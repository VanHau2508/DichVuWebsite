# 53 — Săn lỗi hợp thành đợt 2: quét 5 mảng chưa chạm, và bài học về "0 bị bác bỏ"

Tiếp `docs/51` và `docs/52`. Lần này quét 5 mảng chưa từng soi theo kiểu này: kho/tồn,
giao hàng, ba lớp giảm giá chồng nhau, phân quyền, thuê bao nền tảng.

**Cách làm.** 5 agent đọc song song, mỗi agent trả tối đa 3 nghi vấn kèm `file:dòng` +
kịch bản thao tác cụ thể; mỗi nghi vấn nặng bị một agent KHÁC cố **bác bỏ** bằng chính mã
nguồn, mặc định là bác bỏ nếu không tự chứng minh được. 14 agent, ~13 phút.

## Kết quả: 9 sống sót, **0 bị bác bỏ** — và đó là một cảnh báo, không phải một điểm số

Lớp phản biện không loại được gì. Với một lớp phản biện lành mạnh, tỉ lệ đó phải khác 0.
Nên kết quả được xử lý như **danh sách nghi vấn**, không phải danh sách lỗi. Và đúng như
vậy: nghi vấn nặng nhất **sai ở phần lý giải**.

## Nghi vấn #3 — "shop trả tiền vẫn bị khoá vĩnh viễn": sai lý giải, đúng lỗi

Agent nói `sweepSubscriptions` khoá shop mà không đóng dấu `suspended_at`, còn đường mở
khoá thì đòi dấu đó → khoá vĩnh viễn.

Đọc mã thì thấy **`sweepBillingEnforce` vẫn đóng dấu hộ** ngay cả khi nó không phải kẻ khoá
(`locked.rowCount ? prev : null`, worker `index.js:636-639`). Nên lập luận trên chưa đủ.
Chạy thật (`a8-khoa-shop-repro`):

| Ca | Kết quả |
|---|---|
| Cấu hình mặc định, chạy cả hai sweep | **KHÔNG hỏng** — khoá → trả tiền → `shop=active` |
| Chỉ `sweepSubscriptions` kịp khoá | **HỎNG** — trả tiền, sub về `active` còn hạn, mà `shops.status` kẹt `suspended` |

Ca 2 **đến được ở cấu hình mặc định**: hai sweep là hai `setInterval` RIÊNG, còn
`sweepBillingApply` chạy mỗi 30 giây. Khách trả tiền trong khe giữa hai nhịp là rơi đúng
vào đó. Và một khi sub đã `active`, `sweepBillingEnforce` — nơi duy nhất đóng dấu — không
bao giờ chọn lại nó nữa (`WHERE s.status IN ('past_due','cancelled')`), nên dấu không bao
giờ được đóng bù. Khoá thật sự vĩnh viễn, chỉ là qua một con đường khác con đường agent mô tả.

**Vá.** `sweepSubscriptions` đóng dấu `suspended_at`/`suspended_from` y như
`sweepBillingEnforce`, và **chỉ khi chính nó khoá** (`locked.rowCount`) — đóng dấu hộ cho
shop đang bị nền tảng khoá vì vi phạm là mở đúng cái cửa không nên mở.
Kèm lợi ích phụ: shop được trả về **đúng trạng thái cũ** thay vì bị ép thành `active`.

## Nghi vấn #2 — RMA bỏ qua coupon/điểm: đúng, và nặng hơn mô tả

`createReturn` tính hoàn `Σ(unit_price_vnd × qty)` — giá **trước** giảm. Coupon và điểm
thưởng nằm ở header đơn (`discount_vnd`, `points_discount_vnd`); hàm này không đọc hai cột
đó. Đơn không giảm giá thì `Σ dòng = số đã thu` nên mọi test cũ đều xanh.

Chạy thật (`a9-rma-giam-gia`), đơn 2 món 170.000đ, coupon −85.000đ, ship 30.000đ,
khách trả 115.000đ:

