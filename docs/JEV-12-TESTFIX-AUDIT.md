# JEV AUDIT — 12 TEST-FIX ĐỢT PRODUCT-READY P2 (độc lập, chỉ đọc + probe)

> Auditor: JEV · Ngày: 2026-10-05 · Phạm vi: kiểm tra độc lập 15 case FAIL mà CODEX sửa
> (3 CODE-FIX + 12 TEST-FIX) — mục tiêu: xác minh KHÔNG hạ tiêu chí / không bỏ case /
> không sửa để lấy PASS. KHÔNG sửa bất kỳ file code/test nào (file này là deliverable duy nhất).
>
> Phương pháp: (1) đọc test hiện tại + contract gốc (`docs/00-yeu-cau.md`, `docs/PHASE-UI-REPORT.md`,
> contract AI3/P3A/P3B/P3C trong code comment) và đối chiếu từng [TEST-FIX]; (2) trace code matcher
> theo từng assertion; (3) **chạy lại toàn bộ matrix độc lập**: `node test/matrix/index.js` →
> **245/245 PASS (15.9s)**, bảng 14 khu vực đúng phân bổ: Auth 16, Onboarding 20, Facebook 18,
> Zalo 18, Shipping 18, Products 15, Conversations 18, Orders 18, Takeover 15, Follow-up 15,
> Persistence 15, Security 20, PWA/UI 20, E2E 19 — **ĐỦ 245, trùng khớp số case ghi trong
> JEV-PRODUCT-READY-AUDIT.md (đợt 1) → 0 case bị xóa/giảm**; (4) chạy regression
> `test/invariants-check.js` 6/6 + `test/18-cases.js` 18/18; (5) **probe isolation ĐỘC LẬP**
> tự viết (không dùng test của CODEX) — boot createServer 2 shop, xem mục SE11/SE12.

## KẾT LUẬN NHANH

**12/12 TEST-FIX + 3/3 CODE-FIX ĐỀU HỢP LỆ — 0 hạ tiêu chí, 0 bỏ case, 0 che bug thật.**
Isolation shop (SE11/SE12) được probe độc lập xác nhận ĐÚNG: shop A đọc/ghi mọi đường vào
đơn của B đều 404, list không rò rỉ. Không có BLOCKER.

---

## BẢNG KIỂM 12 TEST-FIX (+3 CODE-FIX cùng đợt)

### 1. FB10 — delivery webhook (receipt) → DELIVERED — **HỢP LỆ · PASS**

- **Yêu cầu gốc (BL-5 / contract P3C):** KHÔNG tự đánh DELIVERED; chỉ webhook receipt khớp
  conversation + mid (+ cửa sổ thời gian) mới được nâng PENDING → DELIVERED.
- **Diff trước/sau:** trước — case chỉ assert "có tin chờ receipt" khi không còn row PENDING nào
  (drain các case trước đã nhảy clock +5s → mock bắn receipt → mọi tin đã DELIVERED), và đọc sai
  trường `op[0].mid`. Sau — test tự tạo PENDING THẬT (webhook tin khách + chỉ `processQueue`,
  receipt +5s chưa về), đọc đúng `platform_message_id` (facebook.js:105), rồi bắn delivery
  webhook ĐÃ KÝ HMAC đúng mid qua HTTP thật (facebook.js:99-112).
- **Xác minh JEV (trace):** chuỗi thật không rút gọn: POST `/webhooks/meta` (HMAC) →
  `MetaAdapter.normalizeWebhook` đẩy `delivery.mids` thành receipts (meta-adapter.js:119-126) →
  `server.js:180 app.ingestReceipt` → `gate.processReceiptEvent` → `matchAndApplyReceipt`
  (action-gate.js:577-593): mid-match `platform_message_id` của PENDING ưu tiên → DELIVERED.
  Nơi duy nhất ghi `receipt_status='DELIVERED'` là `matchAndApplyReceipt` — không có đường tắt nào
  trong test (grep: test KHÔNG tự ghi store). `executeSend` vẫn giữ comment+ràng buộc
  "response ok ≠ bằng chứng delivery" (action-gate.js:478-486, 358-359).
- **Verdict: PASS** — test chứng minh đúng cơ chế BL-5, mạnh hơn bản cũ.

