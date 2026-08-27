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
 * Vai trò app_worker đọc outbox + ba cột định danh order để nối delivery với timeline; không đọc
 * tiền hoặc PII của order. Các sweep nghiệp vụ dùng pool/role hẹp riêng.
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
import { buildSmtpOptions } from './smtp.js';
import {
  canApplyKiotVietStock,
  createKiotVietClient,
  extractKiotVietNotifications,
  integrationRetryBackoffMs,
  isStaleKiotVietSnapshot,
  kiotVietBranchOnHand,
  KiotVietError,
} from '../kiotviet.js';

const PORT = Number(process.env.PORT ?? 3080);
const POLL_MS = Number(process.env.POLL_MS ?? 1000);
const ATTEMPTS = Number(process.env.EMAIL_ATTEMPTS ?? 5);
const BACKOFF_MS = Number(process.env.EMAIL_BACKOFF_MS ?? 2000);
const INTEGRATION_ATTEMPTS = Number(process.env.INTEGRATION_ATTEMPTS ?? 8);
const INTEGRATION_WEBHOOK_ATTEMPTS = Number(process.env.INTEGRATION_WEBHOOK_ATTEMPTS ?? 10);
const FROM = process.env.EMAIL_FROM ?? 'no-reply@nentang.vn';
// Thương hiệu + email liên hệ nền tảng cho NỘI DUNG nhắc hạn thuê bao (dunning) —
// cùng mặc định với storefront (trang công ty) để copy nhất quán.
const PLATFORM_BRAND = process.env.PLATFORM_BRAND ?? 'Nền Tảng';
const BILLING_CONTACT = process.env.PLATFORM_CONTACT_EMAIL ?? 'lienhe@nentang.vn';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const INTEGRATION_URL = process.env.DATABASE_URL_INTEGRATION;
const integrationDb = INTEGRATION_URL ? new pg.Pool({ connectionString: INTEGRATION_URL, max: 4 }) : null;
const INTEGRATION_ENC_KEY = process.env.INTEGRATION_ENC_KEY ?? '';
const INTEGRATION_RECONCILE_MS = Number(process.env.INTEGRATION_RECONCILE_MS ?? 300000);
const INTEGRATION_RECONCILE_CONCURRENCY = Math.max(1, Math.min(8,
  Number(process.env.INTEGRATION_RECONCILE_CONCURRENCY ?? 4) || 4));
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
// Pool RIÊNG cho điểm thưởng (role app_loyalty cực hẹp — 0086). Thiếu env → TẮT tính năng.
// Tích điểm (vesting: chỉ đơn paid ≥ N ngày) + thu-hồi (clawback/reversal đơn terminal).
const LOYALTY_URL = process.env.DATABASE_URL_LOYALTY;
const loyaltyDb = LOYALTY_URL ? new pg.Pool({ connectionString: LOYALTY_URL, max: 2 }) : null;
// Vai app_affiliate (0132): quét vòng đời hoa hồng CTV cross-shop. Hẹp nhất có thể —
// đọc orders/cấu hình, CHỈ đổi trạng thái hoa hồng; không INSERT, không đụng phiếu chi.
const AFFILIATE_URL = process.env.DATABASE_URL_AFFILIATE;
const affiliateDb = AFFILIATE_URL ? new pg.Pool({ connectionString: AFFILIATE_URL, max: 2 }) : null;
const LOYALTY_SWEEP_MS = Number(process.env.LOYALTY_SWEEP_MS ?? 300000);
// Self-serve signup (0091): pool app_signup (least-priv — chỉ chạm shop_signups) để GC nháp treo.
const SIGNUP_URL = process.env.DATABASE_URL_SIGNUP;
const signupDb = SIGNUP_URL ? new pg.Pool({ connectionString: SIGNUP_URL, max: 2 }) : null;
const SIGNUP_SWEEP_MS = Number(process.env.SIGNUP_SWEEP_MS ?? 300000); // 5 phút
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
const transport = nodemailer.createTransport(buildSmtpOptions());

const log = makeLog('worker');

const queue = new Queue('email', { connection });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const deliveryMeta = (topic, payload, shopId, outboxId, channel) => ({
  outboxId: String(outboxId),
  shopId: UUID_RE.test(String(shopId ?? '')) ? shopId : null,
  orderId: UUID_RE.test(String(payload?.order_id ?? '')) ? payload.order_id : null,
  orderNumber: Number.isSafeInteger(Number(payload?.order_number)) && Number(payload.order_number) > 0 ? Number(payload.order_number) : null,
  retryOf: UUID_RE.test(String(payload?.retry_of_delivery_id ?? '')) ? payload.retry_of_delivery_id : null,
  topic, channel,
});
const safeDeliveryError = (e) => String(e?.message ?? e ?? 'lỗi không xác định')
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
  .replace(/(?:\+?84|0)\d{8,10}/g, '[phone]')
  .replace(/\b(authorization|token|secret|password|api[-_ ]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[secret]')
  .replace(/(https?:\/\/[^\s?]+)\?[^\s]+/gi, '$1?[redacted]')
  .slice(0, 500);

function candidateChannels(topic, payload, shopId) {
  const out = [];
  if (payload?.to) out.push('email');
  if (MESSENGER_URL && topic === 'order.status_changed' && payload?.messenger_psid) out.push('messenger');
  if (TELEGRAM_ON && shopId && tgMessageFor(topic, payload)) out.push('telegram');
  return out;
}

async function queueDeliveryRows(c, row) {
  for (const channel of candidateChannels(row.topic, row.payload, row.shop_id)) {
    const m = deliveryMeta(row.topic, row.payload, row.shop_id, row.id, channel);
    await c.query(
      `INSERT INTO notification_deliveries
         (shop_id, outbox_id, order_id, order_number, topic, channel, status, retry_of_delivery_id)
       VALUES ($1,$2,coalesce($3, (
         SELECT o.id FROM orders o WHERE o.shop_id = $1 AND o.order_number = $4 LIMIT 1
       )),$4,$5,$6,'queued',$7)
       ON CONFLICT (outbox_id, channel) DO NOTHING`,
      [m.shopId, m.outboxId, m.orderId, m.orderNumber, m.topic, m.channel, m.retryOf],
    );
  }
}

async function startDelivery(meta) {
  const r = await db.query(
    `INSERT INTO notification_deliveries
       (shop_id, outbox_id, order_id, order_number, topic, channel, status, attempts,
        last_attempt_at, retry_of_delivery_id)
     VALUES ($1,$2,coalesce($3, (
       SELECT o.id FROM orders o WHERE o.shop_id = $1 AND o.order_number = $4 LIMIT 1
     )),$4,$5,$6,'sending',1,now(),$7)
     ON CONFLICT (outbox_id, channel) DO UPDATE
       SET status = 'sending', attempts = notification_deliveries.attempts + 1,
           order_id = coalesce(notification_deliveries.order_id, excluded.order_id),
           last_attempt_at = now(), updated_at = now(), last_error = NULL, failed_at = NULL
       WHERE notification_deliveries.status NOT IN ('accepted','failed','skipped','superseded')
     RETURNING id`,
    [meta.shopId, meta.outboxId, meta.orderId, meta.orderNumber, meta.topic, meta.channel, meta.retryOf],
  );
  return r.rowCount === 1;
}

async function finishDelivery(meta, status, { error = null, providerMessageId = null } = {}) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const row = (await c.query(
      `UPDATE notification_deliveries
          SET status = $3, provider_message_id = coalesce($4, provider_message_id),
              last_error = $5,
              accepted_at = CASE WHEN $3 = 'accepted' THEN now() ELSE accepted_at END,
              failed_at = CASE WHEN $3 = 'failed' THEN now() ELSE failed_at END,
              updated_at = now()
        WHERE outbox_id = $1 AND channel = $2
        RETURNING id, shop_id, order_id, topic, channel, attempts`,
      [meta.outboxId, meta.channel, status, providerMessageId, error],
    )).rows[0];
    if (row?.order_id && (status === 'accepted' || status === 'failed')) {
      await c.query(
        `INSERT INTO order_events
           (shop_id, order_id, event_type, actor_type, source, payload)
         VALUES ($1,$2,$3,'system','worker',$4)`,
        [row.shop_id, row.order_id, status === 'accepted' ? 'notification.sent' : 'notification.failed', {
          delivery_id: row.id,
          channel: row.channel,
          topic: row.topic,
          attempts: Number(row.attempts),
          ...(status === 'failed' ? { error: error ?? 'không xác định' } : {}),
        }],
      );
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

async function runTracked(job, channel, fn) {
  const { topic, payload, shopId, outboxId } = job.data;
  const meta = deliveryMeta(topic, payload, shopId, outboxId, channel);
  if (!(await startDelivery(meta))) return { status: 'already_final' };
  try {
    const result = await fn();
    const status = result?.status === 'skipped' ? 'skipped' : 'accepted';
    await finishDelivery(meta, status, { providerMessageId: result?.providerMessageId ?? null });
    return result;
  } catch (e) {
    const finalAttempt = Number(job.attemptsMade ?? 0) + 1 >= Number(job.opts?.attempts ?? 1);
    await finishDelivery(meta, finalAttempt ? 'failed' : 'retrying', { error: safeDeliveryError(e) }).catch(() => {});
    throw e;
  }
}

// ── compose email từ sự kiện ─────────────────────────────────────────────────
// Payload SELF-CONTAINED cho nội dung gửi; worker chỉ nối id timeline bằng shop_id + order_number.
// p.link (nếu có) = URL tra cứu đơn.
// Trả {subject, text, html}: text GIỮ NGUYÊN cấu trúc cũ (nodemailer gửi multipart/
// alternative — client text-only vẫn đọc trọn); html là bản trình bày inline-style.
const money = (v) => new Intl.NumberFormat('vi-VN').format(Number(v)) + 'đ';
// esc cho HTML email — payload chứa dữ liệu người dùng (tên khách, tên SP…) PHẢI escape.
const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Thương hiệu hiển thị trong email: shop_name (nếu payload mang) → host của link tra cứu
// (miền shop — payload đơn hàng không mang tên shop, worker CỐ Ý không đọc bảng shops)
// → thương hiệu nền tảng. KHÔNG nhúng/tải logo: email nhẹ, không request ngoài.
function brandOf(p) {
  if (p?.shop_name) return p.shop_name;
  try { if (p?.link) return new URL(p.link).host; } catch { /* link hỏng → rơi xuống brand nền tảng */ }
  return PLATFORM_BRAND;
}
// Khung HTML email: header thương hiệu (text) + nội dung + nút CTA (nếu có) + footer.
// Table + inline style (Gmail/Outlook bỏ <style>); KHÔNG ảnh/CSS/font ngoài. Màu an toàn
// dark-mode: nền trắng ép bằng bgcolor + chữ tối #111827 — client dark tự đảo, không mất chữ.
function emailHtml(p, title, bodyHtml, cta) {
  const brand = escHtml(brandOf(p));
  const btn = cta ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0 6px"><tr><td bgcolor="#1d4ed8" style="border-radius:6px"><a href="${escHtml(cta.url)}" style="display:inline-block;padding:11px 22px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none">${escHtml(cta.label)}</a></td></tr></table>` : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f3f4f6" style="background-color:#f3f4f6;padding:24px 12px"><tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="background-color:#ffffff;width:100%;max-width:560px;border-radius:8px;border:1px solid #e5e7eb;font-family:Arial,Helvetica,sans-serif;color:#111827">
<tr><td style="padding:16px 28px;border-bottom:1px solid #e5e7eb;font-size:16px;font-weight:bold;color:#111827">${brand}</td></tr>
<tr><td style="padding:22px 28px;font-size:14px;line-height:1.65;color:#111827">
<h1 style="margin:0 0 12px;font-size:18px;line-height:1.4;color:#111827">${escHtml(title)}</h1>
${bodyHtml}${btn}</td></tr>
<tr><td style="padding:14px 28px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.5;color:#6b7280">${brand} — Email tự động từ cửa hàng trên nentang.vn. Vui lòng không trả lời email này.</td></tr>
</table></td></tr></table>`;
}
// Bảng thông tin nhỏ (mã đơn/tổng tiền/…) — value do CALLER escape (tránh escape kép).
const kvRow = (k, v) => `<tr><td style="padding:5px 12px 5px 0;color:#6b7280;white-space:nowrap;vertical-align:top">${escHtml(k)}</td><td style="padding:5px 0;color:#111827"><strong>${v}</strong></td></tr>`;
const kvTable = (rows) => `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:4px 0 6px">${rows.join('')}</table>`;
const par = (s) => `<p style="margin:0 0 10px">${s}</p>`;

function compose(topic, p) {
  const footer = `${p.link ? `\n\nTra cứu đơn hàng: ${p.link}` : ''}\n\nCảm ơn bạn!`;
  const trackCta = p.link ? { url: p.link, label: 'Tra cứu đơn hàng' } : null;
  const payLabel = p.payment_method === 'qr' ? 'chuyển khoản QR' : 'khi nhận hàng (COD)';
  if (topic === 'order.created') {
    return {
      subject: `Xác nhận đơn hàng #${p.order_number}`,
      text: `Chào ${p.customer_name || 'bạn'},\n\nĐơn hàng #${p.order_number} đã được ghi nhận.\nTổng: ${money(p.total_vnd)} — Thanh toán: ${payLabel}.${footer}`,
      html: emailHtml(p, `Xác nhận đơn hàng #${p.order_number}`,
        par(`Chào ${escHtml(p.customer_name || 'bạn')}, đơn hàng của bạn đã được ghi nhận.`) +
        kvTable([
          kvRow('Mã đơn', `#${escHtml(p.order_number)}`),
          kvRow('Tổng tiền', escHtml(money(p.total_vnd))),
          kvRow('Thanh toán', escHtml(payLabel)),
        ]), trackCta),
    };
  }
  if (topic === 'order.paid') {
    return {
      subject: `Đã nhận thanh toán đơn #${p.order_number}`,
      text: `Chào ${p.customer_name || 'bạn'},\n\nChúng tôi đã nhận đủ thanh toán cho đơn hàng #${p.order_number} (${money(p.total_vnd)}).\nĐơn của bạn đang được xử lý.${footer}`,
      html: emailHtml(p, `Đã nhận thanh toán đơn #${p.order_number}`,
        par(`Chào ${escHtml(p.customer_name || 'bạn')}, chúng tôi đã nhận đủ thanh toán cho đơn hàng của bạn.`) +
        kvTable([
          kvRow('Mã đơn', `#${escHtml(p.order_number)}`),
          kvRow('Số tiền', escHtml(money(p.total_vnd))),
        ]) + par('Đơn của bạn đang được xử lý.'), trackCta),
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
        html: emailHtml(p, `Đơn hàng #${p.order_number} đã tự huỷ`,
          par(`Đơn hàng <strong>#${escHtml(p.order_number)}</strong> đã được hệ thống tự huỷ vì ${escHtml(why)}.`) +
          par('Hàng đã được trả lại kho — nếu bạn vẫn muốn mua, vui lòng đặt lại đơn mới.'), trackCta),
      };
    }
    // MỞ LẠI ĐƠN: khách vừa nhận thư "đơn đã huỷ" — im lặng mở lại rồi giao tới nhà là làm khách
    // hoảng. Tách nhánh riêng vì trạng thái đích là 'pending', mà nhãn thô của nó lọt ra ngoài
    // sẽ thành "Đơn hàng #216 — pending" trong hộp thư của người Việt.
    if (p.status === 'pending' && p.reopened) {
      return {
        subject: `Đơn hàng #${p.order_number} đã được mở lại`,
        text: `Đơn hàng #${p.order_number} trước đó đã huỷ, nay được cửa hàng MỞ LẠI và đang chờ xử lý.\nNếu bạn không còn muốn mua, vui lòng báo lại cửa hàng để huỷ.${footer}`,
        html: emailHtml(p, `Đơn hàng #${p.order_number} đã được mở lại`,
          par(`Đơn hàng <strong>#${escHtml(p.order_number)}</strong> trước đó đã huỷ, nay được cửa hàng <strong>mở lại</strong> và đang chờ xử lý.`) +
          par('Nếu bạn không còn muốn mua, vui lòng báo lại cửa hàng để huỷ.'), trackCta),
      };
    }
    const label = { confirmed: 'đã được xác nhận', shipped: 'đang trên đường giao', delivered: 'đã giao thành công', cancelled: 'đã huỷ', refunded: 'đã hoàn tiền', returned: 'đã được hoàn về cửa hàng' }[p.status] ?? p.status;
    // HUỶ ĐƠN (0117): người mất tiền có quyền biết VÌ SAO và BAO NHIÊU sẽ được trả.
    // Trước đây email chỉ nói "đã huỷ" — khách đã chuyển khoản không có thông tin nào
    // về khoản tiền của mình.
    const cancelWhy = p.status === 'cancelled' && p.cancel_reason ? `\nLý do: ${p.cancel_reason}` : '';
    const cancelWhyHtml = p.status === 'cancelled' && p.cancel_reason ? par(`Lý do: ${escHtml(p.cancel_reason)}`) : '';
    // TIỀN TRONG EMAIL — cho MỌI trạng thái đóng đơn, không riêng 'cancelled'.
    //
    // Trước đây chỉ đơn huỷ mới nhắc tới tiền, và nhắc bằng `refund_due_vnd` do nhánh huỷ tự
    // tính = total_vnd. Hai chỗ sai: (1) đơn ĐÃ TRẢ HÀNG hoặc ĐÃ HOÀN TIỀN thì email im lặng
    // hoàn toàn về tiền — khách vừa gửi hàng đi, đọc thư chỉ thấy đổi trạng thái; (2) đơn đã
    // hoàn một phần rồi mới huỷ thì email HỨA hoàn nguyên tổng đơn, nhiều hơn số shop còn nợ.
    // Một lời hứa sai bằng chữ, gửi thẳng vào hộp thư, là thứ khó rút lại nhất.
    //
    // Nay statusEvent đính kèm paid/refunded/owed tính bằng công thức DÙNG CHUNG (owed.js) —
    // cùng con số với trang quản trị, trang tra cứu và lịch sử đơn của khách (docs/66, 67).
    // `refund_due_vnd` giữ làm đường lui cho các dòng outbox CŨ đã nằm sẵn trong hàng đợi.
    const dong = ['cancelled', 'refunded', 'returned'].includes(p.status);
    const daTra = Number(p.paid_vnd ?? p.refund_due_vnd ?? 0);
    const daHoan = Number(p.refunded_vnd ?? 0);
    const conNo = p.owed_vnd != null ? Number(p.owed_vnd) : Math.max(0, daTra - daHoan);
    const tienDong = [];
    if (dong && daTra > 0) {
      tienDong.push(`Bạn đã thanh toán ${money(daTra)} cho đơn này.`);
      if (daHoan > 0) tienDong.push(`Cửa hàng đã hoàn lại ${money(daHoan)}.`);
      if (conNo > 0) {
        tienDong.push(`Cửa hàng còn phải hoàn ${money(conNo)}. Nếu sau vài ngày làm việc bạn vẫn chưa nhận được, vui lòng liên hệ cửa hàng kèm số đơn #${p.order_number}.`);
      } else if (daHoan > 0) {
        tienDong.push('Cửa hàng đã hoàn đủ khoản bạn thanh toán cho đơn này.');
      }
    }
    const cancelDue = tienDong.length ? `\n${tienDong.join(' ')}` : '';
    const cancelDueHtml = tienDong.map((s) => par(escHtml(s))).join('');
    const extra = p.status === 'shipped' && p.tracking_number ? `\nMã vận đơn: ${p.tracking_number} — bạn có thể tra trên trang của hãng vận chuyển.`
      : p.status === 'delivered' ? '\nCảm ơn bạn đã mua hàng! Nếu có vấn đề với sản phẩm, hãy liên hệ cửa hàng.'
      : p.tracking_number ? `\nMã vận đơn: ${p.tracking_number}` : '';
    const extraHtml = p.status === 'shipped' && p.tracking_number ? par(`Mã vận đơn: <strong>${escHtml(p.tracking_number)}</strong> — bạn có thể tra trên trang của hãng vận chuyển.`)
      : p.status === 'delivered' ? par('Cảm ơn bạn đã mua hàng! Nếu có vấn đề với sản phẩm, hãy liên hệ cửa hàng.')
      : p.tracking_number ? par(`Mã vận đơn: <strong>${escHtml(p.tracking_number)}</strong>`) : '';
    return {
      subject: `Đơn hàng #${p.order_number} — ${label}`,
      text: `Đơn hàng #${p.order_number} ${label}.${cancelWhy}${cancelDue}${extra}${footer}`,
      html: emailHtml(p, `Đơn hàng #${p.order_number} — ${label}`,
        par(`Đơn hàng <strong>#${escHtml(p.order_number)}</strong> ${escHtml(label)}.`)
        + cancelWhyHtml + cancelDueHtml + extraHtml, trackCta),
    };
  }
  if (topic === 'user.password_reset') {
    // Sự kiện CẤP IDENTITY (outbox shop_id NULL — 0058): chỉ email, worker không đọc users.
    return {
      subject: 'Đặt lại mật khẩu nentang.vn',
      text: `Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản này.\n\nMở link sau để đặt mật khẩu mới (hết hạn sau 30 phút, dùng một lần):\n${p.link}\n\nNếu bạn KHÔNG yêu cầu, hãy bỏ qua email này — mật khẩu của bạn không thay đổi.`,
      html: emailHtml({ shop_name: PLATFORM_BRAND }, 'Đặt lại mật khẩu nentang.vn',
        par('Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản này.') +
        par('Bấm nút bên dưới để đặt mật khẩu mới (hết hạn sau 30 phút, dùng một lần).') +
        par(`<span style="color:#6b7280">Nếu bạn KHÔNG yêu cầu, hãy bỏ qua email này — mật khẩu của bạn không thay đổi.</span>`),
        { url: p.link, label: 'Đặt mật khẩu mới' }),
    };
  }
  // Self-serve signup (0091): kích hoạt cửa hàng vừa đăng ký. Cấp NỀN TẢNG (outbox shop_id NULL —
  // shop chưa tồn tại). p = {to, name, slug, link}. Bấm link → provision (verify-trước-provision).
  if (topic === 'signup.verify') {
    const url = p.link, storeAddr = `${p.slug ?? ''}.${(process.env.PLATFORM_DOMAIN ?? 'nentang.vn')}`;
    return {
      subject: `Kích hoạt cửa hàng "${p.name ?? ''}" — ${PLATFORM_BRAND}`,
      text: `Cảm ơn bạn đã đăng ký mở cửa hàng "${p.name ?? ''}" tại ${storeAddr}.\n\nBấm link sau để KÍCH HOẠT cửa hàng (hết hạn sau 30 phút):\n${url}\n\nNếu bạn KHÔNG đăng ký, hãy bỏ qua email này — không có gì được tạo.`,
      html: emailHtml({ shop_name: PLATFORM_BRAND }, `Kích hoạt cửa hàng của bạn`,
        par(`Cảm ơn bạn đã đăng ký mở cửa hàng <strong>${escHtml(p.name ?? '')}</strong> tại <strong>${escHtml(storeAddr)}</strong>.`) +
        par('Bấm nút bên dưới để kích hoạt cửa hàng (hết hạn sau 30 phút).') +
        par('<span style="color:#6b7280">Nếu bạn KHÔNG đăng ký, hãy bỏ qua email này — không có gì được tạo.</span>'),
        { url, label: 'Kích hoạt cửa hàng' }),
    };
  }
  // Tài khoản khách (0083): brand = tên shop (p.shop_name) + link về domain shop (brandOf p.link).
  if (topic === 'customer.email_verify') {
    return {
      subject: `Xác minh email — ${p.shop_name ?? 'cửa hàng'}`,
      text: `Cảm ơn bạn đã tạo tài khoản tại ${p.shop_name ?? 'cửa hàng'}.\n\nXác minh email của bạn (hết hạn sau 24 giờ):\n${p.link}\n\nNếu bạn không tạo tài khoản, hãy bỏ qua email này.`,
      html: emailHtml(p, `Xác minh email — ${p.shop_name ?? 'cửa hàng'}`,
        par(`Cảm ơn bạn đã tạo tài khoản tại <strong>${escHtml(p.shop_name ?? 'cửa hàng')}</strong>.`) +
        par('Bấm nút bên dưới để xác minh email (hết hạn sau 24 giờ).') +
        par('<span style="color:#6b7280">Nếu bạn không tạo tài khoản, hãy bỏ qua email này.</span>'),
        { url: p.link, label: 'Xác minh email' }),
    };
  }
  if (topic === 'customer.password_reset') {
    return {
      subject: `Đặt lại mật khẩu — ${p.shop_name ?? 'cửa hàng'}`,
      text: `Chúng tôi nhận được yêu cầu đặt lại mật khẩu tài khoản của bạn tại ${p.shop_name ?? 'cửa hàng'}.\n\nMở link sau để đặt mật khẩu mới (hết hạn sau 30 phút, dùng một lần):\n${p.link}\n\nNếu bạn KHÔNG yêu cầu, hãy bỏ qua email này.`,
      html: emailHtml(p, `Đặt lại mật khẩu — ${p.shop_name ?? 'cửa hàng'}`,
        par('Chúng tôi nhận được yêu cầu đặt lại mật khẩu tài khoản của bạn.') +
        par('Bấm nút bên dưới để đặt mật khẩu mới (hết hạn sau 30 phút, dùng một lần).') +
        par('<span style="color:#6b7280">Nếu bạn KHÔNG yêu cầu, hãy bỏ qua email này.</span>'),
        { url: p.link, label: 'Đặt mật khẩu mới' }),
    };
  }
  if (topic === 'user.invited') {
    // HỢP ĐỒNG với Đợt 5.5 (service ghi outbox 'user.invited'): payload CHÍNH XÁC là
    // {to, shop_name, role, accept_url, expires_days} — đổi tên trường phải đổi CẢ HAI phía.
    const roleLabel = { owner: 'Chủ cửa hàng', admin: 'Quản trị', staff: 'Nhân viên', catalog_manager: 'Quản lý sản phẩm', order_manager: 'Quản lý đơn hàng' }[p.role] ?? p.role;
    return {
      subject: `Lời mời quản trị cửa hàng ${p.shop_name}`,
      text: `Bạn được mời tham gia quản trị cửa hàng ${p.shop_name} với vai trò ${roleLabel}.\n\nMở link sau để chấp nhận lời mời:\n${p.accept_url}\n\nLời mời hết hạn sau ${p.expires_days} ngày. Nếu bạn KHÔNG mong đợi lời mời này, hãy bỏ qua email — không có gì thay đổi.`,
      html: emailHtml(p, `Lời mời quản trị cửa hàng ${p.shop_name}`,
        par(`Bạn được mời tham gia quản trị cửa hàng <strong>${escHtml(p.shop_name)}</strong> với vai trò <strong>${escHtml(roleLabel)}</strong>.`) +
        par(`Lời mời hết hạn sau <strong>${escHtml(p.expires_days)} ngày</strong>.`) +
        par(`<span style="color:#6b7280">Nếu bạn KHÔNG mong đợi lời mời này, hãy bỏ qua email — không có gì thay đổi.</span>`),
        { url: p.accept_url, label: 'Chấp nhận lời mời' }),
    };
  }
  if (topic === 'support.ticket_created') {
    return {
      subject: `[Hỗ trợ] ${p.subject ?? '(không tiêu đề)'}`,
      text: `Yêu cầu hỗ trợ mới từ shop ${p.shop_id ?? ''}
Từ: ${p.from ?? '(không rõ)'}
`
        + `${p.context_url ? `Trang: ${p.context_url}
` : ''}Mã phiếu: ${p.ticket_id ?? ''}`,
    };
  }
  // Chiều VỀ (0108): người nhận là NGƯỜI BÁN, người gửi là NỀN TẢNG. Cố ý KHÔNG truyền
  // shop_name vào payload → brandOf() rơi về PLATFORM_BRAND: thư này do nentang.vn gửi, đóng
  // dấu tên shop của chính người nhận lên đó là mạo danh họ với chính họ.
  if (topic === 'support.ticket_resolved') {
    const done = p.note
      ? `Chúng tôi đã xử lý:\n\n${p.note}`
      : 'Yêu cầu của bạn đã được xử lý.';
    return {
      subject: `Đã xử lý yêu cầu hỗ trợ: ${p.subject ?? ''}`,
      text: `Chào bạn,\n\nYêu cầu "${p.subject ?? ''}" đã được xử lý xong.\n\n${done}\n\nNếu vẫn chưa ổn, bạn gửi lại một yêu cầu mới trong mục Trợ giúp — chúng tôi xem tiếp.`,
      html: emailHtml(p, 'Yêu cầu hỗ trợ đã được xử lý',
        par(`Yêu cầu <strong>${escHtml(p.subject ?? '')}</strong> đã được xử lý xong.`) +
        (p.note ? par(escHtml(p.note)) : '') +
        par('<span style="color:#6b7280">Nếu vẫn chưa ổn, bạn gửi lại một yêu cầu mới trong mục Trợ giúp — chúng tôi xem tiếp.</span>')),
    };
  }
  if (topic === 'shop.onboarding_nudge') {
    // Email DUY NHẤT ta gửi cho người bán ở giai đoạn này, nên nó phải đáng một lần mở hộp thư:
    // nói địa chỉ shop đã sống, nói việc kế tiếp, hết. Không khoe tính năng, không giục mua gói.
    const cta = p.admin_url ? { url: p.admin_url, label: 'Thêm sản phẩm đầu tiên' } : null;
    return {
      subject: `Cửa hàng ${p.shop_name ?? ''} đã sẵn sàng — còn thiếu sản phẩm`,
      text: `Cửa hàng "${p.shop_name ?? ''}" của bạn đã hoạt động, nhưng chưa có sản phẩm nào nên khách vào chưa mua được gì.

`
        + `Thêm một sản phẩm là bán được ngay — không cần chờ thiết lập xong hết.
`
        + `${p.admin_url ? `
Vào trang quản trị: ${p.admin_url}
` : ''}`
        + `
Vướng ở đâu cứ trả lời email này, chúng tôi hỗ trợ.`,
      html: emailHtml(p, `Cửa hàng đã sẵn sàng — còn thiếu sản phẩm`,
        par(`Cửa hàng <strong>${escHtml(p.shop_name ?? '')}</strong> của bạn đã hoạt động, nhưng chưa có sản phẩm nào nên khách vào chưa mua được gì.`)
        + par('Thêm <strong>một</strong> sản phẩm là bán được ngay — không cần chờ thiết lập xong hết.')
        + par('<span style="color:#6b7280">Vướng ở đâu cứ trả lời email này, chúng tôi hỗ trợ.</span>'), cta),
    };
  }
  if (topic === 'stock.low') {
    const lines = (p.items ?? []).map((i) => `  • ${i.title}${i.variant_title ? ` (${i.variant_title})` : ''} — còn ${i.available}`).join('\n');
    const rowsHtml = (p.items ?? []).map((i) => `<tr><td style="padding:6px 12px 6px 0;border-bottom:1px solid #f3f4f6">${escHtml(i.title)}${i.variant_title ? ` <span style="color:#6b7280">(${escHtml(i.variant_title)})</span>` : ''}</td><td align="right" style="padding:6px 0;border-bottom:1px solid #f3f4f6;white-space:nowrap"><strong>còn ${escHtml(i.available)}</strong></td></tr>`).join('');
    return {
      subject: `⚠ ${p.items?.length ?? 0} sản phẩm sắp hết hàng`,
      text: `Các sản phẩm sau còn tồn thấp (≤ ${p.threshold}):\n\n${lines}\n\nVào trang quản trị để nhập thêm hàng hoặc ẩn sản phẩm.`,
      html: emailHtml(p, `${p.items?.length ?? 0} sản phẩm sắp hết hàng`,
        par(`Các sản phẩm sau còn tồn thấp (≤ ${escHtml(p.threshold)}):`) +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin:4px 0 6px">${rowsHtml}</table>` +
        par('Vào trang quản trị để nhập thêm hàng hoặc ẩn sản phẩm.')),
    };
  }
  if (topic === 'subscription.reminder') {
    // NHẮC HẠN thuê bao (dunning 7/3/1 + past_due) — gửi tới shops.contact_email.
    // Nhánh này BẮT BUỘC: thiếu nó fallback dưới sẽ email JSON thô cho chủ shop.
    const d = (iso) => new Date(iso).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const plan = p.plan_name || p.plan_code || '';
    const who = p.shop_name ? `cửa hàng ${p.shop_name}` : 'cửa hàng của bạn';
    // TỰ GIA HẠN đứng TRƯỚC (0124-0128). Bản cũ chỉ nói "liên hệ nền tảng" — từ khi có
    // trang Gói dịch vụ thì câu đó bắt người ta chờ mình trả lời để được TRẢ TIỀN cho mình.
    // Vẫn giữ email liên hệ làm lối phụ cho ai gặp trục trặc.
    const payUrl = ADMIN_URL && p.shop_id ? `${ADMIN_URL}/shops/${p.shop_id}/billing` : null;
    const contact = (payUrl ? `\n\nGia hạn ngay (quét mã, hệ thống tự vào hạn): ${payUrl}` : '')
      + `\n\nCần hỗ trợ? Liên hệ ${PLATFORM_BRAND}: ${BILLING_CONTACT}.`;
    const contactHtml = (payUrl ? par(`<a href="${escHtml(payUrl)}"><strong>Gia hạn ngay</strong></a> — quét mã chuyển khoản, hệ thống tự vào hạn trong vài phút.`) : '')
      + par(`Cần hỗ trợ? Liên hệ ${escHtml(PLATFORM_BRAND)}: <strong>${escHtml(BILLING_CONTACT)}</strong>.`);
    if (p.milestone === 'past_due') {
      return {
        subject: `⚠ Thuê bao ${who} ĐÃ QUÁ HẠN — còn ${p.grace_days_left} ngày trước khi website tạm ngưng`,
        text: `Gói ${plan} của ${who} đã HẾT HẠN ngày ${d(p.period_end)}.\nWebsite hiện VẪN hoạt động trong thời gian ân hạn — còn ${p.grace_days_left} ngày.\nNếu chưa gia hạn trong thời gian này, website sẽ TẠM NGƯNG (khách không truy cập được). Dữ liệu được giữ nguyên và khôi phục ngay khi gia hạn.${contact}`,
        html: emailHtml(p, `Thuê bao ĐÃ QUÁ HẠN — còn ${p.grace_days_left} ngày ân hạn`,
          par(`Gói <strong>${escHtml(plan)}</strong> của ${escHtml(who)} đã hết hạn ngày <strong>${escHtml(d(p.period_end))}</strong>.`) +
          par(`Website hiện VẪN hoạt động trong thời gian ân hạn — còn <strong>${escHtml(p.grace_days_left)} ngày</strong>. Nếu chưa gia hạn, website sẽ tạm ngưng (khách không truy cập được). Dữ liệu được giữ nguyên và khôi phục ngay khi gia hạn.`) +
          contactHtml),
      };
    }
    const label = p.sub_status === 'trial' ? `Thời gian dùng thử (gói ${plan})` : `Gói ${plan}`;
    return {
      subject: `${label} của ${who} sắp hết hạn — còn ${p.days_left} ngày`,
      text: `${label} của ${who} sẽ hết hạn ngày ${d(p.period_end)} (còn ${p.days_left} ngày).\nGia hạn trước ngày này để website và đơn hàng hoạt động liên tục, không gián đoạn.${contact}`,
      html: emailHtml(p, `${label} sắp hết hạn — còn ${p.days_left} ngày`,
        par(`${escHtml(label)} của ${escHtml(who)} sẽ hết hạn ngày <strong>${escHtml(d(p.period_end))}</strong> (còn ${escHtml(p.days_left)} ngày).`) +
        par('Gia hạn trước ngày này để website và đơn hàng hoạt động liên tục, không gián đoạn.') +
        contactHtml),
    };
  }
  return { subject: `Thông báo`, text: JSON.stringify(p) }; // fallback: text-only, không html
}

// Điểm nối KÊNH THÔNG BÁO: hiện chỉ email; sau này thêm Zalo ZNS tại đây (cần OA +
// template được Zalo duyệt — tích hợp khi user có tài khoản OA, KHÔNG dựng code chết).
// List-Unsubscribe: CỐ Ý KHÔNG đặt — RÀ TỪNG topic thì TẤT CẢ đều transactional:
// order.* (trạng thái đơn khách vừa đặt), user.password_reset / user.invited (hành động
// người nhận khởi phát), stock.low + subscription.reminder (thông báo vận hành/thu phí tới
// CHỦ SHOP đang trả tiền dịch vụ — tắt là mất cảnh báo nghiệp vụ, không phải marketing).
// Không có topic marketing nào → header unsubscribe sẽ là cargo-cult (bấm vào tắt được
// email giao dịch = tự hại). Khi nào thêm email marketing/newsletter MỚI phải thêm header
// (mailto + one-click RFC 8058). Bounce/complaint handling nằm ở RELAY (Resend/SES dashboard
// + suppression list của relay) — xem docs/35 mục deliverability.
async function deliverNotification(topic, payload, outboxId) {
  if (!payload?.to) return { status: 'skipped' }; // không có email → bỏ qua (ZNS sau này dùng payload.phone)
  // DEDUP theo outboxId (mirror tgsent): queue at-least-once — nếu job gửi email XONG rồi
  // chết/lỗi ở bước sau → retry → KHÔNG gửi email TRÙNG cho khách. Đánh dấu SAU khi
  // sendMail thành công (lỗi relay tạm thời vẫn được thử lại). Redis chung với queue.
  const rc = outboxId ? await queue.client : null;
  if (rc && (await rc.get(`emailsent:${outboxId}`))) return { status: 'accepted' };
  const { subject, text, html } = compose(topic, payload);
  const info = await transport.sendMail({
    from: FROM, to: payload.to, subject, text, ...(html ? { html } : {}),
    messageId: outboxId ? `<outbox-${outboxId}@nentang.vn>` : undefined,
  });
  if (rc) await rc.set(`emailsent:${outboxId}`, '1', 'EX', 86400);
  return { status: 'accepted', providerMessageId: String(info?.messageId ?? '').slice(0, 500) || null };
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
      // removeOnFail CÓ TRẦN (7 ngày / 1000 job): dead-letter để soi + retry (xem
      // /internal/dead-letters) nhưng KHÔNG tích trong Redis vĩnh viễn (audit #47).
      // sweepMoneyAlerts cảnh báo theo SỐ LƯỢNG failed hiện có — quét mỗi 5', ngưỡng
      // ALERT_EMAIL_FAIL_MAX; giữ 7 ngày ≫ cửa sổ cảnh báo nên cắt trần KHÔNG làm lọt cảnh báo.
      await queue.add(
        r.topic, { topic: r.topic, payload: r.payload, shopId: r.shop_id, outboxId: String(r.id) },
        { jobId: `ob-${r.id}`, attempts: r.topic.startsWith('integration.') ? INTEGRATION_ATTEMPTS : ATTEMPTS,
          backoff: r.topic.startsWith('integration.')
            ? { type: 'integration' } : { type: 'fixed', delay: BACKOFF_MS },
          removeOnComplete: { count: 500 }, removeOnFail: { age: 7 * 24 * 3600, count: 1000 } },
      );
      await queueDeliveryRows(c, r);
    }
    if (rows.length) await c.query(`UPDATE outbox SET processed_at = now() WHERE id = ANY($1::bigint[])`, [rows.map((r) => r.id)]);
    await c.query('COMMIT');
    if (rows.length) log('info', 'outbox_dispatched', { n: rows.length });
  } catch (e) {
    if (c) await c.query('ROLLBACK').catch(() => {});
    log('error', 'poll_error', { message: e.message });
  } finally { if (c) c.release(); }
}

// Yêu cầu hỗ trợ → CHỦ NỀN TẢNG. Telegram trước (tới ngay), email sau nếu có cấu hình.
// KHÔNG throw: hỗ trợ mà làm job fail rồi retry sẽ nhân bản thông báo, và phiếu thì đã nằm
// trong DB rồi — mất thông báo còn hơn spam chủ nền tảng mười lần cùng một phiếu.
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL ?? '';
async function deliverSupportAlert(p, shopId, outboxId) {
  const line = `🆘 Yêu cầu hỗ trợ mới
Shop: ${shopId}
Từ: ${p?.from ?? '(không rõ)'}
`
    + `Tiêu đề: ${p?.subject ?? ''}
${p?.context_url ? `Trang: ${p.context_url}
` : ''}`
    + `Mã phiếu: ${p?.ticket_id ?? ''}`;
  try {
    if (TELEGRAM_ON && ALERT_TELEGRAM_CHAT_ID) await tgSend(ALERT_TELEGRAM_CHAT_ID, line);
  } catch (e) { log('warn', 'support_alert_telegram_failed', { message: e.message }); }
  try {
    if (SUPPORT_EMAIL) {
      await deliverNotification('support.ticket_created', { ...p, to: SUPPORT_EMAIL }, outboxId);
    }
  } catch (e) { log('warn', 'support_alert_email_failed', { message: e.message }); }
  log('info', 'support_alert', { shopId, ticket: p?.ticket_id ?? null,
    telegram: Boolean(TELEGRAM_ON && ALERT_TELEGRAM_CHAT_ID), email: Boolean(SUPPORT_EMAIL) });
}

// ── banner mặc định cho shop mới (0114) ──────────────────────────────────────
// Preset ngành seed `hero.slides: []`; theme.js chỉ render hero_side/promo_banners
// khi có slide hợp lệ → shop vừa cấp phát hiện 3 khối thay vì 12. Ở đây vẽ bộ
// banner đầu tiên theo ĐÚNG palette shop đang dùng (đọc themes.tokens, KHÔNG đọc
// preset) → chủ shop đổi màu trước khi worker chạy thì banner vẫn khớp.
//
// Key phải khớp BANNER_KEY_RE của theme.js: <shop-uuid>/banner-<uuid>.webp
async function seedShopBanners(payload, outboxId) {
  const shopId = payload?.shop_id;
  if (!/^[0-9a-f-]{36}$/i.test(String(shopId ?? ''))) {
    log('warn', 'banner_seed_bad_payload', { outboxId });
    return;
  }
  const row = (await db.query('SELECT tokens, layout FROM themes WHERE shop_id = $1', [shopId])).rows[0];
  if (!row || !Array.isArray(row.layout)) { log('warn', 'banner_seed_no_theme', { outboxId }); return; }

  // IDEMPOTENT: đã có slide (worker chạy lại, hoặc chủ shop tự tải ảnh trước khi
  // ta kịp) thì KHÔNG đè. Banner của người thật luôn thắng banner máy vẽ.
  const hero = row.layout.find((s) => s && s.section === 'hero');
  if (Array.isArray(hero?.props?.slides) && hero.props.slides.length) {
    log('info', 'banner_seed_skip_existing', { outboxId });
    return;
  }

  const { bannerPlan } = await import('../banner-art.js');
  const sharp = (await import('sharp')).default;
  const minio = await getMinio();
  const BPUB = process.env.MEDIA_BUCKET_PUBLIC ?? 'media-public';

  const made = { hero: [], side: [], promo: [] };
  for (const b of bannerPlan(payload?.industry ?? null, row.tokens)) {
    const key = `${shopId}/banner-${crypto.randomUUID()}.webp`;
    const buf = await sharp(Buffer.from(b.svg)).webp({ quality: 84 }).toBuffer();
    await minio.putObject(BPUB, key, buf, buf.length, { 'Content-Type': 'image/webp' });
    // button_label BẮT BUỘC đi kèm button_link ở hero: thiếu nhãn thì
    // heroBannerInner bỏ nút CTA, im lặng không báo lỗi.
    made[b.slot].push({
      image_key: key, headline: b.headline, sub: b.sub, button_link: '/products',
      ...(b.slot === 'hero' ? { button_label: 'Xem sản phẩm' } : {}),
    });
  }

  const bySlot = { hero: made.hero, hero_side: made.side, promo_banners: made.promo };

  // GHI CÓ ĐIỀU KIỆN — chống mất-cập-nhật.
  //
  // Trước đây đây là đọc–sửa–ghi trần: layout đọc ở đầu hàm, rồi ĐÈ nguyên mảng ở
  // cuối. Khoảng giữa hai mốc đó có việc vẽ ảnh + upload MinIO cho từng banner, tức
  // hàng giây tới hàng chục giây. Chủ shop bấm Lưu trong trang Giao diện đúng khoảng
  // đó là thay đổi của HỌ bị đè mất, im lặng, không ai biết. Và đây đúng là lúc dễ
  // trùng nhất: banner-seed chạy ngay khi cấp phát shop, còn chủ shop mới thì hay
  // vào nghịch giao diện ngay phút đầu.
  //
  // Cách vá: đọc LẠI layout ngay trước khi ghi, và chỉ ghi khi nó CÒN NGUYÊN như lúc
  // đọc (`AND layout = $3::jsonb` — so sánh jsonb là so sánh ngữ nghĩa, không phụ
  // thuộc thứ tự khoá). Ai đó chen vào giữa thì rowCount = 0 → đọc lại, đắp slides
  // lên bản MỚI của họ rồi ghi lại. Ảnh đã upload nên vòng lặp KHÔNG vẽ lại gì.
  //
  // Không dùng cột `version` vì app_worker chỉ được cấp SELECT/UPDATE trên `layout`
  // (0114); dùng version sẽ phải mở thêm quyền cho một việc dọn dẹp — so sánh chính
  // giá trị sắp bị đè đã đủ chặt mà không nới quyền.
  let n = 0;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const cur = (await db.query('SELECT layout FROM themes WHERE shop_id = $1', [shopId])).rows[0];
    if (!cur || !Array.isArray(cur.layout)) { log('warn', 'banner_seed_no_theme', { outboxId }); return; }
    // Người thật đã tự tải banner trong lúc ta đang vẽ → nhường. Cùng luật idempotent
    // ở đầu hàm, nhưng kiểm LẠI trên bản mới nhất chứ không trên bản đọc lúc đầu.
    const h = cur.layout.find((s) => s && s.section === 'hero');
    if (Array.isArray(h?.props?.slides) && h.props.slides.length) {
      log('info', 'banner_seed_skip_existing', { outboxId, attempt });
      return;
    }
    const before = JSON.stringify(cur.layout);
    for (const s of cur.layout) {
      if (s && bySlot[s.section]) s.props = { ...s.props, slides: bySlot[s.section] };
    }
    // layout là MẢNG → JSON.stringify, không thì node-pg ép thành array-literal.
    const r = await db.query(
      'UPDATE themes SET layout = $2 WHERE shop_id = $1 AND layout = $3::jsonb',
      [shopId, JSON.stringify(cur.layout), before],
    );
    if (r.rowCount) { n = attempt; break; }
    // Có người ghi chen. Ghi log mức warn: im lặng thử lại thì một xung đột THẬT SỰ
    // hay xảy ra sẽ không bao giờ lộ ra.
    log('warn', 'banner_seed_conflict_retry', { outboxId, attempt });
    if (attempt === 4) {
      // Bỏ cuộc còn hơn đè: banner mặc định chỉ là mồi, cấu hình của chủ shop thì không.
      log('error', 'banner_seed_gave_up', { outboxId, why: 'layout bị ghi đè liên tục bởi người khác' });
      return;
    }
  }
  log('info', 'banner_seed_done', { outboxId, n: made.hero.length + made.side.length + made.promo.length, attempts: n });
}

