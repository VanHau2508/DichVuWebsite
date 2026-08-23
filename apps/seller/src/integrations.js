import crypto from 'node:crypto';
import { send } from './http.js';
import { withTenant, audit } from './db.js';
import { open, seal } from './secretbox.js';
import { resolveIntegrationWebhook, withIntegrationTenant } from './integration-db.js';
import { createKiotVietClient, verifyKiotVietSignature } from '../kiotviet.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const KEY_ENV = 'INTEGRATION_ENC_KEYS';
const LEGACY_KEY = () => process.env.INTEGRATION_ENC_KEY ?? '';
const WEBHOOK_BASE = (process.env.INTEGRATION_WEBHOOK_BASE ?? 'https://api.nentang.vn').replace(/\/$/, '');
const KIV_IDENTITY_BASE = process.env.KIOTVIET_IDENTITY_BASE;
const KIV_API_BASE = process.env.KIOTVIET_API_BASE;
const KIV_WEBHOOK_TYPES = ['product.update', 'product.delete', 'stock.update', 'order.update', 'invoice.update'];

function safeError(error) {
  return String(error?.message ?? error ?? 'lỗi không xác định')
    .replace(/Bearer\s+\S+/gi, 'Bearer [ẩn]')
    .replace(/client_secret["'=:\s]+[^\s,"}]+/gi, 'client_secret=[ẩn]')
    .replace(/webhook_secret["'=:\s]+[^\s,"}]+/gi, 'webhook_secret=[ẩn]')
    .slice(0, 500);
}

function encodeCredentials(credentials) {
  if (!LEGACY_KEY()) throw Object.assign(new Error('chưa cấu hình khoá mã hoá kết nối'), { statusCode: 503 });
  return seal(JSON.stringify(credentials), LEGACY_KEY(), KEY_ENV);
}

export function decodeIntegrationCredentials(ciphertext) {
  if (!LEGACY_KEY()) throw Object.assign(new Error('chưa cấu hình khoá mã hoá kết nối'), { statusCode: 503 });
  return JSON.parse(open(ciphertext, LEGACY_KEY(), KEY_ENV));
}

function kiotVietClient(credentials) {
  return createKiotVietClient({
    clientId: credentials.client_id,
    clientSecret: credentials.client_secret,
    retailer: credentials.retailer,
    ...(KIV_IDENTITY_BASE ? { identityBase: KIV_IDENTITY_BASE } : {}),
    ...(KIV_API_BASE ? { apiBase: KIV_API_BASE } : {}),
  });
}

const webhookUrl = (publicId, type) => `${WEBHOOK_BASE}/integrations/kiotviet/webhooks/${publicId}/${type}`;

async function ensureKiotVietWebhooks(client, publicId, secret) {
  const existing = await client.listWebhooks();
  const rows = await Promise.all(KIV_WEBHOOK_TYPES.map(async (type) => {
    const url = webhookUrl(publicId, type);
    const found = existing.find((row) => row.type === type && row.url === url && row.isActive !== false);
    const row = found ?? await client.registerWebhook({
      type, url, secret, description: `Nền Tảng đồng bộ ${type}`,
    });
    return [type, String(row.id)];
  }));
  return Object.fromEntries(rows);
}

