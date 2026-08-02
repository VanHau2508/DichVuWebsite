/**
 * Các trang CÔNG TY của nền tảng trên nentang.vn (ngoài trang chủ landing):
 *   /gioi-thieu  → Giới thiệu        /ho-tro     → Trung tâm hỗ trợ
 *   /dieu-khoan  → Điều khoản        /blog       → Blog công ty (danh sách)
 *   /blog/:slug  → Bài viết
 * Dùng khung chung site.js. SSR tĩnh, KHÔNG JS, hợp CSP. Sửa nội dung: các mảng/POSTS dưới đây.
 * (LƯU Ý pháp lý: nội dung Điều khoản là BẢN MẪU — hãy rà soát với luật sư và điền
 *  thông tin công ty thật (địa chỉ, MST) trước khi dùng chính thức.)
 */
import { esc, I, mailtoHref, sitePage } from './site.js';

const COMPANY_CSS = `.blog-grid{display:grid;gap:24px;grid-template-columns:repeat(3,1fr)}
.bcard{background:color-mix(in srgb,var(--card) 88%,transparent);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);border:1px solid var(--bd);border-radius:20px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 1px 2px rgba(13,21,38,.05);transition:transform .3s cubic-bezier(.2,.7,.2,1),box-shadow .3s,border-color .3s}
.bcard:hover{transform:translateY(-6px);border-color:color-mix(in srgb,var(--pri) 34%,var(--bd));box-shadow:0 30px 60px -32px color-mix(in srgb,var(--pri) 55%,transparent)}
.bcard-img{height:150px;display:grid;place-items:center;color:rgba(255,255,255,.92)}.bcard-img svg{width:44px;height:44px}
.bcard-body{padding:22px;display:flex;flex-direction:column;flex:1}
.btag{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--pri);margin-bottom:8px}
.bcard h3{margin:0 0 8px;font-size:1.14rem;line-height:1.35;font-weight:700}.bcard h3 a:hover{color:var(--pri)}
.bcard p{margin:0 0 16px;color:var(--mut);font-size:.94rem;flex:1}
.bmeta{display:flex;align-items:center;justify-content:space-between;font-size:.85rem;color:var(--mut)}.bmeta .more{color:var(--pri);font-weight:600}
.post{max-width:760px;margin:0 auto}
.post-back{display:inline-flex;align-items:center;gap:6px;color:var(--pri);font-weight:600;margin-bottom:22px}.post-back svg{width:16px;height:16px;transform:rotate(180deg)}
.post-meta{display:flex;align-items:center;gap:16px;color:var(--mut);font-size:.9rem;margin-top:8px;justify-content:center;flex-wrap:wrap}
.post-meta span{display:inline-flex;align-items:center;gap:6px}.post-meta svg{width:15px;height:15px}
.support-grid{display:grid;gap:18px;grid-template-columns:repeat(2,1fr);max-width:860px;margin:0 auto 8px}
.scard{display:flex;gap:16px;background:color-mix(in srgb,var(--card) 88%,transparent);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);border:1px solid var(--bd);border-radius:18px;padding:24px 26px;box-shadow:0 1px 2px rgba(13,21,38,.05);transition:transform .3s cubic-bezier(.2,.7,.2,1),box-shadow .3s,border-color .3s}
.scard:hover{transform:translateY(-6px);border-color:color-mix(in srgb,var(--pri) 30%,var(--bd));box-shadow:0 26px 52px -30px color-mix(in srgb,var(--pri) 50%,transparent)}
.scard .sic{width:48px;height:48px;flex:none;border-radius:14px;background:linear-gradient(135deg,color-mix(in srgb,var(--pri) 18%,transparent),color-mix(in srgb,var(--pri2) 16%,transparent));color:var(--pri);display:grid;place-items:center;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--pri) 22%,transparent)}.scard .sic svg{width:24px;height:24px}
.scard h3{margin:0 0 5px;font-size:1.08rem}.scard p{margin:0;color:var(--mut);font-size:.93rem;line-height:1.6}
.values{display:grid;gap:22px;grid-template-columns:repeat(3,1fr);margin:0}
.value{background:color-mix(in srgb,var(--card) 88%,transparent);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);border:1px solid var(--bd);border-radius:20px;padding:28px 26px;box-shadow:0 1px 2px rgba(13,21,38,.05);transition:transform .3s cubic-bezier(.2,.7,.2,1),box-shadow .3s,border-color .3s}
.value:hover{transform:translateY(-6px);border-color:color-mix(in srgb,var(--pri) 30%,var(--bd));box-shadow:0 26px 52px -30px color-mix(in srgb,var(--pri) 50%,transparent)}
.value .vic{width:52px;height:52px;border-radius:15px;background:linear-gradient(135deg,color-mix(in srgb,var(--pri) 18%,transparent),color-mix(in srgb,var(--pri2) 16%,transparent));color:var(--pri);display:grid;place-items:center;margin-bottom:16px;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--pri) 22%,transparent)}.value .vic svg{width:25px;height:25px}
.value h3{margin:0 0 6px;font-size:1.12rem}.value p{margin:0;color:var(--mut);font-size:.95rem;line-height:1.65}
.note{max-width:760px;margin:28px auto 0;background:color-mix(in srgb,var(--pri) 7%,var(--card));border:1px solid color-mix(in srgb,var(--pri) 22%,var(--bd));border-radius:14px;padding:16px 20px;color:var(--soft);font-size:.92rem;line-height:1.6}
@media(max-width:820px){.blog-grid,.values{grid-template-columns:1fr}.support-grid{grid-template-columns:1fr}}`;

