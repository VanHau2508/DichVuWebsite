# 51 — Cộng tác viên / Affiliate (CTV): quy tắc hoa hồng

Shop cấp **mã giới thiệu** cho CTV; CTV rải link, khách mua qua link đó thì CTV được hoa
hồng. Tài liệu này chốt QUY TẮC — mọi thay đổi số tiền phải đối chiếu ở đây trước.

## Chốt lớn: hoa hồng theo ĐƠN GIAO THÀNH CÔNG, không theo đơn đã thanh toán

Đây là cách **cả Shopee lẫn TikTok Shop** đang làm:

| | Shopee Affiliate | TikTok Shop Affiliate |
|---|---|---|
| Lúc đặt đơn | "đơn phát sinh" | hoa hồng **ước tính** |
| Điều kiện chốt | đơn **hoàn thành** = đã giao **và** hết hạn đổi trả | đơn **hợp lệ** sau kỳ **đối soát** |
| Trả tiền | chu kỳ tháng, trễ ~1–2 tháng | theo chu kỳ, sau đối soát |

Lý do: CTV không chịu rủi ro bom hàng, nhưng cũng không được thưởng cho đơn bị trả về.
Trả theo "đã thanh toán" thì đơn bị hoàn **trong hạn đổi trả** buộc phải đi đòi lại hoa
hồng đã đưa — việc không bao giờ êm.

**Điểm nền tảng này KHÁC sàn:** Shopee/TikTok giữ tiền của chính họ. Shop ở đây thì tiền
COD **nằm ở hãng vận chuyển** cho tới khi hãng chuyển về (docs/37 quy tắc 10). Chốt hoa
hồng ngay lúc "đã giao" nghĩa là shop trả CTV **trước khi cầm tiền hàng**. Ta không chặn
— nhưng phải nói ra (xem "Cảnh báo tiền chưa về" dưới).

## Vòng đời hoa hồng (bốn trạng thái)

```
   đặt đơn có mã                giao xong + hết hạn đổi trả            chốt phiếu chi
  ───────────────►  pending  ──────────────────────────────►  eligible ─────────────► paid
                       │                                          │
                       └──────── đơn huỷ / hoàn ──────────────────┴──────────►  void
```

| Trạng thái | Nghĩa | Ai chuyển |
|---|---|---|
| `pending` | **Tạm tính** — CTV thấy được, chưa phải tiền | checkout tạo |
| `eligible` | **Đủ điều kiện** — `delivered_at + hạn đổi trả < now()` | worker sweep |
| `void` | **Rụng** — đơn huỷ/hoàn trước khi đủ điều kiện | worker sweep |
| `paid` | **Đã trả** — nằm trong một phiếu chi CTV | shop chốt phiếu |

- Hạn đổi trả mặc định **7 ngày**, shop chỉnh được (`shop_affiliate_config.hold_days`).
- Đơn huỷ/hoàn **sau** khi đã `paid` thì **KHÔNG tự đòi lại** — ghi cảnh báo cho shop tự
  xử với CTV. Tự trừ ngược vào phiếu đã chi là làm sổ chi nói dối.

## Quy tắc tiền

1. **Căn cứ tính = `subtotal − discount`** (giống doanh thu hàng ở docs/37 quy tắc 1).
   **KHÔNG** tính trên phí ship: ship không phải doanh thu của shop, trả hoa hồng trên đó
   là trả cho tiền mình không được hưởng.
2. **SNAPSHOT mức hoa hồng lúc đặt đơn** vào chính dòng hoa hồng (`rate_kind`,
   `rate_value`, `base_vnd`) — như `unit_cost_vnd` của giá vốn. Đổi mức sau **không** sửa
   đơn cũ.
3. **Một đơn một dòng hoa hồng** (`UNIQUE (shop_id, order_id)`). Đơn không có mã giới
   thiệu thì không có dòng nào — không đẻ dòng 0đ.
4. **Đơn đổi giá trị → hoa hồng `pending` tính lại**; hoa hồng đã `eligible`/`paid`
   **giữ nguyên** (đã chốt). Một công thức duy nhất, đọc thẳng trạng thái DB hiện tại:

   ```
   base = (subtotal − discount) × (subtotal − Σ tiền hàng đã trả về) / subtotal
   ```

   tức *phần tiền hàng khách THỰC SỰ giữ lại, sau giảm giá*. Không trả gì thì rút gọn đúng
   về quy tắc 1. Cài ở `tinhLaiHoaHongCTV()` (seller/orders.js), gọi từ **hai** đường:
   `reconcileEditLines` (sửa đơn v1+v2) và `createReturn` (đổi-trả). Chia số nguyên =
   **làm tròn xuống**, cùng chiều thận trọng với `affiliate_commission_amount` (0131).

   *Đã từng thủng cả hai đường (đợt 4, docs/57):* trước bản vá `grep -c affiliate
   apps/seller/src/orders.js` = **0** — không đường nào của seller đụng tới bảng hoa hồng,
   dù quy tắc này đã viết ở đây từ đầu và 0131 cấp `EXECUTE` cho `app_rw` đúng vì nó. Nặng
   nhất là **trả hàng một phần**: đơn giữ nguyên `delivered` (đúng), vòng quét lật
   `pending → eligible` với căn cứ GỐC → shop hoàn tiền hàng cho khách mà **vẫn** trả hoa
   hồng trọn đơn. Bảng hoa hồng chỉ đọc nên không có màn nào sửa tay.

