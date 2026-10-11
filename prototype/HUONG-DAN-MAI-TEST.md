# HƯỚNG DẪN TEST THẬT — Bot bán hàng Suri (mai)

Máy đã sẵn 100%: icon desktop **Bot Ban Hang Suri**, bot nội bộ trả lời đúng giá,
đơn hàng chạy đủ. Chỉ còn điền **token thật** vào file `.env.live` rồi làm 5 bước dưới đây.

---

## Bước 0 — Chuẩn bị file `.env.live` (làm trước, tối nay hoặc sáng mai)

1. Mở thư mục bot: `C:\Users\BAOAN\.zcode\workspace\default\sales-ai-lab\prototype`
2. Copy file `.env.example` thành `.env.live` (cùng thư mục).
3. Điền giá trị thật, tối thiểu:
   - `CHANNEL_MODE=live`  và  `SHIPPING_MODE=ghn`  ← 2 dòng này BẮT BUỘC, không có là vẫn chạy giả lập
   - `META_APP_ID`, `META_APP_SECRET` — lấy trong Meta for Developers → App của bạn
   - `META_PAGE_ID`, `META_PAGE_ACCESS_TOKEN` — Page Facebook bán hàng (token Page, quyền pages_messaging)
   - `META_VERIFY_TOKEN=` **tự nghĩ 1 chuỗi bất kỳ** (vd `suri-2026-x`) — sẽ dùng y hệt khi khai webhook
   - `GHN_TOKEN`, `GHN_SHOP_ID` — tài khoản GHN (đơn hàng thật). Chưa có GHN thì xóa dòng `SHIPPING_MODE=ghn` (đơn sẽ chạy nội bộ, không tạo vận đơn thật)
   - `WEBHOOK_PUBLIC_BASE=` để trống, làm Bước 2 xong mới điền
   - Zalo: chưa dùng OA thì bỏ qua, không ảnh hưởng Facebook

## Bước 1 — Restart bot để nhận token mới

- Desktop: đúp **Tat Bot Ban Hang** → đúp **Bot Ban Hang Suri**
- Mở `http://localhost:8080`, đăng nhập, vào Cài đặt kiểm tra trạng thái.

## Bước 2 — Mở đường công khai (webhook)

- Desktop: đúp **Mo Tunnel Bot Ban Hang**
- Cửa sổ đen hiện dòng `https://xxxx-yyyy.trycloudflare.com` — **copy URL đó**
- Điền vào `.env.live` dòng `WEBHOOK_PUBLIC_BASE=https://xxxx-yyyy.trycloudflare.com`
  rồi **Tat Bot Ban Hang → Bot Ban Hang Suri** lần nữa (nhét URL vào bot).
  *(URL này mỗi lần mở tunnel là ĐỔI — sáng mai làm sát giờ test.)*

## Bước 3 — Khai webhook trên Meta

1. Meta for Developers → App → Messenger → Settings → Webhooks
2. Callback URL: `https://xxxx-yyyy.trycloudflare.com/webhooks/meta`
3. Verify token: đúng chuỗi `META_VERIFY_TOKEN` đã điền ở Bước 0 → Verify (bot phải đang chạy)
4. Subscribe fields: `messages`, `messaging_postbacks`
5. Gắn Page + cấp quyền nhận tin nhắn cho Page đó.

## Bước 4 — Test thật

- Dùng tài khoản Facebook khác nhắn tin vào Page:
  1. `cho hỏi nến thơm vanilla giá bao nhiêu` → phải nhận bảng giá 165.000/185.000đ
  2. `lấy 1 nến vanilla M` → bot hỏi tên/SĐT/địa chỉ, tạo đơn
  3. `xác nhận` → đơn CONFIRMED, (nếu GHN live) có mã vận đơn
- Xem trực tiếp trong dashboard: mục Hội thoại + Đơn hàng.

## Bước 5 — (Nên làm) Nối AI DeepSeek để bot có "hồn"

- Hiện AI đang chạy chế độ **local** (kịch bản cứng — vẫn trả đúng giá/đơn).
- Muốn hội thoại tự nhiên: Cài đặt → Nối key AI → chọn DeepSeek → dán key → Test.
  *(Key DeepSeek cũ mất theo thư mục cũ — cần key mới.)*

---

## Sự cố nhanh

| Hiện tượng | Xử lý |
|---|---|
| Meta Verify không qua | Bot chưa chạy → đúp **Bot Ban Hang Suri** rồi Verify lại; kiểm tra VERIFY_TOKEN khớp 2 nơi |
| Nhắn Page không thấy bot trả | Xem tunnel còn sống (cửa sổ đen phải còn mở); webhook URL đúng `/webhooks/meta` chưa; Page đã subscribe `messages` chưa |
| Bot trả lời kiểu kịch bản, không "AI" | Chưa nối key DeepSeek (Bước 5) |
| Quên mật khẩu | ID `thao2019` / mật khẩu `thao@1987` |
