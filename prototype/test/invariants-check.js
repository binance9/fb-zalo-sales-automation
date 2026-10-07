'use strict';
// test/invariants-check.js — FAILURE INJECTION vòng 2 (Reviewer 3): phá hệ thống có chủ đích
// để chứng minh 6 vùng rủi ro cao được phòng thủ THẬT theo HARD INVARIANTS INV-1..INV-5
// (docs/00-yeu-cau.md) + spec docs/AI3-backend-reliability.md.
//
// Mỗi vùng: bắn lỗi vào đúng đường (mock platform/carrier hang, event trùng xen kẽ trễ,
// bắn trùng key, đổi giá/tồn giữa chat và chốt, LLM stub bịa giá, takeover giữa chừng)
// rồi assert hệ thống phản ứng ĐÚNG. Exit 0 khi 6/6 vùng PASS.
//
// Chạy:  node test/invariants-check.js
// Evidence: stdout + data/test-runs/inv-*/ (db.json + audit.jsonl của từng kịch bản).

const path = require('path');
const assert = require('assert');
const { App } = require('../src/app');
const { SAFE_REPLIES } = require('../src/action-gate');
const { renderSystemTemplate } = require('../src/system-templates');

const DATA = path.join(__dirname, '..', 'data', 'test-runs');
const FB = 'facebook';
const dir = name => path.join(DATA, name);

let pid = 0;
function msg(app, channel, ref, text, extra = {}) {
  pid += 1;
  return app.receive({
    channel,
    type: 'message',
    platformEventId: extra.pid || `mid-inv-${ref}-${pid}`,
    payload: {
      customer_ref: ref,
      thread_id: extra.thread || ref,
      kind: extra.kind || 'text',
      text: text || '',
      media: extra.media,
      platform_message_id: `pm-inv-${pid}`,
    },
  });
}

const convOf = (app, ref) => app.store.findOne('conversations', c => c.platform_thread_id === ref);
const cusOf = (app, ref) => app.store.findOne('customers', c => c.platform_ref === ref);
const outMsgs = (app, ref) => {
  const conv = convOf(app, ref);
  return conv ? app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'out') : [];
};
const stock = (app, sku) => app.productDB.getStock(sku);

const BUY_VANILLA = 'lấy 1 nến vanilla M đỏ, tên Anh Bảo, sdt 0901111222, địa chỉ 12 Nguyễn Trãi Q1 TP.HCM';

// Mua + xác nhận -> đơn CONFIRMED (mua bằng ref riêng trong app đang cho)
function buyAndConfirm(app, ref, buyText) {
  msg(app, FB, ref, buyText || BUY_VANILLA);
  app.drain();
  msg(app, FB, ref, 'xác nhận');
  app.drain();
  const conv = convOf(app, ref);
  const orders = app.store.findAll('orders', o => o.conversation_id === conv.conversation_id && o.status === 'CONFIRMED');
  assert.ok(orders.length >= 1, `buyAndConfirm(${ref}): chưa có đơn CONFIRMED`);
  return orders[orders.length - 1];
}

function assertNoOversell(app) {
  for (const v of app.productDB.allVariants()) {
    assert.ok(v.variant.stock_qty >= 0, `oversell stock_qty ${v.variant.sku} = ${v.variant.stock_qty}`);
    assert.ok(v.variant.stock_qty - (v.variant.stock_reserved || 0) >= 0, `tồn hiệu dụng âm ${v.variant.sku}`);
  }
}

