# 70 — Nhập danh mục từ TikTok Shop

> Trạng thái: **đặc tả đã chốt, chưa viết mã.**
> Liên quan: [45-di-cu-tu-san-khac](45-di-cu-tu-san-khac.md) · [11-catalog](11-catalog.md) ·
> [12-inventory-media](12-inventory-media.md) · [37-bao-cao-loi-nhuan](37-bao-cao-loi-nhuan.md) ·
> [38-flash-sale](38-flash-sale.md) · [56-tai-dung-bien-the](56-tai-dung-bien-the-va-chung-tu-cho.md) ·
> [04-quyet-dinh-kien-truc-adr](04-quyet-dinh-kien-truc-adr.md) (ADR-008)

---

## 0. Bộ nhập hiện có CÓ chạy — và trượt file TikTok ở đúng một chốt

Đã **chạy thật**, không suy từ mã: PostgreSQL 16 thật · 146 migration áp sạch · gọi thẳng
`importProducts()` của `apps/seller/src/import.js`, dùng đúng `parseCsv` của
`seller-admin/src/server.js`.

### 0.1 Bất biến DB — xanh

```
node --test packages/db/test/*.test.js
# tests 88 · pass 88 · fail 0
```

Khớp đúng con số README (`88 bất biến DB`). Cô lập tenant, least-privilege, bất biến schema:
không có gì hỏng.

### 0.2 Tệp mẫu của kho — **chạy đúng**

`maunhapsanpham.csv`, 4 dòng → xem trước rồi nhập thật:

| | kết quả |
|---|---|
| HTTP | 200 (cả `dry_run` lẫn ghi thật) |
| nhóm → sản phẩm | 2 nhóm → **2 sản phẩm, 4 biến thể** |
| DB sau khi ghi | `products 2 · variants 4 · product_options 2 · option_values 4 · variant_option_values 6` |
| gộp theo `handle` | ✔ `ao-thun-basic` → 1 SP, 3 SKU, **2 trục (Màu+Size)** |
| tổ hợp | `Đen/M` · `Đen/L` · `Trắng/M` — đúng từng cái |
| `status` | `active` / `draft` tôn trọng đúng cột |
| giá cấp SP | 199.000₫ = **min** của nhóm — đúng quy tắc `docs/45 §4.4` |

**Kết luận: chức năng "chuyển nhà" của `docs/45` hoạt động đúng như đã viết.** Không cần sửa
phần lõi. Việc còn lại thuần tuý là **dạy nó đọc thêm một định dạng**.

### 0.3 File TikTok thật qua đúng bộ nhập đó — **0 sản phẩm**

Chạy hai ca, cả hai đều thất bại toàn phần:

| ca | dòng gửi | nhóm | **tạo được** | hỏng | nguyên nhân |
|---|---:|---:|---:|---:|---|
| **A.** người bán lưu thẳng sang CSV | 645 | 645 | **0** | 645 | `SKU trống hoặc quá dài` ×99 + 1 nhóm toàn ảnh |
| **B.** đã xoá tay 5 dòng tiêu đề thừa | 641 | 641 | **0** | 641 | `SKU trống hoặc quá dài` ×100 |

Cột được nhận: **`category`, `product_name`, `price`, `quantity`** — 4/36. Bỏ qua 32 cột.

Hai điều đọc ra từ bảng này:

1. **`nhóm = 641` chứ không phải `124`.** Không có cột `handle` ⇒ mỗi dòng thành một sản phẩm
   riêng — đúng kịch bản `docs/45 §1` sinh ra để chặn, chỉ là đến từ hướng khác.
2. **Chốt chặn là `sku`**, không phải biến thể hay ảnh. `seller_sku` rỗng 0/641 nên không dòng
   nào qua nổi `validSku` (`import.js:196`). Kể cả có gộp nhóm đúng thì vẫn ra 0.

Ca A tệ hơn ca B **4 dòng** — đó là 4 dòng tiêu đề TikTok bị đọc thành sản phẩm. Nhỏ, nhưng
xác nhận lỗi §3 là thật chứ không phải lo xa.

---

## 1. Vì sao có tài liệu này

`docs/45` xây bộ nhập di cư trên hình dạng **Shopify** và tự ghi một giới hạn thành thật:

> *"bí danh cho Shopify/Haravan dựa trên định dạng tôi nắm chắc. Shopee và Sapo thì chưa — tôi
> không có file xuất thật để đối chiếu, và đoán tên cột rồi ghi vào bảng ánh xạ là tạo ra thứ
> **trông như** đã hỗ trợ nhưng im lặng bỏ sót cột."*

Nay đã có **file xuất thật của TikTok Shop** (641 dòng, 124 sản phẩm, một shop trang sức đang
bán). Tài liệu này thay chỗ trống đó bằng **số đo**, và ghi lại **bảy giả định đã bị đo cho
sai** — gồm cả giả định trong bản thiết kế được đề xuất cho chính việc này.

**Bài học lặp lại từ `docs/61`:** *không biết ≠ chưa xảy ra*. Trước khi có file thật, mọi thiết
kế cho việc này đều là suy đoán về hình dạng dữ liệu — kể cả suy đoán nghe rất hợp lý.

---

## 2. Số đo trên file xuất thật

Nguồn: `Tiktoksellercenter_batchedit_20260809_all_information_template.xlsx`, xuất qua
**Batch Edit Product → All information**. Đây là đường xuất mà người bán thực sự dùng được.

### 2.1 Hình dạng file

| số đo | giá trị |
|---|---|
| định dạng | **`.xlsx`** (không phải CSV) |
| dòng tiêu đề | **5 dòng** — dữ liệu bắt đầu ở **dòng 6** |
| dòng 1 | khoá máy (`product_id`, `category`, …) |
| dòng 2 | phiên bản: `V4` · `All_Information` · `metric` |
| dòng 3 | nhãn tiếng Việt |
| dòng 4 | `Bắt buộc` / `Không bắt buộc` / `Bắt buộc có điều kiện` |
| dòng 5 | hướng dẫn dài |
| dòng dữ liệu | **641** |
| sản phẩm riêng (`product_id`) | **124** |
| trung bình | **5,2 SKU/sản phẩm** |
| phân bố SKU/SP | 1 SKU: 7 · 2: 16 · 3: 11 · 4: 17 · 5: 8 · 6: 12 · **7: 48** · 8: 1 · 9: 1 · 10: 2 · 16: 1 |

### 2.2 Tỉ lệ điền — cột nào THẬT SỰ có dữ liệu

Đây là bảng quan trọng nhất của tài liệu. Cột 0% không phải "hiếm", mà là **không tồn tại
trong thực tế** và mọi thiết kế dựa vào nó đều hỏng.