// Dải CTA cuối trang, dùng lại cho mọi trang công ty.
const ctaBlock = (contactEmail) => `<section class="cta-final"><div class="wrap"><div class="cta-box reveal">
  <h2>Sẵn sàng mở cửa hàng của bạn?</h2>
  <p>Liên hệ để chúng tôi dựng website cho bạn — thường trong vài ngày.</p>
  <a class="btn btn-primary" href="${mailtoHref(contactEmail, 'Tôi muốn mở cửa hàng')}" aria-label="Liên hệ mở cửa hàng (gửi email)">Liên hệ ngay ${I.arrow}</a>
</div></div></section>`;

const pageHero = (eyebrow, title, sub) => `<header class="page-hero"><span class="orb o1" aria-hidden="true"></span><span class="orb o2" aria-hidden="true"></span><span class="orb o3" aria-hidden="true"></span><div class="wrap">
  <p class="eyebrow">${eyebrow}</p><h1>${esc(title)}</h1>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}
</div></header>`;

// ── GIỚI THIỆU ───────────────────────────────────────────────────────────────
const VALUES = [
  { icon: I.wallet, t: 'Minh bạch về tiền', d: 'Khách trả vào thẳng tài khoản của bạn. Chúng tôi không giữ, không ôm dòng tiền — không bao giờ.' },
  { icon: I.headset, t: 'Đồng hành, không bỏ mặc', d: 'Có người thật hỗ trợ bạn dựng shop, cấu hình, gỡ rối. Bạn không đơn độc với công nghệ.' },
  { icon: I.shield, t: 'Dữ liệu là của bạn', d: 'Sản phẩm, đơn hàng, khách hàng — bạn xuất ra bất cứ lúc nào. Không khoá chân, không giam giữ.' },
];
export function renderAbout(cfg = {}) {
  const { contactEmail = 'lienhe@nentang.vn' } = cfg;
  const body = `${pageHero(`${I.store}Về chúng tôi`, 'Chúng tôi lo kỹ thuật, để người Việt tự tin bán hàng', 'Sứ mệnh của chúng tôi là giúp mọi người bán hàng online có một cửa hàng chuyên nghiệp mà không cần biết một dòng code nào.')}
<section class="sec"><div class="wrap">
  <div class="content">
    <h2>Câu chuyện của chúng tôi</h2>
    <p>Rất nhiều người bán hàng giỏi ở Việt Nam bị mắc kẹt: bán trên mạng xã hội thì đơn sót, tin nhắn loạn, không chuyên nghiệp; muốn có website riêng thì vướng đủ thứ kỹ thuật — máy chủ, tên miền, thanh toán, bảo mật. Thuê làm thì đắt và sau đó không ai bảo trì.</p>
    <p>Chúng tôi tin việc bán hàng nên đơn giản. Vì vậy chúng tôi làm phần khó — dựng và vận hành cả hệ thống — để bạn chỉ tập trung vào điều bạn giỏi nhất: sản phẩm và khách hàng.</p>
    <h2>Chúng tôi tin điều gì</h2>
  </div>
  <div class="content" style="max-width:1000px"><div class="values" style="margin-top:18px">
    ${VALUES.map((v) => `<div class="value reveal"><div class="vic">${v.icon}</div><h3>${esc(v.t)}</h3><p>${esc(v.d)}</p></div>`).join('')}
  </div></div>
  <div class="content" style="margin-top:44px">
    <h2>Chúng tôi làm gì cho bạn</h2>
    <ul>
      <li>Dựng website bán hàng hoàn chỉnh, chuẩn SEO, hợp mọi thiết bị.</li>
      <li>Cấu hình thanh toán COD và chuyển khoản QR VietQR vào thẳng tài khoản bạn.</li>
      <li>Lo máy chủ, chứng chỉ HTTPS, sao lưu, cập nhật — bạn không phải đụng tới.</li>
      <li>Hỗ trợ bạn trong suốt quá trình vận hành, không bỏ mặc sau khi bàn giao.</li>
    </ul>
  </div>
</div></section>
${ctaBlock(contactEmail)}`;
  return sitePage({ title: `Giới thiệu — ${esc(cfg.brand ?? 'Nền Tảng')}`, description: 'Sứ mệnh của chúng tôi: giúp người Việt bán hàng online với một cửa hàng chuyên nghiệp mà không cần biết kỹ thuật.', active: '', extraCss: COMPANY_CSS, body, ...cfg });
}

