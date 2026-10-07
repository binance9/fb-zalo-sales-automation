# CROSS-REVIEW — REVIEWER 3 (độ bền / bảo mật / khả thi kỹ thuật)

> Người viết: AI-3 (Backend / Security / Reliability) — vòng CROSS-REVIEW, ngày 2026-10-05.
> Đầu vào bắt buộc đã đọc: `docs/00-yeu-cau.md` (contract + INV-1…5) → `docs/AI3-failure-injection-v2.md` (bản của R3 — căn cứ độ bền) → `docs/AI1-capability-matrix.md` (matrix R1) → `docs/AI2-sales-ai-v2.md` (thiết kế R2) → source `prototype/src/*` để lấy evidence.
> Góc soi: **độ bền (reliability), bảo mật (an toàn dữ liệu/PII/token), khả thi kỹ thuật ở quy mô thật (nhiều page, nhiều khách, đa tiến trình)**.
> Phương pháp: (1) đối chiếu chéo doc ↔ doc ↔ code; (2) tái hiện thực nghiệm các nghi vấn trên chính prototype (mục Phụ lục — chạy lại được). Không sửa bất kỳ file nào khác ngoài file này.

---

## BẢNG TỔNG HỢP (18 findings: R1 = 6, R2 = 12)

| # | Nhắm | Lỗi/rủi ro (tóm tắt) | Mức |
|---|---|---|---|
| R1-1 | AI1 | INV-1 có 3 định nghĩa dedupe-key mâu thuẫn; giả định `mid`/`msg_id` ổn định trình bày như đã chốt trong khi AI3 ghi CHƯA XÁC MINH; luồng comment (`feed`) không có key | MAJOR |
| R1-2 | AI1 | Ràng buộc cửa sổ 24h + HUMAN_AGENT không được chuyển thành cơ chế thực thi ở bất kỳ tầng nào của R2/AI3 → auto-send sẽ vi phạm policy nền tảng ở production | MAJOR |
| R1-3 | AI1 | Zalo CS quota 8 tin/48h: không có budget per conversation; cache quota 60s tạo race → tin thứ 2 bị platform từ chối | MAJOR |
| R1-4 | AI1 | Zalo refresh-token xoay vòng: timeout lúc refresh = mất cả cặp token → khóa cả kênh Zalo vĩnh viễn; không có xử lý kiểu INV-2; race 2 worker refresh | MAJOR |
| R1-5 | AI1 | "Auto re-subscribe" sau Webhooks Disabled thiếu kênh alert out-of-band; không có backfill cho event mất trong cửa sổ chết | MINOR |
| R1-6 | AI1 | "Tải media NGAY" mâu thuẫn với budget ACK ~5s + batch 1000 + gateway đơn tiến trình | MINOR |
| R2-1 | AI2 | PII khách (SĐT/tên/địa chỉ) chui vào model context qua object `conv` đầy đủ — vi phạm "An toàn dữ liệu" của contract, phủ nhận tuyên bố cấu trúc A.2.2 | **BLOCKER** |
| R2-2 | AI2 | "Whitelist policy" cho tin system/transactional tuyên bố nhưng KHÔNG tồn tại trong code → kênh miễn kiểm bỏ qua cả takeover lẫn opt-out | MAJOR |
| R2-3 | AI2 | Doc R2 mô tả cơ chế INV-5 theo bản prototype CŨ (hủy cả job check_receipt) — mâu thuẫn trực tiếp với bản vá AI3 v2; làm theo sẽ tái tạo bug mất đường đối chứng (INV-2) | MAJOR |
| R2-4 | AI2 | Race scheduler-vs-takeover chưa đóng: follow-up đang RUNNING không bị chạm; mode chỉ check trước khi send, không re-check tại điểm gửi → vi phạm INV-5 khi đa tiến trình | MAJOR |
| R2-5 | AI2 | Auto-takeover bởi 'system' không có SLA/timeout trả quyền → hội thoại kẹt HUMAN vô hạn, AI câm hoàn toàn với khách | MAJOR |
| R2-6 | AI2 | Idempotency key outbound = hash(text) khi event=null → nuốt tin hợp lệ; follow-up đánh SENT bất kể kết quả gửi (đã tái hiện) | MAJOR |
| R2-7 | AI2 | Bóc số lượng lấy SỐ ĐẦU TIÊN trong đoạn → SĐT trong câu mua thành qty=903.123.456 (đã tái hiện); khách bị chặn mua vô lý | MAJOR |
| R2-8 | AI2 | Không TTL cho DRAFT → reserve rò rỉ vô hạn với giỏ bỏ dở → "hết hàng ảo" cho mọi khách sau | MAJOR |
| R2-9 | AI2 | shipping_fee hardcode 25000 — vi phạm nguyên tắc vàng (phí ship từ DB/API thật); phaseB không re-validate phí | MINOR |
| R2-M1 | AI2 | fillSlots ghi đè slot đã `confirmed` + ghi đè `customer.phone` — trái chính tả slot-state của chính R2 (A.1.3) | MINOR |
| R2-M2 | AI2 | `claim` không có cơ chế close — "đóng xong quay về origin_state" không thể xảy ra | MINOR |
| R2-M3 | AI2 | Mode HUMAN early-return TRƯỚC fillSlots → dữ liệu khách đưa trong lúc nhân viên xử lý bị vứt; handback xong AI hỏi lại | MINOR |

---

## PHẦN 1 — FINDINGS NHẮM VÀO AI1 (capability matrix)

