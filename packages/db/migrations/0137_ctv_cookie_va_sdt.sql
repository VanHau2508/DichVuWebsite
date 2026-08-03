-- 0137 — hai lỗ của chương trình CỘNG TÁC VIÊN (đợt 4, docs/57).

-- ── LỖ 1: ô "Ghi nhớ mã giới thiệu (ngày)" của shop KHÔNG có tác dụng ────────
-- storefront/server.js đọc `resolved.affiliateCookieDays` — một thuộc tính CHƯA BAO GIỜ được
-- gán (grep toàn repo: đúng 1 kết quả, chính là chỗ đọc). `Number(undefined) || 30` → cookie
-- LUÔN 30 ngày, bất kể shop đặt gì. Mà vòng lưu/hiện của cấu hình thì KÍN: có cột DB, có
-- validate 1–90, có ô nhập, mở lại hiện đúng số vừa gõ — nên shop tin là đã có tác dụng.
-- Tuổi thọ cookie CHÍNH LÀ cửa sổ quy gán (checkout không so ngày click ở đâu cả), nên lệch
-- ở đây là CTV mất hoa hồng thật, hoặc shop trả hoa hồng cho đơn nó đã cố ý loại ra.
--
-- Vai app_store (storefront) chưa có quyền gì trên bảng này. Cấp CỘT HẸP NHẤT: chỉ shop_id
-- và cookie_days. Storefront KHÔNG được thấy rate_value/hold_days/block_self_referral —
-- nó chỉ cần biết cookie sống bao lâu.
GRANT SELECT (shop_id, cookie_days) ON shop_affiliate_config TO app_store;

-- storefront đọc TRƯỚC khi có ngữ cảnh tenant (nhánh ?ref= chạy ngay sau resolveShop, chưa
-- set app.shop_id) → policy cross-shop, y như app_expiry ở 0022/0136. Thứ giới hạn thực sự
-- là quyền CỘT ở trên.
CREATE POLICY store_affiliate_cookie ON shop_affiliate_config FOR SELECT TO app_store USING (true);

-- ── LỖ 2: chặn CTV tự mua bị vô hiệu khi SĐT lưu dạng +84 ───────────────────
-- Bên GHI (seller/affiliates.js) giữ nguyên dấu '+' và KHÔNG đổi 84→0:
--     String(body.phone).replace(/[^\d+]/g, '')
-- Bên ĐỌC (checkout canonPhone) bỏ mọi ký tự không phải số RỒI đổi 84→0.
-- Chỗ so là so CHUỖI TUYỆT ĐỐI `a.phone <> $4`, nên '+84900001111' không bao giờ khớp
-- '0900001111' → điều kiện chặn im lặng vô hiệu. block_self_referral mặc định TRUE nên shop
-- tin là đang được bảo vệ; đây đúng là lỗ hổng đầu tiên mọi chương trình affiliate bị khai
-- thác (docs/51 quy tắc 5).
--
-- ĐẶT CÔNG THỨC CẠNH DỮ LIỆU, không chép sang JS lần thứ ba — cùng lối affiliate_commission_amount
-- (0131): "một công thức, một nơi". So bằng hàm còn có cái lợi thứ hai: nó chữa luôn các dòng
-- ĐANG LƯU SAI trong DB mà không cần migration dữ liệu.
--
-- IMMUTABLE + STRICT: không đọc bảng nào, NULL vào thì NULL ra → dùng được trong index sau này.
CREATE FUNCTION canon_phone(p text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE
           WHEN length(d) >= 8 THEN d
           ELSE NULL
         END
    FROM (
      SELECT CASE
               WHEN s LIKE '84%' AND length(s) > 9 THEN '0' || substring(s FROM 3)
               ELSE s
             END AS d
        FROM (SELECT regexp_replace(p, '\D', '', 'g') AS s) x
    ) y
$$;

-- checkout là nơi so khớp lúc ghi hoa hồng; app_rw để seller dùng lại về sau (màn CTV).
GRANT EXECUTE ON FUNCTION canon_phone(text) TO app_checkout, app_rw;
