'use strict';
// test/stability-cases.js — SURI STABILITY GATE: CA MỚI S1-S6 + CASE GUARD TIỀN (G) + CONFIG (CFG).
// Nhiệm vụ gate: đóng lỗi ổn định + kiểm soát giá. KHÔNG mở tính năng, KHÔNG nới assertion.
//
// S1: AI chậm + takeover giữa chờ  -> reply muộn REJECT (takeover), khách không nhận 2 tin.
// S2: AI chậm + bot OFF giữa chờ   -> reply muộn REJECT (bot_off).
// S3: AI chậm + khách đổi ý giữa chờ -> câu tư vấn cũ KHÔNG được gửi sau khi khách đổi ý
//     (stale-turn rejection — mitigation-b của LỖI 2; trước khi thêm detectStaleTurn case này FAIL).
// S4: 5 hội thoại đồng thời -> mỗi conv đúng reply của mình, không cross-talk, không mất tin.
// S5: crash giữa xử lý và gửi (inject như Gate-A A5) -> không gửi trùng, không tạo đơn trùng.
// S6: follow-up không mất qua restart (persist) -> chạy đúng hạn sau restart, đúng 1 lần.
// G1-G3: guard tiền bare-number/k TRÊN ĐƯỜNG BILL + CHITCHAT (LỖI 3 — trước fix LỌT ra khách).
// G4-G6: false-positive control: tổng/fee/qty/SĐT/mã đơn vẫn đi bình thường.
// CFG1: default timeout LLM = 8000ms (mitigation-a của LỖI 2 — block sync đo được = timeout).
//
// Chạy: node test/stability-cases.js — offline 100% (LLM mô phỏng bằng httpFn tiêm vào;
// delay đồng bộ dùng Atomics.wait — chặn thread như spawnSync curl, KHÔNG spin CPU).
// Exit 0 khi toàn bộ PASS.

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { App } = require('../src/app');
const aiProvider = require('../src/ai-provider');

const DATA = path.join(__dirname, '..', 'data', 'test-runs');
const FB = 'facebook';
const RESULTS = [];

// ---------------------------------------------------------------- helpers
const sleepSync = ms => {
  // chặn thread ĐỒNG BỘ ms ms (mô phỏng spawnSync curl của live-http) — Atomics.wait không spin CPU
  const ab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(ab, 0, 0, ms);
};

let pid = 0;
function msg(app, ref, text, extra = {}) {
  pid += 1;
  return app.receive({
    channel: extra.channel || FB,
    type: 'message',
    platformEventId: extra.pid || `mid-stab-${ref}-${pid}`,
    payload: {
      customer_ref: ref, thread_id: extra.thread || ref, kind: extra.kind || 'text',
      text: text || '', platform_message_id: `pm-stab-${pid}`,
    },
  });
}
const fire = (app, ref, text, extra = {}) => { msg(app, ref, text, extra); app.drain(); };
const convOf = (app, ref) => app.store.findOne('conversations', c => c.platform_thread_id === ref);
const outMsgs = (app, ref) => {
  const c = convOf(app, ref);
  return c ? app.store.findAll('messages', m => m.conversation_id === c.conversation_id && m.direction === 'out') : [];
};
const inMsgs = (app, ref) => {
  const c = convOf(app, ref);
  return c ? app.store.findAll('messages', m => m.conversation_id === c.conversation_id && m.direction === 'in') : [];
};

// LLM giả ĐỒNG BỘ chậm: onWaitStart chạy GIỮA LÚC "LLM đang nghĩ" (mô phỏng sự kiện đến
// trong cửa sổ chờ: takeover/bot-off/khách nhắn thêm), respond trả câu trả lời LLM.
function slowLLM({ delayMs, answer, onWaitStart }) {
  const calls = [];
  const fn = req => {
    calls.push(req);
    if (onWaitStart) onWaitStart(req, calls.length);
    if (delayMs) sleepSync(delayMs);
    const text = typeof answer === 'function' ? answer(req, calls.length) : answer;
    return { ok: true, status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: text } }] }) };
  };
  fn.calls = calls;
  return fn;
}