| cột TikTok | điền | ghi chú |
|---|---:|---|
| `product_id` | **100%** | khoá gộp sản phẩm |
| `sku_id` | **100%** | **khoá định danh biến thể — dùng cái này** |
| `variation_value` | 100% | giá trị biến thể, **không có tên trục** (§3.1) |
| `product_name` | 100% | |
| `product_description` | 100% | **là HTML** (§3.2) |
| `category` | 100% | 1 cấp, dạng `Vòng tay & Lắc tay (605274)` |
| `price` | 100% | chuỗi số nguyên thuần: `450000` |
| `quantity` | 100% | tổng tồn cả file: 32.267 |
| `parcel_weight` | 100% | **đã là gram** — `200` cho một chiếc vòng |
| `cod` | 99,8% | giá trị `Y` |
| `main_image` | 100% | |
| `image_2` | 90,0% | |
| `image_3` | 41,7% | |
| `image_4` | 8,1% | |
| `image_5` … `image_6` | 1,9% · 1,2% | |
| `product_property/100701` (Vật liệu) | 39,6% | một giá trị duy nhất: `Phủ kim loại` |
| `product_property/100149` (Xuất xứ) | 2,5% | |
| **`seller_sku`** | **0%** | ⚠️ §3.3 |
| **`brand`** | **0%** | |
| **`parcel_length` / `width` / `height`** | **0%** | chỉ có cân nặng |
| `image_7` `image_8` `image_9` | 0% | |
| `size_chart` · `special_product_listing_type` · `auction_starting_price` | 0% | |
| 6 `product_property/*` còn lại | 0% | |

### 2.3 Số đo dẫn tới quyết định thiết kế

| số đo | hệ quả |
|---|---|
| 1.557 ô ảnh có URL, **chỉ 299 URL riêng biệt** | xoay ngang→dọc mà không khử trùng = **tải thừa 5,2 lần** |
| ảnh riêng/SP: min 1, max 6, **tb 2,4** | trần ảnh hiện tại thoải mái |
| 4 thẻ `<img>` **nhúng trong mô tả** (1 URL riêng) | mô tả có ảnh ngoài — CSP chặn (§3.2) |
| 121 SP **1 trục**, 3 SP **2 trục** | trục 3 chưa gặp; `MAX_OPTIONS = 3` dư sức |
| 0 SP có `variation_value` lặp | quy tắc "tổ hợp lặp → từ chối" không vướng |
| 0 SP có tên/mô tả khác nhau giữa các dòng | quy tắc "dòng đầu cấp thông tin sản phẩm" chạy sạch |
| 0 tên sản phẩm trùng giữa 2 SP | nhưng **vẫn không được gộp theo tên** (`docs/45 §4`) |
| giá 210.000 – 700.000 ₫ | không có giá 0, không có giá thập phân |
| **5.000 SP/file × 5,2 = ~25.847 dòng** | **gấp 26 lần** trần `IMPORT_MAX_ROWS = 1000` |

---

## 3. Bảy phát hiện lật giả định

### 3.1 `variation_value` KHÔNG mang tên trục — và không tách được bằng máy

Đây là phát hiện quan trọng nhất, và nó phủ định thiết kế "TikTok cho `Color=Black, Size=M`".

Giá trị thật trong file:

```
'48'                      '50cm (vừa cổ)'        '48 tay đo 14cm'
'50'                      '50cm (vừa cồ)'   ←    '48 / 14cm'
'45cm (ngắn)'             '60cm (đeo chồng cổ)'  '1 chỉ, Ni 5'
'45cm, 45cm'              '40cm (em bé đeo)'     '2 chỉ, Ni 9'
```

Ba sự thật đo được:

1. **Không có tên trục ở bất kỳ đâu trong file.** Không cột nào nói `48` là *Size* hay *Ni* hay
   *Chiều dài*. Suy ra được từ tên sản phẩm thì là đoán, và đoán sai thì người bán nhìn thấy
   trục tên `Size` trên một sợi dây chuyền.
2. **Không có ký tự phân cách máy đọc được.** Đếm trên 641 dòng: `:` 0 lần · `;` 0 lần ·
   `|` 0 lần. Chỉ có `, ` (36 dòng) và `/` (92 dòng) — mà `/` là **văn bản người gõ**, không
   phải phân cách: so `'48 tay đo 14cm'` với `'48 / 14cm'`, cùng nghĩa, một cái có `/` một cái
   không.
3. **Giá trị là văn bản tự do người bán gõ, có lỗi chính tả.** `'50cm (vừa cổ)'` và
   `'50cm (vừa cồ)'` cùng tồn tại trong một shop — hai giá trị khác nhau với máy, một với người.

**Hệ quả thiết kế.** Không thể suy tên trục. Nhưng **đếm được số trục**: 121 SP không có `, `
(1 trục), 3 SP có (2 trục). Nên đường đi đúng là:

> **Máy đoán số trục và tách thử → màn Xem trước hiện kết quả tách → người bán ĐẶT TÊN trục và
> sửa chỗ tách sai.**

Biến một bài toán phân tích không giải được thành một câu hỏi 5 giây. Mặc định đề nghị:
`Phân loại` cho 1 trục, `Phân loại 1` / `Phân loại 2` cho 2 trục.

⚠️ **Dấu phẩy là suy đoán, không phải luật.** `'Áo, quần'` là một giá trị chứ không phải hai
trục. Nên kết quả tách **phải hiện ra để người duyệt**, và phải cho **tắt tách** ở mức từng sản
phẩm. Tách sai mà im lặng thì tạo ra ma trận biến thể rác mà người bán chỉ phát hiện khi khách
đặt nhầm.

### 3.2 Mô tả là HTML — và storefront hiện sẽ hiện THẺ THÔ cho khách xem

641/641 dòng có mô tả chứa HTML. Thẻ đếm được: `<p>` 3.830 · `<br>` 2.228 · `<img>` 4 ·
`<ol>`/`<li>` 2.

```html
<p>Trang sức cao cấp - chất liệu đồng vàng<br>+ KHÔNG ĐEN<br>+ KHÔNG TEN KHÔNG TRÓC TRẮNG<br>...</p>
```

Storefront render mô tả qua `formatDesc` (`apps/storefront/src/theme.js:2460`), và hàm đó
**`esc()` toàn bộ nội dung** — cố ý, chống XSS, chỉ thẻ khối do ta sinh mới được ra HTML.

Nghĩa là nhập thô vào thì khách hàng **nhìn thấy chữ `<p>` và `<br>` trên trang sản phẩm**.
Không phải lỗ bảo mật — nhưng là **100% sản phẩm nhập vào đều hỏng phần mô tả**, và hỏng theo
kiểu người bán chỉ phát hiện khi tự mở cửa hàng ra xem.

**Đây là điều bản thiết kế được đề xuất không nhắc tới một chữ nào.** Nó bàn rất kỹ về JSON và
mapping engine, nhưng thứ làm hỏng 100% dữ liệu ngay lần nhập đầu lại nằm ngoài tầm nhìn — vì
nó chỉ lộ ra khi đọc mã render, không lộ ra khi đọc tên cột.

**Cần:** bộ chuyển HTML → văn bản thuần theo đúng quy ước `formatDesc` đọc được:
`<br>` → `\n` · `</p>` → `\n\n` · `<li>` → `- ` · bỏ mọi thẻ còn lại · giải mã thực thể
(`&amp;` `&nbsp;` `&#39;`).

