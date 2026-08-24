/**
 * Cô lập tenant — cổng nghiệm thu tuần 1.
 *
 * Không được sang tuần 2 nếu bộ test này chưa xanh.
 *
 * Mỗi test ở đây tương ứng với một cách mà dữ liệu của khách hàng này rò sang
 * khách hàng khác. Không cái nào là lý thuyết: tất cả đều là lỗi từng xảy ra
 * trong các hệ thống multi-tenant thật.
 *
 * Chạy: docker compose -f infra/compose.dev.yml exec -T dbtest node --test test/
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  rw,
  integration,
  expiry,
  owner,
  withTenant,
  withIntegrationTenant,
  seedTwoShops,
  cleanupShops,
  sqlstateOf,
  closeAll,
  SQLSTATE,
} from './helpers.js';

let A, B;

before(async () => {
  const shops = await seedTwoShops();
  A = shops.a;
  B = shops.b;
});

after(async () => {
  await cleanupShops({ a: A, b: B });
  await closeAll();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ĐỌC', () => {
  test('shop A không thấy sản phẩm của shop B', async () => {
    const rows = await withTenant(A.id, (c) => c.query('SELECT id FROM products'));
    const ids = rows.rows.map((r) => r.id);
    assert.ok(ids.includes(A.productId), 'phải thấy sản phẩm của chính mình');
    assert.ok(!ids.includes(B.productId), 'KHÔNG được thấy sản phẩm của shop B');
  });

  test('shop A không thấy tham chiếu nhập sản phẩm của shop B', async () => {
    const aExternal = `tenant-a-${randomUUID()}`;
    const bExternal = `tenant-b-${randomUUID()}`;
    await withTenant(A.id, (c) => c.query(
      `INSERT INTO product_source_refs (shop_id, source, kind, external_id, product_id)
       VALUES (current_shop_id(), 'tiktok', 'product', $1, $2)`, [aExternal, A.productId],
    ));
    await withTenant(B.id, (c) => c.query(
      `INSERT INTO product_source_refs (shop_id, source, kind, external_id, product_id)
       VALUES (current_shop_id(), 'tiktok', 'product', $1, $2)`, [bExternal, B.productId],
    ));

    const rows = await withTenant(A.id, (c) => c.query(
      `SELECT external_id FROM product_source_refs WHERE external_id = ANY($1::text[]) ORDER BY external_id`,
      [[aExternal, bExternal]],
    ));
    assert.deepEqual(rows.rows.map((r) => r.external_id), [aExternal]);
  });

  test('truy vấn thẳng theo id của shop B vẫn trả về rỗng', async () => {
    // Đây là IDOR: kẻ tấn công đoán/biết được uuid của shop khác.
    const r = await withTenant(A.id, (c) =>
      c.query('SELECT id FROM products WHERE id = $1', [B.productId]),
    );
    assert.equal(r.rowCount, 0);
  });

  test('đơn hàng của shop B không lọt sang shop A', async () => {
    const r = await withTenant(A.id, (c) => c.query('SELECT id FROM orders'));
    assert.equal(r.rowCount, 1);
    assert.equal(r.rows[0].id, A.orderId);
  });

  test('shop_counters của shop B không đọc được', async () => {
    // Nếu đọc được, shop A biết chính xác sản lượng đơn hàng của đối thủ.
    const r = await withTenant(A.id, (c) =>
      c.query('SELECT value FROM shop_counters WHERE shop_id = $1', [B.id]),
    );
    assert.equal(r.rowCount, 0);
  });

  test('bảng shops: shop A chỉ thấy chính mình', async () => {
    const r = await withTenant(A.id, (c) => c.query('SELECT id FROM shops'));
    assert.equal(r.rowCount, 1);
    assert.equal(r.rows[0].id, A.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GHI — WITH CHECK phải chặn', () => {
  test('shop A không UPDATE được sản phẩm của shop B', async () => {
    const r = await withTenant(A.id, (c) =>
      c.query('UPDATE products SET price_vnd = 1 WHERE id = $1', [B.productId]),
    );
    // RLS lọc dòng ra khỏi tầm nhìn, nên UPDATE không khớp gì — không ném lỗi.
    assert.equal(r.rowCount, 0);

    const { rows } = await owner.query('SELECT price_vnd FROM products WHERE id = $1', [B.productId]);
    assert.equal(Number(rows[0].price_vnd), 250000, 'giá của shop B phải nguyên vẹn');
  });

  test('shop A không DELETE được sản phẩm của shop B', async () => {
    const r = await withTenant(A.id, (c) =>
      c.query('DELETE FROM products WHERE id = $1', [B.productId]),
    );
    assert.equal(r.rowCount, 0);

    const { rowCount } = await owner.query('SELECT 1 FROM products WHERE id = $1', [B.productId]);
    assert.equal(rowCount, 1, 'sản phẩm của shop B phải còn');
  });

  test('shop A không INSERT được dòng mang shop_id của shop B', async () => {
    const code = await sqlstateOf(() =>
      withTenant(A.id, (c) =>
        c.query(
          `INSERT INTO products (shop_id, slug, title, price_vnd) VALUES ($1, $2, 'X', 1)`,
          [B.id, `x-${randomUUID().slice(0, 8)}`],
        ),
      ),
    );
    assert.equal(code, SQLSTATE.INSUFFICIENT_PRIVILEGE, 'WITH CHECK phải chặn INSERT chéo shop');
  });

  test('shop A không "di cư" được dòng của mình sang shop B', async () => {
    // Dòng này A đọc được (nó của A) nên USING cho qua; chỉ WITH CHECK trên
    // giá trị MỚI mới chặn được. Nếu có một policy permissive thứ hai với
    // WITH CHECK (true), dòng này sẽ lọt sang shop B.
    const code = await sqlstateOf(() =>
      withTenant(A.id, (c) =>
        c.query('UPDATE products SET shop_id = $1 WHERE id = $2', [B.id, A.productId]),
      ),
    );
    assert.equal(code, SQLSTATE.INSUFFICIENT_PRIVILEGE);
  });

  test('lỡ quên WHERE shop_id thì cũng chỉ chạm dữ liệu của chính mình', async () => {
    // Đây chính là lỗi mà RLS tồn tại để cứu: `UPDATE ... ` không có mệnh đề WHERE.
    await withTenant(A.id, (c) => c.query('UPDATE products SET price_vnd = 99'));

    const a = await owner.query('SELECT price_vnd FROM products WHERE id = $1', [A.productId]);
    const b = await owner.query('SELECT price_vnd FROM products WHERE id = $1', [B.productId]);
    assert.equal(Number(a.rows[0].price_vnd), 99);
    assert.equal(Number(b.rows[0].price_vnd), 250000, 'shop B không được đụng tới');

    await owner.query('UPDATE products SET price_vnd = 250000 WHERE id = $1', [A.productId]);
  });

  test('idempotency key trùng giữa hai shop chỉ đọc và cập nhật dòng tenant hiện tại', async () => {
    // RLS là lớp DB đang chặn rò chéo shop; predicate là lớp ứng dụng bổ sung. Dùng CÙNG key
    // ở hai shop để xác nhận predicate chỉ đọc/cập nhật đúng chứng từ tenant hiện tại.
    const key = `tenant-shared-${randomUUID()}`;
    await owner.query(
      `INSERT INTO idempotency_keys (shop_id, key, request_hash, status)
       VALUES ($1, $3, 'hash-a', 'in_progress'), ($2, $3, 'hash-b', 'in_progress')`,
      [A.id, B.id, key],
    );

    const seen = await withTenant(A.id, (c) => c.query(
      `SELECT shop_id, request_hash
         FROM idempotency_keys
        WHERE key = $1 AND shop_id = current_shop_id()`, [key],
    ));
    assert.equal(seen.rowCount, 1);
    assert.equal(seen.rows[0].shop_id, A.id);
    assert.equal(seen.rows[0].request_hash, 'hash-a');

    const changed = await withTenant(A.id, (c) => c.query(
      `UPDATE idempotency_keys
          SET status = 'completed', response_code = 200, response_body = '{"shop":"a"}'::jsonb
        WHERE key = $1 AND shop_id = current_shop_id()`, [key],
    ));
    assert.equal(changed.rowCount, 1, 'chỉ chứng từ của shop A được cập nhật');

    const { rows } = await owner.query(
      `SELECT shop_id, status, response_body FROM idempotency_keys
        WHERE key = $1 ORDER BY shop_id`, [key],
    );
    const a = rows.find((r) => r.shop_id === A.id);
    const b = rows.find((r) => r.shop_id === B.id);
    assert.equal(a.status, 'completed');
    assert.deepEqual(a.response_body, { shop: 'a' });
    assert.equal(b.status, 'in_progress', 'shop B phải nguyên vẹn');
    assert.equal(b.response_body, null);
  });
});

describe('CONNECTOR POS — cùng external id vẫn cô lập theo shop', () => {
  let ia, ib, wa, wb;

  before(async () => {
    await owner.query(
      `INSERT INTO inventory_levels (shop_id, variant_id, on_hand, reserved)
       VALUES ($1,$2,10,0), ($3,$4,20,0)`,
      [A.id, A.variantId, B.id, B.variantId],
    );
    ia = (await owner.query(
      `INSERT INTO shop_integrations
         (shop_id, provider, status, inventory_authority, credential_ciphertext, retailer,
          webhook_public_id, external_branch_ref, reconciled_at)
       VALUES ($1, 'kiotviet', 'active', 'external_master', 'cipher-a', 'retailer-a',
               $2, 'branch-a', now() - interval '10 minutes')
       RETURNING id, webhook_public_id, generation`, [A.id, randomUUID()],
    )).rows[0];
    ib = (await owner.query(
      `INSERT INTO shop_integrations
         (shop_id, provider, status, inventory_authority, credential_ciphertext, retailer,
          webhook_public_id, external_branch_ref, reconciled_at)
       VALUES ($1, 'kiotviet', 'active', 'external_master', 'cipher-b', 'retailer-b',
               $2, 'branch-b', now() - interval '10 minutes')
       RETURNING id, webhook_public_id, generation`, [B.id, randomUUID()],
    )).rows[0];
    for (const [shop, connector, variant] of [[A, ia, A.variantId], [B, ib, B.variantId]]) {
      const webhook = await owner.query(
        `INSERT INTO integration_webhook_inbox
           (shop_id, integration_id, generation, provider_event_id, event_type, payload_hash, payload)
         VALUES ($1,$2,$3,'evt-chung','stock.update','hash','{}') RETURNING id`,
        [shop.id, connector.id, connector.generation],
      );
      if (shop.id === A.id) wa = webhook.rows[0].id;
      else wb = webhook.rows[0].id;
      await withIntegrationTenant(shop.id, async (c) => {
        await c.query(`SELECT set_config('app.integration_id', $1, true)`, [connector.id]);
        await c.query(`SELECT set_config('app.integration_generation', $1, true)`, [String(connector.generation)]);
        await c.query(
          `INSERT INTO integration_entity_refs
             (shop_id, integration_id, entity_type, external_id, local_id, mapping_status,
              inventory_synced_at, inventory_generation)
           VALUES (current_shop_id(),$1,'variant','external-chung',$2,'mapped',now(),$3)`,
          [connector.id, variant, connector.generation],
        );
      });
      await owner.query(
        `INSERT INTO integration_sync_discrepancies
           (shop_id, integration_id, kind, dedupe_key, message)
         VALUES ($1,$2,'webhook_failed','loi-chung','Lỗi thử')`, [shop.id, connector.id],
      );
    }
  });

  test('app_integration của shop A chỉ thấy bốn dòng A', async () => {
    const rows = await withIntegrationTenant(A.id, async (c) => {
      const out = {};
      for (const table of ['shop_integrations', 'integration_webhook_inbox', 'integration_entity_refs', 'integration_sync_discrepancies']) {
        out[table] = (await c.query(`SELECT shop_id FROM ${table}`)).rows.map((r) => r.shop_id);
      }
      return out;
    });
    for (const [table, ids] of Object.entries(rows)) {
      assert.deepEqual(ids, [A.id], `${table} không được lộ shop B`);
    }
  });

  test('UPDATE theo UUID của connector shop B chạm 0 dòng', async () => {
    const changed = await withIntegrationTenant(A.id, (c) => c.query(
      `UPDATE shop_integrations SET last_error = 'xâm nhập' WHERE id = $1`, [ib.id],
    ));
    assert.equal(changed.rowCount, 0);
    assert.equal((await owner.query(`SELECT last_error FROM shop_integrations WHERE id = $1`, [ib.id])).rows[0].last_error, null);
  });

  test('resolver công khai chỉ trả đúng connector theo public id, không cần mở SELECT toàn bảng', async () => {
    const a = await integration.query(`SELECT * FROM resolve_integration_webhook($1)`, [ia.webhook_public_id]);
    assert.equal(a.rowCount, 1);
    assert.equal(a.rows[0].shop_id, A.id);
    assert.equal(a.rows[0].credential_ciphertext, 'cipher-a');
    assert.equal(Number(a.rows[0].generation), Number(ia.generation));
    const none = await integration.query(`SELECT * FROM resolve_integration_webhook($1)`, [randomUUID()]);
    assert.equal(none.rowCount, 0);
    const direct = await integration.query(`SELECT id FROM shop_integrations`);
    assert.equal(direct.rowCount, 0, 'ngoài tenant context phải fail-closed');
  });

  test('app_rw không sửa on_hand của external_master; đúng connector + generation mới được ghi', async () => {
    const blocked = await sqlstateOf(() => withTenant(A.id, (c) => c.query(
      `UPDATE inventory_levels SET on_hand = on_hand + 1 WHERE variant_id = $1`, [A.variantId],
    )));
    assert.equal(blocked, 'PIV01');

    const reservation = await withTenant(A.id, (c) => c.query(
      `UPDATE inventory_levels SET reserved = reserved + 1 WHERE variant_id = $1`, [A.variantId],
    ));
    assert.equal(reservation.rowCount, 1, 'external_master chỉ khoá tồn vật lý, không khoá reservation checkout');

    const stale = await sqlstateOf(() => withIntegrationTenant(A.id, async (c) => {
      await c.query(`SELECT set_config('app.integration_id', $1, true)`, [ia.id]);
      await c.query(`SELECT set_config('app.integration_generation', $1, true)`, [String(Number(ia.generation) + 1)]);
      await c.query(`UPDATE inventory_levels SET on_hand = 11 WHERE variant_id = $1`, [A.variantId]);
    }));
    assert.equal(stale, 'PIV01', 'job generation cũ/sai không được ghi bản chiếu tồn');

    const changed = await withIntegrationTenant(A.id, async (c) => {
      await c.query(`SELECT set_config('app.integration_id', $1, true)`, [ia.id]);
      await c.query(`SELECT set_config('app.integration_generation', $1, true)`, [String(ia.generation)]);
      return c.query(`UPDATE inventory_levels SET on_hand = 11 WHERE variant_id = $1`, [A.variantId]);
    });
    assert.equal(changed.rowCount, 1);
    const { rows } = await owner.query(
      `SELECT shop_id, on_hand, reserved FROM inventory_levels
        WHERE variant_id = ANY($1::uuid[]) ORDER BY shop_id`, [[A.variantId, B.variantId]],
    );
    assert.equal(Number(rows.find((r) => r.shop_id === A.id).on_hand), 11);
    assert.equal(Number(rows.find((r) => r.shop_id === A.id).reserved), 1);
    assert.equal(Number(rows.find((r) => r.shop_id === B.id).on_hand), 20, 'shop B phải nguyên vẹn');
  });

  test('đơn website đã gửi chỉ được app_integration cập nhật như bản chiếu', async () => {
    await withIntegrationTenant(A.id, (c) => c.query(
      `UPDATE orders
          SET integration_id = $2, integration_generation = $3,
              external_ref = 'kv-web-a', sync_status = 'synced'
        WHERE id = $1`, [A.orderId, ia.id, ia.generation],
    ));
    const orderBlocked = await sqlstateOf(() => withTenant(A.id, (c) => c.query(
      `UPDATE orders SET note = 'sửa riêng local' WHERE id = $1`, [A.orderId],
    )));
    assert.equal(orderBlocked, 'PIO01');
    const lineBlocked = await sqlstateOf(() => withTenant(A.id, (c) => c.query(
      `UPDATE order_lines SET title_snapshot = 'sửa riêng local' WHERE order_id = $1`, [A.orderId],
    )));
    assert.equal(lineBlocked, 'PIO01');

    const observed = await withIntegrationTenant(A.id, (c) => c.query(
      `UPDATE orders SET status = 'confirmed' WHERE id = $1`, [A.orderId],
    ));
    assert.equal(observed.rowCount, 1, 'connector phải cập nhật được trạng thái provider đã quan sát');

    // app_expiry chỉ được tách liên kết khách khi ẩn danh; không được lợi dụng cùng
    // ngoại lệ đó để gán đơn A sang hồ sơ khách thuộc shop B.
    const { rows: [foreignCustomer] } = await owner.query(
      `INSERT INTO customers (shop_id, full_name, phone) VALUES ($1, 'Khách B', '0900000001') RETURNING id`, [B.id],
    );
    const crossCustomer = await sqlstateOf(() => expiry.query(
      `UPDATE orders
          SET customer_name = '(đã ẩn danh)', customer_phone = NULL, customer_email = NULL,
              shipping_address = NULL, client_ip_hash = NULL, anonymized_at = now(), customer_id = $2
        WHERE id = $1`, [A.orderId, foreignCustomer.id],
    ));
    assert.equal(crossCustomer, 'PIO01', 'app_expiry không được gán customer_id tùy ý khi scrub PII');
    assert.equal((await owner.query(`SELECT customer_id FROM orders WHERE id = $1`, [A.orderId])).rows[0].customer_id, null);
    await owner.query(`DELETE FROM customers WHERE id = $1`, [foreignCustomer.id]);

    const anonymized = await expiry.query(
      `UPDATE orders
          SET customer_name = '(đã ẩn danh)', customer_phone = NULL, customer_email = NULL,
              shipping_address = NULL, client_ip_hash = NULL, anonymized_at = now()
        WHERE id = $1`, [A.orderId],
    );
    assert.equal(anonymized.rowCount, 1, 'hạn lưu PII vẫn phải áp cho đơn ngoài');
    const expiryBusinessWrite = await sqlstateOf(() => expiry.query(
      `UPDATE orders SET status = 'cancelled' WHERE id = $1`, [A.orderId],
    ));
    assert.equal(expiryBusinessWrite, 'PIO01', 'ngoại lệ ẩn danh không được mở thao tác nghiệp vụ');
    const pii = (await owner.query(
      `SELECT customer_name, customer_phone, customer_email, shipping_address, client_ip_hash,
              anonymized_at FROM orders WHERE id = $1`, [A.orderId],
    )).rows[0];
    assert.equal(pii.customer_name, '(đã ẩn danh)');
    assert.equal(pii.customer_phone, null);
    assert.equal(pii.customer_email, null);
    assert.equal(pii.shipping_address, null);
    assert.equal(pii.client_ip_hash, null);
    assert.ok(pii.anonymized_at);

    await withIntegrationTenant(A.id, (c) => c.query(
      `UPDATE orders
          SET integration_id = NULL, integration_generation = NULL,
              external_ref = NULL, sync_status = 'not_required'
        WHERE id = $1`, [A.orderId],
    ));
  });

  test('sweep chỉ lộ UUID webhook tới hạn và phục hồi được claim processing bị treo', async () => {
    const dueIds = async () => (await integration.query(
      `SELECT inbox_id FROM list_due_integration_webhooks(200) WHERE inbox_id = ANY($1::uuid[]) ORDER BY inbox_id`,
      [[wa, wb]],
    )).rows.map((r) => r.inbox_id);
    assert.deepEqual(await dueIds(), [wa, wb].sort());

    await owner.query(
      `UPDATE integration_webhook_inbox
          SET status = CASE WHEN id = $1 THEN 'processing' ELSE 'failed' END,
              claimed_at = CASE WHEN id = $1 THEN now() ELSE claimed_at END,
              next_attempt_at = CASE WHEN id = $2 THEN now() + interval '1 hour' ELSE next_attempt_at END
        WHERE id = ANY($3::uuid[])`,
      [wa, wb, [wa, wb]],
    );
    assert.deepEqual(await dueIds(), [], 'claim còn mới và retry chưa tới hạn phải được bỏ qua');

    await owner.query(
      `UPDATE integration_webhook_inbox
          SET claimed_at = CASE WHEN id = $1 THEN now() - interval '11 minutes' ELSE claimed_at END,
              next_attempt_at = CASE WHEN id = $2 THEN now() - interval '1 minute' ELSE next_attempt_at END
        WHERE id = ANY($3::uuid[])`,
      [wa, wb, [wa, wb]],
    );
    assert.deepEqual(await dueIds(), [wa, wb].sort(), 'processing treo và retry tới hạn phải quay lại sweep');
  });

  test('generation mới supersede inbox cũ và cho phép cùng event id ở vòng đời mới', async () => {
    const tag = randomUUID().slice(0, 8);
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      const shop = (await client.query(
        `INSERT INTO shops (slug, name, status) VALUES ($1,$2,'active') RETURNING id`,
        [`t-generation-${tag}`, `Shop generation ${tag}`],
      )).rows[0];
      const connector = (await client.query(
        `INSERT INTO shop_integrations
           (shop_id, provider, status, inventory_authority, credential_ciphertext, retailer,
            webhook_public_id, external_branch_ref)
         VALUES ($1,'kiotviet','degraded','local','cipher','retailer',$2,'branch')
         RETURNING id, generation`, [shop.id, randomUUID()],
      )).rows[0];
      const oldInbox = (await client.query(
        `INSERT INTO integration_webhook_inbox
           (shop_id, integration_id, generation, provider_event_id, event_type, payload_hash, payload)
         VALUES ($1,$2,$3,'evt-lap','stock.update','hash-0','{}') RETURNING id`,
        [shop.id, connector.id, connector.generation],
      )).rows[0];
      await client.query('SAVEPOINT duplicate_event');
      let duplicate = null;
      try {
        await client.query(
          `INSERT INTO integration_webhook_inbox
             (shop_id, integration_id, generation, provider_event_id, event_type, payload_hash, payload)
           VALUES ($1,$2,$3,'evt-lap','stock.update','hash-trung','{}')`,
          [shop.id, connector.id, connector.generation],
        );
      } catch (error) {
        duplicate = error.code;
        await client.query('ROLLBACK TO SAVEPOINT duplicate_event');
      }
      assert.equal(duplicate, SQLSTATE.UNIQUE_VIOLATION);

      const rotated = (await client.query(
        `UPDATE shop_integrations SET generation = generation + 1 WHERE id = $1 RETURNING generation`,
        [connector.id],
      )).rows[0];
      const status = (await client.query(
        `SELECT status, payload FROM integration_webhook_inbox WHERE id = $1`, [oldInbox.id],
      )).rows[0];
      assert.equal(status.status, 'superseded');
      assert.deepEqual(status.payload, {}, 'payload generation cũ phải được xoá khi supersede');
      const next = await client.query(
        `INSERT INTO integration_webhook_inbox
           (shop_id, integration_id, generation, provider_event_id, event_type, payload_hash, payload)
         VALUES ($1,$2,$3,'evt-lap','stock.update','hash-1','{}')`,
        [shop.id, connector.id, rotated.generation],
      );
      assert.equal(next.rowCount, 1, 'cùng provider event id ở generation mới là vòng đời độc lập');

    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('đổi cấu hình connector bắt buộc tăng generation trong cùng CAS', async () => {
    const configWithoutGeneration = await sqlstateOf(() => withTenant(A.id, (c) => c.query(
      `UPDATE shop_integrations SET external_branch_ref = 'branch-khong-cas' WHERE id = $1`,
      [ia.id],
    )));
    assert.equal(configWithoutGeneration, '23514',
      'đổi credential/chi nhánh/webhook mà không tăng generation phải bị DB chặn');
  });

  test('connector degraded + local phục hồi được sang active + external_master bằng đúng generation', async () => {
    const tag = randomUUID().slice(0, 8);
    const shop = (await owner.query(
      `INSERT INTO shops (slug, name, status) VALUES ($1,$2,'active') RETURNING id`,
      [`t-recovery-${tag}`, `Shop recovery ${tag}`],
    )).rows[0];
    const connector = (await owner.query(
      `INSERT INTO shop_integrations
         (shop_id, provider, status, inventory_authority, credential_ciphertext, retailer,
          webhook_public_id, external_branch_ref, last_error)
       VALUES ($1,'kiotviet','degraded','local','cipher','retailer',$2,'branch','mapping lỗi')
       RETURNING id, generation`, [shop.id, randomUUID()],
    )).rows[0];
    try {
      const localOrder = (await owner.query(
        `INSERT INTO orders (shop_id, order_number, status, total_vnd)
         VALUES ($1,1,'pending',100000) RETURNING id`, [shop.id],
      )).rows[0];
      const blockedByOpenOrder = await sqlstateOf(() => withIntegrationTenant(shop.id, async (c) => {
        await c.query(`SELECT set_config('app.integration_id', $1, true)`, [connector.id]);
        await c.query(`SELECT set_config('app.integration_generation', $1, true)`, [String(connector.generation)]);
        await c.query(
          `UPDATE shop_integrations
              SET status = 'active', inventory_authority = 'external_master', last_error = NULL
            WHERE id = $1 AND generation = $2`, [connector.id, connector.generation],
        );
      }));
      assert.equal(blockedByOpenOrder, '23514', 'không cutover khi còn đơn local đang thực hiện');
      await owner.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [localOrder.id]);

      const recovered = await withIntegrationTenant(shop.id, async (c) => {
        await c.query(`SELECT set_config('app.integration_id', $1, true)`, [connector.id]);
        await c.query(`SELECT set_config('app.integration_generation', $1, true)`, [String(connector.generation)]);
        return c.query(
          `UPDATE shop_integrations
              SET status = 'active', inventory_authority = 'external_master', last_error = NULL
            WHERE id = $1 AND generation = $2 RETURNING status, inventory_authority`,
          [connector.id, connector.generation],
        );
      });
      assert.deepEqual(recovered.rows[0], { status: 'active', inventory_authority: 'external_master' });

      const jump = await sqlstateOf(() => owner.query(
        `UPDATE shop_integrations SET generation = generation + 2 WHERE id = $1`, [connector.id],
      ));
      assert.equal(jump, '23514');
      const disableWithoutGeneration = await sqlstateOf(() => withTenant(shop.id, (c) => c.query(
        `UPDATE shop_integrations SET status = 'disabled' WHERE id = $1`, [connector.id],
      )));
      assert.equal(disableWithoutGeneration, '23514');
    } finally {
      await owner.query(`DELETE FROM shop_integrations WHERE id = $1`, [connector.id]);
      await owner.query(`DELETE FROM orders WHERE shop_id = $1`, [shop.id]);
      await owner.query(`DELETE FROM shops WHERE id = $1`, [shop.id]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('COMPOSITE FOREIGN KEY — lớp phòng thủ khi RLS thất bại', () => {
  test('order_line không trỏ được sang variant của shop khác', async () => {
    const code = await sqlstateOf(() =>
      // Chạy bằng OWNER (bỏ qua RLS) để cô lập đúng cơ chế đang kiểm: khoá ngoại.
      owner.query(
        `INSERT INTO order_lines
           (shop_id, order_id, variant_id, title_snapshot, sku_snapshot, unit_price_vnd, qty)
         VALUES ($1, $2, $3, 'X', 'X', 1, 1)`,
        [A.id, A.orderId, B.variantId], // ← variant của shop B
      ),
    );
    assert.equal(code, SQLSTATE.FOREIGN_KEY_VIOLATION, 'composite FK phải chặn tham chiếu chéo shop');
  });

  test('order_line không trỏ được sang order của shop khác', async () => {
    const code = await sqlstateOf(() =>
      owner.query(
        `INSERT INTO order_lines
           (shop_id, order_id, variant_id, title_snapshot, sku_snapshot, unit_price_vnd, qty)
         VALUES ($1, $2, $3, 'X', 'X', 1, 1)`,
        [A.id, B.orderId, A.variantId], // ← order của shop B
      ),
    );
    assert.equal(code, SQLSTATE.FOREIGN_KEY_VIOLATION);
  });

  test('variant không trỏ được sang product của shop khác', async () => {
    const code = await sqlstateOf(() =>
      owner.query(
        `INSERT INTO variants (shop_id, product_id, sku, price_vnd) VALUES ($1, $2, $3, 1)`,
        [A.id, B.productId, `x-${randomUUID().slice(0, 8)}`],
      ),
    );
    assert.equal(code, SQLSTATE.FOREIGN_KEY_VIOLATION);
  });

  test('tham chiếu nguồn của shop A không trỏ được sang sản phẩm shop B', async () => {
    const code = await sqlstateOf(() => owner.query(
      `INSERT INTO product_source_refs (shop_id, source, kind, external_id, product_id)
       VALUES ($1, 'tiktok', 'product', $2, $3)`,
      [A.id, `cross-${randomUUID()}`, B.productId],
    ));
    assert.equal(code, SQLSTATE.FOREIGN_KEY_VIOLATION);
  });

  test('INSERT ... SELECT từ dữ liệu shop khác chỉ chèn được 0 dòng', async () => {
    // Không ném lỗi: RLS làm sub-select rỗng. Kết quả đúng, im lặng, an toàn.
    const r = await withTenant(A.id, (c) =>
      c.query(
        `INSERT INTO order_lines
           (shop_id, order_id, variant_id, title_snapshot, sku_snapshot, unit_price_vnd, qty)
         SELECT $1, $2, v.id, 'X', v.sku, v.price_vnd, 1
         FROM variants v WHERE v.id = $3`,
        [A.id, A.orderId, B.variantId],
      ),
    );
    assert.equal(r.rowCount, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('TENANT CONTEXT — fail-closed', () => {
  test('không đặt context thì không đọc được gì', async () => {
    const r = await rw.query('SELECT id FROM products'); // ngoài withTenant
    assert.equal(r.rowCount, 0, 'phải trả rỗng, không phải trả tất cả');
  });

  test('context rỗng không làm nổ truy vấn, chỉ trả rỗng', async () => {
    // NULLIF(...,'') trong current_shop_id() ngăn lỗi "invalid input syntax for uuid".
    const client = await rw.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.shop_id', '', true)`);
      const r = await client.query('SELECT id FROM products');
      assert.equal(r.rowCount, 0);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  test('SET LOCAL hết hiệu lực sau COMMIT — connection tái sử dụng an toàn', async () => {
    // Mô phỏng PgBouncer transaction pooling: cùng một connection phục vụ shop A
    // rồi phục vụ request tiếp theo (chưa đặt context).
    const client = await rw.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.shop_id', $1, true)`, [A.id]);
      const inside = await client.query('SELECT id FROM products');
      assert.equal(inside.rowCount, 1);
      await client.query('COMMIT');

      const after = await client.query('SELECT id FROM products');
      assert.equal(after.rowCount, 0, 'context KHÔNG được sống sót qua COMMIT');
    } finally {
      client.release();
    }
  });

  test('SET session-scoped RÒ RỈ sang truy vấn sau — vì sao bắt buộc SET LOCAL', async () => {
    // Test này khẳng định một hành vi NGUY HIỂM, để nếu ai đó đổi `withTenant`
    // sang set_config(..., false) thì hiểu chính xác cái giá phải trả.
    const client = await rw.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.shop_id', $1, false)`, [A.id]); // is_local = false
      await client.query('COMMIT');

      const leaked = await client.query('SELECT id FROM products');
      assert.equal(leaked.rowCount, 1, 'session-scoped context sống sót — đây là rò rỉ');
      assert.equal(leaked.rows[0].id, A.productId);
    } finally {
      await client.query('DISCARD ALL').catch(() => {});
      client.release();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('AUDIT LOG — chỉ ghi thêm', () => {
  test('app_rw ghi được audit của shop mình', async () => {
    const r = await withTenant(A.id, (c) =>
      c.query(
        `INSERT INTO audit_logs (shop_id, actor_type, action) VALUES ($1, 'user', 'test.write')`,
        [A.id],
      ),
    );
    assert.equal(r.rowCount, 1);
  });

  test('app_rw KHÔNG sửa được audit đã ghi', async () => {
    const code = await sqlstateOf(() =>
      withTenant(A.id, (c) => c.query(`UPDATE audit_logs SET action = 'tampered'`)),
    );
    assert.equal(code, SQLSTATE.INSUFFICIENT_PRIVILEGE, 'audit log là bằng chứng, không được sửa');
  });

  test('app_rw KHÔNG xoá được audit', async () => {
    const code = await sqlstateOf(() =>
      withTenant(A.id, (c) => c.query('DELETE FROM audit_logs')),
    );
    assert.equal(code, SQLSTATE.INSUFFICIENT_PRIVILEGE);
  });

  test('audit cấp nền tảng (shop_id NULL) vô hình với nhà bán hàng', async () => {
    await owner.query(
      `INSERT INTO audit_logs (shop_id, actor_type, action) VALUES (NULL, 'platform_staff', 'shop.suspend')`,
    );
    const r = await withTenant(A.id, (c) =>
      c.query(`SELECT id FROM audit_logs WHERE action = 'shop.suspend'`),
    );
    assert.equal(r.rowCount, 0);
    await owner.query(`DELETE FROM audit_logs WHERE action = 'shop.suspend'`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SỐ ĐƠN THEO SHOP', () => {
  test('hai shop cùng có đơn số 1 — không dùng sequence toàn cục', async () => {
    // Sequence toàn cục làm lộ sản lượng: shop A đặt đơn, thấy số nhảy 1000
    // → biết đối thủ vừa bán 999 đơn.
    const { rows } = await owner.query(
      'SELECT shop_id, order_number FROM orders WHERE shop_id = ANY($1::uuid[])',
      [[A.id, B.id]],
    );
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => Number(r.order_number) === 1));
  });
});
