// UNIT: các đoạn SQL được CHÉP TAY sang nhiều service phải KHỚP TỪNG KÝ TỰ.
//
// Vì sao có bộ này: ba lỗ tiền trong một ngày (2026-08-03) đều cùng một hình dạng — MỘT LUẬT
// viết ở HAI NƠI rồi trôi lệch:
//   · công thức tổng tiền ở checkout có points_discount_vnd, ở sửa đơn thì không;
//   · phí ship ở checkout có phụ phí cân, ở đơn bot thì không;
//   · bộ lọc "hãng còn nợ" ở cod.js và reports.js lọc theo hai điều kiện khác nhau.
// Mỗi lần đều mất một vòng dựng-lại-thật mới tìm ra. Rẻ hơn nhiều là để máy canh.
//
// VÌ SAO KHÔNG GỘP THÀNH MỘT FILE DÙNG CHUNG: mỗi service là một image riêng, và
// apps/checkout KHÔNG có packages/ trong image (xem chú thích ở apps/seller/src/affiliates.js).
// Gộp đòi thêm bind-mount cho từng service — đụng cả đường tiền checkout để đổi một hằng số
// đang đúng là đánh đổi tồi. Chép tay thì CHẤP NHẬN ĐƯỢC, miễn là có người canh trôi lệch.
// Bộ này chính là người canh đó.
//
// KHI ĐỎ: đừng sửa test cho khớp. Đọc cả N bản, quyết bản nào ĐÚNG, rồi sửa các bản còn lại.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const doc = (p) => readFileSync(join(ROOT, p), 'utf8');

// Trích phần thân của `const <TEN> = \`...\`;` — so sau khi chuẩn hoá khoảng trắng, vì thụt
// lề khác nhau giữa các file là vô hại, còn khác ĐIỀU KIỆN thì không.
function sqlConst(path, name) {
  const src = doc(path);
  const m = new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`).exec(src);
  assert.ok(m, `${path}: không thấy hằng ${name}`);
  return m[1].replace(/\s+/g, ' ').trim();
}

test('VARIANT_NOT_ORPHAN_SQL giống hệt nhau ở mọi service', () => {
  // Luật "ẩn biến thể mồ côi": shop thu hẹp phân loại → biến thể của tổ hợp cũ mất ánh xạ
  // nhưng vẫn active + còn giá/tồn. Lệch một bản là bán được hàng KHÔNG TỒN TẠI ở đúng
  // service đó (storefront cho chọn / checkout cho đặt / seller cho gõ tay).
  const nguon = [
    'apps/storefront/src/server.js',
    'apps/checkout/src/server.js',
    'apps/seller/src/orders.js',
    'apps/seller/src/catalog.js',
    'apps/seller/src/purchasing.js',
  ];
  const bansao = nguon.map((p) => [p, sqlConst(p, 'VARIANT_NOT_ORPHAN_SQL')]);
  const [, chuan] = bansao[0];
  for (const [p, sql] of bansao.slice(1)) {
    assert.equal(sql, chuan, `${p} lệch với ${nguon[0]} — quyết bản nào đúng rồi sửa bản kia, ĐỪNG sửa test`);
  }
  // Chốt hai đầu: nếu ai đó rút gọn hằng thành chuỗi rỗng thì mọi bản vẫn "giống nhau".
  assert.match(chuan, /product_options/, 'hằng không còn nhắc product_options — đã bị rút ruột?');
  assert.match(chuan, /variant_option_values/, 'hằng không còn nhắc variant_option_values');
});