**Riêng `<img>` trong mô tả:** ADR-008 + CSP nghiêm ngặt cấm tài nguyên ngoài. Ba lựa chọn —
đề nghị chọn (b):
- (a) bỏ hẳn → mất thông tin;
- (b) **rút URL ra, xếp vào cuối thư viện ảnh sản phẩm** qua đúng đường `media` pending → worker
  tải → thành ảnh nội bộ. Dùng lại nguyên đường ống đã có, không viết gì mới;
- (c) giữ thẻ → CSP chặn, ảnh vỡ, và tạo phụ thuộc vĩnh viễn vào CDN TikTok.

### 3.3 `seller_sku` rỗng 100% — khoá định danh phải là `sku_id`

Bản thiết kế đề xuất thứ tự khoá: `TikTok Product ID → Seller SKU → SKU/Variant SKU`.

Đo được: **`seller_sku` = 0/641.** Nấc giữa không tồn tại. Người bán TikTok phần lớn không bao
giờ điền ô này — TikTok không bắt buộc.

Hệ quả kép:

1. Bộ nhập hiện tại **bắt buộc** `sku` (`import.js:196`, `'SKU trống hoặc quá dài'`). Không có
   nguồn ⇒ **mọi dòng bị từ chối** ⇒ nhập được đúng 0 sản phẩm.
2. Khoá định danh duy nhất còn lại là **`sku_id` (100%)** — ID nội bộ của TikTok.

Nhưng `variants.sku` là `UNIQUE (shop_id, sku)` và **người bán sẽ đọc nó** trên phiếu kho, vận
đơn, báo cáo. Nhét `1731037645341100126` vào đó là biến một trường con người dùng thành rác máy.

**Đề nghị tách đôi:**
- `variants.sku` ← **sinh cho người đọc**: `slug(tên SP rút gọn)-<giá trị trục>`, ví dụ
  `VONG-TAY-LUOI-48`. Đụng độ thì thêm hậu tố số.
- `sku_id` của TikTok ← lưu ở **bảng tham chiếu riêng** (§5.2), dùng làm khoá chống nhập trùng.

Cùng nguyên tắc `0105` đã chốt cho đơn di cư: chống trùng bằng **mã gốc**, không bằng thuộc tính
nghiệp vụ.

### 3.4 `category` chỉ 1 cấp, và khác hẳn giữa hai template TikTok

| | file **xuất ra** (batchedit) | file **đăng mới** (batchupload) |
|---|---|---|
| dạng | `Vòng tay & Lắc tay (605274)` | `Đồ nữ/Đồ dự tiệc/Đồ công sở` |
| số cấp đo được | **1** (641/641 dòng) | **3** |
| có ID | có, trong ngoặc | không |

File người bán thật sự có là bản trái: **tên lá + ID, không có đường dẫn cha**. Nên:
- bỏ ` (605274)` bằng regex đuôi;
- tạo danh mục **1 cấp** — không bịa cấp cha;
- giữ ID gốc ở bảng tham chiếu (§5.2) để lần nhập sau khớp lại được kể cả khi người bán đổi tên.

Bản phải (3 cấp) **vượt trần 2 cấp của `0095`** — nếu sau này hỗ trợ, phải quyết định gộp cấp
nào, và đó là quyết định riêng, không nhét vào đợt này.

### 3.5 `parcel_weight` ĐÃ là gram — chớ đổi đơn vị

Bản thiết kế đề xuất dòng mapping: `Package Weight | weight | decimal | kg → gram`.

Đo được: `parcel_weight = '200'` cho một chiếc vòng tay, và nhãn cột dòng 3 ghi rõ
**`Trọng lượng kiện hàng(g)`**. Đã là gram.

Áp phép nhân ×1000 sẽ ra **200 kg cho một chiếc vòng tay** ⇒ phí ship sai ⇒ **sai tiền**. Đây
đúng là cái bẫy mà `import.js:70-72` đã ghi lại và cố ý phòng bằng cách **không** nhận cột
`weight` trần. Giữ nguyên nguyên tắc đó: chỉ nhận cột đã nói rõ đơn vị.

### 3.6 Ảnh lặp 5,2 lần — phải khử trùng khi xoay ngang→dọc

TikTok để 9 cột ảnh **trên một dòng**, và mọi dòng của cùng một sản phẩm lặp lại y hệt bộ ảnh
đó: 124/124 sản phẩm có `main_image` giống nhau ở mọi dòng.

1.557 ô có URL, **299 URL riêng biệt**. Xoay ngang→dọc theo kiểu ngây thơ rồi xếp hàng tải sẽ
tạo 1.557 lượt tải cho 299 tấm ảnh — **thừa 5,2 lần**, và mỗi lượt là một lần chạm mạng ra
ngoài qua hàng rào SSRF.

Khử trùng **theo URL, trong phạm vi một sản phẩm**, giữ thứ tự xuất hiện đầu tiên.

### 3.7 Trần 1.000 dòng nhỏ hơn thực tế 26 lần

`IMPORT_MAX_ROWS = 1000` (`import.js:25`). File thật: 641 dòng cho 124 SP.

TikTok cho xuất **5.000 sản phẩm mỗi file**. Với 5,2 SKU/SP ⇒ **~25.847 dòng/file** ⇒ gấp
**26 lần** trần hiện tại. Shop 200 SP (`seed-day60`) đã ~1.040 dòng — **vượt trần ngay**.

Ba đường, đề nghị (b) cho đợt này:
- (a) nâng trần → đụng `maxBody`, thời gian giữ transaction, bộ nhớ;
- (b) **đếm theo SẢN PHẨM, không theo dòng** — trần `1000 sản phẩm/lần`, dòng thì để tự do.
  Hợp nghĩa hơn: đơn vị người bán nghĩ tới là sản phẩm, và `docs/45 §4.6` đã chốt đơn vị
  "một phần" là sản phẩm chứ không phải dòng;
- (c) nhập theo lô nền → đợt sau, cần bảng trạng thái + màn theo dõi.

---

## 4. Đối chiếu bản thiết kế được đề xuất

Bản gợi ý có **khung đúng**. Phần dưới tách rõ ba nhóm để khỏi làm lại thứ đã có và khỏi bê vào
thứ chống lại kiến trúc kho này.

### 4.1 Đúng, và nên làm

| đề xuất | ghi chú |
|---|---|
| Canonical model + adapter theo nguồn | Đúng hướng. Là cách để thêm Shopee sau này mà không viết lại. |
| Giữ **bản thô** của file nhập | Giá trị thật: sửa mapper xong không phải bắt người bán tải lại file. |
| Chuẩn hoá **trước** khi so sánh | Đúng — nhưng ví dụ kg→gram trong bản gợi ý lại sai (§3.5). |
| Không dùng **tên sản phẩm** làm khoá trùng | Đúng, và `docs/45 §4` đã theo nguyên tắc này từ đầu. |
| Import mode (create / update / upsert) | Đáng làm, nhưng xem §4.3 — `docs/45 §2` đã cố ý hoãn upsert. |
| Field ownership (cột nào được ghi đè) | Đúng và cần, đặc biệt cho `price` và `cost`. |

### 4.2 Kho này **đã có**, đừng xây lại

