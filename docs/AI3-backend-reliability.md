# AI-3 — BACKEND / SECURITY / RELIABILITY REVIEWER

- Tài liệu nguồn: `docs/00-yeu-cau.md` (đề bài của chủ shop, kiến trúc đích, 18 case, nguyên tắc vàng).
- Vai trò: thiết kế tầng nền (gateway, dữ liệu, gate, reliability) cho **Phase-1 = RESEARCH + DESIGN + TEST PROTOTYPE, KHÔNG build production**.
- Nội dung là **design + pseudo-code**, không phải code chạy thật.
- Phân loại bắt buộc cho từng đề xuất: `USE` / `ADAPT` / `REJECT` / `CHƯA XÁC MINH`.

---

## MỤC 0 — TỰ ĐÁNH GIÁ: Node.js đơn tiến trình + SQLite cho Phase-1

**Phân loại: USE (có điều kiện) — giữ cho Phase-1. REJECT mọi hạ tầng scale trước thời điểm cần (Redis, message broker, Postgres, multi-instance).**

### 0.1 Lý do TỰ TIN dùng Node + SQLite Phase-1

1. **Mô hình khớp tuyệt đối với SQLite**: 1 shop, 1 fanpage + 1 OA Zalo, sản lượng thực tế vài trăm → vài nghìn sự kiện/ngày. SQLite ở chế độ **WAL** đọc song song, ghi tuần tự — mà hệ thống này bản chất **single-writer** (chính chúng ta muốn exactly-once ledger, tức một luồng ghi sự thật duy nhất).
2. **Transaction thật, dễ đúng**: case 9 (tồn kho đổi giữa chat và chốt) và race 2 đơn cùng lúc được giải quyết gọn bằng `BEGIN IMMEDIATE` — check + reserve trong cùng transaction, không cần lock phân tán.
3. **Zero-ops cho prototype**: không cài service DB, backup = copy file + `VACUUM INTO`; reset lab = xóa file.
4. **Persist queue trong DB thay vì RAM thuần**: yêu cầu "queue trong bộ nhớ + persist" được hiện thực hóa là **bảng `jobs` trong SQLite là nguồn sự thật**, RAM chỉ là vùng chạy. Crash giữa chừng → restart → quét `jobs WHERE status IN ('QUEUED','RUNNING')` chạy lại, không mất sự kiện nào đã trả 200 cho nền tảng.
5. **Driver**: khuyến nghị `better-sqlite3` (API đồng bộ → DB access trong tiến trình Node tự nhiên được serialize, giảm hẳn race nội bộ) hoặc `node:sqlite` built-in (Node ≥ 22, không cần native build). Cả hai đều dùng chung schema bên dưới.

### 0.2 Điều kiện bắt buộc nếu dùng (guardrails — vi phạm là lỗi thiết kế)

- `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;` ngay khi mở DB.
- **Transaction phải NGẮN. Cấm gọi LLM/HTTP/ASR bên trong transaction.** Quy tắc: mở tx → đọc/ghi DB → commit → mới gọi API ngoài. LLM chậm 3–30s, giữ write lock trong lúc đó là chết hệ thống.
- **Một tiến trình duy nhất** là ràng buộc kiến trúc Phase-1 (ghi vào doc để đội prototype không tự ý chạy 2 instance). Single process chính là thứ làm idempotency/dedupe trở nên đơn giản và đáng tin.
- Mọi truy vấn dùng prepared statement; giờ lưu TEXT ISO-8601 UTC.

### 0.3 Khi nào PHẢI rời SQLite (điều kiện thoát, ghi rõ để không gồng)

- Chạy ≥ 2 tiến trình/instance (nút webhook tách khỏi worker) → chuyển queue sang broker thật + DB sang Postgres.
- Cần nhiều người viết đồng thời ở mức dữ liệu cao, hoặc DB > vài GB, hoặc backup point-in-time.
- Lối thoát đã chuẩn bị sẵn: mọi thao tác DB đi qua một lớp repository (`JobsRepo`, `OrdersRepo`, ...) — schema SQL bên dưới viết chuẩn SQL di chuyển được, ít cú pháp riêng của SQLite (chỉ dùng `AUTOINCREMENT`, `INTEGER` boolean).

### 0.4 Kế thừa từ kiến trúc đích trong 00-yeu-cau.md

- Channel Gateway / Action Gate / SALES AI chỉ PROPOSE → **USE nguyên trạng**, đây là đúng hình dạng hệ thống cho một tiến trình.
- Ô "Product DB / CRM / Chat History" vẽ tách biệt → **ADAPT**: Phase-1 chúng nằm chung 1 file SQLite, tách theo **schema + repository**, không tách theo server.

---

## MỤC 1 — CHANNEL GATEWAY

**Phân loại: USE (thiết kế trong 00-yeu-cau) — chi tiết bên dưới là ADAPT từ spec Meta/Zalo, riêng phần verify Zalo là CHƯA XÁC MINH (xem 1.4).**

### 1.1 Vị trí và trách nhiệm

Gateway là **cửa vào + cửa ra duy nhất** của hệ thống với nền tảng:
- Nhận webhook (HTTP server, khuyến nghị Fastify vì có structured logging sẵn).
- **Verify signature trước khi parse** (Meta) / kiểm tra hợp lệ nguồn (Zalo).
- **Trả 200 NGAY** sau khi persist; toàn bộ xử lý nặng (AI, gọi API) chạy nền qua bảng `jobs`.
- Là nơi DUY NHÂN chạm token (mục 9).

### 1.2 Chuỗi xử lý webhook (pseudo-code)

```
POST /webhook/facebook | /webhook/zalo
  1. rawBody = đọc raw bytes TRƯỚC khi parse JSON (bắt buộc cho HMAC)
  2. verifySignature(rawBody, header)            // sai → 401, metric auth_fail++
  3. events = parse(rawBody)
  4. BEGIN IMMEDIATE
       với từng event nền tảng:
         event_id = sinhEventId(channel, event)   // mục 2
         INSERT INTO inbox_events(..., status='RECEIVED') ON CONFLICT(event_id) DO NOTHING
         nếu inserted: INSERT INTO jobs(kind='process_event', payload={event_id}, run_at=now)
     COMMIT
  5. return 200 OK                                  // tổng thời gian mục tiêu < 200ms
```

- Worker (cùng tiến trình, vòng lặp `setInterval` claim job) mới là nơi normalize + chạy AI. Nền tảng gửi lại bao nhiêu lần cũng chỉ chạm được đến `inbox_events` — nil bên trong.
- Meta yêu cầu/respond nhanh và có chế độ **verify webhook** khi đăng ký: `GET /webhook/facebook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...` → so `hub.verify_token` với giá trị trong env, trả nguyên `hub.challenge` → **USE** (spec công khai).

### 1.3 Event chuẩn hoá (một shape duy nhất)

```json
{
  "event_id": "fb:mid.7f3a...  |  fb:comment_123  |  zalo:msg_abc  |  zalo:sha256(...) ",
  "channel": "facebook | zalo",
  "type": "message | message_edit | comment | postback | opt_out_signal | delivery_receipt | read_receipt",
  "conversation_id": "facebook:PAGEID_PSID  |  zalo:OAID_USERID",
  "customer_ref": "PSID (fb) | user_id (zalo)",
  "payload": {
    "kind": "text|image|voice|sticker|fallback",
    "text": "...",                      // text gốc hoặc caption
    "media": [{"type":"image|voice","platform_url":"...","local_path":null}],
    "platform_message_id": "...",       // mid / msg_id
    "timestamp_platform": "...",
    "raw_ref": "..."                    // tham chiếu payload gốc nếu cần
  },
  "received_at": "2026-10-04T09:00:00.000Z"
}
```

