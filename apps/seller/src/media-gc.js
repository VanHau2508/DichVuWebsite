/**
 * Quy tắc "object ảnh nào ĐƯỢC PHÉP xoá" — tách riêng, không phụ thuộc gì.
 *
 * Vì sao tách: đây là phần duy nhất trong đường dọn rác có thể XOÁ NHẦM ảnh đang hiển
 * thị của người bán. Nằm lẫn trong media.js thì chỉ kiểm được qua e2e, mà e2e không
 * dựng nổi các ca biên (ảnh vừa tải 5 phút trước, ảnh sản phẩm không tiền tố, key của
 * shop khác lọt vào danh sách). Module thuần 0 phụ thuộc thì unit test chạy trên máy,
 * dựng được mọi ca biên, và chạy trong mọi cổng.
 *
 * Nằm TRONG apps/seller/src chứ không phải packages/: build context của service này là
 * `apps/seller` nên `packages/` KHÔNG có trong image — import ra ngoài đó sẽ chết lúc
 * CHẠY chứ không phải lúc build (obs.js và secretbox.js đã phải chép tay vì đúng lý do
 * này). Đặt cạnh nhau thì unit test kiểm ĐÚNG file mà service nạp.
 *
 * BA điều kiện phải ĐỒNG THỜI đúng thì mới xoá:
 *   1. Key có tiền tố TRƯNG BÀY (banner-/logo-/content-/cat-). Ảnh sản phẩm là
 *      `<shop>/<uuid>.webp` KHÔNG tiền tố — nó thuộc vòng đời của bảng `media`, đụng
 *      vào đây là phá một cơ chế khác.
 *   2. Key KHÔNG nằm trong tập tham chiếu.
 *   3. Object cũ hơn mốc ân hạn.
 *
 * Tập tham chiếu được lấy bằng cách quét REGEX trên text của mọi cột có thể chứa key,
 * không đi theo tên trường. Quét thừa thì chỉ giữ lại thừa; đi theo tên trường mà sót
 * một chỗ là xoá nhầm. Thiên vị phải nghiêng về GIỮ.
 */

const U36 = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Chỉ 4 tiền tố này mới thuộc diện dọn. */
export const DISPLAY_KEY_RE = new RegExp(`^${U36}/(?:banner|logo|content|cat)-${U36}\\.webp$`);

/** Mọi dạng key ảnh public, KỂ CẢ ảnh sản phẩm không tiền tố — dùng để quét tham chiếu. */
export const ANY_KEY_RE = new RegExp(`${U36}/(?:banner-|logo-|content-|cat-)?${U36}\\.webp`, 'g');

/** Rút mọi key ảnh xuất hiện trong một đoạn text bất kỳ (JSON, thân bài, cột phẳng). */
export function keysFromText(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(ANY_KEY_RE)) out.push(m[0]);
  return out;
}

/** Gộp nhiều đoạn text thành MỘT tập key đang được tham chiếu. */
export function referencedFrom(chunks) {
  const set = new Set();
  for (const t of chunks ?? []) for (const k of keysFromText(t)) set.add(k);
  return set;
}

/**
 * Lọc ra object ĐƯỢC PHÉP xoá, sắp theo dung lượng giảm dần (dọn cái to trước).
 * @param objects mảng {name, size, lastModified}
 * @param refs    Set key đang được tham chiếu
 * @param cutoffMs mốc thời gian: object mới hơn mốc này thì GIỮ (ân hạn)
 */
export function pickCollectable(objects, refs, cutoffMs) {
  const seen = refs instanceof Set ? refs : new Set(refs ?? []);
  return (objects ?? [])
    .filter((o) => o && typeof o.name === 'string')
    .filter((o) => DISPLAY_KEY_RE.test(o.name))
    .filter((o) => !seen.has(o.name))
    .filter((o) => {
      const t = new Date(o.lastModified).getTime();
      // Không đọc được thời gian → GIỮ. Không biết object bao nhiêu tuổi thì không xoá.
      return Number.isFinite(t) && t < cutoffMs;
    })
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
}
