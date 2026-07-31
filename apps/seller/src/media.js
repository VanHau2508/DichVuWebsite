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
export const BUCKET_PUBLIC = process.env.MEDIA_BUCKET_PUBLIC ?? 'media-public';
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

/**
 * LÕI lưu ảnh sản phẩm — tách khỏi tầng HTTP để bộ NHẬP DANH MỤC (import.js) dùng lại ĐÚNG
 * đường ống này thay vì nhân bản nó. Nhân bản đường ống bảo mật (sniff magic byte → bản gốc
 * vào bucket PRIVATE → re-encode WebP strip metadata → mới sang bucket PUBLIC) là kiểu trùng
 * lặp chắc chắn trôi lệch: vá một bên, quên bên kia.
 *
 * Trả { id, url, width, height } khi xong; ném Error có .reason khi hỏng. KHÔNG chạm res.
 */
export async function storeProductImage(ctx, productId, buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw Object.assign(new Error('empty'), { reason: 'empty' });
  const detected = sniffImage(buf);
  if (!detected) throw Object.assign(new Error('not_image'), { reason: 'not_image' });

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
  if (!setup) throw Object.assign(new Error('no_product'), { reason: 'no_product' });

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
    return { id: mediaId, url: `${PUBLIC_BASE}/${publicKey}`, width: info.width, height: info.height };
  } catch (err) {
    await withTenant(ctx.shopId, (c) => c.query(`UPDATE media SET status = 'failed' WHERE id = $1`, [mediaId])).catch(() => {});
    throw Object.assign(new Error('encode_failed'), { reason: 'encode_failed' });
  }
}

