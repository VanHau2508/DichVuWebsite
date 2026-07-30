#!/usr/bin/env bash
#
# Mở shop dev trên ĐIỆN THOẠI THẬT khi chưa deploy gì cả.
#   bash scripts/dev-lan-host.sh                     # tự dò IP LAN, đổi 4 shop demo
#   bash scripts/dev-lan-host.sh 192.168.2.38        # chỉ định IP
#   bash scripts/dev-lan-host.sh --revert            # trả miền chính về *.nentang.vn
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

SHOPS="'demo-fashion','demo-food','demo-furniture','demo-cosmetics'"
PSQL=(docker compose -f infra/compose.dev.yml exec -T postgres psql -U app_owner -d app -v ON_ERROR_STOP=1 -qtA)

if [ "${1:-}" = "--revert" ]; then
  "${PSQL[@]}" <<SQL
UPDATE domains d SET is_primary = (d.hostname LIKE '%.nentang.vn')
FROM shops s WHERE s.id = d.shop_id AND s.slug IN ($SHOPS);
DELETE FROM domains WHERE hostname LIKE '%.nip.io';
SQL
  echo "Đã trả miền chính về *.nentang.vn và xoá alias nip.io."
  exit 0
fi

IP="${1:-}"
if [ -z "$IP" ]; then
  # Địa chỉ IPv4 riêng đầu tiên không phải loopback/APIPA/vEthernet của Docker-WSL.
  IP=$(powershell.exe -NoProfile -Command \
    "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { \$_.InterfaceAlias -notlike '*WSL*' -and \$_.IPAddress -notlike '127.*' -and \$_.IPAddress -notlike '169.254.*' } | Select-Object -First 1 -ExpandProperty IPAddress)" \
    | tr -d '\r\n ')
fi
[ -n "$IP" ] || { echo "Không dò được IP LAN. Truyền tay: bash scripts/dev-lan-host.sh 192.168.x.y" >&2; exit 1; }

DASH="${IP//./-}"
echo "IP LAN: $IP"

"${PSQL[@]}" <<SQL
DELETE FROM domains WHERE hostname LIKE '%.nip.io';
INSERT INTO domains (shop_id, hostname, verification_token, verified_at, is_primary)
SELECT s.id, s.slug || '.$DASH.nip.io', 'dev-lan-alias', now(), true
FROM shops s WHERE s.slug IN ($SHOPS);
UPDATE domains d SET is_primary = (d.hostname LIKE '%.nip.io')
FROM shops s WHERE s.id = d.shop_id AND s.slug IN ($SHOPS);
SQL

echo
echo "Mở trên điện thoại (cùng Wi-Fi) — bấm qua cảnh báo chứng chỉ, CA nội bộ của Caddy:"
for slug in demo-fashion demo-food demo-furniture demo-cosmetics; do
  url="https://$slug.$DASH.nip.io:8443/"
  # -o NUL chứ không /dev/null: MSYS_NO_PATHCONV=1 chặn dịch đường dẫn nên curl
  # (bản Windows) coi /dev/null là tệp thật và fail ghi → exit 23 dù HTTP 200.
  code=$(curl -ks -o NUL -w '%{http_code}' "$url" --max-time 25 || echo ' ERR')
  printf '  %-6s %s\n' "$code" "$url"
done
