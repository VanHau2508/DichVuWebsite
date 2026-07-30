/**
 * Sinh banner mặc định cho shop MỚI — SVG thuần, ZERO-DEP.
 *
 * Vì sao có gói này: preset ngành seed `hero.slides: []`, mà `hero_side` và
 * `promo_banners` chỉ render khi có slide hợp lệ. Hậu quả đo được: shop vừa
 * đăng ký xong hiện 3 khối thay vì 12 — "cùng một bố cục cho mọi ngành" chỉ
 * đúng trên giấy cho tới khi chủ shop tự tải ảnh lên. Nền tảng vẽ hộ bộ banner
 * đầu tiên theo đúng palette họ đã chọn; chủ shop thay lúc nào cũng được.
 *
 * Gói là ESM LÁ zero-import (chỉ dữ liệu + hàm thuần, trả về CHUỖI SVG) để mount
 * được vào image không có thư mục packages/ — cùng khuôn `net-guard/fetch-image.js`.
 * Bên gọi tự lo sharp + MinIO.
 */

// Nét vẽ tối giản trên viewBox 0 0 100 100.
export const SHAPES = {
  ao: 'M30 18 L18 28 L26 40 L30 35 L30 84 L70 84 L70 35 L74 40 L82 28 L70 18 L61 18 A11 8 0 0 1 39 18 Z',
  vay: 'M36 18 L30 32 L36 36 L26 84 L74 84 L64 36 L70 32 L64 18 L57 18 A8 6 0 0 1 43 18 Z',
  quan: 'M32 18 L68 18 L71 84 L56 84 L50 46 L44 84 L29 84 Z',
  khoac: 'M32 18 L16 30 L25 43 L28 38 L28 84 L47 84 L47 28 L53 28 L53 84 L72 84 L72 38 L75 43 L84 30 L68 18 Z',
  la: 'M50 14 C22 28 20 64 50 88 C80 64 78 28 50 14 Z M50 22 L50 84',
  thit: 'M26 42 C26 22 74 20 78 44 C82 66 62 84 44 81 C28 78 26 60 26 42 Z M44 46 A9 9 0 1 0 44 64 A9 9 0 1 0 44 46',
  qua: 'M50 26 A26 26 0 1 0 50 82 A26 26 0 1 0 50 26 M50 26 C50 18 56 12 66 12 C66 22 60 26 50 26',
  sofa: 'M14 48 C14 40 26 40 26 48 L26 42 L74 42 L74 48 C74 40 86 40 86 48 L86 70 L14 70 Z M22 70 L22 80 M78 70 L78 80 M26 42 L26 34 L74 34 L74 42',
  ban: 'M12 40 L88 40 L88 50 L12 50 Z M20 50 L20 82 M80 50 L80 82 M50 50 L50 66',
  giuong: 'M12 40 L12 76 L22 76 L22 68 L78 68 L78 76 L88 76 L88 52 L34 52 L34 40 Z',
  son: 'M40 36 L60 36 L60 82 L40 82 Z M42 36 L42 14 L58 20 L58 36 Z',
  serum: 'M42 30 L58 30 L58 42 C68 48 68 80 58 84 L42 84 C32 80 32 48 42 42 Z M44 14 L56 14 L56 30 L44 30 Z',
  tuyp: 'M36 26 L64 26 L60 84 L40 84 Z M42 14 L58 14 L58 26 L42 26 Z M40 40 L60 40',
  tui: 'M24 38 L76 38 L80 84 L20 84 Z M38 38 C38 22 62 22 62 38',
};

// Kích thước theo đúng chỗ dùng trong theme.js: hero là carousel ô lớn, side là
// 2 ô cột phải, promo là hàng 3 ô. Tỉ lệ chỉ cần "hợp lý" — cả ba chỗ đều
// blur-fill hoặc object-fit nên ảnh lệch tỉ lệ vẫn không vỡ.
const SIZE = { hero: [1680, 640], side: [820, 304], promo: [800, 500] };

/**
 * Chữ mặc định: CỐ Ý trung tính. Đây là banner sẽ chạy trên cửa hàng THẬT của
 * người khác — không hứa hộ họ "giao trong 2 giờ" hay "chính hãng 100%".
 */
