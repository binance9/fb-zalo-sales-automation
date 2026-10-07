'use strict';
// test/matrix/followup.js — AREA FOLLOW-UP (15 case): lập lịch sau giao + 4 gate
// (window/quota/opt-out/receipt) + cấu hình automation áp đúng.
const assert = require('assert');
const { startInst, setupShop, newApp, fire } = require('./_harness');

async function deliveredOrder(app, ref, pid) {
  // FLUSH: đẩy đồng hồ qua các follow-up treo từ đơn trước (chúng rơi HELD do hết cửa sổ
  // và KHÔNG còn kéo nextDueAt) — nếu không, drain sẽ nhảy đồng hồ +48h làm draft mới
  // vừa tạo bị TTL-expired ngay trong cùng lần drain.
  app.clock.advance(app.clock.now() + 50 * 3600 * 1000);
  app.drain({ horizonMs: 0 });
  fire(app, 'facebook', ref, `lấy 1 hộp trà hoa sấy, tên Khach ${ref.replace(/[^a-zA-Z]/g, '')}, sdt 093${String(1000000 + (pid.length * 224737) % 8999999)}, địa chỉ ${ref} St Q1`, pid);
  const conv = app.store.findOne('conversations', c => c.platform_thread_id === ref);
  const draft = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
  assert.ok(draft, 'draft ' + ref);
  const r = app.orders.phaseB({ orderId: draft.order_id });
  assert.ok(r.ok);
  const order = app.store.findOne('orders', o => o.order_id === draft.order_id);
  const ship = app.orders.createShipment({ order, carrier: app.carrier }); // đúng bước routeConfirm
  const sh = ship.shipment;
  app.carrier.setStatus(sh.tracking_number, 'DELIVERED');
  app.pipeline.onCarrierStatus(order.order_id);
  return { conv, order, sh };
}

