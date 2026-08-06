/**
 * E2E CHI PHÍ VẬN CHUYỂN THỰC TRẢ (docs/69).
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/ship-cost.e2e.mjs
 *
 * Tiền cước là khoản shop THỰC SỰ mất, và sổ lãi lỗ đang không thấy phần lớn nó.
 *
 * ĐO TRƯỚC KHI VIẾT, trên DB dev: 1.568/2.019 vận đơn là "giao tay" (provider NULL) và KHÔNG
 * dòng nào có `carrier_fee_vnd`. Nghĩa là shop tự giao, hoặc dùng hãng chưa nối API (Grab,
 * Ahamove, xe ôm quen — phần lớn shop Việt), thì TOÀN BỘ tiền cước biến mất khỏi P&L. Đơn bị
 * BOM còn mất thêm cước CHIỀU VỀ, khoản này không hãng nào đồng bộ về.
 *
 * BỘ NÀY CANH:
 *   · nhập được phí cho vận đơn GIAO TAY, và nó vào ĐÚNG dòng chi phí của P&L;
 *   · nhập được phí CHIỀU VỀ cho đơn đã quay lại, và nó cũng vào P&L (ghi ở kỳ hàng-quay-về);
 *   · KHÔNG cho gõ đè phí của vận đơn do HÃNG đồng bộ — ở đó hãng là nguồn sự thật;
 *   · NULL ≠ 0: bỏ trống là "chưa nhập", điền 0 là "hãng không thu". Gộp hai thứ đó làm một là
 *     biến "chưa biết" thành "biết chắc bằng không", và sổ trông sạch hơn thực tế.
 */
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const inviteTokenOf = async (e) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [e]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', BOLD = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${String(d).slice(0, 200)}${X}`); };
const sect = (m) => console.log(`\n${BOLD}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };
const N = (v) => Number(v ?? 0);

async function rq(base, method, path, { body, cookie, origin } = {}) {
  const h = {}; if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin; if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, raw: t, sc: r.headers.getSetCookie() };
}
async function adm(method, path, { cookie, form } = {}) {
  const h = {}; if (form !== undefined) h['content-type'] = 'application/x-www-form-urlencoded';
  h.origin = OADM; if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(ADMIN + path, { method, headers: h, redirect: 'manual', body: form !== undefined ? String(form) : undefined });
  return { status: r.status, loc: r.headers.get('location'), body: await r.text(), sc: r.headers.getSetCookie() };
}
const login = async (e, p) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email: e, password: p }, origin: OA })).sc);
const uidOf = async (e) => (await owner.query('SELECT id FROM users WHERE email=$1', [e])).rows[0]?.id ?? null;

async function makeStaff() {
  const email = `staff-${uniq()}@nentang.vn`, password = 'staff strong passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let c = await login(email, password);
  const en = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie: c, origin: OA });
  const key = base32Decode(en.json.secret);
  await rq(AUTH, 'POST', '/auth/mfa/activate', { cookie: c, body: { code: totp(key, {}) }, origin: OA });
  const c0 = counterFor(Date.now());
  await owner.query(`INSERT INTO platform_staff (user_id,role) VALUES ($1,'admin')`, [await uidOf(email)]);
  while (counterFor(Date.now()) <= c0) await sleep(1000);
  c = await login(email, password);
  return ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie: c, body: { code: totp(key, {}) }, origin: OA })).sc) ?? c;
}

async function main() {
  const staff = await makeStaff();
  const slug = `sc-${uniq()}`;
  const shopId = (await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO })).json.id;
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  const api = await login(oe, op);
  const ui = ck((await adm('POST', '/login', { form: new URLSearchParams({ email: oe, password: op }) })).sc);
  const S = {
    get: (p) => rq(SELLER, 'GET', `/shops/${shopId}${p}`, { cookie: api }),
    post: (p, b) => rq(SELLER, 'POST', `/shops/${shopId}${p}`, { body: b, cookie: api, origin: OS }),
    patch: (p, b) => rq(SELLER, 'PATCH', `/shops/${shopId}${p}`, { body: b, cookie: api, origin: OS }),
  };
  await S.patch('', { name: slug, max_pending_per_phone: 999, max_pending_per_ip: 999 });
  const pr = await S.post('/products', { title: 'Áo cước', slug: `ao-${uniq()}`, price_vnd: 300000, status: 'active', variants: [{ sku: `SC-${uniq()}`, price_vnd: 300000, cost_vnd: 100000 }] });
  const vid = (await S.get(`/products/${pr.json.id}`)).json.variants[0].id;
  await S.post(`/variants/${vid}/inventory/adjust`, { delta: 100, reason: 'nhập' });
  const A = (oid, act, f = {}) => adm('POST', `/shops/${shopId}/orders/${oid}/${act}`, { cookie: ui, form: new URLSearchParams(f) });
  const datDon = async () => (await S.post('/orders', {
    lines: [{ variant_id: vid, qty: 1 }],
    customer: { name: 'Khách cước', phone: `09${Math.floor(10000000 + Math.random() * 89999999)}`, email: `kh-${uniq()}@khach.vn`, address_line: '1 Lê Lợi', province: 'Hà Nội' },
    payment_method: 'cod', idempotency_key: `sc-${uniq()}`,
  })).json;
  // preset HỢP LỆ: today · 7d · 30d · mtd · last_month. Bản đầu tôi gõ 'this_year' — không có
  // trong danh sách, báo cáo trả khoảng rỗng nên MỌI con số về 0 và hai khẳng định "P&L tăng
  // đúng 30.000₫" đỏ, còn khẳng định "P&L thôi tính" lại XANH vì 0 === 0. Xanh vì lý do sai.
  const baoCao = async () => (await S.get('/reports/sales?preset=30d')).json?.totals ?? {};
  const phiTrongBaoCao = async () => N((await baoCao()).carrier_fee_vnd);
  const laiTrongBaoCao = async () => N((await baoCao()).operating_profit_vnd);
  const cot = async (oid, c) => (await owner.query(`SELECT ${c} AS v FROM orders WHERE id=$1`, [oid])).rows[0]?.v;
  ui ? ok('dựng shop + sản phẩm có giá vốn') : bad('không dựng được', '');
  // Chốt chặn cho chính bộ này: preset sai → báo cáo rỗng → mọi phép so 0-với-0 đều xanh trơn.
  (await baoCao()).operating_profit_vnd !== undefined
    ? ok('báo cáo trả về đúng cấu trúc (preset hợp lệ, không phải khoảng rỗng)') : bad('báo cáo rỗng — preset sai?', JSON.stringify(await baoCao()));

  // ── 1. PHÍ CHIỀU ĐI CHO VẬN ĐƠN GIAO TAY ─────────────────────────────────
  sect('1. Vận đơn GIAO TAY — trước đây không có chỗ nào ghi tiền cước');
  const d1 = await datDon();
  await A(d1.id, 'confirm');
  await A(d1.id, 'ship', { tracking_number: `TAY${uniq()}` });   // không chọn hãng → giao tay
  const sh = (await owner.query(`SELECT provider, carrier_fee_vnd FROM shipments WHERE order_id=$1`, [d1.id])).rows[0];
  sh && sh.provider === null && sh.carrier_fee_vnd === null
    ? ok('dựng đúng ca: vận đơn giao tay, phí đang TRỐNG (đúng hiện trạng 1.568/2.019 vận đơn)')
    : bad(`ca sai: ${JSON.stringify(sh)}`, '');
  const phi0 = await phiTrongBaoCao(), lai0 = await laiTrongBaoCao();
  let r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${d1.id}/ship-cost`, { body: { outbound_fee_vnd: 30000 }, cookie: api, origin: OS });
  r.status === 200 && r.json?.shipments_updated === 1 ? ok('ghi được phí 30.000₫ cho vận đơn giao tay') : bad(`ghi hỏng: ${r.status} ${r.raw}`, '');
  (await phiTrongBaoCao()) === phi0 + 30000
    ? ok('P&L: dòng phí vận chuyển TĂNG đúng 30.000₫') : bad(`P&L không nhận: ${phi0} → ${await phiTrongBaoCao()}`, '');
  (await laiTrongBaoCao()) === lai0 - 30000
    ? ok('và lãi vận hành GIẢM đúng 30.000₫ — khoản lỗ nay có mặt trong sổ') : bad(`lãi sai: ${lai0} → ${await laiTrongBaoCao()}`, '');

  // ── 2. PHÍ CHIỀU VỀ KHI BỊ BOM ───────────────────────────────────────────
  sect('2. Đơn bị bom — cước CHIỀU VỀ, khoản không hãng nào đồng bộ về');
  const phi1 = await phiTrongBaoCao(), lai1 = await laiTrongBaoCao();
  r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${d1.id}/ship-cost`, { body: { return_fee_vnd: 25000 }, cookie: api, origin: OS });
  r.status === 409 ? ok('đơn ĐANG GIAO chưa cho nhập phí chiều về (hàng chưa quay lại thì lấy đâu ra cước về)') : bad(`nhập được khi chưa về: ${r.status}`, '');
  await A(d1.id, 'mark-returned', { restock: 'on' });
  r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${d1.id}/ship-cost`, { body: { return_fee_vnd: 25000 }, cookie: api, origin: OS });
  r.status === 200 ? ok('đơn đã quay về → nhập được 25.000₫') : bad(`ghi hỏng: ${r.status} ${r.raw}`, '');
  Number(await cot(d1.id, 'return_fee_vnd')) === 25000 ? ok('lưu đúng vào orders.return_fee_vnd') : bad('không lưu', '');
  (await phiTrongBaoCao()) === phi1 + 25000 && (await laiTrongBaoCao()) === lai1 - 25000
    ? ok('P&L cộng tiếp 25.000₫ vào phí vận chuyển và trừ đúng vào lãi — mất tiền hai chiều thì sổ ghi hai chiều')
    : bad(`P&L sai: phí ${phi1}→${await phiTrongBaoCao()}, lãi ${lai1}→${await laiTrongBaoCao()}`, '');

  // ── 3. NULL ≠ 0 ──────────────────────────────────────────────────────────
  sect('3. Bỏ trống ≠ điền 0 — "chưa biết" không được biến thành "biết chắc bằng không"');
  r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${d1.id}/ship-cost`, { body: { return_fee_vnd: 0 }, cookie: api, origin: OS });
  Number(await cot(d1.id, 'return_fee_vnd')) === 0 && r.status === 200
    ? ok('điền 0 → lưu 0 (câu trả lời "hãng không thu chiều về")') : bad('không lưu được số 0', '');
  r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${d1.id}/ship-cost`, { body: { return_fee_vnd: null }, cookie: api, origin: OS });
  (await cot(d1.id, 'return_fee_vnd')) === null
    ? ok('gửi rỗng → về NULL ("chưa nhập", màn hình còn nhắc)') : bad(`không xoá được: ${await cot(d1.id, 'return_fee_vnd')}`, '');
  (await phiTrongBaoCao()) === phi1
    ? ok('và P&L thôi tính khoản đó — NULL không bị đọc thành 0₫ chi phí') : bad('P&L vẫn giữ khoản đã xoá', '');

  // ── 4. KHÔNG GÕ ĐÈ PHÍ CỦA HÃNG ──────────────────────────────────────────
  sect('4. Vận đơn do HÃNG tạo — hãng là nguồn sự thật, không cho gõ tay đè lên');
  const d2 = await datDon();
  await A(d2.id, 'confirm');
  await A(d2.id, 'ship', { tracking_number: `GHN${uniq()}` });
  // Giả lập vận đơn đã nối hãng: đặt provider + phí do hãng đồng bộ về.
  await owner.query(`UPDATE shipments SET provider='ghn', carrier_fee_vnd=40000 WHERE order_id=$1`, [d2.id]);
  r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${d2.id}/ship-cost`, { body: { outbound_fee_vnd: 5000 }, cookie: api, origin: OS });
  r.status === 409 ? ok('gõ đè phí vận đơn của hãng → 409 (không tạo hai con số cho một khoản)') : bad(`sửa được: ${r.status}`, '');
  Number((await owner.query(`SELECT carrier_fee_vnd v FROM shipments WHERE order_id=$1`, [d2.id])).rows[0].v) === 40000
    ? ok('số của hãng còn nguyên 40.000₫') : bad('đã bị ghi đè', '');

  // ── 5. CHẶN SỐ BẬY ───────────────────────────────────────────────────────
  sect('5. Số không hợp lệ');
  for (const [ten, v] of [['âm', -1000], ['không nguyên', 1500.5], ['quá lớn', 999_000_000]]) {
    const rr = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${d1.id}/ship-cost`, { body: { return_fee_vnd: v }, cookie: api, origin: OS });
    rr.status === 400 ? ok(`${ten} → 400`) : bad(`${ten} lọt: ${rr.status}`, '');
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
