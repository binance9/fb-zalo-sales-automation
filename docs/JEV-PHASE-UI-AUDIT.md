# JEV — AUDIT PHASE UI (READ-ONLY + chạy thử lấy evidence)

- **Ngày audit:** 2026-10-05 (khoảng 12:04–12:30 giờ local)
- **Đối tượng:** `prototype/server.js` + `prototype/ui/` (index.html, app.js, style.css) + `prototype/src/*.js` (core)
- **Phương pháp:** KHÔNG sửa bất kỳ file source/UI nào. Chỉ gọi API/HTTP để tái hiện, đọc store `data/ui-runtime/db.json` làm ground truth, chạy lại test suite. Nếu có bug → chỉ báo cáo.
- **Server audit:** `PORT=8080 node server.js`, demo seed ON, PID audit = **35024** (đã kill cuối phiên, port 8080 trống). Log: `/tmp/ui-audit.log` — sạch, không có `[tick]`/`[http]` error.
- **Lưu ý khởi đầu:** lúc bắt đầu audit, port 8080 đã có 1 instance `node server.js` cũ (PID 33164, start 12:00:50 — sau lần sửa source cuối 11:56, tức cùng code mới). Auditor kill instance này và start lại instance mới để có trạng thái seed sạch, kiểm soát vòng đời.
- **Core nguyên trạng:** mọi file `src/*.js` có mtime ≤ 11:17 (trước Phase UI 11:50–11:56); 5/5 test suite PASS sau audit. Manifest sha256 15 file src lưu tại `C:\JEV\evidence\manifest-1791177354325.json` (vd `action-gate.js` = `6cc60349…20c5`).

---

## A. UI WIRING — AUDIT PASS

Mỗi chuỗi đều trace được đủ 4 chặng: UI (ui/app.js) → API → handler server.js → hàm src → store/audit → response. Các mục in đậm đã **chạy thử live bằng curl** trong phiên audit.

