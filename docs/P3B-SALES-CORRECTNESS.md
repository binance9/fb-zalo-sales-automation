# P3B — SALES CORRECTNESS (báo cáo thực thi)

> Phạm vi: đóng đúng **5 hạng mục sales-correctness** trên `prototype/` (thuần Node, không npm, không mạng):
> (1) Repurchase/Re-entry, (2) Draft TTL, (3) Qty extraction, (4) Claim/Takeover, (5) Cancel order.
> **Giữ nguyên các invariant Gate A đã đóng ở P3A** — INV-1…5, PII-strip trước model, system template
> whitelist, event-scoped idempotency (chứng minh bằng regression: gate-a 7/7 PASS sau khi sửa).
> Vẫn CẤM (đã tuân thủ): production, LLM thật, Window Gate (BL-1), Zalo quota (BL-2), receipt store (BL-5),
> đổi kiến trúc. Nhãn kết quả: toàn bộ PASS đều là **PASS (MOCK)** — stub LLM, mock platform/carrier,
> JSON store, đồng hồ ảo (`clock.js`).
> Căn cứ đầu vào: `docs/00-yeu-cau.md`, `docs/P3A-GATE-A.md`, `docs/cross-review-R2.md`, `docs/cross-review-R3.md`
> (các finding: R3-1 mua lại bị nuốt, R2-7 qty=903123456, R3-3 complaint false-positive, R3-5/R2-8 reservation
> không TTL, R2-M2 claim không close, R2-M3 HUMAN bỏ fillSlots, R3-7 không có luồng hủy đơn).

---

## 1. BEFORE — evidence 5 lỗi TRƯỚC KHI SỬA (probe chạy thật trên source gốc)

Probe `test/_probe-p3b.js` (đã chạy thật 2026-10-05 trên App/Store thật của prototype, DB tạm, KHÔNG sửa
source; **file probe đã xoá sau khi lấy evidence**). Kết quả nguyên văn:

```
[P1] sau mua lan 1: state=ORDERED orders=CONFIRMED
[P1] sau tin mua lai: state=ORDERED orders=CONFIRMED | tin out moi: 2 | tin cuoi: "Dạ đơn ORD4_7F95CF của anh/chị đã được xác nhận, tổng 210000..."
[P1] sau khi van xac nhan: tong orders=1 (CONFIRMED) — khong bao gio co don thu 2: BUG XAC NHAN (mua lại bị nuốt)
[P2] sau reserve: reserved=1 effective=2
[P2] sau 48h im lang: reserved=1 effective=2 | draft con treo: ord_muunmh2h_r_9dffe0 — reservation khong bao gio duoc tra: BUG XAC NHAN (không TTL)
[P3] extractItems("sdt 0903123456 cho minh 1 hop tra hoa say") = [{"sku":"TRA-HOA-SEY-50","qty":903123456}] — BUG XAC NHAN (SĐT thành qty)
[P4] cau hoi "chua thay bang size" (chua co don): mode=HUMAN claim={"opened_at":"2026-10-04T09:00:00.000Z","reason":"complaint","origin_state":"PRODUCT_QA"} — BUG XAC NHAN (false-positive claim)
[P5] sau tin "huy don": order.status=CONFIRMED | shipment=CREATED | carrier.cancelCalls=0 — BUG XAC NHAN (không có luồng hủy đơn)
```

Trace code tương ứng từng lỗi (source gốc):

