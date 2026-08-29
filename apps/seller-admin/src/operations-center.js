/**
 * Tách trạng thái danh sách vận đơn khỏi trạng thái truy vấn đếm trong nhóm `todo`.
 * Hai nhóm chạy ở hai savepoint khác nhau: đếm lỗi không được che các dòng đã đọc được.
 */
export function shipmentAttentionPresentation(failedGroups, todoItem, rows) {
  const unavailable = failedGroups.has('shipment_attention');
  const count = todoItem?.available === false || !Number.isFinite(todoItem?.n) ? null : todoItem.n;
  return {
    unavailable,
    count,
    shouldRender: unavailable || rows.length > 0 || (count != null && count > 0),
  };
}