// ── TRUNG TÂM HỖ TRỢ ─────────────────────────────────────────────────────────
const SUPPORT_CATS = [
  { icon: I.rocket, t: 'Bắt đầu', d: 'Đăng ký, nhận cửa hàng, đăng sản phẩm đầu tiên và mở bán.' },
  { icon: I.wallet, t: 'Thanh toán', d: 'Cấu hình COD, chuyển khoản QR VietQR, đối soát và nhận tiền.' },
  { icon: I.seo, t: 'Tên miền & SEO', d: 'Dùng tên miền phụ .nentang.vn hoặc gắn tên miền riêng, tối ưu tìm kiếm.' },
  { icon: I.cart, t: 'Quản lý đơn & kho', d: 'Xử lý đơn, cập nhật trạng thái, quản lý tồn kho, xuất dữ liệu.' },
];
const SUPPORT_FAQS = [
  { q: 'Làm sao để đăng sản phẩm đầu tiên?', a: 'Đăng nhập trang quản trị → mục Sản phẩm → Thêm sản phẩm, nhập tên, giá, ảnh và mô tả rồi lưu. Sản phẩm sẽ hiện ngay trên cửa hàng của bạn.' },
  { q: 'Tôi nhận tiền khách chuyển khoản ở đâu?', a: 'Tiền chuyển khoản QR vào thẳng tài khoản ngân hàng bạn đã cấu hình trong mục Thanh toán. Nền tảng không giữ tiền của bạn.' },
  { q: 'Tôi cần hỗ trợ gấp thì liên hệ thế nào?', a: 'Gửi email cho đội hỗ trợ theo địa chỉ ở cuối trang, mô tả rõ vấn đề và tên cửa hàng của bạn — chúng tôi phản hồi sớm nhất.' },
];
export function renderSupport(cfg = {}) {
  const { contactEmail = 'lienhe@nentang.vn' } = cfg;
  const body = `${pageHero(`${I.headset}Trung tâm hỗ trợ`, 'Chúng tôi luôn ở đây khi bạn cần', 'Chọn chủ đề bên dưới hoặc liên hệ trực tiếp — có người thật hỗ trợ bạn.')}
<section class="sec" style="padding-bottom:40px"><div class="wrap">
  <div class="support-grid">
    ${SUPPORT_CATS.map((c) => `<div class="scard reveal"><div class="sic">${c.icon}</div><div><h3>${esc(c.t)}</h3><p>${esc(c.d)}</p></div></div>`).join('')}
  </div>
</div></section>
<section class="sec" style="padding-top:0"><div class="wrap">
  <div class="sec-head reveal"><p class="kick">Hỏi đáp nhanh</p><h2>Câu hỏi thường gặp</h2></div>
  <div class="faq">${SUPPORT_FAQS.map((f) => `<details><summary>${esc(f.q)}</summary><div class="ans">${esc(f.a)}</div></details>`).join('')}</div>
  <div class="note" style="text-align:center">Không tìm thấy câu trả lời? Gửi email cho chúng tôi tại <a href="${mailtoHref(contactEmail, 'Cần hỗ trợ')}">${esc(contactEmail)}</a> — chúng tôi phản hồi sớm nhất.</div>
</div></section>
${ctaBlock(contactEmail)}`;
  return sitePage({ title: `Trung tâm hỗ trợ — ${esc(cfg.brand ?? 'Nền Tảng')}`, description: 'Trung tâm hỗ trợ: hướng dẫn bắt đầu, thanh toán, tên miền, quản lý đơn hàng và giải đáp thắc mắc.', active: 'support', extraCss: COMPANY_CSS, body, ...cfg });
}

