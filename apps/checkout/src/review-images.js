/**
 * Ảnh trong đánh giá (0101) — lần ĐẦU nền tảng nhận TỆP từ NGƯỜI LẠ (không đăng nhập).
 * Rủi ro khác hẳn ảnh sản phẩm (do chính chủ shop tải lên), nên có 4 lớp:
 *
 *   1. TRẦN CỨNG        — ≤3 ảnh/đánh giá, ≤5MB/ảnh, ≤15MB tổng body. Cộng với trần
 *                          3 đánh giá/IP/ngày sẵn có ⇒ tối đa 9 ảnh/IP/ngày.
 *   2. SNIFF MAGIC BYTE — không tin Content-Type do client khai; chỉ nhận JPEG/PNG/WebP/GIF.
 *   3. RE-ENCODE        — sharp giải mã rồi mã hoá lại sang WebP: "ảnh có payload nhúng"
 *                          thành ảnh sạch, tệp không-phải-ảnh HỎNG NGAY tại đây thay vì
 *                          nằm chờ trong kho. Cũng strip EXIF (toạ độ GPS nhà người mua!).
 *   4. BUCKET RIÊNG TƯ  — ảnh KHÔNG có URL công khai cho tới khi shop DUYỆT đánh giá.
 *                          Chặn kịch bản: gửi ảnh bẩn → đánh giá không được duyệt nên không
 *                          hiện → nhưng URL vẫn sống trên tên miền shop và kẻ đó phát tán.
 */
import crypto from 'node:crypto';
import { Client as MinioClient } from 'minio';
import sharp from 'sharp';

export const MAX_IMAGES = Number(process.env.REVIEW_IMAGES_MAX ?? 3);
export const MAX_IMAGE_BYTES = Number(process.env.REVIEW_IMAGE_MAX_BYTES ?? 5 * 1024 * 1024);
export const MAX_BODY_BYTES = MAX_IMAGE_BYTES * MAX_IMAGES + 1024 * 1024; // + chỗ cho các field text

const BUCKET_PRIVATE = process.env.MEDIA_BUCKET_PRIVATE ?? 'media-private';
const minio = new MinioClient({
  endPoint: process.env.MINIO_ENDPOINT ?? 'minio',
  port: Number(process.env.MINIO_PORT ?? 9000),
  useSSL: String(process.env.MINIO_USE_SSL ?? 'false') === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY ?? 'minioadmin',
});

// Kiểu THẬT từ magic byte — KHÔNG tin content-type client khai (đổi được bằng 1 dòng curl).
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.slice(0, 6).toString('latin1') === 'GIF89a' || buf.slice(0, 6).toString('latin1') === 'GIF87a') return 'image/gif';
  return null;
}

/** Đọc toàn bộ body multipart với TRẦN CỨNG. Vượt trần → huỷ kết nối, không đọc tiếp. */
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(Object.assign(new Error('body quá lớn'), { statusCode: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Tách multipart thành {fields, files}. Cùng cơ chế boundary với seller-admin/http.js
 * (đã chạy thật cho upload ảnh sản phẩm) — chép sang để checkout tự chứa, không import chéo app.
 */
export async function readMultipartAll(req, maxBytes = MAX_BODY_BYTES) {
  const ct = req.headers['content-type'] || '';
  const m = /multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (!m) return { fields: {}, files: [] };
  const token = (m[1] || m[2]).trim();
  const dash = Buffer.from('--' + token);
  const delim = Buffer.from('\r\n--' + token);
  const body = await readRawBody(req, maxBytes);
  const fields = {}, files = [];
  let pos = body.indexOf(dash);
  if (pos === -1) return { fields, files };
  pos += dash.length;
  while (pos < body.length) {
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    const hEnd = body.indexOf('\r\n\r\n', pos, 'latin1');
    if (hEnd === -1) break;
    const headers = body.slice(pos, hEnd).toString('latin1');
    const cStart = hEnd + 4;
    const next = body.indexOf(delim, cStart);
    if (next === -1) break;
    const bytes = body.slice(cStart, next);
    const nameM = /name="([^"]*)"/i.exec(headers);
    const fnM = /filename="([^"]*)"/i.exec(headers);
    const name = nameM ? nameM[1] : '';
    if (fnM) { if (fnM[1] && bytes.length) files.push({ field: name, filename: fnM[1], bytes }); }
    else if (name) fields[name] = bytes.toString('utf8');
    pos = next + delim.length;
  }
  return { fields, files };
}

/**
 * Làm sạch + cất ảnh vào bucket RIÊNG TƯ. Trả mảng bản ghi để chèn review_images.
 * Ảnh hỏng/không phải ảnh bị BỎ QUA lặng lẽ — đánh giá vẫn được gửi. (Chặn cả đánh giá chỉ
 * vì một tệp lỗi là phạt nhầm người mua thật; ảnh là phần thêm, không phải phần chính.)
 */
export async function ingestReviewImages(shopId, files) {
  const out = [];
  for (const f of files.slice(0, MAX_IMAGES)) {
    if (f.bytes.length > MAX_IMAGE_BYTES) continue;
    const detected = sniff(f.bytes);
    if (!detected) continue;                       // không phải ảnh → bỏ, không tạo bản ghi
    try {
      // Re-encode: đây là bước biến tệp lạ thành ảnh sạch. .rotate() áp EXIF rồi bỏ hẳn
      // metadata — QUAN TRỌNG với ảnh người mua: EXIF có thể chứa toạ độ GPS nhà họ.
      const { data, info } = await sharp(f.bytes)
        .rotate()
        .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer({ resolveWithObject: true });
      const id = crypto.randomUUID();
      // Key nằm trong bucket PRIVATE. Chỉ khi shop duyệt, seller mới sao sang public.
      const originalKey = `review/${shopId}/${id}.webp`;
      await minio.putObject(BUCKET_PRIVATE, originalKey, data, data.length, { 'Content-Type': 'image/webp' });
      out.push({ id, originalKey, contentType: detected, width: info.width, height: info.height, size: data.length });
    } catch { /* sharp ném = tệp không giải mã được → bỏ qua ảnh này */ }
  }
  return out;
}
