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

---

## Checklist go-live (đánh dấu đủ mới nhận khách trả tiền)

- [ ] `BACKUP_ENC_KEY` thật + `OFFSITE_CMD`/`OFFSITE_DEST` + cron backup chạy + **đã diễn tập restore**
- [ ] `ALERT_WEBHOOK_URL` thật + đã thử nhận được 1 cảnh báo mẫu
- [ ] Giám sát uptime NGOÀI VPS trỏ vào URL công khai + `HEALTHCHECK_PING_URL` cho backup
- [ ] (Ngoài phạm vi doc này) VPS + floating IP + tên miền + secret prod thật (KHÔNG devpassword) +
      SMTP relay thật + **API key GHTK/GHN production** cho các shop

**Liên quan:** `scripts/backup.sh` · `scripts/restore.sh` · `apps/worker/src/index.js`
(sweepMoneyAlerts) · `.env.example` (mục Backup + Cảnh báo) · docs/23 (deploy/backup) · docs/27 (observability).
