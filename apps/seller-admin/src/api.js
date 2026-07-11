/**
 * Client gọi backend nội bộ (auth/seller/platform), FORWARD cookie phiên của trình
 * duyệt + gửi Origin của admin (backend originAllowed đòi Origin thuộc allowlist cho
 * POST). Trả {status, json, setCookie} để relay Set-Cookie (login/mfa) về trình duyệt.
 */
const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const ADMIN_ORIGIN = process.env.ADMIN_ORIGIN ?? 'https://admin.nentang.vn';

async function call(base, method, path, { cookie, body } = {}) {
  const headers = { origin: ADMIN_ORIGIN };
  if (cookie) headers.cookie = `__Host-session=${cookie}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, setCookie: r.headers.getSetCookie() };
}

export const authApi = (m, p, o) => call(AUTH, m, p, o);
export const sellerApi = (m, p, o) => call(SELLER, m, p, o);
export const platformApi = (m, p, o) => call(PLATFORM, m, p, o);

/** Nạp phiên: gọi /auth/me. Trả {state:'ok'|'mfa'|'anon', me?}. */
export async function loadSession(cookie) {
  if (!cookie) return { state: 'anon' };
  const r = await authApi('GET', '/auth/me', { cookie });
  if (r.status === 200) return { state: 'ok', me: r.json };
  if (r.status === 401 && r.json?.mfa_required) return { state: 'mfa' };
  return { state: 'anon' };
}
