# CROSS-REVIEW — REVIEWER 1 (Platform/API) soi thiết kế R2 + R3

> Người viết: AI-1 (REVIEWER 1, vòng CROSS-REVIEW) — ngày 2026-10-05.
> Góc soi: **nền tảng thực tế** (FB/Messenger, Zalo OA, ĐVVC) đối chiếu `docs/AI1-capability-matrix.md` (bản audit của R1).
> Đầu vào: `docs/00-yeu-cau.md` (contract + INV-1…5) → `docs/AI2-sales-ai-v2.md` (R2) → `docs/AI3-failure-injection-v2.md` (R3) → toàn bộ `prototype/src/*.js` + `test/invariants-check.js` + `test/18-cases.js`.
> Phương pháp: (1) đọc chéo doc ↔ code; (2) **chạy lại cả 2 suite trong BẢN SAO** (temp dir, không đụng evidence gốc): `18-cases.js` → 18/18 PASS, `invariants-check.js` → 6/6 PASS — **claim số liệu của R2/R3 là trung thực** (21 thư mục `inv-*`, 20 `case-*`, 2 file log tồn tại đúng như khai); (3) viết **7 probe** chạy trong bản sao để chứng minh/bác từng nghi vấn (output trích nguyên văn trong từng finding).
> Chấm mức: **BLOCKER** = vi phạm contract/nền tảng cấm hẳn khi lên API thật; **MAJOR** = hỏng thật có bằng chứng, phải thiết kế lại; **MINOR** = sai lệch doc/rủi ro nhỏ.

---

## A. FINDINGS CHO R2 (`docs/AI2-sales-ai-v2.md` + prototype)

### R2-1 — [BLOCKER] Không tồn tại khái niệm "cửa sổ 24h / HUMAN_AGENT / Utility Messages" trong toàn bộ thiết kế gửi tin ra Facebook

- **LỖI/RỦI RO**: Toàn bộ đường gửi tin của thiết kế (AI reply, bill, confirm, follow-up care sau giao, tin hệ thống) giả định gửi được BẤT CỨ LÚC NÀO. Trên Messenger thật, ngoài cửa sổ 24h chỉ còn: HUMAN_AGENT (7 ngày, **chỉ dành cho người thật trả lời — bot cấm dùng**, matrix A12) và **Utility Messages** (`page_utility_messaging` + template được duyệt — matrix A13, con đường BẮT BUỘC sau khi 3 tag cũ chết 27/04/2026, matrix 6.2 mục 1). Case 17 (follow-up +2 ngày sau DELIVERED — `pipeline.js` L566) và case 13/15/16 (gửi trong/sau takeover) hiện được gắn nhãn **USE "đã cài + test"** nhưng trên nền tảng thật sẽ trả lỗi (code 10) ở tin đầu tiên — và thiết kế **không có luồng duyệt template nào** để đi hợp lệ.
- **EVIDENCE**:
  - `docs/AI2-sales-ai-v2.md`: grep toàn file — **không một dòng nào** nhắc "24h", "window", "HUMAN_AGENT", "Utility", "template duyệt" (chỉ có `human_agent` như actor nội bộ). Bảng A.1.4 (L67-70) và A.6 (L159-171) không có bất kỳ ràng buộc thời gian nào cho outbound.
  - `prototype/src/action-gate.js` L158-180 (`authorize()`): duyệt đủ điều kiện chốt — `bot_enabled`, `mode`, `opt_out`, `bad_state` — **không có check nào về thời điểm tin cuối của khách**.
  - `prototype/src/shipping.js` L84-104 (`MockPlatform.sendMessage`): nhận mọi call mọi thời điểm — mock không mô hình hoá cửa sổ, nên 18/18 PASS không nói gì về ràng buộc này.
  - Đối chiếu: `AI1-capability-matrix.md` A9/A12/A13/A16 — ngoài 24h chỉ còn Utility/HUMAN_AGENT/OTN/Marketing-opt-in; A16 là **UNSUPPORTED** cho marketing tự do.
- **MỨC**: **BLOCKER** (case 17/18 + toàn bộ after-sales FB: hỏng ngay tin đầu trên API thật; vi phạm mục tiêu "Chăm sóc sau bán" của contract L11).
- **ĐỀ XUẤT KHẮC PHỤC**: Thêm `last_user_event_ts` per conversation (đã có `last_activity_at` nhưng chưa ai đọc nó để chặn); Reply Gate FB tính `now - last_user_event_ts`: ≤24h → gửi thường; >24h → (a) tin after-sales đi template UTILITY đã duyệt (thiết kế bộ template + flow xin quyền `page_utility_messaging`), (b) follow-up care/marketing tự động **huỷ hoặc chuyển hàng đợi chờ khách nhắn lại**, (c) tin trong mode HUMAN quá 24h đi HUMAN_AGENT do `human_agent` bấm tay (không phải bot). Thêm case test 17b/18b mô phỏng "hết window".

