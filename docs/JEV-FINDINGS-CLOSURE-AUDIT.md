# JEV-FINDINGS-CLOSURE-AUDIT — AUDIT ĐỘC LẬP GATE "SURI — ĐÓNG 5 FINDING"

> Ngày: 2026-10-06 · JEV (AUDITOR độc lập — READ-ONLY + probe, KHÔNG sửa file project).
> Đối tượng: `docs/SURI-FINDINGS-CLOSURE.md` (CODEX) · Baseline: `docs/SHA-SURI-ASYNC-BASELINE.json` · After: `docs/SHA-SURI-ASYNC-AFTER.json`.
> Phương pháp: tự tính SHA-256 bằng node crypto (không dùng mtime) · probe độc lập tự viết (file tạm NGOÀI project, dataDir riêng tại `%TEMP%\jev-audit`) · chạy lại toàn bộ regression trên hash cuối.
> KẾT LUẬN TỔNG: **5 FINDING: VERIFIED FIXED (probe + suite độc lập, nhiều lượt, xanh). NHƯNG GATE CHƯA THỂ CHỐT**: trong lúc audit, một tiến trình song song (AICAKE-GAP G1/G2) đã sửa thêm 5 file (18:13–18:33) ⇒ bảng SHA của closure KHÔNG CÒN mô tả cây hiện tại. Trước nghiệm thu kênh thật PHẢI: đóng băng cây → chụp SHA mới → chạy lại toàn bộ regression trên hash đóng băng (mục A2 + HIGH-1).

---

## A. SHA ĐỐI CHIẾU (crypto tự tính — PASS)

16/16 file: hash tự tính **khớp byte-đúng** với cả baseline lẫn `SHA-SURI-ASYNC-AFTER.json`. 13 file LOCKED GIỮ NGUYÊN, đúng 3 file allowlist đổi. Không có file nào đổi ngoài allowlist. 4 file mới khớp hash khai báo.

| File | Trước (baseline) | Sau (tự tính) | Trạng thái |
|---|---|---|---|
| src/action-gate.js | e31096fba777c48d… | e31096fba777c48d… | **SAME — LOCKED-OK** |
| src/order-engine.js | 1e3d24d4093e269b… | 1e3d24d4093e269b… | **SAME — LOCKED-OK** |
| src/session.js | bbd68cebbf5fb833… | bbd68cebbf5fb833… | **SAME — LOCKED-OK** |
| src/gateway.js | fa6b9e157e701e6f… | fa6b9e157e701e6f… | **SAME — LOCKED-OK** |
| src/pipeline.js | 0259c20a634c5948… | e60eed6cd5e3e528… | CHANGED (allowlist — F1+F2) |
| src/sales-ai.js | 5d07136219dbf3d3… | 6c27fa3ad450113c… | CHANGED (allowlist — F5 call) |
| src/live-http.js | 65a26bcdfe2fa33e… | 65a26bcdfe2fa33e… | **SAME — LOCKED-OK** |
| src/ai-provider.js | f5a28b62a3dd50c3… | 6cb6b9b7da6dc323… | CHANGED (allowlist — F5 save) |
| src/app.js | 7e87f520bff9b1d7… | 7e87f520bff9b1d7… | **SAME — LOCKED-OK** |
| src/agent/orchestrator.js | 40725e6593a45231… | 40725e6593a45231… | **SAME — LOCKED-OK** |
| src/agent/tools.js | 66b8b1403bf93896… | 66b8b1403bf93896… | **SAME — LOCKED-OK** |
| src/prompt-builder.js | fece4ebe91a8b251… | fece4ebe91a8b251… | **SAME — LOCKED-OK** |
| src/deepseek-wire.js | 6f8be10669da8eb1… | 6f8be10669da8eb1… | **SAME — LOCKED-OK** |
| src/util.js | 8a68dba69f689120… | 8a68dba69f689120… | **SAME — LOCKED-OK** |
| server.js | 27e93002174ade02… | 27e93002174ade02… | **SAME — LOCKED-OK** (role gate có sẵn) |
| ui/app.js | 687a6071948b0b2a… | 687a6071948b0b2a… | **SAME — LOCKED-OK** |

File mới (đối chiếu hash trong AFTER.json — khớp hết): `test/f1-facts-stale.js`, `test/f1-f5-closure.js`, `docs/SURI-ASYNC.md`, `docs/SURI-FINDINGS-CLOSURE.md`. UI: KHÔNG đụng.
⇒ **A1: PASS — TẠI THỜI ĐIỂM AFTER.json (18:08) và đầu phiên audit (~18:11).**