// ============================================================ VÙNG 1 — DUPLICATE EVENT (INV-1)
// Phá: bắn CÙNG event 6 lần — liền kề, xen kẽ trễ 5'/30' (đã PROCESSED rồi vẫn resend),
// kèm injection worker ném exception (event gần như bị xử lý 0 lần).
function area1() {
  // (a) trùng xen kẽ trễ: lần 2..6 đều phải bị loại tại cửa vào, đúng 1 lần xử lý
  const app = new App({ dataDir: dir('inv-01a') });
  const ev = () => ({
    channel: FB, type: 'message', platformEventId: 'mid-inv1-001',
    payload: { customer_ref: 'fb-i1', thread_id: 'fb-i1', kind: 'text', text: 'nến vanilla giá bao nhiêu?' },
  });
  const r1 = app.receive(ev());
  app.drain();                       // xử lý xong lần 1
  app.advance(5 * 60e3);             // trễ 5 phút — nền tảng resend
  const r2 = app.receive(ev());
  app.drain();
  const r3 = app.receive(ev());
  const r4 = app.receive(ev());      // bắn 2 lần liền trong cùng tick
  app.drain();
  app.advance(30 * 60e3);            // trễ 30 phút — resend sau khi đã PROCESSED lâu
  const r5 = app.receive(ev());
  const r6 = app.receive(ev());
  app.drain();

  for (const [name, r] of [['r1', r1], ['r2', r2], ['r3', r3], ['r4', r4], ['r5', r5], ['r6', r6]]) {
    assert.strictEqual(r.http, 200, `${name}: HTTP 200`);
    assert.strictEqual(r.duplicate, name !== 'r1', `${name}: duplicate=${r.duplicate}`);
  }
  assert.strictEqual(app.store.findAll('inbox_events', e => e.event_id === 'facebook:mid-inv1-001').length, 1, 'inbox_events đúng 1 dòng');
  const conv = convOf(app, 'fb-i1');
  assert.strictEqual(app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'in').length, 1, '1 tin in');
  assert.strictEqual(outMsgs(app, 'fb-i1').length, 1, '1 tin out');
  assert.strictEqual(app.store.findAll('action_executions', e => e.action_type === 'SEND_MESSAGE' && e.status === 'DONE').length, 1, 'đúng 1 exec send DONE');
  assert.strictEqual(app.store.findAll('ai_proposals', p => p.intent === 'PRICE').length, 1, 'AI chạy đúng 1 lần');
  assert.strictEqual(app.metric('dedupe_hit'), 5, 'dedupe_hit = 5 (5 lần trùng)');
  assert.strictEqual(app.platform.sentCalls.length, 1, 'platform nhận đúng 1 call gửi');

  // (b) cùng platformEventId KHÁC kênh -> event_id khác -> KHÔNG bị dedupe nhầm
  const zr = app.receive({ channel: 'zalo', type: 'message', platformEventId: 'mid-inv1-001', payload: { customer_ref: 'zl-i1', text: 'hi' } });
  assert.strictEqual(zr.duplicate, false, 'kênh khác: event_id khác, không dedupe nhầm');

  // (c) injection: worker ném exception — event không được nuốt im lặng (sửa lần 2)
  const app2 = new App({ dataDir: dir('inv-01c1') });
  const orig = app2.pipeline.handleEvent.bind(app2.pipeline);
  let calls = 0;
  app2.pipeline.handleEvent = evv => {
    calls += 1;
    if (calls === 1) throw new Error('inject: LLM provider 500 (lỗi tạm thời)');
    return orig(evv);
  };
  msg(app2, FB, 'fb-i1c', 'nến vanilla giá bao nhiêu?');
  app2.drain();
  assert.strictEqual(convOf(app2, 'fb-i1c').mode, 'AI', 'sự cố tạm thời -> event vẫn được xử lý lại');
  assert.strictEqual(outMsgs(app2, 'fb-i1c').length, 1, 'event retry thành công -> trả lời 1 lần');
  const row = app2.store.findOne('inbox_events', e => e.event_id.startsWith('facebook:mid-inv-fb-i1c'));
  assert.strictEqual(row.status, 'PROCESSED', 'event PROCESSED sau retry');
  assert.ok(row.attempts >= 1 && row.attempts < 3, `attempts ghi nhận ${row.attempts} (< 3)`);

  // (d) injection: worker lỗi PERSISTENT -> retry có hạn rồi FAILED CÓ DẤU (không mất câm)
  const app3 = new App({ dataDir: dir('inv-01c2') });
  app3.pipeline.handleEvent = () => { throw new Error('inject: hỏng vĩnh viễn'); };
  msg(app3, FB, 'fb-i1d', 'nến vanilla giá bao nhiêu?');
  app3.drain();
  const row3 = app3.store.findOne('inbox_events', e => e.event_id.startsWith('facebook:mid-inv-fb-i1d'));
  assert.strictEqual(row3.status, 'FAILED', 'quá 3 lần -> FAILED có dấu, không loop vô hạn');
  assert.ok(row3.fail_reason.includes('inject'), 'fail_reason giữ nguyên văn lỗi');
  assert.strictEqual(app3.metric('event_failed'), 1, 'metric event_failed++');
  assert.strictEqual(outMsgs(app3, 'fb-i1d').length, 0, 'không có tin nào gửi ra khi xử lý thất bại');
  assert.strictEqual(app3.platform.sentCalls.length, 0, 'không có side-effect nào thoát ra');
}

