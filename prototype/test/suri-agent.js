'use strict';
// test/suri-agent.js — SURI PHASE 1 (đợt P1): ORCHESTRATOR + TOOLS + SHOP PROFILE + ERROR UX/TZ.
//
// Phạm vi test (đề bài hạng mục TEST):
//   S1  Orchestrator: tin BUY -> AgentRun với steps UNDERSTAND -> DECISION -> SEND + audit đầy đủ
//       + persist qua store (restart giữ nguyên) + KHÔNG đổi hành vi trả lời (bill vẫn gửi).
//   S2  Orchestrator mode HUMAN -> decision SUPPRESSED_HUMAN_MODE, KHÔNG có step SEND.
//   S3  Orchestrator NEEDS_HUMAN (ảnh không match) -> run status NEEDS_HUMAN.
//   S4  Tool registry: >= 10 tool chạy thật (đọc loạt + create draft + confirm + cancel +
//       send qua gate + takeover/handback + follow-up + note), NOT_CONFIGURED khi GHN thiếu
//       token, TOOL_TIMEOUT, TOOL_UNKNOWN/INVALID_INPUT, dedupe idempotency, ToolCall ghi run.
//   S5  Shop profile: validate chặn secret + save + buildSystemPrompt chứa field + profile ĐÈ
//       prompt config cũ.
//   S6  Errors UX + TZ: map lỗi -> tiếng Việt; fmtVnTime +7; roundtrip giờ VN; timezone mặc định.
//   S7  DeepSeek wire: đọc file THẬT của chủ (mask assert — không in key).
//   S8  HTTP server: /api/agent/tools, /api/agent/runs(+detail), /api/shop-profile GET/POST,
//       /api/prompt merge profile, /api/settings timezone, /api/automation scheduled_at_vn.
// Exit 0 khi toàn bộ PASS.

const path = require('path');
const fs = require('fs');
const http = require('http');
const assert = require('assert');
const { App } = require('../src/app');
const { runTool, listTools, registerTool, unregisterTool, DEFS } = require('../src/agent/tools');
const { GhnAdapter } = require('../src/shipping/ghn-adapter');
const { ShopSettings } = require('../src/shop-settings');
const shopProfile = require('../src/shop-profile');
const { mergePromptConfig } = shopProfile;
const { buildSystemPrompt } = require('../src/prompt-builder');
const { friendlyError, fmtVnTime, vnWallClockToIso, DEFAULT_TIMEZONE } = require('../src/errors');
const { readDeepseekRule, wireDeepseek } = require('../src/deepseek-wire');
const { createServer } = require('../server');

const DATA = path.join(__dirname, '..', 'data', 'test-runs');
const FB = 'facebook';
const ZL = 'zalo';
const dir = name => path.join(DATA, 'suri-' + name);

let pid = 0;
function msg(app, channel, ref, text, extra = {}) {
  pid += 1;
  return app.receive({
    channel,
    type: 'message',
    platformEventId: extra.pid || `mid-suri-${ref}-${pid}`,
    payload: {
      customer_ref: ref,
      thread_id: extra.thread || ref,
      kind: extra.kind || 'text',
      text: text || '',
      media: extra.media,
      platform_message_id: `pm-suri-${pid}`,
    },
  });
}
const convOf = (app, ref) => app.store.findOne('conversations', c => c.platform_thread_id === ref);
const ctxOf = app => ({ app, recordToolCall: c => app.agent.recordToolCall(c) });

// ============================================================ harness
const RESULTS = [];
async function T(group, desc, fn) {
  const n = RESULTS.length + 1;
  const t0 = Date.now();
  try {
    await fn();
    RESULTS.push({ n, group, desc, ok: true, ms: Date.now() - t0, err: null });
    console.log(`  ${String(n).padStart(2)} PASS  [${group}] ${desc}  ${Date.now() - t0}ms`);
  } catch (e) {
    RESULTS.push({ n, group, desc, ok: false, ms: Date.now() - t0, err: e });
    console.log(`  ${String(n).padStart(2)} FAIL  [${group}] ${desc}  ${Date.now() - t0}ms\n      -> ${e && e.message}`);
  }
}

