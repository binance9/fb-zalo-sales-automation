'use strict';
// test/matrix/index.js — RUNNER TEST MATRIX (14 khu vực, >=220 case runtime thật).
// Chạy: node test/matrix/index.js — in bảng theo khu vực + tổng; exit 0 khi toàn bộ PASS.
//
// SURI STABILITY GATE (Lỗi 1 — hardening harness, không đổi assertion/case nào):
//   [FIX-RUNNER-1] log TIẾN ĐỘ theo từng khu vực + từng case (elapsed) — trước đây runner in
//                  mỗi结果 ở CUỐI -> khi bị treo không biết khu vực/case nào mắc (run 3/4
//                  đợt BEFORE: 150s không có một dòng output nào).
//   [FIX-RUNNER-2] timeout từng case (90s) — case treo (promise không bao giờ settle) chuyển
//                  thành FAIL có tên thay vì TREO CẢ RUNNER vô hạn. KHÔNG nới assertion:
//                  case nào không xong trong hạn = FAIL (thiệt, không phải PASS dễ).
//   [FIX-RUNNER-3] watchdog toàn cục 10 phút — in vùng/case đang chạy lúc hết giờ + exit 1.
//   [FIX-RUNNER-4] EXIT SẠCH: đóng mọi server instance tạo trong setup (ctx.inst.close()),
//                  flush stdout rồi process.exit(code) — trước đây runner treo mãi mãi sau
//                  khi in kết quả (server/timer còn mở) — hạn chế đã ghi KNOWN LIMITATIONS
//                  từ P1/P2, giờ xử lý tận gốc (nghiệm thu lặp cần exit code in rõ).

const fs = require('fs');
const path = require('path');

const AREAS = [
  ['auth', require('./auth')],
  ['onboarding', require('./onboarding')],
  ['facebook', require('./facebook')],
  ['zalo', require('./zalo')],
  ['shipping', require('./shipping')],
  ['products', require('./products')],
  ['conversations', require('./conversations')],
  ['orders', require('./orders')],
  ['takeover', require('./takeover')],
  ['followup', require('./followup')],
  ['persistence', require('./persistence')],
  ['security', require('./security')],
  ['pwa', require('./pwa')],
  ['e2e', require('./e2e')],
];

const CASE_TIMEOUT_MS = 90 * 1000;   // [FIX-RUNNER-2] một case không được treo quá 90s
const GLOBAL_WATCHDOG_MS = 10 * 60 * 1000; // [FIX-RUNNER-3] cả runner không quá 10 phút

// dọn dữ liệu test-run cũ của matrix (đặt TRƯỚC khối lock — lockfile nằm cùng thư mục)
const DATA_CLEAN = path.join(__dirname, '..', '..', 'data', 'test-runs');

// [FIX-RUNNER-5] CHỐNG ZOMBIE RUNNER: nguyên nhân gốc đã chứng minh của họ flaky — runner cũ
// (trước FIX-RUNNER-4) treo vĩnh viễn nên TỒN TẠI song song; tick 2s của runner cũ vẫn persist
// db.json vào CÙNG data/test-runs/matrix-* , mà startInst chạy appDataMode=persist nên run mới
// NẠP LẠI db.json của runner cũ (đơn CONFIRMED sẵn, checklist onboarding test đã complete,
// follow-up đã SENT...) -> case fail di chuyển tùy vùng runner cũ đang đứng. Giải pháp: lockfile
// + kiểm tra pid sống — runner thứ 2 REFUSE chạy (exit 2) thay vì nhiễm chéo dữ liệu.
const LOCK_PATH = path.join(DATA_CLEAN, 'matrix-runner.lock');
function acquireRunnerLock() {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      let old = null;
      try { old = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')); } catch (e) { old = null; }
      if (old && old.pid) {
        let alive = true;
        try { process.kill(old.pid, 0); } catch (e) { alive = false; }
        if (alive) {
          console.error(`[LOCK] matrix runner khác đang chạy (pid ${old.pid}, start ${old.started_at}).`);
          console.error('[LOCK] Chạy song song 2 runner sẽ nhiễm chéo dữ liệu test-runs (flaky đã chứng minh). REFUSE — exit 2.');
          process.exit(2);
        }
        console.log(`[LOCK] bỏ lock stale của pid chết ${old.pid}`);
      }
    }
    fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  } catch (e) {
    console.error('[LOCK] không ghi được lockfile — chạy tiếp (không chặn):', e && e.message);
  }
}
function releaseRunnerLock() {
  try {
    const row = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    if (row.pid === process.pid) fs.rmSync(LOCK_PATH, { force: true });
  } catch (e) { /* không có/không đọc được — bỏ qua */ }
}
acquireRunnerLock();
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  try { process.on(sig, () => { releaseRunnerLock(); process.exit(130); }); } catch (e) { /* bỏ qua */ }
}

for (const f of fs.readdirSync(DATA_CLEAN)) {
  if (f.startsWith('matrix-')) fs.rmSync(path.join(DATA_CLEAN, f), { recursive: true, force: true });
}

