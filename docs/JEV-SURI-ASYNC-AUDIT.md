# JEV AUDIT — SURI-ASYNC GATE (LỖI 2: đường LLM chặn event loop)

> Auditor: JEV (READ-ONLY + chạy thử probe) · 2026-10-06 · Đối tượng: docs/SURI-ASYNC.md của CODEX
> Phạm vi: prototype `sales-ai-lab/prototype` · Phương pháp: đọc code + CHẠY LẠI độc lập toàn bộ
> suite + 2 probe riêng (unhandled-rejection, drain-guard clock-jump) — KHÔNG sửa file nào của repo.
> Probe lưu tại `C:\JEV\evidence\jev-async-unhandled-probe.js` + `jev-async-drainguard-probe.js`.

## KẾT LUẬN NHANH

| Mục | Verdict |
|---|---|
| A. Allowlist + DIFF | **PASS** — đúng allowlist, 0 file nhạy cảm bị đụng |
| B. Repro BEFORE | **CHƯA XÁC MINH (tái hiện trực tiếp)** — đã vá + không có toggle sync; artifact BEFORE khớp doc 100%, logic cơ chế xác nhận |
| C. 8 proof sau vá | **PASS** — 9/9 exit 0 (chạy lại độc lập), test THẬT, không fake PASS |
| D. Drain guard §5 | **PASS** — probe: 0ms nhảy khi pending, nhảy lại bình thường sau settle; matrix 245/245; stability 14/14 (S6 PASS) |
| E. Secrets + regression | **PASS** — 0 secret; 12 suite + matrix + async-gate toàn exit 0; `node --check` sạch |
| F. Thiết kế dual-mode | **PASS (kèm quan sát LOW)** — 0 unhandledRejection (probe); race 2 tin xử lý đúng; nhận xét mức LOW |

**Tổng: PASS (MOCK) — không có BLOCKER/HIGH/MEDIUM.** 5 vấn đề mức LOW + 2 mục CHƯA XÁC MINH (liệt kê cuối).

---

## A. ALLOWLIST + DIFF — PASS

Không có git → diff kiểm bằng **mtime + đọc code vùng nhạy cảm + đối chiếu line-number với audit trước** (JEV-STABILITY-AUDIT.md viết 13:24, SAU lần sửa cuối của action-gate 12:52 — nếu file đổi sau đó, line-number sẽ lệch).

**File ĐỔI trong đợt này (mtime ≥ 15:19 06-10) — đúng 100% allowlist:**
| File | mtime | Khớp khai |
|---|---|---|
| src/live-http.js | 15:22 | +`httpOnceAsync` (spawn async, stdin body, kill-backstop max-time+5s, exit 28→timeout); `httpOnce` spawnSync GIỮ NGUYÊN (dòng 20-59 nguyên khối, chỉ thêm comment header) |
| src/sales-ai.js | 15:26 | `_tryLLM` tách `_finishLLM` dùng chung; có `httpFn` → sync như cũ; không → `asyncHttpFn \|\| httpOnceAsync` → Promise; `propose` thenable → `.then` fallback-stub; base_url passthrough |
| src/pipeline.js | 15:29 | helper `_then(pr, cont)` (dòng 392-394); **6 call-site propose đều bọc `_then`**: routeInfo:422, routeImage-STOCK:444, routeBuy-VARIANT:490, routeBuyItems-BUY_ASK:536, tryCreateOrder-BUY_ASK:605, routeChitchat:896 — continuation là ĐÚNG khối code cũ (đọc từng site: chỉ bọc lại điểm gọi, 0 dòng logic đổi) |
| src/agent/orchestrator.js | 15:29 | `handleIncoming`: nhánh thenable ghi run sau settle, rejection vẫn throw cho gateway (dòng 51-64); sync path nguyên trạng |
| src/gateway.js | 15:30 | CHỈ `processQueue`: thêm `.catch(failRow)` cho thenable (dòng 79-84) — tái dùng đúng khối retry≤3/FAILED hiện có; `receive()` KHÔNG đụng (đọc nguyên hàm — dedupe/INV-1 nguyên vẹn) |
| src/ai-provider.js | 15:19 | +`base_url` (saveAiConfig/getAiConfig/aiView/testAiProvider; validate http(s)); key vẫn mask, không echo |
| src/app.js | 16:11 | `getAiRuntime` +`base_url` (dòng 88); `opts.aiAsyncHttpFn` (dòng 96); `pendingAsync` + `_handleEventTracked` (144-162); drain guard (263-284) |

