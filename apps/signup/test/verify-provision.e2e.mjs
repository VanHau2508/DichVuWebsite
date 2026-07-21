// E2E verify + provision (0091 signup-3) — POST /signup/verify nguyên tử 1-tx. Kiểm:
//  • chuỗi đầy đủ: nháp → verify → shop+domain(verified)+subscription(trial)+membership(owner)+audit;
//    user tạo email_verified; nháp→provisioned; KHÔNG auto-login (parity).
//  • GET verify KHÔNG side-effect (nháp vẫn pending sau GET).
//  • double-verify song song → đúng 1 provision, cái kia trung tính (idempotent, chống prefetch).
//  • token 1-lần: verify lại token đã dùng → trung tính, KHÔNG shop thứ 2.
//  • nhánh (b) user chưa-verify → CLAIM (shop tạo, user đặt lại). nhánh (c) user ĐÃ verify → login_required, KHÔNG shop.
//  • CSRF: POST verify không Origin → 403.
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import { getPreset } from '../../../packages/presets/src/index.js';

const SU = new URL(process.env.SIGNUP_URL ?? 'http://signup:3064');
const FORM_SECRET = process.env.SIGNUP_FORM_SECRET ?? 'dev-signup-form-secret';
const HOST = 'nentang.vn';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  PASS ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? ' :: ' + String(d).slice(0, 220) : '')); };
const sect = (m) => console.log('\n# ' + m);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function ct(ageMs = 5000) { const ts = Date.now() - ageMs; return `${ts}.${crypto.createHmac('sha256', FORM_SECRET).update(String(ts)).digest('base64url').slice(0, 24)}`; }
function req(method, path, { form, xff = '203.0.113.9', origin = `https://${HOST}` } = {}) {
  return new Promise((resolve, reject) => {
    const data = form !== undefined ? new URLSearchParams(form).toString() : null;
    const headers = { host: HOST, 'x-forwarded-for': xff };
    if (origin) headers.origin = origin;
    if (data != null) { headers['content-type'] = 'application/x-www-form-urlencoded'; headers['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ hostname: SU.hostname, port: SU.port, path, method, headers }, (rs) => {
      let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => resolve({ status: rs.statusCode, body: b, setCookie: rs.headers['set-cookie'] ?? [] }));
    });
    r.on('error', reject); if (data != null) r.write(data); r.end();
  });
}
const goodForm = (over = {}) => ({ name: 'Nhà Xinh', slug: `v-${uniq()}`, email: `u-${uniq()}@gmail.com`, password: 'matkhau-manh-2026', plan_code: 'platform', website: '', ct: ct(), ...over });
// Đăng ký + móc token thô từ link outbox (chỉ test có được — thực tế đi qua email).
async function draft(over = {}) {
  const f = goodForm(over);
  await req('POST', '/signup', { form: f, xff: `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  const link = (await owner.query(`SELECT payload->>'link' AS l FROM outbox WHERE topic='signup.verify' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [f.email])).rows[0]?.l;
  const token = link ? new URL(link).searchParams.get('token') : null;
  return { ...f, token };
}
const shopBySlug = async (slug) => (await owner.query(`SELECT id, status, created_via FROM shops WHERE lower(slug)=$1`, [slug])).rows[0] ?? null;

