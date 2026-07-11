# Hạ tầng và vận hành

> Bối cảnh: **VPS Việt Nam + Docker**, 2 người, 3–10 shop pilot, custom domain bắt buộc.

---

## 1. Sự thật phải chấp nhận khi tự host

Bạn ký hợp đồng cam kết hosting, SSL, backup, bảo mật. Tự host nghĩa là **bạn là người trực**. Bốn hệ quả:

1. **Không có ai khác khôi phục database lúc 2 giờ sáng.** Backup chưa từng được restore thử = không có backup.
2. **IP là vĩnh viễn.** Khách trỏ A record vào IP của bạn. Đổi IP = gọi điện cho từng khách. → **Bắt buộc floating IP.** Nếu nhà cung cấp VPS không có, đổi nhà cung cấp trước khi bán khách đầu tiên.
3. **Không có chống DDoS.** IP lộ ra qua DNS của khách. Với 10 shop pilot thì rủi ro thấp; hãy ghi nó vào danh sách rủi ro và đừng cam kết SLA cao (kế hoạch gốc cũng nói vậy).
4. **VPS Việt Nam đôi khi chặn port 25 và có tuyến quốc tế không ổn định.** → **Không tự gửi email.** Dùng SMTP relay (Resend / Amazon SES / Mailgun). Email xác nhận đơn vào spam là mất tiền của khách.

---

## 2. Topology

### VPS-1 — production (khuyến nghị 4 vCPU / 8 GB / 100 GB NVMe)
```
caddy        :80 :443   ← duy nhất expose ra Internet
storefront   :3000      \
seller-admin :3001       │ network nội bộ Docker, không publish port
api          :3002       │
worker         —         │
postgres     :5432       │
redis        :6379       │
minio        :9000      /
```

### VPS-2 — staging + hạ tầng phụ (2 vCPU / 4 GB, rẻ)
```
staging (toàn bộ stack, dữ liệu giả)
uptime-kuma        ← giám sát VPS-1 từ bên ngoài
postgres replica   ← streaming replication từ VPS-1 (chỉ đọc, để restore nhanh)
```

Giám sát phải chạy **trên máy khác**. Uptime Kuma cài trên chính VPS-1 sẽ chết cùng lúc với thứ nó đang giám sát.

### Ngoài VPS
- **Backblaze B2** (hoặc Wasabi): đích backup offsite. ~5 USD/tháng.
- **Sentry** (free tier): error tracking.
- **Resend / SES**: gửi email.
- **Cloudflare**: DNS + proxy **chỉ cho `nentang.vn`** của bạn. Domain của khách trỏ thẳng vào floating IP (xem ADR-004).

Tổng chi phí ước tính giai đoạn pilot: **1,5 – 2,5 triệu đồng/tháng**. Với 5 khách × 990k = 4,95 triệu doanh thu định kỳ. Biên ổn, nhưng chỉ khi giờ hỗ trợ được kiểm soát như mục 3 của file kế hoạch.

---

## 3. Caddyfile

```caddyfile
{
  email {env.ACME_EMAIL}
  # `interval`/`burst` đã bị Caddy gỡ từ v2.8 — để lại thì Caddy không khởi động.
  # `ask` là lá chắn duy nhất; tls-authorize tự rate-limit việc chạm database.
  on_demand_tls {
    ask http://tls-authorize:3010/internal/tls/authorize
  }
  servers {
    trusted_proxies static private_ranges
  }
}

(security_headers) {
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options    "nosniff"
    Referrer-Policy           "strict-origin-when-cross-origin"
    Permissions-Policy        "geolocation=(), microphone=(), camera=()"
    -Server
  }
}

# ── Quản trị nhà bán hàng: MỘT origin duy nhất ──────────────────
admin.nentang.vn {
  import security_headers
  header Content-Security-Policy "default-src 'self'; frame-ancestors 'none'"
  reverse_proxy seller-admin:3001
}

# ── Storefront: subdomain nền tảng (wildcard cert qua DNS-01) ───
*.nentang.vn {
  tls {
    dns cloudflare {env.CF_API_TOKEN}
  }
  import security_headers
  reverse_proxy storefront:3000
}

# ── Storefront: domain riêng của khách (TLS on-demand) ──────────
https:// {
  tls { on_demand }
  import security_headers

  # Giỏ hàng và checkout không bao giờ được cache ở bất kỳ tầng nào
  @nocache path /cart* /checkout* /api/*
  header @nocache Cache-Control "private, no-store"

  reverse_proxy storefront:3000
}
```

