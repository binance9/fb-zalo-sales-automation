# P3A — GATE A: DATA / SAFETY FOUNDATION (báo cáo thực thi)

> Phạm vi: đóng đúng 3 blocker **BL-3 / BL-8 / BL-9** của `BAO-CAO-HOI-DONG-V2.md` Phần A.2 trên prototype
> `prototype/` (thuần Node, không npm, không mạng). KHÔNG đụng: Meta/Zalo production, AUTO thật, LLM thật,
> Window Gate (BL-1), Zalo quota (BL-2), receipt store (BL-5), order-engine mua lại (BL-4), giá subject-scoped (BL-6),
> follow-up SENT mapping (BL-7), không thêm Redis/Postgres, không đổi kiến trúc lớn.
> Nhãn kết quả: toàn bộ PASS đều là **PASS (MOCK)** — stub LLM, mock platform/carrier/vision/ASR, JSON store, đồng hồ ảo.

---

## 1. BEFORE — evidence BL-3/8/9 TRƯỚC KHI SỬA (Bước 0 — audit trên source gốc)

Kết quả đối chiếu: **source gốc KHỚP 100% evidence của báo cáo V2** — cả 3 đường evidence đều tìm thấy
nguyên văn tại đúng file:dòng mà V2 ghi. Không có điểm nào "CHƯA XÁC MINH".

### BL-3 — PII chui vào model context qua object `conv` → XÁC MINH ĐÚNG
| V2 ghi | Audit thấy (source gốc) |
|---|---|
| `pipeline.js` dòng 242 | `this.ai.propose(intent, { text, normText: normKey(text), facts, conv })` — truyền `conv` nguyên vẹn |
| `pipeline.js` dòng 292–295 (routeBuy) | `propose('BUY_ASK', { text, facts: {...}, draftMissing: missing, conv })` |
| `pipeline.js` dòng 487 (routeChitchat) | `propose('CHITCHAT', { text: '', facts, conv })` |
| `session.js` dòng 120–133 (getDraft) | `draft.slots.{name,phone,address}.value` chứa PII; `fillSlots` (pipeline 165–175) ghi phone/tên/địa chỉ vào `conv.draft.slots` + `customer.phone` |
| **(mới tìm thấy, V2 không liệt kê)** | `pipeline.js` ~dòng 319: `tryCreateOrder` nhánh `MISSING_FIELDS` cũng truyền `conv` vào `propose('BUY_ASK', …)` — cùng vector |

Stub `sales-ai.js` bỏ qua `ctx.conv` nên 18/18 không lộ — khớp đúng nhận định V2 ("stub bỏ qua conv nên 18/18 không lộ").
Ngoài ra ctx còn nhận `text` raw của khách (chứa SĐT/địa chỉ khi khách rải info) — cũng là bề mặt rò PII, đã xử lý (mục 3).

### BL-8 — HUMAN_OWNED còn cổng `actor=system` → XÁC MINH ĐÚNG
| V2 ghi | Audit thấy (source gốc) |
|---|---|
| `action-gate.js` dòng 158–171 | `authorize()`: mode HUMAN chỉ chặn (a) `actor==='ai'` (dòng 160), (b) `marketing`/`care` bất kể actor (dòng 166). Tổ hợp `actor='system' + msgKind='ai_reply'` (DEFAULT của `sendReply`, dòng 52) đi tự do |
| Opt-out chỉ check marketing/care (dòng 169) | Kênh system tới được cả khách đã opt-out |
| `pipeline.js` dòng 102–107 (`askHuman`) | Chính code hiện hữu dùng vector này: `sender:'system'`, text tự do, msgKind mặc định `ai_reply` |
| Whitelist "chỉ tồn tại trên giấy" | Không có bảng/module `SYSTEM_TEMPLATES` nào trong source — xác nhận cr-R3 R2-2 |

### BL-9 — Crash-sau-side-effect sinh tin trùng + dữ liệu nhân đôi → XÁC MINH ĐÚNG
| V2 ghi | Audit thấy (source gốc) |
|---|---|
| `action-gate.js` dòng 187 | `idem = send:<conv>:<sha(text + event_id)>` — key **phụ thuộc text** |
| `action-gate.js` dòng 36–40 | `safeReply()` xoay `safeIdx` **toàn cục** → mỗi retry sinh text KHÁC → key khác |
| `gateway.js` dòng 62–79 | catch → re-queue (retry cùng event), KHÔNG cơ chế bù trừ side-effect đã xảy ra |
| `invariants-check.js` dòng 111–117, 128–129 | Injection chỉ throw **ngay đầu** `handleEvent` (trước mọi side-effect) |
| (bổ sung audit) | `store.UNIQUE_KEYS.ai_proposals = ['proposal_id']` — proposal_id là uid → retry sinh proposal row trùng logic; inbound message có unique `platform_message_id` nên retry CÙNG event được dedupe sẵn (điểm này nguyên bản đã idempotent) |

