# P3C — PLATFORM CONSTRAINTS + SEND CORRECTNESS (báo cáo thực thi)

> Phạm vi: đóng đúng **5 blocker nền tảng** của `BAO-CAO-HOI-DONG-V2.md` Phần A.2 trên
> `prototype/` (thuần Node, không npm, không mạng): **BL-1** (FB 24h window), **BL-2** (Zalo CS
> quota), **BL-5** (receipt store inbound-first), **BL-6** (money guard theo subject), **BL-7**
> (follow-up status correctness) + hợp nhất **SendPolicy một chỗ duy nhất** trong AUTHORIZE.
> Giữ nguyên các invariant đã PASS ở P3A (BL-3/8/9) và P3B — chứng minh bằng regression:
> gate-a 7/7 + invariants 6/6 + 18-cases 18/18 + p3b 11/11 sau khi sửa.
> CẤM đã tuân thủ: không nối Meta/Zalo production, không bật AUTO thật, không nối LLM thật,
> không tự chế API không có docs, không dùng private API, KHÔNG sửa Gate A để lách test,
> không đổi kiến trúc lớn, không thêm Redis/Postgres, không gọi production-ready.
> Nhãn kết quả: toàn bộ PASS là **PASS (MOCK)** — stub LLM, mock platform/carrier/vision/ASR,
> JSON store, đồng hồ ảo (`clock.js`). Căn cứ: `docs/00-yeu-cau.md` (INV-1…5),
> `docs/AI1-capability-matrix.md` (A9/A12/A13/A16, B5/B6/B8/B9), `BAO-CAO-HOI-DONG-V2.md` A.2.

---

## 1. BEFORE — evidence 5 lỗi TRƯỚC KHI SỬA (Bước 0 — audit + probe chạy thật trên source gốc)

Kết quả đối chiếu: **source khớp 100% evidence của báo cáo V2** ở cả 5 blocker — probe
`test/_probe-p3c.js` (đã chạy thật 2026-10-05 trên source TRƯỚC khi sửa, App/Store thật, DB tạm;
**file probe đã xoá sau khi lấy evidence**, đúng hygiene P3A/P3B). Output nguyên văn:

```
===== BEFORE PROBE P3C (source chưa sửa) =====
[BL-1] sau 25h im lặng, AI tự gửi: sent=true | sentCalls 1->2 | store có channel_state (last_user_event_ts): false | authorize có check window: KHÔNG (source action-gate.authorize chỉ check bot/mode/opt_out/state)
[BL-2] 20 tin Zalo CS liên tiếp: platform gửi 20 tin | platform.getQuota tồn tại: false | store có channel_budget: false
[BL-2] -> không có mô hình cs_reply.remain: tin thứ 9+ trên Zalo thật sẽ bị API từ chối.
[BL-5] ngay sau send accepted, CHƯA có evidence receipt nào: delivery_status=DELIVERED | verifySend đọc platform.getReceipt(exec_id): CÓ (API không tồn tại trên FB/Zalo thật) | store có outbound_pending: false
[BL-6] subject=nến vanilla (185000), AI nói 145000 (= giá TRÀ): decision=AUTO_EXECUTED | 145000 lọt ra tin khách nhận: true
[BL-7] platform hang_forever, follow-up gửi khi exec tin trước = TIMEOUT_UNKNOWN: fu.status=SENT | message.delivery_status=UNKNOWN | -> follow-up đánh SENT VÔ ĐIỀU KIỆN dù platform UNKNOWN (không có bằng chứng gửi) | idem key follow-up theo text: KHÔNG (P3A đã đổi follow_up:<id> — phần còn lại của BL-7 là mapping SENT)
===== HẾT BEFORE PROBE =====
```

Trace từng cái trên source gốc (khớp V2, không có điểm CHƯA XÁC MINH):

