# 65 — Vai "chủ shop lúc có sự cố": bốn chỗ chặn đường khi khách đang cáu

**2026-08-05.** Vai thứ tư và là vai cuối trong bốn vai đặt ra ban đầu. Ba vai trước (shop mới mở
· khách mua · shop ngày-60) đi lúc mọi thứ suôn sẻ. Vai này đi lúc **hỏng**: khách khiếu nại giao
sai màu, đòi đổi gấp, hỏi hàng đang ở đâu, đòi tiền về.

Hiện trường không phải dựng lại — dùng luôn shop ngày-60 (`scripts/seed-day60.sh`) với 395 đơn
trải đủ mọi trạng thái, gồm cả đơn đã huỷ, đơn bom hàng, đơn trả một phần.

## Vì sao vai này khác các vai trước

Lúc bình thường, phần mềm chậm hoặc thiếu một nút thì người bán chép miệng bỏ qua. Lúc khách
đang chờ máy, mỗi lần phải mò là một lần họ nhớ — và cái họ làm khi phần mềm không cho làm là
**ghi tay ra ngoài phần mềm**. Từ giây đó sổ sách bắt đầu sai, và không ai biết nó sai ở đâu.

Nên tiêu chí của vai này không phải "có tính năng không" mà: **có đường ra không, và đường ra có
đúng sổ không.**

## Bốn chỗ đã vá

### 1. Đơn trả trước bị bom hàng — tiền kẹt vĩnh viễn, mà câu từ chối lại chỉ sai chỗ

Chốt hoàn tiền khoá theo **trạng thái**:

```js
if (o.status === 'returned') return { code: 409, msg: '... xem mục Hoàn tiền của đơn' };
```

Nhưng có **hai đường** tới `returned`:

| đường | có phiếu hoàn không |
|---|---|
| RMA (khách gửi hàng về, `createReturn`) | **có** — hàm tự ghi phiếu |
| Bom hàng (`mark-returned`, khách không nhận) | **không** — cố ý, vì COD bom là chưa thu đồng nào |

Đơn **trả trước** rồi bị bom rơi vào đường thứ hai: shop đang giữ tiền của khách, bấm Hoàn tiền
ra 409, và câu 409 bảo đi xem "phiếu trả" — **một phiếu không tồn tại**. Đo trên shop ngày-60:
đơn #216, 775.000₫, không có lối nào ghi được khoản hoàn.

**Vá:** khoá theo **bằng chứng** thay vì theo trạng thái.

```js
if (o.status === 'returned') {
  const daCoPhieu = (await c.query(
    `SELECT 1 FROM refunds WHERE order_id = $1 AND kind <> 'edit_adjustment' LIMIT 1`, [orderId])).rows[0];
  if (daCoPhieu) return { code: 409, msg: '...' };
}
```

Trần `remaining` sẵn có vẫn chặn hoàn đúp — nới đúng một khe, không nới cả cánh cửa.

> **Lớp lỗi:** *một trạng thái, hai đường tới.* Chốt viết theo trạng thái thì đúng với đường
> người viết đang nghĩ tới và sai với đường kia. Khi chốt chặn một thao tác vì "chắc đã làm rồi",
> hãy hỏi **thứ đó có để lại dấu vết nào không** — rồi khoá theo dấu vết.

### 2. Bấm nhầm "Đã nhận tiền (COD)" — đường lùi duy nhất là ghi một phiếu hoàn khống

Không có nút gỡ. Cách duy nhất là ghi phiếu hoàn cho một khoản **chưa từng trả**. Đo trên báo cáo
P&L thì sổ sai **bốn chỗ** cùng lúc: doanh thu hàng phồng lên một lần bán không có thật · dòng
hoàn tiền phồng lên một lần trả không có thật (con số này đi thẳng vào quyết toán) · doanh thu
thuần và lãi gộp cùng thấp đi đúng bằng phí ship, vì phiếu hoàn ôm cả ship còn doanh thu chỉ ghi
phần hàng.