---

## 2. FILES CHANGED

| File | Loại | Nội dung |
|---|---|---|
| `src/system-templates.js` | **MỚI** | Bảng whitelist cứng `SYSTEM_TEMPLATES` (6 template) + `renderSystemTemplate()` — nguồn duy nhất render text cho tin sender=system (BL-8) |
| `src/util.js` | sửa | +`redactPii()` (mask SĐT→`[SDT]`, tên→`[TEN]`, địa chỉ→`[DIA_CHI]`) + export (BL-3) |
| `src/sales-ai.js` | sửa | Guard runtime `assertModelCtxSafe()`: ctx chứa SĐT → throw `MODEL_CONTEXT_PII_CHECK`; cập nhật hợp đồng ctx (BL-3) |
| `src/store.js` | sửa | `UNIQUE_KEYS.ai_proposals += 'turn_key'` — dedupe proposal theo `<event_id>:<slot>` (BL-9) |
| `src/pipeline.js` | sửa | `modelCtx()`; 5 điểm `propose` bỏ `conv` (dòng cũ 242 / 292–295 / 319 / 487 + routeImage); ASK_HUMAN_ACK / OPT_OUT_ACK / COMPLAINT_ACK chuyển sang whitelist template; proposal nháp mode HUMAN có `turn_key` (BL-3+BL-8+BL-9) |
| `src/action-gate.js` | sửa | `safeReply(eventId)` theo `hash(event_id)` (bỏ `safeIdx`); `authorize()` mới (whitelist system); `executeSend` idem key event-scoped + bù trạng thái từ receipt + race re-check trong tx ghi message; `sendReply`/`createOrder` thêm `turn_key` + tái sử dụng row khi duplicate; audit AUTHORIZED/REJECT ghi `template_id + actor + mode + result`; `sendFollowUp` qua template + `idemScope=follow_up:<id>`; `agentSend` idemScope nonce (BL-8+BL-9) |
| `test/gate-a.js` | **MỚI** | Battery Gate A: A1–A7 (mục 7) |
| `test/18-cases.js`, `test/invariants-check.js` | **KHÔNG đụng** | 0 expectation bị đổi/nới (mtime giữ nguyên) |

---

## 3. PII STRIP IMPLEMENTATION (BL-3)

- **ctx hợp pháp duy nhất cho model** — `Pipeline.modelCtx(conv, text)`:
  `{ state, mode, subject_sku, text: redactPii(text), normText: normKey(redacted) }` + FACTS do caller dựng từ product-db + `draftMissing` (chỉ TÊN trường thiếu, không giá trị).
  **Cấm và đã bỏ**: object `conv`, customer object, `draft.slots` (phone/address/name), token/secret, full conversation state.
- **`redactPii()`** (util.js): SĐT VN (0/84 + 9–10 số, chịu separator `.` `-` space) → `[SDT]`; mệnh đề sau `tên/mình là/tôi là` → `[TEN]`; mệnh đề sau `địa chỉ/giao đến/tới/giao hàng tại` → `[DIA_CHI]`. Dùng cùng họ regex với `fillSlots` để redact đúng phần hệ thống bắt được.
- **Guard 2 lớp**: (1) runtime trong `sales-ai.propose` — ctx serialize khớp SĐT → throw, không nuốt; (2) test `assertCtxClean` quét toàn bộ ctx captured theo 4 path (A1/A2).
- **Deterministic layer lấy PII từ DB bằng ID**: tạo đơn/địa chỉ vẫn do gate/order-engine đọc `draft.slots`/orders trong store — model không bao giờ thấy PII. DB (messages in, orders.address_snapshot, audit) giữ nguyên văn PII — chỉ MODEL bị che.
- **CHITCHAT giữ hành vi gốc**: `text: ''` cho model (context tối thiểu hơn cả redact) — không đổi hành vi ngoài phạm vi blocker.

## 4. SYSTEM TEMPLATE WHITELIST (BL-8)