| BL | V2 ghi | Audit thấy trên source gốc |
|---|---|---|
| **BL-1** | `authorize()` không check thời điểm tin cuối của khách | `action-gate.js` authorize (dòng 199–233 bản gốc) chỉ duyệt bot_enabled/mode/opt_out/system-template/state; **không có `last_user_event_ts` trong schema lẫn gate** (grep toàn src = 0 kết quả). Case 17 (+2 ngày) PASS trong lab vì mock không mô hình hoá window — đúng kịch bản V2 |
| **BL-2** | Zalo quota 8 tin CS/48h không có trong code/gate | `MockPlatform` không có khái niệm quota (probe: gửi 20/20 tin); `authorize` không đọc budget nào; không có bảng `channel_budget`. Matrix B5/B6/B9: hết `remain` → API từ chối cứng, không escape hatch |
| **BL-5** | Đánh SENT/DELIVERED ngay không chờ receipt | `verifySend()` bản gốc: `res.ok` → đọc `platform.getReceipt(clientMessageId)` (mock tự hẹn giao theo chính key đó) → gán `delivery_status='DELIVERED'` ngay; không có `outbound_pending`; case 11 đối chứng qua API không tồn tại trên nền tảng thật (FB: chỉ webhook `message_deliveries`/`message_echoes`/`message_reads`; Zalo: `user_seen_message`) |
| **BL-6** | `allowedMoney` = toàn catalogue | `sendReply` bản gốc dòng 85: `for (const v of this.productDB.knownMoneyValues()) allowed.add(v)`; `knownMoneyValues()` thêm giá **mọi variant của mọi SP** (product-db.js dòng 91–99). Probe 7 cross-review tái hiện: nến 185000, nói 145000 (giá trà) → `AUTO_EXECUTED`, tin ra khách nguyên văn. Thêm mặt false-positive cr-R2 R3-2: OVERRIDDEN đè **cả tin** (renderValidated thay toàn bộ text) |
| **BL-7** | Follow-up đánh SENT vô điều kiện; idem key theo text | `sendFollowUp()` bản gốc dòng 660–662: `updateRow('follow_ups', …, { status:'SENT' })` ngay sau executeSend **không đọc** `send.res.ok/timeout` (probe: `fu.status=SENT` khi `exec=TIMEOUT_UNKNOWN`). **Lưu ý trung thực:** phần idem key theo text V2 nhắc đã được **P3A đóng trước** (`idemScope: follow_up:<follow_up_id>` — dòng 644 bản gốc, có audit Gate A); phần còn lại của BL-7 đúng 1 lỗi mapping SENT — đã xác minh và đóng trong vòng này |

---

## 2. FILES CHANGED

| File | Loại | Nội dung |
|---|---|---|
| `prototype/src/shipping.js` | sửa | **BL-2**: MockPlatform mô hình `cs_reply.remain` per user (`getQuota/setQuota/consumeCs`, mặc định thiết kế 8/48h — production đọc API, không hardcode). **BL-5**: mode `ok` tách "send accepted" (response mid, đồng bộ) khỏi "delivery evidence" (receipt webhook về TRỄ sau `latencyMs`, bắn ngược qua `onReceipt`); giữ `getReceipt()` chỉ cho regression cũ. Export `MOCK_SHIPPING_FEE` + `MOCK_PROMOTIONS` (evidence tiền dùng chung) |
| `prototype/src/store.js` | sửa | 4 collection mới (schema delta D6/D9 + log): `outbound_pending` (unique `op_id`,`exec_id`), `receipt_events` (unique `receipt_event_id` — dedupe webhook), `channel_budget` (unique `conversation_id`), `channel_state` (unique `conversation_id` — mốc window) |
| `prototype/src/system-templates.js` | sửa | `ACK_DLQ` thêm cờ `utility_approved: true` (mock-approved Meta Utility, matrix A13) + `isUtilityApproved()`; follow-up marketing/care KHÔNG thuộc loại này |
| `prototype/src/gateway.js` | sửa | **BL-1**: `normalize()` upsert `channel_state.last_user_event_ts` **CHỈ khi `type === 'message'`** (event thật từ user). Bot send/agent send/follow-up không đi qua receive; webhook receipt đi đường `ingestReceipt` riêng → không thể refresh window |
| `prototype/src/order-engine.js` | sửa | phí ship đọc `MOCK_SHIPPING_FEE` (bỏ hardcode 25000 rải — dùng chung evidence với money guard) |
| `prototype/src/action-gate.js` | sửa | **Phần lớn thay đổi** — xem mục 3 (SendPolicy), 4 (receipt store), 5 (money guard), 6 (follow-up): `authorize` thành SendPolicy 8 bước; `executeSend` reserve quota nguyên tử trong tx ghi message + ghi `outbound_pending`; `verifySend` bỏ getReceipt; `checkSendReceipt` đọc op + DLQ + ACK_DLQ; `processReceiptEvent`/`matchAndApplyReceipt`/`reconcileReceiptsForConversation`; `buildAllowedMoney` theo subject + `replaceBadMoneySentences` theo câu; `sendFollowUp` mapping PENDING_RECEIPT/FAILED + HELD window/quota; `sendDlqAck` |
| `prototype/src/app.js` | sửa | wire `platform.onReceipt → ingestReceipt()` (normalize FB `message_delivery` / Zalo `user_seen_message`, event_id deterministic); opts `quotaLowThreshold` (mặc định 2) |
| `prototype/src/pipeline.js` | sửa | `rescheduleWindowHeldFollowUps(conv)` — khách nhắn lại (window mở lại) → follow-up HELD vì `fb_window_closed` quay về SCHEDULED |
| `prototype/test/p3c-cases.js` | **MỚI** | Battery P3C 28 test (mục 7–11) |
| `prototype/test/18-cases.js` | sửa (3 chỗ, có lý do) | xem mục 12 — case 11b (ACK_DLQ), case 15 (job đối chứng), case 17 (window BL-1) |
| `prototype/test/invariants-check.js` | sửa (1 chỗ, có lý do) | xem mục 12 — vùng 2(b) (ACK_DLQ) |
| `prototype/test/gate-a.js`, `test/p3b-cases.js` | **KHÔNG đụng** | 0 expectation đổi |

