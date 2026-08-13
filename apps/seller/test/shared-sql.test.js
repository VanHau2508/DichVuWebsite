// UNIT: các đoạn SQL được CHÉP TAY sang nhiều service phải KHỚP TỪNG KÝ TỰ.
//
// Vì sao có bộ này: ba lỗ tiền trong một ngày (2026-08-03) đều cùng một hình dạng — MỘT LUẬT
// viết ở HAI NƠI rồi trôi lệch:
//   · công thức tổng tiền ở checkout có points_discount_vnd, ở sửa đơn thì không;
//   · phí ship ở checkout có phụ phí cân, ở đơn bot thì không;
//   · bộ lọc "hãng còn nợ" ở cod.js và reports.js lọc theo hai điều kiện khác nhau.
// Mỗi lần đều mất một vòng dựng-lại-thật mới tìm ra. Rẻ hơn nhiều là để máy canh.
//
// VÌ SAO KHÔNG GỘP THÀNH MỘT FILE DÙNG CHUNG: mỗi service là một image riêng, và
// apps/checkout KHÔNG có packages/ trong image (xem chú thích ở apps/seller/src/affiliates.js).
// Gộp đòi thêm bind-mount cho từng service — đụng cả đường tiền checkout để đổi một hằng số
// đang đúng là đánh đổi tồi. Chép tay thì CHẤP NHẬN ĐƯỢC, miễn là có người canh trôi lệch.
// Bộ này chính là người canh đó.
//
// KHI ĐỎ: đừng sửa test cho khớp. Đọc cả N bản, quyết bản nào ĐÚNG, rồi sửa các bản còn lại.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const doc = (p) => readFileSync(join(ROOT, p), 'utf8');

