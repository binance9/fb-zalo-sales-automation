'use strict';
// zalo-adapter.js — Adapter BIÊN Zalo OA LIVE (P2 LIVE-INTEGRATION).
//
// HỢP ĐỒNG INTERFACE (quan trọng — không phá core):
//   ActionGate.executeSend gọi platform.sendMessage() ĐỒNG BỘ và đọc res.ok/res.timeout/res.error
//   ngay; ActionGate.getBudget gọi platform.getQuota() ĐỒNG BỘ. Vì vậy sendMessage/getQuota ở
//   adapter là HÀM ĐỒNG BỘ (HTTP sync qua curl, xem live-http.js). Token refresh có API ASYNC
//   riêng (refreshToken — dùng ở route/health/test, hỗ trợ single-flight promise lock).
//
// Trách nhiệm (KHÔNG đụng core P3A/P3B/P3C):
//   1. TOKEN LIFECYCLE (matrix B13): refresh qua oauth.zaloapp.com/v4/oa/access_token với
//      SINGLE-FLIGHT (promise lock — 1 OA chỉ có ĐÚNG 1 refresh HTTP chạy cùng lúc; các caller
//      khác chờ và nhận cùng cặp token mới). Refresh token XOAY VÒNG (dùng 1 lần) => LƯU ĐỒNG
//      THỜI CẢ HAI token mới ATOMIC (ghi .tmp + rename; file riêng NGOÀI dataDir test).
//   2. Webhook normalize: user_send_text/image (+ user_send_audio — voice CHỈ ĐÁNH DẤU chưa bật:
//      pipeline rơi nhánh ASR-fail -> NEEDS_HUMAN, không bịa text), user_seen_message ->
//      receipt store (BL-5), unfollow/user_withdraw -> opt_out_signal (case 18).
//   3. Outbound CS: POST openapi.zalo.me/v3.0/oa/message/cs — GATE chỉ gọi SAU khi authorize
//      ALLOW (adapter KHÔNG TỰ GỬI, không biết window/quota — policy nằm ở SendPolicy BL-1/BL-2).
//   4. Quota: POST /v3.0/oa/quota/message — CHỈ DÙNG số API trả về khi account trả field
//      cs_reply (KHÔNG hardcode giả khi LIVE); API không trả field => giá trị THIẾT KẾ 8/48h
//      đánh dấu source='design_default_unverified' + quota_verified=false (không fake verified).
//
// CỨM SECRETS: access_token đi header `access_token` (chuẩn Zalo), secret_key đi header refresh;
// KHÔNG log giá trị, KHÔNG nằm trong providerStatus/status bất kỳ.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { httpOnce } = require('../live-http');
const { isConfigured } = require('../live-env');

const OAUTH_URL = 'https://oauth.zaloapp.com/v4/oa/access_token';
const CS_SEND_URL = 'https://openapi.zalo.me/v3.0/oa/message/cs';
const QUOTA_URL = 'https://openapi.zalo.me/v3.0/oa/quota/message';
const QUOTA_CACHE_MS = 60 * 1000; // matrix B6: cache TTL ngắn <= 60s

class ZaloAdapter {
  constructor(opts = {}) {
    const c = opts.config || {};
    this.cfg = {
      appId: c.appId || null,
      appSecret: c.appSecret || null,
      oaId: c.oaId || null,
      accessToken: c.accessToken || null,
      refreshToken: c.refreshToken || null,
    };
    this.httpFn = opts.httpFn || httpOnce;       // dependency injection — tests tiêm mock
    this.timeoutMs = opts.timeoutMs || 15000;
    this.mode = 'live';
    this.oauthUrl = opts.oauthUrl || OAUTH_URL;  // cho test offline ép URL
    this.csUrl = opts.csUrl || CS_SEND_URL;
    this.quotaUrl = opts.quotaUrl || QUOTA_URL;

    // Token file NGOÀI dataDir test (mặc định prototype/data/live/zalo-token.json) —
    // file là NGUỒN MỚI NHẤT vì refresh token xoay vòng.
    this.tokenFile = opts.tokenFile || path.join(__dirname, '..', '..', 'data', 'live', 'zalo-token.json');
    this.tokens = { access_token: this.cfg.accessToken, refresh_token: this.cfg.refreshToken, expires_at: 0 };
    this._loadTokens(); // token trong file luôn mới hơn env tĩnh (rotation)

    this._refreshing = null;      // SINGLE-FLIGHT lock (promise)
    this.refreshCalls = [];       // quan sát test: số lần HTTP refresh THẬT
    this.quotaCache = { at: 0, value: null };
    this.state = {
      configured: this.isConfigured(),
      connected: false,
      last_webhook_at: null,
      last_success_at: null,
      last_error_type: null,
      token_expired: !isConfigured(this.tokens.access_token),
      quota_verified: false,
    };
    this.sendCalls = [];
    this.consumedCs = []; // mirror caller-side (platform-side trừ tại Zalo)
  }

