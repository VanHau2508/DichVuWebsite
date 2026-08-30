import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crc16, buildVietQR, verifyVietQR } from '../src/vietqr.js';

const checkoutSource = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const pagesSource = readFileSync(new URL('../src/pages.js', import.meta.url), 'utf8');
// Bộ unit này vốn chạy được trên máy chưa `npm install`. Nạp đúng mã render qua data URL và
// thay hai import không liên quan tới HTML đang kiểm, thay vì biến một unit thuần thành test
// phụ thuộc package `qrcode` trên máy host.
const pagesUnderTest = import(`data:text/javascript;base64,${Buffer.from(pagesSource
  .replace("import QRCode from 'qrcode';", "const QRCode = { toString: async () => '' };")
  .replace("import { PROVINCES } from './provinces.js';", "const PROVINCES = ['Hà Nội'];"), 'utf8').toString('base64')}`);
const summary = (policy) => ({
  items: [{ variant_id: 'v1', product_title: 'Áo thử', variant_title: 'M', qty: 1, unit_price_vnd: 100000, line_total_vnd: 100000 }],
  subtotal_vnd: 100000,
  shipping_vnd: 30000,
  discount_vnd: 0,
  points_discount_vnd: 0,
  total_vnd: 130000,
  loyalty: { balance: 500, per_point_vnd: 100, max_points: 500, applied_points: 0 },
  checkout_policy: policy,
});

test('CRC-16/CCITT-FALSE khớp vector chuẩn', () => {
  // Giá trị kiểm chuẩn của CRC-16/CCITT-FALSE cho "123456789".
  assert.equal(crc16('123456789'), 0x29b1);
});

test('VietQR: chứa BIN, tài khoản, số tiền, nội dung, và CRC hợp lệ', () => {
  const qr = buildVietQR({ bankBin: '970415', accountNumber: '0011002345678', amountVnd: 530000, content: 'NTGABC123' });
  assert.ok(qr.includes('970415'), 'chứa bank BIN');
  assert.ok(qr.includes('0011002345678'), 'chứa số tài khoản');
  assert.ok(qr.includes('530000'), 'chứa số tiền');
  assert.ok(qr.includes('NTGABC123'), 'chứa nội dung/mã đối soát');
  assert.ok(qr.startsWith('000201'), 'bắt đầu bằng payload format + method');
  assert.ok(verifyVietQR(qr), 'CRC hợp lệ');
});

test('sửa một ký tự → CRC không còn hợp lệ', () => {
  const qr = buildVietQR({ bankBin: '970415', accountNumber: '0011002345678', amountVnd: 100000, content: 'NTGX' });
  const tampered = qr.slice(0, 10) + (qr[10] === '9' ? '8' : '9') + qr.slice(11);
  assert.equal(verifyVietQR(tampered), false);
});

test('số tiền khác → chuỗi QR khác', () => {
  const a = buildVietQR({ bankBin: '970415', accountNumber: '123', amountVnd: 100000, content: 'X' });
  const b = buildVietQR({ bankBin: '970415', accountNumber: '123', amountVnd: 200000, content: 'X' });
  assert.notEqual(a, b);
});

test('external-master không mời áp coupon/đổi điểm nhưng shop local giữ nguyên', async () => {
  const { renderCart } = await pagesUnderTest;
  const local = renderCart('Shop', summary({ external_master: false, discounts_allowed: true, cod_only: false }));
  assert.match(local, /action="\/cart\/coupon"/);
  assert.match(local, /action="\/cart\/points"/);

  const external = renderCart('Shop', summary({ external_master: true, discounts_allowed: false, cod_only: true }));
  assert.doesNotMatch(external, /action="\/cart\/(?:coupon|points)"/);
  assert.match(external, /Ưu đãi đang tạm khóa/);
  assert.match(external, /130\.000₫/);
});

test('external-master chỉ hiện COD dù shop đã bật QR; shop local vẫn hiện cả hai', async () => {
  const { renderCheckout } = await pagesUnderTest;
  const opts = { formTs: 'signed', qrEnabled: true };
  const local = renderCheckout('Shop', summary({ external_master: false, discounts_allowed: true, cod_only: false }), 'idem-local', opts);
  assert.match(local, /name="payment_method" value="cod"/);
  assert.match(local, /name="payment_method" value="qr"/);

  const external = renderCheckout('Shop', summary({ external_master: true, discounts_allowed: false, cod_only: true }), 'idem-external', opts);
  assert.match(external, /name="payment_method" value="cod"/);
  assert.doesNotMatch(external, /name="payment_method" value="qr"/);
  assert.match(external, /Ưu đãi đang tạm khóa/);
  assert.match(external, /chỉ hỗ trợ COD trong giai đoạn pilot/);
});

test('nút GPS không trở thành nút chết khi tắt JavaScript', async () => {
  const { renderCheckout } = await pagesUnderTest;
  const summaryLocal = summary({ external_master: false, discounts_allowed: true, cod_only: false });
  const html = renderCheckout('Shop', summaryLocal, 'idem-gps', { gps: true, nonce: 'nonce-gps' });

  // GPS chỉ có tác dụng khi script chạy; hidden SSR giữ no-JS checkout không mời bấm một
  // control không thể hoạt động. Script chỉ mở lại control sau khi browser có geolocation.
  assert.match(html, /\[hidden\]\{display:none!important\}/);
  assert.match(html, /<button[^>]*id="use-gps"[^>]*\shidden(?:\s|>)/);
  assert.match(html, /<div[^>]*id="gps-hint"[^>]*\shidden(?:\s|>)/);
  assert.match(html, /btn\.hidden=false; if\(hint\) hint\.hidden=false;/);
});

test('policy ưu đãi KiotViet là một nguồn server-side và fail-closed theo boolean thật', () => {
  assert.match(checkoutSource, /function policyTuConnector\([^)]+\)[\s\S]*?preserve_line_price === true;/);
  assert.match(checkoutSource, /const policy = knownPolicy \?\? await checkoutPolicy\(c\);/);
  assert.match(checkoutSource, /policy\.discounts_allowed && cc \? await resolveCoupon/);
  assert.match(checkoutSource, /if \(customerId && policy\.discounts_allowed\)/);
  assert.match(checkoutSource, /if \(clean && !policy\.discounts_allowed\)/);
  assert.match(checkoutSource, /if \(want > 0 && !policy\.discounts_allowed\)/);
  assert.match(checkoutSource, /!policy\.discounts_allowed && storedCoupon && f\.expectedGiam == null/);
  assert.match(checkoutSource, /f\.pointsRedeem == null && requestedPoints > 0 && !policy\.discounts_allowed && f\.expectedGiam == null/);
  assert.match(checkoutSource, /const cc = policy\.discounts_allowed \? storedCoupon : null;/);
  assert.match(checkoutSource, /const want = policy\.discounts_allowed \? requestedPoints : 0;/);
  assert.match(checkoutSource, /policy\.cod_only && paymentMethod !== 'cod'[\s\S]*?qr_unavailable: true/);
});
