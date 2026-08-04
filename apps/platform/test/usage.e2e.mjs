/**
 * E2E ĐO LUỒNG DÙNG (0141). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/platform/test/usage.e2e.mjs
 *
 * Đường đi đầy đủ: request thật → Redis → worker gộp → feature_usage → API → trang console.
 *
 * Bốn khẳng định TRUNG TÂM, mỗi cái ứng với một cách tính năng này có thể vô dụng:
 *   1. ĐẾM ĐÚNG MẪU — id thật không lọt vào `route` (lọt là bảng nổ, mọi phép gộp vô nghĩa).
 *   2. GẮN ĐÚNG SHOP — kể cả service phân giải shop theo TÊN MIỀN (storefront/checkout).
 *   3. CỘNG DỒN — gộp hai lần thì số cộng lại, không đè lên nhau và không đếm hai lần.
 *   4. KHÔNG CẢN ĐƯỜNG NÓNG — Redis hỏng thì request vẫn 200, chỉ mất số đếm.
 */
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const WORKER = process.env.WORKER_URL ?? 'http://worker:3080';
const STORE = new URL(process.env.STOREFRONT_URL ?? 'http://storefront:3050');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 5 });
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const G = '\x1b[32m', RED = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', BOLD = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${RED}FAIL${X} ${m}`); if (d) console.log(`       ${D}${String(d).slice(0, 200)}${X}`); };
const sect = (m) => console.log(`\n${BOLD}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };

async function rq(base, method, path, { body, cookie, origin } = {}) {
  const h = {}; if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin; if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
async function adm(method, path, { cookie, origin, form } = {}) {
  const h = {}; if (form !== undefined) h['content-type'] = 'application/x-www-form-urlencoded';
  if (origin) h.origin = origin; if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(ADMIN + path, { method, headers: h, redirect: 'manual', body: form !== undefined ? new URLSearchParams(form).toString() : undefined });
  return { status: r.status, sc: r.headers.getSetCookie(), body: await r.text() };
}
const login = async (e, p) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email: e, password: p }, origin: OA })).sc);
const uidOf = async (e) => (await owner.query('SELECT id FROM users WHERE email=$1', [e])).rows[0]?.id ?? null;

let HOST;
function sf(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: STORE.hostname, port: STORE.port, path, method: 'GET', headers: { host: HOST } }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, raw: b }));
    });
    req.on('error', reject); req.end();
  });
}
const sweep = () => fetch(`${WORKER}/internal/usage-sweep`, { method: 'POST' }).then((r) => r.json()).catch(() => null);
// Ngày theo GIỜ VN — phải KHỚP mốc ngày mà obs.js dùng, nếu không thì gần nửa đêm bộ test
// đọc nhầm ngày và đỏ vì lý do chẳng liên quan gì tới tính năng.
const dayVN = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const hitsOf = async (service, route, shopId) => Number((await owner.query(
  `SELECT coalesce(sum(hits), 0)::bigint AS n FROM feature_usage
    WHERE service = $1 AND route = $2 AND day = $3::date
      AND ($4::uuid IS NULL OR shop_id = $4)`, [service, route, dayVN(), shopId ?? null])).rows[0].n);

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
  const verified = ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie: c, body: { code: totp(key, {}) }, origin: OA })).sc) ?? c;
  return { email, password, cookie: verified, key };
}

async function main() {
  const staff = await makeStaff();
  const slug = `fu-${uniq()}`;
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff.cookie, origin: OO });
  const shopId = r.json.id; HOST = `${slug}.nentang.vn`;
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff.cookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  const oc = await login(oe, op);
  // Shop phải ACTIVE thì mới nằm trong mẫu số "cửa hàng đang hoạt động" của API.
  await owner.query(`UPDATE shops SET status = 'active' WHERE id = $1`, [shopId]);
  ok('dựng shop + chủ shop');

  // ── 1. ĐẾM ĐÚNG MẪU, GẮN ĐÚNG SHOP ─────────────────────────────────────────
  sect('1. Đếm đúng mẫu route + đúng shop');
  // Đường của SELLER có shop trong ĐƯỜNG DẪN → mẫu phải là /shops/:id/..., shop rút tự động.
  const before = await hitsOf('seller', 'GET /shops/:id/orders', shopId);
  await rq(SELLER, 'GET', `/shops/${shopId}/orders`, { cookie: oc });
  await sweep();
  let after = await hitsOf('seller', 'GET /shops/:id/orders', shopId);
  after === before + 1
    ? ok('gọi /shops/<uuid>/orders → đếm vào mẫu "GET /shops/:id/orders", đúng shop')
    : bad(`đếm sai: ${before} → ${after}`, '');
  // uuid THẬT không được có mặt ở bất kỳ dòng nào — đây là khẳng định sống-chết của bảng.
  const leak = Number((await owner.query(`SELECT count(*)::int n FROM feature_usage WHERE route LIKE '%' || $1 || '%'`, [shopId])).rows[0].n);
  leak === 0 ? ok('KHÔNG dòng nào chứa uuid thật trong cột route') : bad(`${leak} dòng có uuid thật trong route`, '');

  // Đường của STOREFRONT phân giải shop theo TÊN MIỀN → cần noteShop(). Đây là ca dễ sót nhất:
  // bỏ noteShop thì vẫn có số đếm, chỉ là shop_id NULL — số vẫn "chạy", chỉ mất hết ý nghĩa.
  const b2 = await hitsOf('storefront', 'GET /products', shopId);
  const page = await sf('/products');
  await sweep();
  const a2 = await hitsOf('storefront', 'GET /products', shopId);
  page.status === 200 && a2 === b2 + 1
    ? ok('storefront (shop theo tên miền) vẫn gắn ĐÚNG shop, không phải NULL')
    : bad(`storefront đếm sai: ${b2} → ${a2} (status ${page.status})`, '');

  // Slug do người bán tự đặt → phải thành :slug, nếu không mỗi sản phẩm là một dòng riêng.
  //
  // KHẲNG ĐỊNH ĐÚNG là "KHÔNG slug thật nào lọt", KHÔNG phải "chỉ có ĐÚNG MỘT mẫu /p/...".
  // Bản đầu tôi viết vế sau và nó ĐỎ trong lượt CI đầy đủ — đỏ ĐÚNG, vì hệ có hai endpoint
  // /p/ khác nhau CÓ THẬT: trang SP (/p/<slug>) và xem nhanh (/p/<slug>/quickview). Hai endpoint
  // khác nhau ra hai mẫu khác nhau chính là điều ta MUỐN; gộp chúng lại mới là hỏng.
  // Bài học: khẳng định phải nói đúng cái luật, đừng nói một hệ quả tình cờ đúng lúc viết.
  // PHẢI dùng SẢN PHẨM CÓ THẬT. Slug bịa → trang 404 → sink CỐ Ý bỏ 404 → không có dòng nào,
  // và khẳng định bên dưới xanh mà chẳng đo gì. Đột biến (gỡ 'p' khỏi SLUG_PREFIX) vẫn xanh —
  // đúng lớp bẫy "khẳng định không đo thứ nó tưởng", lần này là do 404 nuốt mất hiện trường.
  const slugSP = `sp-do-luong-${uniq()}`;
  const cre = await rq(SELLER, 'POST', `/shops/${shopId}/products`, {
    body: { title: 'SP đo luồng', slug: slugSP, price_vnd: 100000, status: 'active', variants: [{ sku: `DL-${uniq()}`, price_vnd: 100000 }] },
    cookie: oc, origin: OS });
  const sp1 = await sf(`/p/${slugSP}`);
  const sp2 = await sf(`/p/${slugSP}/quickview`);
  cre.status === 201 && sp1.status === 200
    ? ok('dựng được SP thật để đo (trang SP trả 200, không phải 404)')
    : bad(`không dựng được hiện trường: tạo=${cre.status} trang=${sp1.status} quickview=${sp2.status}`, cre.raw?.slice(0, 160));
  await sweep();
  // PHẠM VI: chỉ dòng của SHOP LƯỢT NÀY. Quét toàn bảng nghe mạnh hơn nhưng KHÔNG lặp lại được:
  // một lượt chạy đột biến trước đó để lại dòng có slug thật, và mọi lượt sau đều đỏ vì rác cũ
  // chứ không vì mã hiện tại. (Đã dính đúng thế.) Khẳng định phải nói về HÀNH VI HÔM NAY.
  const { rows: pRows } = await owner.query(
    `SELECT DISTINCT route FROM feature_usage
      WHERE service='storefront' AND route LIKE '% /p/%' AND shop_id = $1`, [shopId]);
  // Khẳng định TRỰC TIẾP nhất: slug thật của SP vừa tạo KHÔNG được có mặt ở bất kỳ mẫu nào.
  const dinhSlug = pRows.map((r) => r.route).filter((r) => r.includes(slugSP));
  dinhSlug.length === 0 ? ok('slug thật của SP KHÔNG xuất hiện trong mẫu nào') : bad(`slug thật lọt: ${dinhSlug.join(' | ')}`, '');
  // Hợp lệ: '<METHOD> /p/:slug' và '<METHOD> /p/:slug/<gì đó>'. Sai: bất cứ gì khác sau /p/.
  const ro = pRows.map((r) => r.route).filter((r) => !/ \/p\/:slug(\/|$)/.test(r));
  ro.length === 0
    ? ok(`mọi trang SP gom slug vào ':slug' (${pRows.length} mẫu /p/ hợp lệ, không rò)`)
    : bad(`slug THẬT lọt vào mẫu: ${ro.join(' | ')}`, '');

  // ── 2. CỘNG DỒN QUA NHIỀU CHU KỲ ───────────────────────────────────────────
  // Gộp là UPSERT cộng dồn. Nếu ai đó đổi thành DO UPDATE SET hits = excluded.hits thì lần
  // gộp sau ĐÈ lên lần trước — số vẫn "có", chỉ là sai, và sai âm thầm.
  sect('2. Gộp nhiều chu kỳ thì CỘNG DỒN');
  const b3 = await hitsOf('seller', 'GET /shops/:id/orders', shopId);
  await rq(SELLER, 'GET', `/shops/${shopId}/orders`, { cookie: oc });
  await rq(SELLER, 'GET', `/shops/${shopId}/orders`, { cookie: oc });
  await sweep();
  const mid = await hitsOf('seller', 'GET /shops/:id/orders', shopId);
  await rq(SELLER, 'GET', `/shops/${shopId}/orders`, { cookie: oc });
  await sweep();
  const end = await hitsOf('seller', 'GET /shops/:id/orders', shopId);
  mid === b3 + 2 && end === b3 + 3
    ? ok(`hai chu kỳ gộp cộng dồn đúng (${b3} → ${mid} → ${end})`)
    : bad(`cộng dồn sai: ${b3} → ${mid} → ${end}, mong +2 rồi +3`, '');
  // Gộp khi KHÔNG có gì mới → không được đẻ thêm số.
  await sweep();
  (await hitsOf('seller', 'GET /shops/:id/orders', shopId)) === end
    ? ok('gộp lại khi không có lượt mới → số KHÔNG đổi') : bad('gộp rỗng vẫn làm số nhảy', '');

  // ── 3. KHÔNG ĐẾM THỨ KHÔNG PHẢI "AI ĐÓ DÙNG" ───────────────────────────────
  sect('3. Bỏ qua health + đường không tồn tại');
  await fetch(`${SELLER}/healthz`).catch(() => {});
  await rq(SELLER, 'GET', `/shops/${shopId}/khong-co-duong-nay`, { cookie: oc });
  await sweep();
  const hz = Number((await owner.query(`SELECT count(*)::int n FROM feature_usage WHERE route LIKE '%healthz%' OR route LIKE '%livez%' OR route LIKE '%readyz%'`)).rows[0].n);
  hz === 0 ? ok('đường health KHÔNG vào bảng (load balancer gọi liên tục sẽ át số liệu thật)') : bad(`${hz} dòng health`, '');
  const nf = await hitsOf('seller', 'GET /shops/:id/khong-co-duong-nay', shopId);
  nf === 0 ? ok('404 KHÔNG được đếm (nó nói về đường không tồn tại)') : bad(`404 vẫn đếm: ${nf}`, '');

  // ── 3b. RÁC BOT KHÔNG ĐƯỢC VÀO BẢNG ────────────────────────────────────────
  // Lỗ này e2e mới thấy được: vài service THOÁT SỚM bằng CHUYỂN HƯỚNG trước khi khớp route,
  // nên lá chắn 404 không chạy và mọi URL bot dò thành một ô riêng. Máy chủ công khai ăn hàng
  // nghìn URL dò mỗi ngày là mức NỀN — chạm trần 5.000 ô/ngày thì mọi route thật xuất hiện
  // LẦN ĐẦU sau đó rơi vào ':over'.
  sect('3b. Đường thoát-sớm không đẻ ô rác');
  const RAC = ['/wp-login.php', '/.env', '/xmlrpc.php'];
  // ĐO CHÊNH LỆCH, không đo tuyệt đối: bảng có thể còn ô rác từ lần chạy TRƯỚC khi vá (hoặc từ
  // một lượt đột biến). Đếm tuyệt đối thì mọi lượt sau đều đỏ vì quá khứ, không vì mã hôm nay.
  const demRac = async () => Number((await owner.query(
    `SELECT count(*)::int n FROM feature_usage WHERE route ~ '(wp-login|xmlrpc|\.env)'`)).rows[0].n);
  const racTruoc = await demRac();
  // (a) seller-admin: chưa đăng nhập → 303 về /login cho MỌI đường dẫn.
  for (const r of RAC) await adm('GET', r, {});
  // (b) storefront: ?ref= → 302 cho MỌI đường dẫn, và nó nằm SAU noteShop nên rác còn mang
  //     shop_id thật — nhìn bảng tưởng shop đó có tính năng lạ.
  for (const r of RAC) await sf(`${r}?ref=CTV01`);
  await sweep();
  const racSau = await demRac();
  racSau === racTruoc
    ? ok(`đường bot dò (303 /login và 302 ?ref=) KHÔNG đẻ ô mới (${racTruoc} ô cũ giữ nguyên)`)
    : bad(`${racSau - racTruoc} ô rác MỚI lọt vào bảng`, '');
  // Nhưng KHÔNG được nới tay quá: đường THẬT vẫn phải đếm.
  const truocSf = await hitsOf('storefront', 'GET /products', shopId);
  await sf('/products');
  await sweep();
  (await hitsOf('storefront', 'GET /products', shopId)) === truocSf + 1
    ? ok('và route THẬT vẫn đếm bình thường (không chặn nhầm)') : bad('chặn nhầm route thật', '');
  // Tệp phông: mỗi lượt tải trang kéo 3-9 tệp → không loại thì chúng đứng đầu bảng xếp hạng.
  const font = Number((await owner.query(
    `SELECT count(*)::int n FROM feature_usage WHERE route LIKE '%/fonts/%'`)).rows[0].n);
  font === 0 ? ok('tệp phông KHÔNG vào bảng') : bad(`${font} dòng tệp phông`, '');

  // ── 3c. TRANG NỀN TẢNG TÁCH KHỎI TRANG SHOP ────────────────────────────────
  // Một tiến trình storefront phục vụ CẢ trang marketing nentang.vn LẪN storefront của shop.
  // Không tách tên service thì '/' và '/blog' của hai bên gộp làm một — câu "blog người bán có
  // ai đọc không" bị cộng lượt đọc bài marketing của chính nền tảng.
  sect('3c. Trang marketing nền tảng đếm riêng');
  // ĐO CHÊNH LỆCH (lần thứ ba trong bộ này phải nhớ): bảng có thể đã có dòng 'nentang' từ lượt
  // chạy trước, nên "sum >= 1" luôn đúng và khẳng định thành vô nghĩa — đột biến vô hiệu hoá
  // noteService() vẫn xanh. Chỉ số TĂNG THÊM mới nói về hành vi của mã hôm nay.
  const demNen = async () => Number((await owner.query(
    `SELECT coalesce(sum(hits),0)::int n FROM feature_usage WHERE service='nentang'`)).rows[0].n);
  const nenTruoc = await demNen();
  await sf('/');                                    // Host = tên miền của SHOP
  const sfHost = (path, host) => new Promise((res2, rej) => {
    const q = http.request({ hostname: STORE.hostname, port: STORE.port, path, method: 'GET', headers: { host } }, (r2) => { r2.resume(); r2.on('end', () => res2(r2.statusCode)); });
    q.on('error', rej); q.end();
  });
  const goc = await sfHost('/', 'nentang.vn');      // Host = tên miền NỀN TẢNG
  await sweep();
  const nenSau = await demNen();
  goc === 200 && nenSau > nenTruoc
    ? ok(`trang nền tảng đếm dưới service riêng 'nentang' (+${nenSau - nenTruoc} lượt)`)
    : bad(`không tách được (status ${goc}, ${nenTruoc} → ${nenSau})`, '');
  const tronLan = Number((await owner.query(
    `SELECT count(*)::int n FROM feature_usage WHERE service='nentang' AND shop_id IS NOT NULL`)).rows[0].n);
  tronLan === 0 ? ok("service 'nentang' không mang shop_id nào") : bad(`${tronLan} dòng nentang có shop_id`, '');

  // ── 4. API CONSOLE ─────────────────────────────────────────────────────────
  sect('4. API /ops/usage');
  r = await rq(PLATFORM, 'GET', '/ops/usage?days=30', { cookie: staff.cookie });
  const row = (r.json?.rows ?? []).find((x) => x.service === 'seller' && x.route === 'GET /shops/:id/orders');
  r.status === 200 && row ? ok('API trả dòng của route đã dùng') : bad('API không thấy dòng', r.raw?.slice(0, 200));
  Number(row?.shops) >= 1 ? ok(`đếm được SỐ SHOP dùng (${row?.shops})`) : bad('không đếm được số shop', JSON.stringify(row));
  Number(r.json?.active_shops) >= 1 ? ok(`có mẫu số "cửa hàng đang hoạt động" (${r.json.active_shops})`) : bad('thiếu mẫu số', r.raw?.slice(0, 200));
  r.json?.measuring_since ? ok(`biết đang đo từ ngày nào (${String(r.json.measuring_since).slice(0, 10)})`) : bad('không biết đo từ bao giờ', '');
  // Xếp NGƯỢC: ít shop dùng nhất lên đầu. Bảng xuôi thì kết quả ai cũng đoán được — vô dụng.
  const shopsSeq = (r.json?.rows ?? []).map((x) => Number(x.shops));
  shopsSeq.every((n, i) => i === 0 || shopsSeq[i - 1] <= n)
    ? ok('sắp xếp NGƯỢC: ít cửa hàng dùng nhất lên đầu') : bad('thứ tự sai', JSON.stringify(shopsSeq.slice(0, 10)));
  r = await rq(PLATFORM, 'GET', '/ops/usage?days=30&service=seller', { cookie: staff.cookie });
  (r.json?.rows ?? []).every((x) => x.service === 'seller') ? ok('lọc theo dịch vụ chạy') : bad('bộ lọc dịch vụ rơi', r.raw?.slice(0, 160));
  r = await rq(PLATFORM, 'GET', '/ops/usage?days=abc', { cookie: staff.cookie });
  r.status === 200 && r.json?.days === 30 ? ok('days rác → về mặc định 30, không 500') : bad(`days rác trả ${r.status}`, r.raw?.slice(0, 160));

  // ── 5. PHÂN QUYỀN ──────────────────────────────────────────────────────────
  // Bảng này nói "route X có N shop dùng" — dữ liệu của CẢ NỀN TẢNG. Chủ shop xem được là
  // biết được thông tin về các shop khác.
  sect('5. Chỉ nhân viên nền tảng xem được');
  r = await rq(PLATFORM, 'GET', '/ops/usage', { cookie: oc });
  r.status === 403 ? ok('chủ shop gọi /ops/usage → 403') : bad(`chủ shop nhận ${r.status}`, r.raw?.slice(0, 160));
  r = await rq(PLATFORM, 'GET', '/ops/usage', {});
  r.status === 401 ? ok('không phiên → 401') : bad(`không phiên nhận ${r.status}`, r.raw?.slice(0, 160));
  // HAI LỚP, kiểm CẢ HAI. DB này có ALTER DEFAULT PRIVILEGES cấp CRUD cho app_rw trên MỌI
  // bảng mới — bộ test này chính là chỗ phát hiện ra điều đó (0141 phải REVOKE tường minh).
  // Chỉ kiểm "đọc ra 0 dòng" là chưa đủ: RLS đang chặn, nhưng RLS chặn vì KHÔNG CÓ policy —
  // một sự vắng mặt. Ai đó thêm policy PERMISSIVE cho app_rw là cửa mở, mà test vẫn xanh.
  const gr = await owner.query(`SELECT privilege_type FROM information_schema.table_privileges WHERE table_name='feature_usage' AND grantee='app_rw'`);
  gr.rows.length === 0 ? ok('vai app_rw (seller) KHÔNG có quyền nào trên feature_usage') : bad(`app_rw có ${gr.rows.map((x) => x.privilege_type).join(',')} — thiếu REVOKE (default privileges tự cấp)`, '');
  const rwPool = new pg.Pool({ connectionString: process.env.DATABASE_URL_RW, max: 1 });
  let rwDocDuoc = null;
  try { rwDocDuoc = Number((await rwPool.query('SELECT count(*)::int n FROM feature_usage')).rows[0].n); } catch { rwDocDuoc = 'bi tu choi'; }
  rwDocDuoc === 'bi tu choi' || rwDocDuoc === 0
    ? ok(`app_rw KHÔNG đọc được dòng nào (${rwDocDuoc})`) : bad(`app_rw đọc được ${rwDocDuoc} dòng`, '');
  await rwPool.end();

  // ── 6. TRANG CONSOLE ───────────────────────────────────────────────────────
  sect('6. Trang Đo luồng dùng');
  // Dùng THẲNG cookie đã qua MFA của staff: console nền tảng đòi phiên đã step-up MFA, và
  // đây đúng là phiên đó. Đăng nhập lại qua trang admin sẽ ra một phiên CHƯA verify → 403,
  // tức là đo nhầm (trang bị chặn vì thiếu MFA, không phải vì trang hỏng).
  // KHÔNG đặt tên biến là `pg` — nó che module `pg` đã import ở đầu file trong TOÀN BỘ hàm
  // (TDZ của let), làm mọi chỗ dùng pg.Pool phía trên ném ReferenceError. Đã vấp đúng lỗi này.
  const trang = await adm('GET', '/platform/usage', { cookie: staff.cookie });
  trang.status === 200 ? ok('mở được trang /platform/usage') : bad(`trang trả ${trang.status}`, trang.body.slice(0, 200));
  const nhan = ['Đo luồng dùng', 'Cửa hàng dùng', 'Đường dẫn'];
  const thieu = nhan.filter((x) => !trang.body.includes(x));
  thieu.length === 0 ? ok('trang hiện đủ nhãn: ' + nhan.join(' · ')) : bad('thiếu nhãn: ' + thieu.join(', '), '');
  trang.body.includes('/shops/:id/orders') ? ok('trang in ĐÚNG mẫu route (không phải uuid thật)') : bad('không thấy mẫu route trên trang', trang.body.slice(0, 300));
  !trang.body.includes(shopId) ? ok('trang KHÔNG in uuid shop nào') : bad('uuid shop lọt lên trang', '');
  // Nói thẳng cái nó CHƯA trả lời được — trang tự nhận giới hạn thì người đọc không kết luận ẩu.
  /chưa ai chạm bao giờ/i.test(trang.body) ? ok('trang nói rõ giới hạn "chưa từng chạm thì không xuất hiện"') : bad('trang không nêu giới hạn', '');

  // ── 7. KHÔNG CẢN ĐƯỜNG NÓNG ────────────────────────────────────────────────
  // Đo đạc hỏng thì mất số đếm — KHÔNG được làm hỏng một request thật. Dựng bằng cách trỏ
  // sink vào một Redis không tồn tại là không thể từ ngoài, nên kiểm điều tương đương và
  // kiểm được: đường nóng vẫn 200 khi Redis đang bị dội request và khi mẫu route dài bất thường.
  sect('7. Đo đạc không cản đường nóng');
  const dai = '/' + Array.from({ length: 14 }, (_, i) => `doan-rat-dai-${i}-${'x'.repeat(50)}`).join('/');
  const rDai = await sf(dai);
  rDai.status === 404 || rDai.status === 200 ? ok(`đường dẫn dài bất thường vẫn trả lời bình thường (${rDai.status})`) : bad(`trả ${rDai.status}`, '');
  const s2 = await sweep();
  s2 ? ok('và vòng gộp vẫn chạy được sau đó (không kẹt vì dòng rác)') : bad('vòng gộp hỏng', '');
  const qua = Number((await owner.query(`SELECT count(*)::int n FROM feature_usage WHERE length(route) > 160`)).rows[0].n);
  qua === 0 ? ok('không dòng nào vượt trần 160 ký tự của cột route') : bad(`${qua} dòng quá dài`, '');

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
