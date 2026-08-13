/**
 * Bảo mật tài khoản khách (0083) — kiểm ở tầng DB: grant least-priv + RLS cô lập + 4 must-fix
 * red-team. Đây là bảng "vương miện": ghi = chiếm tài khoản. Test là bức tường cuối.
 *  #1 nhận-đơn-cũ gate bằng GUC app.claim_token_hash (không rò PII đơn vãng lai).
 *  #2 customers/sessions SELF-scoped (khách A không ghi đè MK khách B).
 *  #4 app_rw KHÔNG đọc/ghi password_hash.
 */
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { owner } from './helpers.js';

const cust = new pg.Pool({ connectionString: process.env.DATABASE_URL_CUSTOMER, max: 4 });
const rw = new pg.Pool({ connectionString: process.env.DATABASE_URL_RW, max: 3 });
after(async () => { await Promise.all([cust.end(), rw.end()]); });

const sha = (s) => createHash('sha256').update(s).digest('hex');
// Chạy fn dưới vai + GUC (shop/customer/claim-token) trong 1 transaction; ROLLBACK cuối.
async function ctx(pool, { shop, customer, claim, commit }, fn) {
  const c = await pool.connect();
  let done = false;
  try {
    await c.query('BEGIN');
    if (shop) await c.query(`SELECT set_config('app.shop_id', $1, true)`, [shop]);
    if (customer) await c.query(`SELECT set_config('app.customer_id', $1, true)`, [customer]);
    if (claim) await c.query(`SELECT set_config('app.claim_token_hash', $1, true)`, [claim]);
    const r = await fn(c);
    if (commit) { await c.query('COMMIT'); done = true; }
    return r;
  } finally { if (!done) await c.query('ROLLBACK').catch(() => {}); c.release(); }
}
const colPriv = (role, table, col, priv) =>
  owner.query(`SELECT has_column_privilege($1,$2,$3,$4) AS ok`, [role, table, col, priv]).then((r) => r.rows[0].ok);
const tblPriv = (role, table, priv) =>
  owner.query(`SELECT has_table_privilege($1,$2,$3) AS ok`, [role, table, priv]).then((r) => r.rows[0].ok);

async function seed() {
  const tag = randomUUID().slice(0, 8);
  const mkShop = async (k) => (await owner.query(`INSERT INTO shops (slug,name,status) VALUES ($1,$2,'active') RETURNING id`, [`cust-${k}-${tag}`, `Shop ${k}`])).rows[0].id;
  const A = await mkShop('a'), B = await mkShop('b');
  const mkCust = async (shop, email) => (await owner.query(`INSERT INTO customers (shop_id,email,password_hash,full_name) VALUES ($1,$2,'HASH-'||$2,'Tên') RETURNING id`, [shop, email])).rows[0].id;
  const a1 = await mkCust(A, `a1-${tag}@x.vn`), a2 = await mkCust(A, `a2-${tag}@x.vn`), b1 = await mkCust(B, `b1-${tag}@x.vn`);
  await owner.query(`INSERT INTO customer_addresses (shop_id,customer_id,recipient_name,phone,line1) VALUES ($1,$2,'A2','09','L')`, [A, a2]);
  // Đơn: 1 gán cho a1, 1 vãng lai (customer_id NULL) có lookup_token.
  const tok = randomUUID() + randomUUID();
  const mkOrder = async (shop, num, custId, token) => (await owner.query(
    `INSERT INTO orders (shop_id,order_number,total_vnd,customer_id,lookup_token_hash,customer_name,customer_phone) VALUES ($1,$2,100000,$3,$4,'Khách','0900') RETURNING id`,
    [shop, num, custId, token ? sha(token) : null])).rows[0].id;
  const oA1 = await mkOrder(A, 1, a1, null);
  const oGuest = await mkOrder(A, 2, null, tok);
  return { A, B, a1, a2, b1, oA1, oGuest, tok, tag };
}
const cleanup = async (s) => {
  for (const t of ['order_lines', 'orders', 'customer_addresses', 'customer_sessions', 'customer_password_reset_tokens', 'customer_email_verifications', 'customers'])
    await owner.query(`DELETE FROM ${t} WHERE shop_id = ANY($1::uuid[])`, [[s.A, s.B]]);
  await owner.query(`DELETE FROM shops WHERE id = ANY($1::uuid[])`, [[s.A, s.B]]);
};

