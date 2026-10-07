'use strict';
// guide-ai.js — test route HƯỚNG DẪN + AI hỏi-đáp (/api/guide + /api/guide/ask).
// Boot factory createServer port 0 + TEMP (pattern test/matrix/_harness.js) — KHÔNG đụng
// server 8080, không đụng data/ của project.
//
// src/guide-content.js do Agent A viết SONG SONG — có thể CHƯA tồn tại lúc chạy test:
// stub tạm qua require.cache (+ module._pathCache seed đường resolve khi file chưa có)
// TRONG TEST, KHÔNG ghi file vào src/ — test không phụ thuộc thứ tự agent.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');
const { createServer } = require('../server.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

// ------------------------------------------------ guide-content STUB (không ghi src/)
const SRC_DIR = path.join(__dirname, '..', 'src');
const GUIDE_FILE = path.join(SRC_DIR, 'guide-content.js');
const PATH_CACHE_KEY = './guide-content\x00' + SRC_DIR;

function guideContentStub() {
  const norm = s => String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd');
  return {
    version: 'test-stub',
    product: 'Sales AI Console',
    categories: [
      {
        id: 'bat-dau', title: 'Bắt đầu',
        articles: [{
          id: 'dang-nhap', title: 'Đăng nhập tài khoản', minutes: 2, summary: 'Cách vào console.',
          steps: [
            { title: 'Mở trang đăng nhập', body: 'Vào địa chỉ console và chọn Đăng nhập.' },
            { title: 'Nhập email và mật khẩu', body: 'Dùng email đã tạo ở bước setup OWNER.', tip: 'Mật khẩu tối thiểu 8 ký tự.' },
          ],
          seeAlso: [],
        }],
      },
      {
        id: 'don-hang', title: 'Đơn hàng',
        articles: [{
          id: 'xac-nhan-don', title: 'Xác nhận đơn hàng', minutes: 3, summary: 'Chốt đơn DRAFT.',
          steps: [{ title: 'Mở tab Đơn hàng', body: 'Chọn đơn trạng thái DRAFT rồi bấm Xác nhận.' }],
        }],
      },
      {
        id: 'van-chuyen', title: 'Vận chuyển GHN',
        articles: [{
          id: 'huy-don-ghn', title: 'Hủy đơn qua GHN', minutes: 2, summary: 'Hủy đơn đã có vận đơn.',
          steps: [{ title: 'Mở chi tiết đơn', body: 'Bấm Hủy đơn — hệ thống gọi GHN hủy vận đơn.' }],
        }],
      },
    ],
    searchArticles(q) {
      const nq = norm(q);
      const out = [];
      for (const cat of this.categories) {
        for (const a of cat.articles) {
          const hay = norm(`${cat.title} ${a.title} ${a.summary || ''}`);
          let score = 0;
          for (const w of nq.split(/\s+/).filter(Boolean)) if (hay.includes(w)) score += 1;
          if (score > 0) out.push({ category: cat, article: a, score });
        }
      }
      return out.sort((a, b) => b.score - a.score);
    },
  };
}

function installGuideContentStub() {
  let fileExists = false;
  try { fs.accessSync(GUIDE_FILE); fileExists = true; } catch (e) { /* chưa có */ }
  const prevModule = require.cache[GUIDE_FILE];
  const prevPathEntry = Module._pathCache[PATH_CACHE_KEY];
  // File CHƯA có: seed _pathCache để require('./guide-content') từ src/guide-ai.js resolve
  // ra GUIDE_FILE (Node resolve trước rồi mới tra require.cache). File CÓ: resolve tự tìm thấy.
  if (!fileExists) Module._pathCache[PATH_CACHE_KEY] = GUIDE_FILE;
  require.cache[GUIDE_FILE] = {
    id: GUIDE_FILE, filename: GUIDE_FILE, loaded: true, path: SRC_DIR,
    exports: guideContentStub(), children: [], require: null,
  };
  return function restore() {
    if (prevModule) require.cache[GUIDE_FILE] = prevModule; else delete require.cache[GUIDE_FILE];
    if (prevPathEntry) Module._pathCache[PATH_CACHE_KEY] = prevPathEntry;
    else delete Module._pathCache[PATH_CACHE_KEY];
  };
}

(async () => {
  const restoreStub = installGuideContentStub();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-ai-'));
  const inst = createServer({
    port: 0,
    authDir: path.join(tmp, 'auth'),
    shopsRoot: path.join(tmp, 'shops'),
    uiDemo: '0',
    appDataMode: 'persist',
  });
  inst.listen();
  for (let i = 0; i < 60 && !inst.server.listening; i++) await new Promise(r => setTimeout(r, 20));
  const base = 'http://127.0.0.1:' + inst.server.address().port;

  const j = (method, p, body, token) => new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    if (token) headers.Cookie = 'sid=' + token;
    const req = http.request(base + p, { method, headers }, res => {
      let out = '';
      res.on('data', c => { out += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(out); } catch (e) { json = null; }
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });

  try {
    // ---- CASE 1: chưa login -> 401 (route nằm sau auth guard, không mở đường ẩn danh)
    const anon = await j('GET', '/api/guide');
    ok(anon.status === 401, 'chưa login GET /api/guide -> 401');
    const anonAsk = await j('POST', '/api/guide/ask', { q: 'đăng nhập' });
    ok(anonAsk.status === 401, 'chưa login POST /api/guide/ask -> 401');

    // ---- setup OWNER
    const setup = await j('POST', '/api/auth/setup',
      { email: 'owner-guide@test.vn', password: 'password123', shop_name: 'Guide Shop' });
    ok(setup.status === 200, 'setup OWNER 200');
    const sid = setup.headers['set-cookie'][0].match(/sid=([^;]+)/)[1];

    // ---- CASE 2: login xong GET /api/guide -> 200 + guide (stub qua require.cache đã ăn)
    const g = await j('GET', '/api/guide', undefined, sid);
    ok(g.status === 200 && g.json && g.json.ok === true, 'GET /api/guide -> 200 ok:true');
    ok(!!(g.json && g.json.guide && Array.isArray(g.json.guide.categories) && g.json.guide.categories.length === 3),
      'guide trả categories (stub guide-content ăn qua require.cache)');

    // ---- CASE 3: ask có bài khớp -> answer CÓ HỒN (mở đầu thân thiện + steps + kết mời hỏi)
    const ask = await j('POST', '/api/guide/ask', { q: 'làm sao đăng nhập' }, sid);
    ok(ask.status === 200 && ask.json && ask.json.ok === true, 'ask "đăng nhập" -> 200 ok:true');
    const a = (ask.json && ask.json.answer) || '';
    ok(a.length > 0, 'answer không rỗng');
    ok(a.includes('Đăng nhập tài khoản'), 'answer nhắc title bài khớp');
    ok(a.includes('1. Mở trang đăng nhập — Vào địa chỉ console'), 'answer liệt kê steps "1. <title> — <body>"');
    ok(a.includes('💡 Mật khẩu tối thiểu 8 ký tự'), 'answer thêm 💡 tip của step');
    ok(a.includes('trong mục Bắt đầu'), 'answer kết chỉ về bài + mục');
    // (a) dấu hiệu thân thiện: không khớp chuỗi cứng — chỉ cần mở đầu + steps + kết
    const aLines = a.split('\n').map(s => s.trim()).filter(Boolean);
    ok(aLines.length >= 4, 'answer có cấu trúc mở đầu + steps + kết (>=4 dòng)');
    ok(/nha|nhé|nè|nhỉ/i.test(aLines[0]) && aLines[0].length > 10, 'dòng mở đầu thân thiện (không khô kiểu máy)');
    ok(/^\d+\.\s/.test(aLines[2]), 'khối steps đánh số xuất hiện trong answer');
    ok(/cứ hỏi|gọi em|nhắn em/i.test(aLines[aLines.length - 1]), 'dòng kết mời hỏi lại');
    ok(Array.isArray(ask.json.steps) && ask.json.steps.length === 2, 'steps trả đủ của bài khớp');
    ok(Array.isArray(ask.json.articles) && ask.json.articles.length > 0
      && ask.json.articles[0].id === 'dang-nhap' && ask.json.articles[0].category === 'Bắt đầu',
      'articles top 3 [{id,title,category}] không rỗng, bài khớp đứng đầu');
    ok(ask.json.articles.length <= 3, 'articles tối đa 3 bài');

    // (b) ổn định hash: 2 lần cùng q -> CÙNG answer (không random opener/closer)
    const ask2 = await j('POST', '/api/guide/ask', { q: 'làm sao đăng nhập' }, sid);
    ok(ask2.status === 200 && ask2.json && ask2.json.answer === ask.json.answer,
      '2 lần cùng q -> cùng answer (ổn định hash, không random)');

    // (multi) 2 bài khớp điểm gần nhau -> gộp bài chính + mention bài 2
    const multi = await j('POST', '/api/guide/ask', { q: 'đăng nhập hủy đơn ghn' }, sid);
    ok(multi.status === 200 && multi.json && multi.json.ok === true, 'ask khớp 2 bài -> 200 ok');
    const mAns = String((multi.json && multi.json.answer) || '');
    ok(mAns.includes('Hủy đơn qua GHN') && mAns.includes('Đăng nhập tài khoản'),
      'multi-bài: answer gộp bài chính + mention bài 2');
    ok(Array.isArray(multi.json.articles) && multi.json.articles.length === 3
      && multi.json.articles[0].id === 'huy-don-ghn' && multi.json.articles[1].id === 'dang-nhap',
      'articles top 3 đúng thứ tự điểm (bài chính + bài mention + bài 3)');

    // ---- CASE 4: ask rác không khớp bài nào -> fallback VUI VẺ liệt kê >=5 chủ đề giúp được
    const miss = await j('POST', '/api/guide/ask', { q: 'blabla123' }, sid);
    ok(miss.status === 200 && miss.json && miss.json.ok === true, 'ask rác "blabla123" -> 200 ok (không crash)');
    const mAns2 = String((miss.json && miss.json.answer) || '');
    const bullets = mAns2.split('\n').filter(l => l.trim().startsWith('•')).length;
    ok(bullets >= 5, `fallback liệt kê >=5 chủ đề giúp được (thấy ${bullets})`);
    ok(/GHN|sản phẩm|báo cáo/i.test(mAns2), 'fallback nhắc chủ đề cụ thể (GHN/sản phẩm/báo cáo)');
    ok(mAns2.length > 100, 'fallback dài hơn 1 câu cục — có hồn mời hỏi lại');
    ok(miss.json.steps.length === 0, 'steps rỗng khi không khớp');
    ok(Array.isArray(miss.json.articles) && miss.json.articles.length === 3, 'articles = top 3 bài gợi ý xem trước');

    // ---- CASE 5: q trống -> 400 EMPTY_Q
    const empty1 = await j('POST', '/api/guide/ask', { q: '   ' }, sid);
    ok(empty1.status === 400 && empty1.json && empty1.json.error === 'EMPTY_Q', 'q toàn khoảng trắng -> 400 EMPTY_Q');
    const empty2 = await j('POST', '/api/guide/ask', {}, sid);
    ok(empty2.status === 400 && empty2.json && empty2.json.error === 'EMPTY_Q', 'q thiếu -> 400 EMPTY_Q');

    // ---- CASE 6: AGENT (tạo qua /api/auth/users) được ĐỌC /api/guide -> 200
    const mk = await j('POST', '/api/auth/users',
      { email: 'agent-guide@test.vn', password: 'password123', role: 'AGENT' }, sid);
    ok(mk.status === 200, 'OWNER tạo user role AGENT 200');
    const login = await j('POST', '/api/auth/login', { email: 'agent-guide@test.vn', password: 'password123' });
    ok(login.status === 200, 'AGENT login 200');
    const agentSid = login.headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
    const gAgent = await j('GET', '/api/guide', undefined, agentSid);
    ok(gAgent.status === 200 && gAgent.json && gAgent.json.ok === true, 'AGENT GET /api/guide -> 200 (đọc, qua agentAllowed)');
    // AGENT nằm trong whitelist POST của agentAllowed (chỉ đọc guide) -> hỏi được, y như aicake cho mọi user chat
    const askAgent = await j('POST', '/api/guide/ask', { q: 'đăng nhập' }, agentSid);
    ok(askAgent.status === 200 && askAgent.json && askAgent.json.ok === true
      && Array.isArray(askAgent.json.articles) && askAgent.json.articles.length > 0,
      'AGENT POST /api/guide/ask -> 200 (nhân viên được hỏi AI hướng dẫn)');

    // ---- CASE 7: method sai -> 405 (route guide vẫn khép kín)
    const wrong1 = await j('POST', '/api/guide', {}, sid);
    ok(wrong1.status === 405, 'POST /api/guide -> 405');
    const wrong2 = await j('GET', '/api/guide/ask', undefined, sid);
    ok(wrong2.status === 405, 'GET /api/guide/ask -> 405');

    // ---- CASE 8: route guide KHÔNG phá route thường (analytics vẫn chạy sau call site)
    const an = await j('GET', '/api/analytics', undefined, sid);
    ok(an.status === 200 && an.json && an.json.ok !== false, '/api/analytics vẫn 200 sau khi cài guide routes');
  } finally {
    restoreStub();
    inst.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`guide-ai: ${pass}/${pass + fail} PASS`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
