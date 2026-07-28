/**
 * E2E onboarding checklist trong seller-admin (BFF). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-onboarding.e2e.mjs
 *
 * Kiểm: shop mới (onboarding) hiện checklist phản ánh tín hiệu THẬT (ngân hàng/SP) · nút "Mở bán"
 * lật onboarding→active + ẩn checklist + banner chúc mừng · idempotent · cô lập chéo shop · CSRF.
 */
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest';
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
  return { status: r.status, location: r.headers.get('location'), body: t };
}
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;
const statusOf = async (shopId) => (await owner.query('SELECT status FROM shops WHERE id=$1', [shopId])).rows[0]?.status;

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
  const A = await makeShopOwner(staff, `ob-${uniq()}`);
  const Bo = await makeShopOwner(staff, `oc-${uniq()}`);
  (await statusOf(A.shopId)) === 'onboarding' ? ok('dựng 2 shop mới (status onboarding)') : bad('shop không ở onboarding');
  const OV = `/shops/${A.shopId}/overview`;

  sect('1. Shop mới: checklist hiện, 0/4, có nút Mở bán, no-JS');
  let r = await adm('GET', OV, { cookie: A.cookie });
  r.status === 200 && /Hoàn tất thiết lập cửa hàng/.test(r.body) && /0\/4 xong/.test(r.body)
    && /Gắn ngân hàng nhận tiền/.test(r.body) && /Thêm sản phẩm/.test(r.body) && /Mở bán chính thức/.test(r.body) && !r.body.includes('<script')
    ? ok('checklist 0/4 + 4 mục + nút Mở bán, no-JS') : bad('checklist sai', r.body.slice(0, 200));
  // docs/44 §4.11: khối gợi ý KHÔNG được đứng cạnh checklist thiết lập. Hai khối cùng bảo
  // người bán "hãy làm cái này" ở một màn hình là nhiễu, và checklist mới là thứ có thứ tự
  // ưu tiên đúng cho shop chưa mở bán.
  // Bám class="sugg-row" chứ KHÔNG bám chữ hiển thị: chữ hiển thị còn nằm trong <style>
  // (tên lớp, chú thích) nên tìm theo chữ sẽ khớp cả khi khối vắng mặt.
  !/class="sugg-row"/.test(r.body)
    ? ok('shop onboarding: KHÔNG hiện khối gợi ý (checklist đang giữ vai trò dẫn dắt)')
    : bad('khối gợi ý đứng cạnh checklist');

  sect('2. Thêm sản phẩm + gắn ngân hàng nhận tiền → mục ✓, tiến độ tăng');
  await adm('POST', `/shops/${A.shopId}/products`, { cookie: A.cookie, origin: OADM, form: { title: 'SP demo', slug: `sp-${uniq()}`, price_vnd: '100000', status: 'draft', sku: `SKU-${uniq()}`, variant_price_vnd: '100000' } });
  await owner.query(`INSERT INTO shop_payment_config (shop_id, bank_bin, account_number, account_name, qr_enabled) VALUES ($1,'970436','0123456789','SHOP TEST',true) ON CONFLICT (shop_id) DO UPDATE SET qr_enabled=true, bank_bin=EXCLUDED.bank_bin, account_number=EXCLUDED.account_number`, [A.shopId]);
  r = await adm('GET', OV, { cookie: A.cookie });
  const prog = r.body.match(/(\d)\/4 xong/)?.[1];
  Number(prog) >= 2 && /Đã xong/.test(r.body) ? ok(`gắn bank + thêm SP → ${prog}/4 xong, mục ✓`) : bad('tín hiệu không phản ánh', `prog=${prog}`);

  sect('3. Mở bán: onboarding → active + redirect live=1');
  r = await adm('POST', `/shops/${A.shopId}/activate`, { cookie: A.cookie, origin: OADM });
  const st = await statusOf(A.shopId);
  r.status === 303 && /live=1/.test(r.location ?? '') && st === 'active' ? ok('mở bán → status=active, redirect live=1') : bad('mở bán lỗi', `${r.status} ${r.location} st=${st}`);

  sect('4. Shop active: checklist ẩn + banner chúc mừng');
  r = await adm('GET', `${OV}?live=1`, { cookie: A.cookie });
  // Mở bán xong thì checklist biến mất — nếu không có gì thay thế, người bán mất luôn
  // đường dẫn tới các tính năng chưa dùng. Đây chính là chỗ khối gợi ý lấp vào.
  const suggHrefs = [...r.body.matchAll(/class="sugg-card" href="([^"]+)"/g)].map((m) => m[1]);
  /class="sugg-row"/.test(r.body) && suggHrefs.length === 5 && suggHrefs.every((h) => h.startsWith(`/shops/${A.shopId}/`))
    ? ok(`shop active: khối gợi ý XUẤT HIỆN, ${suggHrefs.length} thẻ trỏ đúng shop`)
    : bad('shop active không thấy khối gợi ý', `hrefs=${suggHrefs.length}`);
  // BẤM THẬT từng thẻ. "Route có tồn tại" chưa đủ: thẻ dẫn tới 404/403 còn tệ hơn không có
  // thẻ — nó dạy người bán rằng khối gợi ý là đồ trang trí. Đây cũng là thứ duy nhất bắt
  // được khi ai đó đổi tên đường dẫn mà quên sửa danh sách SUGG.
  const dead = [];
  for (const h of suggHrefs) {
    const hit = await adm('GET', h, { cookie: A.cookie });
    if (hit.status !== 200) dead.push(`${h}→${hit.status}`);
  }
  dead.length === 0 ? ok('cả 5 thẻ gợi ý mở được (200), không thẻ nào dẫn tới ngõ cụt')
    : bad('thẻ gợi ý dẫn tới ngõ cụt', dead.join(' '));
  r.status === 200 && !/Hoàn tất thiết lập cửa hàng/.test(r.body) && /mở bán chính thức/i.test(r.body) && !r.body.includes('<script')
    ? ok('active: checklist ẩn + banner chúc mừng') : bad('sau mở bán sai', r.body.slice(0, 160));

  sect('5. Idempotent: mở bán lại shop đã active → vẫn active');
  r = await adm('POST', `/shops/${A.shopId}/activate`, { cookie: A.cookie, origin: OADM });
  (await statusOf(A.shopId)) === 'active' ? ok('mở bán lại → vẫn active (không đổi)') : bad('idempotent sai');

  sect('6. Cô lập chéo shop: A mở bán shop B → chặn, B vẫn onboarding');
  r = await adm('POST', `/shops/${Bo.shopId}/activate`, { cookie: A.cookie, origin: OADM });
  const stB = await statusOf(Bo.shopId);
  r.status === 403 && stB === 'onboarding' ? ok('A mở bán B → 403, B vẫn onboarding') : bad('cô lập chéo shop hỏng', `${r.status} stB=${stB}`);

  sect('7. CSRF: POST activate KHÔNG Origin → 403, không đổi');
  r = await adm('POST', `/shops/${Bo.shopId}/activate`, { cookie: Bo.cookie });
  const stB2 = await statusOf(Bo.shopId);
  r.status === 403 && stB2 === 'onboarding' ? ok('activate không Origin → 403, B vẫn onboarding') : bad('CSRF activate không chặn', `${r.status} stB=${stB2}`);

  sect('8. Shop bị khoá: KHÔNG quảng bá tính năng "đã nằm trong gói"');
  // Cổng của khối gợi ý là shopStatus === 'active', KHÔNG phải "vắng checklist". Nếu ai đó
  // sau này rút gọn về !setup thì shop suspended/terminated rơi vào nhánh HIỆN — tức mời
  // người đang bị cắt dịch vụ dùng thêm tính năng họ "đã trả tiền". Test này khoá điều đó.
  await owner.query(`UPDATE shops SET status='suspended' WHERE id=$1`, [A.shopId]);
  r = await adm('GET', OV, { cookie: A.cookie });
  const hidSusp = r.status === 200 && !/class="sugg-row"/.test(r.body);
  await owner.query(`UPDATE shops SET status='active' WHERE id=$1`, [A.shopId]);
  r = await adm('GET', OV, { cookie: A.cookie });
  hidSusp && /class="sugg-row"/.test(r.body)
    ? ok('suspended → ẩn khối gợi ý; trả lại active → hiện lại')
    : bad('khối gợi ý không theo trạng thái shop', `hidSusp=${hidSusp}`);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
