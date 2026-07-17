/**
 * Kênh thông báo Telegram per-shop. MỘT bot nền tảng (TELEGRAM_BOT_USERNAME); shop link chat
 * riêng qua deep-link /start <link_code> → worker (getUpdates) bind chat_id. Gửi tin do WORKER
 * làm (nó giữ token); seller chỉ tạo mã link + xem trạng thái + ngắt.
 */
import crypto from 'node:crypto';
import { send } from './http.js';
import { withTenant, audit } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME ?? ''; // công khai (không phải token)

async function getTelegram(res, ctx) {
  const row = await withTenant(ctx.shopId, async (c) =>
    (await c.query(`SELECT chat_id, link_code, enabled, linked_at, link_code_expires_at FROM shop_telegram WHERE shop_id = current_shop_id()`)).rows[0] ?? null);
  // Mã CHỈ "pending" khi CÒN HẠN (0069) — khớp điều kiện bind của worker (expires > now()).
  // Mã hết hạn/đời cũ không hạn: coi như không có → UI hiện lại nút "Tạo liên kết".
  const codeLive = !!row?.link_code && !row?.chat_id
    && !!row?.link_code_expires_at && new Date(row.link_code_expires_at) > new Date();
  return send(res, 200, {
    available: !!BOT_USERNAME,
    bot_username: BOT_USERNAME,
    connected: !!row?.chat_id && !!row?.enabled,
    pending: codeLive,
    ...(codeLive ? { deep_link: `https://t.me/${BOT_USERNAME}?start=${row.link_code}` } : {}),
  });
}

async function linkTelegram(res, ctx) {
  if (!BOT_USERNAME) return send(res, 503, { error: 'nền tảng chưa bật Telegram (thiếu TELEGRAM_BOT_USERNAME)' });
  const code = await withTenant(ctx.shopId, async (c) => {
    // link_code có UNIQUE index riêng (khác PK shop_id) → ON CONFLICT(shop_id) KHÔNG bắt được
    // va chạm link_code. Trùng ~ bất khả thi (72-bit) nhưng vẫn retry với SAVEPOINT cho chắc
    // (statement lỗi làm abort transaction → phải rollback về savepoint mới chạy tiếp được).
    let cd;
    for (let i = 0; ; i++) {
      cd = crypto.randomBytes(9).toString('base64url');
      try {
        await c.query('SAVEPOINT lt');
        // Mã có HẠN 30 phút (0069) — mã lộ/cũ không bind được vĩnh viễn; quá hạn bấm tạo lại.
        await c.query(
          `INSERT INTO shop_telegram (shop_id, link_code, enabled, link_code_expires_at)
           VALUES (current_shop_id(), $1, true, now() + interval '30 minutes')
           ON CONFLICT (shop_id) DO UPDATE
             SET link_code = $1, enabled = true, link_code_expires_at = now() + interval '30 minutes'`, [cd]);
        await c.query('RELEASE SAVEPOINT lt');
        break;
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT lt');
        if (e.code === '23505' && i < 4) continue; // trùng link_code → sinh mã mới
        throw e;
      }
    }
    await audit(c, 'telegram.link_requested', { actorId: ctx.user.id, ip: ctx.ip, metadata: {} });
    return cd;
  });
  return send(res, 200, { ok: true, deep_link: `https://t.me/${BOT_USERNAME}?start=${code}` });
}

async function unlinkTelegram(res, ctx) {
  await withTenant(ctx.shopId, async (c) => {
    await c.query(`DELETE FROM shop_telegram WHERE shop_id = current_shop_id()`);
    await audit(c, 'telegram.unlinked', { actorId: ctx.user.id, ip: ctx.ip, metadata: {} });
  });
  return send(res, 200, { ok: true });
}

export const NOTIFY_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/telegram$`), perm: 'orders.read', fn: (res, ctx) => getTelegram(res, ctx) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/telegram/link$`), perm: 'shop.write', fn: (res, ctx) => linkTelegram(res, ctx) },
  { m: 'DELETE', re: new RegExp(`^/shops/${UUID}/telegram$`), perm: 'shop.write', fn: (res, ctx) => unlinkTelegram(res, ctx) },
];
