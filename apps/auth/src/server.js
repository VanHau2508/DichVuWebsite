/**
 * Dịch vụ auth. Băm mật khẩu (Argon2id), phiên server-side, MFA (TOTP),
 * đặt lại mật khẩu, rate limit đăng nhập.
 *
 * Nguyên tắc bảo mật (mỗi cái có test tương ứng ở e2e / dbtest):
 *   - Mật khẩu băm Argon2id, không bao giờ log/trả về.
 *   - Token phiên/reset chỉ lưu HASH; token thô chỉ tồn tại trong cookie/email.
 *   - Secret TOTP mã hoá AES-256-GCM bằng khoá ngoài DB.
 *   - Thông báo lỗi đăng nhập/quên mật khẩu KHÔNG tiết lộ email có tồn tại không.
 *   - Rate limit theo IP và theo tài khoản.
 *   - Cookie __Host-session: Secure, HttpOnly, SameSite=Lax.
 *   - Mutation phải có Origin hợp lệ (chống CSRF).
 *   - Chống replay TOTP bằng last_counter.
 */

import http from 'node:http';
import pg from 'pg';
import Redis from 'ioredis';

import { hashPassword, verifyPassword } from '../../../packages/auth/src/password.js';
import { totp, verifyTotp } from '../../../packages/auth/src/totp.js';
import { base32Encode, base32Decode } from '../../../packages/auth/src/base32.js';
import { otpauthURL } from '../../../packages/auth/src/totp.js';
import { seal, open } from '../../../packages/auth/src/secretbox.js';
import { generateToken, hashToken, generateRecoveryCode } from '../../../packages/auth/src/tokens.js';
import { hit, reset as resetRate } from '../../../packages/auth/src/ratelimit.js';
import crypto from 'node:crypto';

import {
  readJson,
  send,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  originAllowed,
  clientIp,
  SESSION_COOKIE,
} from './http.js';

const PORT = Number(process.env.PORT ?? 3020);
const MFA_ENC_KEY = process.env.MFA_ENC_KEY;
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS ?? 168) * 3600_000;
const CHALLENGE_TTL_MS = 10 * 60_000; // phiên nửa vời (chờ MFA) sống ngắn
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const ISSUER = 'nentang';

// Chỉ dùng cho e2e: lưu token đặt lại mật khẩu vào Redis để test lấy được.
//
// KHÔNG gate bằng `NODE_ENV !== 'production'`. Gate như vậy là FAIL-OPEN: môi
// trường nào quên set NODE_ENV (rất thường gặp) sẽ tự động bật tính năng rò
// token. Cờ này phải được BẬT TƯỜNG MINH, mặc định tắt.
const DEV_RESET_TOKEN_STASH = process.env.DEV_RESET_TOKEN_STASH === '1';

if (!MFA_ENC_KEY) throw new Error('thiếu MFA_ENC_KEY');

// Hai cờ nguy hiểm không bao giờ được cùng tồn tại với production.
// Thà không khởi động còn hơn chạy production mà âm thầm rò token đặt lại mật khẩu.
if (DEV_RESET_TOKEN_STASH && process.env.APP_ENV === 'production') {
  throw new Error('DEV_RESET_TOKEN_STASH bật ở production — từ chối khởi động');
}
if (ALLOWED_ORIGINS.length === 0) {
  throw new Error('thiếu ALLOWED_ORIGINS — mọi request đổi trạng thái sẽ bị từ chối');
}

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
// enableOfflineQueue:false + commandTimeout: khi Redis DOWN, lệnh REJECT NHANH
// thay vì xếp hàng chờ reconnect (treo). hit() bắt lỗi → fail-open, login vẫn chạy.
const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  commandTimeout: 1000,
});
redis.on('error', () => {}); // nuốt sự kiện error (đã xử lý fail-open ở hit/reset)

function log(level, event, fields = {}) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }) + '\n');
}

