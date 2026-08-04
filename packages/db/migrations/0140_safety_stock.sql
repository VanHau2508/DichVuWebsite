-- 0140 — TỒN AN TOÀN (safety stock) v0.
--
-- VẤN ĐỀ NÓ GIẢI. Con số tồn trong hệ luôn TRÔI khỏi kho thật: shop bán thêm ở cửa hàng, ở
-- sàn khác, ở Facebook; hàng vỡ, hàng thất lạc, đếm sai lúc nhập. Khi trôi, khách đặt được
-- món mà kho không còn — shop phải gọi xin lỗi, huỷ đơn, mất uy tín. Đây là câu hỏi đầu tiên
-- mọi người bán hỏi khi nghe "bán trên web của chính mình": *"lỡ hết hàng thì sao?"*
--
-- CÁCH GIẢI: chừa một phần tồn KHÔNG bán online. Kho còn 100, chừa 20 thì web chỉ bán 80 —
-- 20 cái cuối là vùng đệm hấp thụ sai số.
--
-- VÌ SAO KHÔNG PHẢI "CHIA KHO THEO KÊNH" (đã cân nhắc và bỏ ở v0). Chia kho tạo ra một *hồ
-- riêng* cho web; hồ đó cạn trong khi kho vẫn còn → web báo hết hàng oan, tự tay chặn doanh
-- thu của shop. Muốn tránh phải biết sàn bán được bao nhiêu, tức phải có API sàn. Tồn an toàn
-- KHÔNG có hồ riêng — nó chỉ là một mức sàn trên chính con số tồn — nên lớp lỗi "hết hàng ảo"
-- KHÔNG TỒN TẠI. Cùng một câu trả lời cho người bán, rẻ hơn nhiều, rủi ro gần bằng không.
-- Mô hình chia-kênh để dành cho v1 khi đã có API đồng bộ.

-- Mức mặc định TOÀN SHOP, theo TỈ LỆ chứ không phải số tuyệt đối: tỉ lệ tự co giãn khi nhập
-- thêm hàng, số tuyệt đối thì đứng yên và mục nát. Shop bấm một lần là áp cho cả nghìn SKU.
--
-- Trần 90 chứ không phải 100: 100% nghĩa là không bao giờ bán được gì — một cái bẫy chân
-- không ai cố ý muốn. Chạm 90 đã đủ để người gõ nhận ra mình đang làm chuyện bất thường.
ALTER TABLE shops ADD COLUMN safety_stock_pct int NOT NULL DEFAULT 0
  CHECK (safety_stock_pct BETWEEN 0 AND 90);

-- GHI ĐÈ theo từng biến thể, bằng SỐ TUYỆT ĐỐI. Hai đơn vị khác nhau là CỐ Ý: mức chung của
-- shop hợp lý theo tỉ lệ, còn ngoại lệ thì người bán nghĩ bằng số cái ("món này luôn chừa 2").
-- NULL = không có ngoại lệ, dùng tỉ lệ của shop.
ALTER TABLE inventory_levels ADD COLUMN safety_stock_qty int
  CHECK (safety_stock_qty IS NULL OR safety_stock_qty >= 0);

-- ĐO CÁI GIÁ CỦA TÍNH NĂNG. Mỗi lần khách định mua mà bị vùng đệm chặn TRONG KHI kho vẫn còn
-- hàng thật, đếm một phát vào đây. Không có con số này thì không ai biết vùng đệm đang bảo vệ
-- shop hay đang ăn doanh thu của họ — và một tháng "nghe khách phản hồi" sẽ chỉ ra giai thoại.
-- Đặt ngay trên inventory_levels để trả lời được câu hữu ích nhất: SKU NÀO đang bị chặn nhiều.
--
-- GIỚI HẠN ĐÃ BIẾT của v0: chỉ đếm ở bước ĐẶT HÀNG. Khách thấy trang báo "hết hàng" rồi bỏ đi
-- thì không đếm được (storefront không có quyền ghi, và cũng không nên có). Con số này vì vậy
-- là SÀN DƯỚI của thiệt hại thật, không phải con số đầy đủ.
ALTER TABLE inventory_levels ADD COLUMN safety_blocked_count int NOT NULL DEFAULT 0
  CHECK (safety_blocked_count >= 0);

-- KHÔNG CẤP QUYỀN MỚI — đã kiểm information_schema trước khi viết (bài học 0139: vai app_expiry
-- có UPDATE(provider_status) mà thiếu SELECT, nên truy vấn mới im lặng rơi vào catch):
--   · shops             — app_store / app_checkout / app_rw đều có SELECT MỨC BẢNG
--   · inventory_levels  — app_store SELECT, app_checkout SELECT+UPDATE, app_rw CRUD, mức BẢNG
-- Grant mức bảng phủ cột mới ngay lập tức.
--
-- app_expiry thì cấp theo CỘT (on_hand, reserved, shop_id, variant_id / UPDATE reserved,
-- updated_at) nên KHÔNG thấy ba cột này — ĐÚNG như mong muốn: vòng quét chỉ nhả giữ chỗ của
-- đơn hết hạn, nó không cần biết vùng đệm là bao nhiêu.

-- KHÔNG thêm CHECK kiểu `reserved <= on_hand - safety`. Ràng buộc đó SAI về ngữ nghĩa: vùng
-- đệm chỉ chặn giữ chỗ MỚI, nó không được cấm nhả chỗ hay xuất hàng đã giữ từ trước. Shop đặt
-- đệm lúc đang có nhiều đơn chờ sẽ khiến mọi UPDATE trên dòng đó vỡ — kể cả lệnh huỷ đơn.
-- Ràng buộc chống oversell THẬT (`reserved <= on_hand`, 0009) vẫn nguyên vẹn là lớp cuối cùng;
-- vùng đệm là lớp chặn nằm TRÊN nó, cưỡng chế trong chính transaction đặt đơn.
