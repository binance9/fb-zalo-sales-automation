'use strict';
// test/gate-a.js — BATTERY MỚI GATE A (P3A): DATA / SAFETY FOUNDATION.
// Đóng và CHỨNG MINH đúng 3 blocker của BAO-CAO-HOI-DONG-V2.md Phần A.2:
//   BL-3 — PII không được lọt vào model context (A1, A2 — 4 path: BUY/CHITCHAT/AFTER_SALES/CLAIM)
//   BL-8 — actor=system không bypass HUMAN/opt-out; chỉ đi qua whitelist SYSTEM_TEMPLATES (A3, A4)
//   BL-9 — retry/crash không sinh duplicate side-effect; idem key EVENT-SCOPED, không text-derived (A5, A6, A7)
// Mọi expectation ghi ĐÚNG hành vi mong muốn — KHÔNG mock che lỗi, KHÔNG nới expectation.
// Exit 0 khi 7/7 PASS.

const path = require('path');
const assert = require('assert');
const { App } = require('../src/app');
const { renderSystemTemplate } = require('../src/system-templates');

const DATA = path.join(__dirname, '..', 'data', 'test-runs');
const FB = 'facebook';
const dir = name => path.join(DATA, name);

// Fixture PII test (khớp pattern kiểm: SĐT VN 0/84 + 9-10 số, tên, địa chỉ, token)
const FIX = {
  name: 'Anh Bảo',
  phone: '0901111222',
  address: '12 Nguyễn Trãi Q1 TP.HCM',
  token: 'zcdn-token',
};
const RE_VN_PHONE = /(?:\+?84|0)(?:3|5|7|8|9)(?:[.\-\s]?\d){8,9}(?!\d)/;

let pid = 0;
function msg(app, channel, ref, text, extra = {}) {
  pid += 1;
  return app.receive({
    channel,
    type: 'message',
    platformEventId: extra.pid || `mid-ga-${ref}-${pid}`,
    payload: {
      customer_ref: ref,
      thread_id: extra.thread || ref,
      kind: extra.kind || 'text',
      text: text || '',
      media: extra.media,
      platform_message_id: `pm-ga-${pid}`,
    },
  });
}

const convOf = (app, ref) => app.store.findOne('conversations', c => c.platform_thread_id === ref);
const cusOf = (app, ref) => app.store.findOne('customers', c => c.platform_ref === ref);
const outMsgs = (app, ref) => {
  const conv = convOf(app, ref);
  return conv ? app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'out') : [];
};

// Bắt MỌI thứ được đưa vào model (ai.propose) — đây chính là "model context" của Gate A
function captureModelCtx(app) {
  const captured = [];
  const orig = app.ai.propose.bind(app.ai);
  app.ai.propose = (intent, ctx) => {
    captured.push({ intent, ctx });
    return orig(intent, ctx);
  };
  return captured;
}

// BL-3: ctx hợp phép cho model — CHỈ những key này (conv/customer/draft.slots/token CẤM)
const ALLOWED_CTX_KEYS = new Set(['state', 'mode', 'subject_sku', 'text', 'normText', 'facts', 'draftMissing']);

function assertCtxClean(captured, label) {
  assert.ok(captured.length >= 1, `${label}: phải có ít nhất 1 lần model được gọi (test không vacuous)`);
  for (const c of captured) {
    const s = JSON.stringify(c.ctx);
    assert.ok(!RE_VN_PHONE.test(s), `${label} [${c.intent}]: model ctx CHỨA SỐ ĐIỆN THOẠI`);
    assert.ok(!s.includes(FIX.name), `${label} [${c.intent}]: model ctx CHỨA TÊN khách`);
    assert.ok(!s.includes('Nguyễn Trãi'), `${label} [${c.intent}]: model ctx CHỨA ĐỊA CHỈ khách`);
    assert.ok(!s.includes(FIX.token), `${label} [${c.intent}]: model ctx CHỨA TOKEN`);
    assert.ok(!('conv' in (c.ctx || {})), `${label} [${c.intent}]: model ctx chứa object conv nguyên vẹn (BL-3)`);
    for (const k of Object.keys(c.ctx || {})) {
      assert.ok(ALLOWED_CTX_KEYS.has(k), `${label} [${c.intent}]: key ctx không hợp phép "${k}"`);
    }
  }
}

