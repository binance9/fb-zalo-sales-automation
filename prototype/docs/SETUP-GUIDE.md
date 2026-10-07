# HƯỚNG DẪN CÀI ĐẶT CHO CHỦ SHOP (không cần biết code)

> Hệ thống: Sales AI Console — bot trả lời khách trên Facebook Messenger / Zalo, tự lập đơn, tự tạo vận đơn GHN, lời tư vấn do AI (DeepSeek) viết trên nền dữ liệu giá/tồn thật của shop.
> Thời gian làm theo: ~30–45 phút. Bạn chỉ cần: máy tính Windows có cài Node.js, một tab trình duyệt, và các tài khoản Facebook Page / Zalo OA / GHN của shop.

---

## BƯỚC 0 — Khởi động hệ thống (1 lần)

1. Mở thư mục `prototype`, chạy file **`START-BOT.bat`** (hoặc mở Git Bash gõ `node server.js`).
2. Màn hình hiện dòng `UI bán hàng: http://localhost:8080` và trình duyệt tự mở.
3. Lần đầu vào sẽ được yêu cầu **tạo tài khoản chủ shop** (email + mật khẩu ≥ 8 ký tự). Đây là tài khoản quản trị cục bộ — không liên quan mật khẩu Facebook/Zalo của bạn.

> Mọi cấu hình bên dưới đều làm TRONG TRANG WEB, không cần sửa file nào. Env file (`.env.live`, xem `.env.example`) chỉ dùng khi muốn khai nhanh bằng văn bản — UI luôn thắng env.

---

## BƯỚC 1 — Thông tin shop (bắt buộc)

Vào **Cài đặt → khối wizard "Thiết lập shop"** (hoặc Cài đặt → Hồ sơ shop cho AI):

- **Tên shop, Hotline, Địa chỉ** — bot dùng các thông tin này để giới thiệu khi khách hỏi.
- Lưu lại. Wizard hiển thị tiến độ `x/7` góc trên.

---

## BƯỚC 2 — Kết nối Facebook Messenger

**Chuẩn bị trên Facebook (làm trong developers.facebook.com):**

1. Tạo một **App** loại *Business* trong Meta for Developers (miễn phí).
2. Trong App, thêm sản phẩm **Messenger**. Ghi lại **App ID**, **App Secret** (Settings → Basic).
3. Cần một **Facebook Page** của shop + lấy **Page Access Token** (qua Graph API Explorer hoặc tool "Access Token Debugger": chọn permission `pages_show_list`, `pages_messaging`, `pages_manage_metadata`, rồi Generate Page Token). Token dạng `EAA…` rất dài.
4. Đặt **Verify Token**: một chuỗi ký tự bất kỳ do bạn tự đặt (ví dụ `suri-verify-2026`) — dùng khi khai webhook.

**Kiến thức quan trọng (Meta quy định — bot đã xử lý sẵn, bạn chỉ cần hiểu):**

- Khách **nhắn tin / bấm Get Started / comment bài viết** → cửa sổ 24h mở, bot được trả lời thoải mái. Quá 24h không có tin khách → bot tự DỪNG (không gửi lậu) và chờ khách nhắn lại.
- Nhân viên bấm **"TIẾP QUẢN"** trong Inbox → bot ngắt AUTO, nhắn được tới 7 ngày theo chuẩn HUMAN_AGENT của Meta.
- Bot trả lời **comment** bằng tin nhắn riêng (Private Reply) — Meta chỉ cho nhắn riêng **1 tin/1 comment** nên nội dung phải chốt cẩn thận (bot đã làm đúng cơ chế này).
- Token hết hạn → Cài đặt hiện `PERMISSION_REQUIRED` / cảnh báo "Facebook hết phiên đăng nhập" → thay token mới ở wizard bước 2.

**Điền vào hệ thống:** wizard bước 2 — **Page ID** + **Page Access Token**. (App ID/Secret/Verify Token điền vào `.env.live` theo `.env.example` khi chạy live webhook.)

---

## BƯỚC 3 — Kết nối Zalo OA

**Chuẩn bị trên Zalo:**

