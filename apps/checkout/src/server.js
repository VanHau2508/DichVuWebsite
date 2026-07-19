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
import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';
import { readJson, readForm, send, sendHtml, redirect, wantsHtml, parseCookies, setCartCookie, sameOrigin, clientIp, CART_COOKIE } from './http.js';
import { buildVietQR } from './vietqr.js';
import { renderCart, renderCheckout, renderOrder, renderError, renderLookup, qrSvg } from './pages.js';
import { runReq, makeLog, health } from './obs.js';
import { isProvince, regionOf } from './provinces.js';
import { haversineKm, inVietnam } from './geo.js';
import { reverseGeocode, normalizeProvince, GEOCODE_ON } from './geocode.js';
// Bộ đếm rate-limit DÙNG CHUNG với auth (atomic Lua, FAIL-OPEN khi Redis lỗi). File
// gắn vào /app/ratelimit.js qua bind-mount trong compose.dev.yml (không copy, không sửa).
import { hit } from '../ratelimit.js';

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

// ── Rate-limit hạ tầng (Đợt 6.2) ───────────────────────────────────────────────
// Image checkout là bản TỐI GIẢN (chỉ src + pg), KHÔNG có ioredis. Rate-limit chỉ cần
// EVAL (cho ratelimit.js) + DEL, nên tự nói RESP qua net (built-in) — không thêm
// dependency, không rebuild image (khớp luồng dev: bind-mount + restart). Ngữ nghĩa
// GIỐNG cấu hình Redis của auth: Redis chưa sẵn sàng / lệnh quá hạn → REJECT NGAY (không
// treo); nuốt lỗi socket. hit() bắt mọi lỗi → FAIL-OPEN, không bao giờ làm sập checkout.
function respParse(b, i) {
  if (i >= b.length) return { ok: false };
  const type = b[i];
  const nl = b.indexOf('\r\n', i + 1);
  if (nl < 0) return { ok: false };
  const line = b.toString('latin1', i + 1, nl);
  const after = nl + 2;
  if (type === 0x2b) return { ok: true, value: line, next: after };
  if (type === 0x2d) return { ok: true, value: new Error(line), next: after, err: true };
  if (type === 0x3a) return { ok: true, value: Number(line), next: after };
  if (type === 0x24) {
    const len = Number(line);
    if (len < 0) return { ok: true, value: null, next: after };
    const end = after + len;
    if (end + 2 > b.length) return { ok: false };
    return { ok: true, value: b.toString('utf8', after, end), next: end + 2 };
  }
  if (type === 0x2a) {
    const n = Number(line);
    if (n < 0) return { ok: true, value: null, next: after };
    const arr = []; let p = after;
    for (let k = 0; k < n; k++) { const el = respParse(b, p); if (!el.ok) return { ok: false }; arr.push(el.value); p = el.next; }
    return { ok: true, value: arr, next: p };
  }
  return { ok: false };
}
function makeRedis(url, { commandTimeout = 1000 } = {}) {
  const u = new URL(url);
  const host = u.hostname, port = Number(u.port || 6379);
  let sock = null, ready = false, buf = Buffer.alloc(0);
  const pending = []; // resolver theo ĐÚNG thứ tự Redis trả lời (1 kết nối = FIFO)
  function fail(err) {
    ready = false;
    while (pending.length) { const p = pending.shift(); clearTimeout(p.timer); p.reject(err); }
    if (sock) { sock.removeAllListeners(); sock.destroy(); sock = null; }
    setTimeout(connect, 500).unref();
  }
  function connect() {
    try {
      sock = net.connect({ host, port });
      sock.setNoDelay(true);
      sock.on('connect', () => { ready = true; });
      sock.on('error', () => {});
      sock.on('close', () => fail(new Error('redis closed')));
      sock.on('data', (chunk) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        let out;
        while (pending.length && (out = respParse(buf, 0)).ok) {
          buf = buf.subarray(out.next);
          const p = pending.shift(); clearTimeout(p.timer);
          out.err ? p.reject(out.value) : p.resolve(out.value);
        }
      });
    } catch { ready = false; setTimeout(connect, 500).unref(); }
  }
  function send2(args) {
    return new Promise((resolve, reject) => {
      if (!ready || !sock) return reject(new Error('redis not ready')); // enableOfflineQueue:false
      let cmd = `*${args.length}\r\n`;
      for (const a of args) { const s = String(a); cmd += `$${Buffer.byteLength(s)}\r\n${s}\r\n`; }
      const timer = setTimeout(() => fail(new Error('redis timeout')), commandTimeout);
      pending.push({ resolve, reject, timer });
      sock.write(cmd);
    });
  }
  connect();
  return {
    eval: (script, numkeys, ...rest) => send2(['EVAL', script, numkeys, ...rest]),
    del: (key) => send2(['DEL', key]),
  };
}
// REDIS_URL vắng → không dựng client → gate tự bỏ qua (fail-open). Không chặn khởi động.
const redis = process.env.REDIS_URL ? makeRedis(process.env.REDIS_URL, { commandTimeout: 1000 }) : null;
// Cổng NGOÀI per-IP cho thao tác GHI (POST/PATCH giỏ + checkout). 120/60s: rộng cho khách
// thật (giỏ đua 10 request đồng thời vẫn lọt), đủ chặt để chặn flood. Chỉnh được qua env.
const CO_RL = Number(process.env.CHECKOUT_RL_PER_MIN) || 120;
const RL_HTML = '<!doctype html><meta charset="utf-8"><title>Quá nhanh</title><body style="font-family:system-ui,sans-serif;text-align:center;padding:48px 16px"><h1>Bạn thao tác quá nhanh</h1><p>Vui lòng thử lại sau chút.</p></body>';

const genToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function resolveShop(hostname) {
  const { rows } = await db.query(`SELECT shop_id FROM domains WHERE hostname = $1 AND verified_at IS NOT NULL`, [hostname]);
  return rows[0]?.shop_id ?? null;
}
const CUSTOMER_COOKIE = '__Host-cust_session';
// Khách đăng nhập (0083): đọc cookie __Host-cust_session → phiên hợp lệ + khách active. Trả
// {id, full_name, phone, email, addr} để prefill + stamp orders.customer_id. app_checkout có
// SELECT customers/customer_sessions/customer_addresses theo cột (KHÔNG password_hash). Địa chỉ
// đọc theo customer_id RÚT TỪ PHIÊN (không từ form) — không IDOR.
async function resolveCustomer(shopId, req, { withAddresses = false } = {}) {
  const tok = parseCookies(req)[CUSTOMER_COOKIE];
  if (!tok) return null;
  return withTenant(shopId, async (c) => {
    const cu = (await c.query(
      `SELECT cu.id, cu.full_name, cu.phone, cu.email FROM customer_sessions s JOIN customers cu ON cu.id = s.customer_id
        WHERE s.token_hash = $1 AND s.shop_id = current_shop_id() AND s.revoked_at IS NULL AND s.expires_at > now() AND cu.status = 'active'`,
      [sha256(tok)])).rows[0];
    if (!cu) return null;
    // Địa chỉ đọc theo customer_id RÚT TỪ PHIÊN (không từ form) → chống IDOR. withAddresses:
    // nạp CẢ danh sách để checkout hiện "chọn nhanh địa chỉ" (khớp address_choice trong bộ nhớ →
    // id địa chỉ khách khác không có trong list → không dùng được, không cần query riêng).
    const rows = (await c.query(
      `SELECT id, recipient_name, phone, line1, ward, district, province, is_default FROM customer_addresses
        WHERE customer_id = $1 ORDER BY is_default DESC, created_at${withAddresses ? '' : ' LIMIT 1'}`, [cu.id])).rows;
    return { ...cu, addr: rows[0] ?? null, ...(withAddresses ? { addresses: rows } : {}) };
  }).catch(() => null);
}
// Gộp các trường địa chỉ đã lưu thành 1 dòng địa chỉ giao (line1 + ward/district; province riêng).
function savedAddrLine(a) { return [a.line1, a.ward, a.district].filter(Boolean).join(', '); }
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

