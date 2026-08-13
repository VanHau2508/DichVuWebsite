/**
 * E2E BFF cho các URL thanh toán legacy còn giữ để tương thích client cũ.
 *
 * Bộ này kiểm đúng lớp seller-admin: chủ shop chưa xác thực lại phải thấy cổng
 * mật khẩu; thao tác hàng loạt không làm mất đơn đã chọn hoặc bộ lọc; nhân viên
 * đơn hàng không được nhìn/thực hiện thao tác tiền; mật khẩu sai không được ghi
 * bất kỳ chứng từ hay số dư nào.
 */
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const OA = 'https://auth.localtest';
const OO = 'https://ops.localtest';
const OS = 'https://seller.localtest';
const OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });

let pass = 0;
let fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (message) => { pass++; console.log(`  ${G}PASS${X} ${message}`); };
const bad = (message, detail = '') => {
  fail++;
  console.log(`  ${R}FAIL${X} ${message}`);
  if (detail) console.log(`       ${D}${String(detail).slice(0, 700)}${X}`);
};
const section = (message) => console.log(`\n${B}${message}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cookieOf = (setCookies) => (setCookies ?? [])
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

async function admin(method, path, { cookie, form, origin = OADM } = {}) {
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
    cookies: response.headers.getSetCookie(),
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
  return cookieOf((await request(AUTH, 'POST', '/auth/login', {
    body: { email, password }, origin: OA,
  })).cookies);
}

async function adminLogin(email, password) {
  return cookieOf((await admin('POST', '/login', {
    form: { email, password },
  })).cookies);
}

async function makeStaff() {
  const email = `staff-legacy-pay-${uniq()}@nentang.vn`;
  const password = 'staff legacy payment passphrase';
  await request(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let cookie = await login(email, password);
  const enrolled = await request(AUTH, 'POST', '/auth/mfa/enroll', { cookie, origin: OA });
  const key = base32Decode(enrolled.json.secret);
  await request(AUTH, 'POST', '/auth/mfa/activate', {
    cookie, body: { code: totp(key, {}) }, origin: OA,
  });
  const userId = (await owner.query(`SELECT id FROM users WHERE email = $1`, [email])).rows[0].id;
  await owner.query(`INSERT INTO platform_staff (user_id, role) VALUES ($1, 'admin')`, [userId]);
  const counter = counterFor(Date.now());
  while (counterFor(Date.now()) <= counter) await sleep(1000);
  cookie = await login(email, password);
  return cookieOf((await request(AUTH, 'POST', '/auth/mfa/verify', {
    cookie, body: { code: totp(key, {}) }, origin: OA,
  })).cookies) ?? cookie;
}

async function makeShopOwner(staffCookie) {
  const slug = `legacy-pay-${uniq()}`;
  const created = await request(PLATFORM, 'POST', '/ops/shops', {
    body: { name: 'Shop kiểm tra thanh toán legacy', slug, plan_code: 'platform' },
    cookie: staffCookie,
    origin: OO,
  });
  if (created.status !== 201) throw new Error(`không tạo được shop: ${created.status} ${created.raw}`);
  const shopId = created.json.id;
  const email = `owner-${slug}@shop.vn`;
  const password = 'owner legacy payment passphrase';
  const invited = await request(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, {
    body: { email, role: 'owner' }, cookie: staffCookie, origin: OO,
  });
  if (invited.status !== 201) throw new Error(`không mời được chủ shop: ${invited.status} ${invited.raw}`);
  const accepted = await request(AUTH, 'POST', '/auth/invitations/accept', {
    body: { token: await inviteTokenOf(email), password }, origin: OA,
  });
  if (accepted.status !== 200) throw new Error(`không nhận được lời mời: ${accepted.status} ${accepted.raw}`);
  return { shopId, email, password, apiCookie: await login(email, password) };
}

async function makeOrderManager(staffCookie, shopId) {
  const email = `order-manager-${uniq()}@shop.vn`;
  const password = 'order manager legacy passphrase';
  const invited = await request(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, {
    body: { email, role: 'order_manager' }, cookie: staffCookie, origin: OO,
  });
  if (invited.status !== 201) throw new Error(`không mời được nhân viên đơn hàng: ${invited.status} ${invited.raw}`);
  const accepted = await request(AUTH, 'POST', '/auth/invitations/accept', {
    body: { token: await inviteTokenOf(email), password }, origin: OA,
  });
  if (accepted.status !== 200) throw new Error(`nhân viên không nhận được lời mời: ${accepted.status} ${accepted.raw}`);
  return { email, password };
}

async function setupVariant(shop) {
  const product = await request(SELLER, 'POST', `/shops/${shop.shopId}/products`, {
    cookie: shop.apiCookie,
    origin: OS,
    body: {
      title: 'Sản phẩm kiểm tra tiền legacy',
      slug: `legacy-${uniq()}`,
      price_vnd: 120000,
      status: 'active',
      variants: [{ sku: `LEG-${uniq()}`, price_vnd: 120000 }],
    },
  });
  if (product.status !== 201) throw new Error(`không tạo được sản phẩm: ${product.status} ${product.raw}`);
  const detail = await request(SELLER, 'GET', `/shops/${shop.shopId}/products/${product.json.id}`, {
    cookie: shop.apiCookie,
  });
  const variantId = detail.json?.variants?.[0]?.id;
  await request(SELLER, 'POST', `/shops/${shop.shopId}/variants/${variantId}/inventory/adjust`, {
    cookie: shop.apiCookie, origin: OS, body: { delta: 50, reason: 'nhập hàng kiểm thử' },
  });
  return variantId;
}

async function createOrder(shop, variantId, label) {
  const response = await request(SELLER, 'POST', `/shops/${shop.shopId}/orders`, {
    cookie: shop.apiCookie,
    origin: OS,
    body: {
      idempotency_key: `legacy-pay-${label}-${uniq()}`,
      payment_method: 'cod',
      lines: [{ variant_id: variantId, qty: 1 }],
      customer: {
        name: `Khách ${label}`,
        phone: `09${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
        address_line: '1 Lê Lợi',
        province: 'Hà Nội',
      },
    },
  });
  if (response.status !== 201) throw new Error(`không tạo được đơn ${label}: ${response.status} ${response.raw}`);
  return response.json;
}