- Bảng cứng `SYSTEM_TEMPLATES` (`src/system-templates.js`): `ASK_HUMAN_ACK`, `COMPLAINT_ACK`, `OPT_OUT_ACK`, `FOLLOW_UP_MARKETING`, `FOLLOW_UP_CARE`, `ACK_DLQ` — mỗi entry `{ kind, allowed_modes, text }`; text chỉ được sinh bằng `renderSystemTemplate()`.
- `authorize()` mới — thứ tự check:
  1. bot tắt → `bot_off`;
  2. `actor=ai` + mode HUMAN → `takeover` (INV-5, giữ nguyên);
  3. marketing/care + mode HUMAN (mọi actor) → `takeover`;
  4. marketing/care + opt-out (mọi actor — **system không phải kênh bypass**) → `opt_out`;
  5. **actor=system**: `msgKind=ai_reply` → REJECT TUYỆT ĐỐI (`system_ai_reply`); còn lại bắt buộc `template_id` tồn tại whitelist (`system_template_unknown`) + đúng kind (`system_template_kind`) + đúng `allowed_modes` (`system_template_mode`) + text render khớp bảng (`system_template_text`) — KHÔNG chấp nhận text tự do dù caller internal;
  6. state check CREATE/CONFIRM order (giữ nguyên).
- **Race re-check (cr-R3 R2-4)**: `executeSend` re-run `authorize()` TRONG CÙNG `store.transaction` ghi row message; race bị bắt → KHÔNG có row, KHÔNG có platform call, trả `race_rejected` về caller (follow-up → HELD).
- **Audit bắt buộc**: mọi entry stage AUTHORIZED (ALLOW và REJECT, gồm cả race + DUPLICATE_SUPPRESSED) ghi `validation: { decision/result, actor, mode, template_id }`.
- Pipeline chuyển 3 template nội bộ sang whitelist: `ASK_HUMAN_ACK` (trước đây đúng vector BL-8: system + ai_reply + text tự do), `COMPLAINT_ACK`, `OPT_OUT_ACK`; `sendFollowUp` render text từ bảng TRƯỚC authorize.
- Probe cũ V2 đã test lại: mode HUMAN + actor system + msgKind ai_reply + text "KHUYEN MAI SOC 50% CHI HOM NAY!!!" → **REJECT (`system_ai_reply`), platform.sentCalls không tăng** (A3); template hợp lệ `ACK_DLQ` trong mode HUMAN → **AUTHORIZED, audit ghi template_id=ACK_DLQ + actor=system + mode=HUMAN + result=ALLOW, text khớp render** (A4).

## 5. EVENT-SCOPED IDEMPOTENCY (BL-9)

- **Send key mới**: `send:<conversation_id>:<event_id>:<msg_kind>:<slot>` với đủ 3 tính chất:
  (1) *stable across retry* — cùng event tính lại ra cùng key; (2) *independent of generated wording* — text chỉ là payload, KHÔNG nằm trong key; (3) *unique by intended side-effect* — `slot` (intent/template) phân biệt các send khác intent trong cùng event.
  Caller ngoài event dùng `idemScope` theo intent: `follow_up:<follow_up_id>` (đúng hướng đóng BL-7 của V2), `agent:<operator>:<nonce>`; test gọi trực tiếp không event → `onetime:<nonce>`.
- **`safeReply(eventId)`**: chọn câu an toàn theo `sha(event_id)` — retry-deterministic; xoá `safeIdx` xoay vòng toàn cục.
- **Proposal dedupe**: `ai_proposals.turn_key = <turn_event_id>:<slot>` (unique index); retry trùng → skip insert, và `sendReply`/`createOrder` **tái sử dụng row cũ** để ghi `decision`/`validation_json` (không mất trạng thái).
- **Bù trạng thái crash-sau-send (INV-2 consistent)**: nhánh duplicate trong `executeSend` — nếu exec cũ chưa DONE nhưng platform CÓ receipt theo exec_id cũ → đóng DONE + message DELIVERED từ bằng chứng; audit ghi `DUPLICATE_SUPPRESSED` (kèm actor/mode/template_id).
- **Inbound row**: giữ nguyên dedupe sẵn có theo unique `platform_message_id` (retry cùng event không nhân đôi tin nhắn vào).

## 6. NEW FAILURE INJECTION TESTS (crash SAU side-effect — điểm V2 chỉ ra suite cũ không phủ)