### R1-1 — INV-1: 3 định nghĩa dedupe-key mâu thuẫn; giả định ID nền tảng ổn định được trình bày như đã chốt
- **NHẪM AI**: AI1 (`docs/AI1-capability-matrix.md`).
- **LỖI/RỦI RO**: Cùng một invariant nhưng matrix đưa ra 3 spec key khác nhau, và giả định then chốt (ID nền tảng ổn định qua resend) được ghi là quyết định dù chính hệ thống đã tự đánh dấu chưa xác minh. Nếu `mid` không ổn định qua 36h retry của Meta (A19), dedupe tầng nhận sụp đổ → INV-1 vỡ đúng ở kịch bản thật mà nó sinh ra để chống. Riêng luồng comment `feed` (A6 — bắt buộc theo contract "comment automation", `00-yeu-cau.md` mục Mục tiêu) dùng `comment_id` chứ không có `mid` — dedupe cho cả tính năng này chưa được định nghĩa trong bất kỳ dòng nào của matrix.
- **EVIDENCE**:
  - `AI1-capability-matrix.md` A1: "`mid` = key idempotency (INV-1)"; B1: "`msg_id` = key idempotency (INV-1)".
  - Cùng file, mục D, dòng INV-1: "Bảng `raw_event` với unique key (`channel`, `sender`, `mid`/`msg_id`) + watermark timestamp" — khác A1/B1 (thêm `sender`) và khác hoàn toàn key đang cài trong prototype: `gateway.js` dòng 25 `event_id = ${channel}:${platformEventId}` (không có `sender`).
  - `AI3-failure-injection-v2.md` mục 9, điểm 3: "Việc Meta mid / Zalo msg_id có ổn định qua resend thật hay không vẫn CHƯA XÁC MINH (AI3 Phụ lục C.1/C.6) — mock không chứng minh được" — mâu thuẫn với giọng khẳng định của A1/B1.
- **MỨC**: MAJOR.
- **ĐỀ XUẤT KHẮC PHỤC**: Chốt MỘT spec key duy nhất trong contract kỹ thuật: natural key theo loại event (`mid` cho Messenger message, `msg_id` cho Zalo, `comment_id` cho feed) + fallback content-hash (`channel + sender + platform_ts + sha256(raw)`) cho event không có natural key; "ổn định của mid qua resend" là item xác minh bắt buộc tuần 1 (trùng kế hoạch AI3 mục 9.3), và补 bảng D của matrix cho khớp A1/B1.

### R1-2 — Cửa sổ 24h + HUMAN_AGENT: ràng buộc nền tảng không được chuyển thành cơ chế thực thi nào ở tầng dưới
- **NHẪM AI**: AI1 (chính), kéo theo AI2/AI3 (không ai nhận nốt).
- **LỖI/RỦI RO**: Matrix ghi đúng ràng buộc nhưng dừng ở "ảnh hưởng thiết kế" dạng ghi chú; không một thiết kế hay dòng code nào trong lab thực thi nó. Chạy thật, tin tự động đầu tiên sau 24h sẽ bị Meta từ chối → theo thiết kế v2 rơi nhánh FAILED + đẩy người (`action-gate.js` dòng 243–244) → after-sales/follow-up FB đổ hàng loạt vào worklist nhân viên. Tệ hơn: timeline tự thiết kế của hệ thống (check_receipt +60s×3, follow-up +2 ngày) nằm ngoài cửa sổ trong đúng các kịch bản chuẩn của nó.
- **EVIDENCE**:
  - `AI1-capability-matrix.md` A9 ảnh hưởng thiết kế: "Lưu `last_user_event_ts` per PSID; Reply Policy kiểm tra clock trước khi gửi"; A12: "Map thẳng vào INV-5: chỉ bật khi session đang HUMAN_OWNED; bot KHÔNG tự dùng tag này".
  - `AI2-sales-ai-v2.md` A.1.2 liệt kê đủ 3 tầng chặn của hệ thống (AUTHORIZE / pipeline / scheduler) — không tầng nào nhắc cửa sổ 24h; A.1.4 bảng INV cũng không.
  - Code: `action-gate.js` `authorize()` dòng 158–180 — không có rule window; `session.js` `ensureConversation()` dòng 54–78 — không có field `last_user_event_ts`; `gateway.js` `normalize()` dòng 84–110 — không cập nhật timestamp tương tác.
- **MỨC**: MAJOR.
- **ĐỀ XUẤT KHẮC PHỤC**: Thêm `last_user_event_ts` (per channel+customer) vào schema, cập nhật ở gateway khi normalize event inbound; thêm 1 rule AUTHORIZE per-channel: FB — tin `ai`/`system` ngoài 24h chỉ được đi qua Utility template (A13) hoặc `human_agent` với tag HUMAN_AGENT (A12); đưa vào `invariants-check.js` một vùng test thứ 7.