// Vỏ HTTP mỏng quanh lõi trên — giữ nguyên hợp đồng mã trạng thái của endpoint upload.
async function uploadMedia(res, ctx, body, params) {
  try {
    const out = await storeProductImage(ctx, params[1], body);
    return send(res, 201, out);
  } catch (e) {
    if (e.reason === 'empty') return send(res, 400, { error: 'thiếu dữ liệu ảnh' });
    if (e.reason === 'not_image') return send(res, 400, { error: 'không phải ảnh hợp lệ (JPEG/PNG/WebP/GIF)' });
    if (e.reason === 'no_product') return send(res, 404, { error: 'không tìm thấy sản phẩm' });
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

// Ảnh BANNER trang chủ (Phase 5): media CẤP-SHOP y HỆT logo về bảo mật (sniff magic byte,
// KHÔNG tin Content-Type, re-encode WebP strip payload, CHỈ WebP lên bucket PUBLIC, trần
// MAX_UPLOAD ở dispatcher). Khác logo: KHÔNG ghi shops row — key chỉ sống trong theme
// layout JSON (hero.props.slides), nên trả { key, url } để seller-admin lắp vào slide.
// Không giữ bản gốc (banner chỉ trưng bày). Tiền tố key banner- để phân biệt logo-/ảnh SP.
// Perm 'theme.write' (owner/admin) — khai ở route. Cùng shop namespace nên RLS cô lập.
/**
 * Đường xử lý ảnh CHUNG cho mọi ảnh trưng bày (banner, ảnh nội dung, ảnh danh mục):
 * sniff magic byte → re-encode WebP (bỏ mọi payload nhúng + EXIF) → đẩy bucket PUBLIC.
 * Trả `null` khi đã tự gửi lỗi cho client, hoặc `{ key }` khi xong.
 *
 * Tách ra vì đã có ba chỗ dùng: chép ba lần thì đến lần thứ tư sẽ có một bản quên
 * sniff — và đó đúng là bản cho phép tải lên tệp không phải ảnh.
 */
async function putDisplayImage(res, buf, publicKey, w, h) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) { send(res, 400, { error: 'thiếu dữ liệu ảnh' }); return null; }
  if (!sniffImage(buf)) { send(res, 400, { error: 'không phải ảnh hợp lệ (JPEG/PNG/WebP/GIF)' }); return null; }
  try {
    const { data } = await sharp(buf).rotate()
      .resize({ width: w, height: h, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
    await minio.putObject(BUCKET_PUBLIC, publicKey, data, data.length, { 'Content-Type': 'image/webp' });
  } catch { send(res, 422, { error: 'xử lý ảnh thất bại' }); return null; }
  return { key: publicKey };
}

async function uploadBanner(res, ctx, body) {
  // Banner phủ rộng → cho phép tới 2000×1200.
  const r = await putDisplayImage(res, body, `${ctx.shopId}/banner-${crypto.randomUUID()}.webp`, 2000, 1200);
  if (!r) return undefined;
  await withTenant(ctx.shopId, (c) => audit(c, 'shop.banner_uploaded', { actorId: ctx.user.id, ip: ctx.ip, metadata: {} })).catch(() => {});
  return send(res, 200, { key: r.key, url: mediaPublicUrl(r.key) });
}

/**
 * MỌI ảnh đã upload của shop, mới nhất trước — để người viết blog/trang nội dung CHỌN
 * lại ảnh sẵn có thay vì phải tự đi tìm rồi dán "key media" bằng tay.
 *
 * Trước đây ô ảnh bìa blog bắt dán chuỗi `<shop-id>/<media-id>.webp`. Chủ shop nói
 * thẳng: đọc giải thích cũng không hiểu phải chèn cái gì. Một ô mà người dùng không
 * thể tự đoán ra cách điền thì tính năng coi như không tồn tại.
 *
 * Chỉ trả ảnh ĐÃ xử lý xong (status='ready') và kèm tên sản phẩm để nhận ra ảnh nào.
 * Ảnh banner/logo không có dòng media nên không nằm ở đây — bù lại có đường TẢI LÊN.
 */
async function listShopMedia(res, ctx) {
  const rows = await withTenant(ctx.shopId, async (c) => (await c.query(
    `SELECT m.public_key, p.title AS product_title, m.created_at
       FROM media m JOIN products p ON p.id = m.product_id
      WHERE m.status = 'ready' AND m.public_key IS NOT NULL AND m.deleted_at IS NULL
        AND p.deleted_at IS NULL
      ORDER BY m.created_at DESC LIMIT 200`)).rows);
  return send(res, 200, { media: rows.map((r) => ({ ...r, url: mediaPublicUrl(r.public_key) })) });
}

/**
 * Tải ảnh cho NỘI DUNG (ảnh bìa blog, ảnh trong bài). Dùng lại đúng đường xử lý của
 * uploadBanner — sniff magic byte, re-encode WebP (bỏ payload nhúng), đẩy MinIO.
 * Khác ở QUYỀN: người viết bài có content.write chứ không nhất thiết có theme.write.
 */
async function uploadContentImage(res, ctx, body) {
  // Tiền tố RIÊNG `content-`, không dùng lại `banner-`. Bản đầu gọi thẳng uploadBanner
  // nên ảnh ra key `<shop>/banner-<uuid>.webp` — mà blog.js/content.js chỉ nhận
  // `<shop>/<uuid>.webp` hoặc `logo-`, nên PATCH sau đó bị 400 "key ảnh không hợp lệ".
  // Nút "Tải ảnh bìa lên" vì thế CHƯA TỪNG chạy được; e2e lúc đó chỉ kiểm phần hiển
  // thị bộ chọn nên không thấy. Prefix riêng còn giữ đúng ngữ nghĩa: ảnh nội dung
  // không phải banner, và BANNER_KEY_RE không nên nhận nó.
  const r = await putDisplayImage(res, body, `${ctx.shopId}/content-${crypto.randomUUID()}.webp`, 1600, 1600);
  if (!r) return undefined;
  await withTenant(ctx.shopId, (c) => audit(c, 'shop.content_image_uploaded', { actorId: ctx.user.id, ip: ctx.ip, metadata: {} })).catch(() => {});
  return send(res, 200, { key: r.key, url: mediaPublicUrl(r.key) });
}

/**
 * Ảnh đại diện DANH MỤC: tải lên rồi GẮN LUÔN vào categories.image_key trong một lần
 * gọi. Tách thành hai bước (tải → PATCH key) sẽ đẻ ra object mồ côi mỗi lần người
 * dùng bỏ dở giữa chừng, mà chẳng đổi lấy được gì.
 *
 * Trước đây ảnh danh mục suy từ SP mới nhất trong danh mục. Shop mới chưa có SP (hoặc
 * SP chưa có ảnh) thì ô danh mục rỗng — đúng thứ chủ shop phàn nàn. Giờ đặt được tay,
 * để trống vẫn giữ nguyên cách suy cũ.
 */
async function uploadCategoryImage(res, ctx, body, params) {
  const catId = params[1];
  // Ảnh danh mục hiện ở ô nhỏ (vòng tròn ~64px hoặc thẻ ~300px) → 1200 là quá đủ.
  const r = await putDisplayImage(res, body, `${ctx.shopId}/cat-${crypto.randomUUID()}.webp`, 1200, 1200);
  if (!r) return undefined; // putDisplayImage đã trả lỗi cho client
  const n = await withTenant(ctx.shopId, async (c) => {
    const u = await c.query(`UPDATE categories SET image_key = $2 WHERE id = $1 AND deleted_at IS NULL`, [catId, r.key]);
    if (u.rowCount) await audit(c, 'category.image_set', { actorId: ctx.user.id, ip: ctx.ip, metadata: { catId } });
    return u.rowCount;
  });
  if (!n) return send(res, 404, { error: 'không tìm thấy danh mục' });
  return send(res, 200, { key: r.key, url: mediaPublicUrl(r.key) });
}

/** Gỡ ảnh danh mục → quay lại suy ảnh từ sản phẩm. Object cũ để worker dọn. */
async function deleteCategoryImage(res, ctx, _body, params) {
  const n = await withTenant(ctx.shopId, async (c) => (await c.query(
    `UPDATE categories SET image_key = NULL WHERE id = $1 AND deleted_at IS NULL`, [params[1]])).rowCount);
  if (!n) return send(res, 404, { error: 'không tìm thấy danh mục' });
  return send(res, 200, { ok: true });
}

async function listMedia(res, ctx, _body, params) {
  const productId = params[1];
  const rows = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(
      `SELECT id, status, public_key, width, height, position, variant_id, created_at
         FROM media WHERE product_id = $1 AND deleted_at IS NULL ORDER BY position, created_at`,
      [productId],
    );
    return r.rows;
  });
  return send(res, 200, {
    media: rows.map((m) => ({ ...m, url: m.public_key ? `${PUBLIC_BASE}/${m.public_key}` : null })),
  });
}

