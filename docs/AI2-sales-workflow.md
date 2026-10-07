# AI2 — SALES AI / WORKFLOW REVIEW & DESIGN

> Reviewer 2/3 của hội đồng. Đầu vào: `docs/00-yeu-cau.md` (yêu cầu chung, kiến trúc đích, 18 case).
> Nguồn nghiên cứu:
> (1) **AICake UserGuide** — 15/15 bài công khai, lấy trực tiếp qua API `aicake.vn/UserGuide/GetCategories` + `GetArticle/{id}` (ngày tra: 2026-10-04).
> (2) **Prototype local** `C:\Users\BAOAN\.zcode\workspace\default\bot-ban-hang\` — `bot/reply-engine.js`, `bot/order-parser.js`, `server.js`, `store.js`, `.env.example`.
>
> Phân loại bắt buộc cho mọi ý: **USE** (dùng) / **ADAPT** (ý tốt, viết lại) / **REJECT** (bỏ) / **CHƯA XÁC MINH** (cần evidence).
> Bài này CHỈ là thiết kế — không build code.

---

## 0. Tóm tắt nhanh AICake làm gì (bối cảnh cho các mục dưới)

Quy trình onboarding mà AICake dạy user, theo thứ tự 9 bài "Bắt đầu nhanh" + 4 bài "Xây dựng AI" + 2 bài "Đơn hàng":

1. **Đăng nhập bằng Facebook** (lấy quyền page) → **Kích hoạt page** (mặc định kéo 1000 hội thoại gần nhất khi bật).
2. **Thêm sản phẩm** (tên, **mã SP**, giá, **cân nặng**, **ảnh**) + **kho hàng** (người quản lý, SĐT, địa chỉ kho — bắt buộc để đẩy đơn sang ĐVVC 1 nút).
3. **Cấu hình ĐVVC** (chọn nhà vận chuyển, nhập thông số kết nối).
4. **Đăng ký AI** (DeepSeek cho text — rẻ; ChatGPT hoặc z.ai/GLM cho **đọc ảnh + đọc voice**, vì DeepSeek không đa phương thức). API key đưa vào platform, KHÔNG đưa vào ngữ cảnh.
5. **Viết ngữ cảnh AI** (system prompt khổng lồ do chủ shop soạn): phong cách xưng hô, thông tin shop, **danh sách sản phẩm kèm giá + link ảnh**, thông số SP, bảng ship, chương trình khuyến mại, quy tắc từ chối giảm giá, quy tắc gửi ảnh, quy tắc tách câu, câu cấm nói.
6. **AI tự tạo đơn**: bật "AI chốt đơn đẩy sang Đơn hàng" + từ khoá trigger trong reply của AI (VD "chốt đơn"); format bill bắt buộc (SP × SL = thành tiền, phí ship, giảm giá, tổng, SĐT + địa chỉ **có dấu đầy đủ**).
7. **Comment automation**: ẩn comment tự động, trả lời comment (biến `{{TenKhachHang}}`), tự inbox khách từ comment.
8. **Đơn & vận chuyển**: xác nhận đơn (3 cách, để Meta ghi conversion) → đẩy ĐVVC; huỷ ở platform thì huỷ cả bên ĐVVC; **webhook ViettelPost** đẩy trạng thái đơn ngược về.
9. **PWA** (thêm vào màn hình chính iOS/Android, bật thông báo) — không có app native.

Điểm yếu bẩm sinh của mô hình AICake (thấy rõ từ chính bài guide của nó): **mọi sự thật nằm trong system prompt tĩnh do tay soạn** — giá, KM, tồn kho đều là chữ trong prompt; AI được phép "tự tính giảm giá khi mua 4"; thông tin khách được lưu… ngay trong tin nhắn đầu tiên của assistant. Đây chính là các chỗ project này phải làm khác (mục 3, 5, 2).

---

## 1. STATE MACHINE BÁN HÀNG

Giữ nguyên khung 10 state của `00-yeu-cau.md` (đề bài đã duyệt làm mốc phản biện), bổ sung **2 lớp vuông góc** thay vì thêm state tuyến tính:

- `mode` của hội thoại: `AUTO` | `HUMAN` (nhân viên đang giữ) — takeover có thể xảy ra ở **mọi state**, nên không đưa vào luồng chính (mục 6).
- `claim` (khiếu nại) là **state phụ có thể vào/ra** từ ORDERED / SHIPPING / AFTER_SALES, xử lý xong **quay về state cũ** — không phá luồng tuyến tính (trả lời câu hỏi "khiếu nại = state riêng?": **CÓ, nhưng là state rẽ nhánh có nhớ-lối-về**, không phải state nằm trên trục chính).

### 1.1 Bảng state

| State | Điều kiện VÀO | AI làm gì | Điều kiện RA | Chuyển tới |
|---|---|---|---|---|
| **NEW_LEAD** | Inbound đầu tiên từ customer chưa có record, hoặc record `dormant` (không tương tác > 60 ngày) | Chào tự nhiên + hỏi nhu cầu; KHÔNG đẩy giá bán khi chưa được hỏi; với lead đến từ comment → 1 tininbox duy nhất (chống spam) | Khách nói nhu cầu tìm hiểu chung | DISCOVERY |
| **DISCOVERY** | Khách hỏi mơ hồ: "bán gì", "còn shop không", "tư vấn giúp" | Tư vấn theo **catalog từ DB** (tên, nhóm hàng); hỏi lại 1–2 câu thu hẹp nhu cầu; GỬI ẢNH chỉ từ link ảnh trong product DB | Khách nhắc 1 sản phẩm cụ thể (match SKU/tên) → PRODUCT_QA; có tín hiệu mua → BUY_INTENT | PRODUCT_QA / BUY_INTENT |
| **PRODUCT_QA** | Khách hỏi chi tiết ≥1 SP (giá, size, màu, chất liệu, còn không) | **Retrieval từ product DB** (mục 3) → chỉ được phát biểu những gì có trong kết quả truy vấn; thiếu evidence → câu an toàn (mục 5) | Tín hiệu mua → BUY_INTENT; đổi SP → ở lại PRODUCT_QA (đổi subject); hết hàng → đề xuất SP thay thế từ DB hoặc hẹn nhập hàng | PRODUCT_QA / BUY_INTENT |
| **BUY_INTENT** | Phát hiện ý định đặt ("lấy 1", "đặt", "chốt", hỏi cách mua/cod/ship về nhà) | Tạo **order draft** (draft, chưa phải đơn); xin thông tin còn thiếu; nhắc lại đang chọn gì | Có ≥1 trường dữ liệu đơn được ghi nhận → COLLECT_ORDER; khách lùi ý → PRODUCT_QA/DISCOVERY | COLLECT_ORDER |
| **COLLECT_ORDER** | Đang có order draft, còn thiếu trường | **Slot-filling từng trường**: hỏi ĐÚNG trường thiếu nhất (ưu tiên SĐT → địa chỉ → xác nhận SP/SL); ghép thông tin rải qua nhiều tin nhắn (mục 2.3) | Đủ trường bắt buộc → VALIDATE; hết thời hạn draft (24h) → huỷ draft + quay lại state trước | VALIDATE |
| **VALIDATE** | Draft đủ trường bắt buộc | **AI KHÔNG làm gì ở state này** — máy kiểm tra: SĐT regex VN 10 số; địa chỉ đủ 3 cấp (tỉnh/huyện/xã — tra bảng hành chính); SKU tồn tại + **re-check tồn kho**; giá & tổng tính từ DB; phí ship từ bảng ship DB | Pass → CONFIRM; fail → quay COLLECT_ORDER với câu hỏi đúng trường lỗi (hết hàng → kèm đề xuất thay thế) | CONFIRM / COLLECT_ORDER |
| **CONFIRM** | Draft đã validate | Gửi **bill template render từ dữ liệu validated** (không phải lời AI sinh — mục 5.3); chờ khách gật/sửa | Khách xác nhận → ORDERED (qua Action Gate); khách sửa → COLLECT_ORDER (giữ các trường khách không muốn sửa); im lặng 24h → nhắc 1 lần rồi đóng draft | ORDERED / COLLECT_ORDER |
| **ORDERED** | Action Gate đã EXECUTE tạo đơn thành công (VERIFY được order_id từ hệ thống, không phải từ lời AI) | Trả lời câu hỏi trạng thái từ order DB; không được hứa thời gian giao ngoài chính sách | Webhook ĐVVC "đã tiếp nhận/lấy hàng" → SHIPPING | SHIPPING |
| **SHIPPING** | ĐVVC xác nhận nhận hàng | Chỉ báo cáo trạng thái từ webhook/order DB; KHÔNG hứa thay shipper | Webhook "giao thành công" → AFTER_SALES; "giao thất bại/hoàn" → CLAIM | AFTER_SALES / CLAIM |
| **AFTER_SALES** | Đơn giao thành công (hoặc khách quay lại sau bán) | Follow-up theo lịch (mục case 17): hỏi trải nghiệm, xin đánh giá, ưu đãi mua lại — **chỉ khi khách không opt-out**; hỏi kỹ thuật/cách dùng | Có đơn mới → NEW_LEAD→…(vòng mới); có vấn đề → CLAIM | CLAIM / vòng mới |

**CLAIM (state phụ)**: vào từ ORDERED/SHIPPING/AFTER_SALES khi phát hiện khiếu nại (từ khoá + classifier) hoặc giao thất bại. Bắt buộc `mode=HUMAN` (AI không tự hứa bồi thường — học đúng quy tắc AICake "chỉ nhắn để em báo chủ shop", nhưng thực thi bằng **cơ chế** chứ không chỉ bằng lời dặn trong prompt). RA: nhân viên đóng khiếu nại → quay về state ghi nhớ trước khi vào.

### 1.2 Edge case đã thiết kế trong máy (tóm tắt, mapping đầy đủ ở mục 10)

- **Đổi SP giữa chừng** (case 5): CHANGE_SUBJECT → PRODUCT_QA; slot `sku/size/màu/số lượng` của SP cũ bị đánh dấu `stale` (không xoá — khách có thể quay lại), slot không phụ thuộc SP (`tên`, `sđt`, `địa chỉ`) được **giữ nguyên**.
- **Mua nhiều SKU** (case 6): draft là `lines[]` không phải 1 sản phẩm; mỗi line có tồn kho validate riêng.
- **Hết hàng đúng lúc chốt** (case 9): tồn kho check 2 lần — ở VALIDATE và **một lần nữa trong Action Gate ngay trước EXECUTE** (transaction/conditional update); fail ở cổng này → không tạo đơn, đề xuất thay thế, `mode=HUMAN` nếu khách lớn.
- **Khiếu nại giữa SHIPPING** (case 13): CLAIM không xoá SHIPPING — đơn vẫn chạy theo webhook; CLAIM chỉ là lớp hội thoại.

**Phân loại mục 1**: khung 10 state + mode overlay = **USE** (theo 00-yeu-cau, đã bổ sung CLAIM + chi tiết vào/ra). Luồng "comment → inbox → tư vấn → đơn" của AICake = **ADAPT** (học cấu trúc, bỏ vì: AICake không có state machine tường minh — mọi thứ là prompt + tab UI; ta cần state để test được 18 case). "AI chốt đơn khi reply chứa từ khoá" của AICake = **REJECT** (từ khoá trong lời AI không phải evidence; tạo đơn phải đi qua Action Gate từ slot data đã validate — đúng nguyên tắc vàng).

---

## 2. CUSTOMER MEMORY

### 2.1 Schema (thiết kế đích — triển khai giai đoạn đầu bằng SQLite)

```
Customer   { id, channels: {fb_psid?, zalo_uid?}, name?, phone?, gender?,
             address?, tags[], marketing_consent: true|false,      // case 18
             vip_level, created_at, last_active_at }
