import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptTiktok } from '../src/adapters/tiktok.js';
import { detectSource, inspectSourceColumns } from '../src/adapters/index.js';

const rows = [
  { product_id: '1111111111111111111', product_name: 'Vòng tay ống kiểu lưới',
    product_description: '<p>Mô tả&nbsp;đẹp</p><img src="https://img/mo-ta.jpg">',
    category: 'Vòng tay & Lắc tay (123)', price: '199.000 ₫', quantity: '4', parcel_weight: '200',
    variation_value: 'Đỏ, 48cm', sku_id: '9000000000000000001', main_image: 'https://img/main.jpg', image_2: 'https://img/two.jpg' },
  { product_id: '1111111111111111111', product_name: 'Vòng tay ống kiểu lưới',
    product_description: '<p>Mô tả&nbsp;đẹp</p><img src="https://img/mo-ta.jpg">',
    category: 'Vòng tay & Lắc tay (123)', price: '209000', quantity: '2', parcel_weight: '200',
    variation_value: 'Xanh, 50cm (vừa cổ)', sku_id: '9000000000000000002', main_image: 'https://img/main.jpg', image_2: 'https://img/two.jpg' },
  { product_id: '1111111111111111111', product_name: 'Vòng tay ống kiểu lưới',
    product_description: '', category: 'Vòng tay & Lắc tay (123)', price: '209000', quantity: '1', parcel_weight: '200',
    variation_value: 'Xanh, 50cm (vừa cồ)', sku_id: '9000000000000000003', main_image: 'https://img/main.jpg' },
];

test('nhận dạng TikTok, tách đúng ", ", giữ lỗi chính tả và sinh SKU đọc được', () => {
  assert.equal(detectSource(rows), 'tiktok');
  const out = adaptTiktok(rows, { axisNames: { '1111111111111111111': ['Màu', 'Chiều dài'] } });
  const variants = out.rows.filter((r) => r.sku);
  assert.equal(variants.length, 3);
  assert.deepEqual(variants.map((r) => r.option2_value), ['48cm', '50cm (vừa cổ)', '50cm (vừa cồ)']);
  assert.ok(variants.every((r) => !/^\d{19}$/.test(r.sku)));
  assert.equal(new Set(variants.map((r) => r.sku)).size, 3);
  assert.equal(variants[0].category, 'Vòng tay & Lắc tay');
  assert.equal(variants[0].description, 'Mô tả đẹp');
  assert.equal(out.sourceRefs.products.get('1111111111111111111')?.rawRow, rows[0]);
  assert.equal(out.sourceRefs.variants.get(variants[0].sku)?.externalId, '9000000000000000001');
  assert.equal(out.sourceRefs.variants.get(variants[0].sku)?.rawRow, rows[0]);
});

test('mẫu thật 7 SKU ra một trục và 16 SKU ra hai trục', () => {
  const motTrucId = '1731037612150720606';
  const haiTrucId = '1731277253352720478';
  const motTruc = ['48', '50', '52', '54', '56', '58', '60'].map((variation, i) => ({
    product_id: motTrucId, product_name: 'Vòng tay ống kiểu lưới', product_description: '<p>Vòng tay</p>',
    category: 'Vòng tay & Lắc tay (605274)', price: '450000', quantity: '49', parcel_weight: '200',
    variation_value: variation, sku_id: String(1731037645341100126n + BigInt(i)),
  }));
  const lengths = ['45cm', '50cm', '55cm', '60cm'];
  const haiTruc = lengths.flatMap((a, ai) => lengths.map((b, bi) => ({
    product_id: haiTrucId, product_name: 'Dây chuyền trúc bọng 3c', product_description: '<p>Dây chuyền</p>',
    category: 'Dây chuyền (605280)', price: '550000', quantity: '49', parcel_weight: '200',
    variation_value: `${a}, ${b}`, sku_id: String(1734823571014976606n + BigInt(ai * 4 + bi)),
  })));

  const out = adaptTiktok([...motTruc, ...haiTruc]);
  const variants = out.rows.filter((r) => r.sku);
  const oneAxis = variants.filter((r) => r.handle === motTrucId);
  const twoAxes = variants.filter((r) => r.handle === haiTrucId);
  assert.equal(oneAxis.length, 7);
  assert.ok(oneAxis.every((r) => r.option1_value && r.option2_value === undefined));
  assert.equal(twoAxes.length, 16);
  assert.ok(twoAxes.every((r) => r.option1_value && r.option2_value));
  assert.deepEqual(out.axisHints.map((h) => [h.productId, h.count]), [[motTrucId, 1], [haiTrucId, 2]]);
  assert.equal(out.sourceRefs.variants.size, 23);
});

