# SURI-FINDINGS-CLOSURE — ĐÓNG 5 FINDING JEV-SURI-ASYNC (TRƯỚC THỬ LIVE)

> Ngày: 2026-10-06 · CODEX (implementer) · Đối tượng: `docs/JEV-SURI-ASYNC-AUDIT.md` — 5 finding LOW.
> Phạm vi: prototype `sales-ai-lab/prototype` · Thuần Node, không npm · Baseline SHA: `docs/SHA-SURI-ASYNC-BASELINE.json` (16 file).
> FREEZE giữ nguyên BYTE (đối chiếu SHA §4): Action Gate, order engine, session, gateway receive, receipt store,
> window/quota, PII strip, idempotency — **13/16 file baseline GIỮ NGUYÊN hash**, chỉ 3 file allowlist đổi
> (`pipeline.js`, `sales-ai.js`, `ai-provider.js`) + file test/doc mới.

## 0. TÓM TẮT FINAL

| Finding | Vá | Test | FINAL |
|---|---|---|---|
| F1 — Facts stale lúc AI chờ (JEV LOW-1) | CODE-FIX `pipeline._freshFactsReply` + 4 call-site | `test/f1-facts-stale.js` 4/4 + closure 2 case | **PASS (MOCK)** |
| F2 — routeRepurchase khi propose Promise (JEV LOW-2) | CODE-FIX tại call-site routeRepurchase | closure F2-0..3 (sync/resolve/reject/timeout) | **PASS (MOCK)** |
| F5a — Quyền cấu hình AI (JEV LOW-5) | VERIFY — role gate CÓ SẴN (`agentAllowed`), không thêm code | closure F5-4 (HTTP thật, AGENT 403) | **PASS** |
| F5b — Đích mạng ai_base_url | CODE-FIX allowlist SAVE + CALL (2 tầng) | closure F5-1..3 (save 11 chặn / call 0 byte) | **PASS** |
| F3 — Doc §7 "13/13" stale | DOC-FIX → 14/14 kèm chú thích | closure F3 assert file | **PASS** |
| F4 — Doc §8.5 mâu thuẫn LIVE | DOC-FIX → ping LIVE ĐÃ PASS trong suri-p2; reply LIVE CHƯA XÁC MINH | closure F4 assert file | **PASS (doc)** — đường reply LIVE **CHƯA XÁC MINH** |

Regression nguyên trạng: **toàn bộ exit 0** (§5) · `node --check` 77 file sạch · SHA 16 file §4.

---

## 1. F1 — FACTS STALE LÚC LLM CHỜ (JEV LOW-1)

**Tái hiện (probe):** đường LLM async (SURI ASYNC) chụp FACTS lúc `propose`; LLM trả lời muộn 150-6000ms;
trong cửa sổ chờ đổi DB qua productDB (cùng đường product-overrides API):
(a) `getVariant('NT-VANILLA-S').variant.price 165000 → 199000` — reply cũ (mock echo snapshot "165000đ")
vẫn được gửi; ngay cả khi money guard đè số, `renderValidated` render từ `proposal.facts` = SNAPSHOT CŨ
→ khách vẫn nhận giá hết hiệu lực. (b) `setStock(sku, 0)` — lời cũ bảo "còn 8" khi DB đã hết.
(c) `getProduct('prd_nt_vanilla').enabled = false` — bot vẫn tư vấn SP đã ẩn khỏi bán.

**CODE-FIX** (`src/pipeline.js`, chỉ thêm kiểm tra — 0 dòng logic cũ đổi):
- `_factsDrift(snapshot)` — so snapshot với DB TƯƠI NGAY TRƯỚC KHI GỬI: subject tắt/biến mất →
  `subject_disabled_or_gone`; variant mất → `variant_missing`; giá đổi → `price_changed`;
  tồn đổi còn→hết → `stock_out`. Không lệch → `null`.
