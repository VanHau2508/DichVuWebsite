/**
 * End-to-end Bước 7: CHỐNG BOT checkout no-JS + trần đơn ảo TUỲ CHỈNH per-shop.
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/checkout/test/botguard.e2e.mjs
 *
 * Đường FORM (nơi bot đánh): honeypot, time-trap (ký HMAC), câu hỏi toán khi 1 nguồn nhiều
 * đơn chờ. Trần per-shop: shop đặt max_pending_per_phone → chặn sớm hơn mặc định.
 */
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });

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

// node:http vì fetch cấm đặt Host. Trả {status, body, location, setCookie}.
function hreq(host, method, path, { form, json, cartToken, idemKey } = {}) {
  return new Promise((resolve, reject) => {
    const data = form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : null;
    const headers = { host, origin: `https://${host}` };
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    else if (json) headers['content-type'] = 'application/json';
    if (data) headers['content-length'] = Buffer.byteLength(data);
    if (cartToken) headers['cookie'] = `__Host-cart=${cartToken}`;
    if (idemKey) headers['idempotency-key'] = idemKey;
    const req = http.request({ hostname: CO.hostname, port: CO.port, path, method, headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => {
        let token = cartToken;
        for (const c of res.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) token = m[1]; }
        let j = null; try { j = b ? JSON.parse(b) : null; } catch {}
        resolve({ status: res.statusCode, body: b, json: j, location: res.headers.location, cartToken: token });
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
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: r.json.token, password }, origin: OA });
  return { shopId, slug, host: `${slug}.nentang.vn`, email, password, cookie: await login(email, password) };
}
async function setupProduct(shop, stock) {
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/products`, { body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: 90000, status: 'active', variants: [{ sku: `BG-${uniq()}`, price_vnd: 90000 }] }, cookie: shop.cookie, origin: OS });
  const vid = (await rq(SELLER, 'GET', `/shops/${shop.shopId}/products/${r.json.id}`, { cookie: shop.cookie })).json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${shop.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'seed' }, cookie: shop.cookie, origin: OS });
  return vid;
}
// Đặt đơn qua JSON API (nhanh, không dính bot-guard) — để tạo đơn chờ nền.
async function jsonOrder(host, vid) {
  const cart = (await hreq(host, 'POST', '/cart/items', { json: { variant_id: vid, qty: 1 } })).cartToken;
  return hreq(host, 'POST', '/checkout', { json: { customer: { name: 'K', phone: phone() }, payment_method: 'cod' }, cartToken: cart, idemKey: `k-${uniq()}` });
}
// Lấy trang /checkout (form) → trích ct + idempotency_key + (nếu có) câu hỏi toán.
async function getForm(host, vid) {
  const cart = (await hreq(host, 'POST', '/cart/items', { json: { variant_id: vid, qty: 1 } })).cartToken;
  const page = await hreq(host, 'GET', '/checkout', { cartToken: cart });
  const ct = /name="ct" value="([^"]*)"/.exec(page.body)?.[1];
  const idem = /name="idempotency_key" value="([^"]*)"/.exec(page.body)?.[1];
  const sig = /name="challenge_sig" value="([^"]*)"/.exec(page.body)?.[1];
  const qm = /<strong>(\d+) \+ (\d+) = \?/.exec(page.body);
  return { cart, ct, idem, sig, answer: qm ? Number(qm[1]) + Number(qm[2]) : null, body: page.body };
}
const baseForm = (fm, extra = {}) => ({ idempotency_key: fm.idem, ct: fm.ct, name: 'Khách Thật', phone: phone(), address_line: '12 Lê Lợi', province: 'TP. Hồ Chí Minh', payment_method: 'cod', ...extra });
// Trích ct/idem/challenge từ 1 body HTML (dùng cho form re-render sau POST).
function parseForm(body) {
  const ct = /name="ct" value="([^"]*)"/.exec(body)?.[1];
  const idem = /name="idempotency_key" value="([^"]*)"/.exec(body)?.[1];
  const sig = /name="challenge_sig" value="([^"]*)"/.exec(body)?.[1];
  const qm = /<strong>(\d+) \+ (\d+) = \?/.exec(body);
  return { ct, idem, sig, answer: qm ? Number(qm[1]) + Number(qm[2]) : null };
}

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `bot-${uniq()}`);
  const vid = await setupProduct(A, 200);
  ok('dựng shop + sản phẩm');

  sect('1. Honeypot');
  let fm = await getForm(A.host, vid);
  await sleep(2600); // qua time-trap
  let r = await hreq(A.host, 'POST', '/checkout/place', { form: baseForm(fm, { company: 'BotCorp' }), cartToken: fm.cart });
  r.status === 400 ? ok('bot điền trường ẩn (honeypot) → 400, không tạo đơn') : bad('honeypot lọt', `${r.status}`);

  sect('2. Time-trap (ký HMAC)');
  fm = await getForm(A.host, vid);
  r = await hreq(A.host, 'POST', '/checkout/place', { form: baseForm(fm), cartToken: fm.cart }); // POST NGAY (quá nhanh)
  r.status === 200 && /hơi nhanh/.test(r.body) ? ok('điền quá nhanh (<2.5s) → dựng lại form (chặn bot)') : bad('không chặn submit nhanh', `${r.status}`);
  r = await hreq(A.host, 'POST', '/checkout/place', { form: baseForm(fm, { ct: '9999999999.giả-mạo' }), cartToken: fm.cart });
  r.status === 200 && /hết hạn/.test(r.body) ? ok('token thời gian GIẢ → dựng lại form (hết hạn)') : bad('token giả lọt', `${r.status}`);

  sect('3. Đặt hàng hợp lệ (người thật)');
  fm = await getForm(A.host, vid);
  await sleep(2600);
  r = await hreq(A.host, 'POST', '/checkout/place', { form: baseForm(fm), cartToken: fm.cart });
  r.status === 303 && /\/checkout\/success/.test(r.location ?? '') ? ok('điền hợp lệ + đủ thời gian → 303 đặt hàng thành công') : bad('người thật bị chặn', `${r.status} ${r.location} ${r.body.slice(0, 120)}`);

  sect('4. Câu hỏi toán khi nguồn nhiều đơn chờ (leo thang)');
  // Tạo 4 đơn chờ từ CÙNG IP (dbtest) → lần POST tiếp theo bị hỏi toán (CHALLENGE_AFTER_PENDING=4).
  for (let i = 0; i < 4; i++) await jsonOrder(A.host, vid);
  fm = await getForm(A.host, vid);
  await sleep(2600);
  // POST hợp lệ NHƯNG chưa giải toán → re-render KÈM câu hỏi (challenge chỉ hiện sau POST).
  r = await hreq(A.host, 'POST', '/checkout/place', { form: baseForm(fm), cartToken: fm.cart });
  let cf = parseForm(r.body);
  r.status === 200 && cf.sig && cf.answer != null ? ok('nguồn ≥4 đơn chờ → POST bị chặn, HIỆN câu hỏi toán (a + b = ?)') : bad('không leo thang hỏi toán', `${r.status}`);
  // Trả lời SAI → vẫn chặn (re-render câu hỏi mới).
  await sleep(2600);
  r = await hreq(A.host, 'POST', '/checkout/place', { form: baseForm({ ct: cf.ct, idem: cf.idem }, { challenge_sig: cf.sig, challenge_answer: '0' }), cartToken: fm.cart });
  r.status === 200 && /câu hỏi xác minh/.test(r.body) ? ok('trả lời SAI → chặn, hỏi lại (bot không đoán được)') : bad('đáp án sai vẫn lọt', `${r.status}`);
  // Trả lời ĐÚNG (câu hỏi mới nhất) → đặt hàng thành công.
  cf = parseForm(r.body);
  const solved = { sig: cf.sig, answer: cf.answer }; // giữ để thử REPLAY
  await sleep(2600);
  r = await hreq(A.host, 'POST', '/checkout/place', { form: baseForm({ ct: cf.ct, idem: cf.idem }, { challenge_sig: cf.sig, challenge_answer: String(cf.answer) }), cartToken: fm.cart });
  r.status === 303 ? ok('trả lời ĐÚNG → đặt hàng thành công (người thật vẫn qua)') : bad('đáp án đúng vẫn bị chặn', `${r.status} ${r.body.slice(0, 120)}`);
  // REPLAY (vá #2): dùng LẠI cặp (sig,answer) đã giải cho đơn/idem KHÁC → phải bị chặn
  // (challenge ràng buộc idempotency_key nên MAC lệch với idem mới).
  const fm2 = await getForm(A.host, vid);
  await sleep(2600);
  r = await hreq(A.host, 'POST', '/checkout/place', { form: baseForm(fm2, { challenge_sig: solved.sig, challenge_answer: String(solved.answer) }), cartToken: fm2.cart });
  r.status === 200 && /câu hỏi xác minh/.test(r.body) ? ok('REPLAY challenge cũ cho đơn mới → BỊ CHẶN (ràng buộc idem)') : bad('replay challenge lọt', `${r.status}`);

  sect('5. Trần đơn ảo TUỲ CHỈNH per-shop');
  const Bs = await makeShopOwner(staff, `botb-${uniq()}`);
  const vidB = await setupProduct(Bs, 50);
  r = await rq(SELLER, 'PATCH', `/shops/${Bs.shopId}`, { body: { name: 'Shop B', max_pending_per_phone: 2 }, cookie: Bs.cookie, origin: OS });
  r.status === 200 ? ok('shop đặt trần 2 đơn/SĐT') : bad('đặt trần lỗi', r.raw);
  const ph = phone();
  const place = async () => {
    const cart = (await hreq(Bs.host, 'POST', '/cart/items', { json: { variant_id: vidB, qty: 1 } })).cartToken;
    return hreq(Bs.host, 'POST', '/checkout', { json: { customer: { name: 'K', phone: ph }, payment_method: 'cod' }, cartToken: cart, idemKey: `k-${uniq()}` });
  };
  const s1 = await place(), s2 = await place(), s3 = await place();
  s1.status === 201 && s2.status === 201 && s3.status === 429
    ? ok('trần shop=2 → đơn 1,2 OK, đơn 3 bị chặn 429 (chặt hơn mặc định 8)') : bad('trần per-shop không áp', `${s1.status} ${s2.status} ${s3.status}`);
  r = await rq(SELLER, 'PATCH', `/shops/${Bs.shopId}`, { body: { name: 'Shop B', max_pending_per_phone: 999 }, cookie: Bs.cookie, origin: OS });
  r.status === 400 ? ok('đặt trần vượt mức cho phép (>50) → 400') : bad('không chặn trần vô lý', r.raw);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
