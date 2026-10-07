'use strict';
// test/p3c-cases.js — BATTERY P3C: PLATFORM CONSTRAINTS + SEND CORRECTNESS (28 test).
// Đóng đúng 5 blocker của BAO-CAO-HOI-DONG-V2.md Phần A.2 (nhóm còn lại sau P3A/P3B):
//   BL-1 WINDOW 24h FB   — C1.1..C1.5 (last_user_event_ts + Window Gate trong AUTHORIZE)
//   BL-2 ZALO QUOTA CS   — C2.1..C2.6 (cs_reply.remain per user, check-and-decrement nguyên tử,
//                          remain thấp -> human, remain 0 -> REJECT cứng, gom tin/turn)
//   BL-5 RECEIPT STORE   — C3.1..C3.5 (inbound-first: outbound_pending + webhook receipt match;
//                          KHÔNG tự đánh DELIVERED; timeout -> DLQ, không blind resend)
//   BL-6 MONEY GUARD     — C4.1..C4.5 (allowedMoney theo SUBJECT + snapshot đơn + giỏ + fee;
//                          giá SP khác -> OVERRIDE; đè ĐÚNG CÂU sai, không đè cả tin)
//   BL-7 FOLLOW-UP STATUS— C5.1..C5.6 (SENT chỉ khi có receipt; timeout -> PENDING_RECEIPT;
//                          fail rõ -> FAILED; idem theo follow_up_id; DLQ -> ACK_DLQ đúng 1 lần)
//   SENDPOLICY 1 CHỖ     — C6.1 (mọi ràng buộc duyệt tại authorize; sender chỉ execute)
// KHÔNG sửa expectation của suite cũ — các va chạm hợp lệ đã được cập nhật RIÊNG kèm lý do
// trong 18-cases.js (11b/15/17) và invariants-check.js (vùng 2b).
// Exit 0 khi 28/28 PASS.

const path = require('path');
const assert = require('assert');
const { App } = require('../src/app');
const { renderSystemTemplate } = require('../src/system-templates');

const DATA = path.join(__dirname, '..', 'data', 'test-runs');
const FB = 'facebook';
const ZL = 'zalo';
const dir = name => path.join(DATA, name);

let pid = 0;
function msg(app, channel, ref, text, extra = {}) {
  pid += 1;
  return app.receive({
    channel,
    type: 'message',
    platformEventId: extra.pid || `mid-p3c-${ref}-${pid}`,
    payload: {
      customer_ref: ref,
      thread_id: extra.thread || ref,
      kind: 'text',
      text: text || '',
      platform_message_id: `pm-p3c-${pid}`,
    },
  });
}

const convOf = (app, ref) => app.store.findOne('conversations', c => c.platform_thread_id === ref);
const cusOf = (app, ref) => app.store.findOne('customers', c => c.platform_ref === ref);
const outMsgs = (app, ref) => {
  const conv = convOf(app, ref);
  return conv ? app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'out') : [];
};
const budgetOf = (app, ref) => app.store.findOne('channel_budget', b => b.conversation_id === convOf(app, ref).conversation_id);

const BUY_VANILLA = 'lấy 1 nến vanilla M đỏ, tên Anh Bảo, sdt 0901111222, địa chỉ 12 Nguyễn Trãi Q1 TP.HCM';

function insertFu(app, conv, cus, id, kind, delayMs) {
  app.store.insert('follow_ups', {
    follow_up_id: id, order_id: null, conversation_id: conv.conversation_id, customer_id: cus.customer_id,
    kind, scheduled_at: new Date(app.clock.now() + delayMs).toISOString(),
    status: 'SCHEDULED', cancel_reason: null, exec_id: null,
    created_at: app.store.now(), updated_at: app.store.now(),
  });
  return app.store.findOne('follow_ups', f => f.follow_up_id === id);
}

// ============================================================ BL-1 — WINDOW 24h FACEBOOK
// C1.1: vừa nhắn (<24h) -> AUTO -> ALLOW; gateway lưu last_user_event_ts; bot send/receipt
// KHÔNG refresh window (window chỉ mở bởi event thật của user).
function C1_1() {
  const app = new App({ dataDir: dir('p3c-c11') });
  msg(app, FB, 'fb-w1', 'nến vanilla giá bao nhiêu?');
  app.drain();

  const cs = app.store.findOne('channel_state', s => s.conversation_id === 'facebook:fb-w1');
  const evIn = app.store.findOne('inbox_events', e => e.event_id && e.event_id.startsWith('facebook:mid-p3c-fb-w1'));
  assert.ok(cs && cs.last_user_event_ts, 'BL-1: gateway lưu last_user_event_ts theo channel+conversation');
  assert.strictEqual(Date.parse(cs.last_user_event_ts), Date.parse(evIn.received_at),
    'BL-1: mốc = thời điểm event THẬT của user (drain trôi clock vì receipt timer nhưng mốc KHÔNG đổi)');
  assert.strictEqual(outMsgs(app, 'fb-w1').length, 1, 'C1.1: AUTO reply đi bình thường trong window');
  const allow = app.store.findAll('audit_events', a => a.stage === 'AUTHORIZED' && a.execution_result === 'AUTHORIZED').pop();
  assert.ok(allow && allow.validation.window_open === true, 'audit ALLOW ghi window_open=true');

  // trôi 23h — receipt/bot activity KHÔNG được refresh window (chỉ user event mở window)
  app.advance(23 * 3600e3);
  const conv = convOf(app, 'fb-w1');
  const cus = cusOf(app, 'fb-w1');
  const facts = app.pipeline.buildFacts(conv, '');
  const r = app.gate.sendReply({
    conversation: conv, customer: cus, event: null,
    proposal: { intent: 'PRICE', msgKind: 'ai_reply', text: 'Dạ giá 185000đ nha anh ạ!', evidence: { source: 'product_db' }, confidence: 0.99, facts },
  });
  assert.strictEqual(r.sent, true, 'C1.1: 23h sau tin khách (< 24h) vẫn ALLOW');
  assert.strictEqual(Date.parse(app.store.findOne('channel_state', s => s.conversation_id === 'facebook:fb-w1').last_user_event_ts),
    Date.parse(cs.last_user_event_ts), 'BL-1: bot send + receipt KHÔNG refresh last_user_event_ts');
}

// C1.2: im > 24h -> auto-send thường REJECT reason=fb_window_closed, 0 platform call.
function C1_2() {
  const app = new App({ dataDir: dir('p3c-c12') });
  msg(app, FB, 'fb-w2', 'nến vanilla giá bao nhiêu?');
  app.drain();
  const before = app.platform.sentCalls.length;
  app.advance(25 * 3600e3); // im lặng 25h — window đóng

  const conv = convOf(app, 'fb-w2');
  const cus = cusOf(app, 'fb-w2');
  const facts = app.pipeline.buildFacts(conv, '');
  const r = app.gate.sendReply({
    conversation: conv, customer: cus, event: null,
    proposal: { intent: 'PRICE', msgKind: 'ai_reply', text: 'Dạ giá 185000đ nha anh ạ!', evidence: { source: 'product_db' }, confidence: 0.99, facts },
  });
  assert.strictEqual(r.sent, false, 'C1.2: ngoài 24h -> REJECT');
  assert.strictEqual(r.reason, 'fb_window_closed', 'C1.2: reason fb_window_closed');
  assert.strictEqual(r.decision, 'REJECTED_BY_GATE');
  assert.strictEqual(app.platform.sentCalls.length, before, 'C1.2: KHÔNG tin nào ra ngoài');
  assert.ok(app.metric('gate_rejected_fb_window_closed') >= 1, 'metric gate_rejected_fb_window_closed++');
  const rej = app.store.findAll('audit_events', a => a.stage === 'AUTHORIZED' && a.execution_result === 'REJECTED:fb_window_closed').pop();
  assert.ok(rej && rej.validation.actor === 'ai' && rej.validation.mode === 'AI', 'audit REJECT ghi actor/mode');
}

