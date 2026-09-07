/**
 * ĐO BỀ RỘNG HẸP CHO CÁC *TRẠNG THÁI* CỦA TRANG NHẬP.
 *
 *   node scripts/probe-nhap-360.mjs <shopId> <cookie> [bề_rộng] [js|nojs] <kịch bản> [ảnh.png]
 *
 * Lấy shopId + cookie bằng:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest \
 *     node apps/seller-admin/test/probe-fixture-360.mjs
 *
 * VÌ SAO KHÔNG DÙNG THẲNG probe-360.mjs. Probe kia chỉ GET một URL, mà phần dễ vỡ nhất của
 * trang nhập chỉ tồn tại SAU một POST: bảng lỗi từng dòng, dòng trần gói, khối "lượt nhập dừng
 * giữa chừng", interstitial xác nhận thiếu mã đơn. Đo mỗi form rỗng là đo trạng thái ÍT vỡ nhất
 * rồi tuyên bố cả trang đạt.
 *
 * Lái FORM THẬT (tải tệp + bấm đúng nút), không dựng HTML giả — và KHÔNG chép lại phép đo:
 * `doTranNgang` import từ probe-360.mjs, để kiến thức về các bẫy chỉ có ĐÚNG MỘT bản.
 *
 * BẪY ĐÃ ĐO Ở CHÍNH DRIVER NÀY: nút "Nhập thật" mang `data-confirm`, ADMIN_JS biến nó thành
 * `confirm()` thật, mà Playwright mặc định TỰ HUỶ mọi dialog ⇒ form không gửi, driver hết giờ
 * chờ điều hướng. Lần đầu nó suýt bị đọc thành lỗi bố cục — thật ra là CHỐT SẢN PHẨM đang chạy
 * đúng. Driver phải bấm Đồng ý, không né.
 */
import { doTranNgang, tiemKhoiRong, CHROME_SHELL, argsCho } from './probe-360.mjs';
import fs from 'node:fs';

const PW = '/opt/node22/lib/node_modules/playwright/index.js';
const pw = await import(PW);
const { chromium } = pw.default ?? pw;

const [, , SHOP, COOKIE, wArg, mode, kichBan, shot] = process.argv;
const W = Number(wArg ?? 360);
const JS = mode !== 'nojs';
const HOST = 'admin.localtest:8443';
const BASE = `https://${HOST}/shops/${SHOP}`;

// ── Tệp thử ────────────────────────────────────────────────────────────────
const spOk = () => { let c = 'handle,title,status,sku,price_vnd\n';
  for (let i = 1; i <= 3; i++) c += `ok-${i},Áo thun cổ tròn nam size lớn mẫu ${i},draft,SKU-OK-${i},199000\n`;
  return c; };
const spLoi = () => 'handle,title,status,sku,price_vnd\n'
  + 'g-1,Áo khoác dạ nữ dáng dài Hàn Quốc mùa đông bản giới hạn,draft,SKU-G1,199000\n'
  + 'g-2,Quần jean ống suông,draft,SKU-G2,khong-phai-so\n'
  + 'g-3,Giày,draft,SKU-G3,-500\n';
const spTran = () => { let c = 'handle,title,status,sku,price_vnd\n';
  for (let i = 1; i <= 212; i++) c += `t-${i},Sản phẩm số ${i},draft,SKU-T-${i},199000\n`;
  return c; };
const donOk = () => 'order_code,date,customer_name,customer_phone,total_vnd,status\n'
  + 'DH-001,2026-01-05,Nguyễn Thị Hoa,0912345678,450000,delivered\n'
  + 'DH-002,2026-01-06,Trần Văn Minh,0912345679,1250000,delivered\n';
const donThieuMa = () => 'date,customer_name,customer_phone,total_vnd,status\n'
  + '2026-01-05,Nguyễn Thị Hoa,0912345678,450000,delivered\n'
  + '2026-01-06,Trần Văn Minh,0912345679,1250000,delivered\n'
  + '2026-01-07,Lê Thị Bích Ngọc Hạnh,0912345670,320000,delivered\n';
const donLoi = () => 'order_code,date,customer_name,customer_phone,total_vnd,status\n'
  + 'DH-101,2026-01-05,Nguyễn Thị Hoa,0912345678,450000,delivered\n'
  + 'DH-102,khong-phai-ngay,Trần Văn Minh,0912345679,rac,delivered\n';

const KB = {
  'sp-rong':     { url: `${BASE}/products/import`, csv: null },
  'sp-xemtruoc': { url: `${BASE}/products/import`, csv: spOk(),   nut: 'preview' },
  'sp-loi':      { url: `${BASE}/products/import`, csv: spLoi(),  nut: 'preview' },
  'sp-tran':     { url: `${BASE}/products/import`, csv: spTran(), nut: 'preview' },
  'don-rong':    { url: `${BASE}/orders/import`,   csv: null },
  'don-xemtruoc':{ url: `${BASE}/orders/import`,   csv: donOk(),      nut: 'preview' },
  'don-loi':     { url: `${BASE}/orders/import`,   csv: donLoi(),     nut: 'preview' },
  'don-xacnhan': { url: `${BASE}/orders/import`,   csv: donThieuMa(), nut: 'commit' },
};
const kb = KB[kichBan];
if (!kb) { console.error(`kịch bản lạ: ${kichBan}. Có: ${Object.keys(KB).join(', ')}`); process.exit(2); }

const browser = await chromium.launch({ executablePath: CHROME_SHELL, args: argsCho('admin.localtest') });
const ctx = await browser.newContext({ viewport: { width: W, height: 820 }, javaScriptEnabled: JS, ignoreHTTPSErrors: true });
await ctx.addCookies([{ name: '__Host-session', value: COOKIE, url: `https://admin.localtest/` }]);
const page = await ctx.newPage();
// Nút "Nhập thật" mang data-confirm; ADMIN_JS biến nó thành confirm() thật. Playwright mặc
// định TỰ HUỶ mọi dialog, nên form không gửi và driver hết giờ chờ điều hướng — đo được đúng
// một lần và suýt bị đọc thành lỗi bố cục. Đó là CHỐT SẢN PHẨM đang chạy đúng, nên driver phải
// bấm Đồng ý, không phải né nó. (Tắt JS thì không có confirm — đường đó dựa vào chốt 409 ở
// seller, đúng thiết kế.)
page.on('dialog', (d) => d.accept());
await page.goto(kb.url, { waitUntil: 'networkidle' });

if (kb.csv) {
  const tep = `/tmp/nhap360/${kichBan}.csv`;
  fs.writeFileSync(tep, kb.csv);
  await page.setInputFiles('input[type=file][name=file]', tep);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click(`button[name=mode][value=${kb.nut}]`),
  ]);
}
if (process.env.PROBE_TIEM === '1') await tiemKhoiRong(page);

const kq = await doTranNgang(page, Number(process.env.PROBE_EXPECT ?? W));
// In kèm một MẨU chữ của trang để tự tố giác khi driver đo nhầm trang (bị đá về đăng nhập,
// hay form không nộp được): "0 tràn" trên trang đăng nhập là xanh giả hoàn hảo.
kq.tieuDe = (await page.title()).slice(0, 60);
kq.dauHieu = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 110);
if (shot) await page.screenshot({ path: shot, fullPage: true });
console.log(JSON.stringify(kq));
await browser.close();
process.exit(kq.tuChoi || kq.soTran > 0 ? 1 : 0);
