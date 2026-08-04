// E2E worker cho self-serve signup (0091 signup-4): (1) worker gửi EMAIL verify (topic
// 'signup.verify') tới Mailpit; (2) sweep GC nháp treo → 'expired' giải phóng slug (đăng ký lại được),
// GIỮ nháp còn hạn. Sweep chạy vai app_signup (chỉ chạm shop_signups).
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';

const SU = new URL(process.env.SIGNUP_URL ?? 'http://signup:3064');
const WORKER = process.env.WORKER_URL ?? 'http://worker:3080';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://mailpit:8025';
const FORM_SECRET = process.env.SIGNUP_FORM_SECRET ?? 'dev-signup-form-secret';
const HOST = 'nentang.vn';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  PASS ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? ' :: ' + String(d).slice(0, 200) : '')); };
const sect = (m) => console.log('\n# ' + m);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ct(ageMs = 5000) { const ts = Date.now() - ageMs; return `${ts}.${crypto.createHmac('sha256', FORM_SECRET).update(String(ts)).digest('base64url').slice(0, 24)}`; }
function signupPost(form, xff) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(form).toString();
    const headers = { host: HOST, origin: `https://${HOST}`, 'x-forwarded-for': xff, 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(data) };
    const r = http.request({ hostname: SU.hostname, port: SU.port, path: '/signup', method: 'POST', headers }, (rs) => { let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => resolve({ status: rs.statusCode, body: b })); });
    r.on('error', reject); r.write(data); r.end();
  });
}
const draftForm = (over = {}) => ({ name: `Shop-${uniq()}`, slug: `w-${uniq()}`, email: `u-${uniq()}@gmail.com`, password: 'matkhau-manh-2026', plan_code: 'platform', website: '', ct: ct(), ...over });
const rndIp = () => `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const mpList = async () => (await (await fetch(`${MAILPIT}/api/v1/messages`)).json()).messages ?? [];
const mpDetail = async (id) => (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json();
async function waitEmailSubject(sub, timeout = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const h = (await mpList()).find((m) => (m.Subject ?? '').includes(sub)); if (h) return h; await sleep(400); }
  return null;
}
const sweep = async () => (await (await fetch(`${WORKER}/internal/signup-sweep`, { method: 'POST' })).json());
const statusOf = async (slug) => (await owner.query(`SELECT status FROM shop_signups WHERE lower(slug)=$1 ORDER BY created_at DESC LIMIT 1`, [slug])).rows[0]?.status ?? null;
const pendingCount = async (slug) => Number((await owner.query(`SELECT count(*)::int n FROM shop_signups WHERE lower(slug)=$1 AND status='pending'`, [slug])).rows[0].n);

async function main() {
  sect('1. Worker GỬI email verify (topic signup.verify) tới Mailpit');
  const f = draftForm();
  await signupPost(f, rndIp());
  const mail = await waitEmailSubject(f.name); // subject có tên shop (duy nhất)
  let detail = mail ? await mpDetail(mail.ID) : null;
  const linkOk = detail && /verify\?token=/.test((detail.Text ?? '') + (detail.HTML ?? ''));
  mail && /Kích hoạt/.test(mail.Subject) && linkOk ? ok('email "Kích hoạt cửa hàng…" gửi tới Mailpit + có link verify') : bad('không gửi được email verify', mail?.Subject);

  sect('2. Sweep: nháp quá hạn → expired → GIẢI PHÓNG slug (đăng ký lại được)');
  const g = draftForm();
  await signupPost(g, rndIp());
  (await pendingCount(g.slug)) === 1 ? ok('nháp pending tạo ra') : bad('không có nháp');
  // Lùi hạn về quá khứ → sweep phải expire.
  await owner.query(`UPDATE shop_signups SET expires_at = now() - interval '1 minute' WHERE lower(slug)=$1`, [g.slug]);
  const r = await sweep();
  const st = await statusOf(g.slug);
  // ĐO TRẠNG THÁI, KHÔNG đo số trả về của MỘT lượt gọi. Worker còn một hẹn giờ 5 phút chạy
  // CHÍNH hàm này; nếu nó kịp xử lý trước thì lượt gọi tay đếm được 0 dù mọi thứ đúng hoàn
  // toàn. Đã đỏ GIẢ đúng như thế trong một lượt CI đầy đủ: log ghi `{"expired":0} st=expired`
  // — tức bản ghi ĐÃ hết hạn đúng, chỉ là do người khác làm.
  // Nới thế này KHÔNG che được lỗi thật: nếu quét hỏng thì hẹn giờ cũng hỏng (cùng một hàm),
  // st sẽ đứng ở 'pending' và khẳng định vẫn đỏ.
  st === 'expired'
    ? ok(`nháp quá hạn → status='expired' (lượt gọi tay đếm ${typeof r?.expired === 'number' ? r.expired : '?'}; hẹn giờ 5' có thể đã làm trước)`)
    : bad('nháp quá hạn KHÔNG chuyển expired', `${JSON.stringify(r)} st=${st}`);
  // slug đã giải phóng → đăng ký lại slug đó thành công (nháp pending MỚI).
  await signupPost(draftForm({ slug: g.slug }), rndIp());
  (await pendingCount(g.slug)) === 1 ? ok('slug giải phóng → đăng ký lại được (1 nháp pending mới)') : bad('slug chưa giải phóng', await pendingCount(g.slug));

  sect('3. Sweep GIỮ nháp còn hạn (không quét mù)');
  const h = draftForm();
  await signupPost(h, rndIp());
  await sweep();
  (await statusOf(h.slug)) === 'pending' ? ok('nháp còn hạn vẫn pending sau sweep') : bad('sweep quét cả nháp còn hạn');

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
