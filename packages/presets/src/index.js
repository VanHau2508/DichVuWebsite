/**
 * Thư viện PRESET giao diện theo ngành — nguồn DUY NHẤT dùng chung.
 *
 *   - seller-admin: nút "Đổi giao diện theo ngành" đọc preset rồi PUT qua service seller.
 *   - signup:       chọn ngành lúc đăng ký → seed 1 row `themes` từ preset (cùng tx provision).
 *
 * Mỗi preset = một bộ {tokens, layout} lưu sẵn — ĐÚNG hình dạng bảng `themes`
 * (tokens jsonb, layout jsonb). Engine render (apps/storefront/src/theme.js) đọc thẳng:
 * tokensToCss(tokens) → CSS :root; layout [{section,props}] → map qua registry SECTIONS.
 *
 * HỢP ĐỒNG BẮT BUỘC (nếu vi phạm, storefront âm thầm rớt về mặc định MAISON — có test chặn):
 *   - tokens CHỈ chứa 11 khoá: 9 màu (color.*) + radius + spacing. Màu khớp /^#hex 3-8/,
 *     radius/spacing khớp /^\d{1,4}(px|rem|em|%)$/  (theme.js:41-43).
 *   - TUYỆT ĐỐI KHÔNG font.* — nền tảng chỉ tự-host 'Be Vietnam Pro', CSP chặn font ngoài.
 *   - layout dùng section trong registry (theme.js:250): header, hero, features, collections,
 *     product_grid, product_spotlight, category_bar, category_rows, flash_sale, blog, story,
 *     footer. header đầu, footer cuối, hero gần đầu.
 *   - hero.props.slides = [] RỖNG: banner do CHỦ SHOP tự upload (áp preset giữ nguyên ảnh cũ).
 *   - nav_links ≤ 6, url nội bộ '/...'. Ở đây trỏ /products* (luôn resolve, không 404);
 *     chủ shop tự trỏ lại danh mục thật /c/<slug> sau. sort lạ tự về 'new' nên không gãy.
 *
 * Đây là MODULE LÁ: chỉ dữ liệu + hàm thuần, ZERO import (không kéo theme.js vào 3 service).
 */

