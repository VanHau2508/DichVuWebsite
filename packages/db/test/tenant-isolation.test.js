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
  owner,
  withTenant,
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
