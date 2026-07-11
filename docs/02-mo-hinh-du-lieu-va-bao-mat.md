# Mô hình dữ liệu và cô lập tenant

> Tài liệu này quyết định thứ **không sửa được về sau**. Đọc kỹ trước khi viết migration đầu tiên.

---

## 1. Nguyên tắc bất biến

1. **Mọi bảng nghiệp vụ có cột `shop_id uuid NOT NULL`.** Không ngoại lệ. Kể cả bảng tưởng như phụ (`media`, `outbox`, `idempotency_keys`).
2. **Khóa chính là `uuid` (v7 nếu có).** Không dùng `bigserial` cho thực thể nghiệp vụ — id tuần tự toàn cục để lộ sản lượng của khách và tạo cám dỗ IDOR.
3. **Mọi bảng nghiệp vụ có `UNIQUE (shop_id, id)`.** Chỉ để làm đích cho composite foreign key. Xem mục 3.
4. **Tiền là `bigint`, đơn vị đồng, không thập phân.** Không `float`, không `numeric` để rồi quên `ROUND`. VND không có phần lẻ.
5. **Không xóa cứng dữ liệu nghiệp vụ.** `deleted_at timestamptz`. Khóa shop không xóa dữ liệu — đây là cam kết trong hợp đồng.
6. **Timestamps `timestamptz`, lưu UTC.** Timezone hiển thị là thuộc tính của shop.

---

## 2. ERD lõi

```
                    ┌──────────┐
                    │  shops   │
                    └────┬─────┘
        ┌────────────────┼────────────────┬─────────────┐
        │                │                │             │
   ┌────▼─────┐   ┌──────▼──────┐  ┌──────▼──────┐ ┌────▼────────┐
   │ domains  │   │ memberships │  │subscriptions│ │   themes    │
   └──────────┘   └──────┬──────┘  └─────────────┘ └─────────────┘
                         │
                    ┌────▼────┐
                    │  users  │  (toàn cục — một người có thể ở nhiều shop)
                    └─────────┘

   ┌────────────┐      ┌──────────────┐      ┌────────────────┐
   │ categories │◄────►│   products   │─────►│    variants    │
   └────────────┘ n:n  └──────┬───────┘ 1:n  └───────┬────────┘
                              │                      │
                       ┌──────▼───────┐      ┌───────▼─────────┐
                       │ product_media│      │ inventory_levels│
                       └──────────────┘      └───────┬─────────┘
                                                     │
                                             ┌───────▼──────────┐
                                             │ inventory_ledger │ (append-only)
                                             └──────────────────┘

   ┌────────┐      ┌────────────┐      ┌──────────┐      ┌─────────────┐
   │ carts  │─────►│ cart_items │      │  orders  │─────►│ order_lines │
   └────────┘      └────────────┘      └────┬─────┘      └─────────────┘
                                            │            (snapshot: tên, SKU,
                                   ┌────────┼────────┐    giá, ảnh tại lúc mua)
                                   │        │        │
                            ┌──────▼──┐ ┌───▼────┐ ┌─▼─────────┐
                            │ payments│ │shipments│ │order_events│
                            └────┬────┘ └────────┘ └───────────┘
                                 │
                        ┌────────▼──────────┐
                        │payment_transactions│ (ledger, append-only)
                        └───────────────────┘

   Hạ tầng: outbox · idempotency_keys · audit_logs · shop_counters · media
```

---

## 3. Composite foreign key — chống tham chiếu chéo shop

Đây là kỹ thuật quan trọng nhất và hay bị bỏ qua nhất.

FK thông thường **không** ngăn được `order_line` của shop A trỏ tới `variant` của shop B:

```sql
-- ✗ SAI: cho phép cross-tenant reference
CREATE TABLE order_lines (
  id         uuid PRIMARY KEY,
  shop_id    uuid NOT NULL REFERENCES shops(id),
  variant_id uuid NOT NULL REFERENCES variants(id)   -- variant của shop nào?
);
```