// App + LLM path bật (deepseek + key giả — mạng KHÔNG ra ngoài vì httpFn được tiêm)
function newApp(name, aiHttpFn) {
  const app = new App({ dataDir: path.join(DATA, name), aiHttpFn });
  if (aiHttpFn) aiProvider.saveAiConfig(app.settings, { provider: 'deepseek', api_key: 'sk-stab-key-0001' });
  return app;
}

async function T(id, desc, fn) {
  const t0 = Date.now();
  try {
    await fn();
    RESULTS.push({ id, desc, ok: true, note: '' });
    console.log(`  [PASS] ${id} — ${desc} (${Date.now() - t0}ms)`);
  } catch (e) {
    RESULTS.push({ id, desc, ok: false, note: String(e && e.message).split('\n')[0] });
    console.log(`  [FAIL] ${id} — ${desc}\n         -> ${String(e && e.message).split('\n').slice(0, 2).join(' | ')}`);
  }
}

// ---------------------------------------------------------------- S1
async function S1() {
  // AI chậm 5s; GIỮA LÚC CHỜ (trong window 5s) nhân viên takeover; LLM trả lời MUỘN
  // -> gate phải REJECT ở bước ghi message (re-check trong tx), khách KHÔNG nhận 2 tin.
  const convRef = 'stab-s1';
  const app = newApp('stab-s1', slowLLM({
    delayMs: 5000,
    answer: 'Dạ nến vanilla size M đỏ giá 185.000đ ạ.',
    onWaitStart: () => {
      // takeover DURING the 5s wait — cùng core mà API takeover gọi (INV-5)
      app.takeover.setTakeover(convOf(app, convRef), 'nv-hung', 'manual_test');
    },
  }));
  fire(app, convRef, 'nến vanilla size M đỏ giá bao nhiêu vậy shop');
  const outs = outMsgs(app, convRef);
  assert.strictEqual(outs.length, 0, 'S1: khách KHÔNG nhận tin bot nào sau takeover (nhận được ' + outs.length + ')');
  const prp = app.store.findAll('ai_proposals', p => p.conversation_id === convOf(app, convRef).conversation_id)
    .filter(p => p.decision === 'REJECTED_BY_GATE');
  assert.ok(prp.length >= 1, 'S1: proposal của reply muộn bị REJECTED_BY_GATE');
  const rej = app.store.findAll('audit_events', a =>
    a.conversation_id === convOf(app, convRef).conversation_id
    && String(a.execution_result || '').includes('takeover'));
  assert.ok(rej.length >= 1, 'S1: audit ghi REJECTED:takeover');
  assert.strictEqual(inMsgs(app, convRef).length, 1, 'S1: tin khách vẫn nguyên (không mất tin nhắn vào)');
  assert.strictEqual(app.metric('gate_rejected_takeover') >= 1, true, 'S1: metric gate_rejected_takeover');
}

// ---------------------------------------------------------------- S2
async function S2() {
  const convRef = 'stab-s2';
  const app = newApp('stab-s2', slowLLM({
    delayMs: 2000,
    answer: 'Dạ nến vanilla size S giá 165.000đ ạ.',
    onWaitStart: () => {
      // bot OFF giữa chờ (cùng đường /api/settings/bot off)
      app.store.transaction(() => {
        const row = app.store.findOne('settings', s => s.key === 'bot_enabled');
        app.store.updateRow('settings', row, { value: false });
      });
    },
  }));
  fire(app, convRef, 'nến vanilla size S giá bao nhiêu ạ');
  const outs = outMsgs(app, convRef);
  assert.strictEqual(outs.length, 0, 'S2: bot OFF giữa chờ -> reply muộn không đi ra');
  const rej = app.store.findAll('audit_events', a =>
    a.conversation_id === convOf(app, convRef).conversation_id
    && String(a.execution_result || '').includes('bot_off'));
  assert.ok(rej.length >= 1, 'S2: audit ghi REJECTED:bot_off');
}

