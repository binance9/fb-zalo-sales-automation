# GAP ANALYSIS — APP MÌNH (sales-ai-lab, :8080) vs AICAKE.VN (chuẩn chủ giao)

> REA soi + đối chiếu · 2026-10-06 · Nguồn chuẩn: aicake.vn landing + /Home/Pricing
> (fetch trực tiếp 2026-10-06) + BAO-CAO-HOI-DONG-V2.md mục 1/2/19 (AI-2 đọc 15/15
> UserGuide aicake ngày 2026-10-04) + code hiện tại prototype/ (36 API routes, 6 view).

## 1. ĐÃ CÓ — khớp chuẩn aicake (không làm lại)

| Chuẩn aicake | App mình | Bằng chứng |
|---|---|---|
| Onboarding 4 bước (đăng ký → nối kênh → huấn luyện AI → chốt đơn) | Wizard 7 bước + go-live gate 403 GO_LIVE_CHECKLIST | server.js onboarding; JEV audit B: PASS |
| AI trả lời tin nhắn theo kịch bản shop | sales-ai FACTS→WORDING (giá/tồn 100% từ DB, chống bịa), prompt 9 field, Action Gate | 245/245 matrix PASS |
| Tự tạo đơn từ tin nhắn | routeBuy → order-engine (bill, variant, SĐT/tên) | P3B + acceptance 15/15 |
| Đẩy đơn ĐVVC + tracking | GHN adapter (create/fee/tracking/webhook, hủy 2 chiều) | shipping/ghn-adapter.js |
| Chăm sóc sau bán (cảm ơn/feedback/gợi ý sau X ngày) | follow_ups + scheduler + opt-out | app.js:231-254, pipeline.js:1009 |
| Human takeover khi AI không chắc | takeover + worklist needs_human + notifications | takeover.js, 15 case PASS |
| PWA | manifest + sw (không cache /api) + icons | JEV audit E: PASS |
| An toàn: không tự giảm giá, whitelist ảnh | Action Gate + guard giá + routeImage | P3C |

## 2. THIẾU — phải bổ sung (đúng chuẩn aicake)

| # | Tính năng aicake | Hiện trạng mình | Việc phải làm | Giao |
|---|---|---|---|---|
| G1 | **Báo cáo & thống kê real-time**: doanh thu, số đơn, hiệu suất AI, top khách hàng, top sản phẩm | dashboard() chỉ có today: khách/đơn/doanh thu hôm nay + activities; KHÔNG có module thống kê dài hạn, không chart | `src/analytics.js` (tổng hợp từ store: revenue theo ngày 14 ngày, đơn theo trạng thái, tỷ lệ AI tự xử vs takeover, top 10 khách theo chi tiêu, top 10 SP theo số đơn) + `GET /api/analytics?days=14` + view UI "Báo cáo" (nav mới, bảng + bar chart CSS thuần, không thêm lib) | Agent A |
| G2 | **Tự động comment & inbox**: trả lời bình luận, ẨN comment tiêu cực, inbox khách từ comment | meta-adapter chỉ normalize comment → message (origin:'comment'); pipeline KHÔNG có flow riêng comment; không có ẩn comment; không có auto-inbox | Flow comment trong pipeline: (a) auto-reply comment khi khớp sản phẩm/giá (dùng cùng sales-ai), (b) phát hiện từ tiêu cực → đánh dấu + lệnh hide qua meta-adapter (mock, ghi audit), (c) từ comment có ý định mua → tạo/tìm conversation inbox và đi luồng bán; settings 3 công tắc + UI settings | Agent B |
| G3 | **Đa model AI**: ChatGPT, Gemini, DeepSeek, Grok, Kimi | ai-provider chỉ deepseek + openai (allowlist 2 host) | Thêm gemini (generativelanguage.googleapis.com), grok (api.x.ai), kimi (api.moonshot.cn) — same OpenAI-style wire, cho phép từng nhà chọn wire riêng nếu khác; mở rộng ALLOW host; UI chọn model trong settings AI; test ai-provider | Agent C |
| G4 | **Tách reply bằng marker `---` / `{{TachCau}}`, quick reply `[[nút]]`, postback `[[[...]]]`, biến `{{TenKhachHang}}`** | sales-ai trả 1 khối; không có tách marker; template không có biến | parser marker ở tầng wording (sales-ai: tách `---` thành nhiều đoạn gửi lần lượt; `[[label|payload]]` → quick_reply; `[[[label|payload]]]` → postback) + render biến `{{TenKhachHang}}` trong template; test unit | Agent D |
| G5 | **Quản lý nhiều thành viên team** (bảng giá Pro) | API /api/auth/users GET+POST CÓ SẴN, UI KHÔNG có | UI settings tab "Thành viên": danh sách + tạo user (email, vai trò OWNER/ADMIN/AGENT) + mô tả quyền; đi qua API sẵn có | Agent D |

## 3. GHI CHÚ — không copy (giữ nguyên quyết hội đồng, BAO-CAO-HOI-DONG-V2 mục 19)

- Giá/tồn trong prompt tĩnh → giữ FACTS render DB mỗi lượt.
- "AI chốt đơn khi reply chứa từ khóa" → giữ Action Gate từ draft đã validate.
- Kéo 1000 hội thoại cũ làm ngữ cảnh → KHÔNG làm (PII).
- Tách câu theo dấu chấm → dùng marker `---` (G4 đúng hướng hội đồng ADAPT).
- API & Webhook ERP/CRM outbound (giá Pro): GHI NHẬN out-of-scope local lab — chưa có ERP để nối; để roadmap.

