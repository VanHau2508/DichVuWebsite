import crypto from 'node:crypto';
import { send } from './http.js';
import { withTenant, audit } from './db.js';
import { open, seal } from './secretbox.js';
import { resolveIntegrationWebhook, withIntegrationTenant } from './integration-db.js';
import { createKiotVietClient, verifyKiotVietSignature } from '../kiotviet.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const UUID_VALUE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  const refs = {};
  const createdRefs = {};
  try {
    for (const type of KIV_WEBHOOK_TYPES) {
      const url = webhookUrl(publicId, type);
      const found = existing.find((row) => row.type === type && row.url === url && row.isActive !== false);
      const row = found ?? await client.registerWebhook({
        type, url, secret, description: `Nền Tảng đồng bộ ${type}`,
      });
      const id = String(row.id ?? row.Id ?? '');
      if (!id) throw new Error(`KiotViet không trả ID cho webhook ${type}`);
      refs[type] = id;
      if (!found) createdRefs[type] = id;
    }
    return { refs, createdRefs };
  } catch (error) {
    await Promise.allSettled(Object.values(createdRefs).map((id) => client.deleteWebhook(id)));
    throw error;
  }
}

async function removeKiotVietWebhooks(credentials, webhookRefs) {
  if (!credentials || !Object.keys(webhookRefs ?? {}).length) return [];
  const client = kiotVietClient(credentials);
  const errors = [];
  for (const webhookId of Object.values(webhookRefs ?? {})) {
    try { await client.deleteWebhook(webhookId); }
    catch (error) { errors.push(safeError(error)); }
  }
  return errors;
}

