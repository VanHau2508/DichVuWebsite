#!/usr/bin/env bash
#
# Smoke test cho Caddy on-demand TLS + endpoint `ask`.
#
#   docker compose -f infra/compose.dev.yml up -d --build
#   bash scripts/smoke-tls.sh
#
# Mục đích: chứng minh cơ chế TỪ CHỐI đúng chỗ, không chỉ chứng minh nó chạy.
# Một endpoint `ask` luôn trả 200 cũng làm mọi test "cấp cert thành công" pass.
#
# Mọi lời gọi curl chạy TRONG container Linux (`toolbox`), không dùng curl của
# host. curl trên Git Bash dùng backend schannel của Windows: nó bỏ qua --cacert
# và đòi kiểm tra revocation, nên handshake chết vì lý do chẳng liên quan gì tới
# Caddy — và các test phủ định sẽ "pass" vì lý do sai. Đó là loại test tệ nhất:
# xanh, và vô nghĩa.

set -uo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash sẽ biến /caddy-data thành C:/Program Files/Git/caddy-data

COMPOSE="docker compose -f infra/compose.dev.yml"
CA=/caddy-data/caddy/pki/authorities/local/root.crt # mount ro vào toolbox

# curl trả về 35 khi Caddy hủy handshake vì `ask` từ chối cấp chứng chỉ.
CURL_TLS_REFUSED=35

pass=0
fail=0
RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'

