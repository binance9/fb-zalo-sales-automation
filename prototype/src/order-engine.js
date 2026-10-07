'use strict';
// order-engine.js — tạo đơn 2 pha (AI3 mục 5) + tạo vận đơn có idempotency (case 12).
//   Pha A (DRAFT): check tồn kho + reserve + insert orders DRAFT + order_items trong 1 transaction.
//   Pha B (CONFIRM): RE-VALIDATE giá/tồn MỚI NHẤT từ product-db trong transaction, rồi mới trừ kho.
// Case 12: executor timeout -> TIMEOUT_UNKNOWN -> retry mù BỊ CHẶN (chưa có receipt) -> DLQ + needsHuman;
//          job reconcile tra cứu theo clientOrderCode -> ALREADY_EXISTS -> DONE với tracking cũ.
// idempotencyKey BẮT BUỘC: đơn  'order:'+conversation_id+':'+hash(giỏ); vận đơn 'shipment:'+order_id.
//
// Ghi chú prototype: "transaction" = store.transaction (khoá ghi tuần tự + snapshot rollback);
// production dùng BEGIN IMMEDIATE của SQLite trong cùng transaction với trừ kho (AI3 mục 0/5).

const { uid, sha } = require('./util');
// P3C/BL-6: phí ship là EVIDENCE dùng chung — order-engine và money guard (action-gate) phải
// đọc CÙNG MỘT nguồn (trước đây 25000 hardcode rải rác; production thay bằng carrier.quoteFee()).
const { MOCK_SHIPPING_FEE } = require('./shipping');

class OrderEngine {
  constructor({ store, productDB, clock, needsHuman, draftTtlMs }) {
    this.store = store;
    this.productDB = productDB;
    this.clock = clock;
    this.needsHuman = needsHuman; // (conversation, reason, severity) => void — do app cắm
    // P3B-2: TTL giữ chỗ cho DRAFT (cấu hình được; mặc định 24h). Hết TTL scheduler
    // (app.runDueJobs -> expireStaleDrafts) tự hoàn reservation.
    this.draftTtlMs = draftTtlMs !== undefined ? draftTtlMs : 24 * 3600 * 1000;
  }

  cartHash(items) {
    return sha(items.map(i => `${i.sku}x${i.qty}`).sort().join('|'), 16);
  }

  statusHistory(orderId, from, to, actor, reason, eventId) {
    this.store.audit({
      event_id: eventId || null,
      conversation_id: (this.store.findOne('orders', o => o.order_id === orderId) || {}).conversation_id || null,
      customer_ref: null,
      proposed_action: 'ORDER_STATUS',
      validation: { from: from || null, to, actor, reason: reason || null },
      execution_result: to,
      receipt: null,
      stage: 'ORDER',
    });
  }