Quy ước:
- `conversation_id = channel + ':' + thread nền tảng` (Meta: page-id + psid; comment: post-id + comment-id; Zalo: oa_id + user_id). Đây là khóa hội thoại thống nhất cho cả Messenger lẫn comment.
- `type='comment'` vẫn vào cùng conversations nhưng đánh dấu để Reply Policy áp chính sách riêng (comment automation: trả công khai 1 lần / private reply theo chính sách Meta — cơ chế private reply cần token page, gateway xử lý).
- Media (ảnh/voice) KHÔNG nằm trong webhook URL vĩnh viễn → worker nền tải về thư mục nội bộ `data/media/` bằng token (gateway), ghi `local_path`. Đề bài "hiểu ảnh + voice" phụ thuộc bước này.

### 1.4 Verify signature

- **Meta: `X-Hub-Signature-256`** = `sha256=<hex(HMAC-SHA256(app_secret, rawBody))>`. So sánh bằng `crypto.timingSafeEqual` trên buffer, không dùng `==` trên string (tránh timing leak). → **USE**, spec công khai, test được bằng cách tự ký payload mẫu.
- **Zalo: CHƯA XÁC MINH.** Cần xác minh trên tài liệu chính thức open.zalo.me (OA webhook):
  1. Zalo OA webhook có header chữ ký tương đương `X-Hub-Signature-256` hay không (nếu có → dùng đúng spec, cùng cơ chế HMAC).
  2. Nếu không có chữ ký: phòng thủ thay thế theo tầng — (a) **URL bí mật**: đường webhook chứa segment ngẫu nhiên dài (vd `/webhook/zalo/<32-byte-random>`) coi như shared secret; (b) schema-validate payload nghiêm (bắt `oa_id` khớp OA của mình, bắt shape event); (c) IP allowlist nếu Zalo công bố dải IP chính thức.
  3. Chính sách resend của Zalo (retry bao nhiêu lần, khoảng cách) — quyết định tham số dedupe (mục 2).
- Ghi chú cho cả hai: webhook handler PHẢI chấp nhận tin nhận trùng, sai thứ tự, và event lạ (version mới của nền tảng) mà không crash — event không nhận diện được vẫn persist raw + status `FAILED(reason=unknown_type)` để phân tích sau, **không bao giờ 500 cho nền tảng** (500 → nền tảng resend → tự làm dơ dedupe).

---

## MỤC 2 — IDEMPOTENCY / DEDUPE

**Phân loại: USE — thiết kế cốt lõi, là điều kiện cần cho case 10/11/12.**

### 2.1 `event_id` — khóa chống trùng tầng nhận

```
event_id =
  nếu có id nền tảng ổn định  →  channel + ':' + platform_id
      (Meta message: mid; Meta comment: comment_id; postback: lấy m.id + timestamp;
       Zalo: msg_id / event_id trong payload — cần xác minh tên field, xem 1.4)
  nếu KHÔNG có id             →  channel + ':' + sha256(customer_ref + platform_timestamp + canonical(rawBody))
```

- `inbox_events.event_id` có **UNIQUE INDEX**. `INSERT ... ON CONFLICT DO NOTHING` → nếu conflict: kiểm tra status bản gốc:
  - `PROCESSED` → bỏ qua, trả 200, metric `dedupe_hit++` (nhẹ nhàng, đúng case 10).
  - `PROCESSING` hoặc `RECEIVED` (job còn chờ) → bỏ qua (job đã có trong `jobs`), trả 200.
  - Điểm mù thực tế: hai webhook trùng **nội dung** nhưng khác timestamp sẽ sinh `event_id` khác nhau nếu rơi vào nhánh hash — nên **ưu tiên tuyệt đối platform_id**; nhánh hash chỉ là phương án cuối. Điều này phụ thuộc id nền tảng có ổn định không → Meta mid ổn định (USE); Zalo msg_id CHƯA XÁC MINH (thêm vào danh sách 1.4).

### 2.2 Exactly-once HIỆU DỤNG cho side-effect (gửi tin / tạo đơn / tạo vận đơn)

"Exactly-once" thật với API ngoài là không thể; mục tiêu là **hiệu ứng bên ngoài xảy ra đúng 1 lần hoặc 0 lần có bằng chứng**:

```
Trước khi gọi API ngoài, BẮT BUỘC:
  INSERT INTO action_executions(exec_id, idempotency_key, status='INTENT', ...)
  → UNIQUE(idempotency_key)
  - Nếu conflict: ĐỪNG gọi. Đọc bản ghi cũ:
      DONE          → đã gửi rồi, tái sử dụng receipt, bỏ qua.
      INTENT/EXECUTING → vòng khác đang làm hoặc treo → tính theo timeout_at (mục 7).
  - Nếu insert thành công → mới EXECUTE, kèm idempotency_key cho API (Meta:
      dùng `client_message_id`? — CHƯA XÁC MINH cờ idempotency chính thức của
      Send API; biện pháp bù: quy ước 1 tin = 1 action_executions, retry bao giờ
      phải qua bước kiểm tra receipt trước — mục 7).
```

Hai tầng độc lập nhau: tầng **nhận** (event_id — chống resend webhook) và tầng **hành động** (idempotency_key — chống double-send/double-order khi retry, crash, hay AI xin chạy lại). Đội prototype cài cả hai, không gộp.

### 2.3 Thứ tự ghi chống mất mát

Quy tắc vàng reliability: **ghi trước, gọi sau** (write-ahead intent). Mọi thứ có thể fail (API ngoài, LLM) đều phải có dòng trạng thái trong DB TRƯỚC khi gọi, để crash bất kỳ lúc nào cũng còn đường dọn (reconcile) thay vì mò.

---

## MỤC 3 — DATABASE SCHEMA CHÍNH

**Phân loại: USE (cấu trúc bảng là thiết kế mới của AI-3, bám chặt yêu cầu audit chuỗi `event_id → conversation_id → customer_id → proposed_action → validation → execution_result → receipt`).**

Toàn bộ CREATE TABLE dạng text — **xem PHỤ LỤC A** ở cuối tài liệu (bản đầy đủ, đây là tóm tắt vai trò):

| Bảng | Vai trò |
|---|---|
| `customers` | Khách + PII tối thiểu, cờ `marketing_opt_out` |
| `conversations` | Hội thoại, `state` (state machine), `mode` (AI/HUMAN) |
| `inbox_events` | Log sự kiện nền tảng đã normalize + anchor dedupe |
| `messages` | Mọi tin in/out, receipt gửi tin |
| `products` / `product_variants` | SKU, giá, tồn kho, size/màu, ảnh (tồn kho đặt trên **variant**) |
| `orders` / `order_items` / `order_status_history` | Đơn + dòng hàng + snapshot giá/địa chỉ lúc validate + lịch sử trạng thái |
| `shipments` | Vận đơn theo ĐVVC |
| `ai_proposals` | Mọi lời AI đề xuất + evidence + kết quả validation |
| `action_executions` | Ledger side-effect: idempotency_key + trạng thái INTENT→DONE/FAILED/TIMEOUT_UNKNOWN |
| `audit_events` | Chuỗi audit bắt buộc của đề bài, có `receipt_json` |
| `jobs` | Queue persist + scheduler (run_at) + retry/backoff |
| `dead_letter_queue` | Việc chết sau N lần + cờ đã cảnh báo |
| `follow_ups` | Lịch chăm sóc sau bán |
| `settings` | Cấu hình (bot_enabled, chính sách) — **cấm chứa secret** |
| `operators` | Nhân viên (takeover, phân quyền) |
| `metrics_counters` | Đếm lỗi/theo dõi theo ngày (mục 10) |

### 3.1 Chính sách PII (ai được xem gì)

| Dữ liệu | DB | Dashboard (operator) | AI prompt | Log |
|---|---|---|---|---|
| platform_ref (PSID/user_id) | Có | Có | Có (cần để trả lời trong thread) | Có |
| Tên | Có | Có | Có | Có |
| **SĐT** | Có | Có | **Chỉ dạng mask `09xx***123`**; bản đầy đủ chỉ bước VALIDATE/EXECUTE tạo đơn lấy thẳng từ DB theo `customer_id` | **Cấm** — logger redact |
| **Địa chỉ** | Có | Có | Chỉ khi bước thu thập cần AI xác nhận → cho dạng rút gọn (quận/huyện, phường); bản đầy đủ chỉ qua DB tại VALIDATE | Cấm |
| app_secret / page token / OA token | **KHÔNG BAO GIỜ** (kể cả settings) | Không | Không | Không |