Bốn điểm cần hiểu:

- **`*.nentang.vn` phải dùng DNS-01**, không HTTP-01. Let's Encrypt không cấp wildcard qua HTTP-01. Đó là lý do DNS của `nentang.vn` để ở Cloudflare (có API token).
- **Image `caddy:2-alpine` gốc KHÔNG chạy được file này.** Nó không có module DNS nào. Kiểm chứng: `caddy validate` báo `module not registered: dns.providers.cloudflare`. Phải build bằng `infra/caddy/Dockerfile` (xcaddy + `caddy-dns/cloudflare`).
- **`https://` (site block trống)** là catch-all cho mọi Host lạ → kích hoạt on-demand TLS → gọi `ask`.
- **`ask` không có nghĩa là xác thực.** Nó chỉ kiểm tra "domain này có trong DB và đã verify chưa". Nó phải trả lời **trong < 200ms** và tuyệt đối không được lỗi 500 — Caddy coi mọi non-2xx là từ chối, khách sẽ mất SSL.

---

## 4. Docker Compose (production, rút gọn)

```yaml
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data        # ← chứa toàn bộ chứng chỉ. PHẢI backup.
      - caddy_config:/config
    environment: [CF_API_TOKEN]

  api:
    image: ghcr.io/nentang/api:${TAG}
    restart: unless-stopped
    environment:
      DATABASE_URL: postgres://app_rw:${DB_PASS}@postgres:5432/app  # ← app_rw, KHÔNG phải owner
      REDIS_URL:    redis://redis:6379
    depends_on: [postgres, redis]
    # KHÔNG có "ports:" — không expose ra ngoài

  worker:
    image: ghcr.io/nentang/api:${TAG}
    command: node dist/worker.js
    restart: unless-stopped

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./postgres/postgresql.conf:/etc/postgresql/postgresql.conf:ro
    command: postgres -c config_file=/etc/postgresql/postgresql.conf
    # wal_level=replica, archive_mode=on, archive_command → wal-g

  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes --maxmemory 512mb --maxmemory-policy noeviction
    # noeviction: BullMQ mất job nếu Redis đuổi key. Không dùng allkeys-lru.
    volumes: [redisdata:/data]

  minio:
    image: minio/minio
    command: server /data
    volumes: [miniodata:/data]

volumes: { caddy_data, caddy_config, pgdata, redisdata, miniodata }
```

Bí mật: **không** dùng file `.env` nằm cạnh compose. Dùng `docker secret` hoặc `sops` + `age`, và bật `gitleaks` trong CI. Cam kết trong hợp đồng là bảo mật — secret trong repo là vi phạm cam kết đó.

---

## 5. Backup — thứ quyết định bạn có sống sót hay không

### Ba thứ phải backup
| Đối tượng | Cách | Tần suất | Giữ |
|---|---|---|---|
| PostgreSQL | `wal-g` → B2 (base backup + WAL liên tục) | base: hằng ngày; WAL: liên tục | 30 ngày |
| MinIO (ảnh) | `rclone sync` → B2 | mỗi 6 giờ | 30 ngày |
| `caddy_data` (chứng chỉ) | tar → B2 | hằng ngày | 7 ngày |

RPO mục tiêu ≤ 5 phút (nhờ WAL archiving). RTO mục tiêu ≤ 60 phút.

