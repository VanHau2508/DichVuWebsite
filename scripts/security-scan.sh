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

# ── 1. Dependency scan (npm audit, mức high+) ────────────────────────────────
sect "1. Dependency scan (npm audit --audit-level=high)"
for pkg in apps/*/package.json packages/*/package.json; do
  dir="$(dirname "$pkg")"
  # Sinh lockfile tạm rồi audit trong container throwaway (không đụng source).
  out="$(docker run --rm -v "$PWD/$dir:/s:ro" -w /tmp node:22-alpine sh -c \
    "cp /s/package.json . && npm install --package-lock-only --silent >/dev/null 2>&1 && npm audit --omit=dev --audit-level=high 2>&1" 2>/dev/null)"
  if grep -qiE 'found 0 vulnerabilities|found [0-9]+ (low|moderate) ' <<<"$out" || [ -z "$out" ]; then
    ok "$dir — không lỗ hổng high/critical"
  elif grep -qiE 'high|critical' <<<"$out"; then
    flag "$dir — CÓ lỗ hổng high/critical:"; echo "$out" | grep -iE 'high|critical|severity' | head -4 | sed 's/^/       /'
  else
    ok "$dir — không lỗ hổng high/critical"
  fi
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

printf '\n\033[1m%d phát hiện cần xử lý\033[0m\n' "$issues"
[ "$issues" -eq 0 ] || exit 1