// Trích phần thân của `const <TEN> = \`...\`;` — so sau khi chuẩn hoá khoảng trắng, vì thụt
// lề khác nhau giữa các file là vô hại, còn khác ĐIỀU KIỆN thì không.
function sqlConst(path, name) {
  const src = doc(path);
  const m = new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`).exec(src);
  assert.ok(m, `${path}: không thấy hằng ${name}`);
  return m[1].replace(/\s+/g, ' ').trim();
}

function jsFilesUnder(path) {
  const root = join(ROOT, path);
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(root);
  return files;
}

test('VARIANT_NOT_ORPHAN_SQL giống hệt nhau ở mọi service', () => {
  // Luật "ẩn biến thể mồ côi": shop thu hẹp phân loại → biến thể của tổ hợp cũ mất ánh xạ
  // nhưng vẫn active + còn giá/tồn. Lệch một bản là bán được hàng KHÔNG TỒN TẠI ở đúng
  // service đó (storefront cho chọn / checkout cho đặt / seller cho gõ tay).
  const nguon = [
    'apps/storefront/src/server.js',
    'apps/checkout/src/server.js',
    'apps/seller/src/orders.js',
    'apps/seller/src/catalog.js',
    'apps/seller/src/purchasing.js',
  ];
  const bansao = nguon.map((p) => [p, sqlConst(p, 'VARIANT_NOT_ORPHAN_SQL')]);
  const [, chuan] = bansao[0];
  for (const [p, sql] of bansao.slice(1)) {
    assert.equal(sql, chuan, `${p} lệch với ${nguon[0]} — quyết bản nào đúng rồi sửa bản kia, ĐỪNG sửa test`);
  }
  // Chốt hai đầu: nếu ai đó rút gọn hằng thành chuỗi rỗng thì mọi bản vẫn "giống nhau".
  assert.match(chuan, /product_options/, 'hằng không còn nhắc product_options — đã bị rút ruột?');
  assert.match(chuan, /variant_option_values/, 'hằng không còn nhắc variant_option_values');
});

test('quyền UPDATE shops của app_rw khớp chính xác các route seller đang dùng', () => {
  const migration = doc('packages/db/migrations/0165_shop_go_live_privilege_guard.sql');
  const grant = /GRANT\s+UPDATE\s*\(([\s\S]*?)\)\s+ON\s+shops\s+TO\s+app_rw\s*;/i.exec(migration);
  assert.ok(grant, '0165: không tìm thấy column grant UPDATE shops cho app_rw');
  const granted = new Set(grant[1].split(',').map((column) => column.trim().toLowerCase()).filter(Boolean));

  const used = new Set();
  let updates = 0;
  for (const file of jsFilesUnder('apps/seller/src')) {
    const src = readFileSync(file, 'utf8');
    const path = relative(ROOT, file);

    assert.doesNotMatch(src, /\bINSERT\s+INTO\s+shops\b/i, `${path}: seller không được tạo tenant root`);
    assert.doesNotMatch(src, /\bDELETE\s+FROM\s+shops\b/i, `${path}: seller không được xoá tenant root`);

    const update = /\bUPDATE\s+shops\s+SET\s+([\s\S]*?)\bWHERE\b/gi;
    let match;
    while ((match = update.exec(src)) !== null) {
      updates += 1;
      const whereStart = src.slice(update.lastIndex, update.lastIndex + 120);
      assert.match(
        whereStart,
        /^\s+id\s*=\s*current_shop_id\(\)/i,
        `${path}: UPDATE shops phải chốt đúng current_shop_id()`,
      );
      for (const assignment of match[1].matchAll(/(?:^|,)\s*([a-z_][a-z0-9_]*)\s*=/gi)) {
        used.add(assignment[1].toLowerCase());
      }
    }
  }

  assert.ok(updates > 0, 'không tìm thấy UPDATE shops nào trong seller — bộ dò có thể đã hỏng');
  const missingGrant = [...used].filter((column) => !granted.has(column)).sort();
  const unusedGrant = [...granted].filter((column) => !used.has(column)).sort();
  assert.deepEqual(
    { missingGrant, unusedGrant },
    { missingGrant: [], unusedGrant: [] },
    'route seller và column grant app_rw đã trôi lệch; sửa code/migration theo least privilege, đừng nới quyền toàn bảng',
  );
});

test('backfill went_live_at của 0165 chặn timestamp và đóng policy tạm', () => {
  const migration = doc('packages/db/migrations/0165_shop_go_live_privilege_guard.sql');
  const legacyStart = migration.indexOf('WITH readiness_cutoff AS');
  const legacyEnd = migration.indexOf('WITH first_orders AS', legacyStart);
  assert.ok(legacyStart >= 0 && legacyEnd > legacyStart, '0165: thiếu backfill legacy có cutoff');
  const legacy = migration.slice(legacyStart, legacyEnd);
  assert.match(legacy, /version\s*=\s*'0160_shop_readiness_go_live'/i);
  assert.match(legacy, /o\.created_at\s*<=\s*c\.applied_at/i,
    'chỉ đơn có trước lúc 0160 áp dụng mới được chứng minh shop là legacy');
  assert.match(legacy, /s\.status\s*=\s*'onboarding'/i,
    'backfill legacy không được tự đổi lifecycle của shop ngoài onboarding');
  assert.match(
    legacy,
    /SET\s+status\s*=\s*'active'\s*,[\s\S]*?went_live_at\s*=\s*LEAST\s*\(\s*now\(\)\s*,\s*GREATEST\s*\(\s*s\.created_at\s*,\s*f\.first_order_at\s*\)\s*\)/i,
    '0165 phải phục hồi shop onboarding legacy đã có đơn và chặn went_live_at trong biên hợp lệ',
  );

  const privilegeLock = migration.indexOf('REVOKE INSERT, UPDATE, DELETE ON shops FROM app_rw;');
  assert.ok(privilegeLock > 0, '0165: không tìm thấy mốc siết quyền app_rw');
  for (const policy of [
    'go_live_backfill_owner_read',
    'go_live_backfill_owner_update',
    'go_live_backfill_orders_owner_read',
  ]) {
    const created = migration.indexOf(`CREATE POLICY ${policy}`);
    const dropped = migration.indexOf(`DROP POLICY ${policy}`);
    assert.ok(created >= 0, `0165: thiếu policy tạm ${policy}`);
    assert.ok(dropped > created, `0165: policy tạm ${policy} chưa được DROP sau backfill`);
    assert.ok(dropped < privilegeLock, `0165: policy tạm ${policy} sống quá phạm vi backfill`);
  }

  const roleGrant = migration.indexOf('GRANT app_go_live TO app_owner;');
  const executeGrant = migration.indexOf(
    'GRANT EXECUTE ON FUNCTION activate_current_shop_after_readiness() TO app_rw;',
  );
  const ownerChange = migration.indexOf(
    'ALTER FUNCTION activate_current_shop_after_readiness() OWNER TO app_go_live;',
  );
  const roleRevoke = migration.indexOf('REVOKE app_go_live FROM app_owner;');
  assert.ok(
    roleGrant >= 0 && roleGrant < executeGrant && executeGrant < ownerChange && ownerChange < roleRevoke,
    '0165: app_owner phải GRANT EXECUTE khi còn sở hữu hàm, rồi mới chuyển owner và thu hồi membership',
  );
});