  isConfigured() {
    return isConfigured(this.cfg.appId) && isConfigured(this.cfg.appSecret)
      && isConfigured(this.cfg.oaId)
      && (isConfigured(this.tokens.access_token) || isConfigured(this.tokens.refresh_token));
  }

  providerStatus() {
    // CHỈ trả metadata — KHÔNG BAO GIỜ trả token/secret (CỨM SECRETS).
    return {
      provider: 'zalo', mode: this.mode, configured: this.state.configured,
      connected: this.state.configured && this.state.connected
        && !this.state.token_expired && this.state.last_error_type !== 'config',
      last_webhook_at: this.state.last_webhook_at,
      last_success_at: this.state.last_success_at,
      last_error_type: this.state.last_error_type,
      token_expired: this.state.token_expired,
      quota_verified: this.state.quota_verified,
    };
  }

  _err(type) {
    this.state.last_error_type = type;
    if (type === 'config') this.state.connected = false;
  }

  // ================= 1) TOKEN LIFECYCLE =================
  _loadTokens() {
    try {
      if (this.tokenFile && fs.existsSync(this.tokenFile)) {
        const j = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8'));
        if (j && typeof j.access_token === 'string' && j.access_token) this.tokens.access_token = j.access_token;
        if (j && typeof j.refresh_token === 'string' && j.refresh_token) this.tokens.refresh_token = j.refresh_token;
        if (j && Number.isFinite(j.expires_at)) this.tokens.expires_at = j.expires_at;
      }
    } catch (e) { /* file hỏng -> dùng env */ }
  }

