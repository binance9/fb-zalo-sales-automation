# SURI-ASYNC — GATE ĐÓNG LỖI 2: ĐƯỜNG LLM KHÔNG CÒN CHẶN EVENT LOOP

> Ngày: 2026-10-06 · CODEX (implementer) · Phạm vi: LỖI 2 của gate SURI-STABILITY (propose SYNC
> chặn xử lý) — bản vá BẤT ĐỒNG BỘ TỐI THIỂU. Core P3A/P3B/P3C + checkpoint LỖI 1/3 giữ nguyên
> trạng thái (bằng chứng regression §7). Bằng chứng BEFORE: `docs/ASYNC-BEFORE-TRACE.md`.
> Hợp đồng GỬI KÊNH (Action Gate → platform.sendMessage) VẪN SYNC NHƯ CŨ — không đụng.

## 0. TÓM TẮT FINAL

| Hạng mục | Kết quả |
|---|---|
| LỖI 2 — đường LLM chặn event loop | **ĐÃ SỬA — PASS (MOCK)**: propose LLM chuyển bất đồng bộ (`httpOnceAsync` — spawn curl KHÔNG sync); sync-path (stub + httpFn tiêm) giữ nguyên 100% cho toàn bộ regression cũ |
| Event loop block | BEFORE: **6088ms** (health 6088ms, POST tin khách 6079ms) → AFTER: **health 16ms / takeover 6ms / bot-off 5ms / tin đổi ý 15ms** trong lúc AI chờ 6s |
| Reply lạc thời điểm | BEFORE: khách **NHẬN** tư vấn muộn dù takeover/bot-off/đổi ý → AFTER: **0 tin muộn**, gate REJECT (`takeover` / `bot_off` / `stale_user_change` — re-check có sẵn P3C/BL-8 + detectStaleTurn chạy ĐÚNG LÚC GỬI) |
| 8 proof P1-P8 | **9/9 PASS** (P1,P2,P3,P4,P5,P6,P6h,P7,P8) — `test/async-gate.js` exit 0 |
| Regression | **12 suite exit 0 + matrix 245/245 exit 0 + `node --check` toàn repo sạch** (§7) |
| Bug phát hiện thêm khi nghiệm thu | drain "nhảy" đồng hồ ảo tới job tương lai trong lúc reply LLM đang chờ → reply bị đưa về tương lai, window 24h lệch → gate từ chối nhầm. Đã vá trong cùng gate (§4.6, proof P5) |

## 1. SƠ ĐỒ BEFORE (trace đầy đủ: docs/ASYNC-BEFORE-TRACE.md)

```
webhook / UI test / /api/debug/customer-message
  → app.receive → gateway.receive (dedupe, SYNC) → queue
  → app.drain() (gọi NGAY trong handler HTTP)
      → gateway.processQueue → agent.handleIncoming → pipeline.handleEvent (SYNC)
          → routeInfo/routeChitchat/routeBuy… → ai.propose (SYNC)
              → live-http.httpOnce → spawnSync('curl')  ██ CHẶN EVENT LOOP ██
          → gate.sendReply → platform.sendMessage (SYNC — giữ nguyên)
  → HTTP handler mới trả response (sau ~timeout LLM)
```

**Chỗ cần kết quả ĐỒNG BỘ:** luồng mua (`BUY_ASK` — luôn stub sync-instant, không qua LLM),
`gateway.receive` (dedupe cửa vào), `gate.sendReply` + `sendMessage` (hợp đồng kênh LOCKED).
**Chỉ cần kết quả MUỘN rồi gửi:** `PRICE / VARIANT / STOCK / CHITCHAT` (tư vấn trên FACTS) —
chính là 4 intent của `LLM_INTENTS`. Gate đã có re-check ĐẦY ĐỦ ĐÚNG LÚC GỬI trong tx ghi message
(authorize lại + detectStaleTurn — P3C/BL-8 + mitigation-b của gate STABILITY) → chờ muộn là an toàn.

## 2. REPRO BEFORE — SỐ LIỆU (tiến trình khách độc lập, mock AI chậm 6s, server thật)

| Mốc (t+ms) | Sự kiện | Latency |
|---:|---|---:|
| 6255 | POST tin hỏi giá TRẢ VỀ | **6079ms** (handler chờ drain→propose→curl sync) |
| 6264 | GET /api/health trong "cửa sổ chờ" | **6088ms** (đứng sau block) |
| 6267 | POST takeover | 3ms (chạy SAU block) |
| 6270 | POST bot-off | 3ms (sau block) |
| 6279 | tin "đổi ý không mua nữa" | 9ms (sau block) |
| 6283 | state cuối | **out_count = 1 — khách ĐÃ NHẬN tư vấn muộn**, rejected = [] |

