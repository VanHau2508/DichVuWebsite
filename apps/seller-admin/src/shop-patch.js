/**
 * Đọc-trộn-ghi cho hồ sơ cửa hàng — bắt buộc với MỌI form chỉ sửa MỘT PHẦN hồ sơ.
 *
 * `PATCH /shops/:id` của seller là GHI ĐÈ TOÀN BỘ, KHÔNG phải merge. Nó chạy đúng một câu
 *
 *     UPDATE shops SET name=$1, contact_email=$2, …, ship_over_max_behavior=$22
 *      WHERE id = current_shop_id()
 *
 * đặt CẢ 22 cột trong một lần, và quy ước `'' → NULL`. Nghĩa là một form gửi lên 3 ô
 * (ví dụ wizard onboarding: tên + SĐT + địa chỉ) sẽ XOÁ TRẮNG phí ship, ngưỡng miễn phí
 * ship, ngưỡng sắp hết hàng, trần đơn chờ theo IP/SĐT, toạ độ gốc giao hàng, hệ số đường
 * bộ và hạn ẩn danh PII. HTTP trả 200. Không lỗi, không cảnh báo, không dấu vết trong log.
 * Chủ shop phát hiện ra khi khách đặt hàng và thấy phí ship về 0 — tức là sau khi đã mất
 * tiền, và không có cách nào biết giá trị cũ là bao nhiêu để đặt lại.
 *
 * Nên: GET /shops/:id (trả đủ 22 cột) → dựng lại NGUYÊN body từ giá trị hiện tại → mới đè
 * đúng ô mà form đang sửa.
 *
 * `null → ''`, TUYỆT ĐỐI KHÔNG `String(null)`. Chuỗi 'null' đi qua parseMoney ở seller thì
 * thành NULL (may, vì parseMoney lọc phi-số) — nhưng ở cột CHỮ như ship_from_province nó
 * nằm nguyên thành chữ "null", rồi isProvince() từ chối và cả form 400 mà không ai hiểu vì sao.
 *
 * Tác dụng phụ có chủ ý: gửi lại `pii_retention_months` bằng ĐÚNG giá trị cũ khiến chốt
 * "chỉ chủ shop được đổi hạn lưu dữ liệu khách" (seller kiểm `cur !== mới`) không kích hoạt,
 * nên admin vẫn qua được các form không đụng tới ô đó.
 *
 * File riêng chứ không để trong server.js: server.js gọi server.listen() lúc nạp module nên
 * không import được từ `node --test`. Bộ apps/seller-admin/test/shop-patch.test.js canh danh
 * sách cột dưới đây khớp ĐÚNG câu UPDATE ở apps/seller/src/server.js — thêm cột vào UPDATE
 * mà quên thêm ở đây là lại mở lại đúng lỗ hổng trên.
 */

/** 22 cột mà PATCH /shops/:id ghi. Thứ tự theo câu UPDATE ở seller cho dễ đối chiếu. */
export const SHOP_PATCH_KEYS = [
  'name', 'contact_email', 'contact_phone', 'business_address',
  'ship_fee_vnd', 'free_ship_threshold_vnd', 'low_stock_threshold',
  'max_pending_per_ip', 'max_pending_per_phone',
  'ship_fee_far_vnd', 'ship_extra_per_500g_vnd', 'default_weight_gram', 'ship_from_province',
  'pii_retention_months',
  'ship_mode', 'ship_origin_lat', 'ship_origin_lng', 'ship_base_vnd',
  'ship_per_km_vnd', 'ship_max_km', 'ship_road_factor', 'ship_over_max_behavior',
];

/**
 * @param shop bản ghi GET /shops/:id (nguồn của các cột KHÔNG sửa).
 * @param overrides đúng những ô mà form đang sửa, đã trim.
 * @returns body đủ 22 khoá cho PATCH /shops/:id, mọi giá trị là chuỗi.
 */
export function shopPatchBody(shop, overrides) {
  const body = {};
  for (const k of SHOP_PATCH_KEYS) body[k] = shop?.[k] == null ? '' : String(shop[k]);
  return { ...body, ...overrides };
}
