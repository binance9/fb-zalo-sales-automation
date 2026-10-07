'use strict';
// test/matrix/_harness.js — harness dùng chung cho TEST MATRIX (offline 100%).
// Mỗi area file export { area, setup, cases } — runner (index.js) gọi setup 1 lần rồi
// chạy tuần tự từng case; mỗi case assert ĐIỀU KIỆN RIÊNG có ý nghĩa.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createServer } = require('../../server');
const { App } = require('../../src/app');

const DATA = path.join(__dirname, '..', '..', 'data', 'test-runs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeClient(base) {
  const u0 = new URL(base);
  return function call(method, p, { body, cookie, headers: extra, raw } = {}) {
    return new Promise((resolve, reject) => {
      const data = raw ? Buffer.from(raw) : (body !== undefined ? Buffer.from(JSON.stringify(body)) : null);
      const headers = Object.assign({}, extra || {});
      if (data) { headers['Content-Type'] = headers['Content-Type'] || 'application/json'; headers['Content-Length'] = data.length; }
      if (cookie) headers.Cookie = `sid=${cookie}`;
      const req = http.request({ hostname: u0.hostname, port: u0.port, path: p, method, headers }, res => {
        let out = '';
        res.on('data', c => { out += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(out); } catch (e) { /* html/text */ }
          resolve({ status: res.statusCode, headers: res.headers, json, text: out });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  };
}

async function startInst(name, opts = {}) {
  const root = path.join(DATA, 'matrix-' + name);
  fs.rmSync(root, { recursive: true, force: true });
  const inst = createServer(Object.assign({
    port: 0,
    authDir: path.join(root, 'auth'),
    shopsRoot: path.join(root, 'shops'),
    uiDemo: '0',
    appDataMode: 'persist',
  }, opts));
  inst.listen();
  for (let i = 0; i < 60 && !inst.server.listening; i++) await sleep(20);
  inst.root = root;
  inst.client = makeClient(`http://127.0.0.1:${inst.server.address().port}`);
  return inst;
}

// setup owner + (tuỳ chọn) đủ go-live checklist + bot ON. Trả { sid, shop, app }.
async function setupShop(inst, { goLive = true, email } = {}) {
  const mail = email || ('owner-' + Math.random().toString(36).slice(2, 8) + '@matrix.vn');
  const setup = await inst.client('POST', '/api/auth/setup', { body: { email: mail, password: 'password123', shop_name: 'Matrix Shop' } });
  if (setup.status !== 200) throw new Error('setup fail: ' + setup.text.slice(0, 120));
  const sid = setup.headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
  const shop = setup.json.shop.shop_id;
  const app = inst.getApp(shop);
  if (goLive) {
    for (const [stepId, data] of [
      ['shop-info', { name: 'Matrix Shop', hotline: '0900000000', address: '1 Matrix St Q1' }],
      ['facebook', { page_id: 'page-mx', page_access_token: 'ptk-mx' }],
      ['zalo', { oa_id: 'oa-mx', access_token: 'zat-mx' }],
      ['shipping', { ghn_token: 'ghn-mx', ghn_shop_id: '222222' }],
      ['ai', { provider: 'local' }],
    ]) {
      const r = await inst.client('POST', '/api/onboarding/complete-step', { cookie: sid, body: { stepId, data } });
      if (r.status !== 200) throw new Error('step ' + stepId + ' fail');
    }
    const ai = await inst.client('POST', '/api/ai/test', { cookie: sid, body: {} });
    if (ai.status !== 200) throw new Error('ai test fail');
    const bot = await inst.client('POST', '/api/settings/bot', { cookie: sid, body: { on: true } });
    if (bot.status !== 200) throw new Error('bot on fail: ' + bot.text.slice(0, 140));
  }
  // [chốt local] matrix phải DETERMINISTIC — ép engine stub/local, không LLM mạng
  // (LLM wording chỉ được test ở suri-live với key thật, ghi nhãn PASS (LIVE) riêng).
  await inst.client('POST', '/api/ai/config', { cookie: sid, body: { use_for_replies: false } });

  // [chốt local] poll-wait helper ở cấp module (xuống dưới) — chống flake timing khi máy load.
  // fixture: nạp đủ tồn kho cho cả area (mỗi area chạy ~18 case tạo đơn) — test điều khiển fixture
  try {
    for (const sku of ['TRA-HOA-SEY-50', 'NT-VANILLA-S', 'NT-VANILLA-M-DO']) {
      const hit = app.productDB.getVariant(sku);
      if (hit) hit.variant.stock_qty = 500;
    }
  } catch (e) { /* seed khác thì bỏ qua */ }
  return { sid, shop, app, email: mail };
}

// [chốt local] poll-wait thay sleep/query một lần — chống flake timing khi máy load
async function waitFor(fn, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = fn(); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(50);
  }
}

// App-level (không HTTP) — cho các case gate/engine thuần.
function newApp(name, opts = {}) {
  const dataDir = path.join(DATA, 'matrix-app-' + name);
  fs.rmSync(dataDir, { recursive: true, force: true });
  return new App(Object.assign({ dataDir, persist: false, botEnabled: true }, opts));
}

// bắn event text qua app.receive (đường webhook) + drain
function fire(app, channel, ref, text, pid, extra = {}) {
  const r = app.receive({
    channel, type: 'message',
    platformEventId: pid || `mx-${ref}-${Math.random().toString(36).slice(2, 8)}`,
    payload: Object.assign({
      customer_ref: ref, thread_id: ref, kind: 'text', text: text || '',
      platform_message_id: 'pm-' + (pid || 'mx'),
    }, extra),
  });
  app.drain();
  return r;
}

// tạo đơn CONFIRMED (kèm vận đơn) cho ref — qua đường hệ thống (buy message + confirm API/app)
async function mkConfirmedOrder(inst, app, sid, ref, pid, text) {
  fire(app, 'facebook', ref, text || `lấy 1 hộp trà hoa sấy, tên Khach ${ref.replace(/[^a-zA-Z]/g, '')}, sdt 093${String(1000000 + (pid.length * 7919) % 8999999)}, địa chỉ ${ref} St Q1`, pid);
  const conv = app.store.findOne('conversations', c => c.platform_thread_id === ref);
  const draft = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
  if (!draft) throw new Error('mkConfirmedOrder: không tạo được draft cho ' + ref);
  const cf = sid
    ? await inst.client('POST', '/api/orders/' + draft.order_id + '/confirm', { cookie: sid, body: {} })
    : null;
  if (cf) {
    if (cf.status !== 200) throw new Error('mkConfirmedOrder: confirm fail ' + cf.status);
  } else {
    // đường App-level: pha B + tạo vận đơn đúng như pipeline.routeConfirm làm sau confirm
    const r = app.orders.phaseB({ orderId: draft.order_id });
    if (!r.ok) throw new Error('mkConfirmedOrder: phaseB fail ' + r.reason);
    app.orders.createShipment({ order: app.store.findOne('orders', o => o.order_id === draft.order_id), carrier: app.carrier });
  }
  return app.store.findOne('orders', o => o.order_id === draft.order_id);
}

module.exports = { startInst, setupShop, newApp, fire, mkConfirmedOrder, sleep, makeClient, DATA, waitFor };