describe('0083 grant least-priv', () => {
  test('app_store KHÔNG có quyền nào trên 5 bảng khách', async () => {
    for (const t of ['customers', 'customer_sessions', 'customer_addresses', 'customer_password_reset_tokens', 'customer_email_verifications'])
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
        assert.equal(await tblPriv('app_store', t, p), false, `app_store ${p} ${t}`);
  });
  test('#4 app_rw KHÔNG đọc/ghi password_hash; đọc/ghi được cột thường', async () => {
    assert.equal(await colPriv('app_rw', 'customers', 'password_hash', 'SELECT'), false, 'app_rw SELECT password_hash');
    assert.equal(await colPriv('app_rw', 'customers', 'password_hash', 'UPDATE'), false, 'app_rw UPDATE password_hash (must-fix #4)');
    assert.equal(await colPriv('app_rw', 'customers', 'email', 'SELECT'), true);
    assert.equal(await colPriv('app_rw', 'customers', 'email', 'UPDATE'), true, 'app_rw ẩn danh được email');
    assert.equal(await colPriv('app_rw', 'customers', 'email_verified_at', 'UPDATE'), false, 'app_rw KHÔNG giả xác minh email');
    assert.equal(await tblPriv('app_rw', 'customers', 'INSERT'), false, 'app_rw KHÔNG tạo tài khoản');
    assert.equal(await tblPriv('app_rw', 'customer_sessions', 'INSERT'), false, 'app_rw KHÔNG mint phiên khách');
  });
  test('app_checkout đọc customers KHÔNG gồm password_hash', async () => {
    assert.equal(await colPriv('app_checkout', 'customers', 'password_hash', 'SELECT'), false);
    assert.equal(await colPriv('app_checkout', 'customers', 'email', 'SELECT'), true);
    assert.equal(await tblPriv('app_checkout', 'customers', 'UPDATE'), false, 'checkout không ghi customers');
  });
  test('app_customer KHÔNG đọc order_lines.unit_cost_vnd (giá vốn 0081)', async () => {
    assert.equal(await colPriv('app_customer', 'order_lines', 'unit_cost_vnd', 'SELECT'), false);
    assert.equal(await colPriv('app_customer', 'order_lines', 'unit_price_vnd', 'SELECT'), true);
  });
});

