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
import crypto from 'node:crypto';
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
// Đơn COD 'pending' quá lâu mà shop chưa xác nhận → tự huỷ, trả tồn (chống đơn ảo giữ kho).
// Dài hơn QR nhiều (QR chờ chuyển khoản; COD chờ shop xử lý) — mặc định 7 ngày.
const COD_EXPIRY_DAYS = Number(process.env.COD_EXPIRY_DAYS ?? 7);
const EXPIRY_SWEEP_MS = Number(process.env.EXPIRY_SWEEP_MS ?? 60000);
// Pool RIÊNG cho xác minh custom domain qua DNS TXT (role app_domainverify cực hẹp — 0027).
// Thiếu env → tắt tính năng. Resolver DNS tách được (DOMAINVERIFY_RESOLVER) để e2e trỏ stub.
const DOMAINVERIFY_URL = process.env.DATABASE_URL_DOMAINVERIFY;
const domainDb = DOMAINVERIFY_URL ? new pg.Pool({ connectionString: DOMAINVERIFY_URL, max: 2 }) : null;
const DOMAINVERIFY_SWEEP_MS = Number(process.env.DOMAINVERIFY_SWEEP_MS ?? 60000);
const DOMAINVERIFY_PREFIX = process.env.DOMAINVERIFY_PREFIX ?? '_nentang-verify';
// Quá hạn này mà CHƯA verify → xoá (giải phóng hostname toàn cục, chống squat). 7 ngày.
const DOMAINVERIFY_GIVEUP_HOURS = Number(process.env.DOMAINVERIFY_GIVEUP_HOURS ?? 168);
// Pool RIÊNG cho vòng đời thuê bao (role app_billing cực hẹp — 0033). Thiếu env → tắt.
const BILLING_URL = process.env.DATABASE_URL_BILLING;
const billingDb = BILLING_URL ? new pg.Pool({ connectionString: BILLING_URL, max: 2 }) : null;
// Poll trạng thái vận đơn hãng VC (GHN/GHTK — 0044). Dùng CHUNG pool app_expiry (role
// tự động hoá vòng đời đơn). Cần thêm SHIPPING_ENC_KEY (giải mã token per-shop) — thiếu → tắt.
const SHIPPING_ENC_KEY = process.env.SHIPPING_ENC_KEY ?? '';
const TRACKING_ON = /^[0-9a-f]{64}$/i.test(SHIPPING_ENC_KEY);
const TRACKING_SWEEP_MS = Number(process.env.TRACKING_SWEEP_MS ?? 600000); // 10 phút
const SUBSCRIPTION_SWEEP_MS = Number(process.env.SUBSCRIPTION_SWEEP_MS ?? 3600000); // 1 giờ
const SUBSCRIPTION_GRACE_DAYS = Number(process.env.SUBSCRIPTION_GRACE_DAYS ?? 7);
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
// Payload SELF-CONTAINED (worker không đọc orders). p.link (nếu có) = URL tra cứu đơn.
function compose(topic, p) {
  const money = (v) => new Intl.NumberFormat('vi-VN').format(Number(v)) + 'đ';
  const footer = `${p.link ? `\n\nTra cứu đơn hàng: ${p.link}` : ''}\n\nCảm ơn bạn!`;
  if (topic === 'order.created') {
    return {
      subject: `Xác nhận đơn hàng #${p.order_number}`,
      text: `Chào ${p.customer_name || 'bạn'},\n\nĐơn hàng #${p.order_number} đã được ghi nhận.\nTổng: ${money(p.total_vnd)} — Thanh toán: ${p.payment_method === 'qr' ? 'chuyển khoản QR' : 'khi nhận hàng (COD)'}.${footer}`,
    };
  }
  if (topic === 'order.paid') {
    return {
      subject: `Đã nhận thanh toán đơn #${p.order_number}`,
      text: `Chào ${p.customer_name || 'bạn'},\n\nChúng tôi đã nhận đủ thanh toán cho đơn hàng #${p.order_number} (${money(p.total_vnd)}).\nĐơn của bạn đang được xử lý.${footer}`,
    };
  }
  if (topic === 'order.status_changed') {
    // Huỷ TỰ ĐỘNG (reason='expired'): nói rõ vì sao + mời đặt lại — khác huỷ do shop.
    if (p.status === 'cancelled' && p.reason === 'expired') {
      const why = p.payment_method === 'qr'
        ? 'chưa nhận được thanh toán chuyển khoản trong thời gian giữ đơn'
        : 'cửa hàng chưa kịp xác nhận trong thời gian giữ đơn';
      return {
        subject: `Đơn hàng #${p.order_number} đã tự huỷ`,
        text: `Đơn hàng #${p.order_number} đã được HỆ THỐNG TỰ HUỶ vì ${why}.\nHàng đã được trả lại kho — nếu bạn vẫn muốn mua, vui lòng đặt lại đơn mới.${footer}`,
      };
    }
    const label = { confirmed: 'đã được xác nhận', shipped: 'đang trên đường giao', delivered: 'đã giao thành công', cancelled: 'đã huỷ', refunded: 'đã hoàn tiền' }[p.status] ?? p.status;
    const extra = p.status === 'shipped' && p.tracking_number ? `\nMã vận đơn: ${p.tracking_number} — bạn có thể tra trên trang của hãng vận chuyển.`
      : p.status === 'delivered' ? '\nCảm ơn bạn đã mua hàng! Nếu có vấn đề với sản phẩm, hãy liên hệ cửa hàng.'
      : p.tracking_number ? `\nMã vận đơn: ${p.tracking_number}` : '';
    return {
      subject: `Đơn hàng #${p.order_number} — ${label}`,
      text: `Đơn hàng #${p.order_number} ${label}.${extra}${footer}`,
    };
  }
  if (topic === 'stock.low') {
    const lines = (p.items ?? []).map((i) => `  • ${i.title}${i.variant_title ? ` (${i.variant_title})` : ''} — còn ${i.available}`).join('\n');
    return {
      subject: `⚠ ${p.items?.length ?? 0} sản phẩm sắp hết hàng`,
      text: `Các sản phẩm sau còn tồn thấp (≤ ${p.threshold}):\n\n${lines}\n\nVào trang quản trị để nhập thêm hàng hoặc ẩn sản phẩm.`,
    };
  }
  return { subject: `Thông báo`, text: JSON.stringify(p) };
}

