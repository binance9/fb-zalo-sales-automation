# AI-3 — FAILURE INJECTION VÒNG 2 (REVIEWER 3: BACKEND / SECURITY / RELIABILITY)

- Contract gốc: `docs/00-yeu-cau.md` — HARD INVARIANTS INV-1…INV-5 (không thay mục tiêu).
- Đầu vào vòng 1: `docs/AI3-backend-reliability.md` (spec + schema 17 bảng), prototype `prototype/` (18/18 PASS — `docs/KET-QUA-18-CASE.md`).
- Nhiệm vụ vòng này: **phá hệ thống có chủ đích** ở 6 vùng rủi ro cao, chứng minh phòng thủ là THẬT; hở thì bít; bít xong phải có test chứng minh.
- Cách chạy lại toàn bộ:
  ```bash
  cd sales-ai-lab/prototype
  node test/18-cases.js            # 18/18 PASS (exit 0)
  node test/invariants-check.js    # 6/6 vùng PASS (exit 0) — suite injection MỚI của vòng 2
  ```
- Evidence: stdout log `prototype/data/test-runs/18-cases-rerun-v2.log`, `prototype/data/test-runs/invariants-run.log`; DB + audit JSONL từng kịch bản ở `prototype/data/test-runs/inv-*/` (21 thư mục, mỗi kịch bản 1 DB riêng).

---

## TỔNG QUAN KẾT QUẢ

| Chỉ số | Giá trị |
|---|---|
| Vùng rủi ro phủ | **6/6** |
| Suite 18 case (vòng 1, chạy lại sau khi sửa) | **18/18 PASS** |
| Suite injection vòng 2 (`test/invariants-check.js`) | **6/6 vùng PASS** (21 kịch bản phá, ~120 assert) |
| Bug/hở THẬT tìm thấy ở prototype | **7** (đã sửa hết, danh mục ở mục 8) |
| Sửa file src | 6 file (`takeover.js`, `order-engine.js`, `action-gate.js`, `pipeline.js`, `gateway.js`, `app.js`) |
| Sửa file test | `test/18-cases.js` (1 dòng kind job, có lý do), thêm `test/invariants-check.js` |

Trong quá trình vá, chính suite injection đã bắt **1 lỗi trong bản vá đầu tiên** của INV-3 (đếm thế hệ sai khiến retry tuần tự tạo đơn 2) — bản vá đã được viết lại theo "thế hệ cội điểm" và chứng minh lại. Đây là bằng chứng suite injection có giá trị riêng, không chỉ diễn lại kết quả.

---

## VÙNG 1 — DUPLICATE EVENT (INV-1: INBOUND IDEMPOTENCY)

### Hở gì (kiểm toán vòng 1)
Case 10 chỉ bắn event trùng **2 lần liền kề trước khi drain**. Chưa chứng minh: (a) resend **xen kẽ trễ** — event trùng đến SAU khi bản gốc đã `PROCESSED` (nền tảng resend thật luôn trễ); (b) bắn trùng **nhiều lần**; (c) **worker ném exception** — đọc code `gateway.processQueue()` thấy catch chỉ đánh `FAILED` rồi **nuốt im lặng**: event bị xử lý **0 lần**, không retry, không DLQ, không metric — vi phạm tinh thần "mỗi event được xử lý đúng một lần" (một lần HOẶC thất bại có dấu).

### Bít bằng cách nào
- `gateway.js`: catch lỗi worker chuyển sang **retry có hạn** — `attempts < 3` đưa event về `RECEIVED` + xếp lại hàng; quá hạn mức mới `FAILED` + metric `event_failed++` (dedupe tầng nhận theo `event_id` KHÔNG đổi — vẫn đúng INV-1).
- `app.js` (`drain`): coi queue còn event re-queue là "có hành động" để vòng drain chạy tiếp, không dừng sớm bỏ sót event.

