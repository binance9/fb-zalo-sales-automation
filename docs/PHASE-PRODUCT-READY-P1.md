# PHASE PRODUCT-READY — ĐỢT 1 (báo cáo thực thi)

> Người thực thi: CODEX (implementer đợt 1) — ngày 2026-10-05.
> Mục tiêu: biến Sales-AI thành sản phẩm **click-là-chạy**: AUTH + multi-shop, onboarding wizard
> 7 bước + go-live checklist, product management thật (CSV import, soft-delete, disabled filter),
> AI provider management, persistence chính thức (persist mặc định) + START-BOT.bat + first-run
> experience. Thuần Node, KHÔNG npm, Git Bash.
> Căn cứ freeze-core: KHÔNG đụng PII strip / Action Gate / SendPolicy / idempotency / receipt
> store / order engine / repurchase / draft TTL / qty extraction / claim-takeover / cancel order /
> window-quota / follow-up. **Ngoại lệ DUY NHẤT được Supervisor duyệt trước**:
> `src/product-db.js` thêm lọc `enabled !== false` trong `searchProduct` (đã làm, có test
> regression riêng C3 + C4).

---

## 0. BEFORE

- Server chỉ có 1 App duy nhất (`data/ui-runtime`), KHÔNG có tài khoản/đăng nhập — ai mở browser
  cũng vào được toàn bộ dữ liệu (hội thoại, khách, đơn).
- Bot bật/tắt tự do, không có checklist go-live; shop chưa cấu hình gì vẫn "bật được" bot.
- Products chỉ có POST/PUT qua overrides file toàn cục (`data/ui-runtime.product-overrides.json`);
  không có import CSV, không có xóa mềm, SP tắt vẫn bị bot match/tư vấn.
- AI là stub cứng, không có chỗ cấu hình provider/key, không có test provider, không có prompt
  theo form cấu hình shop.
- `APP_DATA_MODE` mặc định **reset** (server thường chạy mất dữ liệu khi restart); không có
  START-BOT.bat; mở `/` là thẳng app không phân quyền.

## 1. ARCHITECTURE (auth / shop / App-per-shop)

```
Browser ── cookie sid (HttpOnly, 7 ngày) ──► server.js createServer()
                                             │  Auth (data/auth/{users,shops,sessions,reset-tokens}.json)
                                             │  session → user {email, role OWNER|ADMIN|AGENT, shop_id}
                                             ▼
                       map shop_id → App (LAZY, cache) — MỖI SHOP 1 APP + dataDir RIÊNG
                                             │
                  data/shops/<shop_id>/  ├── db.json (+db.backup.json)      ← store thật của shop
                                         ├── audit.jsonl                     ← audit thật của shop
                                         ├── settings.json                   ← ShopSettings (kênh/AI/prompt/flags)
                                         ├── product-overrides.json          ← overrides sản phẩm của shop
                                         └── media/
```

- **Cô lập shop bằng KIẾN TRÚC**, không phải lọc row: shop A chỉ có đúng 1 App với store riêng;
  mọi API resolve `app = getApp(session.user.shop_id)`. Test A7 chứng minh bằng 2 shop seed:
  conversations/orders/products của B không xuất hiện ở A (đọc chéo order → 404).
- Roles: OWNER = ADMIN = làm được tất cả (OWNER mới tạo được OWNER); **AGENT** chỉ
  conversations + orders (xem/xử lý: send/takeover/handback/cancel) + products & customers
  READ-only — allowlist ở server, còn lại 403 `FORBIDDEN_ROLE` (test A6).
- Password: scryptSync + salt 16B ngẫu nhiên, so `timingSafeEqual`; session token
  `crypto.randomBytes(32)`, file `sessions.json` (restart giữ đăng nhập), sweep hết hạn khi nạp.
- Login rate limit **5 lần THẤT BẠI/phút/IP** (đếm fail — chuẩn practice; khi đã vượt limit thì
  cả mật khẩu đúng cũng bị 429 trong cửa sổ; thành công xóa counter). **FAIL-CLOSED**: limiter
  lỗi → từ chối. Lưu ý: đếm fail thay vì đếm mọi lần thử là quyết định thiết kế (báo rõ mục 6).
- Quên mật khẩu: `forgot` → reset token ghi FILE `data/auth/reset-tokens.json` (30 phút, dùng
  1 lần, không email thật); `reset` đổi mật khẩu qua token.
