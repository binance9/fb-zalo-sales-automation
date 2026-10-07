# JEV — AUDIT GATE "SURI — ĐÓNG LỖI ỔN ĐỊNH VÀ KIỂM SOÁT GIÁ"

> Auditor: JEV (read-only + probe lấy evidence, KHÔNG sửa file prototype) · Ngày: 2026-10-06
> Đối tượng: `prototype/docs/SURI-STABILITY-GATE.md` (báo cáo CODEX) + code đã sửa + trace logs
> Phạm vi kiểm: 6 mục A-F. Mọi kết luận dưới đây đều kèm evidence (file:dòng hoặc output lệnh chạy trực tiếp).
> Phạm vi test-runs (`prototype/data/test-runs/*`) bị test/probe ghi đè trong lúc chạy — đây là dữ liệu runtime test, không phải file code/docs.

---

## KẾT LUẬN NHANH

| Mục | Nội dung | Kết quả |
|---|---|---|
| A | Log BEFORE đầy đủ, giữ cả lượt tệ | **PASS** |
| B | Zombie matrix đã chết; cơ chế persist hợp lý | **PASS** — kèm FINDING CAO (zombie tải mới của chính CODEX) |
| C | extractMoney + guard tiền + 13 case + assert thật | **PASS** — kèm 1 hole nhỏ (mức THẤP) |
| D | LỖI 2 khai "CHƯA SỬA root" — trung thực | **PASS (TRUNG THỰC)** |
| E | Nghiệm thu lặp tự chạy lại | **PASS** |
| F | Secrets + regression nguyên trạng | **PASS** |

**Chung: 6/6 mục ĐẠT. 1 finding mức CAO (ngoài phạm vi claim của gate nhưng ảnh hưởng tuyên bố "đã xử lý tận gốc zombie"), 1 mức TRUNG BÌNH (mô tả báo cáo lệch log ở 3 chỗ), 2 mức THẤP.**

---

## A. BEFORE TRACES — PASS

Số liệu: `prototype/docs/STABILITY-TRACE/` có **27 file** = 26 log lượt chạy + 1 log heartbeat tải (`accept-load.log`).

Đợt 1 — runner NGUYÊN bản (`stab-run-1..5.log`) — đối chiếu bảng §2.1 của CODEX:

| Log | Nội dung thực tế trong file | Khớp CODEX? |
|---|---|---|
| stab-run-1 | `TỔNG: 244/245` — fail PS10 `assert.ok(lines.length >= 10)`; `EXIT_CODE=124` | ĐẠT |
| stab-run-2 | `TỔNG: 237/245` — 8 fail Shipping SH01/03/04/05/06/12/14/16, note `"draft tạo cho shN"` | ĐẠT |
| stab-run-3 | TREO: chỉ 3 dòng, không một dòng kết quả; `EXIT_CODE=124`; 12:08:21 → 12:10:51 (150s) | ĐẠT |
| stab-run-4 | TREO y hệt run 3; `EXIT_CODE=124` | ĐẠT |
| stab-run-5 | `TỔNG: 245/245`; vẫn `EXIT_CODE=124` (runner cũ không tự exit) | ĐẠT |

Đợt 2 — sau hardening (`loop-run-1..12.log`) — đối chiếu dòng tổng từng file:

```
run1 245/245 · run2 245/245 · run3 235/245 · run4 244/245 · run5 245/245 · run6 245/245
run7 245/245 · run8 245/245 · run9 240/245 · run10 245/245 · run11 245/245 · run12 244/245
```

= đúng bảng 12 lượt trong CODEX §2.1. Chi tiết lượt tệ: run 3 — E2E 9/19 (10 fail: E2E-A2/A3/A4/B1/C1/C2/D1/E1/E3/G3); run 4 — OB12 `'7/7' !== '6/7'`; run 9 — 5 fail (OB12, ZL08, ZL16, CV05, CV17); run 12 — E2E-E3. **Lượt tệ KHÔNG bị xóa, không bị chỉnh** (mọi file còn nguyên cả dòng FAIL chi tiết).