**File KHÔNG ĐỔI (khớp khai "KHÔNG đụng") — mtime TRƯỚC khi gate bắt đầu (~15:00):**
`action-gate.js` (12:52 — đợt STABILITY), `server.js` (10:19), `store.js` (09:29), `order-engine.js` (05-10),
`session.js`, `takeover.js`, `system-templates.js`, `shipping.js`, `product-db.js`, `auth.js`,
channel/shipping adapters, toàn bộ test cũ (18-cases, gate-a, p3b, p3c, invariants, live-adapters,
product-ready, e2e, image-match, suri-agent, suri-p2, stability-cases 13:31, matrix 12:38).
File mới: `test/async-gate.js`, `test/_async-client.js`, `test/_boot-async-server.js`, `test/slow-ai-mock.js` — test-infra cộng thêm, đúng như doc.

**Vùng nhạy cảm đọc trực tiếp — xác nhận nguyên trạng:**
- `action-gate.authorize` (270-332): bot_off → takeover (ai+HUMAN) → marketing/care+HUMAN → opt_out → system-whitelist → WINDOW 24h (BL-1, human_agent_spoofed/utility) → QUOTA Zalo (BL-2) → bad_state. Toàn bộ nguyên vẹn.
- Re-check trong tx ghi message: `executeSend` dòng 500-527 — `authorize` lại (502) + `detectStaleTurn` (509) TRƯỚC `platform.sendMessage` (543, vẫn **SYNC**) — line-number KHỚP CHÍNH XÁC audit STABILITY trước đây (509-510, 543) ⇒ bằng chứng mạnh 0 dòng đổi.
- Receipt store / window / quota / idempotency (BL-5/BL-9): `recordOutboundPending`, `SENT_PENDING_RECEIPT`, reserve/hoàn quota nguyên tử — nguyên vẹn trong file chưa đổi.
- `order-engine.js`, `gateway.receive`, sessions, takeover: mtime cũ + regression 12 suite PASS.

⇒ **Không có file nào ngoài allowlist bị đổi. Không BLOCKER.**

## B. REPRO BEFORE — CHƯA XÁC MINH (tái hiện trực tiếp); artifact + logic: ĐỒNG Ý

- **Không thể tái hiện trực tiếp**: bản vá đã áp; không git để checkout; và **không có toggle production cho đường sync** — grep `aiHttpFn` trong `server.js`/`live-runtime.js`/`live-env.js`: 0 kết quả (server KHÔNG BAO GIỜ tiêm httpFn sync ⇒ production luôn đi async; đường sync chỉ tồn tại khi test tiêm vào).
- **Artifact BEFORE khớp doc 100%**: `docs/STABILITY-TRACE/async-before-repro.json` — recv_price_post latency **6079ms** (t+6255), health **6088ms** (t+6264), takeover/botoff 3ms (sau block), out_count=**1**, out_texts chứa câu mock LLM "…185.000đ…", rejected=[], mode HUMAN, gate_rejected_bot_off=1. Toàn bộ số liệu trong ASYNC-BEFORE-TRACE.md §2 có nguyên bản trong file.
- **Logic cơ chế xác nhận**: `httpOnce` spawnSync curl vẫn tồn tại (live-http.js:41) và được dùng cho kênh gửi — cơ chế "sync curl chặn event loop" là thật; BEFORE xảy ra khi propose cũng đi hàm này (đúng sơ đồ doc).
- **Đối chiếu AFTER bằng chính client đó** (chạy lại trong C): cùng kịch bản giờ là 12/18/7/5/19ms, out_count=0, REJECTED:bot_off — độ tương phản khớp bảng §6 của doc.