  // ================= PHA A — ĐẶT GIỮ =================
  // validate (tồn/giá MỚI NHẤT) -> reserve -> orders DRAFT. Idempotent theo conversation+giỏ+THẾ HỆ MUA.
  phaseA({ conversation, customer, items, eventId }) {
    // SỬA LẦN 2 (bug thật, vùng INV-3): idempotency_key theo THẾ HỆ (`#gen`).
    // Key cũ `order:<conv>:<hashGiỏ>` khiến khách MUA LẠI cùng giỏ sau khi đã HỦY đơn
    // bị coi là "trùng key" -> trả về đơn CANCELLED cũ -> draft trỏ vào đơn chết ->
    // xác nhận văng BAD_STATUS_CANCELLED, khách kẹt vĩnh viễn.
    // Ngược lại retry THẬT (đơn DRAFT/CONFIRMED cùng giỏ chưa hủy) vẫn phải trùng key
    // -> chỉ 1 đơn (INV-3). Đơn CANCELLED/FAILED được đếm vào thế hệ -> mua lại ra đơn mới.
    //
    // P3B-1 (REPURCHASE/RE-ENTRY — cr-R3 R3-1 BLOCKER): key scope theo INTENT mua, KHÔNG
    // scope theo giỏ — thêm thế hệ cội điểm MUA `:g<buy_gen>` (conversation.buy_gen tăng 1
    // mỗi lần pipeline mở intent mua mới từ ORDERED/AFTER_SALES). Mỗi lần mua lại = generation
    // mới => đơn #2 THẬT với id mới; retry/crash CÙNG intent vẫn trùng key => đúng 1 đơn (INV-3).
    const gen = conversation.buy_gen || 0;
    const base = `order:${conversation.conversation_id}:${this.cartHash(items)}:g${gen}`;
    return this.store.transaction(() => {
      // Thế hệ CỘI ĐIỂM: chọn đơn có số thế hệ LỚN NHẤT của cùng conversation+giỏ.
      //  - đơn mới nhất còn DRAFT/CONFIRMED  -> retry thật -> idempotent hit (đúng 1 đơn, INV-3)
      //  - đơn mới nhất là CANCELLED/FAILED  -> mua lại ra thế hệ mới (không hồi sinh đơn chết)
      //  - chưa có đơn nào                   -> thế hệ #0
      const rows = this.store.findAll('orders', o =>
        o.conversation_id === conversation.conversation_id &&
        (o.idempotency_key || '').startsWith(base + '#'));
      let generation = -1;
      let latest = null;
      for (const o of rows) {
        const g = parseInt(o.idempotency_key.slice(base.length + 1), 10);
        if (!Number.isNaN(g) && g > generation) { generation = g; latest = o; }
      }
      if (latest && (latest.status === 'DRAFT' || latest.status === 'CONFIRMED')) {
        return { ok: true, order: latest, idempotent: true };
      }
      const idem = `${base}#${generation + 1}`;

      // 1) VALIDATE tồn kho bằng giá trị DB mới nhất — mọi item trong CÙNG transaction
      const lines = [];
      for (const it of items) {
        const s = this.productDB.getStock(it.sku); // LUÔN đọc mới nhất
        if (!s) return { ok: false, reason: 'SKU_NOT_FOUND', sku: it.sku };
        if (s.effective < it.qty) {
          return { ok: false, reason: 'OUT_OF_STOCK', sku: it.sku, effective: s.effective };
        }
        lines.push({ sku: it.sku, qty: it.qty, unit_price: s.price, line_total: s.price * it.qty });
      }

      // 2) RESERVE + ghi DRAFT (fail giữa chừng -> throw -> rollback cả reserve lẫn rows)
      for (const l of lines) {
        if (!this.productDB.reserve(l.sku, l.qty)) {
          return { ok: false, reason: 'OUT_OF_STOCK', sku: l.sku };
        }
      }
      const order_id = uid('ord');
      const subtotal = lines.reduce((t, l) => t + l.line_total, 0); // INTEGER VND, không float
      const shipping_fee = MOCK_SHIPPING_FEE;
      const order = {
        order_id,
        order_code: 'ORD' + order_id.slice(-8).toUpperCase(),
        conversation_id: conversation.conversation_id,
        customer_id: customer.customer_id,
        status: 'DRAFT',
        subtotal,
        shipping_fee,
        total: subtotal + shipping_fee,
        address_snapshot: JSON.stringify(
          conversation.draft && conversation.draft.slots.address ? conversation.draft.slots.address.value : null),
        price_snapshot_json: JSON.stringify(lines),
        idempotency_key: idem,
        // P3B-2: hạn giữ chỗ — scheduler sẽ tự hoàn reservation khi quá hạn
        draft_expires_at: new Date(this.clock.now() + this.draftTtlMs).toISOString(),
        created_at: this.store.now(),
        updated_at: this.store.now(),
      };
      this.store.insert('orders', order);
      for (const l of lines) {
        this.store.insert('order_items', {
          item_id: uid('itm'), order_id, variant_sku: l.sku, qty: l.qty,
          unit_price: l.unit_price, line_total: l.line_total,
        });
      }
      this.statusHistory(order_id, null, 'DRAFT', 'system', 'phase_a_reserve', eventId);
      return { ok: true, order, idempotent: false };
    });
  }

