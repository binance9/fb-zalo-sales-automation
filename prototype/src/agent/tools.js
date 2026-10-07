'use strict';
// tools.js — TOOL REGISTRY CỦA SURI SALES AGENT (SURI PHASE 1, hạng mục 2).
//
// Nguyên tắc BẮT BUỘC: handler CHỈ ỦY QUYỀN về core sẵn có (order-engine, action-gate,
// product-db, shipping adapter, takeover, sessions) — KHÔNG viết lại logic nào. Tool chưa
// cấu hình backend (vd GHN thiếu token) trả {status:'NOT_CONFIGURED', reason} — KHÔNG giả PASS.
//
// runTool(name, input, ctx):
//   1. validate input THEO inputSchema (type/required) -> TOOL_INVALID_INPUT;
//   2. sideEffect + idempotencyKey -> dedupe theo audit (idem_key scope theo run/adhoc);
//   3. timeout wrapper: handler sync đo elapsed, handler async race với timer -> TOOL_TIMEOUT;
//   4. gọi handler (ủy quyền core);
//   5. ghi audit (TOOL:<name>) + ToolCall/ToolResult vào AgentRun đang mở (ctx.recordToolCall).
//
// ctx: { app, operator?, run?, recordToolCall?(call) }. Tools KHÔNG import orchestrator
// (tránh vòng phụ thuộc) — run mở được bắn qua ctx bởi server/orchestrator.

const { uid, sha } = require('../util');
const { MOCK_SHIPPING_FEE, MOCK_PROMOTIONS } = require('../shipping');
const { friendlyError } = require('../errors');

const FB_WINDOW_HOURS = 24; // BL-1 (P3C) — cửa sổ Messenger
const ZALO_CS_KINDS = ['ai_reply', 'care']; // loại tin tốn quota CS (BL-2)

// ---------------------------------------------------------------- lỗi tool
function toolError(code, message, extra) {
  const e = new Error(message || code);
  e.code = code;
  e.toolError = true;
  const f = friendlyError(e);
  e.userMessage = f.userMessage;
  if (extra) Object.assign(e, extra);
  return e;
}

// ---------------------------------------------------------------- schema validate
// inputSchema: { type:'object', fields: { name: { type, required?, description? } } }
// type: string|number|boolean|array|object. Field lạ -> lỗi (schema.additionalFields==='allow'
// để nới). Trả {ok, errors[], value} — value CHỈ gồm field khai báo (đã ép kiểu nhẹ).
function validateAgainstSchema(schema, input) {
  const errors = [];
  const value = {};
  const inp = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const fields = (schema && schema.fields) || {};
  for (const [name, def] of Object.entries(fields)) {
    const v = inp[name];
    if (v === undefined || v === null || v === '') {
      if (def.required) errors.push(`${name}: bắt buộc`);
      continue;
    }
    const t = def.type || 'string';
    const matches =
      (t === 'string' && typeof v === 'string') ||
      (t === 'number' && typeof v === 'number' && Number.isFinite(v)) ||
      (t === 'boolean' && typeof v === 'boolean') ||
      (t === 'array' && Array.isArray(v)) ||
      (t === 'object' && typeof v === 'object' && !Array.isArray(v));
    if (!matches) { errors.push(`${name}: sai kiểu (cần ${t})`); continue; }
    if (t === 'string' && def.maxLength && v.length > def.maxLength) { errors.push(`${name}: quá dài`); continue; }
    value[name] = v;
  }
  if (!schema || schema.additionalFields !== 'allow') {
    for (const k of Object.keys(inp)) {
      if (!fields[k]) errors.push(`${k}: field không được phép`);
    }
  }
  return { ok: errors.length === 0, errors, value };
}

// ---------------------------------------------------------------- helpers đọc dữ liệu
function loadConversation(app, conversationId) {
  const conv = app.store.findOne('conversations', c => c.conversation_id === conversationId);
  if (!conv) throw toolError('CONVERSATION_NOT_FOUND', `conversation ${conversationId} không tồn tại`);
  const customer = app.store.findOne('customers', c => c.customer_id === conv.customer_id);
  if (!customer) throw toolError('CUSTOMER_NOT_FOUND', `customer của ${conversationId} không tồn tại`);
  return { conv, customer };
}

function loadOrder(app, { order_id, order_code }) {
  let order = null;
  if (order_id) order = app.store.findOne('orders', o => o.order_id === order_id);
  else if (order_code) order = app.store.findOne('orders', o => o.order_code === order_code);
  if (!order) throw toolError('ORDER_NOT_FOUND', 'order không tồn tại');
  return order;
}

function orderView(app, o) {
  const sh = app.store.findOne('shipments', s => s.order_id === o.order_id);
  let lines = [];
  try { lines = JSON.parse(o.price_snapshot_json || '[]'); } catch (e) { lines = []; }
  return {
    order_id: o.order_id, order_code: o.order_code, conversation_id: o.conversation_id,
    status: o.status, subtotal: o.subtotal, shipping_fee: o.shipping_fee, total: o.total,
    items: lines, draft_expires_at: o.draft_expires_at || null,
    cancel_reason: o.cancel_reason || null, created_at: o.created_at,
    shipment: sh ? { shipment_id: sh.shipment_id, tracking_number: sh.tracking_number, status: sh.status } : null,
  };
}

function productView(app, p) {
  return {
    product_id: p.product_id, sku_base: p.sku_base, name: p.name, category: p.category || null,
    aliases: p.aliases || [], enabled: p.enabled !== false,
    variants: p.variants.map(v => ({
      sku: v.sku, size: v.size, color: v.color || null, price: v.price,
      stock_qty: v.stock_qty, stock_reserved: v.stock_reserved || 0,
      effective: app.productDB.effectiveStock(v.sku),
    })),
  };
}

function customerView(app, c) {
  const orders = app.store.findAll('orders', o => o.customer_id === c.customer_id);
  return {
    customer_id: c.customer_id, channel: c.channel, platform_ref: c.platform_ref,
    display_name: c.display_name || null, full_name: c.full_name || null, phone: c.phone || null,
    marketing_opt_out: c.marketing_opt_out === 1, opt_out_at: c.opt_out_at || null,
    orders_count: orders.length, notes: Array.isArray(c.notes) ? c.notes : [],
    created_at: c.created_at,
  };
}

