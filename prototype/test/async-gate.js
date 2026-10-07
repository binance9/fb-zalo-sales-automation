'use strict';
// test/async-gate.js — SURI ASYNC GATE: NGHIỆM THU LỖI 2 SAU VÁ (8 proof P1-P8).
//
// Bản vá: đường LLM propose BẤT ĐỒNG BỘ (live-http.httpOnceAsync — spawn curl không sync);
// kênh gửi (Action Gate → sendMessage) GIỮ SYNC như cũ; core P3A/P3B/P3C nguyên trạng.
//
// Bằng chứng:
//   P1  AI chờ 6s → GET /api/health + POST takeover trong lúc chờ trả < 300ms (HTTP thật,
//       tiến trình khách độc lập — test/_async-client.js scenario repro).
//   P2  takeover trong lúc AI chờ → reply muộn REJECT 'takeover' (mode HUMAN), khách 0 tin.
//   P3  bot-off trong lúc AI chờ → reply muộn REJECT 'bot_off', khách 0 tin.
//   P4  khách đổi ý trong lúc AI chờ → câu tư vấn cũ KHÔNG gửi (REJECT 'stale_user_change'),
//       tin đổi ý vẫn được xử lý.
//   P5  timeout THEO CẤU HÌNH SHOP (3s) trên transport THẬT (httpOnceAsync + curl --max-time):
//       reply fallback về ~3s (không phải 6s của mock, không phải default 8s).
//   P6  5 khách đồng thời (AI chậm) → mỗi conv đúng 1 reply ĐÚNG SẢN PHẨM của mình, không
//       cross-talk, không mất tin (in-process so nội dung + HTTP đếm số lượng).
//   P7  restart giữa xử lý và gửi (persist) → không dup send, không mất job/follow-up.
//   P8  send chưa rõ kết quả (platform chờ receipt) → đối soát qua receipt store/job,
//       KHÔNG retry mù (đúng 1 send, receipt đến thì confirm).
//
// Mỗi proof ghi bảng timestamp (gửi/nhận/xử lý/commit/before-send) + event-loop latency
// (probe tick 5ms trong lúc AI chờ) + API latency (HTTP proofs).
//
// Chạy: node test/async-gate.js  — exit 0 khi toàn bộ PASS. Offline: LLM = slow-ai-mock local
// (không đụng DeepSeek thật); P2/P3/P4/P6/P7/P8 dùng aiAsyncHttpFn tiêm (không ra mạng);
// P5 + P1 dùng transport THẬT httpOnceAsync/curl tới mock trên 127.0.0.1.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const assert = require('assert');

const ROOT = __dirname;
const DATA = path.join(ROOT, '..', 'data', 'test-runs');
const TRACE = path.join(ROOT, '..', 'docs', 'STABILITY-TRACE');
const RESULTS = [];
const TABLE = [];

function log() { console.log.apply(console, arguments); }

async function T(id, desc, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    RESULTS.push({ id, desc, ok: true, note: note || '' });
    log(`  [PASS] ${id} — ${desc} (${Date.now() - t0}ms)${note ? ' :: ' + note : ''}`);
  } catch (e) {
    RESULTS.push({ id, desc, ok: false, note: String((e && e.message) || e).split('\n')[0] });
    log(`  [FAIL] ${id} — ${desc}\n         -> ${String((e && e.message) || e).split('\n').slice(0, 3).join(' | ')}`);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Probe event-loop: trả {stop(), maxGapMs()} — đo gap lớn nhất giữa 2 tick trong lúc đo.
function loopProbe(intervalMs = 5) {
  let last = Date.now();
  let maxGap = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    const gap = now - last;
    if (gap > maxGap) maxGap = gap;
    last = now;
  }, intervalMs);
  return { stop: () => clearInterval(timer), maxGapMs: () => maxGap };
}