  cancelDraft(orderId, reason, eventId) {
    return this.store.transaction(() => {
      const order = this.store.findOne('orders', o => o.order_id === orderId);
      if (!order || order.status !== 'DRAFT') return { ok: false, reason: 'NOT_DRAFT' };
      const lines = JSON.parse(order.price_snapshot_json);
      for (const l of lines) this.productDB.release(l.sku, l.qty); // hoàn reserve
      // P3B-2: cancel_reason lên ROW (routeConfirm đọc để nhận biết "hết TTL phải re-validate")
      this.store.updateRow('orders', order, { status: 'CANCELLED', cancel_reason: reason || null });
      this.statusHistory(orderId, 'DRAFT', 'CANCELLED', 'system', reason, eventId);
      return { ok: true };
    });
  }

  // ================= P3B-2: TTL SWEEP — scheduler hoàn reservation quá hạn =================
  // Gọi từ app.runDueJobs (scheduler) tại MỌI tick: DRAFT quá draft_expires_at -> CANCELLED
  // (hoàn reserve -> tồn khả dụng trở lại). Ghi audit đầy đủ qua statusHistory.
  expireStaleDrafts(nowMs) {
    const store = this.store;
    const stale = store.findAll('orders', o =>
      o.status === 'DRAFT' && o.draft_expires_at && Date.parse(o.draft_expires_at) <= nowMs);
    const released = [];
    for (const o of stale) {
      const r = this.cancelDraft(o.order_id, 'draft_ttl_expired', null);
      if (r.ok) {
        released.push(o.order_id);
        store.inc('draft_expired');
        // nếu conversation đang trỏ vào draft này: GIỮ order_id (routeConfirm đọc ra
        // cancel_reason='draft_ttl_expired' để re-validate khi khách xác nhận muộn).
      }
    }
    return released;
  }

  // ================= P3B-5: HỦY ĐƠN (CONFIRMED/ORDERED) =================
  // - Đơn DRAFT -> cancelDraft (hoàn reserve).
  // - Đơn CONFIRMED KHÔNG có shipment (chưa gửi đi) -> restock + CANCELLED ngay.
  // - Đơn CONFIRMED ĐÃ CÓ shipment -> BẮT BUỘC đi qua shipping cancel path:
  //     write-ahead intent (action_executions key `cancel_shipment:<order_id>`, idempotent)
  //     -> carrier.cancelShipment -> có receipt CANCELLED mới hoàn tồn + CANCELLED;
  //     carrier TỪ CHỐI / chưa hỗ trợ -> đơn KHÔNG huỷ lửng: status CANCEL_PENDING + needsHuman.
  // Audit đầy đủ: ai huỷ (actor), lúc nào (cancel_at), lý do (reason).
  requestCancelOrder({ orderId, actor, reason, eventId, carrier }) {
    const store = this.store;
    const order = store.findOne('orders', o => o.order_id === orderId);
    if (!order) return { ok: false, reason: 'ORDER_NOT_FOUND' };
    if (order.status === 'CANCELLED') return { ok: true, idempotent: true, order };
    if (order.status === 'CANCEL_PENDING') return { ok: false, reason: 'CANCEL_PENDING_NEEDS_HUMAN', order };

    store.audit({
      event_id: eventId || null, conversation_id: order.conversation_id, customer_ref: order.customer_id,
      proposed_action: 'CANCEL_ORDER_REQUESTED',
      validation: { order_id: orderId, from_status: order.status, actor: actor || 'system', reason: reason || 'customer_request' },
      execution_result: 'PROPOSED', receipt: null, stage: 'PROPOSED',
    });

    const activeShipment = store.findOne('shipments', s => s.order_id === orderId && s.status !== 'CANCELLED');

    if (order.status === 'DRAFT') {
      const r = this.cancelDraft(orderId, reason || 'customer_request', eventId);
      if (!r.ok) return { ok: false, reason: r.reason };
      store.updateRow('orders', order, { cancel_actor: actor || 'system', cancel_at: store.now() });
      return { ok: true, order: store.findOne('orders', o => o.order_id === orderId), viaCarrier: false };
    }

    // CONFIRMED — tồn kho ĐÃ trừ lúc chốt (commitSale) -> huỷ phải HOÀN TỒN (restock)
    if (activeShipment) {
      if (!carrier) return { ok: false, reason: 'CARRIER_REQUIRED' };
      const csr = this.cancelShipmentViaCarrier({ order, shipment: activeShipment, actor, reason, eventId, carrier });
      if (csr.ok) {
        return { ok: true, order: store.findOne('orders', o => o.order_id === orderId), viaCarrier: true };
      }
      return { ok: false, pending: true, reason: 'CANCEL_PENDING_NEEDS_HUMAN', carrierReason: csr.reason, order };
    }

    const r = store.transaction(() => {
      this.restockOrder(order);
      store.updateRow('orders', order, {
        status: 'CANCELLED', cancel_reason: reason || 'customer_request',
        cancel_actor: actor || 'system', cancel_at: store.now(),
      });
      this.statusHistory(orderId, 'CONFIRMED', 'CANCELLED', actor || 'system', reason || 'customer_request', eventId);
      return { ok: true };
    });
    return r.ok
      ? { ok: true, order: store.findOne('orders', o => o.order_id === orderId), viaCarrier: false }
      : r;
  }

