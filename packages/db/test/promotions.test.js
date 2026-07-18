/**
 * Hợp đồng GIÁ HIỆU LỰC (0082) — hàm promo_effective là nguồn giá DUY NHẤT. Kiểm ở tầng
 * DB (không service): ranh giới khung giờ nửa-mở, chồng promo lấy max giảm + tie-break
 * uuid, làm tròn khớp couponDiscount, fixed>base→0, RLS cô lập + app_store/app_checkout
 * chỉ đọc promo active của shop mình.
 */
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { owner } from './helpers.js';

const store = new pg.Pool({ connectionString: process.env.DATABASE_URL_STORE, max: 3 });
const checkout = new pg.Pool({ connectionString: process.env.DATABASE_URL_CHECKOUT, max: 3 });
const rw = new pg.Pool({ connectionString: process.env.DATABASE_URL_RW, max: 3 });
after(async () => { await Promise.all([store.end(), checkout.end(), rw.end()]); });

// Chạy fn dưới VAI (pool) + tenant context (SET LOCAL) trong một transaction.
async function asTenant(pool, shopId, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
const eff = (c, productId, base, at) =>
  c.query(`SELECT price_vnd, promotion_id, off_pct FROM promo_effective($1,$2,$3)`, [productId, base, at])
    .then((r) => r.rows[0] ?? null);

// Seed 1 shop + 1 product qua owner (bỏ RLS). Trả ids + dọn.
async function seedShop() {
  const tag = randomUUID().slice(0, 8);
  const { rows: [s] } = await owner.query(`INSERT INTO shops (slug,name,status) VALUES ($1,$2,'active') RETURNING id`, [`promo-${tag}`, `Promo ${tag}`]);
  const { rows: [p] } = await owner.query(`INSERT INTO products (shop_id,slug,title,price_vnd,status) VALUES ($1,'sp','SP',100000,'active') RETURNING id`, [s.id]);
  return { shopId: s.id, productId: p.id, tag };
}
const mkPromo = (shopId, o) => owner.query(
  `INSERT INTO promotions (id, shop_id, title, kind, value, scope, starts_at, ends_at, active)
   VALUES (coalesce($9, gen_random_uuid()), $1,$2,$3,$4,$5,$6,$7,coalesce($8,true)) RETURNING id`,
  [shopId, o.title ?? 'P', o.kind, o.value, o.scope ?? 'all', o.starts, o.ends, o.active ?? null, o.id ?? null],
).then((r) => r.rows[0].id);
async function cleanup(shopId) { // xoá theo thứ tự phụ thuộc (products→shops không cascade)
  for (const t of ['promotion_products', 'promotions', 'products']) await owner.query(`DELETE FROM ${t} WHERE shop_id=$1`, [shopId]);
  await owner.query(`DELETE FROM shops WHERE id=$1`, [shopId]);
}

describe('promo_effective — hợp đồng giá', () => {
  test('ranh giới khung giờ NỬA-MỞ: 23:59:59 còn sale, 00:00:00 hết', async () => {
    const { shopId, productId } = await seedShop();
    try {
      await mkPromo(shopId, { kind: 'percent', value: 30, starts: '2026-07-01 00:00:00+07', ends: '2026-07-20 00:00:00+07' });
      await asTenant(rw, shopId, async (c) => {
        const before = await eff(c, productId, 100000, '2026-07-19 23:59:59+07');
        assert.equal(Number(before.price_vnd), 70000, 'còn sale lúc 23:59:59');
        const at = await eff(c, productId, 100000, '2026-07-20 00:00:00+07');
        assert.equal(at, null, 'hết sale đúng 00:00:00 (end loại trừ)');
        const early = await eff(c, productId, 100000, '2026-06-30 23:59:59+07');
        assert.equal(early, null, 'chưa tới giờ bắt đầu → không áp');
      });
    } finally { await cleanup(shopId); }
  });

  test('chồng 2 promo cùng SP → GIẢM NHIỀU NHẤT, không cộng dồn', async () => {
    const { shopId, productId } = await seedShop();
    try {
      const win = '2026-07-10 00:00:00+07', winEnd = '2026-07-30 00:00:00+07';
      await mkPromo(shopId, { kind: 'percent', value: 20, scope: 'all', starts: win, ends: winEnd });
      const pB = await mkPromo(shopId, { kind: 'percent', value: 35, scope: 'products', starts: win, ends: winEnd });
      await owner.query(`INSERT INTO promotion_products (shop_id,promotion_id,product_id) VALUES ($1,$2,$3)`, [shopId, pB, productId]);
      await asTenant(rw, shopId, async (c) => {
        const r = await eff(c, productId, 100000, '2026-07-15 12:00:00+07');
        assert.equal(Number(r.price_vnd), 65000, 'lấy −35% (sâu hơn −20%), KHÔNG −55%');
        assert.equal(r.promotion_id, pB, 'promo thắng = cái giảm nhiều');
      });
    } finally { await cleanup(shopId); }
  });

  test('hoà mức giảm → promotion_id NHỎ NHẤT thắng (deterministic)', async () => {
    const { shopId, productId } = await seedShop();
    try {
      const w = ['2026-07-10 00:00:00+07', '2026-07-30 00:00:00+07'];
      const [a, b] = [randomUUID(), randomUUID()];
      const lo = a < b ? a : b, hi = a < b ? b : a; // uuid pg so byte = hex thường khớp JS string <
      await mkPromo(shopId, { id: hi, kind: 'percent', value: 25, starts: w[0], ends: w[1] });
      await mkPromo(shopId, { id: lo, kind: 'percent', value: 25, starts: w[0], ends: w[1] });
      await asTenant(rw, shopId, async (c) => {
        const r = await eff(c, productId, 100000, '2026-07-15 12:00:00+07');
        assert.equal(r.promotion_id, lo, 'hoà 25% → uuid nhỏ nhất');
      });
    } finally { await cleanup(shopId); }
  });

  test('làm tròn percent KHỚP couponDiscount Math.floor (base lẻ)', async () => {
    const { shopId, productId } = await seedShop();
    try {
      await mkPromo(shopId, { kind: 'percent', value: 30, starts: '2026-07-10 00:00:00+07', ends: '2026-07-30 00:00:00+07' });
      await asTenant(rw, shopId, async (c) => {
        const r = await eff(c, productId, 101, '2026-07-15 12:00:00+07'); // base=101 lộ chênh 1đ
        const couponDiscount = Math.floor(101 * 30 / 100); // = 30
        assert.equal(Number(r.price_vnd), 101 - couponDiscount, 'effective = base − floor(base*%/100) = 71');
        assert.equal(Number(r.off_pct), Math.round(30 * 100 / 101), 'off_pct từ discount thực');
      });
    } finally { await cleanup(shopId); }
  });

  test('fixed > giá → effective KẸP 0 (không âm), off_pct 100', async () => {
    const { shopId, productId } = await seedShop();
    try {
      await mkPromo(shopId, { kind: 'fixed', value: 999999999, starts: '2026-07-10 00:00:00+07', ends: '2026-07-30 00:00:00+07' });
      await asTenant(rw, shopId, async (c) => {
        const r = await eff(c, productId, 100000, '2026-07-15 12:00:00+07');
        assert.equal(Number(r.price_vnd), 0, 'GREATEST(0, base−fixed) = 0');
        assert.equal(Number(r.off_pct), 100);
      });
    } finally { await cleanup(shopId); }
  });

  test('promo INACTIVE → không áp (tắt tay/kết thúc sớm)', async () => {
    const { shopId, productId } = await seedShop();
    try {
      await mkPromo(shopId, { kind: 'percent', value: 50, active: false, starts: '2026-07-10 00:00:00+07', ends: '2026-07-30 00:00:00+07' });
      await asTenant(rw, shopId, async (c) => {
        const r = await eff(c, productId, 100000, '2026-07-15 12:00:00+07');
        assert.equal(r, null, 'active=false → hàm bỏ qua');
      });
    } finally { await cleanup(shopId); }
  });
});

describe('promo_effective — RLS cô lập + least-priv', () => {
  test('app_store: chỉ ĐỌC promo ACTIVE của shop mình; KHÔNG thấy inactive/shop khác; KHÔNG ghi', async () => {
    const A = await seedShop(); const B = await seedShop();
    try {
      const w = ['2026-07-10 00:00:00+07', '2026-07-30 00:00:00+07'];
      // A: promo scope='products' phủ A.productId (để test product NGOÀI phạm vi → không áp).
      const pA = await mkPromo(A.shopId, { kind: 'percent', value: 30, scope: 'products', starts: w[0], ends: w[1] });
      await owner.query(`INSERT INTO promotion_products (shop_id,promotion_id,product_id) VALUES ($1,$2,$3)`, [A.shopId, pA, A.productId]);
      await mkPromo(A.shopId, { kind: 'percent', value: 40, active: false, starts: w[0], ends: w[1] }); // inactive A
      await mkPromo(B.shopId, { kind: 'percent', value: 50, scope: 'all', starts: w[0], ends: w[1] });  // active B (all)
      await asTenant(store, A.shopId, async (c) => {
        const rows = (await c.query(`SELECT value, active FROM promotions`)).rows;
        assert.equal(rows.length, 1, 'app_store shop A chỉ thấy 1 promo active của A (inactive + shop B ẩn)');
        assert.equal(Number(rows[0].value), 30);
        const inA = await eff(c, A.productId, 100000, '2026-07-15 12:00:00+07');
        assert.equal(Number(inA.price_vnd), 70000, 'A.product trong phạm vi → −30%');
        // B.productId trong context A: KHÔNG thuộc promotion_products của A + A không có promo 'all'
        // → RLS chặn thấy promo B → 0 dòng (dù B có promo 'all' 50% ở shop khác).
        const inB = await eff(c, B.productId, 100000, '2026-07-15 12:00:00+07');
        assert.equal(inB, null, 'product shop B trong context A → không promo (cô lập)');
      });
      // Write-denial trong transaction RIÊNG (INSERT lỗi làm abort tx → tách khỏi reads).
      await asTenant(store, A.shopId, async (c) => {
        const err = await c.query(`INSERT INTO promotions (shop_id,title,kind,value,scope,starts_at,ends_at) VALUES ($1,'x','percent',10,'all',$2,$3)`, [A.shopId, w[0], w[1]]).then(() => null, (e) => e.code);
        assert.equal(err, '42501', 'app_store INSERT promotions → insufficient_privilege');
      });
    } finally { await cleanup(A.shopId); await cleanup(B.shopId); }
  });

  test('app_checkout: đọc promo active để tính giá; KHÔNG ghi', async () => {
    const { shopId, productId } = await seedShop();
    try {
      await mkPromo(shopId, { kind: 'fixed', value: 25000, starts: '2026-07-10 00:00:00+07', ends: '2026-07-30 00:00:00+07' });
      await asTenant(checkout, shopId, async (c) => {
        const r = await eff(c, productId, 100000, '2026-07-15 12:00:00+07');
        assert.equal(Number(r.price_vnd), 75000, 'app_checkout tính giá fixed −25k');
      });
      await asTenant(checkout, shopId, async (c) => {
        const err = await c.query(`UPDATE promotions SET value=1`).then(() => null, (e) => e.code);
        assert.equal(err, '42501', 'app_checkout UPDATE promotions → insufficient_privilege');
      });
    } finally { await cleanup(shopId); }
  });
});