  // ATOMIC save: ghi .tmp rồi rename (cùng volume) — crash giữa chừng không để file nửa vời.
  _saveTokensAtomic() {
    const dir = path.dirname(this.tokenFile);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.tokenFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      access_token: this.tokens.access_token,
      refresh_token: this.tokens.refresh_token,
      expires_at: this.tokens.expires_at,
      saved_at: new Date().toISOString(),
    }, null, 1));
    fs.renameSync(tmp, this.tokenFile);
  }

  _callRefreshHttp() {
    const rt = this.tokens.refresh_token;
    if (!isConfigured(rt) || !isConfigured(this.cfg.appSecret)) {
      return { __config_missing: true };
    }
    this.refreshCalls.push({ at: new Date().toISOString() });
    return this.httpFn({
      url: this.oauthUrl,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        secret_key: String(this.cfg.appSecret), // chuẩn SDK Zalo (matrix B13)
      },
      body: JSON.stringify({ refresh_token: rt, app_id: this.cfg.appId, grant_type: 'refresh_token' }),
      timeoutMs: this.timeoutMs,
    });
  }

  _parseRefresh(res) {
    if (res && res.__config_missing) {
      this._err('config');
      this.state.token_expired = true;
      return { ok: false, error: 'ZALO_REFRESH_CONFIG_MISSING' };
    }
    if (res && res.timeout) { this._err('timeout'); this.state.token_expired = true; return { ok: false, error: 'timeout' }; }
    if (!res || res.error) {
      this._err('http_error'); this.state.token_expired = true;
      return { ok: false, error: (res && res.error) || 'http_error' };
    }
    let parsed = null;
    try { parsed = JSON.parse(res.bodyText || ''); } catch (e) { parsed = null; }
    if (res.status >= 200 && res.status < 300 && parsed && typeof parsed.access_token === 'string' && parsed.access_token) {
      // XOAY VÒNG: lưu ĐÈ CẢ HAI token (refresh cũ chết sau 1 lần dùng)
      this.tokens.access_token = parsed.access_token;
      if (typeof parsed.refresh_token === 'string' && parsed.refresh_token) this.tokens.refresh_token = parsed.refresh_token;
      const expiresInSec = Number(parsed.expires_in);
      this.tokens.expires_at = Number.isFinite(expiresInSec) && expiresInSec > 0
        ? Date.now() + expiresInSec * 1000
        : 0; // 0 = không biết hạn — CHƯA XÁC MINH tới khi có OA thật (B13)
      this._saveTokensAtomic();
      this.state.token_expired = false;
      this.state.connected = true;
      this.state.last_error_type = null;
      return {
        ok: true,
        access_token: this.tokens.access_token,
        refresh_token: this.tokens.refresh_token,
        expires_at: this.tokens.expires_at,
      };
    }
    this._err(`zalo_refresh_error:${res.status || 0}`);
    this.state.token_expired = true;
    return { ok: false, error: 'ZALO_REFRESH_FAILED' };
  }

  // SINGLE-FLIGHT refresh (API ASYNC — route/health/test await): 5 gọi đồng thời = ĐÚNG 1 HTTP.
  refreshToken() {
    if (this._refreshing) return this._refreshing;
    this._refreshing = Promise.resolve()
      .then(() => {
        const out = this._callRefreshHttp();
        return (out && typeof out.then === 'function') ? out.then(x => this._parseRefresh(x)) : this._parseRefresh(out);
      })
      .finally(() => { this._refreshing = null; });
    return this._refreshing;
  }

  // Refresh ĐỒNG BỘ (dùng trong sendMessage — hợp đồng gate sync). Nếu httpFn trả Promise
  // (mock chậm) thì đăng ký vào lock cho caller async và báo busy AN TOÀN (không gửi tin nào).
  refreshTokenSync() {
    if (this._refreshing) return { ok: false, error: 'refresh_in_progress', busy: true };
    const out = this._callRefreshHttp();
    if (out && typeof out.then === 'function') {
      this._refreshing = out.then(x => this._parseRefresh(x)).finally(() => { this._refreshing = null; });
      return { ok: false, error: 'refresh_in_progress', busy: true };
    }
    return this._parseRefresh(out);
  }

  // Token còn hạn/không biết hạn -> dùng luôn; hết hạn/hết token -> refresh 1 lần.
  tokenUsable() {
    if (!isConfigured(this.tokens.access_token)) return false;
    if (this.tokens.expires_at && Date.now() > this.tokens.expires_at - 5 * 60 * 1000) return false;
    return true;
  }

  // ================= 2) WEBHOOK NORMALIZE =================
  // X-ZEvent-Signature = sha256(appId + data + timeStamp + OAsecretKey) (matrix B12) —
  // data = raw body string, timeStamp = body.timestamp (ms). Verify khi có đủ secret + header.
  verifyWebhookSignature(rawBody, header, timestampMs) {
    if (!isConfigured(this.cfg.appSecret) || !header) return false;
    const expected = crypto.createHash('sha256')
      .update(`${this.cfg.appId || ''}${String(rawBody)}${String(timestampMs || '')}${this.cfg.appSecret}`)
      .digest('hex');
    return expected === String(header).toLowerCase();
  }

  // bodyJson = JSON của webhook Zalo. Trả {events, receipts, ignored}.
  // msg_id = platformEventId -> dedupe tầng gateway (INV-1).
  normalizeWebhook(bodyJson, { receivedAt } = {}) {
    const nowIso = receivedAt || new Date().toISOString();
    this.state.last_webhook_at = nowIso;
    const out = { events: [], receipts: [], ignored: 0 };
    const b = bodyJson && typeof bodyJson === 'object' ? bodyJson : {};
    const eventName = String(b.event_name || '');
    const sender = (b.sender && b.sender.id) ? String(b.sender.id) : null;
    const at = isoOf(b.timestamp, nowIso);
    const msgId = (b.message && b.message.msg_id) || null;
    if (!eventName) { out.ignored += 1; return out; }

    if (eventName === 'user_send_text' && sender) {
      out.events.push(userEnv(msgId || `${sender}:${b.timestamp}`, sender, {
        kind: 'text', text: String((b.message && b.message.text) || ''),
        platform_message_id: msgId, timestamp_platform: at,
      }));
    } else if (eventName === 'user_send_image' && sender) {
      const att = (b.message && Array.isArray(b.message.attachments) && b.message.attachments[0]) || null;
      out.events.push(userEnv(msgId || `${sender}:${b.timestamp}`, sender, {
        kind: 'image', text: String((b.message && b.message.text) || ''),
        media: {
          platform_url: att && att.payload ? att.payload.url : null,
          thumbnail: att && att.payload ? att.payload.thumbnail : null,
          type: 'image',
        },
        platform_message_id: msgId, timestamp_platform: at,
      }));
    } else if (eventName === 'user_send_audio' && sender) {
      // VOICE: CHỈ ĐÁNH DẤU chưa bật (P2) — cờ voice_not_enabled; pipeline ASR-fail -> NEEDS_HUMAN
      // (không bịa text, đúng case 4). ASR Zalo thật là việc CHƯA XÁC MINH.
      const att = (b.message && Array.isArray(b.message.attachments) && b.message.attachments[0]) || null;
      out.events.push(userEnv(msgId || `${sender}:${b.timestamp}`, sender, {
        kind: 'voice', text: '',
        media: { platform_url: att && att.payload ? att.payload.url : null, type: 'audio.amr' },
        platform_message_id: msgId, timestamp_platform: at,
        voice_not_enabled: true,
      }));
    } else if (eventName.startsWith('user_send_') || eventName.startsWith('anonymous_send_')) {
      // sticker/gif/video/file/link/location — P2 normalize tối giản: lưu loại event, không bịa nội dung
      out.events.push(userEnv(msgId || `${sender || 'anon'}:${b.timestamp}:${eventName}`, sender || 'anonymous', {
        kind: 'text', text: '', platform_message_id: msgId, timestamp_platform: at,
        unsupported_event: eventName,
      }));
    } else if (eventName === 'user_seen_message' && sender) {
      out.receipts.push({ conversation_id: `zalo:${sender}`, kind: 'user_seen_message', mid: msgId, at });
    } else if ((eventName === 'unfollow' || eventName === 'user_withdraw') && sender) {
      // opt-out cứng (case 18 / matrix B15) — đi đường opt_out_signal của pipeline
      out.events.push({
        channel: 'zalo',
        type: 'opt_out_signal',
        platformEventId: `${eventName}:${sender}:${b.timestamp || nowIso}`,
        payload: {
          customer_ref: sender, thread_id: sender, kind: 'text', text: '',
          platform_message_id: null, timestamp_platform: at, reason: eventName,
        },
      });
    } else {
      out.ignored += 1; // user_reacted/seen phụ, change_oa_daily_quota, event lạ...
    }
    return out;
  }

  // ================= 3) OUTBOUND CS (interface ActionGate gọi sau ALLOW — ĐỒNG BỘ) =================
  // sendMessage({clientMessageId, to, text}) — to = conversation_id 'zalo:<user_id>'.
  // Trả {ok:true, mid} | {ok:false, timeout:true} | {ok:false, error} — KHÔNG retry mù (INV-2).
  sendMessage({ clientMessageId, to, text } = {}) {
    void clientMessageId;
    this.sendCalls.push({ to, at: new Date().toISOString() });
    if (!this.isConfigured()) { this._err('config'); return { ok: false, error: 'ZALO_NOT_CONFIGURED' }; }
    const userId = String(to || '').split(':').slice(1).join(':');
    if (!userId) { this._err('bad_recipient'); return { ok: false, error: 'BAD_RECIPIENT' }; }

    if (!this.tokenUsable()) {
      const r = this.refreshTokenSync();
      if (!r.ok) {
        // busy (refresh đang chạy ở luồng async) hoặc refresh fail => KHÔNG gửi gì — fail RÕ, an toàn
        this.state.token_expired = true;
        return { ok: false, error: r.error === 'refresh_in_progress' ? 'ZALO_TOKEN_REFRESHING' : 'ZALO_TOKEN_EXPIRED' };
      }
    }

    const res = this.httpFn({
      url: this.csUrl,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        access_token: String(this.tokens.access_token), // chuẩn Zalo OA: token đi header
      },
      body: JSON.stringify({ recipient: { user_id: userId }, message: { text: String(text || '') } }),
      timeoutMs: this.timeoutMs,
    });
    if (res && res.timeout) { this._err('timeout'); return { ok: false, timeout: true }; }
    if (!res || res.error) { this._err('http_error'); return { ok: false, error: (res && res.error) || 'http_error' }; }

    let parsed = null;
    try { parsed = JSON.parse(res.bodyText || ''); } catch (e) { parsed = null; }
    // ĐỌC response code/data: HTTP 200 KHÔNG tự động = thành công — success chỉ khi error === 0
    if (parsed && Number(parsed.error) === 0) {
      const mid = (parsed.data && (parsed.data.msg_id || parsed.data.message_id)) || null;
      this.state.last_success_at = new Date().toISOString();
      this.state.connected = true;
      this.state.last_error_type = null;
      return { ok: true, mid };
    }
    const errCode = parsed ? Number(parsed.error) : -1;
    // lỗi token/auth -> đánh dấu hết hạn (lần gửi SAU sẽ refresh) — KHÔNG retry tin này (INV-2)
    if (errCode === -10 || errCode === 31 || errCode === 420 || errCode === -401) {
      this.state.token_expired = true;
      this._err(`zalo_auth_error:${errCode}`);
    } else {
      this._err(`zalo_api_error:${errCode}`);
    }
    return { ok: false, error: this.state.last_error_type };
  }

  // ================= 4) QUOTA (matrix B6 — đọc động, ĐỒNG BỘ theo hợp đồng gate) =================
  // Trả {remain, total, source}: source 'api' khi account trả cs_reply; không trả field =>
  // giá trị THIẾT KẾ 8/48h đánh dấu 'design_default_unverified' + quota_verified=false.
  getQuota(userRef) {
    const now = Date.now();
    if (this.quotaCache.value && now - this.quotaCache.at < QUOTA_CACHE_MS) return this.quotaCache.value;
    const fallback = {
      remain: 8, total: 8, source: 'design_default_unverified',
      fetched_at: new Date(now).toISOString(),
    };
    if (!this.isConfigured() || !isConfigured(this.tokens.access_token)) {
      this.state.quota_verified = false;
      return fallback;
    }
    let res;
    try {
      res = this.httpFn({
        url: this.quotaUrl, method: 'POST',
        headers: { 'Content-Type': 'application/json', access_token: String(this.tokens.access_token) },
        body: JSON.stringify({ user_id: String(userRef || '') }),
        timeoutMs: this.timeoutMs,
      });
    } catch (e) {
      this.state.quota_verified = false;
      return fallback;
    }
    let parsed = null;
    try { parsed = JSON.parse((res && res.bodyText) || ''); } catch (e) { parsed = null; }
    const q = parsed && parsed.data ? (parsed.data.quota || parsed.data) : (parsed ? parsed.quota : null);
    const cs = q && q.cs_reply;
    if (parsed && Number(parsed.error) === 0 && cs
      && Number.isFinite(Number(cs.remain)) && Number.isFinite(Number(cs.total))) {
      this.state.quota_verified = true;
      this.state.connected = true;
      const value = { remain: Number(cs.remain), total: Number(cs.total), source: 'api', fetched_at: new Date(now).toISOString() };
      this.quotaCache = { at: now, value };
      return value;
    }
    this.state.quota_verified = false;
    return fallback; // không claim verified — UI/health bào rõ qua providerStatus
  }

  // Mirror caller-side khi gate báo tin CS accepted (platform-side trừ tại Zalo) — compat interface.
  consumeCs(userRef) {
    this.consumedCs.push({ userRef, at: new Date().toISOString() });
    if (this.quotaCache.value && Number.isFinite(this.quotaCache.value.remain)) {
      this.quotaCache.value = { ...this.quotaCache.value, remain: Math.max(0, this.quotaCache.value.remain - 1) };
    }
    return null;
  }
}