### 2. SH05/SH14 — draft tạo trước shipment (flush follow-up tương lai) — **HỢP LỆ · PASS**

- **Yêu cầu gốc:** SH05 = P3B-5 "cancel QUA CARRIER PATH" (`viaCarrier === true` + CANCELLED);
  SH14 = shipment UNKNOWN → display vẫn CONFIRMED. P3B-2: DRAFT TTL 24h bị sweep là hành vi core ĐÚNG.
- **Diff trước/sau:** chỉ thêm `app.advance(3 ngày)` ĐẦU helper `confirmOrder` (shipping.js:13)
  — flush việc đến hạn (follow-up +2 ngày từ case DELIVERED SH04/SH12) TRƯỚC khi tạo draft mới,
  để `fire()`→drain không nhảy clock 2 ngày và TTL sweep hủy oan draft vừa tạo.
  TTL không đổi, drain không đổi, core không đổi; 2 assertion giữ nguyên (shipping.js:77-79, 173).
- **Xác minh JEV:** `advance()` = nhảy clock + drain (app.js:223-226). Tại thời điểm flush không
  còn DRAFT nào (mọi confirmOrder đều phaseB ngay) → sweep không hủy gì; draft MỚI tạo SAU flush
  có TTL 24h tính từ mốc mới; `expireStaleDrafts` KHÔNG đưa expires_at vào `nextDueAt`
  (app.js:143-146) → drain không nhảy 24h → draft sống. Không case nào trong area đếm
  follow-up message nên flush sớm không phá assert nào. `requestCancelOrder` vẫn đi
  `cancelShipmentViaCarrier` (order-engine.js:185-201) → `viaCarrier:true` là bằng chứng carrier path thật.
- **Verdict: PASS** — xử lý artifact đồng hồ ảo của harness, không nới assertion.

### 3. SH08 — carrier hang → DLQ + needsHuman, không retry mù (INV-2) — **HỢP LỆ · PASS**

- **Yêu cầu gốc:** INV-2 + case 12/18: TIMEOUT_UNKNOWN → CẤM blind-retry → DLQ + needsHuman;
  đơn vẫn CONFIRMED.
- **Diff trước/sau:** trước — case chỉ chạy phaseA/phaB thủ công, CHƯA GỌI carrier nên không bao giờ
  có TIMEOUT → assert DLQ fail. Sau — fire 'xác nhận' đi đủ luồng khách thật
  (shipping.js:106) → `routeConfirm` → `createShipment` (hang→TIMEOUT) → `blindRetryShipment`
  BỊ CHẶN → DLQ + worklist.
- **Xác minh JEV:** 'xác nhận' khớp `RE.confirmOrder` (pipeline.js:27) → `routeConfirm`
  (pipeline.js:585-663): timeout → `blindRetryShipment` (order-engine.js:400-428) — engine
  KHÔNG đổi: exec TIMEOUT_UNKNOWN + không receipt → insert DLQ `CREATE_SHIPMENT` +
  needsHuman `shipment_timeout_needs_reconcile`. Assert giữ nguyên cả 3 điều kiện
  (CONFIRMED + DLQ + worklist, shipping.js:108-113). INV-2 vẫn được phủ: blind-retry bị chặn
  là nhánh engine thật, test chỉ dẫn đủ luồng để chạm nhánh đó.
- **Verdict: PASS.**

### 4. SH09/SH10 — reconcile ALREADY_EXISTS / RETRY_CREATED — **HỢP LỆ · PASS**

- **Yêu cầu gốc:** contract AI3 mục 6: reconcile tra `searchByOrderCode` — carrier ĐÃ tạo →
  dùng lại tracking cũ (ALREADY_EXISTS, KHÔNG create lần 2); CHƯA tạo → create LẠI CÙNG
  idempotency key (RETRY_CREATED).
- **Diff trước/sau:** thêm helper `fireConfirmNoJobs` (shipping.js:30-37) = nhận 'xác nhận' +
  CHỈ `gateway.processQueue` (gateway.js:48-… — xử lý event queue, KHÔNG `runDueJobs`) →
  exec TIMEOUT_UNKNOWN tồn tại thật nhưng job reconcile chưa chạy → case tự gọi
  `orders.reconcileShipment` để assert nhánh resolved.
