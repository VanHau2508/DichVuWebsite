/**
 * ĐƠN CHỜ TẠO (0186) — cửa /ingest/* đọc trạng thái cửa hàng. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/held-orders.e2e.mjs
 *
 * Đo lại chính thứ đã đo tay ngày 07/09 và ra bảng này TRƯỚC khi vá:
 *
 *     shops.status   storefront   POST /ingest/orders   tồn
 *     active         200          201                   giữ chỗ +1
 *     suspended      503          201                   giữ chỗ +1
 *     terminated     404          201                   giữ chỗ +1
 *
 * Bộ này canh cả hai chiều, vì thiếu chiều thuận thì một bản "chặn hết" cũng đi lọt:
 *   · shop ĐANG BÁN vẫn tạo đơn thật và KHÔNG đẻ dòng chờ nào;
 *   · shop TẠM NGƯNG nhận 202, KHÔNG có đơn, KHÔNG đụng `reserved`;
 *   · shop ĐÃ CHẤM DỨT bị từ chối ở MỌI đường /ingest/*;
 *   · chốt lúc còn tạm ngưng → 409 (không giữ chỗ hàng cho shop đang bị khoá);
 *   · mở lại rồi chốt → đơn thật + `reserved` +1 + dòng chờ đóng lại.
 *
 * Khẳng định đặt ở BỀ MẶT NGƯỜI BÁN NHÌN THẤY chứ không chỉ ở API (§4): trang admin phải
 * hiện tên khách và hai nút, và sau khi chốt phải hiện link đơn.
 */
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3050';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const inviteTokenOf = async (e) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [e]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${String(d).slice(0, 300)}${X}`); };
const sect = (m) => console.log(`\n${B}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };

async function rq(base, method, path, { body, cookie, origin, bearer } = {}) {
  const h = {};
  if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  if (bearer) h.authorization = `Bearer ${bearer}`;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t, location: r.headers.get('location') };
}
const login = async (e, p) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email: e, password: p }, origin: OA })).sc);
const uidOf = async (e) => (await owner.query('SELECT id FROM users WHERE email=$1', [e])).rows[0]?.id ?? null;

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
  return { cookie, password };
}
async function makeShopOwner(staffCookie, slug) {
  const r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'growth' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, slug, email, password, cookie: await login(email, password) };
}
async function addMember(shop, role) {
  const email = `m-${role}-${uniq()}@shop.vn`, password = 'member passphrase strong';
  const su = await rq(AUTH, 'POST', '/auth/step-up', { body: { password: shop.password }, cookie: shop.cookie, origin: OA });
  shop.cookie = ck(su.sc) ?? shop.cookie;
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/members/invite`, { body: { email, role }, cookie: shop.cookie, origin: OS });
  if (![200, 201].includes(r.status)) throw new Error(`mời ${role}: ${r.status} ${r.raw}`);
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { cookie: await login(email, password), role };
}

