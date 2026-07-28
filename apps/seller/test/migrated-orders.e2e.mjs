/**
 * E2E BẤT BIẾN TIỀN cho ĐƠN DI CƯ (0104, docs/45). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/migrated-orders.e2e.mjs
 *
 * Chủ nền tảng đã chốt: đơn cũ mang từ sàn khác sang KHÔNG tính vào doanh thu, báo cáo lãi,
 * đối soát COD hay điểm thưởng — chúng chỉ để TRA CỨU và gộp thành hồ sơ khách hàng.
 *
 * Bộ test này là LƯỚI AN TOÀN của quyết định đó. Cách kiểm: đo mọi con số tiền TRƯỚC, chèn
 * đơn di cư với TỔNG TIỀN RẤT LỚN, đo lại và đòi hỏi KHÔNG MỘT SỐ NÀO NHÚC NHÍCH. Số tiền
 * cố ý lớn bất thường (900 triệu) để nếu lọt vào bất kỳ phép cộng nào thì lệch là hiển nhiên,
 * không thể lẫn vào sai số.
 *
 * Vì sao chèn thẳng bằng SQL chứ không qua endpoint nhập: bộ test này kiểm PHẦN LOẠI TRỪ,
 * độc lập với việc bộ nhập được viết thế nào. Endpoint có thể đổi; bất biến thì không.
 */

import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
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
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;

async function makeStaff() {
  const email = `staff-${uniq()}@nentang.vn`, password = 'staff strong passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let r = await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA });
  let cookie = ck(r.sc);
  r = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie, origin: OA });
  const key = base32Decode(r.json.secret);
  await rq(AUTH, 'POST', '/auth/mfa/activate', { cookie, body: { code: totp(key, {}) }, origin: OA });
  const c = counterFor(Date.now());
  await owner.query(`INSERT INTO platform_staff (user_id,role) VALUES ($1,'admin')`, [await uidOf(email)]);
  while (counterFor(Date.now()) <= c) await sleep(1000);
  r = await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA });
  cookie = ck(r.sc);
  cookie = ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA })).sc) ?? cookie;
  return cookie;
}
async function makeShopOwner(staffCookie, slug) {
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  r = await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA });
  return { shopId, cookie: ck(r.sc) };
}

