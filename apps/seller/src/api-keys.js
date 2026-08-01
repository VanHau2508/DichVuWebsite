/**
 * KHOÁ KẾT NỐI (0120) — để phần mềm ngoài đẩy đơn vào nền tảng.
 *
 * Vì sao có: shop Việt chốt đơn trong chat Facebook/Zalo, thường qua phần mềm chat
 * (Pancake, Botcake, Vpage…) hoặc n8n/Zapier. Đơn nằm bên đó; website không biết gì,
 * kho không trừ, tiền không vào sổ. Khoá này là cầu nối: shop tự sinh khoá trong
 * admin → dán vào phần mềm kia → phần mềm POST đơn sang → đơn vào đúng shop.
 *
 * HAI đường, cố ý tách rời:
 *   • /shops/:id/api-keys  — QUẢN LÝ khoá. Session người thật + RBAC + step-up.
 *   • /ingest/orders       — DÙNG khoá. Không session, chỉ Bearer token.
 * Endpoint ingest KHÔNG nằm dưới /shops/ nên không route nào của seller lọt qua
 * đường Bearer, và ngược lại (dispatcher khớp regex tuyệt đối, xem server.js).
 *
 * Tạo đơn dùng LẠI createManualOrder — cùng validate, cùng khoá tồn, cùng giá,
 * cùng idempotency, cùng outbox. Một đường tiền thứ hai là một chỗ để lệch âm thầm.
 */
import crypto from 'node:crypto';
import { send } from './http.js';
import { withTenant, audit, resolveApiKey } from './db.js';
import { createManualOrder } from './orders.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Tiền tố nhận diện + 32 byte ngẫu nhiên base64url. Tiền tố để người bán nhìn là biết
// đây là khoá của nentang chứ không phải token của bên khác, và để sau này grep log/leak.
const TOKEN_PREFIX = 'ntk_';
const newToken = () => TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');

const MAX_KEYS_PER_SHOP = 10;   // đủ cho mọi tích hợp thật; chặn kịch bản sinh khoá vô hạn

// ── Quản lý khoá (session người thật) ────────────────────────────────────────

async function listApiKeys(res, ctx) {
  const rows = await withTenant(ctx.shopId, async (c) =>
    (await c.query(
      `SELECT k.id, k.name, k.token_prefix, k.scope, k.created_at, k.last_used_at, k.revoked_at,
              (SELECT count(*)::int FROM orders o WHERE o.api_key_id = k.id) AS orders_count
         FROM shop_api_keys k
        WHERE k.shop_id = current_shop_id()
        ORDER BY k.revoked_at NULLS FIRST, k.created_at DESC`,
    )).rows);
  return send(res, 200, { keys: rows });
}

async function createApiKey(res, ctx, body) {
  const name = String(body?.name ?? '').trim().slice(0, 80);
  if (!name) return send(res, 400, { error: 'đặt tên cho khoá (vd "Pancake", "n8n") để sau còn biết cái nào là cái nào' });
  const token = newToken();
  const out = await withTenant(ctx.shopId, async (c) => {
    const live = Number((await c.query(
      `SELECT count(*)::int AS n FROM shop_api_keys WHERE shop_id = current_shop_id() AND revoked_at IS NULL`,
    )).rows[0].n);
    if (live >= MAX_KEYS_PER_SHOP) {
      return { code: 400, body: { error: `tối đa ${MAX_KEYS_PER_SHOP} khoá đang hoạt động — thu hồi bớt khoá không dùng` } };
    }
    const row = (await c.query(
      `INSERT INTO shop_api_keys (shop_id, name, token_hash, token_prefix, created_by)
       VALUES (current_shop_id(), $1, $2, $3, $4) RETURNING id, created_at`,
      [name, sha256(token), token.slice(0, 12), ctx.user.id],
    )).rows[0];
    await audit(c, 'api_key.created', { actorId: ctx.user.id, ip: ctx.ip, metadata: { key_id: row.id, name } });
    return { code: 201, body: { id: row.id, name, created_at: row.created_at, token } };
  });
  // `token` chỉ có trong PHẢN HỒI NÀY, không lưu đâu cả. Mất thì thu hồi + tạo lại.
  return send(res, out.code, out.body);
}