Cách đúng: đưa `shop_id` vào chính khóa ngoại. Database sẽ **từ chối** ghi nếu shop không khớp.

```sql
-- ✓ ĐÚNG
CREATE TABLE variants (
  id      uuid PRIMARY KEY DEFAULT uuidv7(),
  shop_id uuid NOT NULL REFERENCES shops(id),
  ...
  UNIQUE (shop_id, id)          -- đích cho composite FK
);

CREATE TABLE order_lines (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  shop_id    uuid NOT NULL,
  order_id   uuid NOT NULL,
  variant_id uuid NOT NULL,

  FOREIGN KEY (shop_id, order_id)   REFERENCES orders   (shop_id, id),
  FOREIGN KEY (shop_id, variant_id) REFERENCES variants (shop_id, id),
  UNIQUE (shop_id, id)
);
```

Áp dụng cho **mọi** quan hệ giữa hai bảng có tenant. Nếu ORM của bạn không diễn đạt được composite FK, viết migration SQL thô — đừng bỏ.

Kết quả: dù RLS bị tắt nhầm, dù code quên `WHERE shop_id`, một `INSERT` tham chiếu chéo shop vẫn **bị Postgres chặn**.

---

## 4. Row-Level Security — thiết lập đầy đủ

### 4.1 Vai trò database

```sql
-- Role sở hữu schema, chỉ dùng để chạy migration. KHÔNG phải app dùng.
CREATE ROLE app_owner LOGIN PASSWORD '...';

-- Role ứng dụng dùng hằng ngày.
CREATE ROLE app_rw LOGIN PASSWORD '...';
-- app_rw KHÔNG phải superuser, KHÔNG có BYPASSRLS, KHÔNG sở hữu bảng nào.
-- (Chủ sở hữu bảng luôn bypass RLS trừ khi FORCE — xem 4.2.)

GRANT USAGE ON SCHEMA public TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
```

Kiểm tra định kỳ trong CI:
```sql
SELECT rolname FROM pg_roles WHERE rolbypassrls AND rolname = 'app_rw';
-- phải trả về 0 dòng
```

### 4.2 Policy trên từng bảng

```sql
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE  ROW LEVEL SECURITY;   -- áp dụng cả cho chủ bảng

CREATE POLICY tenant_isolation ON products
  USING      (shop_id = current_setting('app.shop_id', true)::uuid)
  WITH CHECK (shop_id = current_setting('app.shop_id', true)::uuid);
```

- `USING` lọc `SELECT`/`UPDATE`/`DELETE`.
- `WITH CHECK` chặn `INSERT`/`UPDATE` ghi sang shop khác.
- `FORCE` bắt buộc, nếu không chủ bảng vẫn nhìn thấy hết.
- Tham số thứ hai `true` của `current_setting` = `missing_ok`. Khi chưa set, hàm trả `NULL`, so sánh ra `NULL` → **không có dòng nào lọt**. Đây là hành vi fail-closed mong muốn. Bọc thêm `NULLIF(..., '')` vì chuỗi rỗng ép kiểu `uuid` sẽ ném lỗi.

> **Đính chính (kiểm chứng bằng mutation testing).** Với policy `FOR ALL`, bỏ
> `WITH CHECK` **không** tạo lỗ hổng: Postgres dùng lại biểu thức `USING` cho cả
> chiều ghi. Ta vẫn viết tường minh, nhưng đó là quy ước, không phải hàng rào.
>
> Lỗ hổng ghi chéo tenant **thật sự** nằm ở chỗ khác: một policy **PERMISSIVE thứ
> hai** trên cùng bảng (ví dụ `CREATE POLICY lax ON products FOR INSERT TO app_rw
> WITH CHECK (true)`) được **OR** với policy gốc và vô hiệu hoá nó hoàn toàn —
> trong khi `tenant_isolation` vẫn nằm đó, trông hoàn toàn vô hại.
>
> Vì vậy bất biến được cưỡng chế là: **mỗi bảng tenant có đúng MỘT policy cho
> `app_rw`**, và **không policy nào dùng biểu thức hằng `true`**.