function userEnv(platformEventId, sender, payloadExtra) {
  return {
    channel: 'zalo',
    type: 'message',
    platformEventId: `zlmsg:${platformEventId}`,
    payload: {
      customer_ref: String(sender),
      thread_id: String(sender), // 1 user = 1 thread với OA
      platform_message_id: null,
      timestamp_platform: null,
      ...payloadExtra,
    },
  };
}

function isoOf(ms, fallback) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return new Date(n).toISOString();
}

// ============================================================ ChannelRouter
// Router platform cho LIVE mode: ActionGate truyền `to` = conversation_id '<channel>:<ref>' —
// router chia theo channel prefix cho adapter đúng. getQuota/consumeCs chỉ zalo dùng (BL-2:
// gate chỉ đọc budget khi channel zalo). KHÔNG có policy nào ở đây — chỉ định tuyến.
class ChannelRouter {
  constructor({ facebook, zalo } = {}) {
    this.facebook = facebook || null;
    this.zalo = zalo || null;
  }

  sendMessage(params = {}) {
    const channel = String(params.to || '').split(':')[0];
    const adapter = channel === 'zalo' ? this.zalo : (channel === 'facebook' ? this.facebook : null);
    if (!adapter) return { ok: false, error: `NO_ADAPTER_FOR_CHANNEL:${channel}` };
    return adapter.sendMessage(params); // cả hai adapter ĐỒNG BỘ theo hợp đồng gate
  }

  getQuota(userRef) {
    return this.zalo ? this.zalo.getQuota(userRef) : { remain: 8, total: 8, source: 'no_adapter' };
  }

  consumeCs(userRef) {
    if (this.zalo && this.zalo.consumeCs) this.zalo.consumeCs(userRef);
  }

  providerStatus() {
    return {
      meta: this.facebook ? this.facebook.providerStatus() : null,
      zalo: this.zalo ? this.zalo.providerStatus() : null,
    };
  }
}

module.exports = { ZaloAdapter, ChannelRouter };
