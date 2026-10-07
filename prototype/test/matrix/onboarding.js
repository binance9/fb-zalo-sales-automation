'use strict';
// test/matrix/onboarding.js — AREA ONBOARDING (20 case)
const assert = require('assert');
const { startInst } = require('./_harness');

module.exports = {
  area: 'Onboarding',
  async setup() {
    const inst = await startInst('onboarding');
    const s = await inst.client('POST', '/api/auth/setup', { body: { email: 'ob@matrix.vn', password: 'password123', shop_name: 'OB' } });
    const sid = s.headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
    const shop = s.json.shop.shop_id;
    return { inst, sid, shop, app: inst.getApp(shop) };
  },
  cases: [
    { id: 'OB01', desc: 'GET /api/onboarding trả đúng 7 bước với id chuẩn', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/api/onboarding', { cookie: ctx.sid });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.steps.length, 7);
      assert.deepStrictEqual(r.json.steps.map(s => s.id), ['shop-info', 'facebook', 'zalo', 'products', 'shipping', 'ai', 'test']);
    } },
    { id: 'OB02', desc: 'khởi điểm: shop-info NOT_CONFIGURED', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/api/onboarding', { cookie: ctx.sid });
      const s1 = r.json.steps.find(s => s.id === 'shop-info');
      assert.strictEqual(s1.status, 'NOT_CONFIGURED');
      assert.strictEqual(r.json.canGoLive, false);
    } },
    { id: 'OB03', desc: 'complete-step shop-info -> CONNECTED với chiTiet đủ 3 trường', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/onboarding/complete-step', { cookie: ctx.sid, body: { stepId: 'shop-info', data: { name: 'OB Shop', hotline: '0911111111', address: '2 OB St' } } });
      assert.strictEqual(r.status, 200);
      const s1 = r.json.steps.find(s => s.id === 'shop-info');
      assert.strictEqual(s1.status, 'CONNECTED');
      assert.strictEqual(s1.chiTiet.shop_name, 'OB Shop');
    } },
    { id: 'OB04', desc: 'bước products XANH sẵn nhờ seed (enabled_count >= 4)', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/api/onboarding', { cookie: ctx.sid });
      const s4 = r.json.steps.find(s => s.id === 'products');
      assert.strictEqual(s4.status, 'CONNECTED');
      assert.ok(s4.chiTiet.enabled_count >= 4);
    } },
    { id: 'OB05', desc: 'bước facebook NOT_CONFIGURED -> sau complete-step CONNECTED, token chỉ mask', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/onboarding/complete-step', { cookie: ctx.sid, body: { stepId: 'facebook', data: { page_id: 'pg-ob', page_access_token: 'ptk-ob-secret-123' } } });
      assert.strictEqual(r.status, 200);
      const s2 = r.json.steps.find(s => s.id === 'facebook');
      assert.strictEqual(s2.status, 'CONNECTED');
      assert.strictEqual(s2.chiTiet.token_masked, '***');
      const raw = JSON.stringify(r.json);
      assert.ok(!raw.includes('ptk-ob-secret-123'), 'token thô không nằm trong response');
    } },
    { id: 'OB06', desc: 'unknown step -> 400 UNKNOWN_STEP', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/onboarding/complete-step', { cookie: ctx.sid, body: { stepId: 'titanium', data: {} } });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.json.error, 'UNKNOWN_STEP');
    } },
    { id: 'OB07', desc: 'go-live khi thiếu (không AI) -> 403 GO_LIVE_CHECKLIST + reasons nêu bước 6', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/settings/bot', { cookie: ctx.sid, body: { on: true } });
      assert.strictEqual(r.status, 403);
      assert.strictEqual(r.json.error, 'GO_LIVE_CHECKLIST');
      assert.ok(Array.isArray(r.json.reasons) && r.json.reasons.some(x => x.includes('Bước 6')), JSON.stringify(r.json.reasons));
    } },
    { id: 'OB08', desc: 'tắt bot LUÔN được phép (không gate khi off)', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/settings/bot', { cookie: ctx.sid, body: { on: false } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.on, false);
    } },
    { id: 'OB09', desc: 'cấu hình AI local + test PASS -> bước ai ONLINE', async fn(ctx) {
      await ctx.inst.client('POST', '/api/onboarding/complete-step', { cookie: ctx.sid, body: { stepId: 'ai', data: { provider: 'local' } } });
      const t = await ctx.inst.client('POST', '/api/ai/test', { cookie: ctx.sid, body: {} });
      assert.strictEqual(t.status, 200);
      assert.strictEqual(t.json.ai.status, 'ONLINE');
    } },
    { id: 'OB10', desc: 'bước zalo complete -> CONNECTED', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/onboarding/complete-step', { cookie: ctx.sid, body: { stepId: 'zalo', data: { oa_id: 'oa-ob', access_token: 'zat-ob' } } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.steps.find(s => s.id === 'zalo').status, 'CONNECTED');
    } },
    { id: 'OB11', desc: 'bước shipping complete -> CONNECTED', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/onboarding/complete-step', { cookie: ctx.sid, body: { stepId: 'shipping', data: { ghn_token: 'ghn-ob', ghn_shop_id: '333' } } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.steps.find(s => s.id === 'shipping').status, 'CONNECTED');
    } },
    { id: 'OB12', desc: 'đủ checklist -> canGoLive true, progress 6/7 (chưa test)', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/api/onboarding', { cookie: ctx.sid });
      assert.strictEqual(r.json.canGoLive, true);
      assert.strictEqual(r.json.reasons.length, 0);
      assert.strictEqual(r.json.progress, '6/7');
    } },
    { id: 'OB13', desc: 'bot ON 200 sau khi đủ go-live', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/settings/bot', { cookie: ctx.sid, body: { on: true } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.on, true);
    } },
    { id: 'OB14', desc: 'test-conversation: bot trả lời thật + cờ settings lưu', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/onboarding/test-conversation', { cookie: ctx.sid, body: {} });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.ok, true);
      assert.strictEqual(r.json.bot_replied, true);
      const st = ctx.app.store.findOne('settings', s => s.key === 'onboarding_test_conversation');
      assert.strictEqual(st.value, true);
    } },
    { id: 'OB15', desc: 'test-order: tạo được đơn CONFIRMED + cờ settings lưu', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/onboarding/test-order', { cookie: ctx.sid, body: {} });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.ok, true);
      assert.strictEqual(r.json.order.status, 'CONFIRMED');
      const st = ctx.app.store.findOne('settings', s => s.key === 'onboarding_test_order');
      assert.strictEqual(st.value, true);
    } },
    { id: 'OB16', desc: 'sau test: bước 7 CONNECTED -> progress 7/7', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/api/onboarding', { cookie: ctx.sid });
      assert.strictEqual(r.json.progress, '7/7');
      assert.strictEqual(r.json.steps.find(s => s.id === 'test').status, 'CONNECTED');
    } },
    { id: 'OB17', desc: 'AGENT gọi onboarding -> 403 FORBIDDEN_ROLE', async fn(ctx) {
      await ctx.inst.client('POST', '/api/auth/users', { cookie: ctx.sid, body: { email: 'ob-agent@matrix.vn', password: 'password789', role: 'AGENT' } });
      const ag = (await ctx.inst.client('POST', '/api/auth/login', { body: { email: 'ob-agent@matrix.vn', password: 'password789' } })).headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
      assert.strictEqual((await ctx.inst.client('GET', '/api/onboarding', { cookie: ag })).status, 403);
      assert.strictEqual((await ctx.inst.client('POST', '/api/onboarding/complete-step', { cookie: ag, body: { stepId: 'shop-info', data: {} } })).status, 403);
    } },
    { id: 'OB18', desc: 'auto_order FALSE -> go-live không đòi bước shipping', async fn(ctx) {
      // shop mới riêng để không phá checklist của shop chính
      const shop2 = ctx.inst.auth.createShop('OB Shop 2').shop_id;
      const u2 = await ctx.inst.client('POST', '/api/auth/users', { cookie: ctx.sid, body: { email: 'ob2@matrix.vn', password: 'password123', role: 'OWNER', shop_id: shop2 } });
      assert.strictEqual(u2.status, 200);
      const sid2 = (await ctx.inst.client('POST', '/api/auth/login', { body: { email: 'ob2@matrix.vn', password: 'password123' } })).headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
      const app2 = ctx.inst.getApp(shop2);
      await ctx.inst.client('POST', '/api/onboarding/complete-step', { cookie: sid2, body: { stepId: 'shop-info', data: { name: 'OB2', hotline: '0922222222', address: '3 OB St' } } });
      await ctx.inst.client('POST', '/api/onboarding/complete-step', { cookie: sid2, body: { stepId: 'facebook', data: { page_id: 'pg2', page_access_token: 'ptk2' } } });
      await ctx.inst.client('POST', '/api/onboarding/complete-step', { cookie: sid2, body: { stepId: 'ai', data: { provider: 'local' } } });
      await ctx.inst.client('POST', '/api/ai/test', { cookie: sid2, body: {} });
      await ctx.inst.client('POST', '/api/onboarding/complete-step', { cookie: sid2, body: { stepId: 'settings', data: { auto_order: false } } });
      const ob = await ctx.inst.client('GET', '/api/onboarding', { cookie: sid2 });
      assert.strictEqual(ob.json.canGoLive, true, 'không GHN vẫn go-live được khi tắt auto-order');
      assert.strictEqual(app2 ? true : true, true);
    } },
    { id: 'OB19', desc: 'auto_order TRUE thiếu GHN -> reasons đòi bước 5', async fn(ctx) {
      const shop3 = ctx.inst.auth.createShop('OB Shop 3').shop_id;
      await ctx.inst.client('POST', '/api/auth/users', { cookie: ctx.sid, body: { email: 'ob3@matrix.vn', password: 'password123', role: 'OWNER', shop_id: shop3 } });
      const sid3 = (await ctx.inst.client('POST', '/api/auth/login', { body: { email: 'ob3@matrix.vn', password: 'password123' } })).headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
      ctx.inst.getApp(shop3);
      await ctx.inst.client('POST', '/api/onboarding/complete-step', { cookie: sid3, body: { stepId: 'shop-info', data: { name: 'OB3', hotline: '0933333333', address: '4 OB St' } } });
      await ctx.inst.client('POST', '/api/onboarding/complete-step', { cookie: sid3, body: { stepId: 'facebook', data: { page_id: 'pg3', page_access_token: 'ptk3' } } });
      await ctx.inst.client('POST', '/api/onboarding/complete-step', { cookie: sid3, body: { stepId: 'ai', data: { provider: 'local' } } });
      await ctx.inst.client('POST', '/api/ai/test', { cookie: sid3, body: {} });
      await ctx.inst.client('POST', '/api/onboarding/complete-step', { cookie: sid3, body: { stepId: 'settings', data: { auto_order: true } } });
      const ob = await ctx.inst.client('GET', '/api/onboarding', { cookie: sid3 });
      assert.strictEqual(ob.json.canGoLive, false);
      assert.ok(ob.json.reasons.some(x => x.includes('Bước 5')), JSON.stringify(ob.json.reasons));
    } },
    { id: 'OB20', desc: 'onboarding không cookie -> 401', async fn(ctx) {
      assert.strictEqual((await ctx.inst.client('GET', '/api/onboarding')).status, 401);
    } },
  ],
};
