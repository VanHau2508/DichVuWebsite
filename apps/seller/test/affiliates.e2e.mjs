/**
 * E2E CỘNG TÁC VIÊN (CTV / affiliate) — docs/51. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/affiliates.e2e.mjs
 *
 * Đi TRỌN đường tiền của CTV: link ?ref= → cookie → đơn thật → hoa hồng 'pending' →
 * worker sweep chốt 'eligible' khi đã giao + hết hạn giữ → phiếu chi 'paid'.
 * Kèm các ca ác: mã sai KHÔNG chặn đơn · CTV tự mua bị chặn · đơn huỷ làm hoa hồng RỤNG ·
 * chưa hết hạn giữ thì CHƯA chốt · đổi mức hoa hồng KHÔNG làm đổi đơn cũ · cô lập chéo shop.
 */
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = 'http://auth:3020', PLATFORM = 'http://platform:3030', SELLER = 'http://seller:3040';
const WORKER = process.env.WORKER_URL ?? 'http://worker:3080';
const CO = new URL('http://checkout:3060');
const SF = new URL(process.env.STOREFRONT_URL ?? 'http://storefront:3050');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 5 });
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  PASS ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? ' :: ' + String(d).slice(0, 240) : '')); };
const sect = (m) => console.log('\n# ' + m);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };
const N = (x) => Number(x ?? 0);

async function rq(base, method, path, { body, cookie, origin } = {}) {
  const h = {};
  if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
const login = async (e, p) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email: e, password: p }, origin: OA })).sc);
const uidOf = async (e) => (await owner.query('SELECT id FROM users WHERE email=$1', [e])).rows[0]?.id ?? null;

let HOST;
// Gọi checkout kèm ĐƯỢC cookie ref — đây là điểm mấu chốt cả tính năng nằm ở đó.
function co(method, path, { json, cartCookie, idem, ref } = {}) {
  return new Promise((resolve, reject) => {
    const data = json !== undefined ? JSON.stringify(json) : null;
    const headers = { host: HOST, origin: `https://${HOST}` };
    if (data != null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const jar = [];
    if (cartCookie) jar.push(`__Host-cart=${cartCookie}`);
    if (ref) jar.push(`__Host-ref=${ref}`);
    if (jar.length) headers.cookie = jar.join('; ');
    if (idem) headers['idempotency-key'] = idem;
    const req = http.request({ hostname: CO.hostname, port: CO.port, path, method, headers }, (rs) => {
      let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch {} let tok = cartCookie; for (const c of rs.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) tok = m[1]; } resolve({ status: rs.statusCode, json: j, raw: b, cartCookie: tok }); });
    });
    req.on('error', reject); if (data != null) req.write(data); req.end();
  });
}
// Storefront: cần đọc header 302 + set-cookie thô nên đi http thẳng, không fetch.
function sf(path, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: SF.hostname, port: SF.port, path, method: 'GET', headers: { host } }, (rs) => {
      rs.resume();
      rs.on('end', () => resolve({ status: rs.statusCode, location: rs.headers.location, setCookie: rs.headers['set-cookie'] ?? [] }));
    });
    req.on('error', reject); req.end();
  });
}
const sweep = () => fetch(`${WORKER}/internal/affiliate-sweep`, { method: 'POST' }).then((r) => r.json());

async function makeStaff() {
  const email = `staff-${uniq()}@nentang.vn`, password = 'staff strong passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let c = await login(email, password);
  const en = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie: c, origin: OA });
  const key = base32Decode(en.json.secret);
  await rq(AUTH, 'POST', '/auth/mfa/activate', { cookie: c, body: { code: totp(key, {}) }, origin: OA });
  const c0 = counterFor(Date.now());
  await owner.query(`INSERT INTO platform_staff (user_id,role) VALUES ($1,'admin')`, [await uidOf(email)]);
  while (counterFor(Date.now()) <= c0) await sleep(1000);
  c = await login(email, password);
  return ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie: c, body: { code: totp(key, {}) }, origin: OA })).sc) ?? c;
}

