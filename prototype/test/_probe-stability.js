'use strict';
// test/_probe-stability.js — PROBE TÁI HIỆN (BEFORE) cho gate SURI-STABILITY:
//   LOI 2 — đường LLM chặn xử lý (sync blocking): inject httpFn chậm 3s vào propose,
//           đo event loop bằng setInterval(20ms) — gap tick = ms event loop bị block.
//   LOI 3 — guard tiền thiếu số KHÔNG đơn vị: subject nến vanilla 185000/165000,
//           proposal chứa "giá 92500" (bare) và "92.5k" — cả 2 đường PRICE và bill/tổng tiền.
// KHÔNG sửa code — chỉ đo và in bằng chứng. Output: stdout (lưu vào docs/STABILITY-TRACE/).

const path = require('path');
const { App } = require('../src/app');
const aiProvider = require('../src/ai-provider');

const DATA = path.join(__dirname, '..', 'data', 'test-runs');
const out = [];
const P = (...a) => { const l = a.join(' '); out.push(l); console.log(l); };

function newApp(name, aiHttpFn) {
  const app = new App({ dataDir: path.join(DATA, 'probe-stab-' + name), aiHttpFn });
  // Bật LLM path với key giả (httpFn được tiêm — không ra mạng)
  aiProvider.saveAiConfig(app.settings, { provider: 'deepseek', api_key: 'sk-probe-key-1234', timeout: 20000 });
  return app;
}

const fire = (app, ref, text, pid) => {
  app.receive({
    channel: 'facebook', type: 'message', platformEventId: pid,
    payload: { customer_ref: ref, thread_id: ref, kind: 'text', text, platform_message_id: 'pm-' + pid },
  });
  app.drain();
};
const convOf = (app, ref) => app.store.findOne('conversations', c => c.platform_thread_id === ref);
const outMsgs = (app, ref) => {
  const conv = convOf(app, ref);
  return conv ? app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'out') : [];
};

// ================================================================= LOI 2
async function probeLoi2() {
  P('================= LOI 2 — SYNC BLOCKING TRÊN ĐƯỜNG LLM =================');
  // httpFn giả: block ĐỒNG BỘ 3s (busy-wait — giống spawnSync chờ curl) rồi trả LLM response hợp lệ
  const slowHttp = ({ timeoutMs }) => {
    const until = Date.now() + 3000;
    // eslint-disable-next-line no-empty
    while (Date.now() < until) { /* blocking — mô phỏng spawnSync curl của live-http.js */ }
    return {
      ok: true, status: 200,
      bodyText: JSON.stringify({ choices: [{ message: { content: 'Dạ nến vanilla size M giá 185.000đ ạ.' } }] }),
    };
  };
  const app = newApp('loi2', slowHttp);

  // Đo event loop: setInterval 20ms — nếu bị block, gap giữa 2 tick >= thời gian block
  let last = Date.now();
  let maxGap = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    if (now - last > maxGap) maxGap = now - last;
    last = now;
  }, 20);

  const t0 = Date.now();
  fire(app, 'cv-l2', 'nến vanilla size M giá bao nhiêu vậy shop', 'probe-l2-1');
  const wall = Date.now() - t0;
  // nhường event loop chạy nốt các tick tick tick BỊ ĐÓNG BẮT trong lúc block —
  // callback setInterval đến hạn trong 3s block sẽ chạy SAU khi block thả (đó chính là bằng chứng)
  await new Promise(r => setTimeout(r, 50));
  clearInterval(timer);

  const outs = outMsgs(app, 'cv-l2');
  P(`wall-time của 1 tin khách (gồm propose LLM): ${wall}ms`);
  P(`max gap giữa 2 tick setInterval(20ms): ${maxGap}ms`);
  P(`kết luận: event loop bị block >= ${maxGap}ms (tick 20ms phải way hơn nhiều nếu không block)`);
  P(`bot vẫn trả lời (engine=${app.ai.lastEngine}): ${outs.length ? 'CÓ' : 'KHÔNG'} — "${(outs[0] && outs[0].text_content || '').slice(0, 60)}"`);
  P('Chổ chặn (đã đọc code):');
  P('  - src/live-http.js:39  spawnSync("curl", args, {timeout}) — GỌI ĐỒNG BỘ, chặn event loop suốt thời gian curl chạy');
  P('  - src/sales-ai.js:160-167  http = this.httpFn || httpOnce; res = http({... timeoutMs: cfg.timeout || 20000}) — propose giữ SYNC');
  P('  - src/sales-ai.js:124  propose(intent, ctx) — hợp đồng SYNC (pipeline gọi trực tiếp tại src/pipeline.js:413/433/477)');
  P('Worst case hiện tại: timeout LLM mặc định 20000ms (src/ai-provider.js getAiConfig: ai_timeout || 20000;');
  P('  src/sales-ai.js:167 timeoutMs: cfg.timeout || 20000) -> 1 tin khách có thể chặn event loop tới 20s;');
  P('  saveAiConfig cho phép đặt tới 120000ms (ai-provider.js: BAD_TIMEOUT check 1000..120000).');
}

