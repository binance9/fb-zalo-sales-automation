# P2 — LIVE-INTEGRATION (báo cáo thực thi)

> Người thực thi: CODEX (implementer) — ngày 2026-10-05.
> Phạm vi: thay **mock adapter bằng adapter THẬT ở BIÊN** cho `prototype/` (thuần Node, không
> npm, Git Bash) — **giữ nguyên toàn bộ core P3A/P3B/P3C** (Action Gate, PII strip, event-scoped
> idempotency, window/quota/receipt, takeover — 0 đụng). Căn cứ: `docs/00-yeu-cau.md` (INV-1…5),
> `docs/AI1-capability-matrix.md` (A9/A12/A13/A19/A20, B5/B6/B12/B13/B15, C1),
> `docs/P3C-PLATFORM-CONSTRAINTS.md` (SendPolicy một chỗ, receipt inbound-first).
> Nhãn kết quả: **PASS (MOCK + OFFLINE-VERIFIED)** cho code; **LIVE runtime = CHƯA XÁC MINH**
> (chưa có token/Page/OA/GHN thật — liệt kê đầy đủ ở từng mục kênh).

---

## 0. TỔNG QUAN KIẾN TRÚC (cái gì nằm ở BIÊN, cái gì giữ nguyên)

```
Meta webhook ─GET verify──┐
Meta webhook ─POST────────┤  server.js /webhooks/*  — CHỈ: VERIFY → NORMALIZE →
Zalo webhook ─POST────────┤        app.receive() / app.ingestReceipt() → ACK 200 NGAY
GHN webhook ──POST────────┘        (KHÔNG sales logic trong route; pipeline chạy qua
                                    gateway queue ở tick 2s — < SLA 30s Meta)
        │ app.receive (shape envelope cũ 100%)
        ▼
Gateway (dedupe INV-1 + last_user_event_ts BL-1) → Pipeline → ActionGate (SendPolicy P3C)
        │ platform.sendMessage / platform.getQuota — interface MockPlatform GIỮ NGUYÊN
        ▼
ChannelRouter ──► MetaAdapter (Graph API /me/messages)      [sync HTTP — live-http.js]
              └──► ZaloAdapter (openapi.zalo.me CS + oauth refresh + quota) [sync]
OrderEngine/Pipeline ──► GhnAdapter (create/detail/cancel/fee/webhook)       [sync]
```

- **Chọn adapter bằng env** (`src/live-runtime.js`): `CHANNEL_MODE=mock|live`,
  `SHIPPING_MODE=mock|ghn` (mặc định **mock** — toàn bộ regression cũ chạy mock nguyên trạng).
  Core **KHÔNG biết** OAuth/token/URL — chỉ gọi qua interface có sẵn của MockPlatform/MockCarrier.
- **HTTP ĐỒNG BỘ** (`src/live-http.js`): ActionGate gọi `sendMessage` ĐỒNG BỘ (core không đổi),
  nên HTTP ra mạng chạy sync qua `spawnSync('curl')` (curl có sẵn Windows/Git Bash). Timeout
  curl exit 28 → `{timeout:true}` — đúng hợp đồng INV-2 của gate (không blind-retry).
  Tests **không bao giờ** ra mạng: mọi adapter nhận `httpFn` TIÊM VÀO (dependency injection).
- **Secrets** (`.env.live`, giá trị RỖNG — chỉ key) + parser `src/live-env.js` (env-mini tự viết;
  nạp file nếu tồn tại, **KHÔNG override env có sẵn**). Key: META_APP_ID/SECRET/PAGE_ID/
  PAGE_ACCESS_TOKEN/VERIFY_TOKEN/API_VERSION (mặc định v21.0), ZALO_APP_ID/SECRET/OA_ID/
  ACCESS_TOKEN/REFRESH_TOKEN, GHN_TOKEN/SHOP_ID/BASE_URL (default dev-online-gateway.ghn.vn),
  WEBHOOK_PUBLIC_BASE.

## 1. FILES CHANGED / NEW

