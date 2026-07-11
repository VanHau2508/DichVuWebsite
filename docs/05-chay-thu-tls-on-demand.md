# Chạy thử TLS on-demand (bước (c))

Mục đích: chứng minh cơ chế cấp chứng chỉ tự động cho tên miền riêng của khách
hoạt động **và từ chối đúng chỗ**, trước khi viết một dòng nghiệp vụ nào.

Đây là rủi ro kỹ thuật lớn nhất của kiến trúc (ADR-003, ADR-004). Gỡ nó trước.

---

> **Trạng thái: ĐÃ CHẠY, 35/35 pass** trên Docker 29.6.1 / Caddy 2.11.4 / Postgres 16,
> gồm cả cold start từ volume rỗng và hai lần chạy liên tiếp.
> Unit test (không cần Docker): 15/15 pass.

---

## 1. Cài đặt (một lần, cần quyền Administrator)

Máy đã đủ điều kiện: **VT-x bật trong BIOS, SLAT có**. Chỉ thiếu phần mềm.

Mở **PowerShell với quyền Administrator** (Win → gõ `powershell` → `Ctrl+Shift+Enter`):

```powershell
# 1. WSL2 (Docker Desktop cần). Bật luôn các Windows feature liên quan.
wsl --install --no-distribution

# 2. Khởi động lại máy. Bắt buộc — các feature chưa có hiệu lực trước khi reboot.
Restart-Computer
```

Sau khi khởi động lại, mở lại PowerShell **Administrator**:

```powershell
winget install -e --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements
```

Mở Docker Desktop một lần, chờ trạng thái **Engine running**. Kiểm tra:

```powershell
docker --version
docker compose version
```

> Nếu `wsl --install` báo lỗi virtualization: kiểm tra lại BIOS mục
> *Intel VT-x / Intel Virtualization Technology*. Máy này báo `VirtualizationFirmwareEnabled: True`
> nên nhiều khả năng không cần đụng tới.

---

## 2. Chạy stack

Từ `D:\Dichvuwebsite`:

```bash
docker compose -f infra/compose.dev.yml up -d --build
docker compose -f infra/compose.dev.yml ps      # cả 4 service phải healthy/running
```

Năm container: `caddy`, `tls-authorize`, `postgres`, `storefront` (stub
`traefik/whoami`), và `toolbox` (chỉ để test — xem mục 3.1).

Chỉ Caddy publish port ra host: `8080` (HTTP) và `8443` (HTTPS).
`tls-authorize` và `postgres` **không có** `ports:` — chúng chỉ tồn tại trong
network nội bộ, đúng như production.

---

## 3. Chạy smoke test

```bash
bash scripts/smoke-tls.sh
```

Script dùng `curl --cacert` với chính root CA của Caddy để **xác thực chứng chỉ
thật sự**. Nó không dùng `curl -k` (trừ đúng một handshake khởi động CA, không
assert gì) — cờ đó làm mọi test pass kể cả khi chứng chỉ hoàn toàn sai.

### 3.1 Vì sao phải có container `toolbox`

`curl` của Git Bash trên Windows dùng backend **schannel**: nó bỏ qua `--cacert`
và đòi kiểm tra revocation, nên handshake chết với
`CERT_TRUST_REVOCATION_STATUS_UNKNOWN` — **trước khi** chạm tới Caddy.

Hậu quả tệ hơn là các test *phủ định* (`shopb.test` phải bị từ chối) vẫn "PASS",
vì curl thất bại — chỉ là vì lý do hoàn toàn khác. Test xanh, và vô nghĩa.

Vì vậy mọi lời gọi curl chạy trong container Linux `toolbox` (dùng OpenSSL), nối
tới Caddy bằng `--connect-to` để giữ nguyên SNI, và đọc root CA qua volume
`caddy_data` mount read-only. Test phủ định khẳng định **đúng mã lỗi** `curl 35`
(*TLS connect error* — Caddy chủ động huỷ handshake), không chấp nhận "thất bại
vì lý do gì cũng được".

### Năm shop mẫu và điều mỗi cái chứng minh

| Hostname | Trạng thái trong DB | Kỳ vọng | Chứng minh điều gì |
|---|---|---|---|
| `shopa.test` | verified, shop active | **cấp cert** | Đường hạnh phúc hoạt động |
| `shopb.test` | **chưa verified** | **từ chối** | Không ai chiếm được tên miền bằng cách trỏ DNS vào IP của bạn |
| `shopc.test` | verified, shop `terminated` | **từ chối** | Chấm dứt hợp đồng thì cắt cert |
| `shopd.test` | verified, shop `suspended` | **cấp cert** | Khoá shop vẫn giữ HTTPS để hiện trang thông báo |
| `shope.test` | verified, shop active | — | Chỉ dùng cho mục 5; cố ý không hỏi trước để cache không che mất bài test |
| `evil.test` | không có trong DB | **từ chối** | Domain lạ không đốt quota Let's Encrypt của bạn |

Ngoài ra script kiểm: chuẩn hoá hostname (hoa/thường, dấu chấm cuối), từ chối
wildcard / IP / port / nhãn đơn, chặn domain nền tảng, security headers,
`Cache-Control: private, no-store` trên `/cart` `/checkout` `/api/*`,
redirect HTTP→HTTPS 308.