Viết một migration sinh policy cho **toàn bộ** bảng có cột `shop_id`, và một test đảo ngược:

```sql
-- CI phải fail nếu có bảng nghiệp vụ nào thiếu RLS
SELECT c.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN information_schema.columns col
     ON col.table_name = c.relname AND col.column_name = 'shop_id'
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);
-- phải trả về 0 dòng
```

### 4.3 Đặt tenant context

```ts
// packages/tenant-context/withTenant.ts
export async function withTenant<T>(shopId: string, fn: (tx: Tx) => Promise<T>) {
  return db.transaction(async (tx) => {
    // SET LOCAL: phạm vi transaction, an toàn với PgBouncer transaction pooling.
    // KHÔNG dùng SET (session-scoped) — nó rò sang request kế tiếp trên cùng connection.
    await tx.execute(sql`SELECT set_config('app.shop_id', ${shopId}, true)`);
    return fn(tx);
  });
}
```

Dùng `set_config(..., true)` thay vì `SET LOCAL app.shop_id = '...'` vì tham số hóa được → không nối chuỗi → không SQL injection qua shop_id.

**Truy vấn nào không nằm trong `withTenant` sẽ trả về rỗng.** Đó là thiết kế. Query của platform-admin dùng connection role riêng `app_platform` với policy riêng, có audit bắt buộc.

### 4.4 Bảng toàn cục (không có shop_id)

`users`, `shops`, `platform_staff`, `plans`. Không bật RLS; bảo vệ hoàn toàn ở tầng ứng dụng. Số lượng ít, truy cập có kiểm soát.

Lưu ý `users` là toàn cục: một email có thể là Owner shop A và Order Manager shop B. Quyền nằm ở `memberships(user_id, shop_id, role)`.

---

## 5. Test cross-shop — cổng nghiệm thu tuần 1

> **Trạng thái: ĐÃ CHẠY.** `packages/db/test/` — 34/34 pass.
> Mutation testing (`scripts/verify-tenant-isolation.sh`) — 12/12: mỗi lớp phòng
> thủ bị gỡ đi đều làm bộ test chuyển sang đỏ. Xem `06-co-lap-tenant.md`.

Không có bộ test này thì **không được sang tuần 2**. Nó rẻ và nó là thứ cứu bạn khỏi việc mất toàn bộ khách hàng trong một ngày.

Và một bộ test xanh chưa chứng minh gì cả: phải gỡ từng lớp phòng thủ ra để xem
nó có chuyển sang đỏ không. Bộ test không đỏ khi hàng rào bị tháo là bộ test
đang không canh gác gì.

```ts
describe('cô lập tenant', () => {
  const A = seedShop('shop-a');
  const B = seedShop('shop-b');

  it('shop A không SELECT được sản phẩm của B', async () => {
    const rows = await withTenant(A.id, tx => tx.select().from(products));
    expect(rows.map(r => r.id)).not.toContain(B.productId);
  });

  it('shop A không UPDATE được sản phẩm của B', async () => {
    const n = await withTenant(A.id, tx =>
      tx.update(products).set({ price: 1 }).where(eq(products.id, B.productId)));
    expect(n.rowCount).toBe(0);            // RLS lọc, không throw
  });

  it('shop A không INSERT được dòng mang shop_id của B', async () => {
    await expect(withTenant(A.id, tx =>
      tx.insert(products).values({ shop_id: B.id, ... })
    )).rejects.toThrow(/row-level security/);   // WITH CHECK chặn
  });

  it('không thể tạo order_line trỏ sang variant của shop khác', async () => {
    await expect(withTenant(A.id, tx =>
      tx.insert(orderLines).values({ shop_id: A.id, variant_id: B.variantId, ... })
    )).rejects.toThrow(/foreign key/);          // composite FK chặn
  });

  it('không có tenant context thì không đọc được gì', async () => {
    const rows = await db.select().from(products);   // ngoài withTenant
    expect(rows).toHaveLength(0);                    // fail-closed
  });

  it('app_rw không có BYPASSRLS', async () => {
    const [r] = await db.execute(sql`SELECT rolbypassrls FROM pg_roles WHERE rolname='app_rw'`);
    expect(r.rolbypassrls).toBe(false);
  });
});
```

