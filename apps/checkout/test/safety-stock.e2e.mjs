/**
 * E2E TỒN AN TOÀN (0140). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/checkout/test/safety-stock.e2e.mjs
 *
 * Tính năng: chừa một phần tồn KHÔNG bán online, để hàng vỡ / bán tại quầy / đếm sai không
 * làm khách đặt trúng món đã hết.
 *
 * Bộ này phải chứng minh ĐỦ CẢ HAI CHIỀU, vì một vùng đệm sai hướng thì hoặc là vô dụng
 * (không chặn gì) hoặc là ăn doanh thu (chặn cả khi không nên):
 *   1. Tắt mặc định — shop chưa cấu hình thì hành vi y hệt trước 0140 (pct = 0).
 *   2. KHÔNG BÁN QUÁ PHẦN — kể cả khi N khách đặt ĐỒNG THỜI (đây là khẳng định trung tâm).
 *   3. Storefront và checkout nói CÙNG một con số — trang bảo "còn hàng" mà checkout từ chối
 *      là lỗi tệ nhất của tính năng này.
 *   4. ĐƠN TAY của người bán VẪN bán được vào vùng đệm — ranh giới CỐ Ý, không phải sót.
 *   5. Ghi đè theo biến thể thắng tỉ lệ chung; ô trống ≠ số 0.
 *   6. Bộ đếm "bị chặn" chỉ tăng khi kho CÒN hàng thật (đo cái giá của tính năng),
 *      KHÔNG tăng khi hết sạch (lúc đó tính năng đang làm đúng việc, không phải chi phí).
 */
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const STORE = new URL(process.env.STOREFRONT_URL ?? 'http://storefront:3050');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 5 });
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const G = '\x1b[32m', RED = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', BOLD = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${RED}FAIL${X} ${m}`); if (d) console.log(`       ${D}${String(d).slice(0, 200)}${X}`); };
const sect = (m) => console.log(`\n${BOLD}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };

async function rq(base, method, path, { body, cookie, origin } = {}) {
  const h = {}; if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin; if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
const login = async (e, p) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email: e, password: p }, origin: OA })).sc);
const uidOf = async (e) => (await owner.query('SELECT id FROM users WHERE email=$1', [e])).rows[0]?.id ?? null;
// Trang quản trị (BFF, no-JS): form urlencoded, KHÔNG tự đi theo redirect (cần đọc Location).
async function adm(method, path, { cookie, origin, form } = {}) {
  const h = {}; if (form !== undefined) h['content-type'] = 'application/x-www-form-urlencoded';
  if (origin) h.origin = origin; if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(ADMIN + path, { method, headers: h, redirect: 'manual', body: form !== undefined ? new URLSearchParams(form).toString() : undefined });
  return { status: r.status, location: r.headers.get('location'), sc: r.headers.getSetCookie(), body: await r.text() };
}
const admLogin = async (e, p) => ck((await adm('POST', '/login', { origin: OADM, form: { email: e, password: p } })).sc);

let HOST;
// HTTP thô: cần đặt Host (định tuyến theo tên miền shop) + cookie giỏ + Idempotency-Key.
function hit(target, method, path, { json, cartCookie, idem } = {}) {
  return new Promise((resolve, reject) => {
    const data = json !== undefined ? JSON.stringify(json) : null;
    const headers = { host: HOST, origin: `https://${HOST}` };
    if (data != null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (cartCookie) headers.cookie = `__Host-cart=${cartCookie}`;
    if (idem) headers['idempotency-key'] = idem;
    const req = http.request({ hostname: target.hostname, port: target.port, path, method, headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => {
        let j = null; try { j = b ? JSON.parse(b) : null; } catch {}
        let token = cartCookie;
        for (const c of res.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) token = m[1]; }
        resolve({ status: res.statusCode, json: j, raw: b, cartCookie: token });
      });
    });
    req.on('error', reject); if (data != null) req.write(data); req.end();
  });
}
const co = (m, p, o) => hit(CO, m, p, o);
const sf = (p) => hit(STORE, 'GET', p);

// Tách hai bước. Bước THÊM VÀO GIỎ cũng có hàng rào tồn riêng của nó; nếu để chung một hàm
// thì ca "giỏ nhận, checkout mới chặn" không dựng được — mà đó chính là ca duy nhất chạm tới
// nhánh HẾT SẠCH của hàng rào checkout.
const themGio = (vid, qty) => co('POST', '/cart/items', { json: { variant_id: vid, qty } });
const chotGio = (cartCookie, tag) => co('POST', '/checkout', {
  json: { customer: { name: 'Khách', phone: sdt(), email: `k-${uniq()}@x.vn` }, address: { line: '1 Lê Lợi', province: 'Hà Nội' }, payment_method: 'cod' },
  cartCookie, idem: `ss-${tag}-${uniq()}`,
});

