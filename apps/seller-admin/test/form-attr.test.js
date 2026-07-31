/**
 * Bất biến: mọi thuộc tính form="X" phải có một <form id="X"> TRONG CÙNG hàm render.
 *
 * VÌ SAO CÓ. HTML cho phép ô nhập nằm ngoài cây DOM của form và dính vào form bằng
 * thuộc tính `form="<id>"`. Rất tiện (trang sửa sản phẩm dùng nó để một nút Lưu ghi
 * được cả trang), nhưng có một kiểu hỏng ÂM THẦM: trỏ tới id KHÔNG tồn tại thì trình
 * duyệt lặng lẽ KHÔNG gửi ô đó. Người dùng gõ, bấm Lưu, thấy báo thành công, dữ liệu
 * không đổi. Không lỗi, không cảnh báo, không dấu vết.
 *
 * Đã xảy ra thật: một lần thay chuỗi toàn cục khi làm nút "Lưu tất cả" đã dán
 * form="pall" vào 7 trang khác — trong đó có FORM TẠO SẢN PHẨM (tên/slug/giá) và
 * form viết blog. Trên các trang đó không có #pall nên các ô ấy chết lặng.
 *
 * E2E KHÔNG bắt được lớp lỗi này: bộ test POST thẳng body form-encoded, tức bỏ qua
 * hoàn toàn ngữ nghĩa gom-ô của trình duyệt. Chúng vẫn xanh trong khi trang thật hỏng.
 * Nên phép kiểm phải nằm ở mức MÃ NGUỒN.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages.js');

test('mọi form="X" đều có <form id="X"> trong cùng hàm render', () => {
  // Bỏ dòng CHÚ THÍCH trước khi quét. Bản đầu báo nhầm renderResetDone vì một chú
  // thích có nhắc form="codf" nằm ngay TRƯỚC ranh giới hàm → bị gán sang hàm trước.
  // Giữ nguyên số dòng (thay bằng dòng trống) để thông báo lỗi còn chỉ đúng chỗ.
  const src = fs.readFileSync(SRC, 'utf8').split('\n')
    .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l)).join('\n');
  // Cắt theo ranh giới hàm export — đủ chính xác vì mỗi trang là một hàm render riêng.
  const marks = [...src.matchAll(/export function (\w+)/g)];
  const chunks = marks.map((m, i) => ({
    name: m[1],
    body: src.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : src.length),
  }));

  const orphans = [];
  let checked = 0;
  for (const c of chunks) {
    const ids = new Set([...c.body.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]));
    for (const m of c.body.matchAll(/\bform="([\w-]+)"/g)) {
      checked++;
      if (!ids.has(m[1])) orphans.push(`${c.name}: form="${m[1]}" nhưng không có id="${m[1]}"`);
    }
  }

  // Đếm > 0 để ca này không bao giờ "xanh rỗng": nếu regex hỏng và khớp 0 chỗ thì đỏ,
  // chứ không lặng lẽ báo đạt như đã từng xảy ra ở một ca khác.
  assert.ok(checked > 0, 'không tìm thấy thuộc tính form= nào — regex hỏng?');
  assert.deepEqual(orphans, [], `\n  ${orphans.join('\n  ')}\n`);
});
