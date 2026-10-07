'use strict';
// test/f1-facts-stale.js — SURI CLOSURE F1 (JEV LOW-1): FACTS STALE LÚC LLM CHỜ.
//
// Tái hiện: đường LLM async (production) chụp FACTS lúc propose; trong lúc chờ, DB đổi —
//   (a) giá variant subject đổi   -> lời cũ mang giá cũ (trước đây: money guard đè bằng render
//                                    TỪ SNAPSHOT CŨ -> khách vẫn nhận giá hết hiệu lực);
//   (b) tồn đổi còn-hàng -> hết   -> lời cũ bảo "còn hàng" khi DB đã hết;
//   (c) subject bị tắt (enabled=false) -> bot vẫn tư vấn SP đã ẩn khỏi bán.
// Vá: pipeline._freshFactsReply (chạy TRONG continuation TRƯỚC gate.sendReply) — so snapshot
// với DB tươi NGAY LÚC GỬI; lệch -> KHÔNG gửi lời cũ: render câu CHÍNH THỨC từ DB tươi
// (gate.renderValidated — cùng cơ chế gate render) hoặc câu an toàn + NEEDS_HUMAN.
//
// Chạy: node test/f1-facts-stale.js — exit 0 khi toàn bộ PASS. Offline: LLM mock cầm promise
// (hold) qua aiAsyncHttpFn tiêm — không ra mạng. Mock trả câu ECHO SNAPSHOT (đọc FACTS trong
// system prompt của request) => nếu lời cũ lọt ra khách thì chắc chắn chứa giá/tồn CŨ.

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { App } = require('../src/app');
const aiProvider = require('../src/ai-provider');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data', 'test-runs');

