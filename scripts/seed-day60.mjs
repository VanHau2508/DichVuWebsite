/**
 * DỰNG SHOP "NGÀY THỨ 60" — hiện trường để tự đóng vai chủ shop đã bán được hai tháng.
 *
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node scripts/seed-day60.mjs
 *
 * VÌ SAO CẦN. Mọi màn hình đều đẹp ở ngày 1 vì dữ liệu trống: danh sách 3 dòng không cần tìm
 * kiếm, báo cáo 1 tuần không cần so kỳ, tồn kho 5 SKU nhìn phát thấy hết. Cái vỡ ở ngày 60 —
 * "tìm lại đơn tháng trước", "200 SP còn dùng được danh sách không", "báo cáo 60 ngày có chậm
 * không" — thì ngày 1 KHÔNG BAO GIỜ lộ ra. Muốn thấy thì phải có dữ liệu thật của ngày 60.
 *
 * TÍNH TRUNG THỰC CỦA HIỆN TRƯỜNG. Sản phẩm/tồn kho đi qua API THẬT của seller (giữ đúng ràng
 * buộc biến thể, tồn, sổ cái). Đơn hàng ghi thẳng SQL — 400 đơn qua checkout thật sẽ mất hàng
 * giờ và đụng trần chống-đơn-ảo — nhưng ghi ĐÚNG BẤT BIẾN: tổng = Σ dòng + ship − giảm,
 * paid_at/shipped_at/delivered_at thuận thời gian, đơn đã trả có payment_transactions, đơn đã
 * giao có dòng sổ cái xuất kho, on_hand = nhập − xuất. Sai bất biến thì mọi màn hình hiện số
 * vô nghĩa và tôi sẽ đuổi theo lỗi ma.
 *
 * KHÔNG PHẢI dữ liệu để chạy test tự động — đây là hiện trường để NGƯỜI (hoặc tôi đóng vai
 * người) đi lại bằng mắt. Chạy lại nhiều lần sẽ tạo shop MỚI mỗi lần, không đụng shop cũ.
 */
import crypto from 'node:crypto';
import pg from 'pg';
import { totp, counterFor } from '../packages/auth/src/totp.js';
import { base32Decode } from '../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 6 });

const uniq = () => Math.random().toString(36).slice(2, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

async function rq(base, method, path, { body, cookie, origin } = {}) {
  const h = {}; if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin; if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, raw: t, sc: r.headers.getSetCookie() };
}
const login = async (e, p) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email: e, password: p }, origin: OA })).sc);

// ── Dữ liệu tiếng Việt để màn hình đọc ra như shop thật, không phải "SP 1, SP 2" ──────────
const LOAI = [
  ['Áo thun', ['trơn', 'in hình', 'cổ tròn', 'cổ tim', 'oversize', 'form rộng', 'tay lỡ']],
  ['Áo sơ mi', ['kẻ sọc', 'trắng công sở', 'lụa', 'caro', 'tay dài', 'linen']],
  ['Quần jean', ['ống suông', 'skinny', 'rách gối', 'baggy', 'lửng']],
  ['Quần short', ['kaki', 'jean', 'thể thao', 'đũi']],
  ['Váy', ['hoa nhí', 'liền thân', 'xoè', 'công sở', 'maxi']],
  ['Áo khoác', ['bomber', 'jean', 'gió', 'cardigan', 'blazer']],
  ['Giày', ['sneaker trắng', 'lười da', 'thể thao', 'sandal']],
  ['Túi', ['tote vải', 'đeo chéo', 'da mini', 'cói']],
];
const MAU = ['Đen', 'Trắng', 'Be', 'Xanh navy', 'Xám', 'Nâu', 'Hồng'];
const CO = ['S', 'M', 'L', 'XL'];
const HO = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Vũ', 'Đặng', 'Bùi', 'Đỗ', 'Ngô'];
const DEM = ['Thị', 'Văn', 'Minh', 'Thu', 'Quốc', 'Hải', 'Ngọc', 'Anh'];
const TEN = ['An', 'Bình', 'Chi', 'Dũng', 'Giang', 'Hà', 'Hùng', 'Lan', 'Linh', 'Mai', 'Nam', 'Oanh', 'Phúc', 'Quân', 'Sơn', 'Thảo', 'Trang', 'Tú', 'Vy', 'Yến'];
const TINH = ['Hà Nội', 'TP. Hồ Chí Minh', 'Đà Nẵng', 'Hải Phòng', 'Cần Thơ', 'Bình Dương', 'Đồng Nai', 'Khánh Hòa', 'Nghệ An', 'Thanh Hóa'];
const DUONG = ['Lê Lợi', 'Nguyễn Huệ', 'Trần Hưng Đạo', 'Hai Bà Trưng', 'Lý Thường Kiệt', 'Phan Đình Phùng', 'Nguyễn Trãi'];
const khongDau = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function makeStaff() {
  const email = `seed60-${uniq()}@nentang.vn`, password = 'seed passphrase strong';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let c = await login(email, password);
  const en = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie: c, origin: OA });
  const key = base32Decode(en.json.secret);
  await rq(AUTH, 'POST', '/auth/mfa/activate', { cookie: c, body: { code: totp(key, {}) }, origin: OA });
  const c0 = counterFor(Date.now());
  const uid = (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0].id;
  await owner.query(`INSERT INTO platform_staff (user_id,role) VALUES ($1,'admin')`, [uid]);
  while (counterFor(Date.now()) <= c0) await sleep(1000);
  c = await login(email, password);
  return ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie: c, body: { code: totp(key, {}) }, origin: OA })).sc) ?? c;
}