Nguyên tắc: **AI thao tác qua id, không qua PII thô.** Proposal của AI chứa `customer_id`, `variant_id`, số lượng — VALIDATE hợp nhất địa chỉ/phone từ DB. Vừa đúng "PII tối thiểu cho từng bước" vừa đúng "LLM không phải nguồn sự thật" (AI không thể bịa SĐT vì prompt không có SĐT để bịa).

---

## MỤC 4 — ACTION GATE (VALIDATE → AUTHORIZE → EXECUTE → VERIFY)

**Phân loại: USE — đúng như kiến trúc đích; phần dưới là hợp đồng chính xác để đội prototype cài.**

Mọi action **rời hệ thống** (gửi tin cho khách, tạo order, tạo vận đơn, tin follow-up/marketing) PHẢI đi qua `runGate()`. AI không có đường nào gọi API nền tảng ngoài hàm này (ràng buộc bằng cấu trúc code: chỉ gate import module gateway-gửi).

```pseudo
function runGate(proposal):                 // proposal đến từ ai_proposals hoặc tác vụ hệ thống
  # ---- 1. VALIDATE: dữ liệu từ DB, KHÔNG phải lời AI ----
  ctx = loadFreshFromDB(proposal)           // giá/tồn variant BÂY GIỜ, customer, conversation, settings
  v = {}
  với từng field mà proposal tuyên bố:
    v[field] = giá trị từ DB (override lời AI)   // giá → variants.price; tồn → stock còn lại;
                                                  // sku → map variant_id; địa chỉ/phone → customers
  nếu proposal.intent == 'SEND_REPLY' và chứa số liệu:
      thay toàn bộ số liệu trong text bằng giá trị đã validate (hoặc từ chối nếu không map được)
  nếu thiếu field bắt buộc (vd địa chỉ khi tạo đơn) → NEEDS_HUMAN hoặc hỏi lại khách (case 7)
  # ---- 2. AUTHORIZE ----
  nếu settings.bot_enabled == false                          → REJECT('bot_off')
  nếu conversation.mode == 'HUMAN' (đang takeover)            → REJECT('takeover')   // case 15
  nếu action là marketing/follow-up và customer.marketing_opt_out == 1 → REJECT('opt_out')  // case 18
  nếu state machine không cho phép chuyển tiếp này            → REJECT('bad_state')
  nếu conversation vi phạm rate-limit gửi tin (chống loop)     → REJECT('rate_limit')
  # ---- 3. EXECUTE: ghi intent TRƯỚC, idempotency key ----
  key = actionType + ':' + idEMP(proposal)   // ví dụ 'send:'+conversation_id+':'+sha256(text+variant_confirm)
  INSERT action_executions(status='INTENT', idempotency_key=key) ON CONFLICT → bỏ qua (đã làm rồi)
  result = callExternal(proposal, key)        // gọi API nền tảng/ĐVVC NGOÀI mọi DB transaction
  update action_executions → DONE|FAILED|TIMEOUT_UNKNOWN (kèm receipt nếu có)
  # ---- 4. VERIFY: đọc kết quả thật, không tin lời tự khai ----
  với SEND_MESSAGE: chờ/motionEvent delivery_receipt từ webhook, hoặc poll API trạng thái tin
                    → messages.delivery_status = DELIVERED|FAILED|UNKNOWN
  với CREATE_SHIPMENT: getStatus(order_code) xác nhận vận đơn tồn tại thật trước khi báo khách
  với CREATE_ORDER: xác nhận orders.status chuyển CONFIRMED trong DB (nguồn trong nhà)
  INSERT audit_events(stage='VERIFIED', receipt_json=...)    // đóng chuỗi audit của đề bài
```

Quy ước quan trọng:
- **Kết quả VERIFY lấy từ nguồn ngoài/webhook, KHÔNG nhận "AI nói đã gửi" làm bằng chứng** — đúng điều cấm trong 00-yeu-cau ("KHÔNG dùng nội dung AI tự khai làm evidence thực thi").
- Gate REJECT luôn ghi `audit_events(stage='AUTHORIZED', detail={decision:'REJECT', reason})` + metric `gate_rejected_<reason>` — để case 8/18 assert được.

---

## MỤC 5 — ORDER ENGINE (tồn kho, race, case 9)

**Phân loại: USE (chỉ đạo tổng "chốt lúc validate lại bằng giá trị DB mới nhất") — thiết kế 2 pha DRAFT→CONFIRMED.**

### 5.1 Hai pha

```
Pha A — ĐẶT GIỮ khi khách có ý mua rõ (state → COLLECT_ORDER):
  BEGIN IMMEDIATE
    với từng variant trong giỏ:
      row = SELECT stock_qty, stock_reserved FROM product_variants WHERE variant_id=?
      nếu stock_qty - stock_reserved < qty  → ROLLBACK → trả 'OUT_OF_STOCK' cho AI đề xuất phương án khác
    UPDATE product_variants SET stock_reserved = stock_reserved + qty
    INSERT orders(status='DRAFT', price_snapshot, address_snapshot) + order_items
  COMMIT
  → (ngoài tx) gate gửi tin xác nhận cho khách

Pha B — CHỐT khi khách xác nhận (state VALIDATE → CONFIRM):
  BEGIN IMMEDIATE        // RE-VALIDATE bằng giá trị DB MỚI NHẤT — đúng mệnh lệnh đề bài
    re-read stock + giá từng variant; re-check địa chỉ/phone đủ
    nếu hết/hụt hàng hoặc giá đổi → ROLLBACK pha B
      → trả kết quả cho AI: PROPOSE (xin ý khách chọn phương án khác) — không tự chốt thay khách
    nếu OK:
      UPDATE product_variants SET stock_reserved = stock_reserved - qty,
                                   stock_qty       = stock_qty       - qty
      UPDATE orders SET status='CONFIRMED', total=...
  COMMIT
  → (ngoài tx) tạo vận đơn (mục 6) + audit_events
```

### 5.2 Race 2 đơn cùng lúc (nội bộ)

SQLite **single-writer**: `BEGIN IMMEDIATE` xếp 2 transaction thành hàng tuần tự; check-and-reserve nằm trong cùng tx nên không oversell được. Trong tiến trình Node (driver đồng bộ) cũng không có interleaving. Dùng thêm ràng buộc `CHECK (qty > 0)` và `CHECK (stock_reserved >= 0 AND stock_qty >= 0)` làm lưới an toàn cuối.

### 5.3 Giới hạn đặt giữ

`stock_reserved` là con nợ: phải có **hết hạn** — job scheduler (mục 8) mỗi giờ quét `orders WHERE status='DRAFT' AND created_at < now-24h` → hủy đơn + hoàn reserve (`stock_reserved -= qty`), audit `CANCELLED(reason='draft_timeout')`. Không có cơ chế này, tồn kho hiệu dụng sẽ bò dần về 0.

### 5.4 Đơn vị tiền

`INTEGER` (VND nguyên), cấm float — tổng = SUM(line_total) tính trong transaction, không để AI/JS cộng lẻ.

---

## MỤC 6 — SHIPPING ADAPTER INTERFACE

**Phân loại: ADAPT (đề bài yêu cầu đúng hướng "API chính thức khi khả dụng") — Phase-1 chỉ interface + mock; GHN/GHTK/J&T/ViettelPost là CHƯA XÁC MINH (chưa có key/spec thời điểm thiết kế).**