Bỏ `caddy_data` là sai lầm hay gặp: mất nó, mọi shop cần cấp lại cert cùng lúc, và bạn đâm vào rate limit của Let's Encrypt.

### Quy tắc bất di bất dịch
> **Backup chưa restore thử không phải là backup.**

Đặt lịch: **ngày 1 mỗi tháng**, restore bản backup mới nhất vào VPS-2, chạy bộ smoke test, ghi lại thời gian thực tế. Nếu tháng nào bỏ qua, coi như hệ thống không có backup cho tới khi làm bù. Đây là Ngày 19 trong kế hoạch, và nó lặp lại hằng tháng mãi mãi.

Diễn tập phải bao gồm: **restore về một thời điểm cụ thể** (PITR), không chỉ restore bản mới nhất. Kịch bản thật là "lúc 14:30 có người chạy nhầm `DELETE`", không phải "ổ cứng chết".

---

## 6. CI/CD

```
push → GitHub Actions
  ├─ lint + typecheck
  ├─ unit + integration test (Postgres ephemeral)
  ├─ TEST CROSS-SHOP (bắt buộc pass)         ← không có ngoại lệ
  ├─ kiểm tra: mọi bảng có shop_id đều FORCE RLS
  ├─ kiểm tra: app_rw không có BYPASSRLS
  ├─ gitleaks + pnpm audit (chặn High/Critical)
  ├─ migration check: up → down → up
  ├─ build image → ghcr.io
  ├─ deploy staging (tự động)
  ├─ Playwright e2e trên staging
  └─ deploy production  ← THỦ CÔNG, một người bấm nút
```

Triển khai production: `docker compose pull && docker compose up -d` với `TAG` cố định (không bao giờ `latest`). Rollback = đổi `TAG` về bản trước + `up -d`. Phải mất **dưới 2 phút** và đã được diễn tập.

**Migration phải tương thích ngược một phiên bản.** Không `DROP COLUMN` trong cùng release với code ngừng dùng nó. Quy tắc hai bước:
- Release N: thêm cột mới, ghi cả hai, đọc cột cũ.
- Release N+1: đọc cột mới.
- Release N+2: bỏ cột cũ.

Nếu không, rollback = mất dữ liệu, và bạn không dám rollback lúc đang cháy.

---

## 7. Giám sát và cảnh báo

| Tín hiệu | Ngưỡng | Kênh |
|---|---|---|
| Storefront trả 5xx | > 1% trong 5 phút | Telegram/Zalo bot |
| Checkout thất bại | bất kỳ lần nào | Telegram, ngay |
| Job vào dead-letter queue | bất kỳ | Telegram |
| Webhook thanh toán lỗi chữ ký | bất kỳ | Telegram (dấu hiệu tấn công) |
| Postgres connection > 80% | 5 phút | Telegram |
| Đĩa > 80% | — | email |
| Chứng chỉ sắp hết hạn < 14 ngày | — | email |
| WAL archive thất bại | bất kỳ | Telegram, ngay |
| Uptime từ ngoài (Uptime Kuma) | 2 lần fail liên tiếp | Telegram |

Trong **tuần đầu chạy thật**, theo dõi thủ công mọi đơn hàng (kế hoạch gốc yêu cầu đúng vậy). Một dashboard đơn giản `orders WHERE created_at > now() - interval '24 hours'` và bạn đọc nó mỗi sáng.

Logger phải redact. Một `console.log(req.body)` ở trang checkout là ghi số điện thoại, địa chỉ khách hàng ra log vĩnh viễn. Viết logger có allowlist field, đừng viết denylist.

---

## 8. Feature flag

Mỗi shop có `shops.feature_flags jsonb`. Tối thiểu:
```json
{ "checkout_enabled": true, "payment_qr": true, "payment_gateway": false }
```
Khi checkout của một shop lỗi, bạn tắt được **riêng shop đó** trong 10 giây mà không cần deploy. Storefront hiện thông báo "Tạm ngưng nhận đơn". Đây là yêu cầu trong mục "Cách ra mắt an toàn" của kế hoạch.

