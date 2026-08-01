/**
 * End-to-end KHOÁ KẾT NỐI + NHẬN ĐƠN TỪ PHẦN MỀM NGOÀI (0119 + 0120). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/api-keys.e2e.mjs
 *
 * Kiểm: tạo khoá đòi step-up · token hiện ĐÚNG một lần (không đọc lại được) · POST
 * /ingest/orders bằng Bearer tạo đơn thật (trừ tồn, đúng shop, source=facebook) · khoá
 * shop A KHÔNG tạo được đơn cho shop B · token sai/thiếu → 401 · thu hồi rồi → 401 ·
 * idempotency chống đẩy trùng · nguồn đơn sai chính tả → 400 (KHÔNG âm thầm về 'manual') ·
 * bộ lọc ?source= và cột source trên danh sách · khoá không dùng được cho route session.
 */
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic = 'user.invited' AND payload->>'to' = $1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${d}${X}`); };
const sect = (m) => console.log(`\n${B}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };

async function rq(base, method, path, { body, cookie, origin, bearer } = {}) {
  const h = {};
  if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  if (bearer) h.authorization = `Bearer ${bearer}`;
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
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
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
const stepUp = async (shop) => rq(AUTH, 'POST', '/auth/step-up', { body: { password: shop.password }, cookie: shop.cookie, origin: OA });

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `key-${uniq()}`);
  const Bs = await makeShopOwner(staff, `key-${uniq()}`);
  const vidA = await setupProduct(A, 150000, 20);
  const vidB = await setupProduct(Bs, 90000, 5);
  const a = {
    post: (p, b) => rq(SELLER, 'POST', `/shops/${A.shopId}${p}`, { body: b, cookie: A.cookie, origin: OS }),
    get: (p) => rq(SELLER, 'GET', `/shops/${A.shopId}${p}`, { cookie: A.cookie }),
  };
  const CUST = { name: 'Khách Chốt Messenger', phone: '0912345678', address_line: '5 Lê Lợi', province: 'TP. Hồ Chí Minh' };
  const ingest = (token, over = {}) => rq(SELLER, 'POST', '/ingest/orders', {
    bearer: token,
    body: { lines: [{ variant_id: vidA, qty: 1 }], customer: CUST, payment_method: 'cod', source: 'facebook', idempotency_key: `fb-${uniq()}`, ...over },
  });

  sect('1. Tạo khoá — đòi step-up, token hiện đúng MỘT lần');
  let r = await a.post('/api-keys', { name: 'Pancake' });
  r.status === 403 && r.json?.step_up_required === true
    ? ok('chưa step-up → 403 step_up_required') : bad(`tạo khoá không đòi step-up (${r.status})`, r.raw);
  const su = await stepUp(A);
  if (su.status !== 200) throw new Error(`step-up thất bại: ${su.raw}`);
  A.cookie = ck(su.sc) ?? A.cookie;
  r = await a.post('/api-keys', { name: '' });
  r.status === 400 ? ok('tên rỗng → 400') : bad(`tên rỗng không bị chặn (${r.status})`, r.raw);
  r = await a.post('/api-keys', { name: 'Pancake' });
  const token = r.json?.token, keyId = r.json?.id;
  r.status === 201 && typeof token === 'string' && token.startsWith('ntk_') && token.length > 30
    ? ok('tạo khoá 201, trả token ntk_… đủ dài') : bad('tạo khoá lỗi', r.raw);

  r = await a.get('/api-keys');
  const listed = (r.json?.keys ?? []).find((k) => k.id === keyId);
  r.status === 200 && listed && listed.name === 'Pancake' ? ok('khoá hiện trong danh sách') : bad('danh sách khoá sai', r.raw);
  // Đây là điểm CHẾT NGƯỜI nếu làm sai: khoá đọc lại được = khoá rò theo mọi ảnh chụp
  // màn hình. Không chỉ kiểm "thiếu trường token" mà kiểm KHÔNG chuỗi nào chứa token.
  JSON.stringify(r.json).includes(token)
    ? bad('token ĐỌC LẠI ĐƯỢC qua danh sách khoá!') : ok('danh sách KHÔNG chứa token thô (chỉ prefix)');
  const dbRow = (await owner.query('SELECT token_hash, token_prefix FROM shop_api_keys WHERE id=$1', [keyId])).rows[0];
  dbRow && !dbRow.token_hash.includes(token) && dbRow.token_hash.length === 64
    ? ok('DB chỉ lưu sha256, không lưu token thô') : bad('DB lưu token thô hoặc hash sai', JSON.stringify(dbRow));

  sect('2. Nhận đơn qua Bearer — đơn thật, đúng shop, trừ tồn');
  const before = await invOf(vidA);
  r = await ingest(token);
  const o1 = r.json;
  r.status === 201 && o1?.total_vnd === 150000 + 30000
    ? ok(`ingest tạo đơn 201 #${o1.order_number}, giá lấy theo shop`) : bad('ingest lỗi', r.raw);
  const after = await invOf(vidA);
  Number(after.reserved) === Number(before.reserved) + 1 ? ok('reserve tồn +1') : bad(`reserve sai: ${before.reserved}→${after.reserved}`);
  const row = (await owner.query('SELECT shop_id, source, source_ref, api_key_id FROM orders WHERE id=$1', [o1.id])).rows[0];
  row.shop_id === A.shopId ? ok('đơn nằm ĐÚNG shop của khoá') : bad(`đơn vào nhầm shop: ${row.shop_id}`);
  row.source === 'facebook' ? ok("source ghi 'facebook'") : bad(`source sai: ${row.source}`);
  row.api_key_id === keyId ? ok('đơn đóng dấu api_key_id (truy được tích hợp nào đẩy)') : bad(`api_key_id sai: ${row.api_key_id}`);
  const aud = (await owner.query(`SELECT actor_type, actor_id, metadata FROM audit_logs WHERE action='order.created_manual' AND metadata->>'api_key_id'=$1`, [keyId])).rows[0];
  aud && aud.actor_type === 'system' && aud.actor_id === null
    ? ok("audit ghi actor_type='system', không gán bừa cho người") : bad('audit đơn ingest sai', JSON.stringify(aud));
  // last_used_at là căn cứ để chủ shop DÁM thu hồi khoá — sai thì họ không dám đụng.
  const used = (await owner.query('SELECT last_used_at FROM shop_api_keys WHERE id=$1', [keyId])).rows[0];
  used.last_used_at ? ok('last_used_at được đóng dấu') : bad('last_used_at vẫn NULL sau khi gọi');

  sect('3. Token sai/thiếu/thu hồi → 401, không rò thông tin');
  r = await rq(SELLER, 'POST', '/ingest/orders', { body: { lines: [] } });
  r.status === 401 ? ok('không có Authorization → 401') : bad(`thiếu token không bị chặn (${r.status})`, r.raw);
  r = await ingest('ntk_khong-ton-tai-gi-ca');
  r.status === 401 ? ok('token bịa → 401') : bad(`token bịa lọt (${r.status})`, r.raw);
  // Cùng MỘT câu trả lời cho hai trường hợp: khác nhau là kênh dò xem khoá nào có thật.
  const noHeader = await rq(SELLER, 'POST', '/ingest/orders', { body: {} });
  const badToken = await ingest('ntk_zzz');
  noHeader.json?.error === badToken.json?.error
    ? ok('thiếu token và token sai trả CÙNG thông báo (không dò được)') : bad('thông báo khác nhau → dò được khoá tồn tại', `${noHeader.raw} vs ${badToken.raw}`);

  sect('4. Cô lập chéo shop — khoá A không chạm được hàng shop B');
  r = await ingest(token, { lines: [{ variant_id: vidB, qty: 1 }], idempotency_key: `x-${uniq()}` });
  r.status !== 201 ? ok(`khoá shop A đặt biến thể shop B → ${r.status} (từ chối)`) : bad('CÔ LẬP VỠ: khoá A tạo được đơn với hàng shop B!', r.raw);
  const bOrders = (await owner.query('SELECT count(*)::int n FROM orders WHERE shop_id=$1', [Bs.shopId])).rows[0].n;
  bOrders === 0 ? ok('shop B vẫn 0 đơn') : bad(`shop B có ${bOrders} đơn lạ!`);
  // FK composite (0121) — kiểm bằng vai OWNER, tức là BỎ QUA RLS: chứng minh chính DB
  // từ chối, không phải "RLS che nên không ai với tới". Đây là khác biệt giữa một hàng
  // rào và một sự may mắn.
  const kB = (await owner.query(
    `INSERT INTO shop_api_keys (shop_id, name, token_hash, token_prefix)
     VALUES ($1, 'khoa-B', $2, 'ntk_test') RETURNING id`, [Bs.shopId, `hash-${uniq()}${uniq()}`],
  )).rows[0].id;
  let fkBlocked = false;
  try {
    await owner.query('UPDATE orders SET api_key_id = $1 WHERE id = $2', [kB, o1.id]);
  } catch { fkBlocked = true; }
  fkBlocked ? ok('DB chặn đơn shop A trỏ sang khoá shop B (FK composite)')
    : bad('FK cho phép đơn trỏ sang khoá shop KHÁC!');

  sect('5. Idempotency — đẩy trùng không đẻ đơn thứ hai');
  const idem = `dup-${uniq()}`;
  const d1 = await ingest(token, { idempotency_key: idem });
  const d2 = await ingest(token, { idempotency_key: idem });
  d1.status === 201 && d2.json?.order_number === d1.json?.order_number
    ? ok('gửi lại cùng idempotency_key → trả đúng đơn cũ') : bad('đẩy trùng đẻ đơn mới!', `${d1.raw} | ${d2.raw}`);
  r = await ingest(token, { idempotency_key: 'x' });
  r.status === 400 ? ok('idempotency_key quá ngắn → 400') : bad(`key rác lọt (${r.status})`, r.raw);

  sect('6. Nguồn đơn sai chính tả → 400, KHÔNG âm thầm về mặc định');
  r = await ingest(token, { source: 'fb', idempotency_key: `s-${uniq()}` });
  r.status === 400 ? ok("source='fb' → 400 (không lặng lẽ thành 'manual')") : bad(`source rác lọt (${r.status})`, r.raw);
  r = await ingest(token, { source: 'zalo', source_ref: 'zalo.me/0912345678', idempotency_key: `s-${uniq()}` });
  const zrow = r.status === 201 ? (await owner.query('SELECT source, source_ref FROM orders WHERE id=$1', [r.json.id])).rows[0] : null;
  zrow?.source === 'zalo' && zrow.source_ref === 'zalo.me/0912345678'
    ? ok('source=zalo + source_ref lưu nguyên') : bad('zalo/source_ref sai', r.raw);

  sect('7. Danh sách đơn: cột nguồn + bộ lọc ?source=');
  await a.post('/orders', { lines: [{ variant_id: vidA, qty: 1 }], customer: CUST, payment_method: 'cod', idempotency_key: `man-${uniq()}` });
  r = await a.get('/orders?limit=100');
  const all = r.json?.orders ?? [];
  all.some((o) => o.source === 'facebook') && all.some((o) => o.source === 'manual')
    ? ok('danh sách trả cột source cho cả đơn ingest và đơn gõ tay') : bad('danh sách thiếu source', r.raw);
  r = await a.get('/orders?source=facebook&limit=100');
  const fb = r.json?.orders ?? [];
  fb.length > 0 && fb.every((o) => o.source === 'facebook')
    ? ok(`?source=facebook lọc đúng (${fb.length} đơn)`) : bad('lọc theo nguồn sai', r.raw);
  r = await a.get('/orders?source=zzz&limit=100');
  (r.json?.orders ?? []).length === all.length
    ? ok('?source= giá trị lạ → bỏ qua bộ lọc, không vỡ trang') : bad('source lạ làm lệch kết quả', r.raw);
  r = await a.get('/orders/export?source=facebook');
  r.status === 200 && /(^|,)source(,|\r?\n)/.test(String(r.raw).split(/\r?\n/)[0] ?? '')
    ? ok('CSV có cột source') : bad('CSV thiếu cột source', String(r.raw).slice(0, 200));

  sect('8. Thu hồi khoá — ngừng nhận đơn ngay');
  r = await a.post(`/api-keys/${keyId}/revoke`);
  r.status === 200 ? ok('thu hồi 200') : bad('thu hồi lỗi', r.raw);
  r = await ingest(token, { idempotency_key: `after-${uniq()}` });
  r.status === 401 ? ok('khoá đã thu hồi → 401') : bad(`khoá thu hồi VẪN tạo được đơn (${r.status})!`, r.raw);
  r = await a.post(`/api-keys/${keyId}/revoke`);
  r.status === 404 ? ok('thu hồi lần hai → 404') : bad(`thu hồi lặp trả ${r.status}`, r.raw);

  sect('9. Khoá KHÔNG thay được phiên đăng nhập');
  // Step-up lại: cửa sổ step-up có hạn, mà tới đây bộ test đã chạy qua nhiều vòng gọi.
  const su2 = await stepUp(A);
  A.cookie = ck(su2.sc) ?? A.cookie;
  const live = await a.post('/api-keys', { name: 'n8n' });
  const t2 = live.json?.token;
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/orders`, { bearer: t2 });
  r.status === 401 ? ok('Bearer không mở được route session (/shops/:id/orders → 401)') : bad(`Bearer vào được route session (${r.status})!`, r.raw);
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/api-keys`, { bearer: t2 });
  r.status === 401 ? ok('Bearer không liệt kê được khoá') : bad(`Bearer đọc được danh sách khoá (${r.status})!`, r.raw);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
