/**
 * Nhật ký hoạt động shop (audit viewer) — CHỈ ĐỌC, perm audit.read (owner/admin).
 *
 * Đọc audit_logs dưới RLS app_rw: policy tenant_isolation (0004) tự cô lập theo
 * shop_id = current_shop_id(); dòng cấp identity/nền tảng (shop_id NULL — auth
 * ghi login/đổi mật khẩu…) KHÔNG bao giờ lọt (NULL = uuid → NULL → loại).
 *
 * LEFT JOIN users là bắt buộc (không phải INNER): app_rw chỉ thấy users là
 * THÀNH VIÊN HIỆN TẠI của shop (policy member_visibility, 0007). Người đã rời
 * shop / platform_staff / system → actor_email NULL nhưng dòng audit VẪN hiện —
 * INNER JOIN sẽ âm thầm nuốt các dòng đó (mất tính toàn vẹn nhật ký).
 */
import { send, parseOffset } from './http.js';
import { withTenant } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

async function listAuditLog(res, ctx, _b, _p, query) {
  const limit = Math.min(Math.max(parseInt(query.get('limit') ?? '50', 10) || 50, 1), 100);
  const offset = parseOffset(query);
  const rows = await withTenant(ctx.shopId, async (c) => (await c.query(
    // WHERE shop_id thừa so với RLS nhưng cho planner dùng audit_logs_shop_created_idx.
    `SELECT a.id, a.actor_type, a.actor_id, a.action, a.target, a.metadata, a.created_at,
            u.email AS actor_email
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.shop_id = current_shop_id()
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${limit + 1} OFFSET ${offset}`)).rows);
  const has_more = rows.length > limit;
  return send(res, 200, { entries: rows.slice(0, limit), limit, offset, has_more });
}

export const AUDIT_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/audit-log$`), perm: 'audit.read', fn: (res, ctx, b, p, q) => listAuditLog(res, ctx, b, p, q) },
];
