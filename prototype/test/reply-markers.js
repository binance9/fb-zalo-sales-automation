'use strict';
// test/reply-markers.js — AICAKE (G4): unit splitReply/renderVars + integration nhiều tin.
//
// Unit: tách 3 khối `---`, quick reply có/không payload, postback, không marker = NO-OP,
//       biến {{TenKhachHang}} tên có/rỗng, `---` giữa câu KHÔNG tách.
// Integration: boot SERVER FACTORY port 0 + TEMP (đúng pattern test/matrix/_harness.js),
//       cấu hình LLM mock (aiHttpFn tiêm — offline 100%), seed tin khách có ý định mua
//       -> assert reply nhiều khối tạo NHIỀU MESSAGE LIÊN TIẾP trong conversation ĐÚNG THỨ TỰ,
//       metadata quick/postback lên message record, biến tên render; và reply cũ không marker
//       vẫn ĐÚNG 1 tin (no regression).
// Chạy: node test/reply-markers.js — in "reply-markers: X/X PASS", exit 0/1.

const assert = require('assert');
const path = require('path');
const { splitReply, renderVars, NAME_VAR } = require('../src/reply-markers');
const { startInst, setupShop, fire, sleep } = require('./matrix/_harness');

const groups = [];
function run(name, fn) { groups.push({ name, fn }); }

// ============================================================ UNIT
run('U1 splitReply: 3 khối --- -> 3 text đúng thứ tự', () => {
  const parts = splitReply('Chào anh/chị\n---\nNến thơm handmade còn sẵn nè\n---\nCần tư vấn cứ nhắn tin nha');
  assert.strictEqual(parts.length, 3);
  assert.deepStrictEqual(parts.map(p => p.kind), ['text', 'text', 'text']);
  assert.strictEqual(parts[0].label, 'Chào anh/chị');
  assert.strictEqual(parts[1].label, 'Nến thơm handmade còn sẵn nè');
  assert.strictEqual(parts[2].label, 'Cần tư vấn cứ nhắn tin nha');
});

run('U2 splitReply: quick reply có/không payload', () => {
  const withPayload = splitReply('[[Xem bảng giá|bang_gia]]');
  assert.strictEqual(withPayload.length, 1);
  assert.strictEqual(withPayload[0].kind, 'quick');
  assert.strictEqual(withPayload[0].label, 'Xem bảng giá');
  assert.strictEqual(withPayload[0].payload, 'bang_gia');
  const noPayload = splitReply('[[Mua ngay]]');
  assert.strictEqual(noPayload[0].kind, 'quick');
  assert.strictEqual(noPayload[0].label, 'Mua ngay');
  assert.strictEqual(noPayload[0].payload, 'Mua ngay'); // payload mặc định = label
  const emptyPayload = splitReply('[[Mua ngay|]]');
  assert.strictEqual(emptyPayload[0].payload, 'Mua ngay'); // payload rỗng -> fallback label
});

run('U3 splitReply: postback [[[Nhãn|payload]]] (và không payload)', () => {
  const pb = splitReply('[[[Đặt ngay|order_now]]]');
  assert.strictEqual(pb.length, 1);
  assert.strictEqual(pb[0].kind, 'postback');
  assert.strictEqual(pb[0].label, 'Đặt ngay');
  assert.strictEqual(pb[0].payload, 'order_now');
  const pbNo = splitReply('[[[Nhắc tôi sau]]]');
  assert.strictEqual(pbNo[0].kind, 'postback');
  assert.strictEqual(pbNo[0].payload, 'Nhắc tôi sau');
  // text quanh token GỘP thành 1 phần text của khối (đặt trước), token đẩy theo thứ tự
  const mixed = splitReply('A [[x|y]] B [[[z|w]]] C');
  assert.strictEqual(mixed.length, 3);
  assert.deepStrictEqual(mixed.map(p => p.kind), ['text', 'quick', 'postback']);
  assert.strictEqual(mixed[0].label, 'A\nB\nC');
  assert.strictEqual(mixed[1].label, 'x');
  assert.strictEqual(mixed[2].label, 'z');
});

