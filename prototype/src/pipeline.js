'use strict';
// pipeline.js — bộ điều phối: event -> (understand) -> (propose) -> GATE -> hành động.
// Thứ tự tầng khớp AI3 mục 11: GW -> DED -> WRK -> AI -> GATE -> AUD.
// Pipeline là CODE máy (không phải LLM): trích slot, dựng FACTS mới nhất từ product-db, gọi AI stub
// lấy WORDING, rồi LUÔN đẩy qua Action Gate. Khách opt-out / khiếu nại / takeover xử lý theo policy.

const { normKey, extractPhone, fmtVND, redactPii } = require('./util');
const { mockVision, mockASR } = require('./media');
const { uid } = require('./util');
const { renderSystemTemplate } = require('./system-templates');
// AICAKE (G4): TÁCH REPLY MARKER + QUICK REPLY + BIẾN {{TenKhachHang}} (chuẩn aicake) —
// renderVars/splitReply là cấu phần THUẦN; pipeline wrap gate.sendReply ĐÚNG MỘT CHỖ
// (sendSplitReply dưới đây) để mọi reply có marker được tách thành N tin gửi lần lượt.
const { splitReply, renderVars, NAME_VAR } = require('./reply-markers');
// AICAKE (G2): TỰ ĐỘNG COMMENT & INBOX — phân loại/soạn câu comment (thuần, không đụng gate),
// helper ẩn comment của channel adapter Meta (mock lab — Phase-2 gọi Graph API), và công tắc
// settings shop (auto_reply_comment / hide_negative_comment / auto_inbox_from_comment).
const { classifyComment, negativeReply, positiveReply } = require('./comment-flow');
const { hideComment } = require('./channel/meta-adapter');
const { ShopSettings, COMMENT_FLOW_DEFAULTS } = require('./shop-settings');

const RE = {
  optOut: /(dung|đừng|khong|không).*(quang cao|quảng cáo|qc)|stop ?ads|khong nhan khuyen mai|không nhận khuyến (mãi|mại)/i,
  // P3B-4: TÁCH tín hiệu khiếu nại thành MẠNH/YẾU (trước đây 1 regex "dính chuỗi" mở claim
  // oan cho câu hỏi như "chưa thấy bảng size" — cross-review R3-3).
  //   MẠNH (luôn mở claim): lừa đảo / khiếu nại / đơn lỗi / hàng hỏng / giao sai / đổi-trả / bồi hoàn.
  //   YẾU  (chỉ mở claim khi NGỮ CẢNH CÓ ĐƠN đã đặt, hoặc bất mãn yếu LẶP LẠI >= 2 lần):
  //         chưa nhận được / chưa thấy / phiền phức / xấu / tệ.
  //   LƯU Ý: regex chạy trên normText (đã BỎ DẤU) — từ 1-2 ký tự bắt buộc \b để không dính
  //   'te' trong 'tet', 'xau' trong từ khác.
  complaintStrong: /(lua dao|lừa đảo|khieu nai|khiếu nại|don hang loi|đơn hàng lỗi|đơn bị lỗi|hang hong|hàng hỏng|hang loi|hàng lỗi|giao sai|giao thieu|giao thiếu|doi hang|đổi hàng|tra hang|trả hàng|boi hoan|bồi hoàn|hoan tien khong duoc|hoàn tiền không được)/i,
  complaintWeak: /(chua nhan duoc|chua thay|phen phuc|phien phuc|\bte\b|\bxau\b)/i,
  askHuman: /(cho (em )?gap|gặp người|người thật|nguoi that|chu shop oi|chủ shop ơi|bot a|bot à)/i,
  confirmOrder: /(xac nhan|xác nhận|confirm|chot luon|chốt luôn|dat hang|đặt hàng|ok lam|ok làm|dung roi|đúng rồi)/i,
  changeSubject: /(thoi lay|thôi lấy|doi sang|đổi sang|lay cai kia|lấy cái kia|doi y|đổi ý)/i,
  // P3B-5: ý định HUỶ ĐƠN ("quản lý đơn" theo contract; cross-review R3-7 — trước đây tin này bị nuốt).
  cancelOrder: /(huy don|hủy đơn|huy don hang|hủy đơn hàng|bo don|bỏ đơn|bo don hang|bỏ đơn hàng|khong mua nua|không mua nữa|doi y khong mua|đổi ý không mua|dat nham|đặt nhầm|cancel order)/i,
  price: /(gia|giá|bao nhieu|bao nhiêu|price|cost)/i,
  variant: /(size|mua|mau|màu|con khong|còn không|con hang|còn hàng|hết chưa|het chua)/i,
  buy: /(lay|lấy|mua|dat|đặt|chot|chốt|order|cho minh|cho mình|muon mua|muốn mua)/i,
  attrUnknown: /(be \d+ thang|bé \d+ tháng|do tuoi|độ tuổi|tre so sinh|trẻ sơ sinh|da nhay cam|da nhạy cảm|an toan cho|an toàn cho|phu nu co thai|phụ nữ có thai)/i,
  // P3B-3: qty CHỈ nhận khi số ĐI KÈM đơn vị (cai|hop|bo|...) — regex cũ `(số)(đơn vị?)` với nhóm
  // đơn vị OPTIONAL khiến MỌI số đầu đoạn trở thành qty (SĐT 0903123456 -> qty=903123456).
  // Số lượng giờ được bóc bằng Pipeline.extractQty() (đơn vị BẮT BUỘC / số ngắn cạnh động từ mua).
  qtyUnit: /(cai|cái|con|hop|hộp|bo|bộ|mon|món|sp|san pham|sản phẩm|combo|box|goi|gói|chai|lon|lọ|cay|cây|tui|túi|set|hop qua|hộp quà)/i,
  // SURI P2 (hạng mục 4): REPURCHASE THEO HISTORY (spec case 2) — khách cũ nhắn kiểu
  // "lấy thêm cái hôm trước". CHẶT để không nuốt intent cũ: cần CẢ (a) TÍN HIỆU LẶP/THÊM
  // và (b) THAM CHIẾU LỊCH SỬ; tin có nhắc SẢN PHẨM thì đã bị nhánh BUY bắt trước (items rỗng
  // mới tới đây). Regex chạy trên normText (đã bỏ dấu).
  repurchase: /(lay them|them cai|them mon|them hop|them combo|them lan|dat them|mua them|lay lai|dat lai|mua lai|lap lai|order lai|thêm lần)/,
  repurchaseHistory: /(hom truoc|lan truoc|lan cuoi|don cu|don truoc|don roi|nhu lan|nhu hom|giong hom|giong lan|cu roi|dia chi cu|lần như|hôm bữa|hom bua|bữa trước|bua truoc)/,
};

class Pipeline {
  constructor({ store, productDB, sessions, ai, gate, orders, takeover, carrier, clock }) {
    Object.assign(this, { store, productDB, sessions, ai, gate, orders, takeover, carrier, clock });
    this.lastResult = null;
    // SURI CLOSURE F2: thời gian chờ CÓ HẠN cho đường routeBuyItems trả Promise trong
    // routeRepurchase (hiện BUY_ASK luôn stub-sync nên bất khả thi — bẫy tiềm ẩn JEV LOW-2;
    // chuẩn bị cho tương lai BUY_ASK async). Vượt hạn mức -> fallback câu an toàn, không treo.
    this.repurchaseAwaitMs = 15000;
    // AICAKE (G4): TÁCH REPLY MARKER — pipeline là NƠI DUY NHẤT gọi gate.sendReply (đã grep
    // toàn repo), nên wrap ĐÚNG MỘT CHỖ tại đây: mọi reply (tư vấn AI, template, comment,
    // transactional) đều đi qua sendSplitReply -> renderVars -> splitReply. Reply cũ không
    // marker/không biến trả về đường gọi GỐC nguyên vẹn (no-op — regression 245 không đổi).
    if (this.gate && typeof this.gate.sendReply === 'function') {
      const sendReplyBase = this.gate.sendReply.bind(this.gate);
      this.gate.sendReply = (args) => this.sendSplitReply(args, sendReplyBase);
    }
  }