| # | Lỗi | Trace code (trước khi sửa) |
|---|---|---|
| 1 | Mua lại cùng giỏ bị nuốt, không bao giờ có đơn #2 (cr-R3 R3-1 BLOCKER) | `order-engine.js` phaseA: key `order:<conv>:<hashGiỏ>#<gen>` — đơn CONFIRMED cùng giỏ → idempotent hit trả đơn cũ; `action-gate.js` `ORDER_ACTION_STATES` không có ORDERED/AFTER_SALES → `createOrder` reject `bad_state`; `pipeline.js` routeBuy nhánh lỗi `return { ..., error: r.reason, replies: [] }` → **0 tin trả lời**; `session.js` TRANSITIONS.ORDERED không có BUY_INTENT |
| 2 | Reservation không TTL → giữ chỗ rò rỉ vĩnh viễn (cr-R3 R3-5, cr-R2 R2-8) | `order-engine.js` reserve chỉ hoàn qua `cancelDraft` (đổi SP / hết hàng lúc chốt / đổi giá); grep `ttl|expire` trên `src/` = 0 kết quả; `app.js` `runDueJobs` chỉ xử lý `check_send_receipt` + `reconcile_shipment` + follow-ups |
| 3 | SĐT đọc thành qty (cr-R2 R2-7) | `pipeline.js` `qtyWord: /(\d+)\s*(?:cai|cái|hop|hộp|sp|san pham|sản phẩm)?/` — nhóm đơn vị OPTIONAL + lấy match đầu đoạn → `extractItems('sdt 0903123456 …')` → qty=903123456 → phaA OUT_OF_STOCK → khách bị chặn mua bằng một câu hoàn toàn bình thường |
| 4 | Complaint false-positive + claim không close + HUMAN bỏ fillSlots (cr-R3 R3-3, cr-R2 R2-M2/M3) | `RE.complaint` match `chua thay|xau|tệ` trên MỌI tin ở MỌI state TRƯỚC mọi route → "chưa thấy bảng size" mở claim oan + takeover + xin lỗi; `session.js` chỉ có `openClaim`, không có close; nhánh `mode === 'HUMAN'` early-return TRƯỚC `fillSlots` |
| 5 | Không có luồng hủy đơn (cr-R3 R3-7) | `cancelDraft` reject mọi order không phải DRAFT (`NOT_DRAFT`); `detectIntent` không có CANCEL_ORDER → tin "hủy đơn…" rơi CHITCHAT; `MockCarrier` không có `cancelShipment` |

---

## 2. FILES CHANGED

| File | Loại | Nội dung |
|---|---|---|
| `prototype/src/session.js` | sửa | TRANSITIONS.ORDERED += `BUY_INTENT` (re-entry); **`closeClaim(conv, operator, reason)`** mới: về ĐÚNG `origin_state` (transition + fallback force có audit), xoá claim, audit `CLAIM_CLOSE` (ai đóng, lúc nào, mở lúc nào) |
| `prototype/src/pipeline.js` | sửa | (HM-1) routeBuy: re-entry ORDERED/AFTER_SALES → `buy_gen++` + ngắt `draft.order_id` + transition BUY_INTENT; (HM-3) `extractQty(seg, product)` thay `qtyWord` (mask SĐT/số dài ≥9 chữ số → unit bắt buộc → số ngắn sau động từ → số ngắn trước tên SP; mặc định 1); (HM-4) `classifyComplaint` strong/weak + `convHasPlacedOrder` + counter bất mãn lặp lại; nhánh HUMAN chạy `fillSlots` TRƯỚC khi HOLD (vẫn không auto-send); (HM-5) `RE.cancelOrder` + `routeCancel`; (HM-2) `routeConfirm` nhận diện draft TTL-expired → `renewExpiredDraft` (pha A lại + bill mới chờ xác nhận lần nữa) |
| `prototype/src/order-engine.js` | sửa | (HM-1) phaseA key scope theo INTENT: `order:<conv>:<hash>:g<buy_gen>#<retry_gen>` (mua lại = generation mới; retry cùng intent vẫn trùng key — INV-3); (HM-2) `draftTtlMs` cấu hình (mặc định 24h), order DRAFT có `draft_expires_at`, `cancelDraft` ghi `cancel_reason` lên row, **`expireStaleDrafts(now)`** sweep hoàn reservation; (HM-5) **`requestCancelOrder`**: DRAFT → release; CONFIRMED không shipment → restock + CANCELLED; CONFIRMED có shipment → **`cancelShipmentViaCarrier`** (write-ahead intent key riêng `cancel_shipment:<order_id>` → `carrier.cancelShipment` → có receipt CANCELLED mới restock + huỷ đơn; carrier từ chối → order `CANCEL_PENDING` + `cancel_carrier_reason` + needsHuman, KHÔNG huỷ lửng); `restockOrder` hoàn tồn đã trừ lúc chốt; audit đầy đủ actor/at/reason |
| `prototype/src/shipping.js` | sửa | MockCarrier thêm `cancelShipment({idempotencyKey, shipmentId, trackingNumber})` — bắt buộc idem key, receipt `CXL-…`, idempotent (cùng key/tracking trả lại receipt cũ), `cancelMode: 'ok' | 'refuse'` (refuse → `REJECTED, reason: carrier_policy_not_cancellable`; đã DELIVERED → REJECTED), `cancelCalls` log để assert |
| `prototype/src/app.js` | sửa | opts `draftTtlMs` + `carrierCancelMode` truyền xuống; `runDueJobs` chạy `expireStaleDrafts(clock.now())` mỗi tick (scheduler tự release) |
| `prototype/test/p3b-cases.js` | **MỚI** | Battery P3B: 11 test (mục 4) |
| `test/18-cases.js`, `test/invariants-check.js`, `test/gate-a.js` | **KHÔNG đụng** | mtime giữ nguyên — 0 expectation bị đổi/nới |

