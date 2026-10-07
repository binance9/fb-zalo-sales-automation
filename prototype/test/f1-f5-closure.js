'use strict';
// test/f1-f5-closure.js — SURI CLOSURE GATE: ĐÓNG 5 FINDING JEV-SURI-ASYNC-AUDIT (mức LOW).
//
//   F1 (facts-stale lúc LLM chờ)      : mock LLM CHẬM (hold) -> đổi facts giữa chờ qua
//                                       productDB -> reply PHẢI mang giá MỚI từ DB, KHÔNG giá cũ.
//                                       (Suite đầy đủ: test/f1-facts-stale.js — 4 case.)
//   F2 (routeRepurchase khi propose   : 3 ca — resolve (phản hồi đủ + metadata), reject (fallback
//       trả Promise)                   an toàn không crash), timeout (không treo vô hạn, khách
//                                       nhận câu an toàn, 0 đơn trùng). Kèm ca SYNC regression.
//   F5 (ai_base_url)                  : quyền AGENT 403 ở POST /api/ai/config + /api/ai/wire-deepseek
//                                       (HTTP thật); allowlist đích mạng ở SAVE (cấu hình bẩn
//                                       không lưu được) VÀ ở CALL (deep defense — 0 byte ra mạng).
//   F3/F4 (docs SURI-ASYNC.md)        : §7 14/14 (đính chính), §8.5 deepseek-wire LIVE ping ĐÃ
//                                       PASS trong suri-p2, riêng đường reply LIVE CHƯA XÁC MINH.
//
// Chạy: node test/f1-f5-closure.js — exit 0 khi toàn bộ PASS. Offline trừ phần HTTP nội bộ
// (127.0.0.1) — không đụng DeepSeek/mạng ngoài.

const path = require('path');
const fs = require('fs');
const http = require('http');
const assert = require('assert');
const { App } = require('../src/app');
const aiProvider = require('../src/ai-provider');
const { ShopSettings } = require('../src/shop-settings');
const { createServer } = require('../server');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data', 'test-runs');

const RESULTS = [];
async function T(id, desc, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    RESULTS.push({ id, ok: true });
    console.log(`  [PASS] ${id} — ${desc} (${Date.now() - t0}ms)${note ? ' :: ' + note : ''}`);
  } catch (e) {
    RESULTS.push({ id, ok: false, err: String(e && e.message) });
    console.log(`  [FAIL] ${id} — ${desc}\n         -> ${String(e && e.message).split('\n').slice(0, 3).join(' | ')}`);
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// đếm unhandled rejection toàn tiến trình — F2/F1 không được sinh ra
let UNHANDLED = 0;
process.on('unhandledRejection', e => {
  UNHANDLED += 1;
  console.error('  [unhandledRejection]', String((e && e.message) || e));
});

let seq = 0;
function fireDrain(app, ref, text) {
  seq += 1;
  app.receive({
    channel: 'facebook', type: 'message',
    platformEventId: `f15-${ref}-${seq}`,
    payload: { customer_ref: ref, thread_id: ref, kind: 'text', text, platform_message_id: `f15pm-${seq}` },
  });
  app.drain();
}
const convOf = (app, ref) => app.store.findOne('conversations', c => c.platform_thread_id === ref);
const outMsgs = (app, ref) => {
  const c = convOf(app, ref);
  return c ? app.store.findAll('messages', m => m.conversation_id === c.conversation_id && m.direction === 'out') : [];
};
const ordersOf = (app, ref) => {
  const c = convOf(app, ref);
  return c ? app.store.findAll('orders', o => o.conversation_id === c.conversation_id) : [];
};
function newApp(name, opts = {}) {
  const dir = path.join(DATA, name);
  fs.rmSync(dir, { recursive: true, force: true });
  return new App({ dataDir: dir, ...opts });
}

// ==================================================================== F1
const sleep_then = (hold, answerText) => async () => {
  await hold.promise;
  return { ok: true, status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: answerText } }] }) };
};

