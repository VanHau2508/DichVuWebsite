/**
 * Dựng cấu hình nodemailer từ env — TÁCH RIÊNG để unit-test được mà không phải
 * khởi động worker (DB pool/timer/HTTP).
 *
 * Quy tắc (lỗ hổng cũ: transport không auth → mọi relay thật từ chối → email chết
 * ở production trong khi CI xanh vì Mailpit dev nhận mọi auth):
 * - auth CHỈ khi SMTP_USER được đặt → dev Mailpit (không auth) giữ nguyên.
 * - Cổng 465 = TLS ngầm → secure:true (nodemailer KHÔNG tự suy từ port).
 * - Có auth + không TLS ngầm (tức 587) → ÉP STARTTLS (requireTLS): relay không
 *   nâng cấp TLS thì gửi THẤT BẠI thay vì rơi về plaintext (rò email khách +
 *   credential SMTP).
 * KHÔNG log kết quả hàm này — chứa auth.pass.
 */
export function buildSmtpOptions(env = process.env) {
  const port = Number(env.SMTP_PORT ?? 1025);
  const user = env.SMTP_USER ?? '';
  const secure = env.SMTP_SECURE === 'true' || port === 465;
  const opts = { host: env.SMTP_HOST ?? 'mailpit', port, secure };
  if (user) {
    opts.auth = { user, pass: env.SMTP_PASSWORD ?? '' };
    if (!secure) opts.requireTLS = true;
  }
  return opts;
}
