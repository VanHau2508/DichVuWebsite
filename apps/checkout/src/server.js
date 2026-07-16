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
import { isProvince } from './provinces.js';

const PORT = Number(process.env.PORT ?? 3060);
// Mặc định phí ship nền tảng (shop chưa cấu hình → dùng số này). Dùng `??` không đủ:
// SHIP_FEE_VND='' (env để trống) lọt qua `??` rồi Number('')===0 → free-ship âm thầm toàn
// nền tảng. Chỉ nhận số hữu hạn; rỗng/không hợp lệ → 30000.
const SHIP_FEE = (() => { const r = process.env.SHIP_FEE_VND; return (r != null && r !== '' && Number.isFinite(Number(r))) ? Number(r) : 30000; })();
const MEDIA_PUBLIC_BASE = process.env.MEDIA_PUBLIC_BASE ?? '/media-public';
// Chống đơn ảo: trần số đơn CHƯA XỬ LÝ (pending, 24h) theo NGUỒN (hash IP) và theo SĐT.
// Đủ rộng cho khách thật (kể cả IP dùng chung), đủ chặt để chặn spam 100 đơn.
const MAX_PENDING_PER_IP = Number(process.env.MAX_PENDING_ORDERS_PER_IP) || 30;
const MAX_PENDING_PER_PHONE = Number(process.env.MAX_PENDING_ORDERS_PER_PHONE) || 8;
// Hash IP có PEPPER bí mật (HMAC) → không đảo ngược được nếu DB lộ (IPv4 nhỏ, sha256 trần dò ra).
const IP_PEPPER = process.env.ORDER_HASH_PEPPER || 'nentang-order-ip-v1';
const hashIp = (ip) => crypto.createHmac('sha256', IP_PEPPER).update('oip:' + ip).digest('hex');
// ── Chống BOT no-JS: form ký HMAC (không cần lưu state) ───────────────────────
// (1) time-trap: form nhúng thời điểm render đã ký → submit quá nhanh (bot) hoặc token
//     giả/hết hạn → chặn. (2) câu hỏi toán ký → chỉ hiện khi 1 NGUỒN đã nhiều đơn chờ
//     (leo thang), số a,b + đáp án ký HMAC nên không tính hộ/giả được.
const MIN_FILL_MS = Number(process.env.CHECKOUT_MIN_FILL_MS) || 2500;   // <2.5s điền xong = bot
const FORM_MAX_AGE_MS = Number(process.env.CHECKOUT_FORM_MAX_AGE_MS) || 2 * 60 * 60 * 1000; // 2h
const CHALLENGE_AFTER_PENDING = Number(process.env.CHECKOUT_CHALLENGE_AFTER) || 4; // ≥N đơn chờ/IP → hỏi toán
const formSig = (s) => crypto.createHmac('sha256', IP_PEPPER).update('form:' + s).digest('base64url').slice(0, 24);
const issueFormTs = () => { const t = Date.now(); return `${t}.${formSig('ts:' + t)}`; };
function verifyFormTs(v) {
  const [tStr, mac] = String(v ?? '').split('.');
  const t = Number(tStr);
  if (!Number.isInteger(t) || formSig('ts:' + t) !== mac) return { valid: false };
  return { valid: true, age: Date.now() - t };
}
// Challenge RÀNG BUỘC vào (idemKey + thời điểm) → một cặp đã giải KHÔNG replay được cho
// đơn khác (idem khác → MAC lệch) và hết hạn sau FORM_MAX_AGE_MS.
function issueChallenge(idemKey) {
  const a = 2 + Math.floor(Math.random() * 8), b = 2 + Math.floor(Math.random() * 8), t = Date.now();
  return { a, b, sig: `${a}.${b}.${t}.${formSig(`mc:${a}:${b}:${t}:${idemKey}`)}` };
}
function verifyChallenge(sig, answer, idemKey) {
  const [aStr, bStr, tStr, mac] = String(sig ?? '').split('.');
  const a = Number(aStr), b = Number(bStr), t = Number(tStr);
  if (![a, b, t].every(Number.isInteger) || formSig(`mc:${a}:${b}:${t}:${idemKey}`) !== mac) return false;
  if (Date.now() - t > FORM_MAX_AGE_MS) return false;
  return Number(String(answer ?? '').trim()) === a + b;
}
// Chuẩn hoá SĐT về 1 dạng (chỉ số, +84→0) → '091 234', '+8491...', '0912...' tính là MỘT.
function canonPhone(p) {
  let d = String(p ?? '').replace(/\D/g, '');
  if (d.startsWith('84') && d.length > 9) d = '0' + d.slice(2);
  return d.length >= 8 ? d : null;
}
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

