'use strict';
// test/slow-ai-mock.js — MOCK AI SERVER CHẬM (OpenAI-compatible) cho gate SURI-ASYNC (LỖI 2).
//
// MỤC ĐÍCH: mô phỏng LLM trả lời SAU `delay` ms để đo việc đường propose chờ kết quả —
// BEFORE (sync spawnSync curl) chặn event loop trọn delay; AFTER (httpOnceAsync) không chặn.
// KHÔNG RA MẠNG — server này chỉ lắng nghe 127.0.0.1; shop AI trỏ vào đây qua ai_base_url.
//
// Hợp đồng: POST .../chat/completions (OpenAI-compatible, khớp deepseek-wire/ai-provider)
//   - body {model, messages, max_tokens, ...}
//   - max_tokens <= 1 HOẶC messages cuối == 'ping'  -> TRẢ NGAY (cho POST /api/ai/test)
//   - còn lại -> trả sau `delay` ms (mặc định 6000; ?delay= / header x-mock-delay / env)
//   - réponse: {id, choices:[{message:{role:'assistant', content: ANSWER}}]}
// Mỗi request ghi 1 dòng log JSON ra stdout: {t, kind, delay, model} — client dùng đối soát.
//
// Chạy: node test/slow-ai-mock.js [port] [delayMs]   (port 0 = ephemeral, in ra "MOCK_PORT=<p>")

const http = require('http');

const DEFAULT_ANSWER = 'Dạ nến thơm vanilla size M giá 185.000đ nha anh/chị ạ!';

function startSlowAiMock({ port = 0, delayMs = 6000, answer = DEFAULT_ANSWER } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const t0 = Date.now();
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch (e) { body = {}; }
      const lastMsg = Array.isArray(body.messages) && body.messages.length
        ? String(body.messages[body.messages.length - 1].content || '') : '';
      const isPing = Number(body.max_tokens) <= 1 || lastMsg === 'ping';
      const qDelay = Number((req.url.match(/[?&]delay=(\d+)/) || [])[1]);
      const hDelay = Number(req.headers['x-mock-delay']);
      const d = isPing ? 0 : (Number.isFinite(qDelay) && qDelay > 0 ? qDelay
        : (Number.isFinite(hDelay) && hDelay > 0 ? hDelay : delayMs));
      const entry = { t: new Date().toISOString(), kind: isPing ? 'ping' : 'chat', delay: d, model: body.model || null };
      requests.push(entry);
      try { process.stdout.write('[slow-ai-mock] ' + JSON.stringify(entry) + '\n'); } catch (e) { /* ignore */ }
      const reply = () => {
        const payload = JSON.stringify({
          id: 'chatcmpl-mock-' + Date.now(),
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(payload);
        entry.served_at = new Date().toISOString();
        entry.took_ms = Date.now() - t0;
      };
      if (d > 0) setTimeout(reply, d); else reply();
    });
  });
  return {
    server,
    requests,
    listen(cb) { server.listen(port, '127.0.0.1', cb); },
    close(cb) { server.close(cb); },
    get port() { return server.address().port; },
  };
}

module.exports = { startSlowAiMock, DEFAULT_ANSWER };

if (require.main === module) {
  const port = Number(process.argv[2] || 0);
  const delayMs = Number(process.argv[3] || 6000);
  const inst = startSlowAiMock({ port, delayMs });
  inst.listen(() => {
    console.log(`MOCK_PORT=${inst.port}`);
    console.log(`[slow-ai-mock] listening 127.0.0.1:${inst.port} delay=${delayMs}ms`);
  });
  process.on('SIGINT', () => inst.close(() => process.exit(0)));
  process.on('SIGTERM', () => inst.close(() => process.exit(0)));
}
