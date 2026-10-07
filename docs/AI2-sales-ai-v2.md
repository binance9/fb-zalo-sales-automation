# AI2 — SALES AI v2 (HỘI ĐỒNG VÒNG 2 — REVIEWER 2: SALES AI / WORKFLOW)

> Vòng 2. Đầu vào bắt buộc: `docs/00-yeu-cau.md` (contract gốc — HARD INVARIANTS INV-1…INV-5, KHÔNG thay mục tiêu).
> Kế thừa: `docs/AI2-sales-workflow.md` (thiết kế vòng 1) + prototype `sales-ai-lab/prototype/` (18/18 PASS, `docs/KET-QUA-18-CASE.md` vòng 1).
> File này gồm 2 phần: **PHẦN A — thiết kế v2** (nâng cấp vòng 1, rà từng invariant) và **PHẦN B — 18 scenario SIMULATION ĐÃ CHẠY THẬT** (evidence từ log + `db.json`/`audit.jsonl`).
> Phạm vi: KHÔNG đụng file khác, KHÔNG sửa prototype. Log chạy thật của vòng này: `docs/simulation-run.log`.
>
> **Chạy lại bởi Reviewer 2 ngày 2026-10-05**: `cd sales-ai-lab/prototype && node test/18-cases.js` (Git Bash, Node v24.18.0, thuần module có sẵn, không npm, không mạng) → **18/18 PASS, exit code 0**. Lưu ý: timestamp trong evidence là `2026-10-04T09:00…` vì prototype chạy trên **đồng hồ ảo** khởi tạo cố định (`clock.js`) — không phải thời điểm chạy thật.

---

# PHẦN A — THIẾT KẾ SALES AI v2

## A.1 State machine 10 state + mode AUTO/HUMAN + slot-state đơn

### A.1.1 Trục 10 state (giữ khung contract; điều kiện vào/ra đã cài được trong prototype)

| State | VÀO khi | AI làm gì | RA khi | Chuyển tới |
|---|---|---|---|---|
| NEW_LEAD | Event đầu tiên từ customer chưa có record | Chào + hỏi nhu cầu; KHÔNG đẩy giá khi chưa được hỏi | Nhu cầu chung / hỏi SP / tín hiệu mua | DISCOVERY / PRODUCT_QA / BUY_INTENT |
| DISCOVERY | Khách hỏi mơ hồ ("bán gì", "tư vấn giúp") | Tư vấn theo catalogue từ DB | Nhắc SP cụ thể / tín hiệu mua | PRODUCT_QA / BUY_INTENT |
| PRODUCT_QA | Hỏi chi tiết SP (giá, size, màu, còn không) — kể cả đến từ ảnh/vision | Retrieval 4 lớp → chỉ được phát biểu trong FACTS; thiếu evidence → câu an toàn | Tín hiệu mua; hết hàng → đề xuất thay thế từ DB | BUY_INTENT / COLLECT_ORDER / (hết hàng khi chốt → quay lại đây) |
| BUY_INTENT | Nhận diện ý định đặt + bóc được ≥1 SP | Ghi nhận giỏ; xin trường thiếu | Có ≥1 trường đơn được ghi nhận | COLLECT_ORDER |
| COLLECT_ORDER | Đang có draft, còn thiếu trường | Slot-filling ĐÚNG trường thiếu nhất (SĐT → địa chỉ → tên); ghép tin rải nhiều lát | Đủ trường → VALIDATE | VALIDATE |
| VALIDATE | Draft đủ trường bắt buộc | **AI không quyết gì ở đây** — máy kiểm tra: slot đủ, SKU tồn tại, tồn kho + giá FRESH từ DB (pha A, trong transaction) | Pass → CONFIRM; fail → COLLECT_ORDER hỏi đúng trường lỗi | CONFIRM / COLLECT_ORDER |
| CONFIRM | Draft đã validate + đã giữ chỗ (reserve) | Gửi bill template render từ order snapshot (AI không sinh bill); chờ khách gật/sửa | Khách xác nhận → pha B; sửa → COLLECT_ORDER | ORDERED / COLLECT_ORDER |
| ORDERED | Pha B COMMIT thành công (đọc lại từ orders DB, không phải lời AI) | Trả lời trạng thái từ order DB | Webhook ĐVVC | SHIPPING / AFTER_SALES |
| SHIPPING | ĐVVC xác nhận nhận hàng | Chỉ báo cáo trạng thái từ webhook/DB | Giao thành công / thất bại | AFTER_SALES / CLAIM* |
| AFTER_SALES | Đơn DELIVERED (verify từ carrier, không tin lời ai) | Follow-up theo lịch, chỉ khi chưa opt-out | Đơn mới → vòng mới; vấn đề → CLAIM* | vòng mới / CLAIM* |

\* **CLAIM là state phụ, không nằm trên trục chính**: flag `claim = {opened_at, reason, origin_state}` (prototype `session.js openClaim()`), vào từ ORDERED/SHIPPING/AFTER_SALES khi classifier phát hiện khiếu nại, đóng xong quay về `origin_state`. Case 13 chứng minh: claim `{reason:"complaint", origin_state:"ORDERED"}` — đơn vẫn chạy webhook bình thường trong lúc hội thoại ở chế độ khiếu nại.

Bảng chuyển hợp lệ cài cứng (`session.js TRANSITIONS`): transition ngoài bảng → bị từ chối `bad_transition_X_to_Y`. Đây là hàng rào machine-checkable — không code nào thêm sau này có thể nhảy state ngoài luồng mà không để lại audit lỗi.

### A.1.2 mode AUTO/HUMAN — overlay vuông góc với mọi state (nơi INV-5 bị chặn)

