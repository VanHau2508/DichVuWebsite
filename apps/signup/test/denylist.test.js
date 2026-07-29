/**
 * Unit test DANH SÁCH CẤM SLUG khi tự đăng ký.
 *   node --test apps/signup/test/denylist.test.js
 *
 * Vì sao đáng có test riêng: đây là cái chặn ĐẦU TIÊN trên phễu self-serve, và lỗi của nó
 * hoàn toàn IM LẶNG — người bán chỉ thấy "Địa chỉ này không sử dụng được", thử vài tên rồi
 * bỏ đi. Không log, không phiếu hỗ trợ, không ai biết đã mất ai. Test là cách duy nhất nhìn
 * thấy nó.
 *
 * Bản đầu khớp CHUỖI CON với mọi thương hiệu, kể cả 'be' (2 ký tự) và 'nhanh' — chặn gần
 * trọn ngành hàng MẸ & BÉ cùng mọi shop có chữ "nhanh". Không bộ e2e nào bắt được, vì e2e
 * dùng slug ngẫu nhiên; nó chỉ lộ ra dưới dạng một bộ test đỏ ~1/24 lượt (slug 8 ký tự ngẫu
 * nhiên trúng 'be' với xác suất ~0,54%).
 *
 * Chạy trong mili-giây, không cần stack → vào cổng unit của MỌI commit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSlugDenied, isDisposableEmail } from '../src/denylist.js';

test('CHO QUA tên shop Việt thật — ngành mẹ & bé', () => {
  // Toàn bộ nhóm này TỪNG bị chặn vì chuỗi 'be'.
  for (const s of ['me-va-be', 'do-choi-cho-be', 'be-yeu-shop', 'shop-me-be', 'bebi-store']) {
    assert.equal(isSlugDenied(s), false, `${s} phải dùng được`);
  }
});

test('CHO QUA tên có chữ thông dụng lọt vào giữa', () => {
  const cases = [
    'bepgiadinh',        // bếp gia đình — chứa 'be'
    'banh-beo-co-ba',    // bánh bèo — chứa 'be'
    'giao-hang-nhanh',   // chứa 'nhanh'
    'ship-nhanh-24h',
    'an-nhanh',
    'sapoche-vuon',      // quả sapoche — chứa 'sapo'
    'tiem-banh-pancake', // bánh pancake — chứa 'pancake'
  ];
  for (const s of cases) assert.equal(isSlugDenied(s), false, `${s} phải dùng được`);
});

test('VẪN CHẶN khi slug TRÙNG TRỌN tên thương hiệu', () => {
  for (const s of ['be', 'tiki', 'grab', 'zalo', 'momo', 'sapo', 'nhanh', 'shopee', 'pancake']) {
    assert.equal(isSlugDenied(s), true, `${s} phải bị chặn`);
  }
});

test('VẪN CHẶN chiếm tên bằng thương hiệu DÀI lồng bên trong', () => {
  for (const s of ['shopee-vn', 'my-shopee-store', 'lazada-official', 'nentang-clone',
    'facebook-shop', 'vietcombank-vn', 'thegioididong-2']) {
    assert.equal(isSlugDenied(s), true, `${s} phải bị chặn`);
  }
});

test('ĐÁNH ĐỔI CÓ CHỦ Ý: thương hiệu NGẮN lồng bên trong thì lọt', () => {
  // 'tiki-store' nay dùng được. Cố ý: kẻ chiếm tên thì ta THẤY và có sẵn đường tạm khoá shop;
  // người bán thật bị chặn thì im lặng rời đi. Hai loại sai không cân nhau.
  // Ghi lại ở đây để nếu ai đổi ý thì phải sửa test — tức là phải cố ý.
  for (const s of ['tiki-store', 'grab-food', 'zalo-shop']) {
    assert.equal(isSlugDenied(s), false, `${s} hiện được cho qua (đánh đổi có chủ ý)`);
  }
});

test('slug hệ thống (RESERVED) vẫn chặn, đầu vào rác không nổ', () => {
  assert.equal(isSlugDenied('admin'), true);
  assert.equal(isSlugDenied('www'), true);
  for (const v of [null, undefined, '', 123, {}]) {
    assert.equal(typeof isSlugDenied(v), 'boolean', `${String(v)} phải trả boolean`);
  }
});

test('email dùng-một-lần nhận diện theo TÊN MIỀN, không phải chuỗi con', () => {
  assert.equal(isDisposableEmail('a@mailinator.com'), true);
  assert.equal(isDisposableEmail('a@yopmail.com'), true);
  // Tên miền thật CHỨA tên miền rác không được tính — 'notmailinator.com' là miền khác hẳn.
  assert.equal(isDisposableEmail('a@notmailinator.com'), false);
  assert.equal(isDisposableEmail('a@gmail.com'), false);
  assert.equal(isDisposableEmail('khong-co-a-cong'), false);
});
