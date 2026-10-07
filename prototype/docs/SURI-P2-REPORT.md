# SURI SALES AGENT — PHASE 2 (ĐỢT 2): DEEPSEEK VÀO ĐƯỜNG TRẢ LỜI THẬT + REPURCHASE HISTORY

> Ngày: 2026-10-06 · CODEX (implementer đợt P2) · Phạm vi: 7 hạng mục theo lệnh đợt 2.
> FREEZE CORE tôn trọng như đợt P1: Action Gate/SendPolicy (Window/Quota/Receipt/Opt-out),
> PII strip (BL-3), idempotency event-scoped, order engine, takeover, pipeline state machine —
> không dòng nào đổi hành vi. Mọi thay đổi ADDITIVE; thêm 1 SỬA LỖI thật ở biên HTTP (mục 4).

## 0. BEFORE → FINAL

| Bộ kiểm chứng | BEFORE (đầu đợt) | AFTER (cuối đợt) |
|---|---|---|
| test/18-cases.js | 18/18 | **18/18 PASS** |
| test/invariants-check.js | 6/6 | **6/6 PASS** |
| test/gate-a.js | 7/7 | **7/7 PASS** |
| test/p3b-cases.js | 11/11 | **11/11 PASS** |
| test/p3c-cases.js | 28/28 | **28/28 PASS** |
| test/live-adapters.js | 26/26 | **26/26 PASS** |
| test/product-ready.js | 32/32 | **32/32 PASS** |
| test/e2e-flows.js | 5/5 | **5/5 PASS** |
| test/matrix (245 case) | 245/245 | **245/245 PASS (17.1s)** |
| test/suri-agent.js (P1) | 19/19 | **19/19 PASS** |
| test/deepseek-wire.js (P1) | PASS + LIVE ONLINE | **PASS + LIVE ONLINE (nguyên trạng)** |
| test/suri-p2.js (MỚI) | — | **16/16 PASS** |
| test/suri-live.js (MỚI) | — | **PASS (LIVE) — 3/3 câu tư vấn thật qua engine với DeepSeek** |

`node --check` PASS toàn bộ file .js (src + test + ui + server.js — assert trong suri-p2 F1).
Server boot thật OK (port thay thế, NO_BROWSER_OPEN). **Không suite cũ nào bị sửa; luồng stub
FAQ giữ nguyên 100% khi AI tắt/lỗi (assert khớp CHÍNH XÁC text stub cũ — suri-p2 B1).**

**FINAL:** AI replies = **PASS (LIVE)** (DeepSeek thật, maskedKey ***42cd); repurchase-history,
useForReplies toggle, UI, docs, error UX = PASS (MOCK, offline); regression nguyên trạng.

## 1. HẠNG MỤC CHÍNH — NỐI DEEPSEEK VÀO ĐƯỜNG TRẢ LỜI THẬT (src/sales-ai.js)

Phân lớp GIỮ NGUYÊN nguyên tắc vàng — LLM chỉ viết CÂU CHỮ, không đụng quyết định:

```
webhook/UI ─► Gateway ─► AgentOrchestrator ─► Pipeline (MÁY: detectIntent + slot + buildFacts từ DB)
                                                │
                        PRICE/VARIANT/STOCK/CHITCHAT ──► SalesAI.propose(intent, ctx)
                                                            │ runtime config đọc FRESH từ
                                                            │ ShopSettings (provider/key/timeout/
                                                            │ useForReplies + systemPrompt từ
                                                            │ hồ sơ shop + prompt config)
                            có provider+key & useForReplies │
                            ┌───────────────────────────────┴───────────────────────────┐
                            │ LLM: system = buildSystemPrompt + khối FACTS (giá/tồn/SKU │
                            │ từ productDB + luật "số không có trong FACTS cấm nói")    │
                            │ user = tin khách ĐÃ redactPii (BL-3)                      │
                            │ key đi HEADER; timeout per-call; sync (curl)              │
                            └───────────────┬───────────────────────────────────────────┘
                                            │ lỗi/timeout/JSON xấu/rỗng → FALLBACK STUB FAQ
                                            ▼
                        Action Gate (FROZEN): P3C money guard quét mọi số trong câu LLM,
                        không có evidence trong FACTS/đơn → ĐÈ câu render CHÍNH THỨC từ DB
```