// ── Đường tiền NỀN TẢNG: áp dụng khoản đã trả + cưỡng chế hết hạn (0124) ─────
// TÁCH đôi có chủ ý: payment service (vai hẹp, ăn dữ liệu từ Internet) CHỈ đánh dấu
// billing_charges đã trả; worker mới cộng hạn + mở khoá + ghi sổ thu. Nếu để payment làm
// hết thì vai xử lý webhook phải có quyền sửa subscriptions và shops — đúng thứ không nên
// trao cho endpoint công khai.
//
// applied_at NULL = còn việc → sweep nhặt. Máy chết giữa chừng thì nhịp sau làm lại; cộng
// hạn hai lần bị chặn bởi chính applied_at (đặt trong CÙNG transaction với cộng hạn).
const BILLING_GRACE_DAYS = Number(process.env.BILLING_GRACE_DAYS ?? 7);
async function sweepBillingApply(batch = 100) {
  if (!billingDb) return 0;
  let c, n = 0;
  try {
    c = await billingDb.connect();
    await c.query('BEGIN');
    const rows = (await c.query(
      `SELECT id, shop_id, plan_code, months, amount_vnd FROM billing_charges
        WHERE status = 'paid' AND applied_at IS NULL
        ORDER BY paid_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [batch],
    )).rows;
    for (const ch of rows) {
      // Cộng hạn từ MỐC LỚN HƠN giữa "hạn cũ" và "bây giờ": trả sớm thì cộng nối tiếp
      // (không mất ngày đã mua), trả muộn thì tính từ hôm nay (không tặng ngày đã lỡ).
      await c.query(
        `UPDATE subscriptions
            SET status = 'active',
                plan_code = $2,
                current_period_end = GREATEST(COALESCE(current_period_end, now()), now()) + ($3 || ' months')::interval
          WHERE shop_id = $1`,
        [ch.shop_id, ch.plan_code, String(ch.months)],
      );
      // MỞ KHOÁ + XOÁ CỜ trong MỘT câu lệnh.
      //
      // Bản trước tách làm hai (đọc cờ → mở khoá → xoá cờ) và e2e bắt được đúng cái nó sinh
      // ra để bắt: có lúc hạn được cộng mà shop vẫn khoá — nghĩa là khách TRẢ TIỀN RỒI VẪN
      // KHÔNG BÁN ĐƯỢC, kết cục tệ nhất có thể. Nguyên nhân là phụ thuộc thứ tự: cờ bị xoá
      // trước khi kịp dùng (và hai lần quét chạy song song thì càng chắc trượt).
      // Gộp vào một statement thì không còn khe nào để trượt.
      //
      // suspended_at IS NOT NULL = "CHÍNH TA khoá vì chưa trả tiền". Shop bị nhân viên nền
      // tảng khoá (vi phạm) không có cờ này → trả tiền KHÔNG mở được, cưỡng chế giữ nguyên ý
      // nghĩa. Trả về suspended_from = đúng trạng thái cũ, không ép 'active' (0126).
      await c.query(
        `WITH unlocked AS (
           UPDATE shops sh SET status = COALESCE(s.suspended_from, 'active')
             FROM subscriptions s
            WHERE sh.id = $1 AND s.shop_id = $1
              AND sh.status = 'suspended' AND s.suspended_at IS NOT NULL
           RETURNING sh.id
         )
         UPDATE subscriptions SET suspended_at = NULL, suspended_from = NULL
          WHERE shop_id = $1 AND EXISTS (SELECT 1 FROM unlocked)`,
        [ch.shop_id],
      );
      // Sổ THU append-only (0061) — chứng từ doanh thu, ghi SAU KHI tiền đã về.
      await c.query(
        `INSERT INTO platform_invoices (shop_id, plan_code, months, amount_vnd, note)
         VALUES ($1, $2, $3, $4, 'shop tự thanh toán (chuyển khoản)')`,
        [ch.shop_id, ch.plan_code, ch.months, ch.amount_vnd],
      );
      await c.query(`UPDATE billing_charges SET applied_at = now() WHERE id = $1`, [ch.id]);
      n += 1;
    }
    await c.query('COMMIT');
    if (n) log('info', 'billing_applied', { n });
    return n;
  } catch (err) {
    if (c) await c.query('ROLLBACK').catch(() => {});
    log('error', 'billing_apply_failed', { message: err.message });
    return 0;
  } finally { c?.release(); }
}

/** Quá hạn + hết ân hạn → KHOÁ BÁN. Storefront đã sẵn kiểm shops.status='suspended'. */
async function sweepBillingEnforce(batch = 200) {
  if (!billingDb) return 0;
  let c;
  try {
    c = await billingDb.connect();
    await c.query('BEGIN');
    // Lọc CHÍNH LÀ điều kiện xử lý (suspended_at IS NULL) → không có "đói quét": shop đã
    // khoá rồi thì rơi khỏi tập, lô sau lấy shop kế tiếp.
    // Lấy LUÔN trạng thái shop hiện tại: cần nó để nhớ "khoá từ đâu" (0126), và đọc sau
    // khi UPDATE thì chỉ thấy 'suspended'. FOR UPDATE OF s — chỉ khoá dòng subscriptions,
    // không khoá shops (tránh đụng độ với thao tác khác đang sửa shop).
    const rows = (await c.query(
      `SELECT s.shop_id, sh.status AS prev_status FROM subscriptions s
         JOIN shops sh ON sh.id = s.shop_id
        WHERE s.status IN ('past_due', 'cancelled') AND s.suspended_at IS NULL
          -- CHỈ shop ĐANG BÁN ĐƯỢC. Shop đã bị nền tảng khoá vì VI PHẠM (hoặc đã chấm dứt)
          -- không thuộc việc của cưỡng chế nợ phí — và quan trọng hơn: nếu để nó vào lô thì
          -- UPDATE bên dưới trượt, còn dấu suspended_at vẫn bị đóng, tức shop bị khoá vì vi
          -- phạm TỰ MỞ LẠI ĐƯỢC bằng cách trả một tháng tiền (sweepBillingApply:573 mở khoá
          -- chỉ dựa vào suspended_at IS NOT NULL). Lọc ở đây thay vì bỏ dấu vì tập vẫn phải
          -- CO LẠI khi xử xong — bỏ dấu mà không lọc thì mấy shop này nằm mãi đầu lô
          -- (ORDER BY current_period_end) và chặn shop khác = đói quét.
          AND sh.status IN ('active', 'onboarding')
          AND s.current_period_end IS NOT NULL
          AND s.current_period_end < now() - ($1 || ' days')::interval
        ORDER BY s.current_period_end LIMIT $2 FOR UPDATE OF s SKIP LOCKED`,
      [String(BILLING_GRACE_DAYS), batch],
    )).rows;
    for (const r of rows) {
      // 'onboarding' CŨNG phải khoá: shop ở trạng thái đó VẪN bán được (0006 + nút "Mở
      // bán"), nên bỏ sót nó là để cả một nhóm shop dùng mãi không trả tiền mà vẫn hợp lệ.
      const locked = await c.query(
        `UPDATE shops SET status = 'suspended' WHERE id = $1 AND status IN ('active', 'onboarding')`,
        [r.shop_id],
      );
      // ĐÓNG DẤU CHỈ KHI CHÍNH TA KHOÁ (mirror sweepSubscriptions:976). Trạng thái shop có
      // thể đổi giữa lúc chọn và lúc UPDATE — ta chỉ khoá dòng subscriptions (FOR UPDATE OF s),
      // không khoá shops. Ca hiếm đó để lại dòng cho lô sau xử, không đóng dấu khống.
      if (locked.rowCount) {
        await c.query(
          `UPDATE subscriptions SET suspended_at = now(), suspended_from = $2 WHERE shop_id = $1`,
          [r.shop_id, r.prev_status],
        );
      }
      log('warn', 'shop_suspended_nonpayment', { shop_id: r.shop_id, grace_days: BILLING_GRACE_DAYS, locked: locked.rowCount > 0 });
    }
    await c.query('COMMIT');
    return rows.length;
  } catch (err) {
    if (c) await c.query('ROLLBACK').catch(() => {});
    log('error', 'billing_enforce_failed', { message: err.message });
    return 0;
  } finally { c?.release(); }
}

// ── Vòng đời hoa hồng CTV (0129, docs/51) ────────────────────────────────────
// pending → eligible khi đơn ĐÃ GIAO và hết hạn đổi trả (hold_days của shop).
// pending → void  khi đơn huỷ/hoàn TRƯỚC lúc đủ điều kiện — hoa hồng rụng, KHÔNG phải đi
// đòi lại tiền đã đưa CTV. Đây chính là lý do chọn "giao thành công" thay vì "đã thanh
// toán" (Shopee/TikTok cũng vậy).
//
// Đơn huỷ/hoàn SAU khi đã 'paid' thì KHÔNG đụng: tiền đã ra khỏi shop, tự trừ ngược vào
// phiếu chi đã lập là làm sổ chi nói dối. Shop tự xử với CTV.
async function sweepAffiliateCommissions(batch = 300) {
  if (!affiliateDb) return { eligible: 0, voided: 0 };
  let c;
  try {
    c = await affiliateDb.connect();
    await c.query('BEGIN');
    // ĐÓI QUÉT: điều kiện lọc CHÍNH LÀ điều kiện xử lý (status='pending'), nên dòng vừa xử
    // rơi khỏi tập ngay — lô sau lấy dòng kế tiếp, không shop nào bị kẹt cuối hàng.
    // hold_days lấy từ cấu hình CỦA CHÍNH SHOP đó (join theo shop_id), không phải hằng số
    // toàn cục: mỗi shop có chính sách đổi trả riêng.
    const rows = (await c.query(
      `SELECT k.id, o.status AS order_status
         FROM affiliate_commissions k
         JOIN orders o ON o.id = k.order_id
         JOIN shop_affiliate_config cfg ON cfg.shop_id = k.shop_id
        WHERE k.status = 'pending'
          AND (
            -- đủ điều kiện: đã giao + qua hạn giữ
            (o.status = 'delivered' AND o.delivered_at IS NOT NULL
             AND o.delivered_at < now() - (cfg.hold_days || ' days')::interval)
            -- hoặc rụng: đơn kết thúc theo hướng xấu
            --
            -- 'returned' PHẢI có mặt. Thiếu nó thì dòng hoa hồng của đơn hoàn về (bom hàng,
            -- 0059) hoặc trả HẾT (RMA) không khớp NHÁNH NÀO: không 'delivered' để lật
            -- eligible, không cancelled/refunded để rụng → nằm 'pending' VĨNH VIỄN. Người bán
            -- thấy nó trong "chờ duyệt" mãi mãi, không có nút nào dọn (bảng hoa hồng chỉ đọc),
            -- và tổng nợ CTV trên báo cáo cứ đội lên bằng tiền của hàng đã quay về kho.
            OR o.status IN ('cancelled', 'refunded', 'returned')
          )
        ORDER BY k.created_at LIMIT $1 FOR UPDATE OF k SKIP LOCKED`, [batch])).rows;
    const dead = rows.filter((r) => r.order_status !== 'delivered').map((r) => r.id);
    const live = rows.filter((r) => r.order_status === 'delivered').map((r) => r.id);
    if (dead.length) {
      await c.query(
        `UPDATE affiliate_commissions SET status='void', void_reason='đơn huỷ/hoàn/trả về trước khi đủ điều kiện', updated_at=now()
          WHERE id = ANY($1::uuid[]) AND status='pending'`, [dead]);
    }
    if (live.length) {
      await c.query(
        `UPDATE affiliate_commissions SET status='eligible', eligible_at=now(), updated_at=now()
          WHERE id = ANY($1::uuid[]) AND status='pending'`, [live]);
    }
    await c.query('COMMIT');
    if (rows.length) log('info', 'affiliate_sweep', { eligible: live.length, voided: dead.length });
    return { eligible: live.length, voided: dead.length };
  } catch (err) {
    if (c) await c.query('ROLLBACK').catch(() => {});
    log('error', 'affiliate_sweep_failed', { message: err.message });
    return { eligible: 0, voided: 0 };
  } finally { c?.release(); }
}

// ── Báo khách qua Messenger khi đơn đổi trạng thái (0122) ────────────────────
// Khách chốt đơn trong chat Facebook thường KHÔNG có email (bot không hỏi — thêm một bước
// là thêm một chỗ để họ bỏ giữa chừng). Nếu chỉ báo bằng email thì với đúng nhóm khách này
// ta không báo gì cả: họ đặt xong rồi im lặng cho tới lúc shipper gọi.
//
// Kỷ luật giống deliverTelegram: ĐỘC LẬP email, idempotent theo outboxId, và TUYỆT ĐỐI
// không throw — báo tin hỏng không được kéo email của khách xuống theo.
const MESSENGER_URL = process.env.MESSENGER_URL ?? '';
async function deliverMessenger(topic, p, shopId, outboxId) {
  if (!MESSENGER_URL || topic !== 'order.status_changed' || !p?.messenger_psid) return { status: 'skipped' };
  const rc = outboxId ? await queue.client : null;
  if (rc && (await rc.get(`fbsent:${outboxId}`))) return { status: 'accepted' };
  const label = { confirmed: 'đã được xác nhận ✅', shipped: 'đang trên đường giao 🚚', delivered: 'đã giao thành công 🎉',
    cancelled: 'đã bị huỷ ❌', refunded: 'đã được hoàn tiền', returned: 'đã hoàn về cửa hàng' }[p.status];
  if (!label) return { status: 'skipped' };   // trạng thái không đáng làm phiền khách thì im lặng
  const extra = p.status === 'shipped' && p.tracking_number ? `
Mã vận đơn: ${p.tracking_number}`
    : p.status === 'cancelled' && p.cancel_reason ? `
Lý do: ${p.cancel_reason}` : '';
  const r = await fetch(`${MESSENGER_URL}/internal/notify`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ shop_id: shopId, psid: p.messenger_psid, text: `Đơn #${p.order_number} ${label}.${extra}` }),
  });
  if (!r.ok) throw new Error(`messenger từ chối (${r.status})`);
  if (rc) await rc.set(`fbsent:${outboxId}`, '1', 'EX', 86400);
  return { status: 'accepted' };
}

// ── Connector KiotViet ──────────────────────────────────────────────────────
// app_worker chỉ claim outbox toàn cục; mọi dữ liệu shop của connector dùng pool
// app_integration + SET LOCAL, nên một job mang nhầm shopId vẫn bị RLS chặn ở DB.
async function withIntegrationTenant(shopId, fn) {
  if (!integrationDb) throw new Error('thiếu DATABASE_URL_INTEGRATION');
  const c = await integrationDb.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { c.release(); }
}

// Khoá advisory theo connector sống trên một session riêng, nên giữ được xuyên nhiều
// transaction + nhiều lần gọi provider mà không chiếm connection của pool nghiệp vụ. Mọi
// cửa vào full reconciliation phải đi qua đây; nếu không hai scan cùng generation có thể ghi
// cursor/raw_meta theo thứ tự hoàn tất thay vì thứ tự dữ liệu.
async function withIntegrationReconcileLock(integrationId, fn) {
  if (!INTEGRATION_URL) throw new Error('thiếu DATABASE_URL_INTEGRATION');
  const lockClient = new pg.Client({ connectionString: INTEGRATION_URL });
  const key = `integration-reconcile:${integrationId}`;
  await lockClient.connect();
  let locked = false;
  try {
    locked = Boolean((await lockClient.query(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`, [key],
    )).rows[0]?.locked);
    if (!locked) return { locked: false, value: null };
    return { locked: true, value: await fn() };
  } finally {
    if (locked) await lockClient.query(
      `SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [key],
    ).catch(() => {});
    await lockClient.end().catch(() => {});
  }
}

function integrationCredentials(ciphertext) {
  if (!/^[0-9a-f]{64}$/i.test(INTEGRATION_ENC_KEY)) throw new Error('INTEGRATION_ENC_KEY không hợp lệ');
  return JSON.parse(sbOpen(ciphertext, INTEGRATION_ENC_KEY, 'INTEGRATION_ENC_KEYS'));
}

function integrationClient(row) {
  const creds = integrationCredentials(row.credential_ciphertext);
  return createKiotVietClient({
    clientId: creds.client_id, clientSecret: creds.client_secret, retailer: creds.retailer,
    ...(process.env.KIOTVIET_IDENTITY_BASE ? { identityBase: process.env.KIOTVIET_IDENTITY_BASE } : {}),
    ...(process.env.KIOTVIET_API_BASE ? { apiBase: process.env.KIOTVIET_API_BASE } : {}),
  });
}

const asId = (v) => v == null ? '' : String(v);
const asInt = (v) => Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : null;
const asDate = (v) => {
  const ms = Date.parse(v ?? '');
  return Number.isFinite(ms) ? new Date(ms) : null;
};
const branchInventory = (row, branchRef) => asInt(kiotVietBranchOnHand(row, branchRef));

class StaleIntegrationJob extends Error {
  constructor() { super('job connector thuộc vòng đời cũ hoặc connector đã bị ngắt'); this.code = 'stale_integration_job'; }
}

async function lockIntegrationGeneration(c, integrationId, generation, mode = 'SHARE') {
  const row = (await c.query(
    `SELECT id, status, inventory_authority, generation
       FROM shop_integrations WHERE id = $1 FOR ${mode}`,
    [integrationId],
  )).rows[0];
  if (!row || row.status === 'disabled' || Number(row.generation) !== Number(generation)) {
    throw new StaleIntegrationJob();
  }
  // Trigger quyền sở hữu tồn kiểm cả tenant, connector và generation. Đặt context sau khi
  // đã khóa đúng dòng để một job cũ không thể tự khai generation mới rồi ghi bản chiếu.
  await c.query(
    `SELECT set_config('app.integration_id', $1, true),
            set_config('app.integration_generation', $2, true)`,
    [integrationId, String(generation)],
  );
  return row;
}

async function upsertDiscrepancy(c, integrationId, { kind, severity = 'warning', dedupeKey, message, entityType = null, externalRef = null, localId = null, details = null }) {
  await c.query(
    `INSERT INTO integration_sync_discrepancies
       (shop_id, integration_id, kind, severity, entity_type, external_ref, local_id, dedupe_key, message, details)
     VALUES (current_shop_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (shop_id, integration_id, dedupe_key) WHERE status = 'open'
     DO UPDATE SET severity = EXCLUDED.severity, message = EXCLUDED.message,
                   details = EXCLUDED.details, updated_at = now()`,
    [integrationId, kind, severity, entityType, externalRef, localId, dedupeKey, message, details],
  );
}

// Auto-sync and manual mapping must serialize claims for the same local variant.
// The SQL function is the single source of truth for the advisory-lock key.
async function lockKiotVietEntityClaim(c, integrationId, entityType, localId) {
  await c.query(
    `SELECT pg_advisory_xact_lock(kiotviet_entity_claim_lock_key($1, $2, $3))`,
    [integrationId, entityType, localId],
  );
}

async function applyProjectedStock(c, integrationId, variantId, externalRef, providerOnHand) {
  // INSERT trước rồi mới khoá: hai webhook đầu tiên cho cùng biến thể có thể chạy đồng thời.
  // SELECT-không-thấy rồi cùng INSERT sẽ làm một job vỡ unique và bỏ cả lô webhook.
  await c.query(
    `INSERT INTO inventory_levels (shop_id, variant_id, on_hand, reserved)
     VALUES (current_shop_id(), $1, 0, 0) ON CONFLICT (shop_id, variant_id) DO NOTHING`,
    [variantId],
  );
  const level = (await c.query(
    `SELECT on_hand, reserved FROM inventory_levels WHERE variant_id = $1 FOR UPDATE`, [variantId],
  )).rows[0];
  const reserved = Number(level.reserved);
  if (!canApplyKiotVietStock(providerOnHand, reserved)) {
    // Không nâng on_hand lên bằng reserved để lách CHECK: số đó không tồn tại ở provider và
    // sẽ biến thành hàng bán được ngay khi reservation được nhả. Giữ snapshot cũ, xóa bằng
    // chứng freshness và khóa checkout cho tới khi KiotViet lại đủ phủ phần đã giữ.
    await c.query(
      `UPDATE integration_entity_refs
          SET inventory_synced_at = NULL, inventory_generation = NULL, updated_at = now()
        WHERE integration_id = $1 AND entity_type = 'variant' AND external_id = $2`,
      [integrationId, externalRef],
    );
    await upsertDiscrepancy(c, integrationId, {
      kind: 'stock_below_reserved', severity: 'critical', dedupeKey: `stock:${externalRef}`,
      message: 'Tồn KiotViet thấp hơn số lượng đang giữ cho đơn website; biến thể đã bị khóa checkout.',
      entityType: 'variant', externalRef, localId: variantId,
      details: { provider_on_hand: providerOnHand, local_reserved: reserved },
    });
    return false;
  }
  const delta = providerOnHand - Number(level.on_hand);
  if (delta !== 0) {
    await c.query(`UPDATE inventory_levels SET on_hand = $2, updated_at = now() WHERE variant_id = $1`, [variantId, providerOnHand]);
    await c.query(
      `INSERT INTO inventory_ledger (shop_id, variant_id, delta, kind, reason)
       VALUES (current_shop_id(), $1, $2, 'adjust', $3)`,
      [variantId, delta, `Bản chiếu tồn KiotViet (${externalRef})`],
    );
  }
  await c.query(
    `UPDATE integration_sync_discrepancies
        SET status = 'resolved', resolved_at = now(), updated_at = now()
      WHERE integration_id = $1 AND dedupe_key = $2 AND status = 'open'`,
    [integrationId, `stock:${externalRef}`],
  );
  return true;
}

async function providerVariantCollision(c, variantId, row) {
  const sku = String(row.code ?? row.Code ?? '').trim();
  const barcode = String(row.barCode ?? row.barcode ?? row.BarCode ?? '').trim();
  return (await c.query(
    `SELECT id, sku, barcode FROM variants
      WHERE id <> $1 AND (($2 <> '' AND sku = $2) OR ($3 <> '' AND barcode = $3))
      ORDER BY id LIMIT 1`, [variantId, sku, barcode],
  )).rows[0] ?? null;
}

async function applyProviderVariantFields(c, integrationId, refId, variantId, externalId, row) {
  const sku = String(row.code ?? row.Code ?? '').trim();
  const barcode = String(row.barCode ?? row.barcode ?? row.BarCode ?? '').trim();
  const basePrice = asInt(row.basePrice ?? row.BasePrice ?? row.price ?? row.Price);
  const collision = await providerVariantCollision(c, variantId, row);
  if (collision) {
    await c.query(
      `UPDATE integration_entity_refs
          SET mapping_status = 'conflict', inventory_synced_at = NULL,
              inventory_generation = NULL, updated_at = now()
        WHERE id = $1`, [refId],
    );
    // Không để bản chiếu cũ tiếp tục cung cấp external_id cho đường gửi đơn sau khi
    // SKU/barcode đã trở nên mơ hồ. Mapping conflict phải khóa cả catalog lẫn outbound.
    await c.query(
      `DELETE FROM product_source_refs
        WHERE source = 'kiotviet' AND kind = 'variant' AND external_id = $1`, [externalId],
    );
    await upsertDiscrepancy(c, integrationId, {
      kind: barcode && collision.barcode === barcode ? 'duplicate_barcode' : 'duplicate_sku',
      severity: 'critical', dedupeKey: `catalog-field:${externalId}`,
      message: 'SKU/barcode do KiotViet quản lý đang trùng một biến thể khác; website đã khóa biến thể này để không nối nhầm.',
      entityType: 'variant', externalRef: externalId, localId: variantId,
      details: { sku: sku || null, barcode: barcode || null, conflict_variant_id: collision.id },
    });
    return false;
  }
  await c.query(
    `UPDATE variants
        SET sku = CASE WHEN $2 <> '' THEN $2 ELSE sku END,
            barcode = CASE WHEN $3 <> '' THEN $3 ELSE barcode END,
            price_vnd = coalesce($4, price_vnd)
      WHERE id = $1`, [variantId, sku, barcode, basePrice],
  );
  await c.query(
    `UPDATE integration_sync_discrepancies
        SET status = 'resolved', resolved_at = now(), updated_at = now()
      WHERE integration_id = $1 AND dedupe_key = $2 AND status = 'open'`,
    [integrationId, `catalog-field:${externalId}`],
  );
  return true;
}

async function applyKiotVietProducts(shopId, integration, rows) {
  return withIntegrationTenant(shopId, async (c) => {
    const lifecycle = await lockIntegrationGeneration(c, integration.id, integration.generation);
    let unresolved = 0;
    // Resolve all claims before writing any mapping. This makes two previously-unmapped
    // provider rows targeting one variant a conflict as a group instead of "first row wins".
    const plans = [];
    const sortedRows = [...rows].sort((a, b) => asId(a.id ?? a.Id ?? a.productId ?? a.ProductId)
      .localeCompare(asId(b.id ?? b.Id ?? b.productId ?? b.ProductId)));
    for (const row of sortedRows) {
      const externalId = asId(row.id ?? row.Id ?? row.productId ?? row.ProductId);
      if (!externalId) continue;
      const sku = String(row.code ?? row.Code ?? '').trim();
      const barcode = String(row.barCode ?? row.barcode ?? row.BarCode ?? '').trim();
      const modifiedAt = asDate(row.modifiedDate ?? row.ModifiedDate);
      const existing = (await c.query(
        `SELECT mapping_status, external_updated_at FROM integration_entity_refs
          WHERE integration_id = $1 AND entity_type = 'variant' AND external_id = $2`,
        [integration.id, externalId],
      )).rows[0];
      if (modifiedAt && existing?.external_updated_at
        && modifiedAt < new Date(existing.external_updated_at)) continue;
      if (existing?.mapping_status === 'ignored') {
        plans.push({ row, externalId, sku, barcode, modifiedAt, existing,
          pinned: null, unique: [], local: null, claim: null, owner: null });
        continue;
      }
      const pinned = (await c.query(
        `SELECT v.id, v.product_id
           FROM integration_entity_refs r JOIN variants v ON v.id = r.local_id
          WHERE r.integration_id = $1 AND r.entity_type = 'variant' AND r.external_id = $2
            AND r.mapping_status = 'mapped'`, [integration.id, externalId],
      )).rows[0];
      const candidates = pinned ? [pinned] : (await c.query(
        `SELECT id, product_id FROM variants
          WHERE ($1 <> '' AND sku = $1) OR ($2 <> '' AND barcode = $2)
          ORDER BY id`, [sku, barcode],
      )).rows;
      const unique = [...new Map(candidates.map((it) => [it.id, it])).values()];
      const local = unique[0] ?? null;
      let claim = unique.length === 1 && local ? 'new' : null;
      let owner = null;
      if (claim === 'new') {
        await lockKiotVietEntityClaim(c, integration.id, 'variant', local.id);
        owner = (await c.query(
          `SELECT external_id FROM integration_entity_refs
             WHERE integration_id = $1 AND entity_type = 'variant' AND local_id = $2
               AND mapping_status = 'mapped'
             LIMIT 1`, [integration.id, local.id],
        )).rows[0] ?? null;
        if (owner && owner.external_id !== externalId) claim = 'occupied';
        if (owner && owner.external_id === externalId) claim = 'existing';
      }
      plans.push({ row, externalId, sku, barcode, modifiedAt, existing, pinned, unique, local, claim, owner });
    }
    const newClaims = new Map();
    for (const plan of plans) {
      if (plan.claim !== 'new') continue;
      const key = String(plan.local.id);
      const list = newClaims.get(key) ?? [];
      list.push(plan);
      newClaims.set(key, list);
    }
    for (const list of newClaims.values()) {
      if (list.length > 1) {
        const externalIds = list.map((plan) => plan.externalId);
        for (const plan of list) {
          plan.claim = 'batch_conflict';
          plan.batchExternalIds = externalIds;
        }
      }
    }

    for (const plan of plans) {
      const { row, externalId, sku, barcode, modifiedAt, existing, pinned, unique, local } = plan;
      if (existing?.mapping_status === 'ignored') {
        // "Không bán trên website" là quyết định vận hành bền vững, không phải lỗi ánh xạ
        // tạm thời. Đồng bộ sau chỉ làm mới metadata; không được tự biến nó lại thành unmapped.
        await c.query(
          `UPDATE integration_entity_refs
              SET external_updated_at = coalesce($3, external_updated_at), raw_meta = $4,
                  inventory_synced_at = NULL, inventory_generation = NULL, updated_at = now()
            WHERE integration_id = $1 AND entity_type = 'variant' AND external_id = $2`,
          [integration.id, externalId,
            modifiedAt?.toISOString() ?? null,
            { name: row.name ?? row.Name ?? null, sku: sku || null, barcode: barcode || null }],
        );
        await c.query(
          `UPDATE integration_sync_discrepancies SET status = 'resolved', resolved_at = now(), updated_at = now()
            WHERE integration_id = $1 AND dedupe_key IN ($2,$3,$4) AND status = 'open'`,
          [integration.id, `mapping:${externalId}`, `provider-deleted:${externalId}`,
            `stock-unmapped:${externalId}`],
        );
        continue;
      }
      const onHand = branchInventory(row, integration.external_branch_ref);
      const basePrice = asInt(row.basePrice ?? row.BasePrice ?? row.price ?? row.Price);
      const isConflict = unique.length > 1 || plan.claim === 'occupied' || plan.claim === 'batch_conflict';
      const mappingStatus = isConflict ? 'conflict' : unique.length === 1 ? 'mapped' : 'unmapped';
      const mappingLocal = isConflict ? null : local;
      const inventoryStamped = mappingStatus === 'mapped' && mappingLocal && onHand != null;
      const saved = (await c.query(
        `INSERT INTO integration_entity_refs
           (shop_id, integration_id, entity_type, external_id, local_id, mapping_status,
             external_updated_at, inventory_synced_at, inventory_generation, raw_meta, updated_at)
         VALUES (current_shop_id(), $1, 'variant', $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (shop_id, integration_id, entity_type, external_id)
         DO UPDATE SET local_id = EXCLUDED.local_id, mapping_status = EXCLUDED.mapping_status,
                        external_updated_at = coalesce(EXCLUDED.external_updated_at, integration_entity_refs.external_updated_at),
                        inventory_synced_at = EXCLUDED.inventory_synced_at,
                        inventory_generation = EXCLUDED.inventory_generation,
                        raw_meta = EXCLUDED.raw_meta, updated_at = now()
         RETURNING id`,
        [integration.id, externalId, mappingLocal?.id ?? null, mappingStatus,
          modifiedAt?.toISOString() ?? null,
          inventoryStamped ? new Date().toISOString() : null,
          inventoryStamped ? Number(integration.generation) : null, {
          name: row.name ?? row.Name ?? null, sku: sku || null, barcode: barcode || null,
          base_price_vnd: basePrice, provider_on_hand: onHand,
        }],
      )).rows[0];
      if (!local || unique.length !== 1 || isConflict) {
        unresolved += 1;
        const conflictLocalId = local?.id ?? plan.owner?.local_id ?? null;
        const conflictKind = barcode && plan.owner?.external_id
          ? 'duplicate_barcode' : unique.length > 1 || isConflict ? (barcode ? 'duplicate_barcode' : 'duplicate_sku') : 'unmapped_sku';
        const batch = plan.batchExternalIds ?? null;
        const conflictReason = plan.claim === 'occupied'
          ? 'Biến thể nội bộ đã thuộc một sản phẩm KiotViet khác; không cướp mapping đang chạy.'
          : plan.claim === 'batch_conflict'
            ? 'Nhiều sản phẩm KiotViet mới cùng nhận một biến thể trong cùng lượt; cần chọn thủ công.'
            : unique.length > 1
              ? 'SKU/barcode KiotViet khớp nhiều biến thể nội bộ; hệ thống không tự đoán.'
              : 'Sản phẩm KiotViet chưa khớp biến thể nội bộ.';
        await upsertDiscrepancy(c, integration.id, {
          kind: conflictKind,
          dedupeKey: batch ? `local-variant:${local.id}` : `mapping:${externalId}`,
          message: conflictReason,
          entityType: 'variant', externalRef: externalId, localId: conflictLocalId,
          details: { sku: sku || null, barcode: barcode || null, candidate_ids: unique.map((it) => it.id),
            conflicting_external_id: plan.owner?.external_id ?? null, conflicting_external_ids: batch },
        });
        continue;
      }
      await c.query(
        `INSERT INTO product_source_refs (shop_id, source, kind, external_id, product_id, variant_id, raw_row)
         VALUES (current_shop_id(), 'kiotviet', 'variant', $1, $2, $3, $4)
         ON CONFLICT (shop_id, source, kind, external_id)
         DO UPDATE SET product_id = EXCLUDED.product_id, variant_id = EXCLUDED.variant_id,
                       raw_row = EXCLUDED.raw_row, imported_at = now()`,
        [externalId, local.product_id, local.id, row],
      );
      if (onHand == null) {
        unresolved += 1;
        await upsertDiscrepancy(c, integration.id, {
          kind: 'inventory_unavailable', severity: 'critical',
          dedupeKey: `stock-missing:${externalId}`,
          message: 'Không đọc được tồn của đúng chi nhánh KiotViet đã chọn; biến thể bị khóa checkout.',
          entityType: 'variant', externalRef: externalId, localId: local.id,
          details: { branch_ref: integration.external_branch_ref },
        });
        continue;
      }
      if (lifecycle.inventory_authority === 'external_master') {
        const fieldsOk = await applyProviderVariantFields(c, integration.id, saved.id, local.id, externalId, row);
        if (!fieldsOk) { unresolved += 1; continue; }
        if (onHand != null && !await applyProjectedStock(c, integration.id, local.id, externalId, onHand)) {
          unresolved += 1;
          continue;
        }
      }
      await c.query(
        `UPDATE integration_sync_discrepancies SET status = 'resolved', resolved_at = now(), updated_at = now()
          WHERE integration_id = $1 AND dedupe_key IN ($2,$3,$4) AND status = 'open'`,
        [integration.id, `mapping:${externalId}`, `provider-deleted:${externalId}`,
          `stock-unmapped:${externalId}`],
      );
      await c.query(
        `UPDATE integration_sync_discrepancies SET status = 'resolved', resolved_at = now(), updated_at = now()
          WHERE integration_id = $1 AND dedupe_key = $2 AND status = 'open'`,
        [integration.id, `stock-missing:${externalId}`],
      );
    }
    return unresolved;
  });
}

async function syncKiotVietCatalog(shopId, integrationId, { incremental = false, generation = null } = {}) {
  const integration = await withIntegrationTenant(shopId, async (c) =>
    (await c.query(
      `SELECT id, provider, status, credential_ciphertext, external_branch_ref, catalog_synced_at,
              inventory_authority, generation
         FROM shop_integrations WHERE id = $1`, [integrationId],
    )).rows[0]);
  if (!integration || integration.provider !== 'kiotviet' || !integration.external_branch_ref
    || integration.status === 'disabled' || (generation != null && Number(integration.generation) !== Number(generation))) {
    throw new StaleIntegrationJob();
  }
  const expectedGeneration = Number(integration.generation);
  const client = integrationClient(integration);
  const scanStartedAt = new Date();
  let currentItem = 0;
  let total = 0;
  let unresolved = 0;
  let exhaustive = false;
  const removed = new Set();
  const lastModifiedFrom = incremental && integration.catalog_synced_at
    ? new Date(new Date(integration.catalog_synced_at).getTime() - 60_000).toISOString() : null;
  for (let page = 0; page < 500; page++) {
    const batch = await client.listProducts({ currentItem, pageSize: 100, lastModifiedFrom });
    total = batch.total;
    for (const id of batch.removed ?? []) removed.add(String(id));
    unresolved += await applyKiotVietProducts(shopId, integration, batch.rows);
    currentItem += batch.rows.length;
    if (!batch.rows.length || batch.rows.length < 100 || (total && currentItem >= total)) {
      exhaustive = true;
      break;
    }
  }
  if (!exhaustive) throw new KiotVietError('Không thể chứng minh đã quét hết catalog KiotViet trong giới hạn an toàn', {
    status: 503, code: 'catalog_scan_incomplete',
  });
  const localMissing = await withIntegrationTenant(shopId, async (c) => {
    const lifecycle = await lockIntegrationGeneration(c, integration.id, expectedGeneration, 'UPDATE');
    for (const externalId of removed) {
      const ref = (await c.query(
        `SELECT local_id FROM integration_entity_refs
          WHERE integration_id = $1 AND entity_type = 'variant' AND external_id = $2`,
        [integration.id, externalId],
      )).rows[0];
      await c.query(
        `UPDATE integration_entity_refs
            SET mapping_status = 'ignored', local_id = NULL,
                inventory_synced_at = NULL, inventory_generation = NULL, updated_at = now()
          WHERE integration_id = $1 AND entity_type = 'variant' AND external_id = $2
        `, [integration.id, externalId],
      );
      await c.query(
        `DELETE FROM product_source_refs WHERE source = 'kiotviet' AND kind = 'variant' AND external_id = $1`,
        [externalId],
      );
      await upsertDiscrepancy(c, integration.id, {
        kind: 'unmapped_sku', severity: 'critical', dedupeKey: `provider-deleted:${externalId}`,
        message: 'Sản phẩm đã bị xóa ở KiotViet; website khóa bán cho tới khi ánh xạ lại hoặc chuyển quyền tồn.',
        entityType: 'variant', externalRef: externalId, localId: ref?.local_id ?? null,
      });
    }
    const rows = (await c.query(
      `SELECT v.id, v.sku FROM variants v JOIN products p ON p.id = v.product_id
        WHERE p.status = 'active' AND p.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM product_source_refs r
             WHERE r.source = 'kiotviet' AND r.kind = 'variant' AND r.variant_id = v.id
          ) LIMIT 500`,
    )).rows;
    for (const row of rows) await upsertDiscrepancy(c, integration.id, {
      kind: 'unmapped_sku', dedupeKey: `local-variant:${row.id}`,
      message: 'Biến thể đang bán trên website chưa có sản phẩm tương ứng ở KiotViet.',
      entityType: 'variant', localId: row.id, details: { sku: row.sku },
    });
    let issues = rows.length + Number((await c.query(
      `SELECT count(*)::int n FROM integration_entity_refs
        WHERE integration_id = $1 AND entity_type IN ('product','variant')
          AND mapping_status IN ('unmapped','conflict')`, [integration.id],
    )).rows[0].n);
    issues += Number((await c.query(
      `SELECT count(*)::int n
         FROM integration_entity_refs r
         JOIN variants v ON v.id = r.local_id
         JOIN products p ON p.id = v.product_id
        WHERE r.integration_id = $1 AND r.entity_type = 'variant'
          AND r.mapping_status = 'mapped' AND p.status = 'active' AND p.deleted_at IS NULL
          AND (r.inventory_synced_at IS NULL OR r.inventory_generation IS DISTINCT FROM $2)`,
      [integration.id, expectedGeneration],
    )).rows[0].n);

    // Đơn local đã giữ tồn nhưng chưa khép vòng đời không thể tự biến thành đơn KiotViet.
    // Cutover lúc này sẽ làm đường giao/hủy cũ và nguồn tồn mới bất đồng; giữ connector local
    // cho tới khi shop xử lý hoặc hủy hết các đơn ấy.
    const localOrders = (await c.query(
      `SELECT id, order_number, status FROM orders
        WHERE integration_id IS NULL AND status IN ('pending','confirmed','shipped')
        ORDER BY created_at, id LIMIT 21`,
    )).rows;
    if (localOrders.length) {
      issues += 1;
      await upsertDiscrepancy(c, integration.id, {
        kind: 'local_orders_pending', severity: 'critical', dedupeKey: 'local-orders-pending',
        message: 'Còn đơn đang xử lý bằng tồn local; hãy hoàn tất hoặc hủy trước khi KiotViet làm chủ tồn.',
        details: {
          count_at_least: localOrders.length,
          truncated: localOrders.length > 20,
          orders: localOrders.slice(0, 20).map((row) => ({
            id: row.id, order_number: Number(row.order_number), status: row.status,
          })),
        },
      });
    } else {
      await c.query(
        `UPDATE integration_sync_discrepancies
            SET status = 'resolved', resolved_at = now(), updated_at = now()
          WHERE integration_id = $1 AND dedupe_key = 'local-orders-pending' AND status = 'open'`,
        [integration.id],
      );
    }

    // Đồng bộ thử chỉ stage provider fields/tồn trong ref. Chỉ khi toàn tập đã ánh xạ sạch
    // mới áp snapshot và chuyển authority trong CÙNG transaction; đỏ giữa chừng không làm
    // thay on_hand local dù một số SKU đã khớp.
    if (!issues && lifecycle.inventory_authority !== 'external_master') {
      const staged = (await c.query(
        `SELECT r.id, r.external_id, r.local_id, r.raw_meta
           FROM integration_entity_refs r JOIN variants v ON v.id = r.local_id
          WHERE r.integration_id = $1 AND r.entity_type = 'variant'
            AND r.mapping_status = 'mapped' AND r.local_id IS NOT NULL
          ORDER BY r.local_id
          FOR UPDATE OF r, v`, [integration.id],
      )).rows;
      for (const ref of staged) {
        const raw = ref.raw_meta ?? {};
        const providerRow = {
          Code: raw.sku, BarCode: raw.barcode, BasePrice: raw.base_price_vnd,
        };
        if (await providerVariantCollision(c, ref.local_id, providerRow)) {
          await applyProviderVariantFields(c, integration.id, ref.id, ref.local_id, ref.external_id, providerRow);
          issues += 1;
        }
        const providerOnHand = asInt(raw.provider_on_hand);
        const reserved = Number((await c.query(
          `SELECT reserved FROM inventory_levels WHERE variant_id = $1 FOR UPDATE`, [ref.local_id],
        )).rows[0]?.reserved ?? 0);
        if (providerOnHand != null && !canApplyKiotVietStock(providerOnHand, reserved)) {
          issues += 1;
          await c.query(
            `UPDATE integration_entity_refs
                SET inventory_synced_at = NULL, inventory_generation = NULL, updated_at = now()
              WHERE id = $1`, [ref.id],
          );
          await upsertDiscrepancy(c, integration.id, {
            kind: 'stock_below_reserved', severity: 'critical', dedupeKey: `stock:${ref.external_id}`,
            message: 'Tồn KiotViet thấp hơn số lượng đang giữ cho đơn website; chưa thể chuyển quyền tồn.',
            entityType: 'variant', externalRef: ref.external_id, localId: ref.local_id,
            details: { provider_on_hand: providerOnHand, local_reserved: reserved },
          });
        }
      }
      if (!issues) {
        // Chuyển authority trước khi ghi snapshot, nhưng vẫn trong transaction này. Bất kỳ lỗi
        // SKU/tồn nào phía dưới sẽ rollback cả authority lẫn mọi dòng đã áp.
        const cutover = await c.query(
          `UPDATE shop_integrations
              SET inventory_authority = 'external_master', status = 'active',
                  last_error = NULL, updated_at = now()
            WHERE id = $1 AND generation = $2 AND status <> 'disabled'`,
          [integration.id, expectedGeneration],
        );
        if (cutover.rowCount !== 1) throw new StaleIntegrationJob();
        for (const ref of staged) {
          const raw = ref.raw_meta ?? {};
          const fieldsOk = await applyProviderVariantFields(c, integration.id, ref.id, ref.local_id, ref.external_id, {
            Code: raw.sku, BarCode: raw.barcode, BasePrice: raw.base_price_vnd,
          });
          if (!fieldsOk) throw new Error('catalog thay đổi trong lúc chuyển quyền tồn; đã rollback toàn bộ cutover');
          const onHand = asInt(raw.provider_on_hand);
          if (onHand != null
            && !await applyProjectedStock(c, integration.id, ref.local_id, ref.external_id, onHand)) {
            throw new Error('tồn KiotViet thấp hơn reservation trong lúc chuyển quyền; đã rollback toàn bộ cutover');
          }
        }
      }
    }

    const nextAuthority = issues && lifecycle.inventory_authority !== 'external_master'
      ? 'local' : 'external_master';
    const nextStatus = issues && lifecycle.inventory_authority !== 'external_master'
      ? 'degraded' : 'active';
    const changed = await c.query(
      `UPDATE shop_integrations
          SET status = $2, inventory_authority = $3, catalog_synced_at = $6,
              inventory_synced_at = CASE WHEN $5 THEN $6 ELSE inventory_synced_at END,
              last_error = $4, updated_at = now()
        WHERE id = $1 AND generation = $7 AND status <> 'disabled'`,
      [integration.id, nextStatus, nextAuthority,
        issues ? `Còn ${issues} vấn đề cần xử lý trước khi đồng bộ tồn sẵn sàng.` : null,
        !incremental, scanStartedAt.toISOString(), expectedGeneration],
    );
    if (changed.rowCount !== 1) throw new StaleIntegrationJob();
    return rows.length;
  });
  log('info', incremental ? 'integration_catalog_reconciled' : 'integration_initial_sync_done', {
    shopId, integrationId, total, removed: removed.size, unresolved: unresolved + localMissing,
  });
}

function deterministicOrderCode(shopId, orderId, orderNumber) {
  return `[NTG:${String(shopId).toLowerCase()}:${String(orderId).toLowerCase()}:${orderNumber}]`;
}

function websiteOrderRequestHash(order, lines) {
  const body = {
    order_id: order.id, order_number: order.order_number,
    customer_name: order.customer_name, customer_phone: order.customer_phone,
    customer_email: order.customer_email, shipping_address: order.shipping_address,
    subtotal_vnd: order.subtotal_vnd, shipping_vnd: order.shipping_vnd,
    discount_vnd: order.discount_vnd, total_vnd: order.total_vnd,
    payment_method: order.payment_method, payment_status: order.payment_status,
    points_discount_vnd: order.points_discount_vnd,
    lines: lines.map((line) => ({ variant_id: line.variant_id, external_id: line.external_id,
      unit_price_vnd: line.unit_price_vnd, qty: line.qty, sku_snapshot: line.sku_snapshot })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function buildKiotVietWebsiteOrder(order, lines, integration, marker) {
  const address = order.shipping_address ?? {};
  const deliveryAddress = [address.line, address.ward, address.district, address.province].filter(Boolean).join(', ');
  const method = { card: 'Card', qr: 'Transfer', transfer: 'Transfer' }[order.payment_method] ?? 'Cash';
  return {
    branchId: /^\d+$/.test(integration.external_branch_ref) ? Number(integration.external_branch_ref) : integration.external_branch_ref,
    description: `${marker} Đơn website Nền Tảng #${order.order_number}`,
    purchaseDate: new Date(order.created_at).toISOString(), makeInvoice: false, method,
    totalPayment: order.payment_status === 'paid' ? Number(order.total_vnd) : 0,
    discount: Number(order.discount_vnd) + Number(order.points_discount_vnd ?? 0),
    customer: { name: order.customer_name, contactNumber: order.customer_phone,
      email: order.customer_email || undefined, address: deliveryAddress },
    orderDelivery: { receiver: order.customer_name, contactNumber: order.customer_phone,
      address: deliveryAddress, price: Number(order.shipping_vnd) },
    orderDetails: lines.map((line) => ({
      productId: /^\d+$/.test(line.external_id) ? Number(line.external_id) : line.external_id,
      quantity: Number(line.qty), price: Number(line.unit_price_vnd), discount: 0, note: line.sku_snapshot,
    })),
  };
}

async function markWebsiteOrderNeedsAttention(shopId, payload, reason, intentId = null) {
  return withIntegrationTenant(shopId, async (c) => {
    await lockIntegrationGeneration(c, payload.integration_id, payload.generation);
    if (intentId) await c.query(
      `UPDATE integration_order_send_intents
          SET state = 'needs_attention', lookup_state = 'inconclusive', last_error = $2, updated_at = now()
        WHERE id = $1`, [intentId, reason],
    );
    await c.query(
      `UPDATE orders SET sync_status = 'needs_attention', sync_error = $2, sync_updated_at = now()
        WHERE id = $1 AND integration_generation = $3 AND sync_status <> 'synced'`,
      [payload.order_id, reason, Number(payload.generation)],
    );
    await upsertDiscrepancy(c, payload.integration_id, {
      kind: 'order_identity_pending', severity: 'critical', dedupeKey: `order-identity:${payload.order_id}`,
      message: 'Không chứng minh được đơn KiotViet đã nhận hay chưa; đã dừng retry tự động để tránh tạo đơn trùng.',
      entityType: 'order', localId: payload.order_id, details: { reason },
    });
  });
}

async function prepareWebsiteOrderSend(shopId, payload) {
  return withIntegrationTenant(shopId, async (c) => {
    const integration = (await c.query(
      `SELECT id, provider, status, credential_ciphertext, external_branch_ref, generation
         FROM shop_integrations WHERE id = $1 FOR SHARE`, [payload.integration_id],
    )).rows[0];
    const order = (await c.query(
      `SELECT id, order_number, status, customer_name, customer_phone, customer_email, shipping_address,
              subtotal_vnd, shipping_vnd, discount_vnd, total_vnd, payment_method, payment_status,
              points_discount_vnd, created_at, sync_status, external_ref, integration_generation
         FROM orders WHERE id = $1 FOR UPDATE`, [payload.order_id],
    )).rows[0];
    if (!integration || !order || integration.provider !== 'kiotviet') return null;
    if (Number(order.integration_generation) !== Number(payload.generation)
      || Number(integration.generation) !== Number(payload.generation)) throw new StaleIntegrationJob();
    if (order.external_ref && order.sync_status === 'synced') return { done: true };
    if (!['pending', 'confirmed'].includes(order.status)) {
      await c.query(
        `UPDATE orders SET sync_status = 'not_required', sync_error = NULL, sync_updated_at = now()
          WHERE id = $1 AND external_ref IS NULL`, [order.id],
      );
      return { done: true };
    }
    if (integration.status !== 'active' || !integration.credential_ciphertext) {
      throw new KiotVietError('Kết nối KiotViet chưa sẵn sàng để nhận đơn', { status: 503, code: 'provider_unavailable' });
    }
    const lines = (await c.query(
      `SELECT l.variant_id, l.title_snapshot, l.sku_snapshot, l.unit_price_vnd, l.qty, r.external_id
         FROM order_lines l
         LEFT JOIN product_source_refs r ON r.variant_id = l.variant_id
           AND r.source = 'kiotviet' AND r.kind = 'variant'
         WHERE l.order_id = $1 ORDER BY l.id`, [payload.order_id],
    )).rows;
    const missing = lines.filter((line) => !line.external_id);
    if (missing.length) {
      await c.query(
        `UPDATE orders SET sync_status = 'needs_attention', sync_error = $2, sync_updated_at = now() WHERE id = $1`,
        [order.id, 'Có dòng đơn chưa ánh xạ sang sản phẩm KiotViet.'],
      );
      await upsertDiscrepancy(c, integration.id, {
        kind: 'unmapped_sku', severity: 'critical', dedupeKey: `order-mapping:${order.id}`,
        message: 'Đơn website chưa gửi được vì có sản phẩm chưa ánh xạ KiotViet.',
        entityType: 'order', localId: order.id, details: { variant_ids: missing.map((line) => line.variant_id) },
      });
      return { done: true };
    }
    const marker = deterministicOrderCode(shopId, order.id, order.order_number);
    const requestHash = websiteOrderRequestHash(order, lines);
    let intent = (await c.query(
      `SELECT id, state, request_hash, attempt_started_at, provider_external_id, provider_code, lookup_state
         FROM integration_order_send_intents
        WHERE integration_id = $1 AND generation = $2 AND order_id = $3 FOR UPDATE`,
      [integration.id, Number(payload.generation), order.id],
    )).rows[0];
    if (intent && intent.request_hash !== requestHash) {
      await c.query(
        `UPDATE orders SET sync_status = 'needs_attention', sync_error = $2, sync_updated_at = now() WHERE id = $1`,
        [order.id, 'Nội dung đơn đã đổi sau khi tạo bằng chứng gửi; cần xác nhận thủ công trước khi gửi lại.'],
      );
      return { done: true };
    }
    if (!intent) intent = (await c.query(
      `INSERT INTO integration_order_send_intents
         (shop_id, integration_id, generation, order_id, marker, request_hash)
       VALUES (current_shop_id(), $1, $2, $3, $4, $5) RETURNING id, state, request_hash,
               attempt_started_at, provider_external_id, provider_code, lookup_state`,
      [integration.id, Number(payload.generation), order.id, marker, requestHash],
    )).rows[0];
    return { integration, order, lines, marker, intent, done: false };
  });
}

async function finalizeWebsiteOrderSend(shopId, payload, intentId, external, marker, integrationId) {
  const externalId = asId(external?.id ?? external?.Id);
  if (!externalId) throw new Error('KiotViet tạo đơn nhưng không trả id');
  const providerCode = asId(external?.code ?? external?.Code) || null;
  return withIntegrationTenant(shopId, async (c) => {
    await lockIntegrationGeneration(c, integrationId, payload.generation);
    const order = (await c.query(
      `SELECT id, status, external_ref FROM orders WHERE id = $1 FOR UPDATE`, [payload.order_id],
    )).rows[0];
    if (!order) return;
    if (order.external_ref && order.external_ref !== externalId) throw new KiotVietError(
      'Đơn website đã nối tới một đơn KiotViet khác; cần xử lý thủ công', { status: 409, code: 'order_marker_conflict' },
    );
    await c.query(
      `UPDATE orders SET external_ref = $2, status = CASE WHEN status = 'pending' THEN 'confirmed' ELSE status END,
                         sync_status = 'synced', sync_error = NULL, sync_updated_at = now()
        WHERE id = $1 AND integration_generation = $3`,
      [order.id, externalId, Number(payload.generation)],
    );
    if (order.status === 'pending') await c.query(
      `SELECT record_order_event($1, 'integration.order_accepted', 'system', NULL, 'kiotviet', $2::jsonb)`,
      [order.id, JSON.stringify({ external_order_id: externalId, generation: Number(payload.generation) })],
    );
    await c.query(
      `INSERT INTO integration_entity_refs
         (shop_id, integration_id, entity_type, external_id, local_id, mapping_status, raw_meta)
       VALUES (current_shop_id(), $1, 'order', $2, $3, 'mapped', $4)
       ON CONFLICT (shop_id, integration_id, entity_type, external_id)
       DO UPDATE SET local_id = EXCLUDED.local_id, mapping_status = 'mapped', raw_meta = EXCLUDED.raw_meta, updated_at = now()`,
      [integrationId, externalId, order.id, { marker, provider_code: providerCode }],
    );
    await c.query(
      `UPDATE integration_order_send_intents
          SET state = 'sent', lookup_state = 'found', provider_external_id = $2,
              provider_code = $3, last_error = NULL, updated_at = now()
        WHERE id = $1`, [intentId, externalId, providerCode],
    );
    await c.query(
      `UPDATE integration_sync_discrepancies
          SET status = 'resolved', resolved_at = now(), updated_at = now()
        WHERE integration_id = $1 AND status = 'open'
          AND dedupe_key IN ($2,$3,$4,$5)`,
      [integrationId, `order-provider:${order.id}`, `order-mapping:${order.id}`,
        `order-dead-letter:${order.id}`, `order-identity:${order.id}`],
    );
    await c.query(
      `UPDATE shop_integrations SET orders_synced_at = now(), last_error = NULL, updated_at = now()
        WHERE id = $1 AND generation = $2`, [integrationId, Number(payload.generation)],
    );
  });
}

async function sendWebsiteOrderToKiotViet(shopId, payload) {
  const prepared = await prepareWebsiteOrderSend(shopId, payload);
  if (!prepared || prepared.done) return;
  const { integration, order, lines, marker, intent } = prepared;
  const client = integrationClient(integration);
  const since = new Date(new Date(order.created_at).getTime() - 10 * 60_000).toISOString();

  // A committed attempted intent is the durable boundary. Once it exists, a marker scan
  // may prove presence but never absence; only a provider's exact code lookup can permit
  // another POST after an interrupted attempt.
  if (intent.state !== 'prepared') {
    const lookup = intent.provider_code && client.lookupOrderByCode
      ? await client.lookupOrderByCode(intent.provider_code)
      : await client.findOrderByMarker(marker, { lastModifiedFrom: since });
    if (lookup?.state === 'found') {
      const found = lookup.order;
      const foundBranch = asId(found.BranchId ?? found.branchId);
      if (foundBranch && foundBranch !== asId(integration.external_branch_ref)) {
        throw new KiotVietError('Tìm thấy marker đơn ở chi nhánh khác; dừng gửi để không nhận nhầm đơn ngoài', {
          status: 409, code: 'order_marker_conflict',
        });
      }
      await finalizeWebsiteOrderSend(shopId, payload, intent.id, found, marker, integration.id);
      return;
    }
    if (lookup?.state !== 'proven_absent') {
      await markWebsiteOrderNeedsAttention(shopId, payload,
        'Không thể chứng minh đơn KiotViet cũ chưa tồn tại; retry tự động đã bị dừng để tránh tạo đơn trùng.', intent.id);
      return;
    }
  }

  const marked = await withIntegrationTenant(shopId, async (c) => {
    const row = (await c.query(
      `UPDATE integration_order_send_intents
          SET state = 'attempted', attempt_started_at = coalesce(attempt_started_at, now()),
              lookup_state = 'unknown', updated_at = now()
        WHERE id = $1 AND state = 'prepared'
        RETURNING id`, [intent.id],
    )).rows[0];
    return Boolean(row);
  });
  if (!marked) return;

  const external = await client.createOrder(buildKiotVietWebsiteOrder(order, lines, integration, marker));
  await finalizeWebsiteOrderSend(shopId, payload, intent.id, external, marker, integration.id);
}

async function applyStockWebhook(shopId, integrationId, generation, events) {
  const integration = await withIntegrationTenant(shopId, async (c) =>
    (await c.query(
      `SELECT id, status, credential_ciphertext, external_branch_ref, generation
         FROM shop_integrations WHERE id = $1`, [integrationId],
    )).rows[0]);
  if (!integration?.external_branch_ref || integration.status === 'disabled'
    || Number(integration.generation) !== Number(generation)) throw new StaleIntegrationJob();
  const client = integrationClient(integration);
  const current = [];
  const seen = new Set();
  for (const event of events) {
    const externalId = asId(event.data?.ProductId ?? event.data?.productId ?? event.data?.Id ?? event.data?.id);
    const branchId = asId(event.data?.BranchId ?? event.data?.branchId);
    if (!externalId || seen.has(externalId) || (branchId && branchId !== asId(integration.external_branch_ref))) continue;
    seen.add(externalId);
    // stock.update không mang ModifiedDate. Đọc lại chi tiết hiện tại từ provider để một
    // webhook cũ tới muộn không ghi đè tồn mới; payload chỉ là tín hiệu cần làm mới.
    const product = await client.getProduct(externalId);
    const onHand = branchInventory(product, integration.external_branch_ref);
    if (onHand == null) continue;
    current.push({ externalId, onHand, modifiedAt: asDate(product.ModifiedDate ?? product.modifiedDate) });
  }
  await withIntegrationTenant(shopId, async (c) => {
    await lockIntegrationGeneration(c, integrationId, generation);
    for (const row of current) {
      const ref = (await c.query(
        `SELECT r.local_id AS variant_id, r.external_updated_at
           FROM integration_entity_refs r
          WHERE r.integration_id = $1 AND r.entity_type = 'variant' AND r.external_id = $2
            AND r.mapping_status = 'mapped'`, [integrationId, row.externalId],
      )).rows[0];
      if (!ref?.variant_id) {
        await upsertDiscrepancy(c, integrationId, {
          kind: 'unmapped_sku', dedupeKey: `stock-unmapped:${row.externalId}`,
          message: 'KiotViet gửi cập nhật tồn cho sản phẩm chưa ánh xạ.', entityType: 'variant', externalRef: row.externalId,
        });
        continue;
      }
      // Đã đọc lại trạng thái hiện hành từ GET /products/:id nên không so với ModifiedDate
      // catalog: nhiều provider không đổi mốc catalog khi chỉ thay tồn chi nhánh.
      const applied = await applyProjectedStock(c, integrationId, ref.variant_id, row.externalId, row.onHand);
      if (!applied) continue;
      await c.query(
        `UPDATE integration_entity_refs
            SET external_updated_at = coalesce($3, external_updated_at),
                inventory_synced_at = now(), inventory_generation = $4, updated_at = now()
          WHERE integration_id = $1 AND entity_type = 'variant' AND external_id = $2`,
        [integrationId, row.externalId, row.modifiedAt?.toISOString() ?? null, Number(generation)],
      );
    }
  });
}

function markerOrderIdentity(shopId, data) {
  const description = String(data.Description ?? data.description ?? '');
  const match = new RegExp(`\\[NTG:${String(shopId).toLowerCase()}:([0-9a-f-]{36}):(\\d+)\\]`, 'i').exec(description);
  return match ? { orderId: match[1].toLowerCase(), orderNumber: Number(match[2]) } : null;
}

function posPaymentMethod(data) {
  const methods = (data.Payments ?? data.payments ?? []).map((row) => String(row.Method ?? row.method ?? '').toLowerCase());
  if (methods.some((x) => x.includes('cash'))) return 'cash';
  if (methods.some((x) => x.includes('card'))) return 'card';
  if (methods.some((x) => x.includes('transfer'))) return 'transfer';
  return 'other';
}

function sanitizedInvoiceSnapshot(shopId, data) {
  const details = data.InvoiceDetails ?? data.invoiceDetails ?? data.Details ?? data.details ?? [];
  const payments = data.Payments ?? data.payments ?? [];
  const identity = markerOrderIdentity(shopId, data);
  return {
    Id: data.Id ?? data.id ?? data.InvoiceId ?? data.invoiceId ?? null,
    Code: data.Code ?? data.code ?? null,
    BranchId: data.BranchId ?? data.branchId ?? null,
    OrderId: data.OrderId ?? data.orderId ?? null,
    OrderCode: data.OrderCode ?? data.orderCode ?? null,
    // Description là ghi chú tự do và có thể chứa tên/SĐT/địa chỉ. Retry chỉ cần marker do
    // nền tảng tự sinh; không giữ phần chữ còn lại của provider.
    Description: identity
      ? deterministicOrderCode(shopId, identity.orderId, identity.orderNumber) : null,
    // CustomerId là khóa ngoài tối thiểu để retry vẫn nối đúng hồ sơ. Không giữ tên/SĐT ở
    // snapshot trung gian; hóa đơn nhập ngay đã ghi chúng vào order/customer có lifecycle PII.
    CustomerId: asId(data.CustomerId ?? data.customerId).slice(0, 200) || null,
    Status: data.Status ?? data.status ?? null,
    StatusValue: data.StatusValue ?? data.statusValue ?? null,
    ModifiedDate: data.ModifiedDate ?? data.modifiedDate ?? null,
    PurchaseDate: data.PurchaseDate ?? data.purchaseDate ?? data.CreatedDate ?? data.createdDate ?? null,
    Total: data.Total ?? data.total ?? null,
    TotalPayment: data.TotalPayment ?? data.totalPayment ?? null,
    InvoiceDetails: Array.isArray(details) ? details.slice(0, 500).map((row) => ({
      ProductId: row.ProductId ?? row.productId ?? row.Id ?? row.id ?? null,
      Quantity: row.Quantity ?? row.quantity ?? null,
      Price: row.Price ?? row.price ?? null,
    })) : [],
    Payments: Array.isArray(payments) ? payments.slice(0, 20).map((row) => ({
      Method: String(row.Method ?? row.method ?? '').slice(0, 80) || null,
    })) : [],
  };
}

const sanitizedPaymentEvidence = (data, externalId, status, total, totalPayment) => ({
  invoice_id: externalId,
  invoice_code: data.Code ?? data.code ?? null,
  branch_id: data.BranchId ?? data.branchId ?? null,
  status,
  total_vnd: total,
  total_payment_vnd: totalPayment,
  payment_methods: (data.Payments ?? data.payments ?? []).slice(0, 20)
    .map((row) => String(row.Method ?? row.method ?? '').slice(0, 80)),
});

async function ensurePosCustomer(c, integrationId, data) {
  const externalId = asId(data.CustomerId ?? data.customerId);
  if (!externalId) return null;
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`kiotviet:customer:${integrationId}:${externalId}`]);
  const existing = (await c.query(
    `SELECT r.local_id FROM integration_entity_refs r
      WHERE r.integration_id = $1 AND r.entity_type = 'customer' AND r.external_id = $2
        AND r.mapping_status = 'mapped' FOR UPDATE`, [integrationId, externalId],
  )).rows[0];
  const name = String(data.CustomerName ?? data.customerName ?? '').trim().slice(0, 200) || null;
  const phone = String(data.CustomerContactNumber ?? data.customerContactNumber ?? '').trim().slice(0, 30) || null;
  if (existing?.local_id) {
    await c.query(
      `UPDATE customers SET full_name = coalesce($2, full_name), phone = coalesce($3, phone), updated_at = now()
        WHERE id = $1 AND status = 'active'`, [existing.local_id, name, phone],
    );
    return existing.local_id;
  }
  const customer = (await c.query(
    `INSERT INTO customers (shop_id, full_name, phone)
     VALUES (current_shop_id(), $1, $2) RETURNING id`, [name, phone],
  )).rows[0];
  await c.query(
    `INSERT INTO integration_entity_refs
       (shop_id, integration_id, entity_type, external_id, local_id, mapping_status, raw_meta)
     VALUES (current_shop_id(), $1, 'customer', $2, $3, 'mapped', $4)`,
    [integrationId, externalId, customer.id, { source: 'kiotviet_pos' }],
  );
  return customer.id;
}

async function releaseWebsiteOrderReservation(c, integrationId, orderId) {
  const lines = (await c.query(
    `SELECT variant_id, sum(qty)::int AS qty
       FROM order_lines WHERE order_id = $1
      GROUP BY variant_id ORDER BY variant_id`, [orderId],
  )).rows;
  for (const line of lines) await c.query(
    `UPDATE inventory_levels
        SET reserved = GREATEST(0, reserved - $2), updated_at = now()
      WHERE variant_id = $1`, [line.variant_id, Number(line.qty)],
  );
  if (lines.length) await c.query(
    `UPDATE integration_entity_refs
        SET inventory_synced_at = NULL, inventory_generation = NULL, updated_at = now()
      WHERE integration_id = $1 AND entity_type = 'variant'
        AND local_id = ANY($2::uuid[])`,
    [integrationId, lines.map((line) => line.variant_id)],
  );
}

async function importPosInvoice(shopId, integrationId, generation, event, { storedReplay = false } = {}) {
  const data = event.data ?? {};
  const externalId = asId(data.Id ?? data.id ?? data.InvoiceId ?? data.invoiceId);
  if (!externalId) return;
  await withIntegrationTenant(shopId, async (c) => {
    // Nhập invoice cập nhật heartbeat connector ở cuối transaction; lấy khóa lifecycle độc
    // quyền ngay đầu để các invoice đồng thời không deadlock khi cùng nâng khóa connector.
    await lockIntegrationGeneration(c, integrationId, generation, 'UPDATE');
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`kiotviet:invoice:${integrationId}:${externalId}`]);
    const integration = (await c.query(
      `SELECT external_branch_ref FROM shop_integrations WHERE id = $1`, [integrationId],
    )).rows[0];
    const branchId = asId(data.BranchId ?? data.branchId);
    // V1 chỉ nhập đúng một chi nhánh. Payload thiếu BranchId không được suy từ tổng retailer;
    // reconciliation sẽ đọc lại hóa đơn đầy đủ qua API và phục hồi nếu webhook bị rút gọn.
    if (!integration || !branchId || branchId !== asId(integration.external_branch_ref)) return;

    const modifiedAt = asDate(data.ModifiedDate ?? data.modifiedDate ?? data.PurchaseDate ?? data.purchaseDate);
    const existing = (await c.query(
      `SELECT local_id, external_updated_at FROM integration_entity_refs
        WHERE integration_id = $1 AND entity_type = 'invoice' AND external_id = $2 FOR UPDATE`,
      [integrationId, externalId],
    )).rows[0];
    // Monotonic cho cả invoice đã nhập lẫn snapshot còn unresolved. Nếu chỉ chặn khi đã có
    // local_id, một webhook paid cũ có thể ghi đè snapshot cancelled mới rồi được retry thành
    // doanh thu. Snapshot hiện có mốc mà event mới không có mốc cũng phải fail-closed.
    const exactStoredReplay = storedReplay && !existing?.local_id && modifiedAt && existing?.external_updated_at
      && modifiedAt.getTime() === new Date(existing.external_updated_at).getTime();
    if (!exactStoredReplay
      && isStaleKiotVietSnapshot(modifiedAt?.toISOString() ?? null, existing?.external_updated_at)) return;

    // Ghi PII vào customer projection có vòng đời ẩn danh trước mọi nhánh có thể treo invoice.
    // Snapshot retry bên dưới chỉ giữ CustomerId, nên replay vẫn nối được hồ sơ mà không phải
    // giữ tên/SĐT vô hạn trong raw_meta của connector.
    const customerId = await ensurePosCustomer(c, integrationId, data);

    // Giữ bản đầy đủ trước khi thử nhập. Mapping có thể được sửa nhiều phút sau khi cursor
    // reconciliation đã tiến; nút retry phải đọc đúng hóa đơn này thay vì hy vọng quét lại.
    await c.query(
      `INSERT INTO integration_entity_refs
         (shop_id, integration_id, entity_type, external_id, local_id, mapping_status, external_updated_at, raw_meta)
       VALUES (current_shop_id(), $1, 'invoice', $2, NULL, 'unmapped', $3, $4)
       ON CONFLICT (shop_id, integration_id, entity_type, external_id)
       DO UPDATE SET external_updated_at = coalesce(EXCLUDED.external_updated_at, integration_entity_refs.external_updated_at),
                     raw_meta = coalesce(integration_entity_refs.raw_meta, '{}'::jsonb) || EXCLUDED.raw_meta,
                     updated_at = now()`,
       [integrationId, externalId, modifiedAt?.toISOString() ?? null, sanitizedInvoiceSnapshot(shopId, data)],
    );

    const providerOrderId = asId(data.OrderId ?? data.orderId);
    const providerOrderCode = asId(data.OrderCode ?? data.orderCode);
    const localIdentity = markerOrderIdentity(shopId, data);
    let websiteOrder = null;
    if (localIdentity) websiteOrder = (await c.query(
      `SELECT id, total_vnd, paid_at, payment_status, amount_paid_vnd FROM orders
        WHERE id = $1 AND order_number = $2 AND source = 'web'
          AND integration_id = $3 AND integration_generation = $4
        FOR UPDATE`,
      [localIdentity.orderId, localIdentity.orderNumber, integrationId, Number(generation)],
    )).rows[0];
    if (!websiteOrder && (providerOrderId || providerOrderCode)) websiteOrder = (await c.query(
      `SELECT o.id, o.total_vnd, o.paid_at, o.payment_status, o.amount_paid_vnd
         FROM integration_entity_refs r JOIN orders o ON o.id = r.local_id
        WHERE r.integration_id = $1 AND r.entity_type = 'order'
          AND o.integration_id = $1 AND o.integration_generation = $4
          AND (r.external_id = $2 OR ($2 = '-' AND r.raw_meta->>'provider_code' = $3))
        LIMIT 1 FOR UPDATE OF o`,
      [integrationId, providerOrderId || '-', providerOrderCode || '-', Number(generation)],
    )).rows[0];
    let provenPosOrder = false;
    if (!websiteOrder && !localIdentity && (providerOrderId || providerOrderCode)) {
      provenPosOrder = Boolean((await c.query(
        `SELECT 1 FROM integration_entity_refs r
          WHERE r.integration_id = $1 AND r.entity_type = 'order'
            AND r.local_id IS NULL AND r.mapping_status = 'ignored'
            AND r.raw_meta->>'platform_marker' = 'false'
            AND (r.external_id = $2 OR ($2 = '-' AND r.raw_meta->>'provider_code' = $3))
          LIMIT 1`,
        [integrationId, providerOrderId || '-', providerOrderCode || '-'],
      )).rowCount);
    }

    const status = Number(data.Status ?? data.status ?? 0);
    if (websiteOrder) {
      await c.query(
        `INSERT INTO integration_entity_refs
           (shop_id, integration_id, entity_type, external_id, local_id, mapping_status, external_updated_at, raw_meta)
         VALUES (current_shop_id(), $1, 'invoice', $2, $3, 'mapped', $4, $5)
         ON CONFLICT (shop_id, integration_id, entity_type, external_id)
         DO UPDATE SET local_id = EXCLUDED.local_id, mapping_status = 'mapped',
                       external_updated_at = EXCLUDED.external_updated_at,
                       raw_meta = coalesce(integration_entity_refs.raw_meta, '{}'::jsonb) || EXCLUDED.raw_meta,
                       updated_at = now()`,
        [integrationId, externalId, websiteOrder.id, modifiedAt?.toISOString() ?? null,
          { code: data.Code ?? data.code ?? null, website_order_echo: true }],
      );
      const invoiceTotal = asInt(data.Total ?? data.total);
      const totalPayment = asInt(data.TotalPayment ?? data.totalPayment);
      const orderTotal = Number(websiteOrder.total_vnd);
      const exactPayment = status === 1 && invoiceTotal != null && totalPayment != null
        && invoiceTotal === orderTotal && totalPayment === orderTotal;
      let paymentMismatch = false;
      if (status === 1 && exactPayment) {
        const paidAt = (asDate(data.PurchaseDate ?? data.purchaseDate
          ?? data.ModifiedDate ?? data.modifiedDate) ?? new Date()).toISOString();
        // Provider có thể phát nhiều event invoice cho cùng một đơn website. Dùng UUID đơn,
        // không dùng ID invoice, làm khóa idempotency cho hiệu ứng tiền; nếu không hai invoice
        // khác ID có thể tạo hai khoản credit.
        let firstPayment = false;
        if (!websiteOrder.paid_at) {
          const inserted = await c.query(
            `INSERT INTO payment_transactions
               (shop_id, order_id, provider, provider_event_id, amount_vnd, status, entry_type, note, raw)
              VALUES (current_shop_id(), $1, 'kiotviet', $2, $3, 'received', 'credit',
                      'Thanh toán COD đơn website tại KiotViet', $4)
              ON CONFLICT (shop_id, provider, provider_event_id) DO NOTHING`,
            [websiteOrder.id, `kiotviet-web-order:${websiteOrder.id}`, totalPayment,
              sanitizedPaymentEvidence(data, externalId, status, invoiceTotal, totalPayment)],
          );
          firstPayment = inserted.rowCount === 1;
          await c.query(
            `UPDATE orders
                SET payment_status = 'paid', amount_paid_vnd = $2, paid_at = $3
              WHERE id = $1 AND paid_at IS NULL`,
            [websiteOrder.id, totalPayment, paidAt],
          );
        }
        // Chỉ invoice tạo hiệu ứng thanh toán đầu tiên mới được đánh dấu đã nhả reservation.
        // Invoice ID khác của cùng đơn là bản lặp quan sát, không được tự nhận quyền nhả kho.
        if (firstPayment) {
          const firstRelease = await c.query(
            `UPDATE integration_entity_refs
                SET raw_meta = coalesce(raw_meta, '{}'::jsonb)
                      || '{"reservation_released":true}'::jsonb,
                    updated_at = now()
              WHERE integration_id = $1 AND entity_type = 'invoice' AND external_id = $2
                AND coalesce(raw_meta->>'reservation_released', 'false') <> 'true'
              RETURNING id`,
            [integrationId, externalId],
          );
          if (firstRelease.rowCount === 1) await releaseWebsiteOrderReservation(c, integrationId, websiteOrder.id);
        }
        await c.query(
          `UPDATE integration_sync_discrepancies
              SET status = 'resolved', resolved_at = now(), updated_at = now()
            WHERE integration_id = $1 AND dedupe_key = $2 AND status = 'open'`,
          [integrationId, `invoice-payment:${externalId}`],
        );
      } else if (status === 1) {
        paymentMismatch = true;
        await upsertDiscrepancy(c, integrationId, {
          kind: 'payment_mismatch', severity: 'critical', dedupeKey: `invoice-payment:${externalId}`,
          message: 'Hóa đơn KiotViet của đơn website chưa được ghi nhận thanh toán vì số tiền không khớp.',
          entityType: 'invoice', externalRef: externalId, localId: websiteOrder.id,
          details: {
            order_total_vnd: orderTotal,
            invoice_total_vnd: invoiceTotal,
            total_payment_vnd: totalPayment,
          },
        });
      }
      await c.query(
        `UPDATE orders SET sync_status = $2, sync_error = $3, sync_updated_at = now() WHERE id = $1`,
        [websiteOrder.id, status === 2 || paymentMismatch ? 'needs_attention' : status === 1 ? 'synced' : 'pending',
          status === 2
            ? 'Hóa đơn KiotViet liên kết với đơn website đã bị hủy; cần đối soát tiền và tồn.'
            : paymentMismatch
              ? 'Số tiền hóa đơn KiotViet không khớp đơn website; chưa ghi nhận thanh toán.' : null],
      );
      if (status === 2) await upsertDiscrepancy(c, integrationId, {
        kind: 'return_mismatch', severity: 'critical', dedupeKey: `website-invoice-cancelled:${externalId}`,
        message: 'Hóa đơn KiotViet của đơn website đã bị hủy; hệ thống không tự hoàn tiền hay nhập tồn.',
        entityType: 'invoice', externalRef: externalId, localId: websiteOrder.id,
      });
      await c.query(
        `SELECT record_order_event($1, 'integration.invoice_observed', 'system', NULL, 'kiotviet', $2::jsonb, coalesce($3, now()))`,
        [websiteOrder.id, JSON.stringify({ external_invoice_id: externalId, status }), modifiedAt?.toISOString() ?? null],
      );
      await c.query(
        `UPDATE integration_sync_discrepancies
            SET status = 'resolved', resolved_at = now(), updated_at = now()
          WHERE integration_id = $1 AND dedupe_key = $2 AND status = 'open'`,
        [integrationId, `invoice-order-pending:${externalId}`],
      );
      return;
    }

    if (existing?.local_id) {
      if (status === 2) {
        await c.query(
          `UPDATE orders SET sync_status = 'needs_attention', sync_error = $2, sync_updated_at = now() WHERE id = $1`,
          [existing.local_id, 'Hóa đơn POS đã bị hủy ở KiotViet; cần đối soát hoàn tiền và tồn.'],
        );
        await upsertDiscrepancy(c, integrationId, {
          kind: 'return_mismatch', severity: 'critical', dedupeKey: `pos-invoice-cancelled:${externalId}`,
          message: 'Hóa đơn POS đã nhập trước đó nay bị hủy ở KiotViet; không tự đảo tiền/tồn.',
          entityType: 'invoice', externalRef: externalId, localId: existing.local_id,
        });
      }
      await c.query(
        `UPDATE integration_entity_refs SET external_updated_at = coalesce($3, external_updated_at),
                                            raw_meta = $4, updated_at = now()
          WHERE integration_id = $1 AND entity_type = 'invoice' AND external_id = $2`,
        [integrationId, externalId, modifiedAt?.toISOString() ?? null, { code: data.Code ?? data.code ?? null, status }],
      );
      return;
    }

    // Provider có thể tạo đơn thành công rồi worker chết trước khi ghi order ref. Nếu invoice
    // mang OrderId/OrderCode nhưng chưa nối được, nhập ngay thành POS sẽ đếm doanh thu hai lần.
    // Giữ bản đã loại PII và chờ lượt đối soát order chạy trước invoice.
    if (!provenPosOrder && (providerOrderId || providerOrderCode || localIdentity)) {
      await upsertDiscrepancy(c, integrationId, {
        kind: 'order_identity_pending', severity: 'critical',
        dedupeKey: `invoice-order-pending:${externalId}`,
        message: 'Hóa đơn có dấu vết đơn KiotViet nhưng chưa chứng minh được là đơn website hay giao dịch POS; hệ thống tạm chưa ghi doanh thu.',
        entityType: 'invoice', externalRef: externalId,
        details: { provider_order_id: providerOrderId || null, provider_order_code: providerOrderCode || null,
          has_platform_marker: Boolean(localIdentity), retryable: true },
      });
      return;
    }
    if (provenPosOrder) await c.query(
      `UPDATE integration_sync_discrepancies
          SET status = 'resolved', resolved_at = now(), updated_at = now()
        WHERE integration_id = $1 AND dedupe_key = $2 AND status = 'open'`,
      [integrationId, `invoice-order-pending:${externalId}`],
    );

    // Chỉ hóa đơn hoàn thành mới là giao dịch bán lẻ. Trạng thái đang xử lý/hủy không được
    // biến thành doanh thu `paid` chỉ vì đã phát webhook.
    if (status !== 1) return;
    const details = data.InvoiceDetails ?? data.invoiceDetails ?? data.Details ?? data.details ?? [];
    if (!Array.isArray(details) || !details.length) return;
    const lines = [];
    for (const detail of details) {
      const productRef = asId(detail.ProductId ?? detail.productId ?? detail.Id ?? detail.id);
      const ref = (await c.query(
        `SELECT r.variant_id, v.sku, v.title AS variant_title, p.title AS product_title
           FROM product_source_refs r JOIN variants v ON v.id = r.variant_id JOIN products p ON p.id = v.product_id
          WHERE r.source = 'kiotviet' AND r.kind = 'variant' AND r.external_id = $1`, [productRef],
      )).rows[0];
      if (!ref) {
        await upsertDiscrepancy(c, integrationId, {
          kind: 'unmapped_sku', severity: 'critical', dedupeKey: `invoice:${externalId}:product:${productRef}`,
          message: 'Hóa đơn POS chưa nhập được vì có sản phẩm chưa ánh xạ.',
          entityType: 'invoice', externalRef: externalId, details: { product_ref: productRef, retryable: true },
        });
        return;
      }
      lines.push({ ...ref, qty: Math.max(1, asInt(detail.Quantity ?? detail.quantity) ?? 1),
        price: asInt(detail.Price ?? detail.price) ?? 0 });
    }
    const total = asInt(data.Total ?? data.total) ?? lines.reduce((sum, line) => sum + line.price * line.qty, 0);
    const totalPayment = asInt(data.TotalPayment ?? data.totalPayment) ?? 0;
    if (totalPayment !== total) {
      await upsertDiscrepancy(c, integrationId, {
        kind: 'payment_mismatch', severity: 'critical', dedupeKey: `invoice-payment:${externalId}`,
        message: 'Hóa đơn POS chưa được nhập vì số đã thanh toán khác tổng hóa đơn.',
        entityType: 'invoice', externalRef: externalId, details: { total_vnd: total, total_payment_vnd: totalPayment },
      });
      return;
    }
    const num = (await c.query(
      `INSERT INTO shop_counters (shop_id, name, value) VALUES (current_shop_id(), 'order_number', 1)
       ON CONFLICT (shop_id, name) DO UPDATE SET value = shop_counters.value + 1 RETURNING value`,
    )).rows[0].value;
    const paidAt = (asDate(data.PurchaseDate ?? data.purchaseDate ?? data.CreatedDate ?? data.createdDate) ?? new Date()).toISOString();
    const order = (await c.query(
      `INSERT INTO orders
         (shop_id, order_number, status, payment_status, payment_method, customer_name, customer_phone,
          subtotal_vnd, total_vnd, amount_paid_vnd, paid_at, source, integration_id, external_ref,
           external_branch_ref, sync_status, sync_updated_at, created_at, customer_id,
           integration_generation)
        VALUES (current_shop_id(), $1, 'delivered', 'paid', $2, $3, $4, $5, $5, $5, $6,
                'kiotviet_pos', $7, $8, $9, 'synced', now(), $6, $10, $11)
        RETURNING id`,
      [num, posPaymentMethod(data), data.CustomerName ?? data.customerName ?? null,
        data.CustomerContactNumber ?? data.customerContactNumber ?? null, total, paidAt,
        integrationId, externalId, branchId || null, customerId, Number(generation)],
    )).rows[0];
    for (const line of lines) await c.query(
      `INSERT INTO order_lines
         (shop_id, order_id, variant_id, title_snapshot, sku_snapshot, unit_price_vnd, qty, unit_cost_vnd)
       VALUES (current_shop_id(), $1, $2, $3, $4, $5, $6,
               (SELECT cost_vnd FROM variant_costs
                 WHERE shop_id = current_shop_id() AND variant_id = $2))`,
      [order.id, line.variant_id, `${line.product_title}${line.variant_title ? ` - ${line.variant_title}` : ''}`,
        line.sku, line.price, line.qty],
    );
    await c.query(
      `INSERT INTO payment_transactions
         (shop_id, order_id, provider, provider_event_id, amount_vnd, status, entry_type, note, raw)
       VALUES (current_shop_id(), $1, 'kiotviet', $2, $3, 'received', 'credit', 'Thanh toán tại KiotViet POS', $4)
       ON CONFLICT (shop_id, provider, provider_event_id) DO NOTHING`,
       [order.id, `invoice:${externalId}`, totalPayment,
         sanitizedPaymentEvidence(data, externalId, status, total, totalPayment)],
    );
    await c.query(
      `INSERT INTO integration_entity_refs
         (shop_id, integration_id, entity_type, external_id, local_id, mapping_status, external_updated_at, raw_meta)
       VALUES (current_shop_id(), $1, 'invoice', $2, $3, 'mapped', $4, $5)
       ON CONFLICT (shop_id, integration_id, entity_type, external_id)
       DO UPDATE SET local_id = EXCLUDED.local_id, mapping_status = 'mapped',
                     external_updated_at = EXCLUDED.external_updated_at,
                     raw_meta = EXCLUDED.raw_meta, updated_at = now()`,
      [integrationId, externalId, order.id, modifiedAt?.toISOString() ?? null,
        { code: data.Code ?? data.code ?? null, status }],
    );
    await c.query(
      `SELECT record_order_event($1, 'order.imported_pos', 'system', NULL, 'kiotviet', $2::jsonb, $3)`,
      [order.id, JSON.stringify({ external_invoice_id: externalId }), paidAt],
    );
    await c.query(
      `UPDATE integration_sync_discrepancies
          SET status = 'resolved', resolved_at = now(), updated_at = now()
        WHERE integration_id = $1 AND entity_type = 'invoice' AND external_ref = $2 AND status = 'open'`,
      [integrationId, externalId],
    );
    await c.query(`UPDATE shop_integrations SET orders_synced_at = now(), updated_at = now() WHERE id = $1`, [integrationId]);
  });
}

async function observeKiotVietOrder(shopId, integrationId, generation, event, { authoritativeIdentity = false } = {}) {
  const data = event.data ?? {};
  const externalId = asId(data.Id ?? data.id);
  const localIdentity = markerOrderIdentity(shopId, data);
  if (!externalId) return;
  if (!localIdentity) {
    // Webhook có thể là payload rút gọn nên thiếu Description không chứng minh đây là đơn POS.
    // Chỉ kết quả listOrders đầy đủ trong reconciliation mới được ghi bằng chứng "không marker";
    // invoice scan chạy ngay sau đó có thể nhập doanh thu POS thay vì treo vô hạn.
    if (!authoritativeIdentity) return;
    const evidence = await withIntegrationTenant(shopId, async (c) => {
      await lockIntegrationGeneration(c, integrationId, generation);
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`kiotviet:order:${integrationId}:${externalId}`]);
      // Crash-gap: provider có thể đã nhận đơn website trong khi transaction ghi external_ref
      // chưa COMMIT. Absence của marker trên list endpoint không được biến đơn ấy thành POS.
      // FOR SHARE chờ sender đang giữ FOR UPDATE; sau khi nó COMMIT ta sẽ thấy ref mapped.
      const outboundPending = (await c.query(
        `SELECT 1 FROM orders
          WHERE source = 'web' AND integration_id = $1 AND integration_generation = $2
            AND external_ref IS NULL AND sync_status IN ('pending','needs_attention')
          ORDER BY created_at, id LIMIT 1 FOR SHARE`,
        [integrationId, Number(generation)],
      )).rowCount;
      if (outboundPending) return { identityBlocked: true };
      const modifiedAt = asDate(data.ModifiedDate ?? data.modifiedDate);
      const previous = (await c.query(
        `SELECT local_id, external_updated_at FROM integration_entity_refs
          WHERE integration_id = $1 AND entity_type = 'order' AND external_id = $2 FOR UPDATE`,
        [integrationId, externalId],
      )).rows[0];
      if (previous?.local_id) return;
      if (isStaleKiotVietSnapshot(modifiedAt?.toISOString() ?? null, previous?.external_updated_at)) return;
      await c.query(
        `INSERT INTO integration_entity_refs
           (shop_id, integration_id, entity_type, external_id, local_id, mapping_status, external_updated_at, raw_meta)
         VALUES (current_shop_id(), $1, 'order', $2, NULL, 'ignored', $3, $4)
         ON CONFLICT (shop_id, integration_id, entity_type, external_id)
         DO UPDATE SET mapping_status = 'ignored', external_updated_at = EXCLUDED.external_updated_at,
                       raw_meta = EXCLUDED.raw_meta, updated_at = now()
         WHERE integration_entity_refs.local_id IS NULL`,
        [integrationId, externalId, modifiedAt?.toISOString() ?? null, {
          provider_code: asId(data.Code ?? data.code).slice(0, 200) || null,
          status: Number(data.Status ?? data.status ?? 0), platform_marker: false,
        }],
      );
      return { externalId, providerCode: asId(data.Code ?? data.code).slice(0, 200) || null };
    });
    if (evidence?.identityBlocked) return evidence;
    return evidence ? { posEvidence: evidence } : null;
  }
  await withIntegrationTenant(shopId, async (c) => {
    await lockIntegrationGeneration(c, integrationId, generation);
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`kiotviet:order:${integrationId}:${externalId}`]);
    const order = (await c.query(
      `SELECT id FROM orders
        WHERE id = $1 AND order_number = $2 AND source = 'web'
          AND integration_id = $3 AND integration_generation = $4
        FOR UPDATE`,
      [localIdentity.orderId, localIdentity.orderNumber, integrationId, Number(generation)],
    )).rows[0];
    if (!order) return;
    const status = Number(data.Status ?? data.status ?? 0);
    const modifiedAt = asDate(data.ModifiedDate ?? data.modifiedDate);
    const previous = (await c.query(
      `SELECT local_id, mapping_status, external_updated_at, raw_meta FROM integration_entity_refs
        WHERE integration_id = $1 AND entity_type = 'order' AND external_id = $2 FOR UPDATE`,
      [integrationId, externalId],
    )).rows[0];
    if (previous?.local_id && previous.local_id !== order.id) {
      await upsertDiscrepancy(c, integrationId, {
        kind: 'order_identity_pending', severity: 'critical',
        dedupeKey: `order-marker-conflict:${externalId}`,
        message: 'Cùng đơn KiotViet đang trỏ tới hai đơn website; hệ thống dừng cập nhật để tránh đếm hoặc xử lý nhầm.',
        entityType: 'order', externalRef: externalId, localId: order.id,
        details: { previous_local_id: previous.local_id, marker_local_id: order.id },
      });
      return;
    }
    // Marker chứa shop/order UUID là bằng chứng mạnh hơn một snapshot no-marker trước đó.
    // Chỉ bỏ event cũ khi ref đã mapped đúng chính đơn này; local_id NULL luôn được nâng cấp.
    if (previous?.local_id === order.id
      && isStaleKiotVietSnapshot(modifiedAt?.toISOString() ?? null, previous.external_updated_at)) return;
    await c.query(
      `INSERT INTO integration_entity_refs
         (shop_id, integration_id, entity_type, external_id, local_id, mapping_status, external_updated_at, raw_meta)
       VALUES (current_shop_id(), $1, 'order', $2, $3, 'mapped', $4, $5)
       ON CONFLICT (shop_id, integration_id, entity_type, external_id)
       DO UPDATE SET local_id = EXCLUDED.local_id, mapping_status = 'mapped',
                     external_updated_at = CASE
                       WHEN integration_entity_refs.external_updated_at IS NULL THEN EXCLUDED.external_updated_at
                       WHEN EXCLUDED.external_updated_at IS NULL THEN integration_entity_refs.external_updated_at
                       ELSE GREATEST(integration_entity_refs.external_updated_at, EXCLUDED.external_updated_at)
                     END,
                     raw_meta = EXCLUDED.raw_meta, updated_at = now()`,
      [integrationId, externalId, order.id, modifiedAt?.toISOString() ?? null, {
        marker: deterministicOrderCode(shopId, localIdentity.orderId, localIdentity.orderNumber),
        provider_code: data.Code ?? data.code ?? null, status,
      }],
    );
    await c.query(
      `UPDATE integration_sync_discrepancies
          SET status = 'resolved', resolved_at = now(), updated_at = now()
        WHERE integration_id = $1 AND dedupe_key = $2 AND status = 'open'`,
      [integrationId, `order-marker-conflict:${externalId}`],
    );
    // Tài liệu Public API không khóa bảng số trạng thái order; StatusValue mới là contract
    // có nghĩa đọc được. Không đoán 3/4 vì một mã sai sẽ biến đơn hợp lệ thành ca lỗi.
    const rejected = /hủy|cancel/i.test(String(data.StatusValue ?? data.statusValue ?? ''));
    await c.query(
      `UPDATE orders SET external_ref = $2, sync_status = $3, sync_error = $4, sync_updated_at = now()
        WHERE id = $1`, [order.id, externalId, rejected ? 'needs_attention' : 'synced',
        rejected ? 'KiotViet từ chối hoặc hủy đơn; cần kiểm tra tồn và tiền trước khi xử lý tiếp.' : null],
    );
    if (rejected) await upsertDiscrepancy(c, integrationId, {
      kind: 'provider_rejected', severity: 'critical', dedupeKey: `order-rejected:${externalId}`,
      message: 'Đơn website đã bị KiotViet từ chối hoặc hủy; hệ thống không tự hủy đơn hay hoàn tiền.',
      entityType: 'order', externalRef: externalId, localId: order.id,
      details: { status, status_value: data.StatusValue ?? data.statusValue ?? null },
    });
  });
}

