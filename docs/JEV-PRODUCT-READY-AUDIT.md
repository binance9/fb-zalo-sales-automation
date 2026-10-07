# JEV AUDIT — PHASE PRODUCT-READY (đợt 1 + đợt 2)

> Auditor: JEV (chỉ ĐỌC + chạy thử lấy evidence) · Ngày: 2026-10-05
> Đối tượng: `prototype/` — auth/shop, onboarding + go-live gate, products CRUD/CSV/disabled,
> AI provider + prompt-builder, PWA/notifications/health, matrix runner.
> Căn cứ: `docs/PHASE-PRODUCT-READY-P1.md` + `prototype/docs/PHASE-PRODUCT-READY-P2.md`
> (claim của CODEX) + `docs/00-yeu-cau.md` (contract).
> Phương pháp: đọc code (file:dòng) + **boot server THẬT qua factory `createServer`** (server.js:54)
> ở port 8222 với `authDir`/`shopsRoot` đặt trong TEMP — **không tạo/không sửa file nào trong
> project** (sau audit: `data/auth`, `data/shops` trong project KHÔNG tồn tại = first-run vẫn sạch).
> Harness audit: `C:\Users\BAOAN\AppData\Local\Temp\jev-audit-pr\audit-main.js` (56/56 check PASS).

---

## A. AUTH + SHOP ISOLATION — **PASS (25/25 check)**