export const PRESETS = {
  // ── Thời trang — editorial, đơn sắc ink lạnh + nhấn crimson, cạnh sắc, lookbook ──
  fashion: {
    name: 'Thời trang',
    description: 'Editorial tối giản, tương phản cao, một nhấn đỏ crimson, lưới sản phẩm dày kiểu lookbook.',
    tokens: {
      'color.primary': '#17171a',
      'color.primary-dark': '#000000',
      'color.accent': '#cf1b3b',
      'color.bg': '#ffffff',
      'color.surface': '#f4f4f6',
      'color.hero-bg': '#ededf1',
      'color.text': '#17171a',
      'color.muted': '#6b6b73',
      'color.border': '#e3e3e8',
      radius: '2px',
      spacing: '18px',
    },
    layout: [
      { section: 'header', props: {
        topbar_text: 'Miễn phí giao hàng cho đơn từ 500.000₫ · Đổi trả linh hoạt trong 30 ngày',
        menu_show_featured: false, menu_show_new: true, menu_show_sale: true,
        nav_links: [
          { label: 'Hàng nữ', url: '/products' },
          { label: 'Hàng nam', url: '/products' },
          { label: 'Phụ kiện', url: '/products' },
        ],
      } },
      { section: 'hero', props: {
        eyebrow: 'Bộ sưu tập Thu Đông 2026',
        title: 'Phong cách định hình dấu ấn riêng',
        subtitle: 'Thiết kế chọn lọc, chất liệu cao cấp và những đường cắt tôn dáng — dành cho người mặc muốn nói lên cá tính mà không cần phô trương.',
        slides: [],
      } },
      { section: 'product_grid', props: { title: 'Hàng mới về', columns: 4, limit: 8 } },
      { section: 'collections', props: { title: 'Khám phá bộ sưu tập' } },
      { section: 'story', props: {
        title: 'Thời trang là ngôn ngữ của sự tự tin',
        body: 'Chúng tôi tin mỗi bộ trang phục là một tuyên ngôn. Từ khâu chọn vải đến từng đường kim mũi chỉ, mọi thiết kế đều hướng tới sự tối giản tinh tế — bền đẹp theo thời gian thay vì chạy theo mùa vụ. Đó là cách chúng tôi đồng hành cùng phong cách của bạn, mỗi ngày.',
        cta_text: 'Tìm hiểu thêm',
      } },
      { section: 'features', props: { items: [
        { title: 'Đổi trả 30 ngày', desc: 'Không vừa ý về dáng hay size? Đổi trả linh hoạt trong 30 ngày, thủ tục nhanh gọn.' },
        { title: 'Giao hàng toàn quốc', desc: 'Giao nhanh 2–4 ngày, đóng gói chỉn chu, hỗ trợ kiểm tra hàng trước khi thanh toán.' },
        { title: 'Chuẩn form dáng đẹp', desc: 'Vải được tuyển chọn kỹ, may đo tỉ mỉ, giữ form và lên dáng đẹp qua từng lần mặc.' },
        { title: 'Tư vấn phối đồ', desc: 'Đội ngũ stylist gợi ý chọn size và cách mix đồ hợp dáng, hợp dịp cho riêng bạn.' },
      ] } },
      { section: 'blog', props: {} },
      { section: 'footer', props: {} },
    ],
  },

  // ── Thực phẩm – Đồ uống — tươi, ấm, xanh lá + cam đất, nền kem, bo tròn ──
  food: {
    name: 'Thực phẩm – Đồ uống',
    description: 'Siêu thị kiểu MM Mega Market: xanh dương thương hiệu + đỏ ưu đãi, thanh danh mục, lưới ưu đãi, và các hàng sản phẩm TỰ LƯỚT theo danh mục.',
    tokens: {
      'color.primary': '#0272ba',
      'color.primary-dark': '#005b96',
      'color.accent': '#e82230',
      'color.bg': '#ffffff',
      'color.surface': '#f3f4f6',
      'color.hero-bg': '#f1f9ff',
      'color.text': '#2a2f33',
      'color.muted': '#7a7e80',
      'color.border': '#e5e7eb',
      radius: '8px',
      spacing: '16px',
    },
    layout: [
      { section: 'header', props: {
        topbar_text: 'Freeship đơn từ 300K nội thành · Giao nhanh 2 giờ · Cam kết tươi mỗi ngày',
        menu_show_featured: true, menu_show_new: true, menu_show_sale: true,
        nav_links: [
          { label: 'Rau củ quả', url: '/products' },
          { label: 'Đồ uống', url: '/products?sort=new' },
          { label: 'Combo tiết kiệm', url: '/products?sort=price_asc' },
        ],
      } },
      { section: 'hero', props: {
        eyebrow: 'Tươi ngon mỗi ngày',
        title: 'Thực phẩm sạch, chọn kỹ từ nông trại',
        subtitle: 'Rau củ, trái cây và đặc sản chọn lọc — giao tận nơi trong ngày, giữ trọn độ tươi cho bữa cơm nhà bạn.',
        slides: [],
      } },
      { section: 'category_bar', props: {} },
      { section: 'product_grid', props: { title: 'Ưu đãi hôm nay', columns: 4, limit: 8 } },
      { section: 'category_rows', props: {} },
      { section: 'features', props: { items: [
        { title: 'Tươi mỗi ngày', desc: 'Nhập hàng từ sáng sớm, chọn lọc kỹ, không để tồn quá 24 giờ.' },
        { title: 'Giao nhanh 2 giờ', desc: 'Đặt trước 15h, nhận ngay trong ngày nội thành, giữ lạnh suốt hành trình.' },
        { title: 'Nguồn gốc rõ ràng', desc: 'Truy xuất tận vườn, đạt chuẩn an toàn thực phẩm VietGAP.' },
        { title: 'Đổi trả trong 24h', desc: 'Không hài lòng về độ tươi? Hoàn tiền hoặc đổi mới, không hỏi lý do.' },
      ] } },
      { section: 'footer', props: {} },
    ],
  },

  // ── Nội thất — showroom kiểu Sofa Ngọc Việt: xanh slate + cam terracotta, GÓC VUÔNG (radius 0),
  //    nền trắng/xám nhạt, duyệt theo danh mục (thanh danh mục + khối SP từng loại). ──
  furniture: {
    name: 'Nội thất',
    description: 'Showroom nội thất kiểu Sofa Ngọc Việt: xanh slate + cam terracotta trên nền trắng/xám nhạt, GÓC VUÔNG chuyên nghiệp, thanh danh mục + các khối sản phẩm theo loại (sofa, giường, bàn ăn…).',
    tokens: {
      'color.primary': '#446084',
      'color.primary-dark': '#35506e',
      'color.accent': '#d26e4b',
      'color.bg': '#ffffff',
      'color.surface': '#f8f8f9',
      'color.hero-bg': '#eef1f6',
      'color.text': '#333333',
      'color.muted': '#777777',
      'color.border': '#dddddd',
      radius: '0px',
      spacing: '20px',
    },
    layout: [
      { section: 'header', props: {
        topbar_text: 'Miễn phí giao lắp nội thành · Bảo hành khung 5 năm · 2 showroom Hà Nội & TP.HCM',
        menu_show_featured: true, menu_show_new: true, menu_show_sale: true,
        nav_links: [
          { label: 'Sofa phòng khách', url: '/products' },
          { label: 'Giường ngủ', url: '/products?sort=new' },
          { label: 'Bàn ăn', url: '/products' },
        ],
      } },
      { section: 'hero', props: {
        eyebrow: 'Nội thất cao cấp · Bảo hành dài hạn',
        title: 'Kiến tạo không gian sống đẳng cấp',
        subtitle: 'Sofa, giường, bàn ăn thiết kế tinh tế — chất liệu cao cấp, bền đẹp theo thời gian, giao lắp tận nơi toàn quốc.',
        slides: [],
      } },
      { section: 'category_bar', props: {} },
      { section: 'product_grid', props: { title: 'Mẫu mới về', columns: 4, limit: 8 } },
      { section: 'category_rows', props: {} },
      { section: 'features', props: { items: [
        { title: 'Giao lắp tận nơi', desc: 'Kỹ thuật tư vấn, vận chuyển và lắp đặt tận nhà trên toàn quốc.' },
        { title: 'Chất lượng vượt trội', desc: 'Thiết kế bắt mắt, mẫu mã đa dạng, vật liệu cao cấp, độ bền vượt trội.' },
        { title: 'Bảo hành ấn tượng', desc: 'Chế độ bảo hành dài hạn, tận tâm, xử lý nhanh chóng và kịp thời.' },
        { title: 'Tư vấn tận tình', desc: 'Tư vấn viên chuyên nghiệp, hỗ trợ trực tiếp tại showroom hoặc qua hotline.' },
      ] } },
      { section: 'blog', props: {} },
      { section: 'footer', props: {} },
    ],
  },

  // ── Mỹ phẩm — hồng M.O.I: hồng thương hiệu ấm + hồng nóng ưu đãi, nền trắng/kem ấm, FLASH SALE ──
  cosmetics: {
    name: 'Mỹ phẩm',
    description: 'Beauty kiểu M.O.I: hồng thương hiệu tươi + hồng nóng ưu đãi trên nền trắng/kem ấm, FLASH SALE đếm ngược, lưới bán chạy 5 cột — nữ tính, hiện đại, hướng khuyến mãi.',
    tokens: {
      'color.primary': '#f36b7d',
      'color.primary-dark': '#e5697d',
      'color.accent': '#f84969',
      'color.bg': '#ffffff',
      'color.surface': '#fdf6f3',
      'color.hero-bg': '#fdeef1',
      'color.text': '#1f1a1c',
      'color.muted': '#777777',
      'color.border': '#f2dfe3',
      radius: '12px',
      spacing: '16px',
    },
    layout: [
      { section: 'header', props: {
        topbar_text: 'Miễn phí giao hàng cho đơn từ 500K · Tư vấn loại da miễn phí với chuyên viên',
        nav_style: 'band',
        menu_show_featured: true, menu_show_new: true, menu_show_sale: true,
        nav_links: [
          { label: 'Trang điểm', url: '/products' },
          { label: 'Chăm sóc da', url: '/products' },
          { label: 'Nước hoa', url: '/products' },
        ],
      } },
      { section: 'hero', props: {
        variant: 'split',
        eyebrow: 'Chính hãng · Thành phần lành tính',
        title: 'Tháng này chốt deal — nuông chiều phái đẹp',
        subtitle: 'Mỹ phẩm chính hãng, bảng thành phần minh bạch — ưu đãi mỗi ngày, nâng niu làn da bạn dịu nhẹ và an toàn.',
        slides: [],
      } },
      // Section DỮ-LIỆU (không tự render): giữ 2 banner PHỤ bên phải hero split. Storefront hero
      // split đọc slides ở đây; chủ shop upload qua form "Banner phụ hero" trong Giao diện.
      { section: 'hero_side', props: { slides: [] } },
      { section: 'flash_sale', props: { title: 'Flash sale' } },
      { section: 'promo_banners', props: { title: 'Ưu đãi nổi bật', slides: [] } },
      { section: 'product_grid', props: { title: 'Sản phẩm bán chạy', columns: 5 } },
      { section: 'collections', props: { title: 'Danh mục làm đẹp' } },
      { section: 'features', props: { items: [
        { title: '100% chính hãng', desc: 'Cam kết hàng thật, đầy đủ tem phụ và nguồn gốc rõ ràng.' },
        { title: 'Thành phần lành tính', desc: 'Bảng thành phần minh bạch, không cồn khô, không paraben.' },
        { title: 'Tư vấn theo loại da', desc: 'Chuyên viên gợi ý sản phẩm hợp da khô, da dầu hay da nhạy cảm.' },
        { title: 'Đổi trả trong 7 ngày', desc: 'Hoàn tiền dễ dàng nếu sản phẩm chưa mở niêm phong.' },
      ] } },
      { section: 'blog', props: {} },
      { section: 'footer', props: {} },
    ],
  },
};

/** Trả preset theo slug ngành, hoặc null nếu không có (slug lạ → gọi phía dùng tự bỏ qua). */
export const getPreset = (slug) => (typeof slug === 'string' && Object.hasOwn(PRESETS, slug)) ? PRESETS[slug] : null;

/** Danh sách slug ngành có preset. */
export const listPresets = () => Object.keys(PRESETS);

/** [{slug, name, description}] — dựng menu chọn ngành (signup form, seller-admin picker). */
export const presetChoices = () => Object.entries(PRESETS).map(([slug, p]) => ({ slug, name: p.name, description: p.description }));
