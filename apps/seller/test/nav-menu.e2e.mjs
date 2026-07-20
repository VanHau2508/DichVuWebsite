/**
 * End-to-end sanitize menu điều hướng "Sản phẩm" (Phase 5b). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/nav-menu.e2e.mjs
 *
 * Kiểm (qua PUT theme → GET đọc lại header.props):
 *   - nav_links: loại mục url javascript: (safeLink) ; kẹp nhãn ≤40 ; cap >6 → còn 6 ;
 *     bỏ mục thiếu nhãn/URL ; giữ nội bộ '/...' + http(s).
 *   - toggle menu_show_* ép về bool (chuỗi/số lạ → true/false).
 */

import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic = 'user.invited' AND payload->>'to' = $1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

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

// Đọc header.props từ theme đang lưu.
async function headerProps(shopId, cookie) {
  const r = await rq(SELLER, 'GET', `/shops/${shopId}/theme`, { cookie });
  return (Array.isArray(r.json?.layout) ? r.json.layout.find((s) => s && s.section === 'header') : null)?.props ?? {};
}
const putHeader = (shopId, cookie, props) => rq(SELLER, 'PUT', `/shops/${shopId}/theme`, {
  cookie, origin: OS,
  body: { tokens: {}, layout: [{ section: 'header', props }, { section: 'hero', props: {} }, { section: 'product_grid', props: {} }, { section: 'footer', props: {} }] },
});

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `nav-${uniq()}`);
  ok('dựng shop owner');

  // ── 1. nav_links: lọc url không an toàn + kẹp nhãn + bỏ mục rỗng ──────────────
  sect('1. Sanitize nav_links');
  let r = await putHeader(A.shopId, A.cookie, {
    nav_links: [
      { label: 'Về chúng tôi', url: '/pages/gioi-thieu' },              // hợp lệ nội bộ
      { label: 'Fanpage', url: 'https://facebook.com/shop' },           // hợp lệ http(s)
      { label: 'Độc', url: 'javascript:alert(1)' },                     // url độc → bỏ
      { label: 'Rỗng URL', url: '' },                                   // thiếu url → bỏ
      { label: '', url: '/x' },                                         // thiếu nhãn → bỏ
      { label: 'N'.repeat(80), url: '/dai' },                           // nhãn dài → kẹp 40
    ],
  });
  let hp = await headerProps(A.shopId, A.cookie);
  const links = Array.isArray(hp.nav_links) ? hp.nav_links : [];
  const okLen = links.length === 3;
  const dropJs = !links.some((l) => /javascript:/i.test(l.url));
  const clamped = links.find((l) => l.url === '/dai')?.label.length === 40;
  const keptInternal = links.some((l) => l.url === '/pages/gioi-thieu' && l.label === 'Về chúng tôi');
  const keptHttp = links.some((l) => l.url === 'https://facebook.com/shop');
  (r.status === 200 && okLen && dropJs && clamped && keptInternal && keptHttp)
    ? ok('bỏ url javascript:/mục rỗng, kẹp nhãn 40, giữ nội bộ+http(s) → còn 3 mục')
    : bad('sanitize nav_links sai', `${r.status} len=${links.length} js=${!dropJs} clamp=${clamped}\n${JSON.stringify(links)}`);

  // ── 2. Cap >6 mục → còn tối đa 6 ─────────────────────────────────────────────
  sect('2. Trần 6 liên kết');
  r = await putHeader(A.shopId, A.cookie, {
    nav_links: Array.from({ length: 9 }, (_, i) => ({ label: `Mục ${i}`, url: `/m/${i}` })),
  });
  hp = await headerProps(A.shopId, A.cookie);
  (r.status === 200 && Array.isArray(hp.nav_links) && hp.nav_links.length === 6)
    ? ok('9 mục → cap còn 6') : bad('không cap 6', JSON.stringify(hp.nav_links));

  // ── 3. Toggle ép về bool ─────────────────────────────────────────────────────
  sect('3. Toggle menu_show_* ép bool');
  r = await putHeader(A.shopId, A.cookie, {
    menu_show_featured: true,
    menu_show_new: false,
    menu_show_sale: 'bật',   // chuỗi lạ → true
  });
  hp = await headerProps(A.shopId, A.cookie);
  (r.status === 200 && hp.menu_show_featured === true && hp.menu_show_new === false && hp.menu_show_sale === true)
    ? ok('bool giữ nguyên, chuỗi "bật" ép về true')
    : bad('toggle không ép bool', JSON.stringify({ f: hp.menu_show_featured, n: hp.menu_show_new, s: hp.menu_show_sale }));

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('nav-menu e2e lỗi:', err); process.exit(2); });