5. **CTV tự mua qua mã của mình**: chặn theo SĐT trùng với SĐT CTV — tự thưởng cho mình
   là lỗ hổng đầu tiên mọi chương trình affiliate bị khai thác. So bằng **`canon_phone()`**
   (0137) ở cả hai vế, **không** so chuỗi tuyệt đối: bên ghi giữ `+84900001111`, bên đọc
   chuẩn hoá thành `0900001111`, nên so chuỗi làm điều kiện chặn im lặng vô hiệu — mà
   `block_self_referral` mặc định BẬT nên shop tin là mình đang được bảo vệ. Đặt hàm ở DB
   (cùng lối `affiliate_commission_amount`) còn chữa luôn các dòng đang lưu sai, không cần
   migration dữ liệu.

6. **Đơn `returned` cũng làm hoa hồng RỤNG.** Vòng quét chỉ biết `delivered` (chốt) và
   `cancelled`/`refunded` (rụng); thiếu `returned` thì dòng của đơn bom hàng (0059) hoặc
   trả HẾT không khớp nhánh nào → kẹt `pending` **vĩnh viễn**, và tổng nợ CTV trên báo cáo
   cứ đội lên bằng tiền của hàng đã quay về kho.

## Gán mã giới thiệu cho đơn

- Link CTV: `https://<shop>/?ref=MADEXUAT` → storefront đặt **cookie theo
  `cookie_days` của shop** (mặc định 30, kẹp 1–90; last-click, giống Shopee) rồi **xoá tham
  số khỏi URL** để khách không rải link bẩn tiếp.
- **Tuổi thọ cookie CHÍNH LÀ cửa sổ quy gán** — checkout không so ngày click ở đâu cả, nó
  chỉ đọc cookie còn hay mất. Nên ô cấu hình đó *phải* tới được storefront. Đã từng không:
  storefront đọc `resolved.affiliateCookieDays`, một thuộc tính chưa bao giờ được gán, nên
  mọi shop đều 30 ngày trong khi ô nhập lưu/hiện đúng số vừa gõ (đợt 4).
- Truy vấn `cookie_days` chỉ chạy khi **mã đúng định dạng** — giữ nguyên hàng rào cũ: người
  lạ dội `?ref=` rác không làm shop tốn query nào. DB hỏng → rơi về 30, **không** chặn điều
  hướng: hỏng cấu hình mà chặn khách vào trang thì đắt hơn nhiều so với cookie sai hạn.
- Checkout đọc cookie → ghi mã vào đơn. Mã **không hợp lệ / CTV đã tắt** → bỏ qua im lặng,
  đơn vẫn đi tiếp: **không bao giờ để chương trình hoa hồng chặn một đơn hàng thật**.
- Đơn tạo tay / đơn từ bot Messenger: shop chọn CTV thủ công (v2).

## Cảnh báo tiền chưa về (đặc thù tự-vận-hành)

Màn hình chi tiền CTV hiện: *"Trong X đồng sắp trả, có **Y đồng** thuộc đơn COD mà hãng
**chưa chuyển tiền về**."* Dùng lại `cod_outstanding` của docs/37 quy tắc 10. **Không
chặn** — shop có quyền trả trước để giữ CTV — nhưng không để họ trả mù.

## Phân quyền

| Thao tác | Perm | Vai trò |
|---|---|---|
| Xem/sửa CTV + mức hoa hồng | `affiliate.manage` | owner, admin |
| Xem báo cáo hoa hồng | `affiliate.manage` | owner, admin |
| Chốt phiếu chi CTV | `affiliate.manage` + step-up | owner |

Hoa hồng là **chi phí**, nên nó vào P&L (docs/37) như một dòng riêng ở tầng vận hành —
cùng chỗ với phí hãng, **theo ngày đủ điều kiện** (không phải ngày đặt đơn).

## Cắt v1 → v2

Cổng đăng nhập riêng cho CTV tự xem doanh số · nhiều tầng hoa hồng (F1/F2) · hoa hồng
theo sản phẩm/danh mục · tự động chuyển khoản cho CTV · mã giảm giá gắn kèm mã CTV.
