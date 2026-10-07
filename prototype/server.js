'use strict';
// server.js — HTTP SERVER bán hàng (PHASE UI + P2 LIVE + PRODUCT-READY đợt 1 + ĐỢT 2).
//
// NGUYÊN TẮC (Phase UI + PRODUCT-READY):
//   - Thuần Node `http`, KHÔNG npm, KHÔNG mạng ngoài (trừ adapter LIVE ở biên — P2).
//   - CÔ LẬP SHOP BẰNG KIẾN TRÚC: MỖI SHOP = 1 App instance + dataDir RIÊNG (data/shops/<shop_id>),
//     server giữ map shop_id -> App (lazy). Mọi API scope theo shop CỦA SESSION — shop A KHÔNG
//     ĐỌC được shop B (test chứng minh bằng 2 shop seed).
//   - AUTH: src/auth.js — login/session cookie HttpOnly 7 ngày, role OWNER/ADMIN/AGENT,
//     rate limit 5 lần/phút/IP fail-closed, setup OWNER đầu tiên khi 0 user.
//   - Mọi API ĐỌC là hàm READ-ONLY quét store của App shop; mọi API GHI đi ĐÚNG ĐƯỜNG hệ thống
//     (gate.agentSend / takeover / requestCancelOrder / settings store / ProductDB + overrides).
//   - ONBOARDING 7 BƯỚC + GO-LIVE CHECKLIST: bot AUTO chỉ bật được khi bước 1,4,6 xanh +
//     (2 HOẶC 3 xanh) + (5 xanh nếu bật auto-order) — POST /api/settings/bot kiểm -> thiếu = 403.
//   - APP_DATA_MODE: mặc định PERSIST khi chạy thường; reset CHỈ khi APP_DATA_MODE=reset (test).
//   - Đồng hồ ảo của App kéo theo GIỜ THẬT mỗi tick 2s (như Phase UI — không drain ở runtime).
//
// MỚI ĐỢT 2 (PHASE PRODUCT-READY đợt 2):
//   - /api/notifications + /api/notifications/read (in-app; suy ra TỪ store thật; read-state
//     per shop lưu file dataDir shop); SSE đẩy kèm số unread.
//   - /api/health bổ sung `components` (database/facebook/zalo/shipping/ai/scheduler/webhook/queue).
//   - Order actions: POST /api/orders/:id/confirm (DRAFT -> phaseB ĐÚNG engine), retry-shipping
//     (chỉ khi policy cho: CANCEL_PENDING -> gọi lại cancel-via-carrier; CONFIRMED thiếu vận đơn
//     timeout -> reconcileShipment; KHÔNG BAO GIỜ update DB trực tiếp).
//   - /api/automation + POST: cấu hình follow-up sau giao (số giờ) + care/review/purchase-reminder.
//     Bộ điều phối server-level áp settings lên ROW follow_ups (dữ liệu) — việc GỬI vẫn do
//     scheduler + SendPolicy của core quyết định (Window/Quota/Opt-out/Receipt KHÔNG đụng).
//   - POST /api/conversations/:id/close-claim — đóng claim (P3B-4) qua sessions.closeClaim.
//   - PWA: /manifest.webmanifest + /sw.js + /icons/* (service worker cache-first static,
//     KHÔNG cache /api).
//
// CHƯA LÀM / HẠN CHẾ: docs/PHASE-PRODUCT-READY-P2.md.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { App } = require('./src/app');
const { applyProductOverrides } = require('./src/product-db');
const { loadEnvFile } = require('./src/live-env');
const { Auth, AuthError } = require('./src/auth');
const { ShopSettings } = require('./src/shop-settings');
const { buildSystemPrompt, validatePromptConfig } = require('./src/prompt-builder');
const aiProvider = require('./src/ai-provider');
const { parseProductsCsv } = require('./src/csv-import');
// SURI PHASE 1 (đợt P1): agent tools + shop profile + deepseek wire + error UX/TZ.
const agentTools = require('./src/agent/tools');
const shopProfile = require('./src/shop-profile');
const { wireDeepseek } = require('./src/deepseek-wire');
const { friendlyError, fmtVnTime, DEFAULT_TIMEZONE } = require('./src/errors');
// BÁO CÁO & THỐNG KÊ real-time (chuẩn aicake) — /api/analytics
const { buildAnalytics } = require('./src/analytics');
// HƯỚNG DẪN + AI HỎI-ĐÁP hướng dẫn (chuẩn aicake) — /api/guide + /api/guide/ask
const { installGuideRoutes } = require('./src/guide-ai');

const ROOT = __dirname;
const UI_DIR = path.join(ROOT, 'ui');
// P2 LIVE-INTEGRATION: nạp .env.live (CHỈ điền biến môi trường CHƯA có — env thật thắng)
loadEnvFile(path.join(ROOT, '.env.live'));

