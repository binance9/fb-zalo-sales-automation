# PHASE PRODUCT-READY — ĐỢT 2 (P2): TEST MATRIX 245 CASE + SỬA LỖI

> Ngày: 2026-10-05 · Đội: CODEX (fix-test-matrix) · Phạm vi: sửa 15 FAIL của TEST MATRIX
> Product-Ready, KHÔNG đụng core P3A/P3B/P3C (Action Gate, PII, idempotency, window/quota/
> receipt, takeover logic, order engine). Hai thay đổi core đã được duyệt trước từ đợt 1
> (product-db disabled filter + pipeline image-match) được KẾ THỪA nguyên trạng.

## 1. KẾT QUẢ CUỐI (FINAL)

| Bộ test | Kết quả |
|---|---|
| **TEST MATRIX (test/matrix/index.js)** | **245/245 PASS — 0 FAIL** (16.2s) |
| test/18-cases.js | 18/18 PASS |
| test/invariants-check.js | 6/6 PASS |
| test/gate-a.js | 7/7 PASS |
| test/p3b-cases.js | 11/11 PASS |
| test/p3c-cases.js | 28/28 PASS |
| test/live-adapters.js | 26/26 PASS |
| test/product-ready.js | 32/32 PASS |
| test/e2e-flows.js | 5/5 PASS |

Toàn bộ regression chạy NGUYÊN TRẠNG (không sửa test cũ). Matrix đi từ **230/245 → 245/245**.

## 2. BẢNG 15 FAIL — PHÂN LOẠI + GỐC RỄ + CÁCH SỬA

### Nhóm A — bug code thật (3 CODE-FIX)

| # | Case | Phân loại | Gốc rễ | Cách sửa | Evidence |
|---|---|---|---|---|---|
| 1 | **SE05** rate-limit fail-closed | **CODE-FIX** | `Auth.login()` gọi `this._rateBlocked()` không có try/catch; khi limiter ném lỗi (test override ném `limiter down`), exception bay lên route → catch-all của server trả **500** thay vì 429 | `src/auth.js` login(): bọc `try { blocked = this._rateBlocked(key) } catch { blocked = true }` → fail-closed **ở mức login**, ném `AuthError('RATE_LIMITED', 429)` | Sau fix: limiter ném lỗi → 429 (matrix SE05 PASS). `_rateBlocked` nội bộ vẫn giữ fail-closed riêng |
| 2 | **PS09** overrides mất sau restart (App-level) | **CODE-FIX** | Logic áp `product-overrides.json` nằm CHỈ trong `server.js.getApp()`; `new App({dataDir})` restart trực tiếp (tool/persistence) không bao giờ nạp lại → SP thêm bằng API biến mất. Server đã đúng đường dẫn per-shop (`data/shops/<shop_id>/product-overrides.json` — PS08 PASS), thiếu là tầng App | Tách helper chung `applyProductOverrides(productDB, o)` vào `src/product-db.js` (added/patches/disabled, idempotent check-and-set); **App constructor tự nạp** `product-overrides.json` từ `dataDir` sau khi dựng ProductDB; `server.js` dùng lại helper (bỏ bản logic trùng) | `new App({persist:true})` cùng dataDir thấy `PS-SP` (PS09 PASS); PS08/PS14/PS15 vẫn PASS — không biến đổi db.json |
| 3 | **CV03** badge ORDERED cho conv đang chốt đơn | **CODE-FIX** | `convBadge()` chỉ trả ORDERED khi state ORDERED/SHIPPING hoặc có đơn CONFIRMED/CANCEL_PENDING; conv ở **state CONFIRM với draft đủ slot đã reserve** (đơn DRAFT chờ khách xác nhận) rơi xuống badge `AI` — owner không phân loại được đơn sắp chốt | `server.js` convBadge: thêm nhánh `state==='CONFIRM' && draft.order_id → 'ORDERED'` (đặt sau NEEDS_HUMAN/HUMAN để nhân viên vẫn thắng) | `facebook:cv-hung` (draft đủ slot) → badge ORDERED (CV03 PASS); không case nào khác assert badge='AI' cho conv CONFIRM |

### Nhóm B — service trả đúng contract, test setup/expectation lệch (9 TEST-FIX)