// ── ĐIỀU KHOẢN (bản mẫu — cần rà soát pháp lý) ───────────────────────────────
export function renderTerms(cfg = {}) {
  const { contactEmail = 'lienhe@nentang.vn', brand = 'Nền Tảng' } = cfg;
  const body = `${pageHero(`${I.doc}Pháp lý`, 'Điều khoản dịch vụ', 'Cập nhật: Tháng 7, 2026')}
<section class="sec"><div class="wrap">
  <div class="note">Đây là <strong>bản mẫu</strong> để bạn tham khảo. Trước khi áp dụng chính thức, hãy rà soát với luật sư và điền thông tin công ty thật (tên pháp nhân, địa chỉ, mã số thuế).</div>
  <div class="content" style="margin-top:32px">
    <h2>1. Về dịch vụ</h2>
    <p>${esc(brand)} cung cấp dịch vụ dựng và vận hành website bán hàng trọn gói. Bằng việc sử dụng dịch vụ, bạn đồng ý với các điều khoản dưới đây.</p>
    <h2>2. Tài khoản</h2>
    <p>Bạn chịu trách nhiệm bảo mật thông tin đăng nhập và mọi hoạt động dưới tài khoản của mình. Vui lòng thông báo ngay khi phát hiện truy cập trái phép.</p>
    <h2>3. Thanh toán & gói cước</h2>
    <p>Phí dịch vụ được tính theo gói hằng tháng đã niêm yết. Bạn có thể nâng hoặc hạ gói bất cứ lúc nào. Tiền khách hàng thanh toán (COD/chuyển khoản) đi thẳng vào tài khoản của bạn; chúng tôi không giữ khoản tiền này.</p>
    <h2>4. Dữ liệu & quyền sở hữu</h2>
    <p>Toàn bộ dữ liệu cửa hàng (sản phẩm, đơn hàng, khách hàng) thuộc về bạn. Bạn có thể xuất dữ liệu bất cứ lúc nào. Chúng tôi chỉ xử lý dữ liệu để cung cấp dịch vụ và không bán cho bên thứ ba.</p>
    <h2>5. Trách nhiệm các bên</h2>
    <p>Chúng tôi nỗ lực duy trì dịch vụ ổn định, an toàn và sao lưu định kỳ. Bạn chịu trách nhiệm về tính hợp pháp của hàng hoá, nội dung đăng tải và việc tuân thủ pháp luật kinh doanh hiện hành.</p>
    <h2>6. Chấm dứt</h2>
    <p>Bạn có thể ngừng dịch vụ bất cứ lúc nào. Chúng tôi có thể tạm ngừng tài khoản vi phạm điều khoản hoặc pháp luật, sau khi thông báo hợp lý khi có thể.</p>
    <h2>7. Liên hệ</h2>
    <p>Mọi thắc mắc về điều khoản, vui lòng liên hệ <a href="${mailtoHref(contactEmail, 'Hỏi về điều khoản dịch vụ')}">${esc(contactEmail)}</a>.</p>
  </div>
</div></section>`;
  return sitePage({ title: `Điều khoản dịch vụ — ${esc(brand)}`, description: 'Điều khoản dịch vụ của nền tảng: tài khoản, thanh toán, dữ liệu và trách nhiệm các bên.', active: '', extraCss: COMPANY_CSS, body, ...cfg });
}