function buyAndConfirm(app, ref) {
  msg(app, FB, ref, `lấy 1 nến vanilla M đỏ, tên ${FIX.name}, sdt ${FIX.phone}, địa chỉ ${FIX.address}`);
  app.drain();
  msg(app, FB, ref, 'xác nhận');
  app.drain();
  const conv = convOf(app, ref);
  const orders = app.store.findAll('orders', o => o.conversation_id === conv.conversation_id && o.status === 'CONFIRMED');
  assert.ok(orders.length >= 1, `buyAndConfirm(${ref}): chưa có đơn CONFIRMED`);
  return orders[orders.length - 1];
}

// ============================================================ A1 — BL-3 BUY path
function A1() {
  const app = new App({ dataDir: dir('gate-a1') });
  const captured = captureModelCtx(app);
  // BUY thiếu địa chỉ -> luồng BUY_ASK propose; text khách chứa TÊN + SĐT (PII thật)
  msg(app, FB, 'fb-ga1', `lấy 1 nến vanilla M đỏ, tên ${FIX.name}, sdt ${FIX.phone}`);
  app.drain();

  assertCtxClean(captured, 'A1 BUY');
  // model ctx có state đúng (COLLECT_ORDER) — chứng minh ctx trắng vẫn đủ nghiệp vụ
  const ask = captured.find(c => c.intent === 'BUY_ASK');
  assert.ok(ask, 'A1: có propose BUY_ASK');
  assert.strictEqual(ask.ctx.state, 'COLLECT_ORDER', 'A1: ctx.state = COLLECT_ORDER');
  assert.deepStrictEqual(ask.ctx.draftMissing, ['address'], 'A1: draftMissing chỉ tên trường, không giá trị PII');
  // hành vi nghiệp vụ giữ nguyên: hỏi đúng trường thiếu
  const outs = outMsgs(app, 'fb-ga1');
  assert.strictEqual(outs.length, 1, 'A1: đúng 1 tin out');
  assert.ok(outs[0].text_content.includes('địa chỉ'), 'A1: hỏi đúng trường thiếu');
  // PII không lọt qua proposal đã lưu (wording của model không chứa PII)
  for (const p of app.store.findAll('ai_proposals', x => x.intent === 'BUY_ASK')) {
    const pj = p.proposal_json || '';
    assert.ok(!pj.includes(FIX.phone), 'A1: proposal_json chứa SĐT');
    assert.ok(!pj.includes(FIX.name), 'A1: proposal_json chứa tên khách');
  }
}

