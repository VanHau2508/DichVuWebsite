import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'import.js');

test('đường cập nhật TikTok chỉ ghi các trường được phép, không chạm tài sản shop', () => {
  const source = fs.readFileSync(SRC, 'utf8');
  const start = source.indexOf('async function updateImportedProduct');
  const end = source.indexOf('// ── Handler', start);
  assert.ok(start >= 0 && end > start, 'không cắt được đường cập nhật import');
  const updatePath = source.slice(start, end);

  assert.match(updatePath, /UPDATE products SET title = \$1, description = \$2/);
  assert.doesNotMatch(updatePath, /UPDATE products SET[^;]*(?:slug|status|price_vnd|cost_vnd)/s);
  assert.doesNotMatch(updatePath, /UPDATE variants SET[^;]*(?:sku|cost_vnd)/s);
  assert.doesNotMatch(updatePath, /UPDATE variant_costs/);
  assert.doesNotMatch(updatePath, /UPDATE products SET[^;]*slug/s);
});
