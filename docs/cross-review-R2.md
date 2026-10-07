# CROSS-REVIEW — REVIEWER 2 (Sales AI / Workflow) soi R1 + R3

> Vòng 2, ngày 2026-10-05. Góc soi: **trải nghiệm bán hàng thật + tính đầy đủ của luồng khách hàng**.
> Đầu vào đã đọc: `docs/00-yeu-cau.md`, `docs/AI2-sales-ai-v2.md` (bản của R2 — căn cứ luồng), `docs/AI1-capability-matrix.md` (R1), `docs/AI3-failure-injection-v2.md` (R3), code `prototype/src/*`, test `prototype/test/18-cases.js`, `prototype/test/invariants-check.js`.
> Xác minh độc lập trước khi kết tội: **chạy lại cả 2 suite** (`node test/18-cases.js` → 18/18 PASS exit 0; `node test/invariants-check.js` → 6/6 PASS exit 0) — claim của R3 là THẬT. Các "probe" bên dưới là script `node -e` chạy trên DB tạm (temp dir), KHÔNG đụng file nào trong lab; lệnh + output nguyên văn ghi ở từng finding để tái lập.
> Ghi nhận trung thực: prototype vòng 1 là tài sản chung (R2 viết pipeline/session). Finding đếm cho R3 khi lỗi nằm ở **phạm vi audit/cơ chế mà R3 vòng 2 tuyên bố đã phủ** (6 vùng "PHÙ ĐỂ PROTOTYPE-MOCK", danh mục 7 bug "đã sửa hết") — R3 là chủ nhân của suite injection, công cụ duy nhất có nhiệm vụ bắt các lỗ hổng này.

**TỔNG: 13 finding — R1: 5 (2 MAJOR, 3 MINOR) · R3: 8 (1 BLOCKER, 6 MAJOR, 1 MINOR).**

---

## PHẦN I — FINDINGS CHO R1 (`docs/AI1-capability-matrix.md`)

### R1-1. HUMAN_AGENT (A12) — thiếu trọn điều kiện truy cập/phê duyệt, trong khi cả thiết kế INV-5 ngoài-24h dựa vào nó

- **NHẪM AI**: R1.
- **LỖI/RỦI RO**: Dòng A12 liệt kê điều kiện (7 ngày, chỉ người thật, cấm promo) nhưng **không có bất kỳ điều kiện duyệt app/advanced access nào**, trong khi chính matrix này (A21) chứng minh mọi permission phục vụ bên ngoài cần App Review + Advanced Access + Business Verification; A13 (Utility) thì có ghi permission `page_utility_messaging` + duyệt template. Luồng "nhân viên trả lời khách ngoài 24h" là **nhánh gánh INV-5 khi hết window** (A12 tự ghi "Map thẳng vào INV-5"). Nếu HUMAN_AGENT cần duyệt app (đúng như các permission khác) mà shop chưa được duyệt thì đúng lúc khách chốt quá 24h, **nhân viên không có kênh nào gửi tin** — gãy đúng moment tiền.
- **EVIDENCE**: `docs/AI1-capability-matrix.md` A12: "RESTRICTED — [A] Tag HUMAN_AGENT: 'allows a business representative to manually respond within a 7-day period'; policy: chỉ cho người thật trả lời, không promo" — cột "Ảnh hưởng thiết kế" chỉ ghi "Map thẳng vào INV-5". Đối chiếu nội bộ: cùng file, A13 có permission + luồng duyệt, A21 có "must be approved for Advanced Access via Meta's App Review". A12 là dòng duy nhất mang tải kiến trúc mà không nêu điều kiện truy cập nào ngoài policy.
- **MỨC**: MAJOR.
- **ĐỀ XUẤT KHẮC PHỤC**: Bổ sung vào A12 điều kiện truy cập cần xác minh (app của SaaS có được advanced access cho HUMAN_AGENT hay không, thủ công gì) — nhãn tạm giữ RESTRICTED kèm "CHƯA XÁC MINH điều kiện duyệt"; thiết kế kênh dự phòng cho nhân viên ngoài 24h khi chưa được duyệt (VD: Zalo side-channel, hoặc chốt rằng luồng >24h buộc qua Utility template).

### R1-2. Case 17 (chăm sóc sau bán) trên Zalo KHÔNG có kênh hợp lệ nào trong matrix — lỗ hổng chất đôi nền tảng