### R1-3 — Zalo CS quota 8 tin/48h: không budget per conversation + cache 60s tạo race quota
- **NHẪM AI**: AI1 (matrix tính đúng rào cứng nhưng không được vận hành hóa), kéo theo AI2 (luồng tin không biết chuyện quota).
- **LỖI/RỦI RO**: (i) Luồng mua chuẩn của R2 trên Zalo tốn ≥5 tin CS (hỏi SĐT → hỏi địa chỉ → bill → xác nhận+kèm vận đơn → follow-up care) = 62,5% quota 48h của MỘT khách cho MỘT đơn; hết quota là rào cứng cứng phía platform (B9) → mọi tin sau bị từ chối → theo thiết kế v2 là FAILED + needsHuman. (ii) Giữa B5 ("đọc `cs_reply.remain` TRƯỚC mỗi auto-send") và B6 ("cache TTL ngắn ≤ 60s") mâu thuẫn nhau; cache 60s cho phép 2 auto-send trong cùng cửa sổ TTL cùng thấy remain=1 rồi cùng gửi — tin thứ 2 chắc chắn bị platform hủy.
- **EVIDENCE**:
  - `AI1-capability-matrix.md` B5: "**8 tin CS / 48h per user**"; B9: "hết `remain` → API từ chối"; B6: "đọc động mỗi lần quyết định gửi + cache TTL ngắn (≤ 60s)".
  - `AI2-sales-ai-v2.md` A.1.1 (COLLECT_ORDER slot-filling SĐT → địa chỉ → tên), A.2.4 (bill → confirm → ship notify) — không một chỗ nào đếm tin per conversation; `action-gate.js` `authorize()` không có khái niệm quota.
- **MỨC**: MAJOR.
- **ĐỀ XUẤT KHẮC PHỤC**: Reply Gate Zalo thêm budget counter per conversation (warn ở remain ≤ 2, dừng auto + chuyển human); gộp bill+xác nhận thành 1 template; tin đơn hàng đi loại `transaction` theo B8 (không tốn cs_reply) và map msgKind nội bộ → loại tin Zalo/FB tường minh ở gateway; quota check kiểu check-and-decrement nguyên tử, không cache khi remain thấp.

### R1-4 — Zalo refresh-token xoay vòng: timeout lúc refresh = mất cả cặp token → khóa cả kênh, không có xử lý kiểu INV-2
- **NHẪM AI**: AI1.
- **LỖI/RỦI RO**: Refresh token là one-time-use (rotation) nhưng token service được thiết kế như một cron bình thường ("alarm khi fail" — chuông reo SAU khi đã chết). Kịch bản hở đúng họ USD mà AI3 đã chứng minh với send/carrier: HTTP refresh treo mất response → platform ĐÃ cấp cặp mới và vô hiệu refresh_token cũ → hệ thống không nhận được gì → cả access (≤25h) lẫn refresh đang lưu đều chết → toàn bộ OA của shop mất kênh, recovery duy nhất là owner làm lại OAuth (B14). Cron 12h với access 25h chỉ cho 2 lần cơ hội. Thêm: ở production đa tiến trình (AI3 mục 9.1 thừa nhận SQLite thật có nhiều connection), 2 worker refresh đồng thời bằng cùng refresh_token → một cái chết cháy token của cả hệ.
- **EVIDENCE**:
  - `AI1-capability-matrix.md` B13: "refresh token XOAY VÒNG (dùng 1 lần, nhận cặp mới)"; "Token Service: cron refresh mỗi 12h; LƯU ĐÈ CẢ HAI token ngay khi refresh (rotation — refresh cũ chết sau 1 lần dùng); alarm khi fail".
  - `AI3-failure-injection-v2.md` mục 9 điểm 4: "Hành vi idempotency thật của API ngoài … cần key thật để xác minh" — nhưng token service không nằm trong bất kỳ thiết kế nào để áp nguyên tắc này.
- **MỨC**: MAJOR (single point of total channel outage cho Zalo).
- **ĐỀ XUẤT KHẮC PHỤC**: Coi refresh là thao tác INV-2-class: ghi intent trước; single-flight per OA (khóa per-shop trong DB, worker khác thấy "đang refresh" thì bỏ lượt); timeout của refresh = UNKNOWN → cảnh báo NGAY (không đợi fail) + cron thít lại mỗi 1h khi token age > 20h; lưu pre-refresh state để audit/forensic; đo trước "refresh bằng token đã dùng trả lỗi gì" để phân biệt đã-rotate-chưa-nhận.

### R1-5 — "Auto re-subscribe" sau Webhooks Disabled: thiếu kênh alert out-of-band + không có backfill event mất
- **NHẪM AI**: AI1.
- **LỖI/RỦI RO**: Khi webhook đã bị disable, alert không thể đi qua chính webhook — "monitor alert + auto re-subscribe" như ghi trong matrix cần một kênh ngoài (poll định kỳ) mà không ai thiết kế. Quan trọng hơn: A19 tự ghi "không query được dữ liệu webhook lịch sử" → mọi event trong cửa sổ chết (≥1h, với retry 36h thì gap có thể rộng hơn) mất VĨNH VIỄN — INV-1 im lặng về hồi phục khoảng trống này; khách nhắn trong lúc hệ thống chết sẽ không bao giờ được trả lời và không ai biết.
- **EVIDENCE**:
  - `AI1-capability-matrix.md` A19 ảnh hưởng thiết kế: "monitor alert 'Webhooks Disabled' + auto re-subscribe `subscribed_apps`"; cùng ô: "không query được dữ liệu webhook lịch sử"; "fail tiếp diễn 1 giờ → … unsubscribed khỏi Page".
  - Không thiết kế nào (AI1/AI2/AI3) có job poll `subscribed_apps` hay bước re-sync hội thoại sau phục hồi.
- **MỨC**: MINOR (vận hành) — nhưng gap event-loss là thật và nên khối hóa trước go-live.
- **ĐỀ XUẤT KHẮC PHỤC**: Job monitor định kỳ (≤15 phút) gọi `GET /{page-id}/subscribed_apps` — phát hiện unsubcribe trước mốc 1h; sau khi phục hồi, re-sync conversations từ checkpoint thời gian; ghi nhận gap vào audit để đối soát.

