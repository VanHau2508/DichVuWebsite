/**
 * VAI 2 — KHÁCH MUA HÀNG: vào shop, tìm, mua, tra đơn, lập tài khoản, đánh giá, đổi trả.
 * env: AUDIT_HOST (host storefront của shop đã mở bán)
 */
import { STORE, CHECKOUT, ACCOUNT, owner, http, cookieOf, sessionOf, ok, warn, bad, sect, summary, uniq, visible, sleep } from './lib.mjs';

const HOST = process.env.AUDIT_HOST;
const ORIGIN = `https://${HOST}`;
const S = { cart: null };
const st = (p, o = {}) => http(STORE, p, { host: HOST, ...o });
const co = (p, o = {}) => http(CHECKOUT, p, { host: HOST, origin: o.form || o.body ? ORIGIN : undefined, cookie: S.cart, ...o });
const ac = (p, o = {}) => http(ACCOUNT, p, { host: HOST, origin: o.form || o.body ? ORIGIN : undefined, cookie: S.acct, ...o });

async function main() {
  if (!HOST) { console.error('thiếu AUDIT_HOST'); process.exit(2); }
  const shop = (await owner.query(`SELECT s.id, s.slug FROM shops s JOIN domains d ON d.shop_id=s.id WHERE d.hostname=$1`, [HOST])).rows[0];
  S.shopId = shop.id;

  // ── 1. Vào shop, tìm hàng ────────────────────────────────────────────────
  sect('1. Khách vào cửa hàng');
  let r = await st('/');
  r.status === 200 ? ok(`trang chủ shop mở được (${r.text.length} byte)`) : bad('trang chủ shop lỗi', String(r.status));
  const h = visible(r.text);
  /giỏ|Giỏ/i.test(h) ? ok('có giỏ hàng trên header') : warn('không thấy giỏ hàng ở header');
  /tìm|Tìm|search/i.test(r.text) ? ok('có ô tìm kiếm') : warn('không có ô tìm kiếm');
  const prodLinks = [...new Set([...r.text.matchAll(/href="(\/p\/[^"?#]+)"/g)].map((m) => m[1]))];
  prodLinks.length ? ok(`trang chủ dẫn tới ${prodLinks.length} sản phẩm`) : bad('trang chủ không có link sản phẩm nào');

  r = await st('/products');
  r.status === 200 ? ok('trang danh sách sản phẩm mở được') : bad('/products lỗi', String(r.status));
  // Tìm không dấu — người Việt gõ nhanh không bỏ dấu.
  const title = (await owner.query('SELECT title FROM products WHERE shop_id=$1 LIMIT 1', [S.shopId])).rows[0].title;
  const kw = title.split(' ')[0];
  const kwNoAccent = kw.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
  r = await st(`/search?q=${encodeURIComponent(kw)}`);
  r.status === 200 && r.text.includes(title.slice(0, 15)) ? ok(`tìm "${kw}" ra sản phẩm`) : bad(`tìm "${kw}" KHÔNG ra`, String(r.status));
  r = await st(`/search?q=${encodeURIComponent(kwNoAccent)}`);
  r.status === 200 && r.text.includes(title.slice(0, 15)) ? ok(`tìm KHÔNG DẤU "${kwNoAccent}" vẫn ra`) : warn(`tìm không dấu "${kwNoAccent}" không ra — khách VN gõ kiểu này`);

  // ── 2. Trang sản phẩm ────────────────────────────────────────────────────
  sect('2. Trang sản phẩm');
  const pslug = prodLinks[0];
  r = await st(pslug);
  r.status === 200 ? ok(`mở được ${pslug}`) : bad('trang SP lỗi', String(r.status));
  const pv = visible(r.text);
  /\d[\d.,]*\s*(đ|₫)/.test(pv) ? ok('có hiện giá') : bad('trang SP không hiện giá');
  /Thêm vào giỏ|thêm vào giỏ|Mua/i.test(pv) ? ok('có nút mua/thêm giỏ') : bad('không có nút mua');
  /Mua ngay/i.test(pv) ? ok('có "Mua ngay" (bỏ qua giỏ)') : warn('không có nút Mua ngay');
  /còn hàng|Còn hàng|Tồn|hết hàng/i.test(pv) ? ok('có báo tình trạng hàng') : warn('không nói còn/hết hàng');
  const vid = /name="variant_id"[^>]*value="([^"]+)"/.exec(r.text)?.[1];
  vid ? ok('có chọn được phiên bản (variant)') : warn('không thấy trường variant_id trên form mua');
  S.variantId = vid;

  // ── 3. Giỏ hàng ──────────────────────────────────────────────────────────
  sect('3. Giỏ hàng');
  r = await co('/cart/add', { method: 'POST', form: { variant_id: S.variantId, qty: '2' } });
  S.cart = cookieOf(r.sc, '__Host-cart') ?? S.cart;
  [200, 302, 303].includes(r.status) ? ok(`thêm vào giỏ → ${r.status}`) : bad('thêm giỏ lỗi', `${r.status} ${visible(r.text).slice(0, 150)}`);
  S.cart ? ok('giỏ được ghi nhớ bằng cookie (không cần đăng nhập)') : warn('không thấy cookie giỏ');
  r = await co('/cart');
  r.status === 200 && /2/.test(visible(r.text)) ? ok('trang giỏ hiện đúng số lượng') : warn('trang giỏ không rõ số lượng', String(r.status));
  const sub = /(\d[\d.]*)\s*(?:đ|₫)/.exec(visible(r.text))?.[1];
  sub ? ok(`giỏ có tạm tính: ${sub}đ`) : warn('giỏ không hiện tạm tính');

  // Sửa số lượng + xoá
  r = await co('/cart/update', { method: 'POST', form: { variant_id: S.variantId, qty: '3' } });
  [200, 302, 303].includes(r.status) ? ok('sửa được số lượng trong giỏ') : warn('không sửa được số lượng', String(r.status));

  // ── 4. Chốt đơn COD ──────────────────────────────────────────────────────
  sect('4. Chốt đơn (COD)');
  r = await co('/checkout');
  r.status === 200 ? ok('mở được trang thanh toán') : bad('trang checkout lỗi', String(r.status));
  const cf = r.text;
  const cfields = [...new Set([...cf.matchAll(/<(?:input|select|textarea)[^>]*name="([^"]+)"/g)].map((m) => m[1]))];
  ok(`ô cần điền: ${cfields.join(', ')}`);
  /COD|nhận hàng|Nhận hàng/i.test(visible(cf)) ? ok('có phương thức COD') : bad('không có COD — chợ VN chủ yếu COD');
  /QR|chuyển khoản/i.test(visible(cf)) ? ok('có chuyển khoản/QR') : warn('không có chuyển khoản');
  // Ô ẨN (idempotency_key, ct, ship_seen, subtotal_seen…) PHẢI gửi lại đúng giá trị trang
  // đã in ra — đó là cách trang chống đơn trùng và chống sửa giá. Trình duyệt làm việc này
  // tự động; bộ đo phải bắt chước, nếu không sẽ tự tạo ra lỗi "phiên không hợp lệ" giả.
  const prefill = {};
  for (const m of cf.matchAll(/<input[^>]*>/g)) {
    const tag = m[0];
    const nm = /name="([^"]+)"/.exec(tag)?.[1];
    const val = /value="([^"]*)"/.exec(tag)?.[1];
    if (nm && val !== undefined) prefill[nm] = val;
  }
  Object.keys(prefill).length ? ok(`form mang sẵn ${Object.keys(prefill).length} ô ẩn (chống đơn trùng / chống sửa giá)`) : warn('form không có ô ẩn nào');

  await sleep(3000); // ngưỡng chống bot là 2.5s (CHECKOUT_MIN_FILL_MS)
  const order = { name: 'Nguyễn Thị Hoa', phone: '0912345678', email: `khach-${uniq()}@gmail.com`,
    address_line: '12 Nguyễn Trãi, P.5', province: 'TP. Hồ Chí Minh', payment_method: 'cod', note: 'giao giờ hành chính' };
  const body = {}; for (const f of cfields) body[f] = prefill[f] ?? '';
  Object.assign(body, order);
  r = await co('/checkout/place', { method: 'POST', form: body });
  // Chống bot: submit quá nhanh → trang bảo "bấm Đặt hàng lại". Người thật bấm lại là xong;
  // bộ đo phải làm y vậy, nếu không sẽ báo nhầm là hỏng.
  if (/hơi nhanh/.test(visible(r.text))) {
    ok('chống bot: submit quá nhanh → yêu cầu bấm lại (không mất dữ liệu đã điền)');
    const again = {};
    for (const m of r.text.matchAll(/<input[^>]*>/g)) {
      const nm = /name="([^"]+)"/.exec(m[0])?.[1]; const val = /value="([^"]*)"/.exec(m[0])?.[1];
      if (nm && val !== undefined) again[nm] = val;
    }
    await sleep(3000);
    r = await co('/checkout/place', { method: 'POST', form: { ...body, ...again } });
  }
  const placed = await owner.query(`SELECT id, order_number, status, payment_status, total_vnd FROM orders WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 1`, [S.shopId]).catch(() => ({ rowCount: 0, rows: [] }));
  if (placed.rowCount) { ok(`đặt được đơn ${placed.rows[0].order_number} (${placed.rows[0].total_vnd}đ, ${placed.rows[0].status})`); S.order = placed.rows[0]; }
  else bad('KHÔNG đặt được đơn', `${r.status} ${visible(r.text).slice(0, 250)}`);

  // Đặt xong là 303 sang trang cảm ơn — mã tra cứu nằm TRONG URL đó (DB chỉ giữ bản băm,
  // đúng thiết kế). Người thật được trình duyệt đưa sang; bộ đo phải tự đi theo.
  if (r.status === 303 && r.loc) {
    const su = new URL(r.loc, 'http://x');
    S.lookup = su.searchParams.get('token'); S.num = su.searchParams.get('number');
    r = await co(r.loc.replace(/^https?:\/\/[^/]+/, ''));
    r.status === 200 ? ok('đi tiếp được sang trang cảm ơn') : bad('trang cảm ơn lỗi', String(r.status));
  }
  const succ = visible(r.text);
  if (S.order) {
    succ.includes(S.order.order_number) ? ok('trang cảm ơn hiện MÃ ĐƠN') : warn('trang cảm ơn không hiện mã đơn');
    (S.lookup && succ.includes(S.lookup)) ? ok(`trang cảm ơn hiện MÃ TRA CỨU (${S.lookup.slice(0,6)}…)`) : warn('trang cảm ơn không hiện mã tra cứu → khách mất đường quay lại');
    /đơn hàng|Đơn hàng/.test(succ) && /\d[\d.]*\s*(?:đ|₫)/.test(succ) ? ok('trang cảm ơn nhắc lại số tiền') : warn('trang cảm ơn không nhắc số tiền');
    /tra cứu|Tra cứu/i.test(succ) ? ok('có chỉ đường tra cứu đơn') : warn('không chỉ cách theo dõi đơn');
  }

  // Email xác nhận
  const mail = await owner.query(`SELECT topic FROM outbox WHERE payload->>'to'=$1 ORDER BY id DESC LIMIT 3`, [order.email]);
  mail.rowCount ? ok(`khách nhận email: ${mail.rows.map((m) => m.topic).join(', ')}`) : warn('KHÔNG có email xác nhận đơn cho khách');

  // Tồn kho phải giữ chỗ
  const inv = await owner.query('SELECT on_hand, reserved FROM inventory_levels WHERE variant_id=$1', [S.variantId]);
  inv.rows[0]?.reserved > 0 ? ok(`tồn được giữ chỗ: reserved=${inv.rows[0].reserved}`) : bad('đặt đơn xong KHÔNG giữ chỗ tồn → oversell', JSON.stringify(inv.rows[0]));

  // ── 5. Tra cứu đơn ───────────────────────────────────────────────────────
  sect('5. Khách tra cứu đơn');
  if (S.lookup) {
    r = await co(`/checkout/success?number=${S.num}&token=${encodeURIComponent(S.lookup)}`);
    r.status === 200 && r.text.includes(S.order.order_number) ? ok('tra cứu bằng mã → thấy đơn') : bad('tra cứu không ra đơn', String(r.status));
    const lv = visible(r.text);
    /trạng thái|Trạng thái|Chờ|Đang/i.test(lv) ? ok('tra cứu có hiện trạng thái đơn') : warn('tra cứu không nói trạng thái');
  } else warn('không có mã tra cứu để thử');

  // ── 6. Tài khoản khách ───────────────────────────────────────────────────
  sect('6. Tài khoản khách hàng');
  r = await ac('/account/login');
  r.status === 200 ? ok('có trang đăng nhập khách') : bad('không có trang đăng nhập khách', String(r.status));
  const cemail = `kh-${uniq()}@gmail.com`, cpw = 'mat khau khach dai';
  r = await ac('/account/register', { method: 'POST', form: { email: cemail, password: cpw, name: 'Trần Văn Bình' }, origin: ORIGIN });
  const cu = await owner.query(`SELECT id FROM customers WHERE shop_id=$1 AND email=$2`, [S.shopId, cemail]).catch(() => ({ rowCount: 0 }));
  cu.rowCount ? ok('khách tự tạo được tài khoản trên shop') : warn('không tạo được tài khoản khách', `${r.status} ${visible(r.text).slice(0, 150)}`);
  S.acct = sessionOf(r.sc) ?? cookieOf(r.sc, '__Host-csession');
  if (S.acct) {
    ok('đăng ký xong đăng nhập luôn');
    for (const p of ['/account', '/account/orders', '/account/addresses']) {
      const x = await ac(p);
      x.status === 200 ? ok(`trang ${p} mở được`) : warn(`trang ${p} → ${x.status}`);
    }
  } else warn('đăng ký xong KHÔNG tự đăng nhập — khách phải nhập lại');

  console.log(`\n  → shopId=${S.shopId} orderId=${S.order?.id} lookup=${S.order?.lookup_code} variant=${S.variantId}`);
  summary();
  await owner.end();
}
main().catch((e) => { console.error('VỠ:', e); process.exit(2); });
