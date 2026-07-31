/**
 * End-to-end quản trang nội dung qua admin (BFF). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-content.e2e.mjs
 *
 * Kiểm: tạo trang → thêm/sửa/xoá/di chuyển section (kéo–thả bằng ↑↓) → sửa meta →
 * đăng → xem trước → khôi phục revision → xoá; cùng cô lập chéo shop + CSRF.
 */
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
// Token lời mời KHÔNG còn trong API response (email hoá, 0073) — lấy từ outbox qua owner SQL (ADR-006: cùng tx với INSERT invitations nên đọc được ngay).
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic = 'user.invited' AND payload->>'to' = $1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${d}${X}`); };
const sect = (m) => console.log(`\n${B}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };

async function rq(base, method, path, { body, cookie, origin } = {}) {
  const h = {};
  if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
async function adm(method, path, { cookie, origin, form } = {}) {
  const h = {};
  if (form !== undefined) h['content-type'] = 'application/x-www-form-urlencoded';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(ADMIN + path, { method, headers: h, redirect: 'manual', body: form !== undefined ? new URLSearchParams(form).toString() : undefined });
  return { status: r.status, location: r.headers.get('location'), body: await r.text() };
}
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;
const page = (shopId, cookie, pid) => rq(SELLER, 'GET', `/shops/${shopId}/pages/${pid}`, { cookie });
const pidFrom = (loc) => /\/pages\/([0-9a-f-]{36})$/.exec(loc ?? '')?.[1] ?? null;

async function makeStaff() {
  const email = `staff-${uniq()}@nentang.vn`, password = 'staff strong passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let cookie = await login(email, password);
  const r = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie, origin: OA });
  const key = base32Decode(r.json.secret);
  await rq(AUTH, 'POST', '/auth/mfa/activate', { cookie, body: { code: totp(key, {}) }, origin: OA });
  const c = counterFor(Date.now());
  await owner.query(`INSERT INTO platform_staff (user_id,role) VALUES ($1,'admin')`, [await uidOf(email)]);
  while (counterFor(Date.now()) <= c) await sleep(1000);
  cookie = await login(email, password);
  // A6: mfa/verify ROTATE token → lấy cookie mới
  cookie = ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA })).sc) ?? cookie;
  return cookie;
}
async function makeShopOwner(staffCookie, slug) {
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, email, password, cookie: await login(email, password) };
}

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `cta-${uniq()}`);
  const Bo = await makeShopOwner(staff, `ctb-${uniq()}`);
  const P = (s) => `/shops/${A.shopId}/pages${s}`;
  ok('dựng 2 shop + chủ shop');

  // ── 1. Tạo trang ───────────────────────────────────────────────────────────
  sect('1. Tạo trang');
  let r = await adm('GET', P(''), { cookie: A.cookie });
  r.status === 200 && /Chưa có trang/.test(r.body) ? ok('danh sách trang rỗng + tab') : bad('list rỗng sai', r.body.slice(0, 150));
  r = await adm('POST', P(''), { cookie: A.cookie, origin: OADM, form: { title: 'Giới thiệu', slug: `gioi-thieu-${uniq()}`, seo_title: 'Về shop', seo_description: 'mô tả SEO' } });
  const pid = pidFrom(r.location);
  const E = (s) => P(`/${pid}${s}`);
  r.status === 303 && pid ? ok('tạo trang → 303 trình sửa') : bad('tạo trang lỗi', `${r.status} ${r.location}`);
  r = await adm('GET', E(''), { cookie: A.cookie });
  r.status === 200 && r.body.includes('Giới thiệu') && /Nháp/.test(r.body) && /Chưa đăng/.test(r.body) ? ok('trình sửa: tiêu đề + Nháp + chưa đăng') : bad('trình sửa sai', r.body.slice(0, 200));

  // ── 2. Thêm section các loại ───────────────────────────────────────────────
  sect('2. Thêm section');
  await adm('POST', E('/blocks'), { cookie: A.cookie, origin: OADM, form: { type: 'heading', text: 'Về chúng tôi' } });
  await adm('POST', E('/blocks'), { cookie: A.cookie, origin: OADM, form: { type: 'paragraph', text: 'Nhà Xinh bán nội thất.' } });
  await adm('POST', E('/blocks'), { cookie: A.cookie, origin: OADM, form: { type: 'list', text: 'Giao nhanh\nBảo hành 12 tháng\nĐổi trả 7 ngày' } });
  await adm('POST', E('/blocks'), { cookie: A.cookie, origin: OADM, form: { type: 'quote', text: 'Đẹp và bền', cite: 'Khách hàng' } });
  await adm('POST', E('/blocks'), { cookie: A.cookie, origin: OADM, form: { type: 'divider' } });
  let pg = (await page(A.shopId, A.cookie, pid)).json;
  const types = pg.blocks.map((b) => b.type);
  pg.blocks.length === 5 && JSON.stringify(types) === JSON.stringify(['heading', 'paragraph', 'list', 'quote', 'divider'])
    ? ok('thêm 5 section đúng loại + thứ tự') : bad('section sai', JSON.stringify(types));
  const listBlk = pg.blocks[2];
  Array.isArray(listBlk.items) && listBlk.items.length === 3 ? ok('list tách 3 mục từ 3 dòng') : bad('list không tách đúng', JSON.stringify(listBlk));

  // ── 3. Sửa / di chuyển / xoá section ──────────────────────────────────────
  sect('3. Sửa & kéo–thả (↑↓) & xoá');
  const bHeading = pg.blocks[0].id, bDivider = pg.blocks[4].id;
  await adm('POST', E(`/blocks/${bHeading}/edit`), { cookie: A.cookie, origin: OADM, form: { type: 'heading', text: 'Về Nhà Xinh Décor' } });
  pg = (await page(A.shopId, A.cookie, pid)).json;
  pg.blocks[0].text === 'Về Nhà Xinh Décor' ? ok('sửa nội dung heading') : bad('sửa section lỗi', pg.blocks[0].text);

  await adm('POST', E(`/blocks/${bHeading}/movedown`), { cookie: A.cookie, origin: OADM });
  pg = (await page(A.shopId, A.cookie, pid)).json;
  pg.blocks[1].id === bHeading ? ok('↓ đưa heading xuống vị trí 2') : bad('movedown lỗi', pg.blocks.map((b) => b.id).join());
  await adm('POST', E(`/blocks/${bHeading}/moveup`), { cookie: A.cookie, origin: OADM });
  pg = (await page(A.shopId, A.cookie, pid)).json;
  pg.blocks[0].id === bHeading ? ok('↑ đưa heading về vị trí 1') : bad('moveup lỗi', pg.blocks.map((b) => b.id).join());

  await adm('POST', E(`/blocks/${bDivider}/delete`), { cookie: A.cookie, origin: OADM });
  pg = (await page(A.shopId, A.cookie, pid)).json;
  pg.blocks.length === 4 && !pg.blocks.some((b) => b.type === 'divider') ? ok('xoá section divider → còn 4') : bad('xoá section lỗi', String(pg.blocks.length));

  // ── 4. Sửa meta trang ──────────────────────────────────────────────────────
  sect('4. Meta trang');
  r = await adm('POST', E(''), { cookie: A.cookie, origin: OADM, form: { title: 'Giới thiệu Nhà Xinh', menu_position: '1', seo_title: 'Về Nhà Xinh', seo_description: 'Nội thất đẹp' } });
  pg = (await page(A.shopId, A.cookie, pid)).json;
  r.status === 303 && pg.title === 'Giới thiệu Nhà Xinh' && pg.menu_position === 1 && pg.seo_title === 'Về Nhà Xinh' ? ok('lưu meta (title/menu/seo)') : bad('meta lỗi', `${r.status} ${pg.title} ${pg.menu_position}`);
  // menu_position rác → chặn (không lẳng lặng thành null) + GIỮ input vừa gõ + DB không đổi.
  r = await adm('POST', E(''), { cookie: A.cookie, origin: OADM, form: { title: 'Tiêu đề chưa lưu', menu_position: 'abc' } });
  const kept = r.body.includes('Tiêu đề chưa lưu');
  pg = (await page(A.shopId, A.cookie, pid)).json;
  r.status >= 400 && kept && pg.title === 'Giới thiệu Nhà Xinh' && pg.menu_position === 1 ? ok('menu_position rác → lỗi, giữ input, DB không đổi') : bad('meta lỗi nuốt input/đổi DB', `${r.status} kept=${kept} db=${pg.title}/${pg.menu_position}`);

  // ── 5. Đăng + revision + khôi phục ─────────────────────────────────────────
  sect('5. Đăng & khôi phục');
  r = await adm('POST', E('/publish'), { cookie: A.cookie, origin: OADM });
  pg = (await page(A.shopId, A.cookie, pid)).json;
  r.status === 303 && pg.status === 'published' && pg.published_revision === 1 ? ok('đăng → published, bản #1') : bad('publish lỗi', `${r.status} ${pg.status} ${pg.published_revision}`);
  // Sửa rồi đăng lần 2 → bản #2.
  await adm('POST', E(`/blocks/${bHeading}/edit`), { cookie: A.cookie, origin: OADM, form: { type: 'heading', text: 'Về chúng tôi (v2)' } });
  await adm('POST', E('/publish'), { cookie: A.cookie, origin: OADM });
  pg = (await page(A.shopId, A.cookie, pid)).json;
  pg.published_revision === 2 && pg.revisions.length === 2 ? ok('đăng lần 2 → bản #2, có 2 revision') : bad('publish 2 lỗi', `${pg.published_revision} ${pg.revisions.length}`);
  // Khôi phục về bản #1.
  r = await adm('POST', E('/rollback'), { cookie: A.cookie, origin: OADM, form: { revision: '1' } });
  pg = (await page(A.shopId, A.cookie, pid)).json;
  r.status === 303 && pg.published_revision === 1 ? ok('khôi phục → published trỏ bản #1') : bad('rollback lỗi', `${r.status} ${pg.published_revision}`);

  // ── 6. Xem trước ───────────────────────────────────────────────────────────
  sect('6. Xem trước');
  r = await adm('POST', E('/preview'), { cookie: A.cookie, origin: OADM });
  r.status === 200 && /Link xem trước/.test(r.body) && /preview=/.test(r.body) ? ok('xem trước → hiện link kèm token') : bad('preview lỗi', r.body.slice(0, 200));

  // ── 6b. Section ẢNH: chọn ảnh sẵn có hoặc tải lên, KHÔNG dán "key ảnh" ──────
  // Chủ shop nói trang nội dung khó vận hành. Nguyên nhân cụ thể: ô "Key ảnh" bắt dán
  // chuỗi <shop-id>/<media-id>.webp, kèm hướng dẫn "vào trang Sản phẩm lấy phần sau
  // /media-public/". Không ai tự đoán ra, nên section ảnh coi như không dùng được.
  sect('6b. Section ảnh: chọn sẵn có / tải lên');
  const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC', 'base64');
  // Gửi multipart đúng như trình duyệt gửi form có <input type=file>.
  const admMulti = async (path, parts) => {
    const bd = `----vaBoundary${uniq()}`;
    const chunks = [];
    for (const p of parts) {
      chunks.push(Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="${p.name}"`
        + (p.filename ? `; filename="${p.filename}"\r\nContent-Type: image/png` : '') + '\r\n\r\n'));
      chunks.push(Buffer.isBuffer(p.value) ? p.value : Buffer.from(String(p.value)));
      chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${bd}--\r\n`));
    const res = await fetch(ADMIN + path, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': `multipart/form-data; boundary=${bd}`, origin: OADM, cookie: `__Host-session=${A.cookie}` },
      body: Buffer.concat(chunks),
    });
    return { status: res.status, location: res.headers.get('location'), body: await res.text() };
  };

  r = await adm('GET', E(''), { cookie: A.cookie });
  // Không còn ô text bắt dán key, và form thêm ảnh phải là multipart có ô tệp.
  const noKeyBox = !/name="key"[^>]*placeholder="[^"]*media-id/.test(r.body) && !r.body.includes('/media-public/</code>');
  const hasUpload = /enctype="multipart\/form-data"[\s\S]{0,900}name="file"/.test(r.body) && r.body.includes('name="type" value="image"');
  (r.status === 200 && noKeyBox && hasUpload)
    ? ok('trang sửa: bỏ ô dán "key ảnh", có form thêm ảnh kèm ô tệp') : bad('vẫn còn ô key / thiếu ô tệp', `noKey=${noKeyBox} upload=${hasUpload}`);

  // Tải TỆP → tự upload, tự lấy key, tạo section ảnh.
  let ir = await admMulti(E('/blocks'), [
    { name: 'type', value: 'image' }, { name: 'alt', value: 'Ảnh cửa hàng' },
    { name: 'file', filename: 'a.png', value: PNG_1x1 },
  ]);
  pg = (await page(A.shopId, A.cookie, pid)).json;
  const imgBlk = (pg.blocks ?? []).find((b) => b.type === 'image');
  (ir.status === 303 && imgBlk && /\.webp$/.test(imgBlk.key ?? '') && imgBlk.key.startsWith(`${A.shopId}/`) && imgBlk.alt === 'Ảnh cửa hàng')
    ? ok('chọn tệp → tự tải lên + tạo section ảnh (key trong namespace shop)')
    : bad('thêm ảnh bằng tệp lỗi', `${ir.status} ${JSON.stringify(imgBlk)} | ${(/class="err">([^<]*)/.exec(ir.body) ?? [])[1] ?? ir.body.slice(0, 160)}`);

  // CHỌN ảnh sẵn có (radio key, không kèm tệp) → dùng đúng key đó.
  const pickedKey = imgBlk.key;
  ir = await admMulti(E('/blocks'), [
    { name: 'type', value: 'image' }, { name: 'alt', value: 'Ảnh chọn lại' }, { name: 'key', value: pickedKey },
  ]);
  pg = (await page(A.shopId, A.cookie, pid)).json;
  const picked = (pg.blocks ?? []).filter((b) => b.type === 'image').at(-1);
  (ir.status === 303 && picked?.key === pickedKey && picked.alt === 'Ảnh chọn lại')
    ? ok('chọn ảnh sẵn có (không kèm tệp) → dùng đúng ảnh đó') : bad('chọn ảnh sẵn có lỗi', JSON.stringify(picked));

  // Không chọn gì cả → báo lỗi RÕ, không tạo section ảnh rỗng.
  const beforeN = (pg.blocks ?? []).length;
  ir = await admMulti(E('/blocks'), [{ name: 'type', value: 'image' }, { name: 'alt', value: 'Thiếu ảnh' }]);
  pg = (await page(A.shopId, A.cookie, pid)).json;
  (ir.status === 409 && /Chưa chọn ảnh/.test(ir.body) && (pg.blocks ?? []).length === beforeN)
    ? ok('không chọn ảnh nào → báo lỗi rõ, không tạo section rỗng') : bad('section ảnh rỗng vẫn lọt', `${ir.status} n=${pg.blocks?.length}`);

  // Blog: ảnh giữa bài vẫn là cú pháp text, nhưng phải bày sẵn dòng cần chép.
  const bl = await adm('POST', `/shops/${A.shopId}/blog`, { cookie: A.cookie, origin: OADM, form: { title: 'Bài có ảnh', slug: `ba-${uniq()}`, body: 'x' } });
  const blId = /\/blog\/([0-9a-f-]{36})$/.exec(bl.location ?? '')?.[1];
  r = await adm('GET', `/shops/${A.shopId}/blog/${blId}`, { cookie: A.cookie });
  (r.status === 200 && (r.body.includes('Chèn ảnh vào giữa bài') || !r.body.includes('[anh:<key-media>')))
    ? ok('soạn blog: không còn bắt tự nghĩ ra key ảnh') : bad('blog vẫn để mặc người dùng tìm key');

  // ĐƯỜNG TẢI ẢNH BÌA — chạy THẬT, không chỉ kiểm nút có hiện.
  //
  // Đây là lỗ đã để lọt một lỗi thật: nút "Tải ảnh bìa lên" ship ra mà chưa từng chạy
  // được, vì ảnh nội dung sinh key `<shop>/banner-<uuid>.webp` còn blog chỉ nhận
  // `<shop>/<uuid>.webp` hoặc `logo-`. Bộ test khi đó chỉ khẳng định "trang có bộ chọn
  // ảnh" nên xanh trơn. Kiểm sự CÓ MẶT của một nút không nói gì về việc bấm nó có được.
  ir = await admMulti(`/shops/${A.shopId}/blog/${blId}/cover`, [{ name: 'file', filename: 'c.png', value: PNG_1x1 }]);
  const post = await rq(SELLER, 'GET', `/shops/${A.shopId}/blog/${blId}`, { cookie: A.cookie });
  const cover = post.json?.cover_image_key;
  (ir.status === 303 && typeof cover === 'string' && cover.startsWith(`${A.shopId}/`) && cover.endsWith('.webp'))
    ? ok('tải ảnh bìa blog → gắn được vào bài (key hợp lệ với blog.js)')
    : bad('tải ảnh bìa blog KHÔNG gắn được', `${ir.status} cover=${cover} | ${(/class="err">([^<]*)/.exec(ir.body) ?? [])[1] ?? ''}`);

  // ── 7. Xoá trang + cô lập + CSRF ───────────────────────────────────────────
  sect('7. Xoá & cô lập & CSRF');
  r = await adm('POST', E('/delete'), { cookie: A.cookie, origin: OADM });
  const gone = (await page(A.shopId, A.cookie, pid)).status;
  r.status === 303 && r.location === P('') && gone === 404 ? ok('xoá trang → 303 danh sách + seller 404') : bad('xoá trang lỗi', `${r.status} ${gone}`);
  r = await adm('GET', `/shops/${Bo.shopId}/pages`, { cookie: A.cookie });
  r.status === 403 ? ok('owner A xem trang shop B → 403') : bad('rò trang chéo shop', String(r.status));
  r = await adm('POST', P(''), { cookie: A.cookie, form: { title: 'x', slug: `x-${uniq()}` } }); // KHÔNG Origin
  r.status === 403 ? ok('tạo trang không Origin → 403 (CSRF)') : bad('CSRF không chặn', String(r.status));

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((err) => { console.error('admin content e2e lỗi:', err); process.exit(2); });
