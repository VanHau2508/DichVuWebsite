/**
 * Cấu hình thanh toán QR của shop (ngân hàng nhận tiền). Ngày 14.
 * GET: thành viên xem. PUT: owner (payment.write) + STEP-UP (cấu hình tài chính nhạy cảm).
 */
import crypto from 'node:crypto';
import { send } from './http.js';
import { withTenant, audit } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const BIN_RE = /^\d{6}$/;
const ACC_RE = /^\d{6,19}$/;
// URL webhook nền tảng (SePay của shop trỏ về đây). Prod: hooks.nentang.vn.
const HOOKS_URL = (process.env.PLATFORM_HOOKS_URL ?? 'https://hooks.nentang.vn').replace(/\/+$/, '');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const maskAcc = (a) => { const s = String(a ?? ''); return s ? '****' + s.slice(-4) : ''; };

async function getConfig(res, ctx) {
  const row = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(`SELECT bank_bin, account_number, account_name, qr_enabled FROM shop_payment_config WHERE shop_id = current_shop_id()`);
    return r.rows[0] ?? { bank_bin: null, account_number: null, account_name: null, qr_enabled: false };
  });
  return send(res, 200, row);
}

async function putConfig(res, ctx, body) {
  const bankBin = String(body.bank_bin ?? '').trim();
  const account = String(body.account_number ?? '').trim();
  const accName = String(body.account_name ?? '').trim();
  const qrEnabled = body.qr_enabled === true;

  // Bật QR thì phải có đủ thông tin ngân hàng hợp lệ.
  if (qrEnabled) {
    if (!BIN_RE.test(bankBin)) return send(res, 400, { error: 'bank_bin phải là 6 chữ số (BIN napas)' });
    if (!ACC_RE.test(account)) return send(res, 400, { error: 'số tài khoản không hợp lệ' });
    if (accName.length < 1 || accName.length > 100) return send(res, 400, { error: 'tên tài khoản không hợp lệ' });
  }

  await withTenant(ctx.shopId, async (c) => {
    await c.query(
      `INSERT INTO shop_payment_config (shop_id, bank_bin, account_number, account_name, qr_enabled, updated_at)
       VALUES (current_shop_id(), $1, $2, $3, $4, now())
       ON CONFLICT (shop_id) DO UPDATE SET bank_bin = $1, account_number = $2, account_name = $3, qr_enabled = $4, updated_at = now()`,
      [bankBin || null, account || null, accName || null, qrEnabled],
    );
    await audit(c, 'payment_config.updated', { actorId: ctx.user.id, ip: ctx.ip, metadata: { qr_enabled: qrEnabled } });
  });
  return send(res, 200, { ok: true });
}

// ── SePay per-shop: mỗi shop dùng tài khoản SePay riêng (tiền vào thẳng tài khoản) ──
// Trạng thái SePay (không lộ token — chỉ prefix + URL webhook để cấu hình bên SePay).
async function getSepay(res, ctx) {
  const row = await withTenant(ctx.shopId, async (c) =>
    (await c.query(`SELECT sepay_enabled, sepay_token_prefix, account_number FROM shop_payment_config WHERE shop_id = current_shop_id()`)).rows[0] ?? {});
  return send(res, 200, {
    sepay_enabled: row.sepay_enabled === true,
    token_prefix: row.sepay_token_prefix ?? null,
    has_bank: !!row.account_number,
    webhook_url: `${HOOKS_URL}/webhooks/sepay`,
  });
}

