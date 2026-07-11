import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc16, buildVietQR, verifyVietQR } from '../src/vietqr.js';

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
