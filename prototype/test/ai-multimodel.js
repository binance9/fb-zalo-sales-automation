'use strict';
// test/ai-multimodel.js — AICAKE G3: ĐA MODEL AI (offline 100% — KHÔNG gọi mạng thật).
//
// Kiểm tra 5 provider LLM (deepseek, openai, gemini, grok, kimi) qua HTTP in-process port 0
// (boot bằng factory createServer + TEMP dirs — cùng pattern test/matrix/_harness.js):
//   (a) 5 provider đều config được qua POST /api/ai/config (saveAiConfig) + GET /api/ai/status
//       trả đúng defaultModel + base_url;
//   (b) provider lạ -> từ chối 400 BAD_PROVIDER (config hiện tại không đổi);
//   (c) api_key chỉ trả masked '***' + 4 ký tự cuối trong /api/ai/status (không lộ key thô);
//   (d) base_url ngoài allowlist -> bị chặn theo rule hiện có (400 BAD_BASE_URL:...,
//       cấu hình bẩn KHÔNG vào DB);
//   (e) GET /api/ai/status liệt kê đủ 5 provider cho UI chọn (providers[] + defaultModel)
//       + wire OpenAI-style: url kết thúc /chat/completions + allowlist đủ 5 host.
// Exit 0 khi toàn bộ PASS, in "ai-multimodel: X/X PASS".

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { createServer } = require('../server');
const { PROVIDERS, aiBaseUrlCheck } = require('../src/ai-provider');

