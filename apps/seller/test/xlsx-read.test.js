import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readXlsx } from '../src/xlsx-read.js';
import { buildXlsx } from './xlsx-fixture.js';

test('dò tiêu đề, bỏ bốn dòng meta TikTok và giữ đúng cột khi ô rỗng bị lược', async () => {
  const xlsx = await buildXlsx([
    ['product_id', 'variation_value', 'product_name', 'quantity'],
    ['V4', 'Bắt buộc', 'Không bắt buộc', 'Không thể chỉnh sửa'],
    ['', 'ghi chú mẫu', '', ''],
    ['', '', '', ''],
    ['', '', '', ''],
    [{ value: '1731037645341100126', type: 'inlineStr' }, null, 'Vòng tay bạc', { value: 12, type: 'n' }],
  ]);
  assert.deepEqual(readXlsx(xlsx), [{
    product_id: '1731037645341100126', variation_value: '', product_name: 'Vòng tay bạc', quantity: '12',
  }]);
});

test('dò được dòng tiêu đề không nằm ở dòng đầu và bỏ meta trước dữ liệu thật', async () => {
  const xlsx = await buildXlsx([
    ['TikTok Shop template'],
    ['phiên bản', 'V4'],
    ['product_id', 'variation_value', 'sku_id'],
    ['', 'Không bắt buộc', ''],
    ['1234567890123456789', 'Đen, M', '9876543210987654321'],
  ]);
  assert.equal(readXlsx(xlsx).length, 1);
  assert.equal(readXlsx(xlsx)[0].variation_value, 'Đen, M');
});

test('bỏ nhãn Bắt buộc có điều kiện trước dữ liệu thật', async () => {
  const xlsx = await buildXlsx([
    ['product_id', 'variation_value'],
    ['Bắt buộc có điều kiện', 'Bắt buộc có điều kiện'],
    ['1731999999999999001', 'Đỏ'],
  ]);
  assert.deepEqual(readXlsx(xlsx), [{ product_id: '1731999999999999001', variation_value: 'Đỏ' }]);
});

// ── KHÔNG RA DÒNG NÀO THÌ PHẢI NÓI VÌ SAO ────────────────────────────────────
//
// Đo ngày 07/09: tệp 200 dòng có product_id ở dạng số mũ trả về MẢNG RỖNG, y hệt một tệp chỉ
// có dòng tiêu đề — nên trang nhập hiện cùng một câu cho cả hai: "Tệp không có dòng dữ liệu
// (cần hàng tiêu đề + ít nhất 1 dòng)". Câu đó SAI với tệp 200 dòng và chỉ người bán đi sửa
// đúng thứ duy nhất không hỏng.
//
// Bộ đọc là nơi DUY NHẤT còn biết sự thật (đã thấy tiêu đề, đã đếm N dòng, đã bỏ hết vì
// product_id). Trả `[]` ở đây là ném mất thông tin ngay tại chỗ biết nó.
//
// KHÔNG tự sửa giá trị bị làm tròn: một id mất bốn chữ số cuối là id KHÁC, nhận nó nghĩa là
// ghi external_id trỏ nhầm sản phẩm bên sàn.
test('đọc được N dòng mà bỏ hết vì product_id thì báo đích danh, không trả mảng rỗng', async () => {
  const xlsx = await buildXlsx([
    ['product_id', 'product_name'],
    ...Array.from({ length: 12 }, (_, i) => [{ value: '1.7310376453411E+18', type: 'n' }, `SP ${i}`]),
  ]);
  assert.throws(() => readXlsx(xlsx), (e) => {
    assert.equal(e.code, 'XLSX_NO_PRODUCT_ID');
    assert.match(e.message, /12 dòng dữ liệu/, 'phải nêu SỐ dòng đã đọc được');
    assert.match(e.message, /1\.7310376453411E\+18/, 'phải nêu giá trị đọc được để đối chiếu với tệp');
    assert.match(e.message, /lưu lại bằng bảng tính/, 'dạng số mũ thì phải nói nguyên nhân nhiều khả năng nhất');
    return true;
  });
});

test('giá trị KHÔNG phải dạng số mũ thì không gợi ý nhầm nguyên nhân', async () => {
  // Gợi ý một nguyên nhân không khớp cũng là chỉ người bán đi sai chỗ — đúng thứ câu cũ đã làm.
  const xlsx = await buildXlsx([['product_id', 'product_name'], ['123456789', 'Áo thun']]);
  assert.throws(() => readXlsx(xlsx), (e) => {
    assert.equal(e.code, 'XLSX_NO_PRODUCT_ID');
    assert.match(e.message, /123456789/);
    assert.doesNotMatch(e.message, /bảng tính/, 'id ngắn không liên quan gì tới chuyện làm tròn');
    return true;
  });
});

test('tệp CHỈ có dòng tiêu đề vẫn trả mảng rỗng, không ném', async () => {
  // Chiều ngược lại: câu "tệp không có dòng dữ liệu" của trang là ĐÚNG cho ca này và phải
  // giữ được. Thiếu khẳng định này thì một bản "luôn ném" cũng đi lọt.
  assert.deepEqual(readXlsx(await buildXlsx([['product_id', 'product_name']])), []);
});

test('thiếu trang tính đầu: câu lỗi không chìa đường dẫn nội bộ ra cho người bán', async () => {
  const { buildZip } = await import('../src/zip.js');
  const wb = '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="S" sheetId="1"/></sheets></workbook>';
  const zip = await buildZip([{ name: 'xl/workbook.xml', data: Buffer.from(wb) }]);
  assert.throws(() => readXlsx(zip), (e) => {
    assert.doesNotMatch(e.message, /xl\/worksheets/, 'người bán không biết đường dẫn bên trong tệp zip là gì');
    assert.match(e.message, /trang tính đầu/, 'phải nói giới hạn có thật: chỉ đọc trang tính đầu');
    return true;
  });
});