### R2-2 — [BLOCKER] Zalo bị bỏ rơi: quota 8 tin CS/48h và các loại quota khác không có trong thiết kế lẫn code

- **LỖI/RỦI RO**: Contract yêu cầu cả Facebook + Zalo (L4-10). Matrix B5/B6: Zalo OA chỉ cho **8 tin CS/48h/user** kể từ tương tác cuối, đọc được qua `/v3.0/oa/quota/message` (`cs_reply.remain`); B9: hết quota → API từ chối, **không có escape hatch**. Thiết kế v2 của R2 không có "Reply Gate Zalo" (điều kiện bắt buộc ghi trong chính matrix của R1); luồng slot-filling (hỏi SĐT → địa chỉ → bill → xác nhận → tracking → follow-up) dễ vượt 8 tin. Thậm chí "bill lặp 2 tin" được R2/R3 coi là "chấp nhận" (`invariants-check.js` L235) — trên Zalo đó là lãng phí 25% quota của một lượt mua.
- **EVIDENCE**:
  - `docs/AI2-sales-ai-v2.md`: grep "quota" → 0 kết quả; "Zalo" chỉ xuất hiện ở voice `.amr` và dedupe `msg_id` (L128, L131, L212, L257).
  - `prototype/src/action-gate.js` L158-180: `authorize()` không đọc quota nào; `shipping.js` MockPlatform không mô hình hoá quota → không case nào chạm được rủi ro này.
  - Đối chiếu: `AI1-capability-matrix.md` B5 (RESTRICTED 8 tin/48h), B6 (đọc quota động — SUPPORTED), B9 (UNSUPPORTED gửi ngoài quota).
- **MỨC**: **BLOCKER** (một trong hai kênh bắt buộc của contract sẽ chết giữa phiên mua hàng thật; không có cơ chế suy giảm hay chuyển human theo quota).
- **ĐỀ XUẤT KHẮC PHỤC**: Reply Gate đọc `cs_reply.remain` trước mỗi auto-send Zalo (cache ≤60s theo B6); remain ≤ ngưỡng (vd 2) → ngừng auto, đẩy human; gom nội dung thành ít tin nhất (bill 1 tin); tin xác nhận đơn đi loại `transaction` (B8, không tốn cs_reply) sau khi xác minh product_type; thêm case test "quota cạn giữa slot-filling".

### R2-3 — [MAJOR] Cơ chế INV-2 thiết kế trên `platform.getReceipt(clientMessageId)` — API KHÔNG TỒN TẠI trên Facebook/Zalo thật, nhưng lại gắn nhãn USE "đã cài + test"

- **LỖI/RỦI RO**: Nguyên tắc INV-2 (cấm blind-retry, tra bằng chứng) đúng, nhưng **cơ chế** đối chứng được code là poll đồng bộ `getReceipt(client_message_id)` — Messenger **không có API đọc trạng thái từng tin** (receipt chỉ đến qua webhook `message_deliveries`/`message_reads`/`message_echoes` — matrix D, hàng INV-2); Zalo cũng chỉ có `user_seen_message`/`user_reacted_message`. `clientMessageId` là khái niệm mock thuần — Send API thật không nhận tham số này, nên khi timeout **không có gì để tra theo key đó**. Suite PASS vì chính mock tự định nghĩa `getReceipt` và tự hẹn giao tin (`hang_then_deliver`).
- **EVIDENCE**:
  - `prototype/src/action-gate.js` L269-273 (`checkSendReceipt`): `const receipt = this.platform.getReceipt(client_message_id);` — trỏ thẳng vào mock; L186-192: `clientMessageId = exec_id` do hệ thống tự sinh.
  - `prototype/src/shipping.js` L84-108: `MockPlatform.sendMessage/getReceipt` — receipt được mock tự sinh ra theo chính clientMessageId đó.
  - `docs/AI2-sales-ai-v2.md` A.1.4 hàng INV-2 (L67): phân loại **USE** ("đã cài + test") — không có cảnh báo rằng cơ chế đối chứng chưa ánh xạ được sang API thật (khác với mức trung thực của mục B.0.1 chỉ nói "MockPlatform là mô hình").
  - Đối chiếu: `AI1-capability-matrix.md` mục D hàng INV-2: "FB: **không có API đọc trạng thái từng tin** → receipt = webhook …; Zalo: receipt = `user_seen_message`…".
