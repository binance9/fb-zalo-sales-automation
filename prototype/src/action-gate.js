'use strict';
// action-gate.js — CỔNG HÀNH ĐỘNG DUY NHẤT: VALIDATE -> AUTHORIZE -> EXECUTE -> VERIFY (AI3 mục 4).
// Nguyên tắc vàng cài bằng cấu trúc:
//   - VALIDATE: mọi số tiền trong text AI được đối chiếu với giá trị DB **THEO SUBJECT** (P3C/BL-6:
//     chỉ variant của sản phẩm đang nói + snapshot đơn của conversation + tổng giỏ + phí ship +
//     ngưỡng khuyến mại có evidence — GIÁ SP KHÁC không còn làm whitelist); sai -> đè ĐÚNG CÂU
//     chứa số sai bằng câu render từ DB (không đè cả tin nữa); thiếu evidence -> câu an toàn + needsHuman.
//   - AUTHORIZE = SENDPOLICY MỘT CHỖ DUY NHẤT (P3C Bước 6):
//       bot_enabled · mode HUMAN (kể cả actor=system, whitelist template — P3A/BL-8)
//       · opt_out · WINDOW 24h FB theo last_user_event_ts (P3C/BL-1; chỉ utility template
//       mock-approved hoặc người thật ở mode HUMAN được gửi ngoài window; bot cấm tự gắn
//       human_agent) · QUOTA Zalo cs_reply.remain check trước send (P3C/BL-2; decrement
//       nguyên tử nằm ở EXECUTE cùng transaction ghi message) · state hợp lệ.
//     Sender (executeSend) CHỈ execute + re-check trong transaction (race + reserve quota).
//   - EXECUTE: write-ahead intent (action_executions, unique idempotency_key — P3A/BL-9 event-scoped);
//     P3C: tin accepted -> message SENT_PENDING_RECEIPT + row outbound_pending PENDING (BL-5),
//     KHÔNG BAO GIỜ tự đánh DELIVERED khi chưa có webhook receipt.
//   - VERIFY: RECEIPT STORE INBOUND-FIRST (P3C/BL-5): webhook receipt (FB message_delivery/
//     message_echo/message_read, Zalo user_seen_message) normalize -> match outbound_pending theo
//     conversation + channel + cửa sổ thời gian (+ mid) -> DELIVERED; không dùng platform.getReceipt()
//     (API không tồn tại trên nền tảng thật). Job check_receipt chỉ đọc outbound_pending, hết
//     max_attempts -> DLQ + NEEDS_HUMAN + ACK_DLQ đúng 1 lần — KHÔNG blind resend (INV-2).
// Mỗi action ghi JSONL audit: {event_id, conversation_id, customer_ref, proposed_action, validation,
//   execution_result, receipt, stage, at}. Audit AUTHORIZED ghi đủ template_id + actor + mode + result.

const { uid, sha, extractMoney, fmtVND } = require('./util');
const { SYSTEM_TEMPLATES, renderSystemTemplate, isUtilityApproved } = require('./system-templates');
const { MOCK_SHIPPING_FEE, MOCK_PROMOTIONS } = require('./shipping');

const SAFE_REPLIES = [
  'Câu này em phải hỏi chủ shop mới dám trả lời chính xác, mình chờ chút nha, có lời đáp lại liền ạ!',
  'Em ghi nhận câu hỏi của mình, để em kiểm tra và báo lại sau nha ạ!',
  'Câu này em chưa đủ dữ liệu trả lời ngay được, anh/chị cho em xin vài phút nhé ạ!',
];

// State được phép chạy action đơn
const ORDER_ACTION_STATES = ['BUY_INTENT', 'COLLECT_ORDER', 'VALIDATE', 'CONFIRM', 'PRODUCT_QA'];
const CONFIRM_ACTION_STATES = ['CONFIRM', 'COLLECT_ORDER'];

// P3C/BL-1: cửa sổ 24h Messenger (matrix A9)
const FB_WINDOW_MS = 24 * 3600 * 1000;
// P3C/BL-2: loại tin Zalo TỐN quota CS (matrix B5). transactional đi loại transaction
// (matrix B8 — KHÔNG tốn cs_reply), marketing đi quota promotion riêng (B7 — ngoài phạm vi mock).
const ZALO_CS_KINDS = new Set(['ai_reply', 'care']);
// P3C/BL-5: biên match receipt — cho lệch đồng hồ 2 phút, receipt sau 24h không còn nhận
// (tránh gắn nhầm receipt lạ vào tin cũ).
const RECEIPT_CLOCK_SKEW_MS = 2 * 60 * 1000;
const RECEIPT_MAX_AGE_MS = 24 * 3600 * 1000;

class ActionGate {
  constructor({ store, productDB, platform, clock, orders, needsHuman, quotaLowThreshold }) {
    this.store = store;
    this.productDB = productDB;
    this.platform = platform;
    this.clock = clock;
    this.orders = orders;
    this.needsHuman = needsHuman; // (conversation, reason, severity) => void
    // P3C/BL-2: remain <= ngưỡng -> dừng auto, chuyển human (budget per conversation).
    // remain > ngưỡng mới cho auto-send. Mặc định 2 theo lệnh đóng BL-2.
    this.quotaLowThreshold = quotaLowThreshold !== undefined ? quotaLowThreshold : 2;
  }

  // BL-9 (P3A): safeReply DETERMINISTIC theo hash(event_id) — KHÔNG xoay index toàn cục nữa.
  // Cùng event retry sau crash -> CÙNG câu an toàn -> idem key event-scoped ổn định, khách
  // không bao giờ nhận 2 nội dung khác nhau (safeIdx++ mỗi lần gọi trước đây là một lỗ BL-9:
  // mỗi retry sinh text khác -> key text-derived khác -> tin trùng).
  safeReply(eventId) {
    const h = parseInt(sha(String(eventId === null || eventId === undefined ? 'no-event' : eventId), 8), 16);
    return SAFE_REPLIES[h % SAFE_REPLIES.length];
  }

  botEnabled() {
    const s = this.store.findOne('settings', x => x.key === 'bot_enabled');
    return s ? s.value !== false : true;
  }

