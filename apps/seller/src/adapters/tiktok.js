import { parseAmount } from '../import-parse.js';
import { htmlToText } from '../html-to-text.js';

const str = (v) => String(v ?? '').trim();
const imageColumns = ['main_image', ...Array.from({ length: 8 }, (_, i) => `image_${i + 2}`)];
export const TIKTOK_COLUMNS = Object.freeze({
  product_id: 'handle', product_name: 'title', product_description: 'description', category: 'category',
  sku_id: 'source_ref.variant',
  price: 'price_vnd', quantity: 'stock', parcel_weight: 'weight_gram', variation_value: 'option1_value',
  main_image: 'image_url', image_2: 'image_url', image_3: 'image_url', image_4: 'image_url',
  image_5: 'image_url', image_6: 'image_url', image_7: 'image_url', image_8: 'image_url', image_9: 'image_url',
});

function asciiSlug(value, max = 60) {
  return str(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, (c) => c === 'Đ' ? 'D' : 'd')
    .replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toUpperCase().slice(0, max).replace(/-+$/g, '');
}

function uniqueSku(base, seen) {
  const root = (base || 'SAN-PHAM').slice(0, 60);
  let sku = root;
  let n = 2;
  while (seen.has(sku)) sku = `${root.slice(0, Math.max(1, 60 - String(n).length - 1))}-${n++}`;
  seen.add(sku);
  return sku;
}

function groupByProduct(rows) {
  const groups = [];
  const byId = new Map();
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i] ?? {};
    const id = str(raw.product_id);
    const key = id || `__dong_${i}`;
    let group = byId.get(key);
    if (!group) { group = { productId: id, rows: [] }; byId.set(key, group); groups.push(group); }
    group.rows.push({ raw, line: i + 2 });
  }
  return groups;
}

/** Chuẩn hoá dòng TikTok sang đúng hình dạng mà lõi import hiện có đã hiểu. */
export function adaptTiktok(rows, opts = {}) {
  const axisNames = opts.axisNames ?? {};
  const splitOff = opts.splitOff instanceof Set ? opts.splitOff : new Set(opts.splitOff ?? []);
  const out = [];
  const axisHints = [];
  const sourceRefs = { products: new Map(), variants: new Map() };
  const seenSku = new Set();

  for (const group of groupByProduct(rows)) {
    const { productId } = group;
    const splitCounts = group.rows.map(({ raw }) => splitOff.has(productId) ? 1 : str(raw.variation_value).split(', ').length);
    const axisCount = Math.max(1, ...splitCounts);
    const names = Array.isArray(axisNames[productId]) ? axisNames[productId] : [];
    const resolvedNames = Array.from({ length: axisCount }, (_, i) => str(names[i]) || (axisCount === 1 ? 'Phân loại' : `Phân loại ${i + 1}`));
    const sampleVariation = str(group.rows.find(({ raw }) =>
      (splitOff.has(productId) ? 1 : str(raw.variation_value).split(', ').length) === axisCount)?.raw?.variation_value)
      || str(group.rows[0]?.raw?.variation_value);
    axisHints.push({ productId, name: str(group.rows[0]?.raw?.product_name), count: axisCount,
      axisNames: resolvedNames, sample: sampleVariation,
      parts: splitOff.has(productId) ? [sampleVariation] : sampleVariation.split(', ') });

    const images = [];
    const seenImages = new Set();
    const descriptionImages = [];
    let cleanDescription = '';
    for (const { raw } of group.rows) {
      for (const col of imageColumns) {
        const url = str(raw[col]);
        if (url && !seenImages.has(url)) { seenImages.add(url); images.push(url); }
      }
      const clean = htmlToText(raw.product_description);
      if (!cleanDescription && clean.text) cleanDescription = clean.text;
      for (const url of clean.images) {
        if (url && !seenImages.has(url)) { seenImages.add(url); descriptionImages.push(url); }
      }
    }
    images.push(...descriptionImages);

    const title = str(group.rows.find(({ raw }) => str(raw.product_name))?.raw.product_name).slice(0, 255);
    const titleSku = asciiSlug(title, 24) || 'SAN-PHAM';
    for (let i = 0; i < group.rows.length; i++) {
      const { raw, line } = group.rows[i];
      const variation = str(raw.variation_value);
      const parts = splitOff.has(productId) ? [variation] : variation.split(', ');
      const category = str(raw.category).replace(/\s*\(\d+\)\s*$/, '').trim();
      const price = parseAmount(raw.price);
      const quantity = parseAmount(raw.quantity, 0);
      const weight = parseAmount(raw.parcel_weight);
      const skuBase = [titleSku, ...parts.map((v) => asciiSlug(v, 24)).filter(Boolean)].join('-');
      const sku = uniqueSku(skuBase, seenSku);
      const canonical = {
        handle: productId,
        title: i === 0 ? title : '',
        description: i === 0 ? cleanDescription : '',
        category: i === 0 ? category : '',
        sku,
        price_vnd: price,
        stock: Number.isInteger(quantity) && quantity >= 0 ? quantity : raw.quantity,
        weight_gram: weight,
        image_url: images[i] ?? '',
      };
      for (let ai = 0; ai < axisCount; ai++) {
        canonical[`option${ai + 1}_name`] = resolvedNames[ai];
        canonical[`option${ai + 1}_value`] = parts[ai] ?? '';
      }
      out.push(canonical);
      const variantExternalId = str(raw.sku_id);
      if (variantExternalId) sourceRefs.variants.set(sku, { externalId: variantExternalId, rawRow: raw, line });
    }
    // Ảnh vượt số biến thể được đặt ở dòng chỉ-có-ảnh; lõi import đã hỗ trợ hình dạng này.
    for (let i = group.rows.length; i < images.length; i++) out.push({ handle: productId, image_url: images[i] });
    if (productId) sourceRefs.products.set(productId, { externalId: productId, rawRow: group.rows[0]?.raw ?? {} });
  }
  return { rows: out, axisHints, sourceRefs };
}