| Điểm injection | Cách bắn | Assert sau crash + retry |
|---|---|---|
| **A. sau sendMessage, trước commit status** (A5) | wrap `platform.sendMessage`: gọi orig xong (side-effect đã xảy ra) rồi throw | `sentCalls=1`, out messages=1, 1 nội dung, **1 idem key**, exec **DONE** (bù từ receipt), audit `DUPLICATE_SUPPRESSED`, inbox PROCESSED |
| **B. sau insert inbound row, trước handler complete** (A6-B) | wrap `store.insert('messages', direction:'in')`: ghi xong rồi throw | inbound row=1 (unique platform_message_id), proposal=1, sentCalls=1, out=1 |
| **C. sau insert ai_proposal, trước ACK** (A6-C) | wrap `store.insert('ai_proposals')`: ghi xong rồi throw | proposal logical row=1 (turn_key dedupe), decision ghi đủ trên đúng 1 row, sentCalls=1, out=1, inbound=1 |
| **D. generator sinh text khác giữa 2 lần retry** (A7) | wrap `ai.propose` sinh text khác nhau mỗi lần + crash sau sendMessage | 2 text THẬT sự khác nhau, nhưng exec row=1, key giữ nguyên `send:<conv>:<event_id>:ai_reply:PRICE`, không chứa wording, sentCalls=1, out=1 |

Cấm đã tuân thủ: KHÔNG sửa test cũ thành "duplicate accepted", KHÔNG đổi expectation nào của 18-cases/invariants — 2 file này nguyên trạng (xem FILES CHANGED).

## 7. OLD REGRESSION (chạy lại nguyên trạng)

| Suite | Kết quả | Ghi chú |
|---|---|---|
| `node test/18-cases.js` | **18/18 PASS** | PASS (MOCK); file test KHÔNG bị sửa |
| `node test/invariants-check.js` | **6/6 vùng PASS** | PASS (MOCK); file test KHÔNG bị sửa |

`node --check` PASS cho toàn bộ `src/*.js` và `test/*.js`.

## 8. GATE-A TESTS (`node test/gate-a.js` — 7/7 PASS)

| # | Kịch bản | Kết quả | Assert chính |
|---|---|---|---|
| A1 | BL-3 BUY: phone → model_ctx contains phone = false | **PASS** | BUY_ASK propose với text khách chứa tên+SĐT; toàn bộ ctx captured: 0 SĐT, 0 tên, 0 địa chỉ, 0 token, không có key ngoài whitelist; `draftMissing=['address']`; proposal_json không PII; behavior giữ nguyên (hỏi đúng trường thiếu) |
| A2 | BL-3 CHITCHAT / AFTER_SALES / CLAIM (+ PRICE) | **PASS** | CHITCHAT: ctx.text rỗng (context tối thiểu); PRICE (path forward text): `[SDT]`/`[TEN]`/`[DIA_CHI]` có mặt, PII không; AFTER_SALES: ctx.state=AFTER_SALES, sạch; CLAIM: **0 lần gọi model**, chỉ 1 template an ủi sender=system, audit AUTHORIZED có template_id=COMPLAINT_ACK + actor=system + mode=HUMAN |
| A3 | BL-8 system bypass HUMAN → REJECT | **PASS** | Probe V2: HUMAN + actor=system + ai_reply + "KHUYEN MAI SOC 50%..." → `REJECTED_BY_GATE` / reason `system_ai_reply`, sentCalls KHÔNG tăng, metric `gate_rejected_system_ai_reply++`; system + transactional + KHÔNG template_id → `system_template_unknown`; audit REJECT ghi actor/mode/template_id/decision |
| A4 | BL-8 valid system template → AUTHORIZED | **PASS** | ACK_DLQ render từ whitelist trong mode HUMAN → sent, text khớp render, +1 platform call; audit ALLOW ghi template_id=ACK_DLQ/actor=system/mode=HUMAN; cùng template nhưng msgKind=ai_reply → REJECT tuyệt đối; text mượn danh template → `system_template_text` REJECT |
| A5 | BL-9 crash sau send → retry → exactly 1 external send | **PASS** | 1 sentCall, 1 out message, 1 nội dung, 1 exec row, 1 idem key, exec DONE (bù từ receipt), DUPLICATE_SUPPRESSED, inbox PROCESSED |
| A6 | BL-9 crash sau DB insert → exactly 1 logical row | **PASS** | (B) crash sau insert inbound: 1 in / 1 proposal / 1 send / 1 out; (C) crash sau insert proposal: 1 proposal row (turn_key), decision AUTO_EXECUTED trên đúng row đó, 1 send, 1 out |
| A7 | BL-9 generator khác text giữa retries → identity KHÔNG đổi | **PASS** | 2 lần sinh THẬT ra 2 text khác; exec=1; key = `send:facebook:fb-ga7:<event_id>:ai_reply:PRICE`, không chứa wording; 1 sentCall, 1 out; DUPLICATE_SUPPRESSED chứng minh retry trúng CÙNG key |

