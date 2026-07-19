/**
 * Self-serve signup (0091, signup-1) — bức tường DB cho vai trò CÔNG KHAI app_signup.
 * app_signup ghi user+shop+domain+subscription+membership+audit trong 1 tx lúc provision →
 * nếu thủng service, blast-radius phải NHỎ. Test khoá:
 *  • least-priv: KHÔNG chạm orders/products/customers (crown-jewels nghiệp vụ + tiền).
 *  • column-scope: KHÔNG đọc được users.password_hash / sessions.token_hash.
 *  • policy: membership CHỈ role=owner · audit CHỈ actor_type=system · outbox CHỈ shop_id NULL.
 *  • reserve slug: 2 nháp pending cùng slug → 23505 (chốt đua).
 *  • guard trial: status=trial mà current_period_end NULL → 23514.
 *  • chuỗi provision đầy đủ chạy được dưới RLS (grant+policy đủ, không INSERT câm).
 */
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { owner, sqlstateOf, SQLSTATE } from './helpers.js';

const sg = new pg.Pool({ connectionString: process.env.DATABASE_URL_SIGNUP, max: 4 });
after(async () => { await Promise.all([sg.end(), owner.end()]); });

const tblPriv = (role, table, priv) =>
  owner.query(`SELECT has_table_privilege($1,$2,$3) AS ok`, [role, table, priv]).then((r) => r.rows[0].ok);
const colPriv = (role, table, col, priv) =>
  owner.query(`SELECT has_column_privilege($1,$2,$3,$4) AS ok`, [role, table, col, priv]).then((r) => r.rows[0].ok);
// Chạy fn dưới vai app_signup trong 1 tx rồi ROLLBACK (không bẩn DB). KHÔNG set app.shop_id
// (lúc provision shop chưa tồn tại — đúng như luồng thật).
async function asSignup(fn) {
  const c = await sg.connect();
  try { await c.query('BEGIN'); return await fn(c); }
  finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
}

