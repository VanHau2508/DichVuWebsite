# 76 — Phòng thủ nhiều lớp cho `idempotency_keys`

> Lát cắt xen giữa workflow 3 và 4, làm trước vì nó là rủi ro cô lập tenant đang chạy.
> Kết quả đã merge: `1e8fd2c`.

## Điều đáng nhớ nhất không phải bản vá, mà là cái tiền đề sai

Đợt đo mở đầu bằng một finding **CAO** của tôi: *"`idempotency_keys` chưa bật RLS, có đường
ghi chéo tenant khai thác được từ ngoài."* Tôi đã suýt gửi Codex đi viết migration `0176`
để `ENABLE`/`FORCE` RLS và tạo policy mới.

Tiền đề đó **sai**. Chủ dự án bác lại bằng số đo thật từ `pg_class`:
`relrowsecurity = true`, `relforcerowsecurity = true`, và policy `tenant_isolation` đã tồn
tại. Migration tôi định đặt hàng sẽ **trùng policy** với cái đang có.

Vì sao tôi sai: tôi đi tìm `ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY` viết
thẳng trong migration, không thấy, rồi kết luận là chưa bật. Nhưng `0004_rls.sql:25-59` bật
RLS bằng **vòng lặp động**:

```sql
FOR t IN SELECT ... WHERE có cột shop_id LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
```

Không có chuỗi `ALTER TABLE idempotency_keys` nào trong kho, mà bảng thì vẫn được bật.

**Luật rút ra, đã đưa vào CLAUDE.md §4:** schema lúc chạy phải đọc từ `pg_class` /
`pg_policies`, không suy bằng grep migration. Không truy vấn được thì ghi *"chưa xác minh"*,
đừng khẳng định. Đây là lần thứ ba cùng một lớp lỗi cắn kho này — thứ dựng qua **biến** hoặc
qua **vòng lặp** thì vô hình với phép đo dựa trên chuỗi (trước đó là link dựng qua `x.href`,
và SQL gán vào một `const`).

## Việc thật sự phải làm

Bảng đã có RLS, nhưng vẫn còn một lớp thiếu: hai truy vấn ở checkout đọc/ghi
`idempotency_keys` mà **không có vị từ tenant trong chính câu lệnh**. Chúng an toàn *nhờ*
RLS — nghĩa là chỉ còn **một** lớp. Bản vá thêm vị từ `shop_id` vào đúng hai chỗ đó, để mất
một lớp không thành mất tất cả.

Giữ nguyên: hợp đồng khoá do client cung cấp, và số lượng migration (không thêm file nào).

## Chốt: tập policy phải so ĐÚNG BẰNG, không phải "có tồn tại"

Bản đầu của tôi định kiểm "policy `tenant_isolation` có tồn tại không". Chủ dự án chỉ ra chỗ
hổng: **PostgreSQL OR các policy PERMISSIVE lại với nhau.** Một policy thứ hai tên
`checkout_idem_lax` thêm vào sau sẽ **nới rộng** quyền truy cập trong khi cả hai policy đúng
vẫn nguyên vẹn — chốt "có tồn tại" xanh, dữ liệu rò.

Nên bất biến được khoá là **so cả TẬP**:

- `relrowsecurity` và `relforcerowsecurity` đều `true` — đây là **cột của `pg_class`**, không
  phải dòng policy; tập policy đúng có **3 dòng**, không phải 4 (tôi từng đếm nhầm thành 4).
- `app_rw` có `tenant_isolation` phủ SELECT/INSERT/UPDATE/DELETE với `USING`/`WITH CHECK`
  đúng, và **không có** policy permissive thứ hai.
- `app_checkout` có `checkout_idem`, cùng điều kiện.

Ma trận đột biến 8 ca, tất cả ĐỎ.

## Hai chiều của vòng review chéo

Lát cắt này cho thêm bằng chứng cho luật *"người viết code không phải người duy nhất tuyên bố
xanh"* (§9.1) — nhưng lần này chiều bắt lỗi là **chủ dự án bắt lỗi của Claude**, hai lần, và
cả hai đều là lỗi **đo**, không phải lỗi **gõ**:

1. Tiền đề "chưa bật RLS" — sinh ra từ grep một migration động.
2. Chốt "policy có tồn tại" — bỏ qua ngữ nghĩa OR của PERMISSIVE.

Cả hai đều sẽ đi lọt nếu chỉ đọc diff. Chúng chỉ lộ ra khi có người đối chiếu **với hệ thống
đang chạy** thay vì với văn bản.
