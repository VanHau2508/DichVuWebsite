# 37 — Báo cáo lợi nhuận + giá vốn (0081): quy tắc sổ cái

Trang **Báo cáo** (owner/admin) trả lời câu hỏi "lãi bao nhiêu?" từ dữ liệu đường tiền
đã có: đơn, phiếu hoàn (0070), đổi-trả (0078), phí hãng, giá vốn (0081). Tài liệu này
chốt QUY TẮC GHI NHẬN — mọi thay đổi số liệu phải đối chiếu ở đây trước.

## Giá vốn (COGS)

- Nhập per **biến thể** ở trang Sản phẩm (bảng "Biến thể & tồn kho", cột *Giá vốn*).
  Nhân viên sản phẩm (catalog.write) NHẬP được; chỉ owner/admin (reports.read) XEM lãi.
- Lưu ở bảng riêng `variant_costs` — **không nằm trên `variants`** vì vai storefront/
  checkout có SELECT table-level trên variants (cột mới sẽ tự lộ). Storefront **không
  bao giờ** thấy giá vốn.
- **Snapshot lúc đặt hàng** vào `order_lines.unit_cost_vnd` (như giá bán): sửa giá vốn
  sau đó KHÔNG đổi đơn cũ. Sửa đơn giữ cost cũ cho dòng giữ nguyên; dòng thêm mới lấy
  cost hiện hành.
- `NULL` = *chưa khai* — không bao giờ coi là 0. Báo cáo kèm **độ phủ giá vốn** và hậu
  tố "(tạm tính)" khi <100%. Không backfill hồi tố; nợ NULL tự hết theo đơn mới.

## Quy tắc sổ cái (P&L)

1. **Doanh thu ghi tại `paid_at`**, điều kiện **ever-paid** (`paid_at IS NOT NULL`,
   không lọc `payment_status`): đơn hoàn toàn bộ vẫn ĐỨNG ở ngày thu tiền — khoản hoàn
   trừ ở ngày phiếu. Doanh thu hàng = `subtotal − discount`; thu ship là dòng riêng.
2. **Hoàn tiền trừ tại ngày phiếu** (`refunds.created_at`), **trừ mọi phiếu TRỪ
   `kind='edit_adjustment'`** — phiếu chênh của *sửa-đơn-đã-trả* đã phản ánh qua header
   đơn bị hạ; trừ thêm là trừ đúp. Bất biến kiểm được:
   `Σ thuần = Σ(subtotal−discount, ever-paid) − Σ refunds(kind≠edit_adjustment)`.
3. **COGS** = Σ(qty × cost snapshot) của đơn ever-paid trong kỳ; **loại** đơn
   `cancelled/refunded` mà `fulfillment='unfulfilled'` (tiền đã hoàn nhưng hàng chưa
   từng xuất kho — không có giá vốn thật).
4. **Đảo COGS** chỉ khi đổi-trả (RMA) `restocked=true`, tại ngày phiếu trả, theo
   snapshot `return_lines.unit_cost_vnd`. Hoàn tiền thường có tick "nhập kho" KHÔNG
   đảo COGS (tiền không ánh xạ được sang số lượng) — thiên lệch AN TOÀN (lãi ghi thấp
   hơn thực); muốn đúng hãy dùng luồng **Đổi-trả**.
5. **Phí hãng** = `carrier_fee_vnd` (**báo giá** lúc tạo vận đơn) theo ngày tạo vận
   đơn; giao tay không phí. Phần thực-tế-khác-báo-giá nằm ở quy tắc 9.
6. **Múi giờ VN** cho mọi mốc ngày; kỳ tối đa 366 ngày; >92 ngày tự gộp theo tháng.
7. **Dashboard Tổng quan dùng CÙNG quy tắc** (đồng bộ cùng đợt — có test chéo từng
   đồng). Số kỳ cũ **có thể thay đổi** khi sửa đơn đã trả (restatement — vết ở audit
   `order.edited`).
8. Đơn đã thu tiền bị **huỷ không kèm phiếu hoàn** vẫn nằm trong doanh thu (tiền
   shop còn giữ thật) — ghi phiếu hoàn nếu đã trả lại khách.
9. **HOÀ GIẢI ĐỐI SOÁT COD** — `settlement_variance = Σ(amount_vnd − expected_vnd)`
   của `cod_remittances`, tại **`remitted_at`** (ngày trên sao kê hãng), **cộng** vào
   lãi vận hành. Quy tắc 5 đã trừ phí **báo giá**, còn `expected_vnd` = Σ(tổng đơn −
   phí báo giá); nên chênh này đúng bằng phần thực-tế-lệch-báo-giá — **cộng là đúng,
   không trừ đúp**. Thường **âm**: hãng trừ thêm phí hoàn hàng/bảo hiểm/thu hộ.

   Trước đợt này báo cáo **không hề đọc** `cod_remittances` dù bảng đó đã có và trang
   Đối soát COD đã hiện chênh lệch → P&L vĩnh viễn tin vào báo giá và **báo lãi cao
   hơn thật**. Đây là loại sai đắt nhất: người bán định giá dựa trên con số đó.

   `remitted_at` kiểu **DATE**, không phải timestamptz — dùng `bucketSql`/`rangeSql`
   của cột timestamptz cho nó là SAI (Postgres ép date→timestamp rồi `AT TIME ZONE`
   dịch 7 giờ, phiếu nhảy sang ngày khác). Có `bucketDateSql`/`rangeDateSql` riêng.
11. **HOA HỒNG CTV** (docs/51) là **chi phí** ở tầng vận hành, tại **`eligible_at`** (ngày
    hoa hồng đủ điều kiện), KHÔNG phải ngày đặt đơn. Tính `status IN ('eligible','paid')`;
    **bỏ** `pending` và `void`. Ghi chi phí ở ngày đặt đơn là **ghi khống**: lúc đó khoản
    đó mới là *tạm tính*, đơn huỷ/hoàn trong hạn đổi trả thì rụng hẳn. Đã chi (`paid`) vẫn
    là chi phí của kỳ nó **phát sinh**, không phải kỳ trả tiền.
10. **Hãng còn giữ tiền** (`cod_outstanding`: đơn COD đã giao qua hãng, `cod_settled_at`
    NULL) là **MEMO tại thời điểm xem**, KHÔNG theo kỳ và **KHÔNG trừ vào lãi** — đó là
    khoản *phải thu*, tiền vẫn của shop. Nhưng phải hiện cạnh lãi: "lãi 50 triệu" mà 30
    triệu đang nằm ở hãng là hai tình cảnh rất khác nhau.

## Phân quyền

| Thao tác | Perm | Vai trò |
|---|---|---|
| Xem báo cáo lãi | `reports.read` | owner, admin |
| Nhập giá vốn | `catalog.write` | owner, admin, catalog_manager |
| Xuất CSV báo cáo | `export` + step-up | owner |

## Cắt v1 → v2

Lãi per-đơn trong chi tiết đơn · nhập cost hàng loạt (bulk/CSV) · báo cáo theo
kênh/nhân viên/tỉnh · so sánh kỳ trước · phân bổ discount pro-rata vào bảng theo SP ·
 gửi báo cáo định kỳ qua email.
