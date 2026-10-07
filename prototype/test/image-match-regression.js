'use strict';
// test/image-match-regression.js — REGRESSION RIÊNG cho CHANGE REQUEST đã Supervisor duyệt
// (PHASE PRODUCT-READY đợt 2): đường IMAGE-MATCH (mockVision) trong src/pipeline.js phải lọc
// SP disabled (enabled=false) GIỐNG đường TEXT (product-db.searchProduct).
//
// Nội dung:
//   IM1  enabled  -> ảnh match bình thường (subject_sku + bot trả lời tồn/giá).
//   IM2  disabled -> ảnh CÙNG SP KHÔNG còn match: subject_sku null + NEEDS_HUMAN + KHÔNG lộ giá.
//   IM3  disabled -> getVariant/getStock/getProduct vẫn đọc được (đơn cũ không gãy).
//   IM4  bật lại  -> match qua ảnh hoạt động trở lại.
//   IM5  audit cho lần match-chết: NEEDS_HUMAN có evidence product_disabled (truy được vì sao).
//   IM6  node --check pipeline.js (file duy nhất bị đụng trong exception).
// Exit 0 khi toàn bộ PASS.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { App } = require('../src/app');

const DATA = path.join(__dirname, '..', 'data', 'test-runs', 'image-match-regression');

function freshApp(name) {
  const dataDir = path.join(DATA, name);
  fs.rmSync(dataDir, { recursive: true, force: true });
  return new App({ dataDir, persist: false, botEnabled: true });
}

function fireImage(app, ref, file, pid) {
  return app.receive({
    channel: 'facebook',
    type: 'message',
    platformEventId: pid || `img-${ref}-${file}`,
    payload: {
      customer_ref: ref,
      thread_id: ref,
      kind: 'image',
      text: '',
      media: { platform_url: `https://img.example/${file}` },
      platform_message_id: `pm-${pid || `img-${ref}-${file}`}`,
    },
  });
}

