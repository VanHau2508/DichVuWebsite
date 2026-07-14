/**
 * Checkout — giỏ hàng ẩn danh + tạo đơn. Phần bảo mật gắt nhất (luồng tiền).
 *
 * Bất biến (docs/01 §8, mỗi cái có e2e + mutation):
 *   1. GIÁ tính lại 100% phía server từ variants.price_vnd. Client chỉ gửi
 *      variant_id + qty. Mọi "price"/"total" client gửi bị BỎ QUA.
 *   2. Tạo đơn là MỘT transaction: khoá inventory FOR UPDATE → kiểm tồn → reserve
 *      → ghi order+lines (snapshot) → tăng order_number → commit. Đua giành đơn
 *      cuối → đúng một thắng (chống oversell).
 *   3. IDEMPOTENCY: header Idempotency-Key. Lặp cùng key → trả đơn cũ, không tạo 2.
 *   4. SNAPSHOT: order_lines lưu tên/sku/giá lúc mua; sửa sản phẩm sau không đổi đơn.
 *   5. order_number theo shop (shop_counters), không toàn cục.
 *   6. Cart token chỉ lưu HASH.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import { readJson, readForm, send, sendHtml, redirect, wantsHtml, parseCookies, setCartCookie, sameOrigin, clientIp, CART_COOKIE } from './http.js';
import { buildVietQR } from './vietqr.js';
import { renderCart, renderCheckout, renderOrder, renderError, renderLookup, qrSvg } from './pages.js';
import { runReq, makeLog, health } from './obs.js';

const PORT = Number(process.env.PORT ?? 3060);
// Mặc định phí ship nền tảng (shop chưa cấu hình → dùng số này). Dùng `??` không đủ:
// SHIP_FEE_VND='' (env để trống) lọt qua `??` rồi Number('')===0 → free-ship âm thầm toàn
// nền tảng. Chỉ nhận số hữu hạn; rỗng/không hợp lệ → 30000.
const SHIP_FEE = (() => { const r = process.env.SHIP_FEE_VND; return (r != null && r !== '' && Number.isFinite(Number(r))) ? Number(r) : 30000; })();
const MEDIA_PUBLIC_BASE = process.env.MEDIA_PUBLIC_BASE ?? 'http://minio:9000/media-public';
const imgUrl = (key) => (key ? `${MEDIA_PUBLIC_BASE}/${key}` : null);
const CART_TTL_DAYS = 30;
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

const log = makeLog('checkout');
const genToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function resolveShop(hostname) {
  const { rows } = await db.query(`SELECT shop_id FROM domains WHERE hostname = $1 AND verified_at IS NOT NULL`, [hostname]);
  return rows[0]?.shop_id ?? null;
}
async function withTenant(shopId, fn) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
/** Lỗi nghiệp vụ → throw để withTenant ROLLBACK (không commit reserve dở dang). */
function fail(statusCode, error, extra = {}) { throw Object.assign(new Error(error), { statusCode, body: { error, ...extra } }); }

const isInt = (x) => Number.isInteger(x);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function findCart(c, token) {
  if (!token) return null;
  const r = await c.query(`SELECT id FROM carts WHERE token_hash = $1 AND status = 'active' AND expires_at > now()`, [hashToken(token)]);
  return r.rows[0] ?? null;
}

// Phí ship theo shop (đọc trong tenant context). NULL → mặc định nền tảng (tương thích
// ngược). Dùng CHUNG cho summarize (hiển thị) và createOrderTx (tính đơn) → luôn khớp.
async function shopShipping(c) {
  const s = (await c.query(`SELECT ship_fee_vnd, free_ship_threshold_vnd FROM shops WHERE id = current_shop_id()`)).rows[0] ?? {};
  return {
    fee: s.ship_fee_vnd != null ? Number(s.ship_fee_vnd) : SHIP_FEE,
    threshold: s.free_ship_threshold_vnd != null ? Number(s.free_ship_threshold_vnd) : null,
  };
}
function computeShipping(cfg, subtotal, hasItems) {
  if (!hasItems) return 0;
  if (cfg.threshold != null && subtotal >= cfg.threshold) return 0; // đủ ngưỡng miễn phí ship
  return cfg.fee;
}