| File | Loại | Nội dung |
|---|---|---|
| `.env.live` | MỚI | template secrets, giá trị RỖNG |
| `src/live-env.js` | MỚI | env-mini parser + `redactSecret`/`redactDeep` (CỨM secrets) |
| `src/live-http.js` | MỚI | HTTP sync (curl spawnSync); timeout → `{timeout:true}` |
| `src/channel/meta-adapter.js` | MỚI | adapter Facebook/Messenger (mục 2) |
| `src/channel/zalo-adapter.js` | MỚI | adapter Zalo OA + `ChannelRouter` (mục 3) |
| `src/shipping/ghn-adapter.js` | MỚI | adapter GHN (mục 4) |
| `src/live-runtime.js` | MỚI | factory chọn adapter theo env; trả `null` khi mock |
| `src/app.js` | sửa (additive) | persist mode + cắm externals/adapters; mock path giữ NGUYÊN |
| `src/store.js` | sửa (additive) | `loadIfExists` — chỉ nạp db.json khi App persist mode |
| `server.js` | sửa | 3 webhook routes + health/providers + settings/providers + kenh theo provider |
| `ui/app.js` | sửa | Tổng quan + Cài đặt hiển thị `status_label` + mode/last_error |
| `test/live-adapters.js` | MỚI | battery 26 test offline (mục 8) |

Không đụng: `action-gate.js`, `gateway.js`, `pipeline.js`, `order-engine.js`, `shipping.js`
(MockCarrier/MockPlatform nguyên trạng cho regression), `session.js`, `takeover.js`,
`system-templates.js`, toàn bộ test cũ.

---

## 2. META (Facebook/Messenger) — `src/channel/meta-adapter.js`

**Trạng thái: CODED — Offline-Verified. LIVE runtime CHƯA XÁC MINH.**

Thiết kế đã code + verify offline (test M1–M8):
- **Webhook verify (GET)**: echo `hub.challenge` khi `hub.mode=subscribe` + `hub.verify_token`
  trùng `META_VERIFY_TOKEN`; sai → 403.
- **Chữ ký POST**: `X-Hub-Signature-256` = HMAC-SHA256(**raw body**, `META_APP_SECRET`), so
  timing-safe (`crypto.timingSafeEqual`); sai/thiếu → 401, KHÔNG ACK.
- **Normalize inbound → shape app.receive() đang hiểu**:
  - `entry[].messaging[].message` (không echo) → event `type:'message'`, **`mid` = platformEventId**
    (dedupe INV-1 tầng gateway), `customer_ref/thread_id = PSID`, kind text/image/voice/file/sticker
    (sticker nhận cả type mới lẫn giai đoạn chuyển đổi — matrix A5), `timestamp_platform` từ
    `m.timestamp` (window BL-1 đọc đúng mốc này).
  - `message.is_echo` → **receipt** `message_echo` (bằng chứng send, KHÔNG phải user event —
    không mở window).
  - `delivery` → receipt `message_delivery` (per-mid); `read` → receipt `message_read`.
    Đều đổ vào `app.ingestReceipt()` → receipt store inbound-first BL-5 (match outbound_pending).
  - Page `changes[].field='feed'` comment add → event với **`comment:<comment_id>`** =
    platformEventId, `customer_ref='fbuser:<id>'`, ghi `comment_id/post_id/parent_id` (đầu vào
    private reply A8). Verb remove/edited + postback → ignored (đếm, không event).
- **Outbound**: `POST graph.facebook.com/{v}/me/messages` (mặc định v21.0), text + template
  (attachment object), **token đi header `Authorization: Bearer`** (không nằm trong URL/log).
  Implement ĐÚNG interface `sendMessage({clientMessageId,to,text,template})` của ActionGate —
  **gate chỉ gọi sau khi authorize ALLOW** (SendPolicy một chỗ, adapter không tự gửi, không biết
  window/quota). Response `{message_id}` → `{ok:true,mid}`; lỗi 190/10/200 → `last_error_type='auth'`
  (health → PERMISSION_REQUIRED); timeout → `{ok:false,timeout:true}` (INV-2).

