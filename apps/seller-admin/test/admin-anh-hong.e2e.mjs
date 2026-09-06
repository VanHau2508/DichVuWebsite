/**
 * E2E: ẢNH KHÔNG TẢI ĐƯỢC — bề mặt tổng + gửi lại. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-anh-hong.e2e.mjs
 *
 * VÌ SAO CÓ BỘ NÀY. Bộ nhập từ sàn chỉ XẾP HÀNG ảnh (0106), worker tải nền. Đo ngày 06/09
 * trên stack dev: sau khi nhập xong, ảnh hỏng KHÔNG có bề mặt tổng nào —
 *
 *   khoá /stats: generated_at, partial, sync, revenue, series, orders_today, unpaid,
 *                partial_payments, status, top_products, low_stock, shipment_attention,
 *                todo, todo_items          → không khoá nào nhắc media
 *   todo_items:  owed … low_stock          → không mã nào nhắc ảnh
 *   Tổng quan / danh sách sản phẩm         → im
 *   DB:          media failed = 1
 *
 * Bề mặt DUY NHẤT là ô "lỗi xử lý" trong trang sửa TỪNG sản phẩm. Shop di cư 300 SP × 3 ảnh
 * phải mở 300 trang mới biết ảnh nào chưa về — mà trang nhập vừa hứa "Ảnh sẽ tải 900".
 *
 * Tiền lệ lấy nguyên: `notification_failures` — cũng là "việc nền thất bại", cũng tier 3,
 * cũng có trang danh sách và nút gửi lại. Cùng hình dạng thì người bán không phải học lại.
 *
 * BỘ NÀY CANH LUÔN MỘT LỖ KHÁC cùng gốc: `/ingest/catalog` (bot, chạy dưới app_rw) không lọc
 * `status='ready'` trong SQL, trong khi storefront được POLICY `store_media` lọc hộ ở mức
 * DÒNG. Hậu quả đo được: sản phẩm có ảnh vị-trí-0 hỏng và vị-trí-1 tốt cho storefront một
 * tấm ảnh, còn bot nhận `image=NULL`. Khách xem web thấy ảnh, khách chat thấy ô trống.
 *
 * Ba câu §9.2 mà trang phải trả lời, và bộ này khẳng định từng câu:
 *   chuyện gì xảy ra   — ảnh nào của sản phẩm nào, LÝ DO bằng tiếng người
 *   làm gì tiếp        — URL nguồn nguyên văn để đối chiếu tệp; lỗi sửa-URL thì nói thẳng
 *                        "sửa URL trong tệp rồi nhập lại" thay vì mời bấm một nút vô ích
 *   thử lại được không — nút Tải lại cho lỗi ở ĐẦU KIA, và đo CẢ VÒNG: hỏng → sửa nguồn →
 *                        bấm → ảnh về → dòng biến khỏi danh sách
 */