async function retryInvoicesForProvenPosOrder(shopId, integrationId, generation, { externalId, providerCode }) {
  const pending = await withIntegrationTenant(shopId, async (c) => {
    await lockIntegrationGeneration(c, integrationId, generation);
    return (await c.query(
      `SELECT external_id, raw_meta FROM integration_entity_refs
        WHERE integration_id = $1 AND entity_type = 'invoice'
          AND local_id IS NULL AND mapping_status = 'unmapped'
          AND (raw_meta->>'OrderId' = $2
            OR (coalesce(raw_meta->>'OrderId', '') = '' AND raw_meta->>'OrderCode' = $3))
        ORDER BY created_at, id LIMIT 500`,
      [integrationId, externalId || '-', providerCode || '-'],
    )).rows;
  });
  for (const row of pending) {
    if (row.raw_meta && typeof row.raw_meta === 'object') {
      await importPosInvoice(shopId, integrationId, generation, { data: row.raw_meta }, { storedReplay: true });
    }
  }
}

async function readKiotVietForReconcile(shopId, integrationId, generation) {
  const row = await withIntegrationTenant(shopId, async (c) =>
    (await c.query(
      `SELECT id, provider, status, credential_ciphertext, external_branch_ref, generation,
              webhook_registered_at, order_reconcile_cursor_at, invoice_reconcile_cursor_at
         FROM shop_integrations WHERE id = $1`, [integrationId],
    )).rows[0]);
  if (!row || row.provider !== 'kiotviet' || row.status === 'disabled'
    || !row.credential_ciphertext || !row.external_branch_ref
    || Number(row.generation) !== Number(generation)) throw new StaleIntegrationJob();
  return row;
}

