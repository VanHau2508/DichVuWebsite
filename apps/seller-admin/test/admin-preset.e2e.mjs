/**
 * E2E hệ PRESET ngành trong seller-admin (BFF). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-preset.e2e.mjs
 *
 * Kiểm: picker 4 ngành trên trang Giao diện · màn xác nhận (GET không side-effect) · slug lạ →
 * redirect · ÁP PRESET GIỮ ẢNH (banner cũ còn nguyên, tokens+bố cục đổi theo mẫu) · notice ·
 * Khôi phục mặc định (xoá) · cô lập chéo shop · CSRF. No-JS (không <script>).
 */
import pg from 'pg';
import crypto from 'node:crypto';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';
import { getPreset } from '../../../packages/presets/src/index.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

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
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
async function adm(method, path, { cookie, origin, form } = {}) {
  const h = {};
  if (form !== undefined) h['content-type'] = 'application/x-www-form-urlencoded';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(ADMIN + path, { method, headers: h, redirect: 'manual', body: form !== undefined ? new URLSearchParams(form).toString() : undefined });
  const t = await r.text();
  return { status: r.status, location: r.headers.get('location'), sc: r.headers.getSetCookie(), body: t };
}
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;
const sget = (shopId, cookie, path) => rq(SELLER, 'GET', `/shops/${shopId}${path}`, { cookie });

