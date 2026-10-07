'use strict';
// app.js — lắp ráp toàn hệ thống cho prototype + vòng chạy (drain) trên đồng hồ ảo.
// Mỗi test case dựng 1 App mới = DB mới (đúng nguyên tắc "mỗi test = DB riêng" của AI3 mục 11).

const fs = require('fs');
const path = require('path');
const { VirtualClock } = require('./clock');
const { Store } = require('./store');
const { ProductDB, applyProductOverrides } = require('./product-db');
const { Sessions } = require('./session');
const { SalesAI } = require('./sales-ai');
// SURI P2 (hạng mục 1/2): nối AI provider (DeepSeek live) vào ĐƯỜNG TRẢ LỜI — SalesAI đọc
// runtime config (provider/key/model/useForReplies + system prompt từ hồ sơ shop) từ settings
// của shop MỖI LẦN propose (đổi config không cần restart). Server TIÊM CÙNG instance ShopSettings.
const aiProvider = require('./ai-provider');
const shopProfile = require('./shop-profile');
const { buildSystemPrompt } = require('./prompt-builder');
const { ShopSettings } = require('./shop-settings');
const { Gateway } = require('./gateway');
const { ActionGate } = require('./action-gate');
const { OrderEngine } = require('./order-engine');
const { Takeover } = require('./takeover');
const { Pipeline } = require('./pipeline');
// SURI P1 (hạng mục 1): AgentOrchestrator BỌC pipeline — AgentRun/step có cấu trúc cho MỖI tin
// khách vào. Quan sát có cấu trúc: pipeline.handleEvent giữ NGUYÊN, gateway vẫn nhận cùng throw.
const { AgentOrchestrator } = require('./agent/orchestrator');
const { MockCarrier, MockPlatform } = require('./shipping');
// P2 LIVE-INTEGRATION: factory chọn adapter BIÊN theo env (CHANNEL_MODE/SHIPPING_MODE).
// Mock mode -> null -> App dựng Mock như cũ; core KHÔNG biết OAuth/token/URL — chỉ qua interface.
const { buildLiveExternals } = require('./live-runtime');

const SEED = path.join(__dirname, '..', 'data', 'products.json');