```ts
interface ShippingAdapter {
  readonly carrier: 'ghn'|'ghtk'|'jt'|'viettelpost'|'mock';

  // BẮT BUỘC nhận idempotencyKey — adapter có trách nhiệm chống tạo trùng vận đơn
  createShipment(req: {
    idempotencyKey: string;        // = 'shipment:' + order_id
    clientOrderCode: string;       // = orders.order_code — dùng tra cứu lại khi API không hỗ trợ idempotency
    order: { items: {sku, name, qty, weight?}[]; codAmount: number;
             receiver: {name, phone, address}; note?: string };
  }): Promise<{ status:'CREATED'|'ALREADY_EXISTS'|'REJECTED'|'ERROR',
                trackingNumber?: string; fee?: number; raw?: unknown }>;

  getStatus(trackingNumber: string): Promise<{
    status:'PICKED_UP'|'IN_TRANSIT'|'DELIVERED'|'RETURNED'|'FAILED'|'UNKNOWN';
    at?: string; raw?: unknown }>;

  // Nếu ĐVVC có webhook trạng thái → chuẩn hóa về ShipmentStatusUpdate, không thì poll
  parseWebhook?(rawBody: unknown, headers: Record<string,string>): ShipmentStatusUpdate | null;
}
```

- **MockAdapter (Phase-1)**: tạo mã vận đơn giả `MOCK-<order_code>`, cấu hình được độ trễ/ty lệ lỗi/webhook giả → phục vụ trực tiếp case 11, 12, 17 (timeout, idempotency, follow-up sau giao).
- Quy tắc bắt buộc mọi adapter thật (ghi vào interface): nếu ĐVVC không có idempotency chính thức → adapter **tra cứu theo `clientOrderCode` trước khi create** (gọi API search-by-code; có rồi thì thôi, không thì mới create). Điều này là phòng tuyến chính cho case 12.
- Cần xác minh khi có key: spec idempotency của từng ĐVVC, API tra cứu theo mã đối tác, bảng mã trạng thái → map về enum chung ở trên.

---

## MỤC 7 — RETRY / DEAD-LETTER (timeout "không biết thành công")

**Phân loại: USE — đây là design trực tiếp cho case 11, 12. Nguyên tắc: CẤM retry mù.**

### 7.1 Ba tình huống gửi tin

| Kết quả gọi API | Nghĩa | Hành động |
|---|---|---|
| Response 2xx | Chắc chắn đã nhận | Ghi receipt, DONE |
| Response 4xx/5xx rõ ràng | Chắc chắn THẤT BÁI (4xx gần như không retry; 5xx retry được) | FAILED → retry có backoff (5xx) |
| **Timeout / network error** | **KHÔNG BIẾT** | `TIMEOUT_UNKNOWN` — KHÔNG được gửi lại ngay |

### 7.2 Chiến lược TIMEOUT_UNKNOWN (đúng đề bài: idempotency key + kiểm tra receipt)

```
1. action_executions.status = 'TIMEOUT_UNKNOWN', timeout_at = now + 60s
2. Đặt job 'check_receipt' (run_at = timeout_at, attempts ≤ 3):
   - Gửi: hỏi trạng thái theo bằng chứng sẵn có
       Meta: chờ webhook 'delivery'/'read' cho mid; hoặc đọc lại luồng hội thoại bằng API để tìm mid
             (cơ chế đọc-lại CHƯA XÁC MINH với Send API hiện hành — đưa vào checklist prototype)
       Zalo: API lấy trạng thái tin nhắn nếu có — CHƯA XÁC MINH
       ĐVVC: getStatus(clientOrderCode) — có chắc chắn
   - Thấy bằng chứng ĐÃ GỬI/ĐÃ TẠO → DONE + receipt. Thấy chắc chắn CHƯA → retry an toàn (dùng lại idempotency key).
3. Không phân định được sau 3 lần check → retry lần cuối CÓ ĐIỀU KIỆN:
     chỉ với SEND_MESSAGE chỉ-khi-chưa-có-bằng-chứng-gửi, và chấp nhận rủi ro nhân bản
     TỐI ĐA 1 lần; với CREATE_ORDER/CREATE_SHIPMENT: KHÔNG BAO GIỜ retry không bằng chứng —
     chuyển thẳng DLQ (tạo trùng đơn/vận đơn tệ hơn hơn bỏ sót 1 đơn).
4. Quá hạn mức (max_attempts, backoff 2s→8s→30s→2m→10m, có jitter):
   → INSERT dead_letter_queue + metric dlq_count++
   → CẢNH BÁO: dashboard badge + thông báo chủ shop (kênh phụ, KHÔNG dùng chính kênh đang hỏng)
   → conversation.mode = 'HUMAN' (human takeover) nếu việc chết là gửi tin cho khách đang chờ
   → audit_events(stage='FAILED', detail={dlq_id, reason})
```

Lý do con người phải vào vòng: hệ thống đã hết chứng cứ, quyết định "gửi lại hay bỏ" khi gặp khách thật là quyết định kinh doanh — không automation mù được.

---

## MỤC 8 — SCHEDULER

**Phân loại: USE. Một bảng `jobs` + một vòng tick, phục vụ đủ 3 nhóm việc đề bài nêu.**

```
tick mỗi 5s (trong tiến trình chính, sau khi webhook server đã sẵn sàng):
  due = SELECT * FROM jobs
        WHERE status='QUEUED' AND run_at <= now
        ORDER BY run_at LIMIT 10;
  với từng job: UPDATE ... SET status='RUNNING' (claim) → chạy handler → DONE
        lỗi   → attempts++ ; attempts < max_attempts ? run_at = now + backoff(attempts), status='QUEUED'
                                                     : status='DEAD' + DLQ (mục 7)
  crash giữa RUNNING → restart quét: jobs RUNNING mà updated_at cũ > 5 phút → trả về QUEUED (lease timeout)
```

Việc định kỳ của scheduler (đều là job `run_at` tương lai, tự tái đặt):

| Job | Điều kiện | Việc | Case |
|---|---|---|---|
| `followup_after_delivery` | shipment → DELIVERED | tạo `follow_ups` scheduled_at = +2 ngày; đến hẹn → qua gate gửi (check opt-out) | 17, 18 |
| `expire_draft_order` | orders DRAFT > 24h | hủy + hoàn stock_reserved | 5.3 |
| `kill_stale_session` | hội thoại chờ khách (COLLECT_ORDER/BUY_INTENT) > X giờ | nhắc lịch sự 1 lần rồi đóng về NEW_LEAD; KHÔNG spam | — |
| `stuck_order_reminder` | đơn ở trạng thái gửi/transport > ngưỡng | poll getStatus, treo lại, báo nếu lạ | — |
| `check_receipt` | action TIMEOUT_UNKNOWN | mục 7.2 | 11, 12 |

---

## MỤC 9 — CREDENTIAL VAULT

**Phân loại: USE — điều BẮT BUỘC của đề bài ("Token KHÔNG BAO GIỜ vào prompt/model context"). Thiết kế theo lớp:**

1. **Nơi lưu duy nhất**: file `.env` (gitignored, có `.env.example` không giá trị) cho lab; tùy chọn nâng cấp Windows Credential Manager qua module keyring nếu chủ muốn (`O.keyring`). DB **không có cột nào** chứa secret; bảng `settings` bị cấm đặt secret (review khi merge).
2. **Một module duy nhất được đọc**: `secrets.js` — expose `getPageToken()`, `getZaloOAToken()`, `getAppSecret()`, `getCarrierKey(carrier)`. Các module khác không được `process.env` trực tiếp (chỉ `secrets.js` và bootstrap được phép) — kiểm tra bằng một unit test quét import/regex, chạy trong CI của prototype.
3. **Gateway là nơi duy nhất chạm token khi gửi**: module gửi tin/vận đơn nhận token **làm tham số tại thời điểm gọi cuối**, không giữ tham chiếu lâu, không cache ra đĩa.
4. **Prompt builder bị cắt nguồn**: hàm dựng prompt cho LLM không import `secrets.js` (bằng cấu trúc code + test). Trước khi gửi prompt ra model API, chạy filter cuối: regex phát hiện pattern token (`EAAG...`, `access_token=`, `Bearer `, SĐT VN) → chặn + metric `leak_blocked++`.
5. **Log redaction**: middleware logger replace mọi chuỗi khớp giá trị secret đã nạp (giữ map giá trị→`***`) và số điện thoại. Quy tắc log: không log header `Authorization`, không log raw body của request đi RA (chỉ log metadata + event_id).
6. Token Zalo/FB có hạn → refresh do gateway giữ, refresh cũng qua secrets module; không ai khác refresh.