  // Hoàn tồn kho cho đơn đã CONFIRMED (commitSale đã trừ stock_qty — huỷ phải trả lại)
  restockOrder(order) {
    const lines = JSON.parse(order.price_snapshot_json);
    for (const l of lines) {
      const hit = this.productDB.getVariant(l.sku);
      if (hit) hit.variant.stock_qty += l.qty;
    }
  }

  cancelShipmentViaCarrier({ order, shipment, actor, reason, eventId, carrier }) {
    const store = this.store;
    const idem = `cancel_shipment:${order.order_id}`; // idempotency key RIÊNG của huỷ vận đơn
    const existing = store.findOne('action_executions', e => e.idempotency_key === idem);
    if (existing && existing.status === 'DONE') {
      return { ok: true, receipt: JSON.parse(existing.receipt_json || '{}') };
    }
    if (existing && existing.status !== 'FAILED') {
      // lần huỷ trước chưa rõ kết quả -> KHÔNG gọi lại mù (INV-2) -> chờ người/reconcile
      return { ok: false, reason: 'CANCEL_EXECUTION_IN_FLIGHT' };
    }

    const exec_id = uid('exec');
    store.transaction(() => {
      store.insert('action_executions', {
        exec_id, idempotency_key: idem, action_type: 'CANCEL_SHIPMENT',
        ref_type: 'shipments', ref_id: shipment.shipment_id,
        status: 'INTENT', attempt_count: 0, last_error: null, timeout_at: null,
        created_at: store.now(), updated_at: store.now(),
      });
      store.audit({
        event_id: eventId || null, conversation_id: order.conversation_id, customer_ref: order.customer_id,
        proposed_action: 'CANCEL_SHIPMENT', validation: { idempotency_key: idem, tracking: shipment.tracking_number },
        execution_result: 'INTENT_RECORDED', receipt: null, stage: 'EXECUTED',
      });
    });

    const res = carrier.cancelShipment({ idempotencyKey: idem, shipmentId: shipment.shipment_id, trackingNumber: shipment.tracking_number });

    if (res.status === 'CANCELLED') {
      store.transaction(() => {
        const exec = store.findOne('action_executions', e => e.exec_id === exec_id);
        store.updateRow('action_executions', exec, { status: 'DONE', receipt_json: JSON.stringify(res) });
        store.updateRow('shipments', shipment, { status: 'CANCELLED', cancelled_at: store.now(), cancel_receipt: JSON.stringify(res) });
        // carrier đã xác nhận huỷ -> MỚI hoàn tồn + huỷ đơn (không huỷ lửng)
        this.restockOrder(order);
        store.updateRow('orders', order, {
          status: 'CANCELLED', cancel_reason: reason || 'customer_request',
          cancel_actor: actor || 'system', cancel_at: store.now(),
        });
        this.statusHistory(order.order_id, 'CONFIRMED', 'CANCELLED', actor || 'system', `${reason || 'customer_request'}:via_carrier`, eventId);
        store.audit({
          event_id: eventId || null, conversation_id: order.conversation_id, customer_ref: order.customer_id,
          proposed_action: 'CANCEL_SHIPMENT', validation: { idempotency_key: idem, tracking: shipment.tracking_number },
          execution_result: 'DONE', receipt: res, stage: 'VERIFIED',
        });
      });
      return { ok: true, receipt: res };
    }

    // carrier TỪ CHỐI / chưa hỗ trợ / timeout -> đơn KHÔNG huỷ lửng: CANCEL_PENDING + needsHuman
    store.transaction(() => {
      const exec = store.findOne('action_executions', e => e.exec_id === exec_id);
      store.updateRow('action_executions', exec, { status: 'FAILED', last_error: `carrier_${String(res.status).toLowerCase()}` });
      store.updateRow('orders', order, {
        status: 'CANCEL_PENDING',
        cancel_reason: reason || 'customer_request',
        cancel_actor: actor || 'system',
        cancel_pending_at: store.now(),
        cancel_carrier_reason: res.reason || null,
      });
      this.statusHistory(order.order_id, 'CONFIRMED', 'CANCEL_PENDING', actor || 'system', res.reason || 'carrier_rejected', eventId);
      store.audit({
        event_id: eventId || null, conversation_id: order.conversation_id, customer_ref: order.customer_id,
        proposed_action: 'CANCEL_SHIPMENT',
        validation: { idempotency_key: idem, tracking: shipment.tracking_number, carrier_status: res.status },
        execution_result: `REJECTED:${res.reason || res.status}`, receipt: res, stage: 'FAILED',
      });
    });
    store.inc('cancel_shipment_rejected');
    const conv = store.findOne('conversations', c => c.conversation_id === order.conversation_id);
    if (conv && this.needsHuman) this.needsHuman(conv, 'cancel_shipment_rejected', 'high');
    return { ok: false, reason: res.reason || res.status };
  }