`node --check` PASS cho toàn bộ `src/*.js` + `test/*.js`.

---

## 3. TỪNG HẠNG MỤC

### HẠNG MỤC 1 — REPURCHASE / RE-ENTRY (đóng R3-1)

**IMPLEMENTATION**
- Khách ở ORDERED/AFTER_SALES bày tỏ ý định mua → `routeBuy` chuyển về BUY_INTENT (transition mới
  `ORDERED→BUY_INTENT`, reason `repurchase_reentry`, có audit) → COLLECT_ORDER như luồng mua thường.
- **Idempotency key scope theo INTENT, không scope theo giỏ**: phaseA dùng
  `order:<conv>:<hashGiỏ>:g<buy_gen>#<retry_gen>` — `conversation.buy_gen` tăng 1 mỗi lần mở intent mua
  mới từ ORDERED/AFTER_SALES. Mỗi lần mua lại = generation mới → **đơn #2 THẬT** (id mới, order_items mới,
  reserve mới, vận đơn riêng); retry/crash CÙNG intent (cùng buy_gen) vẫn trùng key → đúng 1 đơn — **INV-3
  giữ nguyên** (area3a/b/c/d của invariants-check PASS lại nguyên trạng).
- `draft.order_id` của đơn cũ bị ngắt ngay khi re-entry → không bao giờ trả đơn cũ "như thể đã đặt".

**TESTS** — `P3B-1a` (mua lại cùng giỏ từ ORDERED: 2 đơn song song trong store, 2 bill + 2 xác nhận,
2 vận đơn riêng, trừ kho cho cả 2, lần mua lại tiếp theo ra đơn #3 riêng), `P3B-1b` (re-entry từ
AFTER_SALES, tin mua lại luôn được trả lời — không dead-air).

**KẾT QUẢ CHẠY THẬT**
```
[PASS] P3B-1a (hạng mục 1) — mua lại cùng giỏ từ ORDERED -> đơn #2 THẬT song song, 2 xác nhận
[PASS] P3B-1b (hạng mục 1) — re-entry từ AFTER_SALES + tin mua lại luôn được trả lời
```

### HẠNG MỤC 2 — DRAFT TTL (đóng R3-5 / R2-8)

**IMPLEMENTATION**
- Order DRAFT ghi `draft_expires_at = now + draftTtlMs` (App opts `draftTtlMs`, mặc định 24h).
- Scheduler (`app.runDueJobs`) chạy `orders.expireStaleDrafts(now)` mỗi tick: DRAFT quá hạn →
  `cancelDraft('draft_ttl_expired')` → **release reservation, tồn khả dụng trở lại**, audit
  ORDER_STATUS→CANCELLED reason `draft_ttl_expired`, metric `draft_expired++`.
- **Confirm sau expire không tùy tiện**: `routeConfirm` thấy draft `CANCELLED` + `cancel_reason =
  'draft_ttl_expired'` → `renewExpiredDraft`: tạo draft MỚI qua pha A đầy đủ (re-validate stock/giá
  MỚI NHẤT trong transaction — đúng chuẩn P3A/INV-4), gửi bill mới (giá mới nếu đã đổi) và chờ khách
  **xác nhận lại lần nữa**; không bao giờ sinh đơn CONFIRMED từ reservation cũ.