async function main() {
  sect('1. Chuỗi đầy đủ: verify → shop+domain+subscription+membership+audit; user verified; KHÔNG auto-login');
  const d = await draft();
  d.token ? ok('lấy được token verify từ outbox') : bad('không có token');
  // GET verify KHÔNG side-effect
  let r = await req('GET', `/signup/verify?token=${d.token}`);
  const pendingAfterGet = (await owner.query(`SELECT status FROM shop_signups WHERE token_hash=$1`, [sha(d.token)])).rows[0]?.status;
  r.status === 200 && /Kích hoạt/.test(r.body) && pendingAfterGet === 'pending' ? ok('GET verify hiện trang xác nhận + nháp VẪN pending (không side-effect)') : bad('GET verify side-effect', pendingAfterGet);
  // POST verify → provision
  r = await req('POST', '/signup/verify', { form: { token: d.token, ct: ct() } });
  const shop = await shopBySlug(d.slug);
  const dom = shop ? (await owner.query(`SELECT verified_at, is_primary FROM domains WHERE shop_id=$1`, [shop.id])).rows[0] : null;
  const sub = shop ? (await owner.query(`SELECT status, current_period_end FROM subscriptions WHERE shop_id=$1`, [shop.id])).rows[0] : null;
  const mem = shop ? (await owner.query(`SELECT role FROM memberships WHERE shop_id=$1`, [shop.id])).rows[0] : null;
  const usr = (await owner.query(`SELECT email_verified_at FROM users WHERE email=$1`, [d.email])).rows[0];
  const aud = shop ? Number((await owner.query(`SELECT count(*)::int n FROM audit_logs WHERE shop_id=$1 AND action='shop.created' AND actor_type='system'`, [shop.id])).rows[0].n) : 0;
  const draftStatus = (await owner.query(`SELECT status, provisioned_shop_id FROM shop_signups WHERE token_hash=$1`, [sha(d.token)])).rows[0];
  const noCookie = r.setCookie.length === 0;
  r.status === 200 && /sẵn sàng/.test(r.body) && shop?.status === 'onboarding' && shop.created_via === 'self_serve'
    && dom?.verified_at && dom.is_primary && sub?.status === 'trial' && sub.current_period_end && mem?.role === 'owner'
    && usr?.email_verified_at && aud === 1 && draftStatus?.status === 'provisioned' && draftStatus.provisioned_shop_id === shop.id && noCookie
    ? ok('provision đủ: shop(self_serve)+domain(verified)+trial(có hạn)+owner+audit; user verified; nháp→provisioned; KHÔNG cookie')
    : bad('provision thiếu', `shop=${!!shop} dom=${!!dom?.verified_at} sub=${sub?.status} mem=${mem?.role} usr=${!!usr?.email_verified_at} aud=${aud} draft=${draftStatus?.status} noCookie=${noCookie}`);

  sect('2. Token 1-lần: verify lại token đã dùng → trung tính, KHÔNG shop thứ 2');
  r = await req('POST', '/signup/verify', { form: { token: d.token, ct: ct() } });
  const cnt = Number((await owner.query(`SELECT count(*)::int n FROM shops WHERE lower(slug)=$1`, [d.slug])).rows[0].n);
  r.status === 200 && /không còn hiệu lực/.test(r.body) && cnt === 1 ? ok('replay token → trang trung tính, vẫn 1 shop') : bad('replay tạo shop 2', `${r.status} cnt=${cnt}`);

  sect('3. Double-verify SONG SONG → đúng 1 provision (idempotent chống prefetch)');
  const d3 = await draft();
  const [ra, rb] = await Promise.all([
    req('POST', '/signup/verify', { form: { token: d3.token, ct: ct() } }),
    req('POST', '/signup/verify', { form: { token: d3.token, ct: ct() } }),
  ]);
  const cnt3 = Number((await owner.query(`SELECT count(*)::int n FROM shops WHERE lower(slug)=$1`, [d3.slug])).rows[0].n);
  const oneOk = [ra, rb].filter((x) => /sẵn sàng/.test(x.body)).length;
  cnt3 === 1 && oneOk === 1 ? ok('2 verify song song → đúng 1 shop, 1 trang "sẵn sàng"') : bad('double provision', `cnt=${cnt3} oneOk=${oneOk}`);

  sect('4. Nhánh (b) user CHƯA verify → CLAIM (shop tạo, user đặt lại)');
  const bEmail = `unv-${uniq()}@gmail.com`;
  await owner.query(`INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1,'OLDHASH',NULL)`, [bEmail]);
  const db2 = await draft({ email: bEmail });
  r = await req('POST', '/signup/verify', { form: { token: db2.token, ct: ct() } });
  const bShop = await shopBySlug(db2.slug);
  const bUser = (await owner.query(`SELECT email_verified_at, password_hash FROM users WHERE email=$1`, [bEmail])).rows[0];
  r.status === 200 && bShop && bUser?.email_verified_at && bUser.password_hash !== 'OLDHASH' ? ok('user chưa-verify → CLAIM: shop tạo + user verified + đặt lại hash') : bad('claim nhánh b sai', `shop=${!!bShop} verified=${!!bUser?.email_verified_at} rehash=${bUser?.password_hash !== 'OLDHASH'}`);

  sect('5. Nhánh (c) user ĐÃ verify → login_required, KHÔNG shop (self-serve không bind mù)');
  const cEmail = `ver-${uniq()}@gmail.com`;
  await owner.query(`INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1,'H',now())`, [cEmail]);
  const dc = await draft({ email: cEmail });
  r = await req('POST', '/signup/verify', { form: { token: dc.token, ct: ct() } });
  const cShop = await shopBySlug(dc.slug);
  r.status === 200 && /đã có tài khoản/.test(r.body) && !cShop ? ok('user đã-verify → login_required, KHÔNG tạo shop') : bad('nhánh c sai', `${r.status} shop=${!!cShop}`);

  sect('6. CSRF: POST verify không Origin → 403');
  const dcsrf = await draft();
  r = await req('POST', '/signup/verify', { form: { token: dcsrf.token, ct: ct() }, origin: null });
  r.status === 403 && !(await shopBySlug(dcsrf.slug)) ? ok('POST verify không Origin → 403, KHÔNG provision') : bad('CSRF verify không chặn', r.status);

  sect('7. Seed THEME theo ngành (0094): chọn ngành → 1 row themes = preset; không chọn → không seed; enum-safe');
  // 7a. industry hợp lệ → shops.industry set + themes seed ĐÚNG preset (tokens+layout)
  const d7 = await draft({ industry: 'cosmetics' });
  await req('POST', '/signup/verify', { form: { token: d7.token, ct: ct() } });
  const s7 = await shopBySlug(d7.slug);
  const th7 = s7 ? (await owner.query(`SELECT tokens, layout FROM themes WHERE shop_id=$1`, [s7.id])).rows[0] : null;
  const ind7 = s7 ? (await owner.query(`SELECT industry FROM shops WHERE id=$1`, [s7.id])).rows[0]?.industry : null;
  const wantP = getPreset('cosmetics');
  const tokOk = th7 && th7.tokens?.['color.primary'] === wantP.tokens['color.primary'] && th7.tokens.radius === wantP.tokens.radius;
  const layOk = th7 && Array.isArray(th7.layout) && th7.layout.length === wantP.layout.length && th7.layout[0].section === 'header' && th7.layout.at(-1).section === 'footer';
  ind7 === 'cosmetics' && tokOk && layOk ? ok('industry=cosmetics → shops.industry set + themes seed ĐÚNG preset (tokens+layout)') : bad('seed theme sai', `ind=${ind7} tok=${tokOk} lay=${layOk}`);

  // 7b. không chọn ngành → industry NULL + KHÔNG seed themes (storefront về DEFAULT_LAYOUT)
  const d7b = await draft({ industry: '' });
  await req('POST', '/signup/verify', { form: { token: d7b.token, ct: ct() } });
  const s7b = await shopBySlug(d7b.slug);
  const nTh = s7b ? Number((await owner.query(`SELECT count(*)::int n FROM themes WHERE shop_id=$1`, [s7b.id])).rows[0].n) : -1;
  const ind7b = s7b ? (await owner.query(`SELECT industry FROM shops WHERE id=$1`, [s7b.id])).rows[0]?.industry : 'x';
  s7b && nTh === 0 && ind7b === null ? ok('không chọn ngành → industry NULL + KHÔNG seed themes') : bad('seed nhầm khi trống', `n=${nTh} ind=${ind7b}`);

  // 7c. enum-safe: industry RÁC → provision vẫn nguyên tử (shop tạo đủ), KHÔNG seed, KHÔNG lỗi (không vi phạm CHECK)
  const d7c = await draft({ industry: '<script>alert(1)</script>' });
  const r7c = await req('POST', '/signup/verify', { form: { token: d7c.token, ct: ct() } });
  const s7c = await shopBySlug(d7c.slug);
  const nTh7c = s7c ? Number((await owner.query(`SELECT count(*)::int n FROM themes WHERE shop_id=$1`, [s7c.id])).rows[0].n) : -1;
  const ind7c = s7c ? (await owner.query(`SELECT industry FROM shops WHERE id=$1`, [s7c.id])).rows[0]?.industry : 'x';
  r7c.status === 200 && /sẵn sàng/.test(r7c.body) && s7c && nTh7c === 0 && ind7c === null ? ok('industry rác → enum-safe NULL, provision nguyên tử, KHÔNG seed') : bad('enum-safe seed lỗi', `status=${r7c.status} shop=${!!s7c} n=${nTh7c} ind=${ind7c}`);

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