// ============================================================ A2 — BL-3 CHITCHAT / AFTER_SALES / CLAIM path
function A2() {
  // ---- CHITCHAT: text khách chứa ĐỦ PII -> ctx sạch; chitchat thậm chí KHÔNG forward text cho model ----
  const app = new App({ dataDir: dir('gate-a2a') });
  let captured = captureModelCtx(app);
  msg(app, FB, 'fb-ga2', `hello shop, mình là ${FIX.name}, sdt ${FIX.phone}, địa chỉ ${FIX.address}`);
  app.drain();
  assertCtxClean(captured, 'A2 CHITCHAT');
  assert.strictEqual(captured[0].ctx.text, '', 'A2 CHITCHAT: model ctx.text rỗng (context tối thiểu)');

  // ---- PRICE (path routeInfo forward text): PII trong câu hỏi phải bị REDACT trước model ----
  const appP = new App({ dataDir: dir('gate-a2p') });
  captured = captureModelCtx(appP);
  msg(appP, FB, 'fb-ga2p', `giá nến vanilla size M bao nhiêu? mình là ${FIX.name}, sdt ${FIX.phone}, giao đến ${FIX.address}`);
  appP.drain();
  assertCtxClean(captured, 'A2 PRICE');
  const pctx = captured[0].ctx.text;
  assert.strictEqual(pctx.includes('[SDT]'), true, 'A2 PRICE: SĐT đã redact thành [SDT]');
  assert.strictEqual(pctx.includes('[TEN]'), true, 'A2 PRICE: tên đã redact thành [TEN]');
  assert.strictEqual(pctx.includes('[DIA_CHI]'), true, 'A2 PRICE: địa chỉ đã redact thành [DIA_CHI]');

  // ---- AFTER_SALES: mua -> chốt -> DELIVERED -> chitchat sau bán ----
  const app2 = new App({ dataDir: dir('gate-a2b') });
  captured = captureModelCtx(app2);
  const order = buyAndConfirm(app2, 'fb-ga2b');
  const shipment = app2.store.findOne('shipments', s => s.order_id === order.order_id);
  app2.carrier.setStatus(shipment.tracking_number, 'DELIVERED');
  app2.pipeline.onCarrierStatus(order.order_id);
  assert.strictEqual(convOf(app2, 'fb-ga2b').state, 'AFTER_SALES', 'A2: state AFTER_SALES');
  msg(app2, FB, 'fb-ga2b', 'hello shop');
  app2.drain();
  assertCtxClean(captured, 'A2 AFTER_SALES');
  assert.strictEqual(captured[captured.length - 1].ctx.state, 'AFTER_SALES', 'A2: model ctx.state = AFTER_SALES');

  // ---- CLAIM: khiếu nại kèm PII -> KHÔNG có gì đưa vào model; chỉ system template whitelist ----
  const app3 = new App({ dataDir: dir('gate-a2c') });
  buyAndConfirm(app3, 'fb-ga2c');
  const sentBefore = app3.platform.sentCalls.length;
  captured = captureModelCtx(app3);
  msg(app3, FB, 'fb-ga2c', `đơn 2 tuần rồi chưa thấy, tôi là ${FIX.name}, sdt ${FIX.phone}, địa chỉ ${FIX.address}, lừa đảo quá!`);
  app3.drain();
  assert.strictEqual(captured.length, 0, 'A2 CLAIM: KHÔNG có ctx nào đưa vào model trong luồng khiếu nại');
  const conv3 = convOf(app3, 'fb-ga2c');
  assert.strictEqual(conv3.mode, 'HUMAN', 'A2 CLAIM: mode HUMAN');
  const outs3 = outMsgs(app3, 'fb-ga2c');
  assert.strictEqual(outs3.length, sentBefore + 1, 'A2 CLAIM: đúng 1 tin out (template an ủi)');
  const t3 = outs3[outs3.length - 1].text_content;
  assert.ok(t3.includes('xin lỗi'), 'A2 CLAIM: template an ủi');
  assert.ok(!RE_VN_PHONE.test(t3) && !t3.includes(FIX.name) && !t3.includes('Nguyễn Trãi'), 'A2 CLAIM: tin out không chứa PII');
  const prpAck = app3.store.findOne('ai_proposals', p => p.intent === 'COMPLAINT_ACK');
  assert.ok(prpAck, 'A2 CLAIM: có proposal COMPLAINT_ACK');
  const authAudit = app3.store.findAll('audit_events', a => a.stage === 'AUTHORIZED' && a.execution_result === 'AUTHORIZED' && a.validation && a.validation.template_id === 'COMPLAINT_ACK');
  assert.ok(authAudit.length >= 1, 'A2 CLAIM: audit AUTHORIZED ghi template_id');
  assert.strictEqual(authAudit[0].validation.actor, 'system', 'A2 CLAIM: audit ghi actor=system');
  assert.strictEqual(authAudit[0].validation.mode, 'HUMAN', 'A2 CLAIM: audit ghi mode=HUMAN');
}