  // ================== SEND REPLY (luồng chính case 1..14) ==================
  sendReply({ conversation, customer, event, proposal }) {
    const store = this.store;
    const proposal_id = uid('prp');
    const actor = proposal.sender || 'ai';
    const msgKind = proposal.msgKind || 'ai_reply'; // ai_reply|transactional|marketing|care
    const templateId = proposal.template_id || null;                 // BL-8: bắt buộc khi actor=system
    const slot = proposal.slot || proposal.intent || 'reply';        // BL-9: định danh side-effect trong event

    // ---------- ghi PROPOSED ----------
    // BL-9: turn_key = <turn_event_id>:<slot> (unique) -> retry cùng event KHÔNG sinh
    // proposal row thứ 2; row attempt trước được tái sử dụng để ghi decision/validation.
    const prp = {
      proposal_id, conversation_id: conversation.conversation_id, turn_event_id: event ? event.event_id : null,
      turn_key: event ? `${event.event_id}:${slot}` : null,
      intent: proposal.intent, proposal_json: JSON.stringify({ text: proposal.text, msgKind, sender: actor }),
      evidence_json: proposal.evidence ? JSON.stringify(proposal.evidence) : null,
      confidence: proposal.confidence !== undefined ? proposal.confidence : null,
      validation_json: null, decision: 'PENDING', created_at: store.now(),
    };
    const prpIns = store.insert('ai_proposals', prp);
    const prpRow = prpIns.duplicate ? prpIns.existing : prp;
    store.audit({
      event_id: event ? event.event_id : null, conversation_id: conversation.conversation_id,
      customer_ref: customer.customer_id, proposed_action: `SEND_REPLY:${proposal.intent}`,
      validation: null, execution_result: 'PROPOSED', receipt: null, stage: 'PROPOSED',
    });

    // ---------- 1) VALIDATE ----------
    // BL-6 (P3C): allowedMoney THEO SUBJECT, KHÔNG còn toàn catalogue:
    //   variant của sản phẩm ĐANG NÓI (conv.subject_sku) + variants trong facts (DB render cho
    //   chính reply này) + snapshot MỌI đơn của conversation + tổng mọi tổ hợp giỏ hiện có
    //   + phí ship + ngưỡng khuyến mại có evidence. Giá SP KHÁC trong catalogue KHÔNG còn làm
    //   whitelist cho subject hiện tại (probe 7: nến 185000 nói 145000 = giá trà -> OVERRIDE).
    const allowed = this.buildAllowedMoney(conversation, proposal);
    const moneyInText = extractMoney(proposal.text);
    // SỬA LẦN 2 (hở thật, vùng HALLUCINATED PRICE — KET-QUA mục 3.6): extractMoney chỉ nhận
    // số CÓ đơn vị tiền/nhóm nghìn -> lời bịa KHÔNG đơn vị ("giá 92500") hay dạng "92.5k"
    // lọt thẳng ra ngoài. Với intent mang GIÁ (PRICE/VARIANT/STOCK), quét thêm: số trần
    // 4–7 chữ số >= 10000 (không khớp SĐT 10 số vì word-boundary) và dạng <số>k.
    const PRICE_INTENTS = new Set(['PRICE', 'VARIANT', 'STOCK']);
    const bareInText = [];
    if (PRICE_INTENTS.has(proposal.intent)) {
      const t = String(proposal.text || '');
      let m;
      const reBare = /\b(\d{4,7})\b/g;
      while ((m = reBare.exec(t)) !== null) {
        const v = parseInt(m[1], 10);
        if (v >= 10000) bareInText.push(v);
      }
      const reK = /\b(\d{1,3}(?:[.,]\d{1,2})?)\s*k\b/gi;
      while ((m = reK.exec(t)) !== null) {
        const v = Math.round(parseFloat(m[1].replace(',', '.')) * 1000);
        if (v >= 10000) bareInText.push(v);
      }
    } else {
      // SURI STABILITY (LỖI 3 — hở thật đã probe: bill/CHITCHAT nói "tổng tiền 92500" /
      // "còn 92.5k" không đơn vị LỌT qua guard vì bare-scan trước đây chỉ chạy cho PRICE/
      // VARIANT/STOCK). Mở rộng: intent KHÁC vẫn quét bare/k NHƯNG chỉ khi số đứng trong
      // NGỮ CẢNH TIỀN (cạnh giá|tiền|giảm|còn|tổng|phí). Loại trừ giữ nguyên: qty 1-99
      // (dưới ngưỡng 10000), SĐT (đã redact/trước đây không khớp \d{4,7} bounded), mã đơn
      // (ORD/MOCK + chữ lẫn số — không khớp \b\d{4,7}\b).
      const t = String(proposal.text || '');
      const MONEY_CTX = /(giá|gia|tiền|tien|giảm|giam|còn|con|tổng|tong|phí|phi)/i;
      let m;
      const reBare = /\b(\d{4,7})\b/g;
      while ((m = reBare.exec(t)) !== null) {
        const v = parseInt(m[1], 10);
        if (v < 10000) continue;
        const window = t.slice(Math.max(0, m.index - 22), m.index + m[0].length + 12);
        if (MONEY_CTX.test(window)) bareInText.push(v);
      }
      const reK = /\b(\d{1,3}(?:[.,]\d{1,2})?)\s*k\b/gi;
      while ((m = reK.exec(t)) !== null) {
        const v = Math.round(parseFloat(m[1].replace(',', '.')) * 1000);
        if (v < 10000) continue;
        const window = t.slice(Math.max(0, m.index - 22), m.index + m[0].length + 12);
        if (MONEY_CTX.test(window)) bareInText.push(v);
      }
    }
    const seenMoney = new Set([...moneyInText, ...bareInText]);
    const badMoney = [...seenMoney].filter(v => !allowed.has(v));
    const overriddenFields = [];
    let decision;
    let text = proposal.text;

    if (proposal.needHuman || !proposal.evidence) {
      // Không đủ evidence -> câu an toàn + cờ needsHuman (case 14, case 3/4 fail)
      // BL-9: text an toàn chọn theo hash(event_id) — retry sinh CÙNG text.
      decision = 'NEEDS_HUMAN';
      text = this.safeReply(event ? event.event_id : null);
      store.inc('ai_low_confidence');
      this.needsHuman(conversation, `low_evidence:${proposal.intent}`, 'normal');
    } else if (badMoney.length) {
      // AI phát số tiền không có evidence theo subject -> đè ĐÚNG CÂU chứa số sai (BL-6 +
      // cr-R2 R3-2: KHÔNG đè cả tin — câu đúng đi kèm được giữ nguyên).
      decision = 'OVERRIDDEN';
      text = this.replaceBadMoneySentences(proposal, badMoney);
      overriddenFields.push('price');
      store.inc('gate_override');
    } else {
      decision = 'AUTO_EXECUTED';
    }

    prpRow.validation_json = JSON.stringify({
      money_in_text: moneyInText, bare_numbers_in_text: bareInText, bad_money: badMoney,
      overridden_fields: overriddenFields,
      allowed_money_source: 'subject_scoped', // BL-6: evidence ghi rõ phạm vi whitelist
      evidence_present: !!proposal.evidence,
    });
    if (decision === 'OVERRIDDEN') prpRow.decision = 'OVERRIDDEN';
    if (decision === 'NEEDS_HUMAN') prpRow.decision = 'NEEDS_HUMAN';
    store.audit({
      event_id: event ? event.event_id : null, conversation_id: conversation.conversation_id,
      customer_ref: customer.customer_id, proposed_action: `SEND_REPLY:${proposal.intent}`,
      validation: prpRow.validation_json ? JSON.parse(prpRow.validation_json) : null,
      execution_result: decision, receipt: null, stage: 'VALIDATED',
    });

    // ---------- 2) AUTHORIZE (SENDPOLICY MỘT CHỖ DUY NHẤT — Bước 6) ----------
    const auth = this.authorize({ conversation, customer, msgKind, actor, actionType: 'SEND_MESSAGE', templateId, renderedText: proposal.text });
    if (!auth.ok) {
      prpRow.decision = 'REJECTED_BY_GATE';
      store.audit({
        event_id: event ? event.event_id : null, conversation_id: conversation.conversation_id,
        customer_ref: customer.customer_id, proposed_action: `SEND_REPLY:${proposal.intent}`,
        validation: { decision: 'REJECT', reason: auth.reason, actor, mode: conversation.mode, template_id: templateId },
        execution_result: `REJECTED:${auth.reason}`, receipt: null, stage: 'AUTHORIZED',
      });
      store.inc(`gate_rejected_${auth.reason}`);
      // BL-2: quota cạn vừa phải (remain <= ngưỡng, chưa == 0) -> KHÔNG auto, chuyển human.
      if (auth.reason === 'zalo_quota_low') this.needsHuman(conversation, 'zalo_quota_low', 'normal');
      return { sent: false, reason: auth.reason, decision: 'REJECTED_BY_GATE', text: null, overridden: overriddenFields };
    }
    // BL-8: audit AUTHORIZED bắt buộc ghi đủ template_id + actor + mode + authorize_result
    // P3C: kèm evidence window/quota tại thời điểm duyệt (SendPolicy một chỗ — dễ đối chứng).
    const w = this.windowState(conversation);
    const budget = conversation.channel === 'zalo' && ZALO_CS_KINDS.has(msgKind)
      ? this.getBudget(conversation, customer) : null;
    store.audit({
      event_id: event ? event.event_id : null, conversation_id: conversation.conversation_id,
      customer_ref: customer.customer_id, proposed_action: `SEND_REPLY:${proposal.intent}`,
      validation: {
        decision: 'ALLOW', actor, mode: conversation.mode, template_id: templateId,
        window_open: conversation.channel === 'facebook' ? w.open : null,
        last_user_event_ts: w.last_user_event_ts,
        cs_remain: budget ? budget.cs_remain : null,
      },
      execution_result: 'AUTHORIZED', receipt: null, stage: 'AUTHORIZED',
    });

    // ---------- 3) EXECUTE (ghi intent TRƯỚC khi gửi) ----------
    const send = this.executeSend({
      conversation, customer, event, text, actor, actionLabel: `SEND_REPLY:${proposal.intent}`, msgKind,
      templateId, slot,
    });
    if (send.race_rejected) {
      // BL-8: re-check authorize trong transaction ghi message bắt được race mode-flip
      // (cr-R3 R2-4) -> coi như gate REJECT, KHÔNG có tin nào đi ra.
      prpRow.decision = 'REJECTED_BY_GATE';
      store.audit({
        event_id: event ? event.event_id : null, conversation_id: conversation.conversation_id,
        customer_ref: customer.customer_id, proposed_action: `SEND_REPLY:${proposal.intent}`,
        validation: { decision: 'REJECT', reason: send.race_rejected, race_recheck: true, actor, mode: conversation.mode, template_id: templateId },
        execution_result: `REJECTED:${send.race_rejected}`, receipt: null, stage: 'AUTHORIZED',
      });
      store.inc(`gate_rejected_${send.race_rejected}`);
      return { sent: false, reason: send.race_rejected, decision: 'REJECTED_BY_GATE', text: null, overridden: overriddenFields };
    }
    prpRow.decision = decision;

    // ---------- 4) VERIFY ----------
    const verify = this.verifySend({ conversation, send, actionLabel: `SEND_REPLY:${proposal.intent}` });
    return { sent: true, text, overridden: overriddenFields, decision, needsHuman: decision === 'NEEDS_HUMAN', ...verify };
  }

