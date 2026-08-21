import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { can, permsFor, needsStepUp, ROLES } from '../src/rbac.js';

const resolutionSource = readFileSync(new URL('../src/order-resolutions.js', import.meta.url), 'utf8');

test('owner có mọi quyền', () => {
  for (const p of ['catalog.write', 'orders.write', 'refund', 'members.write', 'domain.write', 'export']) {
    assert.equal(can('owner', p), true, p);
  }
});

test('admin: sản phẩm + đơn + hoàn tiền + theme + XEM nhân sự, KHÔNG đổi quyền/domain/export', () => {
  assert.equal(can('admin', 'catalog.write'), true);
  assert.equal(can('admin', 'orders.write'), true);
  assert.equal(can('admin', 'refund'), true);
  assert.equal(can('admin', 'theme.write'), true);
  assert.equal(can('admin', 'members.read'), true);
  assert.equal(can('admin', 'members.write'), false); // chỉ owner đổi quyền
  assert.equal(can('admin', 'domain.write'), false);
  assert.equal(can('admin', 'export'), false);
});

test('catalog_manager: chỉ sản phẩm', () => {
  assert.equal(can('catalog_manager', 'catalog.read'), true);
  assert.equal(can('catalog_manager', 'catalog.write'), true);
  assert.equal(can('catalog_manager', 'orders.read'), false);
  assert.equal(can('catalog_manager', 'members.read'), false);
});

test('order_manager: chỉ đơn hàng', () => {
  assert.equal(can('order_manager', 'orders.read'), true);
  assert.equal(can('order_manager', 'orders.write'), true);
  assert.equal(can('order_manager', 'catalog.read'), false);
  assert.equal(can('order_manager', 'refund'), false); // hoàn tiền không thuộc order manager
});

test('chốt COD và chốt bằng refund là hai route quyền khác nhau', () => {
  const routeLines = resolutionSource.split('\n').filter((line) => line.includes("{ m: 'POST'") && line.includes('accept-partial'));
  const plain = routeLines.filter((line) => line.includes('accept-partial$'));
  const withRefund = routeLines.filter((line) => line.includes('accept-partial-with-refund'));
  assert.equal(plain.length, 2, 'hai alias accept-partial phải còn cho client cũ');
  assert.ok(plain.every((line) => line.includes("perm: 'orders.write'") && !line.includes('stepUp: true')));
  assert.equal(withRefund.length, 2, 'hai alias refund phải cùng được bảo vệ');
  assert.ok(withRefund.every((line) => line.includes("perm: 'refund'") && line.includes('stepUp: true')));
});

test('audit.read: owner + admin xem nhật ký; catalog/order manager thì không', () => {
  assert.equal(can('owner', 'audit.read'), true);
  assert.equal(can('admin', 'audit.read'), true);
  assert.equal(can('catalog_manager', 'audit.read'), false);
  assert.equal(can('order_manager', 'audit.read'), false);
  assert.equal(needsStepUp('audit.read'), false); // chỉ đọc, không cần step-up
});

test('vai trò lạ không có quyền nào', () => {
  assert.equal(can('nobody', 'catalog.read'), false);
  assert.equal(can(undefined, 'catalog.read'), false);
});

test('thao tác nhạy cảm cần step-up', () => {
  assert.equal(needsStepUp('members.write'), true);
  assert.equal(needsStepUp('domain.write'), true);
  assert.equal(needsStepUp('export'), true);
  assert.equal(needsStepUp('refund'), true);
  assert.equal(needsStepUp('catalog.read'), false);
  assert.equal(needsStepUp('orders.read'), false);
});

test('permsFor liệt kê đúng, owner nhiều nhất', () => {
  assert.ok(permsFor('owner').length > permsFor('admin').length);
  assert.ok(permsFor('admin').length > permsFor('catalog_manager').length);
  assert.deepEqual(permsFor('order_manager').sort(), ['orders.read', 'orders.write']);
});

test('bốn vai trò khớp CHECK của DB', () => {
  assert.deepEqual(ROLES.sort(), ['admin', 'catalog_manager', 'order_manager', 'owner']);
});

test('reports.read: owner + admin xem báo cáo lãi; manager thì không (giá vốn = bí mật kinh doanh)', () => {
  assert.equal(can('owner', 'reports.read'), true);
  assert.equal(can('admin', 'reports.read'), true);
  assert.equal(can('catalog_manager', 'reports.read'), false); // NHẬP được cost (catalog.write) nhưng không XEM lãi
  assert.equal(can('order_manager', 'reports.read'), false);
  assert.equal(needsStepUp('reports.read'), false); // xem hằng ngày, không step-up
});

test('privacy.erase: CHỈ owner + bắt buộc step-up (ẩn danh là thao tác huỷ dữ liệu)', () => {
  assert.equal(can('owner', 'privacy.erase'), true);
  assert.equal(can('admin', 'privacy.erase'), false);
  assert.equal(can('catalog_manager', 'privacy.erase'), false);
  assert.equal(can('order_manager', 'privacy.erase'), false);
  assert.equal(needsStepUp('privacy.erase'), true);
});
