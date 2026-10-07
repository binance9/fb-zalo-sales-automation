'use strict';
// test/comment-flow.js — G2: TỰ ĐỘNG COMMENT & INBOX (chuẩn aicake.vn) — standalone.
// Boot server qua factory createServer (port rảnh + TEMP dirs — cùng pattern test/matrix/_harness),
// seed comment (origin 'comment' + comment_id — đúng shape meta-adapter normalize) rồi assert:
//   (a) comment hỏi giá      -> bot tự trả CÓ GIÁ TỪ DB + conversation inbox được tạo (inbox:<comment_id>)
//   (b) comment tiêu cực     -> hide_requested + worklist 'negative_comment' + reply xin lỗi + audit comment_hide
//   (c) comment trùng id x2  -> chỉ xử lý 1 lần (dedupe)
//   (d) tắt công tắc settings -> KHÔNG tự trả (auto_reply_comment/hide/inbox đều tôn trọng)
// Chạy: node test/comment-flow.js — in "comment-flow: X/X PASS", exit 0/1.

const assert = require('assert');
const { startInst, setupShop } = require('./matrix/_harness');
const { classifyComment, negativeReply, positiveReply, commentReply } = require('../src/comment-flow');
const { MetaAdapter, hideComment } = require('../src/channel/meta-adapter');

// bắn comment đi ĐÚNG đường webhook nội bộ (app.receive — cùng đường seedEvent dùng),
// payload đúng shape meta-adapter normalize cho feed event (origin/comment_id/platformEventId).
function fireComment(app, ref, text, commentId) {
  const r = app.receive({
    channel: 'facebook',
    type: 'message',
    platformEventId: `comment:${commentId}`, // dedupe theo comment_id (INV-1)
    payload: {
      customer_ref: ref,
      thread_id: ref,
      kind: 'text',
      text: text || '',
      platform_message_id: commentId,
      origin: 'comment',
      comment_id: commentId,
      post_id: 'post-cf',
      parent_id: null,
    },
  });
  app.drain();
  return r;
}

const outMsgsOf = (app, convId) =>
  app.store.findAll('messages', m => m.conversation_id === convId && m.direction === 'out');