const reconcileFrom = (cursor, registeredAt) => {
  const base = cursor ?? registeredAt ?? new Date(Date.now() - 10 * 60_000);
  return new Date(new Date(base).getTime() - 60_000).toISOString();
};

async function reconcileKiotVietOrders(shopId, integrationId, generation) {
  const integration = await readKiotVietForReconcile(shopId, integrationId, generation);
  const scanStartedAt = new Date();
  const client = integrationClient(integration);
  let currentItem = 0;
  let seen = 0;
  let exhaustive = false;
  let identityBlocked = false;
  for (let page = 0; page < 100; page++) {
    const batch = await client.listOrders({
      currentItem, pageSize: 100,
      lastModifiedFrom: reconcileFrom(integration.order_reconcile_cursor_at, integration.webhook_registered_at),
      branchId: integration.external_branch_ref,
    });
    for (const row of batch.rows) {
      const observed = await observeKiotVietOrder(
        shopId, integrationId, generation, { data: row }, { authoritativeIdentity: true },
      );
      if (observed?.identityBlocked) identityBlocked = true;
      if (observed?.posEvidence) await retryInvoicesForProvenPosOrder(
        shopId, integrationId, generation, observed.posEvidence,
      );
    }
    seen += batch.rows.length;
    currentItem += batch.rows.length;
    if (!batch.rows.length || batch.rows.length < 100 || (batch.total && currentItem >= batch.total)) {
      exhaustive = true;
      break;
    }
  }
  if (!exhaustive) throw new KiotVietError('Không thể chứng minh đã quét hết đơn KiotViet', {
    status: 503, code: 'order_scan_incomplete',
  });
  if (!identityBlocked) {
    await withIntegrationTenant(shopId, async (c) => {
      await lockIntegrationGeneration(c, integrationId, generation, 'UPDATE');
      await c.query(
        `UPDATE shop_integrations
            SET order_reconcile_cursor_at = GREATEST(
                  coalesce(order_reconcile_cursor_at, '-infinity'::timestamptz), $2::timestamptz
                ), updated_at = now()
          WHERE id = $1 AND generation = $3`,
        [integrationId, scanStartedAt.toISOString(), Number(generation)],
      );
    });
  }
  log('info', 'integration_order_reconciled', {
    shopId, integrationId, generation, seen, cursorHeld: identityBlocked,
  });
}

async function reconcileKiotVietInvoices(shopId, integrationId, generation) {
  const integration = await readKiotVietForReconcile(shopId, integrationId, generation);
  const scanStartedAt = new Date();
  const client = integrationClient(integration);
  let currentItem = 0;
  let seen = 0;
  let exhaustive = false;
  for (let page = 0; page < 100; page++) {
    const batch = await client.listInvoices({
      currentItem, pageSize: 100,
      lastModifiedFrom: reconcileFrom(integration.invoice_reconcile_cursor_at, integration.webhook_registered_at),
      branchId: integration.external_branch_ref,
    });
    for (const row of batch.rows) await importPosInvoice(shopId, integrationId, generation, { data: row });
    seen += batch.rows.length;
    currentItem += batch.rows.length;
    if (!batch.rows.length || batch.rows.length < 100 || (batch.total && currentItem >= batch.total)) {
      exhaustive = true;
      break;
    }
  }
  if (!exhaustive) throw new KiotVietError('Không thể chứng minh đã quét hết hóa đơn KiotViet', {
    status: 503, code: 'invoice_scan_incomplete',
  });
  await withIntegrationTenant(shopId, async (c) => {
    await lockIntegrationGeneration(c, integrationId, generation, 'UPDATE');
    await c.query(
      `UPDATE shop_integrations
          SET invoice_reconcile_cursor_at = GREATEST(
                coalesce(invoice_reconcile_cursor_at, '-infinity'::timestamptz), $2::timestamptz
              ), updated_at = now()
        WHERE id = $1 AND generation = $3`,
      [integrationId, scanStartedAt.toISOString(), Number(generation)],
    );
  });
  log('info', 'integration_invoice_reconciled', { shopId, integrationId, generation, seen });
}

async function reconcileKiotViet(shopId, integrationId, generation) {
  // Catalog phải là quét toàn tập: chỉ như vậy mỗi biến thể mới nhận một bằng chứng freshness
  // độc lập. Order/invoice dùng cursor riêng và chỉ tiến cursor sau khi trang cuối đã được đọc.
  await syncKiotVietCatalog(shopId, integrationId, { incremental: false, generation });
  await reconcileKiotVietOrders(shopId, integrationId, generation);
  await reconcileKiotVietInvoices(shopId, integrationId, generation);
  await withIntegrationTenant(shopId, async (c) => {
    const lifecycle = await lockIntegrationGeneration(c, integrationId, generation, 'UPDATE');
    await c.query(
      `UPDATE shop_integrations
          SET reconciled_at = now(),
              last_error = CASE WHEN status = 'active' THEN NULL ELSE last_error END,
              updated_at = now()
        WHERE id = $1 AND generation = $2`,
      [integrationId, lifecycle.generation],
    );
    // Một dead-letter đã xóa raw payload chỉ được coi là phục hồi sau khi quét catalog,
    // order và invoice đều exhaustive. Các discrepancy nghiệp vụ chi tiết vẫn giữ riêng.
    await c.query(
      `UPDATE integration_sync_discrepancies
          SET status = 'resolved', resolved_at = now(), updated_at = now()
        WHERE integration_id = $1 AND kind = 'webhook_failed'
          AND dedupe_key LIKE 'webhook:%' AND status = 'open'`,
      [integrationId],
    );
  });
}

async function retryStoredKiotVietInvoice(shopId, integrationId, generation, externalId) {
  const raw = await withIntegrationTenant(shopId, async (c) => {
    await lockIntegrationGeneration(c, integrationId, generation);
    return (await c.query(
      `SELECT raw_meta FROM integration_entity_refs
        WHERE integration_id = $1 AND entity_type = 'invoice' AND external_id = $2`,
      [integrationId, externalId],
    )).rows[0]?.raw_meta ?? null;
  });
  if (!raw || typeof raw !== 'object') throw new Error('không còn bản hóa đơn KiotViet để thử lại');
  await importPosInvoice(shopId, integrationId, generation, { data: raw }, { storedReplay: true });
}

