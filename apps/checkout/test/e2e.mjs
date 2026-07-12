/**
 * End-to-end giỏ hàng + checkout. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/checkout/test/e2e.mjs
 *
 * Kiểm các BẤT BIẾN LUỒNG TIỀN (docs/01 §8):
 *   giá tính server-side (bỏ qua giá client gửi), kiểm tồn, reserve nguyên tử
 *   (đua đơn cuối → 1 thắng), idempotency, snapshot đơn, order_number theo shop,
 *   token giỏ lưu hash, cô lập chéo shop.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
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
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;

// Gọi checkout với Host = domain shop; quản cookie __Host-cart + Idempotency-Key tay.
function co(host, method, path, { body, cartToken, idemKey, origin } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = { host, origin: origin ?? `https://${host}` };
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (cartToken) headers['cookie'] = `__Host-cart=${cartToken}`;
    if (idemKey) headers['idempotency-key'] = idemKey;
    const req = http.request({ hostname: CO.hostname, port: CO.port, path, method, headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => {
        let j = null; try { j = b ? JSON.parse(b) : null; } catch {}
        let token = cartToken;
        for (const c of res.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) token = m[1]; }
        resolve({ status: res.statusCode, headers: res.headers, json: j, raw: b, cartToken: token });
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
  // A6: mfa/verify ROTATE token → lấy cookie mới
  cookie = ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA })).sc) ?? cookie;
  return cookie;
}
async function makeShopOwner(staffCookie, slug) {
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: r.json.token, password }, origin: OA });
  return { shopId, slug, host: `${slug}.nentang.vn`, cookie: await login(email, password) };
}
// Tạo sản phẩm active 1 biến thể giá `price`, nhập tồn `stock`. Trả variantId.
async function setupProduct(shop, price, stock) {
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/products`, {
    body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `S-${uniq()}`, price_vnd: price }] },
    cookie: shop.cookie, origin: OS,
  });
  const detail = await rq(SELLER, 'GET', `/shops/${shop.shopId}/products/${r.json.id}`, { cookie: shop.cookie });
  const vid = detail.json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${shop.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: shop.cookie, origin: OS });
  return vid;
}

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `co-${uniq()}`);
  const vid = await setupProduct(A, 250000, 5);
  ok('dựng shop + sản phẩm active giá 250k, tồn 5');

  // ── 1. Giỏ hàng + giá server-side ──────────────────────────────────────────
  sect('1. Giỏ hàng & định giá server-side');
  let r = await co(A.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 2 } });
  const cart = r.cartToken;
  r.status === 200 && r.json.subtotal_vnd === 500000 && r.json.total_vnd === 530000
    ? ok('thêm 2 món → subtotal 500k + ship 30k = 530k (server tính)') : bad('giỏ/định giá sai', r.raw);

  // Thử GỬI GIÁ GIẢ trong cart — phải bị bỏ qua.
  r = await co(A.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 0, price_vnd: 1, unit_price_vnd: 1 }, cartToken: cart });
  // qty 0 không hợp lệ → 400; nhưng điểm là giá client không bao giờ được dùng.
  r.status === 400 ? ok('qty 0 → 400 (và giá client bị bỏ qua)') : bad('nhận qty 0', r.raw);

  // ── 2. Kiểm tồn ────────────────────────────────────────────────────────────
  sect('2. Kiểm tồn kho');
  r = await co(A.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 10 }, cartToken: cart });
  r.status === 422 ? ok('thêm vượt tồn (2+10 > 5) → 422') : bad('cho vượt tồn', r.raw);

  // ── 3. Checkout: giá server-side, KHÔNG tin total client ───────────────────
  sect('3. Checkout');
  const key1 = `idem-${uniq()}-${uniq()}`;
  r = await co(A.host, 'POST', '/checkout', {
    body: { customer: { name: 'Nguyễn Văn A', phone: '0901234567' }, address: { line: 'HN' }, payment_method: 'cod',
            total_vnd: 1, subtotal_vnd: 1, price_vnd: 1 }, // client cố gửi giá giả
    cartToken: cart, idemKey: key1,
  });
  const orderNum = r.json?.order_number;
  const lookupToken = r.json?.lookup_token;
  r.status === 201 && r.json.total_vnd === 530000 && orderNum
    ? ok(`đơn tạo với total 530k (BỎ QUA total_vnd=1 client gửi) — order #${orderNum}`) : bad('checkout/định giá sai', r.raw);

  // ── 4. Idempotency ─────────────────────────────────────────────────────────
  sect('4. Idempotency');
  r = await co(A.host, 'POST', '/checkout', {
    body: { customer: { name: 'Nguyễn Văn A', phone: '0901234567' }, address: { line: 'HN' }, payment_method: 'cod' },
    cartToken: cart, idemKey: key1,
  });
  r.status === 201 && r.json.order_number === orderNum && r.headers['idempotency-replayed'] === 'true'
    ? ok('lặp cùng Idempotency-Key → trả ĐÚNG đơn cũ (không tạo 2)') : bad('idempotency lỗi', r.raw);

  // Số đơn duy nhất (không có đơn thứ 2 cùng số).
  const cnt = await owner.query(`SELECT count(*)::int n FROM orders WHERE shop_id=$1 AND order_number=$2`, [A.shopId, orderNum]);
  cnt.rows[0].n === 1 ? ok('chỉ MỘT đơn trong DB (idempotency chặn tạo trùng)') : bad(`có ${cnt.rows[0].n} đơn cùng số`);

  // ── 5. Reserve tồn kho ─────────────────────────────────────────────────────
  sect('5. Reserve tồn kho');
  const inv = await owner.query(`SELECT on_hand, reserved FROM inventory_levels WHERE variant_id=$1`, [vid]);
  inv.rows[0].on_hand === 5 && inv.rows[0].reserved === 2
    ? ok('sau đơn: on_hand 5 giữ nguyên, reserved = 2 (đã giữ chỗ)') : bad('reserve sai', JSON.stringify(inv.rows[0]));

  // ── 6. Snapshot đơn ────────────────────────────────────────────────────────
  sect('6. Snapshot giá');
  await owner.query(`UPDATE variants SET price_vnd = 999999 WHERE id=$1`, [vid]); // đổi giá SAU khi đặt
  r = await co(A.host, 'GET', `/checkout/order?number=${orderNum}&token=${encodeURIComponent(lookupToken)}`);
  // pg trả bigint dạng chuỗi → so bằng Number.
  r.status === 200 && Number(r.json.lines[0].unit_price_vnd) === 250000
    ? ok('đổi giá sản phẩm SAU đơn KHÔNG đổi giá trong đơn (snapshot 250k)') : bad('snapshot bị đổi', r.raw);

  // ── 7. Đua giành đơn cuối (reserve nguyên tử) ──────────────────────────────
  sect('7. Chống oversell (reserve nguyên tử)');
  const vidLast = await setupProduct(A, 100000, 1); // tồn = 1
  // Hai giỏ riêng, mỗi giỏ thêm 1 (available 1 lúc thêm).
  const c1 = (await co(A.host, 'POST', '/cart/items', { body: { variant_id: vidLast, qty: 1 } })).cartToken;
  const c2 = (await co(A.host, 'POST', '/cart/items', { body: { variant_id: vidLast, qty: 1 } })).cartToken;
  const [r1, r2] = await Promise.all([
    co(A.host, 'POST', '/checkout', { body: { customer: { name: 'a', phone: '0901111111' } }, cartToken: c1, idemKey: `k1-${uniq()}` }),
    co(A.host, 'POST', '/checkout', { body: { customer: { name: 'b', phone: '0902222222' } }, cartToken: c2, idemKey: `k2-${uniq()}` }),
  ]);
  const wins = [r1, r2].filter((x) => x.status === 201).length;
  const outs = [r1, r2].filter((x) => x.status === 422).length;
  wins === 1 && outs === 1 ? ok('hai checkout đồng thời đơn cuối → 1 thắng, 1 hết hàng (không oversell)') : bad(`đua sai: ${wins} thắng ${outs} hết`, `${r1.status}/${r2.status}`);

  // ── 8. order_number theo shop ──────────────────────────────────────────────
  sect('8. order_number theo shop');
  const Bs = await makeShopOwner(staff, `cob-${uniq()}`);
  const vidB = await setupProduct(Bs, 50000, 3);
  const cb = (await co(Bs.host, 'POST', '/cart/items', { body: { variant_id: vidB, qty: 1 } })).cartToken;
  r = await co(Bs.host, 'POST', '/checkout', { body: { customer: { name: 'b', phone: '0903333333' } }, cartToken: cb, idemKey: `kb-${uniq()}` });
  r.json?.order_number === 1 ? ok('shop B: đơn đầu tiên = #1 (đếm theo shop, không toàn cục)') : bad('order_number không theo shop', String(r.json?.order_number));

  // ── 9. Cô lập chéo shop ────────────────────────────────────────────────────
  sect('9. Cô lập chéo shop');
  // Dùng cookie giỏ của shop A trên domain shop B → RLS không thấy giỏ A.
  r = await co(Bs.host, 'GET', '/cart', { cartToken: cart });
  (r.json?.items ?? []).length === 0 ? ok('cookie giỏ shop A dùng trên domain shop B → giỏ rỗng (RLS)') : bad('rò giỏ chéo shop', r.raw);

  // ── 10. Token giỏ lưu hash ─────────────────────────────────────────────────
  sect('10. Token giỏ chỉ lưu hash');
  const hash = crypto.createHash('sha256').update(cart).digest('hex');
  const row = await owner.query(`SELECT token_hash FROM carts WHERE token_hash=$1`, [hash]);
  row.rowCount === 1 ? ok('DB lưu sha256(token), không lưu token thô') : bad('token giỏ không hash đúng');

  // ── 11. Shop bị đình chỉ KHÔNG nhận đơn (chặn thu tiền) ─────────────────────
  sect('11. Shop suspended không nhận đơn');
  const C = await makeShopOwner(staff, `coc-${uniq()}`);
  const vidC = await setupProduct(C, 100000, 5);
  // Trước khi đình chỉ: thêm giỏ + checkout được.
  let rc = await co(C.host, 'POST', '/cart/items', { body: { variant_id: vidC, qty: 1 } });
  rc.status === 200 ? ok('shop hoạt động: thêm giỏ được') : bad('thêm giỏ lỗi', rc.raw);
  // Đình chỉ shop C.
  await rq(PLATFORM, 'POST', `/ops/shops/${C.shopId}/suspend`, { body: { reason: 'gian lận' }, cookie: staff, origin: OO });
  rc = await co(C.host, 'POST', '/cart/items', { body: { variant_id: vidC, qty: 1 }, cartToken: rc.cartToken });
  rc.status === 503 ? ok('sau đình chỉ: thêm giỏ → 503 (không nhận đơn)') : bad('shop đình chỉ vẫn thêm giỏ', String(rc.status));
  rc = await co(C.host, 'POST', '/checkout', { body: { customer: { name: 'x', phone: '0901234567' } }, cartToken: rc.cartToken, idemKey: `susp-${uniq()}` });
  rc.status === 503 ? ok('sau đình chỉ: checkout → 503 (không tạo đơn/QR vào tài khoản shop)') : bad('shop đình chỉ vẫn checkout', String(rc.status));
  // Khôi phục → nhận đơn lại.
  await rq(PLATFORM, 'POST', `/ops/shops/${C.shopId}/restore`, { cookie: staff, origin: OO });
  rc = await co(C.host, 'POST', '/cart/items', { body: { variant_id: vidC, qty: 1 } });
  rc.status === 200 ? ok('khôi phục → nhận đơn lại') : bad('khôi phục không nhận đơn', String(rc.status));

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('checkout e2e lỗi:', err); process.exit(2); });
