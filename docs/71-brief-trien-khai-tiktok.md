# 71 — Brief triển khai: nhập từ TikTok Shop

> **Tài liệu này để ĐƯA CHO NGƯỜI/AI KHÁC thi công.** Nó **tự chứa**: đọc xong là làm được mà
> không cần hỏi lại, không cần đọc `CLAUDE.md`.
>
> **Vì sao (lý do, số đo, cái giá của từng lựa chọn) nằm ở [`70-nhap-tu-tiktok-shop.md`](70-nhap-tu-tiktok-shop.md).**
> File 70 là *quyết định*, file 71 là *thi công*. Mâu thuẫn giữa hai file ⇒ **70 thắng**.
>
> Người thi công **không được tự đổi quyết định trong 70**. Thấy quyết định sai thì **dừng lại
> và nói ra**, đừng lặng lẽ làm khác — mọi mục trong 70 đều có số đo đứng sau.

---

## 0. Luật của kho này — ĐỌC TRƯỚC, VI PHẠM LÀ CỔNG ĐỎ

Đây không phải phong cách cá nhân. Mỗi dòng dưới đây có cơ chế tự động chặn.

| luật | hậu quả nếu phá |
|---|---|
| **Toàn bộ mã, chú thích, commit, tài liệu bằng TIẾNG VIỆT** | không có chú thích tiếng Anh trong file tiếng Việt. Đây là quy ước tuyệt đối của kho |
| **Không framework web.** HTTP thuần `node:http`, routing viết tay, HTML nối bằng template literal | thêm express/fastify là sai kiến trúc (ADR-001) |
| **ESM** (`"type": "module"`), **Node ≥ 22**, test bằng `node --test` | không dùng CommonJS, không jest/mocha/vitest |
| **Không eslint/prettier** — bám phong cách file xung quanh | đừng chạy formatter lên file có sẵn |
| **Migration BẤT BIẾN** | runner băm nội dung file. Sửa file `.sql` cũ ⇒ `DRIFT` ⇒ cổng đỏ. Sửa gì cũng bằng **file mới đánh số tiếp** |
| **Thêm/bớt bộ test ⇒ phải sửa `MANIFEST_UNIT_COUNT` / `MANIFEST_E2E_COUNT`** trong `scripts/test-manifest.sh` **cùng commit** | nó so **BẰNG**, không phải ≥. Quên là cổng đỏ |
| **Chú thích nói *vì sao*, kèm *số đo thật* và *hậu quả nếu làm khác*** — không nói "hàm này làm gì" | đọc `packages/orders/src/owed.js` để thấy chuẩn. Chú thích ở kho này thường **dài hơn mã**, và đó là cố ý |
| **Giờ `Asia/Ho_Chi_Minh`** ở mọi chỗ hiển thị và mọi biên lọc theo ngày | container chạy UTC, quên `timeZone` là lệch một ngày mà test không thấy |
| **Mọi truy vấn tenant chạy trong `withTenant(shopId, fn)`** | RLS lọc theo `current_shop_id()`. Truy vấn ngoài nó = không thấy dòng nào hoặc rò chéo shop |
| **`GRANT` mở CỘT, `POLICY` mở DÒNG** | bảng mới phải có **cả hai**, và phải `REVOKE` cho vai không cần |
| **`ALTER DEFAULT PRIVILEGES` (0003) tự cấp CRUD cho `app_rw` trên MỌI bảng mới** | "tôi không viết GRANT" ≠ "vai đó không có quyền" |

### 0.1 Cách chạy kiểm chứng

```bash
# một bộ unit lẻ — chạy thẳng ở máy, KHÔNG cần Docker
node --test apps/seller/test/<ten>.test.js

# cổng nhanh (~3 phút, BỎ e2e) — cần Docker
bash scripts/ci-local.sh --fast

# CỔNG ĐẦY ĐỦ (~45 phút) — CHỈ lệnh này exit 0 mới được nói "xanh"
bash scripts/ci-local.sh
```

> **Nếu bạn KHÔNG chạy được Docker: nói rõ ra.** Đừng viết "đã test xong". Ở kho này *"đã test,
> xanh"* mà không chạy cổng đã từng có nghĩa là một CVE sống nhiều ngày trong khi vẫn được báo
> là xanh. Viết unit test và chạy `node --test` thì được — nó không cần Docker.

---

## 1. Bối cảnh trong 10 dòng

Kho là SaaS bán hàng cho shop nhỏ Việt Nam (`nentang.vn`). Có sẵn chức năng **nhập danh mục từ
sàn khác** (`docs/45`), thiết kế quanh định dạng **Shopify/Haravan**, và nó **chạy đúng** — đã
kiểm chứng trên PostgreSQL thật:

> tệp mẫu 4 dòng → **2 sản phẩm · 4 biến thể · 2 trục (Màu+Size)** · tổ hợp `Đen/M` `Đen/L`
> `Trắng/M` · giá cấp SP = min nhóm.

**Việc cần làm: dạy nó đọc thêm định dạng TikTok Shop.** Không viết lại bộ nhập.

Hôm nay đẩy file TikTok thật vào cho kết quả: **641 nhóm, tạo được 0, hỏng 641**, lý do
`SKU trống hoặc quá dài` — vì TikTok không có cột `handle` và cột `seller_sku` rỗng 100%.

---

## 2. Dữ liệu vào — TikTok xuất ra cái gì

### 2.1 Cách người bán lấy file

TikTok Seller Center → Sản phẩm → Batch Tool → Bulk Edit Products → chọn sản phẩm →
Download Template → **All information** → Generate → Download. Ra file **`.xlsx`**.

### 2.2 Hình dạng file — 5 dòng tiêu đề, dữ liệu từ dòng 6

| dòng | nội dung |
|---|---|
| 1 | **khoá máy** — `product_id`, `category`, `product_name`, … ← **dùng dòng này làm tiêu đề** |
| 2 | phiên bản: `V4` · `All_Information` · `metric` |
| 3 | nhãn tiếng Việt: `ID sản phẩm`, `Hạng mục`, … |
| 4 | `Bắt buộc` / `Không bắt buộc` / `Bắt buộc có điều kiện` |
| 5 | hướng dẫn dài |
| **6+** | **dữ liệu thật** |

