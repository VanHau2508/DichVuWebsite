/**
 * GÓI DỊCH VỤ — chủ shop tự xem hạn và TỰ TRẢ TIỀN (0124).
 *
 * Trước đây chủ shop không có màn hình nào thấy gói/hạn của mình, và gia hạn chỉ có ở
 * console nội bộ (nhân viên nền tảng gõ tay sau khi đã nhận tiền). Nghĩa là nền tảng thu
 * hút khách tự động nhưng THU TIỀN thủ công — thứ chặn việc bán ở quy mô.
 *
 * Cách thu: VietQR + SePay ở cấp NỀN TẢNG, đúng cơ chế shop đang dùng để nhận tiền khách.
 * Không cổng thẻ, không Stripe — shop Việt chuyển khoản, và nội dung chuyển khoản (pay_ref)
 * là thứ duy nhất nối một lần chuyển tiền với một cửa hàng.
 */
import crypto from 'node:crypto';
import { send } from './http.js';
import { withTenant, audit } from './db.js';
import QRCode from 'qrcode';
import { buildVietQR } from './vietqr.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
// Hoá đơn chưa trả sống bao lâu. Quá hạn thì shop tạo cái mới — KHÔNG để hoá đơn cũ treo
// mãi rồi shop chuyển khoản theo mã đã chết, tiền về mà không khớp được vào đâu.
const CHARGE_TTL_HOURS = 72;
const MAX_MONTHS = 24;

/** Nội dung chuyển khoản: CHỈ chữ HOA + số. Dấu và ký tự lạ bị ngân hàng cắt/đổi. */
const newPayRef = () => 'SUB' + crypto.randomBytes(5).toString('hex').toUpperCase();

async function getBilling(res, ctx) {
  const data = await withTenant(ctx.shopId, async (c) => {
    const sub = (await c.query(
      `SELECT s.plan_code, s.status, s.current_period_end, s.suspended_at,
              p.name AS plan_name, p.price_vnd_month, p.max_products
         FROM subscriptions s JOIN plans p ON p.code = s.plan_code
        WHERE s.shop_id = current_shop_id()`,
    )).rows[0] ?? null;
    const invoices = (await c.query(
      `SELECT plan_code, months, amount_vnd, note, created_at FROM platform_invoices
        WHERE shop_id = current_shop_id() ORDER BY created_at DESC LIMIT 24`,
    )).rows;
    // Hoá đơn CHỜ TRẢ còn hiệu lực — hiện lại QR để shop không phải tạo mới mỗi lần vào.
    const pending = (await c.query(
      `SELECT id, plan_code, months, amount_vnd, pay_ref, expires_at FROM billing_charges
        WHERE shop_id = current_shop_id() AND status = 'pending' AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1`,
    )).rows[0] ?? null;
    const plans = (await c.query(`SELECT code, name, price_vnd_month, max_products FROM plans WHERE active ORDER BY price_vnd_month`)).rows;
    return { sub, invoices, pending, plans };
  });
  const cfg = platformBank();
  const end = data.sub?.current_period_end ? new Date(data.sub.current_period_end) : null;
  // Làm tròn LÊN: còn 0,3 ngày mà hiện "0 ngày" thì người bán tưởng đã mất quyền.
  const daysLeft = end ? Math.ceil((end.getTime() - Date.now()) / 86400000) : null;
  return send(res, 200, {
    available: !!cfg,
    plan_code: data.sub?.plan_code ?? null,
    plan_name: data.sub?.plan_name ?? null,
    price_vnd_month: data.sub ? Number(data.sub.price_vnd_month) : null,
    max_products: data.sub?.max_products ?? null,
    status: data.sub?.status ?? null,
    current_period_end: data.sub?.current_period_end ?? null,
    days_left: daysLeft,
    suspended_for_nonpayment: !!data.sub?.suspended_at,
    plans: data.plans.map((p) => ({ ...p, price_vnd_month: Number(p.price_vnd_month) })),
    invoices: data.invoices.map((i) => ({ ...i, amount_vnd: Number(i.amount_vnd) })),
    pending: data.pending ? { ...data.pending, amount_vnd: Number(data.pending.amount_vnd), ...(await qrOf(cfg, data.pending)) } : null,
  });
}

/**
 * Tài khoản nhận tiền của NỀN TẢNG — đọc từ env, KHÔNG từ DB (0128).
 *
 * Bản đầu để trong bảng và cấp cho app_rw một policy `USING (true)`; bất biến schema bắt
 * đúng chỗ đó — app_rw là vai TENANT, policy hằng-true ở đấy là hình dạng sẽ rò chéo shop
 * ngay khi bảng có thêm cột shop_id. Số tài khoản của nền tảng vốn là cấu hình cấp nền
 * tảng, cùng loại với SEPAY_WEBHOOK_KEY — env là chỗ đúng của nó.
 *
 * Thiếu cấu hình → trả null → tính năng TẮT chứ KHÔNG dựng QR trỏ vào tài khoản rỗng:
 * khách chuyển tiền theo mã QR sai là mất tiền thật, mất theo cách không ai lần lại được.
 */
