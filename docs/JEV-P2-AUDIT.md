# JEV-P2-AUDIT — Kiểm chứng độc lập PHASE 2 LIVE-INTEGRATION

> Auditor: JEV (READ-ONLY) — ngày 2026-10-05.
> Đối tượng: `prototype/` (file mới: `src/channel/meta-adapter.js`, `src/channel/zalo-adapter.js`,
> `src/shipping/ghn-adapter.js`, `src/live-env.js`, `src/live-http.js`, `src/live-runtime.js`,
> `test/live-adapters.js`, `.env.live`; sửa: `server.js`, `src/app.js`, `src/store.js`, `ui/app.js`).
> Đối chiếu claim: `docs/P2-LIVE-INTEGRATION.md` (CODEX, 2026-10-05).
> Phương pháp: đọc code + chạy lại 6 test suite + boot server THẬT (mock & live-giả) trong bản
> SAO ở `%TEMP%\jev-audit-p2` (project gốc không bị sửa) + probe HTTP thuần Node (tự tính HMAC
> từ secret test) + probe offline độc lập (tự viết, require thẳng adapter, httpFn tiêm mock).
> Project gốc sau audit: không thay đổi source/test; chỉ có data do chạy test suite tạo ra
> (`data/test-runs/…` như mọi lần chạy test trước); KHÔNG có `data/live/` (token file chỉ ghi
> trong dataDir test — đúng thiết kế).

KẾT LUẬN NGẮN: **toàn bộ 6 mục A–F ĐẠT (PASS) trên phạm vi MOCK + OFFLINE-VERIFIED + LIVE-GIẢ
(boot thật với secret test)**. Không phát hiện BLOCKER. 2 vấn đề MAJOR thuộc nhóm **điều kiện
trước go-live** (webhook auth Zalo/GHN), 5 MINOR. LIVE runtime với token/Page/OA/GHN thật vẫn
**CHƯA XÁC MINH** (đúng như CODEX đã tự khai — không có tài nguyên thật trong môi trường audit).

---

## A. REQUEST TRACE — provider → webhook → normalize → Gate → store → response

Cách chạy: boot server trong bản sao temp với `CHANNEL_MODE=live SHIPPING_MODE=ghn`, secret GIẢ
tiêm qua env (`META_APP_SECRET=jev_test_secret_a1b2c3`, `META_VERIFY_TOKEN=jev_verify_tok_99`,
`ZALO_APP_ID/SECRET/...`); **cố tình KHÔNG set** access token/GHN token → outbound short-circuit
(META_NOT_CONFIGURED / ZALO_NOT_CONFIGURED) → trace không chạm mạng thật. Client HTTP thuần Node
(tự tính HMAC theo `META_APP_SECRET` test), tránh lỗi UTF-8 của curl Windows (LIMITATION #12 của
CODEX được xác nhận là đúng — client Node cho kết quả sạch).