| đề xuất | đã có ở đâu |
|---|---|
| "Preview trước khi commit" | `mode=preview` / `mode=commit`, `seller-admin/src/pages.js:3477`. Đã chạy, có e2e. |
| "Variant tách khỏi Product" | `product_options` / `option_values` / `variant_option_values` (0041–0043), ma trận đa trục, trần 100 biến thể. |
| "Báo cột nào không nhận" | `inspectColumns()` (`import.js:86`) đã trả `recognised` / `ignored` và màn hình đã hiện. |
| "Nhóm lỗi thì bỏ cả nhóm, nhóm khác vẫn vào" | `docs/45 §4.6`, đã cài. |
| "Parse tiền đa định dạng" | `parseAmount()` (`import-parse.js`), có unit test, đã xử đúng bẫy `199000.00`. |
| "Hàng rào khi tải ảnh theo URL" | `packages/net-guard`, 8 lớp, dùng chung seller + worker (`docs/45 §5`). |
| "Ảnh tải nền, không chặn request" | worker + `media.status = pending` (0106). |

### 4.3 **Không hợp** với kiến trúc kho này — và thay bằng gì

#### (a) Cột JSONB `external_data` trên bảng `products` — ĐỀ NGHỊ BỎ

Đây là điểm lệch lớn nhất giữa bản gợi ý và kho này.

Nguyên tắc nền của `docs/02`: **`GRANT` mở CỘT, `POLICY` mở DÒNG.** Kiểm soát quyền ở kho này
chạy ở mức cột, với 17 vai `app_*` mỗi vai ít quyền nhất.

Một cột JSONB gộp mọi thứ **phá đúng cơ chế đó**: nó là *một* cột, nên vai nào đọc được cột ấy
là đọc được **toàn bộ** những gì từng đổ vào — hôm nay là ID danh mục TikTok, ngày mai là thứ
người bán dán nhầm vào. Không còn cách nào nói "vai này đọc được ID sàn nhưng không đọc được
phần còn lại".

Thêm hai vấn đề:
- `products` là bảng **44 module của `apps/seller` đọc** và storefront/checkout cũng đọc. Đổ dữ
  liệu **chưa kiểm** của bên thứ ba vào đó là mở một mặt tấn công đi qua tất cả.
- `ALTER DEFAULT PRIVILEGES` (0003) **tự cấp CRUD cho `app_rw`** trên mọi thứ mới. Cột JSON mới
  sẽ tự động ghi được, không ai phải cố ý cho phép.
- PII: `docs/36` có quy tắc ẩn danh theo cột. Một túi JSON tự do là chỗ PII lọt vào mà quy tắc
  đó không với tới.

**Thay bằng:** bảng riêng `product_source_refs` (§5.2) — có `shop_id`, có policy riêng, có GRANT
riêng, và phần thô bị **cách ly khỏi** bảng `products`.

#### (b) "Attributes động" cho thuộc tính sản phẩm — ĐỀ NGHỊ HOÃN

Bản gợi ý lập luận: *"số lượng thuộc tính có thể lên tới hàng trăm/hàng nghìn tùy category"*.

Đo được: trong 641 dòng, **một** thuộc tính có dữ liệu đáng kể — Vật liệu, 39,6%, và **chỉ một
giá trị duy nhất** (`Phủ kim loại`). Xuất xứ 2,5%. Sáu thuộc tính còn lại: 0%.

Xây một engine thuộc tính động cho một trường có một giá trị là làm ngược `README §7` (mỗi việc
hoãn có **ngưỡng** để làm). **Ngưỡng đề nghị:** khi có ≥ 3 shop thật mà `product_property/*`
điền > 30%, hoặc khi có shop hỏi.

Đợt này: giữ thô trong `product_source_refs.raw_row`, **không** hiển thị, **không** vận hành.
Dữ liệu không mất — chỉ chưa được dùng.

#### (c) Bảng `import_field_mapping` trong DB — ĐỀ NGHỊ BỎ

Cơ chế bí danh hiện tại **đã là dữ liệu**: `COLS` (`import.js:58`), thêm một chuỗi vào mảng là
xong, không sửa logic — đúng ý bản gợi ý muốn đạt.

Đưa vào DB thì phải: một migration, một bảng, RLS + GRANT cho nó, một màn quản trị, và một
đường để mapping **trôi lệch giữa các môi trường**. Đổi lại: không được gì khi mới có 1–2 nguồn.

Quan trọng hơn: mapping-as-code **kiểm được bằng test bất biến mức mã nguồn** — đúng loại test
kho này đã dùng nhiều lần (`shared-sql.test.js`, `usage-route.test.js`). Mapping trong DB thì
test phải dựng DB, chậm hơn và yếu hơn.

**Ngưỡng đổi ý:** khi người bán cần **tự** khai mapping cho file lạ.

#### (d) Upsert — **CHỦ DỰ ÁN ĐÃ CHỐT: LÀM**

`docs/45 §2` từng cố ý loại upsert:

> *"Cần quy tắc khớp và sẽ **ghi đè giá đang bán**. Một file nhập sai cột giá có thể hạ giá cả
> cửa hàng trong một lần bấm."*

Dữ kiện đã đổi: hồi đó **không có khoá khớp đáng tin**, nay có `sku_id` 100%. Chủ dự án chốt
làm. Nhưng **cái giá mà `docs/45` cảnh báo không biến mất** — nó chỉ chuyển từ "không làm" sang
"làm kèm hàng rào". Ba hàng rào bắt buộc, không cái nào bỏ được:

1. **Bảng sở hữu trường** (§5.4) — mặc định của mọi trường là *không* ghi đè.
2. **Màn khác biệt bắt buộc xem** trước khi ghi, khi có bất kỳ thay đổi giá nào.
3. **Không xoá gì bao giờ** — xem §5.5, đây là chỗ upsert có thể phá dữ liệu không hoàn lại.

---

## 5. Thiết kế chọn

### 5.1 Đường đi

```
file .xlsx / .csv
      │
      ▼
① ĐỌC        đọc xlsx, dò dòng tiêu đề, trả mảng bản ghi thô
      │
      ▼
② NHẬN DẠNG  ngửi nguồn (TikTok? Shopify? tệp mẫu của ta?)
      │
      ▼
③ ADAPTER    <nguồn> → dạng CHUẨN (đúng khoá mà import.js đang dùng)
      │
      ▼
④ CHUẨN HOÁ  tiền · cân · HTML→text · danh mục · tách trục
      │
      ▼
⑤ XEM TRƯỚC  đã có — thêm: tên trục, kết quả tách, cột bỏ qua
      │
      ▼
⑥ GHI        đã có — thêm: ghi product_source_refs
```

**Nguyên tắc xuyên suốt: adapter chỉ được trả về hình dạng mà `import.js` HIỆN ĐÃ hiểu.**

Nghĩa là adapter TikTok xuất ra đúng các khoá `handle` · `title` · `option1_name` ·
`option1_value` · `sku` · `price_vnd` · `stock` · `weight_gram` · `image_url` … và **không sửa
gì trong `buildProduct`**. Cả phần gộp nhóm, kiểm trục, kiểm trần, quy tắc nhóm-lỗi-bỏ-cả-nhóm
được **dùng lại nguyên vẹn** — cùng lý do `docs/45` không cho đường tiền có bản sao thứ hai.

