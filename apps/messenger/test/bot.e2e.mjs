/**
 * End-to-end BOT MESSENGER (0122) — đi TRỌN hội thoại tới một ĐƠN THẬT. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/messenger/test/bot.e2e.mjs
 *
 * Meta được GIẢ LẬP hai chiều: bộ test dựng một Graph API giả (cổng 4390, service messenger
 * trỏ META_GRAPH_URL vào đây) để ĐỌC ĐÚNG những gì bot gửi cho khách, và tự ký webhook như
 * Meta gửi vào. Nhờ vậy test khẳng định được nội dung tin nhắn, chứ không chỉ "không lỗi".
 *
 * Kiểm: verify webhook (đúng/sai token) · CHỮ KÝ sai → 403 và KHÔNG gửi gì · đi hết luồng
 * nút bấm → ĐƠN THẬT (đúng shop, trừ tồn, source=facebook, đóng dấu khoá hệ thống) · Meta
 * gửi lại webhook KHÔNG đẻ đơn thứ hai · "gặp nhân viên" làm bot im · ngắt kết nối thì xoá
 * cả phiên (PII) · Trang lạ không tạo được gì.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const MESSENGER = process.env.MESSENGER_URL ?? 'http://messenger:3072';
const APP_SECRET = process.env.MESSENGER_APP_SECRET ?? 'dev-messenger-app-secret';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
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
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;

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
  return ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA })).sc) ?? cookie;
}
async function makeShopOwner(staffCookie, slug) {
  const r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, email, password, cookie: await login(email, password) };
}
async function setupProduct(shop, title, price, stock) {
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/products`, {
    body: { title, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `S-${uniq()}`, price_vnd: price }] }, cookie: shop.cookie, origin: OS });
  const d = await rq(SELLER, 'GET', `/shops/${shop.shopId}/products/${r.json.id}`, { cookie: shop.cookie });
  const vid = d.json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${shop.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: shop.cookie, origin: OS });
  return { productId: r.json.id, variantId: vid };
}

// ── Meta GIẢ LẬP ────────────────────────────────────────────────────────────
// Bắt mọi lệnh gửi tin của bot. Đây là thứ cho phép khẳng định NỘI DUNG, chứ không phải
// chỉ "không có lỗi" — bài học cũ: nút có mặt không nói gì về việc bấm vào có chạy.
const sent = [];
const graph = http.createServer((req, res) => {
  if (req.method === 'GET') {  // hồ sơ khách (tên để chào)
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ first_name: 'Lan', last_name: 'Nguyễn' }));
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    try { sent.push(JSON.parse(body)); } catch { sent.push({ raw: body }); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"message_id":"m_stub"}');
  });
});

const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
async function webhook(pageId, messaging, { badSig = false } = {}) {
  const raw = JSON.stringify({ object: 'page', entry: [{ id: pageId, messaging }] });
  const r = await fetch(`${MESSENGER}/webhooks/messenger`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': badSig ? 'sha256=' + '0'.repeat(64) : sign(raw) },
    body: raw,
  });
  return { status: r.status, body: await r.text(), raw };
}
const PSID = 'psid-' + uniq();
const evText = (t) => [{ sender: { id: PSID }, message: { text: t } }];
const evPostback = (p) => [{ sender: { id: PSID }, postback: { payload: p } }];
const evQuick = (p) => [{ sender: { id: PSID }, message: { text: 'x', quick_reply: { payload: p } } }];
/** Gộp mọi text + nút của các tin bot vừa gửi, để khẳng định bằng nội dung khách THẤY. */
function drain() {
  const all = sent.splice(0, sent.length);
  const flat = all.map((m) => JSON.stringify(m.message ?? m)).join('\n');
  return { count: all.length, flat, all };
}