async function caseF1() {
  await T('F1-1', 'mock LLM chậm + đổi GIÁ giữa chờ qua productDB -> reply mang giá MỚI, không giá cũ', async () => {
    const hold = {};
    let release;
    hold.promise = new Promise(r => { release = r; });
    const app = newApp('f15-f1-price', { aiAsyncHttpFn: sleep_then(hold, 'Dạ nến thơm vanilla size S giá 165000đ nha anh/chị ạ!') });
    aiProvider.saveAiConfig(app.settings, { provider: 'deepseek', api_key: 'sk-f15-0001' });
    fireDrain(app, 'f1', 'nến vanilla giá bao nhiêu vậy shop');
    await sleep(50); // LLM đang chờ
    app.productDB.getVariant('NT-VANILLA-S').variant.price = 199000; // đổi giá giữa chờ
    release();
    const t0 = Date.now();
    while (!outMsgs(app, 'f1').length && Date.now() - t0 < 5000) await sleep(15);
    const text = outMsgs(app, 'f1').pop().text_content || '';
    assert.ok(/199000/.test(text), 'phải chứa giá MỚI 199000: ' + text);
    assert.ok(!/165000/.test(text), 'KHÔNG được chứa giá CŨ 165000: ' + text);
    return 'reply: ' + text.replace(/\n/g, ' | ').slice(0, 80);
  });

  await T('F1-2', 'mock LLM chậm + subject DISABLED giữa chờ -> không tư vấn SP đó (0 giá, NEEDS_HUMAN)', async () => {
    const hold = {};
    let release;
    hold.promise = new Promise(r => { release = r; });
    const app = newApp('f15-f1-disabled', { aiAsyncHttpFn: sleep_then(hold, 'Dạ nến thơm vanilla giá 165000đ còn hàng nha anh/chị ạ!') });
    aiProvider.saveAiConfig(app.settings, { provider: 'deepseek', api_key: 'sk-f15-0001' });
    fireDrain(app, 'f1d', 'nến vanilla giá bao nhiêu vậy shop');
    await sleep(50);
    app.productDB.getProduct('prd_nt_vanilla').enabled = false; // tắt SP giữa chờ
    release();
    const t0 = Date.now();
    while (!outMsgs(app, 'f1d').length && Date.now() - t0 < 5000) await sleep(15);
    const text = outMsgs(app, 'f1d').pop().text_content || '';
    assert.ok(!/vanilla/i.test(text) && !/165000/.test(text), 'KHÔNG tư vấn SP tắt / giá cũ: ' + text);
    assert.ok(text.length > 10, 'khách vẫn nhận tin an toàn');
    return 'reply an toàn: ' + text.slice(0, 60);
  });
}

// ==================================================================== F2
// Mô phỏng BẪY JEV LOW-2: BUY_ASK (hiện stub-sync) TRẢ PROMISE — routeRepurchase phải xử lý
// đúng cả 3 ca resolve/reject/timeout mà không mất phản hồi / trùng / treo / crash.
function patchBuyAskPropose(app, mode) {
  const ai = app.pipeline.ai;
  const orig = ai.propose.bind(ai);
  ai.propose = (intent, ctx) => {
    if (intent === 'BUY_ASK') {
      if (mode === 'resolve') return Promise.resolve(orig(intent, ctx));
      if (mode === 'reject') return Promise.reject(new Error('simulated_async_buyask_failure'));
      return new Promise(() => { /* treo vĩnh viễn — timeout case */ });
    }
    return orig(intent, ctx);
  };
  return ai;
}
// Bọc routeRepurchase để đọc KẾT QUẢ TRẢ VỀ (sync object hoặc promise) cho assert.
function captureRouteRepurchase(app) {
  const orig = app.pipeline.routeRepurchase.bind(app.pipeline);
  const box = {};
  app.pipeline.routeRepurchase = function (...a) {
    const r = orig(...a);
    box.result = r;
    return r;
  };
  return box;
}
// Khách cũ CÓ lịch sử đơn + THIẾU slot (phone xoá) -> repurchase rơi đúng nhánh BUY_ASK-propose.
async function setupRepurchaseWithHistory(name) {
  const app = newApp(name);
  fireDrain(app, 'f2', 'lấy 1 hộp trà hoa sấy, tên Mai, sdt 0902222333, địa chỉ 7 Hai Bà Trưng Q1');
  const orders = ordersOf(app, 'f2');
  assert.strictEqual(orders.length, 1, 'đơn lịch sử đã có (DRAFT)');
  const conv = convOf(app, 'f2');
  conv.draft.slots.phone = { value: null, state: 'empty' }; // ép thiếu trường -> BUY_ASK propose
  return { app, order: orders[0], conv };
}
const outsCount = (app, ref) => outMsgs(app, ref).length;