  // ================== SENDPOLICY (P3C Bước 6 — MỘT CHỖ DUY NHẤT) ==================
  // Mọi ràng buộc nền tảng/trạng thái của auto-send duyệt TẠI ĐÂY, theo thứ tự:
  //   (1) bot tắt                          -> bot_off
  //   (2) actor=ai + mode HUMAN            -> takeover        (INV-5, P3A)
  //   (3) marketing/care + mode HUMAN      -> takeover        (INV-5, mọi actor)
  //   (4) marketing/care + opt-out         -> opt_out         (mọi actor — system không bypass)
  //   (5) actor=system                     -> whitelist SYSTEM_TEMPLATES (P3A/BL-8)
  //   (6) WINDOW 24h FB (BL-1)             -> fb_window_closed / human_agent_spoofed;
  //                                           ngoại lệ: utility template mock-approved,
  //                                           người thật (human_agent) ở mode HUMAN (tag HUMAN_AGENT)
  //   (7) QUOTA Zalo CS (BL-2)             -> zalo_quota_exhausted (remain=0, REJECT cứng)
  //                                           / zalo_quota_low (remain<=ngưỡng -> NEEDS_HUMAN/HOLD)
  //   (8) state CREATE/CONFIRM order       -> bad_state
  // Input: { conversation, customer, msgKind, actor, actionType, templateId, renderedText }
  // Output: { ok:true, actor, mode, template_id, window, cs_remain } | { ok:false, reason, hold? }
  // Sender (executeSend) KHÔNG tự nghĩ policy — chỉ re-run hàm này trong transaction ghi message
  // (race + reserve quota nguyên tử). KHÔNG rải check ở sender/scheduler/pipeline.
  authorize({ conversation, customer, msgKind, actor, actionType, templateId, renderedText }) {
    if (!this.botEnabled()) return { ok: false, reason: 'bot_off' };
    if (actor === 'ai' && conversation.mode === 'HUMAN') return { ok: false, reason: 'takeover' };
    // SỬA LẦN 2 (hở thật, vùng INV-5): trước đây chỉ chặn actor 'ai' — follow-up
    // marketing/care do scheduler bắn (actor 'system') đến hạn DURING mode HUMAN
    // vẫn tự động gửi ra ngoài, vi phạm INV-5 ("CẤM MỌI auto-send").
    // Chỉ cho phép: nhân viên (human_agent), tin transactional/chính sách (template
    // khiếu nại, ack opt-out, trạng thái đơn).
    if (conversation.mode === 'HUMAN' && (msgKind === 'marketing' || msgKind === 'care')) {
      return { ok: false, reason: 'takeover' };
    }
    if ((msgKind === 'marketing' || msgKind === 'care') && customer.marketing_opt_out === 1) {
      return { ok: false, reason: 'opt_out' };
    }
    if (actor === 'system') {
      // P3A/BL-8: vector cũ "system + ai_reply (DEFAULT của sendReply)" -> REJECT tuyệt đối
      if (msgKind === 'ai_reply') return { ok: false, reason: 'system_ai_reply' };
      // system chỉ đi qua whitelist template cứng
      const tpl = templateId ? SYSTEM_TEMPLATES[templateId] : null;
      if (!tpl) return { ok: false, reason: 'system_template_unknown' };
      if (tpl.kind !== msgKind) return { ok: false, reason: 'system_template_kind' };
      if (!tpl.allowed_modes.includes(conversation.mode)) return { ok: false, reason: 'system_template_mode' };
      if (renderedText !== undefined && renderedText !== null && renderSystemTemplate(templateId) !== renderedText) {
        return { ok: false, reason: 'system_template_text' };
      }
    }
    // ---- (6) BL-1: WINDOW 24h FACEBOOK ----
    if (conversation.channel === 'facebook') {
      const w = this.windowState(conversation);
      if (!w.open) {
        if (actor === 'human_agent') {
          // Người thật bấm tay -> tag HUMAN_AGENT (7 ngày, matrix A12) — chỉ hợp lệ khi
          // hội thoại đang do người giữ (mode HUMAN). Bot TỰ GẮN human_agent để lách window
          // ở mode AI = giả mạo -> REJECT (C1.5).
          if (conversation.mode !== 'HUMAN') return { ok: false, reason: 'human_agent_spoofed' };
        } else if (actor === 'system' && isUtilityApproved(templateId)) {
          // Utility template đã duyệt (MOCK-APPROVED — matrix A13): đường DUY NHẤT của bot
          // ngoài window. Follow-up marketing/care KHÔNG thuộc loại này (A13 cấm marketing).
        } else {
          return { ok: false, reason: 'fb_window_closed', window: w };
        }
      }
    }
    // ---- (7) BL-2: QUOTA CS ZALO (pre-check; decrement nguyên tử ở EXECUTE) ----
    let budget = null;
    if (conversation.channel === 'zalo' && ZALO_CS_KINDS.has(msgKind)) {
      budget = this.getBudget(conversation, customer);
      if (budget.cs_remain <= 0) return { ok: false, reason: 'zalo_quota_exhausted' };
      if (budget.cs_remain <= this.quotaLowThreshold) return { ok: false, reason: 'zalo_quota_low', hold: true };
    }
    if (actionType === 'CREATE_ORDER' && !ORDER_ACTION_STATES.includes(conversation.state)) {
      return { ok: false, reason: 'bad_state' };
    }
    if (actionType === 'CONFIRM_ORDER' && !CONFIRM_ACTION_STATES.includes(conversation.state)) {
      return { ok: false, reason: 'bad_state' };
    }
    // Ghi chú prototype: rate-limit chống loop (AI3 mục 4) chưa cài — hạn chế ghi trong KET-QUA.
    return {
      ok: true, actor, mode: conversation.mode, template_id: templateId || null,
      window_open: conversation.channel === 'facebook' ? this.windowState(conversation).open : null,
      cs_remain: budget ? budget.cs_remain : null,
    };
  }

  // SURI STABILITY (LỖI 2 — mitigation-b): phát hiện khách ĐÃ ĐỔI Ý sau turn hiện tại.
  // Trả reason 'stale_user_change' nếu:
  //   (a) tin in MỚI NHẤT của hội thoại KHÔNG phải tin của turn này và mang tín hiệu đổi ý;
  //   (b) event user mới hơn CÙNG kênh+khách đang CHỜ trong inbox (webhook đã về, chưa
  //       normalize — nói riêng: đang xếp hàng trong lúc reply AI chậm) và mang tín hiệu đổi ý.
  // Tín hiệu đổi ý = bộ regex HỦY ĐƠN + ĐỔI SUBJECT của pipeline (RE.cancelOrder/RE.changeSubject
  // — chép nguyên văn để action-gate không phụ thuộc pipeline). Chỉ actor 'ai' + có event turn.
  // Khối lượng reject là CHẶT: chỉ câu hủy/đổi ý — câu hỏi bổ sung bình thường KHÔNG bị coi là stale.
  detectStaleTurn(conversation, customer, event, actor) {
    if (actor !== 'ai' || !event || !event.event_id) return null;
    const store = this.store;
    const pmId = (event.payload && event.payload.platform_message_id) || null;
    // (a) tin in mới nhất của hội thoại là tin KHÁC turn này + đổi ý
    const inMsgs = store.findAll('messages', m =>
      m.conversation_id === conversation.conversation_id && m.direction === 'in');
    const lastIn = inMsgs[inMsgs.length - 1];
    if (lastIn
      && String(lastIn.platform_message_id || '') !== String(pmId || '')
      && STALE_CHANGE_RE.test(String(lastIn.text_content || ''))) {
      return 'stale_user_change';
    }
    // (b) event user mới hơn đang chờ trong inbox (chưa normalize) cùng kênh + khách
    const custRef = customer.platform_ref || customer.customer_ref;
    const inbox = store.findAll('inbox_events', e =>
      e.channel === conversation.channel && e.customer_ref === custRef);
    const turnIdx = inbox.findIndex(e => e.event_id === event.event_id);
    for (let i = turnIdx + 1; i < inbox.length; i++) {
      const e = inbox[i];
      if (!e || e.status !== 'RECEIVED' || e.type !== 'message') continue;
      let txt = '';
      try { txt = String((JSON.parse(e.raw_body || '{}') || {}).text || ''); } catch (err) { /* raw hỏng — bỏ qua */ }
      if (STALE_CHANGE_RE.test(txt)) return 'stale_user_change';
    }
    return null;
  }

  // ---- BL-1 helper: trạng thái cửa sổ 24h của conversation (đọc channel_state do gateway ghi) ----
  windowState(conversation) {
    const row = this.store.findOne('channel_state', s => s.conversation_id === conversation.conversation_id);
    const lastIso = row ? row.last_user_event_ts : null;
    const last = lastIso ? Date.parse(lastIso) : null;
    const ageMs = last === null || Number.isNaN(last) ? null : this.clock.now() - last;
    return {
      last_user_event_ts: lastIso,
      age_ms: ageMs,
      // Không có evidence user event nào -> coi như window ĐÓNG (đúng nền tảng: không có tin
      // nào của khách trong 24h qua thì không được gửi thường).
      open: last !== null && !Number.isNaN(last) && ageMs <= FB_WINDOW_MS,
    };
  }

  // ---- BL-2 helper: ngân sách CS per conversation (D9) — KHÔNG cache khi remain thấp:
  // luôn đọc row hiện hành; row khởi tạo MỘT LẦN từ platform.getQuota (đọc động, không hardcode). ----
  getBudget(conversation, customer) {
    const store = this.store;
    let b = store.findOne('channel_budget', x => x.conversation_id === conversation.conversation_id);
    if (!b) {
      const q = this.platform && typeof this.platform.getQuota === 'function'
        ? this.platform.getQuota(customer.platform_ref)
        : { remain: 8, total: 8 };
      b = {
        conversation_id: conversation.conversation_id,
        channel: conversation.channel,
        user_ref: customer.platform_ref,
        cs_total: q.total, cs_remain: q.remain,
        window_opened_at: conversation.last_activity_at || store.now(),
        created_at: store.now(), updated_at: store.now(),
      };
      const ins = store.insert('channel_budget', b);
      if (ins.duplicate) b = ins.existing;
    }
    return b;
  }

