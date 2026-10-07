'use strict';
// store.js — "SQLite thay thế" bằng JSON trong bộ nhớ + persist ra file.
//
// GHI NHẬN RÕ (bắt buộc theo đề bài):
// - Production dùng SQLite (WAL, BEGIN IMMEDIATE, prepared statement) theo đúng AI3 mục 0 + PHỤ LỤC A.
// - Prototype này MÔ PHỎNG semantics quan trọng nhất của SQLite:
//     * Ghi tuần tự (single-writer): transaction(fn) khoá ghi, sâu nhất 1 cấp (nested = cùng tx).
//     * Rollback: snapshot toàn bộ DB trước tx; nếu fn ném lỗi -> phục hồi snapshot.
//       (SQLite thật rollback từng trang; prototype snapshot cả file — đủ đúng về ngữ nghĩa all-or-nothing.)
//     * UNIQUE INDEX cho idempotency: mỗi collection khai báo các cột unique;
//       insert() kiểm tra check-and-set trước khi ghi (tương đương INSERT ... ON CONFLICT DO NOTHING).
// - Thứ SQLite mock KHÔNG chứng minh được: đồng ghi từ 2 tiến trình, WAL, crash-recovery giữa chừng,
//   hiệu năng index khi dữ liệu lớn -> phải dùng SQLite thật khi build production (ghi trong KET-QUA).

const fs = require('fs');
const path = require('path');
const { iso } = require('./util');

// Các "index duy nhất" mô phỏng (tương ứng UNIQUE trong Phụ lục A của AI3)
const UNIQUE_KEYS = {
  customers: ['customer_id'],
  conversations: ['conversation_id'],
  inbox_events: ['event_id'],
  messages: ['message_id', 'platform_message_id'],
  orders: ['order_id', 'order_code', 'idempotency_key'],
  order_items: ['item_id'],
  shipments: ['shipment_id', 'request_idempotency_key'],
  ai_proposals: ['proposal_id', 'turn_key'], // turn_key (BL-9, P3A): <turn_event_id>:<slot> — retry cùng event KHÔNG sinh proposal row thứ 2; null = không dedupe (caller ngoài event)
  action_executions: ['exec_id', 'idempotency_key'],
  audit_events: [],
  jobs: ['job_id', 'idempotency_key'],
  follow_ups: ['follow_up_id'],
  dlq: [],
  worklist: [],
  metrics: [],
  settings: ['key'],
  // ---- P3C (schema delta D6/D9 + receipt log) ----
  // outbound_pending (D6 — BL-5): receipt store INBOUND-FIRST. Mỗi tin đã được platform
  //   CHẤP NHẬN nhưng CHƯA có bằng chứng delivery là 1 row PENDING; webhook receipt
  //   (FB message_delivery/echo/read, Zalo user_seen_message) mới được quyền chuyển DELIVERED.
  outbound_pending: ['op_id', 'exec_id'],
  // receipt_events: log webhook receipt đã xử lý — dedupe theo receipt_event_id (idempotent, C3.3)
  receipt_events: ['receipt_event_id'],
  // channel_budget (D9 — BL-2): ngân sách CS Zalo per conversation (mirror check-and-decrement
  //   nguyên tử của cs_reply.remain; khởi tạo từ platform.getQuota, KHÔNG hardcode số quota)
  channel_budget: ['conversation_id'],
  // channel_state (BL-1): mốc last_user_event_ts per channel+conversation — CHỈ gateway cập nhật
  //   khi event THẬT TỪ USER (type 'message'); bot send/agent send/follow-up/receipt KHÔNG đụng.
  channel_state: ['conversation_id'],
  // ---- SURI AGENT (đợt P1 — additive, không đụng core) ----
  // agent_runs: 1 AgentRun cho MỖI tin khách vào — orchestrator BỌC pipeline.handleEvent
  //   (quan sát có cấu trúc; KHÔNG đổi hành vi trả lời). Persist qua store -> restart giữ nguyên.
  agent_runs: ['run_id'],
  // agent_steps: từng bước của run (UNDERSTAND/DECISION/SEND/TOOL) — {step_id, run_id, type,
  //   input_ref, output_ref, tool_calls[], at}. SURI agent runtime đọc lại để UI xem vệt run.
  agent_steps: ['step_id'],
};

const COLLECTIONS = Object.keys(UNIQUE_KEYS);

