# SURI — GATE ĐÓNG LỖI ỔN ĐỊNH VÀ KIỂM SOÁT GIÁ (SURI-STABILITY-GATE)

> Ngày: 2026-10-06 · CODEX (implementer) · Phạm vi: 3 lỗi được giao (flaky / LLM chặn xử lý /
> guard tiền thiếu đơn vị) + ca mới S1-S6 + nghiệm thu lặp CÓ TẢI CÔNG BỐ.
> FREEZE core P3A/P3B/P3C: KHÔNG đụng hành vi đã PASS của Action Gate/SendPolicy/PII/idempotency/
> receipt/order-engine/window/quota/takeover/pipeline. Mọi sửa là ADDITIVE hoặc harness/test-infra.
> Regression sau khi sửa (chạy đầy đủ): 18/18 · 6/6 · 7/7 · 11/11 · 28/28 · 26/26 · 32/32 · 5/5 ·
> 19/19 · 16/16 (suri-p2, gồm F1 `node --check` toàn repo + F2 regression subprocess) — nguyên trạng.

## 0. TÓM TẮT FINAL TỪNG LỖI

| Lỗi | FINAL | Ghi chú |
|---|---|---|
| LỖI 1 — Matrix flaky (fail di chuyển + runner treo) | **PASS (MOCK)** | Nguyên nhân chứng minh được: (a) zombie runner (runner không tự exit từ P1/P2) nhiễm chéo dữ liệu persist; (b) extractMoney đọc số trong MÃ ĐƠN thành tiền; (c) runner có thể treo vô hạn. Đã sửa tận gốc harness + util; nghiệm thu 5/5 lượt có tải 245/245 exit 0 |
| LỖI 2 — Đường LLM chặn xử lý (sync blocking) | **CHƯA SỬA** (đúng dependency giao trước) + **MITIGATION ĐÃ LÀM: PASS (MOCK)** | Gốc: propose SYNC (curl spawnSync chặn event loop — đụng hợp đồng sendMessage async = Action Gate LOCKED). Mitigation không đụng hợp đồng: (a) default timeout 20s→8s; (b) stale-turn rejection trong tx ghi message (takeover/bot-off có sẵn từ P3C — đã xác minh; khách-đổi-ý là MỚI thêm + test S3) |
| LỖI 3 — Guard tiền thiếu số KHÔNG đơn vị | **PASS (MOCK)** | PRICE/VARIANT/STOCK đã được P3C vá bare/k (kiểm chứng lại: đúng — BỊ ĐÈ). Đường BILL/tổng tiền + CHITCHAT LỌT THẬT (probe B1-B3) → đã mở rộng guard theo ngữ cảnh tiền; false-positive control (tổng giỏ + phí ship + qty + mã đơn + SĐT) giữ PASS |

## 1. NGHI THỨC TẢI CÔNG BỐ (khai báo TRƯỚC khi nghiệm thu)

Trong lúc chạy matrix + stability, chạy NỀN 1 server thật của prototype (createServer — tick 2s,
scheduler, persist) seed shop go-live + bot ON, và 3 hội thoại mock (`fb-load-1..3`) nhắn liên tục
**1 tin/2 giây** qua `/api/debug/customer-message` (đi đúng đường webhook → pipeline → gate → audit).
- Script: `test/_load-generator.js` · log: `docs/STABILITY-TRACE/accept-load.log`.
- **Lệch so đề bài (ghi rõ):** đề ghi "server 8080" nhưng 8080 đang có server prototype sống của
  phiên trước (PID 15968, `/api/health` trả 401) và 8081 là freqtrade của chủ → **CẤM đụng tiến
  trình của chủ**; server tải dùng port ephemeral (lần chạy này: 57875), in rõ ở dòng đầu log.
- Tải ngoài môi trường (công bố): máy đang chạy sẵn tiến trình của chủ — `dev-server.mjs`,
  `PhuongAi/server.js`, freqtrade dry-run, `serve-meme-trader.cjs`, `meter.js` — coi là tải nền,
  KHÔNG can thiệp.
- Kết luận KHÔNG lấy lượt đẹp nhất: chấm trên PHÂN BỔ (worst-case + median), giữ TOÀN BỘ log từng
  lượt (cả run tệ) trong `docs/STABILITY-TRACE/`.

## 2. LỖI 1 — MATRIX FLAKY: BEFORE → NGUYÊN NHÂN (CHỨNG MINH, KHÔNG ĐOÁN) → ĐÃ SỬA

