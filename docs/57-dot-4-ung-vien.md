# Đợt 4 săn lỗi — 15 ứng viên (2026-08-03)

> **Cập nhật cùng ngày:** cụm **hoa hồng CTV** (4 mục dưới) đã vá trọn một lượt — xem
> docs/51 quy tắc 4/5/6 và migration 0137. Kèm một lỗ THỨ NĂM chỉ lộ ra khi dựng lại ca
> "trả hết hàng": đơn về `returned` không khớp nhánh nào của vòng quét hoa hồng → dòng kẹt
> `pending` VĨNH VIỄN, không màn nào dọn được.
>
> **Đợt tiếp (cùng ngày):** vá thêm **A · B · C** dưới đây. Cả ba đi qua 3 lăng kính phản biện
> độc lập (đúng-sai kỹ thuật · tới-được-không · có-cố-ý-không) — **9/9 xác nhận, 0 bác bỏ**, và
> lượt quét lân cận moi thêm **6 chỗ khác cùng khuôn** chưa ai nhắc, đã vá luôn:
> claim chết khoá VĨNH VIỄN quyền sửa đơn (nặng nhất) · bot đưa khách mã vận đơn đã huỷ ·
> trang tra cứu của khách + tài khoản khách in mã đã huỷ · phiếu giao hàng/hoá đơn in kiện
> cũ nhất · digest "đơn ứ" bị claim chết reset đồng hồ · màn "Trang nội dung" chỉ sai đường
> dẫn công khai cho chính chủ shop. Khoá lại bằng `apps/seller/test/shipment-status.test.js`.
> **Đợt tiếp:** vá thêm cụm **phiên/MFA/step-up (D · E · F)** — xem docs/59. Lại 9/9 lăng kính
> xác nhận. Lượt phản biện còn **bác lại chính docs này** ở hai điểm: (1) route thu hồi lời mời
> KHÔNG nên đòi step-up (ngược học thuyết đã viết ở api-keys.js: *tạo* thì step-up, *thu hồi*
> thì không); (2) docs bỏ sót câu CLAIM ở auth — chỉ vá câu SELECT thì còn cuộc đua mà người
> mời LUÔN THUA.
>
> **Đợt tiếp:** vá nốt cụm **xuất dữ liệu & báo cáo (G · H · I)** — xem docs/60. 9/9 lăng kính
> xác nhận. Mục G có bằng chứng mạnh hơn cả mô tả: **docs/41 đã chốt "chi phí điểm ghi tại
> REDEEM giảm doanh thu"** từ đầu, reports.js chỉ là chưa cài; và bất biến chéo màn mà chính
> bộ e2e đã viết ra CHỈ đúng khi không có đơn đổi điểm — lỗ sống được vì fixture chưa từng có
> đơn như thế. Mục H rộng hơn mô tả: **năm** nơi đánh rơi `payment`, không phải ba.
> **2 mục còn lại vẫn CHƯA vá** (trần 100 danh mục storefront · sweep tự huỷ claim 15 phút).

Nguồn: workflow 20 agent quét 5 mảng **chưa từng soi** — storefront công khai · hoa hồng CTV ·
vận chuyển qua hãng · phiên/MFA/step-up · xuất dữ liệu. Mỗi phát hiện đi qua một lượt phản biện
phân loại `sai / không-tới-được / thật-đáng-vá / thật-nhưng-cố-ý`.

## ĐỌC KỸ TRƯỚC KHI TIN

Cả 15 đều được xếp "thật đáng vá" và **0 bị bác** — con số đó TỰ NÓ đáng nghi. Ký ức dự án ghi
rõ: *"0 bị bác bỏ = lớp phản biện yếu, không phải điểm số"*. Có thể vì 5 mảng này chưa ai soi
bao giờ nên phần dễ còn nguyên; cũng có thể lớp phản biện lần này dễ tính.

**Mới tự kiểm chứng 2 mục** (đánh dấu ✔). 13 mục còn lại BẮT BUỘC phải đọc mã xác minh + dựng
lại thật trước khi sửa — 3/9 báo cáo agent ở đợt 3 từng sai bản chất.

Một sai lầm đã lộ ra khi tự kiểm: lớp phản biện của **đợt 3** từng gọi "doanh thu không trừ
điểm thưởng" là quy tắc CỐ Ý theo docs/37. SAI — docs/37 không nhắc gì tới điểm thưởng; docs/51
chốt căn cứ tính *hoa hồng CTV*, là đại lượng khác. Đừng tin nhãn "cố ý" nếu chưa tự mở tài
liệu ra đọc.


