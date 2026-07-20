# Nền production: secret role + build tái lập (P0-6, P0-7)

> **P0-6 (secret role ngoài migration): XONG** — `provision-db-roles.sh` đặt/rotate 9 role
> từ env (chạy thật 9/9, service vẫn kết nối). `.env.example` là hợp đồng env.
> **P0-7 (build tái lập): XONG** — 9 lockfile + `npm ci` + node pin theo digest; rebuild
> toàn stack thành công, runtime xanh (auth 40, media 9, worker 18).

Hai mảnh "nền production" — chưa phải deploy đầy đủ (đó là P0-8: prod compose, floating IP,
offsite backup/PITR, SMTP relay, alert — xem docs/03), nhưng gỡ hai lỗ khiến hệ **không thể**
lên prod an toàn.

## 1. P0-6 — Mật khẩu role không kẹt trong migration bất biến

**Vấn đề:** migration tạo role với `PASSWORD 'devpassword'`. Migration là BẤT BIẾN (checksum)
nên không thể đổi mật khẩu bằng cách sửa migration; và secret không nên nằm trong schema.

**Cách làm (giữ migration bất biến):**
- Migration vẫn tạo role với `devpassword` — coi là **mật khẩu bootstrap mặc định**, chỉ để
  dev chạy được. KHÔNG dùng ở prod.
- [`scripts/provision-db-roles.sh`](../scripts/provision-db-roles.sh) đặt lại mật khẩu 15 role
  từ **biến môi trường** (`APP_RW_PASSWORD`...) bằng `ALTER ROLE`. Prod chạy MỘT LẦN sau
  `migrate` với secret thật → `devpassword` không còn dùng được. **Rotate** = chạy lại với
  mật khẩu mới, không đụng migration. Idempotent; role thiếu env thì bỏ qua (rotate từng phần).
- [`.env.example`](../.env.example) = hợp đồng env (giá trị giả): mật khẩu role, `MFA_ENC_KEY`,
  `SEPAY_WEBHOOK_KEY`, MinIO, SMTP relay. `.env` thật KHÔNG commit (đã ignore).

**`app_owner` ở prod KHÔNG phải superuser.** Dev để `POSTGRES_USER=app_owner` là superuser
bootstrap cho tiện. Prod: tạo `app_owner` chỉ **sở hữu schema** (chạy migration), không
superuser; app **không bao giờ** kết nối bằng `app_owner` — mỗi service dùng role hẹp của nó.

**Trình tự bootstrap prod:**
```
1. Tạo DB + role app_owner (owner schema, NOT superuser).
2. migrate up            # tạo role (devpassword) + schema + grant/policy
3. provision-db-roles.sh # đặt mật khẩu role THẬT từ secret manager  ← devpassword chết ở đây
4. Khởi động service với DATABASE_URL dùng mật khẩu thật.
```

## 2. P0-7 — Build tái lập (lockfile + npm ci + pin image)

**Vấn đề:** không có lockfile; mọi Dockerfile `npm install` → cùng một commit build ra
dependency khác nhau ở hai thời điểm.

**Cách làm:**
- **12 `package-lock.json`** (11 app + `packages/db`), sinh bằng `node:22-alpine` để khớp image.
  Lock ghi cả biến thể nền (argon2/sharp linuxmusl) → `npm ci` chọn đúng trong alpine.
- Dockerfile: `COPY package.json package-lock.json ./` + `RUN npm ci ...` (thay `npm install`).
  `npm ci` cài **đúng** cây trong lock, xoá `node_modules` trước → xác định + nhanh hơn.
- **Pin base image theo DIGEST**: `FROM node:22-alpine@sha256:16e22a…` (tất cả 9 image) → không
  trôi khi tag `22-alpine` cập nhật.

**Kiểm chứng:** `docker compose build` toàn stack — 9 image `npm ci` thành công (native argon2/
sharp/bullmq cài đúng trong alpine); runtime xanh: auth 40, media 9, worker 18.

*Bước sâu hơn (khi cần):* SBOM + scan image, và pin cả Postgres/Redis/MinIO/Caddy theo digest.

## 3. Còn lại của "nền production" (P0-8, ngoài phạm vi ở đây)

Prod compose/manifest, floating IP (ADR-004), offsite backup + WAL/PITR thật, SMTP relay thật,
alert ngoài VPS, deploy/rollback script, restore drill từ backup production-like. Xem docs/03 +
lộ trình 30 ngày (Tuần 3).