async function findCart(c, token, { forUpdate = false } = {}) {
  if (!token) return null;
  // forUpdate: KHOÁ HÀNG giỏ khi TẠO ĐƠN (createOrderTx). Không có nó, N request đồng thời
  // (khác Idempotency-Key, cùng cart cookie) đều đọc giỏ 'active' TRƯỚC khi cái nào commit
  // → 1 giỏ đẻ N đơn + reserved phình N (kiểm toán tấn công Đợt 6). FOR UPDATE tuần tự hoá:
  // cái sau chờ cái trước commit rồi RE-CHECK status='active' (READ COMMITTED) → thấy
  // 'converted' → 0 dòng → fail. Các nơi CHỈ ĐỌC (getCart/summarize/render) không dùng khoá.
  const r = await c.query(
    `SELECT id FROM carts WHERE token_hash = $1 AND status = 'active' AND expires_at > now()${forUpdate ? ' FOR UPDATE' : ''}`,
    [hashToken(token)]);
  return r.rows[0] ?? null;
}

// Phí ship theo shop (đọc trong tenant context). NULL → mặc định nền tảng (tương thích
// ngược). Dùng CHUNG cho summarize (hiển thị) và createOrderTx (tính đơn) → luôn khớp.
async function shopShipping(c) {
  const s = (await c.query(`SELECT ship_fee_vnd, free_ship_threshold_vnd, ship_fee_far_vnd, ship_extra_per_500g_vnd, default_weight_gram, ship_from_province,
              ship_mode, ship_origin_lat, ship_origin_lng, ship_base_vnd, ship_per_km_vnd, ship_max_km, ship_road_factor, ship_over_max_behavior FROM shops WHERE id = current_shop_id()`)).rows[0] ?? {};
  return {
    fee: s.ship_fee_vnd != null ? Number(s.ship_fee_vnd) : SHIP_FEE,
    threshold: s.free_ship_threshold_vnd != null ? Number(s.free_ship_threshold_vnd) : null,
    feeFar: s.ship_fee_far_vnd != null ? Number(s.ship_fee_far_vnd) : null,        // NULL = không phân vùng (phí phẳng như cũ)
    extraPer500g: s.ship_extra_per_500g_vnd != null ? Number(s.ship_extra_per_500g_vnd) : 0,
    defaultWeightGram: Number(s.default_weight_gram ?? 500),
    fromRegion: regionOf(s.ship_from_province), // null nếu shop chưa khai / tên lạ → bỏ bậc vùng
    // Ship theo km (0089). mode='distance' + gốc + đơn giá; NULL/region → hành vi 0063 y nguyên.
    mode: s.ship_mode ?? 'region',
    originLat: s.ship_origin_lat != null ? Number(s.ship_origin_lat) : null,
    originLng: s.ship_origin_lng != null ? Number(s.ship_origin_lng) : null,
    base: s.ship_base_vnd != null ? Number(s.ship_base_vnd) : null,
    perKm: s.ship_per_km_vnd != null ? Number(s.ship_per_km_vnd) : null,
    maxKm: s.ship_max_km != null ? Number(s.ship_max_km) : null,
    roadFactor: s.ship_road_factor != null ? Number(s.ship_road_factor) : 1.3,
    overMax: s.ship_over_max_behavior ?? 'region', // ngoài bán kính nội thành: 'region' (toàn quốc) | 'reject' (chỉ nội thành)
  };
}
// Khoảng cách giao (mét) từ gốc shop tới toạ độ khách — CHỈ khi shop bật distance + toạ độ hợp lệ
// (trong VN). haversine × road_factor. Trả {coordsValid, distanceMeters}. Client gửi coords là INPUT.
function resolveShipDistance(cfg, coords) {
  if (cfg.mode !== 'distance' || !coords || cfg.originLat == null || cfg.originLng == null) return { coordsValid: false, distanceMeters: null };
  if (!inVietnam(coords.lat, coords.lng)) return { coordsValid: false, distanceMeters: null }; // ngoài VN → rơi phí vùng
  return { coordsValid: true, distanceMeters: haversineKm(cfg.originLat, cfg.originLng, coords.lat, coords.lng) * 1000 * cfg.roadFactor };
}
// Toạ độ từ form (hidden lat/lng JS GPS đặt) — CHỈ nhận khi hữu hạn + trong biên (chống NaN).
function parseCoords(latRaw, lngRaw) {
  const lat = Number(latRaw), lng = Number(lngRaw);
  return (Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) ? { lat, lng } : null;
}
// Phí ship 2 bậc vùng (nội miền / liên miền) + phụ phí cân (mỗi 500g vượt 500g đầu).
// HAI CHẾ ĐỘ một hàm: HIỂN THỊ (assumeFarWhenUnknown=false — chưa rõ tỉnh → ước tính
// nội miền + ghi chú) và CHỐT ĐƠN (true — không rõ tỉnh → tính LIÊN MIỀN, bảo vệ shop:
// Origin header giả được bằng curl nên người mua rành kỹ thuật không né được phí xa).
// items: [{qty, weight_gram}] — weight_gram NULL → dùng cân mặc định của shop.
// Phụ phí cân: mỗi 500g vượt 500g đầu.
function weightSurcharge(cfg, items) {
  if (!(cfg.extraPer500g > 0)) return 0;
  const grams = items.reduce((s, it) => s + it.qty * (it.weight_gram != null ? Number(it.weight_gram) : cfg.defaultWeightGram), 0);
  return Math.ceil(Math.max(0, grams - 500) / 500) * cfg.extraPer500g;
}
// Phí VÙNG core (2 bậc nội/liên miền + phụ phí cân), KHÔNG freeship — dùng làm SÀN cho distance + path region (0063).
function regionFeeCore(cfg, items, province, assumeFarWhenUnknown) {
  let fee = cfg.fee;
  if (cfg.feeFar != null && cfg.fromRegion) {
    const to = regionOf(province);
    fee = to == null ? (assumeFarWhenUnknown ? cfg.feeFar : cfg.fee) : (to === cfg.fromRegion ? cfg.fee : cfg.feeFar);
  }
  return fee + weightSurcharge(cfg, items);
}
// HAI CHẾ ĐỘ (choke-point phí DUY NHẤT, dùng chung hiển thị + chốt đơn): region (0063) và distance (0089).
// Trả NULL = NGOÀI VÙNG GIAO (km>max) → caller 422 hard-stop (KHÔNG về 0 = free-ship âm thầm).
function computeShipping(cfg, subtotal, items, province, { assumeFarWhenUnknown = false, coordsValid = false, distanceMeters = null } = {}) {
  if (!items.length) return 0;
  const freeship = cfg.threshold != null && subtotal >= cfg.threshold;
  // Distance CHỈ khi shop bật + server xác thực coords hợp lệ (trong VN). Client KHÔNG tự chọn chế độ.
  if (cfg.mode === 'distance' && coordsValid && distanceMeters != null) {
    const km = Math.ceil(distanceMeters / 1000);                    // ceil → nhích coords vài mét không đổi phí
    // NGOÀI bán kính giao nội thành: nền tảng TOÀN QUỐC → rơi phí VÙNG (giao qua hãng, KHÔNG per-km
    // vô lý Cà Mau→Hà Nội); shop CHỈ giao nội thành ('reject') → 422 ngoài-vùng (thắng cả freeship).
    if (cfg.maxKm != null && km > cfg.maxKm) {
      if (cfg.overMax === 'reject') return null;
      return freeship ? 0 : regionFeeCore(cfg, items, province, assumeFarWhenUnknown);
    }
    if (freeship) return 0;
    const fee = cfg.base + km * cfg.perKm + weightSurcharge(cfg, items);
    // SÀN PHÍ (red-team): không thấp hơn bậc vùng → toạ-độ-giả-sát-shop KHÔNG rẻ hơn khách-xa-trung-thực.
    return Math.max(fee, regionFeeCore(cfg, items, province, assumeFarWhenUnknown));
  }
  // Region mode / distance fallback (no-JS / từ chối GPS / ngoài VN):
  if (freeship) return 0;
  return regionFeeCore(cfg, items, province, assumeFarWhenUnknown);
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

async function summarize(c, cartId, province = null, coords = null) {
  const items = (await c.query(
    `SELECT ci.variant_id, ci.qty, v.price_vnd, v.weight_gram, v.title AS variant_title, v.sku, p.title AS product_title, p.slug,
            pe.price_vnd AS sale_price_vnd, pe.off_pct AS sale_off_pct,
            (SELECT m.public_key FROM media m WHERE m.product_id = p.id ORDER BY m.position, m.created_at LIMIT 1) AS image_key
       FROM cart_items ci JOIN variants v ON v.id = ci.variant_id JOIN products p ON p.id = v.product_id
       LEFT JOIN LATERAL promo_effective(p.id, v.price_vnd, now()) pe ON true
      WHERE ci.cart_id = $1 ORDER BY ci.created_at`, [cartId],
  )).rows;
  let subtotal = 0;
  const out = items.map((it) => {
    // GIÁ HIỆU LỰC: promo_effective (flash sale 0082) NẾU đang chạy, không thì giá gốc variants.
    const base = Number(it.price_vnd);
    const unit = it.sale_price_vnd != null ? Number(it.sale_price_vnd) : base;
    subtotal += unit * it.qty;
    return { variant_id: it.variant_id, product_title: it.product_title, variant_title: it.variant_title, sku: it.sku, unit_price_vnd: unit, qty: it.qty, line_total_vnd: unit * it.qty, image: imgUrl(it.image_key),
      ...(it.sale_price_vnd != null ? { orig_unit_price_vnd: base, sale_off_pct: Number(it.sale_off_pct) } : {}) };
  });
  const cfg = await shopShipping(c);
  const { coordsValid, distanceMeters } = resolveShipDistance(cfg, coords);
  const shipping = computeShipping(cfg, subtotal, items, province, { coordsValid, distanceMeters }); // HIỂN THỊ: chưa rõ tỉnh → ước tính nội miền
  const outOfRange = shipping === null; // NGOÀI VÙNG GIAO (distance km>max) → total không tính được
  // Cờ cho UI: shop CÓ phí liên miền nhưng CHƯA rõ tỉnh nhận → hiện ghi chú "chưa gồm phụ phí liên miền".
  const feeRegionPending = items.length > 0 && cfg.feeFar != null && cfg.fromRegion != null
    && regionOf(province) == null && !(cfg.threshold != null && subtotal >= cfg.threshold);
  // Mã giảm giá đang áp trên giỏ — re-validate theo subtotal hiện tại (mã hết hạn/không đủ đơn → bỏ qua).
  const cc = (await c.query(`SELECT coupon_code FROM carts WHERE id = $1`, [cartId])).rows[0]?.coupon_code;
  const coupon = cc ? await resolveCoupon(c, cc, subtotal) : null;
  const discount = coupon?.discount ?? 0;
  return { items: out, subtotal_vnd: subtotal, shipping_vnd: outOfRange ? null : shipping, discount_vnd: discount, coupon_code: coupon?.code ?? null,
    total_vnd: outOfRange ? null : subtotal - discount + shipping, fee_region_pending: feeRegionPending, ship_out_of_range: outOfRange,
    distance_mode: cfg.mode === 'distance' };
}

// Shop có BẬT thanh toán QR (VietQR) đầy đủ chưa? Mặc định shop chỉ-COD KHÔNG có row → false →
// checkout ẨN radio QR (chống ngõ-cụt: trước đây radio QR luôn hiện, khách chọn → fail(400) →
// trang lỗi cụt mất data). Điều kiện KHỚP createOrderTx (qr_enabled + bank_bin + account_number).
async function shopQrEnabled(c) {
  const cfg = (await c.query(`SELECT qr_enabled, bank_bin, account_number FROM shop_payment_config WHERE shop_id = current_shop_id()`)).rows[0];
  return !!(cfg && cfg.qr_enabled && cfg.bank_bin && cfg.account_number);
}

// Tên shop (cho header trang HTML). app_checkout có SELECT shops (policy checkout_shop).
async function getShopName(shopId) {
  try { return await withTenant(shopId, async (c) => (await c.query(`SELECT name FROM shops WHERE id = current_shop_id()`)).rows[0]?.name ?? null); }
  catch { return null; }
}

// Predicate "biến thể KHÔNG MỒ CÔI": phải có ánh xạ variant_option_values cho MỌI trục
// (product_options) hiện tại của sản phẩm. Shop thu hẹp phân loại → biến thể tổ hợp cũ mất
// hết ánh xạ (cascade) nhưng vẫn active + giữ GIÁ/TỒN CŨ → đường tiền phải CHẶN (không cho
// thêm giỏ, không chốt đơn giá cũ). SP phẳng (0 option) thoả rỗng → mua bình thường.
// Cần grant+policy app_checkout trên 2 bảng option (migration 0057). Alias `v` = variants.
const VARIANT_NOT_ORPHAN_SQL = `NOT EXISTS (
  SELECT 1 FROM product_options po WHERE po.product_id = v.product_id
    AND NOT EXISTS (SELECT 1 FROM variant_option_values vov
                     WHERE vov.variant_id = v.id AND vov.option_id = po.id))`;

// ── cart handlers (lõi dùng chung JSON + form) ───────────────────────────────
async function cartAddCore(c, token, variantId, qty) {
  // RLS: chỉ variant active; kèm chặn biến thể MỒ CÔI (mồ côi == 'ngừng bán').
  const v = (await c.query(
    `SELECT 1 FROM variants v WHERE v.id = $1 AND ${VARIANT_NOT_ORPHAN_SQL}`, [variantId],
  )).rows[0];
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
  const cust = await resolveCustomer(ctx.shopId, req); // đăng nhập? → widget đổi điểm
  const summary = await withTenant(ctx.shopId, async (c) => {
    if (cust?.id) await c.query(`SELECT set_config('app.customer_id', $1, true)`, [cust.id]);
    const cart = await findCart(c, token);
    const base = cart ? await summarize(c, cart.id) : { items: [], subtotal_vnd: 0, shipping_vnd: 0, total_vnd: 0 };
    // Điểm thưởng (0086): CHỈ khi shop BẬT + khách ĐĂNG NHẬP. Hiển thị số dư + số điểm đang áp +
    // giảm giá (client-side chỉ để XEM; checkout re-tính dưới khoá là chân lý). Điểm giảm tiền HÀNG.
    if (cust?.id && cart) {
      const cfg = (await c.query(`SELECT enabled, redeem_vnd_per_point, max_redeem_pct FROM shop_loyalty_config WHERE shop_id = current_shop_id()`)).rows[0];
      if (cfg?.enabled) {
        const bal = (await c.query(`SELECT balance_points FROM loyalty_balances WHERE customer_id = current_customer_id()`)).rows[0];
        const balance = Math.max(0, bal ? Number(bal.balance_points) : 0);
        const perPoint = Number(cfg.redeem_vnd_per_point);
        const goods = base.subtotal_vnd - (base.discount_vnd ?? 0);
        const maxPoints = Math.max(0, Math.min(balance, Math.floor(goods / perPoint), Math.floor((goods * Number(cfg.max_redeem_pct) / 100) / perPoint)));
        const want = Number((await c.query(`SELECT points_redeem FROM carts WHERE id = $1`, [cart.id])).rows[0]?.points_redeem ?? 0);
        const applied = Math.min(want, maxPoints);
        const pointsDiscount = applied * perPoint;
        base.loyalty = { balance, per_point_vnd: perPoint, max_points: maxPoints, applied_points: applied };
        base.points_discount_vnd = pointsDiscount;
        base.total_vnd = base.total_vnd - pointsDiscount; // total hiển thị đã trừ điểm (chân lý ở checkout)
      }
    }
    return base;
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

// Đổi điểm (0086): stamp số điểm khách muốn đổi lên giỏ. Số dư + trần cắt ở checkout (chân lý
// dưới khoá) — đây chỉ ghi ý định. Khách chưa đăng nhập vẫn stamp được nhưng checkout bỏ qua.
async function applyPointsForm(req, res, form, ctx) {
  const token = parseCookies(req)[CART_COOKIE];
  const want = Math.max(0, Math.min(10_000_000, parseInt(form.points ?? '0', 10) || 0));
  try {
    await withTenant(ctx.shopId, async (c) => {
      const cart = await findCart(c, token);
      if (cart) await c.query(`UPDATE carts SET points_redeem = $2, updated_at = now() WHERE id = $1`, [cart.id, want]);
    });
    return redirect(res, '/cart');
  } catch (err) {
    if (err.statusCode) return sendHtml(res, err.statusCode, renderError(await getShopName(ctx.shopId), err.body?.error ?? 'Không áp được điểm.'));
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
    // Toạ độ GPS (0089): CHỈ nhận khi HỮU HẠN + trong biên (red-team: 'abc'/Infinity → NaN phí/total).
    // Rác/thiếu → coords bỏ (undefined) → rơi phí vùng. lat/lng là INPUT; phí tính SERVER.
    const lat = Number(raw.address.lat), lng = Number(raw.address.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      address.lat = lat; address.lng = lng;
    }
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
  // Đổi điểm (0086): số điểm khách muốn đổi (API JSON). null = không truyền → checkout đọc từ giỏ.
  // Server cắt theo trần + số dư dưới khoá; đây chỉ nhận số nguyên ≥0 (bỏ rác).
  const pointsRedeem = raw.points_redeem != null && raw.points_redeem !== '' && Number.isFinite(Number(raw.points_redeem))
    ? Math.max(0, Math.trunc(Number(raw.points_redeem))) : null;
  return { name, phone: phoneCanon, email, address, paymentMethod, pointsRedeem }; // phone đã chuẩn hoá → trần theo-SĐT luôn khớp
}

// Lõi tạo đơn (transaction). Ném fail() khi lỗi nghiệp vụ → withTenant ROLLBACK.
async function createOrderTx(c, ctx, token, idemKey, f) {
  const { name, phone, email, address, paymentMethod } = f;
  {
    // request_hash: nội dung ĐƠN, KHÔNG gồm bất kỳ giá/total nào client gửi. GỒM pointsRedeem
    // (input khách chọn như payment_method) → retry cùng key khác số điểm → 422, không double-spend.
    const requestHash = sha256(idemKey + JSON.stringify({ name, phone, email, address, paymentMethod, pointsRedeem: f.pointsRedeem ?? null }));
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

    // Đặt GUC danh tính khách (0083) → RLS 2 trục cho loyalty_ledger/balances (đổi điểm dưới).
    // Chỉ khi ĐĂNG NHẬP; guest → NULL → không đọc/ghi được điểm (fail-closed).
    if (ctx.customerId) await c.query(`SELECT set_config('app.customer_id', $1, true)`, [ctx.customerId]);

    const cart = await findCart(c, token, { forUpdate: true });
    if (!cart) fail(400, 'giỏ hàng trống hoặc hết hạn');
    // Phòng thủ nhiều lớp: loại biến thể MỒ CÔI khỏi đơn (đã vào giỏ TRƯỚC khi shop thu hẹp
    // phân loại) — không bao giờ reserve/snapshot theo giá/tồn cũ. Giỏ rỗng ra → fail dưới.
    const items = (await c.query(
      `SELECT ci.variant_id, ci.qty, v.price_vnd, v.weight_gram, v.title AS variant_title, v.sku, p.title AS product_title,
              pe.price_vnd AS sale_price_vnd, pe.promotion_id
         FROM cart_items ci JOIN variants v ON v.id = ci.variant_id JOIN products p ON p.id = v.product_id
         LEFT JOIN LATERAL promo_effective(p.id, v.price_vnd, now()) pe ON true
        WHERE ci.cart_id = $1 AND ${VARIANT_NOT_ORPHAN_SQL}
        ORDER BY ci.created_at`, [cart.id],
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
      // GIÁ HIỆU LỰC = flash sale (0082) nếu đang chạy TẠI now() của tx, không thì giá gốc.
      // orig = giá gốc CHỈ khi có sale (snapshot thông tin — không cộng vào tiền nào).
      const base = Number(it.price_vnd);
      const unit = it.sale_price_vnd != null ? Number(it.sale_price_vnd) : base;
      subtotal += unit * it.qty;
      lines.push({ variant_id: it.variant_id, title: it.product_title + (it.variant_title ? ` - ${it.variant_title}` : ''), sku: it.sku, unit, qty: it.qty,
        orig: it.sale_price_vnd != null ? base : null, promotion_id: it.sale_price_vnd != null ? it.promotion_id : null });
    }
    // Vòng trung thực GIÁ no-JS: subtotal (đã sale, trước coupon) khách ĐÃ THẤY (hidden
    // subtotal_seen) khác subtotal tính lại tại now() (promo vừa hết → tăng, hoặc vừa bật →
    // giảm) → 409 NGAY TRONG transaction (rollback reserve/coupon/idem) → checkoutPlace dựng
    // lại form với giá mới. So khớp CẢ HAI chiều (như ship_seen). API JSON không gửi
    // subtotal_seen → expectedSubtotal null → bỏ qua cổng (đọc giá hiện hành).
    if (f.expectedSubtotal != null && subtotal !== f.expectedSubtotal) fail(409, 'giá sản phẩm vừa cập nhật', { subtotal_vnd: subtotal });
    // Chế độ CHỐT ĐƠN: không rõ tỉnh → tính LIÊN MIỀN (bảo vệ shop — xem computeShipping).
    // Ship theo km (0089): coords từ form (đã finite-validate ở parseOrderInput) → tính OFFLINE
    // (haversine, KHÔNG gọi API bản đồ → đặt đơn độc lập uptime provider). Server tính lại phí từ
    // coords → curl giả toạ độ/forge ship_seen vẫn bị tính lại + 409.
    const shipCfg = await shopShipping(c);
    const coords = (address?.lat != null && address?.lng != null) ? { lat: address.lat, lng: address.lng } : null;
    const { coordsValid, distanceMeters } = resolveShipDistance(shipCfg, coords);
    const shipping = computeShipping(shipCfg, subtotal, items, address?.province, { assumeFarWhenUnknown: true, coordsValid, distanceMeters });
    // NGOÀI VÙNG GIAO (distance km>max) → sentinel null → 422 hard-stop TRƯỚC cổng 409 + TRƯỚC total
    // (red-team: null vào 409 → thông điệp sai; vào total → NaN).
    if (shipping === null) fail(422, 'Địa chỉ ngoài vùng giao của cửa hàng', { out_of_range: true });
    // Vòng trung thực phí no-JS: phí khách ĐÃ THẤY (hidden ship_seen, chỉ form gửi) khác phí
    // thật → 409 NGAY TRONG transaction (rollback reserve/coupon/idem — không TOCTOU) →
    // checkoutPlace dựng lại form với phí đúng cho một cú bấm xác nhận nữa. ship_seen chỉ
    // dùng để SO SÁNH — tuyệt đối không đưa vào total.
    if (f.expectedShipping != null && shipping !== f.expectedShipping) fail(409, 'phí giao hàng đã cập nhật', { shipping_vnd: shipping });
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
    // ── ĐỔI ĐIỂM (0086): CHỈ khách ĐĂNG NHẬP. Giảm giá tiền HÀNG (không giảm ship). NGUYÊN TỬ:
    // khoá số dư FOR UPDATE (đọc CHÂN LÝ dưới khoá — chống double-spend + lost-update với worker
    // tích/thu-hồi), cắt theo 3 trần (số dư / tiền hàng còn lại / %tiền hàng), trừ + ghi sổ.
    let pointsRedeemed = 0, pointsDiscount = 0;
    if (ctx.customerId) {
      const lc = (await c.query(`SELECT enabled, redeem_vnd_per_point, min_redeem_points, max_redeem_pct FROM shop_loyalty_config WHERE shop_id = current_shop_id()`)).rows[0];
      // want = số điểm khách muốn đổi: từ input JSON (f.pointsRedeem) hoặc đã stamp trên giỏ (form).
      const want = f.pointsRedeem != null ? Math.max(0, Math.trunc(Number(f.pointsRedeem)) || 0)
        : Number((await c.query(`SELECT points_redeem FROM carts WHERE id = $1`, [cart.id])).rows[0]?.points_redeem ?? 0);
      if (lc?.enabled && want > 0) {
        const bal = (await c.query(`SELECT balance_points FROM loyalty_balances WHERE shop_id = current_shop_id() AND customer_id = $1 FOR UPDATE`, [ctx.customerId])).rows[0];
        const balance = bal ? Number(bal.balance_points) : 0;
        const goods = subtotal - discount;                 // tiền HÀNG còn lại (sau sale + coupon)
        const perPoint = Number(lc.redeem_vnd_per_point);
        const maxPoints = Math.max(0, Math.min(
          balance,                                          // (1) số dư khả dụng
          Math.floor(goods / perPoint),                    // (2) không vượt tiền hàng
          Math.floor((goods * Number(lc.max_redeem_pct) / 100) / perPoint), // (3) % tiền hàng/đơn
        ));
        const pts = Math.min(want, maxPoints);
        if (pts > 0 && pts >= Number(lc.min_redeem_points ?? 0)) {
          pointsRedeemed = pts;
          pointsDiscount = pts * perPoint;
          await c.query(`UPDATE loyalty_balances SET balance_points = balance_points - $2, updated_at = now() WHERE shop_id = current_shop_id() AND customer_id = $1`, [ctx.customerId, pts]);
        }
      }
    }
    const total = subtotal - discount - pointsDiscount + shipping;

    // QR: cần cấu hình ngân hàng của shop + mã đối soát duy nhất.
    let paymentRef = null;
    let qrString = null;
    let qrAccount = null;
    if (paymentMethod === 'qr') {
      const cfg = (await c.query(
        `SELECT bank_bin, account_number, account_name, qr_enabled FROM shop_payment_config WHERE shop_id = current_shop_id()`,
      )).rows[0];
      if (!cfg || !cfg.qr_enabled || !cfg.bank_bin || !cfg.account_number) fail(400, 'shop chưa bật thanh toán QR', { qr_unavailable: true });
      paymentRef = 'NTG' + crypto.randomBytes(6).toString('hex').toUpperCase(); // duy nhất (UNIQUE ở orders)
      qrAccount = cfg.account_number; // snapshot tài khoản nhận → webhook đối chiếu
      qrString = buildVietQR({ bankBin: cfg.bank_bin, accountNumber: cfg.account_number, amountVnd: total, content: paymentRef });
    }

    const num = (await c.query(
      `INSERT INTO shop_counters (shop_id, name, value) VALUES (current_shop_id(), 'order_number', 1)
       ON CONFLICT (shop_id, name) DO UPDATE SET value = shop_counters.value + 1 RETURNING value`,
    )).rows[0].value;

    const lookupToken = genToken();
    // customer_id (0083): ĐÓNG DẤU khách đăng nhập → đơn tự vào lịch sử /account/orders. RÚT
    // TỪ PHIÊN (ctx.customerId), KHÔNG từ form. FK composite (shop_id,customer_id) chống gán chéo.
    const order = (await c.query(
      `INSERT INTO orders (shop_id, order_number, status, payment_status, payment_method,
         customer_name, customer_phone, customer_email, shipping_address,
         subtotal_vnd, shipping_vnd, discount_vnd, total_vnd, lookup_token_hash, payment_ref, qr_account, coupon_code, client_ip_hash, customer_id,
         points_redeemed, points_discount_vnd)
       VALUES (current_shop_id(), $1, 'pending', 'unpaid', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id`,
      [num, paymentMethod, name, phoneCanon ?? phone, email, address, subtotal, shipping, discount, total, hashToken(lookupToken), paymentRef, qrAccount, couponCode, ipHash, ctx.customerId ?? null, pointsRedeemed, pointsDiscount],
    )).rows[0];
    // Sổ điểm ĐỔI (0086): ghi SAU khi có order.id → UNIQUE loyalty_ledger_redeem_once(shop,order)
    // = đúng 1 dòng/đơn. Số dư đã trừ ở trên (cùng tx, khoá FOR UPDATE) → nguyên tử. Nếu tx
    // rollback (đua giỏ 409 dưới) thì cả trừ điểm lẫn đơn cùng biến mất.
    if (pointsRedeemed > 0) {
      await c.query(
        `INSERT INTO loyalty_ledger (shop_id, customer_id, kind, delta, order_id, reason)
         VALUES (current_shop_id(), $1, 'redeem', $2, $3, 'Đổi điểm khi đặt đơn')`,
        [ctx.customerId, -pointsRedeemed, order.id]);
    }
    for (const ln of lines) {
      // unit_cost_vnd (0081): snapshot GIÁ VỐN qua subquery — cost không bao giờ vào object
      // JS của service công khai (không lọt log/response); chưa khai giá vốn → NULL (không 0).
      await c.query(
        `INSERT INTO order_lines (shop_id, order_id, variant_id, title_snapshot, sku_snapshot, unit_price_vnd, qty, unit_cost_vnd, orig_unit_price_vnd, promotion_id)
         VALUES (current_shop_id(), $1, $2, $3, $4, $5, $6,
                 (SELECT cost_vnd FROM variant_costs WHERE shop_id = current_shop_id() AND variant_id = $2), $7, $8)`,
        [order.id, ln.variant_id, ln.title, ln.sku, ln.unit, ln.qty, ln.orig, ln.promotion_id],
      );
    }
    // Guard status='active' + kiểm rowCount: lớp phòng thủ THỨ HAI sau FOR UPDATE. Nếu vì
    // lý do nào giỏ đã bị chuyển đổi (đua lọt qua) → 0 dòng → fail, ROLLBACK cả reserve +
    // idempotency (chưa commit) → KHÔNG đẻ đơn trùng.
    const conv = await c.query(`UPDATE carts SET status = 'converted', updated_at = now() WHERE id = $1 AND status = 'active'`, [cart.id]);
    if (conv.rowCount !== 1) fail(409, 'giỏ hàng vừa được đặt ở một yêu cầu khác');

    // Outbox: sự kiện email xác nhận đơn — GHI TRONG CÙNG transaction. Rollback →
    // không có dòng này → không email ma (ADR-006). Payload self-contained (worker
    // chỉ đọc outbox, không đụng orders/PII). Chỉ khi có email người mua.
    // Phát cho MỌI đơn (kể cả không email): email chỉ gửi khi có `to`, nhưng CHỦ SHOP luôn
    // nhận thông báo Telegram "đơn mới" (worker định tuyến theo shop_id). link tra cứu: token
    // THÔ trong email khách (họ cần) — chỉ thêm khi có email.
    {
      // Link tra cứu trong email PHẢI trỏ trang HTML (/checkout/success — có QR để trả tiền),
      // KHÔNG phải /checkout/order (API JSON — khách bấm vào chỉ thấy JSON thô).
      const link = (email && ctx.host) ? `https://${ctx.host}/checkout/success?number=${Number(num)}&token=${lookupToken}` : undefined;
      await c.query(
        `INSERT INTO outbox (shop_id, topic, payload) VALUES (current_shop_id(), 'order.created', $1)`,
        [{ ...(email ? { to: email } : {}), order_number: Number(num), total_vnd: total, customer_name: name, payment_method: paymentMethod, ...(link ? { link } : {}) }],
      );
    }

    const response = { order_number: Number(num), subtotal_vnd: subtotal, shipping_vnd: shipping, discount_vnd: discount, coupon_code: couponCode, points_redeemed: pointsRedeemed, points_discount_vnd: pointsDiscount, total_vnd: total, status: 'pending', payment_status: 'unpaid', payment_method: paymentMethod, lookup_token: lookupToken };
    if (paymentMethod === 'qr') { response.payment_ref = paymentRef; response.qr_string = qrString; }
    await c.query(`UPDATE idempotency_keys SET status = 'completed', response_code = 201, response_body = $2 WHERE key = $1`, [idemKey, response]);
    log('info', 'order_created', { orderNumber: Number(num), total });
    return { code: 201, body: response };
  }
}

// ── GPS reverse-geocode (0089): toạ độ → địa chỉ + phí. Guest same-origin, JS gọi. ──────────
const GEO_RL_PER_MIN = Number(process.env.GEOCODE_RL_PER_MIN ?? 12);
const GEO_SHOP_DAILY = Number(process.env.GEOCODE_SHOP_DAILY ?? 2000);
const GEO_PLATFORM_DAILY = Number(process.env.GEOCODE_PLATFORM_DAILY ?? 50000);
// NGÂN SÁCH gọi provider — FAIL-CLOSED (KHÁC checkout fail-open): Redis lỗi/thiếu/vượt trần →
// KHÔNG gọi Goong (soft-fallback nhập tay). Đốt quota API bản đồ = mất tiền/DoS; mất-tiện-ích an toàn hơn.
async function geoRateOk(ipHash, shopId) {
  if (!redis) return false;
  const day = new Date().toISOString().slice(0, 10);
  const rs = await Promise.all([
    hit(redis, `rl:geo:ip:${ipHash}`, { limit: GEO_RL_PER_MIN, windowSec: 60 }),
    hit(redis, `rl:geo:shop:${shopId}:${day}`, { limit: GEO_SHOP_DAILY, windowSec: 86400 }),
    hit(redis, `rl:geo:plat:${day}`, { limit: GEO_PLATFORM_DAILY, windowSec: 86400 }),
  ]).catch(() => null);
  return rs != null && rs.every((r) => r.allowed && !r.degraded); // degraded (Redis lỗi) → fail-closed
}
// Bật lớp JS GPS khi shop ship theo km + có key geocoder. Sinh nonce/response (no-store → không lo cache).
const gpsOpts = (summary) => {
  const gps = summary.distance_mode === true && GEOCODE_ON;
  return { gps, nonce: gps ? crypto.randomBytes(16).toString('base64') : '' };
};
async function geocode(req, res, body, ctx) {
  const soft = (reason) => send(res, 200, { available: false, reason }); // KHÔNG BAO GIỜ 500 → checkout không chết
  if (!GEOCODE_ON) return soft('off');
  const lat = Number(body?.lat), lng = Number(body?.lng);
  if (!(Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) return send(res, 400, { error: 'toạ độ không hợp lệ' });
  if (!inVietnam(lat, lng)) return soft('outside_vn');
  const ipHash = ctx.ip ? hashIp(ctx.ip) : 'noip';
  if (!(await geoRateOk(ipHash, ctx.shopId))) return soft('busy'); // đốt quota / spam → nhập tay
  let addr;
  try { addr = await reverseGeocode({ lat, lng }); } catch { return soft('geocode_failed'); }
  const province = normalizeProvince(addr.province); // null → ép khách chọn tỉnh tay (không ghi tỉnh lạ)
  const out = await withTenant(ctx.shopId, async (c) => {
    const cfg = await shopShipping(c);
    if (cfg.mode !== 'distance') return { reason: 'not_distance' };
    const token = parseCookies(req)[CART_COOKIE];
    const cart = await findCart(c, token);
    if (!cart) return { reason: 'no_cart' };
    return { s: await summarize(c, cart.id, province, { lat, lng }), dist: resolveShipDistance(cfg, { lat, lng }).distanceMeters };
  });
  if (out.reason) return soft(out.reason);
  const s = out.s;
  return send(res, 200, {
    available: true,
    address: { line: addr.line, province: province ?? '', district: addr.district, ward: addr.ward },
    need_province: province == null,           // JS: ép chọn tỉnh tay
    distance_km: out.dist != null ? Math.ceil(out.dist / 1000) : null,
    shipping_vnd: s.shipping_vnd, total_vnd: s.total_vnd, out_of_range: s.ship_out_of_range === true,
    ship_seen: s.shipping_vnd,                 // JS đặt hidden ship_seen → honesty-loop khớp
  });
}

// API JSON (e2e + tích hợp): Idempotency-Key ở HEADER. Lỗi nghiệp vụ do dispatcher bắt.
async function checkout(req, res, body, ctx) {
  const idemKey = req.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey.length < 8 || idemKey.length > 200) return send(res, 400, { error: 'thiếu/không hợp lệ Idempotency-Key' });
  const f = parseOrderInput({ name: body.customer?.name, phone: body.customer?.phone, email: body.customer?.email, address: body.address, payment_method: body.payment_method, points_redeem: body.points_redeem });
  if (f.error) return send(res, 400, { error: f.error });
  const token = parseCookies(req)[CART_COOKIE];
  const cust = await resolveCustomer(ctx.shopId, req);
  const out = await withTenant(ctx.shopId, (c) => createOrderTx(c, { ...ctx, customerId: cust?.id ?? null }, token, idemKey, f));
  return send(res, out.code, out.body, out.replay ? { 'idempotency-replayed': 'true' } : {});
}

// Form trình duyệt (không JS): idem-key ở FORM (sinh lúc render /checkout). PRG → /success.
async function checkoutPlace(req, res, form, ctx) {
  const shopName = await getShopName(ctx.shopId);
  const idemKey = String(form.idempotency_key ?? '');
  if (idemKey.length < 8 || idemKey.length > 200) return sendHtml(res, 400, renderError(shopName, 'Phiên thanh toán không hợp lệ, vui lòng tải lại trang.'));

  // Khách đăng nhập (+ địa chỉ đã lưu) — nạp SỚM để "chọn nhanh địa chỉ" + giữ lựa chọn khi
  // dựng lại form. addresses chỉ chứa địa chỉ CỦA phiên này → address_choice lạ không khớp (IDOR).
  const cust = await resolveCustomer(ctx.shopId, req, { withAddresses: true });

  // Dựng lại trang thanh toán (giữ dữ liệu đã nhập) — dùng khi cần thử lại / hỏi xác minh.
  // Sinh idem MỚI ở đây và ràng buộc challenge vào chính idem đó (chống replay).
  const reRender = async ({ needChallenge, ...opts }) => {
    const token = parseCookies(req)[CART_COOKIE];
    const { summary, qrEnabled } = await withTenant(ctx.shopId, async (c) => {
      const cart = await findCart(c, token);
      if (!cart) return { summary: { items: [] }, qrEnabled: false };
      // Tỉnh đã chọn hợp lệ → tổng dựng lại TÍNH THEO TỈNH (ship_seen mới = phí đúng → vòng
      // xác nhận phí hội tụ sau đúng một cú bấm). Toạ độ (nếu có) → ship theo km khớp lúc chốt.
      return { summary: await summarize(c, cart.id, isProvince(String(form.province ?? '')) ? String(form.province) : null, parseCoords(form.lat, form.lng)), qrEnabled: await shopQrEnabled(c) };
    });
    if (!summary.items.length) return redirect(res, '/cart');
    const idem = genToken();
    const prefill = { name: form.name, phone: form.phone, email: form.email, address_line: form.address_line, province: form.province, payment_method: form.payment_method, address_choice: form.address_choice, logged_in: !!cust, lat: form.lat, lng: form.lng };
    const g = gpsOpts(summary);
    return sendHtml(res, opts.status ?? 200, renderCheckout(shopName, summary, idem, { formTs: issueFormTs(), prefill, addresses: cust?.addresses ?? [], gps: g.gps, nonce: g.nonce, qrEnabled, challenge: needChallenge ? issueChallenge(idem) : undefined, ...opts }), {}, g.nonce);
  };

  // ── Lớp BOT no-JS ────────────────────────────────────────────────────────────
  // (a) Honeypot: trường ẩn 'company' — người thật không thấy nên bỏ trống; bot điền → chặn.
  if (String(form.company ?? '').trim() !== '') return sendHtml(res, 400, renderError(shopName, 'Không đặt được đơn.'));
  // (b) Time-trap: token thời gian ký. Giả/hết hạn/điền quá nhanh (bot) → dựng lại form.
  const ts = verifyFormTs(form.ct);
  if (!ts.valid || ts.age > FORM_MAX_AGE_MS) return reRender({ error: 'Phiên thanh toán đã hết hạn. Vui lòng kiểm tra thông tin và bấm Đặt hàng lại.' });
  if (ts.age < MIN_FILL_MS) return reRender({ error: 'Bạn thao tác hơi nhanh — vui lòng bấm Đặt hàng lại để xác nhận.' });

  // CHỌN NHANH địa chỉ đã lưu (khách đăng nhập): address_choice = <uuid> → dùng địa chỉ đó
  // (khớp trong cust.addresses = đã lọc theo customer_id phiên → id lạ không có = IDOR-safe).
  // Không chọn / 'new' / guest → dùng ô nhập tay. Địa chỉ lạ/đã xoá → dựng lại form nhắc chọn lại.
  let inName = form.name, inPhone = form.phone, inLine = form.address_line, inProvince = form.province;
  // Toạ độ GPS (0089): CHỈ cho địa chỉ NHẬP TAY/mới (JS GPS đặt hidden lat/lng). Địa chỉ đã lưu
  // chưa có toạ độ → bỏ coords → ship theo tỉnh (sàn phí vẫn bảo vệ). Xoá coords khi chọn saved.
  let inCoords = parseCoords(form.lat, form.lng);
  const addrChoice = String(form.address_choice ?? '');
  if (cust && UUID_RE.test(addrChoice)) {
    const saved = (cust.addresses ?? []).find((a) => a.id === addrChoice);
    if (!saved) return reRender({ error: 'Địa chỉ đã lưu không còn khả dụng — vui lòng chọn lại hoặc nhập địa chỉ mới.' });
    inName = saved.recipient_name; inPhone = saved.phone; inLine = savedAddrLine(saved); inProvince = saved.province; inCoords = null;
    // Đồng bộ vào form → reRender (honesty-loop ship) tính phí theo ĐÚNG tỉnh của địa chỉ đã lưu.
    form.name = inName; form.phone = inPhone; form.address_line = inLine; form.province = inProvince; form.lat = ''; form.lng = '';
  }
  const f = parseOrderInput({ name: inName, phone: inPhone, email: form.email, address: inLine ? { line: String(inLine).slice(0, 300), province: inProvince ? String(inProvince).slice(0, 60) : undefined, ...(inCoords ? { lat: inCoords.lat, lng: inCoords.lng } : {}) } : null, payment_method: form.payment_method });
  if (f.error) return reRender({ error: f.error });
  // Form NGƯỜI MUA bắt buộc chọn tỉnh (API JSON /checkout vẫn tuỳ chọn — tương thích ngược,
  // nhưng không rõ tỉnh thì bị tính phí liên miền ở createOrderTx).
  if (!f.address?.province) return reRender({ error: 'Vui lòng chọn Tỉnh/Thành phố nhận hàng.' });
  // Phí ship khách ĐÃ THẤY trên form (hidden ship_seen). Thiếu/rác → null = bỏ so khớp
  // (form của ta luôn gửi); chỉ dùng để SO SÁNH trong createOrderTx, không vào total.
  f.expectedShipping = /^\d{1,9}$/.test(String(form.ship_seen ?? '')) ? Number(form.ship_seen) : null;
  // Subtotal (đã sale, trước coupon) khách ĐÃ THẤY (hidden subtotal_seen) — vòng trung thực
  // GIÁ: promo bật/tắt giữa lúc khách điền form → createOrderTx 409 → dựng lại form giá mới.
  f.expectedSubtotal = /^\d{1,12}$/.test(String(form.subtotal_seen ?? '')) ? Number(form.subtotal_seen) : null;

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
    const out = await withTenant(ctx.shopId, (c) => createOrderTx(c, { ...ctx, customerId: cust?.id ?? null }, token, idemKey, f));
    return redirect(res, `/checkout/success?number=${out.body.order_number}&token=${encodeURIComponent(out.body.lookup_token)}&placed=1`);
  } catch (err) {
    // NGOÀI VÙNG GIAO (ship theo km, km>max) → dựng lại form báo rõ, KHÔNG phải lỗi phí (409).
    if (err.statusCode === 422 && err.body?.out_of_range) {
      return reRender({ error: 'Địa chỉ ngoài vùng giao của cửa hàng — vui lòng chọn địa chỉ gần hơn hoặc liên hệ cửa hàng.' });
    }
    // Phí ship đã cập nhật (ship_seen lệch) → dựng lại form: summarize theo tỉnh đã chọn
    // phát ship_seen ĐÚNG + idem/formTs mới → khách kiểm tra rồi bấm Đặt hàng lại là xong.
    if (err.statusCode === 409 && err.body?.shipping_vnd != null) {
      return reRender({ error: `Phí giao hàng tới ${f.address.province} là ${new Intl.NumberFormat('vi-VN').format(err.body.shipping_vnd)}₫ — tổng đơn đã được cập nhật, vui lòng kiểm tra và bấm Đặt hàng lại.` });
    }
    // GIÁ sản phẩm vừa đổi (flash sale bật/tắt) → dựng lại form: summarize phát subtotal_seen
    // MỚI (giá hiện hành) → khách thấy giá đúng, bấm Đặt hàng lại là xong.
    if (err.statusCode === 409 && err.body?.subtotal_vnd != null) {
      return reRender({ error: 'Giá sản phẩm vừa được cập nhật (khuyến mãi thay đổi) — vui lòng kiểm tra và bấm Đặt hàng lại.' });
    }
    // QR không khả dụng (shop tắt QR giữa chừng) → dựng lại form GIỮ dữ liệu (reRender ẩn radio QR
    // → còn COD) thay vì trang lỗi cụt mất data. Chống ngõ-cụt trên đường tới hạn.
    if (err.statusCode === 400 && err.body?.qr_unavailable) {
      return reRender({ error: 'Cửa hàng hiện chỉ nhận thanh toán khi nhận hàng (COD) — đã chuyển về COD, vui lòng bấm Đặt hàng lại.' });
    }
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
    const lines = (await c.query(`SELECT title_snapshot, sku_snapshot, unit_price_vnd, orig_unit_price_vnd, qty FROM order_lines WHERE order_id = $1`, [o.id])).rows;
    return { order_number: o.order_number, status: o.status, payment_status: o.payment_status, payment_method: o.payment_method, subtotal_vnd: Number(o.subtotal_vnd), shipping_vnd: Number(o.shipping_vnd), total_vnd: Number(o.total_vnd), customer_name: o.customer_name, lines };
  });
  if (!data) return send(res, 404, { error: 'không tìm thấy đơn' });
  return send(res, 200, data);
}

// ── trang HTML (không JS) ────────────────────────────────────────────────────
async function getCheckoutPage(req, res, _body, ctx) {
  const token = parseCookies(req)[CART_COOKIE];
  const { summary, qrEnabled } = await withTenant(ctx.shopId, async (c) => {
    const cart = await findCart(c, token);
    if (!cart) return { summary: { items: [], subtotal_vnd: 0, shipping_vnd: 0, total_vnd: 0 }, qrEnabled: false };
    return { summary: await summarize(c, cart.id), qrEnabled: await shopQrEnabled(c) };
  });
  if (!summary.items.length) return redirect(res, '/cart');       // giỏ trống → về giỏ
  // Khách đăng nhập → điền nhanh tên/SĐT/email + CHỌN NHANH địa chỉ đã lưu (no-JS radio).
  const cust = await resolveCustomer(ctx.shopId, req, { withAddresses: true });
  const prefill = cust ? {
    name: cust.full_name ?? '', phone: cust.phone ?? '', email: cust.email ?? '',
    address_line: cust.addr?.line1 ?? '', province: cust.addr?.province ?? '',
    logged_in: true,
  } : undefined;
  const g = gpsOpts(summary);
  return sendHtml(res, 200, renderCheckout(await getShopName(ctx.shopId), summary, genToken(),
    { formTs: issueFormTs(), prefill, addresses: cust?.addresses ?? [], gps: g.gps, nonce: g.nonce, qrEnabled }), {}, g.nonce);
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
      `SELECT id, order_number, status, payment_status, payment_method, shipping_vnd, total_vnd, customer_name, payment_ref, qr_account
         FROM orders WHERE order_number = $1 AND lookup_token_hash = $2`, [number, hashToken(token)],
    )).rows[0];
    if (!o) return null;
    o.lines = (await c.query(`SELECT title_snapshot, sku_snapshot, unit_price_vnd, orig_unit_price_vnd, qty FROM order_lines WHERE order_id = $1`, [o.id])).rows;
    let pay = null;
    if (o.payment_method === 'qr' && o.payment_status !== 'paid') {
      pay = (await c.query(`SELECT bank_bin, account_number, account_name FROM shop_payment_config WHERE shop_id = current_shop_id()`)).rows[0] ?? null;
      // Webhook đối soát khớp SNAPSHOT qr_account lúc TẠO ĐƠN (payment/server.js).
      // Shop đã ĐỔI tài khoản → vẽ QR theo config MỚI là dụ khách trả vào TK mà webhook
      // KHÔNG khớp (tiền treo unmatched vĩnh viễn). Trường hợp đó: KHÔNG vẽ QR, báo
      // khách liên hệ shop (shop huỷ tạo lại đơn hoặc xác nhận tay).
      if (pay && o.qr_account && pay.account_number !== o.qr_account) {
        pay = null;
        o.pay_config_changed = true;
      }
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
  { m: 'POST', p: '/cart/points', fn: applyPointsForm, form: true },
  { m: 'POST', p: '/checkout', fn: checkout },
  { m: 'POST', p: '/checkout/geocode', fn: geocode },
  { m: 'POST', p: '/checkout/place', fn: checkoutPlace, form: true },
  { m: 'GET', p: '/checkout', fn: getCheckoutPage },
  { m: 'GET', p: '/checkout/lookup', fn: getLookupPage },
  { m: 'GET', p: '/checkout/success', fn: getSuccessPage },
  { m: 'GET', p: '/checkout/order', fn: orderLookup },
  { m: 'POST', p: '/checkout/review', fn: submitReviewForm, form: true },
];

// Phông Be Vietnam Pro (OFL) tự-host — /fonts/*.woff2 same-origin (CSP font-src 'self').
const FONTS = (() => {
  const dir = new URL('./fonts/', import.meta.url);
  const m = new Map();
  try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.woff2')) m.set(f, fs.readFileSync(new URL(f, dir))); } catch {}
  return m;
})();

const server = http.createServer((req, res) => runReq(req, res, async () => {
  const url = new URL(req.url, 'http://internal');
  if (await health(url.pathname, res, { db: () => db.query('SELECT 1') })) return;
  if (url.pathname.startsWith('/fonts/')) {
    const buf = FONTS.get(url.pathname.slice(7));
    if (buf) { res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable' }); return res.end(buf); }
    res.writeHead(404); return res.end();
  }
  // /favicon.ico: trả 204 sớm (trước resolve shop) — khỏi tốn roundtrip DB cho icon.
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204, { 'cache-control': 'public, max-age=86400' }); return res.end();
  }

  const route = ROUTES.find((r) => r.m === req.method && r.p === url.pathname);
  if (!route) return send(res, 404, { error: 'không tìm thấy' });
  if (!sameOrigin(req)) return send(res, 403, { error: 'origin không hợp lệ' });

  // ── Cổng rate-limit per-IP (Đợt 6.2) ──────────────────────────────────────────
  // Lớp NGOÀI theo IP, CHỈ bao thao tác GHI (POST/PATCH giỏ + checkout); GET đọc miễn
  // trừ. KHÔNG đụng advisory-lock / trần-pending bên trong — đó là lớp trong theo SĐT/
  // nguồn. FAIL-OPEN: Redis lỗi (rl.degraded) → cho qua. Form không-JS → HTML thân thiện;
  // đường JSON → 429 JSON. Cả hai kèm Retry-After để client lùi lịch.
  if (redis && req.method !== 'GET') {
    const rl = await hit(redis, `rl:co:ip:${clientIp(req)}`, { limit: CO_RL, windowSec: 60 });
    if (!rl.allowed && !rl.degraded) {
      const retry = String(rl.retryAfterSec || 60);
      if (route.form) { res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'retry-after': retry, 'cache-control': 'no-store' }); return res.end(RL_HTML); }
      return send(res, 429, { error: 'Bạn thao tác quá nhanh, thử lại sau chút' }, { 'retry-after': retry });
    }
  }

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