  // EXECUTE cho SEND_MESSAGE: intent ledger -> platform mock -> DONE|TIMEOUT_UNKNOWN|FAILED
  // BL-9 (P3A): idem key EVENT-SCOPED `send:<conv>:<event_id>:<msg_kind>:<slot>` với 3 tính chất:
  //   (1) stable across retry — cùng event tính lại ra CÙNG key;
  //   (2) independent of generated wording — text chỉ là payload, KHÔNG nằm trong key
  //       (trước đây key = sha(text+event_id): LLM thật sinh text khác mỗi lần -> mất dedupe);
  //   (3) unique by intended side-effect — slot (intent) phân biệt nhiều send cùng event.
  // Caller NGOÀI event (agent/follow-up) truyền idemScope theo INTENT: follow_up:<id>,
  // agent:<operator>:<nonce>, dlq_ack:<exec_id> — không bao giờ hash text.
  // BL-2 (P3C): reserve quota CS Zalo NGUYÊN TỬ trong CÙNG transaction ghi message (không có
  //   cửa 2 worker cùng đọc remain=1 rồi cùng gửi); definite-fail -> hoàn lại quota.
  // BL-5 (P3C): tin accepted -> outbound_pending PENDING + message SENT_PENDING_RECEIPT —
  //   KHÔNG tự đánh DELIVERED; chỉ webhook receipt (processReceiptEvent) mới được nâng cấp.
  executeSend({ conversation, customer, event, text, actor, actionLabel, msgKind, templateId, slot, idemScope }) {
    const store = this.store;
    const exec_id = uid('exec');
    const clientMessageId = exec_id;
    const scope = idemScope
      || (event ? `${event.event_id}:${msgKind}:${slot || 'reply'}` : `onetime:${uid('ot')}`);
    const idem = `send:${conversation.conversation_id}:${scope}`;

    // check-and-set theo unique idempotency_key: action này đã làm rồi thì KHÔNG gửi lần 2.
    // Crash-sau-side-effect (P3A/BL-9): retry rơi vào đây -> KHÔNG gửi lại (INV-2).
    // P3C/BL-5: bù trạng thái từ outbound_pending (bằng chứng receipt inbound), KHÔNG từ
    // platform.getReceipt() — API không tồn tại trên nền tảng thật.
    const existed = store.findOne('action_executions', e => e.idempotency_key === idem);
    if (existed) {
      let op = store.findOne('outbound_pending', o => o.exec_id === existed.exec_id);
      if (!op && existed.status === 'INTENT' && existed.action_type === 'SEND_MESSAGE') {
        // Crash trong cửa sổ "đã gọi platform, chưa ghi kết quả": KHÔNG BIẾT tin có rời hệ
        // thống chưa -> xử lý bảo thủ: lập bản ghi chờ receipt (không resend mù). Receipt
        // không bao giờ tới -> job check_receipt sẽ DLQ + NEEDS_HUMAN.
        const dupMsg0 = store.findOne('messages', m => m.send_exec_id === existed.exec_id);
        store.transaction(() => {
          this.recordOutboundPending({
            conversation, exec_id: existed.exec_id,
            text: (dupMsg0 && dupMsg0.text_content) || text || '',
            platformMid: (dupMsg0 && dupMsg0.platform_message_id) || null,
            sentAt: existed.created_at, event,
          });
        });
        op = store.findOne('outbound_pending', o => o.exec_id === existed.exec_id);
        // Crash-window: webhook receipt có thể đã về TRƯỚC khi op được ghi -> reconcile ngay.
        this.reconcileReceiptsForConversation(conversation.conversation_id);
        op = store.findOne('outbound_pending', o => o.exec_id === existed.exec_id);
      }
      const dupMsg = store.findOne('messages', m => m.send_exec_id === existed.exec_id) || { delivery_status: 'UNKNOWN' };
      if (existed.status !== 'DONE' && op && op.receipt_status === 'DELIVERED') {
        // Có bằng chứng delivery inbound -> đóng DONE từ bằng chứng (đúng INV-2).
        store.transaction(() => {
          store.updateRow('action_executions', existed, { status: 'DONE', receipt_json: JSON.stringify({ mid: op.platform_message_id, from: 'outbound_pending' }) });
          if (dupMsg.message_id) {
            dupMsg.delivery_status = 'DELIVERED';
            dupMsg.platform_message_id = op.platform_message_id;
            dupMsg.receipt_json = JSON.stringify({ mid: op.platform_message_id, receipt_at: op.receipt_at });
          }
        });
      }
      store.audit({
        event_id: event ? event.event_id : null, conversation_id: conversation.conversation_id,
        customer_ref: customer.customer_id, proposed_action: actionLabel,
        validation: { idempotency_key: idem, duplicate_suppressed: true, actor, mode: conversation.mode, template_id: templateId || null },
        execution_result: 'DUPLICATE_SUPPRESSED', receipt: null, stage: 'EXECUTED',
      });
      return { exec_id: existed.exec_id, clientMessageId: existed.exec_id, duplicate: true, res: { ok: true, mid: null }, msg: dupMsg };
    }
    store.transaction(() => {
      store.insert('action_executions', {
        exec_id, idempotency_key: idem, action_type: 'SEND_MESSAGE',
        ref_type: 'conversations', ref_id: conversation.conversation_id,
        status: 'INTENT', attempt_count: 0, last_error: null, timeout_at: null,
        created_at: store.now(), updated_at: store.now(),
      });
    });
    store.audit({
      event_id: event ? event.event_id : null, conversation_id: conversation.conversation_id,
      customer_ref: customer.customer_id, proposed_action: actionLabel,
      validation: null, execution_result: 'INTENT_RECORDED', receipt: null, stage: 'EXECUTED',
    });

    // Ghi row message TRƯỚC, cập nhật trạng thái sau (write-ahead).
    // BL-8 (cr-R3 R2-4): re-check authorize TRONG CÙNG transaction ghi message — chống race
    // mode-flip giữa authorize và ghi row; race bị bắt -> KHÔNG có row, KHÔNG có platform call.
    // BL-2: reserve quota CS Zalo cũng trong transaction này (check-and-decrement nguyên tử).
    const msg = {
      message_id: uid('msg'), conversation_id: conversation.conversation_id,
      direction: 'out', sender: actor === 'system' ? 'system' : actor === 'human_agent' ? 'human_agent' : 'ai',
      kind: 'text', text_content: text, attachment_json: null,
      platform_message_id: null, send_exec_id: exec_id, msg_kind: msgKind,
      created_at: store.now(), delivery_status: 'PENDING', receipt_json: null,
    };
    let raceReason = null;
    let quotaConsumed = false;
    store.transaction(() => {
      const cur = store.findOne('conversations', c => c.conversation_id === conversation.conversation_id) || conversation;
      const re = this.authorize({ conversation: cur, customer, msgKind, actor, actionType: 'SEND_MESSAGE', templateId, renderedText: text });
      if (!re.ok) { raceReason = re.reason; return; }
      // SURI STABILITY (LỖI 2 — mitigation-b): STALE-TURN REJECTION. Đường LLM có thể chậm
      // (hiện tại sync chặn event loop tới timeout); nếu TRONG LÚC CHỜ khách đã bày tỏ ĐỔI Ý
      // (hủy đơn/bỏ đơn/đổi SP/thôi mua), reply của turn cũ là STALE — gửi ra là trả lời lạc
      // đề sau khi khách đổi ý. Kiểm tra trong CÙNG transaction ghi message (chống race như
      // BL-8), chỉ áp cho reply AI có turn event; follow-up/agent/system không đụng.
      const stale = this.detectStaleTurn(cur, customer, event, actor);
      if (stale) { raceReason = stale; return; }
      // ---- BL-2: reserve CS quota NGUYÊN TỬ (cùng tx với insert message) ----
      if (cur.channel === 'zalo' && ZALO_CS_KINDS.has(msgKind)) {
        const b = this.getBudget(cur, customer);
        if (b.cs_remain <= 0) { raceReason = 'zalo_quota_exhausted'; return; }
        if (b.cs_remain <= this.quotaLowThreshold) { raceReason = 'zalo_quota_low'; return; }
        // Gom tin (BL-2): Zalo tối đa 2 tin CS/turn; remain thấp -> gộp còn 1 tin/turn.
        const cap = b.cs_remain <= this.quotaLowThreshold + 1 ? 1 : 2;
        if (event && event.event_id) {
          const turnOps = store.findAll('outbound_pending', o =>
            o.conversation_id === cur.conversation_id && o.turn_event_id === event.event_id).length;
          if (turnOps >= cap) { raceReason = 'zalo_cs_turn_cap'; return; }
        }
        store.updateRow('channel_budget', b, { cs_remain: b.cs_remain - 1, updated_at: store.now() });
        quotaConsumed = true;
      }
      store.insert('messages', msg);
    });
    if (raceReason) {
      store.transaction(() => {
        const exec = store.findOne('action_executions', e => e.exec_id === exec_id);
        store.updateRow('action_executions', exec, { status: 'FAILED', last_error: `gate_race:${raceReason}` });
      });
      store.audit({
        event_id: event ? event.event_id : null, conversation_id: conversation.conversation_id,
        customer_ref: customer.customer_id, proposed_action: actionLabel,
        validation: { race_recheck: true, actor, mode: conversation.mode, template_id: templateId || null },
        execution_result: `REJECTED:${raceReason}`, receipt: null, stage: 'EXECUTED',
      });
      if (raceReason === 'zalo_quota_low') this.needsHuman(conversation, 'zalo_quota_low', 'normal');
      return { race_rejected: raceReason, exec_id };
    }

    const res = this.platform.sendMessage({ clientMessageId, to: conversation.conversation_id, text });
    const exec = store.findOne('action_executions', e => e.exec_id === exec_id);
    if (res.ok) {
      // BL-5: response ok = send ĐƯỢC CHẤP NHẬN (có mid) — KHÔNG PHẢI bằng chứng delivery.
      store.transaction(() => {
        store.updateRow('action_executions', exec, {
          status: 'DONE', receipt_json: JSON.stringify({ mid: res.mid, accepted_at: store.now() }),
        });
        msg.delivery_status = 'SENT_PENDING_RECEIPT';
        msg.platform_message_id = res.mid;
        this.recordOutboundPending({ conversation, exec_id, text, platformMid: res.mid, sentAt: store.now(), event });
      });
      if (conversation.channel === 'zalo' && ZALO_CS_KINDS.has(msgKind)) {
        this.platform.consumeCs(customer.platform_ref); // platform trừ quota phía nó (mock B6)
      }
      // Receipt webhook có thể mất — hẹn job đối chứng outbound_pending (có giới hạn -> DLQ).
      this.scheduleCheckReceipt(conversation, exec_id, clientMessageId, 1);
    } else if (res.timeout) {
      store.transaction(() => {
        store.updateRow('action_executions', exec, {
          status: 'TIMEOUT_UNKNOWN', timeout_at: store.now(), last_error: 'platform_timeout',
        });
        msg.delivery_status = 'SENT_PENDING_RECEIPT'; // kết quả chưa biết -> chờ receipt, KHÔNG đoán
        this.recordOutboundPending({ conversation, exec_id, text, platformMid: null, sentAt: store.now(), event });
      });
      store.inc('send_timeout');
      this.scheduleCheckReceipt(conversation, exec_id, clientMessageId, 1);
    } else {
      store.transaction(() => {
        store.updateRow('action_executions', exec, { status: 'FAILED', last_error: res.error });
        msg.delivery_status = 'FAILED';
        // BL-2: thất bại RÕ (không gửi được) -> hoàn lại quota đã reserve (compensation nguyên tử).
        if (quotaConsumed && conversation.channel === 'zalo') {
          const b = this.getBudget(conversation, customer);
          store.updateRow('channel_budget', b, { cs_remain: b.cs_remain + 1, updated_at: store.now() });
          store.inc('quota_refund');
        }
      });
      // SỬA LẦN 2 (hở thật, vùng INV-2): thất bại RÕ (4xx/5xx) trước đây bị nuốt im lặng —
      // tin mất hẳn mà không ai hay. Prototype chọn KHÔNG auto-retry kể cả 5xx (an toàn hơn
      // spec "5xx retry được"): đẩy ngay cho người xử lý + metric send_failed.
      store.inc('send_failed');
      this.needsHuman(conversation, `send_failed:${res.error || 'unknown'}`, 'high');
    }
    store.audit({
      event_id: event ? event.event_id : null, conversation_id: conversation.conversation_id,
      customer_ref: customer.customer_id, proposed_action: actionLabel,
      validation: null,
      execution_result: res.ok ? 'SENT' : (res.timeout ? 'TIMEOUT_UNKNOWN' : 'FAILED'),
      receipt: res.ok ? { mid: res.mid } : null, stage: 'EXECUTED',
    });
    return { exec_id, clientMessageId, res, msg };
  }

