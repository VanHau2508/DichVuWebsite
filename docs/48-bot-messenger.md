# 48 — Bot Messenger: khách chốt đơn ngay trong chat

Chặng 2 của [docs/47](47-don-tu-facebook-zalo.md). Mắt xích còn thiếu — *thứ biến cuộc chat
thành cái đơn* — nay đã có.

## Vì sao bot phải là của mình

Đã kiểm tận tài khoản Business Suite thật (Trang `TikFlash - Máy Chốt Đơn`, 01/08/2026):

* Nút **"Trợ lý kinh doanh Meta AI"** có, nhưng là copilot cho **chủ shop** hỏi về quảng
  cáo — không nói chuyện với người mua.
* **Tất cả công cụ** → tìm "AI" → *không kết quả*.
* **Hộp thư → Quy trình tự động hoá → Xem tất cả** = đúng 9 mẫu trả lời **tĩnh** theo từ
  khoá. Không AI, không "kết nối hệ thống", không chỗ nào khai API.

Khớp tài liệu Meta: **Connectors API của Business Agent hiện chỉ có ở nhánh WhatsApp/WABA**.
Bên Messenger chưa. Page mới tinh nên đúng là *"chưa có"*, không phải *"không bao giờ"* —
kiểm lại tốn 2 phút, và nếu Meta mở thì cổng `/ingest/orders` dùng lại được ngay.

## Ít thao tác là yêu cầu, không phải mong muốn

Khách chat mà phải bấm 8 lần thì họ bỏ giữa chừng, và shop mất đơn. Đường ngắn nhất:

| | Thao tác | Cắt được nhờ |
|---|---|---|
| 1 | **[Mua ngay]** | vào từ quảng cáo (`m.me/trang?ref=sp_<id>`) → nhảy thẳng vào món đó; SL mặc định 1 |
| 2 | **bấm SĐT** | quick reply `user_phone_number` — Messenger đưa sẵn số của khách |
| 3 | gõ địa chỉ | chỗ **duy nhất** phải gõ |
| 4 | **[Đặt hàng]** | tóm tắt tiền rồi xác nhận |

**3 chạm + 1 dòng.** Mua lần hai: bot nhớ SĐT/địa chỉ → **2 chạm, không gõ gì**.

Cắt thêm: không hỏi **tên** (lấy từ hồ sơ Messenger) · không hỏi **số lượng** · shop ≤10 sản
phẩm thì **bỏ bước danh mục** · sản phẩm 1 biến thể thì **không hỏi chọn loại**.

## Ba quyết định chốt

**Không LLM.** Đường tiền không được phụ thuộc vào việc mô hình đoán đúng "size L". Đoán sai
một lần là giao nhầm hàng, và người mất tiền là shop. Bot không đoán: không hiểu thì đưa nút.

**Giá/tồn luôn hỏi lại hệ thống**, không tin số bot đang giữ. Khách chọn lúc 9h, chốt lúc
10h mà shop đổi giá thì đơn ăn giá 10h.

**`[Gặp nhân viên]` ở MỌI bước.** Bấm là bot im 6 tiếng, tin nhắn rơi về Hộp thư như thường.
Bot không có lối thoát là cái bẫy, và đó là cách nhanh nhất mất khách khó tính.

## Kiến trúc: bot KHÔNG chạm vào đơn/kho

Vai `app_messenger` (0122) chỉ có quyền trên **đúng hai bảng của riêng nó**:
`shop_messenger_config` + `messenger_sessions`. Tạo đơn đi qua HTTP `/ingest/orders` bằng
khoá kết nối của shop — cùng validate, cùng khoá tồn, cùng idempotency, cùng giá.
Đường tiền không được có bản sao thứ hai; bản sao sẽ trôi lệch, và chỗ trôi lệch luôn là
giá/tồn — thứ không ai thấy cho tới lúc giao nhầm hoặc bán âm kho.

`flow.js` là **hàm thuần**: (state, sự kiện, dữ liệu) → (state mới, tin cần gửi, việc cần
làm). Không I/O. Nhờ vậy toàn bộ kịch bản hội thoại test được không cần Meta, không cần DB.