### 2.1 BEFORE — tái hiện (mỗi lượt = 1 log trong STABILITY-TRACE, không bỏ lượt tệ)

Đợt 1 — runner NGUYÊN bản (5 lượt, `stab-run-1..5.log`; runner cũ không tự exit nên phải `timeout 150`):

| Run | Tổng | Fail cụ thể |
|---|---|---|
| 1 | 244/245 | PS10 (audit.jsonl < 10 dòng) |
| 2 | 237/245 | CẢ NHÁNH Shipping-draft: SH01, SH03, SH04, SH05, SH06, SH12, SH14, SH16 ("draft tạo cho shN") |
| 3 | **TREO HẲN** — 150s không in một dòng kết quả nào (exit 124 = kill) | — |
| 4 | **TREO HẶN** — y như run 3 | — |
| 5 | 245/245 | — |

Đợt 2 — sau hardening runner (in tiến độ/timeout/exit sạch), 12 lượt liên tiếp (`loop-run-1..12.log`):

| Run | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Tổng | 245 | 245 | **235** | **244** | 245 | 245 | 245 | 245 | **240** | 245 | 245 | **244** |

- run 3 (235): cả area E2E gục 10 case (E2E-A2, A3, A4, B1, C1, C2, D1, E1, E3, G3) + OB12.
- run 4: OB12 ('7/7' !== '6/7') · run 9: OB12 · run 12: E2E-E3 (follow-up "còn SCHEDULED").
- Phân loại bằng chứng (từng case, đọc test + code + dump store lúc fail — KHÔNG đoán):
  - **fail DI CHUYỂN vùng** (Shipping lần này, Onboarding/E2E/Persistence lần khác) = nhiễm dữ liệu,
    KHÔNG phải lỗi logic ứng dụng: mỗi area dùng dataDir RIÊNG (`data/test-runs/matrix-<area>`)
    nhưng runner cũ KHÔNG TỰ EXIT (hạn chế đã ghi KNOWN LIMITATIONS P1 §8.7 / P2 §8.6) → tồn tại
    **2 zombie runner** thật (tasklist: PID 36976 chạy từ 10/5 20:48, PID 37076 từ 10/6 11:04 —
    đúng 2 phiên trước bị treo). Zombie tick 2s **persist db.json của NÓ vào cùng thư mục**;
    matrix chạy `appDataMode=persist` → App mới **NẠP LẠI db.json của zombie**:
    - OB12 7/7: zombie đã chạy qua OB13/OB14 → cờ `onboarding_test_conversation/order=true` sẵn trong db.
    - E2E-A2 state=AFTER_SALES: db của zombie đã đi hết chuỗi (u-ay đã DELIVERED ở run của nó).
    - SH "draft tạo cho shN": đơn của zombie ở trạng thái CONFIRMED/CANCELLED sẵn → `findOne(DRAFT)` rỗng
      (dump lúc fail ghi thấy đơn có **ms timestamps lạ `.925`** — của tiến trình khác — lặp nguyên xi
      giữa 2 run cách nhau 2s).
    - PS10 audit thiếu dòng: audit.jsonl của shop bị zombie tái tạo/ghi đè song song.
  - **TREO HẲN (run 3/4 đợt 1):** runner cũ không có timeout case/watchdog — 1 promise HTTP không
    settle (client không timeout) là treo vô hạn; đè nặng thêm bởi tick của zombie.
  - **Flake họ P3B-5a/1b (phát hiện thêm khi loop 20x):** `extractMoney` đọc số trong **MÃ ĐƠN**
    thành tiền — order_code `ORD5_86033D`: '86033' + 'D' khớp luật `d\b` (/gi) → guard OVERRIDDEN
    oan câu ack huỷ/xác nhận ('tin huỷ nói đúng mã đơn' fail ~1/20-1/400 lần tuỳ rng order_id).
    Ghi chú thiết kế util.js dòng 42 ("mã đơn KHÔNG bị hiểu nhầm là tiền") chưa được regex bảo đảm.

### 2.2 ĐÃ SỬA (tối thiểu, đúng nguyên nhân — không đụng assertion nào, không bỏ case nào)

1. **[FIX-RUNNER-1..5] `test/matrix/index.js`** (test-infra — được phép):
   - in tiến độ theo area/case + elapsed (trước đây chỉ in cuối → treo không biết chỗ);
   - timeout từng case 90s + watchdog toàn cục 10 phút (treo → FAIL có tên/exit 1, không treo vô hạn);
   - **EXIT SẠCH**: đóng mọi server instance cuối runner + flush + `process.exit(code)` in rõ
     `EXIT_CODE=` — xử lý tận gốc KNOWN LIMITATIONS P1/P2 (nguồn của zombie);
   - **RUNNER LOCK**: lockfile + kiểm tra pid sống — runner thứ 2 REFUSE chạy (exit 2) thay vì
     nhiễm chéo dữ liệu (chứng minh được là nguồn flaky).
