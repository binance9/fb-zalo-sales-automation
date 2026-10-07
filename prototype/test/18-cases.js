'use strict';
// test/18-cases.js — chạy TUẦN TỰ 18 case theo đúng thứ tự trong docs/00-yeu-cau.md.
// Mỗi case: dựng dữ liệu (App mới = DB mới) -> bắn event -> assert kết quả kỳ vọng
// (spec chi tiết: docs/AI3-backend-reliability.md mục 11 + phụ lục B).
// In bảng kết quả cuối: 18 dòng PASS/FAIL + tổng. Exit code 0 khi 18/18.

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { App } = require('../src/app');
const { SAFE_REPLIES } = require('../src/action-gate');
const { renderSystemTemplate } = require('../src/system-templates');
const { ProductDB, FUZZY_THRESHOLD } = require('../src/product-db');

const DATA = path.join(__dirname, '..', 'data', 'test-runs');
const FB = 'facebook';
const ZL = 'zalo';

let pid = 0;
function msg(app, channel, ref, text, extra = {}) {
  pid += 1;
  return app.receive({
    channel,
    type: 'message',
    platformEventId: extra.pid || `mid-${ref}-${pid}`,
    payload: {
      customer_ref: ref,
      thread_id: extra.thread || ref,
      kind: extra.kind || 'text',
      text: text || '',
      media: extra.media,
      platform_message_id: `pm-${pid}`,
    },
  });
}

const convOf = (app, ref) => app.store.findOne('conversations', c => c.platform_thread_id === ref);
const cusOf = (app, ref) => app.store.findOne('customers', c => c.platform_ref === ref);
const outMsgs = (app, ref) => {
  const conv = convOf(app, ref);
  return conv ? app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'out') : [];
};
const auditFor = (app, ref) => {
  const conv = convOf(app, ref);
  return conv ? app.store.findAll('audit_events', a => a.conversation_id === conv.conversation_id) : [];
};
const stock = (app, sku) => app.productDB.getStock(sku);

const BUY_VANILLA = 'lấy 1 nến vanilla M đỏ, tên Anh Bảo, sdt 0901111222, địa chỉ 12 Nguyễn Trãi Q1 TP.HCM';

// Mua 1 sản phẩm + xác nhận -> trả order CONFIRMED (dùng cho case 13/16/17/18)
function buyAndConfirm(app, ref, buyText) {
  msg(app, FB, ref, buyText || BUY_VANILLA);
  app.drain();
  msg(app, FB, ref, 'xác nhận');
  app.drain();
  const conv = convOf(app, ref);
  const orders = app.store.findAll('orders', o => o.conversation_id === conv.conversation_id && o.status === 'CONFIRMED');
  assert.ok(orders.length >= 1, `buyAndConfirm(${ref}): chưa có đơn CONFIRMED`);
  return orders[orders.length - 1];
}

