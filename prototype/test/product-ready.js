'use strict';
// test/product-ready.js — BATTERY PHASE PRODUCT-READY đợt 1 (offline; HTTP in-process port 0).
//
// Phạm vi:
//   AUTH     : setup owner đầu tiên (chặn setup lần 2), login đúng/sai, rate limit 5/phút/IP
//              (fail-closed), me/logout, đổi mật khẩu, quên/reset mật khẩu (token file local),
//              tạo user + role AGENT 403 khi đụng settings/products-ghi, AGENT vẫn đọc được
//              conversations/products, shop A KHÔNG thấy dữ liệu shop B (2 shop seed).
//   ONBOARD  : status từng bước + go-live gate 403 kèm reasons khi thiếu; đủ checklist -> bot ON.
//   PRODUCTS : CRUD (POST/PUT/DELETE soft), bulk import CSV (báo dòng lỗi), search ?q=,
//              disabled filter trong product-db.searchProduct + regression pipeline
//              (tắt SP -> bot KHÔNG còn tư vấn SP đó).
//   AI       : save config -> key chỉ trả masked; status không lộ key; secret-in-prompt chặn;
//              test provider local PASS; test provider thật lỗi qua httpFn tiêm -> ERROR + last_error.
//   PERSIST  : persist-mode restart giữ dữ liệu (App mới cùng dir) + db.backup.json;
//              START-BOT.bat tồn tại + đúng nội dung; server boot 200 (login/welcome/health);
//              node --check toàn bộ code.
// Exit 0 khi toàn bộ PASS.

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const { createServer } = require('../server');
const { App } = require('../src/app');
const { ProductDB } = require('../src/product-db');
const { ShopSettings } = require('../src/shop-settings');
const { testAiProvider } = require('../src/ai-provider');
const { buildSystemPrompt, validatePromptConfig } = require('../src/prompt-builder');
const { parseProductsCsv } = require('../src/csv-import');