- `conversation.mode: 'AI' (= AUTO) | 'HUMAN' (= HUMAN_OWNED)`. Takeover có thể xảy ra ở **mọi state**, không phá trục tuyến tính; trả quyền **giữ nguyên state cũ** (case 16: giữ ORDERED, không reset NEW_LEAD).

**Trả lời trực tiếp câu hỏi đề bài — INV-5 (HUMAN_OWNED) chặn auto-send ở 3 tầng, tầng quyết định là AUTHORIZE của Action Gate:**

1. **Tầng AUTHORIZE của Action Gate — tầng CHẾT, nơi mọi auto-action bị chặn** (kể cả action đơn CREATE_ORDER/CONFIRM_ORDER, không chỉ send tin). Mọi tin đi ra và mọi action rời hệ thống đều phải qua `gate.authorize()` vì **đường gửi/action duy nhất của hệ thống nằm trong Action Gate**; luật: `actor === 'ai' && conversation.mode === 'HUMAN'` → REJECT `takeover` (`action-gate.js` dòng authorize). Không có lối tắt nào ra nền tảng mà lọt cổng này — đây là chốt kiến trúc: **cấm hành động ở điểm tập trung, không cấm rải rác trong từng route**.
2. **Tầng pipeline (trước khi đề xuất)**: mode HUMAN → pipeline KHÔNG chạy propose đầy đủ; chỉ lưu tin khách + soạn nháp `HOLD_FOR_AGENT` + đẩy worklist cho nhân viên (`pipeline.js handleEvent`). AI "nghĩ" nhưng không sinh proposal gửi — giảm cả chi phí lẫn rủi ro.
3. **Tầng job nền (scheduler)**: khi nhận takeover, `takeover.setTakeover()` **hủy sạch mọi job QUEUED của hội thoại** (check_receipt, follow-up, marketing) — việc "AI đang hẹn gửi sau" bị thu hồi NGAY, không chỉ chặn tại thời điểm hiện tại.

- **Ngoại lệ tường minh phải giữ chặt**: template hệ thống cố định (ack opt-out, template an ủi khiếu nại) đi với `actor='system'`, text thuộc whitelist policy, audit ghi rõ sender=system (case 13 vẫn gửi đúng 1 tin an ủi trong mode HUMAN). Đây KHÔNG phải auto-send của AI. Quy tắc v2: **mọi template `system` mới phải thêm vào danh sách liệt kê tường minh + audit riêng**; cấm code đường nào khác tự gắn `sender:'system'` để lách cổng (hiện prototype chấp nhận rủi ro này vì 1 file — production phải whitelist cứng).
- Nhân viên gửi tin trong mode HUMAN: `actor='human_agent'` qua cùng gate (`agentSend`) — case 15 chứng minh nhân viên gửi được, AI thì không.

### A.1.3 Slot-state đơn cho từng trường draft

```
draft = {
  slots: { name | phone | address : { value, state: empty | detected | confirmed } },  // độc lập với SP
  items: [ { sku, qty, state: detected | confirmed | stale } ]                          // phụ thuộc SP
}
```

- `empty` → `detected` (bóc được từ tin khách, chưa qua validate) → `confirmed` (đã qua gate: SĐT regex VN pass; item dùng tạo DRAFT); item khi đổi SP → `stale` (KHÔNG xoá — khách quay lại đúng SKU thì restore về `detected`, `session.js markProductChange`).
- **Slot độc lập (name/phone/address) không phụ thuộc SP** — đổi sản phẩm giữ nguyên, không hỏi lại khách (case 5: đổi nến → trà, slot name/phone nguyên vẹn).
- Quy tắc ghép tin rời: tin mới điền chỗ trống; trường đã `confirmed` chỉ đổi khi khách nói rõ muốn sửa.
- Evidence thật case 5 (`case-05/db.json`): sau đổi SP, `items` chứa `TRA-HOA-SEY-50 state="confirmed"` + item cũ stale, `slots = {name:"An"(detected), phone:"0901111222"(confirmed), address(detected)}`.

### A.1.4 Rà 5 INVARIANTS → cơ chế đảm bảo (bảng tổng)

| Invariant | Cơ chế ở tầng nào | Điểm kiểm trong luồng | Case chứng minh |
|---|---|---|---|
| **INV-1 inbound idempotency** | **Gateway** — điểm vào DUY NHẤT: unique index `event_id = channel:platformEventId` qua store insert check-and-set (ngữ nghĩa `INSERT … ON CONFLICT DO NOTHING`); trùng → không xếp hàng, trả `{duplicate:true}` + HTTP 200 + metric `dedupe_hit` | Trước mọi state; event trùng không bao giờ chạm pipeline | 10 (+biến thể Zalo trùng msg_id) |
| **INV-2 outbound unknown** | **Action Gate EXECUTE/VERIFY**: gửi xong kết quả chưa biết → status `TIMEOUT_UNKNOWN` (write-ahead intent đã ghi trong `action_executions` TRƯỚC khi gọi platform) → **CẤM retry mù** → job `check_receipt` hỏi bằng chứng `platform.getReceipt()` ×3 → có receipt: DONE; không: **DLQ + mode=HUMAN + alert operator** | Sau mọi send; cả shipment (case 12) | 11, 11b, 12 |
| **INV-3 order idempotency** | **Order Engine**: key đơn = `order:<conversation_id>:<hash(giỏ)>`, key vận đơn = `shipment:<order_id>`; check-and-set trên unique index `orders.idempotency_key` / `shipments.request_idempotency_key` / `action_executions.idempotency_key`; retry sau reconcile **dùng lại đúng key cũ** | Phase A (tạo DRAFT) + createShipment | 12, 12b (+5: 1 DRAFT active duy nhất) |
| **INV-4 revalidate trước commit** | **Order Engine PHA B** — vị trí đặt revalidate: xem A.2.4 | Trong CÙNG transaction với commit trừ kho | 9 (+6, 7 ở pha A) |
| **INV-5 HUMAN_OWNED** | 3 tầng nêu A.1.2; **tầng quyết định = AUTHORIZE của Action Gate** (điểm tập trung duy nhất) | Mọi send/action | 13, 15, 16 (+11b: system tự takeover khi chết gửi tin) |

