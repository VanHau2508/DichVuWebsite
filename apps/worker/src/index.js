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
import { Resolver } from 'node:dns/promises';
import pg from 'pg';
import { Queue, Worker } from 'bullmq';
import nodemailer from 'nodemailer';
import { runReq, makeLog, health } from './obs.js';

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
// Pool RIÊNG cho xác minh custom domain qua DNS TXT (role app_domainverify cực hẹp — 0027).
// Thiếu env → tắt tính năng. Resolver DNS tách được (DOMAINVERIFY_RESOLVER) để e2e trỏ stub.
const DOMAINVERIFY_URL = process.env.DATABASE_URL_DOMAINVERIFY;
const domainDb = DOMAINVERIFY_URL ? new pg.Pool({ connectionString: DOMAINVERIFY_URL, max: 2 }) : null;
const DOMAINVERIFY_SWEEP_MS = Number(process.env.DOMAINVERIFY_SWEEP_MS ?? 60000);
const DOMAINVERIFY_PREFIX = process.env.DOMAINVERIFY_PREFIX ?? '_nentang-verify';
// Quá hạn này mà CHƯA verify → xoá (giải phóng hostname toàn cục, chống squat). 7 ngày.
const DOMAINVERIFY_GIVEUP_HOURS = Number(process.env.DOMAINVERIFY_GIVEUP_HOURS ?? 168);
const dnsResolver = new Resolver({ timeout: 3000, tries: 2 });
// DOMAINVERIFY_RESOLVER (dev/e2e): host[:port] của DNS stub. setServers cần IP literal nên
// phân giải host→IP một lần lúc khởi động (Docker DNS). Prod để trống → dùng resolver hệ thống.
if (process.env.DOMAINVERIFY_RESOLVER) {
  const [rhost, rport] = process.env.DOMAINVERIFY_RESOLVER.split(':');
  import('node:dns').then(({ promises }) => promises.lookup(rhost)).then(({ address }) => {
    dnsResolver.setServers([rport ? `${address}:${rport}` : address]);
    log('info', 'domainverify_resolver_set', { host: rhost, address, port: rport ?? '53' });
  }).catch((e) => log('warn', 'domainverify_resolver_lookup_failed', { message: e.message }));
}
const connection = { host: process.env.REDIS_HOST ?? 'redis', port: Number(process.env.REDIS_PORT ?? 6379) };
const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST ?? 'mailpit', port: Number(process.env.SMTP_PORT ?? 1025), secure: false });

