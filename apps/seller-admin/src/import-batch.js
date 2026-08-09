const norm = (v) => String(v ?? '').trim();

function groupKey(row, index) {
  const entries = Object.entries(row ?? {});
  const find = (wanted) => entries.find(([k]) => String(k).trim().toLowerCase() === wanted)?.[1];
  return norm(find('product_id')) || norm(find('handle')) || `__dong_${index}`;
}

export function countProductGroups(rows) {
  const keys = new Set();
  for (let i = 0; i < rows.length; i++) keys.add(groupKey(rows[i], i));
  return keys.size;
}

function byteLength(rows) {
  return Buffer.byteLength(JSON.stringify({ rows }), 'utf8');
}

/** Chia lô mà một product_id/handle luôn nằm trọn trong đúng một lô. */
export function splitProductBatches(rows, { maxProducts = 200, maxBytes = 1_500_000 } = {}) {
  const groups = [];
  const byKey = new Map();
  for (let i = 0; i < rows.length; i++) {
    const key = groupKey(rows[i], i);
    let group = byKey.get(key);
    if (!group) { group = []; byKey.set(key, group); groups.push(group); }
    group.push(rows[i]);
  }
  const batches = [];
  let current = [];
  let products = 0;
  for (const group of groups) {
    if (byteLength(group) > maxBytes) throw new Error('Một sản phẩm quá lớn để gửi sang dịch vụ nhập');
    const candidate = current.concat(group);
    if (current.length && (products + 1 > maxProducts || byteLength(candidate) > maxBytes)) {
      batches.push(current);
      current = [];
      products = 0;
    }
    current.push(...group);
    products++;
  }
  if (current.length) batches.push(current);
  return batches;
}

export function mergeImportResults(results) {
  const out = { dry_run: results.every((r) => r.dry_run === true), rows: 0, groups: 0, created: 0,
    variants: 0, failed: 0, skipped_existing: 0, errors: [], preview: [], axisHints: [],
    images: { queued: 0, invalid: 0, skipped: 0 }, columns: { recognised: [], ignored: [] } };
  const recognised = new Set();
  const ignored = new Set();
  for (const r of results) {
    for (const key of ['rows', 'groups', 'created', 'variants', 'failed', 'skipped_existing']) out[key] += Number(r[key] ?? 0);
    for (const key of ['queued', 'invalid', 'skipped']) out.images[key] += Number(r.images?.[key] ?? 0);
    out.errors.push(...(r.errors ?? []));
    out.preview.push(...(r.preview ?? []));
    out.axisHints.push(...(r.axisHints ?? []));
    for (const c of r.columns?.recognised ?? []) {
      const id = `${c.header}\u0000${c.field}`;
      if (!recognised.has(id)) { recognised.add(id); out.columns.recognised.push(c); }
    }
    for (const h of r.columns?.ignored ?? []) if (!ignored.has(h)) { ignored.add(h); out.columns.ignored.push(h); }
  }
  out.errors = out.errors.slice(0, 100);
  out.preview = out.preview.slice(0, 20);
  return out;
}