class App {
  constructor(opts = {}) {
    // P2/PERSISTENCE: APP_DATA_MODE=reset|persist (mặc định reset — test suite giữ reset).
    // persist = KHÔNG rmSync dataDir; lần đầu tạo thư mục; trước khi mở db có sẵn ->
    // copy db.json thành db.backup.json (backup 1 tầng); Store nạp db.json nếu có.
    this.persistMode = opts.persist === true
      || (opts.persist === undefined && String(process.env.APP_DATA_MODE || '').toLowerCase() === 'persist');
    const dataDir = opts.dataDir;
    if (dataDir && !this.persistMode && fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
    this.dataDir = dataDir || path.join(__dirname, '..', 'data', 'runtime');
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (this.persistMode) {
      const dbPath = path.join(this.dataDir, 'db.json');
      if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, path.join(this.dataDir, 'db.backup.json'));
    }

    this.clock = new VirtualClock(opts.clockStart || Date.parse('2026-10-04T09:00:00.000Z'));
    this.store = new Store({ dataDir: this.dataDir, nowFn: () => this.clock.iso(), loadIfExists: this.persistMode });

    // settings (CẤM chứa secret — AI3 schema)
    this.store.insert('settings', { key: 'bot_enabled', value: opts.botEnabled !== false, updated_at: this.store.now() });

    this.productDB = new ProductDB({ seedFile: opts.seedFile || SEED });
    // SỬA (PRODUCT-READY đợt 2, matrix PS09): overrides sản phẩm (SP thêm/sửa/tắt qua API) nằm
    // trong file product-overrides.json CỦA dataDir — phải ÁP LẠI ở MỌI lần dựng App, không chỉ
    // khi server dựng App (getApp). Restart bằng App trực tiếp (tool/test/persistence) không mất SP.
    // Idempotent với server (helper check-and-set — cùng 1 implementation trong product-db.js).
    try {
      applyProductOverrides(this.productDB,
        JSON.parse(fs.readFileSync(path.join(this.dataDir, 'product-overrides.json'), 'utf8')));
    } catch (e) { /* chưa có file overrides — khởi đầu từ seed */ }
    this.sessions = new Sessions({ store: this.store });
    // SURI P2: settings shop (ShopSettings) — server TIÊM instance CÙNG nó đang dùng (không lệch
    // trạng thái); App dựng trực tiếp (test/tool) tự tạo instance trên cùng dataDir settings.json.
    this.settings = opts.settings || null;
    if (!this.settings && opts.settings !== null) this.settings = new ShopSettings(this.dataDir);
    // Runtime AI đọc FRESH mỗi tin: provider/key/timeout/useForReplies + system prompt build từ
    // hồ sơ shop + prompt config (mergePromptConfig — profile ưu tiên cao hơn, như /api/prompt).
    // Chưa cấu hình provider ngoài (hoặc provider 'local' = stub) => getConfig trả null => stub.
    const getAiRuntime = () => {
      const ss = this.settings;
      if (!ss) return null;
      const cfg = aiProvider.getAiConfig(ss);
      if (!cfg || cfg.provider === 'local' || !cfg.api_key) return null;
      const useForReplies = aiProvider.useForReplies(ss);
      let legacy = {};
      try { legacy = ss.get('prompt_config') ? JSON.parse(ss.get('prompt_config')) : {}; } catch (e) { legacy = {}; }
      let sysPrompt;
      try { sysPrompt = buildSystemPrompt(shopProfile.mergePromptConfig(legacy, shopProfile.getShopProfile(ss))); }
      catch (e) { sysPrompt = null; }
      return {
        provider: cfg.provider, api_key: cfg.api_key, model: cfg.model, timeout: cfg.timeout,
        // SURI ASYNC (LỖI 2 — Bước 2): base_url phải đi qua runtime — nếu không sales-ai sẽ
        // fallback về URL mặc định của provider (gọi ra internet thay vì endpoint shop cấu hình).
        base_url: cfg.base_url || null,
        useForReplies, systemPrompt: sysPrompt,
      };
    };
    // opts.aiHttpFn: tiêm HTTP ĐỒNG BỘ cho SalesAI (test offline — không ra mạng); khi có,
    // propose giữ SYNC nguyên trạng. opts.aiAsyncHttpFn: tiêm HTTP KHÔNG chặn (test đường
    // async — SURI ASYNC). Production: KHÔNG tiêm gì — đường LLM dùng httpOnceAsync (spawn
    // curl không sync), stub vẫn sync-instant. Mặc định app giữ nguyên như cũ.
    this.ai = new SalesAI({ getConfig: getAiRuntime, httpFn: opts.aiHttpFn || null, asyncHttpFn: opts.aiAsyncHttpFn !== undefined ? opts.aiAsyncHttpFn : null });

    // P2 LIVE-INTEGRATION: chọn adapter BIÊN — opts.live = externals dựng sẵn (test tiêm trực tiếp),
    // không có thì build từ env (CHANNEL_MODE/SHIPPING_MODE; mặc định mock -> null).
    // Adapter dùng THEO INTERFACE CŨ của MockPlatform/MockCarrier (sendMessage/getQuota/
    // createShipment/cancelShipment/getStatus) — core KHÔNG biết OAuth/token/URL.
    this.live = opts.live || buildLiveExternals(opts.liveOptions || {});
    this.liveMode = !!this.live;

    // Nền tảng ngoài — mock giữ nguyên cho regression; live mode cắm adapter thật cùng interface.
    // Mock delays/failures cấu hình được (case 11/12/17)
    this.carrier = (this.live && this.live.carrier) || new MockCarrier({
      clock: this.clock,
      mode: opts.carrierMode || 'ok',            // ok | hang | hang_no_record
      latencyMs: opts.carrierLatencyMs !== undefined ? opts.carrierLatencyMs : 30 * 1000,
      cancelMode: opts.carrierCancelMode || 'ok', // P3B-5: ok | refuse (từ chối huỷ vận đơn)
    });
    // P3C/BL-5: mock platform bắn WEBHOOK RECEIPT ngược khi tin được giao — App là nơi nhận
    // webhook và normalize (FB message_delivery / Zalo user_seen_message) rồi đổ vào receipt
    // store (outbound_pending). Đây là đường bằng chứng INBOUND duy nhất cho "đã đến tay khách".
    // Live mode: platform = ChannelRouter (meta/zalo adapter) — sendMessage đồng bộ theo hợp đồng gate.
    this.platform = (this.live && this.live.platform) || new MockPlatform({
      clock: this.clock,
      mode: opts.platformMode || 'ok',           // ok | hang_then_deliver | hang_forever | fail_5xx
      latencyMs: opts.platformLatencyMs !== undefined ? opts.platformLatencyMs : 5 * 1000,
      onReceipt: raw => this.ingestReceipt(raw),
    });

    this.takeover = new Takeover({ store: this.store });
    const needsHuman = (conv, reason, severity) => this.markNeedsHuman(conv, reason, severity);
    this.orders = new OrderEngine({
      store: this.store, productDB: this.productDB, clock: this.clock, needsHuman,
      draftTtlMs: opts.draftTtlMs, // P3B-2: TTL giữ chỗ DRAFT (mặc định 24h)
    });
    this.gate = new ActionGate({
      store: this.store, productDB: this.productDB, platform: this.platform,
      clock: this.clock, orders: this.orders, needsHuman,
      quotaLowThreshold: opts.quotaLowThreshold, // P3C/BL-2: ngưỡng chuyển human (mặc định 2)
    });
    this.pipeline = new Pipeline({
      store: this.store, productDB: this.productDB, sessions: this.sessions, ai: this.ai,
      gate: this.gate, orders: this.orders, takeover: this.takeover, carrier: this.carrier, clock: this.clock,
    });
    // SURI P1: orchestrator là lớp gateway->pipeline MỚI (handleIncoming gọi pipeline 1-1 rồi
    // ghi AgentRun/agent_steps). Lỗi ghi nhận bị nuốt có log — KHÔNG ảnh hưởng luồng khách.
    this.agent = new AgentOrchestrator({ store: this.store, pipeline: this.pipeline });
    // SURI ASYNC (LỖI 2): đếm pipeline event đang chờ LLM BẤT ĐỒNG BỘ (promise chưa settle).
    // Drain dùng để KHÔNG nhảy đồng hồ ảo khi còn work pending (xem drain()).
    this.pendingAsync = 0;
    this.gateway = new Gateway({
      store: this.store,
      mediaDir: path.join(this.dataDir, 'media'),
      onEvent: ev => this._handleEventTracked(ev),
    });
  }

