# 41 — Điểm thưởng khách hàng (loyalty points) (0086–0088)

Khách TÍCH điểm khi mua (đơn đã thanh toán), ĐỔI điểm thành giảm giá ở lần mua sau — giữ chân
khách quay lại. Thiết kế qua workflow (recon 4 vùng + 2 design + blueprint + 3 red-team: tiền/sổ
cái, đồng-thời/idempotent, RLS/gian-lận). 4 commit.

## Quyết định kiến trúc: theo GRAIN của repo, KHÔNG trigger/SECURITY-DEFINER

Blueprint đề xuất mô hình LÔ (lots) + FIFO + hàm SECURITY DEFINER + TRIGGER trên orders/refunds.
Đó là **bước ngoặt lớn khỏi grain** của codebase (app-level in-tx + worker sweep + ledger
append-only + RLS 2 trục + idempotency UNIQUE — y như inventory_ledger/refunds/customer-accounts),
và chính red-team cảnh báo rủi ro trigger (rollback đường thanh toán, double-clawback, FORCE-RLS/
owner). Nên v1 chọn bản **căn theo grain** giữ NGUYÊN mọi an-toàn-tiền red-team đòi, bỏ máy móc
rủi ro nhất; **HẾT HẠN theo lô + FIFO → cắt v2** (đó là thứ ép mô hình lô phức tạp).

## Mô hình dữ liệu (0086)

- **`loyalty_ledger`** — JOURNAL append-only (REVOKE UPDATE/DELETE mọi vai), chân lý mọi chuyển
  động CÓ DẤU: `earn +`, `redeem −`, `reversal +`, `clawback −`, `adjust ±`. Idempotency tầng DB:
  UNIQUE partial per-order theo kind (`earn_once`/`redeem_once`/`reversal_once`/`clawback_once`).
- **`loyalty_balances`** — CACHE số dư/khách. Có thể **ÂM = NỢ điểm** (clawback vượt số dư → earn
  tương lai bù; redeem đọc balance ≥0 nên không tiêu vào nợ; hiển thị `GREATEST(0,·)`).
- **`shop_loyalty_config`** — 1 dòng/shop: enabled, `earn_points_per_1000`, `redeem_vnd_per_point`
  (tỉ giá bất đối xứng có chủ đích), `earn_vesting_days`, `min_redeem_points`, `max_redeem_pct`.
- `orders +2`: `points_redeemed`, `points_discount_vnd`; `carts +1`: `points_redeem` (0087).

**Vai DB (least-priv):** role MỚI `app_loyalty` (worker cross-shop, cột-HẸP trên orders né PII như
app_expiry). Bất biến: `balance == Σ(ledger.delta)`; không double-earn/redeem/reversal/clawback;
redeem đòi balance ≥ điểm. RLS 2 trục (shop+customer) như customer-accounts; `app_store` ZERO grant.

## Đường tiền

- **TÍCH (worker sweep — commit 1):** choke point DUY NHẤT, không lệ 5-đường-paid/outbox-gate-email.
  **VESTING**: chỉ tích đơn `paid_at ≤ now − N ngày` → đơn hoàn TRONG cửa sổ KHÔNG bao giờ tích →
  clawback hiếm. Cơ số = **net HÀNG** (`subtotal − discount − points_discount`, LOẠI ship + LOẠI
  phần trả bằng điểm → chống farming redeem→earn). `points = floor(net/1000) × rate`. Idempotent
  qua UNIQUE + `INSERT ON CONFLICT DO NOTHING RETURNING` (chỉ cộng cache khi lô thực chèn). *(Bẫy:
  `FOR UPDATE` trên orders đòi quyền BẢNG, app_loyalty chỉ có cột → bỏ FOR UPDATE, idempotency lo qua UNIQUE.)*
- **ĐỔI (checkout in-tx — commit 2):** CHỈ khách ĐĂNG NHẬP (`ctx.customerId` từ phiên, guest bỏ qua
  ở SERVER). Khoá số dư `FOR UPDATE` (chân lý dưới khoá — chống double-spend + lost-update), cắt
  theo **3 trần** `min(số dư / tiền hàng / max_redeem_pct%)`, trừ số dư + ghi sổ redeem âm (order_id
  → UNIQUE/đơn). Giảm tiền HÀNG KHÔNG giảm ship. `request_hash` GỒM `pointsRedeem` (retry cùng key
  khác điểm → 422). `SET app.customer_id` GUC → RLS 2 trục.
- **THU HỒI (worker sweep — commit 3):** đơn TERMINAL (cancelled/refunded/returned):
  **reversal (+)** hoàn điểm đã đổi — ĐỘC LẬP `paid_at` (bắt cả đơn chưa-trả bị huỷ); **clawback
  (−)** thu hồi TOÀN BỘ điểm đã tích (có thể đẩy số dư âm = nợ). MỘT sweep keyed per-order → KHÔNG
  double-clawback. KHÔNG prorate: partial-refund (status còn 'delivered') không đụng điểm (v1).

## Cấu hình + UI (commit 4)

- **Seller API** (`loyalty-config.js`): GET config (mọi thành viên) · PUT (perm `loyalty.write` +
  **step-up** — chạm đường tiền) · GET `/reports/loyalty` (perm `reports.read`, nợ = Σ số dư dương ×
  tỉ giá; KHÔNG step-up). rbac: perm MỚI `loyalty.write` (owner+admin, STEP_UP_PERMS).
- **seller-admin**: nav "Điểm thưởng" + trang cấu hình (form + step-up interstitial) + card báo cáo nợ.
- **account**: thẻ "Điểm thưởng" trên dashboard (gate bằng config enabled, 0088) + trang
  `/account/points` (số dư `GREATEST(0,·)` + lịch sử). 
- **checkout**: widget đổi điểm trên GIỎ (khách đăng nhập thấy số dư + form `/cart/points`); guest
  không thấy. Dòng "Đổi N điểm − X₫" trong tổng kết.

## Chống gian lận (red-team đã áp)

Farming redeem→earn (cơ số net loại points_discount) · double-spend (khoá số dư + UNIQUE) · guest
(chặn ở server) · earn→spend→refund (vesting bọc phần lớn + sổ nợ backstop: số dư âm, redeem chặn
khi nợ, earn sau bù nợ) · double-clawback (một sweep, UNIQUE/đơn) · điểm đổi khi đơn unpaid huỷ
(reversal độc lập paid_at) · chéo-shop/IDOR (RLS 2 trục + composite FK) · P&L không double-count
(chi phí điểm ghi tại REDEEM giảm doanh thu; nợ là chỉ số, KHÔNG trừ lãi kỳ).

## Test

schema-invariants +3 (append-only, app_store zero, app_loyalty no-bypass) → 30. loyalty-earn 14 ·
loyalty-redeem 12 · loyalty-clawback 11 · admin-loyalty 15 (config+step-up+report+RBAC+account+widget).
Hồi quy: account 40 · buyer-flow 28 · checkout 17 · admin-reports 14 · worker 56 · rbac 11.

## Cắt v1 → v2

HẾT HẠN theo lô + FIFO (cần bảng lots) · nhắc-trước hết hạn (outbox) · prorate clawback/reversal
cho partial-refund · tặng/trừ điểm tay (adjust qua UI) · hạng khách/hệ số nhân/điểm sinh nhật ·
tích cho đơn tay (hiện đơn tay không stamp customer_id → tự nhiên không tích).