// Đặt một đơn qua checkout với giỏ RIÊNG (mỗi lần một giỏ — giỏ đã convert thì không dùng lại được).
// MỖI ĐƠN MỘT SĐT KHÁC NHAU. Kho có trần "đơn chưa xử lý per-SĐT" (chống đơn ảo, docs/34);
// dùng chung một số thì từ đơn thứ N trở đi bị trần đó chặn và bộ này sẽ đo NHẦM cơ chế —
// đúng lớp lỗi "khẳng định không đo thứ nó tưởng". Trần per-IP cũng được nới ở main().
const sdt = () => `09${Math.floor(10000000 + Math.random() * 89999999)}`;
async function datHang(vid, qty, tag) {
  const cart = (await co('POST', '/cart/items', { json: { variant_id: vid, qty } }));
  if (cart.status !== 200 && cart.status !== 201) return { status: cart.status, json: cart.json, raw: cart.raw, cartFailed: true };
  return co('POST', '/checkout', {
    json: { customer: { name: 'Khách', phone: sdt(), email: `k-${uniq()}@x.vn` }, address: { line: '1 Lê Lợi', province: 'Hà Nội' }, payment_method: 'cod' },
    cartCookie: cart.cartCookie, idem: `ss-${tag}-${uniq()}`,
  });
}

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
  const slug = `ss-${uniq()}`;
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO });
  const shopId = r.json.id; HOST = `${slug}.nentang.vn`;
  await owner.query(`UPDATE shops SET status='active', went_live_at=now() WHERE id=$1`, [shopId]);
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  const oc = await login(oe, op);
  // Nới hai trần chống-đơn-ảo cho shop TEST. Chúng bảo vệ shop thật khỏi bom hàng, nhưng ở
  // đây một máy đóng vai N khách nên chúng sẽ chặn trước cả vùng đệm — và bộ test sẽ xanh/đỏ
  // vì lý do khác thứ nó tuyên bố đo.
  await rq(SELLER, 'PATCH', `/shops/${shopId}`, { body: { name: slug, max_pending_per_phone: 999, max_pending_per_ip: 999 }, cookie: oc, origin: OS });
  const S = {
    get: (p) => rq(SELLER, 'GET', `/shops/${shopId}${p}`, { cookie: oc }),
    post: (p, b) => rq(SELLER, 'POST', `/shops/${shopId}${p}`, { body: b, cookie: oc, origin: OS }),
    put: (p, b) => rq(SELLER, 'PUT', `/shops/${shopId}${p}`, { body: b, cookie: oc, origin: OS }),
  };
  const mkSP = async (title, qty) => {
    const c = await S.post('/products', { title, slug: `${slug}-${uniq()}`, price_vnd: 100000, status: 'active', variants: [{ sku: `SS-${uniq()}`, price_vnd: 100000 }] });
    const p = (await S.get(`/products/${c.json.id}`)).json;
    const vid = p.variants[0].id;
    if (qty) await S.post(`/variants/${vid}/inventory/adjust`, { delta: qty, reason: 'nhập' });
    return { pid: c.json.id, vid, slug: p.slug };
  };
  const lvlOf = async (vid) => (await owner.query(`SELECT on_hand, reserved, safety_stock_qty, safety_blocked_count FROM inventory_levels WHERE variant_id=$1`, [vid])).rows[0];
  // Bộ đếm bị-chặn được ghi SAU KHI transaction đặt đơn rollback, và CỐ Ý không await (đo đạc
  // không được giữ chân khách — xem ghiNhanBiDemChan). Nên nó tới TRỄ vài ms: đọc ngay lập tức
  // là đo lúc chưa ghi xong. Chờ có trần; hết giờ vẫn trả số thật để khẳng định báo đúng.
  const demSau = async (vid, mong, msToiDa = 3000) => {
    const het = Date.now() + msToiDa;
    for (;;) {
      const n = Number((await lvlOf(vid)).safety_blocked_count);
      if (n === mong || Date.now() > het) return n;
      await sleep(50);
    }
  };
  const safetyRow = async (vid) => ((await S.get('/inventory/safety?limit=100')).json?.rows ?? []).find((x) => x.variant_id === vid);

  // ── 1. TẮT MẶC ĐỊNH ────────────────────────────────────────────────────────
  // Tính năng mới KHÔNG được đổi hành vi của shop chưa hề bật nó. Đây là khẳng định rẻ nhất
  // mà lại chặn được lớp lỗi tệ nhất: 0140 vô tình khoá bán của mọi shop đang chạy.
  sect('1. Mặc định TẮT (pct = 0) — hành vi y như trước');
  const A = await mkSP('Áo mặc định', 10);
  r = await S.get('/inventory/safety');
  r.status === 200 && Number(r.json.safety_stock_pct) === 0 ? ok('shop mới: tỉ lệ giữ an toàn = 0') : bad('tỉ lệ mặc định khác 0', r.raw);
  let row = await safetyRow(A.vid);
  row && Number(row.on_hand) === 10 && Number(row.safety_effective) === 0 && Number(row.available_online) === 10
    ? ok('ba con số khi tắt: tồn 10 · giữ 0 · bán được 10') : bad('ba con số sai khi tắt', JSON.stringify(row));
  r = await datHang(A.vid, 10, 'off');
  r.status === 201 ? ok('mua trọn 10/10 khi chưa bật đệm → 201') : bad('đệm chặn dù pct=0', r.raw);

  // ── 2. BẬT TỈ LỆ TOÀN SHOP ─────────────────────────────────────────────────
  sect('2. Bật tỉ lệ 20% cho toàn shop');
  r = await S.put('/inventory/safety', { safety_stock_pct: 20 });
  r.status === 200 ? ok('lưu tỉ lệ 20% → 200') : bad('không lưu được tỉ lệ', r.raw);
  r = await S.put('/inventory/safety', { safety_stock_pct: 91 });
  r.status === 400 ? ok('tỉ lệ 91 > trần 90 → 400') : bad('nhận tỉ lệ vượt trần', r.raw);
  r = await S.put('/inventory/safety', { safety_stock_pct: -1 });
  r.status === 400 ? ok('tỉ lệ âm → 400') : bad('nhận tỉ lệ âm', r.raw);
  r = await S.put('/inventory/safety', { safety_stock_pct: 20.5 });
  r.status === 400 ? ok('tỉ lệ không nguyên → 400') : bad('nhận tỉ lệ thập phân', r.raw);
  // Trần 90 chỉ có nghĩa nếu 90 là HỢP LỆ — kiểm cả mép trên, không chỉ mép ngoài.
  r = await S.put('/inventory/safety', { safety_stock_pct: 90 });
  r.status === 200 ? ok('tỉ lệ 90 (đúng trần) → 200') : bad('từ chối đúng trần 90', r.raw);
  await S.put('/inventory/safety', { safety_stock_pct: 20 });

  const B = await mkSP('Áo có đệm', 10);
  row = await safetyRow(B.vid);
  // 20% của 10 = 2.0 → ceil = 2. Chọn 10 để số tròn, ca làm-tròn-LÊN kiểm riêng ở mục 7.
  row && Number(row.safety_effective) === 2 && Number(row.available_online) === 8
    ? ok('tồn 10 · giữ 2 (20%) · bán được 8') : bad('công thức đệm sai', JSON.stringify(row));

  // ── 3. KHÔNG BÁN QUÁ PHẦN (khẳng định trung tâm) ───────────────────────────
  sect('3. Không bán quá phần');
  r = await datHang(B.vid, 9, 'over');
  r.status === 422 && r.cartFailed === true && r.json?.error_code === 'inventory_unavailable'
    && r.json?.variant_id === B.vid && Number(r.json?.available_qty) === 8 && r.json?.action
    ? ok('thêm giỏ 9 > 8 → chặn ngay, trả available_qty + hành động rõ ràng')
    : bad('giỏ nhận quá ATS hoặc lỗi không có hướng xử lý', r.raw);
  let lvl = await lvlOf(B.vid);
  Number(lvl.reserved) === 0 ? ok('đơn bị chặn KHÔNG để lại giữ chỗ rác (reserved = 0)') : bad(`reserved = ${lvl.reserved} sau đơn bị chặn`, '');
  let dem = await demSau(B.vid, 1);
  dem === 1
    ? ok('bộ đếm bị-chặn = 1 (kho còn hàng thật → đúng là chi phí của tính năng)')
    : bad(`bộ đếm bị-chặn = ${dem}, mong 1`, '');

  const BSet = await mkSP('Áo sửa giỏ có đệm', 10);
  let cartSet = await themGio(BSet.vid, 7);
  r = await co('PATCH', '/cart/items', { json: { variant_id: BSet.vid, qty: 9 }, cartCookie: cartSet.cartCookie });
  const kept = await co('GET', '/cart/summary', { cartCookie: cartSet.cartCookie });
  r.status === 422 && r.json?.error_code === 'inventory_unavailable' && Number(r.json?.available_qty) === 8
    && kept.status === 200 && Number(kept.json?.items?.[0]?.qty) === 7
    ? ok('drawer tăng quá ATS → 422 có số còn lại, giỏ giữ nguyên 7')
    : bad('cập nhật giỏ nuốt lỗi hoặc làm mất dòng cũ', JSON.stringify({ error: r.json, kept: kept.json }));

  r = await datHang(B.vid, 8, 'exact');
  r.status === 201 ? ok('đặt đúng 8 = bán-được → 201') : bad('chặn nhầm đơn hợp lệ', r.raw);
  lvl = await lvlOf(B.vid);
  Number(lvl.reserved) === 8 && Number(lvl.on_hand) === 10
    ? ok('sau đơn: tồn thực vẫn 10, giữ chỗ 8 (đệm KHÔNG trừ vào tồn thật)') : bad('tồn/giữ chỗ sai sau đơn', JSON.stringify(lvl));
  row = await safetyRow(B.vid);
  Number(row.available_online) === 0 ? ok('bán được online về 0 (10 − 8 − 2)') : bad(`bán được = ${row?.available_online}`, JSON.stringify(row));
  r = await datHang(B.vid, 1, 'after');
  r.status === 422 ? ok('đặt thêm 1 khi đã hết phần bán-được → 422') : bad('BÁN QUÁ PHẦN ở đơn kế tiếp', r.raw);
  dem = await demSau(B.vid, 2);
  dem === 2 ? ok('bộ đếm bị-chặn lên 2 (vẫn còn 2 cái trong kho)') : bad(`bộ đếm = ${dem}, mong 2`, '');

  // ── 4. ĐUA ĐỒNG THỜI ───────────────────────────────────────────────────────
  // Hàng rào nằm TRONG transaction đang giữ FOR UPDATE. Nếu ai đó dời nó ra ngoài (đọc trước,
  // ghi sau) thì ca một-đơn-một-lúc vẫn xanh, còn ca này đỏ. Đây là bộ canh cho chuyện đó.
  sect('4. Đua N khách đặt cùng lúc');
  const C = await mkSP('Áo đua', 10);            // giữ 2 → bán được 8
  const N = 12;
  const res = await Promise.all(Array.from({ length: N }, (_, i) => datHang(C.vid, 1, `race${i}`)));
  const created = res.filter((x) => x.status === 201).length;
  created === 8 ? ok(`${N} khách đặt 1 cái cùng lúc → ĐÚNG 8 đơn thành công`) : bad(`đua ra ${created} đơn, mong 8`, JSON.stringify(res.map((x) => x.status)));
  lvl = await lvlOf(C.vid);
  Number(lvl.reserved) === 8 && Number(lvl.on_hand) === 10
    ? ok('sau đua: giữ chỗ đúng 8, tồn thực 10 — 2 cái đệm còn nguyên') : bad('đua làm hỏng tồn/giữ chỗ', JSON.stringify(lvl));

  // ── 5. ĐƠN TAY VẪN BÁN ĐƯỢC VÀO ĐỆM (ranh giới CỐ Ý) ───────────────────────
  // Đệm sinh ra để bù cho việc CON SỐ trong máy không đáng tin. Người bán đứng trước khách và
  // NHÌN THẤY kho thật thì đáng tin hơn con số — chặn họ là chặn nhầm đối tượng.
  sect('5. Đơn TAY của người bán không bị đệm chặn');
  const before = await lvlOf(C.vid);
  const conLaiTrongDem = Number(before.on_hand) - Number(before.reserved);  // = 2 nếu đua đúng
  r = await S.post('/orders', {
    lines: [{ variant_id: C.vid, qty: conLaiTrongDem }],
    customer: { name: 'Khách quen', phone: '0912345678', address_line: '5 Lê Lợi', province: 'TP. Hồ Chí Minh' },
    payment_method: 'cod', idempotency_key: `manual-${uniq()}`,
  });
  r.status === 201 ? ok(`đơn tay lấy nốt ${conLaiTrongDem} cái trong vùng đệm → 201`) : bad('đệm chặn nhầm đơn tay', r.raw);
  lvl = await lvlOf(C.vid);
  Number(lvl.reserved) === Number(lvl.on_hand)
    ? ok('đơn tay đẩy giữ-chỗ chạm ĐÚNG tồn thực (đệm không cản)') : bad('đơn tay không giữ chỗ đúng', JSON.stringify(lvl));
  // Hàng rào chống oversell THẬT (0009) vẫn là lớp cuối: quá TỒN THỰC thì đơn tay cũng trượt.
  r = await S.post('/orders', {
    lines: [{ variant_id: C.vid, qty: 1 }],
    customer: { name: 'Khách quen', phone: '0912345678', address_line: '5 Lê Lợi', province: 'TP. Hồ Chí Minh' },
    payment_method: 'cod', idempotency_key: `manual-${uniq()}`,
  });
  r.status !== 201 ? ok('đơn tay vượt TỒN THỰC vẫn bị chặn (lớp cuối 0009 nguyên vẹn)') : bad('đơn tay bán quá tồn thực', r.raw);

  // ── 6. GHI ĐÈ THEO BIẾN THỂ ────────────────────────────────────────────────
  sect('6. Ghi đè theo biến thể');
  const E = await mkSP('Áo ghi đè', 10);          // tỉ lệ chung cho 2
  r = await S.put(`/variants/${E.vid}/inventory/safety`, { safety_stock_qty: 5 });
  r.status === 200 ? ok('lưu ghi đè 5 cái → 200') : bad('không lưu được ghi đè', r.raw);
  row = await safetyRow(E.vid);
  Number(row.safety_effective) === 5 && Number(row.available_online) === 5
    ? ok('ghi đè 5 THẮNG tỉ lệ chung (2) → bán được 5') : bad('ghi đè không thắng tỉ lệ', JSON.stringify(row));
  r = await datHang(E.vid, 6, 'ovr');
  r.status === 422 ? ok('đặt 6 > 5 → 422 (chặn theo mức ghi đè)') : bad('ghi đè không cưỡng chế ở checkout', r.raw);

  // Số 0 và ô TRỐNG là HAI Ý KHÁC NHAU — gộp chúng là làm shop mất khả năng nói "SP này bán hết".
  r = await S.put(`/variants/${E.vid}/inventory/safety`, { safety_stock_qty: 0 });
  row = await safetyRow(E.vid);
  r.status === 200 && Number(row.safety_effective) === 0 && Number(row.available_online) === 10
    ? ok('ghi đè 0 = KHÔNG giữ gì cả (khác với bỏ ghi đè)') : bad('ghi đè 0 không có tác dụng', JSON.stringify(row));
  r = await S.put(`/variants/${E.vid}/inventory/safety`, { safety_stock_qty: null });
  row = await safetyRow(E.vid);
  r.status === 200 && Number(row.safety_effective) === 2 && row.safety_override === null
    ? ok('bỏ ghi đè (null) → quay về tỉ lệ chung = 2') : bad('bỏ ghi đè không quay về tỉ lệ', JSON.stringify(row));
  r = await S.put(`/variants/${E.vid}/inventory/safety`, { safety_stock_qty: -3 });
  r.status === 400 ? ok('ghi đè âm → 400') : bad('nhận ghi đè âm', r.raw);
  // Biến thể CHƯA từng nhập hàng vẫn phải đặt ghi đè được, nếu không thì "chừa 2 cái" chỉ
  // làm được sau khi hàng đã về — tức là muộn.
  const F = await mkSP('Áo chưa nhập', 0);
  r = await S.put(`/variants/${F.vid}/inventory/safety`, { safety_stock_qty: 3 });
  row = await safetyRow(F.vid);
  r.status === 200 && Number(row.safety_override) === 3 && Number(row.available_online) === 0
    ? ok('đặt ghi đè cho biến thể chưa có dòng tồn → tạo dòng, bán được 0') : bad('không đặt được ghi đè khi chưa nhập hàng', JSON.stringify(row));

  // ── 7. LÀM TRÒN LÊN ────────────────────────────────────────────────────────
  // Đệm là vùng chống sai số → chệch về phía GIỮ NHIỀU HƠN mới đúng ý định. (Khác tiền: hoa
  // hồng làm tròn XUỐNG để không đẻ đồng không có thật.)
  sect('7. Làm tròn LÊN');
  const H = await mkSP('Áo lẻ', 7);               // 20% của 7 = 1.4 → ceil = 2, KHÔNG phải 1
  row = await safetyRow(H.vid);
  Number(row.safety_effective) === 2 && Number(row.available_online) === 5
    ? ok('tồn 7 × 20% = 1.4 → giữ 2 (làm tròn LÊN), bán được 5') : bad('không làm tròn lên', JSON.stringify(row));
  // Đệm lớn hơn tồn hiện có → 0, KHÔNG âm.
  const I = await mkSP('Áo ít', 3);
  await S.put(`/variants/${I.vid}/inventory/safety`, { safety_stock_qty: 10 });
  row = await safetyRow(I.vid);
  Number(row.available_online) === 0 ? ok('đệm 10 > tồn 3 → bán được 0 (không âm)') : bad(`bán được = ${row?.available_online}`, JSON.stringify(row));

  // ── 8. BỘ ĐẾM CHỈ ĐO ĐÚNG THỨ NÓ NÓI ───────────────────────────────────────
  // "Bị chặn vì ĐỆM" (kho còn hàng) là CHI PHÍ. "Bị chặn vì HẾT SẠCH" là tính năng làm đúng
  // việc. Gộp hai thứ lại thì con số vô nghĩa, và tháng sau không ai đọc nó ra kết luận gì.
  sect('8. Bộ đếm bị-chặn chỉ đếm ca CÒN HÀNG');
  const J = await mkSP('Áo hết sạch', 2);
  await S.put(`/variants/${J.vid}/inventory/safety`, { safety_stock_qty: 0 });  // tắt đệm riêng SP này
  // HAI KHÁCH cùng bỏ món cuối vào giỏ, rồi lần lượt bấm đặt. Phải dựng đúng như vậy: nếu chỉ
  // gọi "đặt hàng" lần hai thì bước THÊM VÀO GIỎ chặn trước, checkout không hề chạy, và khẳng
  // định dưới đây xanh mà chẳng đo gì (đột biến gỡ điều kiện đếm vẫn xanh — đã kiểm).
  const gio1 = await themGio(J.vid, 2);
  const gio2 = await themGio(J.vid, 2);
  r = await chotGio(gio1.cartCookie, 'all');
  r.status === 201 ? ok('khách 1 mua sạch 2/2 (đệm 0) → 201') : bad('không mua được khi đệm 0', r.raw);
  r = await chotGio(gio2.cartCookie, 'empty');
  r.status === 422 ? ok('khách 2 bấm đặt khi kho đã hết sạch → 422 tại hàng rào checkout') : bad('bán được khi đã hết', r.raw);
  // Khẳng định PHỦ ĐỊNH nên phải chờ đủ lâu: đọc ngay thì "0" có thể chỉ là chưa kịp ghi.
  // demSau(…, 1) chờ tới khi thấy 1 hoặc hết 1.5s — hết giờ mà vẫn 0 mới là bằng chứng thật.
  dem = await demSau(J.vid, 1, 1500);
  dem === 0
    ? ok('hết SẠCH → bộ đếm KHÔNG tăng (không phải chi phí của đệm)') : bad(`bộ đếm = ${dem}, mong 0`, '');

  // ── 9. STOREFRONT NÓI CÙNG CON SỐ VỚI CHECKOUT ─────────────────────────────
  // Lớp lỗi tệ nhất của tính năng này: trang bán hàng bảo "còn hàng", khách bấm đặt rồi bị
  // checkout từ chối. Hai nơi phải dùng CHUNG một công thức (packages/inventory/safety-stock.js).
  sect('9. Storefront khớp checkout');
  const K = await mkSP('Áo trưng bày', 5);
  await S.put(`/variants/${K.vid}/inventory/safety`, { safety_stock_qty: 5 }); // giữ hết → bán được 0
  // DẤU HIỆU PHẢI CHÍNH XÁC: chuỗi "Hết hàng" CÓ SẴN trong khối JS của mọi trang SP
  // (nhánh đổi nhãn khi chọn phân loại), nên regex theo chữ luôn khớp — khẳng định sẽ xanh
  // vĩnh viễn mà không đo gì. Dấu hiệu thật là ô trạng thái `<div class="stock out">`.
  const HET = /class="stock out"/;
  let html = await sf(`/p/${K.slug}`);
  html.status === 200 && HET.test(html.raw)
    ? ok('đệm nuốt trọn tồn → trang SP hiện HẾT HÀNG (dù kho còn 5)') : bad('trang SP vẫn mời mua', html.raw.slice(0, 300));
  html.raw.includes('id="cd-error"') && html.raw.includes("fetch('/cart/items',{method:'PATCH'")
    ? ok('drawer có vùng báo lỗi tại chỗ + cập nhật JSON, no-JS form vẫn giữ riêng')
    : bad('drawer vẫn nuốt lỗi cập nhật tồn', html.raw.slice(-500));
  r = await datHang(K.vid, 1, 'sfmatch');
  r.status === 422 ? ok('và checkout cũng từ chối → hai bên KHỚP') : bad('storefront và checkout lệch nhau', r.raw);
  await S.put(`/variants/${K.vid}/inventory/safety`, { safety_stock_qty: 1 }); // bán được 4
  html = await sf(`/p/${K.slug}`);
  !HET.test(html.raw) ? ok('hạ đệm xuống 1 → trang SP mời mua lại') : bad('trang SP vẫn báo hết sau khi hạ đệm', html.raw.slice(0, 300));
  r = await datHang(K.vid, 5, 'sfover');
  r.status === 422 ? ok('nhưng đặt 5 (vượt 4 bán-được) vẫn bị chặn') : bad('bán quá phần sau khi hạ đệm', r.raw);
  r = await datHang(K.vid, 4, 'sfok');
  r.status === 201 ? ok('đặt đúng 4 → 201') : bad('chặn nhầm ở mức bán-được', r.raw);

  // ── 10. PHÂN QUYỀN ─────────────────────────────────────────────────────────
  // Đệm là cần gạt DOANH THU: đặt 90% là gần như đóng cửa hàng. Cùng nhóm quyền với
  // Nhập hàng/Kiểm kê/Sổ cái (inventory.manage = owner/admin), không phải quyền sửa SP.
  sect('10. Phân quyền inventory.manage');
  // 'order_manager' — vai CÓ THẬT trong hệ (rbac.js) và KHÔNG có inventory.manage. Lần đầu
  // tôi mời vai 'staff' (không tồn tại) → lời mời 400 → không có phiên → mọi khẳng định dưới
  // đây nhận 401 và TRÔNG như đã chặn. Đúng dạng "khẳng định xanh vì lý do sai".
  const se = `om-${uniq()}@shop.vn`, sp = 'nhanvien passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: se, role: 'order_manager' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(se), password: sp }, origin: OA });
  const sc = await login(se, sp);
  // Không có cookie = 401, và 401 KHÔNG chứng minh được điều gì về phân quyền. Chốt chặn này
  // để bộ test không tự lừa mình như lần đầu chạy (lời mời hỏng → 401 → trông như "đã chặn").
  sc ? ok('dựng được tài khoản order_manager (có phiên đăng nhập thật)') : bad('không dựng được thành viên — ba khẳng định phân quyền dưới đây VÔ NGHĨA', '');
  r = await rq(SELLER, 'GET', `/shops/${shopId}/inventory/safety`, { cookie: sc });
  r.status === 403 ? ok('order_manager XEM tồn an toàn → 403') : bad(`order_manager xem được (status ${r.status})`, r.raw);
  r = await rq(SELLER, 'PUT', `/shops/${shopId}/inventory/safety`, { body: { safety_stock_pct: 50 }, cookie: sc, origin: OS });
  r.status === 403 ? ok('order_manager SỬA tỉ lệ → 403') : bad(`order_manager sửa được (status ${r.status})`, r.raw);
  r = await rq(SELLER, 'PUT', `/shops/${shopId}/variants/${B.vid}/inventory/safety`, { body: { safety_stock_qty: 9 }, cookie: sc, origin: OS });
  r.status === 403 ? ok('order_manager SỬA ghi đè → 403') : bad(`order_manager sửa ghi đè được (status ${r.status})`, r.raw);

  // ── 11. CÁCH LY GIỮA CÁC SHOP ──────────────────────────────────────────────
  sect('11. Cách ly shop');
  const slug2 = `ss2-${uniq()}`;
  r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug2, slug: slug2, plan_code: 'platform' }, cookie: staff, origin: OO });
  const shop2 = r.json.id;
  const oe2 = `owner-${uniq()}@shop.vn`;
  await rq(PLATFORM, 'POST', `/ops/shops/${shop2}/invitations`, { body: { email: oe2, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe2), password: op }, origin: OA });
  const oc2 = await login(oe2, op);
  r = await rq(SELLER, 'GET', `/shops/${shop2}/inventory/safety`, { cookie: oc2 });
  r.status === 200 && Number(r.json.safety_stock_pct) === 0
    ? ok('shop khác KHÔNG kế thừa tỉ lệ 20% của shop này') : bad('tỉ lệ rò sang shop khác', r.raw);
  (r.json.rows ?? []).every((x) => x.variant_id !== B.vid)
    ? ok('shop khác không thấy biến thể của shop này') : bad('RLS thủng: thấy biến thể shop khác', '');
  r = await rq(SELLER, 'PUT', `/shops/${shopId}/variants/${B.vid}/inventory/safety`, { body: { safety_stock_qty: 99 }, cookie: oc2, origin: OS });
  // 403 (không phải thành viên) hay 404 (RLS giấu luôn sự tồn tại) đều đạt — miễn KHÔNG ghi được.
  r.status !== 200 ? ok(`chủ shop khác sửa ghi đè của shop này → ${r.status}`) : bad('sửa được chéo shop', r.raw);
  const chuaDoi = await lvlOf(B.vid);
  chuaDoi.safety_stock_qty === null ? ok('và dữ liệu KHÔNG hề đổi') : bad(`ghi đè bị đổi thành ${chuaDoi.safety_stock_qty}`, '');

  // ── 12. MÀN HÌNH NGƯỜI BÁN ─────────────────────────────────────────────────
  // API đúng mà màn hình không hiện thì tính năng KHÔNG TỒN TẠI với người dùng. Mục này đi
  // đúng đường của người bán: đăng nhập trang quản trị → mở trang → gõ số → bấm Lưu.
  sect('12. Trang Tồn an toàn trong quản trị');
  const ac = await admLogin(oe, op);
  ac ? ok('đăng nhập trang quản trị') : bad('không đăng nhập được quản trị', '');
  let pg = await adm('GET', `/shops/${shopId}/safety-stock`, { cookie: ac });
  pg.status === 200 ? ok('mở được trang Tồn an toàn') : bad(`trang trả ${pg.status}`, pg.body.slice(0, 200));
  // BA CON SỐ phải cùng có mặt — thiếu một cái là người bán tưởng hệ thống đếm sai.
  const nhan = ['Tồn thực', 'Giữ an toàn', 'Còn bán được online', 'Đang giữ chỗ'];
  const thieu = nhan.filter((x) => !pg.body.includes(x));
  thieu.length === 0 ? ok('hiện đủ nhãn: ' + nhan.join(' · ')) : bad('thiếu nhãn: ' + thieu.join(', '), '');
  pg.body.includes('Số lần bị chặn') ? ok('hiện cột Số lần bị chặn') : bad('thiếu cột Số lần bị chặn', '');
  // Nói rõ ranh giới đơn tay — nếu không, người bán sẽ tưởng đệm khoá cả kênh bán tại quầy.
  /đơn tay/i.test(pg.body) ? ok('trang nói rõ đơn tay KHÔNG bị đệm chặn') : bad('trang không giải thích ranh giới đơn tay', '');
  // Con số trên trang phải khớp DB, không phải một phép tính thứ hai chép tay ở tầng hiển thị.
  const lvlB = await lvlOf(B.vid);
  pg.body.includes(`>${Number(lvlB.on_hand)}<`) ? ok('trang in ĐÚNG tồn thực từ DB') : bad('tồn thực trên trang không khớp DB', '');

  pg = await adm('POST', `/shops/${shopId}/safety-stock`, { cookie: ac, origin: OADM, form: { safety_stock_pct: '35' } });
  const pctSau = Number((await owner.query(`SELECT safety_stock_pct FROM shops WHERE id=$1`, [shopId])).rows[0].safety_stock_pct);
  // PRG: BFF trả 303 (See Other) sau POST. Nhận cả 302/303 — mã cụ thể không phải điều
  // bộ này canh, còn ép đúng một mã thì đổi kiểu redirect là đỏ oan.
  const chuyenHuong = (x) => x === 302 || x === 303;
  chuyenHuong(pg.status) && pctSau === 35 ? ok('lưu tỉ lệ 35% từ trang → DB đổi') : bad(`lưu hỏng (status ${pg.status}, pct ${pctSau})`, '');
  pg = await adm('POST', `/shops/${shopId}/safety-stock`, { cookie: ac, origin: OADM, form: { safety_stock_pct: '150' } });
  const pctVanVay = Number((await owner.query(`SELECT safety_stock_pct FROM shops WHERE id=$1`, [shopId])).rows[0].safety_stock_pct);
  pctVanVay === 35 ? ok('gõ 150 → từ chối, tỉ lệ giữ nguyên 35') : bad(`tỉ lệ bị đổi thành ${pctVanVay}`, '');
  pg = await adm('POST', `/shops/${shopId}/safety-stock/override`, { cookie: ac, origin: OADM, form: { variant_id: B.vid, safety_stock_qty: '4' } });
  let ovB = (await lvlOf(B.vid)).safety_stock_qty;
  chuyenHuong(pg.status) && Number(ovB) === 4 ? ok('lưu ghi đè 4 từ trang → DB đổi') : bad(`ghi đè hỏng (status ${pg.status}, qty ${ovB})`, '');
  // Ô TRỐNG = bỏ ngoại lệ. Nếu tầng BFF quy nó về 0 thì shop mất hẳn đường quay lại tỉ lệ chung.
  pg = await adm('POST', `/shops/${shopId}/safety-stock/override`, { cookie: ac, origin: OADM, form: { variant_id: B.vid, safety_stock_qty: '' } });
  ovB = (await lvlOf(B.vid)).safety_stock_qty;
  ovB === null ? ok('ô trống → bỏ ngoại lệ (NULL), không phải 0') : bad(`ô trống thành ${ovB}`, '');

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
