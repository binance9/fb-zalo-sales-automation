'use strict';
// orchestrator.js — AGENT ORCHESTRATOR THẬT (SURI PHASE 1, hạng mục 1).
//
// MỖI tin nhắn khách vào -> 1 AgentRun có cấu trúc:
//   { run_id, conversation_id, customer_ref, input, steps[], decision, result,
//     status: RUNNING|DONE|FAILED|NEEDS_HUMAN, started_at, ended_at }
//
// Orchestrator BỌC pipeline hiện có (KHÔNG đổi hành vi trả lời — chỉ thêm lớp quan sát):
//   step 1 UNDERSTAND: gọi pipeline.handleEvent(event) NGUYÊN VẸN như gateway từng gọi
//                      (kết quả {intent, replies, order...} là output của step);
//   step 2 DECISION:   đọc kết quả -> quyết định REPLY_VIA_GATE | SUPPRESSED_HUMAN_MODE |
//                      NEEDS_HUMAN | NO_REPLY;
//   step 3 SEND:       replies pipeline ĐÃ đi qua Action Gate (sendReply trong pipeline) —
//                      step ghi lại kết quả gate từng reply (sent/decision/delivery_status).
// Mỗi step: {step_id, run_id, type, input_ref, output_ref, tool_calls[], at} — lưu collections
// agent_runs + agent_steps (persist qua store — restart giữ nguyên). Tool calls (tools.js) gắn
// vào run đang mở qua recordToolCall() -> step TOOL.
//
// AN TOÀN REGRESSION: mọi lỗi GHI NHẬN bị nuốt có log — quan sát không được phá luồng khách;
// pipeline.call + gateway retry giữ NGUYÊN hành vi (throw vẫn throw cho gateway xử lý).

const { uid } = require('../util');

const STEP_TYPE = { UNDERSTAND: 'UNDERSTAND', DECISION: 'DECISION', SEND: 'SEND', TOOL: 'TOOL' };
const RUN_STATUS = { RUNNING: 'RUNNING', DONE: 'DONE', FAILED: 'FAILED', NEEDS_HUMAN: 'NEEDS_HUMAN' };

class AgentOrchestrator {
  constructor({ store, pipeline }) {
    this.store = store;
    this.pipeline = pipeline;
    this.openRun = null; // run đang mở — tool calls (runTool qua ctx) gắn vào đây
  }

  // ================================================================ luồng chính
  // SURI ASYNC (LỖI 2): pipeline.handleEvent có thể trả PROMISE (đường LLM production —
  // propose qua httpOnceAsync). Sync path: GIỮ NGUYÊN hành vi cũ (ghi run ngay, throw ngay
  // cho gateway retry). Async path: ghi run sau khi settle; rejection giữ nguyên hợp đồng
  // (fail run + THROW lại) để gateway xử lý như lỗi sync. 0 dòng quan sát/decisions đổi.
  handleIncoming(event) {
    const run = this._safeStartRun(event);
    this.openRun = run;
    let result;
    try {
      // HÀNH VI GỐC — gateway trước đây gọi thẳng pipeline.handleEvent; giờ đi qua đây 1-1.
      result = this.pipeline.handleEvent(event);
    } catch (err) {
      this._safe(() => this._failRun(run, err));
      this.openRun = null;
      throw err; // gateway vẫn thấy lỗi như trước (retry <= 3 / FAILED) — không nuốt
    }
    if (result && typeof result.then === 'function') {
      return result.then(
        res => {
          this._safe(() => this._recordRun(run, event, res));
          this.openRun = null;
          return res;
        },
        err => {
          this._safe(() => this._failRun(run, err));
          this.openRun = null;
          throw err; // gateway vẫn thấy lỗi như trước (retry <= 3 / FAILED) — không nuốt
        },
      );
    }
    this._safe(() => this._recordRun(run, event, result));
    this.openRun = null;
    return result;
  }