run('U4 splitReply: KHÔNG marker -> 1 phần tử text NGUYÊN KHỐI (no-op)', () => {
  const raw = '  Dạ em kiểm tra giá giúp mình ngay ạ!\nHơi chờ chút nha  ';
  const parts = splitReply(raw);
  assert.strictEqual(parts.length, 1);
  assert.strictEqual(parts[0].kind, 'text');
  assert.strictEqual(parts[0].label, raw); // byte-identical — không trim, không đổi gì
  assert.strictEqual(splitReply('')[0].label, '');
});

run('U5 splitReply: --- GIỮA CÂU KHÔNG tách (chỉ dòng đơn lẻ)', () => {
  const parts = splitReply('giá nến 20k --- ship riêng tính nha');
  assert.strictEqual(parts.length, 1);
  assert.strictEqual(parts[0].kind, 'text');
});

run('U6 renderVars: biến tên CÓ/RỖNG + không biến = no-op', () => {
  assert.strictEqual(renderVars(`Chào ${NAME_VAR} nha`, { tenKhachHang: 'Lan' }), 'Chào Lan nha');
  assert.strictEqual(renderVars(`${NAME_VAR} ơi`, { tenKhachHang: '' }), 'bạn ơi'); // rỗng -> fallback
  assert.strictEqual(renderVars(`${NAME_VAR} ơi`, {}), 'bạn ơi');                   // thiếu -> fallback
  assert.strictEqual(renderVars(`${NAME_VAR} ơi`, { tenKhachHang: '   ' }), 'bạn ơi'); // whitespace -> fallback
  const s = 'Không có biến nào cả';
  assert.strictEqual(renderVars(s, { tenKhachHang: 'Lan' }), s); // no-op nguyên chuỗi
  assert.strictEqual(renderVars(null, {}), '');
});

