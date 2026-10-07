# SURI SALES AGENT — PHASE 1 (ĐỢT 1): ORCHESTRATOR + TOOLS + SHOP PROFILE + DEEPSEEK LIVE

> Ngày: 2026-10-06 · CODEX (implementer đợt P1) · Phạm vi: 5 hạng mục theo lệnh đợt 1.
> FREEZE CORE tôn trọng NGUYÊN TRẠNG: Action Gate/SendPolicy, PII strip, idempotency
> event-scoped, receipt store, order engine, window/quota logic, takeover logic, pipeline
> state machine — KHÔNG dòng nào đổi hành vi. Mọi thay đổi là ADDITIVE (lớp bọc quan sát,
> settings, route API, UI) + 2 collection store mới (agent_runs/agent_steps).

## 0. BEFORE → FINAL

| Bộ kiểm chứng | BEFORE (đầu đợt) | AFTER |
|---|---|---|
| test/18-cases.js | 18/18 | **18/18 PASS** |
| test/invariants-check.js | 6/6 | **6/6 PASS** |
| test/gate-a.js | 7/7 | **7/7 PASS** |
| test/p3b-cases.js | 11/11 | **11/11 PASS** |
| test/p3c-cases.js | 28/28 | **28/28 PASS** |
| test/live-adapters.js | 26/26 | **26/26 PASS** |
| test/product-ready.js | 32/32 | **32/32 PASS** |
| test/e2e-flows.js | 5/5 | **5/5 PASS** |
| test/matrix (245 case) | 245/245 | **245/245 PASS (17.1s)** |
| test/suri-agent.js (MỚI) | — | **19/19 PASS** |
| test/deepseek-wire.js (MỚI) | — | **(a) PASS + (b) LIVE ONLINE** |

`node --check` PASS cho mọi file mới/sửa. Server boot thật OK (NO_BROWSER_OPEN smoke).
**Không suite cũ nào bị sửa; hành vi trả lời khách giữ nguyên 100% (S1/S8e assert bill vẫn về tay khách qua orchestrator).**

## 1. KIẾN TRÚC (text diagram)

```
                                   ┌──────────────────────────────────────────────┐
webhook / UI debug ──► Gateway ──► │ AgentOrchestrator.handleIncoming(event)      │
                                   │  1. _startRun  -> agent_runs (RUNNING)       │
                                   │  2. step UNDERSTAND: Pipeline.handleEvent    │
                                   │     (NGUYÊN VẸN — trích slot/AI stub/FACTS)  │
                                   │        └─► ActionGate.sendReply (gốc)        │
                                   │  3. step DECISION: REPLY_VIA_GATE |          │
                                   │     SUPPRESSED_HUMAN_MODE | NEEDS_HUMAN |    │
                                   │     NO_REPLY                                 │
                                   │  4. step SEND: ghi kết quả gate từng reply   │
                                   │     (không gửi lặp — quan sát)               │
                                   │  run.status: DONE/NEEDS_HUMAN/FAILED         │
                                   │  LỖI GHI NHẬN = nuốt có log; throw của       │
                                   │  pipeline vẫn throw cho gateway (retry gốc)  │
                                   └──────────────┬───────────────────────────────┘
                                                  │ recordToolCall (run đang mở)
                                                  ▼
        ┌────────────────────────── src/agent/tools.js — runTool(name, input, ctx) ──────────────────────────┐
        │ validate schema -> dedupe idem_key (audit-scoped) -> timeout wrapper (sync đo / async race)        │
        │ -> handler ỦY QUYỀN core: order-engine.phaseA/phaseB/requestCancelOrder/cancelShipmentViaCarrier,  │
        │    gate.agentSend/gate.createOrder/gate.confirmOrder/windowState/getBudget, productDB,             │
        │    sessions.transition/setItems/setSlot, takeover.setTakeover/handback, carrier (mock/GHN)         │
        │ -> audit TOOL:<name> + ToolCall/ToolResult vào AgentRun đang mở (agent_steps type=TOOL)            │
        │ Backend chưa cấu hình -> {status:'NOT_CONFIGURED', reason} — KHÔNG giả PASS                        │
        └───────────────────────────────────────────────────────────────────────────────────────────────────┘

DeepSeek wire:  provider_config.json (ngoài project) --readDeepseekRule--> apiKey/baseUrl/models
                --wireDeepseek--> ShopSettings (ai_provider=deepseek, key, deepseek-chat) --testAiProvider-->
                POST /chat/completions THẬT -> ONLINE | ERROR (key không bao giờ ra log/API — chỉ ***+4 cuối)

Prompt: shop-profile (16 field) --mergePromptConfig--> ĐÈ prompt_config cũ --> buildSystemPrompt
Error UX: catch-all server -> friendlyError -> body {userMessage} ; technical CHỈ vào log
Scheduler TZ: settings.timezone mặc định Asia/Ho_Chi_Minh ; follow-up hiển thị scheduled_at_vn (GMT+7)
```