### A2 — CẢNH BÁO (HIGH): CÂY BỊ DRIFT TRONG LÚC AUDIT

Ngay sau lần đối chiếu đầu, một tiến trình SONG SONG (công việc AICAKE-GAP — `docs/AICAKE-GAP-2026-10-06.md`) đã sửa thêm file:

| File | mtime | Nội dung | Thuộc closure? |
|---|---|---|---|
| src/analytics.js | 18:13:40 | MỚI — module Báo cáo/Thống kê (G1) | ngoài baseline (file mới, không phá freeze) |
| server.js | 18:14:39 | wire `/api/analytics` (require + endpoint dòng 1827) + THÊM `/api/analytics` vào whitelist GET `agentAllowed` (dòng 1581) | **LOCKED — BỊ PHÁ FREEZE** (+4 dòng/+409 byte, 2108→2112 dòng) |
| ui/app.js | 18:16:27 | view UI "Báo cáo" (G1) | **LOCKED — BỊ PHÁ FREEZE** |
| src/comment-flow.js | 18:28:10 | MỚI — comment flow (G2) | ngoài baseline |
| src/channel/meta-adapter.js | 18:30:26 | normalize comment + hideCalls (G2) | ngoài baseline |
| src/pipeline.js | 18:33:41 | commentPlan trong handleEvent + helper G2 (1105→1315 dòng) | **allowlist F1/F2 — ĐỔI THÊM NGOÀI closure** |

Đối chiếu lại với AFTER.json (lúc ~18:35): chỉ 13/16 còn khớp — drifted: `src/pipeline.js`, `server.js`, `ui/app.js`. 3 file fix 5-finding: `sales-ai.js` + `ai-provider.js` vẫn nguyên hash closure; `pipeline.js` có THÊM code G2 TRÊN NỀN fix F1/F2 (fix không bị xóa — f1-facts-stale 4/4 + f1-f5-closure 12/12 chạy lại XANH trên cây dở G2 lúc 18:3x) nhưng hash không còn là `e60eed6c…` của closure.

⇒ **A2: VI PHẠM KỶ LUẬT FREEZE của gate.** Không phải lỗi của báo cáo CODEX (snapshot 18:08 trung thực), nhưng closure SHA hiện KHÔNG mô tả cây chạy thật. Bắt buộc trước nghiệm thu kênh thật: (1) chờ G1/G2 xong, đóng băng cây; (2) chụp SHA-SURI-FINAL mới (hoặc gộp G1/G2 vào một closure mới); (3) chạy lại TOÀN BỘ regression mục F trên đúng hash đóng băng đó. Regression tôi chạy 18:17–18:29 là trên cây post-G1; chạy lại f1-facts-stale/f1-f5-closure 18:3x trên cây dở G2 vẫn xanh — nhưng đó là cây DI ĐỘNG, không dùng làm bằng chứng gate.

## B. F1 FACTS-STALE — PROBE ĐỘC LẬP (PASS 4/4)

**Đọc code** (`src/pipeline.js` continuation): `_factsDrift(snapshot)` so FACTS snapshot với DB TƯƠI theo product_id của snapshot — subject tắt/biến mất → `subject_disabled_or_gone`; variant mất → `variant_missing`; giá đổi → `price_changed`; tồn đổi còn→hết → `stock_out`. `_freshFactsReply` chạy TRONG continuation TRƯỚC `gate.sendReply`: không lệch → shape cũ nguyên trạng; lệch + intent PRICE/VARIANT/STOCK → `gate.renderValidated(intent, FACTS_TƯƠI)` (cùng cơ chế render whitelist money guard — đã xác minh `renderValidated` có sẵn trong action-gate.js LOCKED, render từ facts truyền vào); lệch lớn/intent ngoài nhóm → câu an toàn + `needHuman` → NEEDS_HUMAN. Áp đủ 4 call-site: routeInfo (dòng 484), routeImage (507), routeBuy-ambiguous (553), routeChitchat (995). BUY_ASK stub-sync không đụng — đúng như claim.

**Probe độc lập** (mock LLM cầm promise + ECHO SNAPSHOT, đổi DB trong cửa sổ chờ qua productDB — seed tự dò, không copy code CODEX):
- B1 đổi giá giữa chờ (165000→987654) → reply mang **987654**, KHÔNG 165000; evidence `facts_superseded=price_changed` — PASS.
- B2 tồn còn→hết giữa chờ → reply "hết hàng", KHÔNG "còn N"; evidence `stock_out` — PASS.
- B3 disabled giữa chờ → 0 nhắc tên SP, 0 con số; NEEDS_HUMAN; worklist=1 — PASS.
- B4 không đổi DB → lời LLM nguyên trạng, không có facts_superseded — PASS.
⇒ **B: PASS.** Lý do sync-path không thể lệch xác đáng: stub propose + gửi cùng tick, event loop đơn luồng.