const NET_PROVIDERS = ['deepseek', 'openai', 'gemini', 'grok', 'kimi']; // 5 provider mạng (local = stub nội bộ, khỏi đếm)
const DATA = path.join(__dirname, '..', 'data', 'test-runs');
const dir = name => path.join(DATA, 'ai-multimodel-' + name);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============================================================ HTTP helper (thuần node http)
function makeClient(base) {
  const u0 = new URL(base);
  return function call(method, p, { body, cookie } = {}) {
    return new Promise((resolve, reject) => {
      const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
      const headers = {};
      if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
      if (cookie) headers.Cookie = `sid=${cookie}`;
      const req = http.request({
        hostname: u0.hostname, port: u0.port, path: p, method, headers,
      }, res => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch (e) { /* html */ }
          resolve({ status: res.statusCode, headers: res.headers, json, text: raw });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  };
}

async function startServer(name) {
  // TEMP dirs riêng từng lần chạy — dữ liệu auth/shop SẠCH, không đụng data chạy thật.
  const root = dir(name);
  fs.rmSync(root, { recursive: true, force: true });
  const inst = createServer({
    port: 0,
    authDir: path.join(root, 'auth'),
    shopsRoot: path.join(root, 'shops'),
    uiDemo: '0',
    appDataMode: 'persist',
  });
  inst.listen();
  for (let i = 0; i < 60 && !inst.server.listening; i++) await sleep(20);
  inst.client = makeClient(`http://127.0.0.1:${inst.server.address().port}`);
  return inst;
}

// ============================================================ tests
const TESTS = [];
const T = (n, desc, fn) => TESTS.push({ n, desc, fn });

let inst, sid; // server + cookie OWNER

T('M1', '(a) 5 provider đều config được qua saveAiConfig + status trả đúng defaultModel + base_url=null', async () => {
  for (const p of NET_PROVIDERS) {
    const save = await inst.client('POST', '/api/ai/config', { cookie: sid, body: { provider: p, api_key: 'sk-m1-' + p + '-0000' } });
    assert.strictEqual(save.status, 200, `${p}: save 200 (got ${save.status})`);
    const st = await inst.client('GET', '/api/ai/status', { cookie: sid });
    assert.strictEqual(st.status, 200, `${p}: status 200`);
    assert.strictEqual(st.json.ai.provider, p, `${p}: provider đúng`);
    assert.strictEqual(st.json.ai.model, PROVIDERS[p].defaultModel, `${p}: model mặc định đúng (${PROVIDERS[p].defaultModel})`);
    assert.strictEqual(st.json.ai.base_url, null, `${p}: base_url mặc định null (dùng URL của provider)`);
  }
});

T('M2', '(a) 3 provider mới nhận base_url trên host allowlist của chính nó + status trả lại đúng', async () => {
  const custom = {
    gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    grok: 'https://api.x.ai/v1/chat/completions',
    kimi: 'https://api.moonshot.cn/v1/chat/completions',
  };
  for (const p of ['gemini', 'grok', 'kimi']) {
    const save = await inst.client('POST', '/api/ai/config', { cookie: sid, body: { provider: p, api_key: 'sk-m2-' + p + '-0000', base_url: custom[p] } });
    assert.strictEqual(save.status, 200, `${p}: base_url host riêng -> 200 (got ${save.status} ${save.json && save.json.error})`);
    const st = await inst.client('GET', '/api/ai/status', { cookie: sid });
    assert.strictEqual(st.json.ai.base_url, custom[p], `${p}: status trả lại đúng base_url đã lưu`);
    // dọn về mặc định (base_url rỗng => xoá) cho case sau
    const clr = await inst.client('POST', '/api/ai/config', { cookie: sid, body: { provider: p, api_key: 'sk-m2-' + p + '-0000', base_url: '' } });
    assert.strictEqual(clr.status, 200, `${p}: clear base_url -> 200`);
  }
});

T('M3', '(b) provider lạ -> từ chối 400 BAD_PROVIDER + config hiện tại không đổi', async () => {
  // cấu hình hợp lệ trước để so sánh
  await inst.client('POST', '/api/ai/config', { cookie: sid, body: { provider: 'gemini', api_key: 'sk-m3-gemini-0000' } });
  for (const weird of ['claude', 'gpt5', '', 'local-network-fake']) {
    const r = await inst.client('POST', '/api/ai/config', { cookie: sid, body: { provider: weird, api_key: 'sk-m3-x-0000' } });
    assert.strictEqual(r.status, 400, `provider '${weird}' -> 400 (got ${r.status})`);
    assert.strictEqual(r.json && r.json.error, 'BAD_PROVIDER', `provider '${weird}' -> error BAD_PROVIDER`);
  }
  const st = await inst.client('GET', '/api/ai/status', { cookie: sid });
  assert.strictEqual(st.json.ai.provider, 'gemini', 'provider lạ không ghi đè config hiện tại');
});

T('M4', '(c) api_key masked "***xxxx" trong /api/ai/status — không lộ key thô', async () => {
  const key = 'sk-multimodel-ab12cd34';
  const save = await inst.client('POST', '/api/ai/config', { cookie: sid, body: { provider: 'grok', api_key: key } });
  assert.strictEqual(save.status, 200);
  assert.strictEqual(save.json.ai.api_key_masked, '***cd34', 'save view mask đúng');
  const st = await inst.client('GET', '/api/ai/status', { cookie: sid });
  assert.strictEqual(st.json.ai.api_key_masked, '***cd34', 'status mask đúng *** + 4 ký tự cuối');
  assert.ok(/^\*\*\*[A-Za-z0-9]{4}$/.test(st.json.ai.api_key_masked), 'đúng format ***xxxx');
  assert.ok(!JSON.stringify(st.json).includes(key), 'key thô KHÔNG xuất hiện trong status');
});

T('M5', '(d) base_url ngoài allowlist -> chặn theo rule hiện có (400 BAD_BASE_URL, không vào DB)', async () => {
  // lưu trước 1 config hợp lệ kimi để so sánh "bẩn không vào DB"
  const ok = await inst.client('POST', '/api/ai/config', { cookie: sid, body: { provider: 'kimi', api_key: 'sk-m5-kimi-0000' } });
  assert.strictEqual(ok.status, 200, 'kimi config hợp lệ -> 200');
  const bads = [
    { url: 'https://evil.example.com/v1/chat/completions', reason: 'host_not_allowlisted' },
    { url: 'http://169.254.169.254/latest/meta-data', reason: 'https_required' }, // metadata IP + http
    { url: 'https://10.0.0.5/v1', reason: 'private_or_unapproved_ip' },
    // file:// rơi vào bước validate format hiện có (regex ^https?://) -> BAD_BASE_URL trơn
    { url: 'file:///etc/passwd', reason: '' },
  ];
  for (const b of bads) {
    const r = await inst.client('POST', '/api/ai/config', { cookie: sid, body: { provider: 'kimi', api_key: 'sk-m5-kimi-0000', base_url: b.url } });
    assert.strictEqual(r.status, 400, `base_url ${b.url} -> 400 (got ${r.status})`);
    const expected = b.reason ? 'BAD_BASE_URL:' + b.reason : 'BAD_BASE_URL';
    assert.strictEqual(r.json && r.json.error, expected, `chặn đúng lý do: ${b.reason || 'format không phải http(s)'}`);
  }
  const st = await inst.client('GET', '/api/ai/status', { cookie: sid });
  assert.strictEqual(st.json.ai.base_url, null, 'cấu hình bẩn KHÔNG vào DB (base_url vẫn null)');
  assert.strictEqual(st.json.ai.provider, 'kimi', 'config hợp lệ trước đó vẫn giữ');
});

T('M6', '(e) /api/ai/status liệt kê đủ 5 provider cho UI chọn + wire OpenAI-style + allowlist đủ host', async () => {
  const st = await inst.client('GET', '/api/ai/status', { cookie: sid });
  assert.strictEqual(st.status, 200);
  const list = st.json.ai.providers;
  assert.ok(Array.isArray(list) && list.length >= 5, 'status có providers[] cho UI');
  const byId = Object.fromEntries(list.map(x => [x.id, x]));
  for (const p of NET_PROVIDERS) {
    assert.ok(byId[p], `providers[] có '${p}'`);
    assert.strictEqual(byId[p].defaultModel, PROVIDERS[p].defaultModel, `${p}: defaultModel khớp map`);
  }
  // wire OpenAI-style: cả 5 url đều endpoint /chat/completions (dùng chung đường testAiProvider/_tryLLM)
  for (const p of NET_PROVIDERS) {
    assert.ok(/\/chat\/completions$/.test(PROVIDERS[p].url), `${p}: url OpenAI-style (${PROVIDERS[p].url})`);
  }
  // allowlist chứa đủ 5 host mặc định — kiểm QUA RULE THẬT aiBaseUrlCheck (deep defense tầng CALL
  // cho base_url tuỳ chỉnh; hằng AI_BASE_URL_ALLOW nội bộ không export — test hành vi, không test nội bộ).
  for (const host of ['api.deepseek.com', 'api.openai.com', 'generativelanguage.googleapis.com', 'api.x.ai', 'api.moonshot.cn']) {
    assert.strictEqual(aiBaseUrlCheck('https://' + host + '/chat/completions').ok, true, `allowlist cho phép https://${host}`);
  }
});

// ============================================================ runner
async function main() {
  console.log('===== AI MULTIMODEL (AICAKE G3) — offline, HTTP in-process port 0 =====');
  inst = await startServer('main');
  // setup OWNER đầu tiên
  const setup = await inst.client('POST', '/api/auth/setup', { body: { email: 'owner@multi.vn', password: 'password123', shop_name: 'Multi Shop' } });
  if (setup.status !== 200) throw new Error('setup fail: ' + setup.text.slice(0, 120));
  sid = setup.headers['set-cookie'][0].match(/sid=([^;]+)/)[1];

  let pass = 0;
  for (const t of TESTS) {
    try {
      await t.fn();
      pass += 1;
      console.log(`  [PASS] ${t.n} — ${t.desc}`);
    } catch (err) {
      console.log(`  [FAIL] ${t.n} — ${t.desc}\n         -> ${String(err && err.message).split('\n').slice(0, 4).join(' | ')}`);
    }
  }
  try { await inst.close(); } catch (e) { /* ignore */ }
  console.log(`\nai-multimodel: ${pass}/${TESTS.length} PASS`);
  process.exitCode = pass === TESTS.length ? 0 : 1;
}

main().catch(err => { console.error('[fatal]', err); process.exitCode = 1; });