// C1.3: follow-up care/marketing ngoài 24h -> HELD (đợi khách nhắn lại); khách nhắn lại ->
// window mở lại -> care gửi ĐÚNG 1 lần có receipt.
function C1_3() {
  const app = new App({ dataDir: dir('p3c-c13') });
  msg(app, FB, 'fb-w3', 'nến vanilla giá bao nhiêu?');
  app.drain();
  const conv = convOf(app, 'fb-w3');
  const cus = cusOf(app, 'fb-w3');
  const fuCare = insertFu(app, conv, cus, 'fu-c13-care', 'AFTER_DELIVERY_FEEDBACK', 2 * 24 * 3600e3);
  const fuMkt = insertFu(app, conv, cus, 'fu-c13-mkt', 'MARKETING', 2 * 24 * 3600e3);

  app.advance(2 * 24 * 3600e3 + 60e3); // đến hẹn — window đã đóng từ lâu
  const care = app.store.findOne('follow_ups', f => f.follow_up_id === 'fu-c13-care');
  const mkt = app.store.findOne('follow_ups', f => f.follow_up_id === 'fu-c13-mkt');
  assert.strictEqual(care.status, 'HELD', 'C1.3: care ngoài window -> HELD');
  assert.strictEqual(care.cancel_reason, 'fb_window_closed');
  assert.strictEqual(mkt.status, 'HELD', 'C1.3: marketing ngoài window -> HELD (A16 UNSUPPORTED)');
  assert.strictEqual(app.store.findAll('messages', m => m.msg_kind === 'care' || m.msg_kind === 'marketing').length, 0,
    'C1.3: 0 tin care/marketing đi ra khi window đóng');
  assert.ok(app.store.findAll('audit_events', a => a.execution_result === 'HELD_WINDOW').length >= 1, 'audit HELD_WINDOW');

  // khách nhắn lại -> window mở lại -> follow-up HELD được kích hoạt và gửi (có receipt)
  msg(app, FB, 'fb-w3', 'hi shop, mình cần tư vấn');
  app.drain();
  const care2 = app.store.findOne('follow_ups', f => f.follow_up_id === 'fu-c13-care');
  assert.strictEqual(care2.status, 'SENT', 'C1.3: khách nhắn lại -> care gửi + receipt -> SENT');
  assert.strictEqual(app.store.findAll('messages', m => m.msg_kind === 'care').length, 1, 'care đúng 1 tin');
  const mkt2 = app.store.findOne('follow_ups', f => f.follow_up_id === 'fu-c13-mkt');
  assert.strictEqual(mkt2.status, 'SENT', 'marketing cũng chỉ đi được SAU khi khách mở lại window');
}

// C1.4: utility template mock-approved (ACK_DLQ) là đường DUY NHẤT bot gửi được ngoài window.
function C1_4() {
  const app = new App({ dataDir: dir('p3c-c14') });
  msg(app, FB, 'fb-w4', 'nến vanilla giá bao nhiêu?');
  app.drain();
  const before = app.platform.sentCalls.length;
  app.advance(25 * 3600e3);

  const conv = convOf(app, 'fb-w4');
  const cus = cusOf(app, 'fb-w4');
  const r = app.gate.sendReply({
    conversation: conv, customer: cus, event: null,
    proposal: {
      intent: 'DLQ_ACK', msgKind: 'transactional', sender: 'system', template_id: 'ACK_DLQ',
      text: renderSystemTemplate('ACK_DLQ'), evidence: { policy: 'ack_dlq' }, confidence: 1,
    },
  });
  assert.strictEqual(r.sent, true, 'C1.4: utility template mock-approved -> ALLOW ngoài window');
  assert.strictEqual(app.platform.sentCalls.length, before + 1, 'C1.4: đúng 1 platform call');
  // follow-up CARE template (kind care) KHÔNG được coi là utility -> vẫn REJECT
  const r2 = app.gate.sendReply({
    conversation: conv, customer: cus, event: null,
    proposal: {
      intent: 'FOLLOW_UP', msgKind: 'care', sender: 'system', template_id: 'FOLLOW_UP_CARE',
      text: renderSystemTemplate('FOLLOW_UP_CARE'), evidence: { policy: 'care' }, confidence: 1,
    },
  });
  assert.strictEqual(r2.sent, false, 'C1.4: care ngoài window KHÔNG lách qua template');
  assert.strictEqual(r2.reason, 'fb_window_closed');
}

// C1.5: bot CẤM tự gắn human_agent để lách window; người thật ở mode HUMAN gửi được (tag HUMAN_AGENT).
function C1_5() {
  const app = new App({ dataDir: dir('p3c-c15') });
  msg(app, FB, 'fb-w5', 'nến vanilla giá bao nhiêu?');
  app.drain();
  app.advance(25 * 3600e3);
  const conv = convOf(app, 'fb-w5');
  const cus = cusOf(app, 'fb-w5');
  const before = app.platform.sentCalls.length;

  // bot tự gắn human_agent khi mode AI -> giả mạo -> REJECT
  const r = app.gate.sendReply({
    conversation: conv, customer: cus, event: null,
    proposal: { intent: 'PRICE', msgKind: 'ai_reply', sender: 'human_agent', text: 'Dạ giá 185000đ nha anh ạ!', evidence: { source: 'product_db' }, confidence: 0.99 },
  });
  assert.strictEqual(r.sent, false, 'C1.5: bot gắn human_agent ở mode AI -> REJECT');
  assert.strictEqual(r.reason, 'human_agent_spoofed', 'C1.5: reason human_agent_spoofed');
  assert.strictEqual(app.platform.sentCalls.length, before, 'C1.5: 0 platform call');
  assert.ok(app.metric('gate_rejected_human_agent_spoofed') >= 1, 'metric gate_rejected_human_agent_spoofed++');

  // người thật ở mode HUMAN bấm tay gửi -> tag HUMAN_AGENT hợp lệ (7 ngày, matrix A12)
  app.takeover.setTakeover(conv, 'op1', 'operator_request');
  const sent = app.takeover.agentSend(app.gate, conv, cus, 'Dạ em là nhân viên shop, nến còn hàng nha anh ạ!', 'op1');
  assert.strictEqual(sent.sent, true, 'C1.5: người thật (mode HUMAN) gửi được ngoài window');
  const agentMsgs = app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.sender === 'human_agent');
  assert.strictEqual(agentMsgs.length, 1, 'tin sender=human_agent trong messages');
}

// ============================================================ BL-2 — ZALO QUOTA CS
// C2.1: remain=8 -> send được; sau send remain -> 7 (budget local + platform cùng giảm).
function C2_1() {
  const app = new App({ dataDir: dir('p3c-c21') });
  assert.strictEqual(app.platform.getQuota('zl-q1').remain, 8, 'mock mô hình cs_reply.remain per user (mặc định 8/48h)');
  msg(app, ZL, 'zl-q1', 'nến vanilla giá bao nhiêu?');
  app.drain();

  assert.strictEqual(app.platform.sentCalls.length, 1, 'C2.1: remain 8 > ngưỡng -> send');
  assert.strictEqual(app.platform.getQuota('zl-q1').remain, 7, 'C2.1: platform quota 8 -> 7');
  const b = budgetOf(app, 'zl-q1');
  assert.ok(b && b.cs_remain === 7 && b.cs_total === 8, 'C2.1: channel_budget mirror 7/8 (nguyên tử cùng tx)');
  assert.strictEqual(app.platform.consumedCs.length, 1, 'platform trừ đúng 1 lần');
}

