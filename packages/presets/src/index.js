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
 *   - layout dùng ĐÚNG 8 section registry: header, hero, features, collections,
 *     product_grid, blog, story, footer (theme.js:250). header đầu, footer cuối, hero gần đầu.
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
      { section: 'product_grid', props: { title: 'Hàng mới về', columns: 4 } },
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
      { section: 'product_grid', props: { title: 'Ưu đãi hôm nay', columns: 4 } },
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

  // ── Nội thất — trung tính ấm (rêu + nâu gỗ + kem), tạp chí, khoảng cách rộng ──
  furniture: {
    name: 'Nội thất',
    description: 'Tạp chí trung tính ấm: xanh rêu + nâu gỗ trên nền kem, khoảng cách rộng, nhấn thủ công.',
    tokens: {
      'color.primary': '#4a5a43',
      'color.primary-dark': '#374233',
      'color.accent': '#a06a43',
      'color.bg': '#faf7f2',
      'color.surface': '#f0ebe1',
      'color.hero-bg': '#e7ddcd',
      'color.text': '#2b2620',
      'color.muted': '#756b5c',
      'color.border': '#ddd3c4',
      radius: '8px',
      spacing: '20px',
    },
    layout: [
      { section: 'header', props: {
        topbar_text: 'Miễn phí giao lắp nội thành · Bảo hành khung gỗ 5 năm',
        menu_show_featured: true, menu_show_new: true, menu_show_sale: false,
        nav_links: [
          { label: 'Phòng khách', url: '/products' },
          { label: 'Phòng ngủ', url: '/products' },
          { label: 'Bàn ăn', url: '/products' },
        ],
      } },
      { section: 'hero', props: {
        eyebrow: 'Nội thất gỗ tự nhiên · Thủ công Việt',
        title: 'Không gian sống an nhiên',
        subtitle: 'Từng đường vân gỗ được tuyển chọn và hoàn thiện thủ công, mang hơi ấm bền bỉ vào ngôi nhà của bạn.',
        slides: [],
      } },
      { section: 'collections', props: { title: 'Không gian theo phòng', variant: 'cards' } },
      { section: 'product_grid', props: { title: 'Sản phẩm nổi bật', columns: 3 } },
      { section: 'story', props: {
        title: 'Chuyện của xưởng mộc',
        body: 'Chúng tôi bắt đầu từ một xưởng nhỏ với niềm tin rằng đồ nội thất tốt phải bền theo thời gian. Mỗi sản phẩm là sự kết hợp giữa gỗ tự nhiên tuyển chọn và bàn tay người thợ — mộc mạc mà tinh tế, đồng hành cùng gia đình bạn qua nhiều thế hệ.',
        cta_text: 'Tìm hiểu về xưởng',
      } },
      { section: 'features', props: { items: [
        { title: 'Gỗ tự nhiên tuyển chọn', desc: 'Nguồn gỗ đạt chuẩn, vân đẹp, được xử lý chống mối mọt và cong vênh.' },
        { title: 'Thợ mộc lành nghề', desc: 'Mỗi món đồ được ghép mộng và chà nhám tỉ mỉ bằng đôi tay nghệ nhân.' },
        { title: 'Giao lắp tận nơi', desc: 'Đội ngũ vận chuyển và lắp đặt chuyên nghiệp, gọn gàng ngay tại nhà bạn.' },
        { title: 'Bảo hành dài lâu', desc: 'Khung gỗ bảo hành 5 năm, đồng hành cùng tổ ấm qua năm tháng.' },
      ] } },
      { section: 'blog', props: {} },
      { section: 'footer', props: {} },
    ],
  },

  // ── Mỹ phẩm — pastel rose-mauve + nude, sạch mềm cao cấp, bo mềm ──
  cosmetics: {
    name: 'Mỹ phẩm',
    description: 'Pastel rose-mauve + nude, sạch mềm cao cấp, bo góc mềm, nhấn thành phần lành tính & an tâm.',
    tokens: {
      'color.primary': '#99425a',
      'color.primary-dark': '#7d3149',
      'color.accent': '#c58f6a',
      'color.bg': '#fffdfb',
      'color.surface': '#fbf0ee',
      'color.hero-bg': '#f8e5e4',
      'color.text': '#2b1b21',
      'color.muted': '#8a6f76',
      'color.border': '#f0dcd9',
      radius: '14px',
      spacing: '18px',
    },
    layout: [
      { section: 'header', props: {
        topbar_text: 'Miễn phí giao hàng cho đơn từ 500K · Tư vấn loại da miễn phí với chuyên viên',
        menu_show_featured: true, menu_show_new: true, menu_show_sale: true,
        nav_links: [
          { label: 'Chăm sóc da', url: '/products' },
          { label: 'Trang điểm', url: '/products' },
          { label: 'Bộ quà tặng', url: '/products' },
        ],
      } },
      { section: 'hero', props: {
        eyebrow: 'Chuẩn da liễu · Thành phần lành tính',
        title: 'Vẻ đẹp tự nhiên bắt đầu từ làn da khỏe',
        subtitle: 'Mỹ phẩm chính hãng, bảng thành phần minh bạch — nâng niu làn da bạn mỗi ngày, dịu nhẹ và an toàn.',
        slides: [],
      } },
      { section: 'features', props: { items: [
        { title: '100% chính hãng', desc: 'Cam kết hàng thật, đầy đủ tem phụ và nguồn gốc rõ ràng.' },
        { title: 'Thành phần lành tính', desc: 'Bảng thành phần minh bạch, không cồn khô, không paraben.' },
        { title: 'Tư vấn theo loại da', desc: 'Chuyên viên gợi ý sản phẩm hợp da khô, da dầu hay da nhạy cảm.' },
        { title: 'Đổi trả trong 7 ngày', desc: 'Hoàn tiền dễ dàng nếu sản phẩm chưa mở niêm phong.' },
      ] } },
      { section: 'product_spotlight', props: {
        eyebrow: 'Ngôi sao sản phẩm',
        blurb: 'Sản phẩm được yêu thích nhất — công thức dịu nhẹ, bảng thành phần minh bạch, phù hợp làn da người Việt và được chuyên viên khuyên dùng.',
      } },
      { section: 'product_grid', props: { title: 'Bán chạy được yêu thích', columns: 3 } },
      { section: 'collections', props: { title: 'Danh mục làm đẹp' } },
      { section: 'story', props: {
        title: 'Nâng niu làn da người Việt',
        body: 'Chúng tôi tuyển chọn từng sản phẩm với tiêu chí an toàn và hiệu quả thật — ưu tiên công thức dịu nhẹ, phù hợp khí hậu và làn da người Việt. Mỗi sản phẩm đều được cân nhắc kỹ để chăm sóc da bền vững, thay vì chạy theo lời hứa hào nhoáng.',
        cta_text: 'Tìm hiểu thương hiệu',
      } },
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