- `TEST_AUTH_BYPASS=<token>` (env): khi server được bật env này, cookie `sid=<token>` cố định
  quy về user OWNER đầu — **dành cho smoke/test cũ**; không bật env thì đường này không tồn tại,
  UI/API thật vẫn bắt auth đầy đủ (test A10 kiểm cả 2 chiều).

## 2. TỪNG HẠNG MỤC

### 2.1 AUTH + USER/SHOP MODEL — src/auth.js (MỚI)
File users/shops/sessions/reset-tokens JSON trong `data/auth/` (atomic tmp+rename). API mới xem
mục 3. First-run: `setup` CHỈ hoạt động khi 0 user (test A1 chặn setup lần 2 = 403).

### 2.2 ONBOARDING WIZARD 7 BƯỚC + GO-LIVE CHECKLIST
`GET /api/onboarding` → 7 step `{id, ten, status CONNECTED|ERROR|NOT_CONFIGURED, chiTiet}`:
1 shop-info (settings shop: tên+hotline+địa chỉ) · 2 facebook (META_PAGE_ID+TOKEN trong settings
shop hoặc .env.live) · 3 zalo (ZALO_OA_ID + ACCESS/REFRESH) · 4 products (≥1 enabled — seed mặc
định xanh) · 5 shipping (GHN_TOKEN+SHOP_ID) · 6 ai (provider đã test PASS → ONLINE) · 7 test
(2 cờ `onboarding_test_conversation/test_order` do owner bấm nút test ghi lại).
- **GO-LIVE RULE**: bot AUTO bật được khi bước **1,4,6 xanh + (2 HOẶC 3 xanh) + (5 xanh nếu bật
  auto-order)**. `POST /api/settings/bot {on:true}` kiểm → thiếu → **403 `{error:
  'GO_LIVE_CHECKLIST', reasons[]}`** (test B3); tắt luôn cho phép. reasons liệt kê đỏ từng điều
  kiện thiếu, UI hiện kèm nút BẬT AUTO disabled.
- Nút test wizard chạy SỰ KIỆN THẬT qua `app.receive` (đường webhook): test-conversation = bot
  trả lời được; test-order = tạo được đơn CONFIRMED. Trong lúc test, server bật bot TẠM THỜI rồi
  khôi phục NGAY (bọc try/finally, có audit `ONBOARDING_TEST_BOT_TEMP_ON/OFF`, actor rõ ràng —
  core gate không đụng).
- UI: wizard hiện sau login khi checklist chưa đủ (progress x/7), từng bước có form lưu
  `POST /api/onboarding/complete-step`; token chỉ GHI, không bao giờ hiển thị lại.

### 2.3 PRODUCT MANAGEMENT THẬT
- CRUD đầy đủ: POST (đã có) / PUT / **DELETE = xóa mềm** (`enabled=false`, đơn cũ vẫn đọc được) —
  overrides ghi vào `<dataDir shop>/product-overrides.json` (không còn file toàn cục).
- **Bulk import CSV** `POST /api/products/import {csv}` — cột name,sku,price,stock,size,color,
  weight; header bắt buộc name+sku; quote-aware (`"..."` chứa phẩy), CRLF/BOM; dòng lỗi KHÔNG
  chặn dòng hợp lệ, trả `{imported, failed, errors[{line, error}]}` (test C2, C6).
- **Disabled filter (ngoại lệ core ĐÃ DUYỆT)**: `product-db.searchProduct` bỏ qua
  `p.enabled === false` ở CẢ 4 lớp (sku/alias/substring/fuzzy); `getVariant/getStock/getProduct`
  GIỮ NGUYÊN (đơn cũ/hủy đơn không gãy). Regression riêng: C3 (4 lớp không match khi tắt) +
  C4 (pipeline thật: tắt SP → conversation mới hỏi cùng câu → `subject_sku=null`, không còn tư
  vấn giá SP đó).

### 2.4 AI PROVIDER MANAGEMENT — src/ai-provider.js (MỚI)
- Settings AI per shop: `{provider: deepseek|openai|local, api_key, model, timeout, fallback}`
  trong `settings.json` của shop. Sau save, mọi API trả **chỉ masked** `***` + 4 ký tự cuối —
  không đường nào trả key thô (test D1 quét response settings/status/ai-config).
