# 74 — Onboarding, xem trước và mở bán không làm người dùng mắc kẹt

Đợt này hoàn thiện lát cắt **Tổng quan → kiểm tra readiness → xem trước → mở bán**. Mục tiêu
không phải làm checklist đẹp hơn, mà bảo đảm chủ shop luôn biết đang thiếu gì, có thể thao tác
bằng bàn phím/no-JS, và không vô tình làm chết link xem trước đã gửi cho người khác.

---

## 1. Những ma sát đã bỏ

| trước | sau |
|---|---|
| Nút mở bán bị `disabled`; bàn phím không focus được, mobile không thấy `title` giải thích | Nút luôn submit được; seller kiểm tra lại ở server và BFF nêu đúng mục thiếu đầu tiên + link đi sửa |
| `checkout_dry_run` bị tính như một việc thứ chín dù người dùng không có gì để bấm | Tách thành dòng chẩn đoán; vẫn `blocking=true` ở server nhưng không tính vào tiến độ 8 việc |
| Mỗi POST preview xoay token, nên double-click hoặc gửi lại form làm link cũ chết | Một `INSERT ... ON CONFLICT ... WHERE` nguyên tử giữ token còn hạn; chỉ `rotate=1` mới xoay |
| F5 làm giao diện quên link preview đang sống/hết hạn | `GET /readiness` trả metadata `active/expired/none`, không trả token hay hash |
| Màn “đang chuẩn bị mở bán” có nguy cơ dùng PII tài khoản chủ shop | Chỉ dùng `shops.contact_email/contact_phone`, là liên hệ công khai do shop khai |

MFA vẫn là khuyến nghị không chặn. Readiness, go-live, cô lập tenant và token preview vẫn do
server quyết định; JavaScript chỉ thêm confirm và chống bấm lặp, không trở thành điều kiện để
luồng hoạt động.

---

## 2. Hợp đồng preview

Lần tạo đầu trả URL thô đúng một lần, kèm `expires_at`. Hệ thống chỉ lưu `token_hash`.

- Gửi lặp khi token còn hạn: trả `200 { reused, expires_at }`, không xoay và không dựng lại URL.
- Hai POST đồng thời: vẫn đúng một dòng và token đầu còn hiệu lực.
- Hết hạn hoặc `rotate=1`: xoay token; link cũ mất hiệu lực có chủ ý.
- `GET /readiness`: chỉ trả `{ state, expires_at }`, không lộ token/hash/`created_by`.
- Shop khác không đọc được metadata hoặc dùng token chéo tenant.

Giao diện không nói “dùng lại link đó”, vì hệ thống không biết người dùng còn giữ URL hay không.
Nó nói đúng điều biết được: đang có link còn hiệu lực, không thể hiển thị lại vì chỉ lưu hash,
và tạo link mới sẽ vô hiệu link cũ.

---

## 3. Lỗi tìm thấy khi chạy thật

### 3.1 API thiếu `expires_at`

HTML mới muốn hiển thị giờ hết hạn nhưng response tạo preview chỉ có `expires_in`. Kết quả là
link hiện đúng còn dòng “dùng được tới” biến mất. E2E mới bắt được vì kiểm cả URL lẫn TTL hiển
thị. Vá ở seller bằng cách trả chính `expires_at` từ dòng vừa `RETURNING`.

### 3.2 Fixture cố tạo trạng thái DB không hợp lệ

Test hết hạn ban đầu chỉ kéo `expires_at` về quá khứ, làm nó nhỏ hơn `created_at` và bị CHECK
`expires_at > created_at` chặn. Đây là hàng rào DB hoạt động đúng, không phải lỗi sản phẩm. Fixture
nay lùi cả `created_at` và `expires_at` theo một khoảng thời gian hợp lệ.

### 3.3 `fetch` không phải công cụ đúng để đặt Host storefront

Test PII dùng `fetch(..., { headers: { host } })`; runtime không gửi Host shop như dự kiến nên
storefront phân giải thành 404, tạo hai FAIL giả. Các bộ storefront hiện hữu đã ghi rõ quy tắc:
dùng `node:http` khi cần đặt Host. Test onboarding nay dùng cùng helper đó và chọn domain đã xác
minh theo thứ tự primary.

### 3.4 Test cũ giữ hợp đồng 9 mục

Một nửa file đã đổi sang `2/8`, nửa sau vẫn tìm `2/9`, `3/9`, `8/9`, câu lỗi chung và câu TTL
cũ. Những khẳng định này được đổi sang hợp đồng mới, nhưng không làm mềm: vẫn kiểm đúng tiến độ,
số mục blocking, nhãn shipping đầu tiên, `action_url`, CSP nonce, URL preview và thời hạn.

### 3.5 Readiness theo nguồn tồn và retry email onboarding

Shop `local` giữ nguyên đường readiness hiện có. Với `external_master`, server chỉ cho đạt khi
connector đang `active`, có ít nhất một biến thể đã mapping, `inventory_generation` khớp
generation của connector và `inventory_synced_at` còn trong 5 phút. Thiếu một điều kiện thì
`inventory_source` và `checkout_dry_run` vẫn chặn go-live; giao diện chỉ dẫn tới phần kết nối,
không tự quyết thay backend.

Thông báo `shop.onboarding_nudge` được phép retry từ màn hình sự cố. Retry vẫn tạo outbox mới,
giữ `retry_of_delivery_id`, kế thừa hạn PII gốc và chuyển delivery cũ từ `failed` sang
`superseded`; các topic mật khẩu, lời mời và tồn kho vẫn bị chặn như trước.

---

## 4. Bằng chứng đóng lát cắt

Chạy trên nhánh `codex/ux-onboarding-golive-fix`:

| cổng | kết quả |
|---|---:|
| E2E onboarding mục tiêu | 55 pass, 0 fail |
| unit | 220/220 |
| migration từ DB trắng | 172 migration, 0 DRIFT, 0 pending |
| bất biến DB/RLS | 116/116 |
| toàn bộ E2E | 106/106 bộ xanh |
| smoke edge/readiness/TLS | 3/3 xanh |
| full CI | 113 mục, 0 đỏ |

Lượt full mất gần 58 phút vì DB dev đã tích tới 7.632 shop. Đây không phải lỗi của lát cắt nhưng
là lý do không nên chạy chồng nhiều lượt và cần lên kế hoạch dọn DB dev có backup riêng.

---

## 5. Còn nợ

- Bản cập nhật readiness connector + retry onboarding đang ở nhánh
  `codex/onboarding-readiness-connector`, chưa merge hoặc push; cần review độc lập rồi mới
  fast-forward vào `main`.
- IP LAN của hostname dev đang cũ; chỉ ảnh hưởng link `nip.io`, không ảnh hưởng CI nội bộ.
- Connector KiotViet mới đủ lõi cho pilot; trước khi bật `external_master` cho shop thật phải
  spike bằng credential thật để xác minh webhook, rate limit và ngữ nghĩa HTTP 404.
- Builder và CRM vẫn hoãn tới sau pilot thật 14 ngày; không mở rộng phạm vi lát cắt này trước
  khi có số đo vận hành.
