/**
 * PROBE BỀ RỘNG HẸP cho trang seller-admin (và mọi trang cần cookie phiên).
 *
 *   node scripts/probe-360.mjs <url> <cookie> [bề_rộng] [js|nojs] [ảnh.png]
 *
 * (Kho KHÔNG có node_modules ở gốc và ESM không đọc `NODE_PATH`, nên playwright được nạp theo
 *  ĐƯỜNG DẪN — đè bằng `PLAYWRIGHT_MODULE` nếu máy khác chỗ. Máy có proxy chặn TLS thì thêm
 *  `NO_PROXY='*'` và bỏ HTTP(S)_PROXY, không thì Chromium bị proxy nuốt mất kết nối tới caddy.)
 *
 * Ví dụ (cookie lấy từ một bộ e2e hoặc từ trình duyệt):
 *   node scripts/probe-360.mjs \
 *     https://admin.localtest:8443/shops/<id>/media-failures "$CK" 360 nojs /tmp/a.png
 *
 * VÌ SAO TỆP NÀY NẰM TRONG KHO. Ba lượt đo 360px trước đều dựng probe tạm rồi bỏ đi, nên mỗi
 * lượt lại giẫm lại đúng những cái bẫy dưới đây — và một lượt đã chạy TRỌN ở sai khung nhìn
 * trước khi bị phát hiện. Kiến thức đắt thì phải nằm trong mã, không nằm trong trí nhớ.
 *
 * NĂM BẪY ĐÃ ĐO ĐƯỢC, mỗi cái là một dòng mã ở dưới:
 *
 *  1. `chrome --headless` (new headless) BỎ QUA bề rộng yêu cầu và luôn dựng khung nhìn 500px.
 *     Dấu hiệu: mọi trang ra CÙNG một con số. Phải dùng `headless_shell`, và probe TỰ CHỐI trả
 *     số khi `innerWidth` khác giá trị mong đợi thay vì lặng lẽ trả một con số sai.
 *     `PROBE_EXPECT` tách "bề rộng mong đợi" khỏi "bề rộng đặt" — chỉ khi tách được hai thứ đó
 *     mới đột biến được chính chốt tự-chối.
 *
 *  2. So `scrollWidth` với `clientWidth`, KHÔNG với `innerWidth`: `innerWidth` tính cả thanh
 *     cuộn (360 → khung thật 345), nên ngưỡng đặt theo nó bỏ lọt mọi tràn trong 345–361px.
 *
 *  3. Tha tổ tiên `overflow-x: auto|scroll` — băng thẻ cuộn ngang là cách xử lý nội dung rộng
 *     mà chính sổ tay yêu cầu; đếm thẳng `right > vw` sẽ báo đỏ giả cho nó.
 *
 *  4. KHÔNG tha `hidden`/`clip`. `body{overflow-x:hidden}` biến TRÀN thành CẮT CỤT: nội dung
 *     vượt mép bị xén, trang không cuộn ngang, `scrollWidth === clientWidth` và phép đo báo
 *     ĐẠT trong khi nút menu đã bị cắt mất. Nên phần tử bị cắt vẫn bị TÍNH, chỉ bỏ qua khi
 *     khối cắt rộng ≤2px (kiểu chỉ-đọc-màn-hình — cắt cố ý).
 *
 *  5. `PROBE_TIEM=1` chèn một khối 3000px ngoài mọi khối cuộn. Sửa probe xong thì chạy lại với
 *     biến này: nếu nó KHÔNG bắt được thì probe vừa tự mở một điểm mù.
 *
 * VÀ ĐIỀU QUAN TRỌNG NHẤT, ghi ở đây vì nó không tự động hoá được: **ĐO KHÔNG PHẢI LÀ NHÌN.**
 * Một trang đạt 0 tràn ở mọi bề rộng vẫn có thể vô dụng — trang này lần đầu đạt 0/6 trong khi
 * URL nguồn hiện ra đúng `http://127.0.0.…`, tức mất sạch thứ nó tồn tại để nói. Luôn chụp
 * ảnh và MỞ RA XEM trước khi báo xong.
 */
const PW_MODULE = process.env.PLAYWRIGHT_MODULE ?? '/opt/node22/lib/node_modules/playwright/index.js';
// playwright là CommonJS: `import()` một tệp CJS đưa export vào `.default`, còn export tên có
// thể không được phát hiện. Đọc cả hai chỗ thay vì đoán.
const pw = await import(PW_MODULE);
const chromium = pw.chromium ?? pw.default?.chromium;
if (!chromium) { console.error(`không nạp được playwright từ ${PW_MODULE}`); process.exit(2); }

