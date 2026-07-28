/**
 * End-to-end NHẬP DANH MỤC (di cư từ sàn khác — docs/45). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/import.e2e.mjs
 *
 * Bộ nhập cũ KHÔNG có test nào — mọi khẳng định ở đây là nợ cũ được trả, không chỉ là
 * kiểm phần mới. Kiểm: gộp nhiều dòng thành 1 SP nhiều biến thể · bí danh cột kiểu Shopify ·
 * danh mục 2 cấp · TƯƠNG THÍCH NGƯỢC file 1-dòng-1-SP · nhóm lỗi bỏ cả nhóm · các trần.
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
const S = (shopId, cookie) => ({
  get: (p) => rq(SELLER, 'GET', `/shops/${shopId}${p}`, { cookie }),
  post: (p, body) => rq(SELLER, 'POST', `/shops/${shopId}${p}`, { body, cookie, origin: OS }),
});

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `imp-a-${uniq()}`);
  const a = S(A.shopId, A.cookie);
  const imp = (rows) => a.post('/products/import', { rows });
  ok('dựng shop + chủ shop');

  // ── 1. Gộp: 6 dòng, 2 trục → 1 SP, 6 biến thể ───────────────────────────
  sect('1. Gộp nhiều dòng cùng handle thành MỘT sản phẩm nhiều biến thể');
  const h1 = `ao-thun-${uniq()}`;
  const rows1 = [];
  for (const color of ['Đỏ', 'Xanh']) {
    for (const size of ['S', 'M', 'L']) {
      rows1.push({
        handle: h1, title: 'Áo thun cotton', description: 'Cotton 100%', status: 'active',
        category: 'Thời trang > Áo', option1_name: 'Màu', option1_value: color,
        option2_name: 'Size', option2_value: size,
        sku: `${h1}-${color}-${size}`, price_vnd: color === 'Đỏ' ? '199000' : '219000',
        stock: '5', weight_gram: '250',
      });
    }
  }
  let r = await imp(rows1);
  r.status === 200 && r.json.created === 1 && r.json.variants === 6 && r.json.failed === 0
    ? ok(`6 dòng → ${r.json.created} sản phẩm / ${r.json.variants} biến thể`)
    : bad('gộp sai', JSON.stringify(r.json));

  const list = await a.get('/products?limit=50');
  const p1 = list.json.products.find((p) => p.slug === h1);
  const d1 = p1 ? (await a.get(`/products/${p1.id}`)).json : null;
  d1 && d1.variants.length === 6 && d1.options?.length === 2
    ? ok(`sản phẩm có 2 trục (${d1.options.map((o) => o.name).join(', ')}) + 6 biến thể`)
    : bad('cấu trúc biến thể sai', JSON.stringify({ v: d1?.variants?.length, o: d1?.options?.length }));
  // Giá CẤP SP = nhỏ nhất trong nhóm (storefront hiện "từ ...₫").
  Number(d1?.price_vnd) === 199000 ? ok('giá cấp sản phẩm = giá nhỏ nhất trong nhóm (199.000)') : bad('giá cấp SP sai', String(d1?.price_vnd));
  // Thứ tự giá trị trục GIỮ NGUYÊN theo file (S, M, L) — không sắp lại theo bảng chữ cái.
  const sizeOpt = d1?.options?.find((o) => o.name === 'Size');
  JSON.stringify(sizeOpt?.values?.map((v) => v.value ?? v)) === JSON.stringify(['S', 'M', 'L'])
    ? ok('thứ tự giá trị trục giữ đúng theo file (S, M, L — không sắp lại)')
    : bad('thứ tự giá trị trục bị đổi', JSON.stringify(sizeOpt?.values));

  // ── 2. SINH THƯA, không sinh ma trận ────────────────────────────────────
  sect('2. Sinh THƯA: chỉ tổ hợp có trong file, không sinh ma trận');
  const h2 = `giay-${uniq()}`;
  r = await imp([
    { handle: h2, title: 'Giày sneaker', option1_name: 'Màu', option1_value: 'Đen', option2_name: 'Size', option2_value: '39', sku: `${h2}-den-39`, price_vnd: '500000' },
    { handle: h2, option1_name: 'Màu', option1_value: 'Trắng', option2_name: 'Size', option2_value: '42', sku: `${h2}-trang-42`, price_vnd: '520000' },
  ]);
  const p2 = (await a.get('/products?limit=50')).json.products.find((p) => p.slug === h2);
  const d2 = p2 ? (await a.get(`/products/${p2.id}`)).json : null;
  // Ma trận 2 màu × 2 size = 4; file chỉ có 2 tổ hợp ⇒ phải đúng 2 biến thể.
  r.json?.variants === 2 && d2?.variants?.length === 2
    ? ok('2 tổ hợp trong file → đúng 2 biến thể (KHÔNG sinh ma trận 4)')
    : bad('sinh thừa biến thể', `api=${r.json?.variants} db=${d2?.variants?.length}`);

  // ── 3. Bí danh cột kiểu Shopify ─────────────────────────────────────────
  sect('3. Bí danh cột: file xuất kiểu Shopify/Haravan');
  const h3 = `non-${uniq()}`;
  r = await imp([
    { 'Handle': h3, 'Title': 'Nón lưỡi trai', 'Body (HTML)': '<p>Vải kaki</p>', 'Option1 Name': 'Màu', 'Option1 Value': 'Be',
      'Variant SKU': `${h3}-be`, 'Variant Price': '150000', 'Variant Inventory Qty': '3', 'Variant Grams': '120',
      'Variant Compare At Price': '200000', 'Type': 'Phụ kiện' },
  ]);
  const p3 = (await a.get('/products?limit=50')).json.products.find((p) => p.slug === h3);
  const d3 = p3 ? (await a.get(`/products/${p3.id}`)).json : null;
  r.json?.created === 1 && d3?.title === 'Nón lưỡi trai' && Number(d3?.variants?.[0]?.price_vnd) === 150000
    && Number(d3?.variants?.[0]?.compare_at_vnd) === 200000 && Number(d3?.variants?.[0]?.weight_gram) === 120
    ? ok('nhận đúng Handle/Title/Variant SKU/Variant Price/Compare At/Grams')
    : bad('bí danh cột không khớp', JSON.stringify(d3?.variants?.[0]));

  // ── 4. Danh mục 2 cấp ───────────────────────────────────────────────────
  sect('4. Danh mục: tạo cây 2 cấp, cấp 3 bị từ chối');
  const cats = (await a.get('/categories')).json;
  const arr = Array.isArray(cats) ? cats : (cats.categories ?? []);
  const cha = arr.find((c) => c.name === 'Thời trang');
  const con = arr.find((c) => c.name === 'Áo');
  cha && con && String(con.parent_id) === String(cha.id)
    ? ok('"Thời trang > Áo" tạo đúng quan hệ cha-con')
    : bad('cây danh mục sai', JSON.stringify({ cha: cha?.id, con: con?.parent_id }));
  r = await imp([{ handle: `x-${uniq()}`, title: 'SP cấp 3', category: 'A > B > C', sku: `s-${uniq()}`, price_vnd: '1000' }]);
  r.json?.created === 0 && /cấp/.test(r.json?.errors?.[0]?.error ?? '')
    ? ok('danh mục 3 cấp → từ chối kèm lý do') : bad('cấp 3 không bị chặn', JSON.stringify(r.json));

  // ── 5. TƯƠNG THÍCH NGƯỢC: file cũ 1-dòng-1-SP ───────────────────────────
  sect('5. Tương thích ngược: file KHÔNG có cột handle');
  const s1 = `cu-${uniq()}`, s2 = `cu-${uniq()}`;
  r = await imp([
    { title: 'Sản phẩm cũ A', sku: s1, price_vnd: '10000', stock: '2' },
    { title: 'Sản phẩm cũ B', sku: s2, price_vnd: '20000' },
  ]);
  r.json?.created === 2 && r.json?.variants === 2
    ? ok('file không cột handle → mỗi dòng một sản phẩm (như trước)')
    : bad('tương thích ngược hỏng', JSON.stringify(r.json));
  // Trùng TÊN mà không có handle thì vẫn phải là HAI sản phẩm — không được gộp theo title.
  r = await imp([
    { title: 'Trùng tên', sku: `t1-${uniq()}`, price_vnd: '1000' },
    { title: 'Trùng tên', sku: `t2-${uniq()}`, price_vnd: '2000' },
  ]);
  r.json?.created === 2
    ? ok('hai dòng TRÙNG TÊN → vẫn hai sản phẩm (không gộp theo title)')
    : bad('gộp nhầm theo title', JSON.stringify(r.json));

  // ── 6. Nhóm lỗi bỏ CẢ NHÓM, nhóm khác vẫn vào ───────────────────────────
  sect('6. Nhóm lỗi → bỏ cả nhóm; nhóm lành vẫn nhập');
  const hBad = `loi-${uniq()}`, hGood = `lanh-${uniq()}`;
  r = await imp([
    { handle: hBad, title: 'Hàng lỗi', option1_name: 'Màu', option1_value: 'Đỏ', sku: `${hBad}-1`, price_vnd: '1000' },
    { handle: hBad, option1_name: 'Mầu', option1_value: 'Xanh', sku: `${hBad}-2`, price_vnd: '2000' }, // tên trục LỆCH
    { handle: hGood, title: 'Hàng lành', option1_name: 'Màu', option1_value: 'Đỏ', sku: `${hGood}-1`, price_vnd: '3000' },
  ]);
  const gone = (await a.get('/products?limit=50')).json.products.some((p) => p.slug === hBad);
  const kept = (await a.get('/products?limit=50')).json.products.some((p) => p.slug === hGood);
  r.json?.created === 1 && r.json?.failed === 1 && !gone && kept && /lệch/.test(r.json?.errors?.[0]?.error ?? '')
    ? ok('trục lệch → CẢ nhóm bị bỏ, nhóm lành vẫn vào')
    : bad('xử lý nhóm lỗi sai', JSON.stringify({ j: r.json, gone, kept }));

  // Thiếu giá trị trục ở một dòng cũng phải bỏ cả nhóm.
  const hMiss = `thieu-${uniq()}`;
  r = await imp([
    { handle: hMiss, title: 'Thiếu trục', option1_name: 'Màu', option1_value: 'Đỏ', sku: `${hMiss}-1`, price_vnd: '1000' },
    { handle: hMiss, sku: `${hMiss}-2`, price_vnd: '2000' },
  ]);
  r.json?.created === 0 && /thiếu giá trị trục/.test(r.json?.errors?.[0]?.error ?? '')
    ? ok('dòng thiếu giá trị trục → bỏ cả nhóm kèm số dòng')
    : bad('thiếu trục không bị bắt', JSON.stringify(r.json));

  // Tổ hợp lặp trong cùng nhóm (hai dòng cùng Đỏ/S) — nếu lọt sẽ thành 2 biến thể trùng.
  const hDup = `lap-${uniq()}`;
  r = await imp([
    { handle: hDup, title: 'Tổ hợp lặp', option1_name: 'Màu', option1_value: 'Đỏ', sku: `${hDup}-1`, price_vnd: '1000' },
    { handle: hDup, option1_name: 'Màu', option1_value: 'Đỏ', sku: `${hDup}-2`, price_vnd: '2000' },
  ]);
  r.json?.created === 0 && /lặp/.test(r.json?.errors?.[0]?.error ?? '')
    ? ok('tổ hợp trục lặp → bỏ cả nhóm') : bad('tổ hợp lặp lọt qua', JSON.stringify(r.json));

  // ── 7. Đường tiền: giá gạch phải > giá bán ───────────────────────────────
  sect('7. Chặn dữ liệu làm sai giá');
  r = await imp([{ title: 'Giá gạch sai', sku: `gs-${uniq()}`, price_vnd: '100000', compare_at_price_vnd: '90000' }]);
  r.json?.created === 0 && /gạch ngang/.test(r.json?.errors?.[0]?.error ?? '')
    ? ok('giá gạch ≤ giá bán → từ chối (badge giảm giá sẽ ra số âm)')
    : bad('giá gạch sai lọt qua', JSON.stringify(r.json));
  // Cột "weight" trần KHÔNG được nhận: có thể là kg, đoán nhầm = sai phí ship 1000 lần.
  const hW = `can-${uniq()}`;
  r = await imp([{ handle: hW, title: 'Cân mơ hồ', sku: `${hW}-1`, price_vnd: '1000', weight: '1.5' }]);
  const pW = (await a.get('/products?limit=50')).json.products.find((p) => p.slug === hW);
  const dW = pW ? (await a.get(`/products/${pW.id}`)).json : null;
  dW && dW.variants[0].weight_gram == null
    ? ok('cột "weight" mơ hồ đơn vị → BỎ QUA, không đoán thành gram')
    : bad('nhận nhầm cột weight', String(dW?.variants?.[0]?.weight_gram));

  // ── 8. Trần ─────────────────────────────────────────────────────────────
  sect('8. Trần số dòng / số biến thể');
  r = await imp(Array.from({ length: 1001 }, (_, i) => ({ title: `x${i}`, sku: `k${i}`, price_vnd: '1000' })));
  r.status === 413 ? ok('>1000 dòng → 413') : bad('trần dòng không chặn', String(r.status));

  const hMany = `nhieu-${uniq()}`;
  r = await imp(Array.from({ length: 101 }, (_, i) => ({
    handle: hMany, title: 'Quá nhiều biến thể', option1_name: 'Mã', option1_value: `V${i}`,
    sku: `${hMany}-${i}`, price_vnd: '1000',
  })));
  r.json?.created === 0 && /biến thể/.test(r.json?.errors?.[0]?.error ?? '')
    ? ok('>100 biến thể trong một sản phẩm → từ chối cả nhóm')
    : bad('trần biến thể không chặn', JSON.stringify(r.json));

  // ── 9. Cô lập chéo shop ─────────────────────────────────────────────────
  sect('9. Cô lập chéo shop');
  const Bs = await makeShopOwner(staff, `imp-b-${uniq()}`);
  const intruderSku = `x-${uniq()}`;
  r = await rq(SELLER, 'POST', `/shops/${Bs.shopId}/products/import`,
    { body: { rows: [{ title: 'Chen ngang', sku: intruderSku, price_vnd: '1000' }] }, cookie: A.cookie, origin: OS });
  // 404 chứ KHÔNG phải 403 là CỐ Ý (server.js:391): 403 xác nhận "shop này có tồn tại",
  // tức rò thông tin cho người ngoài. Đừng "sửa" thành 403.
  const bList = await S(Bs.shopId, Bs.cookie).get('/products?limit=50');
  const leaked = (bList.json?.products ?? []).some((p) => p.title === 'Chen ngang');
  r.status === 404 && !leaked
    ? ok('chủ shop A nhập vào shop B → 404 (không xác nhận tồn tại) + shop B không có hàng lạ')
    : bad('cô lập chéo shop hỏng', `${r.status} leaked=${leaked}`);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
