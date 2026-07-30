/**
 * Dịch vụ SELF-SERVE SIGNUP (0091) — người dùng TỰ đăng ký → tự cấp phát shop. Global (KHÔNG
 * per-shop), chạy trên domain marketing (nentang.vn/signup*). Vai DB app_signup (least-priv, 0091).
 * no-framework, no-JS SSR, CSP nghiêm.
 *
 * BẤT BIẾN CHỐNG LẠM DỤNG (signup-2): VERIFY-TRƯỚC-PROVISION — POST /signup CHỈ ghi 1 nháp
 * shop_signups (pending) + token + outbox verify (shop_id NULL). KHÔNG tạo shop/user THẬT ở đây →
 * bot POST không đẻ shop bán-được. Provision (shop+user+membership) chỉ chạy khi verify (signup-3).
 *
 * ENUM-SAFE: POST /signup LUÔN trả trang "kiểm tra email" trung tính (email mới / đã tồn tại / bị
 * nuốt đều GIỐNG). Chỉ lỗi CLIENT-DERIVABLE (định dạng slug/email/mật khẩu/gói, slug bận-công-khai)
 * mới surface. Hash Argon2 VÔ ĐIỀU KIỆN (sàn timing). Bot (honeypot/timing) · email dùng-một-lần ·
 * vượt trần → nuốt im lặng. Trần per-IP ĐẾM DƯỚI advisory-lock (độc lập Redis).
 */
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import Redis from 'ioredis';
import { hashPassword } from '../../../packages/auth/src/password.js';
import { generateToken } from '../../../packages/auth/src/tokens.js';
import { hit } from '../../../packages/auth/src/ratelimit.js';
import { passwordError } from '../../../packages/auth/src/password-policy.js';
import { send, sendHtml, readForm, sameOrigin, clientIp } from './http.js';
import * as V from './views.js';
import { isSlugDenied, isDisposableEmail } from './denylist.js';
import { getPreset, FALLBACK_PRESET } from '../../../packages/presets/src/index.js';

const PORT = Number(process.env.PORT ?? 3064);
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? 'nentang.vn';
// Origin CÔNG KHAI cho link trong email/trang (mặc định suy từ PLATFORM_DOMAIN = prod đúng).
// Dev override để link kèm cổng/host thật (Caddy dev map 8443, admin ở host riêng) → bấm là vào.
const PUBLIC_ORIGIN = process.env.SIGNUP_PUBLIC_ORIGIN ?? `https://${PLATFORM_DOMAIN}`;        // site đăng ký (verify link)
const ADMIN_LOGIN_URL = process.env.ADMIN_PUBLIC_ORIGIN ?? `https://admin.${PLATFORM_DOMAIN}`; // origin admin (đăng nhập)
const TRIAL_DAYS = Math.max(0, Number(process.env.TRIAL_DAYS ?? 14) || 0); // đồng bộ platform/0056
const DRAFT_TTL_MIN = Number(process.env.SIGNUP_DRAFT_TTL_MIN ?? 30);
const SIGNUP_IP_CAP = Number(process.env.SIGNUP_IP_CAP ?? 5);       // trần nháp/IP/giờ (sàn DB)
const SIGNUP_RL_LIMIT = Number(process.env.SIGNUP_RL_LIMIT ?? 20);  // lớp đầu Redis/IP/giờ
const SLUGCHECK_RL = Number(process.env.SIGNUP_SLUGCHECK_RL ?? 60); // check-slug/IP/phút
const FORM_MIN_MS = Number(process.env.SIGNUP_FORM_MIN_MS ?? 2000); // < 2s = bot
const IP_PEPPER = process.env.IP_PEPPER ?? 'dev-ip-pepper';
const FORM_SECRET = process.env.SIGNUP_FORM_SECRET ?? 'dev-signup-form-secret';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379', { maxRetriesPerRequest: 2, lazyConnect: false });
redis.on('error', () => {}); // fail-open (advisory-lock DB là sàn thật)