- `_freshFactsReply(proposal, conv, snapshotFacts)` — chạy TRONG continuation TRƯỚC `gate.sendReply`:
  - không lệch → trả đúng shape cũ `{ ...proposal, facts, msgKind:'ai_reply' }` (sync-path stub không
    thể lệch — propose + gửi cùng tick → regression nguyên trạng);
  - lệch `price_changed`/`stock_out` với intent PRICE/VARIANT/STOCK → thay lời cũ bằng
    `gate.renderValidated(intent, FACTS_TƯƠI)` — **cùng cơ chế gate render**, số luôn khớp whitelist money guard;
  - lệch `subject_disabled_or_gone` (lệch lớn) hoặc intent ngoài nhóm render được → câu an toàn
    "Dạ tình trạng/mức giá vừa được shop cập nhật lại…" + `needHuman: true` → gate NEEDS_HUMAN + worklist
    (khách không bao giờ nhận con số hết hiệu lực, không tư vấn SP đã tắt).
- Áp tại 4 call-site gửi reply LLM trên FACTS: `routeInfo` (PRICE/VARIANT/ATTR), `routeImage` (STOCK),
  `routeBuy`-ambiguous (VARIANT), `routeChitchat` (CHITCHAT). BUY_ASK (stub-sync) không đụng.

**Test** (`test/f1-facts-stale.js`, 4/4 PASS; mock LLM cầm promise hold + ECHO SNAPSHOT — câu trả lời
được dựng từ FACTS trong request, nên nếu snapshot stale mà lọt ra khách thì assert bắt chắc chắn):
- F1-A đổi giá giữa chờ → reply chứa `199000` (DB tươi), **KHÔNG** `165000`; evidence `facts_superseded=price_changed`; AUTO_EXECUTED.
- F1-B còn→hết giữa chờ → reply "hết hàng", KHÔNG "còn 8"; `facts_superseded=stock_out`.
- F1-C disabled giữa chờ → 0 nhắc tên SP, 0 giá; decision NEEDS_HUMAN; worklist ≥1.
- F1-D không đổi DB → lời LLM nguyên trạng (guard không tự ý đè; `facts_superseded` vắng mặt).

**SHA:** `src/pipeline.js 0259c20a… → e60eed6c…`

## 2. F2 — routeRepurchase KHI propose TRẢ PROMISE (JEV LOW-2)

**Tái hiện (đọc code + probe mô phỏng):** `routeRepurchase` gọi `routeBuyItems` rồi gắn
`res.repurchase = …` kiểu sync. Nếu nhánh đó từng trả Promise (metadata gắn lên object Promise → RƠI;
promise không có handler riêng). Hiện không thể tới tự nhiên (items luôn khác rỗng + BUY_ASK stub-sync)
— **bẫy tiềm ẩn**; test mô phỏng bằng cách monkey-patch `ai.propose` trả Promise cho BUY_ASK
(chính xác kịch bản "sau này cho phép async ở nhánh đó").

**CODE-FIX — CHỈ tại call-site routeRepurchase** (`src/pipeline.js`):
- sync → gắn meta như cũ (byte-tương đương hành vi cũ — regression nguyên trạng);
- Promise resolve → gắn `meta` lên KẾT QUẢ sau settle (dùng pattern `_then` của các route khác);
- Promise reject → fallback câu an toàn qua `gate.sendReply` (intent `REPURCHASE_FALLBACK`, evidence
  `repurchase_promise_fallback`) — không crash, không nuốt im lặng, 0 đơn mới (order chỉ do pha A deterministic);
- Promise treo → chờ CÓ HẠN `repurchaseAwaitMs` (mặc định 15000; test đặt 200ms) rồi fallback —
  route không treo vô hạn; event loop vẫn phục vụ tin mới.