**Phân loại A.1**: khung 10 state + mode overlay + slot-state = **USE** (đã cài + test). Thêm rate-limit chống loop ở AUTHORIZE = **CHƯA XÁC MINH** (chưa cài trong prototype — ghi rõ ở A.6).

## A.2 Product grounding (nâng cấp trọng tâm của v2)

### A.2.1 Retrieval 4 lớp — nhận diện khách đang hỏi SP nào

Chạy TRƯỚC khi LLM viết lời (`product-db.js searchProduct`), dừng ở lớp trúng đầu tiên:

- **L1 SKU exact** (khách gõ mã từ ảnh/quảng cáo) → **L2 alias** (dữ liệu shop nhập: tên gọi khác, viết tắt — không phải AI đoán) → **L3 substring** trên tên đã bỏ dấu (NFD + `đ→d`, tái dùng `boDau` đã duyệt vòng 1) → **L4 fuzzy** Levenshtein chuẩn hoá, ngưỡng ≥ 0.8, có cửa sổ trượt để không phạt độ dài.
- **Multi-product**: quét cả catalogue cho từng cụm (tách theo dấu phẩy/"và") — case 6 mua nhiều SKU, case 1 assert L3 trả ≥2 ứng viên cho "nến thơm".
- Không match → subject UNKNOWN → bị cấm đoán tên SP (chỉ hỏi lại/gợi ý từ DB).
- Evidence case 1: `searchProduct('NT-VANILLA-M-DO').layer='sku'`, `'trà hoa sấy'→'alias'`, `'nến thơm'→'substring' (≥2 match)`, `'nen vanila'→'fuzzy' score≥0.8` — cả 4 lớp assert trong cùng 1 case.

### A.2.2 FACTS / WORDING — tách bằng CẤU TRÚC, không phải lời dặn

- **FACTS** = JSON do CODE dựng mới từ product-db tại mỗi lượt (`buildFacts` — luôn đọc mới nhất, có `effective = stock_qty − stock_reserved`), gắn `source: 'product_db'` + snapshot tồn kho.
- **WORDING** = LLM: chỉ diễn đạt FACTS thành lời tự nhiên, không được bổ sung dữ liệu.
- Ràng buộc cài bằng cấu trúc, không phải hy vọng: **`sales-ai.js` KHÔNG import store/product-db/gateway** — nó chỉ nhận FACTS và trả lời đề nghị (text + evidence + confidence), không có đường gọi DB hay API gửi tin. LLM "bịa" không đổi được sự thật vì nó không chạm được tới nguồn sự thật.

### A.2.3 Guard post-check — quét lại LỜI AI trước khi gửi

Đặt tại VALIDATE của Action Gate, chạy trên **mọi** proposal send (case 8 chặn ở đây):

1. Trích mọi số tiền trong text AI (`extractMoney`: số có đơn vị tiền `đ/d/vnd/k` hoặc nhóm nghìn `185.000`) → đối chiếu với tập giá trị hợp lệ = **toàn bộ giá trong DB + snapshot đơn đã validate** (`allowedMoney`). Số lạ → `OVERRIDDEN`: đè bằng câu **render từ FACTS/DB** (`renderValidated`), audit ghi `bad_money` + `overridden_fields=[price]`, metric `gate_override++`.
2. Không evidence (`evidence=null`) hoặc `needHuman` → **câu an toàn (whitelist xoay vòng) + NEEDS_HUMAN**, metric `ai_low_confidence++`, đẩy worklist (case 14).
3. **Hạn chế đã khai (không nói đẹp)** — guard prototype chỉ quét money-có-đơn-vị; **CHƯA quét**: money không đơn vị ("giá 92500"), số lượng tồn, SĐT trong câu AI, tên SP đặt sai catalogue, link/tài khoản ngoài whitelist. Đây là **bản thu gọn cố ý** để tránh false-positive với mã đơn (bug flaky đã gặp vòng 1: `ORD_912930` bị coi là tiền lạ). v2 production bắt buộc regex context-aware đủ 3 lớp (money/qty/phone) + kiểm tên SP — **CHƯA XÁC MINH** độ chính xác trên tiếng Việt thực, phải đo trên corpus trước khi mở auto.

### A.2.4 INV-4 revalidate NGAY TRƯỚC commit — vị trí trong luồng

```
CONFIRM (khách gật)
   └→ gate.confirmOrder()  [AUTHORIZE: actor ai + mode + state]
        └→ orders.phaseB()  ← ★ REVALIDATE ĐẶT Ở ĐÂY — trong CÙNG transaction với commit:
             đọc getStock(sku) MỚI NHẤT từng line (không dùng cache hội thoại):
               • tồn khả dụng CHO ĐƠN = stock_qty − stock_reserved + qty_của_đơn  (không tự chặn
                 chính reservation của mình — bug đã sửa vòng 1, ghi ở KET-QUA mục 5.4)
               • giá DB ≠ giá snapshot → PRICE_CHANGED → không commit
             ĐẦY ĐỦ điều kiện mới: commitSale (trừ kho thật, oversell → throw) + DRAFT→CONFIRMED
             FAIL bất kỳ → return OUT_OF_STOCK/PRICE_CHANGED → hủy draft + hoàn reserve + báo khách
        └→ tạo vận đơn (idempotency `shipment:<order_id>`)
```