// ---------------------------------------------------------------- S3
async function S3() {
  const convRef = 'stab-s3';
  const STALE_TEXT = 'Dạ nến vanilla size M đỏ giá 185.000đ bên mình nha anh/chị.';
  const app = newApp('stab-s3', slowLLM({
    delayMs: 2000,
    answer: STALE_TEXT,
    onWaitStart: () => {
      // khách ĐỔI Ý trong lúc chờ: webhook về NGAY (persist vào inbox, xếp hàng chờ xử lý)
      app.receive({
        channel: FB, type: 'message', platformEventId: 'mid-stab-s3-change',
        payload: { customer_ref: convRef, thread_id: convRef, kind: 'text', text: 'thôi bỏ đơn đi shop, đổi ý rồi', platform_message_id: 'pm-stab-s3-change' },
      });
    },
  }));
  fire(app, convRef, 'nến vanilla size M đỏ giá bao nhiêu vậy shop');
  const staleSent = outMsgs(app, convRef).filter(m => (m.text_content || '').includes('185.000'));
  assert.strictEqual(staleSent.length, 0, 'S3: câu tư vấn cũ KHÔNG được gửi sau khi khách đổi ý');
  const rej = app.store.findAll('audit_events', a =>
    String(a.execution_result || '').includes('stale_user_change'));
  assert.ok(rej.length >= 1, 'S3: gate ghi REJECTED:stale_user_change');
  // phần còn lại của hàng đợi vẫn được xử lý — khách không bị nuốt tin đổi ý
  app.drain();
  assert.ok(inMsgs(app, convRef).some(m => (m.text_content || '').includes('bỏ đơn')), 'S3: tin đổi ý của khách được ghi nhận xử lý');
}

// ---------------------------------------------------------------- S4
const S4_PRODUCTS = [
  { ref: 'stab-s4-a', text: 'nến vanilla size S giá bao nhiêu vậy shop', sku: 'NT-VANILLA-S', price: 165000 },
  { ref: 'stab-s4-b', text: 'hộp trà hoa sấy giá bao nhiêu ạ', sku: 'TRA-HOA-SEY-50', price: 145000 },
  { ref: 'stab-s4-c', text: 'combo quà tặng giá nhiêu vậy shop', sku: 'COMBO-QUA-TANG-1', price: 399000 },
  { ref: 'stab-s4-d', text: 'nến oải hương size S giá bao nhiêu', sku: 'NT-OAI-HUONG-S', price: 175000 },
  { ref: 'stab-s4-e', text: 'túi vỏ bọc nến màu đỏ giá nhiêu ạ', sku: 'TUI-VO-NEN-DO', price: 65000 },
];
async function S4() {
  // 5 khách nhắn GẦN NHƯ CÙNG LÚC (5 event vào hàng đợi rồi drain 1 lần); LLM chậm 120ms/lượt
  const answers = Object.fromEntries(S4_PRODUCTS.map(p => [p.ref, `Dạ ${p.sku} giá ${p.price}đ bên mình ạ.`]));
  let wrongSubject = 0;
  const app = newApp('stab-s4', slowLLM({
    delayMs: 120,
    answer: req => {
      // LLM "trả lời đúng theo FACTS trong prompt" — phát hiện prompt lệch subject -> đếm cross-talk
      const sys = String((JSON.parse(req.body).messages || [])[0].content || '');
      const hit = S4_PRODUCTS.find(p => sys.includes(p.sku));
      if (!hit) wrongSubject += 1;
      return hit ? answers[hit.ref] : 'Dạ bên mình có nhiều mẫu ạ.';
    },
  }));
  for (const p of S4_PRODUCTS) msg(app, p.ref, p.text); // 5 webhook tới nối tiếp
  app.drain();                                          // xử lý cả lô
  assert.strictEqual(wrongSubject, 0, 'S4: FACTS mỗi lần propose đúng subject của hội thoại đó (không cross-talk ở model layer)');
  for (const p of S4_PRODUCTS) {
    const outs = outMsgs(p.ref === S4_PRODUCTS[0].ref ? app : app, p.ref);
    assert.strictEqual(outs.length, 1, `S4: ${p.ref} đúng 1 reply bot (nhận ${outs.length})`);
    assert.ok(new RegExp('(?<![0-9])' + p.price + '(?![0-9])').test(outs[0].text_content), `S4: ${p.ref} nhận đúng giá SP của mình (${p.price})`);
    for (const other of S4_PRODUCTS) {
      if (other.ref === p.ref) continue;
      assert.ok(!new RegExp('(?<![0-9])' + other.price + '(?![0-9])').test(outs[0].text_content), `S4: ${p.ref} KHÔNG nhận giá của ${other.ref} (cross-talk)`);
    }
  }
}

