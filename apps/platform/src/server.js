/**
 * Dịch vụ platform (ops) — nghiệp vụ vận hành nền tảng cho NHÂN VIÊN NỀN TẢNG.
 *
 * Tạo shop, sinh subdomain, chọn gói, mời owner, khoá/mở shop.
 *
 * Hai nguyên tắc bảo mật (docs/03), mỗi cái có test:
 *   1. Role DB app_platform KHÔNG có quyền trên bảng nghiệp vụ (products, orders,
 *      carts...). "Platform không mặc định xem dữ liệu khách mua." Kiểm bằng test:
 *      app_platform SELECT orders → lỗi quyền.
 *   2. Mọi endpoint /ops đòi: (a) phiên hợp lệ, (b) là platform_staff, (c) đã bật MFA.
 *      MFA bắt buộc cho nhân viên nền tảng.
 *
 * Xác thực phiên qua INTROSPECTION: gọi auth /auth/me với cookie được chuyển tiếp.
 * app_platform cố tình KHÔNG đọc được bảng sessions (chỉ auth service đọc) — giữ
 * bán kính ảnh hưởng hẹp. Đánh đổi: một lượt gọi nội bộ mỗi request (chấp nhận ở
 * quy mô pilot). Trong monolith đích, đây chỉ là một lời gọi hàm.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import { readJson, send, originAllowed, clientIp } from './http.js';
import { runReq, makeLog, health } from './obs.js';

const PORT = Number(process.env.PORT ?? 3030);
const AUTH_URL = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? 'nentang.vn';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const INVITE_TTL_DAYS = 7;
// Base URL trang CHẤP NHẬN LỜI MỜI công khai (seller-admin /invite/accept) — mirror
// RESET_LINK_BASE của auth (0058): dịch vụ giữ token thô dựng link đầy đủ, worker chỉ
// dán vào email. Trỏ origin TRÌNH DUYỆT tới được, KHÔNG phải URL nội bộ.
const INVITE_LINK_BASE = process.env.INVITE_LINK_BASE ?? 'https://admin.nentang.vn/invite/accept';
// Thời gian dùng thử — LUÔN đặt current_period_end lúc tạo shop, nếu không thì
// sweepSubscriptions (lọc IS NOT NULL) bỏ qua vĩnh viễn = shop miễn phí mãi mãi.
// NaN/âm → 0 = không trial (hết hạn ngay ở nhịp sweep kế). Đồng bộ với migration 0056.
const TRIAL_DAYS = Math.max(0, Number(process.env.TRIAL_DAYS ?? 14) || 0);

if (ALLOWED_ORIGINS.length === 0) {
  throw new Error('thiếu ALLOWED_ORIGINS — mọi mutation sẽ bị từ chối');
}

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

const log = makeLog('platform');

const genToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

async function audit(action, { shopId = null, actorId = null, ip = null, metadata = null } = {}) {
  await db
    .query(
      `INSERT INTO audit_logs (shop_id, actor_type, actor_id, action, ip, metadata)
       VALUES ($1, 'platform_staff', $2, $3, $4, $5)`,
      [shopId, actorId, action, ip, metadata],
    )
    .catch((err) => log('error', 'audit_failed', { action, message: err.message }));
}

/**
 * Xác thực phiên bằng cách hỏi auth service. Trả về user (đã qua MFA) hoặc null.
 * Chuyển tiếp nguyên cookie của request tới auth /auth/me.
 */