- Khoảng chết được phủ: pha A giữ chỗ lúc còn hàng → **can thiệp ngoài đưa stock về 0** → khách chốt → pha B đọc lại thấy 0 → **không có đơn CONFIRMED, không oversell** (assert cả cột: mọi variant `stock_qty ≥ 0` và `effective ≥ 0`) → hủy draft, hoàn reserve, báo hết hàng + gợi ý SP khác CÒN hàng từ DB → hội thoại không kẹt (về PRODUCT_QA).
- FACTS trong hội thoại cũng luôn dựng mới mỗi lượt (A.2.2) — nhưng lớp chốt là pha B, vì FACTS chỉ nuôi LỜI, còn **commit phải đọc lại trong transaction** (2 lớp độc lập, lớp sau không tin lớp trước).
- Evidence case 9 (`case-09/audit.jsonl`): `{"proposed_action":"CONFIRM_ORDER","validation":{"fail":"OUT_OF_STOCK","sku":"NT-VANILLA-M-DO"},"execution_result":"FAILED:OUT_OF_STOCK","stage":"FAILED"}`; đơn DRAFT → CANCELLED.

**Phân loại A.2**: retrieval 4 lớp + FACTS/WORDING + guard money + pha B revalidate = **USE** (đã cài + test). Guard mở rộng (qty/phone/tên SP/link) + đo corpus = **CHƯA XÁC MINH**.

## A.3 Multimodal — text (chính), ảnh, voice

Nguyên tắc: **media KHÔNG vào pipeline trực tiếp** — tiền xử lý ở tầng riêng, biến thành text/cấu trúc rồi đi tiếp luồng text như thường (một pipeline, không luồng song song).

| Loại | Tiền xử lý | Vào pipeline thế nào | Fail thì sao |
|---|---|---|---|
| **Text** | — (chuẩn hoá bỏ dấu khi match) | Luồng chính | — |
| **Ảnh (khách gửi)** | Gateway (nơi DUY NHẤT chạm token) tải file về `local_path`; **vision** sinh match `{sku, score}` | score ≥ 0.6: set subject_sku → FACTS → trả tồn kho đúng variant, evidence ghi `matched_variant_id` + `vision_score`; ảnh gốc lưu `media_url/local_path` cho Inbox | score < 0.6 → **KHÔNG tự trả**: câu an toàn + NEEDS_HUMAN + worklist (case 3 ảnh mờ score 0.35) |
| **Voice (Zalo/FB)** | Gateway tải file; **STT** → transcript + confidence | Transcript gắn cờ `from_asr` + `asr_confidence`, lưu text_content → **slot-filling chạy tiếp như text** (case 4: voice "cho mình 1 hộp trà hoa sấy" → thẳng luồng mua, hỏi SĐT) | STT fail → câu an toàn + NEEDS_HUMAN, **không đoán** (case 4 broken.amr); token media không lọt audit (assert đọc nguyên file audit.jsonl) |
| Gửi ảnh ĐI | Chỉ URL trong `product.images` + whitelist đuôi file | — (giai đoạn sau, theo USE vòng 1) | — |

- **Zalo voice `.amr`: CHƯA XÁC MINH.** Prototype dùng tên file `.amr` chỉ là nhãn mock — **chưa xác minh được** format/file thật của `user_send_voice` (murl có ký hạn không, amr hay opus, payload chính xác). Phải bấm 1 tin voice Zalo thật, xem payload + tải file trước khi code adapter. FB audio attachment cũng cần xác minh lúc tích hợp. Vision/ASR trong prototype là **bảng tra giả** — đúng luồng xử lý, CHƯA đo chất lượng tiếng Việt thật (bắt buộc đo trên bộ mẫu trước khi mở auto — kế thừa AI3 Phụ lục C.5).
- **Phân loại A.3**: luồng media → preprocess → pipeline text = **USE** (đã test 3/4: ảnh match, ảnh mờ, voice ok, voice fail). Format thật Zalo/FB = **CHƯA XÁC MINH**.

## A.4 Human takeover — đủ vòng đời

```
[AI không chắc] ──①──▶ [DỪNG AUTO-SEND] ──②──▶ [NHÂN VIÊN NHẬN] ──③──▶ [XỬ LÝ] ──④──▶ [TRẢ QUYỀN] ──▶ [AUTO đúng state cũ]
```

1. **Điều kiện AI tự dừng** (máy đọc được, không phụ thuộc cảm tính): confidence thấp / không evidence (guard NEEDS_HUMAN); vision match yếu; ASR fail; subject UNKNOWN; khách đòi người thật (regex `cho gặp/người thật/bot à`); khiếu nại (CLAIM luôn kèm HUMAN); DLQ gửi tin chết sau 3 lần check receipt (system tự takeover — case 11b); nhân viên bấm giữ tay.
2. **Dừng auto-send**: pipeline chuyển sang chế độ nháp `HOLD_FOR_AGENT` + worklist; audit ghi ai bấm, lúc nào, hủy sạch job QUEUED (A.1.2 tầng 3).
3. **Nhân viên nhận**: mọi auto-action của AI bị chặn ở AUTHORIZE — **kể cả action đơn** (create/confirm order cũng đi `authorize(actionType)`): case 13 khách nhắn tiếp "alo?" sau khiếu nại → 0 tin AI đi ra, proposal chỉ `HOLD_FOR_AGENT`. Tin nhân viên (`actor='human_agent'`) qua cùng gate bình thường (case 15).
4. **Xử lý**: tin nhân viên sender=human_agent, audit đầy đủ như tin AI (PROPOSED→AUTHORIZED→EXECUTED→VERIFIED).
5. **Trả quyền**: `handback` → mode=AI, **state giữ nguyên** (case 16: ORDERED không reset), chèn ghi chú "nhân viên X vừa xử lý ở state Y" vào ngữ cảnh (`agent_handoff_note`) → AI propose lại ngay lượt sau và **tham chiếu đúng ngữ cảnh**: reply đọc order_code + trạng thái từ order DB, không mâu thuẫn lời nhân viên vừa hứa (assert case 16).