  // ================================================================ tạo run
  _safeStartRun(event) {
    return this._safe(() => {
      const run = {
        run_id: uid('run'),
        conversation_id: event.conversation_id || `${event.channel}:${(event.payload && (event.payload.thread_id || event.payload.customer_ref)) || event.customer_ref}`,
        customer_ref: event.customer_ref || (event.payload && event.payload.customer_ref) || null,
        channel: event.channel,
        event_id: event.event_id,
        input: {
          type: event.type || 'message',
          kind: (event.payload && event.payload.kind) || 'text',
          text: String((event.payload && event.payload.text) || ''),
          has_media: !!(event.payload && event.payload.media),
        },
        steps: [],           // step_ids theo thứ tự
        step_count: 0,
        decision: null,
        result: null,
        status: RUN_STATUS.RUNNING,
        started_at: this.store.now(),
        ended_at: null,
        error: null,
      };
      this.store.transaction(() => { this.store.insert('agent_runs', run); });
      return run;
    }, null);
  }

  // ================================================================ ghi step (dùng chung với tools)
  // appendStep(store, run, {type, input_ref, output_ref, tool_calls}) -> step row
  appendStep(run, { type, input_ref, output_ref, tool_calls }) {
    const n = (run.step_count || 0) + 1;
    const step = {
      step_id: `${run.run_id}:s${n}`,
      run_id: run.run_id,
      type,
      input_ref: input_ref || null,
      output_ref: output_ref || null,
      tool_calls: Array.isArray(tool_calls) ? tool_calls : [],
      at: this.store.now(),
    };
    this.store.insert('agent_steps', step);
    run.step_count = n;
    run.steps = [...(Array.isArray(run.steps) ? run.steps : []), step.step_id];
    this.store.updateRow('agent_runs', run, { steps: run.steps, step_count: n });
    return step;
  }

  // ToolCall/ToolResult từ tools.js (ctx.recordToolCall) — 1 step TOOL cho mỗi call.
  recordToolCall(call) {
    const run = this.openRun;
    if (!run) return; // tool chạy ngoài run — chỉ audit cấp tool (tools.js đã ghi)
    this._safe(() => {
      this.store.transaction(() => {
        this.appendStep(run, {
          type: STEP_TYPE.TOOL,
          input_ref: call.input_ref || `tool:${call.tool}`,
          output_ref: call.output_ref || null,
          tool_calls: [call],
        });
      });
    });
  }

  // ================================================================ ghi kết quả run
  _failRun(run, err) {
    if (!run) return;
    this.store.transaction(() => {
      this.store.updateRow('agent_runs', run, {
        status: RUN_STATUS.FAILED,
        error: String((err && err.message) || err).slice(0, 300),
        ended_at: this.store.now(),
      });
      this.store.audit({
        event_id: null, conversation_id: run.conversation_id, customer_ref: run.customer_ref,
        proposed_action: 'AGENT_RUN', validation: { run_id: run.run_id, event_id: run.event_id },
        execution_result: 'FAILED', receipt: { error: String((err && err.message) || err).slice(0, 200) }, stage: 'AGENT',
      });
    });
  }