// C2.2: remain=2 (<= ngưỡng) -> KHÔNG auto-send, chuyển human (NEEDS_HUMAN/HOLD).
function C2_2() {
  const app = new App({ dataDir: dir('p3c-c22') });
  app.platform.setQuota('zl-q2', 2);
  msg(app, ZL, 'zl-q2', 'nến vanilla giá bao nhiêu?');
  app.drain();

  assert.strictEqual(app.platform.sentCalls.length, 0, 'C2.2: remain 2 -> 0 auto-send');
  const r = app.store.findAll('ai_proposals', p => p.intent === 'PRICE').pop();
  assert.strictEqual(r.decision, 'REJECTED_BY_GATE');
  assert.ok(app.metric('gate_rejected_zalo_quota_low') >= 1, 'metric gate_rejected_zalo_quota_low++');
  assert.ok(app.store.findAll('worklist', w => w.reason === 'zalo_quota_low').length >= 1, 'C2.2: NEEDS_HUMAN cho operator');
  assert.strictEqual(budgetOf(app, 'zl-q2').cs_remain, 2, 'C2.2: quota KHÔNG bị trừ khi bị chặn');
  // follow-up care đến hạn khi remain thấp -> HELD (không đốt nốt quota, không gửi)
  const conv = convOf(app, 'zl-q2');
  const cus = cusOf(app, 'zl-q2');
  const fu = insertFu(app, conv, cus, 'fu-c22-care', 'AFTER_DELIVERY_FEEDBACK', 60e3);
  app.advance(2 * 3600e3);
  assert.strictEqual(app.store.findOne('follow_ups', f => f.follow_up_id === 'fu-c22-care').status, 'HELD', 'follow-up care remain thấp -> HELD');
  assert.strictEqual(app.store.findAll('messages', m => m.msg_kind === 'care').length, 0);
  void fu;
}

// C2.3: remain=0 -> REJECT cứng, 0 platform call.
function C2_3() {
  const app = new App({ dataDir: dir('p3c-c23') });
  app.platform.setQuota('zl-q3', 0);
  msg(app, ZL, 'zl-q3', 'nến vanilla giá bao nhiêu?');
  app.drain();

  assert.strictEqual(app.platform.sentCalls.length, 0, 'C2.3: remain 0 -> 0 platform call (B9: không escape hatch)');
  const rej = app.store.findAll('audit_events', a => a.execution_result === 'REJECTED:zalo_quota_exhausted').pop();
  assert.ok(rej, 'audit REJECT zalo_quota_exhausted');
  assert.strictEqual(app.metric('send_timeout') + app.metric('send_failed'), 0, 'không có call nào thất bại vì KHÔNG gọi');
  assert.strictEqual(budgetOf(app, 'zl-q3').cs_remain, 0);
}

// C2.4: 2 worker "đồng thời" (2 event cùng tick) với remain=1 -> đúng 1 send
// (check-and-decrement nguyên tử trong cùng transaction — không cả hai đọc remain=1 rồi cùng gửi).
function C2_4() {
  const app = new App({ dataDir: dir('p3c-c24'), quotaLowThreshold: 0 }); // chỉ remain=0 mới chặn
  app.platform.setQuota('zl-q4', 1);
  msg(app, ZL, 'zl-q4', 'nến vanilla giá bao nhiêu?', { pid: 'm-q4-1' });
  msg(app, ZL, 'zl-q4', 'trà hoa sấy giá bao nhiêu?', { pid: 'm-q4-2' });
  app.gateway.processQueue(); // 2 event CÙNG batch — tuần tự trong 1 tick

  assert.strictEqual(app.platform.sentCalls.length, 1, 'C2.4: exactly 1 send (không double-send)');
  assert.strictEqual(budgetOf(app, 'zl-q4').cs_remain, 0, 'C2.4: remain 1 -> 0 đúng 1 lần trừ');
  app.drain();
  assert.strictEqual(app.platform.sentCalls.length, 1, 'vẫn đúng 1 send sau drain');
  assert.ok(app.store.findAll('audit_events', a => a.execution_result === 'REJECTED:zalo_quota_exhausted').length >= 1,
    'event thứ 2 bị REJECT zalo_quota_exhausted (đọc remain=0 sau khi event 1 reserve)');
  assert.strictEqual(app.store.findAll('messages', m => m.direction === 'out').length, 1, 'khách chỉ nhận 1 tin');
}

// C2.5: tin transactional ĐÚNG KIND (loại transaction — B8) KHÔNG trừ CS quota.
function C2_5() {
  const app = new App({ dataDir: dir('p3c-c25') });
  msg(app, ZL, 'zl-q5', BUY_VANILLA); // bill ORDER_DRAFT: msgKind transactional
  app.drain();
  msg(app, ZL, 'zl-q5', 'xác nhận'); // ORDER_CONFIRMED: msgKind transactional
  app.drain();

  assert.ok(app.store.findAll('messages', m => m.direction === 'out' && m.msg_kind === 'transactional').length >= 2, 'đã có tin transactional');
  assert.strictEqual(app.platform.getQuota('zl-q5').remain, 8, 'C2.5: CS quota KHÔNG bị trừ bởi transactional');
  assert.strictEqual(app.platform.consumedCs.length, 0, 'KHÔNG có consumeCs nào');
  assert.strictEqual(budgetOf(app, 'zl-q5'), null, 'không even tạo budget CS (không có tin CS nào)');
  assert.strictEqual(app.store.findAll('orders', o => o.status === 'CONFIRMED').length, 1, 'luồng mua vẫn chạy đủ');
}

