/**
 * Adapter hãng vận chuyển (GHN / GHTK) — tạo vận đơn + tra trạng thái.
 *
 * Bám TÀI LIỆU CÔNG KHAI của hai hãng (GHN v2 shiip public-api; GHTK services API).
 * Dev/e2e trỏ GHN_API_BASE / GHTK_API_BASE vào stub (http://dbtest:PORT). LƯU Ý go-live:
 * cần API key THẬT của shop để kiểm thử thật — hình dạng response hãng có thể lệch docs.
 *
 * Hợp đồng adapter (đồng nhất 2 hãng):
 *   carrierCreate(provider, cfg, s)  → { tracking, fee }  | throw CarrierError(message)
 *   carrierStatus(provider, cfg, tracking) → { state: 'shipping'|'delivered'|'returned'|'cancelled', raw }
 * cfg = { token, ghnShopId? }  (token ĐÃ giải mã)
 */

const GHN_BASE = (process.env.GHN_API_BASE ?? 'https://online-gateway.ghn.vn/shiip/public-api').replace(/\/+$/, '');
const GHTK_BASE = (process.env.GHTK_API_BASE ?? 'https://services.giaohangtietkiem.vn').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.CARRIER_TIMEOUT_MS) || 10000;

// CarrierError.ambiguous = true khi KHÔNG BIẾT hãng đã nhận lệnh chưa (timeout/đứt mạng
// giữa chừng) — caller KHÔNG được xoá claim rồi retry mù (nguy cơ tạo VẬN ĐƠN THẬT thứ 2).
// Hãng trả lời rõ ràng (4xx/5xx có body) = không ambiguous, retry an toàn.
export class CarrierError extends Error {
  constructor(message, { ambiguous = false } = {}) { super(message); this.ambiguous = ambiguous; }
}

async function call(url, { method = 'POST', headers = {}, body } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: r.status, json };
  } catch (e) {
    throw new CarrierError(
      e.name === 'AbortError' ? 'hãng vận chuyển không phản hồi (timeout)' : `không gọi được hãng vận chuyển: ${e.message}`,
      { ambiguous: true }, // timeout/mạng = không rõ hãng đã nhận chưa
    );
  } finally { clearTimeout(t); }
}

// ── GHN (v2, header Token + ShopId; số nhà + phường/quận/tỉnh dạng TÊN) ────────
async function ghnCreate(cfg, s) {
  const { status, json } = await call(`${GHN_BASE}/v2/shipping-order/create`, {
    headers: { Token: cfg.token, ShopId: String(cfg.ghnShopId ?? '') },
    body: {
      payment_type_id: 1,                    // shop trả phí ship (khách trả qua phí đơn)
      client_order_code: s.ref,              // idempotent theo ĐƠN: GHN từ chối mã trùng → retry không tạo vận đơn thứ 2
      required_note: 'CHOXEMHANGKHONGTHU',
      to_name: s.toName, to_phone: s.toPhone, to_address: s.toAddress,
      to_ward_name: s.toWard ?? '', to_district_name: s.toDistrict, to_province_name: s.toProvince,
      cod_amount: s.codAmount, insurance_value: Math.min(s.value, 5_000_000),
      weight: s.weightGram, length: 30, width: 20, height: 10,
      service_type_id: 2,                    // hàng nhẹ (chuẩn e-commerce)
      items: s.items.map((i) => ({ name: i.name.slice(0, 100), quantity: i.qty, weight: Math.ceil(s.weightGram / s.items.length) })),
      note: s.note ?? '',
    },
  });
  if (status !== 200 || json?.code !== 200 || !json?.data?.order_code) {
    throw new CarrierError(`GHN từ chối tạo vận đơn: ${json?.message ?? json?.code_message_value ?? `HTTP ${status}`}`);
  }
  return { tracking: String(json.data.order_code), fee: Number(json.data.total_fee ?? 0) };
}

async function ghnStatus(cfg, tracking) {
  const { status, json } = await call(`${GHN_BASE}/v2/shipping-order/detail`, {
    headers: { Token: cfg.token },
    body: { order_code: tracking },
  });
  if (status !== 200 || json?.code !== 200) throw new CarrierError(`GHN tra trạng thái lỗi: ${json?.message ?? `HTTP ${status}`}`);
  const st = String(json?.data?.status ?? '');
  const state = st === 'delivered' ? 'delivered'
    : st === 'cancel' ? 'cancelled'
    : ['return', 'returned', 'return_transporting', 'return_sorting', 'returning', 'return_fail'].includes(st) ? 'returned'
    : 'shipping';
  return { state, raw: st };
}