⚠️ Bộ nhập hiện tại coi **dòng 1 = tiêu đề, dòng 2+ = dữ liệu**. Áp thẳng vào file TikTok thì
4 dòng meta thành 4 sản phẩm rác. **Phải dò dòng tiêu đề**, không đóng cứng.

### 2.3 36 cột, và cột nào THẬT SỰ có dữ liệu

Đo trên file thật: **641 dòng · 124 sản phẩm · 5,2 SKU/sản phẩm**.

```
100%  product_id  sku_id  variation_value  product_name  product_description
      category  price  quantity  parcel_weight  main_image
 99.8% cod                          (giá trị: 'Y')
 90.0% image_2
 41.7% image_3
 39.6% product_property/100701      (Vật liệu — DUY NHẤT một giá trị: 'Phủ kim loại')
  8.1% image_4
  2.5% product_property/100149 (Xuất xứ) · /101489 · /101490
  1.9% image_5     1.2% image_6
  0.8% product_property/100445
   0%  seller_sku ⚠  brand  parcel_length  parcel_width  parcel_height
       image_7  image_8  image_9  size_chart  special_product_listing_type
       auction_starting_price  + 6 product_property khác
```

**Cột 0% không phải "hiếm" — là KHÔNG TỒN TẠI.** Đừng thiết kế dựa vào chúng.

### 2.4 Dữ liệu mẫu THẬT — dùng đúng cái này để viết test

**Sản phẩm 1 trục (7 SKU)** — `product_id` lặp lại ở mọi dòng, mọi trường cấp sản phẩm giống hệt:

```json
{ "product_id": "1731037612150720606",
  "category": "Vòng tay & Lắc tay (605274)",
  "product_name": "Vòng tay ống kiểu lưới, đồng vàng, có kí hiệu [ảnh thực tế]",
  "sku_id": "1731037645341100126",
  "variation_value": "48",
  "product_description": "<p>Trang sức cao cấp - chất liệu đồng vàng<br>+ KHÔNG ĐEN<br>+ KHÔNG TEN KHÔNG TRÓC TRẮNG<br>+ KHÔNG HÚT NAM CHĂM<br>- Ảnh thực tế chụp bằng điện thoại<br></p>",
  "price": "450000", "quantity": "49", "parcel_weight": "200", "cod": "Y",
  "main_image": "https://p16-oec-va.ibyteimg.com/tos-maliva-i-o3syd03w52-us/a3a50776…",
  "image_2": "https://p16-oec-va.ibyteimg.com/…", "image_3": "https://p16-oec-va.ibyteimg.com/…" }
```
Sáu dòng còn lại chỉ khác `sku_id` và `variation_value`: `50` `52` `54` `56` `58` `60`.

**Sản phẩm 2 trục (16 SKU)** — phân cách là `", "` (phẩy + khoảng trắng):

```json
{ "product_id": "1731277253352720478",
  "category": "Dây chuyền (605280)",
  "product_name": "Dây chuyền trúc bọng 3c, đồng vàng có kí hiệu",
  "sku_id": "1734823571014976606",
  "variation_value": "45cm, 45cm",
  "price": "550000", "quantity": "49", "parcel_weight": "200", "cod": "Y",
  "product_property/100149": "Không", "product_property/101489": "Dây chuyền" }
```
16 tổ hợp: `45cm, 45cm` … `60cm, 60cm`.

**Giá trị `variation_value` gai góc có thật trong file — test phải phủ:**

```
'48'                'A'  số trần
'50cm (vừa cổ)'     'B'  có ngoặc
'50cm (vừa cồ)'     'C'  LỖI CHÍNH TẢ của người bán, khác 'B' một dấu — hai giá trị riêng
'48 tay đo 14cm'    'D'  văn bản dài, KHÔNG có dấu phẩy ⇒ MỘT trục
'48 / 14cm'         'E'  có dấu '/' nhưng CÙNG NGHĨA với 'D' ⇒ vẫn MỘT trục
'45cm, 45cm'        'F'  có ', ' ⇒ HAI trục
'1 chỉ, Ni 5'       'G'  có ', ' ⇒ HAI trục
```

> **`/` KHÔNG phải ký tự phân cách.** Đo được: `:` 0 lần, `;` 0 lần, `|` 0 lần trên 641 dòng.
> Chỉ `", "` mới là phân cách trục, và **cũng chỉ là suy đoán** — xem §4.3.

---

## 3. Đích đến — bộ nhập hiện có nhận hình dạng nào

**Đây là hợp đồng quan trọng nhất của cả brief.** Adapter chỉ được trả về **đúng** hình dạng
dưới đây; **không sửa `buildProduct`, `groupRows`, `mapRow`** trong `apps/seller/src/import.js`.

### 3.1 Khoá chuẩn mà `import.js` đã hiểu

| khoá | bắt buộc | ý nghĩa |
|---|---|---|
| `handle` | không* | **khoá gộp**: các dòng cùng `handle` = một sản phẩm. Không có cột này ⇒ mỗi dòng một sản phẩm |
| `title` | có (dòng đầu nhóm) | tên sản phẩm, < 255 ký tự |
| `description` | không | mô tả — **văn bản thuần**, không phải HTML (§4.2) |
| `status` | không | `active` \| `draft`. **Mặc định `draft`** |
| `category` | không | đường dẫn danh mục phân cách `>`, **tối đa 2 cấp** |
| `option1_name` … `option3_name` | không | tên trục: `Màu`, `Size` |
| `option1_value` … `option3_value` | không | giá trị trục **của dòng này** |
| `sku` | **có** | mã biến thể, **duy nhất trong shop** |
| `price_vnd` | **có** | giá bán |
| `compare_at_price_vnd` | không | giá gạch ngang — **phải > `price_vnd`** |
| `cost_vnd` | không | giá vốn |
| `stock` | không | tồn ban đầu, mặc định 0 |
| `weight_gram` | không | cân nặng **tính bằng GRAM** |
| `image_url` | không | ảnh **của dòng này**; thư viện = hợp các ảnh mọi dòng trong nhóm, theo thứ tự dòng |

