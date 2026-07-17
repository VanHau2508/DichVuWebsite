#!/usr/bin/env node
/**
 * XOAY KHOÁ MÃ HOÁ secretbox (Đợt 5.6 — rà soát #7 'càng để lâu càng đắt').
 *
 * Re-encrypt theo lô mọi ciphertext AES-256-GCM về khoá ACTIVE (entry ĐẦU của keyring):
 *
 *   Cột ciphertext trong hệ thống (đã rà toàn bộ caller seal/open):
 *     - mfa_totp.secret_enc            — secret TOTP (khoá MFA_ENC_KEYS / legacy MFA_ENC_KEY)
 *     - shop_shipping_config.token_enc — token API GHN/GHTK (SHIPPING_ENC_KEYS / SHIPPING_ENC_KEY)
 *   KHÔNG phải ciphertext (không xoay ở đây): sepay_token_hash (sha256 verify-only),
 *   shop_telegram.chat_id (không bí mật), backup (mã hoá file bằng openssl, BACKUP_ENC_KEY riêng).
 *
 * Cách dùng (chạy bằng role BỎ QUA RLS — superuser/BYPASSRLS, vd app_owner dev —
 * vì shop_shipping_config FORCE ROW LEVEL SECURITY):
 *
 *   DATABASE_URL='postgres://app_owner:...@host:5432/app' \
 *   MFA_ENC_KEYS='k2:<64hex mới>,k1:<64hex cũ>'      MFA_ENC_KEY='<64hex legacy>' \
 *   SHIPPING_ENC_KEYS='k2:<64hex mới>,k1:<64hex cũ>' SHIPPING_ENC_KEY='<64hex legacy>' \
 *   node scripts/rotate-secretbox.js [--dry-run] [--verify] [--only=mfa|shipping] [--batch=200]
 *
 *   --dry-run : đếm + giải mã thử, KHÔNG ghi gì (mọi transaction ROLLBACK).
 *   --verify  : giải mã thử TẤT CẢ dòng (kể cả đã ở khoá active), không ghi — dùng
 *               sau khi xoay để chứng minh 100% blob còn đọc được.
 *   --only    : chỉ xoay một nhóm (mfa | shipping).
 *   --batch   : số dòng mỗi transaction (mặc định 200).
 *
 * Dev (DB không publish port ra host — chạy trong container trên network compose):
 *   docker cp scripts/rotate-secretbox.js nentang-dev-dbtest-1:/work/rotate-secretbox.js
 *   docker compose -f infra/compose.dev.yml exec -T \
 *     -e DATABASE_URL='postgres://app_owner:devpassword@postgres:5432/app' \
 *     -e MFA_ENC_KEYS='...' -e MFA_ENC_KEY='...' \
 *     -e SHIPPING_ENC_KEYS='...' -e SHIPPING_ENC_KEY='...' \
 *     dbtest node /work/rotate-secretbox.js
 *
 * An toàn:
 *   - IDEMPOTENT: blob đã ở kid active bị bỏ qua; chạy lại → "0 xoay".
 *   - Transaction THEO LÔ (SELECT ... FOR UPDATE) — crash giữa chừng chỉ mất lô dở,
 *     chạy lại là xong; app đọc song song không bao giờ thấy blob nửa vời.
 *   - Dòng giải mã lỗi (hỏng/kid lạ) được BÁO + BỎ QUA, không chặn phần còn lại.
 *   - Sau khi TOÀN BỘ đã về khoá active (và đã --verify) mới được bỏ khoá cũ khỏi env.
 *
 * Tự chứa (không import app code): script phải chạy được ở nơi chỉ có node + pg
 * (container dbtest / máy vận hành), logic v2 giữ ĐỒNG BỘ với packages/auth/src/secretbox.js.
 */

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
// pg lấy từ node_modules tại chỗ chạy (dbtest /work có sẵn — migrate.js cũng dùng).
const require = createRequire(process.cwd() + '/');
const pg = require('pg');

