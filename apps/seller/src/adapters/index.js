import { adaptTiktok, TIKTOK_COLUMNS } from './tiktok.js';

const keys = (rows) => new Set(rows.flatMap((r) => Object.keys(r ?? {}).map((k) => String(k).trim().toLowerCase())));

export function detectSource(rows) {
  const found = keys(rows);
  if (found.has('product_id') && found.has('variation_value')) return 'tiktok';
  if (found.has('handle') || found.has('variant sku')) return 'shopify';
  return 'chuẩn';
}

export function adaptRows(rows, opts = {}) {
  const source = detectSource(rows);
  if (source === 'tiktok') return { source, ...adaptTiktok(rows, opts) };
  return { source, rows, axisHints: [], sourceRefs: { products: new Map(), variants: new Map() } };
}

export function inspectSourceColumns(rows, source) {
  if (source !== 'tiktok') return null;
  const headers = new Set(rows.flatMap((r) => Object.keys(r ?? {})));
  const recognised = [], ignored = [];
  for (const header of headers) {
    const field = TIKTOK_COLUMNS[String(header).trim().toLowerCase()];
    if (field) recognised.push({ header, field });
    else ignored.push(header);
  }
  return { recognised, ignored };
}