async function listIntegrations(res, ctx) {
  const data = await withTenant(ctx.shopId, async (c) => {
    const integrations = (await c.query(
      `SELECT i.id, i.provider, i.status, i.inventory_authority, i.retailer,
              i.external_branch_ref, i.external_branch_name, i.webhook_public_id,
              i.webhook_refs, i.webhook_registered_at,
              i.catalog_synced_at, i.inventory_synced_at, i.orders_synced_at,
              i.webhook_received_at, i.reconciled_at, i.last_error, i.updated_at,
              (SELECT count(*)::int FROM integration_entity_refs r
                WHERE r.integration_id = i.id AND r.mapping_status IN ('unmapped','conflict')) AS mapping_issues,
              (SELECT count(*)::int FROM integration_sync_discrepancies d
                WHERE d.integration_id = i.id AND d.status = 'open') AS open_discrepancies
         FROM shop_integrations i ORDER BY i.created_at`,
    )).rows;
    const mappings = (await c.query(
      `SELECT r.id, r.integration_id, r.entity_type, r.external_id, r.local_id,
              r.mapping_status, r.raw_meta, r.updated_at
         FROM integration_entity_refs r
        WHERE r.mapping_status IN ('unmapped','conflict')
        ORDER BY r.updated_at DESC LIMIT 100`,
    )).rows;
    const discrepancies = (await c.query(
      `SELECT d.id, d.integration_id, d.kind, d.severity, d.entity_type, d.external_ref,
              d.local_id, d.message, d.created_at, d.updated_at
         FROM integration_sync_discrepancies d
        WHERE d.status = 'open' ORDER BY (d.severity = 'critical') DESC, d.created_at DESC LIMIT 100`,
    )).rows;
    return { integrations, mappings, discrepancies };
  });
  const canManage = ctx.role === 'owner' || ctx.role === 'admin';
  return send(res, 200, {
    integrations: data.integrations.map((row) => ({
      ...row,
      webhook_public_id: canManage ? row.webhook_public_id : undefined,
      webhook_urls: canManage && row.provider === 'kiotviet' ? {
        product: webhookUrl(row.webhook_public_id, 'product.update'),
        product_delete: webhookUrl(row.webhook_public_id, 'product.delete'),
        stock: webhookUrl(row.webhook_public_id, 'stock.update'),
        order: webhookUrl(row.webhook_public_id, 'order.update'),
        invoice: webhookUrl(row.webhook_public_id, 'invoice.update'),
      } : null,
    })),
    mappings: ctx.role === 'owner' || ctx.role === 'admin' || ctx.role === 'catalog_manager' ? data.mappings : [],
    discrepancies: ctx.role === 'catalog_manager' ? [] : data.discrepancies,
  });
}

async function probeKiotViet(res, ctx, body) {
  const credentials = {
    client_id: String(body?.client_id ?? '').trim().slice(0, 200),
    client_secret: String(body?.client_secret ?? '').trim().slice(0, 500),
    retailer: String(body?.retailer ?? '').trim().slice(0, 200),
  };
  if (!credentials.client_id || !credentials.client_secret || !credentials.retailer) {
    return send(res, 400, { error: 'cần đủ client ID, client secret và tên retailer KiotViet' });
  }
  let branches;
  try { branches = await kiotVietClient(credentials).listBranches(); }
  catch (error) { return send(res, error.statusCode && error.statusCode < 500 ? error.statusCode : 502, { error: safeError(error) }); }
  const row = await withTenant(ctx.shopId, async (c) => {
    const previous = (await c.query(
      `SELECT credential_ciphertext FROM shop_integrations WHERE provider = 'kiotviet' FOR UPDATE`,
    )).rows[0];
    if (previous?.credential_ciphertext) {
      try { credentials.webhook_secret = decodeIntegrationCredentials(previous.credential_ciphertext).webhook_secret; }
      catch {}
    }
    credentials.webhook_secret ||= crypto.randomBytes(32).toString('base64');
    const saved = (await c.query(
      `INSERT INTO shop_integrations
         (shop_id, provider, status, inventory_authority, credential_ciphertext, retailer, last_error, updated_at)
       VALUES (current_shop_id(), 'kiotviet', 'connecting', 'local', $1, $2, NULL, now())
       ON CONFLICT (shop_id, provider) DO UPDATE
         SET status = 'connecting', credential_ciphertext = EXCLUDED.credential_ciphertext,
             retailer = EXCLUDED.retailer, last_error = NULL, updated_at = now()
       RETURNING id, webhook_public_id`, [encodeCredentials(credentials), credentials.retailer],
    )).rows[0];
    await audit(c, 'integration.kiotviet_probed', {
      actorId: ctx.user.id, ip: ctx.ip, metadata: { integration_id: saved.id, branches: branches.length },
    });
    return saved;
  });
  return send(res, 200, { integration_id: row.id, branches });
}

