/**
 * Quy tắc xoá ảnh trưng bày. Đây là chỗ duy nhất trong đường dọn rác có thể XOÁ NHẦM
 * ảnh đang hiển thị, nên các ca ở đây viết theo hướng "chứng minh nó KHÔNG xoá" chứ
 * không phải "chứng minh nó có xoá".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickCollectable, referencedFrom, keysFromText, DISPLAY_KEY_RE } from '../src/media-gc.js';

const S = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';   // shop
const u = (n) => `bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb${String(n).padStart(2, '0')}`;
const obj = (name, ageHours = 100, size = 1000) => ({
  name, size, lastModified: new Date(Date.now() - ageHours * 3600000).toISOString(),
});
const CUT = Date.now() - 48 * 3600000; // ân hạn 48 giờ

test('chỉ 4 tiền tố trưng bày mới thuộc diện dọn', () => {
  for (const p of ['banner-', 'logo-', 'content-', 'cat-']) {
    assert.ok(DISPLAY_KEY_RE.test(`${S}/${p}${u(1)}.webp`), `${p} phải khớp`);
  }
  // Ảnh SẢN PHẨM: không tiền tố. Nó có dòng trong bảng media và vòng đời riêng.
  assert.equal(DISPLAY_KEY_RE.test(`${S}/${u(1)}.webp`), false);
  // Tiền tố lạ / đuôi lạ / thiếu thư mục shop → không khớp.
  assert.equal(DISPLAY_KEY_RE.test(`${S}/avatar-${u(1)}.webp`), false);
  assert.equal(DISPLAY_KEY_RE.test(`${S}/banner-${u(1)}.png`), false);
  assert.equal(DISPLAY_KEY_RE.test(`banner-${u(1)}.webp`), false);
});

test('ảnh sản phẩm KHÔNG bao giờ bị dọn, kể cả khi không ai tham chiếu', () => {
  const objs = [obj(`${S}/${u(1)}.webp`), obj(`${S}/banner-${u(2)}.webp`)];
  const got = pickCollectable(objs, new Set(), CUT).map((o) => o.name);
  assert.deepEqual(got, [`${S}/banner-${u(2)}.webp`]);
});

test('key đang được tham chiếu thì GIỮ', () => {
  const keep = `${S}/banner-${u(1)}.webp`, drop = `${S}/banner-${u(2)}.webp`;
  const got = pickCollectable([obj(keep), obj(drop)], new Set([keep]), CUT).map((o) => o.name);
  assert.deepEqual(got, [drop]);
});

test('ân hạn: ảnh vừa tải lên thì GIỮ dù chưa ai tham chiếu', () => {
  const fresh = obj(`${S}/content-${u(1)}.webp`, 1);    // 1 giờ tuổi
  const old = obj(`${S}/content-${u(2)}.webp`, 100);    // 100 giờ tuổi
  const got = pickCollectable([fresh, old], new Set(), CUT).map((o) => o.name);
  assert.deepEqual(got, [old.name], 'ảnh 1 giờ tuổi không được nằm trong diện xoá');
});

test('không đọc được thời gian → GIỮ (không biết tuổi thì không xoá)', () => {
  const bad = { name: `${S}/cat-${u(1)}.webp`, size: 1, lastModified: 'không phải ngày' };
  assert.deepEqual(pickCollectable([bad], new Set(), CUT), []);
});

test('sắp theo dung lượng giảm dần — dọn cái to trước', () => {
  const a = obj(`${S}/banner-${u(1)}.webp`, 100, 10);
  const b = obj(`${S}/banner-${u(2)}.webp`, 100, 900);
  assert.deepEqual(pickCollectable([a, b], new Set(), CUT).map((o) => o.size), [900, 10]);
});

test('quét tham chiếu bắt được key nằm trong JSON, trong thân bài, và ở cột phẳng', () => {
  const inLayout = `${S}/banner-${u(1)}.webp`;
  const inBody = `${S}/content-${u(2)}.webp`;
  const inColumn = `${S}/cat-${u(3)}.webp`;
  const refs = referencedFrom([
    JSON.stringify([{ section: 'hero', props: { slides: [{ image_key: inLayout }] } }]),
    `Đoạn mở đầu.\n\n[anh:${inBody}|ảnh minh hoạ]\n\nĐoạn sau.`,
    inColumn,
  ]);
  for (const k of [inLayout, inBody, inColumn]) assert.ok(refs.has(k), `phải thấy ${k}`);
  // Và tất cả chúng đều được GIỮ khi lọc.
  const objs = [inLayout, inBody, inColumn].map((k) => obj(k));
  assert.deepEqual(pickCollectable(objs, refs, CUT), []);
});

test('quét tham chiếu bắt CẢ key ảnh sản phẩm (không tiền tố)', () => {
  // Không phải để xoá chúng — mà để chúng không bao giờ lọt vào diện xoá vì "không
  // thấy ai nhắc tới". Quét thừa luôn an toàn hơn quét thiếu.
  const prod = `${S}/${u(9)}.webp`;
  assert.ok(referencedFrom([`ảnh: ${prod}`]).has(prod));
  assert.deepEqual(keysFromText('không có key nào ở đây'), []);
});