class Store {
  constructor({ dataDir, nowFn, loadIfExists }) {
    this.dataDir = dataDir;
    this.now = nowFn || (() => new Date().toISOString());
    this.dbPath = path.join(dataDir, 'db.json');
    this.auditPath = path.join(dataDir, 'audit.jsonl');
    this.db = {};
    for (const c of COLLECTIONS) this.db[c] = [];
    // P2/PERSISTENCE (additive): chỉ khi App persist mode -> nạp lại db.json có sẵn.
    // Khi flag false / file không tồn tại: hành vi y hệt trước đây (mọi test mock giữ nguyên).
    // JSON.parse giữ thứ tự key => persist() ra bytes y hệt => SHA256 db.json bất biến qua restart.
    if (loadIfExists && fs.existsSync(this.dbPath)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
        for (const c of COLLECTIONS) this.db[c] = Array.isArray(saved[c]) ? saved[c] : [];
      } catch (err) {
        // db.json hỏng -> khởi đầu sạch (đã có db.backup.json tầng trước)
      }
    }
    this.writeLockDepth = 0;   // >0 nghĩa là đang giữ "write lock" (BEGIN IMMEDIATE)
    this.writeCount = 0;       // đếm số transaction đã commit (quan sát)
    this.rollbacks = 0;
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(this.auditPath)) fs.writeFileSync(this.auditPath, '');
  }

  // ---- transaction: khoá ghi tuần tự + all-or-nothing ----
  transaction(fn) {
    if (this.writeLockDepth > 0) return fn(); // nested -> cùng transaction
    const snapshot = JSON.stringify(this.db);
    this.writeLockDepth += 1;
    try {
      const result = fn();
      this.writeLockDepth -= 1;
      this.writeCount += 1;
      this.persist();
      return result;
    } catch (err) {
      this.writeLockDepth -= 1;
      this.db = JSON.parse(snapshot); // ROLLBACK
      this.rollbacks += 1;
      throw err;
    }
  }

  // ---- CRUD ----
  // Trả {ok:true,row} khi ghi được, {duplicate:true, existing} khi trúng unique index
  // (đúng ngữ nghĩa INSERT ... ON CONFLICT DO NOTHING -> dedupe/idempotency dựa vào đây).
  insert(collection, row) {
    if (!COLLECTIONS.includes(collection)) throw new Error(`unknown collection: ${collection}`);
    for (const key of UNIQUE_KEYS[collection]) {
      if (row[key] === undefined || row[key] === null) continue;
      const existing = this.db[collection].find(r => r[key] === row[key]);
      if (existing) return { duplicate: true, existing, key };
    }
    this.db[collection].push(row);
    return { ok: true, row };
  }

  get(collection, id) {
    return this.db[collection].find(r => (
      r[`${collection.slice(0, -1)}_id`] === id ||
      r.customer_id === id || r.conversation_id === id || r.event_id === id ||
      r.message_id === id || r.order_id === id || r.shipment_id === id ||
      r.exec_id === id || r.job_id === id || r.follow_up_id === id || r.proposal_id === id
    )) || null;
  }

  findOne(collection, pred) {
    for (let i = this.db[collection].length - 1; i >= 0; i--) {
      if (pred(this.db[collection][i])) return this.db[collection][i];
    }
    return null;
  }

  findAll(collection, pred) {
    return this.db[collection].filter(pred || (() => true));
  }

  updateRow(collection, row, patch) {
    Object.assign(row, patch, { updated_at: row.updated_at !== undefined ? this.now() : undefined });
    if (row.updated_at === undefined) delete row.updated_at;
    return row;
  }

  update(collection, pred, patch) {
    const rows = this.findAll(collection, pred);
    for (const r of rows) this.updateRow(collection, r, patch);
    return rows.length;
  }

  // ---- metrics_counters (AI3 mục 10) ----
  inc(metric) {
    const day = this.now().slice(0, 10);
    let row = this.db.metrics.find(m => m.metric === metric && m.day === day);
    if (!row) {
      row = { metric, day, value: 0 };
      this.db.metrics.push(row);
    }
    row.value += 1;
    return row.value;
  }

  metric(metric) {
    const day = this.now().slice(0, 10);
    const row = this.db.metrics.find(m => m.metric === metric && m.day === day);
    return row ? row.value : 0;
  }

  // ---- audit: chuỗi bắt buộc của đề bài, ghi JSONL mỗi action ----
  // Shape JSONL: {event_id, conversation_id, customer_ref, proposed_action, validation,
  //               execution_result, receipt, stage, at}
  audit(entry) {
    const line = {
      event_id: entry.event_id || null,
      conversation_id: entry.conversation_id || null,
      customer_ref: entry.customer_ref || null,
      proposed_action: entry.proposed_action || null,
      validation: entry.validation || null,
      execution_result: entry.execution_result || null,
      receipt: entry.receipt || null,
      stage: entry.stage,
      at: this.now(),
    };
    this.db.audit_events.push(line);
    fs.appendFileSync(this.auditPath, JSON.stringify(line) + '\n');
    return line;
  }

  // ---- persist ----
  persist() {
    fs.writeFileSync(this.dbPath, JSON.stringify(this.db, null, 1));
  }
}

module.exports = { Store, COLLECTIONS };
