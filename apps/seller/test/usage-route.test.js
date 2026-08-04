// UNIT: chuẩn hoá đường dẫn cho ĐO LUỒNG DÙNG (0141) + 10 bản obs.js phải khớp từng ký tự.
//
// VÌ SAO ĐÁNG MỘT BỘ RIÊNG. Toàn bộ giá trị của bảng feature_usage nằm ở một chỗ: `route` phải
// là MẪU, không bao giờ là đường dẫn thật. Lọt một id thật vào là bảng nổ theo số shop, mọi
// phép gộp thành vô nghĩa, và không ai phát hiện cho tới lúc mở trang ra thấy 40.000 dòng.
//
// E2E không bắt được lớp này: nó chỉ đi qua vài đường dẫn có thật của shop test, còn hình dạng
// nguy hiểm (slug tiếng Việt, đường 12 tầng, ký tự lạ, số thứ tự đơn) thì không dựng nổi đủ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { routeTemplate } from '../src/obs.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');

test('id thật KHÔNG BAO GIỜ lọt vào mẫu route', () => {
  const uuid = '9f3c1b2a-4d5e-6f70-8192-a3b4c5d6e7f8';
  const cases = [
    [`/shops/${uuid}/inventory/safety`, '/shops/:id/inventory/safety'],
    [`/shops/${uuid}/variants/${uuid}/inventory/adjust`, '/shops/:id/variants/:id/inventory/adjust'],
    ['/orders/12345', '/orders/:n'],
    ['/p/ao-thun-trang-form-rong', '/p/:slug'],
    ['/c/thoi-trang-nam', '/c/:slug'],
    ['/pages/chinh-sach-doi-tra', '/pages/:slug'],
    ['/blog/meo-chon-size', '/blog/:slug'],
  ];
  for (const [input, want] of cases) {
    const got = routeTemplate(input).route;
    assert.equal(got, want, `${input} → ${got}`);
    assert.ok(!got.includes(uuid), `${input}: uuid LỌT vào mẫu`);
  }
});

test('shop_id rút từ /shops/<uuid>/… (service có shop trong đường dẫn không phải sửa gì)', () => {
  const uuid = '9f3c1b2a-4d5e-6f70-8192-a3b4c5d6e7f8';
  assert.equal(routeTemplate(`/shops/${uuid}/orders`).shopId, uuid);
  // uuid ở vị trí KHÁC không phải shop — lấy bừa là gán nhầm lượt dùng cho shop khác.
  assert.equal(routeTemplate(`/variants/${uuid}/inventory`).shopId, null);
  assert.equal(routeTemplate('/login').shopId, null);
  // Chữ hoa trong uuid vẫn là cùng một shop.
  assert.equal(routeTemplate(`/shops/${uuid.toUpperCase()}/orders`).shopId, uuid);
});

test('mọi hình dạng lạ đều bị chặn — không có đường nào đẻ ô vô hạn', () => {
  // Slug tiếng Việt có dấu / ký tự URL-encode → gom vào một rọ, không mang nguyên vào bảng.
  assert.equal(routeTemplate('/tim-kiem/%C3%A1o%20thun').route, '/tim-kiem/:x');
  // Đoạn dài quá 40 ký tự (token, base64) → :x
  assert.equal(routeTemplate('/x/' + 'a'.repeat(80)).route, '/x/:x');
  // Sâu quá 8 tầng → cắt, không để một URL rác thành mẫu dài vô hạn.
  assert.equal(routeTemplate('/a/b/c/d/e/f/g/h/i/j/k').route.split('/').length - 1, 8);
  // Query string không bao giờ vào mẫu (nó chứa từ khoá khách gõ = dữ liệu người dùng).
  assert.equal(routeTemplate('/products?q=ao+thun&page=3').route, '/products');
  // Rỗng / lạ vẫn ra một mẫu hợp lệ, không ném.
  assert.equal(routeTemplate('/').route, '/');
  assert.equal(routeTemplate(undefined).route, '/');
});

test('mẫu route luôn nằm trong giới hạn CHECK của bảng (160 ký tự)', () => {
  // 8 đoạn × tối đa 40 ký tự + dấu / = 328 → PHẢI ngắn hơn thế, nếu không INSERT vỡ và cả lô
  // gộp của service đó mất. Kiểm bằng một đường dẫn xấu nhất có thể.
  const worst = '/' + Array.from({ length: 12 }, () => 'z'.repeat(40)).join('/');
  assert.ok(routeTemplate(worst).route.length <= 160, `mẫu dài ${routeTemplate(worst).route.length} ký tự`);
});

test('10 bản obs.js khớp nhau TỪNG KÝ TỰ', () => {
  const files = readdirSync(join(ROOT, 'apps'))
    .map((a) => join(ROOT, 'apps', a, 'src', 'obs.js'))
    .filter(existsSync);
  assert.ok(files.length >= 10, `chỉ thấy ${files.length} bản obs.js — kỳ vọng ≥10`);
  const base = readFileSync(files[0], 'utf8');
  for (const f of files.slice(1)) {
    assert.equal(readFileSync(f, 'utf8'), base,
      `${f} đã TRÔI LỆCH khỏi bản chuẩn. obs.js là bản sao mỗi service (image không share packages/) — sửa một bản thì phải chép sang cả 10.`);
  }
});