async function caseF2() {
  await T('F2-0', 'SYNC regression: BUY_ASK stub (nguyên trạng) -> routeRepurchase trả sync object + .repurchase meta', async () => {
    const { app, order } = await setupRepurchaseWithHistory('f15-f2-sync');
    const box = captureRouteRepurchase(app);
    fireDrain(app, 'f2', 'lấy thêm cái hôm trước nha shop');
    assert.ok(box.result, 'routeRepurchase đã chạy');
    assert.ok(!(box.result && typeof box.result.then === 'function'), 'sync path KHÔNG trả promise (nguyên trạng)');
    assert.strictEqual(box.result.repurchase.from_order_id, order.order_id, '.repurchase meta gắn đúng');
    assert.ok(outMsgs(app, 'f2').length >= 2, 'khách nhận BUY_ASK hỏi trường thiếu');
    assert.strictEqual(ordersOf(app, 'f2').length, 1, '0 đơn mới khi còn thiếu trường');
    return 'sync + meta OK';
  });

  await T('F2-1', 'propose trả Promise RESOLVE -> phản hồi ĐỦ + metadata gắn lên kết quả (không rơi)', async () => {
    const { app, order } = await setupRepurchaseWithHistory('f15-f2-resolve');
    patchBuyAskPropose(app, 'resolve');
    const box = captureRouteRepurchase(app);
    fireDrain(app, 'f2', 'lấy thêm cái hôm trước nha shop');
    assert.ok(box.result && typeof box.result.then === 'function', 'route trả promise (mô phỏng BUY_ASK async)');
    const res = await box.result;
    assert.strictEqual(res.repurchase.from_order_id, order.order_id, 'metadata gắn lên KẾT QUẢ sau settle (trước đây rơi)');
    assert.ok(res.repurchase.items.length >= 1, 'items cũ đi kèm');
    assert.ok(res.replies.length >= 1 && res.replies[0].sent, 'khách nhận phản hồi đầy đủ');
    assert.ok(!res.fallback, 'không rơi fallback khi thành công');
    assert.strictEqual(ordersOf(app, 'f2').length, 1, 'không tạo đơn trùng (vẫn 1 đơn — còn thiếu trường)');
    assert.strictEqual(UNHANDLED, 0, '0 unhandled rejection');
    return 'resolve: meta + 1 reply, 0 đơn trùng';
  });

  await T('F2-2', 'propose Promise REJECT -> fallback câu an toàn, KHÔNG crash, 0 đơn trùng', async () => {
    const { app } = await setupRepurchaseWithHistory('f15-f2-reject');
    patchBuyAskPropose(app, 'reject');
    const box = captureRouteRepurchase(app);
    const outsBefore = outsCount(app, 'f2');
    fireDrain(app, 'f2', 'lấy thêm cái hôm trước nha shop');
    const res = await box.result;
    assert.ok(String(res.fallback || '').startsWith('error:'), 'ghi rõ lý do fallback: ' + res.fallback);
    assert.ok(res.replies.length === 1 && res.replies[0].sent, 'khách nhận đúng 1 câu an toàn');
    const text = outMsgs(app, 'f2').pop().text_content || '';
    assert.ok(/ghi nhận yêu cầu mua lại/.test(text), 'nội dung câu an toàn: ' + text);
    assert.strictEqual(outsCount(app, 'f2'), outsBefore + 1, 'đúng +1 tin (không gửi trùng)');
    assert.strictEqual(ordersOf(app, 'f2').length, 1, '0 đơn trùng');
    assert.strictEqual(UNHANDLED, 0, '0 unhandled rejection (trước đây promise reject không handler riêng)');
    return 'reject -> fallback an toàn';
  });

  await T('F2-3', 'propose Promise TREO (httpFn hang) -> fallback theo hạn chờ, không treo vô hạn', async () => {
    const { app } = await setupRepurchaseWithHistory('f15-f2-timeout');
    patchBuyAskPropose(app, 'hang');
    app.pipeline.repurchaseAwaitMs = 200; // hạn chờ CÓ HẠN (production default 15000)
    const box = captureRouteRepurchase(app);
    const outsBefore = outsCount(app, 'f2');
    fireDrain(app, 'f2', 'lấy thêm cái hôm trước nha shop');
    const t0 = Date.now();
    const res = await box.result;
    const waited = Date.now() - t0;
    assert.ok(waited < 3000, 'route resolve CÓ HẠN (không treo vô hạn): ' + waited + 'ms');
    assert.strictEqual(res.fallback, 'await_timeout', 'fallback do vượt hạn chờ');
    assert.ok(res.replies.length === 1 && res.replies[0].sent, 'khách nhận câu an toàn');
    assert.strictEqual(outsCount(app, 'f2'), outsBefore + 1, 'đúng +1 tin');
    assert.strictEqual(ordersOf(app, 'f2').length, 1, '0 đơn trùng');
    // event loop còn sống: tin mới của khách KHÁC vẫn phục vụ ngay
    fireDrain(app, 'f2-new', 'chào shop ạ');
    assert.strictEqual(outMsgs(app, 'f2-new').length, 1, 'tin mới vẫn được phục vụ bình thường');
    assert.strictEqual(UNHANDLED, 0, '0 unhandled rejection');
    return `fallback sau ${waited}ms, loop sống`;
  });
}