---

## MỤC 10 — OBSERVABILITY TỐI GIẢN PHASE-1

**Phân loại: USE (ADAPT từ "dashboards" trong đề: Phase-1 dashboard = query SQL có sẵn, không dựng stack metrics).**

1. **Structured log JSONL**: một dòng/từng entry: `{"ts","level","component","trace_id","event_id?","conversation_id?","msg","err_type?","latency_ms?"}`. `trace_id = conversation_id` cho luồng chat, `event_id` cho luồng webhook — tìm được trọn vẹn hành trình 1 khách/1 sự kiện bằng grep. Ghi stdout + `logs/app-YYYYMMDD.jsonl` (xoay theo ngày).
2. **Đếm lỗi theo loại** — bảng `metrics_counters(metric, day, value)`: `webhook_auth_fail`, `dedupe_hit`, `gate_rejected_<reason>`, `send_timeout`, `send_failed`, `order_create_timeout`, `dlq_count`, `ai_low_confidence`, `leak_blocked`. Increment là 1 UPDATE đơn giản (upsert) — không cần thư viện metrics.
3. **Dashboard Phase-1** đọc thẳng các bảng đã có trong schema (không bảng mới, không Redis, không Prometheus):
   - **Đơn**: `orders` group by `status`, `date(created_at)`; tồn kho hiệu dụng = `stock_qty - stock_reserved`.
   - **Tin**: `messages` group by `sender`, `delivery_status`, ngày.
   - **Lỗi**: `metrics_counters` hôm nay + `dead_letter_queue WHERE alerted=0` + `audit_events WHERE stage='FAILED'` + jobs `status='DEAD'`.
4. Healthcheck `GET /health` (DB open được + tick scheduler còn nhảy + số job QUEUED) — đủ để chủ shop biết hệ thống sống.

---

## MỤC 11 — THIẾT KẾ CHI TIẾT 18 CASE TEST (spec cho đội prototype)

Chuỗi tầng dùng lại trong toàn mục này: **GW** (gateway: verify→persist→200) → **DED** (dedupe) → **WRK** (worker: normalize + lưu message + cập nhật conversation) → **AI** (understand → propose) → **GATE** (validate→authorize→execute→verify) → **AUD** (audit/metrics/log). Mọi case chạy trên DB SQLite riêng của test (mỗi test = DB mới), MockAdapter + mock nền tảng (không gọi Meta/Zalo thật).

### Case 1 — Khách hỏi giá
- **Input mô phỏng**: POST webhook Meta (đã ký HMAC đúng) chứa message text `"cái này bao nhiêu vậy shop"`, PSID=P1; DB có variant V1 giá 250000.
- **Luồng**: GW→DED→WRK→AI(intent=PRICE_QUERY, trích SKU/variant từ text hoặc ngữ cảnh hội thoại)→GATE(VALIDATE: giá lấy từ `product_variants.price`)→GATE(EXECUTE send)→AUD.
- **Kỳ vọng**: AI không được phát ra số giá của riêng nó — text gửi đi chứa `250000` lấy từ DB.
- **Assert**: (a) HTTP 200 < 200ms; (b) `inbox_events` 1 dòng PROCESSED; (c) `messages` có tin in + tin out (sender='ai'); (d) `ai_proposals.validation_json.price.source='product_variants'`; (e) text out khớp giá DB; (f) `action_executions` đúng 1 dòng DONE có receipt; (g) chuỗi audit đủ 5 stage.

### Case 2 — Khách hỏi size/màu
- **Input**: text `"còn size M màu đỏ không?"`; DB: V-M-ĐỎ stock 3, V-M-XANH 0.
- **Luồng**: như case 1, AI propose reply danh sách size/màu + tồn hiệu dụng (`stock_qty - stock_reserved`).
- **Assert**: tin out liệt kê đúng biến thể từ DB (M-đỏ còn, theo số liệu DB lúc validate); nếu hỏi biến thể không tồn tại → trả lời không có + không bịa biến thể; audit VALIDATE ghi snapshot tồn kho.

### Case 3 — Ảnh "còn cái này không?"
- **Input**: message attachment image + caption; DB có ảnh sản phẩm tương ứng (dùng mock vision: hàm `matchImage→variant_id` cắm được).
- **Luồng**: GW→WRK (tải media về `data/media/`, ghi `local_path`)→AI vision (mock) propose variant_id→GATE VALIDATE tồn kho DB.
- **Kỳ vọng**: hệ thống trả lời tồn/không theo đúng variant khớp ảnh.
- **Assert**: `messages.attachment_json.local_path` tồn tại trên đĩa; `ai_proposals.evidence_json` chứa `matched_variant_id` + điểm match; nếu điểm < ngưỡng → decision NEEDS_HUMAN, KHÔNG tự trả; log không chứa token tải media. **CHƯA XÁC MINH**: độ chính xác vision thật — prototype phải đo trên bộ ảnh mẫu trước khi mở auto.

### Case 4 — Khách gửi voice
- **Input**: message attachment audio (Zalo voice hoặc FB audio).
- **Luồng**: GW→WRK tải media→ASR (mock trong test; thật = CHƯA XÁC MINH chọn provider)→các tầng sau như text.
- **Assert**: transcript lưu vào `messages.text_content` (kèm cờ `from_asr=true`); luồng downstream nhận text như thường; token ASR không xuất hiện trong log/prompt; nếu ASR fail → NEEDS_HUMAN, không đoán.

### Case 5 — Đổi sản phẩm giữa hội thoại
- **Input**: hội thoại dần dần: hỏi V1 → chốt V1 (DRAFT tạo, reserve 1) → tin mới `"thôi lấy cái kia đi"` (V2).
- **Luồng**: WRK cập nhật state machine (PRODUCT_QA→COLLECT_ORDER); AI propose CREATE_ORDER mới cho V2; order engine Pha A: hủy/nay phụ chính sách — **thiết kế chọn**: DRAFT cũ bị thay → scheduler `expire_draft_order` chạy sớm (hủy DRAFT cũ + hoàn reserve V1) rồi tạo DRAFT mới V2.
- **Assert**: sau đổi: `stock_reserved` V1 về 0, V2 +1; chỉ 1 orders DRAFT active cho conversation (assert bằng query status='DRAFT' active); audit có 2 chuỗi (hủy cũ, tạo mới); tin xác nhận cho khách nói đúng sản phẩm mới.

### Case 6 — Mua nhiều SKU
- **Input**: text ngỏ ý mua V1 x2 + V3 x1 + cung cấp đủ tên/SĐT/địa chỉ.
- **Luồng**: order engine Pha A: check từng variant trong 1 transaction; Pha B sau khi khách confirm.
- **Assert**: `order_items` ≥ 2 dòng đúng qty; `stock_qty` V1 -2, V3 -1 sau CONFIRMED; tổng = SUM(line_total) (số nguyên VND); nếu 1 trong các variant hết → TOÀN BỘ transaction roll back (không tạo đơn nửa vời), AI đề xuất phương án.

### Case 7 — Thiếu địa chỉ
- **Input**: khách đưa tên + SĐT + "lấy V1 size M" nhưng không địa chỉ.
- **Luồng**: AI propose CREATE_ORDER→GATE VALIDATE fail field `address`→ decision: KHÔNG tạo đơn, propose reply hỏi địa chỉ (tin hỏi được gửi qua gate).
- **Assert**: **không có** dòng `action_executions` loại CREATE_ORDER ở DONE; orders không có dòng CONFIRMED/DRAFT cho turn này; tin out chứa câu hỏi thiếu địa chỉ; conversation state vẫn COLLECT_ORDER.

