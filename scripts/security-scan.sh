#!/usr/bin/env bash
#
# Quét bảo mật tĩnh (Ngày 18): dependency scan + secret/PII/pattern scan.
#   bash scripts/security-scan.sh
#
# Chạy trong CI ở mọi commit. Fail (exit 1) nếu có phát hiện nghiêm trọng.

set -uo pipefail
export PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

RED=$'\033[31m'; GREEN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
issues=0
ok()   { printf '  %sOK%s   %s\n' "$GREEN" "$RST" "$1"; }
warn() { printf '  %sWARN%s %s\n' "$YEL" "$RST" "$1"; }
flag() { issues=$((issues+1)); printf '  %sFLAG%s %s\n' "$RED" "$RST" "$1"; }
sect() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# npm đã đổi văn phong output nhiều lần; chỉ metadata JSON mới là hợp đồng máy đọc được.
# Mode classify dùng đúng hàm production để unit test được cả high và fail-closed mà không
# cần mạng. Mode audit-package là probe hẹp cho một package thật khi review dependency scan.
audit_json_summary() {
  node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const report = JSON.parse(input);
    const counts = report?.metadata?.vulnerabilities;
    const keys = ["low", "moderate", "high", "critical"];
    if (!counts || keys.some((key) => !Number.isInteger(counts[key]) || counts[key] < 0)) throw new Error("bad counts");
    const severe = Object.entries(report.vulnerabilities ?? {})
      .filter(([, item]) => item?.severity === "high" || item?.severity === "critical")
      .map(([name, item]) => `${name}:${item.severity}`);
    process.stdout.write([counts.low, counts.moderate, counts.high, counts.critical, severe.join(",") || "-"].join("\t"));
  } catch {
    process.exitCode = 2;
  }
});'
}

classify_dependency_audit() {
  local dir="$1" audit_rc="$2" out="$3" summary parse_rc low moderate high critical severe
  summary="$(printf '%s' "$out" | audit_json_summary 2>/dev/null)"
  parse_rc=$?
  if [ "$parse_rc" -ne 0 ] || [ -z "$summary" ]; then
    flag "$dir — dependency scan KHÔNG CHẠY ĐƯỢC; không được coi output rỗng/lỗi Docker/JSON hỏng là sạch"
    printf '%s\n' "$out" | head -4 | sed 's/^/       /'
    return
  fi
  IFS=$'\t' read -r low moderate high critical severe <<<"$summary"
  if [ "$high" -gt 0 ] || [ "$critical" -gt 0 ]; then
    flag "$dir — CÓ lỗ hổng high/critical: $high high, $critical critical"
    printf '%s\n' "$severe" | tr ',' '\n' | sed 's/^/       /'
  elif [ "$audit_rc" -ne 0 ]; then
    flag "$dir — dependency scan KHÔNG CHẠY ĐƯỢC; JSON hợp lệ nhưng npm audit trả mã $audit_rc"
  else
    ok "$dir — 0 high, 0 critical · $moderate moderate · $low low"
  fi
}

scan_dependency_package() {
  local dir="$1" out audit_rc
  if [ ! -f "$dir/package.json" ]; then
    flag "$dir — dependency scan KHÔNG CHẠY ĐƯỢC; không tìm thấy package.json"
    return
  fi
  local docker_args=()
  if [ -n "${SECURITY_SCAN_DOCKER_ARGS:-}" ]; then read -r -a docker_args <<<"$SECURITY_SCAN_DOCKER_ARGS"; fi
  out="$(docker run --rm "${docker_args[@]}" -v "$PWD/$dir:/s:ro" -w /tmp node:22-alpine sh -c \
    "cp /s/package.json . && npm install --package-lock-only --silent >/dev/null 2>&1 && npm audit --omit=dev --audit-level=high --json" 2>&1)"
  audit_rc=$?
  classify_dependency_audit "$dir" "$audit_rc" "$out"
}

case "${1:-}" in
  --classify-audit-json)
    classify_dependency_audit "${2:-fixture}" "${3:-0}" "$(cat)"
    [ "$issues" -eq 0 ] || exit 1
    exit 0
    ;;
  --audit-package)
    [ -n "${2:-}" ] || { printf 'thiếu thư mục package\n' >&2; exit 2; }
    scan_dependency_package "$2"
    [ "$issues" -eq 0 ] || exit 1
    exit 0
    ;;
esac

# ── 0. Chốt layout: "không quét được ≠ sạch" ─────────────────────────────────
# Mọi scan dưới glob cứng apps/*/src packages/*/src infra/ với `2>/dev/null || true`
# rồi test rỗng. Nếu cây src bị ĐỔI TÊN / DI CHUYỂN, glob khớp 0 file → grep im lặng
# → mọi mục báo "sạch" GIẢ. Chốt trước: phải thấy đủ cây src mong đợi mới quét.
na=$(ls -d apps/*/src 2>/dev/null | wc -l)
np=$(ls -d packages/*/src 2>/dev/null | wc -l)
if [ "$na" -lt 8 ] || [ "$np" -lt 1 ] || [ ! -d infra ]; then
  printf '%sFATAL%s layout src đổi? thấy %d apps/*/src, %d packages/*/src, infra=%s — KHÔNG quét được ≠ SẠCH\n' \
    "$RED" "$RST" "$na" "$np" "$([ -d infra ] && echo yes || echo NO)"
  exit 1
