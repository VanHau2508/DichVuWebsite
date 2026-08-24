import pg from 'pg';
import { randomUUID } from 'node:crypto';

export const rw = new pg.Pool({ connectionString: process.env.DATABASE_URL_RW, max: 5 });
export const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
export const integration = new pg.Pool({ connectionString: process.env.DATABASE_URL_INTEGRATION, max: 3 });
export const expiry = new pg.Pool({ connectionString: process.env.DATABASE_URL_EXPIRY, max: 2 });

export async function closeAll() {
  await Promise.all([rw.end(), owner.end(), integration.end(), expiry.end()]);
}

/**
 * Đặt tenant context cho đúng một transaction, rồi chạy fn.
 *
 * `set_config(..., is_local => true)` tương đương `SET LOCAL`: phạm vi
 * TRANSACTION. Đây là điểm mấu chốt khi dùng PgBouncer ở chế độ transaction
 * pooling — connection được trả về pool sau mỗi COMMIT và tái sử dụng cho
 * request của shop khác.
 *
 * Dùng `SET` (session-scoped) thay vì `SET LOCAL` sẽ khiến shop_id sống sót
 * sang request kế tiếp trên cùng connection. Đó là rò rỉ dữ liệu chéo tenant,
 * và nó im lặng. Có một test riêng chứng minh điều này ở tenant-isolation.test.js.
 *
 * Dùng set_config() có tham số hoá thay vì nối chuỗi `SET LOCAL app.shop_id = '...'`
 * để shop_id không bao giờ trở thành đường SQL injection.
 */
export async function withTenant(shopId, fn) {
  const client = await rw.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function withIntegrationTenant(shopId, fn) {
  const client = await integration.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Bắt SQLSTATE thay vì so khớp chuỗi thông báo — thông báo đổi theo phiên bản. */
export async function sqlstateOf(fn) {
  try {
    await fn();
    return null; // không ném lỗi
  } catch (err) {
    return err.code ?? 'UNKNOWN';
  }
}

export const SQLSTATE = {
  INSUFFICIENT_PRIVILEGE: '42501', // gồm cả "new row violates row-level security policy"
  FOREIGN_KEY_VIOLATION: '23503',
  UNIQUE_VIOLATION: '23505',
};

/**
 * Tạo hai shop độc lập, mỗi shop có product → variant → order → order_line.
 * Chạy bằng role owner (superuser) nên bỏ qua RLS — đúng như migration/seed thật.
 */
export async function seedTwoShops() {
  const tag = randomUUID().slice(0, 8);
  const shops = {};

  for (const key of ['a', 'b']) {
    const {
      rows: [shop],
    } = await owner.query(
      `INSERT INTO shops (slug, name, status) VALUES ($1, $2, 'active') RETURNING id`,
      [`t-${key}-${tag}`, `Shop ${key.toUpperCase()} ${tag}`],
    );

    const {
      rows: [product],
    } = await owner.query(
      `INSERT INTO products (shop_id, slug, title, price_vnd, status)
       VALUES ($1, 'ao-thun', 'Áo thun', 250000, 'active') RETURNING id`,
      [shop.id],
    );

    const {
      rows: [variant],
    } = await owner.query(
      `INSERT INTO variants (shop_id, product_id, sku, price_vnd)
       VALUES ($1, $2, $3, 250000) RETURNING id`,
      [shop.id, product.id, `SKU-${key}-${tag}`],
    );

    // order_number = 1 ở CẢ HAI shop: số đơn đánh theo shop, không toàn cục.
    const {
      rows: [order],
    } = await owner.query(
      `INSERT INTO orders (shop_id, order_number, total_vnd) VALUES ($1, 1, 250000) RETURNING id`,
      [shop.id],
    );

    await owner.query(
      `INSERT INTO order_lines
         (shop_id, order_id, variant_id, title_snapshot, sku_snapshot, unit_price_vnd, qty)
       VALUES ($1, $2, $3, 'Áo thun', $4, 250000, 1)`,
      [shop.id, order.id, variant.id, `SKU-${key}-${tag}`],
    );

    await owner.query(
      `INSERT INTO shop_counters (shop_id, name, value) VALUES ($1, 'order_number', 1)`,
      [shop.id],
    );

    shops[key] = { id: shop.id, productId: product.id, variantId: variant.id, orderId: order.id };
  }

  return shops;
}

/** Xoá đúng dữ liệu đã tạo, theo thứ tự ngược của khoá ngoại. */
export async function cleanupShops(shops) {
  const ids = Object.values(shops).map((s) => s.id);
  for (const table of [
    'integration_webhook_inbox',
    'integration_entity_refs',
    'integration_sync_discrepancies',
    'order_lines',
    'orders',
    'shop_integrations',
    'variants',
    'products',
    'shop_counters',
    'idempotency_keys',
    'outbox',
    'audit_logs',
    'domains',
  ]) {
    await owner.query(`DELETE FROM ${table} WHERE shop_id = ANY($1::uuid[])`, [ids]);
  }
  await owner.query(`DELETE FROM shops WHERE id = ANY($1::uuid[])`, [ids]);
}
