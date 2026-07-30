/**
 * Seed nội dung cho 4 shop demo — CHỈ DEV. Chạy qua scripts/seed-demo.sh.
 *
 * Vì sao cần: bốn preset ngành chia CHUNG một bố cục 12 khối (phương án A), nên
 * thứ duy nhất làm shop "ra ngành của nó" là palette + ảnh + chữ. Lưới rỗng thì
 * bốn preset trông y hệt nhau và không đánh giá được gì.
 *
 * Ảnh: sinh tại chỗ bằng sharp (SVG → webp) rồi đẩy MinIO. KHÔNG dùng URL ngoài —
 * CSP của storefront là same-origin cho img, ảnh ngoài sẽ bị chặn sạch.
 *
 * Chạy lại được nhiều lần: xoá sạch nội dung cũ của đúng 4 shop rồi dựng lại.
 */
import pg from 'pg';
import * as Minio from 'minio';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
// Chép sang bởi seed-demo.sh (image seller không có thư mục packages/).
// './' chứ không '../': file này chạy ở /app/seed-demo.mjs, không nằm trong src/
// như worker (worker dùng '../fetch-image.js' vì nguồn nó ở /app/src/).
import { PRESETS } from './presets.js';

const db = new pg.Client({ connectionString: process.env.SEED_DATABASE_URL });
const minio = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT,
  port: Number(process.env.MINIO_PORT),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY,
});
const BUCKET = process.env.MEDIA_BUCKET_PUBLIC ?? 'media-public';

// ── Hình khối ngành ────────────────────────────────────────────────────────
// Nét vẽ tối giản trên viewBox 0 0 100 100. Chủ ý KHÔNG dùng ảnh chụp: mục tiêu
// là chấm bố cục + màu, mà khối phẳng đúng tỉ lệ đọc rõ hơn ảnh stock lệch tông.
const SHAPES = {
  ao: 'M30 18 L18 28 L26 40 L30 35 L30 84 L70 84 L70 35 L74 40 L82 28 L70 18 L61 18 A11 8 0 0 1 39 18 Z',
  vay: 'M36 18 L30 32 L36 36 L26 84 L74 84 L64 36 L70 32 L64 18 L57 18 A8 6 0 0 1 43 18 Z',
  quan: 'M32 18 L68 18 L71 84 L56 84 L50 46 L44 84 L29 84 Z',
  khoac: 'M32 18 L16 30 L25 43 L28 38 L28 84 L47 84 L47 28 L53 28 L53 84 L72 84 L72 38 L75 43 L84 30 L68 18 Z',
  la: 'M50 14 C22 28 20 64 50 88 C80 64 78 28 50 14 Z M50 22 L50 84',
  thit: 'M26 42 C26 22 74 20 78 44 C82 66 62 84 44 81 C28 78 26 60 26 42 Z M44 46 A9 9 0 1 0 44 64 A9 9 0 1 0 44 46',
  ca: 'M14 50 C30 28 62 28 78 50 C62 72 30 72 14 50 Z M78 50 L92 34 L89 50 L92 66 Z M34 44 A3 3 0 1 0 34 50 A3 3 0 1 0 34 44',
  qua: 'M50 26 A26 26 0 1 0 50 82 A26 26 0 1 0 50 26 M50 26 C50 18 56 12 66 12 C66 22 60 26 50 26',
  sofa: 'M14 48 C14 40 26 40 26 48 L26 42 L74 42 L74 48 C74 40 86 40 86 48 L86 70 L14 70 Z M22 70 L22 80 M78 70 L78 80 M26 42 L26 34 L74 34 L74 42',
  ban: 'M12 40 L88 40 L88 50 L12 50 Z M20 50 L20 82 M80 50 L80 82 M50 50 L50 66',
  giuong: 'M12 40 L12 76 L22 76 L22 68 L78 68 L78 76 L88 76 L88 52 L34 52 L34 40 Z M34 52 L34 40 L12 40',
  den: 'M34 18 L66 18 L76 46 L24 46 Z M50 46 L50 76 M32 76 L68 76 L68 82 L32 82 Z',
  son: 'M40 36 L60 36 L60 82 L40 82 Z M42 36 L42 14 L58 20 L58 36 Z',
  serum: 'M42 30 L58 30 L58 42 C68 48 68 80 58 84 L42 84 C32 80 32 48 42 42 Z M44 14 L56 14 L56 30 L44 30 Z',
  tuyp: 'M36 26 L64 26 L60 84 L40 84 Z M42 14 L58 14 L58 26 L42 26 Z M40 40 L60 40',
  phan: 'M50 24 A28 28 0 1 0 50 80 A28 28 0 1 0 50 24 M50 36 A16 16 0 1 0 50 68 A16 16 0 1 0 50 36 M22 52 L14 52',
};