// ==================================================================== F5
async function caseF5() {
  await T('F5-1', 'allowlist SAVE: 127.0.0.1 + api.deepseek.com OK; 169.254.169.254/10.x/192.168.x/file:///host lạ BỊ CHẶN', async () => {
    const dir = path.join(DATA, 'f15-f5-save');
    fs.rmSync(dir, { recursive: true, force: true });
    const ss = new ShopSettings(dir);
    // CHO PHÉP
    let v = aiProvider.saveAiConfig(ss, { provider: 'deepseek', api_key: 'sk-f5-save-0001', base_url: 'http://127.0.0.1:8899/v1' });
    assert.strictEqual(v.base_url, 'http://127.0.0.1:8899/v1', 'loopback http OK');
    v = aiProvider.saveAiConfig(ss, { provider: 'deepseek', base_url: 'https://api.deepseek.com/v1' });
    assert.strictEqual(v.base_url, 'https://api.deepseek.com/v1', 'provider chuẩn https OK');
    v = aiProvider.saveAiConfig(ss, { provider: 'deepseek', base_url: 'http://localhost:9000' });
    assert.strictEqual(v.base_url, 'http://localhost:9000', 'localhost OK');
    v = aiProvider.saveAiConfig(ss, { provider: 'deepseek', base_url: '' });
    assert.strictEqual(v.base_url, null, 'rỗng -> xoá (URL mặc định provider)');
    // CHẶN — cấu hình bẩn KHÔNG lưu được (giá trị hợp lệ trước đó phải còn nguyên)
    const good = ss.get('ai_base_url');
    for (const bad of [
      'http://169.254.169.254/latest/meta-data',
      'https://169.254.169.254/v1',
      'https://10.1.2.3/v1',
      'https://192.168.1.9:8443/v1',
      'https://172.16.0.9/v1',
      'file:///etc/passwd',
      'ftp://example.com/x',
      'https://evil.example.com/v1',
      'http://metadata.google.internal/v1',
      'https://user:pass@api.deepseek.com/v1',
      'https://0.0.0.0/v1',
    ]) {
      assert.throws(() => aiProvider.saveAiConfig(ss, { provider: 'deepseek', base_url: bad }), /BAD_BASE_URL/, 'phải chặn: ' + bad);
    }
    assert.strictEqual(ss.get('ai_base_url'), good, 'config hợp lệ KHÔNG bị ghi đè bởi lần save bẩn');
    return 'allow 3 / block 11, config sạch giữ nguyên';
  });

  await T('F5-2', 'allowlist CALL (deep defense): base_url bẩn sửa tay DB -> propose fallback stub, 0 byte ra mạng', async () => {
    const spyCalls = [];
    const app = newApp('f15-f5-call', { aiAsyncHttpFn: async req => { spyCalls.push(req); return { ok: true, status: 200, bodyText: '{"choices":[{"message":{"content":"LEAK"}}]}' }; } });
    aiProvider.saveAiConfig(app.settings, { provider: 'deepseek', api_key: 'sk-f5-call-0001', base_url: 'http://127.0.0.1:8899/v1' });
    app.settings.set('ai_base_url', 'http://169.254.169.254/v1'); // DB BẨN — bypass saveAiConfig
    fireDrain(app, 'f5', 'nến vanilla giá bao nhiêu vậy shop');
    const text = outMsgs(app, 'f5').pop().text_content || '';
    assert.ok(!/LEAK/.test(text), 'KHÔNG có byte nào ra mạng tới host cấm: ' + text);
    assert.ok(/165000/.test(text), 'khách vẫn nhận fallback FAQ stub đọc FACTS: ' + text.slice(0, 60));
    assert.strictEqual(app.ai.stats.llm_fallback, 1, 'ghi nhận fallback');
    assert.ok(/ai_base_url_blocked/.test(String(app.ai.stats.last_fallback_reason || '')), 'reason rõ ràng: ' + app.ai.stats.last_fallback_reason);
    assert.strictEqual(spyCalls.length, 0, 'httpFn KHÔNG được gọi lần nào');
    return 'call-time chặn, fallback stub, spy=0';
  });

  await T('F5-3', 'testAiProvider cũng chặn ở CALL: base_url bẩn -> ERROR có lý do; loopback -> vẫn test bình thường', async () => {
    const dir = path.join(DATA, 'f15-f5-testep');
    fs.rmSync(dir, { recursive: true, force: true });
    const ss = new ShopSettings(dir);
    const spyCalls = [];
    const httpFn = async req => { spyCalls.push(req); return { ok: true, status: 200, bodyText: '{"id":"x","object":"chat.completion"}' }; };
    aiProvider.saveAiConfig(ss, { provider: 'deepseek', api_key: 'sk-f5-tp-0001' });
    ss.set('ai_base_url', 'https://192.168.5.5/v1'); // DB bẩn
    let r = await aiProvider.testAiProvider(ss, { httpFn });
    assert.strictEqual(r.ok, false, 'bị chặn ở tầng gọi');
    assert.ok(/^base_url_blocked:/.test(String(r.error)), 'lý do: ' + r.error);
    assert.strictEqual(spyCalls.length, 0, '0 call ra mạng');
    ss.set('ai_base_url', 'http://127.0.0.1:8899/v1'); // loopback hợp lệ
    r = await aiProvider.testAiProvider(ss, { httpFn });
    assert.strictEqual(r.ok, true, 'loopback vẫn test bình thường (mock local được phép)');
    assert.strictEqual(spyCalls.length, 1, 'đúng 1 call');
    return 'blocked + loopback OK';
  });

  await T('F5-4', 'QUYỀN (HTTP thật): AGENT POST /api/ai/config + /api/ai/wire-deepseek -> 403; OWNER -> 200/400 đúng luật', async () => {
    const root = path.join(DATA, 'f15-f5-http');
    fs.rmSync(root, { recursive: true, force: true });
    const inst = createServer({ port: 0, authDir: path.join(root, 'auth'), shopsRoot: path.join(root, 'shops'), uiDemo: '0', appDataMode: 'persist' });
    inst.listen();
    for (let i = 0; i < 60 && !inst.server.listening; i++) await sleep(20);
    const call = (method, p, body, cookie) => new Promise((resolve, reject) => {
      const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
      const headers = {};
      if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
      if (cookie) headers.Cookie = `sid=${cookie}`;
      const rq = http.request({ hostname: '127.0.0.1', port: inst.server.address().port, path: p, method, headers }, res => {
        let out = ''; res.on('data', c => { out += c; });
        res.on('end', () => resolve({
          status: res.statusCode, headers: res.headers,
          json: (() => { try { return JSON.parse(out); } catch (e) { return null; } })(),
        }));
      });
      rq.on('error', reject); if (data) rq.write(data); rq.end();
    });
    try {
      const setup = await call('POST', '/api/auth/setup', { email: 'f5owner@test.dev', password: 'password123', shop_name: 'F5 Shop' });
      assert.strictEqual(setup.status, 200, 'setup owner');
      const ownerSid = setup.headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
      const mkAgent = await call('POST', '/api/auth/users', { email: 'f5agent@test.dev', password: 'password123', role: 'AGENT' }, ownerSid);
      assert.strictEqual(mkAgent.status, 200, 'tạo user AGENT');
      const agentLogin = await call('POST', '/api/auth/login', { email: 'f5agent@test.dev', password: 'password123' });
      assert.strictEqual(agentLogin.status, 200, 'login AGENT');
      const agentSid = agentLogin.headers['set-cookie'][0].match(/sid=([^;]+)/)[1];

      // AGENT: 2 endpoint cấu hình AI PHẢI 403 (role gate tại agentAllowed — kiểm hiện trạng)
      let r = await call('POST', '/api/ai/config', { provider: 'deepseek', api_key: 'sk-agent-0001' }, agentSid);
      assert.strictEqual(r.status, 403, 'AGENT POST /api/ai/config -> 403 (thấy ' + r.status + ')');
      assert.strictEqual(r.json && r.json.error, 'FORBIDDEN_ROLE');
      r = await call('POST', '/api/ai/wire-deepseek', {}, agentSid);
      assert.strictEqual(r.status, 403, 'AGENT POST /api/ai/wire-deepseek -> 403 (thấy ' + r.status + ')');
      assert.strictEqual(r.json && r.json.error, 'FORBIDDEN_ROLE');

      // OWNER: save base_url chuẩn -> OK; base_url bẩn -> 400 BAD_BASE_URL (không lưu được)
      r = await call('POST', '/api/ai/config', { provider: 'deepseek', api_key: 'sk-owner-0001', base_url: 'http://127.0.0.1:8899/v1' }, ownerSid);
      assert.strictEqual(r.status, 200, 'OWNER save base_url loopback -> 200');
      assert.strictEqual(r.json.ai.base_url, 'http://127.0.0.1:8899/v1');
      r = await call('POST', '/api/ai/config', { provider: 'deepseek', api_key: 'sk-owner-0001', base_url: 'http://169.254.169.254/latest' }, ownerSid);
      assert.strictEqual(r.status, 400, 'OWNER save base_url metadata IP -> 400');
      assert.ok(/^BAD_BASE_URL/.test(String(r.json && r.json.error)), 'error BAD_BASE_URL: ' + (r.json && r.json.error));
      assert.ok(r.json && r.json.userMessage, 'kèm userMessage tiếng Việt');
      // trạng thái sau lần 400: base_url vẫn giữ giá trị hợp lệ trước đó (loopback)
      r = await call('GET', '/api/ai/status', undefined, ownerSid);
      assert.strictEqual(r.json.ai.base_url, 'http://127.0.0.1:8899/v1', 'cấu hình bẩn không vào DB');
      return 'AGENT 2x403, OWNER save đúng luật';
    } finally { await inst.close(); }
  });
}

