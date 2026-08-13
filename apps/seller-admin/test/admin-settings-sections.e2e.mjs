/**
 * E2E Settings Hub qua seller-admin (BFF). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-settings-sections.e2e.mjs
 *
 * Bẫy cần canh: API cũ PATCH /shops/:id coi trường vắng là rỗng. Vì vậy mỗi form
 * phải đi đúng endpoint section riêng; lưu hồ sơ không được xoá phí ship, ngưỡng
 * vận hành hoặc chính sách dữ liệu của shop.
 */

import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const OA = 'https://auth.localtest';
const OO = 'https://ops.localtest';
const OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });

let pass = 0;
let fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d = '') => {
  fail++;
  console.log(`  ${R}FAIL${X} ${m}`);
  if (d) console.log(`       ${D}${String(d).slice(0, 800)}${X}`);
};
const sect = (m) => console.log(`\n${B}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cookieOf = (setCookies) => (setCookies ?? [])
  .map((cookie) => /^__Host-session=([^;]+)/.exec(cookie)?.[1])
  .find(Boolean) ?? null;

async function rq(base, method, path, { body, cookie, origin } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = `__Host-session=${cookie}`;
  if (origin) headers.origin = origin;
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let json = null;
  try { json = raw ? JSON.parse(raw) : null; } catch {}
  return { status: response.status, json, raw, cookies: response.headers.getSetCookie() };
}

async function adm(method, path, { cookie, origin, form } = {}) {
  const headers = {};
  if (form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
  if (cookie) headers.cookie = `__Host-session=${cookie}`;
  if (origin) headers.origin = origin;
  const response = await fetch(ADMIN + path, {
    method,
    headers,
    redirect: 'manual',
    body: form === undefined ? undefined : new URLSearchParams(form).toString(),
  });
  return {
    status: response.status,
    location: response.headers.get('location'),
    body: await response.text(),
  };
}

async function inviteTokenOf(email) {
  const row = (await owner.query(
    `SELECT payload->>'accept_url' AS url
       FROM outbox
      WHERE topic = 'user.invited' AND payload->>'to' = $1
      ORDER BY id DESC LIMIT 1`,
    [email],
  )).rows[0];
  return row?.url ? new URL(row.url).searchParams.get('token') : null;
}

async function login(email, password) {
  return cookieOf((await rq(AUTH, 'POST', '/auth/login', {
    body: { email, password },
    origin: OA,
  })).cookies);
}

async function makeStaff() {
  const email = `staff-settings-ui-${uniq()}@nentang.vn`;
  const password = 'staff settings ui passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let cookie = await login(email, password);
  const enroll = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie, origin: OA });
  const key = base32Decode(enroll.json.secret);
  await rq(AUTH, 'POST', '/auth/mfa/activate', {
    cookie,
    body: { code: totp(key, {}) },
    origin: OA,
  });
  const userId = (await owner.query(`SELECT id FROM users WHERE email = $1`, [email])).rows[0].id;
  await owner.query(`INSERT INTO platform_staff (user_id, role) VALUES ($1, 'admin')`, [userId]);

  const counter = counterFor(Date.now());
  while (counterFor(Date.now()) <= counter) await sleep(1000);
  cookie = await login(email, password);
  return cookieOf((await rq(AUTH, 'POST', '/auth/mfa/verify', {
    cookie,
    body: { code: totp(key, {}) },
    origin: OA,
  })).cookies) ?? cookie;
}

async function makeShopOwner(staffCookie) {
  const slug = `settings-ui-${uniq()}`;
  const created = await rq(PLATFORM, 'POST', '/ops/shops', {
    body: { name: 'Settings UI Shop', slug, plan_code: 'platform' },
    cookie: staffCookie,
    origin: OO,
  });
  if (created.status !== 201 || !created.json?.id) {
    throw new Error(`không tạo được shop: ${created.status} ${created.raw}`);
  }
  const shopId = created.json.id;
  const email = `owner-${slug}@shop.vn`;
  const password = 'owner settings ui passphrase';
  const invited = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, {
    body: { email, role: 'owner' },
    cookie: staffCookie,
    origin: OO,
  });
  if (invited.status !== 201) throw new Error(`không mời được owner: ${invited.status} ${invited.raw}`);
  const accepted = await rq(AUTH, 'POST', '/auth/invitations/accept', {
    body: { token: await inviteTokenOf(email), password },
    origin: OA,
  });
  if (accepted.status !== 200) throw new Error(`không nhận được lời mời owner: ${accepted.status} ${accepted.raw}`);
  return { shopId, cookie: await login(email, password) };
}

async function addAdmin(staffCookie, shopId) {
  const email = `admin-settings-ui-${uniq()}@shop.vn`;
  const password = 'admin settings ui passphrase';
  const invited = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, {
    body: { email, role: 'admin' },
    cookie: staffCookie,
    origin: OO,
  });
  if (invited.status !== 201) throw new Error(`không mời được admin: ${invited.status} ${invited.raw}`);
  const accepted = await rq(AUTH, 'POST', '/auth/invitations/accept', {
    body: { token: await inviteTokenOf(email), password },
    origin: OA,
  });
  if (accepted.status !== 200) throw new Error(`không nhận được lời mời admin: ${accepted.status} ${accepted.raw}`);
  return { cookie: await login(email, password) };
}

const PROFILE_COLUMNS = ['name', 'contact_email', 'contact_phone', 'business_address'];
const SHIPPING_COLUMNS = [
  'ship_fee_vnd', 'free_ship_threshold_vnd', 'ship_fee_far_vnd',
  'ship_extra_per_500g_vnd', 'default_weight_gram', 'ship_from_province',
  'ship_mode', 'ship_origin_lat', 'ship_origin_lng', 'ship_base_vnd',
  'ship_per_km_vnd', 'ship_max_km', 'ship_road_factor', 'ship_over_max_behavior',
];
const OPERATIONS_COLUMNS = ['low_stock_threshold', 'max_pending_per_ip', 'max_pending_per_phone'];
const PRIVACY_COLUMNS = ['pii_retention_months'];
const ALL_COLUMNS = [...PROFILE_COLUMNS, ...SHIPPING_COLUMNS, ...OPERATIONS_COLUMNS, ...PRIVACY_COLUMNS];
const pick = (row, columns) => Object.fromEntries(columns.map((column) => [column, row[column]]));
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

async function snapshot(shopId) {
  const row = (await owner.query(
    `SELECT ${ALL_COLUMNS.join(', ')} FROM shops WHERE id = $1`,
    [shopId],
  )).rows[0];
  return {
    profile: pick(row, PROFILE_COLUMNS),
    shipping: pick(row, SHIPPING_COLUMNS),
    operations: pick(row, OPERATIONS_COLUMNS),
    privacy: pick(row, PRIVACY_COLUMNS),
  };
}

async function seedBaseline(shopId) {
  await owner.query(
    `UPDATE shops
        SET name = 'Baseline Settings Shop',
            contact_email = 'baseline@example.test',
            contact_phone = '0901000001',
            business_address = '1 Baseline Street',
            ship_fee_vnd = 25000,
            free_ship_threshold_vnd = 500000,
            ship_fee_far_vnd = 45000,
            ship_extra_per_500g_vnd = 7000,
            default_weight_gram = 500,
            ship_from_province = $2,
            ship_mode = 'region',
            ship_origin_lat = NULL,
            ship_origin_lng = NULL,
            ship_base_vnd = NULL,
            ship_per_km_vnd = NULL,
            ship_max_km = NULL,
            ship_road_factor = 1.3,
            ship_over_max_behavior = 'region',
            low_stock_threshold = 5,
            max_pending_per_ip = 31,
            max_pending_per_phone = 9,
            pii_retention_months = 24
      WHERE id = $1`,
    [shopId, 'Hà Nội'],
  );
}

function expectOnlySectionChanged(before, after, changedSection, label) {
  const changedWrong = ['profile', 'shipping', 'operations', 'privacy']
    .filter((name) => name !== changedSection && !equal(before[name], after[name]));
  changedWrong.length === 0
    ? ok(`${label}: các nhóm khác giữ nguyên`)
    : bad(`${label}: làm đổi nhóm không liên quan`, changedWrong.join(', '));
}

async function postSection(shopId, cookie, name, form, origin = OADM) {
  return adm('POST', `/shops/${shopId}/settings/${name}`, { cookie, origin, form });
}

async function main() {
  const staffCookie = await makeStaff();
  const shop = await makeShopOwner(staffCookie);
  const admin = await addAdmin(staffCookie, shop.shopId);
  await seedBaseline(shop.shopId);
  ok('dựng owner/admin và bốn nhóm cài đặt có giá trị phân biệt');

  const base = `/shops/${shop.shopId}`;

  sect('1. Hub có bốn form độc lập và giữ link neo cũ');
  let response = await adm('GET', `${base}/settings`, { cookie: shop.cookie });
  const actions = ['profile', 'shipping', 'operations', 'privacy'];
  const invalidActions = actions.filter((name) => {
    const action = `action="${base}/settings/${name}"`;
    return response.body.split(action).length - 1 !== 1;
  });
  response.status === 200 && invalidActions.length === 0
    ? ok('owner thấy đúng một form cho mỗi nhóm cài đặt')
    : bad('thiếu hoặc lặp form nhóm cài đặt', `${response.status} ${invalidActions.join(', ')}`);
  !response.body.includes(`action="${base}/settings"`)
    ? ok('Hub không còn render form ghi toàn bộ API cũ')
    : bad('vẫn còn form ghi toàn bộ cài đặt qua API cũ');
  response.body.includes('id="logo"')
    && response.body.includes('id="phi-ship"')
    && response.body.includes('href="#phi-ship"')
    ? ok('đích #logo và #phi-ship vẫn tồn tại')
    : bad('mất đích link #logo hoặc #phi-ship');

  sect('2. Form hồ sơ chỉ đổi hồ sơ');
  let before = await snapshot(shop.shopId);
  response = await postSection(shop.shopId, shop.cookie, 'profile', {
    name: 'Profile Only Shop',
    contact_email: 'profile@example.test',
    contact_phone: '0902000002',
    business_address: '2 Profile Street',
  });
  let after = await snapshot(shop.shopId);
  response.status === 200
    && after.profile.name === 'Profile Only Shop'
    && after.profile.contact_email === 'profile@example.test'
    && after.profile.contact_phone === '0902000002'
    && after.profile.business_address === '2 Profile Street'
    ? ok('POST hồ sơ qua BFF ghi đủ bốn trường hồ sơ')
    : bad('POST hồ sơ lỗi', `${response.status} ${JSON.stringify(after.profile)}`);
  expectOnlySectionChanged(before, after, 'profile', 'POST hồ sơ');

  sect('3. Form vận chuyển chỉ đổi vận chuyển');
  before = after;
  response = await postSection(shop.shopId, shop.cookie, 'shipping', {
    ship_fee_vnd: '31000',
    free_ship_threshold_vnd: '650000',
    ship_fee_far_vnd: '52000',
    ship_extra_per_500g_vnd: '9000',
    default_weight_gram: '750',
    ship_from_province: 'TP. Hồ Chí Minh',
    ship_mode: 'region',
    ship_origin_lat: '10.7769',
    ship_origin_lng: '106.7009',
    ship_base_vnd: '18000',
    ship_per_km_vnd: '4500',
    ship_max_km: '25',
    ship_road_factor: '1.45',
    ship_over_max_behavior: 'reject',
  });
  after = await snapshot(shop.shopId);
  response.status === 200
    && Number(after.shipping.ship_fee_vnd) === 31000
    && Number(after.shipping.free_ship_threshold_vnd) === 650000
    && after.shipping.ship_from_province === 'TP. Hồ Chí Minh'
    && Number(after.shipping.ship_origin_lat) === 10.7769
    && Number(after.shipping.ship_road_factor) === 1.45
    && after.shipping.ship_over_max_behavior === 'reject'
    ? ok('POST vận chuyển qua BFF ghi đủ cấu hình vùng, cân và khoảng cách')
    : bad('POST vận chuyển lỗi', `${response.status} ${JSON.stringify(after.shipping)}`);
  expectOnlySectionChanged(before, after, 'shipping', 'POST vận chuyển');

  sect('4. Form vận hành chỉ đổi vận hành');
  before = after;
  response = await postSection(shop.shopId, shop.cookie, 'operations', {
    low_stock_threshold: '11',
    max_pending_per_ip: '88',
    max_pending_per_phone: '22',
  });
  after = await snapshot(shop.shopId);
  response.status === 200
    && Number(after.operations.low_stock_threshold) === 11
    && Number(after.operations.max_pending_per_ip) === 88
    && Number(after.operations.max_pending_per_phone) === 22
    ? ok('POST vận hành qua BFF ghi ngưỡng tồn và chống đơn ảo')
    : bad('POST vận hành lỗi', `${response.status} ${JSON.stringify(after.operations)}`);
  expectOnlySectionChanged(before, after, 'operations', 'POST vận hành');

  sect('5. Form quyền riêng tư chỉ đổi quyền riêng tư');
  before = after;
  response = await postSection(shop.shopId, shop.cookie, 'privacy', { pii_retention_months: '36' });
  after = await snapshot(shop.shopId);
  response.status === 200 && Number(after.privacy.pii_retention_months) === 36
    ? ok('owner đổi được thời hạn lưu dữ liệu qua BFF')
    : bad('POST quyền riêng tư lỗi', `${response.status} ${JSON.stringify(after.privacy)}`);
  expectOnlySectionChanged(before, after, 'privacy', 'POST quyền riêng tư');

  sect('6. Lỗi validation giữ input nhưng không ghi DB');
  before = after;
  response = await postSection(shop.shopId, shop.cookie, 'profile', {
    name: 'Tên nháp phải còn',
    contact_email: 'email-khong-hop-le',
    contact_phone: '0903999999',
    business_address: 'Địa chỉ nháp phải còn',
  });
  after = await snapshot(shop.shopId);
  response.status === 400
    && response.body.includes('value="Tên nháp phải còn"')
    && response.body.includes('value="email-khong-hop-le"')
    && response.body.includes('value="0903999999"')
    && response.body.includes('Địa chỉ nháp phải còn')
    ? ok('form lỗi render lại đủ giá trị người dùng vừa nhập')
    : bad('form lỗi làm mất input', `${response.status} ${response.body.slice(0, 600)}`);
  equal(after, before)
    ? ok('validation lỗi không ghi dở bất kỳ nhóm cài đặt nào')
    : bad('validation lỗi vẫn làm đổi DB', `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

  sect('7. Admin lưu được hồ sơ nhưng không thấy form quyền riêng tư');
  response = await adm('GET', `${base}/settings`, { cookie: admin.cookie });
  response.status === 200
    && response.body.includes(`action="${base}/settings/profile"`)
    && !response.body.includes(`action="${base}/settings/privacy"`)
    ? ok('admin thấy form hồ sơ và không thấy form quyền riêng tư')
    : bad('UI phân quyền admin sai', `${response.status}`);
  before = await snapshot(shop.shopId);
  response = await postSection(shop.shopId, admin.cookie, 'profile', {
    name: 'Admin Updated Profile',
    contact_email: 'admin-update@example.test',
    contact_phone: '0904000004',
    business_address: '4 Admin Street',
  });
  after = await snapshot(shop.shopId);
  response.status === 200
    && after.profile.name === 'Admin Updated Profile'
    && Number(after.privacy.pii_retention_months) === Number(before.privacy.pii_retention_months)
    ? ok('admin lưu hồ sơ thành công mà không đổi chính sách owner')
    : bad('admin lưu hồ sơ lỗi hoặc làm đổi quyền riêng tư', `${response.status} ${JSON.stringify(after)}`);
  expectOnlySectionChanged(before, after, 'profile', 'admin POST hồ sơ');

  sect('8. POST không Origin bị chặn trước khi ghi');
  before = after;
  response = await postSection(shop.shopId, shop.cookie, 'profile', {
    name: 'CSRF Must Not Persist',
    contact_email: 'csrf@example.test',
    contact_phone: '0905000005',
    business_address: '5 CSRF Street',
  }, null);
  after = await snapshot(shop.shopId);
  response.status === 403
    ? ok('POST section không Origin trả 403')
    : bad('POST section không Origin không bị chặn', `${response.status} ${response.body.slice(0, 200)}`);
  equal(after, before)
    ? ok('CSRF bị chặn không làm đổi nhóm cài đặt nào')
    : bad('CSRF bị chặn nhưng DB vẫn đổi', `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await owner.end().catch(() => {});
  process.exit(1);
});