  // BL-5 (P3C): ghi bản ghi chờ receipt (inbound-first) — unique theo exec_id (idempotent).
  recordOutboundPending({ conversation, exec_id, text, platformMid, sentAt, event }) {
    const ins = this.store.insert('outbound_pending', {
      op_id: uid('ob'),
      exec_id,
      conversation_id: conversation.conversation_id,
      channel: conversation.channel,
      sent_at: sentAt || this.store.now(),
      text_hash: sha(String(text || ''), 16),
      turn_event_id: event && event.event_id ? event.event_id : null,
      platform_message_id: platformMid || null,
      receipt_status: 'PENDING',
      receipt_event_id: null,
      receipt_at: null,
      created_at: this.store.now(),
      updated_at: this.store.now(),
    });
    return ins.duplicate ? ins.existing : ins.row;
  }

  // ================== RECEIPT STORE INBOUND-FIRST (BL-5) ==================
  // Webhook receipt (normalize xong) -> match outbound_pending:
  //   - dedupe theo receipt_event_id (idempotent — platform resend webhook là chuyện thường);
  //   - match theo conversation + channel + cửa sổ thời gian [sent_at-2ph, sent_at+24h];
  //     nếu receipt mang mid khớp platform_message_id của 1 candidate -> ưu tiên mid;
  //     receipt không khớp candidate nào -> KHÔNG gắn nhầm (metric receipt_unmatched) NHƯNG
  //     GIỮ LẠI row receipt — crash-window (webhook về trước khi op được ghi) sẽ được
  //     reconcileReceiptsForConversation() ghép sau (C3.2).
  // Match thành công -> op DELIVERED + message DELIVERED + exec DONE (nếu đang UNKNOWN)
  // + follow_up PENDING_RECEIPT -> SENT.
  processReceiptEvent(ev) {
    const store = this.store;
    const ins = store.insert('receipt_events', {
      receipt_event_id: ev.event_id,
      conversation_id: ev.conversation_id || null,
      channel: ev.channel || null,
      kind: ev.kind || 'message_delivery',
      mid: ev.mid || null,
      at: ev.at || store.now(),
      matched_op_id: null,
      created_at: store.now(),
    });
    if (ins.duplicate) return { duplicate: true, matched: false }; // C3.3: duplicate receipt idempotent
    return this.matchAndApplyReceipt(ins.row);
  }

