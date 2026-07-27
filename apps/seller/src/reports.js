/**
 * BÁO CÁO BÁN HÀNG + LỢI NHUẬN (0081) — perm 'reports.read' (CHỈ owner/admin: giá vốn/lãi
 * là bí mật kinh doanh; order_manager/catalog_manager bị 403 ở dispatcher).
 *
 * QUY TẮC SỔ CÁI (docs/36 — chốt qua thiết kế + 3 red-team):
 *  1. DOANH THU ghi tại orders.paid_at, điều kiện EVER-PAID (paid_at IS NOT NULL, KHÔNG lọc
 *     payment_status): refundOrder lật 'refunded' nhưng GIỮ paid_at → lọc theo payment_status
 *     làm đơn full-refund rớt ngược khỏi kỳ đã đóng. Doanh thu đứng yên ở ngày thu tiền.
 *  2. HOÀN TIỀN trừ tại NGÀY PHIẾU (refunds.created_at), trừ mọi phiếu TRỪ kind=
 *     'edit_adjustment' — phiếu chênh sửa-đơn-đã-trả đã phản ánh qua header đơn bị hạ
 *     (trừ thêm = trừ ĐÚP). Bất biến: Σ thuần = Σ(subtotal−discount ever-paid) − Σ refunds(kind≠edit_adjustment).
 *  3. DOANH THU HÀNG = subtotal_vnd − discount_vnd; THU SHIP (shipping_vnd) và PHÍ HÃNG
 *     (shipments.carrier_fee_vnd — BÁO GIÁ lúc tạo vận đơn) là 2 dòng riêng ngoài lãi gộp.
 *  4. COGS = Σ(qty × unit_cost_vnd snapshot) của đơn ever-paid trong kỳ; LOẠI đơn
 *     cancelled/refunded mà fulfillment='unfulfilled' (tiền đã hoàn/huỷ nhưng hàng CHƯA
 *     BAO GIỜ xuất kho → không có giá vốn thực — kẻo lãi gộp âm ảo). NULL cost = KHÔNG
 *     BIẾT, không tính (kèm độ phủ), tuyệt đối không coi 0 / không fallback cost hiện tại.
 *  5. ĐẢO COGS chỉ khi RMA restocked=true, tại ngày phiếu trả, theo snapshot return_lines.
 *  6. Múi giờ VN: bucket theo (ts AT TIME ZONE 'Asia/Ho_Chi_Minh'); điều kiện KHOẢNG đổi
 *     múi giờ ở THAM SỐ (sargable, ăn index 0081) — không áp AT TIME ZONE lên cột.
 */
import { send } from './http.js';
import { withTenant, audit } from './db.js';
import { toCsv } from './export.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const TZ = 'Asia/Ho_Chi_Minh';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;         // trần khoảng — khớp 1 năm dương lịch
const FORCE_MONTH_DAYS = 92;  // > 1 quý → tự gộp theo tháng (chart/bảng còn đọc được)
const n = (x) => Number(x ?? 0);

// Ngày "hôm nay" theo giờ VN (UTC+7, không DST).
const todayVN = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
// Ngày THẬT (chặn 2026-02-31 lọt regex → 22008 ở Postgres → 500): roundtrip qua Date UTC.
const realDate = (s) => { const d = new Date(s + 'T00:00:00Z'); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };
const addDays = (s, k) => new Date(Date.parse(s + 'T00:00:00Z') + k * 86400e3).toISOString().slice(0, 10);
// Số ngày của tháng (m 1-based) + tháng dương lịch liền trước một mốc 'YYYY-MM-DD'.
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const prevMonthOf = (s) => {
  let [y, m] = s.slice(0, 7).split('-').map(Number);
  m--; if (m < 1) { m = 12; y--; }
  return { y, m, pad: `${y}-${String(m).padStart(2, '0')}` };
};
// CHỌN NHANH KỲ — server tự sinh from/to. Phải ở SERVER vì client không diễn đạt được ý
// định "tháng" (tháng 28/29/30/31 ngày khác nhau) để chọn đúng kỳ so sánh.
const PRESETS = {
  today: (t) => ({ from: t, to: t }),
  '7d': (t) => ({ from: addDays(t, -6), to: t }),
  '30d': (t) => ({ from: addDays(t, -29), to: t }),
  mtd: (t) => ({ from: `${t.slice(0, 7)}-01`, to: t }),
  last_month: (t) => { const P = prevMonthOf(t); return { from: `${P.pad}-01`, to: `${P.pad}-${String(lastDayOf(P.y, P.m)).padStart(2, '0')}` }; },
};