async function sweepIntegrationReconcile() {
  if (!integrationDb) return { checked: 0 };
  const dueWebhooks = (await integrationDb.query(
    `SELECT shop_id, inbox_id, generation FROM list_due_integration_webhooks(50)`,
  )).rows;
  let recovered = 0;
  for (const row of dueWebhooks) {
    try {
      await processIntegrationWebhook(row.shop_id, { inbox_id: row.inbox_id });
      recovered += 1;
    } catch (error) {
      log('error', 'integration_webhook_recovery_failed', {
        shopId: row.shop_id, inboxId: row.inbox_id, message: safeDeliveryError(error),
      });
    }
  }
  const rows = (await integrationDb.query(
    `SELECT shop_id, integration_id, generation FROM list_due_integrations(20)`,
  )).rows;
  let done = 0;
  let cursor = 0;
  const runners = Array.from({ length: Math.min(INTEGRATION_RECONCILE_CONCURRENCY, rows.length) }, async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      try {
        const run = await withIntegrationReconcileLock(row.integration_id, () =>
          reconcileKiotViet(row.shop_id, row.integration_id, row.generation));
        if (run.locked) done += 1;
      } catch (error) {
        log('error', 'integration_reconcile_failed', {
          shopId: row.shop_id, integrationId: row.integration_id, message: safeDeliveryError(error),
        });
      }
    }
  });
  await Promise.all(runners);
  return { checked: rows.length, done, webhook_checked: dueWebhooks.length, webhook_recovered: recovered };
}

async function processIntegrationWebhook(shopId, payload) {
  const inbox = await withIntegrationTenant(shopId, async (c) => {
    const row = (await c.query(
      `SELECT w.id, w.integration_id, w.generation, w.event_type, w.payload, w.status,
              w.attempts, w.next_attempt_at, w.claimed_at,
              i.generation AS current_generation, i.status AS integration_status
         FROM integration_webhook_inbox w
         JOIN shop_integrations i ON i.id = w.integration_id
        WHERE w.id = $1 FOR UPDATE OF w`, [payload.inbox_id],
    )).rows[0];
    if (!row || ['completed','superseded'].includes(row.status)) return null;
    if (row.integration_status === 'disabled'
      || Number(row.generation) !== Number(row.current_generation)
      || (payload.generation != null && Number(payload.generation) !== Number(row.generation))) {
      await c.query(
        `UPDATE integration_webhook_inbox
            SET status = 'superseded', payload = '{}'::jsonb, processed_at = now(),
                last_error = 'Webhook thuộc generation connector cũ.', updated_at = now()
          WHERE id = $1`, [row.id],
      );
      return null;
    }
    const claimed = (await c.query(
      `UPDATE integration_webhook_inbox
          SET status = 'processing', attempts = attempts + 1, claimed_at = now(), updated_at = now()
        WHERE id = $1 AND (
          status = 'pending'
          OR (status = 'failed' AND coalesce(next_attempt_at, '-infinity'::timestamptz) <= now())
          OR (status = 'processing' AND coalesce(claimed_at, '-infinity'::timestamptz) < now() - interval '10 minutes')
        ) RETURNING id`, [row.id],
    )).rowCount;
    if (claimed !== 1) return null;
    return { ...row, attempts: Number(row.attempts) + 1 };
  });
  if (!inbox) return;
  try {
    const events = extractKiotVietNotifications(inbox.payload, inbox.event_type);
    if (inbox.event_type === 'stock.update'
      || inbox.event_type === 'product.update' || inbox.event_type === 'product.delete') {
      const run = await withIntegrationReconcileLock(inbox.integration_id, async () => {
        if (inbox.event_type === 'stock.update') {
          await applyStockWebhook(shopId, inbox.integration_id, inbox.generation, events);
        } else {
          await syncKiotVietCatalog(shopId, inbox.integration_id, {
            incremental: true, generation: inbox.generation,
          });
        }
      });
      if (!run.locked) {
        throw new KiotVietError('Connector đang đồng bộ catalog/tồn; webhook sẽ được thử lại.', {
          status: 503, code: 'reconcile_in_progress', retryAfterMs: 5000,
        });
      }
    }
    if (inbox.event_type === 'order.update') {
      for (const event of events) {
        await observeKiotVietOrder(shopId, inbox.integration_id, inbox.generation, event);
      }
    }
    if (inbox.event_type === 'invoice.update') {
      for (const event of events) {
        await importPosInvoice(shopId, inbox.integration_id, inbox.generation, event);
      }
    }
    const completed = await withIntegrationTenant(shopId, async (c) => {
      const changed = await c.query(
        `UPDATE integration_webhook_inbox
            SET status = 'completed', payload = '{}'::jsonb, processed_at = now(),
                next_attempt_at = NULL, last_error = NULL, updated_at = now()
          WHERE id = $1 AND generation = $2 AND status = 'processing'`,
        [inbox.id, inbox.generation],
      );
      if (changed.rowCount === 1) await c.query(
        `UPDATE integration_sync_discrepancies
            SET status = 'resolved', resolved_at = now(), updated_at = now()
          WHERE integration_id = $1 AND dedupe_key = $2 AND status = 'open'`,
        [inbox.integration_id, `webhook:${inbox.id}`],
      );
      return changed;
    });
    if (completed.rowCount !== 1) return;
  } catch (error) {
    if (error instanceof StaleIntegrationJob) {
      await withIntegrationTenant(shopId, (c) => c.query(
        `UPDATE integration_webhook_inbox
            SET status = 'superseded', payload = '{}'::jsonb, processed_at = now(),
                last_error = 'Webhook thuộc generation connector cũ.', updated_at = now()
          WHERE id = $1 AND generation = $2 AND status = 'processing'`,
        [inbox.id, inbox.generation],
      ));
      return;
    }
    const message = safeDeliveryError(error);
    const retryAt = new Date(Date.now() + integrationRetryBackoffMs(error, inbox.attempts));
    const exhausted = inbox.attempts >= INTEGRATION_WEBHOOK_ATTEMPTS;
    const failed = await withIntegrationTenant(shopId, async (c) => {
      const changed = await c.query(
        `UPDATE integration_webhook_inbox
            SET status = $4,
                next_attempt_at = CASE WHEN $4 = 'failed' THEN $3::timestamptz ELSE NULL END,
                payload = CASE WHEN $4 = 'dead_letter' THEN '{}'::jsonb ELSE payload END,
                processed_at = CASE WHEN $4 = 'dead_letter' THEN now() ELSE processed_at END,
                last_error = $2, updated_at = now()
          WHERE id = $1 AND generation = $5 AND status = 'processing'
          RETURNING id`,
        [inbox.id, message, retryAt.toISOString(), exhausted ? 'dead_letter' : 'failed', inbox.generation],
      );
      if (changed.rowCount !== 1) return false;
      await upsertDiscrepancy(c, inbox.integration_id, {
        kind: 'webhook_failed', severity: 'critical', dedupeKey: `webhook:${inbox.id}`,
        message: exhausted
          ? 'Webhook KiotViet đã hết lượt thử; payload đã được xóa và reconciliation sẽ phục hồi dữ liệu.'
          : 'Không xử lý được webhook KiotViet; hệ thống sẽ thử lại và đối soát.',
        details: { event_type: inbox.event_type, error: message, attempts: inbox.attempts, exhausted },
      });
      return true;
    });
    if (!failed || exhausted) return;
    throw error;
  }
}

async function processIntegrationJob(topic, payload, shopId) {
  if (!integrationDb || !shopId) throw new Error('connector chưa được cấu hình');
  try {
    if (topic === 'integration.initial_sync_requested' || topic === 'integration.reconcile_requested') {
      const run = await withIntegrationReconcileLock(payload.integration_id, () =>
        reconcileKiotViet(shopId, payload.integration_id, payload.generation));
      if (!run.locked) {
        throw new KiotVietError('Connector đang có một lượt đối soát khác; sẽ thử lại sau', {
          status: 503, code: 'reconcile_in_progress',
        });
      }
      return;
    }
    if (topic === 'integration.order_created') {
      await sendWebsiteOrderToKiotViet(shopId, payload);
      return;
    }
    if (topic === 'integration.webhook_received') {
      await processIntegrationWebhook(shopId, payload);
      return;
    }
    if (topic === 'integration.invoice_retry_requested') {
      await retryStoredKiotVietInvoice(shopId, payload.integration_id, payload.generation, payload.external_id);
      return;
    }
  } catch (error) {
    if (error instanceof StaleIntegrationJob) return;
    const message = safeDeliveryError(error);
    const fatalConfig = error instanceof KiotVietError
      && ['authentication_failed','invalid_credentials'].includes(error.code);
    if (payload?.integration_id) await withIntegrationTenant(shopId, (c) => c.query(
      `UPDATE shop_integrations
          SET status = CASE WHEN $4 AND status <> 'disabled' THEN 'degraded' ELSE status END,
              last_error = $2, updated_at = now()
        WHERE id = $1 AND generation = $3`,
      [payload.integration_id, message, Number(payload.generation), fatalConfig],
    )).catch(() => {});
    const permanentOrderError = topic === 'integration.order_created'
      && error instanceof KiotVietError && Number(error.statusCode) < 500;
    if (permanentOrderError) {
      await withIntegrationTenant(shopId, async (c) => {
        await lockIntegrationGeneration(c, payload.integration_id, payload.generation);
        await c.query(
          `UPDATE integration_order_send_intents
              SET state = 'needs_attention', lookup_state = 'inconclusive', last_error = $2, updated_at = now()
            WHERE integration_id = $1 AND generation = $3 AND order_id = $4
              AND state <> 'sent'`,
          [payload.integration_id, message, Number(payload.generation), payload.order_id],
        );
        await c.query(
          `UPDATE orders SET sync_status = 'needs_attention', sync_error = $2, sync_updated_at = now()
            WHERE id = $1 AND integration_generation = $3 AND sync_status <> 'synced'`,
          [payload.order_id, message, Number(payload.generation)],
        );
        await upsertDiscrepancy(c, payload.integration_id, {
          kind: 'provider_rejected', severity: 'critical', dedupeKey: `order-provider:${payload.order_id}`,
          message: 'KiotViet từ chối đơn website; cần sửa dữ liệu hoặc cấu hình trước khi thử lại.',
          entityType: 'order', localId: payload.order_id, details: { error: message },
        });
      });
      return;
    }
    throw error;
  }
}

// ── consumer: queue → email ──────────────────────────────────────────────────
const worker = new Worker('email', async (job) => {
  const { topic, payload, shopId, outboxId } = job.data;
  if (topic.startsWith('integration.')) {
    await processIntegrationJob(topic, payload, shopId);
    return;
  }
  const channelErrors = [];
  const tryChannel = async (channel, fn) => {
    try { return await runTracked(job, channel, fn); }
    catch (e) {
      channelErrors.push({ channel, error: e });
      log('warn', 'notification_channel_failed', { channel, topic, outboxId, message: safeDeliveryError(e) });
      return null;
    }
  };
  // Banner mặc định (0114): KHÔNG phải email — đi đường riêng và DỪNG tại đây.
  // Rơi xuống deliverNotification sẽ gửi JSON thô tới một địa chỉ không tồn tại.
  if (topic === 'shop.banners_seed') { await seedShopBanners(payload, outboxId); return; }
  // Yêu cầu hỗ trợ (0107) đi ĐƯỜNG RIÊNG: người nhận là CHỦ NỀN TẢNG, không phải khách của
  // shop. Nhét vào đường email-khách sẽ phải bịa payload.to, và bịa địa chỉ trong đường gửi
  // thư là cách gửi nhầm người.
  if (topic === 'support.ticket_created') { await deliverSupportAlert(payload, shopId, outboxId); return; }
  // Telegram cho CHỦ SHOP chạy TRƯỚC + ĐỘC LẬP email: nếu email khách lỗi (relay từ chối →
  // throw → retry → dead-letter), chủ shop VẪN nhận "đơn mới". Idempotent theo outboxId +
  // gom lỗi đến CUỐI attempt → email/Messenger vẫn được thử, rồi BullMQ retry riêng kênh chưa xong.
  if (TELEGRAM_ON && shopId && tgMessageFor(topic, payload)) {
    await tryChannel('telegram', () => deliverTelegram(topic, payload, shopId, outboxId));
  }
  // Messenger cũng chạy TRƯỚC + ĐỘC LẬP email, cùng lý do: khách chốt đơn trong chat có
  // thể KHÔNG có email, nên đây là kênh báo duy nhất tới họ.
  if (MESSENGER_URL && topic === 'order.status_changed' && payload?.messenger_psid) {
    await tryChannel('messenger', () => deliverMessenger(topic, payload, shopId, outboxId));
  }
  // Cờ test: email bounce vĩnh viễn → để kiểm dead-letter (chỉ dev/test).
  if (payload?.to) {
    await tryChannel('email', async () => {
      if (payload.to === 'bounce@test.invalid') throw new Error('simulated permanent bounce');
      return deliverNotification(topic, payload, outboxId);
    });
  }
  if (channelErrors.length) {
    // Chỉ đưa tên kênh vào failedReason; lỗi provider đã được làm sạch trong delivery ledger/log.
    throw new Error(`notification channels failed: ${channelErrors.map((x) => x.channel).join(',')}`);
  }
  // KHÔNG log địa chỉ email (PII). Log topic + số đơn để truy vết.
  if (payload?.to) log('info', 'email_sent', { topic, order: payload.order_number });
}, {
  connection,
  concurrency: 5,
  settings: {
    backoffStrategy: (attemptsMade, type, error) => {
      if (type === 'integration') return integrationRetryBackoffMs(error, attemptsMade);
      return BACKOFF_MS;
    },
  },
});

worker.on('failed', (job, err) => {
  log('warn', job?.data?.topic?.startsWith('integration.') ? 'integration_failed' : 'email_failed', {
    id: job?.id, attempts: job?.attemptsMade, message: safeDeliveryError(err),
  });
  const exhausted = Number(job?.attemptsMade ?? 0) >= Number(job?.opts?.attempts ?? ATTEMPTS);
  if (!exhausted || job?.data?.topic !== 'integration.order_created') return;
  const { shopId, payload } = job.data;
  void withIntegrationTenant(shopId, async (c) => {
    await lockIntegrationGeneration(c, payload.integration_id, payload.generation);
    await c.query(
      `UPDATE orders SET sync_status = 'needs_attention', sync_error = $2, sync_updated_at = now()
        WHERE id = $1 AND integration_generation = $3 AND sync_status <> 'synced'`,
      [payload.order_id, 'Đã thử gửi sang KiotViet nhiều lần nhưng chưa thành công.', Number(payload.generation)],
    );
    await upsertDiscrepancy(c, payload.integration_id, {
      kind: 'provider_rejected', severity: 'critical', dedupeKey: `order-dead-letter:${payload.order_id}`,
      message: 'Đơn website đã hết lượt gửi tự động sang KiotViet; cần thử lại sau khi sửa kết nối.',
      entityType: 'order', localId: payload.order_id, details: { error: safeDeliveryError(err) },
    });
  }).catch((error) => log('error', 'integration_dead_letter_mark_failed', { message: safeDeliveryError(error) }));
});

// ── sweep: hết hạn đơn QR/COD chưa trả tiền → RELEASE reserve ────────────────
// Đơn 'pending'/'unpaid' quá hạn: nhả giữ chỗ + huỷ đơn + hoàn lượt coupon + báo khách.
// Release chỉ giảm `reserved` (KHÔNG đụng on_hand → không ghi ledger, giống cancelOrderTx).
//
// MỖI ĐƠN MỘT GIAO DỊCH — không gói cả lô.
// Bản trước gói tới 200 đơn trong MỘT transaction, nên MỘT lỗi bất kỳ (deadlock, ràng buộc,
// mất kết nối giữa chừng) là ROLLBACK cả lô: 200 đơn không được nhả giữ chỗ trong nhịp đó,
// và dấu vết duy nhất là một dòng log. Hàng tồn bị giam vì một đơn hỏng ở đâu đó trong lô.
// Tách ra thì một đơn hỏng chỉ mất chính nó; 199 đơn kia vẫn xong.
//
// CÁI GIÁ PHẢI TRẢ, và chỗ này là phần dễ làm ẩu nhất:
// bản cũ giữ `FOR UPDATE SKIP LOCKED` suốt cả lô nên hai lượt quét chồng nhau KHÔNG BAO GIỜ
// đụng cùng một đơn — chính vì thế lệnh UPDATE cũ KHÔNG cần guard trạng thái. Commit từng đơn
// là nhả khoá sớm, nên nếu bê nguyên vòng lặp cũ thì hai lượt chồng nhau sẽ nhả giữ chỗ HAI
// LẦN cho cùng một đơn — tức là tự đẻ ra lỗ tồn-sống-lại để chữa một lỗ khác.
// Nên chia hai pha: pha 1 chỉ CHỌN ứng viên (không giữ khoá); pha 2 mỗi đơn tự khoá lại và
// KIỂM LẠI ĐIỀU KIỆN dưới khoá (`status='pending'` + vẫn quá hạn). Đơn đã bị lượt khác xử
// (hoặc khách vừa trả tiền) thì SELECT không trả dòng nào → bỏ qua, không làm gì.
// ĐIỀU KIỆN "ĐƠN ĐÃ QUÁ HẠN" — MỘT bản duy nhất, dùng cho CẢ hai pha.
// Pha 1 (chọn ứng viên) và pha 2 (kiểm lại dưới khoá) phải hỏi ĐÚNG một câu hỏi. Chép tay
// thành hai bản là tự đẻ ra chỗ trôi lệch: nới pha 1 mà quên pha 2 thì quét bỏ sót; nới pha 2
// mà quên pha 1 thì chốt chặn chống-xử-hai-lần bị vô hiệu mà không ai thấy. $1 = phút (QR),
// $2 = ngày (COD) — giữ NGUYÊN vị trí tham số ở cả hai chỗ gọi.
const DON_QUA_HAN_SQL = `status = 'pending' AND (
      (payment_method = 'qr'  AND payment_status = 'unpaid' AND created_at < now() - ($1 || ' minutes')::interval)
   OR (payment_method = 'cod' AND payment_status = 'unpaid' AND created_at < now() - ($2 || ' days')::interval)
    )
    -- ĐÃ NHẬN ĐỒNG NÀO THÌ KHÔNG TỰ HUỶ (0136).
    -- 'payment_status='unpaid'' KHÔNG có nghĩa "chưa trả đồng nào": webhook cộng dồn mọi giao
    -- dịch và CHỈ đụng bảng orders khi ĐỦ tiền (payment/server.js:202-215) — chú thích ở đó
    -- viết rõ "khách có thể chuyển nhiều lần". Chuyển thiếu/chuyển làm hai lượt thì tiền đã
    -- vào payment_transactions mà orders vẫn 'unpaid', amount_paid_vnd vẫn 0. Không có mệnh
    -- đề này thì 30 phút sau ta huỷ đơn + nhả chỗ + gửi email "đã tự huỷ" cho khách TRONG KHI
    -- tiền của họ đang nằm trong tài khoản shop, và không cảnh báo nào kêu (hàng đợi đối soát
    -- chỉ nhận giao dịch KHÔNG KHỚP đơn, còn đây là khớp-nhưng-thiếu).
    -- Đơn đó nay nằm lại danh sách chờ để người bán tự xử. Đánh đổi CHẤP NHẬN: giữ chỗ lâu hơn.
    -- KHÔNG ảnh hưởng đơn COD: thu tiền mặt không ghi payment_transactions, nên tự-huỷ-7-ngày
    -- vẫn chạy y như cũ.
    AND NOT EXISTS (SELECT 1 FROM payment_transactions pt WHERE pt.order_id = orders.id)`;

async function sweepExpired() {
  if (!expiryDb) return 0;
  let xong = 0, hong = 0;
  let ids = [];
  // PHA 1 — chọn ứng viên. CHỈ ĐỌC id, KHÔNG khoá, và dùng pool.query() nên KHÔNG giữ kết
  // nối: giữ khoá ở đây là quay lại đúng vấn đề vừa bỏ. Điều kiện thật được kiểm LẠI dưới
  // khoá ở pha 2, nên danh sách này chỉ là gợi ý.
  try {
    ids = (await expiryDb.query(
      `SELECT id FROM orders WHERE ${DON_QUA_HAN_SQL} ORDER BY id LIMIT 200`,
      [String(ORDER_EXPIRY_MINUTES), String(COD_EXPIRY_DAYS)],
    )).rows.map((r) => r.id);
  } catch (e) {
    log('error', 'expiry_error', { message: e.message });
    return 0;
  }

  // PHA 2 — mỗi đơn một giao dịch độc lập, TRÊN MỘT KẾT NỐI LẤY RIÊNG.
  //
  // Vì sao KHÔNG giữ một kết nối suốt lô (dù như thế ít round-trip hơn):
  //  · Pool `expiryDb` chỉ có max 2, mà 6+ vòng quét khác dùng chung (dọn phiên Messenger,
  //    đồng bộ vận đơn, thống kê SP, ảnh đánh giá, ẩn danh PII…). Tách giao dịch làm lô CHẠY
  //    LÂU HƠN (200 lượt BEGIN/COMMIT thay vì một), nên giữ kết nối suốt lô là đổi một vấn đề
  //    lấy một vấn đề khác: hết deadlock nhưng đói kết nối. Nhả giữa các đơn thì các quét
  //    khác chen vào được.
  //  · Và quan trọng hơn: nếu ROLLBACK CŨNG lỗi (kết nối chết giữa chừng) thì client đang
  //    treo transaction. Giữ nguyên nó để chạy tiếp 199 đơn còn lại là hỏng hết phần còn lại
  //    của lô. `release(err)` HUỶ kết nối hỏng, lượt sau lấy được cái sạch.
  for (const id of ids) {
    const c = await expiryDb.connect().catch(() => null);
    if (!c) { hong++; log('error', 'expiry_order_error', { order_id: id, message: 'không lấy được kết nối' }); continue; }
    let ketNoiHong = null;
    try {
      {
        await c.query('BEGIN');
        // KHOÁ + KIỂM LẠI trong cùng một câu. Đây là chốt chặn chống xử-hai-lần: lượt quét
        // thứ hai (hoặc lượt sau) sẽ chờ khoá, rồi thấy status đã 'cancelled' → 0 dòng → bỏ qua.
        // Dùng LẠI cùng một hằng điều kiện với pha 1 (DON_QUA_HAN_SQL) — giữa hai pha khách
        // có thể vừa trả tiền, nên phải hỏi lại đúng câu hỏi đó dưới khoá.
        const o = (await c.query(
          `SELECT id, shop_id, coupon_code, order_number, total_vnd, payment_method, customer_email
             FROM orders WHERE id = $3 AND ${DON_QUA_HAN_SQL} FOR UPDATE`,
          [String(ORDER_EXPIRY_MINUTES), String(COD_EXPIRY_DAYS), id],
        )).rows[0];
        if (!o) { await c.query('COMMIT'); continue; }

        // ORDER BY variant_id: thứ tự khoá cố định (mirror cancelOrderTx). Đơn từ KHÁCH ghi
        // dòng theo thứ tự bỏ vào giỏ, nên thiếu nó là hai đơn khoá ngược nhau = deadlock (a15).
        const lines = (await c.query(`SELECT variant_id, qty FROM order_lines WHERE order_id = $1 ORDER BY variant_id`, [o.id])).rows;
        for (const ln of lines) {
          await c.query(
            `UPDATE inventory_levels SET reserved = GREATEST(0, reserved - $3), updated_at = now()
              WHERE shop_id = $1 AND variant_id = $2`,
            [o.shop_id, ln.variant_id, ln.qty],
          );
        }
        // Guard `status='pending'` lặp lại ở đây tuy THỪA (dòng đã khoá + đã kiểm ở trên) —
        // giữ vì nó nói ra ý định ngay tại lệnh ghi, và vì bản trước KHÔNG có nó chính là
        // thứ khiến việc tách giao dịch trở nên nguy hiểm.
        await c.query(`UPDATE orders SET status = 'cancelled', cancelled_at = now() WHERE id = $1 AND status = 'pending'`, [o.id]);
        // Đơn hết hạn = chưa trả → hoàn lại 1 lượt coupon (đã tăng lúc tạo đơn).
        if (o.coupon_code) {
          await c.query(`UPDATE coupons SET used_count = GREATEST(used_count - 1, 0) WHERE shop_id = $1 AND upper(code) = upper($2)`, [o.shop_id, o.coupon_code]);
        }
        // Email báo khách đơn TỰ HUỶ (docs/34 §E — hết "huỷ im lặng"). CÙNG transaction với
        // huỷ (ADR-006) — tách giao dịch theo ĐƠN vẫn giữ nguyên tính chất đó.
        if (o.customer_email) {
          await c.query(`INSERT INTO outbox (shop_id, topic, payload) VALUES ($1, 'order.status_changed', $2)`,
            [o.shop_id, { to: o.customer_email, order_id: o.id, order_number: Number(o.order_number), status: 'cancelled', reason: 'expired', payment_method: o.payment_method, total_vnd: Number(o.total_vnd) }]);
        }
        await c.query(
          `INSERT INTO order_events
             (shop_id, order_id, event_type, actor_type, source, payload)
           VALUES ($1,$2,'order.cancelled','system','worker',$3)`,
          [o.shop_id, o.id, { reason: 'expired', payment_method: o.payment_method }],
        );
        await c.query('COMMIT');
        xong++;
      }
    } catch (e) {
      hong++;
      // Log TỪNG đơn hỏng kèm id: bản cũ chỉ có một dòng lỗi cho cả lô nên không cách nào
      // biết đơn nào kẹt. Nuốt lỗi để đơn sau vẫn được xử.
      log('error', 'expiry_order_error', { order_id: id, message: e.message });
      // ROLLBACK hỏng = kết nối không cứu được → đánh dấu để HUỶ nó ở release().
      try { await c.query('ROLLBACK'); } catch (e2) { ketNoiHong = e2; }
    } finally {
      c.release(ketNoiHong ?? undefined);
    }
  }
  if (xong || hong) log('info', 'orders_expired', { n: xong, failed: hong, candidates: ids.length });
  return xong;
}

// ── sweep: dọn phiên hội thoại Messenger nguội (PII, 0123) ────────────────────
// Phiên giữ tên/SĐT/địa chỉ lần mua trước — thứ khiến khách mua lần hai chỉ còn 2 chạm.
// Đổi lại là dữ liệu cá nhân: hết mục đích thì phải xoá (tinh thần 0064). Không ai dọn thì
// bảng phình mãi và mang theo SĐT của mọi người từng nhắn tin cho mọi shop.
//
// KHÔNG có bẫy "đói quét" (xem sweepSubscriptions): điều kiện lọc CHÍNH LÀ điều kiện xoá,
// nên mỗi nhịp luôn lấy đúng dòng còn việc — hết dòng cũ thì trả 0, không có shop nào bị
// kẹt ngoài lô vĩnh viễn.
const MESSENGER_SESSION_TTL_DAYS = Number(process.env.MESSENGER_SESSION_TTL_DAYS ?? 90);
async function sweepMessengerSessions(batch = 500) {
  if (!expiryDb) return 0;
  let c;
  try {
    c = await expiryDb.connect(); // connect() TRONG try — DB sập không làm crash worker
    const r = await c.query(
      `DELETE FROM messenger_sessions
        WHERE ctid IN (SELECT ctid FROM messenger_sessions
                        WHERE updated_at < now() - ($1 || ' days')::interval
                        ORDER BY updated_at LIMIT $2)`,
      [String(MESSENGER_SESSION_TTL_DAYS), batch],
    );
    if (r.rowCount) log('info', 'messenger_sessions_gc', { deleted: r.rowCount, ttl_days: MESSENGER_SESSION_TTL_DAYS });
    return r.rowCount;
  } catch (err) {
    log('error', 'messenger_sessions_gc_failed', { message: err.message });
    return 0;
  } finally { c?.release(); }
}

// ── sweep: xác minh custom domain qua DNS TXT (A5) ────────────────────────────
// Khách thêm TXT `_nentang-verify.<host>` = verification_token. Tra DNS NGOÀI transaction
// (chậm/ngoại vi — không giữ khoá); khớp thì UPDATE verified_at CÓ GUARD (idempotent, an
// toàn khi hai lần quét trùng). Bỏ domain quá 24h chưa xong (challenge chết). DB/DNS lỗi →
// chỉ bỏ nhịp (try/catch), không unhandledRejection → không crash-loop.
const DOMAINVERIFY_BATCH = 100;
const DOMAINVERIFY_PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? 'nentang.vn';
/**
 * Hostname có CNAME trỏ ĐÚNG subdomain nền tảng của shop đó không?
 *
 * Vì sao đủ để thay TXT: đích CNAME mang slug RIÊNG của shop, nên chỉ người sửa được DNS
 * của hostname mới đặt nổi. Bản ghi A wildcard (`*.cuahang.vn → IP nền tảng`) KHÔNG sinh ra
 * CNAME này, nên shop khác không thể mượn wildcard của người ta để chiếm tên miền con.
 * So khớp không phân biệt hoa/thường và bỏ dấu chấm cuối (resolver có thể trả FQDN).
 */
