/**
 * BOT MESSENGER — khách chốt đơn ngay trong chat Facebook (chặng 2, docs/47).
 *
 * ── Vì sao service riêng, và vì sao nó KHÔNG được chạm vào đơn/kho ──────────
 * Vai DB app_messenger chỉ có quyền trên đúng hai bảng của riêng nó (0122). Tạo đơn đi
 * qua HTTP /ingest/orders bằng khoá kết nối của shop — cùng validate, cùng khoá tồn, cùng
 * idempotency, cùng giá. Đường tiền không được có bản sao thứ hai.
 *
 * ── Bảo mật ────────────────────────────────────────────────────────────────
 * MỌI webhook phải qua X-Hub-Signature-256 (HMAC-SHA256 raw body, khoá = App Secret của
 * nền tảng). Không có nó thì bất kỳ ai biết URL đều bơm được "đơn" giả vào shop bất kỳ.
 * So sánh bằng timingSafeEqual, không phải ===.
 *
 * ── Một Meta App cho cả nền tảng ───────────────────────────────────────────
 * App Secret là của NỀN TẢNG (env), Page Access Token là của TỪNG SHOP (mã hoá trong DB).
 * Shop kết nối Trang của họ vào app của nền tảng — họ không phải tự lập app, tự qua App
 * Review. Đó là khác biệt giữa "SaaS dùng được" và "công cụ cho lập trình viên".
 */
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import { health, makeLog, runReq } from './obs.js';
import { open as unseal } from './secretbox.js';
import { step, orderPlacedMessages, orderFailedMessages } from './flow.js';

const PORT = Number(process.env.PORT ?? 3072);
const APP_SECRET = process.env.MESSENGER_APP_SECRET ?? '';
const ENC_KEY = process.env.MESSENGER_ENC_KEY ?? '';
const SELLER_URL = process.env.SELLER_URL ?? 'http://seller:3040';
const GRAPH = process.env.META_GRAPH_URL ?? 'https://graph.facebook.com/v21.0';
const SHOP_BASE = process.env.SHOP_LOOKUP_BASE ?? ''; // để dựng link tra cứu đơn cho khách
const MAX_BODY = 512 * 1024;

// Keyring RIÊNG của Messenger — PHẢI khớp hằng KEYRING trong apps/seller/src/messenger-config.js.
const KEYRING = 'MESSENGER_ENC_KEYS';
const openMsg = (blob) => unseal(blob, ENC_KEY, KEYRING);
const log = makeLog('messenger');
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });

/** Chạy fn trong transaction có tenant context (mirror withTenant của seller). */
async function withShop(shopId, fn) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body quá lớn'), { statusCode: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** HMAC-SHA256 raw body với App Secret. So sánh hằng-thời-gian. */
function signatureOk(rawBody, header) {
  if (!APP_SECRET || typeof header !== 'string') return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  const want = crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest();
  const got = Buffer.from(m[1], 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ── Truy cập DB (chỉ 2 bảng) ────────────────────────────────────────────────

/** Page → shop. Xuyên shop: webhook chỉ mang Page ID (policy messenger_cfg_read, 0122). */
async function configByPage(pageId) {
  const { rows } = await db.query(
    `SELECT shop_id, page_token_enc, api_token_enc FROM shop_messenger_config
      WHERE page_id = $1 AND enabled`, [pageId],
  );
  return rows[0] ?? null;
}
/** Verify token → shop. Meta gọi GET lúc đăng ký webhook và KHÔNG gửi Page ID. */
async function shopByVerifyToken(token) {
  const { rows } = await db.query(
    `SELECT shop_id FROM shop_messenger_config WHERE verify_token_hash = $1`, [sha256(token)],
  );
  return rows[0] ?? null;
}

const loadSession = (c, psid) => c.query(
  `SELECT state, last_customer, handoff_until FROM messenger_sessions
    WHERE shop_id = current_shop_id() AND psid = $1 FOR UPDATE`, [psid],
).then((r) => r.rows[0] ?? null);

const saveSession = (c, psid, state, lastCustomer, handoffUntil) => c.query(
  `INSERT INTO messenger_sessions (shop_id, psid, state, last_customer, handoff_until, updated_at)
   VALUES (current_shop_id(), $1, $2, $3, $4, now())
   ON CONFLICT (shop_id, psid) DO UPDATE
     SET state = $2,
         last_customer = COALESCE($3, messenger_sessions.last_customer),
         handoff_until = COALESCE($4, messenger_sessions.handoff_until),
         updated_at = now()`,
  [psid, JSON.stringify(state), lastCustomer ? JSON.stringify(lastCustomer) : null, handoffUntil],
);

// ── Gọi ra ngoài ────────────────────────────────────────────────────────────

/** API của shop (seller /ingest/*) bằng khoá kết nối đã giải mã. */
async function shopApi(apiToken, path, { method = 'GET', body } = {}) {
  const r = await fetch(SELLER_URL + path, {
    method,
    headers: { authorization: `Bearer ${apiToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j };
}

/** Dịch tin nhắn trung lập của flow.js sang đúng định dạng Send API của Meta. */
function toMetaMessage(m) {
  if (m.kind === 'cards') {
    return {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'generic',
          elements: m.cards.map((c) => ({
            title: c.title, subtitle: c.subtitle,
            ...(c.image ? { image_url: c.image } : {}),
            buttons: c.buttons.map((b) => ({ type: 'postback', title: b.title, payload: b.payload })),
          })),
        },
      },
    };
  }
  const out = { text: m.text };
  if (m.quickReplies?.length) {
    out.quick_replies = m.quickReplies.map((q) => (q.contentType
      ? { content_type: q.contentType }
      : { content_type: 'text', title: q.title, payload: q.payload }));
  }
  return out;
}

async function sendMessages(pageToken, psid, messages) {
  for (const m of messages) {
    const r = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(pageToken)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recipient: { id: psid }, messaging_type: 'RESPONSE', message: toMetaMessage(m) }),
    }).catch((e) => ({ ok: false, status: 0, _err: e.message }));
    if (!r.ok) log('warn', 'send_failed', { status: r.status, error: r._err ?? (await r.text?.().catch(() => null)) });
  }
}

async function fetchProfile(pageToken, psid) {
  try {
    const r = await fetch(`${GRAPH}/${psid}?fields=first_name,last_name&access_token=${encodeURIComponent(pageToken)}`);
    return r.ok ? await r.json() : {};
  } catch { return {}; }  // hồ sơ chỉ để chào tên — hỏng thì bot vẫn chạy, gọi "bạn"
}

// ── Xử lý một sự kiện nhắn tin ──────────────────────────────────────────────

function eventOf(msg) {
  if (msg.postback) return { type: 'postback', payload: msg.postback.payload, ref: msg.postback.referral?.ref };
  if (msg.referral) return { type: 'postback', ref: msg.referral.ref };
  const qrPayload = msg.message?.quick_reply?.payload;
  if (qrPayload) return { type: 'quick_reply', payload: qrPayload };
  // Quick reply user_phone_number trả về trong message.text — coi như khách gõ số.
  if (msg.message?.text != null) return { type: 'text', text: msg.message.text };
  return null;
}

async function handleEvent(cfg, psid, ev) {
  const pageToken = openMsg(cfg.page_token_enc);
  const apiToken = openMsg(cfg.api_token_enc);

  const sess = await withShop(cfg.shop_id, (c) => loadSession(c, psid));
  // Đang giao cho người thật → bot IM. Trừ khi khách chủ động bấm nút của bot.
  if (sess?.handoff_until && new Date(sess.handoff_until) > new Date() && ev.type === 'text') return;

  const state = sess?.state ?? {};
  const data = { lastCustomer: sess?.last_customer ?? null };

  // Nạp ĐÚNG thứ bước này cần — không tải cả kho cho mỗi tin nhắn.
  if (ev.payload?.startsWith('PICK:') || /^sp_[0-9a-f-]{36}$/.test(ev.ref ?? '')) {
    const pid = ev.payload?.slice(5) ?? ev.ref.slice(3);
    const r = await shopApi(apiToken, `/ingest/catalog/products/${pid}`);
    data.product = r.status === 200 ? r.json : null;
  } else if (ev.payload?.startsWith('VAR:')) {
    const r = await shopApi(apiToken, `/ingest/catalog/products/${state.pickProduct}`);
    data.product = r.status === 200 ? r.json : null;
  } else if (!state.step || ev.payload === 'BROWSE' || ev.payload?.startsWith('CAT:')) {
    const cat = ev.payload?.startsWith('CAT:') ? `?cat=${encodeURIComponent(ev.payload.slice(4))}` : '';
    const r = await shopApi(apiToken, `/ingest/catalog${cat}`);
    data.catalog = r.status === 200 ? r.json : { categories: [], products: [] };
  }
  // Nạp hồ sơ khi CHƯA biết tên — không phải chỉ ở tin đầu. Khách vào thẳng từ quảng cáo
  // (ref) bỏ qua bước chào, và khi ấy vẫn cần tên để ghi lên đơn.
  if (!state.customer?.name && !sess?.last_customer?.name) {
    data.profile = await fetchProfile(pageToken, psid);
  }

  let out = step(state, ev, data);

  // ── Hiệu ứng: tạo đơn thật ────────────────────────────────────────────────
  if (out.effect?.type === 'place_order') {
    const seq = Number(state.placeSeq ?? 0);
    const r = await shopApi(apiToken, '/ingest/orders', {
      method: 'POST',
      body: {
        lines: out.effect.cart.map((it) => ({ variant_id: it.variant_id, qty: it.qty })),
        customer: out.effect.customer,
        payment_method: 'cod',
        source: 'facebook',
        source_ref: `m.me/${cfg.page_id ?? ''}?psid=${psid}`,
        // Khoá idempotency KHÔNG băm giỏ hàng: Meta gửi lại webhook khi ta chậm trả 200, và
        // hai lần gửi đó phải ra ĐÚNG MỘT đơn. seq chỉ tăng sau khi đơn tạo XONG, nên lần
        // gửi lại dùng lại đúng khoá cũ → /ingest trả lại đơn cũ thay vì đẻ đơn thứ hai.
        // Khách muốn mua lại y hệt thì seq đã tăng → khoá khác → đơn mới. Đúng cả hai chiều.
        idempotency_key: `fb-${psid}-${seq}`,
      },
    });
    if (r.status === 201) {
      const url = SHOP_BASE ? `${SHOP_BASE}/tra-cuu-don` : null;
      out = {
        state: { cart: [], step: 'start', customer: out.effect.customer, placeSeq: seq + 1 },
        messages: orderPlacedMessages(r.json, url),
        effect: { type: 'remember', customer: out.effect.customer },
      };
    } else {
      out = { state: { ...state, step: 'confirm' }, messages: orderFailedMessages(r.json?.error ?? 'thử lại giúp shop nhé') };
    }
  }

  const handoffUntil = out.effect?.type === 'handoff' ? new Date(Date.now() + 6 * 3600_000) : null;
  const remember = out.effect?.type === 'remember' ? out.effect.customer : null;
  await withShop(cfg.shop_id, (c) => saveSession(c, psid, out.state, remember, handoffUntil));
  if (out.messages.length) await sendMessages(pageToken, psid, out.messages);
}

// ── HTTP ────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => runReq(req, res, async () => {
  const url = new URL(req.url, 'http://internal');
  if (await health(url.pathname, res, { db: () => db.query('SELECT 1') })) return;

  // Meta gọi GET lúc đăng ký webhook. Không có Page ID trong request → nhận diện bằng
  // chính verify token (ngẫu nhiên, riêng từng shop).
  if (req.method === 'GET' && url.pathname === '/webhooks/messenger') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token') ?? '';
    const challenge = url.searchParams.get('hub.challenge') ?? '';
    if (mode === 'subscribe' && token && await shopByVerifyToken(token)) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(challenge);
    }
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('forbidden');
  }

  if (req.method === 'POST' && url.pathname === '/webhooks/messenger') {
    const raw = await readRaw(req);
    if (!signatureOk(raw, req.headers['x-hub-signature-256'])) {
      log('warn', 'bad_signature', { len: raw.length });
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'chữ ký không hợp lệ' }));
    }
    let body = null;
    try { body = JSON.parse(raw.toString('utf8')); } catch {}
    // TRẢ 200 dù xử lý hỏng. Meta gửi lại khi không nhận 200, và gửi lại nghĩa là khách
    // nhận CÙNG tin nhắn thêm lần nữa. Lỗi ghi vào log để người vận hành thấy, không đẩy
    // hậu quả sang mặt khách hàng.
    try {
      for (const entry of body?.entry ?? []) {
        const cfg = await configByPage(String(entry.id));
        if (!cfg) { log('warn', 'unknown_page', { page_id: entry.id }); continue; }
        cfg.page_id = String(entry.id);
        for (const msg of entry.messaging ?? []) {
          if (msg.message?.is_echo) continue;       // tin do CHÍNH shop gửi — bỏ qua, không vòng lặp
          const psid = msg.sender?.id;
          const ev = eventOf(msg);
          if (!psid || !ev) continue;
          await handleEvent(cfg, String(psid), ev);
        }
      }
    } catch (err) {
      log('error', 'webhook_handler_error', { message: err.message, stack: err.stack });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"ok":true}');
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'không tìm thấy' }));
}));

// Thiếu secret/khoá thì bot KHÔNG im lặng chạy sai: chữ ký luôn trượt → mọi webhook 403,
// mà 403 hàng loạt không kèm lời giải thích là ca hỗ trợ tốn cả buổi.
if (!APP_SECRET) log('error', 'messenger_app_secret_missing', { note: 'MỌI webhook sẽ bị từ chối cho tới khi đặt MESSENGER_APP_SECRET' });
if (!/^[0-9a-f]{64}$/i.test(ENC_KEY)) log('error', 'messenger_enc_key_missing', { note: 'không mở được khoá Trang Facebook — đặt MESSENGER_ENC_KEY (64 hex)' });

server.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT }));
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(async () => { await db.end().catch(() => {}); process.exit(0); }));
}