describe('0083 RLS cô lập + must-fix', () => {
  test('cô lập tenant: shop B không thấy khách/địa chỉ/đơn shop A', async () => {
    const s = await seed();
    try {
      await ctx(cust, { shop: s.B, customer: s.b1 }, async (c) => {
        assert.equal((await c.query(`SELECT count(*)::int n FROM customers`)).rows[0].n, 1, 'shop B chỉ thấy khách của B');
        assert.equal((await c.query(`SELECT count(*)::int n FROM orders`)).rows[0].n, 0, 'shop B không thấy đơn shop A');
      });
      // Cùng email đăng ký được ở 2 shop (per-store) — email a1 của shop A, đăng ký ở shop B.
      await ctx(cust, { shop: s.B }, async (c) => {
        const email = (await owner.query(`SELECT email FROM customers WHERE id=$1`, [s.a1])).rows[0].email;
        await c.query(`INSERT INTO customers (shop_id,email,password_hash) VALUES (current_shop_id(),$1,'H')`, [email]);
        assert.ok(true, 'cùng email đăng ký ở shop B thành công (2 tài khoản độc lập)');
      });
    } finally { await cleanup(s); }
  });

  test('#2 IDOR: khách A1 KHÔNG đọc/ghi được customer/địa chỉ của A2 (cùng shop)', async () => {
    const s = await seed();
    try {
      await ctx(cust, { shop: s.A, customer: s.a1 }, async (c) => {
        // Chỉ thấy CHÍNH MÌNH trong customers (self-scoped).
        const n = (await c.query(`SELECT count(*)::int n FROM customers`)).rows[0].n;
        assert.equal(n, 1, 'customers self-scoped: chỉ thấy a1');
        // Ghi đè MK của A2 (dù cố ý WHERE id=A2) → 0 dòng (RLS chặn — must-fix #2).
        const upd = await c.query(`UPDATE customers SET password_hash='HACKED' WHERE id=$1`, [s.a2]);
        assert.equal(upd.rowCount, 0, 'khách A1 KHÔNG ghi đè được MK A2');
        // Địa chỉ của A2 → 0 dòng.
        assert.equal((await c.query(`SELECT count(*)::int n FROM customer_addresses WHERE customer_id=$1`, [s.a2])).rows[0].n, 0, 'không đọc địa chỉ A2');
      });
      // A2's hash còn nguyên.
      const h = (await owner.query(`SELECT password_hash FROM customers WHERE id=$1`, [s.a2])).rows[0].password_hash;
      assert.notEqual(h, 'HACKED', 'MK A2 nguyên vẹn');
    } finally { await cleanup(s); }
  });

  test('#2 pre-auth (cid NULL): tra được khách theo email; self-write vẫn được sau auth', async () => {
    const s = await seed();
    try {
      // Pre-auth login: chưa set customer_id → shop-scoped → tra được mọi email của shop (để verify MK).
      await ctx(cust, { shop: s.A }, async (c) => {
        const n = (await c.query(`SELECT count(*)::int n FROM customers`)).rows[0].n;
        assert.ok(n >= 2, 'pre-auth thấy cả a1,a2 để login theo email');
      });
      // Post-auth self-write: a1 đổi tên CHÍNH MÌNH → 1 dòng.
      await ctx(cust, { shop: s.A, customer: s.a1 }, async (c) => {
        const upd = await c.query(`UPDATE customers SET full_name='Mới' WHERE id=current_customer_id()`);
        assert.equal(upd.rowCount, 1, 'self-write được');
      });
    } finally { await cleanup(s); }
  });

  test('#1 nhận-đơn-cũ: KHÔNG token → không thấy/không nhận đơn vãng lai; ĐÚNG token → nhận đúng 1', async () => {
    const s = await seed();
    try {
      // Khách A1 KHÔNG có claim token: KHÔNG thấy đơn vãng lai (customer_id NULL) → chống rò PII hàng loạt.
      await ctx(cust, { shop: s.A, customer: s.a1 }, async (c) => {
        const n = (await c.query(`SELECT count(*)::int n FROM orders WHERE customer_id IS NULL`)).rows[0].n;
        assert.equal(n, 0, 'không token → KHÔNG đọc được đơn vãng lai của người khác (must-fix #1)');
        // Blind claim KHÔNG token → 0 dòng.
        const upd = await c.query(`UPDATE orders SET customer_id=current_customer_id() WHERE order_number=2 AND customer_id IS NULL`);
        assert.equal(upd.rowCount, 0, 'không token → claim thất bại');
      });
      // Có ĐÚNG token: nhận được + COMMIT để kiểm persistence + chống-cướp bên dưới.
      await ctx(cust, { shop: s.A, customer: s.a1, claim: sha(s.tok), commit: true }, async (c) => {
        const upd = await c.query(`UPDATE orders SET customer_id=current_customer_id() WHERE order_number=2 AND customer_id IS NULL AND lookup_token_hash=current_claim_token_hash()`);
        assert.equal(upd.rowCount, 1, 'đúng token → nhận đúng 1 đơn');
      });
      const owned = (await owner.query(`SELECT customer_id FROM orders WHERE id=$1`, [s.oGuest])).rows[0].customer_id;
      assert.equal(owned, s.a1, 'đơn vãng lai giờ thuộc a1');
      // SAI token → không nhận (dùng token ngẫu nhiên khác).
      const s2 = await seed();
      await ctx(cust, { shop: s2.A, customer: s2.a1, claim: sha('token-sai-hoan-toan') }, async (c) => {
        const upd = await c.query(`UPDATE orders SET customer_id=current_customer_id() WHERE order_number=2 AND customer_id IS NULL AND lookup_token_hash=current_claim_token_hash()`);
        assert.equal(upd.rowCount, 0, 'sai token → không nhận');
      });
      await cleanup(s2);
      // Đơn ĐÃ có chủ không cướp được: b... dùng s (oGuest giờ thuộc a1). a2 thử claim với token đúng.
      await ctx(cust, { shop: s.A, customer: s.a2, claim: sha(s.tok) }, async (c) => {
        const upd = await c.query(`UPDATE orders SET customer_id=current_customer_id() WHERE order_number=2 AND customer_id IS NULL AND lookup_token_hash=current_claim_token_hash()`);
        assert.equal(upd.rowCount, 0, 'đơn đã có chủ → không cướp (customer_id IS NULL fail)');
      });
    } finally { await cleanup(s); }
  });
});

