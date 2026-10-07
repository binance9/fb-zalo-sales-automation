# SURI-ASYNC — BYPASS TRƯỚC KHI VÁ (LỖI 2: ĐƯỜNG LLM CHẶN EVENT LOOP)

> Ngày: 2026-10-06 · CODEX (implementer) · Gate: SURI-ASYNC · Trạng thái tài liệu: BEFORE (bằng chứng gốc).
> Repro qua HTTP THẬT với TIẾN TRÌNH KHÁCH ĐỘC LẬP (`test/_async-client.js`) — server prototype
> chạy tiến trình riêng (`test/_boot-async-server.js`, authDir/shopsRoot CÔ LẬP dưới
> `data/test-runs/async-before/`, không đụng data thật), AI là MOCK CHẬM local
> (`test/slow-ai-mock.js`, OpenAI-compatible, trả lời sau 6000ms; KHÔNG đụng DeepSeek thật).
> Cấu hình shop AI trỏ vào mock qua `ai_base_url` (thêm mới, allowlist — xem SURI-ASYNC.md §3).

## 1. SƠ ĐỒ TRACE BEFORE — luồng 1 tin khách hỏi giá

```
[webhook / UI test / /api/debug/customer-message]
        │  (HTTP handler — server.js, async)
        ▼
app.receive(ev)                       — gateway.receive: dedupe + push queue (SYNC)
        ▼
app.drain()  ←── gọi NGAY trong handler  (server.js /api/debug/customer-message)
        │   └─ gateway.processQueue()  (SYNC loop)
        │        └─ onEvent = agent.handleIncoming(ev)   (orchestrator — SYNC)
        │             └─ pipeline.handleEvent(ev)        (SYNC)
        │                  ├─ sessions.ensureCustomer/Conversation + insert messages
        │                  ├─ detectIntent → 'PRICE'
        │                  └─ routeInfo(conv, customer, event, text, 'PRICE')
        │                       ├─ buildFacts (fresh từ ProductDB)
        │                       ├─ ai.propose('PRICE', ctx)                    ← SYNC
        │                       │    └─ SalesAI._tryLLM → httpFn || httpOnce   ← SYNC
        │                       │         └─ live-http.httpOnce → spawnSync('curl', …)
        │                       │              ██ CHẶN EVENT LOOP suốt thời gian curl ██
        │                       │              (mock chậm 6s → block 6s; worst case = timeout LLM,
        │                       │               mặc định 8s sau mitigation, cấu hình tới 120s)
        │                       └─ gate.sendReply(proposal)  — Action Gate (SYNC, giữ nguyên)
        │                            ├─ authorize (bot_on / mode / window / quota / PII / money-guard)
        │                            ├─ platform.sendMessage (SYNC — hợp đồng kênh giữ nguyên)
        │                            └─ tx ghi message + audit
        ▼
HTTP handler MỚI trả response cho client  (sau ~6s!)
```

### Chỗ nào CẦN kết quả ĐỒNG BỘ (liệt kê + lý do)
| Điểm | Vì sao cần kết quả ngay |
|---|---|
| `routeBuyItems` → `ai.propose('BUY_ASK', …)` (pipeline.js:521) | Câu hỏi-thiếu phải đi NGAY trong cùng tick của tin mua (khách đang rải SĐT/địa chỉ); NHƯNG `BUY_ASK` không nằm trong `LLM_INTENTS` → luôn đi STUB (sync-instant) → không cần async |
| `tryCreateOrder` → `ai.propose('BUY_ASK', …)` (pipeline.js:588) | Như trên — stub, sync |
| `gate.sendReply` + `platform.sendMessage` | Hợp đồng Action Gate LOCKED — giữ SYNC như cũ (đề bài CẤM đổi) |
| `gateway.receive` → dedupe + queue | SYNC cửa vào — giữ nguyên (INV-1) |

### Chỗ nào chỉ cần kết quả MUỘN rồi gửi (async được)
| Điểm | Intent | Lý do |
|---|---|---|
| `routeInfo` → `ai.propose` (pipeline.js:413) | PRICE / VARIANT / ATTR_UNKNOWN | Tư vấn giá/tồn — trả muộn vài giây vẫn đúng nghiệp vụ; gate RE-CHECK tại lúc gửi (authorize + detectStaleTurn trong tx — P3C/BL-8 + mitigation-b của gate STABILITY) tự chặn reply lạc thời điểm |
| `routeImage` → `ai.propose('STOCK')` (pipeline.js:433) | STOCK (ảnh) | Như trên |
| `routeBuy` nhánh ambiguous → `ai.propose('VARIANT')` (pipeline.js:477) | VARIANT | Câu hỏi chọn size/màu — muộn OK |
| `routeChitchat` → `ai.propose('CHITCHAT')` (pipeline.js:877) | CHITCHAT | Trò chuyện — muộn OK |

