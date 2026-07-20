/**
 * Quản trị theme (seller). GET (thành viên) / PUT (theme.write = owner/admin).
 *
 * Lưu tokens/layout dạng jsonb THÔ. Sanitize xảy ra ở STOREFRONT lúc render
 * (theme engine) — đúng lớp: lưu nguyên, làm sạch khi xuất. Nên PUT chỉ cần
 * kiểm kiểu (object/array), không cần biết mẫu màu.
 */
import { send } from './http.js';
import { withTenant, audit } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

// ── Banner trang chủ (Phase 5) — validate CỨNG lúc lưu ────────────────────────
// Layout nói chung lưu THÔ (sanitize ở storefront khi render), NHƯNG image_key của
// banner là một CAPABILITY (trỏ file trong bucket public) → phải kiểm ở server, không
// tin BFF: key phải đúng định dạng banner CỦA CHÍNH SHOP (chống chéo shop / traversal /
// chuỗi tuỳ ý). Key sai → 400, không lưu.
const U36 = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const BANNER_KEY_RE = new RegExp(`^${U36}/banner-${U36}\\.webp$`);
const MAX_SLIDES = 5;
const clampStr = (x, n) => (typeof x === 'string' ? x.trim().slice(0, n) : '');
// button_link: đường dẫn NỘI BỘ (bắt đầu '/', không phải '//') hoặc http(s) tuyệt đối.
// Loại javascript:/data:/mailto:/'//' (protocol-relative) — trả '' (ẩn nút) nếu không hợp lệ.
function safeLink(x) {
  const s = clampStr(x, 300);
  if (!s) return '';
  if (s.startsWith('//')) return '';
  if (s.startsWith('/')) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return '';
}
/** Kiểm + chuẩn hoá mảng slides banner. Trả {slides} hoặc {error}. */
function sanitizeSlides(raw, shopId) {
  if (!Array.isArray(raw)) return { error: 'slides banner phải là mảng' };
  if (raw.length > MAX_SLIDES) return { error: `tối đa ${MAX_SLIDES} banner` };
  const out = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') return { error: 'slide banner không hợp lệ' };
    const key = String(s.image_key ?? '');
    // image_key BẮT BUỘC + là banner key CỦA CHÍNH SHOP (regex + tiền tố shop_id).
    if (!BANNER_KEY_RE.test(key) || !key.startsWith(`${shopId}/`)) return { error: 'key ảnh banner không hợp lệ' };
    out.push({
      image_key: key,
      headline: clampStr(s.headline, 120),
      sub: clampStr(s.sub, 200),
      button_label: clampStr(s.button_label, 40),
      button_link: safeLink(s.button_link),
    });
  }
  return { slides: out };
}
// Đi qua layout, tìm MỌI section có props.slides → validate. Sai key → trả chuỗi lỗi;
// hợp lệ → thay bằng bản đã chuẩn hoá (rỗng → xoá prop). Mutate layout tại chỗ.
function validateBannerInLayout(layout, shopId) {
  if (!Array.isArray(layout)) return null;
  for (const section of layout) {
    if (section && typeof section === 'object' && section.props && typeof section.props === 'object'
        && section.props.slides !== undefined) {
      const r = sanitizeSlides(section.props.slides, shopId);
      if (r.error) return r.error;
      if (r.slides.length) section.props.slides = r.slides; else delete section.props.slides;
    }
  }
  return null;
}

async function getTheme(res, ctx) {
  const row = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(`SELECT tokens, layout, version FROM themes WHERE shop_id = current_shop_id()`);
    return r.rows[0] ?? { tokens: {}, layout: [], version: 0 };
  });
  return send(res, 200, row);
}

async function putTheme(res, ctx, body) {
  const tokens = body.tokens;
  const layout = body.layout;
  if (tokens != null && (typeof tokens !== 'object' || Array.isArray(tokens))) {
    return send(res, 400, { error: 'tokens phải là object' });
  }
  if (layout != null && !Array.isArray(layout)) {
    return send(res, 400, { error: 'layout phải là mảng' });
  }
  // Banner slides (nếu có): kiểm image_key thuộc shop + chuẩn hoá text/link TRƯỚC khi lưu.
  if (layout != null) {
    const bannerErr = validateBannerInLayout(layout, ctx.shopId);
    if (bannerErr) return send(res, 400, { error: bannerErr });
  }
  await withTenant(ctx.shopId, async (c) => {
    await c.query(
      `INSERT INTO themes (shop_id, tokens, layout, version)
       VALUES (current_shop_id(), $1, $2, 1)
       ON CONFLICT (shop_id) DO UPDATE
         SET tokens = EXCLUDED.tokens, layout = EXCLUDED.layout,
             version = themes.version + 1, updated_at = now()`,
      [tokens ?? {}, JSON.stringify(layout ?? [])],
    );
    await audit(c, 'theme.updated', { actorId: ctx.user.id, ip: ctx.ip });
  });
  return send(res, 200, { ok: true });
}

export const THEME_ADMIN_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/theme$`), perm: null, fn: (res, ctx) => getTheme(res, ctx) },
  { m: 'PUT', re: new RegExp(`^/shops/${UUID}/theme$`), perm: 'theme.write', fn: (res, ctx, b) => putTheme(res, ctx, b) },
];