async function activateKiotViet(res, ctx, body) {
  const branchRef = String(body?.branch_id ?? '').trim().slice(0, 200);
  if (!branchRef) return send(res, 400, { error: 'cần chọn chi nhánh KiotViet' });
  const current = await withTenant(ctx.shopId, async (c) =>
    (await c.query(`SELECT id, webhook_public_id, credential_ciphertext FROM shop_integrations WHERE provider = 'kiotviet' FOR UPDATE`)).rows[0]);
  if (!current) return send(res, 404, { error: 'chưa kiểm tra kết nối KiotViet' });
  const credentials = decodeIntegrationCredentials(current.credential_ciphertext);
  let branches;
  try { branches = await kiotVietClient(credentials).listBranches(); }
  catch (error) { return send(res, error.statusCode && error.statusCode < 500 ? error.statusCode : 502, { error: safeError(error) }); }
  const branch = branches.find((row) => row.id === branchRef);
  if (!branch) return send(res, 400, { error: 'chi nhánh không còn tồn tại hoặc không thuộc retailer này' });
  let webhookRefs;
  try { webhookRefs = await ensureKiotVietWebhooks(kiotVietClient(credentials), current.webhook_public_id, credentials.webhook_secret); }
  catch (error) { return send(res, error.statusCode && error.statusCode < 500 ? error.statusCode : 502, { error: `Không đăng ký đủ webhook KiotViet: ${safeError(error)}` }); }
  await withTenant(ctx.shopId, async (c) => {
    await c.query(
      `UPDATE shop_integrations
          SET status = 'connecting', inventory_authority = 'local', external_branch_ref = $1,
              external_branch_name = $2, webhook_refs = $3, webhook_registered_at = now(),
              last_error = NULL, updated_at = now()
        WHERE id = $4`, [branch.id, branch.name, webhookRefs, current.id],
    );
    await c.query(
      `INSERT INTO outbox (shop_id, topic, payload)
       VALUES (current_shop_id(), 'integration.initial_sync_requested', $1)`,
      [{ integration_id: current.id, provider: 'kiotviet' }],
    );
    await audit(c, 'integration.kiotviet_sync_requested', {
      actorId: ctx.user.id, ip: ctx.ip, metadata: { integration_id: current.id, branch_id: branch.id },
    });
  });
  return send(res, 202, { ok: true, status: 'connecting', message: 'Đã xác minh chi nhánh; hệ thống đang chạy đồng bộ thử trước khi chuyển quyền tồn kho.' });
}

async function disableIntegration(res, ctx, _body, params) {
  const id = params[1];
  const snapshot = await withTenant(ctx.shopId, async (c) =>
    (await c.query(
      `SELECT id, provider, credential_ciphertext, webhook_refs
         FROM shop_integrations WHERE id = $1 FOR UPDATE`, [id],
    )).rows[0]);
  if (!snapshot) return send(res, 404, { error: 'không tìm thấy kết nối' });
  const webhookErrors = [];
  if (snapshot.provider === 'kiotviet') {
    try {
      const client = kiotVietClient(decodeIntegrationCredentials(snapshot.credential_ciphertext));
      for (const webhookId of Object.values(snapshot.webhook_refs ?? {})) {
        try { await client.deleteWebhook(webhookId); }
        catch (error) { webhookErrors.push(safeError(error)); }
      }
    } catch (error) { webhookErrors.push(safeError(error)); }
  }
  const changed = await withTenant(ctx.shopId, async (c) => {
    const row = (await c.query(
      `UPDATE shop_integrations
          SET status = 'disabled', webhook_refs = '{}'::jsonb,
              last_error = $2, updated_at = now()
        WHERE id = $1 RETURNING id, inventory_authority`,
      [id, webhookErrors.length ? 'Đã ngắt cục bộ nhưng chưa gỡ được toàn bộ webhook ở KiotViet.' : null],
    )).rows[0];
    if (row) await audit(c, 'integration.disabled', { actorId: ctx.user.id, ip: ctx.ip, metadata: {
      integration_id: id, inventory_authority: row.inventory_authority, provider_webhook_cleanup_ok: webhookErrors.length === 0,
    } });
    return row;
  });
  return send(res, 200, { ok: true, inventory_authority: changed.inventory_authority,
    ...(webhookErrors.length ? { warning: 'Kết nối đã bị vô hiệu trong hệ thống; KiotViet có thể còn giữ URL webhook cũ nhưng mọi yêu cầu tới đó sẽ bị từ chối.' } : {}),
    message: changed.inventory_authority === 'external_master'
      ? 'Đã ngắt kết nối. Sản phẩm liên kết vẫn khóa checkout cho tới khi chuyển quyền tồn kho có kiểm soát.'
      : 'Đã ngắt kết nối; dữ liệu ánh xạ được giữ lại.' });
}

