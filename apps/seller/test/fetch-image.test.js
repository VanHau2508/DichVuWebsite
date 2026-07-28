/**
 * Unit test HÀNG RÀO SSRF của bộ tải ảnh theo URL (docs/45 §5).
 *   node --test apps/seller/test/fetch-image.test.js
 *
 * Vì sao là unit test chứ không chỉ e2e: phần phân loại địa chỉ là hàm THUẦN, và nó là chỗ
 * sai một dòng thì thủng. Test ở đây chạy trong mili-giây, KHÔNG chạm mạng, nên chạy được ở
 * mọi commit — còn e2e chỉ chạy trong stack docker.
 *
 * Các khẳng định "phải TỪ CHỐI" quan trọng hơn các khẳng định "phải cho qua": bỏ sót một
 * dải nội bộ là mở đường vào mạng nội bộ, còn chặn nhầm một dải công cộng chỉ làm một ảnh
 * không tải được.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicIPv4, isPublicIPv6, fetchRemoteImage, ImgError } from '../src/fetch-image.js';

test('IPv4: chặn mọi dải nội bộ/đặc biệt', () => {
  const chan = [
    '127.0.0.1', '127.1.2.3',            // loopback
    '10.0.0.1', '10.255.255.255',        // private A
    '172.16.0.1', '172.31.255.254',      // private B
    '192.168.0.1', '192.168.255.254',    // private C
    '169.254.169.254',                   // METADATA nhà cung cấp máy chủ — đích số 1 của SSRF
    '169.254.0.1',                       // link-local
    '100.64.0.1', '100.127.255.254',     // CGNAT
    '0.0.0.0', '0.1.2.3',                // "this network"
    '224.0.0.1', '239.1.1.1',            // multicast
    '240.0.0.1', '255.255.255.255',      // reserved / broadcast
    '192.0.0.1', '192.0.2.5',            // IETF protocol / TEST-NET-1
    '198.18.0.1', '198.19.0.1',          // benchmark
    '198.51.100.5', '203.0.113.5',       // TEST-NET-2/3
  ];
  for (const ip of chan) assert.equal(isPublicIPv4(ip), false, `phải chặn ${ip}`);
});

test('IPv4: cho qua địa chỉ công cộng thật', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1', '11.0.0.1']) {
    assert.equal(isPublicIPv4(ip), true, `phải cho qua ${ip}`);
  }
});

test('IPv4: chuỗi rác không được coi là công cộng', () => {
  for (const junk of ['', 'abc', '1.2.3', '1.2.3.4.5', '999.1.1.1', '-1.0.0.1', '1.2.3.x', '01.02.03.04.05']) {
    assert.equal(isPublicIPv4(junk), false, `phải chặn "${junk}"`);
  }
});

test('IPv6: chặn loopback/ULA/link-local/multicast', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1']) {
    assert.equal(isPublicIPv6(ip), false, `phải chặn ${ip}`);
  }
});

test('IPv6: chặn các dạng BỌC IPv4 — chỗ hay quên nhất', () => {
  const chan = [
    '::ffff:127.0.0.1',        // IPv4-mapped thập phân
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',  // metadata qua đường IPv6
    '::127.0.0.1',             // IPv4-compatible
    '::ffff:7f00:1',           // IPv4-mapped dạng HEX = 127.0.0.1
    '::ffff:a9fe:a9fe',        // = 169.254.169.254
    '2002:7f00:1::1',          // 6to4 bọc IPv4
    '64:ff9b::7f00:1',         // NAT64
  ];
  for (const ip of chan) assert.equal(isPublicIPv6(ip), false, `phải chặn ${ip}`);
  assert.equal(isPublicIPv6('2606:4700:4700::1111'), true, 'IPv6 công cộng vẫn phải qua');
  assert.equal(isPublicIPv6('::ffff:8.8.8.8'), true, 'IPv4 công cộng bọc IPv6 vẫn phải qua');
});

test('URL: chặn scheme ngoài http/https', async () => {
  for (const u of ['file:///etc/passwd', 'gopher://x/', 'data:image/png;base64,AAAA', 'ftp://x/a.png', 'javascript:1']) {
    await assert.rejects(() => fetchRemoteImage(u), (e) => e instanceof ImgError && e.code === 'scheme' || e.code === 'url_invalid', `phải chặn ${u}`);
  }
});

test('URL: chặn user:pass@ (đánh lừa người đọc log)', async () => {
  await assert.rejects(() => fetchRemoteImage('http://anhdep.com@10.0.0.1/a.png'),
    (e) => e.code === 'userinfo' || e.code === 'blocked');
});

test('URL: chặn cổng ngoài 80/443 (không làm máy quét cổng)', async () => {
  for (const u of ['http://example.com:22/a.png', 'http://example.com:6379/a.png', 'https://example.com:5432/a.png']) {
    await assert.rejects(() => fetchRemoteImage(u), (e) => e.code === 'port', `phải chặn ${u}`);
  }
});

test('URL: chặn IP nội bộ viết thẳng, KHÔNG phát ra kết nối nào', async () => {
  for (const u of ['http://127.0.0.1/a.png', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/a.png',
                   'http://[::1]/a.png', 'http://192.168.1.1/a.png']) {
    await assert.rejects(() => fetchRemoteImage(u, { timeoutMs: 300 }), (e) => e.code === 'blocked', `phải chặn ${u}`);
  }
});

test('URL: tên miền phân giải về loopback bị chặn', async () => {
  // localhost phân giải về 127.0.0.1 / ::1 — phải chặn dù không phải IP viết thẳng.
  await assert.rejects(() => fetchRemoteImage('http://localhost/a.png', { timeoutMs: 300 }),
    (e) => e.code === 'blocked' || e.code === 'dns');
});

test('URL rác → url_invalid, không ném ra lỗi lạ', async () => {
  for (const u of ['', 'không phải url', '://', 'http://']) {
    await assert.rejects(() => fetchRemoteImage(u), (e) => e instanceof ImgError);
  }
});