- **MỨC**: **MAJOR** (INV-2 về nguyên tắc giữ được, nhưng cơ chế đang test sẽ không chạy được bước "tra receipt" khi cắm API thật — phải thiết kế lại tầng đối chứng).
- **ĐỀ XUẤT KHẮC PHỤC**: Đổi mô hình receipt sang **inbound-first**: bảng `outbound_pending` (conversation, thời điểm, hash text) → khớp webhook `message_deliveries`/`message_echoes` (FB, có `mid` + timestamp) hoặc `user_seen_message` (Zalo) theo conversation+cửa sổ thời gian; chỉ khi nhận được evidence tương ứng mới coi là DELIVERED; hết 3 lượt không thấy evidence → DLQ (giữ nguyên). Ghi rõ trong A.1.4 chuyển cơ chế này từ USE → ADAPT.

### R2-4 — [MAJOR] Guard chống giá bịa dùng "mọi giá trong catalogue" làm tập hợp lệ → giá bịa TRÙNG giá sản phẩm khác đi thẳng ra khách (probe chốt hole)

- **LỖI/RỦI RO**: R2 tuyên bố cơ chế case 8 là lớp chốt golden rule ("AI bịa không đổi được sự thật"). Nhưng `allowedMoney` = tiền trong text của proposal + snapshot đơn + **toàn bộ giá mọi variant trong DB**. LLM thật bịa giá nến vanilla = 145000đ (đúng bằng giá trà hoa sấy trong cùng catalogue) → guard nhìn thấy số "nằm trong DB" → AUTO_EXECUTED. R2 đã khai hạn chế ở A.2.3 (chưa quét money-không-đơn-vị…) nhưng **không khai hole này** — hole đã được R3 vá một nửa (bare-number) mà vẫn để nguyên tập allowed quá rộng.
- **EVIDENCE**:
  - `prototype/src/action-gate.js` L71: `for (const v of this.productDB.knownMoneyValues()) allowed.add(v); // mọi giá trong DB là "hợp lệ"`; `product-db.js` L91-99 (`knownMoneyValues`) thêm giá **tất cả** variant.
  - **Probe 7 (R1 chạy)**: gọi thẳng gate với proposal `PRICE`, text `"Dạ nến vanilla M đỏ giá 145000đ nha anh ạ!"` (giá nến thật trong DB = 185000, 145000 là giá TRÀ) → kết quả: `decision = AUTO_EXECUTED | text ra ngoài: "Dạ nến vanilla M đỏ giá 145000đ nha anh ạ!"`.
- **MỨC**: **MAJOR** (lỗ hổng golden rule biết trước, đúng dạng lỗi mà case 8 sinh ra để chặn).
- **ĐỀ XUẤT KHẮC PHỤC**: `allowedMoney` tính theo **subject đang nói** (variants của `conv.subject_sku` + snapshot đơn của conversation + phí ship), không phải toàn catalogue; giá từ SP khác xuất hiện trong câu trả lời về SP này → override như case 8. Test: bơm proposal giá chéo SP (probe 7 trở thành assert).

### R2-5 — [MAJOR] Phí ship hardcode 25000đ, không bao giờ được quote/revalidate từ API ĐVVC trước commit — vi phạm nguyên tắc vàng ở đúng mốc commit

- **LỖI/RỦI RO**: Nguyên tắc vàng (contract L35-36) và matrix D hàng INV-4: phí ship phải gọi API ĐVVC (GHN `Fees`) NGAY trước commit — phí GHN thật phụ thuộc địa chỉ/cân nặng/dịch vụ. Thiết kế A.2.4 của R2 mô tả revalidate "giá + tồn" và được gắn USE; `total = subtotal + 25000` cứng. Bill gửi khách (artifact chính thức) tính từ số cứng → chênh lệch phí thật = đơn lỗ/chắt khách, và INV-4 tuyên bố "phủ" nhưng thực ra bỏ sót 1 trong 4 đại lượng (giá, tồn, **khuyến mại**, phí ship) — khuyến mại cũng không có trong revalidate.
- **EVIDENCE**:
  - `prototype/src/order-engine.js` L88: `const shipping_fee = 25000;` (pha A); L152 (pha B): `const total = lines.reduce(...) + order.shipping_fee;` — pha B **không đọc lại phí** từ nguồn nào.
  - `prototype/src/pipeline.js` L363 (`renderBill`): bill render `order.shipping_fee` (số cứng).
  - `docs/AI2-sales-ai-v2.md` A.2.4 (L101-118): revalidate chỉ nêu `getStock` + so giá; không nhắc fee/khuyến mại.
  - Đối chiếu: `AI1-capability-matrix.md` D hàng INV-4: "phí ship phải gọi lại API ĐVVC (GHN `Fees` …) NGAY trước commit"; C1: GHN có API phí chính thức.