- [GHI CHÚ TRUNG BÌNH-1] CODEX §2.1 viết "run 3 (235): cả area E2E gục 10 case … **+ OB12**" — log run 3 cho thấy Onboarding **20/20** (OB12 không fail; 235 = 245 − 10 fail E2E). Câu "+ OB12" không khớp file log.
- [GHI CHÚ TRUNG BÌNH-2] CODEX §2.1 viết "run 9: OB12" — log run 9 thực tế gục **5 case** (OB12 + ZL08 + ZL16 + CV05 + CV17). Log gốc trung thực, mô tả báo cáo thiếu.
- Không ảnh hưởng kết luận: các mô tả sai đều theo hướng "nêu ít fail hơn thực tế" và log đầy đủ vẫn được giữ để đối chứng.

---

## B. ROOT CAUSE — ZOMBIE — PASS (kèm FINDING CAO)

### B1. Hai PID CODEX khai đã kill — XÁC NHẬN ĐÃ CHẾT

- `tasklist //FI "IMAGENAME eq node.exe"` + PowerShell `Get-CimInstance Win32_Process` (13:10-13:15 ngày 10/6): **PID 36976 và 37076 KHÔNG TỒN TẠI**; `netstat -ano | grep -E "36976|37076"` → không còn socket nào.
- 12 node.exe còn sống được định danh đủ: meter.js, dev-server.mjs, PhuongAi/server.js, xhands.js, lab-web-research.cjs, server.js (PID 15968 — đúng như CODEX công bố là server phiên trước, không đụng), JEV mcp-server ×4, serve-meme-trader.cjs, **và `_load-generator.js` PID 22152 (xem B3)**. Không còn tiến trình matrix runner nào.
- Không thể kiểm chứng lại thời điểm tạo của 2 PID đã chết (10/5 20:48, 10/6 11:04) — chỉ xác nhận trạng thái hiện tại: đã chết.

### B2. Cơ chế nhiễm chéo persist — ĐỦ HỢP LÝ LÀM NGUYÊN NHÂN

Đọc code hiện tại (cơ chế runner cũ suy ra từ chính harness mới + App):

- `test/matrix/_harness.js:39-53` — `startInst` xóa `data/test-runs/matrix-<name>` rồi `createServer({ appDataMode: 'persist' })`.
- `src/app.js:36-51` — persist mode = KHÔNG rmSync, `Store({ loadIfExists: true })` → App mới **NẠP LẠI db.json có sẵn**.
- `src/app.js:221` — `runDueJobs` gọi `this.store.persist()` mỗi tick; server thật tick 2s → instance SỐNG mãi sẽ **persist lại db.json của nó liên tục** vào cùng thư mục.
- Vậy nếu runner cũ không tự exit (KNOWN LIMITATIONS P1/P2 — đúng như CODEX khai), instance cũ còn tick → ghi đè/xóa state của App mới cùng dataDir → fail DI CHUYỂN vùng theo lượt. Khớp chính xác hiện tượng trong log BEFORE: lượt tệ di chuyển giữa Shipping → Onboarding/E2E; `"draft tạo cho shN"` = đơn CONFIRMED sẵn trong db của zombie; OB12 `'7/7'` = checklist đã complete sẵn; `.925` timestamps lạ = ghi của tiến trình khác.
- Runner mới chặn nguồn này: `test/matrix/index.js:50-77` — lockfile `matrix-runner.lock` + kiểm tra pid sống bằng `process.kill(pid, 0)`, runner thứ 2 REFUSE exit 2; `:83-85` dọn `matrix-*` trước khi chạy; `:150-154,186-192` đóng mọi `ctx.inst.close()` rồi `process.exit(code)` in `EXIT_CODE=`. Sau 2 lượt JEV chạy: lock đã release, không còn treo.

### B3. [FINDING CAO] Zombie MỚI do chính đợt CODEX tạo: load-generator KHÔNG TỰ DỪNG