**Cần gì để bật LIVE (CHƯA XÁC MINH tới khi làm được hết):**
1. Meta App (dev) + Page thật; fill `.env.live`: `META_APP_ID/SECRET`, `META_PAGE_ID`,
   `META_PAGE_ACCESS_TOKEN` (long-lived Page token theo A20), `META_VERIFY_TOKEN`.
2. Subscribe webhook: `POST /{page-id}/subscribed_apps?subscribed_fields=feed` + field
   `messages`; cần `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`,
   `pages_show_list` (A6/A21). Public URL HTTPS cho webhook (`WEBHOOK_PUBLIC_BASE`) + verify qua
   GET challenge.
3. `appsecret_proof` cho mọi server call (A20) — **chưa code** (ghi KNOWN LIMITATIONS).
4. Xác minh còn treo theo matrix: A7 rep comment công khai (CHƯA XÁC MINH — chỉ định private
   reply), A13 Utility template approval thật (`utility_approved` hiện là mock-approved của P3C),
   A12 HUMAN_AGENT eligibility.

## 3. ZALO (OA) — `src/channel/zalo-adapter.js` (+ `ChannelRouter`)

**Trạng thái: CODED — Offline-Verified. LIVE runtime CHƯA XÁC MINH.**

- **Token lifecycle (B13)**: refresh `POST oauth.zaloapp.com/v4/oa/access_token`, header
  `secret_key`, body `{refresh_token, app_id, grant_type:'refresh_token'}` (nguyên văn SDK Zalo).
  **SINGLE-FLIGHT promise lock**: 5 gọi đồng thời với mock http chậm 200ms → **đúng 1 HTTP call**,
  cả 5 nhận cùng cặp token mới (test Z1). **Refresh token XOAY VÒNG** → lưu ĐÈ CẢ HAI token
  **ATOMIC** (ghi `.tmp` + rename; file `data/live/zalo-token.json` — **riêng ngoài dataDir test**;
  không để lại `.tmp` — test Z2). `expires_in` → `expires_at`; API không trả hạn → 0 (không biết —
  không bịa). Token file là nguồn mới nhất (rotation), adapter mới nạp lại từ file, không refresh thừa.
- **Webhook normalize**: `user_send_text` / `user_send_image` → envelope (`msg_id` =
  platformEventId → dedupe INV-1; 1 user = 1 thread với OA). `user_send_audio` → kind `voice` +
  cờ **`voice_not_enabled:true`** (CHỈ ĐÁNH DẤU chưa bật — pipeline rơi nhánh ASR-fail →
  NEEDS_HUMAN, không bịa text, đúng case 4). `user_seen_message` → receipt (BL-5).
  `unfollow` / `user_withdraw` → `opt_out_signal` (case 18, B15). Sự kiện khác → ignored (đếm).
  Verify `X-ZEvent-Signature = sha256(appId+data+timeStamp+OAsecretKey)` khi có header (B12) —
  sai → 401 ở route.
- **Outbound CS**: `POST openapi.zalo.me/v3.0/oa/message/cs`, `access_token` đi **header**,
  body `{recipient:{user_id}, message:{text}}`. Sync theo hợp đồng gate. **ĐỌC response**:
  HTTP 200 + `error===0` mới là ok (`mid` từ `data.msg_id`); `error!==0` → fail rõ; lỗi
  token/auth (-10/31/420/-401) → đánh dấu `token_expired` (lần gửi SAU refresh), **không retry
  tin này** (INV-2); timeout → `{timeout:true}`. Nếu hết hạn token ngay lúc gửi: refresh SYNC 1
  lần (single-flight respected — refresh đang chạy → fail RÕ `ZALO_TOKEN_REFRESHING`, không gửi).
- **Quota (B6)**: `POST /v3.0/oa/quota/message` — sync, cache 60s. **Chỉ dùng số API trả về**
  khi account trả field `cs_reply` (`{remain,total,source:'api'}`); API không trả field →
  `{remain:8,total:8,source:'design_default_unverified'}` + `quota_verified=false` —
  **không hardcode giả khi LIVE**: status/UI bào rõ nguồn chưa verified.
  `consumeCs` mirror caller-side (platform trừ phía Zalo) — compat interface gate (BL-2 nguyên trạng).