  // Ghép 1 row receipt_events (đã dedupe) với outbound_pending PENDING của conversation.
  matchAndApplyReceipt(receiptRow) {
    const store = this.store;
    const at = Date.parse(receiptRow.at);
    const candidates = store.findAll('outbound_pending', o =>
      o.conversation_id === receiptRow.conversation_id && o.receipt_status === 'PENDING');
    let target = null;
    if (receiptRow.mid) {
      target = candidates.find(o => o.platform_message_id && o.platform_message_id === receiptRow.mid) || null;
    }
    if (!target) {
      target = candidates
        .filter(o => {
          const sent = Date.parse(o.sent_at);
          return at >= sent - RECEIPT_CLOCK_SKEW_MS && at <= sent + RECEIPT_MAX_AGE_MS;
        })
        .sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)))[0] || null;
    }
    if (!target) {
      // C3.4: receipt lạ (conversation không có pending / ngoài cửa sổ thời gian) -> không gắn nhầm.
      // Row receipt GIỮ LẠI (matched_op_id=null) để reconcile khi op sinh ra sau (crash-window).
      store.inc('receipt_unmatched');
      store.audit({
        event_id: null, conversation_id: receiptRow.conversation_id || null, customer_ref: null,
        proposed_action: 'RECEIPT', validation: { event_id: receiptRow.receipt_event_id, kind: receiptRow.kind, candidates: candidates.length },
        execution_result: 'RECEIPT_UNMATCHED', receipt: null, stage: 'RECEIPT',
      });
      return { matched: false };
    }
    store.transaction(() => {
      store.updateRow('outbound_pending', target, {
        receipt_status: 'DELIVERED', receipt_event_id: receiptRow.receipt_event_id, receipt_at: receiptRow.at, updated_at: store.now(),
      });
      const msgRow = store.findOne('messages', m => m.send_exec_id === target.exec_id);
      if (msgRow) {
        msgRow.delivery_status = 'DELIVERED';
        if (receiptRow.mid) msgRow.platform_message_id = receiptRow.mid;
        msgRow.receipt_json = JSON.stringify({ mid: receiptRow.mid || target.platform_message_id, receipt_event_id: receiptRow.receipt_event_id, receipt_at: receiptRow.at });
      }
      const exec = store.findOne('action_executions', e => e.exec_id === target.exec_id);
      if (exec && exec.status !== 'DONE') {
        store.updateRow('action_executions', exec, { status: 'DONE', receipt_json: JSON.stringify({ mid: receiptRow.mid || target.platform_message_id, from: 'receipt_webhook' }) });
      }
      const fu = store.findOne('follow_ups', f => f.exec_id === target.exec_id && f.status === 'PENDING_RECEIPT');
      if (fu) store.updateRow('follow_ups', fu, { status: 'SENT', receipt_at: receiptRow.at, updated_at: store.now() });
      store.updateRow('receipt_events', receiptRow, { matched_op_id: target.op_id });
      store.inc('receipt_matched');
    });
    store.audit({
      event_id: null, conversation_id: receiptRow.conversation_id || null, customer_ref: null,
      proposed_action: 'RECEIPT', validation: { event_id: receiptRow.receipt_event_id, kind: receiptRow.kind, op_id: target.op_id, exec_id: target.exec_id },
      execution_result: 'RECEIPT_MATCHED', receipt: { mid: receiptRow.mid || null, at: receiptRow.at }, stage: 'VERIFIED',
    });
    return { matched: true, op_id: target.op_id };
  }

  // Reconcile: crash-window — webhook receipt về TRƯỚC khi row outbound_pending được ghi
  // (worker chết sau khi platform nhận tin, retry ghi op muộn hơn webhook). Mọi receipt chưa
  // match của conversation được ghép lại theo cùng luật (conversation + window thời gian + mid).
  reconcileReceiptsForConversation(conversationId) {
    const pendingReceipts = this.store.findAll('receipt_events', r =>
      r.conversation_id === conversationId && !r.matched_op_id);
    let matched = 0;
    for (const r of pendingReceipts) {
      if (this.matchAndApplyReceipt(r).matched) matched += 1;
    }
    return matched;
  }

  scheduleCheckReceipt(conversation, execId, clientMessageId, attempt) {
    const job = {
      job_id: uid('job'), kind: 'check_send_receipt',
      payload_json: JSON.stringify({ exec_id: execId, client_message_id: clientMessageId, attempt }),
      status: 'QUEUED', run_at: new Date(this.clock.now() + 60 * 1000).toISOString(),
      attempts: attempt, max_attempts: 3, idempotency_key: null,
      last_error: null, conversation_id: conversation.conversation_id,
      created_at: this.store.now(), updated_at: this.store.now(),
    };
    this.store.insert('jobs', job);
  }

  // Job check_receipt (case 11) — P3C/BL-5: KHÔNG hỏi platform.getReceipt (API không tồn tại
  // trên nền tảng thật). Chỉ ĐỌC outbound_pending: receipt chưa về (webhook có thể mất) ->
  // retry CÓ GIỚI HẠN; hết max_attempts -> DLQ + NEEDS_HUMAN + follow-up FAILED + ACK_DLQ
  // đúng 1 lần (chống dead-air, V2 B.10.5) — KHÔNG blind resend (INV-2).
  checkSendReceipt({ exec_id, client_message_id, attempt }) {
    const store = this.store;
    const exec = store.findOne('action_executions', e => e.exec_id === exec_id);
    if (!exec || exec.status === 'DONE') return { ok: true, note: 'already_done' };
    let op = store.findOne('outbound_pending', o => o.exec_id === exec_id);
    if (!op || op.receipt_status !== 'DELIVERED') {
      // Receipt webhook có thể về trước khi op được ghi (crash-window) hoặc chưa được ghép
      // -> thử reconcile các receipt chưa match của conversation trước khi kết luận.
      this.reconcileReceiptsForConversation(exec.ref_id);
      op = store.findOne('outbound_pending', o => o.exec_id === exec_id);
    }
    if (op && op.receipt_status === 'DELIVERED') {
      // Receipt đã match (qua webhook) nhưng exec chưa kịp đóng -> đóng từ bằng chứng.
      store.transaction(() => {
        store.updateRow('action_executions', exec, { status: 'DONE', receipt_json: JSON.stringify({ mid: op.platform_message_id, from: 'outbound_pending' }) });
        const msg = store.findOne('messages', m => m.send_exec_id === exec_id);
        if (msg) {
          msg.delivery_status = 'DELIVERED';
          msg.receipt_json = JSON.stringify({ mid: op.platform_message_id, receipt_at: op.receipt_at });
        }
      });
      store.audit({
        event_id: null, conversation_id: exec.ref_id, customer_ref: null,
        proposed_action: 'CHECK_RECEIPT', validation: { attempt },
        execution_result: 'DONE_DELIVERED', receipt: { mid: op.platform_message_id }, stage: 'VERIFIED',
      });
      return { ok: true, resolved: true };
    }
    // chưa có bằng chứng delivery
    if (attempt >= 3) {
      const conv = store.findOne('conversations', c => c.conversation_id === exec.ref_id);
      store.transaction(() => {
        store.insert('dlq', {
          dlq_id: uid('dlq'), job_id: exec_id, kind: 'SEND_MESSAGE',
          payload_json: exec.idempotency_key, fail_reason: 'NO_RECEIPT_AFTER_3_CHECKS',
          alerted: 0, created_at: store.now(),
        });
        store.inc('dlq_count');
        // follow-up đang chờ receipt của exec này -> FAILED (BL-7: chỉ SENT khi có bằng chứng)
        const fu = store.findOne('follow_ups', f => f.exec_id === exec_id && f.status === 'PENDING_RECEIPT');
        if (fu) store.updateRow('follow_ups', fu, { status: 'FAILED', cancel_reason: 'receipt_timeout_dlq', updated_at: store.now() });
        // việc chết là gửi tin cho khách đang chờ -> human takeover (AI3 mục 7.4)
        if (conv && conv.mode !== 'HUMAN') {
          conv.mode = 'HUMAN';
          conv.human_agent = 'system';
          store.audit({
            event_id: null, conversation_id: conv.conversation_id, customer_ref: conv.customer_id,
            proposed_action: 'MODE_CHANGE',
            validation: { from: 'AI', to: 'HUMAN', actor: 'system', reason: 'send_timeout_no_receipt' },
            execution_result: 'MODE_HUMAN', receipt: null, stage: 'MODE',
          });
        }
      });
      if (conv) {
        this.needsHuman(conv, 'send_timeout_no_receipt', 'high');
        // P3C/BL-7: ACK_DLQ — chống dead-air, gửi ĐÚNG 1 lần qua whitelist template
        // (idem key dlq_ack:<exec_id>; utility mock-approved nên không vướng window).
        this.sendDlqAck(conv, exec_id);
      }
      store.audit({
        event_id: null, conversation_id: exec.ref_id, customer_ref: null,
        proposed_action: 'CHECK_RECEIPT', validation: { attempt },
        execution_result: 'DLQ_NO_RECEIPT', receipt: null, stage: 'FAILED',
      });
      return { ok: false, dlq: true };
    }
    this.scheduleCheckReceipt({ conversation_id: exec.ref_id }, exec_id, client_message_id, attempt + 1);
    return { ok: true, resolved: false, retry_scheduled: true };
  }

  // P3C/BL-7: ACK khi DLQ — chống dead-air. Scope idem key theo CONVERSATION (dlq_ack:<conv>):
  // mỗi hội thoại chỉ nhận ĐÚNG 1 tin ACK dù rơi DLQ nhiều lần (tránh bão ACK khi platform
  // hỏng kéo dài: ACK cũng timeout -> DLQ -> ACK...). Qua whitelist template ACK_DLQ
  // (actor=system, kind transactional — đi được cả mode HUMAN; utility mock-approved).
  sendDlqAck(conversation, execId) {
    void execId;
    const customer = this.store.findOne('customers', c => c.customer_id === conversation.customer_id);
    if (!customer) return null;
    try {
      const r = this.executeSend({
        conversation, customer, event: null,
        text: renderSystemTemplate('ACK_DLQ'), actor: 'system',
        actionLabel: 'DLQ_ACK', msgKind: 'transactional', templateId: 'ACK_DLQ', slot: 'DLQ_ACK',
        idemScope: `dlq_ack:${conversation.conversation_id}`,
      });
      if (!r.race_rejected && !r.duplicate) this.store.inc('dlq_ack_sent');
      return r;
    } catch (err) {
      this.store.audit({
        event_id: null, conversation_id: conversation.conversation_id, customer_ref: conversation.customer_id,
        proposed_action: 'DLQ_ACK', validation: { error: String(err && err.message) },
        execution_result: 'ACK_FAILED', receipt: null, stage: 'FAILED',
      });
      return null;
    }
  }

  // VERIFY cho SEND_MESSAGE — P3C/BL-5: accepted CHƯA PHẢI delivered. Không đọc receipt nào
  // ở đây (nền tảng thật không có API đọc trạng thái tin); bằng chứng chỉ đến qua webhook
  // (processReceiptEvent) hoặc job check_receipt đọc outbound_pending.
  verifySend({ conversation, send, actionLabel }) {
    const store = this.store;
    if (send.res.ok) {
      store.audit({
        event_id: null, conversation_id: conversation.conversation_id, customer_ref: null,
        proposed_action: actionLabel || 'SEND_MESSAGE', validation: { delivery_status: 'SENT_PENDING_RECEIPT', note: 'accepted — chờ webhook receipt' },
        execution_result: 'VERIFIED', receipt: { mid: send.res.mid || null }, stage: 'VERIFIED',
      });
      return { delivery_status: 'SENT_PENDING_RECEIPT', mid: send.res.mid || null, pending_receipt: true };
    }
    if (send.res.timeout) {
      store.audit({
        event_id: null, conversation_id: conversation.conversation_id, customer_ref: null,
        proposed_action: actionLabel || 'SEND_MESSAGE', validation: { delivery_status: 'SENT_PENDING_RECEIPT', note: 'timeout_unknown — chờ receipt, cấm blind resend' },
        execution_result: 'VERIFY_PENDING_TIMEOUT', receipt: null, stage: 'VERIFIED',
      });
      return { delivery_status: 'SENT_PENDING_RECEIPT', pending_receipt: true };
    }
    return { delivery_status: 'FAILED' };
  }

  // Tin của nhân viên (case 15/16): AUTHORIZE cho phép mode HUMAN khi actor là người.
  agentSend({ conversation, customer, text, operator }) {
    const store = this.store;
    store.audit({
      event_id: null, conversation_id: conversation.conversation_id, customer_ref: customer.customer_id,
      proposed_action: 'AGENT_SEND', validation: { operator }, execution_result: 'PROPOSED', receipt: null, stage: 'PROPOSED',
    });
    const auth = this.authorize({ conversation, customer, msgKind: 'ai_reply', actor: 'human_agent', actionType: 'AGENT_SEND' });
    if (!auth.ok) {
      store.inc(`gate_rejected_${auth.reason}`);
      return { sent: false, reason: auth.reason };
    }
    const send = this.executeSend({
      conversation, customer, event: null, text, actor: 'human_agent', actionLabel: `AGENT_SEND(${operator})`, msgKind: 'ai_reply',
      idemScope: `agent:${operator}:${uid('as')}`, // BL-9: mỗi lần nhân viên bắn là 1 side-effect riêng — không text-scoped
    });
    if (send.race_rejected) return { sent: false, reason: send.race_rejected };
    const verify = this.verifySend({ conversation, send, actionLabel: `AGENT_SEND(${operator})` });
    return { sent: true, ...verify };
  }

  // ================== CREATE ORDER (qua gate) ==================
  createOrder({ conversation, customer, event }) {
    const store = this.store;
    const draft = conversation.draft;
    const items = draft ? draft.items.filter(i => i.state !== 'stale' && i.qty > 0) : [];

    store.audit({
      event_id: event ? event.event_id : null, conversation_id: conversation.conversation_id,
      customer_ref: customer.customer_id, proposed_action: 'CREATE_ORDER',
      validation: null, execution_result: 'PROPOSED', receipt: null, stage: 'PROPOSED',
    });

    // 1) VALIDATE — field bắt buộc + tồn kho/giá FRESH đọc trong engine (cùng transaction)
    const missing = [];
    if (!items.length) missing.push('items');
    if (!(draft && draft.slots.name.value)) missing.push('name');
    if (!(draft && draft.slots.phone.value)) missing.push('phone');
    if (!(draft && draft.slots.address.value)) missing.push('address');

    const prpId = uid('prp');
    const prp = {
      proposal_id: prpId, conversation_id: conversation.conversation_id, turn_event_id: event ? event.event_id : null,
      turn_key: event ? `${event.event_id}:CREATE_ORDER` : null, // BL-9: retry cùng event không sinh row thứ 2
      intent: 'CREATE_ORDER', proposal_json: JSON.stringify({ items }),
      evidence_json: JSON.stringify({ slots: draft ? draft.slots : null }),
      confidence: missing.length ? 0.5 : 0.95, validation_json: null, decision: 'PENDING', created_at: store.now(),
    };
    const prpIns = store.insert('ai_proposals', prp);
    const prpRow = prpIns.duplicate ? prpIns.existing : prp;

    if (missing.length) {
      prpRow.decision = 'NEEDS_HUMAN';
      prpRow.validation_json = JSON.stringify({ missing });
      store.audit({
        event_id: event ? event.event_id : null, conversation_id: conversation.conversation_id,
        customer_ref: customer.customer_id, proposed_action: 'CREATE_ORDER',
        validation: { missing }, execution_result: 'VALIDATE_FAILED_MISSING_FIELDS', receipt: null, stage: 'VALIDATED',
      });
      return { ok: false, reason: 'MISSING_FIELDS', missing };
    }

    // 2) AUTHORIZE
    const auth = this.authorize({ conversation, customer, msgKind: 'transactional', actor: 'ai', actionType: 'CREATE_ORDER' });
    if (!auth.ok) {
      prp.decision = 'REJECTED_BY_GATE';
      store.inc(`gate_rejected_${auth.reason}`);
      store.audit({
        event_id: event ? event.event_id : null, conversation_id: conversation.conversation_id,
        customer_ref: customer.customer_id, proposed_action: 'CREATE_ORDER',
        validation: { decision: 'REJECT', reason: auth.reason }, execution_result: `REJECTED:${auth.reason}`, receipt: null, stage: 'AUTHORIZED',
      });
      return { ok: false, reason: auth.reason };
    }

    // 3) EXECUTE — order engine pha A (transaction + reserve)
    const result = this.orders.phaseA({ conversation, customer, items, eventId: event ? event.event_id : null });

    // 4) VERIFY — orders trong DB là nguồn trong nhà
    if (result.ok) {
      store.audit({
        event_id: event ? event.event_id : null, conversation_id: conversation.conversation_id,
        customer_ref: customer.customer_id, proposed_action: 'CREATE_ORDER',
        validation: { items, idempotency_key: result.order.idempotency_key },
        execution_result: 'DRAFT_CREATED', receipt: { order_id: result.order.order_id, status: 'DRAFT' }, stage: 'VERIFIED',
      });
      prpRow.decision = 'AUTO_EXECUTED';
      return { ok: true, order: result.order, idempotent: !!result.idempotent };
    }
    prpRow.decision = 'REJECTED_BY_GATE';
    prpRow.validation_json = JSON.stringify({ fail: result.reason, sku: result.sku });
    store.audit({
      event_id: event ? event.event_id : null, conversation_id: conversation.conversation_id,
      customer_ref: customer.customer_id, proposed_action: 'CREATE_ORDER',
      validation: { fail: result.reason, sku: result.sku }, execution_result: `FAILED:${result.reason}`, receipt: null, stage: 'FAILED',
    });
    return { ok: false, reason: result.reason, sku: result.sku, effective: result.effective };
  }

  // ================== CONFIRM ORDER (pha B qua gate) ==================
  confirmOrder({ conversation, customer, event }) {
    const store = this.store;
    const draft = conversation.draft;
    const orderId = draft && draft.order_id;
    store.audit({
      event_id: event ? event.event_id : null, conversation_id: conversation.conversation_id,
      customer_ref: customer.customer_id, proposed_action: 'CONFIRM_ORDER',
      validation: null, execution_result: 'PROPOSED', receipt: null, stage: 'PROPOSED',
    });
    if (!orderId) return { ok: false, reason: 'NO_DRAFT_ORDER' };

    const auth = this.authorize({ conversation, customer, msgKind: 'transactional', actor: 'ai', actionType: 'CONFIRM_ORDER' });
    if (!auth.ok) {
      store.inc(`gate_rejected_${auth.reason}`);
      store.audit({
        event_id: event ? event.event_id : null, conversation_id: conversation.conversation_id,
        customer_ref: customer.customer_id, proposed_action: 'CONFIRM_ORDER',
        validation: { decision: 'REJECT', reason: auth.reason }, execution_result: `REJECTED:${auth.reason}`, receipt: null, stage: 'AUTHORIZED',
      });
      return { ok: false, reason: auth.reason };
    }

    const result = this.orders.phaseB({ orderId, eventId: event ? event.event_id : null });
    if (result.ok) {
      store.audit({
        event_id: event ? event.event_id : null, conversation_id: conversation.conversation_id,
        customer_ref: customer.customer_id, proposed_action: 'CONFIRM_ORDER',
        validation: { order_id: orderId }, execution_result: 'CONFIRMED',
        receipt: { order_id: orderId, status: 'CONFIRMED', total: result.order.total }, stage: 'VERIFIED',
      });
      return { ok: true, order: store.findOne('orders', o => o.order_id === orderId) };
    }
    store.audit({
      event_id: event ? event.event_id : null, conversation_id: conversation.conversation_id,
      customer_ref: customer.customer_id, proposed_action: 'CONFIRM_ORDER',
      validation: { fail: result.reason, sku: result.sku }, execution_result: `FAILED:${result.reason}`, receipt: null, stage: 'FAILED',
    });
    return { ok: false, reason: result.reason, sku: result.sku, effective: result.effective };
  }

  // ================== FOLLOW-UP (case 17/18) ==================
  sendFollowUp({ followUp, conversation, customer }) {
    const store = this.store;
    const msgKind = followUp.kind === 'MARKETING' ? 'marketing' : 'care';
    // BL-8: follow-up là actor=system -> bắt buộc đi qua whitelist template;
    // text render TỪ bảng TRƯỚC authorize để authorize đối chiếu được.
    const templateId = followUp.kind === 'MARKETING' ? 'FOLLOW_UP_MARKETING' : 'FOLLOW_UP_CARE';
    const text = renderSystemTemplate(templateId);
    store.audit({
      event_id: null, conversation_id: conversation.conversation_id, customer_ref: customer.customer_id,
      proposed_action: `FOLLOW_UP:${followUp.kind}`, validation: null,
      execution_result: 'PROPOSED', receipt: null, stage: 'PROPOSED',
    });
    const auth = this.authorize({ conversation, customer, msgKind, actor: 'system', actionType: 'SEND_MESSAGE', templateId, renderedText: text });
    if (!auth.ok) {
      // BL-1/BL-2 (P3C): window đóng / quota thấp -> GIỮ lại (HELD, đợi khách nhắn lại / quota
      // hồi phục); takeover giữ nguyên hành vi P3A; lỗi cứng khác -> CANCELLED như trước.
      if (auth.reason === 'takeover' || auth.reason === 'fb_window_closed' || auth.reason === 'zalo_quota_low') {
        store.transaction(() => {
          store.updateRow('follow_ups', followUp, { status: 'HELD', cancel_reason: auth.reason });
        });
        store.audit({
          event_id: null, conversation_id: conversation.conversation_id, customer_ref: customer.customer_id,
          proposed_action: `FOLLOW_UP:${followUp.kind}`,
          validation: { decision: 'HOLD', reason: auth.reason, actor: 'system', mode: conversation.mode, template_id: templateId },
          execution_result: auth.reason === 'takeover' ? 'HELD_TAKEOVER' : (auth.reason === 'fb_window_closed' ? 'HELD_WINDOW' : 'HELD_QUOTA'),
          receipt: null, stage: 'AUTHORIZED',
        });
        return { sent: false, reason: auth.reason, held: true };
      }
      store.transaction(() => {
        store.updateRow('follow_ups', followUp, { status: 'CANCELLED', cancel_reason: auth.reason });
      });
      store.inc(`gate_rejected_${auth.reason}`);
      store.audit({
        event_id: null, conversation_id: conversation.conversation_id, customer_ref: customer.customer_id,
        proposed_action: `FOLLOW_UP:${followUp.kind}`, validation: { decision: 'REJECT', reason: auth.reason },
        execution_result: `REJECTED:${auth.reason}`, receipt: null, stage: 'AUTHORIZED',
      });
      return { sent: false, reason: auth.reason };
    }
    const send = this.executeSend({
      conversation, customer, event: null, text, actor: 'system',
      actionLabel: `FOLLOW_UP:${followUp.kind}`, msgKind,
      templateId, slot: templateId,
      idemScope: `follow_up:${followUp.follow_up_id}`, // BL-9: intent-scoped (BL-7), KHÔNG text-scoped
    });
    if (send.race_rejected) {
      // race (takeover/quota) giữa authorize và ghi message -> GIỮ lại như HOLD, không gửi
      store.transaction(() => {
        store.updateRow('follow_ups', followUp, { status: 'HELD', cancel_reason: send.race_rejected });
      });
      store.audit({
        event_id: null, conversation_id: conversation.conversation_id, customer_ref: customer.customer_id,
        proposed_action: `FOLLOW_UP:${followUp.kind}`,
        validation: { decision: 'HOLD', reason: send.race_rejected, race_recheck: true, actor: 'system', mode: conversation.mode, template_id: templateId },
        execution_result: send.race_rejected === 'takeover' ? 'HELD_TAKEOVER' : 'HELD_QUOTA', receipt: null, stage: 'AUTHORIZED',
      });
      return { sent: false, reason: send.race_rejected, held: true };
    }
    // BL-7 (P3C): CẤM đánh SENT vô điều kiện. Mapping theo BẰNG CHỨC:
    //   accepted (ok)            -> PENDING_RECEIPT (webhook receipt nâng lên SENT)
    //   TIMEOUT_UNKNOWN          -> PENDING_RECEIPT (job check_receipt quyết định sau)
    //   definite failure         -> FAILED + worklist
    //   (receipt về muộn         -> processReceiptEvent nâng PENDING_RECEIPT -> SENT)
    let fuStatus;
    if (send.res && send.res.ok) fuStatus = 'PENDING_RECEIPT';
    else if (send.res && send.res.timeout) fuStatus = 'PENDING_RECEIPT';
    else fuStatus = 'FAILED';
    store.transaction(() => {
      store.updateRow('follow_ups', followUp, {
        status: fuStatus, exec_id: send.exec_id,
        cancel_reason: fuStatus === 'FAILED' ? 'send_failed' : null,
      });
    });
    if (fuStatus === 'FAILED') {
      store.inc('follow_up_failed');
      this.needsHuman(conversation, 'follow_up_send_failed', 'normal');
    }
    store.audit({
      event_id: null, conversation_id: conversation.conversation_id, customer_ref: customer.customer_id,
      proposed_action: `FOLLOW_UP:${followUp.kind}`,
      validation: { follow_up_id: followUp.follow_up_id, status: fuStatus, idem_key: `send:${conversation.conversation_id}:follow_up:${followUp.follow_up_id}` },
      execution_result: fuStatus, receipt: null, stage: 'EXECUTED',
    });
    const verify = this.verifySend({ conversation, send, actionLabel: `FOLLOW_UP:${followUp.kind}` });
    return { sent: !!send.res.ok, status: fuStatus, exec_id: send.exec_id, duplicate: !!send.duplicate, ...verify };
  }

  // ================== BL-6: MONEY GUARD THEO SUBJECT (P3C) ==================
  // Whitelist tiền hợp lệ CHỈ từ evidence của subject/đơn/giỏ/khuyến mại đang nói:
  //   (1) mọi variant của sản phẩm ĐANG NÓI (conv.subject_sku -> product của nó);
  //   (2) variants trong proposal.facts (DB render cho chính reply này);
  //   (3) proposal.allowedMoney do caller nạp từ snapshot đơn (conversation-scoped);
  //   (4) snapshot MỌI đơn của conversation (total/subtotal/fee/line);
  //   (5) tổng mọi tổ hợp (subset sums) của giỏ hiện có + tổng kèm phí ship;
  //   (6) phí ship + ngưỡng khuyến mại có evidence (config mock dùng chung với engine).
  // Giá SP KHÁC trong catalogue KHÔNG còn làm whitelist cho subject hiện tại — nến thật
  // 185000, AI nói 145000 (giá trà) -> 145000 không có evidence -> OVERRIDE (probe 7).
  buildAllowedMoney(conversation, proposal) {
    const allowed = new Set();
    const add = v => {
      const n = Math.round(Number(v));
      if (Number.isFinite(n) && n > 0) allowed.add(n);
    };
    const factsVariants = (proposal && proposal.facts && proposal.facts.variants) || [];
    // (1) subject product variants
    const sku = conversation.subject_sku;
    if (sku) {
      const hit = this.productDB.getVariant(sku);
      if (hit) for (const v of hit.product.variants) add(v.price);
    }
    // (2) facts variants (evidence DB gắn kèm reply)
    for (const v of factsVariants) if (v && v.price !== undefined && v.price !== null) add(v.price);
    // (3) caller-napped evidence (orderMoney từ snapshot đơn — conversation-scoped)
    for (const v of (proposal && proposal.allowedMoney) || []) add(v);
    // (4) snapshot mọi đơn của conversation
    for (const o of this.store.findAll('orders', x => x.conversation_id === conversation.conversation_id)) {
      add(o.total); add(o.subtotal); add(o.shipping_fee);
      for (const l of JSON.parse(o.price_snapshot_json || '[]')) {
        add(l.unit_price); add(l.line_total); add(l.unit_price * l.qty);
      }
    }
    // (5) tổng mọi tổ hợp giỏ hiện có (cr-R2 R3-2 probe B1: tổng nhiều món KHÔNG phải bịa)
    const draft = conversation.draft;
    const cartLines = ((draft && draft.items) || [])
      .filter(i => i.state !== 'stale' && i.qty > 0)
      .map(i => {
        const hit = this.productDB.getVariant(i.sku);
        return hit ? hit.variant.price * i.qty : null;
      })
      .filter(x => x !== null && x > 0);
    // subset sums — cap tổ hợp (<= 12 dòng là đủ prototype; vượt thì chỉ tính dòng đơn + tổng)
    if (cartLines.length <= 12) {
      const sums = new Set([0]);
      for (const line of cartLines) {
        for (const s of [...sums]) sums.add(s + line);
      }
      for (const s of sums) { if (s > 0) add(s); add(s + MOCK_SHIPPING_FEE); }
    } else {
      for (const line of cartLines) add(line);
      add(cartLines.reduce((t, x) => t + x, 0));
    }
    // (6) phí ship + ngưỡng khuyến mại có evidence (probe B2/B3: fee 25000, freeship 500000)
    add(MOCK_SHIPPING_FEE);
    add(MOCK_PROMOTIONS.freeshipThresholdVnd);
    return allowed;
  }

  // BL-6 + cr-R2 R3-2: OVERRIDDEN chỉ thay ĐÚNG CÂU chứa số sai — câu đúng đi kèm giữ nguyên.
  // Câu chứa số sai được thay bằng câu render CHÍNH THỨC từ DB (renderValidated).
  replaceBadMoneySentences(proposal, badMoney) {
    const bad = new Set(badMoney);
    const render = this.renderValidated(proposal.intent, proposal.facts);
    const sentences = splitSentences(String(proposal.text || ''));
    if (!sentences.length) return render;
    const hasBad = seg => moneyValuesInText(seg).some(v => bad.has(v));
    const kept = sentences.filter(s => !hasBad(s));
    if (kept.length === sentences.length) return proposal.text; // không định vị được -> an toàn giữ render
    if (!kept.length) return render; // mọi câu đều sai -> thay cả tin bằng render DB
    return `${kept.join(' ')}\n${render}`;
  }

  // ================== render câu CHÍNH THỨC từ DB (khi phải đè lời AI) ==================
  renderValidated(intent, facts) {
    const variants = (facts && facts.variants) || [];
    const p = facts && facts.subjectProduct;
    if (intent === 'PRICE' && variants.length) {
      return `Dạ giá chính thức của ${p ? p.name : 'sản phẩm'} theo shop ạ:\n` +
        variants.map(v => `- size ${v.size}${v.color ? ' màu ' + v.color : ''}: ${fmtVND(v.price)}đ`).join('\n');
    }
    if (intent === 'VARIANT' && variants.length) {
      return `Dạ tình trạng ${p ? p.name : 'sản phẩm'} theo shop ạ:\n` +
        variants.map(v => `- size ${v.size}${v.color ? ' màu ' + v.color : ''}: ${v.effective > 0 ? `còn ${v.effective}` : 'hết hàng'} (${fmtVND(v.price)}đ)`).join('\n');
    }
    if (intent === 'STOCK' && variants.length) {
      const v = variants[0];
      return v.effective > 0
        ? `Dạ ${p.name} còn ${v.effective} cái ạ.`
        : `Dạ ${p.name} tạm hết hàng ạ.`;
    }
    return 'Dạ em xác nhận lại thông tin chính thức từ shop giúp anh/chị như sau, anh/chị xem giúp em nha ạ.';
  }
}

