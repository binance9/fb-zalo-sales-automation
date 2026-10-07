'use strict';
// ai-provider.js — AI PROVIDER MANAGEMENT (PHASE PRODUCT-READY).
//
// Settings AI per shop (ShopSettings keys: ai_provider, ai_api_key, ai_model, ai_timeout, ai_fallback):
//   { provider: deepseek|openai|gemini|grok|kimi|local, api_key, model, timeout, fallback }
//
// AICAKE G3 (đa model — chuẩn aicake.vn: ChatGPT/Gemini/DeepSeek/Grok/Kimi): thêm gemini/grok/kimi.
// Cả 3 đều hỗ trợ endpoint OpenAI-style /chat/completions (Authorization: Bearer) nên dùng chung
// đường wire hiện có (testAiProvider + sales-ai._tryLLM) — KHÔNG đổi logic wire/validate.
//
// - POST test: gọi THẬT 1 request ngắn (provider thật dùng httpOnce curl-sync của live-http;
//   test offline TIÊM httpFn). Lỗi -> ERROR + last_error. KHÔNG BAO GIỜ log/trả api_key
//   (mọi view trả maskKey: '***' + 4 ký tự cuối).
// - status: ONLINE | ERROR | DISABLED (chưa cấu hình) + last_success/last_error.
// - provider 'local' = LLM stub nội bộ (prototype) -> test PASS ngay không ra mạng (ghi rõ nguồn).

const { httpOnce } = require('./live-http');

