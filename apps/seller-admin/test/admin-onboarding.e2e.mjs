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
    && /Gắn ngân hàng nhận tiền/.test(r.body) && /Có sản phẩm bán được/.test(r.body) && /Mở bán chính thức/.test(r.body) && !r.body.includes('<script')
    ? ok('checklist 0/4 + 4 mục + nút Mở bán, no-JS') : bad('checklist sai', r.body.slice(0, 200));
  // docs/44 §4.11: khối gợi ý KHÔNG được đứng cạnh checklist thiết lập. Hai khối cùng bảo
  // người bán "hãy làm cái này" ở một màn hình là nhiễu, và checklist mới là thứ có thứ tự
  // ưu tiên đúng cho shop chưa mở bán.
  // Bám class="sugg-row" chứ KHÔNG bám chữ hiển thị: chữ hiển thị còn nằm trong <style>
  // (tên lớp, chú thích) nên tìm theo chữ sẽ khớp cả khi khối vắng mặt.
  !/class="sugg-row"/.test(r.body)
    ? ok('shop onboarding: KHÔNG hiện khối gợi ý (checklist đang giữ vai trò dẫn dắt)')
    : bad('khối gợi ý đứng cạnh checklist');

  sect('1b. Sidebar danh mục 2 cấp kiểu sàn + câu mở đầu nói đúng tình trạng');
  // 28 mục phẳng: Đối soát COD, Kiểm kê, Điểm thưởng, Nhật ký… ngang hàng Đơn hàng, người
  // mới không biết bắt đầu từ đâu. Nay: danh mục lớn bấm sổ ra danh mục con.
  const grpTitles = [...r.body.matchAll(/<details class="nav-grp" name="admnav"[^>]*><summary class="nav-top[^"]*">.*?<span>([^<]+)<\/span>/g)].map((m) => m[1]);
  grpTitles.length >= 5 && grpTitles.includes('Đơn hàng') && grpTitles.includes('Sản phẩm')
    ? ok(`sidebar có ${grpTitles.length} danh mục lớn sổ được: ${grpTitles.join(' · ')}`) : bad('sidebar chưa phân danh mục 2 cấp', JSON.stringify(grpTitles));
  // ĐÓNG-CÁI-ĐANG-MỞ khi bấm cái khác: thuộc tính name= biến cả cụm thành accordion loại
  // trừ ngay trong trình duyệt. Thiếu name → mở được nhiều nhóm cùng lúc, đúng thứ vừa bỏ.
  const nNamed = (r.body.match(/<details class="nav-grp" name="admnav"/g) ?? []).length;
  nNamed === grpTitles.length && nNamed > 0
    ? ok(`cả ${nNamed} nhóm cùng name="admnav" → mở cái này TỰ ĐÓNG cái kia (không cần JS)`)
    : bad('nhóm thiếu name= → accordion không loại trừ', `${nNamed}/${grpTitles.length}`);
  // Mục đứng riêng (Tổng quan) KHÔNG được nhét vào nhóm — một trang mà bắt bấm hai lần.
  /<div class="nav-grp"><a href="[^"]*\/overview" class="nav-top/.test(r.body)
    ? ok('Tổng quan đứng riêng ở cấp cao nhất (không phải bấm 2 lần)') : bad('Tổng quan bị nhét vào nhóm');
  // Mọi link CŨ vẫn còn trong HTML — details chỉ ẩn bằng CSS, không được làm mất đường đi.
  const stillThere = ['/cod', '/stocktakes', '/loyalty', '/audit-log', '/billing', '/help']
    .filter((h) => r.body.includes(`href="/shops/${A.shopId}${h}"`));
  stillThere.length === 6 ? ok('phân danh mục KHÔNG làm mất link nào (6/6 mục ít dùng vẫn có)') : bad('phân danh mục nuốt mất link', JSON.stringify(stillThere));
  // Nhóm chứa trang ĐANG XEM phải bung: gập cả nhóm đang đứng thì mất dấu mình ở đâu.
  const rSet = await adm('GET', `/shops/${A.shopId}/settings`, { cookie: A.cookie });
  /<details class="nav-grp" name="admnav" open><summary class="nav-top has-on">.*?<span>Cài đặt<\/span>/.test(rSet.body)
    && /href="[^"]*\/settings" class="nav-sub on"/.test(rSet.body)
    ? ok('đang ở Cài đặt → danh mục "Cài đặt" tự bung, mục con được tô sáng') : bad('nhóm chứa trang hiện tại không bung');
  // "Không còn việc tồn đọng — cửa hàng đang chạy êm" là lời nói dối với shop chưa bán được:
  // 0 việc vì 0 khách, 0 khách vì chưa có gì để bán.
  !/cửa hàng đang chạy êm/.test(r.body) && /Khách chưa mua được gì/.test(r.body)
    ? ok('shop chưa bán được → nói thẳng, KHÔNG khen "đang chạy êm"') : bad('vẫn khen dối trên shop chưa bán được');

  sect('1c. Có ĐÚNG 1 cửa hàng → vào thẳng, không bắt chọn trong danh sách 1 phần tử');
  const home = await adm('GET', '/', { cookie: A.cookie });
  home.status === 303 && home.location === `/shops/${A.shopId}/overview`
    ? ok('chủ shop 1 cửa hàng: GET / → 303 thẳng vào overview') : bad('vẫn bắt qua màn hình chọn shop', `${home.status} ${home.location}`);
  // Nhân viên nền tảng KHÔNG được chuyển: link vào Console chỉ có ở màn hình này.
  const homeStaff = await adm('GET', '/', { cookie: staff });
  homeStaff.status === 200 && homeStaff.body.includes('href="/platform"')
    ? ok('nhân viên nền tảng vẫn thấy màn hình có link Console') : bad('chuyển hướng làm mất đường vào Console', `${homeStaff.status}`);

  sect('2. SP nháp / tồn 0 KHÔNG được tick — khách vào chỉ thấy "Hết hàng"');
  // Mục này từng đếm catalog_count: có 1 dòng trong bảng products là ✓, bất kể nháp hay
  // tồn 0. Chủ shop mới thấy "xong rồi" nên không sửa, trong khi storefront ghi "Hết hàng"
  // — lời khen dối đúng ở bước quyết định. Nay đếm sellable_count (đang bán + còn hàng).
  await adm('POST', `/shops/${A.shopId}/products`, { cookie: A.cookie, origin: OADM, form: { title: 'SP nháp', price_vnd: '100000', status: 'draft', stock: '10' } });
  await adm('POST', `/shops/${A.shopId}/products`, { cookie: A.cookie, origin: OADM, form: { title: 'SP hết hàng', price_vnd: '100000', status: 'active', stock: '0' } });
  r = await adm('GET', OV, { cookie: A.cookie });
  const prog0 = r.body.match(/(\d)\/4 xong/)?.[1];
  prog0 === '0' ? ok('2 SP (nháp / tồn 0) → vẫn 0/4, KHÔNG tick nhầm') : bad('tick nhầm SP chưa bán được', `prog=${prog0}`);

  sect('3. SP đang bán + còn tồn + gắn ngân hàng → mục ✓, tiến độ tăng');
  // KHÔNG gửi slug/sku: bỏ trống thì seller tự sinh (bỏ dấu tên SP). Test đi đúng đường
  // người thật đi — có gửi thì không bao giờ phát hiện đường tự-sinh vỡ.
  r = await adm('POST', `/shops/${A.shopId}/products`, { cookie: A.cookie, origin: OADM, form: { title: 'Cà phê sữa đá', price_vnd: '25000', status: 'active', stock: '20' } });
  r.status === 303 ? ok('tạo SP không cần gõ slug/SKU') : bad('tạo SP tối giản lỗi', String(r.status));
  await owner.query(`INSERT INTO shop_payment_config (shop_id, bank_bin, account_number, account_name, qr_enabled) VALUES ($1,'970436','0123456789','SHOP TEST',true) ON CONFLICT (shop_id) DO UPDATE SET qr_enabled=true, bank_bin=EXCLUDED.bank_bin, account_number=EXCLUDED.account_number`, [A.shopId]);
  r = await adm('GET', OV, { cookie: A.cookie });
  const prog = r.body.match(/(\d)\/4 xong/)?.[1];
  // Khi hỏng, in RA MỤC NÀO chưa ✓ — "prog=1" một mình không nói được sai ở bước nào.
  const doneLabels = [...r.body.matchAll(/>(✓|○)<\/span>[\s\S]{0,240}?font-size:\.95rem">([^<]+)</g)]
    .map((m) => `${m[1]} ${m[2].trim()}`);
  Number(prog) >= 2 && /Đã xong/.test(r.body)
    ? ok(`gắn bank + SP bán được → ${prog}/4 xong, mục ✓`)
    : bad('tín hiệu không phản ánh', `prog=${prog} · đã ✓: ${JSON.stringify(doneLabels)}`);
  // Tồn PHẢI vào kho thật, không phải chỉ hiện trên form.
  const onHand = (await owner.query(
    `SELECT il.on_hand FROM inventory_levels il JOIN variants v ON v.id=il.variant_id
      JOIN products p ON p.id=v.product_id WHERE p.shop_id=$1 AND p.title='Cà phê sữa đá'`, [A.shopId])).rows[0]?.on_hand;
  Number(onHand) === 20 ? ok('tồn ban đầu 20 đã ghi vào inventory_levels') : bad('tồn ban đầu không vào kho', `on_hand=${onHand}`);

  sect('4. Mở bán: onboarding → active + redirect live=1');
  r = await adm('POST', `/shops/${A.shopId}/activate`, { cookie: A.cookie, origin: OADM });
  const st = await statusOf(A.shopId);
  r.status === 303 && /live=1/.test(r.location ?? '') && st === 'active' ? ok('mở bán → status=active, redirect live=1') : bad('mở bán lỗi', `${r.status} ${r.location} st=${st}`);

  sect('5. Shop active: checklist ẩn + banner chúc mừng');
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

  sect('6. Idempotent: mở bán lại shop đã active → vẫn active');
  r = await adm('POST', `/shops/${A.shopId}/activate`, { cookie: A.cookie, origin: OADM });
  (await statusOf(A.shopId)) === 'active' ? ok('mở bán lại → vẫn active (không đổi)') : bad('idempotent sai');

  sect('7. Cô lập chéo shop: A mở bán shop B → chặn, B vẫn onboarding');
  r = await adm('POST', `/shops/${Bo.shopId}/activate`, { cookie: A.cookie, origin: OADM });
  const stB = await statusOf(Bo.shopId);
  r.status === 403 && stB === 'onboarding' ? ok('A mở bán B → 403, B vẫn onboarding') : bad('cô lập chéo shop hỏng', `${r.status} stB=${stB}`);

  sect('8. CSRF: POST activate KHÔNG Origin → 403, không đổi');
  r = await adm('POST', `/shops/${Bo.shopId}/activate`, { cookie: Bo.cookie });
  const stB2 = await statusOf(Bo.shopId);
  r.status === 403 && stB2 === 'onboarding' ? ok('activate không Origin → 403, B vẫn onboarding') : bad('CSRF activate không chặn', `${r.status} stB=${stB2}`);

  sect('9. Shop bị khoá: KHÔNG quảng bá tính năng "đã nằm trong gói"');
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