  // SURI ASYNC: bọc agent.handleIncoming — promise (đường LLM async) được đếm trong
  // pendingAsync tới khi settle. Sync path trả nguyên kết quả/throw như cũ (0 thay đổi).
  _handleEventTracked(ev) {
    const r = this.agent.handleIncoming(ev);
    if (r && typeof r.then === 'function') {
      this.pendingAsync += 1;
      const done = () => { this.pendingAsync -= 1; };
      return r.then(v => { done(); return v; }, e => { done(); throw e; });
    }
    return r;
  }

  markNeedsHuman(conversation, reason, severity) {
    conversation.flag_needs_human = true;
    this.takeover.pushWorklist(conversation, reason, severity);
  }

  // P3C/BL-5: nhận webhook receipt từ nền tảng (mock bắn khi deliver) — normalize per channel:
  //   facebook -> message_delivery (message_delivery/message_echo/message_read của Meta thật)
  //   zalo     -> user_seen_message
  // event_id deterministic -> platform resend webhook là idempotent (C3.3).
  // Đường này KHÔNG đụng last_user_event_ts (receipt không phải event của user — BL-1).
  ingestReceipt(raw) {
    const channel = String(raw.conversation_id || '').split(':')[0] || 'facebook';
    const kind = channel === 'zalo' ? 'user_seen_message' : 'message_delivery';
    const event_id = `rcpt:${raw.conversation_id}:${raw.clientMessageId}:${kind}`;
    return this.gate.processReceiptEvent({
      event_id,
      conversation_id: raw.conversation_id,
      channel,
      kind,
      mid: raw.mid || null,
      at: raw.at,
    });
  }

  metric(name) {
    return this.store.metric(name);
  }

  // Nhận event mô phỏng webhook. Trả {duplicate, event_id, http} (case 10 assert trên này).
  receive(ev) {
    return this.gateway.receive(ev);
  }

