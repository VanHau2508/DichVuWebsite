# Cô lập tenant — bước (b)

> **Trạng thái: ĐÃ CHẠY từ cold start.**
> Cô lập tenant: 36/36 · Mutation testing: 12/12 · Regression TLS: 35/35.

Đây là cổng nghiệm thu tuần 1. Không được sang tuần 2 nếu bộ test này chưa xanh
**và** chưa qua được mutation testing.

---

## 1. Ba lớp phòng thủ

Không tin vào một lớp nào. Lỗi quên `WHERE shop_id = ?` là điều **sẽ** xảy ra.

| Lớp | Ở đâu | Bắt được gì |
|---|---|---|
| 1. Ứng dụng | `withTenant()` đặt `app.shop_id` mỗi transaction | trường hợp thường |
| 2. RLS | policy `FORCE` trên mọi bảng, role `app_rw` không `BYPASSRLS` | code quên lọc shop |
| 3. Composite FK | `FK (shop_id, x) REFERENCES t (shop_id, id)` | tham chiếu chéo shop, kể cả khi RLS tắt |

Điểm cốt lõi: **các lớp bắt lỗi khác nhau.** Composite FK chặn `order_line` của
shop A trỏ tới `variant` của shop B *ngay cả khi* RLS bị tắt nhầm và code quên
lọc. Đó là lý do phải có cả ba, không phải chọn một.

---

## 2. `withTenant` và vì sao phải là `SET LOCAL`

```js
await client.query('BEGIN');
await client.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]); // is_local = true
// ... truy vấn nghiệp vụ ...
await client.query('COMMIT');
```

`set_config(..., true)` = `SET LOCAL`: phạm vi **transaction**. Sau `COMMIT`,
context biến mất.

Điều này bắt buộc vì **PgBouncer ở chế độ transaction pooling** trả connection
về pool sau mỗi `COMMIT` và giao nó cho request của shop khác. Nếu dùng `SET`
(session-scoped, `is_local = false`), `app.shop_id` của shop A **sống sót** sang
request tiếp theo trên cùng connection — rò rỉ dữ liệu chéo tenant, và im lặng.

Có hai test khẳng định điều này, một cái *cố ý* chứng minh hành vi nguy hiểm của
`SET` session-scoped, để nếu ai đó đổi `withTenant` họ thấy ngay cái giá:

```
test('SET LOCAL hết hiệu lực sau COMMIT — connection tái sử dụng an toàn')
test('SET session-scoped RÒ RỈ sang truy vấn sau — vì sao bắt buộc SET LOCAL')
```

Dùng `set_config($1, ...)` tham số hoá thay vì nối chuỗi `SET LOCAL app.shop_id
= '...'` để `shop_id` không bao giờ trở thành đường SQL injection.

---

## 3. `current_shop_id()` — fail-closed

```sql
CREATE FUNCTION current_shop_id() RETURNS uuid ... AS
$$ SELECT NULLIF(current_setting('app.shop_id', true), '')::uuid $$;
```

- `missing_ok = true` → chưa set thì trả `NULL`, không ném lỗi.
- `NULLIF(..., '')` → chuỗi rỗng ép kiểu `uuid` sẽ ném lỗi; biến nó thành `NULL`.
- `shop_id = NULL` cho ra `NULL` (không phải `true`) → **không dòng nào lọt**.

Nghĩa là truy vấn quên đặt context trả về **rỗng**, không phải trả về dữ liệu
của mọi khách. Mutation "fail-open" (trả shop đầu tiên khi thiếu context) bị test
hành vi bắt ngay.

---

## 4. Hai phát hiện khi kiểm chứng bằng thực nghiệm

Cả hai đều sửa lại điều tôi đã viết trong `docs/02` trước đó. Đây là lý do phải
chạy, không chỉ viết.

### 4.1 Bỏ `WITH CHECK` trên `FOR ALL` KHÔNG phải lỗ hổng