/** Chèn một đơn ĐÃ TRẢ thẳng bằng SQL chủ sở hữu. migrated=true ⇒ đơn di cư. */
async function insertOrder(shopId, { num, total, phone, name, migrated, daysAgo = 3 }) {
  const { rows } = await owner.query(
    `INSERT INTO orders (shop_id, order_number, status, payment_status, total_vnd, subtotal_vnd,
                         shipping_vnd, discount_vnd, amount_paid_vnd, payment_method,
                         customer_name, customer_phone, created_at, paid_at, delivered_at,
                         fulfillment_status, is_migrated)
     VALUES ($1, $2, 'delivered', 'paid', $3, $3, 0, 0, $3, 'cod', $4, $5,
             now() - make_interval(days => $6), now() - make_interval(days => $6),
             now() - make_interval(days => $6), 'fulfilled', $7)
     RETURNING id`,
    [shopId, num, total, name, phone, daysAgo, migrated],
  );
  return rows[0].id;
}

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `mig-${uniq()}`);
  const get = (p) => rq(SELLER, 'GET', `/shops/${A.shopId}${p}`, { cookie: A.cookie });
  ok('dựng shop + chủ shop');

  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const snapshot = async () => {
    const st = (await get('/stats')).json;
    const rp = (await get(`/reports/sales?from=${from}&to=${today}`)).json;
    const cod = (await get('/cod/reconciliation')).json;
    return {
      revToday: Number(st?.revenue?.today ?? 0),
      revD7: Number(st?.revenue?.d7 ?? 0),
      revAll: Number(st?.revenue?.all ?? 0),
      ordersToday: Number(st?.orders_today ?? 0),
      byStatus: JSON.stringify(st?.by_status ?? {}),
      unpaid: Number(st?.unpaid ?? 0),
      pnlRevenue: Number(rp?.totals?.net_revenue_vnd ?? 0),
      pnlOrders: Number(rp?.totals?.orders_paid ?? 0),
      pnlProfit: Number(rp?.totals?.gross_profit_vnd ?? 0),
      codOutstanding: Number(cod?.total_outstanding_vnd ?? 0),
      codCount: (cod?.outstanding ?? []).length,
    };
  };

  // ── 1. Một đơn THẬT trên nền tảng này ───────────────────────────────────
  sect('1. Nền: một đơn thật đã thanh toán');
  await insertOrder(A.shopId, { num: 1, total: 500_000, phone: '0900000001', name: 'Khách thật', migrated: false });
  const before = await snapshot();
  before.revAll === 500_000 && before.pnlRevenue === 500_000
    ? ok(`đơn thật vào doanh thu: tất cả ${before.revAll} · P&L ${before.pnlRevenue}`)
    : bad('đơn thật không vào doanh thu', JSON.stringify(before));

  // ── 2. Chèn đơn DI CƯ với số tiền RẤT LỚN ───────────────────────────────
  sect('2. Chèn 3 đơn di cư, tổng 900 triệu');
  // Số lớn bất thường: nếu lọt vào bất kỳ phép cộng nào thì lệch là hiển nhiên.
  for (let i = 0; i < 3; i++) {
    await insertOrder(A.shopId, {
      num: 100 + i, total: 300_000_000, phone: `090111222${i}`, name: `Khách cũ ${i}`,
      migrated: true, daysAgo: i,   // daysAgo=0 ⇒ RƠI ĐÚNG hôm nay, ép cả ô "doanh thu hôm nay"
    });
  }
  const after = await snapshot();

  // ── 3. BẤT BIẾN: không một con số tiền nào được nhúc nhích ──────────────
  sect('3. Bất biến: mọi con số tiền GIỮ NGUYÊN');
  const fields = [
    ['revToday', 'doanh thu hôm nay'], ['revD7', 'doanh thu 7 ngày'], ['revAll', 'tổng đã thu'],
    ['ordersToday', 'số đơn hôm nay'], ['byStatus', 'đếm theo trạng thái'], ['unpaid', 'đơn chưa thu tiền'],
    ['pnlRevenue', 'P&L doanh thu thuần'], ['pnlOrders', 'P&L số đơn đã trả'], ['pnlProfit', 'P&L lãi gộp'],
    ['codOutstanding', 'COD chờ đối soát (tiền)'], ['codCount', 'COD chờ đối soát (số đơn)'],
  ];
  const moved = fields.filter(([k]) => String(before[k]) !== String(after[k]));
  moved.length === 0
    ? ok(`cả ${fields.length} con số GIỮ NGUYÊN sau khi thêm 900 triệu đơn di cư`)
    : bad('đơn di cư LỌT vào số liệu tiền',
        moved.map(([k, vi]) => `${vi}: ${before[k]} → ${after[k]}`).join(' | '));

  // ── 4. Nhưng khách hàng thì PHẢI có ─────────────────────────────────────
  sect('4. Ngược lại: hồ sơ khách hàng PHẢI nhận đơn di cư');
  const cus = (await get('/customers?limit=50')).json;
  const list = cus?.customers ?? [];
  const oldOnes = list.filter((c) => String(c.phone).startsWith('09011122'));
  oldOnes.length === 3 && oldOnes.every((c) => Number(c.total_spent_vnd) === 300_000_000)
    ? ok('3 khách cũ xuất hiện kèm tổng chi đúng — đây CHÍNH LÀ giá trị của việc nhập đơn cũ')
    : bad('khách cũ không vào hồ sơ khách', JSON.stringify(oldOnes.map((c) => [c.phone, c.total_spent_vnd])));

  // ── 5. Sweep tích điểm không được đụng đơn di cư ────────────────────────
  sect('5. Điểm thưởng: đơn di cư không sinh điểm');
  // Bật điểm thưởng rồi ép điều kiện tích (vesting 0 ngày) — nếu lọt, 900 triệu sẽ đẻ ra
  // một khoản NỢ điểm khổng lồ không có doanh thu nào đối ứng.
  await owner.query(
    `INSERT INTO shop_loyalty_config (shop_id, enabled, earn_points_per_1000, earn_vesting_days)
     VALUES ($1, true, 1, 0) ON CONFLICT (shop_id) DO UPDATE SET enabled = true, earn_vesting_days = 0`,
    [A.shopId],
  ).catch(() => {});
  const led = await owner.query(
    `SELECT count(*)::int n FROM loyalty_ledger l JOIN orders o ON o.id = l.order_id
      WHERE o.shop_id = $1 AND o.is_migrated`, [A.shopId]);
  Number(led.rows[0].n) === 0
    ? ok('không có bút toán điểm nào gắn với đơn di cư')
    : bad('đơn di cư sinh điểm thưởng', String(led.rows[0].n));

  // ── 6. Endpoint NHẬP ĐƠN CŨ ─────────────────────────────────────────────
  sect('6. Nhập đơn cũ qua endpoint');
  const post = (p2, body) => rq(SELLER, 'POST', `/shops/${A.shopId}${p2}`, { body, cookie: A.cookie, origin: OS });
  const impRows = [
    { order_code: 'SPE-001', date: '15/06/2026', customer_name: 'Phạm Thị Lan', customer_phone: '0933444555', total_vnd: '1.250.000', status: 'delivered', payment_status: 'paid', address: '12 Lê Lợi', province: 'Đà Nẵng' },
    { order_code: 'SPE-002', date: '2026-06-20', customer_name: 'Phạm Thị Lan', customer_phone: '0933444555', total_vnd: '750000' },
    { order_code: 'SPE-003', date: '01/07/2026', customer_name: 'Đơn huỷ', customer_phone: '0933444666', total_vnd: '99000', status: 'đã huỷ' },
  ];

  let ir = await post('/orders/import', { rows: impRows, dry_run: true });
  const beforeImp = await snapshot();
  ir.status === 200 && ir.json?.dry_run === true && ir.json?.created === 3 && ir.json?.customers === 2
    ? ok('xem trước: 3 đơn / 2 khách, chưa ghi gì')
    : bad('xem trước đơn cũ sai', JSON.stringify(ir.json));

  ir = await post('/orders/import', { rows: impRows });
  ir.status === 200 && ir.json?.created === 3 && ir.json?.duplicate === 0
    ? ok('nhập thật: 3 đơn cũ vào hệ thống')
    : bad('nhập đơn cũ lỗi', JSON.stringify(ir.json));

  // Bất biến tiền phải GIỮ NGUYÊN kể cả khi đơn vào qua ĐƯỜNG CHÍNH THỨC (không chỉ SQL tay).
  const afterImp = await snapshot();
  JSON.stringify(beforeImp) === JSON.stringify(afterImp)
    ? ok('sau khi nhập qua endpoint, mọi con số tiền VẪN không đổi')
    : bad('nhập qua endpoint làm lệch số liệu tiền',
        fields.filter(([k]) => String(beforeImp[k]) !== String(afterImp[k])).map(([k]) => `${k}: ${beforeImp[k]}→${afterImp[k]}`).join(' | '));

  // ── 7. Nhập LẠI cùng tệp → KHÔNG nhân đôi ───────────────────────────────
  sect('7. Nhập lại cùng tệp: chống nhân đôi tổng chi của khách');
  const spentOf = async (phone) => {
    const cs = (await get(`/customers?limit=50&q=${phone}`)).json;
    return Number((cs?.customers ?? []).find((c) => c.phone === phone)?.total_spent_vnd ?? 0);
  };
  const spentBefore = await spentOf('0933444555');
  ir = await post('/orders/import', { rows: impRows });
  const spentAfter = await spentOf('0933444555');
  ir.json?.created === 0 && ir.json?.duplicate === 3 && spentAfter === spentBefore
    ? ok(`nhập lại → 0 tạo mới, 3 bỏ qua trùng; tổng chi của khách GIỮ NGUYÊN ${spentAfter}`)
    : bad('nhập lại nhân đôi dữ liệu', `created=${ir.json?.created} dup=${ir.json?.duplicate} ${spentBefore}→${spentAfter}`);
  spentBefore === 2_000_000
    ? ok('tổng chi = 1.250.000 + 750.000 (đơn huỷ của khách khác không lẫn vào)')
    : bad('tổng chi sai', String(spentBefore));

  // ── 8. Từ chối dữ liệu làm hỏng hồ sơ khách ─────────────────────────────
  sect('8. Từ chối dòng hỏng');
  ir = await post('/orders/import', { rows: [
    { order_code: 'X1', date: '01/01/2026', customer_phone: '', total_vnd: '1000' },
    { order_code: 'X2', date: '01/01/2099', customer_phone: '0900000009', total_vnd: '1000' },
    { order_code: 'X3', date: 'không phải ngày', customer_phone: '0900000009', total_vnd: '1000' },
    { order_code: 'X4', date: '01/01/2026', customer_phone: '0900000009', total_vnd: 'abc' },
  ] });
  ir.json?.created === 0 && ir.json?.failed === 4
    && /điện thoại/.test(ir.json.errors[0].error) && /tương lai/.test(ir.json.errors[1].error)
    ? ok('thiếu SĐT / ngày tương lai / ngày rác / tiền rác → cả 4 bị từ chối kèm lý do')
    : bad('dòng hỏng lọt qua', JSON.stringify(ir.json?.errors));

  // Không đụng tồn kho: đơn cũ là hàng đã giao ở sàn khác từ lâu.
  const ledger = await owner.query(
    `SELECT count(*)::int n FROM inventory_ledger WHERE shop_id = $1`, [A.shopId]);
  Number(ledger.rows[0].n) === 0
    ? ok('nhập đơn cũ KHÔNG ghi sổ cái kho (không trừ kho lần hai → không đẻ âm kho)')
    : bad('đơn cũ đụng tồn kho', String(ledger.rows[0].n));

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
