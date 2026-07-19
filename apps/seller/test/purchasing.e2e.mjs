// E2E: NHẬP HÀNG (0085) — NCC + phiếu nhập + NHẬN HÀNG nguyên tử. Kiểm đường TỒN + GIÁ VỐN:
// receive() cộng on_hand + ĐÚNG 1 ledger 'receive'/dòng + UPSERT variant_costs bình quân gia
// quyền (NULL cũ / on_hand cũ ≤0 → lấy giá nhập, không coi 0); Σledger==on_hand; nhận-2-lần 409;
// huỷ phiếu đã nhận 409; subtotal cache đúng (SQL bigint); RBAC order_manager 403; IDOR chéo-shop 404.
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';
import pg from 'pg';

const AUTH = 'http://auth:3020', PLATFORM = 'http://platform:3030', SELLER = 'http://seller:3040';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 5 });
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  PASS ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? ' :: ' + String(d).slice(0, 250) : '')); };
const sect = (m) => console.log('\n# ' + m);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const N = (x) => (x == null ? null : Number(x));
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
async function makeShop(staff, prefix) {
  const slug = `${prefix}-${uniq()}`;
  const shopId = (await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO })).json.id;
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  return { shopId, oc: await login(oe, op) };
}

async function main() {
  const staff = await makeStaff();
  const { shopId, oc } = await makeShop(staff, 'po');
  // mk: product active + 1 variant + (tuỳ chọn) nạp tồn ban đầu qua adjust (ledger 'adjust').
  const mk = async (t, price, stock = 0) => {
    const p = await rq(SELLER, 'POST', `/shops/${shopId}/products`, { body: { title: t, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `${t}-${uniq()}`, price_vnd: price }] }, cookie: oc, origin: OS });
    const vid = (await rq(SELLER, 'GET', `/shops/${shopId}/products/${p.json.id}`, { cookie: oc })).json.variants[0].id;
    if (stock) await rq(SELLER, 'POST', `/shops/${shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập ban đầu' }, cookie: oc, origin: OS });
    return vid;
  };
  const setCost = (vid, cost) => owner.query(
    `INSERT INTO variant_costs (shop_id, variant_id, cost_vnd) VALUES ($1,$2,$3)
     ON CONFLICT (shop_id, variant_id) DO UPDATE SET cost_vnd=$3, updated_at=now()`, [shopId, vid, cost]);
  const costOf = async (vid) => N((await owner.query(`SELECT cost_vnd FROM variant_costs WHERE shop_id=$1 AND variant_id=$2`, [shopId, vid])).rows[0]?.cost_vnd);
  const onHandOf = async (vid) => N((await owner.query(`SELECT on_hand FROM inventory_levels WHERE shop_id=$1 AND variant_id=$2`, [shopId, vid])).rows[0]?.on_hand ?? 0);
  const ledgerOf = async (vid) => (await owner.query(`SELECT delta, kind, reason FROM inventory_ledger WHERE shop_id=$1 AND variant_id=$2 ORDER BY id`, [shopId, vid])).rows.map((r) => ({ delta: N(r.delta), kind: r.kind, reason: r.reason }));

  // ── NHÀ CUNG CẤP ───────────────────────────────────────────────────────────
  sect('Nhà cung cấp: tạo / liệt kê / sửa / ẩn (is_active)');
  let r = await rq(SELLER, 'POST', `/shops/${shopId}/suppliers`, { body: { name: 'Xưởng A', phone: '0900111222', email: 'a@ncc.vn' }, cookie: oc, origin: OS });
  const supA = r.json?.id;
  r.status === 201 && supA ? ok('tạo NCC A') : bad('tạo NCC lỗi', r.raw);
  r = await rq(SELLER, 'POST', `/shops/${shopId}/suppliers`, { body: { name: '' }, cookie: oc, origin: OS });
  r.status === 400 ? ok('tên rỗng → 400') : bad('tên rỗng phải 400', r.status);
  r = await rq(SELLER, 'POST', `/shops/${shopId}/suppliers`, { body: { name: 'X', email: 'sai-email' }, cookie: oc, origin: OS });
  r.status === 400 ? ok('email sai → 400') : bad('email sai phải 400', r.status);
  r = await rq(SELLER, 'GET', `/shops/${shopId}/suppliers`, { cookie: oc });
  r.status === 200 && r.json.suppliers.some((s) => s.id === supA) ? ok('liệt kê thấy NCC A') : bad('liệt kê NCC lỗi', r.raw);
  r = await rq(SELLER, 'PATCH', `/shops/${shopId}/suppliers/${supA}`, { body: { name: 'Xưởng A1', is_active: false }, cookie: oc, origin: OS });
  r.status === 200 ? ok('sửa + ẩn NCC A') : bad('sửa NCC lỗi', r.raw);
  r = await rq(SELLER, 'GET', `/shops/${shopId}/suppliers`, { cookie: oc });
  !r.json.suppliers.some((s) => s.id === supA) ? ok('NCC đã ẩn không hiện trong list mặc định') : bad('NCC ẩn vẫn hiện', r.raw);
  r = await rq(SELLER, 'GET', `/shops/${shopId}/suppliers?all=1`, { cookie: oc });
  r.json.suppliers.some((s) => s.id === supA) ? ok('?all=1 hiện cả NCC ẩn') : bad('all=1 lỗi', r.raw);
  // Phiếu nhập KHÔNG tạo được với NCC đã ẩn.
  r = await rq(SELLER, 'POST', `/shops/${shopId}/purchase-orders`, { body: { supplier_id: supA, lines: [] }, cookie: oc, origin: OS });
  r.status === 400 ? ok('tạo phiếu với NCC đã ẩn → 400') : bad('NCC ẩn vẫn tạo được phiếu', r.status);
  // Bật lại NCC để dùng tiếp.
  await rq(SELLER, 'PATCH', `/shops/${shopId}/suppliers/${supA}`, { body: { name: 'Xưởng A1', is_active: true }, cookie: oc, origin: OS });

  // ── PHIẾU NHẬP + NHẬN HÀNG ──────────────────────────────────────────────────
  sect('Phiếu nhập: tạo draft + subtotal cache đúng');
  const V1 = await mk('WA', 120000, 0);   // on_hand 0, cost null
  const V2 = await mk('NC', 50000, 5);    // on_hand 5, cost null
  r = await rq(SELLER, 'POST', `/shops/${shopId}/purchase-orders`, { body: { supplier_id: supA, note: 'lô 1', lines: [{ variant_id: V1, qty: 2, unit_cost_vnd: 1000 }, { variant_id: V2, qty: 3, unit_cost_vnd: 2000 }] }, cookie: oc, origin: OS });
  const po1 = r.json?.id;
  r.status === 201 && po1 ? ok(`tạo phiếu #${r.json.po_number}`) : bad('tạo phiếu lỗi', r.raw);
  r = await rq(SELLER, 'GET', `/shops/${shopId}/purchase-orders/${po1}`, { cookie: oc });
  N(r.json.subtotal_vnd) === 8000 && r.json.lines.length === 2 && r.json.status === 'draft'
    ? ok('subtotal = 2×1000 + 3×2000 = 8000 (cache SQL bigint)') : bad('subtotal/lines sai', `${r.json.subtotal_vnd} lines=${r.json.lines?.length}`);
  // Snapshot title/sku có mặt.
  r.json.lines.every((l) => l.title_snapshot && l.sku_snapshot) ? ok('dòng có snapshot title/sku (chống pool-reuse)') : bad('thiếu snapshot', JSON.stringify(r.json.lines));

  sect('Chống dòng trùng + biến thể lạ');
  r = await rq(SELLER, 'POST', `/shops/${shopId}/purchase-orders`, { body: { supplier_id: supA, lines: [{ variant_id: V1, qty: 1, unit_cost_vnd: 1 }, { variant_id: V1, qty: 2, unit_cost_vnd: 2 }] }, cookie: oc, origin: OS });
  r.status === 400 ? ok('biến thể trùng trong phiếu → 400') : bad('trùng biến thể phải 400', r.status);
  r = await rq(SELLER, 'POST', `/shops/${shopId}/purchase-orders`, { body: { supplier_id: supA, lines: [{ variant_id: '00000000-0000-0000-0000-000000000000', qty: 1, unit_cost_vnd: 1 }] }, cookie: oc, origin: OS });
  r.status === 400 ? ok('biến thể không tồn tại → 400') : bad('biến thể lạ phải 400', r.status);

  sect('Sửa dòng phiếu (draft) → subtotal tính lại');
  r = await rq(SELLER, 'PATCH', `/shops/${shopId}/purchase-orders/${po1}`, { body: { lines: [{ variant_id: V1, qty: 10, unit_cost_vnd: 120000 }, { variant_id: V2, qty: 5, unit_cost_vnd: 80000 }], note: 'lô 1 sửa' }, cookie: oc, origin: OS });
  const d = (await rq(SELLER, 'GET', `/shops/${shopId}/purchase-orders/${po1}`, { cookie: oc })).json;
  r.status === 200 && N(d.subtotal_vnd) === (10 * 120000 + 5 * 80000) ? ok('subtotal sau sửa = 1.600.000') : bad('sửa subtotal sai', `${r.status} ${d.subtotal_vnd}`);

  sect('draft → ordered → NHẬN: on_hand += qty, 1 ledger receive/dòng, cost = giá nhập (cũ NULL)');
  await rq(SELLER, 'POST', `/shops/${shopId}/purchase-orders/${po1}/order`, { cookie: oc, origin: OS });
  r = await rq(SELLER, 'POST', `/shops/${shopId}/purchase-orders/${po1}/receive`, { cookie: oc, origin: OS });
  const h1V1 = await onHandOf(V1), h1V2 = await onHandOf(V2);
  r.status === 200 && h1V1 === 10 && h1V2 === 10 ? ok('on_hand: V1 0→10, V2 5→10 (nhận qty 5 sau sửa)') : bad('on_hand sau nhận sai', `${r.status} V1=${h1V1} V2=${h1V2}`);
  const lgV1 = await ledgerOf(V1);
  const recV1 = lgV1.filter((x) => x.kind === 'receive');
  recV1.length === 1 && recV1[0].delta === 10 && recV1[0].reason.includes('Nhập phiếu')
    ? ok(`ledger V1: đúng 1 dòng receive delta=10 ("${recV1[0].reason}")`) : bad('ledger receive V1 sai', JSON.stringify(lgV1));
  // Bất biến Σledger == on_hand.
  const sumV1 = lgV1.reduce((s, x) => s + x.delta, 0);
  sumV1 === h1V1 ? ok(`bất biến Σledger(${sumV1}) == on_hand(${h1V1})`) : bad('Σledger != on_hand', `${sumV1} vs ${h1V1}`);
  // Giá vốn: V1 cũ NULL → = giá nhập 120000; V2 cũ NULL (dù on_hand 5>0) → = 80000 (không weighted với unknown).
  (await costOf(V1)) === 120000 ? ok('cost V1 = 120.000 (cũ NULL → lấy giá nhập)') : bad('cost V1 sai', await costOf(V1));
  (await costOf(V2)) === 80000 ? ok('cost V2 = 80.000 (cũ NULL dù có tồn → lấy giá nhập, không coi 0)') : bad('cost V2 sai', await costOf(V2));

  sect('NHẬN LẦN 2 phiếu khác → BÌNH QUÂN GIA QUYỀN di động');
  // V1: đang on_hand=10, cost=120000. Nhận thêm 10 @ 220000 → (10*120000+10*220000)/20 = 170000.
  r = await rq(SELLER, 'POST', `/shops/${shopId}/purchase-orders`, { body: { supplier_id: supA, lines: [{ variant_id: V1, qty: 10, unit_cost_vnd: 220000 }] }, cookie: oc, origin: OS });
  const po2 = r.json.id;
  await rq(SELLER, 'POST', `/shops/${shopId}/purchase-orders/${po2}/receive`, { cookie: oc, origin: OS });
  const h2V1 = await onHandOf(V1), c2V1 = await costOf(V1);
  h2V1 === 20 && c2V1 === 170000 ? ok('V1: on_hand 20, cost bình quân = 170.000') : bad('weighted-avg sai', `on_hand=${h2V1} cost=${c2V1}`);

  sect('on_hand cũ ≤ 0 nhưng cost cũ có → lấy giá nhập (không weighted với 0 tồn)');
  const V3 = await mk('ZC', 90000, 0);
  await setCost(V3, 50000); // có cost nhưng on_hand=0
  r = await rq(SELLER, 'POST', `/shops/${shopId}/purchase-orders`, { body: { supplier_id: supA, lines: [{ variant_id: V3, qty: 4, unit_cost_vnd: 90000 }] }, cookie: oc, origin: OS });
  const po3 = r.json.id;
  await rq(SELLER, 'POST', `/shops/${shopId}/purchase-orders/${po3}/receive`, { cookie: oc, origin: OS });
  (await onHandOf(V3)) === 4 && (await costOf(V3)) === 90000 ? ok('V3: on_hand 4, cost = 90.000 (on_hand cũ 0 → không weighted)') : bad('V3 cost sai', `${await onHandOf(V3)}/${await costOf(V3)}`);

  sect('Chứng từ TERMINAL: nhận-2-lần + huỷ-đã-nhận + sửa-đã-nhận đều chặn');
  r = await rq(SELLER, 'POST', `/shops/${shopId}/purchase-orders/${po1}/receive`, { cookie: oc, origin: OS });
  r.status === 409 ? ok('nhận lần 2 cùng phiếu → 409 (không cộng tồn 2 lần)') : bad('nhận-2-lần phải 409', r.status);
  r = await rq(SELLER, 'POST', `/shops/${shopId}/purchase-orders/${po1}/cancel`, { cookie: oc, origin: OS });
  r.status === 409 ? ok('huỷ phiếu đã nhận → 409') : bad('huỷ-đã-nhận phải 409', r.status);
  r = await rq(SELLER, 'PATCH', `/shops/${shopId}/purchase-orders/${po1}`, { body: { note: 'sửa sau chốt' }, cookie: oc, origin: OS });
  r.status === 409 ? ok('sửa phiếu đã nhận → 409') : bad('sửa-đã-nhận phải 409', r.status);
  // Xác nhận on_hand KHÔNG đổi sau các lần bị chặn.
  (await onHandOf(V1)) === 20 ? ok('on_hand V1 vẫn 20 sau các thao tác bị chặn') : bad('on_hand đổi sau khi bị chặn', await onHandOf(V1));

  sect('Nhận phiếu RỖNG (0 dòng) → 400');
  r = await rq(SELLER, 'POST', `/shops/${shopId}/purchase-orders`, { body: { supplier_id: supA, lines: [] }, cookie: oc, origin: OS });
  const poEmpty = r.json.id;
  r = await rq(SELLER, 'POST', `/shops/${shopId}/purchase-orders/${poEmpty}/receive`, { cookie: oc, origin: OS });
  r.status === 400 ? ok('nhận phiếu rỗng → 400') : bad('phiếu rỗng phải 400', r.status);

  sect('Huỷ phiếu draft → không đụng tồn');
  r = await rq(SELLER, 'POST', `/shops/${shopId}/purchase-orders/${poEmpty}/cancel`, { cookie: oc, origin: OS });
  const dc = (await rq(SELLER, 'GET', `/shops/${shopId}/purchase-orders/${poEmpty}`, { cookie: oc })).json;
  r.status === 200 && dc.status === 'cancelled' ? ok('huỷ draft OK → status cancelled') : bad('huỷ draft lỗi', `${r.status} ${dc.status}`);

  // ── RBAC ────────────────────────────────────────────────────────────────────
  sect('RBAC: order_manager KHÔNG có inventory.manage → 403 mọi route nhập hàng');
  const ome = `om-${uniq()}@shop.vn`, omp = 'order manager strong pass';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: ome, role: 'order_manager' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(ome), password: omp }, origin: OA });
  const omc = await login(ome, omp);
  r = await rq(SELLER, 'GET', `/shops/${shopId}/suppliers`, { cookie: omc });
  r.status === 403 ? ok('order_manager GET suppliers → 403') : bad('order_manager phải 403', r.status);
  r = await rq(SELLER, 'POST', `/shops/${shopId}/purchase-orders/${po1}/receive`, { cookie: omc, origin: OS });
  r.status === 403 ? ok('order_manager receive → 403') : bad('order_manager receive phải 403', r.status);

  // ── IDOR chéo-shop ──────────────────────────────────────────────────────────
  sect('IDOR: chủ shop B KHÔNG thấy phiếu/NCC của shop A (RLS)');
  const B = await makeShop(staff, 'pob');
  // Shop B owner có thành viên shop B nhưng dùng id tài nguyên của A → RLS 404.
  r = await rq(SELLER, 'GET', `/shops/${B.shopId}/purchase-orders/${po1}`, { cookie: B.oc });
  r.status === 404 ? ok('B đọc phiếu A qua ngữ cảnh B → 404 (RLS)') : bad('IDOR phiếu chéo-shop', r.status);
  r = await rq(SELLER, 'GET', `/shops/${B.shopId}/suppliers/${supA}`, { cookie: B.oc });
  r.status === 404 ? ok('B đọc NCC A qua ngữ cảnh B → 404 (RLS)') : bad('IDOR NCC chéo-shop', r.status);
  // B không là thành viên A → truy cập trực tiếp URL của A = 404 ở dispatcher.
  r = await rq(SELLER, 'GET', `/shops/${shopId}/purchase-orders/${po1}`, { cookie: B.oc });
  r.status === 404 ? ok('B gọi URL shop A (không phải thành viên) → 404') : bad('non-member phải 404', r.status);

  // ── BIẾN THỂ CÓ THỂ NHẬP (kể cả SP nháp/ẩn) ──────────────────────────────────
  sect('purchasable-variants: gồm cả SP nháp (khác sellable-variants)');
  const draftP = await rq(SELLER, 'POST', `/shops/${shopId}/products`, { body: { title: 'Nháp', slug: `sp-${uniq()}`, price_vnd: 10000, status: 'draft', variants: [{ sku: `DR-${uniq()}`, price_vnd: 10000 }] }, cookie: oc, origin: OS });
  const draftVid = (await rq(SELLER, 'GET', `/shops/${shopId}/products/${draftP.json.id}`, { cookie: oc })).json.variants[0].id;
  const pv = await rq(SELLER, 'GET', `/shops/${shopId}/purchasable-variants`, { cookie: oc });
  const sv = await rq(SELLER, 'GET', `/shops/${shopId}/sellable-variants`, { cookie: oc });
  pv.json.variants.some((v) => v.id === draftVid) && !sv.json.variants.some((v) => v.id === draftVid)
    ? ok('SP nháp: có trong purchasable, KHÔNG có trong sellable') : bad('purchasable/sellable lọc sai', `pv=${pv.json.variants.some((v) => v.id === draftVid)} sv=${sv.json.variants.some((v) => v.id === draftVid)}`);
  pv.json.variants.find((v) => v.id === V1)?.cost_vnd === 170000 ? ok('purchasable kèm giá vốn hiện hành (V1=170.000)') : bad('purchasable thiếu cost', JSON.stringify(pv.json.variants.find((v) => v.id === V1)));

  // ── KIỂM KÊ ──────────────────────────────────────────────────────────────────
  sect('Kiểm kê: tạo phiên (list) → snapshot system_qty = on_hand hiện tại');
  r = await rq(SELLER, 'POST', `/shops/${shopId}/stocktakes`, { body: { scope: 'list', variant_ids: [V1, V2], note: 'kho A' }, cookie: oc, origin: OS });
  const st1 = r.json?.id;
  r.status === 201 && r.json.lines === 2 ? ok(`tạo phiên kiểm kê #${r.json.stocktake_number} (2 dòng)`) : bad('tạo kiểm kê lỗi', r.raw);
  let sd = (await rq(SELLER, 'GET', `/shops/${shopId}/stocktakes/${st1}`, { cookie: oc })).json;
  const sysV1 = sd.lines.find((l) => l.variant_id === V1)?.system_qty;
  N(sysV1) === 20 ? ok('system_qty V1 = 20 (snapshot lúc tạo)') : bad('snapshot system_qty sai', sysV1);

  sect('Đếm → chốt: on_hand về số đếm, 1 ledger adjust cho chênh, dòng khớp KHÔNG ghi ledger');
  r = await rq(SELLER, 'PATCH', `/shops/${shopId}/stocktakes/${st1}`, { body: { counts: [{ variant_id: V1, counted_qty: 18 }, { variant_id: V2, counted_qty: 10 }] }, cookie: oc, origin: OS });
  r.status === 200 && r.json.updated === 2 ? ok('ghi đếm 2 dòng (V1=18 thiếu 2, V2=10 khớp)') : bad('ghi đếm lỗi', r.raw);
  const lgBefore = (await ledgerOf(V1)).filter((x) => x.kind === 'adjust' && x.reason.includes('Kiểm kê')).length;
  r = await rq(SELLER, 'POST', `/shops/${shopId}/stocktakes/${st1}/complete`, { cookie: oc, origin: OS });
  const h3V1 = await onHandOf(V1), h3V2 = await onHandOf(V2);
  const adjRows = (await ledgerOf(V1)).filter((x) => x.kind === 'adjust' && x.reason.includes('Kiểm kê'));
  r.status === 200 && h3V1 === 18 && h3V2 === 10 && r.json.adjusted_lines === 1 && r.json.net_delta === -2
    ? ok('chốt: V1 20→18, V2 khớp 10; adjusted_lines=1, net_delta=-2') : bad('chốt kiểm kê sai', `${r.status} V1=${h3V1} V2=${h3V2} ${JSON.stringify(r.json)}`);
  adjRows.length === lgBefore + 1 && adjRows[adjRows.length - 1].delta === -2
    ? ok('đúng 1 ledger adjust delta=-2 cho V1 (V2 khớp không ghi)') : bad('ledger adjust sai', JSON.stringify(adjRows));
  // Σledger==on_hand vẫn đúng sau adjust.
  const sumV1b = (await ledgerOf(V1)).reduce((s, x) => s + x.delta, 0);
  sumV1b === h3V1 ? ok(`bất biến Σledger(${sumV1b}) == on_hand(${h3V1}) sau kiểm kê`) : bad('Σledger != on_hand sau kiểm kê', `${sumV1b} vs ${h3V1}`);
  // system_qty ghi đè = on_hand sống đã dùng (20).
  sd = (await rq(SELLER, 'GET', `/shops/${shopId}/stocktakes/${st1}`, { cookie: oc })).json;
  N(sd.lines.find((l) => l.variant_id === V1)?.system_qty) === 20 && sd.status === 'completed'
    ? ok('sau chốt: system_qty=20 (cơ sở chênh thực), status=completed') : bad('system_qty ghi đè sai', JSON.stringify(sd.lines));

  sect('Terminal: chốt lại / đếm lại phiên đã hoàn → 409');
  r = await rq(SELLER, 'POST', `/shops/${shopId}/stocktakes/${st1}/complete`, { cookie: oc, origin: OS });
  r.status === 409 ? ok('chốt lại phiên đã hoàn → 409') : bad('chốt-lại phải 409', r.status);
  r = await rq(SELLER, 'PATCH', `/shops/${shopId}/stocktakes/${st1}`, { body: { counts: [{ variant_id: V1, counted_qty: 5 }] }, cookie: oc, origin: OS });
  r.status === 409 ? ok('đếm phiên đã hoàn → 409') : bad('đếm-đã-hoàn phải 409', r.status);

  sect('CHẶN đếm < đang-giữ (reserved) — không đặt on_hand < reserved');
  // Đặt đơn tay giữ 5 của V1 (on_hand 18, reserved 5). Kiểm kê đếm 3 (<5) → chốt 409.
  r = await rq(SELLER, 'POST', `/shops/${shopId}/orders`, { body: { idempotency_key: `resv-${uniq()}`, lines: [{ variant_id: V1, qty: 5 }], customer: { name: 'Giữ', phone: '0912000111' }, payment_method: 'cod' }, cookie: oc, origin: OS });
  r.status === 201 ? ok('đơn tay giữ 5 của V1 (reserved=5)') : bad('tạo đơn giữ lỗi', r.raw);
  r = await rq(SELLER, 'POST', `/shops/${shopId}/stocktakes`, { body: { scope: 'list', variant_ids: [V1] }, cookie: oc, origin: OS });
  const st2 = r.json.id;
  await rq(SELLER, 'PATCH', `/shops/${shopId}/stocktakes/${st2}`, { body: { counts: [{ variant_id: V1, counted_qty: 3 }] }, cookie: oc, origin: OS });
  r = await rq(SELLER, 'POST', `/shops/${shopId}/stocktakes/${st2}/complete`, { cookie: oc, origin: OS });
  const h4V1 = await onHandOf(V1);
  r.status === 409 && h4V1 === 18 ? ok('đếm 3 < giữ 5 → chốt 409, on_hand giữ nguyên 18') : bad('chặn counted<reserved sai', `${r.status} on_hand=${h4V1}`);
  await rq(SELLER, 'POST', `/shops/${shopId}/stocktakes/${st2}/cancel`, { cookie: oc, origin: OS });

  sect('scope=all: gồm mọi biến thể không mồ côi của shop');
  r = await rq(SELLER, 'POST', `/shops/${shopId}/stocktakes`, { body: { scope: 'all' }, cookie: oc, origin: OS });
  r.status === 201 && r.json.lines >= 4 ? ok(`scope=all tạo phiên ${r.json.lines} dòng`) : bad('scope=all lỗi', r.raw);
  await rq(SELLER, 'POST', `/shops/${shopId}/stocktakes/${r.json.id}/cancel`, { cookie: oc, origin: OS });

  // ── BÁO CÁO NHẬP HÀNG ────────────────────────────────────────────────────────
  sect('Báo cáo nhập: tổng theo kỳ (phiếu đã nhận) + theo NCC + theo SP');
  r = await rq(SELLER, 'GET', `/shops/${shopId}/purchasing/report`, { cookie: oc });
  r.status === 200 && r.json.totals.po_count >= 3 && r.json.totals.value_vnd > 0 && r.json.by_supplier.length >= 1 && r.json.by_product.length >= 1
    ? ok(`báo cáo: ${r.json.totals.po_count} phiếu, ${r.json.totals.value_vnd}đ, ${r.json.by_supplier.length} NCC`) : bad('báo cáo nhập sai', r.raw);
  r = await rq(SELLER, 'GET', `/shops/${shopId}/purchasing/report?from=2020-13-40&to=2020-01-01`, { cookie: oc });
  r.status === 400 ? ok('ngày sai → 400') : bad('ngày sai phải 400', r.status);

  sect('RBAC + IDOR trên kiểm kê/báo cáo');
  r = await rq(SELLER, 'GET', `/shops/${shopId}/stocktakes`, { cookie: omc });
  const r2 = await rq(SELLER, 'GET', `/shops/${shopId}/purchasing/report`, { cookie: omc });
  r.status === 403 && r2.status === 403 ? ok('order_manager: stocktakes + report → 403') : bad('RBAC kiểm kê/báo cáo sai', `${r.status}/${r2.status}`);
  r = await rq(SELLER, 'GET', `/shops/${B.shopId}/stocktakes/${st1}`, { cookie: B.oc });
  r.status === 404 ? ok('B đọc phiên kiểm kê A qua ngữ cảnh B → 404 (RLS)') : bad('IDOR kiểm kê', r.status);

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