const log = (level, event, extra = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level, service: 'signup', event, ...extra }));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ipHash = (ip) => crypto.createHmac('sha256', IP_PEPPER).update('sip:' + (ip ?? '')).digest('hex');
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/; // dns-safe, ≤ 40 (khớp platform)
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Hash "mồi" để timing đều (song song apps/account). Không dùng trực tiếp nhưng giữ threadpool nóng.
hashPassword('dummy-' + generateToken()).catch(() => {});

// ── form-ts HMAC (chống bot POST-thẳng + timing) ─────────────────────────────
const formSig = (ts) => crypto.createHmac('sha256', FORM_SECRET).update(String(ts)).digest('base64url').slice(0, 24);
const issueFormTs = () => { const ts = Date.now(); return `${ts}.${formSig(ts)}`; };
function checkFormTs(ct) {
  const [tsRaw, sig] = String(ct ?? '').split('.');
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || !sig || formSig(ts) !== sig) return { ok: false, ageMs: 0 };
  return { ok: true, ageMs: Date.now() - ts };
}

// ── DB ───────────────────────────────────────────────────────────────────────
async function withSignupTx(fn) {
  const c = await db.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
const loadPlans = () => db.query(`SELECT code, name, price_vnd_month FROM plans WHERE active ORDER BY price_vnd_month`).then((r) => r.rows).catch(() => []);
// slug còn trống? (shop đang có + subdomain + nháp pending). Gọi DƯỚI advisory-lock lúc ghi.
async function slugFree(c, slug) {
  const host = `${slug}.${PLATFORM_DOMAIN}`;
  const { rows } = await c.query(
    `SELECT NOT EXISTS(SELECT 1 FROM shops WHERE lower(slug)=$1)
        AND NOT EXISTS(SELECT 1 FROM domains WHERE lower(hostname)=$2)
        AND NOT EXISTS(SELECT 1 FROM shop_signups WHERE lower(slug)=$1 AND status='pending' AND expires_at>now()) AS free`,
    [slug, host]);
  return rows[0].free;
}
const verifyLink = (token) => `${PUBLIC_ORIGIN}/signup/verify?token=${token}`;

// ── handlers ───────────────────────────────────────────────────────────────
async function pageSignup(req, res) {
  const plans = await loadPlans();
  return sendHtml(res, 200, V.renderSignupForm(plans, { ct: issueFormTs(), domain: PLATFORM_DOMAIN, adminUrl: ADMIN_LOGIN_URL }));
}

async function doSignup(req, res) {
  if (!sameOrigin(req)) return send(res, 403, { error: 'origin' });
  const f = await readForm(req);
  const email = String(f.email ?? '').trim().toLowerCase();
  const password = String(f.password ?? '');
  const slug = String(f.slug ?? '').trim().toLowerCase();
  const name = String(f.name ?? '').trim().slice(0, 200);
  const planCode = String(f.plan_code ?? '').trim();
  // Ngành hàng ENUM-SAFE: hợp lệ KHI VÀ CHỈ KHI có preset (nguồn chân lý = packages/presets).
  // Giá trị lạ / rỗng / 'other' → null → KHÔNG seed theme → storefront về DEFAULT_LAYOUT (không lỗi).
  const indRaw = String(f.industry ?? '').trim().toLowerCase();
  const industry = getPreset(indRaw) ? indRaw : null;
  const iph = ipHash(clientIp(req));
  const plans = await loadPlans();
  const keep = { name, slug, email, plan_code: planCode, industry };
  const reForm = (msg, status = 400) => sendHtml(res, status, V.renderSignupForm(plans, { error: msg, f: keep, ct: issueFormTs(), domain: PLATFORM_DOMAIN, adminUrl: ADMIN_LOGIN_URL }));

  // Lỗi CLIENT-DERIVABLE (surface — về CHÍNH input người dùng, không rò gì riêng tư).
  if (!SLUG_RE.test(slug)) return reForm('Địa chỉ cửa hàng chỉ gồm chữ thường, số, gạch ngang (2–40 ký tự).');
  if (name.length < 1) return reForm('Vui lòng nhập tên cửa hàng.');
  if (!EMAIL_RE.test(email)) return reForm('Email không hợp lệ.');
  const pwErr = passwordError(password, { shopName: name });
  if (pwErr) return reForm(pwErr[0].toUpperCase() + pwErr.slice(1) + '.');
  if (!plans.some((p) => p.code === planCode)) return reForm('Vui lòng chọn gói dịch vụ.');
  if (isSlugDenied(slug)) return reForm('Địa chỉ này không sử dụng được, vui lòng chọn tên khác.');

  // Hash VÔ ĐIỀU KIỆN (sàn timing) — cả nhánh nuốt dưới đây cũng đã tốn ~1 Argon2.
  const hash = await hashPassword(password);

  // Redis lớp đầu (fail-open) + tín hiệu bot. NUỐT-IM-LẶNG (trả trang trung tính, KHÔNG tạo nháp):
  // bot(honeypot/timing) · email dùng-một-lần · vượt trần Redis. → chống dò email + farm trial.
  const rl = await hit(redis, `rl:signup:ip:${iph}`, { limit: SIGNUP_RL_LIMIT, windowSec: 3600 }).catch(() => ({ allowed: true }));
  const ts = checkFormTs(f.ct);
  // LÝ DO nuốt — ghi log phía SERVER, KHÔNG lộ ra client (trang trả về vẫn y hệt mọi trường
  // hợp, enum-safe nguyên vẹn). Trước đây mọi lý do gộp thành một biến boolean, nên chặn nhầm
  // người thật là VÔ HÌNH tuyệt đối: không log, không phiếu hỗ trợ, không dấu vết. Đã trả giá
  // một lần với danh sách cấm slug (4cfc637) — chỉ lộ ra vì một bộ e2e đỏ chập chờn.
  const swallowReason = Boolean(f.website) ? 'honeypot'
    : !ts.ok ? 'form_ts_sai'
    : ts.ageMs < FORM_MIN_MS ? 'gui_qua_nhanh'
    : isDisposableEmail(email) ? 'email_dung_mot_lan'
    : !rl.allowed ? 'tran_redis_ip'
    : null;
  const swallow = swallowReason !== null;

  const token = generateToken();
  try {
    await withSignupTx(async (c) => {
      // Trần per-IP ĐẾM DƯỚI advisory-lock (sàn độc lập Redis). Serialize ip→slug (thứ tự nhất quán, không deadlock).
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('signup-ip:'||$1, 0))`, [iph]);
      const nRecent = Number((await c.query(
        `SELECT count(*)::int n FROM shop_signups WHERE ip_hash=$1 AND created_at > now() - interval '1 hour'`, [iph])).rows[0].n);
      if (swallow || nRecent >= SIGNUP_IP_CAP) {
        // Log KHÔNG chứa email/IP thô (PII) — chỉ lý do + tuổi form, đủ để đếm và đặt cảnh báo.
        const why = swallowReason ?? 'tran_ip_gio';
        log('warn', 'signup_swallowed', { reason: why, ageMs: ts.ageMs });
        // Đếm sang Redis để worker gom lại thành CẢNH BÁO (log không ai đọc thì cũng như không
        // ghi). Khoá sống 1 giờ ⇒ giá trị đọc được là "số lần nuốt trong ~1 giờ qua".
        // FAIL-OPEN tuyệt đối: Redis chết KHÔNG được làm hỏng đường đăng ký.
        try {
          const k = `swallow:${why}`;
          if (await redis.incr(k) === 1) await redis.expire(k, 3600);
        } catch { /* bỏ qua: đếm được thì tốt, không đếm được cũng không chặn ai */ }
        return; // nuốt: không ghi gì vào DB
      }
      // Reserve slug NGUYÊN TỬ (cùng key ở provision signup-3/4).
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('signup-slug:'||$1, 0))`, [slug]);
      if (!(await slugFree(c, slug))) throw Object.assign(new Error('slug taken'), { code: 'SLUG_TAKEN' });
      await c.query(
        `INSERT INTO shop_signups (email, password_hash, slug, name, plan_code, industry, token_hash, ip_hash, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9 || ' minutes')::interval)`,
        [email, hash, slug, name, planCode, industry, sha256(token), iph, String(DRAFT_TTL_MIN)]);
      await c.query(`INSERT INTO outbox (shop_id, topic, payload) VALUES (NULL, 'signup.verify', $1)`,
        [{ to: email, name, slug, link: verifyLink(token) }]);
      log('info', 'signup_draft', {}); // KHÔNG log email/slug (PII/enum)
    });
  } catch (e) {
    if (e && e.code === 'SLUG_TAKEN') return reForm('Địa chỉ này đã có người dùng, vui lòng chọn tên khác.');
    if (!e || e.code !== '23505') throw e; // 23505 (đua slug pending) → nuốt trung tính (người kia thắng)
  }
  return sendHtml(res, 200, V.renderSignupDone(email));
}

