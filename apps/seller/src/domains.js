/**
 * Custom domain tự phục vụ (A5). Owner (perm 'domain.write' + step-up) thêm tên miền riêng;
 * xác minh SỞ HỮU qua DNS TXT (worker tra + đặt verified_at — apps/worker). Chỉ domain đã
 * verified mới được tls-authorize cấp cert + storefront/checkout phục vụ.
 *
 * Gate ở route (dispatcher seller cưỡng chế): mutate = domain.write (CHỈ owner) + stepUp.
 * Đọc (list/get) = perm null (thành viên xem được — challenge token chỉ hữu ích cho ai
 * điều khiển DNS). Cô lập tenant: withTenant(shopId) → RLS tenant_isolation, chỉ domain shop mình.
 */
import crypto from 'node:crypto';
import { send } from './http.js';
import { withTenant, audit } from './db.js';
import { normalizeHostname, isReserved } from './hostname.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? 'nentang.vn';
const VERIFY_PREFIX = process.env.DOMAINVERIFY_PREFIX ?? '_nentang-verify';
const MAX_DOMAINS_PER_SHOP = Number(process.env.MAX_DOMAINS_PER_SHOP ?? 20);
// Khoá tuần tự hoá thao tác primary/revoke theo shop (single-primary an toàn khi đua).
const primaryLock = (c) => c.query(`SELECT pg_advisory_xact_lock(hashtext('domain-primary'), hashtext(current_shop_id()::text))`);
const genToken = () => crypto.randomBytes(32).toString('base64url');

// View cho client: KHÔNG lộ token khi đã verified (không còn cần); challenge = bản ghi TXT phải thêm.
const domainView = (d) => ({
  id: d.id,
  hostname: d.hostname,
  verified: d.verified_at !== null,
  is_primary: d.is_primary,
  created_at: d.created_at,
  challenge: d.verified_at === null
    ? { type: 'TXT', name: `${VERIFY_PREFIX}.${d.hostname}`, value: d.verification_token }
    : null,
});

const SELECT_COLS = 'id, hostname, verification_token, verified_at, is_primary, created_at';

async function listDomains(res, ctx) {
  const rows = await withTenant(ctx.shopId, async (c) =>
    (await c.query(`SELECT ${SELECT_COLS} FROM domains ORDER BY is_primary DESC, created_at`)).rows);
  return send(res, 200, { domains: rows.map(domainView) });
}

async function getDomain(res, ctx, _b, params) {
  const d = await withTenant(ctx.shopId, async (c) =>
    (await c.query(`SELECT ${SELECT_COLS} FROM domains WHERE id = $1`, [params[1]])).rows[0]);
  if (!d) return send(res, 404, { error: 'không tìm thấy tên miền' });
  return send(res, 200, { domain: domainView(d) });
}

async function addDomain(res, ctx, body) {
  const host = normalizeHostname(body.hostname);
  if (!host) return send(res, 400, { error: 'tên miền không hợp lệ' });
  // Không cho khách "chiếm" tên miền/subdomain của nền tảng (nền tảng sở hữu apex).
  if (isReserved(host, PLATFORM_DOMAIN)) return send(res, 400, { error: 'không thể dùng tên miền của nền tảng' });
  try {
    const d = await withTenant(ctx.shopId, async (c) => {
      // Trần số tên miền/shop → chống một shop CHIẾM hàng loạt hostname (mỗi dòng giữ lock
      // UNIQUE toàn cục; kết hợp worker dọn challenge chết để không khoá vĩnh viễn).
      const n = (await c.query('SELECT count(*)::int AS n FROM domains')).rows[0].n;
      if (n >= MAX_DOMAINS_PER_SHOP) throw Object.assign(new Error(`đã đạt trần ${MAX_DOMAINS_PER_SHOP} tên miền cho cửa hàng`), { statusCode: 409 });
      const r = await c.query(
        `INSERT INTO domains (shop_id, hostname, verification_token, verified_at, is_primary)
         VALUES (current_shop_id(), $1, $2, NULL, false)
         RETURNING ${SELECT_COLS}`, [host, genToken()]);
      await audit(c, 'domain.added', { actorId: ctx.user.id, ip: ctx.ip, metadata: { hostname: host } });
      return r.rows[0];
    });
    return send(res, 201, { domain: domainView(d) });
  } catch (e) {
    if (e.statusCode) return send(res, e.statusCode, { error: e.message });
    // hostname UNIQUE toàn cục — RLS giấu domain shop khác nên pre-check SELECT không thấy;
    // dựa vào ràng buộc UNIQUE (23505) mới đúng. Chỉ lộ "đã đăng ký", không lộ shop nào.
    if (e.code === '23505') return send(res, 409, { error: 'tên miền đã được đăng ký' });
    throw e;
  }
}