const now = () => new Date().toISOString().slice(11, 19);
function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`CASE_TIMEOUT_${ms}ms (${label})`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  console.log('===== TEST MATRIX — 14 KHU VỰC (runtime thật qua API/App, offline) =====');
  const ctxs = []; // [FIX-RUNNER-4] giữ ctx từng area để đóng server cuối runner
  const rows = [];
  let pass = 0;
  let total = 0;
  const t0 = Date.now();

  // [FIX-RUNNER-3] watchdog: hết giờ -> in vị trí đang chạy + exit 1 (không treo vô hạn)
  let current = { area: '(boot)', case: '(setup)' };
  const watchdog = setTimeout(() => {
    console.error(`\n[WATCHDOG] runner vượt ${GLOBAL_WATCHDOG_MS / 1000}s — đang ở area=${current.area} case=${current.case} -> EXIT 1`);
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  }, GLOBAL_WATCHDOG_MS);
  watchdog.unref();

  for (const [key, areaDef] of AREAS) {
    const area = areaDef.area || key;
    let ctx = null;
    const results = [];
    const tArea = Date.now();
    current = { area, case: '(setup)' };
    console.log(`\n[${now()}] AREA ${area} — setup...`);
    try {
      ctx = areaDef.setup ? await withTimeout(areaDef.setup(), CASE_TIMEOUT_MS, `${area}:setup`) : {};
    } catch (err) {
      console.log(`[${now()}] AREA ${area} — SETUP FAIL: ${String(err && err.message).split('\n')[0]}`);
      for (const c of areaDef.cases) results.push({ id: c.id, desc: c.desc, status: 'FAIL', note: 'SETUP: ' + String(err && err.message).split('\n')[0] });
    }
    if (ctx) {
      ctxs.push({ area, ctx });
      let i = 0;
      for (const c of areaDef.cases) {
        i += 1;
        current = { area, case: c.id };
        const tCase = Date.now();
        try {
          await withTimeout(c.fn(ctx), CASE_TIMEOUT_MS, `${area}:${c.id}`);
          results.push({ id: c.id, desc: c.desc, status: 'PASS', note: '' });
        } catch (err) {
          const ms = Date.now() - tCase;
          console.log(`[${now()}]   FAIL ${area}/${c.id} (${ms}ms): ${String(err && err.message).split('\n').slice(0, 2).join(' | ').slice(0, 160)}`);
          results.push({ id: c.id, desc: c.desc, status: 'FAIL', note: String(err && err.message).split('\n').slice(0, 3).join(' | ').slice(0, 150) });
        }
      }
    }
    const areaPass = results.filter(r => r.status === 'PASS').length;
    pass += areaPass;
    total += results.length;
    console.log(`[${now()}] AREA ${area} — ${areaPass}/${results.length} (${Math.round((Date.now() - tArea) / 100) / 10}s)`);
    for (const r of results) rows.push({ area, ...r });
  }

  // [FIX-RUNNER-4] đóng mọi server instance để event loop cạn — runner exit sạch
  for (const { area, ctx } of ctxs) {
    try { if (ctx && ctx.inst && typeof ctx.inst.close === 'function') await ctx.inst.close(); }
    catch (err) { console.error(`[close] ${area}: ${err && err.message}`); }
  }
  clearTimeout(watchdog);
  const secs = Math.round((Date.now() - t0) / 100) / 10;

  // bảng theo khu vực
  console.log('\n================ BẢNG KẾT QUẢ THEO KHU VỰC ================');
  console.log('#'.padEnd(10) + 'KHU VỰC'.padEnd(16) + 'KẾT QUẢ'.padEnd(12));
  console.log('-'.repeat(38));
  const byArea = new Map();
  for (const r of rows) {
    if (!byArea.has(r.area)) byArea.set(r.area, { pass: 0, total: 0 });
    const e = byArea.get(r.area);
    e.total += 1;
    if (r.status === 'PASS') e.pass += 1;
  }
  let i = 1;
  for (const [area, e] of byArea.entries()) {
    const ok = e.pass === e.total;
    console.log(String(i++).padEnd(3) + String(area).padEnd(13) + `${e.pass}/${e.total}`.padEnd(10) + (ok ? 'PASS' : 'FAIL'));
  }
  console.log('-'.repeat(38));

  const failed = rows.filter(r => r.status === 'FAIL');
  console.log(`\nTỔNG: ${pass}/${total} case PASS (${secs}s) — tối thiểu đề bài: >=220 (14 khu vực)`);
  if (failed.length) {
    console.log('\n---- CASE FAIL ----');
    for (const f of failed) console.log(`  [${f.area}] ${f.id}: ${f.desc}\n        -> ${f.note}`);
  }
  const ok = pass === total && total >= 220;
  console.log(ok
    ? `\n==> MATRIX DAT: ${total} case thật (>=220), toàn bộ PASS.`
    : '\n==> CHƯA ĐẠT (cần >=220 PASS).');
  const code = ok ? 0 : 1;
  console.log(`EXIT_CODE=${code}`);
  // flush stdout rồi exit với code rõ ràng (server đã đóng — không còn handle giữ loop)
  process.exitCode = code;
  await new Promise(r => setTimeout(r, 150));
  // eslint-disable-next-line no-process-exit
  process.exit(code);
}

main().catch(err => { console.error('[fatal]', err); console.log('EXIT_CODE=1'); process.exitCode = 1; });