// Kiểm khả-dụng slug — NHỊ PHÂN (available/unavailable), gộp MỌI lý do bận (denylist/shop/domain/nháp)
// → không thành kênh liệt kê. Rate-limit riêng. JSON cho lớp JS tương lai / kiểm tay.
async function checkSlug(req, res, q) {
  const iph = ipHash(clientIp(req));
  const rl = await hit(redis, `rl:slugcheck:ip:${iph}`, { limit: SLUGCHECK_RL, windowSec: 60 }).catch(() => ({ allowed: true }));
  if (!rl.allowed) return send(res, 429, { available: false });
  const slug = String(q.get('slug') ?? '').trim().toLowerCase();
  if (!SLUG_RE.test(slug) || isSlugDenied(slug)) return send(res, 200, { available: false });
  const free = await withSignupTx((c) => slugFree(c, slug)).catch(() => false);
  return send(res, 200, { available: free });
}

// ── VERIFY + PROVISION (signup-3) — nguyên tử 1-tx ──────────────────────────
// GET verify: CHỈ hiển thị trang xác nhận (KHÔNG side-effect) → prefetch/quét-link email không
// provision. Provision chỉ khi POST (bấm nút) + sameOrigin.
async function pageVerify(req, res, q) {
  const token = String(q.get('token') ?? '');
  const d = token ? (await db.query(
    `SELECT name, slug FROM shop_signups WHERE token_hash=$1 AND status='pending' AND expires_at>now()`,
    [sha256(token)]).then((r) => r.rows[0]).catch(() => null)) : null;
  if (!d) return sendHtml(res, 200, V.renderVerifyInvalid(PLATFORM_DOMAIN));
  return sendHtml(res, 200, V.renderVerifyConfirm(d.name, d.slug, token, issueFormTs(), PLATFORM_DOMAIN));
}

