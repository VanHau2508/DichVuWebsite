/**
 * Custom domain tự phục vụ (A5). Owner (perm 'domain.write' + step-up) thêm tên miền riêng;
 * xác minh SỞ HỮU qua DNS TXT (worker tra + đặt verified_at — apps/worker). Chỉ domain đã
 * verified mới được tls-authorize cấp cert + storefront/checkout phục vụ.
 *
 * Gate ở route (dispatcher seller cưỡng chế): mutate = domain.write (CHỈ owner) + stepUp.
 * Đọc (list/get) = perm null (thành viên xem được — challenge token chỉ hữu ích cho ai
 * điều khiển DNS). Cô lập tenant: withTenant(shopId) → RLS tenant_isolation, chỉ domain shop mình.
 */
import crypto from 'node:crypto';
// node:dns/promises — KHÔNG phải node:dns. Resolver của bản callback không trả Promise:
// `await r.resolve4(h)` ném ERR_INVALID_ARG_TYPE (thiếu callback), rơi vào nhánh catch và
// mọi lần kiểm tra đều báo "chưa tra được DNS". Worker cũng dùng bản promises.
import { Resolver, lookup as dnsLookup } from 'node:dns/promises';
import { send } from './http.js';
import { withTenant, audit } from './db.js';
import { normalizeHostname, isReserved, isApex } from './hostname.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? 'nentang.vn';
const VERIFY_PREFIX = process.env.DOMAINVERIFY_PREFIX ?? '_nentang-verify';
const MAX_DOMAINS_PER_SHOP = Number(process.env.MAX_DOMAINS_PER_SHOP ?? 20);
// IP CÔNG KHAI của nền tảng — thứ khách phải trỏ bản ghi A về. Trước đợt này màn hình
// bảo 'trỏ về IP nền tảng' mà KHÔNG chỗ nào nói IP đó là gì → khách bắt buộc phải hỏi
// hỗ trợ. Prod đặt bằng floating IP (ADR-004).
const PLATFORM_IP = process.env.PLATFORM_IP ?? '';
// Khoá tuần tự hoá thao tác primary/revoke theo shop (single-primary an toàn khi đua).
const primaryLock = (c) => c.query(`SELECT pg_advisory_xact_lock(hashtext('domain-primary'), hashtext(current_shop_id()::text))`);
const genToken = () => crypto.randomBytes(32).toString('base64url');

// View cho client: KHÔNG lộ token khi đã verified (không còn cần).
// challenge có HAI đường, khách chọn một:
//   cname — MỘT bản ghi CNAME → subdomain nền tảng của shop (tên miền con, khuyên dùng)
//   type/name/value — bản ghi TXT (kèm bản ghi A), bắt buộc với tên miền GỐC vì apex không
//   đặt được CNAME (ADR-004). Giữ nguyên hình dạng cũ để client cũ không vỡ.
const domainView = (d, cnameTarget = null) => ({
  id: d.id,
  hostname: d.hostname,
  verified: d.verified_at !== null,
  is_primary: d.is_primary,
  created_at: d.created_at,
  apex: isApex(d.hostname),
  challenge: d.verified_at === null
    ? {
      type: 'TXT', name: `${VERIFY_PREFIX}.${d.hostname}`, value: d.verification_token,
      cname: cnameTarget ? { type: 'CNAME', name: d.hostname, value: cnameTarget } : null,
    }
    : null,
});

const SELECT_COLS = 'id, hostname, verification_token, verified_at, is_primary, created_at';
// Đích CNAME = subdomain nền tảng CỦA CHÍNH shop (`<slug>.nentang.vn`, tạo sẵn lúc mở shop).
// Lấy từ chính bảng `domains` bằng ĐÚNG câu worker dùng — chẩn đoán và xác minh phải nói
// cùng một thứ, lệch nhau là khách sửa theo màn hình mà mãi không verified. RLS đã cắt theo
// tenant nên không cần điều kiện shop_id ở đây.
const cnameTargetOf = async (c) => (await c.query(
  `SELECT hostname FROM domains WHERE hostname LIKE '%.' || $1 ORDER BY created_at LIMIT 1`,
  [PLATFORM_DOMAIN])).rows[0]?.hostname ?? null;