// ============================================================ A3 — BL-8 system bypass HUMAN -> REJECT
function A3() {
  const app = new App({ dataDir: dir('gate-a3') });
  msg(app, FB, 'fb-ga3', 'nến vanilla giá bao nhiêu?');
  app.drain();
  const conv = convOf(app, 'fb-ga3');
  const cus = cusOf(app, 'fb-ga3');
  app.takeover.setTakeover(conv, 'op1', 'operator_request');
  assert.strictEqual(conv.mode, 'HUMAN');
  const sentBefore = app.platform.sentCalls.length; // tin PRICE hợp lệ trước takeover

  // Probe cũ của báo cáo V2 (BL-8): mode HUMAN + actor=system + msgKind=ai_reply + text tự do
  const r = app.gate.sendReply({
    conversation: conv, customer: cus, event: null,
    proposal: {
      intent: 'PROMO_BLAST', msgKind: 'ai_reply', sender: 'system',
      text: 'KHUYEN MAI SOC 50% CHI HOM NAY!!!', evidence: { source: 'internal_tool' }, confidence: 0.99,
    },
  });
  assert.strictEqual(r.sent, false, 'A3: system + ai_reply text tự do phải bị REJECT');
  assert.strictEqual(r.reason, 'system_ai_reply', 'A3: reason system_ai_reply (REJECT tuyệt đối)');
  assert.strictEqual(r.decision, 'REJECTED_BY_GATE', 'A3: decision REJECTED_BY_GATE');
  assert.strictEqual(app.platform.sentCalls.length, sentBefore, 'A3: KHÔNG tin mới nào ra ngoài');
  assert.ok(app.metric('gate_rejected_system_ai_reply') >= 1, 'A3: metric gate_rejected_system_ai_reply++');

  // Caller internal tự gắn sender=system + kind transactional NHƯNG không có template_id -> vẫn REJECT
  const r2 = app.gate.sendReply({
    conversation: conv, customer: cus, event: null,
    proposal: {
      intent: 'INTERNAL_NOTE', msgKind: 'transactional', sender: 'system',
      text: 'Xac nhan thong tin tu do khong thuoc template nao', evidence: { source: 'internal_tool' }, confidence: 1,
    },
  });
  assert.strictEqual(r2.sent, false, 'A3: system text tự do (kể cả transactional) phải REJECT');
  assert.strictEqual(r2.reason, 'system_template_unknown', 'A3: reason system_template_unknown');
  assert.strictEqual(app.platform.sentCalls.length, sentBefore, 'A3: vẫn không có tin mới');

  // audit REJECT ghi đủ template_id + actor + mode + result
  const rej = app.store.findAll('audit_events', a => a.stage === 'AUTHORIZED' && a.execution_result === 'REJECTED:system_ai_reply').pop();
  assert.ok(rej, 'A3: có audit REJECT');
  assert.strictEqual(rej.validation.actor, 'system', 'A3: audit actor=system');
  assert.strictEqual(rej.validation.mode, 'HUMAN', 'A3: audit mode=HUMAN');
  assert.strictEqual(rej.validation.template_id, null, 'A3: audit template_id=null');
  assert.strictEqual(rej.validation.decision, 'REJECT', 'A3: audit authorize_result=REJECT');
}

