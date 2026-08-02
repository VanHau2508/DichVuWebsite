/**
 * End-to-end admin web (BFF) — TÊN MIỀN (A5). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-domains.e2e.mjs
 *
 * Kiểm luồng BFF: tab owner-only, interstitial step-up, thêm domain → hiện challenge TXT,
 * xác minh (stub DNS + worker) → trạng thái, đặt chính, gỡ, CSRF, non-owner.
 */
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const WORKER = process.env.WORKER_URL ?? 'http://worker:3080';
const DNS_STUB = process.env.DNS_STUB_URL ?? 'http://dns-stub:8600';
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
const setTxt = (name, txt) => fetch(`${DNS_STUB}/set`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, txt }) });
const setA = (name, a) => fetch(`${DNS_STUB}/set`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, a }) });
const setCname = (name, cname) => fetch(`${DNS_STUB}/set`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, cname }) });
const PIP = process.env.PLATFORM_IP_EXPECT ?? '127.0.0.1';
const verifySweep = () => fetch(`${WORKER}/internal/verify-sweep`, { method: 'POST' });

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
  return { shopId, slug, email, password, cookie: await login(email, password) };
}
async function addAdmin(shop) {
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: shop.password }, cookie: shop.cookie, origin: OA });
  const email = `adm-${uniq()}@shop.vn`, password = 'admin passphrase strong';
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/members/invite`, { body: { email, role: 'admin' }, cookie: shop.cookie, origin: OS });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { email, password, cookie: await login(email, password) };
}

async function main() {
  await fetch(`${DNS_STUB}/clear`, { method: 'POST' });
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `admd-${uniq()}`);
  ok('chuẩn bị: owner + shop');

  // ── 1. Trang tên miền owner-only + interstitial ────────────────────────────
  sect('1. Trang tên miền + interstitial step-up');
  let r = await adm('GET', `/shops/${A.shopId}/domains`, { cookie: A.cookie });
  r.status === 200 && /Thêm tên miền/.test(r.body) && /Tên miền/.test(r.body) ? ok('owner thấy trang + form thêm') : bad('trang domain sai', r.body.slice(0, 160));

  const host = `bff-${uniq()}.example.com`;
  r = await adm('POST', `/shops/${A.shopId}/domains`, { cookie: A.cookie, origin: OADM, form: { hostname: host } });
  r.status === 200 && /Xác nhận mật khẩu/.test(r.body) && /domains\/step-up/.test(r.body) ? ok('thêm chưa step-up → interstitial') : bad('không hiện interstitial', r.body.slice(0, 160));
  r = await adm('POST', `/shops/${A.shopId}/domains/step-up`, { cookie: A.cookie, origin: OADM, form: { __action: 'add', hostname: host, password: 'sai' } });
  r.status === 401 && /Mật khẩu không đúng/.test(r.body) ? ok('mật khẩu sai → 401') : bad('mật khẩu sai qua', String(r.status));

  // ── 2. Thêm domain → hiện challenge TXT ────────────────────────────────────
  sect('2. Thêm domain → challenge TXT');
  r = await adm('POST', `/shops/${A.shopId}/domains/step-up`, { cookie: A.cookie, origin: OADM, form: { __action: 'add', hostname: host, password: A.password } });
  r.status === 200 && r.body.includes(host) && /_nentang-verify\./.test(r.body) && /Chờ xác minh/.test(r.body) ? ok('thêm domain → hiện challenge TXT + trạng thái chờ') : bad('không hiện challenge', r.body.slice(0, 240));
  // Lấy token challenge từ DB để đăng ký TXT (BFF không lộ token ra ngoài HTML? có — trong <code>).
  const dom = (await owner.query('SELECT id, verification_token FROM domains WHERE hostname=$1', [host])).rows[0];

  // ── 2b. Hướng dẫn LÀM THEO ĐƯỢC: bản ghi A có IP thật + nút "Kiểm tra ngay" ─
  // Trước đợt này màn hình bảo "trỏ về IP nền tảng" mà không chỗ nào nói IP đó là gì, rồi
  // im lặng chờ. Khách đặt sai một bản ghi là ngồi đoán → nhắn hỗ trợ. Đây đúng là chỗ
  // quyết định "khách tự làm được" hay không, nên kiểm bằng HTML thật chứ không chỉ API.
  sect('2b. Bản ghi A có IP thật + nút "Kiểm tra ngay"');
  r = await adm('GET', `/shops/${A.shopId}/domains`, { cookie: A.cookie });
  r.body.includes(PIP) && /<code>A<\/code>/.test(r.body)
    ? ok(`trang hiện bản ghi A kèm IP thật (${PIP}) để khách chép`) : bad('không hiện IP nền tảng', r.body.slice(0, 200));
  new RegExp(`action="/shops/${A.shopId}/domains/${dom.id}/check"`).test(r.body) && /Kiểm tra ngay/.test(r.body)
    ? ok('có nút "Kiểm tra ngay" trỏ đúng tên miền') : bad('thiếu nút kiểm tra', r.body.slice(0, 200));

  // Chưa đặt DNS → phải nói thiếu gì, ngay trên trang.
  r = await adm('POST', `/shops/${A.shopId}/domains/${dom.id}/check`, { cookie: A.cookie, origin: OADM });
  r.status === 200 && /✗ Bản ghi A/.test(r.body) && /✗ Bản ghi TXT/.test(r.body) && r.body.includes(PIP)
    ? ok('bấm kiểm tra khi chưa đặt DNS → trang nói thiếu CẢ HAI bản ghi') : bad('kết quả kiểm tra rỗng', r.body.slice(0, 300));

  // Trỏ sai IP → trang phải nói ĐANG trỏ về đâu (khách sửa được ngay).
  await setA(host, '9.9.9.9');
  r = await adm('POST', `/shops/${A.shopId}/domains/${dom.id}/check`, { cookie: A.cookie, origin: OADM });
  /đang trỏ về 9\.9\.9\.9/.test(r.body) ? ok('trỏ sai IP → trang nói rõ "đang trỏ về 9.9.9.9"') : bad('không nói đang trỏ đâu', r.body.slice(0, 300));

  // Đặt đúng cả hai → trang xác nhận, khách khỏi bấm lại liên tục.
  await setA(host, PIP);
  await setTxt(`_nentang-verify.${host}`, dom.verification_token);
  r = await adm('POST', `/shops/${A.shopId}/domains/${dom.id}/check`, { cookie: A.cookie, origin: OADM });
  /✓ Bản ghi A/.test(r.body) && /✓ Bản ghi TXT/.test(r.body) && /trong vòng 1 phút/.test(r.body)
    ? ok('đặt đúng cả hai → trang báo sẽ tự kích hoạt trong 1 phút') : bad('không xác nhận khi đã đúng', r.body.slice(0, 300));
  r = await adm('POST', `/shops/${A.shopId}/domains/${dom.id}/check`, { cookie: A.cookie }); // KHÔNG Origin
  r.status === 403 ? ok('kiểm tra không Origin → 403 (CSRF)') : bad('CSRF không chặn nút kiểm tra', String(r.status));

  // ── 2c. Tên miền CON: hướng dẫn MỘT bản ghi CNAME, A+TXT lùi vào <details> ──
  // Đây là điểm của cả đợt: khách dùng tên miền con chỉ phải làm MỘT việc, ở MỘT chỗ.
  sect('2c. Tên miền con → hướng dẫn 1 bản ghi CNAME');
  const hSub = `sub-${uniq()}.example.com`;
  await adm('POST', `/shops/${A.shopId}/domains/step-up`, { cookie: A.cookie, origin: OADM, form: { __action: 'add', hostname: hSub, password: A.password } });
  r = await adm('GET', `/shops/${A.shopId}/domains`, { cookie: A.cookie });
  const target = `${A.slug}.nentang.vn`;
  r.body.includes(`<code>CNAME</code>`) && r.body.includes(target)
    ? ok(`hiện bản ghi CNAME → ${target}`) : bad('không hiện hướng dẫn CNAME', r.body.slice(0, 300));
  /Thêm <strong>một<\/strong> bản ghi/.test(r.body) && /<details/.test(r.body)
    ? ok('nói "MỘT bản ghi", cách A+TXT lùi vào mục mở-ra-xem') : bad('vẫn bắt khách làm 2 bản ghi', r.body.slice(0, 300));

  const subId = (await owner.query('SELECT id FROM domains WHERE hostname=$1', [hSub])).rows[0].id;
  await setCname(hSub, target);
  r = await adm('POST', `/shops/${A.shopId}/domains/${subId}/check`, { cookie: A.cookie, origin: OADM });
  /✓ Bản ghi CNAME/.test(r.body) && /CNAME đã đúng/.test(r.body)
    ? ok('bấm kiểm tra → "✓ Bản ghi CNAME", báo sẽ kích hoạt') : bad('không nhận CNAME đúng trên UI', r.body.slice(0, 400));
  await verifySweep();
  r = await adm('GET', `/shops/${A.shopId}/domains`, { cookie: A.cookie });
  new RegExp(`${hSub}</strong>[^<]*<span[^>]*>Đã xác minh`).test(r.body.replace(/\s+/g, ' '))
    ? ok('sau sweep: tên miền con "Đã xác minh" — không cần bản ghi TXT nào') : bad('CNAME không dẫn tới verified trên UI', r.body.slice(0, 400));

  // ── 3. Xác minh → trạng thái "Đã xác minh" ─────────────────────────────────
  sect('3. Xác minh DNS');
  await setTxt(`_nentang-verify.${host}`, dom.verification_token);
  await verifySweep();
  r = await adm('GET', `/shops/${A.shopId}/domains`, { cookie: A.cookie });
  r.body.includes(host) && /Đã xác minh/.test(r.body) ? ok('sau verify: trang hiện "Đã xác minh"') : bad('trạng thái không đổi', r.body.slice(0, 200));

  // ── 4. Đặt tên miền chính (đã step-up trong cửa sổ) ────────────────────────
  sect('4. Đặt tên miền chính');
  r = await adm('POST', `/shops/${A.shopId}/domains/${dom.id}/primary`, { cookie: A.cookie, origin: OADM });
  r.status === 200 && /Đã đặt tên miền chính/.test(r.body) ? ok('đặt chính → OK') : bad('đặt chính lỗi', r.body.slice(0, 160));
  (await owner.query('SELECT is_primary FROM domains WHERE id=$1', [dom.id])).rows[0].is_primary === true ? ok('DB: domain là primary') : bad('DB primary sai');

  // ── 5. Non-owner + CSRF ────────────────────────────────────────────────────
  sect('5. Non-owner + CSRF');
  const admin = await addAdmin(A);
  r = await adm('GET', `/shops/${A.shopId}/domains`, { cookie: admin.cookie });
  /Chỉ.*chủ cửa hàng/.test(r.body) && !/Thêm tên miền/.test(r.body) ? ok('admin thấy "chỉ chủ", KHÔNG có form') : bad('admin thấy form domain', r.body.slice(0, 160));
  r = await adm('POST', `/shops/${A.shopId}/domains`, { cookie: A.cookie, form: { hostname: 'x.example.com' } }); // KHÔNG Origin
  r.status === 403 ? ok('POST không Origin → 403 (CSRF)') : bad('CSRF không chặn', String(r.status));

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('admin-domains e2e lỗi:', e); process.exit(2); });
