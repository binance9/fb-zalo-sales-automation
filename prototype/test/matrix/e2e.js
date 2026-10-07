'use strict';
// test/matrix/e2e.js — AREA E2E (18 case): các chuỗi đầu-cuối ngắn (khác 5 flow lớn),
// mỗi case là 1 mắt xích chain assert thật qua webhook/API/app.
const assert = require('assert');
const crypto = require('crypto');
const { startInst, setupShop, fire, sleep } = require('./_harness');
const { MetaAdapter } = require('../../src/channel/meta-adapter');

function signed(secret, entry) {
  const raw = JSON.stringify(entry);
  return { raw, sig: 'sha256=' + crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex') };
}
function commentEntry(commentId, userId, text) {
  return { object: 'page', entry: [{ id: 'page-e2e', time: Date.now(), changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: commentId, from: { id: userId }, message: text, post_id: 'post-e2e' } }] }] };
}
async function postWh(ctx, entry) {
  const { raw, sig } = signed('sec-e2e-chain', entry);
  return ctx.inst.client('POST', '/webhooks/meta', { raw, headers: { 'x-hub-signature-256': sig } });
}
async function deliveredOrder(app, ref, pid) {
  fire(app, 'facebook', ref, `lấy 1 hộp trà hoa sấy, tên Khach ${ref.replace(/[^a-zA-Z]/g, '')}, sdt 093${String(1000000 + (pid.length * 67867967) % 8999999)}, địa chỉ ${ref} St Q1`, pid);
  const conv = app.store.findOne('conversations', c => c.platform_thread_id === ref);
  const draft = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
  assert.ok(draft, 'draft ' + ref);
  const r = app.orders.phaseB({ orderId: draft.order_id });
  assert.ok(r.ok);
  const order = app.store.findOne('orders', o => o.order_id === draft.order_id);
  const sh = app.store.findOne('shipments', s => s.order_id === order.order_id);
  app.carrier.setStatus(sh.tracking_number, 'DELIVERED');
  app.pipeline.onCarrierStatus(order.order_id);
  return { conv, order, sh };
}