\* Với TikTok **bắt buộc phải sinh `handle`** từ `product_id`, nếu không mỗi SKU thành một
sản phẩm riêng (đúng lỗi đang xảy ra hôm nay).

### 3.2 Quy tắc gộp mà `import.js` đang áp — đọc để khỏi làm trùng

1. Nhóm theo `handle` đã chuẩn hoá.
2. Thông tin cấp sản phẩm lấy từ **dòng đầu tiên có `title`**; dòng sau **bị bỏ qua chứ không
   ghi đè**.
3. Tên trục trong một nhóm **phải nhất quán**; lệch ⇒ **cả nhóm bị từ chối** kèm số dòng.
4. Giá cấp sản phẩm = **min** trong nhóm.
5. Trần: **100 biến thể/sản phẩm**.
6. Nhóm lỗi ⇒ **bỏ cả nhóm**, nhóm khác vẫn vào.

### 3.3 Điểm vào HTTP

```
POST /shops/:shopId/products/import        (quyền: catalog.write, maxBody 2MB)
body: { rows: [ {...}, ... ], dry_run: true|false }
```

`dry_run: true` trả về (không ghi gì, không tải ảnh):

```json
{ "dry_run": true, "rows": 641, "groups": 124, "created": 124, "variants": 641,
  "images": { "queued": 299, "invalid": 0 },
  "failed": 0, "errors": [], 
  "preview": [ { "title": "...", "slug": "...", "variants": 7, "axes": ["Phân loại"], "category": "..." } ],
  "columns": { "recognised": [{"header":"...","field":"..."}], "ignored": ["..."] } }
```

---

## 4. ĐỢT 1 — Đọc được file `.xlsx`

**Mục tiêu đo được:** tải file TikTok thật lên → Xem trước báo **124 sản phẩm / 641 biến thể /
0 lỗi**. Chưa ghi gì vào DB. *(Hôm nay: 641 nhóm / 0 tạo được.)*

### 4.1 File mới: `apps/seller/src/xlsx-read.js`

**Zero-dep.** Không thêm `xlsx`/`SheetJS`/`exceljs`. Lý do: kho gần như không có phụ thuộc
runtime, Dockerfile dùng `npm ci`, và `apps/seller/src/zip.js` đã tự ghi định dạng ZIP bằng
`zlib.deflateRawSync` với đúng lập luận này. Chiều đọc dùng `zlib.inflateRawSync` (có sẵn).

**Chỉ cần 3 tệp trong gói xlsx:**

```
xl/workbook.xml              → tên sheet + thứ tự
xl/worksheets/sheet1.xml     → ô dữ liệu:  <row r="6"><c r="A6" t="s"><v>12</v></c>…</row>
xl/sharedStrings.xml         → bảng chuỗi:  <si><t>Vòng tay…</t></si>
```

Ô có `t="s"` ⇒ `<v>` là **chỉ số vào `sharedStrings`**. Không có `t` ⇒ `<v>` là số. `t="inlineStr"`
⇒ chuỗi nằm ngay trong `<is><t>`.

**Ô rỗng bị BỎ QUA hoàn toàn trong XML** — `<row>` nhảy từ `A6` sang `C6`. Phải đọc thuộc tính
`r` của `<c>` để biết cột, **không** đếm tuần tự. Bỏ qua điều này là lệch cột toàn bộ file.

> **Không viết bộ phân tích XML tổng quát.** Chỉ cần bộ quét theo thẻ cho `<row>` `<c>` `<v>`
> `<t>` `<is>`. Hẹp hơn, kiểm hết được, và không có chỗ cho thực thể ngoài.

### 4.2 Sáu hàng rào bắt buộc — tệp đến từ NGƯỜI LẠ

Kho có tự đăng ký shop công khai, nên file tải lên là **input của người lạ trên Internet**.
Viết module này với thái độ như `packages/net-guard`, không phải như một hàm tiện ích.

| # | hàng rào | chặn |
|---|---|---|
| 1 | trần **tổng kích thước sau giải nén** (đề nghị 200 MB) **và** tỉ lệ nén tối đa **1:100** | zip bomb |
| 2 | trần **số entry** trong gói | zip triệu tệp rỗng |
| 3 | chuẩn hoá đường dẫn entry, **từ chối** `..` và đường tuyệt đối | zip-slip |
| 4 | **từ chối** nội dung chứa `<!DOCTYPE` hoặc `<!ENTITY`; không bao giờ giải thực thể ngoài | XXE / billion laughs |
| 5 | chỉ đọc **đúng 3 tệp** ở §4.1, bỏ qua phần còn lại | giảm mặt tấn công |
| 6 | trần **số dòng / số cột** kiểm **trước khi** cấp phát mảng | OOM |

Ngoài ra: kiểm **magic byte `PK\x03\x04`** trước khi làm gì — đuôi `.xlsx` không chứng minh gì.

> **Đường lùi:** nếu module vượt ~400 dòng, **dừng lại và báo**, đừng cố. Khi đó mới cân nhắc
> thêm thư viện — kèm ghim phiên bản và đưa vào `scripts/security-scan.sh`. Biết trước: SheetJS
> có lịch sử CVE (prototype pollution, ReDoS) đúng ở đường nhận tệp từ người lạ.

### 4.3 Dò dòng tiêu đề

```
Quét tối đa 20 dòng đầu. Dòng tiêu đề = dòng đầu tiên chứa ÍT NHẤT MỘT trong:
    product_id · handle · sku_id · seller_sku · Variant SKU
Dữ liệu bắt đầu từ dòng NGAY SAU dòng tiêu đề, BỎ QUA các dòng meta
(dòng có ô đầu là 'V4' hoặc ô nào bằng 'Bắt buộc' / 'Không bắt buộc' / 'Không thể chỉnh sửa').
```

Cách chắc chắn hơn cho TikTok: sau khi thấy dòng tiêu đề, **bỏ mọi dòng cho tới khi gặp dòng có
`product_id` khớp `^\d{10,}$`**. File thật cho `product_id` là số 19 chữ số.