// Điểm nối KÊNH THÔNG BÁO: hiện chỉ email; sau này thêm Zalo ZNS tại đây (cần OA +
// template được Zalo duyệt — tích hợp khi user có tài khoản OA, KHÔNG dựng code chết).
async function deliverNotification(topic, payload) {
  if (!payload?.to) return; // không có email → bỏ qua (ZNS sau này dùng payload.phone)
  const { subject, text } = compose(topic, payload);
  await transport.sendMail({ from: FROM, to: payload.to, subject, text });
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
      `SELECT id, shop_id, topic, payload FROM outbox WHERE processed_at IS NULL ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED`,
    )).rows;
    for (const r of rows) {
      await queue.add(
        r.topic, { topic: r.topic, payload: r.payload, shopId: r.shop_id, outboxId: String(r.id) },
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
  const { topic, payload, shopId, outboxId } = job.data;
  // Telegram cho CHỦ SHOP chạy TRƯỚC + ĐỘC LẬP email: nếu email khách lỗi (relay từ chối →
  // throw → retry → dead-letter), chủ shop VẪN nhận "đơn mới". Idempotent theo outboxId +
  // tự nuốt lỗi (không throw) → không làm fail/nuốt email.
  await deliverTelegram(topic, payload, shopId, outboxId);
  // Cờ test: email bounce vĩnh viễn → để kiểm dead-letter (chỉ dev/test).
  if (payload?.to === 'bounce@test.invalid') throw new Error('simulated permanent bounce');
  await deliverNotification(topic, payload);
  // KHÔNG log địa chỉ email (PII). Log topic + số đơn để truy vết.
  if (payload?.to) log('info', 'email_sent', { topic, order: payload.order_number });
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
      `SELECT id, shop_id, coupon_code, order_number, total_vnd, payment_method, customer_email FROM orders
        WHERE status = 'pending' AND (
              (payment_method = 'qr'  AND payment_status = 'unpaid' AND created_at < now() - ($1 || ' minutes')::interval)
           OR (payment_method = 'cod' AND payment_status = 'unpaid' AND created_at < now() - ($2 || ' days')::interval)
        )
        ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED`,
      [String(ORDER_EXPIRY_MINUTES), String(COD_EXPIRY_DAYS)],
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
      // Đơn hết hạn = chưa trả → hoàn lại 1 lượt coupon (đã tăng lúc tạo đơn).
      if (o.coupon_code) {
        await c.query(`UPDATE coupons SET used_count = GREATEST(used_count - 1, 0) WHERE shop_id = $1 AND upper(code) = upper($2)`, [o.shop_id, o.coupon_code]);
      }
      // Email báo khách đơn TỰ HUỶ (docs/34 §E — hết "huỷ im lặng"). Cùng transaction
      // với huỷ (ADR-006). reason='expired' → compose() nói rõ lý do + mời đặt lại.
      if (o.customer_email) {
        await c.query(`INSERT INTO outbox (shop_id, topic, payload) VALUES ($1, 'order.status_changed', $2)`,
          [o.shop_id, { to: o.customer_email, order_number: Number(o.order_number), status: 'cancelled', reason: 'expired', payment_method: o.payment_method, total_vnd: Number(o.total_vnd) }]);
      }
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

// ── sweep: vòng đời thuê bao ──────────────────────────────────────────────────
// trial/active hết current_period_end → past_due. past_due quá ân hạn → cancelled + TREO
// shop (status='suspended' — tái dùng chốt storefront). Cross-shop qua app_billing (0033).
// Idempotent (guard status trong WHERE). DB lỗi → chỉ bỏ nhịp (không unhandledRejection).
// Sub past_due VẪN phục vụ storefront (ân hạn); chỉ khi cancelled mới treo.
async function sweepSubscriptions() {
  if (!billingDb) return { past_due: 0, cancelled: 0 };
  let c;
  try {
    c = await billingDb.connect();
    await c.query('BEGIN');
    const pd = await c.query(
      `UPDATE subscriptions SET status = 'past_due'
        WHERE status IN ('trial','active') AND current_period_end IS NOT NULL AND current_period_end < now()`);
    const cancelled = (await c.query(
      `UPDATE subscriptions SET status = 'cancelled'
        WHERE status = 'past_due' AND current_period_end IS NOT NULL
          AND current_period_end < now() - ($1 || ' days')::interval
        RETURNING shop_id`, [String(SUBSCRIPTION_GRACE_DAYS)])).rows;
    for (const row of cancelled) {
      // Treo shop CHỈ khi (a) đang onboarding/active (guard DƯƠNG như platform suspend — KHÔNG
      // hạ 'terminated'/'suspended' bằng phủ định <>'suspended'), và (b) shop KHÔNG còn sub nào
      // khác đang phục vụ (đa-sub: đừng treo shop có sub mới active/trial/past_due còn hiệu lực).
      await c.query(
        `UPDATE shops SET status = 'suspended'
          WHERE id = $1 AND status IN ('onboarding','active')
            AND NOT EXISTS (SELECT 1 FROM subscriptions s2 WHERE s2.shop_id = $1 AND s2.status IN ('trial','active','past_due'))`,
        [row.shop_id],
      );
    }
    await c.query('COMMIT');
    if (pd.rowCount || cancelled.length) log('info', 'subscriptions_swept', { past_due: pd.rowCount, cancelled: cancelled.length });
    return { past_due: pd.rowCount, cancelled: cancelled.length };
  } catch (e) {
    if (c) await c.query('ROLLBACK').catch(() => {});
    log('error', 'subscription_sweep_error', { message: e.message });
    return { past_due: 0, cancelled: 0 };
  } finally { if (c) c.release(); }
}

// ── sweep: poll trạng thái vận đơn hãng VC (GHN/GHTK) ─────────────────────────
// Vận đơn in_transit tạo qua hãng → hỏi API hãng (NGOÀI transaction, như DNS sweep);
// 'delivered' → chốt đơn delivered (guard status='shipped' = idempotent) + outbox email.
// 'returned'/'cancelled' → CHỈ đánh dấu vận đơn + log (shop xử lý hoàn/tồn TAY — không
// tự đảo tồn kho vì hàng hoàn cần kiểm đếm thực tế). Token per-shop giải mã bằng
// SHIPPING_ENC_KEY (AES-256-GCM, cùng định dạng secretbox iv.tag.ct base64).
const GHN_BASE = (process.env.GHN_API_BASE ?? 'https://online-gateway.ghn.vn/shiip/public-api').replace(/\/+$/, '');
const GHTK_BASE = (process.env.GHTK_API_BASE ?? 'https://services.giaohangtietkiem.vn').replace(/\/+$/, '');
function sbOpen(blob, keyHex) { // bản sao secretbox.open (build context worker là dir riêng)
  const key = Buffer.from(keyHex, 'hex');
  const [ivB64, tagB64, ctB64] = String(blob).split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}
async function carrierState(provider, token, ghnShopId, tracking) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10000);
  try {
    if (provider === 'ghn') {
      const r = await fetch(`${GHN_BASE}/v2/shipping-order/detail`, {
        method: 'POST', headers: { 'content-type': 'application/json', Token: token },
        body: JSON.stringify({ order_code: tracking }), signal: ac.signal,
      });
      const j = await r.json().catch(() => null);
      if (r.status !== 200 || j?.code !== 200) return null;
      const st = String(j?.data?.status ?? '');
      return { state: st === 'delivered' ? 'delivered' : st === 'cancel' ? 'cancelled' : /return/.test(st) ? 'returned' : 'shipping', raw: st };
    }
    const r = await fetch(`${GHTK_BASE}/services/shipment/v2/${encodeURIComponent(tracking)}`, { headers: { Token: token }, signal: ac.signal });
    const j = await r.json().catch(() => null);
    if (r.status !== 200 || j?.success !== true) return null;
    const st = Number(j?.order?.status ?? j?.order?.status_id ?? 0);
    return { state: st === 5 || st === 6 ? 'delivered' : st === -1 ? 'cancelled' : st === 9 || st === 20 || st === 21 ? 'returned' : 'shipping', raw: String(st) };
  } catch { return null; } finally { clearTimeout(t); }
}
async function sweepTracking() {
  if (!expiryDb || !TRACKING_ON) return { checked: 0, delivered: 0 };
  // Chống LỖI MỘT DÒNG bỏ đói cả hàng đợi (ORDER BY synced_at): mọi đường lỗi PHẢI bump
  // synced_at để dòng hỏng xoay xuống cuối, không chiếm slot LIMIT 30 mãi mãi.
  const bump = (id) => expiryDb.query(`UPDATE shipments SET synced_at = now() WHERE id = $1`, [id]).catch(() => {});
  // Dọn CLAIM CHẾT: dòng 'created' quá 15' (crash giữa chừng / hãng từ chối mà DELETE bù
  // fail). tracking NULL = hãng CHƯA tạo → mở khoá (cancelled). tracking CÓ (finalize_failed)
  // = vận đơn THẬT tồn tại trên hãng → GIỮ khoá + log cảnh báo (mở là double-create COD thật).
  try {
    const gc = await expiryDb.query(
      `UPDATE shipments SET status = 'cancelled', provider_status = 'claim_expired', synced_at = now()
        WHERE status = 'created' AND provider IS NOT NULL AND tracking_number IS NULL
          AND created_at < now() - interval '15 minutes' RETURNING id`);
    if (gc.rowCount) log('info', 'tracking_claims_expired', { n: gc.rowCount });
    const stuck = await expiryDb.query(
      `SELECT id, order_id, tracking_number FROM shipments
        WHERE status = 'created' AND provider IS NOT NULL AND tracking_number IS NOT NULL
          AND created_at < now() - interval '15 minutes'`);
    for (const r of stuck.rows) log('warn', 'tracking_finalize_stuck', { shipmentId: r.id, tracking: r.tracking_number });
  } catch (e) { log('error', 'tracking_gc_error', { message: e.message }); }

  let rows;
  try {
    rows = (await expiryDb.query(
      `SELECT s.id, s.shop_id, s.order_id, s.provider, s.tracking_number,
              cfg.token_enc, cfg.ghn_shop_id,
              o.status AS order_status, o.order_number, o.total_vnd, o.customer_email
         FROM shipments s
         JOIN shop_shipping_config cfg ON cfg.shop_id = s.shop_id AND cfg.enabled
         JOIN orders o ON o.id = s.order_id
        WHERE s.provider IS NOT NULL AND s.status = 'in_transit'
        ORDER BY s.synced_at NULLS FIRST LIMIT 30`)).rows;
  } catch (e) { log('error', 'tracking_query_error', { message: e.message }); return { checked: 0, delivered: 0 }; }

  let delivered = 0;
  for (const s of rows) {
    let token;
    try { token = sbOpen(s.token_enc, SHIPPING_ENC_KEY); } catch {
      log('error', 'tracking_decrypt_error', { shipmentId: s.id }); // khoá lệch/token hỏng
      await bump(s.id); continue;
    }
    const st = await carrierState(s.provider, token, s.ghn_shop_id, s.tracking_number); // NGOÀI transaction
    if (!st) { await bump(s.id); continue; } // hãng lỗi/timeout → xoay xuống cuối, thử nhịp sau
    let c;
    try {
      c = await expiryDb.connect();
      await c.query('BEGIN');
      if (st.state === 'delivered') {
        const upd = await c.query(`UPDATE orders SET status = 'delivered', delivered_at = now() WHERE id = $1 AND status = 'shipped'`, [s.order_id]);
        await c.query(`UPDATE shipments SET status = 'delivered', provider_status = $2, synced_at = now() WHERE id = $1`, [s.id, st.raw]);
        if (upd.rowCount === 1 && s.customer_email) {
          await c.query(`INSERT INTO outbox (shop_id, topic, payload) VALUES ($1, 'order.status_changed', $2)`,
            [s.shop_id, { to: s.customer_email, order_number: Number(s.order_number), status: 'delivered', total_vnd: Number(s.total_vnd), tracking_number: s.tracking_number }]);
        }
        if (upd.rowCount === 1) { delivered++; log('info', 'tracking_delivered', { order_number: Number(s.order_number), provider: s.provider }); }
      } else if (st.state === 'returned' || st.state === 'cancelled') {
        await c.query(`UPDATE shipments SET status = $2, provider_status = $3, synced_at = now() WHERE id = $1`, [s.id, st.state, st.raw]);
        log('warn', 'tracking_exception', { order_number: Number(s.order_number), provider: s.provider, state: st.state, raw: st.raw });
      } else {
        await c.query(`UPDATE shipments SET provider_status = $2, synced_at = now() WHERE id = $1`, [s.id, st.raw]);
      }
      await c.query('COMMIT');
    } catch (e) {
      if (c) await c.query('ROLLBACK').catch(() => {});
      log('error', 'tracking_update_error', { message: e.message });
    } finally { if (c) c.release(); }
  }
  return { checked: rows.length, delivered };
}