// Giảm giá thực từ coupon theo subtotal. Cap ≤ subtotal (chỉ giảm hàng, không giảm ship,
// total không âm). percent làm tròn xuống.
function couponDiscount(cp, subtotal) {
  const raw = cp.kind === 'percent' ? Math.floor(subtotal * Number(cp.value) / 100) : Number(cp.value);
  return Math.max(0, Math.min(raw, subtotal));
}
// Validate mã của shop hiện tại theo subtotal. Trả {code,kind,value,discount} hoặc null (không áp được).
async function resolveCoupon(c, code, subtotal) {
  if (!code) return null;
  const cp = (await c.query(
    `SELECT code, kind, value, min_subtotal_vnd, max_uses, used_count FROM coupons
      WHERE shop_id = current_shop_id() AND upper(code) = upper($1) AND active
        AND (starts_at IS NULL OR starts_at <= now()) AND (expires_at IS NULL OR expires_at > now())`,
    [String(code).trim()],
  )).rows[0];
  if (!cp) return null;
  if (subtotal < Number(cp.min_subtotal_vnd)) return null;
  if (cp.max_uses != null && cp.used_count >= cp.max_uses) return null;
  const discount = couponDiscount(cp, subtotal);
  return discount > 0 ? { code: cp.code, kind: cp.kind, value: Number(cp.value), discount } : null;
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
  // Mã giảm giá đang áp trên giỏ — re-validate theo subtotal hiện tại (mã hết hạn/không đủ đơn → bỏ qua).
  const cc = (await c.query(`SELECT coupon_code FROM carts WHERE id = $1`, [cartId])).rows[0]?.coupon_code;
  const coupon = cc ? await resolveCoupon(c, cc, subtotal) : null;
  const discount = coupon?.discount ?? 0;
  return { items: out, subtotal_vnd: subtotal, shipping_vnd: shipping, discount_vnd: discount, coupon_code: coupon?.code ?? null, total_vnd: subtotal - discount + shipping };
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

async function addItemForm(req, res, form, ctx) {  // form từ trang sản phẩm → 303 /cart (hoặc /checkout nếu "Mua ngay")
  const variantId = String(form.variant_id ?? ''), qty = parseInt(form.qty ?? '1', 10);
  if (!UUID_RE.test(variantId) || !isInt(qty) || qty < 1 || qty > 1000) return sendHtml(res, 400, renderError(await getShopName(ctx.shopId), 'Yêu cầu không hợp lệ.'));
  const buyNow = form.buynow != null && form.buynow !== '';
  const token = parseCookies(req)[CART_COOKIE];
  try {
    const result = await withTenant(ctx.shopId, (c) => cartAddCore(c, token, variantId, qty));
    if (result.newToken) setCartCookie(res, result.newToken, CART_TTL_DAYS * 86400);
    return redirect(res, buyNow ? '/checkout' : '/cart'); // "Mua ngay" → thẳng trang thanh toán
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

// Áp / gỡ mã giảm giá trên giỏ. code rỗng = gỡ. Lưu mã lên giỏ; summarize tự validate theo
// subtotal → total (đã giảm) được chốt lúc tạo đơn. Hỗ trợ cả form (trang giỏ) lẫn JSON (API).
async function applyCouponCore(c, token, code) {
  const cart = await findCart(c, token);
  if (!cart) fail(404, 'giỏ hàng không tồn tại');
  const clean = String(code ?? '').trim().toUpperCase().slice(0, 40);
  await c.query(`UPDATE carts SET coupon_code = $2, updated_at = now() WHERE id = $1`, [cart.id, clean || null]);
  const summary = await summarize(c, cart.id);
  return { summary, tried: clean, applied: !!(clean && summary.coupon_code) };
}
async function applyCouponForm(req, res, form, ctx) {  // form trang giỏ → 303 /cart (hoặc render lỗi)
  const token = parseCookies(req)[CART_COOKIE];
  try {
    const out = await withTenant(ctx.shopId, (c) => applyCouponCore(c, token, form.code));
    if (out.tried && !out.applied) return sendHtml(res, 200, renderCart(await getShopName(ctx.shopId), { ...out.summary, coupon_error: 'Mã không hợp lệ, hết hạn, hết lượt, hoặc chưa đủ điều kiện đơn.' }));
    return redirect(res, '/cart');
  } catch (err) {
    if (err.statusCode) return sendHtml(res, err.statusCode, renderError(await getShopName(ctx.shopId), err.body?.error ?? 'Không áp được mã.'));
    throw err;
  }
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

// ── Đánh giá sản phẩm (public, no-JS form từ trang SP) ────────────────────────
// Mặc định PENDING — shop duyệt mới hiện. Chống spam: honeypot (bot điền field ẩn →
// giả vờ thành công, không cho tín hiệu) + trần 3 đánh giá/IP/ngày (HMAC ip_hash).
// Badge "đã mua": khách nhập số đơn + SĐT khớp đơn ĐÃ GIAO chứa đúng sản phẩm.
const REVIEWS_PER_IP_DAY = Number(process.env.REVIEWS_PER_IP_DAY) || 3;
async function submitReviewForm(req, res, form, ctx) {
  const productId = String(form.product_id ?? '');
  if (!UUID_RE.test(productId)) return sendHtml(res, 400, renderError(await getShopName(ctx.shopId), 'Yêu cầu không hợp lệ.'));
  const back = (slug, okFlag) => redirect(res, slug ? `/p/${encodeURIComponent(slug)}?review=${okFlag}#danh-gia` : '/');
  const slugRow = await withTenant(ctx.shopId, async (c) =>
    (await c.query(`SELECT slug FROM products WHERE id = $1 AND deleted_at IS NULL`, [productId])).rows[0]);
  if (!slugRow) return sendHtml(res, 404, renderError(await getShopName(ctx.shopId), 'Không tìm thấy sản phẩm.'));
  if (String(form.website ?? '') !== '') return back(slugRow.slug, 'sent'); // honeypot → nuốt im lặng
  const rating = parseInt(String(form.rating ?? ''), 10);
  const author = String(form.author_name ?? '').trim().slice(0, 80);
  const content = String(form.content ?? '').trim().slice(0, 1000);
  if (!isInt(rating) || rating < 1 || rating > 5) return back(slugRow.slug, 'invalid');
  if (author.length < 1 || /[\r\n]/.test(author) || content.length < 10) return back(slugRow.slug, 'invalid');
  const ipHash = ctx.ip ? hashIp(ctx.ip) : null;
  const orderNum = parseInt(String(form.order_number ?? '').replace(/\D/g, ''), 10);
  const revPhone = canonPhone(String(form.phone ?? ''));

  const out = await withTenant(ctx.shopId, async (c) => {
    if (ipHash) {
      const n = Number((await c.query(
        `SELECT count(*)::int n FROM product_reviews WHERE shop_id = current_shop_id() AND ip_hash = $1 AND created_at > now() - interval '1 day'`, [ipHash])).rows[0].n);
      if (n >= REVIEWS_PER_IP_DAY) return { limited: true };
    }
    // Badge "đã mua": đơn ĐÃ GIAO (shipped/delivered) đúng SĐT + chứa sản phẩm này.
    // LƯU Ý (chấp nhận có kiểm soát): khớp theo (order_number + SĐT) có thể bị giả nếu kẻ
    // tấn công biết SĐT + đoán đúng số đơn của nạn nhân — nhưng đánh giá LUÔN chờ shop DUYỆT
    // trước khi hiện, nên badge giả không tự lên trang; đây là chốt chặn chính.
    let verified = false;
    if (Number.isInteger(orderNum) && revPhone) {
      verified = (await c.query(
        `SELECT 1 FROM orders o JOIN order_lines ol ON ol.order_id = o.id JOIN variants v ON v.id = ol.variant_id
          WHERE o.order_number = $1 AND o.customer_phone = $2 AND v.product_id = $3 AND o.status IN ('shipped','delivered') LIMIT 1`,
        [orderNum, revPhone, productId])).rows.length > 0;
    }
    await c.query(
      `INSERT INTO product_reviews (shop_id, product_id, order_number, rating, author_name, content, verified, ip_hash)
       VALUES (current_shop_id(), $1, $2, $3, $4, $5, $6, $7)`,
      [productId, Number.isInteger(orderNum) ? orderNum : null, rating, author, content, verified, ipHash],
    );
    return { ok: true };
  });
  if (out.limited) return sendHtml(res, 429, renderError(await getShopName(ctx.shopId), 'Bạn gửi đánh giá quá nhanh. Vui lòng thử lại vào ngày mai.'));
  return back(slugRow.slug, 'sent');
}

// ── checkout (crown jewel) ───────────────────────────────────────────────────
// Validate + chuẩn hoá input đơn — DÙNG CHUNG cho API JSON và form trình duyệt.
function parseOrderInput(raw) {
  const name = String(raw.name ?? '').trim();
  const phone = String(raw.phone ?? '').trim();
  const email = raw.email ? String(raw.email).trim().toLowerCase() : null;
  // Địa chỉ: WHITELIST cấu trúc (không lưu nguyên văn object client gửi vào jsonb —
  // chặn nhét key rác/payload lớn). Chỉ giữ line/province/district/ward, ép chuỗi + trần.
  let address = null;
  if (raw.address && typeof raw.address === 'object' && !Array.isArray(raw.address)) {
    const pick = (k, max) => (raw.address[k] != null && String(raw.address[k]).trim() !== '' ? String(raw.address[k]).trim().slice(0, max) : undefined);
    address = { line: pick('line', 300), province: pick('province', 60), district: pick('district', 60), ward: pick('ward', 60) };
    // province (tuỳ chọn phía API để tương thích ngược; form BẮT BUỘC ở UI) — phải nằm
    // trong danh sách 34 tỉnh/thành, dùng cho tạo vận đơn hãng VC.
    if (address.province && !isProvince(address.province)) return { error: 'tỉnh/thành không hợp lệ' };
  }
  const paymentMethod = raw.payment_method ?? 'cod';
  if (name.length < 1 || name.length > 120 || /[\r\n]/.test(name)) return { error: 'tên người nhận không hợp lệ' };
  // Định dạng hợp lệ VÀ phải chuẩn hoá được về ≥8 CHỮ SỐ. Chuỗi kiểu "1.2.3.4.5.6" qua regex
  // nhưng <8 số → canonPhone=null; nếu lọt sẽ vô hiệu hoá trần theo-SĐT. Chuẩn hoá luôn ở đây.
  const phoneCanon = canonPhone(phone);
  if (!/^[0-9+\s.-]{8,20}$/.test(phone) || !phoneCanon) return { error: 'số điện thoại không hợp lệ' };
  // Email đi thẳng tới worker→nodemailer. Validate chặt + cấm CR/LF (chống header/SMTP injection).
  if (email !== null && (email.length > 254 || /[\r\n\s]/.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return { error: 'email không hợp lệ' };
  if (!['cod', 'qr'].includes(paymentMethod)) return { error: 'phương thức thanh toán không hợp lệ' };
  return { name, phone: phoneCanon, email, address, paymentMethod }; // phone đã chuẩn hoá → trần theo-SĐT luôn khớp
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

    // ── Chống ĐƠN ẢO: TRẦN ĐỒNG THỜI số đơn CHƯA XỬ LÝ (pending) theo NGUỒN (hash IP) + SĐT.
    // KHOÁ TUẦN TỰ theo nguồn (advisory lock tx-scoped, thứ tự cố định IP→SĐT chống deadlock)
    // TRƯỚC khi đếm → đếm+chèn NGUYÊN TỬ, chống đua nhiều checkout cùng lúc lách trần.
    const ipHash = ctx.ip ? hashIp(ctx.ip) : null;
    const phoneCanon = canonPhone(phone);
    // Trần theo SHOP (0051) nếu shop đặt; NULL → mặc định nền tảng (env). Clamp trần cứng.
    const shopLim = (await c.query(`SELECT max_pending_per_ip, max_pending_per_phone FROM shops WHERE id = current_shop_id()`)).rows[0] ?? {};
    const capIp = Math.min(shopLim.max_pending_per_ip ?? MAX_PENDING_PER_IP, 200);
    const capPhone = Math.min(shopLim.max_pending_per_phone ?? MAX_PENDING_PER_PHONE, 50);
    if (ctx.ip) await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, ['oip:' + ctx.ip]);
    if (phoneCanon) await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, ['oph:' + phoneCanon]);
    if (ipHash) {
      const nIp = Number((await c.query(
        `SELECT count(*)::int n FROM orders WHERE shop_id = current_shop_id() AND client_ip_hash = $1 AND status = 'pending'`, [ipHash])).rows[0].n);
      if (nIp >= capIp) fail(429, 'Quá nhiều đơn chưa xử lý từ mạng/kết nối này. Vui lòng liên hệ cửa hàng hoặc thử lại sau.');
    }
    if (phoneCanon) {
      const nPh = Number((await c.query(
        `SELECT count(*)::int n FROM orders WHERE shop_id = current_shop_id() AND customer_phone = $1 AND status = 'pending'`, [phoneCanon])).rows[0].n);
      if (nPh >= capPhone) fail(429, 'Số điện thoại này có quá nhiều đơn chưa xử lý. Vui lòng liên hệ cửa hàng.');
    }

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
    const shipping = computeShipping(await shopShipping(c), subtotal, items.length > 0);
    // Mã giảm giá: RE-VALIDATE lúc tạo đơn (subtotal đã chốt) + giành 1 lượt NGUYÊN TỬ. Đua 2
    // đơn dùng lượt cuối → chỉ 1 đơn thắng (UPDATE khoá hàng coupon). Hết lượt → bỏ giảm (đơn
    // vẫn tạo, khách trả đủ) thay vì chặn checkout.
    let discount = 0, couponCode = null;
    const cc = (await c.query(`SELECT coupon_code FROM carts WHERE id = $1`, [cart.id])).rows[0]?.coupon_code;
    if (cc) {
      const cp = await resolveCoupon(c, cc, subtotal);
      if (cp) {
        const claim = await c.query(
          `UPDATE coupons SET used_count = used_count + 1
            WHERE shop_id = current_shop_id() AND code = $1 AND active
              AND (max_uses IS NULL OR used_count < max_uses) RETURNING id`, [cp.code],
        );
        if (claim.rowCount === 1) { discount = cp.discount; couponCode = cp.code; }
      }
    }
    const total = subtotal - discount + shipping;

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
         subtotal_vnd, shipping_vnd, discount_vnd, total_vnd, lookup_token_hash, payment_ref, qr_account, coupon_code, client_ip_hash)
       VALUES (current_shop_id(), $1, 'pending', 'unpaid', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [num, paymentMethod, name, phoneCanon ?? phone, email, address, subtotal, shipping, discount, total, hashToken(lookupToken), paymentRef, qrAccount, couponCode, ipHash],
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
      // link tra cứu: token THÔ nằm trong email khách (họ cần nó) — outbox row cũng chứa
      // (chấp nhận được: token chỉ mở trang chi tiết 1 đơn của chính khách).
      const link = ctx.host ? `https://${ctx.host}/checkout/order?number=${Number(num)}&token=${lookupToken}` : undefined;
      await c.query(
        `INSERT INTO outbox (shop_id, topic, payload) VALUES (current_shop_id(), 'order.created', $1)`,
        [{ to: email, order_number: Number(num), total_vnd: total, customer_name: name, payment_method: paymentMethod, ...(link ? { link } : {}) }],
      );
    }

    const response = { order_number: Number(num), subtotal_vnd: subtotal, shipping_vnd: shipping, discount_vnd: discount, coupon_code: couponCode, total_vnd: total, status: 'pending', payment_status: 'unpaid', payment_method: paymentMethod, lookup_token: lookupToken };
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

  // Dựng lại trang thanh toán (giữ dữ liệu đã nhập) — dùng khi cần thử lại / hỏi xác minh.
  // Sinh idem MỚI ở đây và ràng buộc challenge vào chính idem đó (chống replay).
  const reRender = async ({ needChallenge, ...opts }) => {
    const token = parseCookies(req)[CART_COOKIE];
    const summary = await withTenant(ctx.shopId, async (c) => {
      const cart = await findCart(c, token);
      return cart ? summarize(c, cart.id) : { items: [] };
    });
    if (!summary.items.length) return redirect(res, '/cart');
    const idem = genToken();
    const prefill = { name: form.name, phone: form.phone, email: form.email, address_line: form.address_line, province: form.province, payment_method: form.payment_method };
    return sendHtml(res, opts.status ?? 200, renderCheckout(shopName, summary, idem, { formTs: issueFormTs(), prefill, challenge: needChallenge ? issueChallenge(idem) : undefined, ...opts }));
  };

  // ── Lớp BOT no-JS ────────────────────────────────────────────────────────────
  // (a) Honeypot: trường ẩn 'company' — người thật không thấy nên bỏ trống; bot điền → chặn.
  if (String(form.company ?? '').trim() !== '') return sendHtml(res, 400, renderError(shopName, 'Không đặt được đơn.'));
  // (b) Time-trap: token thời gian ký. Giả/hết hạn/điền quá nhanh (bot) → dựng lại form.
  const ts = verifyFormTs(form.ct);
  if (!ts.valid || ts.age > FORM_MAX_AGE_MS) return reRender({ error: 'Phiên thanh toán đã hết hạn. Vui lòng kiểm tra thông tin và bấm Đặt hàng lại.' });
  if (ts.age < MIN_FILL_MS) return reRender({ error: 'Bạn thao tác hơi nhanh — vui lòng bấm Đặt hàng lại để xác nhận.' });

  const f = parseOrderInput({ name: form.name, phone: form.phone, email: form.email, address: form.address_line ? { line: String(form.address_line).slice(0, 300), province: form.province ? String(form.province).slice(0, 60) : undefined } : null, payment_method: form.payment_method });
  if (f.error) return reRender({ error: f.error });

  // (c) Leo thang: nguồn (IP) đã nhiều đơn CHỜ → bắt trả lời câu hỏi toán (ký HMAC).
  if (ctx.ip) {
    const ipHash = hashIp(ctx.ip);
    const nPending = await withTenant(ctx.shopId, async (c) =>
      Number((await c.query(`SELECT count(*)::int n FROM orders WHERE shop_id = current_shop_id() AND client_ip_hash = $1 AND status = 'pending'`, [ipHash])).rows[0].n));
    if (nPending >= CHALLENGE_AFTER_PENDING) {
      if (!verifyChallenge(form.challenge_sig, form.challenge_answer, idemKey)) {
        return reRender({ needChallenge: true, error: 'Vui lòng trả lời câu hỏi xác minh để tiếp tục đặt hàng.' });
      }
    }
  }

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
  return sendHtml(res, 200, renderCheckout(await getShopName(ctx.shopId), summary, genToken(), { formTs: issueFormTs() }));
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
  { m: 'POST', p: '/cart/coupon', fn: applyCouponForm, form: true },
  { m: 'POST', p: '/checkout', fn: checkout },
  { m: 'POST', p: '/checkout/place', fn: checkoutPlace, form: true },
  { m: 'GET', p: '/checkout', fn: getCheckoutPage },
  { m: 'GET', p: '/checkout/lookup', fn: getLookupPage },
  { m: 'GET', p: '/checkout/success', fn: getSuccessPage },
  { m: 'GET', p: '/checkout/order', fn: orderLookup },
  { m: 'POST', p: '/checkout/review', fn: submitReviewForm, form: true },
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
    // host: build link tra cứu đơn trong email (bỏ port nội bộ; Caddy route theo host shop).
    const ctx = { shopId, ip: clientIp(req), host: String(req.headers.host ?? '').split(':')[0].toLowerCase() };
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
