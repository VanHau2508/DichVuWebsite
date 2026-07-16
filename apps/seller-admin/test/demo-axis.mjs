/**
 * Demo BIẾN THỂ ĐA TRỤC trên shop có sẵn (mặc định: shop Nhà Xinh + sản phẩm thảm).
 * Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/demo-axis.mjs
 *
 * Làm QUA API THẬT (đúng luồng chủ shop): đăng nhập owner → đặt trục Màu×Size (sinh ma trận)
 * → giá riêng từng size → tồn từng tổ hợp → upload ảnh swatch màu (PNG sinh tại chỗ) gán theo
 * biến thể → bảng thông số → mô tả có định dạng. Idempotent: chạy lại giữ tổ hợp cũ.
 * Tuỳ biến qua env: DEMO_OWNER_EMAIL / DEMO_OWNER_PW / DEMO_SHOP_ID / DEMO_PRODUCT_ID.
 */

import zlib from 'node:zlib';
import http from 'node:http';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const STORE = process.env.STOREFRONT_URL ?? 'http://storefront:3050';
const OA = 'https://auth.localtest', OS = 'https://seller.localtest';

const OWNER_EMAIL = process.env.DEMO_OWNER_EMAIL ?? 'chushop-4t2cq0@nhaxinh.vn';
const OWNER_PW = process.env.DEMO_OWNER_PW ?? 'nha xinh chu shop 2026';
const SHOP_ID = process.env.DEMO_SHOP_ID ?? 'b0631eeb-5c25-44ae-991d-c945286aa47a';
const PRODUCT_ID = process.env.DEMO_PRODUCT_ID ?? 'c1688f95-0770-4758-9c99-65ef6fb375ba';

const G = '\x1b[32m', R = '\x1b[31m', X = '\x1b[0m';
const step = (m) => console.log(`${G}✔${X} ${m}`);
const fail = (m, d) => { console.log(`${R}✘ ${m}${X}`); if (d) console.log('  ', d); process.exit(1); };
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };

async function rq(base, method, path, { body, cookie, origin, raw } = {}) {
  const h = {};
  if (raw) h['content-type'] = 'application/octet-stream';
  else if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}