| # | ROUTE | KẾT QUẢ THỰC | NORMALIZE → STORE/EFFECT | EVIDENCE |
|---|---|---|---|---|
| 1 | `GET /webhooks/meta` sai `hub.verify_token` | **403 Forbidden** | không event | probe output §2; route `server.js:938-945`; `meta-adapter.js:75-83` |
| 2 | `GET /webhooks/meta` đúng token | **200** echo nguyên văn `CHALLENGE_JEV_42` | — | probe §3; `meta-adapter.js:82` |
| 3 | `POST /webhooks/meta` sig HMAC hợp lệ (mid=`m.jev.1`) | **200 EVENTS_RECEIVED** | inbox_event `facebook:m.jev.1` PROCESSED; message row in=`còn hàng không shop?`; `channel_state.last_user_event_ts` được gateway ghi | probe §4 + db dump; normalize `meta-adapter.js:169-204` (mid→platformEventId, PSID→customer_ref) |
| 4 | `POST /webhooks/meta` **sig sai** (body sửa, giữ sig cũ) | **401 invalid signature** | KHÔNG ACK, không event | probe §5; `server.js:951`; HMAC timing-safe `meta-adapter.js:86-96` |
| 5 | `POST /webhooks/meta` **thiếu header** sig | **401 invalid signature** | như trên | probe §6 |
| 6 | `POST /webhooks/meta` trùng platform id lần 2 | 200 (ACK) nhưng **dedupe tầng gateway**: inbox vẫn đúng 1 event `facebook:m.jev.1`, khách nhận đúng 1 tin | gateway INV-1 | probe §7 + db: `inbox_events` 2 hàng (meta 1 + zalo 1); battery M6 PASS |
| 7 | `POST /webhooks/zalo` `user_send_text` sig sha256(appId+data+ts+secret) hợp lệ | **200 OK** | event `zalo:zlmsg:zmsg.jev.1` PROCESSED; message in=`tra hoa say con khong shop`; conversation `zalo:8900123456` | probe §8; `zalo-adapter.js:227-287,394-407`; `server.js:958-972` |
| 8 | `POST /webhooks/zalo` **sig sai** | **401 invalid signature** | không event | probe §9; `zalo-adapter.js:217-223` |
| 9 | `POST /webhooks/zalo` **không có header** sig | 200 OK (theo đúng thiết kế khai báo: chỉ từ chối khi header được gửi mà sai) | event được nhận | probe bổ sung; `server.js:966-969` — xem VẤN ĐỀ MAJOR-2 |
| 10 | `POST /webhooks/ghn` status ×2 cùng payload | **200 OK cả 2 lần** (ACK luôn, idempotent theo event_id `ghn:<code>:<status>:<time>`) | lần 2 `duplicate:true`, `applyWebhook` no-op; không shipment khớp → không đụng pipeline | probe §10; `ghn-adapter.js:263-292`; `server.js:973-990`; battery G5 |
| 11 | Pipeline chạy sau webhook (tick 2s) | 2 conversation sinh ra từ webhook THẬT; bot trả lời qua gate → adapter: message out `delivery_status=FAILED`, worklist `send_failed:META_NOT_CONFIGURED` / `send_failed:ZALO_NOT_CONFIGURED`, audit `SEND_REPLY:VARIANT` INTENT_RECORDED→FAILED (fail RÕ, không crash, không giả success) | webhook → gateway queue → pipeline → ActionGate → adapter | db dump temp + `/api/conversations`; audit mẫu: `{proposed_action:"SEND_REPLY:VARIANT", execution_result:"FAILED"}` |
| 12 | Mock mode (`CHANNEL_MODE` trống) | cả 3 webhook → **503** rõ ràng "live adapter not enabled"; health providers mode=mock | — | probe trên :8210; `server.js:940,949,961,976` |

**A = PASS.** Route KHÔNG chứa sales logic (chỉ VERIFY→NORMALIZE→receive/ingestReceipt→ACK),
đúng kiến trúc mục 5 của P2 doc.

## B. SECRETS AUDIT

1. **Không secret thật/hardcode trong code + UI + docs**: grep 3 pattern (`EAAG|EAAB|EAAA…8+`,
   `(secret|token|password|api_key)\s*[:=]\s*['"]…16+…['"]`, `Bearer <literal>`) trên
   `server.js`, `src/channel/*`, `src/shipping/*`, `src/live-*.js`, `ui/`, `docs/P2-LIVE-INTEGRATION.md`
   → **0 kết quả**. Chỉ có biến env + placeholder trong `.env.live`.
2. **API không rò secret khi live-giả**: bắn 7 endpoint (`/api/health`, `/api/settings`,
   `/api/conversations`, `/api/orders`, `/api/products`, `/api/customers`, `/api/dashboard`) trên
   server live-giả đang giữ 7 fake secret trong env → **0/7 substring secret**, và 0 key có tên
   nhạy cảm (secret|token|access…) chứa giá trị chưa redact. Provider status chỉ metadata
   (`mode/configured/connected/status_label/last_*/token_expired/quota_verified/environment`).
3. **Log không in token**: `console.*` **không tồn tại** trong cả 5 file adapter/live;
   log 2 server boot (mock + live) **0** chứa secret đã tiêm; log 6 test suite **0** chứa các
   fake token của battery (`EAAG_fake_page_token_123456`, `AT_NEW_123456`,
   `ghn_token_secret_445566`, `zalo_access_secret_776655`, `meta_app_secret_hush8877`).