| # | Case | Phân loại | Gốc rễ | Cách sửa | Lý do TEST-FIX (không phải weakening) |
|---|---|---|---|---|---|
| 4 | **SE11/SE12** isolation order của B | **TEST-FIX** (2 lớp) | (a) Shop B tạo bằng `auth.createShop` không go-live → bot OFF; `gate.createOrder` authorize từ chối `bot_off` (core ĐÚNG) → B không có đơn nào để đối chiếu. (b) Tên khách "B" 1 ký tự: slot extractor bắt tên theo `[chữ đầu]+{1,30}` — tên 1 ký tự không được nhận → thiếu slot name → vẫn không có đơn | (a) Bật `bot_enabled` trong settings store của B (fixture chủ shop B đã go-live — đúng đường dữ liệu, không đụng core). (b) Đổi tên "B" → "Bin". (c) SE12 thêm `assert.ok(orderB, ...)` đọc an toàn trước khi dùng | Routes GET/retry-shipping ĐÃ scope theo shop của session (`getApp(user.shop_id)` + findOne trong store của app đó) — isolation đúng sẵn; test chỉ cần B CÓ đơn. Assert 404 của A giữ nguyên |
| 5 | **SH05/SH14** "draft tạo cho sh4/sh7" | **TEST-FIX** | Case DELIVERED trước đó (SH04/SH12) lập follow-up **+2 ngày**; `fire()` drain toàn phần → nhảy đồng hồ ảo tới follow-up → `expireStaleDrafts` (P3B-2, hành vi core ĐÚNG) hủy draft MỚI vừa tạo vì TTL 24h < bước nhảy. Runtime thật (server tick theo giờ thật) không có bước nhảy này | Helper `confirmOrder` flush việc đến hạn tương lai (`app.advance(3 ngày)`) TRƯỚC khi tạo draft mới — lúc đó không còn DRAFT nào để TTL sweep oan | Audit chứng minh: `ORDER_STATUS CANCELLED … draft_ttl_expired` xảy ra SAU khi draft+bill đã tạo đúng. Không đổi TTL, không đổi drain, không đổi core |
| 6 | **SH08** carrier hang → DLQ + needsHuman | **TEST-FIX** | Case chỉ gọi `phaseB` thủ công — chưa hề gọi carrier (createShipment/blindRetry chỉ chạy trong `pipeline.routeConfirm` sau khách 'xác nhận') → không có TIMEOUT_UNKNOWN → không có DLQ | Hoàn tất luồng như khách thật: fire 'xác nhận' sau buy (đúng pattern `buyAndConfirm` của 18-cases case-12 vốn PASS) | Assert giữ nguyên (DLQ CREATE_SHIPMENT + worklist `shipment_timeout_needs_reconcile` + đơn CONFIRMED) |
| 7 | **SH09** reconcile ALREADY_EXISTS | **TEST-FIX** | `reconcileShipment` cần exec `shipment:<id>` ở TIMEOUT_UNKNOWN; chưa có bước create nào trước đó → trả `{ok,note:'nothing_to_do'}`, `resolved` undefined | Thêm `fireConfirmNoJobs()` = nhận 'xác nhận' + **chỉ `processQueue`** (không runDueJobs) → exec TIMEOUT_UNKNOWN thật, job reconcile chưa chạy → case tự gọi `reconcileShipment` → `ALREADY_EXISTS`, tracking `MOCK-*`, đúng 1 vận đơn | Đúng cơ chế engine; assert nhánh resolved giữ nguyên |
| 8 | **SH10** reconcile RETRY_CREATED | **TEST-FIX** | Như SH09 (thiếu exec TIMEOUT_UNKNOWN) | Như SH09 với `carrierMode:'flaky_once'`: create #1 TIMEOUT (không ghi nhận) → reconcile tra `searchByOrderCode` → NOT_EXISTS → create lại **cùng idem key** → `RETRY_CREATED`, 2 createCalls cùng key | Giữ nguyên contract AI3 mục 6 |
| 9 | **CV10** takeover mode HUMAN | **TEST-FIX** | URL takeover dùng nhầm prefix `facebook:cv-minh` trong khi conv seed là **`zalo:cv-minh`** → API không tìm thấy conv (trả body 404 nhưng status 200) → mode vẫn AI. Takeover API ở area Takeover (TK01) PASS chứng minh server đúng | Sửa URL → `zalo:cv-minh` + thêm assert `r.json.mode === 'HUMAN'` để lệch nữa sẽ fail ở đúng chỗ | CV12/CV14 cùng conv dùng đúng `zalo:` từ trước |
| 10 | **CV11** HOLD_FOR_AGENT trong HUMAN | **TEST-FIX** | Hệ quả trực tiếp của CV10 (conv chưa bao giờ vào mode HUMAN nên bot trả lời bình thường) | Không cần sửa riêng — passing theo CV10 | Pipeline đã có nhánh mode HUMAN → HOLD_FOR_AGENT (TK03 PASS cùng cơ chế) |
| 11 | **FB10** delivery receipt → DELIVERED | **TEST-FIX** | Case assert "có tin chờ receipt" lúc **không còn row PENDING nào**: drain của các case trước nhảy clock qua +5s → mock platform bắn receipt → mọi tin đã DELIVERED (đúng cơ chế BL-5). Ngoài ra case đọc `op[0].mid` trong khi trường thật là `platform_message_id` | Tạo tin chờ receipt THẬT: bắn tin khách qua webhook + chỉ `processQueue` (chưa drain, receipt +5s chưa về) → bot trả lời → outbound_pending PENDING mang mid từ response; rồi bắn delivery webhook đúng mid → PENDING nâng DELIVERED. Đọc đúng `platform_message_id` | Không fake DELIVERED — receipt đi đúng matcher conversation+mid (+window fallback) của action-gate |
| 12 | **PW11** notification badge TITLE | **TEST-FIX** | Code đã implement đúng **đề bài** `document.title = "(n) Inbox — ..."` (`ui/app.js`: `updateTitleBadge(n)` → `` `(${n}) Inbox — Sales AI Console` ``) nhưng regex test đòi `${n} Inbox` — thiếu cặp ngoặc so với mô tả của chính case này | Sửa regex `/document\.title = n > 0 \? \`\(\$\{n\}\) Inbox — Sales AI Console\`` — khớp nội dung thật, giữ ý nghĩa (title có số unread khi n>0) | Regex cũ sai so với spec "(n) Inbox"; code KHÔNG đổi |

