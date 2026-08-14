/** Ca nghiệp vụ cần người bán quyết định khi các kiện cùng đơn có kết quả trái nhau. */
import { createHash } from 'node:crypto';
import { send, parseOffset } from './http.js';
import { withTenant, audit } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOLUTIONS = new Set(['accept_partial', 'resent', 'refunded_remainder', 'cancelled_remainder', 'other']);
const FINANCIAL_ACTIONS = new Set(['handled_separately', 'not_required']);

class ResolutionRollbackError extends Error {
  constructor(result) {
    super(result.message);
    this.name = 'ResolutionRollbackError';
    this.result = result;
  }
}

async function withResolutionRollback(shopId, fn) {
  try {
    return await withTenant(shopId, fn);
  } catch (error) {
    if (error instanceof ResolutionRollbackError) return error.result;
    throw error;
  }
}

const SUMMARY_SQL = `
  SELECT rc.id, rc.order_id, rc.kind, rc.status, rc.resolution, rc.resolution_note,
          rc.resolution_payload, rc.required_refund_vnd, rc.detected_at, rc.resolved_at, rc.resolved_by,
         o.order_number, o.status AS order_status, o.payment_status, o.fulfillment_status,
         coalesce(ship.delivered_shipments, 0)::int AS delivered_shipments,
         coalesce(ship.returned_shipments, 0)::int AS returned_shipments,
         coalesce(snap.snapshot_lines, '[]'::jsonb) AS snapshot_lines,
         coalesce(snap.delivered_qty, 0)::int AS delivered_qty,
         coalesce(snap.returned_qty, 0)::int AS returned_qty,
         coalesce(snap.unresolved_qty, 0)::int AS unresolved_qty,
         coalesce(received.received_qty, 0)::int AS received_return_qty,
         coalesce(received.restocked_qty, 0)::int AS restocked_qty,
         coalesce(received.quarantined_qty, 0)::int AS quarantined_qty
    FROM order_resolution_cases rc
    JOIN orders o ON o.id = rc.order_id
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE s.status = 'delivered')::int AS delivered_shipments,
             count(*) FILTER (WHERE s.status = 'returned')::int AS returned_shipments
        FROM shipments s
       WHERE s.order_id = rc.order_id AND s.status <> 'cancelled'
    ) ship ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'id', cl.id,
               'order_line_id', cl.order_line_id,
               'variant_id', cl.variant_id,
               'ordered_qty', cl.ordered_qty,
               'delivered_qty', cl.delivered_qty,
               'returned_qty', cl.returned_qty,
               'unresolved_qty', cl.unresolved_qty,
               'received_qty', coalesce((
                 SELECT sum(rl.qty)::int
                   FROM order_resolution_return_receipt_lines rl
                  WHERE rl.case_line_id = cl.id
               ), 0),
               'remaining_return_qty', cl.returned_qty - coalesce((
                 SELECT sum(rl.qty)::int
                   FROM order_resolution_return_receipt_lines rl
                  WHERE rl.case_line_id = cl.id
               ), 0)
             ) ORDER BY cl.order_line_id) AS snapshot_lines,
             sum(cl.delivered_qty)::int AS delivered_qty,
             sum(cl.returned_qty)::int AS returned_qty,
             sum(cl.unresolved_qty)::int AS unresolved_qty
        FROM order_resolution_case_lines cl
       WHERE cl.case_id = rc.id
    ) snap ON true
    LEFT JOIN LATERAL (
      SELECT sum(rl.qty)::int AS received_qty,
             sum(rl.qty) FILTER (WHERE rr.disposition = 'restock')::int AS restocked_qty,
             sum(rl.qty) FILTER (WHERE rr.disposition = 'quarantine')::int AS quarantined_qty
        FROM order_resolution_return_receipt_lines rl
        JOIN order_resolution_return_receipts rr ON rr.id = rl.receipt_id
       WHERE rr.case_id = rc.id
    ) received ON true`;

