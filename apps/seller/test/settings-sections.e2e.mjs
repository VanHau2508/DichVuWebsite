/**
 * Section-safe shop settings API.
 *
 * Run inside dbtest after restarting seller so the bind-mounted source is reloaded:
 *   docker compose -f infra/compose.dev.yml restart seller
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/settings-sections.e2e.mjs
 *
 * Contract under test:
 *   PATCH /shops/:id/settings/profile
 *   PATCH /shops/:id/settings/shipping
 *   PATCH /shops/:id/settings/operations
 *   PATCH /shops/:id/settings/privacy
 *
 * Each endpoint owns only its named column group. Saving one settings form must not
 * reset values owned by another form, which is the destructive behavior of the
 * legacy all-in-one PATCH /shops/:id endpoint when fields are omitted.
 */

import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const OA = 'https://auth.localtest';
const OO = 'https://ops.localtest';
const OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });

let pass = 0;
let fail = 0;
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const ok = (message) => { pass++; console.log(`  ${GREEN}PASS${RESET} ${message}`); };
const bad = (message, detail = '') => {
  fail++;
  console.log(`  ${RED}FAIL${RESET} ${message}`);
  if (detail) console.log(`       ${DIM}${detail}${RESET}`);
};
const section = (message) => console.log(`\n${BOLD}${message}${RESET}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sessionOf = (cookies) => (cookies ?? [])
  .map((cookie) => /^__Host-session=([^;]+)/.exec(cookie)?.[1])
  .find(Boolean) ?? null;

async function request(base, method, path, { body, cookie, origin } = {}) {
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

async function makeStaff() {
  const email = `staff-settings-${uniq()}@nentang.vn`;
  const password = 'staff settings passphrase';
  await request(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let cookie = sessionOf((await request(AUTH, 'POST', '/auth/login', {
    body: { email, password }, origin: OA,
  })).cookies);
  const enroll = await request(AUTH, 'POST', '/auth/mfa/enroll', { cookie, origin: OA });
  const key = base32Decode(enroll.json.secret);
  await request(AUTH, 'POST', '/auth/mfa/activate', {
    cookie, body: { code: totp(key, {}) }, origin: OA,
  });
  const userId = (await owner.query(`SELECT id FROM users WHERE email = $1`, [email])).rows[0].id;
  await owner.query(`INSERT INTO platform_staff (user_id, role) VALUES ($1, 'admin')`, [userId]);

  const counter = counterFor(Date.now());
  while (counterFor(Date.now()) <= counter) await sleep(1000);
  cookie = sessionOf((await request(AUTH, 'POST', '/auth/login', {
    body: { email, password }, origin: OA,
  })).cookies);
  return sessionOf((await request(AUTH, 'POST', '/auth/mfa/verify', {
    cookie, body: { code: totp(key, {}) }, origin: OA,
  })).cookies) ?? cookie;
}

async function makeShopOwner(staffCookie, label) {
  const slug = `settings-${label}-${uniq()}`;
  const created = await request(PLATFORM, 'POST', '/ops/shops', {
    body: { name: `Settings ${label}`, slug, plan_code: 'platform' },
    cookie: staffCookie,
    origin: OO,
  });
  if (created.status !== 201 || !created.json?.id) {
    throw new Error(`cannot create shop ${label}: ${created.status} ${created.raw}`);
  }
  const shopId = created.json.id;
  const email = `owner-${slug}@shop.vn`;
  const password = 'owner settings passphrase';
  const invited = await request(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, {
    body: { email, role: 'owner' }, cookie: staffCookie, origin: OO,
  });
  if (invited.status !== 201) throw new Error(`cannot invite owner: ${invited.status} ${invited.raw}`);
  const accepted = await request(AUTH, 'POST', '/auth/invitations/accept', {
    body: { token: await inviteTokenOf(email), password }, origin: OA,
  });
  if (accepted.status !== 200) throw new Error(`cannot accept owner invite: ${accepted.status} ${accepted.raw}`);
  const cookie = sessionOf((await request(AUTH, 'POST', '/auth/login', {
    body: { email, password }, origin: OA,
  })).cookies);
  return { shopId, cookie };
}

async function addShopMember(staffCookie, shopId, role, label) {
  const email = `${role}-${label}-${uniq()}@shop.vn`;
  const password = `${role} settings passphrase`;
  const invited = await request(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, {
    body: { email, role }, cookie: staffCookie, origin: OO,
  });
  if (invited.status !== 201) throw new Error(`cannot invite ${role}: ${invited.status} ${invited.raw}`);
  const accepted = await request(AUTH, 'POST', '/auth/invitations/accept', {
    body: { token: await inviteTokenOf(email), password }, origin: OA,
  });
  if (accepted.status !== 200) throw new Error(`cannot accept ${role} invite: ${accepted.status} ${accepted.raw}`);
  const cookie = sessionOf((await request(AUTH, 'POST', '/auth/login', {
    body: { email, password }, origin: OA,
  })).cookies);
  return { email, cookie };
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
const ALL_COLUMNS = [
  ...PROFILE_COLUMNS,
  ...SHIPPING_COLUMNS,
  ...OPERATIONS_COLUMNS,
  ...PRIVACY_COLUMNS,
];

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

function expectUnchanged(actual, before, names, label) {
  const changed = names.filter((name) => !equal(actual[name], before[name]));
  if (changed.length === 0) return ok(`${label}: unrelated sections stay unchanged`);
  return bad(`${label}: changed unrelated sections`, changed.map((name) => (
    `${name}: ${JSON.stringify(before[name])} -> ${JSON.stringify(actual[name])}`
  )).join(' | '));
}

async function seedBaseline(shopId) {
  await owner.query(
    `UPDATE shops
        SET name = 'Baseline Shop',
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
    [shopId, 'H\u00e0 N\u1ed9i'],
  );
}

