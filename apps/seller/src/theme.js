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
