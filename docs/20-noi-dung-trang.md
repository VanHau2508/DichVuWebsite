# Trang nội dung/chính sách — Ngày 11

> **Trạng thái: ĐÃ CHẠY từ cold start.**
> content e2e: 34/34 · mutation: 4/4 lớp phòng thủ (gỡ → đỏ) + 3/3 quyền append-only.
> **Preview bản nháp (§8): e2e 23/23 · mutation 5/5 + 8/8 cấu trúc RLS/quyền/cột · rà soát đối kháng 4 chiều.**
> **SEO meta theo trang (§9): e2e 25/25 · mutation 2/2 + 4/4 cấu trúc quyền cột · rà soát đối kháng 2 chiều.**
> **Kéo–thả section (§10): e2e 25/25 · mutation 2/2 · rà soát đối kháng 2 chiều. Không migration (dùng lại blocks jsonb).**
> Không hồi quy: storefront e2e 16/16, seller e2e 25/25, catalog e2e 29/29, rbac unit 8/8, schema-invariants 14/14.

Mảnh còn thiếu của kế hoạch 20 ngày: trang tĩnh do người bán tự soạn (giới thiệu,
chính sách đổi trả, bảo hành…) với **draft → publish → rollback** và menu chân trang.
Đây là feature duy nhất trong V1 có mô hình **bản nháp tách bản xuất bản** — nên nó
là nơi phải cẩn thận nhất về "cái gì công khai, cái gì chưa".

## 1. Thành phần

| Nơi | Nội dung |
|---|---|
| `0016_content_pages.sql` | bảng `pages` (draft) + `page_revisions` (append-only) + RLS app_rw/app_store |
| `apps/seller/src/content.js` | CRUD trang, publish, rollback, menu — perm `content.read/write` |
| `apps/seller/src/rbac.js` | thêm `content.read`, `content.write` (owner+admin có; catalog/order không) |
| `apps/storefront/src/server.js` | route `/pages/:slug` + nạp menu chân trang (chỉ bản published) |
| `apps/storefront/src/theme.js` | `renderPage` (block text-only, escape) + menu trong footer |

## 2. Mô hình dữ liệu: draft tách bản xuất bản

- **`pages.blocks`** = bản **DRAFT** đang sửa. Luôn sửa được, PATCH bao nhiêu lần tuỳ ý.
  Sửa draft **không** ảnh hưởng gì tới storefront.
- **Publish** = chụp ảnh (`snapshot`) draft hiện tại thành một dòng mới trong
  `page_revisions` (revision tăng dần), rồi trỏ `pages.published_revision_id` tới đó
  và đặt `status='published'`.
- **Storefront chỉ đọc bản published** — nội dung lấy từ `page_revisions` mà
  `published_revision_id` trỏ tới, **không** đọc `pages.blocks`. Đây là bất biến then chốt.
- **Rollback(revision)** = trỏ `published_revision_id` về một revision cũ. **Không đụng
  draft** — người bán vẫn còn nguyên bản đang sửa dở.

`page_revisions` là **append-only**: `REVOKE UPDATE, DELETE ... FROM app_rw`. Lịch sử
xuất bản không được viết lại. Kiểm chứng bằng `has_table_privilege` (verify script §3):
app_rw chỉ có `INSERT`/`SELECT`, không `UPDATE`/`DELETE`.

FK vòng (`pages.published_revision_id → page_revisions` và `page_revisions.page_id →
pages`) xử lý bằng `ALTER TABLE ADD CONSTRAINT` sau khi cả hai bảng tồn tại; cột nullable
+ MATCH SIMPLE nên trang draft (chưa có revision) không vướng ràng buộc.

## 3. Bốn lớp phòng thủ (mỗi cái có e2e + mutation)

1. **Storefront chỉ hiện bản PUBLISHED** — query join `page_revisions` qua
   `published_revision_id`, cộng RLS `store_pages` (`status='published' AND deleted_at
   IS NULL`). Mutation "đọc draft thay published" → e2e đỏ (sửa draft mà bản live đổi theo).
2. **Block text-only được escape** — `renderPage` chỉ render `heading`/`paragraph`,
   `esc(b.text)` mọi nội dung; type lạ bị bỏ. Mutation bỏ escape → `<script>` lọt → đỏ.
   (Nối tiếp ADR-008: shop không chèn HTML/JS/CSS tuỳ ý; nội dung là block có kiểu.)
3. **Rollback không ghi đè draft** — `rollbackPage` chỉ `UPDATE published_revision_id`.
   Mutation cho nó ghi luôn `blocks` → mất bản đang sửa → đỏ.