```
A. Trả 1 trong 2 món
   HỎNG  hoàn 85.000đ (đúng phải 42.500đ) — shop mất 42.500đ, khách giữ món còn lại gần như miễn phí
B. Trả TOÀN BỘ
   HỎNG  422 "số hoàn 170.000đ vượt số còn có thể hoàn (đã thu 115.000)"
         → đơn dùng coupon KHÔNG nhận trả hàng được, không có đường vòng nào trong giao diện
```

Ca B nặng hơn ca A và agent chỉ nhắc thoáng qua: **tính năng đổi-trả hỏng hoàn toàn với mọi
đơn có khuyến mãi**.

**Vá.** Phân bổ giảm giá header về hàng trả theo tỉ trọng:
`hoàn = round(gross × (subtotal − discount − points) / subtotal)`. Lần trả **cuối** (sau
lượt đó không còn dòng nào chưa trả) đóng đúng phần còn lại, để làm tròn từng lượt không
để sót vài đồng kẹt vĩnh viễn. Phí ship không hoàn — giữ nguyên hành vi cũ.

> Một sai của chính tôi khi đo: khẳng định đầu tiên cho ca B so số hoàn với `amount_paid`
> (đã gồm ship) nên báo VẤP dù mã đã đúng. Mốc đúng là **tiền hàng** đã trả.

## Test thường trực + kiểm tra đột biến

| Bộ | Thêm | Đột biến gây đỏ |
|---|---|---|
| `apps/seller/test/returns-rma.e2e.mjs` | đơn có coupon: trả một phần hoàn phân bổ đúng · trả toàn bộ vẫn nhận được | tắt nhánh phân bổ → **2 FAIL** (hoàn 100.000 thay vì 50.000; trả cả đơn 422) |
| `apps/seller/test/billing.e2e.mjs` §7b | sweep thuê bao khoá → có dấu → trả tiền mở lại được | tắt câu đóng dấu → **2 FAIL** |

## Bài học

1. **"0 bị bác bỏ" là tín hiệu lớp phản biện yếu, không phải tín hiệu các nghi vấn đều đúng.**
   Nghi vấn nặng nhất sai lý giải; đọc mã 10 phút là thấy. Vẫn phải tự kiểm.
2. **Sai lý giải không có nghĩa không có lỗi.** Lỗi có thật, chỉ đến qua đường khác — nếu
   dừng ở "agent nói sai rồi" thì bỏ lọt một lỗi khoá shop đang trả tiền.
3. Lặp lại mô-típ của `docs/52`: **một quy tắc viết ở hai nơi**. Ở đây là "khoá shop" viết
   trong hai sweep, và "công thức tiền hàng" viết ở checkout nhưng không ở RMA.

## Nghi vấn #1 — đơn COD hoàn/trả rơi khỏi sổ đối soát: **đúng nguyên văn**

Sổ "hãng còn nợ tiền" định nghĩa bằng `o.status = 'delivered'` (`cod.js`), còn `refundOrder`
đẩy đơn sang `'refunded'` và `createReturn` sang `'returned'`. Hai bên không biết nhau.

Chạy thật (`a10-cod-mat-dau`), đơn COD 185.000đ giao qua GHTK:

```
A. Khách trả hàng   → ĐƠN RƠI KHỎI SỔ (status=returned, cod_settled_at=NULL)
                       tổng "hãng còn nợ" tụt 185.000đ
   ghi phiếu tay?   → NGÕ CỤT 422 "đơn #25 chưa giao xong"
B. Shop hoàn tiền   → ĐƠN RƠI KHỎI SỔ (status=refunded), tụt 100.000đ
```

Hãng đã thu tiền của khách xong là món nợ giữa **shop và hãng**; chuyện shop hoàn tiền hay
nhận trả hàng sau đó là giữa **shop và khách**. Lọc theo `status` trộn hai quan hệ đó.

**Vá.** Điều kiện đổi sang **"đã từng giao"** (`delivered_at IS NOT NULL`) ở cả ba chỗ:
`OUTSTANDING_SQL`, guard của `recordRemittance`, và **bản sao thứ hai** của cùng bộ lọc
trong memo "hãng còn nợ" ở `reports.js:237` — hai nơi định nghĩa cùng một con số, lệch nhau
là màn Đối soát COD và Báo cáo nói hai số khác nhau mà không ai biết cái nào đúng.