async function listIntegrations(res, ctx) {
  const data = await withTenant(ctx.shopId, async (c) => {
    const integrations = (await c.query(
      `SELECT i.id, i.provider, i.status, i.inventory_authority, i.retailer, i.generation,
              i.external_branch_ref, i.external_branch_name, i.webhook_public_id,
              i.webhook_refs, i.webhook_registered_at,
              i.catalog_synced_at, i.inventory_synced_at, i.orders_synced_at,
              i.webhook_received_at, i.reconciled_at, i.last_error, i.updated_at,
              (SELECT count(*)::int FROM integration_entity_refs r
                WHERE r.integration_id = i.id AND r.entity_type IN ('product','variant')
                  AND r.mapping_status IN ('unmapped','conflict')) AS mapping_issues,
              (SELECT count(*)::int FROM integration_sync_discrepancies d
                WHERE d.integration_id = i.id AND d.status = 'open') AS open_discrepancies
         FROM shop_integrations i ORDER BY i.created_at`,
    )).rows;
    const mappings = (await c.query(
      `SELECT r.id, r.integration_id, r.entity_type, r.external_id, r.local_id,
              r.mapping_status,
              jsonb_build_object('name', r.raw_meta->'name', 'sku', r.raw_meta->'sku',
                                 'barcode', r.raw_meta->'barcode',
                                 'base_price_vnd', r.raw_meta->'base_price_vnd') AS raw_meta,
              r.updated_at
         FROM integration_entity_refs r
        WHERE r.entity_type IN ('product','variant')
          AND r.mapping_status IN ('unmapped','conflict')
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
      webhook_urls: canManage && row.provider === 'kiotviet' && row.webhook_public_id ? {
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
  credentials.webhook_secret = crypto.randomBytes(32).toString('base64');
  const row = await withTenant(ctx.shopId, async (c) => {
    const previous = (await c.query(
      `SELECT id, retailer, generation FROM shop_integrations WHERE provider = 'kiotviet' FOR UPDATE`,
    )).rows[0];
    if (previous?.retailer && previous.retailer !== credentials.retailer) {
      return { retailer_mismatch: true, current_retailer: previous.retailer };
    }
    const saved = (await c.query(
      `INSERT INTO shop_integrations
         (shop_id, provider, status, inventory_authority, credential_ciphertext, retailer,
          pending_generation, pending_credential_ciphertext, pending_retailer,
          pending_webhook_public_id, last_error, updated_at)
       VALUES (current_shop_id(), 'kiotviet', 'connecting', 'local', NULL, NULL,
               1, $1, $2, gen_random_uuid(), NULL, now())
       ON CONFLICT (shop_id, provider) DO UPDATE
         SET pending_generation = shop_integrations.generation + 1,
             pending_credential_ciphertext = EXCLUDED.pending_credential_ciphertext,
             pending_retailer = EXCLUDED.pending_retailer,
             pending_webhook_public_id = gen_random_uuid(),
             last_error = NULL, updated_at = now()
       RETURNING id, pending_generation, pending_webhook_public_id`, [encodeCredentials(credentials), credentials.retailer],
    )).rows[0];
    await audit(c, 'integration.kiotviet_probed', {
      actorId: ctx.user.id, ip: ctx.ip, metadata: { integration_id: saved.id, branches: branches.length },
    });
    return saved;
  });
  if (row.retailer_mismatch) return send(res, 409, {
    error: `V1 không đổi retailer trên cùng kết nối (${row.current_retailer}). Hãy giữ đúng retailer hoặc liên hệ hỗ trợ để chuyển nguồn có đối soát.`,
  });
  return send(res, 200, {
    integration_id: row.id,
    pending_token: row.pending_webhook_public_id,
    branches,
  });
}

async function activateKiotViet(res, ctx, body) {
  const branchRef = String(body?.branch_id ?? '').trim().slice(0, 200);
  const pendingToken = String(body?.pending_token ?? '').trim().toLowerCase();
  if (!branchRef) return send(res, 400, { error: 'cần chọn chi nhánh KiotViet' });
  if (!UUID_VALUE_RE.test(pendingToken)) {
    return send(res, 400, { error: 'phiên kiểm tra credential không hợp lệ; hãy kiểm tra lại kết nối' });
  }
  const current = await withTenant(ctx.shopId, async (c) =>
    (await c.query(
      `SELECT id, status, inventory_authority, generation, retailer, credential_ciphertext,
              webhook_refs, pending_generation, pending_credential_ciphertext,
              pending_retailer, pending_webhook_public_id
         FROM shop_integrations WHERE provider = 'kiotviet' FOR UPDATE`,
    )).rows[0]);
  if (!current) return send(res, 404, { error: 'chưa kiểm tra kết nối KiotViet' });
  if (!current.pending_credential_ciphertext || !current.pending_generation || !current.pending_webhook_public_id) {
    return send(res, 409, { error: 'phiên kiểm tra credential không còn hiệu lực; hãy kiểm tra lại trước khi kích hoạt' });
  }
  if (String(current.pending_webhook_public_id).toLowerCase() !== pendingToken) {
    return send(res, 409, { error: 'credential đã được kiểm tra lại ở phiên khác; hãy tải lại trang trước khi kích hoạt' });
  }
  const credentials = decodeIntegrationCredentials(current.pending_credential_ciphertext);
  let branches;
  try { branches = await kiotVietClient(credentials).listBranches(); }
  catch (error) { return send(res, error.statusCode && error.statusCode < 500 ? error.statusCode : 502, { error: safeError(error) }); }
  const branch = branches.find((row) => row.id === branchRef);
  if (!branch) return send(res, 400, { error: 'chi nhánh không còn tồn tại hoặc không thuộc retailer này' });
  let webhookRefs;
  let createdWebhookRefs;
  try {
    ({ refs: webhookRefs, createdRefs: createdWebhookRefs } = await ensureKiotVietWebhooks(
      kiotVietClient(credentials), current.pending_webhook_public_id, credentials.webhook_secret,
    ));
  }
  catch (error) { return send(res, error.statusCode && error.statusCode < 500 ? error.statusCode : 502, { error: `Không đăng ký đủ webhook KiotViet: ${safeError(error)}` }); }
  let changed;
  try {
    changed = await withTenant(ctx.shopId, async (c) => {
      const row = (await c.query(
        `UPDATE shop_integrations
            SET generation = pending_generation,
                credential_ciphertext = pending_credential_ciphertext,
                retailer = pending_retailer,
                webhook_public_id = pending_webhook_public_id,
                pending_generation = NULL, pending_credential_ciphertext = NULL,
                pending_retailer = NULL, pending_webhook_public_id = NULL,
                status = 'connecting', external_branch_ref = $1,
                external_branch_name = $2, webhook_refs = $3, webhook_registered_at = now(),
                catalog_synced_at = NULL, inventory_synced_at = NULL,
                order_reconcile_cursor_at = NULL, invoice_reconcile_cursor_at = NULL,
                reconciled_at = NULL, last_error = NULL, updated_at = now()
          WHERE id = $4 AND pending_generation = $5
            AND pending_webhook_public_id = $6
          RETURNING id, generation`, [branch.id, branch.name, webhookRefs, current.id,
          current.pending_generation, pendingToken],
      )).rows[0];
      if (!row) return null;
      await c.query(
        `INSERT INTO outbox (shop_id, topic, payload)
         VALUES (current_shop_id(), 'integration.initial_sync_requested', $1)`,
        [{ integration_id: current.id, provider: 'kiotviet', generation: row.generation }],
      );
      await audit(c, 'integration.kiotviet_sync_requested', {
        actorId: ctx.user.id, ip: ctx.ip, metadata: { integration_id: current.id, branch_id: branch.id, generation: row.generation },
      });
      return row;
    });
  } catch (error) {
    // Provider side effect xảy ra trước transaction DB; rollback DB phải gỡ đúng webhook vừa
    // tạo để không để lại URL sống nhưng không có generation nào nhận nó.
    await removeKiotVietWebhooks(credentials, createdWebhookRefs);
    throw error;
  }
  if (!changed) {
    await removeKiotVietWebhooks(credentials, createdWebhookRefs);
    return send(res, 409, { error: 'credential vừa được kiểm tra lại ở phiên khác; webhook mới đã được gỡ, hãy tải lại trang' });
  }
  let oldCredentials = null;
  try { if (current.credential_ciphertext) oldCredentials = decodeIntegrationCredentials(current.credential_ciphertext); } catch {}
  const cleanupErrors = await removeKiotVietWebhooks(oldCredentials, current.webhook_refs);
  if (cleanupErrors.length) await withTenant(ctx.shopId, (c) => c.query(
    `UPDATE shop_integrations SET last_error = $2, updated_at = now()
      WHERE id = $1 AND generation = $3`,
    [current.id, 'Đã chuyển credential nhưng chưa gỡ được toàn bộ webhook cũ; URL cũ đã bị vô hiệu.', changed.generation],
  ));
  return send(res, 202, { ok: true, status: 'connecting', message: 'Đã xác minh chi nhánh; hệ thống đang chạy đồng bộ thử trước khi chuyển quyền tồn kho.' });
}

async function disableIntegration(res, ctx, _body, params) {
  const id = params[1];
  // Đóng lifecycle TRƯỚC khi gọi mạng. Worker gửi đơn giữ cùng khoá dòng qua provider call,
  // nên khi transaction này commit thì không còn POST nào thuộc generation cũ chạy sau đó.
  const snapshot = await withTenant(ctx.shopId, async (c) => {
    const row = (await c.query(
      `SELECT id, provider, credential_ciphertext, webhook_refs, inventory_authority, generation
         FROM shop_integrations WHERE id = $1 FOR UPDATE`, [id],
    )).rows[0];
    if (!row) return null;
    const changed = (await c.query(
      `UPDATE shop_integrations
          SET status = 'disabled', generation = generation + 1,
              credential_ciphertext = NULL, webhook_public_id = NULL,
              webhook_refs = '{}'::jsonb,
              pending_generation = NULL, pending_credential_ciphertext = NULL,
              pending_retailer = NULL, pending_webhook_public_id = NULL,
              last_error = NULL, updated_at = now()
        WHERE id = $1
        RETURNING generation`, [id],
    )).rows[0];
    await audit(c, 'integration.disabled', { actorId: ctx.user.id, ip: ctx.ip, metadata: {
      integration_id: id, inventory_authority: row.inventory_authority,
      generation_before: row.generation, generation_after: changed.generation,
    } });
    return { ...row, generation_after: changed.generation };
  });
  if (!snapshot) return send(res, 404, { error: 'không tìm thấy kết nối' });
  let credentials = null;
  try { if (snapshot.credential_ciphertext) credentials = decodeIntegrationCredentials(snapshot.credential_ciphertext); }
  catch {}
  const webhookErrors = snapshot.provider === 'kiotviet'
    ? await removeKiotVietWebhooks(credentials, snapshot.webhook_refs) : [];
  if (webhookErrors.length) await withTenant(ctx.shopId, (c) => c.query(
    `UPDATE shop_integrations SET last_error = $2, updated_at = now()
      WHERE id = $1 AND status = 'disabled' AND generation = $3`,
    [id, 'Đã ngắt cục bộ nhưng chưa gỡ được toàn bộ webhook ở KiotViet; URL cũ đã bị vô hiệu.', snapshot.generation_after],
  ));
  return send(res, 200, { ok: true, inventory_authority: snapshot.inventory_authority,
    ...(webhookErrors.length ? { warning: 'Kết nối đã bị vô hiệu trong hệ thống; KiotViet có thể còn giữ URL webhook cũ nhưng mọi yêu cầu tới đó sẽ bị từ chối.' } : {}),
    message: snapshot.inventory_authority === 'external_master'
      ? 'Đã ngắt kết nối. Sản phẩm liên kết vẫn khóa checkout cho tới khi chuyển quyền tồn kho có kiểm soát.'
      : 'Đã ngắt kết nối; dữ liệu ánh xạ được giữ lại.' });
}

async function transferInventoryToLocal(res, ctx, _body, params) {
  const id = params[1];
  const row = await withTenant(ctx.shopId, async (c) => {
    const changed = (await c.query(
      `UPDATE shop_integrations
          SET inventory_authority = 'local', generation = generation + 1,
              inventory_synced_at = NULL, last_error = NULL, updated_at = now()
        WHERE id = $1 AND status = 'disabled' AND inventory_authority = 'external_master'
          AND pending_generation IS NULL
        RETURNING id, generation`, [id],
    )).rows[0];
    if (changed) await audit(c, 'integration.inventory_transferred_local', {
      actorId: ctx.user.id, ip: ctx.ip, metadata: { integration_id: id, generation: changed.generation },
    });
    return changed;
  });
  if (!row) return send(res, 409, { error: 'chỉ chuyển về tồn local sau khi đã ngắt connector đang làm chủ tồn' });
  return send(res, 200, {
    ok: true,
    message: 'Đã chuyển quyền tồn về nền tảng từ bản chiếu cuối. Hãy kiểm đếm tồn thực tế trước khi mở bán lại.',
  });
}

async function mapEntity(res, ctx, body, params) {
  const refId = params[1];
  const localId = String(body?.local_id ?? '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(localId)) return send(res, 400, { error: 'local_id không hợp lệ' });
  const result = await withTenant(ctx.shopId, async (c) => {
    const ref = (await c.query(
      `SELECT r.id, r.integration_id, r.entity_type, r.external_id, r.raw_meta, i.generation
         FROM integration_entity_refs r JOIN shop_integrations i ON i.id = r.integration_id
        WHERE r.id = $1 FOR UPDATE OF r`, [refId],
    )).rows[0];
    if (!ref || !['product','variant'].includes(ref.entity_type)) return null;
    const table = ref.entity_type === 'product' ? 'products' : 'variants';
    const exists = (await c.query(`SELECT id FROM ${table} WHERE id = $1`, [localId])).rowCount === 1;
    if (!exists) return { missing: true };
    // Keep manual mapping on the same advisory key as automatic catalog sync. The row
    // unique index is only the last line of defence; the shared lock turns a race into a
    // deterministic 409 instead of a transaction-wide 23505 rollback.
    await c.query(
      `SELECT pg_advisory_xact_lock(kiotviet_entity_claim_lock_key($1, $2, $3))`,
      [ref.integration_id, ref.entity_type, localId],
    );
    const occupied = (await c.query(
      `SELECT external_id FROM integration_entity_refs
        WHERE integration_id = $1 AND entity_type = $2 AND local_id = $3
          AND mapping_status = 'mapped' AND id <> $4`,
      [ref.integration_id, ref.entity_type, localId, ref.id],
    )).rows[0];
    if (occupied) return { occupied: true, external_id: occupied.external_id };
    await c.query(
      `UPDATE integration_entity_refs
          SET local_id = $2, mapping_status = 'mapped',
              inventory_synced_at = NULL, inventory_generation = NULL, updated_at = now()
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
        [{ integration_id: ref.integration_id, generation: ref.generation, reason: 'mapping_resolved' }],
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
      `SELECT r.id, r.integration_id, r.entity_type, r.external_id, r.mapping_status, i.generation
         FROM integration_entity_refs r JOIN shop_integrations i ON i.id = r.integration_id
        WHERE r.id = $1 FOR UPDATE OF r`, [refId],
    )).rows[0];
    if (!ref || !['product','variant'].includes(ref.entity_type)) return null;
    if (ref.mapping_status === 'mapped') return { mapped: true };
    if (ref.mapping_status !== 'ignored') {
      await c.query(
        `UPDATE integration_entity_refs
            SET local_id = NULL, mapping_status = 'ignored',
                inventory_synced_at = NULL, inventory_generation = NULL, updated_at = now()
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
        [{ integration_id: ref.integration_id, generation: ref.generation, reason: 'mapping_ignored' }],
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
  const body = _body ?? {};
  const out = await withTenant(ctx.shopId, async (c) => {
    const row = (await c.query(
      `SELECT d.id, d.integration_id, d.entity_type, d.external_ref, d.local_id, d.status AS discrepancy_status,
              i.generation, i.status AS integration_status
         FROM integration_sync_discrepancies d
         JOIN shop_integrations i ON i.id = d.integration_id
        WHERE d.id = $1
        FOR UPDATE OF d, i`,
      [discrepancyId],
    )).rows[0];
    if (!row) return null;
    const retryOrder = row.entity_type === 'order' && row.local_id;
    const retryInvoice = row.entity_type === 'invoice' && row.external_ref;
    if (retryOrder) {
      const order = (await c.query(
        `SELECT integration_generation AS order_generation, sync_status AS order_sync_status,
                external_ref AS order_external_ref
           FROM orders
          WHERE id = $1 AND integration_id = $2
          FOR UPDATE`, [row.local_id, row.integration_id],
      )).rows[0];
      Object.assign(row, order ?? {
        order_generation: null, order_sync_status: null, order_external_ref: null,
      });
    }
    if (retryOrder && row.discrepancy_status !== 'open') return { ...row, retry_already_consumed: true };
    if (!retryOrder && row.discrepancy_status !== 'open') return null;
    if (retryOrder && String(body.confirm_provider_absent ?? '') !== '1') {
      return { ...row, confirmation_required: true };
    }
    if (retryOrder && (row.order_generation == null
      || Number(row.order_generation) !== Number(row.generation))) {
      return { ...row, stale_order_generation: true };
    }
    if (retryOrder && (row.order_sync_status !== 'needs_attention' || row.order_external_ref)) {
      return { ...row, retry_not_allowed: true };
    }
    if (retryOrder) await audit(c, 'integration.order_retry_confirmed', {
      actorId: ctx.user.id, ip: ctx.ip,
      metadata: { discrepancy_id: row.id, order_id: row.local_id, provider_absent: true },
    });
    if (retryOrder) {
      const consumed = (await c.query(
        `UPDATE integration_sync_discrepancies
            SET status = 'resolved', resolved_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'open'
          RETURNING id`, [row.id],
      )).rows[0];
      if (!consumed) return { ...row, retry_already_consumed: true };
      await c.query(
        `UPDATE orders SET sync_status = 'pending', sync_error = NULL, sync_updated_at = now()
          WHERE id = $1 AND sync_status = 'needs_attention' AND external_ref IS NULL`, [row.local_id],
      );
    }
    await c.query(
      `INSERT INTO outbox (shop_id, topic, payload)
       VALUES (current_shop_id(), $1, $2)`,
      [retryOrder ? 'integration.order_retry_requested'
        : retryInvoice ? 'integration.invoice_retry_requested'
          : 'integration.reconcile_requested', retryOrder
        ? { integration_id: row.integration_id, generation: row.generation, order_id: row.local_id,
            discrepancy_id: row.id, manual_retry_confirmed: true }
        : retryInvoice
          ? { integration_id: row.integration_id, generation: row.generation, external_id: row.external_ref, discrepancy_id: row.id }
          : { integration_id: row.integration_id, generation: row.generation, discrepancy_id: row.id }],
    );
    return { ...row, retry_order: Boolean(retryOrder), retry_invoice: Boolean(retryInvoice) };
  });
  if (!out) return send(res, 404, { error: 'ca đồng bộ không còn mở' });
  if (out.retry_already_consumed) return send(res, 409, {
    error: 'Xác nhận retry này đã được sử dụng hoặc ca đã đóng; cần kiểm tra trạng thái đơn trước khi thử lại.',
  });
  if (out.confirmation_required) return send(res, 400, {
    error: 'Chỉ thử lại sau khi đã kiểm tra KiotViet không có đơn mang mã Nền Tảng; gửi confirm_provider_absent=1 để xác nhận.',
  });
  if (out.stale_order_generation) return send(res, 409, {
    error: 'Đơn thuộc cấu hình POS cũ; không tự gửi sang credential hoặc chi nhánh mới. Cần xác nhận nhận lại đơn có kiểm soát.',
  });
  if (out.retry_not_allowed) return send(res, 409, {
    error: 'Đơn không còn ở trạng thái cần xử lý hoặc đã có định danh KiotViet; không tự gửi lại.',
  });
  return send(res, 202, { ok: true, message: out.retry_order
    ? 'Đã đưa đơn vào hàng đợi gửi lại an toàn.'
    : out.retry_invoice ? 'Đã đưa đúng hóa đơn vào hàng đợi nhập lại.'
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
  const accepted = await withIntegrationTenant(resolved.shop_id, async (c) => {
    const live = (await c.query(
      `SELECT id FROM shop_integrations
        WHERE id = $1 AND generation = $2 AND status IN ('active','degraded')
          AND credential_ciphertext IS NOT NULL
        FOR UPDATE`,
      [resolved.integration_id, resolved.generation],
    )).rows[0];
    if (!live) return { stale: true, row: null };
    const row = (await c.query(
      `INSERT INTO integration_webhook_inbox
         (shop_id, integration_id, generation, provider_event_id, event_type, payload_hash, payload, occurred_at)
       VALUES (current_shop_id(), $1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (shop_id, integration_id, generation, event_type, provider_event_id) DO NOTHING
       RETURNING id`, [resolved.integration_id, resolved.generation, providerEventId, eventType, payloadHash, payload,
         Number.isFinite(occurredAt) ? new Date(occurredAt).toISOString() : null],
    )).rows[0];
    let collision = false;
    if (!row) {
      const existing = (await c.query(
        `SELECT id, payload_hash FROM integration_webhook_inbox
          WHERE integration_id = $1 AND generation = $2
            AND event_type = $3 AND provider_event_id = $4`,
        [resolved.integration_id, resolved.generation, eventType, providerEventId],
      )).rows[0];
      collision = Boolean(existing && existing.payload_hash !== payloadHash);
      if (collision) {
        const dedupeKey = `webhook-collision:${resolved.generation}:${eventType}:${providerEventId}`;
        await c.query(
          `INSERT INTO integration_sync_discrepancies
             (shop_id, integration_id, kind, severity, entity_type, external_ref,
              dedupe_key, message, details)
           VALUES (current_shop_id(), $1, 'webhook_failed', 'critical', 'webhook', $2,
                   $3, $4, $5)
           ON CONFLICT (shop_id, integration_id, dedupe_key) WHERE status = 'open'
           DO UPDATE SET message = EXCLUDED.message, details = EXCLUDED.details, updated_at = now()`,
          [resolved.integration_id, providerEventId, dedupeKey,
            'KiotViet dùng lại cùng mã sự kiện cho nội dung khác; hệ thống đã từ chối để tránh ghi đè dữ liệu.',
            { event_type: eventType, generation: Number(resolved.generation),
              existing_payload_hash: existing.payload_hash, received_payload_hash: payloadHash }],
        );
      }
    }
    await c.query(
      `UPDATE shop_integrations SET webhook_received_at = now(), updated_at = now()
        WHERE id = $1 AND generation = $2 AND status IN ('active','degraded')`,
      [resolved.integration_id, resolved.generation],
    );
    if (row) {
      await c.query(
        `INSERT INTO outbox (shop_id, topic, payload)
         VALUES (current_shop_id(), 'integration.webhook_received', $1)`,
        [{ integration_id: resolved.integration_id, generation: resolved.generation, inbox_id: row.id, event_type: eventType }],
      );
    }
    return { stale: false, row, collision };
  });
  if (accepted.collision) return send(res, 409, {
    accepted: false,
    collision: true,
    error: 'Mã sự kiện webhook đã tồn tại với nội dung khác; hệ thống sẽ đối soát lại thay vì ghi đè.',
  });
  return send(res, 202, {
    accepted: true,
    duplicate: !accepted.row && !accepted.stale,
    superseded: accepted.stale,
  });
}

export const INTEGRATION_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/integrations$`), perm: null, fn: (res, ctx) => listIntegrations(res, ctx) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/integrations/kiotviet/probe$`), perm: 'shop.write', stepUp: true, fn: (res, ctx, body) => probeKiotViet(res, ctx, body) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/integrations/kiotviet/activate$`), perm: 'shop.write', stepUp: true, fn: (res, ctx, body) => activateKiotViet(res, ctx, body) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/integrations/${UUID}/disable$`), perm: 'shop.write', stepUp: true, fn: (res, ctx, body, params) => disableIntegration(res, ctx, body, params) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/integrations/${UUID}/transfer-local$`), perm: 'shop.write', stepUp: true, fn: (res, ctx, body, params) => transferInventoryToLocal(res, ctx, body, params) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/integrations/mappings/${UUID}$`), perm: 'catalog.write', fn: (res, ctx, body, params) => mapEntity(res, ctx, body, params) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/integrations/mappings/${UUID}/ignore$`), perm: 'catalog.write', fn: (res, ctx, body, params) => ignoreEntity(res, ctx, body, params) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/integrations/discrepancies/${UUID}/retry$`), perm: 'orders.write', fn: (res, ctx, body, params) => retryDiscrepancy(res, ctx, body, params) },
];