- **ChannelRouter**: chia `to` theo channel prefix (`facebook:`/`zalo:`) cho adapter đúng;
  `getQuota/consumeCs` chỉ zalo (BL-2 chỉ đọc budget khi channel zalo). Không policy nào ở router.

**Cần gì để bật LIVE:**
1. Zalo App + OA đã xác minh (B14); owner làm flow ủy quyền OA → nhận `refresh_token` đầu tiên;
   fill `.env.live`: `ZALO_APP_ID/SECRET`, `ZALO_OA_ID`, `ZALO_ACCESS_TOKEN/REFRESH_TOKEN`.
2. OA dashboard cấu hình webhook URL → nhận event; chạy thực nghiệm retry (endpoint trả 500) để
   đóng B12 (CHƯA XÁC MINH).
3. Gọi quota API thật (test cả v2/v3 — SDK gọi v2.0) → xác nhận shape `cs_reply`; xác minh
   `product_type=transaction` cho tin transactional (B8) — CHƯA XÁC MINH.
4. ASR cho `.amr` thật — CHƯA bật (voice chỉ đánh dấu, NEEDS_HUMAN).

## 4. GHN (ĐVVC) — `src/shipping/ghn-adapter.js`

**Trạng thái: CODED — Offline-Verified. LIVE runtime CHƯA XÁC MINH.**

Interface GIỐNG MockCarrier → OrderEngine/Pipeline không sửa:
- **createShipment**: headers `Token` + `ShopId`; body `client_order_code` =
  **ClientOrderCode = identity idempotency nội bộ** (`order.order_code`, INV-3). Idempotent
  TẦNG ADAPTER: cùng ClientOrderCode đã CREATED → **trả kết quả cũ, KHÔNG gọi HTTP lần 2**
  (test G1). Attempt TIMEOUT → memo UNKNOWN: lần gọi sau **TRA CỨU detail trước** — thấy
  ALREADY_EXISTS → dùng tracking cũ (`via:'reconcile'`, không bao giờ create lại — test G3,
  đúng case 12/AI3 mục 6); chắc chắn chưa có → tạo lại AN TOÀN cùng key.
- **ĐỌC response code/data — HTTP 200 KHÔNG tự động = thành công**: chỉ
  `{code:"200", data.order_code}` mới CREATED; `code!="200"` → REJECTED rõ kèm message (test G2);
  timeout → TIMEOUT (kết quả chưa biết).
- **detail/tracking** `shipping-order/detail` (theo `client_order_code` hoặc `order_code`);
  status GHN → nội bộ (delivered→DELIVERED, delivering/picked/…→IN_TRANSIT, return*→RETURNED,
  cancel→CANCELLED, delivery_fail/exception→FAILED). `getStatus` ưu tiên **webhook-fed** cache,
  miss → hỏi detail API (`queryOnMiss`).
- **cancel** `switch-status/cancel` `{order_codes:[...]}` — **idempotent** (receipt cũ, 1 HTTP);
  `data[].result===true` mới CANCELLED có `receipt_id`; result false → REJECTED (không huỷ lửng —
  đúng CANCEL_PENDING flow P3B-5).
- **previewFee** (`shipping-order/preview`) — tính phí thật cho production money-guard
  (core mock giữ `MOCK_SHIPPING_FEE` — nguyên trạng).
- **Webhook**: `normalizeWebhook` phòng thủ (snake_case/PascalCase), `event_id` deterministic
  `ghn:<code>:<status>:<time>` → idempotent (lần 2 `duplicate:true`); `applyWebhook` cập nhật
  cache; route ACK 200 NGAY, tìm shipment theo tracking/client_order_code rồi chạy
  `pipeline.onCarrierStatus` (VERIFY từ nguồn ngoài — case 17).

**Cần gì để bật LIVE:**
1. Đăng ký `khachhang.ghn.vn` (miễn phí, self-serve) → `GHN_TOKEN` + `GHN_SHOP_ID` → fill
   `.env.live` (mặc định sandbox `https://dev-online-gateway.ghn.vn` = `environment:'staging'`;
   go-live đổi base URL production → `PRODUCTION_CONNECTED`).
