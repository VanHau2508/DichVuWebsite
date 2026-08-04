/**
 * Observability dùng chung (BẢN SAO mỗi service — service không share packages/ vì
 * build context bó hẹp trong thư mục app). Giữ đồng bộ giữa các service.
 *
 *   - request-id (correlation): lấy từ header `x-request-id` nếu hợp lệ, else sinh mới;
 *     lưu trong AsyncLocalStorage → log() tự gắn `rid` không cần luồn tham số qua mọi hàm.
 *   - makeLog(service): JSON log thống nhất ts + service + rid + event.
 *   - health(): /livez, /healthz (tiến trình sống, KHÔNG phụ thuộc) vs /readyz (DB/Redis
 *     gọi được — 503 nếu hỏng). Giữ /healthz để healthcheck compose/Caddy không đổi.
 *   - ĐO LUỒNG DÙNG (0141): đếm (service, mẫu-route, shop, ngày) vào Redis. Xem setUsageSink.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';

const als = new AsyncLocalStorage();
const RID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Nơi nhận số đếm lượt dùng. Service tự cắm ở lúc khởi động (một dòng) vì obs.js không có — và
 * KHÔNG NÊN có — client Redis của riêng nó. Không cắm thì runReq chạy y như trước 0141.
 */
let usageSink = null;
export function setUsageSink(fn) { usageSink = typeof fn === 'function' ? fn : null; }

/**
 * Chạy handler trong ngữ cảnh có request-id; đặt header phản hồi để bên gọi lần vết.
 *
 * Đếm lượt dùng ở sự kiện `finish` chứ không phải lúc vào: lúc đó mới biết ĐỦ ba thứ — mã
 * trạng thái (bỏ 404/429, chúng nói về đường KHÔNG tồn tại), shop (nhiều service phân giải
 * shop theo Host, mãi trong handler mới có — xem noteShop), và request đã thực sự chạy xong.
 */
export function runReq(req, res, handler) {
  const h = req.headers['x-request-id'];
  const id = (typeof h === 'string' && RID_RE.test(h)) ? h : crypto.randomUUID();
  res.setHeader('x-request-id', id);
  const store = { id, shopId: null };
  if (usageSink) {
    // once: `finish` chỉ bắn một lần, nhưng đăng ký lặp trên cùng res (retry nội bộ) thì
    // không. Nuốt MỌI lỗi: đo đạc không bao giờ được làm hỏng một request thật.
    res.once('finish', () => { try { usageSink(req, res, store); } catch { /* fail-open */ } });
  }
  return als.run(store, () => handler());
}

/**
 * Gắn shop cho request hiện tại. Service phân giải shop theo TÊN MIỀN (storefront, checkout)
 * gọi một dòng này ngay khi biết shop; service có shop trong đường dẫn thì routeTemplate()
 * đã tự rút ra rồi, không cần gọi.
 */
export function noteShop(shopId) {
  const s = als.getStore();
  if (s && typeof shopId === 'string') s.shopId = shopId;
}

/**
 * "Request này KHÔNG phải ai đó dùng một tính năng — đừng đếm."
 *
 * VÌ SAO CẦN. Bộ lọc mặc định bỏ 404 (đường không tồn tại) và 429. Nhưng vài service THOÁT SỚM
 * bằng CHUYỂN HƯỚNG, TRƯỚC khi khớp route — và lúc đó lá chắn 404 không bao giờ chạy:
 *   · seller-admin: chưa đăng nhập → 303 về /login cho MỌI đường dẫn
 *   · storefront:   ?ref=… → 302 bỏ tham số, cho MỌI đường dẫn
 *   · storefront:   tên miền phụ → 301 về tên miền chính, cho MỌI đường dẫn
 * Hậu quả đã đo được bằng request thật: `GET /wp-login.php` và `GET /.env` của bot dò vào THẲNG
 * bảng feature_usage thành ô riêng — mỗi URL rác một ô. Trần 5.000 ô/ngày/service (FU_MAX_FIELDS)
 * vì thế bị một đợt quét bot ăn hết, và từ lúc đó mọi route thật LẦN ĐẦU xuất hiện trong ngày
 * rơi vào ô `:over`. (Route đã có ô từ trước vẫn đếm đúng — Lua chỉ dồn ô MỚI.)
 *
 * Đánh dấu ở NƠI THOÁT, không đoán ở tầng đếm: chỉ chỗ viết ra câu lệnh thoát mới biết chắc
 * "đây không phải một lượt dùng".
 */
export function skipUsage() {
  const s = als.getStore();
  if (s) s.skipUsage = true;
}

/**
 * Đổi TÊN SERVICE cho riêng request này. Một tiến trình có thể phục vụ hai sản phẩm khác nhau:
 * storefront chạy cả trang bán hàng của shop LẪN trang marketing nentang.vn. Không tách thì
 * '/', '/blog', '/blog/:slug', '/sitemap.xml' của hai bên gộp làm một — và câu "blog của người
 * bán có ai đọc không" bị cộng thêm lượt đọc bài marketing của chính nền tảng.
 */