### Test chứng minh (`test/invariants-check.js` — `area1`; evidence `inv-01a`, `inv-01c1`, `inv-01c2`)
Phá: 6 lần receive CÙNG `platformEventId` — lần 1 xử lý; lần 2 sau trễ 5 phút; lần 3–4 bắn liền 2 cái trong cùng tick; lần 5–6 sau trễ 30 phút. Assert: cả 6 trả HTTP 200, đúng 1 dòng `inbox_events`, 1 tin in, 1 tin out, **1 exec send DONE**, 1 proposal PRICE, `dedupe_hit = 5`, platform nhận đúng 1 call. Biến thể: cùng id khác KÊNH → không dedupe nhầm. Kịch bản lỗi worker: (i) lỗi tạm thời 1 lần → event tự xử lý lại thành công, `attempts=1`; (ii) lỗi vĩnh viễn → đúng 3 lần rồi `FAILED` + `event_failed=1`, **không crash, không side-effect nào lọt ra**.

### Output chạy thật
```
$ node test/invariants-check.js
  [PASS] vùng 1 — INV-1 DUPLICATE EVENT (20ms)
...
$ node -e "const a=require('./data/test-runs/inv-01a/db.json');
  console.log(a.metrics.find(m=>m.metric==='dedupe_hit').value, a.inbox_events.filter(e=>e.event_id==='facebook:mid-inv1-001').length)"
5 1
```

---

## VÙNG 2 — OUTBOUND UNKNOWN (INV-2: CẤM BLIND-RETRY)

### Hở gì
Case 11/12 phủ tốt luồng thuần AI, nhưng đọc code thấy **2 nhánh chưa phủ**:
1. `takeover.setTakeover()` hủy **TẤT CẢ** job QUEUED của hội thoại — kể cả `check_send_receipt` / `reconcile_shipment`. Thực tế xảy ra: send timeout (TIMEOUT_UNKNOWN) → khách đòi người thật/operator takeover → job đối chứng bị hủy → exec **mất đường tra receipt vĩnh viễn**: không DONE, không DLQ, không alert — tin vừa có thể đã đến khách mà hệ thống không bao giờ biết. Vi phạm INV-2 (mất đường recuperación), trong khi job này không bao giờ tự gửi tin nên hủy nó cũng không cần cho INV-5.
2. `executeSend` nhánh **thất bại RÕ (4xx/5xx)**: ghi `FAILED` rồi… im lặng — không metric `send_failed`, không cảnh báo ai cả. Tin mất hẳn mà không ai hay.

### Bít bằng cách nào
- `takeover.js`: thêm `NOT_CANCELLABLE_BY_TAKEOVER = {check_send_receipt, reconcile_shipment}` — takeover chỉ hủy job loại **AI** (`process_event`…). Job đối chứng sống tiếp vì nó không vi phạm INV-5.
- `action-gate.js` (`executeSend`): nhánh FAILED thêm `send_failed++` + `needsHuman` (worklist + flag). Prototype **chọn không auto-retry kể cả 5xx** (an toàn hơn mức spec cho phép "5xx retry được") — đẩy người xử lý, triệt tiêu mọi dạng retry mù.

### Test chứng minh (`area2`; evidence `inv-02a`…`inv-02e`)
(a) send treo (`hang_then_deliver`) → TIMEOUT_UNKNOWN → **takeover xen vào TRƯỚC khi check chạy** → assert job check còn QUEUED → drain: receipt về → DONE, `DELIVERED`, platform nhận đúng 1 call, 0 DLQ. (b) `hang_forever`, takeover sau check#1 → check#2 vẫn QUEUED → 3 lần check đủ → `NO_RECEIPT_AFTER_3_CHECKS` vào DLQ + mode HUMAN + worklist, platform vẫn đúng 1 call (không kèm gửi lại). (c) `fail_5xx` → FAILED, `send_failed=1`, worklist `send_failed:…`, drain tiếp vẫn 1 call. (d) carrier: timeout → blind-retry **BỊ CHẶN** (`RETRY_BLOCKED_NO_RECEIPT` → DLQ) → reconcile `ALREADY_EXISTS` → DONE với tracking cũ, mock nhận đúng 1 create; biến thể `NOT_EXISTS` → retry an toàn **dùng lại đúng key** `shipment:<order_id>`, chỉ 1 vận đơn.

