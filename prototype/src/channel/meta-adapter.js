'use strict';
// meta-adapter.js — Adapter BIÊN Facebook/Messenger LIVE (P2 LIVE-INTEGRATION).
//
// Trách nhiệm (KHÔNG đụng core P3A/P3B/P3C):
//   1. Webhook verify (GET echo challenge theo META_VERIFY_TOKEN).
//   2. Verify chữ ký X-Hub-Signature-256 = HMAC-SHA256(raw body, META_APP_SECRET), so timing-safe.
//   3. Normalize inbound message/comment/delivery/read/echo về 2 shape hệ thống đã hiểu:
//        events[]   -> app.receive()   (envelope {channel,type,platformEventId,payload})
//        receipts[] -> app.ingestReceipt() (receipt store inbound-first BL-5)
//      Map platform message id (mid / comment_id) -> platformEventId => dedupe tầng gateway
//      (event_id = channel:platformEventId, INV-1) đúng nguyên tắc case 10.
//   4. Outbound: POST graph.facebook.com/{v}/me/messages (text + template) — hàm sendMessage
//      implement ĐÚNG interface platform của ActionGate; GATE chỉ gọi SAU khi authorize ALLOW
//      (SendPolicy một chỗ — adapter KHÔNG TỰ GỬI, KHÔNG biết window/quota/state).
//
// last_user_event_ts: gateway (core) ghi CHỈ từ event type 'message' — adapter chỉ tạo đúng
// shape, không tự đụng channel_state. Echo/delivery/read KHÔNG tạo event message (không mở window).
//
// CỨM SECRETS: token/secret không bao giờ nằm trong status/log; sendMessage gửi token bằng
// header Authorization: Bearer (không nằm trong URL query).

const crypto = require('crypto');
const { httpOnce } = require('../live-http');
const { isConfigured } = require('../live-env');

class MetaAdapter {
  constructor(opts = {}) {
    const c = opts.config || {};
    this.cfg = {
      appId: c.appId || null,
      appSecret: c.appSecret || null,
      pageId: c.pageId || null,
      pageAccessToken: c.pageAccessToken || null,
      verifyToken: c.verifyToken || null,
      apiVersion: c.apiVersion || 'v21.0',
    };
    this.httpFn = opts.httpFn || httpOnce;   // dependency injection — tests tiêm mock
    this.timeoutMs = opts.timeoutMs || 15000;
    this.mode = 'live';
    this.graphUrl = opts.graphUrl || null;   // chỉ dùng cho test offline nếu muốn ép URL
    this.state = {
      configured: this.isConfigured(),
      connected: false,
      last_webhook_at: null,
      last_success_at: null,
      last_error_type: null,
    };
    this.sendCalls = []; // quan sát cho test (không chứa secret)
    this.hideCalls = []; // AICAKE G2: quan sát lượt gọi ẩn comment (mock) cho test
  }

  isConfigured() {
    return isConfigured(this.cfg.appSecret) && isConfigured(this.cfg.pageAccessToken)
      && isConfigured(this.cfg.verifyToken);
  }

  providerStatus() {
    // CHỈ trả metadata — KHÔNG BAO GIỜ trả token/secret (CỨM SECRETS).
    return {
      provider: 'meta', mode: this.mode, configured: this.state.configured,
      connected: this.state.configured && this.state.connected
        && !['auth', 'config', 'signature'].includes(this.state.last_error_type),
      last_webhook_at: this.state.last_webhook_at,
      last_success_at: this.state.last_success_at,
      last_error_type: this.state.last_error_type,
    };
  }

  _err(type) {
    this.state.last_error_type = type;
    if (['auth', 'config', 'signature'].includes(type)) this.state.connected = false;
  }

  // ================= 1) WEBHOOK VERIFY (GET /webhooks/meta) =================
  // Trả challenge (string) khi hợp lệ, null khi từ chối.
  verifySubscribe(query) {
    const ok = query
      && query['hub.mode'] === 'subscribe'
      && isConfigured(this.cfg.verifyToken)
      && query['hub.verify_token'] === this.cfg.verifyToken;
    if (!ok) { this._err('verify_challenge'); return null; }
    this.state.connected = true;
    return String(query['hub.challenge'] || '');
  }