## 4. RÀNG BUỘC THỰC HIỆN (mọi agent phải giữ)

1. 245/245 matrix + 15/15 acceptance phải PASS sau khi thêm — không hạ gate, không sửa số test cũ.
2. Mọi ghi DB qua store transaction như code hiện tại; comment action (ẩn) ghi audit.jsonl.
3. Không đụng auth semantics, idempotency (INV), Action Gate invariants.
4. Comment/quick-reply/postback đi qua action-gate như tin thường (không path riêng bỏ qua gate).
5. UI: tiếng Việt, theme hồng #db2777, chữ ≥14px, không thêm lib ngoài (giữ vendor hiện tại).

## 5. KẾT QUẢ TRIỂN KHAI (cập nhật 2026-10-06 tối)

| Gap | Trạng thái | Test |
|---|---|---|
| G1 Báo cáo & thống kê | ✅ src/analytics.js + GET /api/analytics + view "Báo cáo" (4 thẻ + chart 14 ngày + hiệu suất AI + top khách/SP) | 29/29 |
| G2 Comment automation | ✅ src/comment-flow.js + pipeline (auto-reply/ẩn tiêu cực/inbox) + 3 công tắc + POST /api/settings | 5/5 + 8/8 (settings-post) |
| G3 Đa model AI | ✅ gemini/grok/kimi vào ai-provider (cả nhà: deepseek, openai, gemini, grok, kimi, local) + dropdown động | 6/6 |
| G4 Marker/quick-reply | ✅ src/reply-markers.js (`---`, `[[nút]]`, `[[[postback]]]`, `{{TenKhachHang}}`) gửi nhiều tin qua Gate | 7/7 |
| G5 UI thành viên | ✅ card Thành viên team (list + tạo user OWNER/ADMIN/AGENT) | matrix Auth |
| Chart fix | ✅ bar chart % height (wrapper thiếu height:100% — cột ẩn) | screenshot |

**Regression cuối: matrix 245/245 PASS · analytics 29/29 · comment 5/5 · settings-post 8/8 · multimodel 6/6 · reply-markers 7/7 · e2e A–E PASS.**
**Acceptance 15-case (instance lạnh đủ go-live, server thật): 15/15 PASS.** Lần chạy trên :8080 data chủ được 8/15 do shop thật đang bot TẮT + checklist 2/7 (gate chặn đúng thiết kế) — không phải bug.
Server :8080 đã restart với code mới (persist, UI_DEMO=0). JEV scan evidence: C:\JEV\evidence\filelist-1791290652420.json (961 files).

## 6. MỤC HƯỚNG DẪN (G6 — yêu cầu thêm 2026-10-06 tối, layout y hệt aicake.vn/UserGuide)
- src/guide-content.js: **5 danh mục / 20 bài / 84 bước** — nội dung THẬT theo UI app (wizard 7 bước, sku_base/alias/CSV, GHN, 6 model AI, 3 công tắc comment, follow-up, takeover, Báo cáo, thành viên, PWA). test guide-content 20/20.
- UI (Agent B): sidebar tìm kiếm + danh mục badge + bài; trang chủ tiêu đề lớn + CTA "Chat với AI để được hướng dẫn" + thẻ "5 Danh mục / 20 Bài viết"; trang bài có breadcrumb + phút đọc + bước đánh số + tip; hash routing #guide/<id>; FAB "🤖 Hỏi AI" mọi view; responsive <900px. Giữ theme hồng.
- Backend (Agent C): GET /api/guide + POST /api/guide/ask — trả lời deterministic TỪ steps (không bịa, đúng luật dự án), fallback + gợi ý 3 bài; 401 khi chưa login; AGENT được đọc + hỏi (đã mở whitelist POST). test guide-ai 26/26.
- Regression cuối: matrix 245/245 · guide-content 20/20 · guide-ai 26/26 · analytics 29/29 · comment 5/5 · multimodel 6/6 · reply-markers 7/7 · settings-post 8/8. Server 8080 restart pid 13240 — soi UI thật bằng browser: trang chủ/bài/chat đều chạy đúng.

## 7. LINH HỒN AI (yêu cầu 2026-10-06 đêm: "AI chưa có hồn, hỏi gì cũng phải trả lời được, vui vẻ, biết bán hàng")
- src/persona.js (MỚI): nhân vật **Suri** — buildPersonaBlock() (system prompt: giọng người thật, emoji vừa đủ, cấm bịa số — chỉ FACTS) + chitchatReply() (10 nhóm: chào/tên/cảm ơn/khen/thanh toán/ship/khuyến mãi/tâm trạng/tạm biệt/default; pool chọn ổn định theo hash, đan hook SP THẬT từ FACTS).
- sales-ai.js: LIVE thêm persona vào system prompt; STUB CHITCHAT đi qua persona. pipeline.js: routeChitchat nhận text (trước truyền rỗng — nguyên nhân "khô").
- Hỏi AI (guide-ai.js, Agent F): 3 lớp — LLM LIVE (DeepSeek/Gemini/Grok/Kimi/OpenAI khi có key) → local có hồn → gợi ý chủ đề; không bao giờ 500.
- Test: persona-soul 12/12 · guide-ai 37/37 · matrix 245/245 · soul-verify 5/5 (instance go-live thật: chào/giá/cảm ơn/CK/ổn định).