const log = makeLog('worker');

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
  if (topic === 'order.paid') {
    return {
      subject: `Đã nhận thanh toán đơn #${p.order_number}`,
      text: `Chào ${p.customer_name || 'bạn'},\n\nChúng tôi đã nhận đủ thanh toán cho đơn hàng #${p.order_number} (${money(p.total_vnd)}).\nĐơn của bạn đang được xử lý.\n\nCảm ơn bạn!`,
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
  // connect() TRONG try: Postgres sập → chỉ log + bỏ nhịp này (KHÔNG để reject lọt ra
  // setInterval → unhandledRejection → crash-loop, làm hỏng luôn liveness).
  let c;
  try {
    c = await db.connect();
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
    if (c) await c.query('ROLLBACK').catch(() => {});
    log('error', 'poll_error', { message: e.message });
  } finally { if (c) c.release(); }
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
  let c;
  try {
    c = await expiryDb.connect(); // connect() TRONG try — DB sập không làm crash worker
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
    if (c) await c.query('ROLLBACK').catch(() => {});
    log('error', 'expiry_error', { message: e.message });
    return 0;
  } finally { if (c) c.release(); }
}

// ── sweep: xác minh custom domain qua DNS TXT (A5) ────────────────────────────
// Khách thêm TXT `_nentang-verify.<host>` = verification_token. Tra DNS NGOÀI transaction
// (chậm/ngoại vi — không giữ khoá); khớp thì UPDATE verified_at CÓ GUARD (idempotent, an
// toàn khi hai lần quét trùng). Bỏ domain quá 24h chưa xong (challenge chết). DB/DNS lỗi →
// chỉ bỏ nhịp (try/catch), không unhandledRejection → không crash-loop.
async function sweepDomainVerify() {
  if (!domainDb) return 0;
  // DỌN challenge chết: xoá dòng CHƯA verify quá hạn → giải phóng hostname (UNIQUE toàn cục) để
  // người sở hữu THẬT đăng ký lại được; chống một shop "chiếm" domain người khác bằng dòng
  // chưa-verify giữ lock mãi. Policy domainverify_gc chỉ cho xoá row verified_at IS NULL.
  try {
    const del = await domainDb.query(
      `DELETE FROM domains WHERE verified_at IS NULL AND created_at <= now() - ($1 || ' hours')::interval`,
      [String(DOMAINVERIFY_GIVEUP_HOURS)]);
    if (del.rowCount) log('info', 'domains_giveup_deleted', { n: del.rowCount });
  } catch (e) { log('error', 'domainverify_gc_error', { message: e.message }); }

  let rows;
  try {
    rows = (await domainDb.query(
      `SELECT id, hostname, verification_token FROM domains
        WHERE verified_at IS NULL AND created_at > now() - ($1 || ' hours')::interval
        ORDER BY created_at DESC LIMIT 100`, [String(DOMAINVERIFY_GIVEUP_HOURS)])).rows;
  } catch (e) { log('error', 'domainverify_query_error', { message: e.message }); return 0; }

  let verified = 0;
  for (const d of rows) {
    let txts;
    try {
      txts = await dnsResolver.resolveTxt(`${DOMAINVERIFY_PREFIX}.${d.hostname}`);
    } catch { continue; } // ENOTFOUND/ENODATA = chưa thêm TXT → bỏ qua, thử nhịp sau
    // resolveTxt trả string[][] (mỗi record là mảng chunk 255-byte) → nối rồi so khớp CHÍNH XÁC.
    if (!txts.some((chunks) => chunks.join('') === d.verification_token)) continue;
    try {
      const upd = await domainDb.query(
        `UPDATE domains SET verified_at = now() WHERE id = $1 AND verified_at IS NULL`, [d.id]);
      if (upd.rowCount === 1) { verified++; log('info', 'domain_verified', { hostname: d.hostname }); }
    } catch (e) { log('error', 'domainverify_flip_error', { message: e.message }); }
  }
  if (verified) log('info', 'domains_verified', { n: verified });
  return verified;
}

const timer = setInterval(poll, POLL_MS);
const expiryTimer = expiryDb ? setInterval(sweepExpired, EXPIRY_SWEEP_MS) : null;
const domainTimer = domainDb ? setInterval(sweepDomainVerify, DOMAINVERIFY_SWEEP_MS) : null;

// ── HTTP: health + stats (cho e2e kiểm dead-letter) ──────────────────────────
const server = http.createServer((req, res) => runReq(req, res, async () => {
  const url = new URL(req.url, 'http://internal');
  if (await health(url.pathname, res, { db: () => db.query('SELECT 1'), redis: async () => (await queue.client).ping() })) return;
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
  // Kích hoạt quét xác minh domain ngay (nội bộ — cho cron + e2e xác định).
  if (url.pathname === '/internal/verify-sweep' && req.method === 'POST') {
    const n = await sweepDomainVerify();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ verified: n }));
  }
  res.writeHead(404); res.end();
}));
server.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT }));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    clearInterval(timer);
    if (expiryTimer) clearInterval(expiryTimer);
    if (domainTimer) clearInterval(domainTimer);
    await worker.close().catch(() => {});
    await queue.close().catch(() => {});
    server.close(async () => { await db.end().catch(() => {}); await expiryDb?.end().catch(() => {}); await domainDb?.end().catch(() => {}); process.exit(0); });
  });
}