`node --check` PASS toàn bộ `src/*.js` + `test/*.js`.

---

## 3. SENDPOLICY IMPLEMENTATION (Bước 6 — một chỗ duy nhất)

`authorize()` trong `action-gate.js` là ĐIỂM DUY NHẤT duyệt mọi auto-send. Thứ tự check:

1. bot tắt → `bot_off`;
2. `actor=ai` + mode HUMAN → `takeover` (INV-5, P3A giữ nguyên);
3. marketing/care + mode HUMAN (mọi actor) → `takeover`;
4. marketing/care + opt-out (mọi actor) → `opt_out`;
5. actor=system → whitelist SYSTEM_TEMPLATES (P3A/BL-8 giữ nguyên);
6. **WINDOW 24h FB (BL-1)**: đọc `channel_state.last_user_event_ts` (gateway ghi);
   `age = now − last_user_event_ts`; ≤24h → đi tiếp; >24h → `fb_window_closed`,
   NGOẠI LỆ duy nhất: (a) `actor=human_agent` **và mode HUMAN** (người thật bấm tay — tag
   HUMAN_AGENT 7 ngày, matrix A12); (b) `actor=system` + template `utility_approved`
   (mock-approved Utility, matrix A13). Bot tự gắn human_agent ở mode AI → `human_agent_spoofed`
   (C1.5 — bot CẤM lách);
7. **QUOTA Zalo CS (BL-2)**: chỉ `msgKind ∈ {ai_reply, care}` (transactional đi loại
   transaction — B8 — KHÔNG tốn CS; marketing đi quota promotion riêng — ngoài phạm vi mock);
   đọc `channel_budget` (khởi tạo 1 lần từ `platform.getQuota(user_ref)` — đọc động, không
   hardcode): `remain ≤ 0` → `zalo_quota_exhausted` (REJECT cứng); `remain ≤ ngưỡng (2)` →
   `zalo_quota_low` + `hold:true` (NEEDS_HUMAN/HOLD — budget per conversation);
8. state CREATE/CONFIRM order → `bad_state`.

Output ALLOW mang evidence: `{ ok, actor, mode, template_id, window_open, cs_remain }` —
audit AUTHORIZED ghi đủ các trường này. **Sender chỉ execute**: `executeSend` không tự nghĩ
policy — chỉ RE-RUN authorize trong CÙNG transaction ghi row message (re-check race mode-flip
của P3A) + **reserve quota nguyên tử** trong transaction đó: check remain → cap gom tin
(`turnOps >= cap` → `zalo_cs_turn_cap`; cap = 2 tin CS/turn, remain thấp → 1/turn) →
`cs_remain−=1` → insert message. Definite-fail → hoàn quota (`quota_refund++`).
KHÔNG có check window/quota rải ở sender/scheduler/pipeline (scheduler chỉ đưa follow-up đến
hạn vào gate; pipeline chỉ gọi sendReply như cũ).

---

## 4. RECEIPT STORE INBOUND-FIRST (BL-5)

- **Đường mới bỏ hẳn phụ thuộc `platform.getReceipt()`** (mock giữ method chỉ cho compat).
  Flow: send accepted (response có mid) → `action_executions DONE` (kết quả send đã biết) +
  `messages.delivery_status = 'SENT_PENDING_RECEIPT'` + row `outbound_pending {op_id, exec_id,
  conversation_id, channel, sent_at, text_hash, turn_event_id, platform_message_id,
  receipt_status:'PENDING'}` — **KHÔNG BAO GIỜ tự đánh DELIVERED khi chưa có evidence**.
