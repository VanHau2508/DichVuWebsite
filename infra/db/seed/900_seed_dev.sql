-- Dữ liệu mẫu cho dev/staging. KHÔNG bao giờ chạy ở production.
-- Migration runner chạy file này SAU mọi migration. Phải IDEMPOTENT: runner có
-- thể chạy lại trên volume đã có dữ liệu (khác với docker-entrypoint-initdb.d
-- chỉ chạy một lần trên volume rỗng).

INSERT INTO shops (slug, name, status) VALUES
  ('shop-a', 'Thời trang A', 'active'),
  ('shop-b', 'Thời trang B', 'active'),
  ('shop-c', 'Thời trang C', 'terminated'),
  ('shop-d', 'Thời trang D', 'suspended'),
  ('shop-e', 'Thời trang E', 'active')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO domains (shop_id, hostname, verification_token, verified_at, is_primary)
SELECT s.id, d.hostname, d.token, d.verified_at, true
FROM shops s
JOIN (VALUES
  -- ✓ PHẢI được cấp cert: đã verify, shop hoạt động
  ('shop-a', 'shopa.test', 'tok-a', now()),

  -- ✗ PHẢI bị từ chối: chưa verify DNS. Đây là lá chắn chống chiếm domain.
  ('shop-b', 'shopb.test', 'tok-b', NULL),

  -- ✗ PHẢI bị từ chối: đã verify nhưng shop đã chấm dứt hợp đồng
  ('shop-c', 'shopc.test', 'tok-c', now()),

  -- ✓ PHẢI được cấp cert: shop bị khoá vẫn cần HTTPS để hiện trang thông báo.
  --   Khoá shop không xoá dữ liệu và không cắt SSL (cam kết hợp đồng).
  ('shop-d', 'shopd.test', 'tok-d', now()),

  -- ✓ Hợp lệ, nhưng CỐ Ý không đụng tới trong phần 1 của smoke test.
  --   Dành riêng cho bài test fail-closed: phải là domain chưa từng vào cache,
  --   nếu không "DB hồi phục → 200" sẽ pass giả nhờ cache dương 300s.
  ('shop-e', 'shope.test', 'tok-e', now())
) AS d(slug, hostname, token, verified_at) ON d.slug = s.slug
ON CONFLICT (hostname) DO NOTHING;
