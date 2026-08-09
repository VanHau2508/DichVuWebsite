/**
 * Bộ đọc XLSX tối thiểu cho đường nhập danh mục.
 *
 * XLSX là ZIP chứa XML. Chỉ ba entry cần thiết được giải nén; toàn bộ central directory
 * vẫn được kiểm trước để chặn zip bomb, zip-slip và gói có quá nhiều entry trước khi cấp
 * phát bộ nhớ theo nội dung do người dùng tải lên.
 */

import zlib from 'node:zlib';

export const XLSX_LIMITS = Object.freeze({
  maxEntries: 2048,
  maxUncompressedBytes: 200 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxRows: 100_000,
  maxColumns: 512,
});

const REQUIRED = new Set([
  'xl/workbook.xml',
  'xl/worksheets/sheet1.xml',
  'xl/sharedStrings.xml',
]);
const BAD_XML = /<!DOCTYPE|<!ENTITY/i;
const HEADER_KEYS = new Set(['product_id', 'handle', 'sku_id', 'seller_sku', 'variant sku']);
const META_VALUES = new Set(['bắt buộc', 'bắt buộc có điều kiện', 'không bắt buộc', 'không thể chỉnh sửa']);

const fail = (message, code = 'XLSX_INVALID') => {
  const err = new Error(message);
  err.code = code;
  return err;
};

export function isXlsxMagic(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4
    && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

function safeEntryName(raw) {
  if (raw.includes('\0')) throw fail('XLSX có tên entry không hợp lệ');
  const name = raw.replaceAll('\\', '/');
  if (/^(?:\/|[a-z]:\/)/i.test(name)) throw fail('XLSX chứa đường dẫn tuyệt đối', 'XLSX_ZIP_SLIP');
  const parts = name.split('/');
  if (parts.includes('..')) throw fail('XLSX chứa đường dẫn vượt thư mục', 'XLSX_ZIP_SLIP');
  return parts.filter((p) => p && p !== '.').join('/');
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 65_557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw fail('XLSX thiếu central directory');
}

function readDirectory(buf, limits) {
  if (!isXlsxMagic(buf)) throw fail('Tệp không có magic byte XLSX/ZIP', 'XLSX_MAGIC');
  const eocd = findEocd(buf);
  const disk = buf.readUInt16LE(eocd + 4);
  const startDisk = buf.readUInt16LE(eocd + 6);
  const diskEntries = buf.readUInt16LE(eocd + 8);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || startDisk !== 0 || diskEntries !== totalEntries) throw fail('XLSX nhiều đĩa không được hỗ trợ');
  if (totalEntries === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw fail('XLSX ZIP64 không được hỗ trợ');
  }
  if (totalEntries > limits.maxEntries) throw fail(`XLSX vượt ${limits.maxEntries} entry`, 'XLSX_ENTRY_LIMIT');
  if (centralOffset + centralSize > eocd || centralOffset < 0) throw fail('Central directory nằm ngoài tệp');

  const entries = new Map();
  let at = centralOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  for (let i = 0; i < totalEntries; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw fail('Central directory bị hỏng');
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const uncompressed = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localOffset = buf.readUInt32LE(at + 42);
    const end = at + 46 + nameLen + extraLen + commentLen;
    if (end > buf.length) throw fail('Tên entry XLSX vượt kích thước tệp');
    const encoding = (flags & 0x0800) ? 'utf8' : 'latin1';
    const name = safeEntryName(buf.subarray(at + 46, at + 46 + nameLen).toString(encoding));
    if (entries.has(name)) throw fail(`XLSX có entry trùng: ${name}`);
    if (flags & 0x0001) throw fail('XLSX mã hoá không được hỗ trợ');
    if (method !== 0 && method !== 8) throw fail(`XLSX dùng kiểu nén không hỗ trợ: ${method}`);
    if (uncompressed > 0 && (compressed === 0 || uncompressed > compressed * limits.maxCompressionRatio)) {
      throw fail('XLSX có tỉ lệ nén vượt 1:100', 'XLSX_COMPRESSION_RATIO');
    }
    totalCompressed += compressed;
    totalUncompressed += uncompressed;
    if (totalUncompressed > limits.maxUncompressedBytes) {
      throw fail('XLSX vượt trần 200MB sau giải nén', 'XLSX_SIZE_LIMIT');
    }
    entries.set(name, { name, flags, method, compressed, uncompressed, localOffset });
    at = end;
  }
  if (at !== centralOffset + centralSize) throw fail('Kích thước central directory không khớp');
  if (totalUncompressed > 0 && totalCompressed > 0
      && totalUncompressed > totalCompressed * limits.maxCompressionRatio) {
    throw fail('Tổng tỉ lệ nén XLSX vượt 1:100', 'XLSX_COMPRESSION_RATIO');
  }
  return entries;
}

function inflateEntry(buf, entry) {
  const at = entry.localOffset;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== 0x04034b50) throw fail('Local header XLSX bị hỏng');
  const nameLen = buf.readUInt16LE(at + 26);
  const extraLen = buf.readUInt16LE(at + 28);
  const start = at + 30 + nameLen + extraLen;
  const end = start + entry.compressed;
  if (end > buf.length) throw fail('Dữ liệu entry XLSX vượt kích thước tệp');
  const compressed = buf.subarray(start, end);
  let out;
  try {
    out = entry.method === 0
      ? Buffer.from(compressed)
      : zlib.inflateRawSync(compressed, { maxOutputLength: entry.uncompressed });
  } catch {
    throw fail(`Không giải nén được ${entry.name}`);
  }
  if (out.length !== entry.uncompressed) throw fail(`Kích thước ${entry.name} không khớp central directory`);
  const xml = out.toString('utf8');
  if (BAD_XML.test(xml)) throw fail('XLSX chứa DOCTYPE/ENTITY bị cấm', 'XLSX_XML_ENTITY');
  return xml;
}