1. Shop cần một **Official Account (OA)** đã tạo trên zalo.me (nên làm thủ tục **xác minh** để tăng độ tin cậy).
2. Lấy **OA ID** và **Access Token** ( Refresh Token ) từ trang quản trị OA / qua app Zalo OS của bạn (mục "Phát triển" → Ứng dụng).

**Kiến thức quan trọng (Zalo quy định):**

- Bot chỉ nhắn được cho khách đã **follow OA hoặc đã nhắn tin** cho OA.
- Sau mỗi lần khách tương tác, bot được gửi tối đa **8 tin CS / 48 giờ** cho khách đó. Hết quota bot TỰ DỪNG và chuyển nhân viên (cảnh báo "Quota Zalo sắp cạn" trong hệ thống) — đây là luật của Zalo, không phải lỗi.
- Token OA có hạn → hệ thống cảnh báo "Zalo OA hết phiên đăng nhập" khi token chết; thay token ở wizard bước 3 (nên có Refresh Token để hệ thống tự gia hạn).

**Điền vào hệ thống:** wizard bước 3 — **OA ID** + **Access Token** (+ Refresh Token nếu có).

> Lưu ý kế hoạch: chỉ cần MỘT trong hai kênh (Facebook HOẶC Zalo) là bot chạy được. Cả hai càng tốt.

---

## BƯỚC 4 — Sản phẩm

- Vào **Sản phẩm** → thêm từng sản phẩm (tên, giá, tồn kho, size/màu) hoặc **Import CSV**.
- Kiểm tra wizard bước 4 hiển thị số sản phẩm đang bật bán ≥ 1.
- Giá/tồn ở đây là NGUỒN SỰ THẬT duy nhất: AI chỉ được nói giá/tồn khớp bảng này; nói sai sẽ bị hệ thống đè lại bằng số đúng (tự động).

---

## BƯỚC 5 — GHN (vận chuyển) — cần khi bật tự động chốt đơn

**Chuẩn bị trên GHN:**

1. Đăng ký tài khoản shop trên ghn.vn (có thể dùng **sandbox** `dev-online-gateway.ghn.vn` để chạy thử).
2. Lấy **API Token** (GHN Dashboard → Quản trị → Token API) và **Shop ID** (số ID cửa hàng GHN cấp).

**Kiến thức quan trọng:**

- Đơn chốt → hệ thống tự gọi GHN tạo **vận đơn** + trả khách mã tracking. GHN chết/treo → hệ thống không bỏ cuộc: ghi nhận "chờ đối soát" và cử nhân viên xử lý (không mất đơn, không gửi 2 lần).
- Huỷ đơn có vận đơn luôn đi qua GHN; GHN từ chối → đơn đứng ở **"Chờ hủy (ĐVVC)"** để người xử — không có trạng thái lửng.

**Điền vào hệ thống:** wizard bước 5 — **GHN Shop ID** + **GHN Token**. Nếu chưa muốn auto tạo vận đơn: tắt **Auto-order** trong Cài đặt (bước 5 không còn bắt buộc).

---

## BƯỚC 6 — AI Engine (DeepSeek) — bộ não viết lời tư vấn

**Cách 1 (khuyến nghị — nút 1 click):**

1. Đảm bảo máy có file provider config của chủ (mặc định đọc tại
   `C:\GaAi-Lab-Test\GaAiLab\backup\model-rename-20261004\provider_config.json`;
   đường dẫn khác thì đặt biến `DEEPSEEK_PROVIDER_CONFIG` trong `.env.live`).
2. Vào **Cài đặt → khối "AI Engine"** → bấm **"Nối key DeepSeek (live)"**.
3. Hệ thống đọc key từ file, lưu vào settings shop (key được **che** — chỉ hiện `***` + 4 số cuối, không bao giờ hiện nguyên văn trên màn hình) và **gọi thử thật 1 request**. Kết quả mong đợi: nhãn xanh **ONLINE**.

**Cách 2 (thủ công):** wizard bước 6 — chọn Provider `DeepSeek`, dán API key `sk-…`, model để trống (= `deepseek-chat`), Lưu, rồi bấm **"Test gọi AI"**.