- **Webhook receipt**: MockPlatform deliver → `onReceipt` → `app.ingestReceipt()` normalize:
  FB → kind `message_delivery` (thật: `message_delivery`/`message_echo`/`message_read`),
  Zalo → `user_seen_message`; event_id deterministic
  `rcpt:<conversation_id>:<clientMessageId>:<kind>` → **platform resend webhook là idempotent**.
- **Match** (`matchAndApplyReceipt`): candidates = op PENDING cùng conversation; ưu tiên khớp
  `mid`; không có mid → cửa sổ thời gian `[sent_at − 2ph (clock skew), sent_at + 24h]`, chọn
  op CŨ nhất. Match → tx: op `DELIVERED` (ghi `receipt_event_id`/`receipt_at`) + message
  `DELIVERED` + exec chưa DONE → DONE + follow_up `PENDING_RECEIPT` → `SENT` + metric
  `receipt_matched++` + audit `RECEIPT_MATCHED` (stage VERIFIED).
- **Receipt không match** → `receipt_unmatched++` + audit `RECEIPT_UNMATCHED` — **KHÔNG gắn
  nhầm**; row receipt GIỮ LẠI (`matched_op_id=null`) để `reconcileReceiptsForConversation()`
  ghép sau khi op sinh ra muộn hơn webhook (crash-window: webhook về trước khi retry ghi op —
  đã gặp thật ở Gate-A A5 và được xử lý).
- **Timeout chưa receipt**: job `check_send_receipt` (hẹn sau mỗi send accepted lẫn timeout)
  chỉ ĐỌC outbound_pending; chưa DELIVERED → reconcile thử → reschedule (max_attempts 3);
  hết hạn → **DLQ + NEEDS_HUMAN (mode HUMAN) + follow_up FAILED + ACK_DLQ đúng 1 lần** —
  **không blind resend** (INV-2 giữ nguyên). Exec gốc vẫn `TIMEOUT_UNKNOWN` (không làm đẹp).
- **ACK storm**: khi platform chết hẳn, chính ACK cũng không có receipt — nếu scope ACK theo
  exec sẽ sinh ACK vô hạn (bắt được khi chạy thử: 67 platform calls). Chốt: idem key ACK là
  `dlq_ack:<conversation_id>` → **mỗi hội thoại nhận ĐÚNG 1 tin ACK** dù rơi DLQ nhiều lần
  (đúng "gửi đúng 1 lần" V2 B.10.5, chặn bão ACK).

## 5. SUBJECT-SCOPED MONEY GUARD (BL-6)

- `buildAllowedMoney(conversation, proposal)` — whitelist CHỈ từ evidence của subject đang nói:
  1. mọi variant của product của `conv.subject_sku`;
  2. variants trong `proposal.facts` (DB render cho chính reply này);
  3. `proposal.allowedMoney` do caller nạp từ snapshot đơn (conversation-scoped);
  4. snapshot MỌI đơn của conversation (total/subtotal/fee/unit_price/line_total);
  5. **tổng mọi tổ hợp (subset sums) giỏ hiện có** + mỗi tổng kèm phí ship (cr-R2 R3-2 probe B1);
  6. phí ship `MOCK_SHIPPING_FEE` (25000, dùng chung nguồn với order-engine) + ngưỡng
     freeship `MOCK_PROMOTIONS.freeshipThresholdVnd` (500000 — probe B3).
  **Giá SP khác trong catalogue KHÔNG còn làm whitelist** → nến 185000 nói 145000 (giá trà)
  → `bad_money` → OVERRIDDEN (C4.1).
- **OVERRIDDEN theo CÂU** (cr-R2 R3-2): `replaceBadMoneySentences()` tách câu, chỉ thay câu
  chứa số sai bằng câu render chính thức từ DB (`renderValidated`), câu đúng đi kèm GIỮ
  NGUYÊN (C4.5); mọi câu đều sai → thay cả tin như cơ chế cũ. `validation_json` ghi thêm
  `allowed_money_source: 'subject_scoped'`.

## 6. FOLLOW-UP STATUS CORRECTNESS (BL-7)

- `sendFollowUp` **cấm đánh SENT vô điều kiện**. Mapping theo bằng chứng:
  `res.ok` (accepted) → `PENDING_RECEIPT`; `TIMEOUT_UNKNOWN` → `PENDING_RECEIPT`;
  webhook receipt về → `SENT` (processReceiptEvent nâng cấp theo exec_id);
  definite failure → `FAILED` + `follow_up_failed++` + worklist `follow_up_send_failed`;
  receipt không bao giờ về (DLQ) → `FAILED` (reason `receipt_timeout_dlq`).
