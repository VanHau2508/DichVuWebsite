/**
 * Storefront — trang bán hàng CÔNG KHAI (không auth, chỉ đọc).
 *
 * Luồng: Host → resolve shop (domains, CHỈ verified) → set tenant context →
 * đọc shop/theme/sản phẩm (app_store, RLS chỉ thấy active/ready) → render SSR.
 *
 * Bốn lớp phòng thủ (mỗi cái có test + mutation):
 *   1. Chỉ domain ĐÃ verified mới route (chưa verify → 404). Chống chiếm domain.
 *   2. Tenant context → RLS cô lập; storefront shop A không bao giờ thấy shop B.
 *   3. app_store CHỈ đọc sản phẩm active + media ready (RLS ở migration 0011) —
 *      draft/archived/pending vô hình về mặt cấu trúc.
 *   4. escape HTML + sanitize token → chống XSS / CSS injection từ dữ liệu shop.
 */

import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';
import { renderHome, renderProducts, renderProduct, renderPage, renderSearch, renderBlogList, renderBlogPost, renderMaintenance, renderPreparing, renderNotFound } from './theme.js';
import { renderLanding } from './landing.js';
import { renderAbout, renderSupport, renderTerms, renderPrivacy, renderContact, renderBlogList as renderCoBlogList, renderBlogPost as renderCoBlogPost, findPost, companyPaths } from './company.js';
import { runReq, makeLog, health, setUsageSink, makeUsageSink, noteShop, skipUsage, noteService } from './obs.js';
import { AVAIL_SQL } from '../safety-stock.js';
// Bộ đếm rate-limit DÙNG CHUNG với auth (atomic Lua, FAIL-OPEN khi Redis lỗi). File
// gắn vào /app/ratelimit.js qua bind-mount trong compose.dev.yml (không copy, không sửa).
import { hit } from '../ratelimit.js';

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const SHOP_PREVIEW_COOKIE = '__Host-shop-preview';
const SHOP_PREVIEW_RE = /^[A-Za-z0-9_-]{40,64}$/;

function cookieValue(req, name) {
  const raw = String(req.headers.cookie ?? '');
  for (const part of raw.split(';')) {
    const at = part.indexOf('=');
    if (at < 0 || part.slice(0, at).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(at + 1).trim()); } catch { return null; }
  }
  return null;
}

const SHOP_PREVIEW_BANNER = '<div class="preview-banner" role="status">⚠ XEM TRƯỚC CỬA HÀNG — khách công khai chưa thể thấy nội dung này hoặc đặt hàng.</div>';
const markShopPreview = (html) => String(html).replace(/<body([^>]*)>/, (open) => `${open}${SHOP_PREVIEW_BANNER}`);

const PORT = Number(process.env.PORT ?? 3050);
// Base URL ảnh public. Mặc định TƯƠNG ĐỐI (/media-public) → cùng origin với trang shop
// (Caddy proxy path này về MinIO) → CSP 'self' cho phép, trình duyệt tới được. Prod có
// thể đặt tuyệt đối (vd https://cdn.nentang.vn/media-public) qua env → MEDIA_ORIGIN vào CSP.
const MEDIA_PUBLIC_BASE = process.env.MEDIA_PUBLIC_BASE ?? '/media-public';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

