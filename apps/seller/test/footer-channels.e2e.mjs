/**
 * End-to-end kênh bán & mạng xã hội trên chân trang. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/footer-channels.e2e.mjs
 *
 * Chủ shop muốn gắn link Shopee/Facebook/Zalo và một cụm nút liên hệ nổi. Rủi ro ở
 * đây KHÔNG phải chuyện trình bày mà là chuyện người bán nhập được gì vào trang:
 *   - `kind` phải nằm trong whitelist (storefront tra bảng để lấy tên/màu → kind lạ
 *     không có gì để render, nhưng vẫn phải chặn ở tầng ghi cho DB sạch);
 *   - url đi qua safeLink y như nav_links (javascript:/data:/'//' bị loại);
 *   - riêng kênh "Gọi ngay" người bán nhập SỐ, hệ thống tự dựng tel: — chỉ giữ chữ số.
 *
 * Kiểm cả phía HIỂN THỊ: cấu hình nằm ở props section footer, mà SÁU trang storefront
 * gọi SECTIONS.footer({}, ctx) với props RỖNG. Nếu footer chỉ đọc props thì kênh biến
 * mất ở mọi trang trừ trang chủ — nên có ca đọc TRANG SẢN PHẨM, không phải trang chủ.
 */

import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const STOREFRONT = process.env.STOREFRONT_URL ?? 'http://storefront:3050';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
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
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
// Host ảo: fetch() BỎ header host (forbidden header của spec) nên phải đi http thô.
function sf(host, path) {
  return new Promise((resolve, reject) => {
    import('node:http').then(({ default: http }) => {
      const u = new URL(STOREFRONT + path);
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { host } }, (res) => {
        let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: t }));
      });
      req.on('error', reject); req.end();
    });
  });
}
// Form-encoded tới seller-admin (BFF) — đúng cách trình duyệt gửi trang Giao diện.
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
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  await owner.query(`UPDATE shops SET status='active', went_live_at=now() WHERE id=$1`, [shopId]);
  // Tạo shop qua platform đã tự cấp domain <slug>.nentang.vn ĐÃ verify — không tự
  // INSERT vào domains (thiếu verification_token là vỡ NOT NULL, và cũng là đi cửa sau).
  const host = `${slug}.nentang.vn`;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, host, cookie: await login(email, password) };
}