**Vá:** endpoint `POST /orders/:id/unmark-paid` + nút `↶ Gỡ "đã nhận tiền"` hiện có điều kiện.

Điều kiện ngặt — đây là **cái tẩy**, không phải cái cửa:
- chỉ đơn **COD** (tiền QR đã vào tài khoản thật, không ai "gỡ" một giao dịch ngân hàng);
- chỉ khi **chưa có phiếu hoàn** nào (đã hoàn rồi thì trạng thái trả tiền là dữ kiện của nghiệp
  vụ hoàn — gỡ nó là làm hỏng sổ chứ không phải sửa sổ);
- chỉ đơn **chưa ở trạng thái cuối**;
- **không** gửi email cho khách: họ vừa nhận biên nhận "đã thanh toán" lúc bấm nhầm, gửi thêm thư
  "thật ra chưa" chỉ làm khách hoang mang. Đây là lỗi nội bộ, người bán tự nhắn nếu cần.

Cùng `orders.write`, **không** step-up — y như chính nút đã gây ra lỗi. Bắt gõ lại mật khẩu để
sửa một lỗi mình vừa tạo là đẩy người ta sang cách làm bậy.

### 3. Không nút tiền / một chiều nào hỏi lại

Cơ chế `data-confirm` **đã có sẵn** trong kho — dùng cho "Lưu trữ sản phẩm", "Nhập thật", "Thu hồi
khoá API". Nhưng **không một nút đơn hàng nào** gắn nó: Huỷ đơn (bắn email tới khách ngay), Bom
hàng, Đã nhận tiền, giao **hàng loạt** (một cú bấm = N email).

**Vá:** `act()` nhận thêm tham số `hoi`; gắn cho Huỷ đơn · Bom hàng · mark-paid · mark-paid-qr ·
bulk-ship · bulk-mark-paid. Câu hỏi nói **hậu quả cụ thể** (số tiền, "khách nhận email ngay"),
không phải "Bạn chắc chứ?".

**Cố ý KHÔNG gắn cho "Xác nhận đơn"** — thao tác đó lùi được. Thêm ma sát ở chỗ vô hại chỉ dạy
người ta bấm bừa qua cả những chỗ có hại.

### 4. Huỷ nhầm đơn là xoá sổ đơn

Màn hình đơn đã huỷ chỉ còn đúng dòng **"Không có thao tác."**. `POST /reopen`, `/uncancel`,
`/restore` → 404 (chưa từng tồn tại); `/confirm`, `/ship`, `/mark-paid` → 409. Muốn bán tiếp phải
gõ tay một đơn mới: mất số đơn khách đang cầm, mất lịch sử, và với đơn đã thu tiền thì khoản tiền
đó không còn chỗ nào bám vào.

**Vá:** `POST /orders/:id/reopen` + nút `↻ Mở lại đơn`.

- Về **`pending`** chứ không về trạng thái cũ — đưa đơn về đầu luồng để người bán tự bấm xác nhận
  lại có ý thức. Và vì `pending` nằm trong cổng huỷ, **đơn vừa mở lại vẫn huỷ được**: không đổi
  một ngõ cụt lấy một ngõ cụt khác.
- **Giữ chỗ tồn lại.** Huỷ đã nhả reserve; 60 ngày sau hàng có thể đã bán cho người khác. Chốt
  thật nằm ở điều kiện của chính lệnh ghi (`AND on_hand - reserved >= $2` + kiểm `rowCount`) chứ
  không phải ở vòng đọc phía trên — kiểm-rồi-mới-ghi thì giữa hai bước vẫn có khách khác chốt đơn
  xong, và cái lọt qua khe đó là bán quá tồn. Vòng đọc chỉ để soạn câu báo **gọi đúng tên** sản
  phẩm thiếu và số còn lại.