## Storefront công khai

### ✅ ĐÃ VÁ (0137 + storefront) — [cao] Ô "Ghi nhớ mã giới thiệu (ngày)" của shop KHÔNG có tác dụng — storefront đọc một thuộc tính không tồn tại nên cookie CTV luôn là 30 ngày ✔ ĐÃ TỰ KIỂM CHỨNG

**Điều kiện cần đủ:** Cần đủ: (1) shop BẬT chương trình CTV (shop_affiliate_config.enabled = true — mặc định false, phải tự bật); (2) shop ĐỔI cookie_days khác 30 (mặc định 30 nên shop để nguyên thì không lệch — đây là lý do lỗi sống sót). Không cần điều kiện gì khác: đường ?ref= là mặc định, không có cờ bật/tắt. Sai số tỉ lệ thuận với độ lệch giữa số shop nhập và 30.

**Đề xuất:** Cho resolveShop trả thêm cookie_days (LEFT JOIN shop_affiliate_config theo d.shop_id, mặc định 30 khi chưa cấu hình) rồi dùng đúng nó ở dòng 469; hoặc bỏ hẳn ô cấu hình khỏi UI nếu quyết định giữ cứng 30. Kèm một e2e: đặt cookie_days = 7 → GET /?ref=MA → khẳng định Max-Age = 604800.

### ✅ ĐÃ VÁ (+1 chỗ lân cận) — [vua] sitemap.xml khai TRANG NỘI DUNG ở sai đường dẫn (/slug thay vì /pages/slug) — mọi URL trang chính sách nộp cho Google đều 404

**Điều kiện cần đủ:** Chỉ cần shop có ≥1 trang CMS đã xuất bản — không cần bật gì. Sitemap được phục vụ cho mọi shop (server.js:507). Không có cờ tắt.

**Đề xuất:** Sửa server.js:527 thành ``loc(`/pages/${pg.slug}`)``. Thêm khẳng định e2e: xuất bản 1 trang → sitemap phải chứa `/pages/<slug>` VÀ GET đúng chuỗi đó phải trả 200 (kiểm bằng cách lấy chính <loc> trong sitemap rồi fetch lại, không gõ tay đường dẫn — nếu không lần sau lại lệch).

### [vua] Trần 100 danh mục ở storefront trong khi seller không có trần và sitemap lấy 200 — danh mục thứ 101 trở đi biến mất khỏi menu và trả 404 khi bấm vào

**Điều kiện cần đủ:** Cần shop có >100 danh mục còn sống (deleted_at IS NULL). Không cần bật gì. Rất dễ chạm với: bộ nhập CSV từ sàn khác (tự đẻ danh mục theo mỗi đường dẫn), hoặc tạp hoá/siêu thị dùng cây 2 cấp. Shop ≤100 danh mục hoàn toàn không dính. Hậu quả nặng dần theo số vượt trần.

**Đề xuất:** Chọn MỘT con số cho khái niệm "danh mục của shop" và đặt nó một chỗ (hằng dùng chung), rồi hoặc (a) nâng trần storefront lên bằng trần sitemap/seller và ép trần khi TẠO danh mục (trả lỗi rõ ràng ở seller thay vì im lặng cắt ở storefront), hoặc (b) bỏ trần ở truy vấn cây và chỉ trần số mục HIỂN THỊ trong menu, còn resolveCatSlug 


## Hoa hồng cộng tác viên

### ✅ ĐÃ VÁ (tinhLaiHoaHongCTV) — [nghiem-trong] Trả hàng MỘT PHẦN trong hạn giữ: hoa hồng vẫn chốt trên căn cứ GỐC — đúng cái hold_days sinh ra để chặn

**Điều kiện cần đủ:** Mặc định, không cần shop bật gì thêm ngoài việc bật chương trình CTV (shop_affiliate_config.enabled=true) và đơn có ?ref= hợp lệ. hold_days>0 (mặc định 7) là điều kiện để có cửa sổ trả hàng — nghịch lý là hold_days càng dài càng dễ dính. Chỉ cần trả/hoàn MỘT PHẦN (không phải toàn bộ): trả hết mọi dòng thì đơn sang 'returned' nên không rơi vào ca này (nhưng lại rơi vào lỗ 'returned' ở phát hiện riêng). Không có test nào phủ: ap

**Đề xuất:** Trong createReturn/refundOrder (và mọi chỗ ghi refunds kind<>'edit_adjustment'), nếu đơn có dòng hoa hồng status='pending' thì tính lại base_vnd = max(0, subtotal − discount − Σ tiền hàng đã hoàn) rồi amount_vnd = affiliate_commission_amount(base mới, rate_kind, rate_value) (hàm 0131 — KHÔNG nhân tay ở JS). Dòng đã 'eligible'/'p