  // ================= PHA B — CHỐT (re-validate) =================
  phaseB({ orderId, eventId }) {
    return this.store.transaction(() => {
      const order = this.store.findOne('orders', o => o.order_id === orderId);
      if (!order) return { ok: false, reason: 'ORDER_NOT_FOUND' };
      if (order.status === 'CONFIRMED') return { ok: true, order, idempotent: true };
      if (order.status !== 'DRAFT') return { ok: false, reason: `BAD_STATUS_${order.status}` };

      const lines = JSON.parse(order.price_snapshot_json);
      // RE-VALIDATE bằng giá trị DB MỚI NHẤT (đúng mệnh lệnh đề bài cho case 9).
      // Tồn khả dụng CHO ĐƠN NÀY = stock_qty - stock_reserved + phần đơn mình đang giữ chỗ
      // (không tự chặn chính reservation của mình).
      for (const l of lines) {
        const s = this.productDB.getStock(l.sku);
        const available = s ? (s.stock_qty - s.stock_reserved) + l.qty : 0;
        if (!s || available < l.qty) {
          return { ok: false, reason: 'OUT_OF_STOCK', sku: l.sku, effective: s ? s.stock_qty - s.stock_reserved : 0 };
        }
        if (s.price !== l.unit_price) {
          return { ok: false, reason: 'PRICE_CHANGED', sku: l.sku, db_price: s.price };
        }
      }
      // COMMIT: trừ kho thật + giải phóng reserve
      for (const l of lines) this.productDB.commitSale(l.sku, l.qty);
      const total = lines.reduce((t, l) => t + l.line_total, 0) + order.shipping_fee;
      this.store.updateRow('orders', order, { status: 'CONFIRMED', total });
      this.statusHistory(orderId, 'DRAFT', 'CONFIRMED', 'system', 'phase_b_confirm', eventId);
      return { ok: true, order };
    });
  }