### R1-6 — "Tải media về storage NGAY" mâu thuẫn với budget ACK ~5s + batch 1000 + gateway đơn tiến trình
- **NHẪM AI**: AI1.
- **LỖI/RỦI RO**: A4 (video/file SUPPORTED) có thể hàng chục MB. Tải đồng bộ "NGAY" (như matrix chỉ) trước ACK, với batch tới 1000 update và gateway đơn tiến trình, sẽ phá budget ~5s → Meta coi là fail → retry → nhân bản event → tải lại → vòng tảixoáy (load spiral). Mâu thuẫn nội tại giữa 3 dòng của chính matrix.
- **EVIDENCE**:
  - `AI1-capability-matrix.md` A2: "Tải media về storage nội bộ NGAY"; A1/A19: "Trả 200 OK trong ~5s"; A19: "batch tối đa 1000 update".
  - `AI3-failure-injection-v2.md` mục 9 điểm 1: nền tảng hiện tại là đơn tiến trình; `gateway.js` `downloadMedia()` dòng 112–117 là sync writeFileSync.
- **MỨC**: MINOR.
- **ĐỀ XUẤT KHẮC PHỤC**: ACK-first (persist raw payload + xếp hàng), worker riêng tải media bất đồng bộ với retry + giới hạn đồng thời per Page; chú ý URL media có hạn dùng (B2) — re-fetch có token tại gateway TRƯỚC hạn, nếu hết hạn → câu an toàn + needsHuman (không đoán nội dung ảnh/voice).

---

## PHẦN 2 — FINDINGS NHẮM VÀO AI2 (thiết kế Sales AI v2)

### R2-1 — PII khách chui vào model context qua object `conv` đầy đủ — vi phạm contract "An toàn dữ liệu" — **BLOCKER**
- **NHẪM AI**: AI2 (`docs/AI2-sales-ai-v2.md`).
- **LỖI/RỦI RO**: Contract bắt buộc "PII khách: chỉ truyền phần tối thiểu cần thiết cho từng bước" (`00-yeu-cau.md` mục An toàn dữ liệu). Thiết kế R2 tự tuyên bố tách cấu trúc: "sales-ai.js … **chỉ nhận FACTS** và trả lời đề nghị" (A.2.2). Thực tế pipeline truyền nguyên object `conv` vào ctx của model — object này chứa `draft.slots.phone.value`, `draft.slots.address.value`, `draft.slots.name.value` (SĐT + địa chỉ + tên khách), cộng `human_agent`, `claim`. Với stub thì vô hại (stub bỏ qua `conv`) nên 18/18 PASS không lộ; khi gắn LLM thật, toàn bộ ctx được serialize vào prompt → PII đi ra nhà cung cấp model + nằm trong log prompt. Đây chính là lỗ hổng an toàn dữ liệu mà contract đặt ở hàng rào cứng, và nó phủ nhận đúng tính "chỉ nhận FACTS" mà R2 chọn làm chứng cứ chống hallucination.
- **EVIDENCE**:
  - `pipeline.js` dòng 242: `this.ai.propose(intent, { text, normText: normKey(text), facts, conv })`; dòng 292–295 (routeBuy truyền `conv`); dòng 487 (routeChitchat truyền `conv`).
  - `session.js` `getDraft()` dòng 120–133: `draft.slots = { name:{value…}, phone:{value…}, address:{value…} }` — `conv.draft` là một phần của object truyền vào `propose`.
  - `AI2-sales-ai-v2.md` A.2.2: "sales-ai.js KHÔNG import store/product-db/gateway — nó chỉ nhận FACTS và trả lời đề nghị"; `00-yeu-cau.md`: "PII khách: chỉ truyền phần tối thiểu cần thiết cho từng bước".
- **MỨC**: **BLOCKER** (vi phạm hard rule dữ liệu của contract; đường lọt PII ra ngoài hệ thống khi gắn model thật; sửa rẻ nhưng phải sửa TRƯỚC khi gắn LLM).
- **ĐỀ XUẤT KHẮC PHỤC**: Thay `conv` bằng context object trắng `{ state, mode, subject_sku }`; thêm 1 assert vào suite: "ctx truyền vào sales-ai KHÔNG chứa chuỗi khớp SĐT/địa chỉ/tên khách" (test được ngay trên stub — không cần model thật).

### R2-2 — "Whitelist policy" cho tin system/transactional tuyên bố nhưng không tồn tại trong code
- **NHẪM AI**: AI2.
- **LỖI/RỦI RO**: Ngoại lệ system/transactional là lỗ hổng duy nhất của cơ chế INV-5 (R2 tự nhận) và R2 quy tắc hóa: "mọi template `system` mới phải thêm vào danh sách liệt kê tường minh + audit riêng". Nhưng trong code, "whitelist" này không tồn tại dưới bất kỳ hình thức nào — không bảng template, không kiểm tra text, không template_id trong audit. Bất kỳ đường code nào gọi `sendReply({ sender:'system', msgKind:'transactional', text: <gì cũng được> })` đều lọt cổng AUTHORIZE dù hội thoại đang HUMAN_OWNED, và vì opt-out chỉ check marketing/care, đây là kênh gửi tự do tới cả khách đã từ chối marketing. R2 có thừa nhận "prototype chấp nhận rủi ro này vì 1 file" — nhưng câu "text thuộc whitelist policy" mô tả trạng thái HIỆN TẠI là không đúng sự thật: hiện tại không có cơ chế nào xác thực text của tin system.
- **EVIDENCE**:
  - `AI2-sales-ai-v2.md` A.1.2: "template hệ thống cố định … đi với `actor='system'`, **text thuộc whitelist policy**, audit ghi rõ sender=system".
  - `action-gate.js` `authorize()` dòng 158–180: không một phép kiểm tra text/template; dòng 169: opt_out chỉ áp dụng `(msgKind === 'marketing' || msgKind === 'care')`.
  - `pipeline.js` `handleComplaint()` dòng 532–536: text template viết inline trong route — "whitelist" chỉ là ý niệm, không có artifact nào để audit.
