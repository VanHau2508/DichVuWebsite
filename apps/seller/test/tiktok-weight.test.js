import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptTiktok } from '../src/adapters/tiktok.js';

test('parcel_weight 200 được giữ là 200 gram, không nhân 1000', () => {
  const out = adaptTiktok([{ product_id: '1234567890123456789', product_name: 'Vòng tay',
    variation_value: 'Mặc định', sku_id: '9876543210987654321', price: '100000', quantity: '1', parcel_weight: '200' }]);
  assert.equal(out.rows[0].weight_gram, 200);
});