import http from 'node:http';
import zlib from 'node:zlib';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const STORE = new URL(process.env.STOREFRONT_URL ?? 'http://storefront:3050');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${String(d).slice(0, 240)}${X}`); };
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
async function adm(method, path, { cookie, form } = {}) {
  const h = {};
  if (form !== undefined) h['content-type'] = 'application/x-www-form-urlencoded';
  h.origin = OADM;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(ADMIN + path, { method, headers: h, redirect: 'manual', body: form !== undefined ? new URLSearchParams(form).toString() : undefined });
  return { status: r.status, location: r.headers.get('location'), body: await r.text() };
}
// node:fetch CẤM đặt header Host ⇒ storefront phân giải shop theo tên miền phải gọi bằng
// node:http, không thì mọi lời gọi ra 404 "tên miền chưa kết nối".
function sf(host, path = '/') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: STORE.hostname, port: STORE.port, path, method: 'GET', headers: { host } },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', reject); req.end();
  });
}
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

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
  return ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA })).sc) ?? cookie;
}
async function makeShopOwner(staff, slug) {
  const r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO });
  const shopId = r.json.id;
  await owner.query(`UPDATE shops SET status='active', went_live_at=now() WHERE id=$1`, [shopId]);
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, slug, host: `${slug}.nentang.vn`, email, password, cookie: await login(email, password) };
}
// Mọi bộ e2e khác đăng nhập bằng owner — vai có sẵn mọi quyền — nên nhánh THIẾU QUYỀN của
// giao diện gần như chưa từng được đi qua. Ô "Ảnh không tải được" gác bằng CATALOG_ROLES nên
// phải đi bằng ĐÚNG hai vai: một vai có, một vai không.
async function addMember(staff, shopId, role) {
  const email = `m-${uniq()}@shop.vn`, password = 'member passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { email, password, cookie: await login(email, password) };
}
function makePng(w, h) {
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc((w * 3 + 1) * h))), chunk('IEND', Buffer.alloc(0))]);
}
const mediaOf = (shopId, slug) => owner.query(
  `SELECT m.id, m.position, m.status, m.last_error, m.source_url
     FROM media m JOIN products p ON p.id = m.product_id
    WHERE p.shop_id = $1 AND p.slug = $2 ORDER BY m.position`, [shopId, slug]).then((r) => r.rows);
async function chờYên(shopId, giây = 60) {
  for (let i = 0; i < giây; i++) {
    const n = Number((await owner.query(
      `SELECT count(*)::int n FROM media m JOIN products p ON p.id = m.product_id
        WHERE p.shop_id = $1 AND m.status = 'pending'`, [shopId])).rows[0].n);
    if (n === 0) return true;
    await sleep(1000);
  }
  return false;
}

async function main() {
  const png = makePng(40, 30);
  // `daSua` mô phỏng người bán đi sửa ĐẦU KIA (mở quyền hotlink trên CDN sàn cũ) — trước khi
  // sửa thì 404, sau khi sửa thì trả ảnh thật. Nhờ vậy nút "Tải lại" được đo CẢ VÒNG chứ
  // không chỉ đo "bấm xong có 202 không".
  let daSua = false;
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/ok')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(png); }
    if (req.url.startsWith('/sua-sau')) {
      if (!daSua) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'image/png' }); return res.end(png);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(80, '0.0.0.0', r));

  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `anh-${uniq()}`);
  const S = { get: (p) => rq(SELLER, 'GET', `/shops/${A.shopId}${p}`, { cookie: A.cookie }) };

  // Ba hình dạng hỏng, mỗi hình một nhóm chính sách khác nhau:
  //   X — ảnh vị-trí-0 trỏ mạng nội bộ (hàng rào chặn) + vị-trí-1 là ảnh THẬT.
  //       Đây là hình dạng dùng cho chốt bot↔storefront.
  //   Y — ảnh hụt (404) ở đầu kia, sửa được → nút Tải lại phải HIỆN.
  const hX = `x${uniq()}`, hY = `y${uniq()}`;
  await rq(SELLER, 'POST', `/shops/${A.shopId}/products/import`, { body: { rows: [
    { handle: hX, title: 'Áo thun hai ảnh', sku: `${hX}-1`, price_vnd: '199000', status: 'active', image_url: 'http://127.0.0.1/ok.png' },
    { handle: hX, image_url: 'http://dbtest/ok.png' },
    { handle: hY, title: 'Quần jean ảnh hụt', sku: `${hY}-1`, price_vnd: '299000', status: 'active', image_url: 'http://dbtest/sua-sau.png' },
  ] }, cookie: A.cookie, origin: OS });
  await owner.query(`UPDATE products SET status='active' WHERE shop_id=$1`, [A.shopId]);
  (await chờYên(A.shopId)) ? null : bad('worker không xử xong hàng đợi ảnh trong 60s');

  sect('1. Lý do hỏng được GHI LẠI, không chỉ đánh dấu failed');
  const medX = await mediaOf(A.shopId, hX);
  const medY = await mediaOf(A.shopId, hY);
  medX.length === 2 && medX[0].status === 'failed' && medX[1].status === 'ready'
    ? ok('ảnh vị-trí-0 hỏng, vị-trí-1 về đủ — đúng hình dạng mà tệp nhập từ sàn hay sinh ra')
    : bad('dựng fixture hỏng', JSON.stringify(medX));
  medX[0]?.last_error === 'blocked'
    ? ok('URL nội bộ ghi lý do "blocked" (0185) — trước đây chỉ có failed, không ai biết vì sao')
    : bad('không ghi lý do URL nội bộ', JSON.stringify(medX[0]));
  medY[0]?.status === 'failed' && medY[0]?.last_error === 'status'
    ? ok('ảnh 404 ở đầu kia ghi lý do "status", tách khỏi nhóm lỗi URL')
    : bad('lý do ảnh 404 sai', JSON.stringify(medY[0]));

  sect('2. /stats và todo_items — con số có bề mặt để dựng ô việc cần làm');
  const st = await S.get('/stats');
  Number(st.json?.todo?.media_failures) === 2
    ? ok('/stats.todo.media_failures = 2, khớp đúng số dòng failed trong DB')
    : bad('/stats không đếm ảnh hỏng', JSON.stringify(st.json?.todo));
  (st.json?.todo_items ?? []).some((t) => t.code === 'media_failures' && t.count === 2 && t.available === true)
    ? ok('todo_items có mã media_failures kèm count + available')
    : bad('todo_items thiếu mã media_failures', JSON.stringify((st.json?.todo_items ?? []).map((t) => t.code)));

  sect('3. Tổng quan — số liệu cho MỌI vai, lối đi chỉ cho vai mở được (§9.3)');
  const ovOwner = await adm('GET', `/shops/${A.shopId}/overview`, { cookie: A.cookie });
  /Ảnh không tải được/.test(ovOwner.body)
    ? ok('owner thấy ô "Ảnh không tải được" trên Tổng quan')
    : bad('Tổng quan không có ô ảnh hỏng');
  new RegExp(`href="/shops/${A.shopId}/media-failures"`).test(ovOwner.body)
    ? ok('ô của owner là LINK dẫn thẳng tới danh sách')
    : bad('ô ảnh hỏng của owner không có link');
  const cm = await addMember(staff, A.shopId, 'catalog_manager');
  const om = await addMember(staff, A.shopId, 'order_manager');
  const ovOm = await adm('GET', `/shops/${A.shopId}/overview`, { cookie: om.cookie });
  // Cắt ĐÚNG ô đang kiểm rồi mới khớp: quét cả trang thì một chuỗi khác cùng chữ sẽ cho
  // xanh giả theo đúng chiều nguy hiểm (§4).
  const oCua = (body) => {
    const i = body.indexOf('Ảnh không tải được');
    return i < 0 ? '' : body.slice(Math.max(0, i - 400), i + 80);
  };
  /Ảnh không tải được/.test(ovOm.body)
    ? ok('order_manager VẪN thấy con số — số liệu vận hành không bị ẩn (quyết định đã khoá ở §9.3)')
    : bad('order_manager bị giấu mất số liệu ảnh hỏng');
  !/media-failures/.test(oCua(ovOm.body))
    ? ok('nhưng KHÔNG có link: /media-failures đòi catalog.read, order_manager sẽ 403')
    : bad('order_manager được mời bấm vào trang sẽ 403', oCua(ovOm.body));
  // catalog_manager KHÔNG mở được Tổng quan (chỉ có catalog.read/write, mà /stats đòi
  // orders.read — landingPath đã gác đúng chuyện đó từ lát cắt 2). Nên chốt "vai này mở
  // được" phải đặt ở CHÍNH trang đích, không đặt ở ô trên Tổng quan.
  const cmPage = await adm('GET', `/shops/${A.shopId}/media-failures`, { cookie: cm.cookie });
  cmPage.status === 200 && /Áo thun hai ảnh/.test(cmPage.body)
    ? ok('catalog_manager MỞ ĐƯỢC trang ảnh hỏng — đúng bộ vai mà seller gác bằng catalog.read')
    : bad(`catalog_manager không mở được trang (${cmPage.status})`, cmPage.body.slice(0, 200));
  // ĐÓNG MẮT XÍCH: khẳng định "order_manager không được mời bấm" ở trên chỉ có nghĩa nếu
  // trang đích THẬT SỰ từ chối họ. Không có dòng này thì ẩn link là trang trí.
  const omPage = await adm('GET', `/shops/${A.shopId}/media-failures`, { cookie: om.cookie });
  omPage.status === 403
    ? ok('và order_manager mở thẳng URL thì 403 — ẩn link khớp với quyền thật, không phải trang trí')
    : bad(`order_manager vẫn mở được trang ảnh hỏng (${omPage.status})`);

  sect('4. Trang danh sách — chuyện gì xảy ra / làm gì tiếp');
  const pg1 = await adm('GET', `/shops/${A.shopId}/media-failures`, { cookie: A.cookie });
  pg1.status === 200 ? ok('trang mở được') : bad(`trang lỗi ${pg1.status}`, pg1.body.slice(0, 200));
  /Áo thun hai ảnh/.test(pg1.body) && /Quần jean ảnh hụt/.test(pg1.body)
    ? ok('nêu ĐÍCH DANH sản phẩm nào thiếu ảnh, không chỉ đưa một con số')
    : bad('trang không nêu tên sản phẩm');
  pg1.body.includes('http://127.0.0.1/ok.png') && pg1.body.includes('http://dbtest/sua-sau.png')
    ? ok('URL nguồn hiện NGUYÊN VĂN — không đối chiếu được với tệp thì "sửa tệp" là lời khuyên suông')
    : bad('trang không hiện URL nguồn');
  /địa chỉ mạng nội bộ/.test(pg1.body) && /máy chủ ảnh không trả về ảnh/.test(pg1.body)
    ? ok('lý do bằng TIẾNG NGƯỜI, mỗi loại một câu khác nhau')
    : bad('lý do không được dịch ra tiếng người');
  // Bất biến của hàng rào: mã HTTP của đích là kênh blind SSRF, không bao giờ trả cho người
  // gửi URL. Người bán mất một chút chi tiết; hàng rào giữ nguyên bất biến của nó.
  !/\b404\b/.test(pg1.body)
    ? ok('KHÔNG lộ mã HTTP của đích — giữ bất biến chống blind SSRF của fetch-image.js')
    : bad('trang in mã HTTP của đích ra cho người gửi URL');

  sect('5. Thử lại được không — nút chỉ hiện ở lỗi SỬA ĐƯỢC Ở ĐẦU KIA');
  const khoi = (body, ten) => {
    const i = body.indexOf(ten);
    return i < 0 ? '' : body.slice(i, i + 1400);
  };
  const kX = khoi(pg1.body, 'Áo thun hai ảnh'), kY = khoi(pg1.body, 'Quần jean ảnh hụt');
  /Sửa URL trong tệp rồi nhập lại/.test(kX) && !/refetch/.test(kX)
    ? ok('lỗi URL: KHÔNG có nút, và nói thẳng phải làm gì thay vì mời bấm một nút vô ích')
    : bad('lỗi URL vẫn mời bấm Tải lại', kX.slice(0, 200));
  /refetch/.test(kY) && /Tải lại/.test(kY)
    ? ok('lỗi ở đầu kia: có nút Tải lại')
    : bad('ảnh 404 không có nút Tải lại', kY.slice(0, 200));
  // Chốt nằm ở SELLER, admin chỉ chuyển tiếp — frontend không phải nguồn quyết định (§9.2).
  const chan = await rq(SELLER, 'POST', `/shops/${A.shopId}/media/${medX[0].id}/refetch`, { cookie: A.cookie, origin: OS });
  chan.status === 409 && chan.json?.error_code === 'url_must_be_fixed'
    ? ok('gọi thẳng API vẫn bị SELLER chặn 409 kèm mã lý do — ẩn nút không phải là chốt')
    : bad('seller cho tải lại URL nội bộ', `${chan.status} ${chan.raw?.slice(0, 160)}`);

  sect('6. Vòng đầy đủ: hỏng → sửa đầu kia → bấm Tải lại → ảnh về → dòng biến mất');
  daSua = true;
  const post = await adm('POST', `/shops/${A.shopId}/media-failures/${medY[0].id}/refetch`, { cookie: A.cookie, form: {} });
  post.status === 303 && /done=refetch/.test(post.location ?? '')
    ? ok('POST rồi REDIRECT (PRG) — bấm lặp hay F5 không gửi lại lệnh')
    : bad('không phải PRG', `${post.status} ${post.location}`);
  (await chờYên(A.shopId)) ? null : bad('worker không nhặt lại ảnh sau khi Tải lại');
  const medY2 = await mediaOf(A.shopId, hY);
  medY2[0]?.status === 'ready' && medY2[0]?.last_error === null
    ? ok('ảnh về cửa hàng thật, lý do cũ được XOÁ (không để lại vết bẩn của lượt hỏng)')
    : bad('ảnh không về sau khi tải lại', JSON.stringify(medY2));
  const pg2 = await adm('GET', `/shops/${A.shopId}/media-failures`, { cookie: A.cookie });
  !/Quần jean ảnh hụt/.test(pg2.body) && /Áo thun hai ảnh/.test(pg2.body)
    ? ok('dòng đã xử biến khỏi danh sách, dòng chưa xử vẫn còn')
    : bad('danh sách không cập nhật');
  Number((await S.get('/stats')).json?.todo?.media_failures) === 1
    ? ok('con số trên Tổng quan tụt theo — đếm và danh sách là CÙNG một tập')
    : bad('/stats không tụt sau khi sửa xong một ảnh');

  sect('7. Bot và storefront phải thấy CÙNG một cửa hàng');
  // `/ingest/catalog` chạy dưới app_rw, mà policy vai đó chỉ lọc shop_id — điều kiện
  // status='ready' mà storefront được POLICY tặng không thì bot phải TỰ VIẾT.
  const su = await rq(AUTH, 'POST', '/auth/step-up', { body: { password: A.password }, cookie: A.cookie, origin: OA });
  A.cookie = ck(su.sc) ?? A.cookie;
  const kr = await rq(SELLER, 'POST', `/shops/${A.shopId}/api-keys`, { body: { name: 'Bot' }, cookie: A.cookie, origin: OS });
  const token = kr.json?.token;
  if (!token) bad('không tạo được khoá kết nối cho bot', `${kr.status} ${kr.raw?.slice(0, 160)}`);
  const cat = await rq(SELLER, 'GET', '/ingest/catalog?limit=30', { bearer: token });
  const botX = (cat.json?.products ?? []).find((p) => p.slug === hX);
  botX && typeof botX.image === 'string' && /\.webp$/.test(botX.image)
    ? ok('bot nhận ĐÚNG ảnh vị-trí-1 (ảnh ready), không bị dòng hỏng vị-trí-0 chắn mất')
    : bad('bot vẫn nhận image NULL trong khi storefront có ảnh', JSON.stringify(botX ?? null));
  const pdp = await sf(A.host, `/p/${hX}`);
  const webpTrenWeb = (pdp.body.match(/\/media-public\/[^"']*\.webp/g) ?? [])[0] ?? null;
  webpTrenWeb && botX?.image === webpTrenWeb
    ? ok('bot và storefront trỏ vào ĐÚNG một tệp ảnh — hai đầu không còn kể hai câu chuyện')
    : bad('bot và storefront lệch nhau', `bot=${botX?.image} web=${webpTrenWeb}`);

  await new Promise((r) => srv.close(r));
  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
