/**
 * SOI CẤU TRÚC HTML MỌI MÀN ADMIN — tìm lớp lỗi "trình duyệt LẶNG LẼ bỏ qua".
 *
 * Vì sao cần: e2e khẳng định "nút CÓ MẶT" và HTML thì luôn có nút. Nhưng nếu `form="x"`
 * trỏ tới một id không tồn tại, trình duyệt BỎ HẲN ô đó khỏi form khi gửi — không cảnh
 * báo, không lỗi, test vẫn xanh, người dùng bấm thì mất dữ liệu. Đợt 4 đã dính đúng cái
 * này với ô lọc đơn và nút phí ship. Đây là bộ dò tự động cho cả họ lỗi đó.
 *
 * env: AUDIT_SLUG / AUDIT_EMAIL / AUDIT_PW
 */
import { ADMIN, AUTH, OADM, OA, owner, http, sessionOf, ok, warn, bad, sect, summary } from './lib.mjs';

const EMAIL = process.env.AUDIT_EMAIL, PW = process.env.AUDIT_PW, SLUG = process.env.AUDIT_SLUG;

const MAN = [
  'overview', 'orders', 'cod', 'export', 'products', 'categories', 'reviews', 'questions',
  'purchasing', 'stocktakes', 'shipping', 'promotions', 'coupons', 'loyalty', 'affiliates',
  'customers', 'reports', 'api-keys', 'domains', 'theme', 'pages', 'blog', 'payment',
  'settings', 'notify', 'members', 'audit-log', 'help', 'billing',
];

// Gỡ thẻ <style> và <script> trước khi soi: tên lớp CSS và chú thích trong đó khớp nhầm
// mọi regex — đã mất một vòng chẩn đoán vì "id" trong chú thích CSS.
const bodyOf = (html) => html
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<!--[\s\S]*?-->/g, '');

const attrs = (h, tag) => [...h.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'gi'))].map((m) => m[1]);
const val = (a, name) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(a)?.[1] ?? null;

function soi(html) {
  const h = bodyOf(html);
  const ids = [...h.matchAll(/\bid\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  const idSet = new Set(ids);
  const loi = [];

  // 1. form="X" trỏ id không tồn tại → trình duyệt BỎ HẲN ô đó khỏi dữ liệu gửi đi.
  for (const tag of ['input', 'select', 'textarea', 'button']) {
    for (const a of attrs(h, tag)) {
      const f = val(a, 'form');
      if (f && !idSet.has(f)) loi.push(`<${tag} form="${f}"> → KHÔNG có form nào mang id đó (ô bị bỏ khi gửi)`);
    }
  }
  // 2. id TRÙNG: form="X" và label for="X" chỉ bắt cái ĐẦU TIÊN → nút thứ hai vô hiệu.
  const dup = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
  for (const d of dup) loi.push(`id="${d}" xuất hiện ${ids.filter((x) => x === d).length} lần (form=/label for= chỉ trỏ cái đầu)`);

  // 3. label for="X" không có ô nào mang id đó → bấm nhãn không focus, và với
  //    radio/checkbox no-JS thì nhãn là VÙNG BẤM DUY NHẤT.
  for (const a of attrs(h, 'label')) {
    const f = val(a, 'for');
    if (f && !idSet.has(f)) loi.push(`<label for="${f}"> → không có ô nào mang id đó (bấm nhãn không ăn)`);
  }
  // 4. href="#neo" mà không có neo → bấm xong đứng yên, người dùng tưởng hỏng.
  const neo = new Set([...idSet, ...[...h.matchAll(/\bname\s*=\s*"([^"]+)"/g)].map((m) => m[1])]);
  for (const a of attrs(h, 'a')) {
    const href = val(a, 'href');
    if (href && href.startsWith('#') && href.length > 1 && !neo.has(href.slice(1))) {
      loi.push(`<a href="${href}"> → không có neo nào tên đó`);
    }
  }
  // 5. <form method=POST> thiếu action → gửi về chính URL hiện tại. Đôi khi cố ý, nhưng
  //    trên trang có tham số lọc (?status=…) thì gửi kèm cả tham số cũ — đáng soi.
  for (const a of attrs(h, 'form')) {
    const m = (val(a, 'method') ?? 'get').toLowerCase();
    if (m === 'post' && !val(a, 'action')) loi.push('<form method="POST"> thiếu action (gửi về đúng URL hiện tại, kèm mọi tham số lọc)');
  }
  // 6. <button> KHÔNG nằm trong <form> nào và KHÔNG có form= → bấm không làm gì (no-JS).
  const ngoaiForm = h.split(/<form\b/i)[0];
  for (const a of attrs(ngoaiForm, 'button')) {
    const t = (val(a, 'type') ?? 'submit').toLowerCase();
    if (t === 'submit' && !val(a, 'form')) loi.push('<button type=submit> nằm NGOÀI mọi form và không có form= (bấm không làm gì)');
  }
  return { loi, soId: ids.length, soForm: attrs(h, 'form').length };
}

async function main() {
  const shop = (await owner.query('SELECT id FROM shops WHERE slug=$1', [SLUG])).rows[0];
  const ck = sessionOf((await http(AUTH, '/auth/login', { method: 'POST', body: { email: EMAIL, password: PW }, origin: OA, host: 'auth.localtest' })).sc);
  if (!ck) { bad('không đăng nhập được'); summary(); await owner.end(); return; }
  ok(`đăng nhập · shop ${SLUG}`);

  sect(`Soi cấu trúc ${MAN.length} màn admin`);
  let tongLoi = 0;
  for (const m of MAN) {
    const r = await http(ADMIN, `/shops/${shop.id}/${m}`, { cookie: ck, host: 'admin.localtest' });
    if (r.status !== 200) { bad(`/${m} → HTTP ${r.status}`, r.text.slice(0, 160)); continue; }
    const { loi, soId, soForm } = soi(r.text);
    if (!loi.length) ok(`/${m} sạch (${soForm} form, ${soId} id)`);
    else { tongLoi += loi.length; bad(`/${m} — ${loi.length} chỗ`, loi.join('\n       ')); }
  }
  console.log(`\n  tổng ${tongLoi} chỗ cần xem`);
  summary();
  await owner.end();
}
main().catch((e) => { console.error('VỠ:', e); process.exit(2); });