(async () => {
  const groups = [];
  const run = (name, fn) => groups.push({ name, fn });
  let inst = null;
  let sid = null;
  let shop = null;
  let app = null;

  // ============================================================ 0) UNIT classify + {{TenKhachHang}}
  run('unit: classifyComment + reply biến {{TenKhachHang}}', () => {
    const q = classifyComment('áo này bao nhiêu vậy shop');
    assert.strictEqual(q.tone, 'question');
    assert.strictEqual(q.buy_intent, true);
    const n = classifyComment('shop lừa đảo bán hàng fake');
    assert.strictEqual(n.tone, 'negative');
    assert.strictEqual(n.buy_intent, false);
    const p = classifyComment('áo đẹp quá shop ơi');
    assert.strictEqual(p.tone, 'positive');
    // negative: có {{TenKhachHang}} thay bằng tên; thiếu tên -> fallback "bạn"
    const nr = negativeReply('x', 'Lan');
    assert.ok(!nr.includes('{{TenKhachHang}}'), 'biến {{TenKhachHang}} phải được thay');
    assert.ok(nr.includes('Lan') && /xin lỗi/.test(nr), 'reply tiêu cực có tên + xin lỗi');
    assert.ok(negativeReply('x', null).includes('bạn'), 'fallback tên khách là "bạn"');
    const pr = positiveReply('x', 'Minh');
    assert.ok(!pr.includes('{{TenKhachHang}}') && pr.includes('Minh'));
    assert.ok(!commentReply('x', null).includes('{{TenKhachHang}}'));
    // adapter helper mock: KHÔNG gọi mạng, trả bằng chứng mock
    const h = hideComment({ comment_id: 'c-unit' });
    assert.deepStrictEqual(h, { ok: true, mock: true, comment_id: 'c-unit' });
    const m = new MetaAdapter({});
    assert.strictEqual(m.hideComment({ comment_id: 'c-unit2' }).ok, true);
    assert.strictEqual(m.hideCalls.length, 1);
    assert.strictEqual(hideComment({}).ok, false);
  });

  // ============================================================ boot + fixture
  inst = await startInst('comment-flow');
  try {
    const s = await setupShop(inst);
    sid = s.sid; shop = s.shop; app = s.app;
    // seed sản phẩm "Áo" (token 'ao' khớp L3 substring) để case (a) có GIÁ TỪ DB để trả
    const pr = await inst.client('POST', '/api/products', {
      cookie: sid,
      body: { name: 'Áo', sku_base: 'AO-THUN', price: 250000, stock_qty: 10, size: 'free', aliases: 'áo thun, ao thun' },
    });
    assert.strictEqual(pr.status, 200, 'seed sản phẩm Áo: ' + pr.text.slice(0, 120));
    assert.ok(app.productDB.getProductByBase('AO-THUN'), 'Áo vào ProductDB');

    // ============================================================ (a) comment hỏi giá
    run('(a) comment "áo này bao nhiêu" -> reply có giá từ DB + inbox tạo', () => {
      const r = fireComment(app, 'fbuser:qa1', 'áo này bao nhiêu vậy shop', 'c-qa-1');
      assert.strictEqual(r.accepted, true, 'comment vào queue');
      const conv = app.store.findOne('conversations', c => c.conversation_id === 'facebook:fbuser:qa1');
      assert.ok(conv, 'conversation comment được tạo');
      assert.ok(conv.last_comment && conv.last_comment.tone === 'question', 'comment được phân loại question');
      const outs = outMsgsOf(app, conv.conversation_id);
      assert.ok(outs.length >= 1, 'bot TỰ TRẢ comment (auto_reply_comment ON)');
      assert.ok(outs.every(m => m.delivery_status), 'mọi reply đi qua Action Gate có trạng thái gửi');
      assert.ok(
        outs.some(m => String(m.text_content || '').includes('250000')),
        'reply chứa GIÁ TỪ DB (250000đ) — thấy: ' + outs.map(x => String(x.text_content || '').slice(0, 60)).join(' | '),
      );
      // inbox khách từ comment: conversation inbox 1-1 + message/platformEventId riêng dedupe
      assert.ok(app.store.findOne('inbox_events', e => e.event_id === 'facebook:inbox:c-qa-1'), 'event inbox:c-qa-1 ghi nhận');
      assert.ok(app.store.findOne('messages', m => m.platform_message_id === 'inbox:c-qa-1'), 'tin inbox được đẩy vào luồng bán');
      assert.strictEqual(app.store.findAll('messages', m => m.platform_message_id === 'inbox:c-qa-1').length, 1);
    });

    // ============================================================ (b) comment tiêu cực
    run('(b) comment "lừa đảo/fake" -> hide_requested + worklist negative_comment + xin lỗi', () => {
      const r = fireComment(app, 'fbuser:neg1', 'shop lừa đảo bán hàng fake', 'c-neg-1');
      assert.strictEqual(r.accepted, true);
      const conv = app.store.findOne('conversations', c => c.conversation_id === 'facebook:fbuser:neg1');
      assert.ok(conv, 'conversation tạo');
      assert.strictEqual(conv.hide_requested, true, 'flag hide_requested trên conversation');
      const msg = app.store.findOne('messages', m =>
        m.conversation_id === conv.conversation_id && m.platform_message_id === 'c-neg-1');
      assert.ok(msg, 'message comment tồn tại');
      assert.strictEqual(msg.hide_requested, true, 'flag hide_requested trên message');
      const wl = app.store.findAll('worklist', w =>
        w.conversation_id === conv.conversation_id && w.reason === 'negative_comment' && w.status === 'OPEN');
      assert.strictEqual(wl.length, 1, 'worklist entry needs_human reason negative_comment');
      const outs = outMsgsOf(app, conv.conversation_id);
      assert.ok(outs.some(m => /xin lỗi/.test(String(m.text_content || ''))), 'reply công khai câu xin lỗi');
      const aud = app.store.findAll('audit_events', a =>
        a.proposed_action === 'comment_hide' && a.conversation_id === conv.conversation_id);
      assert.ok(aud.length >= 1 && aud[0].execution_result === 'HIDE_REQUESTED', 'audit action comment_hide');
      assert.strictEqual(app.store.findAll('worklist', w => w.reason === 'negative_comment').length, 1);
    });

    // ============================================================ (c) comment trùng comment_id x2
    run('(c) comment trùng comment_id gửi 2 lần -> chỉ xử lý 1 lần (dedupe)', () => {
      const r1 = fireComment(app, 'fbuser:dup1', 'áo này bao nhiêu vậy shop', 'c-dup-1');
      const r2 = fireComment(app, 'fbuser:dup1', 'áo này bao nhiêu vậy shop', 'c-dup-1');
      assert.strictEqual(r1.accepted, true);
      assert.strictEqual(r2.duplicate, true, 'lần 2 bị chặn ở cửa vào (INV-1)');
      const conv = app.store.findOne('conversations', c => c.conversation_id === 'facebook:fbuser:dup1');
      assert.ok(conv);
      // 1 luồng comment + 1 luồng inbox = đúng 2 reply bot, KHÔNG nhân đôi
      assert.strictEqual(outMsgsOf(app, conv.conversation_id).length, 2,
        'đúng 2 reply (comment + inbox), không xử lý lặp');
      assert.strictEqual(app.store.findAll('messages', m => m.platform_message_id === 'inbox:c-dup-1').length, 1,
        'inbox chỉ tạo đúng 1 lần');
      assert.strictEqual(app.store.findAll('inbox_events', e => e.event_id === 'facebook:comment:c-dup-1').length, 1);
    });

    // ============================================================ (d) tắt công tắc -> không tự trả
    run('(d) settings tắt 3 công tắc -> không tự trả / không ẩn / không inbox', () => {
      inst.settingsFor(shop).setMany({
        auto_reply_comment: false,
        hide_negative_comment: false,
        auto_inbox_from_comment: false,
      });
      // (d1) comment hỏi giá: KHÔNG reply công khai, KHÔNG inbox
      fireComment(app, 'fbuser:off1', 'áo này bao nhiêu vậy shop', 'c-off-1');
      const conv1 = app.store.findOne('conversations', c => c.conversation_id === 'facebook:fbuser:off1');
      assert.ok(conv1);
      assert.strictEqual(outMsgsOf(app, conv1.conversation_id).length, 0, 'KHÔNG tự trả khi tắt công tắc');
      assert.ok(!app.store.findOne('messages', m => m.platform_message_id === 'inbox:c-off-1'), 'KHÔNG đẩy inbox');
      // (d2) comment tiêu cực: KHÔNG ẩn, KHÔNG worklist, KHÔNG xin lỗi
      fireComment(app, 'fbuser:off2', 'shop lừa đảo bán hàng fake', 'c-off-2');
      const conv2 = app.store.findOne('conversations', c => c.conversation_id === 'facebook:fbuser:off2');
      assert.ok(conv2);
      assert.notStrictEqual(conv2.hide_requested, true, 'KHÔNG flag hide khi tắt hide_negative_comment');
      assert.strictEqual(app.store.findAll('worklist', w =>
        w.conversation_id === conv2.conversation_id && w.reason === 'negative_comment').length, 0, 'KHÔNG worklist');
      assert.strictEqual(outMsgsOf(app, conv2.conversation_id).length, 0, 'KHÔNG reply xin lỗi');
    });
  } catch (err) {
    groups.push({ name: 'BOOT/FIXTURE', fn: () => { throw err; } });
  } finally {
    // ============================================================ chạy + tổng kết
    let pass = 0;
    const fails = [];
    for (const g of groups) {
      try {
        g.fn();
        pass += 1;
        console.log(`  PASS  ${g.name}`);
      } catch (e) {
        fails.push(g.name);
        console.error(`  FAIL  ${g.name}\n        ${e && e.message}`);
      }
    }
    const total = groups.length;
    console.log(`comment-flow: ${pass}/${total} PASS`);
    try { if (inst) await inst.close(); } catch (e) { /* ignore */ }
    setTimeout(() => process.exit(fails.length ? 1 : 0), 50);
  }
})();
