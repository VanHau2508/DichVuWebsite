/**
 * E2E: GIÁ VỐN LÀ BÍ MẬT KINH DOANH. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-gia-von.e2e.mjs
 *
 * VÌ SAO CÓ BỘ NÀY. Đo được ngày 03/09: `catalog_manager` vừa ĐỌC (getProduct trả `cost_vnd`)
 * vừa GHI (PATCH variant → 200) được giá vốn, và trang chi tiết sản phẩm hiện thẳng ô nhập —
 * trong khi cùng vai đó mở `/reports/pnl` thì 404 vì giá vốn là "bí mật kinh doanh" theo đúng
 * chú thích của `reports.read` trong rbac.js. Một dữ liệu, hai mức bảo vệ.
 *
 * Chủ dự án chốt: giá vốn là bí mật, `catalog_manager` KHÔNG được thấy.
 *
 * Bộ này canh HẬU QUẢ, không canh chính tả. Ba điều dễ vá hụt, cả ba đều có ca riêng:
 *   · ẩn ô nhập mà GIỮ "biên ~X%" thì vẫn lộ: giá bán nằm cột bên, biên ⇒ vốn bằng một phép chia;
 *   · tệp mẫu CSV phát ra vẫn có cột `cost_vnd` ⇒ mời người ta gõ một cột sẽ bị vứt;
 *   · seller gỡ cột và ĐẾM số dòng, nhưng `mergeImportResults` dựng object theo danh sách khoá
 *     trắng nên con số rơi im lặng giữa seller và trang — đo được seller trả 2, trang hiện 0,
 *     không lỗi nào. Đúng ba mảnh của một chốt: cơ chế → DÂY NỐI → điểm phát ra.
 *
 * Bỏ qua cột chứ KHÔNG chặn cả tệp, và không im lặng: §3 cấm nuốt lặng một cột tiền.
 */
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

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
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${String(d).slice(0, 200)}${X}`); };
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
// form: object HOẶC mảng cặp [k,v] — mảng cặp BẮT BUỘC khi có key trùng (checkbox nhiều id):
// new URLSearchParams(object) chỉ giữ 1 giá trị → test xanh giả.
async function adm(method, path, { cookie, origin, form } = {}) {
  const h = {};
  if (form !== undefined) h['content-type'] = 'application/x-www-form-urlencoded';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(ADMIN + path, { method, headers: h, redirect: 'manual', body: form !== undefined ? new URLSearchParams(form).toString() : undefined });
  return { status: r.status, location: r.headers.get('location'), body: await r.text() };
}
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;

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
  const r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, slug, email, password, cookie: await login(email, password) };
}
// Mời thêm 1 thành viên vai bất kỳ (để kiểm perm).
async function addMember(staffCookie, shopId, role) {
  const email = `m-${uniq()}@shop.vn`, password = 'member passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { email, password, cookie: await login(email, password) };
}
async function mkProduct(shop, title, price, stock, status = 'active') {
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/products`, {
    body: { title, slug: `sp-${uniq()}`, price_vnd: price, status, variants: [{ sku: `S-${uniq()}`, price_vnd: price }] },
    cookie: shop.cookie, origin: OS,
  });
  const det = await rq(SELLER, 'GET', `/shops/${shop.shopId}/products/${r.json.id}`, { cookie: shop.cookie });
  const vid = det.json.variants[0].id;
  if (stock) {
    await rq(SELLER, 'POST', `/shops/${shop.shopId}/variants/${vid}/inventory/adjust`,
      { body: { delta: stock, reason: `nhập đầu kỳ ${title}` }, cookie: shop.cookie, origin: OS });
  }
  return { pid: r.json.id, vid };
}
async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `cst-${uniq()}`);
  const P = await mkProduct(A, `Ao thun ${uniq()}`, 200000, 10);
  await rq(SELLER, 'PATCH', `/shops/${A.shopId}/products/${P.pid}/variants/${P.vid}`,
    { body: { cost_vnd: 120000 }, cookie: A.cookie, origin: OS });
  const cm = await addMember(staff, A.shopId, 'catalog_manager');
  ok('dựng shop + SP giá 200k / vốn 120k (biên 40%) + catalog_manager');

  sect('1. API seller');
  let r = await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${P.pid}`, { cookie: cm.cookie });
  const v = r.json?.variants?.[0] ?? {};
  !('cost_vnd' in v) ? ok('catalog_manager: VẮNG KHOÁ cost_vnd (không phải null)') : bad('vẫn trả giá vốn', JSON.stringify(v.cost_vnd));
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${P.pid}`, { cookie: A.cookie });
  r.json?.variants?.[0]?.cost_vnd === '120000' ? ok('owner vẫn thấy cost_vnd = 120000') : bad('owner mất giá vốn!', JSON.stringify(r.json?.variants?.[0]));
  r = await rq(SELLER, 'PATCH', `/shops/${A.shopId}/products/${P.pid}/variants/${P.vid}`,
    { body: { cost_vnd: 999 }, cookie: cm.cookie, origin: OS });
  r.status === 403 ? ok('catalog_manager GHI giá vốn → 403') : bad('vẫn ghi được', String(r.status));
  const sau = await owner.query(`SELECT cost_vnd FROM variant_costs WHERE variant_id=$1`, [P.vid]);
  sau.rows[0]?.cost_vnd === '120000' ? ok('giá vốn trong DB KHÔNG đổi (vẫn 120000)') : bad('giá vốn bị ghi đè!', JSON.stringify(sau.rows[0]));
  r = await rq(SELLER, 'PATCH', `/shops/${A.shopId}/products/${P.pid}/variants/${P.vid}`,
    { body: { price_vnd: 210000 }, cookie: cm.cookie, origin: OS });
  r.status === 200 ? ok('catalog_manager vẫn sửa được GIÁ BÁN (không chặn oan)') : bad('chặn nhầm giá bán', String(r.status));

  sect('2. Trang chi tiết sản phẩm');
  const pg = await adm('GET', `/shops/${A.shopId}/products/${P.pid}`, { cookie: cm.cookie });
  const own = await adm('GET', `/shops/${A.shopId}/products/${P.pid}`, { cookie: A.cookie });
  !/name="cost_[0-9a-f-]+"/.test(pg.body) ? ok('catalog_manager: không có ô nhập giá vốn') : bad('vẫn còn ô nhập');
  !/Giá vốn \(đ\)/.test(pg.body) ? ok('catalog_manager: không có cột "Giá vốn (đ)"') : bad('vẫn còn cột');
  !/biên ~\d+%/.test(pg.body) ? ok('catalog_manager: KHÔNG lộ biên lãi (suy ngược ra vốn)') : bad('còn biên lãi — vẫn lộ vốn!');
  !/120000|120\.000/.test(pg.body) ? ok('con số 120000 không xuất hiện ở bất kỳ đâu trong trang') : bad('giá vốn lọt ra trang dưới dạng khác');
  const bien = /biên ~(\d+)%/.exec(own.body); /name="cost_[0-9a-f-]+"/.test(own.body) && bien ? ok(`owner vẫn thấy ô nhập + biên ~${bien[1]}%`) : bad('owner mất cột giá vốn!');
  // Đếm CỘT chứ không chỉ tìm chuỗi: ẩn tiêu đề mà quên ẩn ô (hoặc ngược lại) làm bảng lệch
  // một cột — hàng dữ liệu trượt sang ô sai và trông vẫn "có vẻ đúng" nếu chỉ khớp chuỗi.
  const cols = (b) => (b.match(/<th[ >]/g) ?? []).length;
  cols(own.body) === cols(pg.body) + 1
    ? ok(`bảng biến thể lệch ĐÚNG một cột (owner ${cols(own.body)} · catalog_manager ${cols(pg.body)})`)
    : bad('số cột không lệch đúng 1 — bảng có thể trượt ô', `${cols(own.body)} vs ${cols(pg.body)}`);

  sect('3. Tệp mẫu CSV + trang nhập');
  const mau = await adm('GET', `/shops/${A.shopId}/products/import/mau.csv`, { cookie: cm.cookie });
  const mauO = await adm('GET', `/shops/${A.shopId}/products/import/mau.csv`, { cookie: A.cookie });
  !/cost_vnd/.test(mau.body) ? ok('mẫu CSV cho catalog_manager KHÔNG có cột cost_vnd') : bad('mẫu vẫn mời điền giá vốn');
  /cost_vnd/.test(mauO.body) ? ok('mẫu CSV cho owner VẪN có cost_vnd') : bad('owner mất cột trong mẫu');
  // Dòng DỮ LIỆU cũng phải bớt đúng một ô, không chỉ dòng tiêu đề: bỏ cột ở header mà giữ ở
  // dữ liệu là tệp lệch cột — Excel mở ra vẫn đẹp, nhập vào thì sai mọi trường phía sau.
  const oO = (mauO.body.split('\n')[1] ?? '').split(',').length;
  const oC = (mau.body.split('\n')[1] ?? '').split(',').length;
  oO === oC + 1 ? ok(`dòng dữ liệu mẫu bớt ĐÚNG một ô (owner ${oO} · catalog_manager ${oC})`)
    : bad('mẫu CSV lệch cột', `${oO} vs ${oC}`);
  const ip = await adm('GET', `/shops/${A.shopId}/products/import`, { cookie: cm.cookie });
  !/<code>cost_vnd<\/code>/.test(ip.body) ? ok('bảng mô tả cột không nhắc cost_vnd') : bad('bảng cột vẫn có');

  sect('4. Nhập CSV có cột giá vốn bằng vai thiếu quyền');
  const BND = '----p' + uniq();
  const csv = 'handle,title,status,sku,price_vnd,cost_vnd\nao-x,Ao X,draft,SKU-X1,50000,30000\nao-y,Ao Y,draft,SKU-Y1,60000,40000\n';
  const post = async (mode, cookie) => {
    let b = `--${BND}\r\nContent-Disposition: form-data; name="mode"\r\n\r\n${mode}\r\n`;
    b += `--${BND}\r\nContent-Disposition: form-data; name="import_mode"\r\n\r\ncreate_only\r\n`;
    b += `--${BND}\r\nContent-Disposition: form-data; name="file"; filename="x.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${BND}--\r\n`;
    const x = await fetch(ADMIN + `/shops/${A.shopId}/products/import`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': `multipart/form-data; boundary=${BND}`, origin: OADM, cookie: `__Host-session=${cookie}` }, body: b });
    return { status: x.status, body: await x.text() };
  };
  let x = await post('preview', cm.cookie);
  const cauBao = /<strong>Cột giá vốn đã bị bỏ qua<\/strong> ở (\d+) dòng/.exec(x.body);
  cauBao && cauBao[1] === '2' ? ok('xem trước NÓI RÕ bỏ qua giá vốn ở 2 dòng') : bad('câu báo sai hoặc thiếu', cauBao ? cauBao[1] : x.body.slice(0,300));
  x = await post('commit', cm.cookie);
  const cauBao2 = /<strong>Cột giá vốn đã bị bỏ qua<\/strong> ở (\d+) dòng/.exec(x.body);
  cauBao2 ? ok('nhập thật cũng nói rõ') : bad('nhập thật im lặng');
  const n = await owner.query(`SELECT count(*)::int c FROM variant_costs vc JOIN variants v ON v.id=vc.variant_id JOIN products p ON p.id=v.product_id WHERE p.shop_id=$1 AND p.title IN ('Ao X','Ao Y')`, [A.shopId]);
  n.rows[0].c === 0 ? ok('KHÔNG dòng variant_costs nào được ghi từ tệp đó') : bad('vẫn ghi giá vốn!', String(n.rows[0].c));
  const sp = await owner.query(`SELECT count(*)::int c FROM products WHERE shop_id=$1 AND title IN ('Ao X','Ao Y')`, [A.shopId]);
  sp.rows[0].c === 2 ? ok('2 sản phẩm VẪN được nhập bình thường (không chặn cả tệp)') : bad('chặn nhầm cả tệp', String(sp.rows[0].c));

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  if (fail) process.exitCode = 1;
  await owner.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
