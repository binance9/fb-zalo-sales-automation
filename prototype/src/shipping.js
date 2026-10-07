'use strict';
// shipping.js — Mock nền tảng ngoài cho prototype: MockCarrier (ĐVVC) + MockPlatform (FB/Zalo send API).
// Hằng số delays/failures CẤU HÌNH ĐƯỢC — dùng cho case 11 (send timeout), 12 (createShipment timeout), 17 (DELIVERED).
// Ghi chú prototype: production thay bằng adapter thật theo interface AI3 mục 6 (idempotencyKey bắt buộc,
// tra cứu theo clientOrderCode trước khi create nếu ĐVVC không có idempotency chính thức).

const { uid } = require('./util');

// ============================================================
// CẤU HÌNH MOCK DÙNG CHUNG (evidence tiền trong gate + fee order-engine)
// - MOCK_SHIPPING_FEE: phí ship mock của carrier (trước đây hardcode rải 25000 ở 2 nơi).
// - MOCK_PROMOTIONS.freeshipThresholdVnd: ngưỡng freeship của shop — là EVIDENCE khuyến mại
//   hợp lệ cho money guard (cr-R2 R3-2 probe B3: nói đúng ngưỡng freeship KHÔNG phải bịa).
// Ghi chú prototype: production đọc phí từ carrier.quoteFee() và khuyến mại từ DB — không hardcode.
// ============================================================
const MOCK_SHIPPING_FEE = 25000;
const MOCK_PROMOTIONS = { freeshipThresholdVnd: 500000 };

// ============================================================
// MockCarrier — mô phỏng API ĐVVC
// mode: 'ok'              -> create luôn thành công
//       'hang'            -> request "treo": carrier ĐÃ tạo vận đơn (record NGAY) nhưng MẤT RESPONSE
//                            (client thấy TIMEOUT; searchByOrderCode thấy ALREADY_EXISTS) — case 12 chính
//       'hang_no_record'  -> treo và KHÔNG bao giờ ghi nhận (carrier hỏng vĩnh viễn)
//       'flaky_once'      -> lần gọi đầu TIMEOUT + không ghi nhận (sự cố tạm thời),
//                            các lần sau hoạt động bình thường — dùng cho case 12b (reconcile retry thành công)
// ============================================================
class MockCarrier {
  constructor({ clock, mode, latencyMs, cancelMode }) {
    this.clock = clock;
    this.mode = mode || 'ok';
    this.latencyMs = latencyMs !== undefined ? latencyMs : 30 * 1000;
    this.createCalls = [];          // mọi lần createShipment bị gọi (để assert "nhận đúng 1 lần")
    this.shipmentsByCode = {};      // clientOrderCode -> {trackingNumber, fee}
    this.statusByTracking = {};
    // P3B-5: huỷ vận đơn — cancelMode: 'ok' (huỷ được) | 'refuse' (carrier từ chối/chưa hỗ trợ)
    this.cancelMode = cancelMode || 'ok';
    this.cancelCalls = [];          // mọi lần cancelShipment bị gọi (idempotencyKey + tracking)
    this.cancelledByTracking = {};  // trackingNumber -> receipt huỷ (bằng chứng phía carrier)
  }

