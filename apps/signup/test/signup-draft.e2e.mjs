// E2E self-serve signup (0091 signup-2) — POST /signup CHỈ ghi NHÁP (verify-trước-provision) +
// lớp chống lạm dụng. Kiểm: form no-JS; nháp+outbox verify tạo ra mà KHÔNG đẻ shop/user/subscription;
// enum-safe (email đã tồn tại → phản hồi trung tính + vẫn tạo nháp); honeypot/timing/disposable → nuốt;
// slug denylist/taken/format → surface; trần per-IP đếm dưới advisory-lock nuốt request thứ N+1.
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';

const SU = new URL(process.env.SIGNUP_URL ?? 'http://signup:3064');
const FORM_SECRET = process.env.SIGNUP_FORM_SECRET ?? 'dev-signup-form-secret';
const HOST = 'nentang.vn';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  PASS ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? ' :: ' + String(d).slice(0, 200) : '')); };
const sect = (m) => console.log('\n# ' + m);
const uniq = () => Math.random().toString(36).slice(2, 10);

// ct hợp lệ với "tuổi" ageMs (mặc định 5s > sàn 2s để KHÔNG bị coi là bot).
function ct(ageMs = 5000) {
  const ts = Date.now() - ageMs;
  const sig = crypto.createHmac('sha256', FORM_SECRET).update(String(ts)).digest('base64url').slice(0, 24);
  return `${ts}.${sig}`;
}
function req(method, path, { form, xff = '203.0.113.1', origin = `https://${HOST}` } = {}) {
  return new Promise((resolve, reject) => {
    const data = form !== undefined ? new URLSearchParams(form).toString() : null;
    const headers = { host: HOST, 'x-forwarded-for': xff };
    if (origin) headers.origin = origin;
    if (data != null) { headers['content-type'] = 'application/x-www-form-urlencoded'; headers['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ hostname: SU.hostname, port: SU.port, path, method, headers }, (rs) => {
      let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch {} resolve({ status: rs.statusCode, body: b, json: j, csp: rs.headers['content-security-policy'] }); });
    });
    r.on('error', reject); if (data != null) r.write(data); r.end();
  });
}
// Đơn đăng ký hợp lệ (override tuỳ ca). Mỗi ca IP + slug + email RIÊNG để cô lập trần-IP.
const goodForm = (over = {}) => ({ name: 'Nhà Xinh', slug: `sg-${uniq()}`, email: `u-${uniq()}@gmail.com`, password: 'matkhau-manh-2026', plan_code: 'platform', website: '', ct: ct(), ...over });
const draftCount = async (slug) => Number((await owner.query(`SELECT count(*)::int n FROM shop_signups WHERE lower(slug)=$1 AND status='pending'`, [slug])).rows[0].n);
const outboxOf = async (email) => (await owner.query(`SELECT payload FROM outbox WHERE topic='signup.verify' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email])).rows[0]?.payload ?? null;

async function main() {
  sect('1. GET /signup — form no-JS + CSP nghiêm');
  let r = await req('GET', '/signup');
  r.status === 200 && /name="slug"/.test(r.body) && /name="plan_code"/.test(r.body) && /class="hp"/.test(r.body)
    && /default-src 'none'/.test(r.csp) && !/script-src/.test(r.csp)
    ? ok('form có slug/plan/honeypot/ct + CSP default-src none KHÔNG script') : bad('form/CSP sai', r.csp);

  sect('2. POST hợp lệ → NHÁP + outbox verify, KHÔNG đẻ shop/user/subscription');
  const g = goodForm();
  r = await req('POST', '/signup', { form: g, xff: '203.0.113.11' });
  const neutral = r.status === 200 && /Kiểm tra email/.test(r.body);
  const drafts = await draftCount(g.slug);
  const ob = await outboxOf(g.email);
  const noShop = Number((await owner.query(`SELECT count(*)::int n FROM shops WHERE lower(slug)=$1`, [g.slug])).rows[0].n) === 0;
  const noUser = Number((await owner.query(`SELECT count(*)::int n FROM users WHERE email=$1`, [g.email])).rows[0].n) === 0;
  neutral && drafts === 1 && ob?.link?.includes('verify?token=') && noShop && noUser
    ? ok('nháp pending=1 + outbox verify có token; KHÔNG shop/user (verify-trước-provision)') : bad('draft/provision sai', `neutral=${neutral} drafts=${drafts} ob=${!!ob} noShop=${noShop} noUser=${noUser}`);

  sect('3. Enum-safe: email ĐÃ tồn tại → phản hồi trung tính + vẫn tạo nháp (không rẽ nhánh)');
  const exEmail = `exists-${uniq()}@gmail.com`;
  await owner.query(`INSERT INTO users (email,password_hash) VALUES ($1,'H')`, [exEmail]);
  const g2 = goodForm({ email: exEmail });
  r = await req('POST', '/signup', { form: g2, xff: '203.0.113.12' });
  r.status === 200 && /Kiểm tra email/.test(r.body) && (await draftCount(g2.slug)) === 1
    ? ok('email tồn tại → 200 trung tính (KHÔNG "email đã dùng") + nháp vẫn tạo') : bad('rò tồn tại email', `${r.status} ${r.body.slice(0, 80)}`);

  sect('4. Nuốt im lặng: honeypot / timing / email dùng-một-lần → trung tính KHÔNG nháp');
  const hp = goodForm({ website: 'http://bot.com' });
  r = await req('POST', '/signup', { form: hp, xff: '203.0.113.13' });
  r.status === 200 && /Kiểm tra email/.test(r.body) && (await draftCount(hp.slug)) === 0 ? ok('honeypot → nuốt (không nháp)') : bad('honeypot không nuốt', await draftCount(hp.slug));
  const fast = goodForm({ ct: ct(0) }); // form-ts tuổi ~0 < 2s = bot
  r = await req('POST', '/signup', { form: fast, xff: '203.0.113.14' });
  r.status === 200 && (await draftCount(fast.slug)) === 0 ? ok('timing quá nhanh → nuốt') : bad('timing không nuốt');
  const dispo = goodForm({ email: `x-${uniq()}@mailinator.com` });
  r = await req('POST', '/signup', { form: dispo, xff: '203.0.113.15' });
  r.status === 200 && (await draftCount(dispo.slug)) === 0 ? ok('email dùng-một-lần → nuốt') : bad('disposable không nuốt');

  sect('5. Surface lỗi CLIENT-DERIVABLE: slug denylist / taken / format');
  r = await req('POST', '/signup', { form: goodForm({ slug: 'admin' }), xff: '203.0.113.16' });
  r.status === 400 && /không sử dụng được/.test(r.body) ? ok('slug dành riêng (admin) → surface') : bad('denylist không chặn', r.status);
  // slug trùng shop đang có
  const takenSlug = `taken-${uniq()}`;
  await owner.query(`INSERT INTO shops (slug,name,status) VALUES ($1,'S','active')`, [takenSlug]);
  r = await req('POST', '/signup', { form: goodForm({ slug: takenSlug }), xff: '203.0.113.17' });
  r.status === 400 && /đã có người dùng/.test(r.body) ? ok('slug trùng shop → surface "đã có người dùng"') : bad('slug taken không chặn', r.status);
  r = await req('POST', '/signup', { form: goodForm({ slug: 'UP_case!' }), xff: '203.0.113.18' });
  r.status === 400 && /chữ thường/.test(r.body) ? ok('slug sai định dạng → surface') : bad('format không chặn', r.status);

  sect('6. check-slug NHỊ PHÂN (gộp mọi lý do bận)');
  r = await req('GET', `/signup/check-slug?slug=${takenSlug}`);
  const c1 = r.json?.available === false;
  r = await req('GET', `/signup/check-slug?slug=admin`);
  const c2 = r.json?.available === false;
  r = await req('GET', `/signup/check-slug?slug=free-${uniq()}`);
  const c3 = r.json?.available === true;
  c1 && c2 && c3 ? ok('check-slug: taken=false, denylist=false, free=true') : bad('check-slug sai', `${c1} ${c2} ${c3}`);

  sect('7. Trần per-IP (advisory-lock, độc lập Redis): request thứ 6 cùng IP → nuốt');
  const capIp = '198.51.100.77';
  let lastSlug;
  for (let i = 0; i < 6; i++) { const gf = goodForm(); lastSlug = gf.slug; await req('POST', '/signup', { form: gf, xff: capIp }); }
  // 5 đầu tạo nháp; nháp thứ 6 (lastSlug) bị nuốt vì đã đủ trần.
  (await draftCount(lastSlug)) === 0 ? ok('nháp thứ 6 cùng IP bị nuốt (trần 5/giờ)') : bad('trần IP không chặn', await draftCount(lastSlug));

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