const PROVIDERS = {
  deepseek: { defaultModel: 'deepseek-chat', url: 'https://api.deepseek.com/chat/completions' },
  openai: { defaultModel: 'gpt-4o-mini', url: 'https://api.openai.com/v1/chat/completions' },
  // AICAKE G3: gemini/grok/kimi — OpenAI-compatible /chat/completions (key vẫn qua header Bearer).
  gemini: { defaultModel: 'gemini-2.0-flash', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' },
  grok: { defaultModel: 'grok-3-mini', url: 'https://api.x.ai/v1/chat/completions' },
  kimi: { defaultModel: 'kimi-k2-0905-preview', url: 'https://api.moonshot.cn/v1/chat/completions' },
  local: { defaultModel: 'sales-ai-stub', url: null }, // stub nội bộ — không gọi mạng
};

function maskKey(k) {
  const s = String(k || '');
  if (!s) return '(empty)';
  if (s.length <= 4) return '***';
  return '***' + s.slice(-4);
}

// ================= SURI CLOSURE F5 (JEV LOW-5): ALLOWLIST ĐÍCH MẠNG ai_base_url =================
// Chặn ở HAI TẦNG:
//   (1) SAVE — saveAiConfig: cấu hình bẩn (host nội bộ / metadata IP / scheme lạ) KHÔNG lưu được;
//   (2) CALL — sales-ai._tryLLM + testAiProvider: deep defense (settings bị sửa tay/DB bẩn
//       vẫn không được phép gọi ra ngoài).
// CHO PHÉP: api.deepseek.com, api.openai.com, generativelanguage.googleapis.com (Gemini),
// api.x.ai (Grok), api.moonshot.cn (Kimi) (CHỈ https) + loopback 127.0.0.1/localhost/[::1]
// (http lẫn https — provider Local/ÚC phê duyệt, dùng cho mock test local + gateway riêng).
// CHẶN: mọi host khác — kể cả IP nội bộ (10.x, 172.16-31.x, 192.168.x, 169.254.x metadata,
// 0.0.0.0), host .local/.internal/.lan/.intranet, scheme không phải http(s) (file://, ftp://),
// URL chứa username/password.
const AI_BASE_URL_ALLOW = new Set([
  'api.deepseek.com', 'api.openai.com',
  // AICAKE G3: host mặc định của 3 provider mới (deep defense tầng CALL cho base_url tuỳ chỉnh).
  'generativelanguage.googleapis.com', 'api.x.ai', 'api.moonshot.cn',
]);
const AI_LOOPBACK_HOST = /^(localhost|\[::1\]|::1|127(\.\d{1,3}){3})$/i;

// aiBaseUrlCheck(raw) -> { ok: true } | { ok: false, reason }
function aiBaseUrlCheck(raw) {
  const s = String(raw || '').trim();
  let u = null;
  try { u = new URL(s); } catch (e) { return { ok: false, reason: 'not_a_url' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'scheme_' + u.protocol.replace(':', '') };
  if (u.username || u.password) return { ok: false, reason: 'credentials_in_url' };
  const host = u.hostname.toLowerCase();
  if (AI_LOOPBACK_HOST.test(host)) return { ok: true };
  if (u.protocol === 'http:') return { ok: false, reason: 'https_required' };
  if (AI_BASE_URL_ALLOW.has(host)) return { ok: true };
  if (/\.(local|internal|lan|intranet)$/.test(host)) return { ok: false, reason: 'private_host' };
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return { ok: false, reason: 'private_or_unapproved_ip' };
  return { ok: false, reason: 'host_not_allowlisted' };
}

// Lưu config AI vào ShopSettings. Trả view (đã mask key). Ném lỗi validate -> caller trả 400.
// SURI P2: thêm use_for_replies (settings.ai.useForReplies — mặc định TRUE khi provider ONLINE).
// SURI ASYNC (LỖI 2 — Bước 2, cho phép trong allowlist): thêm `base_url` (settings `ai_base_url`)
// — trỏ provider OpenAI-compatible tới endpoint TUỲ CHỈNH (mock test local / gateway riêng).
// Rỗng/null => dùng URL mặc định của provider. KHÔNG phải secret (view trả nguyên văn).
function saveAiConfig(shopSettings, { provider, api_key, model, timeout, fallback, use_for_replies, base_url } = {}) {
  const p = String(provider || '').toLowerCase();
  if (!PROVIDERS[p]) throw new Error('BAD_PROVIDER');
  const key = String(api_key === undefined ? (shopSettings.get('ai_api_key') || '') : api_key).trim();
  if (/\s/.test(key)) throw new Error('BAD_API_KEY');
  // SURI STABILITY (LỖI 2 — mitigation-a): default timeout 20000 -> 8000. propose hiện SYNC
  // (curl chặn event loop suốt thời gian chờ — probe đo block == thời gian call); 20s là quá
  // dài với bot tin nhắn. Chỉ đổi MẶC ĐỊNH: shop đã cấu hình ai_timeout giữ nguyên giá trị.
  const t = Number(timeout === undefined ? (shopSettings.get('ai_timeout') || 8000) : timeout);
  if (!Number.isFinite(t) || t < 1000 || t > 120000) throw new Error('BAD_TIMEOUT');
  // SURI ASYNC: base_url tuỳ chọn — rỗng => xoá (dùng URL mặc định provider); có => phải http(s).
  const bu = base_url === undefined ? (shopSettings.get('ai_base_url') || '') : String(base_url || '').trim();
  if (bu && !/^https?:\/\/\S+$/i.test(bu)) throw new Error('BAD_BASE_URL');
  // SURI CLOSURE F5: allowlist đích mạng ở SAVE — host nội bộ/metadata/scheme lạ không lưu được.
  // Lỗi 'BAD_BASE_URL:...' -> server 400 (bảng friendly BAD_ đã map) — cấu hình bẩn không vào DB.
  if (bu) {
    const chk = aiBaseUrlCheck(bu);
    if (!chk.ok) throw new Error('BAD_BASE_URL:' + chk.reason);
  }
  shopSettings.setMany({
    ai_provider: p,
    ai_api_key: key,
    ai_model: String(model || PROVIDERS[p].defaultModel).trim() || PROVIDERS[p].defaultModel,
    ai_timeout: Math.round(t),
    ai_base_url: bu || null,
    ai_fallback: fallback === undefined ? shopSettings.get('ai_fallback', true) === true : !!fallback,
    // SURI P2 hạng mục 2: công tắc BẬT/TẮT AI cho lời tư vấn (không đổi provider/key).
    ai_use_for_replies: use_for_replies === undefined
      ? (shopSettings.get('ai_use_for_replies', true) !== false)
      : !!use_for_replies,
  });
  return aiView(shopSettings);
}

// SURI P2 hạng mục 2: đọc công tắc useForReplies (mặc định true — kể cả khi chưa cấu hình provider).
function useForReplies(shopSettings) {
  return shopSettings.get('ai_use_for_replies', true) !== false;
}

function getAiConfig(shopSettings) {
  const provider = String(shopSettings.get('ai_provider') || '').toLowerCase();
  if (!PROVIDERS[provider]) return null; // chưa cấu hình
  return {
    provider,
    api_key: shopSettings.get('ai_api_key') || '',
    model: shopSettings.get('ai_model') || PROVIDERS[provider].defaultModel,
    // SURI ASYNC: base_url tuỳ chỉnh theo shop (mock local / gateway riêng); null = URL mặc định.
    base_url: shopSettings.get('ai_base_url') || null,
    // SURI STABILITY (LỖI 2 — mitigation-a): default 8000 (khớp saveAiConfig — xem comment trên).
    timeout: Number(shopSettings.get('ai_timeout') || 8000),
    fallback: shopSettings.get('ai_fallback', true) === true,
    use_for_replies: useForReplies(shopSettings),
  };
}

// View cho API/UI — KHÔNG chứa api_key thô.
// AICAKE G3: thêm `providers` — danh sách provider + defaultModel cho UI chọn (không secret;
// aiView được /api/ai/status + /api/ai/config spread nên UI đọc 1 chỗ là đủ).
function listProvidersForUi() {
  return Object.keys(PROVIDERS).map(id => ({ id, defaultModel: PROVIDERS[id].defaultModel }));
}

function aiView(shopSettings) {
  const cfg = getAiConfig(shopSettings);
  if (!cfg) return { provider: null, status: 'DISABLED', model: null, base_url: null, timeout: null, fallback: null, use_for_replies: useForReplies(shopSettings), api_key_masked: null, providers: listProvidersForUi() };
  return {
    provider: cfg.provider,
    status: aiStatus(shopSettings).status,
    model: cfg.model,
    base_url: cfg.base_url,
    timeout: cfg.timeout,
    fallback: cfg.fallback,
    use_for_replies: cfg.use_for_replies,
    api_key_masked: maskKey(cfg.api_key),
    providers: listProvidersForUi(),
  };
}

function aiStatus(shopSettings) {
  const cfg = getAiConfig(shopSettings);
  if (!cfg) return { provider: null, status: 'DISABLED', last_success: shopSettings.get('ai_last_success') || null, last_error: null };
  const lastError = shopSettings.get('ai_last_error') || null;
  const lastSuccess = shopSettings.get('ai_last_success') || null;
  // ONLINE khi lần test gần NHẤT là thành công (last_success mới hơn last_error).
  const status = lastSuccess && (!lastError || String(lastSuccess) >= String(lastError)) ? 'ONLINE' : (lastError ? 'ERROR' : 'UNKNOWN');
  return { provider: cfg.provider, status, last_success: lastSuccess, last_error: lastError };
}

// Gọi THẬT 1 request ngắn. httpFn tiêm vào cho test offline; mặc định httpOnce (curl sync).
// Trả {ok, error} — KHÔNG đưa key vào error string.
async function testAiProvider(shopSettings, { httpFn } = {}) {
  const cfg = getAiConfig(shopSettings);
  if (!cfg) return { ok: false, error: 'AI_NOT_CONFIGURED' };
  const now = new Date().toISOString();
  const record = (ok, error) => {
    if (ok) shopSettings.setMany({ ai_last_success: now });
    else shopSettings.setMany({ ai_last_error: now, ai_last_error_msg: error || null });
    return { ok, error: error || null };
  };
  if (cfg.provider === 'local') {
    // LLM stub nội bộ (prototype) — không ra mạng; hợp lệ = cấu hình dùng được.
    return record(true, null);
  }
  if (!cfg.api_key) return record(false, 'MISSING_API_KEY');
  const spec = PROVIDERS[cfg.provider];
  // SURI ASYNC: test cũng tôn trọng base_url tuỳ chỉnh của shop (mock local / gateway riêng).
  const url = (cfg.base_url && /^https?:\/\//i.test(String(cfg.base_url))) ? String(cfg.base_url) : spec.url;
  // SURI CLOSURE F5: chặn đích mạng ở CALL (deep defense — settings sửa tay/DB bẩn vẫn không
  // được gọi ra host không allowlist). Ghi LỖI THẬT vào status, KHÔNG echo URL nội bộ ra ngoài
  // qua message thân thiện (error code ngắn không chứa host).
  if (cfg.base_url) {
    const chk = aiBaseUrlCheck(cfg.base_url);
    if (!chk.ok) return record(false, 'base_url_blocked:' + chk.reason);
  }
  const http = httpFn || httpOnce;
  let res;
  try {
    res = await Promise.resolve(http({
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.api_key}`, // key đi HEADER (không nằm trong URL/log)
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
      timeoutMs: cfg.timeout,
    }));
  } catch (e) {
    return record(false, 'http_error:' + String((e && e.message) || e).slice(0, 200));
  }
  if (res && res.timeout) return record(false, 'timeout');
  if (!res || !res.ok) return record(false, 'http_error:' + String(res && res.error || 'unknown').slice(0, 200));
  if (res.status !== 200) {
    // 401/403 -> sai key; không bao giờ echo body (body có thể chứa key/đoạn request)
    return record(false, `http_status_${res.status}`);
  }
  let ok = false;
  try { const j = JSON.parse(res.bodyText || '{}'); ok = !!(j && (j.id || j.object || j.choices)); } catch (e) { ok = false; }
  return ok ? record(true, null) : record(false, 'bad_response_shape');
}

module.exports = { PROVIDERS, maskKey, aiBaseUrlCheck, saveAiConfig, getAiConfig, aiView, aiStatus, testAiProvider, useForReplies };
