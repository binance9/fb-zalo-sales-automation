'use strict';
// test/matrix/shipping.js — AREA SHIPPING (18 case): vận đơn create/cancel/status + carrier
// bất thường (hang/flaky/refuse) + reconcile + tracking hiển thị qua API.
const assert = require('assert');
const { startInst, setupShop, newApp, fire } = require('./_harness');

async function confirmOrder(app, ref, pid) {
  // [TEST-FIX SH05/SH14] FLUSH việc đến hạn trong TƯƠNG LAI trước khi tạo draft mới: các case
  // DELIVERED trước đó (SH04/SH12) lập follow-up +2 ngày; nếu không flush, drain của fire()
  // bên dưới sẽ nhảy đồng hồ ảo tới follow-up đó và expireStaleDrafts (P3B-2 — hành vi core
  // ĐÚNG) hủy draft MỚI vừa tạo vì TTL 24h < bước nhảy 2 ngày. Trên runtime thật (server tick
  // theo giờ thật) không có bước nhảy này — đây là artifact đồng hồ ảo của harness drain.
  app.advance(3 * 24 * 3600 * 1000);
  fire(app, 'facebook', ref, `lấy 1 hộp trà hoa sấy, tên Khach ${ref.replace(/[^a-zA-Z]/g, '')}, sdt 093${String(1000000 + (pid.length * 104729) % 8999999)}, địa chỉ ${ref} St Q1`, pid);
  const conv = app.store.findOne('conversations', c => c.platform_thread_id === ref);
  const draft = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
  assert.ok(draft, 'draft tạo cho ' + ref);
  const r = app.orders.phaseB({ orderId: draft.order_id });
  assert.strictEqual(r.ok, true);
  const order = app.store.findOne('orders', o => o.order_id === draft.order_id);
  // routeConfirm của pipeline cũng tạo vận đơn NGAY sau pha B — helper đi đúng bước đó
  app.orders.createShipment({ order, carrier: app.carrier });
  return order;
}

// [TEST-FIX SH09/SH10] bắn 'xác nhận' đi ĐÚNG luồng khách (routeConfirm: pha B qua gate ->
// createShipment -> TIMEOUT -> blindRetry bị chặn -> job reconcile) nhưng CHỈ processQueue,
// KHÔNG runDueJobs — job reconcile do case tự gọi orders.reconcileShipment thủ công để assert
// đúng nhánh resolved (ALREADY_EXISTS / RETRY_CREATED) trước khi scheduler chạy hộ.
function fireConfirmNoJobs(app, ref, pid) {
  app.receive({
    channel: 'facebook', type: 'message',
    platformEventId: `${pid}-cf-${Math.random().toString(36).slice(2, 8)}`,
    payload: { customer_ref: ref, thread_id: ref, kind: 'text', text: 'xác nhận', platform_message_id: 'pm-' + pid + '-cf' },
  });
  app.gateway.processQueue();
}