Test `cod-reconcile` +4 khẳng định; đột biến (trả lại `status='delivered'`) → **3 FAIL**.

## Hai nghi vấn phân quyền — đúng, và rộng hơn báo cáo

Agent nói `affiliate.manage` được khai là cần step-up nhưng không route nào bật cờ, và
`POST /cod/remittances` là route `payment.write` duy nhất thiếu. Quét toàn bộ bảng route
xác nhận, và cho thấy vấn đề **có hệ thống** chứ không phải hai chỗ lẻ:

| Quyền | Route | Có step-up |
|---|---:|---:|
| `members.write` · `domain.write` · `refund` · `privacy.erase` · `loyalty.write` | | đủ |
| `payment.write` | 6 | **5/6** |
| `affiliate.manage` | 7 | **0/7** |

**Gốc rễ:** cưỡng chế đi theo cờ `stepUp: true` đặt trên TỪNG route (`server.js:441`), còn
`STEP_UP_PERMS` ở `rbac.js` **chỉ là danh sách khai báo** — `needsStepUp()` không được gọi ở
đâu cả. Mã nói một đằng làm một nẻo. Bằng chứng nó gây hiểu nhầm thật: `affiliates.e2e.mjs`
có sẵn dòng `await stepUp()` kèm chú thích *"affiliate.manage có step-up (tiền rời khỏi
shop)"* — người viết test **đã tin là có**.

**Chọn gì.** Cửa sổ step-up là **5 phút**, không phải mỗi-thao-tác-một-lần. Bật cho hai
**bút toán không hoàn tác được** — chốt phiếu chi CTV (`affiliate_payouts` REVOKE UPDATE/
DELETE) và ghi phiếu đối soát COD (đóng vĩnh viễn tới 500 đơn) — tốn đúng **một lần gõ mật
khẩu cho cả buổi**, vì cả hai đều là việc làm theo đợt. Các route ĐỌC và `PUT
/affiliates/config` (sửa lại được) giữ nguyên. `GET /export/download` cũng giữ nguyên: token
chính là năng lực, step-up đã làm lúc tạo.

**Giao diện phải theo, nếu không là ship lỗi.** Bật cổng mà màn hình không biết hỏi mật khẩu
thì chủ shop bấm sẽ thấy "Không ghi được phiếu" — tưởng lỗi nghiệp vụ. Thêm
`renderStepUpGate` dùng chung: mang TOÀN BỘ ô đã nhập/tick sang màn mật khẩu bằng hidden
input và gửi lại nguyên vẹn. Bắt tick lại 50 đơn là cách chắc chắn nhất để người ta bỏ luôn
việc đối soát. Sai mật khẩu → 401 nhưng dữ liệu vẫn còn.

**Chặn tái diễn:** bộ mới `apps/seller/test/rbac-stepup.e2e.mjs` đi từ ngoài vào qua HTTP:
mỗi bút toán tiền-ra phải 403 `step_up_required` khi chưa xác thực, và **không** còn 403 sau
khi xác thực (chốt hai đầu — cổng luôn-403 cũng là hỏng). Kèm một khẳng định về TRẢI NGHIỆM:
thao tác thứ hai trong cùng cửa sổ không được hỏi lại mật khẩu.

## Hai nghi vấn kho — đúng cả hai, nhưng một cái hẹp hơn báo cáo

### Tồn "sống lại" khi tái dùng biến thể — **đúng, chỉ nổ ở lần đổi trục THỨ HAI**

Agent nói nhánh tái dùng hạ `on_hand = reserved`, rồi khi đơn giữ chỗ bị huỷ thì đường nhả
chỉ hạ `reserved` → available bật lại. Lập luận đúng. Nhưng lần dựng đầu của tôi **đo nhầm**:
biến thể cũ chỉ thành **mồ côi**, chưa hề đi qua đường tái dùng — vì `pool` được dựng ở bước
(2) **trước** `DELETE FROM product_options` ở bước (3), nên lúc đó chúng vẫn còn
`variant_option_values`. Đúng như chú thích trong mã: *"gồm mồ côi lần sửa trước"*.

