/**
 * End-to-end VẬN CHUYỂN HÃNG (GHN/GHTK). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/shipping.e2e.mjs
 *
 * Test mở STUB hãng NGAY TRONG dbtest (seller/worker trỏ GHN_API_BASE=http://dbtest:9101,
 * GHTK_API_BASE=http://dbtest:9102 qua compose.dev) — không gọi hãng thật.
 *
 * Kiểm: kết nối per-shop (step-up, token mã hoá, không lộ), tạo vận đơn (claim chống trùng,
 * consume tồn, COD thu hộ đúng), hãng lỗi → nhả claim + đơn còn nguyên, worker poll →
 * delivered + email, cô lập chéo shop, checkout province.
 */

import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const WORKER = process.env.WORKER_URL ?? 'http://worker:3080';
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
// Token lời mời KHÔNG còn trong API response (email hoá, 0073) — lấy từ outbox qua owner SQL (ADR-006: cùng tx với INSERT invitations nên đọc được ngay).
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic = 'user.invited' AND payload->>'to' = $1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${d}${X}`); };
const sect = (m) => console.log(`\n${B}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const phone = () => '09' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
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

function co(host, method, path, { body, cartToken, idemKey } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = { host, origin: `https://${host}` };
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (cartToken) headers['cookie'] = `__Host-cart=${cartToken}`;
    if (idemKey) headers['idempotency-key'] = idemKey;
    const req = http.request({ hostname: CO.hostname, port: CO.port, path, method, headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => {
        let j = null; try { j = b ? JSON.parse(b) : null; } catch {}
        let token = cartToken;
        for (const c of res.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) token = m[1]; }
        resolve({ status: res.statusCode, json: j, raw: b, cartToken: token });
      });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

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
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, slug, host: `${slug}.nentang.vn`, email, password, cookie: await login(email, password) };
}
async function setupProduct(shop, price, stock) {
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/products`, {
    body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `S-${uniq()}`, price_vnd: price }] }, cookie: shop.cookie, origin: OS });
  const detail = await rq(SELLER, 'GET', `/shops/${shop.shopId}/products/${r.json.id}`, { cookie: shop.cookie });
  const vid = detail.json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${shop.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: shop.cookie, origin: OS });
  return vid;
}
// Đặt đơn COD kèm email + province, trả {id, num}.
async function placeCod(shop, vid, email) {
  const cart = (await co(shop.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 2 } })).cartToken;
  const r = await co(shop.host, 'POST', '/checkout', {
    body: { customer: { name: 'Khách Vận Đơn', phone: phone(), email }, address: { line: '12 Nguyễn Huệ, P. Bến Nghé', province: 'TP. Hồ Chí Minh' }, payment_method: 'cod' },
    cartToken: cart, idemKey: `k-${uniq()}` });
  if (r.status !== 201) throw new Error(`checkout lỗi: ${r.raw}`);
  const id = (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2`, [shop.shopId, r.json.order_number])).rows[0].id;
  return { id, num: r.json.order_number, total: Number(r.json.total_vnd) };
}

// ── STUB hãng VC: server giả trong dbtest, hành vi điều khiển bằng biến `mode` ──
// ghtkTrackCalls: ĐẾM lượt hỏi tra-cứu GHTK. Cần đếm chứ không chỉ kiểm kết quả, vì bằng
// chứng của lỗi "đổi hãng" là worker VẪN ĐI HỎI hãng cũ (bằng token hãng mới) — nhìn kết quả
// cuối thì hai nguyên nhân "không hỏi" và "hỏi nhưng hãng từ chối" trông y hệt nhau.
// createDelayMs: giả lập request tạo vận đơn TIMEOUT (CarrierError ambiguous) → claim ở lại.
const stub = { ghtkMode: 'ok', ghtkStatus: 4, lastCreateBody: null, ghnMode: 'ok', ghtkTrackCalls: 0, ghtkTrackUrls: [], createDelayMs: 0 };
function startStubs() {
  const ghtk = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/services/shipment/order' && req.method === 'POST') {
        try { stub.lastCreateBody = JSON.parse(b); } catch { stub.lastCreateBody = null; }
        if (req.headers.token !== 'ghtk-token-cua-shop-a-123') { res.statusCode = 401; return res.end(JSON.stringify({ success: false, message: 'sai token' })); }
        if (stub.ghtkMode !== 'ok') { res.statusCode = 422; return res.end(JSON.stringify({ success: false, message: 'hãng từ chối (stub)' })); }
        const tra = () => res.end(JSON.stringify({ success: true, order: { label: `S1.A2.${Math.floor(Math.random() * 1e7)}`, fee: 22000 } }));
        // Trả CHẬM hơn CARRIER_TIMEOUT_MS → seller huỷ chờ và ném CarrierError{ambiguous}.
        // Đây là ca "không biết hãng đã tạo chưa": claim CỐ Ý ở lại, không xoá.
        return stub.createDelayMs ? setTimeout(tra, stub.createDelayMs) : tra();
      }
      if (req.url.startsWith('/services/shipment/fee') && req.method === 'GET') {
        if (req.headers.token !== 'ghtk-token-cua-shop-a-123') { res.statusCode = 401; return res.end(JSON.stringify({ success: false, message: 'sai token' })); }
        return res.end(JSON.stringify({ success: true, fee: { name: 'Nội quận', fee: 15000, insurance_fee: 0 } }));
      }
      if (req.url.startsWith('/services/shipment/v2/') && req.method === 'GET') {
        stub.ghtkTrackCalls++; stub.ghtkTrackUrls.push(req.url);
        // KIỂM TOKEN như hãng thật. Thiếu dòng này thì stub trả 'đã giao' cho BẤT KỲ token
        // nào — nên mọi phép đo về lệch-token đều MÙ, kể cả phép đo của chính bộ test này.
        if (req.headers.token !== 'ghtk-token-cua-shop-a-123') { res.statusCode = 401; return res.end(JSON.stringify({ success: false, message: 'sai token' })); }
        return res.end(JSON.stringify({ success: true, order: { status: stub.ghtkStatus } }));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  const ghn = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v2/shipping-order/create' && req.method === 'POST') {
        if (req.headers.token !== 'ghn-token-abc' || req.headers.shopid !== '190001') { res.statusCode = 401; return res.end(JSON.stringify({ code: 401, message: 'sai token/shopid' })); }
        return res.end(JSON.stringify({ code: 200, data: { order_code: `GHN${Math.floor(Math.random() * 1e7)}`, total_fee: 31000 } }));
      }
      if (req.url === '/v2/shipping-order/detail') return res.end(JSON.stringify({ code: 200, data: { status: 'delivering' } }));
      res.statusCode = 404; res.end('{}');
    });
  });
  return Promise.all([
    new Promise((r) => ghn.listen(9101, '0.0.0.0', r)),
    new Promise((r) => ghtk.listen(9102, '0.0.0.0', r)),
  ]).then(() => ({ ghn, ghtk }));
}