### 4.4 Sửa file có sẵn

| file | sửa gì |
|---|---|
| `apps/seller-admin/src/pages.js` (~dòng 3477 và 3607) | `accept=".csv,text/csv"` → thêm `.xlsx` và MIME `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| `apps/seller-admin/src/server.js` (~dòng 1402, 1426) | đang gọi `parseCsv(file.bytes.toString('utf8'))`. Rẽ nhánh: magic byte `PK` ⇒ `xlsx-read`, còn lại ⇒ `parseCsv` |
| `apps/seller/src/import.js:25` | `IMPORT_MAX_ROWS = 1000` → **`IMPORT_MAX_PRODUCTS = 1000`**, đếm theo **sản phẩm** |
| `apps/seller/src/import.js:388` | đổi chốt trần cho khớp |
| `apps/seller-admin/src/server.js` | **chia lô** — xem §4.5 |

### 4.5 Chia lô ở BFF — BẮT BUỘC, có số đo

| số đo | giá trị |
|---|---|
| 641 dòng TikTok → JSON | **1,32 MB** (lọt trần `maxBody` 2 MB) |
| 5.000 SP (~25.847 dòng) → JSON | **~53 MB** — vượt trần **26 lần** |

⇒ BFF phải cắt thành nhiều lượt gọi. **Cắt đúng ranh giới `product_id`.**

> Cắt giữa một sản phẩm là **xé nhóm biến thể**: lô 1 nhận 4 SKU, lô 2 nhận 3 SKU còn lại, ra
> **hai sản phẩm cùng tên** mỗi cái thiếu SKU — và **không lỗi nào báo**. Đây là lớp lỗi tệ nhất:
> im lặng và trông như thành công.

Cộng dồn kết quả các lô rồi hiện **một** bảng tổng cho người bán.

### 4.6 Nghiệm thu đợt 1

- [ ] file TikTok thật → Xem trước **124 sản phẩm / 641 biến thể / 0 lỗi**
- [ ] 5 dòng tiêu đề **không** thành sản phẩm *(hôm nay ca lưu-thẳng-CSV ra 645 thay vì 641)*
- [ ] file `.csv` cũ chạy **y hệt**: 2 SP · 4 biến thể · 2 trục `Màu+Size` · `Đen/M` `Đen/L`
      `Trắng/M` · giá cấp SP 199.000₫
- [ ] zip bomb (tỉ lệ > 1:100) bị từ chối **trước khi** giải nén hết
- [ ] xlsx chứa `<!DOCTYPE` / `<!ENTITY` bị từ chối
- [ ] file đuôi `.xlsx` mà ruột không phải zip bị từ chối
- [ ] entry có `..` trong đường dẫn bị từ chối
- [ ] chia lô **không cắt giữa một `product_id`**

---

## 5. ĐỢT 2 — Adapter TikTok

**Mục tiêu:** 124 sản phẩm vào DB đúng, mô tả đọc được, ảnh không tải thừa.

### 5.1 File mới: `apps/seller/src/adapters/tiktok.js`

**Hàm thuần — không chạm DB, không chạm mạng.** Để `node --test` chạy được ở mọi commit mà
không cần Docker (cùng lý do `import-parse.js` đã tách ra).

```js
/** @param {object[]} rows  dòng thô, khoá = tiêu đề cột TikTok
 *  @param {{axisNames?: Record<string,string[]>, splitOff?: Set<string>}} opts
 *         axisNames: product_id → tên trục do NGƯỜI BÁN đặt
 *         splitOff:  product_id mà người bán TẮT tách trục
 *  @returns {{ rows: object[], axisHints: {productId, name, count, sample}[] }} */
