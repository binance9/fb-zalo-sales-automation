'use strict';
// test/suri-p2.js — SURI PHASE 2: DEEPSEEK VÀO ĐƯỜNG TRẢ LỜI THẬT + REPURCHASE HISTORY.
//
// Phạm vi test (đề bài hạng mục TEST):
//   A  AI ON  (provider deepseek đã cấu hình, httpFn TIÊM VÀO — offline): reply của engine
//      KHÔNG còn là template stub + P3C money guard vẫn chặn giá LLM bịa (92500 → DB render).
//   B  AI OFF (chưa cấu hình / use_for_replies=false) → stub FAQ NGUYÊN TRẠNG (khớp text cũ).
//   C  AI TIMEOUT (mô phỏng httpFn timeout / throw / HTTP 500 / JSON xấu) → fallback FAQ stub,
//      KHÔNG crash, khách vẫn nhận tin.
//   D  REPURCHASE THEO HISTORY (spec case 2): khách cũ "lấy thêm cái hôm trước" → engine đọc
//      đơn gần nhất của conversation → đề xuất lại ĐÚNG sản phẩm/số lượng cũ (từ DB) → đi tiếp
//      flow (P3B-1 re-entry, pha A draft) + nhánh CHƯA có lịch sử → hỏi lại, không đoán.
//   E  HTTP API: /api/ai/config chỉ với use_for_replies (toggle độc lập) + view trả use_for_replies.
//   F  REGRESSION: 7 suite cũ + e2e-flows + suri-agent + deepseek-wire PASS nguyên trạng
//      (chạy subprocess, exit code 0). node --check toàn bộ file .js của prototype.
// Exit 0 khi toàn bộ PASS.
//
// Lưu ý trung thực: nhóm A/C dùng DeepSeek GIẢ (httpFn tiêm) — chứng minh ĐƯỜNG ĐI và các ràng
// buộc; câu chữ thật của DeepSeek được xác minh riêng bởi test/suri-live.js (key thật).

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { App } = require('../src/app');
const { SalesAI, buildFactsBlock } = require('../src/sales-ai');
const aiProvider = require('../src/ai-provider');
const { createServer } = require('../server');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data', 'test-runs');
const dir = name => path.join(DATA, 'p2-' + name);
let pid = 0;

function msg(app, ref, text) {
  pid += 1;
  app.receive({
    channel: 'facebook', type: 'message',
    platformEventId: `p2-${ref}-${pid}`,
    payload: { customer_ref: ref, thread_id: ref, kind: 'text', text, platform_message_id: `pm-p2-${pid}` },
  });
  app.drain();
}
const convOf = (app, ref) => app.store.findOne('conversations', c => c.platform_thread_id === ref);
const outsOf = (app, convId) => app.store.findAll('messages', m => m.conversation_id === convId && m.direction === 'out');

// DeepSeek fake: trả content tuỳ ý, đúng shape /chat/completions
const fakeLLMResponse = content => ({
  ok: true, status: 200,
  bodyText: JSON.stringify({ id: 'chatcmpl-test', choices: [{ message: { role: 'assistant', content } }] }),
});
// Bắt request httpFn gửi lên (assert key đi HEADER, facts có trong system)
function capturingLLM(content, capture) {
  return req => {
    if (capture) capture(req);
    return fakeLLMResponse(content);
  };
}

// ============================================================ harness
const RESULTS = [];
async function T(group, desc, fn) {
  const n = RESULTS.length + 1;
  const t0 = Date.now();
  try {
    await fn();
    RESULTS.push({ n, group, desc, ok: true, err: null });
    console.log(`  ${String(n).padStart(2)} PASS  [${group}] ${desc}  ${Date.now() - t0}ms`);
  } catch (e) {
    RESULTS.push({ n, group, desc, ok: false, err: e });
    console.log(`  ${String(n).padStart(2)} FAIL  [${group}] ${desc}  ${Date.now() - t0}ms\n      -> ${e && e.message}`);
  }
}