// ── GHTK (header Token; địa chỉ dạng TÊN tỉnh/quận) ───────────────────────────
async function ghtkCreate(cfg, s) {
  const { status, json } = await call(`${GHTK_BASE}/services/shipment/order`, {
    headers: { Token: cfg.token },
    body: {
      products: s.items.map((i) => ({ name: i.name.slice(0, 100), quantity: i.qty, weight: Math.max(0.1, s.weightGram / 1000 / s.items.length), price: i.price })),
      order: {
        id: s.ref,                            // mã tham chiếu duy nhất phía mình
        pick_name: s.pickup.name, pick_tel: s.pickup.phone, pick_address: s.pickup.address,
        pick_province: s.pickup.province, pick_district: s.pickup.district, pick_ward: s.pickup.ward ?? '',
        name: s.toName, tel: s.toPhone, address: s.toAddress,
        province: s.toProvince, district: s.toDistrict, ward: s.toWard ?? '', hamlet: 'Khác',
        pick_money: s.codAmount, value: Math.min(s.value, 20_000_000),
        // is_freeship=1: shipper CHỈ thu đúng pick_money — khách ĐÃ trả phí ship trong
        // total_vnd của đơn (đồng nhất GHN payment_type_id=1). is_freeship=0 sẽ khiến
        // shipper thu THÊM phí ship lần 2. Go-live: xác nhận lại với token GHTK thật.
        transport: 'road', is_freeship: 1, note: s.note ?? '',
      },
    },
  });
  if (status !== 200 || json?.success !== true || !json?.order?.label) {
    throw new CarrierError(`GHTK từ chối tạo vận đơn: ${json?.message ?? `HTTP ${status}`}`);
  }
  return { tracking: String(json.order.label), fee: Number(json.order.fee ?? 0) };
}

async function ghtkStatus(cfg, tracking) {
  const { status, json } = await call(`${GHTK_BASE}/services/shipment/v2/${encodeURIComponent(tracking)}`, {
    method: 'GET', headers: { Token: cfg.token },
  });
  if (status !== 200 || json?.success !== true) throw new CarrierError(`GHTK tra trạng thái lỗi: ${json?.message ?? `HTTP ${status}`}`);
  const st = Number(json?.order?.status ?? json?.order?.status_id ?? 0);
  // Bảng mã GHTK: 5=đã giao, 6=đã đối soát(sau giao), -1=huỷ, 9=không giao được, 20/21=trả hàng.
  const state = st === 5 || st === 6 ? 'delivered'
    : st === -1 ? 'cancelled'
    : st === 9 || st === 20 || st === 21 ? 'returned'
    : 'shipping';
  return { state, raw: String(st) };
}

export function carrierCreate(provider, cfg, shipment) {
  if (provider === 'ghn') return ghnCreate(cfg, shipment);
  if (provider === 'ghtk') return ghtkCreate(cfg, shipment);
  throw new CarrierError('hãng vận chuyển không được hỗ trợ');
}

// ── KIỂM TRA KẾT NỐI (0đ, KHÔNG tạo đơn) ──────────────────────────────────────
// GHTK: gọi API TÍNH PHÍ (chỉ hỏi giá) — token sai/thiếu quyền → hãng trả lỗi.
async function ghtkFee(cfg, s) {
  const q = new URLSearchParams({
    pick_province: s.pickup.province, pick_district: s.pickup.district,
    province: s.toProvince, district: s.toDistrict,
    weight: String(s.weightGram), value: String(s.value || 0), transport: 'road', deliver_option: 'none',
  }).toString();
  const { status, json } = await call(`${GHTK_BASE}/services/shipment/fee?${q}`, { method: 'GET', headers: { Token: cfg.token } });
  if (status === 401 || status === 403) throw new CarrierError('token GHTK không hợp lệ hoặc chưa được cấp quyền tính phí');
  if (status !== 200 || json?.success !== true) throw new CarrierError(`GHTK từ chối tính phí: ${json?.message ?? `HTTP ${status}`}`);
  return { fee: Number(json?.fee?.fee ?? 0) };
}
// GHN: token cần ID quận/phường để tính phí → kiểm token đơn giản bằng API danh mục tỉnh.
async function ghnPing(cfg) {
  const { status, json } = await call(`${GHN_BASE}/master-data/province`, { method: 'GET', headers: { Token: cfg.token } });
  if (status !== 200 || json?.code !== 200) throw new CarrierError(`token GHN không hợp lệ: ${json?.message ?? `HTTP ${status}`}`);
  return { fee: null };
}
export function carrierTest(provider, cfg, sample) {
  if (provider === 'ghtk') return ghtkFee(cfg, sample);
  if (provider === 'ghn') return ghnPing(cfg);
  throw new CarrierError('hãng vận chuyển không được hỗ trợ');
}
export function carrierStatus(provider, cfg, tracking) {
  if (provider === 'ghn') return ghnStatus(cfg, tracking);
  if (provider === 'ghtk') return ghtkStatus(cfg, tracking);
  throw new CarrierError('hãng vận chuyển không được hỗ trợ');
}
