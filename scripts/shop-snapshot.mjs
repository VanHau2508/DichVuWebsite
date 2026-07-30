/**
 * Chụp / khôi phục MỘT shop dev — chạy qua scripts/shop-snapshot.sh.
 *
 * Vì sao có: dev-db-reset.sh xoá sạch, mà có shop là BÀN THAM CHIẾU THIẾT KẾ
 * (nha-xinh: bố cục M.O.I chủ shop đang lấy làm chuẩn) — dựng lại bằng tay thì
 * không ai làm, nên reset sẽ không bao giờ được chạy và dữ liệu lại phình.
 *
 * GIỮ: shop, tên miền, theme, danh mục, sản phẩm + biến thể + tồn + tuỳ chọn,
 *      khuyến mãi, và TOÀN BỘ object ảnh trong MinIO.
 * KHÔNG GIỮ: đơn hàng và mọi thứ treo dưới nó (order_lines, shipments, thanh
 *      toán, hoàn tiền, sổ cái, giỏ, khách). Cố ý — khôi phục MỘT NỬA đường tiền
 *      còn tệ hơn không khôi phục: shop trông bình thường nhưng sổ sách rỗng
 *      ruột, và mọi phép đo sau đó đều sai mà không báo.
 *
 * Giữ NGUYÊN UUID cũ. Bắt buộc: khoá ảnh trong MinIO là `<shop-uuid>/<uuid>.webp`
 * và nằm cứng trong themes.layout — sinh id mới là ảnh mồ côi hết.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import * as Minio from 'minio';

const MODE = process.argv[2];            // 'dump' | 'restore'
const SLUG = process.argv[3];
// /tmp chứ không /app: container seller chạy user không-root, /app chỉ đọc.
const DIR = process.argv[4] ?? '/tmp/snap';

const db = new pg.Client({ connectionString: process.env.SEED_DATABASE_URL });
const minio = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT, port: Number(process.env.MINIO_PORT), useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY, secretKey: process.env.MINIO_SECRET_KEY,
});
const BUCKET = process.env.MEDIA_BUCKET_PUBLIC ?? 'media-public';

// THỨ TỰ QUAN TRỌNG: chèn theo chiều phụ thuộc. categories có self-FK
// (categories_parent_fk) nên trong bảng đó còn phải xếp cha trước con — xử lý riêng.
//
// `option_values` nằm giữa product_options và variant_option_values. Bản đầu tôi
// QUÊN nó và chế độ `dry` bắt được: variant_option_values FK sang option_values,
// tức bản chụp trông đầy đủ nhưng khôi phục sẽ đổ — và chỉ lộ ra SAU khi DB đã bị
// xoá. Đây là lý do tồn tại của chế độ tổng duyệt.
const TABLES = [
  'domains', 'themes', 'shop_counters', 'subscriptions',
  'shop_payment_config', 'shop_shipping_config',
  'categories', 'products', 'product_options', 'option_values',
  'variants', 'variant_option_values', 'inventory_levels',
  'product_categories', 'product_specs',
  'promotions', 'promotion_products', 'coupons',
  'media', 'blog_posts', 'pages', 'page_revisions',
];

// CỐ Ý KHÔNG chụp — đường tiền, vận hành và danh tính:
//   orders/order_lines/shipments/payment_transactions/refunds/returns/cod_remittances/
//   unmatched_transfers/carts/customers*/loyalty_*/inventory_ledger/variant_costs/
//   purchase_orders*/stocktakes*/audit_logs/outbox/memberships/support_tickets/
//   product_reviews/review_*/product_questions/wishlist_items/product_view_daily
// Khôi phục MỘT NỬA đường tiền tệ hơn không khôi phục: shop trông bình thường
// nhưng sổ sách rỗng ruột, và mọi phép đo sau đó sai mà không báo. Đây là bàn
// THAM CHIẾU THIẾT KẾ, không phải bản sao lưu doanh nghiệp.

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));

