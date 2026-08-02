/**
 * VAI 1 (tiếp) — CHỦ SHOP: đăng nhập lần đầu → onboarding → tạo hàng → nhận tiền → MỞ BÁN.
 * Nhận shop qua env AUDIT_EMAIL / AUDIT_PW / AUDIT_SLUG (a1 in ra ở cuối).
 */
import { ADMIN, STORE, OADM, owner, http, sessionOf, ok, warn, bad, sect, summary, uniq, visible } from './lib.mjs';

const EMAIL = process.env.AUDIT_EMAIL, PW = process.env.AUDIT_PW, SLUG = process.env.AUDIT_SLUG;
const S = {};

const adm = (path, opts = {}) => http(ADMIN, path, { host: 'admin.localtest', origin: opts.form || opts.body ? OADM : undefined, cookie: S.cookie, ...opts });

async function main() {
  if (!EMAIL || !PW || !SLUG) { console.error('thiếu AUDIT_EMAIL/AUDIT_PW/AUDIT_SLUG'); process.exit(2); }
  const shopRow = await owner.query('SELECT id, status FROM shops WHERE slug=$1', [SLUG]);
  S.shopId = shopRow.rows[0].id;
  const base = `/shops/${S.shopId}`;

  // ── 4. Đăng nhập lần đầu ──────────────────────────────────────────────────
  sect('4. Chủ shop đăng nhập lần đầu');
  let r = await adm('/login');
  r.status === 200 ? ok('trang đăng nhập mở được') : bad('trang đăng nhập lỗi', String(r.status));
  r = await adm('/login', { method: 'POST', form: { email: EMAIL, password: PW }, origin: OADM });
  S.cookie = sessionOf(r.sc);
  S.cookie ? ok(`đăng nhập được ngay bằng mật khẩu đặt lúc đăng ký (→ ${r.status} ${r.loc ?? ''})`) : bad('không đăng nhập được', `${r.status} ${visible(r.text).slice(0, 150)}`);

  r = await adm('/');
  [200,302,303].includes(r.status) ? ok(`vào được khu quản trị (${r.status})`) : bad('vào admin lỗi', String(r.status));

  // ── 5. Checklist onboarding: có nói rõ phải làm gì không? ──────────────────
  sect('5. Trang tổng quan — checklist "làm gì tiếp"');
  r = await adm(`${base}/overview`);
  r.status === 200 ? ok('mở được trang tổng quan') : bad('tổng quan lỗi', String(r.status));
  const ov = visible(r.text);
  const items = [...r.text.matchAll(/checklist-item[^>]*>([\s\S]{0,120}?)</g)].map((m) => m[1].trim());
  /Nhận tiền|nhận tiền/.test(ov) ? ok('checklist nhắc "nhận tiền"') : warn('checklist không nhắc cấu hình nhận tiền');
  /sản phẩm|Sản phẩm/.test(ov) ? ok('checklist nhắc thêm sản phẩm') : warn('checklist không nhắc thêm sản phẩm');
  /Mở bán|mở bán/.test(ov) ? ok('có nút/mục "Mở bán"') : warn('không thấy đường chuyển shop sang trạng thái bán');
  const links = [...r.text.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => h.startsWith(base));
  links.length >= 5 ? ok(`tổng quan có ${links.length} lối đi tiếp`) : warn(`chỉ có ${links.length} link — dễ lạc`);

  // ── 6. Sản phẩm đầu tiên ──────────────────────────────────────────────────
  sect('6. Tạo sản phẩm đầu tiên');
  r = await adm(`${base}/products/new`);
  r.status === 200 ? ok('mở được form tạo sản phẩm') : bad('form tạo SP lỗi', String(r.status));
  const pf = r.text;
  const fields = [...pf.matchAll(/<(?:input|select|textarea)[^>]*name="([^"]+)"/g)].map((m) => m[1]);
  const uniqF = [...new Set(fields)];
  ok(`ô nhập có: ${uniqF.join(', ')}`);
  /name="price/.test(pf) ? ok('nhập được giá ngay ở form tạo') : bad('form tạo SP KHÔNG có ô giá');
  /name="(stock|on_hand|qty)/.test(pf) ? ok('nhập được tồn kho ngay') : warn('không nhập được tồn ở form tạo → SP tạo ra là 0 tồn, KHÔNG bán được');
  /name="opt_name0"/.test(pf) ? ok('form tạo có ô đặt phiên bản (size/màu)') : warn('form tạo KHÔNG cho đặt biến thể — phải vào trang chi tiết');

  const title = `Cà phê phin Sáu Mượt ${uniq()}`;
  const payload = {};
  for (const f of uniqF) payload[f] = '';
  Object.assign(payload, { title, price_vnd: '85000', stock: '50', status: 'active' });
  r = await adm(`${base}/products`, { method: 'POST', form: payload, origin: OADM });
  const created = await owner.query(`SELECT p.id, p.slug, p.status FROM products p WHERE p.shop_id=$1 AND p.title=$2`, [S.shopId, title]);
  created.rowCount === 1 ? ok(`tạo sản phẩm xong (slug tự sinh: ${created.rows[0].slug}, status=${created.rows[0].status})`) : bad('không tạo được sản phẩm', `${r.status} ${visible(r.text).slice(0, 200)}`);
  S.productId = created.rows[0]?.id;
  if (S.productId) {
    const inv = await owner.query(`SELECT v.id, v.price_vnd, il.on_hand FROM variants v LEFT JOIN inventory_levels il ON il.variant_id=v.id WHERE v.product_id=$1`, [S.productId]);
    inv.rows[0]?.price_vnd > 0 ? ok(`giá vào đúng: ${inv.rows[0].price_vnd}đ`) : bad('giá không được lưu', JSON.stringify(inv.rows));
    inv.rows[0]?.on_hand > 0 ? ok(`tồn vào kho: ${inv.rows[0].on_hand}`) : bad('SP tạo xong tồn = 0 → khách KHÔNG mua được', JSON.stringify(inv.rows));
    S.variantId = inv.rows[0]?.id;
  }

  // ── 7. Nhận tiền ──────────────────────────────────────────────────────────
  sect('7. Cấu hình nhận tiền (VietQR)');
  r = await adm(`${base}/payment`);
  r.status === 200 ? ok('mở được trang thanh toán') : bad('trang thanh toán lỗi', String(r.status));
  const hasHint = /BIN|napas|Vietcombank/i.test(visible(r.text));
  hasHint ? ok('có gợi ý mã BIN ngân hàng (khách không phải đi tra)') : warn('không gợi ý BIN — chủ shop phải tự tìm mã ngân hàng');
  const payForm = { __op: 'save', bank_bin: '970422', account_number: '0819107687', account_name: 'LE VAN HAU', qr_enabled: 'on' };
  r = await adm(`${base}/payment`, { method: 'POST', form: payForm, origin: OADM });
  const needStep = /Xác nhận mật khẩu/.test(r.text);
  needStep ? ok('sửa tài khoản nhận tiền BẮT xác nhận mật khẩu (đúng — đây là đường tiền)') : warn('đổi tài khoản nhận tiền KHÔNG cần xác nhận lại');
  if (needStep) {
    r = await adm(`${base}/payment/step-up`, { method: 'POST', origin: OADM, form: { ...payForm, __action: 'save', password: PW } });
  }
  const pay = await owner.query(`SELECT bank_bin, account_number FROM shop_payment_config WHERE shop_id=$1`, [S.shopId]).catch(() => ({ rowCount: 0, rows: [] }));
  pay.rowCount === 1 ? ok(`lưu được tài khoản nhận tiền (BIN ${pay.rows[0].bank_bin})`) : bad('không lưu được tài khoản nhận tiền', `${r.status} ${visible(r.text).slice(0, 200)}`);

  // ── 8. Vận chuyển ─────────────────────────────────────────────────────────
  sect('8. Cấu hình phí ship');
  r = await adm(`${base}/shipping`);
  r.status === 200 ? ok('mở được trang vận chuyển') : bad('trang vận chuyển lỗi', String(r.status));
  const sh = visible(r.text);
  /miễn phí|Miễn phí/.test(sh) ? ok('có ngưỡng miễn phí ship') : warn('không thấy ngưỡng freeship');
  /Cài đặt cửa hàng/.test(sh) && /phi-ship/.test(r.text) ? ok('trang hãng VC CHỈ ĐƯỜNG tới nơi đặt phí ship') : warn('không chỉ đường tới phí ship');
  /GHN|GHTK/.test(sh) ? ok('nối được hãng vận chuyển (GHN/GHTK)') : warn('không thấy kết nối hãng VC');

  // ── 9. Giao diện ──────────────────────────────────────────────────────────
  sect('9. Giao diện');
  r = await adm(`${base}/theme`);
  r.status === 200 ? ok('mở được trang giao diện') : bad('trang giao diện lỗi', String(r.status));
  const presetCount = [...r.text.matchAll(/name="preset"[^>]*value="([^"]+)"/g)].length;
  presetCount ? ok(`chọn nhanh được ${presetCount} mẫu theo ngành`) : warn('không có mẫu sẵn — shop phải tự chỉnh màu');
  /settings#logo/.test(r.text) ? ok('trang Giao diện có lối sang tải logo') : warn('trang Giao diện không chỉ được chỗ tải logo');
  // Biến thể ngay ở form tạo (vá đợt này) — shop thời trang cần ở SP đầu tiên.
  const pn = await adm(`${base}/products/new`);
  /name="opt_name0"/.test(pn.text) && /name="opt_values1"/.test(pn.text)
    ? ok('form tạo SP đặt được size/màu ngay (2 trục)') : warn('form tạo vẫn chưa đặt được biến thể');
  const tv = `Áo thun Sáu Mượt ${uniq()}`;
  await adm(`${base}/products`, { method: 'POST', origin: OADM, form: { title: tv, price_vnd: '199000', stock: '10', status: 'active', opt_name0: 'Size', opt_values0: 'S, M, L', opt_name1: 'Màu', opt_values1: 'Đen, Trắng' } });
  const nv = await owner.query(`SELECT count(*)::int n FROM variants v JOIN products p ON p.id=v.product_id WHERE p.shop_id=$1 AND p.title=$2`, [S.shopId, tv]);
  nv.rows[0].n === 6 ? ok(`tạo 1 lần ra ĐỦ 6 phiên bản (3 size × 2 màu)`) : bad(`sinh sai số tổ hợp: ${nv.rows[0].n} (mong 6)`);

  // ── 10. Mở bán ────────────────────────────────────────────────────────────
  sect('10. Mở bán + khách vào được chưa');
  r = await adm(`${base}/activate`, { method: 'POST', origin: OADM, form: {} });
  const st = await owner.query('SELECT status FROM shops WHERE id=$1', [S.shopId]);
  st.rows[0].status === 'active' ? ok('bấm Mở bán → shop chuyển sang active') : bad(`Mở bán không đổi trạng thái (vẫn ${st.rows[0].status})`, `${r.status}`);

  const host = `${SLUG}.nentang.vn`;
  r = await http(STORE, '/', { host });
  r.status === 200 ? ok(`storefront của shop mở được tại ${host}`) : bad('storefront không mở được', String(r.status));
  r.text.includes(title.slice(0, 20)) ? ok('sản phẩm vừa tạo HIỆN trên trang chủ shop') : warn('trang chủ shop không thấy sản phẩm vừa tạo (có thể do bố cục chỉ hiện SP nổi bật)');
  const pr = await http(STORE, `/products`, { host });
  pr.status === 200 && pr.text.includes(title.slice(0, 20)) ? ok('sản phẩm có trong trang /products') : bad('sản phẩm KHÔNG hiện ở trang danh sách', String(pr.status));

  console.log(`\n  → shopId=${S.shopId} productId=${S.productId} variantId=${S.variantId} host=${host}`);
  summary();
  await owner.end();
}
main().catch((e) => { console.error('VỠ:', e); process.exit(2); });