Conversation{ id, customer_id, channel, state (mục 1), mode: AUTO|HUMAN,
             claim: null|{opened_at, reason, origin_state, resolved_at},
             summary (tóm tắt cuộn), summary_upto_msg_id }
Message    { id, conversation_id, direction in|out|agent, kind text|image|voice|comment,
             text, media_url?, msg_id (dedupe), sent_status, created_at }
OrderDraft { id, conversation_id, lines: [OrderLine], slots (2.3), expires_at }
Order      { id, external_id (ĐVVC), conversation_id, lines[], total, shipping_fee,
             status: draft|confirmed|created|shipping|delivered|failed|cancelled,
             idempotency_key, audit_id }
```

### 2.2 Ngữ cảnh AI = 3 lớp (window + summary + facts)

- **Lớp 1 — Window**: N tin cuối nguyên văn (N≈12 lượt; đủ để hiểu "cái đó", "món kia").
- **Lớp 2 — Summary cuộn**: tóm tắt do LLM viết, cập nhật mỗi ~10 tin (chạy nền, không chặn reply): khách là ai, đang quan tâm SP nào, đã đồng ý/gặp gỡ gì, điều gì KHÔNG được lặp lại (VD đã xin giảm giá 2 lần và bị từ chối). Ghi rõ ở prompt: "sự thật là DB; summary chỉ để hiểu bối cảnh".
- **Lớp 3 — Facts có cấu trúc**: product snapshot vừa retrieval, draft/order hiện tại, customer profile (truyền **tối thiểu PII** cần cho lượt này — đúng 00-yeu-cau).

Học của AICake trong mục này: AICake nhét "thông tin khách (tên, giới tính, từ bài post nào, số đơn đã đặt, giờ VN) vào **tin nhắn đầu tiên của assistant**" — tức state khách nằm trong chính hội thoại. **REJECT** cách lưu này (mất khi xoá tin, không truy vấn được, hai kênh không gộp) — nhưng **ADAPT** ý tưởng "giờ VN hiện tại + nguồn lead + số đơn cũ nên có mặt trong ngữ cảnh": đưa vào lớp 3 facts, render tự động lúc build prompt.

### 2.3 Slot trạng thái từng trường (chống mất dữ liệu rải nhiều tin)

Mỗi trường của draft có trạng thái riêng:

```
slots: {
  name:   { value, state: empty|detected|confirmed },   // detected = bóc được từ tin khách, chưa khách xác nhận
  phone:  { value, state },                             // phone/địa chỉ hợp lệ qua VALIDATE → confirmed
  address:{ value, parts:{tinh,huyen,xa}, state },
  lines[]:{ sku, size?, colour?, qty, unit_price, state: empty|detected|confirmed|stale }
}
```

Quy tắc ghép tin rời (đã thấy hiện tượng này trong prototype — khách nhắn "đặt 2 hộp trà hoa sấy" rồi tin sau "sdt… địa chỉ…"): tin mới **ưu tiên** điền chỗ trống; trường đã `confirmed` chỉ đổi khi khách nói rõ muốn sửa. Trường `stale` khi đổi SP nhưng được restore nếu khách quay lại đúng SP đó trong cùng draft.

**Phân loại mục 2**: schema + 3 lớp ngữ cảnh + slot-state = **USE** (thiết kế mới, mẫu mực từ kiến trúc đích "Chat History + CRM"). Prototype `store.js lichSu()` (lấy 8 tin cuối theo kênh) = **ADAPT** (đổi điều kiện lọc: theo customer unified, không theo kênh; tăng window, thêm summary). Cách AICake lưu khách trong tin nhắn = **REJECT** (lý do trên).

---

## 3. PRODUCT RETRIEVAL (RAG THU GỌN — KHÔNG VECTOR DB GIAI ĐOẠN ĐẦU)

### 3.1 Nhận diện khách hỏi sản phẩm nào

Pipeline nhận diện subject (chạy TRƯỚC khi LLM viết lời):

1. **Chuẩn hoá**: lowercase → bỏ dấu tiếng Việt (chuẩn NFD, `đ→d` — dùng lại `boDau()` của prototype, đã chạy ổn) → bỏ emoji/punctuation thừa → tách token.
2. **Match theo lớp, dừng ở lớp trúng đầu tiên**:
   - L1 exact **SKU** (AI-1: SKU là bí mật với khách — nhưng khách hay gõ mã từ ảnh/quảng cáo, vẫn match).
   - L2 **alias table**: mỗi SP khai sẵn tên gọi khác, viết tắt, ký hiệu ("trà hoa", "tra sen", "combo qua tang", "TTHS"). Alias là dữ liệu shop nhập — không phải AI đoán.
   - L3 **substring/contains** trên tên đã bỏ dấu.
   - L4 **fuzzy**: trigram similarity (hoặc Levenshtein chuẩn hoá) ngưỡng ~0.8; trả nhiều ứng viên → hỏi khách chọn khi score gần nhau.
3. **Multi-product**: quét toàn bộ catalogue cho n-gram (case 6, và câu "QPD với QPX còn không") — trả danh sách match, không chỉ 1.
4. Không match gì → AI nhận "SUBJECT: UNKNOWN" + top-3 gợi ý, bị cấm đoán tên sản phẩm.

### 3.2 Product DB schema

```
Product { id, sku, name, aliases[], category,
          price, list_price?,                       // giá bán — NGUỒN THẬT DUY NHẤT
          stock,                                    // tổng tồn
          variants: [ { sku_variant, size?, colour?, stock } ],   // tồn kho theo size/màu
          images: [url],                            // chỉ domain của mình
          weight_g,                                 // cần cho tính phí ĐVVC (học AICake)
          attributes: { mô tả, thông số, chính sách… },   // nguồn " PRODUCT_QA
          active, updated_at }
