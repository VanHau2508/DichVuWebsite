/**
 * End-to-end Bước 6: XÁC NHẬN HÀNG LOẠT + IN HÀNG LOẠT + CẢNH BÁO SẮP HẾT HÀNG.
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/ops-batch.e2e.mjs
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
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
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

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `ops-${uniq()}`);
  let r = await rq(SELLER, 'POST', `/shops/${A.shopId}/products`, { body: { title: `Ghế Băng Dài ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: 150000, status: 'active', variants: [{ sku: `OP-${uniq()}`, price_vnd: 150000 }] }, cookie: A.cookie, origin: OS });
  const pid = r.json.id;
  const vid = (await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${pid}`, { cookie: A.cookie })).json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${A.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: 10, reason: 'seed' }, cookie: A.cookie, origin: OS });
  // Bộ này kiểm batch/low-stock, không kiểm readiness. Kích hoạt fixture như các E2E checkout khác.
  await owner.query(`UPDATE shops SET status='active', went_live_at=now() WHERE id=$1`, [A.shopId]);

  const buy = async () => {
    const cart = (await co(A.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 1 } })).cartToken;
    const oc = await co(A.host, 'POST', '/checkout', { body: { customer: { name: 'Khách Lô', phone: phone() }, payment_method: 'cod' }, cartToken: cart, idemKey: `k-${uniq()}` });
    return (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2`, [A.shopId, oc.json.order_number])).rows[0].id;
  };
  const o1 = await buy(), o2 = await buy(), o3 = await buy();
  // o3 huỷ trước → bulk phải BỎ QUA nó (partial success).
  await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${o3}/cancel`, { cookie: A.cookie, origin: OS });
  ok('dựng shop + 3 đơn (1 đã huỷ)');

  sect('1. Xác nhận hàng loạt');
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/bulk/confirm`, { body: { order_ids: [o1, o2, o3] }, cookie: A.cookie, origin: OS });
  r.status === 200 && r.json.confirmed === 2 && r.json.skipped === 1
    ? ok('bulk 3 đơn → 2 xác nhận + 1 bỏ qua (đơn huỷ)') : bad('bulk sai', r.raw);
  const sts = (await owner.query(`SELECT status, count(*)::int n FROM orders WHERE id = ANY($1::uuid[]) GROUP BY status ORDER BY status`, [[o1, o2, o3]])).rows;
  JSON.stringify(sts) === JSON.stringify([{ status: 'cancelled', n: 1 }, { status: 'confirmed', n: 2 }])
    ? ok('DB: 2 confirmed + 1 cancelled (không đụng đơn huỷ)') : bad('DB sai', JSON.stringify(sts));
  // outbox email confirmed cho đơn có email? (đơn không email → không outbox; chỉ kiểm không lỗi)
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/bulk/confirm`, { body: { order_ids: [o1, o2] }, cookie: A.cookie, origin: OS });
  r.json.confirmed === 0 && r.json.skipped === 2 ? ok('bulk lặp lại → idempotent (0 confirmed)') : bad('không idempotent', r.raw);
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/bulk/confirm`, { body: { order_ids: [] }, cookie: A.cookie, origin: OS });
  r.status === 400 ? ok('danh sách rỗng → 400') : bad('không chặn rỗng', r.raw);

  sect('2. Cảnh báo sắp hết hàng');
  // Đặt ngưỡng 8 + email liên hệ; tồn hiện tại = 10 - 3 reserve +1 (huỷ trả lại) = available 8 → chạm ngưỡng.
  r = await rq(SELLER, 'PATCH', `/shops/${A.shopId}`, { body: { name: 'Shop Ops', contact_email: `shop-${uniq()}@mail.vn`, low_stock_threshold: 8 }, cookie: A.cookie, origin: OS });
  r.status === 200 ? ok('đặt ngưỡng sắp hết = 8 + email liên hệ') : bad('settings lỗi', r.raw);
  const st = await rq(SELLER, 'GET', `/shops/${A.shopId}/stats`, { cookie: A.cookie });
  (st.json.low_stock ?? []).length >= 1 ? ok(`tổng quan hiện ${st.json.low_stock.length} biến thể sắp hết`) : bad('thiếu low_stock trong stats', JSON.stringify(st.json.low_stock));
  const todoCodes = new Set((st.json.todo_items ?? []).map((x) => x.code));
  const coreTodo = (st.json.todo_items ?? []).filter((x) => ['to_confirm', 'to_ship', 'unpaid', 'partial_payments'].includes(x.code));
  st.status === 200 && /^\d{4}-\d\d-\d\dT/.test(st.json.generated_at ?? '') && Array.isArray(st.json.partial?.failed)
    ? ok('stats mở rộng có generated_at + partial.failed') : bad('stats thiếu contract snapshot', JSON.stringify(st.json));
  st.json.sync?.mode === 'local' && st.json.sync?.status === 'not_connected' && st.json.sync?.lag_seconds === null
    ? ok('shop local hiển thị nguồn nội bộ và độ trễ chưa từng đồng bộ là —') : bad('sync local sai', JSON.stringify(st.json.sync));
  coreTodo.length === 4 && coreTodo.every((x) => x.available === true && x.count === st.json.todo?.[x.code])
    && todoCodes.has('owed') && todoCodes.has('low_stock')
    ? ok('todo_items giữ đủ mã + khớp các số lõi trong todo cũ') : bad('todo_items lệch todo legacy', JSON.stringify(st.json.todo_items));

  // Ca phân biệt ATS với tồn vật lý: 10 on_hand, không reserve nhưng giữ an toàn 4 → ATS 6.
  // Ngưỡng 8 phải bắt được ở cả Tổng quan và danh sách sản phẩm dù on_hand-reserved vẫn là 10.
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/products`, { body: { title: `ATS Low ${uniq()}`, slug: `ats-${uniq()}`, price_vnd: 99000, status: 'active', variants: [{ sku: `ATS-${uniq()}`, price_vnd: 99000 }] }, cookie: A.cookie, origin: OS });
  const atsPid = r.json.id;
  const atsVid = (await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${atsPid}`, { cookie: A.cookie })).json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${A.shopId}/variants/${atsVid}/inventory/adjust`, { body: { delta: 10, reason: 'seed ATS' }, cookie: A.cookie, origin: OS });
  await rq(SELLER, 'PUT', `/shops/${A.shopId}/variants/${atsVid}/inventory/safety`, { body: { safety_stock_qty: 4 }, cookie: A.cookie, origin: OS });
  const atsStats = await rq(SELLER, 'GET', `/shops/${A.shopId}/stats`, { cookie: A.cookie });
  const atsLow = (atsStats.json.low_stock ?? []).find((x) => x.sku?.startsWith('ATS-'));
  Number(atsLow?.available) === 6
    ? ok('Tổng quan dùng ATS: tồn thực 10, giữ 4 → còn bán online 6')
    : bad('Tổng quan vẫn dùng tồn vật lý', JSON.stringify(atsStats.json.low_stock));
  const atsProducts = await rq(SELLER, 'GET', `/shops/${A.shopId}/products?stock=low&limit=100`, { cookie: A.cookie });
  const atsProduct = (atsProducts.json.products ?? []).find((p) => p.id === atsPid);
  Number(atsProduct?.stock) === 6 && Number(atsProduct?.oos_variants) === 0
    ? ok('lọc Sản phẩm sắp hết khớp Tổng quan và hiển thị ATS 6')
    : bad('catalog lệch ATS/low-stock', JSON.stringify(atsProduct ?? atsProducts.json));
  const ws = await (await fetch(`${WORKER}/internal/lowstock-sweep`, { method: 'POST' })).json();
  ws.shops >= 1 ? ok(`worker sweep → cảnh báo ${ws.shops} shop`) : bad('sweep không bắn', JSON.stringify(ws));
  const ob = (await owner.query(`SELECT payload FROM outbox WHERE shop_id=$1 AND topic='stock.low' ORDER BY id DESC LIMIT 1`, [A.shopId])).rows[0];
  ob && ob.payload.items?.length >= 1 && ob.payload.threshold === 8
    ? ok('outbox stock.low kèm danh sách + ngưỡng 8') : bad('outbox thiếu', JSON.stringify(ob?.payload));
  // Idempotent theo NGÀY (0052): gọi sweep lần 2 → shop đã cảnh báo hôm nay KHÔNG gửi lại.
  const before = Number((await owner.query(`SELECT count(*)::int n FROM outbox WHERE shop_id=$1 AND topic='stock.low'`, [A.shopId])).rows[0].n);
  await (await fetch(`${WORKER}/internal/lowstock-sweep`, { method: 'POST' })).json();
  const after = Number((await owner.query(`SELECT count(*)::int n FROM outbox WHERE shop_id=$1 AND topic='stock.low'`, [A.shopId])).rows[0].n);
  after === before ? ok('gọi sweep lần 2 cùng ngày → KHÔNG email trùng (idempotent)') : bad(`email trùng: ${before}→${after}`);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