// ── audit ────────────────────────────────────────────────────────────────────
async function audit(action, { userId = null, ip = null, ua = null, metadata = null } = {}) {
  // shop_id NULL: sự kiện cấp identity. Policy auth_audit chỉ cho phép NULL.
  await db
    .query(
      `INSERT INTO audit_logs (shop_id, actor_type, actor_id, action, ip, user_agent, metadata)
       VALUES (NULL, 'user', $1, $2, $3, $4, $5)`,
      [userId, action, ip, ua, metadata],
    )
    .catch((err) => log('error', 'audit_failed', { action, message: err.message }));
}

// ── validation ───────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validEmail(x) {
  return typeof x === 'string' && x.length <= 254 && EMAIL_RE.test(x);
}
function validPassword(x) {
  // Tối thiểu 10 ký tự. Không áp luật phức tạp rối rắm (NIST khuyến nghị độ dài).
  return typeof x === 'string' && x.length >= 10 && x.length <= 1024;
}

// ── session ──────────────────────────────────────────────────────────────────
async function createSession(userId, { mfaSatisfied, ip, ua, ttlMs }) {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, mfa_satisfied, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, tokenHash, mfaSatisfied, expiresAt, ip, ua],
  );
  return { token, expiresAt };
}

/** Trả về {session, user} nếu token hợp lệ và chưa hết hạn/thu hồi; ngược lại null. */
async function loadSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT s.id, s.user_id, s.mfa_satisfied, s.expires_at, s.stepped_up_at,
            u.email, u.status, u.mfa_enabled
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [hashToken(token)],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  if (r.status !== 'active') return null;
  // last_seen best-effort (không chặn request)
  db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [r.id]).catch(() => {});
  return {
    session: { id: r.id, mfaSatisfied: r.mfa_satisfied, steppedUpAt: r.stepped_up_at },
    user: { id: r.user_id, email: r.email, mfaEnabled: r.mfa_enabled },
  };
}

/** Phiên ĐẦY ĐỦ: tồn tại VÀ (không bật MFA HOẶC đã qua MFA). */
function isFullyAuthed(ctx) {
  return ctx && (!ctx.user.mfaEnabled || ctx.session.mfaSatisfied);
}

// Hash Argon2id giả để verify KHI KHÔNG có user — giữ thời gian phản hồi ổn định,
// không rò email tồn tại qua timing. Dùng ở login và step-up.
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000';

// ── handlers ─────────────────────────────────────────────────────────────────

// Phản hồi register PHẢI y hệt cho email mới lẫn email đã tồn tại — cùng status,
// cùng body. Trả {id,email} ở một nhánh và {ok:true} ở nhánh kia là oracle liệt
// kê xác định chỉ với một request. Không trả id (rò cả sự tồn tại lẫn định danh).
const REGISTER_OK = { ok: true };

async function register(req, res, body, ctx) {
  const email = String(body.email ?? '').toLowerCase().trim();
  const password = body.password;
  if (!validEmail(email)) return send(res, 400, { error: 'email không hợp lệ' });
  if (!validPassword(password)) return send(res, 400, { error: 'mật khẩu tối thiểu 10 ký tự' });

  // Rate limit theo IP TRƯỚC khi băm. hashPassword là Argon2id 19 MiB trên
  // threadpool libuv (4) dùng chung với login/reset — không chặn ở đây thì
  // register trở thành vector DoS làm đói xác thực hợp lệ.
  const rl = await hit(redis, `rl:register:ip:${ctx.ip}`, { limit: 10, windowSec: 3600 });
  if (!rl.allowed) {
    return send(res, 429, { error: 'quá nhiều lần thử, thử lại sau' }, { 'retry-after': String(rl.retryAfterSec) });
  }

  const passwordHash = await hashPassword(password);
  try {
    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
      [email, passwordHash],
    );
    await audit('user.register', { userId: rows[0].id, ip: ctx.ip, ua: ctx.ua });
    return send(res, 201, REGISTER_OK);
  } catch (err) {
    if (err.code === '23505') {
      // Email đã tồn tại: cùng status, cùng body như nhánh thành công.
      return send(res, 201, REGISTER_OK);
    }
    throw err;
  }
}