// Đặt tên miền CHÍNH — chỉ khi đã verified (chưa verified thì không có cert, primary sẽ vỡ).
async function setPrimary(res, ctx, _b, params) {
  const out = await withTenant(ctx.shopId, async (c) => {
    await primaryLock(c); // tuần tự hoá với setPrimary/revoke khác của shop → không bao giờ 2 primary
    const d = (await c.query('SELECT verified_at FROM domains WHERE id = $1 FOR UPDATE', [params[1]])).rows[0];
    if (!d) return { code: 404 };
    if (d.verified_at === null) return { code: 409, msg: 'tên miền chưa xác minh — không thể đặt làm chính' };
    // Đúng MỘT primary (không có ràng buộc DB) → hạ hết của shop rồi nâng cái này (RLS scoped).
    await c.query('UPDATE domains SET is_primary = false WHERE is_primary');
    await c.query('UPDATE domains SET is_primary = true WHERE id = $1', [params[1]]);
    await audit(c, 'domain.primary_changed', { actorId: ctx.user.id, ip: ctx.ip, metadata: { domainId: params[1] } });
    return { code: 200 };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy tên miền' });
  if (out.code === 409) return send(res, 409, { error: out.msg });
  return send(res, 200, { ok: true });
}

// Gỡ tên miền (DELETE) → storefront/checkout ngừng phục vụ NGAY (đọc verified_at không cache).
// Chặn gỡ subdomain nền tảng + tên miền CHÍNH (shop cần một host + link preview).
async function revokeDomain(res, ctx, _b, params) {
  const out = await withTenant(ctx.shopId, async (c) => {
    await primaryLock(c); // cùng khoá với setPrimary → guard is_primary đọc trạng thái nhất quán
    const d = (await c.query('SELECT hostname, is_primary FROM domains WHERE id = $1 FOR UPDATE', [params[1]])).rows[0];
    if (!d) return { code: 404 };
    if (d.hostname === PLATFORM_DOMAIN || d.hostname.endsWith('.' + PLATFORM_DOMAIN)) return { code: 409, msg: 'không thể gỡ subdomain nền tảng' };
    if (d.is_primary) return { code: 409, msg: 'không thể gỡ tên miền chính — đặt tên miền khác làm chính trước' };
    await c.query('DELETE FROM domains WHERE id = $1', [params[1]]);
    await audit(c, 'domain.revoked', { actorId: ctx.user.id, ip: ctx.ip, metadata: { hostname: d.hostname } });
    return { code: 200 };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy tên miền' });
  if (out.code === 409) return send(res, 409, { error: out.msg });
  return send(res, 200, { ok: true });
}

export const DOMAIN_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/domains$`), perm: null, fn: (res, ctx) => listDomains(res, ctx) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/domains$`), perm: 'domain.write', stepUp: true, fn: (res, ctx, b) => addDomain(res, ctx, b) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/domains/${UUID}$`), perm: null, fn: (res, ctx, b, p) => getDomain(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/domains/${UUID}/primary$`), perm: 'domain.write', stepUp: true, fn: (res, ctx, b, p) => setPrimary(res, ctx, b, p) },
  { m: 'DELETE', re: new RegExp(`^/shops/${UUID}/domains/${UUID}$`), perm: 'domain.write', stepUp: true, fn: (res, ctx, b, p) => revokeDomain(res, ctx, b, p) },
];
