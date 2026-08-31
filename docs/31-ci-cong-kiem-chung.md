# CI đóng đủ cổng — "kiểm chứng bằng chạy thật" thành gate tự động (A7)

> **Kiểm chứng được:** `.github/workflows/ci.yml` (3 job: unit / e2e / mutation). Mọi
> `verify-*.sh` (19) + `smoke-*.sh` (edge/readiness/tls) + `security-scan.sh` đã vào CI.
> Guard "rỗng = xanh giả" ở CẢ BA job. Các fix guard được kiểm bằng chạy thử pass+fail path.

Con số `19` ở phần lịch sử A7 là số tại thời điểm tài liệu được viết. Hiện manifest mutation có
`22` script; `verify-onboarding-readiness.sh` bổ sung ba chốt cho readiness connector và retry
email onboarding, còn các script cũ không bị đổi.

## 1. Vấn đề A7 giải

Trước A7, triết lý "kiểm chứng bằng chạy thật" (mutation testing + smoke) đã có dưới dạng
**script rời** nhưng CHƯA nối đủ vào CI, và những chỗ đã nối lại tự có lỗ **"rỗng = xanh giả"**
(glob khớp 0 file → lặp 0 lần → báo xanh dù không kiểm gì). A7 (a) nối hết vào Actions và
(b) làm cứng chính các guard đó.

## 2. Ba job

| Job | Chạy khi | Nội dung |
|-----|----------|----------|
| **unit** | mọi push/PR | node:test thuần (7 file) + `security-scan.sh` |
| **e2e** | mọi push/PR | dựng stack Docker → mọi e2e suite + bất biến → `smoke-edge/readiness/tls.sh` |
| **mutation** | nightly + tay | glob mọi `verify-*.sh` (19) — gỡ từng lớp phòng thủ, e2e phải chuyển đỏ |

Job mutation RẤT chậm (restart service nhiều lần) nên chỉ chạy `schedule`/`workflow_dispatch`,
không chặn mỗi push.

## 3. Vá "rỗng = xanh giả" (rà soát đối kháng workflow — 5 finding CONFIRMED)

Workflow audit 4 chiều (find → verify default-refute) lôi ra: các guard MỚI vẫn hở cùng lớp
"rỗng = xanh giả" ở mức mịn hơn. Đã vá cả 5:

1. **dbtest glob** (`node --test test/*.test.js`) không có sàn đếm → mất-ròng 1 suite cô lập
   (vd `storefront-isolation.test.js` — KHÔNG `verify-*.sh` nào phủ) vẫn xanh. **Vá:** chốt
   `n ≥ 3` trong `sh -c` trước khi chạy.
2. **unit guard `-ge 4`** là TỔNG 4 mẫu, không phải sàn từng nguồn → mất trọn dir
   `packages/auth/test/` (crypto MFA/TOTP) vẫn đủ 4 → xanh. **Vá:** mỗi thư mục test phải
   khớp ≥1 file + tổng ≥ 7 (số thật).
3. **unit guard bị 2 path lẻ thổi phồng** — `nullglob` KHÔNG rút path không có ký tự glob
   (`vietqr.test.js`, `rbac.test.js`) → luôn đếm là 2 → sàn 4 chỉ cần 2 glob thật. **Vá:**
   `test -f` từng file lẻ tường minh, không tính vào sàn glob.
4. **`security-scan.sh` không phân biệt "sạch" với "không quét được"** — mọi scan glob cứng
   `apps/*/src packages/*/src infra/` với `2>/dev/null || true` rồi test rỗng; layout đổi tên
   → glob 0 file → mọi mục "sạch" GIẢ. **Vá:** section 0 chốt `≥8 apps/*/src`, `≥1 packages/*/src`,
   `infra/` tồn tại — không thấy đủ cây src → `exit 1` (không quét được ≠ sạch).
5. **mutation guard `-ge 15`** thấp hơn số thật (19) 4 script → mất-ròng tới 4 mutation vẫn qua.
   **Vá:** sàn = 19.

Nguyên tắc chung: **sàn đếm = số thật hôm nay** (thêm → tăng vẫn qua; xoá/đổi tên → giảm → đỏ),
và với nguồn hỗn hợp glob+literal thì chốt TỪNG nguồn, không chỉ tổng.

## 4. Trôi anchor mutation (A2/A5 đổi code làm sed hụt)

Glob mutation mới kéo vào cả các `verify-*.sh` trước đây bị bỏ sót khỏi danh sách hardcode
(`media`/`checkout`/`platform`) → lộ 2 script có anchor đã trôi do code đổi sau khi script viết:

- **`verify-storefront.sh` (`verified`)**: A5 `resolveShop` thêm subquery có `verified_at IS NOT NULL`
  thứ hai + prefix WHERE chính thành `d.verified_at` → sed cũ trúng subquery vô hại. **Vá:** nhắm
  `AND d.verified_at IS NOT NULL` (WHERE chính).
- **`verify-seller.sh` (`tenant`)**: `withTenant`/`set_config('app.shop_id')` đã tách sang `db.js`
  từ Ngày 8, nhưng sed vẫn nhắm `server.js`. **Vá:** nhắm `db.js` + thêm `db.js` vào backup/restore/
  diff-check (theo đúng mẫu `verify-catalog.sh` — script này vốn đã nhắm `db.js` đúng).

Bài học: script mutation nhắm file KHÔNG backup thì sau khi chạy file đó KẸT ở trạng thái đã-gỡ-phòng-thủ
(lỗ hổng bị commit) VÀ diff-check "anchor sai" không thấy đổi. Glob-hết vào CI mới lôi ra được.

## 5. `verify-platform.sh` — bỏ mutation không phải lỗ hổng

Mutation `invonce` (gỡ tính nguyên tử của accept lời mời) VẪN XANH đúng: accept trùng token chỉ
re-accept cho CÙNG user; unique users/memberships + kết quả idempotent chặn chiếm shop. Bất biến
P0-4 thật đã do `verify-invitation.sh` phủ. Đã gỡ mutation này (không phải phòng thủ) → platform 6/6.

## 6. Trạng thái verify (19 script)

- **Live (đỏ-khi-mutation):** auth 16/16, seller 8/8, storefront 7/7, admin 3/3, invitation 4/4,
  platform 6/6, checkout 7/7, media 5/5.
- **Anchor còn nguyên (đối chiếu byte với code hiện tại):** payment, fulfillment, content, catalog,
  preview, blocks, seo, domains, export.
- **Miễn trôi:** tenant-isolation (mutation cấp DDL/SQL, không anchor mã nguồn), readiness (hành vi).

**Tuần A HOÀN TẤT** (A1→A3a→A3b→A2→A4→A6→A5→A7). Tuần B–D (deploy/DR/UAT/pilot) cần tài nguyên user.
