/**
 * DỰNG LẠI: tồn kho "SỐNG LẠI" khi tái dùng biến thể cho tổ hợp mới.
 *
 * catalog.js hạ `on_hand = reserved` khi lấy một biến thể cũ ra dùng cho tổ hợp MỚI —
 * đúng khi đọc riêng: phần BÁN ĐƯỢC về 0, mà vẫn giữ reserve của đơn đang chờ (ràng buộc
 * CHECK reserved<=on_hand). Nhưng khi đơn đó bị huỷ/hết hạn, đường nhả chỗ chỉ hạ `reserved`
 * và KHÔNG đụng `on_hand` → available = on_hand − reserved bật lại thành số cũ.
 * Tức tổ hợp mới tự nhiên có tồn bán được, bằng đúng số hàng của tổ hợp CŨ.
 * env: AUDIT_SLUG / AUDIT_EMAIL / AUDIT_PW
 */
import { SELLER, AUTH, OS, OA, owner, http, sessionOf, ok, warn, bad, sect, summary, uniq } from './lib.mjs';

const EMAIL = process.env.AUDIT_EMAIL, PW = process.env.AUDIT_PW, SLUG = process.env.AUDIT_SLUG;
const S = {};
const api = (p, o = {}) => http(SELLER, p, { cookie: S.ck, origin: o.body !== undefined ? OS : undefined, ...o });
const q1 = async (sql, a) => (await owner.query(sql, a)).rows[0];
const ton = async (vid) => q1('SELECT on_hand, reserved, (on_hand-reserved) AS ban_duoc FROM inventory_levels WHERE variant_id=$1', [vid]);