```

### 3.3 Quy tắc bất di bất dịch: giá/tồn kho chỉ từ kết quả truy vấn

- Trước khi LLM viết lời, hệ thống chạy retrieval và **nhét kết quả vào prompt dưới nhãn `FACTS (bất khả xâm phạm)`**: giá, tồn kho, variant có sẵn.
- Prompt cấm: "không được nêu bất kỳ con số tiền/số lượng tồn nào không có trong FACTS. Không tính tổng khi FACTS không cho đủ dữ liệu."
- Guard post-check quét lại số tiền trong câu AI so với FACTS (mục 5.2).
- **Ưníu thực dụng cho catalogue nhỏ (< ~100 SP, đúng giai đoạn này)**: render toàn catalogue fresh từ DB vào prompt mỗi lượt (kiểu AICake "Chèn bảng sản phẩm") — vẫn an toàn vì dữ liệu render lúc chạy, không phải chữ tĩnh; khi catalogue lớn hơn thì chuyển tool-call retrieval. Retrieval per-turn (L1–L4) vẫn chạy để xác định SUBJECT.

**Phân loại mục 3**: toàn bộ thiết kế = **USE**. "Chèn bảng sản phẩm + link ảnh vào prompt, AI đọc và gửi ảnh đúng SP" của AICake = **ADAPT** (giữ cơ chế render catalogue từ DB, thêm alias + fuzzy mà AICake không có — AICake chỉ match theo AI "đọc tên trong bảng"). "Mua 4 quạt tự tính giảm giá" trong ngữ cảnh AICake = **REJECT** (tính khuyến mại phải hàm deterministic từ bảng KM trong DB, không giao cho LLM). AICake quy định "mã SP là bí mật, không nhắn cho khách" = **ADAPT** (chính sách hay — đưa vào reply policy).

---

## 4. IMAGE / VOICE HANDLING

### 4.1 Ảnh (khách gửi)

- **Ảnh KHÔNG vào pipeline text trực tiếp.** Bước riêng: (a) gateway tải file từ attachment URL; (b) gọi **vision model** sinh caption có cấu trúc (SP nào, màu gì, tình trạng, có chữ không); (c) caption dạng `[KHÁCH GỬI ẢNH: …]` được đưa vào pipeline text như một tin nhắn thường; (d) ảnh gốc lưu `media_url` để nhân viên xem trong Inbox.
- Model: cần model đa phương thức (GLM-4V/ChatGPT/…). Đây là lý do AICake bắt dùng ChatGPT/z.ai song song DeepSeek — **học: multi-model routing** (text model rẻ cho hội thoại; vision model chỉ tốn tiền khi có ảnh).
- Kênh gửi ảnh ĐI: chỉ gửi URL ảnh nằm trong `product.images` (domain của mình), validate đuôi file `.jpg/.jpeg/.png/.gif/.webp` trước khi gửi — **bê nguyên quy tắc whitelist của AICake vì nó đã chặn đúng 2 lỗ hổng thực tế**: AI bịa link và AI lấy lại link ảnh trong hội thoại/domain Facebook (Facebook CDN hết hạn sớm).
- Facebook: `message.attachments[].type="image"`, URL tại `payload.url` — **USE** (chuẩn ổn định, xác minh lại lúc tích hợp).

### 4.2 Voice

Nguyên tắc: **speech-to-text TRƯỚC, rồi mới vào pipeline text** — voice transcript được gắn nhãn `[VOICE KHÁCH NÓI: "…"]` và một cờ `low_confidence` nếu STT score thấp (→ nghiêng về hỏi lại, không tự tin trả lời).

| Kênh | Sự kiện webhook | Trường dữ liệu | Ghi chú |
|---|---|---|---|
| Zalo OA | `user_send_voice` | `message.voice.murl` (media URL trên CDN Zalo) | Mức tin cậy: event + murl khớp với pattern docs Zalo (tra nhanh 2026-10-04) nhưng **CHƯA XÁC MINH**: (1) đuôi/format thật của file (mp3? amr/opus?) — cần bấm 1 tin voice thật và xem payload + tải file; (2) URL có ký thời hạn hay không → phải tải ngay, không cache URL. |
| Facebook | `message.attachments[].type="audio"` | `payload.url` (thường .mp4/.m4a/.oga) | **USE**, kèm xác minh lúc tích hợp (kích thước tối đa, format). |

- STT: 1 API STT hỗ trợ tiếng Việt tốt (whisper-large / model VN). Kết quả transcript **đi qua cùng slot-filling** như text — tức case 4 (voice) không cần luồng riêng nào ngoài bước tiền xử lý.
- Không STT được (file hỏng/ngôn ngữ lạ) → câu an toàn + takeover.
- Gửi voice ĐI: **REJECT giai đoạn đầu** (không cần thiết cho bán hàng; TTS tăng phức tạp, không có bằng chứng khách cần).

**Phân loại mục 4**: thiết kế = **USE**; multi-model routing của AICake = **ADAPT**; whitelist ảnh của AICake = **USE**; Zalo voice format chi tiết = **CHƯA XÁC MINH** (cần evidence: payload thật + file thật).

---

## 5. CHỐNG HALLUCINATION

### 5.1 Tách FACTS / WORDING

- **FACTS** = mọi dữ liệu từ tool/DB/API: giá, tồn kho, SKU, khuyến mại, phí ship, trạng thái đơn, chính sách, profile khách, bill đã validate. Được sinh bởi code, format JSON, gắn `source` + `fetched_at`.
- **WORDING** = phần LLM: chọn giọng điệu, xếp câu, xưng hô, hỏi lại tự nhiên. LLM chỉ được "diễn đạt FACTS", không được "bổ sung FACTS".
- Prompt template tách bạch: `FACTS (bất khả xâm phạm, nếu cần thông tin ngoài FACTS → hỏng)` / `NHIỆM VỤ (viết 1–3 tin nhắn tự nhiên dựa đúng FACTS)`.

### 5.2 Guard post-check (chốt cửa sau khi LLM viết xong)

Máy quét output AI TRƯỚC KHI GỬI:
1. Mọi **số tiền/số lượng/số điện thoại** trong câu phải khớp một mục trong FACTS hoặc draft đã validate (case 8 chặn ở đây). Lệch → thay bằng bản render từ FACTS hoặc chặn gửi.
2. Mọi **tên SP** phải match catalogue (không được đặt tên mới).
3. Từ cấm (hứa hẹn đổi trả/bồi thường ngoài chính sách, số tài khoản không phải của shop, link ngoài whitelist domain) → chặn.
4. Đề nghị giảm giá tự phát → chặn, đẩy `mode=HUMAN` nếu khách đòi giảm ngoài khung (học tinh thần quy tắc 6/10 ngữ cảnh AICake, thực thi bằng guard chứ không phải lời dặn).

### 5.3 Không có evidence → câu an toàn + takeover

- Trả lời an toàn chuẩn (xoay vòng vài mẫu để không lặp): *"Câu này em phải hỏi chủ shop mới dám trả lời chính xác, mình chờ chút nha, có lời đáp lại liền ạ 🙏"* — mượn thẳng từ `fallbackPool` của prototype vì viết đã tự nhiên: **USE**.
- Đồng thời: log audit (câu hỏi, lý do thiếu evidence), nếu lặp lại ≥2 lần hoặc thuộc CLAIM → `mode=HUMAN`.
- **CẤM** câu "em đoán" kiểu "chắc khoảng…" với số tiền/tồn kho.

### 5.4 Template chốt đơn từ dữ liệu validated

Bill gửi khách (state CONFIRM) là **template render từ OrderDraft đã qua VALIDATE** — AI không tham gia sinh bill; AI chỉ có thể kèm 1 câu dẫn tự nhiên (không chứa số). Tương tự mọi action thật: `PROPOSE → VALIDATE → AUTHORIZE → EXECUTE → VERIFY` (00-yeu-cau). Điểm khác biệt quyết định với AICake: AICake cho AI **soạn bill trong reply** và dùng chữ "chốt đơn" trong reply làm cờ tạo đơn — tức lời AI là evidence. **REJECT**: ở đây bill là artifact của pipeline dữ liệu, lời AI chỉ là bao bì.

**Phân loại mục 5**: USE toàn bộ thiết kế (guard + facts/wording + template bill). Mượn của AICake các **quy tắc cấm soạn bằng lời** (không hứa đổi trả, không bồi thường, không nhận giảm giá ngoài chương trình, câu trả lời tình huống khiếu nại) = **ADAPT** — chuyển thành điều kiện guard máy + một phần policy, giữ nguyên câu thoại mẫu vì viết tốt.

---

## 6. HUMAN TAKEOVER

### 6.1 Cơ chế

- `Conversation.mode`: `AUTO` → `HUMAN` (và ngược lại). Khi `HUMAN`: **AI vẫn chạy UNDERSTAND + RETRIEVE để chuẩn bị "draft gợi ý" cho nhân viên nhưng KHÔNG auto-send**; mọi tin đi ra phải do nhân viên gửi (hoặc duyệt draft).
- Cờ hiển thị trong Inbox: badge trạng thái per-conversation: `AI tự động` / `⏸ AI chờ người` / `🚩 Khiếu nại` / `👤 NV đang trả lời` — nhân viên nhìn một phát biết ai đang giữ hội thoại.

### 6.2 Điều kiện AI tự dừng auto-send (danh sách máy đọc được)

1. Confidence thấp: guard chặn, subject UNKNOWN 2 lần liên tiếp, STT low-confidence.
2. Khách yêu cầu người thật ("cho gặp người", " chủ shop ơi", "bot à") — từ điển + classifier.
3. Khiếu nại (CLAIM luôn kèm `mode=HUMAN`).
4. Khách lớn: đơn giá trị ≥ ngưỡng VIP, hoặc customer.tags chứa `vip`/`wholesale`.
5. Nhân viên bấm giữ hội thoại thủ công.

### 6.3 Trả quyền

Nhân viên bấm **"Trả lại AI"** → `mode=AUTO` + hệ thống chèn 1 bản ghi summary "người đã xử lý X, khách đã đồng ý Y" vào ngữ cảnh (nhờ lớp summary mục 2.2) → AI tiếp mượt, không hỏi lại thứ khách đã trả lời cho người. Mọi chuyển mode ghi audit.

**Phân loại mục 6**: **USE** (thiết kế mới — AICake guide công khai KHÔNG có takeover tường minh; chốt đơn lớn/khiếu nại đều để AI xử theo prompt). Đây là một trong những khoảng trống lớn nhất của AICake so với yêu cầu đề bài.

---

## 7. REPLY SPLITTING TỰ NHIÊN

- **Tách 2–3 tin**: LLM đánh dấu `---` giữa các phần (prototype đã làm đúng — server cắt và gửi lần lượt, cap 4 phần): **USE**.
- **Delay tự nhiên**: 1.5s giữa các phần (prototype); **ADAPT** thêm: delay ngẫu nhiên hoá 0.8–2.5s, tỉ lệ thuận độ dài tin trước; optional typing indicator nếu kênh hỗ trợ. Lý do: 1.5s cứng lặp lại vẫn lộ máy khi soi log.
- So với AICake: họ tách **tự động theo dấu chấm** (max 3 câu) hoặc marker `{{TachCau}}`, kèm cú pháp quick reply `[[nút]]` và postback `[[[...]]]`.
  - Tách theo dấu chấm = **REJECT** (dấu chấm trong "120.000đ", trong list gạch đầu dòng dễ tách sai — chính bài guide của họ phải viết cả mục "lưu ý dấu chấm số tiền"; marker tường minh an toàn và debug được).
  - `{{TachCau}}` = **ADAPT thành `---`** (ngắn hơn, không trúng văn tự nhiên).
  - Quick reply `[[nút]]` = **ADAPT** (giai đoạn sau, cho state BUY_INTENT/CONFIRM trên Messenger; Zalo OA có button riêng — cần map 2 cú pháp kênh, **CHƯA XÁC MINH** chi tiết button Zalo OA v3.0).
- **Chống máy móc về wording**: xoay vòng fallbackPool (prototype — USE); câu chốt ký cuối mỗi tin (prototype chuKy — ADAPT: chỉ gắn tin cuối cùng của lượt, không gắn vào bill/template); cấm mở đầu lặp (đưa negative examples vào prompt — học từ danh mục "câu cấm" của AICake ngữ cảnh mẫu: **USE** ý tưởng).

---

## 8. ĐÁNH GIÁ PROTOTYPE LOCAL (bot-ban-hang) — USE / ADAPT / REJECT

| Thành phần | Phân loại | Nhận xét |
|---|---|---|
| `order-parser.js: boDau()` | **USE** | Chuẩn hoá bỏ dấu đúng, dùng lại làm lớp L1 của retrieval (mục 3.1). |
| `timSoDienThoai()` | **USE** | Regex 10 số + chuẩn hoá +84 ổn; bổ sung: chặn match SĐT nằm trong chuỗi dài hơn (đang có thể trúng 11 số — cắt còn 10 đầu). |
| `timDiaChi()` heuristic nhãn/địa danh | **ADAPT** | Giữ làm *gợi ý pre-fill* slot; quyết định cuối để VALIDATE (bảng hành chính), không tin heuristic 100%. |
| `timSanPham()` substring | **ADAPT** | Nâng lên L1–L4 (mục 3.1): thêm alias + fuzzy + multi-match; substring thuần sẽ trượt khi khách viết tắt/sai chính tả. |
| Nhận diện đơn bằng regex ý định + SĐT | **ADAPT** | Giữ làm **bộ phát hiện rẻ** (không tốn token) để quyết định "có đang trong luồng đơn không"; việc bóc slot chuyển dần cho LLM có schema (structured output) + validate. Lý do: regex `Y_DINH_DAT` hiện match "mua " khá rộng, dễ false positive. |
| `reply-engine.js: buildSystemPrompt()` (văn phong, chia `---`, không bịa, hỏi thiếu đúng chỗ, ngữ cảnh shop tự soạn `nguCanhBanHang`) | **ADAPT** | Xương sống prompt giữ nguyên; tách thành: policy (cố định) + FACTS (mỗi lượt) + window/summary (mục 2.2); hạ `temperature` từ 0.9 → 0.3–0.6 (bán hàng cần ổn định; 0.9 là nguyên nhân biasa bịa). |
| `hoiAI()` DeepSeek/OpenAI-compatible + timeout + fallback kịch bản khi AI lỗi | **USE** | Kiến trúc đúng: AI lỗi không chết bot. Bổ sung retry/ circuit-breaker. |
| `xacNhanDon()` template từ dữ liệu parse | **ADAPT** | Đúng tinh thần "bill máy render" (mục 5.4) — nâng dữ liệu nguồn từ `parse()` heuristic lên OrderDraft đã VALIDATE; bỏ gắn `chuKy` vào bill (bill phải sạch). |
| FAQ kịch bản + `{DANH_SACH}` | **ADAPT** | Giữ làm lớp dự phòng khi AI chưa cấu hình; lâu dài FAQ chỉ là tài liệu nguồn cho FACTS. |
| `fallbackPool` xoay vòng 5 câu | **USE** | Đã tự nhiên, dùng thẳng. |
| `server.js`: verify chữ ký `X-Hub-Signature-256`, trả 200 ngay rồi xử lý nền, postback menu, comment feed webhook, TEST_MODE outbox, `/api/test-reply` | **USE** | Đúng chuẩn tích hợp; outbox + test-reply là nền cho 18 case mô phỏng. |
| `server.js`: `xuLyTin()` tách `---` + delay 1500ms + ghi cả 2 chiều | **USE/ADAPT** | Giữ cơ chế; delay ngẫu nhiên hoá (mục 7). |
| `server.js`: KHÔNG dedupe `msg_id` — webhook duplicate → trả lời 2 lần | **REJECT** (sửa) | Case 10 bắt buộc: thêm bảng `seen_msg_ids` + idempotency. |
| `server.js`: gửi đi không track kết quả (timeout chưa biết thành công) | **REJECT** (sửa) | Case 11: outbox cần trạng thái `pending/sent/failed` + verify (đọc lại hội thoại/đối soát) trước khi retry. |
| Tạo order `addOrder` không idempotency | **REJECT** (sửa) | Case 12: `idempotency_key` bắt buộc (mục 2.1). |
| Post-sale `setInterval` quét mỗi giờ, tự nhắn cảm ơn | **ADAPT** | Ý đúng (case 17) — chuyển sang job queue có lịch + check `marketing_consent` (case 18) + chống gửi trùng (`careSent` đã có, giữ). |
| Tin báo trạng thái giao hardcode | **ADAPT** | Đưa vào reply policy + chỉ render khi order DB xác nhận trạng thái thật (webhook ĐVVC), không phải khi admin bấm nút là tin ngay. |
| `store.js` JSON file | **USE cho prototype / REJECT cho production** | Đúng ghi chú trong file: thay SQLite, giữ interface. |
| `store.js` cap 500 tin TOÀN CỤ (mất lịch sử khách cũ) | **REJECT** (sửa) | Cap per-conversation; lưu trữ đầy đủ để AI "hiểu toàn bộ lịch sử từng khách" (yêu cầu đề bài). |
| `lichSu()` lọc theo (channel, senderId) | **ADAPT** | Unified theo customer_id (2 kênh 1 lịch sử). |

---

## 9. SƠ ĐỒ STATE MACHINE (text)

```
                        ┌──────────────────────────── mode: AUTO ⇄ HUMAN (mọi state) ───────────────────────────┐
                        │                                                                                        │
  inbound (comment/inbox/voice/ảnh→STT/vision)                                                           ┌───────────────┐
        │                                                                                                │    CLAIM      │
        ▼                                                                                                │ (khiếu nại /  │
   NEW_LEAD ──nhu cầu chung──▶ DISCOVERY ──nhắc SP cụ thể──▶ PRODUCT_QA ──ý định mua──▶ BUY_INTENT        │  giao thất bại)│
        ▲                              │  ▲   │                      │ │                    │              └──────┬────────┘
        │                              │  │   └──đổi SP (giữ slot    │ │                    │                     │ vào từ
        └──── quay lại vòng mới ───────┘  │       ko phụ thuộc SP)───┘ │                    │                     │ ORDERED/
        (AFTER_SALES có đơn mới)          │                            │                    │                     │ SHIPPING/
                                          └── không tìm thấy SP ───────┘                    │                     │ AFTER_SALES
                                          (gợi ý từ DB / hỏi lại)                           ▼                     │
                                                                              COLLECT_ORDER ◀───────────┐               │
                                                                                  │ đủ trường            │ sửa/thiếu     │
                                                                                  ▼                      │ trường        │
                                                                              VALIDATE ──fail──▶ COLLECT_ORDER          │
                                                                                  │ pass                                │
                                                                                  ▼                                     │
                                                                              CONFIRM ──khách sửa──▶ COLLECT_ORDER      │
                                                                                  │ khách xác nhận                       │
                                                                                  ▼ (Action Gate:                        │
                                                                                  │  re-check tồn kho,                   │
                                                                                  │  idempotency_key)                    │
                                                                              ORDERED ──webhook ĐVVC nhận hàng──▶ SHIPPING
                                                                                  ▲                                     │
                                                                                  │ resolve xong quay về state cũ ◀─────┘
                                                                                  │                                     │ giao thành công
                                                                                  └────────────── vòng mới ◀── AFTER_SALES (follow-up, opt-out marketing dừng)
