/**
 * CÒN NỢ KHÁCH — tiền shop ĐANG GIỮ mà không còn quyền giữ.
 *
 * NGUỒN DUY NHẤT của con số này. Ba chỗ đọc nó (băng đỏ trên trang đơn · ô "Việc cần làm" ·
 * trang Công nợ) và cả ba PHẢI dùng chung đúng biểu thức dưới đây. Đây không phải sạch sẽ cho
 * đẹp: bản trước có luật riêng nằm thẳng trong pages.js, và nó vừa hụt vừa sai.
 *
 * ĐO THẬT trên shop ngày-60 (395 đơn) trước khi viết file này:
 *   · luật cũ `total_vnd - đã hoàn` chỉ xét đơn 'cancelled' → BỎ SÓT 10 đơn 'returned' đã thu
 *     tiền mà chưa hoàn, tổng 5.620.000₫ (bom hàng khách đã trả trước — hàng về, tiền chưa về);
 *   · và với đơn ĐÃ SỬA GIẢM thì nó tính RA SỐ ÂM nên tắt luôn băng cảnh báo: đơn duy nhất đang
 *     'cancelled' đã thu 1.990.000₫, hoàn 1.560.000₫, tức còn nợ 430.000₫ — luật cũ ra
 *     430.000 - 1.560.000 = -1.130.000 và kết luận "không nợ gì".
 *   Tổng cộng: 6.050.000₫ tiền của khách nằm trong túi shop, phần mềm hiện 0₫.
 *
 * CÔNG THỨC — ba vế, đọc theo nghĩa tiền chứ không theo trạng thái:
 *
 *     còn nợ = ĐÃ THU  −  ĐÃ HOÀN  −  ĐƯỢC PHÉP GIỮ
 *
 *   · ĐÃ THU = `amount_paid_vnd`, KHÔNG phải `total_vnd`. Hai số này lệch nhau ở mọi đơn từng
 *     sửa, và cái shop nợ là cái shop đã CẦM, không phải cái đơn ghi.
 *   · ĐÃ HOÀN = tổng bảng `refunds`, gồm cả `kind='edit_adjustment'` — tiền trả lại vì sửa đơn
 *     giảm cũng là tiền đã về tay khách.
 *   · ĐƯỢC PHÉP GIỮ = `total_vnd` khi đơn CÒN SỐNG, và 0 khi đơn đã chết (huỷ / hoàn về / đã
 *     hoàn tiền). Đơn chết nghĩa là khách không nhận được gì, nên shop không có quyền giữ đồng
 *     nào — kể cả phí ship.
 *
 * `greatest(0, …)` vì đơn giao xong mà shop hoàn thiện chí một phần sẽ ra số âm; âm nghĩa là
 * shop đã trả DƯ, không phải khách đang nợ shop — chuyện đó không thuộc màn hình này.
 *
 * DÙNG: các biểu thức đòi bảng `orders` được đặt bí danh `o`.
 */

/**
 * ĐÃ THU — và cái bẫy `amount_paid_vnd = 0`.
 *
 * Cột này (0077) là LAZY: nó chỉ được KHOÁ lúc sửa đơn đã-trả lần đầu. Giá trị 0 trên một đơn
 * ĐÃ TỪNG THU TIỀN nghĩa là "chưa khoá", và quy ước của 0077 là dùng `total_vnd` — vì đơn chưa
 * từng sửa nên total chính là số đã charge. Backfill của 0077 cũng CỐ Ý bỏ qua đơn
 * unpaid/refunded/cancelled ("lazy xử khi cần").
 *
 * Bản đầu của file này đọc thẳng `coalesce(amount_paid_vnd, 0)` và thế là BÁO THIẾU NỢ đúng ở
 * nhóm đơn quan trọng nhất: đơn đã thu tiền rồi chết (huỷ / hoàn về / hoàn tiền) — chính là
 * nhóm mà màn hình công nợ sinh ra để canh. Đo trên DB dev: 693 đơn `paid` có
 * `amount_paid_vnd = 0`. Bộ `edit-paid-order.e2e.mjs` bắt được (nó CỐ Ý dựng đơn kiểu này).
 *
 * "Đã từng thu" = `paid_at IS NOT NULL` — quy tắc sổ cái ever-paid của docs/37, và nó SỐNG SÓT
 * qua hoàn tiền (refundOrder lật payment_status nhưng GIỮ paid_at). Gỡ đánh dấu đã-thu thì
 * `paid_at` về NULL, nên đơn bấm nhầm không bị tính nợ oan.
 */
export const OWED_PAID_SQL = `CASE
    WHEN coalesce(o.amount_paid_vnd, 0) > 0 THEN o.amount_paid_vnd
    WHEN o.paid_at IS NOT NULL THEN o.total_vnd
    ELSE 0 END`;

/** Số tiền shop CÓ QUYỀN giữ trên đơn này. */
export const OWED_ENTITLED_SQL = `CASE WHEN o.status IN ('cancelled', 'returned', 'refunded') THEN 0 ELSE o.total_vnd END`;

/** Tổng đã hoàn cho đơn — mọi loại phiếu. */
export const OWED_REFUNDED_SQL = `coalesce((SELECT sum(r.amount_vnd) FROM refunds r WHERE r.order_id = o.id), 0)`;

/** Còn nợ khách, ₫. Không bao giờ âm. */
export const OWED_SQL = `greatest(0, ${OWED_PAID_SQL} - ${OWED_REFUNDED_SQL} - ${OWED_ENTITLED_SQL})`;

/**
 * Vì sao đơn này còn nợ — để màn hình nói được LÝ DO thay vì chỉ ném ra một con số. Chủ shop
 * cần biết nên xử lý thế nào, và ba lý do dưới đây dẫn tới ba hành động khác nhau.
 */
export const OWED_REASON_SQL = `CASE
    WHEN o.status = 'cancelled' THEN 'huy_da_thu'
    WHEN o.status IN ('returned', 'refunded') THEN 'hoan_ve_chua_tra'
    ELSE 'thu_thua' END`;

export const OWED_REASON_TEXT = {
  huy_da_thu: 'Đơn đã huỷ nhưng khách đã thanh toán',
  hoan_ve_chua_tra: 'Hàng đã về shop nhưng chưa hoàn tiền',
  thu_thua: 'Đã thu nhiều hơn giá trị đơn (đơn bị sửa giảm)',
};
