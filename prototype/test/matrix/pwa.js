'use strict';
// test/matrix/pwa.js — AREA PWA/UI (20 case): manifest + icons + sw + đăng ký + theme +
// responsive breakpoint + notification badge + served-over-HTTP.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { startInst, setupShop } = require('./_harness');

const UI = path.join(__dirname, '..', '..', 'ui');

module.exports = {
  area: 'PWA/UI',
  async setup() {
    const inst = await startInst('pwa');
    const { sid } = await setupShop(inst, { goLive: true, email: 'pwa@matrix.vn' });
    return { inst, sid };
  },
  cases: [
    { id: 'PW01', desc: 'manifest.webmanifest tồn tại + JSON hợp lệ', async fn() {
      const raw = fs.readFileSync(path.join(UI, 'manifest.webmanifest'), 'utf8');
      const j = JSON.parse(raw);
      assert.ok(j.name && j.short_name);
    } },
    { id: 'PW02', desc: 'manifest theme trắng/hồng: theme_color #db2777 + background trắng', async fn() {
      const j = JSON.parse(fs.readFileSync(path.join(UI, 'manifest.webmanifest'), 'utf8'));
      assert.strictEqual(j.theme_color, '#db2777');
      assert.strictEqual(j.background_color, '#ffffff');
    } },
    { id: 'PW03', desc: 'manifest display standalone + start_url / + scope /', async fn() {
      const j = JSON.parse(fs.readFileSync(path.join(UI, 'manifest.webmanifest'), 'utf8'));
      assert.strictEqual(j.display, 'standalone');
      assert.strictEqual(j.start_url, '/');
      assert.strictEqual(j.scope, '/');
    } },
    { id: 'PW04', desc: 'manifest khai đủ icon 192 + 512 PNG', async fn() {
      const j = JSON.parse(fs.readFileSync(path.join(UI, 'manifest.webmanifest'), 'utf8'));
      const sizes = j.icons.map(i => i.sizes);
      assert.ok(sizes.includes('192x192'));
      assert.ok(sizes.includes('512x512'));
      assert.ok(j.icons.every(i => i.type === 'image/png' && i.src.startsWith('/icons/')));
    } },
    { id: 'PW05', desc: 'file icon PNG thật: header PNG + đúng kích thước pixel (node zlib decode)', async fn() {
      for (const size of [192, 512]) {
        const b = fs.readFileSync(path.join(UI, 'icons', `icon-${size}.png`));
        assert.strictEqual(b.slice(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature ' + size);
        assert.strictEqual(b.readUInt32BE(16), size, 'width ' + size);
        assert.strictEqual(b.readUInt32BE(20), size, 'height ' + size);
      }
    } },
    { id: 'PW06', desc: 'sw.js tồn tại: cache-first static (caches.match trước fetch)', async fn() {
      const sw = fs.readFileSync(path.join(UI, 'sw.js'), 'utf8');
      assert.ok(sw.includes('caches.match(req'));
      assert.ok(sw.includes("caches.open(CACHE)"));
    } },
    { id: 'PW07', desc: 'sw.js KHÔNG cache /api và /webhooks (network passthrough)', async fn() {
      const sw = fs.readFileSync(path.join(UI, 'sw.js'), 'utf8');
      assert.match(sw, /startsWith\('\/api\/'\)/);
      assert.match(sw, /startsWith\('\/webhooks\/'\)/);
      assert.match(sw, /req\.method !== 'GET'/, 'non-GET passthrough');
    } },
    { id: 'PW08', desc: 'sw.js: chỉ cache 200 basic (không cache redirect) + dọn cache cũ khi activate', async fn() {
      const sw = fs.readFileSync(path.join(UI, 'sw.js'), 'utf8');
      assert.match(sw, /res\.status === 200/);
      assert.match(sw, /res\.type === 'basic'/);
      assert.match(sw, /caches\.delete/);
    } },
    { id: 'PW09', desc: 'index.html đăng ký service worker + link manifest', async fn() {
      const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
      assert.match(html, /serviceWorker\.register\('\/sw\.js'\)/);
      assert.match(html, /rel="manifest" href="\/manifest.webmanifest"/);
    } },
    { id: 'PW10', desc: 'index.html meta theme-color #db2777 + apple-touch-icon', async fn() {
      const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
      assert.match(html, /name="theme-color" content="#db2777"/);
      assert.match(html, /rel="apple-touch-icon"/);
    } },
    { id: 'PW11', desc: 'notification badge TITLE: document.title = "(n) Inbox — ..." trong app.js', async fn() {
      const appjs = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
      // [TEST-FIX] regex cũ thiếu cặp ngoặc so với ĐỀ BÀI "(n) Inbox — ..." (desc của chính case
      // này). Code đã implement đúng spec: document.title = `(${n}) Inbox — Sales AI Console`
      // trong updateTitleBadge — khớp regex theo nội dung thật, giữ nguyên ý nghĩa.
      assert.match(appjs, /document\.title = n > 0 \? `\(\$\{n\}\) Inbox — Sales AI Console` : /);
      assert.match(appjs, /updateTitleBadge\(/);
    } },
    { id: 'PW12', desc: 'UI notification: bell dropdown + đọc tất cả + SSE unread_by_shop', async fn() {
      const appjs = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
      assert.match(appjs, /notifPanel/);
      assert.match(appjs, /\/api\/notifications\/read/);
      assert.match(appjs, /unread_by_shop/);
    } },
    { id: 'PW13', desc: 'UI order drawer: nút XÁC NHẬN ĐƠN + RETRY (đúng điều kiện hiển thị)', async fn() {
      const appjs = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
      assert.match(appjs, /btnConfirmOrder/);
      assert.match(appjs, /btnRetryShipping/);
      assert.match(appjs, /\/confirm`/);
      assert.match(appjs, /retry-shipping`/);
      assert.match(appjs, /Mở hội thoại/);
    } },
    { id: 'PW14', desc: 'UI settings: form Automation (hours/care/review/purchase) + health pills', async fn() {
      const appjs = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
      assert.match(appjs, /autoHours/);
      assert.match(appjs, /autoCare/);
      assert.match(appjs, /autoReview/);
      assert.match(appjs, /autoReminder/);
      assert.match(appjs, /\/api\/automation/);
      assert.match(appjs, /healthStrip/);
    } },
    { id: 'PW15', desc: 'responsive mobile: breakpoint 480px (390px dùng được) + form 1 cột + drawer full', async fn() {
      const css = fs.readFileSync(path.join(UI, 'style.css'), 'utf8');
      assert.match(css, /@media \(max-width: 480px\)/);
      const m = css.match(/@media \(max-width: 480px\) \{([\s\S]*?)\n\}/);
      assert.ok(m, 'khối 480px');
      assert.match(m[1], /form-2col \{ grid-template-columns: 1fr/);
      assert.match(m[1], /drawer \{ width: 100vw/);
      assert.match(css, /\.notif-panel/);
    } },
    { id: 'PW16', desc: 'login + welcome có viewport meta (mobile dùng được trước đăng nhập)', async fn() {
      assert.match(fs.readFileSync(path.join(UI, 'login.html'), 'utf8'), /viewport/);
      assert.match(fs.readFileSync(path.join(UI, 'welcome.html'), 'utf8'), /viewport/);
    } },
    { id: 'PW17', desc: 'HTTP: /manifest.webmanifest 200 + content-type manifest+json', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/manifest.webmanifest', { cookie: ctx.sid });
      assert.strictEqual(r.status, 200);
      assert.match(r.headers['content-type'], /manifest\+json/);
    } },
    { id: 'PW18', desc: 'HTTP: /sw.js 200 javascript; /icons/icon-192.png 200 image/png (đủ bytes)', async fn(ctx) {
      const sw = await ctx.inst.client('GET', '/sw.js', { cookie: ctx.sid });
      assert.strictEqual(sw.status, 200);
      assert.match(sw.headers['content-type'], /javascript/);
      const icon = await ctx.inst.client('GET', '/icons/icon-192.png', { cookie: ctx.sid });
      assert.strictEqual(icon.status, 200);
      assert.match(icon.headers['content-type'], /image\/png/);
      const disk = fs.statSync(path.join(UI, 'icons', 'icon-192.png')).size;
      assert.ok(icon.text.length >= disk * 0.5, 'icon có nội dung binary (utf8-decoded)');
    } },
    { id: 'PW19', desc: 'API trả Cache-Control: no-store (không cache business data phía HTTP)', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/api/dashboard', { cookie: ctx.sid });
      assert.match(r.headers['cache-control'], /no-store/);
    } },
    { id: 'PW20', desc: 'index.html serve sau login chứa app shell (topbar + notif panel)', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/', { cookie: ctx.sid });
      assert.strictEqual(r.status, 200);
      assert.match(r.text, /id="bellBtn"/);
      assert.match(r.text, /id="notifPanel"/);
      assert.match(r.text, /id="botToggle"/);
    } },
  ],
};
