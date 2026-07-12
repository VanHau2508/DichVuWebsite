# Lộ trình 30 ngày (bản chỉnh) — tới 1 shop pilot thật

> Bản này **chỉnh lại** lộ trình trong bản audit (yeucau.txt §7), đã **áp 5 nâng cấp**
> và **gắn gate rõ cho từng ngày**. Soạn để DUYỆT trước khi code tiếp. Giả định người
> code chính là 1 (không phải 2 dev như bản gốc) → chia rõ **việc code được ngay** vs
> **việc cần tài nguyên của bạn** (VPS, floating IP, offsite storage, SMTP, shop thật).

## 0. 5 nâng cấp đã áp (khác bản audit)

1. **UI = SSR form thuần + BFF, KHÔNG Next.js/SPA.** Admin/buyer là HTML render server,
   form POST + PRG, CSP `default-src 'none'` (không script). `seller-admin` là **BFF mỏng**
   forward tới service sẵn có. Nhanh hơn, chống XSS mạnh hơn, không thêm framework/service nặng.
   *(Audit đề xuất `apps/admin-web (Next.js)`; đây là nâng cấp thực tế đã làm.)*
2. **Gate = "chạy thật + mutation", không phải "test xanh".** Mỗi tính năng được **drive
   end-to-end trên stack đang chạy** + có **harness mutation** (gỡ lớp phòng thủ → e2e phải ĐỎ).
   Gate mỗi ngày là một phát biểu **kiểm chứng được**, không phải "đã code xong".
3. **Rà soát đối kháng trước mỗi commit.** Workflow nhiều "lăng kính" reviewer độc lập →
   **verify đối kháng** (mặc định REFUTED) → chỉ sửa lỗi đã xác nhận, rồi mới commit.
4. **Đi theo VÒNG PILOT trước.** Ship vòng tiền seller→buyer (sản phẩm→ảnh→đơn→checkout) +
   tự phục vụ tài khoản/nhân sự **sớm** (đã xong), **hoãn** custom-domain/export/theme-editor
   tới khi vòng lõi chứng minh dùng được.
5. **Gộp, không mở rộng service.** Một BFF nhỏ, KHÔNG 3 web app riêng. Strangler: giữ nguyên
   DB/RLS/test, không rewrite.

## 1. Trạng thái so với lộ trình gốc — CHƯA hoàn thành