async function main() {
  await new Promise((r) => graph.listen(4390, '0.0.0.0', r));
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `bot-${uniq()}`);
  const p1 = await setupProduct(A, 'Áo Thun Trắng', 199000, 10);
  const pageId = String(Math.floor(1e14 + Math.random() * 8e14));

  sect('1. Chủ shop kết nối Trang (đòi step-up)');
  let r = await rq(SELLER, 'PUT', `/shops/${A.shopId}/messenger`, { body: { page_id: pageId, page_token: 'EAAG-fake-page-token-1234567890' }, cookie: A.cookie, origin: OS });
  r.status === 403 && r.json?.step_up_required ? ok('chưa step-up → 403') : bad(`kết nối Trang không đòi step-up (${r.status})`, r.raw);
  const su = await rq(AUTH, 'POST', '/auth/step-up', { body: { password: A.password }, cookie: A.cookie, origin: OA });
  A.cookie = ck(su.sc) ?? A.cookie;
  r = await rq(SELLER, 'PUT', `/shops/${A.shopId}/messenger`, { body: { page_id: pageId, page_name: 'Shop Thử', page_token: 'EAAG-fake-page-token-1234567890' }, cookie: A.cookie, origin: OS });
  const verifyToken = r.json?.verify_token;
  r.status === 200 && verifyToken ? ok('kết nối 200 + trả verify token') : bad('kết nối Trang lỗi', r.raw);
  const cfgRow = (await owner.query('SELECT page_token_enc, api_key_id FROM shop_messenger_config WHERE shop_id=$1', [A.shopId])).rows[0];
  cfgRow && !cfgRow.page_token_enc.includes('EAAG-fake') ? ok('Page token lưu MÃ HOÁ, không phải chữ thường') : bad('token Trang lưu thô!', cfgRow?.page_token_enc?.slice(0, 40));
  const sysKey = (await owner.query('SELECT system_owned FROM shop_api_keys WHERE id=$1', [cfgRow.api_key_id])).rows[0];
  sysKey?.system_owned === true ? ok('khoá của bot đánh dấu system_owned') : bad('khoá bot không đánh dấu hệ thống');
  const keyList = await rq(SELLER, 'GET', `/shops/${A.shopId}/api-keys`, { cookie: A.cookie });
  (keyList.json?.keys ?? []).some((k) => k.id === cfgRow.api_key_id)
    ? bad('khoá của bot LỘ trong danh sách khoá của shop (thu hồi nhầm là bot chết)') : ok('khoá bot KHÔNG hiện trong danh sách khoá thường');

  sect('2. Meta xác minh webhook');
  let g = await fetch(`${MESSENGER}/webhooks/messenger?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=xyz123`);
  (g.status === 200 && (await g.text()) === 'xyz123') ? ok('verify token đúng → trả challenge') : bad(`verify đúng token thất bại (${g.status})`);
  g = await fetch(`${MESSENGER}/webhooks/messenger?hub.mode=subscribe&hub.verify_token=sai-token&hub.challenge=xyz123`);
  g.status === 403 ? ok('verify token sai → 403') : bad(`token sai vẫn qua (${g.status})`);

  sect('3. Chữ ký sai → 403 và KHÔNG gửi gì cho khách');
  drain();
  r = await webhook(pageId, evText('alo'), { badSig: true });
  r.status === 403 ? ok('chữ ký sai → 403') : bad(`chữ ký sai lọt (${r.status})`, r.body);
  await sleep(300);
  drain().count === 0 ? ok('không tin nhắn nào được gửi') : bad('bot GỬI TIN dù chữ ký sai!');

  sect('4. Khách nhắn lần đầu → bot chào + đưa sản phẩm');
  r = await webhook(pageId, evText('shop ơi'));
  await sleep(600);
  let out = drain();
  r.status === 200 && out.count > 0 ? ok(`webhook 200, bot gửi ${out.count} tin`) : bad('bot không trả lời', r.body);
  out.flat.includes('Lan') ? ok('chào đúng TÊN lấy từ hồ sơ Messenger (khách không phải gõ tên)') : bad('không dùng tên khách', out.flat.slice(0, 200));
  out.flat.includes('Áo Thun Trắng') ? ok('hiện sản phẩm ngay (shop ít hàng → bỏ bước danh mục)') : bad('không thấy sản phẩm', out.flat.slice(0, 300));
  out.flat.includes('Mua ngay') ? ok('có nút Mua ngay (SP 1 biến thể → không hỏi chọn loại)') : bad('thiếu nút Mua ngay');

  sect('5. Bấm Mua ngay → vào giỏ + hỏi SĐT (có nút số sẵn)');
  r = await webhook(pageId, evPostback(`PICK:${p1.productId}`));
  await sleep(600);
  out = drain();
  out.flat.includes('Đã thêm') ? ok('đã thêm vào giỏ') : bad('không thêm được vào giỏ', out.flat.slice(0, 300));
  out.flat.includes('user_phone_number') ? ok('hỏi SĐT bằng NÚT có sẵn số của khách (1 chạm)') : bad('không dùng quick reply user_phone_number');

  sect('6. SĐT → địa chỉ → tóm tắt');
  await webhook(pageId, evText('0912345678'));
  await sleep(500);
  out = drain();
  out.flat.includes('Địa chỉ') ? ok('hỏi địa chỉ') : bad('không hỏi địa chỉ', out.flat.slice(0, 200));
  await webhook(pageId, evText('12 Lê Lợi, Phường Bến Nghé, TP Hồ Chí Minh'));
  await sleep(500);
  out = drain();
  out.flat.includes('Đặt hàng') && out.flat.includes('199') ? ok('tóm tắt có tiền + nút Đặt hàng') : bad('tóm tắt sai', out.flat.slice(0, 400));

  sect('6b. Phí ship THẬT trong tóm tắt + đổi số lượng ngay tại đó');
  // Phí ship phải là SỐ, không phải "tính sau": đây là màn hình cuối trước khi mất tiền.
  // Và nó phải bằng đúng số hệ thống sẽ thu — khẳng định chéo ở mục 7.
  out.flat.includes('Phí giao') && /229/.test(out.flat)
    ? ok('tóm tắt hiện phí ship thật + TỔNG 229.000₫ (199k hàng + 30k ship)') : bad('tóm tắt thiếu phí ship thật', out.flat.slice(0, 400));
  out.flat.includes('Thêm 1') ? ok('có nút ➕ Thêm 1 ngay ở tóm tắt (1 chạm)') : bad('thiếu nút tăng số lượng', out.flat.slice(0, 300));
  const qrOf = (flat, re) => re.exec(flat)?.[1];
  const plusPayload = qrOf(out.flat, /"payload":"(QTYP:[^"]+)"/);
  plusPayload ? ok('nút tăng mang đúng biến thể') : bad('không thấy payload QTYP');
  await webhook(pageId, evQuick(plusPayload));
  await sleep(700);
  out = drain();
  out.flat.includes('× 2') && /398/.test(out.flat)
    ? ok('➕ → ×2, tiền hàng 398.000₫ (tính lại đúng)') : bad('tăng số lượng sai', out.flat.slice(0, 400));
  out.flat.includes('Bớt 1') ? ok('có nút ➖ Bớt 1 khi SL > 1') : bad('thiếu nút giảm');
  const minusPayload = qrOf(out.flat, /"payload":"(QTYM:[^"]+)"/);
  await webhook(pageId, evQuick(minusPayload));
  await sleep(700);
  out = drain();
  out.flat.includes('× 1') && /229/.test(out.flat)
    ? ok('➖ → về ×1, TỔNG 229.000₫') : bad('giảm số lượng sai', out.flat.slice(0, 400));
  // Vượt tồn phải chặn NGAY tại chỗ, không để khách bấm sướng tay rồi ăn lỗi ở bước cuối.
  for (let i = 0; i < 12; i++) { await webhook(pageId, evQuick(plusPayload)); await sleep(220); }
  out = drain();
  /chỉ còn 10/.test(out.flat) ? ok('bấm quá tồn → báo "chỉ còn 10 cái" tại chỗ') : bad('không chặn vượt tồn', out.flat.slice(-400));
  // Đưa về lại 1 để mục 7 kiểm đúng reserve +1.
  for (let i = 0; i < 9; i++) { await webhook(pageId, evQuick(minusPayload)); await sleep(220); }
  out = drain();
  out.flat.includes('× 1') ? ok('bớt về ×1, giỏ không bị xoá nhầm') : bad('giảm về 1 sai', out.flat.slice(-300));

  sect('7. Bấm Đặt hàng → ĐƠN THẬT');
  const invBefore = (await owner.query('SELECT reserved FROM inventory_levels WHERE variant_id=$1', [p1.variantId])).rows[0];
  const placeEv = evQuick('PLACE');
  r = await webhook(pageId, placeEv);
  await sleep(900);
  out = drain();
  const ordRows = (await owner.query(`SELECT id, order_number, source, source_ref, api_key_id, total_vnd FROM orders WHERE shop_id=$1`, [A.shopId])).rows;
  ordRows.length === 1 ? ok(`tạo ĐÚNG 1 đơn thật #${ordRows[0].order_number}`) : bad(`số đơn sai: ${ordRows.length}`);
  ordRows[0]?.source === 'facebook' ? ok("source ghi 'facebook'") : bad(`source sai: ${ordRows[0]?.source}`);
  String(ordRows[0]?.source_ref ?? '').includes(PSID) ? ok('source_ref mang PSID (mở lại đúng đoạn chat)') : bad(`source_ref sai: ${ordRows[0]?.source_ref}`);
  ordRows[0]?.api_key_id === cfgRow.api_key_id ? ok('đơn đóng dấu khoá của bot') : bad('api_key_id sai');
  const invAfter = (await owner.query('SELECT reserved FROM inventory_levels WHERE variant_id=$1', [p1.variantId])).rows[0];
  Number(invAfter.reserved) === Number(invBefore.reserved) + 1 ? ok('trừ tồn (reserve +1)') : bad(`tồn sai: ${invBefore.reserved}→${invAfter.reserved}`);
  out.flat.includes('thành công') && out.flat.includes(String(ordRows[0].order_number))
    ? ok('bot báo khách mã đơn') : bad('không báo mã đơn cho khách', out.flat.slice(0, 300));
  // KHẲNG ĐỊNH CHÉO quan trọng nhất của mục phí ship: con số bot HỨA ở tóm tắt (229.000₫)
  // phải bằng đúng con số hệ thống THU. Hai chỗ tính riêng là hai chỗ để lệch.
  Number(ordRows[0]?.total_vnd) === 229000
    ? ok('tổng tiền trên ĐƠN = tổng bot đã hứa (229.000₫)') : bad(`bot hứa 229.000₫ nhưng đơn thu ${ordRows[0]?.total_vnd}`);

  sect('8. Meta gửi LẠI cùng webhook → KHÔNG đẻ đơn thứ hai');
  await webhook(pageId, placeEv);
  await sleep(800);
  drain();
  const n2 = (await owner.query('SELECT count(*)::int n FROM orders WHERE shop_id=$1', [A.shopId])).rows[0].n;
  n2 === 1 ? ok('vẫn đúng 1 đơn (idempotency chặn)') : bad(`gửi lại đẻ thêm đơn: tổng ${n2}`);

  sect('9. Gặp nhân viên → bot IM');
  await webhook(pageId, evQuick('HUMAN'));
  await sleep(500);
  out = drain();
  out.flat.includes('nhân viên') ? ok('bot báo chuyển cho người thật') : bad('không phản hồi handoff', out.flat.slice(0, 200));
  await webhook(pageId, evText('còn màu khác không shop'));
  await sleep(500);
  drain().count === 0 ? ok('sau handoff, bot KHÔNG chen vào nữa') : bad('bot vẫn trả lời dù đã giao cho nhân viên!');

  sect('9b. Worker dọn phiên nguội (PII không nằm lại mãi)');
  // Phiên giữ SĐT + địa chỉ khách. Đẩy updated_at về quá khứ rồi gọi sweep: dòng CŨ phải
  // biến mất, dòng ĐANG DÙNG phải còn — quét mà cuốn cả phiên sống là cắt ngang khách.
  const oldPsid = 'psid-old-' + uniq();
  await owner.query(
    `INSERT INTO messenger_sessions (shop_id, psid, state, last_customer, updated_at)
     VALUES ($1, $2, '{}'::jsonb, '{"phone":"0900000001"}'::jsonb, now() - interval '200 days')`,
    [A.shopId, oldPsid],
  );
  const gc = await fetch(`${process.env.WORKER_URL ?? 'http://worker:3080'}/internal/messenger-gc`, { method: 'POST' });
  const gcJson = gc.ok ? await gc.json() : null;
  const oldLeft = (await owner.query('SELECT count(*)::int n FROM messenger_sessions WHERE psid=$1', [oldPsid])).rows[0].n;
  const liveLeft = (await owner.query('SELECT count(*)::int n FROM messenger_sessions WHERE psid=$1', [PSID])).rows[0].n;
  gc.ok && Number(gcJson?.deleted) >= 1 && oldLeft === 0
    ? ok(`worker xoá phiên nguội (${gcJson.deleted} dòng)`) : bad('phiên 200 ngày tuổi VẪN còn', JSON.stringify(gcJson));
  liveLeft === 1 ? ok('phiên đang dùng KHÔNG bị cuốn theo') : bad('quét xoá nhầm phiên đang hoạt động!');

  sect('10. Trang lạ + ngắt kết nối');
  drain();
  r = await webhook('999999999999999', evText('hello'));
  await sleep(400);
  r.status === 200 && drain().count === 0 ? ok('Trang chưa kết nối → im lặng, không lỗi') : bad('Trang lạ gây phản ứng lạ', r.body);
  r = await rq(SELLER, 'DELETE', `/shops/${A.shopId}/messenger`, { cookie: A.cookie, origin: OS });
  const left = (await owner.query('SELECT count(*)::int n FROM messenger_sessions WHERE shop_id=$1', [A.shopId])).rows[0].n;
  r.status === 200 && left === 0 ? ok('ngắt kết nối xoá cả phiên hội thoại (PII khách không nằm lại)') : bad(`ngắt kết nối chưa dọn phiên: còn ${left}`);
  const revoked = (await owner.query('SELECT revoked_at FROM shop_api_keys WHERE id=$1', [cfgRow.api_key_id])).rows[0];
  revoked?.revoked_at ? ok('khoá của bot bị thu hồi theo') : bad('khoá bot còn sống sau khi ngắt kết nối!');

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  graph.close();
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