// ---------------------------------------------------------------- in-process helpers
const FB = 'facebook';
let seq = 0;
function fire(app, ref, text, extra = {}) {
  seq += 1;
  return app.receive({
    channel: extra.channel || FB,
    type: 'message',
    platformEventId: extra.pid || `ag-${ref}-${seq}`,
    payload: { customer_ref: ref, thread_id: extra.thread || ref, kind: extra.kind || 'text', text: text || '', platform_message_id: `ag-pm-${seq}` },
  });
}
const fireDrain = (app, ref, text, extra = {}) => { fire(app, ref, text, extra); app.drain(); };
const convOf = (app, ref) => app.store.findOne('conversations', c => c.platform_thread_id === ref);
const outMsgs = (app, ref) => {
  const c = convOf(app, ref);
  return c ? app.store.findAll('messages', m => m.conversation_id === c.conversation_id && m.direction === 'out') : [];
};
const inMsgs = (app, ref) => {
  const c = convOf(app, ref);
  return c ? app.store.findAll('messages', m => m.conversation_id === c.conversation_id && m.direction === 'in') : [];
};
const auditsOf = (app, ref) => {
  const c = convOf(app, ref);
  return c ? app.store.findAll('audit_events', a => a.conversation_id === c.conversation_id) : [];
};
const setBot = (app, on) => app.store.transaction(() => {
  const row = app.store.findOne('settings', s => s.key === 'bot_enabled');
  app.store.updateRow('settings', row, { value: !!on });
});

// LLM async giả (không ra mạng): trả sau delayMs — có cổng chặn ngoài (hold).
function asyncLLM({ delayMs = 400, answer = 'Dạ nến thơm vanilla size M giá 185.000đ nha anh/chị ạ!', hold } = {}) {
  const calls = [];
  return async req => {
    calls.push(req);
    if (delayMs) await sleep(delayMs);
    if (hold) await hold;
    return { ok: true, status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: answer } }] }) };
  };
}

function newAsyncApp(name, aiAsyncHttpFn) {
  const { App } = require('../src/app');
  const aiProvider = require('../src/ai-provider');
  const app = new App({ dataDir: path.join(DATA, name), aiAsyncHttpFn });
  if (aiAsyncHttpFn) aiProvider.saveAiConfig(app.settings, { provider: 'deepseek', api_key: 'sk-async-gate-0001' });
  return app;
}

// ---------------------------------------------------------------- HTTP infra (P1/P5/P6-HTTP)
function spawnChild(cmd, args, logFile) {
  const out = fs.openSync(logFile, 'a');
  const child = spawn(cmd, args, { cwd: path.join(ROOT, '..'), stdio: ['ignore', out, out], windowsHide: true });
  return child;
}
function waitPortInLog(file, marker, timeoutMs = 20000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      try {
        const txt = fs.readFileSync(file, 'utf8');
        const m = txt.match(new RegExp(marker + '=(\\d+)'));
        if (m) return resolve(Number(m[1]));
      } catch (e) { /* chưa có */ }
      if (Date.now() - t0 > timeoutMs) return reject(new Error('timeout waiting ' + marker + ' in ' + file));
      setTimeout(poll, 150);
    })();
  });
}
function runClient(args, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, '_async-client.js'), ...args], { cwd: path.join(ROOT, '..'), windowsHide: true });
    let buf = '';
    child.stdout.on('data', c => { buf += c; });
    child.stderr.on('data', c => { buf += c; });
    const killer = setTimeout(() => child.kill(), timeoutMs);
    child.on('exit', code => {
      clearTimeout(killer);
      const m = buf.match(/CLIENT_RESULT=(.*)/);
      let result = null;
      try { result = m ? JSON.parse(m[1]) : null; } catch (e) { result = null; }
      resolve({ code, buf, result });
    });
    child.on('error', reject);
  });
}

// ================================================================= P1-P4, P6-HTTP (HTTP thật)
let MOCK_PORT = null;
let PROTO_PORT = null;
let mockChild = null;
let protoChild = null;
const HTTP_ROOT = path.join(DATA, `async-http-${Date.now()}`); // root DUY NHẤT/lần chạy — chống nhiễm dữ liệu từ tiến trình cũ

