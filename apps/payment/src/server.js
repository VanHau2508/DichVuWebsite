/**
 * Payment — nhận webhook đối soát chuyển khoản (SePay/Casso), đánh dấu đơn đã trả.
 *
 * Đây là endpoint CÔNG KHAI được nhà cung cấp gọi. Bất biến bảo mật (ADR-007):
 *   - Xác thực API key (timing-safe). Sai key → 401, KHÔNG đụng đơn.
 *   - Đối chiếu SỐ TIỀN: chỉ đủ tiền mới paid; thiếu → ghi 'underpaid', KHÔNG paid.
 *   - provider_event_id UNIQUE → replay/trùng bị bỏ qua (idempotent).
 *   - CHỈ webhook này (hoặc thao tác thủ công seller) mới đặt paid. KHÔNG có endpoint
 *     nào cho trình duyệt tự đánh dấu paid.
 *
 * KHÔNG resolve theo Host: nhà cung cấp gọi một URL nền tảng cố định. Tìm đơn theo
 * payment_ref (duy nhất toàn nền tảng) qua vai trò app_payment (đọc cột KHÔNG-PII).
 */

import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import { runReq, makeLog, health } from './obs.js';

const PORT = Number(process.env.PORT ?? 3070);
const SEPAY_KEY = process.env.SEPAY_WEBHOOK_KEY ?? '';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });

if (!SEPAY_KEY) throw new Error('thiếu SEPAY_WEBHOOK_KEY');

const log = makeLog('payment');

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 64 * 1024) { reject(Object.assign(new Error('too big'), { statusCode: 413 })); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('bad json'), { statusCode: 400 })); } });
    req.on('error', reject);
  });
}
function send(res, status, body) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