const footerProps = async (shopId, cookie) => {
  const r = await rq(SELLER, 'GET', `/shops/${shopId}/theme`, { cookie });
  return (Array.isArray(r.json?.layout) ? r.json.layout.find((s) => s && s.section === 'footer') : null)?.props ?? {};
};
const putFooter = (shopId, cookie, props) => rq(SELLER, 'PUT', `/shops/${shopId}/theme`, {
  cookie, origin: OS,
  body: { tokens: {}, layout: [{ section: 'header', props: {} }, { section: 'hero', props: {} }, { section: 'product_grid', props: {} }, { section: 'footer', props }] },
});

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `chn-${uniq()}`);
  ok('dựng shop owner + host');

  // ── 1. Whitelist kind + safeLink + tel: ───────────────────────────────────────
  sect('1. Chuẩn hoá kênh');
  let r = await putFooter(A.shopId, A.cookie, {
    social: [
      { kind: 'shopee', url: 'https://shopee.vn/shop' },        // giữ
      { kind: 'facebook', url: 'https://fb.com/shop' },         // giữ
      { kind: 'myspace', url: 'https://myspace.com/shop' },     // kind ngoài whitelist → bỏ
      { kind: 'zalo', url: 'javascript:alert(1)' },             // url độc → bỏ
      { kind: 'phone', url: '0909 123 456' },                   // số → tel:0909123456
      { kind: 'facebook', url: 'https://fb.com/shop2' },        // TRÙNG kind → bỏ
      { kind: 'tiki', url: '//evil.example' },                  // protocol-relative → bỏ
    ],
  });
  let fp = await footerProps(A.shopId, A.cookie);
  const s = Array.isArray(fp.social) ? fp.social : [];
  const kinds = s.map((x) => x.kind).join(',');
  const tel = s.find((x) => x.kind === 'phone')?.url;
  (r.status === 200 && kinds === 'shopee,facebook,phone' && tel === 'tel:0909123456')
    ? ok('bỏ kind lạ, url độc, protocol-relative, trùng kind; số → tel:0909123456')
    : bad('chuẩn hoá kênh sai', `${r.status} kinds=${kinds} tel=${tel}\n${JSON.stringify(s)}`);

  // Số quá ngắn không dựng được tel: — "gọi ngay" mà bấm vào không gọi được thì thà không có.
  await putFooter(A.shopId, A.cookie, { social: [{ kind: 'phone', url: '123' }] });
  fp = await footerProps(A.shopId, A.cookie);
  fp.social === undefined ? ok('số điện thoại < 8 chữ số → bỏ hẳn kênh') : bad('số ngắn vẫn lọt', JSON.stringify(fp.social));

  // ── 2. Trần số lượng ──────────────────────────────────────────────────────────
  sect('2. Trần social 8 / float 4');
  const many = ['facebook', 'instagram', 'tiktok', 'youtube', 'zalo', 'messenger', 'shopee', 'lazada', 'tiki', 'sendo']
    .map((k) => ({ kind: k, url: `https://x.example/${k}` }));
  r = await putFooter(A.shopId, A.cookie, { social: many, float: many });
  fp = await footerProps(A.shopId, A.cookie);
  (fp.social?.length === 8 && fp.float?.length === 4)
    ? ok('10 kênh → social cap 8, float cap 4') : bad('không cap', `${fp.social?.length}/${fp.float?.length}`);

  // ── 3. Hiển thị trên storefront — TRANG SẢN PHẨM, không phải trang chủ ────────
  sect('3. Render trên trang không-phải-trang-chủ');
  await putFooter(A.shopId, A.cookie, {
    social: [{ kind: 'shopee', url: 'https://shopee.vn/s' }, { kind: 'phone', url: '0912345678' }],
    float: [{ kind: 'zalo', url: 'https://zalo.me/0912345678' }],
  });
  // /products do CHÍNH storefront phục vụ và KHÔNG đi qua layout (khác trang chủ) —
  // đúng đường mà lỗi "props rỗng" sẽ lộ ra. (/cart là của service checkout, 404 ở đây.)
  let pr = await sf(A.host, '/products');
  // Icon giờ là SVG tự vẽ, không còn chữ viết tắt 2 ký tự — ca này trước kiểm '>SP<'.
  (pr.status === 200 && /class="chn ftr-chn"[^>]*shopee\.vn/.test(pr.body)
    && /<span class="chn-i"><svg /.test(pr.body) && /title="Shopee"/.test(pr.body))
    ? ok('pill Shopee hiện ở chân trang /products, icon là SVG (props rỗng → tra lại layout)')
    : bad('kênh mất ở trang không-phải-trang-chủ', String(pr.status));
  /href="tel:0912345678"/.test(pr.body) && pr.body.includes('>0912345678<')
    ? ok('kênh Gọi ngay → href tel: + hiện đúng số') : bad('tel: sai');
  /class="fab"/.test(pr.body) && /class="chn fab-b"[^>]*zalo\.me/.test(pr.body)
    ? ok('cụm nút NỔI render (zalo)') : bad('thiếu nút nổi');
  /target="_blank" rel="noopener nofollow"/.test(pr.body)
    ? ok('link ra ngoài có noopener + nofollow') : bad('thiếu noopener/nofollow');

  // ── 4. Không cấu hình → KHÔNG phát thẻ nào ────────────────────────────────────
  sect('4. Chưa cấu hình thì im lặng');
  await putFooter(A.shopId, A.cookie, {});
  pr = await sf(A.host, '/products');
  // PHẢI khẳng định 200: bản đầu chỉ kiểm "không có chn-row" nên trang 404 cũng đạt —
  // ca xanh trong khi chẳng đo gì. Đúng loại xanh-rỗng đã cắn ở chỗ khác.
  (pr.status === 200 && !pr.body.includes('class="chn-row"') && !pr.body.includes('class="fab"'))
    ? ok('bỏ trống → trang vẫn 200 nhưng không hàng kênh, không nút nổi') : bad('phát thẻ rỗng thừa', String(pr.status));

  // ── 5. Đi qua FORM THẬT của seller-admin ─────────────────────────────────────
  // Ba ca trên gọi thẳng API seller. Nhưng chủ shop không gọi API — họ bấm nút trong
  // trang Giao diện. Đường đó có thêm hai chỗ hỏng được mà API không thấy: ô không
  // nằm trong form (trình duyệt lặng lẽ không gửi) và handler quên đọc field. Đã bị
  // đúng lớp lỗi đó một lần với form="pall", nên đường form phải có ca riêng.
  sect('5. Lưu qua form trang Giao diện');
  let ar = await adm('GET', `/shops/${A.shopId}/theme`, { cookie: A.cookie });
  const hasField = ar.body.includes('name="ch_kind_0"') && ar.body.includes('name="ch_url_0"') && ar.body.includes('name="ch_float_0"');
  // Ô phải nằm TRONG thẻ <form> đang POST /theme, không thì bấm Lưu là mất trắng.
  const iForm = ar.body.indexOf(`action="/shops/${A.shopId}/theme"`);
  const iField = ar.body.indexOf('name="ch_kind_0"');
  const seg = ar.body.slice(iForm, iField);
  const inForm = iForm > 0 && iField > iForm && !seg.includes('</form>');
  (ar.status === 200 && hasField && inForm)
    ? ok('trang Giao diện có ô kênh, nằm TRONG form lưu giao diện') : bad('ô kênh thiếu/ngoài form', `field=${hasField} inForm=${inForm}`);

  ar = await adm('POST', `/shops/${A.shopId}/theme`, {
    cookie: A.cookie, origin: OADM,
    form: {
      ch_kind_0: 'shopee', ch_url_0: 'https://shopee.vn/qua-form',
      ch_kind_1: 'phone', ch_url_1: '0987 654 321', ch_float_1: '1',
      ch_kind_2: 'zalo', ch_url_2: '',                       // thiếu địa chỉ → bỏ dòng
    },
  });
  fp = await footerProps(A.shopId, A.cookie);
  const viaForm = (fp.social ?? []).map((x) => x.kind).join(',');
  (ar.status === 303 && viaForm === 'shopee,phone' && fp.float?.length === 1 && fp.float[0].kind === 'phone'
    && fp.social.find((x) => x.kind === 'phone').url === 'tel:0987654321')
    ? ok('form lưu 2 kênh, bỏ dòng thiếu địa chỉ, chỉ dòng có tick thành nút nổi')
    : bad('lưu qua form sai', `${ar.status} social=${viaForm} float=${JSON.stringify(fp.float)}`);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('footer-channels e2e lỗi:', err); process.exit(2); });
