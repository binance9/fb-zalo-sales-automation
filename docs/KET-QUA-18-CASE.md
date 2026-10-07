# KẾT QUẢ 18 CASE — PROTOTYPE BÁN HÀNG TỰ ĐỘNG

- Ngày chạy: 2026-10-04. Node.js v24.18.0, thuần module có sẵn (fs, path, crypto, assert) — **không npm install, không mạng**.
- Vị trí code: `sales-ai-lab/prototype/` — chạy trọn vẹn: `node test/18-cases.js` (exit code 0 khi 18/18).
- Kết quả: **18/18 PASS**, ổn định qua nhiều lần chạy liên tiếp (không phụ thuộc thời gian thực — toàn bộ delay/timer chạy trên đồng hồ ảo).

## 1. Bảng 18 case

| # | Case | Cơ chế đã chứng minh | Kết quả |
|---|------|----------------------|---------|
| 1 | Khách hỏi giá | 4 lớp `searchProduct` (sku → alias → substring bỏ dấu → fuzzy ≥0.8); reply chứa **185000** đọc từ DB lúc validate; `ai_proposals.evidence.source=product_db`; 1 exec send DONE có receipt (mid); audit đủ 5 stage PROPOSED→VALIDATED→AUTHORIZED→EXECUTED→VERIFIED | PASS |
| 2 | Hỏi size/màu | Reply liệt kê đúng biến thể DB: M-đỏ **còn 3** (tồn hiệu dụng = qty−reserved), M-xanh **hết hàng**; không bịa biến thể; snapshot tồn kho ghi trong evidence | PASS |
| 3 | Ảnh "còn cái này không?" | Gateway tải media về `data/media/` (local_path tồn tại trên đĩa); mock vision match `NT-VANILLA-M-DO` score 0.92 → trả tồn đúng variant; ảnh mờ score 0.35 → **NEEDS_HUMAN + câu an toàn, không tự trả** | PASS |
| 4 | Voice | ASR trước rồi vào pipeline text như thường (transcript + cờ `from_asr`, slot-filling chạy tiếp như text → hỏi SĐT); ASR fail → câu an toàn + NEEDS_HUMAN, không đoán; token media không lọt audit | PASS |
| 5 | Đổi sản phẩm giữa hội thoại | DRAFT cũ bị **hủy + hoàn reserve V1**, item cũ → `stale`, slot độc lập (tên/SĐT/địa chỉ) **giữ nguyên**; chỉ 1 DRAFT active; audit 2 chuỗi (hủy cũ + tạo mới) | PASS |
| 6 | Mua nhiều SKU | `order_items` 2 dòng, tổng = SUM(line_total)+fee = 540000 (VND nguyên); trừ đúng stock từng variant; **1 variant hết → rollback toàn bộ**, không có đơn nửa vời, không reserve sót | PASS |
| 7 | Thiếu địa chỉ | GATE VALIDATE fail `MISSING_FIELDS` → **không có orders DRAFT/CONFIRMED**, không CREATE_ORDER DONE; tin out hỏi đúng trường "địa chỉ"; state giữ COLLECT_ORDER; bổ sung địa chỉ → pha A chạy tiếp | PASS |
| 8 | AI định báo sai giá | Stub cố tình bịa "GIÁ SỐC 92500đ" (đề bài: giá sai 50% khi câu chứa "giá sốc"); GATE VALIDATE quét money trong text, 92500∉DB → **đè bằng câu render từ DB (185000)**; `decision=OVERRIDDEN`, `overridden_fields=[price]`, metric `gate_override++` | PASS |
| 9 | Hết hàng giữa chat và chốt | Pha A giữ chỗ khi còn 1; can thiệp ngoài đưa stock về 0; chốt → **pha B RE-VALIDATE trong transaction → OUT_OF_STOCK → hủy draft + hoàn reserve**; stock ≥ 0 và tồn hiệu dụng ≥ 0 toàn cột (không oversell); báo hết hàng + gợi ý SP khác từ DB; audit FAILED reason=out_of_stock; hội thoại không kẹt | PASS |
| 10 | Webhook DUPLICATE | Cùng platformEventId gửi 2 lần: lần 2 trả `{duplicate:true}` + HTTP 200; `inbox_events` 1 dòng; 1 tin in; AI trả đúng 1 lần (1 exec DONE); `dedupe_hit=1`; biến thể Zalo trùng msg_id cũng dedupe riêng | PASS |
| 11 | Gửi tin timeout | Platform mock treo response → exec `TIMEOUT_UNKNOWN` → **không gửi lại mù** → job `check_receipt` hỏi bằng chứng: mock phát receipt → DONE + `DELIVERED` + mid, khách nhận đúng 1 tin; biến thể xấu (không bao giờ có receipt) → 3 lần check → **DLQ + mode HUMAN + alert operator** | PASS |
| 12 | Tạo vận đơn timeout | Executor timeout → `TIMEOUT_UNKNOWN` → **attempt retry mù BỊ CHẶN (không receipt) → DLQ + cờ needsHuman**; job reconcile tra cứu `clientOrderCode`: (a) ALREADY_EXISTS → DONE với tracking CŨ, mock nhận đúng 1 create; (b) chưa tồn tại → retry an toàn **dùng lại idempotency key** `shipment:<order_id>`; cả 2 kịch bản chỉ có **1 vận đơn** | PASS |
| 13 | Khách khiếu nại | Classifier từ khóa → CLAIM + `mode=HUMAN` actor=system reason=complaint; **duy nhất 1 template an ủi** (không hứa bồi thường); follow-up marketing đang chờ → CANCELLED; worklist alert; tin sau đó AI không auto-send | PASS |
| 14 | Không đủ evidence | Hỏi thuộc tính không có trong DB → stub trả confidence 0.1 / evidence rỗng → **câu an toàn (thuộc whitelist) + NEEDS_HUMAN**, không đoán; `ai_low_confidence++`; worklist OPEN cho operator | PASS |
| 15 | Human takeover | `mode=HUMAN` + audit (ai bấm, lúc nào); **job AI QUEUED của hội thoại bị hủy sạch**; tin khách sau đó chỉ lưu + soạn nháp `HOLD_FOR_AGENT`, 0 tin sender=ai; tin nhân viên (sender=human_agent) gửi qua gate bình thường | PASS |
| 16 | Nhân viên trả quyền | `mode=AI`, **state giữ nguyên (ORDERED, không reset NEW_LEAD)**; tin khách kế tiếp AI propose lại (audit PROPOSED mới); reply tham chiếu đúng mã đơn + trạng thái đọc từ order DB → không mâu thuẫn lời nhân viên | PASS |
| 17 | Follow-up sau giao | Carrier mock báo DELIVERED (VERIFY từ nguồn ngoài) → tạo `follow_ups` hẹn +2 ngày (idempotent, gọi 2 lần vẫn 1 dòng) → đến hẹn → GATE (check opt-out) → **SENT đúng 1 lần, đúng hẹn**; chạy thêm 24h không có tin thứ 2; audit đủ chuỗi | PASS |
| 18 | Từ chối marketing | "đừng nhắn quảng cáo" → `marketing_opt_out=1` + opt_out_at; follow-up marketing SCHEDULED → **CANCELLED(opt_out)**; job marketing đến hẹn sau đó → AUTHORIZE **REJECT opt_out** (`gate_rejected_opt_out++`), 0 tin đi ra; **tin transactional (trạng thái đơn) vẫn đi được**; audit ghi event opt-out | PASS |

