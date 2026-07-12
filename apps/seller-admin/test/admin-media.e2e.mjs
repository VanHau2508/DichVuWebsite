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
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });

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
  await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA });
  return cookie;
}
async function makeShopOwner(staffCookie, slug) {
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: r.json.token, password }, origin: OA });
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

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((err) => { console.error('admin media e2e lỗi:', err); process.exit(2); });