async function listDomains(res, ctx) {
  const { rows, target } = await withTenant(ctx.shopId, async (c) => ({
    rows: (await c.query(`SELECT ${SELECT_COLS} FROM domains ORDER BY is_primary DESC, created_at`)).rows,
    target: await cnameTargetOf(c),
  }));
  // platform_ip đi kèm danh sách để màn hình hiện được BẢN GHI A cụ thể. Không có nó thì
  // câu "trỏ về IP nền tảng" là hướng dẫn không làm theo được.
  return send(res, 200, { domains: rows.map((d) => domainView(d, target)), platform_ip: PLATFORM_IP || null });
}

async function getDomain(res, ctx, _b, params) {
  const out = await withTenant(ctx.shopId, async (c) => ({
    d: (await c.query(`SELECT ${SELECT_COLS} FROM domains WHERE id = $1`, [params[1]])).rows[0],
    target: await cnameTargetOf(c),
  }));
  if (!out.d) return send(res, 404, { error: 'không tìm thấy tên miền' });
  return send(res, 200, { domain: domainView(out.d, out.target) });
}

async function addDomain(res, ctx, body) {
  const host = normalizeHostname(body.hostname);
  if (!host) return send(res, 400, { error: 'tên miền không hợp lệ' });
  // Không cho khách "chiếm" tên miền/subdomain của nền tảng (nền tảng sở hữu apex).
  if (isReserved(host, PLATFORM_DOMAIN)) return send(res, 400, { error: 'không thể dùng tên miền của nền tảng' });
  try {
    const d = await withTenant(ctx.shopId, async (c) => {
      // Trần số tên miền/shop → chống một shop CHIẾM hàng loạt hostname (mỗi dòng giữ lock
      // UNIQUE toàn cục; kết hợp worker dọn challenge chết để không khoá vĩnh viễn).
      const n = (await c.query('SELECT count(*)::int AS n FROM domains')).rows[0].n;
      if (n >= MAX_DOMAINS_PER_SHOP) throw Object.assign(new Error(`đã đạt trần ${MAX_DOMAINS_PER_SHOP} tên miền cho cửa hàng`), { statusCode: 409 });
      const r = await c.query(
        `INSERT INTO domains (shop_id, hostname, verification_token, verified_at, is_primary)
         VALUES (current_shop_id(), $1, $2, NULL, false)
         RETURNING ${SELECT_COLS}`, [host, genToken()]);
      await audit(c, 'domain.added', { actorId: ctx.user.id, ip: ctx.ip, metadata: { hostname: host } });
      return { row: r.rows[0], target: await cnameTargetOf(c) };
    });
    return send(res, 201, { domain: domainView(d.row, d.target) });
  } catch (e) {
    if (e.statusCode) return send(res, e.statusCode, { error: e.message });
    // hostname UNIQUE toàn cục — RLS giấu domain shop khác nên pre-check SELECT không thấy;
    // dựa vào ràng buộc UNIQUE (23505) mới đúng. Chỉ lộ "đã đăng ký", không lộ shop nào.
    if (e.code === '23505') return send(res, 409, { error: 'tên miền đã được đăng ký' });
    throw e;
  }
}

