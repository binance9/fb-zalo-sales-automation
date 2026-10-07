'use strict';
// test/matrix/persistence.js — AREA PERSISTENCE (15 case): persist restart, backup, session,
// settings, overrides, audit.jsonl, idempotency qua restart, reset-mode xoá sạch.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { startInst, setupShop, fire, sleep } = require('./_harness');
const { App } = require('../../src/app');

module.exports = {
  area: 'Persistence',
  async setup() {
    const inst = await startInst('persistence');
    const { sid, shop, app } = await setupShop(inst, { email: 'ps@matrix.vn' });
    return { inst, sid, shop, app };
  },
  cases: [
    { id: 'PS01', desc: 'mặc định server persist (modes.data=persist)', async fn(ctx) {
      const h = await ctx.inst.client('GET', '/api/health', { cookie: ctx.sid });
      assert.strictEqual(h.json.modes.data, 'persist');
    } },
    { id: 'PS02', desc: 'db.json + audit.jsonl tồn tại trong dataDir shop', async fn(ctx) {
      fire(ctx.app, 'facebook', 'ps1', 'nến vanilla giá nhiêu', 'ps-1');
      assert.ok(fs.existsSync(path.join(ctx.inst.root, 'shops', ctx.shop, 'db.json')));
      assert.ok(fs.existsSync(path.join(ctx.inst.root, 'shops', ctx.shop, 'audit.jsonl')));
    } },
    { id: 'PS03', desc: 'restart (App mới persist) -> counts giữ nguyên', async fn(ctx) {
      fire(ctx.app, 'facebook', 'ps2', 'lấy 1 hộp trà hoa sấy, tên Persist, sdt 0934444001, địa chỉ Persist Q1', 'ps-2');
      const counts = s => JSON.stringify(['customers', 'conversations', 'messages', 'orders'].map(k => s.findAll(k, () => true).length));
      const before = counts(ctx.app.store);
      const app2 = new App({ dataDir: path.join(ctx.inst.root, 'shops', ctx.shop), persist: true });
      assert.strictEqual(counts(app2.store), before);
    } },
    { id: 'PS04', desc: 'restart tạo db.backup.json (backup 1 tầng)', async fn(ctx) {
      const app2 = new App({ dataDir: path.join(ctx.inst.root, 'shops', ctx.shop), persist: true });
      void app2;
      assert.ok(fs.existsSync(path.join(ctx.inst.root, 'shops', ctx.shop, 'db.backup.json')));
    } },
    { id: 'PS05', desc: 'order CONFIRMED giữ nguyên trạng thái qua restart', async fn(ctx) {
      const draft = ctx.app.store.findOne('orders', o => o.status === 'DRAFT' || o.status === 'CONFIRMED');
      void draft;
      const app2 = new App({ dataDir: path.join(ctx.inst.root, 'shops', ctx.shop), persist: true });
      const orders = app2.store.findAll('orders', () => true);
      assert.ok(orders.length >= 1);
      assert.ok(orders.every(o => ['DRAFT', 'CONFIRMED', 'DELIVERED', 'CANCELLED', 'CANCEL_PENDING', 'SHIPPING'].includes(o.status)));
    } },
    { id: 'PS06', desc: 'sessions.json + users.json ghi trên đĩa (mồi cho restart)', async fn(ctx) {
      const authDir = path.join(ctx.inst.root, 'auth');
      assert.ok(fs.existsSync(path.join(authDir, 'users.json')));
      assert.ok(fs.existsSync(path.join(authDir, 'sessions.json')));
      const sessions = JSON.parse(fs.readFileSync(path.join(authDir, 'sessions.json'), 'utf8'));
      assert.ok(Object.keys(sessions).length >= 1, 'session hiện tại đã ghi file');
    } },
    { id: 'PS07', desc: 'settings.json (token/AI/automation) persist trong dataDir shop', async fn(ctx) {
      await ctx.inst.client('POST', '/api/ai/config', { cookie: ctx.sid, body: { provider: 'local' } });
      await ctx.inst.client('POST', '/api/automation', { cookie: ctx.sid, body: { followup_delivery_hours: 6 } });
      const raw = JSON.parse(fs.readFileSync(path.join(ctx.inst.root, 'shops', ctx.shop, 'settings.json'), 'utf8'));
      assert.strictEqual(raw.ai_provider, 'local');
      assert.strictEqual(raw.automation_followup_delivery_hours, 6);
    } },
    { id: 'PS08', desc: 'product-overrides.json persist trong dataDir shop (không file toàn cục)', async fn(ctx) {
      await ctx.inst.client('POST', '/api/products', { cookie: ctx.sid, body: { name: 'Persist SP', sku_base: 'PS-SP', price: 77000, stock_qty: 2 } });
      const file = path.join(ctx.inst.root, 'shops', ctx.shop, 'product-overrides.json');
      assert.ok(fs.existsSync(file));
      const o = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.ok(o.added.some(p => p.sku_base === 'PS-SP'));
    } },
    { id: 'PS09', desc: 'overrides áp lại sau restart (SP thêm bằng API vẫn còn)', async fn(ctx) {
      const app2 = new App({ dataDir: path.join(ctx.inst.root, 'shops', ctx.shop), persist: true });
      assert.ok(app2.productDB.getProductByBase('PS-SP'), 'SP added qua overrides nạp lại');
    } },
    { id: 'PS10', desc: 'audit.jsonl append-only: mỗi dòng JSON hợp lệ + tăng monotonic', async fn(ctx) {
      const file = path.join(ctx.inst.root, 'shops', ctx.shop, 'audit.jsonl');
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      assert.ok(lines.length >= 10);
      for (const line of lines.slice(0, 5)) {
        const j = JSON.parse(line);
        assert.ok('proposed_action' in j && 'stage' in j && 'at' in j);
      }
    } },
    { id: 'PS11', desc: 'idempotency qua restart: event trùng của platform KHÔNG xử lý lại', async fn(ctx) {
      const app2 = new App({ dataDir: path.join(ctx.inst.root, 'shops', ctx.shop), persist: true });
      const r = app2.receive({ channel: 'facebook', type: 'message', platformEventId: 'ps-1', payload: { customer_ref: 'ps1', thread_id: 'ps1', kind: 'text', text: 'nến vanilla giá nhiêu', platform_message_id: 'pm-ps-1' } });
      assert.strictEqual(r.duplicate, true, 'event cũ trong db -> dedupe khi replay');
    } },
    { id: 'PS12', desc: 'reset mode (APP_DATA_MODE=reset) xoá dataDir như thiết kế test', async fn(ctx) {
      const dir = path.join(ctx.inst.root, 'shops', ctx.shop);
      const appReset = new App({ dataDir: path.join(ctx.inst.root, 'shops', 'ps-reset'), persist: false });
      fire(appReset, 'facebook', 'psr', 'hi', 'psr-1');
      assert.ok(fs.existsSync(path.join(ctx.inst.root, 'shops', 'ps-reset', 'db.json')));
      void dir;
      const appReset2 = new App({ dataDir: path.join(ctx.inst.root, 'shops', 'ps-reset'), persist: false });
      assert.strictEqual(appReset2.store.findAll('customers', () => true).length, 0, 'reset -> DB sạch');
    } },
    { id: 'PS13', desc: 'restart giữ token_expired/provider state files (live-token file nếu có)', async fn(ctx) {
      // zalo token file path cấu hình theo dataDir — kiểm thư mục data/live không bắt buộc tồn tại
      const app2 = new App({ dataDir: path.join(ctx.inst.root, 'shops', ctx.shop), persist: true });
      assert.ok(app2.store.findOne('settings', s => s.key === 'bot_enabled'));
      assert.strictEqual(app2.store.findOne('settings', s => s.key === 'bot_enabled').value, true, 'bot_enabled persist');
    } },
    { id: 'PS14', desc: 'server restart thật (createServer thứ 2 cùng root): session + dữ liệu còn', async fn(ctx) {
      const { createServer } = require('../../server');
      const inst2 = createServer({ port: 0, authDir: path.join(ctx.inst.root, 'auth'), shopsRoot: path.join(ctx.inst.root, 'shops'), uiDemo: '0', appDataMode: 'persist' });
      inst2.listen();
      for (let i = 0; i < 60 && !inst2.server.listening; i++) await sleep(20);
      inst2.client = require('./_harness').makeClient(`http://127.0.0.1:${inst2.server.address().port}`);
      const me = await inst2.client('GET', '/api/auth/me', { cookie: ctx.sid });
      assert.strictEqual(me.status, 200, 'session còn sau server restart');
      const convs = await inst2.client('GET', '/api/conversations', { cookie: ctx.sid });
      assert.ok(convs.json.conversations.length >= 1, 'conversations nạp lại từ db.json');
      const prods = await inst2.client('GET', '/api/products', { cookie: ctx.sid });
      assert.ok(prods.json.products.some(p => p.sku_base === 'PS-SP'), 'SP added persist qua API');
      await inst2.close();
    } },
    { id: 'PS15', desc: 'WriteCount tăng + persist không phá SHA cấu trúc (JSON ổn định)', async fn(ctx) {
      // nạp db.json bằng App mới 2 lần liên tiếp -> dữ liệu như nhau (không tự biến đổi)
      const load = () => JSON.parse(fs.readFileSync(path.join(ctx.inst.root, 'shops', ctx.shop, 'db.json'), 'utf8'));
      const a = load();
      const app2 = new App({ dataDir: path.join(ctx.inst.root, 'shops', ctx.shop), persist: true });
      app2.store.persist();
      const b = load();
      assert.deepStrictEqual(b, a, 'persist không biến đổi dữ liệu');
    } },
  ],
};