// ============================================================ A4 — BL-8 valid system template -> AUTHORIZED
function A4() {
  const app = new App({ dataDir: dir('gate-a4') });
  msg(app, FB, 'fb-ga4', 'nến vanilla giá bao nhiêu?');
  app.drain();
  const conv = convOf(app, 'fb-ga4');
  const cus = cusOf(app, 'fb-ga4');
  app.takeover.setTakeover(conv, 'op1', 'operator_request');
  const sentBefore = app.platform.sentCalls.length; // tin PRICE hợp lệ trước takeover

  // template hợp lệ ACK_DLQ (render từ whitelist) trong mode HUMAN -> AUTHORIZED
  const text = renderSystemTemplate('ACK_DLQ');
  const r = app.gate.sendReply({
    conversation: conv, customer: cus, event: null,
    proposal: {
      intent: 'DLQ_ACK', msgKind: 'transactional', sender: 'system', template_id: 'ACK_DLQ',
      text, evidence: { policy: 'ack_dlq', template_id: 'ACK_DLQ' }, confidence: 1,
    },
  });
  assert.strictEqual(r.sent, true, 'A4: system template hợp lệ -> AUTHORIZED + gửi');
  assert.strictEqual(r.text, text, 'A4: text đi ra khớp render whitelist');
  assert.strictEqual(app.platform.sentCalls.length, sentBefore + 1, 'A4: đúng thêm 1 platform call cho template');
  const allow = app.store.findAll('audit_events', a => a.stage === 'AUTHORIZED' && a.execution_result === 'AUTHORIZED').pop();
  assert.ok(allow, 'A4: có audit AUTHORIZED');
  assert.strictEqual(allow.validation.template_id, 'ACK_DLQ', 'A4: audit ghi template_id=ACK_DLQ');
  assert.strictEqual(allow.validation.actor, 'system', 'A4: audit actor=system');
  assert.strictEqual(allow.validation.mode, 'HUMAN', 'A4: audit mode=HUMAN');
  assert.strictEqual(allow.validation.decision, 'ALLOW', 'A4: audit authorize_result=ALLOW');

  // Cùng template_id NHƯNG gắn msgKind=ai_reply -> REJECT tuyệt đối (system + ai_reply)
  const r2 = app.gate.sendReply({
    conversation: conv, customer: cus, event: null,
    proposal: {
      intent: 'DLQ_ACK', msgKind: 'ai_reply', sender: 'system', template_id: 'ACK_DLQ',
      text, evidence: { policy: 'ack_dlq', template_id: 'ACK_DLQ' }, confidence: 1,
    },
  });
  assert.strictEqual(r2.sent, false, 'A4: system + ai_reply = REJECT tuyệt đối dù có template_id');
  assert.strictEqual(r2.reason, 'system_ai_reply', 'A4: reason system_ai_reply');
  assert.strictEqual(app.platform.sentCalls.length, sentBefore + 1, 'A4: không có call mới');

  // template_id hợp lệ NHƯNG text KHÔNG render từ bảng -> REJECT (chặn thay nội dung template)
  const r3 = app.gate.sendReply({
    conversation: conv, customer: cus, event: null,
    proposal: {
      intent: 'DLQ_ACK', msgKind: 'transactional', sender: 'system', template_id: 'ACK_DLQ',
      text: 'Text tự do mượn danh template ACK_DLQ', evidence: { policy: 'ack_dlq', template_id: 'ACK_DLQ' }, confidence: 1,
    },
  });
  assert.strictEqual(r3.sent, false, 'A4: text không khớp render whitelist -> REJECT');
  assert.strictEqual(r3.reason, 'system_template_text', 'A4: reason system_template_text');
  assert.strictEqual(app.platform.sentCalls.length, sentBefore + 1, 'A4: vẫn chỉ 1 platform call cho template');
}

// ============================================================ A5 — BL-9 crash SAU sendMessage -> retry -> đúng 1 send
function A5() {
  const app = new App({ dataDir: dir('gate-a5') });
  const origSend = app.platform.sendMessage.bind(app.platform);
  let sends = 0;
  app.platform.sendMessage = (a) => {
    const r = origSend(a); // platform ĐÃ nhận tin (side-effect xảy ra)
    sends += 1;
    if (sends === 1) throw new Error('inject: crash NGAY SAU sendMessage, TRƯỚC khi commit status');
    return r;
  };
  msg(app, FB, 'fb-ga5', 'nến vanilla giá bao nhiêu?');
  app.drain(); // crash -> gateway re-queue -> retry cùng event_id

  assert.strictEqual(app.platform.sentCalls.length, 1, 'A5: đúng 1 external send (không gửi lần 2)');
  const outs = outMsgs(app, 'fb-ga5');
  assert.strictEqual(outs.length, 1, 'A5: đúng 1 tin out');
  assert.strictEqual(new Set(outs.map(m => m.text_content)).size, 1, 'A5: không có 2 nội dung khác nhau');
  const execs = app.store.findAll('action_executions', e => e.action_type === 'SEND_MESSAGE');
  assert.strictEqual(execs.length, 1, 'A5: đúng 1 action_executions row');
  assert.strictEqual(new Set(execs.map(e => e.idempotency_key)).size, 1, 'A5: đúng 1 idempotency key (event-scoped)');
  assert.strictEqual(execs[0].status, 'DONE', 'A5: retry bù trạng thái DONE từ receipt (không treo INTENT)');
  assert.ok(app.store.findAll('audit_events', a => a.execution_result === 'DUPLICATE_SUPPRESSED').length >= 1, 'A5: audit ghi DUPLICATE_SUPPRESSED');
  const inbox = app.store.findOne('inbox_events', e => e.event_id && e.event_id.startsWith('facebook:mid-ga-fb-ga5'));
  assert.strictEqual(inbox.status, 'PROCESSED', 'A5: event hoàn tất sau retry');
}