// ============================================================ INTEGRATION (server factory port 0 + TEMP)
(async () => {
  let inst = null;
  let integErr = null;
  try {
    inst = await startInst('reply-markers');
    const { sid, shop, app } = await setupShop(inst, { goLive: true, email: 'owner-rm@matrix.vn' });
    void sid;

    // ---- cấu hình LLM MOCK (offline): provider ngoài + key + httpFn tiêm SYNC vào App ----
    // Reply LLM mô phỏng đúng chuẩn aicake: 3 khối --- (khối 2/3 có text + nút).
    const LLM_REPLY = [
      `Dạ em chào ${NAME_VAR} ạ, trà hoa sấy bên shop đang có sẵn ạ`,
      'Mình gửi bảng giá giúp mình nè\n[[Xem bảng giá]]',
      'Chốt đơn nhanh giúp em nha\n[[[Đặt ngay|order_now]]]',
    ].join('\n---\n');
    app.ai.httpFn = () => ({ // tiêm httpFn SYNC (regression sync path) — KHÔNG ra mạng
      ok: true, status: 200,
      bodyText: JSON.stringify({ choices: [{ message: { content: LLM_REPLY } }] }),
    });
    // bật đường LLM (provider ngoài + key; use_for_replies mặc định true — SURI P2)
    inst.settingsFor(shop).setMany({
      ai_provider: 'deepseek', ai_api_key: 'sk-test-replymarkers', ai_model: 'deepseek-chat',
      ai_use_for_replies: true, // setupShop đã tắt (chốt local matrix) — integration này cần đường LLM mock
    });

    const ref = 'fbuser-rm-1';
    // khách có TÊN để assert biến {{TenKhachHang}} render đúng
    fire(app, 'facebook', ref, 'chào shop', 'rm-seed-0');
    const conv = app.store.findOne('conversations', c => c.platform_thread_id === ref);
    assert.ok(conv, 'conversation tạo cho khách');
    const customer = app.store.findOne('customers', c => c.platform_ref === ref);
    app.store.transaction(() => app.store.updateRow('customers', customer, { full_name: 'Lan' }));

    // mốc số tin out CỦA CHÍNH conversation này trước khi seed tin mua
    const outsBefore = app.store.findAll('messages',
      m => m.conversation_id === conv.conversation_id && m.direction === 'out').length;

    // ---- seed tin khách có Ý ĐỊNH MUA (hỏi giá) -> LLM trả 3 khối -> 3 tin lần lượt ----
    fire(app, 'facebook', ref, 'trà hoa sấy giá bao nhiêu vậy shop', 'rm-buy-1');
    assert.strictEqual(app.ai.lastEngine.indexOf('llm:') === 0, true, 'reply đi đường LLM mock');

    const outs = app.store.findAll('messages',
      m => m.conversation_id === conv.conversation_id && m.direction === 'out');
    const news = outs.slice(outsBefore);
    // 3 khối: khối 1 = text; khối 2/3 = text + nút -> tổng 5 tin RIÊNG, đúng thứ tự khối
    assert.strictEqual(news.length, 5, 'reply 3 khối (2 khối có nút) -> 5 tin riêng liên tiếp');

    // ĐÚNG THỨ TỰ gửi: text render biến -> text khối 2 -> [Nhãn quick] -> text khối 3 -> [Nhãn postback]
    assert.strictEqual(news[0].text_content, 'Dạ em chào Lan ạ, trà hoa sấy bên shop đang có sẵn ạ');
    assert.strictEqual(news[1].text_content, 'Mình gửi bảng giá giúp mình nè');
    assert.strictEqual(news[2].text_content, '[Xem bảng giá]');
    assert.strictEqual(news[3].text_content, 'Chốt đơn nhanh giúp em nha');
    assert.strictEqual(news[4].text_content, '[Đặt ngay]');
    // cùng conversation, thứ tự ghi DB = thứ tự gửi
    for (let i = 1; i < news.length; i++) {
      assert.ok(String(news[i - 1].created_at) <= String(news[i].created_at), 'thứ tự thời gian tăng dần');
    }
    // metadata quick/postback LÊN MESSAGE RECORD (attachment_json) — trên ĐÚNG tin nút
    const metaQuick = JSON.parse(news[2].attachment_json || '{}');
    assert.deepStrictEqual(metaQuick.quick_replies, [{ label: 'Xem bảng giá', payload: 'Xem bảng giá' }]);
    const metaPb = JSON.parse(news[4].attachment_json || '{}');
    assert.deepStrictEqual(metaPb.postbacks, [{ label: 'Đặt ngay', payload: 'order_now' }]);
    assert.strictEqual(news[0].attachment_json, null, 'tin text thường không gắn metadata');
    assert.strictEqual(news[1].attachment_json, null, 'tin text khối 2 không gắn metadata');
    // biến đã render ở tầng gửi: KHÔNG còn {{TenKhachHang}} sót trong bất kỳ tin nào
    for (const m of news) assert.ok(!String(m.text_content || '').includes(NAME_VAR), 'đã render biến tên');

    // ---- REGRESSION: reply cũ KHÔNG marker -> vẫn ĐÚNG 1 tin, nguyên văn ----
    app.ai.httpFn = null; // tắt LLM mock -> stub không marker
    inst.settingsFor(shop).setMany({ ai_provider: 'local' });
    const conv2 = app.store.findOne('conversations', c => c.platform_thread_id === ref);
    const outsBefore2 = app.store.findAll('messages',
      m => m.conversation_id === conv2.conversation_id && m.direction === 'out').length;
    fire(app, 'facebook', ref, 'shop có nến thơm không ạ', 'rm-stub-1');
    const news2 = app.store.findAll('messages',
      m => m.conversation_id === conv2.conversation_id && m.direction === 'out').slice(outsBefore2);
    assert.strictEqual(news2.length, 1, 'reply stub không marker -> ĐÚNG 1 tin (no-op)');
    assert.ok(!String(news2[0].text_content || '').includes('---'), 'text stub nguyên vẹn không tách');
  } catch (err) {
    integErr = err;
  } finally {
    // integration là 1 NHÓM được đếm — boot đã chạy ở trên (await), nhóm chỉ báo kết quả
    run('I1 integration: server port 0 + LLM mock -> reply 3 khối tạo 5 tin đúng thứ tự + metadata nút + biến tên; reply cũ không marker vẫn 1 tin', () => {
      if (integErr) throw integErr;
    });
    let pass = 0;
    const fails = [];
    for (const g of groups) {
      try { g.fn(); pass += 1; console.log(`  PASS  ${g.name}`); } catch (e) {
        fails.push(g.name);
        console.error(`  FAIL  ${g.name}\n        ${e && e.message}`);
      }
    }
    const total = groups.length;
    console.log(`reply-markers: ${pass}/${total} PASS`);
    try { if (inst) await inst.close(); } catch (e) { /* ignore */ }
    await sleep(30);
    // eslint-disable-next-line no-process-exit
    process.exit(fails.length ? 1 : 0);
  }
})();
