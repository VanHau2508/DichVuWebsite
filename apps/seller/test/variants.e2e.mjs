/**
 * End-to-end biến thể ĐA TRỤC (options/values → sinh ma trận) + thông số. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/variants.e2e.mjs
 *
 * Kiểm: sinh cartesian đúng số tổ hợp; tái dùng biến thể theo combo khi sửa (giữ id/giá/tồn);
 * getProduct trả options+specs; validation trần tổ hợp; cô lập chéo shop.
 */

import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
// Token lời mời KHÔNG còn trong API response (email hoá, 0073) — lấy từ outbox qua owner SQL (ADR-006: cùng tx với INSERT invitations nên đọc được ngay).
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
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  r = await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA });
  return { shopId, cookie: ck(r.sc) };
}
const S = (shopId, cookie) => ({
  get: (p) => rq(SELLER, 'GET', `/shops/${shopId}${p}`, { cookie }),
  post: (p, body) => rq(SELLER, 'POST', `/shops/${shopId}${p}`, { body, cookie, origin: OS }),
  put: (p, body) => rq(SELLER, 'PUT', `/shops/${shopId}${p}`, { body, cookie, origin: OS }),
  patch: (p, body) => rq(SELLER, 'PATCH', `/shops/${shopId}${p}`, { body, cookie, origin: OS }),
});

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `axis-a-${uniq()}`);
  const Bs = await makeShopOwner(staff, `axis-b-${uniq()}`);
  const a = S(A.shopId, A.cookie);

  sect('1. Sinh ma trận từ 2 trục');
  const slug = `tham-${uniq()}`;
  let r = await a.post('/products', { title: 'Thảm đa trục', slug, price_vnd: 500000, status: 'active', variants: [{ sku: `${slug}-base`, price_vnd: 500000 }] });
  const pid = r.json.id;
  r.status === 201 ? ok('tạo sản phẩm (1 biến thể phẳng)') : bad('tạo SP lỗi', r.raw);

  r = await a.put(`/products/${pid}/options`, { options: [{ name: 'Màu', values: ['Đỏ', 'Xanh'] }, { name: 'Size', values: ['M', 'L'] }] });
  r.status === 200 && r.json.combos === 4 ? ok('2 trục (2×2) → 4 tổ hợp') : bad('sinh ma trận sai', r.raw);
  r.json.reused === 1 && r.json.generated === 3 ? ok('tái dùng 1 biến thể phẳng gốc + tạo mới 3') : bad(`reuse sai: reused=${r.json.reused} generated=${r.json.generated}`);

  r = await a.get(`/products/${pid}`);
  const titles = (r.json.variants ?? []).map((v) => v.title).sort();
  JSON.stringify(titles) === JSON.stringify(['Xanh / L', 'Xanh / M', 'Đỏ / L', 'Đỏ / M'].sort())
    ? ok('4 biến thể có nhãn tổ hợp đúng (Màu / Size)') : bad('nhãn biến thể sai', JSON.stringify(titles));
  (r.json.options ?? []).length === 2 && r.json.options[0].values.length === 2
    ? ok('getProduct trả options + values') : bad('options thiếu', JSON.stringify(r.json.options));
  (r.json.variants ?? []).every((v) => Number(v.price_vnd) === 500000)
    ? ok('biến thể mới lấy giá = giá sản phẩm (500.000)') : bad('giá biến thể sai');

  // Map DB: 4 biến thể × 2 trục = 8 dòng variant_option_values.
  const nmap = Number((await owner.query(
    `SELECT count(*)::int n FROM variant_option_values vov JOIN variants v ON v.id=vov.variant_id WHERE v.product_id=$1`, [pid])).rows[0].n);
  nmap === 8 ? ok('variant_option_values = 8 (4 biến thể × 2 trục)') : bad(`map sai: ${nmap}`);

  sect('2. Sửa trục: thêm giá trị → tái dùng theo tổ hợp (giữ id)');
  const idByTitle0 = Object.fromEntries((await a.get(`/products/${pid}`)).json.variants.map((v) => [v.title, v.id]));
  r = await a.put(`/products/${pid}/options`, { options: [{ name: 'Màu', values: ['Đỏ', 'Xanh'] }, { name: 'Size', values: ['M', 'L', 'XL'] }] });
  r.status === 200 && r.json.combos === 6 ? ok('2×3 → 6 tổ hợp') : bad('combos sai', r.raw);
  r.json.reused === 4 && r.json.generated === 2 ? ok('4 tổ hợp cũ TÁI DÙNG, 2 mới tạo') : bad(`reuse sai: reused=${r.json.reused} generated=${r.json.generated}`);
  const idByTitle1 = Object.fromEntries((await a.get(`/products/${pid}`)).json.variants.map((v) => [v.title, v.id]));
  ['Đỏ / M', 'Đỏ / L', 'Xanh / M', 'Xanh / L'].every((t) => idByTitle0[t] && idByTitle0[t] === idByTitle1[t])
    ? ok('id 4 biến thể cũ KHÔNG đổi (giữ giá/tồn/đơn)') : bad('id biến thể đổi khi sửa trục');

  sect('2b. Tổ hợp MỚI không kế thừa giá/tồn biến thể mồ côi (đường tiền)');
  // Biến thể 'Đỏ / M' đang có: giá khuyến mãi 480k + tồn 10.
  const redM = idByTitle1['Đỏ / M'];
  await owner.query(`UPDATE variants SET price_vnd = 480000 WHERE id = $1`, [redM]);
  // Seed tồn PHẢI kèm ledger 'receive' (giữ bất biến tổng delta == on_hand cho check dưới).
  await owner.query(`INSERT INTO inventory_levels (shop_id, variant_id, on_hand) VALUES ($1,$2,10) ON CONFLICT (shop_id,variant_id) DO UPDATE SET on_hand=10`, [A.shopId, redM]);
  await owner.query(`INSERT INTO inventory_ledger (shop_id, variant_id, delta, kind, reason) VALUES ($1,$2,10,'receive','seed test')`, [A.shopId, redM]);
  // + giá VỐN (0081) trên biến thể sắp mồ côi — tổ hợp mới KHÔNG được kế thừa (cùng lớp bug).
  await owner.query(`INSERT INTO variant_costs (shop_id, variant_id, cost_vnd) VALUES ($1,$2,300000) ON CONFLICT (shop_id,variant_id) DO UPDATE SET cost_vnd=300000`, [A.shopId, redM]);
  // ĐỔI TÊN trục 'Màu'→'Mau' → mọi biến thể cũ thành MỒ CÔI (khoá combo lệch), rồi
  // THÊM 'Vàng' → tổ hợp mới lấy biến thể mồ côi từ pool. Nó KHÔNG được kế thừa 480k/tồn 10.
  r = await a.put(`/products/${pid}/options`, { options: [{ name: 'Mau', values: ['Đỏ', 'Xanh'] }, { name: 'Size', values: ['M', 'L', 'XL'] }] });
  r.status === 200 ? ok('đổi tên trục Màu→Mau → 200 (biến thể cũ mồ côi)') : bad('đổi tên trục lỗi', r.raw);
  r = await a.put(`/products/${pid}/options`, { options: [{ name: 'Mau', values: ['Đỏ', 'Xanh', 'Vàng'] }, { name: 'Size', values: ['M', 'L', 'XL'] }] });
  r.status === 200 && r.json.combos === 9 ? ok('thêm Vàng → 9 tổ hợp (pool tái dùng mồ côi)') : bad('combos sai', r.raw);
  const vang = (await owner.query(
    `SELECT v.price_vnd, coalesce(il.on_hand - il.reserved, 0) AS avail
       FROM variants v LEFT JOIN inventory_levels il ON il.variant_id = v.id
      WHERE v.product_id = $1 AND v.title LIKE 'Vàng /%'`, [pid])).rows;
  vang.length === 3 && vang.every((x) => Number(x.price_vnd) === 500000)
    ? ok('tổ hợp Vàng = GIÁ SẢN PHẨM 500k (không kế thừa giá khuyến mãi 480k)') : bad('tổ hợp mới sai giá', JSON.stringify(vang));
  vang.every((x) => Number(x.avail) === 0)
    ? ok('tổ hợp Vàng tồn BÁN ĐƯỢC = 0 (không kế thừa tồn ảo)') : bad('tổ hợp mới có tồn ảo', JSON.stringify(vang));
  const vangCost = Number((await owner.query(
    `SELECT count(*)::int n FROM variant_costs vc JOIN variants v ON v.id = vc.variant_id
      WHERE v.product_id = $1 AND v.title LIKE 'Vàng /%'`, [pid])).rows[0].n);
  vangCost === 0 ? ok('tổ hợp Vàng KHÔNG kế thừa giá vốn biến thể mồ côi (variant_costs đã xoá)') : bad(`tổ hợp mới mang cost ma: ${vangCost} dòng`);
  // Bất biến ledger: tổng delta == on_hand cho mọi variant của SP (reset tồn phải ghi ledger).
  const ledgerOk = (await owner.query(
    `SELECT count(*)::int bad FROM (
       SELECT il.variant_id FROM inventory_levels il JOIN variants v ON v.id = il.variant_id
        WHERE v.product_id = $1
        GROUP BY il.variant_id, il.on_hand
       HAVING il.on_hand <> coalesce((SELECT sum(delta) FROM inventory_ledger l WHERE l.variant_id = il.variant_id), 0)
     ) x`, [pid])).rows[0].bad;
  ledgerOk === 0 ? ok('bất biến ledger giữ vững (tổng delta == on_hand)') : bad(`ledger lệch ở ${ledgerOk} biến thể`);

  sect('3. Thông số kỹ thuật (specs)');
  r = await a.put(`/products/${pid}/specs`, { specs: [{ name: 'Chất liệu', value: 'Polyester' }, { name: 'Xuất xứ', value: 'Việt Nam' }, { name: '', value: '' }] });
  r.status === 200 && r.json.count === 2 ? ok('lưu 2 thông số (bỏ dòng trống)') : bad('specs lỗi', r.raw);
  r = await a.get(`/products/${pid}`);
  (r.json.specs ?? []).length === 2 && r.json.specs[0].name === 'Chất liệu' ? ok('getProduct trả specs đúng thứ tự') : bad('specs sai', JSON.stringify(r.json.specs));

  sect('3b. Sửa giá từng biến thể (PATCH — dùng cho tổ hợp ma trận)');
  const anyV = (await a.get(`/products/${pid}`)).json.variants[0];
  r = await a.patch(`/products/${pid}/variants/${anyV.id}`, { price_vnd: 777000 });
  r.status === 200 ? ok('PATCH giá biến thể → 200') : bad('PATCH giá lỗi', r.raw);
  const vAfter = (await a.get(`/products/${pid}`)).json.variants.find((v) => v.id === anyV.id);
  Number(vAfter.price_vnd) === 777000 ? ok('giá biến thể đổi thành 777.000') : bad(`giá sai: ${vAfter.price_vnd}`);
  r = await a.patch(`/products/${pid}/variants/${anyV.id}`, { price_vnd: -5 });
  r.status === 400 ? ok('giá âm → 400') : bad('không chặn giá âm', r.raw);
  r = await S(Bs.shopId, Bs.cookie).patch(`/products/${pid}/variants/${anyV.id}`, { price_vnd: 1000 });
  r.status === 404 ? ok('shop B PATCH giá biến thể shop A → 404 (cô lập)') : bad('rò sửa giá chéo shop', r.raw);

  sect('3b. Giá vốn (0081): PATCH nhập/sửa/xoá + cô lập');
  const anyV2 = (await a.get(`/products/${pid}`)).json.variants[0];
  r = await a.patch(`/products/${pid}/variants/${anyV2.id}`, { cost_vnd: 350000 });
  r.status === 200 ? ok('PATCH chỉ cost_vnd (không trường variants nào) → 200') : bad('cost-only PATCH lỗi', r.raw);
  let vGot = (await a.get(`/products/${pid}`)).json.variants.find((v) => v.id === anyV2.id);
  Number(vGot.cost_vnd) === 350000 ? ok('getProduct trả cost_vnd=350.000') : bad(`cost đọc sai: ${vGot.cost_vnd}`);
  r = await a.patch(`/products/${pid}/variants/${anyV2.id}`, { cost_vnd: 999.5 });
  r.status === 400 ? ok('cost thập phân → 400') : bad('không chặn cost rác', r.raw);
  r = await a.patch(`/products/${pid}/variants/${anyV2.id}`, { cost_vnd: null });
  vGot = (await a.get(`/products/${pid}`)).json.variants.find((v) => v.id === anyV2.id);
  r.status === 200 && vGot.cost_vnd == null ? ok('cost=null → xoá dòng (getProduct trả null)') : bad('xoá cost lỗi', `${r.status} ${vGot.cost_vnd}`);
  r = await S(Bs.shopId, Bs.cookie).patch(`/products/${pid}/variants/${anyV2.id}`, { cost_vnd: 1000 });
  r.status === 404 ? ok('shop B PATCH cost biến thể shop A → 404 (cô lập)') : bad('rò cost chéo shop', r.raw);
  const auditCost = (await owner.query(
    `SELECT metadata FROM audit_logs WHERE shop_id=$1 AND action='variant.updated' AND metadata->'changed'->'cost_vnd' IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [A.shopId])).rows;
  auditCost.length === 1 ? ok('audit variant.updated ghi diff cost_vnd from/to') : bad('thiếu audit cost');

  sect('4. Validation + cô lập chéo shop');
  r = await a.put(`/products/${pid}/options`, { options: [{ name: 'A', values: Array.from({ length: 11 }, (_, i) => `a${i}`) }, { name: 'B', values: Array.from({ length: 11 }, (_, i) => `b${i}`) }] });
  r.status === 400 ? ok('121 tổ hợp > 100 → 400 (chặn bùng nổ)') : bad('không chặn trần tổ hợp', r.raw);
  r = await a.put(`/products/${pid}/options`, { options: [{ name: 'Màu', values: [] }] });
  r.status === 400 ? ok('trục không có giá trị → 400') : bad('không chặn trục rỗng', r.raw);
  r = await S(Bs.shopId, Bs.cookie).put(`/products/${pid}/options`, { options: [{ name: 'X', values: ['1'] }] });
  r.status === 404 ? ok('shop B PUT options SP shop A → 404 (cô lập)') : bad('rò chéo shop', r.raw);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
