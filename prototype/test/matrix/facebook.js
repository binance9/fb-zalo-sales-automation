'use strict';
// test/matrix/facebook.js — AREA FACEBOOK (18 case): webhook verify/signature + comment +
// messaging + normalize comment/message + provider status (adapter BIÊN injected offline).
const assert = require('assert');
const crypto = require('crypto');
const { startInst, setupShop, fire } = require('./_harness');
const { MetaAdapter } = require('../../src/channel/meta-adapter');

const SECRET = 'mx-meta-secret';
function signed(entry) {
  const raw = JSON.stringify(entry);
  return { raw, sig: 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex') };
}
function commentEntry(commentId, userId, text) {
  return { object: 'page', entry: [{ id: 'page-mx', time: Date.now(), changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: commentId, from: { id: userId }, message: text, post_id: 'post-mx' } }] }] };
}
function msgEntry(mid, userId, text, attachments) {
  const message = { mid, text };
  if (attachments) message.attachments = attachments;
  return { object: 'page', entry: [{ id: 'page-mx', time: Date.now(), messaging: [{ sender: { id: userId }, recipient: { id: 'page-mx' }, timestamp: Date.now(), message }] }] };
}

module.exports = {
  area: 'Facebook',
  async setup() {
    const inst = await startInst('facebook');
    const { sid, shop, app } = await setupShop(inst, { email: 'fb@matrix.vn' });
    // cắm live meta adapter (biên) — mọi webhook đi qua HMAC thật
    app.live = Object.assign({}, app.live, { meta: new MetaAdapter({ config: { appSecret: SECRET, pageAccessToken: 'ptk-mx', verifyToken: 'vt-mx' } }) });
    return { inst, sid, shop, app };
  },
  cases: [
    { id: 'FB01', desc: 'GET verify challenge sai token -> 403', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/webhooks/meta?hub.mode=subscribe&hub.verify_token=SAI&hub.challenge=ch42');
      assert.strictEqual(r.status, 403);
    } },
    { id: 'FB02', desc: 'GET verify đúng token -> echo challenge 200', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/webhooks/meta?hub.mode=subscribe&hub.verify_token=vt-mx&hub.challenge=ch42');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.text, 'ch42');
    } },
    { id: 'FB03', desc: 'POST webhook KHÔNG chữ ký -> 401', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/webhooks/meta', { raw: JSON.stringify(commentEntry('fb-c0', 'u0', 'hi')) });
      assert.strictEqual(r.status, 401);
    } },
    { id: 'FB04', desc: 'POST webhook chữ ký SAI -> 401', async fn(ctx) {
      const { raw } = signed(commentEntry('fb-c0b', 'u0', 'hi'));
      const r = await ctx.inst.client('POST', '/webhooks/meta', { raw, headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) } });
      assert.strictEqual(r.status, 401);
    } },
    { id: 'FB05', desc: 'POST bad json (sig đúng) -> 400', async fn(ctx) {
      const raw = '{khong phai json';
      const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex');
      const r = await ctx.inst.client('POST', '/webhooks/meta', { raw, headers: { 'x-hub-signature-256': sig } });
      assert.strictEqual(r.status, 400);
    } },
    { id: 'FB06', desc: 'POST comment hợp lệ -> 200 EVENTS_RECEIVED', async fn(ctx) {
      const { raw, sig } = signed(commentEntry('fb-c1', 'fbu1', 'nến vanilla còn không shop'));
      const r = await ctx.inst.client('POST', '/webhooks/meta', { raw, headers: { 'x-hub-signature-256': sig } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.text, 'EVENTS_RECEIVED');
      ctx.inst.getApp(ctx.shop).drain();
    } },
    { id: 'FB07', desc: 'comment tạo conversation + bot trả lời (private reply)', async fn(ctx) {
      const app = ctx.inst.getApp(ctx.shop);
      const conv = app.store.findOne('conversations', c => c.conversation_id === 'facebook:fbuser:fbu1');
      assert.ok(conv, 'thread comment nằm trong inbox');
      const outs = app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'out');
      assert.ok(outs.length >= 1 && outs.every(m => m.delivery_status));
    } },
    { id: 'FB08', desc: 'comment_id TRÙNG -> dedupe (không sinh tin/match lần 2)', async fn(ctx) {
      const app = ctx.inst.getApp(ctx.shop);
      const before = app.store.findAll('inbox_events', e => e.event_id === 'facebook:comment:fb-c1').length;
      const { raw, sig } = signed(commentEntry('fb-c1', 'fbu1', 'nến vanilla còn không shop'));
      await ctx.inst.client('POST', '/webhooks/meta', { raw, headers: { 'x-hub-signature-256': sig } });
      ctx.inst.getApp(ctx.shop).drain();
      const after = app.store.findAll('inbox_events', e => e.event_id === 'facebook:comment:fb-c1').length;
      assert.strictEqual(before, 1);
      assert.strictEqual(after, 1, 'event trùng bị chặn ở cửa vào (INV-1)');
    } },
    { id: 'FB09', desc: 'messaging event -> bot reply qua PSID thread', async fn(ctx) {
      const { raw, sig } = signed(msgEntry('mid-fb-1', 'fbu1', 'cho minh 1 hop tra hoa say'));
      const r = await ctx.inst.client('POST', '/webhooks/meta', { raw, headers: { 'x-hub-signature-256': sig } });
      assert.strictEqual(r.status, 200);
      ctx.inst.getApp(ctx.shop).drain();
      const conv = ctx.inst.getApp(ctx.shop).store.findOne('conversations', c => c.conversation_id === 'facebook:fbu1');
      assert.ok(conv, 'PSID thread tạo riêng');
      const outs = ctx.inst.getApp(ctx.shop).store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'out');
      assert.ok(outs.length >= 1);
    } },
    { id: 'FB10', desc: 'delivery webhook (receipt) -> outbound_pending DELIVERED', async fn(ctx) {
      const app = ctx.inst.getApp(ctx.shop);
      // [TEST-FIX] Trước đây assert "có tin chờ receipt" fail vì lúc case chạy KHÔNG CÒN row
      // PENDING: drain của các case trước đã nhảy đồng hồ qua +5s -> mock platform bắn receipt
      // -> mọi tin đã DELIVERED (đúng cơ chế BL-5). Tạo tin chờ receipt THẬT: bắn tin khách qua
      // webhook + CHỈ processQueue (chưa drain — receipt +5s chưa về) -> bot trả lời ->
      // outbound_pending PENDING mang mid từ response send API. Sau đó delivery webhook của
      // platform (mid khớp) mới được quyền nâng DELIVERED — đúng cơ chế, không fake.
      const { raw, sig } = signed(msgEntry('mid-dlv-0', 'fbu1', 'cho minh xin gia tra hoa say'));
      await ctx.inst.client('POST', '/webhooks/meta', { raw, headers: { 'x-hub-signature-256': sig } });
      app.gateway.processQueue();
      const op = app.store.findAll('outbound_pending', o =>
        o.conversation_id === 'facebook:fbu1' && o.receipt_status === 'PENDING');
      assert.ok(op.length >= 1, 'có tin chờ receipt');
      const mid = op[op.length - 1].platform_message_id || null; // [TEST-FIX] trường là platform_message_id (không phải .mid)
      const body = { object: 'page', entry: [{ id: 'page-mx', time: Date.now(), messaging: [{ sender: { id: 'fbu1' }, recipient: { id: 'page-mx' }, timestamp: Date.now(), delivery: { mids: mid ? [mid] : [], watermark: Date.now() } }] }] };
      const { raw: rawD, sig: sigD } = signed(body);
      const r = await ctx.inst.client('POST', '/webhooks/meta', { raw: rawD, headers: { 'x-hub-signature-256': sigD } });
      assert.strictEqual(r.status, 200);
      ctx.inst.getApp(ctx.shop).drain();
      assert.ok(app.store.findAll('outbound_pending', o => o.receipt_status === 'DELIVERED').length >= 1, 'receipt chuyển DELIVERED');
      assert.ok(op.every(o => app.store.findOne('outbound_pending', x => x.op_id === o.op_id).receipt_status === 'DELIVERED'), 'tin chờ receipt -> DELIVERED');
    } },
    { id: 'FB11', desc: 'normalize image attachment -> kind image (adapter unit)', async fn(ctx) {
      const meta = ctx.app.live.meta;
      const norm = meta.normalizeWebhook(msgEntry('mid-img', 'fbu9', '', [{ type: 'image', payload: { url: 'https://img.example/nen-vanilla-m-do.jpg' } }]));
      assert.strictEqual(norm.events.length, 1);
      assert.strictEqual(norm.events[0].payload.kind, 'image');
      assert.strictEqual(norm.events[0].payload.media.platform_url, 'https://img.example/nen-vanilla-m-do.jpg');
    } },
    { id: 'FB12', desc: 'normalize audio -> kind voice', async fn(ctx) {
      const norm = ctx.app.live.meta.normalizeWebhook(msgEntry('mid-aud', 'fbu9', '', [{ type: 'audio', payload: { url: 'https://img.example/voice-tra.amr' } }]));
      assert.strictEqual(norm.events[0].payload.kind, 'voice');
    } },
    { id: 'FB13', desc: 'normalize sticker -> text (nội dung bỏ qua)', async fn(ctx) {
      const norm = ctx.app.live.meta.normalizeWebhook(msgEntry('mid-stk', 'fbu9', '', [{ type: 'sticker', sticker_id: 369239263222822 }]));
      assert.strictEqual(norm.events[0].payload.kind, 'text');
    } },
    { id: 'FB14', desc: 'normalize comment -> origin comment + platformEventId comment:<id>', async fn(ctx) {
      const norm = ctx.app.live.meta.normalizeWebhook(commentEntry('fb-cx', 'fbu8', 'giá nào shop'));
      assert.strictEqual(norm.events[0].platformEventId, 'comment:fb-cx');
      assert.strictEqual(norm.events[0].payload.origin, 'comment');
      assert.strictEqual(norm.events[0].payload.customer_ref, 'fbuser:fbu8');
    } },
    { id: 'FB15', desc: 'messaging thiếu sender -> ignored (không crash)', async fn(ctx) {
      const norm = ctx.app.live.meta.normalizeWebhook({ object: 'page', entry: [{ id: 'page-mx', messaging: [{ recipient: { id: 'x' }, message: { mid: 'm', text: 'x' } }] }] });
      assert.strictEqual(norm.events.length, 0);
      assert.ok(norm.ignored >= 1);
    } },
    { id: 'FB16', desc: 'providerStatus KHÔNG chứa token/secret', async fn(ctx) {
      const s = JSON.stringify(ctx.app.live.meta.providerStatus());
      for (const secret of [SECRET, 'ptk-mx', 'vt-mx']) assert.ok(!s.includes(secret), 'rò ' + secret);
    } },
    { id: 'FB17', desc: 'last_webhook_at được cập nhật sau webhook', async fn(ctx) {
      const { raw, sig } = signed(commentEntry('fb-c2', 'fbu1', 'shop ơi'));
      await ctx.inst.client('POST', '/webhooks/meta', { raw, headers: { 'x-hub-signature-256': sig } });
      ctx.inst.getApp(ctx.shop).drain();
      assert.ok(ctx.app.live.meta.state.last_webhook_at, 'last_webhook_at set');
    } },
    { id: 'FB18', desc: 'health component facebook ok + không có secret trong /api/health', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/api/health', { cookie: ctx.sid });
      assert.strictEqual(r.status, 200);
      assert.ok(r.json.components.facebook);
      const raw = r.text;
      for (const secret of [SECRET, 'ptk-mx', 'vt-mx', 'ptk-e2e']) assert.ok(!raw.includes(secret), 'rò secret trong health');
    } },
  ],
};