// ---------------------------------------------------------------- S5
async function S5() {
  // crash NGAY SAU platform.sendMessage (như Gate-A A5) trên đường MUA HÀNG:
  // bill đã tới platform rồi process chết -> retry cùng event -> KHÔNG gửi trùng, KHÔNG 2 đơn.
  const app = new App({ dataDir: path.join(DATA, 'stab-s5') });
  const origSend = app.platform.sendMessage.bind(app.platform);
  let sends = 0;
  app.platform.sendMessage = a => {
    const r = origSend(a); // side-effect xảy ra (platform đã nhận)
    sends += 1;
    if (sends === 1) throw new Error('inject: crash sau sendMessage, trước khi commit status');
    return r;
  };
  fire(app, 'stab-s5', 'lấy 1 hộp trà hoa sấy, tên Stab, sdt 0903333444, địa chỉ 5 Stab Q1');
  assert.strictEqual(app.platform.sentCalls.length, 1, 'S5: đúng 1 external send (retry không gửi lần 2)');
  const conv = convOf(app, 'stab-s5');
  const outs = app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'out');
  assert.strictEqual(outs.length, 1, 'S5: đúng 1 tin out (bill không gửi trùng)');
  const orders = app.store.findAll('orders', o => o.conversation_id === conv.conversation_id);
  assert.strictEqual(orders.length, 1, 'S5: đúng 1 đơn (không tạo đơn trùng)');
  const execs = app.store.findAll('action_executions', e => e.action_type === 'SEND_MESSAGE');
  assert.strictEqual(new Set(execs.map(e => e.idempotency_key)).size, execs.length, 'S5: idempotency key đơn nhất');
  assert.ok(app.store.findAll('audit_events', a => a.execution_result === 'DUPLICATE_SUPPRESSED').length >= 1, 'S5: audit DUPLICATE_SUPPRESSED');
}