test('hình dạng 641 dòng được gom thành 124 sản phẩm, gồm 121 một trục và 3 hai trục', () => {
  const generated = [];
  let sku = 1739000000000000000n;
  const images = (productId, hasThird) => ({
    main_image: `https://img.test/${productId}/1.jpg`,
    image_2: `https://img.test/${productId}/2.jpg`,
    ...(hasThird ? { image_3: `https://img.test/${productId}/3.jpg` } : {}),
  });
  for (let product = 0; product < 121; product++) {
    const productId = String(1738000000000000000n + BigInt(product));
    const variants = product < 12 ? 4 : 5;
    const hasThird = product < 2 || (product >= 12 && product < 59);
    for (let variant = 0; variant < variants; variant++) {
      generated.push({
        product_id: productId, product_name: `Sản phẩm ${product}`, product_description: '<p>Mô tả</p>',
        category: 'Danh mục (1)', price: '100000', quantity: '1', parcel_weight: '200',
        variation_value: `V${variant}`, sku_id: String(sku++), ...images(productId, hasThird),
      });
    }
  }
  for (let product = 0; product < 3; product++) {
    const productId = String(1738100000000000000n + BigInt(product));
    for (let first = 0; first < 4; first++) {
      for (let second = 0; second < 4; second++) {
        generated.push({
          product_id: productId, product_name: `Sản phẩm hai trục ${product}`, product_description: '<p>Mô tả</p>',
          category: 'Danh mục (1)', price: '100000', quantity: '1', parcel_weight: '200',
          variation_value: `A${first}, B${second}`, sku_id: String(sku++), ...images(productId, product < 2),
        });
      }
    }
  }

  const out = adaptTiktok(generated);
  const sourceImageCells = generated.reduce((sum, row) => sum
    + ['main_image', 'image_2', 'image_3'].filter((key) => row[key]).length, 0);
  const queuedImages = new Set(out.rows.map((row) => row.image_url).filter(Boolean));
  assert.equal(generated.length, 641);
  assert.equal(sourceImageCells, 1557);
  assert.equal(queuedImages.size, 299);
  assert.equal(out.rows.filter((r) => r.sku).length, 641);
  assert.equal(out.rows.filter((r) => /<|&nbsp;/i.test(r.description ?? '')).length, 0);
  assert.ok(out.rows.filter((r) => r.sku).every((r) => r.weight_gram === 200));
  assert.equal(out.axisHints.length, 124);
  assert.equal(out.axisHints.filter((h) => h.count === 1).length, 121);
  assert.equal(out.axisHints.filter((h) => h.count === 2).length, 3);
  assert.equal(out.sourceRefs.products.size, 124);
  assert.equal(out.sourceRefs.variants.size, 641);
});

test('khử trùng ảnh và xếp ảnh mô tả sau ảnh sản phẩm', () => {
  const out = adaptTiktok(rows);
  assert.deepEqual(out.rows.map((r) => r.image_url).filter(Boolean), [
    'https://img/main.jpg', 'https://img/two.jpg', 'https://img/mo-ta.jpg',
  ]);
});

test('tắt tách giữ nguyên dấu phẩy và ép về một trục', () => {
  const out = adaptTiktok(rows, { splitOff: new Set(['1111111111111111111']) });
  const first = out.rows.find((r) => r.sku);
  assert.equal(first.option1_value, 'Đỏ, 48cm');
  assert.equal(first.option2_value, undefined);
});

test('báo sku_id là tham chiếu được lưu, không ghi nhầm thành cột bị bỏ qua', () => {
  const columns = inspectSourceColumns([{ product_id: '1', variation_value: 'A', sku_id: '2', cod: 'Y' }], 'tiktok');
  assert.ok(columns.recognised.some((c) => c.header === 'sku_id' && c.field === 'source_ref.variant'));
  assert.ok(!columns.ignored.includes('sku_id'));
  assert.ok(columns.ignored.includes('cod'));
});