// ── sweep: cảnh báo SẮP HẾT HÀNG (0050) — mỗi ngày 1 email/shop nếu có hàng tồn thấp ──
// Ngưỡng per-shop (NULL → 5). Chỉ shop active + có contact_email. Nhóm theo shop → 1 email
// tối đa 20 dòng. Idempotent theo NHỊP (timer 24h); gọi tay /internal/lowstock-sweep để test.
const LOWSTOCK_SWEEP_MS = Number(process.env.LOWSTOCK_SWEEP_MS ?? 86400000); // 24h
async function sweepLowStock() {
  if (!expiryDb) return { shops: 0 };
  let rows;
  try {
    // CHỈ biến thể ĐÃ cấu hình tồn (có dòng inventory_levels — INNER JOIN) → không báo giả
    // biến thể mới chưa nhập kho. Cap 20 dòng/SHOP bằng row_number (không để 1 shop nhiều
    // biến thể tồn thấp bỏ đói cảnh báo shop khác qua LIMIT toàn cục).
    rows = (await expiryDb.query(`
      SELECT shop_id, contact_email, threshold, title, variant_title, available FROM (
        SELECT s.id AS shop_id, s.contact_email, coalesce(s.low_stock_threshold, 5) AS threshold,
               p.title, v.title AS variant_title, (il.on_hand - il.reserved)::int AS available,
               row_number() OVER (PARTITION BY s.id ORDER BY (il.on_hand - il.reserved) ASC, v.id) AS rn
          FROM shops s
          JOIN products p ON p.shop_id = s.id AND p.status = 'active' AND p.deleted_at IS NULL
          JOIN variants v ON v.product_id = p.id
          JOIN inventory_levels il ON il.variant_id = v.id
         WHERE s.status IN ('active', 'onboarding') AND s.contact_email IS NOT NULL
           AND (il.on_hand - il.reserved) <= coalesce(s.low_stock_threshold, 5)
      ) x WHERE rn <= 20`)).rows;
  } catch (e) { log('error', 'lowstock_query_error', { message: e.message }); return { shops: 0 }; }
  const byShop = new Map();
  for (const r of rows) {
    if (!byShop.has(r.shop_id)) byShop.set(r.shop_id, { to: r.contact_email, threshold: Number(r.threshold), items: [] });
    byShop.get(r.shop_id).items.push({ title: r.title, variant_title: r.variant_title, available: r.available });
  }
  let sent = 0;
  for (const [shopId, g] of byShop) {
    let c;
    try {
      c = await expiryDb.connect();
      await c.query('BEGIN');
      // Claim NGUYÊN TỬ theo ngày: chỉ shop CHƯA gửi hôm nay mới qua → không email trùng.
      const claimed = await c.query(
        `UPDATE shops SET low_stock_alerted_on = current_date
          WHERE id = $1 AND (low_stock_alerted_on IS NULL OR low_stock_alerted_on < current_date)`, [shopId]);
      if (claimed.rowCount === 1) {
        await c.query(`INSERT INTO outbox (shop_id, topic, payload) VALUES ($1, 'stock.low', $2)`, [shopId, g]);
        sent++;
      }
      await c.query('COMMIT');
    } catch (e) {
      if (c) await c.query('ROLLBACK').catch(() => {});
      log('error', 'lowstock_outbox_error', { message: e.message });
    } finally { if (c) c.release(); }
  }
  if (sent) log('info', 'lowstock_alerts', { shops: sent });
  return { shops: sent };
}

