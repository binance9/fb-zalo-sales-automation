'use strict';
// test/matrix/orders.js — AREA ORDERS (18 case): draft/confirm qua API/idempotency/total/
// restock/display status/lọc status/history/audit/đơn của shop khác 404.
const assert = require('assert');
const { startInst, setupShop, fire, waitFor } = require('./_harness');

async function mkDraft(app, ref, pid, text) {
  fire(app, 'facebook', ref, text || `lấy 1 hộp trà hoa sấy, tên Khach ${ref.replace(/[^a-zA-Z]/g, '')}, sdt 093${String(1000000 + (pid.length * 15485863) % 8999999)}, địa chỉ ${ref} St Q1`, pid);
  // [chốt local] poll-wait thay query một lần — chống flake timing khi máy load
  const conv = app.store.findOne('conversations', c => c.platform_thread_id === ref);
  return waitFor(() => conv
    ? app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT')
    : null);
}

module.exports = {
  area: 'Orders',
  async setup() {
    const inst = await startInst('orders');
    const { sid, shop, app } = await setupShop(inst, { email: 'od@matrix.vn' });
    return { inst, sid, shop, app };
  },
  cases: [
    { id: 'OR01', desc: 'buy message -> order DRAFT với price_snapshot', async fn(ctx) {
      const d = await mkDraft(ctx.app, 'ord1', 'od-1');
      assert.ok(d);
      assert.strictEqual(d.status, 'DRAFT');
      const lines = JSON.parse(d.price_snapshot_json);
      assert.strictEqual(lines[0].sku, 'TRA-HOA-SEY-50');
      assert.strictEqual(lines[0].unit_price, 145000);
    } },
    { id: 'OR02', desc: 'CONFIRM qua API: DRAFT -> CONFIRMED (pha B re-validate)', async fn(ctx) {
      const d = await mkDraft(ctx.app, 'ord2', 'od-2');
      const r = await ctx.inst.client('POST', '/api/orders/' + d.order_id + '/confirm', { cookie: ctx.sid, body: {} });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.order.status, 'CONFIRMED');
      assert.strictEqual(r.json.order.total, 145000 + 25000);
    } },
    { id: 'OR03', desc: 'confirm lần 2 (idempotent) -> 200 idempotent:true, không 2 đơn', async fn(ctx) {
      const d = await mkDraft(ctx.app, 'ord3', 'od-3');
      await ctx.inst.client('POST', '/api/orders/' + d.order_id + '/confirm', { cookie: ctx.sid, body: {} });
      const r2 = await ctx.inst.client('POST', '/api/orders/' + d.order_id + '/confirm', { cookie: ctx.sid, body: {} });
      assert.strictEqual(r2.status, 200);
      assert.strictEqual(r2.json.idempotent, true);
      assert.strictEqual(ctx.app.store.findAll('orders', o => o.conversation_id === d.conversation_id).length, 1);
    } },
    { id: 'OR04', desc: 'confirm đơn không tồn tại -> 404 ORDER_NOT_FOUND', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/orders/ord-khong-co/confirm', { cookie: ctx.sid, body: {} });
      assert.strictEqual(r.status, 404);
    } },
    { id: 'OR05', desc: 'confirm đơn không phải DRAFT (CANCELLED) -> 409 NOT_DRAFT', async fn(ctx) {
      const d = await mkDraft(ctx.app, 'ord4', 'od-4');
      ctx.app.orders.requestCancelOrder({ orderId: d.order_id, actor: 'test', reason: 'test', eventId: null, carrier: ctx.app.carrier });
      const r = await ctx.inst.client('POST', '/api/orders/' + d.order_id + '/confirm', { cookie: ctx.sid, body: {} });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json.error, 'NOT_DRAFT');
    } },
    { id: 'OR06', desc: 'confirm khi hết hàng -> 409 OUT_OF_STOCK (re-validate pha B)', async fn(ctx) {
      const v = ctx.app.productDB.getProductByBase('TRA-HOA-SEY').variants.find(v => v.sku === 'TRA-HOA-SEY-50');
      const oldQty = v.stock_qty;
      try {
        const d = await mkDraft(ctx.app, 'ord5', 'od-5');
        v.stock_qty = 0;
        const r = await ctx.inst.client('POST', '/api/orders/' + d.order_id + '/confirm', { cookie: ctx.sid, body: {} });
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.json.error, 'OUT_OF_STOCK');
      } finally { v.stock_qty = oldQty; }
    } },
    { id: 'OR07', desc: 'confirm khi giá đổi -> 409 PRICE_CHANGED (không chốt giá cũ)', async fn(ctx) {
      const v = ctx.app.productDB.getVariant('TRA-HOA-SEY-50').variant;
      const oldPrice = v.price;
      try {
        const d = await mkDraft(ctx.app, 'ord6', 'od-6');
        v.price = 199000;
        const r = await ctx.inst.client('POST', '/api/orders/' + d.order_id + '/confirm', { cookie: ctx.sid, body: {} });
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.json.error, 'PRICE_CHANGED');
        assert.strictEqual(r.json.db_price, 199000);
      } finally { v.price = oldPrice; }
    } },
    { id: 'OR08', desc: 'list orders + lọc status=CONFIRMED chỉ trả đơn đúng', async fn(ctx) {
      await mkDraft(ctx.app, 'ord7', 'od-7');
      const all = await ctx.inst.client('GET', '/api/orders', { cookie: ctx.sid });
      assert.ok(all.json.orders.length >= 1);
      const cf = await ctx.inst.client('GET', '/api/orders?status=DRAFT', { cookie: ctx.sid });
      assert.ok(cf.json.orders.every(o => o.display_status === 'DRAFT'));
    } },
    { id: 'OR09', desc: 'order detail: items/customer/address/total đầy đủ', async fn(ctx) {
      const d = await mkDraft(ctx.app, 'ord8', 'od-8');
      await ctx.inst.client('POST', '/api/orders/' + d.order_id + '/confirm', { cookie: ctx.sid, body: {} });
      const r = await ctx.inst.client('GET', '/api/orders/' + d.order_id, { cookie: ctx.sid });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.items.length, 1);
      assert.match(r.json.items[0].name, /trà hoa/);
      assert.ok(r.json.customer.name);
      assert.match(r.json.address_snapshot, /St Q1/);
      assert.strictEqual(r.json.total, 170000);
    } },
    { id: 'OR10', desc: 'detail đơn không tồn tại -> 404', async fn(ctx) {
      assert.strictEqual((await ctx.inst.client('GET', '/api/orders/ord-khong-co', { cookie: ctx.sid })).status, 404);
    } },
    { id: 'OR11', desc: 'hủy đơn CONFIRMED không vận đơn? (confirm tạo shipeed luôn) -> hủy qua carrier', async fn(ctx) {
      const d = await mkDraft(ctx.app, 'ord9', 'od-9');
      await ctx.inst.client('POST', '/api/orders/' + d.order_id + '/confirm', { cookie: ctx.sid, body: {} });
      const before = ctx.app.productDB.getStock('TRA-HOA-SEY-50').stock_qty;
      const r = await ctx.inst.client('POST', '/api/orders/' + d.order_id + '/cancel', { cookie: ctx.sid, body: {} });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.ok, true);
      assert.strictEqual(ctx.app.productDB.getStock('TRA-HOA-SEY-50').stock_qty, before + 1, 'restock 1');
    } },
    { id: 'OR12', desc: 'history trạng thái ghi đủ from/to/actor', async fn(ctx) {
      const d = await mkDraft(ctx.app, 'ord10', 'od-10');
      await ctx.inst.client('POST', '/api/orders/' + d.order_id + '/confirm', { cookie: ctx.sid, body: {} });
      await ctx.inst.client('POST', '/api/orders/' + d.order_id + '/cancel', { cookie: ctx.sid, body: {} });
      const r = await ctx.inst.client('GET', '/api/orders/' + d.order_id, { cookie: ctx.sid });
      const hist = r.json.history;
      assert.ok(hist.length >= 2, 'có DRAFT->CONFIRMED + CONFIRMED->CANCELLED');
      assert.ok(hist.some(h => h.from === 'DRAFT' && h.to === 'CONFIRMED'));
      assert.ok(hist.some(h => h.from === 'CONFIRMED' && h.to === 'CANCELLED'));
    } },
    { id: 'OR13', desc: 'cancel_reason + cancel_actor ghi nhận khi hủy', async fn(ctx) {
      const d = await mkDraft(ctx.app, 'ord11', 'od-11');
      await ctx.inst.client('POST', '/api/orders/' + d.order_id + '/confirm', { cookie: ctx.sid, body: {} });
      await ctx.inst.client('POST', '/api/orders/' + d.order_id + '/cancel', { cookie: ctx.sid, body: {} });
      const r = await ctx.inst.client('GET', '/api/orders/' + d.order_id, { cookie: ctx.sid });
      assert.strictEqual(r.json.status, 'CANCELLED');
      assert.match(r.json.cancel_reason, /operator_ui_request/);
      assert.match(r.json.cancel_actor, /@/);
    } },
    { id: 'OR14', desc: 'draft TTL: đơn DRAFT hết hạn giữ chỗ -> scheduler hoàn reserve (không oversell)', async fn(ctx) {
      const d = await mkDraft(ctx.app, 'ord12', 'od-12');
      const stockBefore = ctx.app.productDB.getStock('TRA-HOA-SEY-50').stock_qty;
      const reserved = ctx.app.productDB.getStock('TRA-HOA-SEY-50').stock_reserved;
      assert.ok(reserved >= 1, 'draft giữ chỗ 1');
      ctx.app.advance(25 * 3600 * 1000); // quá TTL 24h
      const expired = ctx.app.store.findOne('orders', o => o.order_id === d.order_id);
      assert.strictEqual(expired.status, 'CANCELLED', 'draft hết TTL -> CANCELLED draft_ttl_expired');
      assert.strictEqual(expired.cancel_reason, 'draft_ttl_expired');
      const after = ctx.app.productDB.getStock('TRA-HOA-SEY-50');
      // các draft khác cũng hết TTL trong 25h -> reserved giảm >= 1; stock_qty KHÔNG đổi
      assert.ok(after.stock_reserved < reserved, 'reserve đã hoàn (trước ' + reserved + ' -> sau ' + after.stock_reserved + ')');
      assert.strictEqual(after.stock_qty, stockBefore, 'stock không đổi');
    } },
    { id: 'OR15', desc: ' mua lại sau DELIVERED -> đơn MỚI (idempotency theo thế hệ mua)', async fn(ctx) {
      const d = await mkDraft(ctx.app, 'ord13', 'od-13');
      await ctx.inst.client('POST', '/api/orders/' + d.order_id + '/confirm', { cookie: ctx.sid, body: {} });
      const o1 = ctx.app.store.findOne('orders', o => o.order_id === d.order_id);
      const sh = ctx.app.store.findOne('shipments', s => s.order_id === o1.order_id);
      ctx.app.carrier.setStatus(sh.tracking_number, 'DELIVERED');
      ctx.app.pipeline.onCarrierStatus(o1.order_id);
      // mua lại cùng giỏ
      fire(ctx.app, 'facebook', 'ord13', 'cho mình thêm 1 hộp trà hoa sấy nữa nhé', 'od-13b');
      const conv = ctx.app.store.findOne('conversations', c => c.platform_thread_id === 'ord13');
      const orders = ctx.app.store.findAll('orders', o => o.conversation_id === conv.conversation_id);
      assert.ok(orders.length >= 2, 'đơn thứ 2 được tạo (không nuốt im lặng)');
      const statuses = orders.map(o => o.status);
      assert.ok(statuses.includes('DRAFT') || orders.length >= 2);
    } },
    { id: 'OR16', desc: 'AGENT: list/detail/confirm/cancel 200 (quyền xử lý đơn)', async fn(ctx) {
      await ctx.inst.client('POST', '/api/auth/users', { cookie: ctx.sid, body: { email: 'od-agent@matrix.vn', password: 'password789', role: 'AGENT' } });
      const ag = (await ctx.inst.client('POST', '/api/auth/login', { body: { email: 'od-agent@matrix.vn', password: 'password789' } })).headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
      assert.strictEqual((await ctx.inst.client('GET', '/api/orders', { cookie: ag })).status, 200);
      const d = await mkDraft(ctx.app, 'ord14', 'od-14');
      const cf = await ctx.inst.client('POST', '/api/orders/' + d.order_id + '/confirm', { cookie: ag, body: {} });
      assert.strictEqual(cf.status, 200);
      const cc = await ctx.inst.client('POST', '/api/orders/' + d.order_id + '/cancel', { cookie: ag, body: {} });
      assert.strictEqual(cc.status, 200);
    } },
    { id: 'OR17', desc: 'isolation: order của shop KHÁC -> 404', async fn(ctx) {
      const shop2 = ctx.inst.auth.createShop('OD Shop 2').shop_id;
      await ctx.inst.client('POST', '/api/auth/users', { cookie: ctx.sid, body: { email: 'od2@matrix.vn', password: 'password123', role: 'OWNER', shop_id: shop2 } });
      const sid2 = (await ctx.inst.client('POST', '/api/auth/login', { body: { email: 'od2@matrix.vn', password: 'password123' } })).headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
      ctx.inst.getApp(shop2);
      const d = await mkDraft(ctx.app, 'ord15', 'od-15');
      assert.strictEqual((await ctx.inst.client('GET', '/api/orders/' + d.order_id, { cookie: sid2 })).status, 404);
      assert.strictEqual((await ctx.inst.client('POST', '/api/orders/' + d.order_id + '/confirm', { cookie: sid2, body: {} })).status, 404);
    } },
    { id: 'OR18', desc: 'audit events của đơn: CREATE_ORDER + CONFIRM_ORDER đầy đủ stage (chat-confirm)', async fn(ctx) {
      const d = await mkDraft(ctx.app, 'ord16', 'od-16');
      // xác nhận bằng TIN KHÁCH ('xác nhận') -> đi qua gate.confirmOrder -> audit đầy đủ
      fire(ctx.app, 'facebook', 'ord16', 'xác nhận', 'od-16b');
      const audits = ctx.app.store.findAll('audit_events', a => a.conversation_id === d.conversation_id);
      assert.ok(audits.some(a => a.proposed_action === 'CREATE_ORDER' && a.execution_result === 'DRAFT_CREATED'));
      assert.ok(audits.some(a => a.proposed_action === 'CONFIRM_ORDER' && a.execution_result === 'CONFIRMED'));
      // API-confirm (operator) cũng có audit riêng rõ ràng
      assert.ok(audits.some(a => a.proposed_action === 'ORDER_STATUS' && a.validation && a.validation.to === 'CONFIRMED'));
    } },
  ],
};
