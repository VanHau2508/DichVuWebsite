/**
 * E2E: LƯỢT NHẬP ĐỨT GIỮA CHỪNG. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-nhap-dut.e2e.mjs
 *
 * VÌ SAO CÓ BỘ NÀY. Admin chia tệp thành lô 200 sản phẩm. Đo được ngày 03/09 (tiêm lỗi ở lô 2
 * của tệp 400 SP): **200 sản phẩm ĐÃ vào cửa hàng thật**, còn người bán chỉ thấy một câu
 * "Không nhập được — kiểm tra quyền hoặc định dạng tệp". Câu đó sai ba lần cùng lúc — đã nhập,
 * quyền không sao, tệp không sao — và `results` của các lô đã xong bị `return` thẳng ném đi dù
 * số liệu nằm sẵn trong tay. Có HAI đường hỏng: seller trả non-200, và `fetch` NÉM (container
 * chết/timeout) làm ngoại lệ thoát ra thành trang "Lỗi" 500 trần trụi.
 *
 * DỰNG SỰ CỐ BẰNG HÀNH VI SẢN PHẨM, KHÔNG TIÊM LỖI. `axis_names` được admin gửi kèm MỌI lô,
 * còn seller chặn thân yêu cầu ở 2MB: cho lô 1 toàn sản phẩm nhẹ (qua trót lọt) và lô 2 vài sản
 * phẩm mô tả rất dài, cộng axis_names ~1MB → đúng lô 2 bị từ chối SAU KHI lô 1 đã ghi 200 sản
 * phẩm. Nhờ vậy cả ba mảnh của chốt (§4) đều đo được bằng hành vi: cơ chế (lô 1 không bị hoàn
 * tác) → dây nối (server.js dựng `dut`) → điểm phát ra (trang nói đủ ba câu §9.2).
 *
 * MỘT NHÁNH VẪN CHƯA ĐO ĐƯỢC BẰNG HÀNH VI: đường `fetch` NÉM (container chết, timeout). Nó đi
 * qua `catch` riêng trong server.js và chỉ khác ở CÂU LÝ DO. Đã đo TAY một lần bằng cách dừng
 * container giữa lượt nhập (kết quả ghi ở §9.3b); ai sửa khu đó phải chạy lại tay.
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

const BND='----d'+uniq();
function mp(csv,fields){let b='';for(const[k,v]of Object.entries(fields))b+=`--${BND}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;return b+`--${BND}\r\nContent-Disposition: form-data; name="file"; filename="x.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${BND}--\r\n`;}
const nhap=async(shopId,cookie,csv,f)=>{const r=await fetch(ADMIN+`/shops/${shopId}/products/import`,{method:'POST',redirect:'manual',headers:{'content-type':`multipart/form-data; boundary=${BND}`,origin:OADM,cookie:`__Host-session=${cookie}`},body:mp(csv,f)});return{status:r.status,body:await r.text()};};
const hang=(n)=>{let c='handle,title,status,sku,price_vnd\n';for(let i=1;i<=n;i++)c+=`d-${i},SP ${i},draft,SKU-${i},100000\n`;return c;};

async function main(){
  const staff=await makeStaff();

  sect('1. Lô 2 hỏng THẬT — lô 1 đã ghi, trang phải nói đủ ba câu');
  // Dựng sự cố bằng HÀNH VI SẢN PHẨM, không tiêm lỗi vào mã: `axis_names` được admin gửi kèm
  // MỌI lô, còn seller chặn thân yêu cầu ở 2MB. Cho lô 1 toàn sản phẩm nhẹ (qua trót lọt) và
  // lô 2 vài sản phẩm mô tả rất dài, cộng thêm axis_names ~1MB → đúng lô 2 vượt 2MB và bị từ
  // chối, sau khi lô 1 đã ghi xong 200 sản phẩm.
  const A=await makeShopOwner(staff,`dut-${uniq()}`);
  await owner.query(`UPDATE subscriptions SET plan_code='growth' WHERE shop_id=$1`,[A.shopId]);
  let csv='handle,title,description,status,sku,price_vnd\n';
  for(let i=1;i<=200;i++) csv+=`d-${i},SP ${i},,draft,SKU-${i},100000\n`;
  const dai='x'.repeat(120000);
  for(let i=201;i<=210;i++) csv+=`d-${i},SP NANG ${i},${dai},draft,SKU-${i},100000\n`;
  const phinh={}; for(let k=0;k<10;k++) phinh[`axis_100000000${k}_1`]='y'.repeat(100000);
  const r=await nhap(A.shopId,A.cookie,csv,{mode:'commit',import_mode:'create_only',...phinh});
  const daTao=(await owner.query(`SELECT count(*)::int c FROM products WHERE shop_id=$1 AND deleted_at IS NULL`,[A.shopId])).rows[0].c;
  daTao===200?ok('lô 1 ghi đủ 200 sản phẩm, KHÔNG bị hoàn tác vì lô sau hỏng'):bad(`số đã ghi lạ: ${daTao}`);
  /Lượt nhập dừng giữa chừng/.test(r.body)?ok('có khối "Lượt nhập dừng giữa chừng"'):bad('không có khối cảnh báo', `${r.status} ${r.body.slice(0,200)}`);
  /Đã nhập xong <strong>1\/2<\/strong> phần/.test(r.body)?ok('CHUYỆN GÌ: nói rõ đã xong 1/2 phần tệp'):bad('không nói phần đã xong');
  /đã nằm trong cửa hàng/.test(r.body)?ok('CHUYỆN GÌ: nói rõ phần đã xong ĐÃ vào cửa hàng'):bad('không nói phần đã ghi');
  /10 sản phẩm chưa được thêm/.test(r.body)?ok('LÀM GÌ TIẾP: nêu đúng 10 sản phẩm còn thiếu'):bad('số còn thiếu sai');
  /<li>SP NANG 201[\s\S]{0,80}dòng 202/.test(r.body)?ok('LÀM GÌ TIẾP: nêu ĐÍCH DANH sản phẩm + số dòng trong tệp'):bad('không nêu đích danh + dòng');
  /không bị nhân đôi/.test(r.body)?ok('THỬ LẠI ĐƯỢC KHÔNG: nói rõ gửi lại không nhân đôi'):bad('không trả lời thử-lại');
  // Khẳng định TRÊN TRANG, không phải trên DB: cả điểm của bản vá là GIỮ kết quả các lô đã
  // xong thay vì ném đi. Đếm sản phẩm bằng SQL thì đúng cả khi trang chẳng hiện gì — đo được
  // đúng lỗ đó: đột biến gỡ `mergeImportResults` khỏi payload vẫn cho 12/0 xanh.
  const oTao=/<div class="l">Sản phẩm đã tạo<\/div><div class="v"[^>]*>(\d+)/.exec(r.body);
  oTao && Number(oTao[1])===200
    ? ok('TRANG hiện đúng 200 sản phẩm đã tạo (không ném kết quả lô đã xong)')
    : bad('trang không hiện số đã tạo', oTao?oTao[1]:'(không có ô)');
  !/kiểm tra quyền hoặc định dạng tệp/.test(r.body)?ok('KHÔNG còn câu sai "kiểm tra quyền hoặc định dạng tệp"'):bad('vẫn còn câu sai cũ');

  sect('2. Gửi lại tệp VỪA SỨC — nhập nốt phần thiếu, không nhân đôi');
  let csv2='handle,title,status,sku,price_vnd\n';
  for(let i=1;i<=210;i++) csv2+=`d-${i},SP ${i},draft,SKU-${i},100000\n`;
  await nhap(A.shopId,A.cookie,csv2,{mode:'commit',import_mode:'create_only'});
  const t2=(await owner.query(`SELECT count(*)::int c FROM products WHERE shop_id=$1 AND deleted_at IS NULL`,[A.shopId])).rows[0].c;
  t2===210?ok('gửi lại → đúng 210: phần cũ bỏ qua, phần thiếu được thêm'):bad(`sai tổng: ${t2}`);

  sect('3. Xem trước đứt phải nói CHƯA GHI GÌ, không doạ nhầm');
  const B2=await makeShopOwner(staff,`dv-${uniq()}`);
  await owner.query(`UPDATE subscriptions SET plan_code='growth' WHERE shop_id=$1`,[B2.shopId]);
  const rv=await nhap(B2.shopId,B2.cookie,csv,{mode:'preview',import_mode:'create_only',...phinh});
  /Lượt nhập dừng giữa chừng/.test(rv.body)?ok('xem trước cũng có khối đứt'):bad('xem trước không có khối đứt');
  const taoKhiXem=(await owner.query(`SELECT count(*)::int c FROM products WHERE shop_id=$1 AND deleted_at IS NULL`,[B2.shopId])).rows[0].c;
  taoKhiXem===0?ok('xem trước đứt: cửa hàng vẫn trống'):bad(`xem trước đã ghi ${taoKhiXem}`);
  /Mới xem trước được <strong>\d+\/\d+<\/strong> phần của tệp thì dừng — <strong>chưa ghi gì vào cửa hàng<\/strong>/.test(rv.body)?ok('xem trước đứt nói rõ CHƯA ghi gì'):bad('xem trước đứt nói sai/thiếu');

  console.log(`\n${pass} pass, ${fail} fail`); if(fail) process.exitCode=1; await owner.end();
}
main().catch(e=>{console.error(e);process.exit(1)});
