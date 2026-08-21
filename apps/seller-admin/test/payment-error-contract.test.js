import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const server = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'server.js'), 'utf8');
const pages = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'pages.js'), 'utf8');
const sellerOrders = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'seller', 'src', 'orders.js'), 'utf8');
const checkoutServer = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'checkout', 'src', 'server.js'), 'utf8');
const migration = fs.readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'packages', 'db', 'migrations', '0175_refund_idempotency.sql'), 'utf8');

function thanHam(ten, tenHamSau) {
  const batDau = server.indexOf(`async function ${ten}(`);
  const ketThuc = server.indexOf(`async function ${tenHamSau}(`, batDau);
  assert.ok(batDau >= 0 && ketThuc > batDau, `phải tìm thấy thân hàm ${ten}`);
  return server.slice(batDau, ketThuc);
}

test('lỗi nghiệp vụ tiền ưu tiên message, sau đó error và nối hành động tiếp theo', () => {
  const batDau = server.indexOf('function paymentApiError(');
  const ketThuc = server.indexOf('function legacyPaymentBody(', batDau);
  assert.ok(batDau >= 0 && ketThuc > batDau, 'phải có helper lỗi dùng chung cho nghiệp vụ tiền');
  const helper = server.slice(batDau, ketThuc);
  assert.match(helper, /r\.json\?\.message \?\? r\.json\?\.error \?\? fallback/);
  assert.match(helper, /r\.json\?\.action \? `\$\{message\} \$\{r\.json\.action\}` : message/);
});

test('ghi nhận tiền thủ công và đảo giao dịch không làm mất hướng xử lý', () => {
  const ghiNhan = thanHam('doPaymentLedgerManual', 'paymentLedgerManual');
  const daoGiaoDich = thanHam('doPaymentLedgerReverse', 'paymentLedgerReverse');
  assert.match(ghiNhan, /paymentApiError\(r, 'Không ghi nhận được khoản thu\.'\)/);
  assert.match(daoGiaoDich, /paymentApiError\(r, 'Không điều chỉnh được khoản thu\.'\)/);
  assert.doesNotMatch(ghiNhan, /r\.json\?\.error \?\?/);
  assert.doesNotMatch(daoGiaoDich, /r\.json\?\.error \?\?/);
});

test('xác nhận QR và hoàn tiền giữ nguyên message cùng action của seller', () => {
  const qr = thanHam('doMarkPaidQr', 'markPaidQrConfirm');
  const hoanTien = thanHam('doRefund', 'refundConfirm');
  assert.match(qr, /paymentApiError\(r, 'Không xác nhận được thanh toán\.'\)/);
  assert.match(hoanTien, /paymentApiError\(r, 'Không hoàn tiền được\.'\)/);
  assert.doesNotMatch(qr, /r\.json\?\.error \?\?/);
  assert.doesNotMatch(hoanTien, /r\.json\?\.error \?\?/);
});

test('refund luôn qua hai POST SSR và giữ nguyên idempotency key khi thử lại', () => {
  const chuanBi = thanHam('refundConfirm', 'refundExecute');
  const execStart = server.indexOf('async function refundExecute(');
  const execEnd = server.indexOf('\nfunction readReturnBody(', execStart);
  assert.ok(execStart >= 0 && execEnd > execStart, 'phải tìm thấy thân hàm refundExecute');
  const thucThi = server.slice(execStart, execEnd);
  const goiSeller = thanHam('doRefund', 'refundConfirm');
  assert.match(chuanBi, /idempotency_key:\s*crypto\.randomUUID\(\)/,
    'POST đầu phải sinh UUID ở server');
  assert.match(chuanBi, /renderRefundConfirm/);
  assert.doesNotMatch(chuanBi, /sellerApi\(|doRefund\(/,
    'POST đầu chỉ được render xác nhận, chưa được ghi refund');
  assert.match(thucThi, /UUID_RE\.test\(vals\.idempotency_key\)/);
  assert.match(thucThi, /return doRefund\([^;]*vals\)/s,
    'POST cuối phải chuyển đúng object chứa key sang seller');
  assert.match(goiSeller, /body = \{ idempotency_key: vals\.idempotency_key \}/);
  assert.match(goiSeller, /renderRefundConfirm\([^;]*vals/s,
    'seller lỗi phải render lại confirmation với cùng key, không quay về form sinh key mới');
  assert.doesNotMatch(goiSeller, /parseVnd\(vals\.amount_vnd\)/,
    'không được biến amount rác thành null/toàn bộ bằng parseVnd');

  const renderStart = pages.indexOf('export function renderRefundConfirm(');
  const renderEnd = pages.indexOf('\nexport function renderInviteAccept(', renderStart);
  const render = pages.slice(renderStart, renderEnd);
  assert.match(render, /action="\$\{base\}\/refund\/confirm"/);
  assert.match(render, /name="idempotency_key"/);
  assert.match(render, /name="reason"/);
  assert.match(render, /data-busy=/);
  assert.match(render, /requirePassword \? '<label>Mật khẩu/,
    'step-up còn hạn không được hỏi lại mật khẩu');
  assert.match(server, /\/refund\$`\)\.exec\(p\)\) && req\.method === 'POST'\) return refundConfirm/);
  assert.match(server, /\/refund\/confirm\$`\)\.exec\(p\)\) && req\.method === 'POST'\) return refundExecute/);
  assert.doesNotMatch(server, /\/refund\/step-up/,
    'route cũ cho phép bỏ qua trang xác nhận không được quay lại');
});

