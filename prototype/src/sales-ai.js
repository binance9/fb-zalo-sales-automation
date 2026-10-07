'use strict';
// sales-ai.js — LỚP MODEL của Sales AI: STUB rule-based + LLM LIVE (DeepSeek) cho PHẦN CÂU CHỮ.
//
// SURI PHASE 2 (nâng cấp chính của đợt): khi AI provider ĐÃ CẤU HÌNH (provider + key qua
// ai-provider — DeepSeek đã wire live từ đợt P1), lời TƯ VẤN SẢN PHẨM / GIÁ / TỒN / CHIT-CHAT
// được DeepSeek VIẾT CÂU CHỮ trên nền FACTS. PHÂN LỚP BẮT BUỘC (không đổi so với thiết kế cũ):
//   - INTENT DETECTION: deterministic (pipeline.detectIntent — KHÔNG qua LLM).
//   - ORDER FLOW:       deterministic (parser slot + order engine + gate — LLM KHÔNG được
//                       tự quyết tạo đơn; intent BUY_ASK giữ template hỏi trường thiếu).
//   - FACTS (giá/tồn):  deterministic — pipeline.buildFacts dựng từ ProductDB fresh mỗi tin.
//   - LLM (DeepSeek):   CHỈ viết CÂU CHỮ cho PRICE/VARIANT/STOCK/CHITCHAT trên đúng FACTS đó.
// Gate vẫn ghi đè số sai (P3C money guard — action-gate.buildAllowedMoney + replaceBadMoney
// Sentences): mọi con số trong câu LLM không có evidence trong FACTS/đơn => bị đè bằng câu
// render CHÍNH THỨC từ DB. Khi AI lỗi/timeout => fallback FAQ STUB như cũ, không crash.
//
// RÀNG BUỘC CẤU TRÚC (giữ nguyên từ đợt trước):
//   - File này KHÔNG import store/product-db/gateway. Nó chỉ nhận FACTS (JSON do code dựng từ DB)
//     và trả về LỜI ĐỀ NGHỊ (text + evidence + confidence). KHÔNG có đường gọi DB hay API gửi tin.
//   - Mạng CHỈ qua httpFn (SYNC — test offline tiêm; giữ propose SYNC cho toàn bộ regression cũ)
//     hoặc asyncHttpFn (SURI ASYNC — production mặc định httpOnceAsync của live-http: đường LLM
//     không còn chặn event loop; propose trả Promise, pipeline tiếp diễn qua helper _then).
//   - Stub CÓ THỂ BỊA (case 8): khi câu hỏi chứa "giá sốc", nó tự tính giá -50% — để chứng minh
//     Action Gate chặn bằng cách đối chiếu số tiền trong text với DB. Hành vi stub GIỮ NGUYÊN
//     (dùng cho regression + fallback); LLM mode KHÔNG thừa hưởng lỗi bịa này (system prompt cấm).
//   - Tách FACTS / WORDING (AI2 mục 5): mọi con số ĐÚNG phải đến từ `facts`.

const { fmtVND } = require('./util');
const { httpOnce, httpOnceAsync } = require('./live-http');
const { PROVIDERS, aiBaseUrlCheck } = require('./ai-provider');
const persona = require('./persona'); // AICAKE SOUL: nhân vật + chit-chat vui vẻ (2026-10-06)

// BL-3 (P3A): GUARD RUNTIME — ctx đưa vào model KHÔNG ĐƯỢC chứa PII.
// Pipeline phải truyền ctx trắng { state, mode, subject_sku } + text ĐÃ redact + FACTS từ DB.
// Nếu guard vang lên nghĩa là có đường code mới đang rò PII vào model — FAIL ngay, không nuốt.
const RE_MODEL_PII_PHONE = /(?:\+?84|0)(?:3|5|7|8|9)\d{8,9}(?!\d)/;

function assertModelCtxSafe(intent, ctx) {
  const s = JSON.stringify(ctx);
  if (RE_MODEL_PII_PHONE.test(s)) {
    throw new Error(`MODEL_CONTEXT_PII_CHECK: ctx của intent ${intent} chứa số điện thoại (BL-3) — pipeline phải redactPii trước khi propose`);
  }
}

// Intent LLM được viết câu chữ (tư vấn tự do trên nền FACTS). Ngoài list này — deterministic:
//   BUY_ASK  : luồng đơn (hỏi trường thiếu) — cấm LLM tự do quanh đơn hàng.
//   ATTR_UNKNOWN: DB không có dữ liệu — cấm LLM đoán (case 14) => needHuman.
//   các intent hệ thống khác (OUT_OF_STOCK, ORDER_*, CANCEL_*) do pipeline dựng text trực tiếp.
const LLM_INTENTS = new Set(['PRICE', 'VARIANT', 'STOCK', 'CHITCHAT']);