// ── CHÍNH SÁCH BẢO VỆ DỮ LIỆU CÁ NHÂN (bản mẫu — cần rà soát pháp lý) ────────
//
// VÌ SAO PHẢI CÓ, không phải "cho đẹp":
//   1. Nghị định 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân — ta thu thập họ tên, số điện
//      thoại, địa chỉ giao hàng, và cả TOẠ ĐỘ GPS (tính phí ship theo km).
//   2. Meta App Review BẮT BUỘC có URL chính sách quyền riêng tư mới duyệt app. Không có
//      trang này thì bot Messenger (0122) không bao giờ chạy được với Trang thật —
//      một tính năng đã xây xong nằm chờ đúng một trang tĩnh.
// Nội dung phải nói ĐÚNG những gì hệ thống làm thật; đừng chép mẫu chung chung rồi mô tả
// sai — sai còn tệ hơn không có.
export function renderPrivacy(cfg = {}) {
  const { contactEmail = 'lienhe@nentang.vn', brand = 'Nền Tảng' } = cfg;
  const body = `${pageHero(`${I.shield}Pháp lý`, 'Chính sách bảo vệ dữ liệu cá nhân', 'Cập nhật: Tháng 8, 2026')}
<section class="sec"><div class="wrap">
  <div class="note">Đây là <strong>bản mẫu</strong> mô tả đúng cách hệ thống đang hoạt động. Trước khi áp dụng chính thức, hãy rà soát với luật sư và điền thông tin pháp nhân thật (tên công ty, địa chỉ, mã số thuế, người phụ trách bảo vệ dữ liệu).</div>
  <div class="content" style="margin-top:32px">
    <h2>1. Chúng tôi là ai</h2>
    <p>${esc(brand)} cung cấp nền tảng dựng và vận hành website bán hàng. Chính sách này áp dụng cho hai nhóm: <strong>chủ cửa hàng</strong> dùng dịch vụ, và <strong>người mua hàng</strong> ghé các cửa hàng chạy trên nền tảng.</p>
    <p>Với dữ liệu người mua, chủ cửa hàng là <strong>Bên Kiểm soát dữ liệu</strong> và ${esc(brand)} là <strong>Bên Xử lý dữ liệu</strong> — chúng tôi chỉ xử lý theo yêu cầu vận hành cửa hàng của họ.</p>

    <h2>2. Dữ liệu chúng tôi thu thập</h2>
    <p><strong>Của chủ cửa hàng:</strong> email, mật khẩu (chỉ lưu dạng băm, không bao giờ lưu bản gốc), tên cửa hàng, số tài khoản nhận tiền, nhật ký thao tác quản trị.</p>
    <p><strong>Của người mua:</strong> họ tên, số điện thoại, email, địa chỉ giao hàng, nội dung đơn hàng, đánh giá và ảnh đánh giá nếu bạn gửi.</p>
    <p><strong>Vị trí:</strong> nếu bạn <em>chủ động bấm</em> nút định vị lúc thanh toán, trình duyệt gửi toạ độ để tính phí giao theo khoảng cách. Không bấm thì không thu. Toạ độ được <strong>tự động ẩn danh</strong> sau khi đơn hoàn tất.</p>
    <p><strong>Kỹ thuật:</strong> địa chỉ IP được <strong>băm một chiều</strong> (không lưu IP gốc) để chống đơn ảo và chặn lạm dụng.</p>

    <h2>3. Dùng để làm gì</h2>
    <p>Xử lý và giao đơn hàng; gửi email xác nhận và cập nhật trạng thái; tính phí vận chuyển; chống gian lận và đơn ảo; hỗ trợ khi bạn liên hệ. <strong>Chúng tôi không dùng dữ liệu của bạn để quảng cáo và không bán cho bên thứ ba.</strong></p>

    <h2>4. Chia sẻ với ai</h2>
    <p>Chỉ chia sẻ ở mức tối thiểu cần thiết, với: <strong>đơn vị vận chuyển</strong> (tên, số điện thoại, địa chỉ để giao hàng); <strong>ngân hàng / cổng đối soát</strong> (nội dung chuyển khoản để xác nhận đã trả tiền); <strong>nhà cung cấp email</strong> để gửi thư giao dịch. Tiền khách trả đi <strong>thẳng vào tài khoản của chủ cửa hàng</strong> — chúng tôi không giữ dòng tiền.</p>
    <p>Ngoài ra chỉ chia sẻ khi có yêu cầu hợp pháp của cơ quan nhà nước có thẩm quyền.</p>

    <h2>5. Lưu bao lâu</h2>
    <p>Dữ liệu đơn hàng lưu theo thời hạn kế toán và nhu cầu tra soát của cửa hàng. Thông tin cá nhân trong đơn cũ được <strong>tự động ẩn danh</strong> sau thời hạn lưu trữ. Toạ độ vị trí ẩn danh sớm hơn, ngay sau khi đơn hoàn tất.</p>

    <h2>6. Quyền của bạn</h2>
    <p>Theo Nghị định 13/2023/NĐ-CP, bạn có quyền: được biết, truy cập, chỉnh sửa, xoá, hạn chế xử lý, rút lại sự đồng ý, và khiếu nại. Người mua có <strong>tài khoản khách hàng</strong> để tự xem lịch sử đơn và sổ địa chỉ. Muốn thực hiện quyền khác, gửi yêu cầu tới <a href="${mailtoHref(contactEmail, 'Yêu cầu về dữ liệu cá nhân')}">${esc(contactEmail)}</a> — chúng tôi phản hồi trong 72 giờ làm việc.</p>

    <h2>7. Chúng tôi bảo vệ thế nào</h2>
    <p>Mật khẩu băm bằng Argon2id. Token của bên thứ ba (vận chuyển, mạng xã hội) mã hoá AES-256-GCM khi lưu. Toàn bộ kết nối chạy HTTPS. Dữ liệu mỗi cửa hàng <strong>cách ly ở tầng cơ sở dữ liệu</strong> — cửa hàng này không đọc được dữ liệu cửa hàng kia. Sao lưu định kỳ có mã hoá.</p>

    <h2>8. Cookie</h2>
    <p>Chỉ dùng cookie cần thiết cho hoạt động: giữ giỏ hàng, giữ phiên đăng nhập, chống giả mạo biểu mẫu. <strong>Không có cookie quảng cáo hay theo dõi xuyên trang.</strong></p>

    <h2>9. Trẻ em</h2>
    <p>Dịch vụ không hướng tới người dưới 16 tuổi. Nếu phát hiện đã thu thập dữ liệu của trẻ em mà không có sự đồng ý của người giám hộ, chúng tôi sẽ xoá.</p>

    <h2>10. Thay đổi &amp; liên hệ</h2>
    <p>Khi có thay đổi quan trọng, chúng tôi cập nhật ngày ở đầu trang và thông báo cho chủ cửa hàng qua email. Mọi câu hỏi về dữ liệu cá nhân: <a href="${mailtoHref(contactEmail, 'Hỏi về chính sách bảo vệ dữ liệu')}">${esc(contactEmail)}</a>.</p>
  </div>
</div></section>`;
  return sitePage({ title: `Chính sách bảo vệ dữ liệu cá nhân — ${esc(brand)}`, description: 'Chúng tôi thu thập dữ liệu gì, dùng làm gì, chia sẻ với ai, lưu bao lâu và bạn có những quyền nào.', active: '', extraCss: COMPANY_CSS, body, ...cfg });
}