// C2.6: gom tin — Zalo tối đa 2 tin CS/turn; remain thấp -> gộp còn 1 tin/turn.
function C2_6() {
  const app = new App({ dataDir: dir('p3c-c26') });
  const conv = (() => { msg(app, ZL, 'zl-q6', 'hi'); app.drain(); return convOf(app, 'zl-q6'); })();
  const cus = cusOf(app, 'zl-q6');
  const facts = app.pipeline.buildFacts(conv, '');
  const event = { event_id: 'evt-turn-q6' };
  const send = (slot) => app.gate.sendReply({
    conversation: conv, customer: cus, event,
    proposal: { intent: 'PRICE', msgKind: 'ai_reply', text: 'Dạ giá 185000đ nha ạ!', evidence: { source: 'product_db' }, confidence: 0.99, facts, slot },
  });

  const r1 = send('slot-a');
  const r2 = send('slot-b');
  const r3 = send('slot-c');
  assert.strictEqual(r1.sent, true, 'C2.6: tin CS thứ 1/turn -> ALLOW');
  assert.strictEqual(r2.sent, true, 'C2.6: tin CS thứ 2/turn -> ALLOW (cap 2)');
  assert.strictEqual(r3.sent, false, 'C2.6: tin thứ 3/turn bị chặn');
  assert.strictEqual(r3.reason, 'zalo_cs_turn_cap', 'C2.6: reason zalo_cs_turn_cap (gom tin)');
  assert.strictEqual(app.platform.sentCalls.length, 3, '3 platform call: chitchat chào + 2 tin CS của turn');
  void r1; void r2;

  // remain thấp (3: > ngưỡng 2 nên vẫn auto được, nhưng <= ngưỡng+1) -> cap 1 tin/turn
  const b = budgetOf(app, 'zl-q6');
  app.store.updateRow('channel_budget', b, { cs_remain: 3 }); // > ngưỡng (vẫn auto) nhưng thấp -> gộp còn 1
  const event2 = { event_id: 'evt-turn-q6b' };
  const s1 = app.gate.sendReply({
    conversation: conv, customer: cus, event: event2,
    proposal: { intent: 'PRICE', msgKind: 'ai_reply', text: 'Dạ giá 185000đ nha ạ!', evidence: { source: 'product_db' }, confidence: 0.99, facts, slot: 'slot-d' },
  });
  const s2 = app.gate.sendReply({
    conversation: conv, customer: cus, event: event2,
    proposal: { intent: 'PRICE', msgKind: 'ai_reply', text: 'Dạ giá 185000đ nha ạ!', evidence: { source: 'product_db' }, confidence: 0.99, facts, slot: 'slot-e' },
  });
  assert.strictEqual(s1.sent, true, 'remain thấp: 1 tin/turn -> ALLOW');
  assert.strictEqual(s2.sent, false, 'remain thấp: tin thứ 2/turn -> KHÔNG gửi (gom còn 1 tin/turn)');
  // Lý do chặn có thể là zalo_cs_turn_cap (đọc trong tx) hoặc zalo_quota_low (pre-check sau khi
  // tin thứ 1 làm remain chạm ngưỡng) — cả hai đều đúng chính sách: remain thấp chỉ 1 tin/turn.
  assert.ok(['zalo_cs_turn_cap', 'zalo_quota_low'].includes(s2.reason), `reason gom tin (${s2.reason})`);
  assert.strictEqual(budgetOf(app, 'zl-q6').cs_remain, 2, 'remain không tụt dưới ngưỡng vì tin thứ 2 bị gộp');
}

// ============================================================ BL-5 — RECEIPT STORE INBOUND-FIRST
// C3.1: send accepted CHƯA có receipt -> message SENT_PENDING_RECEIPT (KHÔNG DELIVERED),
// outbound_pending PENDING.
function C3_1() {
  const app = new App({ dataDir: dir('p3c-c31') });
  msg(app, FB, 'fb-r1', 'nến vanilla giá bao nhiêu?');
  app.gateway.processQueue(); // CHƯA advance — chưa có webhook receipt nào

  const out = outMsgs(app, 'fb-r1')[0];
  assert.ok(out, 'tin đã gửi');
  assert.strictEqual(out.delivery_status, 'SENT_PENDING_RECEIPT', 'C3.1: accepted -> SENT_PENDING_RECEIPT, KHÔNG tự đánh DELIVERED');
  const op = app.store.findOne('outbound_pending', o => o.exec_id === out.send_exec_id);
  assert.ok(op, 'outbound_pending row tồn tại');
  assert.strictEqual(op.receipt_status, 'PENDING', 'C3.1: op PENDING');
  assert.strictEqual(op.channel, 'facebook');
  assert.ok(op.text_hash && op.sent_at, 'op có text_hash + sent_at (match theo conversation+time)');
}

// C3.2: receipt webhook tới -> DELIVERED (message + op + exec DONE).
function C3_2() {
  const app = new App({ dataDir: dir('p3c-c32') });
  msg(app, FB, 'fb-r2', 'nến vanilla giá bao nhiêu?');
  app.gateway.processQueue();
  app.drain(); // +5s: mock bắn webhook message_delivery -> match

  const out = outMsgs(app, 'fb-r2')[0];
  assert.strictEqual(out.delivery_status, 'DELIVERED', 'C3.2: receipt -> DELIVERED');
  assert.ok(out.platform_message_id, 'platform_message_id từ receipt');
  const op = app.store.findOne('outbound_pending', o => o.exec_id === out.send_exec_id);
  assert.strictEqual(op.receipt_status, 'DELIVERED', 'op DELIVERED');
  assert.ok(op.receipt_event_id && op.receipt_at, 'op ghi receipt_event_id + receipt_at');
  const exec = app.store.findOne('action_executions', e => e.exec_id === out.send_exec_id);
  assert.strictEqual(exec.status, 'DONE', 'exec DONE từ bằng chứng');
  assert.ok(app.metric('receipt_matched') >= 1, 'metric receipt_matched++');
  assert.ok(app.store.findAll('audit_events', a => a.execution_result === 'RECEIPT_MATCHED').length >= 1, 'audit RECEIPT_MATCHED');
}

// C3.3: duplicate receipt (platform resend webhook) -> idempotent, KHÔNG double-match.
function C3_3() {
  const app = new App({ dataDir: dir('p3c-c33') });
  msg(app, FB, 'fb-r3', 'nến vanilla giá bao nhiêu?');
  app.drain();
  const out = outMsgs(app, 'fb-r3')[0];
  const op = app.store.findOne('outbound_pending', o => o.exec_id === out.send_exec_id);
  assert.strictEqual(op.receipt_status, 'DELIVERED');
  const matchedBefore = app.metric('receipt_matched');
  const opsBefore = app.store.findAll('outbound_pending', o => o.receipt_status === 'DELIVERED').length;

  const again = app.ingestReceipt({
    conversation_id: 'facebook:fb-r3', clientMessageId: out.send_exec_id,
    mid: out.platform_message_id, at: op.receipt_at,
  });
  assert.strictEqual(again.duplicate, true, 'C3.3: duplicate receipt -> dedupe theo receipt_event_id');
  assert.strictEqual(app.metric('receipt_matched'), matchedBefore, 'C3.3: không match lại lần 2');
  assert.strictEqual(app.store.findAll('outbound_pending', o => o.receipt_status === 'DELIVERED').length, opsBefore, 'vẫn đúng 1 op DELIVERED');
  assert.strictEqual(app.store.findAll('messages', m => m.direction === 'out').length, 1, 'không sinh tin mới');
}

// C3.4: receipt LẠ (conversation lạ / ngoài cửa sổ thời gian) -> KHÔNG gắn nhầm.
function C3_4() {
  const app = new App({ dataDir: dir('p3c-c34') });
  // (a) conversation không tồn tại / không có pending nào
  const r1 = app.gate.processReceiptEvent({
    event_id: 'rcpt-ghost-1', conversation_id: 'facebook:ghost', channel: 'facebook',
    kind: 'message_delivery', at: new Date(app.clock.now()).toISOString(), mid: 'mid-lạ',
  });
  assert.strictEqual(r1.matched, false, 'C3.4a: receipt của conversation lạ -> không match');
  assert.ok(app.metric('receipt_unmatched') >= 1, 'metric receipt_unmatched++');

  // (b) receipt đến SAU 3 ngày — ngoài cửa sổ [sent-2ph, sent+24h] -> không gắn vào tin cũ
  const app2 = new App({ dataDir: dir('p3c-c34b'), platformMode: 'hang_then_deliver', platformLatencyMs: 10 * 24 * 3600e3 });
  msg(app2, FB, 'fb-r34', 'nến vanilla giá bao nhiêu?');
  app2.gateway.processQueue(); // TIMEOUT_UNKNOWN -> op PENDING (job check hẹn +60s, chưa chạy)
  app2.clock.advance(app2.clock.now() + 3 * 24 * 3600e3); // KHÔNG runDueJobs — chỉ trôi clock
  const op = app2.store.findOne('outbound_pending', () => true);
  const r2 = app2.gate.processReceiptEvent({
    event_id: 'rcpt-late-1', conversation_id: op.conversation_id, channel: 'facebook',
    kind: 'message_delivery', at: new Date(app2.clock.now()).toISOString(), mid: null,
  });
  assert.strictEqual(r2.matched, false, 'C3.4b: receipt +3 ngày ngoài window -> không gắn nhầm');
  assert.strictEqual(app2.store.findOne('outbound_pending', o => o.op_id === op.op_id).receipt_status, 'PENDING', 'op vẫn PENDING');
  const out = outMsgs(app2, 'fb-r34')[0];
  assert.notStrictEqual(out.delivery_status, 'DELIVERED', 'tin KHÔNG bị đánh DELIVERED oan');
}