// ── sweep: DỌN outbox — bỏ PII (email + link tra cứu token) khỏi dòng ĐÃ XỬ LÝ >7 ngày.
// Email đã gửi xong nên không cần giữ; giảm bề mặt rò nếu DB lộ. app_worker đã có UPDATE outbox.
const OUTBOX_GC_MS = Number(process.env.OUTBOX_GC_MS ?? 6 * 60 * 60 * 1000); // 6h
async function sweepOutboxGc() {
  try {
    const r = await db.query(
      `UPDATE outbox SET payload = payload - 'link' - 'to'
        WHERE processed_at IS NOT NULL AND processed_at < now() - interval '7 days'
          AND (jsonb_exists(payload, 'link') OR jsonb_exists(payload, 'to'))`);
    if (r.rowCount) log('info', 'outbox_gc', { n: r.rowCount });
    return { scrubbed: r.rowCount };
  } catch (e) { log('error', 'outbox_gc_error', { message: e.message }); return { scrubbed: 0 }; }
}

// ── sweep: CẢNH BÁO ĐƯỜNG TIỀN + VẬN HÀNH ────────────────────────────────────
// Đẩy cảnh báo tới ALERT_WEBHOOK_URL (webhook chung — Slack/Discord/Mattermost nhận {text};
// Telegram/Zalo qua cầu nối) khi: (1) giao dịch tiền CHƯA KHỚP tồn đọng (tiền về, chưa vào
// đơn — mất doanh thu/khiếu nại); (2) email TỒN ĐỌNG (worker gửi mail kẹt); (3) email
// dead-letter. Dedup: chỉ báo khi trạng thái ĐỔI hoặc quá ALERT_REPEAT_MS (chống spam).
// ── THÔNG BÁO TELEGRAM (1 bot nền tảng, per-shop chat) ───────────────────────
// Shop link chat qua deep-link /start <link_code>: worker poll getUpdates → bind chat_id.
// Sự kiện đơn (mới/thanh toán/huỷ) + sắp hết hàng → bắn tới chat chủ shop. Dev trỏ stub.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TELEGRAM_API_BASE = (process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org').replace(/\/+$/, '');
const TELEGRAM_ON = TELEGRAM_BOT_TOKEN !== '';
const TELEGRAM_LINK_SWEEP_MS = Number(process.env.TELEGRAM_LINK_SWEEP_MS ?? 15000);
const ALERT_TELEGRAM_CHAT_ID = process.env.ALERT_TELEGRAM_CHAT_ID ?? ''; // chat NỀN TẢNG nhận cảnh báo tiền
let tgOffset = 0;