- **Intent detection + order flow + FACTS vẫn deterministic**: `BUY_ASK` (hỏi trường thiếu đơn),
  `ATTR_UNKNOWN` (cấm đoán — needHuman) và mọi intent hệ thống KHÔNG qua LLM (assert suri-p2 A3:
  0 call LLM trong luồng đơn).
- **Gate vẫn ghi đè số sai**: suri-p2 A2 — LLM bịa "GIÁ SỐC 92500đ" → reply tới tay khách là câu
  render DB (165000/185000), proposal `OVERRIDDEN`. LIVE: 3/3 câu DeepSeek 0 giá sai so với FACTS.
- **Fallback FAQ như cũ**: suri-p2 C1–C3 — timeout / throw / HTTP 500 / JSON xấu / content rỗng /
  settings hỏng → 6/6 biến thể fallback stub, không crash, khách vẫn nhận tin.
- **Hồ sơ shop đè vào prompt**: runtime build `buildSystemPrompt(mergePromptConfig(prompt_config,
  shop-profile))` mỗi tin — đổi hồ sơ/giọng nói có hiệu lực ngay, không restart.
- Ví dụ reply THẬT (suri-live, câu 1, qua engine đầy đủ):
  > Khách: "nến thơm vanilla giá bao nhiêu vậy shop ơi"
  > Bot (DeepSeek): "Dạ nến thơm vanilla bên mình có các mức giá: size S màu trắng 165.000đ,
  > size M màu đỏ 185.000đ ạ. Size M màu xanh hiện đã hết hàng. Anh/chị muốn lấy size nào…"
  > (đúng giá DB 165000/185000; M xanh hết hàng đúng tồn 0 — DeepSeek đọc FACTS, không bịa)

## 2. HẠNG MỤC 2 — CONFIG BẬT/TẮT settings.ai.useForReplies

- ShopSettings key `ai_use_for_replies`, **mặc định TRUE** (kể cả khi chưa test — mọi call hỏng
  đều có fallback riêng); tắt → SalesAI dùng stub NGAY (0 mạng — suri-p2 B2 khớp text stub cũ).
- API: `POST /api/ai/config` nhận `use_for_replies`; body CHỈ chứa công tắc (không provider/key)
  cũng được (toggle độc lập — suri-p2 E1); `aiView`/`aiStatus` trả `use_for_replies`.
- UI: Cài đặt → khối **"AI Engine"** có switch "AI viết lời tư vấn".

## 3. HẠNG MỤC 4 — E2E REPURCHASE THEO HISTORY (spec case 2)