  // ================= VẬN ĐƠN (case 12) =================
  // Ghi intent TRƯỚC khi gọi ngoài (write-ahead intent, AI3 mục 2.3); timeout -> TIMEOUT_UNKNOWN.
  createShipment({ order, carrier }) {
    const idem = `shipment:${order.order_id}`;
    const existing = this.store.findOne('action_executions', e => e.idempotency_key === idem);
    if (existing && existing.status === 'DONE') {
      return { ok: true, done: true, shipment: this.store.findOne('shipments', s => s.order_id === order.order_id) };
    }
    if (existing) {
      // vòng khác đang làm / đang treo -> KHÔNG gọi lại mù quáng
      return { ok: false, blocked: true, reason: 'EXECUTION_IN_FLIGHT', exec: existing };
    }

    const exec_id = uid('exec');
    this.store.transaction(() => {
      this.store.insert('action_executions', {
        exec_id, idempotency_key: idem, action_type: 'CREATE_SHIPMENT',
        ref_type: 'orders', ref_id: order.order_id,
        status: 'INTENT', attempt_count: 0, last_error: null, timeout_at: null,
        created_at: this.store.now(), updated_at: this.store.now(),
      });
    });
    this.store.audit({
      event_id: null, conversation_id: order.conversation_id, customer_ref: order.customer_id,
      proposed_action: 'CREATE_SHIPMENT', validation: { idempotency_key: idem },
      execution_result: 'INTENT_RECORDED', receipt: null, stage: 'EXECUTED',
    });

    const res = carrier.createShipment({
      idempotencyKey: idem,
      clientOrderCode: order.order_code,
      order: { items: JSON.parse(order.price_snapshot_json), receiver: { name: 'khách', phone: '***' } },
    });

    if (res.status === 'CREATED') {
      this.store.transaction(() => {
        const exec = this.store.findOne('action_executions', e => e.exec_id === exec_id);
        this.store.updateRow('action_executions', exec, { status: 'DONE', receipt_json: JSON.stringify(res) });
        this.insertShipment(order, res.trackingNumber);
        this.store.audit({
          event_id: null, conversation_id: order.conversation_id, customer_ref: order.customer_id,
          proposed_action: 'CREATE_SHIPMENT', validation: { idempotency_key: idem },
          execution_result: 'DONE', receipt: res, stage: 'VERIFIED',
        });
      });
      return { ok: true, shipment: this.store.findOne('shipments', s => s.order_id === order.order_id) };
    }

    // TIMEOUT: KHÔNG BIẾT thành công hay thất bại -> CẤM retry mù (AI3 mục 7.1)
    this.store.transaction(() => {
      const exec = this.store.findOne('action_executions', e => e.exec_id === exec_id);
      this.store.updateRow('action_executions', exec, {
        status: 'TIMEOUT_UNKNOWN',
        timeout_at: this.store.now(),
        last_error: 'carrier_timeout',
      });
      this.store.audit({
        event_id: null, conversation_id: order.conversation_id, customer_ref: order.customer_id,
        proposed_action: 'CREATE_SHIPMENT', validation: { idempotency_key: idem },
        execution_result: 'TIMEOUT_UNKNOWN', receipt: null, stage: 'FAILED',
      });
    });
    this.store.inc('order_create_timeout');
    this.scheduleReconcile(order);
    return { ok: false, timeout: true, reason: 'TIMEOUT_UNKNOWN', exec_id };
  }