  // ---- AICAKE (G4): gửi reply sau renderVars + splitReply ----
  // 1 text (không marker)  -> 1 tin qua gate như cũ.
  // N khối (dòng ---)      -> N tin RIÊNG gửi LẦN LƯỚT, cùng conversation, CÙNG pattern
  //                           audit/transaction/idempotency của gate (slot phân biệt theo
  //                           phần: <slot>, <slot>:p2, ... — retry cùng event vẫn dedupe đúng).
  // quick/postback         -> mock adapter gửi text `[Nhãn]`; metadata quick_replies/postbacks
  //                           ghi lên message record (attachment_json) — render nút thật: Phase-2.
  // Gate chặn 1 phần (bot_off/takeover/quota/...) -> DỪNG, không gửi lố các phần sau.
  sendSplitReply({ conversation, customer, event, proposal }, sendReplyBase) {
    const raw = typeof proposal.text === 'string'
      ? proposal.text
      : (proposal.text === null || proposal.text === undefined ? '' : String(proposal.text));
    if (!raw) return sendReplyBase({ conversation, customer, event, proposal }); // text rỗng -> nguyên vẹn
    const hasVar = raw.indexOf(NAME_VAR) >= 0;
    const hasMarker = /^[ \t]*-{3,}[ \t]*$/m.test(raw) || /\[\[/.test(raw) || /\]\]/.test(raw);
    if (!hasVar && !hasMarker) {
      return sendReplyBase({ conversation, customer, event, proposal }); // NO-OP tuyệt đối với reply cũ
    }

    // Biến {{TenKhachHang}} -> tên khách (slot name đơn > full_name > display_name > 'bạn')
    const rendered = renderVars(raw, { tenKhachHang: this.customerDisplayName(conversation, customer) });
    const parts = splitReply(rendered);
    // 1 khối text thuần -> vẫn ĐÚNG 1 tin: text đã render biến thì gửi text mới,
    // giống hệt raw thì trả proposal gốc nguyên vẹn (byte-identical).
    if (parts.length === 1 && parts[0].kind === 'text') {
      if (parts[0].label === raw) return sendReplyBase({ conversation, customer, event, proposal });
      return sendReplyBase({
        conversation, customer, event,
        proposal: Object.assign({}, proposal, { text: parts[0].label }),
      });
    }

    const store = this.store;
    const convId = conversation.conversation_id;
    const outMsgs = () => store.findAll('messages', m => m.conversation_id === convId && m.direction === 'out');
    const baseSlot = proposal.slot || proposal.intent || 'reply';
    const results = [];
    let anySent = false;
    let needsHuman = false;
    let lastDecision = null;
    let lastDelivery = null;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const sendText = p.kind === 'text' ? p.label : `[${p.label}]`; // mock: nút -> text [Nhãn] (Phase-2 render nút)
      const meta = p.kind === 'quick'
        ? { quick_replies: [{ label: p.label, payload: p.payload }] }
        : (p.kind === 'postback' ? { postbacks: [{ label: p.label, payload: p.payload }] } : null);
      // tin out TRƯỚC khi gửi — để sau gửi tìm đúng message record mới sinh ra gắn metadata
      const knownIds = meta ? new Set(outMsgs().map(m => m.message_id)) : null;
      const r = sendReplyBase({
        conversation, customer, event,
        proposal: Object.assign({}, proposal, {
          text: sendText,
          slot: i === 0 ? baseSlot : `${baseSlot}:p${i + 1}`,
        }),
      });
      if (meta && r && r.sent) {
        // metadata quick/postback LÊN MESSAGE RECORD (attachment_json) — cùng transaction pattern
        const newRow = outMsgs().filter(m => !knownIds.has(m.message_id)).pop();
        if (newRow) store.transaction(() => store.updateRow('messages', newRow, { attachment_json: JSON.stringify(meta) }));
      }
      results.push(r);
      if (r && r.sent) { anySent = true; }
      if (r && r.needsHuman) needsHuman = true;
      if (r) {
        if (r.decision) lastDecision = r.decision;
        if (r.delivery_status) lastDelivery = r.delivery_status;
      }
      if (!r || !r.sent) break; // gate chặn phần này -> dừng (không gửi tiếp các phần sau)
    }
    return {
      sent: anySent, text: rendered, decision: lastDecision, needsHuman,
      delivery_status: lastDelivery, split: true, parts: results,
    };
  }

  handleEvent(event) {
    const store = this.store;
    const customer = this.sessions.ensureCustomer(event.channel, event.customer_ref, null);
    const threadId = event.conversation_id.split(':').slice(1).join(':');
    const conv = this.sessions.ensureConversation(event.channel, threadId, customer);
    conv.last_activity_at = store.now();

    if (event.type === 'opt_out_signal') {
      return this.handleOptOut(conv, customer, event);
    }

    // ---- tiền xử lý media (voice -> ASR; image -> vision) ----
    let text = event.payload.text || '';
    const kind = event.payload.kind || 'text';
    let fromAsr = false;
    let imageMatch = null;

    if (kind === 'voice' && event.payload.media) {
      const asr = mockASR(event.payload.media.platform_url);
      const att = [{ type: 'voice', platform_url: event.payload.media.platform_url, local_path: event.payload.media.local_path || null }];
      if (asr.ok) {
        text = asr.text;
        fromAsr = true;
        att[0].from_asr = true;
        att[0].asr_confidence = asr.confidence;
      } else {
        store.insert('messages', {
          message_id: uid('msg'), conversation_id: conv.conversation_id, direction: 'in', sender: 'customer',
          kind, text_content: null, attachment_json: JSON.stringify(att),
          platform_message_id: event.payload.platform_message_id, created_at: store.now(),
          delivery_status: null, receipt_json: null,
        });
        // ASR fail -> KHÔNG đoán (AI3 case 4)
        const proposal = { intent: 'VOICE_ASR_FAIL', text: null, needHuman: true, evidence: null, confidence: 0.1 };
        const r = this.gate.sendReply({ conversation: conv, customer, event, proposal });
        return { intent: 'VOICE_ASR_FAIL', suppressed: false, needsHuman: true, replies: [r] };
      }
      store.insert('messages', {
        message_id: uid('msg'), conversation_id: conv.conversation_id, direction: 'in', sender: 'customer',
        kind, text_content: text, attachment_json: JSON.stringify(att),
        platform_message_id: event.payload.platform_message_id, created_at: store.now(),
        delivery_status: null, receipt_json: null,
      });
    } else if (kind === 'image' && event.payload.media) {
      store.insert('messages', {
        message_id: uid('msg'), conversation_id: conv.conversation_id, direction: 'in', sender: 'customer',
        kind, text_content: text || null,
        attachment_json: JSON.stringify([{ type: 'image', platform_url: event.payload.media.platform_url, local_path: event.payload.media.local_path }]),
        platform_message_id: event.payload.platform_message_id, created_at: store.now(),
        delivery_status: null, receipt_json: null,
      });
      imageMatch = mockVision(event.payload.media.platform_url);
    } else {
      store.insert('messages', {
        message_id: uid('msg'), conversation_id: conv.conversation_id, direction: 'in', sender: 'customer',
        kind, text_content: text || null, attachment_json: null,
        platform_message_id: event.payload.platform_message_id, created_at: store.now(),
        delivery_status: null, receipt_json: null,
      });
    }

    const normText = normKey(text);

    // ---- AICAKE (G2): TỰ ĐỘNG COMMENT & INBOX (origin === 'comment') ----
    // Comment FB có HÀNH VI RIÊNG theo chuẩn aicake: tự trả lời bình luận, ẩn comment tiêu
    // cực và inbox khách từ comment. Mọi REPLY vẫn đi QUA ACTION GATE như tin thường
    // (không có path riêng bỏ qua gate); giá/tồn CHỈ từ ProductDB qua luồng tư vấn hiện có.
    const commentPlan = this.commentPlan(conv, customer, event, text, normText);
    if (commentPlan && commentPlan.handled) return commentPlan.result;

    // ---- tín hiệu opt-out (case 18) ----
    if (RE.optOut.test(text) || RE.optOut.test(normText)) {
      return this.handleOptOut(conv, customer, event);
    }
    // ---- khiếu nại (case 13) — P3B-4: CHỈ mở claim khi tín hiệu RÕ ----
    const complaintLevel = this.classifyComplaint(normText);
    if (complaintLevel === 'strong') {
      return this.handleComplaint(conv, customer, event, text);
    }
    if (complaintLevel === 'weak') {
      // Tín hiệu yếu ("chưa thấy", "xấu"...): chỉ claim khi NGỮ CẢNH CÓ ĐƠN đã đặt,
      // hoặc khách bày tỏ bất mãn yếu LẶP LẠI (>= 2 lần). Câu hỏi tiêu cực nhẹ -> KHÔNG claim,
      // tin đi luồng thường (AI vẫn trả lời) — cross-review R3-3.
      conv.soft_complaint_count = (conv.soft_complaint_count || 0) + 1;
      if (this.convHasPlacedOrder(conv) || conv.soft_complaint_count >= 2) {
        return this.handleComplaint(conv, customer, event, text);
      }
    }
    // ---- khách đòi người thật (AI2 6.2.2) ----
    if (RE.askHuman.test(normText)) {
      this.takeover.setTakeover(conv, 'system', 'customer_request');
      // BL-8: ACK system ĐI QUA WHITELIST TEMPLATE (trước đây là text tự do + actor=system + ai_reply
      // — đúng vector BL-8). kind transactional, render từ SYSTEM_TEMPLATES, có template_id trong audit.
      const proposal = {
        intent: 'ASK_HUMAN', msgKind: 'transactional', sender: 'system', template_id: 'ASK_HUMAN_ACK',
        text: renderSystemTemplate('ASK_HUMAN_ACK'),
        evidence: { policy: 'ask_human', template_id: 'ASK_HUMAN_ACK' }, confidence: 0.9,
      };
      const r = this.gate.sendReply({ conversation: conv, customer, event, proposal });
      return { intent: 'ASK_HUMAN', suppressed: false, replies: [r] };
    }

    // ---- P3C/BL-1: khách NHẮN LẠI = cửa sổ 24h mở lại -> kích hoạt lại follow-up bị HELD
    // vì ngoài window ("đợi khách nhắn lại" — điều kiện đóng BL-1 của V2). Follow-up HELD vì
    // takeover/quota KHÔNG đụng (luồng riêng của takeover/handback). ----
    this.rescheduleWindowHeldFollowUps(conv);

    // ---- mode HUMAN: AI KHÔNG auto-send (case 15) — chỉ lưu + soạn nháp gợi ý ----
    if (conv.mode === 'HUMAN') {
      const intent = this.detectIntent(normText, conv);
      // P3B-4 (cr-R3 R2-M3): VẪN fillSlots trong mode HUMAN — bot ghi nhận thông tin khách
      // vào session (nhân viên thấy, handback không phải hỏi lại), nhưng KHÔNG auto-send
      // (INV-5 — Gate A A3 phải tiếp tục PASS: mọi send của AI trong HUMAN vẫn bị gate khoá).
      this.fillSlots(conv, customer, text);
      store.insert('ai_proposals', {
        proposal_id: uid('prp'), conversation_id: conv.conversation_id, turn_event_id: event.event_id,
        turn_key: `${event.event_id}:DRAFT_NOTE`, // BL-9: retry cùng event không sinh nháp thứ 2
        intent, proposal_json: JSON.stringify({ note: 'draft suggestion cho nhân viên, KHÔNG tự gửi' }),
        evidence_json: null, confidence: null, validation_json: null,
        decision: 'HOLD_FOR_AGENT', created_at: store.now(),
      });
      this.takeover.pushWorklist(conv, 'message_while_human_mode', 'normal');
      this.lastResult = { intent, suppressed: true, replies: [] };
      return this.lastResult;
    }

    // ---- UNDERSTAND: intent + slot filling + FACTS mới nhất ----
    let intent = this.detectIntent(normText, conv);

    // cập nhật slot từ tin bất kỳ (khách rải info nhiều tin — AI2 2.3)
    this.fillSlots(conv, customer, text);

    // Ảnh đi luồng vision riêng (match variant từ ảnh), không dùng intent của text/caption
    if (kind === 'image') {
      return this.routeImage(conv, customer, event, text, imageMatch);
    }

    // Khách đang trong luồng thu thập đơn: tin tiếp theo (kể cả không nhắc SP) là tiếp tục draft
    if (
      conv.state === 'COLLECT_ORDER' && conv.draft && (conv.draft.items || []).length &&
      ['CHITCHAT', 'PRICE', 'VARIANT'].includes(intent)
    ) {
      intent = 'BUY';
    }

    // AICAKE (G2): switch giữ NGUYÊN hành vi cũ — chỉ bắt kết quả lại để comment có ý định
    // mua còn ĐẨY KHÁCH VÀO INBOX sau khi đã tư vấn/trả lời công khai (pushInboxFromComment).
    let result;
    switch (intent) {
      case 'PRICE': result = this.routeInfo(conv, customer, event, text, 'PRICE'); break;
      case 'VARIANT': result = this.routeInfo(conv, customer, event, text, 'VARIANT'); break;
      case 'CONFIRM_ORDER': result = this.routeConfirm(conv, customer, event); break;
      case 'CHANGE_SUBJECT': result = this.routeChangeSubject(conv, customer, event, text); break;
      case 'BUY': result = this.routeBuy(conv, customer, event, text); break;
      case 'CANCEL_ORDER': result = this.routeCancel(conv, customer, event, text); break;
      // SURI P2 (hạng mục 4): khách cũ "lấy thêm cái hôm trước" — đọc đơn gần nhất của
      // conversation, đề xuất lại ĐÚNG sản phẩm/số lượng cũ (từ DB, không đoán SKU).
      case 'REPURCHASE': result = this.routeRepurchase(conv, customer, event, text); break;
      case 'ATTR_UNKNOWN': result = this.routeInfo(conv, customer, event, text, 'ATTR_UNKNOWN'); break;
      // AICAKE SOUL: truyền text cho chit-chat — persona đọc câu khách để chọn lời vui vẻ
      default: result = this.routeChitchat(conv, customer, event, text);
    }
    if (commentPlan && commentPlan.inboxAfter) {
      return this._then(result, r => this.pushInboxFromComment(conv, customer, event, commentPlan.cctx, text, r));
    }
    return result;
  }

  // ================= UNDERSTAND helpers =================

  // BL-3 (P3A): ctx DUY NHẤT được phép đưa vào model. KHÔNG truyền object conv / customer /
  // draft.slots (phone/address/name) / token. Chỉ: { state, mode, subject_sku } + text ĐÃ
  // redactPii + normText (từ text đã redact) + FACTS do caller dựng từ product-db.
  // Action cần PII (tạo đơn, ship) lấy từ DB bằng ID ở tầng deterministic (gate/engine) — LLM không thấy PII.
  modelCtx(conv, text) {
    const t = redactPii(String(text || ''));
    return { state: conv.state, mode: conv.mode, subject_sku: conv.subject_sku || null, text: t, normText: normKey(t) };
  }

  // ================= P3C/BL-1: kích hoạt lại follow-up HELD vì hết window =================
  // Khách nhắn lại -> window 24h mở lại -> follow-up care/marketing bị HELD (fb_window_closed)
  // quay về SCHEDULED; scheduler chạy ngay vì scheduled_at đã trong quá khứ. Nếu window vẫn
  // không đủ (vd khách nhắn trong HUMAN) -> gate sẽ HELD lại — không có đường lách.
  rescheduleWindowHeldFollowUps(conv) {
    const held = this.store.findAll('follow_ups', f =>
      f.conversation_id === conv.conversation_id &&
      f.status === 'HELD' && f.cancel_reason === 'fb_window_closed');
    for (const f of held) this.store.updateRow('follow_ups', f, { status: 'SCHEDULED', cancel_reason: null });
    return held.length;
  }

  // ================= P3B-4: phân loại tín hiệu khiếu nại =================
  // 'strong' — từ khoá khiếu nại RÕ (lừa đảo/khiếu nại/đơn lỗi/hàng hỏng/giao sai/đổi-trả/bồi hoàn)
  //            -> LUÔN mở claim.
  // 'weak'   — câu tiêu cực nhẹ (chưa thấy/chưa nhận được/xấu/tệ/phền phức) -> CHỈ claim khi
  //            ngữ cảnh CÓ ĐƠN đã đặt (caller check convHasPlacedOrder) hoặc lặp lại >= 2 lần.
  classifyComplaint(normText) {
    if (RE.complaintStrong.test(normText)) return 'strong';
    if (RE.complaintWeak.test(normText)) return 'weak';
    return 'none';
  }

  // Ngữ cảnh "có đơn" = hội thoại đã có đơn ĐẶT THẬT (đã chốt/giao) — draft chưa chốt không tính.
  convHasPlacedOrder(conv) {
    return this.store.findAll('orders', o =>
      o.conversation_id === conv.conversation_id &&
      ['CONFIRMED', 'DELIVERED', 'CANCEL_PENDING'].includes(o.status)).length > 0;
  }

  detectIntent(normText, conv) {
    // P3B-5: hủy đơn phải được nhận TRƯỚC changeSubject ("đổi ý không mua" chứa "đổi ý")
    if (RE.cancelOrder.test(normText)) return 'CANCEL_ORDER';
    if (RE.confirmOrder.test(normText) && conv.state === 'CONFIRM') return 'CONFIRM_ORDER';
    if (RE.changeSubject.test(normText)) return 'CHANGE_SUBJECT';
    if (RE.attrUnknown.test(normText)) return 'ATTR_UNKNOWN';
    if (RE.buy.test(normText) && this.extractItems(normText).length) return 'BUY';
    // SURI P2 (hạng mục 4): REPURCHASE đặt TRƯỚC price/variant — "mua thêm như hôm trước" chứa
    // "mua" (dính variant regex cũ) phải đi luồng mua lại; tin nhắc SP đã bị nhánh BUY bắt ở trên.
    if (RE.repurchase.test(normText) && RE.repurchaseHistory.test(normText) && !this.extractItems(normText).length) return 'REPURCHASE';
    if (RE.price.test(normText)) return 'PRICE';
    if (RE.variant.test(normText) && (normText.includes('size') || normText.includes('mau'))) return 'VARIANT';
    if (RE.variant.test(normText)) return 'VARIANT';
    return 'CHITCHAT';
  }

  // ================= P3B-3: QTY EXTRACTION (SĐT KHÔNG BAO GIỜ là qty) =================
  // Quy tắc (đề bài P3B hạng mục 3):
  //   (0) Số khớp SĐT VN (đầu 0/84) hoặc số dài >= 9 chữ số -> LUÔN bị loại trước (mask) —
  //       không bao giờ thành qty dù có đơn vị đứng cạnh (bug cũ: qty=903123456).
  //   (a) qty nhận khi số (1-2 chữ số, <= 99) CÓ ĐƠN VỊ rõ ngay cạnh (cai|hop|bo|mon|sp|combo|box|gói…);
  //   (b) hoặc số ngắn (<= 99) ĐỨNG NGAY SAU động từ đặt/mua/lấy;
  //   (c) hoặc số ngắn đứng NGAY TRƯỚC tên sản phẩm trong đoạn ("3 trà hoa sấy");
  //   còn lại -> mặc định 1 (tầng trên hỏi lại/xác nhận với khách).
  extractQty(seg, product) {
    let s = String(seg || '');
    // (0) mask SĐT / số dài TRƯỚC KHI xét qty — chống cả việc "456 hop" (3 số cuối SĐT) trúng đơn vị
    s = s.replace(/(?:\+?84|0)(?:3|5|7|8|9)(?:[.\-\s]?\d){7,9}(?!\d)/gi, ' sdt ');
    s = s.replace(/(?<!\d)\d{9,}(?!\d)/g, ' sdt ');
    const unit = String(RE.qtyUnit.source).replace(/^\(/, '').replace(/\)$/i, '');
    const tail = '(?![a-z0-9à-ỹ])'; // biên phải chịu được ký tự tiếng Việt ('bộ ' — \b của ASCII không đúng)
    // (a) số + ĐƠN VỊ ngay cạnh (cả 2 thứ tự "2 hộp" / "hộp 2"); lookbehind chặn trúng 3 số cuối số dài
    let m = s.match(new RegExp(`(?<!\\d)(\\d{1,2})\\s*(?:${unit})${tail}`, 'i'))
         || s.match(new RegExp(`(?:${unit})\\s*:?\\s*(?<!\\d)(\\d{1,2})(?!\\d)`, 'i'));
    if (m) {
      const v = parseInt(m[1], 10);
      if (v >= 1 && v <= 99) return v;
    }
    // (b) số ngắn đứng ngay sau động từ đặt/mua/lấy (vd "lấy 2 nến vanilla")
    m = s.match(/\b(?:lay|lấy|mua|dat|đặt|chot|chốt|order|cho|muon|muốn)\s+(?<!\d)(\d{1,2})(?!\d)\s+(?=[a-zà-ỹ])/i);
    if (m) {
      const v = parseInt(m[1], 10);
      if (v >= 1 && v <= 99) return v;
    }
    // (c) số ngắn đứng NGAY TRƯỚC tên/alias sản phẩm (vd "3 trà hoa sấy", "1 nến vanilla")
    if (product) {
      const low = normKey(s); // so trên nền đã bỏ dấu — alias trong DB cũng lưu dạng normKey
      const names = [normKey(product.name), ...(product.aliases || []).map(normKey)].filter(a => a.length >= 4);
      for (const a of names) {
        const idx = low.indexOf(a);
        if (idx < 0) continue;
        const before = low.slice(Math.max(0, idx - 4), idx); // cửa sổ nhỏ NGAY trước tên SP
        const m2 = before.match(/(?<!\d)(\d{1,2})\s*$/);
        if (m2) {
          const v = parseInt(m2[1], 10);
          if (v >= 1 && v <= 99) return v;
        }
      }
    }
    return 1; // mặc định 1 — không đoán số lớn
  }

  fillSlots(conv, customer, text) {
    const phone = extractPhone(text);
    if (phone) {
      this.sessions.setSlot(conv, 'phone', phone, 'confirmed'); // regex VN pass -> confirmed
      customer.phone = phone;
    }
    const nameM = text.match(/(?:tên|ten|mình là|minh la|tôi là|toi la)\s+([A-ZÀ-Ỹa-zà-ỹ][A-Za-zÀ-ỹà-ỹ ]{1,30}?)(?=\s*(?:,|\.|sdt|số điện thoại|so dien thoai|địa chỉ|dia chi|$))/i);
    if (nameM) this.sessions.setSlot(conv, 'name', nameM[1].trim(), 'detected');
    const addrM = text.match(/(?:địa chỉ|dia chi|giao đến|giao den|giao tới|giao toi|giao hàng tại|giao hang tai)\s*[:\-]?\s*(.+)$/i);
    if (addrM) this.sessions.setSlot(conv, 'address', addrM[1].trim(), 'detected');
  }

  // Bóc giỏ hàng: tách đoạn theo dấu phẩy/"và", match product, qty theo extractQty (P3B-3).
  extractItems(text) {
    const segments = String(text).split(/,| và | va |\+/i).map(s => s.trim()).filter(Boolean);
    const items = [];
    for (const seg of segments) {
      const { matches } = this.productDB.searchProduct(seg);
      if (!matches.length) continue;
      const m = matches[0];
      const resolved = this.resolveVariant(m.product, seg);
      // [ZCode-approved Phase UI fix] SP đa variant khách chưa nói size/màu — KHÔNG bỏ item
      // (bug cũ: extractItems rỗng → Buy intent bị nuốt → khách nhận fallback "chưa đủ dữ liệu").
      // Đánh dấu ambiguous để routeBuy hỏi chọn variant từ FACTS (không bịa giá/tồn).
      if (resolved && resolved.ambiguous) {
        items.push({
          ambiguous: true,
          options: resolved.options,
          qty: this.extractQty(seg, m.product),
          name: m.product.name,
          product_id: m.product.product_id || m.product.id,
        });
        continue;
      }
      if (!resolved || !resolved.sku) continue;
      const qty = this.extractQty(seg, m.product);
      items.push({ sku: resolved.sku, qty: Number.isNaN(qty) || qty < 1 ? 1 : qty, name: m.product.name });
    }
    return items;
  }

  resolveVariant(product, segText) {
    const vs = product.variants;
    if (vs.length === 1) return { sku: vs[0].sku };
    const s = normKey(segText);
    let candidates = vs;
    const sizeM = s.match(/\bsize\s*([smlxl])\b|\b([sml])\b/);
    if (sizeM) {
      const size = (sizeM[1] || sizeM[2]).toUpperCase();
      const bySize = candidates.filter(v => v.size.toUpperCase() === size);
      if (bySize.length) candidates = bySize;
    }
    const colorMap = { do: 'đỏ', den: 'đen', xanh: 'xanh', trang: 'trắng', tim: 'tím', vang: 'vàng' };
    for (const key of Object.keys(colorMap)) {
      if (new RegExp(`\\b${key}\\b`).test(s)) {
        const byColor = candidates.filter(v => normKey(v.color || '') === normKey(colorMap[key]));
        if (byColor.length) candidates = byColor;
        break;
      }
    }
    if (candidates.length === 1) return { sku: candidates[0].sku };
    return { sku: null, ambiguous: true, options: candidates.map(v => ({ sku: v.sku, size: v.size, color: v.color })) };
  }

  // FACTS: LUÔN dựng mới từ product-db tại thời điểm này (fresh read)
  buildFacts(conv, text) {
    const sku = conv.subject_sku;
    if (!sku) return { subjectProduct: null, variants: [] };
    const hit = this.productDB.getVariant(sku);
    if (!hit) return { subjectProduct: null, variants: [] };
    const facts = {
      subjectProduct: hit.product,
      variants: hit.product.variants.map(v => ({
        sku: v.sku, size: v.size, color: v.color, price: v.price,
        effective: this.productDB.effectiveStock(v.sku), // tồn hiệu dụng = qty - reserved
      })),
    };
    void text;
    return facts;
  }

  // ================= ROUTES =================
  // SURI ASYNC (LỖI 2): helper tiếp diễn cho kết quả propose — propose trả GIÁ TRỊ THƯỜNG
  // (stub hoặc httpFn sync tiêm vào — regression cũ, chạy SYNC NGUYÊN TRẠNG, không sinh
  // microtask) HOẶC PROMISE (đường LLM production qua httpOnceAsync). Trong cả hai trường
  // hợp phần TIẾP DIỄN là ĐÚNG code cũ (0 dòng logic đổi) — chỉ bọc lại điểm gọi.
  _then(pr, cont) {
    return (pr && typeof pr.then === 'function') ? pr.then(cont) : cont(pr);
  }

  // ================= SURI CLOSURE F1 (JEV LOW-1): FACTS STALE LÚC LLM CHỜ =================
  // Đường LLM async (SURI ASYNC) propose với FACTS chụp LÚC propose; khi LLM trả lời muộn,
  // giá/tồn/trạng thái SP trong product-db CÓ THỂ đã đổi — lời tư vấn dựng trên snapshot cũ
  // là SAI (money guard chỉ đè SỐ SAU, và render của nó vẫn từ snapshot cũ).
  // Guard: so snapshot với DB TƯƠI NGAY TRƯỚC KHI GỬI. Lệch khi:
  //   (a) giá 1 variant subject đổi, (b) tồn 1 variant subject đổi còn-hàng -> hết-hàng,
  //   (c) subject bị tắt (enabled=false / biến mất). KHÔNG lệch -> trả ĐÚNG shape cũ
  // (sync-path stub không thể lệch — propose + gửi trong cùng tick). Có lệch -> KHÔNG gửi
  // lời cũ: thay bằng câu render CHÍNH THỨC từ DB TƯƠI (cùng cơ chế render của gate:
  // gate.renderValidated) hoặc câu an toàn + NEEDS_HUMAN khi không render được (SP tắt,
  // intent ngoài PRICE/VARIANT/STOCK). Khách KHÔNG BAO GIỜ nhận con số hết hiệu lực.
  _factsDrift(snapshot) {
    if (!snapshot || !snapshot.subjectProduct || !snapshot.subjectProduct.product_id) return null;
    const fresh = this.productDB.getProduct(snapshot.subjectProduct.product_id);
    if (!fresh || fresh.enabled === false) return 'subject_disabled_or_gone';
    for (const sv of (snapshot.variants || [])) {
      const fv = fresh.variants.find(x => x.sku === sv.sku);
      if (!fv) return 'variant_missing';
      if (Number(fv.price) !== Number(sv.price)) return 'price_changed';
      if (Number(sv.effective) > 0 && this.productDB.effectiveStock(sv.sku) <= 0) return 'stock_out';
    }
    return null;
  }

  _freshFactsReply(proposal, conv, snapshotFacts) {
    const drift = this._factsDrift(snapshotFacts);
    if (!drift) return { ...proposal, facts: snapshotFacts, msgKind: 'ai_reply' };
    void conv;
    const prod = this.productDB.getProduct(snapshotFacts.subjectProduct.product_id);
    const facts = prod ? {
      subjectProduct: prod,
      variants: prod.variants.map(v => ({
        sku: v.sku, size: v.size, color: v.color, price: v.price,
        effective: this.productDB.effectiveStock(v.sku), // tồn hiệu dụng = qty - reserved
      })),
    } : snapshotFacts;
    const evidence = { source: 'product_db', facts_superseded: drift };
    if (drift === 'subject_disabled_or_gone' || !['PRICE', 'VARIANT', 'STOCK'].includes(proposal.intent)) {
      // Lệch lớn / không render được câu tư vấn -> câu an toàn + NEEDS_HUMAN (gate tự đưa
      // lên worklist qua cờ needHuman như các case low-evidence hiện có).
      return {
        intent: proposal.intent, msgKind: 'ai_reply',
        text: 'Dạ tình trạng/mức giá vừa được shop cập nhật lại, anh/chị cho em xin vài phút kiểm tra chính xác ạ.',
        evidence, confidence: 0.9, needHuman: true, facts,
      };
    }
    // Còn render được -> câu CHÍNH THỨC dựng từ DB TƯƠI (số luôn khớp whitelist money guard).
    return {
      intent: proposal.intent, msgKind: 'ai_reply',
      text: this.gate.renderValidated(proposal.intent, facts),
      evidence, confidence: 0.9, facts,
    };
  }

  routeInfo(conv, customer, event, text, intent) {
    // [ZCode-approved Phase UI fix] khách trả lời chọn variant khi đang awaiting → resolve rồi
    // quay về luồng mua (routeBuyItems) — không loop hỏi lại vô hạn, không rơi fallback.
    if (conv.awaiting_variant && conv.awaiting_variant.subject_sku) {
      const hit = this.productDB.getVariant(conv.awaiting_variant.subject_sku);
      if (hit) {
        const resolved = this.resolveVariant(hit.product, text);
        if (resolved && resolved.sku) {
          conv.awaiting_variant = null;
          conv.subject_sku = resolved.sku;
          const qty = conv.pending_qty || 1;
          conv.pending_qty = null;
          return this.routeBuyItems(conv, customer, event, text, [
            { sku: resolved.sku, qty, name: hit.product.name },
          ]);
        }
      }
    }
    // xác định subject từ text nếu chưa có
    const { matches } = this.productDB.searchProduct(text);
    if (matches.length && intent !== 'ATTR_UNKNOWN') {
      conv.subject_sku = (matches[0].variant && matches[0].variant.sku) || matches[0].product.variants[0].sku;
    }
    const facts = this.buildFacts(conv, text);
    // BL-3: model chỉ nhận ctx trắng + FACTS — KHÔNG conv nguyên vẹn (trước đây truyền conv, rò PII)
    // SURI ASYNC: propose trả giá trị | Promise — tiếp diễn qua _then (code giữ nguyên).
    return this._then(this.ai.propose(intent, { ...this.modelCtx(conv, text), facts }), proposal => {
      // facts gắn kèm proposal để gate render lại câu CHÍNH THỨC từ DB khi phải đè lời AI (case 8)
      // SURI CLOSURE F1: _freshFactsReply so FACTS snapshot với DB tươi NGAY LÚC GỬI — lệch thì
      // thay lời cũ bằng render từ DB tươi (hoặc câu an toàn) — không gửi tư vấn hết hiệu lực.
      const r = this.gate.sendReply({ conversation: conv, customer, event, proposal: this._freshFactsReply(proposal, conv, facts) });
      if (r.sent) {
        if (conv.state === 'NEW_LEAD' || conv.state === 'DISCOVERY') this.sessions.transition(conv, 'PRODUCT_QA', 'product_question');
      }
      return { intent, suppressed: false, needsHuman: !!r.needsHuman, replies: [r] };
    });
  }

  routeImage(conv, customer, event, text, imageMatch) {
    // [Supervisor-approved PRODUCT-READY đợt 2 exception — CHANGE REQUEST số 1 của đợt 1]
    // SP tắt (p.enabled === false — soft-delete/ẩn khỏi bán) KHÔNG được match qua đường ẢNH,
    // giống đúng chính sách đường TEXT (product-db.searchProduct đã lọc ở cả 4 lớp).
    // getVariant() giữ nguyên hành vi (đơn cũ vẫn đọc được) — chỉ chặn ở ĐIỂM TẠO subject mới.
    const matchedVariant = imageMatch && imageMatch.sku ? this.productDB.getVariant(imageMatch.sku) : null;
    const matchDisabled = !!(matchedVariant && matchedVariant.product.enabled === false);
    if (imageMatch && imageMatch.sku && imageMatch.score >= 0.6 && !matchDisabled) {
      conv.subject_sku = imageMatch.sku;
      const facts = this.buildFacts(conv, text);
      const v = facts.variants.find(x => x.sku === imageMatch.sku) || facts.variants[0];
      // SURI ASYNC: tiếp diễn qua _then (propose giá trị | Promise — code giữ nguyên).
      return this._then(this.ai.propose('STOCK', { ...this.modelCtx(conv, text), facts: { subjectProduct: facts.subjectProduct, variants: [v] } }), proposal => {
        proposal.evidence = { matched_variant_id: imageMatch.sku, vision_score: imageMatch.score, source: 'product_db' };
        // SURI CLOSURE F1: guard facts tươi trước khi gửi (cùng cơ chế với routeInfo).
        const r = this.gate.sendReply({ conversation: conv, customer, event, proposal: this._freshFactsReply(proposal, conv, facts) });
        if (r.sent) this.sessions.transition(conv, 'PRODUCT_QA', 'image_question');
        return { intent: 'IMAGE_STOCK', suppressed: false, replies: [r] };
      });
    }
    // match yếu HOẶC SP đã tắt -> NEEDS_HUMAN, KHÔNG tự trả (AI3 case 3)
    const proposal = {
      intent: 'IMAGE_MATCH_LOW', text: null, needHuman: true,
      evidence: imageMatch ? { vision_score: imageMatch.score, product_disabled: matchDisabled || undefined } : null,
      confidence: imageMatch ? imageMatch.score : 0,
    };
    const r = this.gate.sendReply({ conversation: conv, customer, event, proposal: { ...proposal, msgKind: 'ai_reply' } });
    return { intent: 'IMAGE_MATCH_LOW', suppressed: false, needsHuman: true, replies: [r] };
  }

  routeBuy(conv, customer, event, text) {
    let items = this.extractItems(text);
    // [ZCode-approved Phase UI fix] khách đang TRẢ LỜI chọn variant → resolve size/màu từ tin
    // hiện tại rồi đi tiếp luồng mua với item đã rõ SKU (đủ INV: mọi lối đi qua routeBuyItems).
    if (conv.awaiting_variant && conv.awaiting_variant.subject_sku) {
      const hit = this.productDB.getVariant(conv.awaiting_variant.subject_sku);
      if (hit) {
        const resolved = this.resolveVariant(hit.product, text);
        if (resolved && resolved.sku) {
          conv.awaiting_variant = null;
          conv.subject_sku = resolved.sku;
          return this.routeBuyItems(conv, customer, event, text, [
            { sku: resolved.sku, qty: conv.pending_qty || 1, name: hit.product.name },
          ]);
        }
      }
    }
    // [ZCode-approved Phase UI fix] SP đa variant chưa rõ size/màu → hỏi chọn variant
    // (từ FACTS trong DB — chống bịa), KHÔNG rơi fallback "chưa đủ dữ liệu".
    const amb = items.find(i => i.ambiguous);
    if (amb) {
      conv.subject_sku = amb.options[0].sku;
      conv.awaiting_variant = { product_id: amb.product_id, subject_sku: conv.subject_sku };
      conv.pending_qty = amb.qty || 1;
      if (['NEW_LEAD', 'DISCOVERY', 'PRODUCT_QA'].includes(conv.state)) {
        this.sessions.transition(conv, 'BUY_INTENT', 'buy_signal');
      }
      const facts = this.buildFacts(conv, text);
      // SURI ASYNC: tiếp diễn qua _then (propose giá trị | Promise — code giữ nguyên).
      return this._then(this.ai.propose('VARIANT', { ...this.modelCtx(conv, text), facts }), proposal => {
        // SURI CLOSURE F1: guard facts tươi trước khi gửi (VARIANT là intent LLM trên FACTS).
        const r = this.gate.sendReply({ conversation: conv, customer, event, proposal: this._freshFactsReply(proposal, conv, facts) });
        return { intent: 'BUY', ambiguous: true, replies: [r] };
      });
    }
    // Tin không nhắc SP nhưng đang có giỏ -> dùng giỏ hiện có (khách rải info nhiều tin)
    if (!items.length && conv.draft && (conv.draft.items || []).some(i => i.state !== 'stale')) {
      items = conv.draft.items.filter(i => i.state !== 'stale').map(i => ({ sku: i.sku, qty: i.qty, name: this.productName(i.sku) }));
    }
    return this.routeBuyItems(conv, customer, event, text, items);
  }

  // [ZCode-approved Phase UI fix] tách phần đi tiếp luồng mua để dùng chung cho lối "khách vừa
  // trả lời chọn variant" — hợp đồng giữ nguyên: items rỗng → hỏi variant, đủ → draft/đơn.
  routeBuyItems(conv, customer, event, text, items) {
    if (!items.length) return this.routeInfo(conv, customer, event, text, 'VARIANT');

    // P3B-1: REPURCHASE / RE-ENTRY — khách ở ORDERED/AFTER_SALES bày tỏ ý định mua (lại):
    // quay về BUY_INTENT và mở THẾ HỆ MUA MỚI (buy_gen++). Idempotency key đơn scope theo
    // INTENT (qua buy_gen trong order-engine.phaseA) — KHÔNG scope theo giỏ: mua lại cùng giỏ
    // phải tạo đơn #2 THẬT (id mới, dòng order mới), KHÔNG nuốt im lặng, KHÔNG trả đơn cũ.
    if (['ORDERED', 'AFTER_SALES'].includes(conv.state) && conv.draft) {
      conv.buy_gen = (conv.buy_gen || 0) + 1;
      conv.draft.order_id = null; // ngắt liên kết đơn cũ — không bao giờ "xác nhận" vào đơn đã chốt
      conv.draft.items = [];      // giỏ mới — items cũ đã thuộc đơn trước
      this.sessions.transition(conv, 'BUY_INTENT', 'repurchase_reentry');
    }

    // đổi chủ đề ngầm khi đang có giỏ khác (case 5 biến thể)
    const oldActive = (conv.draft && conv.draft.items || []).filter(i => i.state !== 'stale').map(i => i.sku);
    const newSkus = items.map(i => i.sku);
    const isSwitch = oldActive.length > 0 && !newSkus.some(s => oldActive.includes(s));
    if (isSwitch) return this.doProductChange(conv, customer, event, items);

    this.sessions.setItems(conv, items);
    conv.subject_sku = items[0].sku;
    if (['NEW_LEAD', 'DISCOVERY', 'PRODUCT_QA'].includes(conv.state)) {
      this.sessions.transition(conv, 'BUY_INTENT', 'buy_signal');
    }
    if (conv.state === 'BUY_INTENT') this.sessions.transition(conv, 'COLLECT_ORDER', 'draft_started');

    const missing = this.sessions.missingRequiredSlots(conv);
    if (missing.length) {
      const facts = this.buildFacts(conv, text);
      // BL-3: KHÔNG truyền conv/draft slots vào model — chỉ ctx trắng + FACTS + tên trường thiếu
      // SURI ASYNC: BUY_ASK luôn đi stub (sync) — _then vẫn bọc để an toàn nếu cấu hình đổi.
      return this._then(this.ai.propose('BUY_ASK', {
        ...this.modelCtx(conv, text),
        facts: { ...facts, variants: items.map(i => ({ ...this.variantView(i.sku), qty: i.qty, name: i.name })) },
        draftMissing: missing,
      }), proposal => {
        const r = this.gate.sendReply({ conversation: conv, customer, event, proposal: { ...proposal, msgKind: 'ai_reply' } });
        return { intent: 'BUY', suppressed: false, missing, replies: [r] };
      });
    }
    return this.tryCreateOrder(conv, customer, event);
  }

  variantView(sku) {
    const hit = this.productDB.getVariant(sku);
    if (!hit) return { sku };
    return { sku, size: hit.variant.size, color: hit.variant.color, price: hit.variant.price, effective: this.productDB.effectiveStock(sku) };
  }

  // ================= SURI P2 (hạng mục 4): REPURCHASE THEO HISTORY (spec case 2) =================
  // Khách cũ nhắn "lấy thêm cái hôm trước" -> đọc ĐƠN GẦN NHẤT (không bị huỷ) CỦA conversation
  // này, đề xuất lại ĐÚNG sản phẩm/số lượng cũ TỪ price_snapshot (DB — KHÔNG đoán SKU, KHÔNG để
  // LLM quyết số lượng), rồi đi TIẾP flow mua bình thường (routeBuyItems: P3B-1 re-entry khi
  // ORDERED/AFTER_SALES -> validate slot -> pha A engine). AI (khi bật) chỉ viết lại CÂU CHỮ
  // hỏi-thiếu trên nền giỏ cũ — quyết định items vẫn là code máy đọc DB.
  latestRepurchaseItems(conv) {
    const orders = this.store.findAll('orders', o => o.conversation_id === conv.conversation_id)
      .filter(o => o.status !== 'CANCELLED') // không đề xuất lại đơn đã huỷ
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    for (const o of orders) {
      let lines = [];
      try { lines = JSON.parse(o.price_snapshot_json || '[]'); } catch (e) { lines = []; }
      const items = lines.filter(l => l && l.sku && l.qty > 0)
        .map(l => ({ sku: l.sku, qty: l.qty, name: this.productName(l.sku) }));
      if (items.length) return { order: o, items };
    }
    return null;
  }

  routeRepurchase(conv, customer, event, text) {
    const hit = this.latestRepurchaseItems(conv);
    if (!hit) {
      // Chưa có lịch sử đơn (hoặc chỉ còn đơn huỷ) -> KHÔNG đoán: hỏi khách muốn lấy gì.
      const proposal = {
        intent: 'REPURCHASE_NO_HISTORY', msgKind: 'ai_reply',
        text: 'Dạ em chưa thấy đơn cũ nào của anh/chị ở đây, anh/chị muốn lấy sản phẩm nào gửi em tên hoặc ảnh nha ạ!',
        evidence: { policy: 'repurchase_no_history', conversation_id: conv.conversation_id }, confidence: 0.9,
      };
      const reply = this.gate.sendReply({ conversation: conv, customer, event, proposal });
      return { intent: 'REPURCHASE', suppressed: false, noHistory: true, replies: [reply] };
    }
    const { order, items } = hit;
    // Đi đúng luồng mua: P3B-1 tự xử lý re-entry từ ORDERED/AFTER_SALES (buy_gen++, ngắt liên
    // kết đơn cũ); slots còn đầy đủ (khách cũ) -> pha A tạo draft ngay, thiếu thì hỏi ĐỦ 1 trường.
    // SURI CLOSURE F2 (JEV LOW-2): routeBuyItems có thể trả PROMISE (hiện BUY_ASK luôn stub-sync
    // nên bất khả thi — bẫy tiềm ẩn; nếu sau này BUY_ASK chuyển async thì metadata cũ gắn lên
    // object Promise và RƠI, rejection không có handler riêng). Chuẩn hoá NGAY TẠI call-site:
    //   - sync    -> gắn meta như cũ (0 thay đổi hành vi cho toàn bộ regression cũ);
    //   - resolve -> gắn meta lên KẾT QUẢ sau settle;
    //   - reject  -> fallback câu an toàn cho khách (không crash, không nuốt im lặng, 0 đơn mới);
    //   - timeout -> chờ CÓ HẠN (repurchaseAwaitMs) rồi fallback — route không treo vô hạn.
    // Idempotency đơn KHÔNG đổi: order chỉ do pha A deterministic tạo (metadata path không đụng).
    const meta = { from_order_id: order.order_id, from_order_code: order.order_code, items };
    const res = this.routeBuyItems(conv, customer, event, text, items);
    if (!(res && typeof res.then === 'function')) {
      res.repurchase = meta;
      return res;
    }
    const fallback = reason => {
      const proposal = {
        intent: 'REPURCHASE_FALLBACK', msgKind: 'ai_reply',
        text: 'Dạ em đang ghi nhận yêu cầu mua lại của anh/chị, em kiểm tra và phản hồi mình ngay nha ạ!',
        evidence: { policy: 'repurchase_promise_fallback', reason, from_order_id: order.order_id },
        confidence: 0.8,
      };
      const reply = this.gate.sendReply({ conversation: conv, customer, event, proposal });
      return { intent: 'REPURCHASE', suppressed: false, repurchase: meta, fallback: reason, replies: [reply] };
    };
    let settled = false;
    return new Promise(resolve => {
      const finish = r => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => finish(fallback('await_timeout')), this.repurchaseAwaitMs);
      Promise.resolve(res).then(
        r => { if (r && typeof r === 'object') r.repurchase = meta; finish(r); },
        e => finish(fallback('error:' + String((e && e.message) || e).slice(0, 80)))
      );
    });
  }

  productName(sku) {
    const hit = this.productDB.getVariant(sku);
    return hit ? hit.product.name : sku;
  }

  tryCreateOrder(conv, customer, event) {
    // VALIDATE slot -> AUTHORIZE -> EXECUTE pha A -> VERIFY (qua gate)
    const r = this.gate.createOrder({ conversation: conv, customer, event });
    if (!r.ok) {
      if (r.reason === 'MISSING_FIELDS') {
        // SURI ASYNC: BUY_ASK đi stub (sync) — bọc _then giữ mẫu thống nhất.
        return this._then(this.ai.propose('BUY_ASK', {
          ...this.modelCtx(conv, ''),
          facts: { subjectProduct: null, variants: [] }, draftMissing: r.missing,
        }), proposal => {
          const reply = this.gate.sendReply({ conversation: conv, customer, event, proposal: { ...proposal, msgKind: 'ai_reply' } });
          return { intent: 'BUY', suppressed: false, missing: r.missing, replies: [reply] };
        });
      }
      if (r.reason === 'OUT_OF_STOCK') {
        const alt = this.suggestAlternatives(conv);
        const text = r.sku
          ? `Dạ anh/chị ơi, sản phẩm này mình vừa hết hàng rồi ạ.${alt ? ' Bên em còn ' + alt + ' anh/chị xem thử nha!' : ''}`
          : 'Dạ mình vừa hết hàng rồi ạ.';
        const proposal = { intent: 'OUT_OF_STOCK', text, evidence: { source: 'product_db', sku: r.sku, effective: r.effective }, confidence: 0.9 };
        const reply = this.gate.sendReply({ conversation: conv, customer, event, proposal: { ...proposal, msgKind: 'ai_reply' } });
        if (conv.state === 'COLLECT_ORDER' || conv.state === 'VALIDATE') this.sessions.transition(conv, 'PRODUCT_QA', 'out_of_stock');
        return { intent: 'BUY', suppressed: false, outOfStock: true, replies: [reply] };
      }
      return { intent: 'BUY', suppressed: false, error: r.reason, replies: [] };
    }
    // pha A OK -> bill template render từ dữ liệu validated (AI2 5.4 — AI không sinh bill)
    conv.draft.order_id = r.order.order_id;
    for (const it of conv.draft.items) if (it.state === 'detected') it.state = 'confirmed';
    this.sessions.transition(conv, 'VALIDATE', 'slots_complete');
    this.sessions.transition(conv, 'CONFIRM', 'draft_reserved');
    const bill = this.renderBill(r.order);
    const proposal = {
      intent: 'ORDER_DRAFT', text: bill, msgKind: 'transactional',
      evidence: { source: 'orders_db', order_id: r.order.order_id, price_snapshot: JSON.parse(r.order.price_snapshot_json) },
      confidence: 1, allowedMoney: this.orderMoney(r.order),
    };
    const reply = this.gate.sendReply({ conversation: conv, customer, event, proposal });
    return { intent: 'BUY', suppressed: false, orderId: r.order.order_id, replies: [reply] };
  }

  orderMoney(order) {
    const lines = JSON.parse(order.price_snapshot_json);
    return [order.total, order.subtotal, order.shipping_fee, ...lines.map(l => l.unit_price * l.qty), ...lines.map(l => l.unit_price)];
  }

  renderBill(order) {
    const lines = JSON.parse(order.price_snapshot_json);
    const rows = lines.map(l => {
      const hit = this.productDB.getVariant(l.sku);
      const label = hit ? `${hit.product.name}${hit.variant.size ? ' (' + hit.variant.size + (hit.variant.color ? ' ' + hit.variant.color : '') + ')' : ''}` : l.sku;
      return `- ${l.qty} x ${label}: ${fmtVND(l.line_total)}đ`;
    });
    return `Dạ đơn của anh/chị như sau ạ:\n${rows.join('\n')}\nPhí ship: ${fmtVND(order.shipping_fee)}đ\nTổng cộng: ${fmtVND(order.total)}đ\nAnh/chị xác nhận giúp em để em gửi hàng nha ạ!`;
  }

  routeConfirm(conv, customer, event) {
    if (!conv.draft || !conv.draft.order_id) return this.routeChitchat(conv, customer, event);
    // P3B-2: draft đã hết TTL -> reservation đã được scheduler thu hồi (expireStaleDrafts).
    // Xác nhận bây giờ KHÔNG ĐƯỢC "tùy tiện" sinh đơn từ reservation cũ: phải re-validate
    // như P3A (đọc stock/giá MỚI NHẤT) — làm bằng cách tạo draft MỚI đầy đủ pha A rồi gửi
    // bill mới chờ khách xác nhận lại lần nữa.
    const prevOrder = this.store.findOne('orders', o => o.order_id === conv.draft.order_id);
    if (prevOrder && prevOrder.status === 'CANCELLED' && prevOrder.cancel_reason === 'draft_ttl_expired') {
      return this.renewExpiredDraft(conv, customer, event, prevOrder);
    }
    // PHA B: re-validate tồn/giá mới nhất (case 9) qua gate
    const r = this.gate.confirmOrder({ conversation: conv, customer, event });
    if (!r.ok) {
      if (r.reason === 'OUT_OF_STOCK') {
        // hủy draft + hoàn reserve, không oversell
        this.orders.cancelDraft(conv.draft.order_id, 'out_of_stock_at_confirm', event.event_id);
        conv.draft.order_id = null;
        const alt = this.suggestAlternatives(conv);
        const text = `Dạ anh/chị ơi, đúng lúc mình chuẩn bị chốt thì sản phẩm này vừa hết hàng ạ. ${alt ? 'Bên em còn ' + alt + ', anh/chị muốn đổi sang bên đó không ạ?' : 'Anh/chị cho em xin thông tin để báo lại khi có hàng nha ạ.'}`;
        const proposal = { intent: 'OUT_OF_STOCK', text, evidence: { source: 'product_db', sku: r.sku, effective: r.effective }, confidence: 0.9 };
        const reply = this.gate.sendReply({ conversation: conv, customer, event, proposal: { ...proposal, msgKind: 'ai_reply' } });
        this.sessions.transition(conv, 'COLLECT_ORDER', 'confirm_failed_out_of_stock');
        this.sessions.transition(conv, 'PRODUCT_QA', 'confirm_failed_out_of_stock');
        return { intent: 'CONFIRM_ORDER', suppressed: false, outOfStock: true, replies: [reply] };
      }
      if (r.reason === 'PRICE_CHANGED') {
        // SỬA LẦN 2 (hở thật, vùng INV-4): giá đổi giữa chat và chốt trước đây rơi vào thông
        // báo chung "đơn có vấn đề nhỏ" và GIỮ draft giá cũ mãi -> dead-end (khách không thể
        // chốt, reserve treo). Đúng thiết kế AI3 mục 5.1: rollback pha B -> hủy draft giá cũ
        // (hoàn reserve) -> đặt giữ LẠI theo giá MỚI NGAY TRƯỚC commit -> báo tổng mới chờ
        // khách xác nhận lại; xác nhận kế tiếp chạy pha B với giá mới.
        this.orders.cancelDraft(conv.draft.order_id, 'price_changed_at_confirm', event.event_id);
        conv.draft.order_id = null;
        const re = this.gate.createOrder({ conversation: conv, customer, event });
        if (re.ok) {
          conv.draft.order_id = re.order.order_id;
          for (const it of conv.draft.items) if (it.state === 'detected') it.state = 'confirmed';
          const bill = this.renderBill(re.order);
          const proposal = {
            intent: 'ORDER_REPRICED', msgKind: 'transactional',
            text: `Dạ anh/chị ơi, vừa lúc chuẩn bị chốt thì shop cập nhật giá mới ạ. Em đã giữ chỗ lại theo giá mới giúp anh/chị rồi nha:\n${bill}`,
            evidence: { source: 'orders_db', order_id: re.order.order_id, reason: 'PRICE_CHANGED', db_price: r.db_price },
            confidence: 1, allowedMoney: this.orderMoney(re.order),
          };
          const reply = this.gate.sendReply({ conversation: conv, customer, event, proposal });
          return { intent: 'CONFIRM_ORDER', suppressed: false, repriced: true, orderId: re.order.order_id, replies: [reply] };
        }
        // giữ lại theo giá mới không thành công (hết hàng luôn) -> báo hết hàng + gợi ý
        const alt = this.suggestAlternatives(conv);
        const text = `Dạ anh/chị ơi, giá sản phẩm vừa được shop cập nhật và lúc em giữ lại thì bên em vừa hết hàng ạ.${alt ? ' Bên em còn ' + alt + ', anh/chị xem thử nha!' : ''}`;
        const proposal = { intent: 'OUT_OF_STOCK', text, evidence: { source: 'product_db', reason: 'PRICE_CHANGED_THEN_OOS' }, confidence: 0.9 };
        const reply = this.gate.sendReply({ conversation: conv, customer, event, proposal: { ...proposal, msgKind: 'ai_reply' } });
        this.sessions.transition(conv, 'COLLECT_ORDER', 'price_changed_then_oos');
        this.sessions.transition(conv, 'PRODUCT_QA', 'price_changed_then_oos');
        return { intent: 'CONFIRM_ORDER', suppressed: false, outOfStock: true, replies: [reply] };
      }
      const proposal = { intent: 'ORDER_ISSUE', text: 'Dạ đơn của mình có vấn đề nhỏ, em kiểm tra và báo lại mình ngay nha ạ!', evidence: { source: 'orders_db', fail: r.reason }, confidence: 0.8 };
      const reply = this.gate.sendReply({ conversation: conv, customer, event, proposal: { ...proposal, msgKind: 'ai_reply' } });
      return { intent: 'CONFIRM_ORDER', suppressed: false, error: r.reason, replies: [reply] };
    }
    // CONFIRMED -> tạo vận đơn (case 12 nằm ở đây khi carrier treo)
    const order = r.order;
    this.sessions.transition(conv, 'ORDERED', 'confirmed');
    const ship = this.orders.createShipment({ order, carrier: this.carrier });
    let replyText;
    const money = this.orderMoney(order);
    if (ship.ok) {
      replyText = `Dạ đơn ${order.order_code} của anh/chị đã được xác nhận, tổng ${fmtVND(order.total)}đ. Mã vận đơn: ${ship.shipment.tracking_number}. Shop sẽ gửi sớm nhất nha ạ!`;
    } else if (ship.timeout) {
      // TIMEOUT_UNKNOWN -> attempt retry mù -> bị CHẶN (chưa có receipt) -> DLQ + needsHuman (case 12)
      const retry = this.orders.blindRetryShipment({ order });
      replyText = `Dạ đơn ${order.order_code} đã được ghi nhận, hệ thống đang hoàn tất bước gửi hàng. Shop sẽ báo lại mình ngay khi có mã vận đơn nha ạ!`;
      const proposal = {
        intent: 'ORDER_CONFIRMED_PENDING_SHIPMENT', text: replyText, msgKind: 'transactional',
        evidence: { source: 'orders_db', order_id: order.order_id, shipment: 'TIMEOUT_UNKNOWN', retry_blocked: retry.blocked },
        confidence: 0.8, allowedMoney: money,
      };
      const reply = this.gate.sendReply({ conversation: conv, customer, event, proposal });
      return { intent: 'CONFIRM_ORDER', suppressed: false, orderId: order.order_id, shipmentTimeout: true, retryBlocked: retry.blocked, replies: [reply] };
    } else {
      replyText = `Dạ đơn ${order.order_code} đã xác nhận, tổng ${fmtVND(order.total)}đ. Bước gửi hàng đang tạm trì hoãn, shop sẽ cập nhật nha ạ!`;
    }
    const proposal = {
      intent: 'ORDER_CONFIRMED', text: replyText, msgKind: 'transactional',
      evidence: { source: 'orders_db', order_id: order.order_id }, confidence: 1, allowedMoney: money,
    };
    const reply = this.gate.sendReply({ conversation: conv, customer, event, proposal });
    return { intent: 'CONFIRM_ORDER', suppressed: false, orderId: order.order_id, replies: [reply] };
  }

  // P3B-2: giữ chỗ LẠI sau khi draft hết TTL — qua pha A đầy đủ (validate stock/giá mới nhất
  // trong transaction) rồi gửi bill mới; khách phải xác nhận lại lần nữa mới có đơn CONFIRMED.
  renewExpiredDraft(conv, customer, event, expiredOrder) {
    const re = this.gate.createOrder({ conversation: conv, customer, event });
    if (re.ok && re.order.order_id !== expiredOrder.order_id) {
      conv.draft.order_id = re.order.order_id;
      for (const it of conv.draft.items) if (it.state === 'detected') it.state = 'confirmed';
      const bill = this.renderBill(re.order);
      const proposal = {
        intent: 'ORDER_DRAFT_RENEWED', msgKind: 'transactional',
        text: `Dạ giữ chỗ của đơn trước đã hết hạn nên em đặt giữ lại giúp anh/chị theo giá và tồn kho mới nhất nha:\n${bill}\nAnh/chị xác nhận lại giúp em một lần nữa để em gửi hàng nha ạ!`,
        evidence: { source: 'orders_db', order_id: re.order.order_id, renewed_from: expiredOrder.order_id, reason: 'DRAFT_TTL_EXPIRED' },
        confidence: 1, allowedMoney: this.orderMoney(re.order),
      };
      const reply = this.gate.sendReply({ conversation: conv, customer, event, proposal });
      return { intent: 'CONFIRM_ORDER', suppressed: false, renewed: true, orderId: re.order.order_id, replies: [reply] };
    }
    // giữ lại KHÔNG thành công (đã hết hàng luôn / thiếu slot) -> báo như nhánh hết hàng của P3A
    const alt = this.suggestAlternatives(conv);
    const text = `Dạ anh/chị ơi, giữ chỗ của đơn trước đã hết hạn và lúc em đặt lại thì bên em vừa hết hàng ạ.${alt ? ' Bên em còn ' + alt + ', anh/chị xem thử nha!' : ''}`;
    const proposal = { intent: 'OUT_OF_STOCK', text, evidence: { source: 'product_db', reason: 'DRAFT_TTL_EXPIRED_THEN_OOS' }, confidence: 0.9 };
    const reply = this.gate.sendReply({ conversation: conv, customer, event, proposal: { ...proposal, msgKind: 'ai_reply' } });
    this.sessions.transition(conv, 'COLLECT_ORDER', 'draft_expired_then_oos');
    this.sessions.transition(conv, 'PRODUCT_QA', 'draft_expired_then_oos');
    return { intent: 'CONFIRM_ORDER', suppressed: false, outOfStock: true, replies: [reply] };
  }

  // ================= P3B-5: HỦY ĐƠN (quản lý đơn — contract dòng 10) =================
  // Đơn DRAFT/CONFIRMED + khách nhắn "hủy đơn…" -> huỷ RÕ RÀNG có audit (ai huỷ, lúc nào, lý do).
  // Đơn đã có shipment -> BẮT BUỘC đi qua shipping cancel path (carrier.cancelShipment có
  // idempotency key riêng + receipt); carrier từ chối -> CANCEL_PENDING + needsHuman, KHÔNG huỷ lửng.
  routeCancel(conv, customer, event, text) {
    void text;
    const store = this.store;
    const convOrders = store.findAll('orders', o => o.conversation_id === conv.conversation_id);
    const active = convOrders.filter(o => ['DRAFT', 'CONFIRMED', 'CANCEL_PENDING'].includes(o.status));
    if (!active.length) {
      const proposal = {
        intent: 'CANCEL_ORDER_NO_TARGET', msgKind: 'ai_reply',
        text: 'Dạ hiện tại em không thấy đơn nào đang xử lý của anh/chị, anh/chị kiểm tra lại giúp em nhé ạ!',
        evidence: { source: 'orders_db', conversation_id: conv.conversation_id, active_orders: 0 }, confidence: 0.9,
      };
      const reply = this.gate.sendReply({ conversation: conv, customer, event, proposal });
      return { intent: 'CANCEL_ORDER', suppressed: false, replies: [reply] };
    }
    // đơn hiện hành: ưu tiên đơn đã chốt (CONFIRMED) mới nhất; nếu chỉ có draft -> huỷ draft
    const target = active.filter(o => o.status !== 'CANCEL_PENDING')
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .find(o => o.status === 'CONFIRMED') || active.filter(o => o.status !== 'CANCEL_PENDING')[0];
    if (!target) {
      // chỉ còn đơn CANCEL_PENDING (đang chờ người xử với ĐVVC) -> không huỷ lửng lần 2
      const proposal = {
        intent: 'CANCEL_ORDER_PENDING', msgKind: 'ai_reply',
        text: 'Dạ yêu cầu huỷ đơn của anh/chị đang do nhân viên xử lý tiếp với đơn vị vận chuyển, shop sẽ báo lại kết quả sớm nhất nha ạ!',
        evidence: { source: 'orders_db', status: 'CANCEL_PENDING' }, confidence: 0.9,
      };
      const reply = this.gate.sendReply({ conversation: conv, customer, event, proposal });
      return { intent: 'CANCEL_ORDER', suppressed: false, cancelPending: true, replies: [reply] };
    }

    const r = this.orders.requestCancelOrder({
      orderId: target.order_id, actor: 'system', reason: 'customer_request',
      eventId: event ? event.event_id : null, carrier: this.carrier,
    });

    if (r.ok) {
      if (target.status === 'DRAFT') {
        // huỷ draft chưa chốt -> về COLLECT_ORDER (transition hợp lệ), giỏ có thể lập lại
        if (conv.state === 'CONFIRM') this.sessions.transition(conv, 'COLLECT_ORDER', 'order_cancelled');
      } else if (conv.state === 'ORDERED' || conv.state === 'CONFIRM') {
        this.sessions.transition(conv, 'AFTER_SALES', 'order_cancelled');
      }
      const viaCarrier = !!r.viaCarrier;
      const shipment = store.findOne('shipments', s => s.order_id === target.order_id);
      const proposal = {
        intent: 'ORDER_CANCELLED', msgKind: 'transactional',
        text: viaCarrier
          ? `Dạ em đã huỷ đơn ${target.order_code} theo yêu cầu của anh/chị ạ. Vận đơn ${shipment ? shipment.tracking_number : ''} cũng đã huỷ bên đơn vị vận chuyển. Anh/chị cần đặt lại đơn nào cứ nhắn em nha!`
          : `Dạ em đã huỷ đơn ${target.order_code} theo yêu cầu của anh/chị ạ. Anh/chị cần đặt lại đơn nào cứ nhắn em nha!`,
        evidence: { source: 'orders_db', order_id: target.order_id, status: 'CANCELLED', cancel_actor: r.actor, via_carrier: viaCarrier },
        confidence: 1, allowedMoney: this.orderMoney(target),
      };
      const reply = this.gate.sendReply({ conversation: conv, customer, event, proposal });
      return { intent: 'CANCEL_ORDER', suppressed: false, cancelled: target.order_id, viaCarrier, replies: [reply] };
    }
    if (r.reason === 'CANCEL_PENDING_NEEDS_HUMAN' || r.pending) {
      const proposal = {
        intent: 'ORDER_CANCEL_PENDING', msgKind: 'transactional',
        text: `Dạ yêu cầu huỷ đơn ${target.order_code} đã được ghi nhận. Bên vận chuyển chưa xác nhận huỷ được nên đơn đang ở trạng thái chờ xử lý, nhân viên shop sẽ kiểm tra và báo lại mình sớm nhất nha ạ!`,
        evidence: { source: 'orders_db', order_id: target.order_id, status: 'CANCEL_PENDING', carrier_reason: r.carrierReason || null },
        confidence: 0.9, allowedMoney: this.orderMoney(target),
      };
      const reply = this.gate.sendReply({ conversation: conv, customer, event, proposal });
      return { intent: 'CANCEL_ORDER', suppressed: false, cancelPending: true, replies: [reply] };
    }
    // idempotent: đơn đã huỷ trước đó -> trả lời lịch sự, không huỷ lại lần 2
    if (r.idempotent) {
      const proposal = {
        intent: 'ORDER_ALREADY_CANCELLED', msgKind: 'ai_reply',
        text: `Dạ đơn ${target.order_code} đã được huỷ trước đó rồi ạ, anh/chị cần đặt đơn mới cứ nhắn em nha!`,
        evidence: { source: 'orders_db', order_id: target.order_id, status: 'CANCELLED' }, confidence: 0.95,
      };
      const reply = this.gate.sendReply({ conversation: conv, customer, event, proposal });
      return { intent: 'CANCEL_ORDER', suppressed: false, idempotent: true, replies: [reply] };
    }
    const proposal = { intent: 'ORDER_ISSUE', text: 'Dạ em chưa huỷ được đơn lúc này, em báo nhân viên kiểm tra ngay và phản hồi mình nha ạ!', evidence: { source: 'orders_db', fail: r.reason }, confidence: 0.8 };
    const reply = this.gate.sendReply({ conversation: conv, customer, event, proposal: { ...proposal, msgKind: 'ai_reply' } });
    return { intent: 'CANCEL_ORDER', suppressed: false, error: r.reason, replies: [reply] };
  }

  routeChangeSubject(conv, customer, event, text) {
    const items = this.extractItems(text);
    return this.doProductChange(conv, customer, event, items, text);
  }

  doProductChange(conv, customer, event, items, text) {
    // case 5: hủy DRAFT cũ + hoàn reserve V1, item cũ -> stale (slot độc lập giữ nguyên)
    if (conv.draft && conv.draft.order_id) {
      this.orders.cancelDraft(conv.draft.order_id, 'customer_changed_product', event.event_id);
      conv.draft.order_id = null;
    }
    if (!items.length) {
      const proposal = { intent: 'CHANGE_SUBJECT', text: 'Dạ anh/chị muốn xem sản phẩm nào, gửi em tên hoặc ảnh nha ạ!', evidence: { policy: 'ask_subject' }, confidence: 0.8 };
      const reply = this.gate.sendReply({ conversation: conv, customer, event, proposal: { ...proposal, msgKind: 'ai_reply' } });
      return { intent: 'CHANGE_SUBJECT', suppressed: false, replies: [reply] };
    }
    this.sessions.markProductChange(conv, items);
    conv.subject_sku = items[0].sku;
    void text;
    // slot name/phone/address GIỮ NGUYÊN -> nếu đủ thì vào pha A luôn với giỏ mới
    return this.routeBuy(conv, customer, event, items.map(i => `${i.qty} ${i.sku}`).join(' và '));
  }

  routeChitchat(conv, customer, event, text) {
    // trả lời có tham chiếu đơn khi đã ORDERED (case 16: không mâu thuẫn ngữ cảnh)
    if (conv.state === 'ORDERED' && conv.draft && conv.draft.order_id) {
      const order = this.store.findOne('orders', o => o.order_id === conv.draft.order_id);
      if (order) {
        const proposal = {
          intent: 'ORDER_STATUS_QA', msgKind: 'ai_reply',
          text: `Dạ không có gì ạ! Đơn ${order.order_code} của anh/chị đang ở trạng thái ${order.status}, shop sẽ cập nhật sớm nhất nha ạ!`,
          evidence: { source: 'orders_db', order_id: order.order_id, status: order.status },
          confidence: 0.95, allowedMoney: this.orderMoney(order),
        };
        const reply = this.gate.sendReply({ conversation: conv, customer, event, proposal });
        return { intent: 'ORDER_STATUS_QA', suppressed: false, replies: [reply] };
      }
    }
    const facts = this.buildFacts(conv, '');
    // BL-3: KHÔNG truyền conv nguyên vẹn (trước đây dòng này rò PII vào model ctx)
    // SURI ASYNC: tiếp diễn qua _then (propose giá trị | Promise — code giữ nguyên).
    return this._then(this.ai.propose('CHITCHAT', { ...this.modelCtx(conv, text || ''), facts }), proposal => {
      // SURI CLOSURE F1: guard facts tươi trước khi gửi (CHITCHAT có thể nhắc số liệu trong FACTS).
      const reply = this.gate.sendReply({ conversation: conv, customer, event, proposal: this._freshFactsReply(proposal, conv, facts) });
      if (reply.sent && conv.state === 'NEW_LEAD') this.sessions.transition(conv, 'DISCOVERY', 'first_contact');
      return { intent: 'CHITCHAT', suppressed: false, replies: [reply] };
    });
  }

  // ================= AICAKE (G2): TỰ ĐỘNG COMMENT & INBOX =================
  // Chuẩn aicake: "Tự động trả lời bình luận trên bài đăng, ẩn comment tiêu cực và inbox
  // khách từ comment" — reply dùng biến {{TenKhachHang}} (comment-flow.js).
  //
  // Gateway.normalize chỉ giữ {kind,text,media,platform_message_id,timestamp_platform} nên
  // origin/comment_id của comment (meta-adapter đặt ở feed event) nằm NGUYÊN trong
  // inbox_events.raw_body — đọc lại theo event_id (READ-ONLY, không đụng gateway).
  // Không phải comment -> null -> event đi luồng tin nhắn bình thường như cũ.
  commentContext(event) {
    try {
      if (!event || !event.event_id) return null;
      const row = this.store.findOne('inbox_events', e => e.event_id === event.event_id);
      if (!row || !row.raw_body) return null;
      const raw = JSON.parse(row.raw_body);
      if (!raw || raw.origin !== 'comment') return null;
      return {
        comment_id: String(raw.comment_id || raw.platform_message_id || ''),
        post_id: raw.post_id || null,
        parent_id: raw.parent_id || null,
      };
    } catch (e) { return null; }
  }

  // 3 công tắc settings shop — đọc FRESH từ settings.json trong dataDir của App (server truyền
  // CÙNG file qua settingsFor(shopId)): đổi công tắc có hiệu lực NGAY, không cần restart.
  commentSwitches() {
    try {
      const ss = new ShopSettings(this.store.dataDir);
      return ss.commentFlowCfg ? ss.commentFlowCfg() : Object.assign({}, COMMENT_FLOW_DEFAULTS);
    } catch (e) {
      return Object.assign({}, COMMENT_FLOW_DEFAULTS);
    }
  }

  customerDisplayName(conv, customer) {
    const draftName = conv && conv.draft && conv.draft.slots && conv.draft.slots.name && conv.draft.slots.name.value;
    return customer.full_name || draftName || customer.display_name || null; // null -> reply fallback "bạn"
  }

  // Kế hoạch xử lý cho MỖI event: nếu là comment (origin 'comment') trả về kế hoạch
  // { handled, result?, inboxAfter?, cctx } — ngược lại null (luồng tin nhắn như cũ).
  commentPlan(conv, customer, event, text, normText) {
    const cctx = this.commentContext(event);
    if (!cctx || !cctx.comment_id) return null;
    const store = this.store;
    const sw = this.commentSwitches();
    const name = this.customerDisplayName(conv, customer);
    let productMatched = false;
    try { productMatched = this.productDB.searchProduct(text).matches.length > 0; } catch (e) { productMatched = false; }
    const cls = classifyComment(text, { productMatched });

    // đánh dấu comment lên conversation (quan sát cho UI/API — ghi qua transaction)
    store.transaction(() => {
      conv.last_comment = { comment_id: cctx.comment_id, tone: cls.tone, buy_intent: cls.buy_intent, at: store.now() };
      store.updateRow('conversations', conv, { last_comment: conv.last_comment });
    });

    // ---------- NHÁNH 1: COMMENT TIÊU CỰC — ẩn + xin lỗi công khai + worklist ----------
    if (cls.tone === 'negative') {
      return { handled: true, result: this.handleNegativeComment(conv, customer, event, cctx, cls, sw, name, text) };
    }

    // ---------- NHÁNH 2: CÂU HỎI / Ý ĐỊNH MUA ----------
    // auto_reply_comment ON -> FALL THROUGH luồng tư vấn HIỆN CÓ (routeInfo/routeBuy —
    // giá/tồn CHỈ từ ProductDB qua sales-ai/FACTS, không bịa số); sau đó buy_intent +
    // auto_inbox_from_comment -> ĐẨY KHÁCH VÀO INBOX (luồng bán bình thường).
    if (cls.tone === 'question' || cls.buy_intent) {
      const inboxAfter = !!(cls.buy_intent && sw.auto_inbox_from_comment);
      if (!sw.auto_reply_comment) {
        // tắt công tắc tự trả -> KHÔNG trả lời công khai; inbox vẫn chạy nếu công tắc riêng bật.
        if (!inboxAfter) {
          return { handled: true, result: { intent: 'COMMENT_SKIPPED_BY_SETTINGS', suppressed: true, comment: cctx, replies: [] } };
        }
        return { handled: true, result: this.pushInboxFromComment(conv, customer, event, cctx, text, null) };
      }
      return { handled: false, inboxAfter, cctx };
    }

    // ---------- NHÁNH 3: COMMENT TÍCH CỰC — trả lời cảm ơn có tên khách ----------
    if (cls.tone === 'positive') {
      if (!sw.auto_reply_comment) {
        return { handled: true, result: { intent: 'COMMENT_SKIPPED_BY_SETTINGS', suppressed: true, comment: cctx, replies: [] } };
      }
      const proposal = {
        intent: 'COMMENT_POSITIVE_REPLY', msgKind: 'ai_reply',
        text: positiveReply(text, name),
        evidence: { policy: 'comment_flow', comment_id: cctx.comment_id, tone: 'positive' },
        confidence: 0.9,
      };
      const r = this.gate.sendReply({ conversation: conv, customer, event, proposal });
      return { handled: true, result: { intent: 'COMMENT_POSITIVE', suppressed: false, comment: cctx, replies: [r] } };
    }

    // ---------- NHÁNH 4: comment KHÁC — không tự trả công khai (tránh trả lệch),
    // vẫn đi tiếp luồng tin nhắn bình thường để không nuốt hành vi giao dịch ----------
    return { handled: false, inboxAfter: false, cctx };
  }

  // Comment tiêu cực: flag hide_requested (message + conversation) -> GỌI helper ẩn qua
  // channel adapter (mock lab) -> worklist 'negative_comment' -> audit 'comment_hide';
  // reply công khai câu xin lỗi ({{TenKhachHang}}) VẪN QUA ACTION GATE.
  handleNegativeComment(conv, customer, event, cctx, cls, sw, name, text) {
    const store = this.store;
    const out = { intent: 'COMMENT_NEGATIVE', suppressed: false, tone: 'negative', hideRequested: false, comment: cctx, replies: [] };
    store.transaction(() => {
      if (sw.hide_negative_comment) {
        // (1) đánh dấu flag hide_requested trên conversation + message comment
        conv.hide_requested = true;
        store.updateRow('conversations', conv, { hide_requested: true });
        const msg = store.findOne('messages', m =>
          m.conversation_id === conv.conversation_id && m.platform_message_id === cctx.comment_id);
        if (msg) store.updateRow('messages', msg, { hide_requested: true, comment_id: cctx.comment_id });
        // (2) GỌI helper ẩn comment qua channel adapter (mock — Phase-2 gọi Graph API thật)
        const hide = hideComment({ comment_id: cctx.comment_id });
        out.hideRequested = !!(hide && hide.ok);
        out.hideMock = !!(hide && hide.mock);
        // (3) worklist cho nhân viên (đúng pattern worklist hiện có — dashboard NEEDS_HUMAN)
        this.takeover.pushWorklist(conv, 'negative_comment', 'high');
        // (4) audit action 'comment_hide' (pattern audit hiện có)
        store.audit({
          event_id: event ? event.event_id : null, conversation_id: conv.conversation_id,
          customer_ref: customer.customer_id, proposed_action: 'comment_hide',
          validation: { comment_id: cctx.comment_id, tone: cls.tone, switch: 'hide_negative_comment' },
          execution_result: 'HIDE_REQUESTED', receipt: hide || null, stage: 'EXECUTED',
        });
      } else {
        // công tắc ẩn tắt -> KHÔNG hành động ngoài (không flag, không worklist) — vẫn ghi vết quyết định
        store.audit({
          event_id: event ? event.event_id : null, conversation_id: conv.conversation_id,
          customer_ref: customer.customer_id, proposed_action: 'comment_hide',
          validation: { comment_id: cctx.comment_id, tone: cls.tone, switch: 'hide_negative_comment' },
          execution_result: 'SKIPPED_SWITCH_OFF', receipt: null, stage: 'EXECUTED',
        });
      }
    });
    // (5) trả lời công khai câu xin lỗi — QUA ACTION GATE như tin thường (giám sát đầy đủ)
    if (sw.auto_reply_comment) {
      const proposal = {
        intent: 'COMMENT_NEGATIVE_REPLY', msgKind: 'ai_reply',
        text: negativeReply(text, name),
        evidence: { policy: 'comment_flow', comment_id: cctx.comment_id, tone: 'negative' },
        confidence: 0.9,
      };
      const r = this.gate.sendReply({ conversation: conv, customer, event, proposal });
      out.replies = [r];
    } else {
      out.suppressed = true; // tắt auto-reply: vẫn ẩn + lên worklist nhưng không tự trả
    }
    return out;
  }

  // ĐẨY KHÁCH TỪ COMMENT VÀO INBOX (luồng bán bình thường): tạo/tìm conversation inbox 1-1
  // của khách (thread = platform_ref — cùng pattern Messenger của sessions.ensureConversation),
  // event riêng dedupe theo `inbox:<comment_id>` (unique index inbox_events.event_id) rồi gọi
  // lại handleEvent với origin 'inbox' -> tin đi ĐÚNG luồng hiểu ý/gate như tin khách thường.
  pushInboxFromComment(conv, customer, event, cctx, text, commentResult) {
    void conv; void commentResult;
    const store = this.store;
    const evtId = `${event.channel}:inbox:${cctx.comment_id}`;
    let duplicate = false;
    store.transaction(() => {
      const ins = store.insert('inbox_events', {
        event_id: evtId, channel: event.channel, type: 'message', conversation_id: null,
        customer_ref: customer.platform_ref,
        raw_body: JSON.stringify({ origin: 'inbox', comment_id: cctx.comment_id, customer_ref: customer.platform_ref, thread_id: customer.platform_ref }),
        normalized_json: null, status: 'PROCESSED', fail_reason: null,
        received_at: store.now(), processed_at: store.now(),
      });
      duplicate = !!ins.duplicate;
    });
    if (duplicate) {
      return { intent: 'COMMENT_INBOX_DUPLICATE', suppressed: true, comment: cctx, replies: [] };
    }
    const inboxEvent = {
      channel: event.channel,
      type: 'message',
      platformEventId: `inbox:${cctx.comment_id}`,
      conversation_id: `${event.channel}:${customer.platform_ref}`,
      customer_ref: customer.platform_ref,
      payload: {
        kind: 'text',
        text,
        platform_message_id: `inbox:${cctx.comment_id}`, // unique messages.platform_message_id
        origin: 'inbox',
      },
    };
    const res = this.handleEvent(inboxEvent);
    return this._then(res, r => Object.assign({}, r || {}, { from_comment_inbox: true, comment: cctx }));
  }

  // ================= POLICY ROUTES =================
  handleOptOut(conv, customer, event) {
    const store = this.store;
    store.transaction(() => {
      customer.marketing_opt_out = 1;
      customer.opt_out_at = store.now();
      conv.marketing_opt_out = 1;
      // hủy mọi follow-up marketing đang chờ của customer (case 18)
      const pending = store.findAll('follow_ups', f => f.customer_id === customer.customer_id && f.kind === 'MARKETING' && f.status === 'SCHEDULED');
      for (const f of pending) store.updateRow('follow_ups', f, { status: 'CANCELLED', cancel_reason: 'opt_out' });
      store.audit({
        event_id: event ? event.event_id : null, conversation_id: conv.conversation_id, customer_ref: customer.customer_id,
        proposed_action: 'OPT_OUT_MARKETING', validation: { cancelled_follow_ups: pending.length },
        execution_result: 'OPT_OUT_SET', receipt: null, stage: 'AUTHORIZED',
      });
    });
    // xác nhận cho khách (tin transactional — vẫn được phép sau opt-out)
    // BL-8: ACK opt-out là system template trong whitelist (system không phải kênh bypass —
    // authorize vẫn chạy đầy đủ; kind transactional nên đúng policy opt-out).
    const proposal = {
      intent: 'OPT_OUT_ACK', msgKind: 'transactional', sender: 'system', template_id: 'OPT_OUT_ACK',
      text: renderSystemTemplate('OPT_OUT_ACK'),
      evidence: { policy: 'opt_out', template_id: 'OPT_OUT_ACK' }, confidence: 1,
    };
    const reply = this.gate.sendReply({ conversation: conv, customer, event, proposal });
    return { intent: 'OPT_OUT', suppressed: false, replies: [reply] };
  }

  handleComplaint(conv, customer, event, text) {
    const store = this.store;
    // CLAIM luôn kèm mode=HUMAN (AI2 mục 1) — actor=system
    this.sessions.openClaim(conv, 'complaint');
    this.takeover.setTakeover(conv, 'system', 'complaint');
    // hủy follow-up marketing đang chờ
    store.transaction(() => {
      const pending = store.findAll('follow_ups', f => f.customer_id === customer.customer_id && f.kind === 'MARKETING' && f.status === 'SCHEDULED');
      for (const f of pending) store.updateRow('follow_ups', f, { status: 'CANCELLED', cancel_reason: 'complaint' });
    });
    this.takeover.pushWorklist(conv, 'complaint', 'high');
    void text;
    // CHỈ template an ủi mẫu (không hứa hẹn bồi thường) — gửi bằng actor system trong mode HUMAN.
    // BL-8: template nằm trong SYSTEM_TEMPLATES whitelist; authorize kiểm tra template_id + render.
    const proposal = {
      intent: 'COMPLAINT_ACK', msgKind: 'transactional', sender: 'system', template_id: 'COMPLAINT_ACK',
      text: renderSystemTemplate('COMPLAINT_ACK'),
      evidence: { policy: 'complaint_template', template_id: 'COMPLAINT_ACK' }, confidence: 1,
    };
    const reply = this.gate.sendReply({ conversation: conv, customer, event, proposal });
    return { intent: 'COMPLAINT', suppressed: false, mode: conv.mode, replies: [reply] };
  }

  // ================= CASE 17: trạng thái vận đơn từ ĐVVC =================
  // VERIFY từ nguồn ngoài: chỉ tin carrier.getStatus(tracking), không tin lời ai nói đã giao.
  onCarrierStatus(orderId) {
    const store = this.store;
    const shipment = store.findOne('shipments', s => s.order_id === orderId);
    if (!shipment) return { ok: false, reason: 'NO_SHIPMENT' };
    const st = this.carrier.getStatus(shipment.tracking_number); // nguồn ngoài
    if (st.status !== 'DELIVERED') {
      store.updateRow('shipments', shipment, { status: st.status });
      return { ok: true, status: st.status };
    }
    store.transaction(() => {
      store.updateRow('shipments', shipment, { status: 'DELIVERED' });
      const order = store.findOne('orders', o => o.order_id === orderId);
      const conv = order ? store.findOne('conversations', c => c.conversation_id === order.conversation_id) : null;
      if (conv) this.sessions.transition(conv, 'AFTER_SALES', 'delivered');
      if (order) {
        store.updateRow('orders', order, { status: 'DELIVERED' });
        // idempotent: 1 follow-up cho 1 order
        const existed = store.findOne('follow_ups', f => f.order_id === orderId && f.kind === 'AFTER_DELIVERY_FEEDBACK');
        if (!existed) {
          store.insert('follow_ups', {
            follow_up_id: uid('fu'), order_id: orderId,
            conversation_id: order.conversation_id, customer_id: order.customer_id,
            kind: 'AFTER_DELIVERY_FEEDBACK',
            scheduled_at: new Date(this.clock.now() + 2 * 24 * 3600 * 1000).toISOString(), // +2 ngày
            status: 'SCHEDULED', cancel_reason: null, exec_id: null,
            created_at: store.now(), updated_at: store.now(),
          });
        }
      }
      store.audit({
        event_id: null, conversation_id: (order || {}).conversation_id || null, customer_ref: null,
        proposed_action: 'SHIPMENT_DELIVERED', validation: { tracking: shipment.tracking_number },
        execution_result: 'DELIVERED', receipt: st, stage: 'VERIFIED',
      });
    });
    return { ok: true, status: 'DELIVERED' };
  }

  suggestAlternatives(conv) {
    // gợi ý SP thay thế CÒN hàng từ DB (AI2 mục 1 PRODUCT_QA)
    for (const p of this.productDB.products) {
      for (const v of p.variants) {
        if (v.sku !== conv.subject_sku && this.productDB.effectiveStock(v.sku) > 0) {
          return `${p.name}${v.size ? ' (' + v.size + (v.color ? ' ' + v.color : '') + ')' : ''}`;
        }
      }
    }
    return null;
  }
}

module.exports = { Pipeline };