Verdict: số liệu BEFORE = **xác thực qua artifact gốc**, tái hiện lại = **CHƯA XÁC MINH** (không còn đường chạy sync ở production — đây cũng là bằng chứng gián tiếp rằng vá có hiệu lực).

## C. 8 PROOF SAU VÁ — PASS (9/9, chạy lại độc lập, test THẬT)

**Chạy lại: `node test/async-gate.js` → 9/9 PASS, EXIT=0** (P2,P3,P4,P6,P7,P8,P5,P6h,P1):

| Proof | Số liệu lần chạy JEV | Khớp doc? |
|---|---|---|
| P2 | drain 4ms · takeover 1ms · loop max-gap 17ms · 0 out · audit REJECTED:takeover · metric · REJECTED_BY_GATE | Đúng |
| P3 | 0 out · audit REJECTED:bot_off · metric | Đúng |
| P4 | tin đổi ý xử lý **6ms** · 2 in · câu tư vấn cũ không gửi · audit stale_user_change | Đúng |
| P6 | 5/5 reply đúng SP — giá per-conv 165000/175000/145000/399000/529000 (không giao nhau, 0 cross-talk) · 5 LLM call · 5 lần bắn 6ms | Đúng |
| P7 | dup=0 · tin vào nguyên vẹn · follow-up CARE chạy đúng 1 lần sau restart · App2 phục vụ tin mới | Đúng |
| P8 | 1 send · SENT_PENDING_RECEIPT → DELIVERED qua receipt · platform.sentCalls=1 (0 blind retry) | Đúng |
| P5 | first_reply **3069ms** (shop timeout 3000ms; mock 6s; default 8s) — transport thật curl `--max-time` | Đúng |
| P6h | 5 in / 5 out / 5 agent-run DONE (reply_count=1) | Đúng |
| P1 | post **12ms** · health **18ms** · takeover **7ms** · botoff **5ms** · change **19ms** · out_count=0 · REJECTED:bot_off · mode HUMAN | Đúng |

**Audit test có fake PASS không — KHÔNG phát hiện:**
- P2/P3/P4 chứng minh bằng **bằng chứng store thật**: `out.length === 0` (messages table) + `audit_events` chứa `REJECTED:takeover|bot_off|stale_user_change` + metric + `ai_proposals.decision='REJECTED_BY_GATE'` — không thể PASS nếu gate không thực sự chặn. (Tính phụ thuộc của assert vào gate đã được gate STABILITY chứng minh ngược bằng monkey-patch `detectStaleTurn→null` ⇒ tin muộn ĐƯỢC GỬI — audit trước, không phải mock cứng.)
- P4 lọc kỹ: chỉ chặn text chứa giá vanilla (của mock) và loại text ACK hệ thống "đang xử lý" của tin đổi ý — assert có nội dung.
- P6 bắt cross-talk bằng **so giá thật trong text reply** với tập giá không giao nhau của 5 SP — không phải assert luôn-đúng.
- P7/P8 đọc trạng thái delivery + `platform.sentCalls` — đo side-effect thật.
- Timing không fake: P2 đo `Date.now()` quanh `fireDrain`; delay LLM do `setTimeout`/hold-promise thật, không phải stub trả lập tức.

**Hạ tầng test độc lập với DeepSeek thật**: P2-P8 in-process tiêm `aiAsyncHttpFn` (không ra mạng); P1/P5/P6h boot **server thật** (`_boot-async-server.js` — GHI RÕ không tiêm gì, transport `httpOnceAsync` + curl thật) + **mock AI chậm local** `slow-ai-mock.js` chỉ listen 127.0.0.1; authDir/shopsRoot cô lập dưới `data/test-runs/`. Config shop qua `/api/ai/config` + `ai_base_url` → mock. **0 đụng DeepSeek/mạng ngoài** trong 9 proof.

## D. DRAIN GUARD §5 (clock-jump) — PASS