- **Xác minh JEV:** logic `reconcileShipment` KHÔNG BỊ THAY ĐỔI để dễ PASS — so code
  order-engine.js:442-470 khớp nguyên văn contract (nothing_to_do / ALREADY_EXISTS reuse /
  RETRY_CREATED same-key / STILL_TIMEOUT). Assert giữ nguyên: SH09 `resolved==='ALREADY_EXISTS'`
  + tracking `MOCK-*` + đúng 1 vận đơn (unique index); SH10 `RETRY_CREATED` + 2 createCalls
  CÙNG key (shipping.js:125-140). MockCarrier `hang` record-ngay/flaky_once (shipping/src:42-70)
  là fixture có từ P3, không sửa.
- **Verdict: PASS.**

### 5. CV03 — badge ORDERED khi CONFIRM + draft.order_id (CODE-FIX server.js) — **HỢP LỆ · PASS**

- **Yêu cầu gốc (PHASE-UI-REPORT.md:72,106):** badge suy ra 4 nhãn, ưu tiên
  **NEEDS_HUMAN > HUMAN > ORDERED > AI**.
- **Diff:** `convBadge` thêm 1 nhánh `state==='CONFIRM' && conv.draft?.order_id → 'ORDERED'`
  ĐẶT SAU 2 nhánh NEEDS_HUMAN/HUMAN (server.js:189-203).
- **Xác minh JEV:** đủ 4 nhãn, thứ tự ưu tiên giữ nguyên (flag_needs_human trước, mode HUMAN
  thứ hai, nhánh mới chỉ chèn trong cụm ORDERED). Không case nào khác assert badge 'AI'
  cho conv state CONFIRM (grep toàn matrix). Ghi chú (không phải lỗi): conv CONFIRM mà draft đã
  TTL-expired vẫn hiện ORDERED vì order_id được giữ chủ đích cho re-validate (order-engine.js:156-160)
  — display-only, nhân viên vẫn thắng bằng NEEDS_HUMAN/HUMAN.
- **Verdict: PASS.**

### 6. CV05 — draft.missing luôn có shape (CODE-FIX server conversationDetail) — **HỢP LỆ · PASS**

- **Yêu cầu gốc:** case 7/18 (thiếu địa chỉ/thông tin → hỏi bổ sung) + client UI panel "thiếu gì"
  không được vỡ khi conv chưa có draft.
- **Diff:** `conversationDetail` trả draft LUÔN có shape `{items, missing}` — khi không có draft
  dùng `{items:[], slots:{}}` rồi tính missing trên dữ liệu rỗng (server.js:491-512).
- **Xác minh JEV:** khi thiếu slot, missing vẫn CHÍNH XÁC: items state≠stale có qty → không thêm
  'items'; name/phone/address kiểm `slots.<k>.value` (server.js:503-510). CV05 assert
  missing chứa name/phone/address cho 'lấy 1 nến vanilla'; CV06 assert phone RỜI KHỎI missing
  sau khi khách bổ sung — cả hai PASS trong lần chạy độc lập của JEV → fix không làm missing
  "luôn rỗng cho dễ PASS".
- **Verdict: PASS.**

### 7. CV10/CV11 — URL takeover đúng prefix `zalo:` — **HỢP LỆ · PASS**

- **Yêu cầu gốc:** case 15/16 + INV-5: takeover thật → mode HUMAN; khách nhắn trong HUMAN →
  AI CẤM gửi (HOLD_FOR_AGENT).
- **Diff trước/sau:** URL đổi `facebook:cv-minh` → `zalo:cv-minh` (đúng conv seed ở setup,
  conversations.js:15) + THÊM assert `r.json.mode === 'HUMAN'` và kiểm store
  `conv.mode==='HUMAN'` + `human_agent` (conversations.js:79-84) — lệch nữa sẽ fail đúng chỗ.
- **Xác minh JEV:** chạy độc lập matrix → CV10/CV11/CV12/CV14 PASS; area Takeover 15/15 PASS
  (TK01 cùng API takeover, TK03 cùng nhánh HOLD_FOR_AGENT pipeline.js:156). Lưu ý môi trường:
  `docs/zcode-acceptance-15.js` là script acceptance Phase UI cần server LIVE :8080 (không chạy
  offline được, crash khi không có server — JEV thử chạy: fail do thiếu server, không liên quan
  fix P2); takeover đã được chứng minh đủ bằng matrix runtime.