// KỲ LIỀN TRƯỚC để so sánh. Kỳ THÁNG → tháng dương lịch liền trước (KHÔNG trừ N ngày, vì
// tháng dài ngắn khác nhau). Còn lại → cùng số ngày, sát ngay trước `from`.
// group giữ NGUYÊN của kỳ hiện tại: để parseRange ép lại có thể ra group khác → so lệch.
function prevRange({ from, to, group, preset }) {
  const wholeMonth = from.slice(8) === '01' && from.slice(0, 7) === to.slice(0, 7);
  if (preset === 'mtd' || preset === 'last_month' || wholeMonth) {
    const P = prevMonthOf(from);
    const L = lastDayOf(P.y, P.m);
    // Kỳ đang xem có TRỌN tháng không (đến hết ngày cuối của chính tháng đó)?
    const curLast = lastDayOf(Number(from.slice(0, 4)), Number(from.slice(5, 7)));
    const isFullMonth = Number(to.slice(8)) === curLast;
    // TRỌN THÁNG → so với TRỌN tháng trước. Nếu chỉ clamp theo ngày như nhánh dưới thì
    // tháng NGẮN so với tháng DÀI sẽ cắt cụt kỳ trước (xem tháng 2 → chỉ so 01–28/01,
    // bỏ mất 29–31/01) → % tăng trưởng bịa ra.
    // DỞ DANG (mtd, vd hôm nay 15/3) → so cùng số ngày đầu tháng trước (01–15/02), có
    // clamp cho tháng ngắn hơn (31/03 → 28/02).
    const d = isFullMonth ? L : Math.min(Number(to.slice(8)), L);
    return { from: `${P.pad}-01`, to: `${P.pad}-${String(d).padStart(2, '0')}`, group };
  }
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400e3) + 1;
  const pt = addDays(from, -1);
  return { from: addDays(pt, -(days - 1)), to: pt, group };
}

// Validate + chuẩn hoá tham số kỳ. Trả {error} hoặc {from,to,group,days,preset}.
function parseRange(query) {
  // Preset lạ → BỎ QUA (không 400): BFF render trang lỗi TOÀN PHẦN khi status ≠ 200, người
  // dùng sẽ mất luôn trang Báo cáo chỉ vì gõ sai 1 tham số trên URL.
  const pk = query.get('preset');
  const preset = Object.hasOwn(PRESETS, pk ?? '') ? pk : null;
  const P = preset ? PRESETS[preset](todayVN()) : null;
  const to = P ? P.to : (query.get('to') ?? todayVN());
  const from = P ? P.from : (query.get('from') ?? addDays(to, -29)); // mặc định 30 ngày kết thúc hôm nay VN
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return { error: 'ngày không hợp lệ (YYYY-MM-DD)' };
  if (!realDate(from) || !realDate(to)) return { error: 'ngày không tồn tại trên lịch' };
  if (from > to) return { error: 'từ-ngày phải ≤ đến-ngày' };
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400e3) + 1;
  if (days > MAX_DAYS) return { error: `khoảng tối đa ${MAX_DAYS} ngày` };
  let group = query.get('group') === 'month' ? 'month' : 'day';
  if (days > FORCE_MONTH_DAYS) group = 'month'; // ép — response range.group phản ánh
  return { from, to, group, days, preset };
}

// Mảnh SQL bucket theo múi giờ VN cho một cột timestamptz — CHỈ dùng ở SELECT/GROUP BY
// (WHERE giữ sargable trên cột thuần). KHÔNG nội suy giá trị người dùng.
const bucketSql = (col, group) => group === 'month'
  ? `to_char(date_trunc('month', ${col} AT TIME ZONE '${TZ}'), 'YYYY-MM')`
  : `to_char((${col} AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD')`;
// Điều kiện khoảng sargable: $i=from, $i+1=to (date). [00:00 from VN, 00:00 to+1 VN).
const rangeSql = (col, i) => `${col} >= ($${i}::date::timestamp AT TIME ZONE '${TZ}') AND ${col} < (($${i + 1}::date + 1)::timestamp AT TIME ZONE '${TZ}')`;
// COGS: loại đơn đã huỷ/hoàn mà hàng CHƯA BAO GIỜ xuất kho (quy tắc 4).
const COGS_ORDER_GUARD = `NOT (o.status IN ('cancelled','refunded') AND o.fulfillment_status = 'unfulfilled')`;
// Sort bảng sản phẩm: ALLOWLIST → mảnh SQL cố định (không nội suy query param).
const SORT_SQL = {
  revenue: 'revenue DESC, qty DESC',
  qty: 'qty DESC, revenue DESC',
  profit: 'profit DESC NULLS LAST, revenue DESC', // dòng thiếu cost (profit NULL) xuống cuối
};