async function makeStaff() {
  const email = `staff-${uniq()}@nentang.vn`, password = 'staff strong passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let cookie = await login(email, password);
  const r = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie, origin: OA });
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
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, email, password, cookie: await login(email, password) };
}

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `pt-${uniq()}`);
  const Bo = await makeShopOwner(staff, `pu-${uniq()}`);
  ok('dựng 2 shop + chủ shop');
  const T = (p) => `/shops/${A.shopId}/theme${p}`;

  sect('1. Trang Giao diện có picker chọn mẫu theo ngành (4 ngành, no-JS)');
  let r = await adm('GET', T(''), { cookie: A.cookie });
  r.status === 200 && /Đổi giao diện theo ngành/.test(r.body)
    && /Thời trang/.test(r.body) && /Thực phẩm/.test(r.body) && /Nội thất/.test(r.body) && /Mỹ phẩm/.test(r.body)
    && r.body.includes('name="preset"') && !r.body.includes('<script')
    ? ok('picker 4 mẫu render + không <script>') : bad('picker sai', r.body.slice(0, 160));

  sect('2. Màn xác nhận (GET, KHÔNG side-effect)');
  const before = (await sget(A.shopId, A.cookie, '/theme')).json;
  r = await adm('GET', T('/preset?preset=food'), { cookie: A.cookie });
  const still = (await sget(A.shopId, A.cookie, '/theme')).json;
  r.status === 200 && /Áp mẫu/.test(r.body) && /giữ banner/i.test(r.body)
    && r.body.includes('value="food"') && !r.body.includes('<script')
    && JSON.stringify(before) === JSON.stringify(still)
    ? ok('confirm food: "Áp mẫu"+"giữ banner", POST preset=food, no-JS, KHÔNG đổi theme') : bad('confirm sai', `${r.status} ${r.body.slice(0, 140)}`);

  sect('3. slug lạ → redirect Giao diện (không lỗi)');
  r = await adm('GET', T('/preset?preset=khong-co'), { cookie: A.cookie });
  (r.status === 302 || r.status === 303) && /\/theme$/.test(r.location ?? '') ? ok('slug lạ → redirect /theme') : bad('slug lạ sai', `${r.status} ${r.location}`);

  sect('4. GIỮ ẢNH: seed banner cũ → áp mẫu food → tokens+bố cục đổi, BANNER CÒN NGUYÊN');
  const bkey = `${A.shopId}/banner-${crypto.randomUUID()}.webp`;
  const seedLayout = [
    { section: 'header', props: { topbar_text: 'CŨ' } },
    { section: 'hero', props: { title: 'Hero cũ', slides: [{ image_key: bkey, headline: 'Banner cũ của tôi', sub: '', button_label: '', button_link: '/' }] } },
    { section: 'footer', props: {} },
  ];
  let pr = await rq(SELLER, 'PUT', `/shops/${A.shopId}/theme`, { cookie: A.cookie, origin: OS, body: { tokens: { 'color.primary': '#111111' }, layout: seedLayout } });
  pr.status === 200 ? ok('seed theme cũ (có banner) qua seller PUT') : bad('seed theme lỗi', `${pr.status} ${pr.raw?.slice(0, 120)}`);

  r = await adm('POST', T('/preset'), { cookie: A.cookie, origin: OADM, form: { preset: 'food' } });
  const applied = (await sget(A.shopId, A.cookie, '/theme')).json;
  const food = getPreset('food');
  const tokOk = applied.tokens?.['color.primary'] === food.tokens['color.primary'] && applied.tokens?.radius === food.tokens.radius;
  const heroSlides = (applied.layout ?? []).find((s) => s.section === 'hero')?.props?.slides ?? [];
  const kept = heroSlides.some((sl) => sl.image_key === bkey && sl.headline === 'Banner cũ của tôi');
  const layMatch = (applied.layout ?? []).map((s) => s.section).join(',') === food.layout.map((s) => s.section).join(',');
  r.status === 303 && /applied=food/.test(r.location ?? '') && tokOk && kept && layMatch
    ? ok('áp food → tokens=food + bố cục=food + BANNER CŨ CÒN NGUYÊN (giữ ảnh)')
    : bad('áp preset giữ-ảnh sai', `st=${r.status} loc=${r.location} tok=${tokOk} kept=${kept} lay=${layMatch}`);

  sect('5. Notice "đã áp mẫu" (no-JS)');
  r = await adm('GET', T('?applied=food'), { cookie: A.cookie });
  r.status === 200 && /Đã áp mẫu/.test(r.body) && /giữ nguyên/.test(r.body) && !r.body.includes('<script') ? ok('notice áp mẫu hiển thị, không <script>') : bad('notice sai', r.body.slice(0, 120));

  sect('6. Khôi phục mặc định (reset) → tokens/layout rỗng (banner mất — nút riêng)');
  r = await adm('POST', T(''), { cookie: A.cookie, origin: OADM, form: { reset: '1' } });
  const afterReset = (await sget(A.shopId, A.cookie, '/theme')).json;
  const emptied = (!afterReset.tokens || Object.keys(afterReset.tokens).length === 0) && (!afterReset.layout || afterReset.layout.length === 0);
  r.status === 303 && emptied ? ok('khôi phục mặc định → tokens+layout rỗng') : bad('reset sai', `${r.status} tok=${JSON.stringify(afterReset.tokens)} lay=${afterReset.layout?.length}`);

  sect('7. Cô lập chéo shop: owner A áp preset lên shop B → chặn, B không đổi');
  r = await adm('POST', `/shops/${Bo.shopId}/theme/preset`, { cookie: A.cookie, origin: OADM, form: { preset: 'fashion' } });
  const bTheme = (await sget(Bo.shopId, Bo.cookie, '/theme')).json;
  const bUntouched = bTheme.tokens?.['color.primary'] !== getPreset('fashion').tokens['color.primary'];
  !/applied=/.test(r.location ?? '') && bUntouched ? ok(`A áp preset lên B → chặn (status ${r.status}), B không đổi`) : bad('cô lập chéo shop hỏng', `${r.status} ${r.location} bUntouched=${bUntouched}`);

  sect('8. CSRF: POST /theme/preset KHÔNG Origin → 403, KHÔNG áp');
  const beforeCsrf = (await sget(A.shopId, A.cookie, '/theme')).json;
  r = await adm('POST', T('/preset'), { cookie: A.cookie, form: { preset: 'cosmetics' } });
  const afterCsrf = (await sget(A.shopId, A.cookie, '/theme')).json;
  r.status === 403 && JSON.stringify(beforeCsrf.tokens ?? {}) === JSON.stringify(afterCsrf.tokens ?? {}) ? ok('POST preset không Origin → 403, không áp') : bad('CSRF preset không chặn', `${r.status}`);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