async function withTxn(fn) {
  const c = await db.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

const REF_RE = /NTG[0-9A-F]{12}/;

async function sepayWebhook(req, res, body) {
  // 1) Xác thực API key trước MỌI thứ.
  if (!timingSafeEq(req.headers['authorization'] ?? '', `Apikey ${SEPAY_KEY}`)) {
    return send(res, 401, { error: 'unauthorized' });
  }

  const eventId = String(body.id ?? '');
  const amount = Number(body.transferAmount ?? body.amount ?? NaN);
  const content = String(body.content ?? '');
  const transferType = body.transferType; // 'in' = tiền vào
  if (!eventId || !Number.isFinite(amount) || amount < 0) return send(res, 400, { error: 'payload không hợp lệ' });

  // Chỉ xử lý giao dịch TIỀN VÀO.
  if (transferType && transferType !== 'in') return send(res, 200, { matched: false, reason: 'not_incoming' });

  // Timestamp bất thường (tương lai xa) → từ chối. Replay cũ đã có UNIQUE chặn.
  const t = body.transactionDate ? Date.parse(body.transactionDate) : NaN;
  if (Number.isFinite(t) && t > Date.now() + 86400000) return send(res, 400, { error: 'timestamp bất thường' });

  const m = REF_RE.exec(content.toUpperCase());
  if (!m) return send(res, 200, { matched: false, reason: 'no_ref' });
  const ref = m[0];

  // Tài khoản NHẬN tiền mà SePay báo. Bắt buộc để chống "đánh dấu hộ" đơn shop khác.
  const rcvAccount = String(body.subAccount ?? body.accountNumber ?? '').replace(/\s/g, '');

  // Mask tài khoản trong log — KHÔNG lộ số tài khoản đầy đủ (chỉ 4 số cuối).
  const mask = (a) => { const s = String(a ?? ''); return s ? '****' + s.slice(-4) : '(none)'; };

  const result = await withTxn(async (c) => {
    // Tra đơn theo payment_ref (payment_read USING(true) — không cần context).
    const order = (await c.query(
      `SELECT id, shop_id, total_vnd, order_number, customer_email, payment_status, qr_account FROM orders WHERE payment_ref = $1`, [ref],
    )).rows[0];
    if (!order) return { matched: false, reason: 'order_not_found' };

    // Ràng buộc tài khoản: tiền phải vào ĐÚNG tài khoản của shop sở hữu đơn.
    // Không có ràng buộc này, kẻ tấn công chuyển tiền vào tài khoản CỦA MÌNH kèm
    // ref đơn shop khác để đánh dấu paid hộ (rà soát bảo mật Ngày 14).
    const want = String(order.qr_account ?? '').replace(/\s/g, '');
    if (!want || rcvAccount !== want) {
      log('warn', 'payment_account_mismatch', { ref, rcvAccount: mask(rcvAccount), want: mask(want) });
      return { matched: false, reason: 'account_mismatch' };
    }

    // Đặt context = shop của đơn cho các ghi tiếp theo (RLS scoped).
    await c.query(`SELECT set_config('app.shop_id', $1, true)`, [order.shop_id]);

    // status per-txn = giao dịch NÀY có đủ tổng đơn một mình không (bản ghi lịch sử).
    const status = amount >= Number(order.total_vnd) ? 'received' : 'underpaid';

    // Ghi sổ giao dịch — UNIQUE(provider, event_id) chặn replay.
    const ins = await c.query(
      `INSERT INTO payment_transactions (shop_id, order_id, provider, provider_event_id, amount_vnd, status, raw)
       VALUES (current_shop_id(), $1, 'sepay', $2, $3, $4, $5)
       ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`,
      [order.id, eventId, amount, status, body],
    );
    if (ins.rows.length === 0) return { matched: true, duplicate: true }; // replay → idempotent

    // GỘP nhiều giao dịch: đủ tiền = TỔNG mọi giao dịch của đơn ≥ tổng đơn (khách có
    // thể chuyển làm nhiều lần). Bao gồm giao dịch vừa chèn.
    const cumulative = Number((await c.query(`SELECT coalesce(sum(amount_vnd), 0)::bigint AS s FROM payment_transactions WHERE order_id = $1`, [order.id])).rows[0].s);
    const enough = cumulative >= Number(order.total_vnd);

    let paid = false;
    if (enough && order.payment_status !== 'paid') {
      const upd = await c.query(
        `UPDATE orders SET payment_status = 'paid', paid_at = now(), status = 'confirmed'
          WHERE id = $1 AND payment_status <> 'paid'`, [order.id],
      );
      paid = upd.rowCount === 1;
      // Phát order.paid TRONG cùng transaction → worker gửi biên nhận. Chỉ khi có email.
      if (paid && order.customer_email) {
        await c.query(
          `INSERT INTO outbox (shop_id, topic, payload) VALUES (current_shop_id(), 'order.paid', $1)`,
          [{ to: order.customer_email, order_number: Number(order.order_number), total_vnd: Number(order.total_vnd) }],
        );
      }
    }
    log('info', 'payment_processed', { ref, amount, cumulative, enough, paid });
    return { matched: true, paid, status, cumulative, order_id: order.id };
  });

  return send(res, 200, result);
}

const server = http.createServer((req, res) => runReq(req, res, async () => {
  const url = new URL(req.url, 'http://internal');
  if (await health(url.pathname, res, { db: () => db.query('SELECT 1') })) return;
  if (req.method === 'POST' && url.pathname === '/webhooks/sepay') {
    try {
      const body = await readJson(req);
      return await sepayWebhook(req, res, body);
    } catch (err) {
      const st = err.statusCode ?? 500;
      if (st >= 500) log('error', 'webhook_error', { message: err.message, stack: err.stack });
      if (!res.headersSent) send(res, st, { error: st >= 500 ? 'lỗi hệ thống' : err.message });
      return;
    }
  }
  return send(res, 404, { error: 'not found' });
}));

server.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT }));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(async () => { await db.end().catch(() => {}); process.exit(0); }));
