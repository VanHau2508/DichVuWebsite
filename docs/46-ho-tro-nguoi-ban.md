# 46 — Hỗ trợ người bán: từ lời kêu cứu tới lời trả lời

Migration `0107` (bảng phiếu) + `0108` (ghi chú xử lý, email người gửi) + `0109` (bối cảnh chẩn đoán).

## 1. Vì sao có

Đây là **lỗ vận hành**, không phải thiếu tính năng.

Trước self-serve signup (docs/43), mọi shop đều qua concierge — có số điện thoại, có người
quen. Sau self-serve, một người có thể mở shop lúc 2 giờ sáng mà **không quen ai**. Gặp trục
trặc thì trong sản phẩm không có đường nào liên hệ: họ bỏ đi, và ta không bao giờ biết vì sao
mất khách.

Nút thắt "vận-hành-SaaS" đã nêu gồm bốn mảnh: self-serve signup ✓, onboarding ✓, di cư ✓ — và
hỗ trợ. Đây là mảnh cuối.

## 2. Vòng khép kín

```
Người bán            nentang.vn                        Chủ nền tảng
─────────            ──────────                        ────────────
Trợ giúp
  └─ gửi phiếu ───►  support_tickets (RLS shop mình)
                     outbox CÙNG TX ─────► worker ────► Telegram + email  🆘
                                                              │
                     Console → hàng đợi xuyên shop ◄───────────┘
                          │  đọc, xem trang họ đang đứng
                          │  bấm "Đã xử lý" + ghi chú
                          ▼
                     outbox CÙNG TX ─────► worker ────► email + Telegram  ✅
Trang Trợ giúp ◄──── ghi chú hiện trên phiếu
```

Hai chiều đều đi qua outbox (ADR-006) trong **cùng transaction** với dòng dữ liệu nó mô tả:
không có phiếu nằm im không ai biết, cũng không có thông báo về một phiếu chưa tồn tại.

## 3. Những quyết định đáng nhớ

**Lưu DB chứ không gửi-rồi-quên.** Bắn thẳng Telegram thì không có hàng đợi, không biết cái
nào đã xử, và người bán không thấy yêu cầu của mình đã tới nơi. Một dòng trong DB giải quyết
cả ba.

**Mọi vai gửi được** (`perm: 'orders.read'`, mức thấp nhất mọi vai đều có). Bắt phải có quyền
cấu hình mới kêu cứu được là chặn đúng người đang cần giúp — nhân viên bán hàng gặp lỗi lúc 9
giờ tối là người duy nhất có mặt.

**Trần theo SỐ PHIẾU CHƯA XỬ (20/shop), không phải rate-limit thời gian.** Người đang gặp sự
cố thật có thể gửi vài phiếu liên tiếp; thứ cần giới hạn là hàng đợi của chủ nền tảng, không
phải nhịp gõ của người bán. Hệ quả có chủ đích: hàng đợi không được dọn thì shop bị nghẽn —
áp lực đặt đúng chỗ.

**Hàng đợi xếp FIFO (chờ lâu nhất trước).** Xếp mới-trước sẽ bỏ đói đúng người đã chờ lâu
nhất, cũng là người sắp bỏ đi. Tab "Đã xử lý" thì ngược lại (mới nhất trước): ở đó ta đang
xem lại việc vừa làm.

**Cờ quá hạn 24h.** Chờ quá một ngày thì lời hứa hỗ trợ đã hỏng dù cuối cùng có trả lời.
Vì danh sách xếp cũ-trước nên phiếu trễ tự nổi lên đầu — không cần bộ lọc riêng.

**`from_email` CHÉP vào phiếu, không JOIN `users`.** `app_platform` không có quyền nào trên
bảng `users` (cố ý — xem 0075/0091 siết cột). Mở `SELECT users` cho console chỉ để hiện một
địa chỉ là nới đặc quyền vĩnh viễn đổi lấy một tiện nghi. Chép cũng đúng nghĩa hơn: phiếu
phải nhớ ai gửi kể cả khi người đó rời shop — cùng lối nghĩ với snapshot giá/địa chỉ trên đơn.

**Ghi chú xử lý là bắt buộc về mặt thiết kế, tuỳ chọn về mặt thao tác.** Đổi nhãn sang "Đã xử
lý" mà không nói gì là một lời hứa suông, còn tệ hơn im lặng vì làm người bán tưởng mình đã
được trả lời. Nhưng có việc xử xong bằng một cuộc gọi — nên ô ghi chú để trống vẫn gửi được.

**Idempotent theo guard `status='open'`.** Bấm hai lần (F5, hai nhân viên cùng mở) chỉ đổi
trạng thái một lần → chỉ một outbox → người bán không nhận hai email cho cùng một phiếu. Lần
thứ hai trả `{already:true}` chứ không 409: người bấm không làm gì sai.

**Có đường MỞ LẠI.** Thiếu nó thì "đã xử lý" là ngõ cụt và người ta sẽ né không dám bấm. Mở
lại **xoá** ghi chú cũ (giữ lại nghĩa là để một lời giải thích không còn đúng nằm trên phiếu
đang mở) và **không** bắn thông báo (không có gì mới để nói).

**Route phiếu KHÔNG khoá `minRole:'admin'`.** Trả lời hỗ trợ chính là việc của operator; bắt
phải là admin nghĩa là chỉ chủ nền tảng trả lời được — đúng cái nút cổ chai đang gỡ. Thao tác
cũng không phá hoại, và đã có đường mở lại. Gate admin cho suspend/terminate/tiền vẫn nguyên.