async function login(req, res, body, ctx) {
  const email = String(body.email ?? '').toLowerCase().trim();
  const password = String(body.password ?? '');

  // Bộ đếm theo IP: chặn TRƯỚC khi băm — đây là lá chắn DoS (Argon2 đắt) và
  // brute-force từ một nguồn. Theo IP (không theo tài khoản) nên không thể bị vũ
  // khí hoá để khoá tài khoản người khác.
  const ipRl = await hit(redis, `rl:login:ip:${ctx.ip}`, { limit: 20, windowSec: 900 });
  if (!ipRl.allowed) {
    await audit('user.login_rate_limited', { ip: ctx.ip, ua: ctx.ua, metadata: { email } });
    return send(res, 429, { error: 'quá nhiều lần thử, thử lại sau' }, { 'retry-after': String(ipRl.retryAfterSec) });
  }

  const { rows } = await db.query(
    `SELECT id, password_hash, status, mfa_enabled FROM users WHERE email = $1`,
    [email],
  );

  // Luôn chạy verify (kể cả khi không có user) để không rò email tồn tại qua timing.
  const user = rows[0];
  const ok = await verifyPassword(user?.password_hash ?? DUMMY_HASH, password);

  if (!user || !ok || user.status !== 'active') {
    // Chỉ ĐẾM lần SAI theo tài khoản. Không bao giờ chặn mật khẩu ĐÚNG bằng bộ
    // đếm này — nếu chặn, kẻ tấn công spam mật khẩu sai cho victim@email sẽ khoá
    // luôn cả lần đăng nhập đúng của nạn nhân (lockout DoS). Kẻ tấn công không
    // biết mật khẩu nên không vượt được nhánh này.
    const acctRl = await hit(redis, `rl:login:acctfail:${email}`, { limit: 10, windowSec: 900 });
    await audit('user.login_failed', { userId: user?.id ?? null, ip: ctx.ip, ua: ctx.ua, metadata: { email } });
    if (!acctRl.allowed) {
      return send(res, 429, { error: 'quá nhiều lần thử, thử lại sau' }, { 'retry-after': String(acctRl.retryAfterSec) });
    }
    return send(res, 401, { error: 'email hoặc mật khẩu không đúng' });
  }

  // Mật khẩu ĐÚNG → xoá bộ đếm lần-sai (không để lần sai trước phạt phiên hợp lệ).
  await resetRate(redis, `rl:login:acctfail:${email}`);

  if (user.mfa_enabled) {
    // Tạo phiên NỬA VỜI (chờ MFA), sống ngắn. /auth/me sẽ từ chối nó.
    const { token } = await createSession(user.id, {
      mfaSatisfied: false,
      ip: ctx.ip,
      ua: ctx.ua,
      ttlMs: CHALLENGE_TTL_MS,
    });
    setSessionCookie(res, token, Math.floor(CHALLENGE_TTL_MS / 1000));
    await audit('user.login_password_ok_mfa_pending', { userId: user.id, ip: ctx.ip, ua: ctx.ua });
    return send(res, 200, { mfa_required: true });
  }

  const { token } = await createSession(user.id, {
    mfaSatisfied: true,
    ip: ctx.ip,
    ua: ctx.ua,
    ttlMs: SESSION_TTL_MS,
  });
  setSessionCookie(res, token, Math.floor(SESSION_TTL_MS / 1000));
  await audit('user.login', { userId: user.id, ip: ctx.ip, ua: ctx.ua });
  return send(res, 200, { ok: true, mfa_required: false });
}