export function noteService(name) {
  const s = als.getStore();
  if (s && typeof name === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(name)) s.service = name;
}

/** request-id hiện tại (null nếu gọi ngoài request). */
export const requestId = () => als.getStore()?.id ?? null;

const UUID_SEG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Đường công khai có SLUG do người bán tự đặt → cardinality vô hạn nếu giữ nguyên. Danh sách
// này là các tiền tố CÓ THẬT trong storefront/checkout; cái nào sót thì trần route ở dưới đỡ.
//
// KHÔNG có 'products'. Storefront chỉ có /products (DANH SÁCH, không tham số) — chi tiết SP đi
// qua /p/:slug. Nhưng seller và seller-admin có cả rổ đường TĨNH dưới /products/: /new, /import,
// /bulk-status, /bulk/status… Để 'products' ở đây là biến MỌI đoạn tĩnh đó thành ':slug' rồi gộp
// chúng làm MỘT dòng: bộ NHẬP CSV (di cư từ sàn khác, docs/45) đếm chung với trang "thêm sản
// phẩm" — tính năng đắt tiền có thể chết hẳn mà con số vẫn to. Đã đo bằng node -e.
const SLUG_PREFIX = new Set(['p', 'c', 'pages', 'blog']);

/**
 * Biến đường dẫn thật thành MẪU route ổn định. Đây là chỗ quyết định bảng 0141 có dùng được
 * hay không: lọt một id thật là bảng nổ theo số shop và mọi phép gộp thành vô nghĩa.
 *
 *   /shops/9f3c…/inventory/safety → /shops/:id/inventory/safety
 *   /p/ao-thun-trang              → /p/:slug
 *   /orders/12345                 → /orders/:n
 *
 * Trả về { route, shopId }: shopId rút luôn từ `/shops/<uuid>/…` để service có shop trong
 * đường dẫn (seller, seller-admin, platform) không phải sửa một dòng nào.
 */
export function routeTemplate(pathname) {
  const raw = String(pathname ?? '/').split('?')[0];
  const parts = raw.split('/').filter(Boolean);
  let shopId = null;
  const out = [];
  for (let i = 0; i < parts.length && i < 8; i++) {   // sâu quá 8 tầng là không có thật
    const seg = parts[i];
    if (UUID_SEG.test(seg)) {
      if (i > 0 && parts[i - 1] === 'shops' && !shopId) shopId = seg.toLowerCase();
      out.push(':id');
    } else if (i > 0 && SLUG_PREFIX.has(parts[i - 1].toLowerCase())) {
      // XÉT TRƯỚC luật số: SLUG_RE của seller (catalog.js) cho phép slug TOÀN SỐ — shop đặt tên
      // sản phẩm theo mã ('1234') là chuyện thường. Nếu luật số chạy trước thì '/p/1234' ra
      // '/p/:n' còn '/p/ao-thun' ra '/p/:slug': MỘT endpoint đẻ HAI mẫu, gộp kiểu gì cũng lệch.
      // .toLowerCase() BẮT BUỘC: nhánh giữ-nguyên bên dưới đã hạ chữ thường, nên so khớp đoạn
      // THÔ ở đây thì '/P/ao-thun-nam' (link cũ, người gõ tay) trượt luật :slug và mẫu mang ĐÚNG
      // slug sản phẩm → bảng nổ theo SỐ SẢN PHẨM. Hai chỗ phải dùng cùng một chuẩn hoá.
      out.push(':slug');
    } else if (/^\d+$/.test(seg)) {
      out.push(':n');
    } else if (/^[A-Za-z0-9._-]{1,40}$/.test(seg)) {
      out.push(seg.toLowerCase());
    } else {
      out.push(':x');    // ký tự lạ / quá dài → gom một rọ, không để rác vào bảng
    }
  }
  // TRẦN ĐỘ DÀI. 8 đoạn × 40 ký tự = 328 > CHECK 160 của feature_usage. Vượt CHECK thì INSERT
  // ném lỗi, mà worker gộp CẢ LÔ trong MỘT lệnh → một đường dẫn dài làm mất số đếm của toàn bộ
  // service đó trong chu kỳ. Cắt ở đây, tại nguồn. (Bộ usage-route.test.js bắt đúng lỗi này.)
  let route = '/' + out.join('/');
  if (route.length > 150) route = route.slice(0, 147) + '/:x';
  return { route, shopId };
}

/** Log JSON thống nhất: ts + service + rid (nếu có) + level + event + fields. */
export function makeLog(service) {
  return (level, event, fields = {}) => {
    const rid = requestId();
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, service, ...(rid ? { rid } : {}), event, ...fields }) + '\n');
  };
}

