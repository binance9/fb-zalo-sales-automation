'use strict';
// test/_load-generator.js — TẢI CÔNG BỐ cho nghiệm thu SURI-STABILITY (chạy nền trong lúc
// matrix + stability chạy): 1 server thật của prototype trên port 8080 + 3 hội thoại mock
// nhắn liên tục MỖI 2 GIÂY 1 TIN (xoay vòng 3 khách). Đi đúng đường webhook thật
// (/api/debug/customer-message -> app.receive -> pipeline -> gate) nên tạo CPU + I/O + fs
// persist cạnh tranh — đúng "máy có tải" cho phép đo phân bố worst-case.
//
// Chạy: node test/_load-generator.js [thời_gian_giây] [port]   (mặc định chạy tới khi bị kill)
// PORT: mặc định port 0 (EPHEMERAL — in ra ở dòng đầu). 8080 = server prototype cũ (PID 15968),
// 8081 = freqtrade của chủ — CẤM đụng tiến trình của chủ, nên server tải chọn port trống.
// Log: in heartbeat mỗi 10s (số tin đã bắn + RSS). SIGTERM/SIGINT -> đóng server sạch.

const path = require('path');
const { createServer } = require('../server');

const PORT = process.argv[3] ? parseInt(process.argv[3], 10) : 0;
const ROOT = path.join(__dirname, '..', 'data', 'test-runs', 'load-server');
// [chốt local — JEV CAO-1] mặc định 600s TỰ DỪNG (0 = tới khi kill, phải truyền tường minh
// thì mới được chế độ vô hạn — trước đây để 0 là nguồn zombie load).
const DURATION_S = process.argv[2] ? parseInt(process.argv[2], 10) : 600;

const REFS = ['fb-load-1', 'fb-load-2', 'fb-load-3'];
const QUESTIONS = [
  'nến vanilla size M giá bao nhiêu vậy shop',
  'trà hoa sấy còn không ạ',
  'combo quà tặng có giảm giá không shop',
  'nến oải hương size S còn hàng không',
  'túi vỏ bọc nến màu đỏ giá nhiêu ạ',
];

async function main() {
  // dữ liệu load server làDISPOSABLE — mỗi lần chạy seed lại từ đầu (rmSync trước khi mở)
  const fs = require('fs');
  fs.rmSync(ROOT, { recursive: true, force: true });
  const inst = createServer({
    port: PORT,
    authDir: path.join(ROOT, 'auth'),
    shopsRoot: path.join(ROOT, 'shops'),
    uiDemo: '0',
    appDataMode: 'persist',
  });
  inst.listen();
  for (let i = 0; i < 100 && !inst.server.listening; i++) await new Promise(r => setTimeout(r, 20));
  const BOUND_PORT = inst.server.address().port;
  console.log(`[load] server REAL port = ${BOUND_PORT}`);
  const client = function call(method, p, { body, cookie } = {}) {
    const http = require('http');
    return new Promise((resolve, reject) => {
      const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
      const headers = {};
      if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
      if (cookie) headers.Cookie = `sid=${cookie}`;
      const req = http.request({ hostname: '127.0.0.1', port: BOUND_PORT, path: p, method, headers }, res => {
        let out = '';
        res.on('data', c => { out += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: out }));
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  };

  // ---- seed shop + go-live + bot ON (mô phỏng shop thật đang chạy bot) ----
  const setup = await client('POST', '/api/auth/setup', { body: { email: 'load@lab.vn', password: 'password123', shop_name: 'Load Shop' } });
  if (setup.status !== 200) throw new Error('setup fail: ' + setup.text.slice(0, 120));
  const sid = setup.headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
  for (const [stepId, data] of [
    ['shop-info', { name: 'Load Shop', hotline: '0900000000', address: '1 Load St Q1' }],
    ['facebook', { page_id: 'page-load', page_access_token: 'ptk-load' }],
    ['zalo', { oa_id: 'oa-load', access_token: 'zat-load' }],
    ['shipping', { ghn_token: 'ghn-load', ghn_shop_id: '222366' }],
    ['ai', { provider: 'local' }],
  ]) {
    const r = await client('POST', '/api/onboarding/complete-step', { cookie: sid, body: { stepId, data } });
    if (r.status !== 200) throw new Error('step ' + stepId + ' fail');
  }
  const ai = await client('POST', '/api/ai/test', { cookie: sid, body: {} });
  if (ai.status !== 200) throw new Error('ai test fail: ' + ai.text.slice(0, 120));
  const bot = await client('POST', '/api/settings/bot', { cookie: sid, body: { on: true } });
  if (bot.status !== 200) throw new Error('bot on fail: ' + bot.text.slice(0, 140));
  console.log(`[load] server :${PORT} sẵn sàng — shop seeded, bot ON. Bắt đầu bắn ${REFS.length} hội thoại x 1 tin/2s.`);

  let sent = 0;
  let fails = 0;
  let qi = 0;
  const t0 = Date.now();
  const timer = setInterval(async () => {
    try {
      for (const ref of REFS) {
        const text = QUESTIONS[qi % QUESTIONS.length];
        const r = await client('POST', '/api/debug/customer-message', { cookie: sid, body: { channel: 'facebook', ref, text, extra: {} } });
        if (r.status === 200) sent += 1;
        else if (fails < 3) { fails += 1; console.error(`[load] bắn tin fail (${r.status}): ${r.text.slice(0, 120)}`); }
      }
      qi += 1;
      if (sent > 0 && sent % 15 < REFS.length) {
        console.log(`[load] t+${Math.round((Date.now() - t0) / 1000)}s sent=${sent} rss=${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);
      }
      if (DURATION_S && (Date.now() - t0) / 1000 >= DURATION_S) {
        console.log(`[load] hết hạn ${DURATION_S}s — sent=${sent}. Đóng server sạch.`);
        clearInterval(timer);
        await inst.close();
        process.exit(0);
      }
    } catch (e) {
      console.error('[load] lỗi bắn tin:', e && e.message);
    }
  }, 2000);

  process.on('SIGTERM', () => { clearInterval(timer); inst.close().then(() => process.exit(0)); });
  process.on('SIGINT', () => { clearInterval(timer); inst.close().then(() => process.exit(0)); });
}

main().catch(e => { console.error('[load][fatal]', e); process.exit(1); });
