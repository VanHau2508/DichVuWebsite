# 42 — Ship theo khoảng cách (km) + định vị GPS lúc thanh toán (0089)

Khách bấm **“📍 Dùng vị trí hiện tại”** ở trang thanh toán → hệ thống đổi toạ độ thành địa chỉ và
**tính ngay phí giao theo quãng đường** từ cửa hàng tới khách. Bớt gõ tay (tăng tỉ lệ chốt đơn) và
cho phép shop có shipper riêng tính phí sát thực tế cho **khách gần**. Thiết kế qua workflow (recon
4 vùng + 2 design + blueprint + 3 red-team: 1 crit + nhiều high). 4 commit (ship-1→ship-4).

## Bài toán TOÀN QUỐC (khác đối thủ chỉ giao nội tỉnh) — nguyên tắc số 1

Tham chiếu tieutieu.synd.vn: họ chỉ giao **trong một tỉnh (Cà Mau)** nên tính tiền thuần theo km là
hợp lý. Nền tảng này bán **toàn quốc** → nếu tính km thuần thì đơn Cà Mau → Hà Nội (~1.800km) sẽ ra
tiền triệu, **không ai mua**. Vì vậy ship theo km ở đây là **LỚP TỐI ƯU cho khách GẦN**, chồng lên
phí vùng (0063), KHÔNG thay thế:

- **Trong bán kính `ship_max_km`:** phí = `base + km × per_km × road_factor`, nhưng **không thấp hơn
  phí vùng** (SÀN).
- **Ngoài bán kính:** rơi về **phí vùng liên miền** (`ship_over_max_behavior = 'region'`, mặc định)
  — vẫn giao toàn quốc với mức GHN/GHTK thu, **không** nhân nghìn km. Shop chỉ-giao-nội-thành có thể
  chọn `'reject'` → đơn ngoài bán kính bị từ chối (422 “ngoài vùng giao”).

## Đường tiền + chống gian lận: SÀN PHÍ là LINCHPIN

`computeShipping` là **choke-point phí DUY NHẤT** (hiển thị lúc xem = chốt lúc đặt). Nhánh distance:

```
km = ceil(distanceMeters / 1000)                       // distanceMeters = haversine × road_factor
if (maxKm != null && km > maxKm)                        // ngoài bán kính
    → overMax==='reject' ? null(→422) : phí_vùng(region/far theo tỉnh)
phí_km = base + km×per_km + phụ_phí_cân
return max(phí_km, phí_vùng)                            // ← SÀN: distance KHÔNG BAO GIỜ rẻ hơn vùng
```

**Vì sao SÀN là linchpin:** client gửi `lat/lng` là **INPUT** (JS GPS đặt vào hidden field); phí
**luôn tính SERVER**. Kẻ gian có thể giả toạ độ **sát cửa hàng** để km≈0 → nhưng `max(km_fee,
region_fee)` kéo phí về mức phí vùng của **tỉnh khách khai** → không bao giờ rẻ bất thường. Điều này
**vô hiệu hoá cả lớp** gian lận toạ-độ-giả, nên **không cần** thêm cờ nghi ngờ COD riêng cho GPS
(cân nhắc ở ship-4: cờ theo khoảng cách dễ dương-tính-giả trên đường tiền, mà SÀN đã bịt lỗ hổng
mất tiền). Các chốt chặn khác:

- **coords finite-validate** (`parseCoords`/`parseOrderInput`): `'abc'`/`Infinity`/ngoài `[-90,90]×
  [-180,180]` → bỏ → rơi phí vùng (chống `NaN` lọt vào total).
- **km > max → sentinel `null`** → `fail(422, out_of_range)` **TRƯỚC** cổng 409 và **TRƯỚC** tính
  total → không `NaN`, đúng thông điệp, thắng cả freeship (deliverability).
- **Ngoài bbox VN** (`inVietnam`) → rơi phí vùng. **Toạ độ gốc shop** validate trong lãnh thổ VN
  (seller) — gốc sai thì mọi phí sai.
- `distanceMeters` tính ở helper `resolveShipDistance` **DÙNG CHUNG** giữa endpoint geocode và lúc
  chốt → `ship_seen` (honesty-loop) === phí thật.

## Kiến trúc: giữ no-JS + CSP nghiêm, NỚI đúng một trang

- **`apps/checkout/src/geo.js`** — `haversineKm` thuần + bbox VN (`inVietnam`). Tính **OFFLINE**,
  không gọi API bản đồ cho phí → phí độc lập uptime provider.
- **`apps/checkout/src/geocode.js`** — reverse-geocode gọi **Ở SERVER** (key giấu, trình duyệt
  sạch). Provider cắm được: `stub` (dev/e2e, in-process, không mạng) · `goong` (rsapi.goong.io).
  - **SSRF khoá cứng:** URL toàn từ env + path cố định + key server; input client chỉ 2 số đã
    validate. `redirect:'manual'` + guard `content-type` + `readCapped` 64KB + timeout/abort 4s.
  - **`normalizeProvince`** (fail-safe): unaccent + bảng alias tên-cũ-63 → 1/34 tỉnh; **không khớp →
    `null`** → checkout ÉP khách chọn tỉnh tay (TUYỆT ĐỐI không ghi tỉnh ngoài-34 → vận đơn an toàn).
  - Mọi lỗi → `GeoError` → endpoint **soft-fallback** (không 500) → khách nhập tay, đơn vẫn đặt được.
