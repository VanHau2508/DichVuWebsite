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
    const extra = p.status === 'shipped' && p.tracking_number ? `\nMã vận đơn: ${p.tracking_number} — bạn có thể tra trên trang của hãng vận chuyển.`
      : p.status === 'delivered' ? '\nCảm ơn bạn đã mua hàng! Nếu có vấn đề với sản phẩm, hãy liên hệ cửa hàng.'
      : p.tracking_number ? `\nMã vận đơn: ${p.tracking_number}` : '';
    const extraHtml = p.status === 'shipped' && p.tracking_number ? par(`Mã vận đơn: <strong>${escHtml(p.tracking_number)}</strong> — bạn có thể tra trên trang của hãng vận chuyển.`)
      : p.status === 'delivered' ? par('Cảm ơn bạn đã mua hàng! Nếu có vấn đề với sản phẩm, hãy liên hệ cửa hàng.')
      : p.tracking_number ? par(`Mã vận đơn: <strong>${escHtml(p.tracking_number)}</strong>`) : '';
    return {
      subject: `Đơn hàng #${p.order_number} — ${label}`,
      text: `Đơn hàng #${p.order_number} ${label}.${extra}${footer}`,
      html: emailHtml(p, `Đơn hàng #${p.order_number} — ${label}`,
        par(`Đơn hàng <strong>#${escHtml(p.order_number)}</strong> ${escHtml(label)}.`) + extraHtml, trackCta),
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

// ── consumer: queue → email ──────────────────────────────────────────────────
const worker = new Worker('email', async (job) => {
  const { topic, payload, shopId, outboxId } = job.data;
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
    const reminded = await sweepSubscriptionReminders();
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
async function sweepSubscriptionReminders() {
  if (!billingDb) return 0;
  let subs;
  try {
    // NOT EXISTS = guard đa-sub (mirror lines suspend): đừng nhắc "sắp tạm ngưng" khi
    // concierge đã tạo sub MỚI còn hạn dài phục vụ shop (gia hạn kiểu thêm dòng).
    subs = (await billingDb.query(
      `SELECT sub.id, sub.shop_id, sub.status, sub.plan_code, sub.current_period_end,
              sh.name AS shop_name, sh.contact_email, p.name AS plan_name
         FROM subscriptions sub
         JOIN shops sh ON sh.id = sub.shop_id
         LEFT JOIN plans p ON p.code = sub.plan_code
        WHERE sh.status IN ('onboarding','active') AND sub.current_period_end IS NOT NULL
          AND ((sub.status IN ('trial','active') AND sub.current_period_end < now() + interval '7 days')
               OR sub.status = 'past_due')
          AND NOT EXISTS (SELECT 1 FROM subscriptions s2
                           WHERE s2.shop_id = sub.shop_id AND s2.id <> sub.id
                             AND s2.status IN ('trial','active') AND s2.current_period_end > now() + interval '7 days')
        ORDER BY sub.current_period_end LIMIT 200`)).rows;
  } catch (e) { log('error', 'subreminder_query_error', { message: e.message }); return 0; }
  let sent = 0;
  for (const s of subs) {
    const msLeft = new Date(s.current_period_end).getTime() - Date.now();
    const days = msLeft / 86400000;
    const milestone = s.status === 'past_due' ? 'past_due' : days <= 1 ? 'd1' : days <= 3 ? 'd3' : 'd7';
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
  if (sent) log('info', 'subscription_reminders', { n: sent });
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
        // COD hãng giao xong = shipper ĐÃ THU tiền khách (thu hộ) → tự flip unpaid→paid
        // (0066). QR giữ nguyên bất biến "chỉ webhook đặt paid". CASE trong CÙNG câu
        // UPDATE + guard status='shipped' → nguyên tử, idempotent như cũ.
        const upd = await c.query(
          `UPDATE orders SET status = 'delivered', delivered_at = now(),
                  payment_status = CASE WHEN payment_method = 'cod' AND payment_status = 'unpaid' THEN 'paid' ELSE payment_status END,
                  paid_at = CASE WHEN payment_method = 'cod' AND payment_status = 'unpaid' THEN now() ELSE paid_at END
            WHERE id = $1 AND status = 'shipped'`, [s.order_id]);
        await c.query(`UPDATE shipments SET status = 'delivered', provider_status = $2, synced_at = now() WHERE id = $1`, [s.id, st.raw]);
        if (upd.rowCount === 1 && s.customer_email) {
          await c.query(`INSERT INTO outbox (shop_id, topic, payload) VALUES ($1, 'order.status_changed', $2)`,
            [s.shop_id, { to: s.customer_email, order_number: Number(s.order_number), status: 'delivered', total_vnd: Number(s.total_vnd), tracking_number: s.tracking_number }]);
        }
        if (upd.rowCount === 1) { delivered++; log('info', 'tracking_delivered', { order_number: Number(s.order_number), provider: s.provider }); }
      } else if (st.state === 'returned') {
        // Hàng HOÀN (bom hàng): trước đây đơn kẹt 'shipped' mãi. Chốt đơn 'returned' +
        // mốc returned_at, guard status='shipped' = idempotent (mirror nhánh delivered).
        // KHÔNG cộng lại on_hand: hàng chưa chắc về kho/có thể hỏng, và app_expiry cố
        // tình KHÔNG có quyền on_hand/ledger (0022) — chủ shop tự Điều chỉnh tồn khi
        // nhận hàng thật. Reserve đã trả lúc ship (consumeAndShip) nên không còn gì release.
        const upd = await c.query(`UPDATE orders SET status = 'returned', returned_at = now() WHERE id = $1 AND status = 'shipped'`, [s.order_id]);
        await c.query(`UPDATE shipments SET status = 'returned', provider_status = $2, synced_at = now() WHERE id = $1`, [s.id, st.raw]);
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
      if (r.rowCount < 500) break;
    }
    if (total) log('info', 'pii_sweep', { n: total }); // CHỈ đếm — không log PII
  } catch (e) { log('error', 'pii_sweep_error', { message: e.message }); }
  return { anonymized: total };
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
async function sweepStaleOrders() {
  if (!expiryDb || !TELEGRAM_ON) return { shops: 0, pending: 0, shipped: 0 };
  let pend, ship;
  try {
    pend = (await expiryDb.query(
      `SELECT shop_id, order_number FROM orders
        WHERE status = 'pending' AND created_at < now() - ($1 || ' hours')::interval
        ORDER BY shop_id, created_at LIMIT 500`, [String(STALE_PENDING_HOURS)])).rows;
    ship = (await expiryDb.query(
      `SELECT o.shop_id, o.order_number FROM orders o
        WHERE o.status = 'shipped'
          AND coalesce((SELECT max(s.created_at) FROM shipments s WHERE s.order_id = o.id), o.created_at)
              < now() - ($1 || ' days')::interval
        ORDER BY o.shop_id, o.created_at LIMIT 500`, [String(STALE_SHIPPED_DAYS)])).rows;
  } catch (e) { log('error', 'stale_query_error', { message: e.message }); return { shops: 0, pending: 0, shipped: 0 }; }
  const byShop = new Map();
  const add = (r, kind) => {
    if (!byShop.has(r.shop_id)) byShop.set(r.shop_id, { pending: [], shipped: [] });
    byShop.get(r.shop_id)[kind].push(Number(r.order_number));
  };
  for (const r of pend) add(r, 'pending');
  for (const r of ship) add(r, 'shipped');
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }); // YYYY-MM-DD giờ VN
  let sent = 0;
  for (const [shopId, g] of byShop) {
    try {
      const rc = await queue.client;
      const key = `tgstale:${shopId}:${day}`;
      if (await rc.get(key)) continue; // shop này đã nhận digest hôm nay
      const row = (await expiryDb.query(`SELECT chat_id FROM shop_telegram WHERE shop_id = $1 AND enabled AND chat_id IS NOT NULL`, [shopId])).rows[0];
      if (!row?.chat_id) continue; // chưa nối Telegram → thôi (không có kênh khác để digest)
      const firstFew = (a) => a.slice(0, 5).map((n) => `#${n}`).join(', ') + (a.length > 5 ? '…' : '');
      const parts = [];
      if (g.pending.length) parts.push(`${g.pending.length} đơn chờ xử lý >${STALE_PENDING_HOURS}h (${firstFew(g.pending)})`);
      if (g.shipped.length) parts.push(`${g.shipped.length} đơn gửi hãng >${STALE_SHIPPED_DAYS} ngày chưa giao (${firstFew(g.shipped)})`);
      const okSent = await tgSend(row.chat_id, `⏳ Đơn ứ: ${parts.join(', ')}. Vào trang quản trị xử lý sớm để không mất khách.`);
      if (okSent) { sent++; await rc.set(key, '1', 'EX', 26 * 3600); } // 26h > 1 ngày — key tự rơi
    } catch (e) { log('error', 'stale_digest_error', { message: e.message }); }
  }
  if (sent) log('info', 'stale_order_digests', { shops: sent, pending: pend.length, shipped: ship.length });
  return { shops: sent, pending: pend.length, shipped: ship.length };
}

const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL ?? '';
const ALERT_SWEEP_MS = Number(process.env.ALERT_SWEEP_MS ?? 300000);      // 5 phút
const ALERT_REPEAT_MS = Number(process.env.ALERT_REPEAT_MS ?? 3600000);   // nhắc lại mỗi 1h nếu còn
const ALERT_UNMATCHED_MAX = Number(process.env.ALERT_UNMATCHED_MAX ?? 1); // ≥N giao dịch chưa khớp >1h
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
const piiTimer = expiryDb ? setInterval(sweepPiiRetention, PII_SWEEP_MS) : null;
const staleTimer = (expiryDb && TELEGRAM_ON) ? setInterval(sweepStaleOrders, STALE_SWEEP_MS) : null;

// ── HTTP: health + stats (cho e2e kiểm dead-letter) ──────────────────────────
const server = http.createServer((req, res) => runReq(req, res, async () => {
  const url = new URL(req.url, 'http://internal');
  if (await health(url.pathname, res, { db: () => db.query('SELECT 1'), redis: async () => (await queue.client).ping() })) return;
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
  if (url.pathname === '/internal/pii-sweep' && req.method === 'POST') {
    const r = await sweepPiiRetention();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
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
  // Kích hoạt quét đơn ứ (SLA digest) ngay (nội bộ — cho cron + e2e xác định).
  if (url.pathname === '/internal/stale-sweep' && req.method === 'POST') {
    const r = await sweepStaleOrders();
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
    if (piiTimer) clearInterval(piiTimer);
    if (staleTimer) clearInterval(staleTimer);
    clearInterval(outboxGcTimer);
    clearInterval(alertTimer);
    if (tgLinkTimer) clearInterval(tgLinkTimer);
    await worker.close().catch(() => {});
    await queue.close().catch(() => {});
    server.close(async () => { await db.end().catch(() => {}); await expiryDb?.end().catch(() => {}); await domainDb?.end().catch(() => {}); await billingDb?.end().catch(() => {}); process.exit(0); });
  });
}