| # | NÚT / CHỨC NĂNG | UI (ui/app.js) | ENDPOINT | HANDLER server.js | HÀM SRC | EVIDENCE |
|---|---|---|---|---|---|---|
| 1 | Load dashboard (mở app/mục Tổng quan) | `loadCommon()` :119-124 + `renderOverview()` :141 | `GET /api/dashboard`, `GET /api/health` | :830, :831 → `dashboard()` :396-448, `health()` :450-471 | đọc trực tiếp `app.store.findAll(...)` (read-only) | Live: `khachHomNay=5, donHomNay=2, doanhThuHomNay=380000→170000 (sau cancel), canNhanVien=1, takeoverCount=1`, 6 hoạt động gần đây sinh từ ai_proposals/orders/worklist/dlq thật |
| 2 | Load danh sách hội thoại | `renderConversations()` :213-214 | `GET /api/conversations` | :838 → `listConversations()` :91-109 | quét store conversations + customers + messages | Live: 5 hội thoại đúng store (badge AI/HUMAN/ORDERED) |
| 3 | Mở 1 hội thoại | click `.conv-item` :351-357 → `renderConversations()` :221 | `GET /api/conversations/:id` | :839-844 → `conversationDetail()` :306-394 | quét store messages/shipments/orders + `gate.windowState()` (read-only) | Live: `facebook:fb-hung` trả 4 messages, draft/window/quota/latest_order đầy đủ; tin bot có `delivery_status=DELIVERED` từ outbound_pending |
| 4 | **Gửi tin nhân viên** | `sendAgentMessage()` :403-422 (nút `#btnSend` :381-382, Enter :377-379) | `POST /api/conversations/:id/send` | :845-849 → `apiSendAsAgent()` :491-500 | `app.takeover.agentSend` (takeover.js:66-68) → `gate.agentSend` (action-gate.js:783-801) → `executeSend`/`verifySend` | Live: `{"ok":true,"sent":true,"delivery_status":"SENT_PENDING_RECEIPT"}`; tin `sender=agent` xuất hiện trong conversation; audit `AGENT_SEND/PROPOSED` trong db.json |
| 5 | **Takeover** | nút `#btnTakeover` :384-390 | `POST /api/conversations/:id/takeover` | :850 → `apiTakeover()` :502-507 | `takeover.setTakeover` (takeover.js:21-38) — INV-5 | Live: mode `AI`→`HUMAN`, `human_agent=admin`; audit `TAKEOVER/AUTHORIZED/MODE_HUMAN` |
| 6 | **Handback** | nút `#btnHandback` :391-398 | `POST /api/conversations/:id/handback` | :851 → `apiHandback()` :509-514 | `takeover.handback` (takeover.js:40-63) — giữ state, kích hoạt lại follow-up HELD | Live: mode `HUMAN`→`AI`, state giữ `ORDERED`; audit `HANDBACK/AUTHORIZED/MODE_AI` có `state_kept:"ORDERED"` |
| 7 | Load đơn hàng | `renderOrders()` :430-431 | `GET /api/orders?status=` | :853 → `listOrders()` :139-164 | quét store orders + shipments + price_snapshot | Live: 2 đơn khớp db.json (xem mục B) |
| 8 | Mở chi tiết đơn | click `tr[data-order]` :462-463 → `openOrderDrawer()` :466-467 | `GET /api/orders/:id` | :854-857 → `orderDetail()` :187-223 | orders + shipments + audit_events (`orderHistory` :166-177, `orderAudit` :179-185) | Live: drawer data có history DRAFT→CONFIRMED→CANCELLED + audit đầy đủ |
| 9 | **Hủy đơn** | nút `#btnCancelOrder` :523-533 (chỉ hiện với DRAFT/CONFIRMED :517) | `POST /api/orders/:id/cancel` | :858-861 → `apiCancelOrder()` :516-539 | `app.orders.requestCancelOrder` (order-engine.js:171) — đường P3B-5 | Live: PASS — xem mục D |
| 10 | Load sản phẩm | `renderProducts()` :547-548 | `GET /api/products` | :862 → `listProducts()` :225-243 | `app.productDB.products` + overrides file | Live: 7 SP (6 seed products.json + 1 từ overrides) |
| 11 | **Sửa sản phẩm** | modal `#pfSave` :625-652; công tắc bật/tắt bán :587-599 | `PUT /api/products/:skuBase` | :868-872 → `apiUpdateProduct()` :627-676 | ProductDB (nguồn sự thật) + persist overrides + audit `PRODUCT_UPDATE`/`PRODUCT_TOGGLE` | Live: giá TUI-VO-NEN-DO 65000→69000, tồn 4→6, patch ghi vào `ui-runtime.product-overrides.json`; đã trả lại giá trị gốc sau test |
| 12 | Load khách hàng + chi tiết | `renderCustomers()` :661-662; `openCustomerDrawer()` :692-693 | `GET /api/customers`, `GET /api/customers/:id` | :873, :874-877 → `listCustomers()` :245-264, `customerDetail()` :266-292 | quét store customers/conversations/orders | Live: 5 khách khớp store; chi tiết Lan: opt_out=true, đơn ORDR_EF0268/DELIVERED |
| 13 | **Bot toggle** | `#botToggle` :823-834 (topbar); `#setBotSwitch` :783-793 (Cài đặt) | `POST /api/settings/bot` | :833-837 → `apiSetBot()` :541-554 | `store.updateRow('settings', bot_enabled)` trong transaction + audit `BOT_ENABLED_TOGGLE` | Live: off→`bot_on:false` ở /api/health + settings row false; on→true. Xem mục E |
| 14 | SSE realtime | `EventSource('/api/events')` :842-856 | `GET /api/events` | :816-824 + `tick()` :775-789 (quét fingerprint 2s, broadcast khi đổi) | không đổi logic — chỉ đọc | Live: nhận `hello` + 2 event `update` khi store đổi (mục F) |

