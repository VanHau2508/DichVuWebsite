/**
 * End-to-end admin web (BFF) — XUẤT DỮ LIỆU. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-export.e2e.mjs
 *
 * Kiểm luồng BFF: trang owner-only, interstitial step-up mật khẩu, tạo bản xuất, relay
 * tải NHỊ PHÂN (ZIP không hỏng), non-owner bị chặn, CSRF.
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
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
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

async function rq(base, method, path, { body, cookie, origin } = {}) {
  const h = {};
  if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
// BFF client (form urlencoded, không tự theo redirect).
async function adm(method, path, { cookie, origin, form } = {}) {
  const h = {};
  if (form !== undefined) h['content-type'] = 'application/x-www-form-urlencoded';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(ADMIN + path, { method, headers: h, redirect: 'manual', body: form !== undefined ? new URLSearchParams(form).toString() : undefined });
  return { status: r.status, location: r.headers.get('location'), body: await r.text() };
}
// BFF tải nhị phân (giữ bytes).
async function admBin(path, { cookie } = {}) {
  const h = {}; if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(ADMIN + path, { method: 'GET', headers: h, redirect: 'manual' });
  const ab = await r.arrayBuffer();
  return { status: r.status, bytes: Buffer.from(ab), contentType: r.headers.get('content-type'), disposition: r.headers.get('content-disposition') };
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
function readZip(bufr) {
  const files = {}; let o = 0;
  while (o + 4 <= bufr.length && bufr.readUInt32LE(o) === 0x04034b50) {
    const compSize = bufr.readUInt32LE(o + 18), nameLen = bufr.readUInt16LE(o + 26), extraLen = bufr.readUInt16LE(o + 28);
    const name = bufr.slice(o + 30, o + 30 + nameLen).toString('utf8');
    const dataStart = o + 30 + nameLen + extraLen;
    files[name] = zlib.inflateRawSync(bufr.slice(dataStart, dataStart + compSize)).toString('utf8');
    o = dataStart + compSize;
  }
  return files;
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
  await owner.query(`UPDATE shops SET status='active', went_live_at=now() WHERE id=$1`, [shopId]);
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, slug, host: `${slug}.nentang.vn`, email, password, cookie: await login(email, password) };
}
async function addAdmin(shop) {
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: shop.password }, cookie: shop.cookie, origin: OA });
  const email = `adm-${uniq()}@shop.vn`, password = 'admin passphrase strong';
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/members/invite`, { body: { email, role: 'admin' }, cookie: shop.cookie, origin: OS });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { email, password, cookie: await login(email, password) };
}
async function setupProduct(shop) {
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/products`, {
    body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: 250000, status: 'active', variants: [{ sku: `S-${uniq()}`, price_vnd: 250000 }] }, cookie: shop.cookie, origin: OS });
  const detail = await rq(SELLER, 'GET', `/shops/${shop.shopId}/products/${r.json.id}`, { cookie: shop.cookie });
  const vid = detail.json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${shop.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: 10, reason: 'nhập' }, cookie: shop.cookie, origin: OS });
  return vid;
}
async function placeCodOrder(shop, vid, email) {
  const cart = (await co(shop.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 1 } })).cartToken;
  await co(shop.host, 'POST', '/checkout', { body: { customer: { name: 'Khách', phone: '0901234567', email }, address: { line: 'HN' }, payment_method: 'cod' }, cartToken: cart, idemKey: `k-${uniq()}` });
}

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `axp-${uniq()}`);
  const vid = await setupProduct(A);
  const buyerEmail = `buyer-${uniq()}@kh.vn`;
  await placeCodOrder(A, vid, buyerEmail);
  ok('chuẩn bị: owner + sản phẩm + đơn COD');

  // ── 1. Trang xuất owner-only ───────────────────────────────────────────────
  // LƯU Ý: chưa step-up owner ở đây — để mục 2 kiểm được interstitial (addAdmin sẽ
  // step-up owner nên hoãn tới mục 5).
  sect('1. Trang xuất — owner thấy nút');
  let r = await adm('GET', `/shops/${A.shopId}/export`, { cookie: A.cookie });
  r.status === 200 && /Tạo bản xuất/.test(r.body) && /Xuất dữ liệu/.test(r.body) ? ok('owner thấy trang + nút "Tạo bản xuất"') : bad('trang xuất owner sai', r.body.slice(0, 160));

  // ── 2. Interstitial step-up (owner CHƯA step-up) ───────────────────────────
  sect('2. Step-up interstitial');
  r = await adm('POST', `/shops/${A.shopId}/export`, { cookie: A.cookie, origin: OADM });
  r.status === 200 && /Xác nhận mật khẩu/.test(r.body) && /export\/step-up/.test(r.body) ? ok('owner chưa step-up → interstitial mật khẩu') : bad('không hiện interstitial', r.body.slice(0, 160));

  r = await adm('POST', `/shops/${A.shopId}/export/step-up`, { cookie: A.cookie, origin: OADM, form: { password: 'sai mật khẩu' } });
  r.status === 401 && /Mật khẩu không đúng/.test(r.body) ? ok('mật khẩu sai → 401 + lỗi') : bad('mật khẩu sai không bị chặn', String(r.status));

  // ── 3. Step-up đúng → tạo bản xuất + link tải ──────────────────────────────
  sect('3. Tạo bản xuất → link tải');
  r = await adm('POST', `/shops/${A.shopId}/export/step-up`, { cookie: A.cookie, origin: OADM, form: { password: A.password } });
  const mm = /\/shops\/[^/]+\/export\/download\?token=([^"&]+)/.exec(r.body);
  r.status === 200 && /Bản xuất đã sẵn sàng/.test(r.body) && mm ? ok('step-up đúng → trang có link tải + tóm tắt') : bad('không tạo được bản xuất qua BFF', r.body.slice(0, 200));
  const token = mm ? decodeURIComponent(mm[1]) : '';

  // ── 4. Relay tải NHỊ PHÂN (ZIP không hỏng qua BFF) ─────────────────────────
  sect('4. Tải ZIP qua BFF (nhị phân)');
  let d = await admBin(`/shops/${A.shopId}/export/download?token=${encodeURIComponent(token)}`, { cookie: A.cookie });
  d.status === 200 && d.contentType === 'application/zip' ? ok('BFF tải → 200 application/zip') : bad('BFF tải lỗi', `${d.status} ${d.contentType}`);
  /attachment; filename=/.test(d.disposition ?? '') ? ok(`Content-Disposition attachment (${d.disposition})`) : bad('thiếu attachment', d.disposition);
  d.bytes.readUInt32LE(0) === 0x04034b50 ? ok('ZIP nguyên vẹn qua BFF (chữ ký PK, bytes KHÔNG hỏng)') : bad('ZIP hỏng qua BFF', d.bytes.slice(0, 8).toString('hex'));
  let files = {};
  try { files = readZip(d.bytes); } catch (e) { bad('unzip lỗi', e.message); }
  (files['orders.csv'] ?? '').includes(buyerEmail) ? ok('nội dung ZIP đúng (orders.csv có email khách)') : bad('ZIP thiếu dữ liệu');

  // ── 5. Non-owner bị chặn qua BFF ───────────────────────────────────────────
  sect('5. Non-owner bị chặn (BFF)');
  const admin = await addAdmin(A); // (addAdmin step-up owner — nên đặt sau các mục owner)
  r = await adm('GET', `/shops/${A.shopId}/export`, { cookie: admin.cookie });
  r.status === 200 && /Chỉ.*chủ cửa hàng/.test(r.body) && !/Tạo bản xuất/.test(r.body) ? ok('admin thấy "chỉ chủ cửa hàng", KHÔNG có nút') : bad('admin thấy nút xuất', r.body.slice(0, 160));
  // admin step-up rồi ép POST export → BFF forward → seller 403 → trang lỗi (không có link tải).
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: admin.password }, cookie: admin.cookie, origin: OA });
  r = await adm('POST', `/shops/${A.shopId}/export`, { cookie: admin.cookie, origin: OADM });
  !/export\/download\?token=/.test(r.body) ? ok('admin POST export → KHÔNG có link tải (seller 403)') : bad('admin xuất được qua BFF — LỖ HỔNG', r.body.slice(0, 160));
  d = await admBin(`/shops/${A.shopId}/export/download?token=${encodeURIComponent(token)}`, { cookie: admin.cookie });
  d.status !== 200 || d.contentType !== 'application/zip' ? ok(`admin tải trực tiếp → không nhận ZIP (status ${d.status})`) : bad('admin tải được ZIP — LỖ HỔNG');

  // ── 6. CSRF ────────────────────────────────────────────────────────────────
  sect('6. CSRF');
  r = await adm('POST', `/shops/${A.shopId}/export`, { cookie: A.cookie }); // KHÔNG Origin
  r.status === 403 ? ok('POST export không Origin → 403') : bad('CSRF không chặn', String(r.status));

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('admin-export e2e lỗi:', e); process.exit(2); });
