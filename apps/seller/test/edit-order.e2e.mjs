// E2E: SỬA ĐƠN (v1). Kiểm bất biến tiền/tồn: đổi qty/thêm/bớt dòng nhả-giữ reserve đúng,
// oversell bị chặn (rollback sạch), guard trạng thái/payment, giá snapshot giữ nguyên,
// declarative idempotent + đua FOR UPDATE, audit diff from→to.
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = 'http://auth:3020', PLATFORM = 'http://platform:3030', SELLER = 'http://seller:3040';
const CO = new URL('http://checkout:3060');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 5 });
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  PASS ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? ' :: ' + String(d).slice(0, 170) : '')); };
const sect = (m) => console.log('\n# ' + m);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };
async function rq(base, method, path, { body, cookie, origin } = {}) {
  const h = {}; if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin; if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
const login = async (e, p) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email: e, password: p }, origin: OA })).sc);
const uidOf = async (e) => (await owner.query('SELECT id FROM users WHERE email=$1', [e])).rows[0]?.id ?? null;
let HOST;
function co(method, path, { json, cartCookie, idem } = {}) {
  return new Promise((resolve, reject) => {
    const data = json !== undefined ? JSON.stringify(json) : null;
    const headers = { host: HOST, origin: `https://${HOST}` };
    if (data != null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (cartCookie) headers.cookie = `__Host-cart=${cartCookie}`;
    if (idem) headers['idempotency-key'] = idem;
    const req = http.request({ hostname: CO.hostname, port: CO.port, path, method, headers }, (rs) => {
      let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch {} let tok = cartCookie; for (const c of rs.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) tok = m[1]; } resolve({ status: rs.statusCode, json: j, raw: b, cartCookie: tok }); });
    });
    req.on('error', reject); if (data != null) req.write(data); req.end();
  });
}
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
const reservedOf = async (vid) => Number((await owner.query('SELECT reserved FROM inventory_levels WHERE variant_id=$1', [vid])).rows[0].reserved);

