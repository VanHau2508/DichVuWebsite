/**
 * MÁY TRẠNG THÁI của bot Messenger — hàm THUẦN, không I/O.
 *
 * Vì sao tách riêng: luồng chốt đơn là chỗ dễ sai nhất (sai một nhánh là khách kẹt giữa
 * chừng, hoặc tệ hơn là đặt nhầm hàng). Để nó thuần thì test được toàn bộ kịch bản mà
 * không cần Meta, không cần DB, không cần mạng — chạy trong mili giây, nên test được
 * NHIỀU kịch bản chứ không phải một.
 *
 * Vào:  (state hiện tại, sự kiện từ khách, dữ liệu shop đã nạp sẵn)
 * Ra:   (state mới, danh sách tin nhắn cần gửi, việc cần làm — vd "tạo đơn")
 * Nơi gọi (server.js) mới là chỗ nói chuyện với DB, với /ingest, với Send API.
 *
 * NGUYÊN TẮC SỐ THAO TÁC (yêu cầu của chủ dự án: càng ít chạm càng tốt):
 *   · vào từ quảng cáo có ref sản phẩm → NHẢY THẲNG vào món đó, không duyệt danh mục
 *   · shop ≤ MAX_DIRECT sản phẩm → bỏ luôn bước danh mục
 *   · SP một biến thể → [Mua ngay] luôn, không hỏi chọn
 *   · số lượng mặc định 1, đổi ở bước tóm tắt
 *   · tên lấy từ hồ sơ Messenger, SĐT lấy bằng quick reply có sẵn → khách không gõ
 *   · mua lần 2: nhớ địa chỉ cũ → còn 2 chạm, không gõ gì
 */

export const MAX_DIRECT = 10;     // ≤ ngần này SP thì bỏ bước danh mục
export const MAX_CARDS = 10;      // trần phần tử băng chuyền của Messenger
export const MAX_QR = 11;         // trần quick reply của Messenger

const money = (n) => new Intl.NumberFormat('vi-VN').format(Number(n)) + '₫';
// Nút Messenger có trần 20 KÝ TỰ. Vượt là Meta từ chối CẢ tin nhắn (không phải cắt bớt),
// nghĩa là khách thấy bot "im" mà không hiểu vì sao. Cắt ở đây, không tin vào may rủi.
const btnTitle = (s) => (String(s).length <= 20 ? String(s) : String(s).slice(0, 19) + '…');

const text = (t, quickReplies) => ({ kind: 'text', text: t, ...(quickReplies ? { quickReplies } : {}) });
const qr = (title, payload) => ({ title: btnTitle(title), payload });

/** Nút "gặp người thật" — có ở MỌI bước. Bot không có lối thoát = bẫy = mất khách. */
const QR_HUMAN = qr('💬 Gặp nhân viên', 'HUMAN');

const priceLine = (p) => (p.orig_price_vnd != null
  ? `${money(p.price_vnd)} (giá gốc ${money(p.orig_price_vnd)})`
  : money(p.price_vnd));

/** Băng chuyền sản phẩm — mỗi thẻ 1 nút, bấm là vào thẳng bước chọn/mua. */
function productCards(products) {
  return {
    kind: 'cards',
    cards: products.slice(0, MAX_CARDS).map((p) => ({
      title: p.title,
      subtitle: p.available > 0 ? priceLine(p) : `${priceLine(p)} — TẠM HẾT`,
      image: p.image,
      buttons: p.available > 0
        ? [{ title: btnTitle(p.needs_choice ? 'Chọn loại' : '🛒 Mua ngay'), payload: `PICK:${p.id}` }]
        : [{ title: 'Hết hàng', payload: `PICK:${p.id}` }],
    })),
  };
}

function categoryReplies(categories) {
  return [...categories.slice(0, MAX_QR - 1).map((c) => qr(c.name, `CAT:${c.id}`)), QR_HUMAN];
}

export const subtotalOf = (cart) => (cart ?? []).reduce((s, it) => s + it.unit * it.qty, 0);