- `detectIntent` thêm `REPURCHASE` (đặt trước price/variant vì "mua thêm…" dính regex cũ): cần
  CẢ tín hiệu lặp ("lấy thêm/đặt lại/mua lại…") VÀ tham chiếu lịch sử ("hôm trước/lần trước/đơn
  cũ…"), và tin KHÔNG nhắc sản phẩm (có nhắc SP thì BUY giữ nguyên — suri-p2 D5 regression P3B-1a).
- `routeRepurchase`: đọc **đơn gần nhất chưa huỷ CỦA conversation** (price_snapshot_json —
  SKU/số lượng TỪ DB, không đoán, không cho LLM quyết) → `routeBuyItems` với items cũ:
  P3B-1 tự re-entry từ ORDERED/AFTER_SALES (buy_gen++, không trả đơn cũ); khách cũ đủ slot →
  pha A tạo DRAFT mới ngay; thiếu slot → hỏi ĐỦ 1 trường.
- Biên: chưa có lịch sử → `REPURCHASE_NO_HISTORY` hỏi lại (không đoán SKU); chỉ còn đơn huỷ →
  không đề xuất lại (suri-p2 D1–D4: đúng SKU + đúng qty 2 từ đơn cũ, đơn #2 thật, reserve đúng).

## 4. SỬA LỖI THẬT Ở BIÊN — live-http UTF-8 (bắt gặp khi LIVE câu tiếng Việt đầu tiên)

`spawnSync('curl', [...,'--data-binary', body])` truyền body qua ARGUMENT làm hỏng UTF-8 trên
Windows (curl nhận qua ANSI codepage) → **DeepSeek trả 400 "invalid unicode code point"** với
MỌI request tiếng Việt. Đây cũng là vector hỏng cho các adapter live Meta/Zalo/GHN khi gửi tin
có dấu. Fix: body đẩy qua **STDIN** (`--data-binary @-` + spawnSync `input`) — byte-accurate.
Sau fix: DeepSeek trả lời tiếng Việt đúng (suri-live LIVE); 26/26 live-adapters + 245 matrix
vẫn PASS (không đổi hợp đồng; tests dùng httpFn tiêm nên không dính đường này từ trước).

## 5. HẠNG MỤC 5 — UI

- **(a) Khối "AI Engine"** (Cài đặt): provider + trạng thái pill ONLINE/ERROR/DISABLED, switch
  "AI viết lời tư vấn" (useForReplies), API key masked, last_error/last_success, các nút
  **Test gọi AI** + **Đổi cấu hình** + **Nối key DeepSeek (live)** (gộp 1 hàng).
- **(b) Tab phụ "Agent runs"** trong menu Hội thoại: bảng run (run_id/started/kênh/khách/intent/
  decision/status/steps) từ `/api/agent/runs`; bấm 1 dòng → chi tiết từng step (UNDERSTAND →
  DECISION → SEND/TOOL, kèm output JSON rút gọn + giờ VN từ `/api/agent/runs/:id`).
- **(c) Lỗi thân thiện**: `ui/api()` ưu tiên `body.userMessage` (server catch-all P1 + mới thêm
  userMessage cho 400 của `/api/ai/config` qua `friendlyError`).

## 6. HẠNG MỤC 6 — DOCS + ENV

- **docs/SETUP-GUIDE.md** — hướng dẫn từng bước cho người không rành code: khởi động, 7 bước
  wizard, kiến thức nền Meta (cửa sổ 24h/HUMAN_AGENT/private reply 1 tin), Zalo (8 tin CS/48h,
  follow), GHN (vận đơn/huỷ qua carrier), AI Engine (wire/test/fallback/useForReplies) +
  bảng sự cố thường gặp — dùng đúng knowledge AI1 (docs/AI1-platform-api.md).
- **.env.example** — chỉ TÊN biến (META_*/ZALO_*/GHN_*/WEBHOOK_PUBLIC_BASE/DEEPSEEK_PROVIDER_CONFIG/
  CHANNEL_MODE/SHIPPING_MODE/APP_DATA_MODE/PORT/UI_DEMO/NO_BROWSER_OPEN/GHN_WEBHOOK_TOKEN) + ghi
  chú secret hygiene. KHÔNG chứa giá trị thật.
- **docs/BACKUP-RESTORE.md** — bản đồ dữ liệu (data/shops/<id>: db.json + settings.json +
  product-overrides.json; db.backup.json 1 tầng tự động), backup 3 bước, restore + checklist
  sau restore, việc KHÔNG được làm (không sửa db.json khi chạy, không gửi settings.json).

## 7. TEST MỚI

- **test/suri-p2.js — 16/16 PASS**: A1 LLM wording non-stub + key đi HEADER + FACTS (SKU thật)
  trong prompt + không PII; A2 LLM bịa giá → gate OVERRIDDEN (P3C còn nguyên); A3 BUY_ASK
  deterministic (0 call LLM); B1/B2 OFF → stub khớp CHÍNH XÁC text cũ (0 mạng); C1–C3 timeout/
  throw/500/bad-json/rỗng/settings-hỏng → fallback FAQ không crash; D1–D5 repurchase history
  (đúng SP+qty từ DB, re-entry ORDERED, no-history hỏi lại, đơn huỷ không đề xuất, có nhắc SP
  vẫn BUY); E1 HTTP toggle use_for_replies + masked key + userMessage; F1 node --check toàn repo;
  F2 regression subprocess 10 suite exit 0.
- **test/suri-live.js — PASS (LIVE)**: wire key thật (không in key, maskedKey ***42cd) → test
  provider ONLINE → 3 câu tư vấn qua ENGINE đầy đủ: reply không rỗng, 0 giá sai ngoài whitelist
  FACTS (scan đồng bộ luật gate: đơn vị/nhóm nghìn/bare/k), khác template stub. Key lỗi → in
  CHƯA XÁC MINH, không fake (3 nhánh đều trung thực).

## 8. KNOWN LIMITATIONS

1. **propose SYNC — call LLM chặn event loop** trong thời gian chờ DeepSeek (giống hạn chế
   curl-sync của adapter P2, đã ghi từ trước). Timeout mặc định 20s/request; production cần
   async worker. Fallback giữ bot luôn trả lời khi hỏng.
2. **Money guard phủ số tiền; thuộc tính phi số** (ví dụ "thắp được 30 tiếng") chưa có evidence
   engine — chống bằng system prompt (cấm bịa) + "THÔNG TIN CẦM NÓI" hồ sơ shop; ATTR_UNKNOWN
   (độ tuổi, da nhạy cảm…) vẫn deterministic needHuman, không qua LLM.
3. **Repurchase scope theo conversation** (đúng spec "đơn/history gần nhất của conversation đó")
   — khách đặt lại qua kênh/thread khác chưa gộp lịch sử liên-customer.
4. **useForReplies mặc định TRUE khi đã có provider+key** (kể cả khi chưa từng test ONLINE):
   thiết kế per-call fallback nên an toàn; muốn cứng hơn có thể tắt switch thủ công.
5. **UI Agent runs tối giản** đúng đề bài (bảng + chi tiết step); chưa có filter/lọc theo conv.
6. **Matrix runner vẫn không tự exit** (hạn chế đã ghi từ P2) — chạy ad-hoc cần timeout; kết quả
   245/245 in đủ trước khi treo.

## 9. FINAL

**Đợt P2 xong: DeepSeek ĐÃ vào đường trả lời thật — PASS (LIVE): 3/3 câu tư vấn tiếng Việt qua
engine đầy đủ với key thật (maskedKey ***42cd), giá/tồn 100% từ productDB, Gate P3C vẫn là rào
chặn số sai (chứng minh cả MOCK lẫn LIVE), fallback FAQ nguyên trạng khi AI tắt/lỗi, order flow
vẫn deterministic (AI không tự tạo đơn). Repurchase-history "lấy thêm cái hôm trước" đọc đúng
đơn cũ từ DB → đơn mới đúng SKU/số lượng. useForReplies toggle API+UI. UI: AI Engine + tab Agent
runs + lỗi userMessage. Docs: SETUP-GUIDE (Meta/Zalo/GHN/AI cho người không rành code),
.env.example, BACKUP-RESTORE. Sửa thêm 1 lỗi biên thật: UTF-8 body qua curl args → stdin
(lợi mọi adapter live gửi tiếng Việt). Regression: 18/6/7/11/28/26/32 + e2e 5/5 + suri-agent
19/19 + deepseek-wire PASS nguyên trạng + matrix 245/245 + suri-p2 16/16. FREEZE core không
bị đụng — thay đổi additive: sales-ai (nâng lớp wording), ai-provider (+1 công tắc), app.js
(wiring config), pipeline (+REPURCHASE), live-http (fix stdin), server (+toggle/userMessage),
ui (+AI Engine/runs tab), docs + 2 test mới.**