// Gán ảnh cho 1 BIẾN THỂ (hoặc bỏ gán = ảnh chung sản phẩm). variant_id=null → ảnh chung.
// Biến thể phải THUỘC ĐÚNG sản phẩm của ảnh (composite FK cũng chặn chéo shop; check thêm chéo SP).
async function assignVariant(res, ctx, body, params) {
  const mediaId = params[1];
  const variantId = body.variant_id ? String(body.variant_id) : null;
  if (variantId !== null && !new RegExp(`^${UUID}$`).test(variantId)) return send(res, 400, { error: 'variant_id không hợp lệ' });
  const out = await withTenant(ctx.shopId, async (c) => {
    const m = (await c.query(`SELECT product_id FROM media WHERE id = $1 AND deleted_at IS NULL`, [mediaId])).rows[0];
    if (!m) return { code: 404 };
    if (variantId) {
      const v = await c.query(`SELECT 1 FROM variants WHERE id = $1 AND product_id = $2`, [variantId, m.product_id]);
      if (!v.rows.length) return { code: 400 };
    }
    await c.query(`UPDATE media SET variant_id = $1 WHERE id = $2`, [variantId, mediaId]);
    await audit(c, 'media.variant_assigned', { actorId: ctx.user.id, ip: ctx.ip, metadata: { mediaId, variantId } });
    return { code: 200 };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy media' });
  if (out.code === 400) return send(res, 400, { error: 'biến thể không thuộc sản phẩm này' });
  return send(res, 200, { ok: true, variant_id: variantId });
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
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/media/${UUID}/variant$`), perm: 'catalog.write', fn: (res, ctx, b, p) => assignVariant(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/logo$`), perm: 'shop.write', raw: true, fn: (res, ctx, b) => uploadLogo(res, ctx, b) },
  { m: 'GET',  re: new RegExp(`^/shops/${UUID}/media$`), perm: 'content.read', fn: (res, ctx) => listShopMedia(res, ctx) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/content-image$`), perm: 'content.write', raw: true, fn: (res, ctx, b) => uploadContentImage(res, ctx, b) },
  // Ảnh đại diện danh mục (0118). catalog.write vì đây là dữ liệu danh mục, không phải giao diện.
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/categories/${UUID}/image$`), perm: 'catalog.write', raw: true, fn: (res, ctx, b, p) => uploadCategoryImage(res, ctx, b, p) },
  { m: 'DELETE', re: new RegExp(`^/shops/${UUID}/categories/${UUID}/image$`), perm: 'catalog.write', fn: (res, ctx, b, p) => deleteCategoryImage(res, ctx, b, p) },
  { m: 'DELETE', re: new RegExp(`^/shops/${UUID}/logo$`), perm: 'shop.write', fn: (res, ctx) => deleteLogo(res, ctx) },
  // Banner trang chủ (Phase 5): upload ảnh riêng cho carousel hero. theme.write (owner/admin).
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/banner-image$`), perm: 'theme.write', raw: true, fn: (res, ctx, b) => uploadBanner(res, ctx, b) },
];