// Carrier "đã cấu hình": adapter live (GhnAdapter) tự khai isConfigured(); MockCarrier coi như
// cấu hình trong môi trường mock. GHN thiếu token/shopId -> false -> tool trả NOT_CONFIGURED.
function carrierConfigured(app) {
  const c = app && app.carrier;
  if (!c) return false;
  if (typeof c.isConfigured === 'function') return !!c.isConfigured();
  return true; // MockCarrier
}

// ---------------------------------------------------------------- TOOL DEFINITIONS
// Mỗi tool: {name, description, inputSchema, outputSchema, sideEffect, idempotencyKey?, timeoutMs, handler}
const DEFS = [
  // ================= NHÓM ĐỌC =================
  {
    name: 'read_customer',
    description: 'Đọc hồ sơ khách theo customer_id hoặc conversation_id (tên, SĐT, opt-out, notes, số đơn).',
    inputSchema: { type: 'object', fields: {
      customer_id: { type: 'string', description: 'ID khách' },
      conversation_id: { type: 'string', description: 'lấy customer từ hội thoại' },
    } },
    outputSchema: { type: 'object', description: 'customer view' },
    sideEffect: false,
    timeoutMs: 5000,
    handler(input, ctx) {
      const app = ctx.app;
      let customer = null;
      if (input.customer_id) customer = app.store.findOne('customers', c => c.customer_id === input.customer_id);
      else if (input.conversation_id) customer = loadConversation(app, input.conversation_id).customer;
      else throw toolError('INVALID_INPUT', 'cần customer_id hoặc conversation_id');
      if (!customer) throw toolError('CUSTOMER_NOT_FOUND', 'khách không tồn tại');
      return customerView(app, customer);
    },
  },
  {
    name: 'read_conversation',
    description: 'Đọc hội thoại: state, mode, giỏ hàng draft, slot thiếu, tin nhắn gần nhất, cửa sổ 24h.',
    inputSchema: { type: 'object', fields: {
      conversation_id: { type: 'string', required: true, description: 'ID hội thoại (channel:thread)' },
      limit_messages: { type: 'number', description: 'số tin gần nhất (mặc định 10)' },
    } },
    outputSchema: { type: 'object', description: 'conversation summary + messages' },
    sideEffect: false,
    timeoutMs: 5000,
    handler(input, ctx) {
      const app = ctx.app;
      const { conv, customer } = loadConversation(app, input.conversation_id);
      const limit = Math.min(50, Math.max(1, input.limit_messages || 10));
      const msgs = app.store.findAll('messages', m => m.conversation_id === conv.conversation_id)
        .slice(-limit)
        .map(m => ({ id: m.message_id, direction: m.direction, sender: m.sender, text: m.text_content, kind: m.kind, at: m.created_at, delivery_status: m.delivery_status || null }));
      const draft = conv.draft || { items: [], slots: {} };
      const s = draft.slots || {};
      return {
        conversation_id: conv.conversation_id, channel: conv.channel, state: conv.state, mode: conv.mode,
        subject_sku: conv.subject_sku || null, customer: customerView(app, customer),
        draft: {
          items: (draft.items || []).filter(i => i.state !== 'stale'),
          order_id: draft.order_id || null,
          slots: { name: (s.name && s.name.value) || null, phone: (s.phone && s.phone.value) || null, address: (s.address && s.address.value) || null },
          missing: app.sessions.missingRequiredSlots(conv),
        },
        window: app.gate.windowState(conv),
        messages: msgs,
      };
    },
  },
  {
    name: 'read_product',
    description: 'Đọc 1 sản phẩm theo sku_base hoặc product_id (kèm variants + tồn hiệu dụng).',
    inputSchema: { type: 'object', fields: {
      sku_base: { type: 'string', description: 'mã gốc SP' },
      product_id: { type: 'string', description: 'ID SP' },
    } },
    outputSchema: { type: 'object', description: 'product view + variants' },
    sideEffect: false,
    timeoutMs: 5000,
    handler(input, ctx) {
      const app = ctx.app;
      const p = input.sku_base ? app.productDB.getProductByBase(input.sku_base)
        : input.product_id ? app.productDB.getProduct(input.product_id) : null;
      if (!p) throw toolError('PRODUCT_NOT_FOUND', 'sản phẩm không tồn tại');
      return productView(app, p);
    },
  },
  {
    name: 'search_products',
    description: 'Tìm sản phẩm theo từ khoá khách gõ (4 lớp: sku -> alias -> substring -> fuzzy).',
    inputSchema: { type: 'object', fields: {
      query: { type: 'string', required: true, description: 'từ khoá' },
      limit: { type: 'number', description: 'số kết quả tối đa (mặc định 5)' },
    } },
    outputSchema: { type: 'object', description: 'danh sách match' },
    sideEffect: false,
    timeoutMs: 5000,
    handler(input, ctx) {
      const app = ctx.app;
      const { matches } = app.productDB.searchProduct(input.query);
      const limit = Math.min(20, Math.max(1, input.limit || 5));
      return {
        query: input.query,
        matches: matches.slice(0, limit).map(m => ({
          sku_base: m.product.sku_base, name: m.product.name, layer: m.layer, score: m.score,
          variant_sku: (m.variant && m.variant.sku) || (m.product.variants[0] && m.product.variants[0].sku) || null,
          price: (m.variant && m.variant.price) || (m.product.variants[0] && m.product.variants[0].price) || null,
          effective: m.product.variants.reduce((t, v) => t + app.productDB.effectiveStock(v.sku), 0),
        })),
      };
    },
  },
  {
    name: 'read_stock',
    description: 'Đọc tồn kho hiệu dụng (stock_qty - reserved) + giá hiện hành của 1 SKU.',
    inputSchema: { type: 'object', fields: { sku: { type: 'string', required: true } } },
    outputSchema: { type: 'object', description: '{sku, stock_qty, stock_reserved, effective, price}' },
    sideEffect: false,
    timeoutMs: 5000,
    handler(input, ctx) {
      const s = ctx.app.productDB.getStock(input.sku);
      if (!s) throw toolError('SKU_NOT_FOUND', `sku ${input.sku} không tồn tại`);
      return s;
    },
  },
  {
    name: 'read_price',
    description: 'Đọc giá hiện hành của 1 SKU từ ProductDB (nguồn sự thật — AI không được bịa).',
    inputSchema: { type: 'object', fields: { sku: { type: 'string', required: true } } },
    outputSchema: { type: 'object', description: '{sku, price, currency}' },
    sideEffect: false,
    timeoutMs: 5000,
    handler(input, ctx) {
      const s = ctx.app.productDB.getStock(input.sku);
      if (!s) throw toolError('SKU_NOT_FOUND', `sku ${input.sku} không tồn tại`);
      return { sku: s.sku, price: s.price, currency: 'VND' };
    },
  },
  {
    name: 'read_shipping_policy',
    description: 'Đọc chính sách ship hiện hành: phí mock/evidence, ngưỡng freeship, carrier mode + cấu hình.',
    inputSchema: { type: 'object', fields: {} },
    outputSchema: { type: 'object', description: '{shipping_fee, freeship_threshold_vnd, carrier_mode, configured}' },
    sideEffect: false,
    timeoutMs: 5000,
    handler(input, ctx) {
      const app = ctx.app;
      const c = app.carrier;
      return {
        shipping_fee: MOCK_SHIPPING_FEE,
        freeship_threshold_vnd: MOCK_PROMOTIONS.freeshipThresholdVnd,
        currency: 'VND',
        carrier_mode: (c && c.mode) || 'mock',
        carrier_environment: typeof (c && c.environment) === 'function' ? c.environment() : 'mock',
        configured: carrierConfigured(app),
        note: 'Phí/ngưỡng là EVIDENCE dùng chung với order-engine + money-guard (BL-6).',
      };
    },
  },
  {
    name: 'quote_shipping',
    description: 'Báo phí vận chuyển: live carrier (GHN preview) nếu đã cấu hình; mock trả phí evidence.',
    inputSchema: { type: 'object', fields: {
      sku: { type: 'string', description: 'SKU để ước lượng cân nặng' },
      qty: { type: 'number', description: 'số lượng (mặc định 1)' },
    } },
    outputSchema: { type: 'object', description: '{status, source, fee}' },
    sideEffect: false,
    timeoutMs: 25000,
    handler(input, ctx) {
      const app = ctx.app;
      const c = app.carrier;
      if (c && typeof c.previewFee === 'function') {
        if (!carrierConfigured(app)) return { status: 'NOT_CONFIGURED', reason: 'GHN token/shopId chưa cấu hình (isConfigured=false)' };
        const r = c.previewFee({ body: { weight: Math.max(1, (input.qty || 1) * 250) } });
        if (r && r.ok) return { status: 'OK', source: 'ghn', fee: r.fee, currency: 'VND' };
        if (r && r.timeout) throw toolError('CARRIER_TIMEOUT', 'GHN preview fee timeout — kết quả chưa biết');
        throw toolError('CARRIER_REJECTED', 'GHN từ chối báo phí: ' + String((r && r.error) || 'unknown'));
      }
      // MockCarrier — phí evidence dùng chung với order-engine (không phải PASS giả: ghi rõ nguồn mock)
      return { status: 'OK', source: 'mock', fee: MOCK_SHIPPING_FEE, currency: 'VND', freeship_threshold_vnd: MOCK_PROMOTIONS.freeshipThresholdVnd };
    },
  },
  {
    name: 'read_order',
    description: 'Đọc đơn theo order_id/order_code (status, dòng hàng, vận đơn, lý do huỷ).',
    inputSchema: { type: 'object', fields: {
      order_id: { type: 'string' }, order_code: { type: 'string' },
    } },
    outputSchema: { type: 'object', description: 'order view' },
    sideEffect: false,
    timeoutMs: 5000,
    handler(input, ctx) {
      if (!input.order_id && !input.order_code) throw toolError('INVALID_INPUT', 'cần order_id hoặc order_code');
      return orderView(ctx.app, loadOrder(ctx.app, input));
    },
  },

  // ================= NHÓM ĐƠN HÀNG (sideEffect — ủy quyền order-engine + gate) =================
  {
    name: 'create_order_draft',
    description: 'Tạo đơn DRAFT giữ chỗ cho hội thoại (đúng pha A qua Action Gate: validate tồn/giá + reserve).',
    inputSchema: { type: 'object', fields: {
      conversation_id: { type: 'string', required: true },
      items: { type: 'array', required: true, description: '[{sku, qty}]' },
      name: { type: 'string', description: 'slot tên (nếu biết)' },
      phone: { type: 'string', description: 'slot SĐT (nếu biết)' },
      address: { type: 'string', description: 'slot địa chỉ (nếu biết)' },
    } },
    outputSchema: { type: 'object', description: 'order DRAFT view + missing' },
    sideEffect: true,
    idempotencyKey: input => `order_draft:${input.conversation_id}:${sha(JSON.stringify((input.items || []).map(i => `${(i && i.sku) || ''}x${(i && i.qty) || 1}`).sort()), 16)}`,
    timeoutMs: 10000,
    handler(input, ctx) {
      const app = ctx.app;
      const { conv, customer } = loadConversation(app, input.conversation_id);
      const items = (input.items || []).map(i => ({ sku: String(i.sku), qty: Math.max(1, Math.round(Number(i.qty) || 1)) }));
      if (!items.length) throw toolError('INVALID_INPUT', 'items rỗng');
      for (const it of items) if (!app.productDB.getStock(it.sku)) throw toolError('SKU_NOT_FOUND', `sku ${it.sku} không tồn tại`);
      // mirror P3B-1 re-entry (cùng semantics pipeline.routeBuyItems — không viết lại engine)
      if (['ORDERED', 'AFTER_SALES'].includes(conv.state) && conv.draft) {
        conv.buy_gen = (conv.buy_gen || 0) + 1;
        conv.draft.order_id = null;
        conv.draft.items = [];
      }
      app.sessions.setItems(conv, items);
      conv.subject_sku = items[0].sku;
      if (input.name) app.sessions.setSlot(conv, 'name', input.name, 'confirmed');
      if (input.phone) app.sessions.setSlot(conv, 'phone', input.phone, 'confirmed');
      if (input.address) app.sessions.setSlot(conv, 'address', input.address, 'confirmed');
      for (const st of ['BUY_INTENT', 'COLLECT_ORDER']) {
        if (['NEW_LEAD', 'DISCOVERY', 'PRODUCT_QA', 'BUY_INTENT'].includes(conv.state)) {
          app.sessions.transition(conv, st, st === 'BUY_INTENT' ? 'tool_buy_signal' : 'tool_draft_started');
        }
      }
      // AUTHORIZE + EXECUTE qua gate.createOrder (validate -> authorize -> phaseA -> verify)
      const r = app.gate.createOrder({ conversation: conv, customer, event: null });
      if (!r.ok) throw toolError(r.reason || 'CREATE_ORDER_FAILED', 'gate từ chối tạo draft', { missing: r.missing || null, sku: r.sku || null });
      conv.draft.order_id = r.order.order_id;
      for (const it of conv.draft.items) if (it.state === 'detected') it.state = 'confirmed';
      app.sessions.transition(conv, 'VALIDATE', 'tool_slots_complete');
      app.sessions.transition(conv, 'CONFIRM', 'tool_draft_reserved');
      return { order: orderView(app, r.order), idempotent: !!r.idempotent, missing: app.sessions.missingRequiredSlots(conv) };
    },
  },
  {
    name: 'update_order_draft',
    description: 'Sửa giỏ/slot của draft: huỷ DRAFT cũ (hoàn reserve) rồi áp items/slots mới — slot độc lập giữ.',
    inputSchema: { type: 'object', fields: {
      conversation_id: { type: 'string', required: true },
      items: { type: 'array', description: '[{sku, qty}] mới (không gửi = giữ)' },
      name: { type: 'string' }, phone: { type: 'string' }, address: { type: 'string' },
    } },
    outputSchema: { type: 'object', description: '{draft:{items, missing, order_id}}' },
    sideEffect: true,
    idempotencyKey: input => `order_draft_update:${input.conversation_id}:${sha(JSON.stringify([input.items || null, input.name || null, input.phone || null, input.address || null]).slice(0, 16))}`,
    timeoutMs: 10000,
    handler(input, ctx) {
      const app = ctx.app;
      const { conv } = loadConversation(app, input.conversation_id);
      if (!conv.draft) throw toolError('NO_DRAFT', 'hội thoại chưa có draft');
      // draft đang giữ chỗ -> huỷ ĐÚNG engine (hoàn reserve) trước khi sửa
      if (conv.draft.order_id) {
        const order = app.store.findOne('orders', o => o.order_id === conv.draft.order_id);
        if (order && order.status === 'DRAFT') {
          app.orders.cancelDraft(order.order_id, 'tool_update_draft', null);
          if (conv.state === 'CONFIRM') app.sessions.transition(conv, 'COLLECT_ORDER', 'tool_update_draft');
        }
        conv.draft.order_id = null;
      }
      if (Array.isArray(input.items) && input.items.length) {
        const items = input.items.map(i => ({ sku: String(i.sku), qty: Math.max(1, Math.round(Number(i.qty) || 1)) }));
        for (const it of items) if (!app.productDB.getStock(it.sku)) throw toolError('SKU_NOT_FOUND', `sku ${it.sku} không tồn tại`);
        app.sessions.setItems(conv, items);
        conv.subject_sku = items[0].sku;
      }
      if (input.name) app.sessions.setSlot(conv, 'name', input.name, 'confirmed');
      if (input.phone) app.sessions.setSlot(conv, 'phone', input.phone, 'confirmed');
      if (input.address) app.sessions.setSlot(conv, 'address', input.address, 'confirmed');
      return {
        draft: {
          items: (conv.draft.items || []).filter(i => i.state !== 'stale'),
          order_id: conv.draft.order_id || null,
          missing: app.sessions.missingRequiredSlots(conv),
        },
      };
    },
  },
  {
    name: 'confirm_order',
    description: 'Chốt đơn DRAFT (pha B qua gate: re-validate tồn/giá MỚI NHẤT -> commit -> tạo vận đơn).',
    inputSchema: { type: 'object', fields: {
      order_id: { type: 'string', required: true, description: 'đơn DRAFT cần chốt' },
    } },
    outputSchema: { type: 'object', description: '{order, shipment?, shipment_timeout?}' },
    sideEffect: true,
    idempotencyKey: input => `order_confirm:${input.order_id}`,
    timeoutMs: 30000,
    handler(input, ctx) {
      const app = ctx.app;
      const order = loadOrder(app, input);
      const { conv, customer } = loadConversation(app, order.conversation_id);
      // AUTHORIZE + pha B qua gate.confirmOrder (đúng pipeline.routeConfirm)
      const r = app.gate.confirmOrder({ conversation: conv, customer, event: null });
      if (!r.ok) throw toolError(r.reason || 'CONFIRM_FAILED', 'chốt đơn thất bại', { sku: r.sku || null, db_price: r.db_price || null });
      const fresh = app.store.findOne('orders', o => o.order_id === order.order_id);
      if (conv.state === 'CONFIRM') app.sessions.transition(conv, 'ORDERED', 'tool_confirm');
      // CONFIRMED -> tạo vận đơn đúng flow core (carrier treo -> TIMEOUT_UNKNOWN + reconcile job)
      const ship = app.orders.createShipment({ order: fresh, carrier: app.carrier });
      const out = { order: orderView(app, app.store.findOne('orders', o => o.order_id === order.order_id)) };
      if (ship.ok) out.shipment = { tracking_number: ship.shipment.tracking_number, status: ship.shipment.status };
      else if (ship.timeout) out.shipment_timeout = true;
      else out.shipment_deferred = true;
      return out;
    },
  },
  {
    name: 'cancel_order',
    description: 'Huỷ đơn theo yêu cầu (đi requestCancelOrder: draft hoàn reserve; đã ship -> qua carrier, từ chối -> CANCEL_PENDING).',
    inputSchema: { type: 'object', fields: {
      order_id: { type: 'string', required: true },
      reason: { type: 'string', description: 'lý do huỷ (mặc định tool_request)' },
    } },
    outputSchema: { type: 'object', description: '{order, viaCarrier, pending}' },
    sideEffect: true,
    idempotencyKey: input => `order_cancel:${input.order_id}`,
    timeoutMs: 30000,
    handler(input, ctx) {
      const app = ctx.app;
      const order = loadOrder(app, input);
      const r = app.orders.requestCancelOrder({
        orderId: order.order_id,
        actor: ctx.operator || 'agent_tool',
        reason: input.reason || 'tool_request',
        eventId: null,
        carrier: app.carrier,
      });
      // đồng bộ state hội thoại như apiCancelOrder (đi sessions.transition, không đụng core)
      const conv = app.store.findOne('conversations', c => c.conversation_id === order.conversation_id);
      if (conv && r.ok) {
        try {
          if (order.status === 'DRAFT' && conv.state === 'CONFIRM') app.sessions.transition(conv, 'COLLECT_ORDER', 'tool_order_cancelled');
          else if (['ORDERED', 'CONFIRM'].includes(conv.state)) app.sessions.transition(conv, 'AFTER_SALES', 'tool_order_cancelled');
        } catch (e) { /* transition từ chối -> giữ state */ }
      }
      const fresh = app.store.findOne('orders', o => o.order_id === order.order_id);
      return {
        ok: !!r.ok, viaCarrier: !!r.viaCarrier, pending: !!r.pending,
        idempotent: !!r.idempotent, reason: r.reason || r.carrierReason || null,
        order: fresh ? orderView(app, fresh) : null,
      };
    },
  },

  // ================= NHÓM VẬN ĐƠN =================
  {
    name: 'create_shipment',
    description: 'Tạo vận đơn cho đơn CONFIRMED qua carrier (idempotency key shipment:<order_id> của engine).',
    inputSchema: { type: 'object', fields: { order_id: { type: 'string', required: true } } },
    outputSchema: { type: 'object', description: '{shipment} | timeout' },
    sideEffect: true,
    idempotencyKey: input => `shipment_create:${input.order_id}`,
    timeoutMs: 30000,
    handler(input, ctx) {
      const app = ctx.app;
      if (!carrierConfigured(app)) return { status: 'NOT_CONFIGURED', reason: 'GHN token/shopId chưa cấu hình — không tạo vận đơn ảo' };
      const order = loadOrder(app, input);
      if (order.status !== 'CONFIRMED') throw toolError('BAD_STATUS', `đơn ${order.status} — chỉ đơn CONFIRMED tạo vận đơn được`);
      const r = app.orders.createShipment({ order, carrier: app.carrier });
      if (r.ok) return { shipment: { tracking_number: r.shipment.tracking_number, status: r.shipment.status, carrier: r.shipment.carrier } };
      if (r.timeout) return { shipment_timeout: true, reason: 'TIMEOUT_UNKNOWN — đã lên job reconcile, cấm retry mù' };
      return { blocked: !!r.blocked, reason: r.reason || 'unknown' };
    },
  },
  {
    name: 'get_shipment_status',
    description: 'Đọc trạng thái vận đơn: row trong store + trạng thái carrier (VERIFY từ nguồn ngoài).',
    inputSchema: { type: 'object', fields: {
      order_id: { type: 'string' }, tracking_number: { type: 'string' },
    } },
    outputSchema: { type: 'object', description: '{shipment, carrier_status}' },
    sideEffect: false,
    timeoutMs: 25000,
    handler(input, ctx) {
      const app = ctx.app;
      let sh = null;
      if (input.tracking_number) sh = app.store.findOne('shipments', s => s.tracking_number === input.tracking_number);
      else if (input.order_id) sh = app.store.findOne('shipments', s => s.order_id === input.order_id);
      if (!sh) throw toolError('SHIPMENT_NOT_FOUND', 'vận đơn không tồn tại');
      const live = app.carrier ? app.carrier.getStatus(sh.tracking_number) : { status: 'UNKNOWN' };
      return {
        shipment: { shipment_id: sh.shipment_id, order_id: sh.order_id, tracking_number: sh.tracking_number, status: sh.status, carrier: sh.carrier },
        carrier_status: live.status, carrier_status_at: live.at || null,
      };
    },
  },
  {
    name: 'cancel_shipment',
    description: 'Huỷ vận đơn qua carrier (engine cancelShipmentViaCarrier: receipt CANCELLED mới restock; từ chối -> CANCEL_PENDING).',
    inputSchema: { type: 'object', fields: {
      order_id: { type: 'string', required: true },
      reason: { type: 'string' },
    } },
    outputSchema: { type: 'object', description: '{ok, viaCarrier, order}' },
    sideEffect: true,
    idempotencyKey: input => `shipment_cancel:${input.order_id}`,
    timeoutMs: 30000,
    handler(input, ctx) {
      const app = ctx.app;
      if (!carrierConfigured(app)) return { status: 'NOT_CONFIGURED', reason: 'GHN token/shopId chưa cấu hình' };
      const order = loadOrder(app, input);
      const shipment = app.store.findOne('shipments', s => s.order_id === order.order_id && s.status !== 'CANCELLED');
      if (!shipment) throw toolError('SHIPMENT_NOT_FOUND', 'đơn không có vận đơn đang chạy');
      const r = app.orders.cancelShipmentViaCarrier({
        order, shipment,
        actor: ctx.operator || 'agent_tool',
        reason: input.reason || 'tool_request',
        eventId: null, carrier: app.carrier,
      });
      const fresh = app.store.findOne('orders', o => o.order_id === order.order_id);
      return { ok: !!r.ok, reason: r.reason || null, order: fresh ? { order_id: fresh.order_id, status: fresh.status } : null };
    },
  },

  // ================= NHÓM GỬI TIN / TAKEOVER =================
  {
    name: 'send_message',
    description: 'Gửi tin cho khách ĐÚNG GATE (agentSend — actor human_agent; Window 24h/quota/opt-out vẫn do gate quyết).',
    inputSchema: { type: 'object', fields: {
      conversation_id: { type: 'string', required: true },
      text: { type: 'string', required: true, maxLength: 4000 },
      operator: { type: 'string', description: 'người gửi (mặc định agent_tool)' },
      idem_nonce: { type: 'string', description: 'gửi LẠI nội dung y hệt chủ đích -> đặt nonce mới' },
    } },
    outputSchema: { type: 'object', description: '{sent, delivery_status, reason}' },
    sideEffect: true,
    idempotencyKey: input => `agent_send:${input.conversation_id}:${sha(String(input.text), 16)}:${input.idem_nonce || ''}`,
    timeoutMs: 15000,
    handler(input, ctx) {
      const app = ctx.app;
      const { conv, customer } = loadConversation(app, input.conversation_id);
      const r = app.gate.agentSend({
        conversation: conv, customer,
        text: String(input.text).trim(),
        operator: input.operator || ctx.operator || 'agent_tool',
      });
      if (r.race_rejected) return { sent: false, reason: r.race_rejected, race_recheck: true };
      return { sent: !!r.sent, reason: r.reason || null, delivery_status: r.delivery_status || null, pending_receipt: !!r.pending_receipt };
    },
  },
  {
    name: 'send_media',
    description: 'Gửi media (ảnh/video) cho khách — CHƯA CÓ adapter outbound media trong prototype.',
    inputSchema: { type: 'object', fields: {
      conversation_id: { type: 'string', required: true },
      media_url: { type: 'string', required: true },
      type: { type: 'string', description: 'image|video|file' },
    } },
    outputSchema: { type: 'object', description: '{status: NOT_CONFIGURED}' },
    sideEffect: true,
    idempotencyKey: input => `send_media:${input.conversation_id}:${sha(String(input.media_url), 16)}`,
    timeoutMs: 15000,
    handler() {
      // KHÔNG giả PASS: platform adapter prototype chỉ hỗ trợ text (MockPlatform/GhnAdapter interface).
      return { status: 'NOT_CONFIGURED', reason: 'outbound media chưa có adapter — platform interface hiện chỉ gửi text' };
    },
  },
  {
    name: 'request_human_takeover',
    description: 'Chuyển hội thoại cho nhân viên giữ (takeover.setTakeover — huỷ job AI QUEUED, mode HUMAN).',
    inputSchema: { type: 'object', fields: {
      conversation_id: { type: 'string', required: true },
      operator: { type: 'string' },
      reason: { type: 'string' },
    } },
    outputSchema: { type: 'object', description: '{ok, mode}' },
    sideEffect: true,
    idempotencyKey: input => `takeover:${input.conversation_id}`,
    timeoutMs: 5000,
    handler(input, ctx) {
      const app = ctx.app;
      const { conv } = loadConversation(app, input.conversation_id);
      return app.takeover.setTakeover(conv, input.operator || ctx.operator || 'agent_tool', input.reason || 'tool_request');
    },
  },
  {
    name: 'handback_to_ai',
    description: 'Trả hội thoại về AI (takeover.handback — giữ nguyên state, kích hoạt lại follow-up HELD).',
    inputSchema: { type: 'object', fields: {
      conversation_id: { type: 'string', required: true },
      operator: { type: 'string' },
    } },
    outputSchema: { type: 'object', description: '{ok, mode, state}' },
    sideEffect: true,
    idempotencyKey: input => `handback:${input.conversation_id}`,
    timeoutMs: 5000,
    handler(input, ctx) {
      const app = ctx.app;
      const { conv } = loadConversation(app, input.conversation_id);
      return app.takeover.handback(conv, input.operator || ctx.operator || 'agent_tool');
    },
  },
  {
    name: 'schedule_follow_up',
    description: 'Đặt lịch follow-up (CARE/MARKETING) — row follow_ups; việc GỬI vẫn do scheduler + gate quyết.',
    inputSchema: { type: 'object', fields: {
      conversation_id: { type: 'string', required: true },
      kind: { type: 'string', required: true, description: 'CARE | MARKETING' },
      delay_hours: { type: 'number', description: 'số giờ chờ (mặc định 24)' },
      scheduled_at: { type: 'string', description: 'ISO UTC — ưu tiên hơn delay_hours' },
      note: { type: 'string', maxLength: 500 },
    } },
    outputSchema: { type: 'object', description: '{follow_up_id, scheduled_at, scheduled_at_vn}' },
    sideEffect: true,
    idempotencyKey: input => `follow_up:${input.conversation_id}:${String(input.kind).toUpperCase()}:${input.scheduled_at || ('h' + (input.delay_hours || 24))}`,
    timeoutMs: 5000,
    handler(input, ctx) {
      const app = ctx.app;
      const { conv, customer } = loadConversation(app, input.conversation_id);
      const kind = String(input.kind).toUpperCase() === 'MARKETING' ? 'MARKETING' : 'CARE';
      // mirror policy gate: marketing chịu opt-out (chặn từ lúc đặt lịch — gate vẫn chặn lần 2 khi gửi)
      if (kind === 'MARKETING' && customer.marketing_opt_out === 1) {
        throw toolError('OPT_OUT', 'khách đã opt-out marketing — không đặt lịch quảng cáo');
      }
      const atIso = input.scheduled_at
        || new Date(app.clock.now() + Math.max(0.01, input.delay_hours || 24) * 3600 * 1000).toISOString();
      const { fmtVnTime } = require('../errors');
      const row = {
        follow_up_id: uid('fu'),
        order_id: null,
        conversation_id: conv.conversation_id,
        customer_id: conv.customer_id,
        kind,
        scheduled_at: atIso,
        status: 'SCHEDULED', cancel_reason: null, exec_id: null,
        note: input.note || null, source: 'agent_tool',
        created_at: app.store.now(), updated_at: app.store.now(),
      };
      const ins = app.store.insert('follow_ups', row);
      return {
        follow_up_id: (ins.duplicate ? ins.existing : row).follow_up_id,
        kind, scheduled_at: atIso, scheduled_at_vn: fmtVnTime(atIso), duplicate: !!ins.duplicate,
      };
    },
  },

  // ================= NHÓM CHÍNH SÁCH / KÊNH =================
  {
    name: 'read_channel_policy',
    description: 'Đọc chính sách kênh cho hội thoại: cửa sổ 24h FB (BL-1), loại tin tốn quota Zalo (BL-2), opt-out.',
    inputSchema: { type: 'object', fields: { conversation_id: { type: 'string' } } },
    outputSchema: { type: 'object', description: '{window, rules}' },
    sideEffect: false,
    timeoutMs: 5000,
    handler(input, ctx) {
      const app = ctx.app;
      const conv = input.conversation_id
        ? app.store.findOne('conversations', c => c.conversation_id === input.conversation_id)
        : null;
      return {
        window: conv ? app.gate.windowState(conv) : null,
        rules: {
          facebook_window_hours: FB_WINDOW_HOURS,
          facebook_window_scope: 'last_user_event_ts do gateway ghi — CHỈ event THẬT của user mở cửa sổ',
          zalo_cs_kinds_charged: ZALO_CS_KINDS,
          marketing_requires_opt_in: true,
          send_policy_single_point: 'action-gate.authorize (SendPolicy một chỗ duy nhất — P3C Bước 6)',
        },
      };
    },
  },
  {
    name: 'read_channel_quota',
    description: 'Đọc ngân sách CS Zalo còn lại của hội thoại (channel_budget — check trước khi đề xuất gửi).',
    inputSchema: { type: 'object', fields: { conversation_id: { type: 'string', required: true } } },
    outputSchema: { type: 'object', description: '{cs_remain, cs_total}' },
    sideEffect: false,
    timeoutMs: 5000,
    handler(input, ctx) {
      const app = ctx.app;
      const { conv, customer } = loadConversation(app, input.conversation_id);
      if (conv.channel !== 'zalo') return { channel: conv.channel, cs_remain: null, cs_total: null, note: 'kênh không dùng quota CS (chỉ Zalo)' };
      const b = app.gate.getBudget(conv, customer); // core đọc row hiện hành (không cache khi thấp)
      return { channel: 'zalo', cs_remain: b.cs_remain, cs_total: b.cs_total, quota_low_threshold: app.gate.quotaLowThreshold };
    },
  },
  {
    name: 'save_customer_note',
    description: 'Lưu ghi chú nội bộ về khách (append vào customer.notes + audit CUSTOMER_NOTE).',
    inputSchema: { type: 'object', fields: {
      customer_id: { type: 'string', required: true },
      note: { type: 'string', required: true, maxLength: 1000 },
      operator: { type: 'string' },
    } },
    outputSchema: { type: 'object', description: '{customer_id, notes_count}' },
    sideEffect: true,
    idempotencyKey: input => `customer_note:${input.customer_id}:${sha(String(input.note), 16)}`,
    timeoutMs: 5000,
    handler(input, ctx) {
      const app = ctx.app;
      const c = app.store.findOne('customers', x => x.customer_id === input.customer_id);
      if (!c) throw toolError('CUSTOMER_NOT_FOUND', 'khách không tồn tại');
      const entry = { note: String(input.note).trim(), operator: input.operator || ctx.operator || 'agent_tool', at: app.store.now() };
      app.store.transaction(() => {
        c.notes = [...(Array.isArray(c.notes) ? c.notes : []), entry];
        app.store.audit({
          event_id: null, conversation_id: null, customer_ref: c.customer_id,
          proposed_action: 'CUSTOMER_NOTE', validation: { operator: entry.operator },
          execution_result: 'OK', receipt: { note_preview: entry.note.slice(0, 50) }, stage: 'SETTINGS',
        });
      });
      return { customer_id: c.customer_id, notes_count: c.notes.length };
    },
  },
];