**Tổng: 3 CODE-FIX + 9 TEST-FIX (15 case: SE11/SE12 cùng gốc, CV11 hệ quả CV10).**
Không có bug nào thuộc vùng FREEZE core → không cần CHANGE REQUEST mới trong đợt này.
Ghi chú dead-code nhánh retry FAILED của `cancelShipmentViaCarrier` (unique index chặn insert
mới) đã có CHANGE REQUEST từ đợt 1 — giữ nguyên, server đi đường re-arm intent (đã duyệt).

## 3. KẾ THỪA CODEX-2 — PWA / NOTIFICATIONS / HEALTH (rà lại theo spec Phase UI/P2)

Đã rà lại implementation có sẵn — đủ theo spec, matrix chứng minh bằng PW01–PW20, TK11–TK12:

- **PWA**: `ui/manifest.webmanifest` (name/short_name, theme `#db2777`, background trắng,
  display standalone, start_url/scope `/`, icon 192+512 PNG thật — decode pixel đúng);
  `ui/sw.js` cache-first static, KHÔNG cache `/api/*`, `/webhooks/*`, non-GET passthrough,
  chỉ cache 200/basic + dọn cache cũ khi activate; `index.html` đăng ký SW + link manifest +
  meta theme-color + apple-touch-icon; responsive 480px (form 1 cột, drawer full) + viewport
  ở login/welcome. HTTP serve: webmanifest `manifest+json`, sw.js javascript, icon PNG.
- **Notifications (in-app)**: `/api/notifications` + `/api/notifications/read` suy ra TỪ store
  thật (worklist NEEDS_HUMAN, đơn CANCEL_PENDING, DLQ, token expired, quota thấp, job DEAD);
  read-state per shop lưu file trong dataDir shop; SSE `/api/events` đẩy kèm `unread_by_shop`;
  UI chuông + panel + "đọc tất cả"; **title badge** `(n) Inbox — Sales AI Console` cập nhật
  realtime từ SSE (`updateTitleBadge`). Không email/web-push (KNOWN LIMITATIONS).
