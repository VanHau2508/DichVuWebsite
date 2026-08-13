/**
 * E2E EMAIL NÓI VỀ TIỀN (docs/68).
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/worker/test/email-tien.e2e.mjs
 *
 * Khách đọc EMAIL trước, mở link sau. Trang tra cứu và lịch sử đơn đã nói đủ ba con số
 * (docs/67) nhưng email báo "đơn đã hoàn hàng" vẫn chỉ nói TRẠNG THÁI — để khách phải bấm
 * thêm một bước mới biết mình được trả bao nhiêu.
 *
 * HAI THỨ SAI Ở BẢN CŨ, bộ này canh cả hai:
 *   1. CHỈ đơn 'cancelled' mới nhắc tiền. Đơn ĐÃ TRẢ HÀNG / ĐÃ HOÀN TIỀN thì email im lặng
 *      hoàn toàn — khách vừa gửi hàng đi, đọc thư chỉ thấy đổi trạng thái.
 *   2. Số tiền lấy từ `refund_due_vnd` do nhánh huỷ tự tính = `total_vnd`. Đơn đã hoàn MỘT
 *      PHẦN rồi mới huỷ thì email HỨA hoàn nguyên tổng đơn — nhiều hơn số shop còn nợ. Một
 *      lời hứa sai bằng chữ, gửi thẳng vào hộp thư, là thứ khó rút lại nhất.
 *
 * Phần 2 là ca QUYẾT ĐỊNH: ở mọi ca khác `total_vnd` và số-còn-nợ bằng nhau, nên một công
 * thức lấy nhầm vẫn xanh trơn.
 */
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://mailpit:8025';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const inviteTokenOf = async (e) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [e]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', BOLD = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${String(d).slice(0, 240)}${X}`); };
const sect = (m) => console.log(`\n${BOLD}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };
// PHẢI khớp ĐÚNG bộ định dạng của worker: nó dùng 'đ' (chữ cái), còn giao diện web dùng '₫'
// (ký hiệu tiền tệ U+20AB). Hai ký tự khác nhau, mắt người đọc gần như không phân biệt được.
// Đây là bẫy đã ghi trong docs/50 và tôi vẫn vấp lại — mọi khẳng định về số tiền trong email
// đỏ hết trong khi nội dung email hoàn toàn đúng.
const money = (v) => new Intl.NumberFormat('vi-VN').format(Number(v)) + 'đ';

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

// ── Mailpit ─────────────────────────────────────────────────────────────────
const mpClear = () => fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' }).catch(() => null);
async function mpTim(toEmail, chua, { hanGiay = 25 } = {}) {
  // Chờ worker gom outbox → SMTP. Tìm theo ĐỊA CHỈ NHẬN + một mẩu chữ bắt buộc, thay vì lấy
  // "thư mới nhất": chạy song song với bộ khác thì thư mới nhất có thể của người khác.
  for (let i = 0; i < hanGiay * 2; i++) {
    const list = await (await fetch(`${MAILPIT}/api/v1/messages?limit=200`)).json().catch(() => ({}));
    for (const m of list.messages ?? []) {
      if (!(m.To ?? []).some((t) => t.Address === toEmail)) continue;
      const full = await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json().catch(() => null);
      if (!full) continue;
      const noiDung = `${full.Subject ?? ''}\n${full.Text ?? ''}\n${full.HTML ?? ''}`;
      if (!chua || noiDung.includes(chua)) return { subject: full.Subject ?? '', body: noiDung };
    }
    await sleep(500);
  }
  return null;
}

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
  const slug = `mail-${uniq()}`;
  const shopId = (await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO })).json.id;
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  const api = await login(oe, op);
  const ui = ck((await adm('POST', '/login', { form: new URLSearchParams({ email: oe, password: op }) })).sc);
  const S = {
    get: (p) => rq(SELLER, 'GET', `/shops/${shopId}${p}`, { cookie: api }),
    post: (p, b) => rq(SELLER, 'POST', `/shops/${shopId}${p}`, { body: b, cookie: api, origin: OS }),
    patch: (p, b) => rq(SELLER, 'PATCH', `/shops/${shopId}${p}`, { body: b, cookie: api, origin: OS }),
  };
  await S.patch('', { name: slug, max_pending_per_phone: 999, max_pending_per_ip: 999 });
  const pr = await S.post('/products', { title: 'Áo email', slug: `ao-${uniq()}`, price_vnd: 400000, status: 'active', variants: [{ sku: `ML-${uniq()}`, price_vnd: 400000 }] });
  const vid = (await S.get(`/products/${pr.json.id}`)).json.variants[0].id;
  await S.post(`/variants/${vid}/inventory/adjust`, { delta: 200, reason: 'nhập' });
  const A = (oid, act, f = {}) => adm('POST', `/shops/${shopId}/orders/${oid}/${act}`, { cookie: ui, form: new URLSearchParams(f) });
  const markPaid = (oid) => adm('POST', `/shops/${shopId}/orders/${oid}/mark-paid/step-up`, {
    cookie: ui, form: new URLSearchParams({ password: op }),
  });
  const datDon = async () => {
    const email = `kh-${uniq()}@khach.vn`;
    const o = (await S.post('/orders', {
      lines: [{ variant_id: vid, qty: 1 }],
      customer: { name: 'Khách email', phone: `09${Math.floor(10000000 + Math.random() * 89999999)}`, email, address_line: '1 Lê Lợi', province: 'Hà Nội' },
      payment_method: 'cod', idempotency_key: `ml-${uniq()}`,
    })).json;
    return { ...o, email };
  };
  const owedCua = async (oid) => Number((await rq(SELLER, 'GET', `/shops/${shopId}/orders/${oid}`, { cookie: api })).json.owed_vnd);
  await mpClear();
  ui ? ok('dựng shop + đăng nhập quản trị + xoá hộp thư') : bad('không dựng được', '');

  // ── 1. HUỶ ĐƠN ĐÃ THU TIỀN ───────────────────────────────────────────────
  sect('1. Huỷ đơn khách đã trả tiền — email phải nói số tiền sẽ được hoàn');
  const d1 = await datDon();
  await A(d1.id, 'confirm'); await markPaid(d1.id);
  await A(d1.id, 'cancel', { reason: 'hết hàng' });
  const m1 = await mpTim(d1.email, 'đã huỷ');
  m1 ? ok(`nhận được email "${m1.subject}"`) : bad('không thấy email huỷ', '');
  if (m1) {
    const no1 = await owedCua(d1.id);
    m1.body.includes(`Bạn đã thanh toán ${money(d1.total_vnd)}`) ? ok(`nói rõ đã thanh toán ${money(d1.total_vnd)}`) : bad('không nhắc số đã trả', m1.body.slice(0, 200));
    m1.body.includes(`Cửa hàng còn phải hoàn ${money(no1)}`) ? ok(`và còn phải hoàn ${money(no1)} — đúng số shop thấy`) : bad(`không khớp số còn nợ ${money(no1)}`, m1.body.slice(0, 200));
    /liên hệ cửa hàng kèm số đơn/.test(m1.body) ? ok('có lối ra kèm số đơn') : bad('không có lối ra', '');
  }

  // ── 2. HOÀN MỘT PHẦN RỒI MỚI HUỶ — ca quyết định ─────────────────────────
  sect('2. Hoàn một phần RỒI mới huỷ — bản cũ hứa nguyên tổng đơn');
  const d2 = await datDon();
  await A(d2.id, 'confirm'); await markPaid(d2.id);
  await adm('POST', `/shops/${shopId}/orders/${d2.id}/refund/step-up`,
    { cookie: ui, form: new URLSearchParams({ password: op, amount_vnd: '150000', reason: 'trả trước một phần' }) });
  await A(d2.id, 'cancel', { reason: 'khách đổi ý' });
  const no2 = await owedCua(d2.id);
  const m2 = await mpTim(d2.email, 'đã huỷ');
  m2 ? ok('nhận được email huỷ') : bad('không thấy email', '');
  if (m2) {
    no2 > 0 && no2 < Number(d2.total_vnd)
      ? ok(`dựng đúng ca: còn nợ ${money(no2)} < tổng đơn ${money(d2.total_vnd)} (bản cũ sẽ hứa nhầm tổng đơn)`)
      : bad(`ca sai: còn nợ ${no2} vs tổng ${d2.total_vnd}`, '');
    m2.body.includes(`Cửa hàng còn phải hoàn ${money(no2)}`)
      ? ok(`email hứa ĐÚNG ${money(no2)}, không phải tổng đơn`) : bad('hứa sai số', m2.body.slice(0, 240));
    !m2.body.includes(`Cửa hàng còn phải hoàn ${money(d2.total_vnd)}`)
      ? ok(`và KHÔNG hề nhắc ${money(d2.total_vnd)} như một khoản sẽ hoàn`) : bad('vẫn hứa nguyên tổng đơn', '');
    m2.body.includes(`Cửa hàng đã hoàn lại ${money(150000)}`)
      ? ok('kể cả phần đã hoàn trước đó cũng được nêu') : bad('bỏ qua phần đã hoàn', m2.body.slice(0, 240));
  }

  // ── 3. BOM HÀNG — trước đây email im lặng về tiền ────────────────────────
  sect('3. Khách trả hàng về (bom hàng) — trước đây email không nhắc tiền một chữ');
  const d3 = await datDon();
  await A(d3.id, 'confirm'); await markPaid(d3.id);
  await A(d3.id, 'ship', { tracking_number: `TN${uniq()}` });
  await A(d3.id, 'mark-returned', { restock: 'on' });
  const no3 = await owedCua(d3.id);
  const m3 = await mpTim(d3.email, 'hoàn về cửa hàng');
  m3 ? ok(`nhận được email "${m3.subject}"`) : bad('không thấy email hoàn hàng', '');
  if (m3) {
    m3.body.includes(`Cửa hàng còn phải hoàn ${money(no3)}`)
      ? ok(`email hoàn-hàng nay NÓI VỀ TIỀN: còn phải hoàn ${money(no3)}`) : bad('vẫn im lặng về tiền', m3.body.slice(0, 240));
  }

  // ── 4. HOÀN ĐỦ — nói rõ đã xong, không doạ thêm ──────────────────────────
  sect('4. Hoàn đủ tiền — email nói rõ đã xong');
  const d4 = await datDon();
  await A(d4.id, 'confirm'); await markPaid(d4.id);
  await adm('POST', `/shops/${shopId}/orders/${d4.id}/refund/step-up`,
    { cookie: ui, form: new URLSearchParams({ password: op, reason: 'hoàn đủ' }) });
  const m4 = await mpTim(d4.email, 'đã hoàn tiền');
  m4 ? ok(`nhận được email "${m4.subject}"`) : bad('không thấy email hoàn tiền', '');
  if (m4) {
    m4.body.includes('Cửa hàng đã hoàn đủ khoản bạn thanh toán')
      ? ok('nói rõ đã hoàn ĐỦ') : bad('không xác nhận đã hoàn đủ', m4.body.slice(0, 240));
    !/còn phải hoàn/.test(m4.body) ? ok('và KHÔNG doạ thêm khoản nào') : bad('vẫn nói còn nợ', '');
  }

  // ── 5. ĐƠN CÒN SỐNG — không được chèn tiền vào ───────────────────────────
  sect('5. Đơn đang giao — email KHÔNG được mọc thêm đoạn tiền');
  const d5 = await datDon();
  await A(d5.id, 'confirm'); await markPaid(d5.id);
  await A(d5.id, 'ship', { tracking_number: `TN${uniq()}` });
  const m5 = await mpTim(d5.email, 'đang trên đường giao');
  m5 ? ok('nhận được email đang giao') : bad('không thấy email giao', '');
  if (m5) {
    !/Bạn đã thanh toán|còn phải hoàn|đã hoàn lại/.test(m5.body)
      ? ok('đơn còn sống: email giữ nguyên như cũ, không chèn chuyện tiền nong') : bad('chèn nhầm vào đơn còn sống', m5.body.slice(0, 240));
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
