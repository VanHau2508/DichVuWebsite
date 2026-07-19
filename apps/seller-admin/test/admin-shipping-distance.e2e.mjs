/**
 * E2E ship theo km — cấu hình trong seller-admin (BFF, 0089 ship-3). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-shipping-distance.e2e.mjs
 *
 * Kiểm: trang Cài đặt render ô cấu hình ship-theo-km → lưu cấu hình distance hợp lệ → GET lại prefill
 * đúng (mode/toạ độ/phí/bán kính/hành-vi-ngoài-bán-kính) → validate mirror CHECK (distance thiếu toạ độ,
 * toạ độ ngoài VN, distance thiếu tỉnh gửi+phí liên miền) surface lỗi tiếng Việt → tắt lại về region →
 * cô lập chéo shop + CSRF không Origin.
 */
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic = 'user.invited' AND payload->>'to' = $1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${String(d).slice(0, 240)}${X}`); };
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
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, email, password, cookie: await login(email, password) };
}
// Nền hồ sơ tối thiểu hợp lệ (name bắt buộc). Trộn override để dựng từng ca.
const baseForm = (over = {}) => ({ name: 'Shop Ship KM', ship_from_province: 'Hà Nội', ship_fee_far_vnd: '50000', ...over });
const distForm = (over = {}) => baseForm({
  ship_mode: 'distance', ship_origin_lat: '21.028511', ship_origin_lng: '105.804817',
  ship_base_vnd: '15000', ship_per_km_vnd: '4000', ship_max_km: '20', ship_road_factor: '1.3',
  ship_over_max_behavior: 'region', ...over,
});
const S = (shopId) => `/shops/${shopId}/settings`;

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `shd-${uniq()}`);
  const Bo = await makeShopOwner(staff, `she-${uniq()}`);
  ok('dựng 2 shop + chủ shop');

  // ── 1. Trang Cài đặt render ô cấu hình ship-theo-km ─────────────────────────
  sect('1. Trang Cài đặt có mục ship theo km');
  let r = await adm('GET', S(A.shopId), { cookie: A.cookie });
  const hasSection = r.status === 200 && /Ship theo khoảng cách/.test(r.body)
    && /name="ship_mode" value="distance"/.test(r.body) && /name="ship_origin_lat"/.test(r.body)
    && /name="ship_max_km"/.test(r.body) && /name="ship_over_max_behavior" value="reject"/.test(r.body);
  hasSection ? ok('render đủ ô: mode/toạ độ/bán kính/hành-vi-ngoài-bán-kính') : bad('thiếu ô cấu hình', r.body.slice(0, 200));
  // Mặc định (shop mới) = region checked.
  /name="ship_mode" value="region" checked/.test(r.body) ? ok('mặc định mode = region (checked)') : bad('mặc định mode sai', r.body.match(/ship_mode[^>]*/g)?.join(' | '));

  // ── 2. Lưu cấu hình distance hợp lệ ────────────────────────────────────────
  sect('2. Lưu cấu hình ship theo km hợp lệ');
  r = await adm('POST', S(A.shopId), { cookie: A.cookie, origin: OADM, form: distForm() });
  r.status === 200 && /Đã lưu/.test(r.body) ? ok('lưu distance → 200 + thông báo đã lưu') : bad('lưu distance lỗi', `${r.status} ${r.body.slice(0, 200)}`);
  // Xác nhận DB ghi đúng (nguồn chân lý — không chỉ tin trang trả về).
  const row = (await owner.query(`SELECT ship_mode, ship_origin_lat, ship_origin_lng, ship_base_vnd, ship_per_km_vnd, ship_max_km, ship_road_factor, ship_over_max_behavior FROM shops WHERE id=$1`, [A.shopId])).rows[0];
  row.ship_mode === 'distance' && Number(row.ship_origin_lat).toFixed(4) === '21.0285' && Number(row.ship_base_vnd) === 15000
    && Number(row.ship_per_km_vnd) === 4000 && row.ship_max_km === 20 && Number(row.ship_road_factor) === 1.3 && row.ship_over_max_behavior === 'region'
    ? ok('DB shops ghi đúng mode+toạ độ+phí+bán kính+road_factor+over_max') : bad('DB sai', JSON.stringify(row));

  // ── 3. GET lại → prefill đúng ──────────────────────────────────────────────
  sect('3. Mở lại trang → prefill giá trị đã lưu');
  r = await adm('GET', S(A.shopId), { cookie: A.cookie });
  const pre = /name="ship_mode" value="distance" checked/.test(r.body)
    && /name="ship_origin_lat" value="21.028511"/.test(r.body)
    && /name="ship_base_vnd" value="15000"/.test(r.body) && /name="ship_per_km_vnd" value="4000"/.test(r.body)
    && /name="ship_max_km" value="20"/.test(r.body)
    && /name="ship_over_max_behavior" value="region" checked/.test(r.body);
  pre ? ok('prefill: distance checked + toạ độ + phí + bán kính + over_max=region checked') : bad('prefill sai', r.body.match(/ship_(mode|origin_lat|base_vnd|max_km|over_max_behavior)[^>]*/g)?.join(' | '));

  // ── 4. Validate mirror CHECK — surface lỗi tiếng Việt (KHÔNG 500) ──────────
  sect('4. Ràng buộc bật distance');
  r = await adm('POST', S(A.shopId), { cookie: A.cookie, origin: OADM, form: distForm({ ship_origin_lat: '', ship_origin_lng: '' }) });
  r.status === 400 && /toạ độ gốc/.test(r.body) ? ok('distance thiếu toạ độ → 400 + lỗi tiếng Việt') : bad('thiếu toạ độ không chặn', `${r.status} ${r.body.slice(0, 160)}`);
  r = await adm('POST', S(A.shopId), { cookie: A.cookie, origin: OADM, form: distForm({ ship_origin_lat: '48.85', ship_origin_lng: '2.35' }) }); // Paris
  r.status === 400 && /Việt Nam/.test(r.body) ? ok('toạ độ gốc ngoài VN → 400') : bad('toạ độ ngoài VN không chặn', `${r.status} ${r.body.slice(0, 160)}`);
  r = await adm('POST', S(A.shopId), { cookie: A.cookie, origin: OADM, form: distForm({ ship_from_province: '', ship_fee_far_vnd: '' }) });
  r.status === 400 && /tỉnh gửi|liên miền/.test(r.body) ? ok('distance thiếu tỉnh gửi + phí liên miền → 400 (cần bậc dự phòng)') : bad('thiếu dự phòng không chặn', `${r.status} ${r.body.slice(0, 160)}`);
  r = await adm('POST', S(A.shopId), { cookie: A.cookie, origin: OADM, form: distForm({ ship_max_km: '9999' }) });
  r.status === 400 && /trần km/.test(r.body) ? ok('bán kính > 500 → 400') : bad('bán kính rác không chặn', `${r.status} ${r.body.slice(0, 160)}`);
  // Lỗi validate KHÔNG được ghi đè DB (vẫn giữ cấu hình distance hợp lệ ở bước 2).
  const still = (await owner.query(`SELECT ship_mode, ship_max_km FROM shops WHERE id=$1`, [A.shopId])).rows[0];
  still.ship_mode === 'distance' && still.ship_max_km === 20 ? ok('POST lỗi KHÔNG đụng DB (giữ cấu hình cũ)') : bad('DB bị ghi đè khi lỗi', JSON.stringify(still));

  // ── 5. Tắt lại về region ────────────────────────────────────────────────────
  sect('5. Tắt ship theo km → về region');
  r = await adm('POST', S(A.shopId), { cookie: A.cookie, origin: OADM, form: baseForm({ ship_mode: 'region' }) });
  const back = (await owner.query(`SELECT ship_mode FROM shops WHERE id=$1`, [A.shopId])).rows[0];
  r.status === 200 && back.ship_mode === 'region' ? ok('chuyển về region → lưu OK') : bad('tắt distance lỗi', `${r.status} ${back.ship_mode}`);

  // ── 6. Cô lập chéo shop + CSRF ─────────────────────────────────────────────
  sect('6. Cô lập & CSRF');
  r = await adm('GET', S(Bo.shopId), { cookie: A.cookie });
  r.status === 403 ? ok('owner A mở cài đặt shop B → 403') : bad('rò cài đặt chéo shop', String(r.status));
  r = await adm('POST', S(A.shopId), { cookie: A.cookie, form: distForm() }); // KHÔNG Origin
  r.status === 403 ? ok('lưu không Origin → 403 (CSRF)') : bad('CSRF không chặn', String(r.status));

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((err) => { console.error('admin shipping-distance e2e lỗi:', err); process.exit(2); });