// C3.5: không bao giờ có bằng chứng -> check CÓ GIỚI HẠN -> hết max_attempts -> DLQ +
// NEEDS_HUMAN + ACK_DLQ đúng 1 lần — KHÔNG blind resend tin gốc.
function C3_5() {
  const app = new App({ dataDir: dir('p3c-c35'), platformMode: 'hang_forever' });
  msg(app, FB, 'fb-r5', 'nến vanilla giá bao nhiêu?');
  app.drain();

  const ackText = renderSystemTemplate('ACK_DLQ');
  const origCalls = app.platform.sentCalls.filter(c => !c.text.includes('185000'));
  assert.strictEqual(app.platform.sentCalls.filter(c => c.text.includes('185000')).length, 1, 'C3.5: tin gốc KHÔNG blind-resend (đúng 1 call)');
  assert.strictEqual(origCalls.length, 1, 'C3.5: + 1 ACK_DLQ duy nhất');
  assert.strictEqual(origCalls[0].text, ackText, 'ACK đúng template whitelist');
  assert.ok(app.store.findAll('dlq', d => d.fail_reason === 'NO_RECEIPT_AFTER_3_CHECKS').length >= 1, 'DLQ có dòng');
  assert.strictEqual(convOf(app, 'fb-r5').mode, 'HUMAN', 'NEEDS_HUMAN -> takeover');
  assert.ok(app.store.findAll('worklist', w => w.reason === 'send_timeout_no_receipt').length >= 1, 'operator được báo');
  const exec = app.store.findOne('action_executions', e => e.action_type === 'SEND_MESSAGE' && e.status === 'TIMEOUT_UNKNOWN');
  assert.ok(exec, 'exec gốc vẫn TIMEOUT_UNKNOWN (không bị làm đẹp thành DONE)');
}

// ============================================================ BL-6 — MONEY GUARD THEO SUBJECT
// C4.1: cross-product — nến 185000, AI nói 145000 (= giá trà) -> OVERRIDE, không lọt.
function C4_1() {
  const app = new App({ dataDir: dir('p3c-c41') });
  msg(app, FB, 'fb-m1', 'nến vanilla M đỏ còn không?'); // subject = nến vanilla
  app.drain();
  const conv = convOf(app, 'fb-m1');
  const cus = cusOf(app, 'fb-m1');
  const facts = app.pipeline.buildFacts(conv, '');
  const r = app.gate.sendReply({
    conversation: conv, customer: cus, event: null,
    proposal: { intent: 'PRICE', msgKind: 'ai_reply', text: 'Dạ nến vanilla M đỏ giá 145000đ nha anh ạ!', evidence: { source: 'product_db' }, confidence: 0.99, facts },
  });
  assert.strictEqual(r.decision, 'OVERRIDDEN', 'C4.1: giá SP khác -> OVERRIDDEN (không còn catalogue-whitelist)');
  const t = outMsgs(app, 'fb-m1').pop().text_content;
  assert.ok(t.includes('185000'), 'khách nhận giá DB của subject');
  assert.ok(!t.includes('145000'), 'C4.1: 145000 (giá trà) KHÔNG lọt');
  const val = JSON.parse(app.store.findAll('ai_proposals', p => p.intent === 'PRICE').pop().validation_json);
  assert.ok(val.bad_money.includes(145000) && val.allowed_money_source === 'subject_scoped', 'validation ghi bad_money + nguồn whitelist subject-scoped');
}

// C4.2: giá của subject -> ALLOW.
function C4_2() {
  const app = new App({ dataDir: dir('p3c-c42') });
  msg(app, FB, 'fb-m2', 'nến vanilla M đỏ còn không?');
  app.drain();
  const conv = convOf(app, 'fb-m2');
  const cus = cusOf(app, 'fb-m2');
  const facts = app.pipeline.buildFacts(conv, '');
  const r = app.gate.sendReply({
    conversation: conv, customer: cus, event: null,
    proposal: { intent: 'PRICE', msgKind: 'ai_reply', text: 'Dạ giá 185000đ nha anh ạ!', evidence: { source: 'product_db' }, confidence: 0.99, facts },
  });
  assert.strictEqual(r.decision, 'AUTO_EXECUTED', 'C4.2: giá subject -> ALLOW');
  assert.strictEqual(outMsgs(app, 'fb-m2').pop().text_content.includes('185000'), true);
}

// C4.3: tổng giỏ / snapshot đơn (có evidence) -> ALLOW (false-positive đã bị thủ).
function C4_3() {
  // (i) snapshot đơn đã chốt: tổng 210000 (185000 + 25000 fee)
  const app = new App({ dataDir: dir('p3c-c43') });
  msg(app, FB, 'fb-m3', BUY_VANILLA);
  app.drain();
  msg(app, FB, 'fb-m3', 'xác nhận');
  app.drain();
  let conv = convOf(app, 'fb-m3');
  let cus = cusOf(app, 'fb-m3');
  const r = app.gate.sendReply({
    conversation: conv, customer: cus, event: null,
    proposal: { intent: 'ORDER_STATUS_QA', msgKind: 'ai_reply', text: 'Dạ đơn anh tổng cộng 210000đ nha anh ạ!', evidence: { source: 'orders_db' }, confidence: 0.95 },
  });
  assert.strictEqual(r.decision, 'AUTO_EXECUTED', 'C4.3i: tổng đơn snapshot -> ALLOW');

  // (ii) giỏ đang draft (chưa có đơn): 1 nến M đỏ + 1 trà -> tổng 330000 và 355000 (kèm fee)
  const app2 = new App({ dataDir: dir('p3c-c43b') });
  msg(app2, FB, 'fb-m3b', 'lấy 1 nến vanilla M đỏ và 1 hộp trà hoa sấy, tên An');
  app2.drain();
  const conv2 = convOf(app2, 'fb-m3b');
  const cus2 = cusOf(app2, 'fb-m3b');
  assert.ok(conv2.draft && conv2.draft.items.length === 2, 'giỏ 2 dòng đang draft');
  const r2 = app2.gate.sendReply({
    conversation: conv2, customer: cus2, event: null,
    proposal: { intent: 'ORDER_STATUS_QA', msgKind: 'ai_reply', text: 'Dạ giỏ của anh đang 330000đ nha ạ!', evidence: { source: 'draft' }, confidence: 0.9 },
  });
  assert.strictEqual(r2.decision, 'AUTO_EXECUTED', 'C4.3ii: tổng giỏ (tổ hợp dòng) -> ALLOW');
  const r3 = app2.gate.sendReply({
    conversation: conv2, customer: cus2, event: null,
    proposal: { intent: 'ORDER_STATUS_QA', msgKind: 'ai_reply', text: 'Cộng phí ship là 355000đ nha anh ạ!', evidence: { source: 'draft' }, confidence: 0.9 },
  });
  assert.strictEqual(r3.decision, 'AUTO_EXECUTED', 'C4.3ii: tổng giỏ + phí ship -> ALLOW');
}

