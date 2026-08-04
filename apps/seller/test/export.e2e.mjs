/**
 * End-to-end xuất dữ liệu (A4). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/export.e2e.mjs
 *
 * Gate: tạo bản xuất = owner + step-up; tải = owner + token còn hạn. Kiểm:
 *   - Chưa step-up → 403. Non-owner (admin) → 403 (cả tạo lẫn tải).
 *   - Owner step-up → ZIP hợp lệ (unzip được), đủ CSV, có dữ liệu đơn/khách, KHÔNG lộ bí mật.
 *   - Token sai/hết hạn/khác shop → 404 (RLS giấu).
 */
import http from 'node:http';
import zlib from 'node:zlib';
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
// Tải nhị phân: giữ nguyên bytes + header.
async function rqBin(path, { cookie } = {}) {
  const h = {}; if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(SELLER + path, { method: 'GET', headers: h });
  const ab = await r.arrayBuffer();
  return { status: r.status, bytes: Buffer.from(ab), contentType: r.headers.get('content-type'), disposition: r.headers.get('content-disposition') };
}
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;
const stepUp = (cookie, password) => rq(AUTH, 'POST', '/auth/step-up', { body: { password }, cookie, origin: OA });

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

// Đọc ZIP tối thiểu: quét local file header (PK\x03\x04), inflate mỗi entry → {name: text}.
function readZip(bufr) {
  const files = {};
  let o = 0;
  while (o + 4 <= bufr.length && bufr.readUInt32LE(o) === 0x04034b50) {
    const compSize = bufr.readUInt32LE(o + 18);
    const nameLen = bufr.readUInt16LE(o + 26);
    const extraLen = bufr.readUInt16LE(o + 28);
    const name = bufr.slice(o + 30, o + 30 + nameLen).toString('utf8');
    const dataStart = o + 30 + nameLen + extraLen;
    const comp = bufr.slice(dataStart, dataStart + compSize);
    files[name] = zlib.inflateRawSync(comp).toString('utf8');
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
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, slug, host: `${slug}.nentang.vn`, email, password, cookie: await login(email, password) };
}
async function addAdmin(shop) {
  await stepUp(shop.cookie, shop.password);
  const email = `adm-${uniq()}@shop.vn`, password = 'admin passphrase strong';
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/members/invite`, { body: { email, role: 'admin' }, cookie: shop.cookie, origin: OS });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { email, password, cookie: await login(email, password) };
}
async function setupProduct(shop, price, stock) {
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/products`, {
    body: { title: `=1+2 Áo thử ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `S-${uniq()}`, price_vnd: price }] }, cookie: shop.cookie, origin: OS });
  const detail = await rq(SELLER, 'GET', `/shops/${shop.shopId}/products/${r.json.id}`, { cookie: shop.cookie });
  const vid = detail.json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${shop.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: shop.cookie, origin: OS });
  return vid;
}
async function placeCodOrder(shop, vid, email) {
  const cart = (await co(shop.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 2 } })).cartToken;
  const r = await co(shop.host, 'POST', '/checkout', { body: { customer: { name: 'Nguyễn Khách', phone: '0901234567', email }, address: { line: 'Số 1 Hà Nội' }, payment_method: 'cod' }, cartToken: cart, idemKey: `k-${uniq()}` });
  return r.json?.order_number;
}

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `expa-${uniq()}`);
  const vid = await setupProduct(A, 250000, 10);
  const buyerEmail = `buyer-${uniq()}@kh.vn`;
  const orderNum = await placeCodOrder(A, vid, buyerEmail);
  orderNum ? ok(`chuẩn bị: sản phẩm + đơn #${orderNum} (COD, có email khách)`) : bad('không tạo được đơn nền');

  // ── 1. Gate: chưa step-up → 403 ────────────────────────────────────────────
  sect('1. Tạo bản xuất đòi step-up');
  let r = await rq(SELLER, 'POST', `/shops/${A.shopId}/export`, { body: {}, cookie: A.cookie, origin: OS });
  r.status === 403 && r.json?.step_up_required ? ok('owner chưa step-up → 403 step_up_required') : bad('xuất được khi chưa step-up', r.raw);

  // ── 2. Owner step-up → tạo bản xuất ────────────────────────────────────────
  sect('2. Owner step-up → tạo bản xuất');
  (await stepUp(A.cookie, A.password)).status === 200 ? ok('step-up owner') : bad('step-up lỗi');
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/export`, { body: {}, cookie: A.cookie, origin: OS });
  const token = r.json?.token;
  r.status === 200 && token && r.json?.counts?.orders >= 1 ? ok(`tạo bản xuất → token + counts (orders=${r.json.counts.orders}, products=${r.json.counts.products})`) : bad('tạo bản xuất lỗi', r.raw);
  r.json?.expires_in > 0 ? ok(`có expires_in=${r.json.expires_in}s`) : bad('thiếu expires_in');

  // ── 3. Tải ZIP hợp lệ + nội dung ───────────────────────────────────────────
  sect('3. Tải ZIP hợp lệ');
  let d = await rqBin(`/shops/${A.shopId}/export/download?token=${encodeURIComponent(token)}`, { cookie: A.cookie });
  d.status === 200 && d.contentType === 'application/zip' ? ok('tải → 200 application/zip') : bad('tải lỗi', `${d.status} ${d.contentType}`);
  /attachment; filename=/.test(d.disposition ?? '') ? ok(`Content-Disposition attachment (${d.disposition})`) : bad('thiếu attachment disposition', d.disposition);
  d.bytes.readUInt32LE(0) === 0x04034b50 ? ok('bytes bắt đầu bằng chữ ký ZIP (PK\\x03\\x04)') : bad('không phải ZIP', d.bytes.slice(0, 4).toString('hex'));

  let files = {};
  try { files = readZip(d.bytes); ok(`unzip được ${Object.keys(files).length} tệp: ${Object.keys(files).join(', ')}`); } catch (e) { bad('không unzip được ZIP', e.message); }
  const need = ['products.csv', 'variants.csv', 'orders.csv', 'order_lines.csv', 'customers.csv', 'media_manifest.csv', 'README.txt'];
  need.every((n) => n in files) ? ok('đủ 7 tệp mong đợi') : bad('thiếu tệp', need.filter((n) => !(n in files)).join(','));
  (files['orders.csv'] ?? '').includes(buyerEmail) ? ok('orders.csv chứa email khách (dữ liệu thật)') : bad('orders.csv thiếu dữ liệu đơn', (files['orders.csv'] ?? '').slice(0, 120));
  (files['customers.csv'] ?? '').includes(buyerEmail) ? ok('customers.csv suy ra khách từ đơn') : bad('customers.csv thiếu khách');
  (files['products.csv'] ?? '').startsWith('﻿') ? ok('CSV có BOM UTF-8 (Excel đọc đúng tiếng Việt)') : bad('CSV thiếu BOM');
  // Chống formula injection: tiêu đề sản phẩm bắt đầu bằng "=1+2" → phải bị chèn ' đứng đầu.
  // Ô đã vô hiệu = `'=1+2...`; KHÔNG được có ô thô field-leading =1+2 (đầu dòng hoặc sau dấu phẩy).
  const prod = files['products.csv'] ?? '';
  (prod.includes("'=1+2") && !/(^|[\r\n,])=1\+2/.test(prod)) ? ok('CSV vô hiệu formula injection (chèn \' trước =1+2)') : bad('CSV để lọt =1+2 field-leading (formula injection)', prod.slice(0, 160));
  // Review fix: thời gian ISO-8601 UTC (không phải String(Date) dài dòng theo TZ container).
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/.test(files['orders.csv'] ?? '') ? ok('created_at dạng ISO-8601 UTC') : bad('thời gian không ISO', (files['orders.csv'] ?? '').slice(0, 140));
  // Review fix: shipping_address giữ trọn (địa chỉ đơn có "Số 1 Hà Nội", không rớt/không [object Object]).
  (files['orders.csv'] ?? '').includes('Số 1 Hà Nội') && !/\[object Object\]/.test(files['orders.csv'] ?? '') ? ok('shipping_address giữ trọn (không [object Object])') : bad('shipping_address mất dữ liệu', (files['orders.csv'] ?? '').slice(0, 200));

  // ── 4. KHÔNG lộ bí mật ─────────────────────────────────────────────────────
  sect('4. Không lộ bí mật');
  const all = Object.values(files).join('\n');
  !/lookup_token_hash|token_hash|original_key/.test(all) ? ok('không lộ cột bí mật (lookup_token_hash/token_hash/original_key)') : bad('LỘ cột bí mật trong export');

  // ── 5. Non-owner (admin) bị chặn ───────────────────────────────────────────
  sect('5. Non-owner bị chặn');
  const admin = await addAdmin(A);
  await stepUp(admin.cookie, admin.password); // dù step-up, admin vẫn thiếu perm 'export'
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/export`, { body: {}, cookie: admin.cookie, origin: OS });
  r.status === 403 && r.json?.required === 'export' ? ok('admin tạo bản xuất → 403 (thiếu perm export)') : bad('admin xuất được — LỖ HỔNG', r.raw);
  d = await rqBin(`/shops/${A.shopId}/export/download?token=${encodeURIComponent(token)}`, { cookie: admin.cookie });
  d.status === 403 ? ok('admin tải bản xuất → 403') : bad('admin tải được — LỖ HỔNG', String(d.status));

  // ── 6. Token sai / hết hạn / khác shop → 404 ───────────────────────────────
  sect('6. Token sai / hết hạn / khác shop');
  d = await rqBin(`/shops/${A.shopId}/export/download?token=khong-ton-tai`, { cookie: A.cookie });
  d.status === 404 ? ok('token sai → 404') : bad('token sai không 404', String(d.status));

  const B = await makeShopOwner(staff, `expb-${uniq()}`);
  d = await rqBin(`/shops/${B.shopId}/export/download?token=${encodeURIComponent(token)}`, { cookie: B.cookie });
  d.status === 404 ? ok('owner B dùng token của shop A tại shop B → 404 (RLS giấu)') : bad('token chéo shop tải được — LỖ HỔNG', String(d.status));

  // Ép hết hạn qua owner pool → RLS export_read (expires_at > now()) giấu → 404.
  const th = crypto.createHash('sha256').update(token).digest('hex');
  await owner.query(`UPDATE export_artifacts SET expires_at = now() - interval '1 hour' WHERE token_hash = $1`, [th]);
  d = await rqBin(`/shops/${A.shopId}/export/download?token=${encodeURIComponent(token)}`, { cookie: A.cookie });
  d.status === 404 ? ok('token HẾT HẠN → 404 (RLS cưỡng chế expires_at)') : bad('token hết hạn vẫn tải được — LỖ HỔNG', String(d.status));

  // KHÔNG tô màu dòng tổng kết ở đây: `B` trong hàm này là SHOP THỨ HAI (const B = await
  // makeShopOwner… ở trên), che mất hằng màu cùng tên → dòng tổng kết in ra
  // "[object Object]22 pass, 0 fail". Bộ chạy hàng loạt dò `^[0-9]+ pass` sẽ KHÔNG khớp và
  // báo bộ này ĐỎ trong khi nó xanh — đúng thứ làm hỏng luật "thiếu dòng tổng kết = ĐỎ".
  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('export e2e lỗi:', e); process.exit(2); });