async function introspect(cookieHeader) {
  if (!cookieHeader) return null;
  try {
    const res = await fetch(`${AUTH_URL}/auth/me`, {
      headers: { cookie: cookieHeader },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null; // 401 (chưa đăng nhập / phiên nửa vời) → null
    return await res.json(); // {id, email, mfa_enabled, memberships, stepped_up_at}
  } catch (err) {
    log('error', 'introspect_failed', { message: err.message });
    return null; // fail-closed
  }
}

/**
 * Yêu cầu: phiên hợp lệ + là platform_staff + đã bật MFA.
 * Trả về {user, staffRole} hoặc gửi lỗi và trả null.
 *
 * platform_staff.role có HAI mức (0006, CHECK operator|admin):
 *   - 'operator': chỉ ĐỌC — danh sách/chi tiết shop, plans, metrics (nhân viên
 *     vận hành xem số liệu, không đụng tiền/trạng thái).
 *   - 'admin'   : thêm các route GHI/PHÁ HOẠI/TIỀN — tạo shop, mời owner,
 *     suspend/restore/terminate, ghi nhận thu, xuất dữ liệu offboard.
 * Gate nằm ở dispatch (route.minRole, cạnh gate stepUp): operator gọi route
 * admin → 403 {error:'cần quyền admin nền tảng'}.
 */
// Step-up 5 phút cho thao tác PHÁ HOẠI của staff (mirror seller server.js): phiên
// staff bị chiếm/ẩu không khoá được shop đang trả phí hay ghi hoá đơn mà không gõ
// lại mật khẩu. /auth/me đã trả stepped_up_at sẵn — platform chỉ việc ĐỌC.
const STEP_UP_WINDOW_MS = 5 * 60_000;
function steppedUpRecently(me) {
  if (!me?.stepped_up_at) return false;
  return Date.now() - new Date(me.stepped_up_at).getTime() < STEP_UP_WINDOW_MS;
}

async function requireStaff(req, res) {
  const me = await introspect(req.headers.cookie);
  if (!me) {
    send(res, 401, { error: 'chưa đăng nhập hoặc chưa qua MFA' });
    return null;
  }
  // MFA bắt buộc cho nhân viên nền tảng — không thoả hiệp.
  if (!me.mfa_enabled) {
    send(res, 403, { error: 'nhân viên nền tảng phải bật MFA' });
    return null;
  }
  const { rows } = await db.query('SELECT role FROM platform_staff WHERE user_id = $1', [me.id]);
  if (rows.length === 0) {
    send(res, 403, { error: 'không phải nhân viên nền tảng' });
    return null;
  }
  return { user: me, staffRole: rows[0].role };
}

// ── validation ───────────────────────────────────────────────────────────────
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/; // dns-safe, <= 40 ký tự
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ['owner', 'admin', 'catalog_manager', 'order_manager'];

// ── handlers ─────────────────────────────────────────────────────────────────

async function createShop(req, res, body, staff, ip) {
  const name = String(body.name ?? '').trim();
  const slug = String(body.slug ?? '').toLowerCase().trim();
  const planCode = String(body.plan_code ?? '').trim();
  const locale = String(body.locale ?? 'vi-VN').trim();
  const currency = String(body.currency ?? 'VND').toUpperCase().trim();
  const timezone = String(body.timezone ?? 'Asia/Ho_Chi_Minh').trim();

  if (!name || name.length > 200) return send(res, 400, { error: 'tên shop không hợp lệ' });
  if (!SLUG_RE.test(slug)) return send(res, 400, { error: 'slug không hợp lệ (a-z, 0-9, gạch ngang)' });

  const plan = await db.query('SELECT code FROM plans WHERE code = $1 AND active', [planCode]);
  if (plan.rows.length === 0) return send(res, 400, { error: 'gói dịch vụ không hợp lệ' });

  const subdomain = `${slug}.${PLATFORM_DOMAIN}`;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const shop = await client.query(
      `INSERT INTO shops (slug, name, status, locale, currency, timezone)
       VALUES ($1, $2, 'onboarding', $3, $4, $5) RETURNING id`,
      [slug, name, locale, currency, timezone],
    );
    const shopId = shop.rows[0].id;

    // Subdomain nền tảng: tự sở hữu nên verified ngay (khác custom domain của khách).
    await client.query(
      `INSERT INTO domains (shop_id, hostname, verification_token, verified_at, is_primary)
       VALUES ($1, $2, $3, now(), true)`,
      [shopId, subdomain, genToken()],
    );

    await client.query(
      `INSERT INTO subscriptions (shop_id, plan_code, status, current_period_end)
       VALUES ($1, $2, 'trial', now() + ($3 || ' days')::interval)`,
      [shopId, planCode, String(TRIAL_DAYS)],
    );

    await client.query(
      `INSERT INTO audit_logs (shop_id, actor_type, actor_id, action, ip, metadata)
       VALUES ($1, 'platform_staff', $2, 'shop.created', $3, $4)`,
      [shopId, staff.user.id, ip, { slug, plan_code: planCode }],
    );
    await client.query('COMMIT');

    log('info', 'shop_created', { shopId, slug });
    return send(res, 201, { id: shopId, slug, subdomain, status: 'onboarding' });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return send(res, 409, { error: 'slug hoặc subdomain đã tồn tại' });
    throw err;
  } finally {
    client.release();
  }
}

// Phân trang 50/trang + tìm (?q= ILIKE name/slug) + lọc (?sub_status=). Trước đây
// LIMIT 200 cứng — quá 200 shop là danh sách "mù". total đếm CÙNG điều kiện lọc.
// staff_role trả kèm (đã có sẵn từ requireStaff — 0 truy vấn thêm) để Console
// ẩn nút admin-only với operator; gate THẬT vẫn là minRole ở dispatch.
const SHOPS_PAGE_SIZE = 50;
const SUB_STATUSES = ['trial', 'active', 'past_due', 'cancelled'];
// Trần trang: xem chú thích ở listSupportTickets — cùng một lý do, cùng một khuôn.
const MAX_PAGE = 1e5;

async function listShops(req, res, staff) {
  const url = new URL(req.url, 'http://internal');
  const page = Math.min(MAX_PAGE, Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1));
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
  const subStatus = (url.searchParams.get('sub_status') ?? '').trim();
  const where = ['s.deleted_at IS NULL'];
  const args = [];
  if (q) {
    // Escape ký tự đặc biệt của LIKE — người dùng gõ '%' phải khớp NGHĨA ĐEN.
    args.push(`%${q.replace(/[\\%_]/g, (ch) => '\\' + ch)}%`);
    where.push(`(s.name ILIKE $${args.length} OR s.slug ILIKE $${args.length})`);
  }
  if (SUB_STATUSES.includes(subStatus)) {
    args.push(subStatus);
    where.push(`sub.status = $${args.length}`);
  }
  // Lọc "chưa có sản phẩm": nhóm cần gọi điện giúp. Trước đây console không phân biệt được
  // shop mở 10 ngày chưa đăng gì với shop đang bán tốt — nhìn y hệt nhau, chỉ khác cột đã-thu
  // bằng 0. Không thấy thì không giúp được ai.
  //
  // ĐỌC CỜ shops.first_product_at, KHÔNG đếm bảng products. Bản đầu tôi viết
  // `NOT EXISTS (SELECT 1 FROM products ...)` và test bắt ngay: app_platform CỐ TÌNH không có
  // quyền trên bảng nghiệp vụ (nguyên tắc #1 ở đầu file — "platform không mặc định xem dữ liệu
  // khách mua", có test canh). Cấp thêm quyền để tiện hiển thị là phá đúng ranh giới đó; đưa
  // MỘT CỜ lên bảng shops thì console biết ai đang mắc kẹt mà vẫn không nhìn thấy hàng hoá.
  const activity = url.searchParams.get('activity') ?? '';
  if (activity === 'noproduct') where.push(`s.first_product_at IS NULL`);
  // subscriptions UNIQUE(shop_id) từ 0065 → LEFT JOIN không nhân dòng, COUNT chuẩn.
  const whereSql = where.join(' AND ');
  const [list, total] = await Promise.all([
    db.query(
      `SELECT s.id, s.slug, s.name, s.status, s.created_at,
              d.hostname AS subdomain, sub.plan_code, sub.status AS sub_status,
              (SELECT COALESCE(SUM(pi.amount_vnd), 0)::bigint
                 FROM platform_invoices pi WHERE pi.shop_id = s.id) AS total_collected_vnd,
              s.first_product_at
         FROM shops s
         LEFT JOIN domains d ON d.shop_id = s.id AND d.is_primary
         LEFT JOIN subscriptions sub ON sub.shop_id = s.id
        WHERE ${whereSql}
        ORDER BY s.created_at DESC
        LIMIT ${SHOPS_PAGE_SIZE} OFFSET ${(page - 1) * SHOPS_PAGE_SIZE}`,
      args,
    ),
    db.query(
      `SELECT COUNT(*)::int AS n
         FROM shops s LEFT JOIN subscriptions sub ON sub.shop_id = s.id
        WHERE ${whereSql}`,
      args,
    ),
  ]);
  return send(res, 200, {
    shops: list.rows,
    page,
    page_size: SHOPS_PAGE_SIZE,
    total: total.rows[0].n,
    has_more: page * SHOPS_PAGE_SIZE < total.rows[0].n,
    staff_role: staff.staffRole,
    activity,
  });
}

