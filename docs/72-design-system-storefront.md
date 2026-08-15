# 72 — Design System: Cửa hàng công khai (storefront)

> Anh em với [`44-design-system-seller-dashboard.md`](44-design-system-seller-dashboard.md).
> **44 là bảng điều khiển người bán · 72 là cửa hàng khách mua.** Hai nơi khác nhau về mục tiêu
> nên khác nhau về ngôn ngữ thiết kế — đừng chép qua lại.
>
> Liên quan: [`13-storefront`](13-storefront.md) · [`24-buyer-checkout-ui`](24-buyer-checkout-ui.md) ·
> [`04-ADR`](04-quyet-dinh-kien-truc-adr.md) (ADR-008 không JavaScript) · `packages/presets/src/index.js`

---

## 0. Vì sao có tài liệu này — số đo

`docs/44` ra đời cho seller-admin và **quy định 22 token màu**. Storefront chưa từng có tài liệu
tương đương, và hậu quả đo được trên `apps/storefront/src/theme.js`:

| số đo | hôm nay | vấn đề |
|---|---:|---|
| dùng `var(--color-*)` | **436 lần** | ✅ hệ thống chủ đề **đang chạy tốt** |
| mã màu cứng | 120 lần / **39 màu riêng** | mỗi màu cứng là một chỗ **không đổi theo shop** |
| `rgba()` cứng | 60 lần | phần lớn là bóng đổ và lớp phủ |
| **giá trị `padding` riêng** | **99** | ⚠️ **không có nhịp khoảng cách nào** |
| cỡ chữ riêng | **~20** | ⚠️ xem §0.1 |
| `border-radius` riêng | 23 | trong khi chỉ cần 5 bậc dẫn xuất từ `--radius` |

**Kết luận quan trọng nhất: hệ thống token màu KHÔNG hỏng.** 436/556 ≈ **78% màu đã qua token**.
Chỗ vỡ nằm ở **thang chữ** và **nhịp khoảng cách** — hai thứ chưa ai viết ra nên ai cũng tự chế.

### 0.1 Thang chữ hiện tại — chỗ hỏng rõ nhất

Đếm thật trong `theme.js`:

```
.9rem (20 lần) · .85rem (15) · .88rem (13) · .92rem (12) · 1rem (8) · .82rem (8)
.8rem (6) · .86rem (5) · 1.05rem (4) · .74rem (4) · 1.8rem (3) · 1.7rem (3)
1.5rem (3) · 1.1rem (3) · 1.02rem (3) · .95rem (3) · 2rem (2) · clamp(2rem,3.8vw,3.1rem) (2)
```

Nhìn kỹ khoảng `.8 → 1.05rem`: có **`.8` `.82` `.85` `.86` `.88` `.9` `.92` `.95` `1` `1.02` `1.05`**.

**Mười một cỡ chữ trong một khoảng 4px.** `.85rem` và `.86rem` lệch nhau **0,16px** — không mắt
người nào phân biệt được, nhưng mười một biến thể thì đủ để **không màn nào có nhịp giống màn
nào**. Đây chính là thứ khiến giao diện "nhìn không chuyên" mà không ai chỉ ra được tại sao.

Không phải lỗi thẩm mỹ. Là **thiếu một quy tắc**, nên mỗi lần thêm màn hình lại chỉnh tay cho
"vừa mắt", và mỗi lần vừa mắt ở một cỡ khác.

---

## 1. Nguyên tắc nền: cái gì THEO SHOP, cái gì CỐ ĐỊNH

Đây là điểm khác biệt lớn nhất với `docs/44`. Seller-admin là **một** ứng dụng nên 22 token cố
định. Storefront là **N cửa hàng**, mỗi shop một thương hiệu.

```
        THEO SHOP (11 khoá — preset + shop tự sửa)          CỐ ĐỊNH (nền tảng giữ)
        ────────────────────────────────────────            ──────────────────────
        9 màu:  primary · primary-dark · accent             thang chữ
                bg · surface · hero-bg                      nhịp khoảng cách 4px
                text · muted · border                       giải phẫu thành phần
        radius: 0px … 12px                                  màu ngữ nghĩa (§2.2)
        spacing: 16px … 20px                                trạng thái & tiêu điểm
                                                            quy tắc tiếng Việt
```

**Luật:** shop đổi được **thương hiệu**, không đổi được **tay nghề**.