// ============================================================ 18 CASES
const CASES = [
  // ---------------------------------------------------------- CASE 1
  {
    n: 1, desc: 'Khách hỏi giá — giá từ DB, không phải lời AI',
    fn() {
      // Unit: 4 lớp searchProduct đều trúng đúng lớp
      const db = new ProductDB({ seedFile: path.join(__dirname, '..', 'data', 'products.json') });
      assert.strictEqual(db.searchProduct('NT-VANILLA-M-DO').matches[0].layer, 'sku', 'L1 sku');
      assert.strictEqual(db.searchProduct('trà hoa sấy').matches[0].layer, 'alias', 'L2 alias');
      assert.strictEqual(db.searchProduct('nến thơm').matches[0].layer, 'substring', 'L3 substring');
      assert.ok(db.searchProduct('nến thơm').matches.length >= 2, 'substring multi-match 2 nến thơm');
      const fz = db.searchProduct('nen vanila').matches[0];
      assert.strictEqual(fz.layer, 'fuzzy', 'L4 fuzzy');
      assert.ok(fz.score >= FUZZY_THRESHOLD, 'fuzzy score >= 0.8');

      const app = new App({ dataDir: path.join(DATA, 'case-01') });
      msg(app, FB, 'fb-c1', 'nen vanila size M bao nhiêu vậy shop');
      app.drain();

      const outs = outMsgs(app, 'fb-c1');
      assert.strictEqual(outs.length, 1, 'đúng 1 tin out');
      assert.ok(outs[0].text_content.includes('185000'), 'tin out chứa giá DB 185000');
      const ins = app.store.findAll('messages', m => m.direction === 'in');
      assert.strictEqual(ins.length, 1, '1 tin in');

      const prp = app.store.findOne('ai_proposals', p => p.intent === 'PRICE');
      assert.ok(prp, 'có ai_proposals PRICE');
      assert.ok(JSON.parse(prp.evidence_json).source === 'product_db', 'evidence price.source=product_db');
      assert.strictEqual(JSON.parse(prp.validation_json).evidence_present, true, 'validation evidence_present');

      const execs = app.store.findAll('action_executions', e => e.action_type === 'SEND_MESSAGE');
      assert.strictEqual(execs.length, 1, 'đúng 1 exec send');
      assert.strictEqual(execs[0].status, 'DONE', 'exec DONE');
      assert.ok(execs[0].receipt_json && JSON.parse(execs[0].receipt_json).mid, 'exec có receipt (mid)');

      const stages = auditFor(app, 'fb-c1').map(a => a.stage);
      for (const s of ['PROPOSED', 'VALIDATED', 'AUTHORIZED', 'EXECUTED', 'VERIFIED']) {
        assert.ok(stages.includes(s), `audit thiếu stage ${s}`);
      }
      const inbox = app.store.findAll('inbox_events', e => e.status === 'PROCESSED');
      assert.strictEqual(inbox.length, 1, 'inbox_events 1 dòng PROCESSED');
    },
  },

  // ---------------------------------------------------------- CASE 2
  {
    n: 2, desc: 'Hỏi size/màu — liệt kê đúng biến thể + tồn hiệu dụng từ DB',
    fn() {
      const app = new App({ dataDir: path.join(DATA, 'case-02') });
      msg(app, FB, 'fb-c2', 'nến vanilla còn size M màu đỏ không?');
      app.drain();

      const outs = outMsgs(app, 'fb-c2');
      assert.strictEqual(outs.length, 1);
      const t = outs[0].text_content;
      assert.ok(t.includes('còn 3'), 'M đỏ còn 3 (theo DB)');
      assert.ok(t.includes('hết hàng'), 'M xanh hết hàng (theo DB)');
      assert.ok(t.includes('185000'), 'giá M = 185000 từ DB');
      assert.ok(!t.includes('màu vàng') && !t.includes('mau vang'), 'không bịa biến thể không có');
      const prp = app.store.findOne('ai_proposals', p => p.intent === 'VARIANT');
      const ev = JSON.parse(prp.evidence_json);
      assert.strictEqual(ev.source, 'product_db');
      assert.strictEqual(ev.variants.find(v => v.sku === 'NT-VANILLA-M-DO').effective, 3, 'snapshot tồn kho trong audit');
    },
  },

  // ---------------------------------------------------------- CASE 3
  {
    n: 3, desc: 'Ảnh "còn cái này không?" — vision match + media local_path; match yếu -> NEEDS_HUMAN',
    fn() {
      const app = new App({ dataDir: path.join(DATA, 'case-03') });
      msg(app, FB, 'fb-c3', 'còn cái này không?', {
        kind: 'image',
        media: { platform_url: 'https://fbcdn.example/nen-vanilla-m-do.jpg' },
      });
      app.drain();

      const conv = convOf(app, 'fb-c3');
      const inMsg = app.store.findOne('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'in');
      const att = JSON.parse(inMsg.attachment_json)[0];
      assert.ok(att.local_path && fs.existsSync(att.local_path), 'media đã tải về local_path tồn tại trên đĩa');

      const outs = outMsgs(app, 'fb-c3');
      assert.strictEqual(outs.length, 1);
      assert.ok(outs[0].text_content.includes('còn 3'), 'trả tồn kho đúng variant khớp ảnh');
      const prp = app.store.findOne('ai_proposals', p => p.intent === 'STOCK');
      const ev = JSON.parse(prp.evidence_json);
      assert.strictEqual(ev.matched_variant_id, 'NT-VANILLA-M-DO', 'evidence có matched_variant_id');
      assert.ok(ev.vision_score >= 0.6, 'vision score ghi trong evidence');

      // Biến thể: ảnh mờ -> score thấp -> KHÔNG tự trả, NEEDS_HUMAN
      msg(app, FB, 'fb-c3', 'còn cái này không?', { kind: 'image', media: { platform_url: 'https://fbcdn.example/blur.jpg' } });
      app.drain();
      const outs2 = outMsgs(app, 'fb-c3');
      assert.strictEqual(outs2.length, 2);
      assert.ok(SAFE_REPLIES.includes(outs2[1].text_content), 'match yếu -> câu an toàn, không tự trả');
      const prp2 = app.store.findOne('ai_proposals', p => p.intent === 'IMAGE_MATCH_LOW');
      assert.strictEqual(prp2.decision, 'NEEDS_HUMAN');
      assert.ok(app.store.findAll('worklist', w => w.reason === 'low_evidence:IMAGE_MATCH_LOW').length >= 1, 'operator có việc NEEDS_HUMAN');
    },
  },

  // ---------------------------------------------------------- CASE 4
  {
    n: 4, desc: 'Voice — ASR trước rồi vào pipeline text như thường; ASR fail -> NEEDS_HUMAN',
    fn() {
      const app = new App({ dataDir: path.join(DATA, 'case-04') });
      msg(app, ZL, 'zl-c4', '', { kind: 'voice', media: { platform_url: 'https://zcdn.example/voice-tra.amr' } });
      app.drain();

      const conv = convOf(app, 'zl-c4');
      const inMsg = app.store.findOne('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'in');
      assert.strictEqual(inMsg.text_content, 'cho mình 1 hộp trà hoa sấy nhé', 'transcript lưu text_content');
      const att = JSON.parse(inMsg.attachment_json)[0];
      assert.strictEqual(att.from_asr, true, 'cờ from_asr');

      // downstream: luồng bán hàng chạy như text -> hỏi SĐT (slot thiếu)
      const outs = outMsgs(app, 'zl-c4');
      assert.strictEqual(outs.length, 1);
      assert.ok(outs[0].text_content.includes('SĐT'), 'tiếp tục slot-filling như text thường');
      assert.strictEqual(conv.state, 'COLLECT_ORDER');

      // Biến thể: ASR fail -> không đoán
      msg(app, ZL, 'zl-c4', '', { kind: 'voice', media: { platform_url: 'https://zcdn.example/broken.amr' } });
      app.drain();
      const outs2 = outMsgs(app, 'zl-c4');
      assert.strictEqual(outs2.length, 2);
      assert.ok(SAFE_REPLIES.includes(outs2[1].text_content), 'ASR fail -> câu an toàn');
      assert.ok(app.store.findOne('ai_proposals', p => p.intent === 'VOICE_ASR_FAIL' && p.decision === 'NEEDS_HUMAN'));
      assert.ok(!fs.readFileSync(path.join(DATA, 'case-04', 'audit.jsonl'), 'utf8').includes('zcdn-token'), 'token media không lọt audit/log');
    },
  },

  // ---------------------------------------------------------- CASE 5
  {
    n: 5, desc: 'Đổi sản phẩm giữa hội thoại — hủy DRAFT cũ, hoàn reserve, slot độc lập giữ nguyên',
    fn() {
      const app = new App({ dataDir: path.join(DATA, 'case-05') });
      msg(app, FB, 'fb-c5', 'lấy 1 nến vanilla M đỏ, tên An, sdt 0901111222, địa chỉ 3 Lê Lợi Q1');
      app.drain();
      let conv = convOf(app, 'fb-c5');
      const draft1 = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
      assert.ok(draft1, 'pha A tạo DRAFT cho V1');
      assert.strictEqual(stock(app, 'NT-VANILLA-M-DO').stock_reserved, 1, 'reserve V1 = 1');
      const nameBefore = conv.draft.slots.name.value;

      msg(app, FB, 'fb-c5', 'thôi lấy hộp trà hoa sấy đi');
      app.drain();

      conv = convOf(app, 'fb-c5');
      assert.strictEqual(app.productDB.getVariant('NT-VANILLA-M-DO').variant.stock_reserved, 0, 'reserve V1 hoàn về 0');
      assert.strictEqual(app.productDB.getVariant('TRA-HOA-SEY-50').variant.stock_reserved, 1, 'reserve V2 = 1');
      const activeDrafts = app.store.findAll('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
      assert.strictEqual(activeDrafts.length, 1, 'chỉ 1 DRAFT active');
      assert.strictEqual(app.store.findOne('orders', o => o.order_id === draft1.order_id).status, 'CANCELLED', 'DRAFT cũ bị hủy');
      assert.strictEqual(conv.draft.slots.name.value, nameBefore, 'slot tên GIỮ NGUYÊN khi đổi SP');
      const outs = outMsgs(app, 'fb-c5');
      assert.ok(outs[outs.length - 1].text_content.includes('trà hoa sấy'), 'tin xác nhận nói đúng SP mới');
      const orderStages = auditFor(app, 'fb-c5').filter(a => a.proposed_action === 'ORDER_STATUS');
      assert.ok(orderStages.some(a => a.validation.to === 'CANCELLED') && orderStages.some(a => a.validation.to === 'DRAFT'), 'audit 2 chuỗi: hủy cũ + tạo mới');
    },
  },

  // ---------------------------------------------------------- CASE 6
  {
    n: 6, desc: 'Mua nhiều SKU — order_items ≥2, trừ đúng stock; 1 variant hết -> rollback toàn bộ',
    fn() {
      const app = new App({ dataDir: path.join(DATA, 'case-06') });
      msg(app, FB, 'fb-c6', 'lấy 2 nến vanilla M đỏ và 1 trà hoa sấy, tên An, sdt 0901111222, địa chỉ 25 Nguyễn Trãi Q1 TP.HCM');
      app.drain();
      msg(app, FB, 'fb-c6', 'xác nhận');
      app.drain();

      const conv = convOf(app, 'fb-c6');
      const order = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'CONFIRMED');
      assert.ok(order, 'đơn CONFIRMED');
      const items = app.store.findAll('order_items', i => i.order_id === order.order_id);
      assert.ok(items.length >= 2, 'order_items >= 2 dòng');
      assert.strictEqual(order.total, 2 * 185000 + 145000 + 25000, 'tổng = SUM(line_total) + fee (VND nguyên)');
      assert.strictEqual(stock(app, 'NT-VANILLA-M-DO').stock_qty, 1, 'M đỏ 3-2=1');
      assert.strictEqual(stock(app, 'TRA-HOA-SEY-50').stock_qty, 19, 'trà 20-1=19');

      // Biến thể: 1 trong các variant hết -> toàn bộ rollback, không có đơn nửa vời
      msg(app, FB, 'fb-c6b', 'lấy 1 set quà Tết và 1 nến vanilla M đỏ, tên Bình, sdt 0912222333, địa chỉ 5 Trần Phú Q5');
      app.drain();
      const conv2 = convOf(app, 'fb-c6b');
      const orders2 = app.store.findAll('orders', o => o.conversation_id === conv2.conversation_id);
      assert.strictEqual(orders2.length, 0, 'không tạo đơn nửa vời khi 1 variant hết');
      assert.strictEqual(stock(app, 'NT-VANILLA-M-DO').stock_reserved, 0, 'không reserve sót cho giỏ hỏng');
      const outs2 = outMsgs(app, 'fb-c6b');
      assert.ok(outs2[0].text_content.includes('hết hàng'), 'báo hết hàng + đề xuất phương án');
    },
  },

  // ---------------------------------------------------------- CASE 7
  {
    n: 7, desc: 'Thiếu địa chỉ — không tạo đơn, hỏi đúng trường thiếu, state giữ COLLECT_ORDER',
    fn() {
      const app = new App({ dataDir: path.join(DATA, 'case-07') });
      msg(app, FB, 'fb-c7', 'lấy 1 nến vanilla M đỏ, tên An, sdt 0901111222');
      app.drain();

      const conv = convOf(app, 'fb-c7');
      assert.strictEqual(app.store.findAll('orders', o => o.conversation_id === conv.conversation_id).length, 0, 'không có orders DRAFT/CONFIRMED');
      assert.ok(!app.store.findAll('action_executions', e => e.action_type === 'CREATE_ORDER').some(e => e.status === 'DONE'), 'không có CREATE_ORDER DONE');
      const outs = outMsgs(app, 'fb-c7');
      assert.strictEqual(outs.length, 1);
      assert.ok(outs[0].text_content.includes('địa chỉ'), 'tin out hỏi đúng trường thiếu (địa chỉ)');
      assert.strictEqual(conv.state, 'COLLECT_ORDER', 'state vẫn COLLECT_ORDER');

      // bổ sung địa chỉ -> luồng chạy tiếp, pha A tạo DRAFT
      msg(app, FB, 'fb-c7', 'địa chỉ 12 Nguyễn Trãi Q1 TP.HCM');
      app.drain();
      assert.ok(app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT'), 'đủ địa chỉ -> DRAFT tạo');
    },
  },

  // ---------------------------------------------------------- CASE 8
  {
    n: 8, desc: 'AI định báo sai giá ("giá sốc" -50%) — gate đè bằng giá DB 185000',
    fn() {
      const app = new App({ dataDir: path.join(DATA, 'case-08') });
      msg(app, FB, 'fb-c8', 'cho hỏi giá sốc của nến vanilla size M với');
      app.drain();

      const outs = outMsgs(app, 'fb-c8');
      assert.strictEqual(outs.length, 1);
      const t = outs[0].text_content;
      assert.ok(t.includes('185000'), 'khách nhận giá DB 185000');
      assert.ok(!t.includes('92500'), 'KHÔNG chứa giá bịa 92500');
      assert.ok(!/giá sốc|GIÁ SỐC/.test(t), 'không nêu "khuyến mãi" không có trong DB');

      const prp = app.store.findOne('ai_proposals', p => p.intent === 'PRICE');
      assert.strictEqual(prp.decision, 'OVERRIDDEN', 'decision = OVERRIDDEN');
      const val = JSON.parse(prp.validation_json);
      assert.ok(val.overridden_fields.includes('price'), 'audit VALIDATE ghi overridden_fields=[price]');
      assert.ok(val.bad_money.includes(92500), 'ghi rõ số bịa bị chặn');
      const ev = JSON.parse(prp.evidence_json);
      assert.strictEqual(ev.source, 'AI_TU_BIA', 'evidence ghi rõ lời AI tự bịa');
      assert.ok(app.metric('gate_override') >= 1, 'metric gate_override++');
    },
  },

  // ---------------------------------------------------------- CASE 9
  {
    n: 9, desc: 'Hết hàng giữa chat và chốt — pha B re-validate, không oversell',
    fn() {
      const app = new App({ dataDir: path.join(DATA, 'case-09') });
      app.productDB.setStock('NT-VANILLA-M-DO', 1); // chỉ còn 1
      msg(app, FB, 'fb-c9', BUY_VANILLA);
      app.drain();
      let conv = convOf(app, 'fb-c9');
      assert.ok(app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT'), 'pha A giữ chỗ khi còn 1');

      // can thiệp bên ngoài: đơn khác vừa bán nốt (stock 1 -> 0) TRƯỚC khi khách chốt
      app.productDB.setStock('NT-VANILLA-M-DO', 0);

      msg(app, FB, 'fb-c9', 'xác nhận');
      app.drain();

      conv = convOf(app, 'fb-c9');
      assert.ok(!app.store.findAll('orders', o => o.conversation_id === conv.conversation_id).some(o => o.status === 'CONFIRMED'), 'KHÔNG có đơn CONFIRMED');
      for (const v of app.productDB.allVariants()) {
        assert.ok(v.variant.stock_qty >= 0, `không oversell stock_qty ${v.variant.sku}`);
        assert.ok(v.variant.stock_qty - (v.variant.stock_reserved || 0) >= 0, `tồn hiệu dụng >= 0 ${v.variant.sku}`);
      }
      const outs = outMsgs(app, 'fb-c9');
      assert.ok(outs[outs.length - 1].text_content.includes('hết hàng'), 'tin out báo hết hàng đúng variant');
      const failed = auditFor(app, 'fb-c9').find(a => a.stage === 'FAILED' && a.proposed_action === 'CONFIRM_ORDER');
      assert.ok(failed && failed.validation.fail === 'OUT_OF_STOCK', 'audit VALIDATE fail reason=out_of_stock');
      assert.ok(['PRODUCT_QA', 'COLLECT_ORDER'].includes(conv.state), 'hội thoại chuyển trạng thái hợp lệ, không kẹt');
    },
  },

  // ---------------------------------------------------------- CASE 10
  {
    n: 10, desc: 'Webhook DUPLICATE — lần 2 bị bỏ, chỉ 1 reply, dedupe_hit=1',
    fn() {
      const app = new App({ dataDir: path.join(DATA, 'case-10') });
      const ev = {
        channel: FB, type: 'message', platformEventId: 'mid-dup-001',
        payload: { customer_ref: 'fb-c10', thread_id: 'fb-c10', kind: 'text', text: 'nến vanilla còn hàng không?' },
      };
      const r1 = app.receive(ev);
      const r2 = app.receive({ ...ev, payload: { ...ev.payload } }); // gửi lại byte-đối-byte cùng platformEventId
      assert.strictEqual(r1.http, 200);
      assert.strictEqual(r2.http, 200, 'lần 2 vẫn 200');
      assert.strictEqual(r1.duplicate, false);
      assert.strictEqual(r2.duplicate, true, 'lần 2 duplicate:true');
      app.drain();

      assert.strictEqual(app.store.findAll('inbox_events', e => e.event_id === 'facebook:mid-dup-001').length, 1, 'inbox_events chỉ 1 dòng');
      const conv = convOf(app, 'fb-c10');
      assert.strictEqual(app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'in').length, 1, '1 tin in');
      assert.strictEqual(app.store.findAll('action_executions', e => e.action_type === 'SEND_MESSAGE' && e.status === 'DONE').length, 1, 'AI trả lời ĐÚNG 1 lần');
      assert.strictEqual(app.metric('dedupe_hit'), 1, 'metric dedupe_hit=1');

      // Biến thể Zalo: trùng msg_id kênh zalo cũng dedupe riêng
      const z1 = app.receive({ channel: ZL, type: 'message', platformEventId: 'msg-z-1', payload: { customer_ref: 'zl-c10', text: 'hi' } });
      const z2 = app.receive({ channel: ZL, type: 'message', platformEventId: 'msg-z-1', payload: { customer_ref: 'zl-c10', text: 'hi' } });
      assert.strictEqual(z1.duplicate, false);
      assert.strictEqual(z2.duplicate, true, 'zalo trùng msg_id cũng bị bỏ');
    },
  },

  // ---------------------------------------------------------- CASE 11
  {
    n: 11, desc: 'Gửi tin timeout — TIMEOUT_UNKNOWN -> check receipt -> DONE; không có tin thứ 2',
    fn() {
      // Biến thể chính: response mất nhưng tin VẪN được giao sau 5s -> check_receipt tìm thấy bằng chứng
      const app = new App({ dataDir: path.join(DATA, 'case-11'), platformMode: 'hang_then_deliver', platformLatencyMs: 5000 });
      msg(app, FB, 'fb-c11', 'nến vanilla giá bao nhiêu?');
      app.drain();

      assert.strictEqual(app.platform.sentCalls.length, 1, 'khách nhận ĐÚNG 1 tin (platform nhận 1 call)');
      const exec = app.store.findOne('action_executions', e => e.action_type === 'SEND_MESSAGE');
      assert.strictEqual(exec.status, 'DONE', 'sau receipt -> DONE');
      assert.ok(JSON.parse(exec.receipt_json).mid, 'receipt_json có mid');
      const out = outMsgs(app, 'fb-c11')[0];
      assert.strictEqual(out.delivery_status, 'DELIVERED', 'messages.delivery_status=DELIVERED');
      assert.ok(out.platform_message_id, 'platform_message_id (mid) đối chứng');

      // Biến thể xấu: không bao giờ có bằng chứng -> 3 lần check -> DLQ + human takeover.
      // P3C (BL-5/BL-7 — SỬA TEST CÓ LÝ DO): tại thời điểm DLQ, hệ thống GIỜ gửi ĐÚNG 1 tin
      // ACK_DLQ (system template whitelist) để chống dead-air — thiết kế BẮT BUỘC của V2 mục
      // B.10.5 ("template system ACK... gửi đúng 1 lần tại thời điểm DLQ; khách nhận >=1 tin ack").
      // Assertion cũ freeze "sentCalls=1" mâu thuẫn trực tiếp với chính sách mới; KHÔNG phải lách:
      // tin gốc vẫn KHÔNG được blind-resend (đúng 1 call), tin thêm là template ACK riêng.
      const app2 = new App({ dataDir: path.join(DATA, 'case-11b'), platformMode: 'hang_forever' });
      msg(app2, FB, 'fb-c11b', 'nến vanilla giá bao nhiêu?');
      app2.drain();
      const ackText = renderSystemTemplate('ACK_DLQ');
      assert.strictEqual(app2.platform.sentCalls.length, 2, 'ĐÚNG 2 call: tin gốc KHÔNG blind-resend (1) + ACK_DLQ chống dead-air (1)');
      assert.strictEqual(app2.platform.sentCalls.filter(c => c.text === ackText).length, 1, 'ACK_DLQ gửi ĐÚNG 1 lần');
      // P3C ghi chú: trên nền platform chết HẲN (hang_forever), chính tin ACK cũng không bao giờ
      // có receipt -> exec của ACK cũng rơi DLQ (đúng INV-2: không biết kết quả thì không đoán).
      assert.ok(app2.store.findAll('dlq', d => d.fail_reason === 'NO_RECEIPT_AFTER_3_CHECKS').length >= 1, 'DLQ có dòng (tin gốc; ACK cũng DLQ vì platform chết hẳn)');
      assert.strictEqual(convOf(app2, 'fb-c11b').mode, 'HUMAN', 'conversation chuyển HUMAN takeover');
      assert.ok(app2.store.findAll('worklist', w => w.reason === 'send_timeout_no_receipt').length >= 1, 'operator có cảnh báo');
    },
  },

  // ---------------------------------------------------------- CASE 12
  {
    n: 12, desc: 'Tạo vận đơn timeout — retry mù bị CHẶN -> DLQ; reconcile tra cứu mã -> không bao giờ 2 vận đơn',
    fn() {
      // Biến thể chính: carrier treo response NHƯNG đã tạo vận đơn thật -> ALREADY_EXISTS.
      // createShipment chạy TỰ ĐỘNG ngay sau confirm (trong pipeline), carrier mode 'hang'.
      const app = new App({ dataDir: path.join(DATA, 'case-12'), carrierMode: 'hang' });
      const order = buyAndConfirm(app, 'fb-c12'); // helper đã drain: timeout -> retry mù bị chặn -> DLQ -> reconcile
      assert.strictEqual(order.status, 'CONFIRMED', 'đơn nội bộ CONFIRMED (không rơi case timeout)');

      assert.ok(app.store.findAll('dlq', d => d.fail_reason === 'RETRY_BLOCKED_NO_RECEIPT').length === 1, 'attempt retry bị CHẶN thiếu receipt -> đi vào DLQ');
      assert.strictEqual(convOf(app, 'fb-c12').flag_needs_human, true, 'cờ needsHuman');
      assert.ok(app.store.findAll('audit_events', a => a.execution_result === 'TIMEOUT_UNKNOWN' && a.proposed_action === 'CREATE_SHIPMENT').length >= 1, 'executor timeout -> TIMEOUT_UNKNOWN có trong audit');

      const shipments = app.store.findAll('shipments', s => s.order_id === order.order_id);
      assert.strictEqual(shipments.length, 1, 'DB shipments chỉ 1 dòng cho order');
      assert.strictEqual(app.carrier.createCalls.length, 1, 'nhà mock nhận ĐÚNG 1 lần createShipment');
      const exec = app.store.findOne('action_executions', e => e.idempotency_key === `shipment:${order.order_id}`);
      assert.strictEqual(exec.status, 'DONE', 'reconcile xong -> DONE');
      assert.strictEqual(shipments[0].tracking_number, 'MOCK-' + order.order_code, 'dùng tracking CŨ từ ALREADY_EXISTS (không tạo lần 2)');
      assert.ok(app.store.findAll('audit_events', a => a.execution_result === 'ALREADY_EXISTS_RESOLVED').length >= 1, 'audit reconcile ALREADY_EXISTS');

      // Biến thể: carrier treo và KHÔNG ghi nhận (sự cố tạm thời) -> reconcile NOT_EXISTS
      // -> retry AN TOÀN dùng lại idempotency key -> thành công 1 lần
      const app2 = new App({ dataDir: path.join(DATA, 'case-12b'), carrierMode: 'flaky_once' });
      const order2 = buyAndConfirm(app2, 'fb-c12b');
      const shp2 = app2.store.findAll('shipments', s => s.order_id === order2.order_id);
      assert.strictEqual(shp2.length, 1, 'KHÔNG bao giờ 2 vận đơn');
      assert.strictEqual(app2.carrier.createCalls.length, 2, 'retry create đúng 1 lần sau khi chắc chắn chưa tồn tại');
      assert.ok(app2.carrier.createCalls.every(c => c.idempotencyKey === `shipment:${order2.order_id}`), 'retry DÙNG LẠI idempotency key');
      assert.strictEqual(app2.store.findOne('action_executions', e => e.idempotency_key === `shipment:${order2.order_id}`).status, 'DONE');
    },
  },

  // ---------------------------------------------------------- CASE 13
  {
    n: 13, desc: 'Khách khiếu nại — mode HUMAN (system), chỉ template an ủi, hủy follow-up marketing',
    fn() {
      const app = new App({ dataDir: path.join(DATA, 'case-13') });
      const order = buyAndConfirm(app, 'fb-c13');
      // một follow-up marketing đang chờ
      app.store.insert('follow_ups', {
        follow_up_id: 'fu-mkt-13', order_id: order.order_id, conversation_id: order.conversation_id,
        customer_id: order.customer_id, kind: 'MARKETING',
        scheduled_at: new Date(app.clock.now() + 3600e3).toISOString(),
        status: 'SCHEDULED', cancel_reason: null, exec_id: null,
        created_at: app.store.now(), updated_at: app.store.now(),
      });
      const outBefore = outMsgs(app, 'fb-c13').length;

      msg(app, FB, 'fb-c13', 'đơn tao 2 tuần rồi chưa thấy đâu, lừa đảo à?');
      app.drain();

      const conv = convOf(app, 'fb-c13');
      assert.strictEqual(conv.mode, 'HUMAN', 'mode=HUMAN');
      const modeAudit = auditFor(app, 'fb-c13').find(a => a.proposed_action === 'TAKEOVER' || a.proposed_action === 'MODE_CHANGE');
      assert.ok(modeAudit, 'audit takeover/mode-change tồn tại');
      assert.strictEqual(modeAudit.validation.operator || modeAudit.validation.actor, 'system', 'actor=system');
      assert.strictEqual(modeAudit.validation.reason, 'complaint', 'reason=complaint');
      const fu = app.store.findOne('follow_ups', f => f.follow_up_id === 'fu-mkt-13');
      assert.strictEqual(fu.status, 'CANCELLED', 'follow_ups marketing -> CANCELLED');

      const outs = outMsgs(app, 'fb-c13');
      assert.strictEqual(outs.length, outBefore + 1, 'duy nhất 1 tin out (template an ủi)');
      const t = outs[outs.length - 1].text_content;
      assert.ok(t.includes('xin lỗi'), 'template an ủi');
      assert.ok(!/hoàn tiền|bồi thường|hoan tien|boi thuong/i.test(t), 'không hứa hẹn bồi thường');

      // tin tiếp theo: AI KHÔNG auto-send
      msg(app, FB, 'fb-c13', 'alo?');
      app.drain();
      assert.strictEqual(outMsgs(app, 'fb-c13').length, outs.length, 'không có AI action nào sau khiếu nại');
      assert.ok(app.store.findAll('worklist', w => w.reason === 'complaint').length >= 1, 'alert operator');
    },
  },

  // ---------------------------------------------------------- CASE 14
  {
    n: 14, desc: 'Không đủ evidence — nhận không biết, câu an toàn + NEEDS_HUMAN, không đoán bừa',
    fn() {
      const app = new App({ dataDir: path.join(DATA, 'case-14') });
      msg(app, FB, 'fb-c14', 'nến này dùng cho bé 3 tháng được không?');
      app.drain();

      const outs = outMsgs(app, 'fb-c14');
      assert.strictEqual(outs.length, 1);
      const t = outs[0].text_content;
      assert.ok(SAFE_REPLIES.includes(t), 'tin out thuộc danh sách câu an toàn được phép');
      assert.ok(!/bé 3 tháng|an toàn cho bé|không vấn đề/i.test(t), 'KHÔNG có khẳng định bịa về thuộc tính');
      const prp = app.store.findOne('ai_proposals', p => p.intent === 'ATTR_UNKNOWN');
      assert.strictEqual(prp.decision, 'NEEDS_HUMAN', 'audit NEEDS_HUMAN');
      assert.strictEqual(prp.evidence_json, null, 'evidence rỗng được ghi rõ');
      assert.ok(app.metric('ai_low_confidence') >= 1, 'metric ai_low_confidence++');
      assert.ok(app.store.findAll('worklist', w => w.status === 'OPEN').length >= 1, 'operator có việc trong worklist NEEDS_HUMAN');
    },
  },

  // ---------------------------------------------------------- CASE 15
  {
    n: 15, desc: 'Human takeover — AI ngừng auto-send, nhân viên gửi được, job AI bị hủy sạch',
    fn() {
      const app = new App({ dataDir: path.join(DATA, 'case-15') });
      msg(app, FB, 'fb-c15', 'nến vanilla giá bao nhiêu?');
      app.drain();
      const aiOutBefore = outMsgs(app, 'fb-c15').filter(m => m.sender === 'ai').length;
      assert.ok(aiOutBefore >= 1);

      const conv = convOf(app, 'fb-c15');
      // giả lập 1 job AI đang QUEUED của hội thoại
      // SỬA LẦN 2: kind đổi 'check_send_receipt' -> 'process_event'. Lý do: check_send_receipt/
      // reconcile_shipment là job ĐỐI CHỨNG (không tự gửi tin) — takeover KHÔNG được hủy chúng
      // (trước đây hủy sạch khiến exec TIMEOUT_UNKNOWN mất đường tra receipt — bug đã sửa ở
      // takeover.js). Job loại AI (process_event theo schema AI3) mới là thứ takeover phải hủy.
      app.store.insert('jobs', {
        job_id: 'job-fake-15', kind: 'process_event', payload_json: '{}', status: 'QUEUED',
        run_at: new Date(app.clock.now() + 3600e3).toISOString(), attempts: 0, max_attempts: 3,
        idempotency_key: null, last_error: null, conversation_id: conv.conversation_id,
        created_at: app.store.now(), updated_at: app.store.now(),
      });

      app.takeover.setTakeover(conv, 'op1', 'operator_request');
      const takeoverAudit = auditFor(app, 'fb-c15').find(a => a.proposed_action === 'TAKEOVER');
      assert.ok(takeoverAudit, 'audit ghi takeover (ai, lúc nào)');
      assert.strictEqual(conv.mode, 'HUMAN');
      // P3C (BL-5 — SỬA TEST CÓ LÝ DO): assertion cũ "jobs QUEUED = 0" đếm CẢ job đối chứng
      // check_send_receipt mà P3C hẹn sau mỗi tin accepted để đối chứng outbound_pending khi
      // webhook receipt thất lạc. Job này thuộc whitelist NOT_CANCELLABLE_BY_TAKEOVER theo
      // thiết kế P3A (invariants vùng 2a assert nó SURVIVE takeover) — không phải job AI xử lý.
      assert.strictEqual(app.store.findAll('jobs', j => j.conversation_id === conv.conversation_id && j.status === 'QUEUED' && j.kind === 'process_event').length, 0, 'jobs AI (process_event) QUEUED bị hủy sạch');

      msg(app, FB, 'fb-c15', 'còn hàng không shop?');
      app.drain();
      const aiOut = outMsgs(app, 'fb-c15').filter(m => m.sender === 'ai');
      assert.strictEqual(aiOut.length, aiOutBefore, 'sau takeover KHÔNG có tin sender=ai mới');
      assert.ok(app.store.findAll('ai_proposals', p => p.conversation_id === conv.conversation_id && p.decision === 'HOLD_FOR_AGENT').length >= 1, 'AI chỉ soạn nháp cho nhân viên');

      const cus = cusOf(app, 'fb-c15');
      const sent = app.takeover.agentSend(app.gate, conv, cus, 'Dạ em là nhân viên shop, nến vanilla M đỏ vẫn còn 3 cái nha anh!', 'op1');
      assert.ok(sent.sent, 'tin nhân viên gửi được qua gate (mode HUMAN, actor người)');
      const agentMsg = app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.sender === 'human_agent');
      assert.strictEqual(agentMsg.length, 1, 'tin sender=human_agent trong messages');
    },
  },

  // ---------------------------------------------------------- CASE 16
  {
    n: 16, desc: 'Nhân viên trả quyền — AI propose lại, state giữ nguyên, không mâu thuẫn lời nhân viên',
    fn() {
      const app = new App({ dataDir: path.join(DATA, 'case-16') });
      const order = buyAndConfirm(app, 'fb-c16');
      const conv = convOf(app, 'fb-c16');
      assert.strictEqual(conv.state, 'ORDERED');
      app.takeover.setTakeover(conv, 'op1', 'operator_request');
      app.takeover.agentSend(app.gate, conv, cusOf(app, 'fb-c16'), `Đơn anh đã xác nhận rồi nhé, mã ${order.order_code} sẽ được gửi trong hôm nay ạ.`, 'op1');

      app.takeover.handback(conv, 'op1');
      assert.strictEqual(conv.mode, 'AI', 'mode về AI');
      assert.strictEqual(conv.state, 'ORDERED', 'state KHÔNG reset về NEW_LEAD');
      const proposedBefore = auditFor(app, 'fb-c16').filter(a => a.stage === 'PROPOSED').length;

      msg(app, FB, 'fb-c16', 'ok cảm ơn nhé');
      app.drain();

      const proposedAfter = auditFor(app, 'fb-c16').filter(a => a.stage === 'PROPOSED').length;
      assert.ok(proposedAfter > proposedBefore, 'AI propose lại (audit PROPOSED mới)');
      const outs = outMsgs(app, 'fb-c16');
      const last = outs[outs.length - 1];
      assert.strictEqual(last.sender, 'ai');
      assert.ok(last.text_content.includes(order.order_code), 'AI tham chiếu đúng ngữ cảnh sau can thiệp người (mã đơn nhân viên vừa xác nhận)');
      assert.ok(last.text_content.includes(order.status), 'không mâu thuẫn: trạng thái đọc từ order DB');
    },
  },

  // ---------------------------------------------------------- CASE 17
  {
    // P3C (BL-1 — SỬA TEST CÓ LÝ DO, đúng ví dụ của lệnh P3C): follow-up +2 ngày trên
    // Messenger THẬT nằm NGOÀI cửa sổ 24h — bản cũ PASS vì mock không mô hình hoá window
    // (đúng cảnh báo BL-1 của BAO-CAO-HOI-DONG-V2: "case 17 đang PASS trong lab sẽ FAIL trên
    // Messenger thật"). Hành vi đúng theo gate mới: đến hẹn khi window đóng -> HELD
    // (đợi khách nhắn lại — điều kiện đóng BL-1), KHÔNG tự gửi; khách nhắn lại -> window mở
    // lại -> follow-up gửi ĐÚNG 1 lần và chỉ SENT khi CÓ receipt (BL-7/BL-5).
    n: 17, desc: 'Follow-up sau giao hàng — +2 ngày ngoài window FB -> HELD; khách nhắn lại -> gửi đúng 1 lần (có receipt)',
    fn() {
      const app = new App({ dataDir: path.join(DATA, 'case-17') });
      const order = buyAndConfirm(app, 'fb-c17');
      const shipment = app.store.findOne('shipments', s => s.order_id === order.order_id);
      assert.ok(shipment, 'vận đơn đã tạo');

      app.carrier.setStatus(shipment.tracking_number, 'DELIVERED'); // mock ĐVVC báo giao
      const r1 = app.pipeline.onCarrierStatus(order.order_id);
      const r2 = app.pipeline.onCarrierStatus(order.order_id); // gọi 2 lần vẫn idempotent
      assert.strictEqual(r1.status, 'DELIVERED');
      const fus = app.store.findAll('follow_ups', f => f.order_id === order.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
      assert.strictEqual(fus.length, 1, 'follow_ups 1 dòng');
      assert.strictEqual(fus[0].status, 'SCHEDULED');
      const scheduledAt = Date.parse(fus[0].scheduled_at);
      assert.ok(scheduledAt - app.clock.now() <= 2 * 24 * 3600e3 + 1, 'hẹn +2 ngày');

      app.advance(2 * 24 * 3600e3 + 60e3); // đến hẹn — NGOÀI cửa sổ 24h của tin cuối của khách
      let fu = app.store.findOne('follow_ups', f => f.order_id === order.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
      assert.strictEqual(fu.status, 'HELD', 'ngoài window 24h FB -> HELD, KHÔNG tự gửi (BL-1)');
      assert.strictEqual(fu.cancel_reason, 'fb_window_closed');
      assert.strictEqual(app.store.findAll('messages', m => m.msg_kind === 'care').length, 0, 'window đóng: 0 tin care đi ra');

      // Khách nhắn lại -> cửa sổ mở lại -> follow-up HELD được kích hoạt, gửi đúng 1 lần
      msg(app, FB, 'fb-c17', 'đã nhận được hàng, cám ơn shop nha');
      app.drain();
      fu = app.store.findOne('follow_ups', f => f.order_id === order.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
      assert.strictEqual(fu.status, 'SENT', 'khách nhắn lại (window mở) -> follow-up gửi + CÓ receipt -> SENT (BL-7)');
      assert.ok(Date.parse(app.store.findOne('messages', m => m.send_exec_id === fu.exec_id).created_at) >= scheduledAt - 60e3, 'gửi sau đúng hẹn (+- window)');
      const careMsgs = app.store.findAll('messages', m => m.msg_kind === 'care');
      assert.strictEqual(careMsgs.length, 1, 'tin follow-up đúng 1 lần');
      assert.strictEqual(careMsgs[0].delivery_status, 'DELIVERED', 'tin care có receipt -> DELIVERED (BL-5)');
      const op17 = app.store.findOne('outbound_pending', o => o.exec_id === fu.exec_id);
      assert.ok(op17 && op17.receipt_status === 'DELIVERED', 'outbound_pending DELIVERED theo receipt');

      app.advance(24 * 3600e3); // chạy thêm: không gửi nốt lần 2
      assert.strictEqual(app.store.findAll('messages', m => m.msg_kind === 'care').length, 1, 'không có tin follow-up thứ 2');
      const audit = app.store.findAll('audit_events', a => a.proposed_action === 'FOLLOW_UP:AFTER_DELIVERY_FEEDBACK' && a.stage === 'VERIFIED');
      assert.ok(audit.length >= 1, 'audit đủ chuỗi cho tin follow-up');
    },
  },

  // ---------------------------------------------------------- CASE 18
  {
    n: 18, desc: 'Từ chối marketing — opt-out chặn marketing, tin transactional vẫn đi',
    fn() {
      const app = new App({ dataDir: path.join(DATA, 'case-18') });
      const order = buyAndConfirm(app, 'fb-c18');
      app.store.insert('follow_ups', {
        follow_up_id: 'fu-mkt-18', order_id: order.order_id, conversation_id: order.conversation_id,
        customer_id: order.customer_id, kind: 'MARKETING',
        scheduled_at: new Date(app.clock.now() + 3600e3).toISOString(),
        status: 'SCHEDULED', cancel_reason: null, exec_id: null,
        created_at: app.store.now(), updated_at: app.store.now(),
      });

      msg(app, FB, 'fb-c18', 'đừng nhắn quảng cáo cho tôi nữa');
      app.drain();

      const cus = cusOf(app, 'fb-c18');
      assert.strictEqual(cus.marketing_opt_out, 1, 'cờ DB marketing_opt_out=1');
      assert.ok(cus.opt_out_at, 'opt_out_at được ghi');
      const fu = app.store.findOne('follow_ups', f => f.follow_up_id === 'fu-mkt-18');
      assert.strictEqual(fu.status, 'CANCELLED', 'follow-up marketing SCHEDULED -> CANCELLED');
      assert.strictEqual(fu.cancel_reason, 'opt_out');
      assert.ok(auditFor(app, 'fb-c18').some(a => a.proposed_action === 'OPT_OUT_MARKETING'), 'audit ghi event opt-out');

      // đề case 17 lại với customer này: job marketing đến hẹn -> AUTHORIZE chặn
      app.store.insert('follow_ups', {
        follow_up_id: 'fu-mkt-18b', order_id: order.order_id, conversation_id: order.conversation_id,
        customer_id: order.customer_id, kind: 'MARKETING',
        scheduled_at: new Date(app.clock.now() + 60e3).toISOString(),
        status: 'SCHEDULED', cancel_reason: null, exec_id: null,
        created_at: app.store.now(), updated_at: app.store.now(),
      });
      const outBefore = outMsgs(app, 'fb-c18').length;
      app.advance(2 * 3600e3);
      const fu2 = app.store.findOne('follow_ups', f => f.follow_up_id === 'fu-mkt-18b');
      assert.strictEqual(fu2.status, 'CANCELLED', 'job đến hẹn bị AUTHORIZE chặn');
      assert.strictEqual(fu2.cancel_reason, 'opt_out');
      assert.strictEqual(outMsgs(app, 'fb-c18').length, outBefore, 'KHÔNG có tin marketing đi ra');
      assert.ok(app.metric('gate_rejected_opt_out') >= 1, 'metric gate_rejected_opt_out++');

      // tin transactional (hỏi trạng thái đơn đang chạy) vẫn được phép
      msg(app, FB, 'fb-c18', 'đơn của mình sao rồi?');
      app.drain();
      const outs = outMsgs(app, 'fb-c18');
      assert.ok(outs.length > outBefore, 'tin transactional vẫn đi được');
      assert.ok(outs[outs.length - 1].text_content.includes(order.order_code), 'nội dung transactional từ order DB');
    },
  },
];

// ============================================================ HARNESS
function main() {
  fs.mkdirSync(DATA, { recursive: true });
  const rows = [];
  let pass = 0;
  for (const c of CASES) {
    const started = Date.now();
    try {
      c.fn();
      pass += 1;
      rows.push({ n: c.n, desc: c.desc, status: 'PASS', note: `${Date.now() - started}ms` });
      console.log(`  [PASS] case ${String(c.n).padStart(2)} — ${c.desc}`);
    } catch (err) {
      rows.push({ n: c.n, desc: c.desc, status: 'FAIL', note: String(err && err.message).split('\n')[0] });
      console.log(`  [FAIL] case ${String(c.n).padStart(2)} — ${c.desc}\n         -> ${String(err && err.message).split('\n').slice(0, 3).join(' | ')}`);
    }
  }

  console.log('\n================= KẾT QUẢ 18 CASE =================');
  console.log('#'.padEnd(4) + 'KẾT QUẢ'.padEnd(9) + 'MÔ TẢ'.padEnd(76) + 'GHI CHÚ');
  console.log('-'.repeat(120));
  for (const r of rows) {
    console.log(String(r.n).padEnd(4) + r.status.padEnd(9) + r.desc.slice(0, 74).padEnd(76) + r.note.slice(0, 40));
  }
  console.log('-'.repeat(120));
  console.log(`TỔNG: ${pass}/18 PASS, ${18 - pass} FAIL`);
  console.log(pass === 18 ? '==> 18/18 — HỆ THỐNG ĐẠT.' : '==> CHƯA ĐẠT, cần sửa các case FAIL phía trên.');
  process.exitCode = pass === 18 ? 0 : 1;
}

main();
