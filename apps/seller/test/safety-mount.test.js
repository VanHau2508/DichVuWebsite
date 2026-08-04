// UNIT: service nào IMPORT công thức tồn an toàn thì compose PHẢI mount file đó vào.
//
// VÌ SAO CÓ BỘ NÀY. packages/inventory/src/safety-stock.js là MỘT bản duy nhất dùng chung cho
// checkout · storefront · seller. Image của mỗi service build từ context riêng nên KHÔNG chứa
// packages/ — file tới được /app/safety-stock.js bằng bind-mount khai trong compose (cùng cơ
// chế với packages/net-guard và packages/auth/src/ratelimit.js).
//
// Đánh đổi đã chọn: một bản dùng chung (không thể trôi lệch) đổi lấy một phụ thuộc VÔ HÌNH —
// Dockerfile không nhắc gì tới nó, nên thêm service mới hoặc dọn compose là mất mount như chơi.
// Mất mount thì service CHẾT LÚC KHỞI ĐỘNG (không giải được import). Hỏng to và hỏng sớm là cố
// ý, nhưng phát hiện lúc deploy vẫn muộn hơn phát hiện trong CI — nên có bộ này.
//
// KHI ĐỎ: đừng gỡ import. Thêm dòng mount vào ĐÚNG khối service ở CẢ HAI file compose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const doc = (p) => readFileSync(join(ROOT, p), 'utf8');

const MOUNT = '../packages/inventory/src/safety-stock.js:/app/safety-stock.js:ro';
const IMPORT = "from '../safety-stock.js'";

// Tên thư mục service → tên service trong compose (trùng nhau ở repo này, giữ ánh xạ cho rõ).
function servicesDungCongThuc() {
  const out = new Set();
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const src = join(ROOT, 'apps', app, 'src');
    if (!existsSync(src)) continue;
    for (const f of readdirSync(src)) {
      if (!f.endsWith('.js')) continue;
      if (readFileSync(join(src, f), 'utf8').includes(IMPORT)) out.add(app);
    }
  }
  return [...out].sort();
}

// Cắt file compose thành từng khối service. Khối bắt đầu ở dòng `  <ten>:` (đúng 2 dấu cách)
// và kết thúc ngay trước khối kế tiếp cùng mức.
function khoiService(composePath) {
  const lines = doc(composePath).split('\n');
  const blocks = new Map();
  let cur = null, buf = [];
  for (const line of lines) {
    const m = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (m) { if (cur) blocks.set(cur, buf.join('\n')); cur = m[1]; buf = []; continue; }
    if (cur) buf.push(line);
  }
  if (cur) blocks.set(cur, buf.join('\n'));
  return blocks;
}

test('service nào import công thức tồn an toàn thì cả hai compose đều mount file đó', () => {
  const services = servicesDungCongThuc();
  // Chốt chặn cho chính bộ test: nếu đổi tên file/đường import mà quên sửa hằng IMPORT ở trên
  // thì danh sách rỗng → mọi khẳng định dưới đây thành vô nghĩa mà vẫn XANH.
  assert.ok(services.length >= 3, `chỉ thấy ${services.length} service import công thức — kỳ vọng ≥3 (checkout/storefront/seller). Đổi đường import mà chưa sửa bộ test?`);

  for (const compose of ['infra/compose.dev.yml', 'infra/compose.prod.yml']) {
    const blocks = khoiService(compose);
    for (const svc of services) {
      const block = blocks.get(svc);
      assert.ok(block, `${compose}: không thấy khối service "${svc}"`);
      assert.ok(block.includes(MOUNT),
        `${compose}: service "${svc}" import '../safety-stock.js' nhưng KHÔNG mount file đó.\n` +
        `  → thêm vào volumes của "${svc}":  - ${MOUNT}`);
    }
  }
});

test('file công thức dùng chung tồn tại và xuất đủ ba thứ', () => {
  const src = doc('packages/inventory/src/safety-stock.js');
  for (const name of ['SAFETY_SQL', 'AVAIL_SQL', 'availOf']) {
    assert.ok(new RegExp(`export const ${name}\\b`).test(src), `thiếu export ${name}`);
  }
  // AVAIL_SQL phải DỰNG TRÊN SAFETY_SQL, không được chép lại biểu thức đệm lần thứ hai —
  // đó đúng là lớp lỗi mà cả file này sinh ra để chặn.
  assert.match(src, /AVAIL_SQL = `[^`]*\$\{SAFETY_SQL\}/, 'AVAIL_SQL không dùng lại SAFETY_SQL');
  // Làm tròn LÊN: đệm là vùng chống sai số nên chệch về phía giữ NHIỀU hơn mới đúng ý định.
  assert.match(src, /ceil\(/, 'công thức đệm không làm tròn lên (ceil)');
});