---

## 9. Runbook — bốn sự cố sẽ xảy ra

### 9.1 "Website khách không vào được, báo lỗi SSL"
1. `dig +short shopA.com` → có trỏ đúng floating IP không? (90% là khách đổi DNS)
2. `ask` có cho phép không?
   ```sh
   docker compose exec caddy wget -qS -O /dev/null \
     'http://tls-authorize:3010/internal/tls/authorize?domain=shopA.com'
   ```
   403 → domain chưa `verified_at`, hoặc shop `terminated`.
3. Cert đã cấp chưa? (Caddy **không có** lệnh `list-certificates`; đọc thẳng storage)
   ```sh
   docker compose exec caddy ls /data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/
   ```
4. Log Caddy: có bị Let's Encrypt rate limit không? (`docker compose logs caddy | grep -i "rate limit"`)
5. Nếu rate limit: **chờ**, không thử lại liên tục — mỗi lần thử làm nặng thêm.
   Kiểm tra ngay `caddy_data` có bị mất không: mất nó = cấp lại toàn bộ cert cùng lúc.

### 9.2 "Khách báo mất đơn hàng"
1. Tìm trong `audit_logs` và `order_events` — đơn có từng tồn tại không?
2. Kiểm tra `outbox` chưa xử lý và dead-letter queue.
3. Không bao giờ sửa trực tiếp database. Nếu buộc phải, ghi lại `audit_logs` bằng tay với `actor_type='system'` và lý do.

### 9.3 "Postgres đầy đĩa"
1. `SELECT pg_size_pretty(pg_database_size('app'));`
2. Thủ phạm thường là `audit_logs` và WAL chưa archive được. Kiểm tra `wal-g` trước.
3. **Không bao giờ `DROP` hay `TRUNCATE` để giải phóng chỗ trong lúc cháy.** Mở rộng volume trước.

### 9.4 "Nghi ngờ rò dữ liệu chéo shop"
1. **Tắt ngay**: bật maintenance mode toàn hệ thống.
2. Đây là sự cố mức Critical. Không debug trên production.
3. Chạy bộ test cross-shop trên bản snapshot production.
4. Xác định phạm vi qua `audit_logs`.
5. Thông báo cho khách bị ảnh hưởng **trong 72 giờ**. Đây là nghĩa vụ pháp lý (Nghị định 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân), không phải lựa chọn PR.
6. Postmortem, biện pháp ngăn tái diễn.

---

## 10. Quy trình vận hành (tham chiếu kế hoạch gốc)

```
Onboarding:  ký hợp đồng → tạo shop → xác minh owner → chọn theme → nhập nội dung
             → cấu hình domain → kiểm thử → khách nghiệm thu → kích hoạt

Phát hành:   PR → review → test → build → staging → smoke test
             → canary 1 shop nội bộ → theo dõi 24h → production → rollback nếu lỗi

Sự cố:       phát hiện → phân mức → hạn chế ảnh hưởng → rollback/tắt flag
             → điều tra → khôi phục → thông báo → postmortem

Suspend:     ghi nhận căn cứ → thông báo → thời hạn khắc phục → phê duyệt
             → suspend (KHÔNG xóa dữ liệu) → audit → restore hoặc chấm dứt

Hỗ trợ:      mọi yêu cầu qua ticket. Bug hệ thống → SLA. Yêu cầu mới → báo giá.
             Không dùng tài khoản cá nhân của khách. Support access có lý do,
             thời hạn, audit, và khách được thông báo.
```

Ba điều tuyệt đối:
- **Platform Admin không sửa trực tiếp database.** Mọi thao tác qua giao diện có audit. Nếu giao diện chưa có tính năng đó, viết nó — đừng mở `psql`.
- **Không dùng tài khoản của khách để đăng nhập.** Dùng support access có thời hạn.
- **Không gọi yêu cầu mới là "bảo hành".**