module.exports = {
  area: 'E2E',
  async setup() {
    const inst = await startInst('e2e');
    const { sid, shop, app } = await setupShop(inst, { email: 'e2e@matrix.vn' });
    app.live = Object.assign({}, app.live, { meta: new MetaAdapter({ config: { appSecret: 'sec-e2e-chain', pageAccessToken: 'ptk-c', verifyToken: 'vt-c' } }) });
    return { inst, sid, shop, app };
  },
  cases: [
    { id: 'E2E-A1', desc: 'chain: comment webhook -> private reply bot (HTTP 200 + tin out)', async fn(ctx) {
      const r = await postWh(ctx, commentEntry('e2e-c1', 'u-ax', 'nến vanilla bao nhiêu shop'));
      assert.strictEqual(r.status, 200);
      ctx.inst.getApp(ctx.shop).drain();
      const conv = ctx.app.store.findOne('conversations', c => c.conversation_id === 'facebook:fbuser:u-ax');
      assert.ok(conv);
      assert.ok(ctx.app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'out').length >= 1);
    } },
    { id: 'E2E-A2', desc: 'chain: comment -> hỏi mua -> chọn variant -> đủ thông tin -> DRAFT', async fn(ctx) {
      fire(ctx.app, 'facebook', 'u-ay', 'lấy 1 nến vanilla', 'ay-1');
      fire(ctx.app, 'facebook', 'u-ay', 'size M màu đỏ', 'ay-2');
      fire(ctx.app, 'facebook', 'u-ay', 'tên Ay, sdt 0931112223, địa chỉ 9 Ay Q1', 'ay-3');
      const conv = ctx.app.store.findOne('conversations', c => c.platform_thread_id === 'u-ay');
      assert.ok(['BUY_INTENT', 'COLLECT_ORDER', 'CONFIRM'].includes(conv.state), 'state=' + conv.state);
      const draft = ctx.app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
      assert.ok(draft, 'draft tạo sau chuỗi 3 tin');
      assert.strictEqual(JSON.parse(draft.price_snapshot_json)[0].sku, 'NT-VANILLA-M-DO');
    } },
    { id: 'E2E-A3', desc: 'chain: DRAFT -> confirm API -> CONFIRMED + shipment tracking', async fn(ctx) {
      const conv = ctx.app.store.findOne('conversations', c => c.platform_thread_id === 'u-ay');
      const draft = ctx.app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
      const r = await ctx.inst.client('POST', '/api/orders/' + draft.order_id + '/confirm', { cookie: ctx.sid, body: {} });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.order.status, 'CONFIRMED');
      assert.match(r.json.shipment.tracking_number, /^MOCK-/);
    } },
    { id: 'E2E-A4', desc: 'chain: carrier DELIVERED -> order DELIVERED -> dashboard doanh thu tăng', async fn(ctx) {
      const conv = ctx.app.store.findOne('conversations', c => c.platform_thread_id === 'u-ay');
      const order = ctx.app.store.findAll('orders', o => o.conversation_id === conv.conversation_id && o.status === 'CONFIRMED')[0];
      const sh = ctx.app.store.findOne('shipments', s => s.order_id === order.order_id);
      ctx.app.carrier.setStatus(sh.tracking_number, 'DELIVERED');
      ctx.app.pipeline.onCarrierStatus(order.order_id);
      assert.strictEqual(ctx.app.store.findOne('orders', o => o.order_id === order.order_id).status, 'DELIVERED');
      const d = await ctx.inst.client('GET', '/api/dashboard', { cookie: ctx.sid });
      assert.ok(d.json.doanhThuHomNay >= order.total, 'doanh thu hôm nay tính từ đơn CONFIRMED/DELIVERED');
    } },
    { id: 'E2E-B1', desc: 'chain: complaint -> claim -> agent send -> closeClaim -> handback -> bot AUTO', async fn(ctx) {
      fire(ctx.app, 'facebook', 'u-bx', 'shop lừa đảo, đơn gì tệ vậy', 'bx-1');
      const conv = ctx.app.store.findOne('conversations', c => c.platform_thread_id === 'u-bx');
      assert.ok(conv.claim && conv.mode === 'HUMAN');
      const send = await ctx.inst.client('POST', '/api/conversations/' + encodeURIComponent(conv.conversation_id) + '/send', { cookie: ctx.sid, body: { text: 'Dạ em kiểm tra ngay ạ' } });
      assert.strictEqual(send.json.sent, true);
      await ctx.inst.client('POST', '/api/conversations/' + encodeURIComponent(conv.conversation_id) + '/close-claim', { cookie: ctx.sid, body: {} });
      await ctx.inst.client('POST', '/api/conversations/' + encodeURIComponent(conv.conversation_id) + '/handback', { cookie: ctx.sid, body: {} });
      fire(ctx.app, 'facebook', 'u-bx', 'cho mình hỏi nến cháy bao lâu', 'bx-2');
      const outs = ctx.app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'out' && m.sender === 'ai');
      assert.ok(outs.length >= 1, 'bot AUTO trả lời lại');
    } },
    { id: 'E2E-C1', desc: 'chain: cancel đơn CONFIRMED (chưa giao) -> carrier -> CANCELLED + restock', async fn(ctx) {
      await flushFollowUps(ctx.app);
      fire(ctx.app, 'facebook', 'u-cx', 'lấy 1 hộp trà hoa sấy, tên Khach ucx, sdt 0931001915, địa chỉ u-cx Street Q1', 'cx-1');
      const conv = ctx.app.store.findOne('conversations', c => c.platform_thread_id === 'u-cx');
      const draft = ctx.app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
      assert.ok(draft, 'draft u-cx');
      const rB = ctx.app.orders.phaseB({ orderId: draft.order_id });
      assert.ok(rB.ok, 'phaseB ' + rB.reason);
      const order = ctx.app.store.findOne('orders', o => o.order_id === draft.order_id);
      ctx.app.orders.createShipment({ order, carrier: ctx.app.carrier });
      const before = ctx.app.productDB.getStock('TRA-HOA-SEY-50').stock_qty;
      const r = ctx.app.orders.requestCancelOrder({ orderId: order.order_id, actor: 'test', reason: 'chain', eventId: null, carrier: ctx.app.carrier });
      assert.strictEqual(r.ok, true, 'cancel ok: ' + JSON.stringify(r.reason || null));
      assert.strictEqual(ctx.app.productDB.getStock('TRA-HOA-SEY-50').stock_qty, before + 1, 'restock +1');
    } },
    { id: 'E2E-C2', desc: 'chain: refuse -> CANCEL_PENDING -> retry (ok) -> CANCELLED (qua API)', async fn(ctx) {
      await flushFollowUps(ctx.app);
      fire(ctx.app, 'facebook', 'u-cy', 'lấy 1 hộp trà hoa sấy, tên Khach ucy, sdt 0931001916, địa chỉ u-cy Street Q1', 'cy-1');
      const conv = ctx.app.store.findOne('conversations', c => c.platform_thread_id === 'u-cy');
      const draft = ctx.app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
      assert.ok(draft, 'draft u-cy');
      const rB = ctx.app.orders.phaseB({ orderId: draft.order_id });
      assert.ok(rB.ok, 'phaseB ' + rB.reason);
      const order = ctx.app.store.findOne('orders', o => o.order_id === draft.order_id);
      ctx.app.orders.createShipment({ order, carrier: ctx.app.carrier });
      // carrier TỪ CHỐI huỷ -> CANCEL_PENDING (không huỷ lửng)
      ctx.app.carrier.cancelMode = 'refuse';
      const c1 = ctx.app.orders.requestCancelOrder({ orderId: order.order_id, actor: 'test', reason: 'chain2', eventId: null, carrier: ctx.app.carrier });
      assert.strictEqual(c1.ok, false);
      assert.strictEqual(ctx.app.store.findOne('orders', o => o.order_id === order.order_id).status, 'CANCEL_PENDING');
      // retry khi carrier VẪN từ chối -> vẫn CANCEL_PENDING
      const rt0 = await ctx.inst.client('POST', '/api/orders/' + order.order_id + '/retry-shipping', { cookie: ctx.sid, body: {} });
      assert.strictEqual(rt0.status, 200);
      assert.strictEqual(rt0.json.order.status, 'CANCEL_PENDING', 'retry refuse -> vẫn pending');
      // carrier chấp nhận -> retry -> CANCELLED
      ctx.app.carrier.cancelMode = 'ok';
      const rt = await ctx.inst.client('POST', '/api/orders/' + order.order_id + '/retry-shipping', { cookie: ctx.sid, body: {} });
      assert.strictEqual(rt.status, 200);
      assert.strictEqual(rt.json.order.status, 'CANCELLED', 'retry ok -> CANCELLED: ' + JSON.stringify(rt.json));
    } },
    { id: 'E2E-D1', desc: 'chain: DELIVERED -> notification order/needs_human xuất hiện khi có sự cố', async fn(ctx) {
      const { order } = await deliveredOrderOk(ctx.app, 'u-dx', 'dx-1');
      // hủy với carrier refuse -> CANCEL_PENDING -> notifications có order_error
      ctx.app.carrier.cancelMode = 'refuse';
      ctx.app.orders.requestCancelOrder({ orderId: order.order_id, actor: 'test', reason: 'noti-chain', eventId: null, carrier: ctx.app.carrier });
      ctx.app.carrier.cancelMode = 'ok';
      const r = await ctx.inst.client('GET', '/api/notifications', { cookie: ctx.sid });
      assert.ok(r.json.notifications.some(n => n.type === 'order_error' && n.message.includes(order.order_code)), JSON.stringify(r.json.notifications.map(n => n.type)));
    } },
    { id: 'E2E-D2', desc: 'chain: mark notifications read -> unread giảm về 0', async fn(ctx) {
      await ctx.inst.client('POST', '/api/notifications/read', { cookie: ctx.sid, body: { all: true } });
      const r = await ctx.inst.client('GET', '/api/notifications', { cookie: ctx.sid });
      assert.strictEqual(r.json.unread, 0);
    } },
    { id: 'E2E-D3', desc: 'chain: health components đủ 8 phần với status hợp lệ', async fn(ctx) {
      const h = await ctx.inst.client('GET', '/api/health', { cookie: ctx.sid });
      const comps = h.json.components;
      for (const k of ['database', 'facebook', 'zalo', 'shipping', 'ai', 'scheduler', 'webhook', 'queue']) {
        assert.ok(comps[k], 'thiếu ' + k);
        assert.ok(['ok', 'degraded', 'error'].includes(comps[k].status), k + '=' + comps[k].status);
      }
    } },
    { id: 'E2E-E1', desc: 'chain: automation settings -> follow-up reschedule (hours áp đúng)', async fn(ctx) {
      await ctx.inst.client('POST', '/api/automation', { cookie: ctx.sid, body: { followup_delivery_hours: 5, review_enabled: false, purchase_reminder_enabled: false } });
      const { order } = await deliveredOrderOk(ctx.app, 'u-ex', 'ex-1');
      for (let i = 0; i < 10; i++) {
        const fu = ctx.app.store.findOne('follow_ups', f => f.order_id === order.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
        if (fu && Date.parse(fu.scheduled_at) - Date.parse(fu.created_at) < 86400000) {
          const hours = (Date.parse(fu.scheduled_at) - Date.parse(fu.created_at)) / 3600000;
          assert.ok(Math.abs(hours - 5) < 0.02, '5h: ' + hours);
          return;
        }
        await sleep(450);
      }
      assert.fail('không reschedule');
    } },
    { id: 'E2E-E2', desc: 'chain: restart dataDir -> đơn + follow-up còn (persist)', async fn(ctx) {
      const { App } = require('../../src/app');
      const app2 = new App({ dataDir: ctx.inst.getApp(ctx.shop).dataDir, persist: true });
      assert.ok(app2.store.findAll('orders', () => true).length >= 3);
      assert.ok(app2.store.findAll('follow_ups', () => true).length >= 1);
    } },
    { id: 'E2E-E3', desc: 'chain: follow-up chạy tiếp sau restart (khách nhắn lại mở cửa sổ -> SENT)', async fn(ctx) {
      const { App } = require('../../src/app');
      const app2 = new App({ dataDir: ctx.inst.getApp(ctx.shop).dataDir, persist: true });
      // khách 'u-ex' nhắn lại trên App MỚI (mở cửa sổ 24h) -> follow-up đã lập được kích hoạt.
      // fu cũ có scheduled_at quá xa (trước restart) -> đặt lại lịch +1h sau lần nhắn này
      // (chỉnh ROW ở tầng test, việc GỬI vẫn do gate quyết định) rồi đẩy đồng hồ tới hạn.
      app2.receive({ channel: 'facebook', type: 'message', platformEventId: 'ex-again', payload: { customer_ref: 'u-ex', thread_id: 'u-ex', kind: 'text', text: 'shop ơi đơn dùng ổn không', platform_message_id: 'pm-ex-again' } });
      app2.drain();
      const fuEx = app2.store.findOne('follow_ups', f => f.conversation_id === 'facebook:u-ex' && f.status === 'SCHEDULED');
      assert.ok(fuEx, 'follow-up u-ex còn SCHEDULED sau restart');
      app2.store.transaction(() => {
        app2.store.updateRow('follow_ups', fuEx, { scheduled_at: new Date(app2.clock.now() + 3600 * 1000).toISOString() });
      });
      app2.clock.advance(app2.clock.now() + 3600 * 1000 + 1000);
      app2.drain({ horizonMs: 0 });
      app2.clock.advance(app2.clock.now() + 30 * 1000); // chờ receipt platform
      app2.drain({ horizonMs: 0 });
      const sent = app2.store.findAll('follow_ups', f => f.status === 'SENT');
      assert.ok(sent.length >= 1, 'có follow-up SENT sau restart+advance: '
        + JSON.stringify(app2.store.findAll('follow_ups', f => f.conversation_id === 'facebook:u-ex').map(f => f.status + '/' + f.cancel_reason)));
    } },
    { id: 'E2E-F1', desc: 'chain: webhook sig sai -> 401 KHÔNG đụng store (không tạo event)', async fn(ctx) {
      const before = ctx.app.store.findAll('inbox_events', () => true).length;
      const raw = JSON.stringify(commentEntry('e2e-bad', 'u-fx', 'hack'));
      const r = await ctx.inst.client('POST', '/webhooks/meta', { raw, headers: { 'x-hub-signature-256': 'sha256=' + 'f'.repeat(64) } });
      assert.strictEqual(r.status, 401);
      assert.strictEqual(ctx.app.store.findAll('inbox_events', () => true).length, before);
    } },
    { id: 'E2E-F2', desc: 'chain: image SP tắt -> NEEDS_HUMAN -> worklist -> notifications needs_human', async fn(ctx) {
      ctx.app.productDB.getProductByBase('NT-VANILLA').enabled = false;
      const r = ctx.app.receive({ channel: 'facebook', type: 'message', platformEventId: 'fx-img', payload: { customer_ref: 'u-fx', thread_id: 'u-fx', kind: 'image', text: '', media: { platform_url: 'https://x/nen-vanilla-m-do.jpg' }, platform_message_id: 'pm-fx-img' } });
      ctx.app.drain();
      const conv = ctx.app.store.findOne('conversations', c => c.conversation_id === 'facebook:u-fx');
      assert.strictEqual(conv.subject_sku, null);
      const notif = await ctx.inst.client('GET', '/api/notifications', { cookie: ctx.sid });
      assert.ok(notif.json.notifications.some(n => n.type === 'needs_human'), 'worklist vào notifications');
      ctx.app.productDB.getProductByBase('NT-VANILLA').enabled = true;
      void r;
    } },
    { id: 'E2E-G1', desc: 'chain: image SP CÒN BÁN -> bot tư vấn tồn (IMAGE_STOCK)', async fn(ctx) {
      ctx.app.productDB.getProductByBase('NT-VANILLA').enabled = true;
      ctx.app.receive({ channel: 'facebook', type: 'message', platformEventId: 'fx-img-ok', payload: { customer_ref: 'u-gx', thread_id: 'u-gx', kind: 'image', text: '', media: { platform_url: 'https://x/nen-vanilla-m-do.jpg' }, platform_message_id: 'pm-fx-img-ok' } });
      ctx.app.drain();
      const conv = ctx.app.store.findOne('conversations', c => c.conversation_id === 'facebook:u-gx');
      assert.strictEqual(conv.subject_sku, 'NT-VANILLA-M-DO');
      const outs = ctx.app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'out');
      assert.ok(outs.length >= 1);
    } },
    { id: 'E2E-G2', desc: 'chain: opt-out -> marketing cancelled + ACK template gửi đúng policy', async fn(ctx) {
      fire(ctx.app, 'facebook', 'u-hx', 'lấy 1 hộp trà hoa sấy, tên Hx, sdt 0934445566, địa chỉ Hx Q1', 'hx-1');
      fire(ctx.app, 'facebook', 'u-hx', 'không nhận khuyến mại nữa nha shop', 'hx-2');
      const conv = ctx.app.store.findOne('conversations', c => c.platform_thread_id === 'u-hx');
      assert.strictEqual(ctx.app.store.findOne('customers', c => c.customer_id === conv.customer_id).marketing_opt_out, 1);
      const ack = ctx.app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.sender === 'system');
      assert.ok(ack.some(m => /KHÔNG gửi tin quảng cáo/.test(m.text_content || '')), 'OPT_OUT_ACK gửi');
    } },
    { id: 'E2E-G3', desc: 'chain: quota zalo -> follow-up không gửi lậu (tổng hợp gate)', async fn(ctx) {
      await flushFollowUps(ctx.app);
      fire(ctx.app, 'zalo', 'u-zx', 'lấy 1 hộp trà hoa sấy, tên Zx, sdt 0934445777, địa chỉ Zx Q1', 'zx-1');
      const conv = ctx.app.store.findOne('conversations', c => c.platform_thread_id === 'u-zx');
      const draft = ctx.app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
      assert.ok(draft, 'draft u-zx');
      ctx.app.orders.phaseB({ orderId: draft.order_id });
      const order = ctx.app.store.findOne('orders', o => o.order_id === draft.order_id);
      const sh = ctx.app.orders.createShipment({ order, carrier: ctx.app.carrier }).shipment;
      ctx.app.platform.setQuota('u-zx', 1, 8);
      ctx.app.carrier.setStatus(sh.tracking_number, 'DELIVERED');
      ctx.app.pipeline.onCarrierStatus(order.order_id);
      ctx.app.advance(3 * 3600 * 1000);
      const fu = ctx.app.store.findOne('follow_ups', f => f.order_id === order.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
      assert.ok(!['SENT', 'PENDING_RECEIPT'].includes(fu.status), 'quota thấp -> không gửi');
    } },
    { id: 'E2E-H1', desc: 'chain: SSE push update kèm unread_by_shop (tick 2s)', async fn(ctx) {
      // KẾT NỐI SSE TRƯỚC, rồi mới fire (broadcast chỉ khi fingerprint đổi sau lúc lắng nghe)
      const http = require('http');
      const got = await new Promise(resolve => {
        const req = http.request({ hostname: '127.0.0.1', port: ctx.inst.server.address().port, path: '/api/events', method: 'GET', headers: { Cookie: 'sid=' + ctx.sid } }, res => {
          let buf = '';
          const timer = setTimeout(() => { req.destroy(); resolve(null); }, 6000);
          res.on('data', c => {
            buf += c;
            // xử lý TỪNG DÒNG (match từ đầu buffer sẽ luôn trả về 'hello' đầu tiên)
            for (;;) {
              const idx = buf.indexOf('\n');
              if (idx < 0) break;
              const line = buf.slice(0, idx).trim();
              buf = buf.slice(idx + 1);
              if (!line.startsWith('data:')) continue;
              try {
                const j = JSON.parse(line.slice(5).trim());
                if (j.type === 'update' && j.unread_by_shop) { clearTimeout(timer); req.destroy(); resolve(j); }
              } catch (e) { /* tiếp tục */ }
            }
          });
        });
        req.end();
        // fire SAU khi đã kết nối
        setTimeout(() => {
          try { fire(ctx.app, 'facebook', 'u-sse', 'shop ơi có nến không', 'sse-1'); } catch (e) { /* ignore */ }
        }, 100);
      });
      assert.ok(got, 'nhận SSE update');
      assert.ok(ctx.shop in got.unread_by_shop, 'unread_by_shop có shop hiện tại');
    } },
  ],
};

