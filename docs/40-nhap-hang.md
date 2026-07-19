# 40 — Nhập hàng: nhà cung cấp + phiếu nhập + kiểm kê (0085)

Chủ shop quản lý **nhà cung cấp (NCC)**, lập **phiếu nhập** (purchase order), và khi hàng về thì
**NHẬN HÀNG** — một thao tác nguyên tử cộng tồn kho + cập nhật **giá vốn bình quân gia quyền**.
Phần **kiểm kê** (stocktake) đối chiếu tồn hệ thống với đếm thực tế. Thiết kế qua workflow
(recon + 2 bản thiết kế song song + blueprint + 3 lăng kính red-team); 3 must-fix đã áp.

Toàn bộ tính năng dùng perm **`inventory.manage`** (CHỈ owner + admin — giá nhập và thông tin
NCC là **bí mật kinh doanh**, y như `reports.read`/`variant_costs`; catalog_manager và
order_manager bị 403 ngay ở dispatcher).

## Nối 2 bất biến cốt lõi — KHÔNG mở đường mới

- **TỒN (0009)**: `receive()` đổi `on_hand` ⇒ ghi **đúng 1 dòng** `inventory_ledger`
  `kind='receive'` cùng transaction → bất biến `Σ(ledger.delta) == on_hand` giữ nguyên. Kiểm kê
  ghi `kind='adjust'`. **KHÔNG thêm kind mới, KHÔNG đụng `inventory_ledger`** (append-only 0009).
  Mirror y hệt đường restock-RMA (orders.js): `INSERT inventory_levels ON CONFLICT DO NOTHING`
  → `FOR UPDATE` khoá → `on_hand +=` → ghi ledger. Khoá theo **thứ tự `variant_id`** (chống deadlock).
- **GIÁ VỐN (0081)**: `receive()` UPSERT `variant_costs` theo **bình quân gia quyền di động**.
  `variant_costs` là **nguồn giá vốn hiện hành duy nhất**; checkout + đơn tay đã snapshot nó vào
  `order_lines.unit_cost_vnd` lúc đặt → `reports.js` **tự** hưởng giá vốn mới cho đơn **tương lai**.
  **KHÔNG hồi tố** đơn cũ, **KHÔNG sửa** reports.js.

## Bình quân gia quyền di động (moving weighted-average)

```
cost_mới = (cost_cũ == NULL || on_hand_cũ <= 0)
             ? giá_nhập                                       -- không có cơ sở để bình quân
             : round( (on_hand_cũ*cost_cũ + qty*giá_nhập) / (on_hand_cũ + qty) )
```

- `cost_cũ == NULL` = **"không biết"** → lấy thẳng giá nhập lô này. **Tuyệt đối không coi NULL là 0**
  (nếu bình quân với 0 sẽ kéo giá vốn xuống sai). Kể cả khi có tồn (`on_hand_cũ > 0`) mà cost NULL:
  vẫn lấy giá nhập, vì không thể bình quân với ẩn số.
- `on_hand_cũ <= 0` (kho rỗng/âm) → không có lượng để bình quân → lấy giá nhập.
- Hàng tặng (`giá_nhập = 0`) hợp lệ: kéo bình quân xuống đúng bản chất kế toán.

## Chứng từ TERMINAL — cưỡng chế "không sửa sau khi chốt"

Phiếu `received` (đã nhận) và `cancelled` = **trạng thái cuối**. Mọi mutation (sửa header/dòng,
`order`, `receive`, `cancel`) đều `SELECT ... FOR UPDATE` rồi **guard status DƯỚI khoá** (chống
TOCTOU — như `shipOrder` "đơn đã giao không giao lại"): nhận-2-lần / huỷ-đã-nhận / sửa-đã-nhận đều
409. `inventory_ledger` append-only (0009) là **backstop DB** cho bất biến tồn; bản thân phiếu
**không cần REVOKE** (sửa được tự do khi còn draft/ordered). Không trigger.

Vòng đời: `draft` → (`order`) → `ordered` → (`receive`) → **`received`**.
`draft`/`ordered` → (`cancel`) → **`cancelled`**. Nhận được từ cả `draft` (shop nhỏ bỏ qua bước
"đã đặt") lẫn `ordered`.

## 3 must-fix red-team (đã áp)