2. Đăng ký webhook URL trong portal GHN; **map địa chỉ**: `to_district_id`/`to_ward_code` là
   BẮT BUỘC trên GHN thật — cần bảng master-data (tỉnh/huyện/xã) khi onboarding shop
   (adapter hiện nhận qua `order.receiver.district_id/ward_code` — **CHƯA có mapper địa chỉ**,
   xem LIMITATIONS).
3. Xác minh shape webhook thật + `service_type_id`/trọng lượng quy đổi (250g/đơn vị là mặc định
   tạm) — CHƯA XÁC MINH cho tới khi tạo đơn sandbox thật.

## 5. WEBHOOK ROUTES (server.js) — VERIFY → NORMALIZE → app.receive() → ACK 200

| Route | Verify | Normalize → | ACK |
|---|---|---|---|
| `GET /webhooks/meta` | challenge theo `META_VERIFY_TOKEN` | — | 200 challenge / 403 |
| `POST /webhooks/meta` | HMAC raw body (401 nếu sai) | events → `app.receive()`; receipts → `app.ingestReceipt()` | 200 `EVENTS_RECEIVED` |
| `POST /webhooks/zalo` | X-ZEvent-Signature (chỉ từ chối khi header ĐƯỢC GỬI mà sai) | như trên | 200 `OK` |
| `POST /webhooks/ghn` | — (docs GHN không đặc tả HMAC công khai) | `normalizeWebhook` → `applyWebhook` → `onCarrierStatus` | 200 `OK` (luôn, idempotent) |