test('chi tiết đơn fail-closed khi thiếu payment_summary và không dựng công thức thứ hai', () => {
  const start = pages.indexOf('export function renderOrderDetail(');
  const end = pages.indexOf('\nexport function renderOrderEdit(', start);
  const detail = pages.slice(start, end);
  assert.match(detail, /PAYMENT_SUMMARY_MISSING/);
  assert.doesNotMatch(detail, /legacyReceived|fallbackRefunded|fallbackNet/,
    'không được khôi phục công thức tiền legacy trong view');
  assert.match(detail, /const editable = paymentReady/,
    'form sửa đơn thường cũng thay tổng tiền nên phải ẩn khi summary lỗi');
  for (const action of ['editPaidAction', 'returnAction', 'canRecordManual', 'canReverse', 'refundAction']) {
    const line = detail.split('\n').find((l) => l.includes(`const ${action} =`)) ?? '';
    assert.match(line, /paymentReady/, `${action} phải biến mất khi summary lỗi`);
  }
  assert.match(detail, /\['cancelled', 'Không tải được'\]/,
    'không được nói sai là chưa thanh toán khi summary bị thiếu');
});

test('workflow đơn dùng role semantic, bảng cuộn và hướng dẫn tồn hoàn về an toàn', () => {
  const start = pages.indexOf('export function renderOrderDetail(');
  const end = pages.indexOf('\nexport function renderOrderEdit(', start);
  const detail = pages.slice(start, end);
  assert.match(detail, /const editPaidAction = \([^\n]*REFUND_ROLES\.has\(ctx\.role\)\)/);
  assert.match(detail, /const returnAction = \([^\n]*REFUND_ROLES\.has\(ctx\.role\)\)/);
  assert.match(detail, /if \(o\.status === 'shipped'[^\n]*ORDER_ROLES\.has\(ctx\.role\)\)/);
  assert.match(detail, /const canRecordManual = [^\n]*PAYMENT_ROLES\.has\(ctx\.role\)/);
  assert.match(detail, /const canReverse = [\s\S]*?PAYMENT_ROLES\.has\(ctx\.role\);/);
  assert.match(detail, /const refundAction = \([^\n]*REFUND_ROLES\.has\(ctx\.role\)\)/);
  assert.match(detail, /const canResolveOrder = ORDER_ROLES\.has\(ctx\.role\);/);
  assert.match(detail, /const canReceiveReturn = INVENTORY_ROLES\.has\(ctx\.role\);/);
  assert.match(detail, /const canResolveRefund = REFUND_ROLES\.has\(ctx\.role\);/);
  const refundBff = server.slice(server.indexOf('// ── Hoàn tiền (refund'), server.indexOf('// ── Nhận trả hàng'));
  assert.equal((refundBff.match(/if \(!REFUND_ROLES\.has\(roleFor\(me, shopId\)\)\)/g) ?? []).length, 2,
    'cả POST chuẩn bị và POST cuối của hoàn tiền thường phải dùng đúng REFUND_ROLES');
  const resolutionRefundBff = server.slice(
    server.indexOf('function resolutionRefundBody('),
    server.indexOf('// Sổ tiền v2 là đường tài chính riêng'),
  );
  assert.equal((resolutionRefundBff.match(/if \(!REFUND_ROLES\.has\(roleFor\(me, shopId\)\)\)/g) ?? []).length, 2,
    'cả POST interstitial và POST step-up của attribution phải dùng đúng REFUND_ROLES');
  assert.match(resolutionRefundBff, /\.\.\.\(body\.refund_ids \?\? \[\]\)\.map\(\(id\) => \['refund_ids', id\]\)/,
    'mọi refund_ids phải sống qua interstitial dưới dạng hidden lặp');
  // Cùng HẬU QUẢ như trước — bảng nằm trong khối cuộn riêng, không đẩy body ở 360px —
  // chỉ đổi CÁCH VIẾT: markup bảng nay do tblCards phát chứ không viết tay.
  // So BẰNG chứ không phải >=. Bản trước viết ">= 3" trong khi thực tế có 4, nên gỡ mất
  // một khối cuộn vẫn XANH — đã chứng minh bằng đột biến. Chi tiết đơn có 10 bảng, đúng 4
  // trong số đó nằm trong khối cuộn (những bảng còn lại đủ hẹp để nằm thẳng trong thẻ).
  assert.equal((detail.match(/<div class="tblscroll">\$\{tblCards\(/g) ?? []).length, 4,
    'bốn bảng chi tiết đơn phải cuộn trong khối, không đẩy body ở 360px');
  assert.match(detail, /\{ cls: canReverse \? 'stack' : undefined, html: reverseForm \}/,
    'form điều chỉnh tiền phải dùng ô stack để không giữ min-width 220px trong cột mobile hẹp');
  assert.match(detail, /grid-template-columns:minmax\(125px,auto\) minmax\(0,1fr\)/,
    'cột nội dung timeline phải được phép co nhỏ trong grid mobile');
  assert.match(detail, /<div style="min-width:0;overflow-wrap:anywhere"><strong>/,
    'mã sự kiện dài trong timeline phải xuống dòng thay vì đẩy body ngang');
  assert.match(detail, /Hàng đã được nhập lại tồn[\s\S]*?Không cộng tồn thủ công lần nữa/);
  assert.match(detail, /title_snapshot[\s\S]*?sku_snapshot/,
    'phiếu nhận hàng hoàn phải dùng tên và SKU, không bắt người dùng đọc UUID');
});

test('refund idempotency được khoá ở DB và replay chạy trước guard trạng thái', () => {
  assert.match(migration, /CREATE UNIQUE INDEX refunds_idem_uq[\s\S]*?ON refunds \(shop_id, idempotency_key\)[\s\S]*?WHERE idempotency_key IS NOT NULL/);
  const start = sellerOrders.indexOf('async function refundOrder(');
  const end = sellerOrders.indexOf('\nconst confirmOrder =', start);
  const refund = sellerOrders.slice(start, end);
  const replay = refund.indexOf('let idem = await refundIdempotency');
  const paymentGuard = refund.indexOf("if (o.payment_status !== 'paid')");
  assert.ok(replay >= 0 && paymentGuard > replay,
    'replay phải chạy trước payment_status để đơn đã refunded vẫn trả 200 replayed');
  assert.match(refund, /idempotency_key_reused/);
  assert.match(refund, /refund_in_progress/);
});

test('10 SQL idempotency_keys của seller và checkout đều tự gác theo tenant', () => {
  // RLS là lớp DB đang chặn rò chéo shop; predicate là lớp ứng dụng bổ sung. Chốt này chỉ
  // thấy SQL viết thẳng trong c.query; SQL qua biến hoặc dựng động cần chốt riêng.
  const extract = (source) => [...source.matchAll(/c\.query\(\s*`([^`]*\bidempotency_keys\b[^`]*)`/g)]
    .map((m) => m[1])
    .map((sql) => ({ sql, kind: /^\s*(SELECT|INSERT|UPDATE|DELETE)\b/.exec(sql)?.[1] ?? null }))
    .filter((q) => q.kind !== null);
  const sellerQueries = extract(sellerOrders);
  const checkoutQueries = extract(checkoutServer);
  const queries = [...sellerQueries, ...checkoutQueries];

  assert.equal(sellerQueries.length, 7, 'seller phải có đúng 7 SQL idempotency inline đã khai');
  assert.equal(checkoutQueries.length, 3, 'checkout phải có đúng 3 SQL idempotency inline đã khai');
  assert.equal(queries.length, 10, 'toàn kho phải có đúng 10 SQL idempotency inline đã khai');
  assert.deepEqual(
    Object.fromEntries(['SELECT', 'INSERT', 'UPDATE', 'DELETE']
      .map((kind) => [kind, queries.filter((q) => q.kind === kind).length])),
    { SELECT: 3, INSERT: 3, UPDATE: 4, DELETE: 0 },
  );

  for (const { kind, sql } of queries) {
    if (kind === 'INSERT') {
      assert.match(sql, /INSERT\s+INTO\s+idempotency_keys\s*\(\s*shop_id\s*,\s*key\b/i);
      assert.match(sql, /VALUES\s*\(\s*current_shop_id\(\)\s*,/i);
      assert.match(sql, /ON\s+CONFLICT\s*\(\s*shop_id\s*,\s*key\s*\)/i);
    } else {
      assert.match(sql, /shop_id\s*=\s*current_shop_id\(\)/,
        `truy vấn ${kind} idempotency_keys thiếu tenant scope:\n${sql}`);
    }
  }
});
