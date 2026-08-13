/** Bất biến DB cho outbox -> notification delivery -> order timeline (0166). */
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { owner, rw } from './helpers.js';

const worker = new pg.Pool({
  connectionString: process.env.DATABASE_URL_WORKER
    ?? 'postgres://app_worker:devpassword@postgres:5432/app',
  max: 2,
});

after(async () => { await Promise.all([worker.end(), rw.end(), owner.end()]); });

async function seed() {
  const tag = randomUUID().slice(0, 8);
  const shop = async (suffix) => (await owner.query(
    `INSERT INTO shops (slug, name, status) VALUES ($1, $2, 'active') RETURNING id`,
    [`notification-${suffix}-${tag}`, `Notification ${suffix} ${tag}`],
  )).rows[0].id;
  const A = await shop('a');
  const B = await shop('b');
  const order = async (shopId, number) => (await owner.query(
    `INSERT INTO orders (shop_id, order_number, total_vnd, status)
     VALUES ($1, $2, 100000, 'pending') RETURNING id`,
    [shopId, number],
  )).rows[0].id;
  const orderA = await order(A, 1);
  const orderA2 = await order(A, 2);
  const orderB = await order(B, 1);
  return { A, B, orderA, orderA2, orderB, outboxIds: [] };
}

async function addOutbox(s, shopId, payload = {}) {
  // Đây là fixture kiểm FK/trigger, không kiểm dispatch; chốt sẵn để worker dev không
  // nhặt outbox giữa lúc cleanup rồi tạo delivery mới làm test chập chờn.
  const id = Number((await owner.query(
    `INSERT INTO outbox (shop_id, topic, payload, processed_at)
     VALUES ($1, 'order.created', $2, now()) RETURNING id`,
    [shopId, payload],
  )).rows[0].id);
  s.outboxIds.push(id);
  return id;
}

async function addDelivery({ shopId, outboxId, orderId = null, status = 'queued', retryOf = null }) {
  return (await owner.query(
    `INSERT INTO notification_deliveries
       (shop_id, outbox_id, order_id, order_number, topic, channel, status,
        accepted_at, failed_at, retry_of_delivery_id)
     VALUES ($1,$2,$3,CASE WHEN $3::uuid IS NULL THEN NULL ELSE 1 END,
             'order.created','email',$4,
             CASE WHEN $4 = 'accepted' THEN now() END,
             CASE WHEN $4 = 'failed' THEN now() END,$5)
     RETURNING id`,
    [shopId, outboxId, orderId, status, retryOf],
  )).rows[0].id;
}

async function cleanup(s) {
  await owner.query(`DELETE FROM order_events WHERE shop_id = ANY($1::uuid[])`, [[s.A, s.B]]);
  if (s.outboxIds.length) {
    await owner.query(
      `DELETE FROM notification_deliveries
        WHERE (outbox_id = ANY($1::bigint[]) OR retry_of_delivery_id IN (
          SELECT id FROM notification_deliveries WHERE outbox_id = ANY($1::bigint[])
        )) AND retry_of_delivery_id IS NOT NULL`,
      [s.outboxIds],
    );
    await owner.query(`DELETE FROM notification_deliveries WHERE outbox_id = ANY($1::bigint[])`, [s.outboxIds]);
    await owner.query(`DELETE FROM outbox WHERE id = ANY($1::bigint[])`, [s.outboxIds]);
  }
  await owner.query(`DELETE FROM orders WHERE shop_id = ANY($1::uuid[])`, [[s.A, s.B]]);
  await owner.query(`DELETE FROM shops WHERE id = ANY($1::uuid[])`, [[s.A, s.B]]);
}

async function rejectedInTransaction(c, query, params, code = '42501') {
  await c.query('SAVEPOINT notification_rejected');
  try {
    await assert.rejects(c.query(query, params), (e) => e.code === code);
  } finally {
    await c.query('ROLLBACK TO SAVEPOINT notification_rejected');
    await c.query('RELEASE SAVEPOINT notification_rejected');
  }
}

async function withSeller(shopId, fn) {
  const c = await rw.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]);
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

const insertWorkerEvent = (values) => worker.query(
  `INSERT INTO order_events
     (shop_id, order_id, event_type, actor_type, source, payload)
   VALUES ($1,$2,$3,'system','worker',$4)`,
  values,
);