- HELD mở rộng: `takeover` (P3A) + `fb_window_closed` (BL-1) + `zalo_quota_low` (BL-2) →
  `status='HELD'` + audit `HELD_TAKEOVER`/`HELD_WINDOW`/`HELD_QUOTA`; handback (P3A) kích hoạt
  lại HELD takeover; khách nhắn lại kích hoạt HELD window (`rescheduleWindowHeldFollowUps`).
- Idem key: `send:<conv>:follow_up:<follow_up_id>` (P3A đã đặt đúng — kiểm chứng lại bằng
  C5.4/C5.5: 2 follow-up khác ID cùng text = 2 sends; retry cùng ID = 1 send).

---

## 7. WINDOW TESTS (BL-1 — 5/5 PASS)

| # | Kịch bản | Assert chính |
|---|---|---|
| C1.1 | Vừa nhắn <24h AUTO → ALLOW | `channel_state.last_user_event_ts` = mốc event user; tin AI đi bình thường; audit ALLOW `window_open=true`; sau +23h vẫn ALLOW và **mốc KHÔNG đổi** (bot send + receipt không refresh window) |
| C1.2 | Im >24h, ai_reply | REJECT `fb_window_closed`, decision REJECTED_BY_GATE, 0 platform call, metric `gate_rejected_fb_window_closed++`, audit REJECT actor/mode |
| C1.3 | Follow-up care/marketing ngoài 24h | Cả hai → `HELD` (`fb_window_closed`), 0 tin ra, audit `HELD_WINDOW`; khách nhắn lại → care SENT đúng 1 tin (có receipt), marketing cũng chỉ đi sau khi window mở lại |
| C1.4 | Utility template mock-approved | ACK_DLQ ngoài window → ALLOW + đúng 1 call; FOLLOW_UP_CARE template (kind care) ngoài window → vẫn `fb_window_closed` (không lách qua template) |
| C1.5 | Bot gắn human_agent | mode AI + actor human_agent ngoài window → `human_agent_spoofed`, 0 call, metric++; mode HUMAN + agentSend → ALLOW, tin `sender=human_agent` (tag HUMAN_AGENT cho người thật) |

## 8. QUOTA TESTS (BL-2 — 6/6 PASS)

| # | Kịch bản | Assert chính |
|---|---|---|
| C2.1 | remain=8 → send | `getQuota().remain 8→7`; `channel_budget` mirror 7/8; `consumedCs` đúng 1 lần |
| C2.2 | remain=2 | 0 auto-send, `gate_rejected_zalo_quota_low++`, worklist NEEDS_HUMAN, quota KHÔNG trừ; follow-up care đến hạn → HELD (không đốt nốt quota) |
| C2.3 | remain=0 | REJECT cứng `zalo_quota_exhausted`, **0 platform call** (B9: không escape hatch), 0 timeout/fail metric |
| C2.4 | 2 event "đồng thời", remain=1 (threshold=0) | **exactly 1 send**; remain 1→0 đúng 1 lần; event 2 → audit `REJECTED:zalo_quota_exhausted`; khách nhận đúng 1 tin — check-and-decrement trong cùng tx, không có cửa hai worker cùng đọc remain=1 rồi cùng gửi |
| C2.5 | Transactional đúng kind | 2 tin transactional (bill + xác nhận đơn) → CS quota vẫn 8, `consumedCs=0`, thậm chí không tạo budget CS (B8) |
| C2.6 | Gom tin | cap 2 tin CS/turn (tin 3 → `zalo_cs_turn_cap`); remain thấp (3 ≤ ngưỡng+1) → chỉ 1 tin/turn (tin 2 bị chặn — lý do `zalo_cs_turn_cap` hoặc `zalo_quota_low`, cả hai cùng chính sách), remain không tụt dưới ngưỡng |

## 9. RECEIPT TESTS (BL-5 — 5/5 PASS)