ok()   { pass=$((pass+1)); printf '  %sPASS%s %s\n' "$GREEN" "$RST" "$1"; }
bad()  { fail=$((fail+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"
         [ $# -gt 1 ] && printf '       %s%s%s\n' "$DIM" "$2" "$RST"; return 0; }
sect() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# curl qua Caddy từ trong network nội bộ.
# --connect-to giữ nguyên SNI = $host nhưng nối TCP tới container `caddy`.
curl_in() {
  local host="$1" path="${2:-/}"; shift 2 || shift
  $COMPOSE exec -T toolbox curl -sS --max-time 10 \
    --connect-to "${host}:443:caddy:443" \
    --cacert "$CA" \
    "$@" "https://${host}${path}"
}

# Chờ tls-authorize trả lời lại sau khi restart.
wait_authorize() {
  for _ in $(seq 30); do
    case "$(ask '')" in 403) return 0 ;; esac
    sleep 1
  done
  return 1
}

# Gọi thẳng tls-authorize, in ra HTTP status code.
# Truyền domain qua biến môi trường: '*.shopa.test' và chuỗi rỗng không sống sót
# qua quoting của shell, còn `busybox wget` nuốt header khi có cờ -q.
ask() {
  $COMPOSE exec -T -e ASK_DOMAIN="$1" tls-authorize node -e '
    const d = process.env.ASK_DOMAIN ?? "";
    const url = "http://127.0.0.1:3010/internal/tls/authorize?domain=" + encodeURIComponent(d);
    fetch(url).then(r => console.log(r.status)).catch(e => console.log("ERR:" + e.message));
  ' 2>/dev/null | tr -d '\r'
}

# ─────────────────────────────────────────────────────────────────────────────
sect "0. Chuẩn bị"

if ! $COMPOSE ps --status running --quiet caddy | grep -q .; then
  echo "Stack chưa chạy. Chạy trước: $COMPOSE up -d --build" >&2
  exit 1
fi

# Caddy chỉ sinh CA nội bộ khi lần đầu cần cấp chứng chỉ. Kích một handshake để
# ép nó tạo. Đây là lần DUY NHẤT dùng -k, và nó không assert gì cả.
$COMPOSE exec -T toolbox curl -sk --max-time 10 \
  --connect-to "shopa.test:443:caddy:443" "https://shopa.test/" >/dev/null 2>&1 || true

got_ca=0
for _ in $(seq 10); do
  if $COMPOSE exec -T toolbox test -r "$CA" >/dev/null 2>&1; then got_ca=1; break; fi
  sleep 1
done
[ "$got_ca" -eq 1 ] && ok "root CA nội bộ của Caddy đọc được từ toolbox" \
                    || { bad "không thấy root CA" "Xem: $COMPOSE logs caddy"; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
sect "1. Endpoint ask — logic cấp phép (không qua TLS)"

# shope.test CỐ Ý vắng mặt ở đây: nó dành riêng cho mục 5 và phải chưa vào cache.
declare -A cases=(
  [shopa.test]=200          # verified + shop active
  [shopb.test]=403          # CHƯA verify DNS → chống chiếm tên miền
  [shopc.test]=403          # verified nhưng shop terminated
  [shopd.test]=200          # shop suspended vẫn cần HTTPS cho trang thông báo
  [unknown.test]=403        # không có trong DB
  [SHOPA.TEST]=200          # chuẩn hoá chữ hoa
  [shopa.test.]=200         # chuẩn hoá dấu chấm cuối (FQDN)
  ['*.shopa.test']=403      # wildcard không bao giờ được cấp on-demand
  [1.2.3.4]=403             # máy quét cổng gõ thẳng IP
  [localhost]=403           # một nhãn, không hợp lệ
  [admin.nentang.vn]=403    # domain nền tảng: đã có site block riêng
  [nentang.vn]=403          # ─nt─
)
for domain in "${!cases[@]}"; do
  want="${cases[$domain]}"; got="$(ask "$domain")"
  [ "$got" = "$want" ] && ok "ask('$domain') → $got" \
                       || bad "ask('$domain') → $got, mong đợi $want"
done
got="$(ask '')"
[ "$got" = "403" ] && ok "ask('') → 403" || bad "ask('') → $got, mong đợi 403"

# ─────────────────────────────────────────────────────────────────────────────
sect "2. TLS on-demand — chứng chỉ có thật sự được cấp không"

# Khẳng định chứng chỉ hợp lệ theo CA nội bộ VÀ storefront resolve đúng shop.
# Storefront thật đặt header X-Shop-Slug = shop mà nó resolve từ Host → chứng minh
# Caddy chuyển đúng Host VÀ storefront ánh xạ domain→shop đúng.
assert_served() {
  local host="$1" why="$2" out slug
  if out="$(curl_in "$host" / 2>&1)"; then
    ok "$host: handshake thành công, chứng chỉ hợp lệ ($why)"
    slug="$(curl_in "$host" / -D - -o /dev/null 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1)=="x-shop-slug"{print $2}')"
    [ -n "$slug" ] \
      && ok "$host: storefront resolve domain→shop ($slug)" \
      || bad "$host: storefront không resolve được shop từ Host" "$out"
  else
    bad "$host: handshake thất bại, đáng lẽ phải được cấp cert ($why)" "$out"
  fi
}

# Khẳng định bị từ chối ĐÚNG NGUYÊN NHÂN: Caddy hủy handshake (curl 35),
# không phải một lỗi mạng/DNS/trust ngẫu nhiên nào khác.
assert_refused() {
  local host="$1" why="$2" out code
  out="$(curl_in "$host" / 2>&1)"; code=$?
  if [ "$code" -eq 0 ]; then
    bad "$host: ĐƯỢC CẤP CERT — đáng lẽ phải từ chối ($why)"
  elif [ "$code" -eq "$CURL_TLS_REFUSED" ]; then
    ok "$host: bị từ chối cấp cert ($why)"
  else
    bad "$host: thất bại nhưng SAI nguyên nhân (curl exit $code, mong đợi $CURL_TLS_REFUSED)" "$out"
  fi
}

assert_served  shopa.test "verified, shop active"
assert_served  shopd.test "shop suspended vẫn phải có HTTPS"
assert_refused shopb.test "chưa verify DNS"
assert_refused shopc.test "shop terminated"
assert_refused evil.test  "không có trong DB"

# ─────────────────────────────────────────────────────────────────────────────
sect "3. Header bảo mật và cache"

hdr="$(curl_in shopa.test / -D - -o /dev/null 2>/dev/null | tr -d '\r')"
for h in strict-transport-security x-content-type-options referrer-policy permissions-policy; do
  grep -qi "^$h:" <<<"$hdr" && ok "có header $h" || bad "thiếu header $h"
done
grep -qi '^server:' <<<"$hdr" && bad "header Server bị lộ" || ok "header Server đã bị gỡ"

# /cart /checkout → dịch vụ checkout (đặt Cache-Control: no-store). Không được cache.
for path in /cart /checkout; do
  cc="$(curl_in shopa.test "$path" -D - -o /dev/null 2>/dev/null \
        | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')"
  case "$cc" in
    *no-store*) ok "$path → Cache-Control chứa no-store ($cc)" ;;
    *) bad "$path → Cache-Control: '${cc:-<trống>}' (thiếu no-store)" ;;
  esac
done

# ─────────────────────────────────────────────────────────────────────────────
sect "4. HTTP → HTTPS"

code="$($COMPOSE exec -T toolbox curl -sS --max-time 10 \
        --connect-to "shopa.test:80:caddy:80" \
        -o /dev/null -w '%{http_code}' "http://shopa.test/" 2>/dev/null | tr -d '\r')"
[ "$code" = "308" ] && ok "HTTP trả 308 redirect" || bad "HTTP trả $code, mong đợi 308"

# ─────────────────────────────────────────────────────────────────────────────
sect "5. Fail-closed khi database chết"

# Dùng shope.test: hợp lệ trong DB nhưng CHƯA từng được hỏi trong lần chạy này.
# Nếu dùng shopa.test, cache dương 300s sẽ trả 200 mà không chạm database và
# cả hai khẳng định dưới đây đều pass giả.
#
# Cache sống trong process và tồn tại LÂU HƠN một lần chạy script. Chạy smoke
# test hai lần trong vòng 5 phút thì shope.test đã nằm sẵn trong cache. Restart
# service để xoá cache thật sự — không thêm endpoint "flush cache" chỉ để phục
# vụ test, vì đó là bề mặt tấn công mới trên endpoint public-facing nhất.
$COMPOSE stop postgres >/dev/null 2>&1
$COMPOSE restart tls-authorize >/dev/null 2>&1
wait_authorize || bad "tls-authorize không trả lời sau khi restart"
sleep 1

got="$(ask shope.test)"
[ "$got" = "403" ] && ok "DB chết → domain hợp lệ chưa cache bị từ chối (fail-closed)" \
                   || bad "DB chết → ask('shope.test') trả $got, mong đợi 403"

# Chứng chỉ đã cấp nằm trên đĩa; Caddy không hỏi lại `ask`.
# Đây là lý do fail-closed an toàn: sự cố DB không làm sập khách đang chạy.
curl_in shopa.test / >/dev/null 2>&1 \
  && ok "DB chết → khách đã có cert vẫn phục vụ bình thường" \
  || bad "DB chết → khách đã có cert bị gián đoạn"

$COMPOSE start postgres >/dev/null 2>&1
for _ in $(seq 30); do
  $COMPOSE exec -T postgres pg_isready -U app_owner -d app >/dev/null 2>&1 && break
  sleep 1
done

# Lỗi database KHÔNG được cache, nên lần hỏi này bắt buộc chạm DB.
# 200 ở đây chứng minh đã hồi phục thật.
got="$(ask shope.test)"
[ "$got" = "200" ] && ok "DB hồi phục → ask('shope.test') chạm DB, trả 200" \
                   || bad "DB hồi phục → ask('shope.test') trả $got, mong đợi 200"

# ─────────────────────────────────────────────────────────────────────────────
sect "6. Chống flood tra cứu database"

# Caddy ≥2.8 đã gỡ `interval`/`burst` khỏi on_demand_tls, nên nó hỏi `ask` ở
# MỌI handshake tới hostname chưa có chứng chỉ. Hostname ngẫu nhiên = cache-miss
# = một query Postgres. Token bucket (capacity 40, nạp 20/s) trong tls-authorize
# phải chặn được.
#
# Nạp CACHE cho một khách thật TRƯỚC khi flood: restart ở mục 5 đã xoá cache, và cert
# trên đĩa khiến Caddy không hỏi lại nên shopa.test đang KHÔNG nằm trong cache. Cache
# dương cho phép khẳng định cuối ("khách thật miễn nhiễm flood") TẤT ĐỊNH — cache hit
# bỏ qua token bucket nên luôn 200 dù bucket đã cạn.
ask shopa.test >/dev/null

# Phải bắn SONG SONG THẬT. Hai lần trước đã sai:
#   (1) global fetch (undici) gộp keep-alive → 120 request rải ra ≤20/s = đúng tốc độ nạp
#       lại → bucket không bao giờ cạn;
#   (2) http.get + agent:false vẫn để việc NỐI socket xen kẽ việc GỬI, nên trên runner
#       chậm 200 request trải dài ra và bucket kịp nạp — xanh máy nhanh, đỏ máy chậm
#       (chính là kiểu đỏ CI #92 trong khi máy dev 158 dòng rate_limited).
# Cách chắc chắn: NỐI XONG HẾT rồi mới GHI request lên tất cả socket trong một vòng lặp
# đồng bộ. Phần chậm (bắt tay TCP) xảy ra TRƯỚC, nên tốc độ máy không còn ảnh hưởng.
# 400 request với bucket 40 + nạp 20/s: kể cả server xử lý mất 10 giây vẫn còn ~160 bị bóp.
flood_out=$($COMPOSE exec -T tls-authorize node -e '
  const net = require("net");
  const N = 400;
  const socks = []; let connected = 0, closed = 0, fired = false;
  const finish = () => { if (!fired) { fired = true; console.log("done " + closed + "/" + N); process.exit(0); } };
  setTimeout(finish, 20000);                       // chặn treo vô hạn
  const armed = () => {
    // Ghi ĐỒNG LOẠT: vòng lặp đồng bộ, không await gì ở giữa.
    for (let i = 0; i < socks.length; i++) {
      try {
        socks[i].write("GET /internal/tls/authorize?domain=flood" + i + ".test HTTP/1.1\r\n" +
                       "Host: x\r\nConnection: close\r\n\r\n");
      } catch { closed++; }
    }
  };
  for (let i = 0; i < N; i++) {
    const s = net.connect({ host: "127.0.0.1", port: 3010 });
    s.setNoDelay(true);
    s.on("data", () => {});
    s.on("close", () => { if (++closed >= N) finish(); });
    s.on("error", () => { if (++connected === N) armed(); });
    s.on("connect", () => { if (++connected === N) armed(); });
    socks.push(s);
  }
' 2>&1)
# KHÔNG nuốt output nữa: trước đây `>/dev/null 2>&1` giấu cả lỗi exec, nên khi lệnh flood
# chết hẳn thì báo cáo vẫn ghi "không có rate_limited" và người đọc đi mò nhầm token bucket.
case "$flood_out" in
  *done*) : ;;
  *) bad "không bắn được flood (lệnh exec lỗi)" "$(printf '%s' "$flood_out" | head -3)" ;;
esac

# `docker logs` có độ trễ flush; grep một-phát dễ hụt dòng vừa in (nguồn flaky thứ hai).
# Chờ tối đa 10s (20×0.5s), qua NGAY khi thấy dòng rate_limited đầu tiên.
found=0
for _ in $(seq 20); do
  if $COMPOSE logs --since 60s tls-authorize 2>&1 | grep -q '"source":"rate_limited"'; then
    found=1; break
  fi
  sleep 0.5
done
[ "$found" -eq 1 ] \
  && ok "flood 400 hostname lạ → token bucket chặn trước khi chạm database" \
  || bad "flood 400 hostname lạ → KHÔNG có log rate_limited; mọi request đều query Postgres"

# Khách thật ĐÃ trong cache: cache hit bỏ qua token bucket → không bị vạ lây dù bucket cạn.
got="$(ask shopa.test)"
[ "$got" = "200" ] && ok "trong lúc flood, khách đã cache vẫn được phục vụ" \
                   || bad "khách đã cache bị vạ lây, trả $got"

# ─────────────────────────────────────────────────────────────────────────────
printf '\n\033[1m%d pass, %d fail\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