- **PID 22152 — `node test/_load-generator.js` — tạo 12:59:05 ngày 10/6, VẪN SỐNG đến 13:21+ (giờ audit)**, đang LISTEN port 61148 và đang được bắn tin (các kết nối ESTABLISHED).
- `test/_load-generator.js:18` — `DURATION_S = argv[2] || 0`, comment dòng 8: *"mặc định chạy tới khi bị kill"*. CODEX đã khởi động KHÔNG truyền duration → **chính tool tải này là 1 zombie không tự exit** — đúng mô-típ nguyên nhân LỖI 1 mà gate tuyên bố "xử lý tận gốc", nhưng chỉ xử lý ở matrix runner, KHÔNG xử lý ở tool tải.
- `docs/STABILITY-TRACE/accept-load.log` chứa **≥2 lượt chạy dính nhau**: lượt trước bị persist `ENOENT` giữa chừng (stack `Store.persist → …\load-server\shops\load-shop\db.json`) vì lượt sau `fs.rmSync(ROOT)` (dòng 32) xóa data dưới chân lượt trước — **nhiễm chéo persist tái hiện đúng cơ chế B2 ngay trên tool tải**.
- **Khai báo tải §6 "load server 332 tin / 3 hội thoại / 225s" KHÔNG KHỚP log**: không có dòng "hết hạn 225s — đóng server sạch" nào trong `accept-load.log`; log cho `sent=317 @ t+225s` (lượt 2), và lượt đang sống đạt `sent=1262 @ t+1308s` (13:20), `data/test-runs/load-server/shops/load-shop/db.json` 14 MB vẫn được ghi liên tục (mtime 13:21).
- Đánh giá: KHÔNG đảo kết luận nghiệm thu — tải thực tế khi matrix/stability chạy dày hơn công bố (nghiệm thu là KHÓ hơn, không phải dễ hơn). Nhưng (1) gate không được để lại zombie sau khi kết thúc; (2) con số công bố trong báo cáo không trùng evidence. **Khuyến nghị: kill PID 22152 ngay; sửa `_load-generator.js` tự đóng khi hết giờ (mặc định có hạn); bổ sung công bố đính chính phần tải của §1/§6.**

---

## C. EXTRACTMONEY FIX + FP CONTROL — PASS (kèm 1 hole nhỏ)

### C1. Code mới

`src/util.js:54-55`: `reSuffixed = /(?<![A-Za-z0-9_])(\d{4,})\s*(?:đ|\s?[dk]\b|vnd|vnđ)/gi` và `reGrouped` có `(?<![A-Za-z0-9_])…(?![A-Za-z0-9])` — đúng như mô tả §2.2.3. Comment dòng 42 ("mã đơn KHÔNG bị hiểu nhầm là tiền") giờ được regex bảo đảm cho mã đơn DÍNH identifier.

### C2. Probe tự viết (node inline, evidence output trực tiếp)

1. **Mã đơn không bị coi là tiền** — `extractMoney("Dạ đơn ORD5_86033D của anh/chị đã được xác nhận, tổng 170.000đ.")` → `[170000]` (86033 không vào danh sách); `"tin huỷ nói đúng mã đơn ORD5_86033D"` → `[]`. **ĐẠT**
2. Sanity 9 case: `185000đ / 185000k / 185.000đ / 185,000` → `[185000]`; ngày `15/10/2026` → `[]`; bare `Tổng tiền 92500` → `[]` (do extractMoney bỏ — đúng thiết kế, bare do action-gate quét). **ĐẠT**
3. **[HOLE THẤP-1]** `"số nhà 25 đường 86033D quận 3"` → `[86033]` — số + chữ cái **không dính** identifier phía trước (space trước số) vẫn bị đọc thành tiền. Lookbehind chỉ chặn khi số DÍNH `_`/chữ (mã đơn `ORD5_86033D` được chặn đúng). Ảnh hưởng: FP tiềm năng hiếm gặp (cần số 4-7 chữ số ≥10000 + `d/k` ngay sau). KHÔNG case nào trong 13 case phủ dạng này; không phá claim chính. **Khuyến nghị: bổ sung case + siết regex (vd yêu cầu biên từ hoặc dấu câu sau `d/k`).**
4. **Gate probe độc lập 4/4 PASS** (tái tạo đúng đường `gate.sendReply` như stability-cases):
   - G-case: `"Tổng tiền 92500"` khi subject 185000 → `OVERRIDDEN`, text tới khách sạch số bịa. **ĐẠT**
   - FP-control: `"Phí ship: 25000 … Tổng 210000"` khớp whitelist → `AUTO_EXECUTED` (không bị đè). **ĐẠT**
   - Mã đơn trong câu ack (`ORD5_86033D` + `MOCK-ORD5_86033D`) → `AUTO_EXECUTED`. **ĐẠT**

### C3. Suite + assert thật