function decodeXml(value) {
  return String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, entity) => {
    const e = entity.toLowerCase();
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const n = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? '') : '';
}

function textTags(xml) {
  let out = '';
  const re = /<(?:[\w.-]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?t>/gi;
  for (const m of xml.matchAll(re)) out += decodeXml(m[1]);
  return out;
}

function sharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<(?:[\w.-]+:)?si\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?si>/gi;
  for (const m of xml.matchAll(re)) out.push(textTags(m[1]));
  return out;
}

function columnIndex(ref) {
  const m = /^([A-Z]+)\d+$/i.exec(ref);
  if (!m) throw fail(`Tham chiếu ô không hợp lệ: ${ref}`);
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

function cellValue(cellTag, inner, strings) {
  const type = attr(cellTag, 't');
  if (type === 'inlineStr') return textTags(inner);
  const v = /<(?:[\w.-]+:)?v\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?v>/i.exec(inner)?.[1] ?? '';
  const decoded = decodeXml(v);
  if (type === 's') {
    const index = Number(decoded);
    if (!Number.isInteger(index) || index < 0 || index >= strings.length) throw fail('Chỉ số shared string không hợp lệ');
    return strings[index];
  }
  return decoded;
}

function worksheetRows(xml, strings, limits) {
  const rows = [];
  const rowRe = /<(?:[\w.-]+:)?row\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?row>/gi;
  for (const rowMatch of xml.matchAll(rowRe)) {
    if (rows.length >= limits.maxRows) throw fail(`XLSX vượt ${limits.maxRows} dòng`, 'XLSX_ROW_LIMIT');
    const cells = new Map();
    const cellRe = /<(?:[\w.-]+:)?c\b([^>]*)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?c>)/gi;
    for (const cellMatch of rowMatch[2].matchAll(cellRe)) {
      const tag = cellMatch[1];
      const ref = attr(tag, 'r');
      if (!ref) throw fail('Ô XLSX thiếu thuộc tính r');
      const col = columnIndex(ref);
      if (col >= limits.maxColumns) throw fail(`XLSX vượt ${limits.maxColumns} cột`, 'XLSX_COLUMN_LIMIT');
      cells.set(col, cellValue(tag, cellMatch[2] ?? '', strings));
    }
    rows.push({ number: Number(attr(rowMatch[1], 'r')) || rows.length + 1, cells });
  }
  return rows;
}

function normalHeader(value) {
  return String(value ?? '').trim().toLowerCase().replaceAll('\u00a0', ' ');
}

function recordsFromRows(rows) {
  let headerAt = -1;
  for (let i = 0; i < Math.min(20, rows.length); i++) {
    if ([...rows[i].cells.values()].some((v) => HEADER_KEYS.has(normalHeader(v)))) {
      headerAt = i;
      break;
    }
  }
  if (headerAt === -1) throw fail('Không tìm thấy dòng tiêu đề trong 20 dòng đầu', 'XLSX_HEADER');
  const headers = new Map();
  for (const [col, value] of rows[headerAt].cells) {
    const name = String(value ?? '').trim();
    if (name) headers.set(col, name);
  }
  const productCol = [...headers].find(([, name]) => normalHeader(name) === 'product_id')?.[0] ?? null;
  const out = [];
  let productDataStarted = productCol === null;
  for (let i = headerAt + 1; i < rows.length; i++) {
    const row = rows[i];
    const values = [...row.cells.values()].map(normalHeader);
    const first = normalHeader(row.cells.get(0));
    if (first === 'v4' || values.some((v) => META_VALUES.has(v))) continue;
    if (!productDataStarted) {
      if (!/^\d{10,}$/.test(String(row.cells.get(productCol) ?? '').trim())) continue;
      productDataStarted = true;
    }
    const record = {};
    let hasValue = false;
    for (const [col, name] of headers) {
      const value = row.cells.get(col) ?? '';
      record[name] = value;
      if (String(value).trim() !== '') hasValue = true;
    }
    if (hasValue) out.push(record);
  }
  return out;
}

/** Đọc sheet đầu của XLSX và trả mảng object có khoá là tiêu đề cột. */
export function readXlsx(buf, overrideLimits = {}) {
  const limits = { ...XLSX_LIMITS, ...overrideLimits };
  const entries = readDirectory(buf, limits);
  const xml = {};
  for (const name of REQUIRED) {
    const entry = entries.get(name);
    if (!entry) {
      if (name === 'xl/sharedStrings.xml') { xml[name] = ''; continue; }
      throw fail(`XLSX thiếu ${name}`);
    }
    xml[name] = inflateEntry(buf, entry);
  }
  // workbook.xml không tham gia ánh xạ ô, nhưng vẫn phải được đọc và kiểm XML độc hại.
  if (!/<(?:[\w.-]+:)?workbook\b/i.test(xml['xl/workbook.xml'])) throw fail('workbook.xml không hợp lệ');
  const strings = sharedStrings(xml['xl/sharedStrings.xml']);
  const rows = worksheetRows(xml['xl/worksheets/sheet1.xml'], strings, limits);
  return recordsFromRows(rows);
}
