'use strict';
// _probe-bugs.js — script KHÁM PHÁ tạm thời (reviewer 3, vòng 2): thử 3 nghi vấn bug
// bằng failure injection thủ công. File sẽ bị XÓA sau khi chốt kết luận.
const path = require('path');
const { App } = require('../src/app');

const DATA = path.join(__dirname, '..', 'data', 'test-runs');
const FB = 'facebook';
let pid = 0;
function msg(app, channel, ref, text, extra = {}) {
  pid += 1;
  return app.receive({
    channel, type: 'message', platformEventId: `mid-probe-${pid}`,
    payload: { customer_ref: ref, thread_id: extra.thread || ref, kind: 'text', text: text || '' },
  });
}
const convOf = (app, ref) => app.store.findOne('conversations', c => c.platform_thread_id === ref);
const outMsgs = (app, ref) => {
  const conv = convOf(app, ref);
  return conv ? app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'out') : [];
};
const BUY = 'lấy 1 nến vanilla M đỏ, tên Anh Bảo, sdt 0901111222, địa chỉ 12 Nguyễn Trãi Q1 TP.HCM';

// ============ PROBE A: gửi trùng trong cửa sổ UNKNOWN có lật DELIVERED không bằng chứng? ============
console.log('=== PROBE A: duplicate sendReply trong cửa sổ TIMEOUT_UNKNOWN ===');
{
  const app = new App({ dataDir: path.join(DATA, 'probe-a'), platformMode: 'hang_forever' });
  msg(app, FB, 'fb-pa', 'nến vanilla giá bao nhiêu?');
  app.gateway.processQueue(); // xử lý 1 lần -> send timeout -> TIMEOUT_UNKNOWN
  const exec1 = app.store.findOne('action_executions', e => e.action_type === 'SEND_MESSAGE');
  console.log('sau lần 1: exec.status =', exec1.status, '| sentCalls =', app.platform.sentCalls.length, '| delivery_status =', outMsgs(app, 'fb-pa')[0].delivery_status);

  // Lớp retry "ngây thơ" gọi sendReply LẠI với cùng event + text (cùng idempotency key)
  const conv = convOf(app, 'fb-pa');
  const cus = app.store.findOne('customers', c => c.platform_ref === 'fb-pa');
  const ev = app.store.findOne('inbox_events', e => e.conversation_id === conv.conversation_id);
  const normalized = JSON.parse(ev.normalized_json);
  app.gate.sendReply({ conversation: conv, customer: cus, event: normalized, proposal: { intent: 'PRICE', text: 'RETRY-GỬI-LẠI-NGÂY-THƠ', evidence: { source: 'retry_layer' }, confidence: 0.9 } });

  const exec2 = app.store.findOne('action_executions', e => e.action_type === 'SEND_MESSAGE');
  console.log('sau retry mù: exec.status =', exec2.status, '| sentCalls =', app.platform.sentCalls.length, '| delivery_status =', outMsgs(app, 'fb-pa')[0].delivery_status);
  console.log('=> NGHI VẤN A:', exec2.status === 'DONE' && outMsgs(app, 'fb-pa')[0].delivery_status === 'DELIVERED'
    ? 'XÁC NHẬN BUG: lật DONE/DELIVERED KHÔNG có receipt (vi phạm tinh thần INV-2)'
    : 'không tái hiện (cần xem lại)');
}

// ============ PROBE B: mua lại SP sau khi draft bị hủy (đổi SP rồi đổi lại) ====
console.log('\n=== PROBE B: mua lại đúng SP sau khi DRAFT bị CANCELLED ===');
{
  const app = new App({ dataDir: path.join(DATA, 'probe-b') });
  msg(app, FB, 'fb-pb', BUY); app.drain();
  let conv = convOf(app, 'fb-pb');
  console.log('draft 1:', app.store.findAll('orders', o => o.conversation_id === conv.conversation_id).map(o => `${o.status} ${o.idempotency_key}`).join(' | '));

  msg(app, FB, 'fb-pb', 'thôi lấy hộp trà hoa sấy đi'); app.drain();
  conv = convOf(app, 'fb-pb');
  console.log('sau khi đổi sang trà:', app.store.findAll('orders', o => o.conversation_id === conv.conversation_id).map(o => `${o.status} ${o.idempotency_key}`).join(' | '));

  msg(app, FB, 'fb-pb', 'thôi lấy lại nến vanilla M đỏ đi'); app.drain();
  conv = convOf(app, 'fb-pb');
  const orders = app.store.findAll('orders', o => o.conversation_id === conv.conversation_id);
  console.log('sau khi đổi LẠI vanilla:', orders.map(o => `${o.status} ${o.idempotency_key}`).join(' | '));
  const draftActive = orders.find(o => o.status === 'DRAFT');
  console.log('=> NGHI VẤN B:', !draftActive
    ? 'XÁC NHẬN BUG: KHÔNG có DRAFT mới khi mua lại SP cũ (idempotency key bị đơn CANCELLED chiếm vĩnh viễn)'
    : draftActive ? 'có DRAFT mới — không bug' : '?');
  if (draftActive) {
    msg(app, FB, 'fb-pb', 'xác nhận'); app.drain();
    const after = app.store.findAll('orders', o => o.conversation_id === convOf(app, 'fb-pb').conversation_id);
    console.log('sau confirm:', after.map(o => `${o.status} ${o.idempotency_key}`).join(' | '));
  } else {
    // thử xác nhận xem có kẹt không
    msg(app, FB, 'fb-pb', 'xác nhận'); app.drain();
    const outs = outMsgs(app, 'fb-pb');
    console.log('tin cuối:', outs[outs.length - 1].text_content.slice(0, 80));
  }
}

// ============ PROBE C: follow-up tự nổ khi hội thoại đang HUMAN_OWNED? ============
console.log('\n=== PROBE C: follow-up SCHEDULED đến hạn trong lúc mode=HUMAN ===');
{
  const app = new App({ dataDir: path.join(DATA, 'probe-c') });
  msg(app, FB, 'fb-pc', BUY); app.drain();
  const conv = convOf(app, 'fb-pc');
  app.store.insert('follow_ups', {
    follow_up_id: 'fu-probe-care', order_id: null, conversation_id: conv.conversation_id,
    customer_id: conv.customer_id, kind: 'CARE_CHECKIN',
    scheduled_at: new Date(app.clock.now() + 3600e3).toISOString(),
    status: 'SCHEDULED', cancel_reason: null, exec_id: null,
    created_at: app.store.now(), updated_at: app.store.now(),
  });
  const outBefore = outMsgs(app, 'fb-pc').length;
  app.takeover.setTakeover(conv, 'op1', 'operator_request');
  app.advance(2 * 3600e3); // qua mốc hẹn
  const fu = app.store.findOne('follow_ups', f => f.follow_up_id === 'fu-probe-care');
  const outs = outMsgs(app, 'fb-pc');
  console.log('follow_up status =', fu.status, '| cancel_reason =', fu.cancel_reason);
  console.log('số tin out tăng sau takeover:', outs.length - outBefore, '| tin mới nhất sender =', outs[outs.length - 1].sender);
  console.log('=> NGHI VẤN C:', fu.status === 'SENT' || outs.length > outBefore
    ? 'XÁC NHẬN BUG: tin TỰ ĐỘNG đi ra khi đang HUMAN_OWNED (vi phạm INV-5)'
    : 'không tái hiện');
}