  // ---- scheduler: chạy mọi job/follow-up đến hạn tại thời điểm hiện tại ----
  runDueJobs() {
    const now = this.clock.now();
    let ran = 0;
    // P3B-2: sweep DRAFT hết TTL — scheduler tự hoàn reservation (tồn khả dụng trở lại).
    // Chạy theo đồng hồ hiện tại (không đưa expires_at vào nextDueAt để drain không nhảy
    // đồng hồ 24h trong các test/test-case cũ — test P3B tự advance đồng hồ rồi drain).
    if (this.orders.expireStaleDrafts(now).length > 0) ran += 1;
    for (;;) {
      const job = this.store.findOne('jobs', j => j.status === 'QUEUED' && Date.parse(j.run_at) <= now);
      if (!job) break;
      job.status = 'RUNNING';
      let result = null;
      try {
        const payload = JSON.parse(job.payload_json);
        if (job.kind === 'check_send_receipt') result = this.gate.checkSendReceipt(payload);
        else if (job.kind === 'reconcile_shipment') {
          const order = this.store.findOne('orders', o => o.order_id === payload.order_id);
          result = order ? this.orders.reconcileShipment({ order, carrier: this.carrier }) : { ok: false };
        } else result = { ok: false, reason: 'unknown_kind' };
        job.status = 'DONE';
      } catch (err) {
        job.attempts += 1;
        job.last_error = String(err && err.message);
        job.status = job.attempts >= job.max_attempts ? 'DEAD' : 'QUEUED';
      }
      job.updated_at = this.store.now();
      ran += 1;
      void result;
    }
    for (;;) {
      // follow-ups đến hạn: chụp SNAPSHOT 1 lượt rồi chạy (SỬA LẦN 2) — sendFollowUp có thể
      // trả "held" (mode HUMAN) giữ status SCHEDULED; vòng while cũ sẽ bắt lại chính nó
      // trong cùng tick -> lặp vô hạn. Snapshot + vòng for = mỗi follow-up thử đúng 1 lần/tick.
      const dueFus = this.store.findAll('follow_ups', f => f.status === 'SCHEDULED' && Date.parse(f.scheduled_at) <= now);
      for (const fu of dueFus) {
        const conv = this.store.findOne('conversations', c => c.conversation_id === fu.conversation_id);
        const customer = this.store.findOne('customers', c => c.customer_id === fu.customer_id);
        if (!conv || !customer) { fu.status = 'CANCELLED'; fu.cancel_reason = 'missing_conv'; continue; }
        fu.status = 'RUNNING'; // chống re-entrant trong cùng tick
        this.gate.sendFollowUp({ followUp: fu, conversation: conv, customer });
        ran += 1;
      }
      break;
    }
    this.store.persist();
    return ran;
  }

  // Thời điểm có việc tiếp theo (timer clock / job QUEUED / follow-up SCHEDULED), null nếu không có.
  nextDueAt() {
    const candidates = [];
    const t = this.clock.nextAt();
    if (t !== null) candidates.push(t);
    for (const j of this.store.findAll('jobs', j => j.status === 'QUEUED')) {
      candidates.push(Date.parse(j.run_at));
    }
    for (const f of this.store.findAll('follow_ups', f => f.status === 'SCHEDULED')) {
      candidates.push(Date.parse(f.scheduled_at));
    }
    return candidates.length ? Math.min(...candidates) : null;
  }

  // Chạy cho tới khi tĩnh: event queue cạn + không còn job/timer trong horizon.
  drain(opts = {}) {
    const horizonMs = opts.horizonMs !== undefined ? opts.horizonMs : 3 * 24 * 3600 * 1000;
    // SURI ASYNC (LỖI 2): KHÔNG "nhảy" đồng hồ ảo tới job tương lai KHI CÓ pipeline event
    // đang chờ LLM bất đồng bộ (pendingAsync > 0) — reply pending sẽ bị kéo theo về tương
    // lai => window 24h/scheduled_at lệch thực tế, gate từ chối gửi nhầm. Ngoài case đó giữ
    // NGUYÊN hành vi cũ (persist hay không đều nhảy khi rảnh — matrix follow-up dựa vào đây).
    // Muốn ép: opts.allowClockJump. ĐỌC pendingAsync TƯƠI TẠI ĐIỂM KIỂM TRA trong vòng lặp
    // (processQueue chạy TRONG loop mới bắt đầu work pending — tại lúc vào drain luôn là 0,
    // chụp trước sẽ sai — bug thật đã bắt được bằng clock-jump trace ở server thật).
    const jumpOpt = opts.allowClockJump;
    for (let guard = 0; guard < 200; guard++) {
      let acted = false;
      const processed = this.gateway.processQueue();
      // SỬA LẦN 2 (đi cùng Fix retry gateway): queue còn event re-queue (retry worker) ->
      // coi như có hành động để vòng drain chạy tiếp, không dừng sớm bỏ sót event.
      if (processed.length || this.gateway.queue.length) acted = true;
      if (this.runDueJobs() > 0) acted = true;
      const next = this.nextDueAt();
      const allowClockJump = jumpOpt !== undefined ? !!jumpOpt : this.pendingAsync === 0;
      if (allowClockJump && next !== null && next - this.clock.now() <= horizonMs) {
        this.clock.advance(next);
        acted = true;
      }
      if (!acted) break;
    }
    this.store.persist();
  }

  // Tăng đồng hồ thủ công (ví dụ +2 ngày cho follow-up) rồi chạy việc đến hạn.
  advance(ms) {
    this.clock.advance(this.clock.now() + ms);
    this.drain({});
  }
}

module.exports = { App };
