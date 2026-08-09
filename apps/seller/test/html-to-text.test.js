import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../src/html-to-text.js';

test('chuyển đoạn, xuống dòng, danh sách và entity sang văn bản thuần', () => {
  const out = htmlToText('<p>A&nbsp;&amp; B<br>Xuống dòng</p><ul><li>Một</li><li>Hai</li></ul>');
  assert.equal(out.text, 'A & B\nXuống dòng\n\n- Một\n- Hai');
  assert.deepEqual(out.images, []);
});

test('rút ảnh theo thứ tự và không để thẻ script tồn tại', () => {
  const out = htmlToText('<div>Đầu<img src="https://img/a.jpg"><script>alert(1)</script><img src=https://img/b.jpg></div>');
  assert.equal(out.text, 'Đầualert(1)');
  assert.deepEqual(out.images, ['https://img/a.jpg', 'https://img/b.jpg']);
  assert.doesNotMatch(out.text, /[<>]|&nbsp;/);
});