const TOOLS = {};
for (const d of DEFS) TOOLS[d.name] = d;

// ---------------------------------------------------------------- registry API
function listTools(ctx = {}) {
  return DEFS.map(d => ({
    name: d.name,
    description: d.description,
    inputSchema: d.inputSchema,
    outputSchema: d.outputSchema,
    sideEffect: !!d.sideEffect,
    idempotency: d.sideEffect ? 'idempotency_key + dedupe qua audit (scope theo run/adhoc)' : null,
    timeoutMs: d.timeoutMs,
    configured: toolConfigured(d.name, ctx.app),
  }));
}

function toolConfigured(name, app) {
  switch (name) {
    case 'quote_shipping':
    case 'create_shipment':
    case 'cancel_shipment':
      return carrierConfigured(app);
    case 'get_shipment_status':
      return !!app.carrier;
    case 'send_message':
      return !!(app.gate && app.platform);
    case 'send_media':
      return false; // prototype: chưa có outbound media adapter — KHÔNG giả PASS
    default:
      return true;
  }
}

// Đăng ký tool thêm (hook cho test/mở rộng) — KHÔNG đè tool core trùng tên.
function registerTool(def) {
  if (TOOLS[def.name]) throw new Error('tool exists: ' + def.name);
  TOOLS[def.name] = def;
  DEFS.push(def);
}