- **`POST /checkout/geocode`** (guest, same-origin CSRF): validate toạ độ → `geoRateOk` → reverse →
  normalize tỉnh → tính phí qua `summarize` → trả `{available, address, need_province, distance_km,
  shipping_vnd, total_vnd, out_of_range, ship_seen}`.
  - **`geoRateOk` FAIL-CLOSED** (khác `hit()` checkout fail-open): 3 tầng ngân sách per-IP/phút ·
    per-shop/ngày · nền-tảng/ngày. Redis lỗi/thiếu/degraded → **KHÔNG** gọi Goong (đốt quota API bản
    đồ = mất tiền/DoS; mất-tiện-ích an toàn hơn mất-tiền).
- **CSP nonce (chỉ trang checkout):** `htmlCsp(nonce)` thêm `script-src 'nonce-X'; connect-src
  'self'`. `'unsafe-inline'` **giữ ở style-src**, tuyệt đối không lọt vào `script-src`. Trang khác
  `nonce=''` → khoá cứng `default-src 'none'` KHÔNG script như cũ.
- **Lớp JS first-party** (`gpsScript`, ~40 dòng, không framework). **XSS-safe:** dữ liệu provider chỉ
  set qua `.value`/`.textContent` (KHÔNG `innerHTML`); `addEventListener` (KHÔNG onclick nội tuyến);
  chỉ nonce nội suy vào thân script. Từ chối GPS / tắt JS / lỗi mạng → **không đụng form** (fallback
  no-JS trọn vẹn).

## PII: toạ độ nằm TRONG shipping_address → tự ẩn danh, KHÔNG cột mới

`lat/lng` lưu trong `orders.shipping_address` (jsonb) cùng `line/province`. Sweep ẩn danh (0064) đặt
`shipping_address = NULL` → **xoá luôn toạ độ**; 0 cột mới, 0 grant mới. Bất biến này được **khoá
bằng test** (`worker/test/pii-gps.e2e.mjs`): nếu sau này tách `lat/lng` ra cột riêng mà quên nối vào
sweep → test đỏ. Toạ độ GPS là PII nhạy (vị trí nhà chính xác) nên chốt chặn này quan trọng.

## Cấu hình cho chủ shop (seller-admin, no-JS)

Trang **Cài đặt → “Ship theo khoảng cách (km)”**: radio Bật/Tắt (mặc định Tắt) · ô Vĩ độ/Kinh độ +
hướng dẫn lấy toạ độ từ Google Maps · phí cơ bản/km · bán kính tối đa · hệ số đường bộ · radio
ngoài-bán-kính (`region` khuyến nghị | `reject`). Backend seller `updateShopProfile` là nơi **validate
+ mirror CHECK** `distance-requires-config` (bật distance bắt buộc khai gốc + đơn giá + bán kính, và
có tỉnh gửi + phí liên miền làm bậc dự phòng). BFF chỉ forward, không tự đoán.

## Migration

- **0089** — `shops +`: `ship_mode('region'|'distance')`, `ship_origin_lat/lng` (double, CHECK
  biên), `ship_base_vnd`/`ship_per_km_vnd` (bigint), `ship_max_km` (int 1–500), `ship_road_factor`
  (numeric DEFAULT 1.3, CHECK 1.0–3.0) + CHECK `distance_requires_config`.
- **0090** — `shops.ship_over_max_behavior` (`'region'` mặc định | `'reject'`).

## Cấu hình môi trường (prod)

`GEOCODE_PROVIDER=goong`, `GEOCODE_API_KEY=<key rsapi.goong.io>` (thiếu key → `GEOCODE_ON=false` →
nút GPS tắt gọn, checkout no-JS như cũ). Tuỳ chọn: `GEOCODE_API_BASE`, `GEOCODE_TIMEOUT_MS`,
`GEOCODE_RL_PER_MIN`/`GEOCODE_SHOP_DAILY`/`GEOCODE_PLATFORM_DAILY` (ngân sách gọi provider). Dev
dùng `GEOCODE_PROVIDER=stub` (không mạng).

## Test

- `checkout/test/ship-distance.e2e.mjs` (9) — money-path: phí km, SÀN chống giả-toạ-độ, 422/reject
  ngoài-bán-kính, no-coords→vùng, rác→vùng, ngoài-VN→vùng, region-mode tương thích.
- `checkout/test/geocode.e2e.mjs` (9) — toạ-độ→địa-chỉ+phí (stub), provider-lỗi→soft-fallback KHÔNG
  500, ngoài-VN, rác→400, region-mode→available:false, trang distance có nút GPS + CSP nonce khớp +
  KHÔNG innerHTML, trang region khoá cứng không script.
- `seller-admin/test/admin-shipping-distance.e2e.mjs` (14) — render + prefill + 4 ràng buộc validate
  + POST-lỗi-không-đụng-DB + cô lập chéo shop + CSRF.
- `worker/test/pii-gps.e2e.mjs` (6) — GPS lat/lng vào shipping_address → quá hạn+terminal → pii-sweep
  xoá toạ độ + tên sentinel + doanh thu giữ; đơn tươi giữ toạ độ (sweep có mục tiêu).
