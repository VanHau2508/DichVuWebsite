/**
 * Hỏi đáp sản phẩm (0100) — duyệt + TRẢ LỜI. Khách gửi qua checkout → PENDING; chỉ câu hỏi
 * ĐÃ DUYỆT mới hiện trên storefront. Perm content.write (owner/admin), giống đánh giá.
 *
 * Khác đánh giá một điểm quan trọng: câu hỏi mà KHÔNG có câu trả lời thì duyệt lên trang
 * sản phẩm chỉ tổ hại (khách thấy câu hỏi bỏ ngỏ = shop không chăm). Nên `answer` phải có
 * TRƯỚC hoặc CÙNG lúc duyệt — cưỡng chế ở approve.
 */
import { send } from './http.js';
import { withTenant, audit } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

async function listQuestions(res, ctx, _b, _p, query) {
  const status = ['pending', 'approved', 'rejected'].includes(query.get('status')) ? query.get('status') : 'pending';
  const limit = Math.min(Math.max(parseInt(query.get('limit') ?? '50', 10) || 50, 1), 100);
  const data = await withTenant(ctx.shopId, async (c) => {
    const rows = (await c.query(
      `SELECT q.id, q.product_id, q.asker_name, q.question, q.answer, q.answered_at, q.status, q.created_at,
              p.title AS product_title, p.slug AS product_slug
         FROM product_questions q JOIN products p ON p.id = q.product_id
        WHERE q.status = $1 ORDER BY q.created_at DESC LIMIT ${limit}`, [status])).rows;
    const pending = Number((await c.query(
      `SELECT count(*)::int n FROM product_questions WHERE status = 'pending'`)).rows[0].n);
    return { questions: rows, pending_count: pending };
  });
  return send(res, 200, { ...data, status });
}

// TRẢ LỜI + (tuỳ chọn) DUYỆT LUÔN trong một thao tác — chủ shop gõ câu trả lời rồi bấm
// "Trả lời & đăng" là xong, không phải bấm hai nút ở hai chỗ.
async function answerQuestion(res, ctx, body, params) {
  const qid = params[1];
  const answer = String(body?.answer ?? '').trim();
  if (!answer) return send(res, 400, { error: 'câu trả lời không được để trống' });
  if (answer.length > 1000) return send(res, 400, { error: 'câu trả lời tối đa 1000 ký tự' });
  const publish = body?.publish !== false;   // mặc định trả lời là đăng luôn
  const n = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(
      `UPDATE product_questions
          SET answer = $2, answered_at = now()${publish ? `, status = 'approved'` : ''}
        WHERE id = $1`, [qid, answer]);
    if (r.rowCount === 1) {
      await audit(c, publish ? 'question.answered' : 'question.draft_answer',
        { actorId: ctx.user.id, ip: ctx.ip, metadata: { questionId: qid } });
    }
    return r.rowCount;
  });
  if (n !== 1) return send(res, 404, { error: 'không tìm thấy câu hỏi' });
  return send(res, 200, { ok: true, status: publish ? 'approved' : 'pending' });
}

// Từ chối (spam / câu hỏi không liên quan) — không cần câu trả lời.
async function rejectQuestion(res, ctx, _b, params) {
  const qid = params[1];
  const n = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(`UPDATE product_questions SET status = 'rejected' WHERE id = $1`, [qid]);
    if (r.rowCount === 1) await audit(c, 'question.rejected', { actorId: ctx.user.id, ip: ctx.ip, metadata: { questionId: qid } });
    return r.rowCount;
  });
  if (n !== 1) return send(res, 404, { error: 'không tìm thấy câu hỏi' });
  return send(res, 200, { ok: true, status: 'rejected' });
}

async function deleteQuestion(res, ctx, _b, params) {
  const qid = params[1];
  const n = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(`DELETE FROM product_questions WHERE id = $1`, [qid]);
    if (r.rowCount === 1) await audit(c, 'question.deleted', { actorId: ctx.user.id, ip: ctx.ip, metadata: { questionId: qid } });
    return r.rowCount;
  });
  if (n !== 1) return send(res, 404, { error: 'không tìm thấy câu hỏi' });
  return send(res, 200, { ok: true });
}

export const QUESTION_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/questions$`), perm: 'content.write', fn: (res, ctx, b, p, q) => listQuestions(res, ctx, b, p, q) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/questions/${UUID}/answer$`), perm: 'content.write', fn: (res, ctx, b, p) => answerQuestion(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/questions/${UUID}/reject$`), perm: 'content.write', fn: (res, ctx, b, p) => rejectQuestion(res, ctx, b, p) },
  { m: 'DELETE', re: new RegExp(`^/shops/${UUID}/questions/${UUID}$`), perm: 'content.write', fn: (res, ctx, b, p) => deleteQuestion(res, ctx, b, p) },
];