describe('0091 self-serve signup — least-priv + RLS + policies', () => {
  test('blast-radius: app_signup KHÔNG chạm bảng nghiệp vụ/tiền', async () => {
    for (const t of ['orders', 'products', 'customers', 'order_lines', 'variants']) {
      assert.equal(await tblPriv('app_signup', t, 'SELECT'), false, `KHÔNG được SELECT ${t}`);
      assert.equal(await tblPriv('app_signup', t, 'INSERT'), false, `KHÔNG được INSERT ${t}`);
    }
  });

  test('có INSERT trên bảng provision cần (users là column-scope, kiểm riêng)', async () => {
    // users cấp INSERT THEO CỘT (không table-level) → has_table_privilege=false là ĐÚNG (least-priv);
    // chuỗi provision đầy đủ + colPriv password_hash chứng minh INSERT users chạy được.
    for (const t of ['shop_signups', 'shops', 'domains', 'subscriptions', 'memberships', 'audit_logs', 'outbox']) {
      assert.equal(await tblPriv('app_signup', t, 'INSERT'), true, `cần INSERT ${t}`);
    }
    assert.equal(await tblPriv('app_signup', 'plans', 'SELECT'), true, 'cần SELECT plans (validate gói)');
  });

  test('column-scope users: KHÔNG đọc password_hash (chống rò băm MK mọi seller)', async () => {
    assert.equal(await colPriv('app_signup', 'users', 'password_hash', 'SELECT'), false, 'KHÔNG được SELECT users.password_hash');
    assert.equal(await colPriv('app_signup', 'users', 'password_hash', 'INSERT'), true, 'cần INSERT password_hash (mint)');
    assert.equal(await colPriv('app_signup', 'users', 'password_hash', 'UPDATE'), true, 'cần UPDATE password_hash (claim)');
    assert.equal(await colPriv('app_signup', 'users', 'email', 'SELECT'), true, 'cần SELECT email (rẽ nhánh)');
    assert.equal(await colPriv('app_signup', 'users', 'email_verified_at', 'SELECT'), true, 'cần SELECT email_verified_at');
  });

  test('column-scope sessions: KHÔNG đọc token_hash, CHỈ thu hồi phiên', async () => {
    assert.equal(await colPriv('app_signup', 'sessions', 'token_hash', 'SELECT'), false, 'KHÔNG được SELECT sessions.token_hash');
    assert.equal(await colPriv('app_signup', 'sessions', 'revoked_at', 'UPDATE'), true, 'cần UPDATE revoked_at (claim)');
  });

  test('reserve slug: 2 nháp pending cùng slug → UNIQUE partial chặn (đua)', async () => {
    const plan = (await owner.query(`SELECT code FROM plans WHERE active LIMIT 1`)).rows[0].code;
    const slug = `sg-race-${randomUUID().slice(0, 8)}`;
    const ins = (c, tok) => c.query(
      `INSERT INTO shop_signups (email, password_hash, slug, name, plan_code, token_hash, expires_at)
       VALUES ($1,'H',$2,'Shop',$3,$4, now()+interval '30 min')`,
      [`${tok}@x.vn`, slug, plan, tok]);
    const code = await asSignup(async (c) => {
      await ins(c, randomUUID());
      return sqlstateOf(() => ins(c, randomUUID())); // cùng slug pending → 23505
    });
    assert.equal(code, SQLSTATE.UNIQUE_VIOLATION);
  });

  test('reserve slug: nháp provisioned KHÔNG chặn slug (giải phóng khi hết hạn/xong)', async () => {
    const plan = (await owner.query(`SELECT code FROM plans WHERE active LIMIT 1`)).rows[0].code;
    const slug = `sg-free-${randomUUID().slice(0, 8)}`;
    const ok = await asSignup(async (c) => {
      await c.query(`INSERT INTO shop_signups (email,password_hash,slug,name,plan_code,token_hash,status,expires_at)
        VALUES ('a@x.vn','H',$1,'S',$2,$3,'provisioned', now())`, [slug, plan, randomUUID()]);
      // slug cùng tên nhưng nháp cũ đã provisioned (loại khỏi partial index) → nháp pending mới OK
      return sqlstateOf(() => c.query(`INSERT INTO shop_signups (email,password_hash,slug,name,plan_code,token_hash,expires_at)
        VALUES ('b@x.vn','H',$1,'S',$2,$3, now()+interval '30 min')`, [slug, plan, randomUUID()]));
    });
    assert.equal(ok, null, 'nháp pending mới KHÔNG bị nháp provisioned chặn');
  });

  test('guard trial: status=trial mà current_period_end NULL → CHECK chặn (23514)', async () => {
    const shopId = (await owner.query(`INSERT INTO shops (slug,name,status) VALUES ($1,'S','active') RETURNING id`, [`sg-tr-${randomUUID().slice(0, 8)}`])).rows[0].id;
    const plan = (await owner.query(`SELECT code FROM plans WHERE active LIMIT 1`)).rows[0].code;
    const bad = await asSignup((c) => sqlstateOf(() => c.query(
      `INSERT INTO subscriptions (shop_id, plan_code, status, current_period_end) VALUES ($1,$2,'trial',NULL)`, [shopId, plan])));
    assert.equal(bad, SQLSTATE.CHECK_VIOLATION ?? '23514');
    const good = await asSignup((c) => sqlstateOf(() => c.query(
      `INSERT INTO subscriptions (shop_id, plan_code, status, current_period_end) VALUES ($1,$2,'trial', now()+interval '14 days')`, [shopId, plan])));
    assert.equal(good, null, 'trial có current_period_end → OK');
    await owner.query(`DELETE FROM shops WHERE id=$1`, [shopId]);
  });

  test('policy membership: CHỈ role=owner (chống tự cấp admin)', async () => {
    const shopId = (await owner.query(`INSERT INTO shops (slug,name,status) VALUES ($1,'S','active') RETURNING id`, [`sg-mb-${randomUUID().slice(0, 8)}`])).rows[0].id;
    const uid = (await owner.query(`INSERT INTO users (email,password_hash) VALUES ($1,'H') RETURNING id`, [`sg-${randomUUID().slice(0, 8)}@x.vn`])).rows[0].id;
    const owner_ok = await asSignup((c) => sqlstateOf(() => c.query(`INSERT INTO memberships (shop_id,user_id,role) VALUES ($1,$2,'owner')`, [shopId, uid])));
    const admin_no = await asSignup((c) => sqlstateOf(() => c.query(`INSERT INTO memberships (shop_id,user_id,role) VALUES ($1,$2,'admin')`, [shopId, uid])));
    assert.equal(owner_ok, null, 'role=owner OK');
    assert.equal(admin_no, SQLSTATE.INSUFFICIENT_PRIVILEGE, 'role=admin bị policy chặn');
    await owner.query(`DELETE FROM memberships WHERE user_id=$1`, [uid]);
    await owner.query(`DELETE FROM users WHERE id=$1`, [uid]);
    await owner.query(`DELETE FROM shops WHERE id=$1`, [shopId]);
  });

  test('policy audit: CHỈ actor_type=system (không mượn danh platform_staff)', async () => {
    const shopId = (await owner.query(`INSERT INTO shops (slug,name,status) VALUES ($1,'S','active') RETURNING id`, [`sg-au-${randomUUID().slice(0, 8)}`])).rows[0].id;
    const sysOk = await asSignup((c) => sqlstateOf(() => c.query(`INSERT INTO audit_logs (shop_id,actor_type,action) VALUES ($1,'system','shop.created')`, [shopId])));
    const staffNo = await asSignup((c) => sqlstateOf(() => c.query(`INSERT INTO audit_logs (shop_id,actor_type,action) VALUES ($1,'platform_staff','shop.created')`, [shopId])));
    assert.equal(sysOk, null, 'actor_type=system OK');
    assert.equal(staffNo, SQLSTATE.INSUFFICIENT_PRIVILEGE, 'actor_type=platform_staff bị chặn');
    await owner.query(`DELETE FROM shops WHERE id=$1`, [shopId]);
  });

  test('policy outbox: CHỈ shop_id NULL (email verify TRƯỚC khi có shop)', async () => {
    const shopId = (await owner.query(`INSERT INTO shops (slug,name,status) VALUES ($1,'S','active') RETURNING id`, [`sg-ob-${randomUUID().slice(0, 8)}`])).rows[0].id;
    const nullOk = await asSignup((c) => sqlstateOf(() => c.query(`INSERT INTO outbox (shop_id,topic,payload) VALUES (NULL,'signup.verify','{}'::jsonb)`)));
    const shopNo = await asSignup((c) => sqlstateOf(() => c.query(`INSERT INTO outbox (shop_id,topic,payload) VALUES ($1,'signup.verify','{}'::jsonb)`, [shopId])));
    assert.equal(nullOk, null, 'shop_id NULL OK');
    assert.equal(shopNo, SQLSTATE.INSUFFICIENT_PRIVILEGE, 'shop_id gắn shop bị chặn');
    await owner.query(`DELETE FROM shops WHERE id=$1`, [shopId]);
  });

  test('chuỗi provision đầy đủ chạy dưới RLS (grant+policy đủ, KHÔNG insert câm)', async () => {
    const plan = (await owner.query(`SELECT code FROM plans WHERE active LIMIT 1`)).rows[0].code;
    const tag = randomUUID().slice(0, 8);
    const err = await asSignup(async (c) => {
      // (a) mint user (branch acceptInvitation email mới)
      const uid = (await c.query(`INSERT INTO users (email,password_hash,email_verified_at) VALUES ($1,'H',now()) RETURNING id`, [`prov-${tag}@x.vn`])).rows[0].id;
      // shop + domain + subscription + membership owner + audit — như provisionShop
      const sid = (await c.query(`INSERT INTO shops (slug,name,status,created_via) VALUES ($1,'S','onboarding','self_serve') RETURNING id`, [`prov-${tag}`])).rows[0].id;
      await c.query(`INSERT INTO domains (shop_id,hostname,verification_token,verified_at,is_primary) VALUES ($1,$2,'t',now(),true)`, [sid, `prov-${tag}.nentang.vn`]);
      await c.query(`INSERT INTO subscriptions (shop_id,plan_code,status,current_period_end) VALUES ($1,$2,'trial', now()+interval '14 days')`, [sid, plan]);
      await c.query(`INSERT INTO memberships (shop_id,user_id,role) VALUES ($1,$2,'owner')`, [sid, uid]);
      await c.query(`INSERT INTO audit_logs (shop_id,actor_type,actor_id,action,metadata) VALUES ($1,'system',NULL,'shop.created', $2)`, [sid, { created_via: 'self_serve' }]);
      return null;
    }).catch((e) => e.message);
    assert.equal(err, null, `chuỗi provision phải chạy trọn (lỗi: ${err})`);
  });
});