1. **TOCTOU** — mọi mutation phiếu khoá `SELECT status FOR UPDATE` **trước** khi kiểm trạng thái,
   serialize các thao tác đồng thời trên cùng phiếu (nhận 2 request song song → 1 thắng, 1 nhận 409).
2. **Counter phiếu** — `po_number`/`stocktake_number` cấp qua **`INSERT ... ON CONFLICT DO UPDATE`
   upsert** (bẫy 0-rows của phiếu đầu tiên mỗi shop, giống `order_number`).
3. **Perm riêng `inventory.manage`** (owner + admin) — KHÔNG tái dùng `catalog.write` (catalog_manager
   không được thấy giá nhập/NCC). Gating ở dispatcher như mọi route seller.

**Chống lost-update giá vốn**: `receive()` khoá cả `variants FOR UPDATE OF v` khi đọc `cost_cũ` →
serialize với `catalog.updateVariant` (cũng khoá `variants` khi ghi `variant_costs`). Hai luồng ghi
cùng `variant_costs` không đè nhau.

## Bí mật kinh doanh — cô lập bằng grant, không chỉ RLS

5 bảng (`suppliers`, `purchase_orders`, `purchase_order_lines`, `stocktakes`, `stocktake_lines`):
RLS **FORCE** + policy `tenant_isolation` + **GRANT CRUD CHỈ `app_rw`**. Không cấp gì cho
`app_store`/`app_checkout`/`app_customer`/`app_expiry`/`app_tls` — giá nhập + NCC không rò ra bề mặt
công khai. RLS lọc **dòng** không lọc **cột**, nên phải zero-grant ở tầng bảng (schema-invariants
kiểm ĐỘNG mọi vai login `app_*` trừ `app_rw` có 0 quyền trên 5 bảng này).

## Composite FK — chống tham chiếu chéo shop

`purchase_orders (shop_id, supplier_id) → suppliers (shop_id, id)` RESTRICT (NCC có phiếu không xoá
cứng → dùng `is_active=false` để ẩn). `purchase_order_lines (shop_id, po_id) → purchase_orders`
CASCADE + `(shop_id, variant_id) → variants`. Mọi FK bao gồm `shop_id` (schema-invariant cưỡng chế).

## Snapshot title/sku trên dòng phiếu

`purchase_order_lines.title_snapshot/sku_snapshot` ghi lúc thêm dòng (join products+variants) →
hiển thị phiếu không cần join sống + chống **pool-reuse (0041)** map lại `variant_id` sau khi nhận.
Nhận được vào **cả SP nháp/ẩn** (không đòi `product.status='active'`) — nhập kho trước, bán sau.

## API (perm `inventory.manage`)

```
POST   /shops/:id/suppliers                         tạo NCC
GET    /shops/:id/suppliers[?q=&all=1]              liệt kê (mặc định chỉ active)
GET    /shops/:id/suppliers/:sid                     chi tiết + 20 phiếu gần nhất
PATCH  /shops/:id/suppliers/:sid                     sửa + bật/tắt is_active

POST   /shops/:id/purchase-orders                    tạo draft {supplier_id, note?, lines[]}
GET    /shops/:id/purchase-orders[?status=]          liệt kê
GET    /shops/:id/purchase-orders/:pid               chi tiết + dòng + on_hand hiện tại
PATCH  /shops/:id/purchase-orders/:pid               sửa header/thay toàn bộ dòng (draft/ordered)
POST   /shops/:id/purchase-orders/:pid/order         draft → ordered
POST   /shops/:id/purchase-orders/:pid/receive       → received (NGUYÊN TỬ: tồn + giá vốn)
POST   /shops/:id/purchase-orders/:pid/cancel        draft/ordered → cancelled

GET    /shops/:id/purchasable-variants[?q=]          chọn biến thể (gồm SP nháp/ẩn) + giá vốn
GET    /shops/:id/purchasing/report[?from&to]        tổng nhập theo kỳ + theo NCC + theo SP

POST   /shops/:id/stocktakes                          tạo phiên {scope:'all'|'list', variant_ids?}
GET    /shops/:id/stocktakes                          liệt kê
GET    /shops/:id/stocktakes/:sid                     chi tiết + dòng (system_qty / counted / on_hand_now)
PATCH  /shops/:id/stocktakes/:sid                     ghi số đếm {counts:[{variant_id, counted_qty}]}
POST   /shops/:id/stocktakes/:sid/complete            chốt → điều chỉnh tồn + ledger 'adjust'
POST   /shops/:id/stocktakes/:sid/cancel              huỷ phiên (không đụng tồn)
```

