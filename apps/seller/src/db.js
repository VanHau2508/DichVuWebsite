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

/**
 * Tra KHOÁ KẾT NỐI (0120): token thô đã băm → shop nào, quyền gì.
 *
 * Ta CHƯA biết shop cho tới khi tra xong, mà RLS thì lọc theo shop. Đặt GUC
 * app.api_token_hash → ngả thứ hai trong USING của policy tenant_isolation mở ĐÚNG một
 * dòng khớp hash. Không có token thì GUC rỗng → không dòng nào hiện.
 *
 * Đóng dấu last_used_at PHẢI đợi tới khi đã đặt app.shop_id: ngả token chỉ có trong
 * USING (đọc), còn WITH CHECK (ghi) chỉ nhận ngả tenant — xem 0121. Nghĩa là mọi thao
 * tác GHI trên bảng khoá đều đi qua đúng một quy tắc, dù đến từ chủ shop hay từ token.
 *
 * Chỉ resolve, KHÔNG bọc luôn việc tạo đơn: createManualOrder tự mở transaction của
 * nó (withTenant), lồng vào đây là lồng transaction. Đổi lại đường tạo đơn dùng LẠI
 * nguyên vẹn — đường tiền không được có bản sao thứ hai.
 *
 * last_used_at đóng dấu ngay tại đây, kể cả khi đơn sau đó lỗi: câu hỏi cần trả lời là
 * "khoá này còn ai gọi không" (để dám thu hồi), không phải "gọi có thành công không".
 *
 * @returns {Promise<{id:string, shop_id:string, scope:string}|null>} null = sai/đã thu hồi.
 */
export async function resolveApiKey(tokenHash) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.api_token_hash', $1, true)`, [tokenHash]);
    const key = (await client.query(
      `SELECT id, shop_id, scope FROM shop_api_keys WHERE revoked_at IS NULL`,
    )).rows[0];
    if (key) {
      await client.query(`SELECT set_config('app.shop_id', $1, true)`, [key.shop_id]);
      await client.query(`UPDATE shop_api_keys SET last_used_at = now() WHERE id = $1`, [key.id]);
    }
    await client.query('COMMIT');
    return key ?? null;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Ghi audit shop-scoped. Gọi TRONG withTenant (dùng current_shop_id()). */
export async function audit(client, action, { actorId, ip, metadata = null, actorType = 'user' }) {
  await client.query(
    `INSERT INTO audit_logs (shop_id, actor_type, actor_id, action, ip, metadata)
     VALUES (current_shop_id(), $1, $2, $3, $4, $5)`,
    [actorType, actorId, action, ip, metadata],
  );
}
