'use strict';
// test/_boot-async-server.js — BOOT WRAPPER server prototype cho gate SURI-ASYNC (test-infra).
//
// Dựng createServer với PORT + authDir/shopsRoot CÔ LẬP (dưới data/test-runs/async-<tag>)
// để KHÔNG đụng data thật của chủ (data/shops, data/auth) và không chiếm 8080/8081.
// Nhận env/argv: --port N --tag name --app-data-mode persist|reset
// In "PROTO_PORT=<p>" khi listen xong; tắt sạch khi nhận SIGINT/SIGTERM (exit 0).
//
// Dùng bởi: test/_async-client.js (orchestrator mode) — tiến trình server ĐỘC LẬP với client.

const path = require('path');
const fs = require('fs');
const { createServer } = require('../server');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const PORT = Number(arg('port', process.env.PORT || 0));
const TAG = String(arg('tag', 'repro'));
const MODE = String(arg('app-data-mode', 'persist')).toLowerCase();
const ROOT = path.join(__dirname, '..', 'data', 'test-runs', `async-${TAG}`);

const inst = createServer({
  port: PORT,
  appDataMode: MODE,     // persist: nạp lại db.json qua restart (P7) — reset: sạch mỗi lần
  uiDemo: '1',           // demo seed + bot ON ban đầu (không phải đi go-live checklist trong repro)
  authDir: path.join(ROOT, 'auth'),
  shopsRoot: path.join(ROOT, 'shops'),
  // GHI RÕ: KHÔNG tiêm aiHttpFn — server dùng đường HTTP THẬT của live-http (spawnSync curl
  // trước vá / spawn async sau vá) trỏ vào slow-ai-mock qua ai_base_url của shop.
});

inst.listen(() => {
  const bound = inst.server.address();
  console.log(`PROTO_PORT=${bound.port}`);
  console.log(`[boot-async] tag=${TAG} mode=${MODE} root=${ROOT} bound=${bound.address}:${bound.port}`);
  // SURI-ASYNC test-infra: in stats của SalesAI (engine/fallback reason) để chẩn đoán đường LLM.
  if (String(process.env.ASYNC_STATS || '') === '1') {
    setInterval(() => {
      for (const [shopId, app] of inst.auth ? require('../src/util') && iterateApps(inst) : []) {
        console.log(`[stats][${shopId}] ai=${JSON.stringify(app.ai.stats)} engine=${app.ai.lastEngine} base_url=${app.settings.get('ai_base_url')}`);
      }
    }, 4000).unref();
  }
});
function iterateApps(inst) {
  // getApp chỉ nhận shopId — liệt kê qua auth shops
  const out = [];
  try {
    const shopsRoot = path.join(ROOT, 'shops');
    for (const d of fs.readdirSync(shopsRoot)) {
      const app = inst.getApp(d);
      if (app) out.push([d, app]);
    }
  } catch (e) { /* ignore */ }
  return out;
}

function shutdown() {
  try { inst.close(() => process.exit(0)); } catch (e) { process.exit(0); }
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
