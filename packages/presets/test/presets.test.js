/**
 * Kiểm HỢP ĐỒNG của mọi preset ngành TRƯỚC khi đưa vào seller-admin/signup.
 * Chạy trong dbtest (mount packages/presets + apps/storefront/src):
 *   docker compose -f infra/compose.dev.yml exec -T dbtest \
 *     node --test /work/packages/presets/test/presets.test.js
 *
 * Điểm mấu chốt: token đi qua sanitizeTokens() THẬT (không bản sao) → nếu một khoá/regex
 * bị lệch, preset sẽ rớt về mặc định MAISON MÀ KHÔNG BÁO LỖI ở runtime; test này bắt cứng.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, getPreset, listPresets, presetChoices } from '../src/index.js';
import { sanitizeTokens } from '../../../apps/storefront/src/theme.js';

// section registry (theme.js:250) — render bỏ qua key lạ, nên preset PHẢI nằm trong tập này.
const VALID_SECTIONS = new Set(['header', 'hero', 'hero_side', 'features', 'collections', 'product_grid', 'product_spotlight', 'category_bar', 'category_rows', 'flash_sale', 'promo_banners', 'blog', 'story', 'footer']);
// 11 khoá token hợp lệ (9 màu + radius + spacing). KHÔNG font.*.
const TOKEN_KEYS = ['color.primary', 'color.primary-dark', 'color.accent', 'color.bg', 'color.surface', 'color.hero-bg', 'color.text', 'color.muted', 'color.border', 'radius', 'spacing'];
const SLUGS = ['fashion', 'food', 'furniture', 'cosmetics'];

test('có đúng 4 preset ngành + helper', () => {
  assert.deepEqual(listPresets().sort(), [...SLUGS].sort());
  assert.equal(getPreset('khong-ton-tai'), null);
  assert.equal(getPreset(undefined), null);
  assert.equal(presetChoices().length, 4);
  for (const c of presetChoices()) assert.ok(c.slug && c.name && c.description);
});

for (const slug of SLUGS) {
  const p = getPreset(slug);

  test(`[${slug}] tokens QUA sanitizeTokens KHÔNG rớt về mặc định`, () => {
    const out = sanitizeTokens(p.tokens);
    // mọi giá trị preset phải được sanitize CHẤP NHẬN (out[k] === giá trị đã đặt, không phải default)
    for (const k of Object.keys(p.tokens)) {
      assert.equal(out[k], p.tokens[k], `token ${k}="${p.tokens[k]}" bị rớt (sai regex/khoá?)`);
    }
    // đúng 11 khoá, không thừa không thiếu
    assert.deepEqual(Object.keys(p.tokens).sort(), [...TOKEN_KEYS].sort(), 'sai bộ khoá token');
    // TUYỆT ĐỐI không font.* (CSP chặn font ngoài)
    assert.ok(!('font.body' in p.tokens) && !('font.heading' in p.tokens), 'preset không được set font.*');
  });

  test(`[${slug}] layout hợp lệ (section registry · header đầu · footer cuối · hero gần đầu)`, () => {
    assert.ok(Array.isArray(p.layout) && p.layout.length >= 4, 'layout phải là mảng đủ dài');
    for (const s of p.layout) {
      assert.ok(s && typeof s === 'object' && typeof s.props === 'object', 'mỗi mục layout cần {section,props}');
      assert.ok(VALID_SECTIONS.has(s.section), `section lạ: ${s.section}`);
    }
    assert.equal(p.layout[0].section, 'header', 'header phải đầu tiên');
    assert.equal(p.layout[p.layout.length - 1].section, 'footer', 'footer phải cuối');
    const heroIdx = p.layout.findIndex((s) => s.section === 'hero');
    assert.ok(heroIdx >= 1 && heroIdx <= 2, 'hero phải gần đầu (sau header)');
    // hero.slides RỖNG — banner do chủ shop tự upload; áp preset không nhồi ảnh
    assert.deepEqual(p.layout[heroIdx].props.slides, [], 'hero.slides phải rỗng []');
    // section không trùng lặp
    const keys = p.layout.map((s) => s.section);
    assert.equal(new Set(keys).size, keys.length, 'section bị trùng trong layout');
  });

  test(`[${slug}] features đúng 4 mục · nav_links ≤6 nội bộ`, () => {
    const feat = p.layout.find((s) => s.section === 'features');
    if (feat) {
      assert.ok(Array.isArray(feat.props.items) && feat.props.items.length === 4, 'features phải đúng 4 mục');
      for (const it of feat.props.items) assert.ok(it.title && it.desc, 'mỗi feature cần title+desc');
    }
    const hdr = p.layout.find((s) => s.section === 'header');
    const nav = hdr.props.nav_links ?? [];
    assert.ok(nav.length <= 6, 'nav_links tối đa 6');
    for (const l of nav) {
      assert.ok(l.label && typeof l.url === 'string', 'nav_link cần label+url');
      assert.ok(l.url.startsWith('/'), `nav url phải nội bộ '/...': ${l.url}`);
    }
  });
}