### Output chạy thật
```
$ node -e "const db=require('./data/test-runs/inv-02a/db.json');
  db.jobs.forEach(j=>console.log(j.kind,j.status));
  db.action_executions.forEach(e=>console.log(e.action_type,e.status));
  db.conversations.forEach(c=>console.log('mode='+c.mode))"
check_send_receipt DONE        // job SỐNG QUA takeover rồi đối chứng xong
SEND_MESSAGE DONE
mode=HUMAN

$ node -e "const b=require('./data/test-runs/inv-02b/db.json'); console.log(b.dlq.map(d=>d.fail_reason).join())"
NO_RECEIPT_AFTER_3_CHECKS
$ node -e "const c=require('./data/test-runs/inv-02c/db.json'); console.log(c.metrics.find(m=>m.metric==='send_failed').value)"
1
```

---

## VÙNG 3 — DUPLICATE ORDER (INV-3: ORDER IDEMPOTENCY)

### Hở gì
18 case vòng 1 **không có case nào bắn trùng idempotency key trực tiếp**. Đọc `order-engine.phaseA`: key = `order:<conv>:<hashGiỏ>` — phát hiện bug thật: khách **đổi SP rồi đổi lại** (V1 → V2 → V1): đơn V1 cũ đã `CANCELLED` vẫn giữ key đó → phaseA coi là "trùng key" → **trả về đơn chết** → `conv.draft.order_id` trỏ vào đơn CANCELLED → khách "xác nhận" văng `BAD_STATUS_CANCELLED` → **kẹt vĩnh viễn**, reserve treo theo. Idempotency dùng sai mục đích: nó phải chặn *retry của cùng intent*, không được *hồi sinh intent đã bị hủy*.

### Bít bằng cách nào
`order-engine.js` phaseA chuyển sang **idempotency key theo thế hệ cội điểm**: `order:<conv>:<hashGiỏ>#<gen>` — chọn đơn có gen LỚN NHẤT của cùng conversation+giỏ: còn `DRAFT/CONFIRMED` → retry thật → idempotent hit (đúng 1 đơn); là `CANCELLED/FAILED` → mua lại ra thế hệ mới (`#gen+1`), key mới vẫn UNIQUE; chưa có → `#0`.

### Test chứng minh (`area3`; evidence `inv-03a`…`inv-03d`)
(a) tuần tự: mua xong gọi `gate.createOrder` lần 2 cùng key → `idempotent:true`, 1 orders row, 1 order_items, reserve đúng 1. (b) "đồng thời": 2 event cùng giỏ khác `platformEventId` trong 1 tick → 1 DRAFT, 1 bộ items, reserve 1 lần (bill lặp 2 tin — chấp nhận, đơn vẫn 1). (c) **V1→V2→V1**: không hồi sinh đơn CANCELLED — ra DRAFT mới `#1`, xác nhận được ngay, đúng 1 CONFIRMED, stock 3→2. (d) confirm 2 lần → phaseB idempotent, không sinh row nào.

### Output chạy thật
```
$ node -e "const db=require('./data/test-runs/inv-03c/db.json');
  for (const o of db.orders.filter(o=>o.price_snapshot_json.includes('NT-VANILLA')))
    console.log(o.idempotency_key, o.status, o.total)"
order:facebook:fb-i3c:60e4cbba1a2f35ca#0 CANCELLED 210000
order:facebook:fb-i3c:60e4cbba1a2f35ca#1 CONFIRMED 210000   // mua lại -> đơn MỚI, chốt được
```
Lưu ý quá trình: bản vá đầu (đếm gen bằng số lượng rows) bị chính suite này bắt lỗi "lần 2 cùng key → idempotent hit" FAIL vì gen đếm nhầm cả đơn DRAFT hiện hành → tạo đơn thứ 2. Đã viết lại theo cội điểm rồi chứng minh lại 6/6 + 18/18.

---

## VÙNG 4 — STOCK/PRICE RACE (INV-4: REVALIDATE TRƯỚC COMMIT)

