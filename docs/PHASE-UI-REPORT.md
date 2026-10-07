# PHASE UI — GIAO DIỆN VẬN HÀNH (báo cáo thực thi)

> Phạm vi: xây **HTTP server + Web UI vận hành** cho prototype bán hàng AI tại `prototype/`
> (thuần Node `http`, KHÔNG npm, KHÔNG mạng ngoài, Git Bash).
> **KHÔNG sửa bất kỳ file `src/*` hay `test/*` nào** — 0 dòng core bị đụng: PII gate, Action
> Gate/authorize (SendPolicy), idempotency (INV-1/2/3), order engine 2 pha, window/quota,
> receipt store, takeover — tất cả nguyên trạng, chứng minh bằng regression 5/5 suite exit 0.
> Nhãn kết quả: **PASS (MOCK)** — UI chạy trên đúng App mock của prototype (stub LLM, mock
> platform/carrier/vision/ASR, JSON store, đồng hồ ảo kéo theo giờ thật).

---

## 1. BEFORE — bề mặt App trước khi nối UI

Trước Phase UI, prototype **không có HTTP server nào** — toàn bộ tương tác đi qua code test:
`new App({dataDir})` → `app.receive({channel, type, platformEventId, payload})` → `app.drain()`
→ assert trực tiếp trên `app.store` (JSON store). Bề mặt liên quan Phase UI đã khảo sát:

| Thành phần | Bề mặt dùng được (public) | Ghi chú |
|---|---|---|
| `App` (`src/app.js`) | `opts.dataDir` (bị **xoá sạch** lúc khởi tạo nếu tồn tại), `opts.clockStart`, `opts.draftTtlMs`, `opts.quotaLowThreshold` | dataDir xoá mỗi lần dựng App — UI runtime do đó **không persist dữ liệu qua lần start lại** (hành vi core, không đổi) |
| Inbound | `app.receive(ev)` → gateway dedupe → queue; `app.gateway.processQueue()`; `app.drain({horizonMs})` | drain nhảy đồng hồ tới `nextDueAt` (horizon 3 ngày mặc định) — **không dùng cho runtime UI** |
| Scheduler | `app.runDueJobs()` (job check_receipt / reconcile / follow-up / TTL draft sweep); `app.clock` (VirtualClock: `now/iso/advance/schedule/nextAt`) | tick UI: `clock.advance(Date.now())` + `processQueue()` + `runDueJobs()` — mọi thứ đến hạn theo GIỜ THẬT, không nhảy xa hơn |
| Gửi tin nhân viên | `app.takeover.agentSend(app.gate, conv, customer, text, operator)` → `gate.agentSend` (authorize actor=human_agent + idem key `agent:<op>:<nonce>` + audit) | đúng đường idempotency + audit |
| Takeover | `app.takeover.setTakeover(conv, operator, reason)` / `app.takeover.handback(conv, operator)` | INV-5 + kích hoạt lại follow-up HELD |
| Hủy đơn | `app.orders.requestCancelOrder({orderId, actor, reason, eventId, carrier: app.carrier})` | đúng flow P3B-5 (draft → release; CONFIRMED không shipment → restock; có shipment → `carrier.cancelShipment` idem key riêng; từ chối → CANCEL_PENDING + needsHuman) |
| Bot on/off | settings store row `bot_enabled` (gate đọc qua `botEnabled()`); `app.store.transaction` + `updateRow` + audit | bật/tắt bằng đúng nguồn sự thật của gate |
| Đọc dữ liệu | `app.store.findOne/findAll/metric`, collections `customers/conversations/messages/orders/order_items/shipments/ai_proposals/action_executions/audit_events/jobs/follow_ups/dlq/worklist/metrics/settings/outbound_pending/receipt_events/channel_budget/channel_state`; `app.gate.windowState(conv)` (READ-ONLY) | mọi API đọc quét store, không cache, không số cứng |
| Sản phẩm | `app.productDB` (in-memory seed `data/products.json`): `getVariant/getStock/effectiveStock/setStock/getProductByBase` | ProductDB **không persist** và không có khái niệm "enabled" — xem mục 5 (hạn chế) |

---

## 2. CODEX CHANGES

