/**
 * Cấu hình ĐIỂM THƯỞNG của shop (0086) + báo cáo NỢ điểm.
 * GET config: mọi thành viên xem. PUT: owner/admin (perm 'loyalty.write') + STEP-UP (chạm đường tiền).
 * GET report: perm 'reports.read' (nợ điểm = khoản shop nợ khách, cạnh P&L; KHÔNG step-up).
 */
import { send } from './http.js';
import { withTenant, audit } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const isInt = (x) => Number.isInteger(x);
const DEFAULTS = { enabled: false, earn_points_per_1000: 1, redeem_vnd_per_point: 100, earn_vesting_days: 7, min_redeem_points: 0, max_redeem_pct: 50 };

async function getConfig(res, ctx) {
  const row = await withTenant(ctx.shopId, async (c) =>
    (await c.query(`SELECT enabled, earn_points_per_1000, redeem_vnd_per_point, earn_vesting_days, min_redeem_points, max_redeem_pct FROM shop_loyalty_config WHERE shop_id = current_shop_id()`)).rows[0]);
  return send(res, 200, row ?? DEFAULTS);
}

// Ràng buộc số nguyên trong khoảng — khớp CHECK migration 0086 (để lỗi 400 rõ, không để CHECK 500).
function validConfig(body) {
  const enabled = body.enabled === true;
  const earn = Number(body.earn_points_per_1000);
  const redeem = Number(body.redeem_vnd_per_point);
  const vesting = Number(body.earn_vesting_days);
  const minR = Number(body.min_redeem_points);
  const pct = Number(body.max_redeem_pct);
  if (!(isInt(earn) && earn >= 1 && earn <= 1000)) return { error: 'điểm/1000đ phải là số nguyên 1–1000' };
  if (!(isInt(redeem) && redeem >= 1 && redeem <= 1_000_000)) return { error: 'giá trị đổi (đ/điểm) phải là số nguyên 1–1.000.000' };
  if (!(isInt(vesting) && vesting >= 0 && vesting <= 365)) return { error: 'số ngày chờ cộng điểm phải là 0–365' };
  if (!(isInt(minR) && minR >= 0)) return { error: 'ngưỡng đổi tối thiểu không hợp lệ' };
  if (!(isInt(pct) && pct >= 1 && pct <= 100)) return { error: 'giảm tối đa (% tiền hàng) phải là 1–100' };
  return { enabled, earn, redeem, vesting, minR, pct };
}

async function putConfig(res, ctx, body) {
  const v = validConfig(body ?? {});
  if (v.error) return send(res, 400, { error: v.error });
  await withTenant(ctx.shopId, async (c) => {
    await c.query(
      `INSERT INTO shop_loyalty_config (shop_id, enabled, earn_points_per_1000, redeem_vnd_per_point, earn_vesting_days, min_redeem_points, max_redeem_pct, updated_at)
       VALUES (current_shop_id(), $1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (shop_id) DO UPDATE SET enabled = $1, earn_points_per_1000 = $2, redeem_vnd_per_point = $3,
         earn_vesting_days = $4, min_redeem_points = $5, max_redeem_pct = $6, updated_at = now()`,
      [v.enabled, v.earn, v.redeem, v.vesting, v.minR, v.pct]);
    await audit(c, 'loyalty_config.updated', { actorId: ctx.user.id, ip: ctx.ip, metadata: { enabled: v.enabled, earn: v.earn, redeem: v.redeem } });
  });
  return send(res, 200, { ok: true });
}

// Báo cáo NỢ điểm: Σ số dư DƯƠNG × giá trị đổi = tiền shop nợ khách (chỉ số cạnh P&L, KHÔNG trừ
// vào lãi kỳ). Kèm chuyển động sổ cái theo loại (tích/đổi/hoàn/thu-hồi/tặng) + số khách có điểm.
async function loyaltyReport(res, ctx) {
  const data = await withTenant(ctx.shopId, async (c) => {
    const cfg = (await c.query(`SELECT enabled, redeem_vnd_per_point FROM shop_loyalty_config WHERE shop_id = current_shop_id()`)).rows[0];
    const perPoint = Number(cfg?.redeem_vnd_per_point ?? DEFAULTS.redeem_vnd_per_point);
    // Nợ = Σ số dư DƯƠNG (nợ âm = khách nợ shop, không cộng vào nợ phải trả).
    const liab = (await c.query(
      `SELECT coalesce(sum(balance_points) FILTER (WHERE balance_points > 0), 0)::bigint AS pos_points,
              count(*) FILTER (WHERE balance_points > 0)::int AS members_with_points,
              count(*) FILTER (WHERE balance_points < 0)::int AS members_in_debt
         FROM loyalty_balances WHERE shop_id = current_shop_id()`)).rows[0];
    // Chuyển động sổ cái theo loại (toàn thời gian) — điểm phát/đổi/hoàn/thu-hồi/tặng.
    const moves = (await c.query(
      `SELECT kind, coalesce(sum(delta), 0)::bigint AS points FROM loyalty_ledger WHERE shop_id = current_shop_id() GROUP BY kind`)).rows;
    const byKind = Object.fromEntries(moves.map((m) => [m.kind, Number(m.points)]));
    return { enabled: cfg?.enabled === true, redeem_vnd_per_point: perPoint, liab, byKind };
  });
  const posPoints = Number(data.liab.pos_points);
  return send(res, 200, {
    enabled: data.enabled,
    redeem_vnd_per_point: data.redeem_vnd_per_point,
    outstanding_points: posPoints,
    liability_vnd: posPoints * data.redeem_vnd_per_point,
    members_with_points: data.liab.members_with_points,
    members_in_debt: data.liab.members_in_debt,
    movements: {
      earned: data.byKind.earn ?? 0,
      redeemed: data.byKind.redeem ?? 0,          // âm
      reversed: data.byKind.reversal ?? 0,
      clawed_back: data.byKind.clawback ?? 0,     // âm
      adjusted: data.byKind.adjust ?? 0,
    },
  });
}

export const LOYALTY_CONFIG_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/loyalty$`), perm: null, fn: (res, ctx) => getConfig(res, ctx) },
  { m: 'PUT', re: new RegExp(`^/shops/${UUID}/loyalty$`), perm: 'loyalty.write', stepUp: true, fn: (res, ctx, b) => putConfig(res, ctx, b) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/reports/loyalty$`), perm: 'reports.read', fn: (res, ctx) => loyaltyReport(res, ctx) },
];
