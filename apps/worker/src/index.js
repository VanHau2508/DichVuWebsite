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
import { buildSmtpOptions } from './smtp.js';

const PORT = Number(process.env.PORT ?? 3080);
const POLL_MS = Number(process.env.POLL_MS ?? 1000);
const ATTEMPTS = Number(process.env.EMAIL_ATTEMPTS ?? 5);
const BACKOFF_MS = Number(process.env.EMAIL_BACKOFF_MS ?? 2000);
const FROM = process.env.EMAIL_FROM ?? 'no-reply@nentang.vn';
// Thương hiệu + email liên hệ nền tảng cho NỘI DUNG nhắc hạn thuê bao (dunning) —
// cùng mặc định với storefront (trang công ty) để copy nhất quán.
const PLATFORM_BRAND = process.env.PLATFORM_BRAND ?? 'Nền Tảng';
const BILLING_CONTACT = process.env.PLATFORM_CONTACT_EMAIL ?? 'lienhe@nentang.vn';

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
// Pool RIÊNG cho điểm thưởng (role app_loyalty cực hẹp — 0086). Thiếu env → TẮT tính năng.
// Tích điểm (vesting: chỉ đơn paid ≥ N ngày) + thu-hồi (clawback/reversal đơn terminal).
const LOYALTY_URL = process.env.DATABASE_URL_LOYALTY;
const loyaltyDb = LOYALTY_URL ? new pg.Pool({ connectionString: LOYALTY_URL, max: 2 }) : null;
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

// ── compose email từ sự kiện ─────────────────────────────────────────────────
// Payload SELF-CONTAINED (worker không đọc orders). p.link (nếu có) = URL tra cứu đơn.
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
    const label = { confirmed: 'đã được xác nhận', shipped: 'đang trên đường giao', delivered: 'đã giao thành công', cancelled: 'đã huỷ', refunded: 'đã hoàn tiền', returned: 'đã được hoàn về cửa hàng' }[p.status] ?? p.status;
    // HUỶ ĐƠN (0117): người mất tiền có quyền biết VÌ SAO và BAO NHIÊU sẽ được trả.
    // Trước đây email chỉ nói "đã huỷ" — khách đã chuyển khoản không có thông tin nào
    // về khoản tiền của mình.
    const cancelWhy = p.status === 'cancelled' && p.cancel_reason ? `\nLý do: ${p.cancel_reason}` : '';
    const cancelDue = p.status === 'cancelled' && Number(p.refund_due_vnd) > 0
      ? `\nBạn đã thanh toán ${money(p.refund_due_vnd)} cho đơn này — cửa hàng sẽ hoàn lại khoản tiền trên. `
        + 'Nếu sau vài ngày làm việc chưa nhận được, vui lòng liên hệ cửa hàng.' : '';
    const cancelWhyHtml = p.status === 'cancelled' && p.cancel_reason ? par(`Lý do: ${escHtml(p.cancel_reason)}`) : '';
    const cancelDueHtml = p.status === 'cancelled' && Number(p.refund_due_vnd) > 0
      ? par(`Bạn đã thanh toán <strong>${escHtml(money(p.refund_due_vnd))}</strong> cho đơn này — cửa hàng sẽ hoàn lại khoản tiền trên. `
        + 'Nếu sau vài ngày làm việc chưa nhận được, vui lòng liên hệ cửa hàng.') : '';
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
    const contact = `\n\nĐể gia hạn, vui lòng liên hệ ${PLATFORM_BRAND}: ${BILLING_CONTACT}.`;
    const contactHtml = par(`Để gia hạn, vui lòng liên hệ ${escHtml(PLATFORM_BRAND)}: <strong>${escHtml(BILLING_CONTACT)}</strong>.`);
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
  if (!payload?.to) return; // không có email → bỏ qua (ZNS sau này dùng payload.phone)
  // DEDUP theo outboxId (mirror tgsent): queue at-least-once — nếu job gửi email XONG rồi
  // chết/lỗi ở bước sau → retry → KHÔNG gửi email TRÙNG cho khách. Đánh dấu SAU khi
  // sendMail thành công (lỗi relay tạm thời vẫn được thử lại). Redis chung với queue.
  const rc = outboxId ? await queue.client : null;
  if (rc && (await rc.get(`emailsent:${outboxId}`))) return;
  const { subject, text, html } = compose(topic, payload);
  await transport.sendMail({ from: FROM, to: payload.to, subject, text, ...(html ? { html } : {}) });
  if (rc) await rc.set(`emailsent:${outboxId}`, '1', 'EX', 86400);
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
        { jobId: `ob-${r.id}`, attempts: ATTEMPTS, backoff: { type: 'fixed', delay: BACKOFF_MS }, removeOnComplete: { count: 500 }, removeOnFail: { age: 7 * 24 * 3600, count: 1000 } },
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
  for (const s of row.layout) {
    if (s && bySlot[s.section]) s.props = { ...s.props, slides: bySlot[s.section] };
  }
  // layout là MẢNG → JSON.stringify, không thì node-pg ép thành array-literal.
  await db.query('UPDATE themes SET layout = $2 WHERE shop_id = $1', [shopId, JSON.stringify(row.layout)]);
  log('info', 'banner_seed_done', { outboxId, n: made.hero.length + made.side.length + made.promo.length });
}

