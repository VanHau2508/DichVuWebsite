import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildZip } from '../src/zip.js';
import { readXlsx } from '../src/xlsx-read.js';
import { buildXlsx } from './xlsx-fixture.js';

test('từ chối tệp giả XLSX và đường dẫn zip-slip', async () => {
  assert.throws(() => readXlsx(Buffer.from('không phải zip')), /magic byte/i);
  const zip = await buildZip([{ name: '../xl/workbook.xml', data: Buffer.from('<workbook/>') }]);
  assert.throws(() => readXlsx(zip), /vượt thư mục/i);
});

test('từ chối DOCTYPE và ENTITY trước khi quét XML', async () => {
  const bad = await buildZip([
    { name: 'xl/workbook.xml', data: Buffer.from('<!DOCTYPE x [<!ENTITY y "z">]><workbook/>') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from('<worksheet><sheetData/></worksheet>') },
    { name: 'xl/sharedStrings.xml', data: Buffer.from('<sst/>') },
  ]);
  assert.throws(() => readXlsx(bad), /DOCTYPE\/ENTITY/i);
});

test('từ chối zip bomb theo tỉ lệ nén trước khi giải nén entry không cần đọc', async () => {
  const normal = await buildXlsx([['product_id'], ['1234567890123456789']], [
    { name: 'docProps/bomb.bin', data: Buffer.alloc(1024 * 1024, 0x41) },
  ]);
  assert.throws(() => readXlsx(normal), /tỉ lệ nén/i);
});

test('từ chối vượt trần entry, dòng và cột trước khi cấp phát mảng lớn', async () => {
  const xlsx = await buildXlsx([['product_id', 'variation_value'], ['1234567890123456789', 'Đỏ']]);
  assert.throws(() => readXlsx(xlsx, { maxEntries: 2 }), /vượt 2 entry/i);
  assert.throws(() => readXlsx(xlsx, { maxRows: 1 }), /vượt 1 dòng/i);
  assert.throws(() => readXlsx(xlsx, { maxColumns: 1 }), /vượt 1 cột/i);
});