export async function resolutionCasesForOrder(c, orderId) {
  return (await c.query(
    `${SUMMARY_SQL} WHERE rc.order_id = $1 ORDER BY rc.detected_at DESC, rc.id DESC`,
    [orderId],
  )).rows.map(normalize);
}

function normalize(r) {
  const returned = Number(r.returned_qty);
  const received = Number(r.received_return_qty);
  return {
    ...r,
    order_number: Number(r.order_number),
    delivered_shipments: Number(r.delivered_shipments),
    returned_shipments: Number(r.returned_shipments),
    delivered_qty: Number(r.delivered_qty),
    returned_qty: returned,
    unresolved_qty: Number(r.unresolved_qty),
    received_return_qty: received,
    remaining_return_qty: returned - received,
    integrity_error: received > returned ? 'received_qty_exceeds_returned' : null,
    restocked_qty: Number(r.restocked_qty),
    quarantined_qty: Number(r.quarantined_qty),
    required_refund_vnd: Number(r.required_refund_vnd ?? 0),
    snapshot_lines: Array.isArray(r.snapshot_lines) ? r.snapshot_lines.map((line) => ({
      ...line,
      ordered_qty: Number(line.ordered_qty),
      delivered_qty: Number(line.delivered_qty),
      returned_qty: Number(line.returned_qty),
      unresolved_qty: Number(line.unresolved_qty),
      received_qty: Number(line.received_qty),
      remaining_return_qty: Number(line.remaining_return_qty),
    })) : [],
  };
}

async function listCases(res, ctx, _body, _params, query) {
  const requested = String(query?.get('status') ?? 'active');
  const status = ['active', 'open', 'waiting_return', 'resolved'].includes(requested) ? requested : 'active';
  const limit = Math.min(100, Math.max(1, Number(query?.get('limit')) || 20));
  const offset = parseOffset(query);
  const data = await withTenant(ctx.shopId, async (c) => {
    const rows = (await c.query(
      `${SUMMARY_SQL}
        WHERE (($1 = 'active' AND rc.status IN ('open','waiting_return')) OR rc.status = $1)
        ORDER BY rc.detected_at DESC, rc.id DESC LIMIT $2 OFFSET $3`,
      [status, limit, offset],
    )).rows.map(normalize);
    const total = Number((await c.query(
      `SELECT count(*)::int AS n FROM order_resolution_cases
        WHERE (($1 = 'active' AND status IN ('open','waiting_return')) OR status = $1)`, [status],
    )).rows[0].n);
    return { rows, total };
  });
  return send(res, 200, { status, total: data.total, limit, offset, cases: data.rows });
}

async function loadCaseLocked(c, caseId) {
  const locked = (await c.query(
    `SELECT lock_current_order_resolution_case($1) AS found`, [caseId],
  )).rows[0]?.found;
  if (!locked) return null;
  return (await c.query(
    `SELECT rc.id, rc.order_id, rc.status, rc.resolution, rc.resolution_note,
            rc.resolution_payload, rc.required_refund_vnd, rc.detected_at,
            o.order_number, o.status AS order_status, o.payment_status, o.fulfillment_status,
            o.amount_paid_vnd, o.paid_at
       FROM order_resolution_cases rc
       JOIN orders o ON o.id = rc.order_id
      WHERE rc.id = $1
      FOR UPDATE OF o`, [caseId],
  )).rows[0] ?? null;
}

async function progressOf(c, caseId) {
  return (await c.query(
    `SELECT count(*)::int AS line_count,
            coalesce(sum(cl.delivered_qty), 0)::int AS delivered_qty,
            coalesce(sum(cl.returned_qty), 0)::int AS returned_qty,
            coalesce(sum(cl.unresolved_qty), 0)::int AS unresolved_qty,
            coalesce((
              SELECT sum(rl.qty)::int
                FROM order_resolution_return_receipt_lines rl
               WHERE rl.case_id = $1
            ), 0)::int AS received_qty
       FROM order_resolution_case_lines cl
      WHERE cl.case_id = $1`, [caseId],
  )).rows[0];
}

