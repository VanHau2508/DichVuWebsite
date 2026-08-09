import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readXlsx } from '../src/xlsx-read.js';
import { buildXlsx } from './xlsx-fixture.js';

test('dò tiêu đề, bỏ bốn dòng meta TikTok và giữ đúng cột khi ô rỗng bị lược', async () => {
  const xlsx = await buildXlsx([
    ['product_id', 'variation_value', 'product_name', 'quantity'],
    ['V4', 'Bắt buộc', 'Không bắt buộc', 'Không thể chỉnh sửa'],
    ['', 'ghi chú mẫu', '', ''],
    ['', '', '', ''],
    ['', '', '', ''],
    [{ value: '1731037645341100126', type: 'inlineStr' }, null, 'Vòng tay bạc', { value: 12, type: 'n' }],
  ]);
  assert.deepEqual(readXlsx(xlsx), [{
    product_id: '1731037645341100126', variation_value: '', product_name: 'Vòng tay bạc', quantity: '12',
  }]);
});

test('dò được dòng tiêu đề không nằm ở dòng đầu và bỏ meta trước dữ liệu thật', async () => {
  const xlsx = await buildXlsx([
    ['TikTok Shop template'],
    ['phiên bản', 'V4'],
    ['product_id', 'variation_value', 'sku_id'],
    ['', 'Không bắt buộc', ''],
    ['1234567890123456789', 'Đen, M', '9876543210987654321'],
  ]);
  assert.equal(readXlsx(xlsx).length, 1);
  assert.equal(readXlsx(xlsx)[0].variation_value, 'Đen, M');
});

test('bỏ nhãn Bắt buộc có điều kiện trước dữ liệu thật', async () => {
  const xlsx = await buildXlsx([
    ['product_id', 'variation_value'],
    ['Bắt buộc có điều kiện', 'Bắt buộc có điều kiện'],
    ['1731999999999999001', 'Đỏ'],
  ]);
  assert.deepEqual(readXlsx(xlsx), [{ product_id: '1731999999999999001', variation_value: 'Đỏ' }]);
});