  // Nỗ lực retry "mù" — PHẢI bị chặn nếu chưa có receipt (case 12: cấm tạo lại mù quáng)
  blindRetryShipment({ order }) {
    const idem = `shipment:${order.order_id}`;
    const exec = this.store.findOne('action_executions', e => e.idempotency_key === idem);
    if (!exec) return { blocked: false, reason: 'NO_PRIOR_EXEC' };
    if (exec.status === 'DONE') {
      return { blocked: false, reason: 'ALREADY_DONE', receipt: JSON.parse(exec.receipt_json) };
    }
    // TIMEOUT_UNKNOWN / INTENT mà KHÔNG có bằng chứng -> CHẶN + DLQ + needsHuman
    const dlqRow = {
      dlq_id: uid('dlq'), job_id: exec.exec_id, kind: 'CREATE_SHIPMENT',
      payload_json: JSON.stringify({ order_id: order.order_id, idempotency_key: idem }),
      fail_reason: 'RETRY_BLOCKED_NO_RECEIPT', alerted: 0, created_at: this.store.now(),
    };
    this.store.transaction(() => {
      this.store.insert('dlq', dlqRow);
      this.store.inc('dlq_count');
      this.store.audit({
        event_id: null, conversation_id: order.conversation_id, customer_ref: order.customer_id,
        proposed_action: 'CREATE_SHIPMENT_RETRY', validation: { idempotency_key: idem },
        execution_result: 'RETRY_BLOCKED_NO_RECEIPT', receipt: null, stage: 'FAILED',
      });
    });
    if (this.needsHuman) {
      const conv = this.store.findOne('conversations', c => c.conversation_id === order.conversation_id);
      if (conv) this.needsHuman(conv, 'shipment_timeout_needs_reconcile', 'high');
    }
    return { blocked: true, reason: 'NO_RECEIPT', dlq: dlqRow };
  }

  scheduleReconcile(order) {
    // Job reconcile: tra cứu theo clientOrderCode (phòng tuyến chính cho case 12 theo AI3 mục 6)
    this.store.insert('jobs', {
      job_id: uid('job'), kind: 'reconcile_shipment',
      payload_json: JSON.stringify({ order_id: order.order_id }),
      status: 'QUEUED', run_at: this.clock.iso(),
      attempts: 0, max_attempts: 3, idempotency_key: `reconcile:${order.order_id}`,
      last_error: null, conversation_id: order.conversation_id,
      created_at: this.store.now(), updated_at: this.store.now(),
    });
  }

  reconcileShipment({ order, carrier }) {
    const idem = `shipment:${order.order_id}`;
    const exec = this.store.findOne('action_executions', e => e.idempotency_key === idem);
    if (!exec || exec.status === 'DONE') return { ok: true, note: 'nothing_to_do' };
    const found = carrier.searchByOrderCode(order.order_code);
    if (found.status === 'ALREADY_EXISTS') {
      // lần đầu THẬT RA THÀNH CÔNG — dùng lại tracking cũ, KHÔNG create lần 2
      this.store.transaction(() => {
        this.store.updateRow('action_executions', exec, { status: 'DONE', receipt_json: JSON.stringify(found) });
        this.insertShipment(order, found.trackingNumber);
        this.store.audit({
          event_id: null, conversation_id: order.conversation_id, customer_ref: order.customer_id,
          proposed_action: 'CREATE_SHIPMENT_RECONCILE', validation: { clientOrderCode: order.order_code },
          execution_result: 'ALREADY_EXISTS_RESOLVED', receipt: found, stage: 'VERIFIED',
        });
      });
      return { ok: true, resolved: 'ALREADY_EXISTS', trackingNumber: found.trackingNumber };
    }
    // Chắc chắn CHƯA tồn tại -> retry AN TOÀN, dùng LẠI idempotency key
    const res = carrier.createShipment({ idempotencyKey: idem, clientOrderCode: order.order_code, order: {} });
    if (res.status === 'CREATED') {
      this.store.transaction(() => {
        this.store.updateRow('action_executions', exec, { status: 'DONE', receipt_json: JSON.stringify(res) });
        this.insertShipment(order, res.trackingNumber);
      });
      return { ok: true, resolved: 'RETRY_CREATED', trackingNumber: res.trackingNumber };
    }
    return { ok: false, reason: 'STILL_TIMEOUT' };
  }

  insertShipment(order, trackingNumber) {
    // unique index request_idempotency_key: không bao giờ 2 vận đơn cho 1 order
    const res = this.store.insert('shipments', {
      shipment_id: uid('shp'),
      order_id: order.order_id,
      carrier: 'mock',
      carrier_order_code: order.order_code,
      tracking_number: trackingNumber,
      status: 'CREATED',
      request_idempotency_key: `shipment:${order.order_id}`,
      created_at: this.store.now(),
      updated_at: this.store.now(),
    });
    return res.duplicate ? res.existing : res.row;
  }
}

module.exports = { OrderEngine };