const COPY = {
  fashion: {
    hero: [['Bộ sưu tập mới', 'Khám phá những mẫu vừa lên kệ', 'khoac'],
           ['Hàng mới về', 'Cập nhật mẫu mới thường xuyên', 'vay'],
           ['Ưu đãi đang có', 'Xem các sản phẩm đang giảm giá', 'ao']],
    side: [['Hàng mới về', 'ao'], ['Đang giảm giá', 'quan']],
    promo: [['Sản phẩm nổi bật', 'khoac'], ['Bán chạy', 'vay'], ['Ưu đãi', 'quan']],
  },
  food: {
    hero: [['Thực phẩm cho bữa cơm nhà', 'Chọn nguyên liệu bạn cần', 'la'],
           ['Hàng mới về', 'Cập nhật mỗi ngày', 'qua'],
           ['Ưu đãi đang có', 'Xem các sản phẩm đang giảm giá', 'thit']],
    side: [['Hàng mới về', 'qua'], ['Đang giảm giá', 'thit']],
    promo: [['Sản phẩm nổi bật', 'la'], ['Bán chạy', 'thit'], ['Ưu đãi', 'qua']],
  },
  furniture: {
    hero: [['Không gian sống của bạn', 'Khám phá bộ sưu tập nội thất', 'sofa'],
           ['Hàng mới về', 'Những mẫu vừa lên kệ', 'ban'],
           ['Ưu đãi đang có', 'Xem các sản phẩm đang giảm giá', 'giuong']],
    side: [['Hàng mới về', 'ban'], ['Đang giảm giá', 'sofa']],
    promo: [['Phòng khách', 'sofa'], ['Phòng ngủ', 'giuong'], ['Bàn & kệ', 'ban']],
  },
  cosmetics: {
    hero: [['Chăm sóc mỗi ngày', 'Khám phá sản phẩm vừa lên kệ', 'son'],
           ['Hàng mới về', 'Cập nhật mẫu mới thường xuyên', 'serum'],
           ['Ưu đãi đang có', 'Xem các sản phẩm đang giảm giá', 'tuyp']],
    side: [['Hàng mới về', 'serum'], ['Đang giảm giá', 'son']],
    promo: [['Trang điểm', 'son'], ['Chăm sóc da', 'serum'], ['Ưu đãi', 'tuyp']],
  },
  // Không chọn ngành (industry NULL) vẫn phải có banner — dùng hình túi mua sắm.
  default: {
    hero: [['Chào mừng bạn ghé thăm', 'Khám phá sản phẩm của cửa hàng', 'tui'],
           ['Hàng mới về', 'Những sản phẩm vừa lên kệ', 'tui'],
           ['Ưu đãi đang có', 'Xem các sản phẩm đang giảm giá', 'tui']],
    side: [['Hàng mới về', 'tui'], ['Đang giảm giá', 'tui']],
    promo: [['Sản phẩm nổi bật', 'tui'], ['Bán chạy', 'tui'], ['Ưu đãi', 'tui']],
  },
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const pick = (v, fallback) => (typeof v === 'string' && HEX.test(v) ? v : fallback);

/** Độ sáng cảm nhận (sRGB tuyến tính hoá xấp xỉ) — chọn nét trắng hay nét tối. */
function isLight(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45;
}

/** Bảng màu banner rút từ tokens của chính shop → banner luôn khớp giao diện họ đang dùng. */
export function paletteFromTokens(tokens) {
  const t = tokens && typeof tokens === 'object' ? tokens : {};
  const accent = pick(t['color.accent'], '#4a5568');
  return {
    bg1: pick(t['color.bg'], '#ffffff'),
    bg2: pick(t['color.hero-bg'], pick(t['color.surface'], '#f2f2f5')),
    accent,
    // Nét nằm TRÊN khối accent, nên tương phản tính với accent chứ không với nền.
    ink: isLight(accent) ? pick(t['color.text'], '#17171a') : '#ffffff',
  };
}

/**
 * Một banner. Bố cục cố ý lệch: nửa trái để trống vì theme.js phủ
 * headline/sub/CTA bằng HTML lên trên (.hbanner-overlay) — KHÔNG vẽ chữ vào ảnh
 * (vừa đúp chữ, vừa ra ô vuông tofu ở image không cài fontconfig).
 */
export function bannerSvg({ w, h, bg1, bg2, accent, ink, shape }) {
  const d = SHAPES[shape] ?? SHAPES.tui;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/>
    </linearGradient>
    <linearGradient id="a" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${accent}" stop-opacity=".95"/>
      <stop offset="1" stop-color="${accent}" stop-opacity=".55"/>
    </linearGradient>
    <clipPath id="c"><rect width="${w}" height="${h}"/></clipPath>
  </defs>
  <g clip-path="url(#c)">
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    <circle cx="${w * 0.82}" cy="${h * 0.5}" r="${h * 0.62}" fill="url(#a)"/>
    <circle cx="${w * 0.97}" cy="${h * 0.08}" r="${h * 0.34}" fill="${accent}" opacity=".28"/>
    <circle cx="${w * 0.66}" cy="${h * 1.02}" r="${h * 0.3}" fill="${accent}" opacity=".2"/>
    <g transform="translate(${w * 0.82 - h * 0.45} ${h * 0.5 - h * 0.45}) scale(${h * 0.009})">
      <path d="${d}" fill="none" stroke="${ink}" stroke-width="2"
            stroke-linejoin="round" stroke-linecap="round" opacity=".9"/>
    </g>
  </g>
</svg>`;
}

/**
 * Kế hoạch trọn bộ banner cho một shop: 3 hero + 2 side + 3 promo.
 * Trả về mảng { slot, w, h, svg, headline, sub } — bên gọi rasterise và ghép key.
 */
export function bannerPlan(industry, tokens) {
  const c = COPY[industry] ?? COPY.default;
  const pal = paletteFromTokens(tokens);
  const out = [];
  // `shape` đi kèm kết quả để test đối chiếu được tên hình YÊU CẦU với hình VẼ RA.
  // Thiếu nó thì tên sai chỉ âm thầm rơi về hình mặc định, không cách nào bắt.
  for (const [headline, sub, shape] of c.hero) {
    const [w, h] = SIZE.hero;
    out.push({ slot: 'hero', w, h, headline, sub, shape, svg: bannerSvg({ w, h, ...pal, shape }) });
  }
  for (const [headline, shape] of c.side) {
    const [w, h] = SIZE.side;
    out.push({ slot: 'side', w, h, headline, sub: '', shape, svg: bannerSvg({ w, h, ...pal, shape }) });
  }
  for (const [headline, shape] of c.promo) {
    const [w, h] = SIZE.promo;
    out.push({ slot: 'promo', w, h, headline, sub: '', shape, svg: bannerSvg({ w, h, ...pal, shape }) });
  }
  return out;
}