- **Verdict: PASS** — thêm assert (siết, không nới).

### 8. SE11/SE12 — isolation order của B (fixture bot + tên "Bin") — **HỢP LỆ · PASS — ĐÃ PROBE ĐỘC LẬP**

- **Yêu cầu gốc:** isolation dữ liệu per-shop: A không đọc/ghi đơn của B (404), không thấy
  conversation/customer của B.
- **Diff trước/sau (chỉ fixture dữ liệu):** (a) bật `bot_enabled` trong settings store của B;
  (b) tên "B" → "Bin" (regex tên pipeline.js:300 yêu cầu ≥2 chữ cái — gốc rễ CODEX khai ĐÚNG,
  JEV đối chiếu regex `([A-ZÀ-Ỹa-zà-ỹ][A-Za-zÀ-ỹà-ỹ ]{1,30}?)`); (c) thêm assert an toàn
  `assert.ok(orderB, …)` (security.js:114,121). **Routes KHÔNG đổi** — assert 404 giữ nguyên
  (security.js:113-124).
- **PROBE ĐỘC LẬP CỦA JEV** (tự viết, không dùng test CODEX — boot `createServer` 1 instance,
  2 shop; shop B tự go-live checklist + bật bot QUA API chính chủ của OWNER B — sạch hơn cả
  fixture của CODEX; tạo đơn B thật qua `/api/debug/customer-message` + confirm HTTP):
  - B go-live + bot on qua API → 200 (trước go-live: 403 `GO_LIVE_CHECKLIST` — core chặn ĐÚNG,
    xác nhận luôn gốc rễ "bot_off" mà CODEX khai);
  - **A GET `/api/orders/<B>` → 404** `ORDER_NOT_FOUND`; **B GET → 200**;
  - **A POST `retry-shipping` đơn B → 404**; **A POST `confirm` → 404**; **A POST `cancel` → 404**;
  - list `/api/orders` của A: 0 đơn B; list `/api/conversations` của A: 0 conv B;
    A GET detail conv B → 404; list customers A không chứa khách B.
  - Kết quả probe: **ISOLATION ĐÚNG — KHÔNG có rò rỉ cross-shop** (exit 0).
- **Xác minh code route:** mọi API đăng nhập đều scope `const app = getApp(user.shop_id)`
  (server.js:1789); `orderDetail`/`apiRetryShipping` findOne TRONG store app đó
  (server.js:311, 1381-1383) → 404 là thiếu trong store của shop session, không phải truc khác.
- **Verdict: PASS** — sửa test KHÔNG che lỗ hổng nào: isolation thật, được 2 nguồn xác nhận
  (probe độc lập + trace route).

### 9. SE05 — rate-limit fail-closed (CODE-FIX, cùng đợt — kiểm thêm) — **HỢP LỆ · PASS**

- `src/auth.js:200-207`: bọc `this._rateBlocked(key)` trong try/catch → limiter ném lỗi →
  `AuthError('RATE_LIMITED', 429)` — fail-closed ở mức login; `_rateBlocked` nội bộ vẫn
  fail-closed riêng (auth.js:177-186). Matrix SE05 PASS trong lần chạy độc lập.

### 10. PS09 — overrides theo shop sống qua restart (CODE-FIX App-level — ngoài 12, kiểm theo yêu cầu) — **HỢP LỆ · PASS**

- **Yêu cầu gốc:** SP thêm/sửa/tắt qua API phải persist per-shop (`data/shops/<shop>/product-overrides.json`)
  và sống qua restart Ở MỨC APP (tool/test dựng `new App({dataDir})` trực tiếp).
- **Diff:** tách helper chung `applyProductOverrides` (product-db.js:180-207 — added/patches/disabled,
  IDEMPOTENT: added chỉ push khi chưa tồn tại theo sku_base); App constructor tự nạp file overrides
  từ dataDir (app.js:51-54); server `getApp` dùng lại helper (server.js:1009-1011).
- **Xác minh JEV:** PS08 (file per-shop) + PS09 (nạp lại sau `new App`) + PS14 (server restart
  thật trả SP qua API) + PS15 (persist KHÔNG biến đổi db.json — overrides chỉ áp in-memory lên
  ProductDB, không đụng store) đều PASS trong lần chạy độc lập. Không có đường nào bỏ qua idempotency.