- **MỨC**: MAJOR.
- **ĐỀ XUẤT KHẮC PHỤC**: Bảng template cứng `SYSTEM_TEMPLATES = { COMPLAINT_ACK: '…', OPT_OUT_ACK: '…' }` ở một module riêng; authorize với actor=system BẮT BUỘC khớp `intent → template_id` và text render từ bảng; audit ghi `template_id`; test injection: gọi sendReply với sender=system + text lạ → phải REJECT.

### R2-3 — Doc R2 mô tả cơ chế INV-5 theo bản prototype CŨ, mâu thuẫn trực tiếp với bản vá AI3 v2
- **NHẪM AI**: AI2.
- **LỖI/RỦI RO**: R2 chốt cơ chế "takeover hủy sạch mọi job QUEUED (check_receipt, follow-up, marketing)" — đúng theo vòng 1 nhưng AI3 v2 đã chứng minh hành vi đó là bug thật: hủy job `check_send_receipt` làm exec TIMEOUT_UNKNOWN mất đường đối chứng vĩnh viễn (vi phạm INV-2) và đã vá bằng whitelist `NOT_CANCELLABLE_BY_TAKEOVER`. Ai đọc R2 để implement (đúng vai trò của doc thiết kế) sẽ tái tạo đúng bug đã được chứng minh và vá. Hội đồng không được có 2 tài liệu mô tả CƠ CHẾ CÙNG MỘT HÀNH VI khác nhau mà không ai ghi chú mâu thuẫn.
- **EVIDENCE**:
  - `AI2-sales-ai-v2.md` A.1.2 tầng 3: "`takeover.setTakeover()` **hủy sạch mọi job QUEUED của hội thoại** (check_receipt, follow-up, marketing)"; A.1.4 dòng INV-5 kế thừa "3 tầng nêu A.1.2"; Kết luận #1 không hiệu chỉnh.
  - `takeover.js` dòng 14: `NOT_CANCELLABLE_BY_TAKEOVER = new Set(['check_send_receipt', 'reconcile_shipment'])`; dòng 27–30: chỉ hủy job ngoài whitelist.
  - `AI3-failure-injection-v2.md` Vùng 2 + Bảng mục 8 #1: hủy job đối chứng = "exec mất đường tra receipt vĩnh viễn (không DONE/DLQ/alert)".
- **MỨC**: MAJOR (thiết kế vs hệ thống đã vá — rủi ro hồi quy khi build thật).
- **ĐỀ XUẤT KHẮC PHỤC**: R2 re-base A.1.2/A.1.4 theo whitelist; quy ước council: mọi doc chạm cơ chế của người khác phải ghi "đã đối chiếu bản <tên file> ngày <ngày>".

### R2-4 — Race scheduler-follow-up vs takeover chưa đóng: RUNNING không bị chạm + không re-check mode tại điểm gửi
- **NHẪM AI**: AI2 (cơ chế 3 tầng của A.1.2 là của R2; AI3 vá được phần QUEUED nhưng phần RUNNING thuộc luồng scheduler của R2).
- **LỖI/RỦI RO**: Chuỗi production thật (SQLite đa tiến trình): worker scheduler pop follow-up, authorize thấy mode=AI → ALLOW; trong khoảnh khắc đó worker takeover commit mode=HUMAN + hủy job QUEUED; worker scheduler tiếp tục executeSend → tin marketing/care đi ra ngoài trong lúc HUMAN_OWNED — vi phạm INV-5 đúng chữ "CẤM MỌI auto-send". Prototype chỉ an toàn vì đơn luồng (sendFollowUp chạy đồng bộ, không ai chen được) — tức là cơ chế được chứng minh nhờ điều kiện vận hành mà chính AI3 ghi là KHÔNG còn đúng ở production (mục 9.1). SetTakeover chỉ chạm `jobs` có `status === 'QUEUED'`; follow_ups (kể cả đang `RUNNING`) không phải jobs nên không bị chạm; mode không được đọc lại sau điểm authorize.
- **EVIDENCE**:
  - `app.js` dòng 112–119: pop follow-up, `fu.status = 'RUNNING'` (dòng 117) rồi gọi `gate.sendFollowUp` (dòng 118).
  - `action-gate.js` dòng 158–167: `conversation.mode` đọc MỘT lần trong authorize; `executeSend` (dòng 183–254) ghi message + gọi platform không re-check.
  - `takeover.js` dòng 27–30: chỉ hủy `j.status === 'QUEUED'` trong bảng `jobs`.
  - `AI3-failure-injection-v2.md` mục 9 điểm 1: "SQLite thật … 2 instance/2 connection ghi cùng lúc — thứ JSON-mock không tái hiện được".
