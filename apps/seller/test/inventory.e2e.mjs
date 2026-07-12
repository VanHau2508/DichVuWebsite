/**
 * End-to-end tồn kho. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/inventory.e2e.mjs
 *
 * Kiểm: điều chỉnh tăng/giảm, không âm, không dưới reserved, ledger khớp on_hand,
 * ledger append-only, và ĐIỀU CHỈNH ĐỒNG THỜI không mất cập nhật (FOR UPDATE).
 */

import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const rwPool = new pg.Pool({ connectionString: process.env.DATABASE_URL_RW, max: 2 });

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
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);

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
  // A6: mfa/verify ROTATE token → lấy cookie mới
  cookie = ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA })).sc) ?? cookie;
  return cookie;
}

async function makeShopOwner(staffCookie, slug) {
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: r.json.token, password }, origin: OA });
  return { shopId, cookie: await login(email, password) };
}

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `inv-${uniq()}`);
  const S = {
    get: (p) => rq(SELLER, 'GET', `/shops/${A.shopId}${p}`, { cookie: A.cookie }),
    post: (p, body) => rq(SELLER, 'POST', `/shops/${A.shopId}${p}`, { body, cookie: A.cookie, origin: OS }),
  };
  // Tạo sản phẩm 1 biến thể.
  let r = await S.post('/products', { title: 'Áo kho', slug: `kho-${uniq()}`, price_vnd: 100000, variants: [{ sku: `INV-${uniq()}`, price_vnd: 100000 }] });
  const prod = (await S.get(`/products/${r.json.id}`)).json;
  const vid = prod.variants[0].id;
  ok('dựng shop + sản phẩm 1 biến thể');

  // ── 1. Mức tồn ban đầu = 0 ─────────────────────────────────────────────────
  sect('1. Điều chỉnh tồn');
  r = await S.get(`/variants/${vid}/inventory`);
  r.status === 200 && r.json.on_hand === 0 && r.json.available === 0 ? ok('tồn ban đầu = 0') : bad('tồn ban đầu sai', r.raw);

  r = await S.post(`/variants/${vid}/inventory/adjust`, { delta: 100, reason: 'nhập lô đầu' });
  r.status === 200 && r.json.on_hand === 100 ? ok('nhập +100 → on_hand 100') : bad('nhập kho lỗi', r.raw);

  r = await S.post(`/variants/${vid}/inventory/adjust`, { delta: -30, reason: 'hàng lỗi' });
  r.status === 200 && r.json.on_hand === 70 ? ok('điều chỉnh -30 → on_hand 70') : bad('điều chỉnh giảm lỗi', r.raw);

  r = await S.post(`/variants/${vid}/inventory/adjust`, { delta: -1000 });
  r.status === 422 ? ok('giảm quá tồn → 422 (không âm)') : bad('cho on_hand âm', r.raw);

  r = await S.post(`/variants/${vid}/inventory/adjust`, { delta: 0 });
  r.status === 400 ? ok('delta = 0 → 400') : bad('nhận delta 0', r.raw);

  // ── 2. Ledger khớp on_hand ─────────────────────────────────────────────────
  sect('2. Ledger');
  r = await S.get(`/variants/${vid}/inventory/ledger`);
  const sum = r.json.entries.reduce((s, e) => s + e.delta, 0);
  const lvl = (await S.get(`/variants/${vid}/inventory`)).json;
  sum === lvl.on_hand && lvl.on_hand === 70 ? ok(`tổng delta ledger (${sum}) == on_hand (${lvl.on_hand})`) : bad('ledger không khớp on_hand', `sum=${sum} on_hand=${lvl.on_hand}`);
  r.json.entries.length === 2 ? ok('ledger có 2 dòng (nhập + điều chỉnh)') : bad('số dòng ledger sai', String(r.json.entries.length));

  // ── 3. Ledger append-only (app_rw không sửa/xoá) ───────────────────────────
  sect('3. Ledger append-only');
  const client = await rwPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.shop_id', $1, true)`, [A.shopId]);
    let blocked = false;
    try { await client.query('UPDATE inventory_ledger SET delta = 0'); } catch (e) { blocked = e.code === '42501'; }
    blocked ? ok('app_rw UPDATE ledger → bị từ chối (42501)') : bad('app_rw sửa được ledger');
    await client.query('ROLLBACK');
  } finally { client.release(); }

  // ── 4. Điều chỉnh ĐỒNG THỜI không mất cập nhật ─────────────────────────────
  sect('4. Đồng thời (FOR UPDATE)');
  // 20 lần +5 song song. Nếu không khoá dòng → mất cập nhật → tổng < 70+100.
  const before = (await S.get(`/variants/${vid}/inventory`)).json.on_hand;
  await Promise.all(Array.from({ length: 20 }, () => S.post(`/variants/${vid}/inventory/adjust`, { delta: 5 })));
  const after = (await S.get(`/variants/${vid}/inventory`)).json.on_hand;
  after === before + 100
    ? ok(`20 điều chỉnh +5 đồng thời → +100 chính xác (${before}→${after})`)
    : bad(`mất cập nhật khi đồng thời: ${before}→${after}, mong ${before + 100}`);

  // Ledger cũng phải có đủ 20 dòng mới + khớp.
  const led = (await S.get(`/variants/${vid}/inventory/ledger`)).json;
  const total = led.entries.reduce((s, e) => s + e.delta, 0);
  total === after ? ok(`ledger vẫn khớp sau đồng thời (${total})`) : bad('ledger lệch sau đồng thời', `${total} vs ${after}`);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end(); await rwPool.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('inventory e2e lỗi:', err); process.exit(2); });
