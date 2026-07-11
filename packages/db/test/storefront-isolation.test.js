/**
 * Cô lập vai trò storefront công khai (app_store).
 *
 * Chứng minh RLS làm app_store KHÔNG THỂ nhìn thấy (về mặt cấu trúc):
 *   - sản phẩm draft/archived (chỉ active),
 *   - media pending/failed (chỉ ready),
 *   - dữ liệu shop khác,
 *   - và app_store KHÔNG ghi được gì (chỉ đọc).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { owner, closeAll } from './helpers.js';

const store = new pg.Pool({ connectionString: process.env.DATABASE_URL_STORE, max: 3 });

/** Chạy query như app_store trong context của shopId. */
async function asStore(shopId, fn) {
  const c = await store.connect();
  try {
    await c.query('BEGIN');
    if (shopId) await c.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

let A, B;

before(async () => {
  const mk = async (slug) => {
    const shop = (await owner.query(`INSERT INTO shops (slug,name,status) VALUES ($1,$2,'active') RETURNING id`, [`${slug}-${randomUUID().slice(0, 6)}`, slug])).rows[0];
    const active = (await owner.query(`INSERT INTO products (shop_id,slug,title,price_vnd,status) VALUES ($1,'p-active','Active',1000,'active') RETURNING id`, [shop.id])).rows[0];
    const draft = (await owner.query(`INSERT INTO products (shop_id,slug,title,price_vnd,status) VALUES ($1,'p-draft','Draft',1000,'draft') RETURNING id`, [shop.id])).rows[0];
    await owner.query(`INSERT INTO variants (shop_id,product_id,sku,price_vnd) VALUES ($1,$2,$3,1000)`, [shop.id, active.id, `A-${randomUUID().slice(0, 6)}`]);
    await owner.query(`INSERT INTO variants (shop_id,product_id,sku,price_vnd) VALUES ($1,$2,$3,1000)`, [shop.id, draft.id, `D-${randomUUID().slice(0, 6)}`]);
    await owner.query(`INSERT INTO media (shop_id,product_id,status,original_key,public_key) VALUES ($1,$2,'ready','o1','pub1')`, [shop.id, active.id]);
    await owner.query(`INSERT INTO media (shop_id,product_id,status,original_key) VALUES ($1,$2,'pending','o2')`, [shop.id, active.id]);
    await owner.query(`INSERT INTO themes (shop_id,tokens) VALUES ($1,'{"color":{"primary":"#f00"}}')`, [shop.id]);
    return { id: shop.id, activeId: active.id, draftId: draft.id };
  };
  A = await mk('store-a');
  B = await mk('store-b');
});

after(async () => {
  for (const t of ['media', 'variants', 'product_categories', 'products', 'themes']) {
    await owner.query(`DELETE FROM ${t} WHERE shop_id = ANY($1::uuid[])`, [[A.id, B.id]]);
  }
  await owner.query(`DELETE FROM shops WHERE id = ANY($1::uuid[])`, [[A.id, B.id]]);
  await store.end();
  await closeAll();
});

describe('app_store — chỉ thấy dữ liệu công khai', () => {
  test('chỉ thấy sản phẩm active, KHÔNG thấy draft', async () => {
    const rows = await asStore(A.id, (c) => c.query('SELECT id, status FROM products'));
    const ids = rows.rows.map((r) => r.id);
    assert.ok(ids.includes(A.activeId), 'phải thấy sản phẩm active');
    assert.ok(!ids.includes(A.draftId), 'KHÔNG được thấy sản phẩm draft');
    assert.ok(rows.rows.every((r) => r.status === 'active'));
  });

  test('chỉ thấy media ready, KHÔNG thấy pending', async () => {
    const rows = await asStore(A.id, (c) => c.query('SELECT status FROM media'));
    assert.ok(rows.rows.length >= 1);
    assert.ok(rows.rows.every((r) => r.status === 'ready'), 'chỉ media ready');
  });

  test('biến thể của sản phẩm draft cũng bị ẩn', async () => {
    // Chỉ biến thể của sản phẩm active mới hiện.
    const rows = await asStore(A.id, (c) =>
      c.query('SELECT v.id FROM variants v JOIN products p ON p.id = v.product_id'));
    assert.equal(rows.rows.length, 1, 'chỉ 1 biến thể (của sản phẩm active)');
  });

  test('thấy theme của shop', async () => {
    const rows = await asStore(A.id, (c) => c.query('SELECT tokens FROM themes'));
    assert.equal(rows.rows.length, 1);
  });

  test('KHÔNG thấy dữ liệu shop khác', async () => {
    const rows = await asStore(A.id, (c) => c.query('SELECT id FROM products WHERE id = $1', [B.activeId]));
    assert.equal(rows.rowCount, 0);
  });

  test('resolve domain không cần context', async () => {
    // store_lookup policy USING(true) trên domains.
    const rows = await asStore(null, (c) => c.query('SELECT 1 FROM domains LIMIT 1'));
    assert.ok(rows.rowCount <= 1); // chạy được, không lỗi quyền
  });

  test('KHÔNG có context → không thấy sản phẩm nào (fail-closed)', async () => {
    const rows = await asStore(null, (c) => c.query('SELECT id FROM products'));
    assert.equal(rows.rowCount, 0);
  });

  test('app_store KHÔNG ghi được (chỉ đọc)', async () => {
    for (const q of [
      `INSERT INTO products (shop_id,slug,title,price_vnd,status) VALUES ($1,'x','X',1,'active')`,
      `UPDATE products SET title = 'hacked' WHERE id = $1`,
      `DELETE FROM products WHERE id = $1`,
    ]) {
      const code = await asStore(A.id, async (c) => {
        try { await c.query(q, [A.id]); return null; } catch (e) { return e.code; }
      });
      assert.equal(code, '42501', `phải bị từ chối quyền: ${q.slice(0, 20)}`);
    }
  });
});