2. **Dọn zombie**: kill 2 PID matrix zombie đã tìm thấy (chỉ kill tiến trình TEST của lab này,
   không đụng tiến trình khác của chủ).
3. **[FIX-UTIL] `src/util.js extractMoney`**: số tiền phải KHÔNG dính vào một identifier
   (`(?<![A-Za-z0-9_])` trước chữ số + `(?![A-Za-z0-9])` cho nhóm nghìn) — mã đơn/số nhà/ngày
   không còn bị đọc thành tiền; '185000đ/185000k/185.000đ' vẫn nhận (sanity-check 9 case PASS).
4. Chứng minh hậu kiểm: area-loop Shipping **12/12 clean DƯỚI CPU burn** (trước: fail 8 case/lượt);
   loop P3B-5a **1500/1500** (trước ~1/20); p3b 15x + gate-a/18-cases 8x clean; nghiệm thu mục 4.

## 3. LỖI 2 — ĐƯỜNG LLM CHẶN XỬ LÝ (SYNC BLOCKING)

### 3.1 BEFORE — probe định lượng (`test/_probe-stability.js`, trace `probe-before-loi2-loi3.log`)
- Inject httpFn chậm 3s vào đường propose → đo event loop bằng `setInterval(20ms)`:
  **max gap giữa 2 tick = 3015ms** — event loop BỊ CHẶN trọn 3s (tick đói hoàn toàn; bot vẫn trả
  lời sau đó — engine llm:deepseek).
- Chỗ chặn xác minh đúng dòng: `src/live-http.js:39` — `spawnSync('curl', …)` chặn event loop suốt
  thời gian curl; gọi từ `src/sales-ai.js:160-167` (`httpFn || httpOnce`, propose SYNC); pipeline
  gọi thẳng tại `src/pipeline.js:413/433/477`.
- **Worst case = timeout LLM**: mặc định 20000ms (`ai-provider.getAiConfig` + `sales-ai`), cấu hình
  cho phép tới 120000ms → 1 tin khách chặn bot tới 20s (tệ 2 phút nếu chủ đặt max).

### 3.2 ĐÃ LÀM (mitigation không đụng hợp đồng) + CHƯA SỬA (dependency)
- **CHƯA SỬA gốc**: chuyển propose/sendMessage sang async worker = đổi hợp đồng Action Gate
  (LOCKED) — đúng dependency giao trước, ghi nguyên trạng.
- **Mitigation (a) — timeout an toàn**: default timeout LLM **20000 → 8000ms**
  (`src/ai-provider.js` saveAiConfig + getAiConfig, `src/sales-ai.js:166`) — chỉ đổi MẶC ĐỊNH,
  shop cấu hình riêng vẫn được tôn trọng (CFG1 assert cả 2 chiều). Worst-case block: 8s.
- **Mitigation (b) — stale-reply rejection**: xác minh gate hiện tại CÓ re-check trong tx ghi
  message (`executeSend` → `authorize` lại + reserve quota nguyên tử — P3C/BL-8, bắt được
  takeover/bot_off/quota) **NHƯNG THIẾU "khách đổi ý"** → thêm `detectStaleTurn()` trong CÙNG tx
  (`src/action-gate.js`): reply AI của turn cũ bị REJECT `stale_user_change` nếu trong lúc chờ
  khách đã nhắn tin mang tín hiệu HỦY ĐƠN/ĐỔI Ý (bộ regex cancel+change của pipeline, chép nguyên
  văn; CHẶT — câu hỏi bổ sung bình thường KHÔNG bị coi là stale). Áp cho actor `ai` có turn event;
  follow-up/agent/system không đụng.
- Ca chứng minh: **S1, S2, S3** (mục 5) — takeover/bot-off/khách-đổi-ý GIỮA LÚC LLM CHẶN 5s/2s →
  reply muộn bị REJECT, khách không nhận tin lạc đề.

## 4. LỖI 3 — GUARD TIỀN THIẾU SỐ KHÔNG ĐƠN VỊ