- `node test/stability-cases.js`: **13/13 PASS, EXIT_CODE=0** (chạy 2 lần độc lập trong audit — mục C và mục E — đều PASS).
- Đếm assert: **41 assert thật** (`assert.strictEqual`/`assert.ok` đều có message và điều kiện có nội dung; grep không thấy `assert.ok(true)`/skip/TODO).
- **Negative test chứng minh assert có ý nghĩa**: monkey-patch `gate.detectStaleTurn = () => null` trong process probe (KHÔNG sửa file) rồi chạy lại kịch bản S3 → câu stale "185.000đ" **ĐƯỢC GỬI** (đúng như CODEX mô tả hành vi BEFORE) → S3 assert thật, phụ thuộc thật vào fix.

---

## D. LỖI 2 "CHƯA SỬA ROOT" — TRUNG THỰC, ĐẠT

| Claim CODEX | Evidence kiểm trực tiếp | Kết luận |
|---|---|---|
| Root SYNC chưa sửa (spawnSync curl chặn event loop) | `src/live-http.js:39` — `spawnSync('curl', args, …)` vẫn nguyên; header file dòng 2-13 giữ nguyên lý do thiết kế + KNOWN LIMITATIONS; `src/sales-ai.js:124` `propose(intent, ctx)` vẫn SYNC, `:98-101` yêu cầu httpFn sync; app wiring `src/app.js:90` vẫn dùng SalesAI sync. KHÔNG tìm thấy async worker mới nào. | **ĐÚNG — không sửa lén root** |
| Default timeout 20s → 8s | `src/ai-provider.js:38` (`shopSettings.get('ai_timeout') || 8000` trong saveAiConfig), `:67` (getAiConfig `|| 8000`), `src/sales-ai.js:168` (`timeoutMs: cfg.timeout || 8000`); CFG1 assert 8000 + override 12000 được tôn trọng — PASS khi chạy | **ĐÚNG** |
| detectStaleTurn trong CÙNG tx ghi message | `src/action-gate.js:342-368` (hàm tồn tại, chỉ actor `ai` + có turn event), gọi tại `:509-510` bên trong `store.transaction` của `executeSend` TRƯỚC `platform.sendMessage` (`:543`); reject → audit `REJECTED:stale_user_change` + exec FAILED `gate_race:` (`:528-541`) | **ĐÚNG** |
| S1-S3 assert REJECT thật | S1: `outs.length === 0` + audit `REJECTED:*takeover*` + metric `gate_rejected_takeover` (stability-cases.js:110-119); S2: `outs.length === 0` + audit bot_off (:138-142); S3: câu stale KHÔNG gửi + audit stale_user_change + tin đổi ý vẫn được ghi nhận (:162-168). Đã chạy: PASS. Negative-test (mục C3) chứng minh S3 không phải assert khống | **ĐÚNG** |

Không phát hiện trường hợp CODEX tuyên bố "chưa sửa root" mà lại có sửa root. Khai báo trung thực.

---

## E. NGHIỆM THU LẶP (JEV TỰ CHẠY) — PASS

Chạy trực tiếp trong phiên audit (bối cảnh: zombie load-generator PID 22152 vẫn bắn tin nền ~1.5 tin/s — điều kiện tải ≥ điều kiện CODEX công bố):

| Lượt | Suite | Kết quả | Exit | Thời gian |
|---|---|---|---|---|
| JEV-1 | Matrix 245 case | **245/245 PASS** | 0 (`EXIT_CODE=0` in rõ) | 17.9s |
| JEV-2 | Matrix 245 case | **245/245 PASS** | 0 | 17.8s |
| JEV-S | Stability 13 case | **13/13 PASS** | 0 | ~9.6s |

- Đối chiếu bảng §6 CODEX (matrix 5×245/245 @17.4-17.6s, stability 2×13/13): **khớp**, không có lượt tệ mới xuất hiện.
- Runner **exit sạch**: process tự kết thúc sau khi in `EXIT_CODE=0`, không phải kill, không treo; `matrix-runner.lock` được release sau chạy; số dòng kết quả in tiến độ từng area (FIX-RUNNER-1 hoạt động).
- Điểm trừ đã ghi ở mục B3: con số tải công bố trong §6 ("332 tin/225s") không trùng `accept-load.log`.

---

## F. SECRETS + REGRESSION — PASS