- **MỨC**: **MAJOR**.
- **ĐỀ XUẤT KHẮC PHỤC**: Pha A gọi `carrier.quoteFee({address, items})` (adapter GHN) thay hằng số; pha B revalidate thêm `fee` (và `promotion`) trong cùng transaction; lệch → xử lý như `PRICE_CHANGED` (đã có sẵn nhánh repriced ở `pipeline.js` L383-412). Mock bổ sung chế độ `fee_changed`.

### R2-6 — [MAJOR] Thiết kế tuyên bố "AFTER_SALES → đơn mới → vòng mới" là USE "đã cài + test", nhưng luồng mua lại KHÔNG THỂ chạy — khách mua lại bị im lặng hoàn toàn (probe chốt)

- **LỖI/RỦI RO**: Bảng A.1.1 hàng AFTER_SALES ghi "RA khi: Đơn mới → vòng mới", và `session.js` TRANSITIONS cho phép AFTER_SALES → BUY_INTENT. Nhưng hai lớp phía dưới mâu thuẫn thiết kế: `routeBuy` chỉ chuyển BUY_INTENT từ `NEW_LEAD/DISCOVERY/PRODUCT_QA`, còn `authorize()` chỉ cho CREATE_ORDER ở 5 state không có ORDERED/AFTER_SALES. Kết quả: khách mua lại (rất phổ biến sau khi giao) nhận **0 tin trả lời** cho yêu cầu mua và không bao giờ có đơn mới — trong khi R2 gắn nhãn cả khung 10 state là USE "đã cài, test 18 case"; 18 case cũng không có case nào mua lại.
- **EVIDENCE**:
  - `docs/AI2-sales-ai-v2.md` A.1.1 bảng state (L19-29, hàng AFTER_SALES L29: "Đơn mới → vòng mới"); A.6 (L161): "10 state + overlay mode + slot-state … **USE** Đã cài, test 18 case".
  - `prototype/src/pipeline.js` L284-287: `if (['NEW_LEAD','DISCOVERY','PRODUCT_QA'].includes(conv.state))` — AFTER_SALES/ORDERED bị loại; `action-gate.js` L22: `ORDER_ACTION_STATES = ['BUY_INTENT','COLLECT_ORDER','VALIDATE','CONFIRM','PRODUCT_QA']`.
  - **Probe 1 (R1 chạy)**: mua → chốt → DELIVERED (AFTER_SALES) → khách gửi lại đúng tin mua ban đầu → `state= AFTER_SALES | số orders rows= 1` (chỉ đơn DELIVERED cũ), tin tiếp theo (`xác nhận`) chỉ nhận câu an toàn; `sau xác nhận: tổng orders= 1 | CONFIRMED= 0` — **không có đơn mới, không có reply nào cho tin mua**.
- **MỨC**: **MAJOR** (chức năng bán lặp lại — mục tiêu lõi "chốt sale 24/7" — hỏng lặng lẽ; nhãn USE sai thực tế code).
- **ĐỀ XUẤT KHẮC PHỤC**: Cho phép AFTER_SALES/ORDERED → BUY_INTENT trong `routeBuy` (transition đã hợp lệ theo TRANSITIONS) và thêm AFTER_SALES vào `ORDER_ACTION_STATES` (draft mới sẽ có idempotency key thế hệ mới — cơ chế `#gen` của R3 đã sẵn sàng cho việc này); thêm case 19 "mua lại sau giao".

### R2-7 — [MINOR] Doc v2 mô tả cơ chế INV-5/INV-2 đã LỆCH so với code sau khi R3 vá: "hủy sạch mọi job QUEUED (check_receipt, follow-up, marketing)" không còn đúng