**Kết luận A:** 13/13 chức năng trong phạm vi yêu cầu đều có chuỗi wiring đầy đủ và chạy được thật. Không có nút chết, không có endpoint orphan.

---

## B. KHÔNG FAKE DATA — AUDIT PASS

**1. Grep ui/app.js + index.html + style.css tìm dữ liệu cứng:**
- Không có tên khách / SĐT / mã đơn hardcode (grep `Mai|Hùng|Minh|Lan|0903|0911|0935|fb-mai|fb-hung|zalo-minh|fb-lan|fb-canh|ORD…` → 0 match).
- Không có mảng số liệu fake; hằng duy nhất là `ORDER_FILTERS` (app.js:425 — nhãn chip lọc, hợp lệ). Số ≥4 chữ số duy nhất là `setTimeout(..., 3200)` (toast, app.js:76).
- Mọi số hiển thị đi qua `fmtVND`/template literal từ state do API trả về.

**2. Đối chiếu API vs `data/ui-runtime/db.json` (script đếm trực tiếp trên db.json):**

| Chỉ số | API trả | db.json (ground truth) | Kết quả |
|---|---|---|---|
| khachHomNay | 5 | 5 | KHỚP |
| donHomNay | 2 | 2 | KHỚP |
| doanhThuHomNay | 170000 (sau khi đơn 210k bị hủy) | 170000 | KHỚP |
| canNhanVien | 1 | 1 | KHỚP |
| takeoverCount | 1 | 1 | KHỚP |
| Orders (count/total/status) | 2 — ORDR_EF0268/170000/DELIVERED, ORDJ_B1FC64/210000/CANCELLED | 2 — giống hệt | KHỚP |
| Conversations (mode/state) | 5 — khớp từng bản ghi | 5 — giống hệt | KHỚP |
| Products | 7 = 6 seed `data/products.json` + 1 từ `ui-runtime.product-overrides.json` | ProductDB seed + overrides | KHỚP (nguồn rõ ràng) |

**3. Chat:** messages liệt kê từ store `messages` (server.js:310-349); trạng thái giao tin suy ra từ `outbound_pending` (server.js:320-324), không bịa.

**Kết luận B:** PASS — toàn bộ số liệu dashboard/orders/chat/products/customers lấy từ store/ProductDB thật.

---

## C. TAKEOVER — AUDIT PASS (chạy thật bằng curl)

Chọn hội thoại `facebook:fb-hung` (đang AUTO, state ORDERED):

1. **Trước:** `mode=AI, human_agent=null`.
2. **`POST /api/conversations/facebook%3Afb-hung/takeover`** → `{"ok":true,"mode":"HUMAN"}`; GET lại → `mode=HUMAN, human_agent=admin`. db.json ghi audit: `TAKEOVER | AUTHORIZED | MODE_HUMAN | {"operator":"admin","reason":"ui_takeover","cancelled_jobs":0}`.
3. **Gửi tin nhân viên khi HUMAN** — `POST .../send` (body UTF-8 từ file): `{"ok":true,"sent":true,"delivery_status":"SENT_PENDING_RECEIPT"}`; tin xuất hiện trong conversation với `sender=agent`; audit `AGENT_SEND/PROPOSED` trong db.json.
   - **"Bot không auto-send khi HUMAN"** — kiểm ở mức API + code + test (server không có endpoint tiêm event khách — đúng thiết kế, webhook chỉ mô phỏng trong test):
     - **Code:** `authorize()` chặn auto khi mode HUMAN — action-gate.js:248 `if (actor === 'ai' && conversation.mode === 'HUMAN') return { ok:false, reason:'takeover' }`; và :254-256 chặn cả follow-up marketing/care của system trong HUMAN. Comment INV-5 action-gate.js:232-233.
     - **Test (nguyên trạng, chạy lại trong phiên này):** `test/invariants-check.js` **VÙNG 6** (dòng 404-500) PASS — gồm (a) AI send bị REJECT `reason=takeover`, `gate_rejected_takeover++`, 0 tin AI mới; (b) createOrder/confirmOrder bị khóa trong HUMAN; (c) follow-up care đến hạn giữa HUMAN bị HELD, handback gửi đúng 1 lần; (d) agentSend của nhân viên vẫn gửi được. `test/gate-a.js` **A3** (dòng 176-217) PASS — actor=system không bypass HUMAN (BL-8, 0 sentCalls). (Ghi chú: A3 của gate-a thuộc nhóm "system bypass", bằng chứng chặn auto-send chính là VÙNG 6.)
