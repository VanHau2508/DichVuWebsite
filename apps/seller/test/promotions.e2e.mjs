// E2E API seller: Khuyến mãi tự động / Flash sale (0082). Kiểm CRUD + validate + GIỜ VN
// (must-fix red-team: datetime-local phải map đúng UTC, không lệch 7h) + cap 50 + scope
// products add/remove + FK cross-shop + status server-side + RBAC + cô lập tenant.
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = 'http://auth:3020', PLATFORM = 'http://platform:3030', SELLER = 'http://seller:3040';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 5 });
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };
let pass = 0, fail = 0;
// Ngày TƯƠNG ĐỐI theo lịch VN. Bộ test này từng cắm cứng '2026-07-20'→'2026-07-25' nên
// ĐẾN 2026-07-25 là chết cả bộ (API đúng khi từ chối "kết thúc phải ở tương lai") — test
// KHÔNG được có hạn sử dụng. +7h rồi lấy phần ngày = đúng ngày theo lịch VN.
const vnDay = (offsetDays) => new Date(Date.now() + offsetDays * 86400000 + 7 * 3600000).toISOString().slice(0, 10);
const S = `${vnDay(3)}T00:00`;  // bắt đầu: 3 ngày nữa
const E = `${vnDay(8)}T00:00`;  // kết thúc: 8 ngày nữa
const ok = (m) => { pass++; console.log('  PASS ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? ' :: ' + String(d).slice(0, 200) : '')); };
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
const N = (x) => Number(x);

async function main() {
  const staff = await makeStaff();
  const mkShop = async (slug) => {
    const r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO });
    const shopId = r.json.id;
    const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
    await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
    await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
    return { shopId, oe, op, oc: await login(oe, op) };
  };
  const A = await mkShop(`promo-${uniq()}`);
  const { shopId, oc, op } = A;
  const P = (m, path, body) => rq(SELLER, m, `/shops/${shopId}${path}`, { body, cookie: oc, origin: OS });
  const mkProd = async (title, price) => {
    const p = await P('POST', '/products', { title, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `S-${uniq()}`, price_vnd: price }] });
    return p.json.id;
  };
  const inviteRole = async (role) => {
    const em = `${role}-${uniq()}@shop.vn`, pw = 'member passphrase strong';
    let r0 = await rq(SELLER, 'POST', `/shops/${shopId}/members/invite`, { body: { email: em, role }, cookie: oc, origin: OS });
    if (r0.status === 403) { await rq(AUTH, 'POST', '/auth/step-up', { body: { password: op }, cookie: oc, origin: OA }); await rq(SELLER, 'POST', `/shops/${shopId}/members/invite`, { body: { email: em, role }, cookie: oc, origin: OS }); }
    await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(em), password: pw }, origin: OA });
    return login(em, pw);
  };

  sect('1. Tạo promo percent + GIỜ VN map ĐÚNG UTC (must-fix)');
  let r = await P('POST', '/promotions', { title: 'Sale hè', kind: 'percent', value: 25, scope: 'all', starts_at: S, ends_at: E });
  r.status === 201 ? ok('tạo promo percent 25% toàn shop → 201') : bad('tạo promo lỗi', r.raw);
  const pid = r.json.id;
  const row = (await owner.query(`SELECT starts_at, ends_at FROM promotions WHERE id=$1`, [pid])).rows[0];
  // 00:00 giờ VN (UTC+7) = 17:00 UTC HÔM TRƯỚC. Kỳ vọng tính từ chính đầu vào nên
  // khẳng định vẫn thật: server hiểu sai múi giờ (lưu 00:00Z) là ĐỎ ngay.
  const wantUtc = new Date(`${S}:00+07:00`).toISOString();
  new Date(row.starts_at).toISOString() === wantUtc
    ? ok(`starts_at ${S} VN → lưu ${wantUtc} (KHÔNG lệch 7h)`) : bad('giờ VN map sai', new Date(row.starts_at).toISOString());

  sect('2. Validate: percent>100, ends≤starts, ends quá khứ, datetime rác, ngày ma');
  r = await P('POST', '/promotions', { title: 'x', kind: 'percent', value: 150, scope: 'all', starts_at: S, ends_at: E });
  r.status === 400 && /phần trăm/.test(r.json?.error ?? '') ? ok('percent 150 → 400') : bad('không chặn percent>100', r.raw);
  r = await P('POST', '/promotions', { title: 'x', kind: 'percent', value: 10, scope: 'all', starts_at: E, ends_at: S });
  r.status === 400 ? ok('ends ≤ starts → 400') : bad('không chặn ends<starts', r.raw);
  r = await P('POST', '/promotions', { title: 'x', kind: 'percent', value: 10, scope: 'all', starts_at: '2020-01-01T00:00', ends_at: '2020-01-02T00:00' });
  r.status === 400 && /tương lai/.test(r.json?.error ?? '') ? ok('ends quá khứ → 400') : bad('không chặn ends quá khứ', r.raw);
  r = await P('POST', '/promotions', { title: 'x', kind: 'percent', value: 10, scope: 'all', starts_at: 'rác', ends_at: E });
  r.status === 400 ? ok('datetime rác → 400') : bad('không chặn datetime rác', r.raw);
  r = await P('POST', '/promotions', { title: 'x', kind: 'percent', value: 10, scope: 'all', starts_at: '2099-02-31T00:00', ends_at: E });
  r.status === 400 ? ok('2099-02-31 (ngày không tồn tại) → 400') : bad('không chặn ngày ma', r.raw);

  sect('3. Fixed + cảnh báo fixed ≥ giá SP rẻ nhất (không chặn)');
  await mkProd('SP rẻ', 30000);
  r = await P('POST', '/promotions', { title: 'Giảm sốc', kind: 'fixed', value: 50000, scope: 'all', starts_at: S, ends_at: E });
  r.status === 201 && r.json.warning && /0đ|rẻ nhất/.test(r.json.warning) ? ok('fixed 50k ≥ giá rẻ nhất 30k → 201 kèm cảnh báo') : bad('thiếu cảnh báo fixed', r.raw);

  sect('4. scope=products: thêm/gỡ SP + FK cross-shop chặn');
  r = await P('POST', '/promotions', { title: 'SP chọn', kind: 'percent', value: 15, scope: 'products', starts_at: S, ends_at: E });
  const pidP = r.json.id;
  const prodA = await mkProd('SP A', 100000);
  r = await P('POST', `/promotions/${pidP}/products`, { product_id: prodA });
  r.status === 200 ? ok('thêm SP vào promo scope=products → 200') : bad('thêm SP lỗi', r.raw);
  // Thêm vào promo scope=all → 400.
  r = await P('POST', `/promotions/${pid}/products`, { product_id: prodA });
  r.status === 400 && /TOÀN SHOP/.test(r.json?.error ?? '') ? ok('thêm SP vào promo scope=all → 400') : bad('không chặn add vào all', r.raw);
  // SP của shop KHÁC → FK 400.
  const B = await mkShop(`promob-${uniq()}`);
  const prodB = await rq(SELLER, 'POST', `/shops/${B.shopId}/products`, { body: { title: 'B', slug: `sp-${uniq()}`, price_vnd: 100000, status: 'active', variants: [{ sku: `S-${uniq()}`, price_vnd: 100000 }] }, cookie: B.oc, origin: OS });
  r = await P('POST', `/promotions/${pidP}/products`, { product_id: prodB.json.id });
  r.status === 400 ? ok('thêm SP shop KHÁC → 400 (FK composite chặn)') : bad('rò chéo shop khi add SP', r.raw);
  // getPromotion trả danh sách SP.
  r = await P('GET', `/promotions/${pidP}`);
  r.status === 200 && r.json.products.length === 1 && r.json.products[0].product_id === prodA ? ok('GET chi tiết: 1 SP trong phạm vi') : bad('chi tiết SP sai', r.raw);
  r = await P('DELETE', `/promotions/${pidP}/products/${prodA}`);
  r.status === 200 ? ok('gỡ SP → 200') : bad('gỡ SP lỗi', r.raw);

  sect('5. Status server-side + kết thúc sớm (PATCH active=false) + xoá');
  r = await P('GET', '/promotions');
  const one = r.json.promotions.find((x) => x.id === pid);
  ['upcoming', 'running', 'ended', 'off'].includes(one.status) ? ok(`list có status server-side (${one.status})`) : bad('thiếu status', JSON.stringify(one));
  r = await P('PATCH', `/promotions/${pid}`, { active: false });
  const act = (await owner.query(`SELECT active FROM promotions WHERE id=$1`, [pid])).rows[0].active;
  r.status === 200 && act === false ? ok('kết thúc sớm (PATCH active=false) → 200, DB active=false') : bad('end sớm lỗi', r.raw);
  const auEnd = (await owner.query(`SELECT metadata FROM audit_logs WHERE shop_id=$1 AND action='promotion.updated' AND metadata->'changed'->'active' IS NOT NULL LIMIT 1`, [shopId])).rows;
  auEnd.length === 1 ? ok('audit promotion.updated ghi changed.active from→to') : bad('thiếu audit end');
  r = await P('DELETE', `/promotions/${pidP}`);
  r.status === 200 && N((await owner.query(`SELECT count(*)::int n FROM promotions WHERE id=$1`, [pidP])).rows[0].n) === 0 ? ok('DELETE promo → 200, CASCADE dọn promotion_products') : bad('xoá lỗi', r.raw);

  sect('6. Cap 50 promo active/shop');
  // Đã có: pid (đã tắt) + fixed + pidP(đã xoá). Đếm active hiện tại rồi tạo tới trần.
  const nowActive = N((await owner.query(`SELECT count(*)::int n FROM promotions WHERE shop_id=$1 AND active`, [shopId])).rows[0].n);
  for (let i = nowActive; i < 50; i++) await owner.query(`INSERT INTO promotions (shop_id,title,kind,value,scope,starts_at,ends_at) VALUES ($1,'bulk','percent',5,'all', now(), now()+interval '1 day')`, [shopId]);
  r = await P('POST', '/promotions', { title: 'thứ 51', kind: 'percent', value: 5, scope: 'all', starts_at: S, ends_at: E });
  r.status === 409 && /trần 50/.test(r.json?.error ?? '') ? ok('promo thứ 51 active → 409 (cap 50)') : bad('không chặn cap', r.raw);

  sect('7. RBAC: catalog_manager tạo được; order_manager 403; cô lập chéo shop');
  const cm = await inviteRole('catalog_manager');
  r = await rq(SELLER, 'POST', `/shops/${shopId}/promotions`, { body: { title: 'cm', kind: 'percent', value: 10, scope: 'all', starts_at: S, ends_at: E }, cookie: cm, origin: OS });
  (r.status === 201 || r.status === 409) ? ok(`catalog_manager tạo promo → ${r.status} (có quyền catalog.write)`) : bad('catalog_manager bị chặn sai', r.raw);
  const om = await inviteRole('order_manager');
  r = await rq(SELLER, 'GET', `/shops/${shopId}/promotions`, { cookie: om });
  r.status === 403 ? ok('order_manager GET promotions → 403') : bad('order_manager lọt', r.status);
  r = await rq(SELLER, 'GET', `/shops/${B.shopId}/promotions`, { cookie: oc });
  (r.status === 403 || r.status === 404) ? ok(`owner shop A xem promotions shop B → ${r.status} (không phải member, không lộ)`) : bad('rò chéo shop', r.status);

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
