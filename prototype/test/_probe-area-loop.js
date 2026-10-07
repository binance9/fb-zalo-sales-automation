'use strict';
// test/_probe-area-loop.js — chạy LẠP 1 khu vực của matrix N lần (root-cause flaky).
// Dùng: node test/_probe-area-loop.js <area-file> <số lần> [dump]
//   area-file: shipping | persistence | onboarding | e2e | conversations | orders | takeover
// In: kết quả từng lượt + case FAIL + (tuỳ chọn dump) dữ liệu store tại lúc fail.

const path = require('path');

const AREA = process.argv[2] || 'shipping';
const TIMES = parseInt(process.argv[3] || '10', 10);
const DUMP = process.argv[4] === 'dump';
const areaDef = require(path.join(__dirname, 'matrix', AREA + '.js'));

async function main() {
  const summary = [];
  for (let i = 1; i <= TIMES; i++) {
    const results = [];
    let ctx = null;
    let setupErr = null;
    try {
      ctx = areaDef.setup ? await areaDef.setup() : {};
    } catch (err) {
      setupErr = err;
    }
    if (setupErr) {
      console.log(`run ${i}: SETUP FAIL ${setupErr.message}`);
      summary.push({ run: i, fails: ['SETUP'] });
      continue;
    }
    for (const c of areaDef.cases) {
      try {
        await c.fn(ctx);
        results.push(`${c.id}=PASS`);
      } catch (err) {
        results.push(`${c.id}=FAIL(${String(err && err.message).split('\n')[0].slice(0, 110)})`);
        if (DUMP) {
          try {
            const app = ctx.app;
            console.log(`    [dump run ${i} ${c.id}] clock=${new Date(app.clock.now()).toISOString()} realNow=${new Date().toISOString()}`);
            console.log(`    orders: ${JSON.stringify(app.store.findAll('orders', () => true).map(o => ({ id: o.order_id && o.order_id.slice(-6), conv: o.conversation_id, st: o.status, cr: o.created_at, reason: o.cancel_reason || null })))}`);
            const convs = app.store.findAll('conversations', c2 => (c2.platform_thread_id || '').startsWith('sh'));
            console.log(`    convs(sh*): ${JSON.stringify(convs.map(cv => ({ id: cv.conversation_id, st: cv.state, mode: cv.mode, last: cv.last_activity_at })))}`);
            const fu = app.store.findAll('follow_ups', () => true);
            console.log(`    follow_ups: ${JSON.stringify(fu.map(f => ({ conv: f.conversation_id, st: f.status, sch: f.scheduled_at, reason: f.cancel_reason || null })))}`);
            const cs = app.store.findAll('channel_state', () => true);
            console.log(`    channel_state: ${JSON.stringify(cs.map(s => ({ conv: s.conversation_id, last: s.last_user_event_ts })))}`);
          } catch (e) { console.log('    [dump lỗi]', e.message); }
        }
      }
    }
    const fails = results.filter(r => r.includes('=FAIL'));
    console.log(`run ${i}: ${results.length - fails.length}/${results.length} ${fails.length ? '-> ' + fails.join(' ; ') : ''}`);
    summary.push({ run: i, fails: fails.map(f => f.split('=')[0]) });
    // dọn inst của lượt này để tick timer không dồn sang lượt kế (mô phỏng chạy sạch)
    if (ctx && ctx.inst && ctx.inst.close) await ctx.inst.close();
  }
  const byCase = {};
  for (const s of summary) for (const f of s.fails) byCase[f] = (byCase[f] || 0) + 1;
  console.log('\nTỔNG HỢP:', JSON.stringify(byCase));
  process.exit(0);
}

main().catch(e => { console.error('[fatal]', e); process.exit(1); });