async function summarize(c, cartId) {
  const items = (await c.query(
    `SELECT ci.variant_id, ci.qty, v.price_vnd, v.title AS variant_title, v.sku, p.title AS product_title, p.slug,
            (SELECT m.public_key FROM media m WHERE m.product_id = p.id ORDER BY m.position, m.created_at LIMIT 1) AS image_key
       FROM cart_items ci JOIN variants v ON v.id = ci.variant_id JOIN products p ON p.id = v.product_id
      WHERE ci.cart_id = $1 ORDER BY ci.created_at`, [cartId],
  )).rows;
  let subtotal = 0;
  const out = items.map((it) => {
    const unit = Number(it.price_vnd); // GIÁ THẬT từ variants
    subtotal += unit * it.qty;
    return { variant_id: it.variant_id, product_title: it.product_title, variant_title: it.variant_title, sku: it.sku, unit_price_vnd: unit, qty: it.qty, line_total_vnd: unit * it.qty, image: imgUrl(it.image_key) };
  });
  const shipping = computeShipping(await shopShipping(c), subtotal, out.length > 0);
  return { items: out, subtotal_vnd: subtotal, shipping_vnd: shipping, total_vnd: subtotal + shipping };
}

// Tên shop (cho header trang HTML). app_checkout có SELECT shops (policy checkout_shop).
async function getShopName(shopId) {
  try { return await withTenant(shopId, async (c) => (await c.query(`SELECT name FROM shops WHERE id = current_shop_id()`)).rows[0]?.name ?? null); }
  catch { return null; }
}

// ── cart handlers (lõi dùng chung JSON + form) ───────────────────────────────
async function cartAddCore(c, token, variantId, qty) {
  const v = (await c.query(`SELECT 1 FROM variants WHERE id = $1`, [variantId])).rows[0]; // RLS: chỉ variant active
  if (!v) fail(404, 'sản phẩm không tồn tại hoặc ngừng bán');
  let cart = await findCart(c, token);
  let newToken = null;
  if (!cart) {
    newToken = genToken();
    cart = (await c.query(
      `INSERT INTO carts (shop_id, token_hash, expires_at) VALUES (current_shop_id(), $1, now() + ($2 || ' days')::interval) RETURNING id`,
      [hashToken(newToken), String(CART_TTL_DAYS)],
    )).rows[0];
  }
  const cur = (await c.query(`SELECT qty FROM cart_items WHERE cart_id = $1 AND variant_id = $2`, [cart.id, variantId])).rows[0];
  const newQty = (cur?.qty ?? 0) + qty;
  if (newQty > 1000) fail(422, 'vượt số lượng tối đa 1000 mỗi sản phẩm'); // đối xứng với cartSetQtyCore (cộng dồn không được vượt cap)
  const lvl = (await c.query(`SELECT on_hand, reserved FROM inventory_levels WHERE variant_id = $1`, [variantId])).rows[0];
  const available = lvl ? lvl.on_hand - lvl.reserved : 0;
  if (newQty > available) fail(422, 'không đủ tồn kho', { available });
  await c.query(
    `INSERT INTO cart_items (shop_id, cart_id, variant_id, qty) VALUES (current_shop_id(), $1, $2, $3)
     ON CONFLICT (shop_id, cart_id, variant_id) DO UPDATE SET qty = $3`,
    [cart.id, variantId, newQty],
  );
  return { summary: await summarize(c, cart.id), newToken };
}

async function cartSetQtyCore(c, token, variantId, qty) {
  const cart = await findCart(c, token);
  if (!cart) fail(404, 'giỏ hàng không tồn tại');
  if (qty === 0) {
    await c.query(`DELETE FROM cart_items WHERE cart_id = $1 AND variant_id = $2`, [cart.id, variantId]);
  } else {
    const lvl = (await c.query(`SELECT on_hand, reserved FROM inventory_levels WHERE variant_id = $1`, [variantId])).rows[0];
    const available = lvl ? lvl.on_hand - lvl.reserved : 0;
    if (qty > available) fail(422, 'không đủ tồn kho', { available });
    const n = await c.query(`UPDATE cart_items SET qty = $3 WHERE cart_id = $1 AND variant_id = $2`, [cart.id, variantId, qty]);
    if (n.rowCount === 0) fail(404, 'không có trong giỏ');
  }
  return summarize(c, cart.id);
}