Ngoài ra: một **Playwright test** đăng nhập bằng Owner của shop A, gọi thẳng `GET /api/orders/{id_của_shop_B}` → phải nhận `404` (không phải `403`; `403` xác nhận sự tồn tại của tài nguyên).

---

## 6. Bảng hạ tầng

### idempotency_keys
```sql
CREATE TABLE idempotency_keys (
  shop_id       uuid NOT NULL,
  key           text NOT NULL,
  request_hash  text NOT NULL,           -- sha256(method+path+body)
  status        text NOT NULL,           -- in_progress | completed
  response_code int,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, key)
);
```
Cùng `key` nhưng `request_hash` khác → trả `422`. Đó là client đang gửi sai, không phải retry.

### outbox
```sql
CREATE TABLE outbox (
  id           bigserial PRIMARY KEY,
  shop_id      uuid NOT NULL,
  topic        text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts     int NOT NULL DEFAULT 0
);
CREATE INDEX ON outbox (processed_at) WHERE processed_at IS NULL;
```

### audit_logs
```sql
CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  shop_id     uuid,                      -- NULL cho hành động cấp nền tảng
  actor_type  text NOT NULL,             -- user | platform_staff | system
  actor_id    uuid,
  action      text NOT NULL,             -- 'order.refund', 'member.role_changed'
  target      text,
  ip          inet,
  user_agent  text,
  metadata    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

**Bắt buộc audit**: đăng nhập / thất bại đăng nhập, đổi quyền, mời/xóa thành viên, hoàn tiền, thêm/xóa domain, xuất dữ liệu, khóa/mở shop, kích hoạt support access, đổi cấu hình thanh toán.

`audit_logs` **chỉ INSERT**. Thu hồi quyền `UPDATE`/`DELETE` của `app_rw` trên bảng này.

### shop_counters
```sql
CREATE TABLE shop_counters (
  shop_id uuid NOT NULL,
  name    text NOT NULL,        -- 'order_number'
  value   bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_id, name)
);
-- UPDATE shop_counters SET value = value + 1
--   WHERE shop_id=$1 AND name='order_number' RETURNING value;
```

---

## 7. Máy trạng thái đơn hàng

```
        ┌─────────┐
        │ pending │ (vừa tạo, chờ xác nhận / chờ chuyển khoản)
        └────┬────┘
             │ confirm
        ┌────▼──────┐         cancel        ┌───────────┐
        │ confirmed ├──────────────────────►│ cancelled │
        └────┬──────┘                       └───────────┘
             │ fulfill                            ▲
        ┌────▼──────┐                             │
        │  shipped  ├─────────────────────────────┘ (chỉ khi chưa delivered)
        └────┬──────┘
             │ deliver
        ┌────▼──────┐   refund   ┌──────────┐
        │ delivered ├───────────►│ refunded │
        └───────────┘            └──────────┘
