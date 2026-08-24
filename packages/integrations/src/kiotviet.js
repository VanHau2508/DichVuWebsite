import crypto from 'node:crypto';

const DEFAULT_IDENTITY_BASE = 'https://id.kiotviet.vn';
const DEFAULT_API_BASE = 'https://public.kiotapi.com';

export class KiotVietError extends Error {
  constructor(message, { status = 502, retryAfterMs = null, code = 'kiotviet_error' } = {}) {
    super(message);
    this.name = 'KiotVietError';
    this.statusCode = status;
    this.retryAfterMs = retryAfterMs;
    this.code = code;
  }
}

const text = (value, max = 500) => String(value ?? '').trim().slice(0, max);

/** Chỉ áp snapshot tồn khi số provider đủ phủ mọi reservation local đang còn hiệu lực. */
export function canApplyKiotVietStock(providerOnHand, reserved) {
  const provider = Number(providerOnHand);
  const held = Number(reserved);
  return Number.isSafeInteger(provider) && provider >= 0
    && Number.isSafeInteger(held) && held >= 0 && provider >= held;
}

/** Event không có mốc không được ghi đè một snapshot đã có bằng chứng thứ tự. */
export function isStaleKiotVietSnapshot(incomingAt, existingAt) {
  if (!existingAt) return false;
  const existingMs = existingAt instanceof Date ? existingAt.getTime() : Date.parse(existingAt);
  if (!Number.isFinite(existingMs)) return false;
  const incomingMs = incomingAt instanceof Date ? incomingAt.getTime() : Date.parse(incomingAt ?? '');
  return !Number.isFinite(incomingMs) || incomingMs <= existingMs;
}

async function readResponse(res) {
  const raw = await res.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch {}
  return { raw, body };
}

