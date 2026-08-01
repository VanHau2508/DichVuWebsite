/**
 * Vẽ banner mặc định KHÔNG được đè cấu hình chủ shop vừa lưu. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/worker/test/banner-race.e2e.mjs
 *
 * seedShopBanners là đọc–sửa–ghi, và khoảng giữa hai đầu có vẽ ảnh + upload MinIO cho
 * ~8 banner, tức hàng giây. Chủ shop bấm Lưu trong trang Giao diện đúng khoảng đó thì
 * trước đây thay đổi của HỌ bị đè mất, im lặng, không ai biết. Vá bằng ghi CÓ ĐIỀU KIỆN
 * (`AND layout = <bản đã đọc>`), xung đột thì đọc lại và đắp slides lên bản mới.
 *
 * VÌ SAO LÀ BỘ RIÊNG, không nằm trong worker/e2e.mjs: bộ đó CỐ TÌNH làm hỏng hàng đợi
 * (tạo email bounce để kiểm dead-letter + retryJobs). Đặt ca này sau đó thì job banner
 * xếp hàng sau đống job đang retry và không chạy kịp — đã dính đúng vậy, ca báo đỏ vì
 * lý do chẳng liên quan gì tới thứ nó đo. Bộ riêng chỉ cần DB + worker, không cần auth.
 */
import pg from 'pg';