// ── LIÊN HỆ ──────────────────────────────────────────────────────────────────
// Trước đợt này thông tin liên hệ chỉ nằm lọt trong mục 7 của Điều khoản. Khách doanh
// nghiệp đi tìm "Liên hệ" sẽ không lục Điều khoản để tìm — họ đóng tab.
export function renderContact(cfg = {}) {
  const { contactEmail = 'lienhe@nentang.vn', contactPhone = '', brand = 'Nền Tảng' } = cfg;
  const body = `${pageHero(`${I.headset}Liên hệ`, 'Nói chuyện với người thật', 'Bạn không phải điền biểu mẫu rồi chờ. Gửi email hoặc gọi, có người trả lời.')}
<section class="sec"><div class="wrap">
  <div class="support-grid">
    <div class="scard"><div class="sic">${I.mail}</div><div>
      <h3>Email</h3><p><a href="${mailtoHref(contactEmail, 'Liên hệ')}">${esc(contactEmail)}</a><br>Phản hồi trong giờ làm việc, thường trong ngày.</p></div></div>
    ${contactPhone ? `<div class="scard"><div class="sic">${I.phone}</div><div>
      <h3>Điện thoại</h3><p>${esc(contactPhone)}<br>Thứ 2 – Thứ 7, 8:00 – 18:00.</p></div></div>` : ''}
    <div class="scard"><div class="sic">${I.headset}</div><div>
      <h3>Đang là khách hàng?</h3><p>Gửi yêu cầu ngay trong khu quản trị — mục <strong>Trợ giúp</strong>. Yêu cầu vào thẳng hàng đợi hỗ trợ kèm thông tin cửa hàng, không phải mô tả lại.</p></div></div>
    <div class="scard"><div class="sic">${I.doc}</div><div>
      <h3>Tự tra trước</h3><p>Nhiều câu hỏi đã có sẵn lời giải ở <a href="/ho-tro">Trung tâm hỗ trợ</a>.</p></div></div>
  </div>
  <div class="note">Thông tin pháp nhân (tên công ty, địa chỉ đăng ký, mã số thuế) sẽ được điền tại đây trước khi phát hành chính thức.</div>
</div></section>
${ctaBlock(contactEmail)}`;
  return sitePage({ title: `Liên hệ — ${esc(brand)}`, description: 'Liên hệ với đội ngũ: email, điện thoại và kênh hỗ trợ dành cho khách hàng đang dùng dịch vụ.', active: '', extraCss: COMPANY_CSS, body, ...cfg });
}