async function cnameMatches(hostname, target) {
  if (!target) return false;
  const want = target.replace(/\.$/, '').toLowerCase();
  try {
    const names = await dnsResolver.resolveCname(hostname);
    return names.some((n) => String(n).replace(/\.$/, '').toLowerCase() === want);
  } catch { return false; } // ENOTFOUND/ENODATA = chưa đặt CNAME (hoặc là apex) → thử đường TXT
}
async function sweepDomainVerify(batch = DOMAINVERIFY_BATCH) {
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

  // XOAY VÒNG (0103) thay vì luôn lấy 100 dòng MỚI NHẤT: dòng chưa verify KHÔNG rời tập kết
  // quả (khách quên đặt TXT thì nằm đó tới 7 ngày), nên `ORDER BY created_at DESC LIMIT 100`
  // khiến domain thứ 101 không bao giờ được tra. Ở đây KHÔNG rút cạn theo lô như nhắc-hạn:
  // mỗi dòng là một truy vấn DNS RA NGOÀI, trần 100/nhịp là đúng — chỉ cần công bằng.
  // NULLS FIRST: domain vừa thêm luôn được ưu tiên → vẫn verify gần như tức thì.
  let rows;
  try {
    // cname_target = subdomain nền tảng CỦA CHÍNH shop đó (`<slug>.nentang.vn`, tạo sẵn lúc
    // mở shop). Lấy từ chính bảng `domains` chứ không JOIN `shops`: vai app_domainverify cố ý
    // KHÔNG có quyền trên `shops`, và nới nó ra chỉ để đọc một cái slug là mất nhiều hơn được.
    rows = (await domainDb.query(
      `SELECT d.id, d.hostname, d.verification_token,
              (SELECT p.hostname FROM domains p
                WHERE p.shop_id = d.shop_id AND p.hostname LIKE '%.' || $3
                ORDER BY p.created_at LIMIT 1) AS cname_target
         FROM domains d
        WHERE d.verified_at IS NULL AND d.created_at > now() - ($2 || ' hours')::interval
        ORDER BY d.last_checked_at NULLS FIRST, d.created_at DESC LIMIT $1`,
      [batch, String(DOMAINVERIFY_GIVEUP_HOURS), DOMAINVERIFY_PLATFORM_DOMAIN])).rows;
  } catch (e) { log('error', 'domainverify_query_error', { message: e.message }); return 0; }
  // Đóng dấu TRƯỚC khi tra DNS, một câu cho cả lô: tra DNS treo/worker chết giữa chừng thì
  // lô này vẫn xoay xuống cuối hàng đợi ở nhịp sau. Bỏ lỡ một vòng chỉ là chậm một nhịp;
  // đóng dấu SAU mà lô luôn chết giữa chừng thì lại đói quét y như cũ.
  if (rows.length) {
    try {
      await domainDb.query(`UPDATE domains SET last_checked_at = now() WHERE id = ANY($1::uuid[])`,
        [rows.map((d) => d.id)]);
    } catch (e) { log('error', 'domainverify_stamp_error', { message: e.message }); }
  }

  let verified = 0;
  for (const d of rows) {
    // Hai đường chứng minh, chấp nhận đường NÀO ĐÚNG trước:
    //   1. CNAME → `<slug>.nentang.vn` (tên miền con): MỘT bản ghi, khách làm một lần.
    //   2. A + TXT (tên miền gốc — apex không đặt CNAME được, ADR-004).
    // Cả hai đều chứng minh "người này điều khiển DNS của hostname", KHÔNG phải chỉ
    // "hostname phân giải về nền tảng" — xem docs/30 §3c về lỗ wildcard.
    let proved = await cnameMatches(d.hostname, d.cname_target);
    if (!proved) {
      let txts;
      try {
        txts = await dnsResolver.resolveTxt(`${DOMAINVERIFY_PREFIX}.${d.hostname}`);
      } catch { continue; } // ENOTFOUND/ENODATA = chưa thêm TXT → bỏ qua, thử nhịp sau
      // resolveTxt trả string[][] (mỗi record là mảng chunk 255-byte) → nối rồi so khớp CHÍNH XÁC.
      proved = txts.some((chunks) => chunks.join('') === d.verification_token);
    }
    if (!proved) continue;
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
async function sweepSubscriptions(reminderBatch) {
  if (!billingDb) return { past_due: 0, cancelled: 0, reminded: 0 };
  let c;
  try {
    c = await billingDb.connect();
    await c.query('BEGIN');
    const pd = await c.query(
      `UPDATE subscriptions SET status = 'past_due'
        WHERE status IN ('trial','active') AND current_period_end IS NOT NULL AND current_period_end < now()`);
    // cancelled_at (0072): mốc huỷ THẬT cho churn — app_billing được GRANT UPDATE
    // theo cột (status, cancelled_at); platform renew sẽ NULL lại khi tái kích hoạt.
    const cancelled = (await c.query(
      `UPDATE subscriptions SET status = 'cancelled', cancelled_at = now()
        WHERE status = 'past_due' AND current_period_end IS NOT NULL
          AND current_period_end < now() - ($1 || ' days')::interval
        RETURNING shop_id`, [String(SUBSCRIPTION_GRACE_DAYS)])).rows;
    for (const row of cancelled) {
      // Đọc trạng thái TRƯỚC khi treo: sau UPDATE chỉ còn thấy 'suspended' (mirror
      // sweepBillingEnforce). Cần nó để mở khoá trả shop về đúng chỗ cũ.
      const prev = (await c.query(`SELECT status FROM shops WHERE id = $1`, [row.shop_id])).rows[0]?.status ?? null;
      // Treo shop CHỈ khi (a) đang onboarding/active (guard DƯƠNG như platform suspend — KHÔNG
      // hạ 'terminated'/'suspended' bằng phủ định <>'suspended'), và (b) shop KHÔNG còn sub nào
      // khác đang phục vụ (đa-sub: đừng treo shop có sub mới active/trial/past_due còn hiệu lực).
      const locked = await c.query(
        `UPDATE shops SET status = 'suspended'
          WHERE id = $1 AND status IN ('onboarding','active')
            AND NOT EXISTS (SELECT 1 FROM subscriptions s2 WHERE s2.shop_id = $1 AND s2.status IN ('trial','active','past_due'))`,
        [row.shop_id],
      );
      // ĐÓNG DẤU khi CHÍNH TA khoá. Thiếu dòng này thì shop TRẢ TIỀN RỒI VẪN BỊ KHOÁ VĨNH VIỄN:
      // sweepBillingApply chỉ mở khoá khi `suspended_at IS NOT NULL`, mà sweepBillingEnforce —
      // nơi duy nhất đóng dấu trước đây — chỉ nhìn sub 'past_due'/'cancelled'. Khách trả tiền
      // xong sub thành 'active' → enforce không bao giờ chọn lại → dấu không bao giờ có → shop
      // kẹt 'suspended' mãi. Hai sweep là hai setInterval RIÊNG còn apply chạy mỗi 30s, nên cửa
      // sổ này có thật ngay ở cấu hình mặc định. Đã dựng lại được (a8-khoa-shop-repro ca 2).
      //
      // Chỉ đóng dấu khi rowCount=1: shop đang bị nền tảng khoá vì VI PHẠM mà ta đóng dấu hộ
      // thì nó tự mở lại được bằng cách trả một tháng tiền — mở đúng cái cửa không nên mở.
      if (locked.rowCount) {
        await c.query(
          `UPDATE subscriptions SET suspended_at = now(), suspended_from = $2
            WHERE shop_id = $1 AND suspended_at IS NULL`, [row.shop_id, prev],
        );
      }
    }
    await c.query('COMMIT');
    // Nhắc hạn chạy SAU chuyển trạng thái, CÙNG nhịp: sub vừa lật past_due nhận ngay
    // thông báo ân hạn trong cùng tick (không đợi giờ sau). LƯU Ý pool max:2 và client
    // transaction ở trên còn checkout tới finally → reminder chỉ được dùng ≤1 kết nối
    // đồng thời (vòng lặp per-sub TUẦN TỰ, không Promise.all — sẽ deadlock pool).
    const reminded = await sweepSubscriptionReminders(reminderBatch);
    if (pd.rowCount || cancelled.length || reminded) log('info', 'subscriptions_swept', { past_due: pd.rowCount, cancelled: cancelled.length, reminded });
    return { past_due: pd.rowCount, cancelled: cancelled.length, reminded };
  } catch (e) {
    if (c) await c.query('ROLLBACK').catch(() => {});
    log('error', 'subscription_sweep_error', { message: e.message });
    return { past_due: 0, cancelled: 0, reminded: 0 };
  } finally { if (c) c.release(); }
}

// ── sweep: NHẮC HẠN thuê bao 7/3/1 ngày + past_due (dunning — 0062) ──────────
// Outbox topic 'subscription.reminder' → email tới shops.contact_email (nếu có) +
// Telegram per-shop (consumer định tuyến theo outbox.shop_id — app_billing KHÔNG đụng
// shop_telegram). Idempotent theo MỐC: claim nguyên tử (mirror lowstock 0052) trên cặp
// (reminded_milestone, reminded_period_end) TRONG CÙNG transaction với INSERT outbox
// (ADR-006: rollback → không mốc cháy, không email ma). Thang bậc d7<d3<d1<past_due:
// worker chết bỏ lỡ mốc → chỉ gửi MỘT nhắc cao nhất (không burst 3 email); gia hạn đẩy
// current_period_end tới → IS DISTINCT FROM tự RE-ARM, platform không cần reset gì.
// Kỷ luật chống crash-loop như mọi sweep: nuốt mọi lỗi, không bao giờ throw ra setInterval.
//
// ĐÓI QUÉT (bug thật, vá 2026-07-27): bản đầu chỉ có `LIMIT 200` và KHÔNG lọc "còn việc",
// nên mỗi nhịp lấy đúng 200 sub HẠN GẦN NHẤT — hầu hết ĐÃ nhắc rồi (claim trả 0 dòng) —
// còn shop thứ 201 trở đi KHÔNG BAO GIỜ lọt vào cửa sổ. Với >200 shop trong cửa sổ 7 ngày
// (đúng quy mô 100–1000 khách đang nhắm) khách hết hạn mà chưa hề nhận nhắc nào, chỉ nhận
// email "ĐÃ QUÁ HẠN" — mất tiền gia hạn, im lặng, không log. Hai vá:
//   (1) đưa điều kiện claim LÊN WHERE → chỉ lấy dòng THỰC SỰ còn việc (đã nhắc rồi thì
//       không chiếm chỗ nữa), tính mốc NGAY TRONG SQL để lọc và claim dùng CÙNG một mốc;
//   (2) rút cạn theo LÔ trong một nhịp, dừng khi hết việc / lô không tiến triển / chạm trần.
const SUB_REMINDER_BATCH = 200;   // mỗi lô, giữ transaction ngắn + pool max:2 thở được
const SUB_REMINDER_ROUNDS = 25;   // trần AN TOÀN 25×200 = 5.000 nhắc/nhịp, chạm thì LOG
// Mốc tính trong SQL — phải khớp thang bậc JS cũ: days<=1 → d1, days<=3 → d3, còn lại d7.
const MILESTONE_SQL = `CASE WHEN sub.status = 'past_due' THEN 'past_due'
             WHEN sub.current_period_end <= now() + interval '1 day' THEN 'd1'
             WHEN sub.current_period_end <= now() + interval '3 days' THEN 'd3'
             ELSE 'd7' END`;
const MILESTONE_RANK = (e) => `CASE ${e} WHEN 'd7' THEN 1 WHEN 'd3' THEN 2 WHEN 'd1' THEN 3 WHEN 'past_due' THEN 4 ELSE 0 END`;
// NOT EXISTS = guard đa-sub (mirror lines suspend): đừng nhắc "sắp tạm ngưng" khi
// concierge đã tạo sub MỚI còn hạn dài phục vụ shop (gia hạn kiểu thêm dòng).
const SUB_REMINDER_SQL =
  `SELECT sub.id, sub.shop_id, sub.status, sub.plan_code, sub.current_period_end,
          sh.name AS shop_name, sh.contact_email, p.name AS plan_name,
          ${MILESTONE_SQL} AS milestone
     FROM subscriptions sub
     JOIN shops sh ON sh.id = sub.shop_id
     LEFT JOIN plans p ON p.code = sub.plan_code
    WHERE sh.status IN ('onboarding','active') AND sub.current_period_end IS NOT NULL
      AND ((sub.status IN ('trial','active') AND sub.current_period_end < now() + interval '7 days')
           OR sub.status = 'past_due')
      AND NOT EXISTS (SELECT 1 FROM subscriptions s2
                       WHERE s2.shop_id = sub.shop_id AND s2.id <> sub.id
                         AND s2.status IN ('trial','active') AND s2.current_period_end > now() + interval '7 days')
      -- CÒN VIỆC: kỳ mới (re-arm sau gia hạn) HOẶC mốc cao bậc hơn mốc đã nhắc.
      AND (sub.reminded_period_end IS DISTINCT FROM sub.current_period_end
           OR ${MILESTONE_RANK(MILESTONE_SQL)} > ${MILESTONE_RANK('sub.reminded_milestone')})
    ORDER BY sub.current_period_end LIMIT $1`;

async function sweepSubscriptionReminders(batch = SUB_REMINDER_BATCH) {
  if (!billingDb) return 0;
  let sent = 0;
  for (let round = 1; ; round++) {
    let subs;
    try {
      subs = (await billingDb.query(SUB_REMINDER_SQL, [batch])).rows;
    } catch (e) { log('error', 'subreminder_query_error', { message: e.message }); break; }
    if (subs.length === 0) break;
    const before = sent;
    sent += await remindSubscriptionBatch(subs);
    // Lô không claim được dòng nào = nhịp khác đang xử lý (hoặc kẹt): dừng, đừng quay vòng.
    if (sent === before) break;
    if (subs.length < batch) break;
    if (round >= SUB_REMINDER_ROUNDS) {
      // KHÔNG im lặng cắt: còn tồn thì phải nhìn thấy được trong log (nhịp sau quét tiếp).
      log('warn', 'subreminder_batch_capped', { rounds: round, sent });
      break;
    }
  }
  if (sent) log('info', 'subscription_reminders', { n: sent });
  return sent;
}

async function remindSubscriptionBatch(subs) {
  let sent = 0;
  for (const s of subs) {
    const msLeft = new Date(s.current_period_end).getTime() - Date.now();
    const days = msLeft / 86400000;
    const milestone = s.milestone;
    const daysLeft = Math.max(0, Math.ceil(days));
    const graceDaysLeft = Math.max(0, Math.ceil((msLeft + SUBSCRIPTION_GRACE_DAYS * 86400000) / 86400000));
    let c;
    try {
      c = await billingDb.connect();
      await c.query('BEGIN');
      // Claim nguyên tử theo mốc: qua khi (a) kỳ ĐỔI (gia hạn → re-arm) hoặc (b) mốc mới
      // CAO BẬC hơn mốc đã nhắc trong cùng kỳ. Hai sweep đua → loser WHERE fail → 0 dòng.
      const claimed = await c.query(
        `UPDATE subscriptions SET reminded_milestone = $2, reminded_period_end = current_period_end
          WHERE id = $1 AND (reminded_period_end IS DISTINCT FROM current_period_end
            OR CASE $2 WHEN 'd7' THEN 1 WHEN 'd3' THEN 2 WHEN 'd1' THEN 3 ELSE 4 END
             > CASE reminded_milestone WHEN 'd7' THEN 1 WHEN 'd3' THEN 2 WHEN 'd1' THEN 3 WHEN 'past_due' THEN 4 ELSE 0 END)`,
        [s.id, milestone]);
      if (claimed.rowCount === 1) {
        // 'to' CHỈ khi có contact_email — thiếu thì deliverNotification bỏ qua email,
        // Telegram vẫn bắn (cùng khuôn sự kiện 'returned' không email khách).
        const payload = {
          shop_name: s.shop_name, plan_code: s.plan_code, plan_name: s.plan_name,
          sub_status: s.status, milestone, days_left: daysLeft, grace_days_left: graceDaysLeft,
          period_end: s.current_period_end,
          // shop_id để email dựng link TỰ GIA HẠN thẳng tới trang Gói dịch vụ (0124-0128).
          shop_id: s.shop_id,
        };
        if (s.contact_email) payload.to = s.contact_email;
        await c.query(`INSERT INTO outbox (shop_id, topic, payload) VALUES ($1, 'subscription.reminder', $2)`, [s.shop_id, payload]);
        sent++;
      }
      await c.query('COMMIT');
    } catch (e) {
      if (c) await c.query('ROLLBACK').catch(() => {});
      log('error', 'subreminder_outbox_error', { message: e.message });
    } finally { if (c) c.release(); }
  }
  return sent;
}

// ── sweep: poll trạng thái vận đơn hãng VC (GHN/GHTK) ─────────────────────────
// Vận đơn in_transit tạo qua hãng → hỏi API hãng (NGOÀI transaction, như DNS sweep);
// 'delivered' → chốt đơn delivered (guard status='shipped' = idempotent) + outbox email.
// 'returned'/'cancelled' → CHỈ đánh dấu vận đơn + log (shop xử lý hoàn/tồn TAY — không
// tự đảo tồn kho vì hàng hoàn cần kiểm đếm thực tế). Token per-shop giải mã bằng
// SHIPPING_ENC_KEY (AES-256-GCM, cùng định dạng secretbox iv.tag.ct base64).
const GHN_BASE = (process.env.GHN_API_BASE ?? 'https://online-gateway.ghn.vn/shiip/public-api').replace(/\/+$/, '');
const GHTK_BASE = (process.env.GHTK_API_BASE ?? 'https://services.giaohangtietkiem.vn').replace(/\/+$/, '');
// Keyring xoay khoá (Đợt 5.6, đồng bộ apps/seller/src/secretbox.js): SHIPPING_ENC_KEYS
// = 'k2:<64hex|base64>,k1:...'; blob v2 mang kid → chọn khoá theo kid; blob legacy
// 3 phần và kid ngầm định 'k0' → khoá legacy SHIPPING_ENC_KEY.
function sbRing(keyringEnv = 'SHIPPING_ENC_KEYS') {
  const out = new Map();
  for (const part of String(process.env[keyringEnv] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    if (i < 1) continue;
    const m = part.slice(i + 1).trim();
    out.set(part.slice(0, i).trim(), /^[0-9a-fA-F]{64}$/.test(m) ? Buffer.from(m, 'hex') : Buffer.from(m, 'base64'));
  }
  return out;
}
function sbOpen(blob, keyHex, keyringEnv = 'SHIPPING_ENC_KEYS') { // bản sao secretbox.open (build context worker là dir riêng)
  const parts = String(blob).split('.');
  let key = Buffer.from(keyHex, 'hex');
  let [ivB64, tagB64, ctB64] = parts;
  if (parts[0] === 'v2' && parts.length === 5) {
    key = sbRing(keyringEnv).get(parts[1]) ?? (parts[1] === 'k0' ? key : null);
    if (!key) throw new Error(`không có khoá kid "${parts[1]}" trong ${keyringEnv}`);
    [, , ivB64, tagB64, ctB64] = parts;
  }
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

async function lockTrackingOrder(c, orderId) {
  // Hai lượt sweep có thể cùng chốt hai kiện khác nhau của một đơn. Khóa order trước shipment
  // buộc chúng nhìn thấy trạng thái terminal của lượt đã commit, nếu không cả hai có thể cùng
  // bỏ lỡ tổ hợp delivered + returned và không lượt sau nào còn nhặt hai kiện đó lên nữa.
  const locked = await c.query(
    `SELECT id FROM orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  return locked.rowCount === 1;
}

async function openMixedShipmentResolution(c, shipment) {
  // app_expiry không được INSERT case/snapshot trực tiếp. Hàm SECURITY DEFINER khóa order,
  // tự đọc shipment terminal và chỉ mở ca khi mọi số lượng đã được giải thích đầy đủ.
  const opened = (await c.query(
    `SELECT open_mixed_shipment_resolution($1) AS result`,
    [shipment.order_id],
  )).rows[0]?.result;
  if (!opened?.opened) return null;

  await c.query(
    `INSERT INTO order_events
       (shop_id, order_id, event_type, actor_type, source, payload)
     VALUES ($1,$2,'resolution.opened','system','worker',$3)`,
    [opened.shop_id, opened.order_id, {
      case_id: opened.case_id,
      kind: 'mixed_shipment_outcome',
      snapshot_lines: Number(opened.snapshot_lines),
      delivered_qty: Number(opened.delivered_qty),
      returned_qty: Number(opened.returned_qty),
      unresolved_qty: Number(opened.unresolved_qty),
      required_refund_vnd: Number(opened.required_refund_vnd),
    }],
  );
  await c.query(
    `INSERT INTO outbox (shop_id, topic, payload)
     VALUES ($1,'order.resolution_required',$2)`,
    [opened.shop_id, {
      order_id: opened.order_id,
      order_number: Number(shipment.order_number),
      case_id: opened.case_id,
      kind: 'mixed_shipment_outcome',
      delivered_qty: Number(opened.delivered_qty),
      returned_qty: Number(opened.returned_qty),
      unresolved_qty: Number(opened.unresolved_qty),
      required_refund_vnd: Number(opened.required_refund_vnd),
    }],
  );
  return opened.case_id;
}

// Lô 30 cũ quá NHỎ so với đích 100-1000 shop: 30 vận đơn/10 phút = 4.320 lượt hỏi/ngày, mà
// một shop bận đã có hàng chục kiện đang đi. Xoay vòng chỉ đảm bảo AI CŨNG tới lượt, không
// đảm bảo tới lượt KỊP — COD chốt 'paid' khi hãng báo delivered, chậm vòng là chậm tiền về sổ.
const TRACKING_BATCH = Math.max(1, Number(process.env.TRACKING_BATCH ?? 200));
// BỎ HỎI vận đơn ZOMBIE: 'in_transit' quá N ngày = hãng đã ngừng cập nhật (mã sai, đơn huỷ
// bên hãng, API không còn giữ bản ghi). Không bỏ thì tập ứng viên chỉ PHÌNH, không bao giờ
// co — xoay vòng vẫn đúng nhưng thời gian một vòng dài ra mãi. Shop KHÔNG bị bỏ rơi: digest
// "đơn ứ" đã cảnh báo kiện gửi hãng >7 ngày chưa giao từ trước đó rất lâu (sweepStaleOrders),
// và shop vẫn chốt giao TAY được.
const TRACKING_GIVEUP_DAYS = Number(process.env.TRACKING_GIVEUP_DAYS ?? 30);
async function sweepTracking() {
  if (!expiryDb || !TRACKING_ON) return { checked: 0, delivered: 0 };
  // Chống LỖI MỘT DÒNG bỏ đói cả hàng đợi (ORDER BY synced_at): mọi đường lỗi PHẢI bump
  // synced_at để dòng hỏng xoay xuống cuối, không chiếm slot mãi mãi.
  const bump = (id) => expiryDb.query(`UPDATE shipments SET synced_at = now() WHERE id = $1`, [id]).catch(() => {});
  // Dọn CLAIM CHẾT: dòng 'created' quá 15' (crash giữa chừng / hãng từ chối mà DELETE bù
  // fail). tracking NULL = hãng CHƯA tạo → mở khoá (cancelled). tracking CÓ (finalize_failed)
  // = vận đơn THẬT tồn tại trên hãng → GIỮ khoá + log cảnh báo (mở là double-create COD thật).
  try {
    // CHỈ mở khoá claim mà ta CHẮC CHẮN hãng chưa hề nhận lệnh: provider_status còn NULL,
    // tức tiến trình chết TRƯỚC khi kịp gọi hãng. Claim 'ambiguous' (gọi hãng rồi nhưng
    // timeout/đứt mạng) thì KHÔNG được đụng: ở đó ta không biết hãng đã tạo chưa, mà đoán
    // "chưa" rồi mở khoá là mời shop tạo vận đơn THỨ HAI cho cùng một đơn — hai lần thu hộ
    // COD, và vận đơn đầu mồ côi. Cả hệ đã dựng ra cờ `ambiguous` đúng vì KHÔNG BIẾT; vòng
    // quét không được biến "không biết" thành "chưa tạo".
    const gc = await expiryDb.query(
      `UPDATE shipments SET status = 'cancelled', provider_status = 'claim_expired', synced_at = now()
        WHERE status = 'created' AND provider IS NOT NULL AND tracking_number IS NULL
          AND provider_status IS NULL
          AND created_at < now() - interval '15 minutes'
        RETURNING id, shop_id, order_id`);
    for (const expired of gc.rows) {
      const c = await expiryDb.connect();
      try {
        await c.query('BEGIN');
        const order = (await c.query(
          `SELECT id, order_number FROM orders WHERE id = $1 FOR UPDATE`, [expired.order_id],
        )).rows[0];
        if (order) await openMixedShipmentResolution(c, { ...expired, order_number: order.order_number });
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        log('error', 'tracking_claim_resolution_error', { orderId: expired.order_id, message: e.message });
      } finally {
        c.release();
      }
    }
    if (gc.rowCount) log('info', 'tracking_claims_expired', { n: gc.rowCount });
    // Claim CẦN NGƯỜI XỬ: có mã (finalize_failed) hoặc không rõ (ambiguous). Cả hai đều giữ
    // khoá và chờ shop đối soát trên trang hãng — nêu tên ra log để người vận hành thấy,
    // thay vì im lặng như trước.
    const stuck = await expiryDb.query(
      `SELECT id, order_id, tracking_number, provider_status FROM shipments
        WHERE status = 'created' AND provider IS NOT NULL
          AND (tracking_number IS NOT NULL OR provider_status = 'ambiguous')
          AND created_at < now() - interval '15 minutes'`);
    for (const r of stuck.rows) {
      log('warn', r.provider_status === 'ambiguous' ? 'tracking_claim_ambiguous' : 'tracking_finalize_stuck',
        { shipmentId: r.id, orderId: r.order_id, tracking: r.tracking_number });
    }
  } catch (e) { log('error', 'tracking_gc_error', { message: e.message }); }

  let rows;
  try {
    rows = (await expiryDb.query(
      `SELECT s.id, s.shop_id, s.order_id, s.provider, s.tracking_number,
              cfg.token_enc, cfg.ghn_shop_id,
              o.status AS order_status, o.order_number, o.total_vnd, o.customer_email
         FROM shipments s
         -- cfg.provider = s.provider LÀ BẮT BUỘC. shop_shipping_config có PK shop_id — MỘT
         -- dòng/shop — nên đổi hãng là GHI ĐÈ token (seller/shipping.js ON CONFLICT). Ghép
         -- chỉ theo shop_id thì vận đơn GHTK cũ vẫn bị nhặt lên nhưng đi hỏi bằng token GHN
         -- mới: hãng trả lỗi → carrierState() trả null → bump → thử lại 4.320 lượt vô ích
         -- trong 30 ngày rồi im. Không log, không metric — COD của những đơn đó KHÔNG BAO
         -- GIỜ tự lật 'paid' (nhánh duy nhất làm việc đó nằm sau st.state === 'delivered').
         JOIN shop_shipping_config cfg ON cfg.shop_id = s.shop_id AND cfg.enabled
                                      AND cfg.provider = s.provider
         JOIN orders o ON o.id = s.order_id
        WHERE s.provider IS NOT NULL AND s.status = 'in_transit'
          AND s.created_at > now() - ($2 || ' days')::interval
        ORDER BY s.synced_at NULLS FIRST LIMIT $1`,
      [TRACKING_BATCH, String(TRACKING_GIVEUP_DAYS)])).rows;
  } catch (e) { log('error', 'tracking_query_error', { message: e.message }); return { checked: 0, delivered: 0 }; }
  // Bão hoà = có thể đang đói. Chỉ lúc đó mới bỏ tiền đếm số vận đơn ZOMBIE bị bỏ hỏi, để
  // người vận hành thấy được vì sao (đếm mỗi nhịp thì tốn scan vô ích khi hệ thống rảnh).
  if (rows.length === TRACKING_BATCH) {
    const zomb = await expiryDb.query(
      `SELECT count(*)::int n FROM shipments s
         JOIN shop_shipping_config cfg ON cfg.shop_id = s.shop_id AND cfg.enabled
                                      AND cfg.provider = s.provider
        WHERE s.provider IS NOT NULL AND s.status = 'in_transit'
          AND s.created_at <= now() - ($1 || ' days')::interval`, [String(TRACKING_GIVEUP_DAYS)]).catch(() => null);
    log('warn', 'tracking_batch_saturated', { batch: TRACKING_BATCH, gave_up: zomb?.rows[0]?.n ?? null });
  }

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
      if (!(await lockTrackingOrder(c, s.order_id))) {
        await c.query('COMMIT');
        continue;
      }
      if (st.state === 'delivered') {
        // SPLIT (0080): đánh dấu KIỆN NÀY delivered TRƯỚC (loại khỏi kiểm "còn kiện chưa giao").
        const shipmentUpdated = await c.query(
          `UPDATE shipments SET status = 'delivered', provider_status = $2, synced_at = now()
            WHERE id = $1 AND status = 'in_transit' RETURNING id`, [s.id, st.raw]);
        if (shipmentUpdated.rowCount !== 1) {
          await c.query('COMMIT');
          continue;
        }
        // Chốt ĐƠN 'delivered' CHỈ khi: mọi dòng gửi đủ (fulfillment='fulfilled') VÀ KHÔNG còn
        // kiện anh em 'created'/'in_transit'/'returned' (mọi kiện đã delivered/cancelled). Tiền COD
        // đi qua record_cod_delivery_payment: status, cache, chứng từ và timeline cùng transaction.
        const upd = await c.query(
          `UPDATE orders SET status = 'delivered', delivered_at = now()
            WHERE id = $1 AND status = 'shipped' AND fulfillment_status = 'fulfilled'
              AND NOT EXISTS (SELECT 1 FROM shipments s2 WHERE s2.order_id = $1 AND s2.status IN ('created','in_transit','returned'))`,
          [s.order_id]);
        if (upd.rowCount === 1) {
          await c.query(`SELECT record_cod_delivery_payment($1,$2)`, [s.order_id, s.id]);
        }
        await c.query(
          `INSERT INTO order_events
             (shop_id, order_id, event_type, actor_type, actor_id, source, payload)
           VALUES ($1,$2,'shipment.delivered','carrier',$3,'worker',$4)`,
          [s.shop_id, s.order_id, s.provider, {
            shipment_id: s.id,
            tracking_number: s.tracking_number,
            order_completed: upd.rowCount === 1,
          }],
        );
        await openMixedShipmentResolution(c, s);
        if (upd.rowCount === 1 && s.customer_email) {
          await c.query(`INSERT INTO outbox (shop_id, topic, payload) VALUES ($1, 'order.status_changed', $2)`,
            [s.shop_id, { to: s.customer_email, order_id: s.order_id, order_number: Number(s.order_number), status: 'delivered', total_vnd: Number(s.total_vnd), tracking_number: s.tracking_number }]);
        }
        if (upd.rowCount === 1) { delivered++; log('info', 'tracking_delivered', { order_number: Number(s.order_number), provider: s.provider }); }
      } else if (st.state === 'returned') {
        // Hàng HOÀN (bom hàng): đánh dấu kiện TRƯỚC. KHÔNG cộng lại on_hand (app_expiry cố tình
        // không có quyền — chủ shop tự Điều chỉnh khi nhận hàng thật). Reserve đã trả lúc ship.
        const shipmentUpdated = await c.query(
          `UPDATE shipments SET status = 'returned', provider_status = $2, synced_at = now()
            WHERE id = $1 AND status = 'in_transit' RETURNING id`, [s.id, st.raw]);
        if (shipmentUpdated.rowCount !== 1) {
          await c.query('COMMIT');
          continue;
        }
        // SPLIT (0080): chốt ĐƠN 'returned' CHỈ khi MỌI kiện đã returned (không còn created/
        // in_transit/delivered). Trộn delivered+returned → GIỮ 'shipped', shop tự xử (v1).
        const upd = await c.query(
          `UPDATE orders SET status = 'returned', returned_at = now()
            WHERE id = $1 AND status = 'shipped'
              AND NOT EXISTS (SELECT 1 FROM shipments s2 WHERE s2.order_id = $1 AND s2.status IN ('created','in_transit','delivered'))`,
          [s.order_id]);
        // Outbox KHÔNG có 'to' → chỉ Telegram cho shop, không email khách bom hàng.
        // Gate rowCount===1 (như delivered) → exactly-once dù sweep chạy lặp.
        if (upd.rowCount === 1) {
          await c.query(`INSERT INTO outbox (shop_id, topic, payload) VALUES ($1, 'order.status_changed', $2)`,
            [s.shop_id, { order_id: s.order_id, order_number: Number(s.order_number), status: 'returned', total_vnd: Number(s.total_vnd), tracking_number: s.tracking_number, reason: 'carrier_returned' }]);
        }
        await c.query(
          `INSERT INTO order_events
             (shop_id, order_id, event_type, actor_type, actor_id, source, payload)
           VALUES ($1,$2,'shipment.returned','carrier',$3,'worker',$4)`,
          [s.shop_id, s.order_id, s.provider, {
            shipment_id: s.id,
            tracking_number: s.tracking_number,
            order_returned: upd.rowCount === 1,
          }],
        );
        await openMixedShipmentResolution(c, s);
        log('warn', 'tracking_returned', { order_number: Number(s.order_number), provider: s.provider, order_changed: upd.rowCount === 1, raw: st.raw });
      } else if (st.state === 'cancelled') {
        const cancelled = await c.query(
          `UPDATE shipments SET status = 'cancelled', provider_status = $2, synced_at = now()
            WHERE id = $1 AND status = 'in_transit' RETURNING id`, [s.id, st.raw],
        );
        if (cancelled.rowCount === 1) {
          // A carrier cancellation is an exception signal, not proof that stock is back.
          // Keep inventory/shipped quantities unchanged and leave an auditable timeline mark.
          await c.query(
            `INSERT INTO order_events
               (shop_id, order_id, event_type, actor_type, actor_id, source, payload)
             VALUES ($1,$2,'shipment.cancelled','carrier',$3,'worker',$4)`,
            [s.shop_id, s.order_id, s.provider, {
              shipment_id: s.id,
              tracking_number: s.tracking_number,
              provider_status: st.raw,
              requires_reconciliation: true,
            }],
          );
          await openMixedShipmentResolution(c, s);
        }
        log('warn', 'tracking_exception', { order_number: Number(s.order_number), provider: s.provider, state: st.state, raw: st.raw });
      } else {
        await c.query(`UPDATE shipments SET provider_status = $2, synced_at = now() WHERE id = $1`, [s.id, st.raw]);
      }
      await c.query('COMMIT');
    } catch (e) {
      if (c) await c.query('ROLLBACK').catch(() => {});
      log('error', 'tracking_update_error', { message: e.message });
      // PHẢI bump cả khi lỗi DB, y như nhánh hãng-lỗi ở trên: xoay vòng chỉ tiến khi
      // synced_at đổi. Dòng lỗi BỀN (dữ liệu đơn hỏng, statement_timeout, khoá kẹt) mà không
      // bump sẽ nằm mãi đầu `ORDER BY synced_at NULLS FIRST LIMIT 30`; đủ 30 dòng như vậy là
      // sweep CHẾT HẲN — không vận đơn nào được hỏi trạng thái nữa, COD giao xong không bao
      // giờ lật 'paid'. Đói quét ăn thẳng vào đường tiền (mirror 0103).
      await bump(s.id);
    } finally { if (c) c.release(); }
  }
  return { checked: rows.length, delivered };
}

// ── sweep: TÍN HIỆU SÀN TMĐT (0096) — tính lại products.sold_count/rating_avg/rating_count ──
// "Đã bán N" + sao trên thẻ sản phẩm (kiểu Shopee/TikTok Shop) đọc từ cột CACHE, không tính
// live (lưới đã 6 subquery/hàng — cộng thêm aggregate sẽ chết ở quy mô 100-1000 shop).
// Sweep này giữ cache tươi. NHẤT QUÁN CUỐI CÙNG là đủ: badge trưng bày, KHÔNG phải đường tiền
// (không dính tồn kho/thanh toán) nên lệch tối đa 1 chu kỳ không gây thiệt hại.
//
// Ghi bằng MỘT câu UPDATE…FROM cho cả nền tảng (không lặp theo shop): sold/rating tính trong
// CTE rồi so bằng IS DISTINCT FROM → chỉ ghi hàng thực sự đổi, tránh bơm WAL vô ích.
const PRODSTATS_SWEEP_MS = Number(process.env.PRODSTATS_SWEEP_MS ?? 900000); // 15 phút
async function sweepProductStats() {
  if (!expiryDb) return { updated: 0 };
  try {
    // Đã bán = SL từ đơn ĐÃ TRẢ và KHÔNG huỷ/trả (ngữ nghĩa ever-paid như reports.js).
    // Sao = chỉ đánh giá ĐÃ DUYỆT — đúng thứ storefront hiển thị.
    const r = await expiryDb.query(`
      WITH sold AS (
        SELECT v.product_id, sum(ol.qty)::int AS qty
          FROM order_lines ol
          JOIN variants v ON v.id = ol.variant_id
          JOIN orders o   ON o.id = ol.order_id
         WHERE o.paid_at IS NOT NULL AND o.status NOT IN ('cancelled', 'returned')
         GROUP BY v.product_id
      ), rated AS (
        SELECT r.product_id, round(avg(r.rating)::numeric, 2) AS avg_r, count(*)::int AS n
          FROM product_reviews r WHERE r.status = 'approved' GROUP BY r.product_id
      )
      UPDATE products p
         SET sold_count  = coalesce(sold.qty, 0),
             rating_avg  = rated.avg_r,
             rating_count = coalesce(rated.n, 0)
        FROM (SELECT id FROM products) ids
        LEFT JOIN sold  ON sold.product_id  = ids.id
        LEFT JOIN rated ON rated.product_id = ids.id
       WHERE p.id = ids.id
         AND (p.sold_count   IS DISTINCT FROM coalesce(sold.qty, 0)
           OR p.rating_avg   IS DISTINCT FROM rated.avg_r
           OR p.rating_count IS DISTINCT FROM coalesce(rated.n, 0))`);
    if (r.rowCount) log('info', 'prodstats_synced', { updated: r.rowCount });
    return { updated: r.rowCount };
  } catch (e) {
    // Kỷ luật chống crash-loop như mọi sweep: nuốt lỗi, không bao giờ throw ra setInterval.
    log('error', 'prodstats_sweep_error', { message: e.message });
    return { updated: 0 };
  }
}

// ── sweep: DỌN RÁC ảnh đánh giá (0102) ───────────────────────────────────────
// Ảnh người mua gửi kèm đánh giá (0101) nằm bucket RIÊNG TƯ tới khi shop duyệt. Hai loại
// rác còn dấu vết trong DB mà worker phải dọn:
//   · đã XOÁ MỀM  — shop từ chối đánh giá → deleted_at được đặt, object vẫn nằm trong kho.
//   · treo QUÁ LÂU — đánh giá không bao giờ được duyệt ('pending') hoặc thăng-public hỏng
//                    ('failed'). Không dọn thì kho phình theo lượng spam.
//
// Loại rác thứ BA — xoá HẲN một đánh giá — KHÔNG dọn được ở đây: review_images CASCADE
// theo product_reviews nên dòng bay ngay, object thành mồ côi không truy được. Vì vậy
// apps/seller xoá object TRƯỚC khi xoá dòng đánh giá (deleteReview). Ghi ở đây để ai đọc
// sweep này không tưởng nó phủ hết mọi đường.
//
// Xoá OBJECT trước, XOÁ DÒNG sau: nếu đổ giữa chừng, vòng sau thử lại (removeObject với key
// đã biến mất là no-op). Ngược lại — xoá dòng trước — sẽ bỏ quên object vĩnh viễn.
const REVIMG_GC_MS = Number(process.env.REVIMG_GC_MS ?? 3600000);        // 1 giờ
const REVIMG_STALE_DAYS = Number(process.env.REVIMG_STALE_DAYS ?? 60);   // đủ rộng cho shop duyệt chậm
let minioClient = null;
async function getMinio() {
  if (minioClient) return minioClient;
  const { Client } = await import('minio');
  minioClient = new Client({
    endPoint: process.env.MINIO_ENDPOINT ?? 'minio',
    port: Number(process.env.MINIO_PORT ?? 9000),
    useSSL: String(process.env.MINIO_USE_SSL ?? 'false') === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY ?? 'minioadmin',
  });
  return minioClient;
}
async function sweepReviewImages() {
  if (!expiryDb) return { removed: 0 };
  const BPRIV = process.env.MEDIA_BUCKET_PRIVATE ?? 'media-private';
  const BPUB = process.env.MEDIA_BUCKET_PUBLIC ?? 'media-public';
  let removed = 0;
  try {
    const mc = await getMinio();
    // LIMIT: dọn từng mẻ, không ôm cả kho trong một vòng (sweep 1 giờ/lần sẽ đuổi kịp).
    const rows = (await expiryDb.query(`
      SELECT id, original_key, public_key FROM review_images
       WHERE deleted_at IS NOT NULL
          OR (status IN ('pending', 'failed') AND created_at < now() - ($1 || ' days')::interval)
       ORDER BY created_at LIMIT 500`, [REVIMG_STALE_DAYS])).rows;
    for (const r of rows) {
      try {
        if (r.original_key) await mc.removeObject(BPRIV, r.original_key).catch(() => {});
        if (r.public_key) await mc.removeObject(BPUB, r.public_key).catch(() => {});
        await expiryDb.query(`DELETE FROM review_images WHERE id = $1`, [r.id]);
        removed++;
      } catch (e) { log('error', 'revimg_gc_row_error', { id: r.id, message: e.message }); }
    }
  } catch (e) {
    // Kỷ luật chống crash-loop: nuốt mọi lỗi, không bao giờ throw ra setInterval.
    log('error', 'revimg_gc_error', { message: e.message });
  }
  if (removed) log('info', 'revimg_gc', { removed });
  return { removed };
}


// ── sweep: TẢI ẢNH SẢN PHẨM THEO URL cho bộ nhập di cư (0106, docs/45 §5) ────
// Bản đầu tải ảnh ĐỒNG BỘ trong request nhập nên phải sống dưới thời gian chờ của BFF:
// trần 200 ảnh / 45 giây mỗi lần. Shop 300 sản phẩm × 3 ảnh phải nhập 5 lần — đúng thứ ma
// sát mà cả tính năng di cư sinh ra để xoá bỏ. Nay bộ nhập chỉ XẾP HÀNG (dòng media
// 'pending' kèm source_url, không chạm mạng) và worker tải nền, không còn trần thời gian.
//
// Hàng rào SSRF KHÔNG viết lại: dùng CHUNG packages/net-guard với seller (mount /app/fetch-image.js).
// Nhân bản đường ống bảo mật là kiểu trùng lặp chắc chắn trôi lệch — vá một bên, quên bên kia.
//
// Vai app_expiry (0106 cấp quyền THEO CỘT + policy riêng): worker KHÔNG thấy cột nào ngoài
// những cột nó cần, và không role nào bypass RLS nên phải có policy tường minh.
const MEDIAFETCH_MS = Number(process.env.MEDIAFETCH_SWEEP_MS ?? 20000);
const MEDIAFETCH_BATCH = Number(process.env.MEDIAFETCH_BATCH ?? 24);
const MEDIAFETCH_CONC = Number(process.env.MEDIAFETCH_CONC ?? 6);
const MEDIAFETCH_MAX_ATTEMPTS = Number(process.env.MEDIAFETCH_MAX_ATTEMPTS ?? 4);
const MEDIAFETCH_TIMEOUT_MS = Number(process.env.MEDIAFETCH_TIMEOUT_MS ?? 8000);
const MEDIAFETCH_MAX_BYTES = Number(process.env.MEDIAFETCH_MAX_BYTES ?? 8 * 1024 * 1024);

async function fetchOneMedia(mc, row, BPRIV, BPUB) {
  const sharp = (await import('sharp')).default;
  const { fetchRemoteImage } = await import('../fetch-image.js');
  const buf = await fetchRemoteImage(row.source_url, {
    maxBytes: MEDIAFETCH_MAX_BYTES, timeoutMs: MEDIAFETCH_TIMEOUT_MS,
  });
  // Sniff magic byte TRƯỚC khi đưa cho sharp: content-type của đích nói dối được, và ta
  // không muốn ném dữ liệu tuỳ ý vào bộ giải mã ảnh nếu chưa biết nó là ảnh.
  const sig = buf.length >= 12 && (
    (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ||
    (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) ||
    (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') ||
    (buf.slice(0, 4).toString('latin1') === 'GIF8'));
  if (!sig) throw Object.assign(new Error('not_image'), { permanent: true });

  // original_key do bộ nhập đặt sẵn lúc xếp hàng — DÙNG LẠI, không tự dựng: hai nơi tự dựng
  // tên object là hai nơi có thể lệch nhau, và khi lệch thì bản gốc thành rác không truy được.
  const originalKey = row.original_key;
  const publicKey = `${row.shop_id}/${row.id}.webp`;
  await mc.putObject(BPRIV, originalKey, buf, buf.length);
  // Re-encode → WebP. sharp mặc định strip metadata; .rotate() áp EXIF rồi bỏ. Đây là bước
  // biến "ảnh có payload nhúng" thành ảnh sạch — GIỐNG HỆT đường ảnh tự tải lên.
  const { data, info } = await sharp(buf).rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
  await mc.putObject(BPUB, publicKey, data, data.length, { 'Content-Type': 'image/webp' });
  return { originalKey, publicKey, width: info.width, height: info.height, size: data.length };
}

async function sweepMediaFetch() {
  if (!expiryDb) return { done: 0 };
  const BPRIV = process.env.MEDIA_BUCKET_PRIVATE ?? 'media-private';
  const BPUB = process.env.MEDIA_BUCKET_PUBLIC ?? 'media-public';
  let done = 0, failed = 0;
  try {
    // CLAIM TRƯỚC KHI LÀM: tăng fetch_attempts + đẩy next_attempt_at ngay khi nhận việc.
    // Không có bước này thì worker chết giữa chừng sẽ để dòng ở 'pending' với mốc cũ, và
    // vòng sau nhặt lại y hệt — quay vòng vô hạn trên đúng một URL hỏng.
    // Lùi giờ theo LUỸ THỪA: 1' → 5' → 25' (đích quá tải cần thời gian, không phải bị đập).
    const rows = (await expiryDb.query(`
      UPDATE media SET fetch_attempts = fetch_attempts + 1,
             next_attempt_at = now() + make_interval(mins => power(5, fetch_attempts)::int)
       WHERE id IN (
         SELECT id FROM media
          WHERE status = 'pending' AND source_url IS NOT NULL AND deleted_at IS NULL
            AND fetch_attempts < $1
            AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          ORDER BY next_attempt_at NULLS FIRST, created_at
          LIMIT $2)
      RETURNING id, shop_id, source_url, original_key, fetch_attempts`, [MEDIAFETCH_MAX_ATTEMPTS, MEDIAFETCH_BATCH])).rows;
    if (rows.length === 0) return { done: 0 };

    const mc = await getMinio();
    let next = 0;
    const worker = async () => {
      for (;;) {
        const row = rows[next++];
        if (!row) return;
        try {
          const out = await fetchOneMedia(mc, row, BPRIV, BPUB);
          await expiryDb.query(
            `UPDATE media SET status = 'ready', original_key = $2, public_key = $3,
                    content_type = 'image/webp', width = $4, height = $5, size_bytes = $6,
                    next_attempt_at = NULL
              WHERE id = $1`,
            [row.id, out.originalKey, out.publicKey, out.width, out.height, out.size]);
          done++;
        } catch (e) {
          failed++;
          // Lỗi VĨNH VIỄN (không phải ảnh, URL bị hàng rào chặn, scheme/cổng sai) thì đánh
          // 'failed' NGAY, đừng thử lại 4 lần — URL đó sẽ không tự tốt lên, và mỗi lần thử
          // là một kết nối ra ngoài mà ta phải chịu trách nhiệm.
          // VĨNH VIỄN: hàng rào chặn (blocked/scheme/port/userinfo/url_invalid/dns), không phải
          // ảnh, hoặc đích trả 3xx/4xx — chuyển hướng ta không bao giờ đi theo, và 404 sẽ không
          // tự có lại. 5xx / timeout / lỗi mạng thì lùi giờ thử lại: đích quá tải cần thời gian,
          // không phải bị đập liên tục.
          const httpPerm = Number.isFinite(e.httpStatus) && e.httpStatus >= 300 && e.httpStatus < 500;
          const perm = e.permanent === true || httpPerm
            || ['blocked', 'scheme', 'port', 'userinfo', 'url_invalid', 'dns'].includes(e.code);
          if (perm || Number(row.fetch_attempts) >= MEDIAFETCH_MAX_ATTEMPTS) {
            await expiryDb.query(`UPDATE media SET status = 'failed', next_attempt_at = NULL WHERE id = $1`, [row.id])
              .catch(() => {});
          }
          log('warn', 'mediafetch_row_failed', { id: row.id, reason: e.code ?? e.message, http: e.httpStatus ?? null, attempt: row.fetch_attempts, permanent: perm });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MEDIAFETCH_CONC, rows.length) }, worker));
  } catch (e) {
    // Kỷ luật chống crash-loop: nuốt mọi lỗi, không bao giờ throw ra setInterval.
    log('error', 'mediafetch_error', { message: e.message });
  }
  if (done || failed) log('info', 'mediafetch', { done, failed });
  return { done, failed };
}

// ── sweep: GỘP LƯỢT XEM sản phẩm từ Redis vào DB (0098) ──────────────────────
// Storefront (vai công khai CHỈ-ĐỌC) đếm vào hash Redis `pv:<ngày VN>:<shopId>`, field =
// productId. Worker gộp vào product_view_daily rồi xoá khoá. Nhờ vậy đường nóng công khai
// không có ghi DB, và một sản phẩm hot chỉ tốn 1 UPSERT/chu kỳ thay vì 1 ghi/lượt xem.
//
// KHÔNG mất số khi đang gộp: RENAME khoá sang `pvf:…` TRƯỚC khi đọc — lượt xem phát sinh
// trong lúc gộp rơi vào khoá `pv:…` MỚI tinh, chu kỳ sau nhặt. (HGETALL rồi DEL sẽ nuốt
// mất phần chen giữa hai lệnh.) Khoá `pvf:` sót lại do worker chết giữa chừng được xử lý
// TRƯỚC ở mỗi lần chạy nên không bao giờ mất dữ liệu.
const PRODVIEW_SWEEP_MS = Number(process.env.PRODVIEW_SWEEP_MS ?? 300000); // 5 phút
const PRODVIEW_KEEP_DAYS = Number(process.env.PRODVIEW_KEEP_DAYS ?? 180);
// SCAN chứ KHÔNG dùng KEYS: Redis đơn luồng và ở đây nó CÒN GIỮ session đăng nhập, rate-limit
// và hàng đợi BullMQ. `KEYS pv:*` duyệt TOÀN BỘ keyspace trong MỘT lệnh chặn — ở quy mô
// 100-1000 shop (mỗi shop mỗi ngày một khoá, cộng session/rl:*/bull:*) là đóng băng Redis vài
// trăm ms mỗi 5 phút, tức là khách đang chốt đơn bị treo theo. SCAN chia thành nhiều lệnh nhỏ.
// Trả về mảng (khoá pv có hạn 2 ngày nên tập này nhỏ); SCAN có thể trả TRÙNG — vô hại vì
// flushViewKey xoá khoá sau khi gộp, lần hai chỉ thấy hash rỗng.
async function scanKeys(rc, pattern) {
  const out = [];
  let cursor = '0';
  do {
    const [next, batch] = await rc.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    if (batch.length) out.push(...batch);
  } while (cursor !== '0');
  return out;
}
async function flushViewKey(rc, flushKey) {
  // pvf:<ngày>:<shopId>
  const parts = flushKey.split(':');
  const day = parts[1], shopId = parts[2];
  // Khoá HỎNG (sai định dạng ngày/uuid) phải bị VỨT, không được ném lỗi: một khoá rác sẽ
  // làm hỏng cả vòng gộp của mọi shop khác (uuid cast lỗi → throw → thoát vòng lặp).
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(shopId ?? '')) {
    log('error', 'prodview_bad_key', { key: flushKey });
    await rc.del(flushKey).catch(() => {});
    return 0;
  }
  const h = await rc.hgetall(flushKey);
  const ids = Object.keys(h ?? {});
  if (!ids.length) { await rc.del(flushKey).catch(() => {}); return 0; }
  const counts = ids.map((id) => Math.max(0, parseInt(h[id], 10) || 0));
  // UPSERT CỘNG DỒN: chạy lại cùng lô cũng chỉ cộng đúng phần chưa cộng (khoá đã xoá).
  // Bỏ qua productId không còn tồn tại → ON CONFLICT DO NOTHING không cứu được FK, nên
  // lọc bằng chính SELECT từ products (join) thay vì tin dữ liệu Redis.
  await expiryDb.query(`
    INSERT INTO product_view_daily (shop_id, product_id, day, views)
    SELECT p.shop_id, p.id, $2::date, v.n
      FROM unnest($3::uuid[], $4::int[]) AS v(pid, n)
      JOIN products p ON p.id = v.pid AND p.shop_id = $1
    ON CONFLICT (shop_id, product_id, day) DO UPDATE SET views = product_view_daily.views + excluded.views`,
    [shopId, day, ids, counts]);
  await rc.del(flushKey).catch(() => {});
  return ids.length;
}
async function sweepProductViews() {
  if (!expiryDb) return { keys: 0 };
  let rc;
  try { rc = await queue.client; } catch { return { keys: 0 }; }
  let keys = 0;
  try {
    // Một khoá lỗi KHÔNG được làm hỏng vòng gộp của các shop còn lại → bọc try từng khoá.
    const one = async (k) => { try { await flushViewKey(rc, k); keys++; } catch (e) { log('error', 'prodview_key_error', { key: k, message: e.message }); } };
    // 1) Dọn khoá gộp-dở-dang của lần chạy trước (worker chết giữa chừng).
    for (const k of await scanKeys(rc, 'pvf:*')) await one(k);
    // 2) Khoá đếm hiện hành → đổi tên rồi gộp.
    for (const k of await scanKeys(rc, 'pv:*')) {
      const dst = `pvf:${k.slice(3)}`;
      try { await rc.rename(k, dst); } catch { continue; }  // khoá vừa hết hạn/biến mất
      await one(dst);
    }
    // 3) Dọn số quá cũ — bảng này chỉ để xem xu hướng gần, không phải sổ sách.
    await expiryDb.query(`DELETE FROM product_view_daily WHERE day < current_date - $1::int`, [PRODVIEW_KEEP_DAYS]);
  } catch (e) {
    // Kỷ luật chống crash-loop: nuốt mọi lỗi, không bao giờ throw ra setInterval.
    log('error', 'prodview_sweep_error', { message: e.message });
  }
  if (keys) log('info', 'prodview_flushed', { keys });
  return { keys };
}

// ── sweep: GỘP LƯỢT DÙNG TÍNH NĂNG từ Redis vào DB (0141) ───────────────────
// Mọi service đếm vào hash Redis `fu:<ngày VN>:<service>`, field = `<METHOD> <mẫu-route>|<shop>`
// (`-` = đường không thuộc shop nào). Worker gộp vào feature_usage rồi xoá khoá.
//
// CÙNG KHUÔN với sweepProductViews (0098) và KHÔNG phải ngẫu nhiên: RENAME sang `fuf:…` TRƯỚC
// khi đọc để lượt phát sinh trong lúc gộp rơi vào khoá MỚI (HGETALL rồi DEL sẽ nuốt mất phần
// chen giữa hai lệnh); SCAN chứ không KEYS vì Redis này còn giữ session/rate-limit/BullMQ;
// try từng khoá để một khoá hỏng không làm hỏng vòng gộp của service khác.
const USAGE_SWEEP_MS = Number(process.env.USAGE_SWEEP_MS ?? 300000);   // 5 phút
const USAGE_KEEP_DAYS = Number(process.env.USAGE_KEEP_DAYS ?? 400);    // đủ so cùng kỳ năm ngoái
const UUID_RE_FU = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function flushUsageKey(rc, flushKey) {
  // fuf:<ngày>:<service>
  const parts = flushKey.split(':');
  const day = parts[1], service = parts.slice(2).join(':');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') || !/^[a-z][a-z0-9-]{0,31}$/.test(service ?? '')) {
    log('error', 'usage_bad_key', { key: flushKey });
    await rc.del(flushKey).catch(() => {});
    return 0;
  }
  const h = await rc.hgetall(flushKey);
  const fields = Object.keys(h ?? {});
  if (!fields.length) { await rc.del(flushKey).catch(() => {}); return 0; }
  const routes = [], shops = [], counts = [];
  for (const f of fields) {
    const bar = f.lastIndexOf('|');
    if (bar <= 0) continue;                       // field méo → bỏ, không làm hỏng cả lô
    const route = f.slice(0, bar), shop = f.slice(bar + 1);
    if (!route || route.length > 160) continue;
    routes.push(route);
    // Shop không còn tồn tại (đã xoá) → NULL, dòng vẫn giữ được để không mất lịch sử dùng.
    shops.push(UUID_RE_FU.test(shop) ? shop : null);
    counts.push(Math.max(0, parseInt(h[f], 10) || 0));
  }
  if (!routes.length) { await rc.del(flushKey).catch(() => {}); return 0; }
  // UPSERT CỘNG DỒN: chạy lại cùng lô cũng chỉ cộng phần chưa cộng (khoá đã xoá sau khi ghi).
  // LEFT JOIN shops: shop_id trỏ shop đã xoá sẽ vi phạm khoá ngoại và làm hỏng CẢ LÔ — hạ về
  // NULL thay vì vứt dòng, vì "ai đó đã dùng tính năng này" vẫn là sự thật cần giữ.
  await expiryDb.query(`
    INSERT INTO feature_usage (service, route, shop_id, day, hits)
    SELECT $1, u.route, s.id, $2::date, u.n
      FROM unnest($3::text[], $4::uuid[], $5::bigint[]) AS u(route, shop, n)
      LEFT JOIN shops s ON s.id = u.shop
    ON CONFLICT (service, route, day, shop_id)
      DO UPDATE SET hits = feature_usage.hits + excluded.hits`,
    [service, day, routes, shops, counts]);
  await rc.del(flushKey).catch(() => {});
  return routes.length;
}
async function sweepFeatureUsage() {
  if (!expiryDb) return { keys: 0 };
  let rc;
  try { rc = await queue.client; } catch { return { keys: 0 }; }
  let keys = 0;
  try {
    const one = async (k) => { try { await flushUsageKey(rc, k); keys++; } catch (e) { log('error', 'usage_key_error', { key: k, message: e.message }); } };
    for (const k of await scanKeys(rc, 'fuf:*')) await one(k);      // dọn lô dở của lần chết trước
    for (const k of await scanKeys(rc, 'fu:*')) {
      const dst = `fuf:${k.slice(3)}`;
      try { await rc.rename(k, dst); } catch { continue; }           // khoá vừa hết hạn/biến mất
      await one(dst);
    }
    await expiryDb.query(`DELETE FROM feature_usage WHERE day < current_date - $1::int`, [USAGE_KEEP_DAYS]);
  } catch (e) {
    log('error', 'usage_sweep_error', { message: e.message });       // không bao giờ throw ra timer
  }
  if (keys) log('info', 'usage_flushed', { keys });
  return { keys };
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
      `UPDATE outbox SET payload = payload - 'link' - 'to' - 'customer_name'
        WHERE processed_at IS NOT NULL
          AND (
            processed_at < now() - interval '7 days'
            OR (
              jsonb_typeof(payload -> 'retry_pii_expires_at_ms') = 'number'
              AND (payload ->> 'retry_pii_expires_at_ms')::numeric
                    <= extract(epoch FROM clock_timestamp()) * 1000
            )
          )
          AND (jsonb_exists(payload, 'link') OR jsonb_exists(payload, 'to') OR jsonb_exists(payload, 'customer_name'))`);
    if (r.rowCount) log('info', 'outbox_gc', { n: r.rowCount });
    return { scrubbed: r.rowCount };
  } catch (e) { log('error', 'outbox_gc_error', { message: e.message }); return { scrubbed: 0 }; }
}

// ── sweep: ẨN DANH PII theo hạn lưu trữ per-shop (0064, Luật BVDLCN 91/2025) ──
// Shop bật shops.pii_retention_months (NULL = tắt, mặc định) → đơn TRẠNG THÁI KẾT THÚC
// cũ hơn N tháng bị gỡ danh tính (tên → sentinel, SĐT/email/địa chỉ/ip_hash → NULL),
// đồng thời bỏ customer_id khỏi đơn; hồ sơ customer chỉ ẩn danh khi không còn đơn trỏ tới.
// Chỉ GHI-ĐÈ — app_expiry cố tình KHÔNG có SELECT trên cột PII (WHERE không đụng chúng).
// Batch 500 × tối đa 20 vòng: shop mới bật với backlog lớn không chạy vô hạn một nhịp.
const PII_SWEEP_MS = Number(process.env.PII_SWEEP_MS ?? 86400000); // 24h
async function sweepPiiRetention() {
  if (!expiryDb) return { anonymized: 0 };
  let total = 0;
  let customerTotal = 0;
  let refTotal = 0;
  try {
    let capped = true;
    for (let round = 0; round < 20; round++) {
      // Đổi order và xử lý customer trong cùng transaction. Nếu tách hai câu lệnh,
      // một đơn mới có thể vừa nối lại customer sau lúc ta kiểm tra "không còn tham chiếu".
      const c = await expiryDb.connect();
      try {
        await c.query('BEGIN');
        const r = await c.query(
          `WITH doomed AS MATERIALIZED (
             SELECT o.id, o.customer_id
               FROM orders o JOIN shops s ON s.id = o.shop_id
              WHERE s.pii_retention_months IS NOT NULL AND o.anonymized_at IS NULL
                AND o.status IN ('delivered','cancelled','refunded','returned')
                AND o.created_at < now() - (s.pii_retention_months || ' months')::interval
              ORDER BY o.created_at LIMIT 500
              FOR UPDATE OF o SKIP LOCKED
           ), changed AS (
             UPDATE orders o
                SET customer_name = '(đã ẩn danh)', customer_phone = NULL,
                    customer_email = NULL, shipping_address = NULL,
                    client_ip_hash = NULL, customer_id = NULL, anonymized_at = now()
               FROM doomed d
              WHERE o.id = d.id
              RETURNING d.customer_id
           )
           SELECT customer_id FROM changed`);
        const batchRows = r.rowCount;
        let batchCustomers = 0;
        let batchRefs = 0;

        const customerIds = [...new Set(r.rows.map((row) => row.customer_id).filter(Boolean))];
        if (customerIds.length) {
          // Khách chỉ được ẩn danh sau khi mọi đơn của họ đã bỏ customer_id. Khoá
          // customer trước khi kiểm tra để một checkout mới không chen vào giữa kiểm tra và cập nhật.
          const eligible = (await c.query(
            `SELECT c.id
               FROM customers c
              WHERE c.id = ANY($1::uuid[])
                AND NOT EXISTS (
                  SELECT 1 FROM orders o
                   WHERE o.shop_id = c.shop_id AND o.customer_id = c.id
                )
              FOR UPDATE`, [customerIds],
          )).rows.map((row) => row.id);
          if (eligible.length) {
            const anonymized = (await c.query(
              `UPDATE customers
                  SET email = NULL, password_hash = NULL, full_name = '(đã ẩn danh)',
                      phone = NULL, status = 'anonymized', anonymized_at = coalesce(anonymized_at, now())
                WHERE id = ANY($1::uuid[])
                RETURNING id`, [eligible],
            )).rows.map((row) => row.id);
            batchCustomers = anonymized.length;
            if (anonymized.length) {
              const refs = await c.query(
                `DELETE FROM integration_entity_refs
                  WHERE entity_type = 'customer' AND local_id = ANY($1::uuid[])`, [anonymized],
              );
              batchRefs = refs.rowCount;
            }
          }
        }
        await c.query('COMMIT');
        total += batchRows;
        customerTotal += batchCustomers;
        refTotal += batchRefs;
        if (batchRows < 500) { capped = false; break; }
      } catch (error) {
        await c.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        c.release();
      }
    }
    // KHÔNG cắt trần im lặng: còn tồn thì phải nhìn thấy trong log (nhịp sau quét tiếp).
    // Ẩn danh PII là nghĩa vụ pháp lý (91/2025) — "đã chạy nhưng chưa xong" phải phân biệt
    // được với "đã xong", nếu không backlog lớn im lìm quá hạn mà không ai biết.
    if (capped) log('warn', 'pii_sweep_capped', { rounds: 20, n: total });
    if (total) log('info', 'pii_sweep', { n: total, customers: customerTotal, refs: refTotal }); // CHỈ đếm — không log PII
  } catch (e) { log('error', 'pii_sweep_error', { message: e.message }); }
  return { anonymized: total };
}

// ── sweep: GC NHÁP SIGNUP TREO (0091) ────────────────────────────────────────
// Nháp pending quá hạn (chưa verify) → chuyển 'expired' (GIẢI PHÓNG slug: UNIQUE partial chỉ WHERE
// pending) → người khác đăng ký lại slug được. GIỮ row (vẫn đếm cho trần per-IP theo giờ). Dọn hẳn
// row 'expired' cũ > 24h (không phình bảng). Provisioned giữ (liên kết signup→shop, audit). Vai
// app_signup (chỉ chạm shop_signups). Nuốt mọi lỗi (không throw ra setInterval).
async function sweepSignups() {
  if (!signupDb) return { expired: 0 };
  let expired = 0;
  try {
    const up = await signupDb.query(`UPDATE shop_signups SET status='expired' WHERE status='pending' AND expires_at < now()`);
    expired = up.rowCount;
    await signupDb.query(`DELETE FROM shop_signups WHERE status='expired' AND created_at < now() - interval '24 hours'`);
    if (expired) log('info', 'signup_drafts_expired', { n: expired }); // KHÔNG log email/slug
  } catch (e) { log('error', 'signup_sweep_error', { message: e.message }); }
  return { expired };
}

// ── sweep: TÍCH ĐIỂM THƯỞNG (0086) ───────────────────────────────────────────
// Choke point DUY NHẤT để tích điểm: quét đơn ĐÃ THANH TOÁN (paid_at) của khách ĐĂNG NHẬP
// (customer_id) đã qua VESTING (paid_at ≤ now − vesting_days) và CHƯA terminal (huỷ/hoàn) →
// đơn hoàn trong cửa sổ vesting KHÔNG bao giờ tích (clawback hiếm). Cơ số = net HÀNG
// (subtotal − discount − points_discount, LOẠI ship + LOẠI phần trả bằng điểm → chống farming
// redeem→earn). Idempotent: UNIQUE loyalty_ledger_earn_once + INSERT ON CONFLICT DO NOTHING
// RETURNING (chỉ cộng cache khi lô THỰC SỰ chèn → không double-count khi sweep chạy đè).
// Kỷ luật chống crash-loop: nuốt mọi lỗi, không throw ra setInterval.
async function sweepLoyaltyEarn() {
  if (!loyaltyDb) return { earned: 0 };
  let total = 0;
  const client = await loyaltyDb.connect();
  try {
    for (let round = 0; round < 20; round++) {
      await client.query('BEGIN');
      // Chọn đơn đủ điều kiện tích điểm > 0 chưa có bút toán earn. KHÔNG dùng FOR UPDATE:
      // app_loyalty chỉ có SELECT theo CỘT (né PII như app_expiry) → row-lock đòi quyền bảng.
      // Idempotency đã có ở UNIQUE loyalty_ledger_earn_once + INSERT ON CONFLICT DO NOTHING
      // RETURNING (hai sweep chồng: chỉ một INSERT thắng, bên kia no-op — không cộng đúp).
      // Chỉ điểm > 0 → đơn nhỏ không lọt vòng quét vô hạn (không thể ghi earn delta=0).
      const rows = (await client.query(
        `SELECT o.id, o.shop_id, o.customer_id, o.paid_at,
                floor(GREATEST(o.subtotal_vnd - o.discount_vnd - o.points_discount_vnd, 0) / 1000.0)::int
                  * c.earn_points_per_1000 AS points
           FROM orders o JOIN shop_loyalty_config c ON c.shop_id = o.shop_id
          WHERE c.enabled = true
            AND o.customer_id IS NOT NULL
            AND o.paid_at IS NOT NULL
            -- Đơn DI CƯ (0104) KHÔNG tích điểm: khách đã mua ở sàn cũ, tặng điểm cho lịch sử
            -- là tự tạo ra một khoản NỢ điểm không có doanh thu nào ở đây đối ứng.
            AND NOT o.is_migrated
            AND o.paid_at <= now() - make_interval(days => c.earn_vesting_days)
            AND o.status NOT IN ('cancelled','refunded','returned')
            AND floor(GREATEST(o.subtotal_vnd - o.discount_vnd - o.points_discount_vnd, 0) / 1000.0)::int
                  * c.earn_points_per_1000 > 0
            AND NOT EXISTS (SELECT 1 FROM loyalty_ledger l
                             WHERE l.shop_id = o.shop_id AND l.order_id = o.id AND l.kind = 'earn')
          ORDER BY o.paid_at LIMIT 500`)).rows;
      if (rows.length === 0) { await client.query('COMMIT'); break; }
      for (const r of rows) {
        const points = Number(r.points);
        // Chèn bút toán earn (idempotent); CHỈ cộng cache khi thực sự chèn (RETURNING).
        const ins = await client.query(
          `INSERT INTO loyalty_ledger (shop_id, customer_id, kind, delta, order_id, reason)
           VALUES ($1, $2, 'earn', $3, $4, 'Tích điểm đơn hàng') ON CONFLICT DO NOTHING RETURNING id`,
          [r.shop_id, r.customer_id, points, r.id]);
        if (ins.rowCount === 1) {
          // Cộng số dư nguyên tử (khoá dòng balances → không lost-update với redeem/clawback).
          await client.query(
            `INSERT INTO loyalty_balances (shop_id, customer_id, balance_points) VALUES ($1, $2, $3)
             ON CONFLICT (shop_id, customer_id)
             DO UPDATE SET balance_points = loyalty_balances.balance_points + $3, updated_at = now()`,
            [r.shop_id, r.customer_id, points]);
          total++;
        }
      }
      await client.query('COMMIT');
      if (rows.length < 500) break;
    }
    if (total) log('info', 'loyalty_earn_sweep', { n: total });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    log('error', 'loyalty_earn_sweep_error', { message: e.message });
  } finally { client.release(); }
  return { earned: total };
}

// ── sweep: THU HỒI ĐIỂM khi đơn HUỶ/HOÀN/TRẢ (0086) ──────────────────────────
// Đơn về TERMINAL (cancelled/refunded/returned = huỷ / hoàn toàn bộ / trả toàn bộ):
//   (A) HOÀN điểm ĐÃ ĐỔI (reversal +): trả lại số điểm khách tiêu trên đơn — ĐỘC LẬP paid_at
//       nên bắt cả đơn CHƯA-thanh-toán bị huỷ mà đã đổi điểm (không để khách mất điểm oan).
//   (B) THU HỒI điểm ĐÃ TÍCH (clawback −): claw TOÀN BỘ điểm đã tích cho đơn (chính xác vì
//       terminal = cả đơn mất) — CÓ THỂ đẩy số dư ÂM = NỢ điểm (earn tương lai bù; redeem
//       đọc balance ≥0 nên không tiêu vào nợ; hiển thị GREATEST(0,·)). Vesting (tích chậm N
//       ngày) đã chặn phần lớn: đơn hoàn TRONG cửa sổ CHƯA tích → không cần clawback.
// Idempotent per-order: UNIQUE reversal_once/clawback_once + INSERT ON CONFLICT RETURNING (một
// sweep DUY NHẤT, không double-clawback). KHÔNG prorate: partial-refund (status còn 'delivered')
// KHÔNG đụng điểm ở v1. Nuốt mọi lỗi, không throw ra setInterval.
async function sweepLoyaltyClawback() {
  if (!loyaltyDb) return { reversed: 0, clawed: 0 };
  let reversed = 0, clawed = 0;
  const client = await loyaltyDb.connect();
  const bumpBalance = (shopId, cid, delta) => client.query(
    `INSERT INTO loyalty_balances (shop_id, customer_id, balance_points) VALUES ($1, $2, $3)
     ON CONFLICT (shop_id, customer_id)
     DO UPDATE SET balance_points = loyalty_balances.balance_points + $3, updated_at = now()`, [shopId, cid, delta]);
  try {
    // (A) Hoàn điểm đã đổi.
    for (let round = 0; round < 20; round++) {
      await client.query('BEGIN');
      const rows = (await client.query(
        `SELECT o.id, o.shop_id, o.customer_id, o.points_redeemed
           FROM orders o
          WHERE o.status IN ('cancelled','refunded','returned')
            AND o.customer_id IS NOT NULL AND o.points_redeemed > 0
            AND NOT EXISTS (SELECT 1 FROM loyalty_ledger l
                             WHERE l.shop_id = o.shop_id AND l.order_id = o.id AND l.kind = 'reversal')
          ORDER BY o.id LIMIT 500`)).rows;
      if (rows.length === 0) { await client.query('COMMIT'); break; }
      for (const r of rows) {
        const pts = Number(r.points_redeemed);
        const ins = await client.query(
          `INSERT INTO loyalty_ledger (shop_id, customer_id, kind, delta, order_id, reason)
           VALUES ($1, $2, 'reversal', $3, $4, 'Hoàn điểm đơn huỷ/hoàn') ON CONFLICT DO NOTHING RETURNING id`,
          [r.shop_id, r.customer_id, pts, r.id]);
        if (ins.rowCount === 1) { await bumpBalance(r.shop_id, r.customer_id, pts); reversed++; }
      }
      await client.query('COMMIT');
      if (rows.length < 500) break;
    }
    // (B) Thu hồi điểm đã tích (full clawback → có thể âm = nợ).
    for (let round = 0; round < 20; round++) {
      await client.query('BEGIN');
      const rows = (await client.query(
        `SELECT o.id, o.shop_id, o.customer_id, e.delta AS earned
           FROM orders o
           JOIN loyalty_ledger e ON e.shop_id = o.shop_id AND e.order_id = o.id AND e.kind = 'earn'
          WHERE o.status IN ('cancelled','refunded','returned')
            AND NOT EXISTS (SELECT 1 FROM loyalty_ledger l
                             WHERE l.shop_id = o.shop_id AND l.order_id = o.id AND l.kind = 'clawback')
          ORDER BY o.id LIMIT 500`)).rows;
      if (rows.length === 0) { await client.query('COMMIT'); break; }
      for (const r of rows) {
        const earned = Number(r.earned);
        const ins = await client.query(
          `INSERT INTO loyalty_ledger (shop_id, customer_id, kind, delta, order_id, reason)
           VALUES ($1, $2, 'clawback', $3, $4, 'Thu hồi điểm đơn huỷ/hoàn') ON CONFLICT DO NOTHING RETURNING id`,
          [r.shop_id, r.customer_id, -earned, r.id]);
        if (ins.rowCount === 1) { await bumpBalance(r.shop_id, r.customer_id, -earned); clawed++; }
      }
      await client.query('COMMIT');
      if (rows.length < 500) break;
    }
    if (reversed || clawed) log('info', 'loyalty_clawback_sweep', { reversed, clawed });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    log('error', 'loyalty_clawback_sweep_error', { message: e.message });
  } finally { client.release(); }
  return { reversed, clawed };
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
  // DỌN mã liên kết HẾT HẠN (0069) — kể cả mã đời cũ không có hạn (NULL, trước 0069):
  // xoá link_code để deep-link cũ/lộ CHẾT HẲN. Chạy TRƯỚC getUpdates (Telegram API sập
  // vẫn dọn được). Mã lộ chỉ sống tối đa 30' + 1 nhịp sweep (~15s).
  try {
    const gc = await expiryDb.query(
      `UPDATE shop_telegram SET link_code = NULL, link_code_expires_at = NULL
        WHERE link_code IS NOT NULL AND (link_code_expires_at IS NULL OR link_code_expires_at <= now())`);
    if (gc.rowCount) log('info', 'tg_link_expired_cleared', { n: gc.rowCount });
  } catch (e) { log('error', 'tg_link_gc_error', { message: e.message }); }
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
      // Bind CHỈ khi mã CÒN HẠN (0069) — mã hết hạn/đời cũ (NULL) rơi xuống nhánh "mã không
      // đúng" bên dưới → người dùng được nhắc tạo mã mới trong admin.
      const upd = await expiryDb.query(
        `UPDATE shop_telegram SET chat_id = $2, linked_at = now(), link_code = NULL, link_code_expires_at = NULL
          WHERE link_code = $1 AND link_code_expires_at > now() RETURNING shop_id`,
        [mm[1], String(chat)]);
      if (upd.rowCount === 1) { bound++; await tgSend(String(chat), '✅ Đã kết nối! Cửa hàng của bạn sẽ nhận thông báo đơn hàng + vận hành tại đây.'); }
      else await tgSend(String(chat), 'Mã liên kết không đúng, đã dùng hoặc đã hết hạn (mã chỉ sống 30 phút). Vào lại trang Thông báo trong admin để tạo mã mới.');
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
  if (topic === 'order.status_changed' && p.status === 'returned') return `↩️ Đơn #${p.order_number} bị HOÀN (bom hàng) — hàng đang về cửa hàng. Nhận lại hàng rồi cập nhật tồn kho (Điều chỉnh tồn).`;
  if (topic === 'order.resolution_required') return `⚠️ Đơn #${p.order_number} có kiện giao thành công và kiện bị hoàn. Mở quản trị để chọn cách xử lý, tránh bỏ sót tiền hoặc hàng.`;
  if (topic === 'stock.low') return `📦 ${p.items?.length ?? 0} sản phẩm SẮP HẾT HÀNG (còn ≤ ${p.threshold}). Kiểm kho + nhập thêm.`;
  // Phiếu hỗ trợ đã xử (0108): người bán đang CHỜ tin này, nên Telegram tới ngay là đúng —
  // không bắt họ phải mở email hay đoán xem đã tới lượt mình chưa.
  if (topic === 'support.ticket_resolved') return `✅ Yêu cầu hỗ trợ "${p.subject ?? ''}" đã được xử lý.${p.note ? `\n${p.note}` : ''}`;
  if (topic === 'subscription.reminder') {
    // Thiếu nhánh này = nửa Telegram của dunning âm thầm TẮT (return null bên dưới).
    const plan = p.plan_name || p.plan_code || '';
    const d = new Date(p.period_end).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    return p.milestone === 'past_due'
      ? `🔴 Thuê bao (gói ${plan}) ĐÃ QUÁ HẠN — còn ${p.grace_days_left} ngày ân hạn trước khi website TẠM NGƯNG. Liên hệ ${BILLING_CONTACT} để gia hạn ngay.`
      : `⏰ ${p.sub_status === 'trial' ? `Dùng thử (gói ${plan})` : `Gói ${plan}`} sắp hết hạn — còn ${p.days_left} ngày (đến ${d}). Liên hệ ${BILLING_CONTACT} để gia hạn.`;
  }
  return null;
}
async function deliverTelegram(topic, payload, shopId, outboxId) {
  if (!TELEGRAM_ON || !expiryDb || !shopId) return { status: 'skipped' };
  const text = tgMessageFor(topic, payload);
  if (!text) return { status: 'skipped' };
  // DEDUP theo outboxId: consumer chạy Telegram TRƯỚC email; nếu email lỗi → job retry →
  // consumer chạy lại → KHÔNG gửi Telegram TRÙNG. Đánh dấu SAU khi gửi thành công (lỗi gửi
  // tạm thời vẫn được thử lại qua vòng retry của email). db/queue Redis dùng chung.
  const rc = outboxId ? await queue.client : null;
  if (rc && (await rc.get(`tgsent:${outboxId}`))) return { status: 'accepted' };
  const row = (await expiryDb.query(`SELECT chat_id FROM shop_telegram WHERE shop_id = $1 AND enabled AND chat_id IS NOT NULL`, [shopId])).rows[0];
  if (!row?.chat_id) return { status: 'skipped' };
  const sent = await tgSend(row.chat_id, text);
  if (!sent) throw new Error('telegram không nhận thông báo');
  if (rc) await rc.set(`tgsent:${outboxId}`, '1', 'EX', 86400);
  return { status: 'accepted' };
}

// ── sweep: SLA ĐƠN Ứ — digest Telegram cho shop có đơn ứ đọng ────────────────
// (a) đơn 'pending' quá STALE_PENDING_HOURS (24h) — shop quên xác nhận (QR pending tự huỷ
//     sau 30' nên tồn >24h thực tế là COD chờ shop); (b) đơn 'shipped' quá STALE_SHIPPED_DAYS
//     (7 ngày) chưa delivered/returned — kẹt ở hãng VC / shop quên chốt giao.
// Mốc "đã gửi hãng" = max(shipments.created_at) của đơn (mọi đường ship đều tạo/chốt dòng
// shipments cùng lúc UPDATE orders → xấp xỉ shipped_at; app_expiry CỐ Ý không có quyền đọc
// orders.shipped_at — 0022/0044 cấp cột tường minh, và ngưỡng NGÀY không cần chính xác phút).
// Digest MỘT tin/shop/NGÀY (giờ VN): dedup Redis key tgstale:<shop>:<ngày>, GIỮ CHỖ bằng
// `SET NX` TRƯỚC khi gửi (không phải đánh dấu sau) — xem chú thích tại chỗ ở vòng lặp dưới.
// Gửi TRỰC TIẾP qua tgSend như sweepMoneyAlerts, KHÔNG qua outbox: đây là digest phái sinh từ
// trạng thái DB hiện có, không phải sự kiện nghiệp vụ mới (ADR-006 dành cho sự kiện phát
// trong transaction).
//
// ⚠️ tgDeliver (`tgsent:<outboxId>`) VẪN theo mẫu cũ đọc-rồi-ghi-sau và mang ĐÚNG lớp lỗi
// này. Chưa đổi vì chưa có ca thử nào chứng minh nó vỡ: BullMQ giao mỗi job cho một consumer
// nên hai lượt gửi cùng một outboxId hiếm khi chồng nhau, khác hẳn hai sweep cùng quét TOÀN BỘ
// shop. Sửa mù khi không có test đỏ là đổi mã theo niềm tin — sửa khi dựng được ca thử.
const STALE_PENDING_HOURS = Number(process.env.STALE_PENDING_HOURS ?? 24);
const STALE_SHIPPED_DAYS = Number(process.env.STALE_SHIPPED_DAYS ?? 7);
const STALE_SWEEP_MS = Number(process.env.STALE_SWEEP_MS ?? 300000); // 5 phút — nhịp như alert-sweep
// Trần đặt trên SHOP, không trên ĐƠN — cùng bài học "đói quét" của nhắc hạn thuê bao: bản
// đầu lấy 500 ĐƠN ứ toàn nền tảng rồi mới gộp theo shop, nên 1000 shop mỗi shop vài đơn ứ
// thì chỉ ~250 shop đầu (theo thứ tự uuid) nhận cảnh báo, phần còn lại KHÔNG BAO GIỜ nhận —
// mỗi ngày, vĩnh viễn. Gộp trong SQL (một dòng/shop) + duyệt keyset theo shop_id: số đếm
// cũng thành ĐÚNG (trước đây bị chính LIMIT cắt cụt → "12 đơn ứ" trong khi thực tế 600).
const STALE_SHOP_BATCH = 200;
const STALE_ROUNDS = 20; // 20 × 200 = 4.000 shop/nhịp; chạm trần thì LOG, nhịp sau quét tiếp
const STALE_SQL =
  `SELECT shop_id,
          count(*) FILTER (WHERE kind = 'pending')::int AS n_pending,
          (array_agg(order_number ORDER BY created_at) FILTER (WHERE kind = 'pending'))[1:5] AS few_pending,
          count(*) FILTER (WHERE kind = 'shipped')::int AS n_shipped,
          (array_agg(order_number ORDER BY created_at) FILTER (WHERE kind = 'shipped'))[1:5] AS few_shipped
     FROM (
       SELECT shop_id, order_number, created_at, 'pending'::text AS kind FROM orders
        WHERE status = 'pending' AND created_at < now() - ($1 || ' hours')::interval
       UNION ALL
       SELECT o.shop_id, o.order_number, o.created_at, 'shipped' FROM orders o
        WHERE o.status = 'shipped'
          -- BỎ vận đơn đã huỷ khỏi mốc "đã gửi hãng". max() trên MỌI dòng cho phép một claim
          -- chết tạo hôm nay (hoặc dòng bị 'orphan' khi shop đổi/ngắt hãng) kéo mốc về hiện
          -- tại → đơn gửi 10 ngày trước KHÔNG BAO GIỜ lọt digest "đơn ứ". Tức là chính lớp
          -- cảnh báo sinh ra để cứu đơn kẹt lại bị đơn kẹt nhất làm mù.
          AND coalesce((SELECT max(s.created_at) FROM shipments s
                         WHERE s.order_id = o.id AND s.status <> 'cancelled'), o.created_at)
              < now() - ($2 || ' days')::interval
     ) t
    WHERE shop_id > $3
    GROUP BY shop_id ORDER BY shop_id LIMIT $4`;
async function sweepStaleOrders() {
  if (!expiryDb || !TELEGRAM_ON) return { shops: 0, pending: 0, shipped: 0 };
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }); // YYYY-MM-DD giờ VN
  const firstFew = (a, n) => a.map((x) => `#${Number(x)}`).join(', ') + (n > a.length ? '…' : '');
  let sent = 0, pending = 0, shipped = 0;
  let after = '00000000-0000-0000-0000-000000000000';
  for (let round = 1; ; round++) {
    let rows;
    try {
      rows = (await expiryDb.query(STALE_SQL,
        [String(STALE_PENDING_HOURS), String(STALE_SHIPPED_DAYS), after, STALE_SHOP_BATCH])).rows;
    } catch (e) { log('error', 'stale_query_error', { message: e.message }); break; }
    if (rows.length === 0) break;
    after = rows[rows.length - 1].shop_id; // keyset: nhịp sau bắt đầu SAU shop cuối lô này
    for (const g of rows) {
      pending += g.n_pending; shipped += g.n_shipped;
      try {
        const rc = await queue.client;
        const key = `tgstale:${g.shop_id}:${day}`;
        // GIỮ CHỖ NGUYÊN TỬ trước khi gửi, KHÔNG phải đọc-rồi-ghi-sau.
        //
        // Bản trước làm `get(key)` → tgSend → `set(key)`, nên cửa sổ chạy đua dài bằng CẢ MỘT
        // LỜI GỌI MẠNG tới Telegram: hai sweep chồng nhịp cùng trượt `get`, cùng gửi, và chủ
        // shop nhận HAI tin y hệt. `SET NX` gộp đọc và ghi thành một thao tác Redis duy nhất
        // nên chỉ một sweep giành được.
        //
        // ĐO ĐƯỢC (e2e "digest đơn ứ ... khi hai sweep chạy đồng thời"): lỗi chỉ lộ khi DB dev
        // tích tới 4370 shop — vòng sweep (200 shop × 20 lượt) kéo dài đủ để hai nhịp 5 phút
        // chồng lên nhau. DB sạch thì nó XANH mà lỗi VẪN CÒN; dọn dữ liệu để test qua là giấu
        // lỗi chứ không phải sửa. Bộ e2e ngay sau đó ("re-sweep → KHÔNG digest trùng") vẫn xanh
        // suốt vì nó chạy TUẦN TỰ — dedup tuần tự chưa bao giờ hỏng, chỉ đồng thời mới vỡ.
        //
        // TTL hai pha. Pha giữ chỗ để NGẮN (5'): worker chết giữa chừng thì chỗ tự nhả và nhịp
        // sau gửi lại, thay vì khoá shop này im lặng suốt 26 giờ vì một lần crash.
        const claimed = await rc.set(key, 'claim', 'EX', 300, 'NX');
        if (!claimed) continue; // sweep khác đang gửi (hoặc đã gửi) cho shop này hôm nay
        const row = (await expiryDb.query(`SELECT chat_id FROM shop_telegram WHERE shop_id = $1 AND enabled AND chat_id IS NOT NULL`, [g.shop_id])).rows[0];
        // NHẢ chỗ: "chưa nối Telegram" không phải "đã gửi". Giữ nguyên thì shop vừa nối kênh
        // lúc chiều sẽ không nhận digest nào cho tới ngày hôm sau.
        if (!row?.chat_id) { await rc.del(key); continue; }
        const parts = [];
        if (g.n_pending) parts.push(`${g.n_pending} đơn chờ xử lý >${STALE_PENDING_HOURS}h (${firstFew(g.few_pending ?? [], g.n_pending)})`);
        if (g.n_shipped) parts.push(`${g.n_shipped} đơn gửi hãng >${STALE_SHIPPED_DAYS} ngày chưa giao (${firstFew(g.few_shipped ?? [], g.n_shipped)})`);
        const okSent = await tgSend(row.chat_id, `⏳ Đơn ứ: ${parts.join(', ')}. Vào trang quản trị xử lý sớm để không mất khách.`);
        // Gửi XONG mới nâng lên 26h (>1 ngày — key tự rơi sang hôm sau). Gửi HỎNG thì nhả chỗ,
        // giữ đúng chủ ý bản cũ: lỗi tạm thời được thử lại ở nhịp sau chứ không mất luôn ngày.
        if (okSent) { sent++; await rc.set(key, '1', 'EX', 26 * 3600); }
        else await rc.del(key);
      } catch (e) { log('error', 'stale_digest_error', { message: e.message }); }
    }
    if (rows.length < STALE_SHOP_BATCH) break;
    if (round >= STALE_ROUNDS) { log('warn', 'stale_sweep_capped', { rounds: round, shops: sent }); break; }
  }
  if (sent) log('info', 'stale_order_digests', { shops: sent, pending, shipped });
  return { shops: sent, pending, shipped };
}

const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL ?? '';
const ALERT_SWEEP_MS = Number(process.env.ALERT_SWEEP_MS ?? 300000);      // 5 phút
const ALERT_REPEAT_MS = Number(process.env.ALERT_REPEAT_MS ?? 3600000);   // nhắc lại mỗi 1h nếu còn
const ALERT_UNMATCHED_MAX = Number(process.env.ALERT_UNMATCHED_MAX ?? 1); // ≥N giao dịch chưa khớp >1h
const ALERT_SIGNUP_SWALLOW_MAX = Number(process.env.ALERT_SIGNUP_SWALLOW_MAX ?? 20); // ≥N lần nuốt đăng ký/giờ
const NUDGE_AFTER_HOURS = Number(process.env.NUDGE_AFTER_HOURS ?? 48);      // nhắc sau N giờ kể từ khi mở shop
const NUDGE_SWEEP_MS = Number(process.env.NUDGE_SWEEP_MS ?? 3600000);       // quét mỗi 1h (việc không gấp)
// Link về trang quản trị trong email nhắc. Không đặt ⇒ email vẫn gửi, chỉ bỏ nút bấm —
// KHÔNG được để một biến thiếu làm hỏng cả email (xem cách nó suýt hỏng: tôi viết
// ADMIN_LOGIN_URL không tồn tại, ReferenceError rơi vào catch và biến thành log lỗi câm).
const ADMIN_URL = (process.env.ADMIN_URL ?? '').replace(/\/+$/, '');
const ALERT_OUTBOX_MAX = Number(process.env.ALERT_OUTBOX_MAX ?? 20);      // ≥N email tồn >10'
const ALERT_EMAIL_FAIL_MAX = Number(process.env.ALERT_EMAIL_FAIL_MAX ?? 5);
// Dead-man's switch: ping URL này mỗi nhịp alert-sweep — im lặng → monitor NGOÀI báo động.
// Cần vì sweepMoneyAlerts chạy TRONG chính worker + dùng CHÍNH DB nó giám sát: worker
// chết/treo thì nó không tự báo được. Trống = tắt.
const WORKER_HEARTBEAT_URL = process.env.WORKER_HEARTBEAT_URL ?? '';
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
  const m = { unmatched_open: 0, unmatched_old: 0, plat_unmatched_open: 0, outbox_backlog: 0, email_failed: 0 };
  if (expiryDb) {
    try {
      const r = (await expiryDb.query(`SELECT
        count(*) FILTER (WHERE resolved_at IS NULL)::int AS open,
        count(*) FILTER (WHERE resolved_at IS NULL AND created_at < now() - interval '1 hour')::int AS old
        FROM unmatched_transfers`)).rows[0];
      m.unmatched_open = r.open; m.unmatched_old = r.old;
    } catch (e) { log('error', 'alert_unmatched_error', { message: e.message }); }
    // Tiền SHOP TRẢ CHO NỀN TẢNG không khớp (0135). Đếm RIÊNG vì hậu quả khác hẳn: tiền
    // khách trả shop lạc thì shop tự đối soát được; tiền này lạc thì shop đã trả rồi vẫn bị
    // KHOÁ sau 7 ngày ân hạn, và chỉ người vận hành nền tảng gỡ được. NGƯỠNG 1 — một dòng
    // đã là một shop đang mất tiền oan, không có "mức nhiễu chấp nhận được".
    try {
      m.plat_unmatched_open = Number((await expiryDb.query(
        `SELECT count(*)::int n FROM platform_unmatched_transfers WHERE resolved_at IS NULL`)).rows[0].n);
    } catch (e) { log('error', 'alert_plat_unmatched_error', { message: e.message }); }
  }
  try {
    m.outbox_backlog = Number((await db.query(
      `SELECT count(*)::int n FROM outbox WHERE processed_at IS NULL AND created_at < now() - interval '10 minutes'`)).rows[0].n);
  } catch (e) { log('error', 'alert_outbox_error', { message: e.message }); }
  // Đếm failed HIỆN CÓ trong Redis. removeOnFail giữ 7 ngày/1000 job (poll()) — dài hơn
  // rất nhiều cửa sổ quét 5' + ALERT_REPEAT_MS 1h, nên trần retention KHÔNG làm lọt cảnh báo.
  try { m.email_failed = Number((await queue.getJobCounts('failed')).failed ?? 0); } catch {}
  // Đăng ký bị NUỐT IM LẶNG (signup ghi counter Redis, khoá sống 1 giờ). Nuốt là hành vi ĐÚNG
  // với bot, nên ngưỡng cao và thông điệp TÁCH THEO LÝ DO: 'honeypot ×200' là bot đập cửa —
  // bình thường; 'tran_ip_gio ×25' hay 'gui_qua_nhanh ×25' là hàng rào đang chặn NGƯỜI THẬT,
  // và đó mới là thứ ta không có cách nào khác để nhìn thấy (docs/43).
  m.swallow_by = {};
  try {
    const rc = await queue.client;
    let cur = '0';
    do {
      const [next, keys] = await rc.scan(cur, 'MATCH', 'swallow:*', 'COUNT', 200);
      cur = next;
      for (const k of keys) m.swallow_by[k.slice('swallow:'.length)] = Number(await rc.get(k)) || 0;
    } while (cur !== '0');
  } catch (e) { log('error', 'alert_swallow_error', { message: e.message }); }
  m.swallow_total = Object.values(m.swallow_by).reduce((a, b) => a + b, 0);

  const breaches = [];
  if (m.unmatched_old >= ALERT_UNMATCHED_MAX) breaches.push(`${m.unmatched_old} giao dịch tiền CHƯA KHỚP quá 1h (tiền về nhưng chưa vào đơn — kiểm hàng đợi đối soát)`);
  // NGƯỠNG 1, KHÔNG chờ 1 tiếng như tiền-khách: mỗi dòng ở đây là một shop đã chuyển tiền
  // thuê bao mà hệ thống không ghi nhận — để lâu là shop bị khoá oan sau ân hạn (0135).
  if (m.plat_unmatched_open >= 1) breaches.push(`${m.plat_unmatched_open} khoản SHOP TRẢ NỀN TẢNG chưa khớp (tiền đã về tài khoản nhưng KHÔNG vào hoá đơn nào — shop sẽ bị khoá oan)`);
  if (m.outbox_backlog >= ALERT_OUTBOX_MAX) breaches.push(`${m.outbox_backlog} email TỒN ĐỌNG >10' (worker gửi mail có thể đang kẹt)`);
  if (m.email_failed >= ALERT_EMAIL_FAIL_MAX) breaches.push(`${m.email_failed} email gửi THẤT BẠI (dead-letter)`);
  if (m.swallow_total >= ALERT_SIGNUP_SWALLOW_MAX) {
    const chiTiet = Object.entries(m.swallow_by).sort((x, y) => y[1] - x[1])
      .map(([r, n]) => `${r} ×${n}`).join(', ');
    breaches.push(`${m.swallow_total} lượt ĐĂNG KÝ bị chặn im lặng trong ~1h (${chiTiet})`);
  }

  const state = breaches.join(' | ');
  const now = Date.now();
  if (state && (state !== lastAlertState || now - lastAlertAt > ALERT_REPEAT_MS)) {
    const sent = await postAlert(`⚠ NỀN TẢNG — cảnh báo vận hành:\n- ${breaches.join('\n- ')}`, m, 'warning');
    if (sent) { lastAlertState = state; lastAlertAt = now; }
    log('warn', 'ops_alert', { breaches: breaches.length, metrics: m, sent });
    // Cảnh báo tiền nổ mà KHÔNG có kênh nào nhận = cảnh báo đó biến mất. Trước đây chỉ
    // có cờ `sent: false` lẫn trong một dòng warn — đọc lại log sau sự cố thì mới thấy.
    // Sự-cố-không-ai-biết nguy hiểm hơn chính sự cố, nên nó phải là ERROR và phải nói
    // rõ cần cắm biến nào. Không in giá trị biến nào (chúng là bí mật).
    if (!sent) {
      log('error', 'ops_alert_undeliverable', {
        breaches, hint: 'Chưa cấu hình kênh nhận cảnh báo. Đặt TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID, hoặc ALERT_WEBHOOK_URL.',
      });
    }
  } else if (!state && lastAlertState) {
    await postAlert('✓ NỀN TẢNG — các cảnh báo vận hành đã hết.', m, 'ok');
    lastAlertState = ''; lastAlertAt = 0;
    log('info', 'ops_alert_cleared', {});
  }
  // Dead-man's switch: chạy tới đây = worker CÒN SỐNG + timer còn quay (các query trên
  // đều có try/catch riêng nên heartbeat vẫn bắn kể cả khi DB lỗi — nó đo SỰ SỐNG của
  // vòng lặp, không đo nội dung cảnh báo). Nuốt mọi lỗi + timeout 5s: KHÔNG được để
  // throw lọt ra setInterval (kỷ luật chống crash-loop của file này).
  if (WORKER_HEARTBEAT_URL) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 5000);
    try { await fetch(WORKER_HEARTBEAT_URL, { method: 'POST', signal: ac.signal }); }
    catch (e) { log('warn', 'heartbeat_ping_failed', { message: e.message }); }
    finally { clearTimeout(t); }
  }
  // Trả cả DANH SÁCH chuỗi cảnh báo, không chỉ số đếm: nội dung mới là thứ đáng kiểm.
  // Vd cảnh báo nuốt đăng ký chỉ có ích khi nó TÁCH THEO LÝ DO — 'honeypot ×200' (bot, bình
  // thường) khác hẳn 'tran_ip_gio ×25' (hàng rào đang chặn người thật). Đếm được 1 cảnh báo
  // mà không biết nó nói gì thì test chỉ chứng minh có-thứ-gì-đó nổ.
  return { metrics: m, breaches: breaches.length, breach_list: breaches };
}