async function waitForReturnedGoods(res, ctx, _body, params) {
  const caseId = params[1];
  const out = await withTenant(ctx.shopId, async (c) => {
    const row = await loadCaseLocked(c, caseId);
    if (!row) return { code: 404 };
    if (row.status === 'resolved') return { code: 409, errorCode: 'case_already_resolved', message: 'ca đã được chốt' };
    if (row.status === 'waiting_return') return { code: 200, replayed: true, row };
    const progress = await progressOf(c, caseId);
    if (!Number(progress.line_count)) return {
      code: 409, errorCode: 'resolution_snapshot_missing',
      message: 'ca chưa có snapshot số lượng để nhận hàng an toàn',
      action: 'Chạy lại migration/backfill 0168 rồi thử lại; không điều chỉnh tồn thủ công từ ca này.',
    };
    if (Number(progress.received_qty) > Number(progress.returned_qty)) return {
      code: 409, errorCode: 'resolution_inventory_integrity_error',
      message: 'số hàng đã ghi nhận nhận về đang lớn hơn snapshot hàng hoàn',
      action: 'Dừng xử lý ca và đối soát receipt/ledger; hệ thống không tự che chênh lệch này.',
    };
    if (Number(progress.received_qty) >= Number(progress.returned_qty)) return {
      code: 409, errorCode: 'returned_goods_already_received',
      message: 'toàn bộ số hàng hoàn trong snapshot đã được nhận',
      action: 'Kiểm tra phần chưa xử lý rồi chọn Chấp nhận giao một phần.',
    };
    await c.query(`SELECT set_order_resolution_active_status($1, 'waiting_return')`, [caseId]);
    await audit(c, 'order.resolution_waiting_return', {
      actorId: ctx.user.id, ip: ctx.ip,
      metadata: { case_id: caseId, orderId: row.order_id, returned_qty: Number(progress.returned_qty), received_qty: Number(progress.received_qty) },
    });
    await c.query(
      `SELECT record_order_event($1, 'resolution.waiting_return', 'user', $2, 'seller_admin', $3)`,
      [row.order_id, ctx.user.id, { case_id: caseId, returned_qty: Number(progress.returned_qty), received_qty: Number(progress.received_qty) }],
    );
    return { code: 200, replayed: false, row };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy ca cần xử lý' });
  if (out.code === 409) return send(res, 409, { error_code: out.errorCode, message: out.message, action: out.action });
  return send(res, 200, {
    ok: true, status: 'waiting_return', replayed: out.replayed,
    order_id: out.row.order_id,
    next_action: 'Khi hàng thực sự về shop, xác nhận số lượng và chọn nhập lại tồn hoặc cách ly hàng hỏng.',
  });
}

function parseReceipt(body) {
  const key = String(body?.idempotency_key ?? '').trim();
  if (key.length < 8 || key.length > 200) return { error: 'idempotency_key phải dài 8-200 ký tự' };
  const rawDisposition = String(body?.disposition ?? '').trim();
  const disposition = rawDisposition === 'damaged' ? 'quarantine' : rawDisposition;
  if (!['restock', 'quarantine'].includes(disposition)) return { error: 'cách xử lý hàng phải là restock hoặc quarantine' };
  const note = String(body?.note ?? '').trim().slice(0, 1000) || null;
  if (disposition === 'quarantine' && !note) return { error: 'cần ghi tình trạng hư hỏng khi đưa hàng vào khu cách ly' };
  const input = Array.isArray(body?.lines) ? body.lines : [];
  if (input.length === 0 || input.length > 50) return { error: 'chọn 1-50 dòng hàng hoàn để xác nhận' };
  const merged = new Map();
  for (const line of input) {
    const id = String(line?.case_line_id ?? '');
    const qty = Number(line?.qty);
    if (!UUID_RE.test(id) || !Number.isInteger(qty) || qty < 1 || qty > 100000) return { error: 'dòng hàng hoặc số lượng nhận không hợp lệ' };
    merged.set(id, (merged.get(id) ?? 0) + qty);
  }
  const lines = [...merged].map(([case_line_id, qty]) => ({ case_line_id, qty }))
    .sort((a, b) => a.case_line_id.localeCompare(b.case_line_id));
  if (lines.some((line) => !Number.isInteger(line.qty) || line.qty < 1 || line.qty > 100000)) {
    return { error: 'tổng số lượng nhận trên một dòng phải từ 1 đến 100000' };
  }
  const requestHash = createHash('sha256').update(JSON.stringify({ disposition, note, lines })).digest('hex');
  return { value: { key, disposition, note, lines, requestHash } };
}

async function receiveReturnedGoods(res, ctx, body, params) {
  const caseId = params[1];
  const parsed = parseReceipt(body);
  if (parsed.error) return send(res, 400, { error: parsed.error });
  const input = parsed.value;
  const out = await withResolutionRollback(ctx.shopId, async (c) => {
    const row = await loadCaseLocked(c, caseId);
    if (!row) return { code: 404 };

    const previous = (await c.query(
      `SELECT id, request_hash, disposition, created_at
         FROM order_resolution_return_receipts
        WHERE case_id = $1 AND idempotency_key = $2`, [caseId, input.key],
    )).rows[0];
    if (previous) {
      if (previous.request_hash !== input.requestHash) return {
        code: 409, errorCode: 'idempotency_conflict',
        message: 'idempotency_key đã được dùng với nội dung khác',
        action: 'Dùng một idempotency_key mới cho lần nhận hàng khác.',
      };
      const progress = await progressOf(c, caseId);
      if (Number(progress.received_qty) > Number(progress.returned_qty)) return {
        code: 409, errorCode: 'resolution_inventory_integrity_error',
        message: 'số hàng đã ghi nhận nhận về đang lớn hơn snapshot hàng hoàn',
        action: 'Dừng xử lý ca và đối soát receipt/ledger trước khi tiếp tục.',
      };
      return { code: 200, replayed: true, receiptId: previous.id, disposition: previous.disposition, progress, caseStatus: row.status };
    }
    if (row.status === 'resolved') return {
      code: 409, errorCode: 'case_already_resolved', message: 'ca đã được chốt nên không thể nhận thêm hàng',
      action: 'Mở một chứng từ điều chỉnh tồn riêng nếu hàng về sau khi ca đã đóng.',
    };

    const caseLines = (await c.query(
      `SELECT cl.id, cl.variant_id, cl.returned_qty,
              coalesce((
                SELECT sum(rl.qty)::int FROM order_resolution_return_receipt_lines rl
                 WHERE rl.case_line_id = cl.id
              ), 0)::int AS received_qty
         FROM order_resolution_case_lines cl
        WHERE cl.case_id = $1
        ORDER BY cl.variant_id, cl.id`, [caseId],
    )).rows;
    if (caseLines.length === 0) return {
      code: 409, errorCode: 'resolution_snapshot_missing',
      message: 'ca chưa có snapshot số lượng để nhận hàng an toàn',
      action: 'Chạy lại migration/backfill 0168 rồi thử lại.',
    };
    const byId = new Map(caseLines.map((line) => [line.id, line]));
    const accepted = [];
    for (const wanted of input.lines) {
      const line = byId.get(wanted.case_line_id);
      if (!line) return {
        code: 422, errorCode: 'case_line_not_found', message: 'có dòng hàng không thuộc ca này',
        action: 'Tải lại chi tiết ca và chọn đúng dòng trong snapshot.',
      };
      const remaining = Number(line.returned_qty) - Number(line.received_qty);
      if (wanted.qty > remaining) return {
        code: 422, errorCode: 'received_qty_exceeds_returned',
        message: `dòng hàng chỉ còn ${Math.max(0, remaining)} sản phẩm hoàn chưa nhận`,
        action: 'Giảm số lượng về đúng phần còn lại hoặc kiểm tra lại chứng từ hãng.',
      };
      accepted.push({ ...wanted, variant_id: line.variant_id });
    }

    const receipt = (await c.query(
      `SELECT create_order_resolution_return_receipt($1,$2,$3,$4,$5,$6) AS id`,
      [caseId, input.key, input.requestHash, input.disposition, input.note, ctx.user.id],
    )).rows[0];
    const receiptLines = [];
    for (const line of accepted) {
      const inserted = (await c.query(
        `SELECT create_order_resolution_return_receipt_line($1,$2,$3,$4,$5) AS id`,
        [caseId, receipt.id, line.case_line_id, line.variant_id, line.qty],
      )).rows[0];
      receiptLines.push({ ...line, receipt_line_id: inserted.id });
    }

    if (input.disposition === 'restock') {
      const variantIds = [...new Set(receiptLines.map((line) => line.variant_id))];
      await c.query(
        `INSERT INTO inventory_levels (shop_id, variant_id)
         SELECT current_shop_id(), variants.variant_id
           FROM unnest($1::uuid[]) AS variants(variant_id)
          ORDER BY variants.variant_id
         ON CONFLICT (shop_id, variant_id) DO NOTHING`,
        [variantIds],
      );
      await c.query(
        `SELECT variant_id
           FROM inventory_levels
          WHERE variant_id = ANY($1::uuid[])
          ORDER BY variant_id
          FOR UPDATE`,
        [variantIds],
      );
      for (const line of receiptLines) {
        await c.query(
          `UPDATE inventory_levels SET on_hand = on_hand + $2, updated_at = now() WHERE variant_id = $1`,
          [line.variant_id, line.qty],
        );
        await c.query(
          `INSERT INTO inventory_ledger
             (shop_id, variant_id, delta, kind, reason, actor_id, resolution_receipt_line_id)
           VALUES (current_shop_id(), $1, $2, 'receive', $3, $4, $5)`,
          [line.variant_id, line.qty, `Nhận hàng hoàn ca ${caseId}`, ctx.user.id, line.receipt_line_id],
        );
      }
    }

    const progress = await progressOf(c, caseId);
    if (Number(progress.received_qty) > Number(progress.returned_qty)) throw new ResolutionRollbackError({
      code: 409, errorCode: 'resolution_inventory_integrity_error',
      message: 'số hàng đã nhận vượt snapshot hàng hoàn',
      action: 'Transaction đã rollback; kiểm tra receipt/ledger trước khi thử lại.',
    });
    const remaining = Number(progress.returned_qty) - Number(progress.received_qty);
    const nextStatus = remaining > 0 ? 'waiting_return' : 'open';
    await c.query(`SELECT set_order_resolution_active_status($1, $2)`, [caseId, nextStatus]);
    await audit(c, 'order.resolution_return_received', {
      actorId: ctx.user.id, ip: ctx.ip,
      metadata: {
        case_id: caseId, orderId: row.order_id, receipt_id: receipt.id,
        disposition: input.disposition, lines: receiptLines.map((line) => ({ case_line_id: line.case_line_id, variant_id: line.variant_id, qty: line.qty })),
        remaining_return_qty: remaining,
      },
    });
    await c.query(
      `SELECT record_order_event($1, 'resolution.return_received', 'user', $2, 'seller_admin', $3)`,
      [row.order_id, ctx.user.id, {
        case_id: caseId, receipt_id: receipt.id, disposition: input.disposition,
        lines: receiptLines.map((line) => ({ case_line_id: line.case_line_id, variant_id: line.variant_id, qty: line.qty })),
        remaining_return_qty: remaining,
      }],
    );
    return { code: 201, replayed: false, receiptId: receipt.id, disposition: input.disposition, progress, caseStatus: nextStatus };
  });

  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy ca cần xử lý' });
  if ([409, 422].includes(out.code)) return send(res, out.code, { error_code: out.errorCode, message: out.message, action: out.action });
  const remaining = Number(out.progress.returned_qty) - Number(out.progress.received_qty);
  return send(res, out.code, {
    ok: true, replayed: out.replayed, receipt_id: out.receiptId,
    disposition: out.disposition, status: out.caseStatus,
    received_return_qty: Number(out.progress.received_qty), remaining_return_qty: remaining,
    next_action: remaining > 0
      ? 'Tiếp tục chờ và xác nhận phần hàng hoàn còn lại.'
      : 'Kiểm tra không còn kiện chưa xử lý rồi chấp nhận giao một phần.',
  });
}

async function acceptPartialDelivery(res, ctx, body, params) {
  const caseId = params[1];
  const financialAction = String(body?.financial_action ?? '').trim();
  const note = String(body?.note ?? '').trim().slice(0, 1000) || null;
  const refundId = body?.refund_id == null ? null : String(body.refund_id).trim().toLowerCase();
  if (!FINANCIAL_ACTIONS.has(financialAction)) return send(res, 409, {
    error_code: 'financial_action_required',
    message: 'hệ thống không tự hoàn tiền cho phần khách không nhận',
    action: 'Hoàn tiền bằng nghiệp vụ refund an toàn trước, hoặc xác nhận financial_action=not_required nếu thực sự không phát sinh khoản phải hoàn.',
  });
  if (!note) return send(res, 400, {
    error: 'cần ghi chú cách đã xử lý tiền cho phần không giao',
  });
  if (financialAction === 'handled_separately' && !UUID_RE.test(refundId ?? '')) return send(res, 400, {
    error_code: 'refund_id_required',
    message: 'cần chọn đúng phiếu hoàn tiền dùng để xử lý phần không giao',
    action: 'Hoàn tiền bằng endpoint refund an toàn, sau đó gửi lại refund_id của phiếu vừa tạo.',
  });
  if (financialAction === 'not_required' && refundId) return send(res, 400, {
    error: 'financial_action=not_required không được đính kèm phiếu hoàn tiền',
  });

  const out = await withTenant(ctx.shopId, async (c) => {
    const row = await loadCaseLocked(c, caseId);
    if (!row) return { code: 404 };
    if (row.status === 'resolved') {
      const saved = row.resolution_payload ?? {};
      const sameRequest = row.resolution === 'accept_partial'
        && row.resolution_note === note
        && saved.financial_action === financialAction
        && (saved.refund_id ?? null) === (refundId ?? null);
      if (sameRequest) return { code: 200, replayed: true, row };
      if (row.resolution === 'accept_partial') return {
        code: 409, errorCode: 'resolution_replay_conflict',
        message: 'ca đã được chốt bằng nội dung tài chính khác',
        action: 'Tải lại timeline; không phát lại accept-partial với note hoặc refund_id khác.',
      };
      return { code: 409, errorCode: 'case_already_resolved', message: 'ca đã được chốt bằng cách xử lý khác' };
    }
    const progress = await progressOf(c, caseId);
    if (!Number(progress.line_count)) return {
      code: 409, errorCode: 'resolution_snapshot_missing', message: 'ca chưa có snapshot số lượng',
      action: 'Chạy lại migration/backfill 0168; không chốt đơn khi chưa giải thích được số lượng.',
    };
    if (Number(progress.unresolved_qty) > 0) return {
      code: 409, errorCode: 'shipment_qty_unresolved',
      message: `còn ${Number(progress.unresolved_qty)} sản phẩm chưa có kết quả giao hoặc hoàn`,
      action: 'Chờ hãng cập nhật hoặc đối soát vận đơn còn lại; case vẫn được giữ mở.',
    };
    const remainingReturn = Number(progress.returned_qty) - Number(progress.received_qty);
    if (remainingReturn < 0) return {
      code: 409, errorCode: 'resolution_inventory_integrity_error',
      message: 'số hàng đã nhận vượt snapshot hàng hoàn',
      action: 'Dừng chốt ca và đối soát receipt/ledger; không dùng số âm như đã xử lý xong.',
    };
    if (remainingReturn > 0) return {
      code: 409, errorCode: 'returned_goods_not_received',
      message: `còn ${remainingReturn} sản phẩm hãng báo hoàn nhưng shop chưa xác nhận đã nhận`,
      action: 'Dùng receive-return để xác nhận hàng thực sự về và chọn restock hoặc quarantine.',
    };
    if (Number(progress.delivered_qty) <= 0) return {
      code: 409, errorCode: 'no_delivered_qty', message: 'không có sản phẩm giao thành công để chấp nhận giao một phần',
      action: 'Không chốt accept_partial; đối soát lại trạng thái các kiện.',
    };
    if (row.order_status !== 'shipped') return {
      code: 409, errorCode: 'order_state_changed', message: `đơn đang ở trạng thái ${row.order_status}`,
      action: 'Tải lại đơn và kiểm tra thay đổi vừa xảy ra trước khi chốt case.',
    };
    if (financialAction === 'not_required'
        && (row.payment_status === 'paid' || row.payment_status === 'refunded'
          || Number(row.amount_paid_vnd) > 0 || row.paid_at)) return {
      code: 409, errorCode: 'refund_evidence_required',
      message: 'đơn đã ghi nhận tiền nên không thể chốt phần không giao chỉ bằng xác nhận',
      action: 'Tạo phiếu hoàn tiền cho phần không giao và gửi lại với financial_action=handled_separately + refund_id.',
    };
    let refund = null;
    if (financialAction === 'handled_separately') {
      refund = (await c.query(
        `SELECT id, amount_vnd
           FROM refunds
          WHERE id = $1 AND order_id = $2 AND kind <> 'edit_adjustment'
            AND created_at >= $3`,
        [refundId, row.order_id, row.detected_at],
      )).rows[0] ?? null;
      if (!refund) return {
        code: 409, errorCode: 'refund_evidence_invalid',
        message: 'phiếu hoàn tiền không thuộc đơn, có trước khi ca phát sinh hoặc không phải phiếu hoàn nghiệp vụ',
        action: 'Chọn phiếu refund đúng của đơn này; không dùng phiếu điều chỉnh giá hoặc phiếu của shop khác.',
      };
      const refundEvidence = (await c.query(
        `SELECT coalesce(sum(amount_vnd), 0)::bigint AS amount,
                count(*) FILTER (WHERE id = $3)::int AS selected_count
           FROM refunds
          WHERE order_id = $1 AND kind <> 'edit_adjustment' AND created_at >= $2`,
        [row.order_id, row.detected_at, refundId],
      )).rows[0];
      const refundedSinceCase = Number(refundEvidence.amount);
      const requiredRefund = Number(row.required_refund_vnd ?? 0);
      if (refundedSinceCase < requiredRefund) return {
        code: 409,
        errorCode: 'refund_amount_insufficient',
        message: `mới ghi nhận hoàn ${refundedSinceCase}đ, thấp hơn số tối thiểu ${requiredRefund}đ cho phần không giao`,
        action: `Hoàn thêm ${requiredRefund - refundedSinceCase}đ bằng endpoint refund an toàn rồi chốt lại ca.`,
      };
      if (Number(refundEvidence.selected_count) !== 1) return {
        code: 409,
        errorCode: 'refund_evidence_not_in_required_total',
        message: 'phiếu được chọn không nằm trong tổng chứng từ dùng để đạt số hoàn tối thiểu',
        action: 'Tải lại đơn và chọn một phiếu refund vừa được tính trong ca này.',
      };
    }

    const completed = (await c.query(
      `SELECT complete_order_resolution_accept_partial($1,$2,$3,$4,$5) AS result`,
      [caseId, note, financialAction, refund?.id ?? null, ctx.user.id],
    )).rows[0].result;
    if (completed?.error_code === 'case_not_found') return { code: 404 };
    await audit(c, 'order.resolution_case_resolved', {
      actorId: ctx.user.id, ip: ctx.ip,
      metadata: {
        case_id: caseId, orderId: row.order_id, resolution: 'accept_partial', financial_action: financialAction,
        delivered_qty: Number(progress.delivered_qty), returned_qty: Number(progress.returned_qty), note,
        ...(refund ? { refund_id: refund.id, refund_amount_vnd: Number(refund.amount_vnd) } : {}),
      },
    });
    await c.query(
      `SELECT record_order_event($1, 'resolution.completed', 'user', $2, 'seller_admin', $3)`,
      [row.order_id, ctx.user.id, {
        case_id: caseId, resolution: 'accept_partial', financial_action: financialAction,
        delivered_qty: Number(progress.delivered_qty), returned_qty: Number(progress.returned_qty),
        order_status: 'delivered', fulfillment_status: 'partial', note,
        ...(refund ? { refund_id: refund.id, refund_amount_vnd: Number(refund.amount_vnd) } : {}),
      }],
    );
    return { code: 200, replayed: false, row };
  });

  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy ca cần xử lý' });
  if (out.code === 409) return send(res, 409, { error_code: out.errorCode, message: out.message, action: out.action });
  return send(res, 200, {
    ok: true, replayed: out.replayed, status: 'resolved', resolution: 'accept_partial',
    order_id: out.row.order_id, order_status: 'delivered', fulfillment_status: 'partial',
  });
}

async function resolveCase(res, ctx, body, params) {
  const resolution = String(body?.resolution ?? '').trim();
  if (!RESOLUTIONS.has(resolution)) return send(res, 400, { error: 'cách xử lý không hợp lệ' });
  if (resolution === 'accept_partial') return acceptPartialDelivery(res, ctx, body, params);
  const action = {
    resent: 'Tạo vận đơn gửi bù bằng luồng shipment có claim/idempotency; tính năng nối kiện bù vào case chưa được mở nên case vẫn giữ nguyên.',
    refunded_remainder: 'Dùng endpoint refund có step-up để ghi chứng từ tiền; sau đó quay lại chốt accept_partial với financial_action=handled_separately.',
    cancelled_remainder: 'Không thể huỷ mù một phần đơn đã giao. Hãy đối soát tiền và hàng rồi chốt accept_partial nếu phù hợp.',
    other: 'Ghi chú không thay thế được chứng từ tiền/tồn. Chọn chờ hàng hoàn, nhận hàng, hoặc chấp nhận giao một phần khi đủ điều kiện.',
  }[resolution];
  return send(res, 409, {
    error_code: `${resolution}_requires_safe_workflow`,
    message: 'hệ thống chưa thể thực hiện lựa chọn này mà vẫn bảo đảm tiền và tồn',
    action,
    case_status: 'unchanged',
  });
}

export const ORDER_RESOLUTION_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/order-resolution-cases$`), perm: 'orders.read', fn: listCases },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/resolution-cases$`), perm: 'orders.read', fn: listCases },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/order-resolution-cases/${UUID}/wait-return$`), perm: 'orders.write', fn: waitForReturnedGoods },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/resolution-cases/${UUID}/wait-return$`), perm: 'orders.write', fn: waitForReturnedGoods },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/order-resolution-cases/${UUID}/receive-return$`), perm: 'inventory.manage', fn: receiveReturnedGoods },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/resolution-cases/${UUID}/receive-return$`), perm: 'inventory.manage', fn: receiveReturnedGoods },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/order-resolution-cases/${UUID}/accept-partial$`), perm: 'orders.write', fn: acceptPartialDelivery },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/resolution-cases/${UUID}/accept-partial$`), perm: 'orders.write', fn: acceptPartialDelivery },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/order-resolution-cases/${UUID}/resolve$`), perm: 'orders.write', fn: resolveCase },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/resolution-cases/${UUID}/resolve$`), perm: 'orders.write', fn: resolveCase },
];