// C4.4: phí ship có evidence -> ALLOW.
function C4_4() {
  const app = new App({ dataDir: dir('p3c-c44') });
  msg(app, FB, 'fb-m4', BUY_VANILLA);
  app.drain();
  const conv = convOf(app, 'fb-m4');
  const cus = cusOf(app, 'fb-m4');
  const r = app.gate.sendReply({
    conversation: conv, customer: cus, event: null,
    proposal: { intent: 'ORDER_STATUS_QA', msgKind: 'ai_reply', text: 'Dạ phí ship 25000đ nha anh ạ!', evidence: { source: 'orders_db' }, confidence: 0.9 },
  });
  assert.strictEqual(r.decision, 'AUTO_EXECUTED', 'C4.4: phí ship 25000 có evidence -> ALLOW (probe B2 cũ không còn chặn nhầm)');
}

// C4.5: 1 câu sai + 2 câu đúng -> CHỈ câu sai bị thay bằng render DB, câu đúng giữ nguyên.
function C4_5() {
  const app = new App({ dataDir: dir('p3c-c45') });
  msg(app, FB, 'fb-m5', 'nến vanilla M đỏ còn không?');
  app.drain();
  const conv = convOf(app, 'fb-m5');
  const cus = cusOf(app, 'fb-m5');
  const facts = app.pipeline.buildFacts(conv, '');
  const r = app.gate.sendReply({
    conversation: conv, customer: cus, event: null,
    proposal: {
      intent: 'VARIANT', msgKind: 'ai_reply',
      text: 'Dạ nến vanilla M đỏ vẫn còn 3 cái nha anh! Giá chỉ 145000đ thôi anh ơi! Anh chốt sớm kẻo hết nha!',
      evidence: { source: 'product_db' }, confidence: 0.95, facts,
    },
  });
  assert.strictEqual(r.decision, 'OVERRIDDEN');
  const t = outMsgs(app, 'fb-m5').pop().text_content;
  assert.ok(t.includes('còn 3 cái nha anh'), 'C4.5: câu đúng 1 GIỮ NGUYÊN');
  assert.ok(t.includes('chốt sớm kẻo hết'), 'C4.5: câu đúng 3 GIỮ NGUYÊN');
  assert.ok(t.includes('185000'), 'C4.5: câu sai được thay bằng render DB');
  assert.ok(!t.includes('145000'), 'C4.5: số sai biến mất');
  const val = JSON.parse(app.store.findAll('ai_proposals', p => p.intent === 'VARIANT').pop().validation_json);
  assert.ok(val.bad_money.includes(145000), 'validation ghi đúng số sai');
}

// ============================================================ BL-7 — FOLLOW-UP STATUS CORRECTNESS
// C5.1: send OK -> PENDING_RECEIPT trước, receipt về -> SENT (tin thật đi ra mới được SENT).
function C5_1() {
  const app = new App({ dataDir: dir('p3c-c51') });
  msg(app, FB, 'fb-f1', 'nến vanilla giá bao nhiêu?');
  app.drain();
  const conv = convOf(app, 'fb-f1');
  const cus = cusOf(app, 'fb-f1');
  insertFu(app, conv, cus, 'fu-c51', 'AFTER_DELIVERY_FEEDBACK', 60e3);

  app.clock.advance(app.clock.now() + 60e3);
  app.runDueJobs(); // follow-up gửi — platform chưa kịp bắn receipt
  let fu = app.store.findOne('follow_ups', f => f.follow_up_id === 'fu-c51');
  assert.strictEqual(fu.status, 'PENDING_RECEIPT', 'C5.1: accepted -> PENDING_RECEIPT (KHÔNG SENT ngay)');
  assert.notStrictEqual(app.store.findOne('messages', m => m.send_exec_id === fu.exec_id).delivery_status, 'DELIVERED');
  assert.strictEqual(app.store.findAll('follow_ups', f => f.status === 'SENT').length, 0, 'chưa có follow-up nào SENT khi chưa có receipt');

  app.drain(); // +5s: receipt về
  fu = app.store.findOne('follow_ups', f => f.follow_up_id === 'fu-c51');
  assert.strictEqual(fu.status, 'SENT', 'C5.1: receipt -> SENT');
  assert.strictEqual(app.store.findAll('messages', m => m.msg_kind === 'care').length, 1);
}

// C5.2: TIMEOUT_UNKNOWN -> PENDING_RECEIPT (không SENT "láo", không blind resend).
function C5_2() {
  const app = new App({ dataDir: dir('p3c-c52'), platformMode: 'hang_forever' });
  msg(app, FB, 'fb-f2', 'nến vanilla giá bao nhiêu?');
  app.gateway.processQueue(); // tin PRICE: TIMEOUT_UNKNOWN (job check +60s chưa chạy, mode vẫn AI)
  const conv = convOf(app, 'fb-f2');
  const cus = cusOf(app, 'fb-f2');
  insertFu(app, conv, cus, 'fu-c52', 'AFTER_DELIVERY_FEEDBACK', 10e3);
  app.clock.advance(app.clock.now() + 10e3);
  app.runDueJobs();

  const fu = app.store.findOne('follow_ups', f => f.follow_up_id === 'fu-c52');
  assert.strictEqual(fu.status, 'PENDING_RECEIPT', 'C5.2: timeout unknown -> PENDING_RECEIPT (trước đây SENT vô điều kiện)');
  const careExec = app.store.findOne('action_executions', e => e.exec_id === fu.exec_id);
  assert.strictEqual(careExec.status, 'TIMEOUT_UNKNOWN', 'exec của follow-up TIMEOUT_UNKNOWN');
  assert.strictEqual(app.store.findAll('messages', m => m.msg_kind === 'care').length, 1, 'đúng 1 lần gọi platform cho follow-up');
}

// C5.3: definite failure (5xx) -> FAILED + worklist.
function C5_3() {
  const app = new App({ dataDir: dir('p3c-c53'), platformMode: 'fail_5xx' });
  msg(app, FB, 'fb-f3', 'nến vanilla giá bao nhiêu?');
  app.drain(); // PRICE fail rõ; mode vẫn AI (fail không takeover)
  const conv = convOf(app, 'fb-f3');
  const cus = cusOf(app, 'fb-f3');
  insertFu(app, conv, cus, 'fu-c53', 'AFTER_DELIVERY_FEEDBACK', 10e3);
  app.clock.advance(app.clock.now() + 10e3);
  app.runDueJobs();

  const fu = app.store.findOne('follow_ups', f => f.follow_up_id === 'fu-c53');
  assert.strictEqual(fu.status, 'FAILED', 'C5.3: definite fail -> FAILED');
  assert.strictEqual(fu.cancel_reason, 'send_failed');
  assert.ok(app.metric('follow_up_failed') >= 1, 'metric follow_up_failed++');
  assert.ok(app.store.findAll('worklist', w => w.reason === 'follow_up_send_failed').length >= 1, 'worklist cho follow-up FAIL');
}