### [cao] docs/51 quy tắc 4 KHÔNG được cài  [✅ ĐÃ VÁ — tinhLaiHoaHongCTV]: sửa đơn đổi tiền hàng nhưng hoa hồng pending không tính lại

**Điều kiện cần đủ:** Chỉ cần chương trình CTV bật + đơn có mã giới thiệu + shop dùng chức năng Sửa đơn (v1 đơn chưa trả: perm orders.write; v2 đơn đã trả: perm refund + step-up). Cả hai đều đi qua reconcileEditLines nên đều dính. Xảy ra khi hoa hồng còn 'pending' — tức trước khi giao xong + hết hold_days, mà sửa đơn chỉ cho phép ở trạng thái pending/confirmed (orders.js:1110, 1142) nên hoa hồng CHẮC CHẮN còn pending. Nghĩa là: mọi lần sửa đơn có m

**Đề xuất:** Cuối reconcileEditLines, sau UPDATE orders, thêm: `UPDATE affiliate_commissions SET base_vnd=$2, amount_vnd=affiliate_commission_amount($2, rate_kind, rate_value), updated_at=now() WHERE order_id=$1 AND status='pending'` với $2 = max(0, subtotal − discount) — dùng ĐÚNG biểu thức của checkout (server.js:1015) để hai nơi không trô

### ✅ ĐÃ VÁ (canon_phone 0137) — [cao] Chặn CTV tự mua bị vô hiệu hoàn toàn nếu shop lưu SĐT dạng +84 — hai nơi chuẩn hoá SĐT khác nhau

**Điều kiện cần đủ:** Điều kiện DUY NHẤT là SĐT CTV được lưu ở dạng có tiền tố quốc gia ('+84…' hoặc '84…'). Dạng '0…' hoặc có khoảng trắng/chấm/gạch ('0900 001 111') thì vẫn chặn đúng vì cả hai bên đều rút về chuỗi số giống nhau. block_self_referral mặc định true nên shop KHÔNG phải bật gì — họ tin là đang được bảo vệ. Không cần shop làm sai thao tác nào khác.

**Đề xuất:** Chuẩn hoá ở BÊN GHI bằng đúng luật của canonPhone (bỏ ký tự không phải số, 84→0, <8 số thì để NULL) trước khi INSERT/UPDATE affiliates.phone — hoặc so ở SQL bằng một hàm DB dùng chung (cùng lối affiliate_commission_amount 0131: một công thức, đặt cạnh dữ liệu). Thêm ca e2e với CTV lưu '+84900001111' và khách gõ '0900001111'.


## Vận chuyển qua hãng

### ✅ ĐÃ VÁ — [cao] Đổi hãng vận chuyển (GHTK→GHN) làm CHẾT ÂM THẦM đồng bộ mọi vận đơn đang chạy của hãng cũ — COD không bao giờ tự chốt 'paid'

**Điều kiện cần đủ:** Cần đủ: (1) shop ĐÃ tạo vận đơn qua hãng A và còn dòng status='in_transit'; (2) shop đổi sang hãng B bằng PUT /shipping (perm shop.write + step-up — chính chủ shop làm, không phải kẻ tấn công). Mặc định BẬT: TRACKING_ON/sweep chạy sẵn, không cần shop tự bật gì. KHÔNG cần điều kiện đặc biệt nào khác — chỉ cần shop đổi hãng khi còn hàng đang đi. Lưu ý: nếu shop chỉ dán LẠI token của CÙNG một hãng thì không dính (provider khớp).

**Đề xuất:** 

### ✅ ĐÃ VÁ (+5 chỗ lân cận) — [vua] Vận đơn ĐÃ HUỶ vẫn được tính là "hãng còn nợ tiền" — sổ đối soát COD và memo trong Báo cáo P&L đẻ ra khoản phải thu MA

**Điều kiện cần đủ:** Cần đủ: (1) đơn COD; (2) từng tồn tại MỘT dòng shipments có provider (ghn/ghtk) — kể cả dòng đã huỷ; (3) dòng provider mới nhất đang ở status='cancelled'; (4) đơn có delivered_at (shop tự bấm "Đã giao xong" sau khi giao tay, hoặc kiện khác được sweep chốt). Mặc định BẬT hoàn toàn: không cần shop bật cờ nào, hai màn hình Đối soát COD và Báo cáo P&L đều đọc đúng hai câu SQL này. Đường dễ xảy ra nhất là shop huỷ vận đơn trên port

