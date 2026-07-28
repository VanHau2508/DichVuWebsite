/**
 * End-to-end quản sản phẩm & tồn kho qua admin (BFF). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-products.e2e.mjs
 *
 * Kiểm: tạo → sửa → đăng bán → điều chỉnh tồn → thêm/xoá biến thể → lưu trữ → xoá,
 * tất cả qua form PRG; cùng cô lập chéo shop + CSRF. BFF forward, `seller` cưỡng chế.
 */
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
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
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
async function adm(method, path, { cookie, origin, form } = {}) {
  const h = {};
  if (form !== undefined) h['content-type'] = 'application/x-www-form-urlencoded';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(ADMIN + path, { method, headers: h, redirect: 'manual', body: form !== undefined ? new URLSearchParams(form).toString() : undefined });
  const t = await r.text();
  return { status: r.status, location: r.headers.get('location'), sc: r.headers.getSetCookie(), csp: r.headers.get('content-security-policy'), body: t };
}
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;

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
  // A6: mfa/verify ROTATE token → lấy cookie mới
  cookie = ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA })).sc) ?? cookie;
  return cookie;
}
async function makeShopOwner(staffCookie, slug) {
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, name: slug, email, password, cookie: await login(email, password) };
}
// Đọc trạng thái thật từ seller (authoritative) để khỏi tin mỗi HTML.
const sget = (shopId, cookie, path) => rq(SELLER, 'GET', `/shops/${shopId}${path}`, { cookie });
const pidFrom = (loc) => /\/products\/([0-9a-f-]{36})$/.exec(loc ?? '')?.[1] ?? null;

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `pa-${uniq()}`);
  const Bo = await makeShopOwner(staff, `pb-${uniq()}`);
  const P = (p) => `/shops/${A.shopId}/products${p}`;
  ok('dựng 2 shop + chủ shop');

  // ── 1. Danh sách rỗng + form tạo ───────────────────────────────────────────
  sect('1. Danh sách & tạo');
  let r = await adm('GET', P(''), { cookie: A.cookie });
  r.status === 200 && /Chưa có sản phẩm/.test(r.body) && /Sản phẩm/.test(r.body) ? ok('danh sách rỗng + tab Sản phẩm') : bad('danh sách rỗng sai', r.body.slice(0, 200));

  r = await adm('GET', P('/new'), { cookie: A.cookie });
  r.status === 200 && /Thêm sản phẩm/.test(r.body) && r.body.includes('name="sku"') ? ok('form thêm sản phẩm render') : bad('form thêm sai', r.body.slice(0, 150));

  // Thiếu tên → backend 400 → BFF render lại form kèm lỗi.
  r = await adm('POST', P(''), { cookie: A.cookie, origin: OADM, form: { slug: `s-${uniq()}`, price_vnd: '100000', sku: `K-${uniq()}`, variant_price_vnd: '100000' } });
  r.status === 400 && /hợp lệ/.test(r.body) ? ok('tạo thiếu tên → 400 + báo lỗi') : bad('thiếu tên không bị chặn', String(r.status));

  const slug = `ghe-sofa-${uniq()}`;
  r = await adm('POST', P(''), { cookie: A.cookie, origin: OADM, form: { title: 'Ghế sofa demo', slug, price_vnd: '4990000', status: 'draft', description: 'Sofa 3 chỗ', sku: `SOFA-${uniq()}`, variant_price_vnd: '4990000' } });
  const pid = pidFrom(r.location);
  r.status === 303 && pid ? ok(`tạo sản phẩm → 303 chi tiết (pid ${pid.slice(0, 8)}…)`) : bad('tạo sản phẩm lỗi', `${r.status} ${r.location}`);

  // ── 2. Chi tiết + sửa ──────────────────────────────────────────────────────
  sect('2. Chi tiết & sửa');
  r = await adm('GET', P(`/${pid}`), { cookie: A.cookie });
  // Giá biến thể giờ là Ô SỬA ĐƯỢC (input value=4990000) thay vì text định dạng 4.990.000.
  r.status === 200 && r.body.includes('Ghế sofa demo') && /Nháp/.test(r.body) && r.body.includes('value="4990000"') ? ok('chi tiết: tên + trạng thái Nháp + ô giá sửa được') : bad('chi tiết sai', r.body.slice(0, 200));

  r = await adm('POST', P(`/${pid}`), { cookie: A.cookie, origin: OADM, form: { title: 'Ghế sofa cao cấp', slug, price_vnd: '5290000', description: 'Đã nâng cấp' } });
  const afterEdit = (await sget(A.shopId, A.cookie, `/products/${pid}`)).json;
  r.status === 303 && afterEdit.title === 'Ghế sofa cao cấp' && Number(afterEdit.price_vnd) === 5290000 ? ok('sửa tên + giá → 303 + DB đổi') : bad('sửa lỗi', `${r.status} ${afterEdit.title} ${afterEdit.price_vnd}`);

  // ── 2b. Sửa lỗi phải GIỮ input vừa gõ (không revert về DB) ─────────────────
  sect('2b. Sửa lỗi giữ input');
  const slug2 = `ban-tra-${uniq()}`;
  r = await adm('POST', P(''), { cookie: A.cookie, origin: OADM, form: { title: 'Bàn trà', slug: slug2, price_vnd: '1850000', status: 'draft', sku: `BAN-${uniq()}`, variant_price_vnd: '1850000' } });
  // Sửa P1 sang slug đã dùng (P2) + tên/mô tả mới → backend 409, BFF phải giữ input.
  r = await adm('POST', P(`/${pid}`), { cookie: A.cookie, origin: OADM, form: { title: 'TÊN VỪA GÕ ĐẶC BIỆT', slug: slug2, price_vnd: '6000000', description: 'mô tả vừa gõ' } });
  const kept = r.body.includes('TÊN VỪA GÕ ĐẶC BIỆT') && r.body.includes(slug2) && r.body.includes('mô tả vừa gõ');
  const dbTitle = (await sget(A.shopId, A.cookie, `/products/${pid}`)).json.title;
  r.status >= 400 && kept && dbTitle === 'Ghế sofa cao cấp' ? ok('sửa đụng slug → lỗi + giữ input vừa gõ, DB không đổi') : bad('sửa lỗi nuốt input hoặc đổi DB', `${r.status} kept=${kept} db=${dbTitle}`);

  // ── 3. Đăng bán ────────────────────────────────────────────────────────────
  sect('3. Trạng thái');
  r = await adm('POST', P(`/${pid}/publish`), { cookie: A.cookie, origin: OADM });
  let st = (await sget(A.shopId, A.cookie, `/products/${pid}`)).json.status;
  r.status === 303 && st === 'active' ? ok('đăng bán → active') : bad('publish lỗi', `${r.status} ${st}`);

  // ── 4. Điều chỉnh tồn ──────────────────────────────────────────────────────
  sect('4. Tồn kho');
  const vid = afterEdit.variants[0].id;
  r = await adm('POST', P(`/${pid}/variants/${vid}/inventory`), { cookie: A.cookie, origin: OADM, form: { delta: '50', reason: 'nhập lô đầu' } });
  let lvl = (await sget(A.shopId, A.cookie, `/variants/${vid}/inventory`)).json;
  r.status === 303 && lvl.on_hand === 50 ? ok('nhập +50 → on_hand 50') : bad('điều chỉnh tồn lỗi', `${r.status} ${JSON.stringify(lvl)}`);

  r = await adm('POST', P(`/${pid}/variants/${vid}/inventory`), { cookie: A.cookie, origin: OADM, form: { delta: '-100', reason: 'thử vượt' } });
  lvl = (await sget(A.shopId, A.cookie, `/variants/${vid}/inventory`)).json;
  r.status >= 400 && /tồn/.test(r.body) && lvl.on_hand === 50 ? ok('giảm quá tồn → lỗi, on_hand giữ 50') : bad('cho tồn âm', `${r.status} ${lvl.on_hand}`);

  r = await adm('GET', P(`/${pid}`), { cookie: A.cookie });
  /50/.test(r.body) ? ok('chi tiết hiện tồn 50') : bad('chi tiết không hiện tồn', r.body.slice(0, 150));

  // ── 5. Biến thể ────────────────────────────────────────────────────────────
  sect('5. Biến thể');
  r = await adm('POST', P(`/${pid}/variants`), { cookie: A.cookie, origin: OADM, form: { sku: `SOFA2-${uniq()}`, price_vnd: '5590000' } });
  let prod = (await sget(A.shopId, A.cookie, `/products/${pid}`)).json;
  r.status === 303 && prod.variants.length === 2 ? ok('thêm biến thể → 2 biến thể') : bad('thêm biến thể lỗi', `${r.status} ${prod.variants.length}`);

  const v2 = prod.variants.find((v) => v.id !== vid).id;
  r = await adm('POST', P(`/${pid}/variants/${v2}/delete`), { cookie: A.cookie, origin: OADM });
  prod = (await sget(A.shopId, A.cookie, `/products/${pid}`)).json;
  r.status === 303 && prod.variants.length === 1 ? ok('xoá biến thể → còn 1') : bad('xoá biến thể lỗi', `${r.status} ${prod.variants.length}`);

  r = await adm('POST', P(`/${pid}/variants/${vid}/delete`), { cookie: A.cookie, origin: OADM });
  prod = (await sget(A.shopId, A.cookie, `/products/${pid}`)).json;
  r.status >= 400 && prod.variants.length === 1 ? ok('xoá biến thể cuối → chặn (còn 1)') : bad('xoá được biến thể cuối', `${r.status} ${prod.variants.length}`);

  // ── 6. Lưu trữ + xoá ───────────────────────────────────────────────────────
  sect('6. Lưu trữ & xoá');
  r = await adm('POST', P(`/${pid}/archive`), { cookie: A.cookie, origin: OADM });
  st = (await sget(A.shopId, A.cookie, `/products/${pid}`)).json.status;
  r.status === 303 && st === 'archived' ? ok('lưu trữ → archived') : bad('archive lỗi', `${r.status} ${st}`);

  r = await adm('POST', P(`/${pid}/delete`), { cookie: A.cookie, origin: OADM });
  const gone = (await sget(A.shopId, A.cookie, `/products/${pid}`)).status;
  r.status === 303 && r.location === P('') && gone === 404 ? ok('xoá sản phẩm → 303 danh sách + seller 404') : bad('xoá sản phẩm lỗi', `${r.status} ${r.location} ${gone}`);

  // ── 7. Cô lập chéo shop + CSRF ─────────────────────────────────────────────
  sect('7. Cô lập & CSRF');
  r = await adm('GET', `/shops/${Bo.shopId}/products`, { cookie: A.cookie });
  r.status === 403 ? ok('owner A xem sản phẩm shop B → 403') : bad('rò sản phẩm chéo shop', String(r.status));

  r = await adm('POST', P(''), { cookie: A.cookie, form: { title: 'x', slug: `x-${uniq()}`, price_vnd: '1000', sku: `X-${uniq()}`, variant_price_vnd: '1000' } }); // KHÔNG Origin
  r.status === 403 ? ok('tạo sản phẩm không Origin → 403 (CSRF)') : bad('tạo thiếu Origin không bị chặn', String(r.status));

  // ── 8. Phân loại đa trục + thông số qua admin (form-encoded, key lặp) ───────
  sect('8. Phân loại đa trục + thông số (admin)');
  const axSlug = `ao-${uniq()}`;
  r = await adm('POST', P(''), { cookie: A.cookie, origin: OADM, form: { title: 'Áo thun', slug: axSlug, price_vnd: '150000', status: 'active', sku: `AO-${uniq()}`, variant_price_vnd: '150000' } });
  const axPid = pidFrom(r.location);
  // Form key LẶP: opt_name/opt_values xen kẽ (URLSearchParams giữ thứ tự) — trục 3 để trống.
  r = await adm('POST', P(`/${axPid}/options`), { cookie: A.cookie, origin: OADM, form: [
    ['opt_name', 'Màu'], ['opt_values', 'Đỏ, Xanh'],
    ['opt_name', 'Size'], ['opt_values', 'M, L'],
    ['opt_name', ''], ['opt_values', ''],
  ] });
  const afterOpt = (await sget(A.shopId, A.cookie, `/products/${axPid}`)).json;
  r.status === 303 && (afterOpt.variants?.length === 4) && (afterOpt.options?.length === 2)
    ? ok('POST /options (2 trục) → sinh 4 biến thể + 2 trục') : bad('options admin lỗi', `${r.status} v=${afterOpt.variants?.length} o=${afterOpt.options?.length}`);
  r = await adm('GET', P(`/${axPid}`), { cookie: A.cookie });
  r.body.includes('value="Màu"') && r.body.includes('value="Size"') && r.body.includes('Đỏ / M')
    ? ok('chi tiết: ô trục prefill (Màu/Size) + biến thể tổ hợp (Đỏ / M)') : bad('detail options render sai');

  // Sửa GIÁ một tổ hợp qua ô inline (ma trận sinh ra lấy giá SP — chỉnh từng tổ hợp ở đây).
  const vAx = afterOpt.variants[0];
  r = await adm('POST', P(`/${axPid}/variants/${vAx.id}/price`), { cookie: A.cookie, origin: OADM, form: { price_vnd: '175000' } });
  const vAxAfter = (await sget(A.shopId, A.cookie, `/products/${axPid}`)).json.variants.find((v) => v.id === vAx.id);
  r.status === 303 && Number(vAxAfter.price_vnd) === 175000
    ? ok('ô sửa giá biến thể → 303 + DB đổi 175.000') : bad('sửa giá biến thể lỗi', `${r.status} ${vAxAfter?.price_vnd}`);

  // ── 8b. Lưu HÀNG LOẠT biến thể (0093): MỘT form, MỘT nút → PATCH mọi biến thể cùng lúc ──
  sect('8b. Lưu hàng loạt biến thể');
  const vlist = (await sget(A.shopId, A.cookie, `/products/${axPid}`)).json.variants;
  const want = vlist.map((v, i) => ({ id: v.id, price: 100000 + i * 11000, compare: 200000 + i * 1000, cost: 50000 + i * 1000, weight: 500 + i * 10 }));
  const bulkForm = {};
  for (const w of want) { bulkForm[`price_${w.id}`] = String(w.price); bulkForm[`compare_${w.id}`] = String(w.compare); bulkForm[`cost_${w.id}`] = String(w.cost); bulkForm[`weight_${w.id}`] = String(w.weight); }
  r = await adm('POST', P(`/${axPid}/variants/bulk`), { cookie: A.cookie, origin: OADM, form: bulkForm });
  const okRedir = r.status === 303 && (r.location ?? '').includes('?saved=4');
  const afterBulk = (await sget(A.shopId, A.cookie, `/products/${axPid}`)).json.variants;
  const allMatch = want.every((w) => { const v = afterBulk.find((x) => x.id === w.id); return v && Number(v.price_vnd) === w.price && Number(v.compare_at_vnd) === w.compare && Number(v.cost_vnd) === w.cost && Number(v.weight_gram) === w.weight; });
  okRedir && allMatch ? ok('lưu hàng loạt 4 biến thể → 303 ?saved=4 + DB đổi hết (giá/gạch/vốn/cân)') : bad('bulk save lỗi', `${r.status} loc=${r.location} match=${allMatch}`);

  // Trang render 1 form gộp id="bulkvars" + nút "Lưu tất cả biến thể", KHÔNG có <script> (CSP no-JS).
  r = await adm('GET', P(`/${axPid}`), { cookie: A.cookie });
  r.body.includes(`/products/${axPid}/variants/bulk"`) && r.body.includes('Lưu tất cả biến thể') && r.body.includes('id="bulkvars"') && !r.body.includes('<script')
    ? ok('chi tiết: 1 form gộp "Lưu tất cả biến thể", không <script>') : bad('bulk form markup sai', `bulk=${r.body.includes('/variants/bulk')} btn=${r.body.includes('Lưu tất cả')} script=${r.body.includes('<script')}`);

  // Lỗi từng dòng KHÔNG bị nuốt: 1 biến thể cân rác (→ seller 400), trang báo lỗi (không 303), dòng khác vẫn lưu.
  const badForm = {};
  for (const w of want) badForm[`price_${w.id}`] = String(w.price);
  badForm[`weight_${want[0].id}`] = 'xxx';
  r = await adm('POST', P(`/${axPid}/variants/bulk`), { cookie: A.cookie, origin: OADM, form: badForm });
  r.status !== 303 && /Lỗi|lỗi/.test(r.body) && r.body.includes('Đã lưu')
    ? ok('bulk: 1 dòng lỗi → báo lỗi rõ, không nuốt (không 303)') : bad('bulk error surfacing sai', `${r.status}`);

  // ── 8c. Cập nhật tồn HÀNG LOẠT: MỘT form bulkstock, CHỈ áp dòng ĐÃ điền, mỗi dòng = 1 lần adjust ──
  sect('8c. Cập nhật tồn hàng loạt');
  const vs = (await sget(A.shopId, A.cookie, `/products/${axPid}`)).json.variants;
  const onHand = async (vid) => (await sget(A.shopId, A.cookie, `/variants/${vid}/inventory`)).json?.on_hand ?? 0;
  const before = {}; for (const v of vs) before[v.id] = await onHand(v.id);
  // Điền delta cho 2 biến thể đầu (+7, +3), để TRỐNG 2 biến thể sau + 1 lý do chung.
  const stockForm = { reason: 'nhập lô hàng loạt' };
  stockForm[`delta_${vs[0].id}`] = '7';
  stockForm[`delta_${vs[1].id}`] = '3';
  r = await adm('POST', P(`/${axPid}/inventory/bulk`), { cookie: A.cookie, origin: OADM, form: stockForm });
  const stRedir = r.status === 303 && (r.location ?? '').includes('?stocked=2');
  const after = {}; for (const v of vs) after[v.id] = await onHand(v.id);
  const deltaOk = after[vs[0].id] === before[vs[0].id] + 7 && after[vs[1].id] === before[vs[1].id] + 3
    && after[vs[2].id] === before[vs[2].id] && after[vs[3].id] === before[vs[3].id];
  stRedir && deltaOk ? ok('bulk tồn: điền 2 dòng → 303 ?stocked=2, CHỈ 2 dòng đổi (+7/+3), 2 dòng trống giữ nguyên')
    : bad('bulk stock lỗi', `${r.status} loc=${r.location} d0=${after[vs[0].id] - before[vs[0].id]} d1=${after[vs[1].id] - before[vs[1].id]} d2=${after[vs[2].id] - before[vs[2].id]} d3=${after[vs[3].id] - before[vs[3].id]}`);

  // Trang render form id="bulkstock" + ô delta_<id> thuộc form đó + nút "Cập nhật tồn", KHÔNG <script>.
  r = await adm('GET', P(`/${axPid}`), { cookie: A.cookie });
  r.body.includes('id="bulkstock"') && r.body.includes(`/products/${axPid}/inventory/bulk"`) && r.body.includes(`name="delta_${vs[0].id}"`) && r.body.includes('Cập nhật tồn') && !r.body.includes('<script')
    ? ok('chi tiết: form gộp "Cập nhật tồn" (bulkstock), ô delta_<id>, không <script>')
    : bad('bulk stock markup sai', `form=${r.body.includes('id="bulkstock"')} act=${r.body.includes('/inventory/bulk')} cell=${r.body.includes(`name="delta_${vs[0].id}"`)} btn=${r.body.includes('Cập nhật tồn')}`);

  // Hết nút trùng: nút "Lưu tất cả biến thể" (đóng </button>) xuất hiện ĐÚNG 1 lần (bỏ nút đầu bảng).
  const nBtn = (r.body.match(/>Lưu tất cả biến thể<\/button>/g) ?? []).length;
  nBtn === 1 ? ok('chỉ 1 nút "Lưu tất cả biến thể" (hết trùng)') : bad('nút lưu biến thể bị trùng', `đếm=${nBtn}`);

  // Lỗi từng dòng KHÔNG bị nuốt: 1 delta âm vượt tồn → seller 400, trang báo lỗi (không 303).
  const badStock = { reason: 'thử vượt' };
  badStock[`delta_${vs[0].id}`] = '-99999';
  r = await adm('POST', P(`/${axPid}/inventory/bulk`), { cookie: A.cookie, origin: OADM, form: badStock });
  r.status !== 303 && /Lỗi|lỗi|tồn/.test(r.body) && r.body.includes('Đã chỉnh tồn')
    ? ok('bulk tồn: 1 dòng vượt tồn → báo lỗi rõ, không nuốt (không 303)') : bad('bulk stock error surfacing sai', `${r.status}`);

  r = await adm('POST', P(`/${axPid}/specs`), { cookie: A.cookie, origin: OADM, form: { specs: 'Chất liệu: Cotton\nXuất xứ: Việt Nam\n(dòng rác không có dấu hai chấm)' } });
  const afterSpecs = (await sget(A.shopId, A.cookie, `/products/${axPid}`)).json;
  r.status === 303 && afterSpecs.specs?.length === 2 && afterSpecs.specs[0].name === 'Chất liệu'
    ? ok('POST /specs textarea → 2 thông số (bỏ dòng rác)') : bad('specs admin lỗi', `${r.status} n=${afterSpecs.specs?.length}`);
  r = await adm('GET', P(`/${axPid}`), { cookie: A.cookie });
  r.body.includes('Chất liệu: Cotton') ? ok('chi tiết: textarea thông số prefill') : bad('specs prefill sai');

  // Xoá hết trục (mọi ô tên trống) → options rỗng (sản phẩm về không phân loại).
  r = await adm('POST', P(`/${axPid}/options`), { cookie: A.cookie, origin: OADM, form: [['opt_name', ''], ['opt_values', ''], ['opt_name', ''], ['opt_values', ''], ['opt_name', ''], ['opt_values', '']] });
  const cleared = (await sget(A.shopId, A.cookie, `/products/${axPid}`)).json;
  r.status === 303 && cleared.options?.length === 0 ? ok('xoá hết trục → options rỗng') : bad('clear options lỗi', `o=${cleared.options?.length}`);

  // ── ADR-011: JS hẹp ký nonce + ĐƯỜNG LUI KHÔNG-JS phải còn nguyên ─────────
  // Bất biến ĐẮT NHẤT của quyết định này. Nonce ở header lệch nonce trên thẻ <script>
  // ⇒ trình duyệt chặn script, nhưng trang vẫn trả về đủ HTML nên mọi assertion so
  // chuỗi đều xanh — người bán chỉ thấy tính năng im lặng không chạy. Phải so TRỰC TIẾP.
  r = await adm('GET', `/shops/${A.shopId}/products`, { cookie: A.cookie });
  const mHdr = /script-src 'nonce-([^']+)'/.exec(r.csp ?? '');
  const mTag = /<script nonce="([^"]+)"/.exec(r.body);
  mHdr && mTag && mHdr[1] === mTag[1]
    ? ok('nonce header CSP === nonce thẻ <script> (sinh một lần, không thể lệch)')
    : bad('nonce lệch/thiếu', `csp=${mHdr?.[1] ?? 'không có'} tag=${mTag?.[1] ?? 'không có'}`);
  !/(unsafe-inline|unsafe-eval|strict-dynamic)/.test((r.csp ?? '').split('script-src')[1] ?? '')
    ? ok('script-src không có unsafe-inline/eval/strict-dynamic (ADR-011 #2)')
    : bad('script-src chứa giá trị bị cấm', r.csp);
  (r.body.match(/<script/g) ?? []).length === 1
    ? ok('đúng MỘT khối <script> nội tuyến (ADR-011 #3)')
    : bad('số khối script sai', String((r.body.match(/<script/g) ?? []).length));

  // Đường lui không-JS: form + checkbox từng dòng vẫn nguyên; ô "chọn tất cả" và chỗ đếm
  // phải ẩn — không JS thì đừng bày ra điều khiển bấm vào chẳng làm gì.
  r.body.includes('id="pbulk"') && /name="product_ids"/.test(r.body)
    ? ok('không-JS: form hàng loạt + checkbox từng dòng còn nguyên')
    : bad('mất form hàng loạt');
  /data-bulk-all="product_ids"[^>]*hidden/.test(r.body)
    ? ok('ô "chọn tất cả" render sẵn nhưng ẨN (JS mới bật lên)')
    : bad('ô chọn-tất-cả không ẩn khi chưa có JS');
  /data-bulk-count="product_ids"[^>]*hidden/.test(r.body)
    ? ok('chỗ đếm số đang chọn cũng ẩn khi chưa có JS')
    : bad('chỗ đếm không ẩn');

  // ── docs/44 §8: bảng nào gắn data-cards thì trang đó PHẢI xin JS ───────────
  // Thuộc tính data-cards tự nó không làm gì: JS mới là thứ đọc <th> gán nhãn rồi thêm lớp
  // .cards. Nếu route quên đổi sang sendHtmlJs thì thuộc tính nằm đó im lặng — bảng vẫn
  // cuộn ngang trên điện thoại, và không có gì báo. Đây là kiểu hỏng KHÔNG bộ test nào
  // khác bắt được, vì HTML vẫn đủ và trang vẫn 200.
  // Liệt kê tường minh chứ không quét động: đúng ý đồ "trang phải CHỦ ĐỘNG xin JS" — thêm
  // bảng mới mà quên thêm vào đây thì đó là việc của lô sau, còn tụt mất một trang đang có
  // thì test đỏ ngay.
  const CARD_PAGES = ['/customers', '/audit-log', '/purchasing', '/suppliers', '/stocktakes',
    '/inventory-ledger', '/promotions', '/coupons', '/pages', '/members', '/cod', '/products/import'];
  const nonceBad = [], notOk = [], chuaBat = [];
  let coBang = 0;
  for (const path of CARD_PAGES) {
    const pr = await adm('GET', `/shops/${A.shopId}${path}`, { cookie: A.cookie });
    if (pr.status !== 200) { notOk.push(`${path}→${pr.status}`); continue; }
    const h = /script-src 'nonce-([^']+)'/.exec(pr.csp ?? '')?.[1];
    const t = /<script nonce="([^"]+)"/.exec(pr.body)?.[1];
    if (!h || !t || h !== t) nonceBad.push(path);
    // Có JS thôi CHƯA ĐỦ. Bản đầu của khẳng định này chỉ kiểm nonce, và nó XANH trong khi
    // bảng Sổ cái kho chưa hề được gắn data-cards — bật sót một bảng không hề báo gì.
    // Trang nào ĐANG render <table> thì bảng đó phải bật thẻ; trang trạng-thái-rỗng không
    // có <table> nên tự bỏ qua (đếm coBang để không âm thầm kiểm được 0 trang).
    // Cắt <style> trước khi quét: biểu định kiểu nội tuyến có chú thích nói VỀ bảng, và
    // một khẳng định về markup của trang thì không được đọc nhầm sang biểu định kiểu.
    const markup = pr.body.replace(/<style[\s\S]*?<\/style>/g, '');
    if (/<table[\s>]/.test(markup)) {
      coBang++;
      if (!/<table[^>]*\sdata-cards/.test(markup)) chuaBat.push(path);
    }
  }
  nonceBad.length === 0 && notOk.length === 0 && chuaBat.length === 0 && coBang >= 3
    ? ok(`${CARD_PAGES.length} trang có JS ký nonce KHỚP header; ${coBang} trang có bảng đều đã bật data-cards`)
    : bad('trang bật thẻ-mobile hỏng', `nonce: ${nonceBad.join(' ') || '—'} | không 200: ${notOk.join(' ') || '—'} | bảng chưa bật: ${chuaBat.join(' ') || '—'} | số trang có bảng: ${coBang}`);

  // ── docs/44 §7: ô số liệu LÀ LINK tới danh sách ĐÃ LỌC SẴN ────────────────
  // Khẳng định phải chứng minh bộ lọc THẬT SỰ LỌC. Một API nhận tham số rồi lặng lẽ bỏ qua
  // vẫn trả 200 kèm đủ dữ liệu — mọi test kiểu "gọi được, không lỗi" đều xanh, trong khi
  // người bán bấm vào con số vẫn nhận nguyên danh sách. Nên phải so SỐ LƯỢNG hai chiều.
  const allP = await adm('GET', `/shops/${A.shopId}/products`, { cookie: A.cookie });
  const lowP = await adm('GET', `/shops/${A.shopId}/products?stock=low`, { cookie: A.cookie });
  const nRows = (b) => (b.match(/<tr>/g) ?? []).length;
  lowP.status === 200 && nRows(lowP.body) <= nRows(allP.body)
    ? ok(`stock=low lọc thật (${nRows(lowP.body)} ≤ ${nRows(allP.body)} dòng)`)
    : bad('stock=low không lọc', `low=${nRows(lowP.body)} all=${nRows(allP.body)}`);
  /Đang lọc:.*Sắp hết hàng/s.test(lowP.body) && /Xoá bộ lọc/.test(lowP.body)
    ? ok('trang Sản phẩm báo rõ "Đang lọc: Sắp hết hàng" + có lối xoá lọc')
    : bad('không hiện chip đang-lọc/xoá-lọc');
  !/Đang lọc:/.test(allP.body)
    ? ok('không lọc thì KHÔNG hiện chip đang-lọc')
    : bad('hiện chip đang-lọc khi không lọc');

  // Tham số rác KHÔNG được lọt xuống API (allowlist một giá trị).
  const junk = await adm('GET', `/shops/${A.shopId}/products?stock=' OR 1=1--`, { cookie: A.cookie });
  junk.status === 200 && nRows(junk.body) === nRows(allP.body) && !/Đang lọc:/.test(junk.body)
    ? ok('stock rác bị bỏ qua → trả danh sách đầy đủ, không lọc bừa')
    : bad('stock rác không bị chặn', String(junk.status));

  // Đơn hàng: payment=unpaid
  const allO = await adm('GET', `/shops/${A.shopId}/orders`, { cookie: A.cookie });
  const unpaidO = await adm('GET', `/shops/${A.shopId}/orders?payment=unpaid`, { cookie: A.cookie });
  unpaidO.status === 200 && nRows(unpaidO.body) <= nRows(allO.body)
    ? ok(`payment=unpaid lọc thật (${nRows(unpaidO.body)} ≤ ${nRows(allO.body)} dòng)`)
    : bad('payment=unpaid không lọc', `unpaid=${nRows(unpaidO.body)} all=${nRows(allO.body)}`);
  /Đang lọc:.*Chưa thu tiền/s.test(unpaidO.body)
    ? ok('trang Đơn hàng báo rõ "Đang lọc: Chưa thu tiền"')
    : bad('không hiện chip đang-lọc ở đơn hàng');

  // Ô số liệu ở Tổng quan phải trỏ ĐÚNG hai đường vừa làm — không còn trỏ danh sách trần.
  const ov = await adm('GET', `/shops/${A.shopId}/overview`, { cookie: A.cookie });
  ov.body.includes('/orders?payment=unpaid') && ov.body.includes('/products?stock=low')
    ? ok('ô "Chưa thu tiền" và "Sắp hết hàng" trỏ tới danh sách ĐÃ LỌC')
    : bad('ô số liệu vẫn trỏ danh sách chưa lọc');

  // Trang KHÔNG xin JS giữ CSP khoá cứng (mặc định an toàn — ADR-011 #4).
  // Dùng /account: trang chỉ đọc, không bảng, không hàng loạt — sẽ không bao giờ cần JS.
  // (Trước đây dùng /orders, nhưng Đợt 2 đã bật JS cho trang đó → chứng cứ mất giá trị.)
  const rNoJs = await adm('GET', '/account', { cookie: A.cookie });
  !/script-src/.test(rNoJs.csp ?? '')
    ? ok('trang không xin JS (/account): CSP KHÔNG có script-src (mặc định an toàn)')
    : bad('trang không dùng JS lại mở script-src', rNoJs.csp);

  // ── docs/45: trang NHẬP DANH MỤC — xem trước phải THẬT SỰ không ghi gì ────
  sect('10. Nhập danh mục CSV (docs/45)');
  // Multipart dựng tay: helper adm() chỉ biết form urlencoded.
  const multipart = async (path, { cookie, mode, csv }) => {
    const bd = '----nt' + uniq();
    const body = Buffer.concat([
      Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="mode"\r\n\r\n${mode}\r\n`),
      Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\nContent-Type: text/csv\r\n\r\n`),
      Buffer.from(csv, 'utf8'), Buffer.from(`\r\n--${bd}--\r\n`),
    ]);
    const res = await fetch(ADMIN + path, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': `multipart/form-data; boundary=${bd}`, origin: OADM, cookie: `__Host-session=${cookie}` },
      body,
    });
    return { status: res.status, body: await res.text() };
  };
  const countProducts = async () => (await sget(A.shopId, A.cookie, '/products?limit=200')).json.total;

  r = await adm('GET', P('/import'), { cookie: A.cookie });
  r.status === 200 && /name="mode" value="preview"/.test(r.body) && /name="mode" value="commit"/.test(r.body)
    ? ok('trang nhập có CẢ hai nút: Xem trước và Nhập thật')
    : bad('thiếu nút xem trước/nhập thật', String(r.status));

  // BOM UTF-8 bắt buộc: thiếu nó thì Excel trên Windows hiện tiếng Việt thành ký tự rác —
  // người bán mở tệp mẫu thấy chữ hỏng sẽ kết luận sản phẩm của họ cũng sẽ hỏng.
  // Phải đọc BYTE THÔ: res.text() của fetch tự NUỐT BOM theo chuẩn WHATWG, nên kiểm bằng
  // chuỗi đã giải mã sẽ luôn báo "không có BOM" dù máy chủ gửi đúng.
  const sres = await fetch(ADMIN + P('/import/mau.csv'), { headers: { cookie: `__Host-session=${A.cookie}` } });
  const sbuf = Buffer.from(await sres.arrayBuffer());
  const stxt = sbuf.toString('utf8');
  sres.status === 200 && sbuf[0] === 0xef && sbuf[1] === 0xbb && sbuf[2] === 0xbf
    && /handle,title/.test(stxt) && (stxt.match(/ao-thun-basic/g) ?? []).length === 3
    ? ok('tệp mẫu: có BOM UTF-8 (Excel đọc đúng tiếng Việt) + DẠY cách gộp (3 dòng cùng handle)')
    : bad('tệp mẫu sai', `${sres.status} bom=${sbuf.slice(0, 3).toString('hex')}`);

  const impCsv = [
    'handle,title,option1_name,option1_value,sku,price_vnd,cot_la_khong_biet',
    `ao-x,Áo nhập thử,Màu,Đỏ,IMP-${uniq()},150000,rác`,
    `ao-x,,Màu,Xanh,IMP-${uniq()},160000,rác`,
  ].join('\n');

  const nBefore = await countProducts();
  let ir = await multipart(P('/import'), { cookie: A.cookie, mode: 'preview', csv: impCsv });
  const afterPreview = await countProducts();
  ir.status === 200 && /chưa ghi gì vào cửa hàng/.test(ir.body) && afterPreview === nBefore
    ? ok('XEM TRƯỚC: báo rõ "chưa ghi gì" và số sản phẩm KHÔNG đổi')
    : bad('xem trước có ghi dữ liệu', `${ir.status} ${nBefore}→${afterPreview}`);
  /1 sản phẩm/.test(ir.body) && /Áo nhập thử/.test(ir.body)
    ? ok('xem trước hiện đúng kết quả gộp: 2 dòng → 1 sản phẩm 2 biến thể')
    : bad('xem trước không hiện kết quả gộp');
  // Cột lạ phải HIỆN RA. Bỏ qua im lặng là cách người bán mất nguyên một cột mà không biết.
  /cot_la_khong_biet/.test(ir.body) && /KHÔNG được nhập/.test(ir.body)
    ? ok('cột không nhận ra được liệt kê kèm cảnh báo dữ liệu không vào')
    : bad('cột lạ bị bỏ qua im lặng');

  ir = await multipart(P('/import'), { cookie: A.cookie, mode: 'commit', csv: impCsv });
  const afterCommit = await countProducts();
  ir.status === 200 && /Đã nhập xong/.test(ir.body) && afterCommit === nBefore + 1
    ? ok(`NHẬP THẬT: sản phẩm vào cửa hàng (${nBefore} → ${afterCommit})`)
    : bad('nhập thật không ghi', `${ir.status} ${nBefore}→${afterCommit}`);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((err) => { console.error('admin products e2e lỗi:', err); process.exit(2); });
