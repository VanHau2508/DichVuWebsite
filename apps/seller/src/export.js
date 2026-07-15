/**
 * Xuất dữ liệu (A4) — owner tải toàn bộ dữ liệu shop dạng ZIP nhiều CSV.
 *
 * Gate (khai báo ở route, dispatcher server.js cưỡng chế): perm 'export' (CHỈ owner có)
 * + stepUp (xác thực lại <5'). Tạo bản xuất: chạy các SELECT RLS-scoped (app_rw thấy
 * đúng một shop) → CSV (RFC 4180 + BOM UTF-8 + chống formula injection) → ZIP zero-dep
 * → lưu bucket PRIVATE → ghi export_artifacts (token hash + TTL) + audit → trả token.
 * Tải: GET với token → RLS lọc shop + hết hạn → getObject stream ZIP (đi qua seller đã
 * xác thực; KHÔNG lộ MinIO ra ngoài).
 *
 * KHÔNG xuất bí mật: lookup_token_hash (mã tra đơn của khách), token_hash, original_key.
 */
import crypto from 'node:crypto';
import { withTenant, audit } from './db.js';
import { minio, BUCKET_PRIVATE } from './media.js';
import { buildZip } from './zip.js';
import { send } from './http.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const EXPORT_TTL_MIN = 15;
// Trần tổng dòng: chặn OOM + giới hạn chuỗi V8 (~536M ký tự) + thời gian nén cho shop
// khổng lồ. Vượt trần → 413 (shop lớn cần xuất bất đồng bộ — ngoài phạm vi MVP).
const EXPORT_MAX_ROWS = Number(process.env.EXPORT_MAX_ROWS ?? 200000);
const PUBLIC_BASE = process.env.MEDIA_PUBLIC_BASE ?? '/media-public';
const genToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