async function main() {
  console.log('== SURI AGENT (P1) — orchestrator + tools + shop profile + errors/TZ ==');

  // ------------------------------------------------------------ S1 ORCHESTRATOR
  await T('S1', 'BUY -> AgentRun: steps UNDERSTAND->DECISION->SEND + audit AGENT_RUN + bill vẫn gửi (hành vi nguyên)', async () => {
    const app = new App({ dataDir: dir('s1') });
    msg(app, FB, 'fb-s1', 'lấy 1 nến vanilla M đỏ, tên Suri Test, sdt 0901111222, địa chỉ 12 Nguyễn Trãi Q1 TP.HCM');
    app.drain();
    const run = app.store.findAll('agent_runs', r => r.customer_ref === 'fb-s1');
    assert.strictEqual(run.length, 1, 'đúng 1 AgentRun cho 1 tin');
    const r = run[0];
    assert.strictEqual(r.status, 'DONE', 'run DONE: ' + JSON.stringify(r.result));
    assert.strictEqual(r.decision, 'REPLY_VIA_GATE');
    const steps = app.store.findAll('agent_steps', s => s.run_id === r.run_id)
      .sort((a, b) => a.step_id.localeCompare(b.step_id));
    assert.deepStrictEqual(steps.map(s => s.type), ['UNDERSTAND', 'DECISION', 'SEND'], 'đủ 3 step đúng thứ tự');
    const stU = steps[0];
    assert.strictEqual(stU.input_ref, `event:${r.event_id}`, 'UNDERSTAND input_ref = event');
    assert.strictEqual(stU.output.intent, 'BUY');
    assert.ok(stU.output.order_id, 'UNDERSTAND output có order_id (draft đã tạo)');
    assert.strictEqual(steps[2].tool_calls.length, 1, 'SEND step ghi 1 gate send');
    assert.strictEqual(steps[2].tool_calls[0].tool, 'send_message');
    assert.ok(steps[2].tool_calls[0].status.startsWith('SENT'), 'gate gửi bill thành công');
    // audit đầy đủ
    const audits = app.store.findAll('audit_events', a => a.proposed_action === 'AGENT_RUN' && a.conversation_id === r.conversation_id);
    assert.ok(audits.length >= 1, 'audit AGENT_RUN có trong chuỗi audit JSONL');
    // hành vi trả lời KHÔNG đổi: khách nhận bill (tin out transactional)
    const conv = convOf(app, 'fb-s1');
    const outs = app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'out');
    assert.ok(outs.some(m => /Tổng cộng/.test(m.text_content || '')), 'khách vẫn nhận bill như trước orchestrator');
    // GET-side helper (cùng nguồn dữ liệu API đọc)
    assert.ok(app.agent.listRuns(10).some(x => x.run_id === r.run_id), 'listRuns thấy run');
    assert.strictEqual(app.agent.getRun(r.run_id).steps.length, 3, 'getRun trả đủ steps');
    global.__s1 = { app, run_id: r.run_id, dataDir: app.dataDir };
  });

  await T('S1b', 'Restart (App mới persist cùng dataDir) -> agent_runs/agent_steps GIỮ NGUYÊN', async () => {
    const { dataDir, run_id } = global.__s1;
    const app2 = new App({ dataDir, persist: true });
    const again = app2.store.findOne('agent_runs', r => r.run_id === run_id);
    assert.ok(again, 'run còn sau restart (persist qua store)');
    assert.strictEqual(app2.store.findAll('agent_steps', s => s.run_id === run_id).length, 3, 'steps còn đủ');
  });

  await T('S2', 'Mode HUMAN -> decision SUPPRESSED_HUMAN_MODE, KHÔNG step SEND (INV-5 quan sát được)', async () => {
    const app = new App({ dataDir: dir('s2') });
    msg(app, FB, 'fb-s2', 'xin chào shop');
    app.drain();
    app.takeover.setTakeover(convOf(app, 'fb-s2'), 'nv-test', 'ui_takeover');
    msg(app, FB, 'fb-s2', 'cho mình hỏi thêm chút');
    app.drain();
    const runs = app.store.findAll('agent_runs', r => r.customer_ref === 'fb-s2');
    const last = runs[runs.length - 1];
    assert.strictEqual(last.decision, 'SUPPRESSED_HUMAN_MODE', 'decision đúng');
    const steps = app.store.findAll('agent_steps', s => s.run_id === last.run_id).map(s => s.type);
    assert.ok(!steps.includes('SEND'), 'không có step SEND khi AI bị khoá gửi');
    assert.strictEqual(last.result.reply_count, 0);
  });

  await T('S3', 'Ảnh không match -> run NEEDS_HUMAN (an toàn ảnh yếu quan sát được)', async () => {
    const app = new App({ dataDir: dir('s3') });
    msg(app, FB, 'fb-s3', 'cái này còn không shop', { kind: 'image', media: { platform_url: 'http://mock/anh-la.jpg' } });
    app.drain();
    const last = app.store.findAll('agent_runs', r => r.customer_ref === 'fb-s3').pop();
    assert.ok(last, 'có run');
    assert.strictEqual(last.status, 'NEEDS_HUMAN', 'run NEEDS_HUMAN');
    assert.strictEqual(last.result.intent, 'IMAGE_MATCH_LOW');
  });

  // ------------------------------------------------------------ S4 TOOLS
  await T('S4a', 'Đọc loạt tool: stock/price/product/search/customer/conversation/policy/quota (8 tool)', async () => {
    const app = new App({ dataDir: dir('s4a') });
    msg(app, FB, 'fb-s4a', 'nen vanila size M bao nhiêu vậy shop');
    app.drain();
    msg(app, ZL, 'zl-s4a', 'cho mình xem trà hoa sấy');
    app.drain();
    const convFb = convOf(app, 'fb-s4a');
    let r = await runTool('read_stock', { sku: 'NT-VANILLA-M-DO' }, { app });
    assert.ok(r.ok && r.result.effective >= 1, 'read_stock');
    r = await runTool('read_price', { sku: 'NT-VANILLA-M-DO' }, { app });
    assert.ok(r.ok && r.result.price === 185000, 'read_price 185000');
    r = await runTool('read_product', { sku_base: 'NT-VANILLA' }, { app });
    assert.ok(r.ok && r.result.variants.length >= 2, 'read_product variants');
    r = await runTool('search_products', { query: 'trà hoa sấy' }, { app });
    assert.ok(r.ok && r.result.matches.length >= 1 && r.result.matches[0].layer === 'alias', 'search_products alias');
    r = await runTool('read_customer', { conversation_id: convFb.conversation_id }, { app });
    assert.ok(r.ok && r.result.customer_id, 'read_customer qua conversation');
    r = await runTool('read_conversation', { conversation_id: convFb.conversation_id }, { app });
    assert.ok(r.ok && r.result.state === 'PRODUCT_QA' && r.result.window.open === true, 'read_conversation state+window');
    r = await runTool('read_shipping_policy', {}, { app });
    assert.ok(r.ok && r.result.shipping_fee === 25000 && r.result.freeship_threshold_vnd === 500000, 'read_shipping_policy evidence');
    r = await runTool('read_channel_quota', { conversation_id: convOf(app, 'zl-s4a').conversation_id }, { app });
    assert.ok(r.ok && r.result.channel === 'zalo' && r.result.cs_total === 8
      && Number.isInteger(r.result.cs_remain) && r.result.cs_remain >= 0 && r.result.cs_remain <= 8,
      'read_channel_quota zalo (total 8; remain đã trừ nếu bot trả lời CS trước đó): ' + JSON.stringify(r.result || r.error));
    r = await runTool('read_channel_policy', { conversation_id: convFb.conversation_id }, { app });
    assert.ok(r.ok && r.result.rules.facebook_window_hours === 24, 'read_channel_policy');
    // lỗi chuẩn
    r = await runTool('read_stock', { sku: 'KHONG-TON-TAI' }, { app });
    assert.ok(!r.ok && r.error.code === 'SKU_NOT_FOUND', 'SKU_NOT_FOUND error type');
    r = await runTool('read_price', {}, { app });
    assert.ok(!r.ok && r.error.code === 'TOOL_INVALID_INPUT', 'TOOL_INVALID_INPUT khi thiếu sku');
    r = await runTool('tool_khong_co', {}, { app });
    assert.ok(!r.ok && r.error.code === 'TOOL_UNKNOWN', 'TOOL_UNKNOWN');
  });

  await T('S4b', 'create_order_draft: thiếu slot -> MISSING_FIELDS; đủ slot -> draft DRAFT + reserve', async () => {
    const app = new App({ dataDir: dir('s4b') });
    msg(app, FB, 'fb-s4b', 'cho mình 2 hộp trà hoa sấy');
    app.drain();
    const conv = convOf(app, 'fb-s4b');
    let r = await runTool('create_order_draft', {
      conversation_id: conv.conversation_id,
      items: [{ sku: 'TRA-HOA-SEY-50', qty: 2 }],
    }, { app });
    assert.ok(!r.ok && r.error.code === 'MISSING_FIELDS' && r.error.missing.includes('name'), 'MISSING_FIELDS kèm missing');
    r = await runTool('create_order_draft', {
      conversation_id: conv.conversation_id,
      items: [{ sku: 'TRA-HOA-SEY-50', qty: 2 }],
      name: 'Suri Tool', phone: '0909998877', address: '12 Nguyễn Huệ Q1 TP.HCM',
    }, { app });
    assert.ok(r.ok && r.result.order.status === 'DRAFT', 'draft tạo (status DRAFT)');
    const priceTra = app.productDB.getStock('TRA-HOA-SEY-50').price;
    assert.strictEqual(r.result.order.total, 2 * priceTra + 25000, `tổng = 2x${priceTra} + fee (giá từ DB)`);
    assert.ok(conv.draft.order_id === r.result.order.order_id, 'conv.draft trỏ draft mới');
    assert.strictEqual(app.productDB.getStock('TRA-HOA-SEY-50').stock_reserved, 2, 'reserve 2');
    // dedupe cùng run: gọi lại y hệt (cùng idem key, cùng engine idem) -> không sinh đơn thứ 2
    const ordersBefore = app.store.findAll('orders', o => o.conversation_id === conv.conversation_id).length;
    r = await runTool('create_order_draft', {
      conversation_id: conv.conversation_id,
      items: [{ sku: 'TRA-HOA-SEY-50', qty: 2 }],
      name: 'Suri Tool', phone: '0909998877', address: '12 Nguyễn Huệ Q1 TP.HCM',
    }, { app });
    assert.ok(r.ok || r.duplicate, 'lần 2 vẫn ok (engine idempotent)');
    const ordersAfter = app.store.findAll('orders', o => o.conversation_id === conv.conversation_id).length;
    assert.strictEqual(ordersAfter, ordersBefore, 'KHÔNG sinh đơn thứ 2 (INV-3)');
  });

  await T('S4c', 'confirm_order + get_shipment_status + cancel_order (ủy quyền engine + carrier)', async () => {
    const app = new App({ dataDir: dir('s4c') });
    msg(app, FB, 'fb-s4c', 'lấy 1 nến vanilla M đỏ, tên Tool Test, sdt 0903333444, địa chỉ 45 Lê Lợi Q1 TP.HCM');
    app.drain();
    const conv = convOf(app, 'fb-s4c');
    const draft = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
    let r = await runTool('confirm_order', { order_id: draft.order_id }, { app });
    assert.ok(r.ok && r.result.order.status === 'CONFIRMED', 'confirm_order -> CONFIRMED');
    assert.ok(r.result.shipment && /^MOCK-/.test(r.result.shipment.tracking_number), 'vận đơn tạo MOCK-');
    r = await runTool('get_shipment_status', { order_id: draft.order_id }, { app });
    assert.ok(r.ok && r.result.shipment.tracking_number && r.result.carrier_status, 'get_shipment_status');
    // đơn thứ 2 để huỷ: mua lại (re-entry) + huỷ ngay khi còn DRAFT
    msg(app, FB, 'fb-s4c', 'lấy thêm 1 nến vanilla S');
    app.drain();
    const conv2 = convOf(app, 'fb-s4c');
    let draft2 = app.store.findOne('orders', o => o.conversation_id === conv2.conversation_id && o.status === 'DRAFT');
    assert.ok(draft2, 'draft mua lại tồn tại');
    r = await runTool('cancel_order', { order_id: draft2.order_id, reason: 'tool_test' }, { app });
    assert.ok(r.ok, 'cancel_order ok: ' + JSON.stringify(r.error || {}));
    assert.strictEqual(app.store.findOne('orders', o => o.order_id === draft2.order_id).status, 'CANCELLED', 'đơn huỷ CANCELLED');
  });

  await T('S4d', 'send_message QUA GATE (window mở -> gửi; sau takeover -> vẫn gửi do human_agent giữ)', async () => {
    const app = new App({ dataDir: dir('s4d') });
    msg(app, FB, 'fb-s4d', 'shop ơi nến còn không');
    app.drain();
    const conv = convOf(app, 'fb-s4d');
    let r = await runTool('send_message', { conversation_id: conv.conversation_id, text: 'Dạ còn nha anh/chị!' }, { app });
    assert.ok(r.ok && r.result.sent === true, 'send_message gửi được qua gate');
    assert.strictEqual(r.result.delivery_status, 'SENT_PENDING_RECEIPT', 'BL-5: SENT_PENDING_RECEIPT (không tự DELIVERED)');
    const outRow = app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'out').pop();
    assert.strictEqual(outRow.sender, 'human_agent', 'actor human_agent qua agentSend');
    // dedupe cấp tool trong CÙNG run context (mô phỏng run đang mở của orchestrator)
    const run = { run_id: 'run_s4d_dedupe', conversation_id: conv.conversation_id, steps: [], step_count: 0, started_at: app.store.now(), status: 'RUNNING' };
    app.store.insert('agent_runs', run);
    app.agent.openRun = run; // "run đang mở" — recordToolCall của orchestrator đọc openRun
    const runCtx = { app, run, recordToolCall: c => app.agent.recordToolCall(c) };
    r = await runTool('send_message', { conversation_id: conv.conversation_id, text: 'Tin dedupe test' }, runCtx);
    assert.ok(r.ok, 'lần 1 ok');
    const r2 = await runTool('send_message', { conversation_id: conv.conversation_id, text: 'Tin dedupe test' }, runCtx);
    assert.ok(r2.duplicate === true, 'lần 2 dedupe (idem key cùng run)');
    app.agent.openRun = null;
    // ToolCall/ToolResult ghi vào AgentRun đang mở
    assert.strictEqual(run.steps.length, 2, 'run ghi 2 step TOOL');
    const steps = app.store.findAll('agent_steps', s => s.run_id === run.run_id);
    assert.strictEqual(steps.length, 2);
    assert.strictEqual(steps[0].tool_calls[0].tool, 'send_message');
    assert.ok(steps[0].tool_calls[0].call_id, 'ToolCall có call_id');
  });

  await T('S4e', 'NOT_CONFIGURED: GHN thiếu token -> quote_shipping/create_shipment KHÔNG giả PASS', async () => {
    const app = new App({ dataDir: dir('s4e'), live: { carrier: new GhnAdapter({ config: {} }) } });
    assert.strictEqual(app.carrier.isConfigured(), false, 'GHN adapter chưa cấu hình');
    let r = await runTool('quote_shipping', { sku: 'NT-VANILLA-M-DO' }, { app });
    assert.ok(!r.ok && r.status === 'NOT_CONFIGURED', 'quote_shipping NOT_CONFIGURED');
    assert.ok(/token/i.test(r.reason), 'reason nêu thiếu token');
    msg(app, FB, 'fb-s4e', 'lấy 1 nến vanilla M đỏ, tên GHN Test, sdt 0905556666, địa chỉ 5 Lê Lợi Q1');
    app.drain();
    const conv = convOf(app, 'fb-s4e');
    const draft = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'DRAFT');
    r = await runTool('confirm_order', { order_id: draft.order_id }, { app });
    assert.ok(r.ok && r.result.order.status === 'CONFIRMED', 'confirm ok (không cần GHN)');
    assert.strictEqual(r.result.shipment_timeout, true, 'carrier GHN chưa cấu hình -> shipment không tạo (deferred/timeout)');
    r = await runTool('create_shipment', { order_id: draft.order_id }, { app });
    assert.ok(!r.ok && r.status === 'NOT_CONFIGURED', 'create_shipment NOT_CONFIGURED');
    r = await runTool('cancel_shipment', { order_id: draft.order_id }, { app });
    assert.ok(!r.ok && r.status === 'NOT_CONFIGURED', 'cancel_shipment NOT_CONFIGURED');
    r = await runTool('send_media', { conversation_id: conv.conversation_id, media_url: 'http://mock/a.jpg' }, { app });
    assert.ok(!r.ok && r.status === 'NOT_CONFIGURED', 'send_media NOT_CONFIGURED (prototype chỉ text)');
  });

  await T('S4f', 'takeover/handback + schedule_follow_up (opt-out chặn marketing) + save_customer_note', async () => {
    const app = new App({ dataDir: dir('s4f') });
    msg(app, FB, 'fb-s4f', 'xin chào shop ơi');
    app.drain();
    const conv = convOf(app, 'fb-s4f');
    let r = await runTool('request_human_takeover', { conversation_id: conv.conversation_id, operator: 'nv-suri', reason: 'tool_test' }, { app });
    assert.ok(r.ok && r.result.mode === 'HUMAN', 'takeover -> HUMAN');
    r = await runTool('handback_to_ai', { conversation_id: conv.conversation_id, operator: 'nv-suri' }, { app });
    assert.ok(r.ok && r.result.mode === 'AI' && r.result.state, 'handback -> AI giữ state');
    r = await runTool('schedule_follow_up', { conversation_id: conv.conversation_id, kind: 'CARE', delay_hours: 2, note: 'gọi thăm' }, { app });
    assert.ok(r.ok && r.result.scheduled_at_vn && /\(GMT\+7/.test(r.result.scheduled_at_vn), 'follow-up có giờ VN hiển thị');
    const fu = app.store.findOne('follow_ups', f => f.conversation_id === conv.conversation_id && f.status === 'SCHEDULED');
    assert.ok(fu && fu.source === 'agent_tool', 'row follow_ups SCHEDULED (việc gửi vẫn do scheduler+gate)');
    // opt-out -> marketing bị chặn từ lúc đặt lịch (gate vẫn chặn lần 2 khi gửi)
    const cus = app.store.findOne('customers', c => c.customer_id === conv.customer_id);
    cus.marketing_opt_out = 1;
    r = await runTool('schedule_follow_up', { conversation_id: conv.conversation_id, kind: 'MARKETING', delay_hours: 5 }, { app });
    assert.ok(!r.ok && r.error.code === 'OPT_OUT', 'marketing với khách opt-out -> OPT_OUT');
    r = await runTool('save_customer_note', { customer_id: cus.customer_id, note: 'Khách thích nến hương vanilla', operator: 'nv-suri' }, { app });
    assert.ok(r.ok && r.result.notes_count === 1, 'save_customer_note');
    assert.ok(app.store.findAll('audit_events', a => a.proposed_action === 'CUSTOMER_NOTE').length >= 1, 'audit CUSTOMER_NOTE');
  });

  await T('S4g', 'TOOL_TIMEOUT + listTools đủ 24 tool đúng danh sách + update_order_draft', async () => {
    const app = new App({ dataDir: dir('s4g') });
    // kiểm tra registry NGUYÊN BẢN trước khi đăng ký tool test
    const names = listTools({ app }).map(t => t.name);
    const EXPECT = ['read_customer', 'read_conversation', 'read_product', 'search_products', 'read_stock', 'read_price',
      'read_shipping_policy', 'quote_shipping', 'read_order', 'create_order_draft', 'update_order_draft', 'confirm_order',
      'cancel_order', 'create_shipment', 'get_shipment_status', 'cancel_shipment', 'send_message', 'send_media',
      'request_human_takeover', 'handback_to_ai', 'schedule_follow_up', 'read_channel_policy', 'read_channel_quota', 'save_customer_note'];
    for (const n of EXPECT) assert.ok(names.includes(n), 'thiếu tool: ' + n);
    assert.strictEqual(names.length, EXPECT.length, 'đúng số tool theo danh sách (' + EXPECT.length + ')');
    const cfg = Object.fromEntries(listTools({ app }).map(t => [t.name, t.configured]));
    assert.strictEqual(cfg.send_media, false, 'send_media configured=false');
    assert.strictEqual(cfg.read_stock, true, 'tool đọc configured=true');
    assert.strictEqual(DEFS.filter(d => d.sideEffect).every(d => typeof d.idempotencyKey === 'function'), true, 'mọi sideEffect tool có idempotencyKey fn');
    // timeout: tool test async chậm (đăng ký tạm -> gỡ ngay để registry sạch cho suite khác)
    registerTool({
      name: 'suri_slow_test',
      description: 'test-only tool chậm',
      inputSchema: { type: 'object', fields: {} },
      outputSchema: { type: 'object' },
      sideEffect: false,
      timeoutMs: 50,
      handler: async () => { await new Promise(r2 => setTimeout(r2, 300)); return { done: true }; },
    });
    const r = await runTool('suri_slow_test', {}, { app });
    assert.ok(!r.ok && r.error.code === 'TOOL_TIMEOUT', 'async handler vượt timeout -> TOOL_TIMEOUT');
    assert.strictEqual(unregisterTool('suri_slow_test'), true, 'gỡ tool test');
    assert.strictEqual(listTools({ app }).length, EXPECT.length, 'sau gỡ registry về đúng 24');
    // update_order_draft: huỷ draft cũ + áp items mới
    const app2 = new App({ dataDir: dir('s4g2') });
    msg(app2, FB, 'fb-s4g2', 'lấy 1 nến vanilla M đỏ, tên Upd Test, sdt 0907778888, địa chỉ 7 Hai Bà Trưng Q1');
    app2.drain();
    const conv2 = convOf(app2, 'fb-s4g2');
    const draft = app2.store.findOne('orders', o => o.conversation_id === conv2.conversation_id && o.status === 'DRAFT');
    const r2 = await runTool('update_order_draft', { conversation_id: conv2.conversation_id, items: [{ sku: 'TRA-HOA-SEY-50', qty: 1 }] }, { app: app2 });
    assert.ok(r2.ok, 'update_order_draft ok: ' + JSON.stringify(r2.error || {}));
    assert.strictEqual(app2.store.findOne('orders', o => o.order_id === draft.order_id).status, 'CANCELLED', 'draft cũ bị huỷ (hoàn reserve)');
    assert.strictEqual(app2.productDB.getStock('NT-VANILLA-M-DO').stock_reserved, 0, 'reserve cũ hoàn lại');
    assert.deepStrictEqual(r2.result.draft.items.map(i => i.sku), ['TRA-HOA-SEY-50'], 'giỏ mới áp');
    assert.ok(r2.result.draft.order_id === null, 'draft không còn trỏ đơn cũ');
    // read_order
    const r3 = await runTool('read_order', { order_code: app2.store.findOne('orders', o => o.order_id === draft.order_id).order_code }, { app: app2 });
    assert.ok(r3.ok && r3.result.status === 'CANCELLED', 'read_order theo order_code');
  });

  // ------------------------------------------------------------ S5 SHOP PROFILE
  await T('S5', 'Shop profile: chặn secret + save + prompt chứa field + profile ĐÈ prompt cũ', async () => {
    const ss = new ShopSettings(dir('s5'));
    let v = shopProfile.validateShopProfile({ giongNoi: 'vui vẻ, key là sk-abc123def456' });
    assert.strictEqual(v.ok, false, 'secret trong profile bị chặn');
    v = shopProfile.validateShopProfile({ faq: [{ q: 'key?', a: 'api_key=abcd1234' }] });
    assert.strictEqual(v.ok, false, 'secret trong faq bị chặn');
    v = shopProfile.validateShopProfile({ ten: 'Shop Suri', linhVuc: 'nến thơm', faq: 'khong-phai-mang' });
    assert.strictEqual(v.ok, false, 'faq sai kiểu bị chặn');
    ss.set('prompt_config', JSON.stringify({ giongNoi: 'cũ: cộc lốc', gioLamViec: '8h-17h' }));
    const save = shopProfile.saveShopProfile(ss, {
      ten: 'Shop Suri', linhVuc: 'Nến thơm handmade', diaChi: '12 Lê Lợi Q1', hotline: '0900123456',
      giongNoi: 'mới: dịu dàng dùng dạ', quyTacTuVan: 'hỏi nhu cầu trước', quyTacChotDon: 'đủ tên/SĐT/địa chỉ',
      chinhSachGiaoHang: '2-4 ngày', thongTinCamNoi: ['nến đốt 30 tiếng'], cta: 'Chốt đơn nha anh/chị!',
      faq: [{ q: 'ship bao lâu?', a: '2-4 ngày' }],
    });
    assert.strictEqual(save.ok, true, 'save hợp lệ');
    const prof = shopProfile.getShopProfile(ss);
    assert.strictEqual(prof.ten, 'Shop Suri');
    // profile ĐÈ prompt config cũ (giongNoi) — giữ field cũ không có trong profile (gioLamViec)
    const merged = mergePromptConfig(JSON.parse(ss.get('prompt_config')), prof);
    const prompt = buildSystemPrompt(merged);
    for (const part of ['HỒ SƠ SHOP', 'Shop Suri', 'Nến thơm handmade', 'QUY TẮC TƯ VẤN', 'CHÍNH SÁCH GIAO HÀNG',
      'THÔNG TIN CẦM NÓI', 'nến đốt 30 tiếng', 'CTA KẾT THÚC', 'mới: dịu dàng dùng dạ', 'FAQ CỦA SHOP']) {
      assert.ok(prompt.includes(part), 'prompt thiếu: ' + part);
    }
    assert.ok(!prompt.includes('cũ: cộc lốc'), 'profile đè giongNoi cũ');
    assert.ok(prompt.includes('8h-17h'), 'field legacy không bị profile đè thì giữ nguyên');
    const vBad2 = shopProfile.validateShopProfile({ ten: { obj: true } });
    assert.strictEqual(vBad2.ok, false, 'field không phải chuỗi bị chặn');
  });

  // ------------------------------------------------------------ S6 ERRORS + TZ
  await T('S6', 'Errors UX: token hết hạn/GHN/AI -> tiếng Việt; fmtVnTime +7 chuẩn; roundtrip giờ VN', async () => {
    const e1 = friendlyError(new Error('token_expired: zalo refresh failed'));
    assert.ok(/hết phiên đăng nhập|refresh/.test(e1.userMessage), 'token expired -> tiếng Việt: ' + e1.userMessage);
    const e2 = friendlyError(new Error('CREATE_SHIPMENT carrier_timeout TIMEOUT_UNKNOWN'));
    assert.ok(/vận đơn GHN/.test(e2.userMessage), 'GHN lỗi -> message đúng');
    const e3 = friendlyError(new Error('deepseek http_status_401'));
    assert.ok(/AI đang tạm gián đoạn/.test(e3.userMessage), 'AI lỗi -> message đúng');
    const e4 = friendlyError(new Error('fb_window_closed'));
    assert.ok(/24h/.test(e4.userMessage), 'window đóng -> message đúng');
    // TZ: 10:00 UTC -> 17:00 GMT+7 cùng ngày
    const vn = fmtVnTime('2026-10-06T10:00:00.000Z');
    assert.ok(vn.startsWith('2026-10-06 17:00'), 'fmtVnTime +7: ' + vn);
    assert.ok(vn.includes('Asia/Ho_Chi_Minh'), 'ghi rõ timezone');
    const iso = vnWallClockToIso('2026-10-06 17:00');
    assert.strictEqual(new Date(iso).toISOString(), '2026-10-06T10:00:00.000Z', 'roundtrip giờ VN -> ISO UTC');
    assert.strictEqual(fmtVnTime('không phải ngày'), null, 'giá trị rác -> null (không crash)');
    assert.strictEqual(DEFAULT_TIMEZONE, 'Asia/Ho_Chi_Minh');
  });

  // ------------------------------------------------------------ S7 DEEPSEEK WIRE (mask)
  await T('S7', 'DeepSeek wire: đọc file THẬT của chủ + mask assert (không in key)', async () => {
    const realPath = 'C:\\GaAi-Lab-Test\\GaAiLab\\backup\\model-rename-20261004\\provider_config.json';
    if (fs.existsSync(realPath)) {
      const rule = readDeepseekRule(realPath);
      assert.ok(rule.ok, 'đọc được rule deepseek: ' + rule.reason);
      assert.ok(/^sk-/.test(rule.apiKey), 'apiKey đúng format sk-');
      assert.strictEqual(rule.baseUrl, 'https://api.deepseek.com/v1', 'baseUrl đúng');
      assert.deepStrictEqual(rule.models, ['deepseek-flash', 'deepseek-v4-pro'], 'personalModelIds đúng');
      const ss = new ShopSettings(dir('s7'));
      const w = wireDeepseek(ss, {});
      // MASK ASSERT — output wire KHÔNG chứa key thô
      const flat = JSON.stringify(w);
      assert.ok(!flat.includes(rule.apiKey), 'wire view KHÔNG chứa key thô');
      assert.ok(!flat.includes(rule.apiKey.slice(0, 12)), 'wire view không chứa đầu key');
      assert.strictEqual(w.maskedKey, '***' + rule.apiKey.slice(-4), 'maskedKey = *** + 4 cuối');
      assert.strictEqual(ss.get('ai_provider'), 'deepseek', 'settings đã ghi provider deepseek');
      assert.strictEqual(ss.get('ai_model'), 'deepseek-chat', 'model wire = deepseek-chat');
      assert.strictEqual(ss.get('ai_api_key'), rule.apiKey, 'key lưu settings (file shop — không ra ngoài)');
      assert.deepStrictEqual(JSON.parse(ss.get('ai_deepseek_models')), ['deepseek-flash', 'deepseek-v4-pro']);
    } else {
      // máy không có file thật -> test fixture thay thế (không fake PASS: ghi rõ nhánh)
      console.log('      (không có file provider config thật — test fixture)');
      const fx = path.join(dir('s7fx'), 'provider_config.json');
      fs.mkdirSync(path.dirname(fx), { recursive: true });
      fs.writeFileSync(fx, JSON.stringify({ config: { providerConfigRules: { providerRules: [{ providerId: 'deepseek', config: { access: { apiKey: 'sk-fixture1234567890' }, api: { baseUrl: 'https://api.deepseek.com/v1' }, personalModelIds: ['deepseek-flash'] } }] } } }));
      const rule = readDeepseekRule(fx);
      assert.ok(rule.ok);
      const ss = new ShopSettings(dir('s7'));
      const w = wireDeepseek(ss, { file: fx });
      assert.ok(!JSON.stringify(w).includes('sk-fixture1234567890'));
      assert.strictEqual(w.maskedKey, '***7890');
    }
  });

  // ------------------------------------------------------------ S8 HTTP SERVER API
  let inst = null;
  let sid = null;
  let shopId = null;
  await T('S8a', 'Server boot + owner setup + go-live + tool registry API (/api/agent/tools: 24 tool + configured)', async () => {
    const root = dir('s8');
    fs.rmSync(root, { recursive: true, force: true });
    inst = createServer({ port: 0, authDir: path.join(root, 'auth'), shopsRoot: path.join(root, 'shops'), uiDemo: '0', appDataMode: 'persist' });
    inst.listen();
    for (let i = 0; i < 60 && !inst.server.listening; i++) await new Promise(r => setTimeout(r, 20));
    inst.client = makeClient(`http://127.0.0.1:${inst.server.address().port}`);
    const setup = await inst.client('POST', '/api/auth/setup', { body: { email: 'suri@test.dev', password: 'password123', shop_name: 'Suri Shop' } });
    assert.strictEqual(setup.status, 200, 'setup owner');
    sid = setup.headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
    shopId = setup.json.shop.shop_id;
    // go-live checklist (shop mới bot OFF — đúng thiết kế; bật như e2e-flows)
    for (const [stepId, data] of [
      ['shop-info', { name: 'Suri Shop', hotline: '0900000000', address: '1 Test St Q1' }],
      ['facebook', { page_id: 'page-suri', page_access_token: 'ptk-suri-token' }],
      ['zalo', { oa_id: 'oa-suri', access_token: 'zat-suri-token' }],
      ['shipping', { ghn_token: 'ghn-suri-token', ghn_shop_id: '111111' }],
      ['ai', { provider: 'local' }],
    ]) {
      const r = await inst.client('POST', '/api/onboarding/complete-step', { cookie: sid, body: { stepId, data } });
      assert.strictEqual(r.status, 200, 'complete-step ' + stepId);
    }
    const aiTest = await inst.client('POST', '/api/ai/test', { cookie: sid, body: {} });
    assert.strictEqual(aiTest.status, 200, 'ai test local PASS offline');
    const bot = await inst.client('POST', '/api/settings/bot', { cookie: sid, body: { on: true } });
    assert.strictEqual(bot.status, 200, 'go-live -> bot ON: ' + bot.text.slice(0, 160));
    const tools = await inst.client('GET', '/api/agent/tools', { cookie: sid });
    assert.strictEqual(tools.status, 200);
    assert.strictEqual(tools.json.tools.length, 24, 'registry qua API đủ 24 tool');
    assert.ok(tools.json.tools.every(t => t.inputSchema && t.outputSchema && typeof t.configured === 'boolean'), 'mỗi tool có schema + configured');
  });

  await T('S8b', '/api/agent/runs: bắn tin khách qua webhook-debug -> run liệt kê + detail đủ steps', async () => {
    const dm = await inst.client('POST', '/api/debug/customer-message', {
      cookie: sid,
      body: { channel: 'facebook', ref: 'fb-s8', text: 'lấy 1 nến vanilla M đỏ, tên Web Test, sdt 0902223333, địa chỉ 9 Lê Thánh Tôn Q1' },
    });
    assert.strictEqual(dm.status, 200);
    const app = inst.getApp(shopId);
    const runs = await inst.client('GET', '/api/agent/runs?limit=50', { cookie: sid });
    assert.strictEqual(runs.status, 200);
    assert.ok(runs.json.runs.length >= 1, 'runs API có dữ liệu');
    const target = runs.json.runs.find(r => r.customer_ref === 'fb-s8');
    assert.ok(target, 'run của fb-s8 có trong danh sách');
    assert.strictEqual(target.status, 'DONE');
    const detail = await inst.client('GET', `/api/agent/runs/${target.run_id}`, { cookie: sid });
    assert.strictEqual(detail.status, 200);
    assert.deepStrictEqual(detail.json.steps.map(s => s.type), ['UNDERSTAND', 'DECISION', 'SEND']);
    assert.ok(detail.json.started_at_vn.includes('GMT+7'), 'run hiển thị giờ VN');
    const missing = await inst.client('GET', '/api/agent/runs/run_khong_ton_tai', { cookie: sid });
    assert.strictEqual(missing.status, 404, 'run lạ -> 404');
    void app;
  });

  await T('S8c', '/api/shop-profile POST/GET + /api/prompt merge profile (ưu tiên cao hơn legacy)', async () => {
    const bad = await inst.client('POST', '/api/shop-profile', { cookie: sid, body: { ten: 'Shop X', giongNoi: 'token	api-abc' } });
    assert.strictEqual(bad.status, 400, 'secret trong profile -> 400');
    const ok = await inst.client('POST', '/api/shop-profile', {
      cookie: sid,
      body: {
        ten: 'Suri Shop Web', linhVuc: 'Nến thơm', hotline: '0900123456', diaChi: '1 Test St',
        giongNoi: 'web: dễ thương', quyTacChotDon: 'chốt nhanh gọn', faq: [{ q: 'alo?', a: 'em đây!' }],
      },
    });
    assert.strictEqual(ok.status, 200, 'POST hợp lệ: ' + ok.text.slice(0, 120));
    const got = await inst.client('GET', '/api/shop-profile', { cookie: sid });
    assert.strictEqual(got.json.profile.ten, 'Suri Shop Web');
    assert.deepStrictEqual(got.json.profile.faq, [{ q: 'alo?', a: 'em đây!' }]);
    // legacy prompt config -> profile ĐÈ giongNoi/quyTacChotDon
    await inst.client('POST', '/api/prompt/config', { cookie: sid, body: { giongNoi: 'legacy: cộc lốc', gioLamViec: '8h-21h' } });
    const pr = await inst.client('GET', '/api/prompt', { cookie: sid });
    assert.ok(pr.json.prompt.includes('web: dễ thương'), 'profile thắng legacy');
    assert.ok(pr.json.prompt.includes('8h-21h'), 'legacy field không bị đè vẫn giữ');
    assert.ok(pr.json.prompt.includes('Suri Shop Web'));
  });

  await T('S8d', 'Scheduler TZ: settings timezone mặc định VN + /api/automation upcoming có scheduled_at_vn', async () => {
    const st = await inst.client('GET', '/api/settings', { cookie: sid });
    assert.strictEqual(st.json.timezone, 'Asia/Ho_Chi_Minh', 'timezone mặc định ghi settings');
    // tạo follow-up SCHEDULED qua tool (agent) rồi đọc automation view
    const app = inst.getApp(shopId);
    const dm = await inst.client('POST', '/api/debug/customer-message', { cookie: sid, body: { channel: 'facebook', ref: 'fb-s8tz', text: 'xin chào shop' } });
    assert.strictEqual(dm.status, 200);
    const conv = app.store.findOne('conversations', c => c.platform_thread_id === 'fb-s8tz');
    const r = await runTool('schedule_follow_up', { conversation_id: conv.conversation_id, kind: 'CARE', delay_hours: 24 }, { app });
    assert.ok(r.ok, 'đặt follow-up: ' + JSON.stringify(r.error || {}));
    const au = await inst.client('GET', '/api/automation', { cookie: sid });
    assert.strictEqual(au.json.automation.timezone, 'Asia/Ho_Chi_Minh');
    const row = au.json.automation.upcoming_follow_ups.find(f => f.follow_up_id === r.result.follow_up_id);
    assert.ok(row, 'follow-up xuất hiện trong upcoming');
    assert.ok(/\(GMT\+7 · Asia\/Ho_Chi_Minh\)$/.test(row.scheduled_at_vn), 'hiển thị giờ VN: ' + row.scheduled_at_vn);
  });

  await T('S8e', 'Regression-honesty: tin khách qua server vẫn trả lời NGUYÊN (orchestrator không cản)', async () => {
    const app = inst.getApp(shopId);
    const conv = app.store.findOne('conversations', c => c.platform_thread_id === 'fb-s8');
    const outs = app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'out');
    assert.ok(outs.length >= 1, 'bot đã trả lời tin fb-s8 (qua orchestrator)');
    assert.ok(outs.some(m => /Tổng cộng/.test(m.text_content || '')), 'bill vẫn về tay khách');
  });

  // ============================================================ tổng kết
  const pass = RESULTS.filter(r => r.ok).length;
  const fail = RESULTS.length - pass;
  console.log('----------------------------------------------------------------------------------------------------');
  console.log(`TỔNG: ${pass}/${RESULTS.length} PASS, ${fail} FAIL`);
  if (fail) {
    for (const f of RESULTS.filter(x => !x.ok)) console.log(`  FAIL #${f.n} [${f.group}] ${f.desc}: ${f.err && f.err.message}`);
    console.log(`==> ${pass}/${RESULTS.length} — CHƯA ĐẠT.`);
    process.exitCode = 1;
  } else {
    console.log(`==> ${pass}/${pass} — SURI P1 ĐẠT.`);
  }
  await new Promise(resolve => { if (inst) inst.close().then(resolve); else resolve(); });
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
}

// HTTP client helper (mô phỏng e2e-flows)
function makeClient(base) {
  const u0 = new URL(base);
  return function call(method, p, { body, cookie } = {}) {
    return new Promise((resolve, reject) => {
      const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
      const headers = {};
      if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
      if (cookie) headers.Cookie = `sid=${cookie}`;
      const req = http.request({ hostname: u0.hostname, port: u0.port, path: p, method, headers }, res => {
        let out = '';
        res.on('data', c => { out += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(out); } catch (e) { /* text */ }
          resolve({ status: res.statusCode, headers: res.headers, json, text: out });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  };
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