// C5.4: 2 follow-up KHÁC follow_up_id cùng text -> 2 intent riêng -> 2 sends.
function C5_4() {
  const app = new App({ dataDir: dir('p3c-c54') });
  msg(app, FB, 'fb-f4', 'nến vanilla giá bao nhiêu?');
  app.drain();
  const conv = convOf(app, 'fb-f4');
  const cus = cusOf(app, 'fb-f4');
  const fu1 = insertFu(app, conv, cus, 'fu-c54-a', 'AFTER_DELIVERY_FEEDBACK', 60e3);
  const fu2 = insertFu(app, conv, cus, 'fu-c54-b', 'AFTER_DELIVERY_FEEDBACK', 60e3);
  const before = app.platform.sentCalls.length;

  const r1 = app.gate.sendFollowUp({ followUp: fu1, conversation: conv, customer: cus });
  const r2 = app.gate.sendFollowUp({ followUp: fu2, conversation: conv, customer: cus });
  assert.strictEqual(r1.sent, true, 'C5.4: fu#1 gửi');
  assert.strictEqual(r2.sent, true, 'C5.4: fu#2 gửi (khác id = intent riêng)');
  assert.strictEqual(app.platform.sentCalls.length, before + 2, 'C5.4: đúng 2 platform call (text giống nhau không nuốt)');
  const k1 = app.store.findOne('action_executions', e => e.exec_id === r1.exec_id).idempotency_key;
  const k2 = app.store.findOne('action_executions', e => e.exec_id === r2.exec_id).idempotency_key;
  assert.notStrictEqual(k1, k2, 'idem key theo follow_up_id — khác nhau');
  assert.ok(k1.endsWith('follow_up:fu-c54-a') && k2.endsWith('follow_up:fu-c54-b'), 'key = send:<conv>:follow_up:<id> (KHÔNG theo text)');
}

// C5.5: retry CÙNG follow_up_id -> đúng 1 send (idempotent).
function C5_5() {
  const app = new App({ dataDir: dir('p3c-c55') });
  msg(app, FB, 'fb-f5', 'nến vanilla giá bao nhiêu?');
  app.drain();
  const conv = convOf(app, 'fb-f5');
  const cus = cusOf(app, 'fb-f5');
  const fu = insertFu(app, conv, cus, 'fu-c55', 'AFTER_DELIVERY_FEEDBACK', 60e3);
  const before = app.platform.sentCalls.length;

  const r1 = app.gate.sendFollowUp({ followUp: fu, conversation: conv, customer: cus });
  const r2 = app.gate.sendFollowUp({ followUp: fu, conversation: conv, customer: cus });
  assert.strictEqual(r1.sent, true);
  assert.strictEqual(r2.duplicate, true, 'C5.5: retry trùng follow_up_id -> DUPLICATE_SUPPRESSED');
  assert.strictEqual(app.platform.sentCalls.length, before + 1, 'C5.5: đúng 1 send');
  assert.strictEqual(app.store.findAll('outbound_pending', o => o.exec_id === r1.exec_id).length, 1, '1 op row');
}

// C5.6: follow-up rơi DLQ (receipt không bao giờ về) -> FAILED + ACK_DLQ gửi ĐÚNG 1 lần.
function C5_6() {
  const app = new App({ dataDir: dir('p3c-c56'), platformMode: 'hang_forever' });
  msg(app, FB, 'fb-f6', 'nến vanilla giá bao nhiêu?');
  app.gateway.processQueue(); // xử lý tin PRICE (timeout) — conv/customer đã có trong store
  const conv = convOf(app, 'fb-f6');
  const cus = cusOf(app, 'fb-f6');
  insertFu(app, conv, cus, 'fu-c56', 'AFTER_DELIVERY_FEEDBACK', 10e3);
  app.drain(); // fu timeout -> 3 lần check -> DLQ (gốc + fu + ack-exec) + ACK 1 lần

  const ackText = renderSystemTemplate('ACK_DLQ');
  assert.strictEqual(app.platform.sentCalls.filter(c => c.text === ackText).length, 1, 'C5.6: ACK_DLQ gửi ĐÚNG 1 lần');
  const fu = app.store.findOne('follow_ups', f => f.follow_up_id === 'fu-c56');
  assert.strictEqual(fu.status, 'FAILED', 'C5.6: follow-up hết receipt -> FAILED (KHÔNG SENT)');
  assert.ok(app.store.findAll('dlq', d => d.fail_reason === 'NO_RECEIPT_AFTER_3_CHECKS').length >= 2, 'DLQ: tin gốc + follow-up');
  assert.strictEqual(convOf(app, 'fb-f6').mode, 'HUMAN', 'operator tiếp quản');
  assert.ok(app.metric('dlq_ack_sent') >= 1, 'metric dlq_ack_sent++');
}

// ============================================================ SENDPOLICY MỘT CHỖ (Bước 6)
// C6.1: mọi ràng buộc duyệt tại ĐÚNG MỘT entry point authorize() — window/quota/opt-out/
// actor/state trả reason thống nhất; output ALLOW mang evidence window/quota.
function C6_1() {
  const app = new App({ dataDir: dir('p3c-c61') });
  // set quota TRƯỚC khi có tin nào -> budget khởi tạo đúng theo platform (đọc động, không cache)
  app.platform.setQuota('zl-s6a', 0);
  app.platform.setQuota('zl-s6b', 2);
  msg(app, FB, 'fb-s6', 'nến vanilla giá bao nhiêu?');
  msg(app, ZL, 'zl-s6a', 'nến vanilla giá bao nhiêu?'); // remain 0 -> bị chặn cứng, budget 0
  msg(app, ZL, 'zl-s6b', 'nến vanilla giá bao nhiêu?'); // remain 2 -> low, budget 2
  app.drain();
  app.advance(25 * 3600e3); // window FB đóng

  const convFb = convOf(app, 'fb-s6');
  const cusFb = cusOf(app, 'fb-s6');
  const convZa = convOf(app, 'zl-s6a');
  const cusZa = cusOf(app, 'zl-s6a');
  const convZb = convOf(app, 'zl-s6b');
  const cusZb = cusOf(app, 'zl-s6b');

  const A = o => app.gate.authorize(o);
  const base = { actionType: 'SEND_MESSAGE' };
  // (1) window đóng + bot -> reject duy nhất tại authorize
  assert.strictEqual(A({ ...base, conversation: convFb, customer: cusFb, msgKind: 'ai_reply', actor: 'ai' }).reason, 'fb_window_closed');
  // (2) bot tự gắn human_agent -> spoofed
  assert.strictEqual(A({ ...base, conversation: convFb, customer: cusFb, msgKind: 'ai_reply', actor: 'human_agent' }).reason, 'human_agent_spoofed');
  // (3) system + ai_reply -> tuyệt đối (P3A giữ nguyên)
  assert.strictEqual(A({ ...base, conversation: convFb, customer: cusFb, msgKind: 'ai_reply', actor: 'system' }).reason, 'system_ai_reply');
  // (4) opt-out chặn marketing (mọi actor) — check TRƯỚC window
  cusFb.marketing_opt_out = 1;
  assert.strictEqual(A({ ...base, conversation: convFb, customer: cusFb, msgKind: 'marketing', actor: 'ai' }).reason, 'opt_out');
  cusFb.marketing_opt_out = 0;
  // (5) utility mock-approved -> cho phép ngoài window, output ghi window_open=false
  const util = A({ ...base, conversation: convFb, customer: cusFb, msgKind: 'transactional', actor: 'system', templateId: 'ACK_DLQ', renderedText: renderSystemTemplate('ACK_DLQ') });
  assert.strictEqual(util.ok, true, 'utility mock-approved -> ALLOW');
  assert.strictEqual(util.window_open, false, 'output ALLOW ghi rõ window_open=false');
  // (6) zalo quota: remain 0 -> exhausted; remain 2 -> low + hold
  assert.strictEqual(A({ ...base, conversation: convZa, customer: cusZa, msgKind: 'ai_reply', actor: 'ai' }).reason, 'zalo_quota_exhausted');
  const low = A({ ...base, conversation: convZb, customer: cusZb, msgKind: 'ai_reply', actor: 'ai' });
  assert.strictEqual(low.reason, 'zalo_quota_low');
  assert.strictEqual(low.hold, true, 'quota low -> HOLD (chuyển human), không phải REJECT cứng');
  // (7) zalo transactional -> KHÔNG đụng quota (không có reason quota)
  const txn = A({ ...base, conversation: convZa, customer: cusZa, msgKind: 'transactional', actor: 'ai' });
  assert.strictEqual(txn.ok, true, 'transactional không tốn CS quota (B8)');
}