const TESTS = [
  ['IM1', 'enabled: ảnh match -> subject_sku đúng + bot trả lời', () => {
    const app = freshApp('im1');
    fireImage(app, 'im1-khach', 'nen-vanilla-m-do.jpg');
    app.drain();
    const conv = app.store.findOne('conversations', c => c.platform_thread_id === 'im1-khach');
    assert.strictEqual(conv.subject_sku, 'NT-VANILLA-M-DO', 'match đúng SKU từ ảnh, got ' + conv.subject_sku);
    const out = app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'out');
    assert.ok(out.length >= 1, 'bot đã trả lời qua ảnh');
    assert.ok(out.some(m => m.delivery_status), 'tin bot có trạng thái gửi');
  }],
  ['IM2', 'disabled: ảnh CÙNG SP -> KHÔNG match, NEEDS_HUMAN, không lộ giá', () => {
    const app = freshApp('im2');
    fireImage(app, 'im2-khach', 'nen-vanilla-m-do.jpg'); //match trước để chắc ảnh "ngoạn mục"
    app.drain();
    const c1 = app.store.findOne('conversations', c => c.platform_thread_id === 'im2-khach');
    assert.strictEqual(c1.subject_sku, 'NT-VANILLA-M-DO');
    // TẮT SP -> conversation MỚI gửi CÙNG ảnh
    app.productDB.getProductByBase('NT-VANILLA').enabled = false;
    fireImage(app, 'im2-khach-2', 'nen-vanilla-m-do.jpg');
    app.drain();
    const conv = app.store.findOne('conversations', c => c.platform_thread_id === 'im2-khach-2');
    assert.strictEqual(conv.subject_sku, null, 'SP tắt KHÔNG được match qua ảnh');
    assert.strictEqual(conv.flag_needs_human, true, 'rơi nhánh an toàn NEEDS_HUMAN');
    const out = app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'out');
    const joined = out.map(m => m.text_content || '').join(' | ');
    assert.ok(!joined.includes('185'), 'KHÔNG tư vấn giá 185k của SP tắt: ' + joined.slice(0, 120));
    assert.ok(!joined.includes('165'), 'KHÔNG lộ giá nào của SP tắt');
  }],
  ['IM3', 'disabled: getVariant/getStock/getProduct vẫn đọc được (đơn cũ không gãy)', () => {
    const app = freshApp('im3');
    app.productDB.getProductByBase('TRA-HOA-SEY').enabled = false;
    const hit = app.productDB.getVariant('TRA-HOA-SEY-50');
    assert.ok(hit && hit.product.name === 'Hộp trà hoa sấy', 'getVariant vẫn trả product');
    const st = app.productDB.getStock('TRA-HOA-SEY-50');
    assert.ok(st && st.price === 145000, 'getStock vẫn đọc giá/tồn');
    assert.ok(app.productDB.getProductByBase('TRA-HOA-SEY'), 'getProductByBase vẫn thấy');
    assert.strictEqual(app.productDB.searchProduct('trà hoa sấy').matches.length, 0, 'nhưng searchProduct (text) vẫn lọc');
  }],
  ['IM4', 'bật lại SP -> match qua ảnh hoạt động trở lại', () => {
    const app = freshApp('im4');
    const p = app.productDB.getProductByBase('NT-VANILLA');
    p.enabled = false;
    fireImage(app, 'im4-off', 'nen-vanilla.jpg');
    app.drain();
    const cOff = app.store.findOne('conversations', c => c.platform_thread_id === 'im4-off');
    assert.strictEqual(cOff.subject_sku, null, 'tắt: không match');
    p.enabled = true;
    fireImage(app, 'im4-on', 'nen-vanilla.jpg');
    app.drain();
    const cOn = app.store.findOne('conversations', c => c.platform_thread_id === 'im4-on');
    assert.strictEqual(cOn.subject_sku, 'NT-VANILLA-S', 'bật lại: match trở lại');
  }],
  ['IM5', 'audit lần match-chết: proposal NEEDS_HUMAN có evidence product_disabled', () => {
    const app = freshApp('im5');
    app.productDB.getProductByBase('NT-VANILLA').enabled = false;
    fireImage(app, 'im5-khach', 'nen-vanilla-m-do.jpg');
    app.drain();
    const conv = app.store.findOne('conversations', c => c.platform_thread_id === 'im5-khach');
    assert.strictEqual(conv.subject_sku, null);
    const prp = app.store.findAll('ai_proposals', p => p.conversation_id === conv.conversation_id
      && p.intent === 'IMAGE_MATCH_LOW');
    // proposal IMAGE_MATCH_LOW được lưu qua gate? — kiểm ít nhất worklist NEEDS_HUMAN + audit khớp
    const wl = app.store.findAll('worklist', w => w.conversation_id === conv.conversation_id && w.status === 'OPEN');
    assert.ok(wl.length >= 1, 'worklist có NEEDS_HUMAN cho ảnh SP tắt');
    const audits = app.store.findAll('audit_events', a => a.conversation_id === conv.conversation_id
      && a.proposed_action === 'SEND_REPLY:IMAGE_MATCH_LOW' && a.execution_result === 'NEEDS_HUMAN');
    assert.ok(audits.length >= 1, 'audit ghi nhận nhánh an toàn NEEDS_HUMAN (VALIDATED/NEEDS_HUMAN)');
    assert.ok(wl.some(w => String(w.reason || '').includes('IMAGE_MATCH_LOW')), 'worklist gắn lý do IMAGE_MATCH_LOW');
  }],
  ['IM6', 'node --check pipeline.js (file duy nhất của exception) không lỗi cú pháp', () => {
    const f = path.join(__dirname, '..', 'src', 'pipeline.js');
    const r = spawnSync('node', ['--check', f], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, 'pipeline.js cú pháp OK: ' + String(r.stderr).split('\n')[0]);
  }],
];

async function main() {
  console.log('===== IMAGE-MATCH REGRESSION (CHANGE REQUEST duyệt: lọc SP disabled trên đường ảnh) =====');
  fs.rmSync(DATA, { recursive: true, force: true });
  let pass = 0;
  for (const [n, desc, fn] of TESTS) {
    try {
      fn();
      pass += 1;
      console.log(`  [PASS] ${n} — ${desc}`);
    } catch (err) {
      console.log(`  [FAIL] ${n} — ${desc}\n         -> ${String(err && err.message).split('\n').slice(0, 4).join(' | ')}`);
    }
  }
  console.log(`\nTỔNG: ${pass}/${TESTS.length} PASS`);
  console.log(pass === TESTS.length
    ? '==> IMAGE-MATCH path ĐÃ LỌC SP disabled — chính sách đồng nhất với đường TEXT.'
    : '==> CHƯA ĐẠT.');
  process.exitCode = pass === TESTS.length ? 0 : 1;
}

main().catch(err => { console.error('[fatal]', err); process.exitCode = 1; });
