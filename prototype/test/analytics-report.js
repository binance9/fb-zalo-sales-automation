'use strict';
// test/analytics-report.js — TEST STANDALONE module BÁO CÁO & THỐNG KÊ (chuẩn aicake).
// Boot server qua factory createServer (port 0 — OS tự chọn port rảnh, authDir/shopsRoot trong TEMP,
// cô lập khỏi data thật — pattern như test/matrix/_harness.js). Seed đơn qua /api/debug/customer-message
// (đi ĐÚNG đường webhook) + confirm qua API, rồi assert buildAnalytics + GET /api/analytics.
// Kết thúc: in "analytics-report: X/X PASS"; exit 0 khi toàn bộ PASS.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../server');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// HTTP client nhỏ (giống makeClient của matrix harness)
function makeClient(base) {
  const u0 = new URL(base);
  return function call(method, p, { body, cookie } = {}) {
    return new Promise((resolve, reject) => {
      const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
      const headers = {};
      if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
      if (cookie) headers.Cookie = `sid=${cookie}`;
      const req = http.request({ hostname: u0.hostname, port: u0.port, path: p, method, headers }, res => {
        let out = '';
        res.on('data', c => { out += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(out); } catch (e) { /* không phải JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, json, text: out });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  };
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); }
}

async function main() {
  // ---- boot server test: port rảnh (0), authDir/shopsRoot trong TEMP ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-report-'));
  const inst = createServer({
    port: 0,
    authDir: path.join(tmp, 'auth'),
    shopsRoot: path.join(tmp, 'shops'),
    uiDemo: '0',
    appDataMode: 'persist',
  });
  inst.listen();
  for (let i = 0; i < 60 && !inst.server.listening; i++) await sleep(20);
  const port = inst.server.address().port;
  const client = makeClient(`http://127.0.0.1:${port}`);
  console.log(`analytics-report: server test @ 127.0.0.1:${port} (TEMP ${tmp})`);

  try {
    // ---- 1) CHƯA LOGIN -> 401 ----
    const unauth = await client('GET', '/api/analytics');
    check('API 401 khi chưa login', unauth.status === 401, unauth.status);

    // ---- 2) setup OWNER + go-live checklist (như matrix harness — bot ON, AI local) ----
    const setup = await client('POST', '/api/auth/setup', {
      body: { email: 'owner-analytics@test.vn', password: 'password123', shop_name: 'Analytics Shop' },
    });
    if (setup.status !== 200) throw new Error('setup fail: ' + setup.text.slice(0, 120));
    const sid = setup.headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
    const shop = setup.json.shop.shop_id;
    const app = inst.getApp(shop);
    check('setup OWNER + getApp', !!(sid && shop && app));

    for (const [stepId, data] of [
      ['shop-info', { name: 'Analytics Shop', hotline: '0900000000', address: '1 Test St Q1' }],
      ['facebook', { page_id: 'page-an', page_access_token: 'ptk-an' }],
      ['zalo', { oa_id: 'oa-an', access_token: 'zat-an' }],
      ['shipping', { ghn_token: 'ghn-an', ghn_shop_id: '222222' }],
      ['ai', { provider: 'local' }],
    ]) {
      const r = await client('POST', '/api/onboarding/complete-step', { cookie: sid, body: { stepId, data } });
      if (r.status !== 200) throw new Error('step ' + stepId + ' fail');
    }
    await client('POST', '/api/ai/test', { cookie: sid, body: {} });
    const bot = await client('POST', '/api/settings/bot', { cookie: sid, body: { on: true } });
    if (bot.status !== 200) throw new Error('bot on fail: ' + bot.text.slice(0, 140));
    await client('POST', '/api/ai/config', { cookie: sid, body: { use_for_replies: false } }); // deterministic, không LLM mạng

    // ---- 3) seed 3 đơn CONFIRMED qua /api/debug/customer-message (đường webhook thật) ----
    //  A: TRA-HOA-SEY-50 · B: NT-VANILLA-S · C: NT-VANILLA-M-DO (B+C cùng base NT-VANILLA -> test gộp variant)
    async function seedConfirmedOrder(ref, text) {
      await client('POST', '/api/debug/customer-message', { cookie: sid, body: { channel: 'facebook', ref, text } });
      const conv = app.store.findOne('conversations', c => c.platform_thread_id === ref);
      if (!conv) throw new Error('seed: không tạo được conversation cho ' + ref);
      const draft = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
      if (!draft) throw new Error('seed: không tạo được draft cho ' + ref);
      const cf = await client('POST', '/api/orders/' + draft.order_id + '/confirm', { cookie: sid, body: {} });
      if (cf.status !== 200) throw new Error('confirm fail ' + cf.status + ': ' + cf.text.slice(0, 140));
      return app.store.findOne('orders', o => o.order_id === draft.order_id);
    }
    const ordA = await seedConfirmedOrder('fb-an-a', 'lấy 1 hộp trà hoa sấy, tên Khach A, sdt 0931111111, địa chỉ 1 A St Q1');
    const ordB = await seedConfirmedOrder('fb-an-b', 'mua 1 hộp NT-VANILLA-S, tên Khach B, sdt 0932222222, địa chỉ 2 B St Q1');
    const ordC = await seedConfirmedOrder('fb-an-c', 'lấy 1 hộp NT-VANILLA-M-DO, tên Khach C, sdt 0933333333, địa chỉ 3 C St Q1');

    // 1 hội thoại tiếp quản bởi nhân viên (mode HUMAN) -> giảm autonomy
    const convC = app.store.findOne('conversations', c => c.platform_thread_id === 'fb-an-c');
    const tk = await client('POST', '/api/conversations/' + encodeURIComponent(convC.conversation_id) + '/takeover', { cookie: sid, body: {} });
    check('takeover hội thoại C (mode HUMAN)', tk.status === 200, tk.status);

    const expectRevenue = [ordA, ordB, ordC].reduce((s, o) => s + Number(o.total || 0), 0);
    check('3 đơn CONFIRMED sau seed', [ordA, ordB, ordC].every(o => o.status === 'CONFIRMED'),
      [ordA, ordB, ordC].map(o => o.status));

    // ---- 4) GET /api/analytics (đã login) ----
    const r = await client('GET', '/api/analytics', { cookie: sid });
    check('API 200 khi đã login', r.status === 200, r.status);
    const a = r.json || {};

    check('range_days mặc định 14', a.range_days === 14, a.range_days);
    check('revenue_by_day đủ 14 ngày', Array.isArray(a.revenue_by_day) && a.revenue_by_day.length === 14,
      a.revenue_by_day && a.revenue_by_day.length);
    const dayRevSum = (a.revenue_by_day || []).reduce((s, d) => s + d.revenue, 0);
    const dayOrdSum = (a.revenue_by_day || []).reduce((s, d) => s + d.orders, 0);
    check('revenue_by_day đúng tổng doanh thu 3 đơn', dayRevSum === expectRevenue, { dayRevSum, expectRevenue });
    check('revenue_by_day đúng tổng số đơn (3)', dayOrdSum === 3, dayOrdSum);
    check('revenue_by_day có entry ngày hôm nay', (a.revenue_by_day || []).some(d => d.date && d.revenue > 0), a.revenue_by_day);

    check('orders_by_status CONFIRMED = 3', a.orders_by_status && a.orders_by_status.CONFIRMED === 3, a.orders_by_status);

    // ---- 5) top_products GỘP variant: NT-VANILLA-S + NT-VANILLA-M-DO -> NT-VANILLA qty 2 ----
    const tp = a.top_products || [];
    const merged = tp.find(p => p.sku === 'NT-VANILLA');
    check('top_products gộp variant về sku gốc NT-VANILLA', !!merged, tp.map(p => p.sku));
    check('NT-VANILLA qty = 2 (2 variant cộng dồn)', merged && merged.qty === 2, merged);
    check('NT-VANILLA orders = 2 (2 đơn riêng biệt)', merged && merged.orders === 2, merged);
    check('không còn SKU variant lẻ trong top_products',
      !tp.some(p => p.sku === 'NT-VANILLA-S' || p.sku === 'NT-VANILLA-M-DO'), tp.map(p => p.sku));
    const traHit = tp.find(p => p.sku === 'TRA-HOA-SEY');
    check('TRA-HOA-SEY qty = 1 (đơn A)', traHit && traHit.qty === 1, traHit);

    // ---- 6) top_customers + summary ----
    const tc = a.top_customers || [];
    check('top_customers đủ 3 khách', tc.length === 3, tc.length);
    check('top_customers tổng chi tiêu = tổng doanh thu', tc.reduce((s, c) => s + c.total_spent, 0) === expectRevenue,
      tc.map(c => c.total_spent));
    check('top_customers có tên (không rỗng)', tc.every(c => c.name && c.name.length > 0), tc.map(c => c.name));

    const s = a.summary || {};
    check('summary.revenue_total đúng', s.revenue_total === expectRevenue, { got: s.revenue_total, want: expectRevenue });
    check('summary.orders_total = 3', s.orders_total === 3, s.orders_total);
    check('summary.customers_total = 3', s.customers_total === 3, s.customers_total);
    check('summary.avg_order_value = round(revenue/orders)',
      s.avg_order_value === Math.round(expectRevenue / 3), s.avg_order_value);

    // ---- 7) ai_performance ----
    const ai = a.ai_performance || {};
    check('ai.total_conversations = 3', ai.total_conversations === 3, ai.total_conversations);
    check('ai.human_takeover = 1 (hội thoại C)', ai.human_takeover === 1, ai.human_takeover);
    check('ai.ai_handled = 2 (A, B)', ai.ai_handled === 2, ai.ai_handled);
    check('autonomy_pct = round(2/3*100) = 67', ai.autonomy_pct === 67, ai.autonomy_pct);
    check('autonomy_pct trong 0..100', ai.autonomy_pct >= 0 && ai.autonomy_pct <= 100, ai.autonomy_pct);

    // ---- 8) days param: /api/analytics?days=7 ----
    const r7 = await client('GET', '/api/analytics?days=7', { cookie: sid });
    check('?days=7 -> range_days 7 + đủ 7 entry ngày', r7.status === 200 && r7.json.range_days === 7
      && Array.isArray(r7.json.revenue_by_day) && r7.json.revenue_by_day.length === 7,
      r7.json && r7.json.range_days);
  } finally {
    // ---- teardown: đóng server + dọn TEMP ----
    try { await inst.close(); } catch (e) { /* đã đóng */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }

  console.log(`analytics-report: ${pass}/${pass + fail} PASS`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('analytics-report: LỖI CHẠY TEST —', err && (err.stack || err.message || err));
  console.log(`analytics-report: ${pass}/${pass + fail} PASS`);
  process.exit(1);
});
