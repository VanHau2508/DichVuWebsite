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
// Pool RIÊNG cho job hết hạn đơn (role app_expiry cực hẹp — xem migration 0022).
// Thiếu env → tắt tính năng (worker vẫn chạy phần outbox).
const EXPIRY_URL = process.env.DATABASE_URL_EXPIRY;
const expiryDb = EXPIRY_URL ? new pg.Pool({ connectionString: EXPIRY_URL, max: 2 }) : null;
const ORDER_EXPIRY_MINUTES = Number(process.env.ORDER_EXPIRY_MINUTES ?? 30);
const EXPIRY_SWEEP_MS = Number(process.env.EXPIRY_SWEEP_MS ?? 60000);
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

// ── sweep: hết hạn đơn QR chưa trả tiền → RELEASE reserve ─────────────────────
// Đơn QR 'pending'/'unpaid' quá ORDER_EXPIRY_MINUTES: trả lại reserve + huỷ đơn.
// FOR UPDATE SKIP LOCKED → hai lần quét không xử lý trùng; guard status='pending' =
// idempotent. Release chỉ giảm reserved (KHÔNG đụng on_hand → không ghi ledger, giống cancel).
async function sweepExpired() {
  if (!expiryDb) return 0;
  const c = await expiryDb.connect();
  try {
    await c.query('BEGIN');
    const orders = (await c.query(
      `SELECT id, shop_id FROM orders
        WHERE payment_method = 'qr' AND payment_status = 'unpaid' AND status = 'pending'
          AND created_at < now() - ($1 || ' minutes')::interval
        ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED`,
      [String(ORDER_EXPIRY_MINUTES)],
    )).rows;
    for (const o of orders) {
      const lines = (await c.query(`SELECT variant_id, qty FROM order_lines WHERE order_id = $1`, [o.id])).rows;
      for (const ln of lines) {
        await c.query(
          `UPDATE inventory_levels SET reserved = GREATEST(0, reserved - $3), updated_at = now()
            WHERE shop_id = $1 AND variant_id = $2`,
          [o.shop_id, ln.variant_id, ln.qty],
        );
      }
      await c.query(`UPDATE orders SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [o.id]);
    }
    await c.query('COMMIT');
    if (orders.length) log('info', 'orders_expired', { n: orders.length });
    return orders.length;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    log('error', 'expiry_error', { message: e.message });
    return 0;
  } finally { c.release(); }
}

const timer = setInterval(poll, POLL_MS);
const expiryTimer = expiryDb ? setInterval(sweepExpired, EXPIRY_SWEEP_MS) : null;

// ── HTTP: health + stats (cho e2e kiểm dead-letter) ──────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://internal');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
  if (url.pathname === '/stats') {
    const counts = await queue.getJobCounts('completed', 'failed', 'active', 'waiting', 'delayed');
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(counts));
  }
  // Kích hoạt quét hết hạn ngay (nội bộ — không route qua Caddy; idempotent, vô hại).
  // Cho phép cron ngoài gọi đúng lịch, và để e2e kiểm chứng xác định.
  if (url.pathname === '/internal/expire-sweep' && req.method === 'POST') {
    const n = await sweepExpired();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ expired: n }));
  }
  res.writeHead(404); res.end();
});
server.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT }));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    clearInterval(timer);
    if (expiryTimer) clearInterval(expiryTimer);
    await worker.close().catch(() => {});
    await queue.close().catch(() => {});
    server.close(async () => { await db.end().catch(() => {}); await expiryDb?.end().catch(() => {}); process.exit(0); });
  });
}