async function addItem(req, res, body, ctx) {  // API JSON
  const variantId = body.variant_id, qty = body.qty;
  if (typeof variantId !== 'string' || !UUID_RE.test(variantId)) return send(res, 400, { error: 'variant_id không hợp lệ' });
  if (!isInt(qty) || qty < 1 || qty > 1000) return send(res, 400, { error: 'qty phải là 1..1000' });
  const token = parseCookies(req)[CART_COOKIE];
  const result = await withTenant(ctx.shopId, (c) => cartAddCore(c, token, variantId, qty));
  if (result.newToken) setCartCookie(res, result.newToken, CART_TTL_DAYS * 86400);
  return send(res, 200, result.summary);
}

async function addItemForm(req, res, form, ctx) {  // form từ trang sản phẩm → 303 /cart
  const variantId = String(form.variant_id ?? ''), qty = parseInt(form.qty ?? '1', 10);
  if (!UUID_RE.test(variantId) || !isInt(qty) || qty < 1 || qty > 1000) return sendHtml(res, 400, renderError(await getShopName(ctx.shopId), 'Yêu cầu không hợp lệ.'));
  const token = parseCookies(req)[CART_COOKIE];
  try {
    const result = await withTenant(ctx.shopId, (c) => cartAddCore(c, token, variantId, qty));
    if (result.newToken) setCartCookie(res, result.newToken, CART_TTL_DAYS * 86400);
    return redirect(res, '/cart');
  } catch (err) {
    if (err.statusCode) return sendHtml(res, err.statusCode, renderError(await getShopName(ctx.shopId), err.body?.error ?? 'Không thêm được vào giỏ.'));
    throw err;
  }
}

async function getCart(req, res, _body, ctx) {  // HTML (trình duyệt) hoặc JSON (API/e2e)
  const token = parseCookies(req)[CART_COOKIE];
  const summary = await withTenant(ctx.shopId, async (c) => {
    const cart = await findCart(c, token);
    return cart ? summarize(c, cart.id) : { items: [], subtotal_vnd: 0, shipping_vnd: 0, total_vnd: 0 };
  });
  if (wantsHtml(req)) return sendHtml(res, 200, renderCart(await getShopName(ctx.shopId), summary));
  return send(res, 200, summary);
}

async function setItemQty(req, res, body, ctx) {  // API JSON
  const variantId = body.variant_id, qty = body.qty;
  if (typeof variantId !== 'string' || !UUID_RE.test(variantId)) return send(res, 400, { error: 'variant_id không hợp lệ' });
  if (!isInt(qty) || qty < 0 || qty > 1000) return send(res, 400, { error: 'qty phải là 0..1000' });
  const token = parseCookies(req)[CART_COOKIE];
  const summary = await withTenant(ctx.shopId, (c) => cartSetQtyCore(c, token, variantId, qty));
  return send(res, 200, summary);
}

async function updateItemForm(req, res, form, ctx) {  // form giỏ (cập nhật/xoá) → 303 /cart
  const variantId = String(form.variant_id ?? ''), qty = parseInt(form.qty ?? '', 10);
  if (!UUID_RE.test(variantId) || !isInt(qty) || qty < 0 || qty > 1000) return sendHtml(res, 400, renderError(await getShopName(ctx.shopId), 'Yêu cầu không hợp lệ.'));
  const token = parseCookies(req)[CART_COOKIE];
  try {
    await withTenant(ctx.shopId, (c) => cartSetQtyCore(c, token, variantId, qty));
    return redirect(res, '/cart');
  } catch (err) {
    if (err.statusCode) return sendHtml(res, err.statusCode, renderError(await getShopName(ctx.shopId), err.body?.error ?? 'Không cập nhật được giỏ.'));
    throw err;
  }
}

