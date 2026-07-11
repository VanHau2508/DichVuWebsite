/**
 * Worker — poller outbox → BullMQ → gửi email qua SMTP relay. Ngày 15.
 *
 * Kiến trúc (ADR-006):
 *   Dịch vụ ghi sự kiện vào `outbox` TRONG transaction nghiệp vụ (đã làm ở checkout).
 *   Worker gồm HAI phần:
 *     1) Poller: đọc outbox chưa xử lý (FOR UPDATE SKIP LOCKED) → đẩy vào BullMQ
 *        (jobId = ob-<id> → idempotent, không đẩy trùng) → đánh dấu processed.
 *     2) Consumer: BullMQ → gửi email. Retry + backoff; thất bại hết attempts →
 *        vào 'failed' (dead-letter).
 *
 * Vai trò app_worker CHỈ đụng outbox — payload self-contained nên không cần đọc
 * orders/PII. Bán kính ảnh hưởng cực hẹp.
 *
 * Dev gửi tới Mailpit (bắt SMTP). Prod dùng relay thật (Resend/SES) — KHÔNG tự gửi
 * cổng 25 (VPS VN hay bị chặn).
 */

import http from 'node:http';
import pg from 'pg';
import { Queue, Worker } from 'bullmq';
import nodemailer from 'nodemailer';

const PORT = Number(process.env.PORT ?? 3080);
const POLL_MS = Number(process.env.POLL_MS ?? 1000);
const ATTEMPTS = Number(process.env.EMAIL_ATTEMPTS ?? 5);
const BACKOFF_MS = Number(process.env.EMAIL_BACKOFF_MS ?? 2000);
const FROM = process.env.EMAIL_FROM ?? 'no-reply@nentang.vn';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const connection = { host: process.env.REDIS_HOST ?? 'redis', port: Number(process.env.REDIS_PORT ?? 6379) };
const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST ?? 'mailpit', port: Number(process.env.SMTP_PORT ?? 1025), secure: false });

const log = (level, event, f = {}) => process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, event, ...f }) + '\n');

const queue = new Queue('email', { connection });

// ── compose email từ sự kiện ─────────────────────────────────────────────────
function compose(topic, p) {
  const money = (v) => new Intl.NumberFormat('vi-VN').format(Number(v)) + 'đ';
  if (topic === 'order.created') {
    return {
      subject: `Xác nhận đơn hàng #${p.order_number}`,
      text: `Chào ${p.customer_name || 'bạn'},\n\nĐơn hàng #${p.order_number} đã được ghi nhận.\nTổng: ${money(p.total_vnd)} — Thanh toán: ${p.payment_method === 'qr' ? 'chuyển khoản QR' : 'COD'}.\n\nCảm ơn bạn!`,
    };
  }
  if (topic === 'order.status_changed') {
    const label = { confirmed: 'đã xác nhận', shipped: 'đang giao', delivered: 'đã giao', cancelled: 'đã huỷ' }[p.status] ?? p.status;
    return {
      subject: `Đơn hàng #${p.order_number} — ${label}`,
      text: `Đơn hàng #${p.order_number} ${label}.${p.tracking_number ? `\nMã vận đơn: ${p.tracking_number}` : ''}`,
    };
  }
  return { subject: `Thông báo`, text: JSON.stringify(p) };
}

// ── poller: outbox → queue ───────────────────────────────────────────────────
async function poll() {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const rows = (await c.query(
      `SELECT id, topic, payload FROM outbox WHERE processed_at IS NULL ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED`,
    )).rows;
    for (const r of rows) {
      await queue.add(
        r.topic, { topic: r.topic, payload: r.payload, outboxId: String(r.id) },
        { jobId: `ob-${r.id}`, attempts: ATTEMPTS, backoff: { type: 'fixed', delay: BACKOFF_MS }, removeOnComplete: { count: 500 }, removeOnFail: false },
      );
    }
    if (rows.length) await c.query(`UPDATE outbox SET processed_at = now() WHERE id = ANY($1::bigint[])`, [rows.map((r) => r.id)]);
    await c.query('COMMIT');
    if (rows.length) log('info', 'outbox_dispatched', { n: rows.length });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    log('error', 'poll_error', { message: e.message });
  } finally { c.release(); }
}

// ── consumer: queue → email ──────────────────────────────────────────────────
const worker = new Worker('email', async (job) => {
  const { topic, payload } = job.data;
  // Cờ test: email bounce vĩnh viễn → để kiểm dead-letter (chỉ dev/test).
  if (payload?.to === 'bounce@test.invalid') throw new Error('simulated permanent bounce');
  if (!payload?.to) return; // không có email → bỏ qua
  const { subject, text } = compose(topic, payload);
  await transport.sendMail({ from: FROM, to: payload.to, subject, text });
  // KHÔNG log địa chỉ email (PII). Log topic + số đơn để truy vết.
  log('info', 'email_sent', { topic, order: payload.order_number });
}, { connection, concurrency: 5 });

worker.on('failed', (job, err) => log('warn', 'email_failed', { id: job?.id, attempts: job?.attemptsMade, message: err.message }));

const timer = setInterval(poll, POLL_MS);

// ── HTTP: health + stats (cho e2e kiểm dead-letter) ──────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://internal');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
  if (url.pathname === '/stats') {
    const counts = await queue.getJobCounts('completed', 'failed', 'active', 'waiting', 'delayed');
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(counts));
  }
  res.writeHead(404); res.end();
});
server.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT }));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    clearInterval(timer);
    await worker.close().catch(() => {});
    await queue.close().catch(() => {});
    server.close(async () => { await db.end().catch(() => {}); process.exit(0); });
  });
}