// helper: đơn DELIVERED qua luồng chat (dùng text chuẩn slot regex)
async function flushFollowUps(app) {
  // FLUSH an toàn: đẩy đồng hồ qua các follow-up treo (chúng chạy -> HELD vì hết cửa sổ ->
  // không còn kéo nextDueAt). Xử lý CHỈ item ĐẾN HẠN (horizon 0) — cấm drain nhảy tương lai
  // (nhảy tương lai có thể kéo đồng hồ đi LÙI theo fu đã qua -> draft mới chết TTL oan).
  app.clock.advance(app.clock.now() + 50 * 3600 * 1000);
  app.drain({ horizonMs: 0 });
}
async function deliveredOrderOk(app, ref, pid) {
  await flushFollowUps(app);
  fire(app, 'facebook', ref, `lấy 1 hộp trà hoa sấy, tên Khach ${ref.replace(/[^a-zA-Z]/g, '')}, sdt 093${String(1000000 + (pid.length * 479) % 8999999)}, địa chỉ ${ref} Street Q1`, pid);
  const conv = app.store.findOne('conversations', c => c.platform_thread_id === ref);
  const draft = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
  assert.ok(draft, 'draft ' + ref + ' slots=' + JSON.stringify(conv.draft && conv.draft.slots));
  const r = app.orders.phaseB({ orderId: draft.order_id });
  assert.ok(r.ok, 'phaseB ' + r.reason);
  const order = app.store.findOne('orders', o => o.order_id === draft.order_id);
  const ship = app.orders.createShipment({ order, carrier: app.carrier }); // đúng bước routeConfirm
  const sh = ship.shipment;
  app.carrier.setStatus(sh.tracking_number, 'DELIVERED');
  app.pipeline.onCarrierStatus(order.order_id);
  return { conv, order, sh };
}
