/**
 * Ghi ZIP KHÔNG phụ thuộc (zero-dep) cho bản xuất dữ liệu (A4).
 *
 * Thêm archiver/jszip = kéo phụ thuộc + phải regen lockfile (Dockerfile dùng `npm ci`).
 * Ta chỉ đóng gói vài file CSV nhỏ → tự ghi định dạng ZIP (method 8 = deflate) bằng
 * `zlib.deflateRawSync` (có ở MỌI phiên bản Node) + CRC32 tự cài (không dùng zlib.crc32
 * vốn chỉ có từ Node 22.2 — tránh phụ thuộc phiên bản).
 *
 * Định dạng: mỗi entry = local file header + tên + dữ liệu deflate; cuối = central
 * directory (một record/entry) + end-of-central-directory. Không thư mục, không mật khẩu.
 */
import zlib from 'node:zlib';
import { promisify } from 'node:util';

// Nén BẤT ĐỒNG BỘ (không chặn event loop của seller khi bản xuất lớn — seller phục vụ
// mọi shop, block đồng bộ = DoS chéo tenant). Kèm trần dòng ở export.js chặn OOM.
const deflateRaw = promisify(zlib.deflateRaw);

// CRC-32 (đa thức 0xEDB88320) — bảng tra dựng một lần.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const DOS_TIME = 0;       // 00:00:00
const DOS_DATE = 0x21;    // 1980-01-01 (ngày cố định → ZIP tất định, không cần Date)

/**
 * Đóng gói `entries` = [{ name: string, data: Buffer }] thành một Buffer ZIP hoàn chỉnh.
 * BẤT ĐỒNG BỘ: nén song song (deflateRaw promisified) → không chặn event loop.
 */
export async function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;

  const comps = await Promise.all(entries.map((e) => deflateRaw(e.data)));

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const comp = comps[i];

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);   // signature PK\x03\x04
    lfh.writeUInt16LE(20, 4);           // version needed
    lfh.writeUInt16LE(0x0800, 6);       // flag bit 11 = tên UTF-8
    lfh.writeUInt16LE(8, 8);            // method = deflate
    lfh.writeUInt16LE(DOS_TIME, 10);
    lfh.writeUInt16LE(DOS_DATE, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(comp.length, 18);   // compressed size
    lfh.writeUInt32LE(e.data.length, 22); // uncompressed size
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28);             // extra length
    parts.push(lfh, name, comp);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);   // signature PK\x01\x02
    cdh.writeUInt16LE(20, 4);           // version made by
    cdh.writeUInt16LE(20, 6);           // version needed
    cdh.writeUInt16LE(0x0800, 8);       // flag UTF-8
    cdh.writeUInt16LE(8, 10);           // method
    cdh.writeUInt16LE(DOS_TIME, 12);
    cdh.writeUInt16LE(DOS_DATE, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(comp.length, 20);
    cdh.writeUInt32LE(e.data.length, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt16LE(0, 30);           // extra length
    cdh.writeUInt16LE(0, 32);           // comment length
    cdh.writeUInt16LE(0, 34);           // disk number start
    cdh.writeUInt16LE(0, 36);           // internal attrs
    cdh.writeUInt32LE(0, 38);           // external attrs
    cdh.writeUInt32LE(offset, 42);      // offset of local header
    central.push(cdh, name);

    offset += lfh.length + name.length + comp.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);    // signature PK\x05\x06
  eocd.writeUInt16LE(0, 4);             // disk number
  eocd.writeUInt16LE(0, 6);             // central dir start disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);       // offset of central directory
  eocd.writeUInt16LE(0, 20);            // comment length

  return Buffer.concat([...parts, centralBuf, eocd]);
}
