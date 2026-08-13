/** RLS, grant, timeline và liên kết chứng từ cho yêu cầu hậu mãi request-only (0158-0167). */
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { owner } from './helpers.js';

const customer = new pg.Pool({ connectionString: process.env.DATABASE_URL_CUSTOMER, max: 3 });
const checkout = new pg.Pool({ connectionString: process.env.DATABASE_URL_CHECKOUT, max: 3 });
after(async () => { await Promise.all([customer.end(), checkout.end(), owner.end()]); });

const sha = (s) => createHash('sha256').update(s).digest('hex');
async function ctx(pool, { shop, customerId, claim, commit = false }, fn) {
  const c = await pool.connect();
  let done = false;
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.shop_id', $1, true)`, [shop]);
    if (customerId) await c.query(`SELECT set_config('app.customer_id', $1, true)`, [customerId]);
    if (claim) await c.query(`SELECT set_config('app.claim_token_hash', $1, true)`, [claim]);
    const out = await fn(c);
    if (commit) { await c.query('COMMIT'); done = true; }
    return out;
  } finally { if (!done) await c.query('ROLLBACK').catch(() => {}); c.release(); }
}

async function seed() {
  const tag = randomUUID().slice(0, 8);
  const mkShop = async (name) => (await owner.query(
    `INSERT INTO shops (slug, name, status) VALUES ($1, $2, 'active') RETURNING id`,
    [`req-${name}-${tag}`, `Shop ${name}`],
  )).rows[0].id;
  const A = await mkShop('a'), B = await mkShop('b');
  const mkCustomer = async (shop, name) => (await owner.query(
    `INSERT INTO customers (shop_id, email, password_hash) VALUES ($1, $2, 'H') RETURNING id`,
    [shop, `${name}-${tag}@x.vn`],
  )).rows[0].id;
  const a1 = await mkCustomer(A, 'a1'), a2 = await mkCustomer(A, 'a2'), b1 = await mkCustomer(B, 'b1');
  const guestToken = `guest-${randomUUID()}-${randomUUID()}`;
  const mkOrder = async (shop, num, customerId, tokenHash) => (await owner.query(
    `INSERT INTO orders (shop_id, order_number, total_vnd, customer_id, lookup_token_hash,
                         customer_name, customer_phone, status)
     VALUES ($1, $2, 100000, $3, $4, 'Khách', '0900000000', 'pending') RETURNING id`,
    [shop, num, customerId, tokenHash],
  )).rows[0].id;
  const own = await mkOrder(A, 1, a1, null);
  const other = await mkOrder(A, 2, a2, null);
  const guest = await mkOrder(A, 3, null, sha(guestToken));
  const ownClosed = await mkOrder(A, 4, a1, null);
  const cross = await mkOrder(B, 1, b1, null);
  const decider = (await owner.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'H') RETURNING id`,
    [`request-decider-${tag}@x.vn`],
  )).rows[0].id;
  return { A, B, a1, a2, b1, own, other, guest, ownClosed, cross, guestToken, decider };
}

async function cleanup(s) {
  const shops = [s.A, s.B];
  await owner.query(`DELETE FROM order_events WHERE shop_id = ANY($1::uuid[])`, [shops]);
  await owner.query(`DELETE FROM order_requests WHERE shop_id = ANY($1::uuid[])`, [shops]);
  await owner.query(`DELETE FROM returns WHERE shop_id = ANY($1::uuid[])`, [shops]);
  await owner.query(`DELETE FROM orders WHERE shop_id = ANY($1::uuid[])`, [shops]);
  await owner.query(`DELETE FROM customers WHERE shop_id = ANY($1::uuid[])`, [shops]);
  await owner.query(`DELETE FROM shops WHERE id = ANY($1::uuid[])`, [shops]);
  await owner.query(`DELETE FROM users WHERE id = $1`, [s.decider]);
}

async function assertQueryRejected(c, query, params, expectedCodes = ['42501']) {
  const codes = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes];
  await c.query('SAVEPOINT blocked_query');
  try {
    await assert.rejects(
      c.query(query, params),
      (e) => codes.includes(e.code),
    );
  } finally {
    await c.query('ROLLBACK TO SAVEPOINT blocked_query');
    await c.query('RELEASE SAVEPOINT blocked_query');
  }
}

const assertCustomerEventRejected = (c, params, expectedCodes) => assertQueryRejected(
  c,
  `SELECT record_order_event($1, $2, $3, $4, $5, $6)`,
  params,
  expectedCodes,
);

describe('0158 grants', () => {
  test('customer/checkout chỉ đọc + tạo; seller không tạo/xoá yêu cầu thay khách', async () => {
    const q = async (role, privilege) => (await owner.query(
      `SELECT has_table_privilege($1, 'order_requests', $2) AS ok`, [role, privilege],
    )).rows[0].ok;
    const col = async (role, column, privilege) => (await owner.query(
      `SELECT has_column_privilege($1, 'order_requests', $2, $3) AS ok`, [role, column, privilege],
    )).rows[0].ok;
    assert.equal(await col('app_customer', 'request_type', 'INSERT'), true);
    assert.equal((await owner.query(
      `SELECT has_table_privilege('app_customer', 'order_events', 'INSERT') AS ok`,
    )).rows[0].ok, true);
    assert.equal((await owner.query(
      `SELECT has_function_privilege('app_customer',
        'record_order_event(uuid,text,text,text,text,jsonb,timestamp with time zone)', 'EXECUTE') AS ok`,
    )).rows[0].ok, true);
    assert.equal(await col('app_customer', 'status', 'UPDATE'), false);
    assert.equal(await col('app_checkout', 'request_type', 'INSERT'), true);
    assert.equal(await col('app_checkout', 'status', 'UPDATE'), false);
    assert.equal(await q('app_rw', 'INSERT'), false);
    assert.equal(await q('app_rw', 'DELETE'), false);
    assert.equal(await col('app_rw', 'status', 'UPDATE'), true);
    assert.equal(await col('app_rw', 'request_payload', 'UPDATE'), false);
  });
});

describe('0158 customer RLS + chống trùng', () => {
  test('khách chỉ tạo/đọc yêu cầu trên đơn của mình; một loại chỉ có một yêu cầu mở', async () => {
    const s = await seed();
    try {
      await ctx(customer, { shop: s.A, customerId: s.a1 }, async (c) => {
        const own = await c.query(
          `INSERT INTO order_requests
             (shop_id, order_id, customer_id, request_type, requester_type, reason)
           VALUES (current_shop_id(), $1, current_customer_id(), 'cancel', 'customer', 'Đặt nhầm')
           RETURNING id`, [s.own],
        );
        assert.equal(own.rowCount, 1);
        await c.query(
          `SELECT record_order_event($1, 'order.cancel_requested', 'buyer', $2, 'account', $3)`,
          [s.own, s.a1, { request_id: own.rows[0].id }],
        );
        assert.equal((await c.query(
          `SELECT count(*)::int AS n FROM order_events WHERE order_id = $1 AND event_type = 'order.cancel_requested'`,
          [s.own],
        )).rows[0].n, 1);
        const visible = await c.query(`SELECT order_id FROM order_requests`);
        assert.deepEqual(visible.rows.map((r) => r.order_id), [s.own]);
        await assertQueryRejected(
          c,
          `INSERT INTO order_requests
             (shop_id, order_id, customer_id, request_type, requester_type)
           VALUES (current_shop_id(), $1, current_customer_id(), 'cancel', 'customer')`,
          [s.other],
        );
        await assertQueryRejected(
          c,
          `SELECT record_order_event($1, 'order.cancel_requested', 'buyer', $2, 'account', '{}'::jsonb)`,
          [s.other, s.a1],
          ['P0002', '42501'],
        );
      });
      // Dùng owner để cô lập đúng backstop unique khỏi RLS/application.
      await owner.query(
        `INSERT INTO order_requests
           (shop_id, order_id, customer_id, request_type, requester_type, reason)
         VALUES ($1, $2, $3, 'return', 'customer', 'Lỗi hàng')`, [s.A, s.own, s.a1],
      );
      await assert.rejects(owner.query(
        `INSERT INTO order_requests
           (shop_id, order_id, customer_id, request_type, requester_type, reason)
         VALUES ($1, $2, $3, 'return', 'customer', 'Bấm lại')`, [s.A, s.own, s.a1],
      ), (e) => e.code === '23505');
      await ctx(customer, { shop: s.A, customerId: s.a2 }, async (c) => {
        assert.equal((await c.query(`SELECT count(*)::int AS n FROM order_requests WHERE order_id = $1`, [s.own])).rows[0].n, 0);
      });
    } finally { await cleanup(s); }
  });

  test('composite FK chặn request shop A trỏ sang order shop B', async () => {
    const s = await seed();
    try {
      await assert.rejects(owner.query(
        `INSERT INTO order_requests
           (shop_id, order_id, customer_id, request_type, requester_type)
         VALUES ($1, $2, $3, 'cancel', 'customer')`, [s.A, s.cross, s.a1],
      ), (e) => e.code === '23503');
    } finally { await cleanup(s); }
  });
});

describe('0164 customer order-event allowlist', () => {
  test('chỉ ghi event request đúng loại, đúng actor/source và đúng request của khách', async () => {
    const s = await seed();
    try {
      const ownRequests = (await owner.query(
        `INSERT INTO order_requests
           (shop_id, order_id, customer_id, request_type, requester_type, reason)
         VALUES
           ($1, $2, $3, 'cancel', 'customer', 'Đặt nhầm'),
           ($1, $2, $3, 'address_change', 'customer', 'Đổi nơi nhận'),
           ($1, $2, $3, 'return', 'customer', 'Sản phẩm lỗi')
         RETURNING id, request_type`,
        [s.A, s.own, s.a1],
      )).rows;
      const requestId = Object.fromEntries(ownRequests.map((r) => [r.request_type, r.id]));
      const otherRequest = (await owner.query(
        `INSERT INTO order_requests
           (shop_id, order_id, customer_id, request_type, requester_type, reason)
         VALUES ($1, $2, $3, 'cancel', 'customer', 'Yêu cầu của khách khác')
         RETURNING id`,
        [s.A, s.other, s.a2],
      )).rows[0].id;
      const closedRequest = (await owner.query(
        `INSERT INTO order_requests
           (shop_id, order_id, customer_id, request_type, requester_type, status,
            reason, decided_by, decided_at)
         VALUES ($1, $2, $3, 'return', 'customer', 'rejected',
                 'Yêu cầu đã đóng', $4, now())
         RETURNING id`,
        [s.A, s.ownClosed, s.a1, s.decider],
      )).rows[0].id;

      await ctx(customer, { shop: s.A, customerId: s.a1 }, async (c) => {
        const allowed = [
          ['order.cancel_requested', requestId.cancel],
          ['order.address_change_requested', requestId.address_change],
          ['return.requested', requestId.return],
        ];
        for (const [eventType, id] of allowed) {
          await c.query(
            `SELECT record_order_event($1, $2, 'buyer', $3, 'account', $4)`,
            [s.own, eventType, s.a1, { request_id: id }],
          );
        }

        await assertCustomerEventRejected(c, [
          s.own, 'order.cancel_requested', 'buyer', s.a1, 'account', { request_id: requestId.cancel },
        ], '23505');

        await assertCustomerEventRejected(c, [
          s.own, 'payment.received', 'buyer', s.a1, 'account', { request_id: requestId.cancel },
        ]);
        await assertCustomerEventRejected(c, [
          s.own, 'order.cancel_requested', 'user', s.a1, 'account', { request_id: requestId.cancel },
        ]);
        await assertCustomerEventRejected(c, [
          s.own, 'order.cancel_requested', 'buyer', s.a2, 'account', { request_id: requestId.cancel },
        ]);
        await assertCustomerEventRejected(c, [
          s.own, 'order.cancel_requested', 'buyer', s.a1, 'worker', { request_id: requestId.cancel },
        ]);
        await assertCustomerEventRejected(c, [
          s.own, 'order.cancel_requested', 'buyer', s.a1, 'account', { request_id: requestId.address_change },
        ]);
        await assertCustomerEventRejected(c, [
          s.own, 'order.cancel_requested', 'buyer', s.a1, 'account', { request_id: otherRequest },
        ]);
        await assertCustomerEventRejected(c, [
          s.own, 'order.cancel_requested', 'buyer', s.a1, 'account', {},
        ]);
        await assertCustomerEventRejected(c, [
          s.ownClosed, 'return.requested', 'buyer', s.a1, 'account', { request_id: closedRequest },
        ]);

        assert.equal((await c.query(
          `SELECT count(*)::int AS n FROM order_events
            WHERE order_id = $1
              AND event_type IN ('order.cancel_requested', 'order.address_change_requested', 'return.requested')`,
          [s.own],
        )).rows[0].n, 3);
      });
    } finally { await cleanup(s); }
  });
});

describe('0167 liên kết yêu cầu trả hàng với phiếu RMA', () => {
  test('completed return bắt buộc có phiếu đúng đơn và một phiếu không đóng hai request', async () => {
    const s = await seed();
    try {
      const ownReturn = (await owner.query(
        `INSERT INTO returns (shop_id, order_id, refund_vnd)
         VALUES ($1, $2, 0) RETURNING id`,
        [s.A, s.own],
      )).rows[0].id;
      const otherOrderReturn = (await owner.query(
        `INSERT INTO returns (shop_id, order_id, refund_vnd)
         VALUES ($1, $2, 0) RETURNING id`,
        [s.A, s.other],
      )).rows[0].id;

      await assert.rejects(owner.query(
        `INSERT INTO order_requests
           (shop_id, order_id, customer_id, request_type, requester_type, status,
            decided_by, decided_at, completed_at)
         VALUES ($1, $2, $3, 'return', 'customer', 'completed', $4, now(), now())`,
        [s.A, s.own, s.a1, s.decider],
      ), (e) => e.code === '23514');

      await assert.rejects(owner.query(
        `INSERT INTO order_requests
           (shop_id, order_id, customer_id, request_type, requester_type, status,
            result_return_id, decided_by, decided_at, completed_at)
         VALUES ($1, $2, $3, 'return', 'customer', 'completed', $4, $5, now(), now())`,
        [s.A, s.own, s.a1, otherOrderReturn, s.decider],
      ), (e) => e.code === '23503');

      const linked = await owner.query(
        `INSERT INTO order_requests
           (shop_id, order_id, customer_id, request_type, requester_type, status,
            result_return_id, decided_by, decided_at, completed_at)
         VALUES ($1, $2, $3, 'return', 'customer', 'completed', $4, $5, now(), now())
         RETURNING id`,
        [s.A, s.own, s.a1, ownReturn, s.decider],
      );
      assert.equal(linked.rowCount, 1);

      await assert.rejects(owner.query(
        `INSERT INTO order_requests
           (shop_id, order_id, customer_id, request_type, requester_type, status,
            result_return_id, decided_by, decided_at, completed_at)
         VALUES ($1, $2, $3, 'return', 'customer', 'completed', $4, $5, now(), now())`,
        [s.A, s.own, s.a1, ownReturn, s.decider],
      ), (e) => e.code === '23505');
    } finally { await cleanup(s); }
  });
});

describe('0158 guest token gate chuẩn bị cho checkout', () => {
  test('đúng lookup token mới tạo/đọc được guest request; token sai fail-closed', async () => {
    const s = await seed();
    try {
      await ctx(checkout, { shop: s.A, claim: sha(s.guestToken), commit: true }, async (c) => {
        const ins = await c.query(
          `INSERT INTO order_requests
             (shop_id, order_id, customer_id, request_type, requester_type, reason)
           VALUES (current_shop_id(), $1, NULL, 'cancel', 'guest', 'Đặt nhầm') RETURNING id`, [s.guest],
        );
        assert.equal(ins.rowCount, 1);
        assert.equal((await c.query(`SELECT count(*)::int AS n FROM order_requests WHERE order_id = $1`, [s.guest])).rows[0].n, 1);
      });
      await ctx(checkout, { shop: s.A, claim: sha('token-sai') }, async (c) => {
        assert.equal((await c.query(`SELECT count(*)::int AS n FROM order_requests WHERE order_id = $1`, [s.guest])).rows[0].n, 0);
        await assert.rejects(c.query(
          `INSERT INTO order_requests
             (shop_id, order_id, customer_id, request_type, requester_type)
           VALUES (current_shop_id(), $1, NULL, 'return', 'guest')`, [s.guest],
        ), (e) => e.code === '42501');
      });
    } finally { await cleanup(s); }
  });
});