// ============================================================ VÙNG 2 — OUTBOUND UNKNOWN (INV-2)
// Phá: platform treo response (không biết gửi thành công), KHÔNG BAO GIỜ có bằng chứng,
// 5xx rõ ràng; carrier treo cả 2 biến thể (đã tạo / chưa tạo).
function area2() {
  // (a) send timeout + operator takeover TRƯỚC khi check receipt chạy:
  //     takeover KHÔNG được hủy job check_send_receipt (sửa lần 2) -> receipt vẫn được đối chứng
  const app = new App({ dataDir: dir('inv-02a'), platformMode: 'hang_then_deliver', platformLatencyMs: 5000 });
  msg(app, FB, 'fb-i2a', 'nến vanilla giá bao nhiêu?');
  app.gateway.processQueue();          // send -> TIMEOUT_UNKNOWN, job check receipt hẹn +60s
  let exec = app.store.findOne('action_executions', e => e.action_type === 'SEND_MESSAGE');
  assert.strictEqual(exec.status, 'TIMEOUT_UNKNOWN', 'executor -> TIMEOUT_UNKNOWN');
  app.takeover.setTakeover(convOf(app, 'fb-i2a'), 'op1', 'operator_request'); // takeover giữa chừng
  const conv = convOf(app, 'fb-i2a');
  assert.strictEqual(conv.mode, 'HUMAN', 'takeover có hiệu lực');
  const checkJobs = app.store.findAll('jobs', j => j.conversation_id === conv.conversation_id && j.kind === 'check_send_receipt');
  assert.strictEqual(checkJobs.length, 1, 'job check receipt còn nguyên');
  assert.strictEqual(checkJobs[0].status, 'QUEUED', 'job check receipt KHÔNG bị takeover hủy (fix lần 2)');
  app.drain();                          // +5s receipt về, +60s check -> DONE
  exec = app.store.findOne('action_executions', e => e.action_type === 'SEND_MESSAGE');
  assert.strictEqual(exec.status, 'DONE', 'receipt về -> DONE (không gửi lại, không DLQ)');
  assert.strictEqual(outMsgs(app, 'fb-i2a')[0].delivery_status, 'DELIVERED');
  assert.strictEqual(app.platform.sentCalls.length, 1, 'KHÔNG blind-retry: platform nhận đúng 1 call');
  assert.strictEqual(app.store.findAll('dlq', d => d.kind === 'SEND_MESSAGE').length, 0, 'không rơi DLQ vì đã có bằng chứng');

  // (b) hang_forever + takeover sau check#1: 3 lần check vẫn chạy đủ -> DLQ + cảnh báo
  const app2 = new App({ dataDir: dir('inv-02b'), platformMode: 'hang_forever' });
  msg(app2, FB, 'fb-i2b', 'nến vanilla giá bao nhiêu?');
  app2.gateway.processQueue();          // TIMEOUT_UNKNOWN, check#1 +60s
  app2.clock.advance(app2.clock.now() + 61e3);
  app2.runDueJobs();                    // check#1: chưa có receipt -> hẹn check#2
  app2.takeover.setTakeover(convOf(app2, 'fb-i2b'), 'op1', 'operator_request'); // takeover sau check#1
  const conv2 = convOf(app2, 'fb-i2b');
  const jobs2 = app2.store.findAll('jobs', j => j.conversation_id === conv2.conversation_id && j.kind === 'check_send_receipt' && j.status === 'QUEUED');
  assert.strictEqual(jobs2.length, 1, 'check#2 vẫn QUEUED sau takeover (fix lần 2)');
  app2.drain();
  // P3C (BL-5/BL-7 — SỬA TEST CÓ LÝ DO): DLQ giờ kèm ĐÚNG 1 tin ACK_DLQ chống dead-air
  // (V2 B.10.5 bắt buộc "khách nhận >=1 tin ack"); tin gốc vẫn KHÔNG blind-resend.
  const ackText2 = renderSystemTemplate('ACK_DLQ');
  assert.strictEqual(app2.platform.sentCalls.filter(c => c.text !== ackText2).length, 1, '3 lần check KHÔNG kèm gửi lại mù (tin gốc đúng 1 call)');
  assert.strictEqual(app2.platform.sentCalls.filter(c => c.text === ackText2).length, 1, 'DLQ -> ACK_DLQ ĐÚNG 1 lần (chống dead-air)');
  // P3C ghi chú: platform chết hẳn -> chính ACK cũng không bao giờ có receipt -> ACK cũng rơi
  // DLQ (đúng INV-2). Không blind-resend gì thêm (ACK idem theo conversation).
  assert.ok(app2.store.findAll('dlq', d => d.fail_reason === 'NO_RECEIPT_AFTER_3_CHECKS').length >= 1, 'hết bằng chứng -> DLQ');
  assert.strictEqual(conv2.mode, 'HUMAN', 'mode HUMAN');
  assert.ok(app2.store.findAll('worklist', w => w.reason === 'send_timeout_no_receipt').length >= 1, 'operator được cảnh báo');

  // (c) 5xx THẤT BÁI RÕ: không retry mù, không nuốt im lặng (fix lần 2: metric + cảnh báo)
  const app3 = new App({ dataDir: dir('inv-02c'), platformMode: 'fail_5xx' });
  msg(app3, FB, 'fb-i2c', 'nến vanilla giá bao nhiêu?');
  app3.gateway.processQueue();
  assert.strictEqual(app3.platform.sentCalls.length, 1, '5xx: không gửi lại lần nào');
  const exec3 = app3.store.findOne('action_executions', e => e.action_type === 'SEND_MESSAGE');
  assert.strictEqual(exec3.status, 'FAILED', 'thất bại rõ -> FAILED (không phải UNKNOWN)');
  assert.strictEqual(app3.metric('send_failed'), 1, 'metric send_failed++ (trước đây bị nuốt im lặng)');
  assert.ok(app3.store.findAll('worklist', w => String(w.reason).startsWith('send_failed')).length >= 1, 'operator được cảnh báo tin thất bại');
  app3.drain();
  assert.strictEqual(app3.platform.sentCalls.length, 1, 'drain tiếp vẫn không retry');

  // (d) carrier: timeout -> blind-retry BỊ CHẶN; reconcile ALREADY_EXISTS -> tracking cũ;
  //     NOT_EXISTS -> retry AN TOÀN dùng lại CÙNG idempotency key; không bao giờ 2 vận đơn
  const app4 = new App({ dataDir: dir('inv-02d'), carrierMode: 'hang' });
  const order = buyAndConfirm(app4, 'fb-i2d');
  assert.strictEqual(order.status, 'CONFIRMED');
  assert.strictEqual(app4.store.findAll('dlq', d => d.fail_reason === 'RETRY_BLOCKED_NO_RECEIPT').length, 1, 'blind-retry thiếu receipt -> CHẶN + DLQ');
  assert.strictEqual(app4.carrier.createCalls.length, 1, 'mock nhận đúng 1 create');
  assert.strictEqual(app4.store.findAll('shipments', s => s.order_id === order.order_id).length, 1, 'chỉ 1 vận đơn');
  assert.strictEqual(app4.store.findOne('action_executions', e => e.idempotency_key === `shipment:${order.order_id}`).status, 'DONE', 'reconcile ALREADY_EXISTS -> DONE');

  const app5 = new App({ dataDir: dir('inv-02e'), carrierMode: 'flaky_once' });
  const order2 = buyAndConfirm(app5, 'fb-i2e');
  assert.strictEqual(app5.carrier.createCalls.length, 2, 'NOT_EXISTS -> retry đúng 1 lần');
  assert.ok(app5.carrier.createCalls.every(c => c.idempotencyKey === `shipment:${order2.order_id}`), 'retry DÙNG LẠI idempotency key');
  assert.strictEqual(app5.store.findAll('shipments', s => s.order_id === order2.order_id).length, 1, 'không bao giờ 2 vận đơn');
  assert.strictEqual(app5.store.findOne('action_executions', e => e.idempotency_key === `shipment:${order2.order_id}`).status, 'DONE');
}

