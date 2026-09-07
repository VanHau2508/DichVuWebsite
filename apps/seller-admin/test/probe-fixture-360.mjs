/**
 * FIXTURE cho `scripts/probe-360.mjs` — KHÔNG phải bộ test (không khớp glob `*.e2e.mjs` nên
 * không vào MANIFEST_E2E_COUNT).
 *
 *   docker compose -f infra/compose.dev.yml exec -T dbtest \
 *     node apps/seller-admin/test/probe-fixture-360.mjs
 *
 * Dựng một shop có ảnh hỏng thật (URL nội bộ bị hàng rào chặn) rồi IN RA `shopId` + cookie
 * phiên, để probe chạy ở HOST đo được trang "Ảnh không tải được" bằng Chromium thật.
 *
 * Cố ý gieo hai thứ hay làm vỡ bố cục hẹp nhất: một TÊN SẢN PHẨM rất dài và một URL rất dài.
 * Lượt đo đầu tiên chính là nhờ URL dài mà lộ ra ô nguồn bị cắt còn `http://127.0.0.…`.
 */
import http from 'node:http'; import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';
const AUTH=process.env.AUTH_URL,PLATFORM=process.env.PLATFORM_URL,SELLER=process.env.SELLER_URL;
const OA='https://auth.localtest',OO='https://ops.localtest',OS='https://seller.localtest';
const owner=new pg.Pool({connectionString:process.env.DATABASE_URL_OWNER,max:4});
const uniq=()=>Math.random().toString(36).slice(2,10);
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const ck=(sc)=>{for(const c of sc??[]){const m=/^__Host-session=([^;]*)/.exec(c);if(m)return m[1];}return null;};
async function rq(b,m,p,{body,cookie,origin}={}){const h={};if(body!==undefined)h['content-type']='application/json';if(origin)h.origin=origin;if(cookie)h.cookie=`__Host-session=${cookie}`;const r=await fetch(b+p,{method:m,headers:h,body:body!==undefined?JSON.stringify(body):undefined});const t=await r.text();let j=null;try{j=t?JSON.parse(t):null;}catch{}return{status:r.status,json:j,sc:r.headers.getSetCookie(),raw:t};}
const login=async(e,p)=>ck((await rq(AUTH,'POST','/auth/login',{body:{email:e,password:p},origin:OA})).sc);
const uidOf=async(e)=>(await owner.query('SELECT id FROM users WHERE email=$1',[e])).rows[0]?.id??null;
const inv=async(email)=>{const{rows}=await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`,[email]);return rows[0]?.u?new URL(rows[0].u).searchParams.get('token'):null;};
async function main(){
  const email=`staff-${uniq()}@nentang.vn`,password='staff strong passphrase';
  await rq(AUTH,'POST','/auth/register',{body:{email,password},origin:OA});
  let staff=await login(email,password);
  const r0=await rq(AUTH,'POST','/auth/mfa/enroll',{cookie:staff,origin:OA});
  const key=base32Decode(r0.json.secret);
  await rq(AUTH,'POST','/auth/mfa/activate',{cookie:staff,body:{code:totp(key,{})},origin:OA});
  const c=counterFor(Date.now());
  await owner.query(`INSERT INTO platform_staff (user_id,role) VALUES ($1,'admin')`,[await uidOf(email)]);
  while(counterFor(Date.now())<=c) await sleep(1000);
  staff=await login(email,password);
  staff=ck((await rq(AUTH,'POST','/auth/mfa/verify',{cookie:staff,body:{code:totp(key,{})},origin:OA})).sc)??staff;

  const slug=`p360-${uniq()}`;
  const rs=await rq(PLATFORM,'POST','/ops/shops',{body:{name:slug,slug,plan_code:'platform'},cookie:staff,origin:OO});
  const shopId=rs.json.id;
  await owner.query(`UPDATE shops SET status='active', went_live_at=now() WHERE id=$1`,[shopId]);
  const oe=`owner-${uniq()}@shop.vn`,op='owner passphrase strong';
  await rq(PLATFORM,'POST',`/ops/shops/${shopId}/invitations`,{body:{email:oe,role:'owner'},cookie:staff,origin:OO});
  await rq(AUTH,'POST','/auth/invitations/accept',{body:{token:await inv(oe),password:op},origin:OA});
  const cookie=await login(oe,op);

  // Ba hình dạng hỏng + tên sản phẩm DÀI và URL DÀI: hai thứ hay làm vỡ bố cục hẹp nhất.
  const rows=[
    {handle:`a${uniq()}`,title:'Áo khoác dạ nữ dáng dài Hàn Quốc mùa đông 2026 bản giới hạn',sku:`s1-${uniq()}`,price_vnd:'899000',status:'active',image_url:'http://127.0.0.1/anh.png'},
    {handle:`b${uniq()}`,title:'Quần',sku:`s2-${uniq()}`,price_vnd:'299000',status:'active',image_url:'http://dbtest/khong-co-that.png'},
    {handle:`c${uniq()}`,title:'Giày thể thao nam đế êm',sku:`s3-${uniq()}`,price_vnd:'1290000',status:'active',
     image_url:'http://127.0.0.1/media/products/2026/09/06/anh-san-pham-goc-chua-nen-kich-thuoc-rat-lon-va-ten-tep-dai-bat-thuong.jpg'},
  ];
  await rq(SELLER,'POST',`/shops/${shopId}/products/import`,{body:{rows},cookie,origin:OS});
  for(let i=0;i<60;i++){
    const n=Number((await owner.query(`SELECT count(*)::int n FROM media m JOIN products p ON p.id=m.product_id WHERE p.shop_id=$1 AND m.status='pending'`,[shopId])).rows[0].n);
    if(n===0)break; await sleep(1000);
  }
  const med=(await owner.query(`SELECT m.status,m.last_error FROM media m JOIN products p ON p.id=m.product_id WHERE p.shop_id=$1`,[shopId])).rows;
  console.log(JSON.stringify({shopId,cookie,media:med}));
  await owner.end();
}
main().catch(e=>{console.error(e);process.exit(1);});
