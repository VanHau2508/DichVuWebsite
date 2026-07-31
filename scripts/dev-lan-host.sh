#!/usr/bin/env bash
#
# Mở shop dev trên ĐIỆN THOẠI THẬT khi chưa deploy gì cả.
#   bash scripts/dev-lan-host.sh                     # tự dò IP LAN, đổi các shop mặc định
#   bash scripts/dev-lan-host.sh 192.168.2.38        # chỉ định IP
#   bash scripts/dev-lan-host.sh auto shop-a shop-b  # chỉ định thêm shop (auto = tự dò IP)
#   bash scripts/dev-lan-host.sh --check             # IP hiện tại có khớp hostname không
#   bash scripts/dev-lan-host.sh --revert            # trả miền chính về *.nentang.vn
#
# DB dev có hơn 5000 shop rác từ test nên KHÔNG quét cả bảng — chỉ đúng danh sách.
#
# Cơ chế: storefront nhận diện shop CHỈ bằng Host header đối chiếu bảng `domains`
# (verified_at IS NOT NULL), Caddy dev có site block bắt-tất-cả với on-demand TLS
# hỏi tls-authorize — cũng tra đúng bảng đó. Nên chỉ cần một hostname phân giải về
# máy này là đủ; nip.io là DNS ký sinh: <bất-kỳ>.192-168-2-38.nip.io → 192.168.2.38.
#
# Vì sao phải đổi cả is_primary: server.js quy tắc A5 — host phụ 301 về miền chính
# và redirect KHÔNG mang theo port :8443 → điện thoại rơi vào ngõ cụt. Hostname LAN
# phải LÀ miền chính thì mới phục vụ trực tiếp.

set -euo pipefail
export PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

DEFAULT_SLUGS=(demo-fashion demo-food demo-furniture demo-cosmetics nha-xinh-1nh1va)
PSQL=(docker compose -f infra/compose.dev.yml exec -T postgres psql -U app_owner -d app -v ON_ERROR_STOP=1 -qtA)

# IPv4 riêng đầu tiên, bỏ loopback/APIPA/vEthernet của Docker-WSL.
detect_ip() {
  powershell.exe -NoProfile -Command \
    "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { \$_.InterfaceAlias -notlike '*WSL*' -and \$_.IPAddress -notlike '127.*' -and \$_.IPAddress -notlike '169.254.*' } | Select-Object -First 1 -ExpandProperty IPAddress)" \
    | tr -d '\r\n '
}

# --check: IP Wi-Fi đổi theo DHCP là chuyện thường (3 lần trong một ngày, đã đo).
# Khi đổi thì MỌI link nip.io chết theo kiểu `000` — trông y hệt Caddy/storefront
# hỏng, và đã tốn một vòng chẩn đoán dù bẫy này do chính tôi ghi ra. Để máy nhắc.
if [ "${1:-}" = "--check" ]; then
  cur=$(detect_ip); [ -n "$cur" ] || exit 0
  have=$("${PSQL[@]}" -c \
    "SELECT DISTINCT split_part(hostname, '.', 2) FROM domains WHERE hostname LIKE '%.nip.io'" 2>/dev/null | tr -d '\r')
  [ -n "$have" ] || exit 0                       # chưa gắn hostname LAN nào → không có gì để lệch
  if printf '%s\n' "$have" | grep -qx "${cur//./-}"; then exit 0; fi
  echo "IP LAN đổi: hostname đang trỏ $(printf '%s' "$have" | tr '\n' ',' | tr -- '-' '.') — máy giờ là $cur"
  echo "→ link nip.io sẽ chết (curl trả 000). Gắn lại:  bash scripts/dev-lan-host.sh"
  exit 1
fi

if [ "${1:-}" = "--revert" ]; then
  # Lấy lại danh sách từ chính các alias đang tồn tại → revert đúng cả shop
  # được truyền thêm ở lần chạy trước, không cần nhớ lại đã truyền những gì.
  "${PSQL[@]}" <<'SQL'
UPDATE domains d SET is_primary = (d.hostname LIKE '%.nentang.vn')
FROM shops s WHERE s.id = d.shop_id
  AND s.id IN (SELECT shop_id FROM domains WHERE hostname LIKE '%.nip.io');
DELETE FROM domains WHERE hostname LIKE '%.nip.io';
SQL
  echo "Đã trả miền chính về *.nentang.vn và xoá alias nip.io."
  exit 0
fi

IP="${1:-}"
[ "$IP" = "auto" ] && IP=""
shift || true
SLUGS=("${DEFAULT_SLUGS[@]}" "$@")
# Danh sách slug → chuỗi 'a','b' cho mệnh đề IN. Slug chỉ gồm [a-z0-9-] nên nối
# thẳng là an toàn; chặn sớm nếu ai đó truyền ký tự lạ.
LIST=""
for s in "${SLUGS[@]}"; do
  [[ "$s" =~ ^[a-z0-9-]+$ ]] || { echo "slug không hợp lệ: $s" >&2; exit 1; }
  LIST="$LIST${LIST:+,}'$s'"
done

[ -n "$IP" ] || IP=$(detect_ip)
[ -n "$IP" ] || { echo "Không dò được IP LAN. Truyền tay: bash scripts/dev-lan-host.sh 192.168.x.y" >&2; exit 1; }

DASH="${IP//./-}"
echo "IP LAN: $IP"

"${PSQL[@]}" <<SQL
DELETE FROM domains WHERE hostname LIKE '%.nip.io';
INSERT INTO domains (shop_id, hostname, verification_token, verified_at, is_primary)
SELECT s.id, s.slug || '.$DASH.nip.io', 'dev-lan-alias', now(), true
FROM shops s WHERE s.slug IN ($LIST);
UPDATE domains d SET is_primary = (d.hostname LIKE '%.nip.io')
FROM shops s WHERE s.id = d.shop_id AND s.slug IN ($LIST);
SQL

echo
echo "Mở trên điện thoại (cùng Wi-Fi) — bấm qua cảnh báo chứng chỉ, CA nội bộ của Caddy:"
for slug in "${SLUGS[@]}"; do
  url="https://$slug.$DASH.nip.io:8443/"
  # -o NUL chứ không /dev/null: MSYS_NO_PATHCONV=1 chặn dịch đường dẫn nên curl
  # (bản Windows) coi /dev/null là tệp thật và fail ghi → exit 23 dù HTTP 200.
  code=$(curl -ks -o NUL -w '%{http_code}' "$url" --max-time 25 || echo ' ERR')
  printf '  %-6s %s\n' "$code" "$url"
done