// Gỡ tool đã đăng ký (test cleanup — chỉ gỡ tool KHÔNG thuộc core).
function unregisterTool(name) {
  const i = DEFS.findIndex(d => d.name === name);
  if (i < 0) return false;
  delete TOOLS[name];
  DEFS.splice(i, 1);
  return true;
}

// ---------------------------------------------------------------- runTool
const ASYNC_TIMEOUT = Symbol('tool_async_timeout');

function idemKeyFor(tool, input, ctx) {
  if (!tool.sideEffect || typeof tool.idempotencyKey !== 'function') return null;
  const base = tool.idempotencyKey(input);
  const scope = ctx.run && ctx.run.run_id ? `run:${ctx.run.run_id}` : `adhoc:${new Date().toISOString().slice(0, 10)}`;
  return `${base}@${scope}`;
}

// Tìm lần chạy OK trước đó cùng idem_key (dedupe cấp tool — underlying core vẫn có idem riêng).
function findPriorOk(store, name, key) {
  if (!key) return false;
  return store.findAll('audit_events', a =>
    a.proposed_action === `TOOL:${name}` &&
    a.execution_result === 'OK' &&
    a.validation && a.validation.idem_key === key).length > 0;
}

function truncate(x, n) {
  try {
    const s = JSON.stringify(x);
    return s && s.length > n ? s.slice(0, n) + '…' : JSON.parse(s || 'null');
  } catch (e) { return null; }
}

