/**
 * Payment — nhận webhook đối soát chuyển khoản (SePay), đánh dấu đơn đã trả.
 *
 * HAI đường:
 *   - POST /webhooks/sepay          — key TOÀN NỀN TẢNG (SEPAY_WEBHOOK_KEY), tìm đơn
 *     theo payment_ref xuyên shop, khớp tài khoản nhận. (Mô hình 1 tài khoản nền tảng.)
 *   - POST /webhooks/sepay/<token>  — PER-SHOP: mỗi shop có token webhook riêng (bí mật,
 *     lưu hash). SePay của CHÍNH shop gọi URL này → resolve đúng shop → khớp đơn TRONG
 *     shop đó. Mô hình "tiền vào thẳng tài khoản shop". Giao dịch không khớp → hàng đợi.
 *
 * Bất biến bảo mật (ADR-007) — GIỮ NGUYÊN cho cả hai đường:
 *   - Xác thực (key toàn cục / token per-shop, timing-safe / hash). Sai → 401, KHÔNG đụng đơn.
 *   - Đối chiếu SỐ TIỀN: chỉ đủ tiền mới paid; thiếu → 'underpaid', KHÔNG paid.
 *   - provider_event_id UNIQUE → replay/trùng bị bỏ qua (idempotent).
 *   - Ràng buộc TÀI KHOẢN nhận (qr_account) — chống "đánh dấu hộ" đơn shop khác.
 *   - CHỈ webhook này (hoặc thao tác thủ công seller) mới đặt paid.
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
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const norm = (a) => String(a ?? '').replace(/\s/g, '');
const mask = (a) => { const s = String(a ?? ''); return s ? '****' + s.slice(-4) : '(none)'; };

// Parse + validate các trường SePay chung. Trả {ok:true,...} | {ok:false,status,error} | {skip}.
function parseEvent(body) {
  const eventId = String(body.id ?? '');
  const amount = Number(body.transferAmount ?? body.amount ?? NaN);
  const content = String(body.content ?? '');
  const transferType = body.transferType; // 'in' = tiền vào
  if (!eventId || !Number.isFinite(amount) || amount < 0) return { ok: false, status: 400, error: 'payload không hợp lệ' };
  if (transferType && transferType !== 'in') return { skip: 'not_incoming' };
  const t = body.transactionDate ? Date.parse(body.transactionDate) : NaN;
  if (Number.isFinite(t) && t > Date.now() + 86400000) return { ok: false, status: 400, error: 'timestamp bất thường' };
  const rcvAccount = norm(body.subAccount || body.accountNumber || ''); // '' rỗng → fallback (SePay có thể gửi subAccount rỗng)
  const m = REF_RE.exec(content.toUpperCase());
  return { ok: true, eventId, amount, content, rcvAccount, ref: m ? m[0] : null };
}

// Ghi sổ giao dịch + cộng dồn + đánh dấu paid. GIẢ ĐỊNH: context shop đã set, order đã
// tìm thấy trong shop, tài khoản đã khớp. UNIQUE(provider,event_id) chặn replay.
async function creditOrder(c, order, { eventId, amount, content, rcvAccount, body }) {
  const status = amount >= Number(order.total_vnd) ? 'received' : 'underpaid';
  // Idempotency theo (shop_id, provider, event_id) — per-shop (0036). Replay cùng shop → bỏ qua.
  const ins = await c.query(
    `INSERT INTO payment_transactions (shop_id, order_id, provider, provider_event_id, amount_vnd, status, raw)
     VALUES (current_shop_id(), $1, 'sepay', $2, $3, $4, $5)
     ON CONFLICT (shop_id, provider, provider_event_id) DO NOTHING RETURNING id`,
    [order.id, eventId, amount, status, body],
  );
  if (ins.rows.length === 0) return { matched: true, duplicate: true }; // replay → idempotent
  // Đơn KHÔNG còn "sống" (đã huỷ/hết hạn/hoàn) → KHÔNG tự xác nhận lại: tồn kho đã trả, sống
  // lại sẽ oversell + gửi email nhầm. Vẫn ghi giao dịch (tiền đã vào) + đẩy vào hàng đợi đối
  // soát để owner hoàn tiền / xử lý tay.
  if (order.status !== 'pending') {
    await persistUnmatched(c, { eventId, amount, content, rcvAccount, reason: 'order_not_live', body });
    log('warn', 'payment_on_dead_order', { ref: order.payment_ref ?? '(n/a)', order_status: order.status, amount });
    return { matched: true, paid: false, reason: 'order_not_live', order_id: order.id };
  }
  // Đủ tiền = TỔNG mọi giao dịch của đơn ≥ tổng đơn (khách có thể chuyển nhiều lần).
  const cumulative = Number((await c.query(`SELECT coalesce(sum(amount_vnd), 0)::bigint AS s FROM payment_transactions WHERE order_id = $1`, [order.id])).rows[0].s);
  const enough = cumulative >= Number(order.total_vnd);
  let paid = false;
  if (enough && order.payment_status !== 'paid') {
    const upd = await c.query(
      `UPDATE orders SET payment_status = 'paid', paid_at = now(), status = 'confirmed'
        WHERE id = $1 AND payment_status <> 'paid' AND status = 'pending'`, [order.id],
    );
    paid = upd.rowCount === 1;
    if (paid && order.customer_email) {
      await c.query(
        `INSERT INTO outbox (shop_id, topic, payload) VALUES (current_shop_id(), 'order.paid', $1)`,
        [{ to: order.customer_email, order_number: Number(order.order_number), total_vnd: Number(order.total_vnd) }],
      );
    }
  }
  log('info', 'payment_processed', { ref: order.payment_ref ?? '(n/a)', amount, cumulative, enough, paid });
  return { matched: true, paid, status, cumulative, order_id: order.id };
}

// Ghi hàng đợi giao dịch CHƯA khớp (idempotent theo shop). Context shop đã set.
async function persistUnmatched(c, { eventId, amount, content, rcvAccount, reason, body }) {
  await c.query(
    `INSERT INTO unmatched_transfers (shop_id, provider, provider_event_id, amount_vnd, content, received_account, reason, raw)
     VALUES (current_shop_id(), 'sepay', $1, $2, $3, $4, $5, $6)
     ON CONFLICT (shop_id, provider, provider_event_id) DO NOTHING`,
    [eventId, amount, content, rcvAccount || null, reason, body],
  );
}

const ORDER_COLS = 'id, shop_id, status, total_vnd, order_number, customer_email, payment_status, payment_ref, qr_account';

// ── Webhook SePay hợp nhất (Authorization: Apikey <key>) ─────────────────────
// Xác thực bằng HEADER (không để bí mật trên URL). Phân biệt:
//   - key == SEPAY_KEY (toàn nền tảng): tra đơn XUYÊN shop theo ref (mô hình 1 tài khoản).
//   - ngược lại: key = TOKEN bí mật của shop → resolve shop → cô lập trong shop đó (per-shop).
//   - không khớp cả hai → 401, KHÔNG đụng đơn.
async function sepayWebhook(req, res, body) {
  const km = /^Apikey (.+)$/s.exec(req.headers['authorization'] ?? '');
  const key = km ? km[1] : '';
  if (!key) return send(res, 401, { error: 'unauthorized' });
  const ev = parseEvent(body);
  if (!ev.ok && !ev.skip) return send(res, ev.status, { error: ev.error });
  const isGlobal = timingSafeEq(key, SEPAY_KEY);

  const result = await withTxn(async (c) => {
    let scoped = false; // per-shop: context = shop của token (dùng cho hàng đợi + cô lập đơn)
    if (!isGlobal) {
      const cfg = (await c.query(`SELECT shop_id FROM shop_payment_config WHERE sepay_token_hash = $1 AND sepay_enabled`, [sha256(key)])).rows[0];
      if (!cfg) return { unauthorized: true };
      await c.query(`SELECT set_config('app.shop_id', $1, true)`, [cfg.shop_id]);
      scoped = true;
    }
    if (ev.skip) return { matched: false, reason: ev.skip };
    // Global không quy được shop khi THIẾU ref / không thấy đơn → không ghi hàng đợi được,
    // nhưng KHÔNG nuốt im lặng: log warn để sweepMoneyAlerts/ops còn thấy (gia cố re-audit).
    if (!ev.ref) {
      if (scoped) await persistUnmatched(c, { ...ev, reason: 'no_ref', body });
      else log('warn', 'payment_global_unmatched', { reason: 'no_ref', eventId: ev.eventId, amount: ev.amount });
      return { matched: false, reason: 'no_ref' };
    }

    // CẢ HAI nhánh đều KHOÁ HÀNG (FOR UPDATE) — gộp giao dịch đồng thời (khách chuyển
    // làm nhiều lần) không đọc thiếu → không kẹt đơn ở unpaid. Trước đây chỉ per-shop
    // có khoá; global đua partial-transfer (re-audit #30). BẪY RLS: FOR UPDATE bắt dòng
    // qua thêm policy USING của UPDATE (tenant-scoped) → global phải DÒ shop trước
    // (SELECT thường, chưa khoá) → set context → khoá LẠI trong context như per-shop.
    let order;
    if (scoped) {
      order = (await c.query(`SELECT ${ORDER_COLS} FROM orders WHERE payment_ref = $1 AND shop_id = current_shop_id() FOR UPDATE`, [ev.ref])).rows[0];
    } else {
      const probe = (await c.query(`SELECT shop_id FROM orders WHERE payment_ref = $1`, [ev.ref])).rows[0];
      if (probe) {
        await c.query(`SELECT set_config('app.shop_id', $1, true)`, [probe.shop_id]);
        order = (await c.query(`SELECT ${ORDER_COLS} FROM orders WHERE payment_ref = $1 AND shop_id = current_shop_id() FOR UPDATE`, [ev.ref])).rows[0];
      }
    }
    if (!order) {
      if (scoped) await persistUnmatched(c, { ...ev, reason: 'order_not_found', body });
      else log('warn', 'payment_global_unmatched', { reason: 'order_not_found', eventId: ev.eventId, amount: ev.amount });
      return { matched: false, reason: 'order_not_found' };
    }

    const want = norm(order.qr_account);
    if (!want || ev.rcvAccount !== want) {
      log('warn', 'payment_account_mismatch', { ref: ev.ref, rcvAccount: mask(ev.rcvAccount), want: mask(want) });
      // Đơn ĐÃ tìm thấy → biết shop (context đã set cả nhánh global) → ghi hàng đợi
      // đối soát cho CẢ global (trước đây global nuốt im lặng — tiền treo vô hình).
      await persistUnmatched(c, { ...ev, reason: 'account_mismatch', body });
      return { matched: false, reason: 'account_mismatch' };
    }
    return creditOrder(c, order, { eventId: ev.eventId, amount: ev.amount, content: ev.content, rcvAccount: ev.rcvAccount, body });
  });

  if (result.unauthorized) return send(res, 401, { error: 'unauthorized' });
  return send(res, 200, result);
}

const server = http.createServer((req, res) => runReq(req, res, async () => {
  const url = new URL(req.url, 'http://internal');
  if (await health(url.pathname, res, { db: () => db.query('SELECT 1') })) return;
  try {
    if (req.method === 'POST' && url.pathname === '/webhooks/sepay') {
      return await sepayWebhook(req, res, await readJson(req));
    }
  } catch (err) {
    const st = err.statusCode ?? 500;
    if (st >= 500) log('error', 'webhook_error', { message: err.message, stack: err.stack });
    if (!res.headersSent) send(res, st, { error: st >= 500 ? 'lỗi hệ thống' : err.message });
    return;
  }
  return send(res, 404, { error: 'not found' });
}));

server.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT }));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(async () => { await db.end().catch(() => {}); process.exit(0); }));