- **LỖI/RỦI RO**: AI2 A.1.2 tầng 3 và bảng B.1 case 15 tuyên bố takeover "hủy sạch" job QUEUED kể cả `check_receipt` — nhưng sau vá của R3, `check_send_receipt`/`reconcile_shipment` được **bảo lưu** chủ đích. Người đọc doc v2 sẽ hiểu sai cơ chế chặn (tưởng takeover cắt cả job đối chứng → tưởng INV-2 mất đường tra receipt là behavior đúng). Case 15 hiện chỉ PASS "hủy sạch" vì test được R3 đổi kind job giả sang `process_event`.
- **EVIDENCE**: `docs/AI2-sales-ai-v2.md` L43 ("`takeover.setTakeover()` **hủy sạch mọi job QUEUED** của hội thoại (check_receipt, follow-up, marketing)") và L217 ("job QUEUED của hội thoại **hủy sạch** (0 dòng QUEUED còn lại)") ↔ `prototype/src/takeover.js` L14 (`NOT_CANCELLABLE_BY_TAKEOVER = new Set(['check_send_receipt', 'reconcile_shipment'])`) và L27-29; `test/18-cases.js` L505-510 (kind đổi thành `process_event`).
- **MỨC**: **MINOR** (doc-code divergence trên đúng cơ chế bất biến).
- **ĐỀ XUẤT KHẮC PHỤC**: Cập nhật A.1.2 + B.1 case 15: takeover hủy **job loại AI** (process_event/follow-up), giữ job đối chứng (check_receipt/reconcile) — kèm lý do INV-2.

### R2-8 — [MINOR] Thiếu tầng vận hành nền tảng: SLA bot 30s, webhook fail 1h → "Webhooks Disabled" + auto re-subscribe, persistent menu onboarding

- **LỖI/RỦI RO**: Matrix A18/A19/A17 xếp các mục này là yêu cầu thiết kế (Meta cắt webhook sau 1h fail liên tục + **unsubscribed** khỏi Page; không có lịch sử webhook để tự phục hồi thụ động). Thiết kế v2 của R2 có INV-1 ở tầng app nhưng không có: monitor alert "Webhooks Disabled", auto re-subscribe `subscribed_apps`, SLA first-response 30s, disclosure khi bật lại bot sau takeover, menu "Gọi nhân viên"/opt-in (nòng súng cho INV-5/case 18).
- **EVIDENCE**: `docs/AI2-sales-ai-v2.md` toàn văn — không có mục vận hành/monitor (grep "webhook" chỉ thấy dedupe; "menu" 0 kết quả); `prototype/src/gateway.js` L8-9 chỉ ghi chú "production verify HMAC" — không có re-subscribe. Đối chiếu `AI1-capability-matrix.md` A17 (persistent menu + rate 10 call/10 phút), A18 (30s + disclosure), A19 (disable 1h + unsubscribed, "monitor + auto re-subscribe là yêu cầu sản phẩm").
- **MỨC**: **MINOR** (không hỏng ngay, nhưng là hệ điều hành của các invariant — thiếu nó thì INV-1 chỉ đúng trong lab).
- **ĐỀ XUẤT KHẮC PHỤC**: Thêm mục "Channel Ops" vào thiết kế v2.1: health-check webhook + alert + auto re-subscribe; SLA 30s ghi vào gateway; disclosure template khi mode chuyển HUMAN→AI; onboarding menu/Get Started cho cả 2 kênh.

---

## B. FINDINGS CHO R3 (`docs/AI3-failure-injection-v2.md` + `test/invariants-check.js`)

### R3-1 — [MAJOR] Injection của vùng INV-1 chỉ đặt điểm lỗi ở ĐẦU hàm xử lý — crash SAU side-effect (ca thật: mất điện sau khi đã gửi) làm nhân đôi dữ liệu và, khi reply không deterministic, GỬI 2 TIN KHÁC NHAU ra khách (probe chốt)

