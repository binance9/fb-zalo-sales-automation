'use strict';
// settings-post.js — test route POST /api/settings (whitelist key, bool coerce, guard 401).
// Dùng factory createServer của server.js (trả { server, listen, close, auth, getApp, port }),
// TEMP dirs cô lập — không đụng data/ của project, không đụng server 8080 đang chạy.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createServer } = require('../server.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-post-'));
  const inst = createServer({
    port: 0,
    authDir: path.join(tmp, 'auth'),
    shopsRoot: path.join(tmp, 'shops'),
    uiDemo: '0',
    appDataMode: 'persist',
  });
  inst.listen();
  for (let i = 0; i < 60 && !inst.server.listening; i++) await new Promise(r => setTimeout(r, 20));
  const base = 'http://127.0.0.1:' + inst.server.address().port;

  const j = (method, p, body, token) => new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    if (token) headers.Cookie = 'sid=' + token;
    const req = http.request(base + p, { method, headers }, res => {
      let out = '';
      res.on('data', c => { out += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(out); } catch (e) { json = null; }
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });

  const setup = await j('POST', '/api/auth/setup',
    { email: 'owner@test.vn', password: 'MatKhau@123', shop_name: 'Shop Test' });
  const setCookie = setup.headers['set-cookie'] || [];
  const token = (setCookie[0] || '').split(';')[0].replace(/^sid=/, '');
  ok(setup.status === 200 && token, 'setup OWNER + cookie sid');

  // POST công tắc comment (đúng payload UI gửi)
  const w = await j('POST', '/api/settings',
    { auto_reply_comment: false, hide_negative_comment: true, auto_inbox_from_comment: 'false' }, token);
  ok(w.status === 200, 'POST settings 200');
  ok(w.json && w.json.config_keys && w.json.config_keys.auto_reply_comment === false
    && w.json.config_keys.auto_inbox_from_comment === false, 'bool + string "false" đều ép về false');

  // Whitelist: key lạ + secret bị bỏ qua, key hợp lệ vẫn ghi
  const w2 = await j('POST', '/api/settings',
    { HACK_KEY: 'x', GHN_TOKEN: 'leak-attempt', shop_hotline: '0900123456' }, token);
  ok(w2.status === 200, 'POST whitelist 200 (key hợp lệ vẫn ghi)');
  ok(w2.json.config_keys.shop_hotline === '0900123456', 'shop_hotline ghi đúng');
  ok(w2.json.config_keys.HACK_KEY === undefined && w2.json.config_keys.GHN_TOKEN === undefined,
    'key lạ + secret bị chặn khỏi whitelist');

  // Body chỉ key lạ -> 400
  const w3 = await j('POST', '/api/settings', { KHONGCO: 1 }, token);
  ok(w3.status === 400 && w3.json.error === 'NO_VALID_KEY', 'chỉ key lạ -> 400 NO_VALID_KEY');

  // Chưa login -> 401 (route nằm sau auth guard)
  const w4 = await j('POST', '/api/settings', { shop_hotline: 'x' });
  ok(w4.status === 401, 'chưa login -> 401');

  console.log(`settings-post: ${pass}/${pass + fail} PASS`);
  inst.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