| # | Kịch bản | Assert chính |
|---|---|---|
| C3.1 | Send chưa receipt (chưa advance clock) | message `SENT_PENDING_RECEIPT` (KHÔNG DELIVERED); op `PENDING` có sent_at/text_hash/channel |
| C3.2 | Receipt webhook tới | message + op `DELIVERED` (ghi receipt_event_id/receipt_at), exec `DONE`, `receipt_matched++`, audit RECEIPT_MATCHED |
| C3.3 | Duplicate receipt (resend webhook) | `duplicate:true` (dedupe receipt_event_id), không match lại, không sinh row/tin mới |
| C3.4 | Receipt lạ | (a) conversation ghost → không match; (b) receipt +3 ngày ngoài cửa sổ → không gắn nhầm, op vẫn PENDING, tin KHÔNG bị DELIVERED oan |
| C3.5 | Không bao giờ có bằng chứng | đúng 3 lần check → DLQ + mode HUMAN + worklist + **đúng 1 ACK_DLQ**; tin gốc đúng 1 call (không blind resend); exec gốc vẫn TIMEOUT_UNKNOWN |

## 10. MONEY GUARD TESTS (BL-6 — 5/5 PASS)

| # | Kịch bản | Assert chính |
|---|---|---|
| C4.1 | Cross-product: subject nến (185000), AI nói 145000 (giá trà) | `OVERRIDDEN`; tin ra chứa 185000, KHÔNG chứa 145000; validation `bad_money=[145000]` + `allowed_money_source='subject_scoped'` |
| C4.2 | Giá subject 185000 | `AUTO_EXECUTED`, tin ra 185000 |
| C4.3 | Tổng snapshot đơn 210000 / tổng giỏ 330000 / giỏ+fee 355000 | cả 3 `AUTO_EXECUTED` (false-positive cr-R2 R3-2 đã thủ) |
| C4.4 | Phí ship 25000 | `AUTO_EXECUTED` |
| C4.5 | 1 câu sai + 2 câu đúng | chỉ câu sai thay bằng render DB; câu "còn 3 cái" + "chốt sớm kẻo hết" GIỮ NGUYÊN; 145000 biến mất, 185000 xuất hiện |

## 11. FOLLOW-UP TESTS (BL-7 — 6/6 PASS)

| # | Kịch bản | Assert chính |
|---|---|---|
| C5.1 | Success | ngay sau gửi: `PENDING_RECEIPT` (không tin nào SENT khi chưa receipt); receipt về → `SENT`, đúng 1 tin care |
| C5.2 | TIMEOUT_UNKNOWN | `PENDING_RECEIPT` (trước đây SENT vô điều kiện — probe BEFORE), exec TIMEOUT_UNKNOWN, đúng 1 lần gọi platform |
| C5.3 | Definite fail (5xx) | `FAILED` + `follow_up_failed++` + worklist `follow_up_send_failed` |
| C5.4 | 2 follow-up khác ID cùng text | 2 platform call, 2 idem key `send:<conv>:follow_up:<id>` khác nhau, KHÔNG nuốt tin hợp lệ |
| C5.5 | Retry cùng follow_up_id | `DUPLICATE_SUPPRESSED`, đúng 1 send, 1 op row |
| C5.6 | DLQ | follow-up `FAILED`; ACK_DLQ gửi ĐÚNG 1 lần (`dlq_ack_sent++`); DLQ có dòng cho tin gốc + follow-up; mode HUMAN |

## 12. REGRESSION (5 suite — bắt buộc exit 0)

```
node test/18-cases.js          -> TỔNG: 18/18 PASS, 0 FAIL   (exit 0)
node test/invariants-check.js  -> TỔNG: 6/6 vùng PASS, 0 FAIL (exit 0)
node test/gate-a.js            -> TỔNG: 7/7 PASS, 0 FAIL      (exit 0)
node test/p3b-cases.js         -> TỔNG: 11/11 PASS, 0 FAIL    (exit 0)
node test/p3c-cases.js         -> TỔNG: 28/28 PASS, 0 FAIL    (exit 0)  [BL-1×5, BL-2×6, BL-5×5, BL-6×5, BL-7×6, SendPolicy×1]
```
Chạy chuỗi 5 suite **3 vòng liên tiếp**: 15/15 lần đều exit 0 (không flaky — bài học từ
P3B-5c). `node --check` PASS toàn bộ src + test.

### CÁC CHỖ PHẢI SỬA TEST CŨ (đúng quy trình: từng chỗ + lý do — KHÔNG phải lách)