/** Ô ảnh sản phẩm: nền chuyển sắc theo palette shop + khối nét trắng ở giữa. */
async function productTile(shape, c1, c2, ink) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900" viewBox="0 0 100 100">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
    </linearGradient></defs>
    <rect width="100" height="100" fill="url(#g)"/>
    <circle cx="78" cy="22" r="26" fill="${ink}" opacity=".07"/>
    <path d="${SHAPES[shape]}" fill="none" stroke="${ink}" stroke-width="2.4"
          stroke-linejoin="round" stroke-linecap="round" opacity=".85"/>
  </svg>`;
  return sharp(Buffer.from(svg)).webp({ quality: 82 }).toBuffer();
}

/**
 * Banner ngang: THUẦN ĐỒ HOẠ, KHÔNG chữ.
 *
 * Hai lý do. (1) theme.js đã tự phủ headline/sub/CTA bằng HTML lên trên ảnh
 * (.hbanner-overlay, .hs-cap, .promo-cap) — nướng chữ vào ảnh là chữ đúp.
 * (2) image seller không có fontconfig nên <text> ra ô vuông tofu.
 *
 * Bố cục cố ý lệch: trái để trống cho lớp chữ HTML, khối màu dồn sang phải.
 */
async function bannerTile(w, h, c1, c2, accent, shape) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
      </linearGradient>
      <linearGradient id="a" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${accent}" stop-opacity=".95"/>
        <stop offset="1" stop-color="${accent}" stop-opacity=".55"/>
      </linearGradient>
      <clipPath id="c"><rect width="${w}" height="${h}"/></clipPath>
    </defs>
    <g clip-path="url(#c)">
      <rect width="${w}" height="${h}" fill="url(#g)"/>
      <circle cx="${w * 0.82}" cy="${h * 0.5}" r="${h * 0.62}" fill="url(#a)"/>
      <circle cx="${w * 0.97}" cy="${h * 0.08}" r="${h * 0.34}" fill="${accent}" opacity=".28"/>
      <circle cx="${w * 0.66}" cy="${h * 1.02}" r="${h * 0.3}" fill="${accent}" opacity=".2"/>
      <g transform="translate(${w * 0.82 - h * 0.45} ${h * 0.5 - h * 0.45}) scale(${h * 0.009})">
        <path d="${SHAPES[shape]}" fill="none" stroke="#fff" stroke-width="2"
              stroke-linejoin="round" stroke-linecap="round" opacity=".9"/>
      </g>
    </g>
  </svg>`;
  return sharp(Buffer.from(svg)).webp({ quality: 84 }).toBuffer();
}

async function put(key, buf) {
  await minio.putObject(BUCKET, key, buf, buf.length, { 'Content-Type': 'image/webp' });
}

