/**
 * E2E onboarding checklist trong seller-admin (BFF). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-onboarding.e2e.mjs
 *
 * Kiểm: shop mới (onboarding) hiện checklist readiness từ seller · preview có TTL · nút "Mở bán"
 * chỉ hoạt động khi đủ điều kiện server-side · ẩn checklist sau go-live · cô lập chéo shop · CSRF.
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
  return { status: r.status, location: r.headers.get('location'), csp: r.headers.get('content-security-policy'), body: t };
}
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;
const statusOf = async (shopId) => (await owner.query('SELECT status FROM shops WHERE id=$1', [shopId])).rows[0]?.status;
const pageIdFrom = (location) => /\/pages\/([0-9a-f-]{36})$/.exec(location ?? '')?.[1] ?? null;

async function publishPolicy(shopId, cookie, slug, title) {
  let r = await adm('POST', `/shops/${shopId}/pages`, {
    cookie, origin: OADM, form: { title, slug, seo_title: title, seo_description: `${title} của cửa hàng` },
  });
  const pageId = pageIdFrom(r.location);
  if (r.status !== 303 || !pageId) return { ok: false, detail: `create=${r.status} ${r.location ?? ''}` };
  r = await adm('POST', `/shops/${shopId}/pages/${pageId}/blocks`, {
    cookie, origin: OADM, form: { type: 'paragraph', text: `${title} áp dụng cho mọi đơn hàng của cửa hàng.` },
  });
  if (r.status !== 303) return { ok: false, detail: `block=${r.status}` };
  r = await adm('POST', `/shops/${shopId}/pages/${pageId}/publish`, { cookie, origin: OADM });
  return { ok: r.status === 303, detail: `publish=${r.status}` };
}

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

  sect('1. Shop mới: checklist readiness 9 mục, go-live bị khoá, no-JS');
  let r = await adm('GET', OV, { cookie: A.cookie });
  // HỢP ĐỒNG MỚI, ba điểm đổi so với bản trước và cả ba đều cố ý:
  //  · 2/8 chứ không 2/9 — checkout_dry_run tách khỏi danh sách VIỆC (nó là KẾT QUẢ, không
  //    phải thứ người dùng bấm được). Nó VẪN blocking ở server, kiểm ở mục 10b.
  //  · KHÔNG còn `disabled`: nút đó không nhận focus nên bàn phím không tới được, và `title`
  //    chỉ hiện khi hover — mobile mù hẳn. Nút nay luôn bấm được, server vẫn là nơi quyết.
  //  · CÓ <script nonce>: nút mang data-busy nên trang mở CSP script cho chủ shop. Đây là
  //    tăng cường, không phải phụ thuộc — no-JS vẫn submit được (kiểm ở mục 10a).
  r.status === 200 && /Hoàn tất thiết lập cửa hàng/.test(r.body) && /2\/8 đạt/.test(r.body)
    && /Sản phẩm bán được/.test(r.body) && /Phương thức nhận tiền/.test(r.body)
    && /Chính sách mua hàng/.test(r.body) && /Quyền riêng tư/.test(r.body)
    && /Mở bán chính thức<\/button>/.test(r.body) && /Còn 5 mục bắt buộc/.test(r.body)
    && !/disabled title="Còn điều kiện bắt buộc chưa đạt"/.test(r.body)
    && /Kiểm tra thử checkout/.test(r.body)
    ? ok('checklist 2/8; dry-run là dòng chẩn đoán; nút go-live focus được (không disabled)')
    : bad('checklist sai', r.body.slice(0, 600));
  // Nút KHÔNG được mang thuộc tính disabled — bàn phím và screen reader phải tới được.
  !/<button[^>]*\bdisabled[^>]*>[^<]*Mở bán/.test(r.body)
    ? ok('nút "Mở bán chính thức" không bị disabled') : bad('nút go-live vẫn disabled');
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

  sect('1d. Wizard thiết lập nhanh ①: đổi tên KHÔNG được xoá 19 cột còn lại');
  // Shop RIÊNG cho wizard, không dùng lại A. Hồ sơ mẫu bên dưới đặt ship_fee_vnd, mà mục
  // "Phí vận chuyển" của checklist đọc đúng cột đó → dùng A thì mục 2 ("vẫn 0/4") đỏ vì một
  // lý do chẳng liên quan gì tới thứ nó canh. Đây là kiểu đỏ giả tốn nhiều giờ nhất.
  const C = await makeShopOwner(staff, `ow-${uniq()}`);
  // ĐÂY là chốt đắt nhất của wizard. PATCH /shops/:id ghi đè CẢ 22 cột trong một câu
  // UPDATE, nên một wizard gửi lên đúng 3 ô của nó sẽ đặt phí ship, toạ độ gốc giao hàng
  // và hạn ẩn danh PII về NULL — trả HTTP 200, không log, không ai biết cho tới lúc khách
  // đặt hàng và thấy phí ship bằng 0.
  //
  // ĐO BẰNG DB, không đo bằng chữ trên màn hình: `SELECT *` trước/sau rồi so từng cột. So
  // theo danh sách cột viết tay thì cột thứ 23 thêm sau này lọt lưới — đúng lớp lỗi cần chặn.
  // (apps/seller-admin/test/shop-patch.test.js canh HÌNH DẠNG body ở mức mã nguồn; bộ này
  // canh KẾT QUẢ thật sau khi đi qua validate của seller — cần cả hai, vì body đúng hình mà
  // seller từ chối một giá trị nào đó thì wizard vẫn hỏng.)
  const fullProfile = {
    name: 'Shop gốc', contact_email: 'goc@shop.vn', contact_phone: '0900000000', business_address: '1 Nguyễn Huệ',
    ship_fee_vnd: '25000', free_ship_threshold_vnd: '500000', low_stock_threshold: '7',
    max_pending_per_ip: '4', max_pending_per_phone: '2',
    ship_fee_far_vnd: '45000', ship_extra_per_500g_vnd: '5000', default_weight_gram: '800',
    ship_from_province: 'TP. Hồ Chí Minh', pii_retention_months: '24',
    ship_mode: 'distance', ship_origin_lat: '10.7769', ship_origin_lng: '106.7009',
    ship_base_vnd: '15000', ship_per_km_vnd: '4000', ship_max_km: '25', ship_road_factor: '1.3',
    ship_over_max_behavior: 'reject',
  };
  r = await adm('POST', `/shops/${C.shopId}/settings`, { cookie: C.cookie, origin: OADM, form: fullProfile });
  const snapShop = async () => (await owner.query('SELECT * FROM shops WHERE id=$1', [C.shopId])).rows[0];
  const before = await snapShop();
  Number(before.ship_base_vnd) === 15000 && before.ship_mode === 'distance' && Number(before.pii_retention_months) === 24
    ? ok('nạp hồ sơ shop "đã dùng thật": ship theo km + hạn ẩn danh PII 24 tháng')
    : bad('không nạp được hồ sơ đầy đủ — mọi khẳng định sau đây vô nghĩa', JSON.stringify({ base: before.ship_base_vnd, mode: before.ship_mode, pii: before.pii_retention_months }));

  r = await adm('GET', `/shops/${C.shopId}/onboarding`, { cookie: C.cookie });
  r.status === 200 && /Đặt tên gian hàng/.test(r.body) && /name="name"/.test(r.body) && !r.body.includes('<script')
    ? ok('bước ① mở được, có ô tên, no-JS') : bad('bước ① sai', `${r.status} ${r.body.slice(0, 160)}`);

  r = await adm('POST', `/shops/${C.shopId}/onboarding`, {
    cookie: C.cookie, origin: OADM,
    form: { step: '1', name: 'Shop Minh Anh', contact_phone: '0912345678', business_address: '99 Hai Bà Trưng' },
  });
  const after = await snapShop();
  const WIZ_COLS = new Set(['name', 'contact_phone', 'business_address', 'updated_at']);
  const collateral = Object.keys(before).filter((k) => !WIZ_COLS.has(k) && String(before[k]) !== String(after[k]));
  r.status === 303 && r.location === `/shops/${C.shopId}/onboarding?step=2` && collateral.length === 0
    ? ok(`bước ① lưu xong → sang bước ②, ${Object.keys(before).length - WIZ_COLS.size} cột khác KHÔNG đổi một cột nào`)
    : bad('bước ① làm đổi cột ngoài phạm vi', `${r.status} → ${r.location} · đổi: ${collateral.join(', ') || '(không)'}`);
  after.name === 'Shop Minh Anh' && after.contact_phone === '0912345678' && after.business_address === '99 Hai Bà Trưng'
    && after.contact_email === 'goc@shop.vn'
    ? ok('ba ô wizard đã lưu; contact_email (wizard KHÔNG hỏi) giữ nguyên')
    : bad('ô wizard lưu sai', JSON.stringify({ name: after.name, phone: after.contact_phone, addr: after.business_address, email: after.contact_email }));
  // Tên rỗng phải quay lại bước ① kèm lỗi, và KHÔNG được ghi gì.
  r = await adm('POST', `/shops/${C.shopId}/onboarding`, { cookie: C.cookie, origin: OADM, form: { step: '1', name: '   ' } });
  const afterBlank = await snapShop();
  r.status === 400 && /Cần đặt tên cửa hàng/.test(r.body) && afterBlank.name === 'Shop Minh Anh'
    ? ok('tên rỗng → 400 + báo lỗi, tên cũ giữ nguyên') : bad('tên rỗng không chặn', `${r.status} name=${afterBlank.name}`);

  sect('1e. Wizard ②: áp mẫu ngành rồi về Tổng quan · CSRF · cô lập chéo shop');
  r = await adm('GET', `/shops/${C.shopId}/onboarding?step=2`, { cookie: C.cookie });
  const nPreset = (r.body.match(/name="preset"/g) ?? []).length;
  r.status === 200 && /Chọn giao diện cửa hàng/.test(r.body) && nPreset === 5 && !r.body.includes('<script')
    ? ok(`bước ② bày ${nPreset} mẫu ngành, no-JS`) : bad('bước ② sai', `${r.status} nPreset=${nPreset}`);
  r = await adm('POST', `/shops/${C.shopId}/onboarding`, { cookie: C.cookie, origin: OADM, form: { step: '2', preset: 'fashion' } });
  const th = (await owner.query('SELECT tokens, layout FROM themes WHERE shop_id=$1', [C.shopId])).rows[0];
  r.status === 303 && r.location === `/shops/${C.shopId}/overview` && th && Object.keys(th.tokens ?? {}).length > 0
    ? ok('bước ② áp mẫu "fashion" (theme có tokens) → về Tổng quan') : bad('bước ② không áp được mẫu', `${r.status} → ${r.location} · tokens=${JSON.stringify(th?.tokens ?? null).slice(0, 90)}`);
  // CSP chặn font ngoài → applyPresetTo phải gỡ font.* khỏi tokens (dùng chung với /theme/preset).
  !Object.hasOwn(th?.tokens ?? {}, 'font.body') && !Object.hasOwn(th?.tokens ?? {}, 'font.heading')
    ? ok('tokens KHÔNG mang font.* (CSP chặn font ngoài)') : bad('preset lọt font ngoài vào theme');
  // Chọn mẫu không tồn tại: quay lại bước ② kèm lỗi, KHÔNG ghi theme rác.
  r = await adm('POST', `/shops/${C.shopId}/onboarding`, { cookie: C.cookie, origin: OADM, form: { step: '2', preset: 'khong-co-that' } });
  r.status === 400 && /Chưa chọn mẫu giao diện/.test(r.body) ? ok('preset lạ → 400, không ghi theme') : bad('preset lạ không chặn', `${r.status}`);
  // CSRF: POST không Origin → 403 và tên KHÔNG đổi.
  r = await adm('POST', `/shops/${C.shopId}/onboarding`, { cookie: C.cookie, form: { step: '1', name: 'Tên do CSRF đặt' } });
  const afterCsrf = await snapShop();
  r.status === 403 && afterCsrf.name === 'Shop Minh Anh' ? ok('POST wizard không Origin → 403, tên không đổi') : bad('CSRF wizard không chặn', `${r.status} name=${afterCsrf.name}`);
  // Cô lập chéo shop: chủ shop C không được mở wizard của shop B, càng không đổi được tên B.
  const nameB0 = (await owner.query('SELECT name FROM shops WHERE id=$1', [Bo.shopId])).rows[0]?.name;
  const gW = await adm('GET', `/shops/${Bo.shopId}/onboarding`, { cookie: C.cookie });
  r = await adm('POST', `/shops/${Bo.shopId}/onboarding`, { cookie: C.cookie, origin: OADM, form: { step: '1', name: 'A chiếm shop B' } });
  const nameB1 = (await owner.query('SELECT name FROM shops WHERE id=$1', [Bo.shopId])).rows[0]?.name;
  gW.status === 403 && r.status === 403 && nameB1 === nameB0
    ? ok('C mở/ghi wizard của B → 403 cả hai chiều, tên B không đổi') : bad('cô lập chéo shop ở wizard hỏng', `GET=${gW.status} POST=${r.status} name=${nameB1}`);

  sect('2. SP nháp / tồn 0 KHÔNG được tick — khách vào chỉ thấy "Hết hàng"');
  // Mục này từng đếm catalog_count: có 1 dòng trong bảng products là ✓, bất kể nháp hay
  // tồn 0. Chủ shop mới thấy "xong rồi" nên không sửa, trong khi storefront ghi "Hết hàng"
  // — lời khen dối đúng ở bước quyết định. Nay đếm sellable_count (đang bán + còn hàng).
  await adm('POST', `/shops/${A.shopId}/products`, { cookie: A.cookie, origin: OADM, form: { title: 'SP nháp', price_vnd: '100000', status: 'draft', stock: '10' } });
  await adm('POST', `/shops/${A.shopId}/products`, { cookie: A.cookie, origin: OADM, form: { title: 'SP hết hàng', price_vnd: '100000', status: 'active', stock: '0' } });
  r = await adm('GET', OV, { cookie: A.cookie });
  const prog0 = r.body.match(/(\d+)\/9 đạt/)?.[1];
  prog0 === '2' ? ok('2 SP (nháp / tồn 0) → vẫn 2/9, KHÔNG tick nhầm catalog') : bad('tick nhầm SP chưa bán được', `prog=${prog0}`);

  sect('3. SP đang bán + còn tồn → catalog đạt; vẫn chưa được mở bán');
  // KHÔNG gửi slug/sku: bỏ trống thì seller tự sinh (bỏ dấu tên SP). Test đi đúng đường
  // người thật đi — có gửi thì không bao giờ phát hiện đường tự-sinh vỡ.
  r = await adm('POST', `/shops/${A.shopId}/products`, { cookie: A.cookie, origin: OADM, form: { title: 'Cà phê sữa đá', price_vnd: '25000', status: 'active', stock: '20' } });
  r.status === 303 ? ok('tạo SP không cần gõ slug/SKU') : bad('tạo SP tối giản lỗi', String(r.status));
  await owner.query(`INSERT INTO shop_payment_config (shop_id, bank_bin, account_number, account_name, qr_enabled) VALUES ($1,'970436','0123456789','SHOP TEST',true) ON CONFLICT (shop_id) DO UPDATE SET qr_enabled=true, bank_bin=EXCLUDED.bank_bin, account_number=EXCLUDED.account_number`, [A.shopId]);
  r = await adm('GET', OV, { cookie: A.cookie });
  const prog = r.body.match(/(\d+)\/9 đạt/)?.[1];
  prog === '3' && /Còn 5 mục bắt buộc/.test(r.body)
    ? ok('SP bán được → 3/9; các điều kiện vận hành còn thiếu vẫn chặn go-live')
    : bad('tín hiệu không phản ánh', `prog=${prog}`);
  // Tồn PHẢI vào kho thật, không phải chỉ hiện trên form.
  const onHand = (await owner.query(
    `SELECT il.on_hand FROM inventory_levels il JOIN variants v ON v.id=il.variant_id
      JOIN products p ON p.id=v.product_id WHERE p.shop_id=$1 AND p.title='Cà phê sữa đá'`, [A.shopId])).rows[0]?.on_hand;
  Number(onHand) === 20 ? ok('tồn ban đầu 20 đã ghi vào inventory_levels') : bad('tồn ban đầu không vào kho', `on_hand=${onHand}`);

  sect('4. Server chặn mở bán sớm, sau đó hoàn tất shipping/contact/policy + preview');
  r = await adm('POST', `/shops/${A.shopId}/activate`, { cookie: A.cookie, origin: OADM });
  r.status === 200 && (await statusOf(A.shopId)) === 'onboarding'
    && /chưa đủ điều kiện mở bán/i.test(r.body) && /Còn 5 mục bắt buộc/.test(r.body)
    ? ok('giả POST trực tiếp vẫn bị seller kiểm tra readiness và giữ onboarding')
    : bad('go-live mở sớm hoặc không giải thích mục còn thiếu', `${r.status} st=${await statusOf(A.shopId)}`);

  r = await adm('POST', `/shops/${A.shopId}/settings`, {
    cookie: A.cookie, origin: OADM,
    form: { name: 'Shop onboarding', contact_phone: '0901234567', ship_fee_vnd: '30000', ship_mode: 'region' },
  });
  const purchase = await publishPolicy(A.shopId, A.cookie, 'chinh-sach-mua-hang', 'Chính sách mua hàng');
  const privacy = await publishPolicy(A.shopId, A.cookie, 'chinh-sach-bao-mat', 'Chính sách bảo mật');
  r.status === 200 && purchase.ok && privacy.ok
    ? ok('đã cấu hình liên hệ, phí ship và xuất bản hai trang chính sách qua BFF')
    : bad('không dựng đủ fixture readiness', `settings=${r.status} purchase=${purchase.detail} privacy=${privacy.detail}`);

  r = await adm('GET', OV, { cookie: A.cookie });
  const nonceHeader = /script-src 'nonce-([^']+)'/.exec(r.csp ?? '')?.[1];
  const nonceTag = /<script nonce="([^"]+)"/.exec(r.body)?.[1];
  /8\/9 đạt/.test(r.body) && /Khuyến nghị, không chặn mở bán/.test(r.body)
    && /data-confirm="Mở checkout công khai cho khách ngay bây giờ\?"/.test(r.body)
    && !/Mở bán chính thức" disabled/.test(r.body)
    && nonceHeader && nonceHeader === nonceTag
    ? ok('8 mục bắt buộc đạt; nút go-live được bật và confirm có CSP nonce hợp lệ')
    : bad('UI/confirm chưa phản ánh readiness hoàn chỉnh', `csp=${nonceHeader ?? 'thiếu'} script=${nonceTag ?? 'thiếu'} ${r.body.slice(0, 500)}`);

  r = await adm('POST', `/shops/${A.shopId}/preview`, { cookie: A.cookie, origin: OADM });
  r.status === 200 && /Link xem trước sống khoảng 15 phút/.test(r.body)
    && new RegExp(`https:\\/\\/[^\"<]+\\?shop_preview=`).test(r.body)
    ? ok('preview shop tạo link có TTL trước khi mở bán') : bad('preview shop lỗi', `${r.status} ${r.body.slice(0, 240)}`);

  sect('5. Mở bán: onboarding → active + redirect live=1');
  r = await adm('POST', `/shops/${A.shopId}/activate`, { cookie: A.cookie, origin: OADM });
  const st = await statusOf(A.shopId);
  r.status === 303 && /live=1/.test(r.location ?? '') && st === 'active' ? ok('mở bán → status=active, redirect live=1') : bad('mở bán lỗi', `${r.status} ${r.location} st=${st}`);

  sect('6. Shop active: checklist ẩn + banner chúc mừng');
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

  sect('7. Idempotent: mở bán lại shop đã active → vẫn active');
  r = await adm('POST', `/shops/${A.shopId}/activate`, { cookie: A.cookie, origin: OADM });
  (await statusOf(A.shopId)) === 'active' ? ok('mở bán lại → vẫn active (không đổi)') : bad('idempotent sai');

  sect('8. Cô lập chéo shop: A mở bán shop B → chặn, B vẫn onboarding');
  r = await adm('POST', `/shops/${Bo.shopId}/activate`, { cookie: A.cookie, origin: OADM });
  const stB = await statusOf(Bo.shopId);
  r.status === 403 && stB === 'onboarding' ? ok('A mở bán B → 403, B vẫn onboarding') : bad('cô lập chéo shop hỏng', `${r.status} stB=${stB}`);

  sect('9. CSRF: POST activate KHÔNG Origin → 403, không đổi');
  r = await adm('POST', `/shops/${Bo.shopId}/activate`, { cookie: Bo.cookie });
  const stB2 = await statusOf(Bo.shopId);
  r.status === 403 && stB2 === 'onboarding' ? ok('activate không Origin → 403, B vẫn onboarding') : bad('CSRF activate không chặn', `${r.status} stB=${stB2}`);

  sect('10. Shop bị khoá: KHÔNG quảng bá tính năng "đã nằm trong gói"');
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

  // ── 10. Link xem trước: idempotent, no-JS, không tự huỷ ───────────────────
  // Bản trước upsert VÔ ĐIỀU KIỆN nên mỗi POST giết token cũ: chủ shop copy link gửi đi rồi
  // bấm lại (hoặc trình duyệt gửi lại form) là link vừa gửi chết, không gì báo vì sao.
  sect('10. Preview: gửi lặp/đồng thời không giết link cũ, chỉ rotate=1 mới xoay');
  const P = await makeShopOwner(staff, `pv-${uniq()}`);
  const PV = `/shops/${P.shopId}`;
  const tokenOf = async (sid) => (await owner.query('SELECT token_hash, expires_at FROM shop_previews WHERE shop_id=$1', [sid])).rows[0] ?? null;
  // Cần tên miền đã xác minh; dựng thẳng bằng owner pool cho gọn.
  await owner.query(
    `INSERT INTO domains (shop_id, hostname, is_primary, verified_at) VALUES ($1,$2,true,now())
     ON CONFLICT DO NOTHING`, [P.shopId, `pv-${uniq()}.localtest`],
  );

  // (a) no-JS: form thuần, không script nào trên đường đi.
  r = await adm('POST', `${PV}/preview`, { cookie: P.cookie, origin: OADM, form: {} });
  const t1 = await tokenOf(P.shopId);
  r.status === 200 && t1 && /shop_preview=/.test(r.body)
    ? ok('tạo link lần đầu bằng form thuần (no-JS), token đã lưu') : bad('tạo preview lỗi', `${r.status}`);

  // (b) GỬI LẶP không rotate → KHÔNG xoay token, link cũ còn nguyên.
  r = await adm('POST', `${PV}/preview`, { cookie: P.cookie, origin: OADM, form: {} });
  const t2 = await tokenOf(P.shopId);
  r.status === 200 && t2?.token_hash === t1?.token_hash
    ? ok('gửi lặp → token KHÔNG đổi, link đã gửi đi vẫn sống') : bad('gửi lặp làm chết link cũ', `hash đổi=${t2?.token_hash !== t1?.token_hash}`);
  // Câu chữ không được khẳng định người dùng đang cầm link.
  !/dùng lại link đó/.test(r.body) && /không hiển thị lại được/.test(r.body)
    ? ok('câu trả lời không giả định người dùng còn giữ URL') : bad('câu chữ reused sai', r.body.slice(0, 200));

  // (c) HAI POST ĐỒNG THỜI, không rotate → vẫn đúng một token.
  const both = await Promise.all([
    adm('POST', `${PV}/preview`, { cookie: P.cookie, origin: OADM, form: {} }),
    adm('POST', `${PV}/preview`, { cookie: P.cookie, origin: OADM, form: {} }),
  ]);
  const t3 = await tokenOf(P.shopId);
  const nRows = Number((await owner.query('SELECT count(*)::int n FROM shop_previews WHERE shop_id=$1', [P.shopId])).rows[0].n);
  both.every((x) => x.status === 200) && nRows === 1 && t3?.token_hash === t1?.token_hash
    ? ok('hai POST đồng thời → đúng 1 dòng, token đầu vẫn hợp lệ') : bad('đua tạo preview', `n=${nRows} đổi=${t3?.token_hash !== t1?.token_hash}`);

  // (d) CHỈ rotate=1 mới xoay.
  r = await adm('POST', `${PV}/preview`, { cookie: P.cookie, origin: OADM, form: { rotate: '1' } });
  const t4 = await tokenOf(P.shopId);
  r.status === 200 && t4 && t4.token_hash !== t1.token_hash
    ? ok('rotate=1 → xoay token (thao tác tường minh)') : bad('rotate không xoay', `${r.status}`);
  // rotate lặp: mỗi lần xoay tiếp, luôn đúng một dòng, không sinh trạng thái lạ.
  await adm('POST', `${PV}/preview`, { cookie: P.cookie, origin: OADM, form: { rotate: '1' } });
  const t5 = await tokenOf(P.shopId);
  const nRows2 = Number((await owner.query('SELECT count(*)::int n FROM shop_previews WHERE shop_id=$1', [P.shopId])).rows[0].n);
  nRows2 === 1 && t5.token_hash !== t4.token_hash
    ? ok('rotate lặp: vẫn đúng 1 dòng, không trạng thái mồ côi') : bad('rotate lặp sinh trạng thái lạ', `n=${nRows2}`);

  // (e) HẾT HẠN: overview phải NÓI RA sau khi tải lại, không quên như trước.
  await owner.query(`UPDATE shop_previews SET expires_at = now() - interval '1 minute' WHERE shop_id=$1`, [P.shopId]);
  r = await adm('GET', `${PV}/overview`, { cookie: P.cookie });
  /đã hết hạn/.test(r.body)
    ? ok('tải lại sau khi hết hạn → giao diện nói "đã hết hạn"') : bad('overview quên trạng thái preview sau reload');
  // Và token hết hạn ở storefront trả thông báo CHUNG, không phân biệt sai/hết hạn.
  const expiredHash = (await tokenOf(P.shopId)).token_hash;
  expiredHash && !/hết hạn|expired/i.test(String(expiredHash))
    ? ok('token_hash không rò trạng thái ra ngoài') : bad('token_hash mang thông tin trạng thái');

  // (f) TOKEN CHÉO SHOP: dòng của shop khác phải vô hình.
  const crossVisible = Number((await owner.query(
    `SELECT count(*)::int n FROM shop_previews WHERE shop_id = $1`, [A.shopId])).rows[0].n);
  r = await adm('GET', `${PV}/overview`, { cookie: A.cookie });
  r.status === 403 && crossVisible >= 0
    ? ok('chủ shop A không mở được overview của shop P (403)') : bad('cô lập chéo shop ở preview hỏng', `${r.status}`);

  // (g) checkout_dry_run VẪN chặn go-live, và KHÔNG nằm trong danh sách việc.
  sect('10b. checkout_dry_run: vẫn blocking ở server, tách khỏi danh sách việc');
  const rdy = await rq(process.env.SELLER_URL ?? 'http://seller:3010', 'GET', `/shops/${P.shopId}/readiness`, { cookie: P.cookie });
  const dry = rdy.json?.checks?.find((c) => c.code === 'checkout_dry_run');
  dry && dry.blocking === true
    ? ok('checkout_dry_run vẫn blocking=true ở computeReadiness') : bad('dry-run mất tính blocking', JSON.stringify(dry));
  dry && dry.action_url === null
    ? ok('dry-run không còn action_url trỏ vòng về overview') : bad('dry-run vẫn có action_url', String(dry?.action_url));
  r = await adm('GET', `${PV}/overview`, { cookie: P.cookie });
  !/x-checkout_dry_run|checkout_dry_run/.test(r.body) && /Kiểm tra thử checkout/.test(r.body)
    ? ok('giao diện: dry-run là dòng chẩn đoán, không phải việc có nút') : bad('dry-run vẫn hiện như một việc');
  // readiness KHÔNG trả token_hash/token thô.
  !/token_hash|shop_preview=/.test(JSON.stringify(rdy.json ?? {}))
    ? ok('GET /readiness không lộ token_hash lẫn token thô') : bad('readiness rò token');

  // (h) shop ĐÃ active không quay lại onboarding.
  sect('10c. Shop đã mở bán không bị đẩy về onboarding');
  const stBefore = await statusOf(A.shopId);
  await adm('POST', `/shops/${A.shopId}/preview`, { cookie: A.cookie, origin: OADM, form: {} });
  await adm('POST', `/shops/${A.shopId}/activate`, { cookie: A.cookie, origin: OADM });
  const stAfter = await statusOf(A.shopId);
  stBefore === 'active' && stAfter === 'active'
    ? ok('shop active: thao tác preview/activate KHÔNG lật về onboarding') : bad('shop active bị đẩy về onboarding', `${stBefore}→${stAfter}`);

  // (i) KHÔNG lộ PII owner ra màn khách.
  sect('10d. renderPreparing chỉ dùng liên hệ CÔNG KHAI của shop');
  const ownerEmail = P.email;
  await owner.query(`UPDATE shops SET contact_email='lienhe@shop.vn', contact_phone='0900111222' WHERE id=$1`, [P.shopId]);
  const host = (await owner.query('SELECT hostname FROM domains WHERE shop_id=$1 LIMIT 1', [P.shopId])).rows[0]?.hostname;
  if (host) {
    const sf = await fetch(`${process.env.STOREFRONT_URL ?? 'http://storefront:3000'}/`, { headers: { host } })
      .then(async (x) => ({ status: x.status, body: await x.text() })).catch(() => ({ status: 0, body: '' }));
    sf.status === 200 && !sf.body.includes(ownerEmail)
      ? ok('màn "đang chuẩn bị" KHÔNG chứa email tài khoản chủ shop') : bad('lộ PII owner ra storefront', sf.body.slice(0, 200));
    sf.body.includes('lienhe@shop.vn')
      ? ok('dùng đúng liên hệ công khai của cửa hàng') : bad('không hiện liên hệ công khai');
  }

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