async function bootHttp() {
  fs.rmSync(HTTP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TRACE, { recursive: true });
  const mockLog = path.join(TRACE, 'async-after-mock.log');
  const protoLog = path.join(TRACE, 'async-after-server.log');
  fs.writeFileSync(mockLog, ''); // truncate — chờ port của LẦN NÀY (log cũ chứa port lần trước)
  mockChild = spawnChild(process.execPath, [path.join(ROOT, 'slow-ai-mock.js'), '0', '6000'], mockLog);
  MOCK_PORT = await waitPortInLog(mockLog, 'MOCK_PORT');
  fs.writeFileSync(protoLog, '');
  protoChild = spawnChild(process.execPath, [path.join(ROOT, '_boot-async-server.js'), '--port', '0', '--tag', path.basename(HTTP_ROOT).replace(/^async-/, ''), '--app-data-mode', 'persist'], protoLog);
  PROTO_PORT = await waitPortInLog(protoLog, 'PROTO_PORT');
  log(`  [infra] mock=${MOCK_PORT} proto=${PROTO_PORT} (log: docs/STABILITY-TRACE/async-after-*.log)`);
  await sleep(800); // server accept xong (auth API sẵn sàng)
}
async function teardownHttp() {
  if (protoChild) { try { protoChild.kill(); } catch (e) { /* ignore */ } }
  if (mockChild) { try { mockChild.kill(); } catch (e) { /* ignore */ } }
}