async function mapEntity(res, ctx, body, params) {
  const refId = params[1];
  const localId = String(body?.local_id ?? '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(localId)) return send(res, 400, { error: 'local_id không hợp lệ' });
  const result = await withTenant(ctx.shopId, async (c) => {
    const ref = (await c.query(
      `SELECT id, integration_id, entity_type, external_id, raw_meta
         FROM integration_entity_refs WHERE id = $1 FOR UPDATE`, [refId],
    )).rows[0];
    if (!ref || !['product','variant'].includes(ref.entity_type)) return null;
    const table = ref.entity_type === 'product' ? 'products' : 'variants';
    const exists = (await c.query(`SELECT id FROM ${table} WHERE id = $1`, [localId])).rowCount === 1;
    if (!exists) return { missing: true };
    const occupied = (await c.query(
      `SELECT external_id FROM integration_entity_refs
        WHERE integration_id = $1 AND entity_type = $2 AND local_id = $3
          AND mapping_status = 'mapped' AND id <> $4`,
      [ref.integration_id, ref.entity_type, localId, ref.id],
    )).rows[0];
    if (occupied) return { occupied: true, external_id: occupied.external_id };
    await c.query(
      `UPDATE integration_entity_refs SET local_id = $2, mapping_status = 'mapped', updated_at = now()
        WHERE id = $1`, [refId, localId],
    );
    if (ref.entity_type === 'variant') {
      const variant = (await c.query(`SELECT id, product_id FROM variants WHERE id = $1`, [localId])).rows[0];
      await c.query(
        `INSERT INTO product_source_refs (shop_id, source, kind, external_id, product_id, variant_id, raw_row)
         VALUES (current_shop_id(), 'kiotviet', 'variant', $1, $2, $3, $4)
         ON CONFLICT (shop_id, source, kind, external_id)
         DO UPDATE SET product_id = EXCLUDED.product_id, variant_id = EXCLUDED.variant_id,
                       raw_row = EXCLUDED.raw_row, imported_at = now()`,
        [ref.external_id, variant.product_id, variant.id, ref.raw_meta ?? {}],
      );
      await c.query(
        `UPDATE integration_sync_discrepancies
            SET status = 'resolved', resolved_at = now(), updated_at = now()
          WHERE integration_id = $1 AND dedupe_key IN ($2, $3) AND status = 'open'`,
        [ref.integration_id, `mapping:${ref.external_id}`, `local-variant:${localId}`],
      );
      await c.query(
        `INSERT INTO outbox (shop_id, topic, payload)
         VALUES (current_shop_id(), 'integration.reconcile_requested', $1)`,
        [{ integration_id: ref.integration_id, reason: 'mapping_resolved' }],
      );
    }
    await audit(c, 'integration.mapping_resolved', { actorId: ctx.user.id, ip: ctx.ip, metadata: { ref_id: refId, local_id: localId } });
    return { ok: true };
  });
  if (!result) return send(res, 404, { error: 'không tìm thấy ánh xạ' });
  if (result.missing) return send(res, 400, { error: 'sản phẩm hoặc biến thể nội bộ không tồn tại' });
  if (result.occupied) return send(res, 409, { error: `biến thể này đã liên kết với KiotViet ID ${result.external_id}` });
  return send(res, 200, result);
}

async function ignoreEntity(res, ctx, _body, params) {
  const refId = params[1];
  const result = await withTenant(ctx.shopId, async (c) => {
    const ref = (await c.query(
      `SELECT id, integration_id, entity_type, external_id, mapping_status
         FROM integration_entity_refs WHERE id = $1 FOR UPDATE`, [refId],
    )).rows[0];
    if (!ref || !['product','variant'].includes(ref.entity_type)) return null;
    if (ref.mapping_status === 'mapped') return { mapped: true };
    if (ref.mapping_status !== 'ignored') {
      await c.query(
        `UPDATE integration_entity_refs
            SET local_id = NULL, mapping_status = 'ignored', updated_at = now()
          WHERE id = $1`, [refId],
      );
      if (ref.entity_type === 'variant') {
        await c.query(
          `DELETE FROM product_source_refs
            WHERE source = 'kiotviet' AND kind = 'variant' AND external_id = $1`, [ref.external_id],
        );
      }
      await c.query(
        `UPDATE integration_sync_discrepancies
            SET status = 'resolved', resolved_at = now(), updated_at = now()
          WHERE integration_id = $1 AND dedupe_key = $2 AND status = 'open'`,
        [ref.integration_id, `mapping:${ref.external_id}`],
      );
      await c.query(
        `INSERT INTO outbox (shop_id, topic, payload)
         VALUES (current_shop_id(), 'integration.reconcile_requested', $1)`,
        [{ integration_id: ref.integration_id, reason: 'mapping_ignored' }],
      );
      await audit(c, 'integration.mapping_ignored', {
        actorId: ctx.user.id, ip: ctx.ip, metadata: { ref_id: refId, external_id: ref.external_id },
      });
    }
    return { ok: true, replayed: ref.mapping_status === 'ignored' };
  });
  if (!result) return send(res, 404, { error: 'không tìm thấy ánh xạ' });
  if (result.mapped) return send(res, 409, { error: 'sản phẩm đã liên kết; hãy gỡ liên kết có kiểm soát thay vì bỏ qua' });
  return send(res, 200, result);
}

async function retryDiscrepancy(res, ctx, _body, params) {
  const discrepancyId = params[1];
  const out = await withTenant(ctx.shopId, async (c) => {
    const row = (await c.query(
      `SELECT id, integration_id, entity_type, local_id
         FROM integration_sync_discrepancies WHERE id = $1 AND status = 'open'`,
      [discrepancyId],
    )).rows[0];
    if (!row) return null;
    const retryOrder = row.entity_type === 'order' && row.local_id;
    await c.query(
      `INSERT INTO outbox (shop_id, topic, payload)
       VALUES (current_shop_id(), $1, $2)`,
      [retryOrder ? 'integration.order_created' : 'integration.reconcile_requested', retryOrder
        ? { integration_id: row.integration_id, order_id: row.local_id }
        : { integration_id: row.integration_id, discrepancy_id: row.id }],
    );
    return { ...row, retry_order: Boolean(retryOrder) };
  });
  if (!out) return send(res, 404, { error: 'ca đồng bộ không còn mở' });
  return send(res, 202, { ok: true, message: out.retry_order
    ? 'Đã đưa đơn vào hàng đợi gửi lại an toàn.'
    : 'Đã đưa ca vào hàng đợi đối soát.' });
}

export async function handleKiotVietWebhook(req, res, { publicId, eventType, readBuffer }) {
  if (!KIV_WEBHOOK_TYPES.includes(eventType)) {
    return send(res, 404, { error: 'loại webhook không được hỗ trợ' });
  }
  const resolved = await resolveIntegrationWebhook(publicId);
  if (!resolved || resolved.provider !== 'kiotviet') return send(res, 404, { error: 'không tìm thấy kết nối' });
  const raw = await readBuffer(req, 1024 * 1024);
  let credentials;
  try { credentials = decodeIntegrationCredentials(resolved.credential_ciphertext); }
  catch { return send(res, 503, { error: 'không đọc được cấu hình kết nối' }); }
  if (!credentials.webhook_secret) return send(res, 503, { error: 'kết nối chưa có secret webhook riêng' });
  if (!verifyKiotVietSignature(raw, req.headers['x-hub-signature'], credentials.webhook_secret)) {
    return send(res, 401, { error: 'chữ ký webhook không hợp lệ' });
  }
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); }
  catch { return send(res, 400, { error: 'payload webhook không phải JSON hợp lệ' }); }
  const payloadHash = crypto.createHash('sha256').update(raw).digest('hex');
  const providerEventId = String(req.headers['x-kiotviet-event-id'] || payload?.Id || payload?.id || payloadHash).slice(0, 240);
  const occurredAt = (payload?.Notifications ?? []).flatMap((n) => Array.isArray(n?.Data) ? n.Data : [])
    .map((row) => Date.parse(row?.ModifiedDate ?? row?.modifiedDate ?? row?.PurchaseDate ?? row?.purchaseDate ?? ''))
    .filter(Number.isFinite).sort((a, b) => b - a)[0];
  const inserted = await withIntegrationTenant(resolved.shop_id, async (c) => {
    const row = (await c.query(
      `INSERT INTO integration_webhook_inbox
         (shop_id, integration_id, provider_event_id, event_type, payload_hash, payload, occurred_at)
       VALUES (current_shop_id(), $1, $2, $3, $4, $5, $6)
       ON CONFLICT (shop_id, integration_id, provider_event_id) DO NOTHING
       RETURNING id`, [resolved.integration_id, providerEventId, eventType, payloadHash, payload,
        Number.isFinite(occurredAt) ? new Date(occurredAt).toISOString() : null],
    )).rows[0];
    await c.query(`UPDATE shop_integrations SET webhook_received_at = now(), updated_at = now() WHERE id = $1`, [resolved.integration_id]);
    if (row) {
      await c.query(
        `INSERT INTO outbox (shop_id, topic, payload)
         VALUES (current_shop_id(), 'integration.webhook_received', $1)`,
        [{ integration_id: resolved.integration_id, inbox_id: row.id, event_type: eventType }],
      );
    }
    return row;
  });
  return send(res, 202, { accepted: true, duplicate: !inserted });
}

export const INTEGRATION_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/integrations$`), perm: null, fn: (res, ctx) => listIntegrations(res, ctx) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/integrations/kiotviet/probe$`), perm: 'shop.write', stepUp: true, fn: (res, ctx, body) => probeKiotViet(res, ctx, body) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/integrations/kiotviet/activate$`), perm: 'shop.write', stepUp: true, fn: (res, ctx, body) => activateKiotViet(res, ctx, body) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/integrations/${UUID}/disable$`), perm: 'shop.write', stepUp: true, fn: (res, ctx, body, params) => disableIntegration(res, ctx, body, params) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/integrations/mappings/${UUID}$`), perm: 'catalog.write', fn: (res, ctx, body, params) => mapEntity(res, ctx, body, params) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/integrations/mappings/${UUID}/ignore$`), perm: 'catalog.write', fn: (res, ctx, body, params) => ignoreEntity(res, ctx, body, params) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/integrations/discrepancies/${UUID}/retry$`), perm: 'orders.write', fn: (res, ctx, body, params) => retryDiscrepancy(res, ctx, body, params) },
];