const RESULTS = [];
async function T(id, desc, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    RESULTS.push({ id, ok: true });
    console.log(`  [PASS] ${id} — ${desc} (${Date.now() - t0}ms)${note ? ' :: ' + note : ''}`);
  } catch (e) {
    RESULTS.push({ id, ok: false, err: String(e && e.message) });
    console.log(`  [FAIL] ${id} — ${desc}\n         -> ${String(e && e.message).split('\n').slice(0, 3).join(' | ')}`);
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let seq = 0;
function fireDrain(app, ref, text) {
  seq += 1;
  app.receive({
    channel: 'facebook', type: 'message',
    platformEventId: `f1-${ref}-${seq}`,
    payload: { customer_ref: ref, thread_id: ref, kind: 'text', text, platform_message_id: `f1pm-${seq}` },
  });
  app.drain();
}
const convOf = (app, ref) => app.store.findOne('conversations', c => c.platform_thread_id === ref);
const outMsgs = (app, ref) => {
  const c = convOf(app, ref);
  return c ? app.store.findAll('messages', m => m.conversation_id === c.conversation_id && m.direction === 'out') : [];
};
const lastProposal = (app, ref) => {
  const c = convOf(app, ref);
  return c ? app.store.findAll('ai_proposals', p => p.conversation_id === c.conversation_id).pop() : null;
};

// Mock LLM: cầm promise (hold) — trả câu ECHO từ FACTS TRONG REQUEST (snapshot lúc propose).
// Mọi con số trong câu trả lời đều lấy từ snapshot => nếu snapshot stale mà câu này lọt ra
// khách thì assert bắt được chắc chắn.
function holdableEchoMock({ hold }) {
  const calls = [];
  const fn = async req => {
    calls.push(req);
    await hold.promise;
    const body = JSON.parse(String(req.body || '{}'));
    const sys = String((body.messages || [{ content: '' }])[0].content || '');
    const name = (sys.match(/Sản phẩm khách đang hỏi: (.+)/) || [])[1] || 'sản phẩm';
    const prices = [...sys.matchAll(/(\d{4,6})đ/g)].map(m => m[1]);
    const stocks = [...sys.matchAll(/còn (\d+)/g)].map(m => m[1]);
    const priceList = prices.length ? prices.map(p => p + 'đ').join(' và ') : 'giá đang cập nhật';
    const stockNote = stocks.length ? ` bên em còn ${stocks[0]} cái` : '';
    return {
      ok: true, status: 200,
      bodyText: JSON.stringify({
        choices: [{ message: { content: `Dạ ${name} ${priceList}${stockNote} nha anh/chị ạ!` } }],
      }),
    };
  };
  return { fn, calls };
}

function newApp(name, asyncHttpFn) {
  const dir = path.join(DATA, name);
  fs.rmSync(dir, { recursive: true, force: true });
  const app = new App({ dataDir: dir, aiAsyncHttpFn: asyncHttpFn });
  aiProvider.saveAiConfig(app.settings, { provider: 'deepseek', api_key: 'sk-f1-facts-stale-0001' });
  return app;
}

// Chờ LLM call ĐANG chờ (đã vào hàm mock) — đảm bảo mutation DB xảy ra TRONG cửa sổ chờ.
async function waitPending(calls, n = 1) {
  const t0 = Date.now();
  while (calls.length < n && Date.now() - t0 < 3000) await sleep(10);
  assert.strictEqual(calls.length, n, 'mock LLM phải nhận đủ ' + n + ' call trong lúc chờ');
  await sleep(30); // cho pipeline kịp đi vào await (đúng cửa sổ chờ)
}
// Chờ reply gửi ra (continuation đã chạy xong qua gate).
async function waitOut(app, ref, before, timeoutMs = 5000) {
  const t0 = Date.now();
  while (outMsgs(app, ref).length <= before && Date.now() - t0 < timeoutMs) await sleep(15);
  return outMsgs(app, ref);
}

(async () => {
  console.log('== SURI CLOSURE F1 — FACTS STALE LÚC LLM CHỜ ==');

  // ---------------------------------------------------------- F1-A: GIÁ ĐỔI giữa chờ
  await T('F1-A', 'đổi giá variant subject giữa chờ -> reply PHẢI mang giá MỚI từ DB, KHÔNG giá cũ', async () => {
    const hold = {};
    let release;
    hold.promise = new Promise(r => { release = r; });
    const mock = holdableEchoMock({ hold });
    const app = newApp('f1-price-drift', mock.fn);
    fireDrain(app, 'fa', 'nến vanilla giá bao nhiêu vậy shop');
    await waitPending(mock.calls, 1);
    // ĐỔI GIÁ TRONG LÚC CHỜ (operator sửa catalogue — cùng đường product-overrides API)
    const hit = app.productDB.getVariant('NT-VANILLA-S');
    assert.strictEqual(hit.variant.price, 165000, 'giá trước đổi phải là 165000 (seed)');
    hit.variant.price = 199000;
    release();
    const outs = await waitOut(app, 'fa', 0);
    const text = outs[outs.length - 1].text_content || '';
    assert.ok(/199000/.test(text), 'reply PHẢI chứa giá MỚI 199000 từ DB tươi: ' + text);
    assert.ok(!/165000/.test(text), 'reply KHÔNG được chứa giá CŨ 165000 (snapshot stale): ' + text);
    // evidence ghi rõ facts bị superseded (audit có cấu trúc cho đối soát)
    const prp = lastProposal(app, 'fa');
    const ev = JSON.parse(prp.evidence_json || '{}');
    assert.strictEqual(ev.facts_superseded, 'price_changed', 'proposal ghi facts_superseded=price_changed');
    assert.strictEqual(prp.decision, 'AUTO_EXECUTED', 'render từ DB tươi -> AUTO_EXECUTED (số khớp whitelist)');
    return 'reply: ' + text.replace(/\n/g, ' | ').slice(0, 90);
  });

  // ---------------------------------------------------------- F1-B: CÒN-HÀNG -> HẾT giữa chờ
  await T('F1-B', 'tồn subject đổi còn-hàng -> hết-hàng giữa chờ -> reply phải báo HẾT HÀNG, không "còn 8"', async () => {
    const hold = {};
    let release;
    hold.promise = new Promise(r => { release = r; });
    const mock = holdableEchoMock({ hold });
    const app = newApp('f1-stock-drift', mock.fn);
    assert.strictEqual(app.productDB.effectiveStock('NT-VANILLA-S'), 8, 'tồn trước đổi = 8');
    fireDrain(app, 'fb', 'nến vanilla còn hàng không shop');
    await waitPending(mock.calls, 1);
    app.productDB.setStock('NT-VANILLA-S', 0); // bán kênh khác / admin điều chỉnh trong lúc chờ
    assert.strictEqual(app.productDB.effectiveStock('NT-VANILLA-S'), 0, 'tồn sau đổi = 0');
    release();
    const outs = await waitOut(app, 'fb', 0);
    const text = outs[outs.length - 1].text_content || '';
    assert.ok(/hết hàng/i.test(text), 'reply PHẢI báo hết hàng theo DB tươi: ' + text);
    assert.ok(!/còn 8/.test(text), 'reply KHÔNG được còn nói "còn 8" (snapshot stale): ' + text);
    const prp = lastProposal(app, 'fb');
    const ev = JSON.parse(prp.evidence_json || '{}');
    assert.strictEqual(ev.facts_superseded, 'stock_out', 'proposal ghi facts_superseded=stock_out');
    return 'reply: ' + text.replace(/\n/g, ' | ').slice(0, 90);
  });

  // ---------------------------------------------------------- F1-C: SUBJECT BỊ TẮT giữa chờ
  await T('F1-C', 'subject bị DISABLED giữa chờ -> KHÔNG tư vấn SP đó nữa: câu an toàn + NEEDS_HUMAN', async () => {
    const hold = {};
    let release;
    hold.promise = new Promise(r => { release = r; });
    const mock = holdableEchoMock({ hold });
    const app = newApp('f1-disabled', mock.fn);
    fireDrain(app, 'fc', 'nến vanilla giá bao nhiêu vậy shop');
    await waitPending(mock.calls, 1);
    app.productDB.getProduct('prd_nt_vanilla').enabled = false; // shop ẩn SP khỏi bán trong lúc chờ
    release();
    const outs = await waitOut(app, 'fc', 0);
    const text = outs[outs.length - 1].text_content || '';
    assert.ok(!/vanilla/i.test(text), 'KHÔNG tư vấn SP đã tắt (không nhắc tên): ' + text);
    assert.ok(!/\d{4,6}\s*đ|\d{5,6}/.test(text), 'KHÔNG kèm con số giá nào: ' + text);
    assert.ok(text.length > 10, 'khách vẫn nhận 1 tin an toàn: ' + text.slice(0, 80));
    const prp = lastProposal(app, 'fc');
    const ev = JSON.parse(prp.evidence_json || '{}');
    assert.strictEqual(ev.facts_superseded, 'subject_disabled_or_gone', 'proposal ghi facts_superseded');
    assert.strictEqual(prp.decision, 'NEEDS_HUMAN', 'lệch lớn -> NEEDS_HUMAN (thấy ' + prp.decision + ')');
    const wl = app.store.findAll('worklist', w => w.conversation_id === convOf(app, 'fc').conversation_id);
    assert.ok(wl.length >= 1, 'worklist đã đẩy cho nhân viên');
    return 'reply an toàn + worklist=' + wl.length;
  });

  // ---------------------------------------------------------- F1-D: KHÔNG LỆCH -> nguyên trạng
  await T('F1-D', 'KHÔNG đổi DB giữa chờ -> lời LLM nguyên trạng (guard không tự ý đè)', async () => {
    const hold = {};
    let release;
    hold.promise = new Promise(r => { release = r; });
    const mock = holdableEchoMock({ hold });
    const app = newApp('f1-no-drift', mock.fn);
    fireDrain(app, 'fd', 'nến vanilla giá bao nhiêu vậy shop');
    await waitPending(mock.calls, 1);
    release();
    const outs = await waitOut(app, 'fd', 0);
    const text = outs[outs.length - 1].text_content || '';
    assert.ok(/165000/.test(text), 'giá snapshot (đúng bằng DB) đi nguyên qua LLM: ' + text);
    const prp = lastProposal(app, 'fd');
    const ev = JSON.parse(prp.evidence_json || '{}');
    assert.ok(!ev.facts_superseded, 'không có facts_superseded khi DB không đổi');
    assert.strictEqual(app.ai.lastEngine, 'llm:deepseek', 'vẫn là lời LLM (không bị thay)');
    return 'LLM wording nguyên trạng';
  });

  // ---------------------------------------------------------- tổng
  const pass = RESULTS.filter(r => r.ok).length;
  console.log(`\nTỔNG: ${pass}/${RESULTS.length} PASS (F1 facts-stale)`);
  process.exit(pass === RESULTS.length ? 0 : 1);
})().catch(e => { console.error('HARNESS_ERROR:', e); process.exit(1); });
