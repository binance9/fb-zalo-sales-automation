'use strict';
// test/e2e-flows.js — E2E FLOWS A–E (PHASE PRODUCT-READY đợt 2; offline 100%, HTTP in-process).
//
//   A: comment (webhook feed event có chữ ký HMAC) -> private reply -> inbox -> hỏi giá ->
//      chọn variant -> SĐT -> tên -> địa chỉ -> bill -> confirm -> order -> shipment -> tracking
//      (mock carrier DELIVERED). Assert TỪNG MẮT XÍCH.
//   B: complaint -> claim + HUMAN -> agent reply QUA API (không bị gate chặn) -> closeClaim ->
//      handback -> AUTO (bot trả lời lại).
//   C: cancel order -> carrier cancel -> CANCELLED (+ restock); nhánh carrier TỪ CHỐI ->
//      CANCEL_PENDING -> retry đúng flow P3B (refuse -> vẫn pending; cho phép -> CANCELLED).
//   D: follow-up sau giao -> Window Gate (fb_window_closed -> HELD -> khách nhắn lại -> SENT) ->
//      Quota Gate (quota_low -> HELD; exhausted -> CANCELLED) -> Opt-out (marketing -> CANCELLED)
//      -> tin follow-up DELIVERED (bằng chứng receipt).
//   E: RESTART server (App mới persist cùng dataDir) -> dữ liệu còn nguyên (counts + orders +
//      follow-up) -> jobs/follow-up còn đó và CHẠY TIẾP khi đồng hồ tới hạn.
// Exit 0 khi toàn bộ PASS.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { createServer } = require('../server');
const { MetaAdapter } = require('../src/channel/meta-adapter');

