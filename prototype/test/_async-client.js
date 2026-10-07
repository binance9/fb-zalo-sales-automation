'use strict';
// test/_async-client.js — TIẾN TRÌNH KHÁCH ĐỘC LẬP cho gate SURI-ASYNC (LỖI 2).
//
// Đo TIMESTAMPS thật qua HTTP với server prototype chạy RIÊNG (test/_boot-async-server.js)
// và mock AI chậm (test/slow-ai-mock.js). KHÔNG tiêm gì vào tiến trình server — mọi thứ đi
// qua HTTP như một client thật (auth/setup → cấu hình AI → debug/customer-message → takeover).
//
// Scenario:
//   repro   — bắn tin hỏi giá (AI chờ delayMs), NGAY LẬP TỨC GET health + POST takeover +
//             POST bot-off + bắn tin "đổi ý"; đo latency từng call; cuối kỳ đọc state.
//   conc    — 5 khách hỏi gần như đồng thời (AI chậm) -> mỗi conv đúng 1 reply, không lẫn.
//   timeout — đặt shop timeout 3s -> reply fallback phải về ~3s (không phải 6s của mock,
//             không phải default 8s).
//
// Chạy: node test/_async-client.js --url http://127.0.0.1:PORT --mock-port P --db <db.json>
//        [--scenario repro|conc|timeout] [--delay 6000] [--timeout 30000] [--out /tmp/x.json]

const fs = require('fs');
const path = require('path');
const http = require('http');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  const v = i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
  return v === undefined ? dflt : v;
}
const URL_BASE = String(arg('url', ''));
const MOCK_PORT = Number(arg('mock-port', 0));
const DB_PATH = String(arg('db', ''));
const SCENARIO = String(arg('scenario', 'repro'));
const MOCK_DELAY = Number(arg('delay', 6000));
const AI_TIMEOUT = Number(arg('timeout', 30000));
const OUT = String(arg('out', ''));

const T = {}; // timestamps (ms kể từ mốc zero của scenario)
let t0 = Date.now();
const mark = (name, extra) => {
  T[name] = { t: Date.now() - t0, iso: new Date().toISOString(), ...(extra || {}) };
  process.stdout.write(`  [t+${String(T[name].t).padStart(6)}ms] ${name}${extra && extra.latency_ms !== undefined ? ` latency=${extra.latency_ms}ms` : ''}\n`);
};

