/**
 * RBAC cho seller-admin. Ma trận quyền theo docs/01 §11.
 *
 * Tách thành module thuần để test được mà không cần DB/HTTP.
 */

// Tập quyền đầy đủ (owner có tất cả).
export const ALL_PERMS = [
  'catalog.read',
  'catalog.write',
  'orders.read',
  'orders.write',
  'refund',
  'theme.write',
  'content.read',
  'content.write',
  'members.read',
  'members.write',
  'domain.write',
  'payment.write',
  'shop.write',
  'export',
  'privacy.erase', // ẩn danh dữ liệu khách (Luật BVDLCN 91/2025) — CHỈ owner, cần step-up
  'audit.read', // xem nhật ký hoạt động shop (owner + admin)
];

// Quyền theo vai trò. Owner = tất cả. Khớp đúng ma trận:
//   - Admin: sản phẩm + đơn hàng + hoàn tiền + theme + XEM nhân sự.
//            KHÔNG có members.write (đổi quyền), domain, export → chỉ Owner.
//   - Catalog Manager: chỉ sản phẩm/tồn kho.
//   - Order Manager: chỉ đơn hàng.
const ROLE_PERMS = {
  owner: new Set(ALL_PERMS),
  admin: new Set(['catalog.read', 'catalog.write', 'orders.read', 'orders.write', 'refund', 'theme.write', 'shop.write', 'content.read', 'content.write', 'members.read', 'audit.read']),
  catalog_manager: new Set(['catalog.read', 'catalog.write']),
  order_manager: new Set(['orders.read', 'orders.write']),
};

// Thao tác nhạy cảm cần step-up (xác thực lại gần đây).
export const STEP_UP_PERMS = new Set(['members.write', 'domain.write', 'payment.write', 'export', 'refund', 'privacy.erase']);

export const ROLES = Object.keys(ROLE_PERMS);

export function can(role, perm) {
  const set = ROLE_PERMS[role];
  return !!set && set.has(perm);
}

export function permsFor(role) {
  return [...(ROLE_PERMS[role] ?? [])];
}

export function needsStepUp(perm) {
  return STEP_UP_PERMS.has(perm);
}