- `POST /api/ai/test` → gọi THẬT 1 request ngắn (deepseek/openai qua httpOnce curl-sync, key đi
  HEADER Authorization); lỗi → `ERROR + last_error` (`http_status_401`, `timeout`, ...) KHÔNG
  echo body; provider `local` = LLM stub nội bộ → PASS offline (ghi rõ nguồn stub).
  `GET /api/ai/status` → `{provider, status ONLINE|ERROR|DISABLED, last_success, last_error}`.
- **Prompt builder** — src/prompt-builder.js (MỚI): `buildSystemPrompt(config)` nhận form
  `{giongNoi, cachXungHo, chinhSachDoiTra, gioLamViec, faq[], khongDuocNoi[], uuTienBan, ngonNgu,
  quyTacChotDon}` → system prompt có GOLDEN RULES (nguyên tắc vàng: LLM không phải nguồn sự
  thật, mọi số từ FACTS/ProductDB, không bịa, không PII) + đúng các mục cấu hình (test D5).
  `validatePromptConfig` **CHẶN LƯU** khi giá trị field chứa pattern secret
  (`sk-…/token/secret/password/api_key`) → 400 `SECRET_IN_PROMPT` (test D2). Prompt KHÔNG đụng
  đường PII strip/FACTS của pipeline (hàm thuần, chỉ nối chỉ dẫn giọng nói).