4. **`.env.live` sạch**: 15 key, giá trị RỖNG (chỉ `META_API_VERSION=v21.0`,
   `GHN_BASE_URL=dev…` là default không phải secret); battery S3 + đọc trực tiếp xác nhận
   không bị ghi đè giá trị thật. `data/live/` (token store Zalo) **không tồn tại** trong project
   gốc — battery ghi token file trong `data/test-runs/` (đúng thiết kế tách khỏi dataDir test).

**B = PASS.**

## C. DUPLICATE / IDEMPOTENCY (adapter thật — probe độc lập tự viết + battery)

| Check | Kết quả | Evidence |
|---|---|---|
| Meta: 2 webhook trùng platform id | **PASS** — `receive()` lần 2 `{duplicate:true}`; inbox đúng 1 event; 1 user message row; battery M6 PASS; trace HTTP #6 | probe `jev-probe-c.js` C1; `gateway` INV-1 qua `event_id=channel:platformEventId` |
| GHN: cùng ClientOrderCode create 2 lần (+ lần 3 với idempotencyKey gate khác) | **PASS** — HTTP create đếm được = **1**; cả 3 lần trả cùng `GHN_C2_1`; battery G1 PASS | probe C2; memo `createdByCode` `ghn-adapter.js:130-141` |
| Zalo refresh 5 luồng đồng thời (http mock chậm 150–200ms) | **PASS** — đúng **1** HTTP refresh, cả 5 caller nhận cùng cặp token xoay vòng, file atomic không còn `.tmp`; battery Z1/Z2 PASS | probe C3; single-flight promise `zalo-adapter.js:184-193` |

Ghi chú (không phải fail claim): gọi `refreshToken()` TUẦN TỰ lần 2 vẫn refresh HTTP thêm 1 lần —
đây là API force-refresh theo hợp đồng (doc ghi "dùng ở route/health/test"); **không có caller
runtime nào** (grep `server.js/src/app/action-gate/pipeline/gateway` → 0), đường gửi thật
`sendMessage` kiểm tra `tokenUsable()` trước (`zalo-adapter.js:299`). Xem MINOR-3.

**C = PASS.**

## D. PERSISTENCE

- Battery `test/live-adapters.js` P1/P2: **PASS** (chạy lại exit 0).
- Probe độc lập với **3 PROCESS node riêng biệt** (spawn thật, không chung bộ nhớ):
  init 3 tin + 1 đơn → `{customers:2, conversations:2, messages:6, orders:1}` đơn CONFIRMED,
  `SHA256(db.json)=c313348e…53909a` (SHA khác số của CODEX vì dữ liệu probe khác — cái cần
  chứng minh là BẤT BIẾN, không phải số cụ thể). Sau restart #1/#2/#3:
  counts giữ nguyên + SHA **giữ nguyên từng lần** + đơn CONFIRMED & draft đọc lại được +
  `db.backup.json` tồn tại và SHA backup === SHA db.json.
- Reset-mode (mặc định) giữ hành vi cũ: App mới KHÔNG persist → dataDir bị xoá sạch
  (probe: customers 1 → 0); toàn bộ suite cũ (phụ thuộc reset) chạy lại PASS exit 0.

**D = PASS.**

## E. POLICY KHÔNG BỊ BYPASS

Đối chiếu code (grep toàn src):