## 2. Kiến trúc prototype (map với thiết kế AI3/AI2)

```
gateway.js  (dedupe theo event_id = channel:platformEventId → queue → worker normalize + tải media)
    ↓
pipeline.js (WRK+AI: understand intent, trích slot, dựng FACTS MỚI từ product-db, gọi sales-ai stub lấy WORDING)
    ↓
action-gate.js (VALIDATE → AUTHORIZE → EXECUTE → VERIFY; mọi action rời hệ thống bắt buộc qua đây)
    ├── product-db.js  (nguồn sự thật giá/tồn; getStock luôn đọc mới nhất)
    ├── order-engine.js (pha A reserve → pha B re-validate → CONFIRMED; shipment có idempotency)
    ├── shipping.js    (MockCarrier + MockPlatform — delay/failures cấu hình được cho case 11/12/17)
    ├── takeover.js    (mode AUTO↔HUMAN + worklist)
    └── store.js       ("SQLite thay thế": JSON + transaction khoá ghi tuần tự + unique index check-and-set + rollback snapshot)
audit: store.audit() ghi JSONL mỗi action: {event_id, conversation_id, customer_ref, proposed_action,
       validation, execution_result, receipt, stage, at} → data/test-runs/case-*/audit.jsonl
```

Ràng buộc cấu trúc đã cài để chứng minh nguyên tắc vàng: `sales-ai.js` **không import** store/product-db/gateway — nó chỉ nhận FACTS (JSON) và trả lời đề nghị; đường gửi tin duy nhất nằm trong action-gate.

## 3. Bản thu gọn so với spec (đã ghi rõ theo yêu cầu)