### Hở gì
Case 9 chỉ phá **tồn**. **Giá** thì `phaseB` có check `PRICE_CHANGED` nhưng (i) không có case nào test; (ii) đọc `pipeline.routeConfirm` thấy nhánh này rơi vào thông báo chung "đơn có vấn đề nhỏ" và **giữ draft giá cũ mãi** — dead-end + reserve treo, không khớp thiết kế AI3 mục 5.1 ("giá đổi → ROLLBACK pha B → đặt giữ lại theo giá mới"). Ngoài ra chưa có kịch bản **2 khách giành món cuối trong cùng 1 tick**.

### Bít bằng cách nào
`pipeline.js` routeConfirm thêm nhánh `PRICE_CHANGED` (đúng thiết kế): hủy draft giá cũ (hoàn reserve) → gọi lại pha A **đọc giá FRESH ngay lúc đó** → tạo draft giữ chỗ mới theo giá mới → gửi khách tổng mới chờ xác nhận; lần "xác nhận" kế tiếp chạy pha B với giá mới. Nếu lúc giữ lại cũng hết hàng → báo hết + gợi ý SP khác (state không kẹt).

### Test chứng minh (`area4`; evidence `inv-04a`…`inv-04c`)
(a) Giá 185000 → draft; can thiệp ngoài đổi giá 200000; chốt → assert: draft cũ `CANCELLED`, draft MỚI snapshot `unit_price=200000`, audit có `FAILED:PRICE_CHANGED` + proposal `ORDER_REPRICED`, khách thấy tổng **225000** (không thấy 210000); chốt lại → CONFIRMED 225000, stock 3→2 đúng 1 lần, reserve sạch, toàn cột không oversell. (b) stock 1→0 giữa chat và chốt → chặn, không CONFIRMED, báo hết hàng, `assertNoOversell`. (c) 2 khách A/B cùng tick giành món cuối → A giữ chỗ, B bị chặn nhận "hết hàng", tồn hiệu dụng về 0 đúng 1 đơn; A chốt → stock đúng 0.

### Output chạy thật
```
$ node -e "const db=require('./data/test-runs/inv-04a/db.json');
  for (const o of db.orders) console.log(o.idempotency_key, o.status, o.total)"
order:facebook:fb-i4a:60e4cbba1a2f35ca#0 CANCELLED 210000
order:facebook:fb-i4a:60e4cbba1a2f35ca#1 CONFIRMED 225000

$ grep -c 'ORDER_REPRICED' data/test-runs/inv-04a/audit.jsonl
6
```

---

## VÙNG 5 — HALLUCINATED PRICE (Action Gate đè bằng DB)

### Hở gì
Case 8 chỉ chặn được giá bịa **CÓ đơn vị tiền** ("92500đ" — `extractMoney` yêu cầu đơn vị `đ/vnd/k` hoặc nhóm nghìn). Chính KET-QUA vòng 1 (mục 3.6) đã tự nhận: **giá bịa KHÔNG đơn vị ("giá 92500") lọt thẳng qua guard** và ra ngoài. Chưa có test bơm proposal độc trực tiếp vào biên hợp đồng LLM→gate.

### Bít bằng cách nào
`action-gate.js` (`sendReply` VALIDATE): với intent mang giá (`PRICE`/`VARIANT`/`STOCK`), quét thêm **số trần 4–7 chữ số ≥ 10000** (word-boundary nên SĐT 10 số và mã đơn không dính) và **dạng thập phân k ("92.5k")** → gộp vào danh sách money đối chiếu DB; lệch DB → override như case 8. Giá THẬT có/không đơn vị đều được thông (nằm trong `knownMoneyValues`). Ghi thêm `bare_numbers_in_text` vào `validation_json` để audit.

### Test chứng minh (`area5`; evidence `inv-05a`, `inv-05b`)
(a) E2E stub bịa "GIÁ SỐC 92500đ" → `OVERRIDDEN`, khách nhận 185000. (b) bơm thẳng gate lời bịa KHÔNG đơn vị "giá 92500 cho…" → **`OVERRIDDEN`**, đè bằng 185000, validation ghi `bad_money=[92500]`. (c) "92.5k" → `OVERRIDDEN`. (d) giá thật không đơn vị "Dạ giá 185000 nha anh!" → `AUTO_EXECUTED` (guard không chặn nhầm sự thật). Assert cuối: quét **mọi** tin out — không một chuỗi "92500"/"92.5k" lọt ra ngoài.

