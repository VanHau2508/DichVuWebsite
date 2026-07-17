/**
 * End-to-end nhật ký hoạt động shop (audit viewer). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/audit-log.e2e.mjs
 *
 * Chứng minh:
 *   1. Owner đọc được nhật ký shop mình (product.created hiện sau khi tạo SP), mới nhất trước.
 *   2. RBAC: admin 200; catalog_manager/order_manager → 403 (thiếu audit.read).
 *   3. LEFT JOIN: dòng audit của người ĐÃ RỜI shop vẫn hiện, actor_email NULL.
 *   4. Cô lập chéo shop: B không thấy dòng của A (qua API lẫn app_rw trực tiếp).
 *   5. RLS chặn dòng identity (shop_id NULL): app_rw + tenant context đếm được 0,
 *      dù app_owner xác nhận các dòng NULL tồn tại thật.
 *   6. Phân trang limit+1 → has_more.
 */

import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';

const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
// Token lời mời KHÔNG còn trong API response (email hoá, 0073) — lấy từ outbox qua owner SQL (ADR-006: cùng tx với INSERT invitations nên đọc được ngay).
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic = 'user.invited' AND payload->>'to' = $1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };
const rw = new pg.Pool({ connectionString: process.env.DATABASE_URL_RW, max: 2 });

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

const uid = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);

async function makeStaff() {
  const email = `staff-${uniq()}@nentang.vn`, password = 'staff strong passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let cookie = await login(email, password);
  const r = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie, origin: OA });
  const key = base32Decode(r.json.secret);
  await rq(AUTH, 'POST', '/auth/mfa/activate', { cookie, body: { code: totp(key, {}) }, origin: OA });
  const c = counterFor(Date.now());
  await owner.query(`INSERT INTO platform_staff (user_id,role) VALUES ($1,'admin')`, [await uid(email)]);
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
  return { shopId, email, password, cookie: await login(email, password) };
}

// Owner mời (qua seller, cần step-up trước) + chấp nhận → cookie thành viên.
async function inviteMember(shopId, ownerCookie, role) {
  const email = `${role}-${uniq()}@shop.vn`, password = 'member passphrase good';
  const r = await rq(SELLER, 'POST', `/shops/${shopId}/members/invite`, { body: { email, role }, cookie: ownerCookie, origin: OS });
  if (r.status !== 201) throw new Error(`mời ${role} thất bại: ${r.raw}`);
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { email, password, cookie: await login(email, password), userId: await uid(email) };
}

