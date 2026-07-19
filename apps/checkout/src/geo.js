// Toán khoảng cách địa lý cho ship theo km (0089) — module THUẦN (không I/O) → test không cần mạng.

// Haversine: khoảng cách chim-bay giữa 2 điểm (km). Bán kính Trái Đất 6371km.
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Hộp bao QUỐC GIA Việt Nam (thô): chặn toạ độ ngoài VN (giả/rác) khỏi km-pricing → rơi phí vùng.
// Bbox 34 tỉnh chi tiết (đối chiếu coords↔tỉnh chọn) làm ở commit sau khi có provider reverse-geocode.
export const VN_BBOX = { latMin: 8.0, latMax: 23.6, lngMin: 102.0, lngMax: 109.6 };
export function inVietnam(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= VN_BBOX.latMin && lat <= VN_BBOX.latMax
    && lng >= VN_BBOX.lngMin && lng <= VN_BBOX.lngMax;
}