// ── CSV: RFC 4180 + BOM UTF-8 (Excel đọc đúng tiếng Việt) + chống formula injection ──
const BOM = '﻿';
function csvCell(v) {
  if (v === null || v === undefined) return '';
  // Date (pg trả timestamptz thành Date) → ISO-8601: máy đọc được, KHÔNG phụ thuộc
  // timezone container (String(Date) cho chuỗi dài, giờ địa phương, không tất định).
  let s = v instanceof Date ? v.toISOString() : String(v);
  // Excel/Sheets THỰC THI ô bắt đầu bằng = + - @ TAB CR LF (bỏ khoảng trắng đầu rồi
  // thấy =) → chèn ' để vô hiệu (dữ liệu người bán/khách nhập = không tin được).
  if (/^[=+\-@\t\r\n]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}
function toCsv(headers, rows) {
  const out = [headers.join(',')];
  for (const r of rows) out.push(headers.map((h) => csvCell(r[h])).join(','));
  return BOM + out.join('\r\n') + '\r\n';
}
const buf = (s) => Buffer.from(s, 'utf8');

// getObject trả stream → gom về Buffer (không có tiền lệ streaming, cả app buffer toàn bộ).
function getObjectBuffer(bucket, key) {
  return new Promise((resolve, reject) => {
    minio.getObject(bucket, key)
      .then((stream) => {
        const chunks = [];
        stream.on('data', (d) => chunks.push(d));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
      })
      .catch(reject);
  });
}

// ── xây ZIP từ các SELECT RLS-scoped (client `c` đã set app.shop_id) ─────────────
async function buildExport(c) {
  // Trần dòng: đếm trước (RLS scope theo shop) → vượt thì từ chối, KHÔNG dựng gì (chống
  // OOM / block event loop / vượt giới hạn chuỗi V8).
  const total = Number((await c.query(
    `SELECT (SELECT count(*) FROM products) + (SELECT count(*) FROM variants)
          + (SELECT count(*) FROM orders) + (SELECT count(*) FROM order_lines)
          + (SELECT count(*) FROM media) AS n`)).rows[0].n);
  if (total > EXPORT_MAX_ROWS) {
    throw Object.assign(new Error(`dữ liệu quá lớn để xuất trực tiếp (${total} dòng > ${EXPORT_MAX_ROWS}). Vui lòng liên hệ hỗ trợ.`), { statusCode: 413 });
  }
  const products = (await c.query(
    `SELECT id, slug, title, price_vnd, status, created_at, description
       FROM products WHERE deleted_at IS NULL ORDER BY created_at`)).rows;
  const variants = (await c.query(
    `SELECT v.id, v.product_id, v.sku, v.title, v.price_vnd, v.position, il.on_hand, il.reserved
       FROM variants v LEFT JOIN inventory_levels il ON il.variant_id = v.id
      ORDER BY v.product_id, v.position`)).rows;
  const orders = (await c.query(
    `SELECT order_number, status, payment_status, payment_method,
            subtotal_vnd, shipping_vnd, discount_vnd, total_vnd,
            customer_name, customer_phone, customer_email, shipping_address, payment_ref,
            created_at, paid_at, shipped_at, delivered_at, cancelled_at
       FROM orders ORDER BY order_number`)).rows;
  const lines = (await c.query(
    `SELECT o.order_number, l.title_snapshot, l.sku_snapshot, l.unit_price_vnd, l.qty
       FROM order_lines l JOIN orders o ON o.id = l.order_id
      ORDER BY o.order_number`)).rows;
  const customers = (await c.query(
    `SELECT customer_name, customer_phone, customer_email,
            count(*)::int AS order_count,
            coalesce(sum(total_vnd) FILTER (WHERE payment_status = 'paid'), 0)::bigint AS paid_total_vnd,
            max(created_at) AS last_order_at
       FROM orders WHERE customer_phone IS NOT NULL OR customer_email IS NOT NULL
      GROUP BY customer_name, customer_phone, customer_email
      ORDER BY paid_total_vnd DESC`)).rows;
  const media = (await c.query(
    `SELECT product_id, id AS media_id, public_key, position, status, width, height, created_at
       FROM media WHERE deleted_at IS NULL ORDER BY product_id, position, created_at`)).rows;

  // shipping_address là jsonb → giữ TRỌN VẸN: object → JSON đầy đủ (không rớt
  // ward/district/note…, không thành "[object Object]"); string → nguyên văn.
  for (const o of orders) {
    const a = o.shipping_address;
    o.shipping_address = a == null ? '' : (typeof a === 'string' ? a : JSON.stringify(a));
  }
  // manifest ảnh: chỉ URL public (ảnh ready), KHÔNG kèm file ảnh.
  for (const m of media) m.public_url = m.public_key ? `${PUBLIC_BASE}/${m.public_key}` : '';

  const entries = [
    { name: 'products.csv', data: buf(toCsv(['id', 'slug', 'title', 'price_vnd', 'status', 'created_at', 'description'], products)) },
    { name: 'variants.csv', data: buf(toCsv(['id', 'product_id', 'sku', 'title', 'price_vnd', 'position', 'on_hand', 'reserved'], variants)) },
    { name: 'orders.csv', data: buf(toCsv(['order_number', 'status', 'payment_status', 'payment_method', 'subtotal_vnd', 'shipping_vnd', 'discount_vnd', 'total_vnd', 'customer_name', 'customer_phone', 'customer_email', 'shipping_address', 'payment_ref', 'created_at', 'paid_at', 'shipped_at', 'delivered_at', 'cancelled_at'], orders)) },
    { name: 'order_lines.csv', data: buf(toCsv(['order_number', 'title_snapshot', 'sku_snapshot', 'unit_price_vnd', 'qty'], lines)) },
    { name: 'customers.csv', data: buf(toCsv(['customer_name', 'customer_phone', 'customer_email', 'order_count', 'paid_total_vnd', 'last_order_at'], customers)) },
    { name: 'media_manifest.csv', data: buf(toCsv(['product_id', 'media_id', 'public_url', 'position', 'status', 'width', 'height', 'created_at'], media)) },
    { name: 'README.txt', data: buf([
      'Ban xuat du lieu nen tang.',
      'Gom: products, variants (kem ton kho), orders, order_lines, customers (suy tu don), media_manifest.',
      'Tien te: VND (so nguyen, khong thap phan). Thoi gian: ISO-8601 UTC. Anh: chi manifest URL, khong kem file anh.',
      'customers.csv la BANG SUY RA tu orders (khong co bang khach rieng): gom theo (ten, dien thoai, email);',
      'khach dat luc chua nhap email co the tach thanh nhieu dong. paid_total_vnd chi tinh don da THANH TOAN.',
      '',
    ].join('\n')) },
  ];
  return {
    zip: await buildZip(entries),
    counts: { products: products.length, variants: variants.length, orders: orders.length, order_lines: lines.length, customers: customers.length, media: media.length },
  };
}

// POST /shops/:id/export — tạo bản xuất, trả token (một lần) + hạn.
async function createExport(res, ctx) {
  const token = genToken();
  const th = hashToken(token);
  const artifactId = crypto.randomUUID();
  const key = `exports/${ctx.shopId}/${artifactId}.zip`;
  const out = await withTenant(ctx.shopId, async (c) => {
    // Chặn lạm dụng: tối đa 3 bản xuất/phút/shop (mỗi bản quét toàn bảng + nén). RLS
    // export_read chỉ thấy bản chưa hết hạn → đếm gần đây là chính xác cho cửa sổ này.
    const recent = (await c.query(`SELECT count(*)::int n FROM export_artifacts WHERE created_at > now() - interval '1 minute'`)).rows[0].n;
    if (recent >= 3) throw Object.assign(new Error('Quá nhiều lần xuất, vui lòng đợi một phút.'), { statusCode: 429 });
    const { zip, counts } = await buildExport(c);
    // Lưu ZIP vào bucket PRIVATE (không policy công khai → không đọc ẩn danh).
    await minio.putObject(BUCKET_PRIVATE, key, zip, zip.length, { 'Content-Type': 'application/zip' });
    await c.query(
      `INSERT INTO export_artifacts (id, shop_id, token_hash, storage_key, created_by, expires_at)
       VALUES ($1, current_shop_id(), $2, $3, $4, now() + ($5 || ' minutes')::interval)`,
      [artifactId, th, key, ctx.user.id, String(EXPORT_TTL_MIN)],
    );
    await audit(c, 'export.created', { actorId: ctx.user.id, ip: ctx.ip, metadata: { counts, bytes: zip.length } });
    return { counts, bytes: zip.length };
  });
  return send(res, 200, { token, expires_in: EXPORT_TTL_MIN * 60, counts: out.counts, bytes: out.bytes });
}

// GET /shops/:id/export/download?token= — tải ZIP (owner + token còn hạn). Ghi raw bytes.
async function downloadExport(res, ctx, _body, _params, searchParams) {
  const token = String(searchParams.get('token') ?? '');
  if (!token) return send(res, 400, { error: 'thiếu token' });
  const th = hashToken(token);
  // RLS export_read đã lọc shop_id + expires_at > now() → khác shop / hết hạn = vô hình.
  const row = await withTenant(ctx.shopId, async (c) =>
    (await c.query('SELECT storage_key FROM export_artifacts WHERE token_hash = $1', [th])).rows[0]);
  if (!row) return send(res, 404, { error: 'link không hợp lệ hoặc đã hết hạn' });
  let zip;
  try {
    zip = await getObjectBuffer(BUCKET_PRIVATE, row.storage_key);
  } catch {
    return send(res, 404, { error: 'không tìm thấy tệp' });
  }
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': 'attachment; filename="nentang-export.zip"',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(zip);
}

export const EXPORT_ROUTES = [
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/export$`), perm: 'export', stepUp: true, fn: (res, ctx) => createExport(res, ctx) },
  // Tải: token LÀ năng lực; step-up đã làm lúc tạo. Vẫn perm 'export' → CHỈ owner tải.
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/export/download$`), perm: 'export', fn: (res, ctx, b, p, q) => downloadExport(res, ctx, b, p, q) },
];
