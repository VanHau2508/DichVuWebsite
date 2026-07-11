# Image Caddy cho PRODUCTION.
#
# Image chính thức `caddy:2-alpine` KHÔNG chứa module DNS provider nào.
# Caddyfile production có block `*.nentang.vn` cần chứng chỉ wildcard, mà
# Let's Encrypt chỉ cấp wildcard qua thử thách DNS-01 → bắt buộc plugin
# caddy-dns/cloudflare. Thiếu nó, Caddy báo lỗi lúc adapt config và không khởi động.
#
# Dev không cần image này (dùng CA nội bộ, không có wildcard).

FROM caddy:2-builder-alpine AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# Kiểm chứng plugin có mặt ngay lúc build — thà fail ở CI còn hơn fail lúc deploy.
RUN caddy list-modules | grep -q '^dns.providers.cloudflare$'