async function getShop(req, res, shopId, staff) {
  const { rows } = await db.query(
    `SELECT s.id, s.slug, s.name, s.status, s.locale, s.currency, s.timezone, s.created_at,
            d.hostname AS subdomain, sub.plan_code, sub.status AS sub_status, sub.current_period_end
       FROM shops s
       LEFT JOIN domains d ON d.shop_id = s.id AND d.is_primary
       LEFT JOIN subscriptions sub ON sub.shop_id = s.id
      WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [shopId],
  );
  if (rows.length === 0) return send(res, 404, { error: 'không tìm thấy shop' });
  // Lịch sử thu + tổng đã thu (sổ platform_invoices) — thuần bổ sung vào payload.
  const [inv, tot] = await Promise.all([
    db.query(
      `SELECT id, plan_code, months, amount_vnd, note, created_at
         FROM platform_invoices WHERE shop_id = $1
        ORDER BY created_at DESC LIMIT 50`,
      [shopId],
    ),
    db.query(
      `SELECT COALESCE(SUM(amount_vnd), 0)::bigint AS total, COUNT(*)::int AS n
         FROM platform_invoices WHERE shop_id = $1`,
      [shopId],
    ),
  ]);
  return send(res, 200, {
    ...rows[0],
    invoices: inv.rows,
    invoice_total_vnd: tot.rows[0].total,
    invoice_count: tot.rows[0].n,
    staff_role: staff.staffRole, // Console ẩn nút admin-only với operator (gate thật ở dispatch)
  });
}

// Danh sách gói đang bán — cho Console render select gói từ DB (giết giá hardcode ở BFF).
async function listPlans(req, res) {
  const { rows } = await db.query(
    'SELECT code, name, price_vnd_month, max_products FROM plans WHERE active ORDER BY price_vnd_month',
  );
  return send(res, 200, { plans: rows });
}

// Số liệu điều hành cho trang chủ Console — CHỈ đọc các bảng quản lý app_platform
// đã có quyền (plans/subscriptions/shops/platform_invoices, 0006/0061). Không đụng
// dữ liệu khách mua. 6 truy vấn song song, mỗi cái đều nhỏ (bảng quản lý ~trăm dòng).
async function getMetrics(req, res) {
  const [mrr, byStatus, byPlan, byMonth, expiring, churn, collected, tickets] = await Promise.all([
    // MRR = tổng giá gói/tháng của thuê bao đang TÍNH TIỀN (active + past_due —
    // past_due vẫn là doanh thu định kỳ đang đòi, chưa mất). Trial/cancelled không tính.
    db.query(
      `SELECT COALESCE(SUM(p.price_vnd_month), 0)::bigint AS mrr
         FROM subscriptions s
         JOIN plans p ON p.code = s.plan_code
         JOIN shops sh ON sh.id = s.shop_id
        WHERE s.status IN ('active','past_due') AND sh.deleted_at IS NULL`,
    ),
    db.query(
      `SELECT s.status, COUNT(*)::int AS n
         FROM subscriptions s JOIN shops sh ON sh.id = s.shop_id
        WHERE sh.deleted_at IS NULL GROUP BY s.status`,
    ),
    db.query(
      `SELECT s.plan_code, COUNT(*)::int AS n
         FROM subscriptions s JOIN shops sh ON sh.id = s.shop_id
        WHERE s.status IN ('active','past_due') AND sh.deleted_at IS NULL
        GROUP BY s.plan_code ORDER BY s.plan_code`,
    ),
    // 12 tháng gần nhất, LẤP THÁNG TRỐNG bằng generate_series (tháng không thu = 0đ,
    // biểu đồ không bị "co" mất tháng). COUNT(pi.id) chứ không COUNT(*) — LEFT JOIN
    // tháng trống vẫn ra 1 dòng NULL.
    db.query(
      `SELECT to_char(m.month, 'YYYY-MM') AS month,
              COALESCE(SUM(pi.amount_vnd), 0)::bigint AS amount_vnd,
              COUNT(pi.id)::int AS invoices
         FROM generate_series(date_trunc('month', now()) - interval '11 months',
                              date_trunc('month', now()), interval '1 month') AS m(month)
         LEFT JOIN platform_invoices pi ON date_trunc('month', pi.created_at) = m.month
        GROUP BY m.month ORDER BY m.month`,
    ),
    db.query(
      `SELECT sh.id, sh.name, s.plan_code, s.status AS sub_status, s.current_period_end
         FROM subscriptions s JOIN shops sh ON sh.id = s.shop_id
        WHERE s.status IN ('trial','active')
          AND s.current_period_end IS NOT NULL
          AND s.current_period_end < now() + interval '7 days'
          AND sh.deleted_at IS NULL
        ORDER BY s.current_period_end LIMIT 20`,
    ),
    // CHURN ~90 ngày — từ 0072 có cancelled_at (mốc huỷ THẬT, worker/terminate ghi).
    // Dòng huỷ TRƯỚC 0072 (cancelled_at NULL) vẫn phải ước lượng qua current_period_end
    // đóng băng (proxy cũ, lệch đúng khoảng ân hạn) — TÁCH RIÊNG hai con số, không trộn.
    db.query(
      `SELECT COUNT(*) FILTER (WHERE cancelled_at >= now() - interval '90 days')::int AS exact,
              COUNT(*) FILTER (WHERE cancelled_at IS NULL
                                 AND current_period_end >= now() - interval '90 days')::int AS legacy
         FROM subscriptions WHERE status = 'cancelled'`,
    ),
    // Đã thu 30 ngày (cửa sổ trượt, khác revenue_by_month theo tháng lịch) + tổng đã thu.
    db.query(
      `SELECT COALESCE(SUM(amount_vnd) FILTER (WHERE created_at >= now() - interval '30 days'), 0)::bigint AS d30,
              COALESCE(SUM(amount_vnd), 0)::bigint AS total
         FROM platform_invoices`,
    ),
    // Phiếu hỗ trợ đang chờ + cái CŨ NHẤT (0108). Con số đứng cạnh MRR là cố ý: hàng đợi hỗ
    // trợ dài là một chỉ số kinh doanh, không phải việc vặt — nó báo trước churn tháng sau.
    db.query(
      `SELECT COUNT(*)::int AS open, MIN(created_at) AS oldest
         FROM support_tickets WHERE status = 'open'`,
    ),
  ]);
  const statusCounts = { trial: 0, active: 0, past_due: 0, cancelled: 0 };
  for (const r of byStatus.rows) statusCounts[r.status] = r.n;
  return send(res, 200, {
    mrr_vnd: mrr.rows[0].mrr,
    shops_by_sub_status: statusCounts,
    shops_by_plan: byPlan.rows,
    revenue_by_month: byMonth.rows,
    expiring_soon: expiring.rows,
    // Hai con số TÁCH BẠCH: churn_90d = mốc huỷ thật (cancelled_at, 0072);
    // legacy_estimate = dòng huỷ trước 0072 (không có mốc) vẫn ước lượng theo kỳ.
    // Cờ is_estimate chỉ còn true khi bức tranh CÒN phần ước lượng (legacy > 0).
    churn_90d: churn.rows[0].exact,
    churn_90d_legacy_estimate: churn.rows[0].legacy,
    churn_90d_is_estimate: churn.rows[0].legacy > 0,
    collected_30d_vnd: collected.rows[0].d30,
    collected_total_vnd: collected.rows[0].total,
    open_tickets: tickets.rows[0].open,
    oldest_open_ticket_at: tickets.rows[0].oldest,
  });
}

// Ghi nhận đã THU thuê bao: sub → active + gia hạn kỳ (từ mốc lớn hơn giữa now và kỳ cũ,
// cộng dồn), đổi gói nếu chọn, và MỞ LẠI shop nếu đang suspended (guard: chỉ suspended→active,
// KHÔNG un-terminate). Thu tiền THỦ CÔNG (chưa cổng recurring) — đúng mô hình concierge.
// Mỗi lần thu = MỘT dòng platform_invoices trong CÙNG transaction (sổ thu — không được
// có gia hạn mà thiếu hoá đơn hoặc ngược lại). amount mặc định = giá gói HIỆU LỰC × months;
// ghi đè thủ công qua body.amount_vnd cho deal thương lượng (note ghi lý do).
async function renewSubscription(req, res, shopId, staff, ip, body) {
  const months = Math.min(Math.max(parseInt(body.months ?? '1', 10) || 1, 1), 24);
  const planCode = body.plan_code ? String(body.plan_code).trim() : null;
  if (planCode) {
    const p = await db.query('SELECT code FROM plans WHERE code = $1 AND active', [planCode]);
    if (p.rows.length === 0) return send(res, 400, { error: 'gói dịch vụ không hợp lệ' });
  }
  // Ghi đè số tiền (deal thương lượng): chỉ nhận số nguyên an toàn 0..2 tỷ.
  let override = null;
  if (body.amount_vnd !== undefined && body.amount_vnd !== null && String(body.amount_vnd).trim() !== '') {
    override = Number(body.amount_vnd);
    if (!Number.isSafeInteger(override) || override < 0 || override > 2_000_000_000) {
      return send(res, 400, { error: 'số tiền không hợp lệ' });
    }
  }
  const note = body.note ? String(body.note).trim().slice(0, 500) || null : null;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Gói HIỆU LỰC (gói ghi đè nếu có, không thì gói hiện tại) + giá — đọc trong CÙNG tx
    // để không race với đổi gói song song.
    const sub = await client.query(
      `SELECT COALESCE($2::text, s.plan_code) AS plan_code, p.price_vnd_month
         FROM subscriptions s JOIN plans p ON p.code = COALESCE($2::text, s.plan_code)
        WHERE s.shop_id = $1`,
      [shopId, planCode],
    );
    if (sub.rows.length === 0) { await client.query('ROLLBACK'); return send(res, 404, { error: 'không tìm thấy thuê bao của shop' }); }
    const effPlan = sub.rows[0].plan_code;
    // pg trả bigint dạng string → Number() tường minh (max 5.9M×24 = 141.6M, an toàn).
    const amount = override ?? Number(sub.rows[0].price_vnd_month) * months;
    // cancelled_at = NULL: sub huỷ mà chủ shop quay lại trả tiền = HẾT churn —
    // giữ mốc cũ sẽ đếm nhầm sub đang active vào churn_90d (0072).
    await client.query(
      `UPDATE subscriptions SET status = 'active',
              cancelled_at = NULL,
              plan_code = COALESCE($2, plan_code),
              current_period_end = GREATEST(COALESCE(current_period_end, now()), now()) + ($3 || ' months')::interval
        WHERE shop_id = $1`,
      [shopId, planCode, String(months)],
    );
    await client.query(`UPDATE shops SET status = 'active' WHERE id = $1 AND status = 'suspended'`, [shopId]);
    await client.query(
      `INSERT INTO platform_invoices (shop_id, plan_code, months, amount_vnd, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [shopId, effPlan, months, amount, note, staff.user.id],
    );
    await client.query(
      `INSERT INTO audit_logs (shop_id, actor_type, actor_id, action, ip, metadata)
       VALUES ($1, 'platform_staff', $2, 'subscription.renewed', $3, $4)`,
      [shopId, staff.user.id, ip, { months, plan_code: effPlan, amount_vnd: amount, override: override !== null }],
    );
    await client.query('COMMIT');
    return send(res, 200, { ok: true, months, amount_vnd: amount, plan_code: effPlan });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function inviteOwner(req, res, body, staff, shopId, ip) {
  const email = String(body.email ?? '').toLowerCase().trim();
  const role = String(body.role ?? 'owner').trim();
  if (!EMAIL_RE.test(email)) return send(res, 400, { error: 'email không hợp lệ' });
  if (!ROLES.includes(role)) return send(res, 400, { error: 'vai trò không hợp lệ' });

  const shop = await db.query(`SELECT id, name FROM shops WHERE id = $1 AND deleted_at IS NULL`, [shopId]);
  if (shop.rows.length === 0) return send(res, 404, { error: 'không tìm thấy shop' });

  const token = genToken();
  // ADR-006 (mirror auth forgot 0058): invitation + outbox trong MỘT transaction —
  // không bao giờ có lời mời mà không email, hay email mà không lời mời.
  // Token thô CHỈ đi qua email người ĐƯỢC MỜI (token = bằng chứng sở hữu email);
  // API không trả token cho người mời nữa. Grant/policy outbox của app_platform: 0073.
  const client = await db.connect();
  let inv;
  try {
    await client.query('BEGIN');
    inv = (await client.query(
      `INSERT INTO invitations (shop_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval) RETURNING id, expires_at`,
      [shopId, email, role, hashToken(token), staff.user.id, String(INVITE_TTL_DAYS)],
    )).rows[0];
    await client.query(
      `INSERT INTO outbox (shop_id, topic, payload) VALUES ($1, 'user.invited', $2)`,
      [shopId, { to: email, shop_name: shop.rows[0].name, role, accept_url: `${INVITE_LINK_BASE}?token=${token}`, expires_days: INVITE_TTL_DAYS }],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await audit('invitation.created', { shopId, actorId: staff.user.id, ip, metadata: { email, role } });

  // KHÔNG trả token: token là bằng chứng sở hữu email của NGƯỜI ĐƯỢC MỜI —
  // trả cho người mời là phá bất biến đó (người mời chiếm được tài khoản mời).
  return send(res, 201, {
    invitation_id: inv.id,
    email,
    email_sent: true,
    expires_at: inv.expires_at,
  });
}

async function setShopStatus(req, res, shopId, action, staff, ip, body) {
  // suspend: onboarding/active → suspended. restore: suspended → active.
  // KHÔNG bao giờ xoá dữ liệu (cam kết hợp đồng).
  let sql;
  let auditAction;
  if (action === 'suspend') {
    sql = `UPDATE shops SET status = 'suspended'
            WHERE id = $1 AND status IN ('onboarding','active') AND deleted_at IS NULL`;
    auditAction = 'shop.suspended';
  } else {
    sql = `UPDATE shops SET status = 'active'
            WHERE id = $1 AND status = 'suspended' AND deleted_at IS NULL`;
    auditAction = 'shop.restored';
  }
  const r = await db.query(sql, [shopId]);
  if (r.rowCount === 0) {
    return send(res, 409, { error: 'shop không ở trạng thái cho phép thao tác này' });
  }
  await audit(auditAction, { shopId, actorId: staff.user.id, ip, metadata: { reason: body?.reason ?? null } });
  return send(res, 200, { ok: true, status: action === 'suspend' ? 'suspended' : 'active' });
}

// ── Chấm dứt hợp đồng (offboard) — admin + step-up ───────────────────────────
// Nghĩa vụ "xuất dữ liệu rồi đóng" (Luật 91/2025): quy trình là suspend (giai đoạn
// nguội) → GET export → terminate. Guard tường minh:
//   * CHỈ shop đang 'suspended' — không đóng thẳng shop đang chạy (409).
//   * body.confirm_slug phải GÕ ĐÚNG slug của shop (typed confirmation, 422).
// Hiệu ứng: shops.status='terminated' + deleted_at=now(); thuê bao → cancelled
// + cancelled_at=now() (0072). Serving DỪNG TỰ NHIÊN qua các chốt sẵn có, KHÔNG
// cần đụng domains (suspend cũng không đụng domains — nó phục vụ trang tạm ngưng):
//   * storefront: policy store_shop (0011) loại terminated/deleted → 404.
//   * checkout:  policy checkout_shop (0012) loại terminated/suspended → 404.
//   * tls-authorize: SQL loại terminated + deleted_at → ngừng cấp/gia hạn chứng chỉ.
// KHÔNG xoá dữ liệu (cam kết hợp đồng) — dòng domains giữ nguyên nên slug/subdomain
// không tái sử dụng được (chủ đích: tránh kẻ khác chiếm subdomain shop cũ).
async function terminateShop(req, res, shopId, staff, ip, body) {
  const confirm = String(body.confirm_slug ?? '').trim();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE: khoá dòng để guard trạng thái + confirm slug không race với
    // suspend/restore/terminate song song.
    const cur = await client.query(
      `SELECT slug, status FROM shops WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [shopId]);
    if (cur.rows.length === 0) { await client.query('ROLLBACK'); return send(res, 404, { error: 'không tìm thấy shop' }); }
    const { slug, status } = cur.rows[0];
    if (status !== 'suspended') {
      await client.query('ROLLBACK');
      return send(res, 409, { error: 'chỉ chấm dứt được shop đang tạm khoá (tạm khoá trước để có giai đoạn nguội)' });
    }
    if (confirm !== slug) {
      await client.query('ROLLBACK');
      return send(res, 422, { error: 'gõ đúng slug của shop để xác nhận chấm dứt' });
    }
    await client.query(`UPDATE shops SET status = 'terminated', deleted_at = now() WHERE id = $1`, [shopId]);
    // Huỷ thuê bao CÒN HIỆU LỰC. Sub đã cancelled từ trước: GIỮ nguyên (mốc huỷ
    // thật là lúc sweep huỷ, không phải lúc terminate — không ghi đè/bịa mốc).
    await client.query(
      `UPDATE subscriptions SET status = 'cancelled', cancelled_at = now()
        WHERE shop_id = $1 AND status <> 'cancelled'`, [shopId]);
    await client.query(
      `INSERT INTO audit_logs (shop_id, actor_type, actor_id, action, ip, metadata)
       VALUES ($1, 'platform_staff', $2, 'shop.terminated', $3, $4)`,
      [shopId, staff.user.id, ip, { slug, reason: body?.reason ?? null }],
    );
    await client.query('COMMIT');
    log('info', 'shop_terminated', { shopId, slug });
    return send(res, 200, { ok: true, status: 'terminated' });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Xuất dữ liệu offboard (admin) — GET /ops/shops/:id/export ────────────────
// PHẠM VI TRUNG THỰC: chỉ dữ liệu QUẢN LÝ mà app_platform vốn được đọc (0006/0061/
// 0072): shop, domains, thuê bao, sổ thu, lời mời, nhân sự, nhật ký. Dữ liệu
// NGHIỆP VỤ (sản phẩm/đơn/khách) app_platform CỐ TÌNH không đọc được — nguyên tắc
// "platform không xem dữ liệu khách mua" (0006). KHÔNG đục lỗ RLS ở đây; bản xuất
// nghiệp vụ ĐẦY ĐỦ do CHỦ SHOP tự chạy qua seller POST /shops/:id/export (ZIP CSV
// toàn bộ, đã có từ A4) — ghi rõ trong trường tenant_data_note của bản xuất.
// Mỗi mục cap 10k dòng + cờ truncated (không stream cả sổ khổng lồ qua JSON).
// Cố ý KHÔNG lọc deleted_at: xuất được cả shop ĐÃ terminated (bằng chứng hậu đóng).
const EXPORT_ROW_CAP = 10_000;
async function exportShop(req, res, shopId) {
  const shop = await db.query(`SELECT * FROM shops WHERE id = $1`, [shopId]);
  if (shop.rows.length === 0) return send(res, 404, { error: 'không tìm thấy shop' });
  // Mỗi mục lấy cap+1 để biết còn dòng bị cắt hay không.
  const capped = async (sql, args) => {
    const { rows } = await db.query(`${sql} LIMIT ${EXPORT_ROW_CAP + 1}`, args);
    const truncated = rows.length > EXPORT_ROW_CAP;
    return { rows: truncated ? rows.slice(0, EXPORT_ROW_CAP) : rows, truncated };
  };
  const [domains, subs, invoices, invitations, members, auditLogs] = await Promise.all([
    // domains: KHÔNG xuất verification_token (bí mật xác minh).
    capped(`SELECT hostname, is_primary, verified_at, created_at FROM domains WHERE shop_id = $1 ORDER BY created_at`, [shopId]),
    capped(`SELECT plan_code, status, started_at, current_period_end, cancelled_at, created_at FROM subscriptions WHERE shop_id = $1 ORDER BY created_at`, [shopId]),
    capped(`SELECT plan_code, months, amount_vnd, note, created_by, created_at FROM platform_invoices WHERE shop_id = $1 ORDER BY created_at`, [shopId]),
    // invitations: KHÔNG xuất token_hash.
    capped(`SELECT email, role, invited_by, expires_at, accepted_at, created_at FROM invitations WHERE shop_id = $1 ORDER BY created_at`, [shopId]),
    capped(`SELECT user_id, role, created_at FROM memberships WHERE shop_id = $1 ORDER BY created_at`, [shopId]),
    capped(`SELECT action, actor_type, actor_id, ip, metadata, created_at FROM audit_logs WHERE shop_id = $1 ORDER BY created_at DESC`, [shopId]),
  ]);
  return send(res, 200, {
    exported_at: new Date().toISOString(),
    tenant_data_note:
      'Bản xuất này CHỈ gồm dữ liệu quản lý nền tảng (shop, tên miền, thuê bao, sổ thu, lời mời, nhân sự, nhật ký). '
      + 'Dữ liệu nghiệp vụ (sản phẩm, đơn hàng, khách hàng) nền tảng cố tình KHÔNG đọc được — '
      + 'chủ shop tự xuất đầy đủ qua trang Xuất dữ liệu của quản trị shop (ZIP CSV) trước khi chấm dứt.',
    shop: shop.rows[0],
    domains: domains.rows,
    subscriptions: subs.rows,
    platform_invoices: invoices.rows,
    invitations: invitations.rows,
    memberships: members.rows,
    audit_logs: auditLogs.rows,
    truncated: {
      domains: domains.truncated,
      subscriptions: subs.truncated,
      platform_invoices: invoices.truncated,
      invitations: invitations.truncated,
      memberships: members.truncated,
      audit_logs: auditLogs.truncated,
    },
  });
}

// ── hàng đợi phiếu hỗ trợ (0107/0108) ────────────────────────────────────────
// Chủ nền tảng nhận Telegram khi có phiếu mới, nhưng Telegram KHÔNG phải hàng đợi: không
// biết cái nào đã xử, không tra lại được, cuộn qua là mất. Đây là hàng đợi thật.
const TICKETS_PAGE_SIZE = 20;

/**
 * Danh sách phiếu XUYÊN SHOP. Policy platform_all (0107) cho phép; RLS vẫn bật.
 *
 * Thứ tự CỐ Ý khác nhau theo tab:
 *   open     → created_at TĂNG DẦN (FIFO). Hàng đợi hỗ trợ xếp mới-trước sẽ bỏ đói đúng
 *              người đã chờ lâu nhất — cũng là người sắp bỏ đi.
 *   resolved → resolved_at GIẢM DẦN: đang xem lại việc vừa làm.
 *
 * Kèm gói + trạng thái thuê bao: phiếu của shop ĐANG TRẢ TIỀN không giống phiếu của một bản
 * dùng thử mở hôm qua, và console không nên bắt mở tab khác mới biết mình đang nói với ai.
 */
async function listSupportTickets(req, res) {
  const url = new URL(req.url, 'http://internal');
  // CHẶN TRÊN cho page. OFFSET nội suy thẳng vào chuỗi SQL (an toàn vì luôn là số, nhưng
  // không tham số hoá): `?page=99999999999999999999` cho 1e20 → OFFSET vượt bigint →
  // Postgres 'bigint out of range' → 500 cho một tham số rác. Trần cũng chặn quét sâu:
  // OFFSET lớn buộc Postgres đọc rồi VỨT đúng bấy nhiêu dòng.
  const page = Math.min(MAX_PAGE, Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1));
  const status = url.searchParams.get('status') === 'resolved' ? 'resolved' : 'open';
  const order = status === 'open' ? 't.created_at ASC' : 't.resolved_at DESC NULLS LAST';
  // Lọc theo SHOP hoặc theo nội dung phiếu, CÙNG MỘT Ô. Chủ nền tảng đang tìm thì trong đầu
  // họ là "cái vụ của shop Sofa" hoặc "cái vụ GHN" — bắt chọn đúng loại trước khi gõ là bắt
  // họ dịch câu hỏi của mình sang cấu trúc dữ liệu của ta.
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
  const args = [status];
  let qSql = '';
  if (q) {
    // Escape ký tự đặc biệt của LIKE — gõ '%' phải khớp NGHĨA ĐEN (khuôn của listShops).
    args.push(`%${q.replace(/[\\%_]/g, (ch) => '\\' + ch)}%`);
    qSql = ' AND (s.name ILIKE $2 OR s.slug ILIKE $2 OR t.subject ILIKE $2)';
  }
  const [list, counts] = await Promise.all([
    db.query(
      `SELECT t.id, t.shop_id, t.subject, t.body, t.context_url, t.status, t.from_email,
              t.created_at, t.resolved_at, t.resolution_note, t.diag,
              s.name AS shop_name, s.slug AS shop_slug, s.status AS shop_status,
              sub.plan_code, sub.status AS sub_status
         FROM support_tickets t
         JOIN shops s ON s.id = t.shop_id
         LEFT JOIN subscriptions sub ON sub.shop_id = t.shop_id
        WHERE t.status = $1${qSql}
        ORDER BY ${order}
        LIMIT ${TICKETS_PAGE_SIZE + 1} OFFSET ${(page - 1) * TICKETS_PAGE_SIZE}`,
      args,
    ),
    // Số đếm trên TAB luôn là TỔNG, KHÔNG theo bộ lọc: nó là "còn bao nhiêu việc", không phải
    // "tìm được bao nhiêu". Cho nó nhảy theo ô tìm là làm mất đúng con số người ta đang canh.
    db.query(`SELECT status, COUNT(*)::int AS n FROM support_tickets GROUP BY status`),
  ]);
  const rows = list.rows.slice(0, TICKETS_PAGE_SIZE);
  const byStatus = Object.fromEntries(counts.rows.map((r) => [r.status, r.n]));
  return send(res, 200, {
    tickets: rows,
    status,
    page,
    q,
    has_more: list.rows.length > TICKETS_PAGE_SIZE,
    counts: { open: byStatus.open ?? 0, resolved: byStatus.resolved ?? 0 },
  });
}

/**
 * Đánh dấu ĐÃ XỬ LÝ + đóng vòng phản hồi về người bán.
 *
 * IDEMPOTENT nhờ guard status='open': bấm hai lần (F5, hai nhân viên cùng mở) chỉ đổi trạng
 * thái MỘT lần → chỉ MỘT outbox → người bán không nhận hai email cho cùng một phiếu. Lần thứ
 * hai trả {already:true} chứ không 409: người bấm không làm gì sai, và kết quả họ muốn đã đạt.
 *
 * Outbox CÙNG TRANSACTION (ADR-006): không có phiếu đã đóng mà người bán không hay biết.
 * payload.to lấy từ t.from_email đã chép sẵn trên phiếu — console không có quyền đọc users.
 */
async function resolveTicket(req, res, ticketId, staff, ip, body) {
  const note = String(body?.note ?? '').trim().slice(0, 2000) || null;
  const client = await db.connect();
  let t;
  try {
    await client.query('BEGIN');
    t = (await client.query(
      `UPDATE support_tickets
          SET status = 'resolved', resolved_at = now(), resolved_by = $2, resolution_note = $3
        WHERE id = $1 AND status = 'open'
        RETURNING shop_id, subject, from_email`,
      [ticketId, staff.user.id, note],
    )).rows[0];
    if (t) {
      await client.query(
        `INSERT INTO outbox (shop_id, topic, payload) VALUES ($1, 'support.ticket_resolved', $2)`,
        [t.shop_id, { ticket_id: ticketId, subject: t.subject, note, to: t.from_email }],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (!t) {
    const ex = await db.query(`SELECT status FROM support_tickets WHERE id = $1`, [ticketId]);
    if (!ex.rows[0]) return send(res, 404, { error: 'không tìm thấy phiếu' });
    return send(res, 200, { ok: true, already: true, status: ex.rows[0].status });
  }
  await audit('support.ticket_resolved', { shopId: t.shop_id, actorId: staff.user.id, ip, metadata: { ticketId, noted: Boolean(note) } });
  return send(res, 200, { ok: true, status: 'resolved' });
}

// Mở lại phiếu đóng nhầm/đóng sớm. KHÔNG báo lại người bán (không có gì mới để nói) và XOÁ
// ghi chú cũ — giữ lại nghĩa là để một lời giải thích không còn đúng nằm trên phiếu đang mở.
// Thiếu đường này thì "đã xử lý" là ngõ cụt, và người ta sẽ né không dám bấm.
async function reopenTicket(req, res, ticketId, staff, ip) {
  const r = await db.query(
    `UPDATE support_tickets
        SET status = 'open', resolved_at = NULL, resolved_by = NULL, resolution_note = NULL
      WHERE id = $1 AND status = 'resolved' RETURNING shop_id`,
    [ticketId],
  );
  if (r.rowCount === 0) {
    const ex = await db.query(`SELECT status FROM support_tickets WHERE id = $1`, [ticketId]);
    if (!ex.rows[0]) return send(res, 404, { error: 'không tìm thấy phiếu' });
    return send(res, 200, { ok: true, already: true, status: ex.rows[0].status });
  }
  await audit('support.ticket_reopened', { shopId: r.rows[0].shop_id, actorId: staff.user.id, ip, metadata: { ticketId } });
  return send(res, 200, { ok: true, status: 'open' });
}

// ── router ───────────────────────────────────────────────────────────────────
const SHOP_ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const TICKET_ID = SHOP_ID;
// minRole:'admin' = route GHI/PHÁ HOẠI/TIỀN — operator chỉ được các route đọc
// (list/detail/plans/metrics). Xem docstring requireStaff. stepUp = gõ lại mật
// khẩu trong 5' (đợt 4.4). export là GET đọc-only nhưng dump cả sổ quản lý →
// vẫn khoá admin (operator không cần mang được dữ liệu ra ngoài).
const ROUTES = [
  { m: 'POST', re: /^\/ops\/shops$/, minRole: 'admin', fn: (req, res, b, s, ip) => createShop(req, res, b, s, ip) },
  { m: 'GET', re: /^\/ops\/shops$/, fn: (req, res, b, s) => listShops(req, res, s) },
  { m: 'GET', re: /^\/ops\/plans$/, fn: (req, res) => listPlans(req, res) },
  { m: 'GET', re: /^\/ops\/metrics$/, fn: (req, res) => getMetrics(req, res) },
  { m: 'GET', re: new RegExp(`^/ops/shops/${SHOP_ID}$`), fn: (req, res, b, s, ip, p) => getShop(req, res, p[0], s) },
  { m: 'GET', re: new RegExp(`^/ops/shops/${SHOP_ID}/export$`), minRole: 'admin', fn: (req, res, b, s, ip, p) => exportShop(req, res, p[0]) },
  { m: 'POST', re: new RegExp(`^/ops/shops/${SHOP_ID}/invitations$`), minRole: 'admin', fn: (req, res, b, s, ip, p) => inviteOwner(req, res, b, s, p[0], ip) },
  { m: 'POST', re: new RegExp(`^/ops/shops/${SHOP_ID}/suspend$`), minRole: 'admin', stepUp: true, fn: (req, res, b, s, ip, p) => setShopStatus(req, res, p[0], 'suspend', s, ip, b) },
  { m: 'POST', re: new RegExp(`^/ops/shops/${SHOP_ID}/restore$`), minRole: 'admin', stepUp: true, fn: (req, res, b, s, ip, p) => setShopStatus(req, res, p[0], 'restore', s, ip, b) },
  { m: 'POST', re: new RegExp(`^/ops/shops/${SHOP_ID}/subscription/renew$`), minRole: 'admin', stepUp: true, fn: (req, res, b, s, ip, p) => renewSubscription(req, res, p[0], s, ip, b) },
  // Phiếu hỗ trợ CỐ Ý không khoá minRole:'admin'. Trả lời hỗ trợ chính là việc của operator;
  // bắt phải là admin nghĩa là chỉ chủ nền tảng trả lời được — đúng cái nút cổ chai ta đang gỡ.
  // Thao tác cũng không phá hoại: đổi một nhãn, và đã có đường mở lại.
  { m: 'GET', re: /^\/ops\/support$/, fn: (req, res) => listSupportTickets(req, res) },
  { m: 'POST', re: new RegExp(`^/ops/support/${TICKET_ID}/resolve$`), fn: (req, res, b, s, ip, p) => resolveTicket(req, res, p[0], s, ip, b) },
  { m: 'POST', re: new RegExp(`^/ops/support/${TICKET_ID}/reopen$`), fn: (req, res, b, s, ip, p) => reopenTicket(req, res, p[0], s, ip) },
  { m: 'POST', re: new RegExp(`^/ops/shops/${SHOP_ID}/terminate$`), minRole: 'admin', stepUp: true, fn: (req, res, b, s, ip, p) => terminateShop(req, res, p[0], s, ip, b) },
];

const server = http.createServer((req, res) => runReq(req, res, async () => {
  const url = new URL(req.url, 'http://internal');
  if (await health(url.pathname, res, { db: () => db.query('SELECT 1') })) return;

  const route = ROUTES.find((r) => r.m === req.method && r.re.test(url.pathname));
  if (!route) return send(res, 404, { error: 'không tìm thấy' });

  if (!originAllowed(req, ALLOWED_ORIGINS)) return send(res, 403, { error: 'origin không được phép' });

  try {
    const staff = await requireStaff(req, res);
    if (!staff) return; // requireStaff đã gửi lỗi
    // Cổng VAI TRÒ trước cổng step-up: operator bị chặn vì THIẾU QUYỀN, không phải
    // thiếu xác thực — không bắt gõ lại mật khẩu rồi mới báo "không đủ quyền".
    if (route.minRole === 'admin' && staff.staffRole !== 'admin') {
      return send(res, 403, { error: 'cần quyền admin nền tảng' });
    }
    // Cổng step-up SAU requireStaff (chỉ staff thật mới thấy cờ step_up_required —
    // non-staff nhận 403 thường từ requireStaff, không lộ sự tồn tại của cổng).
    if (route.stepUp && !steppedUpRecently(staff.user)) {
      return send(res, 403, { error: 'step_up_required', step_up_required: true });
    }

    const params = route.re.exec(url.pathname).slice(1);
    const body = req.method === 'GET' ? {} : await readJson(req);
    await route.fn(req, res, body, staff, clientIp(req), params);
  } catch (err) {
    const status = err.statusCode ?? 500;
    if (status >= 500) log('error', 'handler_error', { path: url.pathname, message: err.message, stack: err.stack });
    if (!res.headersSent) send(res, status, { error: status >= 500 ? 'lỗi hệ thống' : err.message });
  }
}));

server.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT }));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(async () => {
      await db.end().catch(() => {});
      process.exit(0);
    });
  });
}