export function adaptTiktok(rows, opts = {}) { … }
```

`rows` trả về dùng **đúng khoá chuẩn §3.1**. `axisHints` để màn Xem trước hỏi tên trục.

### 5.2 Bảng ánh xạ — làm ĐÚNG từng dòng

| cột TikTok | → khoá chuẩn | quy tắc |
|---|---|---|
| `product_id` | `handle` | dùng thẳng. **Đây là thứ sửa lỗi 641-nhóm** |
| `product_name` | `title` | cắt 255 |
| `product_description` | `description` | **HTML → văn bản thuần** (§5.3) |
| `category` | `category` | bỏ ` (\d+)` ở đuôi → `Vòng tay & Lắc tay`. **1 cấp, KHÔNG bịa cấp cha** |
| `price` | `price_vnd` | dùng `parseAmount()` có sẵn ở `import-parse.js`. **Không nhân/chia gì** |
| `quantity` | `stock` | số nguyên ≥ 0 |
| `parcel_weight` | `weight_gram` | ⚠️ **ĐÃ LÀ GRAM. TUYỆT ĐỐI KHÔNG nhân 1000.** Vòng tay = `200` = 200g. Nhân lên thành 200kg ⇒ sai phí ship ⇒ **sai tiền** |
| `variation_value` | `option1_value` (+`option2_value`) | tách `", "` — §5.4 |
| *(không có nguồn)* | `option1_name` | **người bán nhập**, mặc định `Phân loại` |
| `main_image`, `image_2..9` | `image_url` | xoay ngang→dọc + **khử trùng** — §5.5 |
| *(sinh)* | `sku` | §5.6 |
| `sku_id` | — | **không** vào `variants.sku`; để đợt 3 ghi vào bảng tham chiếu |
| `cod`, `brand`, `parcel_length/width/height`, `size_chart`, `product_property/*` | — | **bỏ qua ở đợt này** |

### 5.3 File mới: `apps/seller/src/html-to-text.js`

**Vì sao bắt buộc:** 641/641 mô tả là HTML. Storefront render qua `formatDesc`
(`apps/storefront/src/theme.js:2460`) và hàm đó **`esc()` toàn bộ** — cố ý, chống XSS. Nhập thô
vào thì **khách nhìn thấy chữ `<p>` và `<br>`** trên trang sản phẩm. Không phải lỗ bảo mật, mà
là **100% sản phẩm hỏng mô tả** ngay lần nhập đầu.

`formatDesc` hiểu: dòng trống = đoạn mới; dòng bắt đầu `- ` hoặc `• ` = danh sách. Nên chuyển:

```
<br> <br/>          → \n
</p> </div>         → \n\n
<li>                → \n- 
</ul> </ol>         → \n\n
mọi thẻ còn lại     → bỏ (giữ nội dung bên trong)
&amp; &lt; &gt; &quot; &#39; &nbsp;  → ký tự thật
≥3 xuống dòng liên tiếp → còn 2
cắt khoảng trắng đầu/cuối
```

**`<img src="...">` — rút URL ra, KHÔNG bỏ:** trả về mảng riêng để adapter **xếp vào CUỐI** thư
viện ảnh (sau `main_image` và `image_2..9`). Ảnh trong mô tả là minh hoạ, không được cướp vị trí
ảnh bìa. Đo được: 4 thẻ / 1 URL riêng trên 641 dòng.

> Giữ nguyên thẻ `<img>` là **sai**: CSP nghiêm ngặt chặn tài nguyên ngoài, ảnh sẽ vỡ, và tạo
> phụ thuộc vĩnh viễn vào CDN TikTok cho một shop **đã rời TikTok**.

**Test bắt buộc:** `<script>alert(1)</script>` trong mô tả phải ra **văn bản thuần**, không còn
thẻ nào.

### 5.4 Tách trục từ `variation_value`

```
Trong một product_id:
  · KHÔNG dòng nào chứa ', '  ⇒ 1 trục, giá trị = nguyên chuỗi
  · CÓ dòng chứa ', '          ⇒ số trục = max(số ', ' + 1) trong nhóm
  · Dòng có ÍT phần hơn số trục của nhóm ⇒ TỪ CHỐI CẢ NHÓM kèm số dòng
    (import.js sẽ tự từ chối nếu thiếu giá trị trục — đừng tự vá bằng cách điền bừa)
  · product_id nằm trong opts.splitOff ⇒ ÉP 1 trục, giữ nguyên dấu phẩy
```

⚠️ **Dấu phẩy là SUY ĐOÁN, không phải luật.** `'Áo, quần'` là **một** giá trị, không phải hai
trục. Vì vậy:

- kết quả tách **phải hiện ra ở màn Xem trước** cho người duyệt;
- phải cho **tắt tách ở mức từng sản phẩm** (`opts.splitOff`);
- **không tự sửa** giá trị trông giống lỗi chính tả: `'50cm (vừa cổ)'` và `'50cm (vừa cồ)'` là
  **hai giá trị khác nhau**. Gộp hộ = mất một biến thể của người bán.

Trên file thật: **121 SP một trục, 3 SP hai trục**. Không SP nào có 3 trục.

### 5.5 Ảnh: xoay ngang→dọc + khử trùng

TikTok để 9 cột ảnh **trên một dòng**, và **mọi dòng của cùng sản phẩm lặp y hệt** (đo: 124/124
sản phẩm có `main_image` giống nhau ở mọi dòng).

```
Với mỗi product_id:
  gom main_image → image_2 → … → image_9 của MỌI dòng, theo thứ tự dòng
  KHỬ TRÙNG theo URL, giữ lần xuất hiện ĐẦU TIÊN
  gắn toàn bộ vào dòng ĐẦU của nhóm (import.js gom ảnh theo thứ tự dòng)
  ảnh rút từ mô tả (§5.3) xếp SAU CÙNG
```

**Số đo bắt buộc đạt:** 1.557 ô có URL → **299 URL riêng biệt**. Không khử trùng = tải thừa
**5,2 lần**, mỗi lượt là một lần chạm mạng qua hàng rào SSRF.

### 5.6 Sinh `sku` — cho NGƯỜI đọc, không phải cho máy

`seller_sku` rỗng 100% nên phải sinh. Nhưng `variants.sku` là thứ người bán **đọc trên phiếu
kho và vận đơn** — nhét `1731037645341100126` vào đó là biến trường của người thành rác máy.

```
sku = slug(rút gọn title, ≤ 24 ký tự) + '-' + slug(các giá trị trục nối bằng '-')
ví dụ: 'VONG-TAY-ONG-KIEU-LUOI-48'  ·  'DAY-CHUYEN-TRUC-BONG-45CM-45CM'
đụng độ trong shop ⇒ thêm hậu tố '-2', '-3', …
```

`sku_id` của TikTok đi vào bảng tham chiếu ở đợt 3, **không** vào `variants.sku`.

### 5.7 Nhận dạng nguồn: `apps/seller/src/adapters/index.js`

```
có cột product_id VÀ variation_value           → 'tiktok'
có cột handle HOẶC 'Variant SKU'               → 'shopify'   (đường hiện có, giữ nguyên)
còn lại                                        → 'chuẩn'     (tệp mẫu của kho)
```

### 5.8 Nghiệm thu đợt 2

- [ ] **124 sản phẩm · 641 biến thể · 0 nhóm bị từ chối**
- [ ] **299** lượt tải ảnh được xếp hàng — **không phải 1.557**
- [ ] **0/641** mô tả còn chứa `<` hoặc `&nbsp;`
- [ ] SP 16 SKU ra **2 trục**; SP 7 SKU ra **1 trục**
- [ ] `weight_gram` = **200** cho vòng tay — **không phải 200000**
- [ ] `sku` sinh ra **không trùng** trong shop và **đọc được** (không phải chuỗi 19 chữ số)
- [ ] `'50cm (vừa cổ)'` và `'50cm (vừa cồ)'` ra **hai giá trị trục riêng**
- [ ] `<script>` trong mô tả ra văn bản thuần

---

## 6. ĐỢT 3 — Lưu tham chiếu + màn hình

### 6.1 Migration mới: `packages/db/migrations/0148_product_source_refs.sql`

**Số `0148` — kiểm lại thư mục trước khi đặt tên, đừng trùng.** File migration **bất biến**:
đã áp rồi thì sửa gì cũng bằng file mới.

```sql
CREATE TABLE product_source_refs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id       uuid NOT NULL REFERENCES shops(id),
  source        text NOT NULL CHECK (source IN ('tiktok','shopify','haravan','sapo','shopee')),
  kind          text NOT NULL CHECK (kind IN ('product','variant','category')),
  external_id   text NOT NULL,
  product_id    uuid,
  variant_id    uuid,
  raw_row       jsonb,
  imported_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, source, kind, external_id),
  FOREIGN KEY (shop_id, product_id) REFERENCES products (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, variant_id) REFERENCES variants (shop_id, id) ON DELETE CASCADE
);

ALTER TABLE product_source_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_source_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON product_source_refs
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

REVOKE ALL ON product_source_refs FROM app_store, app_checkout, app_customer;
```

**Ba điều KHÔNG được bỏ:**
1. `ENABLE` **và** `FORCE` RLS — thiếu `FORCE` thì chủ bảng bỏ qua policy.
2. `POLICY` có **cả** `USING` lẫn `WITH CHECK`.
3. `REVOKE` — `ALTER DEFAULT PRIVILEGES` của `0003` đã tự cấp CRUD cho `app_rw` trên mọi bảng
   mới. Storefront/checkout/account **không có việc gì** với ID sàn ngoài.

Bất biến schema tự động sẽ kiểm: mọi bảng có `shop_id` phải có policy, và policy của `app_rw`
không được dùng biểu thức hằng `true`.

**KHÔNG thêm cột JSONB vào bảng `products`.** Nguyên tắc của kho là *`GRANT` mở CỘT*; một cột
JSON gộp mọi thứ làm mất kiểm soát theo cột, và đổ dữ liệu chưa kiểm của bên thứ ba vào bảng mà
44 module đang đọc.

### 6.2 Ghi tham chiếu + chống nhập trùng

Lúc commit, mỗi sản phẩm ghi 1 dòng `kind='product'` (`external_id = product_id`), mỗi biến thể
ghi 1 dòng `kind='variant'` (`external_id = sku_id`).

`UNIQUE (shop_id, source, kind, external_id)` là chốt: **nhập cùng file 5 lần vẫn ra một bộ sản
phẩm**. Trước khi tạo, tra bảng này; đã có ⇒ bỏ qua (chế độ `create_only`) hoặc cập nhật (đợt 4).

### 6.3 Màn Xem trước: `apps/seller-admin/src/pages.js`

Thêm vào màn đã có (`mode=preview` / `mode=commit` đã chạy sẵn):

| thành phần | nội dung |
|---|---|
| ô **đặt tên trục** cho mỗi sản phẩm nhiều biến thể | mặc định `Phân loại` / `Phân loại 1` + `Phân loại 2` |
| bảng **kết quả tách** | `product_id` · giá trị gốc · sau khi tách · nút **tắt tách** |
| cột **bỏ qua** | đã có sẵn `inspectColumns()` — chỉ cần hiện ra |

**Không JavaScript** trừ khi thật cần: màn này thuộc seller-admin nên được phép JS hẹp có
`nonce`, nhưng form + Post-Redirect-Get là mặc định của kho.

### 6.4 Nghiệm thu đợt 3

- [ ] nhập cùng file **2 lần** → lần 2 báo *"124 sản phẩm đã nhập trước đó, bỏ qua"*, DB **không**
      tăng thêm sản phẩm nào
- [ ] đổi tên trục ở Xem trước → `product_options.name` đúng như đã gõ
- [ ] tắt tách ở một sản phẩm → SP đó thành 1 trục, giá trị **giữ nguyên dấu phẩy**
- [ ] `node --test packages/db/test/schema-invariants.test.js` **xanh**
- [ ] `node --test packages/db/test/tenant-isolation.test.js` **xanh** — shop A không thấy ref của shop B

---

## 7. ĐỢT 4 — Upsert *(chủ dự án đã đồng ý)*

**Cảnh báo trước khi bắt đầu:** `docs/45 §2` từng **cố ý loại bỏ** upsert vì *"một file nhập sai
cột giá có thể hạ giá cả cửa hàng trong một lần bấm"*. Chủ dự án đã chốt làm — nhưng cái giá đó
**không biến mất**, nó chỉ chuyển sang "làm kèm hàng rào". **Không hàng rào ⇒ không bật.**

### 7.1 Ba chế độ

| chế độ | hành vi |
|---|---|
| `create_only` | **MẶC ĐỊNH.** Chỉ tạo mới; đã tồn tại thì bỏ qua |
| `update_only` | chỉ cập nhật cái đã có; không tạo mới |
| `upsert` | có thì cập nhật, không thì tạo |

Khớp theo `product_source_refs`: `sku_id` → biến thể, `product_id` → sản phẩm. **Không bao giờ
khớp theo tên sản phẩm.**

### 7.2 Sở hữu trường — mặc định là KHÔNG ghi đè

| trường | ghi đè? | vì sao |
|---|---|---|
| `title` · `description` · ảnh | **có** (mặc định bật) | nội dung trình bày, sai thì sửa lại được |
| `stock` | **có** (tuỳ chọn, **mặc định TẮT**) | tồn ở file có thể cũ hơn thực tế — người bán biết, ta không |
| `price_vnd` | **cần tick riêng + xác nhận** | rủi ro `docs/45 §2` nêu |
| `cost_vnd` | **KHÔNG BAO GIỜ** | file TikTok không có giá vốn; ghi đè = phá sổ lãi lỗ |
| `variants.sku` | **KHÔNG** | người bán đã in ra giấy |
| `products.slug` | **KHÔNG** | gãy link đang chạy + sitemap + SEO |
| `status` | **KHÔNG** | nhập không được tự bày bán |

### 7.3 BẢN ĐỒ ẢNH HƯỞNG — danh sách kiểm, không phải gợi ý

Upsert **không phải thêm câu `UPDATE`**. Mỗi trường nó chạm đều có thứ khác bám vào.

**(1) Sửa `variants.price_vnd` → 3 chỗ phải theo:**

| kéo theo | vì sao | file |
|---|---|---|
| tính lại `products.price_vnd` = **min** các biến thể | quên ⇒ storefront hiện *"từ …₫"* sai | `catalog.js` |
| kiểm lại `compare_at_price_vnd > price_vnd` **trên dữ liệu đã có** | **nâng** giá lên quá giá gạch cũ ⇒ badge giảm giá **ÂM**. Dữ liệu đang hợp lệ hoá không hợp lệ vì một lần nhập | `import.js:205` |
| khuyến mãi / flash sale đang chạy | `promotion_products` bám theo sản phẩm; đổi giá gốc là đổi số khách thấy giữa chiến dịch | `promotions.js` |
| **`order_lines` — KHÔNG làm gì** | đã snapshot `unit_price_vnd` / `sku_snapshot` / `title_snapshot`. Đơn cũ **an toàn tuyệt đối** | `0002` |

**(2) Sửa tồn kho — CHỖ NGUY HIỂM NHẤT:**

> **CẤM `UPDATE inventory_levels.on_hand` thẳng.** Bất biến của `0009`:
> *tổng `delta` trong `inventory_ledger` == `on_hand`*. Ghi thẳng phá nó, và sổ kho lệch **im lặng**.

```
Đúng: INSERT INTO inventory_ledger (…, delta, kind, reason, actor_id)
      VALUES (…, <mới> - <cũ>, 'adjust', 'nhập từ TikTok', …)
      rồi mới cập nhật on_hand.
kind chỉ nhận: receive · ship · adjust · reserve · release
Mẫu có sẵn: import.js:365 (kind='receive') và inventory.js:68
```

- **Kiểm `reserved` TRƯỚC khi hạ tồn.** `reserved` đang bị giỏ hàng và đơn chưa giao giữ. Đặt
  `on_hand < reserved` ⇒ tồn khả dụng **ÂM** ⇒ shop **mất bán** mà không hiểu vì sao.
  ⇒ Số mới < `reserved` thì **từ chối dòng đó kèm lý do**, không tự ép.
- Công thức tồn khả dụng nằm ở `packages/inventory/src/safety-stock.js` — **dùng chung, không
  chép lại**.
- Nhập 124 SP một phát có thể bắn hàng loạt cảnh báo sắp-hết-hàng (`shops.low_stock_threshold`).

**(3) Biến thể vắng mặt trong file → TUYỆT ĐỐI KHÔNG XOÁ**

`order_lines.variant_id` là **`NOT NULL` + FK tới `variants`**. Xoá biến thể từng có đơn = vi
phạm khoá ngoại; xoá biến thể *chưa* có đơn thì hôm nay được, ngày mai có đơn là hỏng.

⇒ **Để nguyên. Chỉ báo cáo** ở màn khác biệt: *"3 biến thể đang có trong shop không xuất hiện
trong file"*. Người bán tự quyết.

**(4) Thay ảnh → `media-gc` KHÔNG lo hộ**

`media-gc.js` chỉ xoá object có **tiền tố trưng bày** (`banner-`/`logo-`/`content-`/`cat-`).
Ảnh sản phẩm là `<shop>/<uuid>.webp` **không tiền tố**, cố ý nằm ngoài tầm gc.
⇒ Upsert thay ảnh phải **tự xoá dòng `media` cũ tường minh**. Bỏ qua ⇒ ảnh cũ nằm lại **và vẫn
hiện trong thư viện sản phẩm**.

**(5) Chỗ nhỏ nhưng phải sửa cùng lượt**

| việc | file |
|---|---|
| `upsert` **không** tính vào trần gói; chỉ `create` tính | `catalog.js` `planMaxProducts()` |
| Sự kiện audit riêng `product.updated_by_import` (khác `product.imported`) | `db.js` `audit()` |
| Route mới cho đo luồng dùng — **route phải là MẪU, không lọt id thật** | `obs.js` (10 bản phải khớp **từng ký tự**) |
| Timeout BFF 70s / ngân sách ảnh 45s | `seller-admin/src/api.js` |
| RBAC: dùng lại `catalog.write`, **không** thêm quyền mới | `rbac.js` |

### 7.4 Màn khác biệt

Bắt buộc hiện **trước khi ghi** khi có **bất kỳ** thay đổi giá:

```
SKU                        trường   hiện tại    →  từ file      hành động
VONG-TAY-ONG-KIEU-LUOI-48  giá      450.000₫       420.000₫     cập nhật
VONG-TAY-ONG-KIEU-LUOI-50  tồn      50             48           cập nhật
DAY-CHUYEN-TRUC-BONG-45CM  —        —              —            không đổi
(3 biến thể trong shop không có trong file — giữ nguyên)
```

### 7.5 Nghiệm thu đợt 4 — mỗi dòng là một test

- [ ] `create_only` + file đã nhập → **0 thay đổi**
- [ ] `upsert` + sửa giá 1 SP → **đúng 1 dòng** trong bảng khác biệt, và `products.price_vnd`
      **đổi theo** nếu đó là biến thể rẻ nhất
- [ ] nâng giá **cao hơn** `compare_at_price` đang có → **từ chối kèm lý do**, không tạo badge âm
- [ ] `upsert` sửa tồn → `inventory_ledger` có **đúng một** dòng `adjust`, và `sum(delta) == on_hand`
- [ ] hạ tồn xuống **dưới `reserved`** → **từ chối dòng đó**, dòng khác vẫn vào
- [ ] file thiếu 3 biến thể đang có → **0 biến thể bị xoá**, màn khác biệt **báo đủ 3**
- [ ] `cost_vnd` · `slug` · `variants.sku` **không đổi** trong mọi chế độ
- [ ] đơn cũ: `order_lines.unit_price_vnd` và `sku_snapshot` **không nhúc nhích** sau upsert

---

## 8. Test — và luật "xanh vì lý do sai"

> **Một chốt chỉ được coi là CÓ TEST khi:** sửa mã cho hỏng (gỡ đúng chốt đó) → chạy test →
> **phải ĐỎ** → khôi phục → **phải XANH**. Và ca thử phải đi qua **đúng** chốt đó, không phải
> một chốt khác tình cờ chặn trước.

### 8.1 Bộ phải viết

**Unit** — `node --test`, **không cần Docker**:

| bộ | canh gì |
|---|---|
| `apps/seller/test/adapter-tiktok.test.js` | 641 dòng → 124 SP; tách trục; sinh sku; danh mục |
| `apps/seller/test/html-to-text.test.js` | `<br>`→`\n`; `</p>`→`\n\n`; `&nbsp;`; rút `<img>`; `<script>` ra văn bản thuần |
| `apps/seller/test/xlsx-read.test.js` | dò dòng tiêu đề; 5 dòng meta không thành dữ liệu; ô rỗng không lệch cột |
| `apps/seller/test/xlsx-guard.test.js` | zip bomb · zip-slip · `<!DOCTYPE`/`<!ENTITY` · trần entry/dòng/cột |
| `apps/seller/test/tiktok-weight.test.js` | `parcel_weight` **không** bị nhân 1000 — bộ riêng vì đây là **sai tiền** |
| `apps/seller/test/import-field-owner.test.js` | `cost_vnd`/`slug`/`sku` không bao giờ đổi |
| `apps/seller/test/batch-split.test.js` | chia lô **không cắt giữa một `product_id`** |

**E2E** — cần Docker:

| bộ | canh gì |
|---|---|
| `apps/seller/test/import-tiktok.e2e.mjs` | file thật → 124/641; ảnh xếp hàng **299**; mô tả sạch |
| `apps/seller/test/import-tiktok-idem.e2e.mjs` | nhập 2 lần → không nhân đôi |
| `apps/seller/test/import-tiktok-upsert.e2e.mjs` | sửa giá → `products.price_vnd` theo kịp; `compare_at` vô lý bị chặn |
| `apps/seller/test/import-tiktok-stock.e2e.mjs` | tồn qua ledger; `sum(delta)==on_hand`; chặn xuống dưới `reserved` |
| `apps/seller/test/import-tiktok-nodelete.e2e.mjs` | biến thể vắng mặt không bị xoá; đơn cũ giữ snapshot |
| `apps/seller/test/import-tiktok-isolation.e2e.mjs` | shop A nhập, shop B **không** thấy gì |

### 8.2 ⚠️ Sau khi thêm test: SỬA `scripts/test-manifest.sh`

```
MANIFEST_UNIT_COUNT=24   ← cộng thêm số bộ unit mới
MANIFEST_E2E_COUNT=101   ← cộng thêm số bộ e2e mới
```

Bộ unit **lẻ** còn phải thêm đường dẫn vào mảng `MANIFEST_UNIT_FILES`. Nó so **BẰNG**, không
phải ≥. **Quên = cổng đỏ.**

### 8.3 Fixture: DÙNG FILE THẬT, đừng tự sinh file sạch

File xuất thật có **lỗi chính tả của người bán** (`vừa cổ` / `vừa cồ`), có **cột rỗng 100%**, có
**mô tả HTML**. Fixture tự sinh "đẹp" sẽ che đúng những lỗi này — kho đã dính bài học đó rồi.

### 8.4 Hồi quy bắt buộc (đợt 4 chạm giá/tồn nên kéo cả vùng tiền)

`dashboard` · `reports` (P&L) · `promotions` / flash sale · `checkout` (đặt hàng khi tồn vừa
đổi) · công nợ khách.

---

## 9. Ranh giới — KHÔNG được làm những việc sau

| không làm | vì sao |
|---|---|
| Sửa `buildProduct` / `groupRows` / `mapRow` trong `import.js` | phần lõi **đã chạy đúng**; adapter chỉ cần trả về hình dạng nó hiểu |
| Thêm cột JSONB `external_data` vào `products` | phá nguyên tắc `GRANT` mở cột; đã có bảng riêng |
| Xây "thuộc tính động" / EAV | đo được: 1 thuộc tính có dữ liệu, **1 giá trị duy nhất** |
| Tạo bảng `import_field_mapping` trong DB | mapping-as-code kiểm được bằng test mức mã nguồn |
| Sửa file migration đã có | migration **bất biến** — chỉ thêm file mới |
| Xoá biến thể / sản phẩm khi upsert | `order_lines.variant_id` là `NOT NULL` + FK |
| Nhân `parcel_weight` với 1000 | đã là gram; nhân lên = **sai tiền** |
| Đổi `slug`, `variants.sku`, `cost_vnd` | xem §7.2 |
| Thêm framework web / ORM / thư viện test | kiến trúc kho: HTTP thuần, `pg` thuần, `node --test` |
| Chạy formatter lên file có sẵn | không có eslint/prettier; diff rác che mất thay đổi thật |
| Viết chú thích hoặc commit bằng tiếng Anh | quy ước tuyệt đối |
| Hỗ trợ danh mục 3 cấp | trần 2 cấp của `0095`; file xuất thật chỉ 1 cấp |
| Nói "đã test, xanh" khi chưa chạy `bash scripts/ci-local.sh` | ở kho này câu đó có nghĩa **cụ thể** |

---

## 10. Bàn giao — nộp gì khi xong

Mỗi đợt một commit riêng (hoặc một PR riêng), kèm:

1. **Danh sách file đã thêm / đã sửa**, ghi rõ đợt nào.
2. **Bảng nghiệm thu** của đợt đó, tick từng dòng, **kèm số thật chạy ra** — không tick suông.
   Ví dụ: *"124 sản phẩm / 641 biến thể / 299 ảnh xếp hàng"*, không phải *"đạt"*.
3. **Kết quả `node --test`** của các bộ unit mới — dán nguyên đầu ra.
4. **Nói rõ đã chạy `bash scripts/ci-local.sh` chưa.** Chưa chạy được (không có Docker) thì
   **ghi thẳng ra**, đừng để người đọc tự suy.
5. **Đã sửa `MANIFEST_UNIT_COUNT` / `MANIFEST_E2E_COUNT` chưa** — ghi số cũ → số mới.
6. **Chỗ nào đi khác `docs/70` và vì sao.** Đi khác không phải lỗi; **đi khác mà im lặng** mới là.