Màu, độ bo, mật độ là chuyện của shop. Còn nhịp chữ, khoảng thở, thứ tự tab, tương phản là
chuyện của nền tảng — shop chọn preset "Mỹ phẩm" không có nghĩa là được phép có chữ 13,6px.

> **Hệ quả cho người viết mã:** thấy mình gõ một mã màu hex trong `theme.js`, dừng lại và hỏi:
> *"Màu này có nên đổi theo shop không?"* Có → phải là `var(--color-*)`. Không → phải nằm trong
> danh sách §2.2, không được bịa thêm.

### 1.1 Hệ thống phải SỐNG ĐƯỢC qua cả 5 preset

| preset | primary | radius | spacing | tính cách |
|---|---|---:|---:|---|
| Thời trang | `#17171a` gần đen | **0–2px** | 18px | editorial, tương phản cao |
| Thực phẩm | `#0272ba` xanh dương | 8px | 16px | tươi, ấm |
| **Nội thất** | `#446084` slate | **0px** | 20px | showroom, **góc vuông tuyệt đối** |
| **Mỹ phẩm** | `#f36b7d` hồng | **12px** | 16px | mềm, nữ tính |
| Khác | `#1f2933` than | 8px | 18px | trung tính |

Bất kỳ quy tắc nào trong tài liệu này **phải đúng ở cả hai cực**: `radius: 0px` (Nội thất) lẫn
`radius: 12px` (Mỹ phẩm); nền gần đen (Thời trang) lẫn hồng nhạt (Mỹ phẩm).

**Cách kiểm nhanh khi thiết kế:** dựng màn hình ở preset **Nội thất** và **Mỹ phẩm** cạnh nhau.
Đẹp ở cả hai thì quy tắc đúng. Chỉ đẹp ở một bên thì bạn đang thiết kế cho *một* shop, không
phải cho nền tảng.

---

## 2. Màu

### 2.1 Hợp đồng 9 token theo shop

```
--color-primary       nút chính, link, giá, chỉ báo đang chọn
--color-primary-dark  hover/pressed của primary
--color-accent        nhấn tiết chế: nhãn "Giảm giá", chấm flash sale. TIẾT CHẾ TỐI ĐA
--color-bg            nền trang
--color-surface       nền thẻ, thanh lọc, ô input
--color-hero-bg       nền dải hero (thường sáng hơn/tối hơn bg một bậc)
--color-text          chữ chính
--color-muted         chữ phụ, mô tả, timestamp
--color-border        viền, đường kẻ
```

Hợp đồng này do `packages/presets/src/index.js` cưỡng chế (`presets.test.js` canh) — **không
thêm khoá màu thứ 10** mà chưa sửa preset + test cùng commit.

### 2.2 Màu ngữ nghĩa — CỐ ĐỊNH, không theo shop

Trạng thái là **thông tin**, không phải thương hiệu. Shop bán mỹ phẩm không được có màu "hết
hàng" hồng dễ thương — khách cần đọc trạng thái giống nhau ở mọi cửa hàng.

| vai trò | màu | dùng ở |
|---|---|---|
| Còn hàng / thành công | `#00B578` | chấm "Còn hàng", xác nhận đặt hàng |
| Sắp hết | `#FF8F1F` | "Chỉ còn 2 sản phẩm" |
| Hết hàng / lỗi | `#E8302F` | "Hết hàng", lỗi form, nút bị chặn |
| Nền nhạt tương ứng | `#E8F8F2` · `#FFF7E8` · `#FFF1F0` | nền chip trạng thái |

**Bốn màu + ba nền = 7 mã cứng được phép.** Ngoài ra không mã cứng nào khác, trừ hai ngoại lệ
§2.3.

> **Quy tắc không được phá:** trạng thái **luôn đi kèm CHỮ**, không bao giờ chỉ có màu. Khoảng
> 8% nam giới Việt Nam mù màu đỏ-lục; một chấm đỏ không chữ là thông tin không tồn tại với họ.
> Đây cũng là lý do `docs/44 §1` đã có cùng luật.

### 2.3 Hai ngoại lệ được phép dùng màu không token

1. **Bóng đổ và lớp phủ** — `rgba(0,0,0,α)` hoặc `rgba(255,255,255,α)`. Bóng phải trong suốt để
   nằm đúng trên mọi nền shop; bóng bằng màu đặc sẽ vỡ khi shop đổi `--color-bg`.