Adapter là **hàm thuần, không chạm DB/mạng** ⇒ test bằng `node --test` ở mọi commit, giống
`import-parse.js` đã tách ra vì đúng lý do này.

### 5.2 Migration mới — `0152_product_source_refs.sql`

```sql
CREATE TABLE product_source_refs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id       uuid NOT NULL REFERENCES shops(id),
  source        text NOT NULL CHECK (source IN ('tiktok','shopify','haravan','sapo','shopee')),
  kind          text NOT NULL CHECK (kind IN ('product','variant','category')),
  external_id   text NOT NULL,          -- product_id / sku_id / category id
  product_id    uuid,
  variant_id    uuid,
  raw_row       jsonb,                  -- bản THÔ, chỉ để tra & sửa mapper. KHÔNG vận hành.
  imported_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE (shop_id, source, kind, external_id),
  FOREIGN KEY (shop_id, product_id) REFERENCES products (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, variant_id) REFERENCES variants (shop_id, id) ON DELETE CASCADE
);
```

Bắt buộc kèm trong cùng migration — **thiếu là vỡ bất biến schema**:

```sql
ALTER TABLE product_source_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_source_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON product_source_refs
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- app_rw đã tự có CRUD qua 0003. Các vai KHÔNG được đọc bảng này:
REVOKE ALL ON product_source_refs FROM app_store, app_checkout, app_customer;
```

**Vì sao `REVOKE`:** storefront/checkout/account **không có việc gì** với ID sàn ngoài. Đây
đúng thao tác mà `CLAUDE.md §3` bắt làm cho bảng mới không thuộc phạm vi tenant thường —
`ALTER DEFAULT PRIVILEGES` đã tự cấp, nên "không viết GRANT" ≠ "vai đó không có quyền".

**`UNIQUE (shop_id, source, kind, external_id)` là chốt chống nhập trùng** — nhập cùng một file
5 lần vẫn ra một bộ sản phẩm. Cùng cách `0105` chống trùng đơn di cư.

### 5.3 Quy tắc chuẩn hoá — bảng tra

| trường | vào | quy tắc | bẫy đã biết |
|---|---|---|---|
| `product_id` | khoá gộp (`handle`) | dùng thẳng | thay chỗ cột `handle` vắng mặt |
| `sku_id` | `product_source_refs` | không vào `variants.sku` | §3.3 |
| `variation_value` | `option1_value` (+`option2_value`) | tách `, ` → **người bán duyệt** | §3.1 — dấu phẩy là suy đoán |
| *tên trục* | `option1_name` | **người bán nhập**, mặc định `Phân loại` | không suy được |
| `product_name` | `title` | cắt 255 | |
| `product_description` | `description` | **HTML → text**, rút `<img>` ra media | §3.2 — nếu không thì 100% SP hỏng |
| `category` | `category` | bỏ ` (\d+)` đuôi, 1 cấp | §3.4 |
| `price` | `price_vnd` | `parseAmount` (đã có) | không nhân/chia gì |
| `quantity` | `stock` | số nguyên ≥ 0 | |
| `parcel_weight` | `weight_gram` | **dùng thẳng, ĐÃ là gram** | §3.5 — nhân 1000 là sai tiền |
| `main_image`…`image_9` | `image_url` | xoay ngang→dọc, **khử trùng theo URL** | §3.6 — thừa 5,2× |
| `cod` `Y`/`N` | — | chưa dùng | kho chưa có COD mức sản phẩm |
| `brand` | — | 0% | không làm |
| `parcel_length/width/height` | — | 0% | không làm |
| `product_property/*` | `raw_row` | giữ thô, không vận hành | §4.3(b) |
| `sku` (sinh) | `variants.sku` | `slug(title)-<giá trị trục>`, đụng thì thêm số | §3.3 |

### 5.4 Sở hữu trường — cho đợt 4 (upsert)

Chốt trước để đợt 4 không phải cãi lại. **Mặc định của mọi trường là KHÔNG ghi đè.**

| trường | import ghi đè? | vì sao |
|---|---|---|
| `title` · `description` · ảnh | **có** (mặc định bật) | nội dung trình bày, sai thì sửa lại được |
| `stock` | **có** (tuỳ chọn, mặc định tắt) | tồn kho ở đây có thể mới hơn hoặc cũ hơn — người bán biết, ta không |
| `price_vnd` | **cần tick riêng + xác nhận** | hạ giá cả cửa hàng bằng một lần bấm là rủi ro `docs/45 §2` nêu |
| `cost_vnd` | **không bao giờ** | giá vốn không có ở file TikTok; ghi đè = phá sổ lãi lỗ (`docs/37`) |
| `variants.sku` | **không** | người bán đã in lên phiếu kho/vận đơn |
| `slug` | **không** | đổi slug là gãy link đang chạy + mất SEO |
| `status` | **không** | nhập không được tự bày bán (`docs/45 §3`) |
| `product_source_refs.*` | **có** | đó là việc của nó |

### 5.5 BẢN ĐỒ ẢNH HƯỞNG — sửa chỗ này thì phải sửa chỗ nào nữa

Phần quan trọng nhất của cả tài liệu khi bắt tay viết mã. Upsert không phải "thêm câu
`UPDATE`": mỗi trường nó chạm đều có thứ khác bám vào. Bảng dưới là **danh sách bắt buộc kiểm
từng dòng** trước khi gọi một đợt là xong.

#### (1) Sửa `variants.price_vnd` → kéo theo 4 chỗ

| kéo theo | vì sao | file |
|---|---|---|
| `products.price_vnd` phải tính lại | giá cấp SP = **min** các biến thể (`docs/45 §4.4`); sửa một biến thể mà quên tính lại thì storefront hiện *"từ …₫"* sai | `apps/seller/src/catalog.js` |
| `compare_at_price_vnd` phải kiểm lại | ràng buộc `compareAt > price` (`import.js:205`). **Nâng** giá lên quá giá gạch cũ tạo badge giảm giá ÂM — dữ liệu cũ hợp lệ trở thành không hợp lệ vì một lần nhập | `import.js` |
| khuyến mãi / flash sale đang chạy | `promotion_products` bám theo sản phẩm; đổi giá gốc là đổi số tiền khách thấy giữa lúc chiến dịch chạy | `promotions.js`, `docs/38` |
| **`order_lines` — KHÔNG cần làm gì** | đã snapshot `unit_price_vnd`/`sku_snapshot`/`title_snapshot` (`0002`). Đơn cũ **an toàn tuyệt đối**. Đây là chỗ duy nhất trong bảng này không phải lo — vì kiến trúc đã lo sẵn | `0002_catalog_orders.sql` |

#### (2) Sửa tồn kho → chỗ nguy hiểm nhất

**Cấm `UPDATE inventory_levels.on_hand` thẳng.** Bất biến của `0009`: *tổng `delta` trong
`inventory_ledger` == `on_hand`*. Ghi thẳng là phá nó, và sổ kho lệch **im lặng**.

