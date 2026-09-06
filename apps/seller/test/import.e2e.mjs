/**
 * End-to-end NHẬP DANH MỤC (di cư từ sàn khác — docs/45). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/import.e2e.mjs
 *
 * Bộ nhập cũ KHÔNG có test nào — mọi khẳng định ở đây là nợ cũ được trả, không chỉ là
 * kiểm phần mới. Kiểm: gộp nhiều dòng thành 1 SP nhiều biến thể · bí danh cột kiểu Shopify ·
 * danh mục 2 cấp · TƯƠNG THÍCH NGƯỢC file 1-dòng-1-SP · nhóm lỗi bỏ cả nhóm · các trần.
 */

import pg from 'pg';
import http from 'node:http';
import zlib from 'node:zlib';
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

// ── PNG hợp lệ, SINH BẰNG MÃ (không gõ tay) ────────────────────────────────
// Container test không có `sharp`. Fixture PNG gõ tay từng byte đã một lần hỏng cả 4 bộ test
// (độ dài IDAT khai 11 trong khi thật là 13 — libpng mới từ chối). Nên ở đây độ dài và CRC
// đều được TÍNH, không có số nào chép tay.
const CRC_TBL = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TBL[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function makePng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    raw[off] = 0;                                        // filter none
    for (let x = 0; x < w; x++) {
      raw[off + 1 + x * 3] = 0x33; raw[off + 2 + x * 3] = 0x66; raw[off + 3 + x * 3] = 0xaa;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

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
  const imp = (rows, options = {}) => a.post('/products/import', { rows, ...options });
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

  // ── 3b. Hình dạng tệp Shopify THẬT: dòng CHỈ CÓ ẢNH ─────────────────────
  sect('3b. Tệp Shopify thật: ảnh phụ nằm ở DÒNG RIÊNG chỉ có Handle + Image Src');
  // Đây là hình dạng tệp xuất Shopify/Haravan thật, không phải ca hiếm: ảnh thứ 2, 3... của
  // một sản phẩm nằm ở dòng riêng KHÔNG có SKU/giá. Nếu bộ nhập đòi SKU+giá ở mọi dòng thì
  // một tệp bình thường sẽ báo hàng chục "dòng lỗi" và người bán tưởng tệp của mình hỏng.
  const h3b = `ao-khoac-${uniq()}`;
  r = await imp([
    { 'Handle': h3b, 'Title': 'Áo khoác dù', 'Option1 Name': 'Màu', 'Option1 Value': 'Đen',
      'Variant SKU': `${h3b}-den`, 'Variant Price': '450000', 'Image Src': 'http://dbtest/ok.png' },
    { 'Handle': h3b, 'Option1 Name': 'Màu', 'Option1 Value': 'Xám',
      'Variant SKU': `${h3b}-xam`, 'Variant Price': '450000' },
    { 'Handle': h3b, 'Image Src': 'http://dbtest/ok.png?2' },     // DÒNG CHỈ CÓ ẢNH
    { 'Handle': h3b, 'Image Src': 'http://dbtest/ok.png?3' },     // DÒNG CHỈ CÓ ẢNH
  ]);
  r.json?.created === 1 && r.json?.variants === 2 && r.json?.failed === 0
    ? ok('dòng chỉ-có-ảnh KHÔNG bị tính là lỗi; sản phẩm vẫn 2 biến thể')
    : bad('dòng chỉ-có-ảnh bị coi là lỗi (tệp Shopify thật sẽ đầy lỗi giả)', JSON.stringify(r.json));
  r.json?.images?.queued === 3
    ? ok('cả 3 ảnh (1 ở dòng biến thể + 2 ở dòng riêng) đều vào hàng đợi')
    : bad('mất ảnh ở dòng riêng', JSON.stringify(r.json?.images));

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

  // ── 8b. TikTok XLSX shape sau adapter: source refs + idempotency + tách trục ──
  sect('8b. TikTok: product_id/sku_id, tách trục và nhập lại không nhân đôi');
  const t1 = '1731000000000000001', t2 = '1731000000000000002';
  const tiktokRows = [
    { product_id: t1, product_name: 'Vòng tay TikTok', product_description: '<p>Mô tả&nbsp;đẹp</p>', category: 'Vòng tay (1)', price: '450000', quantity: '49', parcel_weight: '200', variation_value: '48', sku_id: '1731000000000000101' },
    { product_id: t1, product_name: 'Vòng tay TikTok', product_description: '<p>Mô tả&nbsp;đẹp</p>', category: 'Vòng tay (1)', price: '450000', quantity: '48', parcel_weight: '200', variation_value: '50cm (vừa cổ)', sku_id: '1731000000000000102' },
    { product_id: t2, product_name: 'Dây chuyền TikTok', product_description: '<p>Dây chuyền</p>', category: 'Dây chuyền (2)', price: '550000', quantity: '10', parcel_weight: '200', variation_value: '45cm, 45cm', sku_id: '1731000000000000201' },
    { product_id: t2, product_name: 'Dây chuyền TikTok', product_description: '<p>Dây chuyền</p>', category: 'Dây chuyền (2)', price: '560000', quantity: '9', parcel_weight: '200', variation_value: '45cm, 50cm', sku_id: '1731000000000000202' },
  ];
  r = await imp(tiktokRows);
  r.json?.source === 'tiktok' && r.json?.created === 2 && r.json?.variants === 4 && r.json?.failed === 0
    ? ok('TikTok 2 product_id → 2 sản phẩm / 4 biến thể')
    : bad('adapter TikTok nhập sai', JSON.stringify(r.json));
  const refs = (await owner.query(`SELECT kind, count(*)::int AS n FROM product_source_refs WHERE shop_id = $1 GROUP BY kind ORDER BY kind`, [A.shopId])).rows;
  JSON.stringify(refs) === JSON.stringify([{ kind: 'product', n: 2 }, { kind: 'variant', n: 4 }])
    ? ok('ghi đủ 2 ref sản phẩm + 4 ref biến thể (product_id/sku_id)')
    : bad('source refs sai', JSON.stringify(refs));
  r = await imp(tiktokRows);
  r.json?.created === 0 && r.json?.skipped_existing === 2 && r.json?.failed === 0
    ? ok('nhập lại cùng file → bỏ qua 2 sản phẩm, không nhân đôi')
    : bad('idempotency TikTok sai', JSON.stringify(r.json));

  const t3 = '1731000000000000003';
  r = await a.post('/products/import', { rows: [
    { product_id: t3, product_name: 'Phân loại có dấu phẩy', product_description: '<p>X</p>', category: 'Khác (3)', price: '100000', quantity: '1', parcel_weight: '200', variation_value: 'A, B', sku_id: '1731000000000000301' },
  ], axis_names: { [t3]: ['Mã hàng'] }, split_off: [t3] });
  const p3t = (await a.get('/products?limit=100')).json.products.find((p) => p.slug === t3);
  const d3t = p3t ? (await a.get(`/products/${p3t.id}`)).json : null;
  d3t?.options?.length === 1 && d3t.options[0].name === 'Mã hàng' && d3t.options[0].values?.[0]?.value === 'A, B'
    ? ok('tắt tách theo từng sản phẩm giữ nguyên dấu phẩy + tên trục người bán')
    : bad('tách trục TikTok sai', JSON.stringify({ options: d3t?.options }));

  const collisionSku = 'SAN-PHAM-DUNG-SKU-A';
  r = await imp([{ title: 'Mã đã có', sku: collisionSku, price_vnd: '100000' }]);
  const t4 = '1731000000000000004';
  r = await imp([{
    product_id: t4, product_name: 'Sản phẩm đụng SKU', product_description: '<p>X</p>',
    category: 'Khác (3)', price: '100000', quantity: '1', parcel_weight: '200',
    variation_value: 'A', sku_id: '1731000000000000401',
  }]);
  const p4t = (await a.get('/products?limit=100')).json.products.find((p) => p.slug === t4);
  const d4t = p4t ? (await a.get(`/products/${p4t.id}`)).json : null;
  r.json?.created === 1 && d4t?.variants?.[0]?.sku === `${collisionSku}-2`
    ? ok('SKU TikTok sinh tự động đụng mã đã có → tự nối -2, sản phẩm vẫn nhập được')
    : bad('SKU TikTok chưa né mã đã có trong shop', JSON.stringify({ result: r.json, sku: d4t?.variants?.[0]?.sku }));

  // ── 8c. Đợt 4: cập nhật giá/tồn theo ref, giữ biến thể vắng mặt ──
  sect('8c. Đợt 4: upsert giá, tồn qua ledger và không xoá biến thể');
  const t1Before = (await owner.query(
    `SELECT v.id, v.sku, v.price_vnd, coalesce(il.on_hand,0) on_hand
       FROM variants v JOIN product_source_refs r ON r.variant_id=v.id
       LEFT JOIN inventory_levels il ON il.variant_id=v.id
      WHERE r.shop_id=$1 AND r.external_id IN ('1731000000000000101','1731000000000000102') ORDER BY r.external_id`, [A.shopId])).rows;
  const snapshotOrder = (await owner.query(
    `INSERT INTO orders (shop_id, order_number, total_vnd) VALUES ($1, $2, $3) RETURNING id`,
    [A.shopId, 900000000 + Math.floor(Math.random() * 90000000), Number(t1Before[0].price_vnd)],
  )).rows[0];
  const snapshotLine = (await owner.query(
    `INSERT INTO order_lines
       (shop_id, order_id, variant_id, title_snapshot, sku_snapshot, unit_price_vnd, qty)
     VALUES ($1, $2, $3, 'Vòng tay TikTok', $4, $5, 1) RETURNING id`,
    [A.shopId, snapshotOrder.id, t1Before[0].id, t1Before[0].sku, t1Before[0].price_vnd],
  )).rows[0];

  r = await imp([{ ...tiktokRows[0], price: '440000' }], { import_mode: 'upsert', update_price: true });
  const priceWithoutConfirm = (await owner.query(`SELECT price_vnd FROM variants WHERE id=$1`, [t1Before[0].id])).rows[0];
  r.status === 400 && Number(priceWithoutConfirm.price_vnd) === Number(t1Before[0].price_vnd)
    ? ok('cập nhật giá thiếu xác nhận riêng → từ chối trước khi ghi')
    : bad('chốt xác nhận giá không hoạt động', JSON.stringify({ result: r.json, after: priceWithoutConfirm }));

  r = await imp(tiktokRows.slice(0, 2).map((x, i) => ({ ...x, price: i === 0 ? '420000' : '430000', quantity: i === 0 ? '45' : '46' })), {
    import_mode: 'upsert', update_price: true, price_confirmed: true, update_stock: true,
  });
  const t1After = (await owner.query(
    `SELECT v.id, v.price_vnd, coalesce(il.on_hand,0) on_hand,
            (SELECT count(*) FROM inventory_ledger l WHERE l.variant_id=v.id AND l.kind='adjust' AND l.reason='nhập từ TikTok') adjusts
       FROM variants v JOIN product_source_refs r ON r.variant_id=v.id
       LEFT JOIN inventory_levels il ON il.variant_id=v.id
      WHERE r.shop_id=$1 AND r.external_id IN ('1731000000000000101','1731000000000000102') ORDER BY r.external_id`, [A.shopId])).rows;
  const t1Product = (await owner.query(`SELECT price_vnd FROM products WHERE id=$1`, [(await owner.query(`SELECT product_id FROM product_source_refs WHERE shop_id=$1 AND external_id=$2`, [A.shopId, '1731000000000000101'])).rows[0].product_id])).rows[0];
  r.json?.updated === 1 && t1After[0]?.price_vnd == 420000 && t1After[1]?.price_vnd == 430000
    && t1After.every((x) => Number(x.adjusts) === 1) && Number(t1Product.price_vnd) === 420000
    ? ok('upsert giá + tồn cập nhật đúng, giá sản phẩm đồng bộ theo min và mỗi biến thể có 1 ledger adjust')
    : bad('upsert giá/tồn sai', JSON.stringify({ result: r.json, before: t1Before, after: t1After, product: t1Product }));
  const snapshotAfter = (await owner.query(
    `SELECT sku_snapshot, unit_price_vnd FROM order_lines WHERE id=$1`, [snapshotLine.id],
  )).rows[0];
  snapshotAfter?.sku_snapshot === t1Before[0].sku && Number(snapshotAfter.unit_price_vnd) === Number(t1Before[0].price_vnd)
    ? ok('đơn cũ giữ nguyên SKU và giá snapshot sau upsert')
    : bad('upsert làm đổi snapshot của đơn cũ', JSON.stringify(snapshotAfter));

  const t2v = (await owner.query(`SELECT r.variant_id, v.price_vnd FROM product_source_refs r JOIN variants v ON v.id=r.variant_id WHERE r.shop_id=$1 AND r.external_id='1731000000000000201'`, [A.shopId])).rows[0];
  await owner.query(`UPDATE variants SET compare_at_vnd=580000 WHERE id=$1`, [t2v.variant_id]);
  r = await imp([{ ...tiktokRows[2], price: '600000', quantity: '10' }], { import_mode: 'upsert', update_price: true, price_confirmed: true });
  const t2After = (await owner.query(`SELECT price_vnd FROM variants WHERE id=$1`, [t2v.variant_id])).rows[0];
  r.json?.errors?.some((e) => /giá mới|giá gạch/.test(e.error)) && Number(t2After.price_vnd) === Number(t2v.price_vnd)
    ? ok('giá mới không vượt compare_at hiện hữu: từ chối và không ghi giá')
    : bad('khóa compare_at không bắt được', JSON.stringify({ result: r.json, after: t2After }));

  r = await imp([{
    ...tiktokRows[2], variation_value: '50cm, 50cm', sku_id: '1731000000000000203', price: '570000', quantity: '7',
  }], { import_mode: 'upsert' });
  const newVariantRef = (await owner.query(
    `SELECT v.sku FROM product_source_refs r JOIN variants v ON v.id=r.variant_id
      WHERE r.shop_id=$1 AND r.external_id='1731000000000000203'`, [A.shopId],
  )).rows[0];
  r.json?.variants_created === 1 && newVariantRef?.sku && !/^\d{10,}$/.test(newVariantRef.sku)
    ? ok('upsert tạo biến thể TikTok mới, giữ SKU đọc được và lưu source ref')
    : bad('upsert biến thể mới sai', JSON.stringify({ result: r.json, newVariantRef }));

  await owner.query(`UPDATE inventory_levels SET reserved=8 WHERE variant_id=$1`, [t2v.variant_id]);
  const t2v2 = (await owner.query(`SELECT r.variant_id FROM product_source_refs r WHERE r.shop_id=$1 AND r.external_id='1731000000000000202'`, [A.shopId])).rows[0];
  r = await imp([
    { ...tiktokRows[2], quantity: '5' },
    { ...tiktokRows[3], quantity: '8' },
  ], { import_mode: 'upsert', update_stock: true });
  const stockRows = (await owner.query(`SELECT variant_id,on_hand,reserved FROM inventory_levels WHERE variant_id=ANY($1::uuid[]) ORDER BY variant_id`, [[t2v.variant_id, t2v2.variant_id]])).rows;
  r.json?.errors?.some((e) => /giữ chỗ|giữ/.test(e.error)) && stockRows.some((x) => x.variant_id === t2v.variant_id && Number(x.on_hand) === 10)
    ? ok('tồn dưới reserved bị từ chối, không ép âm tồn khả dụng')
    : bad('khóa reserved không bắt được', JSON.stringify({ result: r.json, stockRows }));

  r = await imp([tiktokRows[0]], { import_mode: 'upsert', update_content: true });
  const t1Refs = (await owner.query(`SELECT count(*)::int n FROM product_source_refs WHERE shop_id=$1 AND product_id=(SELECT product_id FROM product_source_refs WHERE shop_id=$1 AND external_id='1731000000000000101')`, [A.shopId])).rows[0];
  r.json?.missing_variants?.length === 1 && Number(t1Refs.n) === 3
    ? ok('biến thể vắng mặt được báo cáo và giữ nguyên, không bị xoá')
    : bad('xử lý biến thể vắng mặt sai', JSON.stringify({ result: r.json, refs: t1Refs }));

  const protectedVariant = t1Before[0];
  await owner.query(`INSERT INTO variant_costs (shop_id, variant_id, cost_vnd, updated_by) VALUES ($1,$2,77777,NULL)
    ON CONFLICT (shop_id,variant_id) DO UPDATE SET cost_vnd=77777`, [A.shopId, protectedVariant.id]);
  const protectedProduct = (await owner.query(`SELECT product_id FROM product_source_refs WHERE shop_id=$1 AND external_id='1731000000000000101'`, [A.shopId])).rows[0].product_id;
  r = await imp([{ ...tiktokRows[0], product_name: 'Tên TikTok đã đổi', price: '410000' }], {
    import_mode: 'upsert', update_content: true, update_price: true, price_confirmed: true,
  });
  const protectedAfter = (await owner.query(
    `SELECT p.slug, v.sku, vc.cost_vnd FROM products p JOIN variants v ON v.id=$2
       LEFT JOIN variant_costs vc ON vc.variant_id=v.id WHERE p.id=$1`, [protectedProduct, protectedVariant.id])).rows[0];
  protectedAfter?.slug === t1 && protectedAfter.sku === protectedVariant.sku && Number(protectedAfter.cost_vnd) === 77777
    ? ok('upsert không ghi đè slug, SKU hay cost_vnd do shop sở hữu')
    : bad('field ownership bị phá', JSON.stringify({ result: r.json, protectedAfter }));

  const oldMedia = (await owner.query(
    `INSERT INTO media (shop_id, product_id, status, source_url, original_key, position)
     VALUES ($1, $2, 'failed', 'https://example.com/old.jpg', $3, 0) RETURNING id`,
    [A.shopId, protectedProduct, `staging/${A.shopId}/${uniq()}`],
  )).rows[0];
  const t5 = '1731000000000000005';
  r = await imp([
    { ...tiktokRows[0], main_image: 'https://example.com/replaced.jpg' },
    { product_id: t5, product_name: 'Sản phẩm mới có ảnh', product_description: '<p>X</p>', category: 'Khác (3)',
      price: '100000', quantity: '1', parcel_weight: '200', variation_value: 'A', sku_id: '1731000000000000501',
      main_image: 'https://example.com/new.jpg' },
  ], { import_mode: 'upsert', update_content: true, image_limit: 1 });
  const imageBudgetState = (await owner.query(
    `SELECT
       count(*) FILTER (WHERE id=$1)::int AS old_left,
       count(*) FILTER (WHERE product_id=$2 AND source_url='https://example.com/replaced.jpg' AND deleted_at IS NULL)::int AS replacement
     FROM media WHERE shop_id=$3`, [oldMedia.id, protectedProduct, A.shopId],
  )).rows[0];
  r.json?.created === 1 && r.json?.updated === 1 && r.json?.images?.queued === 1
    && r.json?.images?.skipped === 1 && r.json?.images?.remaining === 0
    && Number(imageBudgetState.old_left) === 0 && Number(imageBudgetState.replacement) === 1
    ? ok('tạo mới + cập nhật dùng chung một ngân sách ảnh; ảnh cũ được dọn dứt điểm')
    : bad('ngân sách hoặc vòng đời ảnh upsert sai', JSON.stringify({ result: r.json, imageBudgetState }));

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

  // ── 10. Ảnh theo URL: đường thành công + hàng rào SSRF ──────────────────
  sect('10. Tải ảnh theo URL (docs/45 §5)');
  // Máy chủ ảnh GIẢ chạy ngay trong bộ test, cổng 80 (bộ tải chỉ nhận 80/443).
  // Host `dbtest` nằm trong IMPORT_IMG_ALLOW_HOSTS của compose.dev — lối thoát HẸP để
  // kiểm được đường-thành-công trong stack toàn IP nội bộ. Mọi lớp khác vẫn nguyên.
  const png = makePng(40, 30);
  let hits = 0;
  let bigKhoiDaDay = 0;   // số MB máy chủ giả kịp đẩy cho /big — xem chú thích ở route đó
  let liarKhoiDaDay = 0;  // ... và cho /liar
  const srv = http.createServer((req, res) => {
    hits++;
    if (req.url.startsWith('/ok')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(png); }
    if (req.url.startsWith('/redirect')) { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); return res.end(); }
    if (req.url.startsWith('/notimage')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.from('<?php echo 1; ?>')); }
    // Ảnh QUÁ CỠ: khai đúng độ dài, vượt trần 8MB → phải bị chặn ở bước đọc Content-Length.
    //
    // ĐẨY THEO KHỐI VÀ ĐẾM, thay vì `res.end(buffer)` một phát. Lý do là chuyện đo lường:
    // hai chốt too_big xếp chồng nhau, nên gỡ riêng chốt Content-Length thì chốt-khi-đang-chảy
    // vẫn bắt được và ảnh vẫn 'failed' — tức khẳng định "có chặn không" KHÔNG hề canh chốt
    // header. Thứ chốt header thật sự làm là KHÔNG TẢI 9MB về, và cách duy nhất đo nó là đếm
    // xem máy chủ đã kịp đẩy bao nhiêu.
    if (req.url.startsWith('/big')) {
      const chunk = Buffer.alloc(1024 * 1024, 0x41);
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(9 * 1024 * 1024) });
      res.on('error', () => {});
      let i = 0;
      const day = () => {
        if (i >= 9 || res.writableEnded || res.destroyed) { if (!res.writableEnded) res.end(); return; }
        i++; bigKhoiDaDay++;
        if (res.write(chunk)) setImmediate(day); else res.once('drain', day);
      };
      return day();
    }
    // KHAI MAN độ dài: không khai Content-Length rồi đẩy 40MB. Nếu chỉ tin Content-Length thì
    // thủng — đây là ca chứng minh trần được cưỡng chế CẢ TRONG LÚC DỮ LIỆU ĐANG CHẢY.
    //
    // 40MB chứ không phải 9MB, và ĐẾM số khối đẩy được. Đo ngày 06/09: bản 9MB làm đột biến
    // "gỡ chốt khi-đang-chảy" đỏ ở SAI CHỖ — hàng rào nuốt trọn 9MB rồi bước sniff magic byte
    // mới từ chối, nên ảnh vẫn 'failed' và chỉ có MÃ LỖI đổi (too_big → not_image). Tức khẳng
    // định "có chặn không" đang được một chốt KHÁC đỡ hộ. Hậu quả thật của chốt này là hàng
    // rào NGỪNG KÉO, và cách duy nhất đo nó là xem đầu kia đẩy được bao nhiêu trước khi đứt.
    if (req.url.startsWith('/liar')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.on('error', () => {});
      const chunk = Buffer.alloc(1024 * 1024, 0x42);
      let i = 0;
      const day = () => {
        if (i >= 40 || res.writableEnded || res.destroyed) { if (!res.writableEnded) res.end(); return; }
        i++; liarKhoiDaDay++;
        if (res.write(chunk)) setImmediate(day); else res.once('drain', day);
      };
      return day();
    }
    res.writeHead(404); res.end();
  });
  await new Promise((res) => srv.listen(80, '0.0.0.0', res));

  const hImg = `anh-${uniq()}`;
  r = await imp([{ handle: hImg, title: 'SP có ảnh', sku: `${hImg}-1`, price_vnd: '99000', image_url: 'http://dbtest/ok.png' }]);
  // Bộ nhập giờ chỉ XẾP HÀNG (0106) — không chạm mạng, nên request nhanh và không còn trần
  // thời gian. Ảnh do worker tải nền.
  r.json?.created === 1 && r.json?.images?.queued === 1 && r.json?.images?.invalid === 0
    ? ok('URL hợp lệ → xếp hàng cho worker (images.queued = 1), request KHÔNG chạm mạng')
    : bad('xếp hàng ảnh hỏng', JSON.stringify(r.json?.images));

  const pImg = (await a.get('/products?limit=50')).json.products.find((p) => p.slug === hImg);
  let med = (await owner.query(`SELECT status, source_url, public_key FROM media WHERE product_id = $1`, [pImg?.id])).rows[0];
  med?.status === 'pending' && med.source_url === 'http://dbtest/ok.png' && !med.public_key
    ? ok('dòng media pending + source_url = ĐƠN VỊ CÔNG VIỆC của worker (không cần bảng hàng đợi riêng)')
    : bad('không ghi hàng đợi', JSON.stringify(med));

  // Chờ worker xử — sweep chạy mỗi MEDIAFETCH_SWEEP_MS (dev đặt ngắn).
  for (let i = 0; i < 40 && med?.status === 'pending'; i++) {
    await sleep(1000);
    med = (await owner.query(`SELECT status, public_key, width, height FROM media WHERE product_id = $1`, [pImg?.id])).rows[0];
  }
  med?.status === 'ready' && /\.webp$/.test(med.public_key ?? '') && Number(med.width) === 40 && Number(med.height) === 30
    ? ok('worker tải xong: bản WebP 40×30 ở bucket public, media=ready')
    : bad('worker không xử lý được hàng đợi', JSON.stringify(med));

  // URL sai DÁNG bị bắt NGAY tại request (rẻ, không chạm mạng) — người bán biết liền nếu tệp
  // dùng đường dẫn tương đối, chứ không phải mười phút sau mới thấy 300 ảnh hỏng.
  const hBad2 = `xau-${uniq()}`;
  r = await imp([
    { handle: `${hBad2}-1`, title: 'URL tương đối', sku: `${hBad2}-1`, price_vnd: '1000', image_url: '/images/a.png' },
    { handle: `${hBad2}-2`, title: 'Scheme sai', sku: `${hBad2}-2`, price_vnd: '1000', image_url: 'file:///etc/passwd' },
    { handle: `${hBad2}-3`, title: 'Cổng lạ', sku: `${hBad2}-3`, price_vnd: '1000', image_url: 'http://dbtest:6379/a.png' },
  ]);
  r.json?.created === 3 && r.json?.images?.queued === 0 && r.json?.images?.invalid === 3
    ? ok('3 URL sai dáng bị bắt NGAY tại request, sản phẩm vẫn vào')
    : bad('URL sai dáng lọt vào hàng đợi', JSON.stringify(r.json?.images));

  // Vector SSRF: xếp hàng được (đúng dáng) nhưng worker PHẢI từ chối và đánh 'failed' NGAY,
  // không thử lại — URL trỏ mạng nội bộ sẽ không tự tốt lên.
  const hSsrf2 = `ssrfw-${uniq()}`;
  r = await imp([
    { handle: `${hSsrf2}-1`, title: 'Loopback', sku: `${hSsrf2}-1`, price_vnd: '1000', image_url: 'http://127.0.0.1/ok.png' },
    { handle: `${hSsrf2}-2`, title: 'Metadata', sku: `${hSsrf2}-2`, price_vnd: '1000', image_url: 'http://169.254.169.254/latest/meta-data/' },
    { handle: `${hSsrf2}-3`, title: 'Chuyển hướng', sku: `${hSsrf2}-3`, price_vnd: '1000', image_url: 'http://dbtest/redirect' },
  ]);
  const ssrfIds = (await owner.query(
    `SELECT m.id FROM media m JOIN products p ON p.id = m.product_id
      WHERE p.slug LIKE $1`, [`${hSsrf2}%`])).rows.map((x) => x.id);
  let states = [];
  for (let i = 0; i < 40; i++) {
    states = (await owner.query(`SELECT status, fetch_attempts FROM media WHERE id = ANY($1::uuid[])`, [ssrfIds])).rows;
    if (states.length && states.every((x) => x.status !== 'pending')) break;
    await sleep(1000);
  }
  states.length === 3 && states.every((x) => x.status === 'failed')
    ? ok('worker chặn 3 vector SSRF, đánh failed NGAY (không quay vòng thử lại URL nội bộ)')
    : bad('worker xử lý sai vector SSRF', JSON.stringify(states));
  states.every((x) => Number(x.fetch_attempts) === 1)
    ? ok('lỗi VĨNH VIỄN chỉ thử đúng 1 lần — mỗi lần thử là một kết nối ra ngoài ta phải chịu trách nhiệm')
    : bad('thử lại lỗi vĩnh viễn', JSON.stringify(states.map((x) => x.fetch_attempts)));

  // Tệp giả dạng ảnh: xếp hàng được nhưng sniff magic byte ở worker bắt.
  const hFake = `gia-${uniq()}`;
  r = await imp([{ handle: hFake, title: 'Ảnh giả', sku: `${hFake}-1`, price_vnd: '1000', image_url: 'http://dbtest/notimage.png' }]);
  const fakeP = (await a.get('/products?limit=50')).json.products.find((p) => p.slug === hFake);
  let fakeMed = null;
  for (let i = 0; i < 40; i++) {
    fakeMed = (await owner.query(`SELECT status FROM media WHERE product_id = $1`, [fakeP?.id])).rows[0];
    if (fakeMed?.status && fakeMed.status !== 'pending') break;
    await sleep(1000);
  }
  fakeMed?.status === 'failed'
    ? ok('tệp giả dạng ảnh (content-type nói dối) → sniff magic byte ở worker từ chối')
    : bad('ảnh giả lọt qua worker', JSON.stringify(fakeMed));

  // ── Trần DUNG LƯỢNG: hai chốt, hai đường vào ─────────────────────────────
  // Hai route /big và /liar đã nằm trong máy chủ giả từ lượt đầu, KÈM chú thích giải thích
  // chúng chứng minh gì — nhưng không dòng nào từng gửi request tới chúng. Đo ngày 06/09:
  // gỡ CẢ HAI chốt `too_big` trong fetch-image.js cho unit 14/0 và bộ này 42/0, xanh trọn vẹn.
  // Fixture viết ra rồi không ai gọi là một chốt KHÔNG TỒN TẠI, chỉ trông như có.
  //
  //   /big  — khai đúng Content-Length 9MB  → cắt ở bước đọc HEADER, chưa tải byte nào.
  //   /liar — khai 'chunked' rồi đẩy 9MB    → chỉ Content-Length thì thủng; phải cưỡng chế
  //           trần CẢ TRONG LÚC DỮ LIỆU ĐANG CHẢY.
  //
  // Và đo luôn PHÂN LOẠI, không chỉ "có chặn không": `too_big` phải là lỗi VĨNH VIỄN. Trước
  // 06/09 nó rơi ra ngoài danh sách vĩnh viễn nên đi đường thử-lại — đo được ở /liar là tải
  // trọn 8MB mỗi lượt × 4 lượt = 32MB, rải qua 1+5+25 phút, kết cục vẫn 'failed'.
  const hBig = `qua-co-${uniq()}`;
  r = await imp([
    { handle: `${hBig}-1`, title: 'Ảnh quá cỡ (khai đúng)', sku: `${hBig}-1`, price_vnd: '1000', image_url: 'http://dbtest/big.png' },
    { handle: `${hBig}-2`, title: 'Ảnh quá cỡ (khai man)', sku: `${hBig}-2`, price_vnd: '1000', image_url: 'http://dbtest/liar.png' },
  ]);
  r.json?.images?.queued === 2
    ? ok('ảnh quá cỡ xếp hàng bình thường — trần dung lượng chỉ đo được KHI TẢI, không đoán từ URL')
    : bad('ảnh quá cỡ không vào hàng đợi', JSON.stringify(r.json?.images));
  const bigIds = (await owner.query(
    `SELECT m.id FROM media m JOIN products p ON p.id = m.product_id WHERE p.slug LIKE $1`, [`${hBig}%`])).rows.map((x) => x.id);
  let bigStates = [];
  for (let i = 0; i < 60; i++) {
    bigStates = (await owner.query(
      `SELECT status, fetch_attempts, last_error, next_attempt_at FROM media WHERE id = ANY($1::uuid[])`, [bigIds])).rows;
    if (bigStates.length === 2 && bigStates.every((x) => x.status !== 'pending')) break;
    await sleep(1000);
  }
  bigStates.length === 2 && bigStates.every((x) => x.status === 'failed')
    ? ok('CẢ HAI đường vượt trần bị chặn: Content-Length khai đúng VÀ khai man khi đang chảy')
    : bad('ảnh 9MB lọt qua trần 8MB', JSON.stringify(bigStates));
  bigStates.every((x) => x.last_error === 'too_big')
    ? ok('lý do ghi đúng mã too_big — người bán đọc được "ảnh vượt quá dung lượng cho phép"')
    : bad('lý do ảnh quá cỡ sai', JSON.stringify(bigStates.map((x) => x.last_error)));
  // Tệp ở đầu kia không tự nhỏ đi ⇒ vĩnh viễn, đúng nhóm với not_image ngay cạnh.
  //
  // "VĨNH VIỄN" đo bằng `next_attempt_at IS NULL`, KHÔNG bằng `fetch_attempts === 1`. Đo ngày
  // 06/09: bản đầu chỉ đếm lượt thử, mà ngay sau lượt đầu thì đường vĩnh viễn và đường thử-lại
  // ĐỀU có attempts = 1 — khác nhau ở chỗ đường thử-lại còn hẹn giờ. Đột biến bỏ 'too_big'
  // khỏi danh sách vĩnh viễn vì thế đi qua khẳng định KHÁC, còn khẳng định mang chữ "vĩnh
  // viễn" thì vẫn xanh. Chốt phải đo đúng thứ tên nó nói.
  bigStates.every((x) => Number(x.fetch_attempts) === 1 && x.next_attempt_at === null)
    ? ok('vượt trần là lỗi VĨNH VIỄN: 1 lượt, KHÔNG hẹn giờ tải lại 8MB thêm ba lần nữa')
    : bad('ảnh quá cỡ vẫn quay vòng thử lại', JSON.stringify(bigStates.map((x) => [x.fetch_attempts, x.next_attempt_at]))); 
  // Chốt HEADER, đo riêng: Content-Length đã nói 9MB thì phải cắt TRƯỚC khi kéo về. Không có
  // khẳng định này thì gỡ chốt header vẫn xanh (chốt-khi-đang-chảy đỡ hộ) — đúng kiểu "xanh
  // vì lý do sai" mà §4 cảnh báo.
  bigKhoiDaDay <= 2
    ? ok(`Content-Length 9MB bị cắt TRƯỚC khi tải (máy chủ chỉ kịp đẩy ${bigKhoiDaDay}MB)`)
    : bad(`kéo về ${bigKhoiDaDay}MB rồi mới cắt — chốt Content-Length không còn tác dụng`);
  // Chốt KHI-ĐANG-CHẢY, đo riêng: không khai độ dài thì trần phải cắt giữa dòng. Đầu kia có
  // 40MB để đẩy; hàng rào phải ngắt giữa chừng chứ không nuốt hết rồi mới chê. Ngưỡng 24 chứ
  // không phải 8: `res.write` trả true là đã nhét vào đệm socket, nên đầu kia còn đẩy thêm một
  // quãng sau khi hàng rào đã destroy. Đo được 13MB khi chốt còn, 40MB khi gỡ chốt — ngưỡng
  // đặt giữa hai con số ĐO ĐƯỢC, không đặt theo lý thuyết.
  liarKhoiDaDay <= 24
    ? ok(`khai man độ dài: hàng rào NGỪNG KÉO ở ~${liarKhoiDaDay}MB, không nuốt trọn 40MB`)
    : bad(`nuốt ${liarKhoiDaDay}MB rồi mới từ chối — trần không được cưỡng chế lúc đang chảy`);
  // Và các vector SSRF ở trên phải ghi đúng lý do của CHÍNH chúng, không phải một mã chung.
  const ssrfReasons = (await owner.query(
    `SELECT last_error FROM media WHERE id = ANY($1::uuid[]) ORDER BY last_error`, [ssrfIds])).rows.map((x) => x.last_error);
  JSON.stringify(ssrfReasons) === JSON.stringify(['blocked', 'blocked', 'status'])
    ? ok('mỗi vector SSRF ghi đúng lý do riêng (2 blocked + 1 status cho chuyển hướng)')
    : bad('lý do vector SSRF sai', JSON.stringify(ssrfReasons));

  await new Promise((res) => srv.close(res));

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