// Ghi audit cấp tool (luôn ghi — dù có run hay không).
function auditToolCall(store, { name, input, idem, ok, status, result, error }) {
  store.audit({
    event_id: null,
    conversation_id: (input && input.conversation_id) || null,
    customer_ref: null,
    proposed_action: `TOOL:${name}`,
    validation: { idem_key: idem || null, input: truncate(input, 500) },
    execution_result: ok ? (status || 'OK') : (error && error.code) || 'ERROR',
    receipt: ok ? truncate(result, 400) : { error_message: String((error && error.message) || '').slice(0, 200) },
    stage: 'TOOL',
  });
}

/**
 * runTool(name, input, ctx) -> {ok:true, result, elapsed_ms, call_id}
 *                            | {ok:false, duplicate:true, elapsed_ms}
 *                            | {ok:false, status:'NOT_CONFIGURED', reason, error}
 *                            | {ok:false, error:{code, message, userMessage}, elapsed_ms}
 */
async function runTool(name, input, ctx = {}) {
  const app = ctx.app;
  const store = app && app.store;
  if (!app || !store) throw toolError('TOOL_CTX_MISSING', 'runTool cần ctx.app');
  const tool = TOOLS[name];
  if (!tool) {
    return { ok: false, error: { code: 'TOOL_UNKNOWN', message: `tool ${name} không tồn tại`, userMessage: 'Hành động không được hỗ trợ.' } };
  }
  const v = validateAgainstSchema(tool.inputSchema, input);
  if (!v.ok) {
    return { ok: false, error: { code: 'TOOL_INVALID_INPUT', message: v.errors.join('; '), userMessage: 'Dữ liệu không hợp lệ — kiểm tra lại thông tin nhập.' } };
  }
  const idem = idemKeyFor(tool, v.value, ctx);
  if (findPriorOk(store, name, idem)) {
    // idempotent hit — VẪN ghi nhận quan sát (agent phải thấy dedupe, không nuốt im lặng)
    const dupCallId = uid('tc');
    if (typeof ctx.recordToolCall === 'function') {
      ctx.recordToolCall({ call_id: dupCallId, tool: name, at: store.now(), elapsed_ms: 0, input_ref: `tool_input:${dupCallId}`, status: 'DUPLICATE_SUPPRESSED' });
    }
    auditToolCall(store, { name, input: v.value, idem, ok: true, status: 'DUPLICATE_SUPPRESSED', result: { duplicate: true } });
    return { ok: false, duplicate: true, idem_key: idem, call_id: dupCallId };
  }

  const t0 = Date.now();
  let out = null;
  let err = null;
  try {
    out = tool.handler(v.value, ctx);
    if (out && typeof out.then === 'function') {
      let timer = null;
      const raced = await Promise.race([
        Promise.resolve(out).catch(e => ({ __handler_error: e })),
        new Promise(r => { timer = setTimeout(() => r(ASYNC_TIMEOUT), tool.timeoutMs); }),
      ]);
      if (timer) clearTimeout(timer);
      if (raced === ASYNC_TIMEOUT) err = toolError('TOOL_TIMEOUT', `tool ${name} vượt ${tool.timeoutMs}ms`);
      else if (raced && raced.__handler_error) err = raced.__handler_error;
      else out = raced;
    }
  } catch (e) { err = e; }
  const elapsed_ms = Date.now() - t0;
  if (!err && elapsed_ms > tool.timeoutMs) {
    err = toolError('TOOL_TIMEOUT', `tool ${name} chạy ${elapsed_ms}ms > timeout ${tool.timeoutMs}ms — kết quả có thể đã side-effect, KHÔNG tự retry`);
  }

  const call_id = uid('tc');
  const call = {
    call_id, tool: name, at: store.now(), elapsed_ms,
    input_ref: `tool_input:${call_id}`,
    status: err ? err.code : 'OK',
  };

  if (!err && out && out.status === 'NOT_CONFIGURED') {
    // Backend chưa cấu hình — trả thẳng, KHÔNG giả PASS.
    call.status = 'NOT_CONFIGURED';
    if (typeof ctx.recordToolCall === 'function') ctx.recordToolCall(call);
    auditToolCall(store, { name, input: v.value, idem, ok: false, status: 'NOT_CONFIGURED', error: new Error(out.reason || 'NOT_CONFIGURED') });
    return { ok: false, status: 'NOT_CONFIGURED', reason: out.reason || 'backend chưa cấu hình', call_id, elapsed_ms };
  }

  if (err) {
    if (typeof ctx.recordToolCall === 'function') ctx.recordToolCall(Object.assign(call, { error: String(err.message).slice(0, 300) }));
    auditToolCall(store, { name, input: v.value, idem, ok: false, error: err });
    const f = friendlyError(err);
    return { ok: false, error: { code: err.code || 'TOOL_ERROR', message: String(err.message), userMessage: err.userMessage || f.userMessage, missing: err.missing || undefined, sku: err.sku || undefined }, call_id, elapsed_ms };
  }

  if (typeof ctx.recordToolCall === 'function') ctx.recordToolCall(Object.assign(call, { output_ref: `tool_result:${call_id}` }));
  auditToolCall(store, { name, input: v.value, idem, ok: true, status: 'OK', result: out });
  return { ok: true, result: out, idem_key: idem, call_id, elapsed_ms };
}

module.exports = {
  TOOLS, DEFS, listTools, runTool, registerTool, unregisterTool, validateAgainstSchema,
  carrierConfigured, toolError,
  // expose để test đọc (không dùng trong handler)
  _internals: { loadConversation, loadOrder, orderView, productView, customerView, toolConfigured },
};