- **NHẪM AI**: R1.
- **LỖI/RỦI RO**: Contract yêu cầu "Chăm sóc sau bán" (case 17: follow-up +2 ngày sau DELIVERED, AI2 A.1.1 AFTER_SALES "Follow-up theo lịch"). Đối chiếu Zalo trong matrix: B5 CS quota **8 tin/48h kể từ tương tác cuối** — follow-up +2 ngày sau giao hàng hầu như luôn rơi SAU cửa sổ 48h (khách thường im sau khi nhận); B7 promotion (1 tin/ngày, 6/tháng) là tin **marketing**, và chính R1 ghi "KHÔNG auto-send promotion nếu không có chính sách riêng của shop"; B8 transaction chỉ "tin xác nhận đơn/vận chuyển" — tin hỏi feedback **không phải** xác nhận vận chuyển. Kết quả: **case 17 trên Zalo không còn kênh nào hợp pháp**, nhưng matrix không hề đánh dấu đây là gap; hệ quả là cùng một thiết kế follow-up sẽ chạy tốt trên FB (A13 Utility) nhưng **im lặng/bị API từ chối trên Zalo** — một nửa khách không được chăm sóc sau bán.
- **EVIDENCE**: `docs/AI1-capability-matrix.md` B5 ("8 tin CS / 48h per user kể từ tương tác cuối"), B7 ("1 tin/ngày, 6 tin/tháng… KHÔNG auto-send promotion nếu không có chính sách riêng"), B8 ("dùng cho tin xác nhận đơn/vận chuyển") đối chiếu `docs/00-yeu-cau.md` case 17 ("Follow-up sau giao hàng") và `docs/AI2-sales-ai-v2.md` A.1.1 (AFTER_SALES — "Follow-up theo lịch, chỉ khi chưa opt-out"; `prototype/src/pipeline.js` dòng 566: `scheduled_at = now + 2*24*3600*1000`). Không dòng nào ở mục B hay mục D (đối chiếu invariant) ánh xạ luồng after-sales Zalo → kênh.
- **MỨC**: MAJOR.
- **ĐỀ XUẤT KHẮC PHỤC**: Thêm dòng "kênh after-sales Zalo" vào matrix: đánh giá ZNS (template vận đơn/feedback, xem R1-4) hoặc quy tắc gửi care **trong 48h cuối của cửa sổ CS** (dời follow-up lên trước khi hết window) hoặc nhận định rõ "Zalo: care follow-up CHƯA CÓ KÊNH — cần quyết định sản phẩm"; Reply Policy phải chọn kênh theo điều kiện từng nền tảng thay vì schedule chung.

### R1-3. Sticker (A5/B4): mốc chuyển đổi ĐÃ qua (30/08/2026 < 05/10/2026) nhưng matrix không nói AI phải LÀM GÌ với tin chỉ-toàn-sticker

- **NHẪM AI**: R1.
- **LỖI/RỦI RO**: A5 tự ghi mốc chuyển đổi sticker FB là 30/08/2026 (hạn cuối), tức là **đã trôi qua tại thời điểm audit 05/10/2026** — payload hiện nay có khả năng CHỈ còn type `sticker` (không kèm `image`). Matrix kết luận "Handler phải nhận CẢ 2 type" (đúng nhưng chưa đủ) và **không định nghĩa behavior bán hàng cho sticker-only**: trả lời gì, có coi là tín hiệu mua không, có vào vision không. Hệ quả trải nghiệm: khách (rất hay) thả sticker/like thay cho "còn hàng không?" → gateway nhận event lạ → **im lặng hoàn toàn** — đúng kiểu dead-air mà toàn hệ thống cố tránh. Zalo B4 (sticker/gif SUPPORTED) cũng không có hành vi thiết kế kèm theo. Cả suite test (18 case + 21 injection) không có event sticker nào.
- **EVIDENCE**: `docs/AI1-capability-matrix.md` A5 ("mốc kết thúc chuyển đổi (vòng 1 ghi 30/08/2026) không đọc lại được nguyên văn… Webhook handler phải nhận CẢ 2 type từ nay") + B4 (`user_send_sticker`… "sticker chỉ cần id + url"); header matrix "ngày 2026-10-05". `prototype/src/pipeline.js` chỉ xử lý `kind: 'voice'|'image'` (dòng 47, 73), nhánh else coi mọi thứ là text — không có nhánh sticker; `test/18-cases.js` + `test/invariants-check.js` không có event sticker.
- **MỨC**: MINOR (nhưng dễ gặp trong thực tế VN).
- **ĐỀ XUẤT KHẮC PHỤC**: Matrix A5/B4 bổ sung "hành vi chuẩn": normalize sticker → event `sticker`; policy đề xuất (sticker đơn thuần → câu chào mời hỏi tiếp, KHÔNG vào vision); kiểm tra changelog Graph API để chốt sticker-only payload; thêm 1 case test sticker-only.

### R1-4. Matrix thiếu hẳn ZNS (Zalo Notification Service) — kênh chuẩn của TMĐT VN cho tin trạng thái đơn

