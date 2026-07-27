/**
 * End-to-end custom domain (A5). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/domains.e2e.mjs
 *
 * Luồng đóng: owner thêm domain (domain.write + step-up) → challenge TXT → thêm TXT vào
 * dns-stub → worker verify-sweep tra DNS → verified_at bật → tls-authorize CẤP cert. Revoke
 * → domain chết (tls từ chối). Cùng: chưa verify không cấp cert, non-owner chặn, guard tên miền.
 *
 * Dùng host RIÊNG cho mỗi khẳng định để cache của tls-authorize (deny 15s / allow 5') không
 * lẫn giữa các bước.
 */
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const WORKER = process.env.WORKER_URL ?? 'http://worker:3080';
const TLS = process.env.TLS_URL ?? 'http://tls-authorize:3010';
const DNS_STUB = process.env.DNS_STUB_URL ?? 'http://dns-stub:8600';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
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
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;
const stepUp = (cookie, password) => rq(AUTH, 'POST', '/auth/step-up', { body: { password }, cookie, origin: OA });
// tls-authorize: Caddy hỏi trước khi cấp cert. 200 = cấp, 403 = từ chối.
const tlsAuthorize = async (host) => (await fetch(`${TLS}/internal/tls/authorize?domain=${encodeURIComponent(host)}`)).status;
const setTxt = (name, txt) => fetch(`${DNS_STUB}/set`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, txt }) });
const verifySweep = async (batch) => (await (await fetch(`${WORKER}/internal/verify-sweep${batch ? `?batch=${batch}` : ''}`, { method: 'POST' })).json());

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
  return { shopId, slug, email, password, cookie: await login(email, password) };
}
async function addAdmin(shop) {
  await stepUp(shop.cookie, shop.password);
  const email = `adm-${uniq()}@shop.vn`, password = 'admin passphrase strong';
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/members/invite`, { body: { email, role: 'admin' }, cookie: shop.cookie, origin: OS });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { email, password, cookie: await login(email, password) };
}
// Thêm domain (cần step-up) → trả {id, hostname, challenge}. Bảo đảm đã step-up.
async function addDomain(shop, hostname) {
  await stepUp(shop.cookie, shop.password);
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/domains`, { body: { hostname }, cookie: shop.cookie, origin: OS });
  return r;
}
// Thêm + xác minh nhanh: add → set TXT khớp → sweep → trả domain id.
async function addAndVerify(shop, hostname) {
  const r = await addDomain(shop, hostname);
  await setTxt(r.json.domain.challenge.name, r.json.domain.challenge.value);
  await verifySweep();
  return r.json.domain.id;
}