async function tgSend(chatId, text) {
  if (!TELEGRAM_ON || !chatId) return false;
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(`${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }), signal: ac.signal });
    return r.ok;
  } catch (e) { log('error', 'tg_send_error', { message: e.message }); return false; }
  finally { clearTimeout(t); }
}

// Poll getUpdates → xử lý "/start <code>" để BIND chat_id vào shop (tra theo link_code).
async function sweepTelegramLink() {
  if (!TELEGRAM_ON || !expiryDb) return { bound: 0 };
  let updates;
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetch(`${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=0&offset=${tgOffset}`, { signal: ac.signal });
    const j = await r.json().catch(() => null);
    if (!j?.ok) return { bound: 0 };
    updates = j.result ?? [];
  } catch (e) { log('error', 'tg_getupdates_error', { message: e.message }); return { bound: 0 }; }
  finally { clearTimeout(t); }
  let bound = 0;
  for (const u of updates) {
    tgOffset = Math.max(tgOffset, Number(u.update_id) + 1); // xác nhận đã xử lý
    const text = u.message?.text ?? '', chat = u.message?.chat?.id;
    const mm = /^\/start\s+([A-Za-z0-9_-]{6,40})/.exec(text);
    if (!mm || chat == null) continue;
    try {
      const upd = await expiryDb.query(
        `UPDATE shop_telegram SET chat_id = $2, linked_at = now(), link_code = NULL WHERE link_code = $1 RETURNING shop_id`,
        [mm[1], String(chat)]);
      if (upd.rowCount === 1) { bound++; await tgSend(String(chat), '✅ Đã kết nối! Cửa hàng của bạn sẽ nhận thông báo đơn hàng + vận hành tại đây.'); }
      else await tgSend(String(chat), 'Mã liên kết không đúng hoặc đã dùng. Vào lại trang Thông báo trong admin để lấy mã mới.');
    } catch (e) { log('error', 'tg_bind_error', { message: e.message }); }
  }
  if (bound) log('info', 'tg_linked', { n: bound });
  return { bound, checked: updates.length };
}

// Soạn tin Telegram cho CHỦ SHOP theo sự kiện outbox. null = không báo (vd confirmed/shipped
// là shop tự thao tác, không cần báo).
function tgMessageFor(topic, p) {
  const money = (v) => new Intl.NumberFormat('vi-VN').format(Number(v)) + 'đ';
  if (topic === 'order.created') return `🛒 Đơn MỚI #${p.order_number} — ${money(p.total_vnd)} (${p.payment_method === 'qr' ? 'chờ CK QR' : 'COD'})${p.customer_name ? `\nKhách: ${p.customer_name}` : ''}`;
  if (topic === 'order.paid') return `💰 Đơn #${p.order_number} ĐÃ THANH TOÁN — ${money(p.total_vnd)}. Chuẩn bị giao hàng.`;
  if (topic === 'order.status_changed' && p.status === 'cancelled') return `❌ Đơn #${p.order_number} đã huỷ${p.reason === 'expired' ? ' (tự huỷ quá hạn)' : ''}.`;
  if (topic === 'stock.low') return `📦 ${p.items?.length ?? 0} sản phẩm SẮP HẾT HÀNG (còn ≤ ${p.threshold}). Kiểm kho + nhập thêm.`;
  return null;
}
async function deliverTelegram(topic, payload, shopId, outboxId) {
  try {
    if (!TELEGRAM_ON || !expiryDb || !shopId) return;
    const text = tgMessageFor(topic, payload);
    if (!text) return;
    // DEDUP theo outboxId: consumer chạy Telegram TRƯỚC email; nếu email lỗi → job retry →
    // consumer chạy lại → KHÔNG gửi Telegram TRÙNG. Đánh dấu SAU khi gửi thành công (lỗi gửi
    // tạm thời vẫn được thử lại qua vòng retry của email). db/queue Redis dùng chung.
    const rc = outboxId ? await queue.client : null;
    if (rc && (await rc.get(`tgsent:${outboxId}`))) return;
    const row = (await expiryDb.query(`SELECT chat_id FROM shop_telegram WHERE shop_id = $1 AND enabled AND chat_id IS NOT NULL`, [shopId])).rows[0];
    if (!row?.chat_id) return;
    const sent = await tgSend(row.chat_id, text);
    if (sent && rc) await rc.set(`tgsent:${outboxId}`, '1', 'EX', 86400);
  } catch (e) { log('error', 'tg_deliver_error', { message: e.message }); } // KHÔNG throw (không làm fail email)
}

const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL ?? '';
const ALERT_SWEEP_MS = Number(process.env.ALERT_SWEEP_MS ?? 300000);      // 5 phút
const ALERT_REPEAT_MS = Number(process.env.ALERT_REPEAT_MS ?? 3600000);   // nhắc lại mỗi 1h nếu còn
const ALERT_UNMATCHED_MAX = Number(process.env.ALERT_UNMATCHED_MAX ?? 1); // ≥N giao dịch chưa khớp >1h
const ALERT_OUTBOX_MAX = Number(process.env.ALERT_OUTBOX_MAX ?? 20);      // ≥N email tồn >10'
const ALERT_EMAIL_FAIL_MAX = Number(process.env.ALERT_EMAIL_FAIL_MAX ?? 5);
let lastAlertState = '', lastAlertAt = 0;

async function postAlert(text, metrics, severity) {
  let sent = false;
  // Ưu tiên Telegram nền tảng (nếu cấu hình) — cảnh báo tiền bắn thẳng vào điện thoại bạn.
  if (TELEGRAM_ON && ALERT_TELEGRAM_CHAT_ID) sent = (await tgSend(ALERT_TELEGRAM_CHAT_ID, text)) || sent;
  if (ALERT_WEBHOOK_URL) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    try {
      const r = await fetch(ALERT_WEBHOOK_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, content: text, severity, service: 'nentang', metrics }), signal: ac.signal,
      });
      sent = r.ok || sent;
    } catch (e) { log('error', 'alert_post_error', { message: e.message }); }
    finally { clearTimeout(t); }
  }
  return sent;
}