- **NHẪM AI**: R1.
- **LỖI/RỦI RO**: Mục B quét đúng hết event nhận + 3 loại quota tin OA (CS/promotion/transaction) nhưng **không có một dòng nào về ZNS** — kênh template gửi theo SĐT/EID, không cần cửa sổ tương tác, là kênh de-facto mọi shop VN dùng cho "đơn đã tạo/đang ship/đã giao" và nhắc đánh giá. Thiếu nó, thiết kế có nguy cơ phụ thuộc hoàn toàn vào B8 (transaction quota — RESTRICTED, R1 tự ghi "cần xác nhận product_type khi có OA thật") — tức **cả hai đường Zalo cho tin đơn hàng đều chưa xác minh mà không ai biết đường thứ hai tồn tại**. Matrix tự đặt tiêu chuẩn "audit đầy đủ capability phục vụ contract" (contract yêu cầu "theo dõi trạng thái đơn") nên thiếu ZNS là lỗi đầy đủ, không phải sở thích.
- **EVIDENCE**: `docs/AI1-capability-matrix.md` mục B có đúng 16 dòng (B1–B16), không dòng nào nhắc ZNS/template notification theo SĐT; mục F.3 "Việc cần làm để đóng 5 ô CHƯA XÁC MINH" cũng không có ZNS. Contract `00-yeu-cau.md` dòng 10: "theo dõi trạng thái đơn".
- **MỨC**: MINOR.
- **ĐỀ XUẤT KHẮC PHỤC**: Thêm dòng B17 "ZNS — RESTRICTED/CHƯA XÁC MINH" (điều kiện: template duyệt, chi phí/tin, gửi theo phone) kèm việc xác minh khi có OA; Reply Policy map "tin trạng thái đơn Zalo" ưu tiên ZNS, fallback transaction quota.

### R1-5. Danh mục ĐVVC thiếu các hãng phổ biến (AhaMove, Ninja Van…) mà không có dòng REJECT/CHƯA XÁC MINH

- **NHẪM AI**: R1.
- **LỖI/RỦI RO**: Contract: "tích hợp ĐVVC qua API CHÍNH THỨC **khi khả dụng**". Matrix chỉ xét 4 hãng (GHN/GHTK/J&T/ViettelPost) rồi chốt "GHN là ĐVVC duy nhất đạt SUPPORTED". AhaMove (same-day, phần bổ sung tự nhiên cho GHN), Ninja Van VN, Best/SEND… đều không có dòng nào — kể cả dòng "CHƯA XÁC MINH". Với shop bán nến/trà quà tặng (đúng catalogue prototype), **same-day nội thành là nhu cầu thật**; việc matrix im lặng khiến adapter interface thiết kế theo GHN-only (C1: "Adapter interface thiết kế theo mẫu GHN") có nguy cơ không chừa chỗ cho group same-day (interface tạo đơn same-day khác semantic: giờ cắt, khoảng giao).
- **EVIDENCE**: `docs/AI1-capability-matrix.md` mục C: chỉ 4 dòng (C1–C4); C1 "Chọn GHN làm ĐVVC ĐẦU TIÊN… Adapter interface thiết kế theo mẫu GHN… rồi map các hãng sau"; mục F đếm "43 dòng capability" không có hãng nào ngoài 4 hãng trên.
- **MỨC**: MINOR.
- **ĐỀ XUẤT KHẮC PHỤC**: Thêm dòng C5/C6 cho AhaMove + Ninja Van (ít nhất "CHƯA XÁC MINH — cần check portal API"), và khi thiết kế adapter interface thêm nhóm phương thức `createShipment(same_day|standard)` vào checklist xác minh.

---

## PHẦN II — FINDINGS CHO R3 (`docs/AI3-failure-injection-v2.md` + `prototype/test/invariants-check.js`)

### R3-1. [BLOCKER] Idempotency đơn (INV-3) nuốt luôn MUA LẠI hợp lệ: khách đặt lại cùng giỏ trong cùng hội thoại → hệ thống IM LẶNG, không đơn mới

- **NHẪM AI**: R3.
- **LỖI/RỦI RO**: Cơ chế "thế hệ cội điểm" của R3 coi đơn **CONFIRMED** cùng giỏ là "retry thật → idempotent hit", và suite của R3 assert hành vi đó là ĐÚNG (area3a: "lần 2 cùng key → idempotent hit"). Từ góc bán hàng, **mua lại cùng giỏ trong cùng hội thoại là kịch bản lõi** (contract: "Đơn mới → vòng mới" sau AFTER_SALES; khách "lấy thêm 1 bộ giống lần trước"). Probe chạy thật cho thấy hệ quả kép: (1) khách nhắn mua lại → **0 tin trả lời** (createOrder bị chặn `bad_state` vì ORDERED không nằm trong `ORDER_ACTION_STATES`, pipeline rơi vào nhánh `error` không reply); (2) khách vẫn "xác nhận" → phaseB idempotent trả về **đơn cũ** — khách tưởng đã đặt đơn thứ 2, thực tế chỉ 1 vận đơn đi ra, **chờ món không bao giờ đến**. Lỗi im lặng, ảnh hưởng tiền + uy tín shop, và không nằm trong 7 bug "đã sửa hết" của R3 cũng như 21 kịch bản phá. State machine không có đường re-entry từ ORDERED/AFTER_SALES → BUY_INTENT do pipeline không fire (chỉ AFTER_SALES có transition trên bảng nhưng không bao giờ được gọi).
- **EVIDENCE**:
  - Code: `prototype/src/order-engine.js` dòng 63-64: `if (latest && (latest.status === 'DRAFT' || latest.status === 'CONFIRMED')) return { ok: true, order: latest, idempotent: true };` — gen chỉ tăng khi CANCELLED/FAILED (dòng 66). `prototype/src/action-gate.js` dòng 22: `ORDER_ACTION_STATES = ['BUY_INTENT','COLLECT_ORDER','VALIDATE','CONFIRM','PRODUCT_QA']` (không có ORDERED/AFTER_SALES). `prototype/src/pipeline.js` dòng 334: nhánh `return { intent:'BUY', suppressed:false, error:r.reason, replies: [] }` — **không reply**. `prototype/src/session.js` TRANSITIONS (dòng 15-26): không có state CANCELLED, không đường ORDERED→mua lại.
  - Probe R2 (chạy 2026-10-05, DB temp): mua + xác nhận → `state=ORDERED orders=CONFIRMED`; nhắn "lấy thêm 1 nến vanilla M đỏ nữa, giao địa chỉ cũ nhé" → `[2] so tin out moi: 2 — tin cuoi: "Dạ đơn ORD4_0902D0 của anh/chị đã được xác nhận, tổng 210000đ..."` (tin cuối vẫn là reply của đơn 1 — tin mua lại bị bỏ qua hoàn toàn); nhắn "xác nhận" → `[3] CONFIRMED=1, tong so orders=1` — **không bao giờ có đơn thứ 2**.
  - Suite R3: `test/invariants-check.js` area3 chỉ test retry-thật (a), đồng thời (b), hồi-sinh-đơn-chết (c), confirm-2-lần (d) — **không có kịch bản mua lại hợp lệ**; `AI3-failure-injection-v2.md` mục VÙNG 3 tuyên bố vùng này "PHÙ ĐỂ PROTOTYPE-MOCK".
