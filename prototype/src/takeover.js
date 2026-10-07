'use strict';
// takeover.js — HUMAN TAKEOVER (case 15/16).
// - setTakeover: mode -> HUMAN + huỷ sạch job AI QUEUED của hội thoại (AI3 case 15).
// - handback:    mode -> AI, GIỮ NGUYÊN state hiện hành (không reset về NEW_LEAD — AI3 case 16),
//                chèn ghi chú "người đã xử lý gì" vào ngữ cảnh (lớp summary thu gọn của AI2 mục 6.3).

const { uid } = require('./util');

// SỬA LẦN 2 (bug thật, vùng INV-2/INV-5): các job ĐỐI CHỨNG (check_send_receipt,
// reconcile_shipment) KHÔNG được hủy khi takeover — chúng không bao giờ tự gửi tin
// (không vi phạm INV-5) và hủy đi sẽ làm action_executions TIMEOUT_UNKNOWN không bao giờ
// được tra receipt/reconcile lại (mất đường recuperación bắt buộc của INV-2).
// Chỉ hủy job thuộc loại xử lý AI (process_event...).
const NOT_CANCELLABLE_BY_TAKEOVER = new Set(['check_send_receipt', 'reconcile_shipment']);

class Takeover {
  constructor({ store }) {
    this.store = store;
  }

  setTakeover(conversation, operatorId, reason) {
    const store = this.store;
    store.transaction(() => {
      conversation.mode = 'HUMAN';
      conversation.human_agent = operatorId;
      // huỷ job AI đang chờ của hội thoại (TRỪ job đối chứng — xem NOT_CANCELLABLE_BY_TAKEOVER)
      const pending = store.findAll('jobs', j =>
        j.conversation_id === conversation.conversation_id &&
        j.status === 'QUEUED' && !NOT_CANCELLABLE_BY_TAKEOVER.has(j.kind));
      for (const j of pending) store.updateRow('jobs', j, { status: 'CANCELLED', last_error: 'takeover' });
      store.audit({
        event_id: null, conversation_id: conversation.conversation_id, customer_ref: conversation.customer_id,
        proposed_action: 'TAKEOVER', validation: { operator: operatorId, reason: reason || 'operator_request', cancelled_jobs: pending.length },
        execution_result: 'MODE_HUMAN', receipt: null, stage: 'AUTHORIZED',
      });
    });
    return { ok: true, mode: 'HUMAN' };
  }

  handback(conversation, operatorId) {
    const store = this.store;
    store.transaction(() => {
      conversation.mode = 'AI';
      conversation.human_agent = null;
      conversation.handback_at = store.now();
      // SỬA LẦN 2 (đi cùng Fix HELD ở action-gate): follow-up bị GIỮ trong lúc HUMAN_OWNED
      // -> kích hoạt lại khi trả quyền để scheduler chạy tiếp đúng 1 lần.
      const held = store.findAll('follow_ups', f =>
        f.conversation_id === conversation.conversation_id && f.status === 'HELD');
      for (const f of held) store.updateRow('follow_ups', f, { status: 'SCHEDULED', cancel_reason: null });
      // lớp summary thu gọn: ghi lại người đã xử lý gì để AI không hỏi lại/mâu thuẫn
      conversation.agent_handoff_note = {
        note: `Nhân viên ${operatorId} vừa xử lý hội thoại ở state ${conversation.state}`,
        at: store.now(),
      };
      store.audit({
        event_id: null, conversation_id: conversation.conversation_id, customer_ref: conversation.customer_id,
        proposed_action: 'HANDBACK', validation: { operator: operatorId, state_kept: conversation.state },
        execution_result: 'MODE_AI', receipt: null, stage: 'AUTHORIZED',
      });
    });
    return { ok: true, mode: 'AI', state: conversation.state };
  }

  // Nhân viên gửi tin trong mode HUMAN — đi qua gate (action-gate.agentSend)
  agentSend(gate, conversation, customer, text, operatorId) {
    return gate.agentSend({ conversation, customer, text, operator: operatorId });
  }

  // Worklist cho operator (dashboard NEEDS_HUMAN)
  pushWorklist(conversation, reason, severity) {
    this.store.insert('worklist', {
      worklist_id: uid('wlk'), conversation_id: conversation.conversation_id,
      customer_id: conversation.customer_id, reason, severity: severity || 'normal',
      status: 'OPEN', created_at: this.store.now(),
    });
  }
}

module.exports = { Takeover };