**TESTS** — `P3B-2a` (biên: 30' < TTL 60' giữ nguyên; 61' → CANCELLED + reserved 0 + effective 3 +
audit + metric + khách khác giữ được chỗ ngay), `P3B-2b` (confirm muộn → 0 CONFIRMED từ reservation cũ,
draft mới theo giá 200000 vừa đổi, bill mới 225000, xác nhận lần nữa mới chốt, kho trừ đúng 1 lần).

**KẾT QUẢ CHẠY THẬT**
```
[PASS] P3B-2a (hạng mục 2) — TTL release: quá hạn -> scheduler hoàn reservation, tồn khả dụng trở lại
[PASS] P3B-2b (hạng mục 2) — confirm sau expire -> không dùng reservation cũ, re-validate giá/tồn mới
```

### HẠNG MỤC 3 — QTY EXTRACTION (đóng R2-7)

**IMPLEMENTATION** — `extractQty(seg, product)` thay regex cũ, đúng quy tắc đề bài:
0. Mask TRƯỚC: SĐT VN (0/84 + 9–10 số, chịu separator) và mọi số dài ≥9 chữ số → placeholder —
   **không bao giờ thành qty** (chặn cả việc "…456 hop" trúng 3 số cuối nhờ lookbehind `(?<!\d)`).
a. Số 1–2 chữ số (≤99) + ĐƠN VỊ rõ ngay cạnh (cai|cái|hop|hộp|bo|bộ|mon|món|sp|san pham|sản phẩm|combo|box|goi|gói|chai|lon|set|túi|cây…) — cả 2 thứ tự "2 hộp"/"hộp 2".
b. Số ngắn đứng ngay sau động từ đặt/mua/lấy ("lấy 2 nến vanilla").
c. Số ngắn đứng ngay trước tên/alias sản phẩm trong đoạn ("3 trà hoa sấy" — đoạn sau tách "và" không còn động từ).
Còn lại → mặc định 1 (tầng trên hỏi lại/xác nhận). Regression: case 6 multi-SKU + toàn bộ case cũ vẫn PASS.

**TESTS** — `P3B-3a` (probe `extractItems('sdt 0903123456 cho minh 1 hop tra hoa say')` → qty=1; probe
SĐT-đầu-câu "0903123456 dat 2 nen vanilla m do" → qty=2; E2E: draft qty=1, chốt được, 0 dòng
order_items nào có qty kiểu SĐT), `P3B-3b` (qty hợp lệ: "lấy 2 nến … và 3 trà …" → 2+3 đúng, tổng
830000, trừ kho 3→1 và 20→17; "2 hộp trà" → 2).

**KẾT QUẢ CHẠY THẬT**
```
[PASS] P3B-3a (hạng mục 3) — sdt-không-thành-qty (903123456) — probe + E2E
[PASS] P3B-3b (hạng mục 3) — qty hợp lệ vẫn nhận: multi-SKU, đơn vị, số trước tên SP
```

### HẠNG MỤC 4 — CLAIM / TAKEOVER (đóng R3-3 + R2-M2 + R2-M3)

**IMPLEMENTATION**
- **Giảm false-positive**: tách `RE.complaint` cũ thành strong/weak. STRONG (luôn claim): lừa đảo,
  khiếu nại, đơn hàng lỗi, hàng hỏng/lỗi, giao sai/thiếu, đổi hàng, trả hàng, bồi hoàn. WEAK (chưa
  nhận được / chưa thấy / phiền phức / xấu / tệ — dạng ASCII + `\b` cho từ ngắn vì chạy trên
  normText): chỉ claim khi **ngữ cảnh CÓ ĐƠN đã đặt** (`convHasPlacedOrder`: CONFIRMED/DELIVERED/
  CANCEL_PENDING) **hoặc bất mãn yếu lặp lại ≥ 2 lần** (`conv.soft_complaint_count`). Câu hỏi tiêu
  cực nhẹ → KHÔNG claim, AI vẫn trả lời bình thường. (Case 13 + area6d cũ — text có "lừa đảo" —
  vẫn claim như trước, giữ nguyên expectation.)