async function main() {
  const servers = await startStubs();
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `shipa-${uniq()}`);
  const Bs = await makeShopOwner(staff, `shipb-${uniq()}`);
  const vid = await setupProduct(A, 250000, 40);
  ok('dựng 2 shop + sản phẩm + stub GHN/GHTK (9101/9102)');

  const S = (shop) => ({
    get: (p) => rq(SELLER, 'GET', `/shops/${shop.shopId}${p}`, { cookie: shop.cookie }),
    put: (p, body) => rq(SELLER, 'PUT', `/shops/${shop.shopId}${p}`, { body, cookie: shop.cookie, origin: OS }),
    post: (p, body) => rq(SELLER, 'POST', `/shops/${shop.shopId}${p}`, { body, cookie: shop.cookie, origin: OS }),
    del: (p) => rq(SELLER, 'DELETE', `/shops/${shop.shopId}${p}`, { cookie: shop.cookie, origin: OS }),
  });
  const a = S(A);
  const PICKUP = { name: 'Kho Nhà Xinh', phone: '0901234567', address: '5 Lê Lợi', province: 'TP. Hồ Chí Minh', district: 'Quận 1' };

  // ── 1. Kết nối hãng (step-up + token mã hoá) ────────────────────────────────
  sect('1. Kết nối GHTK per-shop');
  let r = await a.get('/shipping');
  r.json?.available === true && !r.json.connected ? ok('GET /shipping → available, chưa kết nối') : bad('GET shipping sai', r.raw);
  r = await a.put('/shipping', { provider: 'ghtk', token: 'ghtk-token-cua-shop-a-123', pickup: PICKUP });
  r.status === 403 && r.json?.error === 'step_up_required' ? ok('kết nối khi chưa step-up → 403') : bad('không đòi step-up', r.raw);
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: A.password }, cookie: A.cookie, origin: OA });
  r = await a.put('/shipping', { provider: 'ghtk', token: 'ghtk-token-cua-shop-a-123', pickup: PICKUP });
  r.status === 200 && r.json.token_prefix === 'ghtk-t' ? ok('sau step-up: kết nối GHTK → 200 + prefix') : bad('kết nối lỗi', r.raw);
  r = await a.get('/shipping');
  r.json.connected && r.json.provider === 'ghtk' && !JSON.stringify(r.json).includes('ghtk-token-cua-shop-a-123')
    ? ok('GET /shipping: connected, token KHÔNG lộ trong response') : bad('token lộ hoặc chưa connected', r.raw);
  const enc = (await owner.query(`SELECT token_enc FROM shop_shipping_config WHERE shop_id=$1`, [A.shopId])).rows[0].token_enc;
  // Định dạng: legacy 'iv.tag.ct' (3 phần) hoặc v2 'v2.<kid>.iv.tag.ct' (5 phần — xoay khoá Đợt 5.6).
  const encP = enc.split('.');
  !enc.includes('ghtk-token') && (encP.length === 3 || (encP[0] === 'v2' && encP.length === 5))
    ? ok('token trong DB đã MÃ HOÁ (iv.tag.ct / v2.kid.iv.tag.ct)') : bad('token DB plaintext!', enc.slice(0, 40));

  // Kiểm tra kết nối (0đ): gọi API tính phí, KHÔNG tạo đơn.
  r = await a.get('/shipping/test');
  r.status === 200 && r.json.ok && r.json.fee === 15000 ? ok('kiểm tra kết nối → phí thử 15.000 (token hợp lệ, 0 tạo đơn)') : bad('test kết nối lỗi', r.raw);

  // ── 2. Tạo vận đơn qua hãng ─────────────────────────────────────────────────
  sect('2. Tạo vận đơn GHTK (COD thu hộ + consume tồn)');
  const o1 = await placeCod(A, vid, `khach-${uniq()}@mail.vn`);
  await a.post(`/orders/${o1.id}/confirm`, {});
  const TO = { to_name: 'Khách Vận Đơn', to_phone: '0912345678', to_address: '12 Nguyễn Huệ', to_province: 'TP. Hồ Chí Minh', to_district: 'Quận 1', weight_gram: 800 };
  const onHandBefore = Number((await owner.query(`SELECT on_hand FROM inventory_levels WHERE variant_id=$1`, [vid])).rows[0].on_hand);
  r = await a.post(`/orders/${o1.id}/carrier-shipment`, TO);
  r.status === 200 && r.json.tracking_number && r.json.carrier_fee_vnd === 22000
    ? ok(`tạo vận đơn → tracking ${r.json.tracking_number} + phí hãng 22.000`) : bad('tạo vận đơn lỗi', r.raw);
  Number(stub.lastCreateBody?.order?.pick_money) === o1.total
    ? ok(`COD thu hộ ĐÚNG tổng đơn (${o1.total})`) : bad(`pick_money sai: ${stub.lastCreateBody?.order?.pick_money} ≠ ${o1.total}`);
  stub.lastCreateBody?.order?.province === 'TP. Hồ Chí Minh' ? ok('địa chỉ nhận đẩy đúng sang hãng') : bad('địa chỉ sai', JSON.stringify(stub.lastCreateBody?.order));
  let od = (await a.get(`/orders/${o1.id}`)).json;
  od.status === 'shipped' && od.shipments?.[0]?.provider === 'ghtk' && od.shipments[0].status === 'in_transit'
    ? ok('đơn → shipped, vận đơn in_transit qua ghtk') : bad('trạng thái sai', JSON.stringify(od.shipments));
  const onHandAfter = Number((await owner.query(`SELECT on_hand FROM inventory_levels WHERE variant_id=$1`, [vid])).rows[0].on_hand);
  onHandAfter === onHandBefore - 2 ? ok('tồn kho CONSUME đúng (−2)') : bad(`tồn sai: ${onHandBefore}→${onHandAfter}`);
  r = await a.post(`/orders/${o1.id}/carrier-shipment`, TO);
  r.status === 409 ? ok('tạo lần 2 → 409 (không double-create)') : bad('double-create lọt!', r.raw);
  // Sau rà soát: is_freeship=1 (khách KHÔNG bị thu phí ship 2 lần) + ref ổn định theo đơn.
  stub.lastCreateBody?.order?.is_freeship === 1 ? ok('GHTK is_freeship=1 (shipper CHỈ thu pick_money)') : bad(`is_freeship sai: ${stub.lastCreateBody?.order?.is_freeship}`);
  stub.lastCreateBody?.order?.id === `NTG${o1.num}` ? ok('ref idempotent theo đơn (NTG<số đơn>)') : bad(`ref sai: ${stub.lastCreateBody?.order?.id}`);
  // Giao TAY khi vận đơn hãng đang chạy → 409 (một vận đơn sống mỗi đơn).
  r = await a.post(`/orders/${o1.id}/ship`, { tracking_number: 'TAY-1' });
  r.status === 409 ? ok('giao tay khi có vận đơn hãng → 409') : bad('giao tay lọt song song vận đơn hãng', r.raw);

  // ── 3. Worker poll → delivered + email ──────────────────────────────────────
  sect('3. Worker poll tracking → delivered');
  stub.ghtkStatus = 5; // hãng báo ĐÃ GIAO
  const wr = await fetch(`${WORKER}/internal/tracking-sweep`, { method: 'POST' });
  const wj = await wr.json();
  wj.delivered >= 1 ? ok(`sweep → delivered ${wj.delivered} vận đơn (checked ${wj.checked})`) : bad('sweep không giao được', JSON.stringify(wj));
  od = (await a.get(`/orders/${o1.id}`)).json;
  od.status === 'delivered' && od.shipments[0].status === 'delivered'
    ? ok('đơn → delivered + vận đơn delivered') : bad('delivered sai', `${od.status} ${od.shipments?.[0]?.status}`);
  // COD hãng giao xong = shipper ĐÃ THU tiền (0066) → tự 'paid' (trước đây unpaid vĩnh viễn).
  od.payment_status === 'paid'
    ? ok('COD giao xong → payment_status tự PAID (hãng đã thu hộ)') : bad('COD delivered vẫn unpaid', od.payment_status);
  const ob = await owner.query(
    `SELECT payload FROM outbox WHERE shop_id=$1 AND topic='order.status_changed' AND payload->>'status'='delivered' AND (payload->>'order_number')::int=$2`,
    [A.shopId, o1.num]);
  ob.rows.length === 1 && ob.rows[0].payload.tracking_number ? ok('outbox email "đã giao" kèm tracking cho khách') : bad('thiếu outbox delivered', String(ob.rows.length));

  // ── 3b. TÁCH VẬN ĐƠN (0080): kiện tay + kiện hãng → worker chốt đơn ĐÚNG lúc ──
  // Đơn 2 sp, giao TAY 1 + giao HÃNG 1 (2 kiện). Hãng báo GIAO kiện hãng → worker KHÔNG
  // được chốt đơn 'delivered' vì còn kiện TAY in_transit (provider NULL, worker không poll,
  // không có tín hiệu giao) → guard NOT EXISTS sibling giữ đơn 'shipped'. Shop tự xác nhận
  // giao xong (deliverOrder) mới chốt. COD-hãng cấm tách → dùng đơn TRẢ TRƯỚC (set paid).
  sect('3b. Tách vận đơn: giao tay + hãng, worker order-aware');
  const oS = await placeCod(A, vid, `split-${uniq()}@mail.vn`);
  await a.post(`/orders/${oS.id}/confirm`, {});
  await owner.query(`UPDATE orders SET payment_status='paid', paid_at=now() WHERE id=$1`, [oS.id]);
  let ods = (await a.get(`/orders/${oS.id}`)).json;
  const olS = ods.lines[0].order_line_id;
  r = await a.post(`/orders/${oS.id}/ship`, { tracking_number: 'TAY-S1', lines: [{ order_line_id: olS, qty: 1 }] });
  ods = (await a.get(`/orders/${oS.id}`)).json;
  r.status === 200 && ods.fulfillment_status === 'partial' && Number(ods.lines[0].shipped_qty) === 1
    ? ok('giao tay 1/2 → shipped/partial, shipped_qty=1') : bad('giao tay split lỗi', `${r.status} ff=${ods.fulfillment_status}`);
  r = await a.post(`/orders/${oS.id}/carrier-shipment`, TO);
  ods = (await a.get(`/orders/${oS.id}`)).json;
  r.status === 200 && ods.fulfillment_status === 'fulfilled' && ods.shipments.length === 2
    ? ok('giao hãng phần CÒN LẠI → fulfilled, 2 kiện (tay + hãng)') : bad('carrier split lỗi', `${r.status} ff=${ods.fulfillment_status} n=${ods.shipments?.length}`);
  stub.ghtkStatus = 5; // hãng báo ĐÃ GIAO kiện hãng
  await (await fetch(`${WORKER}/internal/tracking-sweep`, { method: 'POST' })).json();
  ods = (await a.get(`/orders/${oS.id}`)).json;
  const carrierShip = ods.shipments.find((s) => s.provider === 'ghtk');
  const manualShip = ods.shipments.find((s) => !s.provider);
  ods.status === 'shipped' && carrierShip?.status === 'delivered' && manualShip?.status === 'in_transit'
    ? ok('kiện hãng delivered NHƯNG đơn GIỮ shipped (còn kiện tay) — worker không chốt sớm')
    : bad('đơn flip sai khi còn kiện tay', `${ods.status} c=${carrierShip?.status} m=${manualShip?.status}`);
  const noOb = await owner.query(`SELECT count(*)::int n FROM outbox WHERE shop_id=$1 AND topic='order.status_changed' AND payload->>'status'='delivered' AND (payload->>'order_number')::int=$2`, [A.shopId, oS.num]);
  noOb.rows[0].n === 0 ? ok('CHƯA có email "đã giao" (đơn chưa giao xong)') : bad('email giao sớm', String(noOb.rows[0].n));
  r = await a.post(`/orders/${oS.id}/deliver`, {}); // shop tự xác nhận kiện tay đã giao
  ods = (await a.get(`/orders/${oS.id}`)).json;
  r.status === 200 && ods.status === 'delivered'
    ? ok('shop xác nhận giao xong → đơn delivered (mọi kiện xong)') : bad('deliver sau split lỗi', `${r.status} ${ods.status}`);
  stub.ghtkStatus = 4; // trả stub về đang giao cho các mục sau

  // ── 4. Hãng lỗi → nhả claim, đơn còn nguyên, retry được ────────────────────
  sect('4. Hãng từ chối → không kẹt');
  const o2 = await placeCod(A, vid, null);
  await a.post(`/orders/${o2.id}/confirm`, {});
  stub.ghtkMode = 'fail';
  r = await a.post(`/orders/${o2.id}/carrier-shipment`, TO);
  r.status === 502 && /từ chối/.test(r.json?.error ?? '') ? ok('hãng lỗi → 502 kèm thông báo') : bad('lỗi hãng xử lý sai', r.raw);
  od = (await a.get(`/orders/${o2.id}`)).json;
  od.status === 'confirmed' && (od.shipments ?? []).length === 0
    ? ok('đơn CÒN NGUYÊN confirmed, claim đã nhả (không kẹt vận đơn ma)') : bad('claim kẹt', JSON.stringify(od.shipments));
  stub.ghtkMode = 'ok';
  r = await a.post(`/orders/${o2.id}/carrier-shipment`, TO);
  r.status === 200 ? ok('retry sau khi hãng ok → 200') : bad('retry lỗi', r.raw);

  // ── 4b. Hàng HOÀN (bom hàng) → đơn 'returned', báo shop, KHÔNG tự cộng tồn ──
  // o2 đang 'shipped' với vận đơn GHTK sống. GHTK status 20 = trả hàng → sweep phải
  // chốt đơn 'returned' (trước đây kẹt 'shipped' vĩnh viễn), outbox KHÔNG có 'to'
  // (chỉ Telegram cho shop, không email khách bom hàng), on_hand GIỮ NGUYÊN (shop tự
  // Điều chỉnh tồn khi nhận lại hàng thật), sweep lặp = idempotent.
  sect('4b. Hàng hoàn (bom hàng) → returned');
  const onHandShipped = Number((await owner.query(`SELECT on_hand FROM inventory_levels WHERE variant_id=$1`, [vid])).rows[0].on_hand);
  stub.ghtkStatus = 20; // hãng báo TRẢ HÀNG
  let wrr = await (await fetch(`${WORKER}/internal/tracking-sweep`, { method: 'POST' })).json();
  od = (await a.get(`/orders/${o2.id}`)).json;
  od.status === 'returned' && od.shipments[0].status === 'returned'
    ? ok('đơn → returned + vận đơn returned') : bad('returned sai', `${od.status} ${od.shipments?.[0]?.status} ${JSON.stringify(wrr)}`);
  const rat = await owner.query(`SELECT returned_at FROM orders WHERE id=$1`, [o2.id]);
  rat.rows[0]?.returned_at ? ok('returned_at đã chốt mốc') : bad('thiếu returned_at');
  const obr = await owner.query(
    `SELECT payload FROM outbox WHERE shop_id=$1 AND topic='order.status_changed' AND payload->>'status'='returned' AND (payload->>'order_number')::int=$2`,
    [A.shopId, o2.num]);
  obr.rows.length === 1 ? ok('outbox returned đúng 1 dòng') : bad('outbox returned sai số dòng', String(obr.rows.length));
  obr.rows[0] && !('to' in obr.rows[0].payload) && obr.rows[0].payload.reason === 'carrier_returned'
    ? ok('payload KHÔNG có to (không email khách) + reason=carrier_returned') : bad('payload returned sai', JSON.stringify(obr.rows[0]?.payload));
  const onHandReturned = Number((await owner.query(`SELECT on_hand FROM inventory_levels WHERE variant_id=$1`, [vid])).rows[0].on_hand);
  onHandReturned === onHandShipped ? ok('on_hand GIỮ NGUYÊN (không tự cộng — shop tự điều chỉnh)') : bad(`on_hand đổi: ${onHandShipped}→${onHandReturned}`);
  // Sweep lần 2: idempotent — đơn giữ returned, KHÔNG thêm outbox trùng.
  await (await fetch(`${WORKER}/internal/tracking-sweep`, { method: 'POST' })).json();
  const obr2 = await owner.query(
    `SELECT count(*)::int n FROM outbox WHERE shop_id=$1 AND topic='order.status_changed' AND payload->>'status'='returned' AND (payload->>'order_number')::int=$2`,
    [A.shopId, o2.num]);
  obr2.rows[0].n === 1 ? ok('sweep lần 2 → vẫn đúng 1 outbox (idempotent)') : bad('outbox returned trùng', String(obr2.rows[0].n));
  // Đơn returned là terminal cho đường tiền: không đánh dấu đã nhận tiền được nữa.
  r = await a.post(`/orders/${o2.id}/mark-paid`, {});
  r.status === 409 ? ok('mark-paid trên đơn returned → 409') : bad('mark-paid lọt trên đơn returned', r.raw);
  stub.ghtkStatus = 4; // trả stub về trạng thái đang giao cho các mục sau

  // ── 5. Cô lập chéo shop + validation ────────────────────────────────────────
  sect('5. Cô lập + validation');
  const b = S(Bs);
  r = await b.post(`/orders/${o1.id}/carrier-shipment`, TO);
  r.status === 404 ? ok('shop B tạo vận đơn cho đơn shop A → 404') : bad('rò chéo shop', r.raw);
  const vidB = await setupProduct(Bs, 100000, 5);
  const oB = await placeCod(Bs, vidB, null);
  await S(Bs).post(`/orders/${oB.id}/confirm`, {});
  r = await b.post(`/orders/${oB.id}/carrier-shipment`, TO);
  r.status === 400 && /chưa kết nối/.test(r.json?.error ?? '') ? ok('shop B chưa kết nối → 400') : bad('thiếu guard kết nối', r.raw);
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: A.password }, cookie: A.cookie, origin: OA });
  r = await a.put('/shipping', { provider: 'ghn', token: 'ghn-token-abc', pickup: PICKUP });
  r.status === 400 && /ShopId/.test(r.json?.error ?? '') ? ok('GHN thiếu ShopId → 400') : bad('thiếu validate ghn_shop_id', r.raw);

  // ── 6. GHN adapter (đường thứ hai) ─────────────────────────────────────────
  sect('6. GHN adapter');
  r = await a.put('/shipping', { provider: 'ghn', token: 'ghn-token-abc', ghn_shop_id: '190001', pickup: PICKUP });
  r.status === 200 ? ok('đổi kết nối sang GHN → 200') : bad('đổi GHN lỗi', r.raw);
  const o3 = await placeCod(A, vid, null);
  await a.post(`/orders/${o3.id}/confirm`, {});
  r = await a.post(`/orders/${o3.id}/carrier-shipment`, TO);
  r.status === 200 && /^GHN/.test(r.json.tracking_number) && r.json.carrier_fee_vnd === 31000
    ? ok(`GHN tạo vận đơn → ${r.json.tracking_number} + phí 31.000`) : bad('GHN create lỗi', r.raw);

  // ── 7. Checkout: province ────────────────────────────────────────────────────
  sect('7. Checkout province');
  const addr = (await owner.query(`SELECT shipping_address FROM orders WHERE id=$1`, [o1.id])).rows[0].shipping_address;
  addr?.province === 'TP. Hồ Chí Minh' ? ok('đơn lưu shipping_address.province') : bad('thiếu province', JSON.stringify(addr));
  const cart = (await co(A.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 1 } })).cartToken;
  r = await co(A.host, 'POST', '/checkout', {
    body: { customer: { name: 'K', phone: phone() }, address: { line: 'x', province: 'Tỉnh Không Tồn Tại' }, payment_method: 'cod' },
    cartToken: cart, idemKey: `k-${uniq()}` });
  r.status === 400 ? ok('province lạ → 400') : bad('không validate province', r.raw);

  // ── 8. ĐỔI HÃNG khi còn kiện đang bay ───────────────────────────────────────
  sect('8. Đổi hãng khi còn kiện đang bay: không được chết ÂM THẦM');
  // shop_shipping_config có PK shop_id — MỘT dòng/shop — nên đổi hãng GHI ĐÈ token. Vận đơn
  // của hãng cũ vẫn nằm 'in_transit', và trước bản vá worker vẫn nhặt chúng lên rồi hỏi hãng
  // CŨ bằng token MỚI: hãng từ chối → xoay xuống cuối → lặp ~4.320 lượt/30 ngày rồi im. COD
  // của những đơn đó KHÔNG BAO GIỜ tự lật 'paid' (nhánh duy nhất làm việc đó nằm sau
  // st.state === 'delivered'), mà trang Vận chuyển vẫn hứa "hệ thống tự theo dõi tới khi giao xong".
  const stepUp = () => rq(AUTH, 'POST', '/auth/step-up', { body: { password: A.password }, cookie: A.cookie, origin: OA });
  const sweepTrack = () => fetch(`${WORKER}/internal/tracking-sweep`, { method: 'POST' }).then((x) => x.json());
  const donCua = async (id) => (await owner.query(`SELECT status, payment_status FROM orders WHERE id=$1`, [id])).rows[0];
  const kienCua = async (id) => (await owner.query(`SELECT status, provider, provider_status, tracking_number FROM shipments WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1`, [id])).rows[0];

  await stepUp();
  r = await a.put('/shipping', { provider: 'ghtk', token: 'ghtk-token-cua-shop-a-123', pickup: PICKUP });
  r.status === 200 ? ok('quay lại kết nối GHTK') : bad('không nối lại GHTK', r.raw);

  // ĐỐI CHỨNG: cùng kịch bản nhưng KHÔNG đổi hãng → đường tự động phải chạy trọn.
  const oCtrl = await placeCod(A, vid, null);
  await a.post(`/orders/${oCtrl.id}/confirm`, {});
  await a.post(`/orders/${oCtrl.id}/carrier-shipment`, TO);
  stub.ghtkStatus = 5;                       // hãng báo ĐÃ GIAO
  await sweepTrack();
  let d = await donCua(oCtrl.id);
  d.status === 'delivered' && d.payment_status === 'paid'
    ? ok('ĐỐI CHỨNG: không đổi hãng → sweep chốt delivered + COD tự paid')
    : bad('đường tự động vốn đã hỏng — mọi khẳng định dưới đây vô nghĩa', JSON.stringify(d));

  // Ca thật: kiện GHTK đang bay, shop đổi sang GHN.
  const oSwap = await placeCod(A, vid, null);
  await a.post(`/orders/${oSwap.id}/confirm`, {});
  await a.post(`/orders/${oSwap.id}/carrier-shipment`, TO);
  await stepUp();
  r = await a.put('/shipping', { provider: 'ghn', token: 'ghn-token-abc', ghn_shop_id: '190001', pickup: PICKUP });
  r.status === 200 && Number(r.json?.live_shipments) >= 1 && /không còn được theo dõi tự động/i.test(r.json?.warning ?? '')
    ? ok(`đổi hãng → API báo ${r.json.live_shipments} vận đơn mất theo dõi + cảnh báo chốt tay`)
    : bad('đổi hãng IM LẶNG (không đếm, không cảnh báo)', `${r.status} ${JSON.stringify(r.json)}`);
  (await kienCua(oSwap.id))?.provider_status === 'orphan'
    ? ok("kiện của hãng cũ được đánh dấu 'orphan' (mirror ngắt-kết-nối)") : bad('kiện cũ không được đánh dấu', JSON.stringify(await kienCua(oSwap.id)));

  // Đếm theo ĐÚNG MÃ VẬN ĐƠN này, không đếm tổng số lượt. Vòng quét chạy CHÉO SHOP và DB dev
  // tích luỹ vận đơn GHTK của những lần chạy trước (cùng trỏ vào stub này), nên bộ đếm toàn
  // cục sẽ chập chờn — bản thân phép đo phải miễn nhiễm với rác của lần chạy trước.
  const maSwap = (await kienCua(oSwap.id))?.tracking_number;
  const truoc = stub.ghtkTrackUrls.filter((u) => u.includes(maSwap)).length;
  await sweepTrack();
  const sau = stub.ghtkTrackUrls.filter((u) => u.includes(maSwap)).length;
  maSwap && sau === truoc
    ? ok(`sweep KHÔNG hỏi hãng cũ về ${maSwap} nữa (0 lượt gọi GHTK bằng token GHN)`)
    : bad(`sweep vẫn nã hãng cũ bằng token sai: ${sau - truoc} lượt cho ${maSwap}`);
  d = await donCua(oSwap.id);
  d.status === 'shipped' && d.payment_status === 'unpaid'
    ? ok('đơn giữ nguyên shipped/unpaid — shop phải chốt tay, đúng như cảnh báo đã nói')
    : bad('trạng thái đơn sau đổi hãng sai', JSON.stringify(d));

  // ── 9. CLAIM CHẾT không được khoá vĩnh viễn quyền sửa đơn ───────────────────
  sect('9. Claim chết (timeout) không khoá vĩnh viễn quyền SỬA ĐƠN');
  // Request tạo vận đơn timeout SAU khi hãng có thể đã nhận lệnh → seller GIỮ claim (chống
  // tạo trùng vận đơn thật). 15' sau worker đặt status='cancelled'/'claim_expired' — nhưng
  // chỉ UPDATE, shipment_lines nằm lại. Từ đó MỌI lần Sửa đơn đều 409 "đơn đã có vận đơn"
  // cho một đơn CHƯA TỪNG gửi món hàng nào, và màn sửa đơn không có đường vòng nào.
  await stepUp();
  await a.put('/shipping', { provider: 'ghtk', token: 'ghtk-token-cua-shop-a-123', pickup: PICKUP });
  const oDead = await placeCod(A, vid, null);
  await a.post(`/orders/${oDead.id}/confirm`, {});
  stub.createDelayMs = 12000;                 // > CARRIER_TIMEOUT_MS (10s)
  r = await a.post(`/orders/${oDead.id}/carrier-shipment`, TO);
  stub.createDelayMs = 0;
  r.status === 502 && /giữ chỗ|CHƯA RÕ/.test(r.json?.error ?? '')
    ? ok('gọi hãng không xong → 502 và GIỮ claim (không tạo trùng vận đơn thật)') : bad('không dựng được ca claim treo', `${r.status} ${r.raw}`);
  // DỰNG ĐÚNG HIỆN TRƯỜNG: ca ở đây là "tiến trình CHẾT TRƯỚC khi kịp gọi hãng" — claim còn
  // provider_status NULL, và CHẮC CHẮN hãng chưa nhận lệnh nên mở khoá là an toàn. Timeout
  // (mục 10) là ca KHÁC HẲN: đã gọi rồi nhưng không biết kết quả → ghi dấu 'ambiguous' và
  // KHÔNG được tự mở. Trước bản vá hai ca này không phân biệt được, nên bộ test này vô tình
  // dùng timeout để đại diện cho cả hai — tức đo nhầm ca.
  await owner.query(`UPDATE shipments SET provider_status = NULL WHERE order_id = $1 AND status = 'created'`, [oDead.id]);
  // Tua nhanh 15 phút rồi để CHÍNH vòng quét dọn claim — không tự tay UPDATE trạng thái.
  await owner.query(`UPDATE shipments SET created_at = now() - interval '20 minutes' WHERE order_id = $1 AND status = 'created'`, [oDead.id]);
  await sweepTrack();
  const kienChet = await kienCua(oDead.id);
  kienChet?.status === 'cancelled' && kienChet?.provider_status === 'claim_expired' && kienChet?.tracking_number == null
    ? ok("vòng quét đặt claim thành 'cancelled'/'claim_expired' (chưa có mã vận đơn)") : bad('GC claim không chạy', JSON.stringify(kienChet));
  r = await a.post(`/orders/${oDead.id}/edit`, {
    lines: [{ variant_id: vid, qty: 1 }],
    customer: { name: 'Khách Vận Đơn', phone: '0912345678', address_line: '12 Nguyễn Huệ', province: 'TP. Hồ Chí Minh' },
  });
  r.status === 200
    ? ok('sửa đơn ĐƯỢC sau khi claim chết bị dọn (không còn ngõ cụt vĩnh viễn)')
    : bad('claim chết vẫn khoá quyền sửa đơn', `${r.status} ${r.raw}`);
  // Nhưng vận đơn THẬT (đã có mã) thì vẫn phải chặn — dọn dẹp không được nới hàng rào.
  r = await a.post(`/orders/${oCtrl.id}/edit`, {
    lines: [{ variant_id: vid, qty: 1 }],
    customer: { name: 'K', phone: '0912345678', address_line: 'x', province: 'TP. Hồ Chí Minh' },
  });
  r.status === 409 ? ok('đơn có vận đơn THẬT vẫn 409 (hàng rào không bị nới)') : bad('nới nhầm hàng rào sửa đơn', `${r.status} ${r.raw}`);

  // ── 10. CLAIM MƠ HỒ: "không biết" KHÔNG được biến thành "chưa tạo" ──────────
  sect('10. Claim mơ hồ (timeout): giữ khoá, có đường đối soát, KHÔNG tự mở');
  // Request tạo vận đơn timeout SAU khi hãng có thể đã nhận lệnh. Trước bản vá, dòng claim
  // trông y hệt dòng "tiến trình chết trước khi kịp gọi hãng" (cùng status='created',
  // tracking NULL) nên vòng quét 15' huỷ nó bằng giả định "tracking NULL = hãng chưa tạo" →
  // mở khoá → shop tạo vận đơn THỨ HAI: hãng thu hộ COD hai lần, vận đơn đầu mồ côi.
  await stepUp();
  await a.put('/shipping', { provider: 'ghtk', token: 'ghtk-token-cua-shop-a-123', pickup: PICKUP });
  const oMo = await placeCod(A, vid, null);
  await a.post(`/orders/${oMo.id}/confirm`, {});
  stub.createDelayMs = 12000;                 // > CARRIER_TIMEOUT_MS
  r = await a.post(`/orders/${oMo.id}/carrier-shipment`, TO);
  stub.createDelayMs = 0;
  r.status === 502 && /CHƯA RÕ/.test(r.json?.error ?? '')
    ? ok('timeout → 502 nói thẳng "CHƯA RÕ hãng đã nhận lệnh chưa"') : bad('thông điệp timeout sai', `${r.status} ${r.raw?.slice(0, 120)}`);
  let k = await kienCua(oMo.id);
  k?.provider_status === 'ambiguous'
    ? ok("claim được ghi dấu 'ambiguous' — hệ GIỮ LẠI việc mình KHÔNG BIẾT") : bad('không ghi dấu mơ hồ', JSON.stringify(k));
  // Tạo lại ngay → phải bị chặn, kèm lời cảnh báo thu hộ hai lần.
  r = await a.post(`/orders/${oMo.id}/carrier-shipment`, TO);
  r.status === 409 && /hai lần|KHÔNG RÕ/i.test(r.json?.error ?? '')
    ? ok('tạo lại ngay → 409, cảnh báo nguy cơ thu hộ COD hai lần') : bad('cho tạo vận đơn thứ hai', `${r.status} ${r.json?.error ?? ''}`);
  // Tua 20 phút rồi để CHÍNH vòng quét chạy — nó KHÔNG được tự mở khoá.
  await owner.query(`UPDATE shipments SET created_at = now() - interval '20 minutes' WHERE order_id = $1 AND status = 'created'`, [oMo.id]);
  await sweepTrack();
  k = await kienCua(oMo.id);
  k?.status === 'created' && k?.provider_status === 'ambiguous'
    ? ok('vòng quét 15 phút KHÔNG huỷ claim mơ hồ (không đoán "chưa tạo")')
    : bad('vòng quét vẫn huỷ mù claim mơ hồ → mở đường tạo vận đơn trùng', JSON.stringify(k));
  // Và sửa đơn KHÔNG được xoá mất dấu vết đó (bản vá dọn claim chết của đợt trước).
  r = await a.post(`/orders/${oMo.id}/edit`, {
    lines: [{ variant_id: vid, qty: 1 }],
    customer: { name: 'K', phone: '0912345678', address_line: 'x', province: 'TP. Hồ Chí Minh' },
  });
  (await kienCua(oMo.id)) != null
    ? ok('sửa đơn KHÔNG xoá claim mơ hồ (giữ dấu vết vận đơn có thể có thật)') : bad('mất dấu claim mơ hồ khi sửa đơn');
  // ĐƯỜNG RA 1: shop kiểm trang hãng, THẤY vận đơn → nhập mã để chốt.
  r = await a.post(`/orders/${oMo.id}/carrier-reconcile`, { action: 'shipped' });
  r.status === 400 && /nhập mã vận đơn/.test(r.json?.error ?? '')
    ? ok('xác nhận mà KHÔNG có mã → 400 đòi mã (hệ không bịa mã)') : bad('chốt được mà không có mã', `${r.status} ${r.json?.error ?? ''}`);
  r = await a.post(`/orders/${oMo.id}/carrier-reconcile`, { action: 'shipped', tracking_number: 'S1.A2.9999999' });
  const dOk = (await owner.query(`SELECT status FROM orders WHERE id=$1`, [oMo.id])).rows[0];
  r.status === 200 && dOk.status === 'shipped' && (await kienCua(oMo.id))?.tracking_number === 'S1.A2.9999999'
    ? ok('nhập mã đọc trên trang hãng → chốt giao, mã vào đúng dòng vận đơn') : bad('đường ra "đã tạo" hỏng', `${r.status} ${r.raw?.slice(0, 120)}`);
  // ĐƯỜNG RA 2: hãng KHÔNG hề tạo → mở khoá, đặt lại được.
  const oMo2 = await placeCod(A, vid, null);
  await a.post(`/orders/${oMo2.id}/confirm`, {});
  stub.createDelayMs = 12000;
  await a.post(`/orders/${oMo2.id}/carrier-shipment`, TO);
  stub.createDelayMs = 0;
  r = await a.post(`/orders/${oMo2.id}/carrier-reconcile`, { action: 'cancel' });
  const k2 = await kienCua(oMo2.id);
  r.status === 200 && k2?.status === 'cancelled'
    ? ok('kiểm hãng thấy CHƯA tạo → mở khoá được') : bad('không mở khoá được', `${r.status} ${JSON.stringify(k2)}`);
  r = await a.post(`/orders/${oMo2.id}/carrier-shipment`, TO);
  r.status === 200 ? ok('sau khi mở khoá → tạo lại vận đơn bình thường (không ngõ cụt)') : bad('vẫn kẹt sau khi đối soát', `${r.status} ${r.raw?.slice(0, 120)}`);

  servers.ghn.close(); servers.ghtk.close();
  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