async function main() {
  const staff = await makeStaff();
  const slug = `edit-${uniq()}`;
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO });
  const shopId = r.json.id; HOST = `${slug}.nentang.vn`;
  await owner.query(`UPDATE shops SET status='active', went_live_at=now() WHERE id=$1`, [shopId]);
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  const oc = await login(oe, op);
  // 2 SP: A giá 100k tồn 10, B giá 250k tồn 5
  const mk = async (title, price, stock) => {
    const p = await rq(SELLER, 'POST', `/shops/${shopId}/products`, { body: { title, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `${title}-${uniq()}`, price_vnd: price }] }, cookie: oc, origin: OS });
    const vid = (await rq(SELLER, 'GET', `/shops/${shopId}/products/${p.json.id}`, { cookie: oc })).json.variants[0].id;
    await rq(SELLER, 'POST', `/shops/${shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: oc, origin: OS });
    return vid;
  };
  const A = await mk('A', 100000, 10), B = await mk('B', 250000, 5);

  // Đặt đơn COD qua checkout: 2 x A = 200k + ship
  const cart = (await co('POST', '/cart/items', { json: { variant_id: A, qty: 2 } })).cartCookie;
  const oc2 = await co('POST', '/checkout', { json: { customer: { name: 'Khách', phone: '0912000111', email: 'k@x.vn' }, address: { line: 'Số 1', province: 'Hà Nội' }, payment_method: 'cod' }, cartCookie: cart, idem: `e-${uniq()}` });
  const ordId = (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 1`, [shopId])).rows[0].id;
  const g0 = (await rq(SELLER, 'GET', `/shops/${shopId}/orders/${ordId}`, { cookie: oc })).json;
  Number(g0.total_vnd) === 230000 && await reservedOf(A) === 2 ? ok('đơn gốc: 2×A=200k+ship30k=230k, reserved A=2') : bad('đơn gốc sai', `${g0.total_vnd} rA=${await reservedOf(A)}`);
  const eurl = `/shops/${shopId}/orders/${ordId}/edit`;
  const cust = { name: 'Khách', phone: '0912000111', email: 'k@x.vn', address_line: 'Số 1', province: 'Hà Nội' };

  sect('Tăng qty: A 2→4 (reserve +2, tổng +200k)');
  r = await rq(SELLER, 'POST', eurl, { body: { lines: [{ variant_id: A, qty: 4 }], customer: cust }, cookie: oc, origin: OS });
  r.status === 200 && r.json.total_vnd === 430000 && await reservedOf(A) === 4 ? ok('A→4: total 430k, reserved A=4') : bad('tăng qty sai', `${r.status} ${r.json?.total_vnd} rA=${await reservedOf(A)}`);

  sect('Thêm dòng mới B×2 (snapshot giá HIỆN TẠI 250k, reserve B=2)');
  r = await rq(SELLER, 'POST', eurl, { body: { lines: [{ variant_id: A, qty: 4 }, { variant_id: B, qty: 2 }], customer: cust }, cookie: oc, origin: OS });
  r.status === 200 && r.json.total_vnd === 400000 + 500000 + 30000 && await reservedOf(B) === 2 ? ok('thêm B×2: total 930k, reserved B=2') : bad('thêm dòng sai', `${r.status} ${r.json?.total_vnd} rB=${await reservedOf(B)}`);

  sect('Giảm/bớt: A 4→1, bỏ B (nhả reserve A→1, B→0)');
  r = await rq(SELLER, 'POST', eurl, { body: { lines: [{ variant_id: A, qty: 1 }], customer: cust }, cookie: oc, origin: OS });
  const rA = await reservedOf(A), rB = await reservedOf(B);
  r.status === 200 && r.json.total_vnd === 130000 && rA === 1 && rB === 0 ? ok('A→1 bỏ B: total 130k, reserved A=1 B=0 (nhả đúng)') : bad('giảm/bớt sai', `${r.status} ${r.json?.total_vnd} rA=${rA} rB=${rB}`);

  sect('Oversell: đòi A=999 (>tồn) → 422 + ROLLBACK (reserve KHÔNG đổi)');
  const rAbefore = await reservedOf(A);
  r = await rq(SELLER, 'POST', eurl, { body: { lines: [{ variant_id: A, qty: 999 }, { variant_id: B, qty: 1 }], customer: cust }, cookie: oc, origin: OS });
  const rAafter = await reservedOf(A), rBafter = await reservedOf(B);
  r.status === 422 && rAafter === rAbefore && rBafter === 0 ? ok('oversell → 422, reserve A/B KHÔNG đổi (rollback sạch, B không rò reserve)') : bad('oversell rollback lỗi', `${r.status} rA=${rAafter}(kv ${rAbefore}) rB=${rBafter}`);

  sect('Giá snapshot: đổi giá SP A lên 999k rồi sửa qty → dòng CŨ giữ giá 100k');
  await owner.query(`UPDATE variants SET price_vnd=999000 WHERE id=$1`, [A]);
  r = await rq(SELLER, 'POST', eurl, { body: { lines: [{ variant_id: A, qty: 3 }], customer: cust }, cookie: oc, origin: OS });
  const gLine = (await rq(SELLER, 'GET', `/shops/${shopId}/orders/${ordId}`, { cookie: oc })).json.lines.find((l) => l.variant_id === A);
  r.status === 200 && Number(gLine.unit_price_vnd) === 100000 && r.json.total_vnd === 330000 ? ok('dòng cũ GIỮ giá snapshot 100k (không nhảy 999k), total 330k') : bad('snapshot giá vỡ', `${gLine?.unit_price_vnd} total=${r.json?.total_vnd}`);

  sect('Đổi địa chỉ + ghi đè phí ship');
  r = await rq(SELLER, 'POST', eurl, { body: { lines: [{ variant_id: A, qty: 3 }], customer: { ...cust, address_line: 'Địa chỉ mới 99', province: 'Đà Nẵng' }, ship_fee_vnd: 50000 }, cookie: oc, origin: OS });
  const gAddr = (await rq(SELLER, 'GET', `/shops/${shopId}/orders/${ordId}`, { cookie: oc })).json;
  const addr = gAddr.shipping_address;
  const nfc = (s) => String(s ?? '').normalize('NFC');
  r.status === 200 && Number(gAddr.shipping_vnd) === 50000 && Number(gAddr.total_vnd) === 350000 && nfc(addr?.province) === nfc('Đà Nẵng') && nfc(addr?.line) === nfc('Địa chỉ mới 99')
    ? ok('địa chỉ + ship override 50k → total 350k, address cập nhật') : bad('đổi địa chỉ/ship sai', `st=${r.status} ship=${gAddr.shipping_vnd} total=${gAddr.total_vnd} addr=${JSON.stringify(addr)}`);

  sect('Declarative idempotent: post LẠI cùng trạng thái → no-op (reserve/tổng không đổi)');
  const before = await reservedOf(A), bt = gAddr.total_vnd;
  r = await rq(SELLER, 'POST', eurl, { body: { lines: [{ variant_id: A, qty: 3 }], customer: { ...cust, address_line: 'Địa chỉ mới 99', province: 'Đà Nẵng' }, ship_fee_vnd: 50000 }, cookie: oc, origin: OS });
  const afterR = await reservedOf(A);
  r.status === 200 && afterR === before && Number(r.json.total_vnd) === Number(bt) ? ok('post lại y hệt → reserve/tổng KHÔNG đổi (idempotent)') : bad('không idempotent', `st=${r.status} total=${r.json?.total_vnd}(kv ${bt}) rA=${afterR}(kv ${before}) err=${r.json?.error ?? ''}`);

  sect('Đua 5 lệnh sửa đồng thời (A qty 1..5) → tuần tự hoá, reserve = qty cuối cùng thắng, không âm/không phình');
  const races = await Promise.all([1, 2, 3, 4, 5].map((q) => rq(SELLER, 'POST', eurl, { body: { lines: [{ variant_id: A, qty: q }], customer: cust }, cookie: oc, origin: OS })));
  const okCount = races.filter((x) => x.status === 200).length;
  const finalR = await reservedOf(A);
  const finalOrderQty = (await owner.query(`SELECT qty FROM order_lines WHERE order_id=$1 AND variant_id=$2`, [ordId, A])).rows[0]?.qty;
  okCount === 5 && finalR === finalOrderQty && finalR >= 1 && finalR <= 5 ? ok(`đua 5 lệnh: tất cả 200, reserved(${finalR})==order qty(${finalOrderQty}) — nhất quán, không phình`) : bad('đua vỡ nhất quán', `ok=${okCount} rA=${finalR} orderQty=${finalOrderQty}`);

  sect('Guard: ship đơn rồi → KHÔNG sửa được nữa');
  await rq(SELLER, 'POST', `/shops/${shopId}/orders/${ordId}/confirm`, { cookie: oc, origin: OS });
  await rq(SELLER, 'POST', `/shops/${shopId}/orders/${ordId}/ship`, { body: { carrier: 'tay', tracking_number: 'TN' + uniq() }, cookie: oc, origin: OS });
  r = await rq(SELLER, 'POST', eurl, { body: { lines: [{ variant_id: A, qty: 2 }], customer: cust }, cookie: oc, origin: OS });
  r.status === 409 ? ok('đơn đã ship → 409 (không sửa được sau khi gửi hãng)') : bad('sửa được đơn đã ship!', `${r.status}`);

  sect('Guard: đơn đã trả tiền → KHÔNG sửa được (cần hoàn/thu bù — v2)');
  // Đặt đơn COD mới rồi ép payment_status='paid' (mô phỏng đơn đã thu tiền) — không cần QR config.
  const cart2 = (await co('POST', '/cart/items', { json: { variant_id: B, qty: 1 } })).cartCookie;
  await co('POST', '/checkout', { json: { customer: { name: 'Q', phone: '0912000222', email: 'q@x.vn' }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' }, cartCookie: cart2, idem: `q-${uniq()}` });
  const pRow = (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 AND customer_phone='0912000222' ORDER BY created_at DESC LIMIT 1`, [shopId])).rows[0];
  if (!pRow) { bad('không tạo được đơn để test paid-guard'); }
  else {
    await owner.query(`UPDATE orders SET payment_status='paid', paid_at=now() WHERE id=$1`, [pRow.id]);
    r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${pRow.id}/edit`, { body: { lines: [{ variant_id: B, qty: 3 }], customer: { name: 'Q', phone: '0912000222' } }, cookie: oc, origin: OS });
    r.status === 409 && /đã trả|thanh toán/.test(r.json?.error ?? '') ? ok('đơn đã thanh toán → 409 (v2 mới hỗ trợ hoàn/thu bù)') : bad('sửa được đơn đã trả!', `${r.status} ${r.json?.error}`);
  }

  sect('Cross-shop: shop khác KHÔNG sửa được đơn này (RLS)');
  const oe2 = `owner2-${uniq()}@shop.vn`, op2 = 'owner two passphrase';
  const s2 = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: `x2-${uniq()}`, slug: `x2-${uniq()}`, plan_code: 'platform' }, cookie: staff, origin: OO });
  const inv2 = await rq(PLATFORM, 'POST', `/ops/shops/${s2.json.id}/invitations`, { body: { email: oe2, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe2), password: op2 }, origin: OA });
  const oc3 = await login(oe2, op2);
  r = await rq(SELLER, 'POST', `/shops/${s2.json.id}/orders/${ordId}/edit`, { body: { lines: [{ variant_id: A, qty: 1 }], customer: cust }, cookie: oc3, origin: OS });
  r.status === 404 ? ok('shop khác sửa đơn shop A → 404 (RLS/membership)') : bad('cross-shop sửa được!', `${r.status}`);

  sect('Đơn ĐỔI ĐIỂM THƯỞNG: sửa đơn KHÔNG được xoá phần giảm giá điểm');
  // Ca thật: khách đổi điểm lúc đặt (checkout: total = subtotal − discount − points + ship),
  // rồi shop sửa địa chỉ. reconcileEditLines từng tính total = subtotal + ship − discount,
  // BỎ points_discount_vnd → mỗi lần sửa, tổng nhảy lên đúng số điểm khách đã tiêu, mà sổ
  // điểm vẫn ghi đã trừ. Đơn ở đây GIỮ NGUYÊN dòng hàng nên tổng phải KHÔNG đổi.
  const cart3 = (await co('POST', '/cart/items', { json: { variant_id: B, qty: 2 } })).cartCookie;
  await co('POST', '/checkout', { json: { customer: { name: 'P', phone: '0912000333', email: 'p@x.vn' }, address: { line: 'y', province: 'Hà Nội' }, payment_method: 'cod' }, cartCookie: cart3, idem: `p-${uniq()}` });
  const ptRow = (await owner.query(`SELECT id, total_vnd FROM orders WHERE shop_id=$1 AND customer_phone='0912000333' ORDER BY created_at DESC LIMIT 1`, [shopId])).rows[0];
  if (!ptRow) { bad('không tạo được đơn để test điểm thưởng'); }
  else {
    const DIEM = 20000;
    await owner.query(
      `UPDATE orders SET points_redeemed=$2::int, points_discount_vnd=$2::bigint, total_vnd=total_vnd-$2::bigint WHERE id=$1`, [ptRow.id, DIEM]);
    const truoc = Number((await owner.query(`SELECT total_vnd FROM orders WHERE id=$1`, [ptRow.id])).rows[0].total_vnd);
    r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${ptRow.id}/edit`,
      { body: { lines: [{ variant_id: B, qty: 2 }], customer: { name: 'P', phone: '0912000333' } }, cookie: oc, origin: OS });
    const sau = Number((await owner.query(`SELECT total_vnd FROM orders WHERE id=$1`, [ptRow.id])).rows[0].total_vnd);
    r.status === 200 && sau === truoc
      ? ok(`sửa đơn có đổi ${DIEM}đ điểm → tổng GIỮ ${sau}đ (không đòi lại phần đã tiêu điểm)`)
      : bad('sửa đơn xoá giảm giá điểm', `http=${r.status} ${truoc} → ${sau}`);
    // Và khi ĐỔI số lượng, tổng mới vẫn phải trừ điểm.
    const donGia = Number((await owner.query(`SELECT unit_price_vnd FROM order_lines WHERE order_id=$1 AND variant_id=$2`, [ptRow.id, B])).rows[0].unit_price_vnd);
    const ship = Number((await owner.query(`SELECT shipping_vnd FROM orders WHERE id=$1`, [ptRow.id])).rows[0].shipping_vnd);
    r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${ptRow.id}/edit`,
      { body: { lines: [{ variant_id: B, qty: 3 }], customer: { name: 'P', phone: '0912000333' } }, cookie: oc, origin: OS });
    const sau3 = Number((await owner.query(`SELECT total_vnd FROM orders WHERE id=$1`, [ptRow.id])).rows[0].total_vnd);
    const kyVong = donGia * 3 + ship - DIEM;
    r.status === 200 && sau3 === kyVong
      ? ok(`đổi số lượng → tổng ${sau3}đ = 3×${donGia} + ${ship} − ${DIEM} điểm`)
      : bad('tổng sau khi đổi số lượng không trừ điểm', `http=${r.status} thực=${sau3} kỳ vọng=${kyVong}`);
  }

  sect('Đơn có MÃ GIẢM GIÁ: sửa bớt hàng phải TÍNH LẠI giảm giá theo luật của mã');
  // Ca thật: checkout kẹp mã hai lớp (từ chối khi subtotal < min_subtotal_vnd, rồi
  // min(raw, subtotal)). Đường sửa đơn từng bê nguyên discount_vnd cũ sang tiền hàng MỚI —
  // dựng lại được: mã "giảm 85.000, đơn từ 340.000" trên đơn sửa còn 85.000 vẫn ăn đủ
  // 85.000 → KHÁCH ÔM HÀNG MIỄN PHÍ, chỉ trả ship. Ca nặng hơn thì tổng âm → 422 ngõ cụt
  // (màn sửa đơn không có ô nào chỉnh giảm giá).
  {
    const giaB = Number((await owner.query(`SELECT price_vnd FROM variants WHERE id=$1`, [B])).rows[0].price_vnd);
    // Nạp thêm tồn cho B: các khối trước đã ăn gần hết, mà khối này cần 4 món.
    await owner.query(`UPDATE inventory_levels SET on_hand = on_hand + 20 WHERE variant_id=$1`, [B]);
    const c4 = await co('POST', '/cart/items', { json: { variant_id: B, qty: 4 } });
    const pl = await co('POST', '/checkout', { json: { customer: { name: 'M', phone: '0912000444', email: 'm@x.vn' }, address: { line: 'z', province: 'Hà Nội' }, payment_method: 'cod' }, cartCookie: c4.cartCookie, idem: `m-${uniq()}` });
    const md = (await owner.query(`SELECT id, shipping_vnd FROM orders WHERE shop_id=$1 AND customer_phone='0912000444' ORDER BY created_at DESC LIMIT 1`, [shopId])).rows[0];
    if (!md) bad('không tạo được đơn để test mã giảm giá', `cart=${c4.status} place=${pl.status} ${pl.raw}`);
    else {
      // (a) mã CÒN trong bảng, có ngưỡng đơn tối thiểu → sửa xuống dưới ngưỡng = mất giảm.
      const code = `MG${uniq()}`.toUpperCase().slice(0, 18);
      await owner.query(`INSERT INTO coupons (shop_id, code, kind, value, min_subtotal_vnd, active) VALUES ($1,$2,'fixed',$3::bigint,$4::bigint,true)`,
        [shopId, code, giaB, giaB * 3]);
      await owner.query(`UPDATE orders SET coupon_code=$2, discount_vnd=$3::bigint, total_vnd=total_vnd-$3::bigint WHERE id=$1`, [md.id, code, giaB]);
      r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${md.id}/edit`,
        { body: { lines: [{ variant_id: B, qty: 1 }], customer: { name: 'M', phone: '0912000444' } }, cookie: oc, origin: OS });
      const a = (await owner.query(`SELECT subtotal_vnd, discount_vnd, total_vnd FROM orders WHERE id=$1`, [md.id])).rows[0];
      r.status === 200 && Number(a.discount_vnd) === 0 && Number(a.total_vnd) === giaB + Number(md.shipping_vnd)
        ? ok(`sửa còn ${giaB}đ hàng < ngưỡng mã ${giaB * 3}đ → giảm giá về 0, tổng ${a.total_vnd}đ`)
        : bad('mã vẫn ăn giảm dù đơn tụt dưới ngưỡng', `http=${r.status} hàng=${a.subtotal_vnd} giảm=${a.discount_vnd} tổng=${a.total_vnd}`);
      // Bất biến CỨNG, đúng thứ checkout giữ: giảm giá không bao giờ vượt tiền hàng.
      Number(a.discount_vnd) <= Number(a.subtotal_vnd)
        ? ok('bất biến: giảm giá ≤ tiền hàng sau khi sửa')
        : bad('giảm giá vượt tiền hàng', `${a.discount_vnd} > ${a.subtotal_vnd}`);
      // (b) mã ĐÃ BỊ XOÁ khỏi bảng → không còn luật để tra → chia theo TỶ LỆ hàng còn lại
      //     (cùng quy tắc phân bổ giảm giá đã dùng ở nhận-trả-hàng), KHÔNG giữ nguyên số cũ.
      await owner.query(`UPDATE orders SET discount_vnd=$2::bigint, coupon_code='DAXOA' WHERE id=$1`, [md.id, giaB]);
      r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${md.id}/edit`,
        { body: { lines: [{ variant_id: B, qty: 4 }], customer: { name: 'M', phone: '0912000444' } }, cookie: oc, origin: OS });
      const b2 = (await owner.query(`SELECT subtotal_vnd, discount_vnd FROM orders WHERE id=$1`, [md.id])).rows[0];
      // Sửa TĂNG hàng (1→4): tỷ lệ cho ra số lớn hơn, nhưng luật là "không bao giờ cao hơn
      // mức ban đầu" → giữ nguyên giaB. Chốt luôn chiều này để không ai nới thành phình ra.
      r.status === 200 && Number(b2.discount_vnd) === giaB
        ? ok(`mã đã xoá + sửa TĂNG hàng → giảm giá GIỮ ${giaB}đ (không phình theo tỷ lệ)`)
        : bad('sửa tăng hàng làm giảm giá phình ra', `http=${r.status} giảm=${b2.discount_vnd} (ban đầu ${giaB})`);
      // Rồi sửa GIẢM: 4 → 1 = còn 1/4 hàng → giảm giá cũng còn 1/4.
      r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${md.id}/edit`,
        { body: { lines: [{ variant_id: B, qty: 1 }], customer: { name: 'M', phone: '0912000444' } }, cookie: oc, origin: OS });
      const b3 = (await owner.query(`SELECT subtotal_vnd, discount_vnd FROM orders WHERE id=$1`, [md.id])).rows[0];
      const cho = Math.round((giaB * giaB) / (giaB * 4));
      r.status === 200 && Number(b3.discount_vnd) === cho
        ? ok(`mã đã xoá + sửa 4→1 món → giảm giá chia tỷ lệ còn ${b3.discount_vnd}đ`)
        : bad('mã đã xoá: không chia tỷ lệ', `http=${r.status} giảm=${b3.discount_vnd} kỳ vọng=${cho}`);
      await owner.query(`DELETE FROM coupons WHERE shop_id=$1 AND code=$2`, [shopId, code]);
    }
  }

  sect('Audit: order.edited ghi diff from→to');
  const ae = (await owner.query(`SELECT metadata FROM audit_logs WHERE shop_id=$1 AND action='order.edited' ORDER BY id DESC LIMIT 1`, [shopId])).rows[0];
  ae && ae.metadata?.changed && (ae.metadata.changed.total_vnd || ae.metadata.lines) ? ok('audit order.edited có changed/lines diff') : bad('audit thiếu diff', JSON.stringify(ae?.metadata));

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
