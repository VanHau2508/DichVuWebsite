function weightSurcharge(cfg, items) {
  if (!(cfg.extraPer500g > 0)) return 0;
  const grams = items.reduce(
    (sum, item) => sum + Number(item.qty) * (item.weight_gram != null
      ? Number(item.weight_gram)
      : cfg.defaultWeightGram),
    0,
  );
  return Math.ceil(Math.max(0, grams - 500) / 500) * cfg.extraPer500g;
}

function regionFeeCore(cfg, items, toRegion, assumeFarWhenUnknown) {
  let fee = cfg.fee;
  if (cfg.feeFar != null && cfg.fromRegion) {
    fee = toRegion == null
      ? (assumeFarWhenUnknown ? cfg.feeFar : cfg.fee)
      : (toRegion === cfg.fromRegion ? cfg.fee : cfg.feeFar);
  }
  return fee + weightSurcharge(cfg, items);
}

// Returns null when a verified distance is outside a shop's delivery area.
export function computeShipping(
  cfg,
  subtotal,
  items,
  toRegion,
  { assumeFarWhenUnknown = false, coordsValid = false, distanceMeters = null } = {},
) {
  if (!items.length) return 0;
  const freeship = cfg.threshold != null && subtotal >= cfg.threshold;
  if (cfg.mode === 'distance' && coordsValid && distanceMeters != null) {
    const km = Math.ceil(distanceMeters / 1000);
    if (cfg.maxKm != null && km > cfg.maxKm) {
      if (cfg.overMax === 'reject') return null;
      return freeship ? 0 : regionFeeCore(cfg, items, toRegion, assumeFarWhenUnknown);
    }
    if (freeship) return 0;
    const distanceFee = cfg.base + km * cfg.perKm + weightSurcharge(cfg, items);
    return Math.max(distanceFee, regionFeeCore(cfg, items, toRegion, assumeFarWhenUnknown));
  }
  if (freeship) return 0;
  return regionFeeCore(cfg, items, toRegion, assumeFarWhenUnknown);
}