// ============================================================ HARNESS
const TESTS = [
  { n: 'C1.1', bl: 'BL-1', desc: 'vừa nhắn <24h AUTO->ALLOW; last_user_event_ts do gateway ghi; bot send/receipt không refresh', fn: C1_1 },
  { n: 'C1.2', bl: 'BL-1', desc: 'im >24h ai_reply -> REJECT fb_window_closed, 0 platform call', fn: C1_2 },
  { n: 'C1.3', bl: 'BL-1', desc: 'follow-up care/marketing ngoài 24h -> HELD; khách nhắn lại -> gửi đúng 1 lần', fn: C1_3 },
  { n: 'C1.4', bl: 'BL-1', desc: 'utility template mock-approved (ACK_DLQ) -> ALLOW; care không lách được', fn: C1_4 },
  { n: 'C1.5', bl: 'BL-1', desc: 'bot gắn human_agent ở mode AI -> REJECT; người thật mode HUMAN -> ALLOW', fn: C1_5 },
  { n: 'C2.1', bl: 'BL-2', desc: 'remain=8 -> send; remain -> 7 (budget + platform)', fn: C2_1 },
  { n: 'C2.2', bl: 'BL-2', desc: 'remain=2 -> NEEDS_HUMAN (không auto, không trừ); follow-up -> HELD', fn: C2_2 },
  { n: 'C2.3', bl: 'BL-2', desc: 'remain=0 -> REJECT cứng, 0 platform call', fn: C2_3 },
  { n: 'C2.4', bl: 'BL-2', desc: '2 worker "đồng thời" remain=1 -> exactly 1 send (nguyên tử)', fn: C2_4 },
  { n: 'C2.5', bl: 'BL-2', desc: 'transactional đúng kind -> KHÔNG trừ CS quota (B8)', fn: C2_5 },
  { n: 'C2.6', bl: 'BL-2', desc: 'gom tin: cap 2 tin CS/turn; remain thấp -> gộp còn 1/turn', fn: C2_6 },
  { n: 'C3.1', bl: 'BL-5', desc: 'send chưa receipt -> SENT_PENDING_RECEIPT + outbound_pending PENDING', fn: C3_1 },
  { n: 'C3.2', bl: 'BL-5', desc: 'receipt tới -> DELIVERED (message + op + exec DONE)', fn: C3_2 },
  { n: 'C3.3', bl: 'BL-5', desc: 'duplicate receipt (resend webhook) -> idempotent, không double-match', fn: C3_3 },
  { n: 'C3.4', bl: 'BL-5', desc: 'receipt lạ (conv lạ / ngoài window) -> không gắn nhầm', fn: C3_4 },
  { n: 'C3.5', bl: 'BL-5', desc: 'không bao giờ có receipt -> max attempts -> DLQ + HUMAN, không blind resend', fn: C3_5 },
  { n: 'C4.1', bl: 'BL-6', desc: 'cross-product price (145000=giá trà) -> OVERRIDE, không lọt', fn: C4_1 },
  { n: 'C4.2', bl: 'BL-6', desc: 'giá subject (185000) -> ALLOW', fn: C4_2 },
  { n: 'C4.3', bl: 'BL-6', desc: 'tổng đơn snapshot + tổng giỏ (tổ hợp, kèm fee) -> ALLOW', fn: C4_3 },
  { n: 'C4.4', bl: 'BL-6', desc: 'phí ship 25000 có evidence -> ALLOW', fn: C4_4 },
  { n: 'C4.5', bl: 'BL-6', desc: '1 câu sai + 2 câu đúng -> chỉ câu sai bị thay bằng render DB', fn: C4_5 },
  { n: 'C5.1', bl: 'BL-7', desc: 'success: PENDING_RECEIPT trước -> receipt -> SENT', fn: C5_1 },
  { n: 'C5.2', bl: 'BL-7', desc: 'TIMEOUT_UNKNOWN -> PENDING_RECEIPT (không SENT vô điều kiện)', fn: C5_2 },
  { n: 'C5.3', bl: 'BL-7', desc: 'definite fail (5xx) -> FAILED + worklist', fn: C5_3 },
  { n: 'C5.4', bl: 'BL-7', desc: '2 follow-up khác ID cùng text -> 2 sends (idem theo follow_up_id)', fn: C5_4 },
  { n: 'C5.5', bl: 'BL-7', desc: 'retry cùng follow_up_id -> 1 send', fn: C5_5 },
  { n: 'C5.6', bl: 'BL-7', desc: 'DLQ -> follow-up FAILED + ACK_DLQ đúng 1 lần', fn: C5_6 },
  { n: 'C6.1', bl: 'P3C', desc: 'SendPolicy một chỗ: window/quota/opt-out/actor/utility duyệt tại authorize', fn: C6_1 },
];

function main() {
  const rows = [];
  let pass = 0;
  for (const t of TESTS) {
    const started = Date.now();
    try {
      t.fn();
      pass += 1;
      rows.push({ n: t.n, bl: t.bl, desc: t.desc, status: 'PASS', note: `${Date.now() - started}ms` });
      console.log(`  [PASS] ${t.n} (${t.bl}) — ${t.desc}`);
    } catch (err) {
      rows.push({ n: t.n, bl: t.bl, desc: t.desc, status: 'FAIL', note: String(err && err.message).split('\n')[0] });
      console.log(`  [FAIL] ${t.n} (${t.bl}) — ${t.desc}\n         -> ${String(err && err.message).split('\n').slice(0, 3).join(' | ')}`);
    }
  }

  console.log('\n================ KẾT QUẢ P3C PLATFORM CONSTRAINTS ================');
  console.log('#'.padEnd(8) + 'BL'.padEnd(6) + 'KẾT QUẢ'.padEnd(8) + 'MÔ TẢ'.padEnd(80) + 'GHI CHÚ');
  console.log('-'.repeat(124));
  for (const r of rows) {
    console.log(String(r.n).padEnd(8) + String(r.bl).padEnd(6) + r.status.padEnd(8) + r.desc.slice(0, 78).padEnd(80) + r.note.slice(0, 30));
  }
  console.log('-'.repeat(124));
  console.log(`TỔNG: ${pass}/${TESTS.length} PASS, ${TESTS.length - pass} FAIL`);
  console.log(pass === TESTS.length
    ? '==> P3C ' + TESTS.length + '/' + TESTS.length + ' — 5 BLOCKER NỀN TẢNG ĐÓNG (prototype-mock).'
    : '==> CHƯA ĐẠT, cần sửa các test FAIL phía trên.');
  process.exitCode = pass === TESTS.length ? 0 : 1;
}

main();