- **Secrets trong code mới sửa** (`src/util.js, action-gate.js, sales-ai.js, ai-provider.js, live-http.js, test/matrix/index.js, _harness.js, _load-generator.js, _probe-*.js, stability-cases.js`): chỉ có **fake key test offline** — `sk-probe-key-1234` (`_probe-stability.js:20`), `sk-stab-key-0001` / `sk-cfg-0001` (`stability-cases.js:79,348,352`) — dùng với httpFn tiêm, không ra mạng. **0 secret thật.**
- **Secrets trong logs** (`docs/STABILITY-TRACE/*.log`, grep `sk-<8+>`, `Bearer <10+>`, `api_key` dài): **0.**
- `.env.live`: grep `sk-|token` → 0 dòng khớp (không lộ trong kiểm này).
- **Regression nguyên trạng** (JEV tự chạy, exit 0 từng suite):

| Suite | Kết quả | Exit |
|---|---|---|
| test/18-cases.js | **18/18 PASS** | 0 |
| test/gate-a.js | **7/7 PASS** | 0 |
| test/p3c-cases.js | **28/28 PASS** | 0 |

Khớp dòng regression của CODEX ("18/18 · 7/7 · 28/28 … nguyên trạng").

---

## BẢNG VẤN ĐỀ THEO MỨC

| # | Mức | Vấn đề | Evidence | Khuyến nghị |
|---|---|---|---|---|
| 1 | **CAO** | Zombie mới do chính đợt CODEX: `_load-generator.js` PID 22152 chạy từ 12:59 không có duration → vẫn sống 13:21+, bắn tin liên tục (sent=1262 @ t+1308s), db.json 14 MB ghi liên tục; `accept-load.log` chứa ≥2 lượt dính nhau (ENOENT persist do `rmSync` lẫn nhau) — đúng mô-típ "runner không tự exit" mà gate tuyên bố xử lý tận gốc, nhưng tool tải thì KHÔNG | tasklist/Get-CimInstance 13:10-13:21; `test/_load-generator.js:8,18,32`; `accept-load.log`; mtime db.json | Kill PID 22152; sửa load-generator có hạn mặc định; đính chính phần tải §1/§6 |
| 2 | **TRUNG BÌNH** | Mô tả trong SURI-STABILITY-GATE.md lệch log gốc: (a) §6 "332 tin/225s" — log không có lượt nào dừng 225s (sent=317 @225s; lượt sống 1262 @1308s); (b) §2.1 "run 3 … + OB12" — log run 3: Onboarding 20/20; (c) §2.1 "run 9: OB12" — log run 9 gục 5 case | accept-load.log; loop-run-3.log; loop-run-9.log | Sửa mô tả báo cáo cho khớp log (không đụng log) |
| 3 | THẤP | `extractMoney` vẫn đọc tiền oan dạng "số 4-7 chữ số + d/k" KHÔNG dính identifier ("số nhà 25 đường 86033D" → `[86033]`); lookbehind chỉ chặn khi số dính `_`/chữ | Probe node inline mục C2.3 | Bổ sung case + siết regex biên phải |
| 4 | THẤP | Không thể kiểm chứng lại CreationDate của 2 PID zombie cũ (36976/37076) — đã chết, chỉ xác nhận trạng thái hiện tại | tasklist/netstat | Không cần hành động |

---

## ĐỐI CHIẾU CUỐI VỚI CLAIM CODEX

- LỖI 1 PASS (MOCK): **CÔNG NHẬN** — nguyên nhân có evidence (B2), fix tận gốc harness/util (C, E), nghiệm thu lặp khớp (E).
- LỖI 2 CHƯA SỬA + MITIGATION PASS: **CÔNG NHẬN, TRUNG THỰC** (D) — root vẫn sync đúng như khai, mitigation 8s + stale-reject có test thật.
- LỖI 3 PASS (MOCK): **CÔNG NHẬN** (C) — guard mở rộng xuống bill/CHITCHAT, FP-control giữ PASS; 1 hole nhỏ còn lại ngoài phạm vi case (vấn đề #3).
- Tuy nhiên gate CHƯA "sạch zombie" tuyệt đối như tinh thần "xử lý tận gốc": tool tải của chính đợt nghiệm thu để lại 1 tiến trình không tự exit (vấn đề #1) — bắt buộc xử lý trước khi đóng gate.
