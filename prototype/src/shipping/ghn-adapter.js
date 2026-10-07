'use strict';
// ghn-adapter.js — Adapter BIÊN ĐVVC GHN LIVE (P2 LIVE-INTEGRATION).
//
// Interface GIỐNG MockCarrier để OrderEngine/Pipeline dùng KHÔNG SỬA core:
//   createShipment(req)      — req.idempotencyKey BẮT BUỘC; ClientOrderCode = order.order_code
//                              (= idempotency identity nội bộ, INV-3). Idempotent TẦNG ADAPTER:
//                              cùng ClientOrderCode đã tạo thành công -> TRẢ KẾT QUẢ CŨ, KHÔNG
//                              gọi HTTP lần 2. Attempt TIMEOUT (kết quả chưa biết) -> memo
//                              UNKNOWN: lần gọi sau TRA CỨU detail TRƯỚC (ALREADY_EXISTS -> dùng
//                              tracking cũ; chắc chắn chưa có -> tạo lại AN TOÀN, đúng INV-2/AI3 mục 6).
//   searchByOrderCode(code)  — detail theo client_order_code (phòng tuyến case 12).
//   cancelShipment(req)      — POST /shiip/public-api/v2/switch-status/cancel; idempotent (receipt cũ).
//   getStatus(tracking)      — webhook-fed status TRƯỚC (nguồn ngoài mới nhất), miss -> detail API.
//   previewFee(...)          — tính phí (dùng cho production money-guard; core mock giữ MOCK fee).
//
// NGUYÊN TẮC ĐỌC RESPONSE (bắt buộc theo lệnh P2): ĐỌC response code/data — HTTP 200 KHÔNG TỰ
// ĐỘNG = thành công. GHN trả {code:"200", message, data}; chỉ code === "200" + data hợp lệ mới
// là SUCCESS. Lỗi -> REJECTED (fail rõ); timeout -> TIMEOUT (chưa biết).
//
// WEBHOOK: normalizeWebhook(body) -> {event_id, tracking_number, status, duplicate, ...}
// idempotent theo event_id; ACK 200 do route trả NGAY (không xử lý sales logic trong route).
//
// CỨM SECRETS: GHN_TOKEN đi header `Token`, ShopId đi header `ShopId` — không log, không status.

const { httpOnce } = require('../live-http');
const { isConfigured } = require('../live-env');

// GHN status -> status nội bộ (case 17: VERIFY từ ĐVVC)
const STATUS_MAP = {
  ready_to_pick: 'PICKED_UP', picking: 'PICKED_UP', money_collect_picking: 'PICKED_UP',
  picked: 'IN_TRANSIT', storing: 'IN_TRANSIT', transporting: 'IN_TRANSIT',
  delivering: 'IN_TRANSIT', money_collect_delivering: 'IN_TRANSIT',
  delivered: 'DELIVERED',
  delivery_fail: 'FAILED', exception: 'FAILED', damage: 'FAILED', lost: 'FAILED',
  waiting_to_return: 'RETURNED', return: 'RETURNED', return_transporting: 'RETURNED',
  return_fail: 'FAILED', returned: 'RETURNED',
  cancel: 'CANCELLED',
};

class GhnAdapter {
  constructor(opts = {}) {
    const c = opts.config || {};
    this.cfg = {
      token: c.token || null,
      shopId: c.shopId || null,
      baseUrl: String(c.baseUrl || 'https://dev-online-gateway.ghn.vn').replace(/\/+$/, ''),
    };
    this.httpFn = opts.httpFn || httpOnce;       // dependency injection — tests tiêm mock
    this.timeoutMs = opts.timeoutMs || 20000;
    this.mode = 'live';
    this.queryOnMiss = opts.queryOnMiss !== false; // getStatus miss -> hỏi detail API

    // Idempotency memo TẦNG ADAPTER (INV-3): clientOrderCode -> {kind:'CREATED'|'UNKNOWN', result}
    this.createdByCode = {};
    this.cancelledByTracking = {};   // tracking -> receipt (idempotent cancel, MockCarrier đối xứng)
    this.statusByTracking = {};      // tracking -> {status, at} (webhook-fed)
    this.webhookSeen = new Set();    // event_id đã xử lý (normalize idempotent)
    this.createCalls = [];           // quan sát test (không chứa secret)
    this.cancelCalls = [];
    this.state = {
      configured: this.isConfigured(),
      connected: false,
      last_webhook_at: null,
      last_success_at: null,
      last_error_type: null,
    };
  }