// ============================================================ A6 — BL-9 crash SAU DB insert -> retry -> đúng 1 logical row
function A6() {
  // (B) crash sau insert INBOUND row, trước khi handler complete
  const app = new App({ dataDir: dir('gate-a6b') });
  const origIns = app.store.insert.bind(app.store);
  let threwB = false;
  app.store.insert = (col, row) => {
    const r = origIns(col, row);
    if (!threwB && col === 'messages' && row.direction === 'in' && !r.duplicate) {
      threwB = true; // row ĐÃ ghi xong (side-effect dữ liệu xảy ra) rồi mới crash
      throw new Error('inject: crash sau insert inbound row, trước khi handler complete');
    }
    return r;
  };
  msg(app, FB, 'fb-ga6', 'nến vanilla giá bao nhiêu?');
  app.drain();
  const conv = convOf(app, 'fb-ga6');
  assert.strictEqual(app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'in').length, 1, 'A6-B: inbound logical row = 1');
  assert.strictEqual(app.store.findAll('ai_proposals', p => p.conversation_id === conv.conversation_id).length, 1, 'A6-B: proposal logical row = 1');
  assert.strictEqual(app.platform.sentCalls.length, 1, 'A6-B: đúng 1 external send');
  assert.strictEqual(outMsgs(app, 'fb-ga6').length, 1, 'A6-B: đúng 1 tin out');

  // (C) crash sau insert AI_PROPOSAL, trước ACK/send
  const app2 = new App({ dataDir: dir('gate-a6c') });
  const origIns2 = app2.store.insert.bind(app2.store);
  let threwC = false;
  app2.store.insert = (col, row) => {
    const r = origIns2(col, row);
    if (!threwC && col === 'ai_proposals' && !r.duplicate) {
      threwC = true; // proposal ĐÃ ghi xong rồi mới crash
      throw new Error('inject: crash sau insert ai_proposal, trước ACK');
    }
    return r;
  };
  msg(app2, FB, 'fb-ga6c', 'nến vanilla giá bao nhiêu?');
  app2.drain();
  const conv2 = convOf(app2, 'fb-ga6c');
  const prps = app2.store.findAll('ai_proposals', p => p.conversation_id === conv2.conversation_id);
  assert.strictEqual(prps.length, 1, 'A6-C: proposal logical row = 1 (turn_key dedupe)');
  assert.strictEqual(prps[0].decision, 'AUTO_EXECUTED', 'A6-C: proposal row tái sử dụng, decision ghi đủ');
  assert.strictEqual(app2.platform.sentCalls.length, 1, 'A6-C: đúng 1 external send');
  assert.strictEqual(outMsgs(app2, 'fb-ga6c').length, 1, 'A6-C: đúng 1 tin out');
  assert.strictEqual(app2.store.findAll('messages', m => m.conversation_id === conv2.conversation_id && m.direction === 'in').length, 1, 'A6-C: inbound row = 1');
}