| Check | Evidence | Kết quả |
|---|---|---|
| Boot server riêng port 8222 | `createServer({port:8222, authDir:<TEMP>, shopsRoot:<TEMP>, uiDemo:'0', appDataMode:'persist'})` | PASS |
| First-run: GET / khi 0 user → WELCOME | output: `200, title="Chào mừng — tạo tài khoản chủ shop"`; sau setup chưa login → LOGIN | PASS |
| Setup OWNER đầu 200; setup lần 2 → 403 | `SETUP_ALREADY_DONE` (server.js:1663-1674; auth.js:125) | PASS |
| Chưa login → mọi /api/* 401 | 14 path GET + POST /api/products đều **401 UNAUTHORIZED**; GET /app.js → **302 /** (server.js:1774-1781) | PASS |
| 2 shop + user mỗi shop, 2 session | POST /api/shops → `shop-b`; tạo OWNER cho B; login 2 session, `/api/auth/me` đúng shop_id | PASS |
| **Shop A không đọc được dữ liệu B** | B seed qua /api/debug/customer-message → conv `facebook:cust-Bin` + order `ORD4_F4688F/CONFIRMED` + customer. Session A: list conversations=0, orders=0, customers=0; **đọc chéo bằng id của B: conv 404, order 404, customer 404** (server.js:88-109 App-per-shop + resolve theo `user.shop_id`:1789) | PASS |
| AGENT 403 với settings/products-ghi/onboarding/AI | **14/14 đường → 403 FORBIDDEN_ROLE**: GET settings, GET onboarding, POST settings/bot, ai/config, ai/test, prompt/config, products, products/import, onboarding/complete-step, shops (GET+POST), auth/users, PUT+DELETE products. AGENT vẫn READ 200: conversations/orders/products/customers/notifications/health (allowlist server.js:1551-1566, check :1784-1786) | PASS |
| Rate-limit 5 fail/phút → 429 | server riêng: 5 lần sai → 401, **lần 6 → 429 RATE_LIMITED**; đúng mật khẩu trong cửa sổ khóa vẫn **429** (fail-closed — auth.js:200-230, fix SE05 đợt 2) | PASS |
| Cookie HttpOnly | `Set-Cookie: sid=…; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800` (server.js:1540-1545) | PASS |
| Password không plaintext | `data/auth/users.json`: không có chuỗi `password123`; mọi user có `salt` (32 hex) + `passwordHash` scrypt 128 hex (auth.js:28-30,130-139) | PASS |

Ghi chú: cookie không có flag `Secure` (hợp lý cho http localhost — xem Vấn đề mức THẤP #3).

## B. ONBOARDING + GO-LIVE GATE — **PASS**

| Check | Evidence | Kết quả |
|---|---|---|
| Shop mới → 6/7 bước NOT_CONFIGURED + canGoLive=false | GET /api/onboarding (shop-b): `shop-info=NOT_CONFIGURED, facebook=NOT_CONFIGURED, zalo=NOT_CONFIGURED, products=CONNECTED (seed), shipping=NOT_CONFIGURED, ai=NOT_CONFIGURED, test=NOT_CONFIGURED`; **canGoLive=false, progress=1/7** (server.js:803-848) | PASS |
| Bật bot khi thiếu → 403 GO_LIVE_CHECKLIST + reasons | POST /api/settings/bot {on:true} → **403** `GO_LIVE_CHECKLIST`, 4 reasons (server.js:976-994): thiếu shop-info, AI chưa PASS, chưa có kênh, cần GHN vì auto-order bật | PASS |
| Điền đủ điều kiện tối thiểu | complete-step shop-info + ai (provider `local`) + /api/ai/test (local → PASS ONLINE) + facebook (token giả) + shipping (GHN giả) → **canGoLive=true, progress=5/7** (đúng rule 1,4,6 + (2\|3) + 5-vì-auto-order; step `test` chưa làm) | PASS |
| Bật bot sau đủ checklist → OK | POST /api/settings/bot → **200 {on:true}** | PASS |
| Token chỉ GHI, không hiển thị lại | GET /api/settings (B): `META_PAGE_ACCESS_TOKEN → ***0111`, không có chuỗi token thô trong body (ShopSettings.view() redact — shop-settings.js:42-47) | PASS |
| UI wizard | ui/app.js:1109-1120 `renderWizard()` (h1 "Thiết lập shop — wizard x/7"); :921 nút dashboard "Hoàn thiện cấu hình (x/7)"; :1215 nút "BẬT BOT TỰ ĐỘNG" disabled khi !canGoLive; :1317-1320 bắt 403 GO_LIVE_CHECKLIST → mở wizard; :1384-1391 boot mở wizard khi checklist thiếu | PASS |

## C. PRODUCTS + DISABLED — **PASS** (shop B, bot ON sau go-live)

| Check | Evidence | Kết quả |
|---|---|---|
| Thêm SP → bot tư vấn được | POST /api/products `GUONG-CT` 79.000đ → debug/customer-message "gương cầm tay giá bao nhiêu vậy shop" → bot trả: **"Dạ Gương cầm tay bên em có giá như sau nha anh/chị: - size free: 79000đ"**, `subject_sku=GUONG-CT-1` (giá lấy từ ProductDB — đúng nguyên tắc vàng) | PASS |
| Tắt SP (disabled) → bot không còn match | PUT /api/products/GUONG-CT {enabled:false} → tin khách y hệt (ref mới) → **`subject_sku=null`**, bot chỉ trả fallback "Câu này em chưa đủ dữ liệu trả lời ngay được…", KHÔNG còn tên/giá SP (product-db.js:106-171 lọc `enabled===false` ở cả 4 lớp L1-L4) | PASS |
| DELETE = xóa mềm | DELETE /api/products/GUONG-CT → 200; SP vẫn hiện trong list `enabled=false` (đơn cũ vẫn đọc được — server.js:1131-1135) | PASS |
| CSV import 3 dòng (1 lỗi chủ ý) → 2 vào, 1 lỗi | POST /api/products/import → **`imported=2, failed=1, errors=[{line:4, error:"GIA_KHONG_HOP_LE"}]`** — dòng lỗi KHÔNG chặn dòng hợp lệ (csv-import.js:31-81) | PASS |

Bổ sung (đường ẢNH): `src/pipeline.js:410-420` — routeImage cũng chặn SP tắt (`matchDisabled` → NEEDS_HUMAN, không tự trả). P1 mục 5 (CHANGE REQUEST #1 "vision chưa lọc") **đã được duyệt + implement ở đợt 2** — khớp ghi nhận P2 mục 1.

## D. AI PROVIDER + PROMPT BUILDER — **PASS**

| Check | Evidence | Kết quả |
|---|---|---|
| POST /api/ai/test key giả → ERROR, không echo key | config deepseek + `sk-fake…wxyz` → **502 {ok:false, error:"http_status_401"}**, `ai.status=ERROR`, body KHÔNG chứa key (ai-provider.js:121-123 không echo body; key chỉ đi header Authorization) | PASS |
| GET settings → key masked | GET /api/ai/status + /api/settings: `api_key_masked=***wxyz` (4 ký tự cuối), 0 xuất hiện key thô (ai-provider.js:21-26,59-70) | PASS |
| SECRET_IN_PROMPT | POST /api/prompt/config {giongNoi chứa "sk-fake123"} → **400 `SECRET_IN_PROMPT`** + details nêu đúng field lỗi (prompt-builder.js:14-36; server.js:1863-1869) | PASS |
| buildSystemPrompt đủ field form | POST config hợp lệ → 200, prompt chứa GOLDEN RULES + đủ 9 field: giongNoi/cachXungHo/chinhSachDoiTra/gioLamViec/faq/khongDuocNoi/uuTienBan/ngonNgu/quyTacChotDon (prompt-builder.js:38-72); GET /api/prompt persist qua settings | PASS |

Ghi nhận đúng như KNOWN LIMITATIONS: LLM stub (`src/sales-ai.js`) **chưa tiêu thụ** system prompt của prompt-builder (grep: sales-ai.js không import prompt-builder) — prompt-builder là tầng cấu hình chờ adapter LLM thật.

## E. PWA + NOTIFICATIONS + HEALTH — **PASS**

| Check | Evidence | Kết quả |
|---|---|---|
| manifest.webmanifest hợp lệ | GET → **200 `application/manifest+json`**: name="Sales AI Console — Vận hành bán hàng", 4 icons, display=standalone, theme=#db2777 | PASS |
| sw.js: cache static, KHÔNG cache /api | GET → 200 `text/javascript`; source có `startsWith('/api/')` + `startsWith('/webhooks/')` → passthrough, non-GET passthrough, chỉ cache 200/basic (ui/sw.js:55-63) | PASS |
| Icons PNG thật | icon-192.png = PNG **192x192** (864B); icon-512.png = PNG **512x512** (3304B); index.html có link manifest + register sw.js + meta theme-color (ui/index.html:8,9,13,17-19) | PASS |
| /api/notifications needs_human THẬT | khách khiếu nại "shop lừa đảo quá…" qua /api/debug/customer-message → notifications có **2 needs_human từ worklist thật**: `Cần nhân viên: complaint`, `Cần nhân viên: low_evidence:PRICE`; read {all:true} → unread=0 (server.js:1156-1190) | PASS |
| /api/health đủ 8 phần | `components` đủ đúng 8 key: **ai, database, facebook, queue, scheduler, shipping, webhook, zalo** — mỗi phần có status + last_* + uptime_s; database đọc store thật (size_bytes + counts 7 collection) (server.js:596-655) | PASS |
| Health/settings không secret | health + settings không chứa key thô/tokin giả đã lưu (redact toàn bộ đường view) | PASS |

## F. REGRESSION + SECRETS — **PASS (9/9 suite giữ trọn số)**

| Suite | Kết quả (chạy lại NGUYÊN TRẠNG) | Exit |
|---|---|---|
| test/matrix/index.js | **245/245 PASS** (16.4s; 14/14 khu vực: Auth 16, Onboarding 20, Facebook 18, Zalo 18, Shipping 18, Products 15, Conversations 18, Orders 18, Takeover 15, Follow-up 15, Persistence 15, Security 20, PWA/UI 20, E2E 19) | 0* |
| test/product-ready.js | **32/32 PASS** | 0 |
| test/live-adapters.js | **26/26 PASS** | 0 |
| test/e2e-flows.js | **5/5 PASS** | 0 |
| test/18-cases.js | **18/18 PASS** | 0 |
| test/invariants-check.js | **6/6 vùng PASS** | 0 |
| test/gate-a.js | **7/7 PASS** | 0 |
| test/p3b-cases.js | **11/11 PASS** | 0 |
| test/p3c-cases.js | **28/28 PASS** | 0 |

\* Matrix runner **không tự exit** (server test giữ tick timer) → bọc `timeout` trả exit 124 DÙ log đã in đủ "245/245 + MATRIX ĐẠT" — đúng KNOWN LIMITATIONS #6 của P2 doc. 8 suite còn lại exit 0 sạch.

**Secrets: 0 leak.**
- grep `sk-|EAAG|hardcoded password/token` trong toàn bộ `ui/` (*.js/*.html/*.css/*.webmanifest) và `src/` + `server.js`: **0 kết quả**.
- Responses (audit chạy thật): /api/settings, /api/ai/status, /api/ai/test, /api/health, /api/onboarding — không có key/token thô, chỉ `***` + 4 ký tự cuối.
- `.env.live` trong project: **mọi key secret đều RỖNG** (chỉ META_API_VERSION + GHN_BASE_URL có giá trị) — không commit secret thật.
- Dọn dẹp: server audit đã close (không còn listener port 8222/8080); `data/auth` + `data/shops` trong project không hề được tạo (authDir/shopsRoot của audit nằm ở TEMP).

---

## BẢNG TỔNG

| # | Mục | Kết luận |
|---|---|---|
| A | AUTH + SHOP ISOLATION | **PASS** (25/25 check runtime) |
| B | ONBOARDING + GO-LIVE GATE | **PASS** |
| C | PRODUCTS + DISABLED | **PASS** (text path chạy thật; image path xác minh bằng code + matrix C3/C4) |
| D | AI PROVIDER + PROMPT BUILDER | **PASS** |
| E | PWA + NOTIFICATIONS + HEALTH | **PASS** |
| F | REGRESSION + SECRETS | **PASS** (9/9 suite, 0 secret leak) |

**CHƯA XÁC MINH (kế thừa đúng như 2 docs đã khai báo, không phải FAIL):**
1. **LIVE runtime từng kênh** (Meta/Zalo/GHN token thật) — audit chỉ xác minh nhánh lỗi của /api/ai/test với key giả (401 an toàn). Toàn bộ adapter vẫn ở trạng thái "offline-verified" như P2 đã công bố.
2. Bước 7 wizard (test-conversation/test-order qua nút UI thật) — có matrix Onboarding 20/20 + code path (server.js:888-974 withTempBotOn) nhưng audit không bấm nút trong browser thật (ngoài phạm vi 6 mục).

---

## DANH SÁCH VẤN ĐỀ THEO MỨC

**NGHIÊM TRỌNG (chặn go-live): không có.**
**CAO: không có.** **TRUNG BÌNH: không có.**

**THẤP (đã được khai báo trong docs / chấp nhận được cho lab, nên xử lý trước production):**
1. **Token kênh + AI key lưu RAW trên đĩa** trong `data/shops/<shop_id>/settings.json` (thiết kế có chủ ý — adapter cần giá trị thô; mọi đường API view đều redact). Production cần encryption-at-rest/keyring. — `src/shop-settings.js:8-10,42-47`
2. **Session cookie thiếu flag `Secure`** (http localhost — hợp lý hiện tại; bắt buộc bổ sung khi deploy https). — `server.js:1541`
3. **Reset token + session token lưu file JSON local** (`reset-tokens.json`, `sessions.json`) — đúng đề bài lab (không email), đã khai báo KNOWN LIMITATIONS #4 P1.
4. **/api/ai/test gọi mạng ngoài bằng HTTP đồng bộ (blocking event-loop)** — đúng KNOWN LIMITATIONS #2 P1; nhánh lỗi xác minh an toàn (không echo key/body).