1. **Đường gửi đi DUY NHẤT**: `src/action-gate.js:476` — `const res = this.platform.sendMessage({clientMessageId, to: conversation.conversation_id, text})` nằm trong `executeSend`, chỉ chạy sau `authorize()` ALLOW (authorize ở `:173` và **re-check trong cùng transaction** ở `:442` — chống race mode-flip). Ngoài đó: `zalo-adapter.js:429` chỉ là ChannelRouter ĐỊNH TUYẾN (không policy).
2. **Adapter không tự gửi khi nhận webhook**: `normalizeWebhook` của cả 3 adapter chỉ build mảng `events[]/receipts[]/ignored` — grep `send` trong normalize path: 0 lời gọi gửi; HTTP ra mạng chỉ tại `meta-adapter.js:218` (sendMessage), `zalo-adapter.js:134` (refresh), `:308` (sendMessage), `:358` (getQuota — ĐỌC quota cho gate), `ghn-adapter.js:96` (`_post` dùng bởi interface carrier giống MockCarrier).
3. **Policy nằm một chỗ ở gate** (`src/action-gate.js:229-308` SendPolicy): bot_off `:247`, takeover `:248,254`, opt_out `:257`, system whitelist `:260-271`, WINDOW 24h FB `:272-288` (spoof human_agent bị REJECT `:280`), QUOTA Zalo `:289-295` (exhausted/low). Adapter **không chứa logic policy**: grep `authorize|windowState|opt_out|bot_enabled|needs_human|window_closed|quota_low` trong 3 adapter → chỉ có comment + việc PHÂN LOẠI webhook `unfollow` thành event `opt_out_signal` (`zalo-adapter.js:272-282`) — tức đưa tín hiệu VÀO pipeline xử lý theo case 18, không phải quyết định policy.
4. **Bằng chứng runtime (trace A#11 + battery)**: event user cũ 25h qua adapter THẬT vẫn bị gate chặn `fb_window_closed`, 0 platform call (battery M7 PASS); W2 xác nhận live-mode giữ BL-5 (`SENT_PENDING_RECEIPT`, chưa phải DELIVERED); trace thực: adapter trả lỗi → worklist `send_failed:…` + audit FAILED — không có lối nào gửi ngoài gate.

**E = PASS.**

## F. REGRESSION + UI

| Suite | Kết quả | Exit |
|---|---|---|
| `test/18-cases.js` | 18/18 PASS | 0 |
| `test/invariants-check.js` | 6/6 vùng PASS | 0 |
| `test/gate-a.js` | 7/7 PASS | 0 |
| `test/p3b-cases.js` | 11/11 PASS | 0 |
| `test/p3c-cases.js` | 28/28 PASS | 0 |
| `test/live-adapters.js` | 26/26 PASS (M1-M8, Z1-Z6, G1-G5, P1-P2, S1-S3, W1-W2) | 0 |

- `node --check` toàn bộ `src/**`, `test/**`, `server.js`, `ui/app.js` → sạch.
- Boot server: `/api/health` có `modes` + `providers {meta,zalo,ghn}` với
  `mode/configured/connected/status_label/last_webhook_at/last_success_at/last_error_type`
  (mock boot: mode=mock, CONNECTED; live boot: mode=live, DISCONNECTED/TOKEN_EXPIRED/… đổi ĐỘNG
  theo trạng thái adapter — xác nhận cả 2 lần boot).
- UI Cài đặt hiển thị trạng thái động: `ui/app.js:735-754` `renderSettings()` đọc
  `/api/health.providers` + `status_label`, thêm "(mock)" khi `mode!=='live'`, hiện
  `last_error_type`; `server.js:96-126` `statusLabelFor/providersView` là nguồn label; dashboard
  `kenh` dẫn từ providers (`server.js:514-528`, `ui/app.js:148-152`).
- Không secret trong UI: grep 3 pattern trên `ui/` → 0; trang Cài đặt có dòng
  "Không hiển thị secrets/API keys"; 7 API endpoint đã scan 0 leak (mục B.2).
- `GET /` và `/app.js` → 200.

**F = PASS.**

---

## BẢNG TỔNG AUDIT

| Mục | Nội dung | Kết luận |
|---|---|---|
| A | Request trace meta/zalo/ghn + dedupe + pipeline | **PASS** |
| B | Secrets (code/API/log/.env.live) | **PASS** |
| C | Duplicate/idempotency (meta/ghn/zalo refresh) | **PASS** |
| D | Persistence restart ×3 (process thật) + reset-mode | **PASS** |
| E | Policy không bị bypass (SendPolicy một chỗ) | **PASS** |
| F | Regression 6 suite + health/settings/UI | **PASS** |
| — | LIVE runtime với token/Page/OA/GHN THẬT (Meta app+Page, Zalo OA ủy quyền, GHN sandbox, approval template) | **CHƯA XÁC MINH** (đúng như CODEX tự khai; cần tài nguyên thật — danh sách điều kiện ở mục 12 P2 doc) |

## DANH SÁCH VẤN ĐỀ

**BLOCKER: không có.**

**MAJOR (điều kiện trước khi mở webhook ra public URL / go-live — không phủ nhận kết quả offline-verified):**

1. **MAJOR-1 — `/webhooks/ghn` không có lớp xác thực nào** (không HMAC, không IP allowlist, không secret-token trong URL). Route ACK 200 luôn và `onCarrierStatus` VERIFY theo nguồn ngoài → kẻ gọi được endpoint có thể giả status (vd DELIVERED) lái trạng thái đơn/tiền. CODEX đã khai báo ("docs GHN không đặc tả HMAC") — chấp nhận được cho lab, **bắt buộc** thêm xác thực (secret path/query + allowlist IP GHN) trước khi public.
2. **MAJOR-2 — Zalo webhook chỉ từ chối khi header ĐƯỢC GỬI mà SAI** (`server.js:966-969`): request KHÔNG có `X-ZEvent-Signature` vẫn được nhận (trace A#9: 200 OK). Zalo thật luôn gửi header, nhưng nên REJECT khi `ZALO_APP_SECRET` đã cấu hình mà thiếu header để chống giả mạo webhook. (Meta thì nghiêm ngặt: thiếu header → 401 — đã kiểm chứng.)

**MINOR:**

1. **MINOR-1 — `redactDeep` không được áp dụng ở biên xuất**: comment `live-env.js:98-100` nói "mọi object status/health/config PHẢI đi qua đây trước khi ra ngoài", nhưng `server.js` (`providersView/health/settingsView`) trả `providerStatus()` trực tiếp. An toàn thực tế nhờ providerStatus không chứa secret (đã kiểm chứng B.2 + S1) — nhưng lớp phòng thủ sâu này hiện không có đường nào gọi ở server.
2. **MINOR-2 — so sánh chữ ký Zalo không timing-safe** (`zalo-adapter.js:221-222`, `===` thường) trong khi Meta dùng `crypto.timingSafeEqual` (`meta-adapter.js:93`) — không nhất quán; rủi ro timing attack thực tế thấp qua mạng nhưng nên thống nhất dùng timingSafeEqual.
3. **MINOR-3 — `refreshToken()` là force-refresh** (không kiểm tra `tokenUsable()`): gọi tuần tự nhiều lần tạo nhiều HTTP refresh (probe C3: +1 HTTP khi token còn hạn). Hiện không có caller runtime nào nên chưa phải lỗi vận hành; nếu sau này route/health gọi theo lịch, cần check `tokenUsable()` trước (hoặc cron 12h như LIMITATION #8 đã ghi).
4. **MINOR-4 — health mock mode hiển thị `connected:true` / `CONNECTED` cho cả 3 provider mock**: `connected` là suy diễn config (LIMITATION #10 đã khai). UI có hậu tố "(mock)" nên chấp nhận được, nhưng về语义 "connected" dễ gây hiểu nhầm người vận hành rằng đang nối API thật.
5. **MINOR-5 — 2 tiến trình server chung 1 `dataDir` sẽ ghi đè `db.json` của nhau** (Store JSON in-memory per-process, tick 2s persist toàn bộ — ghi nhận trực tiếp khi audit; LIMITATION #7 đã nêu cần SQLite cho đa tiến trình). Không phải regression (không phải cấu hình hỗ trợ) nhưng chưa có guard phát hiện 2 App cùng dataDir.

## GHI CHÚ PHƯƠNG PHÁP (phòng tranh cãi)

- Toàn bộ server boot + probe chạy trên **bản sao** prototype ở `%TEMP%`; project gốc sau audit
  không có thay đổi source/test (chỉ data do test suite tạo như mọi lần chạy).
- Một sự cố môi trường khi audit: lần đầu tôi boot 2 server (mock + live) CHUNG dataDir temp →
  db.json ghi đè lẫn nhau giữa 2 tick; đã dừng, làm sạch, chạy lại live-only — kết quả trace
  reproduce 1:1. Đây là artifact kịch bản thử của auditor, không phải bug của prototype
  (thấy đúng LIMITATION #7).
- SHA256 persistence của JEV (`c313348e…`) khác số của CODEX (`1d095872…`) vì dữ liệu probe khác
  (text/id khác); bất biến SHA qua 3 restart mới là claim cần kiểm chứng — và nó ĐẠT.
