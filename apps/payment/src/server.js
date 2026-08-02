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
import net from 'node:net';
import crypto from 'node:crypto';
import pg from 'pg';
import { runReq, makeLog, health } from './obs.js';
// Bộ đếm rate-limit DÙNG CHUNG với auth (atomic Lua, FAIL-OPEN khi Redis lỗi). File
// gắn vào /app/ratelimit.js qua bind-mount trong compose.dev.yml (không copy, không sửa).
import { hit } from '../ratelimit.js';

const PORT = Number(process.env.PORT ?? 3070);
const SEPAY_KEY = process.env.SEPAY_WEBHOOK_KEY ?? '';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });

if (!SEPAY_KEY) throw new Error('thiếu SEPAY_WEBHOOK_KEY');

const log = makeLog('payment');

// ── Rate-limit hạ tầng (Đợt 6.2) ───────────────────────────────────────────────
// Image payment là bản TỐI GIẢN (chỉ src + pg), KHÔNG có ioredis. Rate-limit chỉ cần
// EVAL (cho ratelimit.js) + DEL, nên tự nói RESP qua net (built-in) — không thêm
// dependency, không rebuild image (khớp luồng dev: bind-mount + restart). Ngữ nghĩa
// GIỐNG cấu hình Redis của auth: Redis chưa sẵn sàng / lệnh quá hạn → REJECT NGAY (không
// treo); nuốt lỗi socket. hit() bắt mọi lỗi → FAIL-OPEN, không bao giờ chặn webhook thật.
function respParse(b, i) {
  if (i >= b.length) return { ok: false };
  const type = b[i];
  const nl = b.indexOf('\r\n', i + 1);
  if (nl < 0) return { ok: false };
  const line = b.toString('latin1', i + 1, nl);
  const after = nl + 2;
  if (type === 0x2b) return { ok: true, value: line, next: after };
  if (type === 0x2d) return { ok: true, value: new Error(line), next: after, err: true };
  if (type === 0x3a) return { ok: true, value: Number(line), next: after };
  if (type === 0x24) {
    const len = Number(line);
    if (len < 0) return { ok: true, value: null, next: after };
    const end = after + len;
    if (end + 2 > b.length) return { ok: false };
    return { ok: true, value: b.toString('utf8', after, end), next: end + 2 };
  }
  if (type === 0x2a) {
    const n = Number(line);
    if (n < 0) return { ok: true, value: null, next: after };
    const arr = []; let p = after;
    for (let k = 0; k < n; k++) { const el = respParse(b, p); if (!el.ok) return { ok: false }; arr.push(el.value); p = el.next; }
    return { ok: true, value: arr, next: p };
  }
  return { ok: false };
}
function makeRedis(url, { commandTimeout = 1000 } = {}) {
  const u = new URL(url);
  const host = u.hostname, port = Number(u.port || 6379);
  let sock = null, ready = false, buf = Buffer.alloc(0);
  const pending = []; // resolver theo ĐÚNG thứ tự Redis trả lời (1 kết nối = FIFO)
  function fail(err) {
    ready = false;
    while (pending.length) { const p = pending.shift(); clearTimeout(p.timer); p.reject(err); }
    if (sock) { sock.removeAllListeners(); sock.destroy(); sock = null; }
    setTimeout(connect, 500).unref();
  }
  function connect() {
    try {
      sock = net.connect({ host, port });
      sock.setNoDelay(true);
      sock.on('connect', () => { ready = true; });
      sock.on('error', () => {});
      sock.on('close', () => fail(new Error('redis closed')));
      sock.on('data', (chunk) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        let out;
        while (pending.length && (out = respParse(buf, 0)).ok) {
          buf = buf.subarray(out.next);
          const p = pending.shift(); clearTimeout(p.timer);
          out.err ? p.reject(out.value) : p.resolve(out.value);
        }
      });
    } catch { ready = false; setTimeout(connect, 500).unref(); }
  }
  function sendCmd(args) {
    return new Promise((resolve, reject) => {
      if (!ready || !sock) return reject(new Error('redis not ready')); // enableOfflineQueue:false
      let cmd = `*${args.length}\r\n`;
      for (const a of args) { const s = String(a); cmd += `$${Buffer.byteLength(s)}\r\n${s}\r\n`; }
      const timer = setTimeout(() => fail(new Error('redis timeout')), commandTimeout);
      pending.push({ resolve, reject, timer });
      sock.write(cmd);
    });
  }
  connect();
  return {
    eval: (script, numkeys, ...rest) => sendCmd(['EVAL', script, numkeys, ...rest]),
    del: (key) => sendCmd(['DEL', key]),
  };
}
// REDIS_URL vắng → không dựng client → gate tự bỏ qua (fail-open). Không chặn khởi động.
const redis = process.env.REDIS_URL ? makeRedis(process.env.REDIS_URL, { commandTimeout: 1000 }) : null;
// SePay hợp lệ post từ VÀI IP, lưu lượng thấp → 120/60s/IP là an toàn. Nếu 1 IP SePay
// hợp lệ post nhiều hơn → NÂNG qua env (không bịa số chết). 429 bảo SePay THỬ LẠI (an
// toàn — không mất thông báo thật). Cửa sổ cố định 60s.
const SEPAY_WEBHOOK_RL = Number(process.env.SEPAY_WEBHOOK_RL_PER_MIN) || 120;

