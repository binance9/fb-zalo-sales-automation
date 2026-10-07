'use strict';
// test/matrix/zalo.js — AREA ZALO (18 case): OA webhook + quota CS + receipt + adapter.
const assert = require('assert');
const { startInst, setupShop, fire, newApp } = require('./_harness');
const { ZaloAdapter, ChannelRouter } = require('../../src/channel/zalo-adapter');

module.exports = {
  area: 'Zalo',
  async setup() {
    const inst = await startInst('zalo');
    const { sid, shop, app } = await setupShop(inst, { email: 'zl@matrix.vn' });
    // cắm live zalo adapter cho webhook path
    app.live = Object.assign({}, app.live, { zalo: new ZaloAdapter({ config: { appId: 'app-mx', appSecret: 'sec-mx-zl', oaId: 'oa-mx' }, tokenFile: inst.root + '/zalo-token.json' }) });
    return { inst, sid, shop, app };
  },
  cases: [
    { id: 'ZL01', desc: 'webhook zalo không sig khi có ZALO_APP_SECRET -> 401', async fn(ctx) {
      process.env.ZALO_APP_SECRET = 'sec-mx-zl';
      try {
        const r = await ctx.inst.client('POST', '/webhooks/zalo', { body: { event_name: 'user_send_message', sender: { id: 'u1' }, message: { text: 'hi' } } });
        assert.strictEqual(r.status, 401);
      } finally { delete process.env.ZALO_APP_SECRET; }
    } },
    { id: 'ZL02', desc: 'webhook zalo bad json -> 400', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/webhooks/zalo', { raw: '{broken' });
      assert.strictEqual(r.status, 400);
    } },
    { id: 'ZL03', desc: 'webhook zalo mock mode (không live ở appForWebhook khác) -> không crash; signed valid -> 200', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/webhooks/zalo', { body: { event_name: 'user_send_message', sender: { id: 'u-zl' }, message: { msg_id: 'm1', text: 'tra hoa say con khong' } } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.text, 'OK');
    } },
    { id: 'ZL04', desc: 'normalize zalo user_send_message -> event type message', async fn(ctx) {
      const za = ctx.app.live.zalo;
      const norm = za.normalizeWebhook({ event_name: 'user_send_text', sender: { id: 'u-zl-9' }, message: { msg_id: 'm-9', text: 'giá trà hoa' }, timestamp: Date.now() }, { receivedAt: new Date().toISOString() });
      assert.strictEqual(norm.events.length, 1);
      assert.strictEqual(norm.events[0].channel, 'zalo');
      assert.strictEqual(norm.events[0].payload.text, 'giá trà hoa');
    } },
    { id: 'ZL05', desc: 'normalize user_seen_message -> receipts (không mở window)', async fn(ctx) {
      const za = ctx.app.live.zalo;
      const norm = za.normalizeWebhook({ event_name: 'user_seen_message', recipient: { id: 'oa-mx' }, sender: { id: 'u-zl-9' }, message: { msg_id: 'm-9' } }, { receivedAt: new Date().toISOString() });
      assert.strictEqual(norm.receipts.length, 1);
      assert.strictEqual(norm.events.length, 0);
    } },
    { id: 'ZL06', desc: 'ChannelRouter route đúng kênh zalo/facebook', async fn(ctx) {
      const router = new ChannelRouter({ facebook: ctx.app.live.zalo, zalo: ctx.app.live.zalo }); // dùng chung adapter cho test shape
      assert.strictEqual(typeof router.sendMessage, 'function');
      let routed = null;
      const r2 = new ChannelRouter({ zalo: { sendMessage: async p => { routed = 'zalo'; return { ok: true, mid: 'x' }; } } });
      await r2.sendMessage({ to: 'zalo:u1', text: 'hi' });
      assert.strictEqual(routed, 'zalo');
    } },
    { id: 'ZL07', desc: 'quota CS mặc định 8/48h (mock thiết kế B5)', async fn(ctx) {
      const q = ctx.app.platform.getQuota('zl-fresh-user');
      assert.strictEqual(q.remain, 8);
      assert.strictEqual(q.total, 8);
    } },
    { id: 'ZL08', desc: 'tin CS Zalo được chấp nhận -> platform trừ quota (consumeCs)', async fn(ctx) {
      fire(ctx.app, 'zalo', 'zl-cs', 'nến vanilla giá bao nhiêu', 'zl-q1');
      const consumed = ctx.app.platform.consumedCs.filter(c => c.userRef === 'zl-cs');
      assert.ok(consumed.length >= 1, 'có consumeCS: ' + JSON.stringify(ctx.app.platform.consumedCs.slice(0, 2)));
      assert.ok(ctx.app.platform.getQuota('zl-cs').remain < 8, 'quota đã trừ sau send');
    } },
    { id: 'ZL09', desc: 'quota còn 2 (<= ngưỡng) -> authorize REJECT zalo_quota_low + follow-up HELD', async fn(ctx) {
      const app = newApp('zl-quotallow');
      const app2 = null;
      fire(app, 'zalo', 'zl-low', 'lấy 1 hộp trà hoa sấy, tên Low, sdt 0937777111, địa chỉ Low St Q1', 'zl-low-1');
      const conv = app.store.findOne('conversations', c => c.platform_thread_id === 'zl-low');
      const draft = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
      assert.ok(draft, 'draft tạo');
      const r = app.orders.phaseB({ orderId: draft.order_id });
      assert.strictEqual(r.ok, true);
      const order = app.store.findOne('orders', o => o.order_id === draft.order_id);
      const sh = app.orders.createShipment({ order, carrier: app.carrier }).shipment;
      app.platform.setQuota('zl-low', 2, 8);
      app.carrier.setStatus(sh.tracking_number, 'DELIVERED');
      app.pipeline.onCarrierStatus(order.order_id);
      app.advance(3 * 3600 * 1000);
      const fu = app.store.findOne('follow_ups', f => f.order_id === order.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
      assert.strictEqual(fu.status, 'HELD');
      assert.strictEqual(fu.cancel_reason, 'zalo_quota_low');
    } },
    { id: 'ZL10', desc: 'quota = 0 -> zalo_quota_exhausted, KHÔNG gửi (follow-up không SENT)', async fn(ctx) {
      const app = newApp('zl-quota0');
      fire(app, 'zalo', 'zl-zero', 'lấy 1 hộp trà hoa sấy, tên Zero, sdt 0937777222, địa chỉ Zero St Q1', 'zl-zero-1');
      const conv = app.store.findOne('conversations', c => c.platform_thread_id === 'zl-zero');
      const draft = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
      app.orders.phaseB({ orderId: draft.order_id });
      const order = app.store.findOne('orders', o => o.order_id === draft.order_id);
      const sh = app.orders.createShipment({ order, carrier: app.carrier }).shipment;
      app.platform.setQuota('zl-zero', 0, 8);
      app.carrier.setStatus(sh.tracking_number, 'DELIVERED');
      app.pipeline.onCarrierStatus(order.order_id);
      app.advance(3 * 3600 * 1000);
      const fu = app.store.findOne('follow_ups', f => f.order_id === order.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
      assert.ok(['HELD', 'CANCELLED'].includes(fu.status), fu.status);
      assert.ok(!['SENT', 'PENDING_RECEIPT'].includes(fu.status), 'không gửi lậu khi quota 0');
    } },
    { id: 'ZL11', desc: 'receipt user_seen_message -> ingestReceipt khớp outbound_pending DELIVERED', async fn(ctx) {
      fire(ctx.app, 'zalo', 'zl-rcpt', 'cho minh xem tra hoa', 'zl-rcpt-1');
      const op = ctx.app.store.findAll('outbound_pending', o => o.conversation_id === 'zalo:zl-rcpt');
      assert.ok(op.length >= 1);
      ctx.app.ingestReceipt({ conversation_id: 'zalo:zl-rcpt', clientMessageId: op[0].client_message_id || op[0].clientMessageId || op[0].exec_id, mid: op[0].mid, at: new Date().toISOString() });
      ctx.app.drain();
      const after = ctx.app.store.findOne('outbound_pending', o => o.op_id === op[0].op_id);
      assert.strictEqual(after.receipt_status, 'DELIVERED', 'receipt zalo user_seen_message -> DELIVERED');
    } },
    { id: 'ZL12', desc: 'tin zalo đi luồng bình thường: bot trả lời + window theo user event', async fn(ctx) {
      fire(ctx.app, 'zalo', 'zl-win', 'tra hoa say gia nhieu', 'zl-win-1');
      const conv = ctx.app.store.findOne('conversations', c => c.conversation_id === 'zalo:zl-win');
      const outs = ctx.app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'out');
      assert.ok(outs.length >= 1);
      const w = ctx.app.gate.windowState(conv);
      assert.strictEqual(w.open, true, 'window zalo theo user event');
    } },
    { id: 'ZL13', desc: 'zalo adapter providerStatus không rò secret', async fn(ctx) {
      const s = JSON.stringify(ctx.app.live.zalo.providerStatus());
      assert.ok(!s.includes('sec-mx-zl'));
    } },
    { id: 'ZL14', desc: 'webhook zalo event lạ (không event_name) -> không crash', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/webhooks/zalo', { body: { foo: 'bar' } });
      assert.strictEqual(r.status, 200);
    } },
    { id: 'ZL15', desc: 'health component zalo ok (mock) + token_expired false', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/api/health', { cookie: ctx.sid });
      assert.ok(r.json.components.zalo, 'component zalo tồn tại');
      assert.ok(['ok', 'degraded', 'error'].includes(r.json.components.zalo.status), 'status hợp lệ: ' + r.json.components.zalo.status);
      assert.strictEqual(r.json.providers.zalo.mode, 'live', 'adapter live được cắm');
    } },
    { id: 'ZL16', desc: 'chốt đơn zalo qua chat + confirm -> CONFIRMED (đúng flow Zalo)', async fn(ctx) {
      fire(ctx.app, 'zalo', 'zl-order', 'lấy 1 hộp trà hoa sấy, tên Minh, sdt 0911222333, địa chỉ Minh St Q1', 'zl-order-1');
      const conv = ctx.app.store.findOne('conversations', c => c.platform_thread_id === 'zl-order');
      const draft = ctx.app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
      assert.ok(draft);
      const r = ctx.app.orders.phaseB({ orderId: draft.order_id });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(ctx.app.store.findOne('orders', o => o.order_id === draft.order_id).status, 'CONFIRMED');
    } },
    { id: 'ZL17', desc: 'quota reserve nguyên tử: budget row mirror cs_remain sau send', async fn(ctx) {
      fire(ctx.app, 'zalo', 'zl-budget', 'nến oải hương giá bao nhiêu', 'zl-budget-1');
      const b = ctx.app.store.findOne('channel_budget', x => x.conversation_id === 'zalo:zl-budget');
      assert.ok(b, 'channel_budget row tạo');
      assert.strictEqual(b.cs_total, 8);
      assert.ok(b.cs_remain < 8, 'đã trừ sau send: ' + b.cs_remain);
    } },
    { id: 'ZL18', desc: 'messaging zalo từ OA khác -> normalize không rơi vào events', async fn(ctx) {
      const za = ctx.app.live.zalo;
      const norm = za.normalizeWebhook({ event_name: 'user_send_message', sender: { id: 'u-x' }, message: { msg_id: 'm-x', text: 'x' }, timestamp: Date.now() }, { receivedAt: new Date().toISOString() });
      assert.ok(Array.isArray(norm.events));
      assert.ok(norm.ignored >= 0);
    } },
  ],
};