const timer = setInterval(poll, POLL_MS);
const integrationReconcileTimer = integrationDb ? setInterval(sweepIntegrationReconcile, INTEGRATION_RECONCILE_MS) : null;

// ── sweep: NHẮC MỘT LẦN người bán chưa đăng sản phẩm nào (0110) ───────────────
// Sau khi xác minh email, người bán không nhận thêm gì cho tới lúc thuê bao sắp hết hạn —
// nền tảng im lặng đúng lúc họ cần được dắt nhất. Đây là email DUY NHẤT ta gửi cho họ ở giai
// đoạn đó, nên nó phải đáng: nói rõ shop đã sống ở địa chỉ nào và việc kế tiếp là gì.
//
// ĐÚNG MỘT LẦN, không phải chuỗi nhắc: tên miền gửi thư còn mới. Nhắc nhiều lần vào hộp thư
// người chưa từng tương tác là cách nhanh nhất để vào spam — và khi đó MỌI email khác của nền
// tảng (xác nhận đơn, đặt lại mật khẩu) cùng chết theo.
async function sweepOnboardingNudge() {
  if (!expiryDb) return { sent: 0, flagged: 0 };
  // TRƯỚC KHI NHẮC: cập nhật cờ first_product_at (0112) cho shop đã đăng hàng. Console nền
  // tảng đọc cờ này thay vì đếm bảng products — app_platform cố tình không có quyền ở đó.
  // Lấy min(created_at) THẬT chứ không phải lúc phát hiện: cùng công sức mà không nói dối về
  // thời điểm. Chạy trước phần nhắc để một shop vừa đăng hàng không bị nhắc oan ở cùng nhịp.
  let flagged = 0;
  try {
    flagged = (await expiryDb.query(`
      UPDATE shops s SET first_product_at = p.dau_tien
        FROM (SELECT shop_id, min(created_at) AS dau_tien FROM products
               WHERE deleted_at IS NULL GROUP BY shop_id) p
       WHERE p.shop_id = s.id AND s.first_product_at IS NULL AND s.deleted_at IS NULL`)).rowCount;
  } catch (e) { log('error', 'first_product_flag_error', { message: e.message }); }

  let rows;
  try {
    // Điều kiện "chưa có SP nào" đọc bảng products — app_expiry đã có quyền (0050 low stock).
    // KHÔNG nhắc shop suspended/terminated: họ hết cửa rồi, nhắc thêm là vô duyên.
    rows = (await expiryDb.query(`
      SELECT s.id, s.name, s.contact_email
        FROM shops s
       WHERE s.onboarding_nudged_at IS NULL
         AND s.deleted_at IS NULL
         AND s.status IN ('onboarding', 'active')
         AND s.contact_email IS NOT NULL
         AND s.created_at < now() - ($1 || ' hours')::interval
         AND s.first_product_at IS NULL
       ORDER BY s.created_at
       LIMIT 50`, [String(NUDGE_AFTER_HOURS)])).rows;
  } catch (e) { log('error', 'nudge_query_error', { message: e.message }); return { sent: 0 }; }

  let sent = 0;
  for (const r of rows) {
    let c;
    try {
      c = await expiryDb.connect();
      await c.query('BEGIN');
      // CHIẾM QUYỀN TRƯỚC rồi mới ghi outbox, cùng một transaction: hai worker chạy song song
      // thì chỉ một cái lấy được dòng, và tx hỏng thì dấu-đã-gửi hoàn nguyên cùng outbox.
      // Không có cửa nào gửi hai lần, cũng không có cửa nào đánh dấu mà quên gửi.
      const claimed = await c.query(
        `UPDATE shops SET onboarding_nudged_at = now() WHERE id = $1 AND onboarding_nudged_at IS NULL`, [r.id]);
      if (claimed.rowCount === 1) {
        await c.query(`INSERT INTO outbox (shop_id, topic, payload) VALUES ($1, 'shop.onboarding_nudge', $2)`,
          [r.id, { to: r.contact_email, shop_name: r.name, admin_url: ADMIN_URL || null }]);
        sent++;
      }
      await c.query('COMMIT');
    } catch (e) {
      await c?.query('ROLLBACK').catch(() => {});
      log('error', 'nudge_send_error', { message: e.message });
    } finally { c?.release(); }
  }
  if (sent || flagged) log('info', 'onboarding_nudge', { sent, flagged });
  return { sent, flagged };
}