- **Cố ý bỏ qua đệm tồn-an-toàn** (docs/62): đệm đó chặn đơn **mới** để khỏi bán quá tay, còn đây
  là đơn cũ vốn đã từng giữ đúng số hàng ấy. Bắt nó qua đệm là dựng lên một ngõ cụt mới ngay
  trong tính năng vừa mở ngõ cụt cũ.
- **Chặn khi đã có phiếu hoàn** — tiền đã chạy ngược về khách rồi.
- **Báo khách**: họ vừa nhận thư "đơn đã huỷ". Nhánh email riêng trong worker, vì trạng thái đích
  là `pending` mà nhãn thô của nó lọt ra ngoài sẽ thành *"Đơn hàng #216 — pending"* trong hộp thư
  của người Việt.
- Câu hỏi-lại của nút **Huỷ đơn** phải sửa theo: nó đang doạ *"đơn KHÔNG mở lại được"*, nay sai.
  Phần mềm nói sai một câu thì người dùng bỏ qua **mọi** câu nó nói.

## Ba lỗi đo của chính tôi trong đợt này

1. **Khẳng định xanh vì chốt khác chặn trước.** Bộ test khẳng định "đơn đã hoàn tiền → 409" và nó
   xanh — nhưng đơn dùng để thử ở trạng thái `returned`, nên **chốt trạng thái** chặn trước, chốt
   phiếu-hoàn không bao giờ được chạm tới. Đột biến gỡ hẳn chốt phiếu-hoàn: **vẫn xanh**. Phải
   dựng đúng ca *đã huỷ **và** đã hoàn tiền* — và hoàn **một phần**, vì hoàn đủ thì đơn nhảy sang
   `refunded` và chốt trạng thái lại che mất lần nữa.
2. **Khẳng định về email trên đơn không có email.** `statusEvent` cố ý im lặng với đơn thiếu email
   (đơn chốt trong chat Messenger). Test tạo đơn không email → không sự kiện nào được phát → mọi
   khẳng định "khách có được báo không" đều vô nghĩa.
3. **`grep -E "^[0-9]+ pass"` báo đỏ giả.** Dòng tổng kết có mã màu ANSI đứng trước nên `^` không
   khớp; hai bộ hồi quy bị báo "KHÔNG CÓ DÒNG PASS = ĐỎ" trong khi cả hai đều xanh. Cùng họ với
   luật đã ghi trong `bo-chay-test-tu-lua.md`, nhưng theo chiều ngược lại.

> Luật rút ra: **một chốt chặn chỉ được coi là có test khi có đột biến gỡ nó và test đỏ.** Ca thử
> phải đi qua *đúng chốt đó*, không phải qua một chốt nào đó cùng trả 409.

## Bằng chứng

- `apps/seller-admin/test/admin-su-co.e2e.mjs` — **31 khẳng định**, 5 phần.
- Đột biến đã chứng: (1) chốt hoàn tiền quay về khoá theo trạng thái → đỏ · (2) gỡ `data-confirm`
  → đỏ · (3) bỏ giữ-chỗ tồn khi mở lại → đỏ · (4) bỏ chốt đã-hoàn-tiền khi mở lại → đỏ.
- Bất biến `lock-order.test.js` bắt truy vấn mới: phải là đúng chuỗi `ORDER BY variant_id`, không
  tiền tố `ol.` — nên truy vấn dùng subquery thay vì JOIN để chỉ có một bảng ở `FROM`.

## Còn lại — 17 phát hiện chưa xử

Đã sống sót lớp phản biện nhưng chưa vá, xếp theo mức:

- **không màn hình nào trả lời "tôi còn nợ khách bao nhiêu"** — số này nằm rải trong từng đơn;
- bảng "Đơn bị hoàn" dạy cộng lại tồn **bằng tay** trong khi hệ thống vừa tự cộng (nguy cơ cộng đúp);
- khách bấm link tra cứu vẫn thấy "Đã thanh toán" sau khi đã trả hàng;
- không có chỗ nhập **phí ship đã trả cho hãng** cho đơn bị bom (khoản lỗ thật, không vào P&L).