2. **Logo/biểu tượng kênh bên thứ ba** (Zalo, Messenger, Facebook) — màu thương hiệu của họ,
   đã có biến `--c` riêng trong `.chn`.

### 2.4 Tương phản — ngưỡng cứng

| nội dung | tối thiểu |
|---|---|
| chữ thường (< 18px) trên nền | **4.5:1** |
| chữ lớn (≥ 18px hoặc ≥ 14px đậm) | **3:1** |
| viền input, ranh giới điều khiển | **3:1** |
| chữ trên nút primary | **4.5:1** |

Preset **Mỹ phẩm** (`#f36b7d`) là ca nguy hiểm nhất: hồng nhạt trên trắng **không đạt 4.5:1**.
Nên chữ trên nút primary của preset đó phải là **trắng**, và **không được** dùng `primary` làm
màu chữ trên nền sáng — chỉ làm màu nền.

**Kiểm bằng máy, đừng kiểm bằng mắt.** Mắt quen dần với thiết kế của chính mình.

---

## 3. Chữ

### 3.1 Font

```
"Be Vietnam Pro", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif
```

**Tự host, `font-src 'self'`.** CSP chặn font ngoài — không Google Fonts, không CDN. Preset
**tuyệt đối không được** khai `font.*` (`packages/presets` đã cưỡng chế).

### 3.2 Thang bậc — 7 bậc, thay cho ~20 cỡ hiện tại

Dùng `rem`, gốc 16px. Bảng này **thay thế toàn bộ** các cỡ đang có.

| tên | rem | px | weight | line-height | dùng cho |
|---|---:|---:|---:|---:|---|
| `--fs-display` | `clamp(1.75rem, 4vw, 2.5rem)` | 28–40 | 700 | 1.15 | tiêu đề hero (**chỉ 1 cái/trang**) |
| `--fs-h1` | `1.5rem` | 24 | 700 | 1.3 | tên sản phẩm ở trang chi tiết, tiêu đề trang |
| `--fs-h2` | `1.25rem` | 20 | 600 | 1.35 | tiêu đề khối ("Sản phẩm mới", "Đánh giá") |
| `--fs-lg` | `1.125rem` | 18 | 600 | 1.45 | **giá ở trang chi tiết**, tiêu đề thẻ |
| `--fs-base` | `1rem` | 16 | 400 | **1.6** | nội dung, mô tả |
| `--fs-sm` | `0.875rem` | 14 | 400 | **1.5** | tên SP trong lưới, nhãn, chữ trên nút |
| `--fs-xs` | `0.75rem` | 12 | 500 | 1.4 | chip trạng thái, meta, ghi chú |

**Bảy bậc. Không có bậc thứ tám.** Muốn thứ gì đó nổi hơn thì đổi **weight** hoặc **màu**, đừng
đẻ cỡ mới.

> Vì sao bỏ hết `.82 / .86 / .88 / .92 / 1.02rem`: chúng lệch nhau dưới 1px. Chúng không tạo ra
> phân cấp — chúng **phá** phân cấp, vì mắt không đọc được thứ bậc từ những chênh lệch đó.

### 3.3 Quy tắc tiếng Việt — bắt buộc

- **`line-height` ≥ 1.4 ở mọi cấp**, và **≥ 1.6 cho đoạn văn**. Dấu mũ + dấu thanh chồng nhau
  (`ế`, `ộ`, `ữ`) cần chỗ thở; 1.2 là dính dấu.
- **KHÔNG `text-transform: uppercase`** cho chữ có dấu. `SẢN PHẨM MỚI VỀ` khó đọc hơn hẳn
  `Sản phẩm mới về`, và nhiều font mất dấu khi viết hoa.
- **`letter-spacing: 0`** ở mọi cỡ ≤ 18px. Giãn chữ tiếng Việt làm dấu trôi khỏi thân chữ.
  Cho phép `-0.01em` **chỉ** ở `--fs-display`.
- **Tiền và số: `font-variant-numeric: tabular-nums`**. `199.000₫` và `1.990.000₫` phải thẳng
  cột trong lưới sản phẩm.
- **Ký hiệu tiền là `₫` (U+20AB)** ở web. Worker in `đ` Latinh — hai ký tự khác nhau, đừng lẫn
  (`CLAUDE.md §4`).
- **Tên sản phẩm trong lưới: cắt đúng 2 dòng** bằng `-webkit-line-clamp: 2`, kèm `min-height`
  cố định. Không có thì thẻ cao thấp so le và cả lưới gãy nhịp.