Tôi từng viết "thiếu `WITH CHECK` là lỗ hổng ghi chéo". **Sai.** Đã kiểm chứng:
gỡ `WITH CHECK` khỏi policy `FOR ALL`, cả 23 test hành vi vẫn xanh — Postgres
dùng lại biểu thức `USING` cho chiều ghi. Vẫn viết tường minh, nhưng đó là quy
ước phòng khi ai đó tách policy, không phải hàng rào.

### 4.2 Lỗ hổng ghi chéo THẬT: policy permissive thứ hai

Policy PERMISSIVE được **OR** với nhau. Thêm một dòng trông vô hại:

```sql
CREATE POLICY lax ON products FOR INSERT TO app_rw WITH CHECK (true);
```

...trong khi `tenant_isolation` vẫn nằm nguyên đó, là **mở toang** đường ghi chéo
shop. Test hành vi bắt được; test metadata đầu tiên của tôi thì **không**.

Bất biến được cưỡng chế bây giờ (trong `schema-invariants.test.js`):
- **mỗi bảng tenant có đúng MỘT policy cho `app_rw`**;
- **không policy nào dùng biểu thức hằng `true`**.

---

## 5. Mutation testing — vì sao test xanh chưa đủ

`scripts/verify-tenant-isolation.sh` gỡ từng lớp phòng thủ rồi khẳng định bộ test
**chuyển sang đỏ**. Lớp nào gỡ mà test vẫn xanh thì lớp đó không được canh gác.

Nó phân biệt hai loại bắt lỗi, và sự phân biệt này quan trọng:

| Loại | Nghĩa | Bộ test |
|---|---|---|
| **hành vi** | dữ liệu THẬT SỰ rò sang shop khác | `tenant-isolation.test.js` |
| **quy ước** | schema lệch chuẩn nhưng chưa rò | `schema-invariants.test.js` |

Nếu ta tưởng một mutation là "lỗ hổng" trong khi nó chỉ bị quy ước bắt, ta đang
tự lừa mình về mức độ an toàn thật. Ví dụ:

- **Rò thật** (test hành vi phải đỏ): tắt RLS, `BYPASSRLS`, `USING (true)`,
  policy permissive thừa, hạ cấp composite FK, cho sửa `audit_logs`, fail-open.
- **Chỉ lệch quy ước** (chưa rò qua `app_rw`): tắt `FORCE` (chỉ ảnh hưởng script
  chạy bằng `app_owner`), bỏ `WITH CHECK` trên `FOR ALL`.
- **Rò thật mà chỉ bất biến bắt được**: thêm bảng mới có `shop_id` nhưng quên
  bật RLS. Test hành vi **không thể** phủ một bảng chưa tồn tại — đây chính là
  lý do bất biến schema tồn tại. Kịch bản thực tế nhất của tuần thứ 9.

---

## 6. Chạy

```bash
docker compose -f infra/compose.dev.yml up -d --build

# Bộ test cô lập tenant (cần Postgres)
docker compose -f infra/compose.dev.yml exec -T dbtest sh -c 'node --test test/*.test.js'

# Mutation testing — chứng minh bộ test trên thật sự canh gác
bash scripts/verify-tenant-isolation.sh
```

Cả hai phải chạy trong **CI ở mọi commit**. Migration là dùng chung với
production (`packages/db/migrations/`), nên nếu chúng đỏ ở CI thì production đang
có lỗ hổng cô lập tenant.

---

## 7. Còn thiếu (ngoài phạm vi bước b)

- Migration runner thật (hiện init qua `docker-entrypoint-initdb.d`; production
  cần công cụ chạy tăng dần + kiểm `up → down → up`).
- `app_platform` role riêng cho `/ops` với policy riêng + audit bắt buộc.
- Ràng buộc `WITH CHECK` cho `outbox`/`idempotency_keys` khi `shop_id` do worker
  đặt (worker chạy ngoài context request — cần đường đặt context riêng).
- State machine đơn hàng (bảng đã có cột `status`; logic chuyển trạng thái chưa).