- **MỨC**: **BLOCKER** (luồng bán hàng l core chết im lặng, sai lệch kỳ vọng khách về tiền/hàng).
- **ĐỀ XUẤT KHẮC PHỤC**: Tách "retry của cùng intent" khỏi "intent mua mới": idempotency key phải gắn với **intent/draft** (VD: `order:<conv>:<hash>#<gen>:<draft_turn_event>` hoặc cộng thêm thời điểm BUY_INTENT); phaseA khi hit đơn CONFIRMED phải phân nhánh "khách xác nhận LẠI draft đang mở" vs "draft mới" theo `draft.order_id` của conversation; mở transition AFTER_SALES/ORDERED → BUY_INTENT trong pipeline routeBuy và bảo đảm route lỗi (bad_state) **luôn có reply** cho khách; thêm case injection "mua lại cùng giỏ sau CONFIRMED → phải ra đơn mới, đúng 2 vận đơn".

### R3-2. Guard tiền (vùng 5) chặn nhầm CÂU TRẢ LỜI ĐÚNG: tổng nhiều món, phí ship 25000, ngưỡng freeship đều bị đè — AI không thể nói tiền một cách tự nhiên

- **NHẪM AI**: R3.
- **LỖI/RỦI RO**: Bản vá vùng 5 của R3 mở rộng **quét** (bare-number, dạng k) nhưng không mở rộng **tập giá trị hợp lệ**: `allowedMoney` chỉ gồm `proposal.allowedMoney` (chỉ có ở tin transactional có order snapshot) + `knownMoneyValues()` = **giá variant trong DB**. Hệ quả đo được: (1) AI tính tổng cho khách ("2 hộp 145000 x 2 = 290000đ") → **OVERRIDDEN**, khách nhận câu liệt kê giá thay vì câu trả lời; (2) AI báo **phí ship 25000đ** — đúng con số chính order engine tự thu (`shipping_fee = 25000`) → cũng OVERRIDDEN vì không variant nào giá 25000 trong catalogue; (3) câu freeship ngưỡng 500000 → OVERRIDDEN. Ngoài ra nhánh OVERRIDDEN **đè TOÀN BỘ tin nhắn** (mất cả nội dung đúng đi kèm). Đây chính là "trải nghiệm bán hàng tự nhiên" bị rào chặn phá: câu hỏi tiền phổ biến nhất của khách VN ("phí ship bao nhiêu", "mua 2 cái hết bao nhiêu") là thứ guard hiện tại **không cho AI trả lời**. R3 tự khai giới hạn ở mục 9.6 (LLM né guard) nhưng **false-positive trên câu ĐÚNG thì chưa được khai ở đâu** và area5(d) chỉ test đúng 1 giá đơn lẻ.
- **EVIDENCE**:
  - Code: `prototype/src/action-gate.js` dòng 70-71 (`allowed = proposal.allowedMoney ∪ productDB.knownMoneyValues()`), dòng 105-109 (`decision='OVERRIDDEN'; text = this.renderValidated(...)` — đè toàn bộ); `prototype/src/product-db.js` dòng 91-99 (knownMoneyValues chỉ giá variant); `prototype/src/order-engine.js` dòng 87 (`const shipping_fee = 25000`); `data/products.json` — không variant nào 25000/500000; `test/invariants-check.js` area5(d) chỉ test "giá 185000" đơn lẻ.
  - Probe R2 (2026-10-05): bơm thẳng gate intent PRICE: `[B1] tong nhieu SP (290000 DUNG toan hoc): OVERRIDDEN -> khách nhận: "Dạ giá chính thức của Hộp trà hoa sấy theo shop ạ: - size hộp 50g: 145000đ..."`; `[B2] phí ship 25000 (trùng shipping_fee cua order engine): OVERRIDDEN`; `[B3] ngưỡng freeship 500000: OVERRIDDEN`.