// ── Nội dung 4 shop ────────────────────────────────────────────────────────
// c1/c2 = nền ảnh (tint nhạt của palette ngành), ink = màu nét.
const SHOPS = [
  {
    slug: 'demo-fashion', industry: 'fashion', c1: '#faf7f5', c2: '#ece3dc', ink: '#3d3733', accent: '#b08968',
    hero: [['Bộ sưu tập Thu Đông', 'Vải mềm, phom chuẩn, mặc là thấy khác', 'khoac'],
           ['Ưu đãi thành viên 30%', 'Đăng ký nhận mã trong hôm nay', 'vay'],
           ['Hàng mới về mỗi thứ Sáu', 'Số lượng giới hạn theo mẫu', 'ao']],
    side: [['Áo khoác từ 590K', '', 'khoac'], ['Freeship đơn 500K', '', 'quan']],
    promo: [['Đồng giá 199K', '', 'ao'], ['Mua 2 giảm 15%', '', 'vay'], ['Sale cuối mùa', '', 'quan']],
    cats: [
      ['Thời trang nữ', 'thoi-trang-nu', ['Áo nữ|ao-nu', 'Váy & đầm|vay-dam']],
      ['Thời trang nam', 'thoi-trang-nam', ['Áo nam|ao-nam', 'Quần nam|quan-nam']],
    ],
    products: [
      ['Áo thun cotton form rộng', 'ao', 259000, 359000, 'ao-nu', 412, 4.7],
      ['Áo sơ mi lụa tay dài', 'ao', 489000, 650000, 'ao-nu', 168, 4.6],
      ['Áo len cổ lọ dệt kim', 'ao', 539000, null, 'ao-nu', 94, 4.8],
      ['Áo croptop tay bồng', 'ao', 229000, 299000, 'ao-nu', 233, 4.4],
      ['Chân váy xếp ly midi', 'vay', 429000, 559000, 'vay-dam', 187, 4.5],
      ['Đầm suông linen tay lỡ', 'vay', 690000, null, 'vay-dam', 76, 4.9],
      ['Váy hai dây lụa satin', 'vay', 549000, 720000, 'vay-dam', 121, 4.3],
      ['Áo sơ mi nam oxford', 'ao', 459000, null, 'ao-nam', 205, 4.6],
      ['Áo polo nam pique', 'ao', 349000, 449000, 'ao-nam', 318, 4.5],
      ['Áo blazer nam dáng lửng', 'khoac', 1290000, 1590000, 'ao-nam', 47, 4.8],
      ['Quần jeans ống đứng', 'quan', 599000, 799000, 'quan-nam', 264, 4.4],
      ['Quần short kaki co giãn', 'quan', 289000, null, 'quan-nam', 152, 4.2],
    ],
  },
  {
    slug: 'demo-food', industry: 'food', c1: '#f4faf3', c2: '#dfeedd', ink: '#2c4a2b', accent: '#3f8f4a',
    hero: [['Tươi mỗi sáng, giao trong 2 giờ', 'Nhập từ trang trại, không tồn quá 24 giờ', 'la'],
           ['Rau củ hữu cơ chuẩn VietGAP', 'Có chứng nhận, truy xuất từng lô', 'qua'],
           ['Combo đi chợ cả tuần', 'Tiết kiệm tới 25% so với mua lẻ', 'thit']],
    side: [['Thịt bò Úc giảm 20%', '', 'thit'], ['Freeship nội thành', '', 'la']],
    promo: [['Combo gia đình', '', 'qua'], ['Hải sản tươi sống', '', 'ca'], ['Rau sạch 39K', '', 'la']],
    cats: [
      ['Thịt & hải sản', 'thit-hai-san', ['Thịt tươi|thit-tuoi', 'Hải sản|hai-san']],
      ['Rau củ & trái cây', 'rau-cu-trai-cay', ['Rau lá|rau-la', 'Củ quả|cu-qua']],
    ],
    products: [
      ['Ba chỉ heo rút sườn 500g', 'thit', 89000, 109000, 'thit-tuoi', 1240, 4.6],
      ['Thăn bò Úc nhập khẩu 300g', 'thit', 189000, 245000, 'thit-tuoi', 486, 4.8],
      ['Ức gà phi lê 1kg', 'thit', 79000, null, 'thit-tuoi', 932, 4.5],
      ['Sườn non heo 500g', 'thit', 125000, 149000, 'thit-tuoi', 318, 4.4],
      ['Cá hồi Na Uy phi lê 250g', 'ca', 165000, 199000, 'hai-san', 274, 4.9],
      ['Tôm sú tươi size 20 - 500g', 'ca', 219000, null, 'hai-san', 196, 4.7],
      ['Mực ống làm sạch 500g', 'ca', 145000, 175000, 'hai-san', 143, 4.3],
      ['Cải ngọt hữu cơ 300g', 'la', 19000, 25000, 'rau-la', 2180, 4.6],
      ['Xà lách Romaine 250g', 'la', 25000, null, 'rau-la', 864, 4.5],
      ['Cà chua bi Đà Lạt 500g', 'qua', 32000, 42000, 'cu-qua', 1105, 4.7],
      ['Bơ sáp Đắk Lắk 1kg', 'qua', 68000, 85000, 'cu-qua', 592, 4.8],
      ['Khoai tây Đà Lạt 1kg', 'qua', 28000, null, 'cu-qua', 738, 4.4],
    ],
  },
  {
    slug: 'demo-furniture', industry: 'furniture', c1: '#f5f6f7', c2: '#e2e6ea', ink: '#3a4652', accent: '#d26e4b',
    hero: [['Showroom nội thất Bắc Âu', 'Gỗ tự nhiên, bảo hành khung 10 năm', 'sofa'],
           ['Trọn bộ phòng khách từ 15 triệu', 'Đo đạc và tư vấn tại nhà miễn phí', 'ban'],
           ['Giao lắp tận nơi toàn quốc', 'Kỹ thuật viên lắp đặt trong ngày', 'giuong']],
    side: [['Sofa giảm đến 30%', '', 'sofa'], ['Trả góp 0%', '', 'den']],
    promo: [['Phòng khách', '', 'sofa'], ['Phòng ngủ', '', 'giuong'], ['Bàn ăn', '', 'ban']],
    cats: [
      ['Phòng khách', 'phong-khach', ['Sofa|sofa', 'Bàn & kệ|ban-ke']],
      ['Phòng ngủ', 'phong-ngu', ['Giường ngủ|giuong-ngu', 'Tủ & đèn|tu-den']],
    ],
    products: [
      ['Sofa băng 3 chỗ vải bố', 'sofa', 12900000, 16500000, 'sofa', 34, 4.8],
      ['Sofa góc chữ L bọc nỉ', 'sofa', 18500000, 22900000, 'sofa', 21, 4.9],
      ['Ghế đơn armchair gỗ sồi', 'sofa', 4900000, null, 'sofa', 58, 4.6],
      ['Ghế ăn bọc nệm chân gỗ', 'sofa', 1290000, 1690000, 'sofa', 142, 4.5],
      ['Bàn trà mặt gỗ sồi tự nhiên', 'ban', 3900000, 4900000, 'ban-ke', 76, 4.7],
      ['Kệ tivi 1m8 gỗ công nghiệp', 'ban', 4500000, null, 'ban-ke', 63, 4.4],
      ['Bàn ăn 6 ghế gỗ cao su', 'ban', 9800000, 12500000, 'ban-ke', 29, 4.8],
      ['Kệ sách 5 tầng khung sắt', 'ban', 2290000, null, 'ban-ke', 91, 4.3],
      ['Giường ngủ 1m6 gỗ tự nhiên', 'giuong', 8900000, 11200000, 'giuong-ngu', 45, 4.9],
      ['Giường tầng trẻ em có cầu thang', 'giuong', 7500000, null, 'giuong-ngu', 18, 4.6],
      ['Tủ quần áo 3 cánh cửa lùa', 'den', 9500000, 11900000, 'tu-den', 37, 4.5],
      ['Đèn sàn chao vải minimal', 'den', 1590000, 1990000, 'tu-den', 108, 4.7],
    ],
  },
  {
    slug: 'demo-cosmetics', industry: 'cosmetics', c1: '#fdf5f8', c2: '#f6dde7', ink: '#8a3d5c', accent: '#e0699a',
    hero: [['Son mới ra mắt — 12 tông', 'Chất kem lì, lên màu chuẩn ánh sáng Việt', 'son'],
           ['Mua 2 tặng 1 toàn bộ son', 'Chỉ trong 3 ngày, số lượng có hạn', 'tuyp'],
           ['Chăm da mùa hanh khô', 'Routine 4 bước cho da thường đến khô', 'serum']],
    side: [['Serum giảm 25%', '', 'serum'], ['Quà tặng đơn 499K', '', 'phan']],
    promo: [['Son & môi', '', 'son'], ['Chăm sóc da', '', 'serum'], ['Chống nắng', '', 'tuyp']],
    cats: [
      ['Trang điểm', 'trang-diem', ['Son môi|son-moi', 'Nền & phấn|nen-phan']],
      ['Chăm sóc da', 'cham-soc-da', ['Làm sạch|lam-sach', 'Dưỡng da|duong-da']],
    ],
    products: [
      ['Son kem lì velvet 3.5g', 'son', 189000, 259000, 'son-moi', 3420, 4.7],
      ['Son thỏi satin dưỡng ẩm', 'son', 249000, 320000, 'son-moi', 1860, 4.6],
      ['Son tint bóng căng nước', 'son', 159000, null, 'son-moi', 2140, 4.5],
      ['Son dưỡng có màu SPF15', 'son', 129000, 169000, 'son-moi', 1290, 4.4],
      ['Kem nền che khuyết điểm 30ml', 'tuyp', 349000, 459000, 'nen-phan', 764, 4.6],
      ['Phấn phủ kiềm dầu 8g', 'phan', 289000, null, 'nen-phan', 921, 4.5],
      ['Mascara làm dày mi', 'son', 219000, 279000, 'nen-phan', 634, 4.3],
      ['Chì kẻ mày 2 đầu', 'son', 99000, null, 'nen-phan', 1470, 4.6],
      ['Sữa rửa mặt dịu nhẹ 150ml', 'tuyp', 179000, 229000, 'lam-sach', 1830, 4.8],
      ['Toner cấp ẩm không cồn 300ml', 'serum', 259000, null, 'lam-sach', 1105, 4.7],
      ['Serum vitamin C 10% 30ml', 'serum', 459000, 599000, 'duong-da', 892, 4.9],
      ['Kem chống nắng SPF50+ 50ml', 'tuyp', 329000, 419000, 'duong-da', 1560, 4.8],
    ],
  },
];