---

## 4. Khoảng cách — nhịp 4px

Đây là sửa chữa lớn nhất: **99 giá trị `padding` → 7 bậc**.

```
--sp-1: 4px      chen giữa icon và chữ
--sp-2: 8px      trong chip, giữa nhãn và giá trị
--sp-3: 12px     padding trong nút, ô input
--sp-4: 16px     padding thẻ, khe lưới trên di động
--sp-5: 24px     khe lưới desktop, giữa các khối nhỏ
--sp-6: 32px     giữa các khối trong một section
--sp-7: 48px     giữa các section lớn
```

**Mọi khoảng cách phải là một trong bảy giá trị này.** Không `9px`, không `14px`, không `18px`,
không `15px` — những số đang có trong mã hôm nay.

### 4.1 `--spacing` của shop dùng vào đâu

Preset khai `spacing: 16–20px`. Nó điều khiển **mật độ của lưới sản phẩm** (khe giữa các thẻ),
**không** điều khiển padding bên trong thành phần.

> Vì sao tách: shop bán nội thất muốn thoáng (20px), shop tạp hoá muốn dày (16px) — đó là mật
> độ **danh mục**. Nhưng padding **trong** một nút thì phải như nhau ở mọi shop, nếu không nút
> ở shop này bấm trúng còn shop kia thì trượt.

### 4.2 Nhịp dọc của trang

```
section  ──── --sp-7 (48px) ────  section
   │
   ├── tiêu đề khối
   │      --sp-5 (24px)
   ├── nội dung
   │      --sp-6 (32px)
   └── nút "Xem tất cả"
```

Trên màn < 640px, `--sp-7` rút còn `--sp-6`, `--sp-6` rút còn `--sp-5`. Đừng rút sâu hơn — chật
quá thì khách không phân biệt được ranh giới các khối.

---

## 5. Bo góc & bóng đổ

### 5.1 Bo góc — 5 bậc, dẫn xuất từ `--radius` của shop

`theme.js:878` đã làm đúng, giữ nguyên:

```css
--r-sm: clamp(2px, calc(var(--radius) * .75), 12px)
--r:    min(var(--radius), 20px)
--r-lg: clamp(var(--radius), calc(var(--radius) * 1.8), 26px)
--r-xl: clamp(var(--radius), calc(var(--radius) * 2.6), 34px)
--pill: 999px
```

**Chỉ dùng 5 biến này. Không gõ số px trực tiếp** — 23 giá trị radius hiện tại là do gõ tay.

⚠️ **Preset Nội thất có `radius: 0px`.** Mọi thành phần phải trông cố ý khi vuông tuyệt đối.
Nếu một thẻ chỉ "đẹp" khi bo 12px thì thiết kế đó sai, không phải preset sai. Đã có cơ chế
`--btn-radius` / `--cat-radius` cho ca này (`theme.js:77-80`) — dùng lại, đừng chế cơ chế mới.

### 5.2 Bóng đổ — 3 bậc, dùng RẤT tiết chế

```css
--sh-sm  thẻ nghỉ (gần như không thấy)
--sh     thẻ hover, dropdown
--sh-lg  modal, lớp phủ
```

**Ưu tiên viền hơn bóng.** `docs/44 §1` đã chốt tinh thần này cho admin và nó đúng luôn cho
storefront: bóng nhiều tầng là dấu hiệu "template", và trên nền màu của shop thì bóng xám trông
bẩn.

**Cấm:** gradient trang trí, glassmorphism, bóng nhiều lớp chồng. Ảnh sản phẩm là nhân vật
chính — mọi hiệu ứng đều là thứ cạnh tranh với nó.

---

## 6. Giải phẫu thành phần

### 6.1 Thẻ sản phẩm trong lưới — thành phần quan trọng nhất

```
┌──────────────────┐
│                  │  ảnh vuông 1:1, object-fit: cover
│      ảnh         │  [nhãn giảm giá] góc trên-trái nếu có
│                  │  luôn có width/height ⇒ không nhảy layout
├──────────────────┤  --sp-3 (12px)
│ Tên sản phẩm     │  --fs-sm · 2 dòng · line-clamp · min-height cố định
│ dài thì cắt hai… │
│                  │  --sp-2 (8px)
│ 199.000₫  259.000│  giá: --fs-lg 600 --color-primary
│                  │  giá gạch: --fs-sm --color-muted, line-through
│ ● Còn hàng       │  --fs-xs + CHẤM + CHỮ
└──────────────────┘
```