**Test** (`test/f1-f5-closure.js` F2-0..3):
- F2-0 SYNC regression: stub nguyên trạng → object sync + `.repurchase` meta + 0 đơn mới khi thiếu trường.
- F2-1 resolve → metadata gắn đúng `from_order_id` trên kết quả; khách nhận đủ phản hồi; 0 fallback; 0 đơn trùng.
- F2-2 reject → `fallback: error:…`, khách nhận đúng 1 câu an toàn "em đang ghi nhận yêu cầu mua lại…";
  out +1 (không trùng); 0 unhandledRejection.
- F2-3 treo → fallback `await_timeout` sau ~212ms (hạn chờ 200ms), đúng +1 tin, 0 đơn trùng,
  tin mới của khách khác vẫn phục vụ ngay; 0 unhandledRejection.

**SHA:** nằm trong `src/pipeline.js` (cùng hash với F1).

## 3. F5 — ai_base_url: QUYỀN + ĐÍCH MẠNG (JEV LOW-5)

**F5a Quyền (VERIFY hiện trạng — không thêm code):** `server.js` đã có role gate chặn sẵn tại
`agentAllowed` (dòng 1577-1594) + lệnh chặn 403 chung (dòng 1812): POST `/api/ai/config` và
`/api/ai/wire-deepseek` KHÔNG nằm trong whitelist POST của AGENT → 403 FORBIDDEN_ROLE.
Bằng chứng chạy THẬT (closure F5-4, HTTP + session thật): AGENT POST cả 2 endpoint → **403 FORBIDDEN_ROLE**;
OWNER → 200/400 đúng luật. ⇒ server.js GIỮ NGUYÊN BYTE (hash khớp baseline).

**F5b Đích mạng — allowlist 2 tầng (CODE-FIX `src/ai-provider.js` + `src/sales-ai.js`):**
- `aiBaseUrlCheck(raw)` (mới, export): CHO PHÉP `api.deepseek.com`, `api.openai.com` (CHỈ https) +
  loopback `127.0.0.1/localhost/[::1]/127.x` (http lẫn https — provider Local/ÚC phê duyệt);
  CHẶN mọi host khác: IP nội bộ 10.x / 172.16-31.x / 192.168.x / 169.254.x (metadata) / 0.0.0.0,
  host `.local/.internal/.lan/.intranet`, scheme không phải http(s) (`file://`, `ftp://`),
  URL chứa username/password.
- Tầng SAVE — `saveAiConfig`: base_url không qua allowlist → throw `BAD_BASE_URL:<reason>` → server 400
  (friendly `BAD_` đã map); cấu hình hợp lệ trước đó GIỮ NGUYÊN (không ghi đè bởi lần save bẩn).
- Tầng CALL (phòng tuyến): `sales-ai._tryLLM` throw `ai_base_url_blocked:<reason>` trong try →
  `llm_fallback` + reason → khách nhận fallback FAQ stub — **0 byte ra mạng**;
  `testAiProvider` → `record(false, 'base_url_blocked:<reason>')` — KHÔNG gọi httpFn.

**Test** (closure F5-1..3):
- F5-1 SAVE: allow 127.0.0.1:8899/v1, https://api.deepseek.com/v1, http://localhost:9000, rỗng→xoá;
  chặn 11 giá trị bẩn (169.254.169.254 http+https, 10.x, 192.168.x:8443, 172.16.x, file://, ftp://,
  evil.example.com, metadata.google.internal, user:pass@…, 0.0.0.0) — config sạch không bị ghi đè.
- F5-2 CALL (propose): base_url bẩn sửa tay DB (bypass save) → reply fallback stub chứa giá DB đúng;
  `llm_fallback=1`, reason `ai_base_url_blocked:…`, spy httpFn **0 lần gọi**, không "LEAK".
- F5-3 CALL (testAiProvider): bẩn → `{ok:false, base_url_blocked:…}`, spy 0; loopback → test bình thường (spy 1).
- F5-4 HTTP quyền: như F5a + OWNER save loopback 200; OWNER save metadata IP → 400 `BAD_BASE_URL:…`;
  sau 400, `GET /api/ai/status` vẫn trả base_url hợp lệ cũ (bẩn không vào DB).