// ============================================================ VÙNG 3 — DUPLICATE ORDER (INV-3)
// Phá: cùng idempotency key tạo đơn 2 lần (tuần tự + 2 event trong 1 tick);
// đổi SP rồi đổi LẠI (trùng key với đơn đã HỦY — bug thật sửa lần 2); xác nhận 2 lần.
function area3() {
  // (a) tuần tự: gọi createOrder 2 lần cùng key -> chỉ 1 đơn
  const app = new App({ dataDir: dir('inv-03a') });
  msg(app, FB, 'fb-i3a', BUY_VANILLA);
  app.drain();
  const conv = convOf(app, 'fb-i3a');
  const cus = cusOf(app, 'fb-i3a');
  const r2 = app.gate.createOrder({ conversation: conv, customer: cus, event: null });
  assert.ok(r2.ok && r2.idempotent === true, 'lần 2 cùng key -> idempotent hit');
  assert.strictEqual(app.store.findAll('orders', o => o.conversation_id === conv.conversation_id).length, 1, 'chỉ 1 orders row');
  assert.strictEqual(app.store.findAll('order_items', i => i.order_id === r2.order.order_id).length, 1, 'order_items không nhân đôi');
  assert.strictEqual(stock(app, 'NT-VANILLA-M-DO').stock_reserved, 1, 'reserve đúng 1 (không trừ 2)');

  // (b) "đồng thời": 2 event CÙNG giỏ khác platformEventId bắn trong 1 tick -> 1 đơn
  const app2 = new App({ dataDir: dir('inv-03b') });
  msg(app2, FB, 'fb-i3b', BUY_VANILLA, { pid: 'mid-double-1' });
  msg(app2, FB, 'fb-i3b', BUY_VANILLA, { pid: 'mid-double-2' }); // khách bấm send 2 lần
  app2.gateway.processQueue();
  const conv2 = convOf(app2, 'fb-i3b');
  const drafts = app2.store.findAll('orders', o => o.conversation_id === conv2.conversation_id && o.status === 'DRAFT');
  assert.strictEqual(drafts.length, 1, '2 event cùng giỏ trong 1 tick -> vẫn 1 đơn');
  assert.strictEqual(app2.store.findAll('order_items', i => i.order_id === drafts[0].order_id).length, 1, '1 bộ order_items');
  assert.strictEqual(stock(app2, 'NT-VANILLA-M-DO').stock_reserved, 1, 'reserve 1 lần duy nhất');
  assert.strictEqual(outMsgs(app2, 'fb-i3b').filter(m => m.text_content.includes('Tổng cộng')).length, 2, 'bill lặp 2 tin (chấp nhận — đơn vẫn 1)');

  // (c) BUG THẨT (fix lần 2): V1 -> V2 -> V1: key trùng đơn CANCELLED cũ KHÔNG được
  //     "hồi sinh" — phải ra đơn DRAFT mới, xác nhận được luôn.
  const app3 = new App({ dataDir: dir('inv-03c') });
  msg(app3, FB, 'fb-i3c', BUY_VANILLA);
  app3.drain();
  msg(app3, FB, 'fb-i3c', 'thôi lấy hộp trà hoa sấy đi');
  app3.drain();
  msg(app3, FB, 'fb-i3c', 'thôi lấy nến vanilla M đỏ đi');
  app3.drain();
  const conv3 = convOf(app3, 'fb-i3c');
  const v1Orders = app3.store.findAll('orders', o => o.conversation_id === conv3.conversation_id &&
    o.price_snapshot_json.includes('NT-VANILLA-M-DO'));
  assert.strictEqual(v1Orders.length, 2, 'V1: 1 CANCELLED cũ + 1 DRAFT mới');
  const active = v1Orders.filter(o => o.status === 'DRAFT');
  assert.strictEqual(active.length, 1, 'đúng 1 DRAFT active');
  assert.ok(!active[0].status.includes('CANCELLED'), 'KHÔNG hồi sinh đơn CANCELLED (fix lần 2)');
  assert.strictEqual(app3.productDB.getVariant('NT-VANILLA-M-DO').variant.stock_reserved, 1, 'reserve V1 = 1');
  assert.strictEqual(app3.productDB.getVariant('TRA-HOA-SEY-50').variant.stock_reserved, 0, 'reserve V2 đã hoàn');
  msg(app3, FB, 'fb-i3c', 'xác nhận');
  app3.drain();
  const confirmed = app3.store.findAll('orders', o => o.conversation_id === conv3.conversation_id && o.status === 'CONFIRMED');
  assert.strictEqual(confirmed.length, 1, 'khách xác nhận được -> đúng 1 CONFIRMED (không dead-end)');
  assert.strictEqual(stock(app3, 'NT-VANILLA-M-DO').stock_qty, 2, 'V1 3->2 (trừ đúng 1 lần)');

  // (d) xác nhận 2 lần -> phaseB idempotent, không sinh đơn thứ 2
  const app4 = new App({ dataDir: dir('inv-03d') });
  const order4 = buyAndConfirm(app4, 'fb-i3d');
  msg(app4, FB, 'fb-i3d', 'xác nhận');
  app4.drain();
  const all4 = app4.store.findAll('orders', o => o.conversation_id === convOf(app4, 'fb-i3d').conversation_id);
  assert.strictEqual(all4.filter(o => o.status === 'CONFIRMED').length, 1, 'confirm trùng -> vẫn 1 đơn CONFIRMED');
  assert.strictEqual(all4.length, 1, 'không sinh thêm orders row nào');
  assert.ok(all4[0].order_id === order4.order_id, 'đúng đơn cũ (idempotent)');
}

