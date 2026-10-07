'use strict';
/* ============================================================
   Sales AI Console — Service Worker (PHASE PRODUCT-READY đợt 2)
   - CACHE-FIRST cho STATIC (app shell: css/js/manifest/icons/html) — chỉ cache khi
     response 200 + same-origin basic (đặt biệt: KHÔNG cache redirect của /app.js khi
     chưa đăng nhập).
   - NETWORK cho MỌI thứ khác: /api/* (dữ liệu kinh doanh — CẤM cache), /webhooks/*,
     SSE /api/events (EventSource không qua handler fetch này nhưng vẫn passthrough).
   - Bump CACHE const khi đổi app shell; activate dọn cache cũ.
   ============================================================ */

const CACHE = 'sai-static-v4';
const PRECACHE = [
  '/style.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/login.html',
  '/welcome.html',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // precache từng file — file lỗi (302/404) KHÔNG chặn install (app.js cần session)
    await Promise.all(PRECACHE.map(async url => {
      try { await cache.add(url); } catch (e) { /* bỏ qua — sẽ cache khi fetch sau */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return; // POST/PUT/DELETE -> network, không can thiệp
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // origin khác -> passthrough
  // ---- CẤM CACHE dữ liệu kinh doanh + webhook + stream ----
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/webhooks/')) return;

  // ---- cache-first cho static của app shell ----
  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: false });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      // chỉ cache 200 same-origin (tránh redirect 302 -> '/' khi chưa login)
      if (res && res.status === 200 && res.type === 'basic') {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch (e) {
      // offline mà chưa có cache: trả trang login tĩnh nếu có (shell tối thiểu)
      const shell = await caches.match('/login.html');
      if (shell) return shell;
      throw e;
    }
  })());
});