// ==================================================================== F3/F4 (docs)
async function caseF34() {
  await T('F3', 'docs/SURI-ASYNC.md §7: stability 14/14 (không còn "13/13" stale ngoài chú thích đính chính)', async () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'SURI-ASYNC.md'), 'utf8');
    const scrubbed = doc.replace(/\(đính chính F3[^)]*\)/g, ''); // giữ được phép: chú thích lịch sử
    assert.ok(!scrubbed.includes('13/13'), 'không còn con số stale 13/13 ngoài chú thích đính chính');
    assert.ok(/14\/14[^|]*đính chính F3/.test(doc) || /14\/14 \(đính chính F3/.test(doc), '§7 ghi 14/14 kèm chú thích đính chính');
    return '13/13 -> 14/14 (đính chính F3)';
  });
  await T('F4', 'docs/SURI-ASYNC.md §8.5: deepseek-wire LIVE ping ĐÃ PASS trong suri-p2; đường reply LIVE CHƯA XÁC MINH', async () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'SURI-ASYNC.md'), 'utf8');
    assert.ok(/deepseek-wire LIVE ping: ĐÃ PASS trong suri-p2/.test(doc), '§8.5 ghi rõ ping LIVE đã PASS trong suri-p2');
    assert.ok(/ĐƯỜNG\s+REPLY LIVE/.test(doc), 'phân biệt đường reply LIVE');
    assert.ok(/CHƯA XÁC MINH \(LIVE\)/.test(doc), 'trạng thái CHƯA XÁC MINH (LIVE) còn nguyên cho đường reply');
    assert.ok(!doc.includes('không chạy lại'), 'bỏ mệnh đề sai "không chạy lại"');
    return '§8.5 nhất quán với thực tế chạy';
  });
}

// ==================================================================== MAIN
(async () => {
  console.log('== SURI CLOSURE F1-F5 — ĐÓNG 5 FINDING ==');
  await caseF1();
  await caseF2();
  await caseF5();
  await caseF34();
  const pass = RESULTS.filter(r => r.ok).length;
  console.log(`\nTỔNG: ${pass}/${RESULTS.length} PASS (SURI CLOSURE F1-F5)`);
  if (UNHANDLED !== 0) console.log(`CẢNH BÁO: ${UNHANDLED} unhandledRejection`);
  console.log(`EXIT_CODE=${pass === RESULTS.length && UNHANDLED === 0 ? 0 : 1}`);
  process.exit(pass === RESULTS.length && UNHANDLED === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS_ERROR:', e); process.exit(1); });