4. **`POST .../handback`** → `{"ok":true,"mode":"AI","state":"ORDERED"}`; GET lại → `mode=AI, human_agent=null, state=ORDERED`. Audit: `HANDBACK | AUTHORIZED | MODE_AI | {"operator":"admin","state_kept":"ORDERED"}`.

**Kết luận C:** PASS trọn vẹn takeover → agentSend → handback, có audit trong store.

---

## D. CANCEL ORDER — AUDIT PASS (đường P3B, không phải UPDATE thẳng)

Đơn `ORDJ_B1FC64` (CONFIRMED, vận đơn `MOCK-ORDJ_B1FC64` status CREATED).

- **`POST /api/orders/ord_muusby5o_j_b1fc64/cancel`** → `{"ok":true,"viaCarrier":true,"pending":false,"status":"CANCELLED"}`.
- **db.json sau lệnh:** orders row `status=CANCELLED, cancel_reason=operator_ui_request, cancel_actor=admin`; shipments row `status=CANCELLED` kèm **receipt carrier**: `{"status":"CANCELLED","trackingNumber":"MOCK-ORDJ_B1FC64","receipt_id":"CXL-cancel_shipment:ord_muusby5o_j_b1fc64",...}` — chứng đi qua adapter ĐVVC (`cancelShipmentViaCarrier`, order-engine.js:227), có idempotency receipt, KHÔNG phải UPDATE thẳng status.
- **Audit chuỗi P3B đầy đủ:** `PROPOSED:CANCEL_ORDER_REQUESTED → EXECUTED:CANCEL_SHIPMENT:INTENT_RECORDED → ORDER:ORDER_STATUS:CANCELLED → VERIFIED:CANCEL_SHIPMENT:DONE`; statusHistory `CONFIRMED → CANCELLED (actor=admin, reason=operator_ui_request:via_carrier)`.
- **Hoàn tồn (restock):** variant `NT-VANILLA-M-DO` effective 2 → **3** sau cancel.
- Test cùng luồng: p3b-cases P3B-5a/5b/5c PASS (11/11) — gồm cả nhánh carrier từ chối → CANCEL_PENDING.

**Kết luận D:** PASS — hủy đơn đi đúng flow P3B (request → hủy vận đơn qua carrier → receipt → CANCELLED + restock).

---

## E. BOT TOGGLE — AUDIT PASS (có 1 bug nhỏ về audit — xem Danh sách vấn đề #1)

