/**
 * Bất biến: form sửa MỘT PHẦN hồ sơ cửa hàng không được xoá các cột nó không đụng tới.
 *
 * VÌ SAO CÓ. `PATCH /shops/:id` ghi đè toàn bộ 22 cột trong một câu UPDATE (chi tiết ở
 * src/shop-patch.js). Wizard onboarding chỉ hỏi 3 ô. Nếu nó POST đúng 3 ô đó thì phí ship,
 * ngưỡng miễn phí ship, ngưỡng sắp hết hàng, trần đơn chờ, toạ độ gốc giao hàng và hạn ẩn
 * danh PII của shop bị đặt về NULL — HTTP 200, không log, không ai biết.
 *
 * E2E KHÔNG bắt được lớp lỗi này một cách bền: bộ e2e chỉ khẳng định những cột nó nghĩ ra
 * lúc viết. Ngày thêm cột thứ 23 vào câu UPDATE, e2e vẫn xanh còn cột mới thì im lặng bị
 * xoá mỗi lần ai đó chạy wizard. Nên phép kiểm phải neo vào chính DANH SÁCH CỘT của seller.
 *
 * Chạy: node --test apps/seller-admin/test/shop-patch.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOP_PATCH_KEYS, shopPatchBody } from '../src/shop-patch.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELLER_SRC = path.join(HERE, '..', '..', 'seller', 'src', 'server.js');
const ADMIN_SRC = path.join(HERE, '..', 'src', 'server.js');

/** Bóc danh sách cột của câu `UPDATE shops SET … WHERE id = current_shop_id()` ở seller. */
function updateShopsColumns() {
  const src = fs.readFileSync(SELLER_SRC, 'utf8');
  // Neo vào `SET name = $1`: seller có ba câu `UPDATE shops SET` (activate, hồ sơ, require_mfa)
  // và bản đầu của regex này vớ phải câu activate rồi nuốt sang tận WHERE của câu sau — ra 2 cột
  // thay vì 22, tức là bộ test XANH GIẢ nếu ngưỡng đặt lỏng hơn.
  const m = /UPDATE shops SET (name = \$1[\s\S]*?)WHERE id = current_shop_id\(\)/.exec(src);
  assert.ok(m, 'không tìm thấy câu UPDATE shops SET … WHERE id = current_shop_id() trong seller — câu này bị đổi hình thì bộ test này mất tác dụng, sửa regex chứ đừng xoá test');
  // "name = $1, contact_email = $2, … ship_road_factor = COALESCE($21, ship_road_factor),"
  return [...m[1].matchAll(/(\w+)\s*=\s*(?:\$\d+|COALESCE\(\$\d+)/g)].map((x) => x[1]);
}

test('SHOP_PATCH_KEYS phủ ĐÚNG mọi cột mà PATCH /shops/:id ghi', () => {
  const cols = updateShopsColumns();
  assert.equal(cols.length, 22, `câu UPDATE ở seller có ${cols.length} cột, không phải 22`);
  const missing = cols.filter((c) => !SHOP_PATCH_KEYS.includes(c));
  const extra = SHOP_PATCH_KEYS.filter((k) => !cols.includes(k));
  assert.deepEqual(missing, [], `cột bị THIẾU trong SHOP_PATCH_KEYS — mọi form sửa một phần hồ sơ sẽ XOÁ TRẮNG cột này: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `SHOP_PATCH_KEYS có khoá seller không ghi (thừa hoặc đã đổi tên): ${extra.join(', ')}`);
});

test('body 3 ô của wizard KHÔNG đủ — đây là hình dạng sai mà test này canh', () => {
  // Ca thử đi qua ĐÚNG chốt: nếu ai đó "đơn giản hoá" onboardingSave thành POST thẳng 3 ô,
  // phép kiểm ở trên phải đỏ. Chứng minh bằng cách chạy chính phép kiểm ấy trên body sai.
  const naive = { name: 'Shop', contact_phone: '0912345678', business_address: 'Hà Nội' };
  const cols = updateShopsColumns();
  const wiped = cols.filter((c) => !Object.hasOwn(naive, c));
  assert.equal(wiped.length, 19, 'body 3 ô phải bỏ sót 19 cột — nếu con số này đổi thì hình dạng PATCH đã đổi');
  assert.ok(wiped.includes('ship_fee_vnd') && wiped.includes('pii_retention_months'),
    'phí ship và hạn ẩn danh PII phải nằm trong nhóm bị xoá — đó là hai cột đắt nhất');
});

test('shopPatchBody giữ nguyên mọi cột không sửa, kể cả cấu hình ship theo km', () => {
  // Hình dạng của một shop đã dùng thật: bật ship theo km (0089) + có hạn ẩn danh PII.
  const shop = {
    id: 'x', slug: 'minh-anh', status: 'active', logo_key: 'k/1.webp', require_mfa: true, // cột GET trả nhưng PATCH không ghi
    name: 'Cửa hàng Minh Anh', contact_email: 'shop@vd.vn', contact_phone: '0912345678', business_address: '12 Lê Lợi, Q1, TP.HCM',
    ship_fee_vnd: 25000, free_ship_threshold_vnd: 500000, low_stock_threshold: 3,
    max_pending_per_ip: 5, max_pending_per_phone: 3,
    ship_fee_far_vnd: 45000, ship_extra_per_500g_vnd: 5000, default_weight_gram: 800, ship_from_province: 'TP. Hồ Chí Minh',
    pii_retention_months: 24,
    ship_mode: 'distance', ship_origin_lat: '10.7769', ship_origin_lng: '106.7009', ship_base_vnd: 15000,
    ship_per_km_vnd: 4000, ship_max_km: 25, ship_road_factor: '1.30', ship_over_max_behavior: 'region',
  };
  const body = shopPatchBody(shop, { name: 'Minh Anh Store', contact_phone: '0987654321', business_address: '99 Hai Bà Trưng' });

  assert.equal(body.name, 'Minh Anh Store');           // ô wizard sửa → đè
  assert.equal(body.contact_phone, '0987654321');
  assert.equal(body.business_address, '99 Hai Bà Trưng');
  assert.equal(body.contact_email, 'shop@vd.vn');      // ô wizard KHÔNG hỏi → giữ

  for (const k of SHOP_PATCH_KEYS) {
    assert.ok(Object.hasOwn(body, k), `thiếu khoá ${k} → seller sẽ đặt cột đó về NULL`);
    assert.equal(typeof body[k], 'string', `${k} phải là chuỗi (seller parse từ chuỗi)`);
  }
  // Cấu hình ship theo km phải quay lại NGUYÊN VẸN, không thì seller từ chối
  // ('bật ship theo km cần toạ độ gốc cửa hàng') và cả wizard 400.
  assert.equal(body.ship_mode, 'distance');
  assert.equal(body.ship_origin_lat, '10.7769');
  assert.equal(body.ship_base_vnd, '15000');
  assert.equal(body.ship_max_km, '25');
  assert.equal(body.pii_retention_months, '24');       // bằng giá trị cũ ⇒ chốt owner-only không kích hoạt
  // Cột GET trả về nhưng PATCH không ghi thì KHÔNG được lọt vào body.
  for (const k of ['id', 'slug', 'status', 'logo_key', 'require_mfa']) {
    assert.ok(!Object.hasOwn(body, k), `${k} không thuộc PATCH, gửi lên là rác`);
  }
});

test('null hoá chuỗi RỖNG, không phải chữ "null"', () => {
  // 'null' đi qua parseMoney thì thành NULL (may), nhưng ở cột chữ ship_from_province nó
  // nằm nguyên → isProvince() từ chối → cả form 400 và không ai đoán ra vì sao.
  const body = shopPatchBody({ name: 'S', ship_from_province: null, ship_fee_vnd: null, ship_road_factor: undefined }, {});
  assert.equal(body.ship_from_province, '');
  assert.equal(body.ship_fee_vnd, '');
  assert.equal(body.ship_road_factor, '');
  assert.ok(!Object.values(body).includes('null'), 'không được có giá trị nào là chuỗi "null"');
  // shop rỗng hoàn toàn (không GET được) vẫn ra đủ khoá, không ném.
  assert.equal(Object.keys(shopPatchBody(null, {})).length, SHOP_PATCH_KEYS.length);
});

test('wizard onboarding thật sự đi qua shopPatchBody, không PATCH thẳng', () => {
  // Chốt cuối: hàm helper đúng mà chỗ gọi không dùng thì vẫn mất dữ liệu như cũ.
  const src = fs.readFileSync(ADMIN_SRC, 'utf8');
  const m = /async function onboardingSave\(([\s\S]*?)\n}/.exec(src);
  assert.ok(m, 'không tìm thấy onboardingSave trong seller-admin');
  assert.match(m[1], /PATCH['"`],\s*`\/shops\/\$\{shopId\}`,\s*\{\s*cookie,\s*body:\s*shopPatchBody\(/,
    'onboardingSave phải PATCH bằng shopPatchBody(cur.json, …) — dựng body tay là mở lại lỗ xoá cột');
  assert.match(m[1], /GET['"`],\s*`\/shops\/\$\{shopId\}`/,
    'phải ĐỌC hồ sơ hiện tại trước khi ghi; không đọc thì không có gì để trộn');
});
