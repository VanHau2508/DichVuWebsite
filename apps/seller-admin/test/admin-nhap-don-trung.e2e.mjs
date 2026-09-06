/**
 * E2E: NHẬP ĐƠN CŨ — chốt xác nhận cho đơn KHÔNG có mã gốc. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-nhap-don-trung.e2e.mjs
 *
 * VÌ SAO CÓ BỘ NÀY. `migrated_ref` (từ cột `order_code`) là thứ DUY NHẤT chặn nhập trùng —
 * UNIQUE `orders_migrated_ref_uq`. Đo được ngày 06/09: tệp 5 đơn không có cột đó, nhập hai lần
 * → **10 đơn**. Người bán vừa di cư từ sàn khác mở danh sách đơn ra thấy lịch sử nhân đôi, và
 * đó chính là thứ họ dùng để đối chiếu với sàn cũ.
 *
 * KHÔNG phải lỗi đường tiền, và điều này đáng ghi vì phản xạ đầu tiên là tưởng vậy:
 * `reports.js`/`dashboard.js` lọc `NOT o.is_migrated` ở MỌI truy vấn tiền, nên doanh thu không
 * phồng — đo được `/stats` vẫn `{today:0,d7:0,prev7:0,all:0}` sau hai lượt nhập. Một truy vấn
 * SQL tự viết KHÔNG lọc `is_migrated` sẽ cho `sum = 2.000.000₫` và dẫn người đo đi sai đường.
 *
 * Cảnh báo cũ CÓ tồn tại nhưng nằm ở bảng mô tả cột, hiện y hệt nhau dù tệp có cột hay không —
 * một chú thích luôn đúng với mọi tệp thì đọc thành nền, không thành cảnh báo.
 *
 * Khuôn xác nhận lấy đúng của vận đơn mồ côi (§9.3b): lượt đầu chỉ HIỆN con số, lượt hai gửi
 * lại CHÍNH con số đó. Không ô tích mù. Đổi tệp giữa chừng thì số lệch và chốt bắt lại từ đầu.
 *
 * Đếm theo DÒNG THẬT (`ref === null`), không theo việc tệp có cột hay không: một tệp CÓ cột
 * `order_code` nhưng bỏ trống vài ô thì đúng những ô đó mới là chỗ hở — ca 6 canh chính điều đó.
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
const BND='----o'+uniq();
function mp(csv,f){let b='';for(const[k,v]of Object.entries(f))b+=`--${BND}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;return b+`--${BND}\r\nContent-Disposition: form-data; name="file"; filename="d.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${BND}--\r\n`;}
const nhap=async(shopId,cookie,csv,f)=>{const r=await fetch(ADMIN+`/shops/${shopId}/orders/import`,{method:'POST',redirect:'manual',headers:{'content-type':`multipart/form-data; boundary=${BND}`,origin:OADM,cookie:`__Host-session=${cookie}`},body:mp(csv,f)});return{status:r.status,body:await r.text()};};
const dem=async(id)=>(await owner.query(`SELECT count(*)::int c FROM orders WHERE shop_id=$1`,[id])).rows[0].c;
const csvKhong=(n2,p2='09811122')=>{let c='date,customer_name,customer_phone,total_vnd\n';for(let i=1;i<=n2;i++)c+=`2025-01-15,Khach ${i},${p2}2${i},200000\n`;return c;};
async function main(){
  const staff=await makeStaff(); const A=await makeShopOwner(staff,`xn-${uniq()}`);
  ok('dựng shop');

  sect('1. Xem trước tệp thiếu order_code — cảnh báo về CHÍNH TỆP NÀY');
  const pv=await nhap(A.shopId,A.cookie,csvKhong(5),{mode:'preview'});
  /Tệp này thiếu mã đơn gốc/.test(pv.body)?ok('có khối cảnh báo riêng cho tệp'):bad('không có khối');
  /<strong>5 đơn<\/strong>/.test(pv.body)?ok('nêu ĐÚNG 5 đơn thiếu khoá'):bad('số sai/thiếu');
  /tạo thêm 5 đơn trùng/.test(pv.body)?ok('nói rõ HẬU QUẢ: nhập lại tạo thêm 5 đơn trùng'):bad('không nêu hậu quả');
  /thêm cột <code>order_code<\/code>/.test(pv.body)?ok('nói CÁCH SỬA: thêm cột order_code'):bad('không nói cách sửa');
  /name="confirm_no_dedup" value="5"/.test(pv.body)?ok('form mang sẵn con số 5 cho lượt sau'):bad('thiếu ô xác nhận');
  await dem(A.shopId)===0?ok('xem trước KHÔNG ghi gì'):bad('xem trước đã ghi');

  sect('2. Bấm thẳng "Nhập thật" (không xem trước) — phải CHẶN, chưa ghi');
  const B=await makeShopOwner(staff,`xn2-${uniq()}`);
  const l1=await nhap(B.shopId,B.cookie,csvKhong(5,'09822233'),{mode:'commit'});
  const sau1=await dem(B.shopId);
  sau1===0?ok('lượt đầu KHÔNG ghi đơn nào'):bad(`đã ghi ${sau1} đơn`);
  /Chưa ghi gì — cần xác nhận/.test(l1.body)?ok('hiện interstitial "chưa ghi gì"'):bad('không có interstitial');
  /name="confirm_no_dedup" value="5"/.test(l1.body)?ok('trang mang con số 5 cho lượt hai'):bad('thiếu con số');

  sect('3. Lượt hai gửi lại ĐÚNG con số → ghi');
  const l2=await nhap(B.shopId,B.cookie,csvKhong(5,'09822233'),{mode:'commit',confirm_no_dedup:'5'});
  const sau2=await dem(B.shopId);
  sau2===5?ok('gửi lại đúng số → ghi đủ 5 đơn'):bad(`ghi sai: ${sau2}`);

  sect('4. Con số SAI thì không ghi (đổi tệp giữa chừng)');
  const C=await makeShopOwner(staff,`xn3-${uniq()}`);
  await nhap(C.shopId,C.cookie,csvKhong(5,'09833344'),{mode:'commit',confirm_no_dedup:'3'});
  await dem(C.shopId)===0?ok('số lệch → chặn, không ghi'):bad('số lệch vẫn ghi');
  await nhap(C.shopId,C.cookie,csvKhong(5,'09833344'),{mode:'commit',confirm_no_dedup:'khong-phai-so'});
  await dem(C.shopId)===0?ok('chuỗi rác → chặn, không lọt thành 0'):bad('chuỗi rác lọt');

  sect('5. Tệp CÓ order_code — không hỏi gì, đi thẳng');
  const D=await makeShopOwner(staff,`xn4-${uniq()}`);
  let c3='order_code,date,customer_name,customer_phone,total_vnd\n';
  for(let i=1;i<=5;i++) c3+=`Y-${i},2025-01-15,Khach ${i},098444555${i},200000\n`;
  const rd=await nhap(D.shopId,D.cookie,c3,{mode:'commit'});
  const sd=await dem(D.shopId);
  sd===5?ok('có mã gốc: nhập thẳng, không interstitial'):bad(`ghi sai: ${sd}`);
  !/Chưa ghi gì — cần xác nhận|Tệp này thiếu mã đơn gốc/.test(rd.body)?ok('không doạ nhầm tệp hợp lệ'):bad('doạ nhầm');
  await nhap(D.shopId,D.cookie,c3,{mode:'commit'});
  await dem(D.shopId)===5?ok('nhập lại vẫn 5 — chống trùng cũ còn nguyên'):bad('chống trùng hỏng');

  sect('6. Tệp CÓ cột nhưng vài ô TRỐNG — đếm theo dòng thật');
  const E=await makeShopOwner(staff,`xn5-${uniq()}`);
  let c4='order_code,date,customer_name,customer_phone,total_vnd\n';
  for(let i=1;i<=5;i++) c4+=`${i<=3?'Z-'+i:''},2025-01-15,Khach ${i},098555666${i},200000\n`;
  const re=await nhap(E.shopId,E.cookie,c4,{mode:'preview'});
  /<strong>2 đơn<\/strong>/.test(re.body)?ok('đếm ĐÚNG 2 dòng trống ô, không đếm cả tệp'):bad('đếm theo tiêu đề cột chứ không theo dòng');

  console.log(`\n${pass} pass, ${fail} fail`); if(fail) process.exitCode=1; await owner.end();
}
main().catch(e=>{console.error(e);process.exit(1)});
