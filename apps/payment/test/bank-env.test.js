// UNIT: dịch vụ VẼ mã QR và dịch vụ KIỂM tiền về phải đọc CÙNG một biến tài khoản nhận.
//
// VÌ SAO CÓ BỘ NÀY. Từ 0144, `payment` chỉ ghi hoá đơn thuê bao là 'paid' khi giao dịch rơi
// đúng `PLATFORM_BANK_ACCOUNT`. Số đó vốn chỉ được `platform` dùng để VẼ mã QR (0128 gom về
// env làm nguồn duy nhất). Nay hai dịch vụ cùng phụ thuộc vào nó, và đó là một phụ thuộc
// VÔ HÌNH: không import, không mount, chỉ là một dòng trong compose.
//
// Hai cách hỏng, cả hai đều im lặng:
//   · QUÊN cắm cho `payment` → biến rỗng → chốt fail-closed chặn HẾT → shop chuyển tiền xong
//     vẫn bị tính là nợ, hết 7 ngày ân hạn thì khoá nhầm. Không lỗi, không cảnh báo.
//   · Cắm cho `payment` một số KHÁC số `platform` đang vẽ QR → mã QR trỏ tài khoản A, chốt
//     đòi tài khoản B → cũng chặn hết, mà nhìn cấu hình thì thấy "đã cắm rồi".
//
// E2E không bắt được: nó chạy trên compose.dev đã cắm đúng, và không có màn nào nhìn thấy
// compose.prod. Bất biến mức tệp cấu hình thì thấy cả hai.
//
// KHI ĐỎ: thêm/sửa dòng PLATFORM_BANK_ACCOUNT trong khối service bị nêu tên, ĐỪNG nới test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const FILES = ['infra/compose.dev.yml', 'infra/compose.prod.yml'];
const CAN_CO = ['platform', 'payment'];

// Cắt khối YAML của một service: từ dòng `  <tên>:` tới dòng đầu tiên cùng mức thụt (2 dấu
// cách) không phải chính nó. Đủ chắc cho định dạng compose của kho này và không cần thư viện.
function khoiService(src, ten) {
  const dong = src.split('\n');
  const bd = dong.findIndex((l) => l === `  ${ten}:`);
  if (bd < 0) return null;
  let kt = dong.length;
  for (let i = bd + 1; i < dong.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(dong[i])) { kt = i; break; }
  }
  return dong.slice(bd, kt).join('\n');
}

test('platform và payment đều được cắm PLATFORM_BANK_ACCOUNT, ở cả hai compose', () => {
  const thieu = [];
  for (const f of FILES) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    for (const svc of CAN_CO) {
      const khoi = khoiService(src, svc);
      assert.ok(khoi, `${f}: không tìm thấy service '${svc}' (đổi tên?)`);
      if (!/^\s*PLATFORM_BANK_ACCOUNT:/m.test(khoi)) thieu.push(`${f} → service '${svc}'`);
    }
  }
  assert.deepEqual(thieu, [],
    'thiếu PLATFORM_BANK_ACCOUNT: dịch vụ vẽ QR và dịch vụ kiểm tiền phải đọc cùng một biến');
});

test('compose.dev cắm CÙNG một giá trị cho cả hai (khác nhau = QR trỏ một nơi, chốt đòi nơi khác)', () => {
  // Chỉ kiểm được ở compose.dev: bản prod dùng ${PLATFORM_BANK_ACCOUNT:-} nên giá trị nằm
  // trong .env của máy chủ, không nằm trong kho — mà cùng tham chiếu tới MỘT tên biến thì
  // tự nó đã không lệch được. Ở dev thì số được ghi thẳng, nên lệch được, nên phải canh.
  const src = readFileSync(join(ROOT, 'infra/compose.dev.yml'), 'utf8');
  const giaTri = CAN_CO.map((svc) => {
    const m = /^\s*PLATFORM_BANK_ACCOUNT:\s*(.+)$/m.exec(khoiService(src, svc) ?? '');
    return [svc, (m?.[1] ?? '').trim().replace(/^["']|["']$/g, '')];
  });
  const [[, a], [, b]] = giaTri;
  assert.equal(a, b, `lệch số tài khoản giữa hai service: ${JSON.stringify(giaTri)}`);
  assert.ok(a.length > 0, 'compose.dev để trống PLATFORM_BANK_ACCOUNT → chốt fail-closed chặn hết');
});