const expiryTimer = expiryDb ? setInterval(sweepExpired, EXPIRY_SWEEP_MS) : null;
const nudgeTimer = expiryDb ? setInterval(sweepOnboardingNudge, NUDGE_SWEEP_MS) : null;
const lowstockTimer = expiryDb ? setInterval(sweepLowStock, LOWSTOCK_SWEEP_MS) : null;
const prodStatsTimer = expiryDb ? setInterval(sweepProductStats, PRODSTATS_SWEEP_MS) : null;
const prodViewTimer = expiryDb ? setInterval(sweepProductViews, PRODVIEW_SWEEP_MS) : null;
const usageTimer = expiryDb ? setInterval(sweepFeatureUsage, USAGE_SWEEP_MS) : null;
const revImgTimer = expiryDb ? setInterval(sweepReviewImages, REVIMG_GC_MS) : null;
const outboxGcTimer = setInterval(sweepOutboxGc, OUTBOX_GC_MS);
const alertTimer = setInterval(sweepMoneyAlerts, ALERT_SWEEP_MS);
const tgLinkTimer = (TELEGRAM_ON && expiryDb) ? setInterval(sweepTelegramLink, TELEGRAM_LINK_SWEEP_MS) : null;
const domainTimer = domainDb ? setInterval(sweepDomainVerify, DOMAINVERIFY_SWEEP_MS) : null;
const billingTimer = billingDb ? setInterval(sweepSubscriptions, SUBSCRIPTION_SWEEP_MS) : null;
// Áp dụng tiền đã về chạy NHANH hơn nhịp vòng đời thuê bao: shop vừa chuyển khoản xong
// mà phải chờ tới nhịp sau mới mở lại là một ca hỗ trợ ('tôi trả rồi mà vẫn khoá').
const billingApplyTimer = billingDb ? setInterval(sweepBillingApply, Number(process.env.BILLING_APPLY_MS ?? 30000)) : null;
const billingEnforceTimer = billingDb ? setInterval(sweepBillingEnforce, SUBSCRIPTION_SWEEP_MS) : null;
const trackingTimer = (expiryDb && TRACKING_ON) ? setInterval(sweepTracking, TRACKING_SWEEP_MS) : null;
// Hoa hồng CTV: nhịp thưa được — hạn giữ tính bằng NGÀY, chậm vài phút không ai thấy.
const affiliateTimer = affiliateDb ? setInterval(sweepAffiliateCommissions, Number(process.env.AFFILIATE_SWEEP_MS ?? 300000)) : null;
const piiTimer = expiryDb ? setInterval(sweepPiiRetention, PII_SWEEP_MS) : null;
// Dọn phiên Messenger đi cùng nhịp với quét PII — cùng loại việc (xoá dữ liệu cá nhân
// hết mục đích), không cần thêm một nhịp riêng cho vài trăm dòng mỗi ngày.
const messengerGcTimer = expiryDb ? setInterval(sweepMessengerSessions, PII_SWEEP_MS) : null;
const staleTimer = (expiryDb && TELEGRAM_ON) ? setInterval(sweepStaleOrders, STALE_SWEEP_MS) : null;
const loyaltyEarnTimer = loyaltyDb ? setInterval(sweepLoyaltyEarn, LOYALTY_SWEEP_MS) : null;
const loyaltyClawTimer = loyaltyDb ? setInterval(sweepLoyaltyClawback, LOYALTY_SWEEP_MS) : null;
const signupTimer = signupDb ? setInterval(sweepSignups, SIGNUP_SWEEP_MS) : null;
// Tải ảnh nhập-di-cư (0106): dùng pool app_expiry như các sweep chéo shop khác.
const mediaFetchTimer = expiryDb ? setInterval(sweepMediaFetch, MEDIAFETCH_MS) : null;

// ── HTTP: health + stats (cho e2e kiểm dead-letter) ──────────────────────────
const server = http.createServer((req, res) => runReq(req, res, async () => {
  const url = new URL(req.url, 'http://internal');
  if (await health(url.pathname, res, { db: () => db.query('SELECT 1'), redis: async () => (await queue.client).ping() })) return;
  // Đã cắm đủ dây vận hành chưa. CHỈ boolean + tên biến cần đặt — không trả giá trị
  // nào, vì đây là token/URL bí mật. Nội bộ mạng trong như /stats (Caddy không route).
  if (url.pathname === '/internal/readiness' && req.method === 'GET') {
    const r = opsReadiness();
    res.writeHead(r.ready ? 200 : 503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  if (url.pathname === '/stats') {
    const counts = await queue.getJobCounts('completed', 'failed', 'active', 'waiting', 'delayed');
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(counts));
  }
  // Soi email DEAD-LETTER (audit #48): 20 job failed gần nhất + tổng — để vận hành biết
  // "kẹt email vì gì" (SMTP sai? relay từ chối?). Nội bộ mạng trong như /stats (không route Caddy).
  if (url.pathname === '/internal/dead-letters' && req.method === 'GET') {
    const [counts, jobs] = await Promise.all([queue.getJobCounts('failed'), queue.getFailed(0, 19)]);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      count: Number(counts.failed ?? 0),
      recent: jobs.map((j) => ({
        id: j.id, name: j.name,
        failedReason: safeDeliveryError(j.failedReason).slice(0, 300), // không trả PII/secret từ relay
        attemptsMade: j.attemptsMade, timestamp: j.timestamp,
      })),
    }));
  }
  // Retry TOÀN BỘ dead-letter (sau khi sửa SMTP/relay): đưa job failed về 'waiting' để
  // consumer gửi lại. BullMQ v5: Queue#retryJobs xử lý theo lô (Lua) — không kéo từng job.
  if (url.pathname === '/internal/dead-letters/retry' && req.method === 'POST') {
    const failedJobs = await queue.getFailed(0, -1);
    const before = failedJobs.length;
    const outboxIds = failedJobs
      .map((j) => /^ob-(\d+)$/.exec(String(j.id ?? ''))?.[1])
      .filter(Boolean);
    // Delivery 'failed' là terminal để replay job ngẫu nhiên không gửi trùng. Endpoint vận hành này
    // mở lại ĐÚNG các kênh của outbox đang nằm trong BullMQ dead-letter trước khi đưa job về waiting.
    if (outboxIds.length) {
      await db.query(
        `UPDATE notification_deliveries
            SET status = 'retrying', failed_at = NULL, updated_at = now()
          WHERE status = 'failed' AND outbox_id = ANY($1::bigint[])`,
        [outboxIds],
      );
    }
    try {
      await queue.retryJobs({ state: 'failed' });
    } catch (e) {
      if (outboxIds.length) {
        await db.query(
          `UPDATE notification_deliveries
              SET status = 'failed', failed_at = coalesce(failed_at, now()), updated_at = now()
            WHERE status = 'retrying' AND outbox_id = ANY($1::bigint[])`,
          [outboxIds],
        ).catch(() => {});
      }
      throw e;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ retried: before }));
  }
  // Kích hoạt quét hết hạn ngay (nội bộ — không route qua Caddy; idempotent, vô hại).
  // Cho phép cron ngoài gọi đúng lịch, và để e2e kiểm chứng xác định.
  if (url.pathname === '/internal/expire-sweep' && req.method === 'POST') {
    const n = await sweepExpired();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ expired: n }));
  }
  // Áp dụng tiền thuê bao đã về + cưỡng chế hết hạn ngay (nội bộ — cho cron + e2e xác định).
  if (url.pathname === '/internal/billing-sweep' && req.method === 'POST') {
    const applied = await sweepBillingApply();
    const suspended = await sweepBillingEnforce();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ applied, suspended }));
  }
  // Chốt hoa hồng CTV ngay (nội bộ — cho cron + e2e xác định, khỏi chờ nhịp 5 phút).
  if (url.pathname === '/internal/affiliate-sweep' && req.method === 'POST') {
    const r = await sweepAffiliateCommissions();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  // Dọn phiên Messenger nguội ngay (nội bộ — cho cron + e2e xác định).
  if (url.pathname === '/internal/messenger-gc' && req.method === 'POST') {
    const nb = parseInt(url.searchParams.get('batch') ?? '', 10);
    const n = await sweepMessengerSessions(Number.isInteger(nb) ? Math.min(Math.max(nb, 1), 500) : undefined);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ deleted: n }));
  }
  // Kích hoạt quét xác minh domain ngay (nội bộ — cho cron + e2e xác định).
  if (url.pathname === '/internal/verify-sweep' && req.method === 'POST') {
    // ?batch= chỉ để e2e ép lô NHỎ mà chứng minh được xoay vòng (mirror subscription-sweep).
    const nb = parseInt(url.searchParams.get('batch') ?? '', 10);
    const n = await sweepDomainVerify(Number.isInteger(nb) ? Math.min(Math.max(nb, 1), DOMAINVERIFY_BATCH) : undefined);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ verified: n }));
  }
  // Kích hoạt quét vòng đời thuê bao ngay (nội bộ — cho cron + e2e xác định).
  if (url.pathname === '/internal/subscription-sweep' && req.method === 'POST') {
    // ?batch= chỉ để e2e ép lô NHỎ mà chứng minh được "đói quét" (shop ngoài lô đầu vẫn
    // được nhắc) — không phải cấu hình vận hành; kẹp 1..SUB_REMINDER_BATCH.
    const nb = parseInt(url.searchParams.get('batch') ?? '', 10);
    const r = await sweepSubscriptions(Number.isInteger(nb) ? Math.min(Math.max(nb, 1), SUB_REMINDER_BATCH) : undefined);
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
  // Tính lại "đã bán"/sao ngay (nội bộ — cho e2e xác định, không phải đợi nhịp 15 phút).
  if (url.pathname === '/internal/prodstats-sweep' && req.method === 'POST') {
    const r = await sweepProductStats();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  // Gộp lượt xem từ Redis vào DB ngay (nội bộ — cho e2e xác định).
  if (url.pathname === '/internal/prodview-sweep' && req.method === 'POST') {
    const r = await sweepProductViews();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  // Gộp lượt DÙNG TÍNH NĂNG từ Redis vào DB ngay (nội bộ — cho e2e xác định, 0141).
  if (url.pathname === '/internal/usage-sweep' && req.method === 'POST') {
    const r = await sweepFeatureUsage();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  // Dọn rác ảnh đánh giá ngay (nội bộ — cho e2e xác định, không phải đợi nhịp 1 giờ).
  if (url.pathname === '/internal/revimg-gc' && req.method === 'POST') {
    const r = await sweepReviewImages();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  // Kích hoạt dọn outbox ngay (nội bộ — cho cron + e2e xác định).
  if (url.pathname === '/internal/pii-sweep' && req.method === 'POST') {
    const r = await sweepPiiRetention();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  // Kích hoạt GC nháp signup treo ngay (nội bộ — cho cron + e2e xác định).
  if (url.pathname === '/internal/signup-sweep' && req.method === 'POST') {
    const r = await sweepSignups();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  if (url.pathname === '/internal/outbox-gc' && req.method === 'POST') {
    const r = await sweepOutboxGc();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  // Kích hoạt tích điểm ngay (nội bộ — cho cron + e2e xác định).
  if (url.pathname === '/internal/loyalty-earn-sweep' && req.method === 'POST') {
    const r = await sweepLoyaltyEarn();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  // Kích hoạt thu-hồi/hoàn điểm đơn terminal ngay (nội bộ — cho cron + e2e xác định).
  if (url.pathname === '/internal/loyalty-clawback-sweep' && req.method === 'POST') {
    const r = await sweepLoyaltyClawback();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  // Kích hoạt quét cảnh báo đường tiền ngay (nội bộ — cho cron + e2e xác định).
  // Kích hoạt sweep nhắc-onboarding ngay (nội bộ — để e2e tất định, không chờ hẹn giờ).
  if (url.pathname === '/internal/nudge-sweep' && req.method === 'POST') {
    const r = await sweepOnboardingNudge();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
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
  // Kích hoạt quét đơn ứ (SLA digest) ngay (nội bộ — cho cron + e2e xác định).
  if (url.pathname === '/internal/stale-sweep' && req.method === 'POST') {
    const r = await sweepStaleOrders();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  res.writeHead(404); res.end();
}));
/**
 * Tình trạng CẮM DÂY vận hành — chỉ boolean + tên biến, KHÔNG BAO GIỜ giá trị.
 * Dùng cho hai chỗ: dòng log lúc khởi động, và GET /internal/readiness để người vận
 * hành kiểm sau khi deploy mà không phải ssh vào đọc biến môi trường.
 */
function opsReadiness() {
  const alertChannel = Boolean((TELEGRAM_ON && ALERT_TELEGRAM_CHAT_ID) || ALERT_WEBHOOK_URL);
  const items = [
    { key: 'alert_channel', ok: alertChannel, need: 'TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID hoặc ALERT_WEBHOOK_URL',
      why: 'Cảnh báo đường tiền (giao dịch chưa khớp, email kẹt) sẽ KHÔNG tới ai.' },
    { key: 'worker_heartbeat', ok: Boolean(WORKER_HEARTBEAT_URL), need: 'WORKER_HEARTBEAT_URL',
      why: 'Worker chết thì không ai biết — chính nó là thứ gửi cảnh báo.' },
    { key: 'support_inbox', ok: Boolean(SUPPORT_EMAIL || (TELEGRAM_ON && ALERT_TELEGRAM_CHAT_ID)), need: 'SUPPORT_EMAIL',
      why: 'Người bán gửi yêu cầu hỗ trợ mà không ai nhận được thông báo.' },
  ];
  return { ready: items.every((i) => i.ok), items };
}
server.listen(PORT, '0.0.0.0', () => {
  log('info', 'listening', { port: PORT });
  // Nói NGAY lúc khởi động, không đợi tới lúc có sự cố mới phát hiện là mình câm.
  const r = opsReadiness();
  for (const i of r.items) {
    if (!i.ok) log('error', 'ops_not_wired', { item: i.key, need: i.need, why: i.why });
  }
  log('info', 'ops_readiness', { ready: r.ready, missing: r.items.filter((i) => !i.ok).map((i) => i.key) });
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    clearInterval(timer);
    if (integrationReconcileTimer) clearInterval(integrationReconcileTimer);
    if (expiryTimer) clearInterval(expiryTimer);
    if (domainTimer) clearInterval(domainTimer);
    if (billingTimer) clearInterval(billingTimer);
    if (trackingTimer) clearInterval(trackingTimer);
    if (lowstockTimer) clearInterval(lowstockTimer);
    if (prodStatsTimer) clearInterval(prodStatsTimer);
    if (prodViewTimer) clearInterval(prodViewTimer);
    if (usageTimer) clearInterval(usageTimer);
    if (revImgTimer) clearInterval(revImgTimer);
    if (piiTimer) clearInterval(piiTimer);
    if (messengerGcTimer) clearInterval(messengerGcTimer);
    if (billingApplyTimer) clearInterval(billingApplyTimer);
    if (billingEnforceTimer) clearInterval(billingEnforceTimer);
    if (staleTimer) clearInterval(staleTimer);
    if (loyaltyEarnTimer) clearInterval(loyaltyEarnTimer);
    if (loyaltyClawTimer) clearInterval(loyaltyClawTimer);
    clearInterval(outboxGcTimer);
    clearInterval(alertTimer);
    if (tgLinkTimer) clearInterval(tgLinkTimer);
    await worker.close().catch(() => {});
    await queue.close().catch(() => {});
    server.close(async () => { await db.end().catch(() => {}); await integrationDb?.end().catch(() => {}); await expiryDb?.end().catch(() => {}); await domainDb?.end().catch(() => {}); await billingDb?.end().catch(() => {}); await loyaltyDb?.end().catch(() => {}); process.exit(0); });
  });
}
