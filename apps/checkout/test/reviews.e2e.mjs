/**
 * End-to-end ĐÁNH GIÁ SẢN PHẨM. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/checkout/test/reviews.e2e.mjs
 *
 * Kiểm: khách gửi (pending, KHÔNG hiện ngay), badge "đã mua" khớp đơn delivered,
 * honeypot nuốt im lặng, rate-limit 3/IP/ngày, shop duyệt → hiện trên storefront
 * (sao + nội dung), reject/xoá, cô lập chéo shop, XSS escape.
 */

import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const STORE = new URL(process.env.STOREFRONT_URL ?? 'http://storefront:3050');
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
// Token lời mời KHÔNG còn trong API response (email hoá, 0073) — lấy từ outbox qua owner SQL (ADR-006: cùng tx với INSERT invitations nên đọc được ngay).
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic = 'user.invited' AND payload->>'to' = $1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${d}${X}`); };
const sect = (m) => console.log(`\n${B}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const phone = () => '09' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
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
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;

// HTTP với Host header (fetch cấm đặt Host) — dùng cho checkout (form) + storefront (đọc trang).
function hostReq(target, host, method, path, { form, body, cartToken, idemKey } = {}) {
  return new Promise((resolve, reject) => {
    const data = form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : null;
    const headers = { host, origin: `https://${host}` };
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    else if (body) headers['content-type'] = 'application/json';
    if (data) headers['content-length'] = Buffer.byteLength(data);
    if (cartToken) headers['cookie'] = `__Host-cart=${cartToken}`;
    if (idemKey) headers['idempotency-key'] = idemKey;
    const req = http.request({ hostname: target.hostname, port: target.port, path, method, headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => {
        let j = null; try { j = b ? JSON.parse(b) : null; } catch {}
        let token = cartToken;
        for (const c of res.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) token = m[1]; }
        resolve({ status: res.statusCode, body: b, json: j, location: res.headers.location, cartToken: token });
      });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

async function makeStaff() {
  const email = `staff-${uniq()}@nentang.vn`, password = 'staff strong passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let cookie = await login(email, password);
  let r = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie, origin: OA });
  const key = base32Decode(r.json.secret);
  await rq(AUTH, 'POST', '/auth/mfa/activate', { cookie, body: { code: totp(key, {}) }, origin: OA });
  const c = counterFor(Date.now());
  await owner.query(`INSERT INTO platform_staff (user_id,role) VALUES ($1,'admin')`, [await uidOf(email)]);
  while (counterFor(Date.now()) <= c) await sleep(1000);
  cookie = await login(email, password);
  cookie = ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA })).sc) ?? cookie;
  return cookie;
}
async function makeShopOwner(staffCookie, slug) {
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, slug, host: `${slug}.nentang.vn`, email, password, cookie: await login(email, password) };
}

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `rv-${uniq()}`);
  // Sản phẩm + tồn + slug
  const slug = `sp-${uniq()}`;
  let r = await rq(SELLER, 'POST', `/shops/${A.shopId}/products`, { body: { title: 'Ghế review', slug, price_vnd: 100000, status: 'active', variants: [{ sku: `RV-${uniq()}`, price_vnd: 100000 }] }, cookie: A.cookie, origin: OS });
  const pid = r.json.id;
  const vid = (await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${pid}`, { cookie: A.cookie })).json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${A.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: 20, reason: 'seed' }, cookie: A.cookie, origin: OS });
  ok('dựng shop + sản phẩm');

  // Đơn ĐÃ GIAO để test badge "đã mua"
  const buyerPhone = phone();
  const cart = (await hostReq(CO, A.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 1 } })).cartToken;
  const oc = await hostReq(CO, A.host, 'POST', '/checkout', { body: { customer: { name: 'Người Mua', phone: buyerPhone }, payment_method: 'cod' }, cartToken: cart, idemKey: `k-${uniq()}` });
  const oid = (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2`, [A.shopId, oc.json.order_number])).rows[0].id;
  await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${oid}/confirm`, { cookie: A.cookie, origin: OS });
  await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${oid}/ship`, { body: { tracking_number: 'RVTEST1' }, cookie: A.cookie, origin: OS });
  await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${oid}/deliver`, { cookie: A.cookie, origin: OS });

  // ── 1. Gửi đánh giá (pending) ────────────────────────────────────────────────
  sect('1. Khách gửi đánh giá');
  r = await hostReq(CO, A.host, 'POST', '/checkout/review', { form: { product_id: pid, rating: '5', author_name: 'Chị Hoa', content: 'Sản phẩm rất tốt, đáng tiền!', order_number: String(oc.json.order_number), phone: buyerPhone } });
  r.status === 303 && r.location?.includes(`/p/${slug}?review=sent`) ? ok('gửi đánh giá → 303 PRG về trang SP') : bad('gửi lỗi', `${r.status} ${r.location}`);
  const rv1 = (await owner.query(`SELECT status, verified FROM product_reviews WHERE shop_id=$1 AND product_id=$2 AND author_name='Chị Hoa'`, [A.shopId, pid])).rows[0];
  rv1?.status === 'pending' ? ok('đánh giá vào hàng chờ (pending)') : bad('status sai', JSON.stringify(rv1));
  rv1?.verified === true ? ok('badge "đã mua" (khớp đơn delivered + SĐT + SP)') : bad('verified sai', JSON.stringify(rv1));

  let page = (await hostReq(STORE, A.host, 'GET', `/p/${slug}`, {})).body;
  !page.includes('Sản phẩm rất tốt') ? ok('PENDING chưa hiện trên storefront') : bad('pending bị lộ!');

  // Sai đơn/SĐT → verified=false
  r = await hostReq(CO, A.host, 'POST', '/checkout/review', { form: { product_id: pid, rating: '4', author_name: 'Anh Ba', content: 'Cũng được, giao hơi chậm.', order_number: '999999', phone: phone() } });
  const rv2 = (await owner.query(`SELECT verified FROM product_reviews WHERE shop_id=$1 AND author_name='Anh Ba'`, [A.shopId])).rows[0];
  rv2?.verified === false ? ok('đơn không khớp → KHÔNG badge đã mua') : bad('verified giả', JSON.stringify(rv2));

  // Honeypot: bot điền field ẩn → giả vờ thành công, KHÔNG lưu.
  r = await hostReq(CO, A.host, 'POST', '/checkout/review', { form: { product_id: pid, rating: '5', author_name: 'Bot', content: 'spam spam spam spam', website: 'http://spam.com' } });
  const nBot = Number((await owner.query(`SELECT count(*)::int n FROM product_reviews WHERE shop_id=$1 AND author_name='Bot'`, [A.shopId])).rows[0].n);
  r.status === 303 && nBot === 0 ? ok('honeypot → 303 giả thành công, KHÔNG lưu') : bad('honeypot lọt', `${r.status} n=${nBot}`);

  // Validation: content ngắn → PRG review=invalid, không lưu.
  r = await hostReq(CO, A.host, 'POST', '/checkout/review', { form: { product_id: pid, rating: '5', author_name: 'X', content: 'ngắn' } });
  r.location?.includes('review=invalid') ? ok('nội dung <10 ký tự → review=invalid') : bad('validation lỏng', r.location);

  // Rate limit: đã gửi 2 (Hoa + Ba) → cái thứ 3 OK, thứ 4 bị 429.
  await hostReq(CO, A.host, 'POST', '/checkout/review', { form: { product_id: pid, rating: '3', author_name: 'Thứ Ba', content: 'đánh giá thứ ba hợp lệ' } });
  r = await hostReq(CO, A.host, 'POST', '/checkout/review', { form: { product_id: pid, rating: '3', author_name: 'Thứ Tư', content: 'đánh giá thứ tư vượt trần' } });
  r.status === 429 ? ok('trần 3 đánh giá/IP/ngày → 429') : bad('không chặn spam', String(r.status));

  // ── 2. Shop duyệt → hiện trên storefront ────────────────────────────────────
  sect('2. Duyệt & hiển thị');
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/reviews?status=pending`, { cookie: A.cookie });
  r.json?.reviews?.length === 3 && r.json.pending_count === 3 ? ok('seller thấy 3 pending') : bad('list sai', `${r.json?.reviews?.length} pc=${r.json?.pending_count}`);
  const rvHoa = r.json.reviews.find((x) => x.author_name === 'Chị Hoa');
  const rvBa = r.json.reviews.find((x) => x.author_name === 'Anh Ba');
  await rq(SELLER, 'POST', `/shops/${A.shopId}/reviews/${rvHoa.id}/approve`, { cookie: A.cookie, origin: OS });
  await rq(SELLER, 'POST', `/shops/${A.shopId}/reviews/${rvBa.id}/reject`, { cookie: A.cookie, origin: OS });
  page = (await hostReq(STORE, A.host, 'GET', `/p/${slug}`, {})).body;
  page.includes('Sản phẩm rất tốt') && page.includes('Chị Hoa') ? ok('APPROVED hiện trên trang SP') : bad('approved không hiện');
  page.includes('Đã mua hàng') ? ok('badge ✓ Đã mua hàng hiển thị') : bad('thiếu badge');
  !page.includes('giao hơi chậm') ? ok('REJECTED không hiện') : bad('rejected bị lộ');
  page.includes('(1 đánh giá)') && page.includes('5') ? ok('tóm tắt sao: 5 (1 đánh giá)') : bad('thiếu tóm tắt sao');
  page.includes('aggregateRating') ? ok('microdata aggregateRating (SEO)') : bad('thiếu microdata');

  // ── 3. XSS + cô lập chéo shop ───────────────────────────────────────────────
  sect('3. XSS + cô lập');
  // Nhả rate-limit (đánh giá cũ lùi 2 ngày) để request XSS được nhận (mục tiêu là kiểm escape).
  await owner.query(`UPDATE product_reviews SET created_at = created_at - interval '2 days' WHERE shop_id = $1`, [A.shopId]);
  await hostReq(CO, A.host, 'POST', '/checkout/review', { form: { product_id: pid, rating: '1', author_name: '<script>alert(1)</script>', content: '<img src=x onerror=alert(2)> nội dung đủ dài' } });
  const rvXss = (await owner.query(`SELECT id FROM product_reviews WHERE shop_id=$1 AND author_name LIKE '%script%'`, [A.shopId])).rows[0];
  if (rvXss) await rq(SELLER, 'POST', `/shops/${A.shopId}/reviews/${rvXss.id}/approve`, { cookie: A.cookie, origin: OS });
  page = (await hostReq(STORE, A.host, 'GET', `/p/${slug}`, {})).body;
  !page.includes('<script>alert(1)') && !page.includes('<img src=x') && page.includes('&lt;script&gt;')
    ? ok('XSS trong đánh giá bị ESCAPE') : bad('XSS lọt!');
  const Bs = await makeShopOwner(staff, `rvb-${uniq()}`);
  r = await rq(SELLER, 'POST', `/shops/${Bs.shopId}/reviews/${rvHoa.id}/reject`, { cookie: Bs.cookie, origin: OS });
  r.status === 404 ? ok('shop B duyệt đánh giá shop A → 404 (cô lập)') : bad('rò chéo shop', r.raw);

  // ── 4. SHOP TRẢ LỜI đánh giá (0099) ─────────────────────────────────────────
  sect('4. Shop trả lời đánh giá — hiện công khai dưới đánh giá');
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/reviews/${rvHoa.id}/reply`,
    { cookie: A.cookie, origin: OS, body: { reply: 'Cảm ơn chị Hoa! Shop sẽ cố gắng giao nhanh hơn.' } });
  r.status === 200 ? ok('shop gửi phản hồi → 200') : bad('gửi phản hồi lỗi', `${r.status} ${r.raw}`);
  page = (await hostReq(STORE, A.host, 'GET', `/p/${slug}`, {})).body;
  /class="rv-reply"/.test(page) && page.includes('Cảm ơn chị Hoa')
    ? ok('phản hồi hiện trên trang SP, dưới đúng đánh giá') : bad('phản hồi không hiện');
  page.includes('Phản hồi của') ? ok('có nhãn "Phản hồi của <tên shop>"') : bad('thiếu nhãn phản hồi');

  // Gỡ phản hồi: gửi chuỗi rỗng.
  await rq(SELLER, 'POST', `/shops/${A.shopId}/reviews/${rvHoa.id}/reply`, { cookie: A.cookie, origin: OS, body: { reply: '' } });
  page = (await hostReq(STORE, A.host, 'GET', `/p/${slug}`, {})).body;
  !/class="rv-reply"/.test(page) ? ok('gửi chuỗi rỗng → GỠ phản hồi khỏi trang SP') : bad('không gỡ được phản hồi');
  const clr = (await owner.query('SELECT seller_reply, seller_replied_at FROM product_reviews WHERE id=$1', [rvHoa.id])).rows[0];
  clr.seller_reply === null && clr.seller_replied_at === null ? ok('gỡ xong xoá luôn mốc thời gian trả lời') : bad('còn sót dữ liệu trả lời', JSON.stringify(clr));

  // XSS qua ô trả lời của shop.
  await rq(SELLER, 'POST', `/shops/${A.shopId}/reviews/${rvHoa.id}/reply`,
    { cookie: A.cookie, origin: OS, body: { reply: '<script>alert(9)</script>' } });
  page = (await hostReq(STORE, A.host, 'GET', `/p/${slug}`, {})).body;
  !page.includes('<script>alert(9)') ? ok('XSS trong phản hồi của shop bị escape') : bad('XSS QUA Ô TRẢ LỜI!');
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/reviews/${rvHoa.id}/reply`,
    { cookie: A.cookie, origin: OS, body: { reply: 'x'.repeat(1001) } });
  r.status === 400 ? ok('phản hồi > 1000 ký tự → 400') : bad('không chặn phản hồi quá dài', String(r.status));
  r = await rq(SELLER, 'POST', `/shops/${Bs.shopId}/reviews/${rvHoa.id}/reply`, { cookie: Bs.cookie, origin: OS, body: { reply: 'chen ngang' } });
  r.status === 404 ? ok('shop B trả lời đánh giá shop A → 404') : bad('rò chéo shop khi trả lời', String(r.status));

  // ── 5. BIỂU ĐỒ PHÂN BỔ SAO ─────────────────────────────────────────────────
  sect('5. Biểu đồ phân bổ sao 5★…1★');
  page = (await hostReq(STORE, A.host, 'GET', `/p/${slug}`, {})).body;
  /class="rv-dist"/.test(page) ? ok('có biểu đồ phân bổ sao') : bad('thiếu biểu đồ phân bổ');
  /class="rv-summary"/.test(page) && /class="rv-big"/.test(page) ? ok('có ô tổng quan điểm trung bình') : bad('thiếu ô tổng quan');
  (page.match(/class="rv-row"/g) ?? []).length === 5 ? ok('đủ 5 hàng (5★ → 1★)') : bad('số hàng phân bổ sai', String((page.match(/class="rv-row"/g) ?? []).length));

  // ── 6. NÚT "HỮU ÍCH" ───────────────────────────────────────────────────────
  sect('6. Nút "Hữu ích": cộng 1 lần, bấm lại KHÔNG cộng thêm');
  page = (await hostReq(STORE, A.host, 'GET', `/p/${slug}`, {})).body;
  /action="\/checkout\/review-helpful"/.test(page) ? ok('có form "Hữu ích" (no-JS, POST sang checkout)') : bad('thiếu nút hữu ích');

  r = await hostReq(CO, A.host, 'POST', '/checkout/review-helpful', { form: { review_id: rvHoa.id, slug } });
  let hc = (await owner.query('SELECT helpful_count FROM product_reviews WHERE id=$1', [rvHoa.id])).rows[0].helpful_count;
  Number(hc) === 1 ? ok('bấm lần 1 → helpful_count = 1') : bad('không cộng', String(hc));
  await hostReq(CO, A.host, 'POST', '/checkout/review-helpful', { form: { review_id: rvHoa.id, slug } });
  await hostReq(CO, A.host, 'POST', '/checkout/review-helpful', { form: { review_id: rvHoa.id, slug } });
  hc = (await owner.query('SELECT helpful_count FROM product_reviews WHERE id=$1', [rvHoa.id])).rows[0].helpful_count;
  Number(hc) === 1 ? ok('bấm thêm 2 lần cùng IP → VẪN 1 (bảng phiếu chặn)') : bad('cộng nhiều lần', String(hc));
  const votes = (await owner.query('SELECT count(*)::int n FROM review_votes WHERE review_id=$1', [rvHoa.id])).rows[0].n;
  Number(votes) === 1 ? ok('chỉ ghi ĐÚNG 1 phiếu') : bad('số phiếu sai', String(votes));
  page = (await hostReq(STORE, A.host, 'GET', `/p/${slug}`, {})).body;
  /Hữu ích \(1\)/.test(page) ? ok('trang SP hiện "Hữu ích (1)"') : bad('không hiện số hữu ích');

  // Đánh giá CHƯA DUYỆT không được nhận phiếu (chỉ lộ ra nếu gọi thẳng endpoint).
  const pend = (await owner.query(`SELECT id FROM product_reviews WHERE shop_id=$1 AND status='pending' LIMIT 1`, [A.shopId])).rows[0];
  if (pend) {
    await hostReq(CO, A.host, 'POST', '/checkout/review-helpful', { form: { review_id: pend.id, slug } });
    const ph = (await owner.query('SELECT helpful_count FROM product_reviews WHERE id=$1', [pend.id])).rows[0].helpful_count;
    Number(ph) === 0 ? ok('đánh giá CHƯA DUYỆT không nhận được phiếu') : bad('vote được cho review chưa duyệt', String(ph));
  }
  r = await hostReq(CO, A.host, 'POST', '/checkout/review-helpful', { form: { review_id: 'khong-phai-uuid', slug } });
  r.status === 302 || r.status === 303 ? ok('review_id rác → chuyển hướng về, không 500') : bad('id rác làm sập', String(r.status));

  // ── 7. HỎI ĐÁP SẢN PHẨM (0100) ──────────────────────────────────────────────
  sect('7. Hỏi đáp: khách hỏi → chờ; chỉ hiện khi shop ĐÃ TRẢ LỜI');
  r = await hostReq(CO, A.host, 'POST', '/checkout/question',
    { form: { product_id: pid, asker_name: 'Chị Lan', question: 'Kich thuoc dong goi la bao nhieu vay shop?' } });
  let qrow = (await owner.query(`SELECT id, status, answer FROM product_questions WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 1`, [A.shopId])).rows[0];
  qrow && qrow.status === 'pending' ? ok('câu hỏi vào hàng đợi CHỜ (không hiện ngay)') : bad('gửi câu hỏi lỗi', JSON.stringify(qrow));
  page = (await hostReq(STORE, A.host, 'GET', `/p/${slug}`, {})).body;
  !page.includes('Kich thuoc dong goi') ? ok('câu hỏi chưa duyệt KHÔNG lộ trên trang SP') : bad('câu hỏi chưa duyệt bị lộ');
  /id="hoi-dap"/.test(page) ? ok('trang SP có mục Hỏi đáp') : bad('thiếu mục hỏi đáp');
  /action="\/checkout\/question"/.test(page) ? ok('có form đặt câu hỏi (no-JS)') : bad('thiếu form hỏi');

  // Honeypot + câu hỏi quá ngắn.
  await hostReq(CO, A.host, 'POST', '/checkout/question',
    { form: { product_id: pid, asker_name: 'Bot', question: 'spam spam spam spam', website: 'http://spam.vn' } });
  let nq = Number((await owner.query(`SELECT count(*)::int n FROM product_questions WHERE shop_id=$1`, [A.shopId])).rows[0].n);
  nq === 1 ? ok('honeypot nuốt im lặng (không tạo câu hỏi)') : bad('honeypot không chặn', String(nq));
  r = await hostReq(CO, A.host, 'POST', '/checkout/question', { form: { product_id: pid, asker_name: 'X', question: 'ngắn' } });
  /ask=invalid/.test(r.location ?? '') ? ok('câu hỏi < 10 ký tự → báo không hợp lệ') : bad('không chặn câu hỏi ngắn', r.location);

  sect('8. Shop trả lời → câu hỏi ĐĂNG LÊN trang SP');
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/questions?status=pending`, { cookie: A.cookie });
  r.json?.questions?.length === 1 && r.json.pending_count === 1 ? ok('seller thấy 1 câu chờ') : bad('list câu hỏi sai', JSON.stringify(r.json?.pending_count));
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/questions/${qrow.id}/answer`,
    { cookie: A.cookie, origin: OS, body: { answer: 'Dạ có ạ, bảo hành 12 tháng chính hãng.' } });
  r.status === 200 && r.json?.status === 'approved' ? ok('trả lời → tự ĐĂNG LUÔN (approved)') : bad('trả lời lỗi', `${r.status} ${r.raw}`);
  page = (await hostReq(STORE, A.host, 'GET', `/p/${slug}`, {})).body;
  page.includes('Kich thuoc dong goi') && page.includes('bảo hành 12 tháng')
    ? ok('cả câu hỏi và câu trả lời hiện trên trang SP') : bad('hỏi đáp không hiện');
  /class="qa-a"/.test(page) ? ok('câu trả lời có khối riêng (đọc như hội thoại)') : bad('thiếu khối trả lời');

  sect('9. Hỏi đáp: bảo mật + cách ly');
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/questions/${qrow.id}/answer`, { cookie: A.cookie, origin: OS, body: { answer: '' } });
  r.status === 400 ? ok('trả lời RỖNG → 400 (không đăng câu hỏi bỏ ngỏ)') : bad('cho phép trả lời rỗng', String(r.status));
  r = await rq(SELLER, 'POST', `/shops/${Bs.shopId}/questions/${qrow.id}/answer`, { cookie: Bs.cookie, origin: OS, body: { answer: 'chen ngang' } });
  r.status === 404 ? ok('shop B trả lời câu hỏi shop A → 404') : bad('rò chéo shop', String(r.status));
  // XSS qua cả câu hỏi (khách) lẫn câu trả lời (shop).
  await owner.query(`UPDATE product_questions SET created_at = created_at - interval '2 days' WHERE shop_id=$1`, [A.shopId]);
  await hostReq(CO, A.host, 'POST', '/checkout/question',
    { form: { product_id: pid, asker_name: '<script>alert(7)</script>', question: '<img src=x onerror=alert(8)> câu hỏi đủ dài' } });
  const qx = (await owner.query(`SELECT id FROM product_questions WHERE shop_id=$1 AND asker_name LIKE '%script%'`, [A.shopId])).rows[0];
  if (qx) {
    await rq(SELLER, 'POST', `/shops/${A.shopId}/questions/${qx.id}/answer`,
      { cookie: A.cookie, origin: OS, body: { answer: '<script>alert(6)</script> xin chào' } });
  }
  page = (await hostReq(STORE, A.host, 'GET', `/p/${slug}`, {})).body;
  !page.includes('<script>alert(7)') && !page.includes('<img src=x') && !page.includes('<script>alert(6)')
    ? ok('XSS trong CẢ câu hỏi lẫn câu trả lời bị escape') : bad('XSS QUA HỎI ĐÁP!');
  // Ẩn câu hỏi → biến mất khỏi trang SP.
  if (qx) await rq(SELLER, 'POST', `/shops/${A.shopId}/questions/${qx.id}/reject`, { cookie: A.cookie, origin: OS });
  page = (await hostReq(STORE, A.host, 'GET', `/p/${slug}`, {})).body;
  !page.includes('xin chào') ? ok('ẩn câu hỏi → biến mất khỏi trang SP') : bad('ẩn rồi vẫn hiện');

  // ── 10. ẢNH TRONG ĐÁNH GIÁ (0101) ───────────────────────────────────────────
  // Bất biến QUAN TRỌNG NHẤT: ảnh KHÔNG có URL công khai cho tới khi shop DUYỆT.
  sect('10. Ảnh đánh giá: riêng tư cho tới khi duyệt');
  // PNG 1×1 hợp lệ (magic byte thật) — sharp giải mã được.
  const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  // Multipart thủ công (không dùng FormData để kiểm soát từng byte biên).
  const mpBody = (bnd, fields, files) => {
    const parts = [];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${bnd}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    for (const f of files) {
      parts.push(Buffer.from(`--${bnd}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`));
      parts.push(f.bytes); parts.push(Buffer.from('\r\n'));
    }
    parts.push(Buffer.from(`--${bnd}--\r\n`));
    return Buffer.concat(parts);
  };
  const postMultipart = (host, path, fields, files) => new Promise((resolve, reject) => {
    const bnd = '----nentangtest' + uniq();
    const data = mpBody(bnd, fields, files);
    const req2 = http.request({ hostname: CO.hostname, port: CO.port, path, method: 'POST',
      headers: { host, origin: `https://${host}`, 'content-type': `multipart/form-data; boundary=${bnd}`, 'content-length': data.length } },
      (rs) => { let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => resolve({ status: rs.statusCode, location: rs.headers.location, body: b })); });
    req2.on('error', reject); req2.write(data); req2.end();
  });

  await owner.query(`UPDATE product_reviews SET created_at = created_at - interval '2 days' WHERE shop_id = $1`, [A.shopId]);
  r = await postMultipart(A.host, '/checkout/review',
    { product_id: pid, rating: '5', author_name: 'Chị Ảnh', content: 'Hàng đẹp, đúng mô tả, gửi kèm ảnh thật.' },
    [{ field: 'images', name: 'a.png', type: 'image/png', bytes: PNG1 },
     { field: 'images', name: 'b.png', type: 'image/png', bytes: PNG1 },
     // Tệp KHÔNG PHẢI ảnh (giả content-type) → phải bị loại, KHÔNG chặn cả đánh giá.
     { field: 'images', name: 'evil.png', type: 'image/png', bytes: Buffer.from('<?php system($_GET[0]); ?>') }]);
  const rvImg = (await owner.query(`SELECT id, status FROM product_reviews WHERE shop_id=$1 AND author_name='Chị Ảnh'`, [A.shopId])).rows[0];
  rvImg ? ok('gửi đánh giá KÈM ẢNH qua multipart → nhận được') : bad('không nhận được đánh giá có ảnh', `${r.status} ${r.location}`);
  let imgRows = (await owner.query(`SELECT id, status, original_key, public_key FROM review_images WHERE review_id=$1 ORDER BY position`, [rvImg?.id ?? null])).rows;
  imgRows.length === 2 ? ok('2 ảnh THẬT được nhận, tệp giả-ảnh (PHP) bị LOẠI') : bad('lọc tệp giả sai', `${imgRows.length} ảnh`);
  imgRows.every((i) => i.status === 'pending' && !i.public_key)
    ? ok('ảnh ở trạng thái CHỜ và KHÔNG có public_key (chưa công khai)') : bad('ảnh đã công khai khi chưa duyệt!', JSON.stringify(imgRows));

  page = (await hostReq(STORE, A.host, 'GET', `/p/${slug}`, {})).body;
  !/class="rv-imgs"/.test(page) ? ok('trang SP CHƯA hiện ảnh (đánh giá còn chờ duyệt)') : bad('ảnh chưa duyệt bị lộ trên trang SP');
  // Storefront (vai công khai) tuyệt đối không đọc được ảnh chưa duyệt, kể cả query trực tiếp.
  const storeSees = await (async () => {
    const cli = new pg.Client({ connectionString: 'postgres://app_store:devpassword@postgres:5432/app' });
    await cli.connect();
    await cli.query(`SELECT set_config('app.shop_id', $1, false)`, [A.shopId]);
    const n = (await cli.query(`SELECT count(*)::int n FROM review_images`)).rows[0].n;
    await cli.end(); return n;
  })();
  storeSees === 0 ? ok('vai storefront KHÔNG đọc được dòng ảnh nào khi chưa duyệt (RLS)') : bad('RLS hở ảnh chưa duyệt', String(storeSees));

  sect('11. Shop DUYỆT → ảnh mới được công khai');
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/reviews/${rvImg.id}/approve`, { cookie: A.cookie, origin: OS });
  r.json?.images_published === 2 ? ok('duyệt → thăng ĐÚNG 2 ảnh lên công khai') : bad('thăng ảnh sai', JSON.stringify(r.json));
  imgRows = (await owner.query(`SELECT status, public_key FROM review_images WHERE review_id=$1`, [rvImg.id])).rows;
  imgRows.every((i) => i.status === 'ready' && i.public_key) ? ok('ảnh có public_key + status ready') : bad('ảnh chưa sẵn sàng', JSON.stringify(imgRows));
  page = (await hostReq(STORE, A.host, 'GET', `/p/${slug}`, {})).body;
  /class="rv-imgs"/.test(page) && (page.match(/class="rv-thumb"/g) ?? []).length === 2
    ? ok('trang SP hiện ĐÚNG 2 ảnh của người mua') : bad('ảnh không hiện sau duyệt');
  /class="rv-lb"/.test(page) ? ok('có lightbox phóng to (thuần CSS, không JS)') : bad('thiếu lightbox');

  sect('12. Ảnh: kiểm duyệt được + từ chối thì biến mất');
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/reviews?status=approved`, { cookie: A.cookie });
  const withImgs = (r.json?.reviews ?? []).find((x) => (x.images ?? []).length === 2);
  withImgs ? ok('API duyệt trả kèm danh sách ảnh (để admin hiện thumbnail)') : bad('API không trả ảnh');
  // Shop XEM được ảnh chưa duyệt qua endpoint có xác thực (duyệt mù là thất bại cần tránh).
  const anyImg = (await owner.query(`SELECT id FROM review_images WHERE review_id=$1 LIMIT 1`, [rvImg.id])).rows[0];
  const imgResp = await fetch(`${SELLER}/shops/${A.shopId}/reviews/${rvImg.id}/images/${anyImg.id}`, { headers: { cookie: `__Host-session=${A.cookie}` } });
  imgResp.status === 200 && /image\//.test(imgResp.headers.get('content-type') ?? '') ? ok('shop xem được ảnh qua endpoint có xác thực') : bad('shop không xem được ảnh', String(imgResp.status));
  const imgCross = await fetch(`${SELLER}/shops/${Bs.shopId}/reviews/${rvImg.id}/images/${anyImg.id}`, { headers: { cookie: `__Host-session=${Bs.cookie}` } });
  imgCross.status === 404 ? ok('shop B KHÔNG xem được ảnh của shop A → 404') : bad('rò ảnh chéo shop', String(imgCross.status));
  const noAuth = await fetch(`${SELLER}/shops/${A.shopId}/reviews/${rvImg.id}/images/${anyImg.id}`);
  noAuth.status === 401 || noAuth.status === 403 ? ok(`chưa đăng nhập xem ảnh → ${noAuth.status}`) : bad('ảnh xem được KHÔNG cần đăng nhập!', String(noAuth.status));

  await rq(SELLER, 'POST', `/shops/${A.shopId}/reviews/${rvImg.id}/reject`, { cookie: A.cookie, origin: OS });
  const afterReject = (await owner.query(`SELECT count(*)::int n FROM review_images WHERE review_id=$1 AND deleted_at IS NULL`, [rvImg.id])).rows[0].n;
  Number(afterReject) === 0 ? ok('từ chối đánh giá → ảnh bị đánh dấu xoá') : bad('ảnh còn sống sau khi từ chối', String(afterReject));
  page = (await hostReq(STORE, A.host, 'GET', `/p/${slug}`, {})).body;
  !/class="rv-thumb"/.test(page) ? ok('ảnh biến mất khỏi trang SP sau khi từ chối') : bad('ảnh vẫn hiện sau từ chối');

  // ── 13. DỌN RÁC ảnh (0102) ──────────────────────────────────────────────────
  sect('13. Worker dọn object ảnh đã xoá mềm + không để mồ côi khi xoá đánh giá');
  const WORKER = process.env.WORKER_URL ?? 'http://worker:3080';
  // Ảnh của đánh giá vừa bị TỪ CHỐI ở mục 12 đang xoá-mềm → worker phải xoá hẳn dòng.
  const beforeGc = Number((await owner.query(
    `SELECT count(*)::int n FROM review_images WHERE review_id=$1`, [rvImg.id])).rows[0].n);
  beforeGc === 2 ? ok('2 dòng ảnh xoá-mềm còn trong DB trước khi dọn') : bad('trạng thái trước dọn sai', String(beforeGc));
  let gc = await (await fetch(`${WORKER}/internal/revimg-gc`, { method: 'POST' })).json();
  Number(gc.removed) >= 2 ? ok(`worker dọn ${gc.removed} ảnh (xoá object + xoá dòng)`) : bad('worker không dọn', JSON.stringify(gc));
  const afterGc = Number((await owner.query(
    `SELECT count(*)::int n FROM review_images WHERE review_id=$1`, [rvImg.id])).rows[0].n);
  afterGc === 0 ? ok('dòng ảnh đã biến mất khỏi DB') : bad('còn sót dòng', String(afterGc));
  gc = await (await fetch(`${WORKER}/internal/revimg-gc`, { method: 'POST' })).json();
  Number(gc.removed) === 0 ? ok('dọn lại lần 2 → 0 (không lặp vô ích)') : bad('dọn lặp', JSON.stringify(gc));

  // RÒ RỈ đã vá: xoá HẲN đánh giá → CASCADE cuốn dòng ảnh, nên seller phải xoá OBJECT TRƯỚC.
  // Nếu không, object thành mồ côi VĨNH VIỄN (không còn bản ghi nào trỏ tới).
  await owner.query(`UPDATE product_reviews SET created_at = created_at - interval '2 days' WHERE shop_id = $1`, [A.shopId]);
  r = await postMultipart(A.host, '/checkout/review',
    { product_id: pid, rating: '4', author_name: 'Chị Xoá', content: 'Đánh giá này sẽ bị xoá hẳn để kiểm rò rỉ.' },
    [{ field: 'images', name: 'c.png', type: 'image/png', bytes: PNG1 }]);
  const rvDel = (await owner.query(`SELECT id FROM product_reviews WHERE shop_id=$1 AND author_name='Chị Xoá'`, [A.shopId])).rows[0];
  // DUYỆT trước để ảnh có public_key — bucket public đọc được qua HTTP nên KIỂM CHỨNG ĐƯỢC
  // object còn hay mất (bucket private đòi chữ ký S3, GET ẩn danh trả 403 dù có hay không).
  await rq(SELLER, 'POST', `/shops/${A.shopId}/reviews/${rvDel.id}/approve`, { cookie: A.cookie, origin: OS });
  const pubKey = (await owner.query(`SELECT public_key FROM review_images WHERE review_id=$1`, [rvDel.id])).rows[0]?.public_key;
  pubKey ? ok('dựng đánh giá đã duyệt có 1 ảnh công khai để kiểm xoá-hẳn') : bad('không tạo được ảnh công khai');
  const objAlive = async (key) => {
    const rs = await fetch(`http://minio:9000/media-public/${key}`);
    return rs.status === 200;
  };
  (await objAlive(pubKey)) ? ok('object đang SỐNG trong kho public trước khi xoá') : bad('object không truy cập được từ đầu');

  // Xoá HẲN đánh giá qua API seller.
  r = await rq(SELLER, 'DELETE', `/shops/${A.shopId}/reviews/${rvDel.id}`, { cookie: A.cookie, origin: OS });
  r.status === 200 ? ok('xoá hẳn đánh giá → 200') : bad('xoá đánh giá lỗi', String(r.status));
  const rowsGone = Number((await owner.query(`SELECT count(*)::int n FROM review_images WHERE review_id=$1`, [rvDel.id])).rows[0].n);
  rowsGone === 0 ? ok('CASCADE cuốn dòng ảnh (đúng như thiết kế DB)') : bad('dòng ảnh còn sót', String(rowsGone));
  // Object PHẢI đã bị xoá TRƯỚC khi dòng bị cuốn — nếu còn, đó chính là MỒ CÔI vĩnh viễn
  // (không còn bản ghi nào trỏ tới nên worker cũng không bao giờ tìm ra).
  !(await objAlive(pubKey)) ? ok('object đã bị xoá TRƯỚC khi cuốn dòng → KHÔNG mồ côi trong kho')
    : bad('RÒ RỈ: object mồ côi vĩnh viễn trong MinIO!');

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