// \p{M} = mọi dấu tổ hợp sau NFD. Dùng property escape thay vì dán ký tự dấu
// thô vào nguồn — file này đi qua nhiều lớp mã hoá, ký tự thô rất dễ hỏng.
const slugify = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/gi, 'd')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function wipe(shopId) {
  // CHỐT AN TOÀN: shop có đơn thì dừng. Xoá sản phẩm dưới chân order_lines là
  // phá dữ liệu tiền — thà seed fail còn hơn. Chỉ dùng cho shop demo trống.
  const { rows: o } = await db.query('SELECT count(*)::int n FROM orders WHERE shop_id=$1', [shopId]);
  if (o[0].n > 0) throw new Error(`shop ${shopId} có ${o[0].n} đơn — từ chối wipe`);

  // Thứ tự theo chiều phụ thuộc: mọi bảng trỏ tới variants/products trước,
  // rồi variants, rồi products, rồi categories.
  for (const sql of [
    'DELETE FROM cart_items WHERE shop_id=$1',
    'DELETE FROM carts WHERE shop_id=$1',
    'DELETE FROM wishlist_items WHERE shop_id=$1',
    'DELETE FROM review_images WHERE shop_id=$1',
    'DELETE FROM product_reviews WHERE shop_id=$1',
    'DELETE FROM product_questions WHERE shop_id=$1',
    'DELETE FROM product_specs WHERE shop_id=$1',
    'DELETE FROM product_view_daily WHERE shop_id=$1',
    'DELETE FROM variant_option_values WHERE shop_id=$1',
    'DELETE FROM product_options WHERE shop_id=$1',
    'DELETE FROM variant_costs WHERE shop_id=$1',
    'DELETE FROM inventory_ledger WHERE shop_id=$1',
    'DELETE FROM media WHERE shop_id=$1',
    'DELETE FROM product_categories WHERE shop_id=$1',
    'DELETE FROM promotion_products WHERE shop_id=$1',
    'DELETE FROM promotions WHERE shop_id=$1',
    'DELETE FROM inventory_levels WHERE shop_id=$1',
    'DELETE FROM variants WHERE shop_id=$1',
    'DELETE FROM products WHERE shop_id=$1',
    'DELETE FROM categories WHERE shop_id=$1',
  ]) await db.query(sql, [shopId]);
  // Dọn object cũ để chạy lại nhiều lần không phình bucket.
  const keys = [];
  await new Promise((res, rej) => {
    const st = minio.listObjectsV2(BUCKET, `${shopId}/`, true);
    st.on('data', (o) => keys.push(o.name));
    st.on('end', res); st.on('error', rej);
  });
  if (keys.length) await minio.removeObjects(BUCKET, keys);
}

