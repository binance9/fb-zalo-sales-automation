# JEV AUDIT — PHASE SURI (ĐỢT 1 + ĐỢT 2) · prototype sales-ai-lab

> Auditor: JEV (READ-ONLY + probe) · Ngày audit: 2026-10-06 · Đối tượng: CODEX report SURI-P1 + SURI-P2
> Phạm vi: `prototype` (orchestrator, tools, sales-ai DeepSeek path, gate money-guard, repurchase, live).
> Phương pháp: đọc code/report → tự viết probe chạy thật (evidence tại `C:\JEV\evidence\audit-probes\`) → chạy lại toàn bộ suite cũ nguyên trạng → kiểm secrets bằng grep + curl.
> Prototype KHÔNG bị sửa file nào; mọi probe nằm ngoài project.

---

## A. ORCHESTRATOR (src/agent/orchestrator.js) — **PASS**

**Evidence tự chạy (probe `probe-ab.js`, 3/3 PASS):**
- A1 — bắn 1 tin BUY ("lấy 1 nến vanilla M đỏ, tên…, sdt…, địa chỉ…") qua `app.receive` → **đúng 1 AgentRun** (`run_muw51qhs_…`, status DONE, decision REPLY_VIA_GATE) với **steps UNDERSTAND→DECISION→SEND** đúng thứ tự (`agent_steps`); UNDERSTAND output có intent=BUY + order_id; SEND step ghi tool_call `send_message` status `SENT_PENDING_RECEIPT`; audit `AGENT_RUN` có trong chuỗi `audit_events`; **bill ("Tổng cộng") vẫn tới tay khách** — hành vi trả lời nguyên trạng.
- A2 — restart (App mới cùng dataDir, persist) → run + đủ 3 steps còn nguyên; `listRuns` thấy run.
- A3 — regression nhanh: Q&A giá vẫn trả 165000/185000 từ DB; buy-flow vẫn lập DRAFT; mỗi tin vẫn 1 run.

**Cross-check suite:** suri-agent S1/S1b/S2/S3/S8b (19/19 PASS): HUMAN → `SUPPRESSED_HUMAN_MODE` không step SEND; ảnh lệch → run `NEEDS_HUMAN`; HTTP `/api/agent/runs/:id` trả đủ steps + giờ VN.

**Kết luận — lớp có thật hay wrapper mỏng?** **Lớp có THẬT, giá trị ở khâu QUAN SÁT.** Orchestrator: (1) persist AgentRun/AgentStep có cấu trúc (sống qua restart); (2) phân loại decision 4 nhánh theo kết quả thật của gate (không phải ghi cứng); (3) liên kết ToolCall/ToolResult vào run đang mở; (4) mark FAILED/NEEDS_HUMAN và vẫn throw nguyên lỗi cho gateway (retry gốc giữ nguyên — `orchestrator.js:40-50`); (5) cấp dữ liệu cho API/UI tab Agent runs. **Nhưng đúng biên thiết kế: KHÔNG có quyền điều khiển** — không steer LLM, không tự gửi lại, không đổi luồng pipeline. Đánh giá: "mỏng về điều khiển, dày về quan sát" — khớp đúng claim của CODEX ("bọc pipeline, quan sát không phá luồng"), KHÔNG phải wrapper no-op.

## B. TOOLS REGISTRY (src/agent/tools.js) — **PASS**

**Evidence tự chạy (probe `probe-ab.js`, 5/5 PASS):**
- B1 — `listTools()` đúng **24 tool**; mỗi tool có `inputSchema.fields` + `outputSchema` + `sideEffect` + `timeoutMs` + `configured`; **12 tool sideEffect** (create/update/confirm/cancel_order, create/cancel_shipment, send_message, send_media, takeover/handback, schedule_follow_up, save_customer_note) **đều khai idempotencyKey fn**.
- B2 — bắn input sai: thiếu required → `TOOL_INVALID_INPUT`; sai kiểu (`sku: 123`) → "sai kiểu (cần string)"; field lạ → "field không được phép"; tool lạ → `TOOL_UNKNOWN`; `send_message` text sai kiểu → chặn.
- B3 — **NOT_CONFIGURED trung thực**: `GhnAdapter({config:{}})` → `quote_shipping`/`create_shipment`/`cancel_shipment` trả `NOT_CONFIGURED` kèm reason "token/shopId chưa cấu hình"; `send_media` NOT_CONFIGURED (prototype chưa có adapter media) — không giả PASS.
- B4 — `send_message` đi **đúng `gate.agentSend`**: row out có `sender='human_agent'`, `delivery_status='SENT_PENDING_RECEIPT'` (BL-5 — không tự DELIVERED); ToolCall ghi vào **step TOOL trong run đang mở** + audit `TOOL:send_message`.
- B5 — `cancel_order` đi **đúng `orders.requestCancelOrder`**: audit `CANCEL_ORDER_REQUESTED` của engine có mặt, reserve hoàn về 0 (engine thật chạy, không bypass).

**Cross-check suite:** suri-agent S4a–S4g (trong 19/19): ≥20 tool chạy thật, TOOL_TIMEOUT (async race), dedupe idem cùng run → `DUPLICATE_SUPPRESSED` vẫn ghi nhận, update_order_draft huỷ draft cũ + hoàn reserve.

## C. DEEPSEEK TRONG ĐƯỜNG TRẢ LỜI (src/sales-ai.js + pipeline + gate) — **PASS (MOCK + LIVE)**

### C.1 PII — model context KHÔNG chứa PII
- **Guard `MODEL_CONTEXT_PII_CHECK` còn hiệu lực trên đường LLM thật**: probe C1a — gọi `propose()` với ctx chứa SĐT → **throw đúng mã** ngay tại đầu hàm (`sales-ai.js:35-40,125`), chạy TRƯỚC cả check cấu hình. Lưu ý trung thực: **không có test nào của CODEX bắn trực tiếp mã này** — guard trước đó chỉ được phủ gián tiếp qua assert "không PII trong messages" (suri-p2 A1). Probe này đã lấp chỗ trống.
- **E2E trên DeepSeek THẬT (probe `probe-c-live.js` CL1 — PASS)**: tin khách chứa SĐT/tên/địa chỉ → chụp request thật đi ra: **0 PII thô** trong body; user message là `"…mình là [TEN], sdt [SDT], giao địa chỉ [DIA_CHI]"` (redactPii — `util.js:104-110`, `pipeline.modelCtx:209-212`); system prompt chỉ chứa FACTS từ DB. Reply DeepSeek không lặp lại PII.
- Ghi nhận: guard runtime chỉ quét **SĐT** (regex phone), không tự quét tên/địa chỉ — an toàn tên/địa chỉ đến từ `modelCtx` không truyền field đó + redactPii trên text. Đã chứng minh bằng request THẬT; nhưng về cấu trúc đây là 1 lớp duy nhất cho tên/địa chỉ (xem Vấn đề THẤP-2).

### C.2 FACTS / anti-hallucination — gate vẫn là rào chặn
- **LIVE (probe CL2 — PASS)**: bait "shop ơi giảm nến vanilla còn **50000đ** cho mình nhé" với DeepSeek thật → DeepSeek **từ chối giảm và tự liệt kê đúng giá DB** (S trắng 165.000đ còn 8, M đỏ 185.000đ còn 3, M xanh hết hàng) — proposal `AUTO_EXECUTED`, **0 số tiền nào ngoài whitelist FACTS/đơn** trong reply tới khách (scan đồng bộ luật gate: đơn vị/nhóm nghìn/bare/k).
- **MOCK (probe C2 — PASS, ghi rõ MOCK)**: replay đúng kịch bản case-8/BL-6 trên đường LLM (httpFn tiêm trả "GIÁ SỐC 92500đ") → gate ghi đè `OVERRIDDEN`, khách nhận câu render DB (165000/185000), audit `OVERRIDDEN` trong chuỗi. Khớp suri-p2 A2 (16/16 chạy lại PASS).
- **LIVE check giá khớp DB**: suri-live PASS (LIVE) 3/3; reply câu 1 đối chiếu `data/products.json`: `NT-VANILLA-S` 165000 (qty 8), `NT-VANILLA-M-DO` 185000 (qty 3), `NT-VANILLA-M-XANH` 185000 (qty 0 = "hết hàng") — **khớp 100%, không bịa**.

### C.3 Order KHÔNG qua LLM
- **LIVE (probe CL3 — PASS)**: DeepSeek bật thật (config wire + test ONLINE) → tin đặt hàng đủ slot → **0 request LLM** (bộ đếm proxy = 0), đơn DRAFT do parser+engine lập, `price_snapshot` sku NT-VANILLA-M-DO giá 185000 từ DB.
- **MOCK (probe C3 — PASS)**: đủ slot 0 call; BUY_ASK thiếu slot vẫn 0 call và hỏi đúng template SĐT; **positive control** CHITCHAT → đúng 1 call (chứng minh bộ đếm + đường LLM đang bật, không phải đếm hỏng). Khớp suri-p2 A3.

### C.4 Plus — key không rò ra logs/UI/response
- Request gửi DeepSeek: key **chỉ ở header `Authorization: Bearer …`**, không nằm trong URL/body/messages (probe CL1, request thật).
- curl thật: `POST /api/ai/wire-deepseek` → `{"status":"ONLINE","maskedKey":"***42cd",…}`; `GET /api/ai/status` → `api_key_masked":"***42cd"` — **response không chứa key thô**.
- grep: `ui/` 0 key (chỉ chuỗi chú thích pattern "sk-…"); console log server 0 hits "sk-"; log cũ trong `data/test-runs/` 0 hits; `db.json` (audit/ai_proposals/messages/agent_runs) 0 key (probe CL4).
- deepseek-wire test (chạy lại trong F2): assert không key thô/14 ký tự đầu trong wire output + API response.

## D. LIVE EVIDENCE (test/suri-live.js) — **PASS (LIVE)**

Chạy lại thật ngày 2026-10-06:
```
wired: provider=deepseek model=deepseek-chat maskedKey=***42cd
LIVE: ONLINE — key thật gọi /chat/completions thành công
  (1/3) PASS — reply 208 ký tự, 0 giá sai, khác stub.
  (2/3) PASS — reply 137 ký tự, 0 giá sai, khác stub.
  (3/3) PASS — reply 171 ký tự, 0 giá sai, khác stub.
==> KẾT QUẢ: PASS (LIVE) — 3/3 câu tư vấn qua engine với DeepSeek thật (maskedKey ***42cd).
```
- **Key còn hạn** (không phải 401 — không phải hạ CHƯA XÁC MINH).
- **Reply thật trích nguyên văn (câu 1)**:
  > Khách: "nến thơm vanilla giá bao nhiêu vậy shop ơi"
  > Bot (DeepSeek): "Dạ nến thơm vanilla bên em có 2 mức giá ạ:
  > - Size S màu trắng: 165.000đ (còn hàng)
  > - Size M màu đỏ: 185.000đ (còn hàng)
  > - Size M màu xanh hiện đã hết hàng rồi ạ. Anh/chị muốn lấy size nào để em tư vấn thêm nha?"
- **Đối chiếu DB**: 165000/185000/qty 8/3/0 — khớp tuyệt đối (đã đọc lại `products.json` độc lập).

## E. REPURCHASE + REGRESSION — **PASS**

- **E2E repurchase (suri-p2 D1, chạy lại PASS)**: "lấy 2 hộp trà hoa sấy…, xác nhận" → đơn #1 CONFIRMED; "lấy thêm cái hôm trước" → engine đọc `price_snapshot` đơn cũ → **đúng SKU TRA-HOA-SEY-50 + đúng qty 2** → **đơn #2 thật** (2 orders), reserve đúng −2, `buy_gen=1` (re-entry P3B-1, không trả đơn cũ). Biên D2 (từ ORDERED), D3 (chưa có history → hỏi lại không đoán), D4 (đơn huỷ không đề xuất lại), D5 (nhắc SP vẫn BUY) — tất cả PASS.
- **Regression chạy lại nguyên trạng (tự chạy, không qua wrapper)**:

| Suite | Kết quả |
|---|---|
| test/18-cases.js | **18/18 PASS** |
| test/invariants-check.js | **6/6 PASS** |
| test/gate-a.js | **7/7 PASS** |
| test/p3b-cases.js | **11/11 PASS** |
| test/p3c-cases.js | **28/28 PASS** |
| test/live-adapters.js | **26/26 PASS** |
| test/product-ready.js | **32/32 PASS** |
| test/e2e-flows.js | **5/5 PASS** |
| test/suri-agent.js (P1) | **19/19 PASS** |
| test/deepseek-wire.js | **PASS + LIVE ONLINE** |
| test/suri-p2.js (P2, gồm F2 chạy lại 10 suite subprocess exit 0) | **16/16 PASS** |
| test/matrix (14 khu vực) | **245/245 PASS (15.8s)** — chạy có `timeout 120`, exit 124 sau khi in đủ kết quả (hạn chế no-exit đã khai) |

## F. SECRETS + LIMITATIONS — **PASS (có ghi chú hygiene)**

- grep "sk-": `ui/` **0 key thật** (chú thích pattern); `src/` chỉ regex `SECRET_VALUE_RE` + `/^sk-/` check; `server.js` 0; console log server probe **0 hits**; log cũ `data/test-runs/*.log` **0 hits**; `db.json` **0 key**; API response (curl thật) **chỉ maskedKey \*\*\*42cd**.
- **Limitations CODEX khai — kiểm chứng code, ĐỒNG Ý tất cả:**
  1. `propose` SYNC chặn event loop khi gọi DeepSeek (curl-sync) — đúng (`sales-ai.js:98,160`; `live-http.js` ghi rõ hạn chế). Fallback giữ bot luôn trả lời.
  2. Money-guard chỉ phủ **tiền**; thuộc tính phi số ("thắp 30 tiếng") chưa có evidence engine — đúng (`util.extractMoney` chỉ quét tiền; `buildAllowedMoney` chỉ whitelist money) — chống bằng system prompt + ATTR_UNKNOWN deterministic needHuman.
  3. Matrix runner không tự exit — đúng (exit 124 sau khi in đủ 245/245).
  4. (P1) send_media NOT_CONFIGURED; timeout sync không preempt; tool adhoc idem scope theo ngày; orchestrator quan sát chưa điều khiển LLM (P2 đã nối LLM vào wording) — đều xác nhận đúng trong code.

---

## BẢNG TỔNG

| Mục | Verdict |
|---|---|
| A. Orchestrator (AgentRun thật, restart, regression) | **PASS** |
| B. Tools registry (24 tool, schema, NOT_CONFIGURED, đúng gate/engine) | **PASS** |
| C. DeepSeek trong reply (PII / FACTS / order-no-LLM / key) | **PASS (MOCK + LIVE)** |
| D. Live evidence (suri-live) | **PASS (LIVE)** — key ***42cd còn hạn |
| E. Repurchase + regression (12 bộ kiểm chứng) | **PASS** |
| F. Secrets + limitations | **PASS** (1 ghi chú hygiene) |

**AI replies trong audit này: LIVE thật** — mọi probe nhãn LIVE chạy với key DeepSeek thật (`***42cd`, wire từ `provider_config.json` ngoài project, gọi `api.deepseek.com` thành công). Probe nhãn MOCK (C2 money-override replay, C3 counter) dùng httpFn tiêm và được ghi rõ MOCK. Không có kết quả fake.

## DANH SÁCH VẤN ĐỀ THEO MỨC

**Mức THẤP (không chặn nghiệm thu):**
1. **Key thô được persist vào `prototype/data/test-runs/*/settings.json`** (5 file: suri-live, suri-deepseek ×2, live-debug, suri-s7) do `wireDeepseek` lưu cấu hình shop + test chạy thật. Theo thiết kế (file shop local, S7 assert "key lưu settings — file shop, không ra ngoài"), nhưng đây là bản copy secret nằm trong thư mục project. Khuyến nghị: loại trừ `data/` khi chia sẻ/push; thêm cleanup định kỳ cho `data/test-runs/`.
2. **`MODEL_CONTEXT_PII_CHECK` chỉ quét SĐT** (regex phone) — tên/địa chỉ không có lưới an toàn runtime thứ hai, chỉ nhờ `modelCtx` không truyền field đó + `redactPii` trên text. E2E LIVE chứng minh hiệu quả hiện tại, nhưng nếu sau này ai thêm field vào ctx bằng đường khác `modelCtx` thì tên/địa chỉ có thể rò mà guard không vang. Khuyến nghị: mở rộng guard quét marker tên/địa chỉ hoặc assert cấu trúc ctx (allow-list field).
3. **Không có test của CODEX bắn trực tiếp `MODEL_CONTEXT_PII_CHECK`** (guard chỉ được phủ gián tiếp) — probe JEV C1a đã lấp; nên đưa 1 assert đơn vị như vậy vào suri-p2.

**Mức GHI NHẬN (đã khai trung thực bởi CODEX, không phải phát hiện mới):**
4. propose SYNC chặn event loop (timeout 20s) — production cần async worker.
5. Money-guard không phủ thuộc tính phi số (vd "30 tiếng") — chống bằng prompt + ATTR_UNKNOWN needHuman.
6. Matrix runner không tự exit — chạy ad-hoc cần timeout/kill.
7. Stub "giá sốc" (bịa -50%) vẫn tồn tại trong fallback stub — CỐ Ý để test gate; khi AI OFF + text chứa "giá sốc" stub vẫn bịa rồi gate đè (đã xác nhận gate luôn chặn). Nếu muốn sạch, có thể chuyển thành flag test-only.

**Không phát hiện** vấn đề mức TRUNG BÌNH hoặc CAO trong phạm vi audit 6 mục.

## Evidence file (C:\JEV\evidence\audit-probes\)
`probe-ab.js/.log` (A+B, 8/8) · `probe-c-mock.js/.log` (C mock, 4/4) · `probe-c-live.js/.log` + `probe-c-live-console.log` (C live, 4/4, DeepSeek thật) · `suri-live-audit.log` (D) · `suri-p2.log` (E, 16/16 + F2) · `matrix.log` (245/245) · `boot-server.log` + curl transcript (F).