module.exports = {
  area: 'Shipping',
  async setup() {
    const inst = await startInst('shipping');
    const { sid, shop, app } = await setupShop(inst, { email: 'sh@matrix.vn' });
    return { inst, sid, shop, app };
  },
  cases: [
    { id: 'SH01', desc: 'confirm -> shipment tự tạo với tracking MOCK-<order_code>', async fn(ctx) {
      const o = await confirmOrder(ctx.app, 'sh1', 'sh-p1');
      const sh = ctx.app.store.findOne('shipments', s => s.order_id === o.order_id);
      assert.ok(sh && sh.tracking_number === 'MOCK-' + o.order_code);
    } },
    { id: 'SH02', desc: 'shipment record có carrier + idempotency key đơn nhất', async fn(ctx) {
      const sh = ctx.app.store.findAll('shipments');
      assert.ok(sh.length >= 1);
      const keys = sh.map(s => s.request_idempotency_key);
      assert.strictEqual(new Set(keys).size, keys.length, 'không trùng key vận đơn');
    } },
    { id: 'SH03', desc: 'carrier.setStatus PICKED_UP -> onCarrierStatus -> display SHIPPING', async fn(ctx) {
      const o = await confirmOrder(ctx.app, 'sh2', 'sh-p2');
      const sh = ctx.app.store.findOne('shipments', s => s.order_id === o.order_id);
      ctx.app.carrier.setStatus(sh.tracking_number, 'PICKED_UP');
      ctx.app.pipeline.onCarrierStatus(o.order_id);
      const rows = await ctx.inst.client('GET', '/api/orders?status=SHIPPING', { cookie: ctx.sid });
      assert.ok(rows.json.orders.some(x => x.order_id === o.order_id), 'đơn hiện SHIPPING theo vận đơn');
    } },
    { id: 'SH04', desc: 'DELIVERED -> order DELIVERED + follow-up lập lịch (core)', async fn(ctx) {
      const o = await confirmOrder(ctx.app, 'sh3', 'sh-p3');
      const sh = ctx.app.store.findOne('shipments', s => s.order_id === o.order_id);
      ctx.app.carrier.setStatus(sh.tracking_number, 'DELIVERED');
      ctx.app.pipeline.onCarrierStatus(o.order_id);
      assert.strictEqual(ctx.app.store.findOne('orders', x => x.order_id === o.order_id).status, 'DELIVERED');
      assert.ok(ctx.app.store.findOne('follow_ups', f => f.order_id === o.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK'));
    } },
    { id: 'SH05', desc: 'carrier hủy được -> CANCELLED qua carrier path (P3B-5)', async fn(ctx) {
      const o = await confirmOrder(ctx.app, 'sh4', 'sh-p4');
      const r = ctx.app.orders.requestCancelOrder({ orderId: o.order_id, actor: 'test', reason: 'test_cancel', eventId: null, carrier: ctx.app.carrier });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.viaCarrier, true);
      assert.strictEqual(ctx.app.store.findOne('orders', x => x.order_id === o.order_id).status, 'CANCELLED');
    } },
    { id: 'SH06', desc: 'carrier REFUSE -> CANCEL_PENDING + needsHuman (không hủy lửng)', async fn(ctx) {
      ctx.app.carrier.cancelMode = 'refuse';
      const o = await confirmOrder(ctx.app, 'sh5', 'sh-p5');
      const r = ctx.app.orders.requestCancelOrder({ orderId: o.order_id, actor: 'test', reason: 'test_cancel', eventId: null, carrier: ctx.app.carrier });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(ctx.app.store.findOne('orders', x => x.order_id === o.order_id).status, 'CANCEL_PENDING');
      assert.ok(ctx.app.store.findAll('worklist', w => w.reason === 'cancel_shipment_rejected').length >= 1);
      ctx.app.carrier.cancelMode = 'ok';
    } },
    { id: 'SH07', desc: 'retry hủy sau refuse (carrier ok) -> CANCELLED (re-arm intent)', async fn(ctx) {
      ctx.app.carrier.cancelMode = 'ok';
      const pending = ctx.app.store.findOne('orders', o => o.status === 'CANCEL_PENDING');
      assert.ok(pending, 'có đơn CANCEL_PENDING từ case trước');
      const exec = ctx.app.store.findOne('action_executions', e => e.idempotency_key === `cancel_shipment:${pending.order_id}`);
      assert.ok(exec, 'exec cũ tồn tại (đã archive attempt)');
      const rt = await ctx.inst.client('POST', '/api/orders/' + pending.order_id + '/retry-shipping', { cookie: ctx.sid, body: {} });
      assert.strictEqual(rt.status, 200);
      assert.strictEqual(rt.json.order.status, 'CANCELLED');
    } },
    { id: 'SH08', desc: 'carrier hang (create TIMEOUT) -> không retry mù: DLQ + needsHuman (case 12)', async fn(ctx) {
      const app = newApp('sh-hang', { carrierMode: 'hang' });
      fire(app, 'facebook', 'shh1', 'lấy 1 hộp trà hoa sấy, tên Hang, sdt 0935550001, địa chỉ Hang Q1', 'shh-1');
      // [TEST-FIX] hoàn tất luồng như khách thật ('xác nhận' -> routeConfirm): pha B qua gate ->
      // createShipment hang -> TIMEOUT_UNKNOWN -> blindRetry BỊ CHẶN -> DLQ + needsHuman
      // (trước đây case chỉ chạy phaseA/phaB thủ công nên chưa hề gọi carrier -> không có DLQ).
      fire(app, 'facebook', 'shh1', 'xác nhận', 'shh-2');
      const conv = app.store.findOne('conversations', c => c.platform_thread_id === 'shh1');
      const order = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'CONFIRMED');
      assert.ok(order, 'đơn CONFIRMED sau confirm');
      const dlq = app.store.findAll('dlq', d => d.kind === 'CREATE_SHIPMENT');
      assert.ok(dlq.length >= 1, 'DLQ có hàng sau blind-retry bị chặn');
      const wl = app.store.findAll('worklist', w => w.reason === 'shipment_timeout_needs_reconcile');
      assert.ok(wl.length >= 1);
    } },
    { id: 'SH09', desc: 'reconcile: carrier thực ra ĐÃ tạo (hang) -> ALREADY_EXISTS dùng lại tracking cũ', async fn(ctx) {
      const app = newApp('sh-recon1', { carrierMode: 'hang' });
      fire(app, 'facebook', 'shr1', 'lấy 1 hộp trà hoa sấy, tên Recon, sdt 0935550002, địa chỉ Recon Q1', 'shr-1');
      // [TEST-FIX] confirm qua routeConfirm (tạo exec TIMEOUT_UNKNOWN thật) nhưng KHÔNG chạy
      // job reconcile (chỉ processQueue) — case tự gọi reconcileShipment để assert nhánh resolved.
      fireConfirmNoJobs(app, 'shr1', 'shr-1');
      const conv = app.store.findOne('conversations', c => c.platform_thread_id === 'shr1');
      const order = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'CONFIRMED');
      const r = app.orders.reconcileShipment({ order, carrier: app.carrier });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.resolved, 'ALREADY_EXISTS');
      assert.ok(r.trackingNumber.startsWith('MOCK-'));
      assert.strictEqual(app.store.findAll('shipments', s => s.order_id === order.order_id).length, 1, 'vẫn đúng 1 vận đơn');
    } },
    { id: 'SH10', desc: 'reconcile: carrier CHƯA tạo (flaky_once) -> RETRY_CREATED cùng idem key', async fn(ctx) {
      const app = newApp('sh-recon2', { carrierMode: 'flaky_once' });
      fire(app, 'facebook', 'shr2', 'lấy 1 hộp trà hoa sấy, tên Flaky, sdt 0935550003, địa chỉ Flaky Q1', 'shr-2');
      // [TEST-FIX] như SH09: exec TIMEOUT_UNKNOWN thật từ routeConfirm, job reconcile chưa chạy.
      fireConfirmNoJobs(app, 'shr2', 'shr-2');
      const conv = app.store.findOne('conversations', c => c.platform_thread_id === 'shr2');
      const order = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'CONFIRMED');
      const r = app.orders.reconcileShipment({ order, carrier: app.carrier });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.resolved, 'RETRY_CREATED');
      assert.strictEqual(app.carrier.createCalls.length, 2, '2 lần create (flaky + retry) cùng key');
      assert.strictEqual(app.carrier.createCalls[0].idempotencyKey, app.carrier.createCalls[1].idempotencyKey);
    } },
    { id: 'SH11', desc: 'createShipment idempotent: gọi lần 2 với cùng order -> done, không tạo vận đơn 2', async fn(ctx) {
      const o = ctx.app.store.findOne('orders', o => o.order_code && o.status === 'CONFIRMED' || o.status === 'SHIPPING');
      const before = ctx.app.store.findAll('shipments', s => s.order_id === o.order_id).length;
      const r = ctx.app.orders.createShipment({ order: o, carrier: ctx.app.carrier });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(ctx.app.store.findAll('shipments', s => s.order_id === o.order_id).length, before);
    } },
    { id: 'SH12', desc: 'mock carrier từ chối hủy đơn ĐÃ GIAO -> CANCEL_PENDING (already_delivered)', async fn(ctx) {
      const o = await confirmOrder(ctx.app, 'sh6', 'sh-p6');
      const sh = ctx.app.store.findOne('shipments', s => s.order_id === o.order_id);
      ctx.app.carrier.setStatus(sh.tracking_number, 'DELIVERED');
      ctx.app.pipeline.onCarrierStatus(o.order_id);
      // giao rồi -> carrier từ chối hủy
      const app2 = null;
      const conv = ctx.app.store.findOne('conversations', c => c.conversation_id === o.conversation_id);
      const r = ctx.app.orders.requestCancelOrder({ orderId: o.order_id, actor: 'test', reason: 'late_cancel', eventId: null, carrier: ctx.app.carrier });
      assert.strictEqual(r.ok, false, 'đơn DELIVERED (status order) -> requestCancel từ chối path');
      void conv;
    } },
    { id: 'SH13', desc: 'API order detail hiển thị shipment (tracking + status + carrier)', async fn(ctx) {
      const rows = await ctx.inst.client('GET', '/api/orders', { cookie: ctx.sid });
      const withSh = rows.json.orders.find(x => x.shipment);
      assert.ok(withSh, 'có đơn có vận đơn');
      const d = await ctx.inst.client('GET', '/api/orders/' + withSh.order_id, { cookie: ctx.sid });
      assert.strictEqual(d.status, 200);
      assert.ok(d.json.shipment.tracking_number);
      assert.ok(d.json.shipment.carrier);
    } },
    { id: 'SH14', desc: 'status UNKNOWN khi chưa set -> display vẫn CONFIRMED (không vỡ)', async fn(ctx) {
      const o = await confirmOrder(ctx.app, 'sh7', 'sh-p7');
      const d = await ctx.inst.client('GET', '/api/orders/' + o.order_id, { cookie: ctx.sid });
      assert.strictEqual(d.json.display_status, 'CONFIRMED');
    } },
    { id: 'SH15', desc: 'carrier.createShipment ĐÒI idempotencyKey (contract AI3 mục 6)', async fn(ctx) {
      assert.throws(() => ctx.app.carrier.createShipment({ clientOrderCode: 'X' }), /thiếu idempotencyKey/);
      assert.throws(() => ctx.app.carrier.cancelShipment({ trackingNumber: 'Y' }), /thiếu idempotencyKey/);
    } },
    { id: 'SH16', desc: 'cancelShipment idempotent: hủy 2 lần cùng key -> 1 receipt', async fn(ctx) {
      const o = await confirmOrder(ctx.app, 'sh8', 'sh-p8');
      const sh = ctx.app.store.findOne('shipments', s => s.order_id === o.order_id);
      const key = 'cancel_shipment:' + o.order_id;
      const r1 = ctx.app.carrier.cancelShipment({ idempotencyKey: key, trackingNumber: sh.tracking_number });
      const r2 = ctx.app.carrier.cancelShipment({ idempotencyKey: key, trackingNumber: sh.tracking_number });
      assert.strictEqual(r1.status, 'CANCELLED');
      assert.strictEqual(r2.status, 'CANCELLED');
      assert.strictEqual(ctx.app.carrier.cancelCalls.filter(c => c.idempotencyKey === key).length, 2);
      assert.strictEqual(r2.receipt_id, r1.receipt_id, 'trả lại receipt cũ (idempotent)');
    } },
    { id: 'SH17', desc: 'health component shipping + webhook ghn mock (chưa nhận webhook -> null)', async fn(ctx) {
      const h = await ctx.inst.client('GET', '/api/health', { cookie: ctx.sid });
      assert.strictEqual(h.json.components.shipping.status, 'ok');
      assert.strictEqual(h.json.components.webhook.ghn, null);
    } },
    { id: 'SH18', desc: 'webhook ghn mock-mode -> 503 rõ ràng', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/webhooks/ghn', { body: {} });
      assert.strictEqual(r.status, 503);
      assert.match(r.text, /ghn/);
    } },
  ],
};
