# Triển khai + Backup production (P0-8, phần code/config)

> **Đã có (kiểm chứng được):** `infra/compose.prod.yml`, `scripts/deploy.sh`,
> `scripts/backup.sh`, `scripts/pitr-drill.sh`. PITR drill 5/5 (khôi phục tới thời điểm),
> logical restore drill 11/11, compose.prod config hợp lệ + fail-loud khi thiếu secret.
> **Cần bạn (hạ tầng):** VPS + **floating IP** (ADR-004, bắt buộc trước khách đầu), DNS,
> đích **offsite** (S3/B2), SMTP relay, alert. Đây là phần *code/config*; không tự mua hạ tầng.
>
> **Rà soát đối kháng 4 chiều (secret/mạng/DR/deploy): 9 lỗi thật đã sửa** (2 HIGH):
> backup thiếu offsite vẫn exit 0 (DR giả) → fail-loud; thiếu `archive_timeout` → RPO vô hạn
> lúc ít giao dịch → thêm 300s; mật khẩu vào argv (`ps`); backup world-readable → `umask 077`;
> guard bỏ sót khoá MFA toàn-0; prune WAL khi base lỗi; deploy luôn abort (Caddy thiếu healthcheck);
> /healthz nông che mật khẩu sai → thêm kiểm auth từng role. Chi tiết: xem git log commit P0-8.

## 1. Khác biệt prod vs dev

| | dev (`compose.dev.yml`) | prod (`compose.prod.yml`) |
|---|---|---|
| Secret | `devpassword` hardcode | `${VAR:?}` từ `.env` (fail nếu thiếu) |
| Code | bind-mount src (hot-reload) | COPY vào image (`npm ci`, node pin digest) |
| Cổng ra ngoài | nhiều (dev tiện) | **chỉ Caddy 80/443** |
| Postgres | mặc định | **WAL archiving** (PITR) + `wal-init` chown |
| migrate | `up --seed` | `up` (KHÔNG seed) |
| Email | Mailpit | **SMTP relay thật** |
| Bỏ | — | dbtest, toolbox, mailpit |
| Giới hạn | — | RAM + log mỗi service |

## 2. Bootstrap prod (lần đầu)

```bash
# 0. Trên VPS: cài Docker + docker compose. Clone repo. Trỏ DNS:
#    A  @/*.nentang.vn, admin, cdn  →  <FLOATING_IP>   (ADR-004)
#    Cloudflare token Zone:DNS:Edit cho wildcard *.nentang.vn (DNS-01).
# 1. Tạo .env từ mẫu, điền secret THẬT (sinh: openssl rand -hex 32 / -base64 24):
cp .env.example .env && $EDITOR .env      # KHÔNG commit .env
# 2. Deploy (tự lo migrate → provision role → up → health):
bash scripts/deploy.sh
```
`deploy.sh` từ chối chạy nếu `.env` còn giá trị mẫu (`change-me`/`devpassword`).

## 3. Deploy các lần sau

```bash
git pull && bash scripts/deploy.sh
```
Thứ tự bắt buộc (deploy.sh lo): build → postgres → **migrate** → **provision-db-roles**
(đặt mật khẩu role thật) → up service → kiểm sức khoẻ. **Rollback:**
`git checkout <commit_cũ> && bash scripts/deploy.sh` (migration forward-only + tương thích
ngược 1 phiên bản). Hỏng dữ liệu → restore (mục 5).

## 4. Backup (cron)

```
# WAL mỗi 5 phút (RPO nhỏ):        */5 * * * *  bash scripts/backup.sh wal
# Full mỗi đêm (logical+base+media): 0 3 * * *   bash scripts/backup.sh
```
Full gồm: `logical.sql.gz` (pg_dumpall), `base.tar.gz` (pg_basebackup), `wal.tar.gz`,
`media.tar.gz`, `caddy_data.tar.gz` (**chứng chỉ** — mất = cấp lại hàng trăm cert, dính
rate-limit Let's Encrypt). **Bắt buộc cấu hình `OFFSITE_CMD`** (đẩy S3/B2) — chỉ backup
cục bộ trên chính VPS **không phải DR**. WAL archive được prune theo `BACKUP_RETENTION_DAYS`
để không đầy đĩa.

## 5. Khôi phục

**Logical (DR đơn giản — máy mới):** dựng postgres mới, `gunzip -c logical.sql.gz | psql -U postgres`.
Chứng minh bằng `scripts/backup-restore-drill.sh` (11/11: data+roles+RLS+cô lập tenant còn nguyên).

**PITR (tới một thời điểm):** giải nén `base.tar.gz` làm PGDATA, thêm `restore_command` trỏ WAL
archive + `recovery_target_time = '<thời điểm>'` + `touch recovery.signal`, khởi động postgres →
replay tới đúng thời điểm. Chứng minh bằng `scripts/pitr-drill.sh` (5/5: khôi phục tới T1, có
'before', không có 'after').

## 6. Còn thiếu (không phải code — cần bạn quyết/tài nguyên)

- **Floating IP** (ADR-004) — mua ngay từ đầu; đổi VPS sau = liên hệ từng khách đổi DNS.
- **Đích offsite thật** (S3/B2/box khác) cho `OFFSITE_CMD`.
- **SMTP relay** (Resend/SES...) — VPS VN thường bị chặn cổng 25.
- **Alert ngoài VPS** (Telegram/Zalo: 5xx, checkout, webhook, DLQ, DB, backup) + uptime từ VPS thứ 2.
- **`seller-admin`** (UI nhà bán hàng, Caddy đã route `admin.nentang.vn`) — giai đoạn UI.
- Làm cứng sâu: `app_owner` không-superuser (custom init), SBOM/scan image, pin cả Postgres/Redis/MinIO theo digest.