function retryAfterMs(res) {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** Backoff dùng chung cho job connector: không gọi lại sớm hơn thời điểm provider yêu cầu. */
export function integrationRetryBackoffMs(error, attemptsMade, { baseMs = 2000, maxMs = 300_000 } = {}) {
  const base = Number.isFinite(Number(baseMs)) ? Math.max(1, Math.trunc(Number(baseMs))) : 2000;
  const cap = Number.isFinite(Number(maxMs)) ? Math.max(base, Math.trunc(Number(maxMs))) : 300_000;
  const attempt = Number.isFinite(Number(attemptsMade)) ? Math.max(1, Math.trunc(Number(attemptsMade))) : 1;
  const exponential = Math.min(cap, base * (2 ** Math.min(attempt - 1, 30)));
  const providerDelay = error?.retryAfterMs == null ? NaN : Number(error.retryAfterMs);
  return Number.isFinite(providerDelay) && providerDelay >= 0
    ? Math.max(exponential, Math.trunc(providerDelay))
    : exponential;
}

/** Client Public API KiotViet; cho phép chèn fetch/base URL để contract test không gọi mạng. */
export function createKiotVietClient({
  clientId,
  clientSecret,
  retailer,
  identityBase = DEFAULT_IDENTITY_BASE,
  apiBase = DEFAULT_API_BASE,
  fetchImpl = fetch,
  timeoutMs = 8000,
}) {
  const cid = text(clientId, 200);
  const secret = text(clientSecret, 500);
  const retailerName = text(retailer, 200);
  if (!cid || !secret || !retailerName) throw new KiotVietError('thiếu thông tin kết nối KiotViet', { status: 400, code: 'invalid_credentials' });

  let token = null;
  let tokenUntil = 0;

  async function accessToken() {
    if (token && tokenUntil > Date.now() + 30_000) return token;
    const body = new URLSearchParams({
      scopes: 'PublicApi.Access',
      grant_type: 'client_credentials',
      client_id: cid,
      client_secret: secret,
    });
    let res;
    try {
      res = await fetchImpl(`${identityBase.replace(/\/$/, '')}/connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new KiotVietError(`không kết nối được máy chủ xác thực KiotViet: ${error.message}`, { code: 'provider_unavailable' });
    }
    const parsed = await readResponse(res);
    if (!res.ok || !parsed.body?.access_token) {
      const msg = text(parsed.body?.error_description || parsed.body?.error || parsed.raw, 240);
      throw new KiotVietError(`KiotViet từ chối thông tin kết nối${msg ? `: ${msg}` : ''}`, {
        status: res.status === 400 || res.status === 401 ? 400 : 502,
        code: 'authentication_failed',
      });
    }
    token = parsed.body.access_token;
    tokenUntil = Date.now() + Math.max(60, Number(parsed.body.expires_in ?? 3600)) * 1000;
    return token;
  }

  async function request(method, path, { query, body, allowNotFound = false } = {}) {
    const url = new URL(apiBase.replace(/\/$/, '') + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value != null && value !== '') url.searchParams.set(key, String(value));
    }
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          retailer: retailerName,
          authorization: `Bearer ${await accessToken()}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new KiotVietError(`không gọi được KiotViet: ${error.message}`, { code: 'provider_unavailable' });
    }
    const parsed = await readResponse(res);
    if (allowNotFound && res.status === 404) return null;
    if (!res.ok) {
      const msg = text(parsed.body?.responseStatus?.message || parsed.body?.message || parsed.raw, 240);
      throw new KiotVietError(`KiotViet trả lỗi ${res.status}${msg ? `: ${msg}` : ''}`, {
        status: res.status === 429 ? 503 : (res.status >= 500 ? 502 : res.status),
        retryAfterMs: retryAfterMs(res),
        code: res.status === 429 ? 'rate_limited' : 'provider_rejected',
      });
    }
    return parsed.body ?? {};
  }

  return {
    accessToken,
    async listBranches() {
      const data = await request('GET', '/branches', { query: { pageSize: 100, includeRemoveIds: false } });
      return (data.data ?? []).map((row) => ({
        id: String(row.id),
        name: text(row.branchName || row.name, 200),
        address: text(row.address, 500) || null,
      }));
    },
    async findOrderByCode(code) {
      return request('GET', `/orders/code/${encodeURIComponent(text(code, 100))}`, { allowNotFound: true });
    },
    async findOrderByMarker(marker, { lastModifiedFrom, maxPages = 50 } = {}) {
      const wanted = text(marker, 200);
      let currentItem = 0;
      const pageLimit = Math.min(Math.max(Number(maxPages) || 50, 1), 50);
      for (let page = 0; page < pageLimit; page++) {
        const data = await request('GET', '/orders', { query: {
          currentItem, pageSize: 100, orderBy: 'modifiedDate', orderDirection: 'Desc',
          ...(lastModifiedFrom ? { lastModifiedFrom } : {}),
        } });
        const rows = Array.isArray(data.data) ? data.data : [];
        const found = rows.find((row) => String(row.description ?? row.Description ?? '').includes(wanted));
        if (found) return found;
        currentItem += rows.length;
        if (rows.length < 100 || (Number(data.total) > 0 && currentItem >= Number(data.total))) return null;
      }
      // Không được biến "đã nhìn 5.000 đơn" thành "đơn chắc chắn chưa tồn tại". Provider có
      // thể đã tạo đơn rồi worker chết trước khi ghi external_ref; POST tiếp trong tình huống
      // chưa quét hết sẽ nhân đôi đơn và giữ tồn hai lần ở KiotViet.
      throw new KiotVietError('Không thể xác minh đơn cũ vì tập kết quả KiotViet vượt giới hạn quét an toàn', {
        status: 503,
        code: 'order_lookup_incomplete',
      });
    },
    async listOrders({ currentItem = 0, pageSize = 100, lastModifiedFrom = null, branchId = null } = {}) {
      const data = await request('GET', '/orders', { query: {
        currentItem, pageSize: Math.min(Math.max(Number(pageSize) || 100, 1), 100),
        ...(lastModifiedFrom ? { lastModifiedFrom } : {}),
        ...(branchId ? { branchIds: branchId } : {}),
        orderBy: 'modifiedDate', orderDirection: 'Asc',
      } });
      return {
        rows: Array.isArray(data.data) ? data.data : [],
        total: Number(data.total ?? data.totalItems ?? 0),
      };
    },
    async createOrder(order) {
      return request('POST', '/orders', { body: order });
    },
    async getProduct(externalId) {
      return request('GET', `/products/${encodeURIComponent(externalId)}`);
    },
    async listProducts({ currentItem = 0, pageSize = 100, lastModifiedFrom = null } = {}) {
      const data = await request('GET', '/products', { query: {
        currentItem, pageSize: Math.min(Math.max(Number(pageSize) || 100, 1), 100),
        includeInventory: true, includeRemoveIds: true,
        ...(lastModifiedFrom ? { lastModifiedFrom } : {}),
      } });
      return {
        rows: Array.isArray(data.data) ? data.data : [],
        removed: Array.isArray(data.removeId) ? data.removeId.map(String) : [],
        total: Number(data.total ?? data.totalItems ?? 0),
      };
    },
    async listInvoices({ currentItem = 0, pageSize = 100, lastModifiedFrom = null, branchId = null } = {}) {
      const data = await request('GET', '/invoices', { query: {
        currentItem, pageSize: Math.min(Math.max(Number(pageSize) || 100, 1), 100),
        includePayment: true, includeInvoiceDelivery: true,
        ...(lastModifiedFrom ? { lastModifiedFrom } : {}),
        ...(branchId ? { branchIds: branchId } : {}),
        orderBy: 'modifiedDate', orderDirection: 'Asc',
      } });
      return {
        rows: Array.isArray(data.data) ? data.data : [],
        total: Number(data.total ?? data.totalItems ?? 0),
      };
    },
    async listWebhooks() {
      const data = await request('GET', '/webhooks', { query: { pageSize: 100 } });
      return Array.isArray(data.data) ? data.data : [];
    },
    async registerWebhook({ type, url, secret, description = 'Nền Tảng POS connector' }) {
      return request('POST', '/webhooks', { body: { Webhook: {
        Type: text(type, 80), Url: text(url, 1000), IsActive: true,
        Description: text(description, 240), Secret: text(secret, 500),
      } } });
    },
    async deleteWebhook(id) {
      return request('DELETE', `/webhooks/${encodeURIComponent(String(id))}`);
    },
  };
}

/** KiotViet ký thân HTTP bằng secret RIÊNG lúc đăng ký webhook, không phải client_secret. */
export function verifyKiotVietSignature(rawBody, signatureHeader, secret) {
  const supplied = text(signatureHeader, 300).replace(/^sha256=/i, '');
  if (!supplied || !secret) return false;
  const expected = crypto.createHmac('sha256', String(secret)).update(rawBody).digest();
  let actual = null;
  if (/^[0-9a-f]{64}$/i.test(supplied)) actual = Buffer.from(supplied, 'hex');
  else if (/^[A-Za-z0-9+/]{43}=$/.test(supplied)) actual = Buffer.from(supplied, 'base64');
  return actual?.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Chuẩn hoá envelope webhook nhưng giữ nguyên Data để mapper theo từng event xử lý sau. */
export function extractKiotVietNotifications(payload, eventType) {
  const envelopeId = text(payload?.Id || payload?.id, 200) || null;
  const notifications = Array.isArray(payload?.Notifications) ? payload.Notifications : [payload];
  return notifications.flatMap((notification, index) => {
    const rows = Array.isArray(notification?.Data) ? notification.Data : [notification?.Data ?? notification];
    return rows.filter((row) => row && typeof row === 'object').map((row, rowIndex) => ({
      eventType,
      eventId: text(row.Id || row.id || `${envelopeId ?? 'envelope'}:${index}:${rowIndex}`, 240),
      action: text(notification?.Action || notification?.action, 80) || null,
      data: row,
    }));
  });
}

/** Chỉ đọc tồn của chi nhánh đã chọn; không rơi về tổng tồn khi danh sách chi nhánh có mặt. */
export function kiotVietBranchOnHand(row, branchRef) {
  const list = row?.inventories ?? row?.Inventories ?? row?.inventory;
  if (Array.isArray(list) && list.length > 0) {
    const wanted = String(branchRef ?? '');
    const found = list.find((it) => String(it?.branchId ?? it?.BranchId ?? it?.id ?? '') === wanted);
    return found ? (found.onHand ?? found.OnHand ?? 0) : 0;
  }
  return row?.onHand ?? row?.OnHand ?? null;
}