Route KHÔNG xử lý sales logic — pipeline chạy qua gateway queue ở tick 2s (< SLA 30s Meta / 5s ACK).
Mock mode (không adapter) → 503 rõ ràng. **Smoke thật đã chạy** (boot live-mode + secret giả):
verify challenge 200/403; POST hợp lệ → 200 `EVENTS_RECEIVED` (client thuần Node — curl Windows
làm hỏng UTF-8 body nên chữ ký lệch, xem LIMITATIONS #12); POST sai chữ ký → 401; zalo/ghn 200;
hội thoại sinh ra từ webhook thật và bot trả lời qua pipeline → gate → adapter.

## 6. PERSISTENCE (LIVE MODE)

- `APP_DATA_MODE=reset|persist` (mặc định **reset** — test suite giữ nguyên hành vi).
  Server dùng persist khi `CHANNEL_MODE=live | SHIPPING_MODE=ghn | APP_DATA_MODE=persist`.
- persist = KHÔNG rmSync; lần đầu tạo thư mục; trước khi mở db có sẵn → copy `db.json` →
  `db.backup.json` (backup 1 tầng); `Store` nạp `db.json` (JSON.parse giữ thứ tự key →
  persist() ra bytes y hệt → SHA bất biến).
- **Kết quả restart 3× (battery P1 + run bằng chứng riêng)**: 3 tin + 1 đơn CONFIRMED →
  `{customers:2, messages:6, orders:1}`; sau MỖI restart (App mới cùng dir persist):
  counts GIỮ NGUYÊN + `SHA256(db.json)` GIỮ NGUYÊN:
  `1d095872449a1b064dfcc9731e403df617401057b556664a569c89234cf59013`
  (giống hệt sau restart #1, #2, #3; `db.backup.json` tồn tại và SHA backup === SHA db.json).
  Đơn CONFIRMED + conversation/draft đọc lại được sau restart.

## 7. UI + HEALTH

- `/api/health` trả thêm `modes` + `providers`:
  `meta {provider, mode, configured, connected, status_label, last_webhook_at, last_success_at, last_error_type}`;
  `zalo {…, token_expired, quota_verified}`;
  `ghn {…, environment: staging|production}`. **Không có secret** (adapter không nhét token vào
  status; audit leak-check trong test S1 + smoke curl).
- `/api/settings` trả thêm `providers` (cùng nguồn); `/api/dashboard.kenh` dẫn từ providers.
- Trạng thái UI (Tổng quan + **Cài đặt**) đổi ĐỘNG theo `status_label` do server tính:
  - Facebook: `CONNECTED` / `DISCONNECTED` / **`PERMISSION_REQUIRED`** (last_error_type='auth');
  - Zalo: `CONNECTED` / **`TOKEN_EXPIRED`** / `DISCONNECTED`;
  - GHN: `STAGING_CONNECTED` / `PRODUCTION_CONNECTED` / `DISCONNECTED`.
  Mock mode hiển thị thêm "(mock)". Không hiện token ở bất kỳ đâu.

## 8. TEST BATTERY MỚI — `test/live-adapters.js` (26/26 PASS, offline 100%)

| Nhóm | Test | Nội dung |
|---|---|---|
| META | M1–M8 | signature valid/invalid (body sửa, header sai, thiếu header); verify challenge; normalize text/comment/delivery/read/echo (echo KHÔNG thành user event); dedupe trùng platform id qua App thật (đúng 1 tin); **event user cũ 25h → Gate chặn `fb_window_closed`, 0 platform call (không đổi gate)**; token đi header không nằm trong URL; timeout → `{timeout:true}` |
| ZALO | Z1–Z6 | **single-flight refresh** (5 gọi đồng thời, http chậm 200ms → đúng 1 HTTP, cả 5 nhận token mới); atomic save + rotation + không còn `.tmp` + adapter mới nạp file; normalize text/image/audio(seen/unfollow); **HTTP 200 + error≠0 KHÔNG phải thành công**; quota: chỉ tin field API, không trả field → `design_default_unverified`; webhook signature sha256(appId+data+ts+secret) |
| GHN | G1–G5 | **create idempotent** (cùng ClientOrderCode → HTTP lần 2 không xảy ra, trả đơn cũ); response code lỗi → REJECTED; timeout → memo UNKNOWN → attempt sau tra cứu trước (ALREADY_EXISTS → tracking cũ, 0 create thừa); cancel idempotent (1 HTTP, cùng receipt; result:false → REJECTED); webhook normalize idempotent + getStatus đọc cache 0 HTTP |
| PERSISTENCE | P1–P2 | restart ×3 SHA256 db.json + counts giữ nguyên + backup 1 tầng; mặc định (reset) giữ hành vi cũ |
| SECRETS | S1–S3 | live-mode giả: providerStatus cả 3 adapter KHÔNG chứa token/secret nào (kể cả state nội bộ, URL request); redact `***`+4 cuối; env-mini không override env có sẵn; `.env.live` đủ key + secret RỖNG |
| WIRING | W1–W2 | env chọn mock/live; router chia kênh; App nhận externals → gate gọi adapter qua interface, BL-5 giữ nguyên (`SENT_PENDING_RECEIPT`) |

## 9. REGRESSION (bắt buộc exit 0 — chạy sau thay đổi cuối cùng)

```
node --check toàn bộ src/*.js + src/channel/*.js + src/shipping/*.js + test/*.js + server.js + ui/app.js  -> PASS
node test/18-cases.js          -> 18/18 PASS, exit 0
node test/invariants-check.js  ->  6/6 vùng PASS, exit 0
node test/gate-a.js            ->  7/7 PASS, exit 0
node test/p3b-cases.js         -> 11/11 PASS, exit 0
node test/p3c-cases.js         -> 28/28 PASS, exit 0
node test/live-adapters.js     -> 26/26 PASS, exit 0  (offline)
boot server (mock)  : /api/health + /api/settings providers OK; GET / + /app.js = 200; webhooks 503 rõ ràng
boot server (live giả): meta verify 200/403; POST sig hợp lệ 200 / sai 401; zalo/ghn 200;
                        bot trả lời qua webhook thật (pipeline→gate→adapter);
                        token giả bị Graph từ chối → NEEDS_HUMAN + health PERMISSION_REQUIRED;
                        leak-check secrets trên health: NONE
```
**0 expectation của test cũ bị đổi** — gate-a/p3b nguyên trạng; 18-cases/invariants/p3c chạy lại
nguyên file (chỉ sửa code, không sửa test cũ).

## 10. SECRETS AUDIT

| Bề mặt | Kiểm soát | Bằng chứng |
|---|---|---|
| `.env.live` | giá trị RỘNG; chỉ key; không commit giá trị | test S3 |
| Log/debug | `redactSecret` = `***` + 4 ký tự cuối (rỗng → `(empty)`) | test S2 |
| API/UI (`/api/health`, `/api/settings`, dashboard) | adapters chỉ trả metadata; smoke + test S1 assert 0 secret substring trong JSON | S1 + smoke |
| Outbound HTTP | token đi HEADER (Meta `Authorization: Bearer`, Zalo `access_token`, GHN `Token`) — không nằm trong URL/query | M8, Z2, G1 |
| Token store | file `data/live/zalo-token.json` ngoài dataDir test; atomic (tmp+rename) | Z1/Z2 |
| Model context | core BL-3 nguyên trạng — secrets KHÔNG BAO GIỜ vào prompt (adapter nằm ngoài pipeline ctx) | kiến trúc + P3A regression |

## 11. KNOWN LIMITATIONS

1. **HTTP ĐỒNG BỘ** (curl spawnSync) — blocking event-loop lúc chờ mạng; chọn để giữ hợp đồng
   sync của ActionGate mà không sửa core. Production: async fetch + worker nền.
2. **`appsecret_proof` (Meta) chưa code**; template Utility/HUMAN_AGENT vẫn là mock-approved của
   P3C (`ACK_DLQ` v.v.) — live cần approval thật (A12/A13).
3. **Comment FB**: normalized thành message event nhưng outbound vẫn là Send API thường —
   private reply theo `comment_id` (A8) **chưa code**; rep công khai A7 vốn CHƯA XÁC MINH.
4. **Zalo**: gửi CS v3.0; tin transaction/promotion (B7/B8) chưa phân loại `product_type`;
   media (ảnh/voice) chỉ lưu URL nền tảng — gateway tải media thật chưa làm (gateway mock
   `mock-bytes` giữ nguyên); ASR `.amr` chưa bật (voice → NEEDS_HUMAN có cờ).
5. **GHN**: thiếu mapper địa chỉ → `to_district_id`/`to_ward_code` (bắt buộc thật); trọng lượng
   quy đổi 250g/đơn vị tạm; shape webhook thật CHƯA XÁC MINH (normalize phòng thủ).
6. **Zalo quota fallback**: API không trả `cs_reply` → dùng 8/48h thiết kế NHƯNG đánh dấu
   `design_default_unverified` + `quota_verified=false` (không fake verified).
7. **Persistence 1 tầng** (`db.backup.json`); `audit.jsonl` append-only không rollback; Store
   vẫn là JSON in-memory (đa tiến trình thật vẫn cần SQLite — giữ nguyên ghi chú P3C).
8. **Zalo refresh sync trong sendMessage**: nếu refresh đang chạy ở luồng async khác → fail RÕ
   `ZALO_TOKEN_REFRESHING` (an toàn, không gửi) — production nên refresh định kỳ (cron 12h, B13).
9. Receipt matching (heuristic P3C) giờ nhận thêm receipt THẬT từ webhook (delivery/read/echo/
   seen) — độ chính xác trên nền tảng thật vẫn CHƯA XÁC MINH (giữ nguyên mục 14 P3C).
10. Health `connected` là suy diễn từ config + lỗi gần nhất; chưa có heartbeat chủ động tới
    nền tảng (production: ping định kỳ + re-subscribe theo A19).
11. Smoke live-mode đã chạm graph.facebook.com THẬT với token giả để chứng minh đường lỗi auth
    (đúng 2 lần, bị từ chối) — battery chính thức thì 100% offline.
12. `curl` trên Windows làm hỏng UTF-8 body khi test chữ ký qua command line (encoding of args)
    — hạn chế của CÔNG CỤ TEST, không phải server: xác minh lại bằng HTTP client thuần Node →
    200/401 đúng.

## 12. CHƯA XÁC MINH (LIVE runtime — cần tài nguyên thật)

| Kênh | Cần để bật (chính xác) |
|---|---|
| META | App + Page thật; 4 secret vào `.env.live`; subscribe webhook (fields `messages`+`feed`) qua `subscribed_apps` với quyền `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, `pages_show_list`; public HTTPS URL; sau đó verify challenge + nhận tin thật + gửi tin thật + đo receipt delivery/read thật |
| ZALO | Zalo App + OA xác minh; owner ủy quyền OA → refresh_token đầu tiên; 4 secret vào `.env.live`; OA dashboard trỏ webhook; thực nghiệm retry (trả 500) đóng B12; gọi quota API thật xác nhận `cs_reply` + `product_type` transaction (B8) |
| GHN | Đăng ký `khachhang.ghn.vn` → Token + ShopId vào `.env.live` (sandbox dev); đăng ký webhook URL; tạo đơn sandbox thật (cần mapper district/ward trước); đo webhook thật |
| Approval Meta | Utility template (`page_utility_messaging`) + HUMAN_AGENT — để ACK_DLQ/follow-up đi được ngoài window trên Messenger thật (hiện mock-approved) |

## 13. FINAL

**FINAL: PASS (MOCK + OFFLINE-VERIFIED)** cho toàn bộ code P2 (26/26 battery riêng + regression
nguyên trạng 18/18 + 6/6 + 7/7 + 11/11 + 28/28, exit 0; boot server mock + live-giả đều OK).

**CHƯA XÁC MINH: LIVE runtime từng kênh** (chưa có token/Page/OA/GHN thật) — danh sách điều kiện
bật từng kênh nằm ở mục 2/3/4/12; không có bất kỳ đường code nào giả lập kết quả mạng rồi gọi
là "supported".

---

## PHỤ LỤC — SUPERVISOR (ZCode) XÁC MINH RUNTIME + HARDENING

### Webhook hardening (JEV MAJOR → đã vá, supervisor tự thực hiện + test)
1. **Zalo fail-closed**: ZALO_APP_SECRET đã cấu hình mà webhook thiếu header X-ZEvent-Signature → **401** (trước đây 200).
2. **GHN webhook token**: SHIPPING_MODE=ghn bắt buộc GHN_WEBHOOK_TOKEN; chưa cấu hình → **503**; sai → **401**; đúng → 200. Key đã thêm vào .env.live.

### Zalo signature — bug thật được phát hiện khi xác minh runtime
`cfg.appId = null` khi ZALO_APP_ID trống → template literal sinh chuỗi **"null"** trong hash
(sha256("null" + body + ts + secret)). Đã vá chuẩn: `${this.cfg.appId || ''}` — appId trống → chuỗi
rỗng. Xác minh runtime: sig chuẩn (appId rỗng) → **200** trên server live thật.

### Supervisor runtime evidence (live-giả: secret test, HTTP thật)
- META verify đúng token → echo 200 · sai token → 403
- ZALO thiếu sig → 401 · sig đúng (đã vá) → 200
- GHN thiếu token → 401 · sai token → 401 · đúng token → 200
- Secrets: health/API/UI không chứa bất kỳ substring secret nào (grep = 0)
- **Persistence LIVE**: restart server thật → counts {customers:5, messages:21, orders:2, receipt_events:11}
  GIỮ NGUYÊN (dashboard 5 khách/2 đơn/380k identical). Ghi chú: byte-level SHA db.json thay đổi do
  đồng hồ re-anchor timestamp khi boot — dữ liệu logic bất biến; SHA bất biến chỉ khi clock đóng băng
  (test suite P2).

### LIVE RUNTIME — CHƯA XÁC MINH (đúng luật, chờ tài nguyên thật)
- META: cần App + Page + META_PAGE_ACCESS_TOKEN (đăng ký developer — SMS) → rồi: META_INBOUND/OUTBOUND/RECEIPT/24H_WINDOW
- ZALO: cần OA + ZALO_ACCESS_TOKEN/REFRESH đầu tiên (OTP) → rồi: ZALO_SEND/QUOTA/SEEN; voice .amr chưa bật
- GHN: cần GHN_TOKEN + GHN_SHOP_ID sandbox → rồi: GHN_FEE/CREATE/TRACKING/CANCEL/WEBHOOK thật