| kéo theo | vì sao |
|---|---|
| ghi `inventory_ledger` một dòng `kind='adjust'` | đúng đường `import.js:365` đang làm cho tồn ban đầu (`kind='receive'`) và `inventory.js:68`. `kind` chỉ nhận `receive/ship/adjust/reserve/release` |
| **kiểm `reserved` trước khi hạ tồn** | `reserved` đang bị giỏ hàng và đơn chưa giao giữ. Đặt `on_hand` < `reserved` ⇒ tồn khả dụng ÂM ⇒ `safety-stock.js` trả 0 và shop **mất bán** mà không hiểu vì sao |
| ngưỡng cảnh báo sắp hết | `shops.low_stock_threshold`, `low_stock_alerted_on` — nhập một phát 124 SP có thể bắn hàng loạt cảnh báo |
| tồn an toàn | `packages/inventory/src/safety-stock.js` — công thức dùng chung, **không được chép lại** trong bộ nhập |

**Quy tắc chốt:** tồn từ file TikTok là **`adjust` về số tuyệt đối**, và nếu số mới < `reserved`
thì **từ chối dòng đó kèm lý do**, không tự ép.

#### (3) Biến thể biến mất khỏi file → TUYỆT ĐỐI KHÔNG XOÁ

`order_lines.variant_id` là **`NOT NULL` + FK tới `variants`** (`0002`). Xoá một biến thể từng
có đơn = vi phạm khoá ngoại; xoá biến thể *chưa* có đơn thì hôm nay được, ngày mai có đơn là hỏng.

Cùng lý do `docs/45 §8` đã ghi cho đơn di cư: *"Nới `NOT NULL` là phá một bất biến kế toán bảo
vệ toàn hệ."*

→ Biến thể vắng mặt trong file: **để nguyên**, chỉ **báo cáo** ở màn khác biệt
(*"3 biến thể đang có trong shop không xuất hiện trong file"*). Người bán tự quyết.

#### (4) Sửa ảnh → dọn rác KHÔNG tự lo hộ

`media-gc.js` chỉ xoá object có **tiền tố trưng bày** (`banner-`/`logo-`/`content-`/`cat-`).
Ảnh sản phẩm là `<shop>/<uuid>.webp` **không tiền tố**, cố ý nằm ngoài tầm gc vì nó thuộc vòng
đời bảng `media`.

→ Upsert thay ảnh phải **tự xoá dòng `media` cũ tường minh**. Bỏ qua bước này thì ảnh cũ nằm
lại kho mãi mãi và **vẫn hiện trong thư viện sản phẩm**.

#### (5) Ba trường KHÔNG BAO GIỜ để import chạm

| trường | hậu quả nếu chạm |
|---|---|
| `products.slug` | gãy mọi link đang chạy + sitemap + thứ hạng tìm kiếm |
| `variants.sku` | người bán đã **in ra giấy** — phiếu kho, vận đơn. Đổi = hàng đi sai |
| `variant_costs.cost_vnd` | file TikTok **không có** giá vốn; ghi đè = phá sổ lãi lỗ (`docs/37`) |

#### (6) Các chỗ nhỏ nhưng phải sửa cùng lượt

| việc | file |
|---|---|
| Trần gói: **upsert không tính** vào trần, chỉ `create` tính | `catalog.js` `planMaxProducts()` |
| Sự kiện audit riêng `product.updated_by_import` (khác `product.imported`) | `db.js` `audit()` |
| Chuẩn hoá route cho đo luồng dùng — **route phải là MẪU, không lọt id** | `obs.js` (10 bản phải khớp từng ký tự — `usage-route.test.js`) |
| Timeout BFF 70s / ngân sách ảnh 45s | `seller-admin/src/api.js`, `docs/45 §5` |
| RBAC: dùng lại `catalog.write`, **không** thêm quyền mới | `rbac.js` |

#### (7) Ràng buộc kích thước — ĐÃ ĐO

| số đo | giá trị |
|---|---|
| 641 dòng TikTok → JSON | **1,32 MB** — lọt trần `maxBody` 2 MB (`import.js:701`) |
| trong đó `product_description` chiếm | **32%** |
| 5.000 SP (~25.847 dòng) → JSON | **~53 MB** — vượt trần **26 lần** |

⇒ Trần đếm theo **sản phẩm** (đã chốt) chưa đủ; phải **chia lô ở phía BFF**: cắt theo ranh giới
`product_id` rồi gửi nhiều lượt. Cắt giữa một sản phẩm là xé nhóm biến thể — ra sản phẩm thiếu
SKU mà không có lỗi nào báo.

---

## 6. Kế hoạch — 4 đợt, mỗi đợt tự đứng được

Mỗi đợt phải **chạy được và có ích ngay**, không để lại nửa vời.

### Đợt 1 — Đọc được file (không đụng gì tới nghiệp vụ)

**Mục tiêu:** tải file `.xlsx` của TikTok lên và **màn Xem trước hiện đúng 124 sản phẩm,
641 biến thể**, chưa ghi gì vào DB.

| việc | file |
|---|---|
| Bộ đọc `.xlsx` → mảng bản ghi | mới: `apps/seller/src/xlsx-read.js` |
| Dò dòng tiêu đề (tìm dòng chứa `product_id`/`handle`, **không** đóng cứng dòng 1) | `xlsx-read.js` |
| Nới `accept` của form + kiểm magic byte `PK\x03\x04` | `seller-admin/src/pages.js:3477`, `server.js` |
| Trần đếm theo **sản phẩm** (`IMPORT_MAX_PRODUCTS = 1000`), bỏ trần dòng | `import.js:25,388` |
| **Chia lô ở BFF** theo ranh giới `product_id` (§5.5.7) | `seller-admin/src/server.js` |

Bộ đọc xlsx theo §9.4: **zero-dep**, sáu hàng rào bắt buộc. Đây là mã ăn tệp của người lạ —
viết nó với cùng thái độ như `net-guard`, không phải như một hàm tiện ích.

**Nghiệm thu:**
- tải file thật lên → Xem trước báo **124 sản phẩm / 641 biến thể / 0 lỗi**
  *(hôm nay: 641 nhóm / 0 tạo được — §0.3)*;
- 5 dòng tiêu đề **không** biến thành sản phẩm *(ca A hôm nay: 645 nhóm thay vì 641)*;
- file `.csv` cũ chạy **y hệt §0.2**: 2 sản phẩm · 4 biến thể · 2 trục `Màu+Size` ·
  tổ hợp `Đen/M` `Đen/L` `Trắng/M` · giá cấp SP 199.000₫;
- zip bomb (tỉ lệ nén > 1:100) bị từ chối **trước khi** giải nén hết;
- xlsx chứa `<!DOCTYPE`/`<!ENTITY` bị từ chối;
- file `.xlsx` giả mạo (đuôi đúng, ruột không phải zip) bị từ chối;
- entry có `..` trong đường dẫn bị từ chối.

---

### Đợt 2 — Adapter TikTok (phần lõi)

**Mục tiêu:** 124 sản phẩm vào DB **đúng**, mô tả đọc được, ảnh không tải thừa.