1. **`POST /api/settings/bot {"on":false}`** → `{"ok":true,"on":false}`; `GET /api/health` → `bot_on:false`; `GET /api/settings` → `bot:{on:false,autoReply:false}`; db.json settings row `bot_enabled=false`.
2. **Đối chiếu cùng nguồn dữ liệu với gate:** `apiSetBot` (server.js:541-554) ghi đúng row `settings.key='bot_enabled'` — chính row mà `gate.botEnabled()` (action-gate.js:72-75) đọc; `authorize()` chặn đầu tiên tại action-gate.js:247 `if (!this.botEnabled()) return { ok:false, reason:'bot_off' }`.
3. **Chứng minh live authorize REJECT khi bot off:** với bot OFF, gọi agentSend → `{"ok":true,"sent":false,"reason":"bot_off"}`; metric `metrics` ghi `gate_rejected_bot_off = 1`. Bật lại `{"on":true}` → health `bot_on:true`.
4. **Test suite:** grep toàn bộ 5 suite — **không có test nào** đề cập `bot_enabled`/`botEnabled`/`bot_off` (0 match). Hành vi bot_off chỉ được chứng minh bằng code + live run ở trên, chưa có test hồi quy. (Không FAIL vì không vi phạm gì — ghi nhận là GAP.)

**Kết luận E:** PASS về chức năng; GAP nhỏ: chưa có test suite phủ bot_enabled.

---

## F. BỔ SUNG — AUDIT PASS

- **SSE:** `curl -N /api/events` (8s) bắt được `data: {"type":"hello",...}` + 2 event `data: {"type":"update",...}` ngay khi store đổi (2 lần toggle bot). Cơ chế: server quét fingerprint mỗi 2s (server.js:760-789), client refetch view đang mở (ui/app.js:842-856). PASS.
- **Secrets:** grep `token|secret|api[_-]?key|password|bearer` trong `ui/*` → chỉ 1 match là **chữ trong label UI** (app.js:751 "Không hiển thị secrets/API keys…"); server.js → 0 match; response `/api/health` và `/api/products` không chứa field key/token. settings store đúng ràng buộc AI3 (chỉ `bot_enabled`, `product_disabled:*`). PASS.
- **5 suite test chạy lại (core nguyên trạng):** 18-cases **18/18**, gate-a **7/7**, invariants-check **6/6** (gồm VÙNG 6 takeover), p3b-cases **11/11**, p3c-cases **28/28** — toàn bộ EXIT=0, đúng mốc 18/18, 7/7, 6/6, 11/11, 28/28.
- **Dọn dẹp:** server audit đã kill đúng PID 35024, port 8080 trống. Giá/tồn sản phẩm đã test PUT được trả về giá trị gốc. Lưu ý: có 1 instance server cũ (PID 33164) do phiên làm việc trước để lại, auditor đã thay thế bằng instance của mình (xem đầu báo cáo).

---

## BẢNG TỔNG

| Mục | Kết luận | Bằng chứng chính |
|---|---|---|
| A. UI WIRING | **PASS** | Bảng 13 chuỗi UI→API→handler→src ở mục A; các chức năng ghi đậm đã curl live thành công |
| B. KHÔNG FAKE DATA | **PASS** | Grep 0 chuỗi cứng; 5/5 chỉ số dashboard + 2/2 đơn + 5/5 hội thoại khớp db.json |
| C. TAKEOVER | **PASS** | Live: AI→HUMAN→agentSend `sent:true`→handback AI; audit TAKEOVER/HANDBACK trong db.json; code action-gate.js:248; test VÙNG 6 + gate-a A3 PASS |
| D. CANCEL ORDER | **PASS** | Live: ok=true, viaCarrier=true; db.json: order CANCELLED + shipment CANCELLED + receipt carrier; restock +1; audit chuỗi CANCEL*; KHÔNG phải UPDATE thẳng |
| E. BOT TOGGLE | **PASS** (1 bug nhỏ audit-trail) | Live: off→bot_on=false + agentSend bị REJECT `bot_off` (metric gate_rejected_bot_off=1)→on; cùng 1 settings row với gate. GAP: 0 test phủ bot_enabled |
| F. BỔ SUNG | **PASS** | SSE hello+2 update; 0 secrets lộ; 5 suite 18/18, 7/7, 6/6, 11/11, 28/28; server đã tắt |

---

## DANH SÁCH VẤN ĐỀ (KHÔNG sửa — chỉ báo cáo)

Không có BLOCKER. Không có MAJOR.