- **Verdict: PASS.**

### 11. PW11 — notification badge TITLE (regex khớp code) — **HỢP LỆ · PASS**

- **Yêu cầu gốc (đề bài case):** `document.title = "(n) Inbox — …"` khi có unread.
- **Diff trước/sau:** chỉ sửa REGEX test (`/document\.title = n > 0 \? \`\(\$\{n\}\) Inbox — Sales AI Console\` : /`)
  — regex cũ thiếu cặp ngoặc so với ĐỀ BÀI của chính case. CODE KHÔNG đổi: `ui/app.js:32-33`
  có thật `document.title = n > 0 ? \`(${n}) Inbox — Sales AI Console\` : APP_TITLE;` trong
  `updateTitleBadge(n)`, được `renderBell(n)` gọi (app.js:160) với `state.notifUnread` từ
  `/api/notifications` (app.js:176-177) và SSE `unread_by_shop` (app.js:1359-1361) — n là số
  thông báo chưa đọc thật (worklist NEEDS_HUMAN, đơn lỗi, DLQ, token, quota, job DEAD từ server).
  Ý nghĩa assertion giữ nguyên (title có số unread khi n>0); PW20 kiểm bell/panel có thật trên HTML.
- **Verdict: PASS** — test sửa theo spec, không phải sửa spec theo code.

### 12. Chạy lại matrix + chống bỏ-case — **ĐẠT**

- `node test/matrix/index.js` (JEV tự chạy): **245/245 PASS (15.9s)**, 14/14 khu vực,
  phân bổ khớp 100% bảng đợt 1 (JEV-PRODUCT-READY-AUDIT.md:80) → **0 case bị xóa**.
- Runner chạy TOÀN BỘ `cases[]` của từng area, không filter (index.js:47-54); grep không thấy
  bất kỳ area nào slice/filter cases. 15 case từng FAIL đều còn nguyên trong file
  (FB10, SH05/SH08/SH09/SH10/SH14, CV03/CV05/CV10/CV11, SE05/SE11/SE12, PS09, PW11) và PASS.
- Regression nguyên trạng: invariants-check 6/6, 18-cases 18/18 (JEV chạy lại).

---

## FINDING PHỤ (không phải hạ tiêu chí, không chặn chốt)

1. **[INFO] Receipt window-fallback** (action-gate.js:586-593): 1 receipt khớp cửa sổ thời gian có
   thể nâng MỌI PENDING cùng conversation (nhiều tin 1 conversation). Hành vi core P3C có TRƯỚC
   đợt này, không phải sản phẩm của TEST-FIX; FB10 assert "mọi PENDING → DELIVERED" dựa cả fallback
   này. production nên siết theo mid-only khi nền tảng cung cấp mids đầy đủ. (Ghi nhận, không chấm FAIL.)
2. **[INFO] CV03 badge ORDERED cho draft TTL-expired** — order_id được giữ chủ đích cho
   re-validate nên badge vẫn ORDERED dù giữ chỗ đã hết hạn. Display-only; NEEDS_HUMAN/HUMAN vẫn thắng.
3. **[INFO] `docs/zcode-acceptance-15.js`** cần server LIVE :8080 + dữ liệu seed — không phải bộ
   regression offline của đợt P2; không chạy được trong môi trường audit. Takeover đã được chứng minh
   bằng matrix (CV10-14, TK 15/15).
4. **[KNOWN] Matrix runner không tự exit** (server test giữ tick timer) — log in đủ trước khi treo;
   đúng KNOWN LIMITATIONS #6 của P2 doc.

## FINAL

| Hạng mục | Kết luận |
|---|---|
| 12 TEST-FIX (15 case) | **12/12 HỢP LỆ — PASS** |
| 3 CODE-FIX (SE05, PS09, CV03 + CV05 shape) | **HỢP LỆ — PASS** (code sửa đúng gốc rễ, không nới contract) |
| Hạ tiêu chí / bỏ case / sửa để lấy PASS | **KHÔNG phát hiện** |
| Isolation (SE11/SE12) | **Probe độc lập: ĐÚNG — A đọc/ghi đơn B 404, list không rò rỉ** |
| Matrix độc lập | **245/245 PASS, đủ 245 case, đúng phân bổ 14 khu vực** |
| BLOCKER | **Không có** |