```

---

## 10. MAPPING 18 CASE → CƠ CHỮ LÝ

| # | Case | State/mode | Cơ chế chính |
|---|---|---|---|
| 1 | Hỏi giá | PRODUCT_QA | Retrieval → FACTS giá từ DB; guard quét số tiền khớp FACTS (5.2). AI không có FACTS → không được nêu giá. |
| 2 | Hỏi size/màu | PRODUCT_QA | `variants` trong product DB trả size/màu + tồn từng variant; variant hết → nói hết đúng variant, gợi ý variant khác CÒN hàng từ DB. |
| 3 | Ảnh "còn cái này không" | PRODUCT_QA | Ảnh → vision caption → match SKU/alias (mục 3.1) → stock từ DB. Match không chắc → hỏi chọn giữa 2–3 ứng viên. |
| 4 | Gửi voice | (bất kỳ) | `user_send_voice`/audio attachment → tải murl/payload.url ngay → STT → `[VOICE: transcript]` vào pipeline text như thường; low confidence → hỏi lại. |
| 5 | Đổi SP giữa chừng | COLLECT_ORDER→PRODUCT_QA | CHANGE_SUBJECT: slot SP cũ → `stale`; giữ name/phone/address; quay lại PRODUCT_QA, BUY_INTENT lại → draft mới tái sử dụng slot. |
| 6 | Nhiều SKU | COLLECT_ORDER | `lines[]` mỗi line slot riêng (sku/size/màu/qty) + validate từng line; tổng tính máy từ giá DB. |
| 7 | Thiếu địa chỉ | VALIDATE fail → COLLECT_ORDER | Validate phát hiện thiếu/địa chỉ không đủ 3 cấp → hỏi lại ĐÚNG trường đó, kèm pre-fill gợi ý từ heuristic; các trường đã confirmed không hỏi lại. |
| 8 | AI định báo sai giá | PRODUCT_QA (chặn tại guard) | Guard post-check: số tiền trong output ≠ FACTS → chặn/replace bằng render từ DB + audit; đếm vi phạm → hạ confidence → takeover. |
| 9 | Hết stock lúc chốt | CONFIRM→ORDERED (Action Gate) | Re-check tồn kho tại EXECUTE (conditional update); fail → không tạo đơn, thông báo thật từ gate, đề xuất thay thế/số lượng ít hơn; VIP → mode=HUMAN. |
| 10 | Webhook duplicate | Gateway | `seen_msg_ids` dedupe theo `msg_id` (+ Zalo `msg_id`, FB `message.mid`); xử lý idempotent toàn bộ handler. |
| 11 | Timeout gửi message | Gateway | Outbox trạng thái `pending/sent/failed`; trước retry phải verify (đối soát hội thoại); đã thấy tin nằm trong hội thoại → không gửi lại. |
| 12 | Tạo order timeout | Action Gate | `idempotency_key` (conversation + draft hash) gửi kèm; timeout → VERIFY (query theo key) trước khi quyết định retry; chưa thấy order → retry cùng key, không tạo bản sao. |
| 13 | Khiếu nại | → CLAIM + mode=HUMAN | Từ khoá/classifier + (SHIPPING fail) → CLAIM; AI chỉ nói mẫu "để em báo chủ shop" (ADAPT của AICake), mọi cam kết do người; đơn vẫn chạy webhook bình thường. |
| 14 | Không đủ evidence | (bất kỳ) | SUBJECT UNKNOWN / FACTS rỗng → câu an toàn xoay vòng + hẹn chủ shop + audit; 2 lần liên tiếp → mode=HUMAN. |
| 15 | Human takeover | mode AUTO→HUMAN | 5 điều kiện mục 6.2; AI chuẩn bị draft gợi ý nhưng không gửi; badge trong Inbox. |
| 16 | Nhân viên trả quyền | mode HUMAN→AUTO | Nút "Trả lại AI" + ghi summary "người đã xử lý gì" vào lớp summary → AI không hỏi lại thông tin khách vừa đưa cho người. |
| 17 | Follow-up sau giao | AFTER_SALES | Job lịch (H+24h mặc định, cấu hình được): cảm ơn + xin đánh giá + ưu đãi (mượn từ prototype & AICake PWA-thông báo) — chỉ chạy khi `marketing_consent=true`. |
| 18 | Từ chối marketing | Automation gate | `marketing_consent=false` ghi vào Customer; automation lọc: message loại `transactional` (xác nhận đơn, giao hàng) vẫn gửi; loại `marketing` bị chặn ở cổng trước khi gửi; khách nói "đừng nhắn quảng cáo" bất kỳ lúc nào → update flag ngay. |

---

## 11. TỔNG KẾT: HỌC GÌ / BỎ GÌ CỦA AICAKE

**Học (USE/ADAPT):**
1. Trình tự onboarding hợp lý: kết nối page → kích hoạt → sản phẩm+kho (có cân nặng, ảnh) → ĐVVC → AI key → ngữ cảnh → test (ADAPT thành checklist Settings của mình).
2. Ngữ cảnh AI kiểu "tờ quy ước": xưng hô, thông tin shop, bảng SP, quy tắc giá, câu cấm nói (ADAPT: tách — phần policy cố định + phần FACTS render mỗi lượt).
3. Multi-model: text model rẻ + model đa phương thức cho ảnh/voice (ADAPT).
4. Quy tắc ảnh gửi đi: whitelist domain/đuôi file, cấm lấy link từ hội thoại/FB (USE nguyên trạng).
5. Tách câu reply để tự nhiên + quick reply/postback markers (ADAPT: `---`, button giai đoạn sau).
6. Comment automation: ẩn comment, reply biến `{{TenKhachHang}}`, tự inbox từ comment (ADAPT — thêm policy rate-limit + từ chối case nhạy cảm).
7. Webhook ĐVVC nhận trạng thái ngược (ViettelPost pattern) + xác nhận đơn trước khi đẩy + huỷ đồng bộ 2 chiều (USE đúng nguyên tắc VERIFY).
8. Trọng số kho hàng trong product record (weight_g) để tính phí ship (USE).

**Bỏ (REJECT) và vì sao:**
1. Giá/KM/tồn kho nằm trong prompt tĩnh do tay soạn → sai theo bảng giá, không có evidence. Thay bằng FACTS từ DB mỗi lượt.
2. "AI chốt đơn khi reply chứa từ khoá" — lời AI làm evidence thực thi. Thay bằng Action Gate từ OrderDraft validated.
3. Đ_state khách lưu trong tin nhắn assistant → mất dữ liệu. Thay bằng Customer/Conversation/OrderDraft schema.
4. "Mua 4 tự tính giảm giá" — tính KM giao LLM. Thay bằng hàm deterministic.
5. Tách câu theo dấu chấm tự động → tách sai ở số tiền; dùng marker tường minh.
6. Không có takeover/khiếu nại tường minh, không có dedupe/idempotency công khai trong guide → tự thiết kế (mục 1, 6, case 10–12).

**CHƯA XÁC MINH (cần evidence trước khi code):**
- Zalo OA voice: payload thật của `user_send_voice` (trường chính xác) + format file voice (mp3/amr/opus?) + thời hạn URL `murl` (tra nhanh khớp pattern nhưng chưa bấm thử).
- Chi tiết button/quick reply Zalo OA v3.0 (cú pháp gửi + giới hạn).
- FB audio attachment: format/giới hạn dung lượng thực tế.
- Webhook ĐVVC cụ thể (ViettelPost/GHN/GHTK): payload, secret, sandbox — làm theo pattern AICake bài 17 nhưng cần docs chính thức từng hãng.
- Ngưỡng N window/summary (12 tin / cập nhật 10 tin) — chỉ là giá trị khởi điểm, tinh chỉnh khi test 18 case.
- Mapping hành chính VN (tỉnh/huyện/xã) cho VALIDATE: chọn nguồn dữ liệu mở chính thức.

---
*AI2 — Sales AI/Workflow Reviewer. File này chỉ thiết kế, chưa build. Không sửa file nào khác ngoài file này.*