4. **RBAC content.read/write** — owner+admin có; catalog_manager/order_manager không.
   Mutation cấp nhầm quyền cho catalog_manager → nó tạo được trang → đỏ.

Thêm hai bất biến kiểm bằng e2e (không mutation riêng vì đã do RLS/tenant lo, đã có
mutation ở `verify-tenant-isolation`/`verify-storefront`):
- **Cô lập tenant**: shop A và shop B cùng slug `chinh-sach`, storefront mỗi bên chỉ
  thấy nội dung của mình; owner B GET trang A → 404.
- **Soft delete**: `deleted_at` → biến mất khỏi storefront và menu, dữ liệu còn trong DB.

## 4. Menu chân trang

- `pages.menu_position` (int, NULL = không lên menu). Menu = các trang **đã published**
  có `menu_position`, sắp theo vị trí.
- Tiêu đề trên menu lấy từ **bản published** (`page_revisions.title`), không phải draft
  → khớp đúng nội dung người xem thấy khi bấm vào.
- Menu nạp một lần trong `withStore`, đưa vào mọi trang (home/product/category/page).

## 5. API seller (đều dưới `/shops/:id`)

| Method | Path | Perm | Việc |
|---|---|---|---|
| GET | `/pages` | content.read | liệt kê (draft+published, menu_position) |
| POST | `/pages` | content.write | tạo trang draft `{slug,title,blocks}` |
| GET | `/pages/:pid` | content.read | chi tiết: draft + published_revision + lịch sử |
| PATCH | `/pages/:pid` | content.write | sửa draft (title/blocks/menu_position) |
| POST | `/pages/:pid/publish` | content.write | snapshot draft → revision mới |
| POST | `/pages/:pid/rollback` | content.write | trỏ published về `{revision}` cũ |
| DELETE | `/pages/:pid` | content.write | soft delete |

Validation: slug `^[a-z0-9-]$` duy nhất trong shop (409 nếu trùng), tiêu đề 1–200 ký tự,
block hợp lệ theo type (xem §10), tối đa 100 block. Mọi ghi đều `audit()`.
`content.write` **không** cần step-up (không phải thao tác tiền/quyền/domain).

## 6. Ghi chú kiến trúc

Mô hình revision/publish/rollback đầy đủ ở tầng DỮ LIỆU; thao tác kéo–thả section (§10)
xây trên đúng tầng đó (id block + reorder), không đổi schema hay bất biến bảo mật — vẫn là
**registry section có kiểu**, không HTML/JS tuỳ ý (ADR-008). Vì chưa có framework UI admin,
"kéo–thả" hiện thực ở tầng API (thao tác section server-side mà editor kéo–thả sẽ gọi).

Lưu ý tương phản với theme (ADR-009 cắt draft/preview theme): theme do **bạn** cấu hình
cho khách nên sửa trực tiếp; còn trang nội dung do **người bán** tự soạn và dễ đăng nhầm
bản dở, nên draft/publish ở đây là đáng giá, không phải tiện nghi.

## 7. Còn thiếu (ngoài phạm vi Ngày 11)

- Block ảnh / nút / HTML nhúng và `og:image` theo trang — cần chọn/tải asset cho trang nội
  dung; các section text (heading/paragraph/list/quote/divider) + title/description đủ cho pilot.
- UI kéo–thả thật trên trình duyệt (khi dựng frontend admin) — API section đã sẵn (§10).

## 8. Xem trước bản nháp (preview) trên storefront

**Bài toán khó:** storefront (`app_store`) BỊ CẤM VỀ CẤU TRÚC đọc `pages.blocks` (draft) —
policy `store_pages` chỉ cho `published`. Đó là bất biến bảo mật, không được nới. Vậy
làm sao xem trước bản nháp *trên chính storefront* mà không mở cửa cho công khai thấy draft?

**Cách chọn — token snapshot (migration `0017_page_previews.sql`):**
- Seller (đã xác thực, `content.read`) `POST /shops/:id/pages/:pid/preview` → **chụp ảnh**
  draft hiện tại vào bảng mới `page_previews` + trả **token ngẫu nhiên 256-bit** (lưu HASH,
  TTL 30 phút). Trả `preview_url = https://<domain>/pages/<slug>?preview=<token>`.
- Storefront `/pages/:slug?preview=<token>` đọc **SNAPSHOT** từ `page_previews` (KHÔNG bao
  giờ đọc `pages.blocks`), render kèm banner **"BẢN NHÁP"**, header `Cache-Control: no-store`
  + `X-Robots-Tag: noindex` (không CDN cache, không SEO index).