async function moneyState(orderIds) {
  const rows = (await owner.query(
    `SELECT o.id, o.payment_status, o.amount_paid_vnd::text, o.paid_at,
            count(pt.id)::int AS transaction_count,
            coalesce(sum(CASE WHEN pt.entry_type = 'credit' THEN pt.amount_vnd ELSE -pt.amount_vnd END), 0)::text AS ledger_vnd
       FROM orders o
       LEFT JOIN payment_transactions pt ON pt.order_id = o.id
      WHERE o.id = ANY($1::uuid[])
      GROUP BY o.id, o.payment_status, o.amount_paid_vnd, o.paid_at
      ORDER BY o.id`,
    [orderIds],
  )).rows;
  return rows;
}

const sameState = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const hiddenHas = (html, name, value) => new RegExp(
  `name="${name}" value="${String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`,
).test(html);

async function main() {
  const staffCookie = await makeStaff();
  const shop = await makeShopOwner(staffCookie);
  const manager = await makeOrderManager(staffCookie, shop.shopId);
  const variantId = await setupVariant(shop);
  const orders = [
    await createOrder(shop, variantId, 'đơn một'),
    await createOrder(shop, variantId, 'đơn hai'),
    await createOrder(shop, variantId, 'đơn ba'),
  ];
  const ownerCookie = await adminLogin(shop.email, shop.password);
  const managerCookie = await adminLogin(manager.email, manager.password);
  if (!ownerCookie || !managerCookie) throw new Error('không đăng nhập được seller-admin');

  section('Chủ shop chưa xác thực lại: mark-paid legacy hiện cổng mật khẩu và giữ dữ liệu');
  const markBefore = await moneyState([orders[0].id]);
  let response = await admin('POST', `/shops/${shop.shopId}/orders/${orders[0].id}/mark-paid`, {
    cookie: ownerCookie,
    form: { amount_vnd: '70000', note: 'khách trả trước 70 nghìn' },
  });
  const markAfter = await moneyState([orders[0].id]);
  response.status === 200
    && /Xác nhận ghi nhận khoản thu/.test(response.body)
    && new RegExp(`action="/shops/${shop.shopId}/orders/${orders[0].id}/mark-paid/step-up"`).test(response.body)
    && hiddenHas(response.body, 'amount_vnd', '70000')
    && hiddenHas(response.body, 'note', 'khách trả trước 70 nghìn')
    ? ok('mark-paid legacy hiện đúng interstitial và giữ số tiền/ghi chú')
    : bad('mark-paid legacy không hiện đúng interstitial', `${response.status} ${response.body.slice(0, 500)}`);
  sameState(markBefore, markAfter)
    ? ok('chưa nhập mật khẩu thì sổ tiền và trạng thái đơn chưa đổi')
    : bad('mark-paid đã ghi tiền trước khi xác thực lại', JSON.stringify({ markBefore, markAfter }));

  section('Hàng loạt: giữ đủ đơn đã chọn và toàn bộ bộ lọc qua interstitial');
  const filters = {
    status: 'pending',
    q: 'Khách đơn',
    from: '2026-08-01',
    to: '2026-08-13',
    source: 'manual',
    payment: 'unpaid',
    limit: '50',
    offset: '20',
  };
  const bulkForm = orders.map((order) => ['order_ids', order.id]);
  for (const [name, value] of Object.entries(filters)) bulkForm.push([name, value]);
  const bulkBefore = await moneyState(orders.map((order) => order.id));
  response = await admin('POST', `/shops/${shop.shopId}/orders/bulk-mark-paid`, {
    cookie: ownerCookie,
    form: bulkForm,
  });
  const bulkAfter = await moneyState(orders.map((order) => order.id));
  const keptOrders = orders.every((order) => hiddenHas(response.body, 'order_ids', order.id));
  const keptFilters = Object.entries(filters).every(([name, value]) => hiddenHas(response.body, name, value));
  response.status === 200
    && /Xác nhận ghi nhận tiền COD hàng loạt/.test(response.body)
    && /3 đơn đã chọn/.test(response.body)
    && keptOrders
    && keptFilters
    ? ok('bulk interstitial giữ đủ 3 order_ids và status/q/from/to/source/payment/limit/offset')
    : bad('bulk interstitial làm mất đơn hoặc bộ lọc', `${response.status} orders=${keptOrders} filters=${keptFilters}`);
  sameState(bulkBefore, bulkAfter)
    ? ok('chưa nhập mật khẩu thì bulk không ghi tiền cho bất kỳ đơn nào')
    : bad('bulk đã ghi tiền trước khi xác thực lại', JSON.stringify({ bulkBefore, bulkAfter }));

  section('order_manager không thấy nút bulk tiền và POST bị chặn');
  response = await admin('GET', `/shops/${shop.shopId}/orders?status=pending&limit=50`, {
    cookie: managerCookie,
  });
  response.status === 200
    && !/formaction="\/shops\/[0-9a-f-]+\/orders\/bulk-mark-paid"/.test(response.body)
    && !/Đã nhận tiền \(COD\)/.test(response.body)
    ? ok('danh sách của order_manager không render nút nhận tiền hàng loạt')
    : bad('order_manager vẫn nhìn thấy nút bulk tiền', response.body.match(/bulk-mark-paid[\s\S]{0,180}/)?.[0] ?? response.status);
  const managerBefore = await moneyState([orders[1].id]);
  response = await admin('POST', `/shops/${shop.shopId}/orders/bulk-mark-paid`, {
    cookie: managerCookie,
    form: [['order_ids', orders[1].id], ['status', 'pending']],
  });
  const managerAfter = await moneyState([orders[1].id]);
  response.status === 403
    ? ok('order_manager POST bulk-mark-paid bị chặn 403')
    : bad('order_manager POST bulk-mark-paid không bị chặn', `${response.status} ${response.location ?? ''}`);
  sameState(managerBefore, managerAfter)
    ? ok('POST bị chặn không thay đổi cache, ledger hoặc trạng thái thanh toán')
    : bad('POST của order_manager vẫn làm đổi tiền', JSON.stringify({ managerBefore, managerAfter }));

  section('Mật khẩu sai ở mark-paid: 401, giữ input và không đổi DB');
  const wrongMarkBefore = await moneyState([orders[0].id]);
  response = await admin('POST', `/shops/${shop.shopId}/orders/${orders[0].id}/mark-paid/step-up`, {
    cookie: ownerCookie,
    form: { amount_vnd: '70000', note: 'khách trả trước 70 nghìn', password: 'mật khẩu sai hoàn toàn' },
  });
  const wrongMarkAfter = await moneyState([orders[0].id]);
  response.status === 401
    && /Mật khẩu không đúng/.test(response.body)
    && hiddenHas(response.body, 'amount_vnd', '70000')
    && hiddenHas(response.body, 'note', 'khách trả trước 70 nghìn')
    ? ok('mark-paid sai mật khẩu trả 401 và giữ nguyên số tiền/ghi chú')
    : bad('mark-paid sai mật khẩu không giữ đúng interstitial', `${response.status} ${response.body.slice(0, 500)}`);
  sameState(wrongMarkBefore, wrongMarkAfter)
    ? ok('mark-paid sai mật khẩu không tạo transaction hoặc đổi số dư')
    : bad('mark-paid sai mật khẩu vẫn làm đổi DB', JSON.stringify({ wrongMarkBefore, wrongMarkAfter }));

  section('Mật khẩu sai ở bulk: 401, giữ đơn/bộ lọc và không đổi DB');
  const wrongBulkBefore = await moneyState(orders.map((order) => order.id));
  response = await admin('POST', `/shops/${shop.shopId}/orders/bulk-mark-paid/step-up`, {
    cookie: ownerCookie,
    form: [...bulkForm, ['password', 'mật khẩu bulk cũng sai']],
  });
  const wrongBulkAfter = await moneyState(orders.map((order) => order.id));
  const wrongKeptOrders = orders.every((order) => hiddenHas(response.body, 'order_ids', order.id));
  const wrongKeptFilters = Object.entries(filters).every(([name, value]) => hiddenHas(response.body, name, value));
  response.status === 401
    && /Mật khẩu không đúng/.test(response.body)
    && wrongKeptOrders
    && wrongKeptFilters
    ? ok('bulk sai mật khẩu trả 401 và giữ đủ đơn cùng toàn bộ bộ lọc')
    : bad('bulk sai mật khẩu làm mất input', `${response.status} orders=${wrongKeptOrders} filters=${wrongKeptFilters}`);
  sameState(wrongBulkBefore, wrongBulkAfter)
    ? ok('bulk sai mật khẩu không ghi transaction cho bất kỳ đơn nào')
    : bad('bulk sai mật khẩu vẫn làm đổi DB', JSON.stringify({ wrongBulkBefore, wrongBulkAfter }));

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await owner.end().catch(() => {});
  process.exit(1);
});