const MAX_LLM_TEXT_CHARS = 1500;

// ---------------------------------------------------------- FACTS -> block cho system prompt
// buildFacts của pipeline dựng { subjectProduct, variants:[{sku,size,color,price,effective}] }.
// Đây là DUY NHẤT nguồn số liệu LLM được phép dùng — render thành text rõ ràng, kèm luật.
function buildFactsBlock(facts, ctx) {
  const f = facts || {};
  const variants = Array.isArray(f.variants) ? f.variants : [];
  const lines = [];
  lines.push('## FACTS — DỮ LIỆU CHÍNH THỨC TỪ DATABASE (bắt buộc tuân thủ)');
  lines.push('Mọi GIÁ / TỒN KHO / SKU trong câu trả lời PHẢI khớp CHÍNH XÁC bảng dưới.');
  lines.push('Số nào KHÔNG có trong FACTS thì TUYỆT ĐỐI KHÔNG được nói ra (kể cả giá ưu đãi, giảm giá).');
  if (f.subjectProduct) lines.push(`Sản phẩm khách đang hỏi: ${f.subjectProduct.name}`);
  if (variants.length) {
    lines.push('Bảng variant (sku | size | màu | giá | tồn khả dụng):');
    for (const v of variants) {
      lines.push(`- ${v.sku} | size ${v.size}${v.color ? ' | màu ' + v.color : ''} | ${fmtVND(v.price)}đ | ${v.effective > 0 ? `còn ${v.effective}` : 'HẾT HÀNG'}`);
    }
  } else {
    lines.push('(không có variant nào trong FACTS — không được nêu bất kỳ giá/tồn nào)');
  }
  const missing = ctx && ctx.draftMissing;
  if (Array.isArray(missing) && missing.length) {
    lines.push(`Thứ tự thông tin CẦN HỎI KHÁCH (hỏi ĐÚNG MỘT thứ đầu tiên, không hỏi dồn): ${missing.join(' -> ')}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------- instruction per intent (ngắn, cứng)
const INTENT_INSTRUCTION = {
  PRICE: 'Khách HỎI GIÁ. Trả lời bằng đúng giá trong FACTS (liệt kê theo variant). Không giảm giá tự phong, không hứa khuyến mãi.',
  VARIANT: 'Khách HỎI TỒN/PHÂN LOẠI. Trả lời theo cột tồn trong FACTS: còn bao nhiêu hoặc hết hàng. Không hứa nhập hàng.',
  STOCK: 'Khách hỏi CÒN HÀNG không. Trả lời đúng theo cột tồn trong FACTS.',
  CHITCHAT: 'Khách nhắn chuyện ngoài/tư vấn chung. Trả lời thân thiện, GIỐNG NHÂN VIÊN BÁN HÀNG; nếu lời tư vấn cần số liệu (giá/tồn/chính sách) mà FACTS không có thì mời khách để lại số điện thoại hoặc nói sẽ chuyển nhân viên tư vấn — KHÔNG bịa.',
};

// Làm sạch text LLM: bỏ fence markdown, khoảng trắng 2 đầu, giới hạn độ dài.
function sanitizeLLMText(t) {
  let s = String(t || '').trim();
  s = s.replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/, '').trim();
  if (s.length > MAX_LLM_TEXT_CHARS) s = s.slice(0, MAX_LLM_TEXT_CHARS - 3).trimEnd() + '...';
  return s;
}

class SalesAI {
  // opts.getConfig : () => runtime AI | null. Runtime: { provider, api_key, model, timeout,
  //                  base_url, useForReplies, systemPrompt }. App wiring đọc từ ShopSettings
  //                  MỖI LẦN propose (đổi config không cần restart). null/undefined => stub như cũ.
  // opts.httpFn    : tiêm HTTP ĐỒNG BỘ cho test offline ({url,method,headers,body,timeoutMs} ->
  //                  {ok,status,bodyText} | {ok:false,timeout:true} | {ok:false,error}).
  //                  Khi httpFn ĐƯỢC TIÊM => toàn bộ propose giữ SYNC (regression cũ nguyên trạng).
  // opts.asyncHttpFn : tiêm HTTP KHÔNG chặn (trả Promise cùng shape) — test đường async;
  //                  mặc định httpOnceAsync của live-http (spawn curl không sync — SURI ASYNC).
  // SURI ASYNC (LỖI 2): khi KHÔNG có httpFn sync tiêm vào (production), đường LLM dùng
  // asyncHttpFn => propose trả PROMISE cho các intent LLM (PRICE/VARIANT/STOCK/CHITCHAT);
  // stub local vẫn sync-instant (trả giá trị thường). Pipeline xử lý CẢ HAI (see pipeline._then).
  constructor(opts = {}) {
    this.getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : null;
    this.httpFn = opts.httpFn || null; // null => đường production: LLM đi async (httpOnceAsync)
    this.asyncHttpFn = opts.asyncHttpFn !== undefined ? opts.asyncHttpFn : null;
    this.lastEngine = 'stub';          // 'stub' | 'llm:<provider>' — engine của lần propose cuối
    this.stats = { llm_calls: 0, llm_ok: 0, llm_fallback: 0, last_fallback_reason: null };
  }

  // Runtime AI hiện tại: có provider ngoài (deepseek/openai) + key + KHÔNG bị tắt useForReplies.
  // provider 'local' = stub nội bộ (định nghĩa của ai-provider) => không gọi mạng.
  _aiRuntime() {
    if (!this.getConfig) return null;
    let cfg = null;
    try { cfg = this.getConfig(); } catch (e) { return null; }
    if (!cfg || !PROVIDERS[cfg.provider] || cfg.provider === 'local') return null;
    if (!cfg.api_key) return null;
    if (cfg.useForReplies === false) return null; // settings.ai.useForReplies=false => stub
    return cfg;
  }

  // intent: PRICE | VARIANT | STOCK | BUY_ASK | ATTR_UNKNOWN | CHITCHAT
  // ctx (BL-3 — hợp đồng bắt buộc): { state, mode, subject_sku, text (ĐÃ redact PII),
  //        normText, facts: {subjectProduct, variants:[{sku,size,color,price,effective}]},
  //        draftMissing:[...] }
  // CẤM truyền: object conv nguyên vẹn, customer object, draft.slots (phone/address/name),
  //        token/secret. Model KHÔNG phải nguồn sự thật và KHÔNG được thấy PII khách.
  // SURI ASYNC: propose trả GIÁ TRỊ THƯỜNG (stub, hoặc LLM qua httpFn sync tiêm vào — regression
  // cũ nguyên trạng) HOẶC PROMISE (đường LLM production qua asyncHttp). Caller (pipeline) xử lý
  // cả hai qua helper _then — tiếp diễn ĐÚNG code cũ trong cả hai trường hợp.
  propose(intent, ctx) {
    assertModelCtxSafe(intent, ctx);
    const cfg = this._aiRuntime();
    if (cfg && LLM_INTENTS.has(intent)) {
      const llm = this._tryLLM(intent, ctx, cfg);
      if (llm && typeof llm.then === 'function') {
        // đường async: LLM trả muộn; lỗi/timeout/response xấu => fallback FAQ STUB (không crash)
        return llm.then(res => {
          if (res) return res;
          this.lastEngine = 'stub';
          return this.stubPropose(intent, ctx);
        });
      }
      if (llm) return llm;
      // AI lỗi/timeout/response xấu => fallback FAQ STUB (không crash, không gửi rỗng)
      this.lastEngine = 'stub';
      return this.stubPropose(intent, ctx);
    }
    this.lastEngine = 'stub';
    return this.stubPropose(intent, ctx);
  }

  // ---------------- LLM LIVE (DeepSeek) — chỉ WORDING, số liệu 100% từ FACTS ----------------
  // Sync path (httpFn tiêm vào): trả proposal | null (fallback stub) — NHƯ CŨ.
  // Async path (production): trả Promise<proposal | null> — cùng ngữ nghĩa, không chặn loop.
  _tryLLM(intent, ctx, cfg) {
    this.stats.llm_calls += 1;
    try {
      const spec = PROVIDERS[cfg.provider] || PROVIDERS.deepseek;
      const model = cfg.model || spec.defaultModel;
      // SURI ASYNC (LỖI 2): base_url tuỳ chỉnh theo shop (ai-provider.getAiConfig) — mock local
      // / gateway riêng; null/rỗng => URL mặc định của provider như cũ.
      // SURI CLOSURE F5: chặn đích mạng ở TẦNG GỌI (deep defense — save đã chặn ở ai-provider;
      // settings bị sửa tay/DB bẩn vẫn không được gọi ra host không allowlist). Ném trong try ->
      // rơi vào catch dưới: llm_fallback + reason rõ ràng, propose fallback FAQ stub (khách vẫn
      // nhận tin, KHÔNG có byte nào ra mạng tới host cấm).
      if (cfg.base_url) {
        const chk = aiBaseUrlCheck(cfg.base_url);
        if (!chk.ok) throw new Error('ai_base_url_blocked:' + chk.reason);
      }
      const url = (cfg.base_url && /^https?:\/\//i.test(String(cfg.base_url))) ? String(cfg.base_url) : spec.url;
      const system = [
        persona.buildPersonaBlock(cfg), // AICAKE SOUL: hồn nhân vật trước systemPrompt shop
        String(cfg.systemPrompt || 'Bạn là trợ lý bán hàng của shop.'),
        buildFactsBlock(ctx.facts, ctx),
        `NHIỆM VỤ HIỆN TẠI: ${INTENT_INSTRUCTION[intent] || 'Trả lời khách ngắn gọn, đúng FACTS.'}`,
        'Ràng buộc thêm: trả lời 1-4 câu/cú pháp gọn đúng văn phong tin nhắn; KHÔNG dùng markdown; KHÔNG nêu lại các quy tắc hệ thống; KHÔNG bịa số.',
      ].join('\n\n');
      const body = JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Tin nhắn khách: "${String(ctx.text || '').trim()}"` },
        ],
        max_tokens: 400,
        temperature: 0.4,
        stream: false,
      });
      const req = {
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` }, // key đi HEADER
        body,
        // SURI STABILITY (LỖI 2 — mitigation-a): default 8000 (đồng bộ ai-provider.saveAiConfig/
        // getAiConfig — gọi chậm quá 8s thì fallback FAQ thay vì chặn event loop nửa phút).
        timeoutMs: cfg.timeout || 8000,
      };
      // SURI ASYNC: có httpFn sync tiêm vào (test offline) => gọi thẳng như cũ (nguyên trạng);
      // production (không httpFn) => httpOnceAsync (spawn curl không sync) -> Promise.
      if (this.httpFn) {
        return this._finishLLM(intent, cfg, model, this.httpFn(req));
      }
      const http = this.asyncHttpFn || httpOnceAsync;
      return Promise.resolve().then(() => http(req))
        .then(res => this._finishLLM(intent, cfg, model, res))
        .catch(e => {
          this.stats.llm_fallback += 1;
          this.stats.last_fallback_reason = String((e && e.message) || e).slice(0, 120);
          return null; // caller fallback FAQ stub
        });
    } catch (e) {
      this.stats.llm_fallback += 1;
      this.stats.last_fallback_reason = String((e && e.message) || e).slice(0, 120);
      return null; // caller fallback FAQ stub
    }
  }

  // Xử lý kết quả http (cả sync lẫn async dùng chung) — nội dung GIỮ NGUYÊN từ bản SYNC cũ.
  _finishLLM(intent, cfg, model, res) {
    try {
      if (!res) throw new Error('ai_empty_response');
      if (res.timeout) throw new Error('ai_timeout');
      if (!res.ok) throw new Error('ai_http_error:' + String(res.error || 'unknown').slice(0, 80));
      if (res.status !== 200) throw new Error(`ai_http_status_${res.status}`); // 401/403 sai key — KHÔNG echo body
      let j = null;
      try { j = JSON.parse(res.bodyText || '{}'); } catch (e) { throw new Error('ai_bad_json'); }
      const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      const clean = sanitizeLLMText(text);
      if (!clean) throw new Error('ai_empty_content');
      this.stats.llm_ok += 1;
      this.lastEngine = 'llm:' + cfg.provider;
      return {
        intent,
        confidence: 0.85,
        engine: cfg.provider,
        model,
        evidence: { source: `ai_provider:${cfg.provider}`, model, facts_source: 'product_db' },
        text: clean,
      };
    } catch (e) {
      this.stats.llm_fallback += 1;
      this.stats.last_fallback_reason = String((e && e.message) || e).slice(0, 120);
      return null; // caller fallback FAQ stub
    }
  }

  // ---------------- STUB rule-based (fallback FAQ + toàn bộ regression cũ) ----------------
  stubPropose(intent, ctx) {
    const facts = ctx.facts || {};
    const variants = facts.variants || [];
    const p = facts.subjectProduct;

    switch (intent) {
      case 'PRICE': {
        // "Lỗi" có chủ đích của stub (chỉ kích hoạt khi câu hỏi chứa "giá sốc"):
        // bịa khuyến mãi -50% trên giá variant cuối (185000 -> 92500) — số tiền KHÔNG có trong facts.
        if (/gia soc|giá sốc/.test(String(ctx.text || '').toLowerCase()) || /gia soc/.test(ctx.normText || '')) {
          const v = variants[variants.length - 1] || variants[0];
          const fakePrice = Math.round((v ? v.price : 100000) * 0.5);
          return {
            intent, confidence: 0.85,
            evidence: { source: 'AI_TU_BIA', note: 'stub tự "sáng tạo" chương trình giá sốc -50%' },
            text: `Dạ bên em đang có GIÁ SỐC chỉ ${fmtVND(fakePrice)}đ cho ${p ? p.name : 'sản phẩm này'} nha anh/chị ạ!`,
          };
        }
        if (!variants.length) {
          return { intent, confidence: 0.1, evidence: null, text: null, needHuman: true };
        }
        const lines = variants.map(v => `- size ${v.size}${v.color ? ' màu ' + v.color : ''}: ${fmtVND(v.price)}đ`);
        return {
          intent, confidence: 0.95,
          evidence: { source: 'product_db', variants: variants.map(v => ({ sku: v.sku, price: v.price })) },
          text: `Dạ ${p ? p.name : 'sản phẩm'} bên em có giá như sau nha anh/chị:\n${lines.join('\n')}`,
        };
      }

      case 'VARIANT': {
        if (!variants.length) return { intent, confidence: 0.1, evidence: null, text: null, needHuman: true };
        const lines = variants.map(v =>
          `- size ${v.size}${v.color ? ' màu ' + v.color : ''}: ${v.effective > 0 ? `còn ${v.effective}` : 'hết hàng'} (${fmtVND(v.price)}đ)`);
        return {
          intent, confidence: 0.95,
          evidence: { source: 'product_db', variants: variants.map(v => ({ sku: v.sku, effective: v.effective })) },
          text: `Dạ tình trạng ${p ? p.name : 'sản phẩm'} hiện tại ạ:\n${lines.join('\n')}`,
        };
      }

      case 'STOCK': {
        const v = variants[0];
        if (!v) return { intent, confidence: 0.1, evidence: null, text: null, needHuman: true };
        const ok = v.effective > 0;
        return {
          intent, confidence: 0.9,
          evidence: { source: 'product_db', sku: v.sku, effective: v.effective },
          text: ok
            ? `Dạ ${p.name} (${v.size}${v.color ? ' màu ' + v.color : ''}) vẫn còn ${v.effective} cái, anh/chị muốn lấy nha ạ!`
            : `Dạ anh/chị ơi, ${p.name} (${v.size}${v.color ? ' màu ' + v.color : ''}) mình vừa hết hàng rồi ạ.`,
        };
      }

      case 'BUY_ASK': {
        // Hỏi đúng trường còn thiếu (ưu tiên SĐT -> địa chỉ -> xác nhận, AI2 mục 1 state COLLECT_ORDER)
        const missing = ctx.draftMissing || [];
        let ask;
        if (missing.includes('phone')) ask = 'anh/chị cho em xin SĐT để xác nhận đơn nha ạ';
        else if (missing.includes('address')) ask = 'anh/chị cho em xin địa chỉ giao hàng nha ạ';
        else if (missing.includes('name')) ask = 'em xin tên anh/chị để lập đơn nha ạ';
        else ask = 'anh/chị xác nhận giúp em đơn này nha ạ';
        return { intent, confidence: 0.9, evidence: { missing }, text: `Dạ em ghi nhận ${describeCart(variants)} nhé ạ! ${ask}.` };
      }

      case 'ATTR_UNKNOWN': {
        // Case 14: câu hỏi thuộc tính sản phẩm mà DB không có field tương ứng -> KHÔNG được đoán.
        return {
          intent, confidence: 0.1, evidence: null, text: null, needHuman: true,
          note: 'DB không có dữ liệu về thuộc tính được hỏi — cấm bịa',
        };
      }

      case 'CHITCHAT':
      default: {
        // AICAKE SOUL: chit-chat vui vẻ (chào/cảm ơn/hỏi tên/than thở/ship/CK/khuyến mãi...)
        // — pool ổn định theo hash, đan hook sản phẩm THẬT từ FACTS. Không khớp nhóm nào
        // chitchatReply vẫn trả 'default' (đã là intent CHITCHAT thì luôn có lời).
        const soul = persona.chitchatReply(ctx.text || '', ctx);
        return {
          intent: 'CHITCHAT', confidence: 0.75, evidence: { source: 'persona_stub' },
          text: soul || 'Dạ em là trợ lý của shop, anh/chị cần tư vấn sản phẩm nào cứ nhắn em nha ạ!',
        };
      }
    }
  }
}

function describeCart(variants) {
  if (!variants || !variants.length) return 'đơn hàng';
  return variants.map(v => `${v.qty} x ${v.name}`).join(', ');
}

module.exports = { SalesAI, LLM_INTENTS, buildFactsBlock, sanitizeLLMText };
