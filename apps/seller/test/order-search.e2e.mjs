/**
 * E2E Ô TÌM ĐƠN — người bán dán số điện thoại từ Zalo/Facebook, hoặc chép mã đơn từ màn hình.
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/order-search.e2e.mjs
 *
 * VÌ SAO CÓ BỘ NÀY. Tìm ra từ việc tự đóng vai chủ shop đã bán 2 tháng (docs/64). Ô tìm trước đây
 * so SĐT bằng ILIKE THÔ, nên chỉ ăn số viết liền. Nhưng người bán KHÔNG gõ số — họ BÔI ĐEN VÀ DÁN
 * từ tin nhắn, mà Zalo hiện "0910.395.950" còn Facebook trả "+84910395950". Dán vào thì màn hình
 * nói "Không tìm thấy đơn nào khớp bộ lọc" — y hệt câu nó nói khi khách thật sự chưa từng mua.
 *
 * Đó là kiểu hỏng tệ nhất: nó KHÔNG báo lỗi. Nhân viên mới tin luôn và trả lời khách "bên em
 * không có đơn nào của anh/chị" — trong khi khách đó có 6 đơn, đã chi 11,4 triệu.
 *
 * Tương tự với mã đơn: mọi màn hình đều in "#183" (danh sách, tiêu đề trang, phiếu in), nhưng
 * chép đúng cái phần mềm đang hiện ra thì lại ra 0 kết quả.
 *
 * canon_phone() có sẵn từ 0137 và app_rw đã có quyền EXECUTE — công cụ nằm sẵn đó, chỉ là ô tìm
 * đơn không dùng. Đây là dạng lỗi "đã có lời giải ở chỗ khác trong cùng repo".
 */
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const inviteTokenOf = async (e) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [e]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${String(d).slice(0, 180)}${X}`); };
const sect = (m) => console.log(`\n${B}${m}${X}`);
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
  const slug = `tim-${uniq()}`;
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO });
  const shopId = r.json.id;
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  const oc = await login(oe, op);
  const S = {
    get: (p) => rq(SELLER, 'GET', `/shops/${shopId}${p}`, { cookie: oc }),
    post: (p, b) => rq(SELLER, 'POST', `/shops/${shopId}${p}`, { body: b, cookie: oc, origin: OS }),
  };
  // Một khách có đơn, một khách KHÁC để chứng minh bộ tìm không quơ bừa.
  const pr = await S.post('/products', { title: 'Áo thử', slug: `ao-${uniq()}`, price_vnd: 100000, status: 'active', variants: [{ sku: `T-${uniq()}`, price_vnd: 100000 }] });
  const vid = (await S.get(`/products/${pr.json.id}`)).json.variants[0].id;
  await S.post(`/variants/${vid}/inventory/adjust`, { delta: 50, reason: 'nhập' });
  const SDT = '0912345678', SDT_KHAC = '0987654321';
  const mk = async (phone, ten) => S.post('/orders', {
    lines: [{ variant_id: vid, qty: 1 }],
    customer: { name: ten, phone, address_line: '1 Lê Lợi', province: 'Hà Nội' },
    payment_method: 'cod', idempotency_key: `s-${uniq()}`,
  });
  await mk(SDT, 'Bùi Minh Thảo');
  await mk(SDT, 'Bùi Minh Thảo');
  const donKhac = await mk(SDT_KHAC, 'Lê Quốc Hùng');
  const soDon = donKhac.json?.order_number;
  donKhac.status === 201 && Number.isInteger(soDon)
    ? ok(`dựng shop + 3 đơn (2 của ${SDT}, 1 của ${SDT_KHAC}); đơn cuối là #${soDon}`)
    : bad(`không dựng được hiện trường: status=${donKhac.status} order_number=${soDon}`, donKhac.raw?.slice(0, 200));

  const dem = async (q) => ((await S.get(`/orders?q=${encodeURIComponent(q)}`)).json?.orders ?? []).length;
  const soDonTraVe = async (q) => ((await S.get(`/orders?q=${encodeURIComponent(q)}`)).json?.orders ?? []).map((o) => Number(o.order_number));

  // ── 1. SĐT DÁN TỪ CHAT ─────────────────────────────────────────────────────
  sect('1. Số điện thoại dán từ Zalo/Facebook');
  const dang = [
    ['0912345678', 'viết liền (kiểu duy nhất chạy được trước đây)'],
    ['0912.345.678', 'Zalo hiện có dấu chấm'],
    ['0912 345 678', 'có dấu cách'],
    ['0912-345-678', 'có gạch nối'],
    ['+84912345678', 'Facebook trả +84'],
    ['84912345678', '84 không dấu cộng'],
    [' 0912345678 ', 'dính khoảng trắng khi bôi đen'],
  ];
  for (const [q, mo_ta] of dang) {
    const n = await dem(q);
    n === 2 ? ok(`"${q}" → 2 đơn (${mo_ta})`) : bad(`"${q}" → ${n} đơn, mong 2 (${mo_ta})`, '');
  }
  // KHÔNG được quơ bừa: chuẩn hoá mà làm mọi số khớp nhau thì còn tệ hơn không tìm ra.
  (await dem('0987654321')) === 1 ? ok('SĐT khác vẫn chỉ ra đúng đơn của họ (không quơ bừa)') : bad('chuẩn hoá SĐT quơ nhầm đơn khách khác', '');
  (await dem('0900000000')) === 0 ? ok('SĐT không có đơn nào → 0 (không phải "khớp hết")') : bad('SĐT lạ vẫn ra đơn', '');

  // ── 2. MÃ ĐƠN CHÉP TỪ MÀN HÌNH ─────────────────────────────────────────────
  sect('2. Mã đơn chép từ chính màn hình');
  // ĐO SỰ CÓ MẶT, không đo SỐ LƯỢNG. Gõ "3" thì ngoài đơn #3 còn khớp mọi SĐT chứa chữ số 3 —
  // đó là hành vi ĐÚNG của một ô tìm chung. Khẳng định "đúng 1 kết quả" là tôi tự bịa ra một
  // luật không tồn tại, và nó đỏ trong khi mã hoàn toàn đúng (đã vấp).
  (await soDonTraVe(String(soDon))).includes(soDon)
    ? ok(`"${soDon}" → có đơn #${soDon} trong kết quả`) : bad(`"${soDon}" không thấy đơn #${soDon}`, '');
  const coThang = await soDonTraVe(`#${soDon}`);
  coThang.includes(soDon)
    ? ok(`"#${soDon}" → có đơn #${soDon} (mọi màn hình đều in kèm dấu thăng)`)
    : bad(`"#${soDon}" không ra đơn — chép đúng thứ phần mềm hiện ra mà không tìm được`, '');
  // Và hai cách gõ phải cho CÙNG một kết quả: dấu thăng chỉ là cách người ta chép, không phải
  // một phép lọc khác.
  JSON.stringify(coThang.sort()) === JSON.stringify((await soDonTraVe(String(soDon))).sort())
    ? ok('gõ có và không có dấu thăng cho cùng một kết quả') : bad('hai cách gõ ra hai kết quả khác nhau', '');

  // ── 3. TÊN KHÔNG DẤU VẪN CHẠY (không được làm hỏng thứ đang đúng) ──────────
  sect('3. Tên khách — thứ đang chạy đúng phải giữ nguyên');
  for (const q of ['Bùi Minh Thảo', 'Bui Minh Thao', 'bui minh thao', 'thảo']) {
    const n = await dem(q);
    n === 2 ? ok(`"${q}" → 2 đơn`) : bad(`"${q}" → ${n} đơn, mong 2`, '');
  }
  (await dem('Lê Quốc Hùng')) === 1 ? ok('tên khách khác → đúng 1 đơn') : bad('tìm theo tên quơ nhầm', '');

  // ── 4. RÁC KHÔNG LÀM VỠ TRANG ──────────────────────────────────────────────
  sect('4. Đầu vào rác');
  for (const q of ['#', '+', '...', '%', '_', "'; DROP TABLE orders; --", '#####']) {
    const r2 = await S.get(`/orders?q=${encodeURIComponent(q)}`);
    r2.status === 200 ? ok(`"${q}" → 200, không vỡ`) : bad(`"${q}" → ${r2.status}`, r2.raw?.slice(0, 120));
  }
  const con = Number((await owner.query(`SELECT count(*)::int n FROM orders WHERE shop_id=$1`, [shopId])).rows[0].n);
  con === 3 ? ok('3 đơn vẫn còn nguyên sau các truy vấn rác') : bad(`còn ${con} đơn`, '');

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
