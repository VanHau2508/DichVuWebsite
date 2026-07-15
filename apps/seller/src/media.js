/**
 * Media — ảnh sản phẩm. Ngày 9.
 *
 * Luồng: upload → kiểm MAGIC BYTE (không tin Content-Type) + kích thước → lưu bản
 * gốc vào bucket PRIVATE → re-encode sang WebP (sharp, tự strip metadata) → lưu
 * vào bucket PUBLIC → media.status = ready.
 *
 * Bất biến bảo mật (mỗi cái có test + mutation):
 *   - Kiểm magic byte, KHÔNG tin Content-Type client gửi → chặn file giả dạng ảnh.
 *   - Bản gốc nằm bucket PRIVATE, không truy cập ẩn danh được. Chỉ WebP đã re-encode
 *     mới lên PUBLIC. File chưa xử lý KHÔNG BAO GIỜ public.
 *   - Re-encode strip mọi payload nhúng (một .png có đuôi rác → WebP sạch).
 *   - media cô lập theo shop (RLS).
 *
 * MVP xử lý INLINE trong request. Kiến trúc đích đẩy sang worker + outbox
 * (docs/01 §10); nâng cấp sau, hợp đồng bất biến (bucket private→public) giữ nguyên.
 */

import crypto from 'node:crypto';
import { Client as MinioClient } from 'minio';
import sharp from 'sharp';
import { send } from './http.js';
import { withTenant, audit } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const MAX_UPLOAD = 10 * 1024 * 1024; // 10MB
// Bucket private + client MinIO dùng lại cho export (A4) — CHỈ một nguồn cấu hình.
export const BUCKET_PRIVATE = process.env.MEDIA_BUCKET_PRIVATE ?? 'media-private';
const BUCKET_PUBLIC = process.env.MEDIA_BUCKET_PUBLIC ?? 'media-public';
const PUBLIC_BASE = process.env.MEDIA_PUBLIC_BASE ?? '/media-public';

export const minio = new MinioClient({
  endPoint: process.env.MINIO_ENDPOINT ?? 'minio',
  port: Number(process.env.MINIO_PORT ?? 9000),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY ?? 'minioadmin',
});