- **MỨC**: MAJOR.
- **ĐỀ XUẤT KHẮC PHỤC**: Nạp `allowedMoney` đủ ngữ cảnh bán hàng: giá variant + **shipping fee từ config shop** + **tổng của mọi tổ hợp giỏ hiện tại** (tính từ FACTS) + snapshot đơn; hoặc quy ước intent riêng `SHIPPING_FEE` có evidence từ DB/ĐVVC thì miễn quét; OVERRIDDEN chỉ thay **câu chứa số lỗi**, giữ phần văn bản còn lại (diff theo câu) thay vì đè cả tin; thêm case guard cho tổng-nhiều-món + phí ship.

### R3-3. Trigger khiếu nại là regex "dính chuỗi" → dương tính giả BẮT TAKEOVER oan: câu hỏi bảng size bị biến thành khiếu nại, AI bị câm + gửi lời xin lỗi vô lý

- **NHẪM AI**: R3.
- **LỖI/RỦI RO**: Vùng 6 của R3 tuyên bố khoá INV-5 đầy đủ nhưng chỉ test **đúng trigger** (area6d dùng text khiếu nại thật). Trigger khiếu nại (`RE.complaint`) match chuỗi con như `chua thay` / `chua nhan duoc` / `xau` trên **mọi** tin của khách ở **mọi** state, trước cả fillSlots. Câu hỏi vô hại "sao mình **chưa thấy** bảng size ở đâu nhỉ?" → hệ thống hiểu là khiếu nại: mở claim + takeover + AI bị câm + gửi template "shop thành thật xin lỗi" — khách bối rối, conversation rơi vào HUMAN không cần thiết (đúng lúc đang tư vấn sản phẩm). INV-5 vẫn "đúng", nhưng **sai việc kích hoạt** = phá trải nghiệm tự nhiên theo đúng nghĩa; và vì mọi tin sau đó chỉ vào HOLD_FOR_AGENT, khách hỏi tiếp size cũng không ai trả lời đến khi có người dò worklist.
- **EVIDENCE**:
  - Code: `prototype/src/pipeline.js` dòng 13 (`complaint: /…|chua nhan duoc|chưa nhận được|chưa thấy|chua thay|…|xau|tệ/`), dòng 98 (`if (RE.complaint.test(normText)) return this.handleComplaint(...)` — trước kiểm tra mode và trước mọi route).
  - Probe R2 (2026-10-05): hỏi "nến vanilla còn hàng không shop?" rồi "sao mình chưa thấy bảng size ở đâu nhỉ?" → `[C1] mode=HUMAN, claim={"reason":"complaint","origin_state":"PRODUCT_QA"}`; tin system: `"Dạ shop thành thật xin lỗi anh/chị về trải nghiệm này ạ..."`; hỏi tiếp "size M còn không ạ?" → `[C2] mode van=HUMAN, AI có trả lời gì mới không: KHÔNG (im lặng, chỉ vào worklist)`.
  - Suite: area6(d) chỉ bắn text khiếu nại thật ("đơn 2 tuần rồi chưa thấy đâu, lừa đảo à?"); không test nào đo precision của trigger.
- **MỨC**: MAJOR.
- **ĐỀ XUẤT KHẮC PHỤC**: Trigger khiếu nại phải có ngữ cảnh: chỉ auto-takeover khi `(match khiếu nại cứng: lừa đảo, khiếu nại, bồi thường…) HOẶC (chưa-nhận-được/chưa-thấy + đang có đơn ORDERED/SHIPPING)`; các match yếu (xấu/tệ/chưa thấy không có đơn) → intent NEEDS_HUMAN_SOFT (worklist, AI vẫn trả lời bình thường); thêm test dương tính giả vào area6 (ít nhất 3 câu trong nghiệp vụ thật chứa "chưa thấy"/"xấu" không phải khiếu nại).

### R3-4. Đường chết DLQ/takeover-tự-động (vùng 2) không có template ACK nào cho khách → dead-air vô hạn cho khách đang chờ