async function mfaVerify(req, res, body, ctx) {
  if (!ctx.auth) return send(res, 401, { error: 'chưa đăng nhập' });
  const { user, session } = ctx.auth;
  if (!user.mfaEnabled) return send(res, 400, { error: 'tài khoản chưa bật MFA' });
  if (session.mfaSatisfied) return send(res, 200, { ok: true }); // đã qua rồi

  const code = String(body.code ?? '').replace(/\s/g, '');

  const rl = await hit(redis, `rl:mfa:${user.id}`, { limit: 10, windowSec: 300 });
  if (!rl.allowed) return send(res, 429, { error: 'quá nhiều lần thử mã' }, { 'retry-after': String(rl.retryAfterSec) });

  const { rows } = await db.query(
    `SELECT secret_enc, last_counter FROM mfa_totp WHERE user_id = $1 AND confirmed_at IS NOT NULL`,
    [user.id],
  );
  if (rows.length === 0) return send(res, 400, { error: 'MFA chưa cấu hình' });

  const secret = base32Decode(open(rows[0].secret_enc, MFA_ENC_KEY));
  const matchedCounter = verifyTotp(secret, code, {});

  let ok = false;
  if (matchedCounter !== null) {
    // Chống replay NGUYÊN TỬ: đọc-rồi-ghi để hở cửa sổ TOCTOU (hai request cùng
    // mã trong cùng bước thời gian đều đọc last cũ rồi cùng ghi). Điều kiện nằm
    // TRONG câu UPDATE: chỉ đúng một request thắng, request thua có rowCount = 0.
    const upd = await db.query(
      `UPDATE mfa_totp SET last_counter = $1
        WHERE user_id = $2 AND (last_counter IS NULL OR last_counter < $1)`,
      [matchedCounter, user.id],
    );
    if (upd.rowCount !== 1) {
      await audit('user.mfa_replay_blocked', { userId: user.id, ip: ctx.ip, ua: ctx.ua });
      return send(res, 401, { error: 'mã đã được dùng' });
    }
    ok = true;
  } else {
    // Thử mã khôi phục (dùng một lần).
    ok = await consumeRecoveryCode(user.id, code);
  }

  if (!ok) {
    await audit('user.mfa_failed', { userId: user.id, ip: ctx.ip, ua: ctx.ua });
    return send(res, 401, { error: 'mã không đúng' });
  }

  // Nâng phiên nửa vời thành đầy đủ + kéo dài hạn.
  await db.query(
    `UPDATE sessions SET mfa_satisfied = true, expires_at = $1 WHERE id = $2`,
    [new Date(Date.now() + SESSION_TTL_MS), session.id],
  );
  setSessionCookie(res, parseCookies(req)[SESSION_COOKIE], Math.floor(SESSION_TTL_MS / 1000));
  await resetRate(redis, `rl:mfa:${user.id}`);
  await audit('user.mfa_verified', { userId: user.id, ip: ctx.ip, ua: ctx.ua });
  return send(res, 200, { ok: true });
}