- **Code** (app.js:263-284): `allowClockJump = jumpOpt !== undefined ? !!jumpOpt : this.pendingAsync === 0` — đọc `pendingAsync` **TƯƠI TẠI ĐIỂM KIỂM TRA trong vòng lặp** (đúng mô tả §4.6 — lỗi "chụp lúc vào drain" đã tránh); nhánh không pending giữ nguyên nhảy `nextDueAt()` horizon 3 ngày.
- **Probe riêng** (`jev-async-drainguard-probe.js`, exit 0): trong lúc LLM pending + có follow-up ở tương lai → `jump_during_pending_ms = 0`; sau settle → drain nhảy lại bình thường (jump > 0), follow-up chạy `SENT`, `pendingAsync` về 0. **Cả hai nhánh đúng thiết kế.**
- **Server tick (2s)** đọc thêm: pump của server chỉ advance đồng hồ về **wall-clock** (không nhảy tới job tương lai) — không thuộc phạm vi guard, không lệch.
- **Chạy thật**: matrix **245/245 PASS, exit 0, 17.2s** — khu vực **Follow-up 15/15 PASS** (nghĩa là hành vi nhảy cũ khi KHÔNG pending còn nguyên); stability-cases **14/14 PASS exit 0** gồm **S6 follow-up restart PASS**.
- Lưu ý: doc ghi "stability 13/13" nhưng suite hiện tại có **14 case** (G7 thêm từ gate STABILITY, file 13:31) — số trong doc stale, không phải lỗi code.

## E. SECRETS + REGRESSION ĐẦY ĐỦ — PASS

- **Secrets**: grep `sk-`/token trong toàn bộ src + server.js + test + docs/log đợt này: chỉ có **key giả trong test** dùng để assert masking/redact (`sk-abc123def456`, `sk-fixture1234567890`, `sk-abc123def`, `sk-probe-*`, `sk-async-gate-0001`, `sk-p7-0001` — offline, không ra mạng) và log mock. `.env.live`: toàn bộ giá trị RỖNG. **0 secret thật.**
- **Chạy trọn bộ (độc lập, lần lượt):**

| Suite | Kết quả | Exit |
|---|---|---|
| 18-cases | 18/18 | 0 |
| gate-a | 7/7 | 0 |
| p3b-cases | 11/11 | 0 |
| p3c-cases | 28/28 | 0 |
| invariants-check | 6/6 | 0 |
| live-adapters | 26/26 | 0 |
| product-ready | 32/32 (gồm node --check) | 0 |
| e2e-flows | 5/5 flows | 0 |
| image-match-regression | 6/6 | 0 |
| suri-agent | 19/19 | 0 |
| suri-p2 | 16/16 (gồm F1 `node --check` toàn repo) | 0 |
| stability-cases | **14/14** (doc ghi 13/13 — stale) | 0 |
| matrix | **245/245** (17.2s, tự exit sạch — không cần kill) | 0 |
| async-gate | 9/9 | 0 |