1. **[MINOR] Audit `BOT_ENABLED_TOGGLE` ghi sai `from` — luôn bằng `to`.**
   - Nơi: `server.js:544-551` (`apiSetBot`) — gọi `store.updateRow('settings', row, {value: !!on})` TRƯỚC, rồi audit đọc `row.value` → vì `updateRow` mutate tại chỗ (`Object.assign`, store.js:122-127) nên `from` luôn = giá trị mới.
   - Evidence thực chạy: 2 lần toggle liên tiếp ghi audit `{"from":false,"to":false}` và `{"from":true,"to":true}` — giá trị TRƯỚC khi toggle (true rồi false) bị mất trong audit trail. Chức năng toggle vẫn đúng (settings row + health đúng), chỉ kém trung thực audit.

2. **[MINOR] `PUT /api/products/:skuBase` với `body.sku` không tồn tại → trả `ok:true` im lặng (silent no-op).**
   - Nơi: `server.js:637-649` — `const v = p.variants.find(...)`; nếu không thấy variant thì bỏ qua mọi mutation nhưng vẫn audit `PRODUCT_UPDATE` + trả `{"ok":true}`.
   - Evidence thực chạy: PUT `{sku:"TUI-VO-NEN-1", price:69000, stock_qty:6}` → `{"ok":true}` nhưng giá/tồn giữ nguyên 65000/4. UI thật không vướng (modal luôn gửi variant lấy từ danh sách, ui/app.js:634) — chỉ ảnh hưởng caller API thô.

3. **[MINOR] Bot tắt (`bot_off`) chặn luôn tin nhân viên gửi tay.**
   - Nơi: action-gate.js:247 — check `bot_off` đứng trước và không ngoại lệ actor, nên `agentSend` (actor `human_agent`, action-gate.js:789) cũng bị REJECT.
   - Evidence thực chạy: bot OFF → POST send → `{"sent":false,"reason":"bot_off"}`. Trong khi UI mô tả "Tắt = mọi **auto-send** bị gate chặn" (ui/app.js:760, :790, :831) — operator tắt bot để tự trả lời tay sẽ không gửi được tin nào. Cần xác nhận đây là chủ ý hay lọt; nếu chủ ý nên sửa文案 UI.

4. **[MINOR — dữ liệu runtime, không phải source] Rác test bám trong `data/ui-runtime.product-overrides.json`.**
   - File chứa 1 sản phẩm thêm bằng tay tên mojibake `"G?i n?n th? v?"` (do console encoding lúc test trước) + `disabled:{GOI-THU-VI:true}`; file nằm NGOÀI dataDir nên sống sót qua mọi restart, hiển thị "Tạm tắt" trong bảng sản phẩm. Không có API xóa sản phẩm; thêm lại cùng SKU bị `409 SKU_BASE_EXISTS` (tên hỏng sửa được qua modal `name`, nhưng SKU/tồn thêm sai thì không xóa được). Vệ sinh bằng cách xóa entry trong file khi server dừng.

5. **[GAP] Chưa có test hồi quy cho `bot_enabled`.** 0/5 suite đề cập `botEnabled`/`bot_off` — hành vi "bot off → authorize REJECT" hiện chỉ được bảo vệ bởi code (action-gate.js:247), không có test khóa hành vi.

6. **[NHẬN XÉT — không phải lỗi] Safmt dữ liệu demo:** hội thoại khiếu nại `fb-canh` tự vào mode HUMAN ngay sau seed (pipeline auto-escalation khiếu nại — đúng thiết kế core), nên dashboard mở lên đã có `takeoverCount=1` và khách hiện tên mặc định `fb-canh` (chưa thu thập được tên — đúng state).

---
*JEV — audit READ-ONLY. Không file source/UI nào bị sửa trong phiên này. Bằng chứng hash src: `C:\JEV\evidence\manifest-1791177354325.json`.*