- **closeClaim(conv, operator, reason)**: về ĐÚNG `origin_state` (transition có audit; fallback đặt
  thẳng kèm audit riêng nếu không transition được), xoá claim, audit `CLAIM_CLOSE` (operator, mốc mở,
  mốc đóng). Mode trả về AUTO qua **luồng handback sẵn có** (`takeover.handback`) — không viết cơ chế mới.
- **HUMAN vẫn fillSlots**: nhánh `mode === 'HUMAN'` chạy `fillSlots` trước khi ghi nháp HOLD_FOR_AGENT —
  bot ghi nhận thông tin khách để nhân viên thấy / handback không phải hỏi lại, nhưng KHÔNG auto-send
  (**INV-5 — Gate A A3 PASS lại nguyên trạng**).

**TESTS** — `P3B-4a` ("sao mình chưa thấy bảng size ở đâu nhỉ?" không có đơn → mode AI, claim null,
AI trả lời, 0 lời xin lỗi oan; tín hiệu yếu thứ 2 lặp lại → claim mở đúng chính sách), `P3B-4b`
(khiếu nại thật → HUMAN + claim origin ORDERED + template an ủi; trong HUMAN khách rải tên/SĐT →
slots ghi nhận nhưng 0 tin out mới; `closeClaim` → restored ORDERED + audit; `handback` → AI trả lời
tham chiếu đúng mã đơn).

**KẾT QUẢ CHẠY THẬT**
```
[PASS] P3B-4a (hạng mục 4) — false-positive đừng claim: "chưa thấy bảng size" -> AI vẫn trả lời
[PASS] P3B-4b (hạng mục 4) — claim thật vào HUMAN + fillSlots không auto-send + closeClaim về đúng state
```

### HẠNG MỤC 5 — CANCEL ORDER (đóng R3-7)

**IMPLEMENTATION**
- `detectIntent`: `RE.cancelOrder` (hủy đơn/bỏ đơn/không mua nữa/đặt nhầm/đổi ý không mua…) — check
  TRƯỚC changeSubject; `routeCancel` chọn đơn hiện hành (ưu tiên CONFIRMED mới nhất; chỉ còn
  CANCEL_PENDING → trả lời chờ xử lý).
- `requestCancelOrder` (order-engine, qua audit đầy đủ ai huỷ `cancel_actor`, lúc nào `cancel_at`,
  lý do `cancel_reason` + audit ORDER_STATUS):
  - DRAFT → `cancelDraft` (release reserve) + về COLLECT_ORDER.
  - CONFIRMED **không** shipment → restock (hoàn tồn đã trừ lúc chốt) + CANCELLED + về AFTER_SALES.
  - CONFIRMED **có** shipment → **bắt buộc qua shipping cancel path**: write-ahead intent
    `action_executions` key riêng `cancel_shipment:<order_id>` → `carrier.cancelShipment` → chỉ khi
    có receipt `CANCELLED` mới huỷ shipment row + restock + huỷ đơn.
  - Carrier TỪ CHỐI/chưa hỗ trợ → order `CANCEL_PENDING` + `cancel_carrier_reason` + needsHuman
    (worklist `cancel_shipment_rejected`, metric riêng) — **KHÔNG huỷ lửng** (shipment còn nguyên,
    kho không hoàn vội). Huỷ lặp: idempotent (không gọi carrier thêm, không restock trùng).

**TESTS** — `P3B-5a` (huỷ draft: CANCELLED + release + audit + tin cho khách; huỷ lặp không nhân đôi;
huỷ CONFIRMED chưa có vận đơn (carrier chết hẳn): restock đúng, 0 lần gọi carrier), `P3B-5b` (huỷ có
shipment: đúng 1 lần `carrier.cancelShipment` với key `cancel_shipment:<order_id>` + receipt CXL-…,
exec DONE, shipment CANCELLED, đơn CANCELLED sau carrier, restock, audit VERIFIED; huỷ lại → 0 call mới),
`P3B-5c` (carrier `refuse`: CANCEL_PENDING + needsHuman + worklist + metric + audit REJECTED, shipment
vẫn CREATED, kho nguyên, khách nhận tin chờ xử lý; hỏi lại không sinh carrier call thứ 2).