### Output chạy thật
```
$ node -e "const db=require('./data/test-runs/inv-05b/db.json');
  const p=db.ai_proposals.filter(x=>x.intent==='PRICE');
  console.log(JSON.stringify(JSON.parse(p[p.length-2].validation_json)))"
{"money_in_text":[],"bare_numbers_in_text":[92500],"bad_money":[92500],
 "overridden_fields":["price"],"evidence_present":true}
```

---

## VÙNG 6 — HUMAN TAKEOVER (INV-5: HUMAN_OWNED KHOÁ TOÀN BỘ AUTO)

### Hở gì
Case 15/16 chỉ chứng minh AI (actor `ai`) bị chặn. Đọc `authorize()`: điều kiện là `actor === 'ai' && mode === 'HUMAN'` — **follow-up marketing/care do scheduler bắn (actor `system`) đến hạn trong lúc HUMAN_OWNED VẪN TỰ ĐỘNG GỬI RA OUTSIDE** — vi phạm đúng chữ INV-5 "CẤM MỌI auto-send". Và khi bị chặn, `sendFollowUp` **CANCEL luôn** follow-up (mất việc chăm sóc) thay vì giữ lại. Thiếu test bơm action độc gọi thẳng gate bỏ qua pipeline, và thiếu test "takeover giữa CONFIRM → trả quyền → chạy tiếp đúng state".

### Bít bằng cách nào
- `action-gate.js authorize`: mode HUMAN chặn thêm **mọi** msgKind `marketing`/`care` bất kể actor (chỉ nhân viên `human_agent` và tin transactional/chính sách — template khiếu nại, ack opt-out, trạng thái đơn — được phép).
- `action-gate.js sendFollowUp`: bị chặn vì takeover → follow-up chuyển `HELD` (extension enum của Phụ lục A — ghi rõ ở mục 9), không hủy, không gửi; audit `HELD_TAKEOVER`.
- `takeover.js handback`: kích hoạt lại các follow-up `HELD` → `SCHEDULED` để scheduler chạy tiếp đúng 1 lần. `app.js runDueJobs` chụp snapshot 1 lượt/tick (tránh re-pick loop).

### Test chứng minh (`area6`; evidence `inv-06a`…`inv-06d`)
(a) gọi thẳng `gate.sendReply` (actor ai) khi HUMAN → `sent:false, reason:'takeover'`, `gate_rejected_takeover++`, 0 tin AI mới. (b) takeover giữa CONFIRM → `createOrder`/`confirmOrder` đều reject `takeover`, 0 đơn CONFIRMED, state không xáo trộn → handback (state giữ `CONFIRM`, không reset NEW_LEAD) → khách "xác nhận" → CONFIRMED + vận đơn tạo bình thường. (c) follow-up care đến hạn ĐÚNG LÚC HUMAN → `HELD`, 0 tin care đi ra, audit `HELD_TAKEOVER` → handback → `SENT` đúng 1 tin, chạy thêm 24h không có tin thứ 2. (d) template khiếu nại (system/transactional) vẫn đi được trong HUMAN; tin khách sau đó không kích hoạt AI; nhân viên `agentSend` bình thường.

### Output chạy thật
```
$ node -e "const db=require('./data/test-runs/inv-06c/db.json');
  db.follow_ups.forEach(f=>console.log(f.follow_up_id,f.status,f.cancel_reason));
  console.log('HELD_TAKEOVER audits:', db.audit_events.filter(x=>x.execution_result==='HELD_TAKEOVER').length)"
fu-care-i6c SENT null          // bị giữ trong HUMAN, handback xong gửi đúng 1 lần
HELD_TAKEOVER audits: 1
```

---

## 7. BẢNG 6 VÙNG → TRẠNG THÁI

