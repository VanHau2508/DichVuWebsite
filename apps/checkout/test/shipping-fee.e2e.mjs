/**
 * End-to-end PHÍ SHIP THEO CÂN + VÙNG MIỀN (0063). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/checkout/test/shipping-fee.e2e.mjs
 *
 * Kiểm các bất biến đường tiền của phí ship 2 bậc vùng (nội miền / liên miền) + phụ phí cân:
 *   - nội miền + phụ phí cân đúng công thức ceil((cân − 500)/500) × phụ phí
 *   - liên miền theo bản đồ Bắc/Trung/Nam tĩnh
 *   - KHÔNG gửi tỉnh lúc chốt đơn → tính LIÊN MIỀN (bảo vệ shop, chống né phí bằng curl)
 *   - biến thể không khai cân → dùng shops.default_weight_gram
 *   - đủ ngưỡng miễn phí ship → miễn TOÀN BỘ (kể cả phụ phí cân)
 *   - shop KHÔNG cấu hình → phí phẳng như cũ (tương thích ngược byte-for-byte)
 *   - 3 bản sao provinces.js (checkout / seller / seller-admin) không drift
 */

import http from 'node:http';
import fs from 'node:fs';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
// Import LƯỜI (chỉ khi chạy full suite trong dbtest) — để `--drift-only` chạy được trên
// host không có node_modules (pg) lẫn stack dịch vụ.
let totp, counterFor, base32Decode, owner;
async function loadDeps() {
  const pg = (await import('pg')).default;
  ({ totp, counterFor } = await import('../../../packages/auth/src/totp.js'));
  ({ base32Decode } = await import('../../../packages/auth/src/base32.js'));
  owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
}
// Token lời mời KHÔNG còn trong API response (email hoá, 0073) — lấy từ outbox qua owner SQL.
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic = 'user.invited' AND payload->>'to' = $1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${String(d).slice(0, 250)}${X}`); };
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
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;

// Gọi checkout với Host = domain shop; quản cookie __Host-cart + Idempotency-Key tay.
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
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
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
  return { shopId, slug, host: `${slug}.nentang.vn`, cookie: await login(email, password) };
}
// PATCH hồ sơ shop (full-profile — gửi lại đủ trường muốn giữ).
const patchShop = (shop, extra) =>
  rq(SELLER, 'PATCH', `/shops/${shop.shopId}`, { body: { name: shop.slug, ...extra }, cookie: shop.cookie, origin: OS });
// Sản phẩm active 2 biến thể (A khai cân qua PATCH, B để trống), nhập tồn. Trả {productId, vidA, vidB}.
async function setupProduct2(shop, price, stock) {
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/products`, {
    body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `A-${uniq()}`, price_vnd: price }, { sku: `B-${uniq()}`, price_vnd: price }] },
    cookie: shop.cookie, origin: OS,
  });
  const detail = await rq(SELLER, 'GET', `/shops/${shop.shopId}/products/${r.json.id}`, { cookie: shop.cookie });
  const [vidA, vidB] = detail.json.variants.map((v) => v.id);
  for (const vid of [vidA, vidB]) {
    await rq(SELLER, 'POST', `/shops/${shop.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: shop.cookie, origin: OS });
  }
  return { productId: r.json.id, vidA, vidB };
}
// Giỏ mới 1 biến thể qty → checkout JSON, trả response.
async function orderWith(shop, vid, qty, address, phone) {
  const cart = (await co(shop.host, 'POST', '/cart/items', { body: { variant_id: vid, qty } })).cartToken;
  return co(shop.host, 'POST', '/checkout', {
    body: { customer: { name: 'Khách Ship', phone }, address, payment_method: 'cod' },
    cartToken: cart, idemKey: `ship-${uniq()}-${uniq()}`,
  });
}

async function main() {
  await loadDeps();
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `shf-${uniq()}`);
  const P = await setupProduct2(A, 200000, 20);

  sect('0. Cấu hình shop + cân biến thể');
  let r = await patchShop(A, { ship_fee_vnd: 20000, ship_fee_far_vnd: 40000, ship_from_province: 'Hà Nội', ship_extra_per_500g_vnd: 5000, default_weight_gram: 500 });
  r.status === 200 ? ok('PATCH shop: nội 20k / liên 40k / từ Hà Nội / phụ phí 5k/500g / mặc định 500g') : bad('không cấu hình được shop', r.raw);
  r = await rq(SELLER, 'PATCH', `/shops/${A.shopId}/products/${P.productId}/variants/${P.vidA}`, { body: { weight_gram: 0 }, cookie: A.cookie, origin: OS });
  r.status === 400 ? ok('PATCH cân = 0 → 400 (validate 1–50000g)') : bad('nhận cân 0', r.raw);
  r = await rq(SELLER, 'PATCH', `/shops/${A.shopId}/products/${P.productId}/variants/${P.vidA}`, { body: { weight_gram: 2000 }, cookie: A.cookie, origin: OS });
  r.status === 200 ? ok('biến thể A khai cân 2000g') : bad('không đặt được cân biến thể', r.raw);
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${P.productId}`, { cookie: A.cookie });
  r.json?.variants?.find((v) => v.id === P.vidA)?.weight_gram === 2000 && r.json?.variants?.find((v) => v.id === P.vidB)?.weight_gram == null
    ? ok('GET product trả weight_gram (A=2000, B=NULL)') : bad('weight_gram không trả về đúng', r.raw);

  // ── 1. Nội miền + phụ phí cân ───────────────────────────────────────────────
  sect('1. Nội miền + phụ phí cân');
  r = await orderWith(A, P.vidA, 1, { line: '1 Tràng Tiền', province: 'Hà Nội' }, '0905111111');
  r.status === 201 && r.json.shipping_vnd === 35000
    ? ok('Hà Nội (nội miền), 2000g → 20000 + ceil(1500/500)×5000 = 35000') : bad('phí nội miền + cân sai', r.raw);

  // ── 2. Liên miền ────────────────────────────────────────────────────────────
  sect('2. Liên miền');
  r = await orderWith(A, P.vidA, 1, { line: '1 Lê Lợi', province: 'TP. Hồ Chí Minh' }, '0905222222');
  r.status === 201 && r.json.shipping_vnd === 55000
    ? ok('TP. Hồ Chí Minh (liên miền) → 40000 + 15000 = 55000') : bad('phí liên miền sai', r.raw);

  // ── 3. KHÔNG gửi tỉnh → tính LIÊN MIỀN (chống né phí bằng curl) ────────────
  sect('3. Không rõ tỉnh lúc chốt đơn = liên miền');
  r = await orderWith(A, P.vidA, 1, { line: 'không tỉnh' }, '0905333333');
  r.status === 201 && r.json.shipping_vnd === 55000
    ? ok('bỏ trống province qua API JSON → vẫn 55000 (không né được phí xa)') : bad('né được phí liên miền!', r.raw);

  // ── 4. Biến thể không khai cân → dùng default_weight_gram ───────────────────
  sect('4. Cân mặc định của shop');
  r = await patchShop(A, { ship_fee_vnd: 20000, ship_fee_far_vnd: 40000, ship_from_province: 'Hà Nội', ship_extra_per_500g_vnd: 5000, default_weight_gram: 1500 });
  r.status === 200 ? ok('đổi cân mặc định 500g → 1500g') : bad('không đổi được cân mặc định', r.raw);
  r = await orderWith(A, P.vidB, 1, { line: '1 Tràng Tiền', province: 'Hà Nội' }, '0905444444');
  r.status === 201 && r.json.shipping_vnd === 30000
    ? ok('biến thể B (NULL) → tính 1500g: 20000 + ceil(1000/500)×5000 = 30000') : bad('cân mặc định không được dùng', r.raw);

  // ── 5. Miễn phí ship miễn TOÀN BỘ (kể cả phụ phí cân + liên miền) ──────────
  sect('5. Ngưỡng miễn phí ship');
  r = await patchShop(A, { ship_fee_vnd: 20000, ship_fee_far_vnd: 40000, ship_from_province: 'Hà Nội', ship_extra_per_500g_vnd: 5000, default_weight_gram: 1500, free_ship_threshold_vnd: 100000 });
  r.status === 200 ? ok('đặt ngưỡng miễn phí ship 100k') : bad('không đặt được ngưỡng', r.raw);
  r = await orderWith(A, P.vidA, 1, { line: '1 Lê Lợi', province: 'TP. Hồ Chí Minh' }, '0905555555');
  r.status === 201 && r.json.shipping_vnd === 0 && r.json.total_vnd === 200000
    ? ok('subtotal 200k ≥ 100k → ship 0 (miễn cả phụ phí cân + liên miền)') : bad('ngưỡng miễn phí không miễn hết', r.raw);

  // ── 6. Shop KHÔNG cấu hình → phí phẳng như cũ ──────────────────────────────
  sect('6. Tương thích ngược (shop không cấu hình)');
  const Bs = await makeShopOwner(staff, `shg-${uniq()}`);
  const PB = await setupProduct2(Bs, 250000, 5);
  r = await orderWith(Bs, PB.vidA, 1, { line: 'HN' }, '0905666666');
  r.status === 201 && r.json.shipping_vnd === 30000 && r.json.total_vnd === 280000
    ? ok('shop mới (mọi cột NULL) → phí phẳng 30000 y hệt hôm nay') : bad('hành vi cũ bị đổi!', r.raw);

  // ── 7. Chống drift 3 bản sao provinces.js ──────────────────────────────────
  await driftChecks({ strict: false });

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

// So 3 bản sao provinces.js (checkout nguồn chuẩn / seller / seller-admin). Cần mount đủ
// apps/*/src (chạy từ repo trên host: `node apps/checkout/test/shipping-fee.e2e.mjs --drift-only`).
// Trong dbtest chỉ mount test/ → thiếu file thì BỎ QUA có cảnh báo (strict=false); --drift-only
// thì thiếu file = FAIL (chạy đúng chỗ mới có ý nghĩa).
async function driftChecks({ strict }) {
  sect('7. Chống drift bản sao provinces.js (checkout / seller / seller-admin)');
  const paths = ['../src/provinces.js', '../../seller/src/provinces.js', '../../seller-admin/src/provinces.js']
    .map((p) => new URL(p, import.meta.url));
  if (!paths.every((u) => fs.existsSync(u))) {
    if (strict) { bad('không tìm thấy đủ 3 file provinces.js — chạy từ repo gốc (host), không phải dbtest'); return; }
    console.log(`  ${D}BỎ QUA — môi trường này không mount apps/*/src (dbtest chỉ mount test/).${X}`);
    console.log(`  ${D}Chạy riêng trên host: node apps/checkout/test/shipping-fee.e2e.mjs --drift-only${X}`);
    return;
  }
  const [pvCo, pvSe, pvSa] = await Promise.all(paths.map((u) => import(u.href)));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  same(pvCo.PROVINCES, pvSe.PROVINCES) && same(pvCo.PROVINCES, pvSa.PROVINCES)
    ? ok('PROVINCES giống hệt ở cả 3 bản sao') : bad('PROVINCES bị drift giữa các service!');
  same(pvCo.REGION_OF, pvSe.REGION_OF) && same(pvCo.REGION_OF, pvSa.REGION_OF)
    ? ok('REGION_OF giống hệt ở cả 3 bản sao') : bad('REGION_OF bị drift giữa các service!');
  const covered = pvCo.PROVINCES.filter((p) => pvCo.REGION_OF[p]).length;
  covered === 34 && Object.keys(pvCo.REGION_OF).length === 34 && pvCo.PROVINCES.length === 34
    ? ok('34/34 tỉnh đều có vùng trong REGION_OF (không tỉnh nào "rơi" thành liên miền oan)') : bad(`bản đồ vùng thiếu tỉnh: ${covered}/34`);
}

if (process.argv.includes('--drift-only')) {
  // Chỉ kiểm drift (không cần stack dịch vụ) — dùng trên host / CI có đủ repo.
  driftChecks({ strict: true }).then(() => {
    console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
    process.exit(fail === 0 ? 0 : 1);
  });
} else {
  main().catch((err) => { console.error('shipping-fee e2e lỗi:', err); process.exit(2); });
}