describe('0172 projection yêu thích', () => {
  test('cô lập khách/shop, tính đúng giá sale + ATS và không quick-add biến thể mồ côi/đa biến thể', async () => {
    const tag = randomUUID().slice(0, 8);
    const shopIds = [];
    const mkShop = async (key, safety = 20) => {
      const id = (await owner.query(
        `INSERT INTO shops (slug,name,status,safety_stock_pct)
         VALUES ($1,$2,'active',$3) RETURNING id`,
        [`wish-${key}-${tag}`, `Wish ${key}`, safety],
      )).rows[0].id;
      shopIds.push(id);
      return id;
    };
    const mkCustomer = async (shop, key) => (await owner.query(
      `INSERT INTO customers (shop_id,email,password_hash,status)
       VALUES ($1,$2,'HASH','active') RETURNING id`,
      [shop, `${key}-${tag}@x.vn`],
    )).rows[0].id;
    const mkProduct = async (shop, key, price) => (await owner.query(
      `INSERT INTO products (shop_id,slug,title,price_vnd,status)
       VALUES ($1,$2,$3,$4,'active') RETURNING id`,
      [shop, `${key}-${tag}`, `SP ${key}`, price],
    )).rows[0].id;
    const mkVariant = async (shop, product, key, price, position = 0) => (await owner.query(
      `INSERT INTO variants (shop_id,product_id,sku,price_vnd,position)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [shop, product, `${key}-${tag}`, price, position],
    )).rows[0].id;
    const wish = (shop, customer, product) => owner.query(
      `INSERT INTO wishlist_items (shop_id,customer_id,product_id) VALUES ($1,$2,$3)`,
      [shop, customer, product],
    );
    const project = (shop, customer) => ctx(cust, { shop, customer }, async (c) =>
      (await c.query(`SELECT * FROM current_customer_wishlist()`)).rows);

    const A = await mkShop('a');
    const B = await mkShop('b');
    const a1 = await mkCustomer(A, 'a1');
    const a2 = await mkCustomer(A, 'a2');
    const b1 = await mkCustomer(B, 'b1');

    try {
      const flat = await mkProduct(A, 'flat', 100_000);
      const flatV = await mkVariant(A, flat, 'flat-v', 100_000);
      await owner.query(
        `INSERT INTO inventory_levels (shop_id,variant_id,on_hand,reserved)
         VALUES ($1,$2,10,2)`, [A, flatV]);
      await owner.query(
        `INSERT INTO media (shop_id,product_id,status,original_key,public_key,position)
         VALUES ($1,$2,'pending',$3,NULL,-1),
                ($1,$2,'ready',$4,$5,0)`,
        [A, flat, `pending-${tag}`, `private-${tag}`, `ready-${tag}.webp`]);
      const promo = (await owner.query(
        `INSERT INTO promotions (shop_id,title,kind,value,scope,starts_at,ends_at,active)
         VALUES ($1,'Sale wishlist','percent',20,'products',now()-interval '1 hour',now()+interval '1 hour',true)
         RETURNING id`, [A])).rows[0].id;
      await owner.query(
        `INSERT INTO promotion_products (shop_id,promotion_id,product_id) VALUES ($1,$2,$3)`,
        [A, promo, flat]);

      const override = await mkProduct(A, 'override', 50_000);
      const overrideV = await mkVariant(A, override, 'override-v', 50_000);
      await owner.query(
        `INSERT INTO inventory_levels
           (shop_id,variant_id,on_hand,reserved,safety_stock_qty)
         VALUES ($1,$2,10,1,3)`, [A, overrideV]);

      const multi = await mkProduct(A, 'multi', 70_000);
      const multiV1 = await mkVariant(A, multi, 'multi-1', 70_000, 0);
      const multiV2 = await mkVariant(A, multi, 'multi-2', 75_000, 1);
      await owner.query(
        `INSERT INTO inventory_levels (shop_id,variant_id,on_hand)
         VALUES ($1,$2,5),($1,$3,4)`, [A, multiV1, multiV2]);

      const orphan = await mkProduct(A, 'orphan', 80_000);
      const orphanV = await mkVariant(A, orphan, 'orphan-v', 80_000);
      await owner.query(
        `INSERT INTO product_options (shop_id,product_id,name) VALUES ($1,$2,'Màu')`,
        [A, orphan]);
      await owner.query(
        `INSERT INTO inventory_levels (shop_id,variant_id,on_hand) VALUES ($1,$2,99)`,
        [A, orphanV]);

      const onlyA2 = await mkProduct(A, 'a2-only', 60_000);
      const onlyA2V = await mkVariant(A, onlyA2, 'a2-only-v', 60_000);
      await owner.query(
        `INSERT INTO inventory_levels (shop_id,variant_id,on_hand) VALUES ($1,$2,9)`,
        [A, onlyA2V]);

      const onlyB = await mkProduct(B, 'b-only', 40_000);
      const onlyBV = await mkVariant(B, onlyB, 'b-only-v', 40_000);
      await owner.query(
        `INSERT INTO inventory_levels (shop_id,variant_id,on_hand) VALUES ($1,$2,8)`,
        [B, onlyBV]);

      for (const product of [flat, override, multi, orphan]) await wish(A, a1, product);
      await wish(A, a2, onlyA2);
      await wish(B, b1, onlyB);

      await assert.rejects(
        () => ctx(cust, { shop: A }, (c) => c.query(`SELECT * FROM current_customer_wishlist()`)),
        (err) => err?.code === '42501',
        'thiếu customer context phải fail closed',
      );

      const rows = await project(A, a1);
      assert.equal(rows.length, 4, 'a1 chỉ thấy bốn sản phẩm chính mình đã lưu');
      assert.ok(!rows.some((r) => r.product_id === onlyA2 || r.product_id === onlyB),
        'không lộ wishlist khách khác hoặc shop khác');

      const byId = new Map(rows.map((r) => [r.product_id, r]));
      assert.deepEqual({
        base: Number(byId.get(flat).base_price_vnd),
        price: Number(byId.get(flat).price_vnd),
        off: Number(byId.get(flat).off_pct),
        image: byId.get(flat).image_key,
        ats: Number(byId.get(flat).available_qty),
        quick: byId.get(flat).default_variant_id,
      }, {
        base: 100_000,
        price: 80_000,
        off: 20,
        image: `ready-${tag}.webp`,
        ats: 6,
        quick: flatV,
      }, 'giá sale, ảnh ready và ATS phần trăm phải khớp storefront/checkout');

      assert.equal(Number(byId.get(override).available_qty), 6,
        'safety_stock_qty=3 phải thắng safety 20% (=2)');
      assert.equal(byId.get(override).default_variant_id, overrideV);
      assert.equal(Number(byId.get(multi).available_qty), 7,
        'ATS đa biến thể là tổng ATS từng biến thể');
      assert.equal(byId.get(multi).default_variant_id, null,
        'đa biến thể không được tự chọn biến thể đầu tiên');
      assert.equal(Number(byId.get(orphan).available_qty), 0,
        'biến thể thiếu mapping option không được tính tồn');
      assert.equal(byId.get(orphan).default_variant_id, null,
        'biến thể mồ côi không được quick-add');

      assert.deepEqual((await project(A, a2)).map((r) => r.product_id), [onlyA2],
        'khách thứ hai cùng shop chỉ thấy wishlist của mình');
      assert.deepEqual((await project(B, b1)).map((r) => r.product_id), [onlyB],
        'shop B chỉ thấy dữ liệu shop B');
      assert.deepEqual(await project(B, a1), [],
        'customer id của shop A không thể đọc wishlist shop B');

      await owner.query(`UPDATE promotions SET active=false WHERE id=$1`, [promo]);
      const noSale = (await project(A, a1)).find((r) => r.product_id === flat);
      assert.equal(Number(noSale.price_vnd), 100_000, 'promo tắt phải trả giá gốc');
      assert.equal(noSale.promotion_id, null);
      assert.equal(noSale.off_pct, null);
    } finally {
      const ids = shopIds;
      for (const table of [
        'promotion_products', 'promotions', 'media', 'wishlist_items', 'inventory_levels',
        'variant_option_values', 'option_values', 'product_options', 'variants', 'products',
        'customer_sessions', 'customers',
      ]) await owner.query(`DELETE FROM ${table} WHERE shop_id = ANY($1::uuid[])`, [ids]);
      await owner.query(`DELETE FROM shops WHERE id = ANY($1::uuid[])`, [ids]);
    }
  });
});