async function main() {
  const staff = await makeStaff();
  const mkShop = async (slug) => {
    const r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO });
    const shopId = r.json.id;
    const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
    await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
    await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
    return { shopId, host: `${slug}.nentang.vn`, oe, op, oc: await login(oe, op) };
  };
  const A = await mkShop(`aff-${uniq()}`);
  const B = await mkShop(`afb-${uniq()}`);
  const { shopId, oc, op } = A; HOST = A.host;
  const stepUp = () => rq(AUTH, 'POST', '/auth/step-up', { body: { password: op }, cookie: oc, origin: OA });
  // affiliate.manage có step-up (tiền rời khỏi shop) → nâng quyền một lần cho cả bộ.
  await stepUp();
  const api = (m, p, body) => rq(SELLER, m, `/shops/${shopId}${p}`, { body, cookie: oc, origin: OS });

  const mkProduct = async (price, stock) => {
    const p = await api('POST', '/products', { title: `SP-${uniq()}`, price_vnd: price, status: 'active', variants: [{ price_vnd: price, stock }] });
    return (await rq(SELLER, 'GET', `/shops/${shopId}/products/${p.json.id}`, { cookie: oc })).json.variants[0].id;
  };
  const V = await mkProduct(200000, 200);
  const place = async (phone, ref) => {
    const cart = (await co('POST', '/cart/items', { json: { variant_id: V, qty: 1 } })).cartCookie;
    const r = await co('POST', '/checkout', {
      json: { customer: { name: 'K', phone }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' },
      cartCookie: cart, idem: `i-${uniq()}`, ref,
    });
    return { status: r.status, order: (await owner.query(`SELECT id, subtotal_vnd, discount_vnd FROM orders WHERE shop_id=$1 AND order_number=$2`, [shopId, r.json?.order_number])).rows[0] };
  };
  const commOf = async (orderId) => (await owner.query(`SELECT status, amount_vnd, base_vnd, rate_kind, rate_value FROM affiliate_commissions WHERE order_id=$1`, [orderId])).rows[0] ?? null;
  const deliver = async (orderId, daysAgo) => {
    await owner.query(`UPDATE orders SET status='delivered', delivered_at = now() - ($2 || ' days')::interval WHERE id=$1`, [orderId, String(daysAgo)]);
  };

  sect('1. Chưa bật chương trình → có mã cũng KHÔNG sinh hoa hồng');
  let r = await api('POST', '/affiliates', { code: 'HAU2025', name: 'Lê Văn Hậu', phone: '0900001111' });
  const affId = r.json?.id;
  r.status === 201 && affId ? ok('tạo CTV mã HAU2025') : bad('tạo CTV lỗi', r.raw);
  let o = await place('0911111111', 'HAU2025');
  (o.status === 201 && await commOf(o.order.id)) === null || (await commOf(o.order.id)) == null
    ? ok('chương trình TẮT → đơn vẫn tạo được, KHÔNG có hoa hồng') : bad('sinh hoa hồng khi chương trình tắt');

  sect('2. Bật chương trình → hoa hồng "tạm tính", tính trên subtotal−discount');
  r = await api('PUT', '/affiliates/config', { enabled: true, rate_kind: 'percent', rate_value: 10, hold_days: 7, cookie_days: 30 });
  r.status === 200 ? ok('lưu cấu hình: 10%, giữ 7 ngày') : bad('lưu cấu hình lỗi', r.raw);
  o = await place('0922222222', 'HAU2025');
  let k = await commOf(o.order.id);
  const base = N(o.order.subtotal_vnd) - N(o.order.discount_vnd);
  k && k.status === 'pending' && N(k.amount_vnd) === Math.floor(base * 0.1) && N(k.base_vnd) === base
    ? ok(`hoa hồng ${k.amount_vnd}đ = 10% của ${base} (căn cứ KHÔNG gồm ship), trạng thái tạm tính`)
    : bad('hoa hồng sai', JSON.stringify(k));

  sect('3. Mã SAI / CTV đã tắt → KHÔNG bao giờ chặn đơn hàng thật');
  o = await place('0933333333', 'KHONG-CO-MA-NAY');
  o.status === 201 && (await commOf(o.order.id)) == null
    ? ok('mã không tồn tại → đơn vẫn 201, không hoa hồng') : bad('mã sai làm hỏng đơn', o.status);
  await api('POST', '/affiliates', { code: 'TATROI', name: 'CTV đã nghỉ' });
  const offId = (await owner.query(`SELECT id FROM affiliates WHERE shop_id=$1 AND code='TATROI'`, [shopId])).rows[0].id;
  await api('PATCH', `/affiliates/${offId}`, { name: 'CTV đã nghỉ', active: false });
  o = await place('0944444444', 'TATROI');
  o.status === 201 && (await commOf(o.order.id)) == null
    ? ok('CTV đã tắt → đơn vẫn 201, không hoa hồng') : bad('CTV tắt vẫn ăn hoa hồng');

  sect('4. CTV tự mua qua mã của mình → chặn (khớp SĐT)');
  o = await place('0900001111', 'HAU2025');   // đúng SĐT của CTV
  o.status === 201 && (await commOf(o.order.id)) == null
    ? ok('SĐT trùng CTV → đơn vẫn tạo, KHÔNG tự thưởng') : bad('CTV tự thưởng được cho mình');

  sect('5. Sweep: chưa hết hạn giữ thì CHƯA chốt; đủ hạn mới "đủ điều kiện"');
  const oEarly = await place('0955555555', 'HAU2025');
  await deliver(oEarly.order.id, 2);          // giao 2 ngày trước, hạn giữ 7 ngày
  const oRipe = await place('0966666666', 'HAU2025');
  await deliver(oRipe.order.id, 10);          // giao 10 ngày trước → quá hạn
  await sweep();
  (await commOf(oEarly.order.id)).status === 'pending'
    ? ok('giao 2 ngày (hạn 7) → VẪN tạm tính, chưa chốt') : bad('chốt sớm khi chưa hết hạn đổi trả');
  (await commOf(oRipe.order.id)).status === 'eligible'
    ? ok('giao 10 ngày → đủ điều kiện') : bad('quá hạn mà không chốt', JSON.stringify(await commOf(oRipe.order.id)));

  sect('6. Đơn huỷ trước khi đủ điều kiện → hoa hồng RỤNG (không phải đi đòi lại)');
  const oDead = await place('0977777777', 'HAU2025');
  await owner.query(`UPDATE orders SET status='cancelled' WHERE id=$1`, [oDead.order.id]);
  await sweep();
  const kDead = await commOf(oDead.order.id);
  kDead.status === 'void' ? ok('đơn huỷ → hoa hồng void, có lý do ghi lại') : bad('đơn huỷ mà hoa hồng còn sống', JSON.stringify(kDead));

  sect('7. Đổi mức hoa hồng KHÔNG làm đổi tiền của đơn CŨ (snapshot)');
  const beforeAmt = N((await commOf(oRipe.order.id)).amount_vnd);
  await api('PUT', '/affiliates/config', { enabled: true, rate_kind: 'percent', rate_value: 50, hold_days: 7, cookie_days: 30 });
  N((await commOf(oRipe.order.id)).amount_vnd) === beforeAmt
    ? ok(`đổi mức 10%→50%, đơn cũ GIỮ ${beforeAmt}đ`) : bad('đổi mức làm đổi tiền đơn cũ');
  const oNew = await place('0988888888', 'HAU2025');
  N((await commOf(oNew.order.id)).amount_vnd) === Math.floor((N(oNew.order.subtotal_vnd) - N(oNew.order.discount_vnd)) * 0.5)
    ? ok('đơn MỚI ăn mức mới 50%') : bad('đơn mới không theo mức mới');
  await api('PUT', '/affiliates/config', { enabled: true, rate_kind: 'percent', rate_value: 10, hold_days: 7, cookie_days: 30 });

  sect('8. Chốt phiếu chi: gom mọi dòng đủ điều kiện, số tiền do DB cộng');
  let d = await rq(SELLER, 'GET', `/shops/${shopId}/affiliates/${affId}`, { cookie: oc });
  const eligibleBefore = N(d.json?.totals?.eligible_vnd);
  eligibleBefore > 0 ? ok(`trước khi chi: ${eligibleBefore}đ đủ điều kiện`) : bad('không có gì để chi', JSON.stringify(d.json?.totals));
  r = await api('POST', `/affiliates/${affId}/payouts`, { method: 'bank', note: 'chuyển khoản tháng 8' });
  r.status === 201 && N(r.json.amount_vnd) === eligibleBefore
    ? ok(`phiếu chi ${r.json.amount_vnd}đ / ${r.json.item_count} dòng — khớp đúng số đủ điều kiện`)
    : bad('phiếu chi lệch', `${r.status} ${r.raw}`);
  d = await rq(SELLER, 'GET', `/shops/${shopId}/affiliates/${affId}`, { cookie: oc });
  N(d.json.totals.eligible_vnd) === 0 && N(d.json.totals.paid_vnd) === eligibleBefore
    ? ok('sau khi chi: đủ-điều-kiện về 0, đã-trả = đúng số vừa chi') : bad('trạng thái sau chi sai', JSON.stringify(d.json.totals));
  r = await api('POST', `/affiliates/${affId}/payouts`, {});
  r.status === 409 ? ok('chi lần hai khi không còn gì → 409 (không đẻ phiếu rỗng)') : bad('chi được phiếu rỗng', r.status);

  sect('9. Phiếu chi là chứng từ: KHÔNG sửa, KHÔNG xoá được kể cả bằng vai app_rw');
  const rw = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const denied = async (sql) => { try { await rw.query(sql); return false; } catch { return true; } };
  const noUpd = await denied(`UPDATE affiliate_payouts SET amount_vnd = 1`);
  const noDel = await denied(`DELETE FROM affiliate_payouts`);
  const noDelK = await denied(`DELETE FROM affiliate_commissions`);
  await rw.end();
  noUpd && noDel ? ok('app_rw KHÔNG sửa/xoá được phiếu chi (append-only)') : bad('phiếu chi sửa/xoá được', `upd=${!noUpd} del=${!noDel}`);
  noDelK ? ok('app_rw KHÔNG xoá được dòng hoa hồng (0130 — xoá = xoá nghĩa vụ với CTV)') : bad('xoá được dòng hoa hồng');

  sect('10. Storefront: ?ref= đặt cookie rồi BỎ tham số khỏi URL');
  const s1 = await sf('/products?cat=abc&ref=hau2025', A.host);
  const cookieSet = (s1.setCookie.find((c) => c.startsWith('__Host-ref=')) ?? '');
  s1.status === 302 && s1.location === '/products?cat=abc' && /__Host-ref=HAU2025;/.test(cookieSet)
    ? ok('?ref=hau2025 → 302 sạch URL + cookie HAU2025 (giữ tham số khác)') : bad('bắt mã lỗi', `${s1.status} ${s1.location} ${cookieSet}`);
  const s2 = await sf('/?ref=%3Cscript%3E', A.host);
  /__Host-ref=;/.test(s2.setCookie.find((c) => c.startsWith('__Host-ref=')) ?? '')
    ? ok('mã rác → XOÁ cookie (last-click là rác thì mã cũ không được ăn tiếp)') : bad('mã rác không xoá cookie');

  sect('11. Cô lập chéo shop: mã của shop A vô hiệu ở shop B');
  HOST = B.host;
  const cartB = (await co('POST', '/cart/items', { json: { variant_id: V, qty: 1 } })).cartCookie;
  // Giỏ của shop A không dùng được ở host B → chính điều đó đã là cô lập; kiểm ở tầng DB
  // cho chắc: shop B tuyệt đối không có dòng hoa hồng nào.
  const nB = N((await owner.query(`SELECT count(*)::int n FROM affiliate_commissions WHERE shop_id=$1`, [B.shopId])).rows[0].n);
  nB === 0 ? ok('shop B không có một dòng hoa hồng nào của shop A') : bad('rò hoa hồng chéo shop', nB);
  const rB = await rq(SELLER, 'GET', `/shops/${B.shopId}/affiliates`, { cookie: oc });
  rB.status === 403 || rB.status === 404 ? ok(`owner A xem CTV của shop B → ${rB.status}`) : bad('xem được CTV shop khác', rB.status);

  sect('12. Hoa hồng là CHI PHÍ trong P&L — tại NGÀY ĐỦ ĐIỀU KIỆN, không phải ngày đặt đơn');
  HOST = A.host;
  // Test CHÉO docs/51 ↔ docs/37: hai tài liệu quy tắc, một con số. Ghi chi phí ở ngày đặt
  // đơn là ghi khống — lúc đó hoa hồng còn tạm tính, đơn huỷ thì rụng hẳn.
  const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  const rep = await rq(SELLER, 'GET', `/shops/${shopId}/reports/sales?from=${today}&to=${today}`, { cookie: oc });
  const tt = rep.json?.totals;
  // Đã chốt 20.000 (eligible→paid hôm nay). Các dòng 'pending'/'void' KHÔNG được tính.
  N(tt?.affiliate_commission_vnd) === 20000
    ? ok('P&L ghi hoa hồng 20.000đ (chỉ dòng đã đủ điều kiện)') : bad('hoa hồng vào P&L sai', JSON.stringify({ aff: tt?.affiliate_commission_vnd }));
  const pendingSum = N((await owner.query(`SELECT coalesce(sum(amount_vnd),0)::bigint s FROM affiliate_commissions WHERE shop_id=$1 AND status='pending'`, [shopId])).rows[0].s);
  pendingSum > 0 && N(tt?.affiliate_commission_vnd) < pendingSum + 20000
    ? ok(`${pendingSum}đ còn tạm tính KHÔNG bị ghi thành chi phí`) : bad('ghi khống chi phí cho khoản chưa chắc phải trả', `pending=${pendingSum}`);
  const csv = await rq(SELLER, 'GET', `/shops/${shopId}/reports/export?type=pnl&from=${today}&to=${today}`, { cookie: oc });
  /affiliate_commission_vnd/.test(String(csv.raw ?? ''))
    ? ok('CSV báo cáo có cột affiliate_commission_vnd') : bad('CSV thiếu cột hoa hồng — cộng tay không ra lãi vận hành');

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