// Bật/xoay token: sinh token mới, lưu HASH (không lưu plaintext), trả token 1 LẦN duy nhất.
async function enableSepay(res, ctx) {
  const token = crypto.randomBytes(24).toString('hex'); // 48 hex — bí mật, chỉ hiện lần này
  const prefix = token.slice(0, 8);
  const ok = await withTenant(ctx.shopId, async (c) => {
    const cfg = (await c.query(`SELECT account_number FROM shop_payment_config WHERE shop_id = current_shop_id()`)).rows[0];
    if (!cfg || !cfg.account_number) return false; // phải khai tài khoản ngân hàng nhận tiền trước
    await c.query(
      `INSERT INTO shop_payment_config (shop_id, sepay_enabled, sepay_token_hash, sepay_token_prefix, updated_at)
       VALUES (current_shop_id(), true, $1, $2, now())
       ON CONFLICT (shop_id) DO UPDATE SET sepay_enabled = true, sepay_token_hash = $1, sepay_token_prefix = $2, updated_at = now()`,
      [sha256(token), prefix],
    );
    await audit(c, 'payment_config.sepay_enabled', { actorId: ctx.user.id, ip: ctx.ip, metadata: { prefix } });
    return true;
  });
  if (!ok) return send(res, 400, { error: 'hãy khai tài khoản ngân hàng nhận tiền trước khi bật SePay' });
  // Token = API Key đặt trong SePay (gửi qua header Authorization: Apikey). URL webhook cố định.
  return send(res, 200, { ok: true, token, webhook_url: `${HOOKS_URL}/webhooks/sepay`, api_key: token });
}

async function disableSepay(res, ctx) {
  await withTenant(ctx.shopId, async (c) => {
    await c.query(`UPDATE shop_payment_config SET sepay_enabled = false, sepay_token_hash = NULL, sepay_token_prefix = NULL, updated_at = now() WHERE shop_id = current_shop_id()`);
    await audit(c, 'payment_config.sepay_disabled', { actorId: ctx.user.id, ip: ctx.ip });
  });
  return send(res, 200, { ok: true });
}

// Hàng đợi giao dịch CHƯA khớp (đối soát tay). Số tài khoản che 4 số cuối.
async function listReconcile(res, ctx) {
  const rows = await withTenant(ctx.shopId, async (c) =>
    (await c.query(
      `SELECT id, provider, amount_vnd, content, received_account, reason, created_at, resolved_at
         FROM unmatched_transfers WHERE shop_id = current_shop_id() ORDER BY (resolved_at IS NULL) DESC, created_at DESC LIMIT 100`)).rows);
  return send(res, 200, { transfers: rows.map((t) => ({ ...t, received_account: maskAcc(t.received_account) })) });
}

// Đánh dấu đã xử lý một giao dịch chưa khớp (owner tự đối soát tay xong).
async function resolveReconcile(res, ctx, _body, params) {
  const id = params[1];
  const ok = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(`UPDATE unmatched_transfers SET resolved_at = now() WHERE id = $1 AND shop_id = current_shop_id() AND resolved_at IS NULL`, [id]);
    if (r.rowCount === 1) await audit(c, 'payment.reconcile_resolved', { actorId: ctx.user.id, ip: ctx.ip, metadata: { id } });
    return r.rowCount === 1;
  });
  return send(res, ok ? 200 : 409, ok ? { ok: true } : { error: 'không tìm thấy hoặc đã xử lý' });
}

export const PAYMENT_CONFIG_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/payment-config$`), perm: null, fn: (res, ctx) => getConfig(res, ctx) },
  { m: 'PUT', re: new RegExp(`^/shops/${UUID}/payment-config$`), perm: 'payment.write', stepUp: true, fn: (res, ctx, b) => putConfig(res, ctx, b) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/payment/sepay$`), perm: null, fn: (res, ctx) => getSepay(res, ctx) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/payment/sepay/enable$`), perm: 'payment.write', stepUp: true, fn: (res, ctx) => enableSepay(res, ctx) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/payment/sepay/disable$`), perm: 'payment.write', stepUp: true, fn: (res, ctx) => disableSepay(res, ctx) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/payment/reconcile$`), perm: null, fn: (res, ctx) => listReconcile(res, ctx) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/payment/reconcile/${UUID}/resolve$`), perm: 'payment.write', stepUp: true, fn: (res, ctx, b, p) => resolveReconcile(res, ctx, b, p) },
];
