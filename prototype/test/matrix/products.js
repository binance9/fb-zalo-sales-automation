'use strict';
// test/matrix/products.js — AREA PRODUCTS (15 case): CRUD/CSV/disabled + image-match policy.
const assert = require('assert');
const { startInst, setupShop, newApp, fire } = require('./_harness');

module.exports = {
  area: 'Products',
  async setup() {
    const inst = await startInst('products');
    const { sid, shop, app } = await setupShop(inst, { email: 'pr@matrix.vn' });
    return { inst, sid, shop, app };
  },
  cases: [
    { id: 'PR01', desc: 'GET /api/products trả catalogue seed (4 sản phẩm)', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/api/products', { cookie: ctx.sid });
      assert.strictEqual(r.status, 200);
      assert.ok(r.json.products.length >= 4);
      assert.ok(r.json.products.every(p => Array.isArray(p.variants) && p.variants.length >= 1));
    } },
    { id: 'PR02', desc: 'POST thêm sản phẩm mới -> 200 + variant sku phát sinh', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/products', { cookie: ctx.sid, body: { name: 'Nến Test MX', sku_base: 'MX-TEST', price: 99000, stock_qty: 7 } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.variant_sku, 'MX-TEST-1');
    } },
    { id: 'PR03', desc: 'POST trùng sku_base -> 409 SKU_BASE_EXISTS', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/products', { cookie: ctx.sid, body: { name: 'Trùng', sku_base: 'MX-TEST', price: 1000 } });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json.error, 'SKU_BASE_EXISTS');
    } },
    { id: 'PR04', desc: 'POST thiếu tên/sku -> 400; giá sai -> 400 BAD_PRICE', async fn(ctx) {
      assert.strictEqual((await ctx.inst.client('POST', '/api/products', { cookie: ctx.sid, body: { sku_base: 'NO-NAME', price: 1000 } })).status, 400);
      assert.strictEqual((await ctx.inst.client('POST', '/api/products', { cookie: ctx.sid, body: { name: 'X', sku_base: 'BAD-PRICE', price: -5 } })).status, 400);
    } },
    { id: 'PR05', desc: 'PUT đổi giá/tồn -> search + stock đọc giá trị mới', async fn(ctx) {
      const r = await ctx.inst.client('PUT', '/api/products/MX-TEST', { cookie: ctx.sid, body: { price: 123000, stock_qty: 5 } });
      assert.strictEqual(r.status, 200);
      const hit = ctx.app.productDB.getStock('MX-TEST-1');
      assert.strictEqual(hit.price, 123000);
      assert.strictEqual(hit.stock_qty, 5);
    } },
    { id: 'PR06', desc: 'PUT enabled=false (soft delete) -> enabled false trong list', async fn(ctx) {
      const r = await ctx.inst.client('PUT', '/api/products/MX-TEST', { cookie: ctx.sid, body: { enabled: false } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.enabled, false);
    } },
    { id: 'PR07', desc: 'DELETE = xóa mềm: 200 + SP vẫn còn trong list với enabled=false', async fn(ctx) {
      await ctx.inst.client('POST', '/api/products', { cookie: ctx.sid, body: { name: 'Sẽ Xóa', sku_base: 'DEL-ME', price: 50000, stock_qty: 1 } });
      const d = await ctx.inst.client('DELETE', '/api/products/DEL-ME', { cookie: ctx.sid });
      assert.strictEqual(d.status, 200);
      const list = await ctx.inst.client('GET', '/api/products', { cookie: ctx.sid });
      const p = list.json.products.find(x => x.sku_base === 'DEL-ME');
      assert.ok(p, 'vẫn nằm trong list (soft)');
      assert.strictEqual(p.enabled, false);
    } },
    { id: 'PR08', desc: 'DELETE SP không tồn tại -> 404', async fn(ctx) {
      assert.strictEqual((await ctx.inst.client('DELETE', '/api/products/KHONG-TON-TAI', { cookie: ctx.sid })).status, 404);
    } },
    { id: 'PR09', desc: 'CSV import: 2 hợp lệ + 1 lỗi -> imported 2, failed 1 với line number', async fn(ctx) {
      const csv = 'name,sku,price,stock\nSản phẩm A,CSV-A,10000,3\nSản phẩm B,CSV-B,20000,4\ndòng hỏng thiếu cột\nSản phẩm C,CSV-C,30000,5';
      const r = await ctx.inst.client('POST', '/api/products/import', { cookie: ctx.sid, body: { csv } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.imported, 3);
      assert.strictEqual(r.json.failed, 1);
      assert.strictEqual(r.json.errors[0].error, 'THIEU_SKU');
    } },
    { id: 'PR10', desc: 'CSV quote-aware: tên chứa phẩy trong quote vẫn parse đúng', async fn(ctx) {
      const csv = 'name,sku,price,stock\n"Combo quà tặng, gồm 2 món",CSV-Q,50000,6';
      const r = await ctx.inst.client('POST', '/api/products/import', { cookie: ctx.sid, body: { csv } });
      assert.strictEqual(r.json.imported, 1);
      const list = await ctx.inst.client('GET', '/api/products?q=CSV-Q', { cookie: ctx.sid });
      assert.match(list.json.products[0].name, /gồm 2 món/);
    } },
    { id: 'PR11', desc: 'CSV thiếu header -> lỗi HEADER_THIEU_COT; CSV rỗng -> CSV_TRONG', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/products/import', { cookie: ctx.sid, body: { csv: 'Linh tinh,và,ví dụ\nA,B,1,2' } });
      assert.strictEqual(r.json.imported, 0);
      assert.match(r.json.errors[0].error, /HEADER/);
      const r2 = await ctx.inst.client('POST', '/api/products/import', { cookie: ctx.sid, body: { csv: '   ' } });
      assert.strictEqual(r2.json.errors[0].error, 'CSV_TRONG');
    } },
    { id: 'PR12', desc: 'search ?q= theo SKU khớp duy nhất', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/api/products?q=CSV-A', { cookie: ctx.sid });
      assert.strictEqual(r.json.products.length, 1);
      assert.strictEqual(r.json.products[0].sku_base, 'CSV-A');
    } },
    { id: 'PR13', desc: 'SP tắt (disabled) -> searchProduct (text) không match cả 4 lớp', async fn(ctx) {
      ctx.app.productDB.getProductByBase('TRA-HOA-SEY').enabled = false;
      for (const q of ['TRA-HOA-SEY-50', 'trà hoa sấy', 'tra hoa say', 'tra hoa saay']) {
        assert.strictEqual(ctx.app.productDB.searchProduct(q).matches.length, 0, 'không match: ' + q);
      }
      ctx.app.productDB.getProductByBase('TRA-HOA-SEY').enabled = true;
    } },
    { id: 'PR14', desc: 'SP tắt -> đường ẢNH (mockVision) cũng không match (CHANGE REQUEST đợt 2)', async fn(ctx) {
      const app = newApp('pr-image');
      fire(app, 'facebook', 'primg1', 'lấy 1 nến vanilla M đỏ', 'primg-0'); // warm-up ok
      app.productDB.getProductByBase('NT-VANILLA').enabled = false;
      app.receive({ channel: 'facebook', type: 'message', platformEventId: 'primg-1', payload: { customer_ref: 'primg2', thread_id: 'primg2', kind: 'image', text: '', media: { platform_url: 'https://x/nen-vanilla-m-do.jpg' }, platform_message_id: 'pm-primg-1' } });
      app.drain();
      const conv = app.store.findOne('conversations', c => c.platform_thread_id === 'primg2');
      assert.strictEqual(conv.subject_sku, null, 'ảnh SP tắt KHÔNG match');
      assert.strictEqual(conv.flag_needs_human, true);
    } },
    { id: 'PR15', desc: 'AGENT: đọc products 200 nhưng GHI (POST/import/PUT/DELETE) 403', async fn(ctx) {
      await ctx.inst.client('POST', '/api/auth/users', { cookie: ctx.sid, body: { email: 'pr-agent@matrix.vn', password: 'password789', role: 'AGENT' } });
      const ag = (await ctx.inst.client('POST', '/api/auth/login', { body: { email: 'pr-agent@matrix.vn', password: 'password789' } })).headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
      assert.strictEqual((await ctx.inst.client('GET', '/api/products', { cookie: ag })).status, 200);
      assert.strictEqual((await ctx.inst.client('POST', '/api/products', { cookie: ag, body: { name: 'X', sku_base: 'AG-X', price: 1000 } })).status, 403);
      assert.strictEqual((await ctx.inst.client('POST', '/api/products/import', { cookie: ag, body: { csv: 'name,sku,price,stock\nX,AG-X2,1,1' } })).status, 403);
      assert.strictEqual((await ctx.inst.client('PUT', '/api/products/MX-TEST', { cookie: ag, body: { price: 1 } })).status, 403);
      assert.strictEqual((await ctx.inst.client('DELETE', '/api/products/MX-TEST', { cookie: ag })).status, 403);
    } },
  ],
};