// ---- BL-6 helpers (module-level): tách câu + bóc số tiền gồm cả bare-number/k-scan ----
function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?…:])\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean);
}

// Bóc mọi "số tiền có thể" trong 1 câu — cùng ngữ nghĩa với scan ở sendReply
// (money có đơn vị / nhóm nghìn + bare 4–7 số >= 10000 + dạng k).
function moneyValuesInText(seg) {
  const out = [...extractMoney(seg)];
  let m;
  const reBare = /\b(\d{4,7})\b/g;
  while ((m = reBare.exec(seg)) !== null) {
    const v = parseInt(m[1], 10);
    if (v >= 10000) out.push(v);
  }
  const reK = /\b(\d{1,3}(?:[.,]\d{1,2})?)\s*k\b/gi;
  while ((m = reK.exec(seg)) !== null) {
    const v = Math.round(parseFloat(m[1].replace(',', '.')) * 1000);
    if (v >= 10000) out.push(v);
  }
  return out;
}

// SURI STABILITY (LỖI 2 — mitigation-b): tín hiệu khách ĐỔI Ý dùng cho stale-turn rejection.
// = RE.cancelOrder + RE.changeSubject của src/pipeline.js (chép nguyên văn — action-gate không
// import pipeline để tránh vòng phụ thuộc; 2 nơi phải giữ đồng bộ khi sửa).
const STALE_CHANGE_RE = /(huy don|hủy đơn|huy don hang|hủy đơn hàng|bo don|bỏ đơn|bo don hang|bỏ đơn hàng|khong mua nua|không mua nữa|doi y khong mua|đổi ý không mua|dat nham|đặt nhầm|cancel order|thoi lay|thôi lấy|doi sang|đổi sang|lay cai kia|lấy cái kia|doi y|đổi ý)/i;

module.exports = { ActionGate, SAFE_REPLIES };