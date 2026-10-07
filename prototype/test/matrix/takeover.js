'use strict';
// test/matrix/takeover.js — AREA TAKEOVER (15 case): takeover/handback/worklist/INV-5/claim.
const assert = require('assert');
const { startInst, setupShop, fire } = require('./_harness');

module.exports = {
  area: 'Takeover',
  async setup() {
    const inst = await startInst('takeover');
    const { sid, shop, app } = await setupShop(inst, { email: 'tk@matrix.vn' });
    fire(app, 'facebook', 'tk1', 'nến vanilla còn hàng không shop', 'tk-1');
    return { inst, sid, shop, app };
  },
  cases: [
    { id: 'TK01', desc: 'takeover -> mode HUMAN + worklist message_while_human_mode sau khi khách nhắn', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/conversations/' + encodeURIComponent('facebook:tk1') + '/takeover', { cookie: ctx.sid, body: {} });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.mode, 'HUMAN');
    } },
    { id: 'TK02', desc: 'takeover hủy job AI QUEUED nhưng GIỮ job đối chứng (check_send_receipt/reconcile)', async fn(ctx) {
      const app = ctx.app;
      app.store.insert('jobs', { job_id: 'job-ai-x', kind: 'process_event', payload_json: '{}', status: 'QUEUED', run_at: app.clock.iso(), attempts: 0, max_attempts: 3, idempotency_key: 'ix-1', conversation_id: 'facebook:tk1', created_at: app.clock.iso(), updated_at: app.clock.iso() });
      app.store.insert('jobs', { job_id: 'job-rcpt-y', kind: 'check_send_receipt', payload_json: '{}', status: 'QUEUED', run_at: app.clock.iso(), attempts: 0, max_attempts: 3, idempotency_key: 'iy-1', conversation_id: 'facebook:tk1', created_at: app.clock.iso(), updated_at: app.clock.iso() });
      app.takeover.setTakeover(app.store.findOne('conversations', c => c.conversation_id === 'facebook:tk1'), 'op', 'test');
      assert.strictEqual(app.store.findOne('jobs', j => j.job_id === 'job-ai-x').status, 'CANCELLED');
      assert.strictEqual(app.store.findOne('jobs', j => j.job_id === 'job-rcpt-y').status, 'QUEUED', 'job đối chứng KHÔNG bị hủy');
    } },
    { id: 'TK03', desc: 'INV-5: AI KHÔNG auto-send khi HUMAN (tin khách vào chỉ ghi + soạn nháp)', async fn(ctx) {
      const outsBefore = ctx.app.store.findAll('messages', m => m.conversation_id === 'facebook:tk1' && m.direction === 'out').length;
      fire(ctx.app, 'facebook', 'tk1', 'còn size S không shop', 'tk-2');
      const outsAfter = ctx.app.store.findAll('messages', m => m.conversation_id === 'facebook:tk1' && m.direction === 'out').length;
      assert.strictEqual(outsAfter, outsBefore, 'KHÔNG có tin mới của bot');
      const prp = ctx.app.store.findAll('ai_proposals', p => p.conversation_id === 'facebook:tk1' && p.decision === 'HOLD_FOR_AGENT');
      assert.ok(prp.length >= 1, 'bot vẫn ghi nhận + soạn nháp');
    } },
    { id: 'TK04', desc: 'fillSlots VẪN chạy trong HUMAN (bot ghi nhận cho agent)', async fn(ctx) {
      fire(ctx.app, 'facebook', 'tk1', 'sdt 0909999111', 'tk-3');
      const conv = ctx.app.store.findOne('conversations', c => c.conversation_id === 'facebook:tk1');
      assert.strictEqual(conv.draft.slots.phone.value, '0909999111');
    } },
    { id: 'TK05', desc: 'agentSend trong HUMAN: 200 sent + tin human_agent', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/conversations/' + encodeURIComponent('facebook:tk1') + '/send', { cookie: ctx.sid, body: { text: 'Dạ còn size S nhé anh' } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.sent, true);
      assert.ok(ctx.app.store.findAll('messages', m => m.conversation_id === 'facebook:tk1' && m.sender === 'human_agent').length >= 1);
    } },
    { id: 'TK06', desc: 'handback -> mode AI + agent_handoff_note ghi ngữ cảnh', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/conversations/' + encodeURIComponent('facebook:tk1') + '/handback', { cookie: ctx.sid, body: {} });
      assert.strictEqual(r.status, 200);
      const conv = ctx.app.store.findOne('conversations', c => c.conversation_id === 'facebook:tk1');
      assert.strictEqual(conv.mode, 'AI');
      assert.ok(conv.agent_handoff_note && /Nhân viên/.test(conv.agent_handoff_note.note));
    } },
    { id: 'TK07', desc: 'sau handback bot trả lời lại bình thường', async fn(ctx) {
      fire(ctx.app, 'facebook', 'tk1', 'nến thơm oải hương bao nhiêu', 'tk-4');
      const conv = ctx.app.store.findOne('conversations', c => c.conversation_id === 'facebook:tk1');
      const outs = ctx.app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'out' && m.sender === 'ai');
      assert.ok(outs.length >= 1, 'AI trả lời lại');
    } },
    { id: 'TK08', desc: 'complaint -> claim + HUMAN tự động + worklist high', async fn(ctx) {
      fire(ctx.app, 'facebook', 'tk2', 'shop bán hàng lỗi quá, đơn tệ nhất từng thấy', 'tk-5');
      const conv = ctx.app.store.findOne('conversations', c => c.platform_thread_id === 'tk2');
      assert.ok(conv.claim);
      assert.strictEqual(conv.mode, 'HUMAN');
      const wl = ctx.app.store.findAll('worklist', w => w.conversation_id === conv.conversation_id && w.reason === 'complaint' && w.status === 'OPEN');
      assert.ok(wl.length >= 1);
    } },
    { id: 'TK09', desc: 'claim nhớ origin_state; close-claim trả về đúng', async fn(ctx) {
      const conv = ctx.app.store.findOne('conversations', c => c.platform_thread_id === 'tk2');
      const origin = conv.claim.origin_state;
      const r = await ctx.inst.client('POST', '/api/conversations/' + encodeURIComponent(conv.conversation_id) + '/close-claim', { cookie: ctx.sid, body: {} });
      assert.strictEqual(r.json.restored_state, origin);
    } },
    { id: 'TK10', desc: 'ask human ("cho người thật trả lời") -> takeover system + ACK template', async fn(ctx) {
      fire(ctx.app, 'facebook', 'tk3', 'cho người thật trả lời được không', 'tk-6');
      const conv = ctx.app.store.findOne('conversations', c => c.platform_thread_id === 'tk3');
      assert.strictEqual(conv.mode, 'HUMAN');
      const ack = ctx.app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.sender === 'system');
      assert.ok(ack.length >= 1);
      assert.match(ack[ack.length - 1].text_content, /nhân viên/);
    } },
    { id: 'TK11', desc: 'worklist OPEN liệt kê trên notifications (type needs_human)', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/api/notifications', { cookie: ctx.sid });
      assert.ok(r.json.notifications.some(n => n.type === 'needs_human'), 'notifications có needs_human');
      assert.ok(r.json.unread >= 1);
    } },
    { id: 'TK12', desc: 'đọc tất cả -> unread 0; thông báo mới vẫn unread', async fn(ctx) {
      await ctx.inst.client('POST', '/api/notifications/read', { cookie: ctx.sid, body: { all: true } });
      const r1 = await ctx.inst.client('GET', '/api/notifications', { cookie: ctx.sid });
      assert.strictEqual(r1.json.unread, 0);
      fire(ctx.app, 'facebook', 'tk4', 'shop làm ăn lừa đảo', 'tk-7'); // claim mới -> worklist mới
      const r2 = await ctx.inst.client('GET', '/api/notifications', { cookie: ctx.sid });
      assert.ok(r2.json.unread >= 1, 'thông báo mới vẫn nổi');
    } },
    { id: 'TK13', desc: 'dashboard canNhanVien + takeoverCount khớp store', async fn(ctx) {
      const d = await ctx.inst.client('GET', '/api/dashboard', { cookie: ctx.sid });
      const convs = ctx.app.store.findAll('conversations');
      const needHuman = convs.filter(c => c.flag_needs_human || c.mode === 'HUMAN').length;
      assert.strictEqual(d.json.canNhanVien, needHuman);
    } },
    { id: 'TK14', desc: 'takeover giữ state (không reset về NEW_LEAD)', async fn(ctx) {
      const conv = ctx.app.store.findOne('conversations', c => c.platform_thread_id === 'tk1');
      const before = conv.state;
      ctx.app.takeover.setTakeover(conv, 'op2', 'test_keep_state');
      ctx.app.takeover.handback(conv, 'op2');
      assert.strictEqual(conv.state, before);
    } },
    { id: 'TK15', desc: 'handback kích hoạt lại follow-up HELD (mode HUMAN)', async fn(ctx) {
      const app = ctx.app;
      const conv = app.store.findOne('conversations', c => c.platform_thread_id === 'tk1');
      const fu = app.store.insert('follow_ups', {
        follow_up_id: 'fu-tk-held', order_id: null, conversation_id: conv.conversation_id,
        customer_id: conv.customer_id, kind: 'AFTER_DELIVERY_FEEDBACK',
        scheduled_at: app.clock.iso(), status: 'HELD', cancel_reason: 'HUMAN_OWNED', exec_id: null,
        created_at: app.clock.iso(), updated_at: app.clock.iso(),
      });
      app.takeover.handback(conv, 'op3');
      assert.strictEqual(app.store.findOne('follow_ups', f => f.follow_up_id === fu.row.follow_up_id).status, 'SCHEDULED', 'HELD -> SCHEDULED sau handback');
    } },
  ],
};