async function patchSettings(shop, name, body) {
  return request(SELLER, 'PATCH', `/shops/${shop.shopId}/settings/${name}`, {
    body, cookie: shop.cookie, origin: OS,
  });
}

async function main() {
  const staff = await makeStaff();
  const shop = await makeShopOwner(staff, 'owner');
  const admin = await addShopMember(staff, shop.shopId, 'admin', 'settings');
  const otherShop = await makeShopOwner(staff, 'other');
  await seedBaseline(shop.shopId);
  ok('created owner/admin, a second shop, and seeded distinct settings values');

  section('1. Profile is isolated');
  let before = await snapshot(shop.shopId);
  let response = await patchSettings(shop, 'profile', {
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
    ? ok('profile endpoint updates its four fields')
    : bad('profile endpoint failed', `${response.status} ${response.raw} ${JSON.stringify(after.profile)}`);
  expectUnchanged(after, before, ['shipping', 'operations', 'privacy'], 'profile PATCH');

  section('2. Shipping is isolated');
  before = after;
  response = await patchSettings(shop, 'shipping', {
    ship_fee_vnd: 31000,
    free_ship_threshold_vnd: 650000,
    ship_fee_far_vnd: 52000,
    ship_extra_per_500g_vnd: 9000,
    default_weight_gram: 750,
    ship_from_province: 'TP. H\u1ed3 Ch\u00ed Minh',
    ship_mode: 'region',
    ship_origin_lat: 10.7769,
    ship_origin_lng: 106.7009,
    ship_base_vnd: 18000,
    ship_per_km_vnd: 4500,
    ship_max_km: 25,
    ship_road_factor: 1.45,
    ship_over_max_behavior: 'reject',
  });
  after = await snapshot(shop.shopId);
  response.status === 200
    && Number(after.shipping.ship_fee_vnd) === 31000
    && Number(after.shipping.free_ship_threshold_vnd) === 650000
    && after.shipping.ship_from_province === 'TP. H\u1ed3 Ch\u00ed Minh'
    && after.shipping.ship_mode === 'region'
    && Number(after.shipping.ship_road_factor) === 1.45
    && after.shipping.ship_over_max_behavior === 'reject'
    ? ok('shipping endpoint updates the complete shipping section')
    : bad('shipping endpoint failed', `${response.status} ${response.raw} ${JSON.stringify(after.shipping)}`);
  expectUnchanged(after, before, ['profile', 'operations', 'privacy'], 'shipping PATCH');

  section('3. Operations is isolated');
  before = after;
  response = await patchSettings(shop, 'operations', {
    low_stock_threshold: 11,
    max_pending_per_ip: 88,
    max_pending_per_phone: 22,
  });
  after = await snapshot(shop.shopId);
  response.status === 200
    && Number(after.operations.low_stock_threshold) === 11
    && Number(after.operations.max_pending_per_ip) === 88
    && Number(after.operations.max_pending_per_phone) === 22
    ? ok('operations endpoint updates stock and anti-abuse thresholds')
    : bad('operations endpoint failed', `${response.status} ${response.raw} ${JSON.stringify(after.operations)}`);
  expectUnchanged(after, before, ['profile', 'shipping', 'privacy'], 'operations PATCH');

  section('4. Privacy is isolated');
  before = after;
  response = await patchSettings(shop, 'privacy', { pii_retention_months: 36 });
  after = await snapshot(shop.shopId);
  response.status === 200 && Number(after.privacy.pii_retention_months) === 36
    ? ok('privacy endpoint updates the retention policy')
    : bad('privacy endpoint failed', `${response.status} ${response.raw} ${JSON.stringify(after.privacy)}`);
  expectUnchanged(after, before, ['profile', 'shipping', 'operations'], 'privacy PATCH');

  section('5. Partial PATCH and role boundaries');
  before = after;
  response = await request(SELLER, 'PATCH', `/shops/${shop.shopId}/settings/profile`, {
    body: { name: 'Admin Partial Rename' }, cookie: admin.cookie, origin: OS,
  });
  after = await snapshot(shop.shopId);
  response.status === 200 && after.profile.name === 'Admin Partial Rename'
    ? ok('admin may update profile')
    : bad('admin profile PATCH failed', `${response.status} ${response.raw}`);
  equal(
    pick(after.profile, ['contact_email', 'contact_phone', 'business_address']),
    pick(before.profile, ['contact_email', 'contact_phone', 'business_address']),
  )
    ? ok('one-field profile PATCH preserves omitted profile fields')
    : bad('partial profile PATCH reset omitted fields', `${JSON.stringify(before.profile)} -> ${JSON.stringify(after.profile)}`);
  expectUnchanged(after, before, ['shipping', 'operations', 'privacy'], 'partial profile PATCH');

  before = after;
  response = await request(SELLER, 'PATCH', `/shops/${shop.shopId}/settings/privacy`, {
    body: { pii_retention_months: 48 }, cookie: admin.cookie, origin: OS,
  });
  after = await snapshot(shop.shopId);
  response.status === 403 && response.json?.error_code === 'owner_required_for_privacy'
    && response.json?.action && response.json?.request_id
    ? ok('admin privacy PATCH is denied with an actionable structured error')
    : bad('admin privacy boundary failed', `${response.status} ${response.raw}`);
  equal(after, before)
    ? ok('denied privacy PATCH writes nothing')
    : bad('denied privacy PATCH changed settings', `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

  section('6. Blank clears only the addressed nullable field');
  before = after;
  response = await patchSettings(shop, 'profile', { contact_email: '' });
  after = await snapshot(shop.shopId);
  response.status === 200 && after.profile.contact_email == null
    ? ok('blank contact email clears that nullable field')
    : bad('blank contact email was not cleared', `${response.status} ${response.raw}`);
  equal(
    pick(after.profile, ['name', 'contact_phone', 'business_address']),
    pick(before.profile, ['name', 'contact_phone', 'business_address']),
  )
    ? ok('blank field does not clear sibling profile fields')
    : bad('blank field cleared sibling profile fields', `${JSON.stringify(before.profile)} -> ${JSON.stringify(after.profile)}`);
  expectUnchanged(after, before, ['shipping', 'operations', 'privacy'], 'blank profile field PATCH');

  section('7. Cross-shop access fails closed');
  const otherBefore = await snapshot(otherShop.shopId);
  const ownBefore = after;
  response = await request(SELLER, 'PATCH', `/shops/${otherShop.shopId}/settings/profile`, {
    body: { name: 'Cross Shop Write' }, cookie: shop.cookie, origin: OS,
  });
  const otherAfter = await snapshot(otherShop.shopId);
  after = await snapshot(shop.shopId);
  response.status === 404
    ? ok('owner of shop A receives 404 for shop B settings')
    : bad('cross-shop settings endpoint did not hide the tenant', `${response.status} ${response.raw}`);
  equal(otherAfter, otherBefore) && equal(after, ownBefore)
    ? ok('cross-shop attempt changes neither tenant')
    : bad('cross-shop attempt changed data', `A ${JSON.stringify(ownBefore)} -> ${JSON.stringify(after)} | B ${JSON.stringify(otherBefore)} -> ${JSON.stringify(otherAfter)}`);

  section('8. Rejected input is atomic');
  before = after;
  response = await patchSettings(shop, 'shipping', {
    ...before.shipping,
    ship_fee_vnd: 99999,
    ship_mode: 'unsupported-mode',
  });
  after = await snapshot(shop.shopId);
  response.status === 400 && response.json?.error_code === 'invalid_ship_mode'
    && response.json?.field_errors?.ship_mode && response.json?.action && response.json?.request_id
    ? ok('invalid shipping settings return a structured actionable error')
    : bad('invalid shipping settings response is incomplete', `${response.status} ${response.raw}`);
  equal(after, before)
    ? ok('validation failure leaves every settings column unchanged')
    : bad('validation failure left a partial write', `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

  console.log(`\n${BOLD}${pass} pass, ${fail} fail${RESET}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await owner.end().catch(() => {});
  process.exit(1);
});