**Hiểu về khối "AI Engine":**

- Trạng thái: **ONLINE** (xanh — đã gọi thật thành công) / **ERROR** (đỏ — key sai/hết tiền/mạng chặn, kèm mã lỗi) / **DISABLED** (xám — chưa cấu hình).
- Công tắc **"AI viết lời tư vấn"**: bật = DeepSeek viết câu tư vấn tự nhiên (mọi giá/tồn vẫn lấy từ DB, Gate vẫn chặn số sai); tắt = bot trả lời bằng template FAQ cứng. Mặc định BẬT khi provider đã nối.
- **AI KHÔNG TỰ LẬP ĐƠN**: phát hiện ý mua, hỏi đủ tên/SĐT/địa chỉ, giữ chỗ và chốt đơn là phần máy chạy cứng — AI chỉ viết câu chữ tư vấn.
- AI lỗi giữa chừng (timeout/mạng) → bot tự dùng FAQ dự phòng, khách không bao giờ nhận tin rỗng, hệ thống không sập.
- Hồ sơ giọng nói (Cài đặt → "Hồ sơ shop cho AI" + "Prompt theo form cấu hình"): giọng nói, cách xưng hô, chính sách đổi trả/giao hàng, FAQ… — DeepSeek sẽ nói đúng "chất" shop của bạn.

---

## BƯỚC 7 — Test trước khi bật bot thật

Wizard bước 7 có 2 nút:

1. **Chạy test hội thoại** — bắn 1 tin khách mẫu qua đúng đường webhook, kiểm tra bot trả lời được.
2. **Chạy test đơn** — chạy trọn 1 đơn: mua → đủ thông tin → giữ chỗ → xác nhận → đơn CONFIRMED.

Khi cả checklist xanh (bước 1, 4, 6 bắt buộc + (2 hoặc 3) + 5 nếu bật auto-order) → nút **"BẬT BOT TỰ ĐỘNG"** sáng lên. Bấm để go-live.

---

## Sau khi chạy: theo dõi hằng ngày

- **Tổng quan**: khách hôm nay, đơn hôm nay, doanh thu, số hội thoại cần người.
- **Hội thoại**: inbox 3 cột; bấm "TIẾP QUẢN"/"TRẢ LẠI CHO AI"; tab phụ **"Agent runs"** xem lại từng bước bot xử lý mỗi tin (run → steps).
- **Đơn hàng**: lọc theo trạng thái; hành động Xác nhận / Huỷ / Gửi-lại-vận-đơn đều đi qua đúng engine (không sửa tay dữ liệu).
- **Chuông 🔔**: cảnh báo cần người / đơn lỗi / token hết hạn / quota cạn / job chết.
- **Cài đặt → Automation**: bật/tắt tin chăm sóc sau giao, xin đánh giá, nhắc mua lại — lịch do bạn đặt, việc GỬI vẫn do lõi chính sách (cửa sổ 24h/quota/opt-out) quyết.

## Sự cố thường gặp

| Hiện tượng | Nghĩa là | Xử lý |
|---|---|---|
| Facebook: `PERMISSION_REQUIRED` | Page token chết/thiếu quyền | Tạo lại Page token, lưu wizard bước 2 |
| Zalo: `TOKEN_EXPIRED` | OA token hết hạn | Lấy token mới / refresh, lưu bước 3 |
| Zalo: "Quota sắp cạn" | 8 tin CS/48h gần hết | Chờ khách nhắn lại hoặc nhân viên xử |
| AI Engine: `ERROR http_status_401` | Key DeepSeek sai/hết hạn | Bấm lại "Nối key DeepSeek" hoặc dán key mới |
| AI Engine: `ERROR timeout` | Mạng chặn api.deepseek.com | Kiểm tra mạng; bot vẫn chạy bằng FAQ dự phòng |
| Đơn "Chờ hủy (ĐVVC)" | GHN từ chối huỷ | Mở đơn → "Gửi lại yêu cầu huỷ" khi GHN sẵn sàng |
| Follow-up "HELD ngoài 24h" | Khách chưa nhắn lại | Bình thường — khách nhắn lại là tự gửi tiếp |