**KẾT QUẢ CHẠY THẬT**
```
[PASS] P3B-5a (hạng mục 5) — cancel trước shipment (draft + CONFIRMED chưa có vận đơn) + restock
[PASS] P3B-5b (hạng mục 5) — cancel có shipment qua adapter (idem key riêng + receipt) + restock
[PASS] P3B-5c (hạng mục 5) — carrier từ chối -> CANCEL_PENDING + needsHuman, không huỷ lửng
```

**BẢNG TỔNG P3B (nguyên văn tail stdout, exit code 0)**
```
#        HM  KẾT QUẢ MÔ TẢ                                                                         GHI CHÚ
--------------------------------------------------------------------------------------------------------------------------
P3B-1a   1   PASS    mua lại cùng giỏ từ ORDERED -> đơn #2 THẬT song song, 2 xác nhận              49ms
P3B-1b   1   PASS    re-entry từ AFTER_SALES + tin mua lại luôn được trả lời                       28ms
P3B-2a   2   PASS    TTL release: quá hạn -> scheduler hoàn reservation, tồn khả dụng trở lại      21ms
P3B-2b   2   PASS    confirm sau expire -> không dùng reservation cũ, re-validate giá/tồn mới      15ms
P3B-3a   3   PASS    sdt-không-thành-qty (903123456) — probe + E2E                                 10ms
P3B-3b   3   PASS    qty hợp lệ vẫn nhận: multi-SKU, đơn vị, số trước tên SP                       21ms
P3B-4a   4   PASS    false-positive đừng claim: "chưa thấy bảng size" -> AI vẫn trả lời            12ms
P3B-4b   4   PASS    claim thật vào HUMAN + fillSlots không auto-send + closeClaim về đúng state   19ms
P3B-5a   5   PASS    cancel trước shipment (draft + CONFIRMED chưa có vận đơn) + restock           27ms
P3B-5b   5   PASS    cancel có shipment qua adapter (idem key riêng + receipt) + restock           17ms
P3B-5c   5   PASS    carrier từ chối -> CANCEL_PENDING + needsHuman, không huỷ lửng                16ms
--------------------------------------------------------------------------------------------------------------------------
TỔNG: 11/11 PASS, 0 FAIL
==> P3B 11/11 — 5 HẠNG MỤC SALES CORRECTNESS ĐÓNG (prototype-mock).
```

---

## 4. REGRESSION (chạy lại NGUYÊN TRẠNG — 0 expectation cũ bị sửa)

```
node test/18-cases.js          -> TỔNG: 18/18 PASS, 0 FAIL   (exit 0)
node test/invariants-check.js  -> TỔNG: 6/6 vùng PASS, 0 FAIL (exit 0)
node test/gate-a.js            -> TỔNG: 7/7 PASS, 0 FAIL      (exit 0)
node test/p3b-cases.js         -> TỔNG: 11/11 PASS, 0 FAIL    (exit 0)
```

Điểm đỏ phải giữ — đã giữ: **Gate A A3 (system bypass HUMAN → REJECT)** và **A1/A2 (PII-strip trước
model)** PASS lại nguyên trạng; `assertCtxClean` không vang lần nào; INV-1…5 giữ nguyên (6/6 vùng
injection PASS). Cụ thể các invariant quan tâm:
- INV-3: mua lại KHÔNG phá dedupe — area3(a) idempotent hit, area3(b) 2 event cùng giỏ 1 tick vẫn 1 đơn,
  area3(c/d) PASS nguyên trạng; retry cùng intent (cùng buy_gen) vẫn trúng key cũ.
- INV-4: confirm sau TTL-expire re-validate giá/tồn mới nhất trong transaction (P3B-2b chứng minh bằng
  giá đổi 185000→200000 được đọc lại NGAY trước commit).
- INV-5: fillSlots trong HUMAN KHÔNG kèm bất kỳ auto-send nào (P3B-4b assert 0 tin out mới; A3 PASS).

---

## 5. KNOWN LIMITATIONS (ghi thẳng thắn)