// ============================================================ VÙNG 4 — STOCK/PRICE RACE (INV-4)
// Phá: đổi GIÁ giữa lúc chat và chốt; đổi TỒN về 0 giữa lúc chat và chốt;
// 2 khách cùng giành món cuối trong cùng 1 tick.
function area4() {
  // (a) giá đổi giữa draft và confirm: KHÔNG chốt giá cũ -> hủy draft cũ -> giữ lại
  //     theo giá MỚI NGAY TRƯỚC commit -> khách xác nhận lại -> chốt giá mới (fix lần 2)
  const app = new App({ dataDir: dir('inv-04a') });
  msg(app, FB, 'fb-i4a', BUY_VANILLA);
  app.drain();
  let conv = convOf(app, 'fb-i4a');
  const draft1 = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
  assert.strictEqual(JSON.parse(draft1.price_snapshot_json)[0].unit_price, 185000, 'draft theo giá 185000');
  // can thiệp ngoài: chủ shop đổi giá trên kênh khác TRƯỚC khi khách chốt
  app.productDB.getVariant('NT-VANILLA-M-DO').variant.price = 200000;

  msg(app, FB, 'fb-i4a', 'xác nhận');
  app.drain();
  conv = convOf(app, 'fb-i4a');
  assert.strictEqual(app.store.findOne('orders', o => o.order_id === draft1.order_id).status, 'CANCELLED', 'draft giá cũ bị hủy (không treo reserve)');
  const draft2 = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
  assert.ok(draft2, 'đơn giữ chỗ MỚI theo giá vừa đọc');
  assert.strictEqual(JSON.parse(draft2.price_snapshot_json)[0].unit_price, 200000, 'giá NGAY TRƯỚC commit (200000) được dùng');
  assert.ok(app.store.findOne('ai_proposals', p => p.intent === 'ORDER_REPRICED'), 'audit có ORDER_REPRICED');
  const outs = outMsgs(app, 'fb-i4a');
  assert.ok(outs[outs.length - 1].text_content.includes('225000'), 'khách thấy tổng MỚI 225000');
  assert.ok(!outs[outs.length - 1].text_content.includes('210000'), 'không báo tổng cũ 210000');

  msg(app, FB, 'fb-i4a', 'xác nhận');
  app.drain();
  const confirmed = app.store.findAll('orders', o => o.conversation_id === conv.conversation_id && o.status === 'CONFIRMED');
  assert.strictEqual(confirmed.length, 1, 'chốt lại thành công');
  assert.strictEqual(confirmed[0].total, 225000, 'chốt theo giá mới (200000 + 25000 ship)');
  assert.strictEqual(stock(app, 'NT-VANILLA-M-DO').stock_qty, 2, 'trừ kho đúng 1 lần (hủy rồi chốt)');
  assert.strictEqual(stock(app, 'NT-VANILLA-M-DO').stock_reserved, 0, 'reserve sạch');
  assertNoOversell(app);

  // (b) hết hàng giữa chat và chốt: chốt -> re-validate -> chặn, không oversell
  const app2 = new App({ dataDir: dir('inv-04b') });
  app2.productDB.setStock('NT-VANILLA-M-DO', 1);
  msg(app2, FB, 'fb-i4b', BUY_VANILLA);
  app2.drain();
  app2.productDB.setStock('NT-VANILLA-M-DO', 0); // can thiệp ngoài trước lúc chốt
  msg(app2, FB, 'fb-i4b', 'xác nhận');
  app2.drain();
  const conv2 = convOf(app2, 'fb-i4b');
  assert.ok(!app2.store.findAll('orders', o => o.conversation_id === conv2.conversation_id).some(o => o.status === 'CONFIRMED'), 'KHÔNG chốt khi hết');
  const last2 = outMsgs(app2, 'fb-i4b').pop();
  assert.ok(last2.text_content.includes('hết hàng'), 'báo hết hàng');
  assertNoOversell(app2);

  // (c) 2 khách cùng giành món cuối trong CÙNG 1 tick: 1 thắng, 1 bị chặn
  const app3 = new App({ dataDir: dir('inv-04c') });
  app3.productDB.setStock('NT-VANILLA-M-DO', 1);
  msg(app3, FB, 'fb-i4c-a', 'lấy 1 nến vanilla M đỏ, tên An, sdt 0901111222, địa chỉ 1 Lê Lợi Q1');
  msg(app3, FB, 'fb-i4c-b', 'lấy 1 nến vanilla M đỏ, tên Bình, sdt 0912222333, địa chỉ 5 Trần Phú Q5');
  app3.gateway.processQueue();        // CÙNG tick, tuần tự trong 1 batch
  const draftA = app3.store.findAll('orders', o => o.conversation_id === convOf(app3, 'fb-i4c-a').conversation_id && o.status === 'DRAFT');
  const draftB = app3.store.findAll('orders', o => o.conversation_id === convOf(app3, 'fb-i4c-b').conversation_id);
  assert.strictEqual(draftA.length, 1, 'khách A giữ được chỗ cuối');
  assert.strictEqual(draftB.length, 0, 'khách B bị chặn (không oversell)');
  const lastB = outMsgs(app3, 'fb-i4c-b').pop();
  assert.ok(lastB.text_content.includes('hết hàng'), 'B nhận báo hết hàng');
  assert.strictEqual(stock(app3, 'NT-VANILLA-M-DO').effective, 0, 'tồn hiệu dụng về 0 đúng 1 đơn');
  assert.strictEqual(stock(app3, 'NT-VANILLA-M-DO').stock_reserved, 1, 'reserve đúng 1');
  assertNoOversell(app3);
  msg(app3, FB, 'fb-i4c-a', 'xác nhận');
  app3.drain();
  assert.strictEqual(stock(app3, 'NT-VANILLA-M-DO').stock_qty, 0, 'A chốt -> stock 0 chính xác');
  assertNoOversell(app3);
}