### File/hợp đồng bị ảnh hưởng nếu bất đồng bộ hóa
- `src/live-http.js` — +1 hàm `httpOnceAsync` (spawn KHÔNG sync); hàm sync cũ GIỮ NGUYÊN cho kênh gửi (Action Gate).
- `src/sales-ai.js` — đường LLM dùng async http; propose trả **giá trị thường (stub/sync-http) HOẶC Promise (LLM)** để toàn bộ suite cũ giữ ngữ nghĩa SYNC.
- `src/pipeline.js` — 6 call-site `ai.propose`: bọc continuation (`_then` helper) — 0 dòng logic.
- `src/agent/orchestrator.js` — `handleIncoming`: nếu pipeline trả Promise → ghi run sau khi settle (await-only).
- `src/gateway.js` — `processQueue`: nếu onEvent trả Promise → bắt rejection bằng CHÍNH logic retry/FAILED hiện có (receive KHÔNG đụng).
- `src/app.js`, `server.js` — KHÔNG phải đổi flow (drain giữ sync; reply muộn settle qua promise + tick persist).
- **FREEZE (không đụng):** Action Gate (`action-gate.js` — sendReply/authorize/executeSend/detectStaleTurn), order-engine, gateway.receive, sessions/state machine, takeover, window/quota/PII/idempotency/receipt.

## 2. REPRO BEFORE — SỐ LIỆU (chạy thật, log: `docs/STABILITY-TRACE/async-before-repro.log`)

Bối cảnh: server prototype tiến trình riêng (persist, port ephemeral 49480); mock AI chậm 6000ms
(port 49479); shop AI = deepseek + `ai_base_url`→mock + timeout 30000ms. Client ĐỘC LẬP
(`node test/_async-client.js --scenario repro`): (a) bắn tin hỏi giá → NGAY LẬP TỨC (b) GET
/api/health, (c) POST takeover, (d) POST bot-off, (e) bắn tin khách "đổi ý không mua nữa".

| Mốc (t+ms) | Sự kiện | Latency call |
|---:|---|---:|
| 175 | zero (client bắt đầu) | — |
| 6255 | **recv_price_post** — POST tin hỏi giá TRẢ VỀ | **6079ms** (handler chờ drain→propose→curl sync 6s) |
| 6264 | **health_during_wait** — GET /api/health | **6088ms** (đứng sau block trong event loop) |
| 6267 | takeover_during_wait — POST takeover | 3ms (chạy SAU khi block xong) |
| 6270 | botoff_during_wait — POST bot off | 3ms (sau block) |
| 6279 | change_idea_post — tin "đổi ý không mua nữa" | 9ms (sau block) |
| 6281 | health_after | 1ms |
| 6283 | settle (đọc state) | out_count=1 |

Kết quả state cuối (đọc db.json của shop sau scenario):
- **Khách ĐÃ NHẬN câu tư vấn AI muộn**: `out_texts = ["Dạ nến thơm vanilla size M giá 185.000đ nha anh/chị ạ!"]`
  (text do MOCK LLM viết — chứng minh đi đúng đường LLM, engine=llm:deepseek, `llm_ok=1`).
- mode conversation = HUMAN (takeover Có HIỆU LỰC — nhưng SAU khi tin đã gửi).
- `rejected = []`, `proposals_rejected = 0`, `metric gate_rejected_takeover = 0` — **không gì chặn được
  tin muộn vì mọi tín hiệu (takeover/bot-off/đổi ý) chỉ đến SAU khi send đã xảy ra trong block**.
- `metric gate_rejected_bot_off = 1` — tin "đổi ý" xử lý sau bị gate từ chối gửi (bot đã off).

Đối chiếu in-process (gate STABILITY trước đây, `test/_probe-stability.js`): block event loop đo bằng
probe tick 20ms = **3015ms** cho LLM chậm 3s — khớp cơ chế (block == thời gian curl), chỗ chặn xác
minh `src/live-http.js:39` `spawnSync('curl', …)` gọi từ `src/sales-ai.js` propose SYNC.

## 3. KẾT LUẬN BEFORE

1. **1 tin khách hỏi giá chặn TOÀN BỘ server ~timeout LLM** (thực đo 6.08s với mock 6s; worst case
   = timeout cấu hình — 8s mặc định, tới 120s nếu chủ tăng).
2. Trong cửa sổ chờ: health/takeover/bot-off/tin đổi ý đều KHÔNG thể xử lý (queued sau block).
3. Hậu quả nghiệp vụ thật: **khách vẫn nhận tư vấn SAI THỜI ĐIỂM** dù đã takeover/bot-off/đổi ý —
   because Action Gate chỉ re-check ĐÚNG LÚC send, mà send đã xảy ra trước khi tín hiệu kịp đến.
4. Đây là bằng chứng gốc để đối chiếu SAU VÁ (SURI-ASYNC.md — 8 proof P1-P8).
