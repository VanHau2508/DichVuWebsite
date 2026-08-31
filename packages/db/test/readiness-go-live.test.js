/**
 * Cửa hẹp go-live ở tầng DB (0165).
 *
 * HTTP readiness vẫn là nơi dựng checklist chi tiết cho người dùng. Các test này khóa phần
 * quyền nền: app_rw không thể tự UPDATE lifecycle, hàm không nhận shop_id nên không thể chạm
 * tenant khác, còn app_platform vẫn vận hành suspend/reactivate như trước.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { rw, owner, withTenant, withIntegrationTenant, sqlstateOf, SQLSTATE, closeAll } from './helpers.js';

const platform = new pg.Pool({ connectionString: process.env.DATABASE_URL_PLATFORM, max: 2 });
const made = [];

async function makeShop(label) {
  const tag = randomUUID().slice(0, 8);
  const row = (await owner.query(
    `INSERT INTO shops (slug, name, status)
     VALUES ($1, $2, 'onboarding') RETURNING id, name`,
    [`go-live-${label}-${tag}`, `Go live ${label} ${tag}`],
  )).rows[0];
  made.push(row.id);
  return row;
}

async function makeReady(shopId) {
  await owner.query(
    `UPDATE shops
        SET contact_phone = '0901234567', ship_mode = 'region', ship_fee_vnd = 30000
      WHERE id = $1`,
    [shopId],
  );
  await owner.query(
    `INSERT INTO domains (shop_id, hostname, verification_token, verified_at)
     VALUES ($1, $2, $3, now())`,
    [shopId, `ready-${shopId.slice(0, 12)}.nentang.vn`, randomUUID()],
  );

  const product = (await owner.query(
    `INSERT INTO products (shop_id, slug, title, price_vnd, status)
     VALUES ($1, $2, 'Sản phẩm readiness', 120000, 'active') RETURNING id`,
    [shopId, `san-pham-${randomUUID().slice(0, 8)}`],
  )).rows[0];
  const variant = (await owner.query(
    `INSERT INTO variants (shop_id, product_id, sku, price_vnd)
     VALUES ($1, $2, $3, 120000) RETURNING id`,
    [shopId, product.id, `READY-${randomUUID().slice(0, 8)}`],
  )).rows[0];
  await owner.query(
    `INSERT INTO inventory_levels (shop_id, variant_id, on_hand, reserved)
     VALUES ($1, $2, 10, 0)`,
    [shopId, variant.id],
  );

  for (const [slug, title] of [
    ['chinh-sach-mua-hang', 'Chính sách mua hàng'],
    ['chinh-sach-bao-mat', 'Chính sách bảo mật'],
  ]) {
    const page = (await owner.query(
      `INSERT INTO pages (shop_id, slug, title, blocks)
       VALUES ($1, $2, $3, '[]'::jsonb) RETURNING id`,
      [shopId, slug, title],
    )).rows[0];
    const revision = (await owner.query(
      `INSERT INTO page_revisions (shop_id, page_id, revision, title, blocks)
       VALUES ($1, $2, 1, $3, '[]'::jsonb) RETURNING id`,
      [shopId, page.id, title],
    )).rows[0];
    await owner.query(
      `UPDATE pages SET status = 'published', published_revision_id = $2 WHERE id = $1`,
      [page.id, revision.id],
    );
  }
  return { productId: product.id, variantId: variant.id };
}

async function attachExternal(shopId, variantId, {
  status = 'active', generation = 0, refGeneration = generation,
  mappingStatus = 'mapped', stale = true,
  } = {}) {
  const integration = (await owner.query(
    `INSERT INTO shop_integrations
       (shop_id, provider, status, inventory_authority, credential_ciphertext,
        webhook_public_id, external_branch_ref, generation)
     VALUES ($1, 'kiotviet', $2, 'external_master', 'fixture-credential', gen_random_uuid(), 'branch-1', $3)
     RETURNING id`, [shopId, status, generation],
  )).rows[0];
  await withIntegrationTenant(shopId, async (c) => {
    const stamped = mappingStatus === 'mapped';
    await c.query(
      `SELECT set_config('app.integration_id', $1, true),
              set_config('app.integration_generation', $2, true)`,
      [integration.id, String(refGeneration)],
    );
    await c.query(
      `INSERT INTO integration_entity_refs
         (shop_id, integration_id, entity_type, external_id, local_id, mapping_status,
          inventory_synced_at, inventory_generation)
       VALUES ($1, $2, 'variant', $3, $4, $5,
               CASE WHEN $6 THEN CASE WHEN $7 THEN now() - interval '10 minutes' ELSE now() END END,
               CASE WHEN $6 THEN $8::bigint ELSE NULL END)`,
      [shopId, integration.id, `fixture-${randomUUID()}`, variantId, mappingStatus, stamped, stale, refGeneration],
    );
  });
  return integration;
}

async function assertGuardBlocked(shopId, label) {
  const result = await withTenant(shopId, (c) => c.query(
    `SELECT status, went_live_at FROM activate_current_shop_after_readiness()`,
  ));
  assert.equal(result.rowCount, 0, `${label}: hàm không được mở shop`);
  const state = (await owner.query(
    `SELECT status, went_live_at FROM shops WHERE id=$1`, [shopId],
  )).rows[0];
  assert.equal(state.status, 'onboarding', `${label}: status phải giữ onboarding`);
  assert.equal(state.went_live_at, null, `${label}: không được tự đóng mốc go-live`);
}

after(async () => {
  if (made.length) {
    await owner.query(`UPDATE pages SET published_revision_id = NULL WHERE shop_id = ANY($1::uuid[])`, [made]);
    await owner.query(`DELETE FROM integration_entity_refs WHERE shop_id = ANY($1::uuid[])`, [made]);
    await owner.query(`DELETE FROM shop_integrations WHERE shop_id = ANY($1::uuid[])`, [made]);
    for (const table of ['page_revisions', 'pages', 'inventory_levels', 'variants', 'products', 'domains']) {
      await owner.query(`DELETE FROM ${table} WHERE shop_id = ANY($1::uuid[])`, [made]);
    }
    await owner.query(`DELETE FROM shops WHERE id = ANY($1::uuid[])`, [made]);
  }
  await Promise.all([platform.end(), closeAll()]);
});

test('app_rw không thể UPDATE status/went_live_at nhưng vẫn sửa được hồ sơ hợp lệ', async () => {
  const shop = await makeShop('privilege');

  const statusState = await sqlstateOf(() => withTenant(shop.id, (c) => c.query(
    `UPDATE shops SET status = 'active' WHERE id = current_shop_id()`,
  )));
  assert.equal(statusState, SQLSTATE.INSUFFICIENT_PRIVILEGE);

  const liveAtState = await sqlstateOf(() => withTenant(shop.id, (c) => c.query(
    `UPDATE shops SET went_live_at = now() WHERE id = current_shop_id()`,
  )));
  assert.equal(liveAtState, SQLSTATE.INSUFFICIENT_PRIVILEGE);

  const changed = await withTenant(shop.id, (c) => c.query(
    `UPDATE shops SET name = $1 WHERE id = current_shop_id() RETURNING name`,
    ['Tên hồ sơ hợp lệ'],
  ));
  assert.equal(changed.rowCount, 1);
  assert.equal(changed.rows[0].name, 'Tên hồ sơ hợp lệ');
});

test('hàm go-live tự chặn shop chưa ready rồi chỉ chuyển đúng shop hiện tại một lần', async () => {
  const a = await makeShop('a');
  const b = await makeShop('b');

  const noContext = await sqlstateOf(() => rw.query(
    `SELECT * FROM activate_current_shop_after_readiness()`,
  ));
  assert.equal(noContext, SQLSTATE.INSUFFICIENT_PRIVILEGE);

  const premature = await withTenant(a.id, (c) => c.query(
    `SELECT status, went_live_at FROM activate_current_shop_after_readiness()`,
  ));
  assert.equal(premature.rowCount, 0, 'không route nào được gọi hàm để mở shop thiếu checklist');
  assert.equal((await owner.query(`SELECT status FROM shops WHERE id=$1`, [a.id])).rows[0].status, 'onboarding');

  await makeReady(a.id);
  const first = await withTenant(a.id, (c) => c.query(
    `SELECT status, went_live_at FROM activate_current_shop_after_readiness()`,
  ));
  assert.equal(first.rowCount, 1);
  assert.equal(first.rows[0].status, 'active');
  assert.ok(first.rows[0].went_live_at);

  const state = (await owner.query(
    `SELECT id, status, went_live_at FROM shops WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [[a.id, b.id]],
  )).rows;
  const byId = new Map(state.map((row) => [row.id, row]));
  assert.equal(byId.get(a.id).status, 'active');
  assert.ok(byId.get(a.id).went_live_at);
  assert.equal(byId.get(b.id).status, 'onboarding');
  assert.equal(byId.get(b.id).went_live_at, null);

  const replay = await withTenant(a.id, (c) => c.query(
    `SELECT status, went_live_at FROM activate_current_shop_after_readiness()`,
  ));
  assert.equal(replay.rowCount, 0, 'active không được đóng lại mốc went_live_at');
});

test('hàm DB tự kiểm từng blocker catalog/ATS/orphan/shipping/contact/policy/domain/dry-total', async () => {
  const shop = await makeShop('blockers');
  const fixture = await makeReady(shop.id);

  await owner.query(`UPDATE products SET status='archived' WHERE id=$1`, [fixture.productId]);
  await assertGuardBlocked(shop.id, 'catalog');
  await owner.query(`UPDATE products SET status='active' WHERE id=$1`, [fixture.productId]);

  await owner.query(`UPDATE inventory_levels SET on_hand=0 WHERE variant_id=$1`, [fixture.variantId]);
  await assertGuardBlocked(shop.id, 'ATS');
  await owner.query(`UPDATE inventory_levels SET on_hand=10 WHERE variant_id=$1`, [fixture.variantId]);

  const option = (await owner.query(
    `INSERT INTO product_options (shop_id, product_id, name) VALUES ($1, $2, 'Màu') RETURNING id`,
    [shop.id, fixture.productId],
  )).rows[0];
  await assertGuardBlocked(shop.id, 'variant orphan');
  await owner.query(`DELETE FROM product_options WHERE id=$1`, [option.id]);

  await owner.query(`UPDATE shops SET ship_fee_vnd=NULL WHERE id=$1`, [shop.id]);
  await assertGuardBlocked(shop.id, 'shipping');
  await owner.query(`UPDATE shops SET ship_fee_vnd=30000 WHERE id=$1`, [shop.id]);

  await owner.query(`UPDATE shops SET contact_phone=NULL, contact_email=NULL WHERE id=$1`, [shop.id]);
  await assertGuardBlocked(shop.id, 'contact');
  await owner.query(`UPDATE shops SET contact_phone='0901234567' WHERE id=$1`, [shop.id]);

  await owner.query(
    `UPDATE pages SET status='draft' WHERE shop_id=$1 AND slug='chinh-sach-mua-hang'`, [shop.id],
  );
  await assertGuardBlocked(shop.id, 'purchase policy');
  await owner.query(
    `UPDATE pages SET status='published' WHERE shop_id=$1 AND slug='chinh-sach-mua-hang'`, [shop.id],
  );

  await owner.query(
    `UPDATE pages SET status='draft' WHERE shop_id=$1 AND slug='chinh-sach-bao-mat'`, [shop.id],
  );
  await assertGuardBlocked(shop.id, 'privacy policy');
  await owner.query(
    `UPDATE pages SET status='published' WHERE shop_id=$1 AND slug='chinh-sach-bao-mat'`, [shop.id],
  );

  await owner.query(`UPDATE domains SET verified_at=NULL WHERE shop_id=$1`, [shop.id]);
  await assertGuardBlocked(shop.id, 'domain');
  await owner.query(`UPDATE domains SET verified_at=now() WHERE shop_id=$1`, [shop.id]);

  await owner.query(`UPDATE variants SET price_vnd=9007199254740992 WHERE id=$1`, [fixture.variantId]);
  await assertGuardBlocked(shop.id, 'dry total');
  await owner.query(`UPDATE variants SET price_vnd=120000 WHERE id=$1`, [fixture.variantId]);

  const activated = await withTenant(shop.id, (c) => c.query(
    `SELECT status, went_live_at FROM activate_current_shop_after_readiness()`,
  ));
  assert.equal(activated.rowCount, 1, 'đủ lại mọi blocker thì hàm mới mở shop');
  assert.equal(activated.rows[0].status, 'active');
});

test('hàm DB mirror blocker external-master bền vững nhưng không hồi tố freshness', async () => {
  const degraded = await makeShop('external-degraded');
  const degradedFixture = await makeReady(degraded.id);
  await attachExternal(degraded.id, degradedFixture.variantId, { status: 'degraded' });
  await assertGuardBlocked(degraded.id, 'external connector degraded');

  const unmapped = await makeShop('external-unmapped');
  const unmappedFixture = await makeReady(unmapped.id);
  await attachExternal(unmapped.id, unmappedFixture.variantId, { mappingStatus: 'unmapped' });
  await assertGuardBlocked(unmapped.id, 'external ref chưa mapped');

  const wrongGeneration = await makeShop('external-generation');
  const wrongGenerationFixture = await makeReady(wrongGeneration.id);
  await attachExternal(wrongGeneration.id, wrongGenerationFixture.variantId, { generation: 7, refGeneration: 6 });
  await assertGuardBlocked(wrongGeneration.id, 'external ref lệch generation');

  const stale = await makeShop('external-stale');
  const staleFixture = await makeReady(stale.id);
  await attachExternal(stale.id, staleFixture.variantId, { generation: 3, stale: true });
  const staleOpened = await withTenant(stale.id, (c) => c.query(
    `SELECT status, went_live_at FROM activate_current_shop_after_readiness()`,
  ));
  assert.equal(staleOpened.rowCount, 1, 'freshness là chốt nhất thời của readiness/checkout, không phải DB go-live');
  assert.equal(staleOpened.rows[0].status, 'active');

  const local = await makeShop('local-no-connector');
  await makeReady(local.id);
  const localOpened = await withTenant(local.id, (c) => c.query(
    `SELECT status, went_live_at FROM activate_current_shop_after_readiness()`,
  ));
  assert.equal(localOpened.rowCount, 1, 'shop local không bị siết nhầm bởi chốt connector');
  assert.equal(localOpened.rows[0].status, 'active');

  const alreadyActive = await makeShop('already-active');
  await makeReady(alreadyActive.id);
  const first = await withTenant(alreadyActive.id, (c) => c.query(
    `SELECT status, went_live_at FROM activate_current_shop_after_readiness()`,
  ));
  const second = await withTenant(alreadyActive.id, (c) => c.query(
    `SELECT status, went_live_at FROM activate_current_shop_after_readiness()`,
  ));
  assert.equal(first.rowCount, 1);
  assert.equal(second.rowCount, 0, 'shop active sẵn không bị hàm hồi tố');
});

test('app_platform vẫn suspend/reactivate shop mà không làm mất mốc go-live', async () => {
  const shop = await makeShop('platform');
  await makeReady(shop.id);
  const activated = await withTenant(shop.id, (c) => c.query(
    `SELECT status, went_live_at FROM activate_current_shop_after_readiness()`,
  ));
  const originalLiveAt = activated.rows[0].went_live_at;

  let changed = await platform.query(
    `UPDATE shops SET status = 'suspended' WHERE id = $1 RETURNING status, went_live_at`,
    [shop.id],
  );
  assert.equal(changed.rows[0].status, 'suspended');
  assert.deepEqual(changed.rows[0].went_live_at, originalLiveAt);

  changed = await platform.query(
    `UPDATE shops SET status = 'active' WHERE id = $1 RETURNING status, went_live_at`,
    [shop.id],
  );
  assert.equal(changed.rows[0].status, 'active');
  assert.deepEqual(changed.rows[0].went_live_at, originalLiveAt);
});
