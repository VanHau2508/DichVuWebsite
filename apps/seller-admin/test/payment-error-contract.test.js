import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const server = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'server.js'), 'utf8');

function thanHam(ten, tenHamSau) {
  const batDau = server.indexOf(`async function ${ten}(`);
  const ketThuc = server.indexOf(`async function ${tenHamSau}(`, batDau);
  assert.ok(batDau >= 0 && ketThuc > batDau, `phải tìm thấy thân hàm ${ten}`);
  return server.slice(batDau, ketThuc);
}

test('lỗi nghiệp vụ tiền ưu tiên message, sau đó error và nối hành động tiếp theo', () => {
  const batDau = server.indexOf('function paymentApiError(');
  const ketThuc = server.indexOf('function legacyPaymentBody(', batDau);
  assert.ok(batDau >= 0 && ketThuc > batDau, 'phải có helper lỗi dùng chung cho nghiệp vụ tiền');
  const helper = server.slice(batDau, ketThuc);
  assert.match(helper, /r\.json\?\.message \?\? r\.json\?\.error \?\? fallback/);
  assert.match(helper, /r\.json\?\.action \? `\$\{message\} \$\{r\.json\.action\}` : message/);
});

test('ghi nhận tiền thủ công và đảo giao dịch không làm mất hướng xử lý', () => {
  const ghiNhan = thanHam('doPaymentLedgerManual', 'paymentLedgerManual');
  const daoGiaoDich = thanHam('doPaymentLedgerReverse', 'paymentLedgerReverse');
  assert.match(ghiNhan, /paymentApiError\(r, 'Không ghi nhận được khoản thu\.'\)/);
  assert.match(daoGiaoDich, /paymentApiError\(r, 'Không điều chỉnh được khoản thu\.'\)/);
  assert.doesNotMatch(ghiNhan, /r\.json\?\.error \?\?/);
  assert.doesNotMatch(daoGiaoDich, /r\.json\?\.error \?\?/);
});

test('xác nhận QR và hoàn tiền giữ nguyên message cùng action của seller', () => {
  const qr = thanHam('doMarkPaidQr', 'markPaidQrConfirm');
  const hoanTien = thanHam('doRefund', 'refundConfirm');
  assert.match(qr, /paymentApiError\(r, 'Không xác nhận được thanh toán\.'\)/);
  assert.match(hoanTien, /paymentApiError\(r, 'Không hoàn tiền được\.'\)/);
  assert.doesNotMatch(qr, /r\.json\?\.error \?\?/);
  assert.doesNotMatch(hoanTien, /r\.json\?\.error \?\?/);
});