  _recordRun(run, event, result) {
    if (!run) return;
    this.store.transaction(() => {
      // ---- step UNDERSTAND ----
      const stU = this.appendStep(run, { type: STEP_TYPE.UNDERSTAND, input_ref: `event:${event.event_id}` });
      const replyViews = (result && Array.isArray(result.replies) ? result.replies : []).map(r => ({
        sent: !!r.sent,
        gate_decision: r.decision || null,
        reason: r.reason || null,
        delivery_status: r.delivery_status || null,
        mid: r.mid || null,
        pending_receipt: !!r.pending_receipt,
        overridden: Array.isArray(r.overridden) ? r.overridden : [],
      }));
      this.store.updateRow('agent_steps', stU, {
        output_ref: `pipeline_result:${run.run_id}`,
        output: {
          intent: (result && result.intent) || null,
          suppressed: !!(result && result.suppressed),
          needsHuman: !!(result && result.needsHuman),
          order_id: (result && result.orderId) || null,
          missing: (result && result.missing) || null,
          out_of_stock: !!(result && result.outOfStock),
          mode: (result && result.mode) || null,
          reply_count: replyViews.length,
        },
      });

      // ---- step DECISION ----
      const sentAny = replyViews.some(r => r.sent);
      let decision;
      if (result && result.suppressed) decision = 'SUPPRESSED_HUMAN_MODE';
      else if (sentAny) decision = 'REPLY_VIA_GATE';
      else if (result && result.needsHuman) decision = 'NEEDS_HUMAN';
      else decision = 'NO_REPLY';
      const stD = this.appendStep(run, { type: STEP_TYPE.DECISION, input_ref: stU.step_id });
      this.store.updateRow('agent_steps', stD, {
        output_ref: `decision:${run.run_id}`,
        output: { decision, reply_count: replyViews.length, needs_human: !!(result && result.needsHuman) },
      });

      // ---- step SEND (chỉ khi pipeline đã đẩy reply qua gate) ----
      if (replyViews.length) {
        const stS = this.appendStep(run, {
          type: STEP_TYPE.SEND,
          input_ref: stD.step_id,
          output_ref: `gate_replies:${run.run_id}`,
        });
        this.store.updateRow('agent_steps', stS, {
          output: { via: 'action_gate.sendReply (trong pipeline — không gửi lặp)', replies: replyViews },
          tool_calls: replyViews.map((r, i) => ({
            call_id: `${run.run_id}:send${i + 1}`,
            tool: 'send_message',
            via: 'pipeline->action_gate',
            status: r.sent ? (r.pending_receipt ? 'SENT_PENDING_RECEIPT' : 'SENT') : `REJECTED:${r.reason || 'unknown'}`,
            gate_decision: r.gate_decision,
            delivery_status: r.delivery_status,
            mid: r.mid,
          })),
        });
      }

      // ---- đóng run ----
      const runResult = {
        intent: (result && result.intent) || null,
        decision,
        reply_count: replyViews.length,
        order_id: (result && result.orderId) || null,
        needs_human: !!(result && result.needsHuman),
        suppressed: !!(result && result.suppressed),
      };
      const status = (result && result.needsHuman) ? RUN_STATUS.NEEDS_HUMAN : RUN_STATUS.DONE;
      this.store.updateRow('agent_runs', run, {
        decision, result: runResult, status, ended_at: this.store.now(),
      });
      this.store.audit({
        event_id: null, conversation_id: run.conversation_id, customer_ref: run.customer_ref,
        proposed_action: 'AGENT_RUN', validation: { run_id: run.run_id, event_id: run.event_id, decision },
        execution_result: status, receipt: runResult, stage: 'AGENT',
      });
    });
  }

  // Bọc mọi thao tác GHI NHẬN: quan sát không được phá luồng khách.
  _safe(fn, fallback) {
    try { return fn(); } catch (err) {
      try { console.error('[agent-orchestrator] record failed:', err && err.message); } catch (e) { /* ignore */ }
      return fallback;
    }
  }

  // ================================================================ đọc lại (cho API/UI)
  listRuns(limit = 50) {
    return this.store.findAll('agent_runs', () => true)
      .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
      .slice(0, Math.min(200, Math.max(1, limit)))
      .map(r => ({
        run_id: r.run_id, conversation_id: r.conversation_id, customer_ref: r.customer_ref,
        channel: r.channel, event_id: r.event_id, status: r.status, decision: r.decision,
        intent: r.result && r.result.intent, reply_count: r.result && r.result.reply_count,
        steps_count: (r.steps || []).length,
        started_at: r.started_at, ended_at: r.ended_at,
      }));
  }

  getRun(runId) {
    const run = this.store.findOne('agent_runs', r => r.run_id === runId);
    if (!run) return null;
    const steps = this.store.findAll('agent_steps', s => s.run_id === runId)
      .sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.step_id.localeCompare(b.step_id));
    return { run, steps };
  }
}

module.exports = { AgentOrchestrator, STEP_TYPE, RUN_STATUS };