**Vì sao snapshot chứ không đọc draft trực tiếp** (đối chiếu các lựa chọn đã cân nhắc):
- *Đọc draft trực tiếp qua policy nới lỏng* (thêm `id = current_setting('app.preview_page_id')`
  vào `store_pages`): cho preview "sống" nhưng phải **sửa policy đã mutation-test**, rủi ro
  hồi quy vào bảo đảm published-only. Loại.
- *Render preview trong seller-admin* (app_rw đọc được draft): phải nhân bản/ chia sẻ theme
  engine (rủi ro preview khác thật). Và yêu cầu là "trên storefront". Loại.
- *Snapshot* (đã chọn): **cộng thêm** một bảng, KHÔNG đụng policy cũ; công khai vẫn tuyệt
  đối không đọc được `pages.blocks`; chỉ nội dung seller CHỦ ĐỘNG cho preview + có token
  mới lộ. Và "preview = đúng thứ Publish sẽ tạo ra" (cả hai đều snapshot draft).

**Năm lớp phòng thủ (mỗi cái có e2e + mutation `verify-preview.sh`):**
1. **Không token → không thấy gì** — nhánh preview chỉ chạy khi `?preview=<token>` khác rỗng;
   không token/token rỗng → luồng published bình thường (draft chưa publish vẫn 404).
2. **Token ràng với slug** — `WHERE token_hash=$1 AND slug=$2` → token không dùng lại được ở URL khác.
3. **Token lưu HASH** — storefront hash token rồi mới tra; DB lộ cũng không có token dùng được.
4. **Không CDN / không index** — preview trả `no-store` + `noindex` (khác trang published cache CDN).
5. **RBAC** — chỉ `content.read` (owner/admin) mới cấp được link preview.

**Hai bất biến do RLS lo (chứng minh bằng kiểm cấu trúc, không phải mutation code):**
- **Cô lập tenant**: `store_preview USING (shop_id = current_shop_id() ...)` → token shop A
  vô hình ở domain shop B (e2e chứng minh 404).
- **Hết hạn**: `expires_at > now()` ở RLS (không chỉ ở query) → dù code quên lọc, DB vẫn giấu.

**Vòng đời:** snapshot **đóng băng** lúc bấm preview; sửa draft xong bấm lại (upsert theo
`(shop_id,page_id)`) → token cũ chết, token mới hiện bản mới. Xoá trang → xoá luôn preview
(link chết ngay). Publish độc lập: preview luôn hiện draft, công khai luôn hiện published.

**Đánh đổi (ghi rõ):** preview là snapshot, không phải draft "sống" — bấm lại để làm mới.
Token nằm trong URL (như link reset mật khẩu / link chia sẻ không đoán được): bù lại bằng
TTL ngắn + `no-store` + `noindex` + `Referrer-Policy` (không rò token sang origin ảnh).

### 8.1. Rà soát đối kháng (4 chiều) + siết cấu trúc lôi ra

Chạy workflow review 4 lăng kính (rò draft / cô lập tenant / cache-CDN / token) → mỗi
finding được một agent khác **phản biện để bác**. 6 finding thô → **5 bị bác, 1 REAL mức
`info`** (cấp preview đồng thời cho cùng một trang → upsert last-writer-wins làm token cũ
chết): đây là **thiết kế cố định** (một preview/trang, bấm lại để làm mới) và e2e §5 đã
khẳng định — không phải lỗi, không ảnh hưởng bảo mật.

Hai điều đáng làm mà review lôi ra:

1. **Siết cột (migration `0018`).** RLS lọc HÀNG chứ không lọc CỘT: trang đã published thì
   `app_store` thấy được HÀNG, kèm cả `pages.blocks`/`pages.title` = bản DRAFT. Storefront
   không hề đọc hai cột đó, nhưng quyền cột vẫn mở → một `SELECT blocks FROM pages` tương lai
   sẽ vô tình lộ draft. Sửa: grant theo cột, `app_store` đọc mọi cột TRỪ `blocks`/`title`.
   Giờ "công khai không đọc được draft" đúng VỀ CẤU TRÚC (kiểm bằng `has_column_privilege` =
   false, có trong `verify-preview.sh`). *Đây là điểm yếu tiềm ẩn từ 0016, review lôi ra.*

2. **Token trong access.log (rủi ro chấp nhận được).** Caddy log JSON ghi cả query string →
   `?preview=<token>` nằm trong `/var/log/caddy/access.log` (giữ ~30 ngày). Nhưng **token chết
   theo TTL 30 phút** — token trong log hết dùng được đúng lúc nó hết hạn; log chỉ ops truy
   cập trên host tin cậy; token chỉ mở một trang một shop. Cùng hạng với link reset trong log:
   chấp nhận, không đổi kiến trúc (link preview kiểu URL-token là chuẩn ngành).