Một Meta App cho **cả nền tảng**: App Secret là của nền tảng (env), Page Access Token là của
từng shop (mã hoá trong DB). Shop chỉ gắn Trang của họ vào — không phải tự lập app, tự qua
App Review. Đó là khác biệt giữa SaaS dùng được và công cụ cho lập trình viên.

## Bảo mật

* **Mọi webhook qua `X-Hub-Signature-256`** (HMAC-SHA256 raw body), so bằng
  `timingSafeEqual`. Không có nó thì ai biết URL cũng bơm được "đơn" giả vào shop bất kỳ.
* **Trả 200 kể cả khi xử lý hỏng.** Meta gửi lại khi không nhận 200, và gửi lại nghĩa là
  khách nhận **cùng tin nhắn** thêm lần nữa. Lỗi vào log cho người vận hành, không đẩy hậu
  quả sang mặt khách.
* **Idempotency `fb-<psid>-<seq>`**, `seq` chỉ tăng sau khi đơn tạo XONG. Meta gửi lại →
  cùng khoá → trả đơn cũ. Khách muốn mua lại y hệt → seq đã tăng → đơn mới. Đúng cả hai chiều.
* **Ngắt kết nối xoá luôn phiên hội thoại** — chúng chứa SĐT/địa chỉ khách.

## Hai cái bẫy đã vấp (ghi lại kẻo lặp)

**1. `secretbox` khoá cứng vào keyring của vận chuyển.** `seal(x, MESSENGER_ENC_KEY)` vẫn
mã hoá bằng khoá **active của `SHIPPING_ENC_KEYS`** — tham số `keyHex` chỉ dùng khi keyring
rỗng. Bot giải mã ra lỗi `không có khoá kid "k2"`. Đã tham số hoá tên env keyring; Messenger
dùng `MESSENGER_ENC_KEYS` riêng, vì lộ một cái không được kéo theo cái kia, và xoay khoá ship
không được bắt mọi shop kết nối lại Trang.

**2. `??` với chuỗi rỗng.** Hồ sơ Messenger thiếu tên → `join('')` ra `''`, mà `''` không
phải `null` nên `??` giữ nguyên rỗng → đơn chết ở bước cuối với *"thiếu tên khách"*. Đổi
sang `||` + nhãn `Khách Facebook`. Khách khoá hồ sơ là quyền của họ, không được vì thế mất đơn.

## Đường tiền: đơn qua khoá ăn flash sale, đơn nhân viên thì không

`createManualOrder` vốn **không** áp `promo_effective` (checkout thì có). Nếu để nguyên, bot
báo giá sale trong chat rồi hệ thống thu giá gốc — **tính sai tiền khách**. Đã tách theo *ai
chọn giá*: đơn qua khoá kết nối = khách tự phục vụ → ăn sale như website; đơn nhân viên gõ
tay = người, có thể đang chốt giá riêng đã thoả thuận → giữ giá gốc.

## Test

* `apps/messenger/test/bot.e2e.mjs` (29) — Meta giả lập **hai chiều**: bộ test dựng Graph API
  giả để đọc **đúng tin bot gửi khách**, và tự ký webhook như Meta. Đi trọn hội thoại tới
  **đơn thật** (đúng shop, trừ tồn, `source=facebook`, `source_ref` mang PSID). Kèm: chữ ký
  sai → 403 **và không gửi gì** · gửi lại webhook không đẻ đơn thứ hai · handoff làm bot im ·
  Trang lạ im lặng · ngắt kết nối dọn cả phiên + thu hồi khoá bot.
* `apps/seller/test/api-keys.e2e.mjs` (35) — thêm mục 7b: giá sale hai đường.

## Ba việc bổ sung (đã làm)

**Phí ship THẬT trong tóm tắt.** Quy tắc phí ship (phẳng + ngưỡng free-ship) tách thành
`shopShipFee()` — **nguồn duy nhất**, dùng chung bởi `createManualOrder` và endpoint mới
`GET /ingest/shipping-quote`. Hai đoạn mã chép tay chắc chắn sẽ lệch, mà lệch ở phí ship
nghĩa là bot hứa một con số rồi thu con số khác. Test khẳng định CHÉO: tổng bot hứa ở tóm
tắt (229.000₫) == `orders.total_vnd`.

