// Reverse geocode (toạ độ → địa chỉ) + chuẩn hoá tỉnh về 34 tỉnh (0089 GPS checkout).
// Gọi Ở SERVER (key giấu, CSP trình duyệt sạch). Provider cắm được: dev/test='stub' (in-process,
// KHÔNG gọi mạng), prod='goong' (rsapi.goong.io). Mọi lỗi → ném GeoError → endpoint SOFT-FALLBACK
// (khách nhập tay + ship theo tỉnh) → đặt đơn ĐỘC LẬP uptime provider.
import { PROVINCES } from './provinces.js';

export class GeoError extends Error {}
const PROVIDER = (process.env.GEOCODE_PROVIDER ?? 'stub').toLowerCase();
const API_BASE = (process.env.GEOCODE_API_BASE ?? 'https://rsapi.goong.io').replace(/\/+$/, '');
const API_KEY = process.env.GEOCODE_API_KEY ?? '';
const TIMEOUT_MS = Number(process.env.GEOCODE_TIMEOUT_MS ?? 4000);
export const GEOCODE_ON = API_KEY.length > 0; // thiếu key → nút GPS tắt gọn (như KEY_OK shipping)

// unaccent + bỏ tiền tố tỉnh/thành để so khớp (Goong trả tên cũ 63 / biến thể dấu).
const strip = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\b(thanh pho|tp\.?|tinh)\b/g, ' ').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
const PROV_INDEX = new Map(PROVINCES.map((p) => [strip(p), p]));
// Alias tên cũ/biến thể hay gặp → 1/34 (sáp nhập 2025). DANH SÁCH TỐI THIỂU — thiếu → normalizeProvince
// trả null → checkout ÉP khách chọn tỉnh tay (TUYỆT ĐỐI không ghi tỉnh ngoài-34 → vận đơn GHN/GHTK an toàn).
// Bảng đầy đủ 63→34 tinh chỉnh sau khi kiểm dữ liệu Goong thực tế (red-team must-fix: fail-safe null).
const ALIAS = new Map(Object.entries({
  'ho chi minh': 'TP. Hồ Chí Minh', 'sai gon': 'TP. Hồ Chí Minh', 'hcm': 'TP. Hồ Chí Minh',
  'thua thien hue': 'Huế', 'hue': 'Huế',
}).map(([k, v]) => [strip(k), v]));
export function normalizeProvince(raw) {
  const s = strip(raw);
  if (!s) return null;
  return PROV_INDEX.get(s) ?? ALIAS.get(s) ?? null; // null = ép chọn tay
}

// Đọc body provider có TRẦN byte (red-team: provider hỏng trả trang khổng lồ trên đường checkout nóng).
async function readCapped(r, cap) {
  const reader = r.body?.getReader?.();
  if (!reader) return String(await r.text()).slice(0, cap);
  let out = '', total = 0; const dec = new TextDecoder();
  for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > cap) { await reader.cancel(); throw new GeoError('response too large'); } out += dec.decode(value, { stream: true }); }
  return out;
}

async function reverseGoong({ lat, lng }) {
  // SSRF khoá cứng: URL toàn từ env + path cố định + key server; input client CHỈ 2 SỐ đã validate.
  const url = `${API_BASE}/Geocode?latlng=${Number(lat)},${Number(lng)}&api_key=${encodeURIComponent(API_KEY)}`;
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'manual' }); // manual → chặn SSRF-redirect
    if (r.status !== 200) throw new GeoError(`goong ${r.status}`);
    if (!/application\/json/i.test(r.headers.get('content-type') ?? '')) throw new GeoError('goong non-json');
    const j = JSON.parse(await readCapped(r, 65536));
    const res0 = j?.results?.[0]; if (!res0) throw new GeoError('goong empty');
    const c0 = res0.compound ?? {};
    return { province: c0.province ?? '', district: c0.district ?? '', ward: c0.commune ?? '', line: String(res0.formatted_address ?? '').slice(0, 300) };
  } catch (e) { throw (e instanceof GeoError ? e : new GeoError(e.name === 'AbortError' ? 'timeout' : e.message)); }
  finally { clearTimeout(t); }
}

// STUB (dev + e2e): địa chỉ TẤT ĐỊNH theo toạ độ, KHÔNG gọi mạng. Dải vĩ độ [22.90,23.00] → ném
// GeoError để test SOFT-FALLBACK provider-lỗi (endpoint vẫn trả available:false, checkout vẫn đặt được).
function reverseStub({ lat, lng }) {
  if (lat >= 22.90 && lat <= 23.00) throw new GeoError('stub-forced-fail');
  const province = lat > 19 ? 'Hà Nội' : lat > 14 ? 'Đà Nẵng' : lat > 10.6 ? 'TP. Hồ Chí Minh' : 'Cà Mau';
  const num = (Math.abs(Math.round(lng * 1000)) % 900) + 1;
  return { province, district: 'Quận Trung Tâm', ward: 'Phường 1', line: `Số ${num} Đường Mẫu, Phường 1` };
}

export async function reverseGeocode(coords) {
  return PROVIDER === 'goong' ? reverseGoong(coords) : reverseStub(coords);
}
