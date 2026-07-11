import pg from 'pg';

// app_rw: vai trò TENANT (RLS). Mọi truy vấn phải chạy qua withTenant.
export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

/**
 * Chạy fn trong một transaction có tenant context. RLS (app_rw) tự cô lập mọi
 * truy vấn theo shopId. SET LOCAL (is_local=true) phạm vi transaction → an toàn
 * với connection pool: context không rò sang request kế tiếp.
 */
export async function withTenant(shopId, fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]);
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Ghi audit shop-scoped. Gọi TRONG withTenant (dùng current_shop_id()). */
export async function audit(client, action, { actorId, ip, metadata = null }) {
  await client.query(
    `INSERT INTO audit_logs (shop_id, actor_type, actor_id, action, ip, metadata)
     VALUES (current_shop_id(), 'user', $1, $2, $3, $4)`,
    [actorId, action, ip, metadata],
  );
}
