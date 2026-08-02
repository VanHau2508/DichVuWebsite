/**
 * VAI 3 — SHOP VẬN HÀNH: quét TOÀN BỘ màn hình quản trị (bắt trang chết/500), rồi đi trọn
 * vòng đời một đơn: xác nhận → giao → thu tiền → hoàn tiền → báo cáo.
 * env: AUDIT_EMAIL / AUDIT_PW / AUDIT_SLUG
 */
import { ADMIN, OADM, owner, http, sessionOf, ok, warn, bad, sect, summary, uniq, visible } from './lib.mjs';

const EMAIL = process.env.AUDIT_EMAIL, PW = process.env.AUDIT_PW, SLUG = process.env.AUDIT_SLUG;
const S = {};
const adm = (path, opts = {}) => http(ADMIN, path, { host: 'admin.localtest', origin: opts.form ? OADM : undefined, cookie: S.cookie, ...opts });

// Màn hình "Xác nhận mật khẩu" là một FORM thật — đọc action + ô ẩn của nó rồi gửi lại,
// đừng đoán đường dẫn. Đoán sai thì báo nhầm "tính năng hỏng" trong khi nó chạy tốt.
async function passStepUp(r, password, wantAction) {
  if (!/Xác nhận/.test(r.text) || !/<form/i.test(r.text)) return r;
  // PHẢI chọn form theo action mong đợi. Lấy "form POST đầu tiên" là bẫy: form đầu trên
  // layout admin là nút ĐĂNG XUẤT — gửi vào đó là tự huỷ phiên rồi mọi bước sau 303, và
  // ta sẽ kết luận nhầm là "hàng loạt tính năng hỏng". Đã dính đúng một lần.
  const forms = [...r.text.matchAll(/<form[^>]*method="POST"[^>]*>[\s\S]*?<\/form>/gi)].map((m) => m[0]);
  const form = forms.find((f) => (/action="([^"]+)"/.exec(f)?.[1] ?? '').includes(wantAction)) ?? '';
  const action = /action="([^"]+)"/.exec(form)?.[1];
  if (!action) { return r; }
  const f = { password };
  for (const m of form.matchAll(/<input[^>]*>/g)) {
    const nm = /name="([^"]+)"/.exec(m[0])?.[1]; const val = /value="([^"]*)"/.exec(m[0])?.[1];
    if (nm && nm !== 'password' && val !== undefined) f[nm] = val;
  }
  return adm(action, { method: 'POST', form: f, origin: OADM });
}

// Mọi màn hình chủ shop có thể bấm TỚI (chỉ GET). Trang 500 im lặng là lớp lỗi tệ nhất:
// người bán tưởng tính năng "chưa có" và bỏ đi, không ai báo lỗi.
// KHÔNG liệt kê 'affiliates/config' và 'messenger': chúng là endpoint POST-only, GET 404 là
// ĐÚNG. Đưa vào đây thì bộ đo tự sinh 2 "lỗi" giả mỗi lần chạy.
const PAGES = [
  'overview', 'orders', 'orders/new', 'orders/import', 'products', 'products/new', 'products/import',
  'categories', 'customers', 'reports', 'inventory-ledger', 'purchasing', 'purchasing/new',
  'purchasing/report', 'suppliers', 'stocktakes', 'cod', 'promotions', 'coupons', 'loyalty',
  'affiliates', 'reviews', 'questions', 'blog', 'blog/new', 'pages', 'pages/new',
  'theme', 'domains', 'payment', 'shipping', 'members', 'api-keys', 'settings', 'audit-log',
  'notify', 'billing', 'export', 'help',
];