> **Trạng thái áp dụng cho PROTOTYPE-MOCK (Node đơn tiến trình + JSON store + mock FB/Zalo/ĐVVC + LLM stub + đồng hồ ảo). KHÔNG PHẢI production-ready.**

| # | Vùng | Invariant | Cơ chế phòng thủ (đã được injection chứng minh) | Trạng thái |
|---|------|-----------|--------------------------------------------------|------------|
| 1 | Duplicate event (cả resend trễ, cả worker lỗi) | INV-1 | Unique `event_id` tại cửa vào + dedupe_hit metric + retry có hạn khi worker throw | **PHÙ ĐỂ PROTOTYPE-MOCK** |
| 2 | Outbound UNKNOWN (send + carrier, cả takeover xen giữa) | INV-2 | TIMEOUT_UNKNOWN → cấm retry mù → check_receipt/reconcile bằng receipt; DLQ sau 3 lần; takeover không hủy job đối chứng; 5xx báo người | **PHÙ ĐỂ PROTOTYPE-MOCK** |
| 3 | Duplicate order (tuần tự, 1 tick, trùng key đơn đã hủy) | INV-3 | Idempotency key thế hệ cội điểm `order:conv:hash#gen` + check-and-set trong transaction | **PHÙ ĐỂ PROTOTYPE-MOCK** |
| 4 | Stock/price race (đổi giá, đổi tồn, 2 khách 1 tick) | INV-4 | Pha A/pha B trong 1 transaction, re-read FRESH trước commit; PRICE_CHANGED → rollback + giữ lại theo giá mới; chống oversell toàn cột | **PHÙ ĐỂ PROTOTYPE-MOCK** |
| 5 | Hallucinated price (có đơn vị, không đơn vị, dạng k) | Nguyên tắc vàng | Gate quét money (có đơn vị + bare-number trong ngữ cảnh giá) → lệch DB là đè bằng render từ DB; không tin lời AI | **PHÙ ĐỂ PROTOTYPE-MOCK** |
| 6 | Human takeover giữa chừng | INV-5 | Gate AUTHORIZE chặn actor ai + mọi marketing/care khi HUMAN; follow-up HELD; handback kích hoạt lại, giữ state | **PHÙ ĐỂ PROTOTYPE-MOCK** |

---

## 8. DANH MỤC BUG/HỞ THẬT TÌM THẤY Ở PROTOTYPE VÒNG 1 → ĐÃ SỬA

| # | File | Bug/hở | Mức độ | Sửa |
|---|------|--------|--------|-----|
| 1 | `src/takeover.js` | Takeover hủy cả job `check_send_receipt`/`reconcile_shipment` → exec TIMEOUT_UNKNOWN mất đường đối chứng vĩnh viễn (không DONE/DLQ/alert) | Cao (INV-2) | Whitelist `NOT_CANCELLABLE_BY_TAKEOVER`; chỉ hủy job AI |
| 2 | `src/order-engine.js` | Trùng idempotency key với đơn CANCELLED cũ → "hồi sinh" đơn chết, khách kẹt `BAD_STATUS_CANCELLED`, reserve treo | Cao (INV-3) | Key thế hệ cội điểm `#gen`; đơn chết → thế hệ mới; retry thật vẫn dedupe |
| 3 | `src/pipeline.js` | `PRICE_CHANGED` rơi vào thông báo chung, draft giá cũ giữ mãi → dead-end + reserve treo | Cao (INV-4) | Hủy draft cũ → pha A lại với giá FRESH → báo tổng mới → chốt tiếp |
| 4 | `src/action-gate.js` | Follow-up marketing/care (actor system) đến hạn trong mode HUMAN vẫn tự gửi ra ngoài | Cao (INV-5) | `authorize` chặn marketing/care khi HUMAN bất kể actor; sendFollowUp → `HELD`; handback kích hoạt lại |
| 5 | `src/action-gate.js` | Giá bịa KHÔNG đơn vị ("giá 92500") hoặc "92.5k" lọt qua guard ra ngoài khách | Trung bình (nguyên tắc vàng) | Bare-number scan + k-scan cho intent PRICE/VARIANT/STOCK |
| 6 | `src/action-gate.js` | Send thất bại RÕ (4xx/5xx) bị nuốt im lặng — không metric, không alert | Trung bình (INV-2) | `send_failed++` + needsHuman/worklist; không auto-retry |
| 7 | `src/gateway.js` | Worker throw → event `FAILED` nuốt im lặng: xử lý 0 lần, không retry/DLQ/metric | Trung bình (INV-1) | Retry có hạn ≤3 lần rồi FAILED + `event_failed++`; drain xử lý requeue |