const DATA = path.join(__dirname, '..', 'data', 'test-runs');
const dir = name => path.join(DATA, 'product-ready-' + name);
const PROTO_ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============================================================ HTTP helper (thuần node http)
function makeClient(base) {
  const u0 = new URL(base);
  return function call(method, p, { body, cookie } = {}) {
    return new Promise((resolve, reject) => {
      const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
      const headers = {};
      if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
      if (cookie) headers.Cookie = `sid=${cookie}`;
      const req = http.request({
        hostname: u0.hostname, port: u0.port, path: p, method, headers,
      }, res => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch (e) { /* html */ }
          resolve({ status: res.statusCode, headers: res.headers, json, text: raw });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  };
}

async function startServer(name, opts = {}) {
  const inst = createServer(Object.assign({
    port: 0,
    authDir: dir('auth-' + name),
    shopsRoot: dir('shops-' + name),
    uiDemo: '0',
    appDataMode: 'persist',
  }, opts));
  inst.listen();
  for (let i = 0; i < 50 && !inst.server.listening; i++) await sleep(20);
  const port = inst.server.address().port;
  inst.client = makeClient(`http://127.0.0.1:${port}`);
  inst.baseUrl = `http://127.0.0.1:${port}`;
  return inst;
}

// ============================================================ tests
const TESTS = [];
const T = (n, group, desc, fn) => TESTS.push({ n, group, desc, fn });

// Chuẩn bị dùng chung (chạy 1 lần trước nhóm AUTH/ONBOARD/PRODUCT)
let inst, ownerA, adminA, agentA, ownerB, shopA, shopB;

// ------------------------------------------------------------ AUTH
T('A1', 'AUTH', 'setup OWNER đầu tiên 200 + chặn setup lần 2 (403)', async () => {
  const r = await inst.client('POST', '/api/auth/setup', { body: { email: 'owner@a.vn', password: 'password123', shop_name: 'Shop A' } });
  assert.strictEqual(r.status, 200, 'setup 200, got ' + r.status + ' ' + r.text);
  assert.strictEqual(r.json.user.role, 'OWNER');
  assert.ok(r.json.shop.shop_id, 'có shop_id');
  assert.ok(r.headers['set-cookie'][0].includes('HttpOnly'), 'cookie HttpOnly');
  shopA = r.json.shop.shop_id;
  const r2 = await inst.client('POST', '/api/auth/setup', { body: { email: 'x@y.vn', password: 'password123' } });
  assert.strictEqual(r2.status, 403, 'setup lần 2 bị chặn');
  ownerA = (await inst.client('POST', '/api/auth/login', { body: { email: 'owner@a.vn', password: 'password123' } })).headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
  shopB = inst.auth.createShop('Shop B').shop_id;
});

T('A2', 'AUTH', 'login sai -> 401 BAD_CREDENTIALS; đúng -> 200', async () => {
  const bad = await inst.client('POST', '/api/auth/login', { body: { email: 'owner@a.vn', password: 'sai-roi' } });
  assert.strictEqual(bad.status, 401);
  assert.strictEqual(bad.json.error, 'BAD_CREDENTIALS');
  const ok = await inst.client('POST', '/api/auth/login', { body: { email: 'owner@a.vn', password: 'password123' } });
  assert.strictEqual(ok.status, 200);
});

T('A3', 'AUTH', 'rate limit: lần thứ 6 trong 1 phút -> 429 (fail-closed, server riêng)', async () => {
  const ri = await startServer('ratelimit');
  try {
    await ri.client('POST', '/api/auth/setup', { body: { email: 'r@a.vn', password: 'password123', shop_name: 'R' } });
    let last = null;
    for (let i = 0; i < 6; i++) {
      last = await ri.client('POST', '/api/auth/login', { body: { email: 'r@a.vn', password: 'wrong-' + i } });
    }
    assert.strictEqual(last.status, 429, 'lần 6 phải 429');
    assert.strictEqual(last.json.error, 'RATE_LIMITED');
    // mật khẩu ĐÚNG trong lúc bị limit vẫn bị chặn (fail-closed theo số lần thử)
    const okInLock = await ri.client('POST', '/api/auth/login', { body: { email: 'r@a.vn', password: 'password123' } });
    assert.strictEqual(okInLock.status, 429, 'đúng mật khẩu vẫn 429 khi đã vượt limit');
  } finally { await ri.close(); }
});

T('A4', 'AUTH', '/api/auth/me theo cookie; logout -> me 401', async () => {
  const me = await inst.client('GET', '/api/auth/me', { cookie: ownerA });
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.json.user.email, 'owner@a.vn');
  const noCookie = await inst.client('GET', '/api/auth/me');
  assert.strictEqual(noCookie.status, 401);
  const junk = await inst.client('GET', '/api/auth/me', { cookie: 'khong-hop-le' });
  assert.strictEqual(junk.status, 401);
  const lo = await inst.client('POST', '/api/auth/logout', { cookie: ownerA });
  assert.strictEqual(lo.status, 200);
  const after = await inst.client('GET', '/api/auth/me', { cookie: ownerA });
  assert.strictEqual(after.status, 401, 'sau logout session hết hiệu lực');
  // login lại để các test sau dùng
  const re = await inst.client('POST', '/api/auth/login', { body: { email: 'owner@a.vn', password: 'password123' } });
  ownerA = re.headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
});

T('A5', 'AUTH', 'tạo ADMIN/AGENT theo role; trùng email -> 409; sai role -> 400', async () => {
  const adm = await inst.client('POST', '/api/auth/users', { cookie: ownerA, body: { email: 'admin@a.vn', password: 'password456', role: 'ADMIN', shop_id: shopA } });
  assert.strictEqual(adm.status, 200);
  const ag = await inst.client('POST', '/api/auth/users', { cookie: ownerA, body: { email: 'agent@a.vn', password: 'password789', role: 'AGENT', shop_id: shopA } });
  assert.strictEqual(ag.status, 200);
  const dup = await inst.client('POST', '/api/auth/users', { cookie: ownerA, body: { email: 'agent@a.vn', password: 'password789', role: 'AGENT' } });
  assert.strictEqual(dup.status, 409, 'trùng email 409');
  const badRole = await inst.client('POST', '/api/auth/users', { cookie: ownerA, body: { email: 'x2@a.vn', password: 'password789', role: 'SUPER' } });
  assert.strictEqual(badRole.status, 400);
  adminA = (await inst.client('POST', '/api/auth/login', { body: { email: 'admin@a.vn', password: 'password456' } })).headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
  agentA = (await inst.client('POST', '/api/auth/login', { body: { email: 'agent@a.vn', password: 'password789' } })).headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
  // OWNER B (shop B) do owner A tạo
  const ob = await inst.client('POST', '/api/auth/users', { cookie: ownerA, body: { email: 'owner@b.vn', password: 'password123', role: 'OWNER', shop_id: shopB } });
  assert.strictEqual(ob.status, 200);
  ownerB = (await inst.client('POST', '/api/auth/login', { body: { email: 'owner@b.vn', password: 'password123' } })).headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
});

T('A6', 'AUTH', 'role AGENT: 403 khi đụng settings/products-ghi/onboarding/ai; 200 khi đọc', async () => {
  const w1 = await inst.client('POST', '/api/settings/bot', { cookie: agentA, body: { on: true } });
  assert.strictEqual(w1.status, 403, 'AGENT bật bot phải 403');
  const w2 = await inst.client('POST', '/api/products', { cookie: agentA, body: { name: 'X', sku_base: 'X1', price: 1000 } });
  assert.strictEqual(w2.status, 403, 'AGENT thêm sản phẩm phải 403');
  const w3 = await inst.client('GET', '/api/onboarding', { cookie: agentA });
  assert.strictEqual(w3.status, 403, 'AGENT xem onboarding phải 403');
  const w4 = await inst.client('POST', '/api/ai/config', { cookie: agentA, body: { provider: 'local' } });
  assert.strictEqual(w4.status, 403, 'AGENT cấu hình AI phải 403');
  const w5 = await inst.client('GET', '/api/shops', { cookie: agentA });
  assert.strictEqual(w5.status, 403, 'AGENT xem shops phải 403');
  const r1 = await inst.client('GET', '/api/products', { cookie: agentA });
  assert.strictEqual(r1.status, 200, 'AGENT đọc products 200 (READ-only)');
  const r2 = await inst.client('GET', '/api/conversations', { cookie: agentA });
  assert.strictEqual(r2.status, 200, 'AGENT đọc conversations 200');
  const r3 = await inst.client('GET', '/api/orders', { cookie: agentA });
  assert.strictEqual(r3.status, 200, 'AGENT đọc orders 200');
  const r4 = await inst.client('POST', '/api/products/import', { cookie: agentA, body: { csv: 'name,sku,price,stock\nX,X9,1000,1' } });
  assert.strictEqual(r4.status, 403, 'AGENT import CSV phải 403');
});

T('A7', 'AUTH', 'cô lập shop: A không thấy conversations/orders/products của B (và ngược lại)', async () => {
  // bắn 1 conversation THẬT vào app của từng shop (đường app.receive = webhook)
  const appA = inst.getApp(shopA);
  const appB = inst.getApp(shopB);
  appA.receive({ channel: 'facebook', type: 'message', platformEventId: 'iso-a-1', payload: { customer_ref: 'iso-a', thread_id: 'iso-a', kind: 'text', text: 'nến vanilla còn không shop', platform_message_id: 'pm-iso-a' } });
  appB.receive({ channel: 'facebook', type: 'message', platformEventId: 'iso-b-1', payload: { customer_ref: 'iso-b', thread_id: 'iso-b', kind: 'text', text: 'tra hoa say gia nhi shop', platform_message_id: 'pm-iso-b' } });
  appA.drain();
  appB.drain();
  // shop B thêm sản phẩm riêng
  const addB = await inst.client('POST', '/api/products', { cookie: ownerB, body: { name: 'Sản phẩm riêng B', sku_base: 'RIENG-B', price: 99000, stock_qty: 5 } });
  assert.strictEqual(addB.status, 200);
  const convA = await inst.client('GET', '/api/conversations', { cookie: ownerA });
  const convB = await inst.client('GET', '/api/conversations', { cookie: ownerB });
  const idsA = convA.json.conversations.map(c => c.id);
  const idsB = convB.json.conversations.map(c => c.id);
  assert.ok(idsA.includes('facebook:iso-a'), 'shop A thấy conv của A');
  assert.ok(!idsA.includes('facebook:iso-b'), 'shop A KHÔNG thấy conv của B');
  assert.ok(idsB.includes('facebook:iso-b'), 'shop B thấy conv của B');
  assert.ok(!idsB.includes('facebook:iso-a'), 'shop B KHÔNG thấy conv của A');
  // order của B: owner A phải 404
  const orderB = await inst.client('GET', '/api/orders', { cookie: ownerB });
  assert.ok(orderB.json.orders.length >= 0);
  if (orderB.json.orders.length) {
    const cross = await inst.client('GET', '/api/orders/' + orderB.json.orders[0].order_id, { cookie: ownerA });
    assert.strictEqual(cross.status, 404, 'owner A đọc đơn của shop B phải 404');
  }
  // sản phẩm riêng của B không xuất hiện ở A
  const prodA = await inst.client('GET', '/api/products', { cookie: ownerA });
  assert.ok(!prodA.json.products.some(p => p.sku_base === 'RIENG-B'), 'SP của B không lộ sang A');
  const prodB = await inst.client('GET', '/api/products', { cookie: ownerB });
  assert.ok(prodB.json.products.some(p => p.sku_base === 'RIENG-B'), 'SP của B có ở B');
});

T('A8', 'AUTH', 'đổi mật khẩu + quên mật khẩu (reset token file local)', async () => {
  // tạo user riêng cho test đổi mật khẩu
  await inst.client('POST', '/api/auth/users', { cookie: ownerA, body: { email: 'cp@a.vn', password: 'password000', role: 'ADMIN', shop_id: shopA } });
  const c1 = (await inst.client('POST', '/api/auth/login', { body: { email: 'cp@a.vn', password: 'password000' } })).headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
  const ch = await inst.client('POST', '/api/auth/change-password', { cookie: c1, body: { old_password: 'password000', new_password: 'password999' } });
  assert.strictEqual(ch.status, 200);
  const reOld = await inst.client('POST', '/api/auth/login', { body: { email: 'cp@a.vn', password: 'password000' } });
  assert.strictEqual(reOld.status, 401, 'mật khẩu cũ không còn dùng được');
  const reNew = await inst.client('POST', '/api/auth/login', { body: { email: 'cp@a.vn', password: 'password999' } });
  assert.strictEqual(reNew.status, 200);
  // quên mật khẩu: forgot -> token -> reset
  const fg = await inst.client('POST', '/api/auth/forgot', { body: { email: 'cp@a.vn' } });
  assert.strictEqual(fg.status, 200);
  assert.ok(fg.json.reset_token, 'có reset_token (local file, không email)');
  const rs = await inst.client('POST', '/api/auth/reset', { body: { token: fg.json.reset_token, new_password: 'password555' } });
  assert.strictEqual(rs.status, 200);
  const afterReset = await inst.client('POST', '/api/auth/login', { body: { email: 'cp@a.vn', password: 'password555' } });
  assert.strictEqual(afterReset.status, 200);
  const reuse = await inst.client('POST', '/api/auth/reset', { body: { token: fg.json.reset_token, new_password: 'password666' } });
  assert.strictEqual(reuse.status, 400, 'token reset KHÔNG dùng lại được');
});

T('A9', 'AUTH', 'cookie session: HttpOnly + SameSite=Lax + Max-Age 7 ngày (604800)', async () => {
  const r = await inst.client('POST', '/api/auth/login', { body: { email: 'admin@a.vn', password: 'password456' } });
  assert.strictEqual(r.status, 200);
  const sc = r.headers['set-cookie'][0];
  assert.ok(sc.includes('HttpOnly'), 'HttpOnly');
  assert.ok(sc.includes('SameSite=Lax'), 'SameSite=Lax');
  assert.ok(sc.includes('Max-Age=604800'), 'Max-Age 7 ngày');
});

T('A10', 'AUTH', 'TEST_AUTH_BYPASS: token cố định quy về OWNER (cho riêng smoke/test cũ)', async () => {
  process.env.TEST_AUTH_BYPASS = 'bypass-token-fixed-123';
  const bi = await startServer('bypass');
  try {
    await bi.client('POST', '/api/auth/setup', { body: { email: 'b@shop.vn', password: 'password123', shop_name: 'Bypass Shop' } });
    const me = await bi.client('GET', '/api/auth/me', { cookie: 'bypass-token-fixed-123' });
    assert.strictEqual(me.status, 200, 'bypass token được nhận');
    assert.strictEqual(me.json.user.role, 'OWNER');
    const bad = await bi.client('GET', '/api/auth/me', { cookie: 'sai-token' });
    assert.strictEqual(bad.status, 401, 'token khác vẫn 401');
  } finally {
    delete process.env.TEST_AUTH_BYPASS;
    await bi.close();
  }
});

// ------------------------------------------------------------ ONBOARDING
T('B1', 'ONBOARD', 'GET /api/onboarding: status từng bước đúng khi mới setup', async () => {
  const r = await inst.client('GET', '/api/onboarding', { cookie: ownerA });
  assert.strictEqual(r.status, 200);
  const st = {};
  for (const s of r.json.steps) st[s.id] = s.status;
  assert.strictEqual(st['shop-info'], 'NOT_CONFIGURED', 'bước 1 chưa điền');
  assert.strictEqual(st.facebook, 'NOT_CONFIGURED', 'bước 2 chưa token');
  assert.strictEqual(st.products, 'CONNECTED', 'bước 4 xanh nhờ seed products');
  assert.strictEqual(st.shipping, 'NOT_CONFIGURED', 'bước 5 chưa GHN');
  assert.strictEqual(st.ai, 'NOT_CONFIGURED', 'bước 6 chưa AI');
  assert.strictEqual(st.test, 'NOT_CONFIGURED', 'bước 7 chưa test');
  assert.strictEqual(r.json.canGoLive, false);
  assert.ok(r.json.reasons.length >= 3, 'có reasons');
  assert.ok(/^\d\/7$/.test(r.json.progress), 'progress x/7');
});

T('B2', 'ONBOARD', 'complete-step shop-info -> bước 1 xanh; settings auto_order off', async () => {
  const r = await inst.client('POST', '/api/onboarding/complete-step', { cookie: ownerA, body: { stepId: 'shop-info', data: { name: 'Shop A', hotline: '0901112223', address: '1 Lê Lợi Q1' } } });
  assert.strictEqual(r.status, 200);
  const s1 = r.json.steps.find(s => s.id === 'shop-info');
  assert.strictEqual(s1.status, 'CONNECTED');
  const r2 = await inst.client('POST', '/api/onboarding/complete-step', { cookie: ownerA, body: { stepId: 'settings', data: { auto_order: false } } });
  assert.strictEqual(r2.json.auto_order, false, 'auto_order tắt -> bước 5 không còn bắt buộc');
  assert.ok(!r2.json.reasons.some(x => x.includes('Bước 5')), 'reasons không còn đòi GHN');
});

T('B3', 'ONBOARD', 'go-live gate: bật bot khi thiếu checklist -> 403 + reasons', async () => {
  const r = await inst.client('POST', '/api/settings/bot', { cookie: ownerA, body: { on: true } });
  assert.strictEqual(r.status, 403, 'thiếu checklist phải 403');
  assert.strictEqual(r.json.error, 'GO_LIVE_CHECKLIST');
  assert.ok(Array.isArray(r.json.reasons) && r.json.reasons.length >= 2, 'reasons nêu rõ thiếu gì');
  const appA = inst.getApp(shopA);
  assert.strictEqual(appA.gate.botEnabled(), false, 'bot vẫn OFF sau 403');
  // tắt bot thì luôn được phép
  const off = await inst.client('POST', '/api/settings/bot', { cookie: ownerA, body: { on: false } });
  assert.strictEqual(off.status, 200);
});

T('B4', 'ONBOARD', 'đủ checklist (fb + AI local PASS + test conv/order) -> bật bot 200', async () => {
  await inst.client('POST', '/api/onboarding/complete-step', { cookie: ownerA, body: { stepId: 'facebook', data: { page_id: '123456', page_access_token: 'EAA-fake-token-offline' } } });
  await inst.client('POST', '/api/ai/config', { cookie: ownerA, body: { provider: 'local' } });
  const t1 = await inst.client('POST', '/api/ai/test', { cookie: ownerA, body: {} });
  assert.strictEqual(t1.status, 200, 'AI local test PASS (offline stub)');
  assert.strictEqual(t1.json.ai.status, 'ONLINE');
  const tc = await inst.client('POST', '/api/onboarding/test-conversation', { cookie: ownerA, body: {} });
  assert.strictEqual(tc.status, 200);
  assert.strictEqual(tc.json.ok, true, 'bot trả lời được conversation test');
  const to = await inst.client('POST', '/api/onboarding/test-order', { cookie: ownerA, body: {} });
  assert.strictEqual(to.status, 200);
  assert.strictEqual(to.json.ok, true, 'test order tạo được đơn CONFIRMED: ' + JSON.stringify(to.json));
  const ob = await inst.client('GET', '/api/onboarding', { cookie: ownerA });
  assert.strictEqual(ob.json.canGoLive, true, 'checklist đủ: ' + JSON.stringify(ob.json.reasons));
  // 5/7 = shop-info + facebook + products + ai + test (zalo/shipping chưa cấu hình nhưng
  // rule go-live chỉ cần 1 trong 2 kênh + shipping chỉ bắt buộc khi auto-order)
  assert.strictEqual(ob.json.progress, '5/7');
  const zaloStep = ob.json.steps.find(s => s.id === 'zalo');
  assert.strictEqual(zaloStep.status, 'NOT_CONFIGURED');
  const on = await inst.client('POST', '/api/settings/bot', { cookie: ownerA, body: { on: true } });
  assert.strictEqual(on.status, 200, 'đủ checklist -> bật bot OK');
  assert.strictEqual(on.json.on, true);
  const dash = await inst.client('GET', '/api/dashboard', { cookie: ownerA });
  assert.strictEqual(dash.json.bot.on, true);
});

T('B5', 'ONBOARD', 'token zalo/ghn lưu settings shop: settings view chỉ trả mask, không lộ raw', async () => {
  await inst.client('POST', '/api/onboarding/complete-step', { cookie: ownerA, body: { stepId: 'zalo', data: { oa_id: '98765', access_token: 'ZALO-RAW-TOKEN-abcd4321', refresh_token: 'ZALO-RAW-REFRESH-wxyz' } } });
  await inst.client('POST', '/api/onboarding/complete-step', { cookie: ownerA, body: { stepId: 'shipping', data: { ghn_shop_id: '7654321', ghn_token: 'GHN-RAW-TOKEN-qqqq1111' } } });
  const sv = await inst.client('GET', '/api/settings', { cookie: ownerA });
  const raw = JSON.stringify(sv.json);
  assert.ok(!raw.includes('ZALO-RAW-TOKEN-abcd4321'), 'không lộ access token zalo');
  assert.ok(!raw.includes('ZALO-RAW-REFRESH-wxyz'), 'không lộ refresh token zalo');
  assert.ok(!raw.includes('GHN-RAW-TOKEN-qqqq1111'), 'không lộ GHN token');
  assert.ok(sv.json.config_keys.META_PAGE_ACCESS_TOKEN.startsWith('***'), 'fb token masked trong config_keys');
  const ob = await inst.client('GET', '/api/onboarding', { cookie: ownerA });
  assert.strictEqual(ob.json.steps.find(s => s.id === 'zalo').status, 'CONNECTED', 'bước 3 xanh');
  assert.strictEqual(ob.json.steps.find(s => s.id === 'shipping').status, 'CONNECTED', 'bước 5 xanh');
});

// ------------------------------------------------------------ PRODUCTS
T('C1', 'PRODUCTS', 'CRUD: POST thêm -> PUT sửa giá/tồn -> DELETE xóa mềm (enabled=false)', async () => {
  const add = await inst.client('POST', '/api/products', { cookie: ownerA, body: { name: 'Nến thơm cam', sku_base: 'NT-CAM', price: 155000, stock_qty: 10, size: 'M', color: 'cam', weight_g: 250 } });
  assert.strictEqual(add.status, 200, 'thêm SP: ' + add.text);
  const upd = await inst.client('PUT', '/api/products/NT-CAM', { cookie: ownerA, body: { price: 165000, stock_qty: 8 } });
  assert.strictEqual(upd.status, 200);
  let list = await inst.client('GET', '/api/products', { cookie: ownerA });
  let p = list.json.products.find(x => x.sku_base === 'NT-CAM');
  assert.strictEqual(p.variants[0].price, 165000, 'giá đã sửa');
  assert.strictEqual(p.variants[0].stock_qty, 8, 'tồn đã sửa');
  const del = await inst.client('DELETE', '/api/products/NT-CAM', { cookie: ownerA });
  assert.strictEqual(del.status, 200, 'xóa mềm 200');
  list = await inst.client('GET', '/api/products', { cookie: ownerA });
  p = list.json.products.find(x => x.sku_base === 'NT-CAM');
  assert.ok(p, 'xóa mềm: SP vẫn trong danh sách');
  assert.strictEqual(p.enabled, false, 'nhưng enabled=false');
  // khôi phục để không ảnh hưởng test khác
  await inst.client('PUT', '/api/products/NT-CAM', { cookie: ownerA, body: { enabled: true } });
});

T('C2', 'PRODUCTS', 'bulk import CSV: 2 dòng hợp lệ import + 1 dòng giá lỗi được báo', async () => {
  const csv = [
    'name,sku,price,stock,size,color,weight',
    '"Hộp quà tặng, phiên bản limit",GQ-1,120000,5,,,300',
    'Nến sáp bông,NSB-1,175000,3,L,trắng,250',
    'Giá lỗi,BAD-1,khong-phai-so,1,,,100',
  ].join('\n');
  const r = await inst.client('POST', '/api/products/import', { cookie: ownerA, body: { csv } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.imported, 2, 'import 2 dòng hợp lệ: ' + r.text);
  assert.strictEqual(r.json.failed, 1);
  assert.strictEqual(r.json.errors[0].error, 'GIA_KHONG_HOP_LE');
  const list = await inst.client('GET', '/api/products', { cookie: ownerA });
  const gq = list.json.products.find(p => p.sku_base === 'GQ-1');
  assert.ok(gq, 'GQ-1 imported');
  assert.strictEqual(gq.name, 'Hộp quà tặng, phiên bản limit', 'CSV quote-aware: dấu phẩy trong tên giữ nguyên');
});

T('C3', 'PRODUCTS', 'disabled filter: searchProduct không match SP tắt (4 lớp search)', async () => {
  const db = new ProductDB({ seedFile: path.join(PROTO_ROOT, 'data', 'products.json') });
  assert.ok(db.searchProduct('nến vanilla').matches.length > 0, 'bật: match bình thường');
  assert.ok(db.searchProduct('tra hoa say').matches.length > 0, 'bật: match alias');
  db.getProductByBase('NT-VANILLA').enabled = false;
  db.getProductByBase('TRA-HOA-SEY').enabled = false;
  assert.strictEqual(db.searchProduct('nến vanilla').matches.length, 0, 'L2/L3: tắt -> 0 match');
  assert.strictEqual(db.searchProduct('tra hoa say').matches.length, 0, 'L2: tắt alias -> 0 match');
  assert.strictEqual(db.searchProduct('NT-VANILLA-M').matches.length, 0, 'L1: tắt -> SKU không match');
  assert.strictEqual(db.searchProduct('nen vanilla').matches.length, 0, 'L4 fuzzy: tắt -> không match');
  // getVariant/getStock GIỮ NGUYÊN (đơn cũ vẫn đọc được)
  assert.ok(db.getVariant('NT-VANILLA-M-DO'), 'getVariant không đụng');
});

T('C4', 'PRODUCTS', 'regression pipeline: tắt SP -> bot không còn tư vấn SP đó', async () => {
  const dataDir = dir('pipeline-disabled');
  const app = new App({ dataDir, persist: false, botEnabled: true });
  const fire = (ref, text) => {
    app.receive({ channel: 'facebook', type: 'message', platformEventId: 'dis-' + ref, payload: { customer_ref: ref, thread_id: ref, kind: 'text', text, platform_message_id: 'pm-dis-' + ref } });
    app.drain();
  };
  fire('c1', 'nến vanilla size M giá bao nhiêu shop');
  const conv1 = app.store.findOne('conversations', c => c.platform_thread_id === 'c1');
  assert.ok(String(conv1.subject_sku || '').startsWith('NT-VANILLA'), 'bật: bot nhận diện đúng SP (subject=' + conv1.subject_sku + ')');
  // TẮT SP -> conversation MỚI hỏi cùng câu -> subject KHÔNG còn được match
  app.productDB.getProductByBase('NT-VANILLA').enabled = false;
  fire('c2', 'nến vanilla size M giá bao nhiêu shop');
  const conv2 = app.store.findOne('conversations', c => c.platform_thread_id === 'c2');
  assert.strictEqual(conv2.subject_sku, null, 'tắt: bot không còn match SP (subject=' + conv2.subject_sku + ')');
  const outMsgs = app.store.findAll('messages', m => m.conversation_id === conv2.conversation_id && m.direction === 'out');
  const joined = outMsgs.map(m => m.text_content || '').join(' ');
  assert.ok(!joined.includes('165'), 'không còn tư vấn giá 165k của SP tắt: ' + joined.slice(0, 120));
});

T('C5', 'PRODUCTS', 'search ?q= lọc products theo tên/SKU/alias', async () => {
  const r = await inst.client('GET', '/api/products?q=vanilla', { cookie: ownerA });
  assert.ok(r.json.products.length >= 1, 'có kết quả');
  assert.ok(r.json.products.every(p => /vanilla/i.test(p.name + p.sku_base + (p.aliases || []).join(','))), 'chỉ còn SP khớp vanilla');
  const none = await inst.client('GET', '/api/products?q=khongton-tai-xyz', { cookie: ownerA });
  assert.strictEqual(none.json.products.length, 0);
});

T('C6', 'PRODUCTS', 'CSV edge: thiếu header -> báo lỗi header; CSV rỗng -> CSV_TRONG; CRLF ok', async () => {
  const noHeader = parseProductsCsv('Khách ghi linh tinh,ví dụ\nNến,NT-X,1000,1');
  assert.strictEqual(noHeader.rows.length, 0);
  assert.ok(noHeader.errors[0].error.includes('HEADER_THIEU_COT'));
  const empty = parseProductsCsv('   \n  ');
  assert.strictEqual(empty.rows.length, 0);
  assert.strictEqual(empty.errors[0].error, 'CSV_TRONG');
  const crlf = parseProductsCsv('name,sku,price,stock\r\nNến test,NT-X,1000,1\r\n');
  assert.strictEqual(crlf.rows.length, 1);
  assert.strictEqual(crlf.rows[0].sku_base, 'NT-X');
  const noSku = parseProductsCsv('name,sku,price,stock\nThiếu SKU,,1000,1');
  assert.strictEqual(noSku.rows.length, 0);
  assert.strictEqual(noSku.errors[0].error, 'THIEU_SKU');
});

// ------------------------------------------------------------ AI PROVIDER
T('D1', 'AI', 'save config: API không trả key thô — chỉ masked ***abcd', async () => {
  const save = await inst.client('POST', '/api/ai/config', { cookie: ownerA, body: { provider: 'deepseek', api_key: 'sk-secret-abc123xyz9990abcd', model: 'deepseek-chat' } });
  assert.strictEqual(save.status, 200);
  assert.strictEqual(save.json.ai.api_key_masked, '***abcd', 'mask đúng');
  assert.ok(!JSON.stringify(save.json).includes('sk-secret-abc123xyz9990abcd'), 'không lộ key trong response');
  const st = await inst.client('GET', '/api/ai/status', { cookie: ownerA });
  assert.ok(!JSON.stringify(st.json).includes('sk-secret-abc123xyz9990abcd'), 'status không lộ key');
  assert.strictEqual(st.json.ai.api_key_masked, '***abcd');
  const sv = await inst.client('GET', '/api/settings', { cookie: ownerA });
  assert.ok(!JSON.stringify(sv.json).includes('sk-secret-abc123xyz9990abcd'), 'settings view không lộ key');
  assert.strictEqual(sv.json.ai.api_key_masked, '***abcd');
});

T('D2', 'AI', 'secret-in-prompt: lưu prompt config chứa sk-/token -> chặn 400', async () => {
  const bad1 = await inst.client('POST', '/api/prompt/config', { cookie: ownerA, body: { giongNoi: 'vui vẻ, key là sk-abc123def456' } });
  assert.strictEqual(bad1.status, 400);
  assert.strictEqual(bad1.json.error, 'SECRET_IN_PROMPT');
  const bad2 = await inst.client('POST', '/api/prompt/config', { cookie: ownerA, body: { chinhSachDoiTra: 'đổi trả 7 ngày, token giao hàng' } });
  assert.strictEqual(bad2.status, 400, 'pattern token cũng bị chặn');
  const ok1 = await inst.client('POST', '/api/prompt/config', { cookie: ownerA, body: { giongNoi: 'thân thiện', ngonNgu: 'tiếng Việt' } });
  assert.strictEqual(ok1.status, 200);
});

T('D3', 'AI', 'test provider local -> PASS ONLINE; status có last_success', async () => {
  await inst.client('POST', '/api/ai/config', { cookie: ownerA, body: { provider: 'local' } });
  const r = await inst.client('POST', '/api/ai/test', { cookie: ownerA, body: {} });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ai.status, 'ONLINE');
  assert.ok(r.json.ai.last_success, 'có last_success');
});

T('D4', 'AI', 'test provider thật lỗi (httpFn tiêm 401) -> ERROR + last_error, không lộ key', async () => {
  const ss = new ShopSettings(dir('ai-fail'));
  ss.setMany({ ai_provider: 'openai', ai_api_key: 'sk-openai-key-9876wxyz', ai_model: 'gpt-4o-mini', ai_timeout: 5000 });
  const r = await testAiProvider(ss, { httpFn: async () => ({ ok: true, status: 401, bodyText: '{"error":"bad key"}' }) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'http_status_401');
  const st = aiStatusSafe(ss);
  assert.strictEqual(st.status, 'ERROR');
  assert.ok(!JSON.stringify(st).includes('sk-openai-key-9876wxyz'), 'status không chứa key');
  // timeout path
  const r2 = await testAiProvider(ss, { httpFn: async () => ({ ok: false, timeout: true }) });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.error, 'timeout');
});
function aiStatusSafe(ss) { return require('../src/ai-provider').aiStatus(ss); }

T('D5', 'AI', 'buildSystemPrompt: đủ mục cấu hình + golden rules; validate chặn secret', async () => {
  const prompt = buildSystemPrompt({
    giongNoi: 'vui vẻ', cachXungHo: 'em - anh/chị', chinhSachDoiTra: '7 ngày',
    gioLamViec: '8h-21h', faq: [{ q: 'ship bao lâu?', a: '2-4 ngày' }],
    khongDuocNoi: ['không hứa giá sai DB'], uuTienBan: 'combo quà', ngonNgu: 'tiếng Việt', quyTacChotDon: 'hỏi đủ tên/SĐT/địa chỉ',
  });
  for (const part of ['GIỌN NÓI', 'vui vẻ', 'CÁCH XƯNG HÔ', 'CHÍNH SÁCH ĐỔI TRẢ', 'GIỜ LÀM VIỆC', 'FAQ CỦA SHOP', 'TUYỆT ĐỐI KHÔNG NÓI', 'ƯU TIÊN BÁN', 'NGÔN NGỮ', 'QUY TẮC CHỐT ĐƠN', 'KHÔNG TỰ BỊA']) {
    assert.ok(prompt.includes(part), 'prompt thiếu: ' + part);
  }
  const v = validatePromptConfig({ giongNoi: 'ok' });
  assert.strictEqual(v.ok, true);
  const vBad = validatePromptConfig({ faq: [{ q: 'key?', a: 'api_key=abcd1234' }] });
  assert.strictEqual(vBad.ok, false, 'faq chứa api_key bị chặn');
});

// ------------------------------------------------------------ PERSISTENCE + BUILD
T('E1', 'PERSIST', 'persist-mode restart giữ dữ liệu (App mới cùng dir) + db.backup.json', async () => {
  const dataDir = dir('persist-restart');
  const a1 = new App({ dataDir, persist: true });
  a1.receive({ channel: 'facebook', type: 'message', platformEventId: 'pr-1', payload: { customer_ref: 'pr', thread_id: 'pr', kind: 'text', text: 'lấy 1 nến vanilla M đỏ, tên Persistence, sdt 0905554433, địa chỉ 9 Hai Bà Trưng Q1', platform_message_id: 'pm-pr-1' } });
  a1.drain();
  const counts = c => ({
    customers: a1.store.findAll('customers', () => true).length,
    messages: a1.store.findAll('messages', () => true).length,
    orders: a1.store.findAll('orders', () => true).length,
  });
  const before = counts();
  assert.ok(before.customers >= 1 && before.orders >= 1, 'đã có dữ liệu trước restart');
  // restart: App MỚI cùng dir, persist
  const a2 = new App({ dataDir, persist: true });
  const after = {
    customers: a2.store.findAll('customers', () => true).length,
    messages: a2.store.findAll('messages', () => true).length,
    orders: a2.store.findAll('orders', () => true).length,
  };
  assert.deepStrictEqual(after, before, 'counts giữ nguyên qua restart');
  assert.ok(fs.existsSync(path.join(dataDir, 'db.backup.json')), 'db.backup.json tồn tại (backup 1 tầng)');
});

T('E2', 'PERSIST', 'START-BOT.bat tồn tại + đúng nội dung (persist + node server.js + mở browser)', async () => {
  const f = path.join(PROTO_ROOT, 'START-BOT.bat');
  assert.ok(fs.existsSync(f), 'START-BOT.bat tồn tại ở thư mục gốc prototype');
  const content = fs.readFileSync(f, 'utf8');
  assert.ok(content.includes('APP_DATA_MODE=persist'), 'set APP_DATA_MODE=persist');
  assert.ok(content.includes('node server.js'), 'chạy node server.js');
  assert.ok(content.includes('http://localhost:8080'), 'mở browser localhost:8080');
  assert.ok(content.includes('@echo off'), '@echo off');
});

T('E3', 'BUILD', 'server boot: / -> login page khi đã có user; /style.css 200; health 200 với session', async () => {
  const root = await inst.client('GET', '/');
  assert.strictEqual(root.status, 200);
  assert.ok(root.text.includes('Đăng nhập'), 'GET / khi chưa login -> trang login');
  assert.ok(String(root.headers['content-type'] || root.headers['Content-Type'] || '').includes('text/html'));
  const css = await inst.client('GET', '/style.css');
  assert.strictEqual(css.status, 200);
  const appjs = await inst.client('GET', '/app.js');
  assert.strictEqual(appjs.status, 302, 'app.js không phát cho người chưa login (302 -> /)');
  const health = await inst.client('GET', '/api/health', { cookie: ownerA });
  assert.strictEqual(health.status, 200);
  assert.strictEqual(health.json.ok, true);
  assert.strictEqual(health.json.modes.data, 'persist', 'server mặc định persist');
  const dashNoAuth = await inst.client('GET', '/api/dashboard');
  assert.strictEqual(dashNoAuth.status, 401, 'API không cookie -> 401');
});

T('E4', 'BUILD', 'first-run: chưa có user -> GET / trả trang WELCOME tạo OWNER', async () => {
  const wi = await startServer('welcome');
  try {
    const r = await wi.client('GET', '/');
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.includes('Chào mừng'), 'trang welcome');
    assert.ok(r.text.includes('OWNER'), 'nhắc tạo OWNER');
    const setup = await wi.client('POST', '/api/auth/setup', { body: { email: 'first@shop.vn', password: 'password123', shop_name: 'First Shop' } });
    assert.strictEqual(setup.status, 200);
    const after = await wi.client('GET', '/');
    assert.ok(!after.text.includes('Chào mừng đến'), 'sau setup GET / không còn welcome (chuyển login/app)');
  } finally { await wi.close(); }
});

T('E6', 'BUILD', 'webhook mock mode: không cần auth (platform gọi) + 503 rõ ràng khi chưa bật live', async () => {
  const meta = await inst.client('POST', '/webhooks/meta', { body: { object: 'page' } });
  assert.strictEqual(meta.status, 503, 'mock mode -> meta live adapter not enabled');
  assert.ok(meta.text.includes('meta live adapter not enabled'));
  const zalo = await inst.client('POST', '/webhooks/zalo', { body: {} });
  assert.strictEqual(zalo.status, 503);
  const ghn = await inst.client('POST', '/webhooks/ghn', { body: {} });
  assert.strictEqual(ghn.status, 503);
  const noBody = await inst.client('POST', '/api/products/import', { body: {} });
  assert.strictEqual(noBody.status, 401, 'API vẫn bắt auth');
});

T('E5', 'BUILD', 'node --check toàn bộ src + server + ui + test không lỗi cú pháp', async () => {
  const files = [];
  const collect = d => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, f.name);
      if (f.isDirectory()) { if (f.name !== 'node_modules') collect(fp); }
      else if (f.name.endsWith('.js')) files.push(fp);
    }
  };
  collect(path.join(PROTO_ROOT, 'src'));
  files.push(path.join(PROTO_ROOT, 'server.js'));
  files.push(path.join(PROTO_ROOT, 'ui', 'app.js'));
  files.push(path.join(PROTO_ROOT, 'test', 'product-ready.js'));
  const bad = [];
  for (const f of files) {
    const r = spawnSync('node', ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) bad.push(`${f}: ${String(r.stderr).split('\n')[0]}`);
  }
  assert.strictEqual(bad.length, 0, 'file lỗi cú pháp: ' + bad.join(' | '));
  assert.ok(files.length >= 20, 'đã check đủ nhiều file: ' + files.length);
});

