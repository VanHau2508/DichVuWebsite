/**
 * E2E: LUỒNG NHẬP CSV — số dòng báo lỗi và trần gói. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-nhap-csv.e2e.mjs
 *
 * VÌ SAO CÓ BỘ NÀY. Hai lỗi đo được ngày 03/09, cả hai CHỈ lộ ra với tệp lớn hơn một lô
 * (admin chia lô 200 sản phẩm) nên mọi tệp thử nhỏ đều xanh:
 *
 *   1. SỐ DÒNG CHỈ VÀO DÒNG VÔ TỘI. Seller tính `line = i + 2` theo mảng NÓ nhận được, tức chỉ
 *      số trong LÔ. Tệp 260 SP, lỗi ở SP thứ 250 → giao diện báo "dòng 51". Dòng 51 CÓ THẬT và
 *      hoàn toàn đúng, nên người bán sửa một sản phẩm lành lặn rồi nhập lại và vẫn hỏng — trong
 *      khi bảng lỗi này tồn tại đúng để họ "sửa file, không sửa cơ sở dữ liệu".
 *
 *   2. XEM TRƯỚC KHÔNG KIỂM TRẦN GÓI. Trần đọc sau `return` của dry-run nên đường xem trước
 *      không chạm tới: tệp 212 SP hứa "Sẽ tạo 212", nhập thật tạo 100 (gói `platform` trần 100).
 *      Sửa xong còn một tầng nữa: xem trước KHÔNG ghi gì nên mỗi lô đọc số sản phẩm hiện có đều
 *      thấy cửa hàng như lúc đầu — lô 1 báo đúng, lô 2 lại tưởng còn chỗ và hứa thêm 12. Trần
 *      phải được NỐI QUA LÔ, y hệt ngân sách ảnh.
 *
 * Và một hồi quy tự gây ra rồi tự bắt: bản vá đầu nêu đích danh từng dòng vượt trần cho "hữu
 * ích", sinh 100 hàng giống hệt nhau và ĐẨY lỗi thật ra khỏi phần hiển thị. Nay là MỘT dòng
 * tổng — nên bộ này khẳng định cả hai chiều: lỗi thật phải thấy được, và trần chỉ một dòng.
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
const BND='----v'+uniq();
async function up(shopId,cookie,csv,fields){let b='';for(const[k,v]of Object.entries(fields))b+=`--${BND}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;b+=`--${BND}\r\nContent-Disposition: form-data; name="file"; filename="x.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${BND}--\r\n`;const r=await fetch(ADMIN+`/shops/${shopId}/products/import`,{method:'POST',redirect:'manual',headers:{'content-type':`multipart/form-data; boundary=${BND}`,origin:OADM,cookie:`__Host-session=${cookie}`},body:b});return{status:r.status,body:await r.text()};}
async function main(){
  const staff=await makeStaff();
  sect('P1 · số dòng sau khi chia lô');
  const A=await makeShopOwner(staff,`l-${uniq()}`);
  let c1='handle,title,status,sku,price_vnd\n';
  for(let i=1;i<=260;i++) c1+=`sp-${i},SP ${i},draft,SKU-${i},${i===250?'khong-phai-so':'100000'}\n`;
  const r1=await up(A.shopId,A.cookie,c1,{mode:'preview',import_mode:'create_only'});
  const dong=[...r1.body.matchAll(/<td[^>]*>(\d+)<\/td>/g)].map(m=>Number(m[1]));
  // Lỗi THẬT phải nằm trong phần hiển thị, không bị dòng trần đẩy ra ngoài.
  const hangLoi=[...r1.body.matchAll(/<tr>\s*<td[^>]*>(?:<span[^>]*>)?([^<]*)(?:<\/span>)?<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)</g)].map(m=>({dong:m[1],ten:m[2],loi:m[3]}));
  hangLoi.some(h=>h.dong==='251'&&/giá/.test(h.loi))
    ? ok('lỗi THẬT (giá sai, dòng 251) hiện được, không bị dòng trần đẩy ra')
    : bad('lỗi thật bị đẩy khỏi danh sách', JSON.stringify(hangLoi.slice(0,3)));
  (r1.body.match(/vượt giới hạn gói/g)??[]).length <= 2
    ? ok('trần gói chỉ MỘT dòng tổng, không lặp trăm dòng')
    : bad('trần gói lặp quá nhiều dòng', String((r1.body.match(/vượt giới hạn gói/g)??[]).length));
  /cả tệp/.test(r1.body) ? ok('dòng lỗi không thuộc dòng nào ghi "cả tệp", không để ô rỗng') : bad('ô số dòng rỗng');
  dong.includes(251)?ok(`báo ĐÚNG dòng 251 (SP thứ 250 + tiêu đề)`):bad(`vẫn sai: ${JSON.stringify(dong.slice(0,4))}`);
  !dong.includes(51)?ok('KHÔNG còn chỉ vào dòng 51 (dòng vô tội)'):bad('vẫn chỉ vào dòng 51');
  sect('P1b · tệp NHỎ (một lô) vẫn đúng như cũ');
  const A2=await makeShopOwner(staff,`s-${uniq()}`);
  const r1b=await up(A2.shopId,A2.cookie,'handle,title,status,sku,price_vnd\nok-1,OK,draft,SKU-A,100000\nbad-1,Bad,draft,SKU-B,rac\n',{mode:'preview',import_mode:'create_only'});
  const d2=[...r1b.body.matchAll(/<td[^>]*>(\d+)<\/td>/g)].map(m=>Number(m[1]));
  d2.includes(3)?ok('tệp nhỏ: báo đúng dòng 3'):bad(`tệp nhỏ sai: ${JSON.stringify(d2.slice(0,4))}`);
  sect('P2 · xem trước kiểm trần gói');
  const Bc=await makeShopOwner(staff,`c-${uniq()}`);
  let c2='handle,title,status,sku,price_vnd\n';
  for(let i=1;i<=212;i++) c2+=`p-${i},SP ${i},draft,SKU-${i},100000\n`;
  const pv=await up(Bc.shopId,Bc.cookie,c2,{mode:'preview',import_mode:'create_only'});
  const seTao=/<div class="l">Sẽ tạo<\/div><div class="v">(\d+)/.exec(pv.body);
  const nTran=(pv.body.match(/vượt giới hạn gói/g)??[]).length;
  console.log(`  ĐO  xem trước "Sẽ tạo" = ${seTao?seTao[1]:'?'} · số dòng báo trần = ${nTran}`);
  seTao&&Number(seTao[1])===100?ok('xem trước hứa ĐÚNG 100'):bad(`xem trước hứa ${seTao?seTao[1]:'?'}`);
  nTran>0?ok(`xem trước nêu ${nTran} dòng "vượt giới hạn gói"`):bad('xem trước im lặng về trần');
  const cm=await up(Bc.shopId,Bc.cookie,c2,{mode:'commit',import_mode:'create_only'});
  const n=await owner.query(`SELECT count(*)::int c FROM products WHERE shop_id=$1 AND deleted_at IS NULL`,[Bc.shopId]);
  seTao&&Number(seTao[1])===n.rows[0].c?ok(`xem trước KHỚP nhập thật (${n.rows[0].c})`):bad(`vẫn lệch: hứa ${seTao?seTao[1]:'?'} · thật ${n.rows[0].c}`);
  console.log(`\n${pass} pass, ${fail} fail`);
  if (fail) process.exitCode = 1;
  await owner.end();
}
main().catch(e=>{console.error(e);process.exit(1)});
