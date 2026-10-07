'use strict';
// session.js — customer session: state machine 10 state + mode AUTO/HUMAN + optOut + orderDraft slots.
// Slot-state từng trường: empty | detected | confirmed | stale (AI2 mục 2.3).
// Đổi sản phẩm: slot phụ thuộc SP (items) -> stale; slot độc lập (name/phone/address) GIỮ NGUYÊN.

const { uid, iso } = require('./util');

const STATES = [
  'NEW_LEAD', 'DISCOVERY', 'PRODUCT_QA', 'BUY_INTENT', 'COLLECT_ORDER',
  'VALIDATE', 'CONFIRM', 'ORDERED', 'SHIPPING', 'AFTER_SALES',
];

// Chuyển tiếp cho phép (tự chuyển về chính mình luôn hợp lệ). Khiếu nại là state phụ
// (flag `claim`) theo AI2 mục 1, không phá trục tuyến tính.
const TRANSITIONS = {
  NEW_LEAD: ['DISCOVERY', 'PRODUCT_QA', 'BUY_INTENT', 'AFTER_SALES'],
  DISCOVERY: ['PRODUCT_QA', 'BUY_INTENT', 'NEW_LEAD'],
  PRODUCT_QA: ['BUY_INTENT', 'DISCOVERY', 'COLLECT_ORDER', 'AFTER_SALES'],
  BUY_INTENT: ['COLLECT_ORDER', 'PRODUCT_QA', 'DISCOVERY'],
  COLLECT_ORDER: ['VALIDATE', 'PRODUCT_QA', 'BUY_INTENT', 'CONFIRM'],
  VALIDATE: ['CONFIRM', 'COLLECT_ORDER'],
  CONFIRM: ['ORDERED', 'COLLECT_ORDER'],
  // P3B-1: ORDERED -> BUY_INTENT — RE-ENTRY mua lại (khách ở ORDERED có ý định mua lần nữa
  // phải quay về BUY_INTENT thay vì bị nuốt im lặng; cross-review R3-1). Đơn CANCELLED là
  // TRẠNG THÁI CỦA ORDER ROW (order-engine), không phải state hội thoại — không thêm vào STATES.
  ORDERED: ['SHIPPING', 'AFTER_SALES', 'CONFIRM', 'BUY_INTENT'],
  SHIPPING: ['AFTER_SALES', 'ORDERED'],
  AFTER_SALES: ['NEW_LEAD', 'PRODUCT_QA', 'BUY_INTENT', 'DISCOVERY', 'COLLECT_ORDER', 'ORDERED', 'SHIPPING'],
};

class Sessions {
  constructor({ store }) {
    this.store = store;
  }

  ensureCustomer(channel, customerRef, displayName) {
    let cus = this.store.findOne('customers', c => c.channel === channel && c.platform_ref === customerRef);
    if (!cus) {
      cus = {
        customer_id: uid('cus'),
        channel,
        platform_ref: customerRef,
        display_name: displayName || null,
        full_name: null,
        phone: null,
        address: null,
        marketing_opt_out: 0,
        opt_out_at: null,
        created_at: this.store.now(),
        updated_at: this.store.now(),
      };
      this.store.insert('customers', cus);
    }
    return cus;
  }

  ensureConversation(channel, threadId, customer) {
    const conversationId = `${channel}:${threadId}`;
    let conv = this.store.findOne('conversations', c => c.conversation_id === conversationId);
    if (!conv) {
      conv = {
        conversation_id: conversationId,
        channel,
        customer_id: customer.customer_id,
        platform_thread_id: threadId,
        state: 'NEW_LEAD',
        mode: 'AI',            // 'AI' = auto | 'HUMAN' = takeover
        human_agent: null,
        handback_at: null,
        marketing_opt_out: 0,  // sao chiếu từ customer cho gate đọc nhanh
        draft: null,           // orderDraft: {slots:{name,phone,address}, items:[{sku,qty,state}], order_id}
        claim: null,           // {opened_at, reason, origin_state} — state phụ khiếu nại
        flag_needs_human: false,
        subject_sku: null,     // sản phẩm đang nói chuyện
        last_activity_at: this.store.now(),
        created_at: this.store.now(),
      };
      this.store.insert('conversations', conv);
    }
    return conv;
  }

  // ---- state machine ----
  transition(conv, toState, reason) {
    if (toState === conv.state) return { ok: true, note: 'same_state' };
    const allowed = (TRANSITIONS[conv.state] || []).includes(toState);
    if (!allowed) return { ok: false, reason: `bad_transition_${conv.state}_to_${toState}` };
    const from = conv.state;
    conv.state = toState;
    conv.last_activity_at = this.store.now();
    this.store.audit({
      event_id: null, conversation_id: conv.conversation_id, customer_ref: conv.customer_id,
      proposed_action: 'STATE_TRANSITION',
      validation: { from, to: toState, reason: reason || null },
      execution_result: 'OK', receipt: null, stage: 'STATE',
    });
    return { ok: true };
  }