## C. F2 ROUTEREPURCHASE PROMISE (PASS 4/4)

**Đọc code** (`src/pipeline.js` dòng 659-688): chỉ đổi TẠI call-site routeRepurchase — sync → gắn meta như cũ; Promise resolve → gắn meta lên kết quả sau settle; reject → fallback `REPURCHASE_FALLBACK` qua `gate.sendReply` (rejection được handler riêng Nuốt-im-lặng là không thể); treo → `setTimeout(repurchaseAwaitMs)` (default 15000) rồi fallback, `settled` cờ chống double-resolve. Idempotency đơn không đụng (order chỉ do pha A).

**Probe độc lập** (monkey-patch propose cho BUY_ASK trả Promise):
- C1 reject → đúng +1 câu an toàn "ghi nhận yêu cầu mua lại", 0 đơn trùng, 0 unhandledRejection — PASS.
- C2 treo + hạn chờ 200ms → fallback `await_timeout`, event loop sống (tin khách khác phục vụ ngay) — PASS.
- C3 **treo rồi settle muộn** → tái hiện đúng known-limitation #1 của CODEX: đúng 1 tin MUỘN từ continuation cũ sau fallback, 0 đơn trùng, 0 unhandledRejection — PASS (định lượng khớp khai báo).
- C4 resolve → `repurchase.from_order_id` gắn trên KẾT QUẢ, reply đầy đủ, không fallback — PASS.
⇒ **C: PASS.** Không còn đường nuốt phản hồi.

## D. F5 AI_BASE_URL (PASS 5/5)

**Đọc code** (`src/ai-provider.js` dòng 42-55 `aiBaseUrlCheck`): cho phép `api.deepseek.com`/`api.openai.com` CHỈ https + loopback (localhost/`[::1]`/127.x) http lẫn https; chặn scheme ≠ http(s), credentials trong URL, http ngoài loopback (`https_required`), host `.local/.internal/.lan/.intranet`, TOÀN BỘ IP dotted-quad ngoài loopback (chặt hơn đề bài — 10.x/172.16-31.x/192.168.x/169.254.x/0.0.0.0 lẫn 172.32+ đều chặn), host lạ. Tầng SAVE: `saveAiConfig` throw `BAD_BASE_URL:<reason>` (dòng 77-80). Tầng CALL: `sales-ai._tryLLM` throw trong try → llm_fallback (dòng 170-173) + `testAiProvider` record `base_url_blocked:*` trước httpFn (dòng 165-168).

