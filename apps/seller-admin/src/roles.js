// Ma trận vai dùng chung cho SSR và BFF. Tách theo QUYỀN nghiệp vụ, không dùng một Set
// khác chỉ vì hôm nay tình cờ có cùng thành viên: refund và content có thể tách nhau sau này.
export const CATALOG_ROLES = new Set(['owner', 'admin', 'catalog_manager']);
export const ORDER_ROLES = new Set(['owner', 'admin', 'order_manager']);
export const CONTENT_ROLES = new Set(['owner', 'admin']);
export const REFUND_ROLES = new Set(['owner', 'admin']);
export const PAYMENT_ROLES = new Set(['owner']);
export const INVENTORY_ROLES = new Set(['owner', 'admin']);