module.exports = {
  area: 'Follow-up',
  async setup() {
    const inst = await startInst('followup');
    const { sid, shop, app } = await setupShop(inst, { email: 'fu@matrix.vn' });
    return { inst, sid, shop, app };
  },
  cases: [
    { id: 'FU01', desc: 'DELIVERED -> core lập AFTER_DELIVERY_FEEDBACK +2 ngày, SCHEDULED', async fn(ctx) {
      const { order } = await deliveredOrder(ctx.app, 'fu1', 'fu-p1');
      const fu = ctx.app.store.findOne('follow_ups', f => f.order_id === order.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
      assert.ok(fu && fu.status === 'SCHEDULED');
      const days = (Date.parse(fu.scheduled_at) - Date.parse(fu.created_at)) / 86400000;
      assert.ok(Math.abs(days - 2) < 0.01, 'mặc định +2 ngày: ' + days);
    } },
    { id: 'FU02', desc: 'idempotent: onCarrierStatus gọi 2 lần -> vẫn 1 follow-up', async fn(ctx) {
      const { order, sh } = await deliveredOrder(ctx.app, 'fu2', 'fu-p2');
      ctx.app.pipeline.onCarrierStatus(order.order_id);
      ctx.app.pipeline.onCarrierStatus(order.order_id);
      assert.strictEqual(ctx.app.store.findAll('follow_ups', f => f.order_id === order.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK').length, 1);
      void sh;
    } },
    { id: 'FU03', desc: 'automation hours=2 -> scheduled_at bị GHI ĐÈ = created + 2h', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/automation', { cookie: ctx.sid, body: { followup_delivery_hours: 2 } });
      assert.strictEqual(r.status, 200);
      const { order } = await deliveredOrder(ctx.app, 'fu3', 'fu-p3');
      for (let i = 0; i < 10; i++) {
        const fu = ctx.app.store.findOne('follow_ups', f => f.order_id === order.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
        if (fu && Date.parse(fu.scheduled_at) - Date.parse(fu.created_at) < 86400000) {
          const hours = (Date.parse(fu.scheduled_at) - Date.parse(fu.created_at)) / 3600000;
          assert.ok(Math.abs(hours - 2) < 0.02, 'đúng 2h: ' + hours);
          return;
        }
        await new Promise(res => setTimeout(res, 450));
      }
      assert.fail('bộ điều phối không reschedule theo settings');
    } },
    { id: 'FU04', desc: 'review_enabled -> REVIEW_REQUEST tạo 1 row/order (source automation)', async fn(ctx) {
      await ctx.inst.client('POST', '/api/automation', { cookie: ctx.sid, body: { review_enabled: true } });
      const { order } = await deliveredOrder(ctx.app, 'fu4', 'fu-p4');
      for (let i = 0; i < 10; i++) {
        const fu = ctx.app.store.findOne('follow_ups', f => f.order_id === order.order_id && f.kind === 'REVIEW_REQUEST');
        if (fu) { assert.strictEqual(fu.source, 'automation_settings'); assert.strictEqual(fu.status, 'SCHEDULED'); return; }
        await new Promise(res => setTimeout(res, 450));
      }
      assert.fail('REVIEW_REQUEST không được tạo');
    } },
    { id: 'FU05', desc: 'care_enabled=false -> cancel SCHEDULED care (care_disabled_setting)', async fn(ctx) {
      await ctx.inst.client('POST', '/api/automation', { cookie: ctx.sid, body: { care_enabled: false } });
      const { order } = await deliveredOrder(ctx.app, 'fu5', 'fu-p5');
      for (let i = 0; i < 10; i++) {
        const fu = ctx.app.store.findOne('follow_ups', f => f.order_id === order.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
        if (fu && fu.status === 'CANCELLED') { assert.strictEqual(fu.cancel_reason, 'care_disabled_setting'); return; }
        await new Promise(res => setTimeout(res, 450));
      }
      assert.fail('care không bị hủy theo settings');
    } },
    { id: 'FU06', desc: 'care_enabled=true lại -> follow-up mới cho đơn giao sau đó chạy bình thường', async fn(ctx) {
      await ctx.inst.client('POST', '/api/automation', { cookie: ctx.sid, body: { care_enabled: true } });
      const { order } = await deliveredOrder(ctx.app, 'fu6', 'fu-p6');
      const fu = ctx.app.store.findOne('follow_ups', f => f.order_id === order.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
      assert.ok(fu && fu.status === 'SCHEDULED');
    } },
    { id: 'FU07', desc: 'WINDOW GATE: 25h không ai nhắn -> HELD fb_window_closed (không gửi)', async fn(ctx) {
      const { order } = await deliveredOrder(ctx.app, 'fu7', 'fu-p7');
      ctx.app.advance(25 * 3600 * 1000);
      const fu = ctx.app.store.findOne('follow_ups', f => f.order_id === order.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
      assert.strictEqual(fu.status, 'HELD');
      assert.strictEqual(fu.cancel_reason, 'fb_window_closed');
    } },
    { id: 'FU08', desc: 'khách nhắn lại -> follow-up HELD kích hoạt + SENT (BL-1)', async fn(ctx) {
      fire(ctx.app, 'facebook', 'fu7', 'shop ơi mình nhận được rồi nè', 'fu-p7b');
      ctx.app.advance(60 * 1000);
      const fu = ctx.app.store.findOne('follow_ups', f => f.order_id === 'fu7-order' || true);
      void fu;
      const conv = ctx.app.store.findOne('conversations', c => c.platform_thread_id === 'fu7');
      const fu2 = ctx.app.store.findOne('follow_ups', f => f.conversation_id === conv.conversation_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
      assert.ok(['SENT', 'PENDING_RECEIPT', 'DELIVERED'].includes(fu2.status), fu2.status + '/' + fu2.cancel_reason);
    } },
    { id: 'FU09', desc: 'receipt: follow-up SENT chỉ khi platform xác nhận giao (inbound)', async fn(ctx) {
      ctx.app.advance(30 * 1000);
      const conv = ctx.app.store.findOne('conversations', c => c.platform_thread_id === 'fu7');
      const fu = ctx.app.store.findOne('follow_ups', f => f.conversation_id === conv.conversation_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
      assert.strictEqual(fu.status, 'SENT', 'receipt về -> SENT');
      const msg = ctx.app.store.findAll('messages', m => m.conversation_id === conv.conversation_id
        && m.direction === 'out' && (m.text_content || '').includes('đã nhận được chưa'));
      assert.ok(msg.length >= 1, 'tin care nằm trong inbox');
    } },
    { id: 'FU10', desc: 'OPT-OUT: marketing follow-up của khách opt-out -> CANCELLED opt_out (core gate)', async fn(ctx) {
      const app = newApp('fu-optout');
      fire(app, 'facebook', 'fuo1', 'lấy 1 hộp trà hoa sấy, tên OptOut, sdt 0936666001, địa chỉ OptOut Q1', 'fuo-1');
      const conv = app.store.findOne('conversations', c => c.platform_thread_id === 'fuo1');
      const draft = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
      app.orders.phaseB({ orderId: draft.order_id });
      const order = app.store.findOne('orders', o => o.order_id === draft.order_id);
      const sh = app.orders.createShipment({ order, carrier: app.carrier }).shipment;
      app.carrier.setStatus(sh.tracking_number, 'DELIVERED');
      app.pipeline.onCarrierStatus(order.order_id);
      // opt-out TRƯỚC khi follow-up tới hạn
      fire(app, 'facebook', 'fuo1', 'không nhận khuyến mại nữa nha shop', 'fuo-2');
      const fuM = app.store.insert('follow_ups', {
        follow_up_id: 'fu-fuo-mkt', order_id: order.order_id, conversation_id: conv.conversation_id,
        customer_id: conv.customer_id, kind: 'MARKETING', scheduled_at: app.clock.iso(),
        status: 'SCHEDULED', cancel_reason: null, exec_id: null,
        created_at: app.clock.iso(), updated_at: app.clock.iso(),
      });
      app.advance(60 * 1000);
      assert.strictEqual(app.store.findOne('follow_ups', f => f.follow_up_id === fuM.row.follow_up_id).status, 'CANCELLED', 'gate chặn opt-out');
      assert.strictEqual(app.store.findOne('follow_ups', f => f.follow_up_id === fuM.row.follow_up_id).cancel_reason, 'opt_out');
    } },
    { id: 'FU11', desc: 'opt-out hủy NGAY các MARKETING SCHEDULED đang chờ (pipeline xử lý tín hiệu)', async fn(ctx) {
      const app = newApp('fu-optout2');
      fire(app, 'facebook', 'fuo2', 'lấy 1 hộp trà hoa sấy, tên OptOut2, sdt 0936666002, địa chỉ OptOut2 Q1', 'fuo2-1');
      const conv = app.store.findOne('conversations', c => c.platform_thread_id === 'fuo2');
      app.store.insert('follow_ups', {
        follow_up_id: 'fu-fuo2-mkt', order_id: null, conversation_id: conv.conversation_id,
        customer_id: conv.customer_id, kind: 'MARKETING', scheduled_at: app.clock.iso(),
        status: 'SCHEDULED', cancel_reason: null, exec_id: null,
        created_at: app.clock.iso(), updated_at: app.clock.iso(),
      });
      fire(app, 'facebook', 'fuo2', 'không gửi quảng cáo cho mình nữa nhé', 'fuo2-2');
      assert.strictEqual(app.store.findOne('follow_ups', f => f.follow_up_id === 'fu-fuo2-mkt').status, 'CANCELLED');
      assert.strictEqual(app.store.findOne('customers', c => c.platform_ref === 'fuo2').marketing_opt_out, 1);
    } },
    { id: 'FU12', desc: 'purchase_reminder settings -> MARKETING row theo days (bị gate opt-out nếu có)', async fn(ctx) {
      await ctx.inst.client('POST', '/api/automation', { cookie: ctx.sid, body: { purchase_reminder_enabled: true, purchase_reminder_days: 3 } });
      const { order } = await deliveredOrder(ctx.app, 'fu8', 'fu-p8');
      for (let i = 0; i < 10; i++) {
        const fu = ctx.app.store.findOne('follow_ups', f => f.order_id === order.order_id && f.kind === 'MARKETING');
        if (fu) {
          const days = (Date.parse(fu.scheduled_at) - Date.parse(fu.created_at)) / 86400000;
          assert.ok(Math.abs(days - 3) < 0.01, 'đúng 3 ngày: ' + days);
          return;
        }
        await new Promise(res => setTimeout(res, 450));
      }
      assert.fail('purchase reminder không được lập');
    } },
    { id: 'FU13', desc: 'RECEIPT GATE: platform hang_forever -> follow-up KHÔNG bao giờ SENT, rơi DLQ', async fn(ctx) {
      const app = newApp('fu-hang', { platformMode: 'hang_forever' });
      fire(app, 'facebook', 'fuh1', 'lấy 1 hộp trà hoa sấy, tên HangFU, sdt 0936666003, địa chỉ HangFU Q1', 'fuh-1');
      const conv = app.store.findOne('conversations', c => c.platform_thread_id === 'fuh1');
      const draft = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
      app.orders.phaseB({ orderId: draft.order_id });
      app.advance(3 * 3600 * 1000); // receipt job fail -> DLQ + follow-up FAILED (BL-7)
      const fu = app.store.findAll('follow_ups', f => f.conversation_id === conv.conversation_id);
      assert.ok(fu.every(f => f.status !== 'SENT'), 'không có SENT khi không có bằng chứng');
      const dlq = app.store.findAll('dlq', () => true);
      assert.ok(dlq.length >= 1, 'DLQ có hàng sau receipt timeout');
    } },
    { id: 'FU14', desc: 'GET /api/automation view khớp settings đã lưu', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/api/automation', { cookie: ctx.sid });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.automation.followup_delivery_hours, 2);
      assert.strictEqual(r.json.automation.purchase_reminder_days, 3);
      assert.strictEqual(r.json.automation.care_enabled, true);
    } },
    { id: 'FU15', desc: 'automation BAD input -> 400 (hours ngoài dải)', async fn(ctx) {
      assert.strictEqual((await ctx.inst.client('POST', '/api/automation', { cookie: ctx.sid, body: { followup_delivery_hours: 0 } })).status, 400);
      assert.strictEqual((await ctx.inst.client('POST', '/api/automation', { cookie: ctx.sid, body: { followup_delivery_hours: 99999 } })).status, 400);
      assert.strictEqual((await ctx.inst.client('POST', '/api/automation', { cookie: ctx.sid, body: { purchase_reminder_days: 400 } })).status, 400);
    } },
  ],
};