/** Chạy một lần lúc khởi động: tạo bucket, đặt bucket public cho phép đọc ẩn danh. */
export async function initMedia() {
  for (const b of [BUCKET_PRIVATE, BUCKET_PUBLIC]) {
    if (!(await minio.bucketExists(b))) await minio.makeBucket(b);
  }
  // CHỈ bucket public cho phép GET ẩn danh. Bucket private KHÔNG có policy nào →
  // truy cập ẩn danh bị từ chối. Đây là ranh giới "chưa xử lý = không public".
  await minio.setBucketPolicy(
    BUCKET_PUBLIC,
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: ['*'] },
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${BUCKET_PUBLIC}/*`],
        },
      ],
    }),
  );
  // Bản xuất dữ liệu (A4) nằm bucket PRIVATE dưới prefix exports/ — chứa PII. Lifecycle
  // tự XOÁ sau 1 ngày để KHÔNG lưu PII vô hạn (link tải chỉ sống 15'; đây là dọn kho).
  // CHỈ prefix exports/ — ảnh gốc (prefix staging/) KHÔNG bị đụng. Non-fatal nếu MinIO
  // chưa hỗ trợ lifecycle (log cảnh báo, không chặn khởi động).
  try {
    await minio.setBucketLifecycle(BUCKET_PRIVATE, {
      Rule: [{ ID: 'expire-exports', Status: 'Enabled', Filter: { Prefix: 'exports/' }, Expiration: { Days: 1 } }],
    });
  } catch (e) {
    process.stderr.write(JSON.stringify({ level: 'warn', event: 'export_lifecycle_failed', message: e.message }) + '\n');
  }
}

/**
 * Phát hiện kiểu ảnh THẬT từ magic byte. Trả kiểu MIME hoặc null nếu không phải
 * ảnh được hỗ trợ. KHÔNG dùng Content-Type do client gửi — nó nói dối được.
 */
export function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.slice(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  return null;
}

async function uploadMedia(res, ctx, body, params) {
  const productId = params[1];
  const buf = body; // Buffer thô (dispatcher đọc bằng readBuffer khi route.raw)

  if (!Buffer.isBuffer(buf) || buf.length === 0) return send(res, 400, { error: 'thiếu dữ liệu ảnh' });
  const detected = sniffImage(buf);
  if (!detected) return send(res, 400, { error: 'không phải ảnh hợp lệ (JPEG/PNG/WebP/GIF)' });

  const mediaId = crypto.randomUUID();
  const originalKey = `staging/${ctx.shopId}/${mediaId}`;
  const publicKey = `${ctx.shopId}/${mediaId}.webp`;

  // 1) Bản gốc → bucket PRIVATE. Ghi media row pending.
  //    Kiểm sản phẩm tồn tại (composite FK cũng chặn, nhưng báo 404 rõ hơn).
  const setup = await withTenant(ctx.shopId, async (c) => {
    const p = await c.query(`SELECT 1 FROM products WHERE id = $1 AND deleted_at IS NULL`, [productId]);
    if (p.rows.length === 0) return null;
    // Ảnh mới nối vào CUỐI (position = max+1) → không giành chỗ ảnh đại diện hiện có.
    const pos = (await c.query(`SELECT coalesce(max(position), -1) + 1 AS p FROM media WHERE product_id = $1 AND deleted_at IS NULL`, [productId])).rows[0].p;
    await c.query(
      `INSERT INTO media (id, shop_id, product_id, status, original_key, content_type, size_bytes, position)
       VALUES ($1, current_shop_id(), $2, 'pending', $3, $4, $5, $6)`,
      [mediaId, productId, originalKey, detected, buf.length, pos],
    );
    return true;
  });
  if (!setup) return send(res, 404, { error: 'không tìm thấy sản phẩm' });

  await minio.putObject(BUCKET_PRIVATE, originalKey, buf, buf.length, { 'Content-Type': detected });

  // 2) Re-encode → WebP. sharp mặc định strip metadata; .rotate() áp EXIF rồi bỏ.
  //    Bước này biến mọi file "ảnh + payload nhúng" thành ảnh sạch.
  try {
    const { data, info } = await sharp(buf)
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });

    // 3) WebP → bucket PUBLIC. Chỉ tới đây file mới public.
    await minio.putObject(BUCKET_PUBLIC, publicKey, data, data.length, { 'Content-Type': 'image/webp' });

    await withTenant(ctx.shopId, async (c) => {
      await c.query(
        `UPDATE media SET status = 'ready', public_key = $1, width = $2, height = $3 WHERE id = $4`,
        [publicKey, info.width, info.height, mediaId],
      );
      await audit(c, 'media.uploaded', { actorId: ctx.user.id, ip: ctx.ip, metadata: { mediaId, productId } });
    });
    return send(res, 201, { id: mediaId, url: `${PUBLIC_BASE}/${publicKey}`, width: info.width, height: info.height });
  } catch (err) {
    await withTenant(ctx.shopId, (c) => c.query(`UPDATE media SET status = 'failed' WHERE id = $1`, [mediaId])).catch(() => {});
    return send(res, 422, { error: 'xử lý ảnh thất bại' });
  }
}

// URL công khai từ key (dùng chung; getShop build logo_url tránh phụ thuộc env ở BFF).
export const mediaPublicUrl = (key) => (key ? `${PUBLIC_BASE}/${key}` : null);

// Logo cửa hàng: media CẤP-SHOP. Cùng bất biến bảo mật ảnh sản phẩm (sniff magic byte,
// re-encode WebP strip payload, chỉ WebP lên PUBLIC). Không giữ bản gốc (logo chỉ branding).
// Thay logo cũ thì xoá object cũ. Perm 'shop.write' (owner/admin) — khai ở route.
async function uploadLogo(res, ctx, body) {
  const buf = body;
  if (!Buffer.isBuffer(buf) || buf.length === 0) return send(res, 400, { error: 'thiếu dữ liệu ảnh' });
  if (!sniffImage(buf)) return send(res, 400, { error: 'không phải ảnh hợp lệ (JPEG/PNG/WebP/GIF)' });
  const publicKey = `${ctx.shopId}/logo-${crypto.randomUUID()}.webp`;
  try {
    const { data } = await sharp(buf).rotate()
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 88 }).toBuffer({ resolveWithObject: true });
    await minio.putObject(BUCKET_PUBLIC, publicKey, data, data.length, { 'Content-Type': 'image/webp' });
  } catch { return send(res, 422, { error: 'xử lý ảnh thất bại' }); }
  const old = await withTenant(ctx.shopId, async (c) => {
    const prev = (await c.query(`SELECT logo_key FROM shops WHERE id = current_shop_id()`)).rows[0]?.logo_key ?? null;
    await c.query(`UPDATE shops SET logo_key = $1 WHERE id = current_shop_id()`, [publicKey]);
    await audit(c, 'shop.logo_updated', { actorId: ctx.user.id, ip: ctx.ip, metadata: {} });
    return prev;
  });
  if (old && old !== publicKey) await minio.removeObject(BUCKET_PUBLIC, old).catch(() => {});
  return send(res, 200, { ok: true, logo_key: publicKey, url: mediaPublicUrl(publicKey) });
}
async function deleteLogo(res, ctx) {
  const old = await withTenant(ctx.shopId, async (c) => {
    const prev = (await c.query(`SELECT logo_key FROM shops WHERE id = current_shop_id()`)).rows[0]?.logo_key ?? null;
    await c.query(`UPDATE shops SET logo_key = NULL WHERE id = current_shop_id()`);
    await audit(c, 'shop.logo_removed', { actorId: ctx.user.id, ip: ctx.ip, metadata: {} });
    return prev;
  });
  if (old) await minio.removeObject(BUCKET_PUBLIC, old).catch(() => {});
  return send(res, 200, { ok: true });
}