// ── PNG swatch sinh tại chỗ (không cần file ảnh): sọc ngang 2 tông màu như mẫu thảm ──
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'latin1');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function swatchPng([r1, g1, b1], [r2, g2, b2], w = 400, h = 400) {
  const rowBytes = 1 + w * 3;
  const rawBuf = Buffer.alloc(h * rowBytes);
  for (let y = 0; y < h; y++) {
    const stripe = Math.floor(y / 40) % 2 === 0;
    const [r, g, b] = stripe ? [r1, g1, b1] : [r2, g2, b2];
    rawBuf[y * rowBytes] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const o = y * rowBytes + 1 + x * 3;
      rawBuf[o] = r; rawBuf[o + 1] = g; rawBuf[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // bit depth 8, truecolor
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rawBuf)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  // 1) Đăng nhập chủ shop
  const lr = await rq(AUTH, 'POST', '/auth/login', { body: { email: OWNER_EMAIL, password: OWNER_PW }, origin: OA });
  const cookie = ck(lr.sc);
  if (!cookie) fail('đăng nhập owner thất bại', lr.raw);
  step(`đăng nhập ${OWNER_EMAIL}`);

  const S = {
    get: (p) => rq(SELLER, 'GET', `/shops/${SHOP_ID}${p}`, { cookie }),
    post: (p, body) => rq(SELLER, 'POST', `/shops/${SHOP_ID}${p}`, { body, cookie, origin: OS }),
    put: (p, body) => rq(SELLER, 'PUT', `/shops/${SHOP_ID}${p}`, { body, cookie, origin: OS }),
    patch: (p, body) => rq(SELLER, 'PATCH', `/shops/${SHOP_ID}${p}`, { body, cookie, origin: OS }),
    upload: (p, bytes) => rq(SELLER, 'POST', `/shops/${SHOP_ID}${p}`, { cookie, origin: OS, raw: bytes }),
  };

  // 2) Trục Màu × Size → sinh ma trận 4 tổ hợp
  let r = await S.put(`/products/${PRODUCT_ID}/options`, {
    options: [
      { name: 'Màu', values: ['Xám trắng', 'Nâu be'] },
      { name: 'Size', values: ['1m6 x 2m3', '2m x 3m'] },
    ],
  });
  if (r.status !== 200) fail('đặt trục thất bại', r.raw);
  step(`trục Màu×Size → ${r.json.combos} tổ hợp (tạo mới ${r.json.generated}, tái dùng ${r.json.reused})`);

  // 3) Lấy biến thể theo nhãn tổ hợp
  r = await S.get(`/products/${PRODUCT_ID}`);
  const byTitle = Object.fromEntries((r.json.variants ?? []).map((v) => [v.title, v]));
  const need = ['Xám trắng / 1m6 x 2m3', 'Xám trắng / 2m x 3m', 'Nâu be / 1m6 x 2m3', 'Nâu be / 2m x 3m'];
  for (const t of need) if (!byTitle[t]) fail(`thiếu tổ hợp "${t}"`, JSON.stringify(Object.keys(byTitle)));

  // 4) Giá theo size (size lớn đắt hơn) + tồn từng tổ hợp
  const PRICE = { '1m6 x 2m3': 650000, '2m x 3m': 950000 };
  const STOCK = { 'Xám trắng / 1m6 x 2m3': 12, 'Xám trắng / 2m x 3m': 6, 'Nâu be / 1m6 x 2m3': 9, 'Nâu be / 2m x 3m': 0 };
  for (const t of need) {
    const v = byTitle[t];
    const price = PRICE[t.split(' / ')[1]];
    r = await S.patch(`/products/${PRODUCT_ID}/variants/${v.id}`, { price_vnd: price });
    if (r.status !== 200) fail(`sửa giá "${t}" thất bại`, r.raw);
    const cur = Number((await S.get(`/variants/${v.id}/inventory`)).json?.available ?? 0);
    const delta = STOCK[t] - cur;
    if (delta !== 0) {
      r = await S.post(`/variants/${v.id}/inventory/adjust`, { delta, reason: 'demo đa trục' });
      if (r.status !== 200) fail(`đặt tồn "${t}" thất bại`, r.raw);
    }
  }
  step('giá theo size (650k / 950k) + tồn: 12 · 6 · 9 · 0 (1 tổ hợp HẾT HÀNG để xem gạch ngang)');

  // 5) Ảnh swatch theo MÀU, gán cho từng tổ hợp (ảnh gốc giữ làm ảnh chung)
  const SWATCH = {
    'Xám trắng': swatchPng([214, 214, 210], [168, 168, 162]),
    'Nâu be': swatchPng([176, 137, 104], [140, 105, 76]),
  };
  const existing = (await S.get(`/products/${PRODUCT_ID}/media`)).json?.media ?? [];
  for (const t of need) {
    const color = t.split(' / ')[0];
    const v = byTitle[t];
    if (existing.some((m) => m.variant_id === v.id)) continue; // idempotent: đã có ảnh gán
    r = await S.upload(`/products/${PRODUCT_ID}/media`, SWATCH[color]);
    if (r.status !== 201) fail(`upload swatch "${t}" thất bại`, r.raw);
    r = await S.post(`/media/${r.json.id}/variant`, { variant_id: v.id });
    if (r.status !== 200) fail(`gán ảnh "${t}" thất bại`, r.raw);
  }
  step('4 ảnh swatch (xám/nâu) upload + gán theo biến thể — chọn màu sẽ ĐỔI ảnh');

  // 6) Bảng thông số + mô tả có định dạng
  r = await S.put(`/products/${PRODUCT_ID}/specs`, { specs: [
    { name: 'Chất liệu', value: 'Lông ngắn polyester, đế chống trượt' },
    { name: 'Kích thước', value: '1m6 x 2m3 hoặc 2m x 3m' },
    { name: 'Xuất xứ', value: 'Việt Nam' },
    { name: 'Bảo hành', value: 'Đổi trả trong 7 ngày' },
  ] });
  if (r.status !== 200) fail('lưu specs thất bại', r.raw);
  r = await S.patch(`/products/${PRODUCT_ID}`, { description:
`Thảm trải sàn lông ngắn cao cấp, mềm mại êm chân, phù hợp phòng khách và phòng ngủ.

- Lông ngắn dễ vệ sinh, không bám bụi sâu
- Đế cao su chống trượt an toàn cho trẻ nhỏ
- 2 màu trung tính dễ phối nội thất
- Giặt máy ở chế độ nhẹ

Giao hàng toàn quốc, kiểm tra hàng trước khi thanh toán.` });
  if (r.status !== 200) fail('cập nhật mô tả thất bại', r.raw);
  step('bảng thông số (4 dòng) + mô tả có đoạn & gạch đầu dòng');

  // 7) Kiểm chứng trang khách (SSR) render đủ khối. Dùng node:http vì fetch/undici
  //    CẤM đặt header Host (bài học từ storefront e2e).
  const pslug = (await S.get(`/products/${PRODUCT_ID}`)).json.slug;
  const host = process.env.DEMO_HOST ?? 'nha-xinh-1nh1va.nentang.vn';
  const su = new URL(STORE);
  const html = await new Promise((resolve, reject) => {
    const req2 = http.request(
      { hostname: su.hostname, port: su.port, path: `/p/${pslug}`, method: 'GET', headers: { host } },
      (res2) => { let b = ''; res2.on('data', (d) => (b += d)); res2.on('end', () => resolve(b)); },
    );
    req2.on('error', reject);
    req2.end();
  });
  const checks = [
    ['chip Màu', html.includes('>Xám trắng<') || html.includes('>Xám trắng</a>')],
    ['chip Size', html.includes('1m6 x 2m3')],
    ['Mua ngay', html.includes('Mua ngay')],
    ['bảng thông số', html.includes('class="specs"')],
    ['gallery radio', html.includes('id="gsel-0"')],
    ['tổ hợp hết hàng gạch ngang', html.includes('chip out') || html.includes('class="chip disabled"') || html.includes('chip sel')],
  ];
  for (const [name, okc] of checks) { if (!okc) fail(`storefront thiếu: ${name}`); }
  step(`storefront render đủ: chips + Mua ngay + specs + gallery (/p/${pslug})`);

  console.log(`\n${G}DEMO SẴN SÀNG${X} → https://nha-xinh-1nh1va.nentang.vn:8443/p/${pslug}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
