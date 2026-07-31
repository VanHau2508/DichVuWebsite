/**
 * Mở shop dev trên điện thoại KHÔNG cần DNS và KHÔNG cần HTTPS.
 *   node scripts/dev-phone-proxy.mjs
 *   → http://<ip-lan>:8801  = shop thứ nhất, 8802 = shop thứ hai, …
 *
 * VÌ SAO CÓ. Đường nip.io + HTTPS đã chết trên một máy thật dù mọi thứ phía máy
 * chủ đều đúng (IP khớp, tường lửa tắt, router phân giải nip.io ra đúng IP, curl
 * tới chính IP LAN trả 200). Thứ còn lại trên đường đi là DNS công cộng và chứng
 * chỉ CA nội bộ — cả hai đều nằm ngoài tầm sửa từ máy này. Bằng chứng quyết định:
 * Mailpit (HTTP thuần, IP trần, cổng lạ) mở được trên chính điện thoại đó.
 *
 * Nên: mỗi shop một CỔNG, HTTP thuần, IP trần. Không tên miền để mà chặn, không
 * chứng chỉ để mà cảnh báo. Proxy chỉ làm một việc — đặt Host header cho đúng
 * shop rồi chuyển tiếp sang Caddy, vì storefront nhận diện shop CHỈ bằng Host.
 *
 * ĐÁNH ĐỔI phải biết: cookie giỏ hàng có cờ Secure nên KHÔNG sống qua HTTP —
 * xem bố cục/màu/ảnh thì đủ, còn thêm-giỏ và thanh toán thì phải dùng đường HTTPS.
 */
import http from 'node:http';
import https from 'node:https';
import { execSync } from 'node:child_process';

const BASE_PORT = Number(process.env.PHONE_PROXY_PORT ?? 8801);
const UPSTREAM = { host: '127.0.0.1', port: 8443 };

// Lấy hostname CHÍNH của từng shop từ DB — chính là Host mà storefront chờ đợi.
// Gửi đúng host này thì quy tắc A5 (host phụ 301 về host chính) không kích hoạt,
// nên không dính cú redirect nuốt mất cổng.
// Lấy hostname CHÍNH bất kể đuôi gì. KHÔNG lọc riêng '.nip.io': tên nip.io chôn
// IP vào trong nó, mà IP thì đổi — chính là thứ proxy này sinh ra để thoát khỏi.
// Với `*.nentang.vn` làm miền chính thì không có gì để lệch theo mạng nữa.
const SHOP_SLUGS = "'demo-fashion','demo-food','demo-furniture','demo-cosmetics','nha-xinh-1nh1va'";
const sql = "SELECT s.slug || '|' || d.hostname FROM shops s JOIN domains d ON d.shop_id = s.id "
  + `WHERE d.is_primary AND s.slug IN (${SHOP_SLUGS}) ORDER BY s.slug`;
const raw = execSync(
  `docker compose -f infra/compose.dev.yml exec -T postgres psql -U app_owner -d app -qtA -c "${sql}"`,
  { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
);
const shops = raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
  const [slug, host] = l.split('|');
  return { slug, host };
});
if (!shops.length) {
  console.error('Chưa có hostname LAN nào. Chạy trước:  bash scripts/dev-lan-host.sh');
  process.exit(1);
}

const lanIp = (() => {
  try {
    return execSync('powershell.exe -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | '
      + "Where-Object { $_.InterfaceAlias -notlike '*WSL*' -and $_.IPAddress -notlike '127.*' -and "
      + "$_.IPAddress -notlike '169.254.*' } | Select-Object -First 1 -ExpandProperty IPAddress)\"",
    { encoding: 'utf8' }).trim();
  } catch { return '<ip-lan>'; }
})();

for (const [i, shop] of shops.entries()) {
  const port = BASE_PORT + i;
  http.createServer((req, res) => {
    const up = https.request({
      ...UPSTREAM,
      method: req.method,
      path: req.url,
      // Host quyết định shop nào được phục vụ — đây là toàn bộ việc của proxy này.
      headers: { ...req.headers, host: shop.host },
      rejectUnauthorized: false,   // CA nội bộ của Caddy; chỉ dev, chỉ tới 127.0.0.1
    }, (upRes) => {
      // Bỏ HSTS: nó dạy trình duyệt ép HTTPS cho origin này ở MỌI lần sau, và khi
      // đó chứng chỉ nội bộ lại chặn — tức tự tay dựng lại đúng bức tường vừa tránh.
      const h = { ...upRes.headers };
      delete h['strict-transport-security'];
      res.writeHead(upRes.statusCode ?? 502, h);
      upRes.pipe(res);
    });
    up.on('error', (e) => { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`không nối được Caddy: ${e.message}`); });
    req.pipe(up);
  }).listen(port, '0.0.0.0', () => {
    console.log(`  http://${lanIp}:${port}   ${shop.slug}`);
  });
}
console.log('\nMở các địa chỉ trên bằng điện thoại (cùng Wi-Fi). Ctrl+C để dừng.');
console.log('Lưu ý: cookie giỏ hàng có cờ Secure nên không sống qua HTTP — xem giao diện thì đủ.');
