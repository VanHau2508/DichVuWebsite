/**
 * Chạy một nhóm số liệu Tổng quan trong savepoint riêng.
 *
 * Nhóm tùy chọn được phép lỗi mà không làm mất snapshot lõi, nhưng lỗi phải được ghi lại
 * để seller-admin không biến dữ liệu thiếu thành số 0 giả.
 */
export async function withOptionalDashboardGroup(client, partial, name, fn, fallback = null) {
  const savepoint = `dashboard_${name}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    const value = await fn();
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return value;
  } catch {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    partial.push(name);
    return fallback;
  }
}
