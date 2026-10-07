'use strict';
// test/matrix/security.js — AREA SECURITY (20 case): rate limit, session expiry, AGENT 403,
// shop isolation, CSRF/SameSite, secrets (response/UI/audit), webhook signature, GHN token,
// PII out of model context, secret-in-prompt chặn.
const assert = require('assert');
const crypto = require('crypto');
const { startInst, setupShop, fire } = require('./_harness');
const { MetaAdapter } = require('../../src/channel/meta-adapter');
const { GhnAdapter } = require('../../src/shipping/ghn-adapter');

module.exports = {
  area: 'Security',
  async setup() {
    const inst = await startInst('security');
    const { sid, shop, app } = await setupShop(inst, { email: 'sec@matrix.vn' });
    const agent = await inst.client('POST', '/api/auth/users', { cookie: sid, body: { email: 'sec-agent@matrix.vn', password: 'password789', role: 'AGENT' } });
    assert.strictEqual(agent.status, 200);
    const sidAgent = (await inst.client('POST', '/api/auth/login', { body: { email: 'sec-agent@matrix.vn', password: 'password789' } })).headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
    const shopB = inst.auth.createShop('Sec Shop B').shop_id;
    await inst.client('POST', '/api/auth/users', { cookie: sid, body: { email: 'sec-b@matrix.vn', password: 'password123', role: 'OWNER', shop_id: shopB } });
    const sidB = (await inst.client('POST', '/api/auth/login', { body: { email: 'sec-b@matrix.vn', password: 'password123' } })).headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
    // shop B có dữ liệu riêng
    const appB = inst.getApp(shopB);
    // [TEST-FIX SE11/SE12] Bật bot cho shop B (fixture chủ shop B đã go-live): draft đơn chỉ
    // được tạo qua gate.createOrder mà authorize từ chối 'bot_off' khi bot tắt (core ĐÚNG) —
    // trước đây B không có đơn nào nên case isolation không có gì để đối chiếu. Bật đúng
    // đường DỮ LIỆU (settings store của B), không đụng core.
    {
      const row = appB.store.findOne('settings', s => s.key === 'bot_enabled');
      appB.store.transaction(() => { appB.store.updateRow('settings', row, { value: true }); });
    }
    // [TEST-FIX SE11/SE12] tên khách phải >= 2 chữ cái ("Bin" thay "B"): slot extractor (P3B)
    // bắt tên theo regex [chữ đầu]{1,30}+ — tên 1 ký tự không được nhận -> thiếu slot name ->
    // gate từ chối tạo đơn. Case này test CÔNG LÝ shop isolation (A không đọc/ghi được đơn của
    // B), không test parser tên — dữ liệu phải tạo được đơn ở B để đối chiếu.
    fire(appB, 'facebook', 'sec-b-khach', 'đơn của shop B đây, lấy 1 hộp trà hoa sấy, tên Bin, sdt 0935551234, địa chỉ B Street Q1', 'sec-b-1');
    // shop A có token riêng
    await inst.client('POST', '/api/onboarding/complete-step', { cookie: sid, body: { stepId: 'facebook', data: { page_id: 'pg-sec', page_access_token: 'ptk-SUPER-SECRET-9876' } } });
    return { inst, sid, sidAgent, sidB, shop, shopB, app, appB, secretToken: 'ptk-SUPER-SECRET-9876' };
  },
  cases: [
    { id: 'SE01', desc: 'rate-limit 1/5: các lần sai liên tiếp đều 401 (đếm fail)', async fn(ctx) {
      let last = null;
      for (let i = 0; i < 4; i++) last = await ctx.inst.client('POST', '/api/auth/login', { body: { email: 'sec@matrix.vn', password: 'sai-' + i } });
      assert.strictEqual(last.status, 401);
    } },
    { id: 'SE02', desc: 'rate-limit 2/5: lần thứ 5 sai -> 401 (ngưỡng chưa vượt)', async fn(ctx) {
      // server riêng để không phá cửa sổ limit của server chính
      const ri = await startInst('sec-rl2');
      try {
        await ri.client('POST', '/api/auth/setup', { body: { email: 'rl@x.vn', password: 'password123', shop_name: 'RL' } });
        let r = null;
        for (let i = 0; i < 5; i++) r = await ri.client('POST', '/api/auth/login', { body: { email: 'rl@x.vn', password: 'wrong' + i } });
        assert.strictEqual(r.status, 401);
      } finally { await ri.close(); }
    } },
    { id: 'SE03', desc: 'rate-limit 3/5: lần 6 -> 429 RATE_LIMITED', async fn(ctx) {
      const ri = await startInst('sec-rl3');
      try {
        await ri.client('POST', '/api/auth/setup', { body: { email: 'rl@x.vn', password: 'password123', shop_name: 'RL' } });
        let r = null;
        for (let i = 0; i < 6; i++) r = await ri.client('POST', '/api/auth/login', { body: { email: 'rl@x.vn', password: 'wrong' + i } });
        assert.strictEqual(r.status, 429);
        assert.strictEqual(r.json.error, 'RATE_LIMITED');
      } finally { await ri.close(); }
    } },
    { id: 'SE04', desc: 'rate-limit 4/5: đang bị khoá thì MẬT KHẨU ĐÚNG cũng 429 (fail-closed)', async fn(ctx) {
      const ri = await startInst('sec-rl4');
      try {
        await ri.client('POST', '/api/auth/setup', { body: { email: 'rl@x.vn', password: 'password123', shop_name: 'RL' } });
        for (let i = 0; i < 5; i++) await ri.client('POST', '/api/auth/login', { body: { email: 'rl@x.vn', password: 'wrong' + i } });
        const ok = await ri.client('POST', '/api/auth/login', { body: { email: 'rl@x.vn', password: 'password123' } });
        assert.strictEqual(ok.status, 429);
      } finally { await ri.close(); }
    } },
    { id: 'SE05', desc: 'rate-limit 5/5: fail-closed khi limiter ném lỗi (ip lỗi -> từ chối)', async fn(ctx) {
      const ri = await startInst('sec-rl5');
      try {
        const before = ri.auth._rateBlocked;
        ri.auth._rateBlocked = () => { throw new Error('limiter down'); };
        const r = await ri.client('POST', '/api/auth/login', { body: { email: 'rl@x.vn', password: 'password123' } });
        ri.auth._rateBlocked = before;
        assert.strictEqual(r.status, 429, 'limiter lỗi -> TỪ CHỐNG (fail-closed)');
      } finally { await ri.close(); }
    } },
    { id: 'SE06', desc: 'session hết hạn -> me 401 (expiry check thật)', async fn(ctx) {
      const token = (await ctx.inst.client('POST', '/api/auth/login', { body: { email: 'sec@matrix.vn', password: 'password123' } })).headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
      assert.strictEqual((await ctx.inst.client('GET', '/api/auth/me', { cookie: token })).status, 200);
      ctx.inst.auth.sessions[token].expires_at = new Date(Date.now() - 1000).toISOString();
      assert.strictEqual((await ctx.inst.client('GET', '/api/auth/me', { cookie: token })).status, 401, 'hết hạn -> 401');
    } },
    { id: 'SE07', desc: 'AGENT 403: settings/bot + ai/config + ai/test', async fn(ctx) {
      assert.strictEqual((await ctx.inst.client('POST', '/api/settings/bot', { cookie: ctx.sidAgent, body: { on: false } })).status, 403);
      assert.strictEqual((await ctx.inst.client('POST', '/api/ai/config', { cookie: ctx.sidAgent, body: { provider: 'local' } })).status, 403);
      assert.strictEqual((await ctx.inst.client('POST', '/api/ai/test', { cookie: ctx.sidAgent, body: {} })).status, 403);
    } },
    { id: 'SE08', desc: 'AGENT 403: shops + auth/users + automation', async fn(ctx) {
      assert.strictEqual((await ctx.inst.client('GET', '/api/shops', { cookie: ctx.sidAgent })).status, 403);
      assert.strictEqual((await ctx.inst.client('GET', '/api/auth/users', { cookie: ctx.sidAgent })).status, 403);
      assert.strictEqual((await ctx.inst.client('POST', '/api/automation', { cookie: ctx.sidAgent, body: { care_enabled: false } })).status, 403);
    } },
    { id: 'SE09', desc: 'AGENT 403: products GHI + onboarding + prompt config', async fn(ctx) {
      assert.strictEqual((await ctx.inst.client('POST', '/api/products', { cookie: ctx.sidAgent, body: { name: 'X', sku_base: 'SEC-X', price: 1 } })).status, 403);
      assert.strictEqual((await ctx.inst.client('GET', '/api/onboarding', { cookie: ctx.sidAgent })).status, 403);
      assert.strictEqual((await ctx.inst.client('POST', '/api/prompt/config', { cookie: ctx.sidAgent, body: { giongNoi: 'x' } })).status, 403);
    } },
    { id: 'SE10', desc: 'isolation: shop A KHÔNG thấy conversations shop B', async fn(ctx) {
      const a = await ctx.inst.client('GET', '/api/conversations', { cookie: ctx.sid });
      assert.ok(!a.json.conversations.some(c => c.id.includes('sec-b-khach')), 'conv của B không lộ sang A');
      const b = await ctx.inst.client('GET', '/api/conversations', { cookie: ctx.sidB });
      assert.ok(b.json.conversations.some(c => c.id.includes('sec-b-khach')), 'B thấy conv của B');
    } },
    { id: 'SE11', desc: 'isolation: order của B -> A đọc 404', async fn(ctx) {
      const orderB = ctx.appB.store.findAll('orders', () => true)[0];
      assert.ok(orderB, 'B có đơn');
      assert.strictEqual((await ctx.inst.client('GET', '/api/orders/' + orderB.order_id, { cookie: ctx.sid })).status, 404);
      assert.strictEqual((await ctx.inst.client('GET', '/api/orders/' + orderB.order_id, { cookie: ctx.sidB })).status, 200);
    } },
    { id: 'SE12', desc: 'isolation: ghi chéo (confirm order của B bằng session A) -> 404', async fn(ctx) {
      const orderB = ctx.appB.store.findAll('orders', () => true)[0];
      assert.ok(orderB, 'B có đơn (đọc an toàn — fixture setup phải tạo đơn cho B)');
      const r = await ctx.inst.client('POST', '/api/orders/' + orderB.order_id + '/retry-shipping', { cookie: ctx.sid, body: {} });
      assert.strictEqual(r.status, 404);
    } },
    { id: 'SE13', desc: 'CSRF/cookie: SameSite=Lax + HttpOnly trên session cookie', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/auth/login', { body: { email: 'sec@matrix.vn', password: 'password123' } });
      const c = r.headers['set-cookie'][0];
      assert.match(c, /HttpOnly/i);
      assert.match(c, /SameSite=Lax/i);
      assert.match(c, /Path=\//);
    } },
    { id: 'SE14', desc: 'secret không nằm trong /api/settings + /api/ai/status + onboarding', async fn(ctx) {
      for (const p of ['/api/settings', '/api/ai/status', '/api/onboarding', '/api/automation']) {
        const r = await ctx.inst.client('GET', p, { cookie: ctx.sid });
        assert.ok(!r.text.includes(ctx.secretToken), p + ' rò token!');
      }
      const st = await ctx.inst.client('GET', '/api/settings', { cookie: ctx.sid });
      assert.doesNotMatch(st.text, /ptk-SUPER-SECRET/);
    } },
    { id: 'SE15', desc: 'secret không nằm trong UI: / (app), style, login page', async fn(ctx) {
      const idx = await ctx.inst.client('GET', '/');
      assert.ok(!idx.text.includes(ctx.secretToken));
      const css = await ctx.inst.client('GET', '/style.css');
      assert.ok(!css.text.includes(ctx.secretToken));
    } },
    { id: 'SE16', desc: 'secret không nằm trong audit (store + audit.jsonl)', async fn(ctx) {
      await ctx.inst.client('PUT', '/api/products/NT-VANILLA', { cookie: ctx.sid, body: { enabled: true } });
      const audits = JSON.stringify(ctx.app.store.findAll('audit_events', () => true));
      assert.ok(!audits.includes(ctx.secretToken), 'audit store rò token');
      const file = require('fs').readFileSync(require('path').join(ctx.inst.root, 'shops', ctx.shop, 'audit.jsonl'), 'utf8');
      assert.ok(!file.includes(ctx.secretToken), 'audit.jsonl rò token');
    } },
    { id: 'SE17', desc: 'webhook meta chữ ký SAI -> 401 (server path, live injected)', async fn(ctx) {
      const raw = JSON.stringify({ object: 'page', entry: [] });
      ctx.app.live = Object.assign({}, ctx.app.live, { meta: new MetaAdapter({ config: { appSecret: 'sec-real', pageAccessToken: 't', verifyToken: 'v' } }) });
      const r = await ctx.inst.client('POST', '/webhooks/meta', { raw, headers: { 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', 'khac').update(raw).digest('hex') } });
      assert.strictEqual(r.status, 401);
    } },
    { id: 'SE18', desc: 'webhook GHN token SAI -> 401 (timing-safe)', async fn(ctx) {
      process.env.GHN_WEBHOOK_TOKEN = 'ghn-webhook-secret';
      ctx.app.live = Object.assign({}, ctx.app.live, { carrier: new GhnAdapter({ config: { token: 't', shopId: '1', baseUrl: 'http://localhost:1' }, httpFn: async () => ({ ok: true, status: 200, bodyText: '{}' }) }) });
      try {
        const wrong = await ctx.inst.client('POST', '/webhooks/ghn?token=SAI', { body: {} });
        assert.strictEqual(wrong.status, 401);
        const right = await ctx.inst.client('POST', '/webhooks/ghn?token=ghn-webhook-secret', { body: {} });
        assert.notStrictEqual(right.status, 401, 'token đúng đi qua (200/400 tuỳ body)');
      } finally { delete process.env.GHN_WEBHOOK_TOKEN; }
    } },
    { id: 'SE19', desc: 'PII không vào model context: modelCtx redact SĐT/địa chỉ/tên', async fn(ctx) {
      const { redactPii } = require('../../src/util');
      const text = 'tên Lan sdt 0903333444 địa chỉ 45 Lê Lợi Q1';
      const red = redactPii(text);
      assert.ok(!/\d{9,}/.test(red), 'SĐT bị che: ' + red);
      const ctxOut = ctx.app.pipeline.modelCtx(ctx.app.store.findOne('conversations', c => c.conversation_id.includes('sec-b')) || { state: 'NEW_LEAD', mode: 'AI' }, text);
      assert.ok(!/\d{9,}/.test(ctxOut.text), 'model ctx không chứa SĐT');
      assert.ok(!ctxOut.text.includes('Lê Lợi'), 'model ctx không chứa địa chỉ');
    } },
    { id: 'SE20', desc: 'prompt chứa secret -> CHẶN LƯU 400 SECRET_IN_PROMPT; prompt sạch lưu OK', async fn(ctx) {
      const bad = await ctx.inst.client('POST', '/api/prompt/config', { cookie: ctx.sid, body: { giongNoi: 'vui vẻ, api_key=sk-abc123def' } });
      assert.strictEqual(bad.status, 400);
      assert.strictEqual(bad.json.error, 'SECRET_IN_PROMPT');
      const badToken = await ctx.inst.client('POST', '/api/prompt/config', { cookie: ctx.sid, body: { khongDuocNoi: ['never say token xyz'] } });
      assert.strictEqual(badToken.status, 400);
      const ok = await ctx.inst.client('POST', '/api/prompt/config', { cookie: ctx.sid, body: { giongNoi: 'thân thiện' } });
      assert.strictEqual(ok.status, 200);
    } },
  ],
};
