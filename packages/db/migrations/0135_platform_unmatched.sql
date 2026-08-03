-- 0135 — HÀNG ĐỢI ĐỐI SOÁT cho tiền SHOP TRẢ CHO NỀN TẢNG.
--
-- Lỗ đang vá: nhánh tiền-thuê-bao của webhook SePay (apps/payment/src/server.js:254-284)
-- return TRƯỚC khi tới persistUnmatched, nên MỌI lý do không khớp — no_ref (shop gõ thiếu
-- nội dung chuyển khoản), charge_not_found, charge_cancelled (shop bấm "Tạo mã" lần nữa sau
-- khi đã chuyển tiền theo mã cũ), amount_short (ngân hàng trừ phí) — chỉ đẻ ra MỘT DÒNG LOG
-- rồi biến mất. Tiền đã nằm trong tài khoản nền tảng, DB không có vết, sweepMoneyAlerts đếm
-- từ `unmatched_transfers` nên không bao giờ kêu. Bảy ngày sau shop bị khoá vì "chưa trả".
--
-- VÌ SAO BẢNG RIÊNG, không dùng chung `unmatched_transfers`: bảng kia shop_id NOT NULL + RLS
-- FORCE theo current_shop_id(). Ở đây shop là thứ ta CHƯA BIẾT (đó chính là lý do không
-- khớp được). Nới shop_id thành nullable là chọc thủng đúng cái cột mà RLS của tiền-khách
-- dựa vào — đắt hơn nhiều so với một bảng mới.
CREATE TABLE platform_unmatched_transfers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL,
  provider_event_id text NOT NULL,
  amount_vnd        bigint NOT NULL,
  content           text,
  received_account  text,
  reason            text NOT NULL CHECK (reason IN ('no_ref','charge_not_found','charge_cancelled','charge_paid','amount_short')),
  -- Biết được shop nào thì ghi (charge_* / amount_short tra ra từ billing_charges); no_ref
  -- và charge_not_found thì NULL — người vận hành đối chiếu bằng nội dung + số tiền.
  shop_id           uuid REFERENCES shops(id),
  pay_ref           text,
  raw               jsonb NOT NULL,
  resolved_at       timestamptz,
  resolved_by       uuid REFERENCES users(id),
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- Idempotent theo sự kiện: SePay gửi lại cùng một giao dịch thì không đẻ dòng thứ hai.
CREATE UNIQUE INDEX platform_unmatched_event_once ON platform_unmatched_transfers (provider, provider_event_id);
CREATE INDEX platform_unmatched_open ON platform_unmatched_transfers (created_at) WHERE resolved_at IS NULL;

-- KHÔNG bật RLS: bảng CẤP NỀN TẢNG, không thuộc shop nào. Cô lập bằng GRANT hẹp thay vì
-- policy — vai nào không được kể tên dưới đây thì không đọc/ghi nổi.
ALTER TABLE platform_unmatched_transfers OWNER TO app_owner;

-- payment: CHÈN (và SELECT vì ON CONFLICT dưới RLS/quyền cần đọc để đánh giá xung đột).
GRANT SELECT, INSERT ON platform_unmatched_transfers TO app_payment;
-- worker (vai đọc chéo shop của cảnh báo tiền): chỉ ĐẾM.
GRANT SELECT ON platform_unmatched_transfers TO app_expiry;
-- console nền tảng: xem + đánh dấu đã xử lý. KHÔNG cho DELETE — đây là vết của TIỀN.
GRANT SELECT, UPDATE (resolved_at, resolved_by, note) ON platform_unmatched_transfers TO app_platform;