Đối chiếu in-process (gate trước): block đo bằng probe tick = 3015ms cho LLM 3s; chỗ chặn
`src/live-http.js:39` spawnSync curl ← `src/sales-ai.js` propose ← `src/pipeline.js` call-sites.

## 3. ALLOWLIST (đã duyệt trong kế hoạch) + DIFF DỰ KIẾN → THỰC TEẾ

| File | Diff dự kiến (duyệt trước) | Thực tế |
|---|---|---|
| `src/live-http.js` | +1 hàm `httpOnceAsync` (spawn KHÔNG sync, stdin body, không worker); giữ `httpOnce` sync cho kênh gửi | Đúng kế hoạch (+30 dòng, header comment cập nhật) |
| `src/sales-ai.js` | đường LLM async; propose trả giá trị \| Promise; stub sync-instant | Đúng: `_tryLLM` tách `_finishLLM` dùng chung; sync khi có `httpFn` tiêm (regression cũ nguyên trạng), async qua `asyncHttpFn \|\| httpOnceAsync` |
| `src/pipeline.js` | await/continuation tại 6 call-site propose, 0 dòng logic | Đúng: helper `_then(pr, cont)` — continuation = ĐÚNG code cũ; 6 site: routeInfo/routeImage-STOCK/routeBuy-VARIANT/routeBuyItems-BUY_ASK/tryCreateOrder-BUY_ASK/routeChitchat |
| `src/app.js` | await/đường ống async | `getAiRuntime` +`base_url` passthrough (B2); `opts.aiAsyncHttpFn` tiêm; +`pendingAsync` tracker `_handleEventTracked`; drain guard (§4.6) |
| `server.js` | chỉ pass-through nếu cần | **KHÔNG đụng** (0 dòng) — `/api/ai/config` pass body sẵn |
| `src/ai-provider.js` | +`base_url` settings (B2 — theo đề bài) | saveAiConfig/getAiConfig/aiView/testAiProvider +`base_url` (validate http(s), KHÔNG phải secret) |
| `src/agent/orchestrator.js` | (phát sinh bắt buộc) handleIncoming: nếu pipeline trả Promise → ghi run sau settle, rejection vẫn throw cho gateway | await-only, 0 dòng quan sát đổi |
| `src/gateway.js` | (phạm vi B3 cho phép "app.js/gateway: await handleEvent") processQueue: thenable → gắn CHÍNH logic retry/FAILED hiện có vào .catch; `receive()` KHÔNG đụng | Đúng — sync path byte-tương đương |
| KHÔNG đụng | Action Gate (`action-gate.js`), order-engine, gateway-receive, sessions, takeover, window/quota/PII/idempotency/receipt | Sạch — `git`-less diff kiểm bằng grep: 0 thay đổi trong các file này |

Thiết kế mấu chốt: **propose trả GIÁ TRỊ THƯỜNG khi đi stub hoặc httpFn sync tiêm (toàn bộ suite cũ
→ chạy SYNC NGUYÊN TRẠNG, không sinh microtask) và chỉ trả PROMISE trên đường LLM production** →
pipeline tiếp diễn qua `_then` — cả hai nhánh dùng ĐÚNG khối code cũ.

## 4. IMPLEMENTATION (điểm từng file)

1. **`live-http.httpOnceAsync`**: `child_process.spawn('curl', …)` + chờ `close`; body qua stdin
   (UTF-8 byte-accurate như fix P2); cùng shape kết quả `{ok,status,bodyText}|{timeout}|{error}`;
   `--max-time` (exit 28 ⇒ `{timeout:true}`) + kill-backstop Node (+5s). Kênh gửi vẫn `httpOnce`.
2. **`sales-ai`**: `_tryLLM` — có `httpFn` ⇒ gọi thẳng sync (như cũ); không ⇒ `asyncHttpFn ||
   httpOnceAsync` ⇒ Promise. `_finishLLM` dùng chung cho cả hai (điều kiện lỗi/fallback stats giữ
   nguyên). `propose`: thenable ⇒ `.then` fallback-stub; không ⇒ trả ngay.
3. **`pipeline._then`** + 6 call-site bọc continuation (0 dòng logic đổi).
4. **`orchestrator.handleIncoming`**: nhánh thenable — record run sau settle; lỗi vẫn throw.
5. **`gateway.processQueue`**: `r.catch(…)` dùng lại đúng khối retry≤3/FAILED (dedupe receive
   nguyên trạng; lỗi async re-queue cùng ngữ nghĩa sync).