// ============================================================ A7 — BL-9 generator sinh text KHÁC giữa 2 lần retry
// -> idempotency identity KHÔNG đổi (key event/intent-scoped, KHÔNG text-scoped)
function A7() {
  const app = new App({ dataDir: dir('gate-a7') });
  // "generator" thật: mỗi lần propose sinh text KHÁC (như LLM thật)
  const genTexts = [];
  const origPropose = app.ai.propose.bind(app.ai);
  let gen = 0;
  app.ai.propose = (intent, ctx) => {
    const p = origPropose(intent, ctx);
    gen += 1;
    const varied = `${p.text} [bien the sinh ${gen}]`;
    genTexts.push(varied);
    return { ...p, text: varied };
  };
  // crash sau sendMessage như A5 -> bắt buộc có retry -> generator chạy lần 2
  const origSend = app.platform.sendMessage.bind(app.platform);
  let sends = 0;
  app.platform.sendMessage = (a) => {
    const r = origSend(a);
    sends += 1;
    if (sends === 1) throw new Error('inject: crash sau sendMessage (lần 1)');
    return r;
  };
  msg(app, FB, 'fb-ga7', 'nến vanilla giá bao nhiêu?');
  app.drain();

  assert.ok(genTexts.length >= 2, 'A7: generator phải chạy >= 2 lần (attempt + retry)');
  assert.notStrictEqual(genTexts[0], genTexts[1], 'A7: 2 lần sinh thật sự ra 2 text KHÁC nhau');
  const execs = app.store.findAll('action_executions', e => e.action_type === 'SEND_MESSAGE');
  assert.strictEqual(execs.length, 1, 'A7: đúng 1 exec row');
  const key = execs[0].idempotency_key;
  assert.ok(key.startsWith('send:facebook:fb-ga7:'), 'A7: key prefix send:<conversation_id>');
  assert.ok(key.includes(':ai_reply:PRICE'), 'A7: key chứa <event_id>:<msg_kind>:<slot> (event-scoped)');
  assert.ok(!key.includes('bien the'), 'A7: key KHÔNG chứa generated wording (không text-scoped)');
  assert.strictEqual(app.platform.sentCalls.length, 1, 'A7: text khác giữa 2 retry vẫn CHỈ 1 external send');
  const outs = outMsgs(app, 'fb-ga7');
  assert.strictEqual(outs.length, 1, 'A7: đúng 1 tin out');
  assert.strictEqual(new Set(outs.map(m => m.text_content)).size, 1, 'A7: không có 2 nội dung');
  assert.ok(app.store.findAll('audit_events', a => a.execution_result === 'DUPLICATE_SUPPRESSED').length >= 1, 'A7: retry bị dedupe bằng CÙNG key (DUPLICATE_SUPPRESSED)');
}

// ============================================================ HARNESS
const TESTS = [
  { n: 'A1', desc: 'BL-3 BUY: phone -> model_ctx contains phone = false', fn: A1 },
  { n: 'A2', desc: 'BL-3 CHITCHAT/AFTER_SALES/CLAIM: address/name -> false/false; CLAIM không đưa gì vào model', fn: A2 },
  { n: 'A3', desc: 'BL-8 system bypass HUMAN (ai_reply + text tự do) -> REJECT, sentCalls = 0', fn: A3 },
  { n: 'A4', desc: 'BL-8 system template hợp lệ ACK_DLQ -> AUTHORIZED, template_id logged; sai kind/text -> REJECT', fn: A4 },
  { n: 'A5', desc: 'BL-9 crash sau sendMessage -> retry -> exactly 1 external send', fn: A5 },
  { n: 'A6', desc: 'BL-9 crash sau DB insert (inbound/proposal) -> retry -> exactly 1 logical row', fn: A6 },
  { n: 'A7', desc: 'BL-9 generator khác text giữa retries -> idempotency identity KHÔNG đổi', fn: A7 },
];

function main() {
  const rows = [];
  let pass = 0;
  for (const t of TESTS) {
    const started = Date.now();
    try {
      t.fn();
      pass += 1;
      rows.push(`  [PASS] ${t.n} — ${t.desc} (${Date.now() - started}ms)`);
      console.log(rows[rows.length - 1]);
    } catch (err) {
      rows.push(`  [FAIL] ${t.n} — ${t.desc}\n         -> ${String(err && err.message).split('\n').slice(0, 4).join(' | ')}`);
      console.log(rows[rows.length - 1]);
    }
  }
  console.log('\n=============== KẾT QUẢ GATE A (P3A) ===============');
  console.log(`TỔNG: ${pass}/7 PASS, ${7 - pass} FAIL`);
  console.log(pass === 7
    ? '==> GATE A 7/7 — BL-3 + BL-8 + BL-9 đóng, có bằng chứng injection (prototype-mock).'
    : '==> GATE A CHƯA ĐẠT — các test FAIL phía trên là blocker thật, không được nới expectation.');
  process.exitCode = pass === 7 ? 0 : 1;
}

main();