/**
 * Nút ở màn tóm tắt. Giỏ ĐÚNG MỘT món thì đặt thẳng +/− vào đây — đổi số lượng chỉ tốn
 * 1 chạm, và đó là trường hợp gần như luôn xảy ra khi chốt đơn qua chat. Nhiều món thì đi
 * qua bước chọn món, vì Messenger chỉ cho 11 quick reply, không nhét hết cặp +/− được.
 */
function confirmReplies(state) {
  const cart = state.cart ?? [];
  const qtyBtns = cart.length === 1
    ? [qr(`➕ Thêm 1 (đang ${cart[0].qty})`, `QTYP:${cart[0].variant_id}`),
      ...(cart[0].qty > 1 ? [qr('➖ Bớt 1', `QTYM:${cart[0].variant_id}`)] : [])]
    : (cart.length > 1 ? [qr('✏ Sửa số lượng', 'EDITQTY')] : []);
  return [qr('✅ Đặt hàng', 'PLACE'), ...qtyBtns, qr('+ Mua thêm', 'BROWSE'), qr('❌ Huỷ', 'CANCEL'), QR_HUMAN];
}

/**
 * Màn hình CUỐI trước khi mất tiền — phải ĐỦ và RÕ, nên phí ship là số THẬT chứ không phải
 * "tính sau". Nơi gọi hỏi /ingest/shipping-quote (đúng hàm mà lúc tạo đơn dùng) rồi truyền
 * vào đây; flow.js thuần nên không tự gọi mạng được, và chính điều đó khiến nó test được.
 */
export function summaryMessages(state, shipFee) {
  const cart = state.cart ?? [];
  const sub = subtotalOf(cart);
  const body = [
    'Đơn của bạn:',
    ...cart.map((it) => `• ${it.title} × ${it.qty} — ${money(it.unit * it.qty)}`),
    `Tiền hàng: ${money(sub)}`,
    shipFee != null ? `Phí giao: ${shipFee === 0 ? 'MIỄN PHÍ' : money(shipFee)}` : 'Phí giao: shop báo lại khi xác nhận',
    shipFee != null ? `TỔNG: ${money(sub + shipFee)}` : '',
    '',
    `Người nhận: ${state.customer?.name ?? ''} · ${state.customer?.phone ?? ''}`,
    `Giao tới: ${state.customer?.address_line ?? ''}`,
  ].filter(Boolean).join('\n');
  return [text(body, confirmReplies(state))];
}

/** Thiếu gì hỏi nấy — thứ tự cố định, và BỎ QUA thứ đã biết (đó là chỗ tiết kiệm thao tác). */
function askNext(state) {
  const c = state.customer ?? {};
  if (!c.phone) {
    return {
      state: { ...state, step: 'ask_phone' },
      messages: [text('Cho shop xin số điện thoại để giao hàng nhé:', [
        // content_type user_phone_number: Messenger hiện SỐ CÓ SẴN của khách thành nút bấm.
        // Khách không có số trên hồ sơ thì nút không hiện — vẫn gõ tay được, không kẹt.
        { contentType: 'user_phone_number' }, QR_HUMAN,
      ])],
    };
  }
  if (!c.address_line) {
    return { state: { ...state, step: 'ask_address' }, messages: [text('Địa chỉ nhận hàng của bạn? (số nhà, đường, phường/xã, tỉnh/thành)', [QR_HUMAN])] };
  }
  // KHÔNG tự dựng tóm tắt ở đây: nó cần phí ship THẬT, mà số đó phải hỏi hệ thống. Phát
  // hiệu ứng để nơi gọi hỏi rồi gọi summaryMessages() — giữ flow.js sạch I/O.
  return { state: { ...state, step: 'confirm' }, messages: [], effect: { type: 'summary' } };
}

/**
 * Bước một sự kiện.
 *
 * @param {object} state    trạng thái đã lưu (rỗng = hội thoại mới)
 * @param {object} ev       {type:'postback'|'text'|'quick_reply', payload?, text?, ref?}
 * @param {object} data     {catalog?, product?, profile?, lastCustomer?, shipFee?}
 * @returns {{state:object, messages:Array, effect?:object}}
 */
