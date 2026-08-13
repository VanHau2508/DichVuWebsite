/**
 * End-to-end thao tác SECTION (kéo–thả) cho trang nội dung. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/blocks.e2e.mjs
 *
 * Bất biến:
 *   - Block có id ổn định; add/update/delete/reorder thao tác trên DRAFT.
 *   - reorder chỉ nhận HOÁN VỊ đúng của tập id hiện có (không lén thêm/bớt/nhân bản).
 *   - Section types mới (list/quote/divider) render đúng + escape (ADR-008).
 *   - Versioned: sắp lại draft sau publish KHÔNG đổi bản live tới khi publish lại.
 *   - Cô lập tenant: thành viên shop khác không thao tác được block.
 */

import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const STORE = new URL(process.env.STOREFRONT_URL ?? 'http://storefront:3050');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
// Token lời mời KHÔNG còn trong API response (email hoá, 0073) — lấy từ outbox qua owner SQL (ADR-006: cùng tx với INSERT invitations nên đọc được ngay).
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
const uid = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;

function sf(host, path = '/') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: STORE.hostname, port: STORE.port, path, method: 'GET', headers: { host } },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); },
    );
    req.on('error', reject);
    req.end();
  });
}

async function makeStaff() {
  const email = `staff-${uniq()}@nentang.vn`, password = 'staff strong passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let cookie = await login(email, password);
  let r = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie, origin: OA });
  const key = base32Decode(r.json.secret);
  await rq(AUTH, 'POST', '/auth/mfa/activate', { cookie, body: { code: totp(key, {}) }, origin: OA });
  const c = counterFor(Date.now());
  await owner.query(`INSERT INTO platform_staff (user_id,role) VALUES ($1,'admin')`, [await uid(email)]);
  while (counterFor(Date.now()) <= c) await sleep(1000);
  cookie = await login(email, password);
  // A6: mfa/verify ROTATE token → lấy cookie mới
  cookie = ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA })).sc) ?? cookie;
  return cookie;
}
async function makeShopOwner(staffCookie, slug) {
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  await owner.query(`UPDATE shops SET status='active', went_live_at=now() WHERE id=$1`, [shopId]);
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, slug, host: `${slug}.nentang.vn`, cookie: await login(email, password) };
}
const S = (shopId, cookie) => ({
  get: (p) => rq(SELLER, 'GET', `/shops/${shopId}${p}`, { cookie }),
  post: (p, body) => rq(SELLER, 'POST', `/shops/${shopId}${p}`, { body, cookie, origin: OS }),
  patch: (p, body) => rq(SELLER, 'PATCH', `/shops/${shopId}${p}`, { body, cookie, origin: OS }),
  del: (p) => rq(SELLER, 'DELETE', `/shops/${shopId}${p}`, { cookie, origin: OS }),
});
const typesOf = async (a, pid) => (await a.get(`/pages/${pid}`)).json.blocks.map((b) => b.type);

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `blk-${uniq()}`);
  const Bs = await makeShopOwner(staff, `blkb-${uniq()}`);
  const a = S(A.shopId, A.cookie);
  const b = S(Bs.shopId, Bs.cookie);
  ok('dựng 2 shop + owner');
  const pid = (await a.post('/pages', { slug: 'trang', title: 'Trang', blocks: [] })).json.id;

  // ── 1. Thêm đủ 5 loại section ──────────────────────────────────────────────
  sect('1. Thêm section (5 loại)');
  const idH = (await a.post(`/pages/${pid}/blocks`, { type: 'heading', text: 'H_HEADING' })).json.id;
  const idP = (await a.post(`/pages/${pid}/blocks`, { type: 'paragraph', text: 'P_PARA' })).json.id;
  const idL = (await a.post(`/pages/${pid}/blocks`, { type: 'list', items: ['L_ITEM1', 'L_ITEM2'] })).json.id;
  const idQ = (await a.post(`/pages/${pid}/blocks`, { type: 'quote', text: 'Q_QUOTE', cite: 'Q_CITE' })).json.id;
  const idD = (await a.post(`/pages/${pid}/blocks`, { type: 'divider' })).json.id;
  [idH, idP, idL, idQ, idD].every(Boolean) ? ok('5 add trả id') : bad('add thiếu id');
  JSON.stringify(await typesOf(a, pid)) === JSON.stringify(['heading', 'paragraph', 'list', 'quote', 'divider'])
    ? ok('getPage: đúng thứ tự + type + có id') : bad('thứ tự/type sai', JSON.stringify(await typesOf(a, pid)));

  // ── 2. Chèn theo index ─────────────────────────────────────────────────────
  sect('2. Chèn theo index');
  await a.post(`/pages/${pid}/blocks`, { type: 'heading', text: 'H_TOP', index: 0 });
  (await typesOf(a, pid))[0] === 'heading' && (await a.get(`/pages/${pid}`)).json.blocks[0].text === 'H_TOP'
    ? ok('chèn index=0 → lên đầu') : bad('chèn index sai');
  // dọn về 5 block gốc
  const top = (await a.get(`/pages/${pid}`)).json.blocks[0].id;
  await a.del(`/pages/${pid}/blocks/${top}`);

  // ── 3. Kéo–thả (reorder) ───────────────────────────────────────────────────
  sect('3. Reorder (kéo–thả)');
  let r = await a.post(`/pages/${pid}/blocks/reorder`, { order: [idD, idQ, idL, idP, idH] });
  r.status === 200 ? ok('reorder → 200') : bad('reorder lỗi', r.raw);
  JSON.stringify(await typesOf(a, pid)) === JSON.stringify(['divider', 'quote', 'list', 'paragraph', 'heading'])
    ? ok('thứ tự đảo đúng theo order') : bad('reorder không đổi thứ tự', JSON.stringify(await typesOf(a, pid)));

  // ── 4. reorder chỉ nhận hoán vị đúng ───────────────────────────────────────
  sect('4. reorder chống thêm/bớt/lặp');
  for (const [name, order] of [
    ['thiếu id', [idD, idQ, idL, idP]],
    ['dư id lạ', [idD, idQ, idL, idP, idH, 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz']],
    ['id lặp', [idD, idD, idQ, idL, idP]],
    ['id không thuộc trang', [idD, idQ, idL, idP, '11111111-1111-1111-1111-111111111111']],
  ]) {
    r = await a.post(`/pages/${pid}/blocks/reorder`, { order });
    r.status === 422 ? ok(`${name} → 422`) : bad(`${name} → ${r.status}, mong 422`, r.raw);
  }

  // ── 5. Sửa / xoá block ─────────────────────────────────────────────────────
  sect('5. Sửa / xoá');
  r = await a.patch(`/pages/${pid}/blocks/${idP}`, { type: 'paragraph', text: 'P_PARA_EDIT' });
  const edited = (await a.get(`/pages/${pid}`)).json.blocks.find((x) => x.id === idP);
  r.status === 200 && edited.text === 'P_PARA_EDIT' ? ok('update block giữ id, đổi nội dung') : bad('update lỗi', r.raw);
  r = await a.patch(`/pages/${pid}/blocks/11111111-1111-1111-1111-111111111111`, { type: 'paragraph', text: 'x' });
  r.status === 404 ? ok('update block không tồn tại → 404') : bad('update block lạ không 404', String(r.status));
  r = await a.del(`/pages/${pid}/blocks/${idD}`);
  r.status === 200 && !(await typesOf(a, pid)).includes('divider') ? ok('xoá divider') : bad('xoá block lỗi', r.raw);
  r = await a.del(`/pages/${pid}/blocks/11111111-1111-1111-1111-111111111111`);
  r.status === 404 ? ok('xoá block không tồn tại → 404') : bad('xoá block lạ không 404', String(r.status));

  // ── 6. Validation ──────────────────────────────────────────────────────────
  sect('6. Validation');
  for (const [name, body] of [
    ['type lạ', { type: 'iframe', text: 'x' }],
    ['list rỗng', { type: 'list', items: [] }],
    ['list item không phải chuỗi', { type: 'list', items: [123] }],
    ['quote thiếu text', { type: 'quote' }],
  ]) {
    r = await a.post(`/pages/${pid}/blocks`, body);
    r.status === 400 ? ok(`${name} → 400`) : bad(`${name} → ${r.status}`, r.raw);
  }

  // ── 7. Render storefront (published) + escape ──────────────────────────────
  sect('7. Render section trên storefront');
  // Thêm block độc để kiểm escape
  await a.post(`/pages/${pid}/blocks`, { type: 'list', items: ['<script>alert(1)</script>SAFE'] });
  await a.post(`/pages/${pid}/publish`, {});
  r = await sf(A.host, '/pages/trang');
  r.body.includes('<blockquote>') && r.body.includes('Q_QUOTE') && r.body.includes('<cite>Q_CITE</cite>') ? ok('quote render <blockquote>+<cite>') : bad('quote render sai');
  r.body.includes('<ul>') && r.body.includes('<li>L_ITEM1</li>') ? ok('list render <ul><li>') : bad('list render sai');
  const order = ['Q_QUOTE', 'L_ITEM1', 'P_PARA_EDIT', 'H_HEADING'].map((s) => r.body.indexOf(s));
  order.every((v, i) => i === 0 || (v > order[i - 1] && v > 0)) ? ok('thứ tự render khớp reorder') : bad('thứ tự render sai', JSON.stringify(order));
  !r.body.includes('<script>alert(1)') && r.body.includes('&lt;script&gt;') ? ok('list item chứa XSS được escape') : bad('XSS trong list không escape');

  // ── 8. Versioned: reorder draft không đổi bản live ─────────────────────────
  sect('8. Reorder draft không đổi bản live');
  const cur = (await a.get(`/pages/${pid}`)).json.blocks.map((x) => x.id);
  await a.post(`/pages/${pid}/blocks/reorder`, { order: [...cur].reverse() });
  r = await sf(A.host, '/pages/trang');
  const live = ['Q_QUOTE', 'H_HEADING'].map((s) => r.body.indexOf(s));
  live[0] < live[1] ? ok('storefront vẫn thứ tự đã published (chưa publish lại)') : bad('reorder draft rò ra bản live');

  // ── 9. Cô lập tenant ───────────────────────────────────────────────────────
  sect('9. Cô lập tenant');
  r = await b.post(`/pages/${pid}/blocks`, { type: 'paragraph', text: 'HACK' });
  r.status === 404 ? ok('shop B thêm block vào trang shop A → 404') : bad('rò thao tác block chéo shop', String(r.status));
  r = await b.post(`/pages/${pid}/blocks/reorder`, { order: cur });
  r.status === 404 ? ok('shop B reorder trang shop A → 404') : bad('rò reorder chéo shop', String(r.status));

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('blocks e2e lỗi:', err); process.exit(2); });