async function doVerify(req, res) {
  if (!sameOrigin(req)) return send(res, 403, { error: 'origin' });
  const f = await readForm(req);
  const token = String(f.token ?? '');
  if (!token) return sendHtml(res, 200, V.renderVerifyInvalid(PLATFORM_DOMAIN));
  let out;
  try {
    out = await withSignupTx(async (c) => {
      // CLAIM-FIRST atomic: pending→provisioned dưới khoá dòng → 2 verify song song CHỈ 1 thắng
      // (cái kia thấy status đã đổi → 0 dòng → trung tính). Token 1-lần. Tx fail → status hoàn nguyên.
      const d = (await c.query(
        `UPDATE shop_signups SET status='provisioned'
          WHERE token_hash=$1 AND status='pending' AND expires_at>now()
          RETURNING id, email, password_hash, slug, name, plan_code, locale, currency, timezone, industry`,
        [sha256(token)])).rows[0];
      if (!d) return { kind: 'invalid' };
      // Reserve slug (CÙNG key draft) + tái kiểm (slug có thể bị admin lấy giữa chừng, hiếm).
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('signup-slug:'||$1, 0))`, [d.slug]);
      if (!(await slugFree(c, d.slug))) throw Object.assign(new Error('slug taken'), { code: 'SLUG_TAKEN' });
      // OWNER = user nội sinh (mẫu acceptInvitation 0020, 3 nhánh). shop_id/user_id LUÔN server-derived.
      const ex = (await c.query(`SELECT id, email_verified_at FROM users WHERE email=$1`, [d.email])).rows[0];
      let userId;
      if (!ex) { // (a) email mới → tạo user đã-xác-minh (token chứng minh email)
        userId = (await c.query(`INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1,$2,now()) RETURNING id`, [d.email, d.password_hash])).rows[0].id;
      } else if (ex.email_verified_at === null) { // (b) user chưa-verify (kẻ chiếm trước) → CLAIM
        userId = ex.id;
        await c.query(`UPDATE users SET password_hash=$1, email_verified_at=now(), mfa_enabled=false WHERE id=$2`, [d.password_hash, userId]);
        await c.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [userId]);
      } else { // (c) email ĐÃ verify (chủ hợp lệ) → self-serve KHÔNG có phiên → 403 login_required
        throw Object.assign(new Error('login required'), { code: 'LOGIN_REQUIRED' });
      }
      // Provision shop (mirror platform createShop:145-169; invariant current_period_end cưỡng chế CHECK 0091).
      const shopId = (await c.query(
        // contact_email = CHÍNH email vừa xác minh. Trước đây bỏ trống, và hậu quả không nằm ở
        // đây mà ở nơi khác: cảnh báo SẮP HẾT HÀNG lọc `WHERE s.contact_email IS NOT NULL`, nên
        // nó chưa từng tới được MỘT shop self-serve nào — tính năng làm xong mà im lặng không
        // chạy. Ta đang giữ sẵn địa chỉ đã xác minh trong tay, không có lý do gì để trống.
        // Người bán vẫn đổi được ở phần Cài đặt.
        `INSERT INTO shops (slug, name, status, locale, currency, timezone, created_via, industry, contact_email)
         VALUES ($1,$2,'onboarding',$3,$4,$5,'self_serve',$6,$7) RETURNING id`,
        [d.slug, d.name, d.locale, d.currency, d.timezone, d.industry, d.email])).rows[0].id;
      await c.query(`INSERT INTO domains (shop_id, hostname, verification_token, verified_at, is_primary) VALUES ($1,$2,$3,now(),true)`,
        [shopId, `${d.slug}.${PLATFORM_DOMAIN}`, generateToken()]);
      await c.query(`INSERT INTO subscriptions (shop_id, plan_code, status, current_period_end) VALUES ($1,$2,'trial', now() + ($3 || ' days')::interval)`,
        [shopId, d.plan_code, String(TRIAL_DAYS)]);
      await c.query(`INSERT INTO memberships (shop_id, user_id, role) VALUES ($1,$2,'owner')`, [shopId, userId]);
      await c.query(`INSERT INTO audit_logs (shop_id, actor_type, actor_id, action, metadata) VALUES ($1,'system',NULL,'shop.created',$2)`,
        [shopId, { slug: d.slug, plan_code: d.plan_code, created_via: 'self_serve', industry: d.industry }]);
      // Seed THEME theo ngành (0094): shop MỚI chưa có row themes → INSERT TRẦN (KHÔNG ON CONFLICT —
      // app_signup chỉ có INSERT, ON CONFLICT cần SELECT → permission denied, đã kiểm RLS). industry
      // đã enum-safe (chỉ nhận slug có preset). layout là MẢNG → BẮT BUỘC JSON.stringify (node-pg ép
      // mảng thành array-literal, không phải jsonb). Không chọn ngành → không seed → DEFAULT_LAYOUT.
      // MỌI shop đều có theme (0115). Không chọn ngành / chọn giá trị lạ → rơi về
      // preset 'general'. Trước đây nhánh đó không seed gì, storefront về
      // DEFAULT_LAYOUT 5 khối — cả một nhóm shop nhận bố cục cũ.
      //
      // LƯU Ý: chỉ THEME rơi về general, `shops.industry` vẫn NULL. Cột đó ghi
      // "họ nói gì", không phải "ta đoán gì".
      const themeSlug = getPreset(d.industry) ? d.industry : FALLBACK_PRESET;
      const preset = getPreset(themeSlug);
      await c.query(`INSERT INTO themes (shop_id, tokens, layout) VALUES ($1,$2,$3)`,
        [shopId, JSON.stringify(preset.tokens), JSON.stringify(preset.layout)]);
      // Banner mặc định (0114): preset seed hero.slides RỖNG, mà hero_side và
      // promo_banners chỉ render khi có slide → shop mới hiện 3 khối thay vì 12.
      // Worker vẽ bộ banner đầu tiên theo palette vừa seed.
      //
      // shop_id để NULL và mang id trong payload: policy signup_outbox_ins ràng
      // WITH CHECK (shop_id IS NULL) — app_signup CỐ Ý không được phát sự kiện
      // gắn tenant. Cùng lối với 'signup.verify'. Cùng transaction (ADR-006).
      await c.query(`INSERT INTO outbox (shop_id, topic, payload) VALUES (NULL, 'shop.banners_seed', $1)`,
        [{ shop_id: shopId, industry: themeSlug }]);
      await c.query(`UPDATE shop_signups SET provisioned_shop_id=$1 WHERE id=$2`, [shopId, d.id]);
      return { kind: 'ok', name: d.name, slug: d.slug };
    });
  } catch (e) {
    if (e && e.code === 'LOGIN_REQUIRED') return sendHtml(res, 200, V.renderVerifyLoginRequired(PLATFORM_DOMAIN, ADMIN_LOGIN_URL));
    if (e && (e.code === 'SLUG_TAKEN' || e.code === '23505')) return sendHtml(res, 409, V.renderVerifySlugTaken(PLATFORM_DOMAIN));
    throw e;
  }
  if (out.kind === 'invalid') return sendHtml(res, 200, V.renderVerifyInvalid(PLATFORM_DOMAIN));
  log('info', 'shop_provisioned', {}); // KHÔNG log slug/email (PII). KHÔNG auto-login (parity).
  return sendHtml(res, 200, V.renderVerifyDone(out.name, out.slug, PLATFORM_DOMAIN, ADMIN_LOGIN_URL));
}

// ── router ───────────────────────────────────────────────────────────────────
const ROUTES = [
  { m: 'GET', re: /^\/signup\/?$/, fn: pageSignup },
  { m: 'POST', re: /^\/signup$/, fn: doSignup },
  { m: 'GET', re: /^\/signup\/check-slug$/, fn: checkSlug },
  { m: 'GET', re: /^\/signup\/verify$/, fn: pageVerify },
  { m: 'POST', re: /^\/signup\/verify$/, fn: doVerify },
];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    let route, m;
    for (const r of ROUTES) { if (r.m === req.method && (m = r.re.exec(url.pathname))) { route = r; break; } }
    if (!route) return sendHtml(res, 404, '<!doctype html><meta charset=utf-8><title>404</title><p>Không tìm thấy trang.</p>');
    return await route.fn(req, res, url.searchParams, m.slice(1));
  } catch (e) {
    log('error', 'handler_error', { message: e.message, path: req.url });
    if (!res.headersSent) return send(res, 500, { error: 'lỗi hệ thống' });
    res.end();
  }
});
server.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT }));