// ============================================================ VÙNG 5 — HALLUCINATED PRICE
// Phá: LLM stub cố báo GIÁ SAI — cả dạng có đơn vị (E2E) lẫn KHÔNG đơn vị và dạng "92.5k"
// (bơm thẳng proposal vào gate — biên hợp đồng LLM->gate). Assert không chuỗi giá sai
// lọt ra NGOÀI (mọi tin out).
function area5() {
  // (a) E2E: stub bịa "GIÁ SỐC 92500đ" -> gate đè bằng giá DB
  const app = new App({ dataDir: dir('inv-05a') });
  msg(app, FB, 'fb-i5a', 'cho hỏi giá sốc của nến vanilla size M với');
  app.drain();
  const prp = app.store.findOne('ai_proposals', p => p.intent === 'PRICE');
  assert.strictEqual(prp.decision, 'OVERRIDDEN', 'gate override lời bịa');
  assert.ok(app.metric('gate_override') >= 1, 'metric gate_override++');
  for (const m of outMsgs(app, 'fb-i5a')) assert.ok(!m.text_content.includes('92500'), 'E2E: không có 92500 trong tin out');

  // (b)+(c)+(d) bơm thẳng gate: lời bịa KHÔNG đơn vị / dạng k / giá thật không đơn vị
  const app2 = new App({ dataDir: dir('inv-05b') });
  msg(app2, FB, 'fb-i5b', 'nến vanilla giá bao nhiêu?');
  app2.drain();
  const conv = convOf(app2, 'fb-i5b');
  const cus = cusOf(app2, 'fb-i5b');
  const facts = app2.pipeline.buildFacts(conv, '');

  const hallucinated = app2.gate.sendReply({
    conversation: conv, customer: cus, event: null,
    proposal: {
      intent: 'PRICE', msgKind: 'ai_reply',
      text: 'Dạ bên em đang có giá 92500 cho nến vanilla M đỏ nha anh ạ!', // KHÔNG có đơn vị tiền
      evidence: { source: 'product_db' }, confidence: 0.99, facts,
    },
  });
  assert.strictEqual(hallucinated.decision, 'OVERRIDDEN', 'giá bịa KHÔNG đơn vị vẫn bị chặn (fix lần 2)');
  assert.ok(hallucinated.text.includes('185000'), 'đè bằng giá DB 185000');
  const val = JSON.parse(app2.store.findAll('ai_proposals', p => p.intent === 'PRICE').pop().validation_json);
  assert.ok(val.bad_money.includes(92500), 'validation ghi số bịa bị chặn');
  assert.ok(val.bare_numbers_in_text.includes(92500), 'bare-number scan ghi nhận');

  const hallucinatedK = app2.gate.sendReply({
    conversation: conv, customer: cus, event: null,
    proposal: { intent: 'PRICE', msgKind: 'ai_reply', text: 'Dạ giá chỉ 92.5k thui nha anh!', evidence: { source: 'product_db' }, confidence: 0.99, facts },
  });
  assert.strictEqual(hallucinatedK.decision, 'OVERRIDDEN', 'dạng "92.5k" bịa cũng bị chặn');

  const legit = app2.gate.sendReply({
    conversation: conv, customer: cus, event: null,
    proposal: { intent: 'PRICE', msgKind: 'ai_reply', text: 'Dạ giá 185000 nha anh!', evidence: { source: 'product_db', variants: [{ sku: 'NT-VANILLA-M-DO', price: 185000 }] }, confidence: 0.99, facts },
  });
  assert.strictEqual(legit.decision, 'AUTO_EXECUTED', 'giá THẬT (có trong DB) không bị chặn nhầm');

  for (const m of outMsgs(app2, 'fb-i5b')) {
    assert.ok(!m.text_content.includes('92500'), `không có 92500 lọt ra ngoài: "${m.text_content.slice(0, 40)}..."`);
    assert.ok(!m.text_content.includes('92.5k'), 'không có 92.5k lọt ra ngoài');
  }
}