// ---------------------------------------------------------------- S6
async function S6() {
  // follow-up sau giao hàng lập lịch +2 ngày -> RESTART (App mới cùng dataDir, persist)
  // -> follow-up KHÔNG mất, chạy đúng hạn sau restart, đúng 1 lần.
  const dataDir = path.join(DATA, 'stab-s6');
  fs.rmSync(dataDir, { recursive: true, force: true }); // mỗi lần chạy = dữ liệu sạch
  const app1 = new App({ dataDir, persist: true });
  fire(app1, 'stab-s6', 'lấy 1 hộp trà hoa sấy, tên Stab Sau, sdt 0905556667, địa chỉ 6 Stab Q1');
  let conv = convOf(app1, 'stab-s6');
  const r = app1.orders.phaseB({ orderId: conv.draft.order_id });
  assert.ok(r.ok, 'S6: phaseB ok');
  const order = app1.store.findOne('orders', o => o.order_id === conv.draft.order_id);
  const ship = app1.orders.createShipment({ order, carrier: app1.carrier });
  app1.carrier.setStatus(ship.shipment.tracking_number, 'DELIVERED');
  app1.pipeline.onCarrierStatus(order.order_id);
  const fuBefore = app1.store.findOne('follow_ups', f => f.order_id === order.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
  assert.ok(fuBefore && fuBefore.status === 'SCHEDULED', 'S6: follow-up đã lập SCHEDULED trước restart');

  // ---- RESTART ----
  const app2 = new App({ dataDir, persist: true });
  const fuAfter = app2.store.findOne('follow_ups', f => f.follow_up_id === fuBefore.follow_up_id);
  assert.ok(fuAfter, 'S6: follow-up còn nguyên qua restart (persist)');
  assert.strictEqual(fuAfter.status, 'SCHEDULED', 'S6: chưa gửi trước hạn');
  assert.strictEqual(app2.store.findAll('messages', m => m.conversation_id === fuAfter.conversation_id && m.sender !== 'customer').length,
    app1.store.findAll('messages', m => m.conversation_id === fuAfter.conversation_id && m.sender !== 'customer').length,
    'S6: không có tin nào gửi thêm lúc restart');

  // ---- đến hạn sau restart: khách nhắn lại mở cửa sổ (nếu bị HELD vì window) -> đúng hạn 1 follow-up ----
  app2.clock.advance(app2.clock.now() + 46 * 3600 * 1000);
  app2.drain({ horizonMs: 0 });
  msg(app2, 'stab-s6', 'shop ơi gói hàng dùng ổn không ạ');
  app2.drain({ horizonMs: 0 });
  app2.clock.advance(app2.clock.now() + 4 * 3600 * 1000); // vượt scheduled_at (+2 ngày từ lúc tạo)
  app2.drain({ horizonMs: 0 });
  app2.clock.advance(app2.clock.now() + 30 * 1000); // chờ receipt platform nâng trạng thái
  app2.drain({ horizonMs: 0 });
  const fu = app2.store.findOne('follow_ups', f => f.follow_up_id === fuBefore.follow_up_id);
  assert.ok(['SENT', 'PENDING_RECEIPT', 'DELIVERED'].includes(fu.status), 'S6: follow-up chạy đúng hạn sau restart (status ' + fu.status + '/' + (fu.cancel_reason || '') + ')');
  const careMsgs = app2.store.findAll('audit_events', a => a.proposed_action === 'FOLLOW_UP:AFTER_DELIVERY_FEEDBACK' && a.stage === 'EXECUTED' && a.execution_result === 'SENT');
  assert.ok(careMsgs.length >= 1, 'S6: audit EXECUTED/SENT cho follow-up');
  // không gửi trùng: idemScope follow_up:<id> — chạy scheduler lần nữa vẫn 1 tin care
  app2.clock.advance(app2.clock.now() + 3600 * 1000);
  app2.drain({ horizonMs: 0 });
  const execCount = app2.store.findAll('action_executions', e => e.idempotency_key === `send:${fuAfter.conversation_id}:follow_up:${fuAfter.follow_up_id}`).length;
  assert.strictEqual(execCount, 1, 'S6: đúng 1 execution cho follow-up (không gửi trùng qua restart)');
}

// ---------------------------------------------------------------- G1-G6 (guard tiền — LỖI 3)
function gSetup(name) {
  const app = new App({ dataDir: path.join(DATA, name) }); // stub AI — kiểm đúng lớp guard
  fire(app, 'g-cust', 'nến vanilla size M đỏ còn không shop');
  const conv = convOf(app, 'g-cust');
  conv.subject_sku = 'NT-VANILLA-M-DO';
  const customer = app.store.findOne('customers', c => c.platform_ref === 'g-cust');
  const product = app.productDB.getProductByBase('NT-VANILLA');
  const facts = {
    subjectProduct: { name: 'Nến thơm vanilla', sku: 'NT-VANILLA' },
    variants: product.variants.map(v => ({ sku: v.sku, size: v.size, color: v.color, price: v.price, effective: 5 })),
  };
  let n = 0;
  return { app, conv, customer, facts, send(intent, text, extra = {}) {
    n += 1;
    const event = { event_id: `facebook:g-evt-${n}`, payload: { platform_message_id: 'pm-g-' + n } };
    const proposal = Object.assign({
      intent, text, confidence: 0.85, engine: 'deepseek',
      evidence: { source: 'ai_provider:deepseek', facts_source: 'product_db' }, facts,
    }, extra);
    return app.gate.sendReply({ conversation: conv, customer, event, proposal });
  } };
}

async function G1() { // bill: tổng tiền bare KHÔNG đơn vị, không khớp đơn -> phải bị đè
  const g = gSetup('stab-g1');
  const r = g.send('ORDER_DRAFT', 'Dạ đơn của anh/chị như sau ạ:\n- 1 x Trà hoa sấy\nTổng tiền 92500 nha anh/chị ạ.', { allowedMoney: [170000, 145000, 25000] });
  assert.strictEqual(r.decision, 'OVERRIDDEN', 'G1: bill "Tổng tiền 92500" (bare) phải OVERRIDDEN — nhận ' + r.decision);
  assert.ok(!r.text.includes('92500'), 'G1: text tới khách không còn số bịa');
}
async function G2() { // bill: "còn 92.5k" -> phải bị đè
  const g = gSetup('stab-g2');
  const r = g.send('ORDER_CONFIRMED', 'Dạ đơn đã xác nhận, tổng còn 92.5k anh/chị nhé ạ!', { allowedMoney: [170000, 145000, 25000] });
  assert.strictEqual(r.decision, 'OVERRIDDEN', 'G2: bill "còn 92.5k" phải OVERRIDDEN — nhận ' + r.decision);
  assert.ok(!r.text.includes('92.5k'), 'G2: text tới khách không còn "92.5k"');
}
async function G3() { // CHITCHAT: "giá 92500" (LLM wording) -> phải bị đè
  const g = gSetup('stab-g3');
  const r = g.send('CHITCHAT', 'Dạ mẫu đó bên em có giá 92500 luôn anh/chị ạ!');
  assert.strictEqual(r.decision, 'OVERRIDDEN', 'G3: CHITCHAT "giá 92500" phải OVERRIDDEN — nhận ' + r.decision);
}
async function G4() { // false-positive control: bill ĐÚNG (tổng bare khớp whitelist + fee + units) đi bình thường
  const g = gSetup('stab-g4');
  const money = [170000, 145000, 25000];
  let r = g.send('ORDER_DRAFT', 'Dạ đơn của anh/chị như sau ạ:\n- 1 x Trà hoa sấy: 145.000đ\nPhí ship: 25.000đ\nTổng cộng: 170.000đ\nAnh/chị xác nhận giúp em nha ạ!', { allowedMoney: money });
  assert.strictEqual(r.decision, 'AUTO_EXECUTED', 'G4a: bill đúng có đơn vị -> không bị đè');
  r = g.send('ORDER_DRAFT', 'Dạ đơn giữ chỗ rồi nha, tổng tiền 170000 anh/chị nhé ạ!', { allowedMoney: money });
  assert.strictEqual(r.decision, 'AUTO_EXECUTED', 'G4b: tổng bare NHƯNG KHỚP whitelist -> không bị đè (nhận ' + r.decision + ')');
}
async function G5() { // false-positive control: qty + confirm text thường
  const g = gSetup('stab-g5');
  let r = g.send('BUY_ASK', 'Dạ em ghi nhận 3 x Nến thơm vanilla nhé ạ! anh/chị cho em xin SĐT để xác nhận đơn nha ạ.', { evidence: { missing: ['phone'] } });
  assert.strictEqual(r.decision, 'AUTO_EXECUTED', 'G5a: text có qty 1-99 -> không đè (nhận ' + r.decision + ')');
  r = g.send('ORDER_CONFIRMED', 'Dạ đơn ORD5_86033D của anh/chị đã được xác nhận, tổng 170.000đ. Mã vận đơn: MOCK-ORD5_86033D nha ạ!', { allowedMoney: [170000] });
  assert.strictEqual(r.decision, 'AUTO_EXECUTED', 'G5b: mã đơn (chữ số lẫn) không bị guard đọc thành tiền (nhận ' + r.decision + ')');
}
async function G6() { // SĐT đã mask + PRICE intent đúng giá vẫn qua
  const g = gSetup('stab-g6');
  let r = g.send('PRICE', 'Dạ size M đỏ giá 185000 nhé anh/chị ạ!');
  assert.strictEqual(r.decision, 'AUTO_EXECUTED', 'G6a: giá ĐÚNG bare trên intent PRICE -> allowed (nhận ' + r.decision + ')');
  r = g.send('PRICE', 'Dạ bên em đang có GIÁ SỐC chỉ 92500 cho nến vanilla nha anh/chị ạ!');
  assert.strictEqual(r.decision, 'OVERRIDDEN', 'G6b: giá bịa bare trên PRICE -> OVERRIDDEN');
  r = g.send('PRICE', 'Dạ chỉ còn 92.5k thôi anh/chị ơi!');
  assert.strictEqual(r.decision, 'OVERRIDDEN', 'G6c: giá bịa dạng k -> OVERRIDDEN');
}
async function G7() { // [chốt local — JEV THẤP-3] số nhà + mã đơn đuôi HOA không phải tiền
  const g = gSetup('stab-g7');
  let r = g.send('ORDER_CONFIRMED', 'Dạ đã ghi nhận giao đến số nhà 25 đường 86033D nha anh/chị!', { allowedMoney: [170000] });
  assert.strictEqual(r.decision, 'AUTO_EXECUTED', 'G7a: số nhà + mã đuôi hoa D KHÔNG thành tiền (nhận ' + r.decision + ')');
  r = g.send('ORDER_CONFIRMED', 'Đơn ORD7_92500K đã giao successful, tổng 170.000đ nha anh/chị!', { allowedMoney: [170000] });
  assert.strictEqual(r.decision, 'AUTO_EXECUTED', 'G7b: mã đuôi hoa K cũng không thành tiền (nhận ' + r.decision + ')');
}

// ---------------------------------------------------------------- CFG1 (LỖI 2 mitigation-a)
async function CFG1() {
  const app = new App({ dataDir: path.join(DATA, 'stab-cfg1') });
  aiProvider.saveAiConfig(app.settings, { provider: 'deepseek', api_key: 'sk-cfg-0001' });
  const cfg = aiProvider.getAiConfig(app.settings);
  assert.strictEqual(cfg.timeout, 8000, 'CFG1: default timeout LLM = 8000ms (block sync đo được = timeout — 20s cũ quá dài)');
  // shop tự cấu hình -> giữ nguyên giá trị shop chọn
  aiProvider.saveAiConfig(app.settings, { provider: 'deepseek', api_key: 'sk-cfg-0001', timeout: 12000 });
  assert.strictEqual(aiProvider.getAiConfig(app.settings).timeout, 12000, 'CFG1: shop cấu hình rõ vẫn được tôn trọng');
}

// ---------------------------------------------------------------- main
(async function main() {
  console.log('===== SURI STABILITY CASES (S1-S6 + G + CFG) — offline =====');
  await T('S1', 'AI chậm 5s + takeover giữa chờ -> reply muộn REJECT (takeover), khách không nhận 2 tin', S1);
  await T('S2', 'AI chậm + bot OFF giữa chờ -> reply muộn REJECT (bot_off)', S2);
  await T('S3', 'AI chậm + khách đổi ý giữa chờ -> câu tư vấn cũ không được gửi (stale_user_change)', S3);
  await T('S4', '5 hội thoại đồng thời -> đúng reply của mình, không cross-talk, không mất tin', S4);
  await T('S5', 'crash giữa xử lý và gửi -> không gửi trùng, không tạo đơn trùng', S5);
  await T('S6', 'follow-up persist qua restart -> chạy đúng hạn, đúng 1 lần', S6);
  await T('G1', 'bill "Tổng tiền 92500" (bare) -> OVERRIDDEN', G1);
  await T('G2', 'bill "còn 92.5k" -> OVERRIDDEN', G2);
  await T('G3', 'CHITCHAT "giá 92500" -> OVERRIDDEN', G3);
  await T('G4', 'FP-control: bill đúng (units + tổng bare khớp whitelist) -> AUTO_EXECUTED', G4);
  await T('G5', 'FP-control: qty + mã đơn ORD5_86033D -> AUTO_EXECUTED', G5);
  await T('G6', 'PRICE: đúng giá bare allowed; giá bịa bare/k -> OVERRIDDEN', G6);
  await T('G7', 'FP-control: số nhà + mã đuôi HOA (86033D / 92500K) -> không thành tiền', G7);
  await T('CFG1', 'default timeout LLM 8000ms; shop override được tôn trọng', CFG1);

  const failed = RESULTS.filter(r => !r.ok);
  console.log(`\nTỔNG: ${RESULTS.length - failed.length}/${RESULTS.length} PASS (SURI-STABILITY)`);
  if (failed.length) {
    console.log('---- FAIL ----');
    for (const f of failed) console.log(`  ${f.id}: ${f.desc}\n    -> ${f.note}`);
  }
  console.log(failed.length === 0 ? '==> STABILITY: TOÀN BỘ PASS.' : '==> CÒN FAIL.');
  const code = failed.length === 0 ? 0 : 1;
  console.log(`EXIT_CODE=${code}`);
  process.exitCode = code;
  await new Promise(r => setTimeout(r, 100));
  // eslint-disable-next-line no-process-exit
  process.exit(code);
})().catch(e => { console.error('[fatal]', e); process.exitCode = 1; });