| File/chỗ | Assertion cũ | Assertion mới + LÝ DO |
|---|---|---|
| `18-cases.js` case 11b | `platform.sentCalls.length === 1` ("KHÔNG gửi lại tin thứ 2") | `=== 2` + assert ACK_DLQ đúng 1 tin: **P3C wire ACK_DLQ vào thời điểm DLQ** — chính sách BẮT BUỘC của V2 B.10.5 ("template system ACK… gửi đúng 1 lần tại thời điểm DLQ; assert khách nhận ≥1 tin ack") mà P3A đã ghi là deferred tới closure BL-5/BL-7. Tin gốc VẪN đúng 1 call (không blind-resend — bất biến INV-2 giữ nguyên, có assert riêng). Ghi chú thêm: platform chết hẳn → chính ACK cũng rơi DLQ (assert `>= 1` dòng DLQ, đúng INV-2) |
| `18-cases.js` case 15 | `jobs QUEUED === 0` (mọi kind) | lọc `kind === 'process_event'`: P3C hẹn job đối chứng `check_send_receipt` sau MỖI send accepted (đường đối chứng khi webhook receipt thất lạc). Job này thuộc whitelist `NOT_CANCELLABLE_BY_TAKEOVER` theo thiết kế P3A — **invariants vùng 2(a) chính suite cũ assert nó SURVIVE takeover**, assertion cũ đếm cả nó là mâu thuẫn nội tại với invariant đã PASS |
| `18-cases.js` case 17 | follow-up +2 ngày → `SENT` | đúng ví dụ của lệnh P3C ("case 17 giờ bị HOLD vì ngoài window"): +2 ngày ngoài window 24h FB → `HELD` (`fb_window_closed`) + 0 tin ra; khách nhắn lại → window mở → gửi ĐÚNG 1 lần, `SENT` chỉ khi CÓ receipt (`outbound_pending DELIVERED`, tin care `DELIVERED`). Mô tả case đổi theo. Đây chính là lỗ hổng BL-1 mà V2 cảnh báo ("case 17 PASS trong lab sẽ FAIL trên Messenger thật") |
| `invariants-check.js` vùng 2(b) | `sentCalls.length === 1` | tách 2 assert: tin gốc (text ≠ ACK) đúng 1 call KHÔNG blind-resend + ACK_DLQ đúng 1 lần — cùng lý do case 11b (V2 B.10.5) |

KHÔNG đụng: `test/gate-a.js` (7/7 nguyên trạng), `test/p3b-cases.js` (11/11 nguyên trạng),
các case khác của 18-cases/invariants. Gate A (BL-3/8/9 — khoá P3A) PASS lại nguyên trạng.

---

## 13. KNOWN LIMITATIONS (ghi thẳng thắn, không đẹp số)

1. **Window chỉ cài cho Facebook**: Zalo không có gate "48h CS window" theo thời gian — chặn
   bằng COUNT quota (8/48h) là rào chính; `channel_budget.window_opened_at` ghi mốc nhưng chưa
   có logic reset 48h theo `last_interaction` (production: quota API tự reset phía Zalo).
2. **Quota budget per CONVERSATION, không per user**: prototype 1 conversation/user; nếu một
   user có nhiều thread thì budget phải gộp theo `customer.platform_ref` (production).
3. **Quota timeout không refund**: definite-fail hoàn quota; TIMEOUT_UNKNOWN giữ nguyên reservation
   (kết quả chưa biết — INV-2); đồng bộ lại chỉ khi đọc quota API thật (mock không mô hình resync).
4. **Zalo turn-cap đếm theo `outbound_pending` của cùng event**: tin của turn trước không bị
   cap truy hồi; message-bundling "gom ý thành 1 tin" ở tầng soạn thảo (LLM/pipeline) chưa làm —
   cap hiện tại chỉ chặn số LẦN GỬI, không gộp nội dung.
5. **Receipt matching là heuristic** conversation + mid + cửa sổ thời gian, chọn op cũ nhất khi
   nhiều op PENDING: với nhiều tin gửi gần nhau trong 1 conversation và webhook không mang mid
   (FB `message_delivery` thật chỉ có watermark) có thể ghép sai cặp op↔receipt. Độ chính xác
   trên nền tảng thật CHƯA XÁC MINH (mục 14).
6. **ACK_DLQ scope theo conversation**: DLQ lần 2 của cùng conversation (sau rất lâu) không có
   ACK mới — chọn an toàn để chặn bão ACK; production nên thêm cooldown thời gian thay vì
   "mãi mãi 1 lần".
7. **`utility_approved` là MOCK-APPROVED**: chưa có luồng nộp/duyệt template thật; nhóm template
   phản hồi conversation (ASK_HUMAN_ACK/COMPLAINT_ACK/OPT_OUT_ACK) KHÔNG đánh dấu utility — nếu
   khách im >24h rồi hệ thống phải gửi ACK chính sách sẽ bị chặn window (hiện thực của FB thật,
   chấp nhận: cần template utility thật khi build production).
