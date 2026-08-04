/**
 * TỒN AN TOÀN — công thức "CÒN BÁN ĐƯỢC ONLINE", NGUỒN DUY NHẤT của checkout (0140).
 *
 * Kho này đã dính lớp lỗi "một con số hiển thị ở nhiều màn, mỗi màn một biểu thức" ba đợt
 * liên tiếp (docs/58, 60, 61). Toàn hệ có 25 chỗ tính `on_hand - reserved`; nếu rải tay thêm
 * phần trừ vùng đệm vào từng chỗ thì chuyện lệch là chắc chắn, chỉ là lúc nào.
 *
 * MỘT BẢN DUY NHẤT, KHÔNG sao chép. Ba service (checkout · storefront · seller) dùng chung
 * đúng file này qua bind-mount `/app/safety-stock.js` khai trong compose.dev.yml VÀ
 * compose.prod.yml — cùng cơ chế với packages/net-guard (hàng rào SSRF) và
 * packages/auth/src/ratelimit.js. Từ `src/` thì import là `'../safety-stock.js'`.
 *
 * Quên mount ở một service = service đó CHẾT NGAY LÚC KHỞI ĐỘNG (không giải được import).
 * Đó là chủ ý: hỏng to và hỏng sớm, hơn hẳn ba bản sao lặng lẽ trôi khỏi nhau — đúng lớp lỗi
 * đã cắn kho này ba đợt liền (docs/58, 60, 61).
 *
 * ── ĐỊNH NGHĨA ───────────────────────────────────────────────────────────────
 *   đệm     = ghi đè của biến thể, KHÔNG có thì ceil(tồn thực × tỉ lệ shop / 100)
 *   bán được = max(0, tồn thực − đang giữ chỗ − đệm)
 *
 * `ceil` chứ không phải `floor`: làm tròn LÊN nghĩa là giữ nhiều hơn một chút. Đây là vùng
 * đệm chống sai số — chệch về phía an toàn mới đúng ý định của nó. (Khác hẳn tiền: ở đó
 * affiliate_commission_amount làm tròn XUỐNG để không đẻ đồng không có thật.)
 *
 * `max(0, …)`: shop có thể đặt đệm lớn hơn tồn hiện có (chừa 20% khi kho còn 3 cái) — kết quả
 * là 0, không phải số âm.
 *
 * ── PHẠM VI (v0, CỐ Ý) ──────────────────────────────────────────────────────
 * Đệm chỉ chặn ĐƯỜNG KHÁCH TỰ MUA: storefront + checkout. KHÔNG chặn đơn người bán tự tạo,
 * vì lúc đó họ đang đứng trước khách và NHÌN THẤY kho thật — đệm sinh ra để bù cho việc con
 * số trong máy không đáng tin, mà người thì đáng tin hơn con số. Ranh giới này có test canh.
 *
 * Mọi màn của NGƯỜI BÁN (tồn kho, danh sách SP, cảnh báo sắp hết, bot) vẫn hiện SỐ THẬT —
 * shop phải thấy đúng cái đang có trong kho, đệm là chuyện của trang bán hàng.
 */

/** Đệm hiệu lực của một dòng inventory_levels (alias `il`), đọc tỉ lệ từ shop hiện tại. */
export const SAFETY_SQL = `coalesce(il.safety_stock_qty,
    ceil(il.on_hand * (SELECT s.safety_stock_pct FROM shops s WHERE s.id = current_shop_id()) / 100.0)::int)`;

/** Số CÒN BÁN ĐƯỢC ONLINE của một dòng inventory_levels (alias `il`). */
export const AVAIL_SQL = `greatest(0, il.on_hand - il.reserved - ${SAFETY_SQL})`;

/** Bản JS cho chỗ đã có sẵn on_hand/reserved/safety trong bộ nhớ (checkout giữ FOR UPDATE). */
export const availOf = (onHand, reserved, safety) => Math.max(0, onHand - reserved - safety);