6. **`app.js` drain guard** (bug thật bắt được khi nghiệm thu P5 — clock-jump trace ở server thật):
   drain nhảy đồng hồ ảo tới `nextDueAt()` (job tương lai, horizon 3 ngày) — nếu nhảy TRONG LÚC
   reply LLM đang chờ thì reply "tỉnh dậy" ở tương lai (+47.6h thực đo) ⇒ window 24h coi khách
   im lặng ⇒ gate REJECT nhầm `fb_window_closed`. Vá: đọc `pendingAsync` TƯƠI TẠI ĐIỂM KIỂM TRA
   trong vòng lặp (lỗi đầu tiên: chụp giá trị tại lúc vào drain = luôn 0 — đã bắt qua trace);
   `pendingAsync > 0` ⇒ hoãn nhảy (lần drain sau nhảy bình thường). Nhánh không pending giữ
   NGUYÊN hành vi (matrix Follow-up FU01-15 dựa vào nhảy này — PASS nguyên trạng).
7. **`ai-provider` + `app.getAiRuntime`**: `ai_base_url` per shop (mock local/gateway riêng) —
   B2 yêu cầu; phát hiện thêm `getAiRuntime` cũ làm RƠI `base_url` (propose gọi ra internet thay
   vì endpoint shop) — đã passthrough; `/api/ai/test` cũng tôn trọng base_url.

## 5. SAU VÁ — 8 PROOF (test/async-gate.js, exit 0; artifacts: docs/STABILITY-TRACE/async-after-*)

| Proof | Kịch bản | Kết quả + số liệu (timestamp/latency) |
|---|---|---|
| **P1** (HTTP thật) | AI chờ 6s → trong cửa sổ chờ: POST tin giá / GET health / POST takeover / POST bot-off / tin đổi ý | **post 10ms · health 16ms · takeover 6ms · botoff 5ms · change 15ms** — tất cả < 300ms (BEFORE: 6079/6088ms). out_count=0 — khách 0 tin muộn |
| **P2** | takeover giữa chờ → reply muộn | **REJECT `takeover`**, 0 tin tới khách, audit REJECTED:takeover, metric `gate_rejected_takeover`, proposal REJECTED_BY_GATE; drain 8ms, takeover 1ms, event-loop max-gap 18ms |
| **P3** | bot OFF giữa chờ → reply muộn | **REJECT `bot_off`**, 0 tin, audit + metric |
| **P4** | khách "thôi bỏ đơn không mua nữa" giữa chờ | tin đổi ý xử lý ngay **8ms** (kể cả khi LLM chờ); câu tư vấn cũ **KHÔNG gửi** — REJECT `stale_user_change` (audit); tin đổi ý vẫn được nhận xử lý (2 in) |
| **P5** (HTTP + transport thật) | shop đặt `ai_timeout` 3000ms; mockserve 6s | reply fallback về **3126ms** (curl `--max-time 3` → exit 28 → fallback FAQ từ DB) — đúng cấu hình shop, KHÔNG phải 6s mock / 8s default; 0 clock-jump |
| **P6** (in-process nội dung) | 5 khách đồng thời, 5 SP khác nhau (set giá không giao nhau), AI chậm 400ms | 5/5 reply, mỗi conv đúng 1 in + 1 out, **0 cross-talk** (so giá từng reply — không conv nào nhắc giá SP khác), đúng 5 LLM call; 5 lần bắn 11ms |
| **P6h** (HTTP) | 5 khách đồng thời qua HTTP, AI chậm 6s | 5 in / 5 out / 5 agent-run DONE (reply_count=1) — không mất, không lặp |
| **P7** | restart (persist) giữa xử lý và gửi (AI treo vĩnh viễn) | **0 dup send** (0 out từ turn cũ), tin khách nguyên vẹn, follow-up CARE trước restart chạy đúng **1 lần** sau restart (idem `follow_up:<id>`), App2 phục vụ tin mới bình thường |
| **P8** | platform timeout (kết quả CHƯA BIẾT) rồi receipt về muộn | đúng **1 sendMessage** (0 blind retry), trạng thái `SENT_PENDING_RECEIPT` + job `check_send_receipt`, receipt về → `DELIVERED` qua đối soát — đúng INV-2 |

Mỗi proof kèm: bảng timestamp gửi/nhận/xử lý/commit + event-loop probe (max-gap 0-20ms trong lúc
AI chờ, trước đây 3015ms) + API latency (P1). Toàn bộ: `docs/STABILITY-TRACE/async-gate-results.json`.

## 6. REPRO SAU VÁ (cùng kịch bản BEFORE, tiến trình khách độc lập)

| Mốc (t+ms) | Sự kiện | Latency | BEFORE |
|---:|---|---:|---:|
| 10 | POST tin hỏi giá TRẢ VỀ | **10ms** | 6079ms |
| 16 | GET /api/health trong cửa sổ chờ | **16ms** | 6088ms |
| 6 | POST takeover trong cửa sổ chờ | **6ms** | 3ms (nhưng SAU block) |
| 5 | POST bot-off | **5ms** | 3ms (sau block) |
| 15 | tin "đổi ý" | **15ms** | 9ms (sau block) |
| 6299 | settle: **out_count = 0** — khách KHÔNG nhận tin muộn; `REJECTED:bot_off`; mode HUMAN | — | out_count = 1 (nhận tin muộn) |

