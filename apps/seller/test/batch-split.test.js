import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countProductGroups, mergeImportResults, splitProductBatches } from '../../seller-admin/src/import-batch.js';

test('chia lô không cắt giữa một product_id dù sản phẩm có nhiều dòng', () => {
  const rows = [
    { product_id: '1', variation_value: 'A' }, { product_id: '1', variation_value: 'B' },
    { product_id: '2', variation_value: 'A' }, { product_id: '2', variation_value: 'B' },
    { product_id: '3', variation_value: 'A' },
  ];
  const batches = splitProductBatches(rows, { maxProducts: 1, maxBytes: 10000 });
  assert.equal(batches.length, 3);
  for (const id of ['1', '2', '3']) {
    assert.equal(batches.filter((batch) => batch.some((r) => r.product_id === id)).length, 1);
  }
});

test('hình dạng 641 dòng và 124 sản phẩm được chia ba lô mà không mất dòng', () => {
  const rows = [];
  for (let product = 0; product < 124; product++) {
    const variants = product < 3 ? 16 : (product < 15 ? 4 : 5);
    const productId = String(1738000000000000000n + BigInt(product));
    for (let variant = 0; variant < variants; variant++) {
      rows.push({ product_id: productId, variation_value: `V${variant}` });
    }
  }
  assert.equal(rows.length, 641);
  assert.equal(countProductGroups(rows), 124);

  const batches = splitProductBatches(rows, { maxProducts: 50, maxBytes: 10_000_000 });
  assert.deepEqual(batches.map((batch) => countProductGroups(batch)), [50, 50, 24]);
  assert.equal(batches.flat().length, 641);
  for (const productId of new Set(rows.map((row) => row.product_id))) {
    assert.equal(batches.filter((batch) => batch.some((row) => row.product_id === productId)).length, 1);
  }
});

test('gộp kết quả nhiều lô giữ số bỏ qua và cộng đủ thống kê cập nhật của Đợt 4', () => {
  const merged = mergeImportResults([
    { dry_run: true, rows: 400, groups: 80, created: 79, variants: 400, skipped_existing: 1,
      images: { queued: 180, invalid: 0 }, columns: { recognised: [{ header: 'product_id', field: 'handle' }], ignored: ['cod'] } },
    { dry_run: true, rows: 241, groups: 44, created: 43, variants: 241, skipped_existing: 1,
      images: { queued: 119, invalid: 0 }, columns: { recognised: [{ header: 'product_id', field: 'handle' }], ignored: ['cod'] } },
  ]);
  assert.equal(merged.rows, 641);
  assert.equal(merged.groups, 124);
  assert.equal(merged.created, 122);
  assert.equal(merged.skipped_existing, 2);
  assert.equal(merged.variants, 641);
  assert.equal(merged.images.queued, 299);
  assert.equal(merged.columns.recognised.length, 1);
  assert.deepEqual(merged.columns.ignored, ['cod']);
  assert.equal(merged.updated, 0);
  assert.equal(merged.variants_updated, 0);
});

test('gộp nhiều lô giữ một ngân sách ảnh chung thay vì cấp lại trần cho từng lô', () => {
  const merged = mergeImportResults([
    { images: { queued: 2, invalid: 1, skipped: 0, limit: 3, remaining: 1 } },
    { images: { queued: 1, invalid: 0, skipped: 4, limit: 1, remaining: 0 } },
  ]);
  assert.deepEqual(merged.images, { queued: 3, invalid: 1, skipped: 4, limit: 3, remaining: 0 });
});