Đổi trục **hai lần** mới dựng lại được (`a11`): nhập 10 màu Đỏ, khách đặt 3, đổi trục hai
lần → biến thể thành "Cotton" với `on_hand=3`; huỷ đơn → **3 cái "Cotton" ma** bán được.

**Vá:** loại biến thể đang giữ chỗ (`reserved > 0`) khỏi pool. Hai lý do cùng gốc: (a) tồn
sống lại; (b) `order_lines` trỏ theo `variant_id` — tái dùng chính id đó cho tổ hợp khác
nghĩa là **kiện hàng khách đang đợi âm thầm thành mặt hàng khác**. Tạo biến thể mới thay vì
tái dùng là rẻ và không có mặt trái.

> Kiểm luôn cả điều mình đang giả định: mồ côi giữ tồn có **thật sự** không bán được không?
> Đặt thử đơn thẳng vào nó → **422 "sản phẩm không tồn tại hoặc ngừng bán"**. Có, thật.

### Hoàn tiền đơn giao-một-phần không nhả chỗ giữ — **đúng nguyên văn, kèm ngõ cụt**

`refundOrder` chỉ nhả reserve ở `pending`/`confirmed`. Đơn tách vận đơn bỏ dở nằm ở
`shipped` và vẫn giữ chỗ phần chưa gửi. Dựng lại (`a12`): gửi 3/5 → hoàn toàn bộ → đơn
`refunded` mà **vẫn giữ 2 suất**; rồi `markReturnedBomb` — nơi duy nhất biết nhả phần chưa
gửi — trả **409 "chỉ hoàn-về đơn ĐANG GIAO"**. Chỗ giữ kẹt vĩnh viễn: hàng nằm trong kho mà
không bán được, không thao tác nào gỡ ra.

**Vá:** nhả `qty − shipped_qty` cho cả `shipped`. **Không** restock phần đã gửi — hoàn tiền
không có nghĩa hàng đã về kho; hàng về thì dùng "Đánh dấu hoàn về" / đổi-trả.

> Lại một lần tôi đo sai trước khi đo đúng: mốc `reserved` lấy **trước khi gửi** nên phép trừ
> gộp cả hai nguyên nhân (gửi hàng đã trừ 2, lệnh hoàn trừ 1) và báo đỏ oan. Mốc phải lấy
> **sau khi gửi** thì mới cô lập được tác động của lệnh hoàn.

## Còn nợ (đã tìm ra, CHƯA kiểm chứng, CHƯA vá)

| Mảng | Vị trí | Nội dung |
|---|---|---|
| khuyến mãi | `apps/seller/src/orders.js:717` | đơn từ bot Messenger tính ship bằng công thức phẳng, bỏ phí liên miền + phụ phí cân mà checkout web đang thu |

Mức độ: **thu thiếu phí ship trên một kênh phụ** — nhẹ hơn hẳn 8 lỗ đã vá (không mất tiền
hàng, không kẹt kho, không chặn nghiệp vụ). Để lại có chủ ý, không phải bỏ quên.

## Hàng rào manifest đã bắt được chính đợt này

`git push` bị chặn: thêm `apps/seller/test/rbac-stepup.e2e.mjs` mà quên khai
`MANIFEST_E2E_COUNT` → `ci-local --fast` thấy 92 file, khai 91 → ĐỎ. Mọi mục khác xanh
(security-scan · 88 bất biến DB · 3 smoke).

Đáng ghi vì nó đính chính một hiểu nhầm: manifest **có** chặn được test mới nằm trong glob
`apps/*/test/*.e2e.mjs` (nhờ so **BẰNG** chứ không so sàn). Cái nó không chặn được chỉ là
test đặt ở **thư mục hoàn toàn mới**, ngoài mọi glob — như `packages/presets/test/` từng lọt.
Quy tắc gọn: **file mới trong thư mục cũ → CI bắt; thư mục mới → phải tự nhớ.**