// Lấp bucket trống (chart không nhảy cóc): sinh danh sách bucket từ from→to theo group.
function bucketList(from, to, group) {
  const out = [];
  if (group === 'month') {
    let [y, m] = from.slice(0, 7).split('-').map(Number);
    const end = to.slice(0, 7);
    for (;;) {
      const b = `${y}-${String(m).padStart(2, '0')}`;
      out.push(b);
      if (b === end) break;
      m++; if (m > 12) { m = 1; y++; }
    }
  } else {
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  }
  return out;
}

// Lõi tính toán — dùng chung cho JSON lẫn CSV. Chạy trong withTenant (RLS).
async function computeSales(shopId, { from, to, group, sort }) {
  return withTenant(shopId, async (c) => {
    const B = (col) => bucketSql(col, group);
    // (1) Header đơn ever-paid theo bucket paid_at.
    const q1 = (await c.query(
      `SELECT ${B('o.paid_at')} AS bucket, count(*)::int AS orders_paid,
              sum(o.subtotal_vnd - o.discount_vnd)::bigint AS revenue_goods,
              sum(o.shipping_vnd)::bigint AS shipping_income
         FROM orders o WHERE ${rangeSql('o.paid_at', 1)} GROUP BY 1`, [from, to])).rows;
    // (2) COGS + độ phủ giá vốn — CÙNG CƠ SỞ DÒNG (đừng trộn header có coupon: pct >100% ảo).
    const q2 = (await c.query(
      `SELECT ${B('o.paid_at')} AS bucket,
              coalesce(sum(l.qty * l.unit_cost_vnd)  FILTER (WHERE l.unit_cost_vnd IS NOT NULL), 0)::bigint AS cogs,
              coalesce(sum(l.qty * l.unit_price_vnd) FILTER (WHERE l.unit_cost_vnd IS NOT NULL), 0)::bigint AS rev_with_cost,
              coalesce(sum(l.qty * l.unit_price_vnd) FILTER (WHERE l.unit_cost_vnd IS NULL), 0)::bigint AS rev_missing_cost,
              count(*) FILTER (WHERE l.unit_cost_vnd IS NULL)::int AS lines_missing_cost
         FROM orders o JOIN order_lines l ON l.order_id = o.id
        WHERE ${rangeSql('o.paid_at', 1)} AND ${COGS_ORDER_GUARD} GROUP BY 1`, [from, to])).rows;
    // (3) Phiếu hoàn tại ngày phiếu — LOẠI edit_adjustment (quy tắc 2); chỉ đơn từng paid
    //     (phiếu trên đơn chưa thu tiền — COD quên bấm nhận — không trừ doanh thu chưa ghi).
    const q3 = (await c.query(
      `SELECT ${B('r.created_at')} AS bucket, sum(r.amount_vnd)::bigint AS refunds
         FROM refunds r JOIN orders o ON o.id = r.order_id AND o.paid_at IS NOT NULL
        WHERE ${rangeSql('r.created_at', 1)} AND r.kind <> 'edit_adjustment' GROUP BY 1`, [from, to])).rows;
    // (4) Đảo COGS: RMA restock tại ngày phiếu trả, theo snapshot return_lines.
    const q4 = (await c.query(
      `SELECT ${B('r.created_at')} AS bucket,
              coalesce(sum(rl.qty * rl.unit_cost_vnd) FILTER (WHERE rl.unit_cost_vnd IS NOT NULL), 0)::bigint AS cogs_reversal
         FROM returns r JOIN return_lines rl ON rl.return_id = r.id
         JOIN orders o ON o.id = r.order_id AND o.paid_at IS NOT NULL
        WHERE r.restocked = true AND ${rangeSql('r.created_at', 1)} GROUP BY 1`, [from, to])).rows;
    // (5) Phí hãng (BÁO GIÁ vận đơn) tại ngày tạo vận đơn — bỏ vận đơn đã huỷ.
    const q5 = (await c.query(
      `SELECT ${B('s.created_at')} AS bucket, sum(s.carrier_fee_vnd)::bigint AS carrier_fee
         FROM shipments s
        WHERE s.carrier_fee_vnd IS NOT NULL AND s.status <> 'cancelled' AND ${rangeSql('s.created_at', 1)} GROUP BY 1`, [from, to])).rows;
    // (6) Lãi theo sản phẩm (gộp snapshot title/sku). profit NULL khi CÓ dòng thiếu cost
    //     (không bịa 0). LIMIT 101 → cờ truncated (top 100).
    const q6 = (await c.query(
      `SELECT * FROM (
         SELECT l.title_snapshot AS title, l.sku_snapshot AS sku,
                sum(l.qty)::int AS qty,
                sum(l.qty * l.unit_price_vnd)::bigint AS revenue,
                coalesce(sum(l.qty * l.unit_cost_vnd) FILTER (WHERE l.unit_cost_vnd IS NOT NULL), 0)::bigint AS cogs,
                bool_or(l.unit_cost_vnd IS NULL) AS has_missing_cost,
                CASE WHEN bool_or(l.unit_cost_vnd IS NULL) THEN NULL
                     ELSE sum(l.qty * (l.unit_price_vnd - l.unit_cost_vnd))::bigint END AS profit
           FROM orders o JOIN order_lines l ON l.order_id = o.id
          WHERE ${rangeSql('o.paid_at', 1)} AND ${COGS_ORDER_GUARD}
          GROUP BY 1, 2
       ) t ORDER BY ${SORT_SQL[sort]} LIMIT 101`, [from, to])).rows;
    return { q1, q2, q3, q4, q5, q6 };
  }).then(({ q1, q2, q3, q4, q5, q6 }) => {
    const idx = (rows) => new Map(rows.map((r) => [r.bucket, r]));
    const m1 = idx(q1), m2 = idx(q2), m3 = idx(q3), m4 = idx(q4), m5 = idx(q5);
    const series = bucketList(from, to, group).map((b) => {
      const a = m1.get(b), g = m2.get(b), r = m3.get(b), v = m4.get(b), s = m5.get(b);
      const revenue_goods = n(a?.revenue_goods), refunds = n(r?.refunds);
      const cogs = n(g?.cogs), reversal = n(v?.cogs_reversal);
      const shipping = n(a?.shipping_income), fee = n(s?.carrier_fee);
      const net = revenue_goods - refunds;
      const gross = net - cogs + reversal;
      return {
        bucket: b, orders_paid: n(a?.orders_paid),
        revenue_goods_vnd: revenue_goods, refunds_vnd: refunds, net_revenue_vnd: net,
        cogs_vnd: cogs, cogs_reversal_vnd: reversal, gross_profit_vnd: gross,
        shipping_income_vnd: shipping, carrier_fee_vnd: fee,
        operating_profit_vnd: gross + shipping - fee,
      };
    });
    const T = (k) => series.reduce((s, r) => s + r[k], 0);
    const withC = q2.reduce((s, r) => s + n(r.rev_with_cost), 0);
    const missC = q2.reduce((s, r) => s + n(r.rev_missing_cost), 0);
    const linesMiss = q2.reduce((s, r) => s + n(r.lines_missing_cost), 0);
    const totals = {
      orders_paid: T('orders_paid'),
      revenue_goods_vnd: T('revenue_goods_vnd'), refunds_vnd: T('refunds_vnd'), net_revenue_vnd: T('net_revenue_vnd'),
      cogs_vnd: T('cogs_vnd'), cogs_reversal_vnd: T('cogs_reversal_vnd'), gross_profit_vnd: T('gross_profit_vnd'),
      shipping_income_vnd: T('shipping_income_vnd'), carrier_fee_vnd: T('carrier_fee_vnd'),
      operating_profit_vnd: T('operating_profit_vnd'),
      cost_coverage: {
        revenue_with_cost_vnd: withC, revenue_missing_cost_vnd: missC, lines_missing_cost: linesMiss,
        pct: (withC + missC) > 0 ? Math.round((withC / (withC + missC)) * 100) : 100, // kỳ 0 doanh thu → 100 (không 0/0)
      },
    };
    const by_product = q6.slice(0, 100).map((t) => ({
      title: t.title, sku: t.sku, qty: n(t.qty), revenue_vnd: n(t.revenue),
      cogs_vnd: t.has_missing_cost ? null : n(t.cogs),
      profit_vnd: t.profit == null ? null : n(t.profit),
      margin_pct: (t.profit == null || n(t.revenue) <= 0) ? null : Math.round((n(t.profit) / n(t.revenue)) * 100),
      has_missing_cost: t.has_missing_cost === true,
    }));
    return { series, totals, by_product, products_truncated: q6.length > 100 };
  });
}