// ============================================================ VÙNG 6 — HUMAN TAKEOVER (INV-5)
// Phá: bắn mọi loại auto-action trong lúc HUMAN_OWNED (gửi reply AI, tạo/confirm đơn,
// follow-up marketing/care đến hạn giữa chừng) -> tất cả phải bị KHOÁ; trả quyền ->
// AI chạy lại đúng state cũ + follow-up bị giữ được gửi đúng 1 lần.
function area6() {
  // (a) gọi thẳng gate (bỏ qua pipeline) khi HUMAN: AI send bị REJECT
  const app = new App({ dataDir: dir('inv-06a') });
  msg(app, FB, 'fb-i6a', 'nến vanilla giá bao nhiêu?');
  app.drain();
  const conv = convOf(app, 'fb-i6a');
  const cus = cusOf(app, 'fb-i6a');
  const aiOutBefore = outMsgs(app, 'fb-i6a').filter(m => m.sender === 'ai').length;
  app.takeover.setTakeover(conv, 'op1', 'operator_request');
  const facts = app.pipeline.buildFacts(conv, '');
  const r = app.gate.sendReply({
    conversation: conv, customer: cus, event: null,
    proposal: { intent: 'PRICE', msgKind: 'ai_reply', text: 'Dạ còn hàng nha anh!', evidence: { source: 'product_db' }, confidence: 0.99, facts },
  });
  assert.strictEqual(r.sent, false, 'gate khoá auto-send AI');
  assert.strictEqual(r.reason, 'takeover');
  assert.strictEqual(r.decision, 'REJECTED_BY_GATE');
  assert.ok(app.metric('gate_rejected_takeover') >= 1, 'metric gate_rejected_takeover++');
  assert.strictEqual(outMsgs(app, 'fb-i6a').filter(m => m.sender === 'ai').length, aiOutBefore, 'không có tin AI mới');

  // (b) takeover giữa CONFIRM: create/confirm đơn bị khoá; trả quyền -> chạy tiếp đúng state
  const app2 = new App({ dataDir: dir('inv-06b') });
  msg(app2, FB, 'fb-i6b', BUY_VANILLA);
  app2.drain();
  const conv2 = convOf(app2, 'fb-i6b');
  assert.strictEqual(conv2.state, 'CONFIRM', 'đang ở CONFIRM với draft');
  app2.takeover.setTakeover(conv2, 'op1', 'operator_request');
  const cus2 = cusOf(app2, 'fb-i6b');
  const co = app2.gate.createOrder({ conversation: conv2, customer: cus2, event: null });
  assert.strictEqual(co.ok, false, 'createOrder bị khoá');
  assert.strictEqual(co.reason, 'takeover', 'createOrder reject reason=takeover');
  const cf = app2.gate.confirmOrder({ conversation: conv2, customer: cus2, event: null });
  assert.strictEqual(cf.ok, false, 'confirmOrder bị khoá');
  assert.strictEqual(cf.reason, 'takeover');
  assert.strictEqual(app2.store.findAll('orders', o => o.conversation_id === conv2.conversation_id && o.status === 'CONFIRMED').length, 0, 'không có đơn nào được chốt trong mode HUMAN');
  assert.strictEqual(conv2.state, 'CONFIRM', 'state KHÔNG bị xáo trộn khi bị chặn');

  app2.takeover.handback(conv2, 'op1');
  assert.strictEqual(conv2.mode, 'AI', 'mode về AI');
  assert.strictEqual(conv2.state, 'CONFIRM', 'state giữ nguyên (không reset NEW_LEAD)');
  // trả quyền -> khách xác nhận -> pipeline chạy lại từ đúng state cũ (pha B + vận đơn)
  msg(app2, FB, 'fb-i6b', 'xác nhận');
  app2.drain();
  const confirmed2 = app2.store.findAll('orders', o => o.conversation_id === conv2.conversation_id && o.status === 'CONFIRMED');
  assert.strictEqual(confirmed2.length, 1, 'trả quyền -> confirm chạy lại từ đúng state cũ');
  assert.ok(app2.store.findOne('shipments', s => s.order_id === confirmed2[0].order_id), 'vận đơn tạo bình thường sau handback');

  // (c) follow-up care đến hạn GIỮA lúc HUMAN: bị GIỮ (không gửi, không hủy);
  //     trả quyền -> gửi ĐÚNG 1 lần (fix lần 2)
  const app3 = new App({ dataDir: dir('inv-06c') });
  const order3 = buyAndConfirm(app3, 'fb-i6c');
  const conv3 = convOf(app3, 'fb-i6c');
  app3.store.insert('follow_ups', {
    follow_up_id: 'fu-care-i6c', order_id: order3.order_id, conversation_id: order3.conversation_id,
    customer_id: order3.customer_id, kind: 'AFTER_DELIVERY_FEEDBACK',
    scheduled_at: new Date(app3.clock.now() + 60e3).toISOString(),
    status: 'SCHEDULED', cancel_reason: null, exec_id: null,
    created_at: app3.store.now(), updated_at: app3.store.now(),
  });
  app3.takeover.setTakeover(conv3, 'op1', 'operator_request');
  app3.advance(2 * 3600e3);            // follow-up đến hạn KHI ĐANG HUMAN
  const fu = app3.store.findOne('follow_ups', f => f.follow_up_id === 'fu-care-i6c');
  assert.ok(fu.status === 'HELD' || fu.status === 'SCHEDULED', `follow-up bị GIỮ (status=${fu.status}), không gửi trong HUMAN`);
  assert.strictEqual(app3.store.findAll('messages', m => m.msg_kind === 'care').length, 0, 'không có tin care nào đi ra trong HUMAN');
  assert.ok(app3.store.findAll('audit_events', a => a.execution_result === 'HELD_TAKEOVER').length >= 1, 'audit ghi HELD_TAKEOVER');

  app3.takeover.handback(conv3, 'op1');
  app3.advance(2 * 3600e3);            // trả quyền -> đến hạn lại
  const fu2 = app3.store.findOne('follow_ups', f => f.follow_up_id === 'fu-care-i6c');
  assert.strictEqual(fu2.status, 'SENT', 'sau handback follow-up được gửi');
  assert.strictEqual(app3.store.findAll('messages', m => m.msg_kind === 'care').length, 1, 'đúng 1 tin care');
  app3.advance(24 * 3600e3);
  assert.strictEqual(app3.store.findAll('messages', m => m.msg_kind === 'care').length, 1, 'không có tin thứ 2');

  // (d) template khiếu nại (system, transactional) VẪN được phép trong HUMAN (chính sách)
  const app4 = new App({ dataDir: dir('inv-06d') });
  buyAndConfirm(app4, 'fb-i6d');
  const outBefore = outMsgs(app4, 'fb-i6d').length;
  msg(app4, FB, 'fb-i6d', 'đơn 2 tuần rồi chưa thấy đâu, lừa đảo à?');
  app4.drain();
  const conv4 = convOf(app4, 'fb-i6d');
  assert.strictEqual(conv4.mode, 'HUMAN', 'khiếu nại -> HUMAN');
  const outs = outMsgs(app4, 'fb-i6d');
  assert.strictEqual(outs.length, outBefore + 1, 'duy nhất 1 template an ủi');
  assert.strictEqual(outs[outs.length - 1].sender, 'system', 'template do system gửi trong HUMAN');
  assert.ok(outs[outs.length - 1].text_content.includes('xin lỗi'), 'nội dung template đúng chính sách');
  msg(app4, FB, 'fb-i6d', 'alo?');
  app4.drain();
  assert.strictEqual(outMsgs(app4, 'fb-i6d').length, outs.length, 'tin sau đó: không AI action nào');
  // tin nhân viên vẫn gửi được
  const sent = app4.takeover.agentSend(app4.gate, conv4, cusOf(app4, 'fb-i6d'), 'Dạ em kiểm tra đơn giúp anh ngay ạ!', 'op1');
  assert.ok(sent.sent, 'nhân viên gửi bình thường qua gate');
}

