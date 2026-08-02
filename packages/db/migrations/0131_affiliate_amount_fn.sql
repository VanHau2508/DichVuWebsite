-- 0131 — Công thức tính tiền hoa hồng: MỘT bản duy nhất, đặt trong DB.
--
-- Ba nơi cần nó: checkout (ghi lúc đặt đơn), seller (tính lại khi SỬA ĐƠN làm đổi căn cứ),
-- và về sau là báo cáo. Ba nơi đó nằm ở BA IMAGE khác nhau — apps/checkout không có
-- packages/ trong image (xem Dockerfile), nên không import chung được như slugify.
--
-- Chép ba bản công thức nhân tiền là cách chắc chắn nhất để hai màn hình ra hai số. Đặt ở
-- DB thì cả ba gọi đúng một hàm, và nó nằm ngay cạnh dữ liệu nó sinh ra.
--
-- IMMUTABLE: cùng input luôn ra cùng output (không đọc bảng, không now()) → Postgres được
-- phép dùng trong index/generated nếu sau này cần.
CREATE FUNCTION affiliate_commission_amount(base_vnd bigint, rate_kind text, rate_value bigint)
RETURNS bigint LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE
    -- LÀM TRÒN XUỐNG: thà trả thiếu 1 đồng còn hơn đẻ ra đồng không có thật trong sổ.
    WHEN rate_kind = 'percent' THEN (greatest(base_vnd, 0) * rate_value) / 100
    -- fixed: hoa hồng cố định/đơn, nhưng KHÔNG vượt quá chính căn cứ tính — trả CTV nhiều
    -- hơn tiền hàng thu được là lỗ ngay ở dòng đầu tiên.
    ELSE least(rate_value, greatest(base_vnd, 0))
  END;
$$;

-- Vai nào ghi hoa hồng thì vai đó phải gọi được. app_rw (seller, sửa đơn) + app_checkout.
GRANT EXECUTE ON FUNCTION affiliate_commission_amount(bigint, text, bigint) TO app_rw, app_checkout;