// ── BLOG CÔNG TY (bài viết tĩnh — thêm bài mới vào mảng POSTS) ────────────────
const GRAD = ['#2463eb,#7c3aed', '#0d9488,#115e59', '#d97706,#92400e'];
const P = (t) => ({ p: t });
const H = (t) => ({ h: t });
const L = (items) => ({ ul: items });
const POSTS = [
  {
    slug: 'vi-sao-nen-co-website-ban-hang-rieng',
    tag: 'Kinh doanh', date: '12/07/2026', read: '5 phút',
    title: '5 lý do bạn nên có website bán hàng riêng, không chỉ bán trên Facebook',
    excerpt: 'Mạng xã hội tốt để tiếp cận khách, nhưng một website riêng mới giúp bạn bán chuyên nghiệp và bền vững. Đây là lý do vì sao.',
    blocks: [
      P('Bán trên Facebook, Instagram hay TikTok giúp bạn tiếp cận khách rất nhanh. Nhưng khi shop lớn dần, chỉ dựa vào mạng xã hội sẽ lộ ra nhiều điểm yếu. Một website bán hàng riêng khắc phục được chúng.'),
      H('1. Bạn làm chủ "mặt tiền" của mình'),
      P('Thuật toán mạng xã hội thay đổi liên tục; một ngày nào đó bài của bạn có thể không ai thấy. Website là tài sản của riêng bạn — không ai tắt được nó.'),
      H('2. Khách mua chuyên nghiệp hơn'),
      P('Có trang sản phẩm rõ ràng, giỏ hàng, thanh toán — khách tự đặt đơn, bạn không phải chốt tay từng tin nhắn, đỡ sót đơn.'),
      H('3. Tự lên Google'),
      P('Website chuẩn SEO giúp khách tìm thấy bạn khi họ tra cứu sản phẩm — nguồn khách miễn phí mà mạng xã hội không có.'),
      H('4. Dữ liệu là của bạn'),
      P('Bạn nắm được sản phẩm nào bán chạy, khách nào quay lại — để bán tốt hơn theo thời gian.'),
      H('5. Thương hiệu đáng tin hơn'),
      P('Một website riêng cho khách cảm giác đây là cửa hàng nghiêm túc, không phải tài khoản bán hàng tạm bợ.'),
      L(['Tiếp cận khách bằng mạng xã hội', 'Chốt đơn và xây thương hiệu bằng website riêng', 'Kết hợp cả hai để bán bền vững']),
    ],
  },
  {
    slug: 'cod-hay-chuyen-khoan-qr',
    tag: 'Thanh toán', date: '05/07/2026', read: '4 phút',
    title: 'COD hay chuyển khoản QR: nên dùng hình thức nào cho shop của bạn?',
    excerpt: 'Mỗi hình thức có ưu và nhược riêng. Hiểu rõ để chọn đúng — và tốt nhất là cho khách cả hai lựa chọn.',
    blocks: [
      P('Hai hình thức thanh toán phổ biến nhất với shop online Việt Nam là COD (thu tiền khi giao) và chuyển khoản QR. Nên dùng cái nào?'),
      H('COD — Thu tiền khi nhận hàng'),
      P('Ưu điểm: khách tin tưởng vì "thấy hàng mới trả tiền", tỷ lệ chốt đơn cao. Nhược điểm: tỷ lệ bom hàng cao hơn, dòng tiền về chậm, tốn phí ship hai chiều nếu khách trả hàng.'),
      H('Chuyển khoản QR (VietQR)'),
      P('Ưu điểm: tiền về ngay, giảm bom hàng, không cần đối soát tiền mặt với shipper. Nhược điểm: một số khách còn e ngại trả trước khi nhận hàng.'),
      H('Lời khuyên'),
      P('Hãy cho khách cả hai lựa chọn. Khuyến khích chuyển khoản QR bằng ưu đãi nhỏ (miễn phí ship, giảm giá) để cải thiện dòng tiền, nhưng vẫn giữ COD cho khách mới còn e ngại.'),
      L(['COD: hợp khách mới, đơn giá trị thấp', 'QR: hợp khách quen, đơn giá trị cao', 'Cho cả hai để không mất đơn nào']),
    ],
  },
  {
    slug: 'chup-anh-san-pham-dep-bang-dien-thoai',
    tag: 'Mẹo bán hàng', date: '28/06/2026', read: '6 phút',
    title: 'Chụp ảnh sản phẩm đẹp bằng điện thoại: 7 mẹo đơn giản',
    excerpt: 'Ảnh đẹp bán chạy hơn. Bạn không cần máy ảnh xịn — chỉ cần chiếc điện thoại và vài mẹo nhỏ này.',
    blocks: [
      P('Trên website, khách không sờ được sản phẩm — họ mua bằng mắt. Ảnh đẹp là yếu tố quyết định. Tin vui: điện thoại là đủ.'),
      L([
        'Dùng ánh sáng tự nhiên: chụp gần cửa sổ, tránh đèn vàng làm sai màu.',
        'Nền đơn giản: một tấm vải hoặc giấy trắng/xám làm nổi bật sản phẩm.',
        'Lau sạch ống kính: vết mờ khiến ảnh mất nét mà bạn không để ý.',
        'Chụp nhiều góc: mặt trước, mặt sau, chi tiết, và ảnh "đang dùng".',
        'Giữ máy chắc: tựa vào bàn hoặc dùng chân đế nhỏ để ảnh không rung.',
        'Bố cục theo lưới: bật lưới trong camera, đặt sản phẩm theo điểm giao.',
        'Chỉnh nhẹ: tăng sáng và độ tương phản vừa phải, đừng lạm dụng bộ lọc.',
      ]),
      H('Nhất quán tạo nên thương hiệu'),
      P('Chụp mọi sản phẩm cùng phong cách (cùng nền, cùng ánh sáng) để trang cửa hàng nhìn gọn gàng, chuyên nghiệp. Sự nhất quán quan trọng hơn một tấm ảnh "nghệ" đơn lẻ.'),
    ],
  },
];