/**
 * Tạo shop demo nếu chưa có. Cần cho luồng sau khi chạy dev-db-reset.sh: bàn thử
 * giao diện phải dựng lại được bằng MỘT lệnh, không thì reset thành ra phá.
 * Đủ ba thứ để storefront phục vụ được: shops + domains (đã verify) + themes.
 */
async function ensureShop(cfg) {
  const found = (await db.query('SELECT id FROM shops WHERE slug=$1', [cfg.slug])).rows[0];
  if (found) return found.id;

  const name = 'Demo ' + cfg.slug.replace(/^demo-/, '');
  const shopId = (await db.query(
    `INSERT INTO shops (slug, name, status, industry, created_via) VALUES ($1,$2,'active',$3,'staff') RETURNING id`,
    [cfg.slug, name, cfg.industry])).rows[0].id;
  await db.query(
    `INSERT INTO domains (shop_id, hostname, verification_token, verified_at, is_primary)
     VALUES ($1,$2,'dev-demo-seed',now(),true)`,
    [shopId, `${cfg.slug}.nentang.vn`]);
  const preset = PRESETS[cfg.industry];
  await db.query(`INSERT INTO themes (shop_id, tokens, layout) VALUES ($1,$2,$3)`,
    [shopId, JSON.stringify(preset.tokens), JSON.stringify(preset.layout)]);
  console.log(`  + tạo mới shop ${cfg.slug}`);
  return shopId;
}