async function revokeApiKey(res, ctx, params) {
  const keyId = params[1];
  const out = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(
      `UPDATE shop_api_keys SET revoked_at = now()
        WHERE id = $1 AND shop_id = current_shop_id() AND revoked_at IS NULL
        RETURNING name`, [keyId],
    );
    if (!r.rowCount) return { code: 404, body: { error: 'không tìm thấy khoá (hoặc đã thu hồi)' } };
    await audit(c, 'api_key.revoked', { actorId: ctx.user.id, ip: ctx.ip, metadata: { key_id: keyId, name: r.rows[0].name } });
    return { code: 200, body: { ok: true } };
  });
  return send(res, out.code, out.body);
}

// ── Nhận đơn từ ngoài (Bearer token) ─────────────────────────────────────────

// Trần thô theo IP, giữ trong tiến trình. KHÔNG phải rate-limit phân tán: seller không
// nối Redis (build context là apps/seller). Mục đích hẹp và nói thẳng ra: chặn vòng lặp
// hỏng của một tích hợp và trò dò token bằng vũ lực. Token 256 bit nên dò là vô vọng;
// đây chỉ để cái vô vọng đó không đốt CPU. Nhiều instance thì trần nhân lên theo số
// instance — chấp nhận, vì lớp bảo vệ thật là chính token.
const INGEST_WINDOW_MS = 60_000;
const INGEST_MAX_PER_MIN = Number(process.env.INGEST_MAX_PER_MIN ?? 120);
const ingestHits = new Map();
function overIngestLimit(ip) {
  const now = Date.now();
  const bucket = Math.floor(now / INGEST_WINDOW_MS);
  const cur = ingestHits.get(ip);
  if (!cur || cur.bucket !== bucket) {
    // Dọn rác cửa sổ cũ NGAY tại đây: không có bộ hẹn giờ nào chạy nền, để Map phình
    // theo số IP từng gọi là rò bộ nhớ chậm — thứ chỉ lộ ra sau nhiều tuần chạy thật.
    if (ingestHits.size > 5000) {
      for (const [k, v] of ingestHits) if (v.bucket !== bucket) ingestHits.delete(k);
    }
    ingestHits.set(ip, { bucket, n: 1 });
    return false;
  }
  cur.n += 1;
  return cur.n > INGEST_MAX_PER_MIN;
}

function bearerOf(req) {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

/**
 * POST /ingest/orders — tạo đơn thay cho shop cầm khoá.
 *
 * Thân request GIỐNG HỆT POST /shops/:id/orders (lines/customer/payment_method/
 * ship_fee_vnd/note/source/source_ref/idempotency_key) — chủ ý: tài liệu một chỗ, và
 * bot Messenger chặng 2 gửi đúng thân đó.
 */
export async function ingestOrder(req, res, { ip, readJson }) {
  if (overIngestLimit(ip ?? 'unknown')) return send(res, 429, { error: 'quá nhiều yêu cầu, thử lại sau một phút' });
  const token = bearerOf(req);
  // Cùng một câu trả lời cho "thiếu header" và "token sai": không xác nhận khoá nào tồn tại.
  if (!token) return send(res, 401, { error: 'thiếu hoặc sai khoá kết nối' });
  const key = await resolveApiKey(sha256(token));
  if (!key || key.scope !== 'orders.ingest') return send(res, 401, { error: 'thiếu hoặc sai khoá kết nối' });
  const body = await readJson(req);
  // Không có người thật đứng sau → ctx.user rỗng; audit ghi actor_type 'system' + id khoá.
  const ctx = { user: null, role: null, shopId: key.shop_id, ip, apiKeyId: key.id };
  return createManualOrder(res, ctx, body);
}

export const API_KEY_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/api-keys$`), perm: 'shop.write', fn: (res, ctx) => listApiKeys(res, ctx) },
  // Tạo khoá = phát ra một năng lực tạo đơn thay shop → step-up như mọi thao tác nhạy cảm.
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/api-keys$`), perm: 'shop.write', stepUp: true, fn: (res, ctx, b) => createApiKey(res, ctx, b) },
  // Thu hồi KHÔNG đòi step-up: khi nghi khoá bị lộ, ma sát thêm một bước là thêm phút
  // để kẻ cầm khoá tạo đơn. Đường an toàn phải là đường dễ đi nhất.
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/api-keys/${UUID}/revoke$`), perm: 'shop.write', fn: (res, ctx, b, p) => revokeApiKey(res, ctx, p) },
];