// CSP cho storefront công khai (lớp phòng thủ XSS thứ hai sau escape HTML).
// - script-src KHÔNG có (default-src 'none') → chặn mọi JS. Storefront không dùng JS.
// - style-src 'unsafe-inline': theme đổ token vào <style> nội tuyến (đã sanitize).
// - img-src: self + gốc media (ảnh sản phẩm từ bucket public/CDN) + data:.
// - frame-ancestors 'none': chống clickjacking. base-uri/form-action khoá về self.
const MEDIA_ORIGIN = (() => { try { return new URL(MEDIA_PUBLIC_BASE).origin; } catch { return ''; } })();
const CSP = [
  "default-src 'none'",
  `img-src 'self' data: ${MEDIA_ORIGIN}`.trim(),
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
// Trang mang lớp JS badge giỏ (header): thêm script-src 'nonce-X' (CHỈ script nội tuyến ĐÚNG
// nonce — KHÔNG 'unsafe-inline', KHÔNG script ngoài) + connect-src 'self' (để fetch('/cart/summary')
// không bị default-src 'none' chặn). MIRROR apps/checkout http.js (GPS). Mọi thứ khác vẫn default-src
// 'none'. nonce vắng → CSP khoá cứng như cũ (trang 404/bảo trì không có script). script-src ĐÈ
// default-src cho <script> → chỉ script ký đúng nonce chạy; XSS chèn <script> không đoán được nonce.
const cspWithNonce = (nonce) => (nonce ? `${CSP}; script-src 'nonce-${nonce}'; connect-src 'self'` : CSP);

const log = makeLog('storefront');

// ── Rate-limit hạ tầng (Đợt 6.2) ───────────────────────────────────────────────
// Image storefront là bản TỐI GIẢN (chỉ src + pg), KHÔNG có ioredis. Rate-limit chỉ
// cần EVAL (cho ratelimit.js) + DEL, nên tự nói RESP qua net (built-in) — không thêm
// dependency, không rebuild image (khớp luồng dev: chỉ bind-mount + restart). Ngữ
// nghĩa GIỐNG cấu hình Redis của auth: Redis chưa sẵn sàng / lệnh quá hạn → REJECT
// NGAY (không treo request); nuốt lỗi socket (không làm sập tiến trình). hit() bắt mọi
// lỗi → FAIL-OPEN, nên bug ở client cùng lắm là mất rate-limit chứ không sập storefront.
function respParse(b, i) {
  if (i >= b.length) return { ok: false };
  const type = b[i];
  const nl = b.indexOf('\r\n', i + 1);
  if (nl < 0) return { ok: false };
  const line = b.toString('latin1', i + 1, nl);
  const after = nl + 2;
  if (type === 0x2b) return { ok: true, value: line, next: after };                 // + chuỗi đơn
  if (type === 0x2d) return { ok: true, value: new Error(line), next: after, err: true }; // - lỗi
  if (type === 0x3a) return { ok: true, value: Number(line), next: after };         // : số nguyên
  if (type === 0x24) {                                                              // $ bulk
    const len = Number(line);
    if (len < 0) return { ok: true, value: null, next: after };
    const end = after + len;
    if (end + 2 > b.length) return { ok: false };
    return { ok: true, value: b.toString('utf8', after, end), next: end + 2 };
  }
  if (type === 0x2a) {                                                              // * mảng (reply EVAL)
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
  const pending = []; // hàng đợi resolver theo ĐÚNG thứ tự Redis trả lời (1 kết nối = FIFO)
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
      sock.on('error', () => {});                       // đã xử lý ở 'close' → nuốt để không throw
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
  function send(args) {
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
    eval: (script, numkeys, ...rest) => send(['EVAL', script, numkeys, ...rest]),
    del: (key) => send(['DEL', key]),
  };
}

// ── Đếm LƯỢT XEM sản phẩm (0098) ─────────────────────────────────────────────
// KHÔNG ghi thẳng DB: vai app_store của storefront là vai CÔNG KHAI, CHỈ ĐỌC — đó là bất
// biến an ninh, không đánh đổi lấy một con số trưng bày. Đếm vào Redis, worker gộp vào
// product_view_daily theo chu kỳ. Lợi kép: đường nóng công khai không có ghi DB nào.
//
// Một lệnh EVAL duy nhất (HINCRBY + EXPIRE nguyên tử, 1 vòng mạng). KHÔNG await ở chỗ gọi →
// Redis chậm/chết cũng không làm chậm trang; mất số đếm thì thôi (fail-open, giống rate-limit).
const PV_LUA = "redis.call('HINCRBY', KEYS[1], ARGV[1], 1) redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2])) return 1";
const PV_TTL = 3 * 86400;  // lưới an toàn: worker chết vài ngày thì khoá tự tan, không rác Redis
// Loại bot: đếm cả bot thì con số vô nghĩa với người bán (SP không ai xem vẫn "1.000 lượt").
const BOT_UA_RE = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|headless|phantom|curl|wget|python-requests|scrapy|go-http|java\/|okhttp/i;
function countProductView(shopId, productId, req) {
  if (!redis) return;
  const ua = String(req?.headers?.['user-agent'] ?? '');
  if (!ua || BOT_UA_RE.test(ua)) return;          // không UA cũng coi là máy, không đếm
  // Ngày theo GIỜ VN (+07) — khớp mốc ngày của báo cáo/dashboard, không lệch 1 ngày.
  const day = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  redis.eval(PV_LUA, 1, `pv:${day}:${shopId}`, String(productId), String(PV_TTL)).catch(() => {});
}
// REDIS_URL vắng → không dựng client → gate tự bỏ qua (fail-open). Không bao giờ chặn khởi động.
const redis = process.env.REDIS_URL ? makeRedis(process.env.REDIS_URL, { commandTimeout: 1000 }) : null;
// ĐO LUỒNG DÙNG (0141): đếm (service, mẫu-route, shop, ngày) vào Redis; worker gộp vào
// feature_usage. Không REDIS_URL → makeUsageSink trả null → runReq chạy y như trước.
setUsageSink(makeUsageSink('storefront', redis));
// Đọc chung 240/60s (~4 req/s bền — rộng cho người duyệt web, trang catalog rẻ). TÌM KIẾM
// 30/60s (LIKE full-scan là bộ khuếch đại đắt). Cửa sổ cố định 60s, chỉnh được qua env.
const SF_READ_RL = Number(process.env.SF_READ_RL_PER_MIN) || 240;
const SF_SEARCH_RL = Number(process.env.SF_SEARCH_RL_PER_MIN) || 30;
const RL_HTML = '<!doctype html><meta charset="utf-8"><title>Quá nhiều yêu cầu</title><body style="font-family:system-ui,sans-serif;text-align:center;padding:48px 16px"><h1>429 — Quá nhiều yêu cầu</h1><p>Bạn đang thao tác quá nhanh. Vui lòng thử lại sau giây lát.</p></body>';

// IP client SAU Caddy: Caddy (proxy tin cậy DUY NHẤT) ghi IP thật vào phần tử PHẢI NHẤT
// của X-Forwarded-For. Lấy trái nhất là giả mạo được. Khớp apps/auth + checkout http.js.
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) { const parts = xff.split(','); return parts[parts.length - 1].trim(); }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Resolve hostname → {shopId, isPrimary, primaryHost}. CHỈ domain đã verified. Kèm tên
 *  miền CHÍNH của shop để 301 host phụ về chính (A5 — tránh trùng nội dung SEO). */
async function resolveShop(hostname) {
  const { rows } = await db.query(
    `SELECT d.shop_id, d.is_primary,
            (SELECT hostname FROM domains WHERE shop_id = d.shop_id AND is_primary AND verified_at IS NOT NULL LIMIT 1) AS primary_host
       FROM domains d WHERE d.hostname = $1 AND d.verified_at IS NOT NULL`,
    [hostname],
  );
  const r = rows[0];
  return r ? { shopId: r.shop_id, isPrimary: r.is_primary, primaryHost: r.primary_host } : null;
}

/** Số ngày ghi nhớ mã CTV của shop (1–90, mặc định 30). Chạy NGOÀI ngữ cảnh tenant nên
 *  policy là cross-shop; giới hạn thật là quyền CỘT (0137 chỉ cấp shop_id + cookie_days).
 *  Không có cấu hình / DB hỏng → 30, không bao giờ ném ra ngoài: đây là đường ĐIỀU HƯỚNG,
 *  hỏng cấu hình mà chặn khách vào trang thì đắt hơn nhiều so với cookie sai hạn. */
async function docCookieDays(shopId) {
  const { rows } = await db
    .query('SELECT cookie_days FROM shop_affiliate_config WHERE shop_id = $1', [shopId])
    .catch(() => ({ rows: [] }));
  // Kẹp lại lần nữa dù DB đã CHECK 1..90: cột có thể được nới sau, còn Max-Age thì không
  // được phép thành NaN/âm — cookie hỏng cú pháp là trình duyệt bỏ luôn, mất quy gán.
  return Math.min(90, Math.max(1, Number(rows[0]?.cookie_days) || 30));
}

/** Mở transaction có tenant context = shopId, chạy fn (app_store, RLS cô lập). */
async function withStore(shopId, fn) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

const imgUrl = (key) => (key ? `${MEDIA_PUBLIC_BASE}/${key}` : null);

// Dựng cây danh mục 2 cấp (0095) từ danh sách phẳng. Trả MẢNG cấp-1, mỗi phần tử kèm
// .children[] (con sắp theo thứ tự đầu vào). Con có parent_id TREO (cha đã ẩn/không thấy)
// → coi như cấp-1 để không mất danh mục. Cây tối đa 2 tầng (ép ở seller), nên không đệ quy.
function buildCatTree(rows, toImg) {
  const norm = (r) => ({ id: r.id, slug: r.slug, name: r.name, image: toImg(r.image_key), children: [] });
  const byId = new Map(rows.map((r) => [r.id, norm(r)]));
  const roots = [];
  for (const r of rows) {
    const node = byId.get(r.id);
    const parent = r.parent_id ? byId.get(r.parent_id) : null;
    if (parent && parent.id !== node.id) parent.children.push(node);
    else roots.push(node); // cấp-1 hoặc con mồ côi (cha đã ẩn)
  }
  return roots;
}

// TRẦN DANH MỤC — MỘT con số cho khái niệm "danh mục của shop".
//
// Trước đây cây menu lấy LIMIT 100 còn sitemap lấy LIMIT 200, và seller KHÔNG có trần nào khi
// tạo. Nên với shop >100 danh mục: mục thứ 101 biến mất khỏi menu, bấm vào link của nó thì
// resolveCatSlug không thấy → 404 — TRONG KHI sitemap vẫn mời Google vào đúng URL đó. Rất dễ
// chạm: bộ nhập CSV từ sàn khác tự đẻ danh mục theo mỗi đường dẫn, và tạp hoá/siêu thị dùng
// cây 2 cấp.
const CAT_MAX = 200;

// Duyệt cây tìm danh mục theo slug + trả tập id để lọc sản phẩm:
//   - slug là CHA → ids = [cha, ...tất cả con]  (lọc gộp)
//   - slug là CON hoặc lá → ids = [chính nó]     (lọc hẹp)
// Trả null nếu không thấy. parent = node cha khi slug là con (để sidebar mở đúng nhánh).
function resolveCatSlug(tree, slug) {
  for (const root of tree) {
    if (root.slug === slug) return { cat: root, parent: null, ids: [root.id, ...root.children.map((ch) => ch.id)] };
    for (const ch of root.children) {
      if (ch.slug === slug) return { cat: ch, parent: root, ids: [ch.id] };
    }
  }
  return null;
}

/**
 * Tra danh mục THẲNG DB khi slug không có trong cây đã nạp (vượt CAT_MAX).
 *
 * Vì sao cần dù đã đồng bộ hai con số: trần nào cũng có mép, và mép của nó là một trang 404
 * cho danh mục CÓ THẬT — người bán tự tay tạo, thấy trong seller-admin, mà khách bấm vào thì
 * "không tìm thấy". Nâng trần chỉ dời mép đi chứ không bỏ mép.
 *
 * Menu vẫn chỉ hiện CAT_MAX mục (dropdown 200 dòng đã là vô dụng rồi) — nhưng ĐIỀU HƯỚNG thì
 * không được có mép. RLS store_categories (0011) đã lọc shop + deleted_at nên không cần lặp lại.
 */
async function resolveCatSlugDb(c, slug) {
  const row = (await c.query(`SELECT id, name, parent_id FROM categories WHERE slug = $1 LIMIT 1`, [slug])).rows[0];
  if (!row) return null;
  // Cha → gộp cả con (đúng luật của resolveCatSlug); con/lá → chỉ chính nó.
  const ids = row.parent_id ? [row.id]
    : [row.id, ...(await c.query(`SELECT id FROM categories WHERE parent_id = $1`, [row.id])).rows.map((r) => r.id)];
  return { cat: { id: row.id, name: row.name, slug }, parent: null, ids };
}

function normalizeHost(raw) {
  if (typeof raw !== 'string') return null;
  return raw.split(':')[0].trim().toLowerCase(); // bỏ port
}

const CACHE_PUBLIC = 'public, s-maxage=60, stale-while-revalidate=300';
const PAGE_SIZE = 24; // sản phẩm mỗi trang (lưới /products / danh mục / tìm kiếm)
const HOME_FEATURED = 10; // trang chủ nạp 10 SP nổi bật (đủ cho 5 cột × 2 hàng kiểu M.O.I); preset ít cột hơn tự đặt props.limit bội-số-cột để không lẻ hàng — xem đủ ở /products

// Sắp xếp lưới (?sort=): WHITELIST → ORDER BY tĩnh (không nội suy input). Giá sort trên
// p.price_vnd — đúng cột giá thẻ sản phẩm đang hiển thị. Giá trị lạ rơi về 'new'.
const GRID_SORTS = {
  new: 'p.created_at DESC',
  // "Bán chạy" (0096) — sort mặc-định-thực-tế của mọi sàn TMĐT. Đọc cột cache sold_count
  // (index products_sold_idx), KHÔNG aggregate live. Tie-break created_at cho ổn định phân trang.
  best: 'p.sold_count DESC, p.created_at DESC',
  price_asc: 'p.price_vnd ASC, p.created_at DESC',
  price_desc: 'p.price_vnd DESC, p.created_at DESC',
};

// Predicate "biến thể KHÔNG MỒ CÔI": biến thể phải có ánh xạ variant_option_values cho
// MỌI trục (product_options) hiện tại của sản phẩm. Khi shop thu hẹp phân loại, biến thể
// của tổ hợp cũ mất hết ánh xạ (cascade) nhưng vẫn active + còn giá/tồn cũ → phải ẨN
// (không cho chọn, không đếm tồn). SP phẳng (0 option) thoả rỗng → giữ nguyên như cũ.
// Yêu cầu alias `v` cho variants ở query bao ngoài; app_store đã có quyền đọc từ 0041.
const VARIANT_NOT_ORPHAN_SQL = `NOT EXISTS (
  SELECT 1 FROM product_options po WHERE po.product_id = v.product_id
    AND NOT EXISTS (SELECT 1 FROM variant_option_values vov
                     WHERE vov.variant_id = v.id AND vov.option_id = po.id))`;
// Host GỐC nền tảng → trang CÔNG TY (marketing/bảng giá), KHÔNG phải shop nào.
const ROOT_HOSTS = new Set((process.env.PLATFORM_ROOT_HOSTS ?? 'nentang.vn,www.nentang.vn')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const LANDING_CFG = {
  contactEmail: process.env.PLATFORM_CONTACT_EMAIL ?? 'lienhe@nentang.vn',
  contactPhone: process.env.PLATFORM_CONTACT_PHONE ?? '',
  brand: process.env.PLATFORM_BRAND ?? 'Nền Tảng',
};

function sendHtml(res, status, html, { shopSlug, cache, preview, nonce, noindex } = {}) {
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'x-content-type-options': 'nosniff',
    // nonce đi kèm trong CẢ header CSP lẫn thân HTML (thuộc tính <script nonce>). Trang cache
    // được (home/product/...) → CDN lưu header+body CÙNG một response nên nonce luôn khớp; script
    // là TĨNH (không nội suy dữ liệu) nên nonce dùng lại trong cửa sổ cache 60s vẫn an toàn.
    'content-security-policy': cspWithNonce(nonce),
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
  };
  // Preview BẢN NHÁP mang token trong URL và lộ nội dung chưa xuất bản → TUYỆT ĐỐI
  // không để CDN/công cụ tìm kiếm giữ lại: no-store + noindex. Phải kiểm trước `cache`.
  if (preview) {
    headers['cache-control'] = 'no-store';
    headers['x-robots-tag'] = 'noindex, nofollow';
  } else if (noindex) {
    // Shop CHƯA CÓ SẢN PHẨM NÀO. Vẫn phục vụ bình thường cho người có link (quyết định sản
    // phẩm: shop onboarding bán được ngay), nhưng KHÔNG mời công cụ tìm kiếm lập chỉ mục một
    // cửa hàng rỗng: ấn tượng đầu tiên trên Google của người bán sẽ là "chưa có sản phẩm nào",
    // và Google giữ ảnh chụp đó khá lâu sau khi họ đã đăng hàng.
    //
    // Dùng HEADER chứ KHÔNG chặn ở robots.txt: robots.txt cấm CRAWL, mà không crawl thì bot
    // không đọc được chỉ thị noindex — URL vẫn lọt chỉ mục qua liên kết ngoài. Cho vào, rồi
    // bảo đừng lập chỉ mục, mới là cách chắc chắn. 'follow' để liên kết vẫn được đi tiếp.
    //
    // TỰ KHỎI: đăng sản phẩm đầu tiên là header biến mất. Không nút bấm, không cờ trong DB,
    // không thêm một trạng thái nữa để người bán quên.
    headers['x-robots-tag'] = 'noindex, follow';
    headers['cache-control'] = 'no-store'; // đừng để CDN giữ bản noindex sau khi đã có hàng
  } else if (cache) {
    // CHỈ đặt Cache-Control cho trang cache được (home/product/category).
    // Trang 404/bảo trì KHÔNG đặt → để Caddy làm chủ no-store trên /cart /checkout
    // /api (không nhân đôi header). CDN cache theo host+path; mỗi host = một shop.
    headers['cache-control'] = CACHE_PUBLIC;
  }
  if (shopSlug) headers['x-shop-slug'] = shopSlug; // giúp e2e/smoke kiểm routing
  res.writeHead(status, headers);
  res.end(html);
}

// Quick-view JSON (Phase 3): trả JSON same-origin, cache như trang catalog (public).
// KHÔNG chứa data khách → an toàn để CDN dùng chung. img-src/CSP không đổi (chỉ là JSON).
function sendJson(res, status, obj, { cache } = {}) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  };
  if (cache) headers['cache-control'] = CACHE_PUBLIC;
  res.writeHead(status, headers);
  res.end(JSON.stringify(obj));
}