## 9. SEO meta theo trang

Trang nội dung có `seo_title` + `seo_description` do người bán nhập (migration `0019`).
Storefront render vào `<head>`: `<title>`, `<meta name="description">`, Open Graph (`og:title`
/`og:description`/`og:type=article`/`og:url`/`og:site_name`), Twitter card, và `<link rel="canonical">`.

**SEO là NỘI DUNG → versioned y như blocks.** Đây là điểm mấu chốt: nếu để `seo_*` ngoài
revision, sửa draft sẽ đổi luôn SEO của bản đang chạy → vỡ bất biến "chưa publish chưa live".
Nên `seo_title`/`seo_description` có mặt ở cả `pages` (draft), `page_revisions` (chụp khi
publish) và `page_previews` (chụp khi preview); rollback tự khôi phục vì trỏ lại revision cũ.
Storefront published đọc `pr.seo_*`, preview đọc `page_previews.seo_*`, KHÔNG bao giờ đọc
`pages.seo_*` — và `app_store` cũng không có quyền cột đó (0018 không liệt kê) nên SEO draft kín.

**Escape thuộc tính (chống injection):** mọi giá trị do người bán nhập đổ vào `<head>` đều
`esc()` — kể cả trong `content="..."` và `href="..."` (esc escape cả `"` và `'` → không breakout
attribute; escape `<>` → không breakout `</title>`). `verify-seo.sh` gỡ escape → e2e đỏ.

**Canonical không nhận Host giả:** `canonical = https://<host><path>`, mà `<host>` phải là
domain ĐÃ verified (nếu không `resolveShop` trả 404 trước khi render) → không chèn Host tuỳ ý.
Canonical/og:url dùng `url.pathname` (không kèm query) → preview không lộ token; preview đặt
`robots noindex` thay canonical.

**Fallback:** thiếu `seo_title` → `"<Tiêu đề trang> — <Tên shop>"`; thiếu `seo_description` →
suy từ text block đầu (cắt ~200 ký tự). Giới hạn: title ≤ 120, description ≤ 320.

## 10. Kéo–thả section

Vì chưa có framework UI admin, "kéo–thả" hiện thực ở **tầng API** — các thao tác section
mà một editor kéo–thả sẽ gọi. **Không cần migration**: dùng lại `blocks jsonb` sẵn có, nên
mọi thứ vẫn chạy qua đúng mô hình versioned (draft → publish → revision → preview → rollback).

**Block có id ổn định.** Mỗi section được gán `id` (UUID) khi tạo — kéo–thả cần id để tham
chiếu "section đang kéo". `normalizeBlocks` gán id, **CHỈ giữ field hợp lệ theo type** (bỏ mọi
key lạ → không lưu rác/độc), và cấp id mới nếu client gửi id không hợp lệ/trùng.

**Registry section mở rộng** (ADR-008 — có kiểu, không HTML tuỳ ý): `heading`, `paragraph`,
`list` (`items[]` ≤ 50, mỗi ≤ 500), `quote` (`text` + `cite?`), `divider`. Storefront render
bằng component riêng, **mọi text `esc()`** (list `<li>`, quote `<blockquote>/<cite>`).

**Thao tác section (đều `content.write`, đọc–sửa–ghi `pages.blocks` dưới `FOR UPDATE`):**

| Method | Path | Việc |
|---|---|---|
| POST | `/pages/:pid/blocks` | thêm section `{type,…, index?}` → trả `id` |
| PATCH | `/pages/:pid/blocks/:bid` | sửa nội dung một section (giữ id + vị trí) |
| DELETE | `/pages/:pid/blocks/:bid` | xoá một section |
| POST | `/pages/:pid/blocks/reorder` | **kết quả kéo–thả**: `{order:[id,…]}` |

**Reorder chỉ nhận HOÁN VỊ đúng** của tập id hiện có (đủ số, đủ tập, không lặp) → không thể
lén thêm/bớt/nhân bản section hay chèn id của trang khác qua reorder (mutation gỡ kiểm này → đỏ).

**Bất biến giữ nguyên:** thao tác chỉ đụng DRAFT (muốn lên live phải publish — e2e chứng minh
sắp lại draft không đổi bản published); cô lập tenant qua `withTenant`/RLS (shop khác → 404);
`FOR UPDATE` chống mất cập nhật khi hai thao tác đồng thời; trần 100 block giữ ở cả add lẫn bulk.
