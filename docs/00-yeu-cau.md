# 00 — YÊU CẦU CHUNG (đề bài của chủ shop — cả 3 reviewer phải đọc file này trước)

## Mục tiêu hệ thống
Hệ thống bán hàng tự động 24/7 cho Facebook + Zalo:
- Gom Messenger/comment + Zalo vào một Inbox thống nhất.
- AI hiểu toàn bộ lịch sử hội thoại từng khách.
- Tự trả lời tự nhiên theo dữ liệu shop, hiểu text + ảnh + voice.
- Tự nhận diện khách đang hỏi sản phẩm nào; tra sản phẩm/giá/size/màu/tồn kho THẬT từ DB — **cấm bịa**.
- Tư vấn + chốt sale; thu thập tên/SĐT/địa chỉ/SKU/size/màu/số lượng; validate trước khi tạo đơn.
- Tạo & quản lý đơn; tích hợp ĐVVC qua API CHÍNH THỨC khi khả dụng; theo dõi trạng thái đơn.
- Chăm sóc sau bán; comment automation theo chính sách nền tảng.
- HUMAN TAKEOVER: AI không chắc → dừng auto-send, giao nhân viên; nhân viên xử xong trả quyền lại AI.
- Dashboard: Inbox / Khách / Sản phẩm / Đơn hàng / Automation / Analytics / Settings.
- Audit toàn bộ AI reply/action.

## Kiến trúc đích (chỉ đạo tổng)
```
Facebook ─┐
          ├→ Channel Gateway → Unified Inbox → Customer Session
Zalo ─────┘                          ↓
              ┌──────────────────────┼──────────────────┐
          Product DB              CRM             Chat History
              └──────────────────────┼──────────────────┘
                                     ↓
                                 SALES AI  (UNDERSTAND → REASON → PROPOSE)
                          ┌──────────┴──────────┐
                     Reply Plan             Action Plan
                          ↓                        ↓
                    Reply Policy             Action Gate  (VALIDATE → AUTHORIZE → EXECUTE → VERIFY)
                          ↓                        ↓
                   Facebook/Zalo          Order / Stock / Shipping / CRM
                                                   ↓
                                              Automation → After-sales → Analytics + Audit
```
**Nguyên tắc vàng: LLM KHÔNG phải nguồn sự thật.** Giá, tồn kho, SKU, khuyến mại, phí ship, trạng thái
đơn, chính sách — lấy từ DB/API thật. AI chỉ PROPOSE. Action thật phải VALIDATE → AUTHORIZE → EXECUTE → VERIFY.

## An toàn dữ liệu (bắt buộc)
- Token Facebook/Zalo/API key KHÔNG BAO GIỜ đưa vào prompt/model context — chỉ gateway dùng lúc gửi.
- PII khách: chỉ truyền phần tối thiểu cần thiết cho từng bước.
- Mọi action quan trọng phải có chuỗi audit:
  `event_id → conversation_id → customer_id → proposed_action → validation → execution_result → receipt`.
- KHÔNG dùng nội dung AI tự khai làm evidence thực thi.

## State machine bán hàng (mốc để 3 bên phản biện, được phép chỉnh khi có lý do)
NEW_LEAD → DISCOVERY → PRODUCT_QA → BUY_INTENT → COLLECT_ORDER → VALIDATE → CONFIRM → ORDERED → SHIPPING → AFTER_SALES

## 18 case test bắt buộc (mô phỏng)
1. Khách hỏi giá.
2. Khách hỏi size/màu.
3. Khách gửi ảnh "còn cái này không?".
4. Khách gửi voice.
5. Khách đổi sản phẩm giữa hội thoại.
6. Khách mua nhiều SKU.
7. Khách cung cấp thiếu địa chỉ.
8. AI định báo sai giá (DB có giá khác → phải lấy giá DB).
9. Tồn kho vừa hết lúc chuẩn bị chốt (stock thay đổi giữa chat và chốt).
10. Webhook Facebook/Zalo gửi DUPLICATE.
11. Timeout sau khi gửi message, chưa biết gửi thành công.
12. Tạo order timeout → không được tạo lại mù quáng (idempotency).
13. Khách khiếu nại.
14. AI không đủ evidence → phải nhận/không đoán bừa.
15. Human takeover.
16. Nhân viên trả quyền lại cho AI.
17. Follow-up sau giao hàng.
18. Khách từ chối nhận marketing → automation phải dừng theo chính sách.

## Phân loại bắt buộc cho mọi đề xuất
`USE` (nên triển khai) / `ADAPT` (ý tốt, viết lại cho project) / `REJECT` (không phù hợp) / `CHƯA XÁC MINH` (thiếu evidence — ghi rõ cần xác minh gì).

## Phạm vi giai đoạn này
RESEARCH + DESIGN + TEST PROTOTYPE trong thư mục lab này. KHÔNG build production.

## HARD INVARIANTS (bổ sung bởi Supervisor theo lệnh chủ shop — contract gốc, mọi reviewer PHẢI tuân, không được thay mục tiêu)
- **INV-1 INBOUND IDEMPOTENCY**: mọi event vào (webhook FB/Zalo) phải idempotent — event trùng bị loại, mỗi event được xử lý đúng một lần.
- **INV-2 OUTBOUND UNKNOWN**: gửi tin ra mà kết quả chưa biết thành công (UNKNOWN) → **CẤM blind-retry**; phải tra receipt/bằng chứng (webhook ngược, API đọc trạng thái) trước khi hành động tiếp.
- **INV-3 ORDER IDEMPOTENCY**: tạo đơn phải theo idempotency key; trùng key **không bao giờ** sinh ra đơn thứ hai.
- **INV-4 REVALIDATE TRƯỚC COMMIT**: giá/tồn kho/khuyến mại phải đọc lại từ nguồn sự thật NGAY TRƯỚC khi commit đơn — không dùng giá trị đã cache trong hội thoại.
- **INV-5 HUMAN_OWNED**: hội thoại đang do người tiếp quản → AI **CẤM MỌI** auto-send/auto-action cho đến khi nhân viên trả quyền lại.