async function main() {
  const t0 = Date.now();
  // CHẾ ĐỘ BỔ SUNG: SEED_SHOP_ID + SEED_EMAIL + SEED_PASS + SEED_FROM → chỉ thêm sản phẩm vào
  // shop đã có. Cần vì trần gói chặn ở 100 SP: muốn dựng đúng hiện trường 200 SP như đề bài thì
  // phải nâng gói rồi chạy tiếp, chứ dựng lại từ đầu là mất 395 đơn đã rải công phu.
  if (process.env.SEED_SHOP_ID) {
    const shopId = process.env.SEED_SHOP_ID;
    const oc = await login(process.env.SEED_EMAIL, process.env.SEED_PASS);
    if (!oc) throw new Error('không đăng nhập được chủ shop');
    const from = Number(process.env.SEED_FROM ?? 200);
    const to = Number(process.env.SEED_TO ?? 300);
    const S = {
      get: (p) => rq(SELLER, 'GET', `/shops/${shopId}${p}`, { cookie: oc }),
      post: (p, b) => rq(SELLER, 'POST', `/shops/${shopId}${p}`, { body: b, cookie: oc, origin: OS }),
    };
    let ok = 0; const err = [];
    const one = async (i) => {
      const [cha, cons] = LOAI[i % LOAI.length];
      const ten = `${cha} ${pick(cons)} ${pick(MAU)}`;
      const gia = rint(9, 65) * 10000;
      const res = await S.post('/products', {
        title: ten, slug: `${khongDau(ten)}-${i}-${uniq()}`, price_vnd: gia, status: i % 17 === 0 ? 'draft' : 'active',
        description: `${ten}. Chất liệu thoáng mát, form chuẩn, dễ phối đồ.`,
        variants: Array.from({ length: rint(1, 3) }, (_, k) => ({ sku: `SKU-${i}-${k}-${uniq()}`, price_vnd: gia, title: `${pick(CO)} / ${pick(MAU)}` })),
      });
      if (res.status !== 201) { err.push(`${res.status} ${String(res.raw).slice(0, 100)}`); return; }
      const full = (await S.get(`/products/${res.json.id}`)).json;
      for (const v of full.variants ?? []) await S.post(`/variants/${v.id}/inventory/adjust`, { delta: rint(12, 90), reason: 'nhập thêm' });
      ok++;
    };
    for (let i = from; i < to; i += 6) await Promise.all(Array.from({ length: Math.min(6, to - i) }, (_, k) => one(i + k)));
    console.log(`bổ sung ${ok} sản phẩm` + (err.length ? ` · ${err.length} lỗi, ví dụ: ${err[0]}` : ''));
    await owner.end();
    return;
  }
  console.log('▶ 1/6  Dựng shop + chủ shop');
  const staff = await makeStaff();
  const slug = `ngay60-${uniq()}`;
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: 'Thời trang Ngày 60', slug, plan_code: 'platform' }, cookie: staff, origin: OO });
  if (r.status !== 201) throw new Error('không tạo được shop: ' + r.raw);
  const shopId = r.json.id;
  const email = `chushop-${uniq()}@shop.vn`, password = 'chu shop passphrase 60';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staff, origin: OO });
  const tok = (await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email])).rows[0].u;
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: new URL(tok).searchParams.get('token'), password }, origin: OA });
  const oc = await login(email, password);
  // Shop đã bán 2 tháng thì phải ACTIVE, và ngày tạo phải lùi 60 ngày — nếu không mọi màn
  // "shop mới" (checklist onboarding) sẽ hiện sai và tôi đóng vai nhầm người.
  await owner.query(`UPDATE shops SET status='active', created_at = now() - interval '60 days', first_product_at = now() - interval '59 days' WHERE id=$1`, [shopId]);
  const S = {
    get: (p) => rq(SELLER, 'GET', `/shops/${shopId}${p}`, { cookie: oc }),
    post: (p, b) => rq(SELLER, 'POST', `/shops/${shopId}${p}`, { body: b, cookie: oc, origin: OS }),
    patch: (p, b) => rq(SELLER, 'PATCH', `/shops/${shopId}${p}`, { body: b, cookie: oc, origin: OS }),
  };

  console.log('▶ 2/6  200 sản phẩm (qua API thật — giữ đúng ràng buộc biến thể/tồn)');
  // Danh mục 2 cấp như shop thật.
  const cats = [];
  for (const [cha, cons] of LOAI.slice(0, 5)) {
    const c1 = await S.post('/categories', { name: cha, slug: khongDau(cha) + '-' + uniq() });
    if (c1.status === 201) {
      cats.push(c1.json.id);
      for (const con of cons.slice(0, 3)) {
        const c2 = await S.post('/categories', { name: `${cha} ${con}`, slug: khongDau(cha + '-' + con) + '-' + uniq(), parent_id: c1.json.id });
        if (c2.status === 201) cats.push(c2.json.id);
      }
    }
  }
  const variants = [];   // { id, price, cost }
  const products = [];
  const loi = [];
  let made = 0;
  const mkOne = async (i) => {
    const [cha, cons] = LOAI[i % LOAI.length];
    const ten = `${cha} ${pick(cons)} ${pick(MAU)}`;
    const gia = rint(9, 65) * 10000;
    const von = Math.round(gia * (0.45 + Math.random() * 0.2));
    const bienThe = Array.from({ length: rint(1, 4) }, (_, k) => ({
      sku: `SKU-${String(i).padStart(3, '0')}-${k}`, price_vnd: gia, title: `${pick(CO)} / ${pick(MAU)}`,
    }));
    const res = await S.post('/products', {
      title: ten, slug: `${khongDau(ten)}-${i}-${uniq()}`, price_vnd: gia, status: i % 17 === 0 ? 'draft' : 'active',
      description: `${ten}. Chất liệu thoáng mát, form chuẩn, dễ phối đồ. Hàng có sẵn, giao toàn quốc.`,
      variants: bienThe,
    });
    if (res.status !== 201) { loi.push(`SP#${i}: ${res.status} ${String(res.raw).slice(0, 120)}`); return; }
    const full = (await S.get(`/products/${res.json.id}`)).json;
    products.push({ id: res.json.id, ten });
    for (const v of full.variants ?? []) {
      variants.push({ id: v.id, price: Number(v.price_vnd), cost: von });
      // Tồn ban đầu qua API → sinh dòng sổ cái 'receive' đúng luật.
      await S.post(`/variants/${v.id}/inventory/adjust`, { delta: rint(12, 90), reason: 'nhập lô đầu' });
    }
    if (cats.length) await S.post(`/products/${res.json.id}/categories`, { category_ids: [pick(cats)] }).catch(() => {});
    if (++made % 25 === 0) console.log(`   … ${made} sản phẩm`);
  };
  const CHUNK = 6;
  for (let i = 0; i < 200; i += CHUNK) {
    await Promise.all(Array.from({ length: Math.min(CHUNK, 200 - i) }, (_, k) => mkOne(i + k)));
  }
  console.log(`   ✔ ${products.length} sản phẩm · ${variants.length} biến thể`);
  if (loi.length) { console.log(`   ⚠ ${loi.length} SP KHÔNG tạo được — ba ví dụ đầu:`); loi.slice(0, 3).forEach((x) => console.log('     ' + x)); }

  console.log('▶ 3/6  120 khách hàng');
  const khach = Array.from({ length: 120 }, (_, i) => ({
    ten: `${pick(HO)} ${pick(DEM)} ${pick(TEN)}`,
    sdt: `09${String(10000000 + i * 7919 % 89999999).padStart(8, '0')}`,
    tinh: pick(TINH),
    diaChi: `${rint(1, 250)} ${pick(DUONG)}`,
  }));

  console.log('▶ 4/6  ~400 đơn rải đều 60 ngày');
  // Phân bố trạng thái như shop thật: phần lớn đã giao, một ít đang chạy, vài đơn huỷ/trả.
  const TRANG_THAI = [
    ...Array(215).fill('delivered'), ...Array(55).fill('shipped'), ...Array(45).fill('confirmed'),
    ...Array(38).fill('pending'), ...Array(30).fill('cancelled'), ...Array(12).fill('returned'),
  ];
  const NGUON = [...Array(230).fill('web'), ...Array(85).fill('manual'), ...Array(60).fill('facebook'), ...Array(20).fill('zalo')];
  const c = await owner.connect();
  let soDon = 0, doanhThu = 0;
  try {
    await c.query('BEGIN');
    for (let n = 1; n <= TRANG_THAI.length; n++) {
      const status = TRANG_THAI[n - 1];
      // Ngày rải đều 60 ngày, đơn CŨ nằm ở trạng thái cuối, đơn MỚI còn đang chạy.
      const tuoi = status === 'pending' ? rint(0, 4)
        : status === 'confirmed' ? rint(1, 8)
        : status === 'shipped' ? rint(2, 14) : rint(3, 59);
      const taoLuc = `now() - interval '${tuoi} days' + interval '${rint(8, 21)} hours'`;
      const kh = pick(khach);
      const soDong = rint(1, 3);
      const dong = Array.from({ length: soDong }, () => {
        const v = pick(variants);
        return { v, qty: rint(1, 3) };
      });
      const subtotal = dong.reduce((s, d) => s + d.v.price * d.qty, 0);
      const ship = pick([0, 25000, 30000, 35000]);
      const giam = Math.random() < 0.12 ? Math.round(subtotal * 0.1 / 1000) * 1000 : 0;
      const total = subtotal + ship - giam;
      const pm = Math.random() < 0.72 ? 'cod' : 'qr';
      const daTra = status === 'delivered' || (status === 'returned') || (pm === 'qr' && ['shipped', 'confirmed'].includes(status));
      // ĐƠN HOÀN VỀ: hai kết cục KHÁC NHAU, và bịa gộp làm một là nói dối sổ.
      //   · đã hoàn tiền xong  → payment_status 'refunded' VÀ có phiếu hoàn đủ trong bảng refunds;
      //   · chưa hoàn (bom hàng đã trả trước) → vẫn 'paid', shop ĐANG GIỮ tiền của khách.
      // Bản trước đặt thẳng 'refunded' cho MỌI đơn returned mà không tạo phiếu nào — một hình
      // dạng mã sản phẩm KHÔNG BAO GIỜ sinh ra được (orders.js:1587 chỉ lật 'refunded' kèm phiếu
      // hoàn đủ). Hậu quả đo được: 13 đơn "đã hoàn" với 0₫ phiếu hoàn, tức 19,8 triệu nợ ảo mà
      // bất kỳ báo cáo công-nợ nào cũng sẽ tin.
      const daHoanXong = status === 'returned' && Math.random() < 0.55;
      const payStatus = daHoanXong ? 'refunded' : daTra ? 'paid' : 'unpaid';
      const o = await c.query(
        `INSERT INTO orders (shop_id, order_number, status, payment_status, subtotal_vnd, shipping_vnd, discount_vnd,
             total_vnd, amount_paid_vnd, payment_method, customer_name, customer_phone, customer_email,
             shipping_address, source, created_at, paid_at, shipped_at, delivered_at, cancelled_at, returned_at,
             lookup_token_hash, payment_ref, fulfillment_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, ${taoLuc},
           ${daTra ? `${taoLuc} + interval '${rint(1, 40)} hours'` : 'NULL'},
           ${['shipped', 'delivered', 'returned'].includes(status) ? `${taoLuc} + interval '${rint(20, 60)} hours'` : 'NULL'},
           ${['delivered', 'returned'].includes(status) ? `${taoLuc} + interval '${rint(20, 60)} hours' + interval '${rint(1, 4)} days'` : 'NULL'},
           ${status === 'cancelled' ? `${taoLuc} + interval '${rint(1, 30)} hours'` : 'NULL'},
           ${status === 'returned' ? `${taoLuc} + interval '${rint(7, 12)} days'` : 'NULL'},
           $16, $17, $18)
         RETURNING id`,
        [shopId, n, status, payStatus, subtotal, ship, giam, total, daTra ? total : 0, pm,
          kh.ten, kh.sdt, `${khongDau(kh.ten)}@email.vn`,
          { line: kh.diaChi, province: kh.tinh }, pick(NGUON),
          crypto.createHash('sha256').update(`seed-${shopId}-${n}`).digest('hex'),
          pm === 'qr' && daTra ? `SEED${shopId.slice(0, 6)}${n}` : null,
          ['delivered', 'returned'].includes(status) ? 'fulfilled' : status === 'shipped' ? 'fulfilled' : 'unfulfilled']);
      const orderId = o.rows[0].id;
      for (const d of dong) {
        await c.query(
          `INSERT INTO order_lines (shop_id, order_id, variant_id, title_snapshot, sku_snapshot, unit_price_vnd, qty, shipped_qty, unit_cost_vnd)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [shopId, orderId, d.v.id, 'Sản phẩm', 'SKU', d.v.price, d.qty,
            ['shipped', 'delivered', 'returned'].includes(status) ? d.qty : 0, d.v.cost]);
        // Đơn ĐÃ XUẤT thì kho phải giảm và sổ cái phải có dòng — nếu không, "tồn" trên màn
        // hình mâu thuẫn với "đã bán", và mọi phán đoán của tôi về màn kho đều vô giá trị.
        if (['shipped', 'delivered'].includes(status)) {
          await c.query(`UPDATE inventory_levels SET on_hand = greatest(0, on_hand - $2) WHERE variant_id=$1`, [d.v.id, d.qty]);
          await c.query(`INSERT INTO inventory_ledger (shop_id, variant_id, delta, kind, reason) VALUES ($1,$2,$3,'ship','giao đơn')`,
            [shopId, d.v.id, -d.qty]);
        }
      }
      // Phiếu hoàn THẬT cho đơn đã hoàn xong — để "đã hoàn" trên đơn và tổng trong bảng refunds
      // khớp nhau. Thiếu dòng này thì mọi con số công nợ đọc từ đây đều sai.
      if (daHoanXong) await c.query(
        `INSERT INTO refunds (shop_id, order_id, amount_vnd, reason, restock, kind, created_at)
         VALUES ($1,$2,$3,$4,true,'rma', ${taoLuc} + interval '${rint(8, 13)} days')`,
        [shopId, orderId, total, 'Khách trả hàng, đã hoàn tiền']);
      if (daTra) {
        doanhThu += total;
        // CHỈ đơn QR mới có dòng giao dịch: bảng này là sổ TIỀN VÀO TÀI KHOẢN (webhook SePay).
        // COD thu tay không đi qua đây — bịa ra một dòng 'received' cho COD là làm sai sổ và
        // mọi phán đoán của tôi về màn đối soát sẽ dựa trên một sự thật không có thật.
        if (pm === 'qr') await c.query(
          `INSERT INTO payment_transactions (shop_id, order_id, provider, provider_event_id, amount_vnd, status, created_at)
           VALUES ($1,$2,$3,$4,$5,'received', ${taoLuc} + interval '2 hours')`,
          [shopId, orderId, pm === 'cod' ? 'cod' : 'sepay', `seed-${shopId.slice(0, 8)}-${n}`, total]);
      }
      soDon++;
    }
    await c.query(
      `INSERT INTO shop_counters (shop_id, name, value) VALUES ($1,'order_number',$2)
       ON CONFLICT (shop_id, name) DO UPDATE SET value = EXCLUDED.value`, [shopId, TRANG_THAI.length]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  console.log(`   ✔ ${soDon} đơn · doanh thu đã thu ${new Intl.NumberFormat('vi-VN').format(doanhThu)}₫`);

  console.log('▶ 5/6  Đánh giá + tồn kho lệch (hiện trường thật luôn có)');
  // Vài SP hết hàng, vài SP sắp hết → màn cảnh báo tồn có việc để làm.
  await owner.query(
    `UPDATE inventory_levels SET on_hand = 0 WHERE variant_id IN (
       SELECT id FROM variants WHERE shop_id=$1 ORDER BY random() LIMIT 12)`, [shopId]);
  await owner.query(
    `UPDATE inventory_levels SET on_hand = floor(random()*4)::int WHERE variant_id IN (
       SELECT id FROM variants WHERE shop_id=$1 AND on_hand > 5 ORDER BY random() LIMIT 25)`, [shopId]);
  // ĐỔI on_hand thì PHẢI ghi dòng sổ cái tương ứng. Bỏ qua bước này thì màn "Sổ cái kho" mâu
  // thuẫn với màn "Tồn kho", và người đọc báo cáo sẽ tưởng phần mềm sai — trong khi lỗi là ở
  // chính bộ dựng hiện trường. (Đã vấp đúng thế: 28 biến thể lệch.)
  await owner.query(
    `INSERT INTO inventory_ledger (shop_id, variant_id, delta, kind, reason)
     SELECT $1, y.variant_id, y.on_hand - y.sc, 'adjust', 'kiểm kê thực tế'
       FROM (SELECT il.variant_id, il.on_hand, coalesce(sum(g.delta),0) AS sc
               FROM inventory_levels il JOIN variants v ON v.id = il.variant_id
               LEFT JOIN inventory_ledger g ON g.variant_id = il.variant_id
              WHERE v.shop_id = $1 GROUP BY 1,2) y
      WHERE y.on_hand <> y.sc`, [shopId]);
  await owner.query(
    `INSERT INTO product_reviews (shop_id, product_id, rating, content, author_name, status, created_at)
     SELECT $1, p.id, 3 + floor(random()*3)::int,
            (ARRAY['Hàng đẹp, đúng mô tả.','Giao nhanh, đóng gói kỹ.','Vải hơi mỏng nhưng ổn so với giá.',
                   'Shop tư vấn nhiệt tình.','Màu hơi khác ảnh một chút.'])[1+floor(random()*5)],
            'Khách ' || substr(md5(random()::text),1,4),
            CASE WHEN random() < 0.75 THEN 'approved' ELSE 'pending' END,
            now() - (random()*55 || ' days')::interval
       FROM products p WHERE p.shop_id=$1 ORDER BY random() LIMIT 90`, [shopId]).catch((e) => console.log('   (bỏ qua đánh giá:', e.message, ')'));

  console.log('▶ 6/6  Xong');
  const dem = await owner.query(
    `SELECT (SELECT count(*) FROM products WHERE shop_id=$1) sp,
            (SELECT count(*) FROM variants WHERE shop_id=$1) bt,
            (SELECT count(*) FROM orders WHERE shop_id=$1) don,
            (SELECT count(*) FROM orders WHERE shop_id=$1 AND payment_status='paid') tra,
            (SELECT count(DISTINCT customer_phone) FROM orders WHERE shop_id=$1) kh,
            (SELECT count(*) FROM inventory_ledger WHERE shop_id=$1) sc`, [shopId]);
  const d = dem.rows[0];
  console.log('\n══════════════════════════════════════════════');
  console.log(` shop_id : ${shopId}`);
  console.log(` slug    : ${slug}   (host: ${slug}.nentang.vn)`);
  console.log(` đăng nhập: ${email} / ${password}`);
  console.log(` dữ liệu : ${d.sp} SP · ${d.bt} biến thể · ${d.don} đơn (${d.tra} đã trả) · ${d.kh} SĐT · ${d.sc} dòng sổ cái kho`);
  console.log(` mất      : ${Math.round((Date.now() - t0) / 1000)} giây`);
  console.log('══════════════════════════════════════════════');
  await owner.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