```

- Chuyển trạng thái là **hàm thuần** `transition(from, event) → to | Error`, có bảng chân lý, có unit test phủ 100% cặp không hợp lệ.
- Mỗi lần chuyển ghi một dòng `order_events` (append-only). Không bao giờ chỉ `UPDATE orders.status`.
- `payment.status` (`unpaid | pending | paid | refunded`) là **trục độc lập** với `order.status`. Đơn COD có thể `delivered` + `unpaid` trong vài giờ. Đừng nhét chung một cột — đây là lỗi thiết kế phổ biến và rất tốn kém để gỡ.
- Trừ tồn kho tại `confirmed`, không phải tại `pending`. Ở `pending` chỉ **reserve** với TTL 30 phút.

---

## 8. Danh mục kiểm soát bảo mật

| Mối đe dọa | Kiểm soát | Kiểm chứng ở đâu |
|---|---|---|
| Rò dữ liệu chéo shop | RLS `FORCE` + composite FK + `withTenant` | test mục 5 |
| Chiếm domain của shop khác | chỉ route domain `verified_at IS NOT NULL`; `/tls/authorize` | e2e |
| Lạm dụng Let's Encrypt | `ask` endpoint + `burst 5` | thủ công |
| IDOR | uuidv7 + RLS + trả `404` không phải `403` | Playwright |
| Leo thang đặc quyền | step-up auth cho hành động nhạy cảm; đổi quyền có audit | unit |
| XSS lưu trữ | không cho chèn HTML/JS; section props validate bằng Zod; CSP không `unsafe-inline` | CI CSP check |
| CSRF | `__Host-` cookie, `SameSite=Lax`, token double-submit cho mutation | e2e |
| SSRF (webhook, DNS check) | allowlist scheme+port, chặn dải IP riêng (RFC1918, 169.254.x) | unit |
| Upload độc hại | magic byte, giới hạn 10MB, re-encode sharp, bucket private → public | unit |
| Nhồi mật khẩu | Argon2id, rate limit theo IP + theo tài khoản, MFA cho Owner/Admin | k6 |
| Replay webhook | `provider_event_id UNIQUE` + kiểm timestamp ±5 phút | unit |
| Đơn trùng | `Idempotency-Key` | integration |
| Giá bị giả mạo | tính lại 100% phía server | integration |
| Rò secret qua log | logger redact `password|token|authorization|cookie|card` | unit |
| Secret trong source | `gitleaks` chạy trong CI, chặn merge | CI |
| Lỗ hổng phụ thuộc | `pnpm audit` + Dependabot, chặn High/Critical | CI |
| Nhân viên nền tảng tò mò | support access có thời hạn + audit + email báo khách | thủ công |

Header bắt buộc (đặt ở Caddy, không ở app — app quên thì Caddy không quên):
```
Strict-Transport-Security: max-age=31536000; includeSubDomains
Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-...';
                         img-src 'self' data: https://cdn.nentang.vn; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), microphone=(), camera=()
```

CSP có `nonce` → Next.js phải chạy ở chế độ nonce. Nếu quá tốn thời gian, `[CẮT-V1]` cho phép `script-src 'self'` không nonce, **nhưng tuyệt đối không `unsafe-inline`**.

---

## 9. Xuất và xóa dữ liệu

Cam kết hợp đồng: *"Khách hàng sở hữu tên miền, nội dung và dữ liệu kinh doanh. Dữ liệu có thể được xuất khi chấm dứt dịch vụ."*

Vì vậy phải có, không phải là tùy chọn:

- `POST /export` (Owner + step-up auth) → job nền → ZIP gồm `products.csv`, `orders.csv`, `customers.csv`, `media/`.
- Link tải **presigned, hết hạn sau 24h**, gửi qua email đã xác minh.
- Ghi `audit_logs` với `action='data.export'`.
- Suspend shop → dữ liệu **nguyên vẹn**, chỉ storefront trả trang thông báo. Không xóa.
- Chấm dứt hợp đồng → giữ 90 ngày → xóa cứng theo quy trình có phê duyệt hai người.

Tự động hóa `/export` ngay từ đầu. Làm thủ công cho 10 khách thì được; đến khách thứ 30 nó sẽ chiếm cả buổi chiều của bạn.