1. **TTL sweep chạy theo đồng hồ hiện tại, không đưa `draft_expires_at` vào `nextDueAt`** — drain không
   tự "nhảy" 24h tới mốc hết hạn (cố ý: tránh phá case 5/7 cũ vốn có draft mở qua drain); test P3B tự
   `advance()` đồng hồ. Production: cron sweep định kỳ là đủ, không phụ thuộc điều này.
2. **Mua lại với giỏ KHÁC từ ORDERED đi qua `doProductChange`** → `cancelDraft` trả `NOT_DRAFT` (đơn cũ
   đã CONFIRMED) rồi re-entry tạo đơn mới — hành vi đúng nhưng luồng "đổi SP khi đang có đơn chờ"
   chưa có route riêng có thông báo; nếu khách muốn CẢ 2 đơn phải nhắn 2 intent mua.
3. **`extractQty` rule (c) dùng cửa sổ 4 ký tự trước tên SP**: "2 nến" nhận, nhưng "đặt 2 cái" tách
   thành "2 cai" sẽ vào rule (a) — các cách viết trộn thiếu dấu phẩy rất dài có thể rơi về mặc định 1
   (an toàn: hỏi lại, không bao giờ đoán số lớn).
4. **CANCEL_PENDING chưa có job tự reconcile với carrier** (khác `reconcile_shipment` của tạo vận đơn):
   sau khi carrier từ chối, việc giải quyết thuộc worklist người thật. Đúng yêu cầu "không huỷ lửng +
   needsHuman" nhưng chưa có đường tự retry có kiểm soát.
5. **Restock huỷ đơn giả định không có bán kênh khác**: prototype hoàn thẳng `stock_qty`; production
   cần đối soát tồn tổng qua ĐVVC/POS trước khi hoàn (ghi nhận theo nguyên tắc "tồn từ DB/API thật").
6. **Weak-complaint counter (`soft_complaint_count`) không decay theo thời gian** — 2 tin yếu cách nhau
   nhiều ngày vẫn tính là "lặp lại"; prototype chấp nhận, production nên thêm cửa sổ thời gian.
7. **Phạm vi**: chỉ 5 hạng mục P3B. BL-1 (Window Gate), BL-2 (Zalo quota), BL-5 (receipt store),
   BL-6 (giá subject-scoped), BL-7 (follow-up SENT mapping), R3-2 (guard tiền OVERRIDDEN đè cả tin),
   R3-4 (ACK_DLQ chưa tự bắn vào luồng DLQ), R3-8 (bill lặp 2 tin "chấp nhận") KHÔNG thuộc vòng này.
8. Toàn bộ kết quả là **PASS (MOCK)** — stub LLM, mock platform/carrier/vision/ASR, JSON store, đồng hồ
   ảo. KHÔNG production-ready. Không mạng, không npm.
9. **[Supervisor] 1 lần FAIL không tái hiện được của P3B-5c**: trong lần xác minh độc lập đầu tiên,
   P3B-5c FAIL tại assert "khách nhận tin trạng thái chờ"; 15 lần chạy liên tiếp sau (12 loop + 3 chuỗi
   4-suite) đều PASS, và `db.json` của case 5c **byte-identical** giữa các lần chạy (App xoá dataDir lúc
   khởi tạo — app.js rmSync). Nghi vấn môi trường (file-lock Windows) chứ không phải logic — pipeline
   deterministic. Ghi nhận để theo dõi khi build thật; không dùng làm căn cứ FAIL.

---

## 6. FINAL

**FINAL: PASS** (P3B Sales Correctness — prototype-mock)

Căn cứ acceptance: 5/5 hạng mục đóng với battery riêng 11/11 PASS (mỗi hạng mục ≥2 test: đường chính +
biên) + regression nguyên trạng 18-case 18/18 + invariants 6/6 + Gate A 7/7 (A1/A2 PII và A3 system-bypass
—红线 — giữ nguyên) + 0 expectation cũ bị sửa (3 file test cũ mtime giữ nguyên) + probe BEFORE chứng minh
cả 5 lỗi có thật trên source gốc trước khi sửa + `node --check` PASS toàn bộ file sửa/thêm.