// GET /shops/:id/reports/sales — JSON cho trang Báo cáo.
async function salesReport(res, ctx, _b, _p, query) {
  const R = parseRange(query);
  if (R.error) return send(res, 400, { error: R.error });
  // Object.hasOwn, KHÔNG `SORT_SQL[x] ? …` — bản cũ để ?sort=constructor / __proto__ lọt
  // (truthy vì kế thừa từ Object.prototype) rồi nội suy chuỗi rác vào ORDER BY → 500.
  const sortKey = query.get('sort');
  const sort = Object.hasOwn(SORT_SQL, sortKey ?? '') ? sortKey : 'revenue';
  const data = await computeSales(ctx.shopId, { ...R, sort });
  // So sánh kỳ trước BẬT mặc định (?compare=off để tắt). Gọi computeSales lần 2 trên kỳ
  // trước — AN TOÀN dù là transaction riêng: kỳ trước KẾT THÚC trước ngày `from`, mà mọi
  // bút toán mới đều mang mốc now() (thuộc kỳ hiện tại) nên kỳ trước là bất biến.
  // CHỈ lấy `totals`: số bucket 2 kỳ có thể khác nhau khi group='month' (vd 100 ngày ra 5
  // bucket, 100 ngày liền trước ra 4) → ghép series theo chỉ số mảng là sai.
  let previous = null;
  if (query.get('compare') !== 'off') {
    const RP = prevRange(R);
    const prev = await computeSales(ctx.shopId, { ...RP, sort });
    previous = { range: { from: RP.from, to: RP.to, group: RP.group }, totals: prev.totals };
  }
  return send(res, 200, {
    range: { from: R.from, to: R.to, group: R.group },
    preset: R.preset ?? null, sort, compare: previous != null, previous, ...data,
  });
}