**Phân loại A.4**: **USE** — đã test đủ vòng đời 13/15/16 + 11b (takeover tự động).

## A.5 Chống hallucination — quy tắc tóm gọn

1. **Không evidence → không phát biểu**: câu an toàn (whitelist xoay vòng 3 mẫu, không chứa số) + needsHuman + worklist; metric `ai_low_confidence` để đo tần suất. Case 14: hỏi "dùng cho bé 3 tháng được không" (thuộc tính không có trong DB) → nhận không biết, 0 khẳng định bịa.
2. **Cấm suy diễn giá/khuyến mại**: case 8 stub cố tình bịa "GIÁ SỐC 92500đ" (-50%) → guard chặn, khách chỉ nhận 185000 từ DB; text out không chứa "92500" lẫn chữ "giá sốc"; audit ghi rõ `evidence.source='AI_TU_BIA'` (không xoá dấu bịa — ghi thẳng vào chuỗi audit).
3. **Bill là artifact của dữ liệu**: bill gửi khách render từ `price_snapshot_json` của đơn đã qua VALIDATE (máy tính tổng VND nguyên, cấm float); AI chỉ được kèm câu dẫn không chứa số. Lời AI KHÔNG BAO GIỜ là evidence thực thi.
4. **Trạng thái đơn/cổ phiếu chỉ từ nguồn ngoài**: DELIVERED chỉ khi `carrier.getStatus()` trả DELIVERED (case 17), không tin lời ai nói "giao rồi".

**Phân loại A.5**: **USE** (đã test case 8/14/17).

## A.6 Tổng hợp USE / ADAPT / REJECT / CHƯA XÁC MINH cho delta v2

| Mục | Phân loại | Ghi chú |
|---|---|---|
| 10 state + overlay mode + slot-state 4 giá trị | **USE** | Đã cài, test 18 case |
| INV-5 chặn tại AUTHORIZE (điểm tập trung) + pipeline HOLD + scheduler cancel | **USE** | Case 13/15/16 |
| Retrieval 4 lớp + FACTS/WORDING tách cấu trúc | **USE** | Case 1/2 |
| Guard money (đơn vị/nhóm nghìn) | **USE (bản thu gọn)** | Case 8; hạn chế khai A.2.3 |
| Guard mở rộng qty/phone/tên-SP/link + regex context-aware | **CHƯA XÁC MINH** | Phải đo corpus tiếng Việt trước khi mở auto |
| INV-4 pha B revalidate trong transaction commit | **USE** | Case 9 |
| Ảnh/voice preprocess | **USE (luồng)** | Case 3/4; model thật CHƯA XÁC MINH |
| Zalo voice format (.amr?) + murl ký hạn | **CHƯA XÁC MINH** | Cần payload + file thật |
| Rate-limit chống loop AUTHORIZE | **CHƯA XÁC MINH** | Chưa cài (AI3 mục 4 yêu cầu) |
| SQLite (production) thay JSON store | **ADAPT** | Prototype mô phỏng đúng ngữ nghĩa single-writer + unique index + rollback; KHÔNG chứng minh WAL/crash-recovery/đa tiến trình |
| LLM thật thay stub | **ADAPT** | Stub rule-based có chủ đích; guard + FACTS giữ nguyên vai trò khi gắn model thật |

---

# PHẦN B — 18 SCENARIO SIMULATION (EVIDENCE THẬT, CHẠY LẠI BỞI REVIEWER 2)

## B.0 Thông tin chạy

- Lệnh: `cd /c/Users/BAOAN/.zcode/workspace/default/sales-ai-lab/prototype && node test/18-cases.js` — Git Bash, Node v24.18.0, thuần Node (fs/path/crypto/assert), **không npm, không mạng**.
- Ngày chạy vòng này: **2026-10-05**. Stdout đầy đủ: `docs/simulation-run.log` (43 dòng, đã tee). **Kết quả: 18/18 PASS, 0 FAIL, exit code 0.**
- Evidence mỗi case: `prototype/data/test-runs/case-*/db.json` (toàn bộ DB cuối case) + `case-*/audit.jsonl` (chuỗi audit từng action: `event_id → conversation_id → customer_ref → proposed_action → validation → execution_result → receipt → stage → at`) + `case-03/case-04 media/` (file media tải về có thật trên đĩa). Các bảng dưới trích từ những file này (đọc lại sau lần chạy, không phải chép từ vòng 1).
- Ghi chú trung thực: `test/` còn 2 file `_probe-a2.js`, `_probe-bugs.js` — là probe debug của session trước, KHÔNG thuộc suite 18 case, không chạy trong lần này, không đụng tới.

## B.0.1 Mức mock — đọc trước khi tin 18/18 (bắt buộc khai theo đề bài)

| Thành phần | Thật hay mock | Hệ quả |
|---|---|---|
| LLM | **Mock (stub rule-based)** — hành vi "bịa" case 8 cài CÓ CHỦ ĐÍCH để test gate | 18/18 chứng minh cơ chế CHẶN, chưa chứng minh hành vi LLM thật. Guard + FACTS giữ nguyên vai trò khi gắn model thật |
| Vision / ASR | **Mock (bảng tra theo tên file)** | Đúng luồng xử lý; chất lượng tiếng Việt thật CHƯA XÁC MINH |
| Store | **Mock (JSON + transaction single-writer + snapshot rollback + unique index check-and-set)** | Đúng ngữ nghĩa idempotency/all-or-nothing 1 tiến trình; KHÔNG chứng minh WAL/crash-recovery/đồng ghi 2 tiến trình |
| Facebook/Zalo send API, ĐVVC | **Mock (MockPlatform/MockCarrier, delay/fail cấu hình được)** | Timeout/5xx/ALREADY_EXISTS là mô hình, không thay đo đạc nền tảng thật |
| Thời gian | **Đồng hồ ảo** (timer + jobs + follow-ups chạy đúng logic run_at) | Ngưỡng 60s×3, +2 ngày… đúng logic, chưa phản ánh jitter/tải thật |
| HTTP + HMAC webhook | **Bỏ** (gọi thẳng gateway.receive) | Production bắt buộc verify `X-Hub-Signature-256` trước parse |