Persist: agent_runs + agent_steps là collection store (unique run_id/step_id) → restart giữ nguyên
(chứng minh S1b: App mới cùng dataDir thấy đủ run + 3 step).

## 2. HẠNG MỤC 1 — AGENT ORCHESTRATOR (src/agent/orchestrator.js)

- Mỗi tin khách vào → AgentRun `{run_id, conversation_id, customer_ref, input{type,kind,text,has_media},
  steps[], decision, result, status(RUNNING/DONE/FAILED/NEEDS_HUMAN), started_at, ended_at, event_id}`.
- Orchestrator **BỌC** `pipeline.handleEvent` như một step (UNDERSTAND) — gọi 1-1, giữ nguyên throw
  (gateway retry/dedupe hoạt động như cũ); đọc kết quả `{intent, replies, orderId…}` → step DECISION →
  nếu có reply: step SEND (ghi kết quả Action Gate từng reply: sent/gate_decision/delivery_status/mid).
- Mỗi step: `{step_id, run_id, type, input_ref, output_ref, tool_calls[], at}` (+ `output` chi tiết).
  Lưu collections **agent_runs/agent_steps** — persist qua store hiện có (restart giữ nguyên — S1b).
- API: `GET /api/agent/runs?limit=50` + `GET /api/agent/runs/:id` (kèm `started_at_vn/ended_at_vn` giờ VN)
  — dữ liệu cho UI xem lại vệt run (UI xem run để đợt sau).
- **KHÔNG đổi hành vi trả lời**: S1 assert khách vẫn nhận bill; S8e assert qua đường HTTP server;
  toàn bộ regression (18/6/7/11/28/26/32/5 + matrix 245) PASS nguyên trạng, 0 test cũ bị sửa.
- Audit: mỗi run ghi 1 dòng `AGENT_RUN` (stage AGENT) vào chuỗi audit JSONL hiện có.

## 3. HẠNG MỤC 2 — TOOL REGISTRY (src/agent/tools.js)

- **24 tool đúng danh sách đề bài** (đề ghi "23 tool" nhưng liệt kê 24 tên — implement đủ 24 tên,
  khớp từng cái một; S4g + S8a assert exact list).
- Mỗi tool: `{name, description, inputSchema (fields/type/required), outputSchema, sideEffect,
  idempotencyKey(fn) nếu sideEffect, timeoutMs, handler}` — handler **CHỈ ỦY QUYỀN core**
  (không viết lại logic nào).
- `runTool(name, input, ctx)`: validate schema → dedupe idem_key (scope theo run/adhoc; duplicate
  VẪN ghi nhận `DUPLICATE_SUPPRESSED` — agent thấy, không nuốt) → timeout wrapper (sync đo elapsed,
  async race timer → `TOOL_TIMEOUT`; sync overrun báo rõ "side-effect có thể đã xảy ra, cấm tự retry")
  → audit `TOOL:<name>` + ToolCall/ToolResult vào AgentRun đang mở (nếu có).
- Backend chưa cấu hình → `{status:'NOT_CONFIGURED', reason}`: S4e chứng minh với GhnAdapter thiếu
  token → quote_shipping/create_shipment/cancel_shipment đều NOT_CONFIGURED; send_media NOT_CONFIGURED
  (prototype chưa có adapter media outbound) — không giả PASS.
- `listTools()` → `GET /api/agent/tools` (24 tool + schema + configured status; send_media configured=false).
- Tool ghi chú: send_message đi **đúng gate** (`gate.agentSend`, actor human_agent — Window/Quota vẫn do
  gate quyết, S4d: `SENT_PENDING_RECEIPT` đúng BL-5); create/confirm/cancel order đi đúng
  `gate.createOrder/gate.confirmOrder/orders.requestCancelOrder` + đồng bộ state qua `sessions.transition`
  (mirror pipeline/apiCancelOrder — không đụng engine); schedule_follow_up chỉ đặt ROW follow_ups
  (việc GỬI vẫn do scheduler + SendPolicy); opt-out chặn marketing ngay từ lúc đặt lịch (gate chặn lần 2 khi gửi).