async function seedShop(cfg) {
  const shopId = await ensureShop(cfg);
  await wipe(shopId);

  // Danh mục 2 cấp — để mega-menu và sidebar cây có gì mà hiện.
  const catId = {};
  let pos = 0;
  for (const [name, slug, children] of cfg.cats) {
    const p = (await db.query(
      `INSERT INTO categories (shop_id, slug, name, position) VALUES ($1,$2,$3,$4) RETURNING id`,
      [shopId, slug, name, pos++])).rows[0].id;
    catId[slug] = p;
    for (const ch of children) {
      const [cname, cslug] = ch.split('|');
      catId[cslug] = (await db.query(
        `INSERT INTO categories (shop_id, slug, name, position, parent_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [shopId, cslug, cname, pos++, p])).rows[0].id;
    }
  }

  // Sản phẩm + biến thể + tồn + ảnh.
  const productIds = [];
  let i = 0;
  for (const [title, shape, price, compareAt, cat, sold, rating] of cfg.products) {
    const pid = (await db.query(
      `INSERT INTO products (shop_id, slug, title, price_vnd, status, description, sold_count, rating_avg, rating_count)
       VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8) RETURNING id`,
      // Hậu tố số: hai tên khác nhau vẫn có thể ra cùng slug (bỏ dấu), mà
      // products có UNIQUE (shop_id, slug) → seed sẽ nổ giữa chừng.
      [shopId, `${slugify(title)}-${i + 1}`, title, price,
       `${title} — hàng có sẵn, đổi trả trong 7 ngày. Mô tả demo phục vụ dựng giao diện.`,
       sold, rating, Math.max(3, Math.round(sold / 12))])).rows[0].id;
    productIds.push(pid);

    const vid = (await db.query(
      `INSERT INTO variants (shop_id, product_id, sku, price_vnd, title, position, weight_gram, compare_at_vnd)
       VALUES ($1,$2,$3,$4,'Mặc định',0,500,$5) RETURNING id`,
      [shopId, pid, `${cfg.slug.toUpperCase()}-${String(++i).padStart(3, '0')}`, price, compareAt])).rows[0].id;
    await db.query(
      `INSERT INTO inventory_levels (shop_id, variant_id, on_hand) VALUES ($1,$2,$3)`,
      [shopId, vid, 20 + (i * 7) % 60]);
    await db.query(
      `INSERT INTO product_categories (shop_id, product_id, category_id) VALUES ($1,$2,$3)`,
      [shopId, pid, catId[cat]]);

    // Hai ảnh/SP: ảnh 2 để thẻ sản phẩm đổi ảnh khi hover (card-img2).
    for (const n of [0, 1]) {
      const key = `${shopId}/${randomUUID()}.webp`;
      // Ảnh 2 ĐẢO TÔNG (nền màu nhấn, nét trắng) để hover đổi ảnh nhìn thấy được.
      // Chỉ lật chiều gradient thì hai ảnh gần như y hệt — hover coi như hỏng.
      await put(key, n === 0
        ? await productTile(shape, cfg.c1, cfg.c2, cfg.ink)
        : await productTile(shape, cfg.accent, cfg.c2, '#ffffff'));
      await db.query(
        `INSERT INTO media (shop_id, product_id, status, original_key, public_key, content_type, width, height, position)
         VALUES ($1,$2,'ready',$3,$4,'image/webp',900,900,$5)`,
        [shopId, pid, `orig/${key}`, key, n]);
    }
  }

  // Banner: hero (carousel) + hero_side (2 ô phải) + promo_banners (3 ô).
  // Key PHẢI khớp BANNER_KEY_RE của theme.js: <shop-uuid>/banner-<uuid>.webp
  const mkBanners = async (list, w, h) => {
    const out = [];
    for (const [headline, sub, shape] of list) {
      const key = `${shopId}/banner-${randomUUID()}.webp`;
      await put(key, await bannerTile(w, h, cfg.c1, cfg.c2, cfg.accent, shape));
      // button_label BẮT BUỘC đi kèm button_link — theo heroBannerInner, thiếu
      // nhãn thì nút CTA im lặng không render (không báo lỗi gì).
      out.push({ image_key: key, headline, sub, button_label: 'Xem ngay', button_link: '/products' });
    }
    return out;
  };
  const heroSlides = await mkBanners(cfg.hero, 1680, 640);
  const sideSlides = await mkBanners(cfg.side, 820, 304);
  const promoSlides = await mkBanners(cfg.promo, 800, 500);

  const layout = (await db.query('SELECT layout FROM themes WHERE shop_id=$1', [shopId])).rows[0]?.layout;
  if (Array.isArray(layout)) {
    for (const s of layout) {
      if (s?.section === 'hero') s.props = { ...s.props, slides: heroSlides };
      if (s?.section === 'hero_side') s.props = { ...s.props, slides: sideSlides };
      if (s?.section === 'promo_banners') s.props = { ...s.props, slides: promoSlides };
    }
    await db.query('UPDATE themes SET layout=$2 WHERE shop_id=$1', [shopId, JSON.stringify(layout)]);
  }

  // Flash sale đang chạy → khối đếm ngược có hàng thật.
  const promoId = (await db.query(
    `INSERT INTO promotions (shop_id, title, kind, value, scope, starts_at, ends_at, active)
     VALUES ($1,$2,'percent',25,'products', now() - interval '1 hour', now() + interval '2 days', true)
     RETURNING id`, [shopId, 'Giờ vàng giá sốc'])).rows[0].id;
  for (const pid of productIds.slice(0, 4)) {
    await db.query(`INSERT INTO promotion_products (shop_id, promotion_id, product_id) VALUES ($1,$2,$3)`,
      [shopId, promoId, pid]);
  }

  console.log(`  ${cfg.slug}: ${cfg.products.length} SP · ${Object.keys(catId).length} danh mục · `
    + `${cfg.products.length * 2 + heroSlides.length + sideSlides.length + promoSlides.length} ảnh · flash sale 4 SP`);
}

await db.connect();
console.log('Seed nội dung demo:');
for (const cfg of SHOPS) await seedShop(cfg);
await db.end();
console.log('Xong.');