**Bốn luật:**
1. **Ảnh luôn có `width`/`height`** → không nhảy bố cục khi tải (Cumulative Layout Shift).
2. **Tên đúng 2 dòng, `min-height` cố định** → mọi thẻ cao bằng nhau.
3. **Giá là thứ đậm nhất trong thẻ** — không phải tên. Khách quét giá trước.
4. **Cả thẻ là một link**, không phải chỉ tiêu đề. Ngón tay trên di động không nhắm được chữ.

### 6.2 Lưới sản phẩm

| bề rộng | số cột | khe |
|---|---:|---|
| < 480px | **2** | `--sp-3` |
| 480–768px | 2–3 | `--sp-4` |
| 768–1200px | 3–4 | `--spacing` của shop |
| > 1200px | 4–5 | `--spacing` của shop |

> **Hai cột trên điện thoại, không phải một.** Khách Việt mua hàng quen quét lưới 2 cột
> (Shopee/TikTok Shop/Lazada đều vậy). Một cột buộc cuộn gấp đôi và cảm giác "ít hàng".

### 6.3 Trang chi tiết sản phẩm

Thứ tự trên di động — **thứ tự này là quyết định, không phải mặc định**:

```
1. Gallery ảnh          (radio + :checked, không JS)
2. Tên sản phẩm         --fs-h1
3. GIÁ                  --fs-lg đậm, --color-primary
4. Chọn biến thể        SSR ?variant= — mỗi lựa chọn là một <a>
5. Tình trạng kho       chấm + CHỮ
6. Nút "Mua ngay"       full-width, cao ≥ 48px
7. Mô tả
8. Đánh giá
9. Sản phẩm liên quan
```

Giá đứng **trên** phần chọn biến thể: khách quyết định mua bằng giá trước, chọn màu sau.

### 6.4 Nút

| loại | nền | chữ | dùng |
|---|---|---|---|
| Chính | `--color-primary` | trắng | Mua ngay, Thêm vào giỏ, Đặt hàng |
| Phụ | trong suốt | `--color-text` | Xem thêm, Quay lại |
| Chữ | không | `--color-primary` | link phụ |

- **Chiều cao chạm tối thiểu 44px**, nút mua chính **48px**.
- **Một nút chính mỗi màn.** Hai nút chính nghĩa là chưa quyết định được việc gì quan trọng nhất.
- Padding: `--sp-3` dọc, `--sp-4` ngang. Bo: `--btn-radius` (tôn trọng preset góc vuông).

### 6.5 Không JavaScript — mẫu đã có, dùng lại

ADR-008: storefront + checkout **không JS**. Bốn mẫu đã chạy trong `theme.js`, **đừng phát minh
lại**:

| tương tác | cách làm |
|---|---|
| gallery đổi ảnh | `<input type=radio>` ẩn + `:checked` |
| phóng to ảnh | `:target` + anchor |
| chọn biến thể | SSR `?variant=` — mỗi lựa chọn là một `<a href>` |
| thêm vào giỏ | `<form method=POST>` + Post-Redirect-Get |

**Hệ quả cho thiết kế:** mọi trạng thái phải biểu diễn được bằng CSS thuần hoặc một lần tải
trang. Thiết kế nào cần "mở dropdown rồi chọn rồi mới apply" là thiết kế sai kiến trúc — hãy
dùng link, chip, hoặc form submit.

---

## 7. Trạng thái, tiêu điểm, khả dụng

### 7.1 Vòng tiêu điểm — bắt buộc

```css
:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
```

**Không bao giờ `outline: none` mà không thay bằng chỉ báo khác.** Không có JS thì bàn phím và
trình đọc màn hình là đường đi duy nhất cho người khiếm thị — bỏ vòng tiêu điểm là khoá cửa.

### 7.2 Đủ bộ trạng thái

Mỗi thành phần tương tác phải có: **nghỉ · hover · focus-visible · active · disabled**, và với
thẻ/nút mua thêm **hết hàng**. Thiếu `disabled` thì khách bấm "Mua" trên hàng hết và nhận lỗi ở
bước sau — hỏng niềm tin ở đúng lúc họ định trả tiền.