### Case 8 — AI định báo sai giá
- **Input**: dựng proposal "độc" (giả lập AI trả giá 150000 khi DB là 250000) bơm thẳng vào GATE + cả đường đầy đủ.
- **Luồng**: GATE VALIDATE so text số liệu với DB → override/reject.
- **Assert**: tin khách nhận chứa 250000; `ai_proposals.decision` thể hiện override; audit VALIDATE có `detail.overridden_fields=['price']`; metric `gate_rejected_price_mismatch`++ (hoặc `gate_override`++); đường đầy đủ: kết quả cuối KHÔNG khác đường gate-thuần (chứng minh AI không có quyền chốt số liệu).

### Case 9 — Tồn kho hết giữa chat và chốt
- **Input**: V1 stock=1 lúc khách hỏi; TRƯỚC khi khách chốt, test can thiệp: chạy orders Pha A từ "khách khác" (hoặc UPDATE trực tiếp) làm stock=0.
- **Luồng**: khách chốt → Pha B BEGIN IMMEDIATE re-validate → hết → rollback → AI propose phương án (hết hàng, gợi ý thay thế).
- **Assert**: không có orders CONFIRMED cho V1; `stock_qty >= 0` (không oversell — assert toàn cột sau test); tin out báo hết hàng đúng variant; audit có stage VALIDATED với fail reason=out_of_stock; hội thoại chuyển trạng thái hợp lệ (không kẹt).

### Case 10 — Webhook DUPLICATE
- **Input**: POST cùng raw body Meta **2 lần** (byte-đối-byte, chữ ký như nhau).
- **Luồng**: GW: lần 1 insert inbox_events + jobs; lần 2 `ON CONFLICT DO NOTHING` → 0 dòng mới.
- **Assert**: cả 2 lần HTTP 200 (lần 2 nhanh < 50ms); `inbox_events` chỉ 1 dòng; `messages` in chỉ 1; AI trả lời ĐÚNG 1 lần (`action_executions` send = 1 DONE); metric `dedupe_hit` = 1. Biến thể: Zalo trùng theo msg_id (mock) — cùng assert.

### Case 11 — Timeout sau khi gửi message
- **Input**: MockGateway send: nhận request rồi treo, không trả (client timeout 10s).
- **Luồng**: GATE EXECUTE → timeout → `action_executions.status=TIMEOUT_UNKNOWN`, job `check_receipt` đặt → mock rồi phát delivery_receipt (webhook giả) hoặc poll mock ra "đã nhận".
- **Assert**: sau timeout, KHÔNG có tin gửi thứ 2; receipt về → status DONE, `messages.delivery_status=DELIVERED`, `receipt_json` có mid; khách nhận ĐÚNG 1 tin. Biến thể xấu: mock không bao giờ xác nhận → 3 lần check → DLQ + `conversation.mode='HUMAN'` + cảnh báo; assert `dead_letter_queue` có dòng, operator thấy alert.

### Case 12 — Tạo order timeout (cấm tạo lại mù)
- **Input**: MockAdapter.createShipment treo/timeout; sau đó job reconcile tra cứu theo `clientOrderCode` → mock trả ALREADY_EXISTS (lần đầu thực ra thành công) — và biến thể "chưa tồn tại".
- **Luồng**: GATE EXECUTE timeout → TIMEOUT_UNKNOWN → reconcile `getStatus/search by order_code` → ALREADY_EXISTS → DONE với tracking cũ.
- **Assert**: DB `shipments` chỉ 1 dòng cho order; nhà mock nhận ĐÚNG 1 lần createShipment; biến thể chưa-tồn-tại → retry dùng lại `idempotency_key='shipment:'+order_id` thành công 1 lần; KHÔNG có kịch bản nào sinh 2 vận đơn. (Đơn nội bộ trong DB không dùng API ngoài → không rơi case này; đây là tạo vận đơn/tạo đơn trên hệ thống ĐVVC.)

### Case 13 — Khách khiếu nại
- **Input**: tin `"đơn tao 2 tuần rồi chưa thấy đâu, lừa đảo à?"` (mock classifier: intent=COMPLAINT, confidence cao).
- **Luồng**: WRK→AI classify→policy: KHÔNG auto-reply giải quyết; chỉ tin an ủi mẫu (template, qua gate) + `conversations.mode='HUMAN'` + alert operator + hủy các follow-up marketing đang chờ của conversation.
- **Assert**: mode=HUMAN có actor=system(reason=complaint); không có AI action bán hàng nào sau đó (case 15 đè); `follow_ups` status=CANCELLED; tin out duy nhất là template an ủi (nội dung không hứa hẹn bồi thường).

### Case 14 — Không đủ evidence → không đoán
- **Input**: `"cái này dùng cho bé 3 tháng được không?"` — DB không có field độ tuổi; mock AI trả proposal với confidence thấp / thiếu evidence.
- **Luồng**: GATE/AI policy: confidence < ngưỡng hoặc evidence rỗng → decision NEEDS_HUMAN → không auto-send; hoặc reply an toàn mẫu ("em kiểm tra và báo anh/chị nhé").
- **Assert**: tuyệt đối không có tin out chứa khẳng định/bịa về thuộc tính sản phẩm (assert bằng từ khóa + so với danh sách câu trả lời an toàn được phép); audit NEEDS_HUMAN; metric `ai_low_confidence`++; operator có việc trong dashboard (worklist NEEDS_HUMAN).

### Case 15 — Human takeover
- **Input**: operator bấm takeover (dashboard) tại hội thoại đang AI; ngay sau đó khách nhắn tiếp.
- **Luồng**: dashboard → `conversations.mode='HUMAN', human_agent=op1` + hủy jobs AI đang chờ của conversation; tin khách sau đó: WRK lưu tin nhưng AI worker skip (chỉ lưu + gợi ý, không propose auto-send).
- **Assert**: sau takeover không có tin sender='ai' mới; tin của nhân viên (sender='human_agent') gửi được qua gateway bình thường (qua gate nhưng AUTHORIZE cho phép mode HUMAN với actor người); audit có dòng takeover (ai, lúc nào, từ đâu); jobs AI pending của conversation bị hủy sạch (assert không còn QUEUED cho conversation đó).

### Case 16 — Trả quyền lại cho AI
- **Input**: operator bấm handback sau khi xử lý xong.
- **Luồng**: `mode='AI', handback_at=now`; state machine đọc trạng thái hiện hành (nhân viên có thể đã chuyển state — handback giữ nguyên state, không reset về đầu); AI context builder nạp toàn bộ lịch sử gồm cả tin nhân viên.
- **Assert**: tin khách kế tiếp được AI propose lại (audit PROPOSED xuất hiện mới); state không bị reset về NEW_LEAD; tin AI gửi đi có tham chiếu đúng ngữ cảnh sau can thiệp người (assert nội dung không mâu thuẫn cam kết nhân viên vừa đưa — kiểm tra mẫu).

### Case 17 — Follow-up sau giao hàng
- **Input**: mock MockAdapter.getStatus → DELIVERED (hoặc webhook giả ĐVVC).
- **Luồng**: shipment DELIVERED → scheduler tạo `follow_ups(scheduled_at=+2d)` → đến hẹn job → GATE (AUTHORIZE check opt-out) → send.
- **Assert**: `follow_ups` 1 dòng → SENT đúng 1 lần; tin out đúng hẹn (± window tick); nếu trước giờ hẹn khách opt-out → status CANCELLED (dính case 18); audit đủ chuỗi cho tin follow-up.

### Case 18 — Khách từ chối marketing
- **Input**: tin `"đừng nhắn quảng cáo cho tôi nữa"` (mock classify intent=OPT_OUT_MARKETING, confidence cao).
- **Luồng**: WRK nhận diện opt-out signal → `customers.marketing_opt_out=1, opt_out_at` → scheduler hủy mọi follow_ups marketing của customer → mọi proposal marketing sau này: GATE AUTHORIZE reject.
- **Assert**: cờ DB đúng; mọi `follow_ups` marketing đang SCHEDULED → CANCELLED(cancel_reason='opt_out'); đề case 17 lại với customer này → job đến hẹn bị AUTHORIZE chặn, metric `gate_rejected_opt_out`++, KHÔNG có tin đi ra; tin giao dịch (xác nhận đơn/đã giao của đơn đang chạy) **vẫn được phép** (assert 1 tin transactional đi được); audit ghi event opt-out (thuộc dẫn chứng khiếu nại nếu bị spam).