8. **Subset-sum giỏ cap 12 dòng**: giỏ >12 dòng chỉ tính dòng đơn + tổng (tránh bùng nổ tổ hợp).
9. **Phạm vi**: BL-4 đã đóng ở P3B; các finding không thuộc 5 blocker này (rate-limit chống loop,
   Zalo refresh-token single-flight, race đa tiến trình, TTL decay soft-complaint…) KHÔNG thuộc vòng này.
10. **Match `follow_ups` theo `exec_id`**: follow-up cũ trước P3C không có exec mapping
    PENDING_RECEIPT — chỉ áp dụng cho follow-up gửi từ bản P3C trở đi (prototype chấp nhận).
11. Toàn bộ kết quả là **PASS (MOCK)** — stub LLM, mock platform/carrier/vision/ASR, JSON store,
    đồng hồ ảo. KHÔNG production-ready. Không mạng, không npm.

## 14. CHƯA XÁC MINH (không giả lập rồi gọi supported)

| Mục | Trạng thái | Cần xác minh bằng gì |
|---|---|---|
| Meta Utility approval thật | CHƯA XÁC MINH | `utility_approved` của ACK_DLQ là cờ mock. Cần: Page dev mode + nộp 1 template Utility thật (permission `page_utility_messaging`), đo thời gian duyệt + webhook `message_template_status_update` (P2/VB-10) |
| HUMAN_AGENT eligibility thật | CHƯA XÁC MINH | Gate cho người thật dùng tag ngoài window theo A12; điều kiện truy cập/duyệt app (cr-R2 R1-1) chưa xác minh — cần App Review thật; mock cho phép ngay khi mode HUMAN |
| Zalo quota API thật | CHƯA XÁC MINH | Mock `getQuota` mặc định 8/48h (con số thiết kế theo matrix B5 — docs JS-render, không phải nguyên văn). Cần OA thật gọi `POST /v3.0/oa/quota/message` (test cả v2/v3) + hành vi `change_oa_daily_quota` |
| Zalo webhook retry thật | CHƯA XÁC MINH | Receipt `user_seen_message` mock bắn đúng 1 lần; retry/duplicate thật của Zalo chưa đo — cần thực nghiệm endpoint trả 500 (B12). Dedupe `receipt_events` phía mình đã sẵn sàng cho cả hai |
| Receipt matching accuracy thật | CHƯA XÁC MINH | Heuristic conversation+waterwindow+mid; FB thật `message_delivery` chỉ có watermark (không mid) — accuracy cặp op↔receipt khi nhiều tin gần nhau phải đo trên Page thật; mid ổn định qua resend cũng CHƯA XÁC MINH (cr-R3 R1-1) |
| Zalo transaction type thật | CHƯA XÁC MINH | Exempt `transactional` khỏi CS quota dựa trên B8 (loại `transaction`/`purchase_quota`) — cần xác minh `product_type` khi có OA thật; nếu sai, tin transactional thật vẫn đốt CS quota |
| Hành vi đa tiến trình | CHƯA XÁC MINH | "2 worker đồng thời" C2.4 là 2 event cùng batch tuần tự (single-process). Nguyên tử thật cần SQLite `BEGIN IMMEDIATE` + re-check trong tx (điểm re-check đã đặt đúng chỗ) |

---

## 15. FINAL

**FINAL: PASS (MOCK)** — P3C Platform Constraints + Send Correctness.

Căn cứ acceptance: BEFORE probe chứng minh cả 5 lỗi có thật và khớp V2 (BL-7 ghi rõ phần idem-key
đã đóng ở P3A) + 5 blocker đóng với battery riêng **28/28 PASS** (BL-1×5, BL-2×6, BL-5×5, BL-6×5,
BL-7×6, SendPolicy×1 — ≥26 theo lệnh) + SendPolicy hợp nhất MỘT chỗ trong AUTHORIZE (sender chỉ
execute) + regression nguyên trạng 4 suite cũ **18/18 + 6/6 + 7/7 + 11/11, exit 0, 3 vòng liên
tiếp 15/15** + chỉ 4 chỗ sửa test cũ (2 ACK-DLQ, 1 job-đối-chứng, 1 case 17 window) — mỗi chỗ ghi
rõ lý do là va chạm hợp lệ với chính sách V2 B.10.5 / whitelist P3A / BL-1, KHÔNG nới bất kỳ
expectation nào về INV-2/INV-5 + `node --check` PASS toàn bộ + 6 mục CHƯA XÁC MINH ghi riêng,
không giả lập thành supported.