async function consumeRecoveryCode(userId, code) {
  const { rows } = await db.query(
    `SELECT id FROM mfa_recovery_codes WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
    [userId, hashToken(code.toUpperCase())],
  );
  if (rows.length === 0) return false;
  const r = await db.query(
    `UPDATE mfa_recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL`,
    [rows[0].id],
  );
  return r.rowCount === 1; // race: chỉ một request thắng
}

async function mfaEnroll(req, res, body, ctx) {
  if (!isFullyAuthed(ctx.auth)) return send(res, 401, { error: 'cần đăng nhập đầy đủ' });
  const { user } = ctx.auth;

  // Chặn enroll lại khi MFA đã BẬT. Enroll đang ghi đè secret + đặt confirmed_at=NULL;
  // nếu người dùng đang bật MFA làm việc đó rồi bỏ dở activate, tài khoản rơi vào
  // trạng thái mồ côi (mfa_enabled=true, confirmed_at=NULL) → khoá cứng, cả mã khôi
  // phục cũng vô dụng. Đổi thiết bị authenticator cần một luồng "tắt MFA" có step-up
  // (xác minh yếu tố hiện tại) — việc tương lai. Hiện tại: chặn để không tự khoá.
  if (user.mfaEnabled) {
    return send(res, 409, { error: 'MFA đã bật; cần tắt trước khi cấu hình lại' });
  }

  // Secret 20 byte (160 bit) — chuẩn cho TOTP SHA1.
  const secretBytes = crypto.randomBytes(20);
  const secretB32 = base32Encode(secretBytes);
  const enc = seal(secretB32, MFA_ENC_KEY);

  // Upsert ở trạng thái CHƯA xác nhận. Enroll lại thì thay secret cũ chưa dùng.
  await db.query(
    `INSERT INTO mfa_totp (user_id, secret_enc, confirmed_at, last_counter)
     VALUES ($1, $2, NULL, NULL)
     ON CONFLICT (user_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc,
       confirmed_at = NULL, last_counter = NULL`,
    [user.id, enc],
  );

  const url = otpauthURL({ secretBase32: secretB32, issuer: ISSUER, account: user.email });
  // Secret chỉ hiện MỘT lần, để người dùng nhập vào app Authenticator.
  return send(res, 200, { secret: secretB32, otpauth_url: url });
}

async function mfaActivate(req, res, body, ctx) {
  if (!isFullyAuthed(ctx.auth)) return send(res, 401, { error: 'cần đăng nhập đầy đủ' });
  const { user, session } = ctx.auth;
  const code = String(body.code ?? '').replace(/\s/g, '');

  const { rows } = await db.query(`SELECT secret_enc FROM mfa_totp WHERE user_id = $1`, [user.id]);
  if (rows.length === 0) return send(res, 400, { error: 'chưa enroll MFA' });

  const secret = base32Decode(open(rows[0].secret_enc, MFA_ENC_KEY));
  const matched = verifyTotp(secret, code, {});
  if (matched === null) return send(res, 401, { error: 'mã không đúng' });

  // Sinh mã khôi phục — trả plaintext MỘT lần, lưu hash.
  const codes = Array.from({ length: 10 }, () => generateRecoveryCode());

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE mfa_totp SET confirmed_at = now(), last_counter = $1 WHERE user_id = $2`,
      [matched, user.id],
    );
    await client.query(`UPDATE users SET mfa_enabled = true WHERE id = $1`, [user.id]);
    // Enroll lại: VÔ HIỆU HOÁ mã khôi phục cũ, không xoá.
    // Không xoá vì: (a) app_auth cố tình không có quyền DELETE trên bảng này —
    // quyền hẹp nhất có thể; (b) giữ lại dấu vết để điều tra khi có sự cố.
    await client.query(
      `UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
      [user.id],
    );
    for (const c of codes) {
      await client.query(`INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [
        user.id,
        hashToken(c.toUpperCase()),
      ]);
    }
    await client.query(`UPDATE sessions SET mfa_satisfied = true WHERE id = $1`, [session.id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  await audit('user.mfa_enabled', { userId: user.id, ip: ctx.ip, ua: ctx.ua });
  return send(res, 200, { ok: true, recovery_codes: codes });
}

async function logout(req, res, body, ctx) {
  if (ctx.auth) {
    await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [ctx.auth.session.id]);
    await audit('user.logout', { userId: ctx.auth.user.id, ip: ctx.ip, ua: ctx.ua });
  }
  clearSessionCookie(res);
  return send(res, 200, { ok: true });
}

async function me(req, res, body, ctx) {
  if (!ctx.auth) return send(res, 401, { error: 'chưa đăng nhập' });
  if (!isFullyAuthed(ctx.auth)) return send(res, 401, { error: 'mfa_required', mfa_required: true });

  const { user, session } = ctx.auth;
  const { rows } = await db.query(
    `SELECT shop_id, role FROM memberships WHERE user_id = $1 ORDER BY created_at`,
    [user.id],
  );
  // stepped_up_at cho seller-admin quyết định thao tác nhạy cảm có cần xác thực lại.
  return send(res, 200, {
    id: user.id,
    email: user.email,
    mfa_enabled: user.mfaEnabled,
    stepped_up_at: session.steppedUpAt,
    memberships: rows,
  });
}

// Xác thực lại (step-up) cho thao tác nhạy cảm. Đặt mốc sessions.stepped_up_at.
// Seller-admin kiểm mốc này để cho/không cho đổi quyền, xoá thành viên, v.v.
async function stepUp(req, res, body, ctx) {
  if (!isFullyAuthed(ctx.auth)) return send(res, 401, { error: 'cần đăng nhập đầy đủ' });
  const { user, session } = ctx.auth;
  const password = String(body.password ?? '');

  const rl = await hit(redis, `rl:stepup:${user.id}`, { limit: 10, windowSec: 300 });
  if (!rl.allowed) return send(res, 429, { error: 'quá nhiều lần thử' }, { 'retry-after': String(rl.retryAfterSec) });

  const { rows } = await db.query(`SELECT password_hash FROM users WHERE id = $1`, [user.id]);
  const ok = await verifyPassword(rows[0]?.password_hash ?? DUMMY_HASH, password);
  if (!ok) {
    await audit('user.step_up_failed', { userId: user.id, ip: ctx.ip, ua: ctx.ua });
    return send(res, 401, { error: 'mật khẩu không đúng' });
  }
  await db.query(`UPDATE sessions SET stepped_up_at = now() WHERE id = $1`, [session.id]);
  await resetRate(redis, `rl:stepup:${user.id}`);
  await audit('user.step_up', { userId: user.id, ip: ctx.ip, ua: ctx.ua });
  return send(res, 200, { ok: true });
}

async function forgot(req, res, body, ctx) {
  const email = String(body.email ?? '').toLowerCase().trim();

  const rl = await hit(redis, `rl:forgot:ip:${ctx.ip}`, { limit: 10, windowSec: 3600 });
  // Luôn trả 200 dù rate-limited hay email không tồn tại: KHÔNG tiết lộ gì.
  if (rl.allowed && validEmail(email)) {
    const { rows } = await db.query(`SELECT id FROM users WHERE email = $1 AND status = 'active'`, [email]);
    if (rows.length) {
      const token = generateToken();
      await db.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '30 minutes')`,
        [rows[0].id, hashToken(token)],
      );
      await audit('user.password_reset_requested', { userId: rows[0].id, ip: ctx.ip });
      // Ở production token CHỈ đi qua email. Không log, không trả qua HTTP response
      // (đừng biến API thành kênh rò token), không lưu đâu khác.
      if (DEV_RESET_TOKEN_STASH) {
        log('warn', 'dev_reset_token_stashed', {}); // không log email (PII)
        await redis.set(`dev:reset:${email}`, token, 'EX', 600);
      }
    }
  }
  return send(res, 200, { ok: true });
}

async function resetPassword(req, res, body, ctx) {
  const token = String(body.token ?? '');
  const password = body.password;
  if (!token || !validPassword(password)) return send(res, 400, { error: 'token hoặc mật khẩu không hợp lệ' });

  const { rows } = await db.query(
    `SELECT id, user_id FROM password_reset_tokens
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [hashToken(token)],
  );
  if (rows.length === 0) return send(res, 400, { error: 'token không hợp lệ hoặc đã hết hạn' });

  const { id: tokenId, user_id: userId } = rows[0];
  const newHash = await hashPassword(password);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Đánh dấu dùng token; nếu 0 dòng thì có request khác đã dùng trước → hủy.
    const used = await client.query(
      `UPDATE password_reset_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL`,
      [tokenId],
    );
    if (used.rowCount !== 1) {
      await client.query('ROLLBACK');
      return send(res, 400, { error: 'token đã được dùng' });
    }
    await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [newHash, userId]);
    // Đổi mật khẩu → thu hồi MỌI phiên. Nếu tài khoản bị chiếm, đây là cách đá ra.
    await client.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    await client.query(
      `UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await audit('user.password_reset', { userId, ip: ctx.ip, ua: ctx.ua });
  return send(res, 200, { ok: true });
}

async function acceptInvitation(req, res, body, ctx) {
  const token = String(body.token ?? '');
  const password = body.password;
  if (!token) return send(res, 400, { error: 'thiếu token' });

  const inv = await db.query(
    `SELECT id, shop_id, email, role FROM invitations
      WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()`,
    [hashToken(token)],
  );
  if (inv.rows.length === 0) return send(res, 400, { error: 'lời mời không hợp lệ hoặc đã hết hạn' });
  const { id: invId, shop_id: shopId, email, role } = inv.rows[0];

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Claim lời mời trước (dùng một lần, atomic). 0 dòng = request khác đã nhận.
    const claimed = await client.query(
      `UPDATE invitations SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL`,
      [invId],
    );
    if (claimed.rowCount !== 1) {
      await client.query('ROLLBACK');
      return send(res, 400, { error: 'lời mời đã được dùng' });
    }

    // TOKEN LỜI MỜI = bằng chứng sở hữu email. Ba nhánh (xem 0020):
    const existing = (await client.query(`SELECT id, email_verified_at FROM users WHERE email = $1`, [email])).rows[0];
    let userId, created = false;

    if (!existing) {
      // (a) Chưa có tài khoản → tạo mới, đánh dấu đã xác minh (token chứng minh email).
      if (!validPassword(password)) { await client.query('ROLLBACK'); return send(res, 400, { error: 'mật khẩu tối thiểu 10 ký tự' }); }
      const hash = await hashPassword(password);
      userId = (await client.query(
        `INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1, $2, now()) RETURNING id`,
        [email, hash],
      )).rows[0].id;
      created = true;
    } else if (existing.email_verified_at === null) {
      // (b) Tài khoản CHƯA xác minh (có thể do kẻ đăng ký trước để chiếm). Người giữ
      // token mới là chủ email thật → CLAIM: đặt lại mật khẩu, TẮT MFA, thu hồi mọi
      // phiên cũ. Sau bước này account thuộc về người vừa chấp nhận, kẻ cũ bị đá.
      if (!validPassword(password)) { await client.query('ROLLBACK'); return send(res, 400, { error: 'mật khẩu tối thiểu 10 ký tự' }); }
      const hash = await hashPassword(password);
      userId = existing.id;
      await client.query(`UPDATE users SET password_hash = $1, email_verified_at = now(), mfa_enabled = false WHERE id = $2`, [hash, userId]);
      await client.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    } else {
      // (c) Tài khoản ĐÃ xác minh = chủ email hợp lệ (đã chứng minh trước). KHÔNG bind
      // mù: bắt buộc đang đăng nhập ĐÚNG tài khoản này mới thêm membership.
      if (!ctx.auth || ctx.auth.user.id !== existing.id) {
        await client.query('ROLLBACK');
        return send(res, 403, { error: 'vui lòng đăng nhập bằng tài khoản này rồi chấp nhận lại', login_required: true });
      }
      userId = existing.id;
    }

    // Tạo membership. Đã là thành viên (chấp nhận lại) → giữ nguyên, không lỗi.
    await client.query(
      `INSERT INTO memberships (shop_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (shop_id, user_id) DO NOTHING`,
      [shopId, userId, role],
    );

    await client.query('COMMIT');
    await audit('user.invitation_accepted', {
      userId,
      ip: ctx.ip,
      ua: ctx.ua,
      metadata: { shop_id: shopId, role, created },
    });
    return send(res, 200, { ok: true, shop_id: shopId, role, account_created: created });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ── router ───────────────────────────────────────────────────────────────────
const ROUTES = {
  'POST /auth/register': register,
  'POST /auth/login': login,
  'POST /auth/mfa/verify': mfaVerify,
  'POST /auth/mfa/enroll': mfaEnroll,
  'POST /auth/mfa/activate': mfaActivate,
  'POST /auth/logout': logout,
  'GET /auth/me': me,
  'POST /auth/step-up': stepUp,
  'POST /auth/password/forgot': forgot,
  'POST /auth/password/reset': resetPassword,
  'POST /auth/invitations/accept': acceptInvitation,
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://internal');
  if (url.pathname === '/healthz') return send(res, 200, { ok: true });

  const key = `${req.method} ${url.pathname}`;
  const handler = ROUTES[key];
  if (!handler) return send(res, 404, { error: 'không tìm thấy' });

  if (!originAllowed(req, ALLOWED_ORIGINS)) {
    return send(res, 403, { error: 'origin không được phép' });
  }

  try {
    const body = req.method === 'GET' ? {} : await readJson(req);
    const ctx = { ip: clientIp(req), ua: req.headers['user-agent'] ?? null, auth: await loadSession(req) };
    await handler(req, res, body, ctx);
  } catch (err) {
    const status = err.statusCode ?? 500;
    if (status >= 500) log('error', 'handler_error', { path: url.pathname, message: err.message, stack: err.stack });
    if (!res.headersSent) send(res, status, { error: status >= 500 ? 'lỗi hệ thống' : err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT }));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log('info', 'shutting_down', { signal: sig });
    server.close(async () => {
      await db.end().catch(() => {});
      redis.disconnect();
      process.exit(0);
    });
  });
}