function req(method, p, body, { cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const u = new URL(URL_BASE + p);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      timeout: 30000,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let j = null; try { j = JSON.parse(raw); } catch (e) { /* text */ }
        const setCookie = res.headers['set-cookie'];
        resolve({ status: res.statusCode, json: j, text: raw, setCookie: setCookie || [] });
      });
    });
    r.on('timeout', () => { r.destroy(new Error('client_timeout_30s')); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withLatency(name, fn) {
  const s = Date.now();
  const out = await fn();
  mark(name, { latency_ms: Date.now() - s, status: out && out.status });
  return out;
}

function readDb() {
  try {
    let p = DB_PATH;
    if (!p.endsWith('db.json')) {
      // DB_PATH là ROOT (shopsRoot cha) -> tìm shops/*/db.json duy nhất bên trong
      const shops = path.join(p, 'shops');
      const shop = fs.readdirSync(shops).find(d => fs.existsSync(path.join(shops, d, 'db.json')));
      p = path.join(shops, shop, 'db.json');
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}
const dbConv = (db, ref) => (db ? db.conversations.find(c => c.platform_thread_id === ref) : null);
const dbOutMsgs = (db, ref) => {
  const c = dbConv(db, ref);
  if (!c) return [];
  return db.messages.filter(m => m.conversation_id === c.conversation_id && m.direction === 'out');
};
const dbInMsgs = (db, ref) => {
  const c = dbConv(db, ref);
  if (!c) return [];
  return db.messages.filter(m => m.conversation_id === c.conversation_id && m.direction === 'in');
};

async function auth() {
  let r = await req('POST', '/api/auth/setup', { email: 'async@gate.test', password: 'Gate#12345', shop_name: 'AsyncGate' });
  if (r.status !== 200) r = await req('POST', '/api/auth/login', { email: 'async@gate.test', password: 'Gate#12345' });
  if (r.status !== 200) throw new Error('auth failed: ' + r.status + ' ' + r.text.slice(0, 200));
  const c = (r.setCookie.find(x => x.startsWith('suri_session') || x.includes('session')) || r.setCookie[0] || '').split(';')[0];
  if (!c) throw new Error('no session cookie: ' + JSON.stringify(r.setCookie));
  return c;
}

async function configAi(cookie, { timeout = AI_TIMEOUT } = {}) {
  const r = await req('POST', '/api/ai/config', {
    provider: 'deepseek', api_key: 'sk-mock-async-0001',
    base_url: `http://127.0.0.1:${MOCK_PORT}`,
    timeout,
  }, { cookie });
  if (r.status !== 200) throw new Error('ai config failed: ' + r.status + ' ' + r.text.slice(0, 300));
  return r.json;
}

const custMsg = (cookie, ref, text) =>
  req('POST', '/api/debug/customer-message', { channel: 'facebook', ref, text }, { cookie });

async function takeoverWithRetry(cookie, ref) {
  const p = `/api/conversations/${encodeURIComponent('facebook:' + ref)}/takeover`;
  for (let i = 0; i < 20; i++) {
    const r = await req('POST', p, {}, { cookie });
    if (r.status === 200) return r;
    await sleep(50);
  }
  throw new Error('takeover failed after retries');
}

async function pollUntil(ref, pred, { maxMs = 15000, step = 150 } = {}) {
  const start = Date.now();
  for (;;) {
    const db = readDb();
    if (db && pred(db)) return { db, waited_ms: Date.now() - start };
    if (Date.now() - start > maxMs) return { db: readDb(), waited_ms: Date.now() - start, timed_out: true };
    await sleep(step);
  }
}

// ---------------------------------------------------------------- scenario: repro
async function scenarioRepro(cookie) {
  const REF = 'async-guest';
  mark('zero');
  // (a) bắn tin hỏi giá — KHÔNG await (đo sau)
  const pricePromise = (async () => {
    const s = Date.now();
    const r = await custMsg(cookie, REF, 'nến vanilla size M giá bao nhiêu vậy shop');
    mark('recv_price_post', { latency_ms: Date.now() - s, status: r.status });
    return r;
  })();
  // (b) ngay lập tức: GET health (đo trong cửa sổ AI chờ)
  await withLatency('health_during_wait', () => req('GET', '/api/health', undefined, { cookie }));
  // (c) POST takeover trong cửa sổ chờ
  await withLatency('takeover_during_wait', () => takeoverWithRetry(cookie, REF));
  // (d) POST bot off trong cửa sổ chờ
  await withLatency('botoff_during_wait', () => req('POST', '/api/settings/bot', { on: false }, { cookie }));
  // (e) khách đổi ý trong cửa sổ chờ
  await withLatency('change_idea_post', () => custMsg(cookie, REF, 'thôi bỏ đơn không mua nữa nha shop'));
  await withLatency('health_after', () => req('GET', '/api/health', undefined, { cookie }));
  // chờ hậu kỳ: reply muộn (nếu có) phải tỉnh lại và bị gate chặn — hoặc bị REJECT (đúng mục tiêu)
  const rejectedProposals = db => {
    const c = dbConv(db, REF);
    return c ? db.ai_proposals.filter(p => p.conversation_id === c.conversation_id && p.decision === 'REJECTED_BY_GATE').length : 0;
  };
  const wait = await pollUntil(REF, db => dbOutMsgs(db, REF).length > 0 || rejectedProposals(db) > 0, { maxMs: 15000 });
  mark('settle', { waited_ms: wait.waited_ms, out_msgs: dbOutMsgs(wait.db, REF).length });
  // bot vẫn OFF từ (d) — bật lại để state sạch cho scenario kế tiếp
  await req('POST', '/api/settings/bot', { on: true }, { cookie });
  const db = readDb();
  const conv = dbConv(db, REF);
  return {
    scenario: 'repro', timestamps: T,
    result: {
      mode: conv ? conv.mode : null,
      out_texts: dbOutMsgs(db, REF).map(m => m.text_content),
      in_count: dbInMsgs(db, REF).length,
      out_count: dbOutMsgs(db, REF).length,
      rejected: db ? db.audit_events.filter(a => a.conversation_id === (conv || {}).conversation_id
        && String(a.execution_result || '').startsWith('REJECTED')).map(a => a.execution_result) : [],
      proposals_rejected: db ? db.ai_proposals.filter(p => p.conversation_id === (conv || {}).conversation_id
        && p.decision === 'REJECTED_BY_GATE').length : 0,
      metric_takeover_rej: db ? (db.metrics.find(m => m.metric === 'gate_rejected_takeover') || {}).value || 0 : 0,
      metric_botoff_rej: db ? (db.metrics.find(m => m.metric === 'gate_rejected_bot_off') || {}).value || 0 : 0,
      metric_stale_rej: db ? (db.metrics.find(m => m.metric === 'gate_rejected_stale_user_change') || {}).value || 0 : 0,
    },
  };
}

// ---------------------------------------------------------------- scenario: conc (P6)
async function scenarioConc(cookie) {
  const REFS = ['conc-1', 'conc-2', 'conc-3', 'conc-4', 'conc-5'];
  mark('zero');
  // 5 khách bắn GẦN NHU NHẤT CÙNG LÚC (không await nhau)
  const fires = REFS.map((ref, i) => {
    const s = Date.now();
    return custMsg(cookie, ref, `khách ${i + 1}: nến vanilla size M giá bao nhiêu vậy shop`)
      .then(r => mark('fired_' + ref, { latency_ms: Date.now() - s, status: r.status }));
  });
  await Promise.all(fires);
  await withLatency('health_during_wait', () => req('GET', '/api/health', undefined, { cookie }));
  // chờ đủ 5 reply (mỗi conv đúng 1) hoặc hết giờ
  const wait = await pollUntil(null, db => REFS.every(ref => dbOutMsgs(db, ref).length >= 1), { maxMs: 20000 });
  mark('settle', { waited_ms: wait.waited_ms });
  const db = readDb();
  const runs = db ? db.agent_runs.filter(r => REFS.some(ref => r.conversation_id === `facebook:${ref}`)) : [];
  return {
    scenario: 'conc', timestamps: T,
    result: {
      per_conv: REFS.map(ref => ({
        ref,
        in: dbInMsgs(db, ref).length,
        out: dbOutMsgs(db, ref).length,
        out_texts: dbOutMsgs(db, ref).map(m => m.text_content),
        runs: runs.filter(r => r.conversation_id === `facebook:${ref}`).map(r => ({ status: r.status, decision: r.decision, replies: r.result && r.result.reply_count })),
      })),
      total_out: REFS.reduce((n, ref) => n + dbOutMsgs(db, ref).length, 0),
      total_in: REFS.reduce((n, ref) => n + dbInMsgs(db, ref).length, 0),
    },
  };
}

// ---------------------------------------------------------------- scenario: timeout (P5)
async function scenarioTimeout(cookie) {
  const REF = 'timeout-guest';
  await configAi(cookie, { timeout: 3000 }); // timeout THEO CẤU HÌNH SHOP = 3s
  mark('zero');
  const s = Date.now();
  const fire = custMsg(cookie, REF, 'nến vanilla size M giá bao nhiêu ạ')
    .then(r => mark('recv_post', { latency_ms: Date.now() - s, status: r.status }));
  await fire;
  const wait = await pollUntil(REF, db => dbOutMsgs(db, REF).length > 0, { maxMs: 15000 });
  mark('first_reply', { waited_ms: wait.waited_ms });
  const db = readDb();
  const outs = dbOutMsgs(db, REF);
  return {
    scenario: 'timeout', timestamps: T,
    result: {
      out_texts: outs.map(m => m.text_content),
      first_reply_ms: wait.waited_ms,
      fallback_reason: db ? db.ai_proposals.filter(p => p.conversation_id === dbConv(db, REF).conversation_id)
        .map(p => p.decision) : [],
    },
  };
}

// ---------------------------------------------------------------- main
(async () => {
  try {
    const cookie = await auth();
    await configAi(cookie, {});
    let report;
    if (SCENARIO === 'conc') report = await scenarioConc(cookie);
    else if (SCENARIO === 'timeout') report = await scenarioTimeout(cookie);
    else report = await scenarioRepro(cookie);
    if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); }
    // in TOÀN BỘ report (timestamps + result) — harness đọc cả hai
    console.log('CLIENT_RESULT=' + JSON.stringify(report));
    process.exit(0);
  } catch (e) {
    console.error('CLIENT_ERROR=' + String((e && e.message) || e));
    process.exit(1);
  }
})();