1. **`server.js` (MỚI)** — HTTP server thuần Node:
   - App runtime riêng `data/ui-runtime` (không đụng `data/test-runs`, không đụng `data/runtime`),
     `clockStart = Date.now() - 55 phút`; seed demo (mặc định BẬT, `UI_DEMO=0` để tắt) bắn event
     **THẬT qua `app.receive()`** + pump (`clock.advance` nhỏ + `processQueue` + `runDueJobs`) —
     sinh hội thoại/đơn/claim/opt-out bằng đúng pipeline/gate/order-engine có audit.
   - Vòng runtime 2s: kéo đồng hồ ảo về giờ thật (`clock.advance(Date.now())` — timer receipt 5s
     chạy đúng nhịp thật), `processQueue()`, `runDueJobs()`, rồi quét fingerprint toàn store
     (`writeCount` + độ dài/`updated_at` từng collection + version product) → đổi thì push SSE.
   - PORT = `process.env.PORT || 8080`, start in `UI bán hàng: http://localhost:8080`.
2. **`ui/index.html` + `ui/app.js` + `ui/style.css` (MỚI)** — SPA 6 mục, theme trắng/hồng
   (#db2777 primary, #fce7f3 accent, #374151 chữ), chữ ≥14px, responsive, không emoji, SSE realtime.
3. **0 file `src/*` / `test/*` bị sửa.** Cả hai lần suy nghiệm "có cần sửa core không" đều kết luận
   KHÔNG cần (đọc được mọi thứ qua `store.findAll/findOne`; ghi đi đúng đường hệ thống). Không có
   gì cần supervisor duyệt sửa core.

---

## 3. FILES CREATED / CHANGED

| File | Loại | Nội dung |
|---|---|---|
| `prototype/server.js` | **MỚI** | HTTP + API JSON + SSE + static `ui/` + seed demo + tick đồng hồ thật |
| `prototype/ui/index.html` | **MỚI** | Khung app: topbar (brand · nút Bot ON/OFF · chuông needs_human · avatar admin), sidebar 6 mục, drawer/modal/toast |
| `prototype/ui/app.js` | **MỚI** | SPA JS: 6 view, chat Messenger-like, drawer đơn/khách, modal sản phẩm, SSE refetch |
| `prototype/ui/style.css` | **MỚI** | Theme trắng/hồng, card + bảng + badge + bubble chat, responsive (≤1180px, ≤820px) |
| `data/ui-runtime/`, `data/ui-runtime.product-overrides.json` | tự sinh khi chạy | DB runtime UI + đè lượng sửa SP (file NGOÀI dataDir vì App xoá dataDir lúc boot) |

`node --check` PASS: `server.js`, `ui/app.js` (và toàn bộ `src/*.js` chạy lại không lỗi).

---

## 4. API MAP (endpoint → store/action thật)

### Đọc (READ-ONLY, quét store, 0 số cứng)
| Endpoint | Nguồn |
|---|---|
| `GET /api/dashboard` | `{khachHomNay}` = customers created hôm nay (ngày của `clock`); `{donHomNay}` = orders created hôm nay; `{doanhThuHomNay}` = tổng `orders.total` CONFIRMED/DELIVERED hôm nay; `{canNhanVien}` = conversations `flag_needs_human ‖ mode=HUMAN`; `{bot}` = settings `bot_enabled` (qua `gate.botEnabled()`); `{kenh}` = trạng thái mock platform/carrier (ghi rõ mock); `{hoatDongGanDay}` = gộp `ai_proposals`(PRICE/VARIANT/STOCK/ATTR_UNKNOWN) + `orders` + `worklist` OPEN + `dlq` + audit `EXECUTED:FAILED` của send, sort desc, lấy 10 |
| `GET /api/conversations` | `conversations` + `customers` + message cuối + badge suy ra (NEEDS_HUMAN > HUMAN > ORDERED > AI) |
| `GET /api/conversations/:id` | `messages` (in/out, sender customer/bot/agent/system) + `delivery_status` từ `messages` nối `outbound_pending` (SENT_PENDING_RECEIPT→DELIVERED theo receipt) + khách (tên/SĐT/địa chỉ từ `draft.slots` + `orders.address_snapshot`) + `state/subject_sku/claim` + đơn gần nhất + **window** `gate.windowState()` (FB 24h) + **quota** `channel_budget` (Zalo CS) |
| `GET /api/orders?status=` | `orders` + `order_items`/`price_snapshot_json` + `shipments`; `display_status` suy ra (CONFIRMED + shipment PICKED_UP/IN_TRANSIT/… → SHIPPING); filter theo display_status |
| `GET /api/orders/:id` | đơn + items (tên từ `productDB.getVariant`) + `history` = audit `ORDER_STATUS` + `audit` = audit ORDER/SHIPMENT/CANCEL của conversation + `cancel_actor/at/reason/carrier_reason` |
| `GET /api/products` | `productDB.products` + tồn hiệu dụng (`stock_qty - stock_reserved`) + cờ `enabled` từ overrides/settings |
| `GET /api/customers` | `customers` + đơn CONFIRMED/DELIVERED (số đơn, tổng chi) + hội thoại (kênh/state/mode) + opt-out |
| `GET /api/customers/:ref` | khách + hội thoại + đơn + claim + opt-out |
| `GET /api/health` | bot_on + kênh (mock) + uptime + metrics lỗi (`send_failed/dlq_count/event_failed/order_create_timeout/follow_up_failed`) + jobs DEAD + version/node/clock |
| `GET /api/settings` | bot + automation: `follow_ups` theo status/kind + số khách opt-out |
| `GET /api/events` | **SSE**: tick 2s quét fingerprint store → push `{type:'update'}`; client refetch view đang mở (không polling 1s) |

### Ghi (đi ĐÚNG đường hệ thống — không ghi DB trực tiếp)
| Endpoint | Đường thật |
|---|---|
| `POST /api/conversations/:id/send {text}` | `takeover.agentSend(gate, conv, customer, text, 'admin')` → `gate.agentSend` (authorize actor=human_agent; idem `agent:admin:<nonce>`; audit AGENT_SEND; gate từ chối thì trả `reason` — vd `fb_window_closed` khi ngoài 24h ở mode AI) |
| `POST /api/conversations/:id/takeover` | `takeover.setTakeover(conv,'admin','ui_takeover')` — mode HUMAN + huỷ job AI QUEUED (giữ job đối chứng) + audit |
| `POST /api/conversations/:id/handback` | `takeover.handback(conv,'admin')` — mode AI giữ state + kích hoạt lại follow-up HELD |
| `POST /api/orders/:id/cancel` | `orders.requestCancelOrder({actor:'admin', reason:'operator_ui_request', carrier: app.carrier})` — đúng P3B-5; carrier từ chối → CANCEL_PENDING + needsHuman, không huỷ lửng |
| `POST /api/settings/bot {on}` | `store.transaction` update settings `bot_enabled` (nguồn gate đọc) + audit `BOT_ENABLED_TOGGLE` |
| `POST /api/products` / `PUT /api/products/:sku` | mutation `productDB` (thêm SP/giá/tồn qua `setStock`) + audit `PRODUCT_ADD/UPDATE` bọc trong `store.transaction`; đè ra file overrides; enabled mirror vào settings `product_disabled:<sku>` |

Chạy thử thật (curl, server :8091): dashboard/conversations/orders/products/customers/health trả
đúng dữ liệu seed; takeover → send (nhân viên, `SENT_PENDING_RECEIPT`) → handback OK; cancel đơn
CONFIRMED có vận đơn → `viaCarrier:true`, đơn CANCELLED; bot off/on OK; SSE nhận `update` ngay khi
store đổi; static 200 cho `/`, `/style.css`, `/app.js`.

---

## 5. UI THEO ĐÚNG ĐẶC TẢ

- **Top bar**: tên shop · nút BOT ON/OFF đậm dễ bấm · chuông thông báo (đếm `canNhanVien`) · avatar admin.
- **Sidebar đúng 6 mục**: Tổng quan / Hội thoại / Đơn hàng / Sản phẩm / Khách hàng / Cài đặt.
- **Tổng quan**: 4 card (Khách hôm nay / Đơn hôm nay / Doanh thu / Cần nhân viên) + khối BOT STATUS
  (FB/Zalo/GHN connected-mock, Bot AI ON/OFF, Human takeover: N hội thoại) + bảng HOẠT ĐỘNG GẦN ĐÂY. Không chart.
- **Hội thoại 3 cột**: danh sách (avatar/tên/icon FB-Zalo/tin cuối/giờ/badge AI-HUMAN-NEEDS_HUMAN-ORDERED
  + ô search) | khung chat Messenger-like (tin khách trái, bot/nhân viên phải, system giữa; timestamp +
  trạng thái gửi `Đã gửi · chờ xác nhận giao / Đã đến khách / Gửi lỗi` từ outbound_pending/messages;
  banner "AI ĐANG XỬ LÝ" hoặc "NHÂN VIÊN ĐANG TIẾP QUẢN"; ô nhập + Gửi; 2 nút lớn TIẾP QUẢN / TRẢ LẠI CHO AI,
  disable nút không hợp lệ theo mode) | thông tin khách (tên/SĐT/địa chỉ/SP đang hỏi/state/đơn gần nhất/kênh/
  window FB/quota Zalo/khiếu nại/opt-out — không tech clutter).
- **Đơn hàng**: bảng (Mã/Khách/Sản phẩm/Tổng tiền/Trạng thái/Vận chuyển/Thời gian) + 7 filter
  (Tất cả/Draft/Confirmed/Shipping/Delivered/Cancelled/Cancel Pending) + drawer chi tiết
  (khách/items/giá + phí ship/tracking/history/audit) + nút HỦY ĐƠN gọi API cancel (confirm trước khi bắn).
- **Sản phẩm**: bảng (Ảnh/Tên/SKU/Giá/Tồn kho/Trạng thái) + Thêm/Sửa (modal) + Bật-Tắt (switch) qua API.
- **Khách hàng**: bảng (Tên/SĐT/Kênh/Đơn đã mua/Tổng chi/Trạng thái/Lần cuối) + drawer chi tiết
  (hội thoại → mở thẳng trong chat / đơn / opt-out).
- **Cài đặt 4 khối**: Kết nối (FB/Zalo/GHN, ghi rõ mock) · Bot AI (ON/OFF, auto reply, takeover) ·
  Automation (follow-up theo trạng thái/kind, opt-out) · Hệ thống (health/version/uptime/log lỗi gần
  đây). **Không hiển thị secrets/API keys** (prototype không có secret; UI cũng không có ô nhập token).
- **SSE realtime**: hội thoại/dashboard/tất cả view refetch khi server báo update (~2s quét).
- **Cấm fake data**: toàn bộ số/tin/danh sách từ API thật. Dữ liệu hiển thị lúc mới bật là do
  **seed demo bắn event thật qua pipeline** (có audit), tắt được bằng `UI_DEMO=0` → UI empty nhưng vẫn thật.

---

## 6. REGRESSION (5 suite — bắt buộc exit 0)

```
node test/18-cases.js          -> TỔNG: 18/18 PASS, 0 FAIL   (exit 0)
node test/invariants-check.js  -> TỔNG: 6/6 vùng PASS, 0 FAIL (exit 0)
node test/gate-a.js            -> TỔNG: 7/7 PASS, 0 FAIL      (exit 0)
node test/p3b-cases.js         -> TỔNG: 11/11 PASS, 0 FAIL    (exit 0)
node test/p3c-cases.js         -> TỔNG: 28/28 PASS, 0 FAIL    (exit 0)
```

`node --check` PASS cho `server.js`, `ui/app.js` và toàn bộ `src/*.js`. `src/*` + `test/*` nguyên
trạng (mtime không đổi) — không cần supervisor duyệt sửa core nào.

---

## 7. HẠN CHẾ (ghi thẳng thắn)

1. **Không persist qua lần start lại**: `App` xoá `dataDir` lúc khởi tạo (hành vi `src/app.js`,
   `fs.rmSync`). Mỗi lần start server, `data/ui-runtime` được dựng lại; seed demo (mặc định ON)
   tạo lại cảnh mẫu bằng event thật. Muốn giữ dữ liệu thật giữa các lần chạy thì phải cho phép
   App có chế độ "không xoá dataDir" — **sửa core, KHÔNG tự làm**, để supervisor duyệt.
2. **Browser automation không chạy được trong agent này** (môi trường subagent không có browser)
   — UI được xác minh bằng: API-level tests đầy đủ (curl mọi endpoint + SSE) + `node --check` +
   khớp selector giữa app.js/index.html (id `botToggle/bellBtn/chatSearch/composer/btnSend/
   btnTakeover/btnHandback/drawer/modal…`). Chưa chụp screenshot — cần 1 lần mở
   `http://localhost:8080` bằng tay để duyệt thị giác.
3. **Sản phẩm**: `ProductDB` là in-memory seed, không persist, không có khái niệm enabled.
   Phase UI thêm lớp overrides (file + mirror settings) — sửa giá/tồn có hiệu lực thật với bot
   (bot đọc `productDB`), còn **"Tạm tắt" chỉ ẩn/khoá ở UI + settings, CHƯA chặn pipeline match
   SP đó** (chặn hẳn phải thêm filter enabled vào `product-db.searchProduct` — sửa core, chưa làm).
   Overrides áp dụng lại lúc boot nên sống qua restart, nhưng data bán được phát sinh trong phiên
   (đơn/đặt chỗ) thì không (đúng mục 1).
4. **Gửi tin nhân viên ở mode AI**: hệ thống cho phép `human_agent` gửi khi window FB còn mở
   (đúng SendPolicy); ngoài window sẽ bị gate từ chối `fb_window_closed`/`human_agent_spoofed`
   nếu không ở mode HUMAN — UI hiển thị nguyên văn lý do thay vì tự xử. Đây là đúng policy nền tảng.
5. **Đồng hồ "hôm nay"** = ngày của đồng hồ hệ thống (ảo, kéo theo giờ thật). Nếu máy ngủ lâu,
   tick sẽ kéo clock bù về hiện tại; các follow-up đến hạn trong lúc ngủ sẽ chạy ngay tick kế tiếp.
6. **SSE fingerprint** dựa `writeCount` + kích thước/mốc thời gian từng collection: bắt được mọi
   thay đổi đi qua transaction (toàn bộ luồng send/đơn/takeover đều qua transaction); cập nhật
   hàng ngoài transaction đơn thuần (không có trong luồng hiện tại) có thể không bắn SSE ngay.
7. **Bảo mật prototype**: server bind mọi interface, không auth — chỉ dùng trong máy local lab.
   Token/secret không bao giờ xuất hiện trong API/UI (core không lưu secret vào store).

## 8. FINAL

**FINAL: PASS (MOCK)** — Phase UI: server + UI + 5/5 suite regression exit 0 + 0 file core bị sửa.

---

## PHỤ LỤC — SUPERVISOR (ZCode) ACCEPTANCE CUỐI

### Đã duyệt + thực hiện thêm sau khi CODEX nộp
1. **POST /api/debug/customer-message** (server.js) — endpoint nghiệm thu do Supervisor duyệt: bắn tin
   khách đi ĐÚNG đường app.receive() (như webhook), không ghi DB trực tiếp.
2. **Core fix có kiểm soát (src/pipeline.js)** — bug thật phát hiện khi acceptance: đơn SP ĐA VARIANT
   khách chưa nói size/màu ("đặt cho mình 1 nến thơm vanilla") bị nuốt Buy intent → fallback
   "chưa đủ dữ liệu". Vá: extractItems cho qua marker ambiguous → routeBuy hỏi chọn variant từ FACTS
   (giá/tồn từ DB, chống bịa) → routeInfo bắt lời chọn variant → đi tiếp luồng mua. Chuỗi xác minh:
   hỏi variant (S 165k / M đỏ 185k kèm tồn) → chọn M đỏ → hỏi SĐT → hỏi tên → bill 185k+25k ship.
3. **ui/app.js** — sửa lỗi escape: meta tin nhắn escape cả span delivery (HTML thô hiện ra);
   giờ chỉ escape phần text, span dlv render đúng màu.
4. **data/ui-runtime.product-overrides.json** — reset (sản phẩm mojibake từ lần test POST cũ).

### KẾT QUẢ NGHIỆM THU ZCODE
- **15/15 case runtime PASS** (zcode-acceptance-15.js, chạy trên server thật :8080): dashboard,
  danh sách hội thoại, mở chat, gửi tin NV, bot reply giá từ DB, takeover→HUMAN, handback→AI,
  tạo đơn hiển thị (4 tin chốt), chi tiết đơn, hủy DRAFT→CANCELLED, hủy CONFIRMED qua carrier→shipment
  CANCELLED, sản phẩm load, sửa giá SP, customer detail, bot ON/OFF.
- **Regression 5 suite sau core fix: 28/28 · 11/11 · 7/7 · 6/6 · 18/18 — PASS (MOCK).**
- **Visual: 6/6 trang đạt** (trắng + hồng, gọn, chữ ≥14px — ảnh tại ui-screenshots/, đã tự xem từng ảnh;
  2-hoi-thoai-fixed.png xác nhận fix meta). JEV audit: 5/5 mục PASS, 0 BLOCKER/MAJOR.

### CHANNEL LIVE
Facebook/Zalo/GHN thật: **CHƯA XÁC MINH** (mock adapter — đợi Phase-2: Meta developer + Page thật,
Zalo OA thật, GHN sandbox).

### URL CHO CHỦ
`cd sales-ai-lab/prototype && node server.js` → mở **http://localhost:8080**
