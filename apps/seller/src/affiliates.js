/**
 * CỘNG TÁC VIÊN (CTV / affiliate) — perm 'affiliate.manage' (owner + admin, có step-up:
 * đây là đường tiền RỜI khỏi shop, cùng hạng refund/export).
 *
 * QUY TẮC (docs/51 — chốt trước khi code):
 *  1. Hoa hồng chốt theo ĐƠN GIAO THÀNH CÔNG (đã giao + hết hạn đổi trả), KHÔNG theo đơn
 *     đã thanh toán — đúng cách Shopee/TikTok Shop làm. Trả theo "đã thanh toán" thì đơn
 *     bị hoàn trong hạn đổi trả buộc đi ĐÒI LẠI tiền đã đưa CTV.
 *  2. Căn cứ tính = subtotal − discount (KHÔNG gồm phí ship: ship không phải doanh thu
 *     của shop, trả hoa hồng trên đó là trả cho tiền mình không được hưởng).
 *  3. Mức hoa hồng SNAPSHOT vào từng dòng lúc đặt đơn (như unit_cost_vnd của giá vốn):
 *     shop đổi mức sau đó KHÔNG được làm đổi tiền của đơn cũ.
 *  4. Đơn huỷ/hoàn TRƯỚC khi đủ điều kiện → hoa hồng 'void' (rụng). SAU khi đã trả thì
 *     KHÔNG tự đòi lại — chỉ cảnh báo cho shop tự xử với CTV.
 */
import { send } from './http.js';
import { withTenant, audit } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,23}$/;   // 2..24, chữ HOA/số/gạch — gõ tay được qua điện thoại
const n = (x) => Number(x ?? 0);

// Mức hoa hồng hợp lệ? (percent 1..100 · fixed > 0). Trả về null nếu KHÔNG khai (kế thừa
// mức chung của shop) — khác hẳn "khai sai".
function parseRate(body) {
  const kind = body.rate_kind == null || body.rate_kind === '' ? null : String(body.rate_kind);
  const value = body.rate_value == null || body.rate_value === '' ? null : Number(body.rate_value);
  if (kind === null && value === null) return { ok: true, kind: null, value: null };
  if (!['percent', 'fixed'].includes(kind)) return { ok: false, error: 'loại hoa hồng phải là percent hoặc fixed' };
  if (!Number.isInteger(value) || value <= 0) return { ok: false, error: 'mức hoa hồng phải là số nguyên dương' };
  if (kind === 'percent' && value > 100) return { ok: false, error: 'hoa hồng phần trăm tối đa 100' };
  return { ok: true, kind, value };
}

// CÔNG THỨC TÍNH TIỀN nằm ở DB: hàm affiliate_commission_amount(base, kind, value) — 0131.
// CỐ Ý không có bản JS ở đây. Ba nơi cần nó (checkout ghi lúc đặt đơn, seller tính lại khi
// sửa đơn, báo cáo) nằm ở ba image khác nhau và apps/checkout không có packages/ trong
// image → không import chung được. Ba bản chép tay của một phép nhân tiền là cách chắc
// chắn nhất để hai màn hình ra hai số khác nhau.

// Cấu hình chương trình. Chưa có dòng nào → trả mặc định (chưa bật) thay vì 404: trang
// cấu hình phải mở được ở shop chưa từng đụng tới CTV.
const DEFAULT_CFG = { enabled: false, rate_kind: 'percent', rate_value: 5, hold_days: 7, cookie_days: 30, block_self_referral: true };

async function getConfig(res, ctx) {
  const cfg = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(`SELECT enabled, rate_kind, rate_value, hold_days, cookie_days, block_self_referral FROM shop_affiliate_config`);
    return r.rows[0] ?? null;
  });
  const d = cfg ?? DEFAULT_CFG;
  return send(res, 200, {
    enabled: d.enabled === true, rate_kind: d.rate_kind, rate_value: n(d.rate_value),
    hold_days: n(d.hold_days), cookie_days: n(d.cookie_days), block_self_referral: d.block_self_referral !== false,
    configured: cfg != null,
  });
}