**Đề xuất:** 

### [cao] Sweep tự huỷ claim sau 15' bằng giả định "tracking NULL = hãng CHƯA tạo" — đúng lúc mà cả hệ thống thiết kế ra cờ 'ambiguous' vì KHÔNG BIẾT; vận đơn thật + tiền COD mồ côi, và thông báo cho shop hứa một việc không có code nào làm

**Điều kiện cần đủ:** Cần đủ: (1) request tạo vận đơn timeout/đứt mạng SAU khi hãng đã nhận lệnh — tức quá 10s (CARRIER_TIMEOUT_MS, carriers.js:16) hoặc rớt kết nối giữa chừng; (2) worker chạy (TRACKING_ON) để GC 15' kích hoạt — đây là mặc định. Cùng cơ chế còn kích hoạt ở đường thứ hai: khi tx chốt hỏng VÀ câu UPDATE bù cũng hỏng (shipping.js:218-220 kết thúc bằng `.catch(() => {})`), tracking cũng không kịp ghi → 15' sau bị huỷ mù y hệt. KHÔNG cầ

**Đề xuất:** 


## Phiên · MFA · step-up

### ✅ ĐÃ VÁ — [cao] Console nền tảng: lưu cấu hình THU TIỀN là ngõ cụt — 403 step_up_required bị nuốt thành "bạn không có quyền", và trang đó không có bất kỳ ô mật khẩu / route step-up nào

**Điều kiện cần đủ:** Mặc định, không cần shop bật gì. Chỉ cần phiên staff chưa step-up trong 5 phút — tức là MỌI lần đăng nhập mới. Xảy ra 100% ở lần cấu hình đầu tiên (đúng lúc chưa ai từng step-up). Nếu người dùng vô tình vừa suspend/restore/renew/terminate một shop trong 5 phút trước đó thì lưu được, nên lỗi này TRÔNG như chập chờn.

**Đề xuất:** Đảo thứ tự trong platformBillingSave: kiểm `r.json?.step_up_required` TRƯỚC `isDenied(r.status)` (giống hệt platformStatus:231 / doPlatformRenew:250 / doPlatformTerminate:265), và thêm route POST /platform/billing/step-up + form mật khẩu mang theo sepay_token/enabled (mirror renderPlatformStepUp có hidden field). Thêm khẳng định

### ✅ ĐÃ VÁ (+ mfaDisable) — [cao] BẬT MFA không thu hồi các phiên KHÁC — phiên mở trước khi bật 2FA giữ nguyên quyền đầy đủ 7 ngày, kể cả cổng "nhân viên nền tảng phải bật MFA"

**Điều kiện cần đủ:** Mặc định, không cần shop bật gì. Cần: (a) tài khoản có ≥2 phiên sống cùng lúc TRƯỚC khi bật MFA — chuyện bình thường (điện thoại + máy tính, hoặc máy cửa hàng), (b) bật MFA từ một trong các phiên đó. Cửa sổ tồn tại = phần còn lại của SESSION_TTL_HOURS=168 (tối đa 7 ngày). Người dùng CÓ đường tự chữa (/account → "Đăng xuất mọi thiết bị KHÁC") nhưng phải tự nghĩ ra, và đúng màn hình sau khi bật MFA lại ẩn nút đó.

**Đề xuất:** Trong transaction của mfaActivate (apps/auth/src/server.js:381-401) thêm `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id != $2 AND revoked_at IS NULL` — copy nguyên câu ở changePassword:553. Cân nhắc làm tương tự cho mfaDisable. Tối thiểu: bỏ `sessions: []` ở apps/seller-admin/src/server.js:2085, gọi lại /auth/

### ✅ ĐÃ VÁ (0138) — [cao] Lời mời thành viên KHÔNG thu hồi được và KHÔNG bị thay thế: mời nhầm email/nhầm vai trò là ngõ cụt 7 ngày, và "gỡ thành viên" không đụng tới lời mời chưa dùng

**Điều kiện cần đủ:** Mặc định, không cần bật gì. Cần: một lời mời chưa dùng còn trong hạn 7 ngày (expires_at cố định `now() + interval '7 days'` ở apps/seller/src/server.js:258; phía platform là INVITE_TTL_DAYS). Kịch bản gõ nhầm email: chỉ cần domain gõ nhầm có người sở hữu — hoàn toàn nằm ngoài tầm kiểm soát của shop. Kịch bản mời-hai-lần: chỉ cần bấm Mời lần thứ hai, chuyện xảy ra thường xuyên khi email vào spam.