function platformBank() {
  const bankBin = process.env.PLATFORM_BANK_BIN ?? '';
  const account = process.env.PLATFORM_BANK_ACCOUNT ?? '';
  if (!/^\d{6}$/.test(bankBin) || !/^\d{6,20}$/.test(account)) return null;
  return { bank_bin: bankBin, account_number: account, account_name: process.env.PLATFORM_BANK_NAME ?? null, enabled: true };
}

/**
 * Trả CẢ chuỗi VietQR lẫn ảnh SVG. Vẽ ở đây chứ không ở seller-admin: chuỗi QR do chính
 * hàm này dựng, nên vẽ cùng chỗ thì không có khe nào để hai bên hiểu khác nhau về nội dung
 * chuyển khoản. SVG nội tuyến (không tải ảnh ngoài) nên hợp CSP nghiêm của admin.
 */
async function qrOf(cfg, charge) {
  if (!cfg?.bank_bin || !cfg?.account_number) return {};
  const qr = buildVietQR({ bankBin: cfg.bank_bin, accountNumber: cfg.account_number, amountVnd: Number(charge.amount_vnd), content: charge.pay_ref });
  let svg = '';
  // QR hỏng KHÔNG được làm sập trang: người bán vẫn chuyển khoản tay được nhờ số tài
  // khoản + nội dung hiển thị bên cạnh.
  try { svg = await QRCode.toString(qr, { type: 'svg', margin: 1, width: 220 }); } catch {}
  return { qr_string: qr, qr_svg: svg, bank_account: cfg.account_number, bank_name: cfg.account_name ?? null };
}

/** POST /shops/:id/billing/charge {months, plan_code?} — tạo yêu cầu trả tiền + QR. */
async function createCharge(res, ctx, body) {
  const months = Number(body?.months);
  if (!Number.isInteger(months) || months < 1 || months > MAX_MONTHS) {
    return send(res, 400, { error: `số tháng phải từ 1 đến ${MAX_MONTHS}` });
  }
  const cfg = platformBank();
  if (!cfg?.enabled) return send(res, 503, { error: 'nền tảng chưa cắm tài khoản nhận tiền — liên hệ hỗ trợ' });

  const out = await withTenant(ctx.shopId, async (c) => {
    const sub = (await c.query(
      `SELECT s.plan_code, p.price_vnd_month FROM subscriptions s JOIN plans p ON p.code = s.plan_code
        WHERE s.shop_id = current_shop_id()`,
    )).rows[0];
    if (!sub) return { code: 400, body: { error: 'cửa hàng chưa có gói dịch vụ' } };
    // Đổi gói: lấy giá của gói MỚI. Giá luôn đọc từ bảng plans, không nhận từ client —
    // client gửi giá là client tự đặt giá.
    let planCode = sub.plan_code, price = Number(sub.price_vnd_month);
    const want = String(body?.plan_code ?? '').trim();
    if (want && want !== sub.plan_code) {
      const p = (await c.query(`SELECT code, price_vnd_month FROM plans WHERE code = $1 AND active`, [want])).rows[0];
      if (!p) return { code: 400, body: { error: 'gói dịch vụ không hợp lệ' } };
      planCode = p.code; price = Number(p.price_vnd_month);
    }
    // Một hoá đơn chờ trả tại một thời điểm: nhiều mã cùng sống thì shop chuyển khoản theo
    // mã nào cũng được, nhưng người bán sẽ bối rối và ta phải đối chiếu tay — đúng việc
    // cần bỏ. Huỷ cái cũ rồi tạo cái mới.
    await c.query(`UPDATE billing_charges SET status = 'cancelled' WHERE shop_id = current_shop_id() AND status = 'pending'`);
    const row = (await c.query(
      `INSERT INTO billing_charges (shop_id, plan_code, months, amount_vnd, pay_ref, expires_at)
       VALUES (current_shop_id(), $1, $2, $3, $4, now() + ($5 || ' hours')::interval)
       RETURNING id, plan_code, months, amount_vnd, pay_ref, expires_at`,
      [planCode, months, price * months, newPayRef(), String(CHARGE_TTL_HOURS)],
    )).rows[0];
    await audit(c, 'billing.charge_created', { actorId: ctx.user.id, ip: ctx.ip, metadata: { months, plan_code: planCode, amount_vnd: price * months } });
    return { code: 201, body: { ...row, amount_vnd: Number(row.amount_vnd), qr: row } };
  });
  if (out.code === 201) {
    const { qr, ...rest } = out.body;
    return send(res, 201, { ...rest, ...(await qrOf(cfg, qr)) });
  }
  return send(res, out.code, out.body);
}

export const BILLING_ROUTES = [
  // Ai trong shop cũng XEM được hạn: nhân viên thấy "còn 3 ngày" mới nhắc được chủ.
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/billing$`), perm: null, fn: (res, ctx) => getBilling(res, ctx) },
  // Tạo hoá đơn = cam kết trả tiền → chỉ chủ shop. KHÔNG step-up: đây là đường TRẢ TIỀN
  // cho nền tảng, thêm ma sát vào đúng chỗ mình muốn người ta đi qua là tự bắn vào chân.
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/billing/charge$`), perm: 'shop.write', fn: (res, ctx, b) => createCharge(res, ctx, b) },
];