---

## PHỤ LỤC A — SCHEMA SQL (dạng text, Phase-1)

```sql
-- SQLite, WAL. Giờ = TEXT ISO-8601 UTC. Boolean = INTEGER 0/1. Tiền = INTEGER VND.
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS customers (
  customer_id        TEXT PRIMARY KEY,                 -- 'cus_' + ULID
  channel            TEXT NOT NULL CHECK (channel IN ('facebook','zalo')),
  platform_ref       TEXT NOT NULL,                    -- PSID (fb) | user_id (zalo)
  display_name       TEXT,
  full_name          TEXT,                             -- PII: tên thật khi chốt đơn
  phone              TEXT,                             -- PII: không vào prompt (mask), không vào log
  address            TEXT,                             -- PII: JSON {line, ward, district, city}
  marketing_opt_out  INTEGER NOT NULL DEFAULT 0,
  opt_out_at         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (channel, platform_ref)
);

CREATE TABLE IF NOT EXISTS conversations (
  conversation_id    TEXT PRIMARY KEY,                 -- channel + ':' + thread_id
  channel            TEXT NOT NULL,
  customer_id        TEXT NOT NULL REFERENCES customers(customer_id),
  platform_thread_id TEXT NOT NULL,
  state              TEXT NOT NULL DEFAULT 'NEW_LEAD', -- NEW_LEAD|DISCOVERY|PRODUCT_QA|BUY_INTENT|COLLECT_ORDER|VALIDATE|CONFIRM|ORDERED|SHIPPING|AFTER_SALES
  mode               TEXT NOT NULL DEFAULT 'AI',       -- 'AI' | 'HUMAN' (takeover)
  human_agent        TEXT,                             -- operator_id đang takeover
  handback_at        TEXT,
  last_activity_at   TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  UNIQUE (channel, platform_thread_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_state ON conversations(state);

CREATE TABLE IF NOT EXISTS inbox_events (               -- raw + normalized; anchor dedupe tầng nhận
  event_seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT NOT NULL UNIQUE,
  channel         TEXT NOT NULL,
  type            TEXT NOT NULL,                        -- message|comment|postback|opt_out_signal|delivery_receipt|read_receipt|unknown
  conversation_id TEXT,
  customer_ref    TEXT,
  raw_body        TEXT NOT NULL,
  normalized_json TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'RECEIVED',     -- RECEIVED|PROCESSING|PROCESSED|FAILED
  fail_reason     TEXT,
  received_at     TEXT NOT NULL,
  processed_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_conv ON inbox_events(conversation_id, received_at);

CREATE TABLE IF NOT EXISTS messages (
  message_id            TEXT PRIMARY KEY,               -- platform mid, hoặc 'msg_'+ULID cho tin mình gửi
  conversation_id       TEXT NOT NULL REFERENCES conversations(conversation_id),
  direction             TEXT NOT NULL CHECK (direction IN ('in','out')),
  sender                TEXT NOT NULL CHECK (sender IN ('customer','ai','human_agent','system')),
  kind                  TEXT NOT NULL,                  -- text|image|voice|sticker|fallback
  text_content          TEXT,
  attachment_json       TEXT,                           -- [{type, platform_url, local_path, from_asr}]
  platform_message_id   TEXT UNIQUE,                    -- mid/msg_id của tin out (đối chứng receipt)
  send_exec_id          TEXT,                           -- FK mềm -> action_executions.exec_id
  created_at            TEXT NOT NULL,
  delivery_status       TEXT,                           -- in: NULL; out: SENT|DELIVERED|READ|FAILED|UNKNOWN
  receipt_json          TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS products (
  product_id   TEXT PRIMARY KEY,                        -- 'prd_' + ULID
  sku_base     TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  description  TEXT,
  images_json  TEXT NOT NULL DEFAULT '[]',
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_variants (
  variant_id     TEXT PRIMARY KEY,                      -- 'var_' + ULID
  product_id     TEXT NOT NULL REFERENCES products(product_id),
  sku            TEXT NOT NULL UNIQUE,
  size           TEXT,
  color          TEXT,
  price          INTEGER NOT NULL CHECK (price >= 0),
  stock_qty      INTEGER NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  stock_reserved INTEGER NOT NULL DEFAULT 0 CHECK (stock_reserved >= 0),
  image_url      TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_var_product ON product_variants(product_id);

CREATE TABLE IF NOT EXISTS orders (
  order_id            TEXT PRIMARY KEY,                 -- 'ord_' + ULID
  order_code          TEXT NOT NULL UNIQUE,             -- mã hiển thị, sinh 1 lần, dùng tra cứu ĐVVC
  conversation_id     TEXT REFERENCES conversations(conversation_id),
  customer_id         TEXT NOT NULL REFERENCES customers(customer_id),
  status              TEXT NOT NULL,                    -- DRAFT|CONFIRMED|SENT_TO_CARRIER|SHIPPING|DELIVERED|CANCELLED|FAILED
  subtotal            INTEGER NOT NULL DEFAULT 0,
  shipping_fee        INTEGER NOT NULL DEFAULT 0,
  total               INTEGER NOT NULL DEFAULT 0,
  address_snapshot    TEXT NOT NULL,                    -- JSON PII chốt lúc validate
  price_snapshot_json TEXT NOT NULL,                    -- [{variant_id, sku, qty, unit_price}]
  idempotency_key     TEXT UNIQUE,                      -- 'order:'+conversation_id+':'+hash(giỏ)
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);

CREATE TABLE IF NOT EXISTS order_items (
  item_id      TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders(order_id),
  variant_id   TEXT NOT NULL REFERENCES product_variants(variant_id),
  sku_snapshot TEXT NOT NULL,
  qty          INTEGER NOT NULL CHECK (qty > 0),
  unit_price   INTEGER NOT NULL,
  line_total   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS order_status_history (
  history_id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   TEXT NOT NULL REFERENCES orders(order_id),
  from_status TEXT, to_status TEXT NOT NULL,
  actor      TEXT NOT NULL,                             -- ai|human|system|carrier
  reason     TEXT,
  at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shipments (
  shipment_id            TEXT PRIMARY KEY,
  order_id               TEXT NOT NULL REFERENCES orders(order_id),
  carrier                TEXT NOT NULL,                 -- ghn|ghtk|jt|viettelpost|mock
  carrier_order_code     TEXT,
  tracking_number        TEXT,
  status                 TEXT NOT NULL DEFAULT 'CREATED', -- CREATED|PICKED_UP|IN_TRANSIT|DELIVERED|RETURNED|FAILED
  request_idempotency_key TEXT UNIQUE,                  -- 'shipment:'+order_id
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_proposals (
  proposal_id     TEXT PRIMARY KEY,                     -- 'prp_' + ULID
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  turn_message_id TEXT,                                 -- tin khách dẫn đến đề xuất
  intent          TEXT NOT NULL,                        -- SEND_REPLY|CREATE_ORDER|CREATE_SHIPMENT|FOLLOW_UP|OPT_OUT_MARKETING
  proposal_json   TEXT NOT NULL,                        -- tham số AI đề xuất (id, không PII thô)
  evidence_json   TEXT,                                 -- dẫn chứng DB/messages AI dựa vào
  confidence      REAL,
  validation_json TEXT,                                 -- kết quả VALIDATE từng field + giá trị DB
  decision        TEXT NOT NULL,                        -- AUTO_EXECUTED|NEEDS_HUMAN|REJECTED_BY_GATE|OVERRIDDEN
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prp_conv ON ai_proposals(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS action_executions (          -- ledger side-effect: exactly-once hiệu dụng
  exec_id         TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  action_type     TEXT NOT NULL,                        -- SEND_MESSAGE|CREATE_ORDER_INTERNAL|CREATE_SHIPMENT|FOLLOW_UP_MSG
  ref_type        TEXT, ref_id TEXT,                    -- orders.order_id / shipments.shipment_id / messages.message_id
  status          TEXT NOT NULL DEFAULT 'INTENT',       -- INTENT|EXECUTING|DONE|FAILED|TIMEOUT_UNKNOWN|ROLLED_BACK
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  timeout_at      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exec_status ON action_executions(status, timeout_at);

CREATE TABLE IF NOT EXISTS audit_events (               -- chuỗi audit bắt buộc của đề bài
  audit_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT,                                 -- id sự kiện nền tảng gốc
  conversation_id TEXT,
  customer_id     TEXT,
  proposal_id     TEXT,
  exec_id         TEXT,
  stage           TEXT NOT NULL,                        -- PROPOSED|VALIDATED|AUTHORIZED|EXECUTED|VERIFIED|FAILED
  detail_json     TEXT NOT NULL,
  receipt_json    TEXT,                                 -- bằng chứng ngoài hệ thống
  at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_conv ON audit_events(conversation_id, at);
CREATE INDEX IF NOT EXISTS idx_audit_stage ON audit_events(stage, at);

CREATE TABLE IF NOT EXISTS jobs (                       -- queue persist + scheduler
  job_id         TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,                         -- process_event|send_message|check_receipt|create_shipment|follow_up|expire_draft|kill_stale_session|stuck_order
  payload_json   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'QUEUED',        -- QUEUED|RUNNING|DONE|DEAD
  run_at         TEXT NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 5,
  idempotency_key TEXT UNIQUE,
  last_error     TEXT,
  conversation_id TEXT,                                 -- để takeover hủy job AI của hội thoại
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, run_at);
CREATE INDEX IF NOT EXISTS idx_jobs_conv ON jobs(conversation_id, status);

CREATE TABLE IF NOT EXISTS dead_letter_queue (
  dlq_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       TEXT NOT NULL,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  fail_reason  TEXT NOT NULL,
  alerted      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS follow_ups (
  follow_up_id   TEXT PRIMARY KEY,
  order_id       TEXT REFERENCES orders(order_id),
  conversation_id TEXT NOT NULL,
  kind           TEXT NOT NULL,                         -- AFTER_DELIVERY_FEEDBACK|CARE_CHECKIN|MARKETING
  scheduled_at   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'SCHEDULED',     -- SCHEDULED|SENT|CANCELLED|FAILED
  cancel_reason  TEXT,
  exec_id        TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fu_due ON follow_ups(status, scheduled_at);

CREATE TABLE IF NOT EXISTS settings (                   -- CẤM chứa secret (review khi merge)
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS operators (
  operator_id TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('owner','agent')),
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics_counters (
  metric TEXT NOT NULL,
  day    TEXT NOT NULL,                                 -- 'YYYY-MM-DD'
  value  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (metric, day)
);
```