**Đề xuất:** Ba việc, việc (1) là bắt buộc: (1) thêm cột revoked_at vào invitations + điều kiện `AND revoked_at IS NULL` ở apps/auth/src/server.js:700, + route DELETE/POST .../members/invitations/:id/revoke ở seller (perm members.write + stepUp: true như các route nhân sự khác), + khối "Lời mời đang chờ" kèm nút Huỷ trong renderMembers; (2) 


## Xuất dữ liệu & báo cáo

### ✅ ĐÃ VÁ — [cao] Báo cáo P&L (và CSV P&L) KHÔNG trừ tiền giảm bằng ĐIỂM THƯỞNG — doanh thu và lãi phồng lên đúng bằng số điểm khách đổi; Tổng quan và Báo cáo nói hai con số ✔ ĐÃ TỰ KIỂM CHỨNG

**Điều kiện cần đủ:** CẦN: shop bật điểm thưởng (shop_loyalty_config.enabled DEFAULT false — shop phải TỰ BẬT, migration 0086:36) + khách ĐĂNG NHẬP tài khoản storefront (apps/checkout/src/server.js:917 `if (ctx.customerId)`) + đổi ≥ min_redeem_points. KHÔNG cần gì thêm: khi ba điều đó xảy ra thì mọi đơn đổi điểm đều sai, mặc định, không có cờ nào tắt được. Shop chưa bật loyalty thì points_discount_vnd = 0 và báo cáo đúng.

**Đề xuất:** Sửa reports.js:163 thành `sum(o.subtotal_vnd - o.discount_vnd - o.points_discount_vnd)` (và cân nhắc thêm một dòng P&L riêng "Giảm giá bằng điểm" để chủ shop thấy chi phí chương trình). Đồng thời thêm vào fixture reports.e2e.mjs một đơn có points_discount_vnd > 0 để đẳng thức stats↔reports ở dòng 249 thực sự canh được lỗi này.

### ✅ ĐÃ VÁ (5 nơi, không phải 3) — [cao] Nút "Xuất CSV" ở trang Đơn hàng đánh rơi bộ lọc TÌNH TRẠNG THANH TOÁN — xuất thừa toàn bộ SĐT/địa chỉ khách, và với shop lớn thì rơi thẳng vào ngõ cụt 413

**Điều kiện cần đủ:** Không cần shop bật gì. Chỉ cần: vai owner (perm 'export', rbac.js:22+38 — admin không có) + vào trang Đơn hàng qua đường có ?payment= (ô "Đơn chưa thu tiền" trên Tổng quan là đường mặc định, pages.js:1791) rồi bấm Xuất CSV. Lọc bằng status/q/from/to/source thì KHÔNG bị (5 trường đó có hidden).

**Đề xuất:** Thêm `<input type="hidden" name="payment" value="${esc(filter.payment ?? '')}">` vào exportBtn (pages.js:2245) và `payment: ['unpaid','pending','paid','refunded'].includes(f.payment) ? f.payment : ''` vào ordersExportFields (server.js:2339); thêm `payment` vào nav() dòng 2222. Về lâu dài nên dựng danh sách trường lọc thành MỘT h

### ✅ ĐÃ VÁ (date-range.js) — [vua] Khoảng ngày của danh sách + xuất CSV đơn hàng cắt theo biên UTC, trong khi Báo cáo/Nhập hàng cắt theo biên giờ VN — cùng một ô "Từ ngày/Đến ngày" cho hai tập đơn khác nhau

**Điều kiện cần đủ:** CẦN: có đơn tạo trong khung 00:00–07:00 giờ VN (đúng khung săn sale 0h) + người bán dùng ô Từ ngày/Đến ngày ở trang Đơn hàng hoặc bản xuất CSV đơn. Đây là mặc định — không có thiết lập nào của shop bật/tắt. SẼ HẾT nếu ai đó đặt TimeZone='Asia/Ho_Chi_Minh' cho DB (hiện không nơi nào đặt), nhưng khi đó lại lệch với các chỗ đã hard-code AT TIME ZONE ở reports/purchasing nếu có ai chỉnh nửa vời.

**Đề xuất:** Đưa rangeSql (bản có AT TIME ZONE) ra một module dùng chung (đang bị chép 2 bản ở reports.js:115 và purchasing.js:362) rồi cho buildOrderFilter dùng nó thay cho `::date` trần. Kèm truyền timeZone:'Asia/Ho_Chi_Minh' cho dt() ở pages.js:10 để cột Thời gian không đứng một múi giờ khác với con số trong báo cáo.