- **NHẪM AI**: R3.
- **LỖI/RỦI RO**: Khi send chết hẳn (NO_RECEIPT_AFTER_3_CHECKS), R3 thiết kế DLQ + mode=HUMAN + worklist — đúng cho INV-2, nhưng **khách thì chưa nhận được TIN NÀO** (tin gốc UNKNOWN) và mọi tin sau đó của khách chỉ rơi vào HOLD_FOR_AGENT. So với luồng khiếu nại (có COMPLAINT_ACK) và opt-out (có OPT_OUT_ACK), đây là **duy nhất** tình huống khách đang chờ mà hệ thống không gửi một tin acknowledged nào — ban đêm/ngày lễ có thể im lặng hàng giờ. Với một hệ bán hàng 24/7, khách "hỏi giá không được đáp" = mất lead; đồng thời không có gì bảo đảm operator mở worklist nhanh. INV-5 không cấm việc này: whitelist `system` đã tồn tại (template khiếu nại/opt-out) chỉ cần thêm 1 mẫu nữa.
- **EVIDENCE**: `prototype/src/action-gate.js` dòng 294-322 (checkSendReceipt attempt≥3: chỉ insert DLQ + mode HUMAN + needsHuman — **không có sendReply nào**); `prototype/src/pipeline.js` dòng 110-121 (mode HUMAN → chỉ insert proposal HOLD_FOR_AGENT + worklist, `replies: []`); whitelist cho phép trong HUMAN: `action-gate.js` dòng 158-168 (chỉ human_agent + transactional/chính sách); `AI3-failure-injection-v2.md` VÙNG 2(b) + area2(b) — assert dừng ở DLQ/worklist, không có assert về tin cho khách.
- **MỨC**: MAJOR.
- **ĐỀ XUẤT KHẮC PHỤC**: Thêm template `system` "Dạ em ghi nhận tin của mình, hệ thống đang có trục trặc gửi phản hồi, nhân viên sẽ vào hỗ trợ mình ngay ạ" vào whitelist chính sách, gửi đúng 1 lần tại thời điểm DLQ; thêm assert trong area2(b) "khách nhận ≥1 tin ack sau DLQ". Nhớ tuân thủ quy tắc của chính AI2 A.1.2: mẫu system mới phải thêm tường minh + audit riêng.

### R3-5. Reservation không có TTL: khách giữ chỗ rồi im lặng → KHOÁ tồn kho vĩnh viễn, đẩy khách khác vào "hết hàng"

- **NHẪM AI**: R3.
- **LỖI/RỦI RO**: Pha A giữ chỗ (`reserve`) chỉ được hoàn khi: khách đổi SP / hết hàng lúc chốt / đổi giá / commit. **Không có bất kỳ expiry nào** cho draft/reserve (grep ttl/expire/expiry trên src = 0 kết quả; scheduler `runDueJobs` chỉ xử lý `check_send_receipt`, `reconcile_shipment`, follow-ups). Với stock nhỏ (catalogue prototype có variant còn đúng 2-3 cái), 1-2 khách hỏng chốt (chat dở, mất mạng, spam giỏ rồi bỏ) là **số còn lại bị báo "hết hàng" vô thời hạn** — vùng 4(c) của chính R3 chứng minh 2 khách giành món cuối thì B bị chặn; khi A bỏ đi giữa chừng thì không ai hoàn chỗ cho B. Đây là rủi ro doanh thu thật, và 6 vùng injection không có scenario "bỏDraft/từ bỏ" (tất cả test đều đi tới confirm hoặc cancel tường minh).
- **EVIDENCE**: `prototype/src/order-engine.js` `reserve` chỉ được gọi ở pha A (dòng 81); `release` chỉ ở `cancelDraft` (dòng 121) — được gọi từ `pipeline.js` 373/389/456 (đổi SP, hết hàng, đổi giá); `prototype/src/app.js` dòng 83-107 (`runDueJobs` chỉ 2 loại job — không có kind draft-expiry); grep `ttl|expire|hết hạn` trên `prototype/src` → không kết quả; `AI3-failure-injection-v2.md` mục 7 (bảng 6 vùng) không có vùng "reservation leak/abandonment".
- **MỨC**: MAJOR.
- **ĐỀ XUẤT KHẮC PHỤC**: Thêm TTL reserve (VD 30-60 phút từ `created_at` của DRAFT): job `expire_draft` chạy định kỳ → cancelDraft(reason='timeout') + hoàn reserve + (tùy chọn) gửi tin transactional "giữ chỗ hết hạn, cần thì nhắn lại"; thêm vùng injection 7: "khách giữ chỗ rồi im lặng X giờ → reserve phải được trả, khách khác mua được".

### R3-6. Idempotency của SEND là content-derived (`sha(text+event_id)`) + SAFE_REPLIES xoay vòng toàn cục → crash SAU khi gửi rồi retry sẽ gửi TRÙNG cho khách; LLM thật (chữ nào ra chữ nấy) phá hẳn lớp này