**SHA:** `src/ai-provider.js f5a28b62… → 6cb6b9b7…`; `src/sales-ai.js 5d071362… → 6c27fa3a…`; `server.js` GIỮ NGUYÊN.

## 4. BẢNG SHA 16 FILE — TRƯỚC/SAU (baseline `docs/SHA-SURI-ASYNC-BASELINE.json`)

Sau-vá đầy đủ: `../docs/SHA-SURI-ASYNC-AFTER.json`. **LOCKED = GIỮ NGUYÊN BYTE.**

| File | Trước (baseline) | Sau | Trạng thái |
|---|---|---|---|
| src/action-gate.js | e31096fba777c48d… | e31096fba777c48d… | **SAME — LOCKED** |
| src/order-engine.js | 1e3d24d4093e269b… | 1e3d24d4093e269b… | **SAME — LOCKED** |
| src/session.js | bbd68cebbf5fb833… | bbd68cebbf5fb833… | **SAME — LOCKED** |
| src/gateway.js | fa6b9e157e701e6f… | fa6b9e157e701e6f… | **SAME — LOCKED** |
| src/pipeline.js | 0259c20a634c5948… | e60eed6cd5e3e528… | CHANGED (allowlist — F1+F2) |
| src/sales-ai.js | 5d07136219dbf3d3… | 6c27fa3ad450113c… | CHANGED (allowlist — F5 call) |
| src/live-http.js | 65a26bcdfe2fa33e… | 65a26bcdfe2fa33e… | **SAME — LOCKED** |
| src/ai-provider.js | f5a28b62a3dd50c3… | 6cb6b9b7da6dc323… | CHANGED (allowlist — F5 save) |
| src/app.js | 7e87f520bff9b1d7… | 7e87f520bff9b1d7… | **SAME — LOCKED** |
| src/agent/orchestrator.js | 40725e6593a45231… | 40725e6593a45231… | **SAME — LOCKED** |
| src/agent/tools.js | 66b8b1403bf93896… | 66b8b1403bf93896… | **SAME — LOCKED** |
| src/prompt-builder.js | fece4ebe91a8b251… | fece4ebe91a8b251… | **SAME — LOCKED** |
| src/deepseek-wire.js | 6f8be10669da8eb1… | 6f8be10669da8eb1… | **SAME — LOCKED** |
| src/util.js | 8a68dba69f689120… | 8a68dba69f689120… | **SAME — LOCKED** |
| server.js | 27e93002174ade02… | 27e93002174ade02… | **SAME — LOCKED** (role gate có sẵn) |
| ui/app.js | 687a6071948b0b2a… | 687a6071948b0b2a… | **SAME — LOCKED** |

File mới (ngoài baseline): `test/f1-facts-stale.js` `48927edf4ce89e4d…`, `test/f1-f5-closure.js`
`2647eff569feb10e…`, `docs/SURI-ASYNC.md` `8bac3a034db5f2ec…` (đính chính F3/F4),
`docs/SURI-FINDINGS-CLOSURE.md` (file này). UI: KHÔNG đụng.

## 5. TEST + REGRESSION (chạy sau mọi thay đổi — nguyên trạng, không bỏ lượt)

