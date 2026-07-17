# 35 — Runbook GO-LIVE: 3 blocker vận hành trước khách trả tiền #1

3 việc VẬN HÀNH (không phải tính năng) chặn nhận khách thật. Code đã sẵn sàng ở phía nền
tảng; phần còn lại là **bạn cắm dịch vụ ngoài + đặt secret thật**. Làm đủ 3 mục này rồi mới go-live.

---

## Blocker 1 — Backup offsite + MÃ HOÁ (chống mất dữ liệu + lộ dữ liệu)

**Vì sao:** dump chứa **PII khách + hash mật khẩu + KHOÁ TLS**. Backup chỉ nằm trên VPS =
mất VPS mất sạch. Backup không mã hoá + offsite bị lộ = lộ toàn bộ.

**Đã có sẵn (code):** `scripts/backup.sh` mã hoá **AES-256** mọi artifact TRƯỚC khi rời máy;
`scripts/restore.sh` giải mã + phục hồi. Thiếu khoá → script TỪ CHỐI đẩy (không "xanh giả").

**Bạn cần làm:**
1. Sinh khoá mã hoá: `openssl rand -base64 48` → đặt `BACKUP_ENC_KEY` trong `.env`.
   **GIỮ RIÊNG khoá này** (KHÔNG lưu cùng nơi chứa backup — vd để trong trình quản lý mật khẩu).
   Mất khoá = mất luôn khả năng khôi phục.
2. Cấu hình đích offsite (S3/Backblaze B2/box khác) qua `OFFSITE_CMD` + `OFFSITE_DEST` trong `.env`.
   Ví dụ rclone: `OFFSITE_CMD='rclone copy --s3-no-check-bucket'`, `OFFSITE_DEST='b2:nentang-backup'`.
3. Cron trên VPS:
   ```cron
   */15 * * * *  cd /srv/nentang && bash scripts/backup.sh wal    # WAL (RPO ~15')
   0 3 * * *     cd /srv/nentang && bash scripts/backup.sh        # full hằng đêm
   ```
4. **DIỄN TẬP KHÔI PHỤC (bắt buộc — backup không restore được = vô nghĩa):**
   trên máy staging: `bash scripts/restore.sh verify /đường-dẫn-backup-tải-về`
   → phải thấy "giải mã + kiểm tra dump hợp lệ". Làm định kỳ (vd hằng tháng).

---

## Blocker 2 — Cảnh báo ĐƯỜNG TIỀN + vận hành