- **MỨC**: MAJOR.
- **ĐỀ XUẤT KHẮC PHỤC**: Ở production: re-check `mode` trong CÙNG transaction ghi message (SELECT conversation kèm khóa ghi ngay trước platform call); hoặc scheduler đánh dấu follow-up `IN_FLIGHT` và `setTakeover` buộc chuyển `IN_FLIGHT` → `HELD` (worker tôn trọng khi commit). Thêm vào suite một kịch bản mô phỏng chen takeover giữa authorize và execute (inject hook).

### R2-5 — Auto-takeover bởi 'system' không có SLA/timeout trả quyền → hội thoại kẹt HUMAN vô hạn
- **NHẪM AI**: AI2.
- **LỖI/RỦI RO**: Vòng đời takeover (A.4) có bước "TRẢ QUYỀN" nhưng không định nghĩa ai trả, khi nào, và không có timer nào. Case 11b/12 cho phép hệ TỰ takeover (reason `send_timeout_no_receipt`, `human_agent='system'`) — kịch bản thật: DLQ lúc 2h sáng, chủ shop một mình đang ngủ → mọi tin nhắn sau đó của khách chỉ được "lưu + HOLD_FOR_AGENT" (`pipeline.js` dòng 110–121); khách đang giữa luồng mua bị câm vô thời hạn; worklist OPEN không ai đọc. INV-5 được áp đúng luật nhưng thiếu cơ chế tránh lạm dụng quá lâu — độ bền của LUỒNG KINH DOANH không được bảo đảm.
- **EVIDENCE**:
  - `action-gate.js` dòng 302–313: system tự `MODE_CHANGE to HUMAN` khi `NO_RECEIPT_AFTER_3_CHECKS`.
  - `AI2-sales-ai-v2.md` A.4: 5 bước vòng đời — không có deadline/SLA/escalate; `takeover.js`/`session.js`: không có cơ chế hẹn giờ handback (grep: chỉ `handback_at` ghi mốc, không ai đọc để timeout).
- **MỨC**: MAJOR.
- **ĐỀ XUẤT KHẮC PHỤC**: Thêm `human_deadline_at` theo severity khi takeover; job scheduler đếm ngược: quá hạn → escalate (notification cho owner) và theo chính sách shop: cho phép AI gửi 1 câu an toàn transactional ("nhân viên sẽ liên hệ lại") hoặc tự handback kèm disclosure (A18 bot 30s/disclosure của AI1 hỗ trợ đường này); metric `time_in_human` để đo.

### R2-6 — Idempotency key outbound = hash(text) khi event=null → nuốt tin hợp lệ; follow-up đánh SENT bất kể kết quả
- **NHẪM AI**: AI2 (cơ chế write-ahead/verify là phần A.1.4 + case 11b/17 của R2).
- **LỖI/RỦI RO**: Với mọi đường gửi KHÔNG có event (follow-up, agentSend, template system), key = hash của CHỈ text. Idempotency dùng sai mục đích — nó phải chặn retry của cùng intent, không được dedupe theo nội dung: hai follow-up khác nhau nhưng trùng text constant → tin thứ hai KHÔNG được gửi nhưng được verify DELIVERED (đọc nhầm receipt của tin thứ nhất) và được đánh `SENT`. Đã tái hiện thực nghiệm (mục Phụ lục, Probe 2): `platform.sentCalls = 1` trong khi `fu2.status = 'SENT'`, `delivery_status = 'DELIVERED'`. Hệ quả: khách có 2 đơn delivered chỉ nhận 1 tin feedback mà DB khai đã gửi đủ; agent chủ động gửi lại cùng một câu nhắc (hợp lệ) bị nuốt im lặng. Thêm: `sendFollowUp` đánh `status='SENT'` NGAY cả khi executeSend trả TIMEOUT_UNKNOWN/FAILED.
- **EVIDENCE**:
  - `action-gate.js` dòng 187: `const idem = \`send:${conversation.conversation_id}:${sha(text + (event ? event.event_id : ''), 20)}\``; dòng 190–192: trúng `existed` → return không gửi; dòng 535–537: `updateRow('follow_ups', … { status: 'SENT', exec_id })` không xem kết quả send.
  - Probe thực nghiệm: xem mục Phụ lục dưới cuối file.
- **MỨC**: MAJOR.
- **ĐỀ XUẤT KHẮC PHỤC**: Key theo intent id: `send:follow_up:<follow_up_id>`, `send:agent:<operator>:<uid>`, `send:system:<intent>:<conv>`; `follow_ups.status` chỉ `SENT` khi exec `DONE`; TIMEOUT/FAILED → giữ `SCHEDULED`/`FAILED` kèm lý do để reconcile/handback xử lý tiếp.