const makeProduct = (shopId, cookie, marker) => rq(SELLER, 'POST', `/shops/${shopId}/products`, {
  body: { title: `SP ${marker}`, slug: `sp-${marker}`, price_vnd: 50000, status: 'active', variants: [{ sku: `SK-${marker}`, price_vnd: 50000 }] },
  cookie, origin: OS,
});

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `aud-a-${uniq()}`);
  const Bp = await makeShopOwner(staff, `aud-b-${uniq()}`);
  ok('dựng shop A + shop B');

  // ── 1. Owner đọc nhật ký shop mình ─────────────────────────────────────────
  sect('1. Owner đọc nhật ký shop mình');
  const markerA = `aud${uniq()}`;
  let r = await makeProduct(A.shopId, A.cookie, markerA);
  if (r.status !== 201) throw new Error(`tạo SP thất bại: ${r.raw}`);
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/audit-log`, { cookie: A.cookie });
  r.status === 200 && Array.isArray(r.json?.entries) ? ok('GET audit-log → 200 + entries[]') : bad('audit-log lỗi', r.raw);
  const created = (r.json?.entries ?? []).find((e) => e.action === 'product.created');
  created ? ok('dòng product.created xuất hiện sau khi tạo SP') : bad('thiếu product.created', r.raw);
  created?.actor_email === A.email ? ok('actor_email = email owner (LEFT JOIN member_visibility)') : bad('actor_email sai', JSON.stringify(created));
  const ids = (r.json?.entries ?? []).map((e) => Number(e.id));
  ids.every((v, i) => i === 0 || v <= ids[i - 1]) ? ok('sắp xếp mới nhất trước (id giảm dần)') : bad('thứ tự sai', JSON.stringify(ids));

  // ── 1b. Diff TRƯỚC/SAU trong metadata (rà soát #9) ─────────────────────────
  sect('1b. Audit diff from/to (giá, coupon)');
  const pid = (await rq(SELLER, 'GET', `/shops/${A.shopId}/audit-log`, { cookie: A.cookie })).json.entries
    .find((e) => e.action === 'product.created')?.metadata?.productId;
  r = await rq(SELLER, 'PATCH', `/shops/${A.shopId}/products/${pid}`, { body: { price_vnd: 45000, title: `SP ${markerA} sửa` }, cookie: A.cookie, origin: OS });
  if (r.status !== 200) throw new Error(`PATCH sản phẩm thất bại: ${r.raw}`);
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/audit-log`, { cookie: A.cookie });
  const upd = (r.json?.entries ?? []).find((e) => e.action === 'product.updated');
  upd?.metadata?.changed?.price_vnd?.from === 50000 && upd?.metadata?.changed?.price_vnd?.to === 45000
    ? ok('product.updated ghi changed.price_vnd {from:50000, to:45000} — hạ giá CHỨNG MINH được')
    : bad('thiếu diff giá trong audit', JSON.stringify(upd?.metadata));
  upd?.metadata?.changed?.title?.to === `SP ${markerA} sửa`
    ? ok('changed.title ghi from/to') : bad('thiếu diff title', JSON.stringify(upd?.metadata));
  // PATCH lặp lại CÙNG giá trị → không có trường nào đổi thật → metadata KHÔNG có changed.
  await rq(SELLER, 'PATCH', `/shops/${A.shopId}/products/${pid}`, { body: { price_vnd: 45000 }, cookie: A.cookie, origin: OS });
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/audit-log`, { cookie: A.cookie });
  const upd2 = (r.json?.entries ?? []).find((e) => e.action === 'product.updated');
  upd2 && upd2.metadata?.changed === undefined
    ? ok('PATCH cùng giá trị → không ghi changed (chỉ trường ĐỔI thật)') : bad('changed thừa khi không đổi', JSON.stringify(upd2?.metadata));
  // Coupon: tắt active → changed.active {from:true, to:false}.
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/coupons`, { body: { code: `AUD${uniq().toUpperCase()}`, kind: 'percent', value: 10 }, cookie: A.cookie, origin: OS });
  if (r.status !== 201) throw new Error(`tạo coupon thất bại: ${r.raw}`);
  const cpId = r.json.id;
  r = await rq(SELLER, 'PATCH', `/shops/${A.shopId}/coupons/${cpId}`, { body: { active: false }, cookie: A.cookie, origin: OS });
  if (r.status !== 200) throw new Error(`PATCH coupon thất bại: ${r.raw}`);
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/audit-log`, { cookie: A.cookie });
  const cUpd = (r.json?.entries ?? []).find((e) => e.action === 'coupon.updated');
  cUpd?.metadata?.changed?.active?.from === true && cUpd?.metadata?.changed?.active?.to === false
    ? ok('coupon.updated ghi changed.active {from:true, to:false}') : bad('thiếu diff active coupon', JSON.stringify(cUpd?.metadata));

  // ── 2. RBAC: audit.read chỉ owner/admin ────────────────────────────────────
  sect('2. RBAC audit.read');
  r = await rq(AUTH, 'POST', '/auth/step-up', { body: { password: A.password }, cookie: A.cookie, origin: OA });
  if (r.status !== 200) throw new Error(`step-up owner thất bại: ${r.raw}`);
  const admin = await inviteMember(A.shopId, A.cookie, 'admin');
  const catalog = await inviteMember(A.shopId, A.cookie, 'catalog_manager');
  const order = await inviteMember(A.shopId, A.cookie, 'order_manager');
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/audit-log`, { cookie: admin.cookie });
  r.status === 200 ? ok('admin → 200') : bad('admin bị chặn', r.raw);
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/audit-log`, { cookie: catalog.cookie });
  r.status === 403 && r.json?.required === 'audit.read' ? ok('catalog_manager → 403 (required audit.read)') : bad('catalog_manager không bị chặn', r.raw);
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/audit-log`, { cookie: order.cookie });
  r.status === 403 ? ok('order_manager → 403') : bad('order_manager không bị chặn', r.raw);

  // ── 3. LEFT JOIN: dòng của người đã rời shop vẫn hiện ──────────────────────
  sect('3. Người rời shop — dòng audit còn, email ẩn');
  const markerC = `catx${uniq()}`;
  r = await makeProduct(A.shopId, catalog.cookie, markerC);
  if (r.status !== 201) throw new Error(`catalog tạo SP thất bại: ${r.raw}`);
  r = await rq(SELLER, 'DELETE', `/shops/${A.shopId}/members/${catalog.userId}`, { cookie: A.cookie, origin: OS });
  r.status === 200 ? ok('owner gỡ catalog_manager') : bad('gỡ thành viên lỗi', r.raw);
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/audit-log?limit=100`, { cookie: A.cookie });
  const ghost = (r.json?.entries ?? []).find((e) => e.action === 'product.created' && JSON.stringify(e.metadata ?? {}).includes(markerC));
  ghost ? ok('dòng product.created của người ĐÃ RỜI shop vẫn hiện (không bị INNER JOIN nuốt)') : bad('mất dòng audit của người đã rời', r.raw.slice(0, 500));
  ghost && ghost.actor_email == null ? ok('actor_email NULL (không còn là thành viên → member_visibility ẩn)') : bad('actor_email phải NULL', JSON.stringify(ghost));

  // ── 4. Cô lập chéo shop ────────────────────────────────────────────────────
  sect('4. Cô lập chéo shop (RLS)');
  r = await rq(SELLER, 'GET', `/shops/${Bp.shopId}/audit-log?limit=100`, { cookie: Bp.cookie });
  r.status === 200 ? ok('owner B đọc nhật ký shop B') : bad('B đọc lỗi', r.raw);
  const leakA = JSON.stringify(r.json?.entries ?? []).includes(markerA) || JSON.stringify(r.json?.entries ?? []).includes(markerC);
  leakA ? bad('shop B THẤY dòng của shop A — rò RLS!') : ok('shop B không thấy dòng nào của shop A');
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/audit-log`, { cookie: Bp.cookie });
  r.status === 404 ? ok('owner B gọi audit-log shop A → 404 (không phải thành viên)') : bad('B chạm được shop A', r.raw);

  // ── 5. app_rw trực tiếp: dòng NULL vô hình, chéo shop = 0 ──────────────────
  sect('5. RLS trực tiếp qua app_rw');
  const nullTotal = Number((await owner.query(`SELECT count(*)::int n FROM audit_logs WHERE shop_id IS NULL`)).rows[0].n);
  nullTotal > 0 ? ok(`app_owner xác nhận CÓ ${nullTotal} dòng identity (shop_id NULL) trong bảng`) : bad('không có dòng NULL để chứng minh (auth phải ghi register/login)');
  const c = await rw.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.shop_id', $1, true)`, [A.shopId]);
    const nullSeen = Number((await c.query(`SELECT count(*)::int n FROM audit_logs WHERE shop_id IS NULL`)).rows[0].n);
    nullSeen === 0 ? ok('app_rw + context shop A: dòng shop_id NULL đếm được 0 (RLS chặn)') : bad(`app_rw thấy ${nullSeen} dòng NULL — rò!`);
    const crossSeen = Number((await c.query(`SELECT count(*)::int n FROM audit_logs WHERE shop_id = $1`, [Bp.shopId])).rows[0].n);
    crossSeen === 0 ? ok('app_rw + context shop A: dòng shop B đếm được 0') : bad(`app_rw context A thấy ${crossSeen} dòng shop B — rò!`);
    const ownSeen = Number((await c.query(`SELECT count(*)::int n FROM audit_logs`)).rows[0].n);
    ownSeen > 0 ? ok(`app_rw + context shop A: thấy ${ownSeen} dòng của chính A`) : bad('context A không thấy dòng nào của A');
    await c.query('ROLLBACK');
    // Không đặt context → fail-closed: 0 dòng.
    const noCtx = Number((await c.query(`SELECT count(*)::int n FROM audit_logs`)).rows[0].n);
    noCtx === 0 ? ok('app_rw KHÔNG context: 0 dòng (fail-closed)') : bad(`không context vẫn thấy ${noCtx} dòng`);
  } finally { c.release(); }

  // ── 6. Phân trang ──────────────────────────────────────────────────────────
  sect('6. Phân trang has_more');
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/audit-log?limit=2&offset=0`, { cookie: A.cookie });
  r.json?.entries?.length === 2 && r.json?.has_more === true ? ok('limit=2 → 2 dòng + has_more true') : bad('phân trang sai', r.raw);
  const p1 = (r.json?.entries ?? []).map((e) => e.id);
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/audit-log?limit=2&offset=2`, { cookie: A.cookie });
  const p2 = (r.json?.entries ?? []).map((e) => e.id);
  p2.length > 0 && !p1.some((i) => p2.includes(i)) ? ok('offset=2 → trang kế, không trùng dòng') : bad('offset không dịch trang', JSON.stringify({ p1, p2 }));

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end(); await rw.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
