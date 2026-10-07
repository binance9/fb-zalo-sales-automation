'use strict';
// analytics.js — BÁO CÁO & THỐNG KÊ real-time (chuẩn aicake: doanh thu, số đơn, hiệu suất AI,
// top khách hàng, top sản phẩm).
//
// Nguyên tắc (giống dashboard() trong server.js):
//   - Hàm THUẦN buildAnalytics(app, {days}) — chỉ ĐỌC qua app.store.findAll(collection, predicate).
//     KHÔNG SQL, KHÔNG đọc file, KHÔNG ghi store.
//   - Mọi số lấy từ store thật, không bịa. "Hôm nay" theo đồng hồ App (app.clock.now()) —
//     khớp todayKeyOf() của dashboard (created_at là ISO UTC nên khoá ngày là slice(0,10) UTC).
//   - Đơn tính doanh thu: CONFIRMED + DELIVERED (giống doanhThuHomNay của dashboard).

const REVENUE_STATUSES = ['CONFIRMED', 'DELIVERED'];

function buildAnalytics(app, { days } = {}) {
  const n = Math.max(1, Math.min(90, Math.floor(Number(days) || 14)));

  // Khoá ngày "hôm nay" theo đồng hồ App (dashboard dùng cùng quy tắc)
  let nowMs = Date.now();
  try { nowMs = app.clock.now(); } catch (e) { /* app không có clock — dùng giờ thật */ }
  const todayKey = new Date(nowMs).toISOString().slice(0, 10);

  // Danh sách N ngày gần nhất: [today-(n-1) ... today] (UTC, khớp khoá ngày của created_at)
  const dayKeys = [];
  const baseMs = Date.parse(todayKey + 'T00:00:00.000Z');
  for (let i = n - 1; i >= 0; i--) dayKeys.push(new Date(baseMs - i * 86400000).toISOString().slice(0, 10));
  const daySet = new Set(dayKeys);
  const inWindow = row => daySet.has(String(row.created_at || '').slice(0, 10));

  // ---- đơn trong khoảng (tất cả trạng thái) ----
  const orders = app.store.findAll('orders', inWindow);

  // ---- revenue_by_day: doanh thu + số đơn CONFIRMED/DELIVERED theo từng ngày (đủ N ngày, ngày trống = 0) ----
  const revByDay = new Map(dayKeys.map(k => [k, { revenue: 0, orders: 0 }]));
  const paidOrders = []; // đơn chốt (CONFIRMED/DELIVERED) trong khoảng — dùng chung cho nhiều mục
  for (const o of orders) {
    if (!REVENUE_STATUSES.includes(o.status)) continue;
    paidOrders.push(o);
    const k = String(o.created_at || '').slice(0, 10);
    const slot = revByDay.get(k);
    if (slot) { slot.revenue += Number(o.total || 0); slot.orders += 1; }
  }
  const revenue_by_day = dayKeys.map(k => {
    const s = revByDay.get(k);
    return { date: k, revenue: s.revenue, orders: s.orders };
  });

  // ---- orders_by_status: đếm đơn trong khoảng theo từng trạng thái ----
  const byStatus = new Map();
  for (const o of orders) byStatus.set(o.status || 'UNKNOWN', (byStatus.get(o.status || 'UNKNOWN') || 0) + 1);
  const orders_by_status = {};
  for (const st of ['DRAFT', 'CONFIRMED', 'SHIPPING', 'DELIVERED', 'CANCELLED', 'CANCEL_PENDING']) {
    if (byStatus.has(st)) orders_by_status[st] = byStatus.get(st);
  }
  for (const [st, c] of byStatus) if (!(st in orders_by_status)) orders_by_status[st] = c;

  // ---- ai_performance: hội thoại trong khoảng; AI tự xử = chưa từng mode HUMAN,
  //      takeover = từng có mode HUMAN (hiện đang) HOẶC đang cờ flag_needs_human ----
  const convs = app.store.findAll('conversations', inWindow);
  const humanTakeover = convs.filter(c => c.mode === 'HUMAN' || c.flag_needs_human);
  const aiHandled = convs.length - humanTakeover.length;
  const autonomy_pct = convs.length
    ? Math.round((aiHandled / convs.length) * 100)
    : 0; // không có hội thoại -> 0% (giữ trong 0..100)
  const ai_performance = {
    total_conversations: convs.length,
    ai_handled: aiHandled,
    human_takeover: humanTakeover.length,
    autonomy_pct: Math.max(0, Math.min(100, autonomy_pct)),
  };

  // ---- top_customers: top 10 theo chi tiêu (đơn chốt trong khoảng) ----
  const customersById = new Map(app.store.findAll('customers', () => true).map(c => [c.customer_id, c]));
  const nameOf = c => (c ? (c.full_name || c.display_name || c.platform_ref) : null) || 'Không tên';
  const byCustomer = new Map(); // customer_id -> {total_spent, orders}
  for (const o of paidOrders) {
    const e = byCustomer.get(o.customer_id) || { total_spent: 0, orders: 0 };
    e.total_spent += Number(o.total || 0);
    e.orders += 1;
    byCustomer.set(o.customer_id, e);
  }
  const top_customers = [...byCustomer.entries()]
    .map(([customer_id, e]) => ({ customer_id, name: nameOf(customersById.get(customer_id)), total_spent: e.total_spent, orders: e.orders }))
    .sort((a, b) => b.total_spent - a.total_spent || b.orders - a.orders || String(a.customer_id).localeCompare(String(b.customer_id)))
    .slice(0, 10);

  // ---- top_products: cộng dồn qty theo sku GỐC (variant GUONG-CT-1 gộp về GUONG-CT) qua productDB
  //      (cách đọc hệt phần draft trong server.js — app.productDB.getVariant). SKU lạ -> giữ nguyên.
  const orderIds = new Set(paidOrders.map(o => o.order_id));
  const qtyByOrder = new Map(); // order_id -> Set(items trong đơn) — đếm "orders" cho mỗi sku gốc
  for (const it of app.store.findAll('order_items', i => orderIds.has(i.order_id))) {
    const list = qtyByOrder.get(it.order_id) || [];
    list.push(it);
    qtyByOrder.set(it.order_id, list);
  }
  const bySku = new Map(); // sku gốc -> {qty, orders:Set<order_id>}
  for (const [orderId, items] of qtyByOrder) {
    for (const it of items) {
      const hit = app.productDB && app.productDB.getVariant ? app.productDB.getVariant(it.variant_sku) : null;
      const baseSku = hit ? hit.product.sku_base : it.variant_sku;
      const baseName = hit ? hit.product.name : it.variant_sku;
      const e = bySku.get(baseSku) || { qty: 0, orders: new Set(), name: baseName };
      e.qty += Number(it.qty || 0);
      e.orders.add(orderId);
      bySku.set(baseSku, e);
    }
  }
  const top_products = [...bySku.entries()]
    .map(([sku, e]) => ({ sku, name: e.name, qty: e.qty, orders: e.orders.size }))
    .sort((a, b) => b.qty - a.qty || b.orders - a.orders || String(a.sku).localeCompare(String(b.sku)))
    .slice(0, 10);

  // ---- summary: cùng tập đơn chốt trong khoảng (khớp các thẻ Doanh thu/Đơn/Khách/Giá TB) ----
  const revenue_total = paidOrders.reduce((s, o) => s + Number(o.total || 0), 0);
  const summary = {
    revenue_total,
    orders_total: paidOrders.length,
    customers_total: byCustomer.size,
    avg_order_value: paidOrders.length ? Math.round(revenue_total / paidOrders.length) : 0,
  };

  return { range_days: n, today: todayKey, revenue_by_day, orders_by_status, ai_performance, top_customers, top_products, summary };
}

module.exports = { buildAnalytics };