### 4.1 BEFORE (probe trên code HIỆN TẠI — không tin báo cáo; trace `probe-before-loi2-loi3.log`)
Subject nến vanilla (DB: 165000/185000/185000), proposal LLM giả với evidence hợp lệ:
| Probe | Đường | Kết quả BEFORE |
|---|---|---|
| "GIÁ SỐC chỉ **92500**" (bare) | PRICE | **BỊ ĐÈ (OVERRIDDEN)** — P3C đã vá thật cho intent tiền |
| "**92.5k**" | PRICE | **BỊ ĐÈ (OVERRIDDEN)** — như trên |
| bill "Tổng tiền **92500**" (bare) | ORDER_DRAFT | **LỌT RA KHÁCH (AUTO_EXECUTED)** |
| bill "còn **92.5k**" | ORDER_CONFIRMED | **LỌT RA KHÁCH (AUTO_EXECUTED)** |
| "**giá 92500**" | CHITCHAT | **LỌT RA KHÁCH (AUTO_EXECUTED)** |
| bill đúng 145.000đ/25.000đ/170.000đ | ORDER_DRAFT | đi bình thường (đúng) |

→ P3C đã chặn intent tiền, NHƯNG đường bill/tổng tiền + CHITCHAT (intent không phải tiền) là lỗ
thật: bare-scan chỉ chạy cho PRICE/VARIANT/STOCK.

### 4.2 ĐÃ SỬA (`src/action-gate.js` sendReply — additive vào khối validation)
- Intent KHÁC PRICE/VARIANT/STOCK: quét thêm bare `\d{4,7}` và dạng `k` **chỉ khi số đứng trong
  NGỮ CẢNH TIỀN** (cửa sổ ±vài từ quanh số khớp `giá|tiền|giảm|còn|tổng|phí`), ngưỡng ≥ 10000.
- Loại trừ giữ nguyên + kiểm chứng bằng case ngược: qty 1-99 (dưới ngưỡng), SĐT (đã mask/độ dài),
  **mã đơn** — cộng thêm fix extractMoney (mục 2.2.3) cho code kiểu `ORD5_86033D`.
- Sau fix (trace `probe-after-loi2-loi3.log`): B1/B2/B3 → **OVERRIDDEN** (không còn số bịa trong
  text tới khách); C1 bill đúng → vẫn AUTO_EXECUTED.

## 5. CA MỚI `test/stability-cases.js` — 13/13 PASS (offline 100%, LLM mô phỏng qua httpFn tiêm)

| Case | Nội dung assert thật | Kết quả |
|---|---|---|
| S1 | AI chậm 5s + takeover giữa chờ (setTakeover trong window chờ) → reply muộn **REJECT 'takeover'**, khách 0 tin bot, audit + metric `gate_rejected_takeover` | PASS |
| S2 | AI chậm + bot OFF giữa chờ → **REJECT 'bot_off'**, 0 tin bot, audit | PASS |
| S3 | AI chậm + khách nhắn "thôi bỏ đơn… đổi ý" giữa chờ → câu tư vấn cũ **KHÔNG được gửi** (REJECT `stale_user_change`), tin đổi ý vẫn được xử lý | PASS (trước khi thêm detectStaleTurn case này FAIL — đúng mục tiêu) |
| S4 | 5 khách nhắn gần như cùng lúc (5 SP khác nhau) → mỗi conv đúng 1 reply, đúng giá SP của mình, KHÔNG cross-talk (assert ranh giới số bằng regex, tránh đếm '65000' ⊂ '165000'), FACTS mỗi propose đúng subject (0 sai ở model layer), không mất tin | PASS |
| S5 | Crash NGAY SAU platform.sendMessage trên đường mua (inject như Gate-A A5) → retry: đúng 1 send, 1 tin out, **1 đơn**, idem key đơn nhất, audit DUPLICATE_SUPPRESSED | PASS |
| S6 | Follow-up sau giao +2 ngày → **restart App (persist)** → follow-up còn nguyên SCHEDULED, chạy đúng hạn sau restart, audit SENT, **đúng 1 execution** (idem `follow_up:<id>`) | PASS |
| G1-G3 | bill/CHITCHAT bare "Tổng tiền 92500" / "còn 92.5k" / "giá 92500" → **OVERRIDDEN**, text tới khách sạch số bịa | PASS (trước fix LỌT — xem mục 4) |
| G4-G6 | FP-control: bill đúng units + **tổng bare KHỚP whitelist** → AUTO_EXECUTED; qty + mã đơn `ORD5_86033D` → AUTO_EXECUTED; PRICE đúng giá bare allowed, giá bịa bare/k → OVERRIDDEN | PASS |
| CFG1 | default timeout LLM = 8000ms; shop override (12s) được tôn trọng | PASS |

