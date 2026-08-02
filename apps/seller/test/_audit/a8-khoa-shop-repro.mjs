/**
 * DỰNG LẠI: shop hết hạn bị KHOÁ BÁN, trả tiền xong có tự MỞ LẠI không?
 *
 * Đợt quét chỉ ra sweepSubscriptions khoá shop mà KHÔNG đóng dấu suspended_at, trong khi
 * đường mở khoá (sweepBillingApply) đòi `suspended_at IS NOT NULL`. Đọc mã thì thấy
 * sweepBillingEnforce VẪN đóng dấu hộ ngay cả khi nó không phải kẻ khoá — nên nhận định
 * "khoá vĩnh viễn" có thể nói quá. Chỉ có chạy thật mới biết.
 *
 * Ca 1 — cấu hình MẶC ĐỊNH (hai ân hạn cùng 7 ngày): khoá rồi trả tiền → có mở lại không?
 * Ca 2 — mô phỏng ân hạn LỆCH NHAU (sub 3 ngày, billing 14 ngày): tức là chỉ
 *         sweepSubscriptions kịp khoá, sweepBillingEnforce chưa tới lượt. Đây là cấu hình
 *         hợp lệ (hai biến môi trường ĐỘC LẬP) — mô phỏng bằng cách chỉ chạy sweep thứ nhất.
 * env: AUDIT_SLUG
 */
import { WORKER, owner, http, ok, warn, bad, sect, summary, uniq } from './lib.mjs';

const q1 = async (sql, a) => (await owner.query(sql, a)).rows[0];
const sweepSub = () => http(WORKER, '/internal/subscription-sweep', { method: 'POST', body: {} });
const sweepBilling = () => http(WORKER, '/internal/billing-sweep', { method: 'POST', body: {} });

async function dungShopHetHan(nhan) {
  const slug = `het-han-${uniq()}`;
  const shop = await q1(
    `INSERT INTO shops (name, slug, status) VALUES ($1, $2, 'active') RETURNING id`, [nhan, slug]);
  const plan = await q1(`SELECT code FROM plans WHERE active ORDER BY price_vnd_month LIMIT 1`);
  await owner.query(
    `INSERT INTO subscriptions (shop_id, plan_code, status, current_period_end)
     VALUES ($1, $2, 'active', now() - interval '30 days')`, [shop.id, plan.code]);
  return { id: shop.id, slug, plan: plan.code };
}

async function main() {
  // ── Ca 1: hai ân hạn BẰNG NHAU (mặc định) — chạy CẢ HAI sweep như worker thật ────
  sect('Ca 1 — cấu hình mặc định: khoá rồi trả tiền, có mở lại không?');
  const s1 = await dungShopHetHan('Shop het han A');
  await sweepSub(); await sweepBilling();
  let sh = await q1(`SELECT status FROM shops WHERE id=$1`, [s1.id]);
  let sub = await q1(`SELECT status, suspended_at, suspended_from FROM subscriptions WHERE shop_id=$1`, [s1.id]);
  sh.status === 'suspended' ? ok(`shop bị khoá bán (sub=${sub.status}, dấu suspended_at=${sub.suspended_at ? 'CÓ' : 'KHÔNG'}, từ=${sub.suspended_from ?? 'null'})`)
    : bad(`shop KHÔNG bị khoá dù quá hạn 30 ngày`, JSON.stringify({ sh, sub }));

  // Shop trả tiền: tạo phiếu thu đã trả (đúng như webhook SePay nền tảng ghi) rồi cho worker áp.
  await owner.query(
    `INSERT INTO billing_charges (shop_id, plan_code, months, amount_vnd, status, paid_at, pay_ref, expires_at)
     VALUES ($1, $2, 1, 199000, 'paid', now(), $3, now() + interval '1 day')`, [s1.id, s1.plan, `SUB${uniq().toUpperCase().slice(0, 10).padEnd(10, '0')}`]);
  await sweepBilling();
  sh = await q1(`SELECT status FROM shops WHERE id=$1`, [s1.id]);
  sub = await q1(`SELECT status, current_period_end > now() AS con_han FROM subscriptions WHERE shop_id=$1`, [s1.id]);
  sh.status === 'suspended'
    ? bad(`TRẢ TIỀN RỒI VẪN BỊ KHOÁ BÁN — shop mất doanh thu, không đường tự mở`, `shop=${sh.status} sub=${sub.status} còn hạn=${sub.con_han}`)
    : ok(`trả tiền → mở lại bán (shop=${sh.status}, sub=${sub.status}, còn hạn=${sub.con_han})`);

  // ── Ca 2: chỉ sweepSubscriptions kịp khoá (ân hạn sub NGẮN HƠN billing) ─────────
  sect('Ca 2 — hai ân hạn LỆCH NHAU: chỉ sweep thuê bao kịp khoá, sweep tiền chưa tới lượt');
  const s2 = await dungShopHetHan('Shop het han B');
  await sweepSub();                       // ← CHỈ sweep này, không chạy billing-sweep
  sh = await q1(`SELECT status FROM shops WHERE id=$1`, [s2.id]);
  sub = await q1(`SELECT status, suspended_at FROM subscriptions WHERE shop_id=$1`, [s2.id]);
  sh.status === 'suspended' && !sub.suspended_at
    ? warn(`shop bị khoá NHƯNG KHÔNG có dấu suspended_at (sub=${sub.status}) — đường mở khoá đòi dấu này`)
    : ok(`shop=${sh.status}, dấu=${sub.suspended_at ? 'CÓ' : 'KHÔNG'}`);

  await owner.query(
    `INSERT INTO billing_charges (shop_id, plan_code, months, amount_vnd, status, paid_at, pay_ref, expires_at)
     VALUES ($1, $2, 1, 199000, 'paid', now(), $3, now() + interval '1 day')`, [s2.id, s2.plan, `SUB${uniq().toUpperCase().slice(0, 10).padEnd(10, '0')}`]);
  await sweepBilling();                   // áp phiếu + (enforce cũng chạy trong endpoint này)
  sh = await q1(`SELECT status FROM shops WHERE id=$1`, [s2.id]);
  sub = await q1(`SELECT status, suspended_at, current_period_end > now() AS con_han FROM subscriptions WHERE shop_id=$1`, [s2.id]);
  sh.status === 'suspended'
    ? bad(`TRẢ TIỀN RỒI VẪN BỊ KHOÁ (ca ân hạn lệch)`, `shop=${sh.status} sub=${sub.status} còn hạn=${sub.con_han} dấu=${sub.suspended_at ? 'CÓ' : 'KHÔNG'}`)
    : ok(`trả tiền → mở lại bán kể cả khi thiếu dấu (shop=${sh.status}, còn hạn=${sub.con_han})`);

  console.log(`\n  → shop A=${s1.slug} B=${s2.slug}`);
  summary();
  await owner.end();
}
main().catch((e) => { console.error('VỠ:', e); process.exit(2); });
