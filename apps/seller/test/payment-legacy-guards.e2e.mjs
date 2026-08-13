/**
 * E2E tập trung cho ba đường ghi tiền COD tương thích ngược.
 *
 * Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest \
 *     node apps/seller/test/payment-legacy-guards.e2e.mjs
 *
 * Các endpoint này được giữ cho client cũ nhưng vẫn ghi vào sổ thanh toán. Vì vậy
 * order_manager tuyệt đối không được lọt qua orders.write, và owner phải xác thực lại
 * trước khi bất kỳ đường nào được phép làm thay đổi tiền.
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

const ownerDb = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
let pass = 0;
let fail = 0;

const ok = (message) => { pass++; console.log(`  PASS ${message}`); };
const bad = (message, detail) => {
  fail++;
  console.log(`  FAIL ${message}${detail ? ` :: ${String(detail).slice(0, 260)}` : ''}`);
};
const section = (message) => console.log(`\n# ${message}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cookieFrom = (setCookies) => {
  for (const value of setCookies ?? []) {
    const match = /^__Host-session=([^;]*)/.exec(value);
    if (match) return match[1];
  }
  return null;
};

async function request(base, method, path, { body, cookie, origin } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = `__Host-session=${cookie}`;
  if (origin) headers.origin = origin;
  const response = await fetch(base + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await response.text();
  let json = null;
  try { json = raw ? JSON.parse(raw) : null; } catch {}
  return { status: response.status, json, raw, setCookies: response.headers.getSetCookie() };
}

const login = async (email, password) => cookieFrom((await request(AUTH, 'POST', '/auth/login', {
  body: { email, password }, origin: OA,
})).setCookies);

const userIdOf = async (email) => (await ownerDb.query(
  `SELECT id FROM users WHERE email = $1`, [email],
)).rows[0]?.id ?? null;

const invitationTokenOf = async (email) => {
  const { rows } = await ownerDb.query(
    `SELECT payload->>'accept_url' AS url
       FROM outbox
      WHERE topic = 'user.invited' AND payload->>'to' = $1
      ORDER BY id DESC LIMIT 1`,
    [email],
  );
  return rows[0]?.url ? new URL(rows[0].url).searchParams.get('token') : null;
};

async function makePlatformStaff() {
  const email = `staff-${uniq()}@nentang.vn`;
  const password = 'staff strong passphrase';
  await request(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let cookie = await login(email, password);
  const enrollment = await request(AUTH, 'POST', '/auth/mfa/enroll', { cookie, origin: OA });
  const key = base32Decode(enrollment.json.secret);
  await request(AUTH, 'POST', '/auth/mfa/activate', {
    cookie, body: { code: totp(key, {}) }, origin: OA,
  });
  await ownerDb.query(
    `INSERT INTO platform_staff (user_id, role) VALUES ($1, 'admin')`,
    [await userIdOf(email)],
  );
  const counter = counterFor(Date.now());
  while (counterFor(Date.now()) <= counter) await sleep(1000);
  cookie = await login(email, password);
  const verified = await request(AUTH, 'POST', '/auth/mfa/verify', {
    cookie, body: { code: totp(key, {}) }, origin: OA,
  });
  return cookieFrom(verified.setCookies) ?? cookie;
}

async function makeShopOwner(staffCookie) {
  const slug = `legacy-money-${uniq()}`;
  const created = await request(PLATFORM, 'POST', '/ops/shops', {
    body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO,
  });
  if (created.status !== 201 || !created.json?.id) {
    throw new Error(`không tạo được shop: ${created.status} ${created.raw}`);
  }
  const shopId = created.json.id;
  const email = `owner-${uniq()}@shop.vn`;
  const password = 'owner strong passphrase';
  const invited = await request(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, {
    body: { email, role: 'owner' }, cookie: staffCookie, origin: OO,
  });
  if (invited.status !== 201) throw new Error(`không mời được owner: ${invited.status} ${invited.raw}`);
  const accepted = await request(AUTH, 'POST', '/auth/invitations/accept', {
    body: { token: await invitationTokenOf(email), password }, origin: OA,
  });
  if (accepted.status !== 200) throw new Error(`không nhận được lời mời owner: ${accepted.status} ${accepted.raw}`);
  return { shopId, email, password, cookie: await login(email, password) };
}

async function inviteOrderManager(shop, ownerCookie) {
  const email = `order-manager-${uniq()}@shop.vn`;
  const password = 'order manager strong passphrase';
  const invited = await request(SELLER, 'POST', `/shops/${shop.shopId}/members/invite`, {
    body: { email, role: 'order_manager' }, cookie: ownerCookie, origin: OS,
  });
  if (invited.status !== 201) throw new Error(`không mời được order_manager: ${invited.status} ${invited.raw}`);
  const accepted = await request(AUTH, 'POST', '/auth/invitations/accept', {
    body: { token: await invitationTokenOf(email), password }, origin: OA,
  });
  if (accepted.status !== 200) throw new Error(`không nhận được lời mời order_manager: ${accepted.status} ${accepted.raw}`);
  return { email, password, cookie: await login(email, password) };
}

async function setupVariant(shop, ownerCookie) {
  const product = await request(SELLER, 'POST', `/shops/${shop.shopId}/products`, {
    body: {
      title: `Legacy payment guard ${uniq()}`,
      slug: `legacy-payment-${uniq()}`,
      price_vnd: 500000,
      status: 'active',
      variants: [{ sku: `LEGACY-PAY-${uniq()}`, price_vnd: 500000 }],
    },
    cookie: ownerCookie,
    origin: OS,
  });
  if (product.status !== 201) throw new Error(`không tạo được sản phẩm: ${product.status} ${product.raw}`);
  const detail = await request(SELLER, 'GET', `/shops/${shop.shopId}/products/${product.json.id}`, {
    cookie: ownerCookie,
  });
  const variantId = detail.json?.variants?.[0]?.id;
  const adjusted = await request(SELLER, 'POST', `/shops/${shop.shopId}/variants/${variantId}/inventory/adjust`, {
    body: { delta: 30, reason: 'payment guard fixture' }, cookie: ownerCookie, origin: OS,
  });
  if (adjusted.status !== 200) throw new Error(`không dựng được tồn kho: ${adjusted.status} ${adjusted.raw}`);
  return variantId;
}

async function createOrder(shopId, variantId, ownerCookie, label) {
  const created = await request(SELLER, 'POST', `/shops/${shopId}/orders`, {
    body: {
      idempotency_key: `legacy-payment-${label}-${uniq()}`,
      lines: [{ variant_id: variantId, qty: 1 }],
      customer: { name: `Customer ${label}`, phone: `0912${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}` },
      payment_method: 'cod',
    },
    cookie: ownerCookie,
    origin: OS,
  });
  if (created.status !== 201) throw new Error(`không tạo được đơn ${label}: ${created.status} ${created.raw}`);
  return { id: created.json.id, totalVnd: Number(created.json.total_vnd) };
}

async function recordPartial(shopId, order, ownerCookie, divisor) {
  const amount = Math.max(1, Math.floor(order.totalVnd / divisor));
  const recorded = await request(SELLER, 'POST', `/shops/${shopId}/orders/${order.id}/payments/manual`, {
    body: { amount_vnd: amount, note: 'fixture partial payment' }, cookie: ownerCookie, origin: OS,
  });
  if (recorded.status !== 200) {
    throw new Error(`không dựng được khoản thanh toán một phần: ${recorded.status} ${recorded.raw}`);
  }
  return amount;
}

async function moneyState(shopId, orderId) {
  const { rows } = await ownerDb.query(
    `SELECT o.amount_paid_vnd::text,
            o.payment_status,
            o.paid_at::text,
            count(pt.id)::int AS transaction_count,
            coalesce(sum(CASE WHEN pt.entry_type = 'credit' THEN pt.amount_vnd ELSE -pt.amount_vnd END), 0)::text AS ledger_net_vnd
       FROM orders o
       LEFT JOIN payment_transactions pt
         ON pt.shop_id = o.shop_id AND pt.order_id = o.id
      WHERE o.shop_id = $1 AND o.id = $2
      GROUP BY o.id, o.amount_paid_vnd, o.payment_status, o.paid_at`,
    [shopId, orderId],
  );
  return rows[0] ?? null;
}

const statesEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);

async function assertNoMoneyChange(label, shopId, orderId, invoke, responseCheck) {
  const before = await moneyState(shopId, orderId);
  const response = await invoke();
  responseCheck(response)
    ? ok(label)
    : bad(label, `http=${response.status} body=${response.raw}`);
  const after = await moneyState(shopId, orderId);
  statesEqual(before, after)
    ? ok(`${label}: dữ liệu tiền trong DB không đổi`)
    : bad(`${label}: trạng thái tiền đã thay đổi`, `trước=${JSON.stringify(before)} sau=${JSON.stringify(after)}`);
}

async function main() {
  const staffCookie = await makePlatformStaff();
  const shop = await makeShopOwner(staffCookie);
  const variantId = await setupVariant(shop, shop.cookie);

  const orders = {};
  for (const label of [
    'manager-mark', 'manager-bulk', 'manager-unmark',
    'owner-mark', 'owner-bulk', 'owner-unmark', 'owner-exact',
  ]) {
    orders[label] = await createOrder(shop.shopId, variantId, shop.cookie, label);
  }

  const steppedOwner = await request(AUTH, 'POST', '/auth/step-up', {
    body: { password: shop.password }, cookie: shop.cookie, origin: OA,
  });
  if (steppedOwner.status !== 200) throw new Error(`owner xác thực lại thất bại: ${steppedOwner.status} ${steppedOwner.raw}`);

  const manager = await inviteOrderManager(shop, shop.cookie);
  await recordPartial(shop.shopId, orders['manager-unmark'], shop.cookie, 4);
  await recordPartial(shop.shopId, orders['owner-unmark'], shop.cookie, 4);
  const exactPartial = await recordPartial(shop.shopId, orders['owner-exact'], shop.cookie, 3);

  const managerStepUp = await request(AUTH, 'POST', '/auth/step-up', {
    body: { password: manager.password }, cookie: manager.cookie, origin: OA,
  });
  if (managerStepUp.status !== 200) throw new Error(`order_manager xác thực lại thất bại: ${managerStepUp.status} ${managerStepUp.raw}`);

  section('Order manager không được dùng endpoint tiền legacy, kể cả sau khi xác thực lại');
  await assertNoMoneyChange(
    'order_manager POST mark-paid → 403',
    shop.shopId,
    orders['manager-mark'].id,
    () => request(SELLER, 'POST', `/shops/${shop.shopId}/orders/${orders['manager-mark'].id}/mark-paid`, {
      body: {}, cookie: manager.cookie, origin: OS,
    }),
    (response) => response.status === 403,
  );
  await assertNoMoneyChange(
    'order_manager POST bulk/mark-paid → 403',
    shop.shopId,
    orders['manager-bulk'].id,
    () => request(SELLER, 'POST', `/shops/${shop.shopId}/orders/bulk/mark-paid`, {
      body: { order_ids: [orders['manager-bulk'].id] }, cookie: manager.cookie, origin: OS,
    }),
    (response) => response.status === 403,
  );
  await assertNoMoneyChange(
    'order_manager POST unmark-paid → 403',
    shop.shopId,
    orders['manager-unmark'].id,
    () => request(SELLER, 'POST', `/shops/${shop.shopId}/orders/${orders['manager-unmark'].id}/unmark-paid`, {
      body: { reason: 'order_manager không được đảo tiền' }, cookie: manager.cookie, origin: OS,
    }),
    (response) => response.status === 403,
  );

  section('Owner phải xác thực lại trên mọi endpoint tiền legacy');
  const freshOwnerCookie = await login(shop.email, shop.password);
  if (!freshOwnerCookie) throw new Error('không tạo được phiên owner mới');
  const requiresStepUp = (response) => response.status === 403
    && response.json?.step_up_required === true
    && response.json?.error === 'step_up_required';

  await assertNoMoneyChange(
    'owner chưa xác thực lại POST mark-paid → step_up_required',
    shop.shopId,
    orders['owner-mark'].id,
    () => request(SELLER, 'POST', `/shops/${shop.shopId}/orders/${orders['owner-mark'].id}/mark-paid`, {
      body: {}, cookie: freshOwnerCookie, origin: OS,
    }),
    requiresStepUp,
  );
  await assertNoMoneyChange(
    'owner chưa xác thực lại POST bulk/mark-paid → step_up_required',
    shop.shopId,
    orders['owner-bulk'].id,
    () => request(SELLER, 'POST', `/shops/${shop.shopId}/orders/bulk/mark-paid`, {
      body: { order_ids: [orders['owner-bulk'].id] }, cookie: freshOwnerCookie, origin: OS,
    }),
    requiresStepUp,
  );
  await assertNoMoneyChange(
    'owner chưa xác thực lại POST unmark-paid → step_up_required',
    shop.shopId,
    orders['owner-unmark'].id,
    () => request(SELLER, 'POST', `/shops/${shop.shopId}/orders/${orders['owner-unmark'].id}/unmark-paid`, {
      body: { reason: 'owner phải xác thực lại' }, cookie: freshOwnerCookie, origin: OS,
    }),
    requiresStepUp,
  );

  section('Owner đã xác thực lại chỉ ghi đúng phần tiền còn thiếu');
  const ownerStepUp = await request(AUTH, 'POST', '/auth/step-up', {
    body: { password: shop.password }, cookie: freshOwnerCookie, origin: OA,
  });
  ownerStepUp.status === 200
    ? ok('owner xác thực lại thành công')
    : bad('owner xác thực lại thành công', `${ownerStepUp.status} ${ownerStepUp.raw}`);

  const beforeExact = await moneyState(shop.shopId, orders['owner-exact'].id);
  const due = orders['owner-exact'].totalVnd - exactPartial;
  const paid = await request(SELLER, 'POST', `/shops/${shop.shopId}/orders/${orders['owner-exact'].id}/mark-paid`, {
    body: {}, cookie: freshOwnerCookie, origin: OS,
  });
  const afterExact = await moneyState(shop.shopId, orders['owner-exact'].id);
  const latest = (await ownerDb.query(
    `SELECT amount_vnd::text, provider, entry_type
       FROM payment_transactions
      WHERE shop_id = $1 AND order_id = $2
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [shop.shopId, orders['owner-exact'].id],
  )).rows[0];

  paid.status === 200
    ? ok('owner đã xác thực lại dùng được mark-paid legacy')
    : bad('owner đã xác thực lại dùng được mark-paid legacy', `${paid.status} ${paid.raw}`);
  Number(latest?.amount_vnd) === due && latest?.provider === 'manual' && latest?.entry_type === 'credit'
    ? ok(`mark-paid legacy ghi đúng phần còn thiếu ${due} VND`)
    : bad('mark-paid legacy ghi sai số tiền', `còn thiếu=${due} mới nhất=${JSON.stringify(latest)}`);
  Number(afterExact?.amount_paid_vnd) === orders['owner-exact'].totalVnd
      && Number(afterExact?.ledger_net_vnd) === orders['owner-exact'].totalVnd
      && afterExact?.payment_status === 'paid'
      && afterExact?.transaction_count === beforeExact.transaction_count + 1
      && Number(paid.json?.payment_summary?.amount_due_vnd) === 0
    ? ok('cache đơn, sổ tiền và response cùng xác nhận đã thu đủ')
    : bad('trạng thái đã thu đủ không nhất quán', `trước=${JSON.stringify(beforeExact)} sau=${JSON.stringify(afterExact)} response=${paid.raw}`);

  const replayBefore = await moneyState(shop.shopId, orders['owner-exact'].id);
  const replay = await request(SELLER, 'POST', `/shops/${shop.shopId}/orders/${orders['owner-exact'].id}/mark-paid`, {
    body: {}, cookie: freshOwnerCookie, origin: OS,
  });
  const replayAfter = await moneyState(shop.shopId, orders['owner-exact'].id);
  [200, 409].includes(replay.status)
    ? ok(`phát lại trả response có kiểm soát (${replay.status})`)
    : bad('phát lại trả response có kiểm soát', `${replay.status} ${replay.raw}`);
  statesEqual(replayBefore, replayAfter)
    ? ok('phát lại không cộng tiền hai lần')
    : bad('phát lại làm thay đổi sổ thanh toán', `trước=${JSON.stringify(replayBefore)} sau=${JSON.stringify(replayAfter)}`);

  console.log(`\n${pass} pass, ${fail} fail`);
  await ownerDb.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await ownerDb.end().catch(() => {});
  process.exit(2);
});