  setMode(conv, mode, actor, reason) {
    const from = conv.mode;
    conv.mode = mode;
    if (mode === 'HUMAN') conv.human_agent = actor;
    if (mode === 'AI') { conv.handback_at = this.store.now(); conv.human_agent = null; }
    this.store.audit({
      event_id: null, conversation_id: conv.conversation_id, customer_ref: conv.customer_id,
      proposed_action: 'MODE_CHANGE',
      validation: { from, to: mode, actor, reason: reason || null },
      execution_result: 'OK', receipt: null, stage: 'MODE',
    });
  }

  openClaim(conv, reason) {
    if (conv.claim) return;
    conv.claim = { opened_at: this.store.now(), reason, origin_state: conv.state };
    this.store.audit({
      event_id: null, conversation_id: conv.conversation_id, customer_ref: conv.customer_id,
      proposed_action: 'CLAIM_OPEN', validation: { reason }, execution_result: 'OK', receipt: null, stage: 'CLAIM',
    });
  }

  // P3B-4 (cr-R3 R2-M2): closeClaim — kết thúc claim: quay về ĐÚNG state trước khi mở claim
  // (origin_state), xoá flag claim, ghi audit đầy đủ (ai đóng, lúc nào). Mode trả về AUTO do
  // LUỒNG HANDBACK SẴN CÓ đảm nhiệm (takeover.handback) — hàm này chỉ trách nhiệm claim+state.
  closeClaim(conv, operatorId, closeReason) {
    if (!conv.claim) return { ok: false, reason: 'NO_OPEN_CLAIM' };
    const store = this.store;
    const origin = conv.claim.origin_state || conv.state;
    const claimSnapshot = { ...conv.claim };
    return store.transaction(() => {
      // về đúng state trước đó; transition() tự audit STATE_TRANSITION.
      const t = this.transition(conv, origin, 'claim_close_restore');
      if (!t.ok) {
        // fallback (origin không còn transition hợp lệ từ state hiện tại — hiếm): đặt thẳng + audit riêng
        const from = conv.state;
        conv.state = origin;
        store.audit({
          event_id: null, conversation_id: conv.conversation_id, customer_ref: conv.customer_id,
          proposed_action: 'STATE_TRANSITION',
          validation: { from, to: origin, reason: 'claim_close_restore_forced' },
          execution_result: 'OK', receipt: null, stage: 'STATE',
        });
      }
      store.audit({
        event_id: null, conversation_id: conv.conversation_id, customer_ref: conv.customer_id,
        proposed_action: 'CLAIM_CLOSE',
        validation: {
          operator: operatorId || 'operator', close_reason: closeReason || null,
          opened_at: claimSnapshot.opened_at, origin_state: origin, reason_open: claimSnapshot.reason,
        },
        execution_result: 'OK', receipt: null, stage: 'CLAIM',
      });
      conv.claim = null;
      return { ok: true, restored_state: origin };
    });
  }

  // ---- orderDraft + slots ----
  getDraft(conv) {
    if (!conv.draft) {
      conv.draft = {
        slots: {
          name: { value: null, state: 'empty' },
          phone: { value: null, state: 'empty' },
          address: { value: null, state: 'empty' },
        },
        items: [], // {sku, qty, state: detected|confirmed|stale}
        order_id: null,
      };
    }
    return conv.draft;
  }

  setSlot(conv, field, value, state) {
    const draft = this.getDraft(conv);
    draft.slots[field] = { value, state: state || 'detected' };
    return draft.slots[field];
  }

  setItems(conv, items) {
    const draft = this.getDraft(conv);
    draft.items = items.map(it => ({ sku: it.sku, qty: it.qty, state: it.state || 'detected' }));
    return draft.items;
  }

  // Case 5: đổi SP — items cũ thành stale, giữ slot độc lập. Restore nếu khách quay lại đúng SKU.
  markProductChange(conv, newItems) {
    const draft = this.getDraft(conv);
    for (const it of draft.items) {
      if (it.state !== 'stale') it.state = 'stale';
    }
    for (const ni of newItems) {
      const old = draft.items.find(o => o.sku === ni.sku && o.state === 'stale');
      if (old) { old.qty = ni.qty; old.state = 'detected'; }
      else draft.items.push({ sku: ni.sku, qty: ni.qty, state: 'detected' });
    }
    // bỏ slot order cũ (nếu có) — caller chịu trách nhiệm huỷ DRAFT DB qua order engine
    return draft.items;
  }

  resetDraft(conv) {
    conv.draft = null;
  }

  missingRequiredSlots(conv) {
    const draft = this.getDraft(conv);
    const missing = [];
    if (!draft.items.some(i => i.state !== 'stale' && i.qty > 0)) missing.push('items');
    if (!(draft.slots.name && draft.slots.name.value)) missing.push('name');
    if (!(draft.slots.phone && draft.slots.phone.value)) missing.push('phone');
    if (!(draft.slots.address && draft.slots.address.value)) missing.push('address');
    return missing;
  }
}

module.exports = { Sessions, STATES, TRANSITIONS };
