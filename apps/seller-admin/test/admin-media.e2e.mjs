/**
 * End-to-end upload ảnh sản phẩm qua admin (BFF). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-media.e2e.mjs
 *
 * Kiểm: form multipart (không JS) → BFF bóc file → forward byte thô tới seller →
 * seller sniff magic byte + re-encode WebP. Ảnh hiện lại, xoá được; chặn file giả
 * dạng ảnh, CSRF, và cô lập chéo shop.
 */
import zlib from 'node:zlib';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const OS = 'https://seller.localtest'; // gọi thẳng seller (đường dọn ảnh) chứ không qua BFF
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
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
const RANDOM_UUID = () => '00000000-0000-4000-8000-' + Date.now().toString(16).padStart(12, '0').slice(-12);

// Tạo PNG 1x1 hợp lệ (sharp giải mã được) — không phụ thuộc base64 nhớ tay.
function makePng() {
  const crc32 = (b) => { let c = ~0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const t = Buffer.from(type, 'latin1'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2; // 1x1, 8-bit, RGB
  const idat = zlib.deflateSync(Buffer.from([0, 255, 0, 0])); // filter 0 + pixel đỏ
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = makePng();

async function rq(base, method, path, { body, cookie, origin } = {}) {
  const h = {};
  if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
async function adm(method, path, { cookie, origin, form } = {}) {
  const h = {};
  if (form !== undefined) h['content-type'] = 'application/x-www-form-urlencoded';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(ADMIN + path, { method, headers: h, redirect: 'manual', body: form !== undefined ? new URLSearchParams(form).toString() : undefined });
  return { status: r.status, location: r.headers.get('location'), body: await r.text() };
}
// Upload multipart (fetch tự đặt boundary). Không set origin = mô phỏng CSRF.
async function admUpload(path, { cookie, origin, bytes, type, filename } = {}) {
  const fd = new FormData();
  if (bytes) fd.append('image', new Blob([bytes], { type: type ?? 'application/octet-stream' }), filename ?? 'file.bin');
  const h = {};
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(ADMIN + path, { method: 'POST', headers: h, body: fd, redirect: 'manual' });
  return { status: r.status, location: r.headers.get('location'), body: await r.text() };
}
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;
const sget = (shopId, cookie, path) => rq(SELLER, 'GET', `/shops/${shopId}${path}`, { cookie });
const pidFrom = (loc) => /\/products\/([0-9a-f-]{36})$/.exec(loc ?? '')?.[1] ?? null;

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
  // A6: mfa/verify ROTATE token → lấy cookie mới
  cookie = ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA })).sc) ?? cookie;
  return cookie;
}
async function makeShopOwner(staffCookie, slug) {
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, email, password, cookie: await login(email, password) };
}

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `mA-${uniq()}`);
  const Bo = await makeShopOwner(staff, `mB-${uniq()}`);
  let r = await adm('POST', `/shops/${A.shopId}/products`, { cookie: A.cookie, origin: OADM, form: { title: 'SP có ảnh', slug: `sp-anh-${uniq()}`, price_vnd: '990000', status: 'draft', sku: `IMG-${uniq()}`, variant_price_vnd: '990000' } });
  const pid = pidFrom(r.location);
  const M = (p) => `/shops/${A.shopId}/products/${pid}${p}`;
  pid ? ok('dựng shop + sản phẩm') : bad('không tạo được sản phẩm', r.location);

  // ── 1. Upload ảnh hợp lệ ───────────────────────────────────────────────────
  sect('1. Upload ảnh');
  r = await admUpload(M('/media'), { cookie: A.cookie, origin: OADM, bytes: PNG, type: 'image/png', filename: 'anh.png' });
  let media = (await sget(A.shopId, A.cookie, `/products/${pid}/media`)).json.media;
  r.status === 303 && media.length === 1 && media[0].status === 'ready' && media[0].url
    ? ok('upload PNG → 303, seller lưu 1 ảnh status ready (đã re-encode WebP)') : bad('upload ảnh lỗi', `${r.status} ${JSON.stringify(media)}`);

  r = await adm('GET', M(''), { cookie: A.cookie });
  r.body.includes('<img') && r.body.includes('/media-public/') ? ok('chi tiết SP hiện thẻ <img> từ CDN') : bad('chi tiết không hiện ảnh', r.body.slice(0, 200));

  // ── 2. Chặn file giả dạng ảnh ──────────────────────────────────────────────
  sect('2. Chặn file không phải ảnh');
  r = await admUpload(M('/media'), { cookie: A.cookie, origin: OADM, bytes: Buffer.from('day khong phai anh, chi la text thoi'), type: 'image/png', filename: 'gia.png' });
  media = (await sget(A.shopId, A.cookie, `/products/${pid}/media`)).json.media;
  r.status >= 400 && /ảnh/.test(r.body) && media.length === 1 ? ok('file text đội lốt .png → lỗi, không thêm ảnh') : bad('nhận file giả dạng ảnh', `${r.status} n=${media.length}`);

  r = await admUpload(M('/media'), { cookie: A.cookie, origin: OADM }); // không kèm file
  r.status >= 400 && /ảnh/.test(r.body) ? ok('không chọn file → báo lỗi') : bad('upload rỗng không báo lỗi', String(r.status));

  // >10MB: phải trả TRANG LỖI (không destroy socket → không ECONNRESET). Nếu bug cũ còn,
  // admUpload sẽ throw ECONNRESET và test đỏ ở đây.
  let big;
  try { big = await admUpload(M('/media'), { cookie: A.cookie, origin: OADM, bytes: Buffer.alloc(11 * 1024 * 1024, 0x41), type: 'image/png', filename: 'to.png' }); }
  catch (e) { big = { status: 0, body: 'ECONNRESET: ' + e.message }; }
  big.status >= 400 && /lớn/.test(big.body) ? ok('ảnh >10MB → trang lỗi thân thiện (socket không bị reset)') : bad('413 không trả được trang lỗi', `${big.status} ${big.body.slice(0, 80)}`);

  // ── 3. Xoá ảnh ─────────────────────────────────────────────────────────────
  sect('3. Xoá ảnh');
  const mid = media[0].id;
  r = await adm('POST', M(`/media/${mid}/delete`), { cookie: A.cookie, origin: OADM });
  media = (await sget(A.shopId, A.cookie, `/products/${pid}/media`)).json.media;
  r.status === 303 && media.length === 0 ? ok('xoá ảnh → 303, không còn ảnh') : bad('xoá ảnh lỗi', `${r.status} n=${media.length}`);

  // ── 4. CSRF + cô lập chéo shop ─────────────────────────────────────────────
  sect('4. CSRF & cô lập');
  r = await admUpload(M('/media'), { cookie: A.cookie, bytes: PNG, type: 'image/png', filename: 'x.png' }); // KHÔNG Origin
  const nAfter = (await sget(A.shopId, A.cookie, `/products/${pid}/media`)).json.media.length;
  r.status === 403 && nAfter === 0 ? ok('upload không Origin → 403 (CSRF), không thêm ảnh') : bad('upload thiếu Origin không bị chặn', `${r.status} n=${nAfter}`);

  r = await admUpload(`/shops/${Bo.shopId}/products/${RANDOM_UUID()}/media`, { cookie: A.cookie, origin: OADM, bytes: PNG, type: 'image/png', filename: 'x.png' });
  r.status === 403 ? ok('upload vào shop B → 403 (cô lập chéo shop)') : bad('rò upload chéo shop', String(r.status));

  // ── 5. Sắp thứ tự & ảnh đại diện ───────────────────────────────────────────
  sect('5. Thứ tự & ảnh đại diện');
  await admUpload(M('/media'), { cookie: A.cookie, origin: OADM, bytes: PNG, type: 'image/png', filename: 'a.png' });
  await admUpload(M('/media'), { cookie: A.cookie, origin: OADM, bytes: PNG, type: 'image/png', filename: 'b.png' });
  let mm = (await sget(A.shopId, A.cookie, `/products/${pid}/media`)).json.media;
  const okOrder = mm.length === 2 && mm[0].position === 0 && mm[1].position === 1;
  okOrder ? ok('upload 2 ảnh → position 0,1 (ảnh đầu = đại diện)') : bad('thứ tự upload sai', JSON.stringify(mm.map((m) => m.position)));
  const [m0, m1] = mm;
  r = await adm('POST', M(`/media/${m1.id}/primary`), { cookie: A.cookie, origin: OADM });
  mm = (await sget(A.shopId, A.cookie, `/products/${pid}/media`)).json.media;
  r.status === 303 && mm[0].id === m1.id ? ok('★ đặt ảnh 2 làm ảnh chính → lên đầu') : bad('set primary lỗi', `${r.status} ${mm[0].id === m1.id}`);
  r = await adm('GET', M(''), { cookie: A.cookie });
  /Ảnh chính/.test(r.body) ? ok('chi tiết SP đánh dấu “Ảnh chính”') : bad('không có nhãn ảnh chính', '');
  r = await adm('POST', M(`/media/${m1.id}/movedown`), { cookie: A.cookie, origin: OADM });
  mm = (await sget(A.shopId, A.cookie, `/products/${pid}/media`)).json.media;
  r.status === 303 && mm[0].id === m0.id ? ok('→ đẩy ảnh chính xuống → ảnh kia lên đầu') : bad('movedown lỗi', String(r.status));
  // reorder không phải hoán vị đúng → 422 (không lén thêm/bớt)
  r = await adm('POST', M(`/media/${RANDOM_UUID()}/moveup`), { cookie: A.cookie, origin: OADM });
  r.status === 303 ? ok('move ảnh không tồn tại → no-op (303)') : bad('move id lạ lỗi', String(r.status));

  // ── 6. Dọn ảnh trưng bày không dùng ────────────────────────────────────────
  //
  // Ảnh banner/logo/nội dung/danh mục không có dòng nào trong DB nên object cũ nằm lại
  // kho vĩnh viễn khi bị thay. Đường dọn này XOÁ TỆP, nên ca quan trọng nhất ở đây
  // KHÔNG phải "nó có xoá không" mà là "nó có chừa ảnh đang dùng ra không".
  //
  // Container dev đặt MEDIA_GC_GRACE_HOURS=0 để chạy được nhánh xoá thật; luật ân hạn
  // 48 giờ được kiểm riêng ở apps/seller/test/media-gc.test.js (e2e không chờ 48h được).
  sect('6. Dọn ảnh trưng bày không dùng');
  const upBanner = async () => (await (await fetch(`${SELLER}/shops/${A.shopId}/banner-image`, {
    method: 'POST', headers: { 'content-type': 'image/png', origin: OS, cookie: `__Host-session=${A.cookie}` }, body: PNG,
  })).json()).key;
  const keptKey = await upBanner();      // sẽ được GẮN vào layout → phải giữ
  const orphanKey = await upBanner();    // không gắn vào đâu → được xoá
  await rq(SELLER, 'PUT', `/shops/${A.shopId}/theme`, {
    cookie: A.cookie, origin: OS,
    body: { tokens: {}, layout: [{ section: 'hero', props: { slides: [{ image_key: keptKey, headline: 'X' }] } }, { section: 'footer', props: {} }] },
  });
  const unused = async () => (await rq(SELLER, 'GET', `/shops/${A.shopId}/media/unused`, { cookie: A.cookie })).json;
  let u = await unused();
  const keys = (u?.items ?? []).map((i) => i.key);
  (keys.includes(orphanKey) && !keys.includes(keptKey))
    ? ok('liệt kê ĐÚNG: ảnh mồ côi có tên, ảnh đang dùng trong layout thì KHÔNG')
    : bad('liệt kê sai', `kept=${keys.includes(keptKey)} orphan=${keys.includes(orphanKey)}`);

  // Ảnh SẢN PHẨM (không tiền tố) không bao giờ vào diện dọn, dù có gắn vào đâu hay không.
  const prodKeys = (await sget(A.shopId, A.cookie, `/products/${pid}/media`)).json.media.map((m) => m.url.split('/media-public/')[1]);
  prodKeys.length && !prodKeys.some((k) => keys.includes(k))
    ? ok('ảnh sản phẩm KHÔNG nằm trong diện dọn (vòng đời của bảng media)') : bad('ảnh sản phẩm lọt vào diện xoá');

  // Gửi lên key của ảnh ĐANG DÙNG: server tính lại, không được xoá theo lời client.
  let d = await rq(SELLER, 'POST', `/shops/${A.shopId}/media/unused/delete`, { cookie: A.cookie, origin: OS, body: { keys: [keptKey] } });
  const stillThere = await fetch(`http://minio:9000/media-public/${keptKey}`).then((x) => x.status).catch(() => 0);
  (d.status === 200 && d.json.deleted === 0 && stillThere === 200)
    ? ok('client đòi xoá ảnh ĐANG DÙNG → server tính lại và từ chối (deleted 0)')
    : bad('xoá theo lời client', `deleted=${d.json?.deleted} http=${stillThere}`);

  // Xoá thật ảnh mồ côi.
  d = await rq(SELLER, 'POST', `/shops/${A.shopId}/media/unused/delete`, { cookie: A.cookie, origin: OS, body: {} });
  const orphanGone = await fetch(`http://minio:9000/media-public/${orphanKey}`).then((x) => x.status).catch(() => 0);
  const keptAlive = await fetch(`http://minio:9000/media-public/${keptKey}`).then((x) => x.status).catch(() => 0);
  (d.status === 200 && d.json.deleted >= 1 && orphanGone === 404 && keptAlive === 200)
    ? ok('xoá → ảnh mồ côi biến mất khỏi kho, ảnh đang dùng còn nguyên')
    : bad('xoá sai', `deleted=${d.json?.deleted} orphan=${orphanGone} kept=${keptAlive}`);

  u = await unused();
  u?.total === 0 ? ok('dọn xong → danh sách rỗng') : bad('còn sót', JSON.stringify(u?.total));

  // Cô lập chéo shop. seller trả 404 chứ không 403 — CÓ CHỦ Ý (server.js: "không xác
  // nhận tồn tại"), nên ca này kiểm 404. Bản đầu tôi kỳ vọng 403 và báo đỏ oan.
  const cross = await rq(SELLER, 'GET', `/shops/${Bo.shopId}/media/unused`, { cookie: A.cookie });
  cross.status === 404 ? ok('chủ shop A xem kho ảnh shop B → 404 (không xác nhận tồn tại)') : bad('rò kho ảnh chéo shop', String(cross.status));

  // ── 7. Màn hình dọn ảnh: HAI BƯỚC, không cho xoá mù ────────────────────────
  // Nút xoá KHÔNG được phép có mặt trước khi người dùng đã nhìn thấy danh sách. Đây là
  // ràng buộc về cách trình bày nhưng nó bảo vệ dữ liệu, nên phải có ca giữ.
  sect('7. Màn hình dọn ảnh (2 bước)');
  await upBanner(); // dựng lại một ảnh mồ côi để có gì mà dọn
  const SET = `/shops/${A.shopId}/settings`;
  r = await adm('GET', SET, { cookie: A.cookie });
  (r.status === 200 && r.body.includes('Kiểm tra ảnh không dùng') && !/Xoá \d+ ảnh này/.test(r.body))
    ? ok('vào trang: chỉ có nút "Kiểm tra", CHƯA có nút xoá') : bad('nút xoá hiện quá sớm', String(r.status));
  r = await adm('POST', `${SET}/unused-images`, { cookie: A.cookie, origin: OADM, form: {} });
  (r.status === 200 && /ảnh không còn được dùng/.test(r.body) && /Xoá \d+ ảnh này/.test(r.body))
    ? ok('bấm Kiểm tra → hiện số lượng + ảnh + nút xoá') : bad('kiểm tra không ra danh sách', r.body.slice(0, 200));
  r = await adm('POST', `${SET}/unused-images/delete`, { cookie: A.cookie, origin: OADM, form: {} });
  (r.status === 200 && /Đã xoá \d+ ảnh/.test(r.body))
    ? ok('bấm Xoá → báo đã xoá bao nhiêu, giải phóng bao nhiêu') : bad('xoá qua UI lỗi', r.body.slice(0, 200));

  sect('8. Tạo sản phẩm KÈM ẢNH ngay lần đầu (không phải bước riêng)');
  // Form thêm SP trước đây không có ô ảnh: chủ shop tạo xong mới phát hiện phải vào trang
  // chi tiết tải ảnh — một sản phẩm không ảnh thì khách không bấm vào. Nay form là
  // multipart và ảnh đi cùng lượt tạo.
  let newP = await fetch(`${ADMIN}/shops/${A.shopId}/products/new`, { headers: { cookie: `__Host-session=${A.cookie}` } });
  const newHtml = await newP.text();
  // Ô file PHẢI nằm TRONG form và form phải có enctype — thiếu enctype thì trình duyệt gửi
  // đúng TÊN TỆP dưới dạng text, không có byte nào, và mọi thứ vẫn "thành công".
  const iForm = newHtml.indexOf('enctype="multipart/form-data"');
  const iFile = newHtml.indexOf('name="image"', iForm);
  const between = iForm > 0 && iFile > iForm ? newHtml.slice(iForm, iFile) : 'x</form>';
  (iForm > 0 && iFile > iForm && !between.includes('</form>'))
    ? ok('form thêm SP có enctype multipart + ô ảnh nằm trong form') : bad('form thêm SP thiếu enctype/ô ảnh ngoài form', `iForm=${iForm} iFile=${iFile}`);

  const fd = new FormData();
  fd.append('title', 'Trà đào cam sả');
  fd.append('price_vnd', '45000');
  fd.append('stock', '12');
  fd.append('status', 'active');
  fd.append('image', new Blob([PNG], { type: 'image/png' }), 'a.png');
  fd.append('image', new Blob([PNG], { type: 'image/png' }), 'b.png');
  const cr = await fetch(`${ADMIN}/shops/${A.shopId}/products`, {
    method: 'POST', headers: { cookie: `__Host-session=${A.cookie}`, origin: OADM }, body: fd, redirect: 'manual',
  });
  const newPid = pidFrom(cr.headers.get('location'));
  cr.status === 303 && newPid ? ok('tạo SP kèm 2 ảnh trong MỘT lượt gửi → 303') : bad('tạo SP kèm ảnh lỗi', `${cr.status} ${cr.headers.get('location')}`);
  const mNew = (await sget(A.shopId, A.cookie, `/products/${newPid}/media`)).json?.media ?? [];
  mNew.length === 2 && mNew.every((x) => x.status === 'ready')
    ? ok('2 ảnh đã vào kho ảnh của SP, status ready') : bad('ảnh không vào theo SP', JSON.stringify(mNew));
  const st = (await owner.query(
    `SELECT COALESCE(il.on_hand,0) n FROM variants v LEFT JOIN inventory_levels il ON il.variant_id=v.id WHERE v.product_id=$1`, [newPid])).rows[0];
  Number(st?.n) === 12 ? ok('tồn ban đầu 12 vẫn ghi đúng khi form là multipart') : bad('multipart làm rơi trường tồn', JSON.stringify(st));

  // Ảnh HỎNG không được huỷ sản phẩm: mất cả công gõ vì một tệp sai là phạt quá nặng.
  const fd2 = new FormData();
  fd2.append('title', 'Sinh tố bơ');
  fd2.append('price_vnd', '40000');
  fd2.append('image', new Blob([Buffer.from('khong phai anh')], { type: 'image/png' }), 'gia.png');
  const cr2 = await fetch(`${ADMIN}/shops/${A.shopId}/products`, {
    method: 'POST', headers: { cookie: `__Host-session=${A.cookie}`, origin: OADM }, body: fd2, redirect: 'manual',
  });
  const body2 = await cr2.text();
  const madeIt = (await owner.query(`SELECT id FROM products WHERE shop_id=$1 AND title='Sinh tố bơ'`, [A.shopId])).rows[0];
  // 409 là mã productDetail dùng cho MỌI thông báo lỗi trên trang chi tiết — điều quan
  // trọng ở đây là SẢN PHẨM VẪN CÒN và người dùng được dẫn tới đúng trang có ô tải lại.
  cr2.status === 409 && madeIt && /chỉ tải được 0\/1 ảnh/.test(body2)
    ? ok('ảnh hỏng → SP VẪN được tạo, mở trang chi tiết báo rõ ảnh không vào') : bad('ảnh hỏng làm mất sản phẩm', `${cr2.status} sp=${!!madeIt}`);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((err) => { console.error('admin media e2e lỗi:', err); process.exit(2); });
