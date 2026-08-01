/**
 * KẾT NỐI TRANG FACEBOOK cho bot Messenger (0122) — phía chủ shop.
 *
 * Chủ shop chỉ phải dán HAI thứ: Page ID và Page Access Token. Mọi thứ còn lại nền tảng tự
 * sinh: verify token (để Meta xác minh webhook) và khoá kết nối nội bộ mà bot dùng để gọi
 * /ingest/orders. Bắt người bán tự tạo khoá rồi tự dán vào đúng chỗ là cách chắc chắn để
 * họ bỏ cuộc giữa chừng.
 *
 * Khoá nội bộ đó đánh dấu system_owned = true → trang Kết nối KHÔNG liệt kê nó như khoá
 * thường: chủ shop thu hồi nhầm là bot chết mà không ai hiểu vì sao.
 */
import crypto from 'node:crypto';
import { send } from './http.js';
import { withTenant, audit } from './db.js';
import { seal } from './secretbox.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ENC_KEY = process.env.MESSENGER_ENC_KEY ?? '';
const KEY_OK = /^[0-9a-f]{64}$/i.test(ENC_KEY); // thiếu khoá → tính năng TẮT, seller vẫn chạy
// Keyring RIÊNG, không dùng chung với token hãng vận chuyển: lộ một cái không kéo theo
// cái kia, và xoay khoá ship không bắt mọi shop kết nối lại Trang Facebook.
const KEYRING = 'MESSENGER_ENC_KEYS';
const sealMsg = (plain) => seal(plain, ENC_KEY, KEYRING);

async function getMessenger(res, ctx) {
  const row = await withTenant(ctx.shopId, async (c) =>
    (await c.query(
      `SELECT page_id, page_name, enabled, created_at, updated_at
         FROM shop_messenger_config WHERE shop_id = current_shop_id()`,
    )).rows[0] ?? null);
  return send(res, 200, { available: KEY_OK, connected: !!row, config: row });
}

async function connectMessenger(res, ctx, body) {
  if (!KEY_OK) return send(res, 503, { error: 'nền tảng chưa bật kênh Messenger (thiếu MESSENGER_ENC_KEY)' });
  const pageId = String(body?.page_id ?? '').trim();
  const pageToken = String(body?.page_token ?? '').trim();
  const pageName = String(body?.page_name ?? '').trim().slice(0, 120) || null;
  if (!/^\d{5,25}$/.test(pageId)) return send(res, 400, { error: 'Page ID phải là dãy số (lấy ở Trang → Giới thiệu → ID Trang)' });
  if (pageToken.length < 20) return send(res, 400, { error: 'Page Access Token không hợp lệ' });

  const verifyToken = crypto.randomBytes(24).toString('base64url');
  const apiToken = 'ntk_' + crypto.randomBytes(32).toString('base64url');

  const out = await withTenant(ctx.shopId, async (c) => {
    // Một Trang chỉ thuộc MỘT shop (UNIQUE page_id, 0122). Bắt lỗi ở đây để trả câu tiếng
    // Việt thay vì để DB ném 23505 lên thành lỗi 500 khó hiểu.
    const taken = (await c.query(
      `SELECT 1 FROM shop_messenger_config WHERE page_id = $1 AND shop_id <> current_shop_id()`, [pageId],
    )).rowCount;
    if (taken) return { code: 409, body: { error: 'Trang này đã được kết nối ở một cửa hàng khác' } };

    // Khoá nội bộ cho bot: hash vào shop_api_keys (như mọi khoá), bản thô mã hoá vào config
    // vì bot cần gửi header Authorization. Xem lý do đầy đủ ở comment của 0122.
    const key = (await c.query(
      `INSERT INTO shop_api_keys (shop_id, name, token_hash, token_prefix, created_by, system_owned)
       VALUES (current_shop_id(), 'Bot Messenger (hệ thống)', $1, $2, $3, true) RETURNING id`,
      [sha256(apiToken), apiToken.slice(0, 12), ctx.user.id],
    )).rows[0];

    // Kết nối lại = thay Trang/token cũ. Thu hồi khoá cũ để không còn khoá mồ côi sống mãi.
    const prev = (await c.query(`SELECT api_key_id FROM shop_messenger_config WHERE shop_id = current_shop_id()`)).rows[0];
    if (prev?.api_key_id) {
      await c.query(`UPDATE shop_api_keys SET revoked_at = now() WHERE id = $1 AND shop_id = current_shop_id() AND revoked_at IS NULL`, [prev.api_key_id]);
    }

    await c.query(
      `INSERT INTO shop_messenger_config (shop_id, page_id, page_name, page_token_enc, verify_token_hash, api_key_id, api_token_enc, enabled, updated_at)
       VALUES (current_shop_id(), $1, $2, $3, $4, $5, $6, true, now())
       ON CONFLICT (shop_id) DO UPDATE
         SET page_id = $1, page_name = $2, page_token_enc = $3, verify_token_hash = $4,
             api_key_id = $5, api_token_enc = $6, enabled = true, updated_at = now()`,
      [pageId, pageName, sealMsg(pageToken), sha256(verifyToken), key.id, sealMsg(apiToken)],
    );
    await audit(c, 'messenger.connected', { actorId: ctx.user.id, ip: ctx.ip, metadata: { page_id: pageId } });
    return { code: 200, body: { ok: true, verify_token: verifyToken } };
  });
  // verify_token trả về ĐÚNG lần này để chủ shop dán sang Meta; ta chỉ giữ hash.
  return send(res, out.code, out.body);
}

async function disconnectMessenger(res, ctx) {
  await withTenant(ctx.shopId, async (c) => {
    const prev = (await c.query(`SELECT api_key_id, page_id FROM shop_messenger_config WHERE shop_id = current_shop_id()`)).rows[0];
    if (!prev) return;
    if (prev.api_key_id) await c.query(`UPDATE shop_api_keys SET revoked_at = now() WHERE id = $1 AND shop_id = current_shop_id() AND revoked_at IS NULL`, [prev.api_key_id]);
    await c.query(`DELETE FROM shop_messenger_config WHERE shop_id = current_shop_id()`);
    // Xoá luôn phiên hội thoại: chúng chứa SĐT/địa chỉ khách (PII). Ngắt kết nối mà để lại
    // dữ liệu khách nằm đó là giữ PII không còn mục đích sử dụng.
    await c.query(`DELETE FROM messenger_sessions WHERE shop_id = current_shop_id()`);
    await audit(c, 'messenger.disconnected', { actorId: ctx.user.id, ip: ctx.ip, metadata: { page_id: prev.page_id } });
  });
  return send(res, 200, { ok: true });
}

export const MESSENGER_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/messenger$`), perm: 'shop.write', fn: (res, ctx) => getMessenger(res, ctx) },
  // Kết nối = trao cho nền tảng quyền nhắn tin thay Trang + phát một khoá tạo đơn → step-up.
  { m: 'PUT', re: new RegExp(`^/shops/${UUID}/messenger$`), perm: 'shop.write', stepUp: true, fn: (res, ctx, b) => connectMessenger(res, ctx, b) },
  // Ngắt KHÔNG đòi step-up — mirror lý do ở thu hồi khoá (0120): đường an toàn phải dễ đi nhất.
  { m: 'DELETE', re: new RegExp(`^/shops/${UUID}/messenger$`), perm: 'shop.write', fn: (res, ctx) => disconnectMessenger(res, ctx) },
];