### R2-7 — Bóc số lượng lấy SỐ ĐẦU TIÊN trong đoạn: SĐT/giá trong câu mua thành số lượng đơn hàng
- **NHẪM AI**: AI2 (slot-filling/extractItems là lõi thiết kế A.1.3/A.2 của R2; 18 case của R2 không phủ case số-đứng-trước-SP).
- **LỖI/RỦI RO**: `RE.qtyWord` có nhóm đơn vị OPTIONAL và `extractItems` lấy match đầu tiên bất kể ngữ cảnh → mọi số đứng trước tên SP (SĐT, giá, mã) bị nhận làm qty. Đã tái hiện trên prototype thật: `extractItems('sdt 0903123456 cho minh 1 hop tra hoa say')` → `{"sku":"TRA-HOA-SEY-50","qty":903123456}`. Với qty đó phaseA chắc chắn `OUT_OF_STOCK` (`order-engine.js` dòng 73–75) → khách BỊ CHẶN mua hoàn toàn bằng một câu hoàn toàn bình thường (nhắn SĐT kèm ý định mua — đúng kịch bản `COLLECT_ORDER` mà hệ thống khuyến khích). Ngược lại qty trúng giá ("nến vanilla giá 185000 lấy cho mình") làm giỏ sai/empty. Đây là lỗi khả thi kỹ thuật của chế độ auto: guard INV-4 bảo được kho nhưng không bảo được đơn sai số lượng, và khách bỏ đi không vì hết hàng.
- **EVIDENCE**:
  - `pipeline.js` dòng 21: `qtyWord: /(\d+)\s*(?:cai|cái|hop|hộp|sp|san pham|sản phẩm)?/` (nhóm đơn vị có `?`); dòng 187–189: `const q = seg.match(RE.qtyWord); const qty = q ? parseInt(q[1], 10) : 1;`.
  - Probe thực nghiệm: mục Phụ lục (Probe 1).
- **MỨC**: MAJOR.
- **ĐỀ XUẤT KHẮC PHỤC**: qty chỉ nhận khi số KẾT HỢP đơn vị bắt buộc (`(\d+)\s*(cai|cái|hop|hộp|…)\b`) hoặc nằm trong cửa sổ ≤3 token trước match SP; số ≥ ngưỡng (vd 1.000) hoặc khớp `extractPhone` → loại khỏi ứng viên qty; qty giả định = 1 và hỏi lại xác nhận. Thêm case test: "sdt 09xx … cho mình 1 hộp X" và "giá 185000 lấy 1".

### R2-8 — Không TTL cho DRAFT → reserve rò rỉ vô hạn với giỏ bỏ dở → "hết hàng ảo"
- **NHẪM AI**: AI2 (vòng đời draft/state machine là thiết kế của R2; AI3 chỉ mô tả cơ chế reserve chứ không có expiry — lỗi thuộc cả hai nhưng bảng state/draft là tài sản của R2).
- **LỖI/RỦI RO**: PhaseA giữ chỗ NGAY khi đủ slot (`tryCreateOrder` gọi khi slots đủ). Draft chỉ được hủy khi: đổi SP, OUT_OF_STOCK/PRICE_CHANGED lúc confirm. Kịch bản phổ biến NHẤT trong bán hàng thật — khách nhận bill (CONFIRM) rồi im lặng — không có đường hết: không job expire, không TTL trong thiết kế A.1/A.2/A.6 hay trong code. Mỗi lead bỏ dở khoá một phần `stock_reserved` MÃI MÃI; vài chục lead → `effective = 0` → mọi khách sau nhận "hết hàng" cho hàng còn nguyên trong kho; bảng `orders` + reserve tích vô hạn không có sweep. Với nhiều shop nhiều lead, đây là lỗi độ bền vận hành bậc nhất của luồng chốt đơn.
- **EVIDENCE**:
  - `order-engine.js` dòng 80–84 (reserve trong phaseA), `cancelDraft` chỉ gọi từ `doProductChange` / routeConfirm OUT_OF_STOCK/PRICE_CHANGED (`pipeline.js` dòng 373, 389, 456).
  - `AI2-sales-ai-v2.md` A.1.1 dòng CONFIRM: "chờ khách gật" — không có thời hạn; A.6 không có mục draft-expiry; grep toàn `src/`: `timeout_at` chỉ tồn tại cho send/shipment, không cho draft.
- **MỨC**: MAJOR.
- **ĐỀ XUẤT KHẮC PHỤC**: Job `expire_drafts` (run_at = created_at + 30–60 phút): DRAFT quá hạn → CANCELLED + release + gửi khách 1 tin transactional Utility ("đơn giữ chỗ hết hạn, cần thì nhắn lại") — khớp A13 của AI1; idempotency `#gen` của AI3 đã sẵn sàng cho mua lại sau đó; metric `draft_expired`.

### R2-9 — shipping_fee hardcode 25000: vi phạm nguyên tắc vàng, phaseB không re-validate phí
- **NHẪM AI**: AI2.
- **LỖI/RỦI RO**: Nguyên tắc vàng của contract liệt kê PHÍ SHIP vào nhóm "lấy từ DB/API thật", và matrix AI1 (D, dòng INV-4) yêu cầu "phí ship phải gọi lại API ĐVVC NGAY trước commit". R2 tuyên bố "Bill là artifact của dữ liệu" (A.5.3) nhưng phí trong bill là một hằng số cứng trong engine; phaseB re-validate giá/tồn mà KHÔNG re-validate phí —bill gửi khách chứa số phí không có nguồn, và khi cắm ĐVVC thật (GHN trước theo AI1 C1) sẽ sai khác phí quy đổi/region.
- **EVIDENCE**:
  - `00-yeu-cau.md` Nguyên tắc vàng: "Giá, tồn kho, SKU, khuyến mại, phí ship, trạng thái đơn … lấy từ DB/API thật".
  - `order-engine.js` dòng 87: `const shipping_fee = 25000;`; `pipeline.js` `renderBill` dòng 363 in `order.shipping_fee` cho khách; `order-engine.js` `phaseB` dòng 129–157: không check phí.
  - `AI1-capability-matrix.md` mục D dòng INV-4: "phí ship phải gọi lại API ĐVVC (GHN `Fees` …) NGAY trước commit".