// Dựng payload quick-view từ dữ liệu đã đọc (RLS). value_ids của biến thể theo THỨ TỰ trục
// (options.position) để modal khớp tổ hợp khi khách bấm chip. image_url = ảnh RIÊNG biến thể (nếu có).
function quickviewJson({ p, variants, options, vov, media }) {
  const vmap = new Map();
  for (const r of vov) { if (!vmap.has(r.variant_id)) vmap.set(r.variant_id, {}); vmap.get(r.variant_id)[r.option_id] = r.option_value_id; }
  const optOrder = options.map((o) => o.id);
  const images = media.map((m) => imgUrl(m.public_key)).filter(Boolean);
  const varImg = (vid) => { const m = media.find((mm) => mm.variant_id === vid); return m ? imgUrl(m.public_key) : null; };
  const num = (x) => (x != null ? Number(x) : null);
  // compare_at "từ" (chỉ hiển thị): biến thể bán ĐÚNG giá 'từ' (p.price_vnd) có compare > giá.
  const fromCmp = variants.find((v) => Number(v.price_vnd) === Number(p.price_vnd) && v.compare_at_vnd != null && Number(v.compare_at_vnd) > Number(v.price_vnd));
  return {
    slug: p.slug, title: p.title, price_vnd: Number(p.price_vnd),
    sale_price_vnd: null, sale_off_pct: null,
    compare_at_vnd: fromCmp ? Number(fromCmp.compare_at_vnd) : null,
    short_desc: p.description ? String(p.description).replace(/\s+/g, ' ').trim().slice(0, 160) : '',
    images,
    options: options.map((o) => ({ id: o.id, name: o.name, values: (o.values || []).map((v) => ({ id: v.id, label: v.value })) })),
    variants: variants.map((v) => ({
      id: v.id,
      value_ids: optOrder.map((oid) => (vmap.get(v.id) || {})[oid]).filter((x) => x != null),
      price_vnd: Number(v.price_vnd),
      sale_price_vnd: num(v.sale_price_vnd), sale_off_pct: num(v.sale_off_pct),
      available: Number(v.available), image_url: varImg(v.id),
    })),
  };
}

// Phông chữ tự-host (Be Vietnam Pro, giấy phép OFL) — nạp sẵn vào RAM, phục vụ
// /fonts/*.woff2 SAME-ORIGIN (CSP font-src 'self' cho phép). Tên file có version →
// cache 1 năm immutable. Map key = tên file whitelist sẵn → không lo path traversal.
const FONTS = (() => {
  const dir = new URL('./fonts/', import.meta.url);
  const m = new Map();
  try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.woff2')) m.set(f, fs.readFileSync(new URL(f, dir))); } catch {}
  return m;
})();