→ Kết luận mức tin cậy: **18/18 PASS chứng minh LOGIC cơ chế (idempotency, revalidate, guard, takeover, opt-out) đúng và test được**; KHÔNG chứng minh hành vi LLM/vision thật, hiệu năng, hay độ trễ nền tảng. Các phần "quá mức mock" đã liệt kê ở B.3.

## B.1 Bảng 18 scenario — case → state path → invariant → kết quả thật

State path đọc từ `STATE_TRANSITION` trong `audit.jsonl` của từng case (state đầu `NEW_LEAD` ngầm định).

| # | Case | State path (audit thật) | Invariant / cơ chế bị test | Kết quả thật (assert chính + evidence) | Evidence |
|---|---|---|---|---|---|
| 1 | Hỏi giá | NEW_LEAD→PRODUCT_QA | Golden rule (AI không nguồn sự thật) + audit 5 stage | PASS — reply chứa **185000** đọc từ DB; `ai_proposals.evidence.source='product_db'`; 1 exec SEND_MESSAGE DONE có receipt `mid`; audit đủ PROPOSED→VALIDATED→AUTHORIZED→EXECUTED→VERIFIED; 4 lớp retrieval assert đúng lớp | `case-01/db.json`, `audit.jsonl` |
| 2 | Hỏi size/màu | NEW_LEAD→PRODUCT_QA | Grounding biến thể + tồn hiệu dụng | PASS — out chứa "còn 3" (M đỏ), "hết hàng" (M xanh), "185000"; KHÔNG có "màu vàng" bịa; evidence snapshot `effective=3` | `case-02/db.json` |
| 3 | Ảnh "còn cái này không?" | NEW_LEAD→PRODUCT_QA | Multimodal + anti-hallucination (match yếu) | PASS — media tải về `local_path` **tồn tại trên đĩa**; vision 0.92 → trả đúng variant; ảnh mờ 0.35 → câu an toàn (thuộc SAFE_REPLIES) + `decision=NEEDS_HUMAN` + worklist; `ai_low_confidence=1` | `case-03/db.json`, `media/*.jpg` |
| 4 | Voice | NEW_LEAD→BUY_INTENT→COLLECT_ORDER | Multimodal + anti-hallucination (ASR fail) + vệ sinh token | PASS — transcript "cho mình 1 hộp trà hoa sấy nhé" lưu text_content, cờ `from_asr`; luồng mua chạy như text (hỏi SĐT); broken.amr → câu an toàn + `VOICE_ASR_FAIL/NEEDS_HUMAN`; **audit.jsonl không chứa 'zcdn-token'** | `case-04/db.json`, `audit.jsonl` |
| 5 | Đổi SP giữa hội thoại | NEW_LEAD→BUY_INTENT→COLLECT_ORDER→VALIDATE→CONFIRM | Slot-state + vòng đời draft + INV-3 (1 DRAFT active) | PASS — audit ORDER_STATUS: `DRAFT→CANCELLED→DRAFT`; reserve V1 hoàn về 0, V2 reserve 1; chỉ 1 DRAFT active; slot name/phone **giữ nguyên**; item cũ stale | `case-05/db.json`, `audit.jsonl` |
| 6 | Mua nhiều SKU | fb-c6: →…→ORDERED; fb-c6b: →PRODUCT_QA (bị chặn) | Atomicity nhiều line + VALIDATE pha A | PASS — order CONFIRMED 2 dòng `order_items`, total = 2×185000+145000+25000 = **540000**; stock M đỏ 3→1, trà 20→19; biến thể 1 variant hết → `REJECTED_BY_GATE` (CREATE_ORDER), **0 đơn nửa vời, 0 reserve sót**, báo hết hàng | `case-06/db.json` |
| 7 | Thiếu địa chỉ | NEW_LEAD→BUY_INTENT→COLLECT_ORDER (→VALIDATE→CONFIRM sau khi bổ sung) | VALIDATE gate | PASS — MISSING_FIELDS: **0 orders, 0 CREATE_ORDER DONE**; tin out hỏi đúng "địa chỉ"; state giữ COLLECT_ORDER; bổ sung → DRAFT tạo | `case-07/db.json` |
| 8 | AI định báo sai giá | NEW_LEAD→PRODUCT_QA | Guard post-check (golden rule) | PASS — audit VALIDATED (trích nguyên văn bên dưới): `money_in_text=[92500]`, `bad_money=[92500]`, `overridden_fields=["price"]`, `execution_result="OVERRIDDEN"`; khách nhận 185000, text KHÔNG chứa 92500/"giá sốc"; `gate_override=1`; evidence ghi `source='AI_TU_BIA'` | `case-08/audit.jsonl`, `db.json` |
| 9 | Hết hàng giữa chat và chốt | NEW_LEAD→BUY_INTENT→COLLECT_ORDER→VALIDATE→CONFIRM→(fail)→COLLECT_ORDER→PRODUCT_QA | **INV-4** revalidate trước commit | PASS — audit FAILED (nguyên văn bên dưới) `fail=OUT_OF_STOCK sku=NT-VANILLA-M-DO`; 0 đơn CONFIRMED; **mọi variant stock ≥ 0 và effective ≥ 0** (không oversell); draft CANCELLED; báo hết hàng + gợi ý từ DB; hội thoại không kẹt | `case-09/audit.jsonl`, `db.json` |
| 10 | Webhook DUPLICATE | NEW_LEAD→PRODUCT_QA | **INV-1** | PASS — lần 2 `{duplicate:true}` + HTTP 200; `inbox_events` 1 dòng; 1 tin in; 1 exec DONE (AI trả đúng 1 lần); `dedupe_hit=1`; biến thể Zalo trùng msg_id dedupe riêng | `case-10/db.json` |
| 11 | Gửi tin timeout | →PRODUCT_QA; 11b: mode→**HUMAN** | **INV-2** | PASS — chính: TIMEOUT_UNKNOWN → job check_receipt → platform phát receipt → DONE + delivery_status=DELIVERED + mid; platform nhận **đúng 1 call**. Biến thể xấu (không bao giờ có receipt): 3 lần check → DLQ `NO_RECEIPT_AFTER_3_CHECKS` + audit `MODE_CHANGE from AI to HUMAN actor=system reason=send_timeout_no_receipt` + worklist; **không có tin thứ 2** | `case-11/db.json`, `case-11b/db.json` |
| 12 | Tạo vận đơn timeout | →…→ORDERED | **INV-2 + INV-3** | PASS — carrier mode 'hang' (đã tạo thật, mất response): order vẫn CONFIRMED; attempt retry mù **BỊ CHẶN** → DLQ `RETRY_BLOCKED_NO_RECEIPT`; `flag_needs_human=true`; reconcile tra `clientOrderCode` → `ALREADY_EXISTS_RESOLVED` → DONE với tracking CŨ; DB shipments **1 dòng**, carrier nhận đúng 1 create. Biến thể 'flaky_once': reconcile NOT_EXISTS → retry an toàn **dùng lại key `shipment:<order_id>`** → 1 vận đơn, 2 create calls | `case-12/*`, `case-12b/*` |
| 13 | Khách khiếu nại | →…→ORDERED + claim(complaint, origin ORDERED) + mode→**HUMAN** | **INV-5** + policy khiếu nại | PASS — audit TAKEOVER `operator=system reason=complaint`; follow-up marketing SCHEDULED → CANCELLED; đúng 1 tin out (template an ủi, có "xin lỗi", KHÔNG hứa bồi thường); tin "alo?" sau đó → **0 tin AI mới**, proposal `HOLD_FOR_AGENT`; worklist OPEN | `case-13/db.json` |
| 14 | Không đủ evidence | NEW_LEAD→PRODUCT_QA | Anti-hallucination | PASS — out thuộc SAFE_REPLIES, KHÔNG có khẳng định về "bé 3 tháng"; `ATTR_UNKNOWN` decision=NEEDS_HUMAN, `evidence_json=null`; `ai_low_confidence=1`; worklist OPEN | `case-14/db.json` |
| 15 | Human takeover | →PRODUCT_QA; mode AI→**HUMAN** | **INV-5** | PASS — audit TAKEOVER (op1, operator_request); job QUEUED của hội thoại **hủy sạch** (0 dòng QUEUED còn lại); tin khách sau đó → 0 tin sender=ai, proposal HOLD_FOR_AGENT; `agentSend` của nhân viên gửi được qua gate, sender=human_agent trong messages | `case-15/db.json` |
| 16 | Nhân viên trả quyền | →…→ORDERED; HUMAN→**AI** (state giữ ORDERED) | **INV-5** handback + ngữ cảnh | PASS — audit TAKEOVER + HANDBACK `state_kept=ORDERED`; mode=AI, state=ORDERED (không reset NEW_LEAD); tin khách kế tiếp → audit PROPOSED mới; reply sender=ai tham chiếu đúng **order_code + status đọc từ order DB** | `case-16/db.json` |
| 17 | Follow-up sau giao | →…→ORDERED→AFTER_SALES | VERIFY từ nguồn ngoài + idempotent follow-up | PASS — carrier.getStatus=DELIVERED → order DELIVERED, state AFTER_SALES; gọi onCarrierStatus 2 lần vẫn **1 dòng** follow_ups (+2 ngày); đến hẹn → SENT đúng 1 lần (tin `msg_kind=care` duy nhất); chạy thêm 24h không có tin thứ 2; audit FOLLOW_UP stage VERIFIED | `case-17/db.json` |
| 18 | Từ chối marketing | →…→ORDERED; mode=AI | Opt-out policy tại AUTHORIZE | PASS — "đừng nhắn quảng cáo" → `marketing_opt_out=1` + opt_out_at; follow-up marketing đang chờ → CANCELLED(opt_out); job marketing thứ 2 đến hẹn → AUTHORIZE REJECT `opt_out` (`gate_rejected_opt_out=1`), 0 tin marketing đi ra; **tin transactional vẫn đi** (reply chứa order_code từ DB); audit có `OPT_OUT_MARKETING` | `case-18/db.json` |

