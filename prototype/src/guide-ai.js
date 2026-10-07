'use strict';
// src/guide-ai.js — BACKEND mục "HƯỚNG DẪN" + AI "Hỏi AI" CÓ HỒN (chuẩn aicake).
//
// 2 ROUTE (cài qua installGuideRoutes — server.js gọi 1 lần ở vị trí SAU auth guard +
// agentAllowed; không mở đường không đăng nhập):
//   GET  /api/guide     -> 200 {ok:true, guide} | 503 {ok:false, error:'GUIDE_NOT_READY'}
//   POST /api/guide/ask -> body {q}; trả {ok, answer, steps, articles} (SHAPE KHÔNG ĐỔI — UI
//                          đang render theo đúng 4 field này).
//
// ==================== ASK 3 LỚP (fallback từng lớp — KHÔNG BAO GIỜ 500) ====================
//   LỚP 1 — LLM LIVE: chỉ khi shop có AI provider THẬT (khác 'local'), có api_key, chưa tắt
//           use_for_replies và status ONLINE (đã test PASS — đọc qua ai-provider, không gọi mù).
//           System prompt nhân cách "Suri"; knowledge = steps + summary của bài khớp (KHÔNG bịa).
//           Wire dùng đúng đường production của sales-ai: httpOnceAsync (spawn curl không chặn
//           event loop) + aiBaseUrlCheck (allowlist đích mạng). Timeout ngắn 8s — lỗi/timeout/
//           response xấu -> xuống lớp 2. Ghi chú Phase-2: sales-ai.js KHÔNG export hàm gọi LLM
//           dùng chung (_tryLLM là method private gắn intent/facts) nên guide-ai tự dựng wire
//           MỎNG từ đúng các mảnh ai-provider đã export — cùng luật allowlist, không mở đường mới.
//   LỚP 2 — LOCAL CÓ HỒN (LUÔN sẵn, deterministic): vẫn 100% từ steps của bài khớp nhưng render
//           ấm — mở đầu thân thiện CHỌN ỔN ĐỊNH theo hash(q) (cùng q => cùng answer), steps đánh
//           số, kết mời hỏi lại. Khớp 2 bài điểm gần nhau -> gộp bài chính + mention bài 2.
//   LỚP 3 — KHÔNG KHỚP BÀI: trả lời vui vẻ + liệt kê 7 chủ đề AI giúp được (mời hỏi lại).
//   Bọc ngoài: mọi lỗi không lường của ask -> 200 + answer an toàn (không crash, không 500).
//
// Nội dung tới từ src/guide-content.js (Agent A viết song song): file CHƯA CÓ -> require
// lỗi -> route trả 503; Agent A xong là TỰ SỐNG (lazy require mỗi request, không restart).

// Guard theo hợp đồng: guide-content.js có thể chưa tồn tại lúc module này nạp.
// Lazy-load MỖI request — require thành công lần đầu sẽ cache lại; thất bại (file chưa có)
// KHÔNG bị cache nên lần require sau tự tìm lại (Agent A xong file là API sống).
function loadGuide() {
  try { return require('./guide-content'); } catch (e) { return null; }
}

// AICAKE i18n: guide theo ngôn ngữ UI (vi mặc định). loadGuideLang('ja') -> guide-content-ja.js;
// file chưa có / lang lạ -> fallback bản VI (không lỗi).
const GUIDE_LANGS = new Set(['en', 'zh', 'ko', 'hi', 'ja']);
const guideLangCache = new Map();
function loadGuideLang(lang) {
  const key = GUIDE_LANGS.has(String(lang || '').toLowerCase()) ? String(lang).toLowerCase() : 'vi';
  if (key === 'vi') return loadGuide();
  if (guideLangCache.has(key)) return guideLangCache.get(key);
  let g = null;
  try { g = require('./guide-content-' + key); } catch (e) { g = null; }
  if (!g || !Array.isArray(g.categories)) g = loadGuide();
  guideLangCache.set(key, g);
  return g;
}

// require phòng thủ — module phụ (ai-provider/live-http/sales-ai) hỏng thì LỚP 1 tự tắt,
// lớp 2/3 vẫn sống (không bao giờ 500 vì phụ thuộc).
function safeRequire(name) {
  try { return require(name); } catch (e) { return null; }
}

// ============================ LỚP 1 — LLM LIVE (Suri) ============================