const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${d}${X}`); };
const sect = (m) => console.log(`\n${B}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ── Vẽ banner mặc định KHÔNG được đè cấu hình chủ shop vừa lưu ──────────────
  //
  // seedShopBanners là đọc–sửa–ghi, và khoảng giữa hai đầu có vẽ ảnh + upload MinIO
  // cho ~8 banner, tức hàng giây. Chủ shop bấm Lưu trong trang Giao diện đúng khoảng
  // đó thì trước đây thay đổi của HỌ bị đè mất, im lặng.
  //
  // Ép cuộc đua BẰNG KHOÁ HÀNG, không bằng sleep may rủi: giữ `SELECT … FOR UPDATE`
  // trên hàng themes → lệnh UPDATE của worker CHẶN LẠI. Ta ghi cấu hình của "chủ shop"
  // trong chính giao dịch đang giữ khoá rồi COMMIT. Worker mở khoá, đọc lại điều kiện
  // WHERE trên bản MỚI (READ COMMITTED), thấy layout đã đổi → không ghi đè → thử lại.
  //
  // Ca này TỰ CHỨNG MINH nó không xanh-rỗng: trước khi commit, nó khẳng định đã thấy
  // worker THẬT SỰ đang bị chặn trong pg_stat_activity. Không thấy chặn = không có
  // cuộc đua = báo đỏ, chứ không lặng lẽ đạt.
  sect('Vẽ banner mặc định không đè cấu hình chủ shop');
  const bshop = (await owner.query(
    `INSERT INTO shops (slug,name,status) VALUES ($1,$1,'active') RETURNING id`, [`bn-${uniq()}`])).rows[0].id;
  await owner.query(
    `INSERT INTO themes (shop_id, tokens, layout) VALUES ($1,'{"color":{"primary":"#c2185b"}}'::jsonb,$2::jsonb)`,
    [bshop, JSON.stringify([
      { section: 'header', props: {} },
      { section: 'hero', props: { slides: [] } },
      { section: 'promo_banners', props: { slides: [] } },
      { section: 'footer', props: {} },
    ])]);

  // HÂM NÓNG trước khi đo. Bản đầu của ca này bỏ qua bước đó và đã cho một kết quả
  // SAI LỆCH: worker vừa build lại còn nguội (kết nối BullMQ + vòng poll outbox tới 5s)
  // nên chưa kịp tới lệnh UPDATE trong cửa sổ chờ, ca báo đỏ vì lý do chẳng liên quan
  // gì tới thứ nó định đo. Chạy một job thật trước, thấy nó ra slide thì mới chắc
  // worker đang xử lý; từ đó cuộc đua bên dưới mới nói lên điều gì.
  const wshop = (await owner.query(
    `INSERT INTO shops (slug,name,status) VALUES ($1,$1,'active') RETURNING id`, [`bw-${uniq()}`])).rows[0].id;
  await owner.query(`INSERT INTO themes (shop_id, tokens, layout) VALUES ($1,'{}'::jsonb,$2::jsonb)`,
    [wshop, JSON.stringify([{ section: 'hero', props: { slides: [] } }, { section: 'footer', props: {} }])]);
  await owner.query(`INSERT INTO outbox (shop_id, topic, payload) VALUES (NULL,'shop.banners_seed',$1::jsonb)`,
    [JSON.stringify({ shop_id: wshop, industry: 'food' })]);
  let warm = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const L = (await owner.query('SELECT layout FROM themes WHERE shop_id=$1', [wshop])).rows[0].layout;
    warm = (L.find((s) => s.section === 'hero')?.props?.slides ?? []).length;
    if (warm) break;
  }
  await owner.query('DELETE FROM themes WHERE shop_id=$1', [wshop]);
  await owner.query('DELETE FROM shops WHERE id=$1', [wshop]);
  warm > 0 ? ok('worker đã nóng máy (job hâm nóng ra banner)') : bad('worker không xử lý job — mọi ca dưới vô nghĩa');

  const holder = await owner.connect();          // giao dịch GIỮ KHOÁ
  let blocked = false;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT layout FROM themes WHERE shop_id = $1 FOR UPDATE', [bshop]);
    // Thả job cho worker. Nó đọc được (SELECT thường không bị khoá chặn), vẽ ảnh, rồi
    // nghẽn ở UPDATE.
    await owner.query(`INSERT INTO outbox (shop_id, topic, payload) VALUES (NULL,'shop.banners_seed',$1::jsonb)`,
      [JSON.stringify({ shop_id: bshop, industry: 'cosmetics' })]);
    for (let i = 0; i < 120 && !blocked; i++) {  // tối đa ~60s chờ worker nghẽn
      await sleep(500);
      blocked = Number((await owner.query(
        `SELECT count(*) n FROM pg_stat_activity
          WHERE query ILIKE '%UPDATE themes SET layout%' AND wait_event_type = 'Lock'`)).rows[0].n) > 0;
    }
    // "Chủ shop lưu giao diện" NGAY trong lúc worker đang nghẽn.
    await holder.query(
      `UPDATE themes SET layout = (SELECT jsonb_agg(CASE WHEN s->>'section'='footer'
         THEN jsonb_set(s,'{props}','{"social":[{"kind":"zalo","url":"https://zalo.me/9"}]}'::jsonb) ELSE s END)
         FROM jsonb_array_elements(layout) s) WHERE shop_id = $1`, [bshop]);
    await holder.query('COMMIT');
  } finally { holder.release(); }

  blocked ? ok('dựng được cuộc đua THẬT: worker nghẽn ở UPDATE themes vì khoá hàng')
    : bad('KHÔNG dựng được cuộc đua — ca dưới đây vô nghĩa', 'không thấy worker chờ khoá');

  let bl = null;
  for (let i = 0; i < 90; i++) {                 // chờ worker thử lại xong (tối đa ~45s)
    await sleep(500);
    bl = (await owner.query('SELECT layout FROM themes WHERE shop_id=$1', [bshop])).rows[0].layout;
    const hs = bl.find((s) => s.section === 'hero')?.props?.slides ?? [];
    if (hs.length) break;
  }
  const heroSlides = bl?.find((s) => s.section === 'hero')?.props?.slides ?? [];
  const keptSocial = bl?.find((s) => s.section === 'footer')?.props?.social ?? [];
  heroSlides.length > 0
    ? ok(`banner mặc định vẫn được vẽ (${heroSlides.length} slide hero)`) : bad('worker không vẽ được banner');
  keptSocial.length === 1 && keptSocial[0].kind === 'zalo'
    ? ok('cấu hình chủ shop lưu GIỮA CHỪNG vẫn còn — không bị đè')
    : bad('MẤT cấu hình chủ shop (lost update)', JSON.stringify(keptSocial));
  await owner.query('DELETE FROM themes WHERE shop_id=$1', [bshop]);
  await owner.query('DELETE FROM shops WHERE id=$1', [bshop]);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((err) => { console.error('banner-race e2e lỗi:', err); process.exit(2); });