1. **SQLite → JSON store**: production dùng SQLite WAL + `BEGIN IMMEDIATE` (AI3 mục 0/Phụ lục A). Prototype mô phỏng: ghi tuần tự (single-writer), rollback bằng snapshot, unique index bằng check-and-set — đủ đúng ngữ nghĩa idempotency/all-or-nothing, không mô phỏng được WAL/crash-recovery/đồng ghi 2 tiến trình.
2. **Gateway bỏ HTTP + HMAC** (`X-Hub-Signature-256`): prototype gọi thẳng `gateway.receive()`; production bắt buộc verify signature trước khi parse (AI3 mục 1.4).
3. **LLM stub thay model thật**: `sales-ai.js` là rule-based; hành vi "bịa" (case 8) được cài có chủ đích để test gate. Khi gắn LLM thật, guard số-tiền + FACTS trong gate giữ nguyên vai trò.
4. **Vision/ASR là bảng tra giả** (`media.js`): đúng luồng xử lý (media → caption/transcript → pipeline), sai số thực tế chưa đo — AI3 Phụ lục C.5 yêu cầu đo trên bộ mẫu trước khi mở auto.
5. **Scheduler = đồng hồ ảo + bảng jobs/follow_ups**: job `check_receipt` (+60s × 3 attempts), `reconcile_shipment`, follow-up +2 ngày chạy đúng logic run_at nhưng không chờ thời gian thực.
6. **Guard số tiền thu gọn**: chỉ coi là money khi có đơn vị tiền (đ/vnd/k) hoặc nhóm nghìn (185.000). Số tiền KHÔNG có đơn vị trong câu AI (vd "giá 92500") chưa bị chặn — cần regex context-aware khi làm thật. Số lượng tồn/SDT trong câu AI cũng chưa quét (AI2 mục 5.2 nêu đủ 3 loại).
7. **Rate-limit chống loop** ở AUTHORIZE (AI3 mục 4) chưa cài.
8. **Comment automation, media nhiều ảnh, reply tách nhiều tin (`---`), summary cuộn LLM**: chưa nằm trong 18 case bắt buộc nên chưa làm — kiến trúc đã chờ sẵn (event type, message kind).

## 4. Hạn chế của prototype — thứ SQLite-mock/JSON KHÔNG chứng minh được (dùng lần 2 khi build thật)

- **Đồng thời đa tiến trình**: check-and-set trong 1 tiến trình Node đơn luồng không chứng minh được hành vi khi 2 instance ghi cùng lúc. Production: SQLite `BEGIN IMMEDIATE` + single-instance constraint (AI3 mục 0.2), thoát ngưỡng thì chuyển Postgres + broker.
- **Crash giữa chừng**: rollback snapshot chỉ mô phỏng all-or-nothing trong logic; crash thật giữa write file/HTTP cần WAL + journal (write-ahead intent đã có trong `action_executions` — đúng hướng, nhưng chưa test crash-recovery thật).
- **Hiệu năng unique index**: quét tuyến tính trên mảng JSON — chỉ đúng cho dữ liệu lab; production dùng index thật.
- **Độ trễ/thất bại thực của nền tảng**: MockPlatform/MockCarrier là mô hình của timeout/5xx/ALREADY_EXISTS, không thay được đo đạc Meta/Zalo/ĐVVC thật (AI3 Phụ lục C: idempotency của Send API, Zalo msg_id, ĐVVC — CHƯA XÁC MINH).
- **Đồng hồ ảo**: các ngưỡng thời gian (60s check, +2 ngày follow-up, tick 5s) chưa phản ánh jitter/tải thật.

## 5. Các lỗi gặp phải khi chạy và đã sửa (log cho lần sau)

1. `msgKind` thiếu trong tham số `executeSend` → mọi gửi tin văng ReferenceError bị gateway nuốt (event FAILED) → cascade ~10 case fail. Sửa: thêm param + đưa helper đoán lỗi fail_reason của inbox_events vào quy trình debug.
2. Guard money nhận mọi số ≥10000 → mã đơn dạng `ORD_912930` (uid chứa 6 số liên tiếp) thỉnh thoảng bị coi là "tiền lạ" → override sai, test **flaky**. Sửa: extractMoney chỉ nhận số có đơn vị tiền hoặc nhóm nghìn.
3. Ảnh bị detectIntent theo caption (VARIANT) thay vì đi luồng vision → trả câu an toàn nhầm. Sửa: kind=image route thẳng `routeImage`.
4. Pha B re-check tồn bằng `effective` (đã trừ reserve) → đơn tự chặn chính chỗ dự phòng của mình. Sửa: tồn khả dụng cho đơn = `stock_qty − stock_reserved + qty_của_đơn`.
5. `drain` chỉ tăng đồng hồ theo timer, quên job/follow-up đến hạn → case 11 treo ở TIMEOUT_UNKNOWN. Sửa: `nextDueAt()` gộp min(timer, jobs.QUEUED.run_at, follow_ups.SCHEDULED.scheduled_at).
6. DLQ sau 3 lần check receipt chưa kéo mode về HUMAN → thêm `MODE_CHANGE` actor=system trong cùng transaction.
7. Case 8: gate render lại câu đúng nhưng thiếu `facts` trong proposal → câu chung chung không số. Sửa: proposal luôn kèm facts để render từ DB.
8. `searchProduct` đưa cả tên SP vào lớp alias → không bao giờ đạt lớp substring. Sửa: unit-test dùng truy vấn là chuỗi con của tên ("nến thơm") để chạm đúng L3.

## 6. Cách chạy lại

```bash
cd sales-ai-lab/prototype
node test/18-cases.js     # in bảng 18 dòng + tổng; exit 0 khi 18/18
```

Dữ liệu mỗi case nằm ở `prototype/data/test-runs/case-*/` (db.json + audit.jsonl + media/) — evidence xem trực tiếp được.