// Đặt tên miền CHÍNH — chỉ khi đã verified (chưa verified thì không có cert, primary sẽ vỡ).
async function setPrimary(res, ctx, _b, params) {
  const out = await withTenant(ctx.shopId, async (c) => {
    await primaryLock(c); // tuần tự hoá với setPrimary/revoke khác của shop → không bao giờ 2 primary
    const d = (await c.query('SELECT verified_at FROM domains WHERE id = $1 FOR UPDATE', [params[1]])).rows[0];
    if (!d) return { code: 404 };
    if (d.verified_at === null) return { code: 409, msg: 'tên miền chưa xác minh — không thể đặt làm chính' };
    // Đúng MỘT primary (không có ràng buộc DB) → hạ hết của shop rồi nâng cái này (RLS scoped).
    await c.query('UPDATE domains SET is_primary = false WHERE is_primary');
    await c.query('UPDATE domains SET is_primary = true WHERE id = $1', [params[1]]);
    await audit(c, 'domain.primary_changed', { actorId: ctx.user.id, ip: ctx.ip, metadata: { domainId: params[1] } });
    return { code: 200 };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy tên miền' });
  if (out.code === 409) return send(res, 409, { error: out.msg });
  return send(res, 200, { ok: true });
}

// Gỡ tên miền (DELETE) → storefront/checkout ngừng phục vụ NGAY (đọc verified_at không cache).
// Chặn gỡ subdomain nền tảng + tên miền CHÍNH (shop cần một host + link preview).
async function revokeDomain(res, ctx, _b, params) {
  const out = await withTenant(ctx.shopId, async (c) => {
    await primaryLock(c); // cùng khoá với setPrimary → guard is_primary đọc trạng thái nhất quán
    const d = (await c.query('SELECT hostname, is_primary FROM domains WHERE id = $1 FOR UPDATE', [params[1]])).rows[0];
    if (!d) return { code: 404 };
    if (d.hostname === PLATFORM_DOMAIN || d.hostname.endsWith('.' + PLATFORM_DOMAIN)) return { code: 409, msg: 'không thể gỡ subdomain nền tảng' };
    if (d.is_primary) return { code: 409, msg: 'không thể gỡ tên miền chính — đặt tên miền khác làm chính trước' };
    await c.query('DELETE FROM domains WHERE id = $1', [params[1]]);
    await audit(c, 'domain.revoked', { actorId: ctx.user.id, ip: ctx.ip, metadata: { hostname: d.hostname } });
    return { code: 200 };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy tên miền' });
  if (out.code === 409) return send(res, 409, { error: out.msg });
  return send(res, 200, { ok: true });
}


/**
 * KIỂM TRA NGAY — chẩn đoán DNS cho một tên miền, nói RÕ đang sai chỗ nào.
 *
 * Vì sao cần: trước đợt này màn hình chỉ nói "chờ ~1 phút (tự kiểm)" rồi im lặng. Khách
 * đặt sai một bản ghi thì ngồi chờ mãi mà không biết sai ở đâu — và cuối cùng nhắn cho
 * shop. Đây đúng là loại việc quyết định "khách tự làm được" hay "phải gọi hỗ trợ".
 *
 * CHỈ ĐỌC, KHÔNG đóng dấu verified_at. Việc lật cờ vẫn thuộc worker (vai app_domainverify
 * least-priv). Sweep chạy mỗi 60 giây nên chẩn đoán tức thì là đủ — đổi lấy việc cấp cho
 * app_rw quyền ghi verified_at là mất nhiều hơn được.
 */
const dnsResolver = new Resolver({ timeout: 3000, tries: 2 });
if (process.env.DOMAINVERIFY_RESOLVER) {
  const [rhost, rport] = process.env.DOMAINVERIFY_RESOLVER.split(':');
  dnsLookup(rhost).then(({ address }) => dnsResolver.setServers([rport ? `${address}:${rport}` : address]))
    .catch(() => {});
}
// Trần thô theo shop, giữ trong tiến trình: mỗi lần bấm là một truy vấn DNS RA NGOÀI.
// Không phải chống tấn công (đã sau session + RBAC) — chỉ để một người bấm liên tục không
// biến trang này thành máy bơm truy vấn DNS.
const checkHits = new Map();
function overCheckLimit(shopId) {
  const now = Date.now();
  const cur = checkHits.get(shopId);
  if (checkHits.size > 2000) for (const [k, v] of checkHits) if (now - v.t > 60_000) checkHits.delete(k);
  if (!cur || now - cur.t > 60_000) { checkHits.set(shopId, { t: now, n: 1 }); return false; }
  cur.n += 1;
  return cur.n > 10;
}

async function checkDomain(res, ctx, _b, params) {
  if (overCheckLimit(ctx.shopId)) return send(res, 429, { error: 'kiểm tra quá nhiều lần, đợi một phút rồi thử lại' });
  const out = await withTenant(ctx.shopId, async (c) => ({
    d: (await c.query(`SELECT ${SELECT_COLS} FROM domains WHERE id = $1`, [params[1]])).rows[0],
    target: await cnameTargetOf(c),
  }));
  const d = out.d;
  if (!d) return send(res, 404, { error: 'không tìm thấy tên miền' });
  if (d.verified_at) return send(res, 200, { verified: true, cname: { ok: true }, a: { ok: true }, txt: { ok: true }, message: 'Tên miền đã xác minh và đang hoạt động.' });

  // ── Cách 1: bản ghi CNAME (một bản ghi, chỉ tên miền con) ──────────────────
  // Kiểm TRƯỚC vì đây là đường ta khuyên: đúng cái này thì hai bản ghi kia không cần nữa.
  let cname = { ok: false, found: [], reason: out.target ? 'unknown' : 'no_target' };
  if (out.target) {
    const want = out.target.toLowerCase();
    try {
      const names = (await dnsResolver.resolveCname(d.hostname)).map((n) => String(n).replace(/\.$/, '').toLowerCase());
      cname.found = names;
      cname.ok = names.includes(want);
      cname.reason = cname.ok ? 'ok' : 'wrong_target';
    } catch (e) {
      cname.reason = (e.code === 'ENOTFOUND' || e.code === 'ENODATA') ? 'missing' : 'dns_error';
    }
  }

  // ── Bản ghi A ──────────────────────────────────────────────────────────────
  // Nói RA con số đang thấy, không chỉ "sai". "Đang trỏ về 103.1.2.3, cần 14.5.6.7" là
  // thứ khách sửa được ngay; "chưa đúng" thì họ chỉ biết mở ticket.
  let a = { ok: false, found: [], reason: 'unknown' };
  try {
    const ips = await dnsResolver.resolve4(d.hostname);
    a.found = ips;
    if (!PLATFORM_IP) a = { ...a, ok: false, reason: 'platform_ip_missing' };
    else if (ips.includes(PLATFORM_IP)) a = { ...a, ok: true, reason: 'ok' };
    else a = { ...a, ok: false, reason: 'wrong_ip' };
  } catch (e) {
    // ENOTFOUND/ENODATA = chưa có bản ghi nào. Phân biệt với lỗi mạng để lời nhắn đúng.
    a.reason = (e.code === 'ENOTFOUND' || e.code === 'ENODATA') ? 'missing' : 'dns_error';
  }

  // ── Bản ghi TXT (chứng minh sở hữu) ────────────────────────────────────────
  let txt = { ok: false, found: [], reason: 'unknown' };
  try {
    const rows = await dnsResolver.resolveTxt(`${VERIFY_PREFIX}.${d.hostname}`);
    // resolveTxt trả string[][] (mỗi bản ghi là mảng chunk 255-byte) → nối rồi so khớp.
    const vals = rows.map((chunks) => chunks.join(''));
    txt.found = vals.map((v) => (v.length > 12 ? `${v.slice(0, 12)}…` : v)); // đủ để đối chiếu, không đổ nguyên token vào log
    txt.ok = vals.includes(d.verification_token);
    txt.reason = txt.ok ? 'ok' : 'mismatch';
  } catch (e) {
    txt.reason = (e.code === 'ENOTFOUND' || e.code === 'ENODATA') ? 'missing' : 'dns_error';
  }

  // Lời nhắn TIẾNG VIỆT, đúng một câu nói được phải làm gì tiếp.
  const MSG_A = {
    ok: null,
    missing: `Chưa thấy bản ghi A cho ${d.hostname}. Thêm bản ghi A trỏ về ${PLATFORM_IP || '(chưa cấu hình IP nền tảng)'} tại nơi bạn mua tên miền.`,
    wrong_ip: `Tên miền đang trỏ về ${a.found.join(', ')} — cần trỏ về ${PLATFORM_IP}.`,
    dns_error: 'Chưa tra được DNS (có thể nhà cung cấp đang cập nhật). Thử lại sau vài phút.',
    platform_ip_missing: 'Nền tảng chưa cấu hình IP công khai — báo giúp bộ phận hỗ trợ.',
    unknown: 'Chưa kiểm tra được bản ghi A.',
  };
  const MSG_TXT = {
    ok: null,
    missing: `Chưa thấy bản ghi TXT tại ${VERIFY_PREFIX}.${d.hostname}. Thêm đúng giá trị hiện trên màn hình này.`,
    mismatch: 'Bản ghi TXT có rồi nhưng giá trị chưa khớp — chép lại đúng chuỗi trên màn hình (không thêm dấu cách).',
    dns_error: 'Chưa tra được bản ghi TXT (có thể nhà cung cấp đang cập nhật). Thử lại sau vài phút.',
    unknown: 'Chưa kiểm tra được bản ghi TXT.',
  };
  // Lời nhắn TIẾNG VIỆT, đúng một câu nói được phải làm gì tiếp. Thứ tự có chủ ý:
  //   1. CNAME đúng → xong, đừng bắt khách nhìn tiếp hai bản ghi họ không cần.
  //   2. CNAME SAI đích → họ rõ ràng đang đi đường CNAME, nói đúng đường đó.
  //   3. còn lại → hướng dẫn A + TXT (bắt buộc với tên miền gốc).
  const steps = [MSG_A[a.reason], MSG_TXT[txt.reason]].filter(Boolean);
  // Tên miền GỐC không đặt được CNAME (ADR-004) → đừng gợi ý thứ họ không làm được.
  const cnameHint = (!isApex(d.hostname) && out.target && cname.reason === 'missing')
    ? ` Cách nhanh hơn cho tên miền con: bỏ cả hai bản ghi trên, chỉ đặt MỘT bản ghi CNAME ${d.hostname} → ${out.target}.`
    : '';
  let message;
  if (cname.ok || (a.ok && txt.ok)) {
    // Đúng rồi nhưng chưa verified: worker sẽ lật cờ ở nhịp sau (≤60s). Nói rõ để khách
    // không bấm lại liên tục tưởng hỏng.
    message = cname.ok
      ? 'Bản ghi CNAME đã đúng. Hệ thống sẽ kích hoạt tên miền trong vòng 1 phút.'
      : 'Hai bản ghi đều đúng. Hệ thống sẽ kích hoạt tên miền trong vòng 1 phút.';
  } else if (cname.reason === 'wrong_target') {
    message = `Bản ghi CNAME đang trỏ về ${cname.found.join(', ')} — cần trỏ về ${out.target}.`;
  } else {
    message = steps.join(' ') + cnameHint;
  }
  return send(res, 200, { verified: false, cname, a, txt, cname_target: out.target, message });
}

export const DOMAIN_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/domains$`), perm: null, fn: (res, ctx) => listDomains(res, ctx) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/domains$`), perm: 'domain.write', stepUp: true, fn: (res, ctx, b) => addDomain(res, ctx, b) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/domains/${UUID}$`), perm: null, fn: (res, ctx, b, p) => getDomain(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/domains/${UUID}/primary$`), perm: 'domain.write', stepUp: true, fn: (res, ctx, b, p) => setPrimary(res, ctx, b, p) },
  { m: 'DELETE', re: new RegExp(`^/shops/${UUID}/domains/${UUID}$`), perm: 'domain.write', stepUp: true, fn: (res, ctx, b, p) => revokeDomain(res, ctx, b, p) },
  // CHỈ ĐỌC (tra DNS, không ghi gì) → perm null như các route đọc khác, KHÔNG step-up:
  // bắt xác thực lại chỉ để xem "tôi đặt DNS đúng chưa" là đúng kiểu rào cản khiến người
  // ta bỏ cuộc và nhắn cho hỗ trợ — đúng thứ nút này sinh ra để tránh.
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/domains/${UUID}/check$`), perm: null, fn: (res, ctx, b, p) => checkDomain(res, ctx, b, p) },
];