  createShipment(req) {
    // BẮT BUỘC nhận idempotencyKey (AI3 mục 6)
    if (!req.idempotencyKey) throw new Error('MockCarrier.createShipment: thiếu idempotencyKey');
    this.createCalls.push({ idempotencyKey: req.idempotencyKey, clientOrderCode: req.clientOrderCode, at: this.clock.iso() });
    if (this.mode === 'flaky_once' && this.createCalls.length === 1) {
      return { status: 'TIMEOUT' }; // sự cố tạm thời: lần đầu không ghi nhận gì
    }
    if (this.mode === 'ok' || this.mode === 'flaky_once') {
      const tracking = 'MOCK-' + req.clientOrderCode;
      this.shipmentsByCode[req.clientOrderCode] = { trackingNumber: tracking, fee: MOCK_SHIPPING_FEE };
      return { status: 'CREATED', trackingNumber: tracking, fee: MOCK_SHIPPING_FEE };
    }
    if (this.mode === 'hang') {
      // carrier ĐÃ NHẬN và xử lý xong request ngay (record ngay tại thời điểm nhận),
      // nhưng response bị mất trên đường về -> client chỉ thấy TIMEOUT.
      // (Đúng kịch bản AI3 case 12: "lần đầu thực ra thành công" -> reconcile thấy ALREADY_EXISTS.)
      this.shipmentsByCode[req.clientOrderCode] = { trackingNumber: 'MOCK-' + req.clientOrderCode, fee: MOCK_SHIPPING_FEE };
      return { status: 'TIMEOUT' }; // client không biết kết quả
    }
    // hang_no_record
    return { status: 'TIMEOUT' };
  }

  searchByOrderCode(clientOrderCode) {
    if (this.shipmentsByCode[clientOrderCode]) {
      return { status: 'ALREADY_EXISTS', trackingNumber: this.shipmentsByCode[clientOrderCode].trackingNumber };
    }
    return { status: 'NOT_EXISTS' };
  }

  // P3B-5: HUỶ VẬN ĐƠN qua adapter — BẮT BUỘC idempotencyKey (đối xứng createShipment),
  // có receipt (bằng chứng) khi huỷ thành công; từ chối theo chính sách khi cancelMode='refuse'
  // hoặc vận đơn đã giao -> hệ thống PHẢI rơi vào CANCEL_PENDING (không huỷ lửng).
  cancelShipment(req) {
    if (!req.idempotencyKey) throw new Error('MockCarrier.cancelShipment: thiếu idempotencyKey');
    this.cancelCalls.push({
      idempotencyKey: req.idempotencyKey, trackingNumber: req.trackingNumber, at: this.clock.iso(),
    });
    // idempotent: cùng key + đã huỷ -> trả lại receipt cũ (không huỷ lần 2)
    const done = this.cancelledByTracking[req.trackingNumber];
    if (done) return { status: 'CANCELLED', trackingNumber: req.trackingNumber, receipt_id: done.receipt_id, at: done.at };
    if (this.cancelMode === 'refuse') {
      return { status: 'REJECTED', reason: 'carrier_policy_not_cancellable' };
    }
    const st = this.statusByTracking[req.trackingNumber];
    if (st === 'DELIVERED') return { status: 'REJECTED', reason: 'already_delivered' };
    const receipt = { status: 'CANCELLED', trackingNumber: req.trackingNumber, receipt_id: 'CXL-' + req.idempotencyKey, at: this.clock.iso() };
    this.cancelledByTracking[req.trackingNumber] = receipt;
    return receipt;
  }

  getStatus(trackingNumber) {
    const st = this.statusByTracking[trackingNumber];
    return { status: st || 'UNKNOWN', at: this.clock.iso() };
  }

  setStatus(trackingNumber, status) {
    this.statusByTracking[trackingNumber] = status; // PICKED_UP|IN_TRANSIT|DELIVERED|RETURNED|FAILED
  }
}