// ============================================================ FACTORY
// createServer(opts) — dùng chung cho boot thật (require.main) và test in-process (port 0,
// authDir/shopsRoot cô lập). Trả { server, listen, close, auth, getApp, port }.
function createServer(opts = {}) {
  const PORT = Number(opts.port !== undefined ? opts.port : (process.env.PORT || 8080));
  const VERSION = 'product-ready-2.0';
  const START_MS = Date.now();
  const APP_DATA = String(opts.appDataMode !== undefined ? opts.appDataMode
    : (process.env.APP_DATA_MODE === undefined ? 'persist' : process.env.APP_DATA_MODE)).toLowerCase();
  const PERSIST = APP_DATA !== 'reset'; // mặc định PERSIST; reset CHỈ khi APP_DATA_MODE=reset
  const DEMO = String(opts.uiDemo !== undefined ? opts.uiDemo : (process.env.UI_DEMO === undefined ? '1' : process.env.UI_DEMO)) !== '0';
  const SHOPS_ROOT = opts.shopsRoot || path.join(ROOT, 'data', 'shops');
  const auth = new Auth({ dir: opts.authDir || path.join(ROOT, 'data', 'auth'), shopsRoot: SHOPS_ROOT });

  const LIVE_BOOT = {
    channelMode: String(process.env.CHANNEL_MODE || 'mock').toLowerCase(),
    shippingMode: String(process.env.SHIPPING_MODE || 'mock').toLowerCase(),
  };

  // ------------------------------------------------------------ shop -> App (lazy, MỖI SHOP 1 APP)
  const apps = new Map();        // shop_id -> App
  const settingsCache = new Map(); // shop_id -> ShopSettings
  const productVersions = new Map(); // shop_id -> số (SSE fingerprint)

  function settingsFor(shopId) {
    if (!settingsCache.has(shopId)) {
      const shop = auth.getShop(shopId);
      settingsCache.set(shopId, new ShopSettings(shop.dataDir));
    }
    const ss = settingsCache.get(shopId);
    // SURI P1 (hạng mục 5): timezone mặc định ASIA/HO_CHI_MINH — follow-up/jobs hiển thị giờ VN.
    if (!ss.has('timezone')) ss.set('timezone', DEFAULT_TIMEZONE);
    return ss;
  }

  function overridesFileFor(shopId) {
    const shop = auth.getShop(shopId);
    return path.join(shop.dataDir, 'product-overrides.json'); // dữ liệu nằm TRONG dataDir shop
  }

  function getApp(shopId) {
    if (apps.has(shopId)) return apps.get(shopId);
    const shop = auth.getShop(shopId);
    if (!shop) return null;
    fs.mkdirSync(shop.dataDir, { recursive: true });
    // SURI P2: TIÊM CÙNG instance ShopSettings cho App — AI runtime (sales-ai) đọc config
    // fresh mỗi tin từ settings này; đổi provider/useForReplies qua API có hiệu lực ngay.
    const app = new App({
      dataDir: shop.dataDir,
      settings: settingsFor(shopId),
      persist: PERSIST, // persist KHÔNG xoá dataDir (nạp db + backup 1 tầng); reset = xoá (test)
      clockStart: Date.now() - 55 * 60 * 1000,
      botEnabled: DEMO, // product mode: shop mới bot OFF — chỉ bật sau go-live checklist; demo mode ON
    });
    // DEMO seed (như Phase UI): CHỈ khi shop còn TRỐNG (persist tránh re-seed mỗi restart)
    if (DEMO && app.store.findAll('customers', () => true).length === 0) {
      try { seedDemo(app); } catch (err) { console.error('[seed-demo]', err && err.message); }
    }
    // PRODUCT-READY đợt 2 (fix thật từ test matrix PS09/PS14): overrides sản phẩm (thêm/sửa/
    // tắt) phải ÁP LẠI mỗi lần dựng App — trước đây chỉ áp khi ghi, restart làm mất SP đã thêm.
    try { applyOverrides(app, shopId); } catch (err) { console.error('[overrides]', err && err.message); }
    apps.set(shopId, app);
    productVersions.set(shopId, 0);
    return app;
  }

  // ------------------------------------------------------------ helper chung
  const nowIsoOf = app => app.clock.iso();
  const todayKeyOf = app => new Date(app.clock.now()).toISOString().slice(0, 10);
  const createdTodayFor = app => row => String(row.created_at || '').slice(0, 10) === todayKeyOf(app);
  const byNewest = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''));

  function readJsonBody(req) {
    return new Promise(resolve => {
      let raw = '';
      req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
      req.on('end', () => {
        try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({ __bad_json: true }); }
      });
      req.on('error', () => resolve({}));
    });
  }

  // P2/WEBHOOK: đọc RAW body (bắt buộc — HMAC X-Hub-Signature-256 hash trên bytes gốc)
  function readRawBody(req) {
    return new Promise(resolve => {
      let raw = '';
      req.on('data', c => { raw += c; if (raw.length > 2e6) req.destroy(); });
      req.on('end', () => resolve({ raw }));
      req.on('error', () => resolve({ raw: '' }));
    });
  }

  function sendText(res, code, text) {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  }

  // ============================================================ P2 PROVIDERS STATUS
  function statusLabelFor(kind, st) {
    if (!st) return 'DISCONNECTED';
    if (kind === 'meta') {
      if (st.mode !== 'live') return 'CONNECTED';
      if (st.last_error_type === 'auth') return 'PERMISSION_REQUIRED';
      return st.connected ? 'CONNECTED' : 'DISCONNECTED';
    }
    if (kind === 'zalo') {
      if (st.mode !== 'live') return 'CONNECTED';
      if (st.token_expired) return 'TOKEN_EXPIRED';
      return st.connected ? 'CONNECTED' : 'DISCONNECTED';
    }
    if (st.mode !== 'live') return 'CONNECTED';
    if (!st.connected) return 'DISCONNECTED';
    return st.environment === 'production' ? 'PRODUCTION_CONNECTED' : 'STAGING_CONNECTED';
  }

  function providersView(app) {
    const live = app.live;
    const mockView = kind => ({
      provider: kind, mode: 'mock', configured: true, connected: true,
      last_webhook_at: null, last_success_at: null, last_error_type: null,
      ...(kind === 'zalo' ? { token_expired: false, quota_verified: false } : {}),
      ...(kind === 'ghn' ? { environment: 'mock' } : {}),
    });
    const meta = live && live.meta ? live.meta.providerStatus() : mockView('meta');
    const zalo = live && live.zalo ? live.zalo.providerStatus() : mockView('zalo');
    const ghn = live && live.carrier ? live.carrier.providerStatus() : mockView('ghn');
    const label = (st, kind) => Object.assign({}, st, { status_label: statusLabelFor(kind, st) });
    return { meta: label(meta, 'meta'), zalo: label(zalo, 'zalo'), ghn: label(ghn, 'ghn') };
  }

  // ============================================================ P2 WEBHOOK DISPATCH
  function dispatchNormalized(app, norm) {
    const accepted = [];
    for (const ev of (norm && norm.events) || []) accepted.push(app.receive(ev));
    for (const rc of (norm && norm.receipts) || []) app.ingestReceipt(rc);
    return accepted;
  }

  // ============================================================ ĐỌC (READ-ONLY) — quét store CỦA SHOP
  function botOn(app) {
    return !!app.gate.botEnabled();
  }

  function convBadge(app, conv) {
    if (conv.flag_needs_human) return 'NEEDS_HUMAN';
    if (conv.mode === 'HUMAN') return 'HUMAN';
    // SỬA (PRODUCT-READY đợt 2, matrix CV03): conv đang Ở GIAI ĐOẠN CHỐT ĐƠN (draft đủ slot,
    // đã reserve, chờ khách xác nhận — state CONFIRM với draft.order_id) phải hiện ORDERED
    // như conv đã có đơn: bộ badge AI/HUMAN/NEEDS_HUMAN/ORDERED không có badge riêng cho
    // "đang chốt" — gom vào ORDERED để owner không bỏ sót đơn sắp chốt. Nhân viên vẫn thắng
    // (2 nhánh trên).
    if (conv.state === 'CONFIRM' && conv.draft && conv.draft.order_id) return 'ORDERED';
    if (conv.state === 'ORDERED' || conv.state === 'SHIPPING') return 'ORDERED';
    const orders = app.store.findAll('orders', o => o.conversation_id === conv.conversation_id);
    const active = orders.filter(o => o.status === 'CONFIRMED' || o.status === 'CANCEL_PENDING');
    if (active.length) return 'ORDERED';
    return 'AI';
  }

  function customerName(customer, conv) {
    const draftName = conv && conv.draft && conv.draft.slots && conv.draft.slots.name && conv.draft.slots.name.value;
    return customer.full_name || draftName || customer.display_name || customer.platform_ref;
  }

  function latestMessage(app, convId, direction) {
    const rows = app.store.findAll('messages', m =>
      m.conversation_id === convId && (direction ? m.direction === direction : true));
    return rows.length ? rows[rows.length - 1] : null;
  }

  function listConversations(app) {
    const rows = app.store.findAll('conversations').slice().sort(byNewest);
    return rows.map(conv => {
      const customer = app.store.findOne('customers', c => c.customer_id === conv.customer_id);
      const last = latestMessage(app, conv.conversation_id);
      return {
        id: conv.conversation_id,
        channel: conv.channel,
        customerName: customer ? customerName(customer, conv) : conv.customer_id,
        lastMessage: last ? (last.text_content || (last.kind === 'image' ? '[ảnh]' : last.kind === 'voice' ? '[voice]' : '')) : '',
        lastTime: last ? last.created_at : conv.last_activity_at,
        badge: convBadge(app, conv),
        state: conv.state,
        mode: conv.mode,
        flag_needs_human: !!conv.flag_needs_human,
        claim: conv.claim ? { reason: conv.claim.reason, opened_at: conv.claim.opened_at } : null,
      };
    });
  }

  function shipmentOf(app, orderId) {
    return app.store.findOne('shipments', s => s.order_id === orderId);
  }

  function orderDisplayStatus(app, order) {
    if (order.status !== 'CONFIRMED') return order.status;
    const sh = shipmentOf(app, order.order_id);
    if (sh && ['PICKED_UP', 'IN_TRANSIT', 'RETURNED', 'FAILED'].includes(sh.status)) return 'SHIPPING';
    return 'CONFIRMED';
  }

  function orderLineNames(app, order) {
    try {
      return JSON.parse(order.price_snapshot_json || '[]').map(l => {
        const hit = app.productDB.getVariant(l.sku);
        return {
          sku: l.sku,
          name: hit ? `${hit.product.name}${hit.variant.size ? ' (' + hit.variant.size + (hit.variant.color ? ' ' + hit.variant.color : '') + ')' : ''}` : l.sku,
          qty: l.qty,
          unit_price: l.unit_price,
          line_total: l.line_total,
        };
      });
    } catch (e) { return []; }
  }

  function listOrders(app, statusFilter) {
    const rows = app.store.findAll('orders').slice().sort(byNewest);
    const out = rows.map(order => {
      const customer = app.store.findOne('customers', c => c.customer_id === order.customer_id);
      const conv = app.store.findOne('conversations', c => c.conversation_id === order.conversation_id);
      const sh = shipmentOf(app, order.order_id);
      const lines = orderLineNames(app, order);
      return {
        order_id: order.order_id,
        order_code: order.order_code,
        customer_name: customer ? customerName(customer, conv) : order.customer_id,
        products: lines.map(l => `${l.qty} x ${l.name}`).join(', '),
        total: order.total,
        subtotal: order.subtotal,
        shipping_fee: order.shipping_fee,
        status: order.status,
        display_status: orderDisplayStatus(app, order),
        shipment: sh ? { tracking_number: sh.tracking_number, status: sh.status, carrier: sh.carrier } : null,
        created_at: order.created_at,
      };
    });
    if (statusFilter && statusFilter !== 'ALL') {
      return out.filter(o => o.display_status === statusFilter);
    }
    return out;
  }

  function orderHistory(app, order) {
    return app.store.findAll('audit_events', a =>
      a.conversation_id === order.conversation_id && a.proposed_action === 'ORDER_STATUS')
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))
      .map(a => ({
        from: (a.validation && a.validation.from) || null,
        to: (a.validation && a.validation.to) || a.execution_result,
        actor: (a.validation && a.validation.actor) || null,
        reason: (a.validation && a.validation.reason) || null,
        at: a.at,
      }));
  }

  function orderAudit(app, order) {
    return app.store.findAll('audit_events', a => {
      if (a.conversation_id !== order.conversation_id) return false;
      const pa = String(a.proposed_action || '');
      return pa.includes('ORDER') || pa.includes('SHIPMENT') || pa.includes('CANCEL');
    }).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 30);
  }

  function orderDetail(app, orderId) {
    const order = app.store.findOne('orders', o => o.order_id === orderId);
    if (!order) return null;
    const customer = app.store.findOne('customers', c => c.customer_id === order.customer_id);
    const conv = app.store.findOne('conversations', c => c.conversation_id === order.conversation_id);
    const sh = shipmentOf(app, orderId);
    return {
      order_id: order.order_id,
      order_code: order.order_code,
      status: order.status,
      display_status: orderDisplayStatus(app, order),
      subtotal: order.subtotal,
      shipping_fee: order.shipping_fee,
      total: order.total,
      address_snapshot: order.address_snapshot ? JSON.parse(order.address_snapshot) : null,
      draft_expires_at: order.draft_expires_at || null,
      cancel_reason: order.cancel_reason || null,
      cancel_actor: order.cancel_actor || null,
      cancel_at: order.cancel_at || null,
      cancel_carrier_reason: order.cancel_carrier_reason || null,
      created_at: order.created_at,
      items: orderLineNames(app, order),
      customer: customer ? {
        customer_id: customer.customer_id,
        name: customerName(customer, conv),
        phone: (conv && conv.draft && conv.draft.slots.phone.value) || customer.phone || null,
        channel: conv ? conv.channel : customer.channel,
      } : null,
      conversation_id: order.conversation_id,
      shipment: sh ? {
        shipment_id: sh.shipment_id, tracking_number: sh.tracking_number, status: sh.status,
        carrier: sh.carrier, created_at: sh.created_at, cancelled_at: sh.cancelled_at || null,
      } : null,
      history: orderHistory(app, order),
      audit: orderAudit(app, order),
    };
  }

  function listProducts(app, shopId, q) {
    const disabled = readOverrides(shopId).disabled || {};
    let items = app.productDB.products.map(p => ({
      product_id: p.product_id,
      sku_base: p.sku_base,
      name: p.name,
      category: p.category || null,
      aliases: p.aliases || [],
      image: (p.images && p.images[0]) || null,
      weight_g: p.weight_g || null,
      attributes: p.attributes || {},
      enabled: p.enabled !== false && !disabled[p.sku_base],
      variants: p.variants.map(v => ({
        sku: v.sku, size: v.size, color: v.color, price: v.price,
        stock_qty: v.stock_qty, stock_reserved: v.stock_reserved || 0,
        effective: v.stock_qty - (v.stock_reserved || 0),
      })),
    }));
    if (q) {
      const needle = String(q).toLowerCase();
      items = items.filter(p =>
        p.name.toLowerCase().includes(needle)
        || p.sku_base.toLowerCase().includes(needle)
        || (p.aliases || []).some(a => String(a).toLowerCase().includes(needle)));
    }
    return items;
  }

  function listCustomers(app) {
    const rows = app.store.findAll('customers');
    return rows.map(cus => {
      const conv = app.store.findOne('conversations', c => c.customer_id === cus.customer_id);
      const orders = app.store.findAll('orders', o => o.customer_id === cus.customer_id);
      const sold = orders.filter(o => o.status === 'CONFIRMED' || o.status === 'DELIVERED');
      return {
        customer_id: cus.customer_id,
        name: customerName(cus, conv),
        phone: (conv && conv.draft && conv.draft.slots.phone.value) || cus.phone || null,
        channel: conv ? conv.channel : cus.channel,
        orders_count: sold.length,
        total_spent: sold.reduce((t, o) => t + Number(o.total || 0), 0),
        state: conv ? conv.state : null,
        mode: conv ? conv.mode : null,
        opt_out: cus.marketing_opt_out === 1,
        last_interaction: conv ? conv.last_activity_at : cus.created_at,
      };
    }).sort((a, b) => String(b.last_interaction || '').localeCompare(String(a.last_interaction || '')));
  }

  function customerDetail(app, customerId) {
    const cus = app.store.findOne('customers', c => c.customer_id === customerId);
    if (!cus) return null;
    const convs = app.store.findAll('conversations', c => c.customer_id === customerId);
    const orders = app.store.findAll('orders', o => o.customer_id === customerId).slice().sort(byNewest);
    return {
      customer: {
        customer_id: cus.customer_id,
        name: customerName(cus, convs[0] || null),
        phone: cus.phone || (convs[0] && convs[0].draft && convs[0].draft.slots.phone.value) || null,
        platform_ref: cus.platform_ref,
        marketing_opt_out: cus.marketing_opt_out === 1,
        opt_out_at: cus.opt_out_at || null,
        created_at: cus.created_at,
      },
      conversations: convs.map(c => ({
        id: c.conversation_id, channel: c.channel, state: c.state, mode: c.mode, badge: convBadge(app, c),
        claim: c.claim ? { reason: c.claim.reason, opened_at: c.claim.opened_at } : null,
        last_activity_at: c.last_activity_at,
      })),
      orders: orders.map(o => ({
        order_id: o.order_id, order_code: o.order_code, status: o.status,
        display_status: orderDisplayStatus(app, o), total: o.total, created_at: o.created_at,
        products: orderLineNames(app, o).map(l => `${l.qty} x ${l.name}`).join(', '),
      })),
    };
  }

  function latestOrderOf(app, convId) {
    const orders = app.store.findAll('orders', o => o.conversation_id === convId).slice().sort(byNewest);
    if (!orders.length) return null;
    const o = orders[0];
    const sh = shipmentOf(app, o.order_id);
    return {
      order_id: o.order_id, order_code: o.order_code, status: o.status,
      display_status: orderDisplayStatus(app, o), total: o.total, created_at: o.created_at,
      tracking_number: sh ? sh.tracking_number : null,
    };
  }

  function conversationDetail(app, convId) {
    const conv = app.store.findOne('conversations', c => c.conversation_id === convId);
    if (!conv) return null;
    const customer = app.store.findOne('customers', c => c.customer_id === conv.customer_id);
    const msgs = app.store.findAll('messages', m => m.conversation_id === convId);
    const windowState = app.gate.windowState(conv); // READ-ONLY
    const budget = app.store.findOne('channel_budget', b => b.conversation_id === convId);
    const subjectHit = conv.subject_sku ? app.productDB.getVariant(conv.subject_sku) : null;
    const draftAddr = conv.draft && conv.draft.slots && conv.draft.slots.address ? conv.draft.slots.address.value : null;
    const latestOrder = latestOrderOf(app, convId);
    const messages = msgs.map(m => {
      let delivery = m.delivery_status || null;
      let op = null;
      if (m.send_exec_id) {
        const row = app.store.findOne('outbound_pending', o => o.exec_id === m.send_exec_id);
        if (row) {
          op = { receipt_status: row.receipt_status, receipt_at: row.receipt_at, sent_at: row.sent_at };
          if (delivery === 'SENT_PENDING_RECEIPT' && row.receipt_status === 'DELIVERED') delivery = 'DELIVERED';
        }
      }
      let sender;
      if (m.direction === 'in') sender = 'customer';
      else if (m.sender === 'human_agent') sender = 'agent';
      else if (m.sender === 'system') sender = 'system';
      else sender = 'bot';
      let attachment = null;
      if (m.attachment_json) {
        try {
          const a = JSON.parse(m.attachment_json)[0];
          if (a) attachment = { type: a.type, from_asr: !!a.from_asr, text: m.text_content || null };
        } catch (e) { /* bỏ qua */ }
      }
      return {
        id: m.message_id,
        direction: m.direction,
        sender,
        text: m.text_content,
        time: m.created_at,
        delivery_status: delivery,
        msg_kind: m.msg_kind || null,
        receipt: op,
        attachment,
      };
    });
    return {
      id: conv.conversation_id,
      channel: conv.channel,
      state: conv.state,
      mode: conv.mode,
      human_agent: conv.human_agent || null,
      claim: conv.claim ? { reason: conv.claim.reason, opened_at: conv.claim.opened_at, origin_state: conv.claim.origin_state } : null,
      opt_out: conv.marketing_opt_out === 1 || (customer && customer.marketing_opt_out === 1),
      subject_sku: conv.subject_sku || null,
      subject_name: subjectHit ? subjectHit.product.name : null,
      draft: (() => {
        // SỬA (PRODUCT-READY đợt 2, matrix CV05): contract của detail là draft LUÔN có shape
        // {items, missing} để UI vẽ panel "thiếu gì" — kể cả khi conv chưa có draft (chưa setSlot
        // lần nào, ví dụ khách hỏi mua SP đa variant đang chờ chọn). Trước đây trả null -> UI
        // và API client đọc draft.missing vỡ. missing tính trên draft rỗng khi chưa có.
        const d = conv.draft || { items: [], slots: {} };
        const s = d.slots || {};
        return {
          items: (d.items || []).filter(i => i.state !== 'stale').map(i => ({
            sku: i.sku, qty: i.qty, state: i.state,
            name: (() => { const h = app.productDB.getVariant(i.sku); return h ? h.product.name : i.sku; })(),
          })),
          missing: (() => {
            const miss = [];
            if (!(d.items || []).some(i => i.state !== 'stale' && i.qty > 0)) miss.push('items');
            if (!(s.name && s.name.value)) miss.push('name');
            if (!(s.phone && s.phone.value)) miss.push('phone');
            if (!(s.address && s.address.value)) miss.push('address');
            return miss;
          })(),
        };
      })(),
      customer: customer ? {
        name: customerName(customer, conv),
        phone: (conv.draft && conv.draft.slots.phone.value) || customer.phone || null,
        address: draftAddr || (latestOrder && latestOrder.order_id
          ? (() => { const o = app.store.findOne('orders', x => x.order_id === latestOrder.order_id); return o && o.address_snapshot ? JSON.parse(o.address_snapshot) : null; })()
          : null),
        platform_ref: customer.platform_ref,
        opt_out: customer.marketing_opt_out === 1,
      } : null,
      latest_order: latestOrder,
      window: {
        last_user_event_ts: windowState.last_user_event_ts,
        open: windowState.open,
        age_ms: windowState.age_ms,
        channel: conv.channel,
      },
      quota: budget ? { cs_remain: budget.cs_remain, cs_total: budget.cs_total } : null,
      messages,
    };
  }

  function dashboard(app) {
    const pv = providersView(app);
    const createdToday = createdTodayFor(app);
    const t = todayKeyOf(app);
    const khachHomNay = app.store.findAll('customers', c => String(c.created_at || '').slice(0, 10) === t).length;
    const ordersToday = app.store.findAll('orders', createdToday);
    const doanhThu = app.store.findAll('orders', o =>
      createdToday(o) && (o.status === 'CONFIRMED' || o.status === 'DELIVERED'))
      .reduce((s, o) => s + Number(o.total || 0), 0);
    const convs = app.store.findAll('conversations');
    const needsHuman = convs.filter(c => c.flag_needs_human || c.mode === 'HUMAN').length;
    const takeover = convs.filter(c => c.mode === 'HUMAN').length;

    const acts = [];
    for (const p of app.store.findAll('ai_proposals', p =>
      ['PRICE', 'VARIANT', 'STOCK', 'ATTR_UNKNOWN'].includes(p.intent))) {
      if (!createdToday(p)) continue;
      acts.push({ type: 'khach_hoi_gia', label: `Khách hỏi sản phẩm/giá (${p.intent})`, conversation_id: p.conversation_id, at: p.created_at });
    }
    for (const o of app.store.findAll('orders', createdToday)) {
      acts.push({ type: 'tao_don', label: `Tạo đơn ${o.order_code} (${o.status})`, order_id: o.order_id, conversation_id: o.conversation_id, at: o.created_at });
    }
    for (const w of app.store.findAll('worklist', w => w.status === 'OPEN')) {
      acts.push({ type: 'can_nhan_vien', label: `Cần nhân viên: ${w.reason}`, conversation_id: w.conversation_id, at: w.created_at });
    }
    for (const d of app.store.findAll('dlq', () => true)) {
      acts.push({ type: 'loi_gui_tin', label: `Lỗi gửi tin: ${d.fail_reason}`, at: d.created_at });
    }
    for (const a of app.store.findAll('audit_events', a =>
      a.stage === 'EXECUTED' && String(a.execution_result) === 'FAILED' && String(a.proposed_action || '').startsWith('SEND'))) {
      acts.push({ type: 'loi_gui_tin', label: `Lỗi gửi tin (${a.proposed_action})`, conversation_id: a.conversation_id, at: a.at });
    }
    acts.sort((a, b) => String(b.at).localeCompare(String(a.at)));

    return {
      khachHomNay,
      donHomNay: ordersToday.length,
      doanhThuHomNay: doanhThu,
      canNhanVien: needsHuman,
      takeoverCount: takeover,
      bot: { on: botOn(app), autoReply: botOn(app) },
      kenh: {
        facebook: {
          connected: pv.meta.connected, mock: pv.meta.mode !== 'live',
          platform_mode: LIVE_BOOT.channelMode, status_label: pv.meta.status_label,
        },
        zalo: {
          connected: pv.zalo.connected, mock: pv.zalo.mode !== 'live',
          platform_mode: LIVE_BOOT.channelMode, status_label: pv.zalo.status_label,
        },
        ghn: {
          connected: pv.ghn.connected, mock: pv.ghn.mode !== 'live',
          carrier_mode: LIVE_BOOT.shippingMode, status_label: pv.ghn.status_label,
        },
      },
      hoatDongGanDay: acts.slice(0, 10),
      now: nowIsoOf(app),
    };
  }

  // HEALTH ĐẦY ĐỦ (đợt 2): từng phần {status, last_success, last_error, last_error_type,
  // last_webhook_at, uptime_s} — đọc từ store/provider THẬT, không guess.
  function componentsHealth(app, shopId) {
    const pv = providersView(app);
    const uptime = Math.round((Date.now() - START_MS) / 1000);
    const comp = (status, extra) => Object.assign({
      status, last_success: null, last_error: null, last_error_type: null, last_webhook_at: null, uptime_s: uptime,
    }, extra || {});
    const comps = {};
    // database: db.json của shop + counts store thật
    let dbSize = 0;
    try { dbSize = fs.statSync(path.join(auth.getShop(shopId).dataDir, 'db.json')).size; } catch (e) { /* chưa có file */ }
    const counts = {};
    for (const c of ['customers', 'conversations', 'messages', 'orders', 'shipments', 'follow_ups', 'audit_events']) {
      counts[c] = app.store.findAll(c, () => true).length;
    }
    comps.database = comp('ok', { size_bytes: dbSize, counts });
    // kênh + shipping: từ provider status thật (mock -> CONNECTED; live -> trạng thái thật)
    comps.facebook = comp(pv.meta.status_label === 'DISCONNECTED' ? 'error' : 'ok', {
      mode: pv.meta.mode, status_label: pv.meta.status_label,
      last_success: pv.meta.last_success_at || null, last_webhook_at: pv.meta.last_webhook_at || null,
      last_error: pv.meta.last_error_type || null, last_error_type: pv.meta.last_error_type || null,
    });
    comps.zalo = comp(pv.zalo.token_expired ? 'error' : (pv.zalo.status_label === 'DISCONNECTED' ? 'error' : 'ok'), {
      mode: pv.zalo.mode, status_label: pv.zalo.status_label,
      last_success: pv.zalo.last_success_at || null, last_webhook_at: pv.zalo.last_webhook_at || null,
      last_error: pv.zalo.last_error_type || pv.zalo.token_expired ? (pv.zalo.last_error_type || 'token_expired') : null,
      last_error_type: pv.zalo.last_error_type || (pv.zalo.token_expired ? 'token_expired' : null),
    });
    comps.shipping = comp(pv.ghn.status_label === 'DISCONNECTED' ? 'error' : 'ok', {
      mode: pv.ghn.mode, status_label: pv.ghn.status_label,
      last_success: pv.ghn.last_success_at || null, last_webhook_at: pv.ghn.last_webhook_at || null,
      last_error: pv.ghn.last_error_type || null, last_error_type: pv.ghn.last_error_type || null,
    });
    // ai: từ ai-status thật của shop (test PASS gần nhất -> ONLINE)
    const aiSt = aiProvider.aiStatus(settingsFor(shopId));
    comps.ai = comp(aiSt.status === 'ERROR' ? 'error' : (aiSt.status === 'ONLINE' ? 'ok' : 'degraded'), {
      provider: aiSt.provider || null, last_success: aiSt.last_success || null, last_error: aiSt.last_error || null,
    });
    // scheduler: jobs pending/dead + follow-up đang chờ
    const jobsPending = app.store.findAll('jobs', j => j.status === 'QUEUED').length;
    const jobsDead = app.store.findAll('jobs', j => j.status === 'DEAD').length;
    const fuScheduled = app.store.findAll('follow_ups', f => f.status === 'SCHEDULED').length;
    comps.scheduler = comp(jobsDead > 0 ? 'degraded' : 'ok', {
      jobs_pending: jobsPending, jobs_dead: jobsDead, follow_ups_scheduled: fuScheduled,
      last_error: jobsDead > 0 ? `${jobsDead} job DEAD (không tự chạy lại)` : null,
    });
    // webhook: last_webhook_at PER PROVIDER (mock chưa nhận gì -> null là đúng)
    const whAt = [pv.meta.last_webhook_at, pv.zalo.last_webhook_at, pv.ghn.last_webhook_at]
      .filter(Boolean).sort().pop() || null;
    comps.webhook = comp('ok', {
      facebook: pv.meta.last_webhook_at || null, zalo: pv.zalo.last_webhook_at || null, ghn: pv.ghn.last_webhook_at || null,
      last_webhook_at: whAt,
    });
    // queue: hàng đợi event nội bộ
    const qPending = app.gateway.queue.length;
    comps.queue = comp(qPending > 50 ? 'degraded' : 'ok', {
      pending: qPending, write_count: app.store.writeCount,
      last_error: qPending > 50 ? `queue tích ${qPending} event chưa xử lý` : null,
    });
    return comps;
  }

  function healthOf(app, shopId) {
    const errMetrics = ['send_failed', 'dlq_count', 'event_failed', 'order_create_timeout', 'follow_up_failed'];
    const errors = {};
    for (const m of errMetrics) errors[m] = app.store.metric(m);
    const jobsDead = app.store.findAll('jobs', j => j.status === 'DEAD').length;
    const providers = providersView(app);
    return {
      ok: true,
      version: VERSION,
      node: process.version,
      uptime_s: Math.round((Date.now() - START_MS) / 1000),
      bot_on: botOn(app),
      modes: { channel: LIVE_BOOT.channelMode, shipping: LIVE_BOOT.shippingMode, data: PERSIST ? 'persist' : 'reset' },
      channels: {
        facebook: { connected: providers.meta.connected, mock: providers.meta.mode !== 'live' },
        zalo: { connected: providers.zalo.connected, mock: providers.zalo.mode !== 'live' },
        ghn: { connected: providers.ghn.connected, mock: providers.ghn.mode !== 'live' },
      },
      providers: {
        meta: {
          provider: providers.meta.provider, mode: providers.meta.mode, configured: providers.meta.configured,
          connected: providers.meta.connected, status_label: providers.meta.status_label,
          last_webhook_at: providers.meta.last_webhook_at, last_success_at: providers.meta.last_success_at,
          last_error_type: providers.meta.last_error_type,
        },
        zalo: {
          provider: providers.zalo.provider, mode: providers.zalo.mode, configured: providers.zalo.configured,
          connected: providers.zalo.connected, status_label: providers.zalo.status_label,
          last_webhook_at: providers.zalo.last_webhook_at, last_success_at: providers.zalo.last_success_at,
          last_error_type: providers.zalo.last_error_type, token_expired: providers.zalo.token_expired,
          quota_verified: providers.zalo.quota_verified,
        },
        ghn: {
          provider: providers.ghn.provider, mode: providers.ghn.mode, configured: providers.ghn.configured,
          connected: providers.ghn.connected, status_label: providers.ghn.status_label,
          last_webhook_at: providers.ghn.last_webhook_at, last_success_at: providers.ghn.last_success_at,
          last_error_type: providers.ghn.last_error_type, environment: providers.ghn.environment,
        },
      },
      clock_now: nowIsoOf(app),
      errors,
      jobs_dead: jobsDead,
      store_write_count: app.store.writeCount,
      components: componentsHealth(app, shopId),
    };
  }

  function settingsView(app, shopId) {
    const ss = settingsFor(shopId);
    const followUps = app.store.findAll('follow_ups', () => true);
    const byStatus = {};
    for (const f of followUps) byStatus[f.status] = (byStatus[f.status] || 0) + 1;
    const kinds = {};
    for (const f of followUps) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
    return {
      bot: { on: botOn(app), autoReply: botOn(app) },
      providers: providersView(app), // trạng thái kết nối — không có secret
      automation: {
        follow_ups_total: followUps.length,
        follow_ups_by_status: byStatus,
        follow_ups_by_kind: kinds,
        opt_out_customers: app.store.findAll('customers', c => c.marketing_opt_out === 1).length,
        config: automationCfg(shopId), // cấu hình follow-up/care/review/purchase-reminder (đợt 2)
      },
      shop: {
        name: ss.get('shop_name') || null,
        hotline: ss.get('shop_hotline') || null,
        address: ss.get('shop_address') || null,
        auto_order: ss.get('auto_order', true) === true,
      },
      // SURI P1: timezone scheduler + hồ sơ shop cho AI đã cấu hình chưa
      timezone: ss.get('timezone') || DEFAULT_TIMEZONE,
      shop_profile_configured: ss.has('shop_profile'),
      ai: aiProvider.aiView(ss), // key đã mask — không bao giờ trả key thô
      config_keys: ss.view(),    // settings shop đã redact (token -> ***xxxx)
    };
  }

  // ============================================================ GHI — đi đúng đường hệ thống
  function apiSendAsAgent(app, convId, text, operator) {
    const conv = app.store.findOne('conversations', c => c.conversation_id === convId);
    if (!conv) return { http: 404, body: { ok: false, error: 'CONVERSATION_NOT_FOUND' } };
    const customer = app.store.findOne('customers', c => c.customer_id === conv.customer_id);
    if (!customer) return { http: 404, body: { ok: false, error: 'CUSTOMER_NOT_FOUND' } };
    if (!text || !String(text).trim()) return { http: 400, body: { ok: false, error: 'EMPTY_TEXT' } };
    const r = app.takeover.agentSend(app.gate, conv, customer, String(text).trim(), operator);
    return { http: 200, body: { ok: true, sent: !!r.sent, reason: r.reason || null, delivery_status: r.delivery_status || null } };
  }

  function apiTakeover(app, convId, operator) {
    const conv = app.store.findOne('conversations', c => c.conversation_id === convId);
    if (!conv) return { http: 404, body: { ok: false, error: 'CONVERSATION_NOT_FOUND' } };
    const r = app.takeover.setTakeover(conv, operator, 'ui_takeover');
    return { http: 200, body: r };
  }

  function apiHandback(app, convId, operator) {
    const conv = app.store.findOne('conversations', c => c.conversation_id === convId);
    if (!conv) return { http: 404, body: { ok: false, error: 'CONVERSATION_NOT_FOUND' } };
    const r = app.takeover.handback(conv, operator);
    return { http: 200, body: r };
  }

  function apiCancelOrder(app, orderId, operator) {
    const order = app.store.findOne('orders', o => o.order_id === orderId);
    if (!order) return { http: 404, body: { ok: false, error: 'ORDER_NOT_FOUND' } };
    const r = app.orders.requestCancelOrder({
      orderId,
      actor: operator,
      reason: 'operator_ui_request',
      eventId: null,
      carrier: app.carrier,
    });
    // đồng bộ state hội thoại như routeCancel của pipeline (đi sessions.transition, không đụng core)
    const conv = app.store.findOne('conversations', c => c.conversation_id === order.conversation_id);
    if (conv && r.ok) {
      try {
        if (order.status === 'DRAFT' && conv.state === 'CONFIRM') app.sessions.transition(conv, 'COLLECT_ORDER', 'operator_order_cancelled');
        else if (['ORDERED', 'CONFIRM'].includes(conv.state)) app.sessions.transition(conv, 'AFTER_SALES', 'operator_order_cancelled');
      } catch (e) { /* transition từ chối thì giữ state cũ */ }
    }
    const fresh = app.store.findOne('orders', o => o.order_id === orderId);
    return {
      http: 200,
      body: {
        ok: !!r.ok,
        viaCarrier: !!r.viaCarrier,
        pending: !!r.pending,
        reason: r.reason || r.carrierReason || null,
        status: fresh ? fresh.status : null,
        order: fresh ? { order_id: fresh.order_id, order_code: fresh.order_code, status: fresh.status } : null,
      },
    };
  }

  // ============================================================ GO-LIVE CHECKLIST + ONBOARDING
  // Rule: bot AUTO chỉ bật được khi bước 1,4,6 xanh + (2 HOẶC 3 xanh) + (5 xanh nếu auto-order).
  function stepRow(id, ten, ok, chiTiet, isError) {
    return { id, ten, status: ok ? 'CONNECTED' : (isError ? 'ERROR' : 'NOT_CONFIGURED'), chiTiet: chiTiet || null };
  }

  // Giá trị cấu hình kênh: settings shop THẮNG env (.env.live) — key dùng cùng tên.
  function cfgVal(shopId, key) {
    const ss = settingsFor(shopId);
    if (ss.has(key)) return String(ss.get(key));
    const v = process.env[key];
    return (v === undefined || v === '') ? '' : String(v);
  }

  function onboardingState(shopId, app) {
    const ss = settingsFor(shopId);
    const steps = [];
    const shopName = ss.get('shop_name');
    const hotline = ss.get('shop_hotline');
    const address = ss.get('shop_address');
    steps.push(stepRow('shop-info', 'Thông tin shop',
      !!(shopName && hotline && address),
      { shop_name: shopName || null, hotline: hotline || null, address: address || null }));

    const fbOk = !!(cfgVal(shopId, 'META_PAGE_ID') && cfgVal(shopId, 'META_PAGE_ACCESS_TOKEN'));
    steps.push(stepRow('facebook', 'Facebook Messenger', fbOk,
      { page_id: cfgVal(shopId, 'META_PAGE_ID') || null, token_masked: cfgVal(shopId, 'META_PAGE_ACCESS_TOKEN') ? '***' : null }));

    const zaloOk = !!(cfgVal(shopId, 'ZALO_OA_ID') && (cfgVal(shopId, 'ZALO_ACCESS_TOKEN') || cfgVal(shopId, 'ZALO_REFRESH_TOKEN')));
    steps.push(stepRow('zalo', 'Zalo OA', zaloOk,
      { oa_id: cfgVal(shopId, 'ZALO_OA_ID') || null, token_masked: (cfgVal(shopId, 'ZALO_ACCESS_TOKEN') || cfgVal(shopId, 'ZALO_REFRESH_TOKEN')) ? '***' : null }));

    const enabledCount = app.productDB.products.filter(p => p.enabled !== false).length;
    steps.push(stepRow('products', 'Sản phẩm', enabledCount >= 1, { enabled_count: enabledCount }));

    const ghnOk = !!(cfgVal(shopId, 'GHN_TOKEN') && cfgVal(shopId, 'GHN_SHOP_ID'));
    steps.push(stepRow('shipping', 'GHN (vận chuyển)', ghnOk,
      { shop_id: cfgVal(shopId, 'GHN_SHOP_ID') || null, token_masked: cfgVal(shopId, 'GHN_TOKEN') ? '***' : null }));

    const aiSt = aiProvider.aiStatus(ss);
    steps.push(stepRow('ai', 'AI Provider', aiSt.status === 'ONLINE', { ...aiSt, api_key: undefined }, aiSt.status === 'ERROR'));

    const tConv = !!app.store.findOne('settings', s => s.key === 'onboarding_test_conversation' && s.value === true);
    const tOrder = !!app.store.findOne('settings', s => s.key === 'onboarding_test_order' && s.value === true);
    steps.push(stepRow('test', 'Test hội thoại + đơn', tConv && tOrder, { test_conversation: tConv, test_order: tOrder }));

    const byId = {};
    for (const s of steps) byId[s.id] = s.status === 'CONNECTED';
    const autoOrder = ss.get('auto_order', true) === true;
    const reasons = [];
    if (!byId['shop-info']) reasons.push('Bước 1: chưa điền đủ tên shop + hotline + địa chỉ');
    if (!byId.products) reasons.push('Bước 4: chưa có sản phẩm nào đang bật bán');
    if (!byId.ai) reasons.push(aiSt.status === 'ERROR'
      ? `Bước 6: AI provider lỗi — ${aiSt.last_error || 'chưa test PASS'}`
      : 'Bước 6: AI provider chưa cấu hình / chưa test PASS');
    if (!byId.facebook && !byId.zalo) reasons.push('Cần kết nối ít nhất 1 kênh: Facebook (bước 2) hoặc Zalo (bước 3)');
    if (autoOrder && !byId.shipping) reasons.push('Bước 5: auto-order đang bật nên cần GHN token + shop id (hoặc tắt auto-order)');
    const canGoLive = reasons.length === 0;
    return { steps, canGoLive, reasons, auto_order: autoOrder, progress: `${steps.filter(s => s.status === 'CONNECTED').length}/7` };
  }

  function apiCompleteStep(app, shopId, body) {
    const stepId = String(body.stepId || '');
    const data = body.data || {};
    const ss = settingsFor(shopId);
    const setIf = (k, v) => { if (v !== undefined && v !== null && String(v).trim() !== '') ss.set(k, String(v).trim()); };
    switch (stepId) {
      case 'shop-info':
        if (data.name !== undefined) ss.set('shop_name', String(data.name || '').trim());
        if (data.hotline !== undefined) ss.set('shop_hotline', String(data.hotline || '').trim());
        if (data.address !== undefined) ss.set('shop_address', String(data.address || '').trim());
        break;
      case 'facebook': // KHÔNG log giá trị token
        setIf('META_PAGE_ID', data.page_id);
        setIf('META_PAGE_ACCESS_TOKEN', data.page_access_token);
        break;
      case 'zalo':
        setIf('ZALO_OA_ID', data.oa_id);
        setIf('ZALO_ACCESS_TOKEN', data.access_token);
        setIf('ZALO_REFRESH_TOKEN', data.refresh_token);
        break;
      case 'shipping':
        setIf('GHN_TOKEN', data.ghn_token);
        setIf('GHN_SHOP_ID', data.ghn_shop_id);
        break;
      case 'ai':
        try { aiProvider.saveAiConfig(ss, data); } catch (e) { return { http: 400, body: { ok: false, error: String(e.message) } }; }
        break;
      case 'settings':
        if (data.auto_order !== undefined) ss.set('auto_order', !!data.auto_order);
        break;
      default:
        return { http: 400, body: { ok: false, error: 'UNKNOWN_STEP' } };
    }
    return { http: 200, body: { ok: true, ...onboardingState(shopId, app) } };
  }

  // Nút test wizard: chạy SỰ KIỆN THẬT qua app.receive (đường webhook) — bật bot tạm thời trong
  // lúc test (server-level, có khôi phục ngay; core KHÔNG đổi), xong set CỜ vào settings store.
  function withTempBotOn(app, fn) {
    const getRow = () => app.store.findOne('settings', s => s.key === 'bot_enabled');
    const prev = getRow().value !== false;
    if (!prev) {
      app.store.transaction(() => {
        app.store.updateRow('settings', getRow(), { value: true });
        app.store.audit({ event_id: null, conversation_id: null, customer_ref: null, proposed_action: 'ONBOARDING_TEST_BOT_TEMP_ON', validation: { temp: true }, execution_result: 'OK', receipt: null, stage: 'SETTINGS' });
      });
    }
    try {
      return fn();
    } finally {
      if (!prev) {
        app.store.transaction(() => {
          app.store.updateRow('settings', getRow(), { value: false });
          app.store.audit({ event_id: null, conversation_id: null, customer_ref: null, proposed_action: 'ONBOARDING_TEST_BOT_TEMP_OFF', validation: { temp: true }, execution_result: 'OK', receipt: null, stage: 'SETTINGS' });
        });
      }
    }
  }

  function pump(app, stepMs) {
    const target = Math.min(Date.now(), app.clock.now() + stepMs);
    app.clock.advance(target);
    for (let i = 0; i < 10 && app.gateway.queue.length; i++) app.gateway.processQueue();
    app.runDueJobs();
  }

  let testSeq = 0;
  function seedEvent(app, channel, ref, text, extra = {}) {
    testSeq += 1;
    return app.receive({
      channel,
      type: 'message',
      platformEventId: extra.pid || `ui-seed-${ref}-${testSeq}`,
      payload: {
        customer_ref: ref,
        thread_id: ref,
        kind: extra.kind || 'text',
        text: text || '',
        media: extra.media,
        platform_message_id: `pm-ui-${testSeq}`,
      },
    });
  }

  function apiOnboardingTestConversation(app) {
    return withTempBotOn(app, () => {
      const ref = `onboard-conv-${Date.now()}`;
      seedEvent(app, 'facebook', ref, 'nến vanilla size M giá bao nhiêu vậy shop');
      app.drain();
      const conv = app.store.findOne('conversations', c => c.platform_thread_id === ref);
      const botMsgs = conv ? app.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'out') : [];
      const sent = botMsgs.some(m => m.delivery_status);
      app.store.transaction(() => {
        const row = app.store.findOne('settings', s => s.key === 'onboarding_test_conversation');
        if (row) app.store.updateRow('settings', row, { value: sent, updated_at: app.store.now() });
        else app.store.insert('settings', { key: 'onboarding_test_conversation', value: sent, updated_at: app.store.now() });
      });
      return { http: 200, body: { ok: sent, bot_replied: sent, last_reply: botMsgs.length ? botMsgs[botMsgs.length - 1].text_content : null } };
    });
  }

  function apiOnboardingTestOrder(app) {
    return withTempBotOn(app, () => {
      const ref = `onboard-order-${Date.now()}`;
      seedEvent(app, 'facebook', ref, 'lấy 1 nến vanilla M đỏ, tên Test Owner, sdt 0909998877, địa chỉ 12 Nguyễn Huệ Q1 TP.HCM');
      pump(app, 3 * 60 * 1000);
      seedEvent(app, 'facebook', ref, 'xác nhận');
      pump(app, 2 * 60 * 1000);
      app.drain();
      const conv = app.store.findOne('conversations', c => c.platform_thread_id === ref);
      const order = conv ? app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'CONFIRMED') : null;
      app.store.transaction(() => {
        const row = app.store.findOne('settings', s => s.key === 'onboarding_test_order');
        if (row) app.store.updateRow('settings', row, { value: !!order, updated_at: app.store.now() });
        else app.store.insert('settings', { key: 'onboarding_test_order', value: !!order, updated_at: app.store.now() });
      });
      return {
        http: 200,
        body: {
          ok: !!order,
          order: order ? { order_id: order.order_id, order_code: order.order_code, total: order.total, status: order.status } : null,
        },
      };
    });
  }

  function apiSetBot(app, on) {
    if (on) {
      const shopId = shopIdOfApp(app);
      const ob = onboardingState(shopId, app);
      if (!ob.canGoLive) return { http: 403, body: { ok: false, error: 'GO_LIVE_CHECKLIST', reasons: ob.reasons } };
    }
    const row = app.store.findOne('settings', s => s.key === 'bot_enabled');
    if (!row) return { http: 500, body: { ok: false, error: 'SETTINGS_ROW_MISSING' } };
    app.store.transaction(() => {
      app.store.updateRow('settings', row, { value: !!on, updated_at: app.store.now() });
      app.store.audit({
        event_id: null, conversation_id: null, customer_ref: null,
        proposed_action: 'BOT_ENABLED_TOGGLE',
        validation: { from: row.value !== false, to: !!on, actor: 'owner' },
        execution_result: 'OK', receipt: null, stage: 'SETTINGS',
      });
    });
    return { http: 200, body: { ok: true, on: botOn(app) } };
  }

  function shopIdOfApp(app) {
    for (const [sid, a] of apps.entries()) if (a === app) return sid;
    return null;
  }

  // ============================================================ SẢN PHẨM — overrides per shop
  function readOverrides(shopId) {
    try { return JSON.parse(fs.readFileSync(overridesFileFor(shopId), 'utf8')); } catch (e) { return { added: [], patches: {}, disabled: {} }; }
  }
  function writeOverrides(shopId, o) {
    fs.writeFileSync(overridesFileFor(shopId), JSON.stringify(o, null, 1));
  }
  function applyOverrides(app, shopId) {
    // PRODUCT-READY đợt 2 (PS09): logic áp overrides về MỘT NƠI (product-db.applyProductOverrides)
    // — App tự áp lại khi restart ở mức App; server áp khi dựng App + mỗi lần ghi overrides.
    const n = applyProductOverrides(app.productDB, readOverrides(shopId));
    if (n > 0) productVersions.set(shopId, (productVersions.get(shopId) || 0) + 1);
  }

  function addProductRow(app, shopId, body) {
    const name = String(body.name || '').trim();
    const skuBase = String(body.sku_base || '').trim().toUpperCase().replace(/\s+/g, '-');
    const price = Math.round(Number(body.price));
    const stock = Math.round(Number(body.stock_qty === undefined ? 0 : body.stock_qty));
    if (!name || !skuBase) return { http: 400, body: { ok: false, error: 'MISSING_NAME_OR_SKU' } };
    if (!Number.isFinite(price) || price <= 0) return { http: 400, body: { ok: false, error: 'BAD_PRICE' } };
    if (app.productDB.getProductByBase(skuBase)) return { http: 409, body: { ok: false, error: 'SKU_BASE_EXISTS' } };
    const aliases = String(body.aliases || '').split(',').map(s => s.trim()).filter(Boolean);
    const variantSku = `${skuBase}-1`;
    const product = {
      product_id: 'prd_' + skuBase.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      sku_base: skuBase,
      name,
      aliases,
      category: String(body.category || 'khác'),
      images: [],
      weight_g: Number(body.weight_g) || 100,
      attributes: {},
      enabled: true,
      variants: [{
        sku: variantSku, size: String(body.size || 'free'), color: body.color ? String(body.color) : null,
        price, stock_qty: Math.max(0, stock), stock_reserved: 0,
      }],
    };
    const o = readOverrides(shopId);
    app.store.transaction(() => {
      app.productDB.products.push(product);
      app.store.audit({
        event_id: null, conversation_id: null, customer_ref: null,
        proposed_action: 'PRODUCT_ADD', validation: { sku_base: skuBase, variant_sku: variantSku, price },
        execution_result: 'OK', receipt: null, stage: 'SETTINGS',
      });
    });
    o.added = o.added || [];
    o.added.push(product);
    if (o.disabled) delete o.disabled[skuBase];
    writeOverrides(shopId, o);
    applyOverrides(app, shopId);
    return { http: 200, body: { ok: true, sku_base: skuBase, variant_sku: variantSku } };
  }

  function apiAddProduct(app, shopId, body) {
    return addProductRow(app, shopId, body);
  }

  function apiImportProducts(app, shopId, csv) {
    const { rows, errors } = parseProductsCsv(csv);
    let imported = 0;
    const rowErrors = errors.map(e => ({ ...e }));
    for (const r of rows) {
      const res = addProductRow(app, shopId, r);
      if (res.http === 200) imported += 1;
      else rowErrors.push({ line: null, sku: r.sku_base, error: res.body.error });
    }
    return {
      http: 200,
      body: { ok: rowErrors.length === 0, imported, failed: rowErrors.length, errors: rowErrors, total_lines: rows.length + errors.length },
    };
  }

  function apiUpdateProduct(app, shopId, skuBase, body) {
    const p = app.productDB.getProductByBase(skuBase);
    if (!p) return { http: 404, body: { ok: false, error: 'PRODUCT_NOT_FOUND' } };
    const o = readOverrides(shopId);
    o.patches = o.patches || {};
    const patch = o.patches[skuBase] = o.patches[skuBase] || { variants: {} };
    app.store.transaction(() => {
      if (body.name !== undefined && String(body.name).trim()) { p.name = String(body.name).trim(); patch.name = p.name; }
      if (body.aliases !== undefined) {
        p.aliases = String(body.aliases).split(',').map(s => s.trim()).filter(Boolean);
        patch.aliases = p.aliases;
      }
      const variantSku = String(body.sku || (p.variants[0] ? p.variants[0].sku : ''));
      const v = p.variants.find(x => x.sku === variantSku);
      if (v) {
        const price = body.price !== undefined ? Math.round(Number(body.price)) : undefined;
        if (Number.isFinite(price) && price > 0) v.price = price;
        const pv = patch.variants[variantSku] = patch.variants[variantSku] || {};
        if (Number.isFinite(price) && price > 0) pv.price = price;
        if (body.stock_qty !== undefined) {
          const q = Math.max(0, Math.round(Number(body.stock_qty)));
          if (Number.isFinite(q)) app.productDB.setStock(variantSku, q);
          pv.stock_qty = q;
        }
      }
      if (body.enabled !== undefined) {
        o.disabled = o.disabled || {};
        if (body.enabled) delete o.disabled[skuBase];
        else o.disabled[skuBase] = true;
        patch.enabled = !!body.enabled;
        p.enabled = !!body.enabled;
        const key = `product_disabled:${skuBase}`;
        const row = app.store.findOne('settings', s => s.key === key);
        app.store.transaction(() => {
          if (row) app.store.updateRow('settings', row, { value: !body.enabled, updated_at: app.store.now() });
          else app.store.insert('settings', { key, value: !body.enabled, updated_at: app.store.now() });
          app.store.audit({
            event_id: null, conversation_id: null, customer_ref: null,
            proposed_action: 'PRODUCT_TOGGLE', validation: { sku_base: skuBase, enabled: !!body.enabled },
            execution_result: 'OK', receipt: null, stage: 'SETTINGS',
          });
        });
      }
      app.store.audit({
        event_id: null, conversation_id: null, customer_ref: null,
        proposed_action: 'PRODUCT_UPDATE', validation: { sku_base: skuBase, fields: Object.keys(body) },
        execution_result: 'OK', receipt: null, stage: 'SETTINGS',
      });
    });
    writeOverrides(shopId, o);
    applyOverrides(app, shopId);
    return { http: 200, body: { ok: true, sku_base: skuBase, enabled: p.enabled !== false } };
  }

  // DELETE = XÓA MỀM (disabled) — không xoá dữ liệu đơn/audit đã tham chiếu SKU.
  function apiDeleteProduct(app, shopId, skuBase) {
    const p = app.productDB.getProductByBase(skuBase);
    if (!p) return { http: 404, body: { ok: false, error: 'PRODUCT_NOT_FOUND' } };
    return apiUpdateProduct(app, shopId, skuBase, { enabled: false });
  }

  // ============================================================ IN-APP NOTIFICATIONS (đợt 2)
  // Suy ra TỪ store THẬT của shop: worklist NEEDS_HUMAN + đơn lỗi (CANCEL_PENDING) + DLQ +
  // token expired (provider status) + quota low (channel_budget <= ngưỡng core) + jobs DEAD.
  // Read-state per shop lưu file TRONG dataDir của shop — không đụng core store.
  // (Không email / không web-push — xem KNOWN LIMITATIONS trong PHASE-PRODUCT-READY-P2.md.)
  function notifReadFile(shopId) {
    const shop = auth.getShop(shopId);
    return path.join(shop.dataDir, 'notifications-read.json');
  }
  function notifReadMap(shopId) {
    try { return JSON.parse(fs.readFileSync(notifReadFile(shopId), 'utf8')) || {}; } catch (e) { return {}; }
  }
  function markNotifsRead(shopId, ids) {
    const map = notifReadMap(shopId);
    const now = new Date().toISOString();
    for (const id of ids || []) if (id) map[id] = now;
    fs.writeFileSync(notifReadFile(shopId), JSON.stringify(map, null, 1));
    return map;
  }
  function notificationsFor(app, shopId) {
    const readMap = notifReadMap(shopId);
    const out = [];
    const push = (id, type, message, time) => {
      if (!id) return;
      out.push({ id, type, message, time: time || null, read: !!readMap[id] });
    };
    for (const w of app.store.findAll('worklist', x => x.status === 'OPEN')) {
      push(`worklist:${w.worklist_id}`, 'needs_human', `Cần nhân viên: ${w.reason}`, w.created_at);
    }
    for (const c of app.store.findAll('conversations', x => x.flag_needs_human)) {
      const open = app.store.findAll('worklist', w => w.conversation_id === c.conversation_id && w.status === 'OPEN').length > 0;
      if (!open) push(`conv_nh:${c.conversation_id}`, 'needs_human', `Hội thoại ${c.conversation_id} đang cờ cần người xử lý`, c.last_activity_at);
    }
    for (const o of app.store.findAll('orders', x => x.status === 'CANCEL_PENDING')) {
      push(`order_pending:${o.order_id}`, 'order_error',
        `Đơn ${o.order_code} chờ hủy qua ĐVVC: ${o.cancel_carrier_reason || o.cancel_reason || 'không rõ lý do'}`,
        o.cancel_pending_at || o.updated_at || o.created_at);
    }
    app.store.findAll('dlq', () => true).forEach(d => {
      push(`dlq:${d.dlq_id}`, 'dlq', `Tin/tác vụ treo DLQ: ${d.fail_reason}`, d.created_at);
    });
    const pv = providersView(app);
    if (pv.zalo.token_expired) push('token_expired:zalo', 'token_expired', 'Zalo OA access token đã hết hạn — cần refresh token', new Date().toISOString());
    if (pv.meta.last_error_type === 'auth') push('token_expired:meta', 'token_expired', 'Facebook Page token bị từ chối quyền — kiểm tra lại token', pv.meta.last_success_at || null);
    for (const b of app.store.findAll('channel_budget', x => x.cs_remain <= 2)) {
      push(`quota_low:${b.conversation_id}`, 'quota_low',
        `Quota Zalo CS sắp cạn (${b.cs_remain}/${b.cs_total}) — ${b.conversation_id}`, new Date().toISOString());
    }
    for (const j of app.store.findAll('jobs', x => x.status === 'DEAD')) {
      push(`job_dead:${j.job_id}`, 'job_dead', `Job ${j.kind} DEAD: ${j.last_error || 'không rõ lỗi'}`, j.updated_at || j.created_at);
    }
    out.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
    return out;
  }

  // ============================================================ AUTOMATION SETTINGS (đợt 2)
  // Cấu hình follow-up sau giao + care/review/purchase-reminder — LƯU settings (ShopSettings).
  // HIỆU LỰC qua bộ điều phối server-level bên dưới: chỉ CHỈNH/CANCEL/TẠO row follow_ups
  // (dữ liệu) — việc GỬI vẫn do scheduler + SendPolicy của core quyết định (Window 24h /
  // Quota Zalo / Opt-out / Receipt KHÔNG BAO GIỜ bị vòng này bỏ qua — không đụng action-gate).
  const AUTOMATION_DEFAULTS = {
    followup_delivery_hours: 48,        // giờ sau DELIVERED khi care/review được gửi
    care_enabled: true,                 // follow-up sau giao (AFTER_DELIVERY_FEEDBACK do core tạo)
    review_enabled: true,               // REVIEW_REQUEST — xin đánh giá (row do bộ điều phối tạo)
    purchase_reminder_enabled: false,   // nhắc mua lại — kind MARKETING (chịu opt-out + cửa sổ)
    purchase_reminder_days: 7,          // ngày sau DELIVERED khi nhắc mua lại
  };
  function automationCfg(shopId) {
    const ss = settingsFor(shopId);
    const num = (k, d, min, max) => {
      const v = Number(ss.get(k));
      return Number.isFinite(v) && v >= min && v <= max ? v : d;
    };
    const bool = (k, d) => ss.get(k, d) === true || ss.get(k, d) === 'true';
    return {
      followup_delivery_hours: num('automation_followup_delivery_hours', AUTOMATION_DEFAULTS.followup_delivery_hours, 1, 24 * 30),
      care_enabled: bool('automation_care_enabled', AUTOMATION_DEFAULTS.care_enabled),
      review_enabled: bool('automation_review_enabled', AUTOMATION_DEFAULTS.review_enabled),
      purchase_reminder_enabled: bool('automation_purchase_reminder_enabled', AUTOMATION_DEFAULTS.purchase_reminder_enabled),
      purchase_reminder_days: num('automation_purchase_reminder_days', AUTOMATION_DEFAULTS.purchase_reminder_days, 1, 365),
    };
  }
  function automationView(app, shopId) {
    const tz = settingsFor(shopId).get('timezone') || DEFAULT_TIMEZONE;
    // SURI P1 (hạng mục 5): follow-up đến hạn hiển thị GIỜ VN (Asia/Ho_Chi_Minh, GMT+7).
    const upcoming = app.store.findAll('follow_ups', f => f.status === 'SCHEDULED')
      .sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)))
      .slice(0, 5)
      .map(f => ({
        follow_up_id: f.follow_up_id, kind: f.kind, conversation_id: f.conversation_id,
        scheduled_at: f.scheduled_at, scheduled_at_vn: fmtVnTime(f.scheduled_at, tz),
      }));
    return Object.assign({}, automationCfg(shopId), {
      timezone: tz,
      follow_ups_total: app.store.findAll('follow_ups', () => true).length,
      review_scheduled: app.store.findAll('follow_ups', f => f.kind === 'REVIEW_REQUEST' && f.status === 'SCHEDULED').length,
      reminder_scheduled: app.store.findAll('follow_ups', f => f.kind === 'MARKETING' && f.status === 'SCHEDULED').length,
      upcoming_follow_ups: upcoming,
    });
  }
  function apiSaveAutomation(app, shopId, body) {
    const ss = settingsFor(shopId);
    const hours = Number(body.followup_delivery_hours);
    const days = Number(body.purchase_reminder_days);
    if (body.followup_delivery_hours !== undefined && (!Number.isFinite(hours) || hours < 1 || hours > 24 * 30)) {
      return { http: 400, body: { ok: false, error: 'BAD_HOURS (1..720)' } };
    }
    if (body.purchase_reminder_days !== undefined && (!Number.isFinite(days) || days < 1 || days > 365)) {
      return { http: 400, body: { ok: false, error: 'BAD_DAYS (1..365)' } };
    }
    if (body.followup_delivery_hours !== undefined) ss.set('automation_followup_delivery_hours', Math.round(hours));
    if (body.care_enabled !== undefined) ss.set('automation_care_enabled', !!body.care_enabled);
    if (body.review_enabled !== undefined) ss.set('automation_review_enabled', !!body.review_enabled);
    if (body.purchase_reminder_enabled !== undefined) ss.set('automation_purchase_reminder_enabled', !!body.purchase_reminder_enabled);
    if (body.purchase_reminder_days !== undefined) ss.set('automation_purchase_reminder_days', Math.round(days));
    app.store.audit({
      event_id: null, conversation_id: null, customer_ref: null,
      proposed_action: 'AUTOMATION_SETTINGS_SAVE', validation: automationCfg(shopId),
      execution_result: 'OK', receipt: null, stage: 'SETTINGS',
    });
    applyAutomation(app, shopId); // áp NGAY, không đợi tick
    return { http: 200, body: { ok: true, automation: automationView(app, shopId) } };
  }
  const FU_AUTO_ID = (kind, orderId) => `fu_auto_${String(kind).toLowerCase()}_${orderId}`;
  // Bộ điều phối: chạy mỗi tick cho MỖI shop — idempotent (key theo order+kind; sửa chỉ khi lệch).
  // Mọi mutation bọc store.transaction (persist NGAY — restart không mất lịch đã điều phối).
  function applyAutomation(app, shopId) {
    const cfg = automationCfg(shopId);
    const store = app.store;
    const HOUR = 3600 * 1000;
    let changed = 0;
    store.transaction(() => {
      for (const order of store.findAll('orders', o => o.status === 'DELIVERED')) {
        const coreFu = store.findOne('follow_ups', f => f.order_id === order.order_id && f.kind === 'AFTER_DELIVERY_FEEDBACK');
        const baseAt = coreFu ? Date.parse(coreFu.created_at) : Date.parse(order.updated_at || order.created_at);
        if (!Number.isFinite(baseAt)) continue;
        const conv = store.findOne('conversations', c => c.conversation_id === order.conversation_id);
        const customer = store.findOne('customers', c => c.customer_id === order.customer_id);
        const cancelKind = (kind, reason) => {
          for (const f of store.findAll('follow_ups', x => x.order_id === order.order_id && x.kind === kind && x.status === 'SCHEDULED')) {
            store.updateRow('follow_ups', f, { status: 'CANCELLED', cancel_reason: reason });
            changed += 1;
          }
        };
        const ensureKind = (kind, atMs) => {
          const existed = store.findOne('follow_ups', f => f.order_id === order.order_id && f.kind === kind);
          if (existed) {
            if (existed.status === 'SCHEDULED') {
              const desired = new Date(atMs).toISOString();
              if (existed.scheduled_at !== desired) { store.updateRow('follow_ups', existed, { scheduled_at: desired }); changed += 1; }
            }
            return;
          }
          if (!conv || !customer) return;
          store.insert('follow_ups', {
            follow_up_id: FU_AUTO_ID(kind, order.order_id),
            order_id: order.order_id, conversation_id: order.conversation_id, customer_id: order.customer_id,
            kind, scheduled_at: new Date(atMs).toISOString(),
            status: 'SCHEDULED', cancel_reason: null, exec_id: null,
            created_at: store.now(), updated_at: store.now(), source: 'automation_settings',
          });
          changed += 1;
        };
        // care: core TỰ tạo AFTER_DELIVERY_FEEDBACK (+2 ngày cứng) — settings hủy khi tắt,
        // đổi giờ khi cấu hình khác (chỉnh ROW, không đụng code pipeline).
        if (coreFu && coreFu.status === 'SCHEDULED') {
          if (!cfg.care_enabled) {
            store.updateRow('follow_ups', coreFu, { status: 'CANCELLED', cancel_reason: 'care_disabled_setting' });
            changed += 1;
          } else {
            const desired = new Date(Date.parse(coreFu.created_at) + cfg.followup_delivery_hours * HOUR).toISOString();
            if (coreFu.scheduled_at !== desired) { store.updateRow('follow_ups', coreFu, { scheduled_at: desired }); changed += 1; }
          }
        } else if (cfg.care_enabled === false) {
          cancelKind('AFTER_DELIVERY_FEEDBACK', 'care_disabled_setting');
        }
        if (cfg.review_enabled) ensureKind('REVIEW_REQUEST', baseAt + cfg.followup_delivery_hours * HOUR);
        else cancelKind('REVIEW_REQUEST', 'review_disabled_setting');
        if (cfg.purchase_reminder_enabled) ensureKind('MARKETING', baseAt + cfg.purchase_reminder_days * 24 * HOUR);
        else cancelKind('MARKETING', 'purchase_reminder_disabled_setting');
      }
    });
    return changed;
  }

  // ============================================================ ORDER ACTIONS (đợt 2)
  // CONFIRM: operator chốt đơn DRAFT — đi ĐÚNG pha B của order engine (re-validate tồn/giá
  // MỚI NHẤT trong transaction + commit), KHÔNG update DB trực tiếp. Không tự gửi tin khách
  // (operator hành động từ UI; tin cho khách vẫn do bot/agent gửi đúng luồng).
  function apiConfirmOrder(app, orderId, operator) {
    const order = app.store.findOne('orders', o => o.order_id === orderId);
    if (!order) return { http: 404, body: { ok: false, error: 'ORDER_NOT_FOUND' } };
    if (order.status === 'CONFIRMED') return { http: 200, body: { ok: true, idempotent: true, order: { order_id: order.order_id, order_code: order.order_code, status: order.status } } };
    if (order.status !== 'DRAFT') return { http: 409, body: { ok: false, error: 'NOT_DRAFT', status: order.status } };
    const r = app.orders.phaseB({ orderId, eventId: null });
    if (!r.ok) {
      return { http: 409, body: { ok: false, error: r.reason || 'CONFIRM_FAILED', sku: r.sku || null, db_price: r.db_price || null } };
    }
    // đồng bộ state hội thoại như routeConfirm của pipeline làm sau pha B (CONFIRM -> ORDERED):
    // operator chốt thay khách xác nhận — hội thoại không được kẹt ở CONFIRM (mua lại/sau bán
    // phải chạy đúng luồng). Đi qua sessions.transition (audit STATE đầy đủ), không đụng core.
    const convForState = app.store.findOne('conversations', c => c.conversation_id === order.conversation_id);
    if (convForState) {
      try { app.sessions.transition(convForState, 'ORDERED', 'operator_confirm'); } catch (e) { /* transition từ chối thì giữ state cũ */ }
    }
    // CONFIRMED -> tạo vận đơn ĐÚNG flow core (pipeline.routeConfirm cũng gọi createShipment);
    // carrier treo -> TIMEOUT_UNKNOWN + job reconcile (không retry mù) — hành vi core giữ nguyên.
    let shipment = null;
    try {
      const ship = app.orders.createShipment({ order: app.store.findOne('orders', o => o.order_id === orderId), carrier: app.carrier });
      shipment = ship.ok ? ship.shipment : null;
    } catch (e) { shipment = null; }
    app.store.audit({
      event_id: null, conversation_id: order.conversation_id, customer_ref: order.customer_id,
      proposed_action: 'OPERATOR_CONFIRM_ORDER',
      validation: { operator, order_id: orderId, via: 'phaseB_engine' },
      execution_result: 'OK', receipt: null, stage: 'EXECUTED',
    });
    const fresh = app.store.findOne('orders', o => o.order_id === orderId);
    return {
      http: 200,
      body: {
        ok: true,
        order: { order_id: fresh.order_id, order_code: fresh.order_code, status: fresh.status, total: fresh.total },
        shipment: shipment ? { tracking_number: shipment.tracking_number, status: shipment.status } : null,
        shipment_pending: !shipment,
      },
    };
  }
  // RETRY SHIPPING — CHỈ khi policy cho (KHÔNG tự đổi status đơn/vận đơn, gọi lại đúng flow P3B):
  //   (a) CANCEL_PENDING + vận đơn còn + intent cancel FAILED (từ chối RÕ có receipt) ->
  //       re-arm intent (lưu trữ row FAILED cũ dưới key :attempt-N, GIỮ NGUYÊN lịch sử) rồi
  //       gọi lại orders.cancelShipmentViaCarrier — engine tự làm intent mới + carrier + restock.
  //       Lý do phải re-arm: nhánh retry FAILED của cancelShipmentViaCarrier hiện là dead-code
  //       (insert mới bị unique index idempotency_key chặn — đã báo CHANGE REQUEST, KHÔNG đụng core).
  //   (b) CONFIRMED + CHƯA có vận đơn + create exec TIMEOUT_UNKNOWN/INTENT -> reconcileShipment
  //       (tra clientOrderCode; chưa tồn tại mới tạo lại với CÙNG idempotency key) — path engine sẵn có.
  function rearmCancelIntent(app, orderId, operator) {
    const idem = `cancel_shipment:${orderId}`;
    const exec = app.store.findOne('action_executions', x => x.idempotency_key === idem);
    if (!exec || exec.status !== 'FAILED') return false;
    const attempts = app.store.findAll('action_executions', x =>
      String(x.idempotency_key || '').startsWith(`${idem}:attempt-`)).length;
    app.store.transaction(() => {
      app.store.updateRow('action_executions', exec, { idempotency_key: `${idem}:attempt-${attempts + 1}` });
      app.store.audit({
        event_id: null, conversation_id: null, customer_ref: null,
        proposed_action: 'RETRY_REARM_CANCEL_INTENT',
        validation: { operator, order_id: orderId, archived_key: `${idem}:attempt-${attempts + 1}`, prior_status: 'FAILED' },
        execution_result: 'OK', receipt: null, stage: 'EXECUTED',
      });
    });
    return true;
  }
  function apiRetryShipping(app, orderId, operator) {
    const order = app.store.findOne('orders', o => o.order_id === orderId);
    if (!order) return { http: 404, body: { ok: false, error: 'ORDER_NOT_FOUND' } };
    const shipment = app.store.findOne('shipments', s => s.order_id === orderId && s.status !== 'CANCELLED');
    if (order.status === 'CANCEL_PENDING' && shipment) {
      const exec = app.store.findOne('action_executions', e => e.idempotency_key === `cancel_shipment:${orderId}`);
      if (!exec || exec.status !== 'FAILED') {
        return { http: 409, body: { ok: false, error: 'RETRY_NOT_ALLOWED', reason: `cancel_exec_status_${exec ? exec.status : 'missing'} (chỉ retry khi carrier đã TỪ CHỐI RÕ)` } };
      }
      rearmCancelIntent(app, orderId, operator);
      const r = app.orders.cancelShipmentViaCarrier({
        order: app.store.findOne('orders', o => o.order_id === orderId),
        shipment, actor: operator, reason: order.cancel_reason || 'operator_retry_cancel',
        eventId: null, carrier: app.carrier,
      });
      const fresh = app.store.findOne('orders', o => o.order_id === orderId);
      return {
        http: 200,
        body: {
          ok: !!r.ok, retried: 'cancel_via_carrier', reason: r.reason || null,
          order: { order_id: fresh.order_id, order_code: fresh.order_code, status: fresh.status },
        },
      };
    }
    if (order.status === 'CONFIRMED' && !shipment) {
      const exec = app.store.findOne('action_executions', e => e.idempotency_key === `shipment:${orderId}`);
      if (!exec || (exec.status !== 'TIMEOUT_UNKNOWN' && exec.status !== 'INTENT')) {
        return { http: 409, body: { ok: false, error: 'RETRY_NOT_ALLOWED', reason: `create_exec_status_${exec ? exec.status : 'missing'}` } };
      }
      const r = app.orders.reconcileShipment({ order, carrier: app.carrier });
      app.store.audit({
        event_id: null, conversation_id: order.conversation_id, customer_ref: order.customer_id,
        proposed_action: 'OPERATOR_RETRY_SHIPPING',
        validation: { operator, order_id: orderId, via: 'reconcile_shipment' },
        execution_result: r.ok ? 'OK' : `FAILED:${r.reason || '?'}`, receipt: null, stage: 'EXECUTED',
      });
      const fresh = app.store.findOne('orders', o => o.order_id === orderId);
      const sh = r.ok ? app.store.findOne('shipments', s => s.order_id === orderId) : null;
      return {
        http: 200,
        body: {
          ok: !!r.ok, retried: 'reconcile_shipment', resolved: r.resolved || null, reason: r.reason || null,
          order: { order_id: fresh.order_id, order_code: fresh.order_code, status: fresh.status },
          shipment: sh ? { tracking_number: sh.tracking_number, status: sh.status } : null,
        },
      };
    }
    return { http: 409, body: { ok: false, error: 'RETRY_NOT_ALLOWED', reason: `status_${order.status}${shipment ? '_with_shipment' : '_no_shipment'}` } };
  }
  // CLOSE CLAIM (P3B-4) — đúng sessions.closeClaim (restore origin_state + audit), KHÔNG đụng core.
  function apiCloseClaim(app, convId, operator) {
    const conv = app.store.findOne('conversations', c => c.conversation_id === convId);
    if (!conv) return { http: 404, body: { ok: false, error: 'CONVERSATION_NOT_FOUND' } };
    const r = app.sessions.closeClaim(conv, operator, 'operator_ui_request');
    if (!r.ok) return { http: 409, body: { ok: false, error: r.reason || 'CLOSE_CLAIM_FAILED' } };
    return { http: 200, body: { ok: true, restored_state: r.restored_state, mode: conv.mode } };
  }

  // ============================================================ DEMO SEED — bắn event THẬT qua app.receive
  function seedDemo(app) {
    const FB = 'facebook';
    const ZL = 'zalo';
    seedEvent(app, FB, 'fb-mai', 'nen vanila size M bao nhiêu vậy shop');
    pump(app, 4 * 60 * 1000);
    seedEvent(app, FB, 'fb-mai', 'mình là Mai, còn size S không shop?');
    pump(app, 3 * 60 * 1000);
    seedEvent(app, FB, 'fb-hung', 'lấy 1 nến vanilla M đỏ, tên Anh Hùng, sdt 0903333444, địa chỉ 45 Lê Lợi Q1 TP.HCM');
    pump(app, 5 * 60 * 1000);
    seedEvent(app, FB, 'fb-hung', 'xác nhận');
    pump(app, 2 * 60 * 1000);
    seedEvent(app, FB, 'fb-canh', 'shop lừa đảo quá, đơn hàng lỗi rồi nhé');
    pump(app, 4 * 60 * 1000);
    seedEvent(app, ZL, 'zalo-minh', 'tra hoa say con khong shop');
    pump(app, 3 * 60 * 1000);
    seedEvent(app, ZL, 'zalo-minh', 'cho minh 2 hop tra hoa say, tên Minh, sdt 0911222333');
    pump(app, 3 * 60 * 1000);
    seedEvent(app, FB, 'fb-lan', 'lấy 1 hộp trà hoa sấy, tên Lan, sdt 0935556667, địa chỉ 8 Trần Phú Q.Người Cà Mau');
    pump(app, 5 * 60 * 1000);
    seedEvent(app, FB, 'fb-lan', 'xác nhận');
    pump(app, 2 * 60 * 1000);
    {
      const conv = app.store.findOne('conversations', c => c.conversation_id === `${FB}:fb-lan`);
      const order = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id && o.status === 'CONFIRMED');
      const sh = order && app.store.findOne('shipments', s => s.order_id === order.order_id);
      if (sh) {
        app.carrier.setStatus(sh.tracking_number, 'DELIVERED');
        app.pipeline.onCarrierStatus(order.order_id);
      }
      pump(app, 3 * 60 * 1000);
    }
    seedEvent(app, FB, 'fb-lan', 'không nhận khuyến mại nữa nha shop');
    pump(app, 3 * 60 * 1000);
    app.clock.advance(Date.now() - 2000);
    app.gateway.processQueue();
    app.runDueJobs();
  }

  // ============================================================ SSE + tick runtime
  let sseClients = [];
  let lastFingerprint = '';

  function fingerprint() {
    let f = '';
    for (const [shopId, app] of apps.entries()) {
      f += `#${shopId}:w${app.store.writeCount};pv${productVersions.get(shopId) || 0}`;
      for (const c of Object.keys(app.store.db)) {
        const rows = app.store.db[c];
        const last = rows.length ? rows[rows.length - 1] : null;
        f += `|${c}:${rows.length}:${last ? String(last.updated_at || last.created_at || last.at || '') : ''}`;
      }
    }
    return f;
  }

  function broadcast(msg) {
    const payload = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of sseClients) { try { res.write(payload); } catch (e) { /* client mất */ } }
  }

  function tick() {
    try {
      for (const [shopId, app] of apps.entries()) {
        const real = Date.now();
        if (real > app.clock.now()) app.clock.advance(real);
        app.gateway.processQueue();
        app.runDueJobs();
        try { applyAutomation(app, shopId); } catch (err) { console.error('[automation]', err && err.message); }
      }
      const fp = fingerprint();
      if (fp !== lastFingerprint) {
        lastFingerprint = fp;
        // SSE đẩy cập nhật: kèm số notification CHƯA ĐỌC theo từng shop để client cập nhật
        // chuông + title không phải refetch toàn bộ (in-app notifications — đợt 2).
        const unreadByShop = {};
        for (const [shopId, app] of apps.entries()) {
          try { unreadByShop[shopId] = notificationsFor(app, shopId).filter(n => !n.read).length; } catch (e) { /* bỏ qua */ }
        }
        broadcast({ type: 'update', at: new Date().toISOString(), unread_by_shop: unreadByShop });
      }
    } catch (err) {
      console.error('[tick]', err && err.message);
    }
  }

  // ============================================================ AUTH plumbing
  function parseCookies(req) {
    const out = {};
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  function sessionUser(req) {
    const cookies = parseCookies(req);
    return auth.userForToken(cookies.sid || null);
  }

  function setSessionCookie(res, token) {
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${7 * 24 * 3600}`);
  }
  function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  }

  const ROLE_RANK = { AGENT: 1, ADMIN: 2, OWNER: 3 };
  function atLeast(user, role) { return user && (ROLE_RANK[user.role] || 0) >= (ROLE_RANK[role] || 0); }

  // AGENT (nhân viên): chỉ conversations + orders (xem/xử lý) + products/customers READ-only.
  // SURI P1: thêm đọc agent tools/runs + shop-profile (READ-only — POST/mai_wire không cho AGENT).
  function agentAllowed(method, p) {
    if (method === 'GET') {
      return p === '/api/dashboard' || p === '/api/health' || p === '/api/analytics'
        || p === '/api/conversations' || /^\/api\/conversations\/[^/]+$/.test(p)
        || p === '/api/orders' || /^\/api\/orders\/[^/]+$/.test(p)
        || p === '/api/products'
        || p === '/api/customers' || /^\/api\/customers\/[^/]+$/.test(p)
        || p === '/api/notifications'
        || p === '/api/agent/tools' || p === '/api/agent/runs' || /^\/api\/agent\/runs\/[^/]+$/.test(p)
        || p === '/api/shop-profile'
        || p === '/api/guide'; // HƯỚNG DẪN (đọc) — AGENT được xem nội dung hướng dẫn
    }
    if (method === 'POST') {
      return /^\/api\/conversations\/[^/]+\/(send|takeover|handback|close-claim)$/.test(p)
        || /^\/api\/orders\/[^/]+\/(cancel|confirm|retry-shipping)$/.test(p)
        || p === '/api/notifications/read'
        || p === '/api/guide/ask'; // Hỏi AI hướng dẫn — chỉ đọc dữ liệu guide, không đụng dữ liệu shop
    }
    return false;
  }

  // ============================================================ static UI
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.json': 'application/json; charset=utf-8' };

  function sendJson(res, code, body) {
    const raw = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(raw);
  }

  const PUBLIC_STATIC = new Set(['login.html', 'welcome.html', 'style.css', 'clear-cache.html']);

  function serveStatic(res, urlPath) {
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = path.normalize(path.join(UI_DIR, rel));
    if (!file.startsWith(UI_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  // GET / — FIRST-RUN EXPERIENCE: chưa có user -> WELCOME; chưa login -> LOGIN; đủ -> app.
  function serveEntry(res, user) {
    if (!auth.hasUsers()) return serveStatic(res, '/welcome.html');
    if (!user) return serveStatic(res, '/login.html');
    return serveStatic(res, '/index.html');
  }

  // ============================================================ HTTP server
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    try {
      // ---- PUBLIC: webhooks (platform gọi — không cookie) ----
      if (p === '/webhooks/meta' && req.method === 'GET') {
        // verify challenge cho TẤT CẢ app live (meta adapter dùng chung env) — dùng app của shop đầu
        const live = appForWebhook();
        if (!live || !live.live || !live.live.meta) return sendText(res, 503, 'meta live adapter not enabled (CHANNEL_MODE=live)');
        const q = Object.fromEntries(url.searchParams.entries());
        const challenge = live.live.meta.verifySubscribe(q);
        if (challenge === null) return sendText(res, 403, 'Forbidden');
        return sendText(res, 200, challenge);
      }
      if (p === '/webhooks/meta' && req.method === 'POST') {
        const { raw } = await readRawBody(req);
        const ctx = appForWebhook();
        if (!ctx || !ctx.live || !ctx.live.meta) return sendText(res, 503, 'meta live adapter not enabled');
        if (!ctx.live.meta.rawBodyValid(raw, req.headers['x-hub-signature-256'])) return sendText(res, 401, 'invalid signature');
        let bodyJson = null;
        try { bodyJson = JSON.parse(raw); } catch (e) { bodyJson = null; }
        if (!bodyJson) return sendText(res, 400, 'bad json');
        dispatchNormalized(ctx, ctx.live.meta.normalizeWebhook(bodyJson, { receivedAt: nowIsoOf(ctx) }));
        return sendText(res, 200, 'EVENTS_RECEIVED');
      }
      if (p === '/webhooks/zalo' && req.method === 'POST') {
        const { raw } = await readRawBody(req);
        const ctx = appForWebhook();
        if (!ctx || !ctx.live || !ctx.live.zalo) return sendText(res, 503, 'zalo live adapter not enabled (CHANNEL_MODE=live)');
        let bodyJson = null;
        try { bodyJson = JSON.parse(raw); } catch (e) { bodyJson = null; }
        if (!bodyJson) return sendText(res, 400, 'bad json');
        const sig = req.headers['x-zevent-signature'];
        if (!sig && process.env.ZALO_APP_SECRET) return sendText(res, 401, 'missing signature');
        if (sig && !ctx.live.zalo.verifyWebhookSignature(raw, sig, bodyJson.timestamp)) {
          return sendText(res, 401, 'invalid signature');
        }
        dispatchNormalized(ctx, ctx.live.zalo.normalizeWebhook(bodyJson, { receivedAt: nowIsoOf(ctx) }));
        return sendText(res, 200, 'OK');
      }
      if (p === '/webhooks/ghn' && req.method === 'POST') {
        const ctx = appForWebhook();
        if (!ctx || !ctx.live || !ctx.live.carrier) return sendText(res, 503, 'ghn live adapter not enabled (SHIPPING_MODE=ghn)');
        const ghnToken = process.env.GHN_WEBHOOK_TOKEN || '';
        if (!ghnToken) return sendText(res, 503, 'ghn webhook auth not configured (GHN_WEBHOOK_TOKEN)');
        const provided = String(req.headers['x-ghn-token'] || url.searchParams.get('token') || '');
        const okLen = provided.length === ghnToken.length;
        const tokenOk = okLen && require('crypto').timingSafeEqual(Buffer.from(provided), Buffer.from(ghnToken));
        if (!tokenOk) return sendText(res, 401, 'invalid webhook token');
        const { raw } = await readRawBody(req);
        let bodyJson = null;
        try { bodyJson = JSON.parse(raw); } catch (e) { bodyJson = null; }
        if (!bodyJson) return sendText(res, 400, 'bad json');
        const norm = ctx.live.carrier.normalizeWebhook(bodyJson, { receivedAt: nowIsoOf(ctx) });
        if (norm.ok) {
          ctx.live.carrier.applyWebhook(norm);
          const sh = ctx.store.findOne('shipments', s =>
            (norm.tracking_number && s.tracking_number === norm.tracking_number)
            || (norm.client_order_code && s.carrier_order_code === norm.client_order_code));
          if (sh) ctx.pipeline.onCarrierStatus(sh.order_id);
        }
        return sendText(res, 200, 'OK');
      }

      // ---- AUTH API (public) ----
      if (p === '/api/auth/setup' && req.method === 'POST') {
        const body = await readJsonBody(req);
        try {
          const r = auth.setupOwner(body);
          const login = auth.login({ email: body.email, password: body.password, ip: req.socket.remoteAddress });
          setSessionCookie(res, login.token);
          return sendJson(res, 200, { ok: true, user: r.user, shop: { shop_id: r.shop.shop_id, name: r.shop.name } });
        } catch (e) {
          if (e instanceof AuthError) return sendJson(res, e.http, { ok: false, error: e.code });
          throw e;
        }
      }
      if (p === '/api/auth/login' && req.method === 'POST') {
        const body = await readJsonBody(req);
        try {
          const r = auth.login({ email: body.email, password: body.password, ip: req.socket.remoteAddress });
          setSessionCookie(res, r.token);
          return sendJson(res, 200, { ok: true, user: r.user });
        } catch (e) {
          if (e instanceof AuthError) return sendJson(res, e.http, { ok: false, error: e.code });
          throw e;
        }
      }
      if (p === '/api/auth/logout' && req.method === 'POST') {
        const cookies = parseCookies(req);
        auth.logout(cookies.sid);
        clearSessionCookie(res);
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/auth/forgot' && req.method === 'POST') {
        const body = await readJsonBody(req);
        // reset token ghi FILE local (không email thật) — trả token để owner dùng ngay trong lab
        return sendJson(res, 200, auth.forgotPassword(body.email));
      }
      if (p === '/api/auth/reset' && req.method === 'POST') {
        const body = await readJsonBody(req);
        try {
          return sendJson(res, 200, auth.resetPassword(body));
        } catch (e) {
          if (e instanceof AuthError) return sendJson(res, e.http, { ok: false, error: e.code });
          throw e;
        }
      }

      // ---- SESSION SCOPING: mọi API còn lại theo user + shop của session ----
      const user = sessionUser(req);

      // ---- AUTH API (cần session) ----
      if (p === '/api/auth/me') {
        if (!user) return sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });
        return sendJson(res, 200, { ok: true, user, setup_done: auth.hasUsers() });
      }
      if (p === '/api/auth/change-password' && req.method === 'POST') {
        if (!user) return sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });
        const body = await readJsonBody(req);
        try { return sendJson(res, 200, auth.changePassword(user, body)); } catch (e) {
          if (e instanceof AuthError) return sendJson(res, e.http, { ok: false, error: e.code });
          throw e;
        }
      }
      if (p === '/api/auth/users' && req.method === 'GET') {
        if (!user) return sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });
        try { return sendJson(res, 200, { users: auth.listUsers(user) }); } catch (e) {
          if (e instanceof AuthError) return sendJson(res, e.http, { ok: false, error: e.code });
          throw e;
        }
      }
      if (p === '/api/auth/users' && req.method === 'POST') {
        if (!user) return sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });
        const body = await readJsonBody(req);
        try { return sendJson(res, 200, { ok: true, user: auth.createUser(user, body) }); } catch (e) {
          if (e instanceof AuthError) return sendJson(res, e.http, { ok: false, error: e.code });
          throw e;
        }
      }
      if (p === '/api/shops' && req.method === 'GET') {
        if (!user) return sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });
        if (!atLeast(user, 'ADMIN')) return sendJson(res, 403, { ok: false, error: 'FORBIDDEN' });
        return sendJson(res, 200, { shops: auth.listShops().map(s => ({ shop_id: s.shop_id, name: s.name, created_at: s.created_at })) });
      }
      if (p === '/api/shops' && req.method === 'POST') {
        if (!user) return sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });
        if (!atLeast(user, 'OWNER')) return sendJson(res, 403, { ok: false, error: 'FORBIDDEN' });
        const body = await readJsonBody(req);
        const shop = auth.createShop(String(body.name || 'Shop mới'));
        return sendJson(res, 200, { ok: true, shop: { shop_id: shop.shop_id, name: shop.name } });
      }

      // ---- SSE (cần session) ----
      if (p === '/api/events' && req.method === 'GET') {
        if (!user) return sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(`data: ${JSON.stringify({ type: 'hello', at: new Date().toISOString() })}\n\n`);
        sseClients.push(res);
        req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
        return;
      }

      // ---- static: entry có first-run; file public cho trang login/welcome ----
      if (req.method === 'GET' && (p === '/' || p === '/index.html' || p === '/login.html' || p === '/welcome.html')) {
        if (p === '/login.html' || p === '/welcome.html') return serveStatic(res, p);
        return serveEntry(res, user);
      }
      if (req.method === 'GET' && PUBLIC_STATIC.has(p.replace(/^\/+/, ''))) {
        return serveStatic(res, p);
      }

      // Từ đây: cần login. (HTML app.js/style của app trả sau session check để không rò UI data)
      if (!user) {
        if (req.method === 'GET' && !p.startsWith('/api/')) {
          res.writeHead(302, { Location: '/' });
          res.end();
          return;
        }
        return sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });
      }

      // Phân quyền ROLE: AGENT chỉ được danh sách cho phép
      if (user.role === 'AGENT' && !agentAllowed(req.method, p)) {
        return sendJson(res, 403, { ok: false, error: 'FORBIDDEN_ROLE' });
      }

      // App của SHOP trong session — mọi API dưới đây scope theo shop này
      const app = getApp(user.shop_id);
      if (!app) return sendJson(res, 500, { ok: false, error: 'SHOP_APP_MISSING' });

      // ---- API JSON ----
      if (p.startsWith('/api/')) {
        let m;
        if (p === '/api/dashboard' && req.method === 'GET') return sendJson(res, 200, dashboard(app));
        // BÁO CÁO & THỐNG KÊ real-time (chuẩn aicake) — ?days=N (mặc định 14)
        if (p === '/api/analytics' && req.method === 'GET') return sendJson(res, 200, buildAnalytics(app, { days: Number(url.searchParams.get('days')) || 14 }));
        // HƯỚNG DẪN + AI HỎI-ĐÁP (chuẩn aicake): cài 1 lần — nằm SAU auth guard + agentAllowed
        // (401 chưa login / 403 role đúng cơ chế). Trả true nếu đã xử lý route guide.
        if (await installGuideRoutes(app, { sendJson, readJsonBody, getSessionUser: () => user, req, res, p })) return;
        if (p === '/api/health' && req.method === 'GET') return sendJson(res, 200, healthOf(app, user.shop_id));
        if (p === '/api/onboarding' && req.method === 'GET') {
          return sendJson(res, 200, { ok: true, ...onboardingState(user.shop_id, app) });
        }
        if (p === '/api/onboarding/complete-step' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const r = apiCompleteStep(app, user.shop_id, body);
          return sendJson(res, r.http, r.body);
        }
        if (p === '/api/onboarding/test-conversation' && req.method === 'POST') {
          const r = apiOnboardingTestConversation(app);
          return sendJson(res, r.http, r.body);
        }
        if (p === '/api/onboarding/test-order' && req.method === 'POST') {
          const r = apiOnboardingTestOrder(app);
          return sendJson(res, r.http, r.body);
        }
        if (p === '/api/settings' && req.method === 'GET') return sendJson(res, 200, settingsView(app, user.shop_id));
        // AICAKE (G2/G5): ghi settings shop qua whitelist — chỉ công tắc comment-flow + thông tin
        // shop thường. KHÔNG nhận secret (token/key đi đường onboarding riêng); key lạ -> bỏ qua.
        if (p === '/api/settings' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const ALLOWED = ['auto_reply_comment', 'hide_negative_comment', 'auto_inbox_from_comment',
            'shop_name', 'shop_hotline', 'shop_address', 'auto_order', 'timezone'];
          const boolKeys = new Set(['auto_reply_comment', 'hide_negative_comment', 'auto_inbox_from_comment', 'auto_order']);
          const patch = {};
          for (const k of ALLOWED) {
            if (body[k] === undefined) continue;
            patch[k] = boolKeys.has(k) ? (body[k] === true || body[k] === 'true' || body[k] === 1 || body[k] === '1') : String(body[k]).slice(0, 300);
          }
          if (!Object.keys(patch).length) return sendJson(res, 400, { ok: false, error: 'NO_VALID_KEY' });
          settingsFor(user.shop_id).setMany(patch);
          return sendJson(res, 200, settingsView(app, user.shop_id));
        }
        if (p === '/api/automation' && req.method === 'GET') {
          return sendJson(res, 200, { ok: true, automation: automationView(app, user.shop_id) });
        }
        if (p === '/api/automation' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const r = apiSaveAutomation(app, user.shop_id, body);
          return sendJson(res, r.http, r.body);
        }
        if (p === '/api/notifications' && req.method === 'GET') {
          const items = notificationsFor(app, user.shop_id);
          return sendJson(res, 200, { ok: true, notifications: items, unread: items.filter(n => !n.read).length });
        }
        if (p === '/api/notifications/read' && req.method === 'POST') {
          const body = await readJsonBody(req);
          let ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
          if (body.all) ids = notificationsFor(app, user.shop_id).map(n => n.id);
          markNotifsRead(user.shop_id, ids);
          const items = notificationsFor(app, user.shop_id);
          return sendJson(res, 200, { ok: true, unread: items.filter(n => !n.read).length });
        }
        if (p === '/api/settings/bot' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const r = apiSetBot(app, !!body.on);
          return sendJson(res, r.http, r.body);
        }
        if (p === '/api/ai/config' && req.method === 'POST') {
          const body = await readJsonBody(req);
          // SURI P2 hạng mục 2: GẠI ĐỘNG LẬT/TẮT useForReplies KHÔNG cần provider trong body
          // (công tắc độc lập — tắt => sales-ai fallback stub, không đụng provider/key).
          const onlyToggle = body && body.provider === undefined && body.api_key === undefined
            && body.model === undefined && body.timeout === undefined && body.fallback === undefined
            && body.use_for_replies !== undefined;
          if (onlyToggle) {
            settingsFor(user.shop_id).set('ai_use_for_replies', !!body.use_for_replies);
            return sendJson(res, 200, { ok: true, ai: aiProvider.aiView(settingsFor(user.shop_id)) });
          }
          try {
            const view = aiProvider.saveAiConfig(settingsFor(user.shop_id), body);
            return sendJson(res, 200, { ok: true, ai: view });
          } catch (e) {
            // SURI P2 hạng mục 5(c): lỗi API chính kèm userMessage thân thiện (src/errors.js)
            const fe = friendlyError(e);
            return sendJson(res, 400, { ok: false, error: String(e.message), userMessage: fe.userMessage });
          }
        }
        if (p === '/api/ai/status' && req.method === 'GET') {
          const ss = settingsFor(user.shop_id);
          return sendJson(res, 200, { ok: true, ai: { ...aiProvider.aiView(ss), ...aiProvider.aiStatus(ss) } });
        }
        if (p === '/api/ai/test' && req.method === 'POST') {
          const r = await aiProvider.testAiProvider(settingsFor(user.shop_id), {});
          const st = aiProvider.aiStatus(settingsFor(user.shop_id));
          // KHÔNG trả key — status chỉ chứa mask + last_error (error không chứa key)
          return sendJson(res, r.ok ? 200 : 502, { ok: r.ok, error: r.error, ai: st });
        }
        // ---- SURI P1 (hạng mục 4): NỐI LIVE DEEPSEEK KEY TỪ FILE PROVIDER CONFIG ----
        // Đọc file ngoài (env DEEPSEEK_PROVIDER_CONFIG hoặc path mặc định của chủ) -> extract
        // apiKey/baseUrl/models -> ghi AI settings shop -> test THẬT 1 request /chat/completions.
        // KHÔNG echo key (chỉ maskedKey ***+4 cuối); KHÔNG nhận path từ body (chỉ env/mặc định).
        if (p === '/api/ai/wire-deepseek' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const ss = settingsFor(user.shop_id);
          let wired;
          try { wired = wireDeepseek(ss, { model: body && body.model }); } catch (e) {
            return sendJson(res, 400, {
              ok: false, status: 'ERROR', error: String(e && e.message), userMessage: 'Không đọc được DeepSeek provider config — kiểm tra file/đường dẫn (DEEPSEEK_PROVIDER_CONFIG).',
            });
          }
          const test = await aiProvider.testAiProvider(ss, {});
          const st = aiProvider.aiStatus(ss);
          const status = test.ok ? 'ONLINE' : 'ERROR';
          return sendJson(res, test.ok ? 200 : 502, {
            ok: test.ok, status, model: wired.model, maskedKey: wired.maskedKey,
            baseUrl: wired.baseUrl, models: wired.models, source_file: wired.path,
            error: test.error || null, ai: st,
          });
        }
        // ---- SURI P1 (hạng mục 2): TOOL REGISTRY — danh sách + schema + configured status ----
        if (p === '/api/agent/tools' && req.method === 'GET') {
          return sendJson(res, 200, { ok: true, tools: agentTools.listTools({ app }) });
        }
        // ---- SURI P1 (hạng mục 1): AGENT RUNS — xem lại vệt run cho UI ----
        if (p === '/api/agent/runs' && req.method === 'GET') {
          const limit = Number(url.searchParams.get('limit') || 50);
          return sendJson(res, 200, { ok: true, runs: app.agent.listRuns(Number.isFinite(limit) ? limit : 50) });
        }
        if ((m = p.match(/^\/api\/agent\/runs\/([^/]+)$/)) && req.method === 'GET') {
          const d = app.agent.getRun(m[1]);
          if (!d) return sendJson(res, 404, { ok: false, error: 'RUN_NOT_FOUND' });
          const tz = settingsFor(user.shop_id).get('timezone') || DEFAULT_TIMEZONE;
          return sendJson(res, 200, {
            ok: true, run: d.run, steps: d.steps,
            started_at_vn: fmtVnTime(d.run.started_at, tz), ended_at_vn: fmtVnTime(d.run.ended_at, tz), timezone: tz,
          });
        }
        // ---- SURI P1 (hạng mục 3): SHOP PROFILE (hồ sơ shop cho AI) ----
        if (p === '/api/shop-profile' && req.method === 'GET') {
          const ss = settingsFor(user.shop_id);
          return sendJson(res, 200, { ok: true, profile: shopProfile.getShopProfile(ss), fields: shopProfile.PROFILE_FIELDS });
        }
        if (p === '/api/shop-profile' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const v = shopProfile.validateShopProfile(body);
          if (!v.ok) return sendJson(res, 400, { ok: false, error: 'INVALID_PROFILE', details: v.errors, userMessage: 'Hồ sơ shop chứa dữ liệu không hợp lệ (có thể là pattern secret).' });
          const r = shopProfile.saveShopProfile(settingsFor(user.shop_id), body);
          app.store.audit({
            event_id: null, conversation_id: null, customer_ref: null,
            proposed_action: 'SHOP_PROFILE_SAVE',
            validation: { fields: Object.keys(v.profile) },
            execution_result: 'OK', receipt: null, stage: 'SETTINGS',
          });
          return sendJson(res, 200, { ok: true, profile: r.profile });
        }
        if (p === '/api/prompt' && req.method === 'GET') {
          const ss = settingsFor(user.shop_id);
          const legacy = ss.get('prompt_config') ? JSON.parse(ss.get('prompt_config')) : {};
          // SURI P1 (hạng mục 3): shop-profile có ĐỘ ƯU TIÊN CAO HƠN prompt config cũ —
          // mergePromptConfig: field profile không rỗng ĐÈ field trùng tên của legacy.
          const prof = shopProfile.getShopProfile(ss);
          const cfg = shopProfile.mergePromptConfig(legacy, prof);
          const profileFields = Object.keys(cfg).filter(k => JSON.stringify(cfg[k]) !== JSON.stringify(legacy[k]));
          return sendJson(res, 200, {
            ok: true, prompt: buildSystemPrompt(cfg),
            source: { profile_fields: profileFields, legacy_fields: Object.keys(legacy) },
          });
        }
        if (p === '/api/prompt/config' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const v = validatePromptConfig(body);
          if (!v.ok) return sendJson(res, 400, { ok: false, error: 'SECRET_IN_PROMPT', details: v.errors });
          settingsFor(user.shop_id).set('prompt_config', JSON.stringify(body));
          return sendJson(res, 200, { ok: true, prompt: buildSystemPrompt(body) });
        }
        if (p === '/api/conversations' && req.method === 'GET') return sendJson(res, 200, { conversations: listConversations(app) });
        if ((m = p.match(/^\/api\/conversations\/(.+)$/))) {
          const convId = m[1];
          if (req.method === 'GET') {
            const d = conversationDetail(app, convId);
            return d ? sendJson(res, 200, d) : sendJson(res, 404, { ok: false, error: 'CONVERSATION_NOT_FOUND' });
          }
          if (req.method === 'POST' && p.endsWith('/send')) {
            const body = await readJsonBody(req);
            const r = apiSendAsAgent(app, convId.replace(/\/send$/, ''), body.text, user.email);
            return sendJson(res, r.http, r.body);
          }
          if (req.method === 'POST' && p.endsWith('/takeover')) return sendJson(res, 200, apiTakeover(app, convId.replace(/\/takeover$/, ''), user.email).body);
          if (req.method === 'POST' && p.endsWith('/handback')) return sendJson(res, 200, apiHandback(app, convId.replace(/\/handback$/, ''), user.email).body);
          if (req.method === 'POST' && p.endsWith('/close-claim')) {
            const r = apiCloseClaim(app, convId.replace(/\/close-claim$/, ''), user.email);
            return sendJson(res, r.http, r.body);
          }
        }
        if (p === '/api/orders' && req.method === 'GET') return sendJson(res, 200, { orders: listOrders(app, url.searchParams.get('status') || 'ALL') });
        if ((m = p.match(/^\/api\/orders\/([^/]+)$/)) && req.method === 'GET') {
          const d = orderDetail(app, m[1]);
          return d ? sendJson(res, 200, d) : sendJson(res, 404, { ok: false, error: 'ORDER_NOT_FOUND' });
        }
        if ((m = p.match(/^\/api\/orders\/([^/]+)\/confirm$/)) && req.method === 'POST') {
          const r = apiConfirmOrder(app, m[1], user.email);
          return sendJson(res, r.http, r.body);
        }
        if ((m = p.match(/^\/api\/orders\/([^/]+)\/retry-shipping$/)) && req.method === 'POST') {
          const r = apiRetryShipping(app, m[1], user.email);
          return sendJson(res, r.http, r.body);
        }
        if ((m = p.match(/^\/api\/orders\/([^/]+)\/cancel$/)) && req.method === 'POST') {
          const r = apiCancelOrder(app, m[1], user.email);
          return sendJson(res, r.http, r.body);
        }
        if (p === '/api/products' && req.method === 'GET') {
          return sendJson(res, 200, { products: listProducts(app, user.shop_id, url.searchParams.get('q')) });
        }
        if (p === '/api/products' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const r = apiAddProduct(app, user.shop_id, body);
          return sendJson(res, r.http, r.body);
        }
        if (p === '/api/products/import' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const r = apiImportProducts(app, user.shop_id, body.csv);
          return sendJson(res, r.http, r.body);
        }
        if ((m = p.match(/^\/api\/products\/([^/]+)$/)) && req.method === 'PUT') {
          const body = await readJsonBody(req);
          const r = apiUpdateProduct(app, user.shop_id, m[1], body);
          return sendJson(res, r.http, r.body);
        }
        if ((m = p.match(/^\/api\/products\/([^/]+)$/)) && req.method === 'DELETE') {
          const r = apiDeleteProduct(app, user.shop_id, m[1]);
          return sendJson(res, r.http, r.body);
        }
        if (p === '/api/customers' && req.method === 'GET') return sendJson(res, 200, { customers: listCustomers(app) });
        if ((m = p.match(/^\/api\/customers\/([^/]+)$/)) && req.method === 'GET') {
          const d = customerDetail(app, m[1]);
          return d ? sendJson(res, 200, d) : sendJson(res, 404, { ok: false, error: 'CUSTOMER_NOT_FOUND' });
        }
        // [Supervisor-approved] endpoint nghiệm thu: bắn tin khách đi ĐÚNG đường webhook (app.receive)
        if (p === '/api/debug/customer-message' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const r = seedEvent(app, body.channel || 'facebook', body.ref || 'fb-debug', body.text || '', body.extra || {});
          app.drain();
          return sendJson(res, 200, { ok: true, event: r || null });
        }
        return sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
      }

      // ---- static còn lại (app.js) — đã qua session check ----
      if (req.method === 'GET') return serveStatic(res, url.pathname);
      res.writeHead(405); res.end('Method not allowed');
    } catch (err) {
      // SURI P1 (hạng mục 5): ERROR UX — body trả userMessage tiếng Việt thân thiện;
      // CHI TIẾT KỸ THUẬT (technical) CHỈ VÀO LOG server, không rò ra response.
      const fe = friendlyError(err);
      console.error('[http]', req.method, p, err, '| userMessage:', fe.userMessage);
      try { sendJson(res, 500, { ok: false, userMessage: fe.userMessage, error: fe.code }); } catch (e) { /* đã gửi */ }
    }
  });

  // Webhook PUBLIC không có session: chọn context app — shop đầu tiên có adapter live.
  function appForWebhook() {
    for (const shopId of Object.keys(auth.shops)) {
      const app = getApp(shopId);
      if (app && app.live) return app;
    }
    const first = auth.firstShopId();
    return first ? getApp(first) : null;
  }

  const tickTimer = setInterval(tick, 2000);
  tick();
  lastFingerprint = fingerprint();

  function listen(cb) {
    return server.listen(PORT, typeof cb === 'function' ? cb : undefined);
  }

  function close() {
    clearInterval(tickTimer);
    for (const r of sseClients) { try { r.end(); } catch (e) { /* ignore */ } }
    sseClients = [];
    return new Promise(resolve => server.close(resolve));
  }

  return { server, listen, close, auth, getApp, settingsFor, port: PORT, persist: PERSIST, demo: DEMO };
}

module.exports = { createServer };

// ============================================================ BOOT (node server.js)
if (require.main === module) {
  const inst = createServer({});
  const PORT = inst.port;
  inst.listen(() => {
    const url = `http://localhost:${PORT}`;
    console.log(`UI bán hàng: ${url}`);
    console.log(`[ui] data=shops/* APP_DATA=${inst.persist ? 'persist' : 'reset'} | demo=${inst.demo ? 'ON (UI_DEMO=0 để tắt)' : 'OFF'} | auth=data/auth`);
    console.log(`[live] CHANNEL_MODE=${process.env.CHANNEL_MODE || 'mock'} | SHIPPING_MODE=${process.env.SHIPPING_MODE || 'mock'} | webhooks: /webhooks/meta /webhooks/zalo /webhooks/ghn`);
    if (!inst.auth.hasUsers()) console.log('[auth] CHƯA có tài khoản — mở trình duyệt để tạo tài khoản OWNER đầu tiên.');
    // Windows: mở browser tự động (NO_BROWSER_OPEN=1 để tắt — dùng cho smoke/boot test)
    if (process.platform === 'win32' && process.env.NO_BROWSER_OPEN !== '1') {
      try {
        const { spawn } = require('child_process');
        spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } catch (e) { /* không mở được thì bỏ qua */ }
    }
  });
}