- **NHẪM AI**: R3.
- **LỖI/RỦI RO**: Vùng 1 tuyên bố INV-1 "mỗi event xử lý đúng một lần — một lần HOẶC thất bại có dấu", nhưng injection duy nhất (area1c) ném exception **ở đầu** `handleEvent` (trước mọi side-effect). Không có kịch bản lỗi SAU `executeSend`: key chống trùng của send là `send:<conv>:<sha(text+event_id)>` (nội dung phái sinh) — nếu process chết sau khi platform nhận tin nhưng trước khi ghi DONE, retry sẽ chạy lại pipeline; với text bất định thì key khác → **gửi tin thứ 2**. Trong prototype chính chỗ này đã có độ bất định cài chủ ý: `SAFE_REPLIES` xoay vòng bằng `safeIdx` **toàn cục** (mỗi lần gọi an toàn tăng 1) → retry cùng event sau crash gửi cho khách 2 câu an toàn KHÁC nhau (double-send thật), đồng thời `ai_low_confidence`/worklist bị đếm 2 lần. Khi thay stub bằng LLM thật (kế hoạch ADAPT của cả 3 bên), text hầu như luôn khác mỗi lần chạy → **lớp dedupe outbound được xây trên nội dung sẽ vô hiệu hoàn toàn**; đúng tinh thần "write-ahead intent" thì key phải là intent-scoped (event_id), không phải text-scoped. Đây là hở nằm chính giữa vùng R3 phụ trách (INV-1/INV-2) mà mục 9 không hề khai.
- **EVIDENCE**: `prototype/src/action-gate.js` dòng 187 (`const idem = send:${conversation.conversation_id}:${sha(text + (event ? event.event_id : ''), 20)}`), dòng 36-40 (`safeReply()` — `this.safeIdx += 1` toàn cục), dòng 99-104 (nhánh NEEDS_HUMAN gọi safeReply → text xoay vòng); `test/invariants-check.js` dòng 113-117 (`if (calls === 1) throw` — injection TRƯỚC side-effect duy nhất); không có area nào inject throw giữa EXECUTE và mark-PROCESSED; `AI3-failure-injection-v2.md` mục 9 (danh mục chưa-chứng-minh) không nhắc class lỗi này.
- **MỨC**: MAJOR (latent — chưa có case FAIL, nhưng là hở thiết kế của chính cơ chế R3 tuyên bố đã bít).
- **ĐỀ XUẤT KHẮC PHỤC**: Đổi key sang intent-scoped: `send:<conv>:<event_id>[:<msg_kind>:<slot>]` (text chỉ là payload); SAFE_REPLIES chọn theo **hash(event_id)** thay vì counter toàn cục để retry-deterministic; thêm injection "throw sau platform.sendMessage thành công, trước khi ghi DONE" assert platform nhận đúng 1 call.

### R3-7. Toàn bộ vòng đời SAU-khi-chốt của KHÁCH (đổi ý/hủy đơn/hoàn) nằm ngoài 6 vùng injection — hệ thống không có đường hủy đơn nào cả

- **NHẪM AI**: R3.
- **LỖI/RỦI RO**: Contract yêu cầu "Tạo & **quản lý** đơn" (đổi ý sau chốt là nghiệp vụ bán hàng VN phổ biến nhất). Nhưng: state machine không có trạng thái/transition hủy (ORDERED chỉ ra SHIPPING/AFTER_SALES/CONFIRM); `cancelDraft` từ chối mọi order không phải DRAFT (`NOT_DRAFT`); pipeline không có route nào map "hủy đơn giúp mình / mình đổi ý" → xác định bằng probe logic + code: tin đó sẽ bị nuốt (không route phù hợp → CHITCHAT trả lời "không có gì"). Nghĩa là khách đổi ý → **đơn vẫn đi giao, AI trả lời theo trạng thái cũ như không nghe thấy**; còn hủy phía ĐVVC (GHN cancel API — R1 C1 có liệt kê) lại là một outbound action rời hệ thống khác — đúng loại failure UNKNOWN mà vùng 2 của R3 chuyên trị, nhưng **chưa được mô hình hóa**. Suite 18 case + 21 injection không có 1 scenario hủy/hoàn nào.
- **EVIDENCE**: `prototype/src/session.js` dòng 15-26 (TRANSITIONS — không CANCELLED; ORDERED: ['SHIPPING','AFTER_SALES','CONFIRM']); `prototype/src/order-engine.js` dòng 118-119 (`if (!order || order.status !== 'DRAFT') return { ok:false, reason:'NOT_DRAFT' }`); `prototype/src/pipeline.js` dòng 142-150 (switch intent — không có CANCEL_ORDER); `test/18-cases.js` danh sách text (grep msg(app) — không có tin hủy/hoàn nào); `test/invariants-check.js` AREAS (6 vùng — không vùng lifecycle đơn sau commit); `docs/00-yeu-cau.md` dòng 10 ("Tạo & quản lý đơn").
- **MỨC**: MAJOR (thiếu luồng bắt buộc theo contract; thuộc phạm vi "đầy đủ luồng" mà cả suite injection của R3 không chạm).
- **ĐỀ XUẤT KHẮC PHỤC**: Bổ sung vùng injection 7 "order lifecycle sau commit": khách hủy khi DRAFT (đã có), khi CONFIRMED/chưa tạo vận đơn (cancel order nội bộ + hoàn kho), khi đã có vận đơn (cancel qua ĐVVC = outbound action qua gate + receipt-or-DLQ như vùng 2), sau SHIPPING (từ chối hủy + báo chính sách); thêm transition `ORDERED → CANCELLED` (state phụ hoặc flag) + reply template; đưa 1 case vào 18-case suite khi chốt v3.

### R3-8. Suite tự chấp nhận gửi TRÙNG 2 bill cho khách ("bill lặp 2 tin — chấp nhận") — biến lỗi trải nghiệm thành assertion chính thức