fi

# ── 1. Dependency scan (npm audit, mức high+) ────────────────────────────────
sect "1. Dependency scan (npm audit --audit-level=high)"
for pkg in apps/*/package.json packages/*/package.json; do
  scan_dependency_package "$(dirname "$pkg")"
done

# ── 2. Secret scan (hardcode) ────────────────────────────────────────────────
sect "2. Secret scan (hardcode ngoài dev/env)"
# Bỏ qua: devpassword (dev), process.env, tên cột (password_hash/secret_enc/token_hash),
# tham số crypto, biến thể "passphrase" trong test.
sec="$(grep -rniE "(secret|api.?key|passwd|password)\s*[:=]\s*['\"][^'\"]{6,}" \
  apps/*/src packages/*/src infra/ 2>/dev/null \
  | grep -viE 'process\.env|devpassword|password_hash|secret_enc|token_hash|MFA_ENC|lookup_token|reset|WEBHOOK_KEY|_KEY:|secretbox|argon2|minioadmin' || true)"
if [ -z "$sec" ]; then ok "không thấy secret hardcode trong src"; else flag "nghi secret hardcode:"; echo "$sec" | head -6 | sed 's/^/       /'; fi

# ── 3. Log rò PII/secret ─────────────────────────────────────────────────────
sect "3. Log rò PII/token/secret"
# Chỉ soi PAYLOAD (đối số thứ 3 sau level+event) — bỏ qua tên event (đối số 2)
# có thể chứa 'token'/'password' trong tên mà không log giá trị nào.
leak="$(grep -rnE "log\([^,]+,[^,]+,[^)]*(password|token|\.phone|\.email|customer_|secret|req\.body|payload\.to)" \
  apps/*/src 2>/dev/null | grep -viE 'order_number|topic|message:|hashToken|token_hash|\.length' || true)"
if [ -z "$leak" ]; then ok "log không chứa PII/token trực tiếp"; else flag "log có thể rò:"; echo "$leak" | head -8 | sed 's/^/       /'; fi

