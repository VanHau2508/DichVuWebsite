// Unit thuần (không DB/Redis/SMTP): quy tắc auth/TLS của buildSmtpOptions.
// Chạy: node --test apps/worker/test/smtp-options.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSmtpOptions } from '../src/smtp.js';

test('dev Mailpit (không SMTP_USER) → không auth, không requireTLS, secure=false', () => {
  const o = buildSmtpOptions({});
  assert.equal(o.host, 'mailpit');
  assert.equal(o.port, 1025);
  assert.equal(o.secure, false);
  assert.equal(o.auth, undefined);
  assert.equal(o.requireTLS, undefined);
});

test('relay thật cổng 587 → auth + ÉP STARTTLS (requireTLS)', () => {
  const o = buildSmtpOptions({ SMTP_HOST: 'smtp.resend.com', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASSWORD: 'p' });
  assert.deepEqual(o.auth, { user: 'u', pass: 'p' });
  assert.equal(o.secure, false);
  assert.equal(o.requireTLS, true);
});

test('cổng 465 → TLS ngầm (secure=true), không cần requireTLS', () => {
  const o = buildSmtpOptions({ SMTP_PORT: '465', SMTP_USER: 'u', SMTP_PASSWORD: 'p' });
  assert.equal(o.secure, true);
  assert.equal(o.requireTLS, undefined);
  assert.deepEqual(o.auth, { user: 'u', pass: 'p' });
});

test('SMTP_SECURE=true ép TLS ngầm trên cổng bất kỳ', () => {
  const o = buildSmtpOptions({ SMTP_PORT: '587', SMTP_SECURE: 'true', SMTP_USER: 'u' });
  assert.equal(o.secure, true);
  assert.equal(o.requireTLS, undefined);
});

test('465 KHÔNG auth (relay nội bộ) → secure vẫn true, không auth', () => {
  const o = buildSmtpOptions({ SMTP_PORT: '465' });
  assert.equal(o.secure, true);
  assert.equal(o.auth, undefined);
});