| việc | file |
|---|---|
| `adaptTiktok(rows)` → dạng chuẩn | mới: `apps/seller/src/adapters/tiktok.js` |
| Nhận dạng nguồn theo chữ ký cột | `adapters/index.js` |
| HTML → text + rút `<img>` | mới: `apps/seller/src/html-to-text.js` |
| Xoay ảnh ngang→dọc + khử trùng | `adapters/tiktok.js` |
| Danh mục: bỏ `(\d+)`, 1 cấp | `adapters/tiktok.js` |
| Sinh `sku` đọc được + chống đụng | `adapters/tiktok.js` |
| Tách `variation_value` (đề xuất, chưa chốt) | `adapters/tiktok.js` |

**Nghiệm thu (đo trên file thật, không phải fixture tự chế):**
- 124 sản phẩm · 641 biến thể · **0 nhóm bị từ chối**;
- **299** lượt tải ảnh được xếp hàng, **không phải 1.557**;
- 0/641 mô tả còn chứa `<` hoặc `&nbsp;`;
- sản phẩm 16 SKU ra **2 trục**, sản phẩm 7 SKU ra **1 trục**;
- `sku` sinh ra **không trùng** trong shop và **đọc được** (không phải chuỗi 19 chữ số);
- `weight_gram` = 200 cho vòng tay — **không phải 200000**.

> **Bẫy fixture (`docs/45`, `CLAUDE.md §4`):** dữ liệu thử "đẹp" che lỗi. File 641 dòng này có
> lỗi chính tả thật (`vừa cổ`/`vừa cồ`), có cột rỗng 100%, có mô tả HTML. **Dùng chính nó làm
> fixture**, đừng tự sinh file sạch.

---

### Đợt 3 — Màn hình + lưu tham chiếu

**Mục tiêu:** người bán **đặt tên trục**, xem kết quả tách, và nhập lại cùng file không tạo bản sao.

| việc | file |
|---|---|
| Migration `0152_product_source_refs.sql` | `packages/db/migrations/` |
| Ghi `product_source_refs` lúc commit | `import.js` |
| Chặn trùng theo `(source, kind, external_id)` | `import.js` |
| Màn Xem trước: ô đặt tên trục + bảng tách + nút tắt tách | `seller-admin/src/pages.js` |
| Hiện rõ cột bỏ qua (đã có `inspectColumns`) | `pages.js` |

**Nghiệm thu:**
- nhập cùng file **2 lần** → lần 2 báo *"124 sản phẩm đã nhập trước đó, bỏ qua"*, DB **không**
  tăng thêm sản phẩm nào;
- đổi tên trục ở Xem trước → `product_options.name` đúng như đã gõ;
- tắt tách ở một sản phẩm → SP đó thành 1 trục, giá trị giữ nguyên dấu phẩy;
- `schema-invariants.test.js` **xanh** (bảng mới có policy, `app_rw` không dùng `USING (true)`);
- `tenant-isolation.test.js` **xanh** cho bảng mới — shop A không thấy ref của shop B.

---

### Đợt 4 — Upsert *(chủ dự án ĐÃ chốt làm — §9.1)*

**Mục tiêu:** nhập lại file mới hơn để cập nhật giá/tồn/nội dung, không tạo bản sao, **không phá
dữ liệu và không xoá gì**.

Đợt này **phải làm trọn §5.5** — đó là danh sách kiểm, không phải gợi ý.

| việc | file bị chạm |
|---|---|
| Chọn chế độ: `create_only` (**mặc định**) · `update_only` · `upsert` | `import.js`, `pages.js` |
| Bảng sở hữu trường §5.4 | `import.js` |
| Màn **khác biệt**: SKU · trường · hiện tại → mới · hành động | `pages.js` |
| Bắt buộc xem khác biệt khi có **bất kỳ** thay đổi giá | `pages.js`, `server.js` |
| Tính lại `products.price_vnd` = min(biến thể) sau mỗi lần sửa giá | `catalog.js` |
| Kiểm lại `compare_at > price` trên **dữ liệu đã có**, không chỉ dòng mới | `import.js` |
| Tồn: **`adjust` qua `inventory_ledger`**, không `UPDATE` thẳng `on_hand` | `import.js`, `inventory.js` |
| Từ chối hạ tồn xuống dưới `reserved`, kèm lý do | `import.js` |
| Biến thể vắng mặt: **báo cáo, không xoá** | `import.js`, `pages.js` |
| Thay ảnh: xoá dòng `media` cũ **tường minh** (gc không lo hộ) | `media.js` |
| `upsert` **không** tính vào trần gói | `catalog.js` |
| Sự kiện audit riêng `product.updated_by_import` | `db.js` |

**Nghiệm thu — mỗi dòng là một test:**
- `create_only` + file đã nhập → **0 thay đổi**;
- `upsert` + file sửa giá 1 SP → **đúng 1 dòng** trong bảng khác biệt, và
  `products.price_vnd` **đổi theo** nếu đó là biến thể rẻ nhất;
- nâng giá lên **cao hơn** `compare_at_price` đang có → **từ chối kèm lý do**, không tạo badge âm;
- `upsert` sửa tồn → `inventory_ledger` có **đúng một** dòng `adjust`, và
  `sum(delta) == on_hand` vẫn đúng;
- hạ tồn xuống **dưới `reserved`** → **từ chối dòng đó**, các dòng khác vẫn vào;
- file thiếu 3 biến thể đang có → **0 biến thể bị xoá**, màn khác biệt **báo đủ 3**;
- `cost_vnd` · `slug` · `variants.sku` **không đổi** trong mọi chế độ;
- đơn cũ: `order_lines.unit_price_vnd` và `sku_snapshot` **không nhúc nhích** sau upsert;
- đột biến: gỡ chốt sở hữu trường → test giá **phải ĐỎ**; gỡ chốt `reserved` → test tồn **ĐỎ**.

---

## 7. Test bắt buộc

Theo `CLAUDE.md §4`: một chốt chỉ được coi là có test khi **có đột biến gỡ nó và test ĐỎ**, và
ca thử phải đi qua **đúng** chốt đó.

**Unit** (`node --test`, chạy mọi commit — nhớ sửa `MANIFEST_UNIT_COUNT`):

| bộ | canh gì |
|---|---|
| `adapters/tiktok.test.js` | 641 dòng → 124 SP; tách trục; sinh sku; danh mục |
| `html-to-text.test.js` | `<br>`→`\n`; `</p>`→`\n\n`; `&nbsp;`; rút `<img>`; **không** để lọt `<script>` |
| `xlsx-read.test.js` | dò dòng tiêu đề; 5 dòng meta không thành dữ liệu; file giả bị từ chối |
| `xlsx-guard.test.js` | zip bomb · zip-slip (`..`) · `<!DOCTYPE`/`<!ENTITY` · trần entry/dòng/cột |
| `tiktok-weight.test.js` | `parcel_weight` **không** bị nhân 1000 — bất biến riêng vì đây là **sai tiền** |
| `import-field-owner.test.js` | bảng sở hữu trường §5.4 — `cost_vnd`/`slug`/`sku` không bao giờ đổi |
| `batch-split.test.js` | chia lô **không cắt giữa một `product_id`** |