async function dump() {
  const shop = (await db.query('SELECT * FROM shops WHERE slug=$1', [SLUG])).rows[0];
  if (!shop) throw new Error(`không có shop ${SLUG}`);
  fs.mkdirSync(path.join(DIR, 'media'), { recursive: true });
  fs.writeFileSync(path.join(DIR, 'shops.json'), JSON.stringify([shop]));

  let total = 0;
  for (const t of TABLES) {
    // Sắp cha trước con cho categories; các bảng khác không có self-FK.
    const order = t === 'categories' ? ' ORDER BY parent_id NULLS FIRST' : '';
    const rows = (await db.query(`SELECT * FROM ${t} WHERE shop_id=$1${order}`, [shop.id])).rows;
    fs.writeFileSync(path.join(DIR, `${t}.json`), JSON.stringify(rows));
    total += rows.length;
    if (rows.length) console.log(`  ${t}: ${rows.length}`);
  }

  // Object ảnh: lấy TẤT CẢ dưới tiền tố shop (kể cả banner) chứ không chỉ khoá
  // có trong bảng media — banner nằm trong themes.layout, không có dòng media.
  const keys = [];
  await new Promise((res, rej) => {
    const st = minio.listObjectsV2(BUCKET, `${shop.id}/`, true);
    st.on('data', (o) => keys.push(o.name)); st.on('end', res); st.on('error', rej);
  });
  for (const k of keys) {
    const buf = await new Promise((res, rej) => {
      minio.getObject(BUCKET, k, (e, s) => {
        if (e) return rej(e);
        const c = []; s.on('data', (d) => c.push(d)); s.on('end', () => res(Buffer.concat(c))); s.on('error', rej);
      });
    });
    // Khoá có '/' → làm phẳng tên tệp, ghi lại bản đồ để khôi phục đúng khoá gốc.
    fs.writeFileSync(path.join(DIR, 'media', k.replace(/\//g, '__')), buf);
  }
  fs.writeFileSync(path.join(DIR, 'objects.json'), JSON.stringify(keys));
  console.log(`  object MinIO: ${keys.length}`);
  console.log(`Đã chụp ${SLUG}: ${total} dòng + ${keys.length} ảnh.`);
}

/**
 * TỔNG DUYỆT (dry): chạy CHÍNH dữ liệu trong bản chụp qua ĐÚNG các lệnh INSERT
 * thật, trong một transaction rồi ROLLBACK. Bắt được lệch kiểu / thiếu cột / sai
 * thứ tự FK mà không đụng gì tới dữ liệu đang sống.
 *
 * Có vì diễn tập khôi phục THẬT phải xoá shop, mà xoá shop thì phải xoá cả đơn
 * hàng — cái giá không đáng cho một phép kiểm. Tổng duyệt phủ 13 bảng phụ thuộc
 * (đúng phần rủi ro); dòng `shops` được diễn tập thật ở một shop dựng-lại-được.
 */
async function dryRun() {
  const shop = readJson('shops.json')[0];
  await db.query('BEGIN');
  try {
    // Dọn bản đang sống TRONG transaction để không đụng khoá trùng. Không đoán
    // thứ tự phụ thuộc: lấy MỌI bảng có cột shop_id rồi xoá lặp tới ĐIỂM BẤT ĐỘNG,
    // nuốt lỗi FK bằng savepoint. Đoán thứ tự là cách chắc chắn sai — lần đầu tôi
    // đã quên inventory_ledger, và danh sách đó chỉ dài thêm theo mỗi migration.
    const tabs = (await db.query(
      `SELECT table_name FROM information_schema.columns
       WHERE column_name='shop_id' AND table_schema='public' AND table_name <> 'shops'`)).rows.map((r) => r.table_name);
    for (let pass = 0; pass < 8; pass++) {
      let stuck = 0;
      for (const t of tabs) {
        await db.query('SAVEPOINT sp');
        try { await db.query(`DELETE FROM ${t} WHERE shop_id=$1`, [shop.id]); await db.query('RELEASE SAVEPOINT sp'); }
        catch { await db.query('ROLLBACK TO SAVEPOINT sp'); stuck++; }
      }
      if (stuck === 0) break;
      if (pass === 7) throw new Error(`còn ${stuck} bảng không xoá được — vòng phụ thuộc?`);
    }
    for (const t of TABLES) await insertRows(t, readJson(`${t}.json`), true);
    await linkPagePointers();
    console.log('Tổng duyệt ĐẠT — mọi dòng chèn được vào lược đồ hiện tại.');
  } finally {
    await db.query('ROLLBACK');
  }
}

/**
 * VÒNG PHỤ THUỘC pages ↔ page_revisions: pages.published_revision_id trỏ sang
 * page_revisions, còn page_revisions.page_id trỏ ngược lại. Không có thứ tự chèn
 * nào thoả cả hai. Lối kinh điển: chèn pages với con trỏ NULL, chèn revisions,
 * rồi UPDATE gắn con trỏ lại.
 */
const pendingPagePtr = [];

async function insertRows(t, rows, quiet = false) {
  for (const row of rows) {
    let r = row;
    if (t === 'pages' && r.published_revision_id) {
      pendingPagePtr.push([r.id, r.published_revision_id, r.shop_id]);
      r = { ...r, published_revision_id: null };
    }
    const cols = Object.keys(r);
    const ph = cols.map((_, i) => `$${i + 1}`).join(',');
    // Đọc cột từ CHÍNH dòng dữ liệu (không cắm cứng danh sách) → thêm/bớt cột ở
    // migration sau này không làm hỏng bộ khôi phục.
    // jsonb: node-pg ép object thành chuỗi Postgres literal nếu không stringify.
    const vals = cols.map((c) => (r[c] !== null && typeof r[c] === 'object' && !(r[c] instanceof Date)
      ? JSON.stringify(r[c]) : r[c]));
    await db.query(`INSERT INTO ${t} (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${ph})`, vals);
  }
  if (rows.length && !quiet) console.log(`  ${t}: ${rows.length}`);
}


/** Gắn lại con trỏ published_revision_id sau khi page_revisions đã có mặt. */
async function linkPagePointers() {
  for (const [id, rev, shop] of pendingPagePtr) {
    await db.query('UPDATE pages SET published_revision_id=$2 WHERE id=$1 AND shop_id=$3', [id, rev, shop]);
  }
  pendingPagePtr.length = 0;
}

async function restore() {
  const shop = readJson('shops.json')[0];
  const existing = (await db.query('SELECT id FROM shops WHERE id=$1 OR slug=$2', [shop.id, shop.slug])).rows[0];
  if (existing) throw new Error(`shop ${shop.slug} ĐÃ tồn tại — xoá trước rồi hãy khôi phục`);

  await insertRows('shops', [shop]);
  for (const t of TABLES) await insertRows(t, readJson(`${t}.json`));
  await linkPagePointers();

  const keys = readJson('objects.json');
  for (const k of keys) {
    const buf = fs.readFileSync(path.join(DIR, 'media', k.replace(/\//g, '__')));
    await minio.putObject(BUCKET, k, buf, buf.length, { 'Content-Type': 'image/webp' });
  }
  console.log(`  object MinIO: ${keys.length}`);
  console.log(`Đã khôi phục ${shop.slug}.`);
}

await db.connect();
if (MODE === 'dump') await dump();
else if (MODE === 'restore') await restore();
else if (MODE === 'dry') await dryRun();
else throw new Error('dùng: dump|restore|dry <slug>');
await db.end();