// Một EVAL duy nhất: kiểm trần + HINCRBY + EXPIRE nguyên tử, một vòng mạng. Không await ở chỗ
// gọi → Redis chậm/chết cũng không làm chậm request; mất số đếm thì thôi (fail-open, y như
// rate-limit và lượt xem SP 0098).
//
// TRẦN SỐ Ô: một đường dẫn lạ (bot dò, đường tôi quên chuẩn hoá) có thể đẻ ô mới vô hạn. Chạm
// trần thì dồn hết vào một ô `:over` — con số vẫn nói thật "có thứ tôi không phân loại được",
// thay vì âm thầm nuốt hoặc âm thầm phình.
const FU_LUA = [
  "if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0",
  "   and redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[2]) then",
  "  redis.call('HINCRBY', KEYS[1], ':over|-', 1)",
  "else",
  "  redis.call('HINCRBY', KEYS[1], ARGV[1], 1)",
  "end",
  "redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))",
  'return 1',
].join(' ');
const FU_TTL = 3 * 86400;      // lưới an toàn: worker chết vài ngày thì khoá tự tan, không rác
const FU_MAX_FIELDS = 5000;
// Đường KHÔNG đếm: health (load balancer gọi mỗi vài giây → át hết số liệu thật) và tài
// nguyên tĩnh (không phải "tính năng ai đó dùng").
// `fonts` có mặt vì mỗi lượt tải trang đầu kéo 3-9 tệp phông; không loại thì bảng xếp hạng
// "dùng nhiều nhất" của seller-admin do tệp phông đứng đầu chứ không phải tính năng nào.
const FU_SKIP = /^\/(livez|healthz|readyz|favicon\.ico|robots\.txt|assets|static|fonts)\b/;

/**
 * Dựng nơi nhận số đếm cho một service. Dùng ở lúc khởi động:
 *   setUsageSink(makeUsageSink('seller', redis));
 * `redis` vắng (env không có REDIS_URL) → trả null → runReq chạy y như trước.
 *
 * GIỚI HẠN QUY MÔ ĐÃ BIẾT: grain là (route × shop) nên số ô ≈ số route × số shop. Vài trăm
 * shop thì thoải mái; tới hàng nghìn phải đổi sang đếm xấp xỉ (HyperLogLog) cho phần "bao
 * nhiêu shop dùng". Ghi ra đây để lúc đó không ai phải đoán vì sao nó chậm.
 */
export function makeUsageSink(service, redis) {
  if (!redis) return null;
  return (req, res, store) => {
    if (store?.skipUsage) return;      // thoát sớm TRƯỚC khi khớp route — xem skipUsage()
    const status = res.statusCode ?? 0;
    // 404 nói về đường KHÔNG tồn tại, 429 nói về rate-limit — cả hai không phải "ai đó dùng
    // tính năng này". 5xx thì CÓ đếm: người dùng đã cố dùng, hỏng là chuyện khác.
    if (status === 404 || status === 429) return;
    const path = String(req.url ?? '/').split('?')[0];
    if (FU_SKIP.test(path)) return;
    const { route, shopId } = routeTemplate(path);
    const method = String(req.method ?? 'GET').toUpperCase();
    const shop = shopId ?? store?.shopId ?? '-';
    const svc = store?.service ?? service;   // một tiến trình có thể phục vụ hai sản phẩm
    // Ngày theo GIỜ VN (+07) — khớp mốc ngày của báo cáo/dashboard, không lệch 1 ngày.
    const day = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
    const field = `${method} ${route}|${shop}`;
    redis.eval(FU_LUA, 1, `fu:${day}:${svc}`, field, String(FU_MAX_FIELDS), String(FU_TTL)).catch(() => {});
  };
}

/**
 * Xử lý đường sức khoẻ. `checks` = { tên: async () => {... throw nếu hỏng} }.
 *   /livez, /healthz → 200 (tiến trình sống, KHÔNG chạm phụ thuộc — DB sập vẫn 200).
 *   /readyz          → 200 nếu MỌI check ok, else 503 (kèm chi tiết từng check).
 * Mỗi check có TIMEOUT (mặc định 2s): probe phải trả lời nhanh cho load balancer, không
 * treo khi phụ thuộc kẹt (vd DNS 'postgres' không phân giải → getaddrinfo retry vài giây).
 * Trả true nếu đã xử lý (là đường health), false nếu không phải.
 */
export async function health(pathname, res, checks = {}, timeoutMs = 2000) {
  if (pathname === '/livez' || pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end('{"ok":true}');
    return true;
  }
  if (pathname === '/readyz') {
    const out = {};
    let ready = true;
    for (const [name, fn] of Object.entries(checks)) {
      const p = Promise.resolve().then(fn);
      p.catch(() => {}); // nuốt rejection MUỘN (sau khi timeout thắng) → không unhandledRejection
      let timer;
      try {
        await Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), timeoutMs); timer.unref?.(); })]);
        out[name] = 'ok';
      } catch { out[name] = 'fail'; ready = false; }
      finally { clearTimeout(timer); }
    }
    res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ready, checks: out }));
    return true;
  }
  return false;
}