const renderBlocks = (blocks) => blocks.map((b) => {
  if (b.h) return `<h2>${esc(b.h)}</h2>`;
  if (b.ul) return `<ul>${b.ul.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
  return `<p>${esc(b.p)}</p>`;
}).join('');

export function renderBlogList(cfg = {}) {
  const { contactEmail = 'lienhe@nentang.vn' } = cfg;
  const cards = POSTS.map((p, i) => `<article class="bcard reveal">
    <div class="bcard-img" style="background:linear-gradient(135deg,${GRAD[i % GRAD.length]})">${I.book}</div>
    <div class="bcard-body">
      <div class="btag">${esc(p.tag)}</div>
      <h3><a href="/blog/${esc(p.slug)}">${esc(p.title)}</a></h3>
      <p>${esc(p.excerpt)}</p>
      <div class="bmeta"><span>${esc(p.date)} · ${esc(p.read)}</span><a class="more" href="/blog/${esc(p.slug)}">Đọc tiếp →</a></div>
    </div>
  </article>`).join('');
  const body = `${pageHero(`${I.book}Blog`, 'Kiến thức bán hàng online cho người Việt', 'Mẹo bán hàng, thanh toán, xây thương hiệu — cập nhật thường xuyên.')}
<section class="sec"><div class="wrap"><div class="blog-grid">${cards}</div></div></section>
${ctaBlock(contactEmail)}`;
  return sitePage({ title: `Blog — ${esc(cfg.brand ?? 'Nền Tảng')}`, description: 'Blog nền tảng: mẹo bán hàng online, thanh toán, chụp ảnh sản phẩm và xây thương hiệu cho người Việt.', active: 'blog', extraCss: COMPANY_CSS, body, ...cfg });
}

export const findPost = (slug) => POSTS.find((p) => p.slug === slug) ?? null;
// Danh sách đường dẫn trang công ty (cho sitemap của nentang.vn).
export const companyPaths = () => ['/gioi-thieu', '/ho-tro', '/lien-he', '/dieu-khoan', '/bao-mat', '/blog', ...POSTS.map((p) => `/blog/${p.slug}`)];

export function renderBlogPost(cfg, post) {
  const { contactEmail = 'lienhe@nentang.vn' } = cfg ?? {};
  const body = `${pageHero(`${I.book}${esc(post.tag)}`, post.title, '')}
<section class="sec" style="padding-top:24px"><div class="wrap">
  <div class="post-meta"><span>${I.clock}${esc(post.date)}</span><span>${esc(post.read)} đọc</span></div>
  <div class="post content" style="margin-top:34px">
    <a class="post-back" href="/blog">${I.arrow}Tất cả bài viết</a>
    ${renderBlocks(post.blocks)}
  </div>
</div></section>
${ctaBlock(contactEmail)}`;
  return sitePage({ title: `${esc(post.title)} — ${esc((cfg && cfg.brand) ?? 'Nền Tảng')}`, description: post.excerpt, active: 'blog', extraCss: COMPANY_CSS, body, ...(cfg ?? {}) });
}