# ── 4. Pattern nguy hiểm ─────────────────────────────────────────────────────
sect "4. Pattern nguy hiểm (eval/exec/SQL nối chuỗi)"
# Chỉ JS eval() thật (không .exec regex, không redis.eval Lua), child_process, new Function.
danger="$(grep -rnE "(^|[^.a-zA-Z])eval\(|child_process|new Function\(" apps/*/src packages/*/src 2>/dev/null \
  | grep -viE 'redis\.eval|\.exec\(' || true)"
[ -z "$danger" ] && ok "không có eval/exec/child_process nguy hiểm" || { flag "pattern nguy hiểm:"; echo "$danger" | head | sed 's/^/       /'; }
# SQL nội suy biến trực tiếp (không phải LIMIT/OFFSET số đã ép kiểu)
sqli="$(grep -rnE "query\(\s*\`[^)]*\\\$\{(?!limit|offset|whereSql)[a-zA-Z]" apps/*/src 2>/dev/null || true)"
[ -z "$sqli" ] && ok "không thấy SQL nội suy biến đáng ngờ" || warn "kiểm tay SQL nội suy: $(echo "$sqli" | wc -l) dòng"

# ── 5. Secret file bị track ──────────────────────────────────────────────────
sect "5. File secret / .env"
found="$(find . -name '.env' -not -path './node_modules/*' 2>/dev/null | grep -v '.env.example' || true)"
[ -z "$found" ] && ok "không có file .env lộ" || flag ".env lộ: $found"

# ── 6. CSP nonce của seller-admin (ADR-011) ─────────────────────────────────
# Vì sao canh ở ĐÂY chứ không phải e2e: cả hai lỗi dưới đây chỉ giết production, còn dev
# thì chạy hoàn hảo (Caddyfile.dev không đặt CSP). Không bộ e2e nào bắt được — chúng chạy
# trên stack dev. Đây là loại lỗi phải chặn bằng đọc-file, ở bước rẻ nhất, chạy mọi push.
sect "6. CSP nonce seller-admin (ADR-011)"

# (a) Edge KHÔNG được đặt lại CSP tĩnh cho admin. Chuỗi tĩnh không thể chứa nonce đổi theo
# response ⇒ thiếu script-src thì rơi về default-src 'none' ⇒ CHẶN SẠCH JS admin ở prod.
admin_block="$(awk '/^admin\.nentang\.vn \{/,/^\}/' infra/caddy/Caddyfile 2>/dev/null || true)"
if [ -z "$admin_block" ]; then
  warn "không tìm thấy block admin.nentang.vn trong Caddyfile — kiểm tay"
elif printf '%s' "$admin_block" | grep -qi 'Content-Security-Policy'; then
  flag "Caddyfile đặt CSP TĨNH cho admin.nentang.vn — sẽ chặn sạch JS admin ở PROD (dev không báo). ADR-011: app là nguồn DUY NHẤT."
else
  ok "edge không đặt CSP tĩnh cho admin (app là nguồn duy nhất)"
fi

# (b) script-src của app CHỈ được chứa nonce (ADR-011 #2). 'unsafe-inline' làm trình duyệt
# BỎ QUA nonce hoàn toàn → mất sạch lớp bảo vệ mà nhìn vào vẫn tưởng còn.
# Lọc DÒNG CHÚ THÍCH trước khi soi: comment giải thích quy tắc đương nhiên chứa đúng những
# từ bị cấm ("không 'unsafe-inline'"), grep thô sẽ báo oan — mà guard báo oan là guard sẽ bị
# tắt. Chỉ xét dòng code thật.
csp_src="$(grep -n "script-src" apps/seller-admin/src/http.js 2>/dev/null | grep -vE '^[0-9]+:[[:space:]]*(//|\*|/\*)' || true)"
if [ -z "$csp_src" ]; then
  ok "seller-admin chưa mở script-src (CSP vẫn khoá cứng)"
elif printf '%s' "$csp_src" | grep -qE "unsafe-inline|unsafe-eval|strict-dynamic|https?://"; then
  flag "script-src của seller-admin có giá trị NGOÀI nonce — vi phạm ADR-011 #2:"
  printf '%s\n' "$csp_src" | sed 's/^/       /'
else
  ok "script-src seller-admin chỉ chứa nonce"
fi

# (c) Đường tiền là ranh giới CỨNG: storefront/checkout/account/signup không được mở JS
# ngoài hai ngoại lệ nonce đã có từ trước (badge giỏ, GPS checkout).
money="$(grep -rn "unsafe-inline" apps/storefront/src/http.js apps/checkout/src/http.js \
        apps/account/src/http.js apps/signup/src/http.js 2>/dev/null | grep "script-src" || true)"
[ -z "$money" ] && ok "storefront/checkout/account/signup: script-src không có unsafe-inline" \
  || { flag "unsafe-inline lọt vào script-src của đường tiền — ADR-011 cấm tuyệt đối:"; printf '%s\n' "$money" | sed 's/^/       /'; }

# ── 7. CSS mới ở thanh NỔI: phải có dự phòng màu đặc ─────────────────────────
# Vì sao canh ở ĐÂY: giống mục 6, đây là lỗi chỉ giết TRÌNH DUYỆT CŨ của khách, còn máy dev
# và mọi bộ e2e (đều chạy Chrome mới) thì xanh hoàn hảo — không test hành vi nào bắt được.
#
# color-mix() chỉ có từ Chrome 111 / Safari 16.2 / Firefox 113 (mới hơn cả :has()). Trình
# duyệt cũ BỎ khai báo không hiểu — đúng chuẩn CSS, im lặng. Với thanh position:sticky|fixed
# nổi trên nội dung thì mất nền = nội dung cuộn xuyên qua, chữ chồng chữ; riêng .topbar còn
# color:#fff nên thành chữ TRẮNG TRÊN NỀN TRẮNG. ĐÃ ĐO: bỏ color-mix ⇒ cả 3 thanh về
# rgba(0,0,0,0), có dự phòng ⇒ nền đặc, đọc được.
#
# Quy tắc: trong luật CSS có position:sticky|fixed, mọi background:color-mix(...) PHẢI có một
# khai báo background màu-đặc đứng NGAY TRƯỚC. Cascade lo phần còn lại.
sect "7. Dự phòng CSS cho trình duyệt cũ (color-mix ở thanh nổi)"
css_bad=0
for f in apps/storefront/src/theme.js apps/checkout/src/pages.js apps/seller-admin/src/pages.js; do
  [ -f "$f" ] || { warn "không thấy $f — bỏ qua"; continue; }
  miss="$(tr '}' '\n' < "$f" \
    | grep -E 'position:(sticky|fixed)' \
    | grep -E 'background:color-mix\(' \
    | grep -vE 'background:(var\([^)]*\)|#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|transparent);background:color-mix\(' || true)"
  if [ -n "$miss" ]; then
    css_bad=1
    flag "$f: thanh sticky/fixed dùng background:color-mix() mà KHÔNG có dự phòng màu đặc đứng trước:"
    printf '%s\n' "$miss" | cut -c1-110 | sed 's/^/       /'
  fi
done
[ "$css_bad" -eq 0 ] && ok "mọi thanh sticky/fixed có dự phòng màu đặc trước color-mix()"

printf '\n\033[1m%d phát hiện cần xử lý\033[0m\n' "$issues"
[ "$issues" -eq 0 ] || exit 1
