// run-sales.js — chạy Sales AI Console ở chế độ chuẩn (in-process factory):
// UI_DEMO=0, APP_DATA_MODE=persist, port 8080. Dùng cho desktop shortcut.
const { createServer } = require('./server.js');
const inst = createServer({ port: 8080, uiDemo: '0', appDataMode: 'persist' });
inst.listen();
console.log('[run-sales] Sales AI Console: http://localhost:8080 (demo=OFF, persist)');