async function main() {
  S.shopId = (await q1('SELECT id FROM shops WHERE slug=$1', [SLUG])).id;
  S.ck = sessionOf((await http(AUTH, '/auth/login', { method: 'POST', body: { email: EMAIL, password: PW }, origin: OA, host: 'auth.localtest' })).sc);
  S.ck ? ok('đăng nhập chủ shop') : bad('không đăng nhập được');

  sect('Tồn "sống lại": đổi tổ hợp biến thể trong lúc có đơn đang giữ chỗ');
  // 1) SP có 1 trục "Màu" = Đỏ/Xanh
  const pr = await api(`/shops/${S.shopId}/products`, { method: 'POST', body: {
    title: `Áo test ${uniq()}`, slug: `ao-${uniq()}`, price_vnd: 100000, status: 'active', variants: [{ price_vnd: 100000 }] } });
  if (pr.status !== 201) { bad(`tạo SP lỗi ${pr.status}`, pr.text.slice(0, 160)); summary(); await owner.end(); return; }
  const pid = pr.json.id;
  let r = await api(`/shops/${S.shopId}/products/${pid}/options`, { method: 'PUT', body: {
    options: [{ name: 'Màu', values: ['Đỏ', 'Xanh'] }] } });
  if (r.status !== 200) { bad(`đặt tổ hợp lỗi ${r.status}`, r.text.slice(0, 160)); summary(); await owner.end(); return; }
  const vs = (await api(`/shops/${S.shopId}/products/${pid}`)).json.variants;
  const vDo = vs.find((v) => /Đỏ/.test(v.title ?? ''));
  ok(`SP có ${vs.length} biến thể: ${vs.map((v) => v.title).join(' · ')}`);

  // 2) Nhập 10 cái màu Đỏ
  await api(`/shops/${S.shopId}/variants/${vDo.id}/inventory/adjust`, { method: 'POST', body: { delta: 10, reason: 'nhập hàng' } });
  // 3) Khách đặt 3 cái Đỏ → giữ chỗ 3
  const od = await api(`/shops/${S.shopId}/orders`, { method: 'POST', body: {
    idempotency_key: `a11-${uniq()}-${uniq()}`,
    customer: { name: 'Khách A', phone: '0918887777', address_line: '5 Lý Thường Kiệt', province: 'Hà Nội' },
    payment_method: 'cod', lines: [{ variant_id: vDo.id, qty: 3 }] } });
  if (od.status !== 201) { bad(`tạo đơn lỗi ${od.status}`, od.text.slice(0, 160)); summary(); await owner.end(); return; }
  const oid = od.json.id ?? od.json.order?.id;
  let t = await ton(vDo.id);
  ok(`nhập 10, khách đặt 3 → tồn ${t.on_hand} / giữ chỗ ${t.reserved} / bán được ${t.ban_duoc}`);

  // 4) ĐỔI TRỤC LẦN 1 → biến thể cũ chỉ thành MỒ CÔI (pool dựng TRƯỚC khi xoá options nên
  //    lần này chúng chưa nằm trong pool). Mồ côi đã có cơ chế ẩn khỏi bán — chưa phải lỗi.
  r = await api(`/shops/${S.shopId}/products/${pid}/options`, { method: 'PUT', body: {
    options: [{ name: 'Size', values: ['S', 'M'] }] } });
  if (r.status !== 200) { warn(`đổi tổ hợp lần 1 → HTTP ${r.status}`, r.text.slice(0, 160)); summary(); await owner.end(); return; }
  t = await ton(vDo.id);
  ok(`đổi trục lần 1 → biến thể cũ thành MỒ CÔI, giữ nguyên tồn ${t.on_hand}/giữ ${t.reserved} (bị ẩn khỏi bán)`);

  // 4b) ĐỔI TRỤC LẦN 2 → giờ mồ côi lần trước MỚI vào pool và bị tái dùng cho tổ hợp mới.
  //     Đây là lúc nhánh `on_hand = reserved` chạy.
  r = await api(`/shops/${S.shopId}/products/${pid}/options`, { method: 'PUT', body: {
    options: [{ name: 'Chất liệu', values: ['Cotton', 'Len'] }] } });
  if (r.status !== 200) { warn(`đổi tổ hợp lần 2 → HTTP ${r.status}`, r.text.slice(0, 160)); summary(); await owner.end(); return; }
  // Biến thể cũ giờ ở một trong hai tình trạng — PHẢI phân biệt, vì "còn tồn" chỉ đáng lo
  // ở tình trạng thứ nhất. Mồ côi = không có dòng variant_option_values nào.
  const soTruc = Number((await q1(`SELECT count(*)::int n FROM variant_option_values WHERE variant_id=$1`, [vDo.id])).n);
  const taiDung = soTruc > 0;
  t = await ton(vDo.id);
  ok(`sau lần đổi 2: biến thể cũ ${taiDung ? 'BỊ TÁI DÙNG cho tổ hợp mới' : 'vẫn là MỒ CÔI (không tái dùng)'} — tồn ${t.on_hand}/giữ ${t.reserved}/bán được ${t.ban_duoc}`);

  // 5) Đơn cũ bị HUỶ → nhả chỗ. on_hand KHÔNG đổi → bán được bật lại?
  const rc = await api(`/shops/${S.shopId}/orders/${oid}/cancel`, { method: 'POST', body: {} });
  if (rc.status !== 200) { warn(`huỷ đơn → HTTP ${rc.status}`, rc.text.slice(0, 140)); summary(); await owner.end(); return; }
  t = await ton(vDo.id);

  if (taiDung) {
    Number(t.ban_duoc) === 0
      ? ok(`huỷ đơn → bán được vẫn 0 (tồn ${t.on_hand}/giữ ${t.reserved})`)
      : bad(`TỒN SỐNG LẠI: huỷ đơn xong tổ hợp mới tự có ${t.ban_duoc} hàng bán được`,
        `tồn ${t.on_hand}/giữ ${t.reserved} — số hàng này là của tổ hợp CŨ. Bán ra là oversell.`);
  } else {
    // Không tái dùng → biến thể giữ nguyên tồn, NHƯNG phải THẬT SỰ không bán được.
    // KIỂM chứ không tin: thử đặt đơn thẳng vào nó qua API.
    const thu = await api(`/shops/${S.shopId}/orders`, { method: 'POST', body: {
      idempotency_key: `a11x-${uniq()}-${uniq()}`,
      customer: { name: 'Khách B', phone: '0918887777', address_line: '5 Lý Thường Kiệt', province: 'Hà Nội' },
      payment_method: 'cod', lines: [{ variant_id: vDo.id, qty: 1 }] } });
    thu.status !== 201
      ? ok(`biến thể mồ côi giữ ${t.on_hand} tồn nhưng KHÔNG bán được (đặt thử → HTTP ${thu.status}: ${thu.json?.error ?? ''})`)
      : bad(`MỒ CÔI VẪN BÁN ĐƯỢC: đặt được đơn cho biến thể không thuộc tổ hợp nào`, `HTTP 201, tồn ${t.on_hand}`);
  }

  console.log(`\n  → SP=${pid} biến thể=${vDo.id} đơn=${oid}`);
  summary();
  await owner.end();
}
main().catch((e) => { console.error('VỠ:', e); process.exit(2); });