**Đổi số lượng ngay ở tóm tắt.** Giỏ một món → `➕ Thêm 1` / `➖ Bớt 1` đặt thẳng vào màn
tóm tắt (**1 chạm**) — đó là trường hợp gần như luôn xảy ra khi chốt qua chat. Nhiều món →
`✏ Sửa số lượng` rồi chọn món, vì Messenger chỉ cho 11 quick reply. Bớt về 0 = bỏ món (không
bắt tìm nút "xoá" riêng cho việc hiển nhiên). Tăng thì **hỏi lại tồn thật** — chặn ngay tại
chỗ ("chỉ còn 10 cái") thay vì để khách bấm sướng tay rồi ăn lỗi ở bước cuối. Dòng hàng vì
thế lưu thêm `product_id`, nếu không thì tra tồn phải đoán mò.

**Worker dọn phiên nguội** (0123). Phiên giữ tên/SĐT/địa chỉ lần trước — chính thứ khiến
khách mua lần hai chỉ còn 2 chạm — nên nó là PII và phải có hạn (`MESSENGER_SESSION_TTL_DAYS`,
mặc định 90). Giao cho `app_expiry`, vai quét dọn xuyên shop vốn đã làm việc này cho đơn hết
hạn: không đẻ vai mới cho một câu DELETE, và `app_messenger` thì khoá theo shop nên không quét
xuyên shop được. Chạy cùng nhịp `PII_SWEEP_MS` (24h). Không dính bẫy "đói quét": điều kiện
lọc CHÍNH LÀ điều kiện xoá.

## Hai việc cuối (đã làm)

**[Tra đơn của tôi].** "Đơn tôi tới đâu rồi?" là câu shop phải trả lời nhiều nhất — bot tự
trả là bớt việc thật cho nhân viên, và khách không phải chờ tới giờ hành chính. Endpoint
`GET /ingest/orders/lookup?psid=` lọc **theo PSID**, không trả cả sổ đơn: khoá kết nối vốn
đọc được mọi đơn của shop, nên lọc sai ở đây là đưa SĐT/địa chỉ khách A cho khách B (có test
riêng cho đúng điều đó). Trạng thái dịch sang tiếng Việt — khách thấy `shipped` thì không
hiểu, thấy "đang giao" thì hiểu ngay và bớt một tin nhắn hỏi shop.

**Bot báo khi đơn đổi trạng thái.** Đây là chỗ lộ ra một lỗ có sẵn: `statusEvent()` **thoát
ngay khi đơn không có email** — mà đơn chốt trong chat thì không có email (bot không hỏi;
bắt gõ email trong chat là thêm một bước để khách bỏ giữa chừng). Nghĩa là nhóm khách này
đặt xong rồi **im lặng mãi mãi**. Nay sự kiện vẫn phát khi có `messenger_psid`, `to` để null
và đường email tự bỏ qua.

Worker gọi `POST /internal/notify` của service messenger thay vì tự gửi: token Trang và
logic gửi nằm ở đó, chép sang worker là nhân đôi chỗ có thể sai. Kỷ luật y như
`deliverTelegram` — độc lập email, idempotent theo `outboxId`, không bao giờ throw.

Tin báo gắn **`POST_PURCHASE_UPDATE`**: khách đặt hôm nay, shop giao ngày mai — tin rơi ra
ngoài cửa sổ 24h của Meta. Không gắn nhãn thì Meta lặng lẽ từ chối và khách không bao giờ
biết đơn đã đi. Nhãn này Meta định ra đúng cho mục đích đó.

## Còn nợ

* Khách **huỷ đơn** ngay trong chat (hiện phải nhắn nhân viên).
* Bot chưa hỏi **email** nên đơn từ chat không có hoá đơn qua email — chấp nhận đánh đổi để
  giữ 3 chạm; nếu sau này cần thì hỏi SAU khi đặt xong, không phải trước.