// ================================================================= MAIN
(async () => {
  log('== SURI ASYNC GATE — nghiệm thu LỖI 2 sau vá (8 proof) ==');
  const tBoot = Date.now();

  // ---------------------------------------------------------------- P2 (in-process, lý do riêng biệt)
  await T('P2', 'takeover giữa lúc AI chờ -> reply muộn REJECT takeover, khách 0 tin', async () => {
    const hold = {};
    let release;
    hold.promise = new Promise(r => { release = r; });
    const app = newAsyncApp('async-gate-p2', asyncLLM({ delayMs: 150, hold: hold.promise }));
    const probe = loopProbe(5);
    const tSend = Date.now();
    fireDrain(app, 'p2', 'nến vanilla size M giá bao nhiêu vậy shop');
    const tSuspended = Date.now();
    const gap = tSuspended - tSend; // drain phải trả NGAY (không chặn)
    assert.ok(gap < 300, 'P2: drain không được chặn cho LLM (nhận ' + gap + 'ms)');
    // takeover GIỮA LÚC AI chờ — cùng core API takeover (/api/conversations/:id/takeover)
    const tTake = Date.now();
    app.takeover.setTakeover(convOf(app, 'p2'), 'nv-hung', 'ui_takeover');
    const tTakeDone = Date.now();
    assert.ok(tTakeDone - tTake < 300, 'P2: takeover API phải tức thời trong cửa sổ chờ');
    release();
    const t0 = Date.now();
    while (!app.ai.stats.llm_ok && Date.now() - t0 < 3000) await sleep(20);
    const out = outMsgs(app, 'p2');
    probe.stop();
    assert.strictEqual(out.length, 0, 'P2: khách KHÔNG nhận tin bot nào (nhận ' + out.length + ')');
    const rej = auditsOf(app, 'p2').filter(a => String(a.execution_result || '').includes('REJECTED:takeover'));
    assert.ok(rej.length >= 1, 'P2: audit REJECTED:takeover');
    assert.strictEqual(app.metric('gate_rejected_takeover') >= 1, true, 'P2: metric gate_rejected_takeover');
    const prp = app.store.findAll('ai_proposals', p => p.conversation_id === convOf(app, 'p2').conversation_id && p.decision === 'REJECTED_BY_GATE');
    assert.ok(prp.length >= 1, 'P2: proposal muộn REJECTED_BY_GATE');
    TABLE.push({ proof: 'P2', send: tSend, suspended: tSuspended, takeover_ms: tTakeDone - tTake, event_loop_max_gap: probe.maxGapMs() + 'ms', outcome: 'REJECTED:takeover, 0 tin tới khách' });
    return `drain ${gap}ms, takeover ${tTakeDone - tTake}ms, loop max-gap ${probe.maxGapMs()}ms`;
  });

  // ---------------------------------------------------------------- P3 (in-process)
  await T('P3', 'bot OFF giữa lúc AI chờ -> reply muộn REJECT bot_off', async () => {
    const hold = {};
    let release;
    hold.promise = new Promise(r => { release = r; });
    const app = newAsyncApp('async-gate-p3', asyncLLM({ delayMs: 150, hold: hold.promise }));
    fireDrain(app, 'p3', 'nến vanilla size S giá bao nhiêu ạ');
    assert.ok(outMsgs(app, 'p3').length === 0, 'P3: chưa có tin nào trong lúc chờ');
    setBot(app, false); // cùng đường /api/settings/bot off
    release();
    const t0 = Date.now();
    while (!app.ai.stats.llm_ok && Date.now() - t0 < 3000) await sleep(20);
    const out = outMsgs(app, 'p3');
    assert.strictEqual(out.length, 0, 'P3: bot OFF -> 0 tin bot');
    const rej = auditsOf(app, 'p3').filter(a => String(a.execution_result || '').includes('REJECTED:bot_off'));
    assert.ok(rej.length >= 1, 'P3: audit REJECTED:bot_off');
    assert.strictEqual(app.metric('gate_rejected_bot_off') >= 1, true, 'P3: metric gate_rejected_bot_off');
    TABLE.push({ proof: 'P3', outcome: 'REJECTED:bot_off, 0 tin tới khách' });
    return 'audit REJECTED:bot_off + metric';
  });

  // ---------------------------------------------------------------- P4 (in-process)
  await T('P4', 'khách đổi ý giữa lúc AI chờ -> câu tư vấn cũ KHÔNG gửi (stale_user_change)', async () => {
    const hold = {};
    let release;
    hold.promise = new Promise(r => { release = r; });
    const app = newAsyncApp('async-gate-p4', asyncLLM({ delayMs: 150, hold: hold.promise }));
    fireDrain(app, 'p4', 'nến vanilla size M giá bao nhiêu vậy shop');
    assert.ok(inMsgs(app, 'p4').length === 1, 'P4: tin hỏi giá đã vào');
    // khách đổi ý GIỮA LÚC CHỜ (tin thứ 2 — phải được xử lý ngay, không kẹt LLM)
    const tChange = Date.now();
    fireDrain(app, 'p4', 'thôi bỏ đơn không mua nữa nha shop');
    const changeMs = Date.now() - tChange;
    assert.ok(changeMs < 300, 'P4: tin đổi ý xử lý ngay cả khi LLM đang chờ (nhận ' + changeMs + 'ms)');
    assert.strictEqual(inMsgs(app, 'p4').length, 2, 'P4: tin đổi ý vẫn được nhận xử lý');
    release();
    const t0 = Date.now();
    while (!app.ai.stats.llm_ok && Date.now() - t0 < 3000) await sleep(20);
    await sleep(50);
    const out = outMsgs(app, 'p4');
    // tin duy nhất được phép là ACK hệ thống cho TIN ĐỔI Ý (route CANCEL_ORDER — xử lý ngay);
    // câu TƯ VẤN CŨ của LLM (do mock viết — chứa giá vanilla) KHÔNG được xuất hiện.
    const stale = out.filter(m => /185\.000|185000|giá bao nhiêu/.test(String(m.text_content || '')) && !/đang xử lý/.test(String(m.text_content || '')));
    assert.strictEqual(stale.length, 0, 'P4: câu tư vấn cũ KHÔNG được gửi (thấy: ' + stale.map(m => m.text_content).join(' | ') + ')');
    const rej = auditsOf(app, 'p4').filter(a => String(a.execution_result || '').includes('stale_user_change'));
    assert.ok(rej.length >= 1, 'P4: audit stale_user_change');
    TABLE.push({ proof: 'P4', change_processed_ms: changeMs, outcome: 'REJECT stale_user_change, tin đổi ý vẫn xử lý' });
    return 'tin đổi ý xử lý ' + changeMs + 'ms; reply cũ REJECT stale_user_change';
  });

  // ---------------------------------------------------------------- P6 (in-process, nội dung)
  await T('P6', '5 khách đồng thời (AI chậm) -> đúng reply/đúng conv, không cross-talk', async () => {
    const delay = 400;
    // LLM giả đọc FACTS trong system prompt và chỉ được nhắc giá CỦA SẢN PHẨM ĐÓ —
    // nếu pipeline lẫn ctx giữa 2 conv, reply sẽ chứa giá sai => bắt được cross-talk.
    const app = newAsyncApp('async-gate-p6', async req => {
      await sleep(delay);
      const body = JSON.parse(String(req.body || '{}'));
      const sys = String((body.messages || [{ content: '' }])[0].content || '');
      const name = (sys.match(/Sản phẩm khách đang hỏi: (.+)/) || [])[1] || 'sản phẩm';
      const price = (sys.match(/(\d{4,6})đ/) || [])[1] || '0';
      return { ok: true, status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: `Dạ ${name} giá ${price}đ nha anh/chị ạ!` } }] }) };
    });
    // 5 SP khác nhau, TẬP GIÁ KHÔNG GIAO nhau (vanilla 165/185k, oải hương 175k, trà hoa 145k,
    // combo 399k, set tết 529k) — reply nào nhắc giá của SP khác là cross-talk thật.
    const refs = ['p6-a', 'p6-b', 'p6-c', 'p6-d', 'p6-e'];
    const texts = {
      'p6-a': 'nến vanilla size M giá bao nhiêu vậy shop',
      'p6-b': 'nến oải hương giá bao nhiêu ạ',
      'p6-c': 'trà hoa sấy giá thế nào shop ơi',
      'p6-d': 'combo quà tặng giá bao nhiêu ạ',
      'p6-e': 'set quà tết giá bao nhiêu vậy',
    };
    const probe = loopProbe(5);
    const t0 = Date.now();
    for (const ref of refs) fireDrain(app, ref, texts[ref]);
    const fireMs = Date.now() - t0;
    assert.ok(fireMs < 1500, 'P6: 5 tin bắn trong lúc AI chậm không được chặn (nhận ' + fireMs + 'ms)');
    probe.stop();
    const t1 = Date.now();
    while (app.ai.stats.llm_ok < 5 && Date.now() - t1 < 5000) await sleep(20);
    await sleep(100);
    const perConv = {};
    for (const ref of refs) {
      const outs = outMsgs(app, ref);
      assert.strictEqual(outs.length, 1, `P6: ${ref} đúng 1 reply (thấy ${outs.length})`);
      assert.strictEqual(inMsgs(app, ref).length, 1, `P6: ${ref} đúng 1 tin vào`);
      const prices = String(outs[0].text_content).match(/\d{4,6}(?=đ)/g) || [];
      perConv[ref] = prices;
      assert.ok(prices.length >= 1, `P6: ${ref} reply có giá (${outs[0].text_content})`);
    }
    assert.strictEqual(app.ai.stats.llm_calls, 5, 'P6: đúng 5 call LLM (không mất tin)');
    // ranh giới số: mỗi conv KHÔNG được nhắc giá của SP conv khác (set giá không giao nhau)
    for (const a of refs) {
      for (const b of refs) {
        if (a === b) continue;
        for (const pa of perConv[a]) {
          assert.ok(!perConv[b].includes(pa), `P6: cross-talk — ${a} nhắc giá ${pa}đ trùng reply của ${b}`);
        }
      }
    }
    TABLE.push({ proof: 'P6', fire5_ms: fireMs, loop_max_gap: probe.maxGapMs() + 'ms', per_conv: refs.map(r => r + ':' + perConv[r].join('/')).join(' ') });
    return `5/5 reply đúng SP, 0 cross-talk, 5 lần bắn ${fireMs}ms`;
  });

  // ---------------------------------------------------------------- P7 (in-process, persist)
  await T('P7', 'restart giữa xử lý và gửi (persist) -> không dup send, không mất job', async () => {
    const { App } = require('../src/app');
    const dir = path.join(DATA, 'async-gate-p7');
    fs.rmSync(dir, { recursive: true, force: true });
    // App1: AI không bao giờ trả (mô phỏng tiến trình chết giữa chờ LLM)
    const app1 = new App({ dataDir: dir, persist: true, aiAsyncHttpFn: async () => new Promise(() => { /* treo vĩnh viễn */ }) });
    const aiProvider = require('../src/ai-provider');
    aiProvider.saveAiConfig(app1.settings, { provider: 'deepseek', api_key: 'sk-p7-0001' });
    fireDrain(app1, 'p7', 'nến vanilla size M giá bao nhiêu vậy shop');
    assert.strictEqual(outMsgs(app1, 'p7').length, 0, 'P7: App1 chưa gửi gì (AI treo)');
    // follow-up CARE đến hạn NGAY trước restart — phải sống qua restart và chạy ĐÚNG 1 lần
    const cust7 = app1.store.findOne('customers', c => c.channel === FB && c.platform_ref === 'p7');
    app1.store.transaction(() => {
      app1.store.insert('follow_ups', {
        follow_up_id: 'fu-p7-1', order_id: null,
        conversation_id: convOf(app1, 'p7').conversation_id, customer_id: cust7.customer_id,
        kind: 'CARE', scheduled_at: app1.clock.iso(), status: 'SCHEDULED',
        cancel_reason: null, exec_id: null, created_at: app1.clock.iso(), updated_at: app1.clock.iso(),
      });
    });
    // RESTART: App2 cùng dataDir (persist) — App1 bỏ lại (promise không bao giờ settle).
    // App2 chạy STUB (provider local — thao tác operator qua settings, không đụng mạng) để
    // chứng minh App2 phục vụ tin mới NGAY sau restart.
    const app2 = new App({ dataDir: dir, persist: true });
    aiProvider.saveAiConfig(app2.settings, { provider: 'local', api_key: '' });
    const c2 = app2.store.findOne('conversations', c => c.platform_thread_id === 'p7');
    assert.ok(!!c2, 'P7: hội thoại còn nguyên sau restart');
    const outs1 = app2.store.findAll('messages', m => m.direction === 'out');
    assert.strictEqual(outs1.length, 0, 'P7: sau restart KHÔNG có tin out nào từ turn cũ (dup=0)');
    const ins = app2.store.findAll('messages', m => m.conversation_id === c2.conversation_id && m.direction === 'in');
    assert.strictEqual(ins.length, 1, 'P7: tin khách nguyên vẹn qua restart');
    // job/follow-up KHÔNG mất: scheduler App2 chạy follow-up đúng 1 lần (idem follow_up:<id>)
    app2.advance(60 * 1000);
    const fus = app2.store.findAll('follow_ups', f => f.follow_up_id === 'fu-p7-1');
    assert.strictEqual(fus.length, 1, 'P7: follow-up còn đúng 1 row');
    assert.ok(['SENT', 'PENDING_RECEIPT', 'HELD'].includes(fus[0].status), 'P7: follow-up được scheduler xử lý sau restart (status=' + fus[0].status + ')');
    const fuAudits = app2.store.findAll('audit_events', a => a.conversation_id === c2.conversation_id
      && String(a.proposed_action || '').startsWith('FOLLOW_UP') && a.execution_result === 'SENT');
    assert.ok(fuAudits.length <= 1, 'P7: follow-up gửi đúng 1 lần (idem), thấy ' + fuAudits.length);
    // tin mới sau restart phục vụ bình thường (stub — app2 chưa cấu hình LLM)
    fireDrain(app2, 'p7-new', 'chào shop ạ');
    assert.strictEqual(outMsgs(app2, 'p7-new').length, 1, 'P7: App2 phục vụ tin mới bình thường');
    TABLE.push({ proof: 'P7', outcome: 'dup=0, tin vào nguyên vẹn, follow-up chạy đúng 1 lần sau restart' });
    return 'dup=0, mất=0, follow-up idem';
  });

  // ---------------------------------------------------------------- P8 (in-process, receipt)
  await T('P8', 'send chưa rõ kết quả (platform timeout) -> đối soát receipt, KHÔNG retry mù', async () => {
    const hold = {};
    let release;
    hold.promise = new Promise(r => { release = r; });
    // platform hang_then_deliver: sendMessage trả timeout (kết quả CHƯA BIẾT) rồi receipt
    // về muộn — gate phải giữ SENT_PENDING_RECEIPT + job check_send_receipt, cấm gửi lại.
    const app = newAsyncApp('async-gate-p8', asyncLLM({ delayMs: 150, hold: hold.promise }));
    app.platform.mode = 'hang_then_deliver';
    fireDrain(app, 'p8', 'nến vanilla size M giá bao nhiêu vậy shop');
    release();
    const t0 = Date.now();
    while (!app.ai.stats.llm_ok && Date.now() - t0 < 3000) await sleep(20);
    await sleep(30);
    const outs = outMsgs(app, 'p8');
    assert.strictEqual(outs.length, 1, 'P8: đúng 1 send (không retry mù), thấy ' + outs.length);
    assert.strictEqual(outs[0].delivery_status, 'SENT_PENDING_RECEIPT', 'P8: trạng thái sau timeout = SENT_PENDING_RECEIPT (kết quả chưa biết)');
    assert.ok(app.store.findAll('jobs', j => j.kind === 'check_send_receipt' && j.status === 'QUEUED').length >= 1, 'P8: job đối soát receipt đã xếp');
    assert.strictEqual(app.platform.sentCalls.length, 1, 'P8: platform bị gọi sendMessage đúng 1 lần');
    // receipt về muộn (mock bắn webhook theo đồng hồ) -> đối soát nâng DELIVERED, KHÔNG send thêm
    app.advance(30 * 1000);
    const outs2 = outMsgs(app, 'p8');
    assert.strictEqual(outs2.length, 1, 'P8: sau receipt vẫn đúng 1 tin (không dup)');
    assert.strictEqual(outs2[0].delivery_status, 'DELIVERED', 'P8: receipt về -> DELIVERED (thấy ' + outs2[0].delivery_status + ')');
    assert.strictEqual(app.platform.sentCalls.length, 1, 'P8: platform vẫn chỉ 1 sendMessage (0 blind retry)');
    TABLE.push({ proof: 'P8', sends: outs2.length, platform_calls: app.platform.sentCalls.length, delivery: outs2[0].delivery_status });
    return '1 send, SENT_PENDING_RECEIPT -> DELIVERED qua receipt, 0 blind retry';
  });

  // ---------------------------------------------------------------- HTTP proofs
  // THỨ TỰ: P5 → P6h → P1. Lý do: bot ON từ boot (demo); scenario repro (P1) TẮT bot trong
  // cửa sổ chờ và KHÔNG bật lại được qua API (POST on bị chặn go-live checklist — hành vi
  // đúng của server) → P1 chạy CUỐI để không làm rơi bot của P5/P6h.
  await bootHttp();
  try {
    // P5: timeout theo cấu hình shop trên transport THẬT (httpOnceAsync + curl --max-time)
    await T('P5', 'shop timeout 3s: reply fallback về ~3s (transport thật, không phải 6s mock / 8s default)', async () => {
      const t0 = Date.now();
      const r = await runClient(['--url', `http://127.0.0.1:${PROTO_PORT}`, '--mock-port', String(MOCK_PORT), '--db', HTTP_ROOT, '--scenario', 'timeout', '--timeout', '3000', '--out', path.join(TRACE, 'async-after-timeout.json')], 60000);
      const wall = Date.now() - t0;
      assert.strictEqual(r.code, 0, 'P5: client exit 0 — ' + r.buf.slice(-300));
      const first = r.result.result.first_reply_ms;
      assert.ok(first >= 1800 && first <= 5200, 'P5: reply đầu phải về trong [1.8s..5.2s] (nhận ' + first + 'ms)');
      assert.ok(wall < 20000, 'P5: tổng thời gian hợp lý');
      TABLE.push({ proof: 'P5(HTTP)', first_reply_ms: first, expected: '≈3000 (curl --max-time theo shop), mock=6000, default=8000', outcome: 'fallback đúng hạn' });
      return `first_reply ${first}ms (timeout shop=3000ms)`;
    });

    // P6-HTTP: 5 khách đồng thời qua HTTP (đếm số lượng; nội dung đã chứng minh P6 in-process)
    await T('P6h', '5 khách đồng thời qua HTTP (AI chậm 6s): mỗi conv đúng 1 reply, không mất/lặp', async () => {
      const r = await runClient(['--url', `http://127.0.0.1:${PROTO_PORT}`, '--mock-port', String(MOCK_PORT), '--db', HTTP_ROOT, '--scenario', 'conc', '--delay', '6000', '--out', path.join(TRACE, 'async-after-conc.json')], 90000);
      assert.strictEqual(r.code, 0, 'P6h: client exit 0 — ' + r.buf.slice(-300));
      const res = r.result.result;
      assert.strictEqual(res.total_in, 5, 'P6h: 5 tin vào');
      assert.strictEqual(res.total_out, 5, 'P6h: đúng 5 tin ra (không lặp/không mất)');
      for (const row of res.per_conv) {
        assert.strictEqual(row.out, 1, `P6h: ${row.ref} đúng 1 reply`);
        assert.strictEqual(row.in, 1, `P6h: ${row.ref} đúng 1 tin vào`);
        assert.ok(row.runs.length === 1 && row.runs[0].status === 'DONE' && row.runs[0].replies === 1, `P6h: ${row.ref} agent run DONE/1 reply`);
      }
      TABLE.push({ proof: 'P6(HTTP)', total_in: res.total_in, total_out: res.total_out, runs: '5 DONE' });
      return '5 conv x (1 in, 1 out, run DONE)';
    });

    // P1 + P2/P3/P4 gộp qua HTTP (CHẠY CUỐI — scenario tắt bot): bắn giá → health/takeover/
    // botoff/đổi ý trong cửa sổ 6s AI chờ; đo latency từng call + reply muộn bị chặn.
    await T('P1', 'AI chờ 6s: health + takeover + botoff + đổi ý đều trả < 300ms (HTTP thật)', async () => {
      const r = await runClient(['--url', `http://127.0.0.1:${PROTO_PORT}`, '--mock-port', String(MOCK_PORT), '--db', HTTP_ROOT, '--scenario', 'repro', '--delay', '6000', '--out', path.join(TRACE, 'async-after-repro.json')]);
      assert.strictEqual(r.code, 0, 'P1: client exit 0 — ' + r.buf.slice(-300));
      const ts = r.result.timestamps || {};
      const inner = r.result.result || {};
      const lat = {
        health_during_wait: ts.health_during_wait && ts.health_during_wait.latency_ms,
        takeover: ts.takeover_during_wait && ts.takeover_during_wait.latency_ms,
        botoff: ts.botoff_during_wait && ts.botoff_during_wait.latency_ms,
        change: ts.change_idea_post && ts.change_idea_post.latency_ms,
        price_post: ts.recv_price_post && ts.recv_price_post.latency_ms,
      };
      for (const [k, v] of Object.entries(lat)) assert.ok(v !== undefined && v < 300, `P1: ${k} phải < 300ms (nhận ${v}ms)`);
      // kèm bằng chứng P2/P3/P4 ở mức HTTP: reply muộn KHÔNG tới khách
      assert.strictEqual(inner.out_count, 0, 'P1/P2-4: khách nhận 0 tin bot muộn (thấy ' + inner.out_count + ')');
      assert.ok(inner.rejected.length >= 1, 'P1/P2-4: reply muộn bị gate REJECT (' + inner.rejected.join(',') + ')');
      assert.strictEqual(inner.mode, 'HUMAN', 'P1: conv ở mode HUMAN sau takeover');
      TABLE.push({ proof: 'P1(HTTP)', price_post_ms: lat.price_post, health_ms: lat.health_during_wait, takeover_ms: lat.takeover, botoff_ms: lat.botoff, change_ms: lat.change, outcome: '0 tin muộn; ' + inner.rejected.join(',') });
      return `post ${lat.price_post}ms | health ${lat.health_during_wait}ms | takeover ${lat.takeover}ms | botoff ${lat.botoff}ms | change ${lat.change}ms`;
    });
  } finally {
    await teardownHttp();
  }

  // ---------------------------------------------------------------- tổng kết
  const pass = RESULTS.filter(r => r.ok).length;
  log('\n----------------------------------------------------------------');
  for (const row of TABLE) log('  ' + JSON.stringify(row));
  log(`\nTỔNG: ${pass}/${RESULTS.length} PASS`);
  fs.writeFileSync(path.join(TRACE, 'async-gate-results.json'), JSON.stringify({ results: RESULTS, table: TABLE, at: new Date().toISOString() }, null, 2));
  log(`EXIT_CODE=${pass === RESULTS.length ? 0 : 1}`);
  process.exit(pass === RESULTS.length ? 0 : 1);
})().catch(e => {
  console.error('HARNESS_ERROR:', e);
  process.exit(1);
});