**NHẬN XÉT (không phải lỗi, ghi lại để tránh hiểu nhầm):**
1. PWA static (`/manifest.webmanifest`, `/sw.js`, `/icons/*`) trả **302 khi chưa login** (thiết kế session-gated static). Browser fetch chúng kèm cookie nên PVA vẫn cài được khi đã đăng nhập; nếu muốn cài được cả pre-login thì đưa vào `PUBLIC_STATIC` (server.js:1577).
2. Matrix runner không tự exit → exit code 124 khi bọc timeout dù 245/245 (KNOWN LIMITATIONS #6 P2).
3. P1 mục 5 (CHANGE REQUEST #1 vision-path) đã lỗi thời: filter đã được duyệt + implement ở đợt 2 (`pipeline.js:410-420`), P2 mục 1 ghi đúng.
4. Giá trong reply bot in dạng `79000đ` (fmtVND không có dấu ngăn cách nghìn) — thẩm mỹ, số liệu đúng từ DB.
5. Prompt-builder sinh system prompt nhưng LLM stub chưa tiêu thụ — đã khai báo, đúng thực tế code.

---

**KẾT LUẬN AUDITOR: PASS (OFFLINE-VERIFIED) cho cả 6 mục.** Claim của CODEX ở P1 + P2
đối chiếu được với code và runtime thật: không phát hiện bug mới trong phạm vi audit;
các hạn chế còn lại đều đã được khai báo trung thực trong 2 docs. Không sửa file nào
trong project trong suốt quá trình audit.
