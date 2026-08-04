/**
 * BIÊN NGÀY theo múi giờ VIỆT NAM — NGUỒN DUY NHẤT cho mọi bộ lọc "Từ ngày / Đến ngày".
 *
 * VÌ SAO PHẢI GOM VỀ MỘT CHỖ. Người bán chỉ có MỘT khái niệm "ngày 15": từ 0h tới 24h giờ
 * Việt Nam. Nhưng DB chạy ở UTC, nên `created_at >= '2026-07-15'::date` cắt tại 0h UTC =
 * **7 giờ sáng ngày 15 giờ VN**. Mọi đơn đặt trong khung 00:00–07:00 sáng — đúng khung săn
 * sale 0h, khung bận nhất của nhiều shop — bị đẩy sang ngày hôm trước.
 *
 * Trước bản vá, hệ có BA nơi lọc theo khoảng ngày và HAI học thuyết:
 *   · reports.js    — AT TIME ZONE (đúng)
 *   · purchasing.js — AT TIME ZONE (đúng, nhưng là bản CHÉP TAY của reports.js)
 *   · orders.js     — `::date` trần (SAI, biên UTC)
 * Nên cùng một ô "Từ 15 đến 15", trang Đơn hàng và trang Báo cáo trả về HAI TẬP ĐƠN KHÁC
 * NHAU, và bản xuất CSV đơn thì lệch với bản xuất CSV báo cáo. Chép tay thì sẽ trôi tiếp —
 * dùng chung một hằng thì giữ đồng bộ BẰNG CẤU TRÚC (cùng lối LATERAL_VAN_DON_HANG ở cod.js).
 *
 * SARGABLE: biến đổi nằm ở THAM SỐ, không áp lên cột → vẫn ăn index trên cột thời gian.
 * KHÔNG nội suy giá trị người dùng: from/to đi qua $i, $i+1 (nơi gọi phải validate DATE_RE).
 */
export const TZ = 'Asia/Ho_Chi_Minh';

/** Cột timestamptz. Khoảng [00:00 ngày `from` giờ VN, 00:00 ngày `to`+1 giờ VN). */
export const rangeSql = (col, i) =>
  `${col} >= ($${i}::date::timestamp AT TIME ZONE '${TZ}') AND ${col} < (($${i + 1}::date + 1)::timestamp AT TIME ZONE '${TZ}')`;

/** Bucket theo múi giờ VN cho cột timestamptz — CHỈ dùng ở SELECT/GROUP BY (WHERE giữ sargable). */
export const bucketSql = (col, group) => (group === 'month'
  ? `to_char(date_trunc('month', ${col} AT TIME ZONE '${TZ}'), 'YYYY-MM')`
  : `to_char((${col} AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD')`);

/**
 * Cột kiểu DATE thuần (ví dụ `cod_remittances.remitted_at` — ngày ghi trên sao kê hãng).
 * KHÔNG dùng bản timestamptz cho nó: Postgres ép date → timestamp rồi AT TIME ZONE dịch đi
 * 7 giờ, đẩy phiếu sang ngày khác — tiền nhảy kỳ. Ngày dương lịch không có múi giờ để quy đổi.
 */
export const rangeDateSql = (col, i) => `${col} >= $${i}::date AND ${col} <= $${i + 1}::date`;
export const bucketDateSql = (col, group) => (group === 'month'
  ? `to_char(date_trunc('month', ${col}), 'YYYY-MM')`
  : `to_char(${col}, 'YYYY-MM-DD')`);
