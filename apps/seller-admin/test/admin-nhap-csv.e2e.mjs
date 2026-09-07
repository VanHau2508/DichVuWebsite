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
// Bản gửi BYTE THÔ: các ca bảng mã không diễn đạt được bằng chuỗi JS (UTF-16, tệp ANSI).
async function upBytes(shopId,cookie,bytes,fields){
  const parts=[];
  for(const[k,v]of Object.entries(fields)) parts.push(Buffer.from(`--${BND}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${BND}\r\nContent-Disposition: form-data; name="file"; filename="x.csv"\r\nContent-Type: text/csv\r\n\r\n`));
  parts.push(bytes); parts.push(Buffer.from(`\r\n--${BND}--\r\n`));
  const r=await fetch(ADMIN+`/shops/${shopId}/products/import`,{method:'POST',redirect:'manual',headers:{'content-type':`multipart/form-data; boundary=${BND}`,origin:OADM,cookie:`__Host-session=${cookie}`},body:Buffer.concat(parts)});
  return{status:r.status,body:await r.text()};
}
const boQuaCot=(b)=>{const m=/<strong style="color:var\(--warn\)">Bỏ qua:<\/strong>([\s\S]*?)<\/p>/.exec(b);return m?m[1].replace(/<[^>]*>/g,'').trim():'';};
const oSeTao=(b)=>{const m=/<div class="l">Sẽ tạo<\/div><div class="v">(\d+)/.exec(b);return m?Number(m[1]):null;};
const cauLoi=(b)=>{const m=/<div class="err">([\s\S]*?)<\/div>/.exec(b);return m?m[1].replace(/<[^>]*>/g,'').trim():'';};

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
  // ── THỨ TỰ TRÊN MÀN HÌNH HẸP ───────────────────────────────────────────────
  // Đo ngày 07/09 bằng Chromium 360px: bốn ô số liệu xếp DỌC, mỗi ô một thẻ cao ~200px, nên
  // người bán phải cuộn ~800px qua phần tóm tắt mới tới BẢNG LỖI — thứ duy nhất họ cần khi tệp
  // hỏng. Trên bàn giấy bốn ô nằm một hàng nên không ai thấy vấn đề.
  //
  // Chủ dự án chốt: có lỗi thì bảng lỗi lên TRƯỚC. Đổi trong DOM chứ không bằng CSS `order`,
  // nên khẳng định này đo được bằng VỊ TRÍ TRONG HTML — mà đó cũng đúng là thứ quyết định thứ
  // tự đọc màn hình và thứ tự Tab, không chỉ thứ tự nhìn thấy.
  const viTriLoi = r1.body.indexOf('dòng cần xem lại');
  const viTriSoLieu = r1.body.indexOf('class="metrics"');
  viTriLoi > 0 && viTriSoLieu > 0 && viTriLoi < viTriSoLieu
    ? ok('có lỗi: bảng lỗi đứng TRƯỚC ô số liệu trong DOM (360px không phải cuộn ~800px mới thấy)')
    : bad('ô số liệu vẫn chắn trước bảng lỗi', `lỗi@${viTriLoi} sốliệu@${viTriSoLieu}`);
  sect('P1b · tệp NHỎ (một lô) vẫn đúng như cũ');
  const A2=await makeShopOwner(staff,`s-${uniq()}`);
  const r1b=await up(A2.shopId,A2.cookie,'handle,title,status,sku,price_vnd\nok-1,OK,draft,SKU-A,100000\nbad-1,Bad,draft,SKU-B,rac\n',{mode:'preview',import_mode:'create_only'});
  const d2=[...r1b.body.matchAll(/<td[^>]*>(\d+)<\/td>/g)].map(m=>Number(m[1]));
  d2.includes(3)?ok('tệp nhỏ: báo đúng dòng 3'):bad(`tệp nhỏ sai: ${JSON.stringify(d2.slice(0,4))}`);
  // Chiều NGƯỢC LẠI, để chốt không thành "luôn đảo": tệp sạch thì số liệu giữ nguyên vị trí
  // đầu — lúc đó chính nó là câu trả lời, không có bảng lỗi nào để ưu tiên.
  const A2b=await makeShopOwner(staff,`sach-${uniq()}`);
  const rSach=await up(A2b.shopId,A2b.cookie,'handle,title,status,sku,price_vnd\nok-1,OK,draft,SKU-Z1,100000\nok-2,OK 2,draft,SKU-Z2,120000\n',{mode:'preview',import_mode:'create_only'});
  const vSach=rSach.body.indexOf('class="metrics"'), vKhongLoi=rSach.body.indexOf('Không có lỗi nào');
  vSach > 0 && vKhongLoi > vSach
    ? ok('tệp sạch: số liệu vẫn đứng trước — chốt không phải là "luôn đảo thứ tự"')
    : bad('tệp sạch cũng bị đảo thứ tự', `sốliệu@${vSach} khônglỗi@${vKhongLoi}`);
  // ── BẢNG MÃ VÀ DẤU TIẾNG VIỆT ──────────────────────────────────────────────
  sect('P1c · bảng mã tệp và tiêu đề tiếng Việt');
  const Ab=await makeShopOwner(staff,`bom-${uniq()}`);
  // 1. Tiêu đề CÓ DẤU. Bảng bí danh của seller vốn đã chứa `tensanpham`/`giaban`/`tonkho` —
  //    tức nó viết ra để phục vụ người bán Việt — nhưng trước 07/09 normKey không bỏ dấu nên
  //    chỉ khớp khi gõ KHÔNG dấu. Đo được: "Sẽ tạo 0" và cả bốn cột rơi vào "Bỏ qua".
  const rDau=await up(Ab.shopId,Ab.cookie,'handle,Tên sản phẩm,Mã SKU,Giá bán,Tồn kho\nao-1,Áo len,SKU-D1,399000,5\n',{mode:'preview',import_mode:'create_only'});
  oSeTao(rDau.body)===1 && !/tên sản phẩm/i.test(boQuaCot(rDau.body))
    ? ok('tiêu đề tiếng Việt CÓ DẤU được nhận (nửa bảng bí danh trước nay chưa dùng được cho ai)')
    : bad('tiêu đề có dấu vẫn bị bỏ', `sẽ tạo=${oSeTao(rDau.body)} bỏ qua=${boQuaCot(rDau.body)}`);
  // 2. Chiều ngược lại: bản KHÔNG dấu vẫn phải chạy như cũ.
  const rKhongDau=await up(Ab.shopId,Ab.cookie,'handle,Ten san pham,Ma SKU,Gia ban\nao-2,Ao gio,SKU-D2,499000\n',{mode:'preview',import_mode:'create_only'});
  oSeTao(rKhongDau.body)===1
    ? ok('tiêu đề KHÔNG dấu vẫn chạy như cũ — bỏ dấu không phá bí danh có sẵn')
    : bad('bản không dấu hỏng theo', `sẽ tạo=${oSeTao(rKhongDau.body)}`);
  // 3. BOM UTF-8: vốn đã đúng, giữ chốt để không ai gỡ mất dòng cắt BOM.
  const rBom=await upBytes(Ab.shopId,Ab.cookie,Buffer.concat([Buffer.from([0xEF,0xBB,0xBF]),Buffer.from('handle,title,sku,price_vnd\nao-3,Áo khoác dạ,SKU-D3,299000\n','utf8')]),{mode:'preview',import_mode:'create_only'});
  oSeTao(rBom.body)===1 && !/handle/.test(boQuaCot(rBom.body))
    ? ok('BOM UTF-8 bị cắt đúng, cột đầu không thành "\uFEFFhandle"')
    : bad('BOM UTF-8 làm hỏng cột đầu', boQuaCot(rBom.body));
  // 4. UTF-16LE (Excel "Unicode text"). Trước đây mỗi ký tự kèm một byte 00 nên tiêu đề đọc
  //    thành `h a n d l e`, tạo 0 sản phẩm và không câu nào nói vì sao. Có BOM thì không phải đoán.
  const rU16=await upBytes(Ab.shopId,Ab.cookie,Buffer.concat([Buffer.from([0xFF,0xFE]),Buffer.from('handle,title,sku,price_vnd\nao-4,Áo sơ mi,SKU-D4,599000\n','utf16le')]),{mode:'preview',import_mode:'create_only'});
  oSeTao(rU16.body)===1
    ? ok('UTF-16LE có BOM được giải mã, không còn tiêu đề rác "h a n d l e"')
    : bad('UTF-16 vẫn ra rác', `sẽ tạo=${oSeTao(rU16.body)} bỏ qua=${boQuaCot(rU16.body).slice(0,60)}`);
  // 5. CA TỆ NHẤT: tệp bảng mã ANSI (Excel trên Windows tiếng Việt). Trước đây nó nhập THÀNH
  //    CÔNG và ghi thẳng "\uFFFDo thun c\uFFFD sau" vào cửa hàng thật — người bán chỉ phát hiện khi
  //    mở cửa hàng của chính mình. Nay phải TỪ CHỐI, và câu từ chối phải nói việc cần làm.
  const ansi=Buffer.concat([
    Buffer.from('handle,title,sku,price_vnd\nansi-1,'),
    Buffer.from([0xC1,0x6F,0x20,0x74,0x68,0x75,0x6E]),
    Buffer.from(',SKU-D5,699000\n'),
  ]);
  const rAnsi=await upBytes(Ab.shopId,Ab.cookie,ansi,{mode:'commit',import_mode:'create_only'});
  const daGhi=(await owner.query(`SELECT count(*)::int c FROM products WHERE shop_id=$1 AND slug='ansi-1'`,[Ab.shopId])).rows[0].c;
  rAnsi.status===400 && daGhi===0
    ? ok('tệp không phải UTF-8 bị TỪ CHỐI và KHÔNG ghi gì vào cửa hàng')
    : bad('tệp hỏng bảng mã vẫn ghi vào cửa hàng', `${rAnsi.status} đã ghi=${daGhi}`);
  /UTF-8/.test(cauLoi(rAnsi.body)) && /Lưu dưới dạng|Tải xuống/.test(cauLoi(rAnsi.body))
    ? ok('câu từ chối nói ĐÚNG việc cần làm (lưu lại dạng CSV UTF-8), không chỉ báo "tệp hỏng"')
    : bad('câu từ chối không nói việc cần làm', cauLoi(rAnsi.body).slice(0,90));
  // 6. Chiều ngược lại: tệp UTF-8 CÓ DẤU hợp lệ phải đi qua trót lọt và giữ nguyên dấu tới DB.
  const rViet=await upBytes(Ab.shopId,Ab.cookie,Buffer.from('handle,title,sku,price_vnd\nviet-1,Áo thun cổ tròn — size XL,SKU-D6,199000\n','utf8'),{mode:'commit',import_mode:'create_only'});
  const ten=(await owner.query(`SELECT title FROM products WHERE shop_id=$1 AND slug='viet-1'`,[Ab.shopId])).rows[0]?.title ?? null;
  rViet.status===200 && ten==='Áo thun cổ tròn — size XL'
    ? ok('tệp UTF-8 có dấu vẫn nhập được và giữ NGUYÊN VĂN dấu tới DB — chốt không phải "chặn mọi thứ lạ"')
    : bad('tệp UTF-8 có dấu bị chặn hoặc mất dấu', JSON.stringify(ten));

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