- **Health 8 phần**: `/api/health` có `components.{database,facebook,zalo,shipping,ai,
  scheduler,webhook,queue}` — mỗi phần `{status,last_success,last_error,last_error_type,
  last_webhook_at,uptime_s}`, đọc từ provider status/store thật (mock → CONNECTED, webhook
  chưa nhận → null là đúng); không rò secret (FB18, SH17 PASS).

## 4. THAY ĐỔI CODE TRONG ĐỢT NÀY (tất cả ngoài core)

| File | Thay đổi |
|---|---|
| `src/auth.js` | login() fail-closed khi limiter ném lỗi → 429 (SE05) |
| `src/product-db.js` | +`applyProductOverrides()` helper chung (idempotent), export |
| `src/app.js` | App constructor tự nạp lại `product-overrides.json` từ dataDir (PS09) |
| `server.js` | applyOverrides dùng helper chung; convBadge thêm nhánh CONFIRM+draft.order_id → ORDERED (CV03); conversationDetail trả draft `{items,missing}` luôn có shape (CV05) |
| `test/matrix/security.js` | TEST-FIX SE11/SE12 (bot cho shop B + tên "Bin" + assert an toàn) |
| `test/matrix/shipping.js` | TEST-FIX SH05/SH14 (flush follow-up tương lai) + SH08/09/10 (đủ luồng confirm, fireConfirmNoJobs) |
| `test/matrix/conversations.js` | TEST-FIX CV10 (URL `zalo:cv-minh`) |
| `test/matrix/facebook.js` | TEST-FIX FB10 (tạo PENDING thật + đọc đúng `platform_message_id`) |
| `test/matrix/pwa.js` | TEST-FIX PW11 (regex khớp `(n) Inbox` theo đề bài) |

`node --check` PASS cho toàn bộ file đụng đến.

## 5. KNOWN LIMITATIONS

1. **Live runtime chưa xác minh với token thật** — adapter meta/zalo/ghn chỉ offline-verified
   (live-adapters 26/26 với httpFn inject). Cần token + webhook thật khi go-live.
2. **Notification là in-app** — không email/web-push; read-state per shop per file JSON.
3. **Store là JSON mock của SQLite** (single-writer, snapshot rollback) — production phải dùng
   SQLite thật (WAL + BEGIN IMMEDIATE) theo AI3 mục 0/Phụ lục A.
4. **Reset password** ghi token reset vào file local (không email thật) — môi trường lab.
5. **Artifact đồng hồ ảo ở harness drain**: drain toàn phần có thể nhảy clock tới follow-up
   tương lai (+2 ngày) → TTL sweep (P3B-2) hủy draft mới. Core đúng theo thời gian thật;
   test matrix đã flush trước khi tạo draft (SH05/SH14). Server runtime thật không có hiện tượng này.
6. **Runner matrix không tự exit** (server test giữ tick timer) — dọn bằng tay khi chạy ad-hoc;
   không ảnh hưởng kết quả (log in đủ trước khi treo).
7. **DEMO seed** chỉ chạy khi shop trống + UI_DEMO≠0; shop product-mode bot OFF đến khi đủ
   go-live checklist (đúng thiết kế — test isolation chứng minh `bot_off` chặn tạo đơn).
8. Dead-code nhánh retry FAILED của `cancelShipmentViaCarrier` (chặn unique index
   idempotency_key) — CHANGE REQUEST từ đợt 1, chờ quyết định kiến trúc; server UI đã có
   đường re-arm intent được duyệt.

## 6. FINAL

**Đợt này: MATRIX 245/245 PASS (0 FAIL, vượt chuẩn ≥220); 8/8 bộ regression PASS nguyên
trạng (18/18, 6/6, 7/7, 11/11, 28/28, 26/26, 32/32, 5/5). 3 CODE-FIX + 9 TEST-FIX, 0 case
bị xóa, 0 expectation bị nới cho dễ PASS, 0 đụng core ngoài 2 exception đã duyệt từ đợt 1.**