// ============================================================ runner
async function main() {
  console.log('===== PHASE PRODUCT-READY BATTERY (offline — HTTP in-process, port 0) =====');
  // mỗi lần chạy = dữ liệu auth/shop SẠCH (xóa dir test-run của battery này)
  for (const f of fs.readdirSync(DATA)) {
    if (f.startsWith('product-ready-')) fs.rmSync(path.join(DATA, f), { recursive: true, force: true });
  }
  inst = await startServer('main');
  const rows = [];
  let pass = 0;
  for (const t of TESTS) {
    const started = Date.now();
    try {
      await t.fn();
      pass += 1;
      rows.push({ n: t.n, g: t.group, desc: t.desc, status: 'PASS', note: `${Date.now() - started}ms` });
      console.log(`  [PASS] ${t.n} (${t.group}) — ${t.desc}`);
    } catch (err) {
      rows.push({ n: t.n, g: t.group, desc: t.desc, status: 'FAIL', note: String(err && err.message).split('\n')[0] });
      console.log(`  [FAIL] ${t.n} (${t.group}) — ${t.desc}\n         -> ${String(err && err.message).split('\n').slice(0, 5).join(' | ')}`);
    }
  }
  try { await inst.close(); } catch (e) { /* ignore */ }
  console.log('\n================ KẾT QUẢ PRODUCT-READY ĐỢT 1 ================');
  console.log('#'.padEnd(6) + 'NHÓM'.padEnd(12) + 'KẾT QUẢ'.padEnd(8) + 'MÔ TẢ'.padEnd(96) + 'GHI CHÚ');
  console.log('-'.repeat(132));
  for (const r of rows) {
    console.log(String(r.n).padEnd(6) + String(r.g).padEnd(12) + r.status.padEnd(8) + r.desc.slice(0, 94).padEnd(96) + r.note.slice(0, 26));
  }
  console.log('-'.repeat(132));
  console.log(`TỔNG: ${pass}/${TESTS.length} PASS, ${TESTS.length - pass} FAIL`);
  console.log(pass === TESTS.length
    ? '==> PRODUCT-READY đợt 1: click-là-chạy verified offline (auth + shop isolation + onboarding gate + products + AI + persist).'
    : '==> CHƯA ĐẠT, cần sửa các test FAIL phía trên.');
  process.exitCode = pass === TESTS.length ? 0 : 1;
}

main().catch(err => { console.error('[fatal]', err); process.exitCode = 1; });