export function step(state, ev, data = {}) {
  const s = { cart: [], ...state };

  // "Gặp nhân viên" thắng MỌI bước, kể cả giữa lúc đang chốt đơn.
  if (ev.payload === 'HUMAN') {
    return {
      state: { ...s, step: 'handoff' },
      messages: [text('Mình chuyển cho nhân viên nhé, bạn đợi chút ạ 🙏')],
      effect: { type: 'handoff' },
    };
  }
  if (ev.payload === 'CANCEL') {
    return { state: { cart: [], step: 'start', customer: s.customer }, messages: [text('Đã huỷ. Bạn cần xem gì thêm không ạ?', [qr('🛍 Xem sản phẩm', 'BROWSE'), QR_HUMAN])] };
  }

  // ── Vào hội thoại ─────────────────────────────────────────────────────────
  // ref từ quảng cáo (m.me/trang?ref=sp_<id>) → BỎ QUA mọi bước duyệt.
  const refProduct = /^sp_([0-9a-f-]{36})$/.exec(ev.ref ?? '')?.[1];
  if (refProduct) return step(s, { type: 'postback', payload: `PICK:${refProduct}` }, data);

  if (!s.step || ev.payload === 'BROWSE' || (ev.type === 'text' && !s.step)) {
    const cat = data.catalog ?? { categories: [], products: [] };
    const greet = s.cart.length ? 'Bạn chọn thêm món nào ạ?' : `Chào ${data.profile?.first_name ?? 'bạn'} 👋 Shop có thể giúp gì ạ?`;
    // Ít hàng thì hiện thẳng sản phẩm — bắt duyệt danh mục khi chỉ có 5 món là thừa một chạm.
    if (cat.products.length && (cat.products.length <= MAX_DIRECT || !cat.categories.length)) {
      return { state: { ...s, step: 'browse' }, messages: [text(greet), productCards(cat.products), text('Chọn món bạn thích nhé 👆', [QR_HUMAN])] };
    }
    if (cat.categories.length) {
      return { state: { ...s, step: 'browse' }, messages: [text(`${greet}\nBạn muốn xem loại nào?`, categoryReplies(cat.categories))] };
    }
    return { state: { ...s, step: 'browse' }, messages: [text('Shop chưa có sản phẩm nào đang bán. Bạn nhắn lại sau nhé!')] };
  }

  // ── Chọn danh mục ─────────────────────────────────────────────────────────
  if (ev.payload?.startsWith('CAT:')) {
    const cat = data.catalog ?? { products: [] };
    if (!cat.products.length) return { state: s, messages: [text('Loại này tạm hết hàng. Bạn xem loại khác nhé!', [qr('🛍 Xem loại khác', 'BROWSE'), QR_HUMAN])] };
    return { state: { ...s, step: 'browse' }, messages: [productCards(cat.products), text('Chọn món bạn thích nhé 👆', [QR_HUMAN])] };
  }

  // ── Chọn sản phẩm ─────────────────────────────────────────────────────────
  if (ev.payload?.startsWith('PICK:')) {
    const p = data.product;
    if (!p) return { state: s, messages: [text('Món này vừa hết hoặc ngừng bán rồi ạ.', [qr('🛍 Xem món khác', 'BROWSE'), QR_HUMAN])] };
    const inStock = p.variants.filter((v) => v.available > 0);
    if (!inStock.length) return { state: s, messages: [text(`"${p.title}" đang hết hàng ạ.`, [qr('🛍 Xem món khác', 'BROWSE'), QR_HUMAN])] };
    // MỘT lựa chọn → vào thẳng, không hỏi. Đây là chỗ cắt được một chạm cho phần lớn shop.
    if (inStock.length === 1) return step(s, { type: 'quick_reply', payload: `VAR:${inStock[0].id}` }, { ...data, product: p });
    return {
      state: { ...s, step: 'pick_variant', pickProduct: p.id },
      messages: [text(`"${p.title}" — bạn chọn loại nào ạ?`, [
        ...inStock.slice(0, MAX_QR - 1).map((v) => qr(`${v.title ?? 'Mặc định'} ${money(v.price_vnd)}`, `VAR:${v.id}`)),
        QR_HUMAN,
      ])],
    };
  }

  // ── Chọn biến thể → vào giỏ, rồi hỏi ngay thứ còn thiếu ───────────────────
  if (ev.payload?.startsWith('VAR:')) {
    const vid = ev.payload.slice(4);
    const p = data.product;
    const v = p?.variants.find((x) => x.id === vid);
    if (!v || v.available <= 0) return { state: s, messages: [text('Loại này vừa hết ạ.', [qr('🛍 Xem món khác', 'BROWSE'), QR_HUMAN])] };
    const title = v.title ? `${p.title} - ${v.title}` : p.title;
    const cart = [...s.cart];
    const found = cart.find((it) => it.variant_id === vid);
    // Bấm lại đúng món = tăng số lượng. Khách hay bấm hai lần vì tưởng máy chưa nhận.
    if (found) found.qty = Math.min(found.qty + 1, v.available);
    // product_id lưu theo dòng hàng để nút +/− sau này TRA LẠI ĐƯỢC tồn kho. Không có nó
    // thì tăng số lượng phải đoán mò, và khách chỉ biết mình vượt tồn ở bước cuối cùng.
    else cart.push({ variant_id: vid, product_id: p.id, title, unit: v.price_vnd, qty: 1 });
    const next = { ...s, cart, step: 'in_cart' };
    // Tên lấy từ hồ sơ Messenger; SĐT/địa chỉ lấy lại từ lần mua trước nếu có.
    // `||` chứ KHÔNG `??`: hồ sơ thiếu tên thì join ra CHUỖI RỖNG, mà '' không phải null nên
    // `??` giữ nguyên rỗng và đơn chết ở bước cuối với "thiếu tên khách" — đúng lỗi đã vấp.
    // Khách khoá hồ sơ (quyền riêng tư của họ) là chuyện bình thường, không được vì thế mà
    // mất đơn: rơi về nhãn chung, shop vẫn có SĐT + link về đoạn chat để gọi lại.
    const fromProfile = [data.profile?.first_name, data.profile?.last_name].filter(Boolean).join(' ');
    next.customer = {
      name: s.customer?.name || data.lastCustomer?.name || fromProfile || 'Khách Facebook',
      phone: s.customer?.phone || data.lastCustomer?.phone || '',
      address_line: s.customer?.address_line || data.lastCustomer?.address_line || '',
      province: s.customer?.province || data.lastCustomer?.province || '',
    };
    const added = text(`Đã thêm: ${title} × ${found ? found.qty : 1} — ${money(v.price_vnd)}`);
    const ask = askNext(next);
    return { state: ask.state, messages: [added, ...ask.messages] };
  }

  // ── Sửa số lượng ở màn tóm tắt ────────────────────────────────────────────
  if (ev.payload === 'EDITQTY') {
    if (!s.cart.length) return askNext(s);
    return {
      state: { ...s, step: 'edit_qty' },
      messages: [text('Bạn muốn đổi số lượng món nào ạ?', [
        ...s.cart.slice(0, MAX_QR - 2).map((it) => qr(`${it.title} (${it.qty})`, `QTYP:${it.variant_id}`)),
        qr('↩ Quay lại', 'SUMMARY'), QR_HUMAN,
      ])],
    };
  }
  if (ev.payload === 'SUMMARY') return askNext(s);
  if (ev.payload?.startsWith('QTYP:') || ev.payload?.startsWith('QTYM:')) {
    const up = ev.payload.startsWith('QTYP:');
    const vid = ev.payload.slice(5);
    const cart = s.cart.map((it) => ({ ...it }));
    const it = cart.find((x) => x.variant_id === vid);
    if (!it) return askNext(s);
    if (up) {
      // Trần là TỒN THẬT vừa hỏi lại, không phải con số bot nhớ từ lúc khách chọn.
      const avail = data.product?.variants?.find((v) => v.id === vid)?.available;
      if (avail != null && it.qty + 1 > avail) {
        const back = askNext({ ...s, cart });
        return { ...back, messages: [text(`Món "${it.title}" chỉ còn ${avail} cái ạ.`), ...back.messages] };
      }
      it.qty += 1;
    } else {
      it.qty -= 1;
      // Bớt về 0 = bỏ món. Không bắt khách tìm nút "xoá" riêng cho một việc hiển nhiên.
      if (it.qty <= 0) {
        const rest = cart.filter((x) => x.variant_id !== vid);
        if (!rest.length) {
          return { state: { ...s, cart: [], step: 'start' }, messages: [text('Giỏ trống rồi ạ. Bạn xem thêm món nào nhé?', [qr('🛍 Xem sản phẩm', 'BROWSE'), QR_HUMAN])] };
        }
        return askNext({ ...s, cart: rest });
      }
    }
    return askNext({ ...s, cart });
  }

  // ── Trả lời câu hỏi ───────────────────────────────────────────────────────
  if (s.step === 'ask_phone') {
    const raw = String(ev.text ?? '').trim();
    const digits = raw.replace(/[^\d+]/g, '');
    if (digits.replace(/\D/g, '').length < 8) {
      return { state: s, messages: [text('Số điện thoại chưa đúng ạ, bạn nhập lại giúp shop nhé (vd 0912345678):', [{ contentType: 'user_phone_number' }, QR_HUMAN])] };
    }
    const next = { ...s, customer: { ...s.customer, phone: digits } };
    return askNext(next);
  }
  if (s.step === 'ask_address') {
    const addr = String(ev.text ?? '').trim();
    if (addr.length < 8) return { state: s, messages: [text('Địa chỉ hơi ngắn, bạn ghi rõ số nhà + đường + phường/xã + tỉnh/thành giúp shop nhé:', [QR_HUMAN])] };
    const next = { ...s, customer: { ...s.customer, address_line: addr.slice(0, 300) } };
    return askNext(next);
  }

  // ── Xác nhận đặt ──────────────────────────────────────────────────────────
  if (ev.payload === 'PLACE') {
    if (!s.cart.length) return { state: { ...s, step: 'start' }, messages: [text('Giỏ đang trống ạ.', [qr('🛍 Xem sản phẩm', 'BROWSE'), QR_HUMAN])] };
    if (!s.customer?.phone || !s.customer?.address_line) return askNext(s);
    return { state: { ...s, step: 'placing' }, messages: [], effect: { type: 'place_order', cart: s.cart, customer: s.customer } };
  }

  // ── Không hiểu → không đoán bừa, đưa nút ──────────────────────────────────
  // Cố đoán ý khách bằng từ khoá là cách âm thầm đặt nhầm hàng. Bot này KHÔNG đoán.
  return {
    state: s,
    messages: [text('Shop chưa hiểu ý bạn 😅 Bạn chọn giúp shop nhé:', [qr('🛍 Xem sản phẩm', 'BROWSE'), QR_HUMAN])],
  };
}

/** Tin nhắn sau khi đơn đã tạo THÀNH CÔNG — có mã đơn để khách tra cứu. */
export function orderPlacedMessages(order, lookupUrl) {
  return [
    text(`✅ Đặt hàng thành công!\nMã đơn: #${order.order_number}\nTổng tiền: ${money(order.total_vnd)}\nShop sẽ liên hệ xác nhận sớm nhất ạ. Cảm ơn bạn! 🎉`),
    ...(lookupUrl ? [text(`Theo dõi đơn tại: ${lookupUrl}`)] : []),
  ];
}

/** Đơn KHÔNG tạo được — nói RÕ lý do (hết hàng…) chứ không "có lỗi xảy ra". */
export function orderFailedMessages(reason) {
  return [text(`Rất tiếc, shop chưa tạo được đơn: ${reason}`, [qr('🛍 Chọn lại', 'BROWSE'), QR_HUMAN])];
}