**Vì sao:** tiền về tài khoản shop nhưng webhook không map được vào đơn (giao dịch "chưa
khớp") = doanh thu treo/khiếu nại; email kẹt = khách không nhận xác nhận. Phải BIẾT NGAY.

**Đã có sẵn (code):** worker `sweepMoneyAlerts` (mỗi 5') → POST cảnh báo tới `ALERT_WEBHOOK_URL` khi:
- giao dịch tiền **chưa khớp** tồn đọng quá 1h (`unmatched_transfers`),
- email **tồn đọng** >10' (worker gửi mail kẹt),
- email **thất bại** (dead-letter).
Dedup: chỉ báo khi trạng thái đổi hoặc quá `ALERT_REPEAT_MS` (1h) — không spam. Hết lỗi → báo "đã ổn định".

**Bạn cần làm:**
1. Tạo webhook nhận cảnh báo. Dễ nhất: **Slack/Discord Incoming Webhook** (nhận JSON `{text}`) →
   dán URL vào `ALERT_WEBHOOK_URL` trong `.env`.
2. Muốn về **Telegram/Zalo:** dùng cầu nối (relay nhỏ đổi `{text}` → `sendMessage`, hoặc dịch
   vụ như Make/IFTTT/n8n). *(Telegram bot API nhận `chat_id`+`text`, không cùng shape `{text}` nên
   cần relay — nếu muốn, báo tôi xây thêm 1 adapter Telegram gọn.)*
3. Ngưỡng chỉnh được: `ALERT_UNMATCHED_MAX` (mặc định 1), `ALERT_OUTBOX_MAX` (20), `ALERT_EMAIL_FAIL_MAX` (5).

**Runbook "kẹt email" (khi nhận cảnh báo email thất bại/dead-letter):** từ trong mạng nội bộ
(vd `docker compose -f infra/compose.dev.yml exec seller sh`), soi lý do:
`curl http://worker:3080/internal/dead-letters` → xem `recent[].failedReason` (thường là SMTP
sai user/password, relay từ chối, domain gửi chưa verify). Sửa nguyên nhân (secret SMTP /
dashboard relay) → gửi lại toàn bộ: `curl -X POST http://worker:3080/internal/dead-letters/retry`
→ job quay về hàng đợi và gửi lại; kiểm `curl http://worker:3080/stats` thấy `failed` giảm.
Dead-letter tự dọn sau 7 ngày / giữ tối đa 1000 job (không phình Redis vô hạn).

---

## Blocker 3 — Giám sát UPTIME (biết khi hệ thống sập)

**Vì sao:** VPS/service chết lúc 2h sáng mà không ai biết = mất đơn + mất uy tín.

**Đã có sẵn (code):** mọi service có `/healthz` (kiểm DB/Redis) trả 200 khi khoẻ.

**Bạn cần làm (dịch vụ NGOÀI — quan trọng là monitor phải ở NGOÀI VPS, VPS chết nó vẫn báo):**
1. Đăng ký **Uptime Kuma** (tự host chỗ khác) hoặc **healthchecks.io / UptimeRobot** (miễn phí).
2. Giám sát các URL CÔNG KHAI (ping = kiểm cả stack):
   - `https://nentang.vn` (trang công ty) · `https://<shop>.nentang.vn` (storefront) ·
     `https://admin.nentang.vn` (đăng nhập admin).
   Có thể giám sát sâu hơn nếu mở `/healthz` ra ngoài qua Caddy (mặc định nội bộ).
3. **Backup dead-man's switch:** đặt `HEALTHCHECK_PING_URL` (healthchecks.io) trong `.env` →
   `backup.sh` ping khi chạy xong. Cron backup ngừng chạy → không ping → healthchecks.io báo động.
4. Nối kênh báo (Telegram/Zalo/email) trong dịch vụ giám sát → nhận thông báo khi có sự cố.
5. **Dead-man's switch cho WORKER (vòng cảnh báo tiền):** đặt `WORKER_HEARTBEAT_URL`
   (healthchecks.io, grace ≥ 15') → worker ping mỗi ~5' cuối mỗi nhịp `sweepMoneyAlerts`.
   Worker treo/chết/DB sập → ngừng ping → monitor báo động. Vì sao cần: `sweepMoneyAlerts`
   chạy TRONG chính worker + dùng CHÍNH DB nó giám sát, nên worker chết thì nó KHÔNG tự
   báo được — phải có mắt NGOÀI hộp.

**Lưu ý quan trọng về healthcheck:** container healthcheck (image + block trong compose)
CHỈ đặt TRẠNG THÁI. Với `docker compose` + `restart: unless-stopped`, container `unhealthy`
KHÔNG được tự khởi động lại — chỉ container có tiến trình THOÁT mới restart. Worker
treo-nhưng-còn-sống sẽ nằm `unhealthy` và IM LẶNG. Cho MVP: dựa vào `restart: unless-stopped`
(bắt crash cứng) + heartbeat + monitor ngoài là đủ; sidecar autoheal cần mount docker.sock
(quyền ngang root) — KHÔNG khuyến nghị.

---

## Email deliverability — SPF / DKIM / DMARC (bắt buộc trước khách #1)

**Vì sao:** worker đã ÉP auth + STARTTLS (587) tới relay thật. Nhưng nếu THIẾU bản ghi
DNS xác thực domain gửi, thư vẫn vào SPAM hoặc bị relay/Gmail từ chối (Gmail/Yahoo từ
2024 bắt buộc SPF+DKIM+DMARC). Khách VN dùng Gmail là chính.

**Bạn cần làm (DNS + dashboard relay — code không tự làm được):**
1. **SPF:** thêm TXT trên domain của `EMAIL_FROM` cho phép relay gửi thay
   (relay như Resend/SES/SendGrid cấp sẵn chuỗi `include:...`).
2. **DKIM:** thêm CNAME/TXT khoá ký do relay cấp → thư được ký, không bị coi là giả mạo.
3. **DMARC:** thêm TXT `_dmarc` giá trị `v=DMARC1; p=quarantine; rua=mailto:<email của bạn>`.
4. **Verify domain gửi** trong dashboard relay (thường phải "verified" mới gửi production).
5. **Kiểm:** gửi 1 thư thử tới Gmail → "Show original" phải thấy SPF=PASS, DKIM=PASS, DMARC=PASS.

---

## Xoay khoá mã hoá (secretbox v2 — Đợt 5.6)

**Vì sao:** blob cũ `iv.tag.ct` không mang key-id — đổi khoá là hỏng MỌI ciphertext
(secret MFA của toàn bộ user + token GHN/GHTK per-shop). Định dạng v2
`v2.<kid>.iv.tag.ct` + keyring cho phép xoay khoá KHÔNG downtime.

**Hai cột ciphertext trong hệ thống:** `mfa_totp.secret_enc` (khoá `MFA_ENC_KEYS`,
legacy `MFA_ENC_KEY`) · `shop_shipping_config.token_enc` (khoá `SHIPPING_ENC_KEYS`,
legacy `SHIPPING_ENC_KEY` — seller VÀ worker cùng giải mã). SePay là sha256 hash,
Telegram chỉ lưu chat_id, backup mã hoá file bằng `BACKUP_ENC_KEY` riêng — không liên quan.

**Keyring:** `MFA_ENC_KEYS='k2:<64hex mới>,k1:<64hex cũ>'` — entry ĐẦU = active
(mã hoá); các entry sau chỉ để giải mã. Khoá legacy (env cũ) = entry ngầm định
kid `k0`, VẪN PHẢI đặt (gate khởi động + giải mã blob legacy). Cùng mẫu cho
`SHIPPING_ENC_KEYS` (đặt GIỐNG NHAU ở seller và worker).

**Quy trình xoay (mỗi khoá):**
1. Sinh khoá mới: `openssl rand -hex 32` → thêm `kMỚI:<hex>` lên ĐẦU keyring, GIỮ khoá cũ phía sau.
2. Deploy/restart (auth · seller · worker) — từ giờ mã hoá mới dùng khoá mới, dữ liệu cũ vẫn đọc được.
3. Re-encrypt tồn đọng: `node scripts/rotate-secretbox.js` (DATABASE_URL role bỏ-qua-RLS;
   `--dry-run` xem trước; idempotent — chạy lại vô hại). Xem header script cho lệnh dev/prod đầy đủ.
4. Chứng minh: `node scripts/rotate-secretbox.js --verify` → 100% dòng giải mã OK; đăng nhập MFA thử.
5. CHỈ SAU ĐÓ mới được bỏ entry khoá cũ khỏi keyring (khuyến nghị giữ thêm 1 chu kỳ backup —
   restore backup cũ cần khoá cũ để đọc blob trong đó).

---

## Checklist go-live (đánh dấu đủ mới nhận khách trả tiền)

- [ ] `BACKUP_ENC_KEY` thật + `OFFSITE_CMD`/`OFFSITE_DEST` + cron backup chạy + **đã diễn tập restore**
- [ ] `ALERT_WEBHOOK_URL` thật + đã thử nhận được 1 cảnh báo mẫu
- [ ] Giám sát uptime NGOÀI VPS trỏ vào URL công khai + `HEALTHCHECK_PING_URL` cho backup
- [ ] SMTP relay thật (`SMTP_USER`/`SMTP_PASSWORD`) + domain gửi đã verify + SPF/DKIM/DMARC = PASS (gửi thử tới Gmail)
- [ ] `WORKER_HEARTBEAT_URL` thật + healthchecks.io grace ≥ 15' + đã thấy 1 ping thành công
- [ ] (Ngoài phạm vi doc này) VPS + floating IP + tên miền + secret prod thật (KHÔNG devpassword) +
      SMTP relay thật + **API key GHTK/GHN production** cho các shop

**Liên quan:** `scripts/backup.sh` · `scripts/restore.sh` · `apps/worker/src/index.js`
(sweepMoneyAlerts) · `.env.example` (mục Backup + Cảnh báo) · docs/23 (deploy/backup) · docs/27 (observability).