**Worker: chiều đi và chiều về đi hai đường khác nhau.** Chiều đi (`support.ticket_created`)
gửi cho CHỦ NỀN TẢNG — nhét vào đường email-khách sẽ phải bịa `payload.to`, mà bịa địa chỉ
trong đường gửi thư là cách gửi nhầm người; hàm này **không throw** (retry sẽ nhân bản thông
báo trong khi phiếu đã nằm trong DB). Chiều về (`support.ticket_resolved`) gửi cho NGƯỜI BÁN
qua đường chung, và cố ý **không** truyền `shop_name` → `brandOf()` rơi về `PLATFORM_BRAND`:
thư này do nentang.vn gửi, đóng dấu tên shop của người nhận lên đó là mạo danh họ với chính họ.

## 4. Cấu hình khi deploy

| Biến | Không đặt thì sao |
|---|---|
| `SUPPORT_ZALO` / `SUPPORT_PHONE` / `SUPPORT_EMAIL` / `SUPPORT_HOURS` | Phần "Liên hệ trực tiếp" ẩn đi; form gửi yêu cầu **vẫn hoạt động** (đường luôn có) |
| `ALERT_TELEGRAM_CHAT_ID` (đã có sẵn cho cảnh báo tiền) | Không có Telegram khi phiếu mới tới — phiếu vẫn nằm trong console |

Thông tin liên hệ để ở **biến môi trường** chứ không phải bảng cấu hình: một dòng cho toàn hệ,
đổi vài tháng một lần; thêm cả bảng + màn quản trị cho một dòng là chi phí không đổi lại được gì.

## 5. Test

* `apps/seller-admin/test/admin-support.e2e.mjs` (12) — chiều đi: form, PRG chống-F5-gửi-lặp,
  lưu DB + outbox, `order_manager` gửi được, cô lập chéo shop hai chiều, chặn rỗng, trần phiếu.
* `apps/seller-admin/test/platform-support.e2e.mjs` (30) — chiều về: hàng đợi xuyên shop,
  người ngoài bị chặn mà **không lộ nội dung**, FIFO, cờ quá hạn, xử lý → outbox đúng người
  nhận, bấm hai lần **không nhân đôi thông báo**, mở lại, ghi chú hiện đúng bên người bán,
  operator xử được nhưng vẫn không khoá được shop, CSRF.

Bộ thứ hai **dọn phiếu mở tồn** trước khi đo: hàng đợi xếp cũ-trước, mỗi trang 20 phiếu, nên
rác của lần chạy trước chiếm sạch trang 1 và khẳng định về thứ tự hoá ra đang đo bãi rác.

## 5b. Bối cảnh chẩn đoán (0109)

Vòng hỏi-đáp đắt nhất của hỗ trợ không phải "lỗi gì" mà là **"anh đang ở đâu, với tư cách
gì"**. Rất nhiều phiếu hoá ra không phải lỗi: người gửi đang ở vai `order_manager` nên không
thấy nút cấu hình, hoặc shop còn `onboarding` nên chưa bật thứ họ đang tìm, hoặc trình duyệt
của họ không chạy được tính năng đó. Máy biết sẵn cả ba lúc bấm gửi — hỏi lại người đang bực
là lãng phí một vòng, mà mỗi vòng là một cơ hội để họ bỏ đi.

`support_tickets.diag` (jsonb) chép: **vai người gửi · trạng thái shop · trình duyệt**.

* **Vai lấy từ `ctx.role`** (seller tự suy ra từ membership), KHÔNG nhận từ body. Đây là thứ
  quyết định "vì sao anh không thấy nút" — để BFF khai thì phiếu có thể nói sai. Có e2e gửi
  kèm vai giả để chốt.
* **UA thì ngược lại, BẮT BUỘC nhận từ body.** Trình duyệt nói chuyện với seller-admin; seller
  chỉ thấy UA của chính BFF (undici) — đọc ở đó sẽ ra một chuỗi vô nghĩa *trông rất giống dữ
  liệu thật*, và đó là kiểu sai tệ nhất.
* Hiển thị là **một dòng người đọc được** ("Vai: chủ shop · shop đang thiết lập · Android ·
  Chrome"), không đổ JSON — đổ object ra màn hình là đẩy việc phân tích sang người đang vội.
  Trạng thái `active` cố ý IM LẶNG: chỉ nói khi có gì bất thường.
* jsonb chứ không phải cột rời: bối cảnh còn nở thêm, và không truy vấn nghiệp vụ nào lọc
  theo nó — chỉ đọc bằng mắt trên đúng một màn hình.

## 6. Còn thiếu (v2)

* **Không có ô tìm/lọc theo shop** trong hàng đợi. Với vài chục shop thì lật trang là đủ và
  FIFO là mặc định đúng; khi backlog lớn thì cần.
* **Không có trả lời trong sản phẩm** — ghi chú là một chiều. Muốn hỏi lại thì vẫn phải
  email/Zalo (nút `mailto:` trên mỗi phiếu đã điền sẵn tiêu đề).
* **Không đính kèm ảnh chụp màn hình.** Hạ tầng NHẬN tệp đã có (`0101`: sniff magic byte +
  re-encode sharp + bucket private) — nhưng khâu HIỂN THỊ mới là chỗ vướng: seller-admin
  không có quyền MinIO, nó proxy byte qua seller (`reviewImage`). Người xem phiếu là chủ nền
  tảng, không có tư cách thành viên shop, nên đường đó dùng lại không được — phải cắm MinIO
  vào service `platform` (thêm credential + thêm bề mặt cho một service đang chỉ chạm
  Postgres). Đó là một quyết định hạ tầng, không phải một buổi code. §5b là phần 80% giá
  trị lấy được mà không cần trả giá đó.