---

## PHỤ LỤC B — BẢNG TÓM TẮT 18 CASE (case → input → luồng → assert)

| # | Case | Input mô phỏng | Luồng tầng | Kỳ vọng + assert chính |
|---|------|----------------|-----------|--------------------------|
| 1 | Hỏi giá | Webhook Meta ký đúng, text hỏi giá; DB giá 250000 | GW→DED→WRK→AI→GATE→AUD | Tin out chứa giá DB; validation.price.source='product_variants'; 1 exec DONE + audit đủ 5 stage |
| 2 | Hỏi size/màu | Text hỏi biến thể; DB stock 3/0 | Như 1 | Liệt kê đúng theo DB (tồn hiệu dụng = qty-reserved); không bịa biến thể |
| 3 | Ảnh "còn không?" | Message image + caption; mock vision | GW→media tải→AI(match variant)→GATE | local_path tồn tại; evidence có matched_variant_id; match yếu → NEEDS_HUMAN, không tự trả |
| 4 | Voice | Message audio; mock ASR | GW→media→ASR→như text | transcript trong text_content (from_asr); ASR fail → NEEDS_HUMAN; token không lọt log |
| 5 | Đổi sản phẩm | Chốt V1 rồi xin đổi V2 | State machine + order engine pha A | DRAFT cũ hủy + hoàn reserve V1; 1 DRAFT active; audit 2 chuỗi |
| 6 | Nhiều SKU | 1 giỏ 2 variant + đủ thông tin | Order engine trong 1 tx | order_items ≥ 2; trừ đúng stock từng variant; 1 variant hết → rollback toàn bộ |
| 7 | Thiếu địa chỉ | Tên + SĐT, không địa chỉ | AI propose → GATE VALIDATE fail | Không CREATE_ORDER DONE; state giữ COLLECT_ORDER; tin hỏi địa chỉ được gửi |
| 8 | AI định sai giá | Proposal giá 150000 khi DB 250000 | GATE VALIDATE override | Khách nhận giá DB; audit ghi overridden_fields; metric gate_override++ |
| 9 | Hết hàng giữa chat | Stock 1→0 trước lúc chốt | Pha B re-validate trong tx | Không oversell (stock ≥ 0 toàn cột); báo hết + đề xuất khác; audit fail reason rõ |
| 10 | Webhook duplicate | Cùng raw body POST 2 lần | GW dedupe | 2x HTTP 200; 1 inbox_events; 1 tin in; AI trả đúng 1 lần; dedupe_hit=1 |
| 11 | Gửi tin timeout | Mock send treo | GATE → TIMEOUT_UNKNOWN → check_receipt | Không gửi trùng; receipt về → DELIVERED; không xác định được → DLQ + takeover |
| 12 | Tạo order/vận đơn timeout | Mock createShipment treo | idempotency_key + tra cứu clientOrderCode | Mock nhận đúng 1 create; biến thể ALREADY_EXISTS → dùng mã cũ; không bao giờ 2 vận đơn |
| 13 | Khiếu nại | Text chửi than thiếu hàng; mock classify | AI classify → mode=HUMAN | Chỉ template an ủi; alert operator; follow_ups marketing bị hủy |
| 14 | Thiếu evidence | Câu hỏi ngoài dữ liệu; confidence thấp | AI policy NEEDS_HUMAN | Không tin nào bịa thuộc tính; metric ai_low_confidence++; có worklist cho operator |
| 15 | Takeover | Operator bấm takeover; khách nhắn tiếp | conversations.mode='HUMAN' | 0 tin 'ai' mới; tin nhân viên gửi OK; job AI của hội thoại bị hủy; audit ghi actor |
| 16 | Trả quyền | Operator handback | mode='AI', giữ state | AI propose lại từ state hiện tại; không reset NEW_LEAD; không mâu thuẫn lời nhân viên |
| 17 | Follow-up sau giao | Mock DELIVERED | Scheduler +2 ngày → GATE | follow_ups SENT đúng 1 lần đúng hẹn; opt-out trước hẹn → CANCELLED |
| 18 | Từ chối marketing | "đừng quảng cáo nữa" | marketing_opt_out=1 → AUTHORIZE chặn | Follow-ups hủy loạt; tin marketing sau bị reject (metric opt_out); tin transactional vẫn đi được |

---

## PHỤ LỤC C — DANH MỤC CHƯA XÁC MINH (cần làm rõ trước khi code thật)

1. **Zalo webhook**: cơ chế verify chính thức (header chữ ký?), tên field id sự kiện, chính sách resend — quyết định cách làm 1.4 và tham số dedupe.
2. **Meta Send API**: cờ idempotency chính thức (client_message_id có được nền tảng dedupe giúp không?) và API đọc lại trạng thái tin để reconcile (case 11).
3. **Zalo API trạng thái tin nhắn** — cho check_receipt.
4. **ĐVVC** (GHN/GHTK/J&T/ViettelPost): idempotency của API create, API tra cứu theo mã đối tác, bảng mã trạng thái, webhook có hay chỉ poll — cần key thật.
5. **ASR voice** (provider, chi phí, tiếng Việt) và **độ chính xác vision ghép ảnh→variant** — phải đo trên bộ mẫu trước khi bật auto.
6. **Nhịp retry thực tế của Meta/Zalo webhook** — để tinh chỉnh cửa sổ dedupe và TTL inbox_events.