### 7.3 `prefers-reduced-motion`

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
```

### 7.4 Chuyển động

Chỉ dùng ở: hover thẻ (nâng nhẹ), mở/đóng chi tiết, đổi ảnh gallery.
**150–250ms, `ease-out`.** Dài hơn là cản đường người đang mua.

---

## 8. Ngân sách — con số để canh bằng test

Đây là phần biến tài liệu này thành thứ **cưỡng chế được**, không phải lời khuyên.

| hạng mục | ngân sách | hôm nay | cách đo |
|---|---:|---:|---|
| cỡ chữ riêng | **≤ 7** | ~20 | `grep -oE 'font-size:[^;}"]+'` \| `sort -u` |
| giá trị `padding` riêng | **≤ 12** | 99 | `grep -oE 'padding:[^;}"]+'` \| `sort -u` |
| `border-radius` gõ tay | **0** | 23 | phải là `var(--r*)` |
| mã màu cứng riêng | **≤ 10** | 39 | 7 màu ngữ nghĩa + 3 dự phòng |
| `!important` | **≤ 5** | — | mỗi cái phải có chú thích lý do |
| chiều sâu lồng CSS | **≤ 3** | — | `.a .b .c` là hết |

> **Đề nghị:** viết `apps/storefront/test/design-budget.test.js` — bất biến mức **mã nguồn**,
> chạy bằng `node --test`, không cần stack. Cùng loại với `date-tz.test.js` và
> `usage-route.test.js` đã có. Nhớ sửa `MANIFEST_UNIT_COUNT` cùng commit.
>
> Ngân sách không có test là **lời khuyên**, và lời khuyên thì trôi. Kho này đã học bài đó ba
> lần (`docs/58`, `60`, `61`).

---

## 9. Lộ trình thi hành — 4 bước, đừng làm một lượt

Sửa 99 giá trị padding trong một commit là không review được, và storefront là **mặt tiền bán
hàng**: hỏng là mất đơn, không phải mất thẩm mỹ.

| bước | việc | rủi ro |
|---|---|---|
| **1** | Khai 7 biến `--fs-*` + 7 biến `--sp-*` trong `:root`. **Chưa đổi chỗ nào dùng.** | không |
| **2** | Đổi thang **chữ**: ~20 cỡ → 7 bậc. Bắt đầu từ thẻ sản phẩm và trang chi tiết. | thấp |
| **3** | Đổi **khoảng cách**: 99 → 12 giá trị, theo từng khối một | trung bình — dễ vỡ bố cục |
| **4** | Gom **màu cứng**: 39 → ≤ 10, phần còn lại thành `var(--color-*)` | thấp |

**Sau mỗi bước:** chụp lại `renderHome` · `renderProducts` · `renderProduct` ở **preset Nội thất
(radius 0)** và **Mỹ phẩm (radius 12)**, ở 360px và 1280px. Tám ảnh. So trước/sau.

Cổng: đụng `theme.js` là đụng nhiều màn ⇒ chạy `apps/storefront/test/e2e.mjs` (170 khẳng định)
sau mỗi bước, và **cổng đầy đủ** trước khi push.

---

## 10. Cố ý CHƯA làm

| việc | vì sao | ngưỡng |
|---|---|---|
| Chế độ tối (dark mode) | 9 token màu chưa có cặp sáng/tối; thêm là đổi hợp đồng preset + 5 preset + test | có shop thật hỏi |
| Cho shop tự khai font | CSP chặn font ngoài; tự host font của từng shop là cả một đường ống lưu trữ | ≥ 5 shop hỏi |
| Preset thứ 6 | 5 preset chưa có shop thật nào dùng đủ | có ngành thật không khớp preset nào |
| Ảnh sản phẩm tỉ lệ tuỳ shop | 1:1 khiến lưới luôn thẳng hàng; tỉ lệ tuỳ biến là mở cửa cho lưới gãy | shop thời trang thật kêu (ảnh dọc 3:4) |

---

## 11. Ghi chú lệch số đã phát hiện

Khi soạn tài liệu này, đếm lại trong `packages/presets/src/index.js`: có **5 preset**
(Thời trang · Thực phẩm–Đồ uống · Nội thất · Mỹ phẩm · Khác/Đa ngành).

**`README.md` §6 đang ghi "4 preset giao diện theo ngành".** Số cũ từ trước khi thêm preset thứ
5 (`0115`). Đã sửa trong cùng commit với tài liệu này — theo luật "sửa gì làm lệch số thì sửa
luôn nơi ghi số".
