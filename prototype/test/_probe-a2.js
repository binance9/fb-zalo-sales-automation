'use strict';
// _probe-a2.js — probe A làm lại: replay ĐÚNG text gốc + ĐÚNG event (cùng idempotency key).
const path = require('path');
const { App } = require('../src/app');
const DATA = path.join(__dirname, '..', 'data', 'test-runs');
const FB = 'facebook';

const app = new App({ dataDir: path.join(DATA, 'probe-a2'), platformMode: 'hang_forever' });
app.receive({
  channel: FB, type: 'message', platformEventId: 'mid-pa2',
  payload: { customer_ref: 'fb-pa2', thread_id: 'fb-pa2', kind: 'text', text: 'nến vanilla giá bao nhiêu?' },
});
app.gateway.processQueue();
const conv = app.store.findOne('conversations', c => c.platform_thread_id === 'fb-pa2');
const out1 = app.store.findOne('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'out');
const exec1 = app.store.findOne('action_executions', e => e.action_type === 'SEND_MESSAGE');
console.log('lần 1: exec =', exec1.status, '| sentCalls =', app.platform.sentCalls.length, '| delivery =', out1.delivery_status);

// lớp retry "ngây thơ" replay cùng event + cùng text (đúng kịch bản job/crash-retry)
const cus = app.store.findOne('customers', c => c.platform_ref === 'fb-pa2');
const evRow = app.store.findOne('inbox_events', e => e.conversation_id === conv.conversation_id);
const normalized = JSON.parse(evRow.normalized_json);
const r = app.gate.sendReply({
  conversation: conv, customer: cus, event: normalized,
  proposal: { intent: 'PRICE', text: out1.text_content, evidence: { source: 'product_db', replay: true }, confidence: 0.95 },
});
const exec2 = app.store.findOne('action_executions', e => e.exec_id === exec1.exec_id);
const out1b = app.store.findOne('messages', m => m.message_id === out1.message_id);
console.log('sau replay: exec =', exec2.status, '| sentCalls =', app.platform.sentCalls.length, '| delivery =', out1b.delivery_status, '| trả về =', JSON.stringify(r).slice(0, 120));
console.log('=> NGHI VẤN A:', app.platform.sentCalls.length === 2
  ? 'XÁC NHẬN: blind-retry VƯỢT QUẢN idempotency key (2 platform calls) — bug nghiêm trọng'
  : (out1b.delivery_status === 'DELIVERED' && !out1b.receipt_json
      ? 'XÁC NHẬN: không gửi lần 2 (key chặn đúng) NHƯNG lật DELIVERED KHÔNG có receipt'
      : 'không tái hiện — key chặn đúng và verify trung thực'));
