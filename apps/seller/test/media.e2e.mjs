/**
 * End-to-end media. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/media.e2e.mjs
 *
 * Kiểm các tính chất bảo mật của pipeline ảnh:
 *   - Kiểm magic byte, không tin Content-Type → chặn file giả dạng ảnh.
 *   - Bản gốc ở bucket PRIVATE (ẩn danh → 403); chỉ WebP re-encode lên PUBLIC.
 *   - Re-encode STRIP payload nhúng (png + đuôi rác → WebP sạch, không còn rác).
 *   - Quá cỡ → 413.
 */

import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const PRIV_BASE = process.env.MEDIA_PRIVATE_BASE ?? 'http://minio:9000/media-private';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });

// PNG 1x1 hợp lệ (đỏ), base64. dbtest không có sharp nên nhúng sẵn ảnh mẫu.
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

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

// Upload nhị phân: gửi Buffer thô + Content-Type do ta khai (để test không-tin-header).
async function upload(shopId, productId, cookie, buf, contentType) {
  const r = await fetch(`${SELLER}/shops/${shopId}/products/${productId}/media`, {
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
  await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA });
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
  const A = await makeShopOwner(staff, `med-${uniq()}`);
  let r = await rq(SELLER, 'POST', `/shops/${A.shopId}/products`, {
    body: { title: 'SP ảnh', slug: `anh-${uniq()}`, price_vnd: 1000, variants: [{ sku: `M-${uniq()}`, price_vnd: 1000 }] },
    cookie: A.cookie, origin: OS,
  });
  const productId = r.json.id;
  ok('dựng shop + sản phẩm');

  // ── 1. Upload ảnh hợp lệ ───────────────────────────────────────────────────
  sect('1. Upload & re-encode');
  let u = await upload(A.shopId, productId, A.cookie, PNG_1x1, 'image/png');
  const mediaId = u.json?.id;
  u.status === 201 && mediaId && u.json.url ? ok('upload PNG → 201, media ready') : bad('upload lỗi', u.raw);

  // Ảnh public phải là WebP (re-encode), truy cập ẨN DANH được.
  if (u.json?.url) {
    const pub = await fetch(u.json.url);
    const bytes = Buffer.from(await pub.arrayBuffer());
    const isWebp = bytes.slice(0, 4).toString('latin1') === 'RIFF' && bytes.slice(8, 12).toString('latin1') === 'WEBP';
    pub.status === 200 && isWebp ? ok('ảnh public truy cập ẩn danh được VÀ là WebP (đã re-encode)') : bad('ảnh public sai', `status=${pub.status} webp=${isWebp}`);
  }

  // ── 2. Bản gốc PRIVATE không truy cập ẩn danh ──────────────────────────────
  sect('2. Bản gốc private');
  const originalKey = `staging/${A.shopId}/${mediaId}`;
  const priv = await fetch(`${PRIV_BASE}/${originalKey}`);
  priv.status === 403 || priv.status === 401 ? ok(`bản gốc bucket private → ${priv.status} (ẩn danh bị chặn)`) : bad('bản gốc private truy cập được', `status=${priv.status}`);

  // ── 3. Không tin Content-Type: file rác giả dạng ảnh ───────────────────────
  sect('3. Magic byte, không tin Content-Type');
  u = await upload(A.shopId, productId, A.cookie, Buffer.from('MZ\x90\x00 đây là exe/text, không phải ảnh, dù header nói image/png'), 'image/png');
  u.status === 400 ? ok('file không phải ảnh (dù Content-Type image/png) → 400') : bad('file giả dạng ảnh lọt qua', u.raw);

  // ── 4. Re-encode strip payload nhúng ───────────────────────────────────────
  sect('4. Re-encode strip payload');
  const marker = 'SECRET_EMBEDDED_PAYLOAD_' + uniq().toUpperCase();
  const polyglot = Buffer.concat([PNG_1x1, Buffer.from(marker)]); // PNG hợp lệ + rác đuôi
  u = await upload(A.shopId, productId, A.cookie, polyglot, 'image/png');
  if (u.status === 201 && u.json.url) {
    const bytes = Buffer.from(await (await fetch(u.json.url)).arrayBuffer());
    !bytes.toString('latin1').includes(marker)
      ? ok('WebP đầu ra KHÔNG chứa payload nhúng (re-encode đã strip)')
      : bad('payload nhúng sống sót qua re-encode', 'marker còn trong output');
  } else bad('upload polyglot lỗi', u.raw);

  // ── 5. Quá cỡ ──────────────────────────────────────────────────────────────
  sect('5. Giới hạn kích thước');
  u = await upload(A.shopId, productId, A.cookie, Buffer.alloc(11 * 1024 * 1024, 0x41), 'image/png');
  u.status === 413 ? ok('upload > 10MB → 413') : bad('nhận file quá cỡ', String(u.status));

  // ── 6. List & xoá ──────────────────────────────────────────────────────────
  sect('6. List & xoá');
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${productId}/media`, { cookie: A.cookie });
  const readyCount = (r.json?.media ?? []).filter((m) => m.status === 'ready').length;
  readyCount >= 2 ? ok(`list media: ${readyCount} ảnh ready`) : bad('list media sai', r.raw);

  r = await rq(SELLER, 'DELETE', `/shops/${A.shopId}/media/${mediaId}`, { cookie: A.cookie, origin: OS });
  r.status === 200 ? ok('xoá media → 200') : bad('xoá media lỗi', r.raw);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('media e2e lỗi:', err); process.exit(2); });