### Bài test quan trọng nhất: mục 5 — fail-closed

Script **tắt Postgres** rồi kiểm hai điều:

1. Domain **mới** bị từ chối → không có chuyện DB chết mà cert được cấp bừa.
2. Khách **đã có cert** vẫn phục vụ bình thường → Caddy đọc cert từ đĩa, không
   gọi lại `ask`.

Đó chính là lý do fail-closed an toàn: sự cố database không làm sập website của
khách đang chạy, chỉ hoãn việc kết nối tên miền mới.

Bài này dùng `shope.test` — domain hợp lệ nhưng **chưa từng được hỏi**. Nếu dùng
`shopa.test`, cache dương 300s sẽ trả 200 mà không hề chạm database và cả hai
khẳng định đều pass giả. Cache sống lâu hơn một lần chạy script, nên script
`restart tls-authorize` để xoá cache một cách trung thực, thay vì thêm endpoint
`/flush-cache` chỉ để phục vụ test — đó sẽ là bề mặt tấn công mới trên endpoint
public-facing nhất của hệ thống.

### Mục 6 — chống flood tra cứu database

Caddy ≥2.8 gọi `ask` ở **mọi** handshake tới hostname chưa có chứng chỉ (tuỳ chọn
`interval`/`burst` đã bị gỡ). Script bắn 120 hostname lạ và khẳng định token
bucket trong `tls-authorize` chặn được trước khi chúng biến thành 120 query
Postgres — đồng thời khách đã nằm trong cache vẫn được phục vụ bình thường.

---

## 4. Test không cần Docker

Lớp lọc hostname là hàm thuần, chạy được ngay:

```bash
node --test apps/tls-authorize/test/hostname.test.js apps/tls-authorize/test/ratelimit.test.js
```

Hiện tại: **15/15 pass**.

- `hostname.js` chặn IP, wildcard, port, nhãn đơn, gạch dưới, nhãn > 63 ký tự,
  hostname > 253 ký tự, TLD toàn số, và bẫy hậu tố (`evilnentang.vn` **không**
  phải subdomain của `nentang.vn`).
- `ratelimit.js` (token bucket) test bằng đồng hồ giả, không dùng thời gian thật
  nên không chớp nháy.

---

## 5. Khác biệt dev ↔ production

| | dev (`Caddyfile.dev`) | production (`Caddyfile`) |
|---|---|---|
| Cấp chứng chỉ | CA nội bộ của Caddy | Let's Encrypt (ACME) |
| Wildcard `*.nentang.vn` | không có | có, qua **DNS-01** |
| Image Caddy | `caddy:2-alpine` | **build từ `infra/caddy/Dockerfile`** |
| Cơ chế on-demand + `ask` | **giống hệt** | **giống hệt** |

### Hai cạm bẫy đã gỡ (cả hai đều kiểm chứng bằng thực nghiệm)

**1. `caddy:2-alpine` không chứa plugin DNS nào.** Block `*.nentang.vn` cần cert
wildcard → Let's Encrypt chỉ cấp wildcard qua DNS-01 → bắt buộc
`caddy-dns/cloudflare`. Chạy `caddy validate` với image gốc:

```
Error: ... getting module named 'dns.providers.cloudflare':
       module not registered: dns.providers.cloudflare, at /etc/caddy/Caddyfile:58
```

`infra/caddy/Dockerfile` build bằng `xcaddy` và có dòng
`RUN caddy list-modules | grep -q '^dns.providers.cloudflare$'` để fail ngay lúc
build thay vì lúc deploy. Kiểm chứng bản build đúng:

```bash
docker build -f infra/caddy/Dockerfile -t nentang-caddy-prod infra/caddy
docker run --rm -e ACME_EMAIL=ops@nentang.vn -e CF_API_TOKEN=dummy \
  -v "$PWD/infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  nentang-caddy-prod caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```
Nó sẽ dừng ở `API token 'dummy' appears invalid` — chính điều đó chứng minh plugin
đã nạp và đang chạy.

**2. `interval` và `burst` trong `on_demand_tls` đã bị Caddy gỡ từ v2.8.**
Để lại thì Caddy **không khởi động**:

```
Error: ... the on_demand_tls 'interval' option is no longer supported,
       remove it from your config, at /etc/caddy/Caddyfile:15
```

Hệ quả không chỉ là sửa cú pháp: **`ask` giờ là lá chắn duy nhất.** Caddy hỏi nó
ở mọi handshake tới hostname chưa có chứng chỉ. Đó là lý do `tls-authorize` có
token bucket riêng.

Trước khi deploy production còn phải chuẩn bị: `ACME_EMAIL`, `CF_API_TOKEN`
(chỉ quyền `Zone:DNS:Edit` trên zone `nentang.vn`, **không** dùng Global API Key),
và **floating IP** theo ADR-004.

---

## 6. Dọn dẹp

```bash
docker compose -f infra/compose.dev.yml down          # giữ dữ liệu
docker compose -f infra/compose.dev.yml down -v       # xoá sạch volume, chạy lại từ đầu
```

Lưu ý: script init SQL trong `infra/db/init/` **chỉ chạy khi volume `pgdata`
còn rỗng**. Sửa schema xong phải `down -v` mới thấy thay đổi.