## 4. HẠNG MỤC 3 — SHOP PROFILE (src/shop-profile.js + prompt-builder + UI)

- Đủ field: ten, logo, linhVuc, diaChi, hotline, chinhSachDoiTra, gioLamViec, giongNoi, cachXungHo,
  quyTacTuVan, quyTacChotDon, faq[{q,a}], thongTinCamNoi[], cta, chinhSachGiaoHang.
- `GET /api/shop-profile` / `POST /api/shop-profile` — validate kiểu/độ dài + **CHẶN pattern secret**
  (tái dùng `SECRET_VALUE_RE` của prompt-builder — một luật cho cả profile lẫn prompt); field lạ bị từ chối.
- Nối vào prompt: `buildSystemPrompt` thêm mục HỒ SƠ SHOP/QUY TẮC TƯ VẤN/CHÍNH SÁCH GIAO HÀNG/
  THÔNG TIN CẦM NÓI/CTA (additive — prompt cũ giữ nguyên khi không cấu hình, product-ready D5 vẫn PASS);
  `GET /api/prompt` merge bằng `mergePromptConfig` — **profile ưu tiên CAO HƠN prompt_config cũ**
  (field profile không rỗng ĐÈ field trùng tên; field không có trong profile giữ legacy — S8c assert cả 2 hướng).
- UI: Cài đặt → card "Hồ sơ shop cho AI" (form tiếng Việt đủ field, FAQ theo dòng `câu hỏi | trả lời`,
  thông tin cầm nói theo dòng; không đụng secret — cùng trang vẫn hiện đúng nguyên tắc không có API key).

## 5. HẠNG MỤC 4 — DEEPSEEK LIVE WIRE (src/deepseek-wire.js) — KẾT QUẢ THẬT

- Nguồn key: `C:\GaAi-Lab-Test\GaAiLab\backup\model-rename-20261004\provider_config.json`
  (JSON path `config.providerConfigRules.providerRules[]` item `providerId==='deepseek'` →
  `config.access.apiKey`, `config.api.baseUrl`, `personalModelIds`), ghi đè bằng env
  `DEEPSEEK_PROVIDER_CONFIG`. KHÔNG nhận path từ body API (chỉ env/mặc định — chống đọc file tùy ý).
- `readDeepseekRule` + `wireDeepseek` → ghi AI settings shop (provider=deepseek, model=deepseek-chat,
  base_url/models lưu tham chiếu) → `POST /api/ai/wire-deepseek` chạy wire + **gọi THẬT 1 request
  /chat/completions** qua `testAiProvider`.
- **KẾT QUẢ LIVE (chạy thật 2026-10-06)**:
  ```
  (a) WIRE OK — provider=deepseek model=deepseek-chat maskedKey=***42cd models=["deepseek-flash","deepseek-v4-pro"]
  (b) LIVE: ONLINE — model=deepseek-chat maskedKey=***42cd (đã gọi thật /chat/completions)
  (/api/ai/test) status=200 ai.status=ONLINE
  ```
  Key HỢP LỆ → **ONLINE**. Response/console KHÔNG chứa key (assert trong test: không key nguyên văn,
  không 14 ký tự đầu; maskedKey = `***` + 4 cuối). Nhánh key hết hạn/mạng lỗi được code xử lý THẬT
  (status ERROR + error code, exit test vẫn trung thực) — lần chạy này không cần vì key sống.

## 6. HẠNG MỤC 5 — ERROR UX + SCHEDULER TZ (src/errors.js)

- `friendlyError`: bảng rule map lỗi kỹ thuật → tiếng Việt (token hết hạn → "Facebook hết phiên đăng
  nhập…", GHN/carrier → "Không tạo được vận đơn GHN…", AI lỗi → "AI đang tạm gián đoạn…", window/quota/
  opt-out/bot_off/OUT_OF_STOCK/PRICE_CHANGED…). Catch-all server trả `{ok, userMessage, error:<code>}`;
  **technical message CHỈ vào log server** (console.error), không rò ra response.
