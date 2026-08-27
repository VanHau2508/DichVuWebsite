import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const worker = readFileSync(new URL('../../worker/src/index.js', import.meta.url), 'utf8');
const seller = readFileSync(new URL('../src/integrations.js', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../../../packages/db/migrations/0181_kiotviet_claim_and_send_intent.sql', import.meta.url), 'utf8');

test('auto-sync và mapEntity dùng cùng canonical claim lock', () => {
  const lockSql = 'kiotviet_entity_claim_lock_key($1, $2, $3)';
  assert.equal(worker.includes(lockSql), true);
  assert.equal(seller.includes(lockSql), true);
  assert.match(migration, /CREATE FUNCTION kiotviet_entity_claim_lock_key\([\s\S]*?kiotviet:entity-claim:/);
  assert.match(worker, /claim === 'occupied'/);
  assert.match(worker, /claim === 'batch_conflict'/);
  assert.match(worker, /local-variant:\$\{local\.id\}/);
  assert.match(worker, /conflicting_external_ids: batch/);
});

test('claim batch không dùng thứ tự externalId để phân xử', () => {
  assert.match(worker, /const sortedRows = \[\.\.\.rows\]\.sort/);
  assert.match(worker, /sắp xếp.*deadlock|Resolve all claims before writing any mapping/i);
  assert.match(worker, /Nhiều sản phẩm KiotViet mới cùng nhận một biến thể trong cùng lượt/);
  assert.match(worker, /DELETE FROM product_source_refs[\s\S]*external_id = \$1/);
});

test('send intent tồn tại trước khi worker gọi provider', () => {
  const insert = worker.indexOf('INSERT INTO integration_order_send_intents');
  const create = worker.indexOf('client.createOrder(');
  assert.ok(insert >= 0 && create > insert);
  assert.match(worker, /state = 'attempted', attempt_started_at = now/);
  assert.match(worker, /state = 'needs_attention'/);
  assert.match(worker, /UPDATE integration_order_send_intents[\s\S]*state = 'needs_attention'[\s\S]*last_error = \$2/);
  const requestHashBody = /function websiteOrderRequestHash[\s\S]*?const body = \{([\s\S]*?)\n  \};/.exec(worker)?.[1] ?? '';
  assert.doesNotMatch(requestHashBody, /\bstatus:/,
    'request hash không được chứa trạng thái mà finalize tự đổi pending → confirmed');
});

test('retry đơn mơ hồ phải có xác nhận và đi qua topic riêng', () => {
  assert.match(seller, /confirm_provider_absent/);
  assert.match(seller, /integration\.order_retry_requested/);
  assert.match(worker, /manual_retry_confirmed === true/);
  assert.match(worker, /lookup\?\.state !== 'proven_absent'/);
  assert.match(worker, /intent\.state !== 'needs_attention'/);
  assert.match(worker, /last_retry_discrepancy_id/);
  assert.doesNotMatch(worker, /state IN \('attempted','needs_attention'\)/,
    'retry không được reset attempted thành prepared');
});
