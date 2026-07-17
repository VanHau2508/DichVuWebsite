/**
 * End-to-end TẠO ĐƠN THỦ CÔNG (nhân viên chốt đơn FB/Zalo gõ vào hệ thống). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/manual-orders.e2e.mjs
 *
 * Kiểm: tạo đơn giá server-side + reserve tồn, idempotency (double-submit), hết hàng
 * rollback sạch, biến thể mồ côi/SP draft bị chặn, phí ship ghi đè + mặc định,
 * province validate, QR không cấu hình → 400, outbox order.created (source=manual),
 * state machine chạy tiếp (confirm), cô lập chéo shop.
 */
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${d}${X}`); };
const sect = (m) => console.log(`\n${B}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };

async function rq(base, method, path, { body, cookie, origin } = {}) {
  const h = {};
  if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;

async function makeStaff() {
  const email = `staff-${uniq()}@nentang.vn`, password = 'staff strong passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let cookie = await login(email, password);
  let r = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie, origin: OA });
  const key = base32Decode(r.json.secret);
  await rq(AUTH, 'POST', '/auth/mfa/activate', { cookie, body: { code: totp(key, {}) }, origin: OA });
  const c = counterFor(Date.now());
  await owner.query(`INSERT INTO platform_staff (user_id,role) VALUES ($1,'admin')`, [await uidOf(email)]);
  while (counterFor(Date.now()) <= c) await sleep(1000);
  cookie = await login(email, password);
  cookie = ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA })).sc) ?? cookie;
  return cookie;
}
async function makeShopOwner(staffCookie, slug) {
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: r.json.token, password }, origin: OA });
  return { shopId, slug, email, password, cookie: await login(email, password) };
}
async function setupProduct(shop, price, stock) {
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/products`, {
    body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `S-${uniq()}`, price_vnd: price }] }, cookie: shop.cookie, origin: OS });
  const detail = await rq(SELLER, 'GET', `/shops/${shop.shopId}/products/${r.json.id}`, { cookie: shop.cookie });
  const vid = detail.json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${shop.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: shop.cookie, origin: OS });
  return vid;
}
const invOf = async (vid) => (await owner.query(`SELECT on_hand, reserved FROM inventory_levels WHERE variant_id=$1`, [vid])).rows[0];

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `man-${uniq()}`);
  const Bs = await makeShopOwner(staff, `man-${uniq()}`);
  const vid = await setupProduct(A, 250000, 10);
  const a = {
    post: (p, b) => rq(SELLER, 'POST', `/shops/${A.shopId}${p}`, { body: b, cookie: A.cookie, origin: OS }),
    get: (p) => rq(SELLER, 'GET', `/shops/${A.shopId}${p}`, { cookie: A.cookie }),
  };
  const CUST = { name: 'Khách Chốt Zalo', phone: '0912345678', address_line: '5 Lê Lợi', province: 'TP. Hồ Chí Minh' };
  const mkBody = (over = {}) => ({ lines: [{ variant_id: vid, qty: 2 }], customer: CUST, payment_method: 'cod', idempotency_key: `manual-${uniq()}`, ...over });

  sect('1. Danh sách biến thể bán được');
  let r = await a.get('/sellable-variants');
  const sv = (r.json?.variants ?? []).find((v) => v.id === vid);
  r.status === 200 && sv && Number(sv.price_vnd) === 250000 && sv.available === 10
    ? ok('sellable-variants trả biến thể + giá + tồn') : bad('sellable-variants sai', r.raw);
  r.json?.truncated ? bad('truncated:true dù dưới trần 500', r.raw) : ok('dưới trần 500 → KHÔNG có cờ truncated');

  // Picker ?q= (Đợt 5.1): lọc tên KHÔNG DẤU + SKU. Tạo SP tên có dấu để kiểm vn_unaccent.
  const rAcc = await rq(SELLER, 'POST', `/shops/${A.shopId}/products`, {
    body: { title: `Ghế Sofa Đỏ ${uniq()}`, slug: `ghe-${uniq()}`, price_vnd: 99000, status: 'active', variants: [{ sku: `SOFA-${uniq()}`, price_vnd: 99000 }] }, cookie: A.cookie, origin: OS });
  const accDetail = await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${rAcc.json.id}`, { cookie: A.cookie });
  const accVid = accDetail.json.variants[0].id, accSku = accDetail.json.variants[0].sku;
  r = await a.get('/sellable-variants?q=ghe%20sofa');
  const hitTitle = (r.json?.variants ?? []).some((v) => v.id === accVid);
  const noisePruned = !(r.json?.variants ?? []).some((v) => v.id === vid);
  r.status === 200 && hitTitle && noisePruned
    ? ok('?q= "ghe sofa" (không dấu) khớp "Ghế Sofa Đỏ", biến thể khác bị lọc') : bad('?q= không dấu sai', r.raw);
  r = await a.get(`/sellable-variants?q=${encodeURIComponent(accSku.toLowerCase())}`);
  (r.json?.variants ?? []).some((v) => v.id === accVid)
    ? ok('?q= theo SKU (thường/hoa ILIKE) khớp biến thể') : bad('?q= SKU sai', r.raw);
  r = await a.get('/sellable-variants?q=zzz-khong-ton-tai');
  r.status === 200 && (r.json?.variants ?? []).length === 0
    ? ok('?q= không khớp → danh sách rỗng (không lỗi)') : bad('?q= rác sai', r.raw);

  sect('2. Tạo đơn COD — giá server, reserve tồn, phí mặc định');
  r = await a.post('/orders', mkBody({ note: 'khách hẹn giao chiều' }));
  const o1 = r.json;
  r.status === 201 && o1.subtotal_vnd === 500000 && o1.status === 'pending'
    ? ok(`tạo đơn 201 #${o1.order_number} subtotal đúng (giá server)`) : bad('tạo đơn lỗi', r.raw);
  o1.shipping_vnd === 30000 && o1.total_vnd === 530000
    ? ok('phí ship mặc định nền tảng 30k, total đúng') : bad(`phí sai: ship=${o1.shipping_vnd} total=${o1.total_vnd}`);
  let inv = await invOf(vid);
  Number(inv.reserved) === 2 ? ok('reserve tồn +2') : bad(`reserve sai: ${inv.reserved}`);
  const od = (await a.get(`/orders/${o1.id}`)).json;
  od.note === 'khách hẹn giao chiều' ? ok('note lưu + đọc lại được') : bad('note mất', JSON.stringify(od.note));
  od.customer_phone === '0912345678' ? ok('SĐT chuẩn hoá lưu đúng') : bad('phone sai', od.customer_phone);
  const ob = await owner.query(
    `SELECT payload FROM outbox WHERE shop_id=$1 AND topic='order.created' AND (payload->>'order_number')::int=$2`, [A.shopId, o1.order_number]);
  ob.rows.length === 1 && ob.rows[0].payload.source === 'manual' && !('to' in ob.rows[0].payload)
    ? ok('outbox order.created source=manual, KHÔNG to (không email)') : bad('outbox sai', JSON.stringify(ob.rows[0]?.payload));

  sect('3. Idempotency — double-submit không tạo đơn trùng');
  const idem = `manual-${uniq()}`;
  const b3 = mkBody({ idempotency_key: idem });
  const r1 = await a.post('/orders', b3);
  const r2 = await a.post('/orders', b3);
  r1.status === 201 && r2.status === 201 && r1.json.order_number === r2.json.order_number
    ? ok('cùng idem key → cùng đơn (replay)') : bad('idempotency vỡ', `${r1.status}/${r2.status} ${r1.json?.order_number}/${r2.json?.order_number}`);
  inv = await invOf(vid);
  Number(inv.reserved) === 4 ? ok('reserve chỉ +2 cho 1 đơn (không double)') : bad(`reserve sai: ${inv.reserved}`);
  const rDiff = await a.post('/orders', { ...mkBody({ lines: [{ variant_id: vid, qty: 3 }] }), idempotency_key: idem });
  rDiff.status === 422 ? ok('idem key dùng lại với NỘI DUNG KHÁC (qty đổi) → 422') : bad('không chặn idem-reuse', rDiff.raw);

  sect('4. Hết hàng — rollback sạch (reserve + idem claim)');
  const rOver = await a.post('/orders', mkBody({ lines: [{ variant_id: vid, qty: 100 }] }));
  rOver.status === 422 && /hết hàng/.test(rOver.json?.error ?? '') ? ok('quá tồn → 422 hết hàng') : bad('không chặn quá tồn', rOver.raw);
  inv = await invOf(vid);
  Number(inv.reserved) === 4 ? ok('reserve KHÔNG đổi sau lỗi (rollback)') : bad(`reserve rò: ${inv.reserved}`);

  sect('5. Validate — mồ côi/draft/tỉnh lạ/QR chưa bật');
  const rBadProv = await a.post('/orders', mkBody({ customer: { ...CUST, province: 'Tỉnh Không Có' } }));
  rBadProv.status === 400 ? ok('tỉnh lạ → 400') : bad('không validate tỉnh', rBadProv.raw);
  const rQr = await a.post('/orders', mkBody({ payment_method: 'qr' }));
  rQr.status === 400 && /QR/.test(rQr.json?.error ?? '') ? ok('QR chưa cấu hình → 400') : bad('QR không chặn', rQr.raw);
  // SP draft: tạo rồi thử bán
  const rd = await rq(SELLER, 'POST', `/shops/${A.shopId}/products`, {
    body: { title: `Nháp ${uniq()}`, slug: `nhap-${uniq()}`, price_vnd: 1000, status: 'draft', variants: [{ sku: `D-${uniq()}`, price_vnd: 1000 }] }, cookie: A.cookie, origin: OS });
  const draftVid = (await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${rd.json.id}`, { cookie: A.cookie })).json.variants[0].id;
  const rDraft = await a.post('/orders', mkBody({ lines: [{ variant_id: draftVid, qty: 1 }] }));
  rDraft.status === 422 ? ok('SP draft → 422 (không bán được)') : bad('draft lọt', rDraft.raw);

  sect('6. Phí ship ghi đè + state machine tiếp tục');
  const rShip = await a.post('/orders', mkBody({ ship_fee_vnd: 0 }));
  rShip.status === 201 && rShip.json.shipping_vnd === 0 && rShip.json.total_vnd === 500000
    ? ok('ghi đè phí ship 0đ (freeship thoả thuận)') : bad('ghi đè phí sai', rShip.raw);
  const rc = await a.post(`/orders/${o1.id}/confirm`, {});
  rc.status === 200 ? ok('đơn thủ công confirm được (state machine chung)') : bad('confirm lỗi', rc.raw);

  sect('7. Cô lập chéo shop');
  const rB = await rq(SELLER, 'POST', `/shops/${A.shopId}/orders`, { body: mkBody(), cookie: Bs.cookie, origin: OS });
  [401, 403, 404].includes(rB.status) ? ok(`owner shop B tạo đơn shop A → ${rB.status}`) : bad('cô lập vỡ!', rB.raw);
  const rBv = await rq(SELLER, 'GET', `/shops/${Bs.shopId}/sellable-variants`, { cookie: Bs.cookie });
  (rBv.json?.variants ?? []).some((v) => v.id === vid) ? bad('shop B THẤY biến thể shop A!') : ok('sellable-variants shop B không thấy hàng shop A');

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