## Kiểm kê — chốt 2 lượt, chặn đếm < đang-giữ

`createStocktake` chụp `system_qty = on_hand` lúc tạo (tham chiếu). Đếm ghi vào `counted_qty`
(NULL = chưa đếm). `completeStocktake` chốt dưới `FOR UPDATE`, **2 lượt** (chỉ dòng đã đếm):
- **Lượt 1** (thứ tự `variant_id`): khoá `inventory_levels`, đọc `on_hand` **sống** + `reserved`.
  **CHẶN nếu `counted_qty < reserved`** → 409 (đặt `on_hand < reserved` vi phạm CHECK 0009; phải
  huỷ/giao đơn đang giữ hàng trước).
- **Lượt 2**: `on_hand = counted_qty`; ghi **đúng 1** ledger `kind='adjust'` `delta = counted − live`
  (bỏ qua nếu delta=0 — không rác ledger); **ghi đè `system_qty = on_hand sống`** (chứng từ phản ánh
  cơ sở chênh thực, không phải snapshot cũ lúc tạo). Bất biến `Σledger==on_hand` giữ nguyên.

`scope='all'` chụp mọi biến thể không mồ côi; **>500 → 422** (chia lô). `counted`/`complete`/`cancel`
chỉ khi status `counting` (guard dưới `FOR UPDATE`); phiên `completed`/`cancelled` = terminal.

Trần: ≤200 dòng/phiếu, qty 1–100.000, giá nhập 0–100 tỷ (khớp MAX_PRICE); `subtotal_vnd` cache
tính ở SQL (`bigint`, tránh tràn Number JS). Dòng trùng biến thể → 400 (gộp vào 1 dòng).

## Test

`schema-invariants` +2 (5 bảng zero-grant vai công khai / đủ CRUD app_rw) — tổng 27 xanh.
`purchasing.e2e` 50: NCC CRUD + ẩn chặn phiếu; phiếu subtotal cache; nhận cộng tồn + 1 ledger
receive/dòng + Σledger==on_hand; giá vốn NULL→giá nhập, bình quân gia quyền di động,
on_hand-cũ-0→giá nhập; terminal 409×3; phiếu rỗng 400; purchasable gồm SP nháp + giá vốn;
kiểm kê snapshot→đếm→chốt adjust ledger + system_qty ghi đè, chặn counted<reserved 409, terminal
409, scope=all; báo cáo nhập theo kỳ/NCC/SP; RBAC order_manager 403; IDOR chéo-shop 404.

## Giao diện (seller-admin BFF, no-JS + CSP nghiêm)

Nav thêm **"Nhập hàng"** + **"Kiểm kê"** (owner/admin — INVENTORY_ROLES; seller cưỡng chế
`inventory.manage`, ẩn nav chỉ là mỹ quan). Khu Nhập hàng có thanh tab phụ (Phiếu nhập · Nhà
cung cấp · Kiểm kê · Báo cáo). Trang: danh sách/chi tiết phiếu; form tạo/sửa phiếu (chọn NCC +
slot biến thể/SL/giá nhập, tìm hàng `?q=` không dấu); **trang xác nhận nhận hàng** (preview
tồn-nay → tồn-sau + cảnh báo không hoàn tác); NCC list + form tạo/sửa/ẩn; kiểm kê list + form
đếm (ô số/dòng) + chốt/huỷ; báo cáo nhập. Mọi POST qua `sameOrigin` (CSRF); slot dùng
`variant_id[]/qty[]/unit_cost[]` song song (getAll). 403 seller → trang lỗi rõ ràng.

Test BFF: `admin-purchasing.e2e` 17 (nav, tạo NCC, tạo phiếu→nhận (tồn 5→15, vốn 50k), kiểm kê
scope=all→đếm lệch→chốt (tồn 15→14, ledger adjust −1), RBAC order_manager 403, CSRF 403).

## Cắt v1 → v2

Nhiều kho/địa điểm (hiện MỘT kho) · nhận **một phần** phiếu (hiện nhận trọn) · công nợ NCC/thanh
toán phiếu · nhập từ file CSV · gợi ý nhập theo tồn tối thiểu · barcode/quét mã lúc đếm.
