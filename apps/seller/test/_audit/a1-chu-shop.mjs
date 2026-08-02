/**
 * VAI 1 — CHỦ SHOP: từ lúc tìm thấy dịch vụ tới lúc bán được hàng.
 * Không giả định gì về nội bộ; chỉ đi bằng HTTP như trình duyệt.
 */
import { SIGNUP, STORE, AUTH, ADMIN, SELLER, OA, OADM, OS, owner, http, sessionOf, ok, warn, bad, sect, summary, uniq, visible, mailLink, sleep } from './lib.mjs';

const U = uniq();
const shop = { name: `Tạp hoá Sáu Mượt ${U}`, slug: `sau-muot-${U}`, email: `chu-${U}@sauMuot.vn`.toLowerCase(), password: 'ban tap hoa cho vui' };
const state = {};

async function main() {
  // ── 1. Tìm thấy dịch vụ: trang giới thiệu ────────────────────────────────
  sect('1. Chủ shop lần đầu vào nentang.vn — có hiểu đây bán gì không?');
  let r = await http(STORE, '/', { host: 'nentang.vn' });
  const home = visible(r.text);
  r.status === 200 ? ok(`trang chủ nền tảng trả 200 (${r.text.length} byte)`) : bad('trang chủ nền tảng không mở được', String(r.status));
  /\/signup/.test(r.text) ? ok('có lối vào đăng ký từ trang chủ') : bad('trang chủ KHÔNG có link đăng ký — khách tự tìm kiểu gì?');
  /\d[\d.,]*\s*(đ|₫|VND|nghìn|triệu)/i.test(home) ? ok('trang chủ có nêu CON SỐ giá') : warn('trang chủ không nêu giá cụ thể — chủ shop phải hỏi mới biết tiền');
  // Trang công ty CÓ THẬT (companyPaths trong storefront/src/company.js) + vài trang
  // khách hàng VN hay tìm mà có thể chưa có.
  for (const p of ['/gioi-thieu', '/ho-tro', '/dieu-khoan', '/bao-mat', '/lien-he', '/blog', '/robots.txt', '/sitemap.xml']) {
    const x = await http(STORE, p, { host: 'nentang.vn' });
    x.status === 200 ? ok(`trang ${p} có`) : bad(`trang ${p} → ${x.status}`);
  }
  // Bảng giá nằm NGAY trên trang chủ (3 gói kèm số tiền/tháng) → không cần trang riêng.
  const homeHasPrice = /\/tháng/.test(home);
  homeHasPrice ? ok('bảng giá nằm ngay trang chủ (không cần trang /bang-gia riêng)') : warn('trang chủ không có bảng giá');

  // ── 2. Form đăng ký ───────────────────────────────────────────────────────
  sect('2. Tự đăng ký (self-serve)');
  r = await http(SIGNUP, '/signup', { host: 'nentang.vn' });
  r.status === 200 ? ok('mở được form đăng ký') : bad('form đăng ký lỗi', String(r.status));
  const form = r.text;
  const ct = /name="ct"\s+value="([^"]*)"/.exec(form)?.[1] ?? '';
  ct ? ok('form có dấu thời gian chống bot') : warn('không thấy trường ct — chống bot?');
  const plans = [...form.matchAll(/name="plan_code"[^>]*value="([^"]+)"/g)].map((m) => m[1]);
  plans.length ? ok(`có ${plans.length} gói để chọn: ${plans.join(', ')}`) : bad('không có gói nào để chọn');
  // Ngành có thể là <select><option value> hoặc radio — bắt cả hai.
  const selBlock = /<select[^>]*name="industry"[\s\S]*?<\/select>/.exec(form)?.[0] ?? '';
  const industries = selBlock
    ? [...selBlock.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]).filter(Boolean)
    : [...form.matchAll(/name="industry"[^>]*value="([^"]+)"/g)].map((m) => m[1]);
  industries.length ? ok(`chọn được ngành: ${industries.join(', ')}`) : warn('không chọn được ngành → giao diện mặc định chung chung');

  // Bot POST thẳng (không có ct) phải bị chặn.
  const botR = await http(SIGNUP, '/signup', { method: 'POST', host: 'nentang.vn:8443', origin: 'https://nentang.vn:8443',
    form: { name: 'bot', slug: `bot-${uniq()}`, email: `bot-${uniq()}@x.vn`, plan_code: plans[0] ?? 'starter' } });
  botR.status >= 400 ? ok(`POST thẳng không có ct → ${botR.status} (chặn bot)`) : warn('bot POST thẳng vẫn qua', String(botR.status));

  // Đăng ký thật.
  await sleep(2200); // form-ts có ngưỡng "nhanh bất thường"
  r = await http(SIGNUP, '/signup', { method: 'POST', host: 'nentang.vn:8443', origin: 'https://nentang.vn:8443',
    form: { name: shop.name, slug: shop.slug, email: shop.email, password: shop.password, plan_code: plans[0] ?? 'starter', industry: industries[0] ?? '', website: '', ct } });
  if (r.status === 200 || r.status === 303) ok(`gửi đăng ký → ${r.status}`); else bad('đăng ký thất bại', `${r.status} ${visible(r.text).slice(0, 200)}`);
  const preShop = await owner.query('SELECT 1 FROM shops WHERE slug=$1', [shop.slug]);
  preShop.rowCount === 0 ? ok('chưa xác minh email thì CHƯA đẻ shop (không rác hoá DB)') : bad('shop được tạo trước khi xác minh email');

  // ── 3. Xác minh email ─────────────────────────────────────────────────────
  sect('3. Xác minh email → cấp phát shop');
  const mails = await owner.query(`SELECT topic, payload FROM outbox WHERE payload->>'to'=$1 ORDER BY id DESC`, [shop.email]);
  mails.rowCount ? ok(`nhận được email: ${mails.rows.map((m) => m.topic).join(', ')}`) : bad('KHÔNG có email xác minh nào được gửi');
  const link = mails.rows[0]?.payload?.link ?? mails.rows[0]?.payload?.verify_url ?? mails.rows[0]?.payload?.url;
  link ? ok(`email có link xác minh`) : bad('email không có link', JSON.stringify(mails.rows[0]?.payload ?? {}).slice(0, 200));
  const token = link ? new URL(link).searchParams.get('token') : null;

  r = await http(SIGNUP, `/signup/verify?token=${encodeURIComponent(token ?? '')}`, { host: 'nentang.vn' });
  r.status === 200 && /xác nhận|Xác nhận|tiếp tục/i.test(visible(r.text)) ? ok('trang xác nhận mở được') : bad('trang xác nhận lỗi', `${r.status}`);
  const ct2 = /name="ct"\s+value="([^"]*)"/.exec(r.text)?.[1] ?? '';
  await sleep(2200);
  r = await http(SIGNUP, '/signup/verify', { method: 'POST', host: 'nentang.vn:8443', origin: 'https://nentang.vn:8443', form: { token, ct: ct2 } });
  const provisioned = await owner.query('SELECT id, status, industry FROM shops WHERE slug=$1', [shop.slug]);
  provisioned.rowCount === 1 ? ok(`shop được cấp phát: status=${provisioned.rows[0].status}`) : bad('xác minh xong vẫn không có shop', `${r.status} ${visible(r.text).slice(0, 200)}`);
  state.shopId = provisioned.rows[0]?.id;

  const doneHtml = visible(r.text);
  /mật khẩu|Mật khẩu/i.test(doneHtml) || /đăng nhập|Đăng nhập/i.test(doneHtml)
    ? ok('trang xong có chỉ đường đăng nhập') : warn('xong rồi mà không nói vào đâu tiếp');

  // Chủ shop đặt mật khẩu thế nào? Kiểm xem có user chưa.
  const u = await owner.query('SELECT id, password_hash IS NOT NULL AS has_pw FROM users WHERE email=$1', [shop.email]);
  if (u.rowCount === 1 && u.rows[0].has_pw) { ok('user đã có mật khẩu ngay sau đăng ký'); state.userId = u.rows[0].id; }
  else if (u.rowCount === 1) { warn('user tồn tại nhưng CHƯA có mật khẩu — phải đi đường "quên mật khẩu"?'); state.userId = u.rows[0].id; }
  else bad('không có user nào được tạo cho chủ shop');

  const sub = await owner.query('SELECT status, current_period_end FROM subscriptions WHERE shop_id=$1', [state.shopId]);
  sub.rowCount === 1 ? ok(`có thuê bao: ${sub.rows[0].status}, hết hạn ${String(sub.rows[0].current_period_end).slice(0, 10)}`) : bad('không có thuê bao → không biết dùng thử tới bao giờ');
  const dom = await owner.query('SELECT hostname, verified_at IS NOT NULL v, is_primary FROM domains WHERE shop_id=$1', [state.shopId]);
  dom.rowCount >= 1 && dom.rows[0].v ? ok(`có tên miền dùng ngay: ${dom.rows[0].hostname}`) : bad('không có tên miền nào hoạt động');
  const theme = await owner.query(`SELECT count(*) n FROM shop_settings WHERE shop_id=$1`, [state.shopId]).catch(() => ({ rows: [{ n: -1 }] }));
  console.log(`       (ghi chú: shop_settings ${theme.rows[0].n} dòng)`);

  console.log(`\n  → shop ${shop.slug} | ${shop.email}`);
  summary();
  await owner.end();
}
main().catch((e) => { console.error('VỠ:', e); process.exit(2); });
