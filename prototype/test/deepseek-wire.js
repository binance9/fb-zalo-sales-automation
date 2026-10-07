'use strict';
// test/deepseek-wire.js — DEEPSEEK LIVE WIRE (SURI P1, hạng mục 4).
//
// (a) WIRE đọc đúng FILE THẬT của chủ (provider_config.json ngoài project) — mask assert:
//     output/chứng minh KHÔNG chứa key thô, maskedKey = '***' + 4 cuối.
// (b) GỌI THẬT: POST /api/ai/wire-deepseek -> wire + test 1 request /chat/completions thật.
//     Key hợp lệ + mạng thông  -> status ONLINE (assert).
//     Key hết hạn / mạng lỗi   -> status ERROR ghi LÕI THẬT (error code) — KHÔNG fake PASS.
// Exit 0 khi (a) PASS và (b) trả về KẾT QUẢ THẬT (ONLINE hoặc ERROR có lý do rõ).
// KHÔNG BAO GIỜ in key ra console.

const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { createServer } = require('../server');
const { readDeepseekRule, wireDeepseek, DEFAULT_PROVIDER_CONFIG_PATH } = require('../src/deepseek-wire');
const { ShopSettings } = require('../src/shop-settings');

const DATA = path.join(__dirname, '..', 'data', 'test-runs', 'suri-deepseek');
const REAL_PATH = process.env.DEEPSEEK_PROVIDER_CONFIG || DEFAULT_PROVIDER_CONFIG_PATH;

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

async function main() {
  console.log('== DEEPSEEK LIVE WIRE ==');
  console.log(`provider config: ${fs.existsSync(REAL_PATH) ? REAL_PATH : '(KHÔNG TỒN TẠI — ' + REAL_PATH + ')'}`);

  // ---------------- (a) WIRE đọc file thật + mask assert ----------------
  let rawKey = null;
  assert.ok(fs.existsSync(REAL_PATH), 'file provider config phải tồn tại trên máy chủ: ' + REAL_PATH);
  const rule = readDeepseekRule(REAL_PATH);
  assert.ok(rule.ok, 'đọc được rule deepseek: ' + (rule.reason || ''));
  assert.ok(/^sk-/.test(rule.apiKey), 'apiKey format sk-');
  rawKey = rule.apiKey;

  const ssDir = path.join(DATA, 'wire-settings');
  fs.rmSync(ssDir, { recursive: true, force: true });
  const ss = new ShopSettings(ssDir);
  const w = wireDeepseek(ss, { file: REAL_PATH });
  assert.strictEqual(w.provider, 'deepseek');
  assert.strictEqual(w.baseUrl, 'https://api.deepseek.com/v1');
  assert.deepStrictEqual(w.models, ['deepseek-flash', 'deepseek-v4-pro']);
  // MASK ASSERT — mọi output của wire không được chứa key (cả đầu lẫn nguyên văn)
  const flat = JSON.stringify(w);
  assert.ok(!flat.includes(rawKey), 'wire output KHÔNG chứa key thô');
  assert.ok(!flat.includes(rawKey.slice(0, 14)), 'wire output KHÔNG chứa đầu key');
  assert.strictEqual(w.maskedKey, '***' + rawKey.slice(-4), 'maskedKey đúng format');
  assert.strictEqual(ss.get('ai_provider'), 'deepseek', 'settings shop đã ghi provider');
  console.log(`(a) WIRE OK — provider=deepseek model=${w.model} maskedKey=${w.maskedKey} models=${JSON.stringify(w.models)}`);

  // ---------------- (b) GỌI THẬT qua HTTP API ----------------
  const root = path.join(DATA, 'server');
  fs.rmSync(root, { recursive: true, force: true });
  const inst = createServer({ port: 0, authDir: path.join(root, 'auth'), shopsRoot: path.join(root, 'shops'), uiDemo: '0', appDataMode: 'persist' });
  inst.listen();
  for (let i = 0; i < 60 && !inst.server.listening; i++) await new Promise(r => setTimeout(r, 20));
  const client = makeClient(`http://127.0.0.1:${inst.server.address().port}`);
  const setup = await client('POST', '/api/auth/setup', { body: { email: 'ds@test.dev', password: 'password123', shop_name: 'DS Shop' } });
  assert.strictEqual(setup.status, 200);
  const sid = setup.headers['set-cookie'][0].match(/sid=([^;]+)/)[1];

  const r = await client('POST', '/api/ai/wire-deepseek', { cookie: sid, body: {} });
  const body = r.json || {};
  // response KHÔNG BAO GIỜ chứa key thô
  assert.ok(!r.text.includes(rawKey), 'API response KHÔNG chứa key thô');
  assert.ok(!r.text.includes(rawKey.slice(0, 14)), 'API response KHÔNG chứa đầu key');

  if (r.status === 200 && body.status === 'ONLINE') {
    assert.strictEqual(body.maskedKey, '***' + rawKey.slice(-4));
    assert.strictEqual(body.model, 'deepseek-chat');
    console.log(`(b) LIVE: ONLINE — model=${body.model} maskedKey=${body.maskedKey} (đã gọi thật /chat/completions)`);
  } else {
    // key hết hạn / mạng lỗi — ghi ERROR THẬT, KHÔNG fake
    assert.strictEqual(body.status, 'ERROR', 'status phải là ERROR khi không ONLINE: ' + r.text.slice(0, 200));
    assert.ok(body.error, 'ERROR phải kèm lý do (error code)');
    console.log(`(b) LIVE: ERROR (ghi thật, không fake) — error=${body.error} maskedKey=${body.maskedKey || '(n/a)'}`);
    console.log('    Lý do có thể: key hết hạn/hết credit, mạng chặn api.deepseek.com, hoặc timeout.');
  }
  // /api/ai/test độc lập (chạy lại request thật thứ 2) — status phải khớp kết quả vừa ghi
  const t = await client('POST', '/api/ai/test', { cookie: sid, body: {} });
  console.log(`(/api/ai/test) status=${t.status} ai.status=${(t.json && t.json.ai && t.json.ai.status) || '?'} error=${(t.json && t.json.error) || '-'}`);

  await inst.close();
  const maskedTail = rawKey.slice(-4);
  console.log(`== KẾT QUẢ: (a) PASS; (b) ${body.status} — maskedKey ***${maskedTail} ==`);
  setTimeout(() => process.exit(0), 50).unref();
}

main().catch(e => { console.error('FATAL:', e && e.message); process.exit(1); });