// GET /shops/:id/reports/export?type=pnl|products — CSV thẳng (aggregate nhỏ, không cần
// vòng token/MinIO của export ZIP). Perm 'export' + step-up (chính sách "Xuất dữ liệu").
async function exportReport(res, ctx, _b, _p, query) {
  const R = parseRange(query);
  if (R.error) return send(res, 400, { error: R.error });
  const type = query.get('type') === 'products' ? 'products' : 'pnl';
  const data = await computeSales(ctx.shopId, { ...R, sort: 'revenue' });
  let csv;
  if (type === 'products') {
    csv = toCsv(
      ['title', 'sku', 'qty', 'revenue_vnd', 'cogs_vnd', 'profit_vnd', 'margin_pct'],
      data.by_product.map((p) => ({ ...p })),
    );
  } else {
    csv = toCsv(
      ['bucket', 'orders_paid', 'revenue_goods_vnd', 'refunds_vnd', 'net_revenue_vnd', 'cogs_vnd',
       'cogs_reversal_vnd', 'gross_profit_vnd', 'shipping_income_vnd', 'carrier_fee_vnd', 'operating_profit_vnd'],
      [...data.series, { bucket: 'TOTAL', orders_paid: data.totals.orders_paid, revenue_goods_vnd: data.totals.revenue_goods_vnd, refunds_vnd: data.totals.refunds_vnd, net_revenue_vnd: data.totals.net_revenue_vnd, cogs_vnd: data.totals.cogs_vnd, cogs_reversal_vnd: data.totals.cogs_reversal_vnd, gross_profit_vnd: data.totals.gross_profit_vnd, shipping_income_vnd: data.totals.shipping_income_vnd, carrier_fee_vnd: data.totals.carrier_fee_vnd, operating_profit_vnd: data.totals.operating_profit_vnd }],
    );
  }
  await withTenant(ctx.shopId, (c) =>
    audit(c, 'report.exported', { actorId: ctx.user.id, ip: ctx.ip, metadata: { type, from: R.from, to: R.to } }));
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="bao-cao-${type}-${R.from}-${R.to}.csv"`,
  });
  return res.end(csv);
}

export const REPORT_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/reports/sales$`), perm: 'reports.read', fn: (res, ctx, b, p, q) => salesReport(res, ctx, b, p, q) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/reports/export$`), perm: 'export', stepUp: true, fn: (res, ctx, b, p, q) => exportReport(res, ctx, b, p, q) },
];