// ============================================================ HARNESS
const AREAS = [
  { n: 1, name: 'INV-1 DUPLICATE EVENT', fn: area1 },
  { n: 2, name: 'INV-2 OUTBOUND UNKNOWN', fn: area2 },
  { n: 3, name: 'INV-3 DUPLICATE ORDER', fn: area3 },
  { n: 4, name: 'INV-4 STOCK/PRICE RACE', fn: area4 },
  { n: 5, name: 'HALLUCINATED PRICE (gate đè DB)', fn: area5 },
  { n: 6, name: 'INV-5 HUMAN TAKEOVER', fn: area6 },
];

function main() {
  let pass = 0;
  for (const a of AREAS) {
    const started = Date.now();
    try {
      a.fn();
      pass += 1;
      console.log(`  [PASS] vùng ${a.n} — ${a.name} (${Date.now() - started}ms)`);
    } catch (err) {
      console.log(`  [FAIL] vùng ${a.n} — ${a.name}\n         -> ${String(err && err.message).split('\n').slice(0, 4).join(' | ')}`);
    }
  }
  console.log('\n=============== KẾT QUẢ FAILURE INJECTION 6 VÙNG ===============');
  console.log(`TỔNG: ${pass}/6 vùng PASS, ${6 - pass} FAIL`);
  console.log(pass === 6 ? '==> 6/6 — CẢ 6 VÙNG RỦI RO CAO ĐƯỢC PHÒNG THỦ THẬT (prototype-mock).' : '==> CHƯA ĐẠT, cần sửa các vùng FAIL phía trên.');
  process.exitCode = pass === 6 ? 0 : 1;
}

main();
