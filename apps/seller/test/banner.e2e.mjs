/**
 * End-to-end BANNER trang chủ (Phase 5). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/banner.e2e.mjs
 *
 * Kiểm:
 *   - uploadBanner: file rác giả ảnh (Content-Type nói dối) → 400; PNG thật → 200 +
 *     key "<shop>/banner-<uuid>.webp" + url public là WebP (re-encode).
 *   - PUT theme: slide key hợp lệ (của shop) → 200; key CHÉO SHOP / MALFORMED → 400;
 *     quá 5 slide → 400; chữ dài bị kẹp trần (headline ≤120, sub ≤200).
 */

import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const PRIV_BASE = process.env.MEDIA_PRIVATE_BASE ?? 'http://minio:9000/media-private';
const MEDIA_ORIGIN_INTERNAL = (() => { try { return new URL(PRIV_BASE).origin; } catch { return 'http://minio:9000'; } })();
const absMedia = (u) => (u && /^https?:\/\//i.test(u) ? u : `${MEDIA_ORIGIN_INTERNAL}${u ?? ''}`);
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic = 'user.invited' AND payload->>'to' = $1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // uuid mẫu cho key giả

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${d}${X}`); };
const sect = (m) => console.log(`\n${B}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };

async function rq(base, method, path, { body, cookie, origin } = {}) {
  const h = {};
  if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;

async function uploadBanner(shopId, cookie, buf, contentType) {
  const r = await fetch(`${SELLER}/shops/${shopId}/banner-image`, {
    method: 'POST',
    headers: { 'content-type': contentType, origin: OS, cookie: `__Host-session=${cookie}` },
    body: buf,
  });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, raw: t };
}

async function makeStaff() {
  const email = `staff-${uniq()}@nentang.vn`, password = 'staff strong passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let cookie = await login(email, password);
  let r = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie, origin: OA });
  const key = base32Decode(r.json.secret);
  await rq(AUTH, 'POST', '/auth/mfa/activate', { cookie, body: { code: totp(key, {}) }, origin: OA });
  const c = counterFor(Date.now());
  await owner.query(`INSERT INTO platform_staff (user_id,role) VALUES ($1,'admin')`, [await uidOf(email)]);
  while (counterFor(Date.now()) <= c) await sleep(1000);
  cookie = await login(email, password);
  cookie = ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA })).sc) ?? cookie;
  return cookie;
}
async function makeShopOwner(staffCookie, slug) {
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, cookie: await login(email, password) };
}