- **MỨC**: MINOR (prototype-mock chấp nhận được) nhưng là item phải đóng trước khi cắm ĐVVC thật.
- **ĐỀ XUẤT KHẮC PHỤC**: Interface `carrier.quote(items, address)` gọi ở pha B trước commit; snapshot phí vào `price_snapshot_json`; fallback bảng phí của shop trong DB; thêm rule re-validate phí vào `invariants-check.js`.

### R2-M1..M3 — Ba điểm phụ (MINOR)
- **NHẪM AI**: AI2.
- **LỖI/RỦI RO & EVIDENCE**:
  - **M1 — fillSlots ghi đè slot `confirmed` + `customer.phone`**: `AI2-sales-ai-v2.md` A.1.3 quy ước "trường đã `confirmed` chỉ đổi khi khách nói rõ muốn sửa"; nhưng `pipeline.js` dòng 166–170: MỖI tin có chuỗi giống SĐT (kể cả khách nhắc lại số người khác) → `setSlot('phone', …, 'confirmed')` + `customer.phone = phone` không kiểm tra state hiện tại → CRM/đơn theo SĐT sai. Sửa: setSlot chỉ ghi đè khi state ≠ confirmed hoặc tin chứa ý định sửa; tách "phone của đơn" khỏi "phone CRM".
  - **M2 — `claim` không có close**: A.1.1 footnote hứa "đóng xong quay về `origin_state`" nhưng `session.js` chỉ có `openClaim` (dòng 110–117), không có hàm/flow close → khiếu nại mở vĩnh viễn, không audit thời điểm đóng. Sửa: `closeClaim(conv, actor)` + transition về `origin_state` + audit CLAIM_CLOSE.
  - **M3 — HUMAN mode bỏ fillSlots**: `pipeline.js` dòng 110–121 early-return TRƯỚC `fillSlots` (dòng 127) → mọi tin khách trong thời gian nhân viên xử lý không được bóc slot; sau handback AI hỏi lại SĐT/địa chỉ khách đã đưa — trái A.1.3 ("tin mới điền chỗ trống") và mục tiêu "AI hiểu toàn bộ lịch sử hội thoại". Sửa: trong mode HUMAN vẫn chạy fillSlots (chỉ bỏ phần propose/send).
- **MỨC**: MINOR (cả ba).

---

## PHỤ LỤC — KIỂM CHỨNG THỰC NGHIỆM CỦA R3 (chạy lại được)

Probe dựng App/Store thật của prototype, không sửa source:

**Probe 1 — R2-7 (qty = SĐT)**: `node -e` dựng `Pipeline` với Store/ProductDB thật rồi gọi `extractItems`:
```
CASE A (gia trong cau mua): []                                            ← "nến vanilla giá 185000 lấy…" → không bóc được giỏ
CASE B (SĐT trong cau mua): [{"sku":"TRA-HOA-SEY-50","qty":903123456,…}]  ← qty = 9 chữ số của SĐT
CASE C (binh thuong): [{"sku":"TRA-HOA-SEY-50","qty":1,…}]
```

**Probe 2 — R2-6 (tin trùng text bị nuốt + SENT láo)**: App mới, 2 follow-up khác `follow_up_id`, cùng text constant:
```
lan 1: {"sent":true,"delivery":"DELIVERED"}
lan 2: {"sent":true,"delivery":"DELIVERED"}        ← report DELIVERED
fu1.status = SENT | fu2.status = SENT              ← DB khai đã gửi đủ
platform.sentCalls (tin thuc su di ra) = 1          ← thực tế khách chỉ nhận 1
```

Thư mục probe tạm đã dọn sạch; suite gốc không bị đụng tới (`prototype/data` chỉ còn `products.json`, `test-runs`).

---

## KẾT LUẬN REVIEWER 3

- **Tổng số finding: 18** (R1 = 6, R2 = 12) — 1 BLOCKER, 11 MAJOR, 6 MINOR. Vượt yêu cầu tối thiểu (≥3/reviewer, ≥6 tổng).
- **Finding nghiêm trọng nhất: R2-1 (BLOCKER)** — PII khách (SĐT/tên/địa chỉ) được truyền nguyên object `conv` vào context của Sales AI, phủ nhận chính tuyên bố cấu trúc "chỉ nhận FACTS" của R2 (A.2.2) và vi phạm mục "An toàn dữ liệu" của contract ("PII khách: chỉ truyền phần tối thiểu cần thiết cho từng bước"). 18/18 PASS không thấy được nó vì stub bỏ qua `conv` — đúng lúc gắn LLM thật thì PII sẽ ra ngoài hệ thống theo prompt. Sửa rẻ (truyền `{state, mode, subject_sku}`) nhưng là điều kiện TIÊN QUYẾT trước khi thay stub bằng model thật.
- Nhận xét chung: cả hai thiết kế đều mạnh ở cơ chế đơn lẻ (điểm mạnh thật, có test), nhưng **điểm yếu chung là các ràng buộc nền tảng/multi-tenant (window 24h, quota Zalo, token lifecycle, budget per conversation) mới dừng ở mức "ghi chú ảnh hưởng thiết kế" của AI1 mà chưa có cơ chế thực thi trong AI2/AI3** — cần một lớp SendPolicy per-channel duy nhất (window + quota + rate) đặt tại Action Gate, và đưa từng mục thành vùng test injection như 6 vùng hiện có.

*Hết — file này chỉ là báo cáo cross-review của R3; không sửa file nào khác trong lab.*
