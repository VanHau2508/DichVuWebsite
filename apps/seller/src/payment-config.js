/**
 * Cấu hình thanh toán QR của shop (ngân hàng nhận tiền). Ngày 14.
 * GET: thành viên xem. PUT: owner (payment.write) + STEP-UP (cấu hình tài chính nhạy cảm).
 */
import { send } from './http.js';
import { withTenant, audit } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const BIN_RE = /^\d{6}$/;
const ACC_RE = /^\d{6,19}$/;

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

export const PAYMENT_CONFIG_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/payment-config$`), perm: null, fn: (res, ctx) => getConfig(res, ctx) },
  { m: 'PUT', re: new RegExp(`^/shops/${UUID}/payment-config$`), perm: 'payment.write', stepUp: true, fn: (res, ctx, b) => putConfig(res, ctx, b) },
];