// Lấy hero.props.slides từ theme đang lưu.
async function heroSlides(shopId, cookie) {
  const r = await rq(SELLER, 'GET', `/shops/${shopId}/theme`, { cookie });
  const hero = (Array.isArray(r.json?.layout) ? r.json.layout.find((s) => s && s.section === 'hero') : null)?.props ?? {};
  return Array.isArray(hero.slides) ? hero.slides : [];
}
const putTheme = (shopId, cookie, layout) => rq(SELLER, 'PUT', `/shops/${shopId}/theme`, { cookie, body: { tokens: {}, layout }, origin: OS });
const bannerLayout = (slides) => [{ section: 'header', props: {} }, { section: 'hero', props: { slides } }, { section: 'product_grid', props: {} }, { section: 'footer', props: {} }];

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `bnr-${uniq()}`);
  const Bs = await makeShopOwner(staff, `bnrb-${uniq()}`);
  ok('dựng 2 shop owner');

  // ── 1. Upload banner ────────────────────────────────────────────────────────
  sect('1. Upload banner (magic byte + re-encode WebP)');
  let u = await uploadBanner(A.shopId, A.cookie, Buffer.from('MZ\x90\x00 không phải ảnh dù nói image/png'), 'image/png');
  u.status === 400 ? ok('file rác giả ảnh (Content-Type image/png) → 400') : bad('file giả ảnh lọt', u.raw);

  u = await uploadBanner(A.shopId, A.cookie, PNG_1x1, 'image/png');
  const bannerKey = u.json?.key;
  const keyRe = new RegExp(`^${A.shopId}/banner-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.webp$`);
  u.status === 200 && bannerKey && keyRe.test(bannerKey) && u.json.url
    ? ok(`PNG thật → 200, key banner- đúng namespace shop (${bannerKey.slice(0, 20)}…)`) : bad('upload banner lỗi', u.raw);

  if (u.json?.url) {
    const pub = await fetch(absMedia(u.json.url));
    const bytes = Buffer.from(await pub.arrayBuffer());
    const isWebp = bytes.slice(0, 4).toString('latin1') === 'RIFF' && bytes.slice(8, 12).toString('latin1') === 'WEBP';
    pub.status === 200 && isWebp ? ok('ảnh banner public là WebP (re-encode), ẩn danh đọc được') : bad('banner public sai', `status=${pub.status} webp=${isWebp}`);
  }

  u = await uploadBanner(A.shopId, A.cookie, Buffer.alloc(11 * 1024 * 1024, 0x41), 'image/png');
  u.status === 413 ? ok('banner > 10MB → 413') : bad('nhận banner quá cỡ', String(u.status));

  // Upload cho shop B (để test chéo shop).
  const uB = await uploadBanner(Bs.shopId, Bs.cookie, PNG_1x1, 'image/png');
  const keyB = uB.json?.key;
  uB.status === 200 && keyB ? ok('shop B có key banner riêng') : bad('upload banner B lỗi', uB.raw);

  // ── 2. Lưu theme với slide banner ───────────────────────────────────────────
  sect('2. PUT theme — validate slide key');
  let r = await putTheme(A.shopId, A.cookie, bannerLayout([
    { image_key: bannerKey, headline: 'Thu Đông', sub: 'Giảm 30%', button_label: 'Mua ngay', button_link: '/c/ao' },
  ]));
  let slides = await heroSlides(A.shopId, A.cookie);
  r.status === 200 && slides.length === 1 && slides[0].image_key === bannerKey && slides[0].button_link === '/c/ao'
    ? ok('slide key hợp lệ của shop → lưu 200, đọc lại đúng') : bad('lưu slide hợp lệ lỗi', `${r.status} ${JSON.stringify(slides)}`);

  // Key CHÉO SHOP (key của B) → 400.
  r = await putTheme(A.shopId, A.cookie, bannerLayout([{ image_key: keyB, headline: 'x' }]));
  r.status === 400 ? ok('key banner CHÉO SHOP (của B) → 400 (chặn)') : bad('key chéo shop lọt', String(r.status));

  // Key MALFORMED / traversal → 400.
  for (const badKey of [`${A.shopId}/../secret.webp`, `${A.shopId}/banner-notuuid.webp`, 'evil.webp', `${A.shopId}/logo-${UUID}.webp`]) {
    r = await putTheme(A.shopId, A.cookie, bannerLayout([{ image_key: badKey }]));
    r.status === 400 ? ok(`key malformed "${badKey.slice(0, 24)}…" → 400`) : bad('key malformed lọt', `${badKey} → ${r.status}`);
  }

  // ── 3. Trần số slide + kẹp độ dài chữ ───────────────────────────────────────
  sect('3. Trần 5 slide + kẹp độ dài');
  r = await putTheme(A.shopId, A.cookie, bannerLayout(Array.from({ length: 6 }, () => ({ image_key: bannerKey }))));
  r.status === 400 ? ok('6 slide (> 5) → 400') : bad('vượt trần slide lọt', String(r.status));

  r = await putTheme(A.shopId, A.cookie, bannerLayout([
    { image_key: bannerKey, headline: 'H'.repeat(300), sub: 'S'.repeat(400), button_link: 'javascript:alert(1)' },
  ]));
  slides = await heroSlides(A.shopId, A.cookie);
  r.status === 200 && slides[0].headline.length === 120 && slides[0].sub.length === 200 && slides[0].button_link === ''
    ? ok('chữ dài bị kẹp (headline 120, sub 200) + button_link javascript: bị loại') : bad('kẹp/lọc link sai', JSON.stringify(slides[0]));

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('banner e2e lỗi:', err); process.exit(2); });