## 9. TOKEN/PII TRACE (bằng chứng thực chạy — dump ctx captured)

Path PRICE (kỹ hơn trong A2, text khách chứa PII):
```json
{"state":"CONFIRM","mode":"AI","subject_sku":"NT-VANILLA-S",
 "text":"giá sốc của nến vanilla còn không? mình là [TEN], sdt [SDT]",
 "normText":"gia soc cua nen vanilla con khong minh la ten sdt sdt",
 "facts":{"subjectProduct":{...product-db...},"variants":[...]}}
```
Path CHITCHAT/AFTER_SALES: `"text":"", "normText":""` + `{state, mode, subject_sku}` + facts.
Path BUY_ASK (A1): text = `lấy 1 nến vanilla M đỏ, tên [TEN], sdt [SDT]`, `draftMissing:["address"]`.
Path CLAIM: **không có lần gọi model nào**.
- Model ctx KHÔNG bao giờ chứa: `conv`, customer object, `draft.slots`, token (`zcdn-token` chỉ gateway chạm — case 4 đã assert từ trước, giữ nguyên), secret.
- `sales-ai.propose` guard: ctx serialize khớp SĐT → throw `MODEL_CONTEXT_PII_CHECK` (chưa từng vang trong 3 suite).

## 10. KNOWN LIMITATIONS (ghi thẳng thắn, không đẹp số)

1. **ACK_DLQ chưa tự bắn vào luồng DLQ**: template đã whitelist + test ở tầng gate (A4), nhưng `checkSendReceipt` chưa gửi ACK cho khách khi rơi DLQ — wiring thuộc closure BL-5/BL-7; bắn ngay sẽ làm case 11b (`sentCalls=1`) FAIL và Gate A CẤM đổi expectation cũ.
2. **redactPii là regex-based**: SĐT viết dạng lạ, tên KHÔNG có tiền tố (`tên/mình là/tôi là`), địa chỉ KHÔNG có tiền tố (`địa chỉ/giao đến/tới/tại`) sẽ không được mask trong `ctx.text` (path PRICE/VARIANT/BUY_ASK). Guard runtime chỉ bắt được SĐT pattern. Trước khi gắn LLM thật cần thêm lớp kiểm PII trên outbound text (two-way check) — đề xuất cho P3.
3. **agentSend dùng nonce cho idemScope**: crash giữa chừng lần gửi của nhân viên không có dedupe (mỗi lần bắn = 1 side-effect riêng) — ngoài đường event-pipeline của BL-9; production cần operator-client-id.
4. **worklist không dedupe theo event**: retry sau crash có thể sinh 2 row worklist NEEDS_HUMAN — nhiễu nội bộ, không phải side-effect ra ngoài.
5. **Race re-check là single-process**: prototype `store.transaction` khoá ghi tuần tự trong 1 tiến trình; đa tiến trình thật cần SQLite BEGIN IMMEDIATE với re-check trong cùng transaction (điểm re-check đã đặt đúng chỗ).
6. **Phạm vi**: BL-4 (mua lại), BL-5, BL-6, BL-7 chưa đụng — đúng lệnh Gate A (chỉ BL-3/8/9). `sendFollowUp` đánh SENT vẫn vô điều kiện sau executeSend (BL-7 cũ) — KHÔNG sửa trong vòng này.
7. Toàn bộ kết quả là **PASS (MOCK)** — stub LLM, mock platform/carrier/vision/ASR, JSON store, đồng hồ ảo. KHÔNG production-ready. Không mạng, không npm.

## 11. FINAL

**FINAL: PASS** (Gate A — prototype-mock)

Căn cứ acceptance: PII tests ALL PASS (A1+A2, 4 path BUY/CHITCHAT/AFTER_SALES/CLAIM) + system-whitelist ALL PASS (A3+A4) + crash-after-side-effect ALL PASS (A5+A6+A7) + 18-case regression PASS 18/18 (MOCK) + invariant regression PASS 6/6 (MOCK) + 0 expectation weakened (2 file test cũ nguyên trạng) + 0 secret/PII leakage (guard + trace) + 0 actor=system free-text bypass (A3, A4) + 0 text-derived retry identity (A7).