  isConfigured() {
    return isConfigured(this.cfg.token) && isConfigured(this.cfg.shopId);
  }

  environment() {
    // sandbox dev-online-gateway.ghn.vn => staging; còn lại production
    return /dev|staging|test|5sao/i.test(this.cfg.baseUrl) ? 'staging' : 'production';
  }

  providerStatus() {
    return {
      provider: 'ghn', mode: this.mode, configured: this.state.configured,
      connected: this.state.configured && this.state.connected && this.state.last_error_type !== 'config',
      last_webhook_at: this.state.last_webhook_at,
      last_success_at: this.state.last_success_at,
      last_error_type: this.state.last_error_type,
      environment: this.environment(),
    };
  }

  _err(type) {
    this.state.last_error_type = type;
    if (type === 'config') this.state.connected = false;
  }

  _post(apiPath, bodyObj) {
    if (!this.isConfigured()) return { __config_missing: true };
    const res = this.httpFn({
      url: `${this.cfg.baseUrl}${apiPath}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Token: String(this.cfg.token),
        ShopId: String(this.cfg.shopId),
      },
      body: JSON.stringify(bodyObj || {}),
      timeoutMs: this.timeoutMs,
    });
    return res;
  }

  // Parse response GHN: HTTP 200 + body {code:"200", data} mới là thành công.
  _parseGhn(res) {
    if (res && res.__config_missing) return { kind: 'CONFIG' };
    if (res && res.timeout) return { kind: 'TIMEOUT' };
    if (!res || res.error) return { kind: 'HTTP_ERROR', error: (res && res.error) || 'http_error' };
    let parsed = null;
    try { parsed = JSON.parse(res.bodyText || ''); } catch (e) { parsed = null; }
    const code = parsed ? String(parsed.code) : '';
    if (res.status >= 200 && res.status < 300 && code === '200' && parsed && parsed.data !== undefined) {
      return { kind: 'OK', data: parsed.data, message: parsed.message || '' };
    }
    return { kind: 'API_ERROR', code: code || `http_${res.status || 0}`, message: (parsed && parsed.message) || '' };
  }

  // ================= CREATE (idempotent theo ClientOrderCode) =================
  createShipment(req = {}) {
    if (!req.idempotencyKey) throw new Error('GhnAdapter.createShipment: thiếu idempotencyKey');
    const code = String(req.clientOrderCode || '');
    if (!code) return { status: 'REJECTED', reason: 'missing_client_order_code' };

    const memo = this.createdByCode[code];
    if (memo && memo.kind === 'CREATED') return memo.result; // idempotent — KHÔNG HTTP lần 2
    if (memo && memo.kind === 'UNKNOWN') {
      // attempt trước TIMEOUT (kết quả chưa biết) -> TRA CỨU trước khi làm gì (INV-2)
      const found = this.searchByOrderCode(code);
      if (found.status === 'ALREADY_EXISTS') {
        const r = { status: 'CREATED', trackingNumber: found.trackingNumber, fee: found.fee !== undefined ? found.fee : null, via: 'reconcile' };
        this.createdByCode[code] = { kind: 'CREATED', result: r };
        return r;
      }
      // chắc chắn CHƯA tồn tại -> rơi xuống tạo lại (retry AN TOÀN, cùng ClientOrderCode)
    }

    this.createCalls.push({ idempotencyKey: req.idempotencyKey, clientOrderCode: code, at: new Date().toISOString() });
    const order = req.order || {};
    const items = Array.isArray(order.items) ? order.items : [];
    const totalWeight = Math.max(1, items.reduce((t, l) => t + (Number(l.qty) || 1), 0) * 250); // 250g/đơn vị mặc định — CHƯA XÁC MINH live
    const body = {
      client_order_code: code,
      to_name: (order.receiver && order.receiver.name) || 'Khach hang',
      to_phone: (order.receiver && order.receiver.phone) || '',
      to_address: (order.receiver && order.receiver.address) || '',
      // to_district_id/to_ward_code: bắt buộc trên GHN thật — ONBOARDING shop phải map địa chỉ
      // (CHƯA XÁC MINH live; prototype ghi nhận truncation này trong report).
      to_district_id: Number(order.receiver && order.receiver.district_id) || 0,
      to_ward_code: String((order.receiver && order.receiver.ward_code) || ''),
      weight: totalWeight,
      service_type_id: 2, // Standard — CHƯA XÁC MINH live
      payment_type_id: 1, // shop trả phí
      required_note: 'CHOXEMHANGKHONGTHU',
      items: items.map(l => ({ name: String(l.sku || 'item'), quantity: Number(l.qty) || 1, weight: 250 })),
    };
    const parsed = this._parseGhn(this._post('/shiip/public-api/v2/shipping-order/create', body));

    if (parsed.kind === 'OK' && parsed.data && parsed.data.order_code) {
      this.state.last_success_at = new Date().toISOString();
      this.state.connected = true;
      this.state.last_error_type = null;
      const r = { status: 'CREATED', trackingNumber: parsed.data.order_code, fee: parsed.data.total_fee !== undefined ? parsed.data.total_fee : null, sort_code: parsed.data.sort_code || null };
      this.createdByCode[code] = { kind: 'CREATED', result: r };
      this.statusByTracking[parsed.data.order_code] = { status: 'CREATED', at: new Date().toISOString() };
      return r;
    }
    if (parsed.kind === 'TIMEOUT') {
      // kết quả CHƯA BIẾT — memo UNKNOWN: mọi create sau phải tra cứu trước (chặn blind-retry)
      this.createdByCode[code] = { kind: 'UNKNOWN', result: null };
      this._err('timeout');
      return { status: 'TIMEOUT' };
    }
    if (parsed.kind === 'CONFIG') { this._err('config'); return { status: 'REJECTED', reason: 'GHN_NOT_CONFIGURED' }; }
    // API_ERROR / HTTP_ERROR = fail RÕ (không memo — retry sau vẫn được phép theo policy tầng trên)
    this._err(parsed.kind === 'API_ERROR' ? `ghn_api_error:${parsed.code}` : 'http_error');
    return { status: 'REJECTED', reason: parsed.kind === 'API_ERROR' ? `ghn_${parsed.code}:${parsed.message}` : (parsed.error || 'http_error') };
  }

  // ================= DETAIL / TRACKING =================
  searchByOrderCode(clientOrderCode) {
    const parsed = this._parseGhn(this._post('/shiip/public-api/v2/shipping-order/detail', { client_order_code: String(clientOrderCode || '') }));
    if (parsed.kind === 'OK' && parsed.data && parsed.data.order_code) {
      return {
        status: 'ALREADY_EXISTS',
        trackingNumber: parsed.data.order_code,
        fee: parsed.data.total_fee,
        ghn_status: parsed.data.status || null,
      };
    }
    if (parsed.kind === 'TIMEOUT' || parsed.kind === 'HTTP_ERROR') return { status: 'UNKNOWN' };
    return { status: 'NOT_EXISTS' }; // API_ERROR (trùng mã/không tồn tại...) — DEF: chưa có đơn
  }

  // getStatus cho pipeline.onCarrierStatus: ưu tiên trạng thái WEBHOOK-fed; miss -> hỏi API.
  getStatus(trackingNumber) {
    const at = new Date().toISOString();
    const fed = this.statusByTracking[trackingNumber];
    if (fed) return { status: fed.status, at: fed.at || at };
    if (!this.queryOnMiss || !this.isConfigured()) return { status: 'UNKNOWN', at };
    const parsed = this._parseGhn(this._post('/shiip/public-api/v2/shipping-order/detail', { order_code: String(trackingNumber || '') }));
    if (parsed.kind === 'OK' && parsed.data) {
      const mapped = STATUS_MAP[String(parsed.data.status || '').toLowerCase()] || 'UNKNOWN';
      this.statusByTracking[trackingNumber] = { status: mapped, at };
      return { status: mapped, at };
    }
    return { status: 'UNKNOWN', at };
  }

  // compat với server seedDemo/tests (MockCarrier.setStatus) — chỉ ghi cache nội bộ
  setStatus(trackingNumber, status) {
    this.statusByTracking[trackingNumber] = { status, at: new Date().toISOString() };
  }

  // ================= PREVIEW / FEE =================
  previewFee(req = {}) {
    const parsed = this._parseGhn(this._post('/shiip/public-api/v2/shipping-order/preview', req.body || req));
    if (parsed.kind === 'OK') return { ok: true, fee: parsed.data.total_fee !== undefined ? parsed.data.total_fee : null, data: parsed.data };
    if (parsed.kind === 'TIMEOUT') return { ok: false, timeout: true };
    return { ok: false, error: parsed.kind === 'CONFIG' ? 'GHN_NOT_CONFIGURED' : `ghn_${parsed.code || 'error'}` };
  }

  // ================= CANCEL (idempotent — MockCarrier đối xứng) =================
  cancelShipment(req = {}) {
    if (!req.idempotencyKey) throw new Error('GhnAdapter.cancelShipment: thiếu idempotencyKey');
    const tracking = String(req.trackingNumber || '');
    const done = this.cancelledByTracking[tracking];
    if (done) return { status: 'CANCELLED', trackingNumber: tracking, receipt_id: done.receipt_id, at: done.at }; // KHÔNG HTTP lần 2
    if (!this.isConfigured()) { this._err('config'); return { status: 'REJECTED', reason: 'GHN_NOT_CONFIGURED' }; }

    this.cancelCalls.push({ idempotencyKey: req.idempotencyKey, trackingNumber: tracking, at: new Date().toISOString() });
    const parsed = this._parseGhn(this._post('/shiip/public-api/v2/switch-status/cancel', { order_codes: [tracking] }));
    if (parsed.kind === 'OK') {
      // data: [{order_code, result, message}] — result true mới là huỷ được
      const rows = Array.isArray(parsed.data) ? parsed.data : [];
      const row = rows.find(x => String(x.order_code) === tracking) || rows[0];
      if (row && (row.result === true || row.result === 'true')) {
        const receipt = { status: 'CANCELLED', trackingNumber: tracking, receipt_id: `GHN-CXL-${req.idempotencyKey}`, at: new Date().toISOString() };
        this.cancelledByTracking[tracking] = receipt;
        this.statusByTracking[tracking] = { status: 'CANCELLED', at: receipt.at };
        this.state.last_success_at = receipt.at;
        this.state.connected = true;
        this.state.last_error_type = null;
        return receipt;
      }
      const reason = (row && row.message) ? String(row.message) : 'ghn_cancel_not_confirmed';
      this._err(`ghn_cancel_rejected:${reason}`);
      return { status: 'REJECTED', reason };
    }
    if (parsed.kind === 'TIMEOUT') { this._err('timeout'); return { status: 'TIMEOUT' }; }
    this._err(parsed.kind === 'API_ERROR' ? `ghn_api_error:${parsed.code}` : 'http_error');
    return { status: 'REJECTED', reason: parsed.kind === 'API_ERROR' ? `ghn_${parsed.code}:${parsed.message}` : (parsed.error || 'http_error') };
  }

  // ================= WEBHOOK NORMALIZE (idempotent) =================
  // GHN webhook body CHƯA XÁC MINH chính thức theo docs công khai — normalize phòng thủ,
  // nhận cả snake_case/PascalCase. event_id deterministic `ghn:<order_code>:<status>:<time>`.
  normalizeWebhook(bodyJson, { receivedAt } = {}) {
    const nowIso = receivedAt || new Date().toISOString();
    this.state.last_webhook_at = nowIso;
    const b = bodyJson && typeof bodyJson === 'object' ? bodyJson : {};
    const tracking = String(b.order_code || b.OrderCode || (b.data && b.data.order_code) || '');
    const clientCode = String(b.client_order_code || b.ClientOrderCode || (b.data && b.data.client_order_code) || '');
    const rawStatus = String(b.status || b.Status || (b.data && b.data.status) || b.log_status || (b.data && b.data.status) || '');
    const time = b.time || b.updated_at || b.created_at || (b.data && (b.data.time || b.data.updated_at)) || nowIso;
    if (!tracking && !clientCode) return { ok: false, reason: 'missing_order_code' };
    const mapped = STATUS_MAP[rawStatus.toLowerCase()] || 'UNKNOWN';
    const event_id = `ghn:${tracking || clientCode}:${rawStatus || 'unknown'}:${new Date(Number(time) || time).toISOString()}`;
    const duplicate = this.webhookSeen.has(event_id);
    if (!duplicate) this.webhookSeen.add(event_id);
    return {
      ok: true, event_id, duplicate,
      tracking_number: tracking || null,      // GHN order code = tracking nội bộ
      client_order_code: clientCode || null,  // mã đối tác = order.order_code của hệ thống
      raw_status: rawStatus || null,
      status: mapped,
      at: new Date(Number(time) || Date.parse(time) || Date.now()).toISOString(),
    };
  }

  // Áp webhook đã normalize vào cache trạng thái (route gọi SAU normalize, trước ACK).
  applyWebhook(norm) {
    if (!norm || !norm.ok || norm.duplicate) return { applied: false, duplicate: !!norm.duplicate };
    const tracking = norm.tracking_number || norm.client_order_code;
    if (tracking) this.statusByTracking[tracking] = { status: norm.status, at: norm.at };
    return { applied: true, duplicate: false };
  }
}

module.exports = { GhnAdapter, STATUS_MAP };
