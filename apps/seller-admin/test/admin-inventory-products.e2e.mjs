/**
 * E2E nhóm "rẻ, dữ liệu đã có" — phần Kho & Sản phẩm. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-inventory-products.e2e.mjs
 *
 * Kiểm:
 *   1. SỔ CÁI KHO cấp shop (0097) — endpoint MỚI + trang chỉ-đọc: hiện đủ ai/khi nào/vì sao,
 *      lọc theo loại, phân trang has_more, CÁCH LY tenant, và perm inventory.manage.
 *   2. Trang SẢN PHẨM — tab trạng thái có số đếm (không dính filter status), cột Tồn (loại
 *      biến thể mồ côi) + cột Đã bán.
 *   3. ĐỔI TRẠNG THÁI HÀNG LOẠT — thành công một phần, giữ bộ lọc sau PRG, có thông báo,
 *      chặn CSRF, cách ly chéo shop, và đường 'draft' (trước đây KHÔNG tồn tại).
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
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${String(d).slice(0, 200)}${X}`); };
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
// form: object HOẶC mảng cặp [k,v] — mảng cặp BẮT BUỘC khi có key trùng (checkbox nhiều id):
// new URLSearchParams(object) chỉ giữ 1 giá trị → test xanh giả.
async function adm(method, path, { cookie, origin, form } = {}) {
  const h = {};
  if (form !== undefined) h['content-type'] = 'application/x-www-form-urlencoded';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(ADMIN + path, { method, headers: h, redirect: 'manual', body: form !== undefined ? new URLSearchParams(form).toString() : undefined });
  return { status: r.status, location: r.headers.get('location'), body: await r.text() };
}
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;

async function makeStaff() {
  const email = `staff-${uniq()}@nentang.vn`, password = 'staff strong passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let cookie = await login(email, password);
  const r = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie, origin: OA });
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
  const r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, slug, email, password, cookie: await login(email, password) };
}
// Mời thêm 1 thành viên vai bất kỳ (để kiểm perm).
async function addMember(staffCookie, shopId, role) {
  const email = `m-${uniq()}@shop.vn`, password = 'member passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { email, password, cookie: await login(email, password) };
}
async function mkProduct(shop, title, price, stock, status = 'active') {
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/products`, {
    body: { title, slug: `sp-${uniq()}`, price_vnd: price, status, variants: [{ sku: `S-${uniq()}`, price_vnd: price }] },
    cookie: shop.cookie, origin: OS,
  });
  const det = await rq(SELLER, 'GET', `/shops/${shop.shopId}/products/${r.json.id}`, { cookie: shop.cookie });
  const vid = det.json.variants[0].id;
  if (stock) {
    await rq(SELLER, 'POST', `/shops/${shop.shopId}/variants/${vid}/inventory/adjust`,
      { body: { delta: stock, reason: `nhập đầu kỳ ${title}` }, cookie: shop.cookie, origin: OS });
  }
  return { pid: r.json.id, vid };
}

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `inv-${uniq()}`);
  const Bo = await makeShopOwner(staff, `oth-${uniq()}`);
  const P1 = await mkProduct(A, `Ao thun ${uniq()}`, 150000, 20);
  const P2 = await mkProduct(A, `Quan jean ${uniq()}`, 300000, 3, 'draft'); // 3 < 5 → phải đánh dấu "sắp hết"
  const P3 = await mkProduct(A, `Non ${uniq()}`, 90000, 0);
  const PB = await mkProduct(Bo, `SP shop khac ${uniq()}`, 50000, 5);
  ok('dựng 2 shop + 3 SP shop A (1 active có tồn, 1 nháp, 1 hết hàng) + 1 SP shop B');

  // ── 1. SỔ CÁI KHO ──────────────────────────────────────────────────────────
  sect('1. Sổ cái kho: endpoint MỚI cấp shop + trang chỉ-đọc');
  let r = await rq(SELLER, 'GET', `/shops/${A.shopId}/inventory/ledger?limit=50`, { cookie: A.cookie });
  const ents = r.json?.entries ?? [];
  r.status === 200 && ents.length >= 2 ? ok(`API trả ${ents.length} dòng sổ cái toàn shop`) : bad('API sổ cái lỗi', `${r.status} ${r.raw?.slice(0, 120)}`);
  const e0 = ents[0] ?? {};
  e0.product_title && e0.actor_email && e0.reason && e0.kind
    ? ok('mỗi dòng đủ: tên SP · người thực hiện · lý do · loại') : bad('dòng thiếu trường', JSON.stringify(e0));
  ents.every((e) => Number(e.delta) !== 0) ? ok('không có dòng delta = 0') : bad('có dòng delta 0');

  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/inventory/ledger?kind=receive`, { cookie: A.cookie });
  (r.json?.entries ?? []).every((e) => e.kind === 'receive')
    ? ok('lọc theo loại "Nhập kho" đúng') : bad('lọc kind sai');
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/inventory/ledger?kind=reserve`, { cookie: A.cookie });
  r.status === 200 ? ok('kind lạ (reserve — chưa từng được ghi) → bỏ qua lọc, không 400/500') : bad('kind lạ làm nổ', String(r.status));

  // variant_id RÁC không được rơi xuống Postgres thành 22P02 → 500 (regex lỏng 36 ký tự
  // hex-hoặc-gạch từng cho chuỗi toàn gạch nối lọt qua).
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/inventory/ledger?variant_id=------------------------------------`, { cookie: A.cookie });
  r.status === 200 ? ok('variant_id rác (36 gạch nối) → 200, không 500') : bad('UUID lỏng làm sập sổ cái', String(r.status));
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/inventory/ledger?variant_id=khong-phai-uuid`, { cookie: A.cookie });
  r.status === 200 ? ok('variant_id rác (chuỗi thường) → 200') : bad('variant_id rác làm sập', String(r.status));

  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/inventory/ledger?limit=1`, { cookie: A.cookie });
  r.json?.entries?.length === 1 && r.json?.has_more === true
    ? ok('phân trang: limit=1 → 1 dòng + has_more=true') : bad('has_more sai', JSON.stringify({ n: r.json?.entries?.length, hm: r.json?.has_more }));

  sect('2. Sổ cái kho: CÁCH LY tenant + phân quyền');
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/inventory/ledger?limit=100`, { cookie: A.cookie });
  const bVariants = new Set([PB.vid]);
  (r.json?.entries ?? []).every((e) => !bVariants.has(e.variant_id))
    ? ok('shop A KHÔNG thấy dòng kho của shop B') : bad('RÒ RỈ chéo shop!');
  r = await rq(SELLER, 'GET', `/shops/${Bo.shopId}/inventory/ledger`, { cookie: A.cookie });
  r.status === 403 || r.status === 404 ? ok(`owner A gọi sổ cái shop B → ${r.status}`) : bad('không chặn chéo shop', String(r.status));

  const cm = await addMember(staff, A.shopId, 'catalog_manager');
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/inventory/ledger`, { cookie: cm.cookie });
  r.status === 403 ? ok('catalog_manager → 403 (sổ cái là bí mật KD, cần inventory.manage)') : bad('perm quá lỏng', String(r.status));

  sect('3. Sổ cái kho: trang seller-admin');
  r = await adm('GET', `/shops/${A.shopId}/inventory-ledger`, { cookie: A.cookie });
  r.status === 200 && /Sổ cái kho/.test(r.body) ? ok('trang mở được') : bad('trang lỗi', `${r.status} ${r.body.slice(0, 150)}`);
  /Nhập kho/.test(r.body) && /nhập đầu kỳ/.test(r.body) ? ok('hiện loại + lý do thật') : bad('thiếu loại/lý do');
  new RegExp(A.email.replace(/[.@+]/g, '\\$&')).test(r.body) ? ok('hiện email người thực hiện') : bad('thiếu người thực hiện');
  !/<script(?![^>]*nonce=)/.test(r.body) ? ok('không script NÀO thiếu nonce (ADR-011)') : bad('lọt <script> không nonce');
  // Chỉ-đọc: không form POST nào nhắm VÀO sổ cái. (Bỏ qua form /logout của khung layout
  // dùng chung — nó có mặt ở mọi trang, không phải thao tác ghi sổ.)
  const writeForms = [...r.body.matchAll(/<form[^>]*method="POST"[^>]*action="([^"]*)"/gi)]
    .map((m) => m[1]).filter((a) => !a.endsWith('/logout'));
  writeForms.length === 0 ? ok('THUẦN chỉ-đọc — không form ghi nào (sổ cái append-only)') : bad('có form ghi trong sổ cái!', writeForms.join(' '));
  /Sổ cái kho<\/a>|>Sổ cái kho</.test(r.body) ? ok('có tab "Sổ cái kho" trong khu Kho') : bad('thiếu tab');
  r = await adm('GET', `/shops/${A.shopId}/inventory-ledger`, { cookie: cm.cookie });
  r.status !== 200 || !/nhập đầu kỳ/.test(r.body) ? ok('catalog_manager không xem được trang sổ cái') : bad('vai thiếu quyền vẫn xem được');

  // ── 4. Trang SẢN PHẨM: tab + cột ───────────────────────────────────────────
  sect('4. Sản phẩm: TAB trạng thái có số đếm + cột Tồn/Đã bán');
  r = await adm('GET', `/shops/${A.shopId}/products`, { cookie: A.cookie });
  r.body.includes('class="stabs"') ? ok('có dải tab trạng thái') : bad('thiếu tab');
  !/<select name="status">/.test(r.body) ? ok('bỏ dropdown trạng thái cũ') : bad('vẫn còn dropdown');
  const tabCount = (label) => {
    const m = new RegExp(`class="stab[^"]*"[^>]*>${label}<span class="cnt">(\\d+)</span>`).exec(r.body);
    return m ? Number(m[1]) : null;
  };
  tabCount('Tất cả') === 3 ? ok('tab "Tất cả" = 3 SP') : bad('đếm Tất cả sai', `=${tabCount('Tất cả')}`);
  tabCount('Đang bán') === 2 ? ok('tab "Đang bán" = 2') : bad('đếm Đang bán sai', `=${tabCount('Đang bán')}`);
  tabCount('Nháp') === 1 ? ok('tab "Nháp" = 1') : bad('đếm Nháp sai', `=${tabCount('Nháp')}`);
  /<th class="right">Tồn<\/th>/.test(r.body) && /<th class="right">Đã bán<\/th>/.test(r.body)
    ? ok('có cột Tồn + cột Đã bán') : bad('thiếu cột mới');
  /<span class="stock">20<\/span>/.test(r.body) ? ok('tồn 20 hiện đúng') : bad('tồn sai', r.body.match(/class="stock[^"]*">\d+/g)?.join(' '));
  /<span class="stock zero">0<\/span>/.test(r.body) ? ok('SP hết hàng hiện 0 kiểu cảnh báo (.zero)') : bad('không đánh dấu hết hàng');
  /<span class="stock low">3<\/span>/.test(r.body) ? ok('tồn thấp (3 < 5) đánh dấu .low') : bad('không đánh dấu tồn thấp');

  sect('5. BẪY: lọc 1 tab thì các tab khác vẫn giữ số đếm thật');
  r = await adm('GET', `/shops/${A.shopId}/products?status=draft`, { cookie: A.cookie });
  tabCount('Tất cả') === 3 ? ok('đang lọc Nháp nhưng tab "Tất cả" vẫn = 3') : bad('đếm dính filter status', `=${tabCount('Tất cả')}`);
  /class="stab on"[^>]*>Nháp/.test(r.body) ? ok('tab đang chọn được đánh dấu') : bad('không đánh dấu tab đang chọn');

  // ── 6. BULK đổi trạng thái ─────────────────────────────────────────────────
  sect('6. Đổi trạng thái HÀNG LOẠT (đường "về nháp" trước đây KHÔNG tồn tại)');
  r = await adm('POST', `/shops/${A.shopId}/products/bulk-status`, {
    cookie: A.cookie, origin: OADM,
    form: [['product_ids', P1.pid], ['product_ids', P3.pid], ['to', 'draft'], ['status_filter', ''], ['q', ''], ['offset', '0']],
  });
  const st1 = (await owner.query('SELECT status FROM products WHERE id=$1', [P1.pid])).rows[0].status;
  const st3 = (await owner.query('SELECT status FROM products WHERE id=$1', [P3.pid])).rows[0].status;
  r.status === 303 && st1 === 'draft' && st3 === 'draft' ? ok('2 SP → nháp (đường mới, publish/archive cũ không làm được)') : bad('bulk draft lỗi', `${r.status} ${st1}/${st3}`);
  /bulk_ok=2/.test(r.location ?? '') ? ok('PRG mang theo số đã đổi') : bad('PRG thiếu số', r.location);

  sect('7. Thành công MỘT PHẦN + thông báo hiện ra + giữ bộ lọc');
  r = await adm('POST', `/shops/${A.shopId}/products/bulk-status`, {
    cookie: A.cookie, origin: OADM,
    form: [['product_ids', P1.pid], ['product_ids', P2.pid], ['to', 'draft'], ['status_filter', 'draft'], ['q', 'Ao'], ['offset', '0']],
  });
  // Cả 2 đã là draft → changed=0, skipped=2 (không phải lỗi).
  /bulk_ok=0/.test(r.location ?? '') && /bulk_skip=2/.test(r.location ?? '')
    ? ok('SP đã ở trạng thái đích → skipped, không báo lỗi') : bad('không xử lý skip đúng', r.location);
  /status=draft/.test(r.location ?? '') && /q=Ao/.test(r.location ?? '')
    ? ok('PRG GIỮ bộ lọc đang xem (status + q)') : bad('PRG làm rơi bộ lọc', r.location);
  const follow = await adm('GET', (r.location ?? '').replace(ADMIN, ''), { cookie: A.cookie });
  /Đã chuyển 0 sản phẩm/.test(follow.body) && /Bỏ qua 2/.test(follow.body)
    ? ok('trang sau HIỆN thông báo kết quả (không để số trơ trên URL)') : bad('không hiện thông báo', follow.body.match(/Đã chuyển[^<]*/)?.[0]);

  sect('8. Bảo mật bulk: CSRF · chéo shop · trạng thái lạ · trần 100');
  r = await adm('POST', `/shops/${A.shopId}/products/bulk-status`, {
    cookie: A.cookie, form: [['product_ids', P1.pid], ['to', 'active']],   // KHÔNG có origin
  });
  const stAfter = (await owner.query('SELECT status FROM products WHERE id=$1', [P1.pid])).rows[0].status;
  r.status === 403 && stAfter === 'draft' ? ok('thiếu Origin → 403, không đổi gì') : bad('CSRF không chặn', `${r.status} ${stAfter}`);

  r = await adm('POST', `/shops/${A.shopId}/products/bulk-status`, {
    cookie: A.cookie, origin: OADM, form: [['product_ids', PB.pid], ['to', 'archived']],
  });
  const stB = (await owner.query('SELECT status FROM products WHERE id=$1', [PB.pid])).rows[0].status;
  stB !== 'archived' ? ok('SP shop B KHÔNG bị đổi qua shop A (RLS)') : bad('RÒ RỈ: đổi được SP shop khác!');

  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/products/bulk/status`, {
    cookie: A.cookie, origin: OS, body: { product_ids: [P1.pid], status: 'deleted' },
  });
  r.status === 400 ? ok('trạng thái lạ ("deleted") → 400, không nhét vào UPDATE') : bad('allowlist trạng thái hổng', String(r.status));

  // XANH GIẢ đã từng mắc: gửi 101 BẢN SAO của CÙNG một id → Set dedupe còn 1 → nhánh trần
  // 100 KHÔNG BAO GIỜ chạy, mà test vẫn xanh nhờ vế `changed === 0`. Phải là 101 id KHÁC NHAU.
  const many = Array.from({ length: 101 }, (_, i) => {
    const h = String(i).padStart(12, '0');
    return `00000000-0000-4000-8000-${h}`;
  });
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/products/bulk/status`, {
    cookie: A.cookie, origin: OS, body: { product_ids: many, status: 'active' },
  });
  r.status === 400 && /100/.test(r.json?.error ?? '') ? ok('101 id KHÁC NHAU → 400 chặn bởi trần 100') : bad('trần 100 không chặn', `${r.status} ${JSON.stringify(r.json)}`);
  // Ngược lại: 101 bản sao của cùng 1 id → dedupe còn 1 → KHÔNG chạm trần, xử lý bình thường.
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/products/bulk/status`, {
    cookie: A.cookie, origin: OS, body: { product_ids: Array.from({ length: 101 }, () => P2.pid), status: 'active' },
  });
  r.status === 200 && Number(r.json?.changed ?? 0) <= 1 ? ok('101 bản sao cùng id → dedupe còn 1, không chạm trần') : bad('dedupe sai', `${r.status} ${JSON.stringify(r.json)}`);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error('admin inventory/products e2e lỗi:', e); await owner.end(); process.exit(1); });