// /assets/* SAME-ORIGIN (CSP img-src 'self' cho phép) — ẢNH THẬT cho trang giới thiệu nền
// tảng. Chủ nền tảng thả file ảnh vào apps/storefront/src/assets/ (vd hero.webp) rồi khởi
// động lại storefront. Whitelist đuôi ảnh + Map key = tên file CÓ SẴN → không lo path
// traversal. KHÔNG có file → landing tự dùng mock CSS (không vỡ).
const ASSET_TYPES = { '.webp': 'image/webp', '.avif': 'image/avif', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' };
const ASSETS = (() => {
  const dir = new URL('./assets/', import.meta.url);
  const m = new Map();
  try {
    for (const f of fs.readdirSync(dir)) {
      const ext = f.slice(f.lastIndexOf('.')).toLowerCase();
      if (ASSET_TYPES[ext]) m.set(f, { buf: fs.readFileSync(new URL(f, dir)), type: ASSET_TYPES[ext] });
    }
  } catch {}
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
  if (url.pathname.startsWith('/assets/')) {
    const a = ASSETS.get(url.pathname.slice(8));
    if (a) { res.writeHead(200, { 'content-type': a.type, 'cache-control': 'public, max-age=86400' }); return res.end(a.buf); }
    res.writeHead(404); return res.end();
  }
  // /favicon.ico: browser tự hỏi mỗi phiên — trả 204 NGAY TẠI ĐÂY (trước resolve shop)
  // để khỏi tốn roundtrip DB + trả 404 HTML nặng. Cache 1 ngày cho browser khỏi hỏi lại.
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204, { 'cache-control': 'public, max-age=86400' }); return res.end();
  }

  // ── Cổng rate-limit per-IP (Đợt 6.2) ──────────────────────────────────────────
  // Chống flood ẩn danh lên storefront công khai. Miễn trừ tài nguyên tĩnh + robots/
  // sitemap (allowlist — healthz/fonts/favicon đã trả sớm phía trên). FAIL-OPEN: Redis
  // lỗi/chưa sẵn sàng (r.degraded) → CHO QUA, tuyệt đối không làm sập storefront.
  if (redis) {
    const p = url.pathname;
    const exempt = p === '/robots.txt' || p === '/sitemap.xml' || p.startsWith('/fonts/') || p === '/favicon.ico';
    if (!exempt) {
      const isSearch = p === '/search';
      const ip = clientIp(req);
      const rl = await hit(redis, isSearch ? `rl:sf:search:ip:${ip}` : `rl:sf:ip:${ip}`,
        { limit: isSearch ? SF_SEARCH_RL : SF_READ_RL, windowSec: 60 });
      if (!rl.allowed && !rl.degraded) {
        res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'retry-after': String(rl.retryAfterSec || 60), 'cache-control': 'no-store' });
        return res.end(RL_HTML);
      }
    }
  }

  try {
    const host = normalizeHost(req.headers.host);
    // Host GỐC nền tảng (nentang.vn) → trang công ty, không resolve shop.
    if (host && ROOT_HOSTS.has(host)) {
      // Trang MARKETING của nền tảng chạy chung tiến trình với storefront của shop. Không tách
      // tên service thì '/', '/blog', '/blog/:slug', '/sitemap.xml' của hai bên gộp làm một —
      // và câu "blog người bán có ai đọc không" bị cộng lượt đọc bài marketing của nentang.vn.
      noteService('nentang');
      if (url.pathname === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': CACHE_PUBLIC }); return res.end(`User-agent: *\nAllow: /\nSitemap: https://${host}/sitemap.xml\n`); }
      if (url.pathname === '/sitemap.xml') {
        const base = `https://${host}`;
        const urls = ['/', ...companyPaths()].map((p) => `<url><loc>${base}${p}</loc></url>`).join('');
        res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': CACHE_PUBLIC });
        return res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
      }
      if (url.pathname === '/') return sendHtml(res, 200, renderLanding({ ...LANDING_CFG, assets: ASSETS }), { cache: true });
      if (url.pathname === '/gioi-thieu') return sendHtml(res, 200, renderAbout(LANDING_CFG), { cache: true });
      if (url.pathname === '/ho-tro') return sendHtml(res, 200, renderSupport(LANDING_CFG), { cache: true });
      if (url.pathname === '/dieu-khoan') return sendHtml(res, 200, renderTerms(LANDING_CFG), { cache: true });
      // Chính sách bảo vệ dữ liệu cá nhân — Nghị định 13/2023 VÀ điều kiện bắt buộc để
      // Meta duyệt app (không có URL này thì bot Messenger không dùng được với Trang thật).
      if (url.pathname === '/bao-mat') return sendHtml(res, 200, renderPrivacy(LANDING_CFG), { cache: true });
      if (url.pathname === '/lien-he') return sendHtml(res, 200, renderContact(LANDING_CFG), { cache: true });
      if (url.pathname === '/blog') return sendHtml(res, 200, renderCoBlogList(LANDING_CFG), { cache: true });
      if (url.pathname.startsWith('/blog/')) {
        const post = findPost(decodeURIComponent(url.pathname.slice('/blog/'.length)));
        if (post) return sendHtml(res, 200, renderCoBlogPost(LANDING_CFG, post), { cache: true });
      }
      return sendHtml(res, 404, renderNotFound());
    }
    const resolved = host ? await resolveShop(host) : null;
    if (!resolved) return sendHtml(res, 404, renderNotFound());
    // A5: host phụ (không phải tên miền chính) → 301 sang tên miền chính. Một shop có thể
    // verified nhiều tên miền; phục vụ tất cả sẽ trùng nội dung → gom về chính cho SEO.
    if (!resolved.isPrimary && resolved.primaryHost && resolved.primaryHost !== host) {
      skipUsage();   // 301 cho MỌI đường dẫn, TRƯỚC khi khớp route → không có 404 chặn rác bot
      res.writeHead(301, { location: `https://${resolved.primaryHost}${req.url}`, 'cache-control': 'no-store' });
      return res.end();
    }
    const shopId = resolved.shopId;
    noteShop(shopId);   // ĐO LUỒNG DÙNG (0141): shop phân giải theo TÊN MIỀN, không có trong đường dẫn

    // ── Mã giới thiệu CTV: ?ref=MA → cookie rồi 302 BỎ tham số (docs/51) ──────────
    // Vì sao phải bỏ tham số khỏi URL: khách hay copy nguyên thanh địa chỉ gửi bạn bè —
    // để nguyên thì mã của CTV này lan sang mọi người, và mọi link chia sẻ đều mang một
    // tham số bẩn vào SEO (trùng nội dung, khác URL).
    //
    // KHÔNG tra MÃ ở đây: mã có thật hay không thì CHECKOUT mới quyết (một câu lệnh, cùng
    // transaction đặt đơn). Tra ở đây nghĩa là mỗi lượt vào trang qua link CTV đều tốn một
    // truy vấn để đổi lấy... đúng thứ checkout sẽ tra lại. Đây cũng là hàng rào: người lạ
    // dội ?ref= lung tung không làm shop tốn query nào.
    const ref = url.searchParams.get('ref');
    if (ref != null && req.method === 'GET') {
      skipUsage();   // 302 cho MỌI đường dẫn (kể cả đường không tồn tại) → cùng lỗ hổng như trên

      const code = ref.trim().toUpperCase();
      const sp = new URLSearchParams(url.search);
      sp.delete('ref');
      const to = url.pathname + (sp.toString() ? `?${sp}` : '');
      // Mã rác → vẫn 302 sạch URL nhưng XOÁ cookie: last-click mà click cuối là rác thì
      // không được để mã CŨ tiếp tục ăn hoa hồng.
      const okCode = /^[A-Z0-9][A-Z0-9-]{1,23}$/.test(code);
      // TUỔI THỌ COOKIE = CỬA SỔ QUY GÁN. Checkout không so ngày click ở đâu cả: nó chỉ đọc
      // cookie còn hay mất. Nên số ngày shop đặt phải tới được ĐÂY, nếu không ô cấu hình chỉ
      // là đồ trang trí (lỗi đang vá: `resolved.affiliateCookieDays` chưa từng được gán ở
      // đâu → `Number(undefined) || 30` → mọi shop đều 30 ngày).
      //
      // Một truy vấn CHỈ KHI mã đúng định dạng: giữ nguyên hàng rào ở trên — kẻ dội ?ref=
      // rác vẫn không làm shop tốn query nào. Hỏng DB thì rơi về 30, KHÔNG chặn điều hướng.
      const days = okCode ? await docCookieDays(shopId) : 30;
      res.writeHead(302, {
        location: to || '/',
        'cache-control': 'no-store',
        'set-cookie': okCode
          ? `__Host-ref=${encodeURIComponent(code)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}`
          : '__Host-ref=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0',
      });
      return res.end();
    }

    // Trang chủ giờ CHỈ là "nổi bật" (8 SP) — lưới đầy đủ chuyển sang /products. Link cũ
    // /?sort=&page= (bookmark/SEO/dropdown cũ) 301 sang /products GIỮ query → không gãy.
    if (url.pathname === '/' && (url.searchParams.has('sort') || url.searchParams.has('page'))) {
      res.writeHead(301, { location: `/products${url.search}`, 'cache-control': 'no-store' });
      return res.end();
    }
    // THỐNG NHẤT danh mục (0095): /c/:slug (bố cục cũ kiểu trang-chủ) 301 sang /products?cat=
    // (bố cục sidebar duy nhất). Giữ query cũ (sort/page/lọc). Bookmark/SEO cũ không gãy.
    const cRedir = /^\/c\/([a-z0-9-]{1,80})$/.exec(url.pathname);
    if (cRedir) {
      const sp = new URLSearchParams(url.search);
      sp.set('cat', cRedir[1]);
      res.writeHead(301, { location: `/products?${sp.toString()}`, 'cache-control': 'no-store' });
      return res.end();
    }

    // robots.txt — shop onboarding chưa công khai thì chặn toàn bộ index. Không chỉ dựa
    // vào thẻ noindex trong HTML: bot có thể hỏi robots trước khi từng tải trang.
    if (url.pathname === '/robots.txt') {
      const live = await withStore(shopId, async (c) =>
        (await c.query(`SELECT status FROM shops WHERE id = current_shop_id()`)).rows[0]?.status === 'active');
      const body = live
        ? `User-agent: *\nAllow: /\nDisallow: /cart\nDisallow: /checkout\nSitemap: https://${host}/sitemap.xml\n`
        : 'User-agent: *\nDisallow: /\n';
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': live ? CACHE_PUBLIC : 'no-store' });
      return res.end(body);
    }
    // sitemap.xml — trang chủ + danh mục + sản phẩm active + trang nội dung published.
    // RLS (app_store) tự lọc active/published → chỉ URL công khai lọt vào sitemap.
    if (url.pathname === '/sitemap.xml') {
      const sm = await withStore(shopId, async (c) => {
        const status = (await c.query(`SELECT status FROM shops WHERE id = current_shop_id()`)).rows[0]?.status;
        if (!status) return null;
        if (status !== 'active') return { notLive: true };
        const prods = (await c.query(`SELECT slug FROM products ORDER BY created_at DESC LIMIT 5000`)).rows;
        const cats = (await c.query(`SELECT slug FROM categories ORDER BY position LIMIT ${CAT_MAX}`)).rows;
        const pages = (await c.query(`SELECT p.slug FROM pages p JOIN page_revisions pr ON pr.id = p.published_revision_id LIMIT 1000`)).rows;
        const blog = (await c.query(`SELECT slug FROM blog_posts WHERE status = 'published' ORDER BY published_at DESC LIMIT 2000`)).rows;
        return { prods, cats, pages, blog };
      });
      if (!sm) return sendHtml(res, 404, renderNotFound());
      if (sm.notLive) {
        res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' });
        return res.end('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n');
      }
      const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const loc = (path) => `  <url><loc>${escXml(`https://${host}${path}`)}</loc></url>`;
      // Sitemap là LỜI MỜI, nên chỉ mời vào chỗ có thứ để xem. Shop chưa có gì mà vẫn liệt kê
      // '/' và '/products' là tự mâu thuẫn: trang chủ rỗng đã trả noindex, mời rồi lại đuổi.
      // Khuôn này vốn đã đúng với /blog (chỉ thêm khi có bài) — nay áp cho cả hai chỗ kia.
      const coGiDo = sm.prods.length || sm.pages.length || sm.blog.length;
      const urls = [
        ...(coGiDo ? [loc('/')] : []),
        ...(sm.prods.length ? [loc('/products'), ...sm.cats.map((c) => loc(`/products?cat=${c.slug}`))] : []),
        ...sm.prods.map((p) => loc(`/p/${p.slug}`)),
        // /pages/:slug — ĐÚNG route thật (xem nhánh phục vụ trang nội dung bên dưới, và
        // theme.js dựng menu bằng cùng đường đó). Trước đây phát `/${slug}` trần: mọi URL
        // trang chính sách nộp cho Google đều 404, mà sitemap thì im lặng — không ai thấy
        // cho tới khi mở Search Console. Đây cũng là lý do e2e phải LẤY CHÍNH <loc> trong
        // sitemap rồi fetch lại, thay vì gõ tay đường dẫn vào test.
        ...sm.pages.map((pg) => loc(`/pages/${pg.slug}`)),
        ...(sm.blog.length ? [loc('/blog'), ...sm.blog.map((b) => loc(`/blog/${b.slug}`))] : [])]
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
      res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': CACHE_PUBLIC });
      return res.end(xml);
    }

    const data = await withStore(shopId, async (c) => {
      const shopRes = await c.query(`SELECT slug, name, status, contact_email, contact_phone, business_address, logo_key FROM shops WHERE id = current_shop_id()`);
      const shop = shopRes.rows[0];
      if (!shop) return { notFound: true }; // terminated/deleted (RLS)
      shop.logo_url = imgUrl(shop.logo_key); // header hiện logo nếu có
      if (shop.status === 'suspended') return { shop, suspended: true };

      // Token xem trước toàn shop: query dùng một lần rồi đổi sang cookie host-only. RLS của
      // shop_previews buộc đúng tenant + TTL; token shop A trình ở host shop B luôn vô hình.
      const queryPreview = url.searchParams.get('shop_preview');
      const cookiePreview = cookieValue(req, SHOP_PREVIEW_COOKIE);
      const presented = SHOP_PREVIEW_RE.test(queryPreview ?? '') ? queryPreview
        : (SHOP_PREVIEW_RE.test(cookiePreview ?? '') ? cookiePreview : null);
      let shopPreview = false;
      if (shop.status === 'onboarding' && presented) {
        shopPreview = (await c.query(
          `SELECT 1 FROM shop_previews WHERE token_hash = $1 AND expires_at > now()`,
          [hashToken(presented)],
        )).rowCount === 1;
      }
      if (shop.status === 'onboarding' && !shopPreview) return { shop, preparing: true };

      const theme = (await c.query(`SELECT tokens, layout FROM themes WHERE shop_id = current_shop_id()`)).rows[0] ?? null;
      // Ảnh tiêu biểu mỗi danh mục = ảnh SP mới nhất trong danh mục — CHỈ khi layout dùng
      // category_bar (thanh danh mục ảnh tròn kiểu MM). Shop khác KHÔNG tốn subquery này.
      // Ảnh gộp cả con (0095): danh mục CHA thường không gán SP trực tiếp (SP nằm ở con) →
      // lấy ảnh SP mới nhất của chính nó HOẶC bất kỳ danh mục con nào.
      // Ảnh TỰ ĐẶT của danh mục (0118) thắng ảnh suy từ SP: shop đã bỏ công chọn thì
      // đừng để một SP mới đăng đổi mất ảnh danh mục sau lưng họ. COALESCE, không phải
      // hai cột — phía render chỉ cần biết "có ảnh hay không".
      // Nạp ảnh khi layout có category_bar HOẶC collections — cả hai đều bày danh mục
      // ra trang chủ. Bố cục khác không dính subquery này.
      const catImg = (Array.isArray(theme?.layout) && theme.layout.some((s) => s && (s.section === 'category_bar' || s.section === 'collections')))
        ? `, COALESCE(c.image_key, (SELECT m.public_key FROM product_categories pc JOIN products p ON p.id = pc.product_id
              JOIN media m ON m.product_id = p.id
             WHERE pc.category_id IN (SELECT ch.id FROM categories ch WHERE ch.deleted_at IS NULL AND (ch.id = c.id OR ch.parent_id = c.id))
               AND p.status = 'active' AND p.deleted_at IS NULL
             ORDER BY p.created_at DESC, m.position LIMIT 1)) AS image_key` : '';
      // Nạp cả cây (2 cấp, 0095): parent_id để dựng cha→con ở dropdown/sidebar. Danh mục con
      // của cha đã ẩn (soft-delete) sẽ có parent_id treo → coi như cấp-1 (xử lý ở buildCatTree).
      const catRows = (await c.query(`SELECT c.id, c.slug, c.name, c.parent_id${catImg} FROM categories c ORDER BY c.position, c.name LIMIT ${CAT_MAX}`)).rows;
      const categories = buildCatTree(catRows, imgUrl); // mảng cấp-1, mỗi phần tử có .children[]
      // Menu chân trang: chỉ trang ĐÃ published, có menu_position. Tiêu đề lấy từ
      // bản published (page_revisions), không phải draft → khớp nội dung hiển thị.
      const menu = (await c.query(
        `SELECT p.slug, pr.title
           FROM pages p JOIN page_revisions pr ON pr.id = p.published_revision_id
          WHERE p.menu_position IS NOT NULL
          ORDER BY p.menu_position, pr.title LIMIT 20`,
      )).rows;
      const hasBlog = Number((await c.query(`SELECT count(*)::int n FROM blog_posts WHERE status = 'published'`)).rows[0].n) > 0;
      const base = {
        shop, theme, categories, menu, hasBlog, shopPreview,
        shopPreviewToken: shopPreview && queryPreview === presented ? presented : null,
      };

      // ?sort= whitelist (giá trị lạ → 'new' = created_at DESC, hành vi cũ).
      const sortKey = Object.hasOwn(GRID_SORTS, url.searchParams.get('sort') ?? '') ? url.searchParams.get('sort') : 'new';
      // Bộ lọc lưới (#27, chỉ danh mục + tìm kiếm): ?instock=1 (còn hàng bán được —
      // dùng lại đúng predicate available của thẻ lưới) + ?pmin=/?pmax= (khoảng giá
      // p.price_vnd, số nguyên). Parse/whitelist tại đây — KHÔNG nội suy chuỗi thô vào SQL.
      const parsePrice = (s) => (/^\d{1,12}$/.test(s ?? '') ? Number(s) : null);
      const filters = {
        instock: url.searchParams.get('instock') === '1',
        pmin: parsePrice(url.searchParams.get('pmin')),
        pmax: parsePrice(url.searchParams.get('pmax')),
      };
      // Nối điều kiện lọc vào WHERE có sẵn; đẩy giá vào args (tham số hoá).
      const filterSql = (args) => {
        const parts = [];
        if (filters.instock) {
          parts.push(`(SELECT coalesce(sum(${AVAIL_SQL}), 0)
                         FROM variants v LEFT JOIN inventory_levels il ON il.variant_id = v.id
                        WHERE v.product_id = p.id AND ${VARIANT_NOT_ORPHAN_SQL}) > 0`);
        }
        if (filters.pmin != null) { args.push(filters.pmin); parts.push(`p.price_vnd >= $${args.length}`); }
        if (filters.pmax != null) { args.push(filters.pmax); parts.push(`p.price_vnd <= $${args.length}`); }
        return parts.length ? ' AND ' + parts.join(' AND ') : '';
      };
      // Giá GẠCH NGANG trên thẻ lưới (0067): thẻ hiện p.price_vnd → chỉ lấy compare của
      // biến thể bán ĐÚNG giá đó (tránh badge -% sai khi biến thể khác giá). Chỉ hiển thị.
      const cardCompareSql = `(SELECT v.compare_at_vnd FROM variants v
                    WHERE v.product_id = p.id AND v.price_vnd = p.price_vnd
                      AND v.compare_at_vnd > v.price_vnd AND ${VARIANT_NOT_ORPHAN_SQL}
                    ORDER BY v.position LIMIT 1) AS compare_at_vnd`;
      const productGrid = async (whereJoin = '', args = [], offset = 0, limit = PAGE_SIZE) => {
        const total = Number((await c.query(`SELECT count(*)::int n FROM products p ${whereJoin}`, args)).rows[0].n);
        // Flash sale (0082): promo_effective trên p.price_vnd (giá thẻ = giá 'từ' rẻ nhất).
        // pe = LATERAL nguồn giá DUY NHẤT → thẻ hiện giá sale + gạch giá gốc, KHÔNG drift.
        const rows = (await c.query(
          `SELECT p.id, p.slug, p.title, p.price_vnd,
                  -- Tín hiệu sàn TMĐT (0096): đọc CỘT CACHE, không aggregate (query này đã 6 subquery/hàng).
                  p.sold_count, p.rating_avg, p.rating_count,
                  pe.price_vnd AS sale_price_vnd, pe.off_pct AS sale_off_pct,
                  (SELECT m.public_key FROM media m WHERE m.product_id = p.id ORDER BY m.position, m.created_at LIMIT 1) AS image_key,
                  -- Phase 3 thẻ hover: ảnh THỨ HAI (đổi khi rê chuột). NULL nếu SP chỉ 1 ảnh.
                  (SELECT m2.public_key FROM media m2 WHERE m2.product_id = p.id ORDER BY m2.position, m2.created_at OFFSET 1 LIMIT 1) AS image2_key,
                  -- Phase 3 thêm-nhanh-vào-giỏ: SP 1 biến thể & 0 trục → thêm thẳng; ngược lại cần chọn (quick-view/PDP).
                  (SELECT count(*)::int FROM product_options po WHERE po.product_id = p.id) AS option_count,
                  (SELECT count(*)::int FROM variants v WHERE v.product_id = p.id AND ${VARIANT_NOT_ORPHAN_SQL}) AS variant_count,
                  (SELECT v.id FROM variants v WHERE v.product_id = p.id AND ${VARIANT_NOT_ORPHAN_SQL} ORDER BY v.position LIMIT 1) AS first_variant_id,
                  ${cardCompareSql},
                  (SELECT coalesce(sum(${AVAIL_SQL}), 0)
                     FROM variants v LEFT JOIN inventory_levels il ON il.variant_id = v.id
                    WHERE v.product_id = p.id AND ${VARIANT_NOT_ORPHAN_SQL}) AS available
             FROM products p
             LEFT JOIN LATERAL promo_effective(p.id, p.price_vnd, now()) pe ON true
             ${whereJoin} ORDER BY ${GRID_SORTS[sortKey]} LIMIT ${limit} OFFSET ${offset}`,
          args,
        )).rows.map((p) => ({ ...p, image: imgUrl(p.image_key), image2: imgUrl(p.image2_key), available: Number(p.available),
          // has_options = có trục HOẶC >1 biến thể → khách phải chọn. default_variant_id chỉ đặt khi
          // SP "phẳng" (0 trục, đúng 1 biến thể) → thẻ hiện form thêm-nhanh; còn lại → link về PDP/quick-view.
          has_options: (Number(p.option_count) > 0) || (Number(p.variant_count) > 1),
          default_variant_id: (Number(p.option_count) === 0 && Number(p.variant_count) === 1) ? p.first_variant_id : null,
          sale_price_vnd: p.sale_price_vnd != null ? Number(p.sale_price_vnd) : null, sale_off_pct: p.sale_off_pct != null ? Number(p.sale_off_pct) : null }));
        return { products: rows, total };
      };
      // Trần CỨNG số trang (100): OFFSET lớn = quét sâu tốn kém; kẻ tấn công không được
      // đẩy ?page=99999 để ép DB nhảy offset khổng lồ. parseInt + kẹp [1, 100].
      const pageNo = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1));
      const offset = (pageNo - 1) * PAGE_SIZE;

      // Quick-view JSON (Phase 3): mini trang SP cho modal. Dữ liệu CATALOG công khai (không
      // data khách) → cache CDN như trang khác. ĐĂNG KÝ TRƯỚC /p/:slug để khớp đúng. Mô hình
      // theo query trang chi tiết (RLS store_products chỉ trả SP active/hiển thị).
      const qm = /^\/p\/([a-z0-9-]+)\/quickview$/.exec(url.pathname);
      if (qm) {
        const p = (await c.query(`SELECT id, slug, title, description, price_vnd FROM products WHERE slug = $1`, [qm[1]])).rows[0];
        if (!p) return { ...base, notFound: true };
        const variants = (await c.query(
          `SELECT v.id, v.price_vnd, v.compare_at_vnd, coalesce(${AVAIL_SQL}, 0) AS available,
                  pe.price_vnd AS sale_price_vnd, pe.off_pct AS sale_off_pct
             FROM variants v LEFT JOIN inventory_levels il ON il.variant_id = v.id
             LEFT JOIN LATERAL promo_effective(v.product_id, v.price_vnd, now()) pe ON true
            WHERE v.product_id = $1 AND ${VARIANT_NOT_ORPHAN_SQL} ORDER BY v.position`, [p.id])).rows;
        const options = (await c.query(
          `SELECT o.id, o.name, o.position,
                  coalesce(json_agg(json_build_object('id', ov.id, 'value', ov.value) ORDER BY ov.position) FILTER (WHERE ov.id IS NOT NULL), '[]') AS values
             FROM product_options o LEFT JOIN option_values ov ON ov.option_id = o.id
            WHERE o.product_id = $1 GROUP BY o.id ORDER BY o.position`, [p.id])).rows;
        const vov = (await c.query(
          `SELECT vov.variant_id, vov.option_id, vov.option_value_id
             FROM variant_option_values vov JOIN variants v ON v.id = vov.variant_id WHERE v.product_id = $1`, [p.id])).rows;
        const media = (await c.query(`SELECT public_key, variant_id FROM media WHERE product_id = $1 ORDER BY position, created_at`, [p.id])).rows;
        return { ...base, quickview: { p, variants, options, vov, media } };
      }

      // Trang chi tiết sản phẩm: /p/:slug (?variant= chọn biến thể — SSR đổi giá/tồn/ảnh).
      const pm = /^\/p\/([a-z0-9-]+)$/.exec(url.pathname);
      if (pm) {
        const p = (await c.query(
          `SELECT id, slug, title, description, price_vnd, seo_title, seo_description
             FROM products WHERE slug = $1`, [pm[1]],
        )).rows[0];
        if (!p) return { ...base, notFound: true };
        countProductView(shopId, p.id, req);   // fire-and-forget, không chặn trang
        // available = CÒN BÁN ĐƯỢC ONLINE = on_hand − reserved − đệm an toàn (0140, safety-stock.js).
        // KHỚP TỪNG CHỮ với hàng rào của checkout — trang nói "còn hàng" mà checkout từ chối là
        // lỗi tệ nhất của tính năng này. Không có dòng inventory = 0 = hết hàng (như cũ).
        // Lọc biến thể MỒ CÔI ngay tại query → selected/totalAvail/selector (theme.js)
        // đều kế thừa danh sách đã lọc, không cần sửa theme.
        // Flash sale (0082): promo_effective per biến thể (base = v.price_vnd RIÊNG → SP đa biến
        // thể ra giá sale đúng từng biến thể). ?variant= đổi giá sale theo biến thể được chọn.
        const variants = (await c.query(
          `SELECT v.id, v.title, v.sku, v.price_vnd, v.compare_at_vnd, coalesce(${AVAIL_SQL}, 0) AS available,
                  pe.price_vnd AS sale_price_vnd, pe.off_pct AS sale_off_pct, pe.promotion_id
             FROM variants v LEFT JOIN inventory_levels il ON il.variant_id = v.id
             LEFT JOIN LATERAL promo_effective(v.product_id, v.price_vnd, now()) pe ON true
            WHERE v.product_id = $1 AND ${VARIANT_NOT_ORPHAN_SQL}
            ORDER BY v.position`, [p.id])).rows.map((v) => ({ ...v,
          sale_price_vnd: v.sale_price_vnd != null ? Number(v.sale_price_vnd) : null, sale_off_pct: v.sale_off_pct != null ? Number(v.sale_off_pct) : null }));
        // Trục biến thể (Màu/Size...) — RLS store_* chỉ trả option của SP đang bán.
        p.options = (await c.query(
          `SELECT o.id, o.name, o.position,
                  coalesce(json_agg(json_build_object('id', ov.id, 'value', ov.value) ORDER BY ov.position) FILTER (WHERE ov.id IS NOT NULL), '[]') AS values
             FROM product_options o LEFT JOIN option_values ov ON ov.option_id = o.id
            WHERE o.product_id = $1 GROUP BY o.id ORDER BY o.position`, [p.id])).rows;
        // Ánh xạ biến thể → {option_id: value_id} để resolve tổ hợp khi khách đổi 1 trục.
        const vov = (await c.query(
          `SELECT vov.variant_id, vov.option_id, vov.option_value_id
             FROM variant_option_values vov JOIN variants v ON v.id = vov.variant_id WHERE v.product_id = $1`, [p.id])).rows;
        const vmap = new Map();
        for (const r of vov) { if (!vmap.has(r.variant_id)) vmap.set(r.variant_id, {}); vmap.get(r.variant_id)[r.option_id] = r.option_value_id; }
        p.variants = variants.map((v) => ({ ...v, values: vmap.get(v.id) ?? {} }));
        // Khung giờ flash sale: title + ends_at của promo áp cho biến thể ĐẦU có sale → theme.js
        // hiện text tĩnh "Flash sale — đến HH:MM dd/mm" (KHÔNG countdown JS, hợp CSP).
        const salePromoId = p.variants.find((v) => v.promotion_id)?.promotion_id ?? null;
        p.promo = salePromoId
          ? ((await c.query(`SELECT title, ends_at FROM promotions WHERE id = $1 AND active`, [salePromoId])).rows[0] ?? null)
          : null;
        // Ảnh: kèm variant_id → storefront đổi ảnh theo biến thể (NULL = ảnh chung sản phẩm).
        p.media = (await c.query(`SELECT public_key, variant_id FROM media WHERE product_id = $1 ORDER BY position, created_at`, [p.id]))
          .rows.map((m) => ({ url: imgUrl(m.public_key), variant_id: m.variant_id }));
        p.specs = (await c.query(`SELECT name, value FROM product_specs WHERE product_id = $1 ORDER BY position`, [p.id])).rows;
        p.category = (await c.query(
          `SELECT c.slug, c.name FROM product_categories pc JOIN categories c ON c.id = pc.category_id
            WHERE pc.product_id = $1 ORDER BY c.position LIMIT 1`, [p.id])).rows[0] ?? null;
        // Sản phẩm liên quan: cùng danh mục, đang bán, khác chính nó (RLS store_products lọc active).
        p.related = (await c.query(
          `SELECT DISTINCT p2.id, p2.slug, p2.title, p2.price_vnd, p2.sold_count, p2.rating_avg, p2.rating_count,
                  pe.price_vnd AS sale_price_vnd, pe.off_pct AS sale_off_pct,
                  (SELECT m.public_key FROM media m WHERE m.product_id = p2.id ORDER BY m.position, m.created_at LIMIT 1) AS image_key,
                  (SELECT coalesce(sum(${AVAIL_SQL}), 0) FROM variants v LEFT JOIN inventory_levels il ON il.variant_id = v.id
                    WHERE v.product_id = p2.id AND ${VARIANT_NOT_ORPHAN_SQL}) AS available
             FROM products p2 JOIN product_categories pc2 ON pc2.product_id = p2.id
             LEFT JOIN LATERAL promo_effective(p2.id, p2.price_vnd, now()) pe ON true
            WHERE pc2.category_id IN (SELECT category_id FROM product_categories WHERE product_id = $1) AND p2.id <> $1
            LIMIT 8`, [p.id])).rows.map((r) => ({ ...r, image: imgUrl(r.image_key), available: Number(r.available),
          sale_price_vnd: r.sale_price_vnd != null ? Number(r.sale_price_vnd) : null, sale_off_pct: r.sale_off_pct != null ? Number(r.sale_off_pct) : null }));
        // Đánh giá: RLS store_reviews chỉ trả APPROVED của SP đang hiện.
        p.reviewStats = (await c.query(
          // Kèm PHÂN BỔ SAO (0099) để vẽ biểu đồ 5★…1★ — khách nhìn phát biết "4.5 sao" là
          // đều tay hay là trộn nhiều 5 sao với vài 1 sao. Đếm trong CÙNG một lượt quét.
          `SELECT count(*)::int AS n, coalesce(round(avg(rating)::numeric, 1), 0) AS avg,
                  count(*) FILTER (WHERE rating = 5)::int AS r5,
                  count(*) FILTER (WHERE rating = 4)::int AS r4,
                  count(*) FILTER (WHERE rating = 3)::int AS r3,
                  count(*) FILTER (WHERE rating = 2)::int AS r2,
                  count(*) FILTER (WHERE rating = 1)::int AS r1
             FROM product_reviews WHERE product_id = $1`, [p.id])).rows[0];
        // HỮU ÍCH NHẤT trước, rồi mới tới mới nhất (mẫu Shopee/TikTok Shop) — đánh giá dài,
        // có ích được nhiều người bấm sẽ nổi lên thay vì chìm theo thời gian.
        p.reviews = (await c.query(
          // Ảnh (0101): RLS store_review_images chỉ trả ảnh 'ready' của đánh giá 'approved'
          // → ảnh chờ duyệt/bị từ chối KHÔNG THỂ lọt ra đây dù query có sai sót.
          `SELECT r.id, r.rating, r.author_name, r.content, r.verified, r.created_at,
                  r.seller_reply, r.seller_replied_at, r.helpful_count,
                  (SELECT coalesce(json_agg(i.public_key ORDER BY i.position), '[]'::json)
                     FROM review_images i WHERE i.review_id = r.id) AS image_keys
             FROM product_reviews r
            WHERE r.product_id = $1 ORDER BY r.helpful_count DESC, r.created_at DESC LIMIT 10`, [p.id]))
          .rows.map((r) => ({ ...r, images: (r.image_keys ?? []).filter(Boolean).map(imgUrl) }));
        // Hỏi đáp (0100): RLS store_questions chỉ trả câu hỏi ĐÃ DUYỆT của SP đang hiện.
        // Chỉ lấy câu ĐÃ CÓ trả lời — câu hỏi bỏ ngỏ trên trang SP chỉ tổ làm khách lo.
        p.questions = (await c.query(
          `SELECT asker_name, question, answer, answered_at, created_at FROM product_questions
            WHERE product_id = $1 AND answer IS NOT NULL ORDER BY created_at DESC LIMIT 10`, [p.id])).rows;
        p.reviewFlag = url.searchParams.get('review'); // 'sent' | 'invalid' (PRG từ checkout)
        p.askFlag = url.searchParams.get('ask');       // 'sent' | 'invalid' (PRG từ checkout)
        p.wishFlag = url.searchParams.get('wish');     // 'added' | 'removed' (PRG từ account)
        p.selectedId = url.searchParams.get('variant');
        return { ...base, product: p };
      }

      // Trang TẤT CẢ sản phẩm: /products — lưới đầy đủ (kế thừa hành vi lưới trang chủ cũ:
      // sort + lọc + pager) + chip danh mục LỌC TẠI CHỖ qua ?cat=<slug> (chủ shop yêu cầu
      // "lọc, không nhảy trang"). Trang chủ giờ chỉ còn 8 SP nổi bật.
      if (url.pathname === '/products') {
        const rawCat = url.searchParams.get('cat') ?? '';
        const catSlug = /^[a-z0-9-]{1,80}$/.test(rawCat) ? rawCat : null;
        // Ô tìm trong sidebar bộ lọc (redesign): ?q= dùng CÙNG cơ chế token /search (không dấu +
        // đảo từ, escape %_\), kết hợp cat + lọc còn-hàng/giá. Trần độ dài 80 như /search.
        const q = (url.searchParams.get('q') ?? '').trim().slice(0, 80);
        const args = [];
        const conds = [];
        let activeCatName = null;
        if (catSlug) {
          // Danh mục 2 cấp (0095): cha → gộp mọi con; con/lá → chỉ chính nó. EXISTS + ANY để
          // KHÔNG nhân đôi hàng khi SP thuộc nhiều con của cùng cha (JOIN sẽ nhân đôi).
          // Không có trong cây đã nạp → tra thẳng DB (danh mục vượt CAT_MAX vẫn phải vào được).
          const hit = resolveCatSlug(categories, catSlug) ?? await resolveCatSlugDb(c, catSlug);
          if (!hit) return { ...base, notFound: true };
          activeCatName = hit.cat.name;
          args.push(hit.ids);
          conds.push(`EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id AND pc.category_id = ANY($${args.length}))`);
        }
        if (q) {
          const toks = q.split(/\s+/).filter(Boolean).slice(0, 8);
          for (const t of toks) {
            args.push('%' + t.replace(/[%_\\]/g, '\\$&') + '%');
            conds.push(`(vn_unaccent(p.title) LIKE vn_unaccent($${args.length}) OR EXISTS (
              SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.sku ILIKE $${args.length} AND ${VARIANT_NOT_ORPHAN_SQL}))`);
          }
        }
        let whereJoin = '';
        if (conds.length) {
          whereJoin = ` WHERE ${conds.join(' AND ')}${filterSql(args)}`; // filterSql prefix ' AND '
        } else {
          const f = filterSql(args); // ' AND ...' → cắt tiền tố để đứng sau WHERE
          whereJoin = f ? ` WHERE ${f.slice(' AND '.length)}` : '';
        }
        const { products, total } = await productGrid(whereJoin, args, offset);
        // basePath giữ cat + q để pager/sort/lọc không làm rơi ngữ cảnh khi phân trang.
        const bp = [];
        if (catSlug) bp.push(`cat=${encodeURIComponent(catSlug)}`);
        if (q) bp.push(`q=${encodeURIComponent(q)}`);
        const basePath = bp.length ? `/products?${bp.join('&')}` : '/products';
        return { ...base, products, productsPage: true, catSlug, query: q, activeCatName,
          pageInfo: { total, offset, pageSize: PAGE_SIZE, basePath, sort: sortKey, filters, filterable: true } };
      }

      // (Trang /c/:slug đã 301 sang /products?cat= ở trên — bố cục danh mục thống nhất.)

      // Tìm kiếm: /search?q=... (LIKE theo tên; RLS store_products lọc active).
      if (url.pathname === '/search') {
        // Trần CỨNG độ dài q (~80 ký tự): cắt bớt để một truy vấn tìm không phình chi phí
        // full-scan LIKE (khuếch đại). Token vẫn giới hạn 8 (dưới) nên đủ cho tìm thật.
        const q = (url.searchParams.get('q') ?? '').trim().slice(0, 80);
        let products = [], total = 0;
        if (q) {
          // KHÔNG DẤU (0048) + ĐẢO TỪ (#26): tách q theo khoảng trắng → MỌI token phải
          // khớp (AND) → "trai tham" vẫn ra "Thảm trải sàn". Mỗi token khớp tên
          // (vn_unaccent LIKE, escape %_\) HOẶC SKU biến thể không-mồ-côi (EXISTS —
          // theo pattern tìm của seller catalog.js). Vẫn LIKE-based có chủ đích:
          // chuyển tsvector/FTS là dự án riêng, chưa làm ở đợt này.
          const toks = q.split(/\s+/).filter(Boolean).slice(0, 8);
          const args = [];
          const conds = toks.map((t) => {
            args.push('%' + t.replace(/[%_\\]/g, '\\$&') + '%');
            return `(vn_unaccent(p.title) LIKE vn_unaccent($${args.length}) OR EXISTS (
              SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.sku ILIKE $${args.length} AND ${VARIANT_NOT_ORPHAN_SQL}))`;
          });
          ({ products, total } = await productGrid(`WHERE ${conds.join(' AND ')}${filterSql(args)}`, args, offset));
        }
        return { ...base, products, search: true, query: q, pageInfo: { total, offset, pageSize: PAGE_SIZE, basePath: `/search?q=${encodeURIComponent(q)}`, sort: sortKey, filters, filterable: true } };
      }

      // Trang nội dung/chính sách: /pages/:slug. CHỈ bản published (RLS store_pages
      // che draft/đã xoá). Nội dung lấy từ page_revisions được published_revision_id trỏ.
      const gm = /^\/pages\/([a-z0-9-]+)$/.exec(url.pathname);
      if (gm) {
        // Preview BẢN NHÁP: seller cấp token → đọc SNAPSHOT trong page_previews (KHÔNG
        // đọc pages.blocks). RLS store_preview lo cô lập tenant + hết hạn; ràng slug để
        // token chỉ dùng đúng trang của nó. Không token → luồng published bình thường.
        const previewToken = url.searchParams.get('preview');
        if (previewToken) {
          const pv = (await c.query(
            `SELECT title, blocks, seo_title, seo_description FROM page_previews
              WHERE token_hash = $1 AND slug = $2 AND expires_at > now()`,
            [hashToken(previewToken), gm[1]],
          )).rows[0];
          if (!pv) return { ...base, notFound: true };
          return { ...base, page: pv, preview: true };
        }
        const doc = (await c.query(
          `SELECT pr.title, pr.blocks, pr.seo_title, pr.seo_description
             FROM pages p JOIN page_revisions pr ON pr.id = p.published_revision_id
            WHERE p.slug = $1`, [gm[1]],
        )).rows[0];
        if (!doc) return { ...base, notFound: true };
        return { ...base, page: doc };
      }

      // Blog: /blog (danh sách bài published, phân trang ?page= — 12 bài/trang) +
      // /blog/:slug (bài, kèm ảnh bìa). RLS store_blog lọc published.
      if (url.pathname === '/blog') {
        const BLOG_PAGE_SIZE = 12;
        // Kẹp trần 100 trang y như lưới sản phẩm ở trên — trang blog CÔNG KHAI, không cần
        // đăng nhập, nên `?page=99999999999999999999` (OFFSET vượt bigint) là một cái 500
        // bất kỳ ai trên Internet cũng bắn được vào storefront của shop. Lưới SP đã kẹp từ
        // đầu, blog thì quên: cùng tệp, cách nhau 200 dòng.
        const bp = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1));
        const nPosts = Number((await c.query(`SELECT count(*)::int n FROM blog_posts WHERE status = 'published'`)).rows[0].n);
        const posts = (await c.query(
          `SELECT slug, title, excerpt, cover_image_key, published_at FROM blog_posts
            WHERE status = 'published' ORDER BY published_at DESC LIMIT ${BLOG_PAGE_SIZE} OFFSET ${(bp - 1) * BLOG_PAGE_SIZE}`,
        )).rows.map((p) => ({ ...p, cover: imgUrl(p.cover_image_key) }));
        return { ...base, blog: 'list', posts, blogPage: { page: bp, last: Math.max(1, Math.ceil(nPosts / BLOG_PAGE_SIZE)) } };
      }
      const bm = /^\/blog\/([a-z0-9-]+)$/.exec(url.pathname);
      if (bm) {
        const post = (await c.query(`SELECT slug, title, excerpt, body, published_at, cover_image_key FROM blog_posts WHERE slug = $1 AND status = 'published'`, [bm[1]])).rows[0];
        if (!post) return { ...base, notFound: true };
        post.cover = imgUrl(post.cover_image_key);
        return { ...base, blog: 'post', post };
      }

      // Trang chủ: CHỈ path '/'. Path lạ → 404 (không render home cho mọi thứ).
      if (url.pathname !== '/') return { ...base, notFound: true };
      // Lưới NỔI BẬT (HOME_FEATURED SP), KHÔNG pageInfo → theme render chế độ "nổi bật"
      // (không chips/sort/pager, nút "Xem thêm" → /products). Fetch đúng HOME_FEATURED, không lấy 24 thừa.
      const { products } = await productGrid('', [], 0, HOME_FEATURED);
      // Section "Bài viết mới nhất": 3 bài published gần nhất (mirror query /blog — RLS
      // store_blog lọc published). Không có bài → theme tự ẩn section.
      const blogPosts = (await c.query(
        `SELECT slug, title, excerpt, body, cover_image_key, published_at FROM blog_posts
          WHERE status = 'published' ORDER BY published_at DESC LIMIT 3`,
      )).rows.map((p) => ({
        slug: p.slug, title: p.title, cover: imgUrl(p.cover_image_key), published_at: p.published_at,
        // Trích đoạn cắt ~120 ký tự server-side (ưu tiên excerpt người bán nhập, không thì body).
        excerpt: String(p.excerpt || p.body || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      }));
      // Bố cục tạp hoá/MM (preset): nếu theme dùng section 'category_rows', nạp SP theo TỪNG
      // danh mục hàng đầu (mỗi danh mục = 1 hàng ngang). CHỈ khi layout khai báo → shop khác
      // KHÔNG tốn query. Tái dùng productGrid (cùng thẻ + đường tiền + RLS active). Trang chủ vẫn cache.
      let categoryRows = [];
      if (Array.isArray(theme?.layout) && theme.layout.some((s) => s && s.section === 'category_rows') && categories.length) {
        // Mỗi hàng = 1 danh mục CẤP-1, GỘP sản phẩm của nó + mọi con (0095). EXISTS+ANY dedup.
        for (const cat of categories.slice(0, 6)) {
          const ids = [cat.id, ...cat.children.map((ch) => ch.id)];
          const { products: cp } = await productGrid(
            `WHERE EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id AND pc.category_id = ANY($1))`, [ids], 0, 8);
          if (cp.length) categoryRows.push({ slug: cat.slug, name: cat.name, products: cp });
        }
      }
      // FLASH SALE (preset mỹ phẩm/M.O.I): CHỈ khi layout dùng 'flash_sale'. endsMs = mốc kết thúc
      // SỚM NHẤT của promo ĐANG chạy (đồng hồ đếm ngược); products = SP đang được giảm (có promo active
      // phủ tới) top 10. Không promo → flashSale = null → section tự ẩn. productGrid lọc bằng EXISTS
      // trên promotions (KHÔNG tham chiếu LATERAL pe → chạy được cả ở count lẫn rows).
      let flashSale = null;
      if (Array.isArray(theme?.layout) && theme.layout.some((s) => s && s.section === 'flash_sale')) {
        const endRow = await c.query(`SELECT extract(epoch FROM min(ends_at)) * 1000 AS ends_ms
                                        FROM promotions WHERE active AND starts_at <= now() AND now() < ends_at`);
        const endsMs = endRow.rows[0].ends_ms != null ? Math.round(Number(endRow.rows[0].ends_ms)) : null;
        if (endsMs) {
          const { products: sp } = await productGrid(
            `WHERE EXISTS (SELECT 1 FROM promotions pr WHERE pr.active AND pr.starts_at <= now() AND now() < pr.ends_at
                             AND (pr.scope = 'all' OR EXISTS (SELECT 1 FROM promotion_products pp
                                   WHERE pp.promotion_id = pr.id AND pp.product_id = p.id)))`, [], 0, 10);
          if (sp.length) flashSale = { endsMs, products: sp };
        }
      }
      return { ...base, products, home: true, blogPosts, categoryRows, flashSale };
    });

    if (data.notFound) return sendHtml(res, 404, renderNotFound(), { shopSlug: data.shop?.slug });
    if (data.suspended) return sendHtml(res, 503, renderMaintenance(data.shop.name), { shopSlug: data.shop.slug });
    if (data.preparing) return sendHtml(res, 200, renderPreparing(data.shop.name, { contact_email: data.shop.contact_email, contact_phone: data.shop.contact_phone }), { shopSlug: data.shop.slug, preview: true });
    // Token không nằm lại trên thanh địa chỉ/referrer: sau khi DB xác thực, đổi sang cookie
    // host-only rồi redirect về chính URL đã bỏ tham số. Cookie vẫn phải qua RLS ở MỌI request.
    if (data.shopPreviewToken) {
      const clean = new URLSearchParams(url.search);
      clean.delete('shop_preview');
      res.writeHead(302, {
        location: url.pathname + (clean.toString() ? `?${clean}` : ''),
        'cache-control': 'no-store',
        'set-cookie': `${SHOP_PREVIEW_COOKIE}=${encodeURIComponent(data.shopPreviewToken)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=900`,
      });
      return res.end();
    }
    const sendView = (status, html, options = {}) => sendHtml(
      res,
      status,
      data.shopPreview ? markShopPreview(html) : html,
      { ...options, preview: data.shopPreview || options.preview === true },
    );
    // Quick-view (Phase 3): JSON public, cache như catalog. TRƯỚC các nhánh render HTML.
    if (data.quickview) return sendJson(res, 200, quickviewJson(data.quickview), { cache: !data.shopPreview });

    // origin tuyệt đối của shop (từ host request) → dựng URL tuyệt đối cho og:image,
    // vì bộ quét mạng xã hội KHÔNG hiểu ảnh đường-dẫn-tương-đối (/media-public/...).
    const origin = host ? `https://${host}` : '';
    // Nonce CSP mỗi-request (ngẫu nhiên mật mã) cho lớp JS badge giỏ ở header. Dùng chung: header
    // render <script nonce=…> + sendHtml phát script-src 'nonce-…' (khớp nhau qua ctx.nonce).
    const nonce = crypto.randomBytes(16).toString('base64');
    const ctx = { shop: data.shop, theme: data.theme, categories: data.categories, products: data.products ?? [], menu: data.menu ?? [], pageInfo: data.pageInfo ?? null, query: data.query ?? '', hasBlog: data.hasBlog, blogPosts: data.blogPosts ?? [], categoryRows: data.categoryRows ?? [], flashSale: data.flashSale ?? null, activeCatName: data.activeCatName ?? null, origin, nonce };
    // Canonical PHÂN TRANG (#28): trang N canonical về CHÍNH NÓ (?page=N — không gộp
    // hết về trang 1 làm Google bỏ index trang sau); sort/lọc KHÔNG vào canonical
    // (cùng nội dung, khác thứ tự). Kèm <link rel=prev/next> khi có trang kề.
    let canonical = host ? `https://${host}${url.pathname}` : null; // URL sạch (không kèm query)
    let prevUrl = null, nextUrl = null;
    const pagedPath = (n) => `https://${host}${url.pathname}${n > 1 ? `?page=${n}` : ''}`;
    if (host && data.home && data.pageInfo) {
      const cur = Math.floor(data.pageInfo.offset / data.pageInfo.pageSize) + 1;
      const last = Math.max(1, Math.ceil(data.pageInfo.total / data.pageInfo.pageSize));
      canonical = pagedPath(cur);
      if (cur > 1) prevUrl = pagedPath(cur - 1);
      if (cur < last) nextUrl = pagedPath(cur + 1);
    } else if (host && data.productsPage && data.pageInfo) {
      // /products: canonical giữ ?cat (nội dung khác nhau theo danh mục) + ?page; sort/lọc không vào.
      const cur = Math.floor(data.pageInfo.offset / data.pageInfo.pageSize) + 1;
      const last = Math.max(1, Math.ceil(data.pageInfo.total / data.pageInfo.pageSize));
      const pp = (n) => {
        const parts = [];
        if (data.catSlug) parts.push(`cat=${data.catSlug}`);
        if (n > 1) parts.push(`page=${n}`);
        return `https://${host}/products${parts.length ? `?${parts.join('&')}` : ''}`;
      };
      canonical = pp(cur);
      if (cur > 1) prevUrl = pp(cur - 1);
      if (cur < last) nextUrl = pp(cur + 1);
    } else if (host && data.blog === 'list' && data.blogPage) {
      canonical = pagedPath(data.blogPage.page);
      if (data.blogPage.page > 1) prevUrl = pagedPath(data.blogPage.page - 1);
      if (data.blogPage.page < data.blogPage.last) nextUrl = pagedPath(data.blogPage.page + 1);
    }
    if (data.page) {
      // Preview → banner cảnh báo + no-store/noindex; published → cache CDN như thường.
      if (data.preview) return sendView(200, renderPage(ctx, data.page, { preview: true, canonical }), { shopSlug: data.shop.slug, preview: true, nonce });
      return sendView(200, renderPage(ctx, data.page, { canonical }), { shopSlug: data.shop.slug, cache: true, nonce });
    }
    // Lưới KHÔNG có kết quả nào (shop chưa có hàng, hoặc lọc/danh mục ra rỗng) → cùng lý lẽ
    // với trang chủ: đừng để công cụ tìm kiếm lập chỉ mục một trang trống. pageInfo.total là
    // TỔNG khớp bộ lọc, đã tính sẵn — không tốn truy vấn thêm.
    if (data.productsPage) {
      const trongLuoi = !(data.pageInfo?.total);
      return sendView(200, renderProducts(ctx, { canonical, prevUrl, nextUrl, catSlug: data.catSlug }),
        { shopSlug: data.shop.slug, cache: !trongLuoi, noindex: trongLuoi, nonce });
    }
    if (data.product) return sendView(200, renderProduct(ctx, data.product, { canonical }), { shopSlug: data.shop.slug, cache: true, nonce });
    if (data.blog === 'list') {
      const trongBlog = !(data.posts?.length);
      return sendView(200, renderBlogList(ctx, data.posts ?? [], { canonical, prevUrl, nextUrl, blogPage: data.blogPage ?? null }),
        { shopSlug: data.shop.slug, cache: !trongBlog, noindex: trongBlog, nonce });
    }
    if (data.blog === 'post') return sendView(200, renderBlogPost(ctx, data.post, { canonical }), { shopSlug: data.shop.slug, cache: true, nonce });
    if (data.search) return sendView(200, renderSearch(ctx, { canonical }), { shopSlug: data.shop.slug, nonce });
    // Trang chủ là cửa vào mà công cụ tìm kiếm lập chỉ mục. Danh sách SP đã nạp xong ở trên
    // nên phép kiểm này KHÔNG tốn thêm truy vấn nào.
    //
    // products RỖNG = shop THẬT SỰ chưa có hàng: lưới trang chủ chạy productGrid('', [], 0, N)
    // — KHÔNG bộ lọc nào — và RLS store_products chỉ để lọt SP active chưa xoá. Đã kiểm kỹ chỗ
    // này: noindex NHẦM một shop đang bán là tự tay cắt nguồn khách của họ, tệ hơn hẳn cái nó
    // định phòng.
    const trong = !(ctx.products?.length);
    return sendView(200, renderHome(ctx, { canonical, prevUrl, nextUrl }),
      { shopSlug: data.shop.slug, cache: !trong, noindex: trong, nonce });
  } catch (err) {
    log('error', 'render_error', { path: url.pathname, message: err.message, stack: err.stack });
    if (!res.headersSent) sendHtml(res, 500, renderNotFound());
  }
}));

server.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT }));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(async () => { await db.end().catch(() => {}); process.exit(0); }));
}