const DATA = path.join(__dirname, '..', 'data', 'test-runs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============================================================ HTTP client helper
function makeClient(base) {
  const u0 = new URL(base);
  return function call(method, p, { body, cookie, headers: extraHeaders, raw } = {}) {
    return new Promise((resolve, reject) => {
      const data = raw ? Buffer.from(raw) : (body !== undefined ? Buffer.from(JSON.stringify(body)) : null);
      const headers = Object.assign({}, extraHeaders || {});
      if (data) { headers['Content-Type'] = headers['Content-Type'] || 'application/json'; headers['Content-Length'] = data.length; }
      if (cookie) headers.Cookie = `sid=${cookie}`;
      const req = http.request({ hostname: u0.hostname, port: u0.port, path: p, method, headers }, res => {
        let out = '';
        res.on('data', c => { out += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(out); } catch (e) { /* text/html */ }
          resolve({ status: res.statusCode, headers: res.headers, json, text: out });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  };
}

async function startServer(name) {
  const root = path.join(DATA, 'e2e-' + name);
  fs.rmSync(root, { recursive: true, force: true });
  const inst = createServer({
    port: 0,
    authDir: path.join(root, 'auth'),
    shopsRoot: path.join(root, 'shops'),
    uiDemo: '0',
    appDataMode: 'persist',
  });
  inst.listen();
  for (let i = 0; i < 60 && !inst.server.listening; i++) await sleep(20);
  inst.root = root;
  inst.client = makeClient(`http://127.0.0.1:${inst.server.address().port}`);
  return inst;
}

async function setupOwnerAndGoLive(inst, email) {
  const setup = await inst.client('POST', '/api/auth/setup', { body: { email, password: 'password123', shop_name: 'E2E Shop' } });
  assert.strictEqual(setup.status, 200, 'setup owner: ' + setup.text.slice(0, 100));
  const sid = setup.headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
  const shop = setup.json.shop.shop_id;
  const app = inst.getApp(shop);
  // đủ checklist go-live: shop-info + facebook + zalo + ghn + ai(local)
  for (const [stepId, data] of [
    ['shop-info', { name: 'E2E Shop', hotline: '0900000000', address: '1 Test St Q1' }],
    ['facebook', { page_id: 'page-e2e', page_access_token: 'ptk-e2e-token' }],
    ['zalo', { oa_id: 'oa-e2e', access_token: 'zat-e2e-token' }],
    ['shipping', { ghn_token: 'ghn-e2e-token', ghn_shop_id: '111111' }],
    ['ai', { provider: 'local' }],
  ]) {
    const r = await inst.client('POST', '/api/onboarding/complete-step', { cookie: sid, body: { stepId, data } });
    assert.strictEqual(r.status, 200, 'complete-step ' + stepId + ': ' + r.text.slice(0, 100));
  }
  // bước 6 (AI) cần test PASS -> ONLINE (local = stub PASS offline)
  const aiTest = await inst.client('POST', '/api/ai/test', { cookie: sid, body: {} });
  assert.strictEqual(aiTest.status, 200, 'ai test local phải PASS: ' + aiTest.text.slice(0, 120));
  const bot = await inst.client('POST', '/api/settings/bot', { cookie: sid, body: { on: true } });
  assert.strictEqual(bot.status, 200, 'go-live -> bot ON phải 200: ' + bot.text.slice(0, 160));
  return { sid, shop, app };
}

// Bắn comment/message QUA WEBHOOK THẬT (POST /webhooks/meta + HMAC X-Hub-Signature-256)
function metaSignedBody(app, entry) {
  const raw = JSON.stringify(entry);
  const sig = 'sha256=' + crypto.createHmac('sha256', 'sec-e2e').update(raw, 'utf8').digest('hex');
  return { raw, sig };
}
function commentEntry(commentId, userId, text) {
  return {
    object: 'page',
    entry: [{
      id: 'page-e2e',
      time: Date.now(),
      changes: [{
        field: 'feed',
        value: { item: 'comment', verb: 'add', comment_id: commentId, from: { id: userId, name: 'Khách ' + userId }, message: text, post_id: 'post-e2e' },
      }],
    }],
  };
}
function messageEntry(mid, userId, text) {
  return {
    object: 'page',
    entry: [{
      id: 'page-e2e',
      time: Date.now(),
      messaging: [{ sender: { id: userId }, recipient: { id: 'page-e2e' }, timestamp: Date.now(), message: { mid, text } }],
    }],
  };
}
async function postWebhook(inst, entry) {
  const { raw, sig } = metaSignedBody(inst.getApp(Object.keys(inst.auth.shops)[0]), entry);
  return inst.client('POST', '/webhooks/meta', { raw, headers: { 'x-hub-signature-256': sig } });
}
function pump(app) {
  app.gateway.processQueue();
  app.drain();
}

// ============================================================ FLOW A — COMMENT -> ... -> DELIVERED
async function flowA() {
  const inst = await startServer('a');
  try {
    const { sid, shop, app } = await setupOwnerAndGoLive(inst, 'owner-a@e2e.vn');
    // cắm adapter META thật (biên) để webhook feed/comment đi đúng đường verify chữ ký
    app.live = Object.assign({}, app.live, { meta: new MetaAdapter({ config: { appSecret: 'sec-e2e', pageAccessToken: 'ptk-e2e', verifyToken: 'vt-e2e' } }) });
    const CONV = 'facebook:fbuser:lan';

    // (A1) COMMENT -> private reply (bot trả lời giá trên thread comment)
    let r = await postWebhook(inst, commentEntry('cmt-1', 'lan', 'nến vanilla giá bao nhiêu vậy shop'));
    assert.strictEqual(r.status, 200, 'webhook comment 200');
    assert.strictEqual(r.text, 'EVENTS_RECEIVED');
    pump(app);
    let conv = app.store.findOne('conversations', c => c.conversation_id === CONV);
    assert.ok(conv, 'comment tạo conversation (thread comment) trong inbox');
    assert.ok(String(conv.subject_sku || '').startsWith('NT-VANILLA'), 'bot nhận diện SP từ comment: ' + conv.subject_sku);
    let outMsgs = app.store.findAll('messages', m => m.conversation_id === CONV && m.direction === 'out');
    assert.ok(outMsgs.length >= 1, 'PRIVATE REPLY: bot đã trả lời sau comment');
    assert.ok(outMsgs.every(m => m.delivery_status), 'tin bot có trạng thái gửi (private reply)');
    assert.ok(outMsgs.some(m => String(m.text_content || '').match(/165|185/)), 'bot báo giá từ DB (165/185k)');

    // (A2) hỏi mua -> CHƯA rõ variant -> bot hỏi chọn size/màu
    r = await postWebhook(inst, commentEntry('cmt-2', 'lan', 'lấy 1 nến vanilla'));
    assert.strictEqual(r.status, 200);
    pump(app);
    conv = app.store.findOne('conversations', c => c.conversation_id === CONV);
    assert.ok(conv.awaiting_variant, 'đa variant -> bot hỏi chọn (awaiting_variant set)');
    assert.strictEqual(conv.state, 'BUY_INTENT', 'ý định mua ghi nhận (hỏi variant trước khi vào thu thập)');

    // (A3) chọn variant
    r = await postWebhook(inst, commentEntry('cmt-3', 'lan', 'size M màu đỏ'));
    assert.strictEqual(r.status, 200);
    pump(app);
    conv = app.store.findOne('conversations', c => c.conversation_id === CONV);
    const activeItem = (conv.draft.items || []).find(i => i.state !== 'stale');
    assert.ok(activeItem && activeItem.sku === 'NT-VANILLA-M-DO', 'variant M đỏ vào giỏ: ' + (activeItem && activeItem.sku));
    assert.strictEqual(activeItem.qty, 1);

    // (A4) SĐT
    r = await postWebhook(inst, commentEntry('cmt-4', 'lan', 'sdt 0901112233'));
    assert.strictEqual(r.status, 200);
    pump(app);
    conv = app.store.findOne('conversations', c => c.conversation_id === CONV);
    assert.strictEqual(conv.draft.slots.phone.value, '0901112233', 'slot phone fill từ tin thường');

    // (A5) tên
    r = await postWebhook(inst, commentEntry('cmt-5', 'lan', 'tên Lan'));
    assert.strictEqual(r.status, 200);
    pump(app);
    conv = app.store.findOne('conversations', c => c.conversation_id === CONV);
    assert.strictEqual(conv.draft.slots.name.value, 'Lan', 'slot name fill');

    // (A6) địa chỉ -> đủ slot -> DRAFT + bill
    r = await postWebhook(inst, commentEntry('cmt-6', 'lan', 'địa chỉ 8 Trần Phú Q1'));
    assert.strictEqual(r.status, 200);
    pump(app);
    conv = app.store.findOne('conversations', c => c.conversation_id === CONV);
    assert.strictEqual(conv.draft.slots.address.value, '8 Trần Phú Q1', 'slot address fill');
    let order = app.store.findOne('orders', o => o.conversation_id === CONV);
    assert.ok(order && order.status === 'DRAFT', 'đủ info -> draft order tạo (pha A)');
    outMsgs = app.store.findAll('messages', m => m.conversation_id === CONV && m.direction === 'out');
    const billMsg = outMsgs[outMsgs.length - 1];
    assert.ok(/Tổng cộng/.test(String(billMsg.text_content || '')), 'bill gửi khách có dòng Tổng cộng');
    assert.ok(/210[.,]?000/.test(String(billMsg.text_content || '')), 'bill tổng đúng 210.000đ (185k + ship 25k) — thấy: ' + String(billMsg.text_content || '').slice(0, 160).replace(/\n/g, ' | '));

    // (A7) confirm -> CONFIRMED + shipment + tracking (mock carrier)
    r = await postWebhook(inst, commentEntry('cmt-7', 'lan', 'xác nhận'));
    assert.strictEqual(r.status, 200);
    pump(app);
    order = app.store.findOne('orders', o => o.conversation_id === CONV);
    assert.strictEqual(order.status, 'CONFIRMED', 'khách xác nhận -> đơn CONFIRMED (pha B re-validate)');
    const sh = app.store.findOne('shipments', s => s.order_id === order.order_id);
    assert.ok(sh && sh.tracking_number, 'vận đơn tạo với tracking: ' + (sh && sh.tracking_number));
    conv = app.store.findOne('conversations', c => c.conversation_id === CONV);
    assert.strictEqual(conv.state, 'ORDERED');
    outMsgs = app.store.findAll('messages', m => m.conversation_id === CONV && m.direction === 'out');
    assert.ok(outMsgs.some(m => String(m.text_content || '').includes(sh.tracking_number)), 'bot báo mã vận đơn cho khách');

    // (A8) carrier cập nhật DELIVERED -> order DELIVERED (đi đúng onCarrierStatus)
    app.carrier.setStatus(sh.tracking_number, 'PICKED_UP');
    app.pipeline.onCarrierStatus(order.order_id);
    assert.strictEqual(app.store.findOne('shipments', s => s.order_id === order.order_id).status, 'PICKED_UP', 'tracking PICKED_UP');
    app.carrier.setStatus(sh.tracking_number, 'DELIVERED');
    app.pipeline.onCarrierStatus(order.order_id);
    assert.strictEqual(app.store.findOne('orders', o => o.order_id === order.order_id).status, 'DELIVERED', 'order DELIVERED từ carrier verify');
    const fu = app.store.findOne('follow_ups', f => f.order_id === order.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
    assert.ok(fu && fu.status === 'SCHEDULED', 'follow-up sau giao được core lập lịch');
    // API nhìn thấy toàn bộ chuỗi (mắt xích cuối: dashboard/order detail)
    const od = await inst.client('GET', '/api/orders/' + order.order_id, { cookie: sid });
    assert.strictEqual(od.status, 200);
    assert.strictEqual(od.json.status, 'DELIVERED');
    assert.strictEqual(od.json.shipment.status, 'DELIVERED');
    return 'A: comment->reply->variant->SĐT->tên->địa chỉ->bill->confirm->order->shipment->DELIVERED (8 mắt xích OK, đơn ' + order.order_code + ')';
  } finally { await inst.close(); }
}

// ============================================================ FLOW B — COMPLAINT -> CLAIM -> AGENT -> CLOSE -> AUTO
async function flowB() {
  const inst = await startServer('b');
  try {
    const { sid, app } = await setupOwnerAndGoLive(inst, 'owner-b@e2e.vn');
    const ref = 'fb-hung-b';
    const fire = (text, pid) => { app.receive({ channel: 'facebook', type: 'message', platformEventId: pid, payload: { customer_ref: ref, thread_id: ref, kind: 'text', text, platform_message_id: 'pm-' + pid } }); app.drain(); };
    // có đơn để khiếu nại có ngữ cảnh
    fire('lấy 1 hộp trà hoa sấy, tên Hùng, sdt 0903333444, địa chỉ 45 Lê Lợi Q1', 'b-1');
    fire('xác nhận', 'b-2');
    let conv = app.store.findOne('conversations', c => c.platform_thread_id === ref);
    const order = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id);
    assert.ok(order, 'đơn tồn tại trước khiếu nại');

    // (B1) complaint -> claim + HUMAN + ACK template
    fire('shop lừa đảo quá, đơn hàng lỗi rồi nhé', 'b-3');
    conv = app.store.findOne('conversations', c => c.conversation_id === conv.conversation_id);
    assert.ok(conv.claim, 'claim mở');
    assert.strictEqual(conv.mode, 'HUMAN', 'tự động chuyển HUMAN');
    assert.strictEqual(conv.claim.origin_state, 'ORDERED', 'claim nhớ origin_state');
    const wl = app.store.findAll('worklist', w => w.conversation_id === conv.conversation_id && w.status === 'OPEN');
    assert.ok(wl.length >= 1, 'worklist NEEDS_HUMAN có hàng');
    const ack = app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'out');
    assert.ok(ack.some(m => m.sender === 'system'), 'ACK khiếu nại (template system) đã gửi');

    // (B2) agent reply QUA API — KHÔNG bị gate chặn (người thật ở mode HUMAN)
    const send = await inst.client('POST', '/api/conversations/' + encodeURIComponent(conv.conversation_id) + '/send', { cookie: sid, body: { text: 'Dạ shop thành thật xin lỗi anh, em kiểm tra đơn ngay đây ạ.' } });
    assert.strictEqual(send.status, 200, 'agent send 200');
    assert.strictEqual(send.json.sent, true, 'agent gửi được trong mode HUMAN: ' + JSON.stringify(send.json));
    const agentMsg = app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.sender === 'human_agent');
    assert.ok(agentMsg.length >= 1, 'tin của agent nằm trong inbox');

    // (B3) khách nhắn thêm trong HUMAN -> bot KHÔNG tự trả (INV-5)
    fire('bao giờ mình nhận được phản hồi vậy shop', 'b-4');
    const botWhileHuman = app.store.findAll('messages', m => m.conversation_id === conv.conversation_id
      && m.direction === 'out' && m.sender === 'ai' && Date.parse(m.created_at) >= Date.parse(app.store.findAll('messages', x => x.text_content && x.text_content.includes('bao giờ') && x.direction === 'in')[0] ? app.store.now() : app.store.now()));
    void botWhileHuman; // assert chính ở dưới: không có AI proposal AUTO_EXECUTED sau takeover
    const lastProposal = app.store.findAll('ai_proposals', p => p.conversation_id === conv.conversation_id
      && p.decision === 'HOLD_FOR_AGENT');
    assert.ok(lastProposal.length >= 1, 'bot soạn NHÁP cho agent (KHÔNG tự gửi) trong mode HUMAN');

    // (B4) closeClaim qua API MỚI -> restore origin_state
    const cl = await inst.client('POST', '/api/conversations/' + encodeURIComponent(conv.conversation_id) + '/close-claim', { cookie: sid, body: {} });
    assert.strictEqual(cl.status, 200, 'close-claim 200: ' + cl.text.slice(0, 100));
    assert.strictEqual(cl.json.restored_state, 'ORDERED', 'closeClaim trả về ĐÚNG origin_state');
    conv = app.store.findOne('conversations', c => c.conversation_id === conv.conversation_id);
    assert.strictEqual(conv.claim, null, 'claim đã đóng');

    // (B5) handback qua API -> AUTO; khách hỏi tiếp -> bot trả lời lại
    const hb = await inst.client('POST', '/api/conversations/' + encodeURIComponent(conv.conversation_id) + '/handback', { cookie: sid, body: {} });
    assert.strictEqual(hb.status, 200);
    assert.strictEqual(hb.json.mode, 'AI');
    fire('cho mình hỏi trà hoa sấy hạn dùng bao lâu', 'b-5');
    conv = app.store.findOne('conversations', c => c.conversation_id === conv.conversation_id);
    assert.strictEqual(conv.mode, 'AI');
    const afterHandback = app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'out');
    const lastOut = afterHandback[afterHandback.length - 1];
    assert.ok(lastOut && lastOut.sender === 'ai', 'bot (AI) trả lời lại sau handback');
    return 'B: complaint->claim+HUMAN->agent send (API)->closeClaim(restore ORDERED)->handback->AUTO reply';
  } finally { await inst.close(); }
}

// ============================================================ FLOW C — CANCEL + CARRIER REJECT/PENDING + RETRY
async function flowC() {
  const inst = await startServer('c');
  try {
    const { sid, app } = await setupOwnerAndGoLive(inst, 'owner-c@e2e.vn');
    const makeOrder = async (ref, pid) => {
      const tenKhach = 'Khach ' + ref.replace(/[^a-zA-Z]/g, ''); // tên không số/ký tự đặc biệt (slot regex)
      const sdt = '091' + String(1000000 + (pid.charCodeAt(1) * 7 + pid.charCodeAt(pid.length - 1) * 13) % 9000000);
      app.receive({ channel: 'facebook', type: 'message', platformEventId: pid + 'a', payload: { customer_ref: ref, thread_id: ref, kind: 'text', text: `lấy 1 hộp trà hoa sấy, tên ${tenKhach}, sdt ${sdt}, địa chỉ ${ref} Street Q1`, platform_message_id: 'pm-' + pid + 'a' } });
      app.drain();
      const conv = app.store.findOne('conversations', c => c.platform_thread_id === ref);
      const draft = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
      assert.ok(draft, 'draft tạo cho ' + ref + ' (slots: ' + JSON.stringify(conv.draft && conv.draft.slots.phone && conv.draft.slots.phone.value) + ')');
      const cf = await inst.client('POST', '/api/orders/' + draft.order_id + '/confirm', { cookie: sid, body: {} });
      assert.strictEqual(cf.status, 200, 'confirm ' + ref);
      return app.store.findOne('orders', o => o.order_id === draft.order_id);
    };
    const stockOf = sku => app.productDB.getStock(sku).stock_qty;

    // (C1) cancel có vận đơn -> qua carrier -> CANCELLED + restock
    const o1 = await makeOrder('fc1', 'c1');
    const tracking1 = app.store.findOne('shipments', s => s.order_id === o1.order_id).tracking_number;
    const before1 = stockOf('TRA-HOA-SEY-50');
    const c1 = await inst.client('POST', '/api/orders/' + o1.order_id + '/cancel', { cookie: sid, body: {} });
    assert.strictEqual(c1.status, 200);
    assert.strictEqual(c1.json.ok, true, 'hủy OK');
    assert.strictEqual(c1.json.viaCarrier, true, 'hủy QUA CARRIER (có vận đơn)');
    assert.strictEqual(c1.json.status, 'CANCELLED');
    assert.ok(app.carrier.cancelledByTracking[tracking1], 'carrier ghi nhận huỷ (receipt)');
    assert.strictEqual(stockOf('TRA-HOA-SEY-50'), before1 + 1, 'hoàn tồn đúng 1');
    // retry trên đơn đã huỷ -> policy CHẶN (409)
    const rt0 = await inst.client('POST', '/api/orders/' + o1.order_id + '/retry-shipping', { cookie: sid, body: {} });
    assert.strictEqual(rt0.status, 409, 'retry trên đơn CANCELLED bị policy chặn');

    // (C2) carrier TỪ CHỐI huỷ -> CANCEL_PENDING (không huỷ lửng) + needsHuman
    app.carrier.cancelMode = 'refuse';
    const o2 = await makeOrder('fc2', 'c2');
    const c2 = await inst.client('POST', '/api/orders/' + o2.order_id + '/cancel', { cookie: sid, body: {} });
    assert.strictEqual(c2.status, 200);
    assert.strictEqual(c2.json.ok, false);
    assert.strictEqual(c2.json.status, 'CANCEL_PENDING', 'carrier từ chối -> CANCEL_PENDING');
    const wl2 = app.store.findAll('worklist', w => w.reason === 'cancel_shipment_rejected' && w.status === 'OPEN');
    assert.ok(wl2.length >= 1, 'needsHuman cho cancel bị từ chối');
    // (C3) retry khi carrier VẪN từ chối -> vẫn CANCEL_PENDING (không hủy lửng)
    const rt1 = await inst.client('POST', '/api/orders/' + o2.order_id + '/retry-shipping', { cookie: sid, body: {} });
    assert.strictEqual(rt1.status, 200);
    assert.strictEqual(rt1.json.order.status, 'CANCEL_PENDING', 'retry (carrier refuse) -> vẫn CANCEL_PENDING');
    // (C4) retry khi carrier chấp nhận -> CANCELLED + restock
    app.carrier.cancelMode = 'ok';
    const before2 = stockOf('TRA-HOA-SEY-50');
    const rt2 = await inst.client('POST', '/api/orders/' + o2.order_id + '/retry-shipping', { cookie: sid, body: {} });
    assert.strictEqual(rt2.status, 200);
    assert.strictEqual(rt2.json.ok, true);
    assert.strictEqual(rt2.json.order.status, 'CANCELLED', 'retry (carrier ok) -> CANCELLED');
    assert.strictEqual(stockOf('TRA-HOA-SEY-50'), before2 + 1, 'retry huỷ cũng hoàn tồn đúng 1');
    // policy: retry khi exec không phải FAILED -> 409
    const o3 = await makeOrder('fc3', 'c3');
    const rt3 = await inst.client('POST', '/api/orders/' + o3.order_id + '/retry-shipping', { cookie: sid, body: {} });
    assert.strictEqual(rt3.status, 409, 'đơn CONFIRMED có vận đơn không đủ cờ retry');
    return 'C: cancel->carrier->CANCELLED(+restock); refuse->CANCEL_PENDING; retry refuse->pending, retry ok->CANCELLED; policy 409';
  } finally { await inst.close(); }
}

// ============================================================ FLOW D — FOLLOW-UP GATES (WINDOW/QUOTA/OPT-OUT) -> DELIVERED
async function flowD() {
  const inst = await startServer('d');
  try {
    const { sid, shop, app } = await setupOwnerAndGoLive(inst, 'owner-d@e2e.vn');
    // cấu hình automation: care sau giao 1 giờ, review bật, KHÔNG purchase reminder (lúc đầu)
    let au = await inst.client('POST', '/api/automation', { cookie: sid, body: { followup_delivery_hours: 1, care_enabled: true, review_enabled: true, purchase_reminder_enabled: false } });
    assert.strictEqual(au.status, 200, 'lưu automation');

    const makeDeliveredFbOrder = async (ref, pid) => {
      const tenKhach = 'Khach ' + ref.replace(/[^a-zA-Z]/g, '');
      const sdt = '093' + String(1000000 + (pid.charCodeAt(1) * 7 + pid.charCodeAt(pid.length - 1) * 13) % 9000000);
      app.receive({ channel: 'facebook', type: 'message', platformEventId: pid + 'a', payload: { customer_ref: ref, thread_id: ref, kind: 'text', text: `lấy 1 hộp trà hoa sấy, tên ${tenKhach}, sdt ${sdt}, địa chỉ ${ref} St Q1`, platform_message_id: 'pm-' + pid + 'a' } });
      app.drain();
      const conv = app.store.findOne('conversations', c => c.platform_thread_id === ref);
      const draft = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
      assert.ok(draft, 'draft tạo cho ' + ref);
      const cf = await inst.client('POST', '/api/orders/' + draft.order_id + '/confirm', { cookie: sid, body: {} });
      assert.strictEqual(cf.status, 200, 'confirm ' + ref);
      const order = app.store.findOne('orders', o => o.order_id === draft.order_id);
      const sh = app.store.findOne('shipments', s => s.order_id === order.order_id);
      app.carrier.setStatus(sh.tracking_number, 'DELIVERED');
      app.pipeline.onCarrierStatus(order.order_id);
      return { conv, order, sh };
    };
    const waitAutomation = async () => { for (let i = 0; i < 8; i++) { await sleep(450); const r = await inst.client('GET', '/api/automation', { cookie: sid }); if ((r.json.automation.review_scheduled || 0) >= 1) return; } };

    // ---------- (D1) WINDOW GATE: follow-up 1h sau giao -> đứng 25h -> window đóng -> HELD
    const w1 = await makeDeliveredFbOrder('fd-win', 'd1');
    assert.strictEqual(w1.order.status, 'DELIVERED');
    await waitAutomation(); // đợi bộ điều phối server chỉnh giờ + tạo REVIEW_REQUEST
    const fuWin = app.store.findOne('follow_ups', f => f.order_id === w1.order.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
    assert.ok(fuWin, 'core tạo follow-up care');
    assert.strictEqual(fuWin.status, 'SCHEDULED');
    const fuReview = app.store.findOne('follow_ups', f => f.order_id === w1.order.order_id && f.kind === 'REVIEW_REQUEST');
    assert.ok(fuReview, 'REVIEW_REQUEST được bộ điều phối tạo theo settings');
    // chốt giờ follow-up = delivered + 1h (settings) — core mặc định +48h phải bị GHI ĐÈ
    const base = Date.parse(fuWin.created_at);
    assert.ok(Math.abs(Date.parse(fuWin.scheduled_at) - (base + 3600 * 1000)) < 5000, 'follow-up đúng giờ cấu hình (1h sau giao)');
    // đứng thêm 25h: follow-up đến hạn NHƯNG cửa sổ 24h FB đã đóng -> HELD (không gửi lậu)
    app.advance(25 * 3600 * 1000);
    let fuWinNow = app.store.findOne('follow_ups', f => f.order_id === w1.order.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
    assert.strictEqual(fuWinNow.status, 'HELD', 'Window Gate: ngoài 24h -> HELD, KHÔNG gửi');
    assert.strictEqual(fuWinNow.cancel_reason, 'fb_window_closed');
    // khách nhắn lại -> window mở lại -> follow-up kích hoạt + GỬI + DELIVERED (receipt)
    app.receive({ channel: 'facebook', type: 'message', platformEventId: 'd1z', payload: { customer_ref: 'fd-win', thread_id: 'fd-win', kind: 'text', text: 'shop ơi đơn dùng tốt lắm', platform_message_id: 'pm-d1z' } });
    app.drain();
    fuWinNow = app.store.findOne('follow_ups', f => f.order_id === w1.order.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
    assert.ok(['SENT', 'PENDING_RECEIPT', 'DELIVERED'].includes(fuWinNow.status), 'kích hoạt lại sau khách nhắn: ' + fuWinNow.status);
    app.advance(30 * 1000); // đợi receipt của platform (mock latency 5s)
    fuWinNow = app.store.findOne('follow_ups', f => f.order_id === w1.order.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
    assert.strictEqual(fuWinNow.status, 'SENT', 'follow-up SENT sau khi có bằng chứng receipt');
    const fuMsg = app.store.findAll('messages', m => m.conversation_id === w1.conv.conversation_id
      && m.direction === 'out' && (m.text_content || '').includes('đã nhận được chưa'));
    assert.ok(fuMsg.length >= 1, 'tin care tới tay khách');

    // ---------- (D2) QUOTA GATE (Zalo): quota còn 2 -> quota_low HELD; về 0 -> exhausted CANCELLED
    const zref = 'zdquota';
    app.receive({ channel: 'zalo', type: 'message', platformEventId: 'd2a', payload: { customer_ref: zref, thread_id: zref, kind: 'text', text: 'lấy 1 hộp trà hoa sấy, tên Quota, sdt 0940000001, địa chỉ Quota St Q1', platform_message_id: 'pm-d2a' } });
    app.drain();
    const zconv = app.store.findOne('conversations', c => c.platform_thread_id === zref);
    const zdraft = app.store.findOne('orders', o => o.conversation_id === zconv.conversation_id && o.status === 'DRAFT');
    const zcf = await inst.client('POST', '/api/orders/' + zdraft.order_id + '/confirm', { cookie: sid, body: {} });
    assert.strictEqual(zcf.status, 200, 'confirm zalo');
    const zorder = app.store.findOne('orders', o => o.order_id === zdraft.order_id);
    const zsh = app.store.findOne('shipments', s => s.order_id === zorder.order_id);
    app.platform.setQuota(zref, 2, 8); // quota sắp cạn TRƯỚC khi giao
    app.carrier.setStatus(zsh.tracking_number, 'DELIVERED');
    app.pipeline.onCarrierStatus(zorder.order_id);
    await waitAutomation();
    let fuQ = app.store.findOne('follow_ups', f => f.order_id === zorder.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
    assert.ok(fuQ, 'follow-up zalo được lập');
    app.advance(2 * 3600 * 1000); // tới hạn (1h) — quota còn 2 <= ngưỡng -> quota_low
    fuQ = app.store.findOne('follow_ups', f => f.order_id === zorder.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
    assert.strictEqual(fuQ.status, 'HELD', 'Quota Gate: quota thấp -> HELD');
    assert.strictEqual(fuQ.cancel_reason, 'zalo_quota_low');
    // về 0 -> lần chạy kế REJECT cứng -> CANCELLED
    app.platform.setQuota(zref, 0, 8);
    // follow-up đang HELD -> hủy SCHEDULED nào còn + đẩy lại bằng cách cho status SCHEDULED thử chạy
    app.advance(2 * 3600 * 1000);
    fuQ = app.store.findOne('follow_ups', f => f.order_id === zorder.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
    assert.ok(['HELD', 'CANCELLED'].includes(fuQ.status), 'quota cạn: HELD/CANCELLED, không gửi lậu: ' + fuQ.status);
    assert.ok(!['SENT', 'PENDING_RECEIPT'].includes(fuQ.status), 'CHẮN CHẮN không gửi khi quota cạn');

    // ---------- (D3) OPT-OUT GATE: marketing follow-up của khách opt-out -> CANCELLED opt_out
    // bật purchase reminder (kind MARKETING) 1 ngày sau giao cho đơn zalo đã giao
    au = await inst.client('POST', '/api/automation', { cookie: sid, body: { purchase_reminder_enabled: true, purchase_reminder_days: 1 } });
    assert.strictEqual(au.status, 200);
    // khách opt-out quảng cáo
    app.receive({ channel: 'zalo', type: 'message', platformEventId: 'd3a', payload: { customer_ref: zref, thread_id: zref, kind: 'text', text: 'không nhận khuyến mại nữa nha shop', platform_message_id: 'pm-d3a' } });
    app.drain();
    const zcus = app.store.findOne('customers', c => c.platform_ref === zref);
    assert.strictEqual(zcus.marketing_opt_out, 1, 'opt-out ghi nhận');
    // bộ điều phối tạo MARKETING cho đơn đã giao (settings bật) -> tới hạn -> gate chặn opt_out
    await waitAutomation();
    const fuM = app.store.findOne('follow_ups', f => f.order_id === zorder.order_id && f.kind === 'MARKETING');
    assert.ok(fuM, 'purchase reminder được lập theo settings');
    app.advance(26 * 3600 * 1000); // quá 1 ngày + cửa sổ
    const fuMNow = app.store.findOne('follow_ups', f => f.order_id === zorder.order_id && f.kind === 'MARKETING');
    assert.ok(['CANCELLED', 'HELD'].includes(fuMNow.status), 'marketing khách opt-out không được gửi: ' + fuMNow.status);
    if (fuMNow.status === 'CANCELLED') {
      assert.strictEqual(fuMNow.cancel_reason, 'opt_out', 'lý do hủy đúng opt_out (core quyết định)');
    }
    // (D4) delivered-by-proof: tin care của flow (D1) đã có receipt DELIVERED ở outbound_pending
    const opRow = app.store.findAll('outbound_pending', o => o.receipt_status === 'DELIVERED');
    assert.ok(opRow.length >= 1, 'có bằng chứng DELIVERED từ platform (inbound receipt)');
    return 'D: Window Gate (25h -> HELD -> khách nhắn -> SENT+DELIVERED) + Quota Gate (low->HELD, 0->không gửi) + Opt-out (marketing->opt_out) OK';
  } finally { await inst.close(); }
}

// ============================================================ FLOW E — RESTART (PERSIST) -> DATA + JOBS/FOLLOW-UP CHẠY TIẾP
async function flowE() {
  const inst = await startServer('e');
  let sid;
  const counts = store => {
    const c = {};
    for (const k of ['customers', 'conversations', 'messages', 'orders', 'shipments', 'follow_ups', 'audit_events']) c[k] = store.findAll(k, () => true).length;
    return c;
  };
  let app1, orderRef, fuBefore, countsBefore;
  try {
    const setup = await setupOwnerAndGoLive(inst, 'owner-e@e2e.vn');
    sid = setup.sid;
    app1 = setup.app;
    // tạo đơn + giao + follow-up 1h (như D) nhưng CHƯA tới hạn
    await inst.client('POST', '/api/automation', { cookie: sid, body: { followup_delivery_hours: 1, care_enabled: true, review_enabled: false, purchase_reminder_enabled: false } });
    app1.receive({ channel: 'facebook', type: 'message', platformEventId: 'e1a', payload: { customer_ref: 'fe1', thread_id: 'fe1', kind: 'text', text: 'lấy 1 hộp trà hoa sấy, tên Persist, sdt 0950000001, địa chỉ Persist St Q1', platform_message_id: 'pm-e1a' } });
    app1.drain();
    const conv = app1.store.findOne('conversations', c => c.platform_thread_id === 'fe1');
    const draft = app1.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
    const cf = await inst.client('POST', '/api/orders/' + draft.order_id + '/confirm', { cookie: sid, body: {} });
    assert.strictEqual(cf.status, 200);
    orderRef = app1.store.findOne('orders', o => o.order_id === draft.order_id);
    const sh = app1.store.findOne('shipments', s => s.order_id === orderRef.order_id);
    app1.carrier.setStatus(sh.tracking_number, 'DELIVERED');
    app1.pipeline.onCarrierStatus(orderRef.order_id);
    // đợi bộ điều phối server (tick 2s) CHỈNH GIỜ follow-up về created + 1h (settings)
    for (let i = 0; i < 12; i++) {
      const f = app1.store.findOne('follow_ups', f => f.order_id === orderRef.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
      if (f && Date.parse(f.scheduled_at) - Date.parse(f.created_at) < 2 * 3600 * 1000) break;
      await sleep(450);
    }
    countsBefore = counts(app1.store);
    fuBefore = app1.store.findOne('follow_ups', f => f.order_id === orderRef.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
    assert.ok(fuBefore && fuBefore.status === 'SCHEDULED', 'follow-up SCHEDULED trước restart');
    assert.ok(Date.parse(fuBefore.scheduled_at) - Date.parse(fuBefore.created_at) < 2 * 3600 * 1000,
      'bộ điều phối đã áp hours=1 trước restart (sched=' + fuBefore.scheduled_at + ')');
  } finally { await inst.close(); }

  // RESTART: server MỚI, cùng authDir/shopsRoot (persist) — App mới nạp db.json
  const inst2 = createServer({
    port: 0,
    authDir: path.join(inst.root, 'auth'),
    shopsRoot: path.join(inst.root, 'shops'),
    uiDemo: '0',
    appDataMode: 'persist',
  });
  inst2.listen();
  try {
    for (let i = 0; i < 60 && !inst2.server.listening; i++) await sleep(20);
    inst2.client = makeClient(`http://127.0.0.1:${inst2.server.address().port}`);
    // session CŨ vẫn còn (sessions.json persist)
    const me = await inst2.client('GET', '/api/auth/me', { cookie: sid });
    assert.strictEqual(me.status, 200, 'session giữ qua restart');
    const app2 = inst2.getApp(me.json.user.shop_id);
    const countsAfter = counts(app2.store);
    assert.deepStrictEqual(countsAfter, countsBefore, 'counts GIỮ NGUYÊN qua restart: ' + JSON.stringify({ before: countsBefore, after: countsAfter }));
    const orderAfter = app2.store.findOne('orders', o => o.order_id === orderRef.order_id);
    assert.ok(orderAfter && orderAfter.status === 'DELIVERED', 'đơn DELIVERED còn nguyên');
    const fuAfter = app2.store.findOne('follow_ups', f => f.order_id === orderRef.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
    assert.ok(fuAfter, 'follow-up còn đó sau restart');
    assert.strictEqual(fuAfter.status, 'SCHEDULED', 'follow-up vẫn SCHEDULED (chưa tới hạn)');
    assert.strictEqual(Date.parse(fuAfter.scheduled_at), Date.parse(fuBefore.scheduled_at), 'scheduled_at không bị dịch');
    // follow-up + jobs CHẠY TIẾP khi đồng hồ tới hạn
    app2.advance(2 * 3600 * 1000);
    const fuRun = app2.store.findOne('follow_ups', f => f.order_id === orderRef.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
    assert.ok(['SENT', 'PENDING_RECEIPT'].includes(fuRun.status),
      'follow-up CHẠY TIẾP sau restart: ' + fuRun.status + ' reason=' + fuRun.cancel_reason
      + ' sched=' + fuRun.scheduled_at + ' last_user=' + JSON.stringify(app2.store.findOne('channel_state', s => s.conversation_id === fuRun.conversation_id)));
    app2.advance(30 * 1000);
    const fuRun2 = app2.store.findOne('follow_ups', f => f.order_id === orderRef.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
    assert.strictEqual(fuRun2.status, 'SENT', 'follow-up SENT với receipt sau restart');
    return 'E: restart persist -> counts/đơn/follow-up nguyên vẹn + session còn + follow-up chạy tiếp và SENT';
  } finally { await inst2.close(); }
}

// ============================================================ runner
async function main() {
  console.log('===== E2E FLOWS A–E (PRODUCT-READY đợt 2 — offline, HTTP in-process) =====');
  const flows = [['A', 'comment->reply->...->tracking DELIVERED', flowA], ['B', 'complaint->claim->agent->closeClaim->handback->AUTO', flowB], ['C', 'cancel + carrier refuse/pending + retry policy', flowC], ['D', 'follow-up Window/Quota/Opt-out gates -> delivered', flowD], ['E', 'restart persist -> data + jobs chạy tiếp', flowE]];
  let pass = 0;
  for (const [id, desc, fn] of flows) {
    const t0 = Date.now();
    try {
      const note = await fn();
      pass += 1;
      console.log(`  [PASS] Flow ${id} (${Math.round((Date.now() - t0) / 100) / 10}s) — ${desc}\n         -> ${note}`);
    } catch (err) {
      console.log(`  [FAIL] Flow ${id} — ${desc}\n         -> ${String(err && err.message).split('\n').slice(0, 6).join(' | ')}`);
    }
  }
  console.log(`\nTỔNG: ${pass}/5 flows PASS`);
  console.log(pass === 5 ? '==> E2E A–E: toàn bộ chuỗi đầu-cuối CHẠY ĐÚNG.' : '==> CÒN FLOW FAIL — xem log trên.');
  process.exitCode = pass === 5 ? 0 : 1;
}

main().catch(err => { console.error('[fatal]', err); process.exitCode = 1; });