// ================================================================= LOI 3
async function probeLoi3() {
  P('================= LOI 3 — GUARD TIỀN THIẾU SỐ KHÔNG ĐƠN VỊ =================');
  // App KHÔNG cấu hình AI (stub, 0 mạng) — bắn 1 tin thật để conv/customer/channel_state là row THẬT
  // (guard phải được đo trên row store thật, không phải object giả — nếu không authorize sẽ REJECT oan).
  const app = newApp('loi3', null);
  fire(app, 'probe-l3', 'nến vanilla size M đỏ còn không shop', 'probe-l3-0');
  const conv = convOf(app, 'probe-l3');
  conv.subject_sku = 'NT-VANILLA-M-DO';
  const customer = app.store.findOne('customers', c => c.platform_ref === 'probe-l3');
  const product = app.productDB.getProductByBase('NT-VANILLA');
  P('subject: nến vanilla — variants DB: ' + product.variants.map(v => `${v.sku}=${v.price}`).join(', '));

  const facts = {
    subjectProduct: { name: 'Nến thơm vanilla', sku: 'NT-VANILLA' },
    variants: product.variants.map(v => ({ sku: v.sku, size: v.size, color: v.color, price: v.price, effective: 5 })),
  };
  let evtN = 0;
  function send(intent, text, extra = {}) {
    evtN += 1;
    const event = { event_id: `facebook:probe-l3-evt-${evtN}`, payload: { platform_message_id: 'pm-l3-' + evtN } };
    const proposal = Object.assign({
      intent, text, confidence: 0.85, engine: 'deepseek',
      evidence: { source: 'ai_provider:deepseek', facts_source: 'product_db' },
      facts,
    }, extra);
    const before = app.store.findAll('ai_proposals', p => p.conversation_id === conv.conversation_id).length;
    const r = app.gate.sendReply({ conversation: conv, customer, event, proposal });
    const prp = app.store.findAll('ai_proposals', p => p.conversation_id === conv.conversation_id)[before]; // proposal của lần này
    return { r, validation: prp && prp.validation_json ? JSON.parse(prp.validation_json) : null };
  }

  // ---- ĐƯỜNG 1: reply tư vấn (PRICE) ----
  P('--- Đường PRICE (intent tiền — đã có bare-scan từ P3C?) ---');
  const a = send('PRICE', 'Dạ bên em đang có GIÁ SỐC chỉ 92500 cho nến vanilla size M đỏ nha anh/chị ạ!');
  P(`A1 "giá 92500" (không đơn vị): decision=${a.r.decision} sent=${a.r.sent} bad_money=${JSON.stringify(a.validation && a.validation.bad_money)} -> ${a.r.decision === 'OVERRIDDEN' ? 'BỊ ĐÈ (guard ăn)' : '*** LỌT ra khách (guard lọt)'}`);
  const b = send('PRICE', 'Dạ chỉ còn 92.5k thôi anh/chị ơi, mua ngay đi ạ!');
  P(`A2 "92.5k":                  decision=${b.r.decision} sent=${b.r.sent} bad_money=${JSON.stringify(b.validation && b.validation.bad_money)} -> ${b.r.decision === 'OVERRIDDEN' ? 'BỊ ĐÈ (guard ăn)' : '*** LỌT ra khách (guard lọt)'}`);

  // ---- ĐƯỜNG 2: bill/tổng tiền (intent KHÔNG phải tiền — ORDER_DRAFT/ORDER_CONFIRMED) ----
  P('--- Đường bill/tổng tiền (intent khác PRICE: bare-scan hiện KHÔNG chạy?) ---');
  const orderMoney = [145000 + 25000, 145000, 25000]; // total, subtotal, fee của đơn giả định
  const c = send('ORDER_DRAFT', 'Dạ đơn của anh/chị như sau ạ:\n- 1 x Trà hoa sấy\nTổng tiền 92500 nha anh/chị (bare, không đơn vị, không khớp đơn).', { allowedMoney: orderMoney });
  P(`B1 bill "tổng tiền 92500":  decision=${c.r.decision} sent=${c.r.sent} bad_money=${JSON.stringify(c.validation && c.validation.bad_money)} -> ${c.r.decision === 'OVERRIDDEN' ? 'BỊ ĐÈ (guard ăn)' : '*** LỌT ra khách (guard lọt)'}`);
  const d = send('ORDER_CONFIRMED', 'Dạ đơn đã xác nhận, tổng còn 92.5k anh/chị nhé ạ!', { allowedMoney: orderMoney });
  P(`B2 bill "còn 92.5k":        decision=${d.r.decision} sent=${d.r.sent} bad_money=${JSON.stringify(d.validation && d.validation.bad_money)} -> ${d.r.decision === 'OVERRIDDEN' ? 'BỊ ĐÈ (guard ăn)' : '*** LỌT ra khách (guard lọt)'}`);
  const e2 = send('CHITCHAT', 'Dạ mẫu đó bên em có giá 92500 luôn anh/chị ạ!');
  P(`B3 CHITCHAT "giá 92500":    decision=${e2.r.decision} sent=${e2.r.sent} bad_money=${JSON.stringify(e2.validation && e2.validation.bad_money)} -> ${e2.r.decision === 'OVERRIDDEN' ? 'BỊ ĐÈ (guard ăn)' : '*** LỌT ra khách (guard lọt)'}`);

  // ---- Kiểm soát dương: số ĐÚNG (đơn vị đầy đủ) trên bill phải đi qua bình thường ----
  P('--- Kiểm soát: số ĐÚNG có đơn vị trên bill (phải KHÔNG bị đè) ---');
  const f = send('ORDER_DRAFT', 'Dạ đơn của anh/chị như sau ạ:\n- 1 x Trà hoa sấy: 145.000đ\nPhí ship: 25.000đ\nTổng cộng: 170.000đ\nAnh/chị xác nhận giúp em nha ạ!', { allowedMoney: orderMoney });
  P(`C1 bill đúng 170.000đ:      decision=${f.r.decision} sent=${f.r.sent} -> ${f.r.decision === 'AUTO_EXECUTED' ? 'ĐI BÌNH THƯỜNG (đúng)' : '*** BỊ ĐÈ OAN (false positive)'}`);

  P('GHÍ CHÚ: raw text khớp những gì khách nhận được khi decision=AUTO_EXECUTED (text không đổi).');
}

(async () => {
  await probeLoi2();
  await probeLoi3();
  P('================= PROBE DONE =================');
  process.exit(0);
})();