async function sweepMoneyAlerts() {
  const m = { unmatched_open: 0, unmatched_old: 0, outbox_backlog: 0, email_failed: 0 };
  if (expiryDb) {
    try {
      const r = (await expiryDb.query(`SELECT
        count(*) FILTER (WHERE resolved_at IS NULL)::int AS open,
        count(*) FILTER (WHERE resolved_at IS NULL AND created_at < now() - interval '1 hour')::int AS old
        FROM unmatched_transfers`)).rows[0];
      m.unmatched_open = r.open; m.unmatched_old = r.old;
    } catch (e) { log('error', 'alert_unmatched_error', { message: e.message }); }
  }
  try {
    m.outbox_backlog = Number((await db.query(
      `SELECT count(*)::int n FROM outbox WHERE processed_at IS NULL AND created_at < now() - interval '10 minutes'`)).rows[0].n);
  } catch (e) { log('error', 'alert_outbox_error', { message: e.message }); }
  try { m.email_failed = Number((await queue.getJobCounts('failed')).failed ?? 0); } catch {}

  const breaches = [];
  if (m.unmatched_old >= ALERT_UNMATCHED_MAX) breaches.push(`${m.unmatched_old} giao dịch tiền CHƯA KHỚP quá 1h (tiền về nhưng chưa vào đơn — kiểm hàng đợi đối soát)`);
  if (m.outbox_backlog >= ALERT_OUTBOX_MAX) breaches.push(`${m.outbox_backlog} email TỒN ĐỌNG >10' (worker gửi mail có thể đang kẹt)`);
  if (m.email_failed >= ALERT_EMAIL_FAIL_MAX) breaches.push(`${m.email_failed} email gửi THẤT BẠI (dead-letter)`);

  const state = breaches.join(' | ');
  const now = Date.now();
  if (state && (state !== lastAlertState || now - lastAlertAt > ALERT_REPEAT_MS)) {
    const sent = await postAlert(`⚠ NỀN TẢNG — cảnh báo vận hành:\n- ${breaches.join('\n- ')}`, m, 'warning');
    if (sent) { lastAlertState = state; lastAlertAt = now; }
    log('warn', 'ops_alert', { breaches: breaches.length, metrics: m, sent });
  } else if (!state && lastAlertState) {
    await postAlert('✓ NỀN TẢNG — các cảnh báo vận hành đã hết.', m, 'ok');
    lastAlertState = ''; lastAlertAt = 0;
    log('info', 'ops_alert_cleared', {});
  }
  return { metrics: m, breaches: breaches.length };
}

