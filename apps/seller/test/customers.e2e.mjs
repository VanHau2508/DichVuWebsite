/**
 * End-to-end CRM-lite (khách hàng). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/customers.e2e.mjs
 *
 * Kiểm: gộp theo SĐT chuẩn hoá (2 đơn 1 khách = 1 dòng), không tính đơn huỷ, tìm không
 * dấu, lọc mua ≥N, chi tiết + lịch sử, ghi chú upsert/xoá, cô lập chéo shop.
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
// Token lời mời KHÔNG còn trong API response (email hoá, 0073) — lấy từ outbox qua owner SQL (ADR-006: cùng tx với INSERT invitations nên đọc được ngay).
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic = 'user.invited' AND payload->>'to' = $1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

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

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `crm-${uniq()}`);
  let r = await rq(SELLER, 'POST', `/shops/${A.shopId}/products`, { body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: 100000, status: 'active', variants: [{ sku: `C-${uniq()}`, price_vnd: 100000 }] }, cookie: A.cookie, origin: OS });
  const vid = (await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${r.json.id}`, { cookie: A.cookie })).json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${A.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: 30, reason: 'seed' }, cookie: A.cookie, origin: OS });

  const buy = async (name, phone, qty = 1) => {
    const cart = (await co(A.host, 'POST', '/cart/items', { body: { variant_id: vid, qty } })).cartToken;
    const oc = await co(A.host, 'POST', '/checkout', { body: { customer: { name, phone }, payment_method: 'cod' }, cartToken: cart, idemKey: `k-${uniq()}` });
    if (oc.status !== 201) throw new Error(oc.raw);
    return oc.json.order_number;
  };
  // Khách "Nguyễn Văn Tèo": 2 đơn với 2 ĐỊNH DẠNG SĐT khác nhau (phải gộp 1 dòng nhờ canonPhone).
  const P = '0911222333';
  await buy('Nguyễn Văn Tèo', '0911222333');
  await buy('Nguyễn Văn Tèo', '+84 911 222 333', 2);
  // Khách khác 1 đơn + 1 đơn bị HUỶ (không được tính).
  const n2 = await buy('Trần Thị Hai', '0988777666');
  const cancelNum = await buy('Trần Thị Hai', '0988777666');
  const cid = (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2`, [A.shopId, cancelNum])).rows[0].id;
  await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${cid}/cancel`, { cookie: A.cookie, origin: OS });
  ok('dựng shop + 4 đơn (2 khách, 1 đơn huỷ)');

  sect('1. Danh sách khách gộp theo SĐT');
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/customers`, { cookie: A.cookie });
  r.json?.total === 2 ? ok('2 khách (đơn huỷ không sinh khách ma)') : bad(`total sai: ${r.json?.total}`, r.raw);
  const teo = r.json.customers.find((c) => c.phone === P);
  teo && teo.n_orders === 2 && Number(teo.total_spent_vnd) === (100000 + 30000) + (200000 + 30000)
    ? ok('2 định dạng SĐT gộp 1 khách, 2 đơn, tổng chi đúng (360k)') : bad('gộp SĐT sai', JSON.stringify(teo));
  const hai = r.json.customers.find((c) => c.phone === '0988777666');
  hai?.n_orders === 1 ? ok('đơn HUỶ không tính vào số đơn') : bad('đơn huỷ bị tính', JSON.stringify(hai));

  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/customers?q=${encodeURIComponent('nguyen van')}`, { cookie: A.cookie });
  r.json?.customers?.length === 1 && r.json.customers[0].phone === P ? ok('tìm "nguyen van" (không dấu) ra đúng khách') : bad('tìm không dấu fail', r.raw);
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/customers?min_orders=2`, { cookie: A.cookie });
  r.json?.total === 1 ? ok('lọc mua ≥2 đơn → 1 khách') : bad('lọc min_orders sai', r.raw);

  sect('2. Chi tiết + ghi chú');
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/customers/${P}`, { cookie: A.cookie });
  r.status === 200 && r.json.orders.length === 2 && r.json.n_orders === 2 ? ok('chi tiết: lịch sử 2 đơn') : bad('chi tiết sai', r.raw);
  r = await rq(SELLER, 'PUT', `/shops/${A.shopId}/customers/${P}/note`, { body: { note: 'Khách quen, giao giờ hành chính' }, cookie: A.cookie, origin: OS });
  r.status === 200 ? ok('lưu ghi chú → 200') : bad('note lỗi', r.raw);
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/customers/${P}`, { cookie: A.cookie });
  r.json.note === 'Khách quen, giao giờ hành chính' ? ok('đọc lại ghi chú đúng') : bad('note sai', r.json.note);
  await rq(SELLER, 'PUT', `/shops/${A.shopId}/customers/${P}/note`, { body: { note: '' }, cookie: A.cookie, origin: OS });
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/customers/${P}`, { cookie: A.cookie });
  r.json.note === '' ? ok('note rỗng → xoá') : bad('xoá note fail', r.json.note);

  sect('3. Cô lập chéo shop');
  const Bs = await makeShopOwner(staff, `crmb-${uniq()}`);
  r = await rq(SELLER, 'GET', `/shops/${Bs.shopId}/customers`, { cookie: Bs.cookie });
  r.json?.total === 0 ? ok('shop B không thấy khách shop A') : bad('rò khách chéo shop', r.raw);
  r = await rq(SELLER, 'GET', `/shops/${Bs.shopId}/customers/${P}`, { cookie: Bs.cookie });
  r.status === 404 ? ok('shop B xem chi tiết khách shop A → 404') : bad('rò chi tiết', r.raw);

  // ── 4. Ẩn danh khách (Luật BVDLCN 91/2025) — owner + step-up, chặn in-flight ──
  sect('4. Ẩn danh khách theo yêu cầu');
  const P2 = '0988777666'; // Trần Thị Hai: 1 đơn pending (n2) + 1 đơn đã huỷ
  await rq(SELLER, 'PUT', `/shops/${A.shopId}/customers/${P2}/note`, { body: { note: 'khách test erase' }, cookie: A.cookie, origin: OS });
  // Chưa step-up → seller chặn (route stepUp: true).
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/customers/${P2}/erase`, { cookie: A.cookie, origin: OS });
  r.status === 403 && r.json?.step_up_required ? ok('chưa step-up → 403 step_up_required') : bad('không đòi step-up', r.raw);
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: A.password }, cookie: A.cookie, origin: OA });
  // Còn đơn pending → 409 (cần địa chỉ để giao nốt).
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/customers/${P2}/erase`, { cookie: A.cookie, origin: OS });
  r.status === 409 && /đang xử lý/.test(r.json?.error ?? '') ? ok('còn đơn in-flight → 409') : bad('không chặn in-flight', r.raw);
  // Huỷ đơn pending rồi ẩn danh.
  const oid2 = (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2`, [A.shopId, n2])).rows[0].id;
  await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${oid2}/cancel`, { cookie: A.cookie, origin: OS });
  // Tài khoản khách (0083) khớp SĐT P2 + địa chỉ + phiên → erase phải ẩn danh cả account.
  const rnd = Math.random().toString(36).slice(2, 8);
  const acctId = (await owner.query(`INSERT INTO customers (shop_id,email,password_hash,full_name,phone) VALUES ($1,$2,'H','Tên P2',$3) RETURNING id`, [A.shopId, `p2-${rnd}@x.vn`, P2])).rows[0].id;
  await owner.query(`INSERT INTO customer_addresses (shop_id,customer_id,recipient_name,phone,line1) VALUES ($1,$2,'P2','09','L')`, [A.shopId, acctId]);
  await owner.query(`INSERT INTO customer_sessions (shop_id,customer_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')`, [A.shopId, acctId, `hash-${rnd}`]);
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/customers/${P2}/erase`, { cookie: A.cookie, origin: OS });
  r.status === 200 && r.json.orders_anonymized === 2 ? ok('erase 200 — ẩn danh 2 đơn') : bad('erase lỗi', r.raw);
  const acct = (await owner.query(`SELECT status, email, phone FROM customers WHERE id=$1`, [acctId])).rows[0];
  const acctAddr = Number((await owner.query(`SELECT count(*)::int n FROM customer_addresses WHERE customer_id=$1`, [acctId])).rows[0].n);
  const acctSess = Number((await owner.query(`SELECT count(*)::int n FROM customer_sessions WHERE customer_id=$1 AND revoked_at IS NULL`, [acctId])).rows[0].n);
  acct.status === 'anonymized' && acct.email === null && acct.phone === null && acctAddr === 0 && acctSess === 0 && r.json.accounts_anonymized === 1
    ? ok('tài khoản khách khớp SĐT: status=anonymized + email/phone NULL + địa chỉ xoá + phiên revoke') : bad('account chưa ẩn danh', `${JSON.stringify(acct)} addr=${acctAddr} sess=${acctSess} acc=${r.json.accounts_anonymized}`);
  const anon = (await owner.query(
    `SELECT customer_name, customer_phone, customer_email, shipping_address, client_ip_hash, anonymized_at, total_vnd, status
       FROM orders WHERE shop_id=$1 AND order_number=$2`, [A.shopId, n2])).rows[0];
  anon.customer_name === '(đã ẩn danh)' && anon.customer_phone === null && anon.customer_email === null
    && anon.shipping_address === null && anon.client_ip_hash === null && anon.anonymized_at
    ? ok('đơn: tên sentinel + phone/email/địa-chỉ/ip NULL + anonymized_at') : bad('cột ẩn danh sai', JSON.stringify(anon));
  Number(anon.total_vnd) === 130000 && anon.status === 'cancelled' // 100k hàng + 30k ship
    ? ok('tiền + trạng thái đơn GIỮ NGUYÊN') : bad('mất dữ liệu doanh thu', JSON.stringify(anon));
  const noteRow = await owner.query(`SELECT 1 FROM customer_notes WHERE shop_id=$1 AND phone=$2`, [A.shopId, P2]);
  noteRow.rows.length === 0 ? ok('ghi chú CRM đã xoá') : bad('note còn sót');
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/customers/${P2}`, { cookie: A.cookie });
  r.status === 404 ? ok('chi tiết khách sau erase → 404') : bad('khách vẫn còn', r.raw);
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/customers/${P}`, { cookie: A.cookie });
  r.status === 200 ? ok('khách KHÁC (Tèo) không bị ảnh hưởng') : bad('erase lan sang khách khác', r.raw);
  const aud = (await owner.query(
    `SELECT metadata FROM audit_logs WHERE shop_id=$1 AND action='customer.erased' ORDER BY id DESC LIMIT 1`, [A.shopId])).rows[0];
  aud && aud.metadata.phone_masked === '•••666' && !JSON.stringify(aud.metadata).includes(P2)
    ? ok('audit chỉ ghi SĐT che (•••666), không SĐT thô') : bad('audit rò SĐT', JSON.stringify(aud?.metadata));

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