async function main() {
  console.log('== SURI P2 — DeepSeek vào đường trả lời + repurchase history ==');

  // ------------------------------------------------------------ A: AI ON (DeepSeek wording)
  await T('A', 'A1: provider cấu hình (httpFn tiêm) -> engine trả CÂU CHỮ LLM, không phải stub; key đi HEADER; FACTS nằm trong prompt', async () => {
    const app = new App({ dataDir: dir('a1'), aiHttpFn: capturingLLM(
      'Dạ nến thơm vanilla bên em có 2 lựa chọn ạ: bản nhỏ 165000đ và bản đầy đủ 185000đ, anh/chị ưng bản nào ạ?',
      cap => { global.__a1req = cap; }) });
    aiProvider.saveAiConfig(app.settings, { provider: 'deepseek', api_key: 'sk-p2-test-0000ffff' });
    msg(app, 'a1', 'nến vanilla giá bao nhiêu vậy shop');
    const conv = convOf(app, 'a1');
    const outs = outsOf(app, conv.conversation_id);
    assert.ok(outs.length, 'bot đã trả lời');
    const text = outs[outs.length - 1].text_content;
    // KHÔNG còn template stub — so với text stub gốc cùng intent
    const stub = new SalesAI().stubPropose('PRICE', {
      text: 'nến vanilla giá bao nhiêu vậy shop', facts: app.pipeline.buildFacts(conv, ''),
    });
    assert.notStrictEqual(text, stub.text, 'reply khác template stub');
    assert.ok(/2 lựa chọn/.test(text), 'reply là câu của LLM: ' + text.slice(0, 60));
    assert.strictEqual(app.ai.lastEngine, 'llm:deepseek');
    assert.strictEqual(app.ai.stats.llm_ok, 1);
    // secret hygiene + facts thật nằm trong request gửi đi
    const req = global.__a1req;
    assert.strictEqual(req.headers.Authorization, 'Bearer sk-p2-test-0000ffff', 'key đi HEADER Authorization');
    const body = JSON.parse(req.body);
    assert.strictEqual(body.model, 'deepseek-chat');
    const sysMsg = body.messages.find(m => m.role === 'system');
    assert.ok(/FACTS — DỮ LIỆU CHÍNH THỨC TỪ DATABASE/.test(sysMsg.content), 'prompt có khối FACTS');
    assert.ok(/NT-VANILLA-M-DO/.test(sysMsg.content), 'FACTS chứa SKU thật từ productDB');
    assert.ok(!/0901|0903|0905\d{6}/.test(body.messages.map(m => m.content).join(' ')), 'không PII trong messages');
  });

  await T('A', 'A2: LLM BỊA giá 92500 (không có trong FACTS) -> P3C money guard ĐÈ bằng câu render từ DB, không gửi giá sai', async () => {
    const app = new App({ dataDir: dir('a2'), aiHttpFn: capturingLLM('Dạ bên em đang có GIÁ SỐC chỉ 92500đ cho nến thơm vanilla nha anh/chị ạ!') });
    aiProvider.saveAiConfig(app.settings, { provider: 'deepseek', api_key: 'sk-p2-test-0000ffff' });
    msg(app, 'a2', 'nến vanilla giá bao nhiêu vậy shop');
    const conv = convOf(app, 'a2');
    const text = outsOf(app, conv.conversation_id).pop().text_content;
    assert.ok(!text.includes('92500'), 'giá bịa KHÔNG tới tay khách: ' + text.slice(0, 80));
    assert.ok(text.includes('165000') && text.includes('185000'), 'chỉ còn giá ĐÚNG từ DB');
    const prp = app.store.findAll('ai_proposals', p => p.conversation_id === conv.conversation_id).pop();
    assert.strictEqual(prp.decision, 'OVERRIDDEN', 'gate ghi đè rõ ràng');
  });

  await T('A', 'A3: BUY_ASK (luồng đơn) giữ deterministic — LLM KHÔNG được đụng order flow', async () => {
    const app = new App({ dataDir: dir('a3'), aiHttpFn: capturingLLM('XIN CHÀO TÔI LÀ LLM TỰ DO') });
    aiProvider.saveAiConfig(app.settings, { provider: 'deepseek', api_key: 'sk-p2-test-0000ffff' });
    // đơn vẫn do engine lập khi khách gửi đủ thông tin trong 1 tin (không cần LLM)
    msg(app, 'a3', 'lấy 1 nến vanilla M đỏ, tên An, sdt 0905556677, địa chỉ 3 Lê Lợi Q1');
    let conv = convOf(app, 'a3');
    assert.ok(app.store.findOne('orders', o => o.conversation_id === conv.conversation_id), 'đơn vẫn do engine lập');
    // tin mua khi THIẾU trường (khách mới, chưa có slot) -> BUY_ASK phải KHÔNG qua LLM
    msg(app, 'a3b', 'lấy 1 hộp trà hoa sấy');
    assert.strictEqual(app.ai.stats.llm_calls, 0, 'BUY_ASK không gọi LLM');
    const convB = convOf(app, 'a3b');
    const text = outsOf(app, convB.conversation_id).pop().text_content;
    assert.ok(/SĐT/.test(text), 'vẫn hỏi đúng trường thiếu theo template order: ' + text.slice(0, 90));
  });

  // ------------------------------------------------------------ B: AI OFF -> stub nguyên trạng
  await T('B', 'B1: chưa cấu hình provider -> stub FAQ như cũ (khớp CHÍNH XÁC text stub gốc)', async () => {
    const app = new App({ dataDir: dir('b1') });
    msg(app, 'b1', 'nến vanilla giá bao nhiêu vậy shop');
    const conv = convOf(app, 'b1');
    const text = outsOf(app, conv.conversation_id).pop().text_content;
    const stub = new SalesAI().stubPropose('PRICE', { text: 'x', facts: app.pipeline.buildFacts(conv, '') });
    assert.strictEqual(text, stub.text, 'stub FAQ nguyên trạng khi AI OFF');
    assert.strictEqual(app.ai.lastEngine, 'stub');
    assert.strictEqual(app.ai.stats.llm_calls, 0, 'không gọi mạng');
  });

  await T('B', 'B2: use_for_replies=false (provider vẫn ONLINE) -> stub, KHÔNG gọi LLM', async () => {
    const app = new App({ dataDir: dir('b2'), aiHttpFn: capturingLLM('LLM KHÔNG ĐƯỢC CHẠY') });
    const view = aiProvider.saveAiConfig(app.settings, { provider: 'deepseek', api_key: 'sk-p2-test-0000ffff', use_for_replies: false });
    assert.strictEqual(view.use_for_replies, false, 'view trả use_for_replies=false');
    msg(app, 'b2', 'nến vanilla giá bao nhiêu vậy shop');
    const conv = convOf(app, 'b2');
    const text = outsOf(app, conv.conversation_id).pop().text_content;
    const stub = new SalesAI().stubPropose('PRICE', { text: 'x', facts: app.pipeline.buildFacts(conv, '') });
    assert.strictEqual(text, stub.text);
    assert.strictEqual(app.ai.stats.llm_calls, 0, 'tắt công tắc -> 0 call LLM');
  });

  // ------------------------------------------------------------ C: AI lỗi/timeout -> fallback
  await T('C', 'C1: httpFn TIMEOUT -> fallback FAQ stub, không crash, khách vẫn nhận tin', async () => {
    const app = new App({ dataDir: dir('c1'), aiHttpFn: () => ({ ok: false, timeout: true }) });
    aiProvider.saveAiConfig(app.settings, { provider: 'deepseek', api_key: 'sk-p2-test-0000ffff' });
    msg(app, 'c1', 'nến vanilla giá bao nhiêu vậy shop');
    const conv = convOf(app, 'c1');
    const text = outsOf(app, conv.conversation_id).pop().text_content;
    assert.ok(text && text.length > 10, 'khách vẫn nhận tin fallback');
    assert.strictEqual(app.ai.stats.llm_fallback, 1);
    assert.strictEqual(app.ai.stats.last_fallback_reason, 'ai_timeout');
    assert.strictEqual(app.ai.lastEngine, 'stub');
    assert.ok(text.includes('165000'), 'fallback là stub đọc FACTS đúng');
  });

  await T('C', 'C2: LLM throw / HTTP 500 / JSON xấu / content rỗng -> đều fallback FAQ (4 biến thể)', async () => {
    const variants = [
      ['throw', () => { throw new Error('conn reset'); }],
      ['http500', () => ({ ok: true, status: 500, bodyText: '{"error":{"message":"server exploded"}}' })],
      ['badjson', () => ({ ok: true, status: 200, bodyText: 'not-json-at-all' })],
      ['empty', () => fakeLLMResponse('   ')],
    ];
    for (const [name, fn] of variants) {
      const app = new App({ dataDir: dir('c2-' + name), aiHttpFn: fn });
      aiProvider.saveAiConfig(app.settings, { provider: 'deepseek', api_key: 'sk-p2-test-0000ffff' });
      msg(app, 'c2' + name, 'trà hoa sấy còn hàng không shop');
      const conv = convOf(app, 'c2' + name);
      const text = outsOf(app, conv.conversation_id).pop().text_content;
      assert.ok(text && /145000|145/.test(text), name + ': fallback stub đọc đúng tồn/giá — ' + String(text).slice(0, 60));
      assert.strictEqual(app.ai.stats.llm_fallback, 1, name + ': ghi nhận fallback');
    }
  });

  await T('C', 'C3: getConfig ném lỗi giữa chừng (settings hỏng) -> stub, không crash pipeline', async () => {
    const ai = new SalesAI({ getConfig: () => { throw new Error('settings corrupted'); } });
    const p = ai.propose('CHITCHAT', { state: 'X', mode: 'AI', subject_sku: null, text: 'hello', facts: {} });
    assert.strictEqual(p.intent, 'CHITCHAT');
    assert.ok(p.text && p.text.length, 'stub trả lời bình thường');
  });

  // ------------------------------------------------------------ D: REPURCHASE THEO HISTORY
  await T('D', 'D1: khách cũ "lấy thêm cái hôm trước" -> đề xuất lại ĐÚNG SP/SỐ LƯỢNG từ đơn cũ (DB) -> đơn mới', async () => {
    const app = new App({ dataDir: dir('d1') }); // AI OFF — luồng deterministic
    msg(app, 'd1', 'lấy 2 hộp trà hoa sấy, tên Mai, sdt 0902222333, địa chỉ 7 Hai Bà Trưng Q1');
    let conv = convOf(app, 'd1');
    const o1 = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id);
    assert.ok(o1 && o1.status === 'DRAFT', 'đơn 1 draft');
    const line1 = JSON.parse(o1.price_snapshot_json)[0];
    assert.strictEqual(line1.qty, 2);
    msg(app, 'd1', 'xác nhận');
    assert.strictEqual(app.store.findOne('orders', o => o.order_id === o1.order_id).status, 'CONFIRMED');
    const stockBefore = app.productDB.effectiveStock('TRA-HOA-SEY-50');

    // REPURCHASE: không nhắc tên SP — engine phải đọc đơn cũ
    const replyBefore = outsOf(app, conv.conversation_id).length;
    msg(app, 'd1', 'lấy thêm cái hôm trước');
    const orders = app.store.findAll('orders', o => o.conversation_id === conv.conversation_id);
    assert.strictEqual(orders.length, 2, 'đơn #2 được tạo (không nuốt, không trả đơn cũ)');
    const o2 = orders.find(o => o.order_id !== o1.order_id);
    assert.ok(o2, 'có đơn mới');
    const lines2 = JSON.parse(o2.price_snapshot_json);
    assert.strictEqual(lines2.length, 1);
    assert.strictEqual(lines2[0].sku, line1.sku, 'ĐÚNG SKU từ đơn cũ (DB) — không đoán');
    assert.strictEqual(lines2[0].qty, 2, 'ĐÚNG số lượng cũ');
    const reply = outsOf(app, conv.conversation_id)[replyBefore];
    assert.ok(reply, 'khách nhận phản hồi');
    const rtext = reply.text_content || '';
    assert.ok(rtext.includes('2 x Hộp trà hoa sấy'), 'reply nêu lại SP + số lượng cũ: ' + rtext.slice(0, 90).replace(/\n/g, ' | '));
    assert.ok(app.productDB.effectiveStock('TRA-HOA-SEY-50') === stockBefore - 2, 'reserve đúng 2');
    assert.strictEqual(conv.buy_gen, 1, 'thế hệ mua mới (P3B-1) cho repurchase');
  });

  await T('D', 'D2: repurchase từ state ORDERED (sau khi giao xong) -> đơn #2 vẫn đúng items cũ', async () => {
    const app = new App({ dataDir: dir('d2') });
    msg(app, 'd2', 'lấy 1 combo quà tặng, tên Hoa, sdt 0903333444, địa chỉ 12 Trần Hưng Đạo Q1');
    let conv = convOf(app, 'd2');
    const o1 = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id);
    msg(app, 'd2', 'xác nhận');
    assert.strictEqual(app.store.findOne('orders', o => o.order_id === o1.order_id).status, 'CONFIRMED');
    msg(app, 'd2', 'cho mình lấy lại đơn hôm trước nha');
    const orders = app.store.findAll('orders', o => o.conversation_id === conv.conversation_id);
    const o2 = orders.find(o => o.order_id !== o1.order_id);
    assert.ok(o2 && o2.status === 'DRAFT', 'đơn #2 draft sau re-entry: ' + (o2 && o2.status));
    const l2 = JSON.parse(o2.price_snapshot_json)[0];
    const l1 = JSON.parse(o1.price_snapshot_json)[0];
    assert.strictEqual(l2.sku, l1.sku);
    assert.strictEqual(l2.qty, l1.qty);
  });

  await T('D', 'D3: repurchase khi CHƯA có lịch sử đơn -> hỏi lại, KHÔNG đoán SKU', async () => {
    const app = new App({ dataDir: dir('d3') });
    msg(app, 'd3', 'lấy thêm cái hôm trước nha shop');
    const conv = convOf(app, 'd3');
    const text = outsOf(app, conv.conversation_id).pop().text_content;
    assert.ok(/chưa thấy đơn cũ|sản phẩm nào/.test(text), 'hỏi lại thân thiện: ' + text.slice(0, 80));
    assert.strictEqual(app.store.findAll('orders', o => o.conversation_id === conv.conversation_id).length, 0, 'không tự tạo đơn');
    const prp = app.store.findAll('ai_proposals', p => p.conversation_id === conv.conversation_id).pop();
    assert.strictEqual(prp.intent, 'REPURCHASE_NO_HISTORY');
  });

  await T('D', 'D4: repurchase khi đơn cũ đã HUỶ -> không đề xuất lại đơn huỷ; hỏi lại', async () => {
    const app = new App({ dataDir: dir('d4') });
    msg(app, 'd4', 'lấy 1 hộp trà hoa sấy, tên Khoa, sdt 0904444555, địa chỉ 9 Nguyễn Thị Minh Khai Q1');
    let conv = convOf(app, 'd4');
    const o1 = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id);
    msg(app, 'd4', 'xác nhận');
    msg(app, 'd4', 'hủy đơn giúp mình');
    assert.strictEqual(app.store.findOne('orders', o => o.order_id === o1.order_id).status, 'CANCELLED');
    msg(app, 'd4', 'lấy thêm cái hôm trước');
    const text = outsOf(app, conv.conversation_id).pop().text_content;
    assert.ok(/chưa thấy đơn cũ|sản phẩm nào/.test(text), 'đơn đã huỷ không được đề xuất lại: ' + text.slice(0, 80));
    assert.strictEqual(app.store.findAll('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT').length, 0, 'không lặp draft mới từ đơn huỷ');
  });

  await T('D', 'D5: tin có nhắc SẢN PHẨM vẫn đi BUY (không bị repurchase nuốt) — regression P3B-1a', async () => {
    const app = new App({ dataDir: dir('d5') });
    msg(app, 'd5', 'lấy 2 nến vanilla M đỏ, tên Tung, sdt 0906666777, địa chỉ 5 Lê Thánh Tôn Q1');
    let conv = convOf(app, 'd5');
    msg(app, 'd5', 'xác nhận');
    msg(app, 'd5', 'lấy thêm 1 nến vanilla M đỏ nữa, giao địa chỉ cũ nhé');
    const orders = app.store.findAll('orders', o => o.conversation_id === conv.conversation_id);
    assert.strictEqual(orders.length, 2, 'mua-lại-có-nhắc-SP vẫn tạo đơn #2 (nguyên tắc P3B-1)');
    const o2 = orders.find(o => JSON.parse(o.price_snapshot_json)[0].qty === 1);
    assert.ok(o2, 'đơn mới theo qty tin mới (1), không phải qty cũ');
  });

  // ------------------------------------------------------------ E: HTTP API (use_for_replies + view)
  await T('E', 'E1: HTTP — /api/ai/config toggle độc lập use_for_replies + /api/ai/status trả view', async () => {
    const root = path.join(DATA, 'p2-e1');
    fs.rmSync(root, { recursive: true, force: true });
    const inst = createServer({ port: 0, authDir: path.join(root, 'auth'), shopsRoot: path.join(root, 'shops'), uiDemo: '0', appDataMode: 'persist' });
    inst.listen();
    for (let i = 0; i < 60 && !inst.server.listening; i++) await new Promise(r => setTimeout(r, 20));
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
      const setup = await call('POST', '/api/auth/setup', { email: 'p2@test.dev', password: 'password123', shop_name: 'P2 Shop' });
      assert.strictEqual(setup.status, 200);
      const sid = setup.headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
      // chưa cấu hình: view vẫn trả use_for_replies=true (mặc định)
      let st = await call('GET', '/api/ai/status', undefined, sid);
      assert.strictEqual(st.json.ai.use_for_replies, true, 'mặc định TRUE');
      assert.strictEqual(st.json.ai.status, 'DISABLED');
      // toggle OFF độc lập (không provider trong body)
      let r = await call('POST', '/api/ai/config', { use_for_replies: false }, sid);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.ai.use_for_replies, false);
      // toggle ON lại
      r = await call('POST', '/api/ai/config', { use_for_replies: true }, sid);
      assert.strictEqual(r.json.ai.use_for_replies, true);
      // save đầy đủ vẫn giữ công tắc + trả masked key
      r = await call('POST', '/api/ai/config', { provider: 'deepseek', api_key: 'sk-p2-api-00112233', use_for_replies: true }, sid);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.ai.provider, 'deepseek');
      assert.strictEqual(r.json.ai.use_for_replies, true);
      assert.ok(/^\*\*\*\d{4}$/.test(r.json.ai.api_key_masked), 'key masked đúng format: ' + r.json.ai.api_key_masked);
      assert.ok(!JSON.stringify(r.json).includes('sk-p2-api-00112233'), 'key thô KHÔNG bao giờ ra API');
      // lỗi validate có userMessage thân thiện (hạng mục 5c)
      r = await call('POST', '/api/ai/config', { provider: 'khongton tai', api_key: 'x' }, sid);
      assert.strictEqual(r.status, 400);
      assert.ok(r.json.userMessage, '400 kèm userMessage tiếng Việt');
    } finally { await inst.close(); }
  });

  // ------------------------------------------------------------ F: node --check + regression subprocess
  await T('F', 'F1: node --check toàn bộ file .js (src + server + test)', async () => {
    const files = [];
    const walk = d => {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        const st = fs.statSync(p);
        if (st.isDirectory()) { if (f !== 'node_modules' && f !== 'data') walk(p); } else if (f.endsWith('.js')) files.push(p);
      }
    };
    walk(path.join(ROOT, 'src')); walk(path.join(ROOT, 'test')); walk(path.join(ROOT, 'ui'));
    files.push(path.join(ROOT, 'server.js'));
    for (const f of files) {
      const r = spawnSync('node', ['--check', f], { encoding: 'utf8' });
      assert.strictEqual(r.status, 0, `node --check FAIL: ${f}\n${r.stderr}`);
    }
    assert.ok(files.length >= 40, 'số file check hợp lý: ' + files.length);
  });

  const SUITES = [
    ['test/18-cases.js', '18-case lõi'],
    ['test/invariants-check.js', 'invariants'],
    ['test/gate-a.js', 'gate A'],
    ['test/p3b-cases.js', 'P3B'],
    ['test/p3c-cases.js', 'P3C'],
    ['test/live-adapters.js', 'live adapters'],
    ['test/product-ready.js', 'product-ready'],
    ['test/e2e-flows.js', 'e2e flows'],
    ['test/suri-agent.js', 'suri agent (P1)'],
    ['test/deepseek-wire.js', 'deepseek wire (LIVE)'],
  ];
  await T('F', 'F2: REGRESSION 7 suite + e2e-flows + suri-agent + deepseek-wire PASS nguyên trạng', async () => {
    const report = [];
    for (const [rel, label] of SUITES) {
      const t0 = Date.now();
      const r = spawnSync('node', [path.join(ROOT, rel)], { encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
      const ok = r.status === 0;
      report.push(`${ok ? 'PASS' : 'FAIL'} ${label} (${rel}) [${Math.round((Date.now() - t0) / 100) / 10}s]`);
      console.log(`      ${report[report.length - 1]}`);
      if (!ok) {
        console.log('      ---- stdout tail ----\n' + String(r.stdout || '').split('\n').slice(-14).join('\n'));
        console.log('      ---- stderr tail ----\n' + String(r.stderr || '').split('\n').slice(-8).join('\n'));
      }
      assert.strictEqual(r.status, 0, 'suite phải exit 0 nguyên trạng: ' + rel);
    }
    global.__regressionReport = report;
  });

  // ------------------------------------------------------------ tổng
  const failed = RESULTS.filter(r => !r.ok);
  console.log(`\nTỔNG: ${RESULTS.length - failed.length}/${RESULTS.length} PASS (SURI P2)`);
  if (global.__regressionReport) console.log('Regression:\n  ' + global.__regressionReport.join('\n  '));
  console.log(failed.length === 0 ? '==> SURI P2: TOÀN BỘ PASS.' : '==> CÒN FAIL — xem log trên.');
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch(e => { console.error('[fatal]', e); process.exitCode = 1; });