- **LỖI/RỦI RO**: Suite tự đặt tiêu chuẩn "mỗi event xử lý đúng một lần (một lần HOẶC thất bại có dấu)" (AI3 mục VÙNG 1). Nhưng cả 2 kịch bản lỗi worker (area1c/1d) đều inject throw **trước khi** `handleEvent` làm bất cứ gì (`calls === 1 → throw` ngay) — điểm an toàn nhất. Khi crash xảy ra **sau** side-effect (ca thật với write-ahead/HTTP thật), gateway re-queue và chạy lại toàn bộ: row tin nhắn vào + ai_proposals bị chèn 2 lần; tệ hơn, với luồng NEEDS_HUMAN, text câu an toàn **xoay vòng** (`safeReply()` tăng `safeIdx`) → retry sinh text KHÁC → idempotency key send (sha(text+event_id)) KHÁC → gửi 2 tin khác nhau cho 1 event. Claim "không có side-effect nào lọt ra" (output area1d) chỉ đúng vì điểm lỗi được chọn trước side-effect.
- **EVIDENCE**:
  - `test/invariants-check.js` L111-117: `app2.pipeline.handleEvent = evv => { calls += 1; if (calls === 1) throw ... }` — throw tại入口; L128-129 tương tự (`app3.pipeline.handleEvent = () => { throw ... }`).
  - `prototype/src/gateway.js` L62-79: catch → `row.status = 'RECEIVED'` + re-queue — không có cơ chế bù trừ side-effect đã xảy ra.
  - `prototype/src/action-gate.js` L187: idem key `send:conv:sha(text + event_id)` — phụ thuộc text; L36-40: `safeReply()` xoay vòng → text khác mỗi lần gọi.
  - **Probe 6 (R1 chạy)**: crash sau khi đã gửi tin an toàn (luồng voice ASR fail) → `platform calls = 2 | out tin = 2` với 2 nội dung KHÁC nhau ("Câu này em phải hỏi chủ shop…" và "Em ghi nhận câu hỏi của mình…"), 2 idempotency key khác nhau.
  - **Probe 3 (R1 chạy)**: crash sau khi xử lý xong → `in-messages= 2 | ai_proposals= 2 | out-messages= 1 | platform calls= 1` — outbound được cứu nhờ idem key, nhưng dữ liệu nhân đôi (không case nào assert điều này).
- **MỨC**: **MAJOR**.
- **ĐỀ XUẤT KHẮC PHỤC**: (1) Đưa idempotency send về key **event-scoped** (`send:conv:event_id:slot`) không phụ thuộc text; (2) `safeReply()` chọn theo hash(event_id) thay vì counter để retry tái sinh đúng text; (3) thêm kịch bản injection "throw SAU khi sendMessage/insert" cho area1 và assert: 1 tin out, 1 row tin-in, 1 proposal (hoặc dedupe ở tầng insert).

### R3-2 — [MAJOR] `sendFollowUp` đánh `SENT` VÔ ĐIỀU KIỆN kể cả khi platform trả TIMEOUT_UNKNOWN/FAILED — status nằm ngược với chính nguyên tắc VERIFY của R3

- **LộI/RỦI RO**: Vùng 2 của R3 đặt nguyên tắc "không tin lời tự khai, bằng chứng từ receipt". Nhưng follow-up đến hạn được update `status:'SENT'` ngay sau khi gọi executeSend **mặc kệ** kết quả là TIMEOUT_UNKNOWN hay FAILED. Probe cho thấy `follow_ups.status = SENT | exec.status = TIMEOUT_UNKNOWN | delivery_status = UNKNOWN` — follow-up "đã chăm sóc" trên dashboard dù tin chưa bao giờ đến tay khách; nếu check_receipt sau đó rơi DLQ cũng không ai xem lại follow-up. Suite không có test nào cho follow-up gửi hỏng.
- **EVIDENCE**:
  - `prototype/src/action-gate.js` L530-537: `const send = this.executeSend({...}); const verify = this.verifySend({...}); store.transaction(() => { store.updateRow('follow_ups', followUp, { status: 'SENT', exec_id: send.exec_id }); });` — không đọc `send.res.ok/timeout`.
  - **Probe 2 (R1 chạy)**: chốt đơn bình thường → DELIVERED → thay platform bằng `hang_forever` → `advance(3 ngày)`: `follow_ups.status = SENT | exec.status = TIMEOUT_UNKNOWN | tin care delivery_status = UNKNOWN`.
  - Đối chiếu tuyên bố: `AI3-failure-injection-v2.md` bảng vùng 2 (L187) "5xx báo người" và VÙNG 2 claim "phủ tốt" — nhánh follow-up của chính cơ chế này không được phủ.
- **MỨC**: **MAJOR**.
- **ĐỀ XUẤT KHẮC PHỤC**: `sendFollowUp` map kết quả: `ok → SENT`, `timeout → PENDING_RECEIPT (chờ check_receipt đổi thành SENT hoặc FAILED+worklist)`, `FAILED → FAILED + worklist`. Thêm injection area2e: follow-up đến hạn khi platform hang_forever.

### R3-3 — [MAJOR] Vùng INV-2 (carrier): mode `hang_no_record` được định nghĩa trong mock nhưng KHÔNG được test; nhánh `STILL_TIMEOUT` của reconcile là ngõ cụt vĩnh viễn — job reconcile bị đánh DONE kể cả khi thất bại