describe('0166 tham chiếu delivery null-safe', () => {
  test('role trigger là NOLOGIN và không thể bypass RLS', async () => {
    const role = (await owner.query(`
      SELECT rolcanlogin, rolsuper, rolbypassrls
        FROM pg_roles WHERE rolname = 'app_notification_integrity'
    `)).rows[0];
    assert.deepEqual(role, { rolcanlogin: false, rolsuper: false, rolbypassrls: false });

    const locks = (await owner.query(`
      SELECT tablename, cmd, qual, with_check
        FROM pg_policies
       WHERE schemaname = 'public'
         AND policyname IN (
           'notification_integrity_outbox_lock',
           'notification_integrity_delivery_lock'
         )
       ORDER BY tablename
    `)).rows;
    assert.deepEqual(locks, [
      { tablename: 'notification_deliveries', cmd: 'UPDATE', qual: 'true', with_check: 'false' },
      { tablename: 'outbox', cmd: 'UPDATE', qual: 'true', with_check: 'false' },
    ]);
  });

  test('outbox và retry luôn tồn tại, cùng tenant kể cả scope platform NULL', async () => {
    const s = await seed();
    try {
      const outboxA = await addOutbox(s, s.A);
      const crossOutboxA = await addOutbox(s, s.A);
      const platformOutbox = await addOutbox(s, null);
      const retryOutbox = await addOutbox(s, null);
      const deliveryA = await addDelivery({ shopId: s.A, outboxId: outboxA, orderId: s.orderA });
      const platformDelivery = await addDelivery({ shopId: null, outboxId: platformOutbox, status: 'failed' });

      const lockRole = await owner.connect();
      try {
        await lockRole.query('BEGIN');
        await lockRole.query('SET LOCAL ROLE app_notification_integrity');
        await assert.rejects(
          lockRole.query(`UPDATE outbox SET id = id WHERE id = $1`, [outboxA]),
          (e) => e.code === '42501',
          'role bảo toàn chỉ được khóa outbox, không được UPDATE thật',
        );
        await lockRole.query('ROLLBACK');
        await lockRole.query('BEGIN');
        await lockRole.query('SET LOCAL ROLE app_notification_integrity');
        await assert.rejects(
          lockRole.query(`UPDATE notification_deliveries SET id = id WHERE id = $1`, [deliveryA]),
          (e) => e.code === '42501',
          'role bảo toàn chỉ được khóa delivery, không được UPDATE thật',
        );
        await lockRole.query('ROLLBACK');
      } finally {
        lockRole.release();
      }

      await assert.rejects(
        addDelivery({ shopId: null, outboxId: crossOutboxA }),
        (e) => e.code === '23503',
        'shop_id NULL không được làm FK bỏ qua outbox thuộc shop',
      );
      await assert.rejects(
        addDelivery({ shopId: null, outboxId: 9_223_372_036_854_770_000n }),
        (e) => e.code === '23503',
        'outbox không tồn tại phải bị chặn cả ở scope platform',
      );
      await assert.rejects(
        addDelivery({ shopId: null, outboxId: retryOutbox, retryOf: deliveryA }),
        (e) => e.code === '23503',
        'platform delivery không được retry delivery của shop',
      );
      await assert.rejects(
        addDelivery({ shopId: null, outboxId: retryOutbox, retryOf: randomUUID() }),
        (e) => e.code === '23503',
        'retry_of_delivery_id không tồn tại phải bị chặn',
      );

      const validRetry = await addDelivery({
        shopId: null,
        outboxId: retryOutbox,
        retryOf: platformDelivery,
      });
      assert.match(validRetry, /^[0-9a-f-]{36}$/i);
      await assert.rejects(
        owner.query(`DELETE FROM outbox WHERE id = $1`, [platformOutbox]),
        (e) => e.code === '23503',
        'không được xóa outbox platform khi delivery còn tham chiếu',
      );
      await assert.rejects(
        owner.query(`UPDATE outbox SET shop_id = $1 WHERE id = $2`, [s.A, platformOutbox]),
        (e) => e.code === '23503',
        'không được đổi scope outbox platform làm delivery mồ côi',
      );
      await assert.rejects(
        owner.query(`DELETE FROM notification_deliveries WHERE id = $1`, [platformDelivery]),
        (e) => e.code === '23503',
        'không được xóa delivery cha khi lần retry platform còn tham chiếu',
      );
    } finally { await cleanup(s); }
  });
});