// ĐO TRÀN NGANG — dùng chung cho CLI dưới đây VÀ cho các driver phải nộp form trước khi đo
// (trang nhập chỉ lộ bảng lỗi / khối cảnh báo SAU một POST). Export ra thay vì chép lại: hai bản
// của cùng một phép đo là hai bản sẽ trôi, và bản trôi ở đây nghĩa là một điểm mù im lặng.
export async function doTranNgang(page, wMong) {
  return page.evaluate((wM) => {
    const iw = window.innerWidth;
    if (iw !== wM) return { tuChoi: `innerWidth=${iw} khác ${wM} — phép đo TỪ CHỐI trả số` };
    const de = document.documentElement;
    const cw = de.clientWidth;
    const chaCuonDuoc = (el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
      }
      return false;
    };
    const bicat = (el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if ((ox === 'hidden' || ox === 'clip') && p.getBoundingClientRect().width > 2) return p;
      }
      return null;
    };
    const ten = (el) => el.tagName.toLowerCase()
      + (el.id ? `#${el.id}` : '')
      + (typeof el.className === 'string' && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : '');
    const tran = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.right <= cw + 0.5 && r.left >= -0.5) continue;
      if (chaCuonDuoc(el)) continue;
      const cat = bicat(el);
      tran.push({ el: ten(el), left: Math.round(r.left), right: Math.round(r.right), catBoi: cat ? ten(cat) : null });
    }
    return { iw, cw, scrollWidth: de.scrollWidth, cuonNgang: de.scrollWidth - cw,
      soTran: tran.length, tran: tran.slice(0, 25), bodyOverflowX: getComputedStyle(document.body).overflowX };
  }, wMong);
}

/** Chèn khối 3000px ngoài mọi khối cuộn — đột biến CHÍNH probe. */
export const tiemKhoiRong = (page) => page.evaluate(() => {
  const d = document.createElement('div');
  d.id = 'dot-bien-probe';
  d.style.cssText = 'width:3000px;height:8px;background:red';
  document.body.appendChild(d);
});

export const CHROME_SHELL = process.env.PROBE_CHROME
  ?? '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';

/** Tham số launch: caddy phục vụ tên miền .localtest, và proxy của máy phải bị bỏ qua. */
export const argsCho = (hostname) => [`--host-resolver-rules=MAP ${hostname} 127.0.0.1`, '--no-proxy-server'];

// CHẠY THẲNG hay ĐƯỢC IMPORT? Phải hỏi `argv[1]`, không hỏi "có đối số không": khi driver
// import tệp này, `process.argv` là argv CỦA DRIVER — nên kiểm theo đối số sẽ thấy đủ tham số
// rồi chạy luôn khối CLI với đối số của người khác. Đo được: driver truyền shopId ở vị trí 2
// và CLI ném `Invalid URL` trên chính chuỗi UUID đó.
const LA_CLI = /(^|\/)probe-360\.mjs$/.test(process.argv[1] ?? '');
const [, , URL_, COOKIE, wArg, mode, shot] = LA_CLI ? process.argv : [];
if (LA_CLI && (!URL_ || !COOKIE)) {
  console.error('dùng: node scripts/probe-360.mjs <url> <cookie> [bề_rộng] [js|nojs] [ảnh.png]');
  process.exit(2);
}
// ── CLI ────────────────────────────────────────────────────────────────────────
if (LA_CLI) {
  const W = Number(wArg ?? 360);
  const W_MONG = Number(process.env.PROBE_EXPECT ?? W);
  const JS = mode !== 'nojs';
  const u = new URL(URL_);
  const browser = await chromium.launch({ executablePath: CHROME_SHELL, args: argsCho(u.hostname) });
  const ctx = await browser.newContext({
    viewport: { width: W, height: 820 }, javaScriptEnabled: JS, ignoreHTTPSErrors: true,
  });
  await ctx.addCookies([{ name: '__Host-session', value: COOKIE, url: `https://${u.hostname}/` }]);
  const page = await ctx.newPage();
  await page.goto(URL_, { waitUntil: 'networkidle' });
  if (process.env.PROBE_TIEM === '1') await tiemKhoiRong(page);
  const kq = await doTranNgang(page, W_MONG);
  if (shot) await page.screenshot({ path: shot, fullPage: true });
  console.log(JSON.stringify(kq, null, 1));
  await browser.close();
  process.exit(kq.tuChoi || kq.soTran > 0 ? 1 : 0);
}