- **LỖI/RỦI RO**: Hai kịch bản carrier được test là `hang` (đã tạo, mất response → reconcile thấy ALREADY_EXISTS) và `flaky_once` (retry thành công ngay) — cả hai đều "đẹp". Kịch bản xấu thật (carrier chết luôn — timeout mà KHÔNG tạo gì) đúng là mode `hang_no_record` của mock nhưng **không xuất hiện trong bất kỳ test nào**. Đi vào nhánh đó (probe 5): `reconcileShipment` trả `{ok:false, reason:'STILL_TIMEOUT'}` mà **không tự hẹn lại** (khác `checkSendReceipt` có vòng ×3), và `runDueJobs` đánh `job.status='DONE'` bất kể result → reconcile chỉ chạy đúng 1 lần rồi im luôn; vận đơn treo TIMEOUT_UNKNOWN vĩnh viễn (chỉ có DLQ từ blind-retry chặn trước đó). `max_attempts: 3` của job reconcile là trang trí — không code nào đọc nó cho job DONE-bất-kểt-quả này.
- **EVIDENCE**:
  - `prototype/src/shipping.js` L14-16, L47-48: mode `hang_no_record` tồn tại; `test/invariants-check.js` chỉ dùng `carrierMode: 'hang'` (L193) và `'flaky_once'` (L201).
  - `prototype/src/order-engine.js` L286-295: nhánh cuối `return { ok: false, reason: 'STILL_TIMEOUT' };` — không reschedule, không DLQ; L258-265 `scheduleReconcile` đặt `max_attempts: 3` nhưng không ai tăng `attempts`.
  - `prototype/src/app.js` L87-107: `job.status = 'DONE'` sau try — `result` bị bỏ qua (`void result`).
  - **Probe 5 (R1 chạy)**: `carrierMode 'hang_no_record'` → `exec CREATE_SHIPMENT status = TIMEOUT_UNKNOWN | reconcile jobs = DONE | dlq = RETRY_BLOCKED_NO_RECEIPT | flag_needs_human = true` — sau drain, không còn job nào sẽ tra lại; đơn CONFIRMED nhưng mãi không có vận đơn nếu carrier chỉ chết tạm.
- **MỨC**: **MAJOR** (tuyên bố "6/6 vùng PHÙ ĐỂ" cho vùng 2 thiếu đúng nhánh xấu nhất của chính mock mình).
- **ĐỀ XUẤT KHẮC PHỤC**: `reconcileShipment` khi `STILL_TIMEOUT` → tự hẹn lại (giảm dần, tối đa `max_attempts`), quá hạn mới DLQ + worklist; `runDueJobs` đánh job theo result (DONE/RETRY/DEAD) thay vì DONE cứng; thêm test `carrierMode: 'hang_no_record'` assert: sau 3 reconcile vẫn chưa có → DLQ có dấu, không case nào "im luôn".

### R3-4 — [MAJOR] VÙNG 6 tuyên bố INV-5 "KHOÁ TOÀN BỘ AUTO" nhưng bỏ ngỏ cổng `actor='system' + msgKind='ai_reply'` — probe gửi thẳng text KHUYẾN MÃI trong mode HUMAN và nó RA NGOÀI thành công; suite không probe lỗ này

- **LỖI/RỦI RO**: `authorize()` chỉ chặn (a) `actor==='ai'` khi HUMAN và (b) `marketing`/`care` khi HUMAN. Còn lại — `actor='system'` với `msgKind='ai_reply'` (giá trị DEFAULT của `sendReply`) — đi qua tự do trong mode HUMAN, bất kể nội dung. Đây chính xác là rủi ro mà R2 A.1.2 tự khai ("cấm code đường nào khác tự gắn `sender:'system'` để lách cổng — hiện prototype chấp nhận rủi ro") — tức là "whitelist policy" **chỉ tồn tại trên giấy, không có trong code**. Suite injection của R3, sinh ra để "phá hệ thống có chủ đích", lại không bơm thử vector này; area6(d) chỉ test template khiếu nại hợp lệ. Kết luận "khoá toàn bộ auto" vì vậy bị overstated.
- **EVIDENCE**:
  - `prototype/src/action-gate.js` L158-171 (`authorize`): điều kiện chặn HUMAN chỉ có 2 loại nêu trên; **không có whitelist nội dung** cho actor `system`.
  - `prototype/src/pipeline.js` L102-107: chính code hiện hữu đã dùng vector này (`askHuman` → `sender:'system'`, msgKind mặc định `ai_reply`).
  - **Probe 4 (R1 chạy)**: mode HUMAN (operator takeover xong), gọi `gate.sendReply` với `{sender:'system', msgKind:'ai_reply', text:'KHUYEN MAI SOC 50% CHI HOM NAY!!!'}` → `sent = true | (KHONG bi chan) | mode = HUMAN`, tin **ra ngoài** với sender=system.
  - `AI3-failure-injection-v2.md` VÙNG 6 tiêu đề (L156): "HUMAN_OWNED KHOÁ TOÀN BỘ AUTO"; bảng vùng 6 (L191): "Gate AUTHORIZE chặn actor ai + mọi marketing/care khi HUMAN" — đúng chữ nhưng bỏ sót tổ hợp system+ai_reply.