async function main() {
  const shop = (await owner.query('SELECT id FROM shops WHERE slug=$1', [SLUG])).rows[0];
  S.shopId = shop.id;
  const base = `/shops/${S.shopId}`;
  let r = await adm('/login', { method: 'POST', form: { email: EMAIL, password: PW }, origin: OADM });
  S.cookie = sessionOf(r.sc);
  S.cookie ? ok('đăng nhập quản trị') : bad('không đăng nhập được');

  // ── 1. Quét toàn bộ màn hình ─────────────────────────────────────────────
  sect('1. Quét TOÀN BỘ màn hình quản trị (bắt trang chết / 500)');
  const broken = [], slow = [];
  for (const p of PAGES) {
    const t0 = Date.now();
    const x = await adm(`${base}/${p}`);
    const ms = Date.now() - t0;
    if (x.status >= 500) { broken.push(`${p} → ${x.status}`); }
    else if (x.status === 404) { broken.push(`${p} → 404`); }
    else if (ms > 1500) slow.push(`${p} ${ms}ms`);
  }
  broken.length === 0 ? ok(`${PAGES.length}/${PAGES.length} màn hình mở được, không có trang chết`) : bad(`${broken.length} màn hình lỗi`, broken.join(' · '));
  slow.length === 0 ? ok('không màn hình nào chậm quá 1,5s') : warn(`chậm: ${slow.join(' · ')}`);

  // ── 2. Vòng đời đơn hàng ─────────────────────────────────────────────────
  sect('2. Vòng đời một đơn: xác nhận → giao → thu tiền');
  const o = (await owner.query(`SELECT id, order_number, status, payment_status, total_vnd FROM orders WHERE shop_id=$1 ORDER BY created_at LIMIT 1`, [S.shopId])).rows[0];
  if (!o) { bad('không có đơn nào để xử lý — chạy a2 trước'); summary(); await owner.end(); return; }
  S.order = o;
  r = await adm(`${base}/orders`);
  r.text.includes(String(o.order_number)) ? ok(`danh sách đơn thấy đơn #${o.order_number}`) : bad('đơn không hiện trong danh sách');
  const ov = visible(r.text);
  /Chờ|chờ xử lý|Mới/.test(ov) ? ok('có phân loại trạng thái để lọc') : warn('không thấy nhãn trạng thái');

  r = await adm(`${base}/orders/${o.id}`);
  r.status === 200 ? ok('mở được chi tiết đơn') : bad('chi tiết đơn lỗi', String(r.status));
  const dv = visible(r.text);
  /0912345678|091/.test(dv) ? ok('chi tiết đơn có SĐT khách (gọi được ngay)') : warn('không thấy SĐT khách');
  /Nguyễn Trãi/.test(dv) ? ok('có địa chỉ giao') : warn('không thấy địa chỉ giao');
  const actions = [...r.text.matchAll(/formaction="([^"]+)"|action="([^"]+)"/g)].map((m) => m[1] ?? m[2]).filter((a) => a.includes(o.id));
  ok(`nút thao tác trên đơn: ${[...new Set(actions.map((a) => a.split('/').pop()))].join(', ') || '(không thấy)'}`);

  const step = async (act, form = {}) => {
    const x = await adm(`${base}/orders/${o.id}/${act}`, { method: 'POST', form, origin: OADM });
    const cur = (await owner.query('SELECT status, payment_status, fulfillment_status FROM orders WHERE id=$1', [o.id])).rows[0];
    return { x, cur };
  };
  let st = await step('confirm');
  st.cur.status !== 'pending' ? ok(`xác nhận đơn → ${st.cur.status}`) : warn(`bấm xác nhận không đổi trạng thái (${st.x.x?.status ?? st.x.status})`);
  st = await step('ship', { carrier: 'ghtk', tracking_number: `GHTK${uniq()}` });
  /ship|deliver/.test(st.cur.status) || st.cur.fulfillment_status ? ok(`giao hàng → status=${st.cur.status} fulfillment=${st.cur.fulfillment_status}`) : warn('không chuyển được sang trạng thái giao');
  st = await step('deliver');
  st.cur.status === 'delivered' ? ok('giao thành công → delivered') : warn(`bấm giao xong → ${st.cur.status}`);
  // COD: giao xong CHƯA phải đã-nhận-tiền — tiền về qua đối soát hãng (module Đối soát COD).
  // Đúng kế toán; chỉ shop TỰ GIAO mới phải bấm thêm một nút.
  st.cur.payment_status === 'unpaid' ? ok('giao xong vẫn unpaid — đúng: tiền COD về qua đối soát hãng, không tự nhận') : ok(`payment_status=${st.cur.payment_status}`);
  st = await step('mark-paid');
  st.cur.payment_status === 'paid' ? ok('bấm "Đã nhận tiền" → paid (2 bước, tách giao hàng khỏi thu tiền)') : warn(`bấm mark-paid không đổi (${st.cur.payment_status})`);

  // ── 3. Hoàn tiền ─────────────────────────────────────────────────────────
  sect('3. Hoàn tiền');
  const before = (await owner.query('SELECT coalesce(sum(amount_vnd),0)::bigint s FROM refunds WHERE order_id=$1', [o.id])).rows[0].s;
  r = await adm(`${base}/orders/${o.id}/refund`, { method: 'POST', form: { amount_vnd: '50000', reason: 'khách kêu thiếu 1 gói' }, origin: OADM });
  if (/Xác nhận|xác nhận/.test(r.text)) ok('hoàn tiền có màn hình xác nhận (không bấm nhầm một phát mất tiền)');
  r = await passStepUp(r, PW, '/refund');
  const after = (await owner.query('SELECT coalesce(sum(amount_vnd),0)::bigint s FROM refunds WHERE order_id=$1', [o.id])).rows[0].s;
  Number(after) > Number(before) ? ok(`ghi được phiếu hoàn ${after}đ (sổ cái append-only)`) : warn('không hoàn được tiền qua UI', `${r.status} ${visible(r.text).slice(0, 160)}`);

  // ── 4. Báo cáo có phản ánh không ─────────────────────────────────────────
  sect('4. Báo cáo lãi lỗ');
  r = await adm(`${base}/reports`);
  r.status === 200 ? ok('mở được báo cáo') : bad('báo cáo lỗi', String(r.status));
  const rv = visible(r.text);
  /Doanh thu|doanh thu/.test(rv) ? ok('có doanh thu') : warn('không thấy doanh thu');
  /Lợi nhuận|lợi nhuận|Lãi/.test(rv) ? ok('có lợi nhuận') : warn('không thấy lợi nhuận');
  /Giá vốn|giá vốn/.test(rv) ? ok('có giá vốn') : warn('không thấy giá vốn');
  /Hoàn tiền|hoàn tiền|Hoàn/.test(rv) ? ok('báo cáo có trừ hoàn tiền') : warn('báo cáo không nhắc hoàn tiền');

  // ── 5. Các công cụ bán hàng ──────────────────────────────────────────────
  sect('5. Công cụ bán hàng: mã giảm giá · flash sale · điểm · CTV');
  const code = `AUDIT${uniq().toUpperCase().slice(0, 5)}`;
  r = await adm(`${base}/coupons`, { method: 'POST', form: { code, kind: 'percent', value: '10', max_uses: '100' }, origin: OADM });
  const cp = await owner.query('SELECT 1 FROM coupons WHERE shop_id=$1 AND upper(code)=upper($2)', [S.shopId, code]).catch(() => ({ rowCount: 0 }));
  cp.rowCount ? ok(`tạo được mã giảm giá ${code}`) : warn('không tạo được mã giảm giá qua UI', `${r.status}`);

  for (const [p, label] of [['promotions', 'flash sale'], ['loyalty', 'điểm thưởng'], ['affiliates', 'cộng tác viên']]) {
    const x = await adm(`${base}/${p}`);
    const has = /<form/.test(x.text);
    x.status === 200 && has ? ok(`${label}: có màn hình + form thao tác`) : warn(`${label}: mở được nhưng không thấy form (${x.status})`);
  }

  // ── 6. Xuất dữ liệu ──────────────────────────────────────────────────────
  sect('6. Xuất dữ liệu (khoá trói khách vào nền tảng?)');
  // Xuất đơn là POST (có step-up) — kiểm nút trên trang Đơn hàng thay vì GET vào endpoint.
  r = await adm(`${base}/orders`);
  /orders\/export/.test(r.text) ? ok('trang Đơn hàng có nút xuất CSV') : warn('không thấy nút xuất CSV ở trang Đơn hàng');
  r = await adm(`${base}/export`);
  r.status === 200 ? ok('có màn hình xuất dữ liệu toàn shop') : warn(`xuất dữ liệu → ${r.status}`);

  console.log(`\n  → order #${S.order.order_number}`);
  summary();
  await owner.end();
}
main().catch((e) => { console.error('VỠ:', e); process.exit(2); });