- **NHẪM AI**: R3.
- **LỖI/RỦI RO**: area3(b): 2 event cùng giỏ trong 1 tick → 1 đơn (đúng) nhưng **khách nhận 2 tin bill giống hệt nhau**, và R3 ghi thẳng vào assert là "chấp nhận". Trải nghiệm thật: khách thấy 2 hóa đơn → hỏi lại "làm sao đơn bị lập 2 lần?" → sinh khiếu nại giả (và regex khiếu nại — R3-3 — sẵn sàng bắt thêm). Dedupe ở đây có thể làm tầng pipeline: event thứ 2 cùng event-origin trong 1 tick vẫn nên reply (theo INV-1 mỗi event một lần) nhưng có thể gom/nhận diện draft đã tồn tại để gửi 1 bill + 1 tin "đã nhận thêm tin của mình".
- **EVIDENCE**: `test/invariants-check.js` dòng 235: `assert.strictEqual(outMsgs(app2, 'fb-i3b').filter(m => m.text_content.includes('Tổng cộng')).length, 2, 'bill lặp 2 tin (chấp nhận — đơn vẫn 1)')`; `AI3-failure-injection-v2.md` VÙNG 3(b) "(bill lặp 2 tin — chấp nhận, đơn vẫn 1)".
- **MỨC**: MINOR.
- **ĐỀ XUẤT KHẮC PHỤC**: Ở tầng pipeline/present: nếu event 2 của cùng turn tạo idempotent-hit thì gửi tin rút gọn ("Dạ em đã nhận tin trước đó của mình rồi ạ") thay vì renderBill lại; đổi assert thành 1 bill + 1 ack.

---

## PHẦN III — TỔNG HỢP

| # | AI | Tóm tắt | Mức |
|---|---|---|---|
| R1-1 | R1 | A12 HUMAN_AGENT thiếu điều kiện truy cập/duyệt app (lệch chuẩn nội bộ A13/A21) — nhánh INV-5 ngoài-24h rủi ro không kênh | MAJOR |
| R1-2 | R1 | Care follow-up sau bán (case 17) trên Zalo không còn kênh hợp lệ nào trong matrix (B5/B7/B8) | MAJOR |
| R1-3 | R1 | Sticker-only: mốc 30/08/2026 đã qua, không có behavior thiết kế, không test | MINOR |
| R1-4 | R1 | Thiếu ZNS trong matrix — không có đường dự phòng cho tin trạng thái đơn Zalo | MINOR |
| R1-5 | R1 | ĐVVC thiếu AhaMove/Ninja Van (không có dòng CHƯA XÁC MINH) | MINOR |
| R3-1 | R3 | **Mua lại cùng giỏ = im lặng + không bao giờ có đơn mới** (idempotency nuốt intent mua hợp lệ; probe chứng minh) | **BLOCKER** |
| R3-2 | R3 | Guard tiền chặn nhầm tổng nhiều món / phí ship 25000 / freeship — và đè toàn bộ tin (probe B1–B3) | MAJOR |
| R3-3 | R3 | Regex khiếu nại dương tính giả ("chưa thấy bảng size") → takeover oan + lời xin lỗi + AI câm (probe C) | MAJOR |
| R3-4 | R3 | DLQ/takeover tự động không có template ack → khách dead-air vô hạn | MAJOR |
| R3-5 | R3 | Reservation không TTL → khách bỏ giữa chừng khoá tồn kho vĩnh viễn | MAJOR |
| R3-6 | R3 | Send idempotency key dựa trên nội dung text + SAFE_REPLIES xoay toàn cục → crash-sau-gửi gây trùng tin; LLM thật vô hiệu hoá | MAJOR |
| R3-7 | R3 | Không có luồng hủy/đổi ý sau chốt (contract: "quản lý đơn") — ngoài 6 vùng injection | MAJOR |
| R3-8 | R3 | Suite assert "bill lặp 2 tin — chấp nhận": lỗi trải nghiệm được hợp thức hoá | MINOR |

**Finding nghiêm trọng nhất: R3-1 (BLOCKER)** — cơ chế chống trùng đơn của INV-3, được injection suite chứng nhận "PHÙ ĐỂ", đồng thời (a) khiến khách mua lại cùng giỏ bị hệ thống **bỏ qua hoàn toàn** (0 tin trả lời) và (b) nếu khách vẫn nhấn "xác nhận" thì bị trả về **đơn cũ đã CONFIRMED** như thể đơn mới đã đặt — khách chờ một lô hàng không bao giờ tồn tại. Đã xác minh bằng probe chạy thật trên prototype ngày 2026-10-05 (evidence nguyên văn ở R3-1).

**Lời cảm ơn kỹ thuật**: Suite 18/18 + 6/6 của hai bên đều chạy lại PASS thật; các finding ở trên là điểm mù về **luồng bán hàng thật** (mua lại, phí ship, đổi ý, dương tính giả trigger, kênh Zalo after-sales), không phải lỗi chạy. Đề xuất cả 3 bên chốt v3 theo đúng 4 nhãn USE/ADAPT/REJECT/CHƯA XÁC MINH cho từng mục khắc phục ở trên.

---
*cross-review-R2 — Reviewer 2 (Sales AI/Workflow), hội đồng vòng 2. Không sửa file nào ngoài file này.*