- **MỨC**: **MAJOR** (lỗ hổng INV-5 biết trước, có sẵn trong code path thật, chưa được injection phủ).
- **ĐỀ XUẤT KHẮC PHỤC**: Trong `authorize()`, khi `mode==='HUMAN'` và `actor==='system'`: chỉ cho msgKind `transactional`/`policy` với text thuộc bảng template liệt kê tường minh (id template, không phải text tự do); msgKind `ai_reply` + system → REJECT. Thêm area6e bơm đúng probe 4 làm assert.

### R3-5 — [MINOR] Chất lượng assert vùng 6(c) yếu hơn tuyên bố: check lỏng `HELD || SCHEDULED` và state follow-up được chèn tay, không đi qua đường kích hoạt thật

- **LỖI/RỦI RO**: Test "follow-up bị GIỮ giữa lúc HUMAN" assert `fu.status === 'HELD' || fu.status === 'SCHEDULED'` — SCHEDULED cũng PASS, tức assertion không phân biệt "đã bị giữ" với "chưa kịp chạy"; và row follow-up được `store.insert` thủ công vào test thay vì sinh từ `onCarrierStatus` (đường trigger thật của case 17) — bypass toàn bộ tiền điều kiện (đơn DELIVERED từ carrier, idempotency 1 follow-up/đơn). Bằng chứng "6/6 vùng PHÙ ĐỂ" vì vậy ở vùng 6c mỏng hơn vẻ ngoài.
- **EVIDENCE**: `test/invariants-check.js` L453-459 (insert follow_ups thủ công), L463: `assert.ok(fu.status === 'HELD' || fu.status === 'SCHEDULED', ...)`; so với đường thật `pipeline.js` L559-570 (follow-up chỉ sinh khi carrier trả DELIVERED).
- **MỨC**: **MINOR**.
- **ĐỀ XUẤT KHẮC PHỤC**: Assert chặt `status === 'HELD'`; sinh follow-up bằng cách set carrier DELIVERED + gọi `onCarrierStatus` (đúng trigger), rồi takeover → advance → assert HELD; handback → SENT đúng 1.

---

## C. TỔNG HỢP

| Nhóm | Số finding | BLOCKER | MAJOR | MINOR |
|---|---|---|---|---|
| R2 | 8 | R2-1, R2-2 | R2-3, R2-4, R2-5, R2-6 | R2-7, R2-8 |
| R3 | 5 | — | R3-1, R3-2, R3-3, R3-4 | R3-5 |
| **Tổng** | **13** | **2** | **8** | **3** |

**Công bằng nơi cần công bằng**: chạy lại cả 2 suite (bản sao) xác nhận 18/18 + 6/6 PASS đúng như R2/R3 khai; các thư mục/log evidence tồn tại trên đĩa đúng như liệt kê; các điểm tự khai "CHƯA XÁC MINH" (voice .amr, LLM thật, WAL, HMAC) của cả hai đều trung thực và KHÔNG bị tính là lỗi trong báo cáo này. Các finding ở trên là phần mà mock "quá đẹp" hoặc doc "quá USE" che khuất ràng buộc nền tảng thật.

**Nghiêm trọng nhất**: **R2-1** — toàn bộ thiết kế outbound không có cửa sổ 24h/HUMAN_AGENT/Utility: trên Messenger thật, follow-up sau bán (case 17), chăm sóc sau takeover và mọi tin ngoài cửa sổ sẽ bị nền tảng từ chối ngay, mà thiết kế không có con đường hợp lệ nào (Utility Messages bắt buộc phải duyệt template; HUMAN_AGENT cấm bot dùng) — nghĩa là các case 13/15/16/17/18 đang PASS trong lab sẽ FAIL ở milimet đầu tiên trên API thật, và đây là sửa đổi kiến trúc (không phải vá nhỏ).
