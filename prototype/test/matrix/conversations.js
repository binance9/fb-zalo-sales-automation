'use strict';
// test/matrix/conversations.js — AREA CONVERSATIONS (18 case): list/detail/messages/composer
// slots/delivery/window/quota hiển thị + agent send.
const assert = require('assert');
const { startInst, setupShop, fire } = require('./_harness');

module.exports = {
  area: 'Conversations',
  async setup() {
    const inst = await startInst('conversations');
    const { sid, shop, app } = await setupShop(inst, { email: 'cv@matrix.vn' });
    // seed vài conversation thật
    fire(app, 'facebook', 'cv-mai', 'nến vanilla size M giá bao nhiêu vậy shop', 'cv-1');
    fire(app, 'facebook', 'cv-hung', 'lấy 1 hộp trà hoa sấy, tên Hùng, sdt 0903333444, địa chỉ 45 Lê Lợi Q1', 'cv-2');
    fire(app, 'zalo', 'cv-minh', 'tra hoa say con khong shop', 'cv-3');
    return { inst, sid, shop, app };
  },
  cases: [
    { id: 'CV01', desc: 'GET /api/conversations trả list có 3 conv seed', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/api/conversations', { cookie: ctx.sid });
      assert.strictEqual(r.status, 200);
      const ids = r.json.conversations.map(c => c.id);
      for (const id of ['facebook:cv-mai', 'facebook:cv-hung', 'zalo:cv-minh']) assert.ok(ids.includes(id), 'thiếu ' + id);
    } },
    { id: 'CV02', desc: 'mỗi conv có lastMessage + lastTime + badge', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/api/conversations', { cookie: ctx.sid });
      for (const c of r.json.conversations) {
        assert.ok(c.lastMessage !== undefined);
        assert.ok(c.badge, 'badge ' + c.id);
      }
    } },
    { id: 'CV03', desc: 'badge ORDERED cho conv đã chốt đơn', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/api/conversations', { cookie: ctx.sid });
      const hung = r.json.conversations.find(c => c.id === 'facebook:cv-hung');
      assert.strictEqual(hung.badge, 'ORDERED', 'đang draft đủ slot -> ORDERED badge: ' + hung.badge);
    } },
    { id: 'CV04', desc: 'detail: messages đúng thứ tự in/out + sender chuẩn', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/api/conversations/' + encodeURIComponent('facebook:cv-mai'), { cookie: ctx.sid });
      assert.strictEqual(r.status, 200);
      const msgs = r.json.messages;
      assert.ok(msgs.length >= 2);
      assert.strictEqual(msgs[0].direction, 'in');
      assert.ok(msgs.slice(1).some(m => m.direction === 'out'));
      assert.ok(msgs.every(m => ['customer', 'bot', 'agent', 'system'].includes(m.sender)));
    } },
    { id: 'CV05', desc: 'detail: draft.missing chính xác (items→name/phone/address)', async fn(ctx) {
      fire(ctx.app, 'facebook', 'cv-miss', 'lấy 1 nến vanilla', 'cv-4');
      // [chốt local] poll-wait — chống flake timing khi máy load
      let last = null;
      for (let i = 0; i < 100; i++) {
        const res = await ctx.inst.client('GET', '/api/conversations/' + encodeURIComponent('facebook:cv-miss'), { cookie: ctx.sid });
        last = res;
        if (res.json && res.json.draft && Array.isArray(res.json.draft.missing) && res.json.draft.missing.length) break;
        await new Promise(rr => setTimeout(rr, 50));
      }
      const fin = last || await ctx.inst.client('GET', '/api/conversations/' + encodeURIComponent('facebook:cv-miss'), { cookie: ctx.sid });
      assert.ok(fin.json.draft.missing.includes('name'));
      assert.ok(fin.json.draft.missing.includes('phone'));
      assert.ok(fin.json.draft.missing.includes('address'));
    } },
    { id: 'CV06', desc: 'detail: slots fill dần (phone) qua tin rải', async fn(ctx) {
      fire(ctx.app, 'facebook', 'cv-miss', 'sdt 0908888111', 'cv-5');
      const r = await ctx.inst.client('GET', '/api/conversations/' + encodeURIComponent('facebook:cv-miss'), { cookie: ctx.sid });
      assert.ok(!r.json.draft.missing.includes('phone'));
      assert.strictEqual(r.json.customer.phone, '0908888111');
    } },
    { id: 'CV07', desc: 'conv không tồn tại -> 404 CONVERSATION_NOT_FOUND', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/api/conversations/facebook:khong-co', { cookie: ctx.sid });
      assert.strictEqual(r.status, 404);
    } },
    { id: 'CV08', desc: 'agent send tin hợp lệ -> 200 sent + tin sender=agent trong inbox', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/conversations/' + encodeURIComponent('facebook:cv-mai') + '/send', { cookie: ctx.sid, body: { text: 'Dạ em báo giá ngay ạ' } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.sent, true);
      const msgs = ctx.app.store.findAll('messages', m => m.conversation_id === 'facebook:cv-mai' && m.sender === 'human_agent');
      assert.ok(msgs.length >= 1);
    } },
    { id: 'CV09', desc: 'agent send text rỗng -> 400 EMPTY_TEXT', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/conversations/' + encodeURIComponent('facebook:cv-mai') + '/send', { cookie: ctx.sid, body: { text: '   ' } });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.json.error, 'EMPTY_TEXT');
    } },
    { id: 'CV10', desc: 'takeover -> mode HUMAN + human_agent set', async fn(ctx) {
      // [TEST-FIX] conv seed là ZALO ('zalo:cv-minh' — xem setup) — trước đây URL dùng nhầm prefix
      // 'facebook:cv-minh' -> conv không tồn tại -> API trả body 404 nhưng status 200 -> assert
      // mode 'HUMAN' fail. Đúng conv: 'zalo:cv-minh' (khớp CV12/CV14 cùng hội thoại).
      const r = await ctx.inst.client('POST', '/api/conversations/' + encodeURIComponent('zalo:cv-minh') + '/takeover', { cookie: ctx.sid, body: {} });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.mode, 'HUMAN', 'takeover trả mode HUMAN (conv phải tồn tại)');
      const conv = ctx.app.store.findOne('conversations', c => c.conversation_id === 'zalo:cv-minh');
      assert.strictEqual(conv.mode, 'HUMAN');
      assert.ok(conv.human_agent);
    } },
    { id: 'CV11', desc: 'khách nhắn trong HUMAN -> AI KHÔNG gửi (draft note HOLD_FOR_AGENT)', async fn(ctx) {
      fire(ctx.app, 'zalo', 'cv-minh', 'giá vẫn chưa rõ à shop', 'cv-6');
      const prp = ctx.app.store.findAll('ai_proposals', p => p.conversation_id === 'zalo:cv-minh' && p.decision === 'HOLD_FOR_AGENT');
      assert.ok(prp.length >= 1, 'bot soạn nháp thay vì tự gửi');
    } },
    { id: 'CV12', desc: 'handback -> mode AI + state giữ nguyên', async fn(ctx) {
      const before = ctx.app.store.findOne('conversations', c => c.conversation_id === 'zalo:cv-minh').state;
      const r = await ctx.inst.client('POST', '/api/conversations/' + encodeURIComponent('zalo:cv-minh') + '/handback', { cookie: ctx.sid, body: {} });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.mode, 'AI');
      assert.strictEqual(r.json.state, before);
    } },
    { id: 'CV13', desc: 'window state hiển thị trong detail (last_user_event_ts + open)', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/api/conversations/' + encodeURIComponent('facebook:cv-mai'), { cookie: ctx.sid });
      assert.ok(r.json.window);
      assert.ok(r.json.window.last_user_event_ts);
      assert.strictEqual(r.json.window.open, true);
    } },
    { id: 'CV14', desc: 'quota hiển thị cho conv zalo (channel_budget mirror)', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/api/conversations/' + encodeURIComponent('zalo:cv-minh'), { cookie: ctx.sid });
      assert.ok(r.json.quota, 'quota block: ' + JSON.stringify(r.json.quota));
      assert.ok(r.json.quota.cs_remain < r.json.quota.cs_total);
    } },
    { id: 'CV15', desc: 'subject_sku/subject_name nhận diện SP đang nói', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/api/conversations/' + encodeURIComponent('facebook:cv-mai'), { cookie: ctx.sid });
      assert.ok(String(r.json.subject_sku || '').startsWith('NT-VANILLA'));
      assert.match(r.json.subject_name, /Nến thơm vanilla/);
    } },
    { id: 'CV16', desc: 'close-claim khi KHÔNG claim -> 409 NO_OPEN_CLAIM', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/conversations/' + encodeURIComponent('facebook:cv-mai') + '/close-claim', { cookie: ctx.sid, body: {} });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json.error, 'NO_OPEN_CLAIM');
    } },
    { id: 'CV17', desc: 'claim luồng khiếu nại -> close-claim restore đúng origin', async fn(ctx) {
      fire(ctx.app, 'facebook', 'cv-comp', 'shop lừa đảo quá, đơn lỗi rồi nhé', 'cv-7');
      const conv = ctx.app.store.findOne('conversations', c => c.platform_thread_id === 'cv-comp');
      assert.ok(conv.claim);
      const origin = conv.claim.origin_state;
      const r = await ctx.inst.client('POST', '/api/conversations/' + encodeURIComponent(conv.conversation_id) + '/close-claim', { cookie: ctx.sid, body: {} });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.restored_state, origin);
      assert.strictEqual(ctx.app.store.findOne('conversations', c => c.conversation_id === conv.conversation_id).claim, null);
    } },
    { id: 'CV18', desc: 'AGENT (role) đọc list + detail + send 200; không cần OWNER', async fn(ctx) {
      await ctx.inst.client('POST', '/api/auth/users', { cookie: ctx.sid, body: { email: 'cv-agent@matrix.vn', password: 'password789', role: 'AGENT' } });
      const ag = (await ctx.inst.client('POST', '/api/auth/login', { body: { email: 'cv-agent@matrix.vn', password: 'password789' } })).headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
      assert.strictEqual((await ctx.inst.client('GET', '/api/conversations', { cookie: ag })).status, 200);
      assert.strictEqual((await ctx.inst.client('GET', '/api/conversations/' + encodeURIComponent('facebook:cv-mai'), { cookie: ag })).status, 200);
      const send = await ctx.inst.client('POST', '/api/conversations/' + encodeURIComponent('facebook:cv-mai') + '/send', { cookie: ag, body: { text: 'Dạ em hỗ trợ mình ạ' } });
      assert.strictEqual(send.status, 200);
      assert.strictEqual(send.json.sent, true);
    } },
  ],
};