// ── keyring (đồng bộ secretbox.js) ───────────────────────────────────────────
const KID_RE = /^[A-Za-z0-9_-]{1,16}$/;
const LEGACY_KID = 'k0';

function keyFromMaterial(m, label) {
  m = String(m ?? '').trim();
  const key = /^[0-9a-fA-F]{64}$/.test(m) ? Buffer.from(m, 'hex') : Buffer.from(m, 'base64');
  if (key.length !== 32) throw new Error(`${label} phải là 32 byte (64 hex hoặc base64)`);
  return key;
}
function parseKeyring(raw, envName) {
  const entries = [];
  for (const part of String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    if (i < 1) throw new Error(`${envName}: entry phải có dạng kid:khoá`);
    const kid = part.slice(0, i).trim();
    if (!KID_RE.test(kid)) throw new Error(`${envName}: kid "${kid}" không hợp lệ`);
    entries.push({ kid, key: keyFromMaterial(part.slice(i + 1), `${envName}[${kid}]`) });
  }
  return entries;
}
function gcmSeal(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64'));
}
function gcmOpen(ivB64, tagB64, ctB64, key) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  d.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ctB64, 'base64')), d.final()]).toString('utf8');
}
/** Giải mã một blob (v2 theo kid, legacy 3 phần bằng khoá legacy). */
function openAny(blob, ring, legacyKey) {
  const parts = String(blob).split('.');
  if (parts[0] === 'v2' && parts.length === 5) {
    const [, kid, iv, tag, ct] = parts;
    let entry = ring.find((e) => e.kid === kid);
    if (!entry && kid === LEGACY_KID && legacyKey) entry = { kid, key: legacyKey };
    if (!entry) throw new Error(`không có khoá kid "${kid}"`);
    return gcmOpen(iv, tag, ct, entry.key);
  }
  if (parts.length !== 3) throw new Error('định dạng ciphertext không hợp lệ');
  if (!legacyKey) throw new Error('blob legacy nhưng thiếu khoá legacy (env cũ)');
  return gcmOpen(parts[0], parts[1], parts[2], legacyKey);
}

// ── cấu hình mục tiêu ────────────────────────────────────────────────────────
const TARGETS = [
  { name: 'mfa', table: 'mfa_totp', pk: 'user_id', col: 'secret_enc', ringEnv: 'MFA_ENC_KEYS', legacyEnv: 'MFA_ENC_KEY' },
  { name: 'shipping', table: 'shop_shipping_config', pk: 'shop_id', col: 'token_enc', ringEnv: 'SHIPPING_ENC_KEYS', legacyEnv: 'SHIPPING_ENC_KEY' },
];

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const VERIFY = args.includes('--verify');
const ONLY = (args.find((a) => a.startsWith('--only=')) ?? '').split('=')[1] || null;
const BATCH = Math.max(1, parseInt((args.find((a) => a.startsWith('--batch=')) ?? '').split('=')[1] || '200', 10) || 200);

if (!process.env.DATABASE_URL) { console.error('thiếu DATABASE_URL (role bỏ qua RLS)'); process.exit(2); }

