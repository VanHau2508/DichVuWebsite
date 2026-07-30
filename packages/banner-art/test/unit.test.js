import test from 'node:test';
import assert from 'node:assert/strict';
import { SHAPES, bannerPlan, bannerSvg, paletteFromTokens } from '../src/index.js';

const FURNITURE = {
  'color.bg': '#ffffff', 'color.hero-bg': '#eef0f2',
  'color.accent': '#d26e4b', 'color.text': '#2f3a45',
};

test('mỗi ngành ra đúng 3 hero + 2 side + 3 promo', () => {
  for (const ind of ['fashion', 'food', 'furniture', 'cosmetics', null, 'nganh-la-hoac']) {
    const plan = bannerPlan(ind, FURNITURE);
    const n = (slot) => plan.filter((b) => b.slot === slot).length;
    assert.equal(n('hero'), 3, `hero của ${ind}`);
    assert.equal(n('side'), 2, `side của ${ind}`);
    assert.equal(n('promo'), 3, `promo của ${ind}`);
  }
});

test('KHÔNG có <text> trong SVG', () => {
  // Hồi quy: bản đầu nướng chữ vào ảnh → ra ô vuông tofu vì image không cài
  // fontconfig, mà theme.js vốn đã tự phủ headline/sub/CTA bằng HTML.
  for (const b of bannerPlan('cosmetics', FURNITURE)) {
    assert.ok(!/<text[\s>]/.test(b.svg), 'SVG không được chứa <text>');
  }
});

test('mọi tên hình trong bảng chữ đều có thật', () => {
  // Sai chính tả tên hình âm thầm rơi về hình mặc định — không lỗi, chỉ xấu.
  // Phải so tên YÊU CẦU với đường vẽ RA: chỉ đếm "khớp 1 hình nào đó trong
  // SHAPES" thì hình mặc định cũng khớp, test xanh trong khi banner đã sai.
  for (const ind of ['fashion', 'food', 'furniture', 'cosmetics', null]) {
    for (const b of bannerPlan(ind, FURNITURE)) {
      assert.ok(SHAPES[b.shape], `${ind}/${b.headline}: tên hình "${b.shape}" không có trong SHAPES`);
      assert.ok(b.svg.includes(`d="${SHAPES[b.shape]}"`), `${ind}/${b.headline}: vẽ ra không phải hình "${b.shape}"`);
    }
  }
});

test('không rò undefined/NaN ra SVG', () => {
  for (const b of bannerPlan('food', FURNITURE)) {
    assert.ok(!/undefined|NaN/.test(b.svg), b.svg.slice(0, 200));
  }
});

test('palette lấy từ tokens của shop, token hỏng thì rơi về mặc định', () => {
  const ok = paletteFromTokens(FURNITURE);
  assert.equal(ok.accent, '#d26e4b');
  assert.equal(ok.bg2, '#eef0f2');

  // Token thiếu / sai định dạng / bị chèn bậy đều KHÔNG được lọt vào SVG.
  const bad = paletteFromTokens({ 'color.accent': 'red; fill:url(#x)', 'color.bg': null });
  for (const v of Object.values(bad)) assert.match(v, /^#[0-9a-f]{6}$/i);
  assert.deepEqual(paletteFromTokens(undefined), paletteFromTokens({}));
});

test('nét tương phản với khối màu nhấn, không phải với nền', () => {
  // Nét nằm TRÊN khối accent. Accent sáng mà vẫn kẻ trắng là mất hình.
  assert.equal(paletteFromTokens({ 'color.accent': '#1a1a2e' }).ink, '#ffffff');
  assert.notEqual(paletteFromTokens({ 'color.accent': '#ffe9a8', 'color.text': '#222222' }).ink, '#ffffff');
});

test('bannerSvg giữ đúng khổ được yêu cầu', () => {
  const svg = bannerSvg({ w: 1680, h: 640, bg1: '#fff', bg2: '#eee', accent: '#d26e4b', ink: '#fff', shape: 'sofa' });
  assert.match(svg, /width="1680"/);
  assert.match(svg, /height="640"/);
});
