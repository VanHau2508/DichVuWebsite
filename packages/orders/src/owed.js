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

/**
 * Predicate lọc thanh toán dùng chung cho dashboard và danh sách đơn.
 *
 * `payment_status` là enum tương thích, nhưng dữ liệu tiền thật nằm ở `amount_paid_vnd`/`paid_at`.
 * Webhook hoặc dữ liệu legacy có thể cập nhật hai nguồn này lệch nhịp với enum; nếu mỗi màn hình
 * tự lọc enum thì ô Tổng quan và danh sách sau khi bấm sẽ trả hai tập đơn khác nhau.
 *
 * Các biểu thức giả định bảng orders mang bí danh `o`.
 */
export const PAYMENT_LIVE_SQL = `o.status NOT IN ('cancelled', 'refunded', 'returned')`;
// Hai hàng đợi "cần thu" chỉ chứa đơn phát sinh thật trên nền tảng và còn có thể xử lý.
// Đơn di cư vẫn đọc/lọc theo trạng thái được, nhưng không được biến thành việc cần làm hiện tại.
export const PAYMENT_ACTIONABLE_SQL = `${PAYMENT_LIVE_SQL} AND NOT o.is_migrated AND o.payment_status <> 'refunded'`;
export const PAYMENT_PAYABLE_SQL = `greatest(0, o.total_vnd - coalesce(o.fulfillment_adjustment_vnd, 0))`;
// payable=0 là đơn đã thanh toán theo paymentSummary; điều kiện > 0 giữ bốn bộ lọc rời nhau.
export const PAYMENT_UNPAID_SQL = `(${PAYMENT_PAYABLE_SQL}) > 0 AND (${OWED_PAID_SQL}) <= 0 AND ${PAYMENT_ACTIONABLE_SQL}`;
export const PAYMENT_PARTIAL_SQL = `(${OWED_PAID_SQL}) > 0 AND (${OWED_PAID_SQL}) < (${PAYMENT_PAYABLE_SQL}) AND ${PAYMENT_ACTIONABLE_SQL}`;
export const PAYMENT_PAID_SQL = `(${OWED_PAID_SQL}) >= (${PAYMENT_PAYABLE_SQL}) AND o.payment_status <> 'refunded'`;
export const PAYMENT_REFUNDED_SQL = `o.payment_status = 'refunded'`;

export function paymentFilterSql(value) {
  return {
    unpaid: PAYMENT_UNPAID_SQL,
    pending: PAYMENT_PARTIAL_SQL,
    paid: PAYMENT_PAID_SQL,
    refunded: PAYMENT_REFUNDED_SQL,
  }[value] ?? null;
}

/** Số tiền shop CÓ QUYỀN giữ trên đơn này. */
export const OWED_ENTITLED_SQL = `CASE
    WHEN o.status IN ('cancelled', 'returned', 'refunded') THEN 0
    ELSE greatest(0, o.total_vnd - coalesce(o.fulfillment_adjustment_vnd, 0)) END`;

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
    WHEN coalesce(o.fulfillment_adjustment_vnd, 0) > 0 THEN 'giao_thieu_da_thu'
    ELSE 'thu_thua' END`;

export const OWED_REASON_TEXT = {
  huy_da_thu: 'Đơn đã huỷ nhưng khách đã thanh toán',
  hoan_ve_chua_tra: 'Hàng đã về shop nhưng chưa hoàn tiền',
  giao_thieu_da_thu: 'Đã thu tiền cho phần hàng không giao thành công',
  thu_thua: 'Đã thu nhiều hơn giá trị đơn (đơn bị sửa giảm)',
};

/**
 * Tóm tắt thanh toán dùng chung cho seller, checkout và account.
 *
 * Đầu vào phải là các số đã đọc bằng OWED_PAID_SQL / OWED_REFUNDED_SQL. Hàm này không tự đọc
 * payment_status vì enum cũ không biểu diễn được trả một phần, chuyển dư hoặc tiền vào đơn đã chết.
 * `amount_due_vnd = 0` trên đơn chết cũng là chốt sinh QR: không mời khách trả thêm cho đơn không còn bán.
 */
export function paymentSummary({ total_vnd, amount_paid_vnd, refunded_vnd, fulfillment_adjustment_vnd, status }) {
  const total = Math.max(0, Number(total_vnd) || 0);
  const received = Math.max(0, Number(amount_paid_vnd) || 0);
  const refunded = Math.max(0, Number(refunded_vnd) || 0);
  const adjustment = Math.min(total, Math.max(0, Number(fulfillment_adjustment_vnd) || 0));
  const entitled = total - adjustment;
  const netReceived = Math.max(0, received - refunded);
  const dead = ['cancelled', 'returned', 'refunded'].includes(String(status));
  // Refund la tien tra RA, khong huy viec khach da thanh toan. Lay netReceived de tinh
  // amount_due se mo lai QR sau moi lan refund (thu 500k, refund 200k -> moi tra them 200k).
  // Chi reversal payment transaction moi lam `received` giam va mo lai phan con thieu.
  const amountDue = dead ? 0 : Math.max(0, entitled - received);
  const customerCredit = dead ? netReceived : Math.max(0, netReceived - entitled);

  let displayState;
  if (received > 0 && refunded >= received) displayState = 'refunded';
  else if (dead && customerCredit > 0) displayState = 'refund_due';
  else if (entitled === 0) displayState = 'paid';
  else if (received <= 0) displayState = 'unpaid';
  else if (received < entitled) displayState = 'partial';
  else if (netReceived > entitled) displayState = 'overpaid';
  else displayState = 'paid';

  return {
    total_vnd: total,
    received_vnd: received,
    refunded_vnd: refunded,
    net_received_vnd: netReceived,
    amount_due_vnd: amountDue,
    customer_credit_vnd: customerCredit,
    display_state: displayState,
  };
}