// ============================================================
// MockPlatform — mô phỏng Send API của Facebook/Zalo
// mode: 'ok'               -> gửi ĐƯỢC CHẤP NHẬN ngay (response có mid); BẰNG CHỨNG DELIVERY
//                             (webhook receipt) chỉ về sau latencyMs — BL-5: response send API
//                             KHÔNG PHẢI bằng chứng "tin đến tay khách".
//       'hang_then_deliver'=> response mất (TIMEOUT) nhưng tin VẪN được giao sau latencyMs, có receipt
//       'hang_forever'     -> treo, không bao giờ có bằng chứng (case 11 biến thể xấu)
//       'fail_5xx'         -> lỗi rõ ràng (retry được)
// BL-2: mock mô hình hoá quota CS Zalo `cs_reply.remain` PER USER (matrix B5/B6):
//       getQuota(userRef) -> {remain, total} (mặc định 8/48h — con số mặc định THIẾT KẾ,
//       production LUÔN đọc API quota, không hardcode); consumeCs trừ khi send accepted.
// BL-5: khi tin ĐƯỢC GIAO (deliver), mock bắn WEBHOOK RECEIPT ngược qua onReceipt
//       (FB: message_delivery / Zalo: user_seen_message) — receipt là INBOUND, hệ thống
//       tự match với outbound_pending; KHÔNG có API đọc trạng thái từng tin.
// ============================================================
class MockPlatform {
  constructor({ clock, mode, latencyMs, onReceipt }) {
    this.clock = clock;
    this.mode = mode || 'ok';
    this.latencyMs = latencyMs !== undefined ? latencyMs : 5 * 1000;
    this.onReceipt = onReceipt || null;   // App cắm: webhook receipt ngược (BL-5)
    this.sentCalls = [];                  // mọi lần sendMessage bị gọi (assert "khách nhận ĐÚNG 1 tin")
    this.receipts = {};                   // clientMessageId -> {mid, delivered_at} — CHỈ ghi khi GIAO
    this.quota = new Map();               // BL-2: userRef -> {remain, total} (cs_reply.remain)
    this.consumedCs = [];                 // BL-2: log các lần platform trừ quota CS
  }

  // BL-2 — quota CS per user (mock của POST /v3.0/oa/quota/message)
  getQuota(userRef) {
    if (!this.quota.has(userRef)) this.quota.set(userRef, { remain: 8, total: 8 }); // mặc định thiết kế B5
    return { ...this.quota.get(userRef) };
  }

  setQuota(userRef, remain, total) {
    this.quota.set(userRef, { remain, total: total !== undefined ? total : 8 });
    return this.getQuota(userRef);
  }

  // BL-2 — platform trừ quota khi tin CS được CHẤP NHẬN (mô phỏng phía Zalo)
  consumeCs(userRef) {
    const q = this.getQuota(userRef);
    q.remain = Math.max(0, q.remain - 1);
    this.quota.set(userRef, q);
    this.consumedCs.push({ userRef, remain: q.remain, at: this.clock.iso() });
    return { ...q };
  }

  sendMessage({ clientMessageId, to, text }) {
    if (!clientMessageId) throw new Error('MockPlatform.sendMessage: thiếu clientMessageId');
    this.sentCalls.push({ clientMessageId, to, text, at: this.clock.iso() });
    const mid = uid('mid'); // id tin từ RESPONSE send API (chưa phải bằng chứng delivery)
    const deliver = () => {
      // tin ĐẾN TAY KHÁCH -> platform bắn webhook receipt ngược (BL-5 inbound-first)
      this.receipts[clientMessageId] = { mid, delivered_at: this.clock.iso() };
      if (this.onReceipt) this.onReceipt({ conversation_id: to, clientMessageId, mid, at: this.clock.iso() });
    };
    switch (this.mode) {
      case 'ok':
        this.clock.schedule(this.latencyMs, deliver); // bằng chứng delivery đến TRỄ sau response
        return { ok: true, mid };
      case 'hang_then_deliver':
        this.clock.schedule(this.latencyMs, deliver);
        return { ok: false, timeout: true };
      case 'hang_forever':
        return { ok: false, timeout: true };
      case 'fail_5xx':
        return { ok: false, error: '500 internal', retryable: true };
      default:
        throw new Error('MockPlatform: unknown mode ' + this.mode);
    }
  }

  // Giữ method cho regression cũ — đường MỚI (P3C) KHÔNG được phụ thuộc:
  // nền tảng thật KHÔNG có API đọc trạng thái từng tin theo clientMessageId (BL-5).
  getReceipt(clientMessageId) {
    return this.receipts[clientMessageId] || null;
  }
}

module.exports = { MockCarrier, MockPlatform, MOCK_SHIPPING_FEE, MOCK_PROMOTIONS };