const SYSTEM_PROMPT = [
  'Bạn là Suri — trợ lý hướng dẫn sử dụng Sales AI Console, nữ, vui vẻ thân thiện, giỏi bán hàng.',
  'Trả lời ngắn gọn bằng tiếng Việt, có thể dùng emoji vừa đủ, giọng gần gũi như đồng nghiệp nhiệt tình.',
  'CHỈ dựa trên kiến thức hướng dẫn được cấp (steps + summary). Số liệu/menu KHÔNG có trong kiến thức thì tuyệt đối KHÔNG bịa — hẹn người dùng xem bài liên quan.',
  'Có thể đánh số bước 1. 2. 3.; KHÔNG dùng markdown phức tạp (heading, bảng).',
].join('\n');

// sanitizeLLMText của sales-ai (bỏ fence ``` + cap độ dài) — yêu cầu phòng thủ, hỏng thì dùng bản gọn.
const _salesAi = safeRequire('./sales-ai');
const sanitizeText = _salesAi && typeof _salesAi.sanitizeLLMText === 'function'
  ? _salesAi.sanitizeLLMText
  : (t => String(t || '').trim());

// Knowledge block CHỈ từ dữ liệu bài (không bịa) — tối đa 2 bài khớp cao nhất, cap 4000 ký tự.
function knowledgeBlock(hits) {
  const parts = [];
  for (const h of (hits || [])) {
    const a = (h && h.article) || {};
    const lines = [`BÀI: ${a.title} (mục ${categoryTitleOf(h.category)})`];
    if (a.summary) lines.push(`Tóm tắt: ${a.summary}`);
    const steps = Array.isArray(a.steps) ? a.steps : [];
    steps.forEach((s, i) => lines.push(`${i + 1}. ${s.title}: ${s.body}${s.tip ? ` (tip: ${s.tip})` : ''}`));
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n').slice(0, 4000);
}

// Trả text của Suri | null (mọi trở ngại -> null -> xuống lớp 2; không bao giờ ném ra ngoài).
async function tryLLMAnswer(q, hits, settings) {
  try {
    if (!settings || !hits || !hits.length) return null;
    const ai = safeRequire('./ai-provider');
    if (!ai || typeof ai.getAiConfig !== 'function') return null;
    const cfg = ai.getAiConfig(settings);
    // provider 'local' là stub nội bộ (không phải LLM chat) — Phase-2: chưa gọi được -> lớp 2.
    if (!cfg || cfg.provider === 'local' || !cfg.api_key) return null;
    if (cfg.use_for_replies === false) return null; // shop tắt AI -> trả lời local có hồn
    // Chỉ LIVE khi provider đã test PASS gần nhất (ONLINE) — không gọi mù vào provider lỗi.
    if (typeof ai.aiStatus === 'function' && ai.aiStatus(settings).status !== 'ONLINE') return null;
    const spec = (ai.PROVIDERS && ai.PROVIDERS[cfg.provider]) || null;
    if (!spec || !spec.url) return null;
    // SURI CLOSURE F5: chặn đích mạng ở TẦNG GỌI (cùng luật với sales-ai._tryLLM).
    if (cfg.base_url) {
      const chk = typeof ai.aiBaseUrlCheck === 'function' ? ai.aiBaseUrlCheck(cfg.base_url) : { ok: true };
      if (!chk.ok) return null;
    }
    const liveHttp = safeRequire('./live-http');
    if (!liveHttp || typeof liveHttp.httpOnceAsync !== 'function') return null;
    const url = (cfg.base_url && /^https?:\/\//i.test(String(cfg.base_url))) ? String(cfg.base_url) : spec.url;
    const user = `Câu hỏi của người dùng: "${String(q).trim()}"\n\n`
      + 'KIẾN THỨC HƯỚNG DẪN ĐƯỢC CẤP (CHỈ dựa vào đây):\n'
      + knowledgeBlock(hits.slice(0, 2))
      + '\n\nHãy trả lời ngắn gọn, vui vẻ, đi thẳng vào các bước cho người dùng.';
    const res = await Promise.resolve(liveHttp.httpOnceAsync({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` }, // key đi HEADER
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
        max_tokens: 500,
        temperature: 0.5,
        stream: false,
      }),
      timeoutMs: Math.min(Number(cfg.timeout) || 8000, 8000), // timeout ngắn — lỗi -> xuống lớp 2
    }));
    if (!res || res.timeout || !res.ok || res.status !== 200) return null;
    let j = null;
    try { j = JSON.parse(res.bodyText || '{}'); } catch (e) { return null; }
    const raw = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    const clean = sanitizeText(raw);
    if (!clean || clean.length < 8) return null;
    return clean.slice(0, 2000);
  } catch (e) {
    return null; // mọi lỗi -> lớp 2
  }
}

// ======================= LỚP 2 — LOCAL CÓ HỒN (deterministic) =======================

function categoryTitleOf(cat) {
  if (cat && typeof cat === 'object') return String(cat.title || cat.id || '');
  return String(cat || '');
}

// hash ổn định (không random) — cùng q => cùng opener/closer => cùng answer (test ổn định).
function stableHash(s) {
  const t = String(s || '');
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function pick(list, seed) { return list[stableHash(seed) % list.length]; }

const OPENERS = [
  'Ok anh/chị, em chỉ ngay nha 🌸',
  'Câu này hay đó, làm theo em nè ✨',
  'Được luôn, em hướng dẫn chi tiết cho mình nhé:',
  'Okie, việc này dễ ăn — em chỉ từng bước nha 🌟',
  'Hỏi trúng bài của em rồi, bắt tay vào làm nha 🙌',
];

const CLOSERS = [
  'Cần em chỉ thêm chỗ nào cứ hỏi nha! 💬',
  'Làm xong có vướng gì cứ gọi em nhé! 🌸',
  'Có gì thắc mắc nữa cứ hỏi em, em luôn ở đây nha! 🌟',
  'Chúc mình làm thành công — cần hỗ trợ cứ nhắn em nha! 💬',
];

// Top N bài gợi ý khi không có bài khớp: quét categories theo thứ tự khai báo trong guide.
function suggestionArticles(guide, n) {
  const out = [];
  for (const cat of ((guide && guide.categories) || [])) {
    for (const a of ((cat && cat.articles) || [])) {
      out.push({ id: a.id, title: a.title, category: categoryTitleOf(cat) });
      if (out.length >= n) return out;
    }
  }
  return out;
}

function topArticles(list) {
  return (list || []).slice(0, 3)
    .map(r => ({ id: r.article.id, title: r.article.title, category: categoryTitleOf(r.category) }));
}

// Steps đánh số "1. <title> — <body>" (giữ định dạng quét được; có tip thì thêm "💡 tip").
function stepLines(article) {
  const steps = Array.isArray(article.steps) ? article.steps : [];
  return steps.map((s, i) => `${i + 1}. ${s.title} — ${s.body}${s.tip ? ` 💡 ${s.tip}` : ''}`);
}

// Answer ấm từ dữ liệu bài: mở đầu hash(q) + giới thiệu bài + steps + (mention bài 2 nếu điểm
// gần nhau) + kết mời hỏi lại. 100% từ steps/summary — không bịa.
function buildWarmAnswer(q, hits) {
  const best = hits[0];
  const article = best.article;
  const cat = categoryTitleOf(best.category);
  const lines = [pick(OPENERS, q)];
  lines.push(`Em xem bài "${article.title}" (mục ${cat}) là đúng ý bạn nhất — làm theo từng bước nha:`);
  lines.push(...stepLines(article));
  // Multi-bài: điểm bài 2 >= nửa bài 1 coi là "gần nhau" -> gộp thành mention ngắn.
  const second = hits[1];
  if (second && Number(second.score) * 2 >= Number(best.score)) {
    const a2 = second.article;
    const quick = (Array.isArray(a2.steps) ? a2.steps : []).slice(0, 3).map(s => s.title);
    const quickTxt = quick.length ? ` Bắt đầu nhanh: ${quick.map((t, i) => `${i + 1}) ${t}`).join(' → ')}.` : '';
    lines.push(`Ý bạn cũng có thể là "${a2.title}" — ${a2.summary || ('xem bài này trong mục ' + categoryTitleOf(second.category))}.${quickTxt}`);
  }
  lines.push(`Chi tiết đầy đủ: bài "${article.title}" trong mục ${cat}. ${pick(CLOSERS, q + '::bye')}`);
  return lines.join('\n');
}

// ======================= LỚP 3 — KHÔNG KHỚP BÀI: gợi ý chủ đề =======================

// 7 chủ đề AI giúp được (bao phủ 5 mục/20 bài: sản phẩm, GHN, AI multi-model, bot, comment
// automation, follow-up, báo cáo, thành viên) — tĩnh để không phụ thuộc lúc guide-content đổi.
const HELP_TOPICS = [
  'cách thêm sản phẩm & import CSV',
  'cấu hình GHN: gợi ý đơn, in bill, hủy vận đơn',
  'đăng ký AI multi-model (ChatGPT/Gemini/DeepSeek/Grok/Kimi)',
  'bật bot tự động trả lời khách',
  'comment Facebook tự động & inbox bán hàng',
  'automation follow-up sau giao hàng',
  'đọc báo cáo doanh thu & hội thoại',
];

function buildNoHitAnswer() {
  const lines = ['Híc, em chưa tìm thấy bài nào khớp câu này 😅 Nhưng đừng lo — mấy vụ này em thuộc lòng, bạn cứ hỏi:'];
  for (const t of HELP_TOPICS) lines.push(`• ${t}`);
  lines.push('Muốn biết vụ nào, gõ thẳng tên vụ đó (VD: "cấu hình GHN", "thêm sản phẩm") cho em nha! 🌸');
  return lines.join('\n');
}

// Answer an toàn khi có lỗi không lường (rất hiếm) — ask KHÔNG BAO GIỜ 500.
const SAFE_ANSWER = 'Ui, em bị lag xíu nên chưa xử lý được câu này 😅 Bạn thử hỏi lại giúp em nha — hoặc mở mục Hướng dẫn trên sidebar là có đủ bài đó! 🌸';

// ============================== ROUTE HANDLER ==============================

async function handleGuideRoutes(ctx, app) {
  const { sendJson, readJsonBody, getSessionUser, req, res, p } = ctx;
  // Double-check session (route nằm sau guard của server.js — kiểm lại để tự đứng vững).
  const user = typeof getSessionUser === 'function' ? getSessionUser() : null;
  if (!user) return sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });

  if (p === '/api/guide') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    // AICAKE i18n: ?lang=en|zh|ko|hi|ja — UI chuyển ngôn ngữ thì guide theo ngôn ngữ đó
    const qLang = (() => { try { return new URL(req.url, 'http://x').searchParams.get('lang'); } catch (e) { return null; } })();
    const guide = loadGuideLang(qLang);
    if (!guide) return sendJson(res, 503, { ok: false, error: 'GUIDE_NOT_READY' });
    return sendJson(res, 200, { ok: true, guide });
  }

  // ---- /api/guide/ask ---- (3 lớp, bọc kín — không bao giờ 500)
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
  const qLangBody = (() => { try { return new URL(req.url, 'http://x').searchParams.get('lang'); } catch (e) { return null; } })();
  const guide = loadGuideLang(qLangBody);
  if (!guide) return sendJson(res, 503, { ok: false, error: 'GUIDE_NOT_READY' });
  try {
    let q = '';
    try {
      const body = await readJsonBody(req);
      q = String((body && body.q) || '').trim();
    } catch (e) { q = ''; }
    if (!q) return sendJson(res, 400, { ok: false, error: 'EMPTY_Q' });

    // Chấm điểm qua guide.searchArticles (chuẩn hóa bỏ dấu, sắp điểm giảm — Agent A export).
    let hits = [];
    try {
      if (typeof guide.searchArticles === 'function') {
        hits = (guide.searchArticles(q) || []).filter(r => r && r.article && Number(r.score) > 0);
      }
    } catch (e) { hits = []; }

    // LỚP 1 — LLM LIVE (provider ONLINE của shop); lỗi/hỏng -> lớp 2.
    let answer = null;
    try {
      answer = await tryLLMAnswer(q, hits, app && app.settings);
    } catch (e) { answer = null; }

    // LỚP 2/3 — local có hồn (deterministic).
    if (!answer) answer = hits.length ? buildWarmAnswer(q, hits) : buildNoHitAnswer();

    return sendJson(res, 200, {
      ok: true,
      answer,
      steps: hits.length && Array.isArray(hits[0].article.steps) ? hits[0].article.steps : [],
      articles: hits.length ? topArticles(hits) : suggestionArticles(guide, 3),
    });
  } catch (err) {
    // Lưới cuối của ask: trả 200 + answer an toàn — KHÔNG 500.
    console.error('[guide-ai] ask error', err && (err.stack || err.message || err));
    try { return sendJson(res, 200, { ok: true, answer: SAFE_ANSWER, steps: [], articles: [] }); } catch (e) { /* đã gửi */ }
    return undefined;
  }
}

// installGuideRoutes(app, ctx) — server.js gọi 1 lần (sau /api/analytics, sau auth guard +
// agentAllowed). Trả true nếu request thuộc route guide (đã trả response), false để server
// chạy tiếp chuỗi route thường. `app` là App của shop session — LỚP 1 đọc app.settings (ShopSettings)
// để biết provider AI của shop; nội dung guide là tài liệu sản phẩm dùng chung nên không scope.
async function installGuideRoutes(app, ctx) {
  const { p } = ctx || {};
  if (p !== '/api/guide' && p !== '/api/guide/ask') return false;
  try {
    await handleGuideRoutes(ctx, app);
  } catch (err) {
    console.error('[guide-ai]', err && (err.stack || err.message || err));
    try { ctx.sendJson(ctx.res, 500, { ok: false, error: 'GUIDE_INTERNAL_ERROR' }); } catch (e) { /* đã gửi */ }
  }
  return true;
}

module.exports = { installGuideRoutes };