async function putConfig(res, ctx, body) {
  const rate = parseRate(body);
  if (!rate.ok) return send(res, 400, { error: rate.error });
  // Mức CHUNG bắt buộc có (khác mức riêng của CTV, cái đó được để trống).
  if (rate.kind === null) return send(res, 400, { error: 'phải đặt mức hoa hồng chung' });
  const hold = Number(body.hold_days ?? 7), cookie = Number(body.cookie_days ?? 30);
  if (!Number.isInteger(hold) || hold < 0 || hold > 90) return send(res, 400, { error: 'hạn giữ hoa hồng: 0–90 ngày' });
  if (!Number.isInteger(cookie) || cookie < 1 || cookie > 90) return send(res, 400, { error: 'hạn ghi nhớ mã giới thiệu: 1–90 ngày' });
  const enabled = body.enabled === true || body.enabled === 'true' || body.enabled === 'on';
  const block = !(body.block_self_referral === false || body.block_self_referral === 'false');
  await withTenant(ctx.shopId, async (c) => {
    await c.query(
      `INSERT INTO shop_affiliate_config (shop_id, enabled, rate_kind, rate_value, hold_days, cookie_days, block_self_referral, updated_at)
       VALUES (current_shop_id(), $1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (shop_id) DO UPDATE SET enabled=EXCLUDED.enabled, rate_kind=EXCLUDED.rate_kind,
         rate_value=EXCLUDED.rate_value, hold_days=EXCLUDED.hold_days, cookie_days=EXCLUDED.cookie_days,
         block_self_referral=EXCLUDED.block_self_referral, updated_at=now()`,
      [enabled, rate.kind, rate.value, hold, cookie, block]);
    await audit(c, 'affiliate.config_saved', { actorId: ctx.user.id, ip: ctx.ip, metadata: { enabled, rate_kind: rate.kind, rate_value: rate.value, hold_days: hold } });
  });
  return send(res, 200, { ok: true });
}

// Danh sách CTV kèm SỐ TIỀN theo trạng thái — con số shop thật sự cần: "phải trả bao nhiêu".
async function listAffiliates(res, ctx) {
  const data = await withTenant(ctx.shopId, async (c) => {
    const rows = (await c.query(
      `SELECT a.id, a.code, a.name, a.phone, a.email, a.rate_kind, a.rate_value, a.active, a.note, a.created_at,
              coalesce(sum(k.amount_vnd) FILTER (WHERE k.status='pending'),  0)::bigint AS pending_vnd,
              coalesce(sum(k.amount_vnd) FILTER (WHERE k.status='eligible'), 0)::bigint AS eligible_vnd,
              coalesce(sum(k.amount_vnd) FILTER (WHERE k.status='paid'),     0)::bigint AS paid_vnd,
              count(k.id) FILTER (WHERE k.status IN ('pending','eligible','paid'))::int AS order_count
         FROM affiliates a LEFT JOIN affiliate_commissions k ON k.affiliate_id = a.id
        GROUP BY a.id ORDER BY a.active DESC, a.created_at DESC`)).rows;
    return rows;
  });
  return send(res, 200, {
    affiliates: data.map((a) => ({
      id: a.id, code: a.code, name: a.name, phone: a.phone, email: a.email,
      rate_kind: a.rate_kind, rate_value: a.rate_value == null ? null : n(a.rate_value),
      active: a.active, note: a.note, created_at: a.created_at,
      pending_vnd: n(a.pending_vnd), eligible_vnd: n(a.eligible_vnd), paid_vnd: n(a.paid_vnd),
      order_count: n(a.order_count),
    })),
  });
}