// IP client SAU Caddy: Caddy (proxy tin cậy DUY NHẤT) ghi IP thật vào phần tử PHẢI NHẤT
// của X-Forwarded-For. Khớp apps/auth + checkout http.js (lấy trái nhất là giả mạo được).
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) { const parts = xff.split(','); return parts[parts.length - 1].trim(); }
  return req.socket.remoteAddress ?? 'unknown';
}

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

// Đơn CHẾT = tồn kho đã trả về, đơn đã đóng sổ. Tiền vào những đơn này KHÔNG được tự
// đánh dấu paid (sống lại sẽ oversell + gửi email nhầm) → đẩy vào hàng đợi đối soát.
//
// pending/confirmed/shipped/delivered đều là đơn SỐNG: tiền về là tiền HỢP LỆ của đơn đó.
// Trước đây điều kiện là `status !== 'pending'`, tức chỉ đơn CHƯA ai đụng mới nhận được
// tiền — nhưng chủ shop được (và UI chủ động mời) bấm "Xác nhận đơn"/xác nhận hàng loạt
// ngay khi thấy đơn mới, TRƯỚC lúc khách kịp chuyển khoản. Khách chuyển tiền thật → webhook
// trả order_not_live → đơn kẹt unpaid vĩnh viễn, phải đối soát tay. Đã dựng lại được ở a6.
const DEAD_STATUSES = new Set(['cancelled', 'refunded', 'returned']);
const LIVE_STATUSES = ['pending', 'confirmed', 'shipped', 'delivered'];

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
  if (DEAD_STATUSES.has(order.status)) {
    await persistUnmatched(c, { eventId, amount, content, rcvAccount, reason: 'order_not_live', body });
    log('warn', 'payment_on_dead_order', { ref: order.payment_ref ?? '(n/a)', order_status: order.status, amount });
    return { matched: true, paid: false, reason: 'order_not_live', order_id: order.id };
  }
  // Đủ tiền = TỔNG mọi giao dịch của đơn ≥ tổng đơn (khách có thể chuyển nhiều lần).
  const cumulative = Number((await c.query(`SELECT coalesce(sum(amount_vnd), 0)::bigint AS s FROM payment_transactions WHERE order_id = $1`, [order.id])).rows[0].s);
  const enough = cumulative >= Number(order.total_vnd);
  let paid = false;
  if (enough && order.payment_status !== 'paid') {
    // status: CHỈ đẩy pending → confirmed. Đơn đang shipped/delivered mà hạ về confirmed
    // là đi lùi máy trạng thái (mất mốc đã giao, worker chốt đơn hiểu sai).
    // amount_paid_vnd = SỐ TIỀN THẬT đã nhận, không phải total: khách chuyển thừa/thiếu thì
    // sổ phải ghi đúng cái đã vào tài khoản. Sửa đơn/hoàn tiền đọc cột này để tính hoàn.
    const upd = await c.query(
      `UPDATE orders SET payment_status = 'paid', paid_at = now(), amount_paid_vnd = $2,
              status = CASE WHEN status = 'pending' THEN 'confirmed' ELSE status END
        WHERE id = $1 AND payment_status <> 'paid' AND status = ANY($3)`, [order.id, cumulative, LIVE_STATUSES],
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
  const isGlobal = timingSafeEq(key, SEPAY_KEY);

  const result = await withTxn(async (c) => {
    // ── Tiền SHOP TRẢ CHO NỀN TẢNG (0124) — luồng KHÁC hẳn tiền khách trả cho shop ──
    // Token riêng, bảng riêng, và tuyệt đối không đụng tới orders. Trộn hai luồng là ghi
    // nhầm sổ tiền, mà sổ tiền ghi nhầm thì không có cách nào phát hiện muộn.
    if (!isGlobal) {
      const bill = (await c.query(
        `SELECT 1 FROM platform_billing_config WHERE sepay_token_hash = $1 AND enabled`, [sha256(key)],
      )).rows[0];
      if (bill) {
        const ev = parseEvent(body);
        if (!ev.ok && !ev.skip) return { badRequest: ev };
        if (ev.skip) return { matched: false, reason: ev.skip };
        // Mã hoá đơn NỀN TẢNG có định dạng RIÊNG (SUB…), khác mã đơn hàng (NTG…). Dò
        // bằng regex riêng ở đây thay vì nới REF_RE dùng chung: nới regex của đường tiền
        // ĐƠN HÀNG để phục vụ một luồng khác là mở rộng bề mặt sai ở chỗ đắt nhất.
        const bref = /SUB[0-9A-F]{10}/.exec(ev.content ?? '')?.[0] ?? null;
        if (!bref) { log('warn', 'billing_unmatched', { reason: 'no_ref', eventId: ev.eventId }); return { matched: false, reason: 'no_ref' }; }
        const ch = (await c.query(
          `SELECT id, shop_id, amount_vnd, status FROM billing_charges WHERE pay_ref = $1 FOR UPDATE`, [bref],
        )).rows[0];
        if (!ch) { log('warn', 'billing_unmatched', { reason: 'charge_not_found', ref: bref, amount: ev.amount }); return { matched: false, reason: 'charge_not_found' }; }
        // Trả TRÙNG (SePay gửi lại, hoặc shop chuyển hai lần): đã paid thì thôi, không
        // đánh dấu lại. Việc cộng hạn nằm ở worker và cũng chỉ chạy một lần (applied_at).
        if (ch.status === 'paid') return { matched: true, already: true, charge_id: ch.id };
        if (ch.status !== 'pending') { log('warn', 'billing_unmatched', { reason: 'charge_' + ch.status, ref: bref }); return { matched: false, reason: 'charge_' + ch.status }; }
        // TRẢ THIẾU thì KHÔNG cộng hạn. Hoá đơn giữ nguyên pending để shop thấy chưa xong,
        // và log để người vận hành liên hệ — cộng hạn theo số tiền thiếu là tự mất tiền.
        if (Number(ev.amount) < Number(ch.amount_vnd)) {
          log('warn', 'billing_amount_short', { ref: bref, got: ev.amount, want: Number(ch.amount_vnd), shop_id: ch.shop_id });
          return { matched: false, reason: 'amount_short' };
        }
        await c.query(`UPDATE billing_charges SET status = 'paid', paid_at = now() WHERE id = $1`, [ch.id]);
        log('info', 'billing_charge_paid', { charge_id: ch.id, shop_id: ch.shop_id, amount: ev.amount });
        return { matched: true, charge_id: ch.id };
      }
    }

    let scoped = false; // per-shop: context = shop của token (dùng cho hàng đợi + cô lập đơn)
    if (!isGlobal) {
      const cfg = (await c.query(`SELECT shop_id FROM shop_payment_config WHERE sepay_token_hash = $1 AND sepay_enabled`, [sha256(key)])).rows[0];
      if (!cfg) return { unauthorized: true };
      await c.query(`SELECT set_config('app.shop_id', $1, true)`, [cfg.shop_id]);
      scoped = true;
    }
    // XÁC THỰC XONG rồi mới đụng payload. Trước đây parseEvent chạy TRƯỚC khi kiểm key,
    // nên key SAI + payload xấu trả 400 thay vì 401 — phá đúng hợp đồng ghi ở đầu file
    // ("Sai → 401, KHÔNG đụng đơn") và biến webhook tiền thành máy dò: kẻ không có key
    // vẫn phân biệt được 400 'payload không hợp lệ' / 400 'timestamp bất thường' / 401,
    // tức là dò ra luật validate để dựng webhook giả. smoke-edge bắt được chỗ này.
    const ev = parseEvent(body);
    if (!ev.ok && !ev.skip) return { badRequest: ev };
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
  if (result.badRequest) return send(res, result.badRequest.status, { error: result.badRequest.error });
  return send(res, 200, result);
}

const server = http.createServer((req, res) => runReq(req, res, async () => {
  const url = new URL(req.url, 'http://internal');
  if (await health(url.pathname, res, { db: () => db.query('SELECT 1') })) return;
  try {
    if (req.method === 'POST' && url.pathname === '/webhooks/sepay') {
      // Cổng rate-limit per-IP (Đợt 6.2) — TRƯỚC readJson + withTxn (chưa giữ connection
      // pool, chưa parse body). FAIL-OPEN: Redis lỗi (rl.degraded) → cho qua, không bao
      // giờ âm thầm bỏ webhook thật. 429 kèm Retry-After → SePay thử lại (an toàn).
      if (redis) {
        const rl = await hit(redis, `rl:pay:webhook:ip:${clientIp(req)}`, { limit: SEPAY_WEBHOOK_RL, windowSec: 60 });
        if (!rl.allowed && !rl.degraded) {
          res.writeHead(429, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': String(rl.retryAfterSec || 60) });
          return res.end(JSON.stringify({ error: 'rate limited' }));
        }
      }
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