- `node --check` tự chạy lại toàn bộ server.js + src/** + test/**: sạch. Sau chạy: không còn process test nào giữ port (58660/58661/49479/49480 đều trống) — **0 zombie**.

## F. ĐÁNH GIÁ THIẾT KẾ — PASS (kèm nhận xét LOW)

- **Dual-mode ổn định**: propose trả GIÁ TRỊ (stub / httpFn sync tiêm — toàn bộ 12 suite cũ chạy SYNC nguyên trạng, không sinh microtask) hoặc PROMISE (chỉ 4 intent `LLM_INTENTS` trên đường production). `_then` chọn đồng bộ khi có giá trị → 0 khác biệt hành vi với regression cũ (được 12 suite chứng minh lại).
- **Unhandled rejection — probe 3 case (exit 0, 0 unhandledRejection)**:
  1. `asyncHttpFn` tự REJECT → `_tryLLM` bắt trong `.catch` → fallback stub → khách vẫn nhận 1 tin (`llm_fallback=1`);
  2. continuation ném lỗi (sendReply throw) → rejection đi orchestrator (run FAILED có ghi) → `_handleEventTracked` rethrow → **gateway `.catch` → retry≤3 re-queue đúng cơ chế cũ** (row attempts=1, queue=1);
  3. `httpOnceAsync` bản thân resolve-only (không bao giờ reject). Mọi đường tiêu thụ (3 call-site `processQueue` trong server.js:926/1498/1529) đều đi qua gateway nơi `.catch` được gắn — **không còn kẽ hở unhandled**.
- **Race 2 tin cùng conversation khi LLM chờ**: tin 2 xử lý NGAY (probe: 4ms) — queue/drain không kẹt; cả 2 reply ra đủ (2in/2out, 2 LLM call). Reply có thể **đảo thứ tự** (thiết kế chấp nhận cho intent tư vấn); tín hiệu NGUY HIỂM (hủy/đổi ý) bị `detectStaleTurn` re-check ĐÚNG LÚC GỬI (P4 + probe xác nhận); các transition trong continuation đều có guard state (NEW_LEAD/DISCOVERY…) nên continuation muộn không đè state mới.

**Nhận xét LOW (không chặn gate):**
1. **Facts snapshot stale trên đường async**: facts chụp lúc propose; nếu DB đổi giá trong lúc chờ, câu tư vấn gửi muộn mang giá cũ (gate chỉ đè số khi against allowedMoney/đơn — tư vấn thuần vẫn lech). Cùng lớp rủi ro với Known Limitation §8.2; khuyến nghị re-fetch facts trong continuation ở gate sau nếu shop hay đổi giá.
2. `pipeline.routeRepurchase` (589-591) gắn `res.repurchase` SAU khi gọi `routeBuyItems` — nếu nhánh đó từng trả Promise, metadata sẽ gắn nhầm lên object Promise. Hiện không thể tới (items luôn khác rỗng + BUY_ASK luôn stub-sync) — bẫy tiềm ẩn nếu sau này cho phép async ở nhánh đó.
3. **Doc §7 stale**: stability ghi 13/13, thực tế suite 14/14 (G7).
4. **Doc §8.5 không nhất quán**: nói "deepseek-wire LIVE không chạy lại" nhưng `suri-p2` (được liệt kê đã chạy) TỰ CHỨA deepseek-wire và lượt chạy của tôi nó ĐÃ gọi ping thật tới DeepSeek (PASS). Phần cốt lõi vẫn đúng: **đường propose LIVE (tin khách → DeepSeek → khách) CHƯA được chạy** — CHƯA XÁC MINH (LIVE).
5. §8.6 (đã khai): `ai_base_url` nhận mọi http(s) host — không chặn host nội bộ; mock chỉ 127.0.0.1. Chấp nhận ở cấp prototype.

**CHƯA XÁC MINH (tổng):**
- Tái hiện BEFORE trực tiếp (đã vá, không toggle sync — xác thực qua artifact `async-before-repro.json` + logic).
- Đường LLM LIVE thật (tin khách → DeepSeek thật → khách) — như chính doc §8.5; ping provider LIVE đã vô tình chạy trong suri-p2 và PASS.
- Kênh GỬI vẫn SYNC (hợp đồng LOCKED — §8.1): 1 sendMessage live chậm vẫn block loop trong timeoutMs của adapter — chưa mở, đúng phạm vi.

---

## BẢNG TỔNG

| # | Hạng mục | Verdict |
|---|---|---|
| A | Allowlist + DIFF (action-gate/order-engine/receive/receipt/window/quota 0 dòng đổi) | **PASS** |
| B | Repro BEFORE (6079/6088ms, khách nhận tư vấn muộn) | **CHƯA XÁC MINH (tái hiện)** — artifact khớp 100%, logic xác nhận |
| C | 8 proof (9/9) chạy lại độc lập + audit fake-PASS | **PASS** |
| D | Drain guard §5 + matrix 245/245 + follow-up + stability + S6 | **PASS** |
| E | Secrets 0 + full regression exit 0 | **PASS** |
| F | Thiết kế dual-mode / unhandled rejection / race | **PASS** (nhận xét LOW) |

**Vấn đề theo mức: BLOCKER: 0 · HIGH: 0 · MEDIUM: 0 · LOW: 5 (F1-F5 trên) · CHƯA XÁC MINH: 2 (B-tái hiện, LIVE LLM).**

*Probe phục vụ đối chiếu: `C:\JEV\evidence\jev-async-unhandled-probe.js`, `C:\JEV\evidence\jev-async-drainguard-probe.js` (chỉ require code, không sửa repo).*