- Lưu ý phạm vi: LLM stub core (sales-ai.js) KHÔNG đụng — prompt builder là tầng cấu hình cho
  adapter LLM thật ở đợt sau (xem KNOWN LIMITATIONS #5).

### 2.5 PERSISTENCE CHÍNH THỨC
- `server.js` mặc định **PERSIST** khi chạy thường; reset CHỈ khi `APP_DATA_MODE=reset` (test).
  Persist mode: App không xóa dataDir, nạp db.json, copy `db.json → db.backup.json` trước khi
  mở (backup 1 tầng — sẵn có của core, kiểm lại trong E1: restart giữ counts).
- **START-BOT.bat** (Windows): `@echo off`, cd đúng thư mục (`cd /d "%~dp0"`), set
  `APP_DATA_MODE=persist` + `UI_DEMO=0`, sau 3 giây mở `http://localhost:8080`
  (`start "" http://localhost:8080`), chạy `node server.js`, giữ cửa sổ (`pause`).

### 2.6 FIRST-RUN EXPERIENCE
- Chưa có user nào → `GET /` trả trang **WELCOME** tạo OWNER (tên shop + email + mật khẩu) →
  setup xong tự đăng nhập → wizard 7 bước.
- Đã có user, chưa login → `GET /` trả trang **LOGIN** (theme trắng + hồng giữ nguyên).
- Login xong: checklist chưa đủ → wizard trước; đủ → dashboard. Server start in URL;
  Windows tự mở browser (tắt bằng `NO_BROWSER_OPEN=1`). Static của app (`/app.js`, `/api/*`)
  không phát cho người chưa đăng nhập (302 `/` / 401); public chỉ: `/login.html`,
  `/welcome.html`, `/style.css`, `/webhooks/*` (platform gọi), `/api/auth/(setup|login|logout|
  forgot|reset)`, `/api/auth/me`.
- Boot smoke thật (port 8127): welcome → setup 200 → `/` ra app → onboarding trả JSON đúng.
  Sau smoke đã xóa data/auth + data/shops để lần chạy đầu của chủ là first-run SẠCH.

## 3. API MỚI (tổng hợp)

| Method + Path | Auth | Chức năng |
|---|---|---|
| POST /api/auth/setup | public (chỉ khi 0 user) | tạo OWNER đầu + shop đầu, trả cookie |
| POST /api/auth/login | public (rate 5 fail/phút/IP) | đăng nhập → cookie HttpOnly 7 ngày |
| POST /api/auth/logout | session | hủy session |
| GET /api/auth/me | session | user hiện tại |
| POST /api/auth/change-password | session | đổi mật khẩu |
| POST /api/auth/forgot | public | tạo reset token (file local, 30', 1 lần) |
| POST /api/auth/reset | public | đặt lại mật khẩu theo token |
| GET/POST /api/auth/users | ADMIN+ / OWNER+ (tạo OWNER) | quản lý user theo shop |
| GET/POST /api/shops | ADMIN+ / OWNER | danh sách / tạo shop (App+dataDir riêng) |
| GET /api/onboarding | ADMIN+ | 7 bước + canGoLive + reasons + progress x/7 |
| POST /api/onboarding/complete-step | ADMIN+ | ghi cấu hình bước (shop-info/fb/zalo/ghn/ai/settings) |
| POST /api/onboarding/test-conversation | ADMIN+ | test bot trả lời (đường webhook thật) |
| POST /api/onboarding/test-order | ADMIN+ | test chốt đơn CONFIRMED |
| POST /api/settings/bot | ADMIN+ | **kiểm go-live checklist khi bật → 403 + reasons** |
| POST /api/ai/config | ADMIN+ | lưu provider/key/model/timeout/fallback (key không trả lại) |
| GET /api/ai/status | ADMIN+ | status ONLINE/ERROR/DISABLED + masked key |
| POST /api/ai/test | ADMIN+ | gọi thật 1 request ngắn; local = stub PASS |
| GET /api/prompt · POST /api/prompt/config | ADMIN+ | buildSystemPrompt / lưu form (chặn secret) |
| POST /api/products/import | ADMIN+ | bulk CSV, báo dòng lỗi |
| DELETE /api/products/:skuBase | ADMIN+ | xóa MỀM (enabled=false) |
| GET /api/products?q= | mọi role | search tên/SKU/alias |
| (cũ) dashboard/health/conversations/orders/customers/... | theo role | scope theo shop của session |

Mọi API cũ GIỮ NGUYÊN hợp đồng response, chỉ thêm scoping theo shop + role.

## 4. TEST RESULTS

### 4.1 Battery mới — `test/product-ready.js` (offline 100%, HTTP in-process port 0)

```
A1-A10  AUTH      10/10 PASS  (setup/403 setup lần 2 · login sai/đúng · rate limit 429 fail-closed
                          · me/logout/401 · users + 409 trùng email · AGENT 403 settings/ghi
                          · AGENT 200 đọc · shop isolation 2 shop (A không thấy B, order chéo 404)
                          · đổi mật khẩu + forgot/reset + token không tái sử dụng
                          · cookie HttpOnly/SameSite/Max-Age · TEST_AUTH_BYPASS 2 chiều)
B1-B5   ONBOARD    5/5 PASS  (status 7 bước khởi đầu · complete-step xanh · go-live gate 403+reasons
                          · đủ checklist → bot ON 200 + progress 5/7 đúng rule · token chỉ mask)
C1-C6   PRODUCTS   6/6 PASS  (CRUD + xóa mềm · CSV import 2 ok + 1 lỗi + quote-aware
                          · searchProduct lọc SP tắt cả 4 lớp · regression pipeline bot không
                          tư vấn SP tắt · search ?q= · CSV edge: thiếu header/rỗng/CRLF/thiếu SKU)
D1-D5   AI         5/5 PASS  (key chỉ masked · secret-in-prompt chặn 400 · local test PASS ONLINE
                          · httpFn 401/timeout → ERROR + last_error không lộ key · prompt đủ mục)
E1-E6   PERSIST/BUILD 6/6 PASS (persist restart giữ dữ liệu + db.backup.json · START-BOT.bat đúng
                          nội dung · boot 200 login/static/health + mặc định persist · first-run
                          WELCOME · webhook mock 503 không cần auth · node --check mọi file)
TỔNG: 32/32 PASS, exit 0
```

### 4.2 REGRESSION (6 suite cũ — chạy lại NGUYÊN FILE, 0 expectation đổi)

| Suite | Kết quả | Exit |
|---|---|---|
| test/18-cases.js | **18/18 PASS** | 0 |
| test/invariants-check.js | **6/6 vùng PASS** | 0 |
| test/gate-a.js | **7/7 PASS** | 0 |
| test/p3b-cases.js | **11/11 PASS** | 0 |
| test/p3c-cases.js | **28/28 PASS** | 0 |
| test/live-adapters.js | **26/26 PASS** | 0 |

`node --check`: toàn bộ src/*.js (kèm src/channel, src/shipping), server.js, ui/app.js, toàn bộ
test/*.js — PASS. 6 suite cũ KHÔNG cần TEST_AUTH_BYPASS (chúng chạy App-level offline, không qua
HTTP); bypass vẫn được cấp và có test riêng (A10) cho nhu cầu smoke sau này.

### 4.3 BOOT SMOKE THẬT
`node server.js` (port 8127, NO_BROWSER_OPEN=1): log URL + mode; `GET /` → WELCOME khi 0 user →
setup 200 (OWNER + shop `smoke-shop`) → login → `/` ra app → `/api/onboarding` JSON đúng →
`/style.css` 200. Đã dọn dữ liệu smoke để first-run thật sạch.

## 5. CHANGE REQUEST (core — chờ Supervisor duyệt)

1. **Vision/image-match chưa lọc SP tắt** (KHÔNG tự sửa — ngoài phạm vi ngoại lệ đã duyệt): pipeline.routeImage
   dùng mockVision theo SKU ảnh; SP đã tắt về lý thuyết vẫn có thể được match qua đường ẢNH.
   Đề xuất: 1 dòng lọc `product.enabled !== false` tại call-site (pipeline core) + test regression.
   Hiện trạng: đường TEXT (searchProduct — luồng chính) đã đóng bằng ngoại lệ đã duyệt.
2. (Không bắt buộc, để cân nhắc) `SalesAI` stub hiện bỏ qua system prompt do prompt-builder sinh
   — prompt chỉ là cấu hình chờ adapter LLM thật (đợt 2). Không có đường nào ĐỘNG vào PII/FACTS.

Ngoài 2 mục trên: KHÔNG có thay đổi core nào khác (diff core = đúng 1 file product-db.js —
ngoại lệ đã được duyệt).

## 6. QUYẾT THIẾT KẾ (báo rõ)

- Rate limit đếm **lần THẤT BẠI** (5/phút/IP) thay vì mọi lần thử: tránh tự khóa nhau khi dùng
  nhiều user cùng máy; vẫn fail-closed và chặn cả mật khẩu đúng khi đang trong cửa sổ khóa
  (test A3 kiểm cả 2).
- Shop mới (product mode) **bot khởi điểm OFF** — chỉ OWNER bật được sau go-live checklist;
  demo mode (`UI_DEMO != 0`, chạy tay không qua .bat) giữ hành vi cũ bot ON + seed demo để thấy
  ngay sản phẩm sống. START-BOT.bat set `UI_DEMO=0` → đường sản phẩm chính luôn qua checklist.
- Overrides sản phẩm chuyển vào `<dataDir shop>/product-overrides.json` (mọi dữ liệu mới nằm
  trong dataDir shop — persist mode không xóa nên an toàn; reset mode = xóa sạch đúng nghĩa test).

## 7. KNOWN LIMITATIONS

1. LLM thật chưa nối: provider deepseek/openai đã có cấu hình + test kết nối thật (curl-sync),
   nhưng reply vẫn là stub nội bộ (local) — nối LLM vào pipeline là đợt sau (không đụng core).
2. HTTP test AI provider là sync (curl) — blocking event-loop trong lúc gọi (giống adapter P2).
3. Onboarding kênh chỉ kiểm "đã điền token" (presence) — chưa ping Graph/Zalo/GHN để xác minh
   token sống (không ra mạng trong đợt này; LIVE runtime vốn CHƯA XÁC MINH từ P2).
4. Session/refresh không rotate trên use; quên mật khẩu là file local (đúng đề bài — không email).
5. Multi-process (2 server cùng chạy 1 shop) chưa khóa ghi liên tiến trình — Store vẫn JSON
   in-memory per App (giữ nguyên ghi chú SQLite từ P3C).
6. Wizard chưa có bước nhập FAQ động (FAQ rỗng mặc định; có API + prompt builder hỗ trợ sẵn).
7. `TEST_AUTH_BYPASS` chỉ hoạt động khi env được bật tường minh; không bật = không tồn tại.

## 8. FINAL

- **FINAL: PASS (OFFLINE-VERIFIED)** cho phạm vi đợt 1 — auth + user/shop model + cô lập shop
  App-per-shop + onboarding 7 bước + go-live gate + products thật (CSV/soft-delete/disabled
  filter) + AI provider management + persist mặc định + START-BOT.bat + first-run experience.
  Battery riêng 32/32 exit 0; regression 6/6 suite giữ trọn số (18+6+7+11+28+26) exit 0;
  node --check toàn bộ PASS; boot smoke thật OK.
- **CHƯA XÁC MINH: LIVE runtime từng kênh** (Meta/Zalo/GHN token thật) — kế thừa nguyên trạng
  trạng thái từ P2-LIVE-INTEGRATION; đợt này KHÔNG xác minh thêm bất kỳ đường mạng nào.
- CHANGE REQUEST số 1 (vision path lọc SP tắt) chờ Supervisor duyệt trước khi đụng pipeline.

URL/port: `http://localhost:8080` (mặc định, đổi bằng PORT). Chạy sản phẩm: double-click
`START-BOT.bat`. Chạy test: `node test/product-ready.js`.