| Suite | Kết quả | Exit | Log |
|---|---|---|---|
| test/f1-facts-stale.js (mới — F1 đầy đủ) | 4/4 | 0 | console |
| test/f1-f5-closure.js (mới — F1+F2+F5+F3/F4) | 12/12 (0 unhandledRejection) | 0 | console |
| 18-cases | 18/18 | 0 | f15-regression.log |
| invariants-check | 6/6 | 0 | f15-regression.log |
| gate-a | 7/7 | 0 | f15-regression.log |
| p3b-cases | 11/11 | 0 | f15-regression.log |
| p3c-cases | 28/28 | 0 | f15-regression.log |
| live-adapters | 26/26 | 0 | f15-regression.log |
| product-ready | 32/32 | 0 | f15-regression.log |
| e2e-flows | 5/5 | 0 | f15-regression.log |
| image-match-regression | 6/6 | 0 | f15-regression.log |
| suri-agent | 19/19 | 0 | f15-regression.log |
| stability-cases | **14/14** (khớp đính chính F3) | 0 | f15-regression.log |
| async-gate | 9/9 | 0 | f15-regression.log |
| suri-p2 | 16/16 (kèm deepseek-wire **LIVE ping PASS**, 1.7s) | 0 | f15-surip2.log |
| **matrix runner** | **245/245 (17.1s, kill-timer 100s — tự exit sạch trước hạn)** | 0 | f15-matrix.log |

`node --check`: 77 file (server.js + src/** + test/** + ui/**) — 0 fail.

## 6. KNOWN LIMITATIONS

1. **F2 — "timeout rồi settle muộn"**: nếu promise trong routeRepurchase vượt hạn chờ (fallback đã gửi)
   và sau đó promise nội bộ vẫn settle thì continuation BUY_ASK có thể gửi thêm 1 tin muộn (nội dung khác
   câu fallback — không trùng nội dung, không tạo đơn trùng vì pha A không chạy lại). Chỉ xảy ra ở kịch
   bản giả định BUY_ASK-async (hiện stub-sync bất khả thi); chấp nhận ở cấp prototype.
2. **F1 — race đổi chủ đề giữa chờ**: guard so snapshot với CHÍNH SẢN PHẨM CỦA SNAPSHOT (theo product_id),
   KHÔNG so theo `conv.subject_sku` — khách đổi sang SP khác giữa chờ vẫn theo hành vi race đã nghiệm thu
   ở gate SURI-ASYNC (thứ tự reply có thể đảo; gate re-check takeover/bot_off/stale tại lúc gửi giữ nguyên).
3. **F1 — câu an toàn khi NEEDS_HUMAN**: gate tự thay text proposal bằng `safeReply(event_id)`
   (hợp đồng NEEDS_HUMAN hiện có) — câu "tình trạng/mức giá vừa cập nhật…" nằm trong proposal_json (audit),
   khách nhận câu an toàn deterministic của gate. Cả hai đều không chứa số/liên quan SP đã tắt.
4. **F5 — allowlist tĩnh theo hostname**: không resolve DNS (mock/gateway qua IP loopback được phép;
   host công khai khác api.deepseek.com/api.openai.com bị chặn kể cả khi trỏ cùng đích). SSRF phần cứng
   (redirect, DNS rebinding) ngoài phạm vi prototype.
5. **LIVE LLM (đường reply) — CHƯA XÁC MINH**: như §8.5 SURI-ASYNC.md (đính chính F4): ping provider LIVE
   đã PASS trong suri-p2; tin khách → DeepSeek thật → khách chưa chạy. 0 finding ở gate này phụ thuộc LIVE.

## 7. FINAL THEO FINDING

- **F1: PASS (MOCK)** — tái hiện 3 lệch (giá/tồn/disabled) → KHÔNG gửi lời cũ; render từ DB tươi hoặc câu an toàn + NEEDS_HUMAN; regression nguyên trạng.
- **F2: PASS (MOCK)** — 3 ca promise (resolve/reject/timeout) + sync regression: không mất phản hồi, không gửi trùng, không tạo đơn trùng, không treo, không crash.
- **F5 (quyền + đích mạng): PASS** — AGENT 403 chứng minh bằng HTTP thật; allowlist chặn SAVE (11 giá trị bẩn) + CALL (0 byte ra mạng); loopback + 2 provider chuẩn được phép.
- **F3: PASS** — §7 14/14 (đính chính).
- **F4: PASS (doc)** — §8.5 nhất quán: ping LIVE ĐÃ PASS trong suri-p2; **đường reply LIVE: CHƯA XÁC MINH**.
