/**
 * E2E CỤM "NGÀY THỨ 60" — bảy chỗ chỉ đau khi shop đã bán được hai tháng (docs/64).
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-ngay60.e2e.mjs
 *
 * VÌ SAO CÓ BỘ NÀY. Cả bảy lỗi đều VÔ HÌNH ở ngày 1: 5 đơn thì không ai cần chọn-tất-cả, 3 sản
 * phẩm thì cột Tồn tổng CHÍNH LÀ sự thật, một trang thì không có gì để mất bộ lọc. Chúng chỉ
 * hiện ra khi có 200 SP / 400 đơn — nên bộ này tự dựng đủ dữ liệu để chạm vào từng cái.
 *
 * Cái đắt nhất là GIAO HÀNG LOẠT: trước đây 26 đơn = 26 lần mở trang + gõ tay mã vận đơn
 * ≈ 12 phút mỗi sáng, ~5-6 giờ mỗi tháng, gần như toàn bộ là lặp máy móc.
 */
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const inviteTokenOf = async (e) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [e]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', BOLD = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${String(d).slice(0, 200)}${X}`); };
const sect = (m) => console.log(`\n${BOLD}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };

async function rq(base, method, path, { body, cookie, origin } = {}) {
  const h = {}; if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin; if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, raw: t, sc: r.headers.getSetCookie() };
}
async function adm(method, path, { cookie, form } = {}) {
  const h = {}; if (form !== undefined) h['content-type'] = 'application/x-www-form-urlencoded';
  h.origin = OADM; if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(ADMIN + path, { method, headers: h, redirect: 'manual', body: form !== undefined ? String(form) : undefined });
  return { status: r.status, loc: r.headers.get('location'), body: await r.text(), sc: r.headers.getSetCookie() };
}
const login = async (e, p) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email: e, password: p }, origin: OA })).sc);
const uidOf = async (e) => (await owner.query('SELECT id FROM users WHERE email=$1', [e])).rows[0]?.id ?? null;

async function makeStaff() {
  const email = `staff-${uniq()}@nentang.vn`, password = 'staff strong passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let c = await login(email, password);
  const en = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie: c, origin: OA });
  const key = base32Decode(en.json.secret);
  await rq(AUTH, 'POST', '/auth/mfa/activate', { cookie: c, body: { code: totp(key, {}) }, origin: OA });
  const c0 = counterFor(Date.now());
  await owner.query(`INSERT INTO platform_staff (user_id,role) VALUES ($1,'admin')`, [await uidOf(email)]);
  while (counterFor(Date.now()) <= c0) await sleep(1000);
  c = await login(email, password);
  return ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie: c, body: { code: totp(key, {}) }, origin: OA })).sc) ?? c;
}

async function main() {
  const staff = await makeStaff();
  const slug = `n60-${uniq()}`;
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO });
  const shopId = r.json.id;
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  const oc = await login(oe, op);
  const ac = ck((await adm('POST', '/login', { form: new URLSearchParams({ email: oe, password: op }) })).sc);
  const S = {
    get: (p) => rq(SELLER, 'GET', `/shops/${shopId}${p}`, { cookie: oc }),
    post: (p, b) => rq(SELLER, 'POST', `/shops/${shopId}${p}`, { body: b, cookie: oc, origin: OS }),
    patch: (p, b) => rq(SELLER, 'PATCH', `/shops/${shopId}${p}`, { body: b, cookie: oc, origin: OS }),
  };
  const A = (p, o) => adm('GET', `/shops/${shopId}${p}`, { cookie: ac, ...o });
  ac ? ok('dựng shop + đăng nhập cả API lẫn trang quản trị') : bad('không đăng nhập được quản trị', '');
  // Nới trần chống-đơn-ảo: một máy đóng vai 25 khách sẽ đụng trần và bộ này đo nhầm cơ chế.
  await S.patch('', { name: slug, max_pending_per_phone: 999, max_pending_per_ip: 999 });

  // ── HIỆN TRƯỜNG: 1 SP nhiều biến thể (1 size hết) + 25 đơn ────────────────
  const pr = await S.post('/products', {
    title: 'Áo thun ngày 60', slug: `ao-${uniq()}`, price_vnd: 150000, status: 'active',
    variants: [{ sku: `A-${uniq()}`, price_vnd: 150000, title: 'S' }, { sku: `B-${uniq()}`, price_vnd: 150000, title: 'M' }, { sku: `C-${uniq()}`, price_vnd: 150000, title: 'L' }],
  });
  const vs = (await S.get(`/products/${pr.json.id}`)).json.variants;
  await S.post(`/variants/${vs[0].id}/inventory/adjust`, { delta: 300, reason: 'nhập' });
  await S.post(`/variants/${vs[1].id}/inventory/adjust`, { delta: 200, reason: 'nhập' });
  // Biến thể thứ ba CỐ Ý để tồn 0 → tổng vẫn 500, nhưng khách chọn size L là mất đơn.
  const sdt = () => `09${Math.floor(10000000 + Math.random() * 89999999)}`;
  const donIds = [];
  for (let i = 0; i < 25; i++) {
    const o = await S.post('/orders', {
      lines: [{ variant_id: vs[i % 2].id, qty: 1 }],
      customer: { name: `Khách ${i}`, phone: sdt(), address_line: '1 Lê Lợi', province: 'Hà Nội' },
      payment_method: 'cod', idempotency_key: `n60-${uniq()}`,
    });
    if (o.status === 201) donIds.push(o.json.id);
  }
  donIds.length === 25 ? ok('dựng 25 đơn + 1 SP ba size (size L tồn 0, tổng vẫn 500)') : bad(`chỉ dựng được ${donIds.length}/25 đơn`, '');

  // ── #3 CỘT TỒN PHẢI LỘ SIZE ĐÃ HẾT ────────────────────────────────────────
  sect('#3 Cột Tồn không được giấu size đã hết');
  const dsSP = await A('/products');
  /500/.test(dsSP.body) ? ok('cột Tồn vẫn hiện tổng 500 (số thật, không đổi ý nghĩa)') : bad('mất con số tổng', '');
  /1 loại hết/.test(dsSP.body)
    ? ok('và có nhãn "1 loại hết" ngay cạnh — nhìn danh sách là biết, không phải mở từng SP')
    : bad('cột Tồn vẫn giấu biến thể hết hàng', dsSP.body.match(/class="stock[\s\S]{0,160}/)?.[0]);

  // ── #5 BỘ LỌC KHÔNG ĐƯỢC RƠI KHI BẤM TAB / TÌM ───────────────────────────
  sect('#5 Bộ lọc sắp-hết-hàng phải đi theo mọi đường rời trang');
  const low = await A('/products?stock=low');
  /[?&]stock=low/.test((low.body.match(/href="\?status=active[^"]*"/) ?? [''])[0])
    ? ok('link tab "Đang bán" mang theo stock=low') : bad('tab làm rơi bộ lọc — số trên nút nói một đằng, bấm vào ra một nẻo', (low.body.match(/href="\?status=active[^"]*"/) ?? [''])[0]);
  /name="stock" value="low"/.test(low.body) ? ok('ô "Tìm theo tên" mang theo stock=low') : bad('ô tìm làm rơi bộ lọc', '');

  // ── #4 + #6 CHỌN TẤT CẢ + SỐ DÒNG MỖI TRANG ──────────────────────────────
  sect('#4/#6 Chọn tất cả trên trang Đơn · chọn số dòng');
  const d20 = await A('/orders?status=pending');
  /data-bulk-all="order_ids"/.test(d20.body)
    ? ok('trang Đơn có ô "chọn tất cả" (trang Sản phẩm vốn đã có)') : bad('vẫn phải tích tay từng ô', '');
  const dem = (b) => (b.match(/name="order_ids" value=/g) ?? []).length;
  dem(d20.body) === 20 ? ok('mặc định 20 dòng') : bad(`mặc định ${dem(d20.body)} dòng`, '');
  const d50 = await A('/orders?status=pending&limit=50');
  dem(d50.body) === 25 ? ok('limit=50 → 25 đơn chờ hiện HẾT trong một trang (không phải làm hai lượt)') : bad(`limit=50 ra ${dem(d50.body)} dòng`, '');
  const dRac = await A('/orders?status=pending&limit=99999');
  dem(dRac.body) === 20 ? ok('limit rác (99999) → về 20, không cho quét sâu') : bad(`limit rác ra ${dem(dRac.body)} dòng`, '');
  /limit=50/.test(d20.body) && /limit=100/.test(d20.body) ? ok('có link chọn 20/50/100') : bad('không có chỗ chọn số dòng', '');

  // ── #2 GIAO HÀNG LOẠT ─────────────────────────────────────────────────────
  sect('#2 Giao hàng loạt — việc đắt nhất của buổi sáng');
  const ids = [...d50.body.matchAll(/name="order_ids" value="([0-9a-f-]{36})"/g)].map((m) => m[1]);
  const form = (extra) => { const f = new URLSearchParams(); ids.forEach((i) => f.append('order_ids', i)); for (const [k, v] of Object.entries(extra)) f.set(k, v); return f; };
  // Chưa xác nhận thì KHÔNG được giao — bỏ qua hết, không đổi gì.
  let rr = await adm('POST', `/shops/${shopId}/orders/bulk-ship`, { cookie: ac, form: form({ status: 'pending', limit: '50' }) });
  const conCho = Number((await owner.query(`SELECT count(*)::int n FROM orders WHERE shop_id=$1 AND status='pending'`, [shopId])).rows[0].n);
  rr.status === 303 && /bulkship_ok=0/.test(rr.loc ?? '') && conCho === 25
    ? ok('đơn CHƯA xác nhận → bỏ qua hết, không đơn nào bị đẩy sang đang giao')
    : bad(`giao nhầm đơn chưa xác nhận (loc=${rr.loc}, còn chờ ${conCho})`, '');
  // Xác nhận hàng loạt rồi giao hàng loạt.
  await adm('POST', `/shops/${shopId}/orders/bulk-confirm`, { cookie: ac, form: form({ status: 'pending', limit: '50' }) });
  const t0 = Date.now();
  rr = await adm('POST', `/shops/${shopId}/orders/bulk-ship`, { cookie: ac, form: form({ status: 'confirmed', limit: '50' }) });
  const ms = Date.now() - t0;
  const sau = (await owner.query(`SELECT count(*) FILTER (WHERE status='shipped') s, count(*) FILTER (WHERE status='confirmed') c FROM orders WHERE shop_id=$1`, [shopId])).rows[0];
  Number(sau.s) === 25 && Number(sau.c) === 0
    ? ok(`25 đơn sang "đang giao" trong ${ms}ms bằng MỘT lần bấm (trước: 25 lần mở trang + gõ tay mã vận đơn)`)
    : bad(`giao hàng loạt sai: shipped=${sau.s} confirmed=${sau.c}`, rr.loc);
  // Bất biến kho: mỗi kiện phải tiêu tồn và ghi ĐÚNG một dòng sổ cái.
  const lech = Number((await owner.query(
    `SELECT count(*)::int n FROM (SELECT il.variant_id, il.on_hand, coalesce(sum(g.delta),0) sc
       FROM inventory_levels il JOIN variants v ON v.id=il.variant_id
       LEFT JOIN inventory_ledger g ON g.variant_id=il.variant_id
      WHERE v.shop_id=$1 GROUP BY 1,2) y WHERE on_hand <> sc`, [shopId])).rows[0].n);
  lech === 0 ? ok('tồn kho vẫn khớp sổ cái từng dòng (giao hàng loạt không làm lệch kho)') : bad(`${lech} biến thể lệch sổ cái`, '');
  const treo = Number((await owner.query(`SELECT count(*)::int n FROM shipments WHERE shop_id=$1 AND status='created'`, [shopId])).rows[0].n);
  treo === 0 ? ok('không để lại vận đơn treo ở trạng thái "created" (vòng quét dọn-claim-chết không đụng tới)') : bad(`${treo} vận đơn treo`, '');

  // ── #7 QUAY VỀ ĐÚNG TAB + BÁO ĐÃ XONG ────────────────────────────────────
  sect('#7 Làm xong phải quay về đúng chỗ và nói ra kết quả');
  /status=confirmed/.test(rr.loc ?? '') && /limit=50/.test(rr.loc ?? '')
    ? ok('quay về ĐÚNG tab + số dòng đang xem (không bị đá về "Tất cả")') : bad(`quay về sai chỗ: ${rr.loc}`, '');
  const sauTrang = await adm('GET', rr.loc, { cookie: ac });
  /Đã chuyển sang đang giao 25 đơn/.test(sauTrang.body)
    ? ok('trang hiện dòng "✓ Đã chuyển sang đang giao 25 đơn."') : bad('không có chữ nào nói máy đã làm gì', (sauTrang.body.match(/class="ok"[^<]*<?[^<]*/) ?? [''])[0]);
  // Bẫy đã vấp: q.get() vắng trả null, Number(null)=0 → nhánh đầu luôn thắng và mọi thao tác
  // đều báo "Đã xác nhận 0 đơn". Ca này canh đúng chỗ đó.
  !/Đã xác nhận 0 đơn/.test(sauTrang.body)
    ? ok('KHÔNG báo nhầm "Đã xác nhận 0 đơn" (tham số vắng ≠ số 0)') : bad('báo nhầm loại thao tác', '');
  const sach = await adm('GET', `/shops/${shopId}/orders`, { cookie: ac });
  !/class="ok"/.test(sach.body) ? ok('vào trang bình thường thì KHÔNG hiện dòng báo cũ') : bad('dòng báo dính lại', '');

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