Runner suite exit sạch (`EXIT_CODE=` in rõ).

## 6. NGHIỆM THU LẶP CÓ TẢI (5 matrix + 2 stability — GIỮ TOÀN BỘ, không bỏ lượt)

Tải đúng nghị thức mục 1: load server 332 tin / 3 hội thoại / 225s (heartbeat mỗi 10s trong
`accept-load.log`) + tải nền sẵn của máy. Toàn bộ log: `docs/STABILITY-TRACE/accept-run-1..5.log`,
`accept-stab-1..2.log`.

| Lượt | Matrix (245 case) | exit | Stability (13 case) | exit |
|---|---|---|---|---|
| 1 | **245/245 PASS (17.5s)** | 0 | — | — |
| 2 | **245/245 PASS (17.6s)** | 0 | — | — |
| 3 | **245/245 PASS (17.6s)** | 0 | — | — |
| 4 | **245/245 PASS (17.4s)** | 0 | — | — |
| 5 | **245/245 PASS (17.6s)** | 0 | — | — |
| S1 | — | — | **13/13 PASS** | 0 |
| S2 | — | — | **13/13 PASS** | 0 |

Phân bố: worst-case = median = **245/245 · 13/13** (không có lượt tệ để che). So BEFORE cùng cơ chế
đo: worst 235/245 (12-loop) và 237/245 + 2 lượt treo hẳn (5-lượt đầu) → chênh lệch nằm ở nguyên
nhân đã chứng minh và đã vá (mục 2), không phải "chạy hôm máy đẹp".

## 7. KNOWN LIMITATIONS

1. **propose vẫn SYNC** (LỖI 2 gốc CHƯA SỬA — cần async worker + đổi hợp đồng Action Gate LOCKED).
   Mitigation đã giảm worst-case block 20s → 8s và chặn reply stale; production bắt buộc chuyển worker.
2. stale-turn rejection nhận tín hiệu đổi ý theo từ khoá (bộ regex cancel/change của pipeline) —
   khách đổi ý bằng cách nói khác (vd "thôi khỏi") chưa thuộc bộ từ khoá; mở rộng dần theo data thật.
3. Runner lock chặn chạy matrix song song trong cùng máy (exit 2) — chạy song song chủ ý phải xoá
   lock thủ công và hiểu rủi ro nhiễm dữ liệu persist.
4. Area-loop/probe/load script (`test/_probe-stability.js`, `test/_probe-area-loop.js`,
   `test/_load-generator.js`) là dụng cụ của gate, KHÔNG nằm trong matrix runner.
5. deepseek-wire LIVE không chạy lại trong đợt này (không đụng đường wire; thay đổi chỉ thuộc
   timeout default + guard + harness — đã phủ bởi regression offline 10 suite + live suite cũ PASS
   từ P2). Cần 1 lượt LIVE xác minh lại khi nối mạng DeepSeek: CHƯA XÁC MINH (LIVE).
6. Server tải dùng port ephemeral thay vì 8080/8081 (bận — tiến trình của chủ; xem mục 1).

## 8. FINAL

- **LỖI 1: PASS (MOCK)** — nguyên nhân chứng minh bằng evidence (zombie runner + persist reuse +
  mã đơn/extractMoney + runner treo); sửa tận gốc ở harness/util, không nới assertion, không bỏ
  case; nghiệm thu có tải 5/5 lượt 245/245 + 2/2 lượt 13/13, exit code in rõ.
- **LỖI 2: CHƯA SỬA** (gốc sync — dependency Action Gate LOCKED) **+ MITIGATION PASS (MOCK)**:
  timeout default 8s + re-check đầy đủ takeover/bot-off (có sẵn P3C — đã xác minh) + khách-đổi-ý
  (mới — S3 chứng minh).
- **LỖI 3: PASS (MOCK)** — guard bare-number/k mở rộng xuống đường bill/tổng tiền + CHITCHAT theo
  ngữ cảnh tiền; FP-control (tổng + fee + qty + mã đơn + SĐT + giá đúng) giữ PASS; probe
  BEFORE/AFTER lưu trong STABILITY-TRACE.
- Regression nguyên trạng sau mọi thay đổi: 18/18 · 6/6 · 7/7 · 11/11 · 28/28 · 26/26 · 32/32 ·
  5/5 · 19/19 · 16/16 + matrix 5×245/245 + stability 2×13/13 (có tải).