**Probe độc lập**:
- D1 trực tiếp `aiBaseUrlCheck`: allow 8 (gồm https 2 provider + 4 biến thể loopback), block 27 (10.x, 172.16/172.31/172.32, 192.168, 169.254 http+https, 0.0.0.0, .local/.internal/.lan/.intranet, file://, ftp://, javascript:, gopher:, user:pass@, evil.example.com, IPv6 public, http://api.deepseek.com, URL hỏng) — PASS.
- D2 SAVE: 4 giá trị bẩn throw BAD_BASE_URL, config hợp lệ trước đó GIỮ NGUYÊN — PASS.
- D3 CALL propose: base_url bẩn sửa tay DB → fallback FAQ stub đúng giá DB, `llm_fallback=1`, reason `ai_base_url_blocked:…`, spy httpFn **0 lần**, không "LEAK" — PASS.
- D4 CALL testAiProvider: bẩn → `ok:false base_url_blocked:*` spy 0; loopback → test 1 call — PASS.
- D5 HTTP thật: AGENT POST `/api/ai/config` và `/api/ai/wire-deepseek` → **403 FORBIDDEN_ROLE** (cả 2); — PASS. (Chạy trên server.js ĐÃ dán analytics — whitelist GET thêm `/api/analytics` không đụng POST whitelist; F5-4 trong f1-f5-closure chạy lại 18:3x cũng vẫn 12/12.)
**Quyền AGENT**: `agentAllowed` tại server.js dòng 1577-1594 + chặn 403 chung dòng 1812 — whitelist POST của AGENT KHÔNG chứa 2 endpoint AI; server.js hash KHỚP baseline ⇒ gate CÓ SẴN từ trước, CODEX chỉ verify hiện trạng như claim (khớp xác nhận JEV trước). ⇒ **D: PASS.**

## E. RECEIPT CŨ ĐỐI CHIẾU (PASS — nguyên hiệu lực)

Đối chiếu code hiện tại (đều nằm trong file LOCKED — hash khớp baseline, không thể bị đợt vá này phá):
- **FB10** (outbound_pending DELIVERED match): `action-gate.js` `processReceiptEvent` + `matchAndApplyReceipt` — dedupe receipt_event_id, match mid ưu tiên, cửa sổ thời gian [sent_at-2ph, +24h], receipt lạ → `receipt_unmatched` + GIỮ row cho crash-window reconcile; match → op DELIVERED + message DELIVERED + exec DONE + follow_up SENT. ✔
- **BL-5** (inbound-first): DELIVERED CHỈ từ receipt webhook/reconcile outbound_pending — KHÔNG platform.getReceipt(); comment header action-gate.js + code khớp. ✔
- **BL-9** (event-scoped idempotency): `action-gate.js` idem key `send:<conv>:<event_id>:<msg_kind>:<slot>`, turn_key `<turn_event_id>:<slot>`, safeReply hash(event_id) — retry cùng event không gửi trùng/khác nội dung. ✔
- **P8** (UNKNOWN → đối soát không retry mù): `order-engine.js` `blindRetryShipment` — exec ≠ DONE → CHẶN + DLQ `RETRY_BLOCKED_NO_RECEIPT` + needsHuman + scheduleReconcile theo clientOrderCode. ✔
Chạy thử: `test/async-gate.js` **9/9 exit 0** (P7 restart dup=0, P8 sends=1 DELIVERED; chạy sau khi server.js đã dán analytics — vẫn xanh) + `test/18-cases.js` **18/18 exit 0**.
⇒ **E: PASS — 4 receipt cũ còn nguyên hiệu lực.**

## F. REGRESSION (toàn bộ exit 0 — chạy 18:17–18:29 trên cây post-G1; suite 5-finding chạy lại 18:3x trên cây dở G2 vẫn xanh)

| Suite | Kết quả (JEV chạy lại) | Exit |
|---|---|---|
| 18-cases | 18/18 | 0 |
| invariants-check | 6/6 | 0 |
| gate-a | 7/7 | 0 |
| p3b-cases | 11/11 | 0 |
| p3c-cases | 28/28 | 0 |
| live-adapters | 26/26 | 0 |
| product-ready (kèm node --check nội bộ) | 32/32 | 0 |
| e2e-flows | 5/5 | 0 |
| image-match-regression | 6/6 | 0 |
| suri-agent | 19/19 | 0 |
| suri-p2 (kèm **deepseek-wire LIVE ping PASS 1.5s**) | 16/16 | 0 |
| stability-cases | 14/14 | 0 |
| async-gate | 9/9 | 0 |
| f1-facts-stale | 4/4 | 0 |
| f1-f5-closure | 12/12 (0 unhandledRejection) | 0 |
| **matrix runner** | **245/245 (17.1s, tự exit sạch trước kill-timer 100s)** | 0 |

`node --check` tự chạy: **79/79 file JS** (server.js + src 32 + test 43 + ui 3) — 0 lỗi cú pháp. (CODEX báo 77 — chênh 2 file chỉ là cách đếm, không phải lỗi.)

**Chất lượng 2 test mới**: assert CÓ THẬT — không assert khống:
- `f1-facts-stale.js`: mock ECHO từ FACTS trong request (snapshot stale lọt ra khách thì assert bắt chắc); `waitPending` đảm bảo mutation nằm ĐÚNG trong cửa sổ chờ; assert 2 chiều (CÓ số mới + KHÔNG số cũ), evidence `facts_superseded`, decision AUTO_EXECUTED/NEEDS_HUMAN, worklist ≥1, case ngược (không lệch → không đè).
- `f1-f5-closure.js`: F2 có counter `unhandledRejection` toàn tiến trình + assert hạn chờ <3000ms + assert +1 tin chính xác + loop sống; F5 spy httpFn đếm 0 lần; F5-4 HTTP thật (server instance, AGENT login, 2x403, OWNER 200/400, GET status sau 400 vẫn base_url sạch).

---

## BẢNG 5 FINDING — FIXED/OPEN

| Finding | Claim CODEX | JEV verify | Kết luận |
|---|---|---|---|
| F1 — facts stale lúc LLM chờ | PASS (MOCK) | code + probe độc lập 4/4 + suite 4/4 | **FIXED** (MOCK) |
| F2 — routeRepurchase Promise | PASS (MOCK) | code + probe độc lập 4/4 (gồm tái hiện limitation #1) + suite 4/4 | **FIXED** (MOCK) |
| F5a — quyền cấu hình AI | VERIFY (gate có sẵn) | `agentAllowed` server.js dòng 1577-1594 + 403 thật; server.js LOCKED | **VERIFIED — FIXED** |
| F5b — đích mạng ai_base_url | PASS (2 tầng) | code + probe 27 block-case + save/call/testProvider spy=0 | **FIXED** |
| F3 — doc §7 "13/13" stale | PASS (doc) | stability 14/14 chạy lại + assert doc trong closure 12/12 | **FIXED (doc)** |
| F4 — doc §8.5 LIVE | PASS (doc) | suri-p2 chạy lại: LIVE ping PASS 1.5s; doc ghi đúng "reply LIVE CHƯA XÁC MINH" | **FIXED (doc)** — đường reply LIVE **vẫn CHƯA XÁC MINH** (đúng như công bố, không phải finding mới) |

## VẤN ĐỀ THEO MỨC

**BLOCKER: không có.**
**HIGH:**
1. **Phá freeze SHA trong quá trình audit (mục A2)** — tiến trình song song AICAKE-GAP G1/G2 đã sửa `server.js` (18:14), `ui/app.js` (18:16), `pipeline.js` (18:33, trên nền fix F1/F2), `meta-adapter.js` (18:30) + thêm `analytics.js`/`comment-flow.js`. Closure SHA (AFTER.json 18:08) KHÔNG CÒN mô tả cây hiện tại (13/16). Fix 5-finding không bị phá (tests vẫn xanh), nhưng gate phải re-freeze + re-snapshot + re-run toàn bộ regression trên hash đóng băng mới được phép nghiệm thu kênh thật.
**MEDIUM: không có.**
**LOW / OBSERVATION:**
1. (F2 — đã công bố, JEV tái hiện + định lượng) Timeout rồi settle muộn → đúng 1 tin muộn thêm sau fallback (nội dung khác, không trùng, 0 đơn trùng, 0 unhandledRejection). Bất khả thi tự nhiên ở hiện trạng BUY_ASK stub-sync. Chấp nhận cấp prototype — ghi nhận cho lúc bật BUY_ASK async thật.
2. (F1 — MỚI, chưa nằm trong KNOWN LIMITATIONS của CODEX) Drift KHÔNG flag chiều tồn TĂNG (0→có hàng, 8→20): khách có thể nhận "hết hàng"/"còn 8" khi DB đã nhiều hơn. Chiều an toàn (không bao giờ nói dối về giá/hàng có sẵn), không sai money — chấp nhận, nên ghi vào limitations khi bật LIVE.
3. (F5 — đã công bố) Allowlist tĩnh theo hostname, không resolve DNS; redirect/DNS-rebinding ngoài phạm vi prototype.
4. (Quan sát đếm) `node --check` CODEX 77 vs JEV 79 file — chỉ khác cách đếm, 0 lỗi cả hai.
5. (Rủi ro còn lại — đã công bố) LIVE reply path (tin khách → DeepSeek thật → khách) chưa chạy lần nào; toàn bộ bằng chứng gate này là MOCK + LIVE ping. Đây chính là điều nghiệm thu kênh thật sắp tới phải phủ.

**KHUYẾN NGHỊ: 5 FINDING ĐƯỢC XÁC NHẬN FIXED — nhưng CHƯA cho phép nghiệm thu kênh thật cho tới khi hoàn tất 3 điều kiện:**
1. **(HIGH-1)** Chờ công việc AICAKE-GAP (G1 analytics + G2 comment) xong và ĐÓNG BĂNG cây → chụp `SHA-SURI-FINAL.json` (gộp hoặc kế thừa closure này) → chạy lại TOÀN BỘ mục F trên đúng hash đóng băng đó.
2. (đã có đủ bằng chứng, chỉ cần lặp lại trên hash mới) LIVE reply path: chạy 1 hội thoại thật qua DeepSeek và đối chiếu reply vs FACTS; bật monitor `ai.stats.llm_fallback` + reason trong phiên LIVE.
3. Ghi nhận limitation #1 (late-settle) + #2 (drift chiều tồn tăng) vào runbook khi chuyển BUY_ASK sang async thật.

---
*Probe JEV: `%TEMP%\jev-audit\jev-f1-probe.js`, `jev-f2-probe.js`, `jev-f5-probe.js` (ngoài project, dataDir riêng, tự xoá được). Không file project nào bị sửa trong quá trình audit (SHA trước/sau audit giống hệt bảng A).*