const timer = setInterval(poll, POLL_MS);
const expiryTimer = expiryDb ? setInterval(sweepExpired, EXPIRY_SWEEP_MS) : null;
const lowstockTimer = expiryDb ? setInterval(sweepLowStock, LOWSTOCK_SWEEP_MS) : null;
const outboxGcTimer = setInterval(sweepOutboxGc, OUTBOX_GC_MS);
const alertTimer = setInterval(sweepMoneyAlerts, ALERT_SWEEP_MS);
const tgLinkTimer = (TELEGRAM_ON && expiryDb) ? setInterval(sweepTelegramLink, TELEGRAM_LINK_SWEEP_MS) : null;
const domainTimer = domainDb ? setInterval(sweepDomainVerify, DOMAINVERIFY_SWEEP_MS) : null;
const billingTimer = billingDb ? setInterval(sweepSubscriptions, SUBSCRIPTION_SWEEP_MS) : null;
const trackingTimer = (expiryDb && TRACKING_ON) ? setInterval(sweepTracking, TRACKING_SWEEP_MS) : null;

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
  // Kích hoạt quét vòng đời thuê bao ngay (nội bộ — cho cron + e2e xác định).
  if (url.pathname === '/internal/subscription-sweep' && req.method === 'POST') {
    const r = await sweepSubscriptions();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  // Kích hoạt poll trạng thái vận đơn hãng VC ngay (nội bộ — cho cron + e2e xác định).
  if (url.pathname === '/internal/tracking-sweep' && req.method === 'POST') {
    const r = await sweepTracking();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  // Kích hoạt quét sắp-hết-hàng ngay (nội bộ — cho cron + e2e xác định).
  if (url.pathname === '/internal/lowstock-sweep' && req.method === 'POST') {
    const r = await sweepLowStock();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  // Kích hoạt dọn outbox ngay (nội bộ — cho cron + e2e xác định).
  if (url.pathname === '/internal/outbox-gc' && req.method === 'POST') {
    const r = await sweepOutboxGc();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  // Kích hoạt quét cảnh báo đường tiền ngay (nội bộ — cho cron + e2e xác định).
  if (url.pathname === '/internal/alert-sweep' && req.method === 'POST') {
    const r = await sweepMoneyAlerts();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  // Kích hoạt poll /start Telegram ngay (nội bộ — cho e2e xác định link).
  if (url.pathname === '/internal/telegram-link-sweep' && req.method === 'POST') {
    const r = await sweepTelegramLink();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  res.writeHead(404); res.end();
}));
server.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT }));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    clearInterval(timer);
    if (expiryTimer) clearInterval(expiryTimer);
    if (domainTimer) clearInterval(domainTimer);
    if (billingTimer) clearInterval(billingTimer);
    if (trackingTimer) clearInterval(trackingTimer);
    if (lowstockTimer) clearInterval(lowstockTimer);
    clearInterval(outboxGcTimer);
    clearInterval(alertTimer);
    if (tgLinkTimer) clearInterval(tgLinkTimer);
    await worker.close().catch(() => {});
    await queue.close().catch(() => {});
    server.close(async () => { await db.end().catch(() => {}); await expiryDb?.end().catch(() => {}); await domainDb?.end().catch(() => {}); await billingDb?.end().catch(() => {}); process.exit(0); });
  });
}