async function createAffiliate(res, ctx, body) {
  const code = String(body.code ?? '').trim().toUpperCase();
  const name = String(body.name ?? '').trim();
  if (!CODE_RE.test(code)) return send(res, 400, { error: 'mã giới thiệu: 2–24 ký tự, chỉ chữ, số và gạch ngang' });
  if (name.length < 1 || name.length > 120) return send(res, 400, { error: 'tên CTV không hợp lệ' });
  const rate = parseRate(body);
  if (!rate.ok) return send(res, 400, { error: rate.error });
  const phone = String(body.phone ?? '').replace(/[^\d+]/g, '').slice(0, 20) || null;
  const email = String(body.email ?? '').trim().slice(0, 254).toLowerCase() || null;
  try {
    const id = await withTenant(ctx.shopId, async (c) => {
      const r = await c.query(
        `INSERT INTO affiliates (shop_id, code, name, phone, email, rate_kind, rate_value, note)
         VALUES (current_shop_id(), $1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [code, name, phone, email, rate.kind, rate.value, String(body.note ?? '').trim() || null]);
      await audit(c, 'affiliate.created', { actorId: ctx.user.id, ip: ctx.ip, metadata: { code } });
      return r.rows[0].id;
    });
    return send(res, 201, { id, code });
  } catch (err) {
    if (err.code === '23505') return send(res, 409, { error: 'mã giới thiệu này đã có người dùng' });
    throw err;
  }
}

async function updateAffiliate(res, ctx, body, params) {
  const id = params[1];
  const rate = parseRate(body);
  if (!rate.ok) return send(res, 400, { error: rate.error });
  const name = String(body.name ?? '').trim();
  if (name.length < 1 || name.length > 120) return send(res, 400, { error: 'tên CTV không hợp lệ' });
  // KHÔNG cho đổi `code`: mã đã nằm trong cookie của khách và trong link CTV đã rải khắp
  // nơi. Đổi mã = mọi link cũ hết ăn hoa hồng mà không ai biết. Muốn mã khác thì tạo CTV mới.
  const out = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(
      `UPDATE affiliates SET name=$2, phone=$3, email=$4, rate_kind=$5, rate_value=$6, active=$7, note=$8
        WHERE id=$1 RETURNING code`,
      [id, name,
       String(body.phone ?? '').replace(/[^\d+]/g, '').slice(0, 20) || null,
       String(body.email ?? '').trim().slice(0, 254).toLowerCase() || null,
       rate.kind, rate.value,
       !(body.active === false || body.active === 'false'),
       String(body.note ?? '').trim() || null]);
    if (!r.rowCount) return null;
    await audit(c, 'affiliate.updated', { actorId: ctx.user.id, ip: ctx.ip, metadata: { code: r.rows[0].code } });
    return r.rows[0].code;
  });
  return out ? send(res, 200, { ok: true, code: out }) : send(res, 404, { error: 'không tìm thấy CTV' });
}

// Chi tiết CTV + các dòng hoa hồng gần nhất (để shop đối chiếu trước khi chi tiền).
async function affiliateDetail(res, ctx, _b, params) {
  const id = params[1];
  const data = await withTenant(ctx.shopId, async (c) => {
    const a = (await c.query(`SELECT id, code, name, phone, email, rate_kind, rate_value, active, note FROM affiliates WHERE id=$1`, [id])).rows[0];
    if (!a) return null;
    const items = (await c.query(
      `SELECT k.id, k.order_id, o.order_number, k.base_vnd, k.amount_vnd, k.status, k.eligible_at,
              k.void_reason, k.created_at, o.status AS order_status, o.payment_method, o.cod_settled_at
         FROM affiliate_commissions k JOIN orders o ON o.id = k.order_id
        WHERE k.affiliate_id = $1 ORDER BY k.created_at DESC LIMIT 200`, [id])).rows;
    // CẢNH BÁO ĐẶC THÙ TỰ-VẬN-HÀNH (docs/51): trong khoản sắp chi, bao nhiêu thuộc đơn COD
    // mà HÃNG CÒN GIỮ TIỀN. Shopee/TikTok không có vấn đề này vì sàn tự giữ tiền.
    const hold = (await c.query(
      `SELECT coalesce(sum(k.amount_vnd),0)::bigint AS amount, count(*)::int AS orders
         FROM affiliate_commissions k JOIN orders o ON o.id = k.order_id
        WHERE k.affiliate_id=$1 AND k.status='eligible'
          AND o.payment_method='cod' AND o.cod_settled_at IS NULL`, [id])).rows[0];
    const payouts = (await c.query(
      `SELECT id, amount_vnd, item_count, paid_at, method, note FROM affiliate_payouts
        WHERE affiliate_id=$1 ORDER BY paid_at DESC, created_at DESC LIMIT 50`, [id])).rows;
    return { a, items, hold, payouts };
  });
  if (!data) return send(res, 404, { error: 'không tìm thấy CTV' });
  const sum = (st) => data.items.filter((i) => i.status === st).reduce((s, i) => s + n(i.amount_vnd), 0);
  return send(res, 200, {
    affiliate: { ...data.a, rate_value: data.a.rate_value == null ? null : n(data.a.rate_value) },
    totals: { pending_vnd: sum('pending'), eligible_vnd: sum('eligible'), paid_vnd: sum('paid'), void_vnd: sum('void') },
    cod_unsettled: { amount_vnd: n(data.hold?.amount), orders: n(data.hold?.orders) },
    commissions: data.items.map((i) => ({
      id: i.id, order_id: i.order_id, order_number: n(i.order_number), base_vnd: n(i.base_vnd),
      amount_vnd: n(i.amount_vnd), status: i.status, eligible_at: i.eligible_at, void_reason: i.void_reason,
      order_status: i.order_status, created_at: i.created_at,
      cod_unsettled: i.payment_method === 'cod' && i.cod_settled_at == null,
    })),
    payouts: data.payouts.map((p) => ({ ...p, amount_vnd: n(p.amount_vnd) })),
  });
}

// CHỐT PHIẾU CHI: gom MỌI dòng 'eligible' của CTV thành một phiếu, số tiền do DB cộng —
// KHÔNG nhận amount từ client. Client gửi số thì client quyết định shop chi bao nhiêu.
async function createPayout(res, ctx, body, params) {
  const id = params[1];
  const out = await withTenant(ctx.shopId, async (c) => {
    const a = (await c.query(`SELECT code FROM affiliates WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!a) return { code: 'NOT_FOUND' };
    // Khoá các dòng sẽ chốt TRƯỚC khi cộng: sweep có thể đang đổi trạng thái song song.
    const rows = (await c.query(
      `SELECT id, amount_vnd FROM affiliate_commissions
        WHERE affiliate_id=$1 AND status='eligible' ORDER BY id FOR UPDATE`, [id])).rows;
    if (!rows.length) return { code: 'EMPTY' };
    const total = rows.reduce((s, r) => s + n(r.amount_vnd), 0);
    if (total <= 0) return { code: 'EMPTY' };
    const p = (await c.query(
      `INSERT INTO affiliate_payouts (shop_id, affiliate_id, amount_vnd, item_count, paid_at, method, note, created_by)
       VALUES (current_shop_id(), $1, $2, $3, coalesce($4::date, current_date), $5, $6, $7) RETURNING id`,
      [id, total, rows.length,
       /^\d{4}-\d{2}-\d{2}$/.test(String(body.paid_at ?? '')) ? String(body.paid_at) : null,
       String(body.method ?? '').trim().slice(0, 40) || null,
       String(body.note ?? '').trim().slice(0, 500) || null,
       ctx.user.id])).rows[0];
    await c.query(
      `UPDATE affiliate_commissions SET status='paid', payout_id=$2, updated_at=now()
        WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.id), p.id]);
    await audit(c, 'affiliate.payout_created', { actorId: ctx.user.id, ip: ctx.ip, metadata: { code: a.code, amount_vnd: total, items: rows.length } });
    return { code: 'OK', id: p.id, amount_vnd: total, item_count: rows.length };
  });
  if (out.code === 'NOT_FOUND') return send(res, 404, { error: 'không tìm thấy CTV' });
  if (out.code === 'EMPTY') return send(res, 409, { error: 'CTV này chưa có hoa hồng nào đủ điều kiện chi' });
  return send(res, 201, { id: out.id, amount_vnd: out.amount_vnd, item_count: out.item_count });
}

export const AFFILIATE_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/affiliates/config$`), perm: 'affiliate.manage', fn: (res, ctx) => getConfig(res, ctx) },
  { m: 'PUT', re: new RegExp(`^/shops/${UUID}/affiliates/config$`), perm: 'affiliate.manage', fn: (res, ctx, b) => putConfig(res, ctx, b) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/affiliates$`), perm: 'affiliate.manage', fn: (res, ctx) => listAffiliates(res, ctx) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/affiliates$`), perm: 'affiliate.manage', fn: (res, ctx, b) => createAffiliate(res, ctx, b) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/affiliates/${UUID}$`), perm: 'affiliate.manage', fn: (res, ctx, b, p) => affiliateDetail(res, ctx, b, p) },
  { m: 'PATCH', re: new RegExp(`^/shops/${UUID}/affiliates/${UUID}$`), perm: 'affiliate.manage', fn: (res, ctx, b, p) => updateAffiliate(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/affiliates/${UUID}/payouts$`), perm: 'affiliate.manage', fn: (res, ctx, b, p) => createPayout(res, ctx, b, p) },
];