async function rotateTarget(pool, t) {
  const rawRing = process.env[t.ringEnv] ?? '';
  const legacyRaw = process.env[t.legacyEnv] ?? '';
  const legacyKey = /^[0-9a-fA-F]{64}$/.test(legacyRaw) ? Buffer.from(legacyRaw, 'hex') : null;
  if (!rawRing && !VERIFY) { console.log(`[${t.name}] BỎ QUA — chưa đặt ${t.ringEnv} (không có khoá active để xoay tới)`); return { skippedTarget: true }; }
  const ring = parseKeyring(rawRing, t.ringEnv);
  if (!ring.length && !VERIFY) { console.log(`[${t.name}] BỎ QUA — ${t.ringEnv} rỗng`); return { skippedTarget: true }; }
  const active = ring[0] ?? null;

  const total = Number((await pool.query(`SELECT count(*)::int n FROM ${t.table}`)).rows[0].n);
  const already = active
    ? Number((await pool.query(`SELECT count(*)::int n FROM ${t.table} WHERE starts_with(${t.col}, $1)`, [`v2.${active.kid}.`])).rows[0].n)
    : 0;
  console.log(`[${t.name}] ${t.table}.${t.col}: tổng ${total}, đã ở khoá active${active ? ` (${active.kid})` : ''}: ${already}`);

  let rotated = 0, verified = 0;
  const failed = [];

  if (VERIFY) {
    // Chế độ chứng minh: giải mã thử TẤT CẢ, không ghi.
    let cursor = null;
    for (;;) {
      const r = await pool.query(
        `SELECT ${t.pk} AS pk, ${t.col} AS blob FROM ${t.table}
          WHERE ($1::uuid IS NULL OR ${t.pk} > $1) ORDER BY ${t.pk} LIMIT ${BATCH}`, [cursor]);
      if (!r.rows.length) break;
      for (const row of r.rows) {
        try { openAny(row.blob, ring, legacyKey); verified++; }
        catch (e) { failed.push({ pk: row.pk, error: e.message }); }
      }
      cursor = r.rows[r.rows.length - 1].pk;
    }
    console.log(`[${t.name}] VERIFY: giải mã OK ${verified}/${total}, lỗi ${failed.length}`);
    for (const f of failed) console.log(`  LỖI ${f.pk}: ${f.error}`);
    return { total, already, verified, failed: failed.length };
  }

  let cursor = null;
  for (;;) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      // FOR UPDATE: app ghi đè song song (shop đổi token) không bị mất — ta khoá dòng
      // trước khi đọc, re-encrypt trên giá trị đã khoá.
      const r = await c.query(
        `SELECT ${t.pk} AS pk, ${t.col} AS blob FROM ${t.table}
          WHERE NOT starts_with(${t.col}, $1) AND ($2::uuid IS NULL OR ${t.pk} > $2)
          ORDER BY ${t.pk} LIMIT ${BATCH} FOR UPDATE`,
        [`v2.${active.kid}.`, cursor]);
      if (!r.rows.length) { await c.query('ROLLBACK'); c.release(); break; }
      for (const row of r.rows) {
        let plaintext;
        try { plaintext = openAny(row.blob, ring, legacyKey); }
        catch (e) { failed.push({ pk: row.pk, error: e.message }); continue; }
        const blob2 = ['v2', active.kid, ...gcmSeal(plaintext, active.key)].join('.');
        if (!DRY) await c.query(`UPDATE ${t.table} SET ${t.col} = $1 WHERE ${t.pk} = $2`, [blob2, row.pk]);
        rotated++;
      }
      await c.query(DRY ? 'ROLLBACK' : 'COMMIT');
      cursor = r.rows[r.rows.length - 1].pk; // con trỏ tiến kể cả khi có dòng lỗi → không lặp vô hạn
      c.release();
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); c.release(); throw e; }
  }
  console.log(`[${t.name}] ${DRY ? 'DRY-RUN — sẽ xoay' : 'ĐÃ XOAY'} ${rotated} dòng về kid "${active.kid}", lỗi giải mã ${failed.length}`);
  for (const f of failed) console.log(`  LỖI ${f.pk}: ${f.error}`);
  return { total, already, rotated, failed: failed.length };
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  let anyFail = 0;
  try {
    for (const t of TARGETS) {
      if (ONLY && t.name !== ONLY) continue;
      const r = await rotateTarget(pool, t);
      anyFail += r.failed ?? 0;
    }
  } finally { await pool.end(); }
  if (anyFail > 0) { console.error(`\nCÓ ${anyFail} dòng không giải mã được — kiểm tra khoá/kid trước khi bỏ khoá cũ.`); process.exit(1); }
  console.log('\nHOÀN TẤT. Chỉ bỏ khoá cũ khỏi env sau khi mọi dòng đã ở khoá active (chạy lại với --verify để chứng minh).');
}
main().catch((e) => { console.error(e); process.exit(1); });