## B.2 Trích evidence nguyên văn (các case then chốt)

**Case 8 — guard chặn lời AI bịa** (`case-08/audit.jsonl`, dòng stage VALIDATED):
```json
{"event_id":"facebook:mid-fb-c8-14","conversation_id":"facebook:fb-c8",...,
 "proposed_action":"SEND_REPLY:PRICE",
 "validation":{"money_in_text":[92500],"bad_money":[92500],"overridden_fields":["price"],"evidence_present":true},
 "execution_result":"OVERRIDDEN","receipt":null,"stage":"VALIDATED","at":"2026-10-04T09:00:00.000Z"}
```

**Case 9 — INV-4 revalidate chặn commit** (`case-09/audit.jsonl`, dòng stage FAILED):
```json
{"event_id":"facebook:mid-fb-c9-16","conversation_id":"facebook:fb-c9",...,
 "proposed_action":"CONFIRM_ORDER","validation":{"fail":"OUT_OF_STOCK","sku":"NT-VANILLA-M-DO"},
 "execution_result":"FAILED:OUT_OF_STOCK","receipt":null,"stage":"FAILED","at":"2026-10-04T09:00:00.000Z"}
```

**Case 11b — INV-2 chết gửi tin → system tự takeover** (`case-11b/audit.jsonl`):
```json
{"proposed_action":"MODE_CHANGE","validation":{"from":"AI","to":"HUMAN","actor":"system","reason":"send_timeout_no_receipt"},"execution_result":"MODE_HUMAN","stage":"MODE","at":"2026-10-04T09:03:00.000Z"}
{"proposed_action":"CHECK_RECEIPT","validation":{"attempt":3},"execution_result":"DLQ_NO_RECEIPT","stage":"FAILED","at":"2026-10-04T09:03:00.000Z"}
```