async function main() {
  const staff = await makeStaff();
  const S = await makeShopOwner(staff.cookie, `hold-${uniq()}`);
  let r = await rq(SELLER, 'POST', `/shops/${S.shopId}/products`, {
    body: { title: 'Áo thun chờ', slug: `ao-${uniq()}`, price_vnd: 120000, status: 'active', variants: [{ sku: `S-${uniq()}`, price_vnd: 120000 }] },
    cookie: S.cookie, origin: OS });
  const pid = r.json.id;
  const vid = (await rq(SELLER, 'GET', `/shops/${S.shopId}/products/${pid}`, { cookie: S.cookie })).json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${S.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: 30, reason: 'nhập' }, cookie: S.cookie, origin: OS });
  const su = await rq(AUTH, 'POST', '/auth/step-up', { body: { password: S.password }, cookie: S.cookie, origin: OA });
  S.cookie = ck(su.sc) ?? S.cookie;
  const token = (await rq(SELLER, 'POST', `/shops/${S.shopId}/api-keys`, { body: { name: 'Pancake' }, cookie: S.cookie, origin: OS })).json.token;

  const CUST = { name: 'Khách Chờ Tạo', phone: '0912345678', address_line: '5 Lê Lợi', province: 'TP. Hồ Chí Minh' };
  const push = (idem) => rq(SELLER, 'POST', '/ingest/orders', {
    bearer: token,
    body: { lines: [{ variant_id: vid, qty: 1 }], customer: CUST, payment_method: 'cod', source: 'facebook', idempotency_key: idem ?? `fb-${uniq()}` },
  });
  const reserved = async () => Number((await owner.query('SELECT reserved FROM inventory_levels WHERE variant_id=$1', [vid])).rows[0].reserved);
  const nOrders = async () => Number((await owner.query('SELECT count(*)::int n FROM orders WHERE shop_id=$1', [S.shopId])).rows[0].n);
  const nHeld = async () => Number((await owner.query('SELECT count(*)::int n FROM held_ingest_orders WHERE shop_id=$1 AND resolved_at IS NULL', [S.shopId])).rows[0].n);
  const setStatus = async (st) => owner.query(`UPDATE shops SET status=$2, deleted_at = CASE WHEN $2='terminated' THEN now() ELSE NULL END WHERE id=$1`, [S.shopId, st]);
  const todoOf = async (code) => {
    const st = await rq(SELLER, 'GET', `/shops/${S.shopId}/stats`, { cookie: S.cookie });
    return (st.json?.todo_items ?? []).find((x) => x.code === code) ?? null;
  };

  sect('1. Shop ĐANG BÁN — chiều thuận: đơn thật, KHÔNG đẻ dòng chờ');
  await setStatus('active');
  let res0 = await reserved();
  r = await push();
  r.status === 201 ? ok('shop active → 201 đơn thật') : bad(`shop active không tạo được đơn (${r.status})`, r.raw);
  (await reserved()) === res0 + 1 ? ok('giữ chỗ tồn +1 như trước') : bad('không giữ chỗ tồn cho shop đang bán');
  (await nHeld()) === 0 ? ok('KHÔNG có dòng chờ nào (chiều ngược lại của mọi chốt dưới)') : bad('shop đang bán mà vẫn đẻ đơn chờ!');

  sect('2. Shop TẠM NGƯNG — nhận, nhưng không đơn và KHÔNG giữ chỗ tồn');
  await setStatus('suspended');
  res0 = await reserved();
  const ord0 = await nOrders();
  const idem = `held-${uniq()}`;
  r = await push(idem);
  const heldId = r.json?.held_id;
  r.status === 202 && r.json?.held === true && heldId
    ? ok('POST /ingest/orders → 202 held (không phải 201, không phải lỗi)') : bad(`tạm ngưng vẫn tạo đơn hoặc trả sai (${r.status})`, r.raw);
  (await nOrders()) === ord0 ? ok('KHÔNG có đơn nào được tạo') : bad('tạm ngưng mà vẫn đẻ đơn thật!');
  (await reserved()) === res0 ? ok('reserved KHÔNG đổi — không giữ chỗ hàng') : bad(`reserved đổi ${res0} → ${await reserved()}`);
  // Câu trả lời phải nói đủ: đã nhận, CHƯA thành đơn, chưa trừ hàng.
  /chưa trừ hàng/.test(r.json?.message ?? '') && /xác nhận lại/.test(r.json?.message ?? '')
    ? ok('câu trả lời nói rõ "chưa trừ hàng" + "chờ xác nhận lại"') : bad('câu trả lời cho tích hợp mơ hồ', r.raw);
  const cat = await rq(SELLER, 'GET', '/ingest/catalog', { bearer: token });
  cat.status === 200 ? ok('/ingest/catalog VẪN mở khi tạm ngưng (bot còn phải trả lời khách)') : bad(`catalog bị cắt khi tạm ngưng (${cat.status})`);

  sect('3. Tích hợp gửi lại cùng idempotency_key → MỘT dòng chờ');
  const again = await push(idem);
  again.status === 202 && again.json?.held_id === heldId
    ? ok('gửi lại cùng khoá → trả đúng dòng chờ cũ') : bad('gửi lại đẻ dòng chờ thứ hai!', again.raw);
  (await nHeld()) === 1 ? ok('vẫn đúng 1 dòng chờ trong DB') : bad(`có ${await nHeld()} dòng chờ`);

  sect('4. Bề mặt: /stats, danh sách seller, trang admin');
  const td = await todoOf('held_orders');
  td && td.count === 1 && td.severity === 'khẩn'
    ? ok('/stats todo_items có held_orders = 1 (khẩn)') : bad('dây nối /stats đứt', JSON.stringify(td));
  const list = await rq(SELLER, 'GET', `/shops/${S.shopId}/held-orders`, { cookie: S.cookie });
  const item = (list.json?.held ?? []).find((h) => h.id === heldId);
  item && item.customer_name === CUST.name && item.qty_total === 1
    ? ok('GET /held-orders trả đúng khách + số món') : bad('danh sách đơn chờ sai', list.raw);
  JSON.stringify(list.json).includes('address_line')
    ? bad('danh sách dội nguyên payload thô ra ngoài') : ok('danh sách KHÔNG dội payload thô (chỉ phần cần quyết định)');
  const page = await rq(ADMIN, 'GET', `/shops/${S.shopId}/held-orders`, { cookie: S.cookie });
  const html = page.raw ?? '';
  page.status === 200 && html.includes(CUST.name) ? ok('trang admin hiện tên khách') : bad(`trang admin ${page.status}`, html.slice(0, 200));
  /chưa giữ chỗ hàng/.test(html) ? ok('trang nói thẳng "chưa giữ chỗ hàng"') : bad('trang không nói rõ đây chưa phải đơn');
  new RegExp(`/held-orders/${heldId}/accept`).test(html) && new RegExp(`/held-orders/${heldId}/drop`).test(html)
    ? ok('trang có cả nút Tạo đơn thật và nút Bỏ') : bad('trang thiếu nút thao tác');

  sect('5. Quyền: order_manager đọc được, catalog_manager không');
  await setStatus('active');           // mời thành viên cần shop bình thường
  const om = await addMember(S, 'order_manager');
  const cm = await addMember(S, 'catalog_manager');
  await setStatus('suspended');
  (await rq(SELLER, 'GET', `/shops/${S.shopId}/held-orders`, { cookie: om.cookie })).status === 200
    ? ok('order_manager xem được đơn chờ') : bad('order_manager bị chặn');
  (await rq(SELLER, 'GET', `/shops/${S.shopId}/held-orders`, { cookie: cm.cookie })).status === 403
    ? ok('catalog_manager → 403') : bad('catalog_manager xem được đơn chờ!');
  (await rq(SELLER, 'POST', `/shops/${S.shopId}/held-orders/${heldId}/accept`, { cookie: cm.cookie, origin: OS })).status === 403
    ? ok('catalog_manager không chốt được') : bad('catalog_manager chốt được đơn chờ!');

  sect('6. Chốt khi CÒN tạm ngưng → 409, và vẫn không giữ chỗ hàng');
  res0 = await reserved();
  r = await rq(SELLER, 'POST', `/shops/${S.shopId}/held-orders/${heldId}/accept`, { cookie: S.cookie, origin: OS });
  r.status === 409 ? ok('chốt lúc tạm ngưng → 409') : bad(`chốt lọt khi còn tạm ngưng (${r.status})`, r.raw);
  /chưa hoạt động lại/.test(r.json?.error ?? '') ? ok('lý do nói đúng việc cần làm (mở lại cửa hàng)') : bad('lý do 409 mơ hồ', r.raw);
  (await reserved()) === res0 ? ok('reserved vẫn không đổi') : bad('chốt hụt vẫn giữ chỗ hàng!');

  sect('7. Mở lại → chốt → đơn thật + giữ chỗ tồn + dòng chờ đóng');
  await setStatus('active');
  const ordBefore = await nOrders();
  res0 = await reserved();
  r = await rq(SELLER, 'POST', `/shops/${S.shopId}/held-orders/${heldId}/accept`, { cookie: S.cookie, origin: OS });
  r.status === 201 && r.json?.order_number ? ok(`chốt → đơn thật #${r.json.order_number}`) : bad(`chốt lỗi (${r.status})`, r.raw);
  (await nOrders()) === ordBefore + 1 ? ok('đúng MỘT đơn được tạo') : bad('số đơn sai sau khi chốt');
  (await reserved()) === res0 + 1 ? ok('giữ chỗ tồn +1 ĐÚNG LÚC CHỐT (không phải lúc nhận)') : bad('chốt xong vẫn không giữ chỗ hàng!');
  const row = (await owner.query('SELECT resolution, order_id, resolved_at FROM held_ingest_orders WHERE id=$1', [heldId])).rows[0];
  row.resolution === 'accepted' && row.order_id === r.json.id && row.resolved_at
    ? ok("dòng chờ đóng lại: resolution='accepted' + trỏ đúng đơn") : bad('dòng chờ không đóng đúng', JSON.stringify(row));
  const o = (await owner.query('SELECT source, api_key_id, paid_at FROM orders WHERE id=$1', [r.json.id])).rows[0];
  o.source === 'facebook' && o.api_key_id && o.paid_at === null
    ? ok('đơn giữ nguyên nguồn + dấu khoá, và CHƯA thu tiền') : bad('đơn chốt ra sai', JSON.stringify(o));
  // AI làm ≠ đơn ĐẾN TỪ ĐÂU. Đơn giữ dấu khoá (đến từ bot) nhưng người bấm nút là người
  // thật, nên nhật ký phải ghi 'user' + id của họ. Chiều ngược lại đã có ở api-keys.e2e:
  // đường /ingest thuần vẫn phải là 'system' + actor_id NULL.
  const uid = (await owner.query('SELECT id FROM users WHERE email=$1', [S.email])).rows[0].id;
  const aud = (await owner.query(
    `SELECT actor_type, actor_id FROM audit_logs
      WHERE action='order.created_manual' AND metadata->>'order_number'=$1
      ORDER BY id DESC LIMIT 1`, [String(r.json.order_number)])).rows[0];
  aud?.actor_type === 'user' && aud.actor_id === uid
    ? ok("nhật ký ghi actor_type='user' + đúng người bấm nút (không phải 'system')")
    : bad('nhật ký gán nhầm actor cho đơn do người bán chốt', JSON.stringify(aud));

  const again2 = await rq(SELLER, 'POST', `/shops/${S.shopId}/held-orders/${heldId}/accept`, { cookie: S.cookie, origin: OS });
  again2.status === 409 ? ok('chốt lần hai → 409') : bad(`chốt lặp trả ${again2.status}`, again2.raw);
  const page2 = await rq(ADMIN, 'GET', `/shops/${S.shopId}/held-orders?resolved=1`, { cookie: S.cookie });
  new RegExp(`Đã tạo đơn #${r.json.order_number}`).test(page2.raw ?? '')
    ? ok('trang hiện "Đã tạo đơn #N" cho dòng đã chốt') : bad('trang không cho biết dòng chờ đã thành đơn nào');

  sect('8. BỎ một đơn chờ');
  await setStatus('suspended');
  const h2 = (await push()).json.held_id;
  await setStatus('active');
  const ordB2 = await nOrders();
  r = await rq(SELLER, 'POST', `/shops/${S.shopId}/held-orders/${h2}/drop`, { cookie: S.cookie, origin: OS });
  r.status === 200 ? ok('bỏ đơn chờ → 200') : bad(`bỏ lỗi (${r.status})`, r.raw);
  (await nOrders()) === ordB2 ? ok('bỏ KHÔNG tạo đơn nào') : bad('bỏ mà vẫn đẻ đơn!');
  (await rq(SELLER, 'POST', `/shops/${S.shopId}/held-orders/${h2}/drop`, { cookie: S.cookie, origin: OS })).status === 404
    ? ok('bỏ lần hai → 404') : bad('bỏ lặp không bị chặn');
  (await rq(SELLER, 'POST', `/shops/${S.shopId}/held-orders/${h2}/accept`, { cookie: S.cookie, origin: OS })).status === 409
    ? ok('chốt một dòng ĐÃ BỎ → 409') : bad('chốt được dòng đã bỏ!');

  sect('8b. Tạo và bỏ đồng thời: dòng chờ phải cùng giao dịch với đơn thật');
  await setStatus('suspended');
  const raceHeld = (await push()).json.held_id;
  await setStatus('active');
  const raceOrders = await nOrders(), raceReserved = await reserved();
  const blocker = await owner.connect();
  const suspender = await owner.connect();
  let accepting, dropping;
  let suspending, suspendBlocked = false;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT variant_id FROM inventory_levels WHERE variant_id=$1 FOR UPDATE', [vid]);
    accepting = rq(SELLER, 'POST', `/shops/${S.shopId}/held-orders/${raceHeld}/accept`, { cookie: S.cookie, origin: OS });
    // Giữ tồn để dừng đúng GIỮA đường tạo đơn, không dựa vào sleep để đoán request đã tới.
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      waiting = (await owner.query(`SELECT 1 FROM pg_stat_activity
        WHERE usename='app_rw' AND wait_event_type='Lock'
          AND query LIKE 'SELECT on_hand, reserved FROM inventory_levels%'`)).rowCount > 0;
      if (waiting) break;
      await sleep(50);
    }
    if (!waiting) throw new Error('mốc chết: accept chưa chờ khoá tồn');
    // Dùng đúng UPDATE trạng thái mà khoá SHARE phải chặn, theo dõi PID riêng để
    // không nhận nhầm một truy vấn khác. Rollback sau phép đo để giữ fixture active.
    await suspender.query('BEGIN');
    const suspendPid = (await suspender.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let suspendDone = false;
    suspending = suspender.query("UPDATE shops SET status='suspended' WHERE id=$1", [S.shopId]);
    suspending.then(() => { suspendDone = true; });
    for (let attempt = 0; attempt < 100 && !suspendDone; attempt++) {
      suspendBlocked = (await owner.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [suspendPid])).rowCount > 0;
      if (suspendBlocked) break;
      await sleep(50);
    }
    // Nếu thiếu SHARE, trả fixture về active ngay để phép đo drop không mắc khoá FK
    // của chính updater; khẳng định suspendBlocked bên dưới vẫn phải đỏ.
    if (suspendDone) await suspender.query('ROLLBACK');
    dropping = rq(SELLER, 'POST', `/shops/${S.shopId}/held-orders/${raceHeld}/drop`, { cookie: S.cookie, origin: OS });
    let dropDone = false;
    dropping.then(() => { dropDone = true; });
    let dropWaiting = false;
    for (let attempt = 0; attempt < 100 && !dropDone; attempt++) {
      dropWaiting = (await owner.query(`SELECT 1 FROM pg_stat_activity
        WHERE usename='app_rw' AND wait_event_type='Lock'
          AND query LIKE 'UPDATE held_ingest_orders SET resolved_at%'`)).rowCount > 0;
      if (dropWaiting) break;
      await sleep(50);
    }
    if (!dropDone && !dropWaiting) throw new Error('mốc chết: drop chưa tới chốt tranh chấp');
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    if (suspending) await suspending;
    await suspender.query('ROLLBACK');
    suspender.release();
  }
  suspendBlocked ? ok('FOR SHARE giữ tạm-ngưng chờ tới cuối giao dịch chốt')
    : bad('tạm-ngưng chen được vào giữa giao dịch chốt đơn');
  const [acceptedRace, droppedRace] = await Promise.all([accepting, dropping]);
  const raceRow = (await owner.query('SELECT resolution, order_id FROM held_ingest_orders WHERE id=$1', [raceHeld])).rows[0];
  acceptedRace.status === 201 && droppedRace.status === 404 && raceRow.resolution === 'accepted'
      && raceRow.order_id === acceptedRace.json?.id
      && (await nOrders()) === raceOrders + 1 && (await reserved()) === raceReserved + 1
    ? ok('accept giữ khoá tới khi tạo xong: drop bị từ chối, dòng chờ và tồn khớp đơn')
    : bad('tạo/bỏ đồng thời làm dòng chờ lệch đơn hoặc tồn', JSON.stringify({ accept: acceptedRace.status, drop: droppedRace.status, row: raceRow }));

  sect('8c. Hết hàng lúc chốt: rollback và lý do đi tới trang admin');
  // Hai dòng: dòng đầu giữ chỗ được, dòng sau bị đơn thật tiêu hết tồn. Thứ tự UUID
  // trùng thứ tự khoá của sản phẩm nên lỗi xảy ra SAU một lần reserve thành công.
  const stockProduct = await rq(SELLER, 'POST', `/shops/${S.shopId}/products`, {
    cookie: S.cookie, origin: OS,
    body: { title: 'Hàng kiểm rollback', slug: `rollback-${uniq()}`, price_vnd: 120000, status: 'active',
      variants: [{ sku: `A-${uniq()}`, price_vnd: 120000 }, { sku: `B-${uniq()}`, price_vnd: 120000 }] },
  });
  if (stockProduct.status !== 201) throw new Error(`mốc chết: tạo sản phẩm rollback ${stockProduct.status} ${stockProduct.raw}`);
  const stockDetail = await rq(SELLER, 'GET', `/shops/${S.shopId}/products/${stockProduct.json.id}`, { cookie: S.cookie });
  const stockIds = stockDetail.json.variants.map((v) => v.id).sort((a, b) => a.localeCompare(b));
  if (stockIds.length !== 2) throw new Error('mốc chết: cần hai biến thể rollback');
  for (const id of stockIds) {
    const adjusted = await rq(SELLER, 'POST', `/shops/${S.shopId}/variants/${id}/inventory/adjust`, {
      cookie: S.cookie, origin: OS, body: { delta: 2, reason: 'nhập hàng kiểm chốt' },
    });
    if (adjusted.status !== 200) throw new Error(`mốc chết: nhập tồn ${adjusted.status}`);
  }
  await setStatus('suspended');
  const failKey = `fail-held-${uniq()}`;
  const failedHold = await rq(SELLER, 'POST', '/ingest/orders', { bearer: token,
    body: { lines: stockIds.map((id) => ({ variant_id: id, qty: 1 })), customer: CUST, idempotency_key: failKey },
  });
  if (failedHold.status !== 202) throw new Error(`mốc chết: gieo đơn chờ ${failedHold.status}`);
  await setStatus('active');
  const exhausted = await rq(SELLER, 'POST', '/ingest/orders', { bearer: token,
    body: { lines: [{ variant_id: stockIds[1], qty: 2 }], customer: CUST, idempotency_key: `consume-${uniq()}` },
  });
  if (exhausted.status !== 201) throw new Error(`mốc chết: tiêu tồn qua đơn thật ${exhausted.status} ${exhausted.raw}`);
  const stockState = async () => (await owner.query('SELECT variant_id, on_hand, reserved FROM inventory_levels WHERE variant_id=ANY($1::uuid[]) ORDER BY variant_id', [stockIds])).rows;
  const beforeStock = await stockState(), beforeOrders = await nOrders();
  const failId = failedHold.json.held_id;
  const acceptPath = `/shops/${S.shopId}/held-orders/${failId}/accept`;
  const rejected = await rq(SELLER, 'POST', acceptPath, { cookie: S.cookie, origin: OS });
  rejected.status === 422 && /hết hàng/.test(rejected.json?.error ?? '')
    ? ok('accept hết hàng → 422 kèm lý do nghiệp vụ') : bad('accept hết hàng bị nuốt lỗi', rejected.raw);
  const adminReject = await rq(ADMIN, 'POST', acceptPath, { cookie: S.cookie, origin: 'https://admin.localtest', body: {} });
  const redirectUrl = adminReject.location ? new URL(adminReject.location, ADMIN) : null;
  if (![302, 303].includes(adminReject.status) || redirectUrl?.pathname !== `/shops/${S.shopId}/held-orders`) {
    bad('admin không redirect về đơn chờ khi chốt hụt', `${adminReject.status} ${adminReject.location}`);
  } else {
    const errorPage = await rq(ADMIN, 'GET', redirectUrl.pathname + redirectUrl.search, { cookie: S.cookie });
    const visibleError = /<div class="err">([^<]*)<\/div>/.exec(errorPage.raw)?.[1] ?? '';
    errorPage.status === 200 && /hết hàng/.test(redirectUrl.searchParams.get('error') ?? '') && /hết hàng/.test(visibleError)
      ? ok('lý do hết hàng đi qua redirect và hiện trên trang admin')
      : bad('đứt dây lỗi hết hàng tới trang admin', `${adminReject.location} HTTP ${errorPage.status}`);
  }
  JSON.stringify(await stockState()) === JSON.stringify(beforeStock) && await nOrders() === beforeOrders
    ? ok('chốt hụt rollback reserve dòng đầu, không tạo đơn') : bad('chốt hụt đổi tồn hoặc tạo đơn');
  const failedRow = (await owner.query('SELECT resolved_at, resolution, order_id FROM held_ingest_orders WHERE id=$1', [failId])).rows[0];
  failedRow.resolved_at === null && failedRow.resolution === null && failedRow.order_id === null
    ? ok('chốt hụt giữ nguyên dòng chờ chưa xử lý') : bad('chốt hụt đánh dấu đã xử lý', JSON.stringify(failedRow));
  const claimLeft = (await owner.query('SELECT 1 FROM idempotency_keys WHERE shop_id=$1 AND key=$2', [S.shopId, failKey])).rowCount;
  claimLeft === 0 ? ok('chốt hụt rollback cả idempotency claim để còn thử lại') : bad('chốt hụt để lại claim');

  sect('9. Shop ĐÃ CHẤM DỨT — đóng CẢ cửa');
  await setStatus('terminated');
  const ordT = await nOrders(); const heldT = await nHeld();
  r = await push();
  r.status === 403 ? ok('POST /ingest/orders → 403') : bad(`shop terminated vẫn nhận đơn (${r.status})`, r.raw);
  /đã đóng/.test(r.json?.error ?? '') ? ok('câu từ chối nói cửa hàng đã đóng (không phải "khoá sai")') : bad('câu từ chối sai hướng', r.raw);
  (await rq(SELLER, 'GET', '/ingest/catalog', { bearer: token })).status === 403
    ? ok('/ingest/catalog cũng 403 (bot không chào hàng thay shop đã đóng)') : bad('catalog vẫn mở cho shop đã đóng');
  (await nOrders()) === ordT ? ok('không đơn nào được tạo') : bad('shop đã đóng vẫn có đơn mới!');
  (await nHeld()) === heldT ? ok('không dòng chờ nào được ghi (đã đóng thì không giữ chỗ gì cả)') : bad('shop đã đóng vẫn đẻ dòng chờ');

  sect('10. Worker dọn dòng chờ nguội (PII không nằm lại mãi)');
  // payload giữ tên/SĐT/địa chỉ khách. Cùng khuôn quét phiên Messenger: dòng CŨ phải biến
  // mất, dòng ĐANG CHỜ phải còn — quét mà cuốn cả dòng sống là xoá đúng thứ người bán đang
  // định gọi lại cho khách.
  await setStatus('suspended');
  const hLive = (await push()).json.held_id;
  await setStatus('active');
  const hOld = (await owner.query(
    `INSERT INTO held_ingest_orders (shop_id, idempotency_key, payload, reason, received_at)
     VALUES ($1, $2, '{"customer":{"phone":"0900000001"}}'::jsonb, 'suspended', now() - interval '400 days')
     RETURNING id`, [S.shopId, `old-${uniq()}`])).rows[0].id;
  const gc = await fetch(`${process.env.WORKER_URL ?? 'http://worker:3080'}/internal/held-order-gc`, { method: 'POST' });
  const gcJson = gc.ok ? await gc.json() : null;
  const oldLeft = Number((await owner.query('SELECT count(*)::int n FROM held_ingest_orders WHERE id=$1', [hOld])).rows[0].n);
  const liveLeft = Number((await owner.query('SELECT count(*)::int n FROM held_ingest_orders WHERE id=$1', [hLive])).rows[0].n);
  gc.ok && Number(gcJson?.deleted) >= 1 && oldLeft === 0
    ? ok(`worker xoá dòng chờ nguội (${gcJson.deleted} dòng)`) : bad('dòng 400 ngày tuổi VẪN còn', JSON.stringify(gcJson));
  liveLeft === 1 ? ok('dòng đang chờ KHÔNG bị cuốn theo') : bad('quét xoá nhầm dòng đang chờ!');

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
// Đứt giữa chừng vẫn phải IN dòng tổng kết. §4 coi "thiếu dòng N pass, 0 fail" là ĐỎ, nên
// bỏ nó đi vẫn đúng kết luận — nhưng ma trận đột biến thì đọc không ra chuyện gì đã hỏng, mà
// đó mới là thứ ma trận tồn tại để nói.
main().catch(async (e) => {
  console.error(e);
  console.log(`\n${B}${pass} pass, ${fail + 1} fail${X} (đứt giữa chừng)`);
  await owner.end().catch(() => {});
  process.exit(1);
});