async function main() {
  await fetch(`${DNS_STUB}/clear`, { method: 'POST' }); // sạch bản ghi từ lần chạy trước
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `dom-${uniq()}`);
  ok('chuẩn bị: owner + shop (đã có subdomain nền tảng verified)');

  // ── 1. Gate: thêm domain cần step-up ───────────────────────────────────────
  sect('1. Thêm domain cần step-up + domain.write');
  const h1 = `shop-${uniq()}.example.com`;
  let r = await rq(SELLER, 'POST', `/shops/${A.shopId}/domains`, { body: { hostname: h1 }, cookie: A.cookie, origin: OS });
  r.status === 403 && r.json?.step_up_required ? ok('thêm domain chưa step-up → 403 step_up_required') : bad('thêm được khi chưa step-up', r.raw);

  // ── 2. Thêm → challenge TXT ────────────────────────────────────────────────
  sect('2. Thêm domain → challenge TXT');
  r = await addDomain(A, h1);
  const dom = r.json?.domain;
  r.status === 201 && dom && dom.verified === false && dom.is_primary === false ? ok('thêm domain → 201, chưa verified, không primary') : bad('thêm domain lỗi', r.raw);
  dom?.challenge?.type === 'TXT' && dom.challenge.name === `_nentang-verify.${h1}` && dom.challenge.value ? ok(`challenge TXT đúng (${dom.challenge.name})`) : bad('challenge sai', JSON.stringify(dom?.challenge));

  // ── 3. Chưa verify từ chối → verify qua DNS TXT → tls cấp cert ──────────────
  // (Hỏi tls cho domain CHƯA verify sẽ negative-cache 15s; nên dùng host RIÊNG cho phần
  //  "từ chối", còn h1 chỉ hỏi tls SAU khi verify để không dính cache.)
  sect('3. Xác minh qua DNS TXT → tls cấp cert');
  const hDeny = `deny-${uniq()}.example.com`;
  const rDeny = await addDomain(A, hDeny);
  // Có bản ghi TXT nhưng SAI giá trị → resolveTxt THÀNH CÔNG nhưng không khớp → worker phải
  // TỪ CHỐI (guard cho mutation "bỏ kiểm TXT": nếu không có TXT thì resolveTxt throw, không
  // chạm nhánh so khớp; phải có TXT sai mới bắt được).
  await setTxt(rDeny.json.domain.challenge.name, 'GIA-TRI-SAI-khong-khop-token');
  (await tlsAuthorize(hDeny)) === 403 ? ok('domain chưa verify → tls 403 (không cấp cert)') : bad('cấp cert cho domain chưa verify — LỖ HỔNG');
  await setTxt(dom.challenge.name, dom.challenge.value);
  const sweep = await verifySweep();
  sweep.verified >= 1 ? ok(`worker verify-sweep → verified ${sweep.verified}`) : bad('sweep không verify', JSON.stringify(sweep));
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/domains`, { cookie: A.cookie });
  const after = (r.json?.domains ?? []).find((d) => d.hostname === h1);
  after?.verified === true && after.challenge === null ? ok('list: domain đã verified, ẩn challenge') : bad('domain chưa verified sau sweep', JSON.stringify(after));
  (await tlsAuthorize(h1)) === 200 ? ok('domain đã verify → tls 200 (cấp cert qua on-demand)') : bad('domain verified vẫn không được cấp cert');
  // hDeny KHÔNG có TXT khớp → sau sweep VẪN chưa verified (worker phải KIỂM TXT, không verify bừa).
  (await owner.query('SELECT verified_at FROM domains WHERE hostname=$1', [hDeny])).rows[0].verified_at === null ? ok('domain không có TXT khớp → vẫn chưa verified (worker kiểm TXT)') : bad('worker verify KHÔNG kiểm TXT — LỖ HỔNG (mint cert bừa)');

  // ── 5. Đặt tên miền chính ──────────────────────────────────────────────────
  sect('5. Đặt tên miền chính');
  // primary trên domain CHƯA verify → 409.
  const hUnv = `unv-${uniq()}.example.com`;
  const rUnv = await addDomain(A, hUnv);
  await stepUp(A.cookie, A.password);
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/domains/${rUnv.json.domain.id}/primary`, { cookie: A.cookie, origin: OS });
  r.status === 409 ? ok('đặt primary domain chưa verify → 409') : bad('primary chưa verify không bị chặn', r.raw);
  // primary trên domain đã verify → 200 + hạ primary cũ.
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/domains/${dom.id}/primary`, { cookie: A.cookie, origin: OS });
  r.status === 200 ? ok('đặt custom domain (verified) làm chính → 200') : bad('đặt primary lỗi', r.raw);
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/domains`, { cookie: A.cookie });
  const doms = r.json?.domains ?? [];
  doms.filter((d) => d.is_primary).length === 1 && doms.find((d) => d.hostname === h1)?.is_primary ? ok('đúng MỘT primary, là custom domain') : bad('primary sai', JSON.stringify(doms.map((d) => [d.hostname, d.is_primary])));
  // Storefront: subdomain (giờ KHÔNG primary) → 301 sang tên miền chính (h1), giữ path+query.
  const sfGet = (host, path) => new Promise((rs) => { const rr = http.request({ hostname: 'storefront', port: 3050, path, method: 'GET', headers: { host } }, (x) => { rs({ status: x.statusCode, loc: x.headers.location }); x.resume(); }); rr.on('error', () => rs({ status: 0 })); rr.end(); });
  const sf = await sfGet(`${A.slug}.nentang.vn`, '/?p=1');
  sf.status === 301 && sf.loc === `https://${h1}/?p=1` ? ok('storefront: host phụ 301 → tên miền chính (giữ path+query)') : bad('không 301 host phụ về chính', `${sf.status} ${sf.loc}`);

  // ── 6. Revoke → domain chết ────────────────────────────────────────────────
  sect('6. Gỡ domain (revoke)');
  // Không cho gỡ primary.
  await stepUp(A.cookie, A.password);
  r = await rq(SELLER, 'DELETE', `/shops/${A.shopId}/domains/${dom.id}`, { cookie: A.cookie, origin: OS });
  r.status === 409 ? ok('gỡ tên miền CHÍNH → 409 (đặt cái khác làm chính trước)') : bad('gỡ được primary', r.raw);
  // Không cho gỡ subdomain nền tảng.
  const sub = `${A.slug}.nentang.vn`;
  const subId = (await owner.query('SELECT id FROM domains WHERE hostname=$1', [sub])).rows[0].id;
  r = await rq(SELLER, 'DELETE', `/shops/${A.shopId}/domains/${subId}`, { cookie: A.cookie, origin: OS });
  r.status === 409 ? ok('gỡ subdomain nền tảng → 409') : bad('gỡ được subdomain nền tảng', r.raw);
  // Gỡ một domain verified KHÁC (chưa từng hỏi tls → không dính positive-cache) → chết.
  const hRev = `rev-${uniq()}.example.com`;
  const revId = await addAndVerify(A, hRev);
  await stepUp(A.cookie, A.password);
  r = await rq(SELLER, 'DELETE', `/shops/${A.shopId}/domains/${revId}`, { cookie: A.cookie, origin: OS });
  r.status === 200 ? ok('gỡ domain thường (verified, không primary) → 200') : bad('gỡ domain lỗi', r.raw);
  (await owner.query('SELECT 1 FROM domains WHERE hostname=$1', [hRev])).rowCount === 0 ? ok('domain đã bị xoá khỏi DB') : bad('domain còn trong DB sau revoke');
  (await tlsAuthorize(hRev)) === 403 ? ok('domain đã gỡ → tls 403 (không cấp cert mới)') : bad('domain gỡ rồi vẫn được cấp cert', hRev);

  // ── 7. Guard tên miền ──────────────────────────────────────────────────────
  sect('7. Guard tên miền');
  await stepUp(A.cookie, A.password);
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/domains`, { body: { hostname: 'khong hop le!!' }, cookie: A.cookie, origin: OS });
  r.status === 400 ? ok('hostname không hợp lệ → 400') : bad('hostname bậy được nhận', r.raw);
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/domains`, { body: { hostname: `chiem-${uniq()}.nentang.vn` }, cookie: A.cookie, origin: OS });
  r.status === 400 ? ok('chiếm subdomain nền tảng → 400') : bad('cho chiếm tên miền nền tảng', r.raw);
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/domains`, { body: { hostname: h1 }, cookie: A.cookie, origin: OS });
  r.status === 409 ? ok('thêm hostname trùng → 409') : bad('cho thêm trùng', r.raw);

  // ── 7b. XOAY VÒNG verify-sweep (0103 — chống đói quét) ─────────────────────
  // Domain chưa verify KHÔNG rời tập kết quả (khách quên đặt TXT thì nằm đó tới 7 ngày).
  // Bản cũ `ORDER BY created_at DESC LIMIT 100` ⇒ >100 domain chờ thì đúng 100 dòng MỚI NHẤT
  // bị tra lại mỗi phút, dòng thứ 101 không bao giờ được tra. Ép lô = 1 để dựng lại đúng cảnh:
  // hXoay (có TXT đúng) thêm TRƯỚC, hChan (không TXT) thêm SAU nên luôn "mới nhất".
  sect('7b. Xoay vòng verify-sweep');
  await stepUp(A.cookie, A.password);
  const hXoay = `xoay-${uniq()}.example.com`, hChan = `chan-${uniq()}.example.com`;
  const rXoay = await addDomain(A, hXoay);
  await setTxt(rXoay.json.domain.challenge.name, rXoay.json.domain.challenge.value);
  await addDomain(A, hChan); // KHÔNG đặt TXT → không bao giờ verify được
  const verifiedOf = async (h) => (await owner.query('SELECT verified_at FROM domains WHERE hostname=$1', [h])).rows[0]?.verified_at ?? null;
  await verifySweep(1); // lô 1 → lấy hChan (mới nhất, chưa tra lần nào)
  (await verifiedOf(hXoay)) === null
    ? ok('lô 1: sweep lấy domain mới nhất (hChan) → hXoay chưa tới lượt')
    : bad('sweep lô 1 đã verify hXoay — ca dựng sai, không chứng minh được gì');
  await verifySweep(1); // hChan đã đóng dấu → tới lượt hXoay
  (await verifiedOf(hXoay)) !== null
    ? ok('lô 1 lần 2: hChan xoay xuống cuối → hXoay ĐƯỢC tra và verify (bản cũ kẹt hChan mãi)')
    : bad('đói quét: domain sau lô đầu không bao giờ được tra', hXoay);

  // ── 8. Non-owner + cô lập tenant ───────────────────────────────────────────
  sect('8. Non-owner + cô lập tenant');
  const admin = await addAdmin(A);
  await stepUp(admin.cookie, admin.password);
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/domains`, { body: { hostname: `adm-${uniq()}.example.com` }, cookie: admin.cookie, origin: OS });
  r.status === 403 && r.json?.required === 'domain.write' ? ok('admin thêm domain → 403 (thiếu perm domain.write)') : bad('admin thêm được domain — LỖ HỔNG', r.raw);
  // owner shop B không thấy/gỡ được domain shop A (RLS + membership).
  const Bo = await makeShopOwner(staff, `domb-${uniq()}`);
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/domains`, { cookie: Bo.cookie });
  r.status === 404 ? ok('owner B xem domain shop A → 404 (không phải thành viên)') : bad('owner B thấy domain shop A', String(r.status));

  // ── 9. Review fix: dọn challenge chết + trần domain (chống squat) ───────────
  sect('9. Dọn challenge chết + trần domain');
  // Domain CHƯA verify quá hạn giveup (>7 ngày) → worker XOÁ (giải phóng hostname toàn cục).
  const stale = `stale-${uniq()}.example.com`;
  await owner.query(`INSERT INTO domains (shop_id, hostname, verification_token, verified_at, is_primary, created_at) VALUES ($1,$2,'t',NULL,false, now() - interval '8 days')`, [A.shopId, stale]);
  await verifySweep();
  (await owner.query('SELECT 1 FROM domains WHERE hostname=$1', [stale])).rowCount === 0 ? ok('worker DỌN domain chưa verify quá hạn → giải phóng hostname (chống squat)') : bad('domain chết không bị dọn');
  // Domain ĐÃ verify dù cũ → KHÔNG bị dọn (policy domainverify_gc chỉ xoá verified_at NULL).
  const oldv = `oldv-${uniq()}.example.com`;
  await owner.query(`INSERT INTO domains (shop_id, hostname, verification_token, verified_at, is_primary, created_at) VALUES ($1,$2,'t',now(),false, now() - interval '30 days')`, [A.shopId, oldv]);
  await verifySweep();
  (await owner.query('SELECT 1 FROM domains WHERE hostname=$1', [oldv])).rowCount === 1 ? ok('domain ĐÃ verify KHÔNG bị dọn (dù cũ)') : bad('dọn NHẦM domain đã verify — NGUY HIỂM');
  await owner.query('DELETE FROM domains WHERE hostname=$1', [oldv]);
  // Trần 20 tên miền/shop: seed tới trần rồi thêm → 409.
  const cur = (await owner.query('SELECT count(*)::int n FROM domains WHERE shop_id=$1', [A.shopId])).rows[0].n;
  for (let i = cur; i < 20; i++) await owner.query(`INSERT INTO domains (shop_id, hostname, verification_token, verified_at, is_primary) VALUES ($1,$2,'t',NULL,false)`, [A.shopId, `cap-${i}-${uniq()}.example.com`]);
  await stepUp(A.cookie, A.password);
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/domains`, { body: { hostname: `over-${uniq()}.example.com` }, cookie: A.cookie, origin: OS });
  r.status === 409 && /trần/.test(r.json?.error ?? '') ? ok('đạt trần 20 tên miền/shop → 409') : bad('trần không chặn', r.raw);

  // Dọn domain của shop test — không để dồn dòng chưa-verify làm nghẽn candidate LIMIT 100.
  await owner.query('DELETE FROM domains WHERE shop_id IN ($1, $2)', [A.shopId, Bo.shopId]);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('domains e2e lỗi:', e); process.exit(2); });