**Case 5 — vòng đời draft khi đổi SP** (`case-05/audit.jsonl`): `ORDER_STATUS` theo thứ tự `DRAFT → CANCELLED → DRAFT` (hủy cũ hoàn reserve + tạo mới trong cùng hội thoại).

**Case 12 — carrier nhận đúng 1 create dù client timeout** (`case-12/db.json`): `action_executions[shipment:<order_id>].status='DONE'`, `shipments=1 dòng`, `dlq=[RETRY_BLOCKED_NO_RECEIPT]`, metrics `order_create_timeout=1, dlq_count=1`.

## B.3 FAIL-CHƯA-CHỨNG MINH (khai trung thực)

- **0 case FAIL** trong lần chạy 2026-10-05 (log: `docs/simulation-run.log`, exit 0).
- Nhưng các điểm sau là **CHƯA-CHỨNG-MINH do mức mock** (không nằm trong khả năng của suite này, không được tính là đã chứng minh):
  1. Hành vi LLM thật (đa dạng ngôn ngữ, prompt injection, bịa không theo kịch bản cài sẵn) — stub rule-based.
  2. Guard CHƯA quét money-không-đơn-vị / số lượng tồn / SĐT / tên SP trong câu AI (A.2.3) — case 8 chỉ chặn money-có-đơn-vị.
  3. Vision/ASR thật trên tiếng Việt (score 0.92/0.35 là bảng tra) — phải đo bộ mẫu trước khi mở auto.
  4. Đồng thời đa tiến trình, crash-recovery, WAL — JSON store 1 tiến trình không chứng minh được.
  5. Độ trễ/thất bại/định dạng thật của Meta Send API, Zalo (voice .amr?), ĐVVC — MockPlatform/MockCarrier là mô hình; production phải verify HMAC webhook + đo idempotency thật của từng API (CHƯA XÁC MINH).
  6. Rate-limit chống loop AUTHORIZE chưa cài — chưa có case test loop.

---

# KẾT LUẬN REVIEWER 2 (vòng 2)

**18/18 PASS THẬT** — chạy lại ngày 2026-10-05, exit code 0, stdout lưu `docs/simulation-run.log`, evidence đĩa tại `prototype/data/test-runs/case-*/*`. Thiết kế v2 (Phần A) là bản nâng cấp của vòng 1 với mọi cơ chế đều trỏ được tới code + case chứng minh.

**5 phát hiện quan trọng nhất:**

1. **INV-5 chỉ an toàn nếu chặn ở MỘT điểm tập trung (AUTHORIZE của Action Gate), không phải rải rác trong route.** Prototype chứng minh: đường gửi tin + action duy nhất nằm trong gate → mode HUMAN chặn được cả send lẫn action đơn (case 13: cả create-order đều bị REJECT). Đổi lại phải khóa chặt ngoại lệ `actor='system'` bằng whitelist tường minh — đây là lỗ hổng tiềm ẩn duy nhất của cơ chế nếu production phóng túng thêm sender mới.
2. **INV-4 revalidate phải nằm TRONG transaction của commit (pha B), không phải ở tầng hội thoại.** FACTS nuôi lời nói là một lớp; lớp chốt đọc lại `getStock` + so giá snapshot ngay trước commitSale, và "tồn khả dụng" phải cộng lại phần reserve của chính đơn (`stock − reserved + qty_của_đơn`) nếu không đơn tự chặn chính mình — bug thật đã gặp và sửa ở vòng 1.
3. **INV-2/INV-3 hợp nhau thành một cơ chế write-ahead intent + receipt-or-DLQ**: mọi action rời hệ thống ghi intent TRƯỚC khi gọi ngoài; UNKNOWN → cấm retry mù → hỏi bằng chứng (receipt/tra mã) ×3 → xong việc hoặc DLQ + takeover. Key idempotency phải được **dùng lại y nguyên** khi retry sau khi chắc chắn chưa tồn tại (case 12b: 2 create calls, 1 vận đơn).
4. **Guard money hiện tại là bản thu gọn — lỗ hổng biết trước**: money không đơn vị, số lượng tồn, SĐT, tên SP trong câu AI chưa bị quét. Case 8 PASS không có nghĩa là LLM thật không lọt số bịa theo dạng khác. Việc số 1 khi build thật: guard context-aware + đo trên corpus tiếng Việt trước khi mở auto (CHƯA XÁC MINH).
5. **Multimodal chỉ mới chứng minh ĐƯỜNG ỐNG**: ảnh/voice đi preprocess → text → cùng pipeline, fail → an toàn + needsHuman, token không rò audit. Format thật của Zalo voice (`.amr`?), ký hạn URL media, chất lượng STT/vision tiếng Việt đều CHƯA XÁC MINH — cấm mở auto cho ảnh/voice trước khi đo bộ mẫu thật.

---
*AI2 v2 — Reviewer 2 (Sales AI/Workflow), hội đồng vòng 2. Không sửa file nào ngoài file này + `docs/simulation-run.log` (stdout của lần chạy).*