// ── checkout (crown jewel) ───────────────────────────────────────────────────
// Validate + chuẩn hoá input đơn — DÙNG CHUNG cho API JSON và form trình duyệt.
function parseOrderInput(raw) {
  const name = String(raw.name ?? '').trim();
  const phone = String(raw.phone ?? '').trim();
  const email = raw.email ? String(raw.email).trim().toLowerCase() : null;
  const address = raw.address && typeof raw.address === 'object' ? raw.address : null;
  const paymentMethod = raw.payment_method ?? 'cod';
  if (name.length < 1 || name.length > 120 || /[\r\n]/.test(name)) return { error: 'tên người nhận không hợp lệ' };
  if (!/^[0-9+\s.-]{8,20}$/.test(phone)) return { error: 'số điện thoại không hợp lệ' };
  // Email đi thẳng tới worker→nodemailer. Validate chặt + cấm CR/LF (chống header/SMTP injection).
  if (email !== null && (email.length > 254 || /[\r\n\s]/.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return { error: 'email không hợp lệ' };
  if (!['cod', 'qr'].includes(paymentMethod)) return { error: 'phương thức thanh toán không hợp lệ' };
  return { name, phone, email, address, paymentMethod };
}

// Lõi tạo đơn (transaction). Ném fail() khi lỗi nghiệp vụ → withTenant ROLLBACK.
async function createOrderTx(c, ctx, token, idemKey, f) {
  const { name, phone, email, address, paymentMethod } = f;
  {
    // request_hash: nội dung ĐƠN, KHÔNG gồm bất kỳ giá/total nào client gửi.
    const requestHash = sha256(idemKey + JSON.stringify({ name, phone, email, address, paymentMethod }));
    // Idempotency: giành key.
    const claim = await c.query(
      `INSERT INTO idempotency_keys (shop_id, key, request_hash, status)
       VALUES (current_shop_id(), $1, $2, 'in_progress')
       ON CONFLICT (shop_id, key) DO NOTHING RETURNING key`, [idemKey, requestHash],
    );
    if (claim.rows.length === 0) {
      const ex = (await c.query(`SELECT request_hash, status, response_code, response_body FROM idempotency_keys WHERE key = $1`, [idemKey])).rows[0];
      if (ex.request_hash !== requestHash) fail(422, 'Idempotency-Key dùng lại với nội dung khác');
      if (ex.status === 'completed') return { code: ex.response_code, body: ex.response_body, replay: true };
      fail(409, 'đơn đang được xử lý, thử lại');
    }

    const cart = await findCart(c, token);
    if (!cart) fail(400, 'giỏ hàng trống hoặc hết hạn');
    const items = (await c.query(
      `SELECT ci.variant_id, ci.qty, v.price_vnd, v.title AS variant_title, v.sku, p.title AS product_title
         FROM cart_items ci JOIN variants v ON v.id = ci.variant_id JOIN products p ON p.id = v.product_id
        WHERE ci.cart_id = $1 ORDER BY ci.created_at`, [cart.id],
    )).rows;
    if (items.length === 0) fail(400, 'giỏ hàng trống');

    // Khoá tồn + reserve + snapshot. Giá lấy từ variants (server-side).
    let subtotal = 0;
    const lines = [];
    for (const it of items) {
      const lvl = (await c.query(`SELECT on_hand, reserved FROM inventory_levels WHERE variant_id = $1 FOR UPDATE`, [it.variant_id])).rows[0];
      const available = lvl ? lvl.on_hand - lvl.reserved : 0;
      if (it.qty > available) fail(422, `hết hàng: ${it.product_title}`, { variant_id: it.variant_id });
      await c.query(`UPDATE inventory_levels SET reserved = reserved + $2, updated_at = now() WHERE variant_id = $1`, [it.variant_id, it.qty]);
      const unit = Number(it.price_vnd);
      subtotal += unit * it.qty;
      lines.push({ variant_id: it.variant_id, title: it.product_title + (it.variant_title ? ` - ${it.variant_title}` : ''), sku: it.sku, unit, qty: it.qty });
    }
    const shipping = computeShipping(await shopShipping(c), subtotal, items.length > 0), discount = 0, total = subtotal + shipping - discount;

    // QR: cần cấu hình ngân hàng của shop + mã đối soát duy nhất.
    let paymentRef = null;
    let qrString = null;
    let qrAccount = null;
    if (paymentMethod === 'qr') {
      const cfg = (await c.query(
        `SELECT bank_bin, account_number, account_name, qr_enabled FROM shop_payment_config WHERE shop_id = current_shop_id()`,
      )).rows[0];
      if (!cfg || !cfg.qr_enabled || !cfg.bank_bin || !cfg.account_number) fail(400, 'shop chưa bật thanh toán QR');
      paymentRef = 'NTG' + crypto.randomBytes(6).toString('hex').toUpperCase(); // duy nhất (UNIQUE ở orders)
      qrAccount = cfg.account_number; // snapshot tài khoản nhận → webhook đối chiếu
      qrString = buildVietQR({ bankBin: cfg.bank_bin, accountNumber: cfg.account_number, amountVnd: total, content: paymentRef });
    }

    const num = (await c.query(
      `INSERT INTO shop_counters (shop_id, name, value) VALUES (current_shop_id(), 'order_number', 1)
       ON CONFLICT (shop_id, name) DO UPDATE SET value = shop_counters.value + 1 RETURNING value`,
    )).rows[0].value;

    const lookupToken = genToken();
    const order = (await c.query(
      `INSERT INTO orders (shop_id, order_number, status, payment_status, payment_method,
         customer_name, customer_phone, customer_email, shipping_address,
         subtotal_vnd, shipping_vnd, discount_vnd, total_vnd, lookup_token_hash, payment_ref, qr_account)
       VALUES (current_shop_id(), $1, 'pending', 'unpaid', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [num, paymentMethod, name, phone, email, address, subtotal, shipping, discount, total, hashToken(lookupToken), paymentRef, qrAccount],
    )).rows[0];
    for (const ln of lines) {
      await c.query(
        `INSERT INTO order_lines (shop_id, order_id, variant_id, title_snapshot, sku_snapshot, unit_price_vnd, qty)
         VALUES (current_shop_id(), $1, $2, $3, $4, $5, $6)`,
        [order.id, ln.variant_id, ln.title, ln.sku, ln.unit, ln.qty],
      );
    }
    await c.query(`UPDATE carts SET status = 'converted', updated_at = now() WHERE id = $1`, [cart.id]);

    // Outbox: sự kiện email xác nhận đơn — GHI TRONG CÙNG transaction. Rollback →
    // không có dòng này → không email ma (ADR-006). Payload self-contained (worker
    // chỉ đọc outbox, không đụng orders/PII). Chỉ khi có email người mua.
    if (email) {
      await c.query(
        `INSERT INTO outbox (shop_id, topic, payload) VALUES (current_shop_id(), 'order.created', $1)`,
        [{ to: email, order_number: Number(num), total_vnd: total, customer_name: name, payment_method: paymentMethod }],
      );
    }

    const response = { order_number: Number(num), subtotal_vnd: subtotal, shipping_vnd: shipping, total_vnd: total, status: 'pending', payment_status: 'unpaid', payment_method: paymentMethod, lookup_token: lookupToken };
    if (paymentMethod === 'qr') { response.payment_ref = paymentRef; response.qr_string = qrString; }
    await c.query(`UPDATE idempotency_keys SET status = 'completed', response_code = 201, response_body = $2 WHERE key = $1`, [idemKey, response]);
    log('info', 'order_created', { orderNumber: Number(num), total });
    return { code: 201, body: response };
  }
}

// API JSON (e2e + tích hợp): Idempotency-Key ở HEADER. Lỗi nghiệp vụ do dispatcher bắt.
async function checkout(req, res, body, ctx) {
  const idemKey = req.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey.length < 8 || idemKey.length > 200) return send(res, 400, { error: 'thiếu/không hợp lệ Idempotency-Key' });
  const f = parseOrderInput({ name: body.customer?.name, phone: body.customer?.phone, email: body.customer?.email, address: body.address, payment_method: body.payment_method });
  if (f.error) return send(res, 400, { error: f.error });
  const token = parseCookies(req)[CART_COOKIE];
  const out = await withTenant(ctx.shopId, (c) => createOrderTx(c, ctx, token, idemKey, f));
  return send(res, out.code, out.body, out.replay ? { 'idempotency-replayed': 'true' } : {});
}

// Form trình duyệt (không JS): idem-key ở FORM (sinh lúc render /checkout). PRG → /success.
async function checkoutPlace(req, res, form, ctx) {
  const shopName = await getShopName(ctx.shopId);
  const idemKey = String(form.idempotency_key ?? '');
  if (idemKey.length < 8 || idemKey.length > 200) return sendHtml(res, 400, renderError(shopName, 'Phiên thanh toán không hợp lệ, vui lòng tải lại trang.'));
  const f = parseOrderInput({ name: form.name, phone: form.phone, email: form.email, address: form.address_line ? { line: String(form.address_line).slice(0, 300) } : null, payment_method: form.payment_method });
  if (f.error) return sendHtml(res, 400, renderError(shopName, f.error));
  const token = parseCookies(req)[CART_COOKIE];
  try {
    const out = await withTenant(ctx.shopId, (c) => createOrderTx(c, ctx, token, idemKey, f));
    return redirect(res, `/checkout/success?number=${out.body.order_number}&token=${encodeURIComponent(out.body.lookup_token)}&placed=1`);
  } catch (err) {
    if (err.statusCode) return sendHtml(res, err.statusCode, renderError(shopName, err.body?.error ?? 'Không đặt được đơn.'));
    throw err;
  }
}

async function orderLookup(req, res, _body, ctx, query) {
  const number = Number(query.get('number'));
  const token = query.get('token');
  if (!Number.isInteger(number) || !token) return send(res, 400, { error: 'thiếu number/token' });
  const data = await withTenant(ctx.shopId, async (c) => {
    const o = (await c.query(
      `SELECT id, order_number, status, payment_status, payment_method, subtotal_vnd, shipping_vnd, total_vnd, customer_name
         FROM orders WHERE order_number = $1 AND lookup_token_hash = $2`, [number, hashToken(token)],
    )).rows[0];
    if (!o) return null;
    const lines = (await c.query(`SELECT title_snapshot, sku_snapshot, unit_price_vnd, qty FROM order_lines WHERE order_id = $1`, [o.id])).rows;
    return { order_number: o.order_number, status: o.status, payment_status: o.payment_status, payment_method: o.payment_method, subtotal_vnd: Number(o.subtotal_vnd), shipping_vnd: Number(o.shipping_vnd), total_vnd: Number(o.total_vnd), customer_name: o.customer_name, lines };
  });
  if (!data) return send(res, 404, { error: 'không tìm thấy đơn' });
  return send(res, 200, data);
}

// ── trang HTML (không JS) ────────────────────────────────────────────────────
async function getCheckoutPage(req, res, _body, ctx) {
  const token = parseCookies(req)[CART_COOKIE];
  const summary = await withTenant(ctx.shopId, async (c) => {
    const cart = await findCart(c, token);
    return cart ? summarize(c, cart.id) : { items: [], subtotal_vnd: 0, shipping_vnd: 0, total_vnd: 0 };
  });
  if (!summary.items.length) return redirect(res, '/cart');       // giỏ trống → về giỏ
  return sendHtml(res, 200, renderCheckout(await getShopName(ctx.shopId), summary, genToken()));
}

async function getLookupPage(req, res, _body, ctx) {
  return sendHtml(res, 200, renderLookup(await getShopName(ctx.shopId)));
}

async function getSuccessPage(req, res, _body, ctx, query) {
  const number = Number(String(query.get('number') ?? '').trim());
  const token = query.get('token');
  const justPlaced = query.get('placed') === '1';
  const shopName = await getShopName(ctx.shopId);
  // Thiếu tham số → về form tra cứu (không phải ngõ cụt).
  if (!Number.isInteger(number) || !token) return sendHtml(res, 200, renderLookup(shopName));
  const data = await withTenant(ctx.shopId, async (c) => {
    const o = (await c.query(
      `SELECT id, order_number, status, payment_status, payment_method, shipping_vnd, total_vnd, customer_name, payment_ref
         FROM orders WHERE order_number = $1 AND lookup_token_hash = $2`, [number, hashToken(token)],
    )).rows[0];
    if (!o) return null;
    o.lines = (await c.query(`SELECT title_snapshot, sku_snapshot, unit_price_vnd, qty FROM order_lines WHERE order_id = $1`, [o.id])).rows;
    let pay = null;
    if (o.payment_method === 'qr' && o.payment_status !== 'paid') {
      pay = (await c.query(`SELECT bank_bin, account_number, account_name FROM shop_payment_config WHERE shop_id = current_shop_id()`)).rows[0] ?? null;
    }
    return { o, pay };
  });
  // Sai số đơn/mã → form tra cứu kèm lỗi (không xác nhận đơn tồn tại; chống dò).
  if (!data) return sendHtml(res, 404, renderLookup(shopName, 'Không tìm thấy đơn — kiểm tra lại số đơn và mã tra cứu.'));
  let qr = '';
  if (data.pay?.bank_bin && data.pay?.account_number) {
    qr = await qrSvg(buildVietQR({ bankBin: data.pay.bank_bin, accountNumber: data.pay.account_number, amountVnd: Number(data.o.total_vnd), content: data.o.payment_ref }));
  }
  return sendHtml(res, 200, renderOrder(shopName, data.o, data.pay, qr, justPlaced));
}

// ── router ───────────────────────────────────────────────────────────────────
// form: đọc body dạng x-www-form-urlencoded (thay vì JSON) cho trang không-JS.
const ROUTES = [
  { m: 'GET', p: '/cart', fn: getCart },
  { m: 'POST', p: '/cart/items', fn: addItem },
  { m: 'PATCH', p: '/cart/items', fn: setItemQty },
  { m: 'POST', p: '/cart/add', fn: addItemForm, form: true },
  { m: 'POST', p: '/cart/update', fn: updateItemForm, form: true },
  { m: 'POST', p: '/checkout', fn: checkout },
  { m: 'POST', p: '/checkout/place', fn: checkoutPlace, form: true },
  { m: 'GET', p: '/checkout', fn: getCheckoutPage },
  { m: 'GET', p: '/checkout/lookup', fn: getLookupPage },
  { m: 'GET', p: '/checkout/success', fn: getSuccessPage },
  { m: 'GET', p: '/checkout/order', fn: orderLookup },
];

const server = http.createServer((req, res) => runReq(req, res, async () => {
  const url = new URL(req.url, 'http://internal');
  if (await health(url.pathname, res, { db: () => db.query('SELECT 1') })) return;

  const route = ROUTES.find((r) => r.m === req.method && r.p === url.pathname);
  if (!route) return send(res, 404, { error: 'không tìm thấy' });
  if (!sameOrigin(req)) return send(res, 403, { error: 'origin không hợp lệ' });

  try {
    const host = String(req.headers.host ?? '').split(':')[0].trim().toLowerCase();
    const shopId = host ? await resolveShop(host) : null;
    if (!shopId) return send(res, 404, { error: 'tên miền chưa kết nối' });

    // Shop phải CÒN NHẬN ĐƠN. Đây là nơi kích hoạt policy checkout_shop (0012):
    // SELECT dưới app_checkout chỉ trả row nếu status NOT IN (suspended,terminated).
    // Nếu bỏ bước này, shop bị đình chỉ vẫn tạo đơn + sinh QR vào tài khoản của nó
    // → vô hiệu hoá đòn bẩy đình chỉ (cắt doanh thu). Đọc thật để policy sống.
    const accepting = await withTenant(shopId, async (c) => (await c.query(`SELECT 1 FROM shops WHERE id = current_shop_id()`)).rowCount > 0);
    if (!accepting) return send(res, 503, { error: 'cửa hàng tạm ngưng nhận đơn' });

    const body = req.method === 'GET' ? {} : (route.form ? await readForm(req) : await readJson(req));
    const ctx = { shopId, ip: clientIp(req) };
    await route.fn(req, res, body, ctx, url.searchParams);
  } catch (err) {
    if (err.statusCode) {
      if (!res.headersSent) send(res, err.statusCode, err.body);
      return;
    }
    log('error', 'handler_error', { path: url.pathname, message: err.message, stack: err.stack });
    if (!res.headersSent) send(res, 500, { error: 'lỗi hệ thống' });
  }
}));

server.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT }));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(async () => { await db.end().catch(() => {}); process.exit(0); }));