**E2E** (nhớ sửa `MANIFEST_E2E_COUNT`):

| bộ | canh gì |
|---|---|
| `import-tiktok.e2e.mjs` | file thật → 124/641; ảnh xếp hàng **299**; mô tả sạch |
| `import-tiktok-idem.e2e.mjs` | nhập 2 lần → không nhân đôi |
| `import-tiktok-upsert.e2e.mjs` | sửa giá → `products.price_vnd` theo kịp; `compare_at` vô lý bị chặn |
| `import-tiktok-stock.e2e.mjs` | tồn qua `inventory_ledger`; `sum(delta)==on_hand`; chặn xuống dưới `reserved` |
| `import-tiktok-nodelete.e2e.mjs` | biến thể vắng mặt **không bị xoá**; đơn cũ giữ nguyên snapshot |
| `import-tiktok-isolation.e2e.mjs` | shop A nhập, shop B **không** thấy gì |

**Bất biến DB:** bảng mới phải qua `schema-invariants` + `tenant-isolation` sẵn có.

**Hồi quy bắt buộc** (upsert chạm giá/tồn nên kéo theo cả vùng tiền): `dashboard` · `reports`
P&L · `promotions`/flash sale · `checkout` (đặt hàng khi tồn vừa đổi) · `owed` (công nợ).

**Cổng:** đụng migration + gói dùng chung + nhiều service ⇒ **cổng đầy đủ** (`CLAUDE.md §5`),
`bash scripts/ci-local.sh` exit 0.

---

## 8. Cố ý CHƯA làm — và ngưỡng để làm

| việc | vì sao hoãn | ngưỡng |
|---|---|---|
| Thuộc tính động (`attributes{}`) | đo được: 1 thuộc tính có dữ liệu, 1 giá trị duy nhất | ≥3 shop có `product_property/*` > 30% |
| Cột JSONB trên `products` | phá nguyên tắc GRANT-mở-cột (§4.3a) | không làm — đã có bảng riêng |
| Bảng mapping trong DB | mapping-as-code test tốt hơn, chưa ai cần tự khai | người bán cần tự khai mapping |
| Danh mục 3 cấp (file batchupload) | vượt trần 2 cấp của `0095` | khi hỗ trợ đường đăng-mới |
| Gọi thẳng **TikTok Product API** | cần app đối tác + người bán cấp quyền; `docs/45 §2` đã cân nhắc | có ≥10 shop di cư và file thủ công thành nút thắt |
| `brand` · kích thước kiện | 0% trong file thật | có file thật điền chúng |
| Nhập **đơn hàng** TikTok | khác hẳn danh mục; `docs/45 §8` đã có đường cho đơn di cư | riêng đợt |

---

## 9. Bốn quyết định — ĐÃ CHỐT

### 9.1 Upsert: **CÓ** *(chủ dự án chốt)*

Kèm ba hàng rào bắt buộc ở §4.3(d) và toàn bộ §5.5. Không có hàng rào thì không bật.

### 9.2 Trần: **đếm theo SẢN PHẨM** *(chủ dự án chốt)*

`IMPORT_MAX_PRODUCTS = 1000`, bỏ trần theo dòng. Đơn vị người bán nghĩ tới là sản phẩm, và
`docs/45 §4.6` đã chốt đơn vị "một phần" là sản phẩm chứ không phải dòng.

⚠️ Chưa đủ một mình — §5.5(7) đo được 5.000 SP ≈ 53 MB JSON, vượt `maxBody` 26 lần. **Phải kèm
chia lô ở BFF, cắt đúng ranh giới `product_id`.**

### 9.3 Ảnh nhúng trong mô tả: **rút ra thư viện ảnh**

Chọn phương án (b) của §3.2. Lý do — theo thứ tự quan trọng:

1. **Dùng lại nguyên đường ống đã có**, không thêm đường mã nào: `media` `pending` → worker →
   `net-guard` (8 lớp SSRF) → `sharp` re-encode WebP → bỏ EXIF/GPS. Đường này đã có test, đã
   chạy, đã qua kiểm toán.
2. **Không phá ADR-008 / CSP.** Giữ thẻ `<img>` trỏ `ibyteimg.com` là tài nguyên ngoài — CSP
   chặn, ảnh vỡ, và tạo phụ thuộc vĩnh viễn vào CDN TikTok cho một shop đã rời TikTok.
3. **Không mất thông tin**, khác hẳn phương án bỏ hẳn.
4. Khối lượng nhỏ: đo được **4 thẻ, 1 URL riêng** trên 641 dòng.

Xếp **cuối** thư viện, sau `main_image` và `image_2..9` — ảnh trong mô tả là ảnh minh hoạ, không
phải ảnh trưng bày, không được cướp vị trí ảnh bìa.

### 9.4 Đọc `.xlsx`: **tự dựng bộ đọc tối thiểu, zero-dep**

Theo đúng lập luận đã viết sẵn trong `zip.js` cho chiều ngược lại:

> *"Thêm archiver/jszip = kéo phụ thuộc + phải regen lockfile (Dockerfile dùng `npm ci`). Ta chỉ
> đóng gói vài file CSV nhỏ → tự ghi định dạng ZIP bằng `zlib.deflateRawSync`."*

Chiều đọc cũng vậy: `zlib.inflateRawSync` có sẵn, và ta chỉ cần **ba tệp** trong gói xlsx —
`xl/workbook.xml`, `xl/worksheets/sheet1.xml`, `xl/sharedStrings.xml`. Không cần công thức,
không cần định dạng, không cần biểu đồ.

**Nhưng phải nói thẳng: ĐỌC nguy hiểm hơn GHI.** `zip.js` ghi dữ liệu của chính ta; bộ đọc này
ăn tệp của **người lạ trên Internet** (self-serve signup — `docs/43`). Sáu hàng rào bắt buộc,
cùng tinh thần `net-guard`:

| hàng rào | chặn gì |
|---|---|
| Trần **tổng kích thước giải nén** (đề nghị 200 MB) + trần tỉ lệ nén (1:100) | zip bomb |
| Trần **số entry** | zip có triệu tệp rỗng |
| Chuẩn hoá đường dẫn entry, **từ chối** `..` và đường tuyệt đối | zip-slip |
| **Từ chối** `<!DOCTYPE` và `<!ENTITY`, không bao giờ giải thực thể ngoài | XXE, billion laughs |
| Chỉ đọc **đúng ba tệp** trên, bỏ qua phần còn lại | giảm mặt tấn công |
| Trần **số dòng / số cột** trước khi cấp phát | OOM |

**Không viết bộ phân tích XML tổng quát.** Chỉ cần bộ quét theo thẻ cho `<row>`/`<c>`/`<v>`/`<t>`
— hẹp hơn, kiểm được hết, và không có chỗ cho thực thể ngoài.

**Đường lùi nếu bộ đọc phình quá ~400 dòng:** dừng lại, thêm thư viện, ghi lý do vào commit —
nhưng ghim phiên bản, đưa vào `security-scan.sh`, và biết trước rằng SheetJS có lịch sử CVE
(prototype pollution, ReDoS) đúng ở đường nhận tệp từ người lạ.

---