| Khối audit | Trạng thái | Ghi chú |
|---|---|---|
| P0-2 UI (buyer + admin) | ✅ **Xong (vượt)** | buyer checkout + admin: login/MFA, đơn, SP/tồn/**ảnh(thứ tự+đại diện)**, nội dung (CMS phiên bản), **tài khoản(bật/tắt MFA, đổi mk)**, nhân sự + chấp nhận lời mời. Giỏ có thumbnail. |
| P0-3 `app_rw` least-privilege | ✅ Xong | migration siết + allowlist test |
| P0-4 chiếm lời mời | ✅ Xong | 3 nhánh + `email_verified_at` |
| P0-5 vòng đời tồn kho | ✅ Xong | ship consume + ledger + worker hết hạn |
| P0-6 DB creds ngoài migration | ✅ Xong | provision role qua script/secret |
| P0-7 build tái lập | ✅ Xong | lockfile + `npm ci` + pin digest |
| P0-1 prod edge routing | 🟡 **Một phần** | admin.nentang.vn ✅; **thiếu host webhook** (`hooks→payment`) + **thiếu edge integration test** |
| P0-8 prod deploy + DR | 🟡 **Code only** | compose.prod + script deploy/backup/PITR có; **chưa deploy/drill thật** (cần tài nguyên) |
| P1 MFA/session | 🟡 Một phần | bật/tắt MFA + đổi mk ✅ (phiên này); **thiếu rotate token sau MFA + trang session list/revoke** |
| P1 readiness/liveness | ❌ | `/healthz` còn nông (luôn 200, không kiểm DB/Redis) |
| P1 payment lifecycle | ❌/🟡 | thiếu `order.paid` outbox + email paid + COD mark-paid + gộp nhiều giao dịch + mask log |
| P1 data export | ❌ | chưa có endpoint export ZIP/CSV/media |
| P1 custom domain | 🟡 | bảng `domains`+`is_primary` có; **thiếu API add/challenge/verify-TXT/primary/revoke + UI** |
| P1 CI gates | 🟡 | thiếu security-scan/TLS-smoke/edge trong Actions; mutation nightly thiếu vài script |
| Tuần 3 prod ops/DR drill | ❌ | cần VPS/offsite/alert thật |
| Tuần 4 UAT + pilot | ❌ | cần shop thật + deploy thật |

**Kết luận thẳng:** Lộ trình 30 ngày **~45–55%** theo số ngày. **Mọi blocker kỹ thuật lõi
(P0-2…P0-7) đã đóng**, và phần UI đã **vượt** kế hoạch. Phần còn lại chủ yếu là **vận hành
production + một cụm P1 + UAT/pilot**, trong đó nhiều mục **cần tài nguyên của bạn**.

## 2. Ranh giới: tôi code được ngay vs cần bạn

- **Tôi làm được ngay (code/config + kiểm chứng):** edge routing + edge test, readiness,
  payment lifecycle, data export, custom-domain API + verify worker, session hardening,
  CI gates, seed UAT, feature flags.
- **Cần TÀI NGUYÊN của bạn (tôi không tự tạo được):** VPS + **floating IP**, tài khoản
  **offsite S3/B2**, **SMTP relay** thật, token **alert** (Telegram/Zalo), **tên miền** +
  DNS, và **shop pilot thật** + người UAT. Cả **security review độc lập/pentest**.

---

## 3. Lộ trình chỉnh — 4 tuần tới pilot

> Mỗi "ngày" = một lô có **GATE kiểm chứng được**. Với 1 người code, vài ngày có thể dồn/tách.
> Ngày nào **cần bạn** được đánh dấu 🔑.

### Tuần A — đóng nốt blocker code (không cần tài nguyên ngoài)

**A1 · Prod edge + webhook host + edge test**
Caddyfile: thêm `hooks.nentang.vn /webhooks/sepay → payment`; rà route admin/storefront/checkout.
Viết **integration test đi QUA Caddy** (không chỉ gọi service nội bộ) trong CI.
*Gate:* webhook SePay + admin + storefront + checkout đến đúng service **qua edge** trong test.

**A2 · Readiness/liveness + request-id**
Tách `/livez` (process) vs `/readyz` (DB+Redis+migration version). Thêm correlation-id vào log.
*Gate:* tắt Postgres → `/readyz` 503, `/livez` 200; mọi log có request-id.

**A3 · Payment lifecycle khép kín**
`order.paid` qua outbox → email "đã thanh toán"; **gộp nhiều giao dịch** thiếu tiền tới đủ tổng;
COD **mark-paid** có RBAC + audit; **mask log** tài chính (chỉ last4/hash).
*Gate (mutation):* bỏ mask → e2e đỏ; QR đủ tiền → `order.paid` + email; COD mark-paid ghi audit.

**A4 · Data export**
Export products/variants/orders/customers + media manifest (ZIP/CSV). Owner + **step-up** +
audit + **link tải hết hạn**.
*Gate:* owner export → tải ZIP hợp lệ; non-owner/không step-up → chặn.

**A5 · Custom domain tự phục vụ**
API add/challenge/status/primary/revoke + **worker verify TXT** + UI admin.
*Gate:* thêm domain → verify TXT → phục vụ qua Caddy on-demand TLS trên staging; revoke → chết.

**A6 · Session hardening**
Rotate session token sau MFA verify/activate; trang **liệt kê + thu hồi phiên khác**.
*Gate (mutation):* bỏ rotate → e2e đỏ; revoke phiên khác → phiên đó 401.

**A7 · CI đóng đủ cổng**
Đưa security-scan + smoke-TLS + edge integration + full mutation vào Actions; sửa "rỗng = xanh giả".
*Gate:* CI chạy security/TLS/edge/e2e/mutation trên commit sạch, đỏ đúng khi gỡ 1 lớp.

*Gate tuần A:* mọi P0-1/P1 code-side đóng; CI xanh thật trên commit sạch.

### Tuần B — production ops + DR (🔑 cần tài nguyên bạn)

**B1 🔑 Deploy thật** — VPS + **floating IP**; deploy bằng `compose.prod` + script sẵn có; ACME TLS.
*Gate:* stack chạy sau floating IP, chứng chỉ thật, `/readyz` xanh.

**B2 🔑 Backup offsite + PITR thật** — S3/B2; WAL archiving thật + media backup; **restore vào host mới**.
*Gate:* khôi phục từ offsite lên host trắng; đo **RPO ≤ 5 phút** thực tế (không chỉ pg_dumpall).

**B3 🔑 Uptime + alert ngoài** — probe từ VPS thứ 2; alert Telegram/Zalo cho 5xx/checkout/webhook/DLQ/DB/backup.
*Gate:* gây lỗi giả → alert tới đúng kênh; có runbook + on-call.

**B4 · Load + chaos + rollback drill** — tải cỡ pilot; restart Redis/SMTP/worker/DB; deploy→rollback.
*Gate:* có bằng chứng deploy/rollback/restore/alert thật.

*Gate tuần B:* deploy/rollback/restore/alert đều có bằng chứng.

### Tuần C — UAT (🔑 cần người + shop gần thật)

**C1 🔑 3 shop UAT** — thời trang / mỹ phẩm / nội bộ; dữ liệu gần thật; test **Android/iOS + mạng chậm**.
**C2 · UAT toàn luồng** — seller (SP/theme/tồn/đơn/payment/content/nhân sự) · ops (create/suspend/restore/export) · buyer (giỏ/checkout/QR/email/tra cứu).
**C3 🔑 Sửa Critical/High + review độc lập** — pentest phạm vi hẹp (ngoài đội) trên **public staging**.
*Gate tuần C:* không còn Critical/High; go/no-go chạy qua endpoint public.

### Tuần D — Pilot có kiểm soát (🔑)

**D1 🔑 Mở 1 shop pilot thật** — feature flag QR/content-preview/block-editor; theo dõi sát 7 ngày; chưa cam kết SLA.
*Gate CUỐI (Definition of Done V1 trả phí):* 1 shop **nhận đơn thật**, alert chạy, backup **khôi phục được**, **không can thiệp DB tay**, không Critical/High tồn.

---

## 4. Đề xuất bắt đầu

Vì phần **cần tài nguyên của bạn** (Tuần B–D) chưa sẵn, nên bắt đầu ngay **Tuần A** (đóng nốt
blocker code) — đề xuất thứ tự theo giá trị/rủi ro: **A1 edge+webhook → A3 payment lifecycle →
A2 readiness → A4 export → A6 session → A5 domain → A7 CI**. Mỗi mục xong sẽ verify + review
đối kháng + commit riêng như các mục vừa rồi.

Song song, bạn chuẩn bị dần: VPS + floating IP, tài khoản offsite, SMTP relay, token alert,
tên miền — để Tuần B khởi động được ngay.