## 7. REGRESSION (sau mọi thay đổi — chạy lại TOÀN BỘ, không bỏ lượt)

| Suite | Kết quả | Exit |
|---|---|---|
| 18-cases | 18/18 | 0 |
| gate-a | 7/7 | 0 |
| p3b-cases | 11/11 | 0 |
| p3c-cases | 28/28 | 0 |
| invariants-check | 6/6 | 0 |
| e2e-flows (5 area) | toàn bộ PASS | 0 |
| image-match-regression | toàn bộ PASS | 0 |
| live-adapters | 26 case offline PASS | 0 |
| product-ready | 32 case PASS | 0 |
| suri-agent | 19/19 | 0 |
| suri-p2 | 16/16 (gồm `node --check` toàn repo) | 0 |
| stability-cases (S1-S6, G, CFG) | 14/14 (đính chính F3: trước đây ghi 13/13 — G7 thêm từ gate STABILITY, đếm thiếu 1) | 0 |
| **matrix runner** | **245/245 PASS (17-18s/lượt)** | **0** |
| async-gate (mới) | 9/9 | 0 |

`node --check` sạch cho server.js + toàn bộ src/** + test tool mới. Không zombie runner (kiểm
process list sau chạy = 0). Log: `docs/STABILITY-TRACE/async-after-*.log|json`.

## 8. KNOWN LIMITATIONS

1. **Gửi kênh vẫn SYNC** (đúng phạm vi): `platform.sendMessage` trong `gate.executeSend` giữ hợp
   đồng sync — latency kênh gửi nhỏ (mock 5s virtual/receipt; live: 1 HTTPS call) và KHÔNG chặn
   event loop của request khác vì… nó CHẠY TRONG event loop: 1 lần sendMessage live chậm tối đa
   `timeoutMs` của adapter sẽ block loop trong khoảng đó. Đây là hợp đồng LOCKED của Action Gate —
   chỉ mở khi chủ duyệt đổi hợp đồng sendMessage sang async.
2. **Retry pipeline ở đường async** mirror đúng ngữ nghĩa sync (re-queue ≤ 3) nhưng event đã ghi
   một phần state (message in, draft) trước lúc lỗi — như sync path; chưa có cơ chế rollback nghiệp
   vụ riêng cho lần retry thứ 2 (giữ nguyên behavior cũ, không mở rộng trong gate này).
3. **Onboarding test-conversation/test-order** với shop ĐÃ cấu hình LLM ngoài: endpoint trả về
   ngay (`bot_replied` có thể false-negative vì reply LLM đến sau). Không thuộc 8 proof; khuyến
   nghị gate riêng nếu chủ dùng wizard onboarding trên shop có LLM thật.
4. **drain guard**: chỉ hoãn nhảy đồng hồ khi có pending LLM; job tương lai sẽ được nhảy tới ở
   lần drain kế tiếp (tick 2s không nhảy — chỉ runDueJobs). Hành vi nhảy phục vụ test nguyên trạng.
5. **deepseek-wire LIVE ping: ĐÃ PASS trong suri-p2** (đính chính F4 — bản trước ghi "không chạy
   lại" là không nhất quán: suite suri-p2 TỰ CHỨA deepseek-wire và lượt chạy gate này ĐÃ gọi 1
   request /chat/completions THẬT tới DeepSeek — wire + ping PASS, status ONLINE). Riêng ĐƯỜNG
   REPLY LIVE (tin khách → DeepSeek thật → khách) CHƯA chạy: **CHƯA XÁC MINH (LIVE)**.
6. Mock AI chỉ lắng nghe 127.0.0.1; `ai_base_url` validate http(s) nhưng không chặn host nội bộ —
   cấu hình là quyền của chủ shop (không phải secret, view trả nguyên văn).

## 9. FINAL

- **LỖI 2: PASS (MOCK)** — propose LLM bất đồng bộ hoàn chỉnh trên server thật (HTTP + curl spawn
  không sync), 8/8 proof đạt (P6 có 2 mức: nội dung in-process + số lượng HTTP), regression nguyên
  trạng 12 suite + matrix 245/245, `node --check` sạch.
- An toàn nghiệp vụ được bảo bởi CÙNG cơ chế gate có sẵn: re-check authorize + detectStaleTurn
  ĐÚNG LÚC GỬI (P2/P3/P4 chứng minh trên cả đường async thật) — Action Gate/order-engine/receive
  KHÔNG bị đụng.
- LỖI 1/3 giữ nguyên trạng thái: matrix 5×245/245 trước đây + 245/245 lần này, stability 14/14
  (đính chính F3), guard tiền (G1-G6) PASS trong stability-cases.