Sửa kèm (test harness): `test/18-cases.js` case 15 đổi kind job giả `'check_send_receipt'` → `'process_event'` — bắt buộc sau fix #1 vì kind cũ giờ là job đối chứng không được hủy; `job-fake-15` vẫn assert đúng ý gốc ("jobs AI QUEUED bị hủy sạch"). File mới `test/invariants-check.js`. Fix nội bộ `app.js runDueJobs`/`drain` phục vụ #4 và #7.

---

## 9. THỨ JSON-MOCK (thay SQLite) KHÔNG CHỨNG MINH ĐƯỢC — kế thừa vòng 1 + bổ sung vòng 2

1. **Đồng thời đa tiến trình**: "cùng 1 tick" ở đây là 2 event tuần tự trong 1 batch của 1 tiến trình đơn luồng. SQLite thật + `BEGIN IMMEDIATE` sẽ xử lý 2 instance/2 connection ghi cùng lúc — thứ JSON-mock không tái hiện được (KET-QUA mục 4, giữ nguyên).
2. **Crash giữa chừng thật**: rollback bằng snapshot JSON chỉ đúng ngữ nghĩa all-or-nothing của LOGIC; mất điện giữa write file / giữa HTTP request thật cần WAL + journal + recovery khi mở lại. Write-ahead intent đã có (`action_executions`) nhưng crash-recovery thật chưa test.
3. **Định danh trùng của nền tảng**: dedupe dựa trên `platformEventId` mock. Việc Meta mid / Zalo msg_id có ổn định qua resend thật hay không vẫn CHƯA XÁC MINH (AI3 Phụ lục C.1/C.6) — mock không chứng minh được.
4. **Hành vi idempotency thật của API ngoài**: `ALREADY_EXISTS`/`NOT_EXISTS` của MockCarrier là mô hình; idempotency chính thức của Meta Send API, Zalo, GHN/GHTK/J&T/ViettelPost cần key thật để xác minh (C.2–C.4).
5. **Timing/jitter/throttle thật**: đồng hồ ảo không mô phỏng network jitter, rate-limit 429, throttling hai chiều của nền tảng; các ngưỡng (60s check, backoff) là hằng số lab.
6. **LLM thật né guard**: stub "bịa" theo kịch bản cài sẵn. LLM thật có vô số cách phát biểu (giá viết bằng chữ, tách tin `---`, ảnh chứa giá…) — bộ guard text hiện tại (money + bare-number trong ngữ cảnh giá) chưa phải lớp phòng thủ đầy đủ với output model thật; cần red-team thêm khi gắn model thật.
7. **Bảo mật tầng transport**: bỏ HTTP + HMAC (`X-Hub-Signature-256`) từ vòng 1 — signature verify, timing-safe compare, IP allowlist Zalo (C.1) chưa nằm trong prototype.

---

## 10. GHI CHÚ ĐỀN TRẠNG THÁI (deviation ghi rõ)

- Follow-up thêm trạng thái `HELD` (ngoài enum `SCHEDULED|SENT|CANCELLED|FAILED` trong AI3 Phụ lục A) — cần cập nhật schema khi build thật, hoặc map `HELD` = `SCHEDULED + hold_flag`.
- `idempotency_key` của orders đổi format sang `order:<conv>:<hash>#<gen>` — bản dựng thật giữ nguyên ý nghĩa UNIQUE + thêm cột `generation` nếu muốn query sạch.
- Prototype chọn **không auto-retry cho 5xx** (đẩy người) — chặt hơn AI3 mục 7.1 ("5xx retry được"); khi build thật có thể bật retry-backoff cho 5xx với điều kiện receipt-check như spec.