  // ================= 2) SIGNATURE X-Hub-Signature-256 =================
  rawBodyValid(rawBody, header) {
    if (!isConfigured(this.cfg.appSecret)) { this._err('config'); return false; }
    const m = /^sha256=([0-9a-fA-F]+)$/.exec(String(header || ''));
    if (!m) { this._err('signature'); return false; }
    const expected = crypto.createHmac('sha256', this.cfg.appSecret).update(String(rawBody), 'utf8').digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(m[1].toLowerCase(), 'hex');
    const okSig = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!okSig) this._err('signature');
    return okSig;
  }

  // ================= 3) NORMALIZE INBOUND =================
  // bodyJson = JSON.parse(raw) đã qua verifySignature. Trả {events, receipts, ignored}.
  // User event (message/comment) mới là type 'message' — gateway chỉ cập nhật last_user_event_ts
  // từ các event này (BL-1). delivery/read/echo đi receipts — KHÔNG mở window.
  normalizeWebhook(bodyJson, { receivedAt } = {}) {
    const nowIso = receivedAt || new Date().toISOString();
    this.state.last_webhook_at = nowIso;
    const out = { events: [], receipts: [], ignored: 0 };
    const body = bodyJson && typeof bodyJson === 'object' ? bodyJson : {};
    for (const entry of Array.isArray(body.entry) ? body.entry : []) {
      // ---- Messenger messaging events ----
      for (const m of Array.isArray(entry.messaging) ? entry.messaging : []) {
        if (m.message && m.message.is_echo) {
          // ECHO: tin của CHÍNH BOT đi ngược về — bằng chứng send, không phải event user.
          if (m.message.mid) out.receipts.push({
            conversation_id: `facebook:${(m.recipient && m.recipient.id) || ''}`,
            kind: 'message_echo', mid: m.message.mid, at: tsIso(m.timestamp, nowIso),
          });
        } else if (m.message) {
          const ev = this._normalizeUserMessage(m, nowIso);
          if (ev) out.events.push(ev); else out.ignored += 1;
        } else if (m.delivery) {
          const conv = `facebook:${(m.sender && m.sender.id) || ''}`;
          const at = tsIso(m.timestamp, nowIso);
          for (const mid of Array.isArray(m.delivery.mids) ? m.delivery.mids : []) {
            out.receipts.push({ conversation_id: conv, kind: 'message_delivery', mid, at });
          }
          if (!m.delivery.mids && m.delivery.watermark) {
            out.receipts.push({ conversation_id: conv, kind: 'message_delivery', mid: null, at });
          }
        } else if (m.read) {
          out.receipts.push({
            conversation_id: `facebook:${(m.sender && m.sender.id) || ''}`,
            kind: 'message_read', mid: (m.read && m.read.mid) || null,
            at: tsIso(m.timestamp, nowIso),
          });
        } else {
          out.ignored += 1; // postback/referral/pass_thread_control... — ngoài phạm vi P2
        }
      }
      // ---- Page feed events (comment) ----
      for (const ch of Array.isArray(entry.changes) ? entry.changes : []) {
        if (ch.field !== 'feed' || !ch.value) { out.ignored += 1; continue; }
        const v = ch.value;
        if (v.item === 'comment' && v.verb === 'add' && v.comment_id) {
          const userRef = `fbuser:${(v.from && v.from.id) || 'anonymous'}`;
          out.events.push({
            channel: 'facebook',
            type: 'message',
            platformEventId: `comment:${v.comment_id}`, // dedupe theo comment_id (INV-1)
            payload: {
              customer_ref: userRef,
              thread_id: userRef,
              kind: 'text',
              text: String(v.message || ''),
              platform_message_id: v.comment_id,
              timestamp_platform: v.created_time || nowIso,
              origin: 'comment',
              comment_id: v.comment_id,
              post_id: v.post_id || null,
              parent_id: v.parent_id || null,
            },
          });
        } else {
          out.ignored += 1; // post/verb remove/edited...
        }
      }
    }
    return out;
  }

  _normalizeUserMessage(m, nowIso) {
    const sender = m.sender && m.sender.id;
    if (!sender) return null;
    const msg = m.message || {};
    const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
    const first = atts[0] || null;
    let kind = 'text';
    let media = null;
    if (first && first.type === 'image') {
      kind = 'image';
      media = { platform_url: (first.payload && first.payload.url) || null, type: 'image' };
    } else if (first && first.type === 'audio') {
      kind = 'voice';
      media = { platform_url: (first.payload && first.payload.url) || null, type: 'audio' };
    } else if (first && (first.type === 'video' || first.type === 'file')) {
      kind = 'text'; // file/video: P2 không xử lý nội dung — lưu như tin nhắn kèm ghi chú media
      media = { platform_url: (first.payload && first.payload.url) || null, type: first.type };
    } else if (first && first.type === 'sticker') {
      kind = 'text'; // sticker (kể cả giai đoạn chuyển đổi có cả image) — không cần nội dung
      media = { platform_url: (first.payload && first.payload.url) || null, type: 'sticker', sticker_id: msg.sticker_id || null };
    }
    return {
      channel: 'facebook',
      type: 'message',
      platformEventId: msg.mid || `msg:${sender}:${m.timestamp || nowIso}`, // mid = key dedupe (INV-1)
      payload: {
        customer_ref: String(sender),
        thread_id: String(sender), // PSID = thread 1-1 Messenger
        kind,
        text: String(msg.text || ''),
        media,
        platform_message_id: msg.mid || null,
        timestamp_platform: tsIso(m.timestamp, nowIso),
      },
    };
  }

  // ================= 4) OUTBOUND — interface ActionGate gọi sau ALLOW =================
  // sendMessage({clientMessageId, to, text, template}) — contract giống MockPlatform:
  //   trả {ok:true, mid} | {ok:false, timeout:true} (INV-2: chưa biết kết quả) | {ok:false, error}
  // to = conversation_id 'facebook:<psid>'. template = attachment object (generic/button/media).
  sendMessage({ clientMessageId, to, text, template } = {}) {
    void clientMessageId;
    this.sendCalls.push({ to, withTemplate: !!template, at: new Date().toISOString() });
    if (!this.isConfigured()) { this._err('config'); return { ok: false, error: 'META_NOT_CONFIGURED' }; }
    const psid = String(to || '').split(':').slice(1).join(':');
    if (!psid) { this._err('bad_recipient'); return { ok: false, error: 'BAD_RECIPIENT' }; }
    const message = template ? { attachment: template } : { text: String(text || '') };
    const url = this.graphUrl || `https://graph.facebook.com/${this.cfg.apiVersion}/me/messages`;
    const res = this.httpFn({
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.cfg.pageAccessToken}`, // token đi header — không vào URL/log
      },
      body: JSON.stringify({
        recipient: { id: psid },
        messaging_type: 'RESPONSE',
        message,
      }),
      timeoutMs: this.timeoutMs,
    });
    if (res && res.timeout) { this._err('timeout'); return { ok: false, timeout: true }; }
    if (!res || res.error) { this._err('http_error'); return { ok: false, error: (res && res.error) || 'http_error' }; }
    let parsed = null;
    try { parsed = JSON.parse(res.bodyText || ''); } catch (e) { parsed = null; }
    if (res.status >= 200 && res.status < 300 && parsed && parsed.message_id) {
      this.state.last_success_at = new Date().toISOString();
      this.state.connected = true;
      this.state.last_error_type = null;
      return { ok: true, mid: parsed.message_id };
    }
    const code = parsed && parsed.error ? parsed.error.code : undefined;
    const type = (code === 190 || code === 10 || code === 200)
      ? 'auth' // token hết hạn/thu hồi hoặc thiếu permission -> PERMISSION_REQUIRED
      : (parsed && parsed.error ? `api_error:${code}` : `http_${res.status || 0}`);
    this._err(type);
    return { ok: false, error: type };
  }
  // ================= 5) ẨN COMMENT TIÊU CỰC (AICAKE G2) =================
  // Instance wrapper — ghi vết vào hideCalls cho test quan sát (không chứa secret).
  hideComment({ comment_id } = {}) {
    const r = hideComment({ comment_id });
    this.hideCalls.push({ comment_id: String(comment_id || ''), ok: !!(r && r.ok), mock: !!(r && r.mock), at: new Date().toISOString() });
    return r;
  }
}

// AICAKE (G2) — exported helper ẨN COMMENT: pipeline gọi khi comment bị phân loại TIÊU CỰC
// và công tắc hide_negative_comment bật. Phase-2 gọi Graph API thật
// (POST graph.facebook.com/{v}/{comment_id} hide=true qua httpOnce + token header Authorization
// như sendMessage) — hiện tại là MOCK CHO LAB: KHÔNG gọi mạng, trả bằng chứng {ok, mock, comment_id}
// để pipeline ghi audit 'comment_hide' + flag hide_requested đầy đủ.
function hideComment({ comment_id } = {}) {
  if (!comment_id) return { ok: false, mock: true, error: 'MISSING_COMMENT_ID' };
  return { ok: true, mock: true, comment_id: String(comment_id) };
}

function tsIso(ms, fallback) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return fallback || new Date().toISOString();
  return new Date(n).toISOString();
}

module.exports = { MetaAdapter, hideComment };