describe('0166 seller transition guard', () => {
  test('seller chỉ được failed -> superseded sau khi tạo outbox gửi lại', async () => {
    const s = await seed();
    try {
      const originalOutbox = await addOutbox(s, s.A);
      const deliveryId = await addDelivery({
        shopId: s.A,
        outboxId: originalOutbox,
        orderId: s.orderA,
        status: 'failed',
      });

      const privileges = (await owner.query(`
        SELECT has_column_privilege('app_rw','notification_deliveries','status','UPDATE') AS status,
               has_column_privilege('app_rw','notification_deliveries','superseded_at','UPDATE') AS superseded_at,
               has_column_privilege('app_rw','notification_deliveries','updated_at','UPDATE') AS updated_at
      `)).rows[0];
      assert.equal(privileges.status, true);
      assert.equal(privileges.superseded_at, false);
      assert.equal(privileges.updated_at, false);

      await withSeller(s.A, async (c) => {
        await rejectedInTransaction(
          c,
          `UPDATE notification_deliveries SET status = 'accepted' WHERE id = $1`,
          [deliveryId],
        );
        await rejectedInTransaction(
          c,
          `UPDATE notification_deliveries SET status = 'superseded' WHERE id = $1`,
          [deliveryId],
        );

        const retry = await c.query(
          `INSERT INTO outbox (shop_id, topic, payload, processed_at)
           VALUES (current_shop_id(), 'order.created', $1, now())
           RETURNING id`,
          [{ retry_of_delivery_id: deliveryId }],
        );
        s.outboxIds.push(Number(retry.rows[0].id));
        const changed = await c.query(
          `UPDATE notification_deliveries SET status = 'superseded'
            WHERE id = $1 RETURNING status, superseded_at, updated_at`,
          [deliveryId],
        );
        assert.equal(changed.rowCount, 1);
        assert.equal(changed.rows[0].status, 'superseded');
        assert.ok(changed.rows[0].superseded_at);
        assert.ok(changed.rows[0].updated_at);

        await rejectedInTransaction(
          c,
          `UPDATE notification_deliveries SET status = 'failed' WHERE id = $1`,
          [deliveryId],
        );
      });
    } finally { await cleanup(s); }
  });
});

describe('0166 worker notification timeline policy', () => {
  test('worker chỉ ghi event trỏ đúng delivery, shop, order, payload và trạng thái terminal', async () => {
    const s = await seed();
    try {
      const outboxAccepted = await addOutbox(s, s.A);
      const outboxFailed = await addOutbox(s, s.B);
      const accepted = await addDelivery({
        shopId: s.A,
        outboxId: outboxAccepted,
        orderId: s.orderA,
        status: 'accepted',
      });
      const failed = await addDelivery({
        shopId: s.B,
        outboxId: outboxFailed,
        orderId: s.orderB,
        status: 'failed',
      });
      const payload = (deliveryId) => ({
        delivery_id: deliveryId,
        channel: 'email',
        topic: 'order.created',
        attempts: 1,
      });

      assert.equal((await insertWorkerEvent([
        s.A, s.orderA, 'notification.sent', payload(accepted),
      ])).rowCount, 1);
      assert.equal((await insertWorkerEvent([
        s.B, s.orderB, 'notification.failed', payload(failed),
      ])).rowCount, 1, 'worker không tenant context vẫn ghi được delivery hợp lệ của shop khác');

      await assert.rejects(
        insertWorkerEvent([s.B, s.orderB, 'notification.sent', payload(failed)]),
        (e) => e.code === '42501',
        'notification.sent phải trỏ delivery accepted',
      );
      await assert.rejects(
        insertWorkerEvent([s.A, s.orderA2, 'notification.sent', payload(accepted)]),
        (e) => e.code === '42501',
        'delivery đúng shop nhưng sai order phải bị chặn',
      );
      await assert.rejects(
        insertWorkerEvent([s.B, s.orderB, 'notification.sent', payload(accepted)]),
        (e) => e.code === '42501',
        'worker xuyên shop không được nối delivery shop A vào event shop B',
      );
      await assert.rejects(
        insertWorkerEvent([s.A, s.orderA, 'notification.sent', payload(randomUUID())]),
        (e) => e.code === '42501',
        'delivery_id không tồn tại phải bị chặn',
      );
      await assert.rejects(
        insertWorkerEvent([s.A, s.orderA, 'notification.sent', {
          ...payload(accepted), channel: 'telegram',
        }]),
        (e) => e.code === '42501',
        'payload không được khai sai kênh của delivery',
      );
    } finally { await cleanup(s); }
  });
});
