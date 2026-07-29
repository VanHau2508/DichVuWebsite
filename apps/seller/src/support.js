/**
 * Yêu cầu hỗ trợ (0107) — người bán gửi từ seller-admin, chủ nền tảng nhận.
 *
 * Đặt ở seller (không phải platform) vì người GỬI là thành viên shop và mọi thứ đã đi qua
 * withTenant + RLS sẵn có: phiếu tự động gắn đúng shop, và người bán không đọc được phiếu
 * của shop khác mà không cần thêm một dòng kiểm quyền nào.
 *
 * Không có perm riêng: MỌI thành viên shop đều gửi được. Bắt phải có quyền cấu hình mới kêu
 * cứu được là chặn đúng người đang cần giúp — nhân viên bán hàng gặp lỗi lúc 9 giờ tối thì
 * họ là người duy nhất có mặt.
 */

import { send } from './http.js';
import { withTenant, audit } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const MAX_SUBJECT = 200;
const MAX_BODY = 5000;
// Trần phiếu MỞ mỗi shop: chống một người bấm gửi hàng trăm lần (hoặc script) làm ngập hàng
// đợi của chủ nền tảng. Không dùng rate-limit theo thời gian vì người đang gặp sự cố thật có
// thể gửi vài phiếu liên tiếp — chặn theo SỐ PHIẾU CHƯA XỬ mới đúng thứ ta muốn giới hạn.
const MAX_OPEN_PER_SHOP = 20;

const str = (v) => String(v ?? '').trim();

async function createTicket(res, ctx, body) {
  const subject = str(body.subject).slice(0, MAX_SUBJECT);
  const content = str(body.body).slice(0, MAX_BODY);
  const contextUrl = str(body.context_url).slice(0, 500) || null;
  if (!subject) return send(res, 400, { error: 'thiếu tiêu đề' });
  if (!content) return send(res, 400, { error: 'thiếu nội dung' });

  const out = await withTenant(ctx.shopId, async (c) => {
    const open = Number((await c.query(
      `SELECT count(*)::int n FROM support_tickets WHERE status = 'open'`)).rows[0].n);
    if (open >= MAX_OPEN_PER_SHOP) return { tooMany: true };

    // from_email CHÉP LẠI (0108) chứ không để console JOIN users: app_platform không có quyền
    // nào trên bảng users, và phiếu phải nhớ ai gửi kể cả khi người đó rời shop sau này.
    const t = (await c.query(
      `INSERT INTO support_tickets (shop_id, user_id, subject, body, context_url, from_email)
       VALUES (current_shop_id(), $1, $2, $3, $4, $5) RETURNING id, created_at`,
      [ctx.user.id, subject, content, contextUrl, ctx.user.email ?? null],
    )).rows[0];

    // Outbox (ADR-006) CÙNG TRANSACTION với phiếu: không có chuyện báo cho chủ nền tảng một
    // phiếu chưa tồn tại, cũng không có phiếu nằm im không ai biết.
    await c.query(
      `INSERT INTO outbox (shop_id, topic, payload) VALUES (current_shop_id(), 'support.ticket_created', $1)`,
      [{ ticket_id: t.id, subject, from: ctx.user.email ?? null, context_url: contextUrl }],
    );
    await audit(c, 'support.ticket_created', { actorId: ctx.user.id, ip: ctx.ip, metadata: { ticketId: t.id } });
    return { id: t.id, created_at: t.created_at };
  });

  if (out.tooMany) {
    return send(res, 429, { error: `đang có ${MAX_OPEN_PER_SHOP} yêu cầu chưa được xử lý — vui lòng chờ phản hồi trước khi gửi thêm` });
  }
  return send(res, 201, out);
}

async function listTickets(res, ctx) {
  const rows = await withTenant(ctx.shopId, async (c) => (await c.query(
    `SELECT id, subject, body, context_url, status, created_at, resolved_at, resolution_note
       FROM support_tickets ORDER BY created_at DESC LIMIT 50`)).rows);
  return send(res, 200, { tickets: rows });
}

export const SUPPORT_ROUTES = [
  // perm 'orders.read' = "là thành viên shop và đọc được việc của shop" — mức thấp nhất mà
  // mọi vai đều có. Cố ý KHÔNG đặt perm cấu hình.
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/support$`), perm: 'orders.read', fn: (res, ctx) => listTickets(res, ctx) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/support$`), perm: 'orders.read', fn: (res, ctx, b) => createTicket(res, ctx, b) },
];