// ── consumer: queue → email ──────────────────────────────────────────────────
const worker = new Worker('email', async (job) => {
  const { topic, payload, shopId, outboxId } = job.data;
  // Banner mặc định (0114): KHÔNG phải email — đi đường riêng và DỪNG tại đây.
  // Rơi xuống deliverNotification sẽ gửi JSON thô tới một địa chỉ không tồn tại.
  if (topic === 'shop.banners_seed') { await seedShopBanners(payload, outboxId); return; }
  // Yêu cầu hỗ trợ (0107) đi ĐƯỜNG RIÊNG: người nhận là CHỦ NỀN TẢNG, không phải khách của
  // shop. Nhét vào đường email-khách sẽ phải bịa payload.to, và bịa địa chỉ trong đường gửi
  // thư là cách gửi nhầm người.
  if (topic === 'support.ticket_created') { await deliverSupportAlert(payload, shopId, outboxId); return; }
  // Telegram cho CHỦ SHOP chạy TRƯỚC + ĐỘC LẬP email: nếu email khách lỗi (relay từ chối →
  // throw → retry → dead-letter), chủ shop VẪN nhận "đơn mới". Idempotent theo outboxId +
  // tự nuốt lỗi (không throw) → không làm fail/nuốt email.
  await deliverTelegram(topic, payload, shopId, outboxId);
  // Cờ test: email bounce vĩnh viễn → để kiểm dead-letter (chỉ dev/test).
  if (payload?.to === 'bounce@test.invalid') throw new Error('simulated permanent bounce');
  await deliverNotification(topic, payload, outboxId);
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
const DOMAINVERIFY_BATCH = 100;
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
    rows = (await domainDb.query(
      `SELECT id, hostname, verification_token FROM domains
        WHERE verified_at IS NULL AND created_at > now() - ($2 || ' hours')::interval
        ORDER BY last_checked_at NULLS FIRST, created_at DESC LIMIT $1`,
      [batch, String(DOMAINVERIFY_GIVEUP_HOURS)])).rows;
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
function sbRing() {
  const out = new Map();
  for (const part of String(process.env.SHIPPING_ENC_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    if (i < 1) continue;
    const m = part.slice(i + 1).trim();
    out.set(part.slice(0, i).trim(), /^[0-9a-fA-F]{64}$/.test(m) ? Buffer.from(m, 'hex') : Buffer.from(m, 'base64'));
  }
  return out;
}
function sbOpen(blob, keyHex) { // bản sao secretbox.open (build context worker là dir riêng)
  const parts = String(blob).split('.');
  let key = Buffer.from(keyHex, 'hex');
  let [ivB64, tagB64, ctB64] = parts;
  if (parts[0] === 'v2' && parts.length === 5) {
    key = sbRing().get(parts[1]) ?? (parts[1] === 'k0' ? key : null);
    if (!key) throw new Error(`không có khoá kid "${parts[1]}" trong SHIPPING_ENC_KEYS`);
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
      if (st.state === 'delivered') {
        // SPLIT (0080): đánh dấu KIỆN NÀY delivered TRƯỚC (loại khỏi kiểm "còn kiện chưa giao").
        await c.query(`UPDATE shipments SET status = 'delivered', provider_status = $2, synced_at = now() WHERE id = $1`, [s.id, st.raw]);
        // Chốt ĐƠN 'delivered' CHỈ khi: mọi dòng gửi đủ (fulfillment='fulfilled') VÀ KHÔNG còn
        // kiện anh em 'created'/'in_transit'/'returned' (mọi kiện đã delivered/cancelled). COD
        // unpaid→paid CASE (0066) CƯỠI trên UPDATE có guard → đơn giao MỘT PHẦN KHÔNG paid sớm.
        const upd = await c.query(
          `UPDATE orders SET status = 'delivered', delivered_at = now(),
                  payment_status = CASE WHEN payment_method = 'cod' AND payment_status = 'unpaid' THEN 'paid' ELSE payment_status END,
                  paid_at = CASE WHEN payment_method = 'cod' AND payment_status = 'unpaid' THEN now() ELSE paid_at END
            WHERE id = $1 AND status = 'shipped' AND fulfillment_status = 'fulfilled'
              AND NOT EXISTS (SELECT 1 FROM shipments s2 WHERE s2.order_id = $1 AND s2.status IN ('created','in_transit','returned'))`,
          [s.order_id]);
        if (upd.rowCount === 1 && s.customer_email) {
          await c.query(`INSERT INTO outbox (shop_id, topic, payload) VALUES ($1, 'order.status_changed', $2)`,
            [s.shop_id, { to: s.customer_email, order_number: Number(s.order_number), status: 'delivered', total_vnd: Number(s.total_vnd), tracking_number: s.tracking_number }]);
        }
        if (upd.rowCount === 1) { delivered++; log('info', 'tracking_delivered', { order_number: Number(s.order_number), provider: s.provider }); }
      } else if (st.state === 'returned') {
        // Hàng HOÀN (bom hàng): đánh dấu kiện TRƯỚC. KHÔNG cộng lại on_hand (app_expiry cố tình
        // không có quyền — chủ shop tự Điều chỉnh khi nhận hàng thật). Reserve đã trả lúc ship.
        await c.query(`UPDATE shipments SET status = 'returned', provider_status = $2, synced_at = now() WHERE id = $1`, [s.id, st.raw]);
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
            [s.shop_id, { order_number: Number(s.order_number), status: 'returned', total_vnd: Number(s.total_vnd), tracking_number: s.tracking_number, reason: 'carrier_returned' }]);
        }
        log('warn', 'tracking_returned', { order_number: Number(s.order_number), provider: s.provider, order_changed: upd.rowCount === 1, raw: st.raw });
      } else if (st.state === 'cancelled') {
        await c.query(`UPDATE shipments SET status = 'cancelled', provider_status = $2, synced_at = now() WHERE id = $1`, [s.id, st.raw]);
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
        WHERE processed_at IS NOT NULL AND processed_at < now() - interval '7 days'
          AND (jsonb_exists(payload, 'link') OR jsonb_exists(payload, 'to') OR jsonb_exists(payload, 'customer_name'))`);
    if (r.rowCount) log('info', 'outbox_gc', { n: r.rowCount });
    return { scrubbed: r.rowCount };
  } catch (e) { log('error', 'outbox_gc_error', { message: e.message }); return { scrubbed: 0 }; }
}

// ── sweep: ẨN DANH PII theo hạn lưu trữ per-shop (0064, Luật BVDLCN 91/2025) ──
// Shop bật shops.pii_retention_months (NULL = tắt, mặc định) → đơn TRẠNG THÁI KẾT THÚC
// cũ hơn N tháng bị gỡ danh tính (tên → sentinel, SĐT/email/địa chỉ/ip_hash → NULL).
// Chỉ GHI-ĐÈ — app_expiry cố tình KHÔNG có SELECT trên cột PII (WHERE không đụng chúng).
// Batch 500 × tối đa 20 vòng: shop mới bật với backlog lớn không chạy vô hạn một nhịp.
const PII_SWEEP_MS = Number(process.env.PII_SWEEP_MS ?? 86400000); // 24h
async function sweepPiiRetention() {
  if (!expiryDb) return { anonymized: 0 };
  let total = 0;
  try {
    let capped = true;
    for (let round = 0; round < 20; round++) {
      const r = await expiryDb.query(
        `UPDATE orders SET customer_name = '(đã ẩn danh)', customer_phone = NULL, customer_email = NULL,
                shipping_address = NULL, client_ip_hash = NULL, anonymized_at = now()
          WHERE id IN (
            SELECT o.id FROM orders o JOIN shops s ON s.id = o.shop_id
             WHERE s.pii_retention_months IS NOT NULL AND o.anonymized_at IS NULL
               AND o.status IN ('delivered','cancelled','refunded','returned')
               AND o.created_at < now() - (s.pii_retention_months || ' months')::interval
             ORDER BY o.created_at LIMIT 500 FOR UPDATE OF o SKIP LOCKED)`);
      total += r.rowCount;
      if (r.rowCount < 500) { capped = false; break; }
    }
    // KHÔNG cắt trần im lặng: còn tồn thì phải nhìn thấy trong log (nhịp sau quét tiếp).
    // Ẩn danh PII là nghĩa vụ pháp lý (91/2025) — "đã chạy nhưng chưa xong" phải phân biệt
    // được với "đã xong", nếu không backlog lớn im lìm quá hạn mà không ai biết.
    if (capped) log('warn', 'pii_sweep_capped', { rounds: 20, n: total });
    if (total) log('info', 'pii_sweep', { n: total }); // CHỈ đếm — không log PII
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

// ── sweep: SLA ĐƠN Ứ — digest Telegram cho shop có đơn ứ đọng ────────────────
// (a) đơn 'pending' quá STALE_PENDING_HOURS (24h) — shop quên xác nhận (QR pending tự huỷ
//     sau 30' nên tồn >24h thực tế là COD chờ shop); (b) đơn 'shipped' quá STALE_SHIPPED_DAYS
//     (7 ngày) chưa delivered/returned — kẹt ở hãng VC / shop quên chốt giao.
// Mốc "đã gửi hãng" = max(shipments.created_at) của đơn (mọi đường ship đều tạo/chốt dòng
// shipments cùng lúc UPDATE orders → xấp xỉ shipped_at; app_expiry CỐ Ý không có quyền đọc
// orders.shipped_at — 0022/0044 cấp cột tường minh, và ngưỡng NGÀY không cần chính xác phút).
// Digest MỘT tin/shop/NGÀY (giờ VN): dedup Redis key tgstale:<shop>:<ngày> — mirror tgsent
// (đánh dấu SAU khi gửi thành công; gửi lỗi → nhịp sau thử lại). Gửi TRỰC TIẾP qua tgSend
// như sweepMoneyAlerts, KHÔNG qua outbox: đây là digest phái sinh từ trạng thái DB hiện có,
// không phải sự kiện nghiệp vụ mới (ADR-006 dành cho sự kiện phát trong transaction).
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
          AND coalesce((SELECT max(s.created_at) FROM shipments s WHERE s.order_id = o.id), o.created_at)
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
        if (await rc.get(key)) continue; // shop này đã nhận digest hôm nay
        const row = (await expiryDb.query(`SELECT chat_id FROM shop_telegram WHERE shop_id = $1 AND enabled AND chat_id IS NOT NULL`, [g.shop_id])).rows[0];
        if (!row?.chat_id) continue; // chưa nối Telegram → thôi (không có kênh khác để digest)
        const parts = [];
        if (g.n_pending) parts.push(`${g.n_pending} đơn chờ xử lý >${STALE_PENDING_HOURS}h (${firstFew(g.few_pending ?? [], g.n_pending)})`);
        if (g.n_shipped) parts.push(`${g.n_shipped} đơn gửi hãng >${STALE_SHIPPED_DAYS} ngày chưa giao (${firstFew(g.few_shipped ?? [], g.n_shipped)})`);
        const okSent = await tgSend(row.chat_id, `⏳ Đơn ứ: ${parts.join(', ')}. Vào trang quản trị xử lý sớm để không mất khách.`);
        if (okSent) { sent++; await rc.set(key, '1', 'EX', 26 * 3600); } // 26h > 1 ngày — key tự rơi
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
const revImgTimer = expiryDb ? setInterval(sweepReviewImages, REVIMG_GC_MS) : null;
const outboxGcTimer = setInterval(sweepOutboxGc, OUTBOX_GC_MS);
const alertTimer = setInterval(sweepMoneyAlerts, ALERT_SWEEP_MS);
const tgLinkTimer = (TELEGRAM_ON && expiryDb) ? setInterval(sweepTelegramLink, TELEGRAM_LINK_SWEEP_MS) : null;
const domainTimer = domainDb ? setInterval(sweepDomainVerify, DOMAINVERIFY_SWEEP_MS) : null;
const billingTimer = billingDb ? setInterval(sweepSubscriptions, SUBSCRIPTION_SWEEP_MS) : null;
const trackingTimer = (expiryDb && TRACKING_ON) ? setInterval(sweepTracking, TRACKING_SWEEP_MS) : null;
const piiTimer = expiryDb ? setInterval(sweepPiiRetention, PII_SWEEP_MS) : null;
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
        failedReason: String(j.failedReason ?? '').slice(0, 300), // cắt ngắn — stack SMTP có thể rất dài
        attemptsMade: j.attemptsMade, timestamp: j.timestamp,
      })),
    }));
  }
  // Retry TOÀN BỘ dead-letter (sau khi sửa SMTP/relay): đưa job failed về 'waiting' để
  // consumer gửi lại. BullMQ v5: Queue#retryJobs xử lý theo lô (Lua) — không kéo từng job.
  if (url.pathname === '/internal/dead-letters/retry' && req.method === 'POST') {
    const before = Number((await queue.getJobCounts('failed')).failed ?? 0);
    await queue.retryJobs({ state: 'failed' });
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
    if (expiryTimer) clearInterval(expiryTimer);
    if (domainTimer) clearInterval(domainTimer);
    if (billingTimer) clearInterval(billingTimer);
    if (trackingTimer) clearInterval(trackingTimer);
    if (lowstockTimer) clearInterval(lowstockTimer);
    if (prodStatsTimer) clearInterval(prodStatsTimer);
    if (prodViewTimer) clearInterval(prodViewTimer);
    if (revImgTimer) clearInterval(revImgTimer);
    if (piiTimer) clearInterval(piiTimer);
    if (staleTimer) clearInterval(staleTimer);
    if (loyaltyEarnTimer) clearInterval(loyaltyEarnTimer);
    if (loyaltyClawTimer) clearInterval(loyaltyClawTimer);
    clearInterval(outboxGcTimer);
    clearInterval(alertTimer);
    if (tgLinkTimer) clearInterval(tgLinkTimer);
    await worker.close().catch(() => {});
    await queue.close().catch(() => {});
    server.close(async () => { await db.end().catch(() => {}); await expiryDb?.end().catch(() => {}); await domainDb?.end().catch(() => {}); await billingDb?.end().catch(() => {}); await loyaltyDb?.end().catch(() => {}); process.exit(0); });
  });
}