async function listMedia(res, ctx, _body, params) {
  const productId = params[1];
  const rows = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(
      `SELECT id, status, public_key, width, height, position, created_at
         FROM media WHERE product_id = $1 AND deleted_at IS NULL ORDER BY position, created_at`,
      [productId],
    );
    return r.rows;
  });
  return send(res, 200, {
    media: rows.map((m) => ({ ...m, url: m.public_key ? `${PUBLIC_BASE}/${m.public_key}` : null })),
  });
}

async function deleteMedia(res, ctx, _body, params) {
  const mediaId = params[1];
  const row = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(
      `UPDATE media SET deleted_at = now()
        WHERE id = $1 AND deleted_at IS NULL RETURNING original_key, public_key`,
      [mediaId],
    );
    if (r.rows.length === 0) return null;
    await audit(c, 'media.deleted', { actorId: ctx.user.id, ip: ctx.ip, metadata: { mediaId } });
    return r.rows[0];
  });
  if (!row) return send(res, 404, { error: 'không tìm thấy media' });
  // Best-effort xoá object (soft-delete row là nguồn sự thật).
  await minio.removeObject(BUCKET_PRIVATE, row.original_key).catch(() => {});
  if (row.public_key) await minio.removeObject(BUCKET_PUBLIC, row.public_key).catch(() => {});
  return send(res, 200, { ok: true });
}

// Kết quả sắp thứ tự ảnh (kéo–thả / đặt ảnh đại diện): order PHẢI là hoán vị đúng
// của tập id ảnh hiện có (đủ số, đủ tập, không lặp) → không lén thêm/bớt qua reorder.
async function reorderMedia(res, ctx, body, params) {
  const productId = params[1];
  const order = body.order;
  if (!Array.isArray(order) || order.some((x) => typeof x !== 'string')) return send(res, 400, { error: 'order phải là mảng id' });
  const out = await withTenant(ctx.shopId, async (c) => {
    // FOR UPDATE: hai reorder đồng thời không giẫm nhau.
    const rows = (await c.query(`SELECT id FROM media WHERE product_id = $1 AND deleted_at IS NULL ORDER BY position, created_at FOR UPDATE`, [productId])).rows;
    const ids = new Set(rows.map((r) => r.id));
    if (order.length !== rows.length || new Set(order).size !== order.length || order.some((id) => !ids.has(id))) return { code: 422 };
    for (let i = 0; i < order.length; i++) {
      await c.query(`UPDATE media SET position = $1 WHERE id = $2 AND product_id = $3`, [i, order[i], productId]);
    }
    await audit(c, 'media.reordered', { actorId: ctx.user.id, ip: ctx.ip, metadata: { productId } });
    return { code: 200 };
  });
  if (out.code === 422) return send(res, 422, { error: 'order phải là hoán vị đúng của ảnh hiện có' });
  return send(res, 200, { ok: true });
}

export const MEDIA_ROUTES = [
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/products/${UUID}/media$`), perm: 'catalog.write', raw: true, fn: (res, ctx, b, p) => uploadMedia(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/products/${UUID}/media/reorder$`), perm: 'catalog.write', fn: (res, ctx, b, p) => reorderMedia(res, ctx, b, p) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/products/${UUID}/media$`), perm: 'catalog.read', fn: (res, ctx, b, p) => listMedia(res, ctx, b, p) },
  { m: 'DELETE', re: new RegExp(`^/shops/${UUID}/media/${UUID}$`), perm: 'catalog.write', fn: (res, ctx, b, p) => deleteMedia(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/logo$`), perm: 'shop.write', raw: true, fn: (res, ctx, b) => uploadLogo(res, ctx, b) },
  { m: 'DELETE', re: new RegExp(`^/shops/${UUID}/logo$`), perm: 'shop.write', fn: (res, ctx) => deleteLogo(res, ctx) },
];