- TZ: `settings.timezone` mặc định **Asia/Ho_Chi_Minh** (ghi một lần vào ShopSettings của shop);
  `fmtVnTime` (GMT+7, không DST) hiển thị follow-up: `/api/automation` trả `timezone` +
  `upcoming_follow_ups[].scheduled_at_vn` ("2026-10-06 17:00 (GMT+7 · Asia/Ho_Chi_Minh)");
  `vnWallClockToIso` đổi giờ VN nhập vào form về ISO UTC; run detail API trả `started_at_vn/ended_at_vn`.
  DB vẫn lưu ISO UTC (chuẩn hoá) — chỉ lớp hiển thị quy đổi (S6 + S8d assert, gồm case restart-ready).

## 7. TEST MỚI

- **test/suri-agent.js — 19/19 PASS**: S1 run BUY đủ UNDERSTAND→DECISION→SEND + audit + bill nguyên;
  S1b restart persist; S2 HUMAN suppress (không SEND); S3 ảnh lệch → NEEDS_HUMAN; S4a-g chạy ≥ 20 tool
  (đọc loạt, create/update/confirm/cancel draft+order, send qua gate + dedupe, NOT_CONFIGURED GHN thiếu
  token, TOOL_TIMEOUT, TOOL_UNKNOWN/INVALID_INPUT, ToolCall ghi vào run đang mở); S5 shop-profile chặn
  secret + prompt merge; S6 error map + TZ +7 + roundtrip; S7 wire file thật mask assert; S8a-e HTTP API
  (tools/runs/shop-profile/prompt/settings/automation) + bot vẫn trả lời nguyên qua server.
- **test/deepseek-wire.js — PASS, LIVE ONLINE**: (a) đọc file thật + mask; (b) gọi thật — ONLINE
  (nhánh ERROR ghi thật khi key/mạng hỏng).

## 8. KNOWN LIMITATIONS

1. **send_media NOT_CONFIGURED** — platform interface hiện chỉ text (Mock/GHN adapter); cần adapter
   outbound media khi nối live thật.
2. **Timeout sync không preempt** — handler sync (curl sync của live-http) không bị ngắt giữa chừng;
   TOOL_TIMEOUT được báo sau khi gọi trả về (side-effect có thể đã xảy ra — wrapper ghi rõ, cấm tự retry).
   Production cần worker async thật.
3. **Tool-level idempotency adhoc scope theo NGÀY** — gọi API tool ngoài run với cùng input trong cùng
   ngày bị coi là duplicate (escape: `idem_nonce` với send_message); scope trong run là chính xác tuyệt đối.
4. **Orchestrator quan sát, chưa điều khiển LLM** — UNDERSTAND vẫn là pipeline machine-code + AI stub;
   thay SalesAI bằng DeepSeek live (reasoner) là đợt tiếp theo; wire hiện chỉ nối cấu hình + test live.
5. **UI xem AgentRun chưa làm** — API runs/runs/:id đã sẵn dữ liệu + schema (đề bài: "cho UI sau").
6. **quote_shipping GHN** cần mapping district/ward (adapter đã ghi truncation này từ P2) — live phải
   bổ sung onboarding địa chỉ; mock trả phí evidence dùng chung engine.
7. **Matrix runner không tự exit** (hạn chế đã ghi từ P2) — chạy ad-hoc cần timeout; kết quả 245/245
   in đủ trong log trước khi treo.
8. Error UX áp ở catch-all server + tool error; các route 4xx nghiệp vụ giữ body code cũ (test cũ
   phụ thuộc) — map tiếng Việt mở rộng dần theo từng route khi đụng đến.

## 9. FINAL

**Đợt P1 xong đủ 5 hạng mục: orchestrator bọc pipeline (không đổi 1 dòng hành vi trả lời — regression
nguyên trạng 18/6/7/11/28/26/32 + e2e 5/5 + matrix 245/245), registry 24 tool ủy quyền core đúng
chính sách (NOT_CONFIGURED trung thực), shop profile 16 field đè prompt cũ qua mergePromptConfig,
DeepSeek LIVE ONLINE (key thật từ provider_config.json ngoài project, maskedKey ***42cd, không key nào
ra log/API), error UX tiếng Việt + scheduler TZ Asia/Ho_Chi_Minh. 2 test suite mới 19/19 + live-wire
PASS. FREEZE core không bị đụng; thay đổi additive: store (+2 collection), app.js (wiring 3 dòng),
server.js (routes + catch-all error UX), prompt-builder (section mới + scan secret field mới), UI
(card hồ sơ + nút wire).**
