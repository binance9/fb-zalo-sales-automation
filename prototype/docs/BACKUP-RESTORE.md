# BACKUP & RESTORE — SALES AI CONSOLE (SURI P2, hạng mục 6)

> Phạm vi: prototype chạy local trên 1 máy Windows. Toàn bộ dữ liệu shop nằm trong thư mục
> `prototype/data` (plain JSON, không DB server) — backup = chép file, restore = chép lại + restart.

---

## 1. Dữ liệu nằm ở đâu

```
prototype/
├── data/
│   ├── products.json                  # catalogue gốc (seed) — ít đổi
│   ├── auth/                          # TÀI KHOẢN đăng nhập + session + danh sách shop
│   │   ├── users.json  sessions.json  shops.json
│   ├── shops/<shop_id>/               # ★ MỖI SHOP 1 THƯ MỤC — quan trọng nhất
│   │   ├── db.json                    # TOÀN BỘ dữ liệu vận hành: khách, hội thoại, tin nhắn,
│   │   │                              #   đơn hàng, vận đơn, follow-up, audit, agent_runs…
│   │   ├── db.backup.json             # backup 1 tầng TỰ ĐỘNG (App ghi lúc boot persist —
│   │   │                              #   bản db.json TRƯỚC khi mở; chỉ chống 1 lần hỏng gần nhất)
│   │   ├── settings.json              # cấu hình shop: AI provider/key, kênh Meta/Zalo/GHN,
│   │   │                              #   timezone, automation… (KEY TỒN TRẠNG ĐÂY — GIỮ KỸ)
│   │   ├── product-overrides.json     # sản phẩm thêm/sửa/tắt qua UI (đè lên seed)
│   │   └── notifications-read.json    # trạng thái đã đọc của chuông thông báo (mất cũng không sao)
│   └── runtime/                       # dữ liệu App mặc định khi chạy test (không cần backup)
```

File nào nên backup: **`data/shops/<shop_id>/`** (nguyên thư mục — gồm db.json + settings.json +
product-overrides.json) và **`data/auth/`** (nếu muốn giữ tài khoản đăng nhập).

> CỨM SECRETS: `settings.json` chứa token kênh + key AI ở dạng THÔ (để adapter dùng).
> Backup file này ở nơi an toàn (ổ riêng/USB), KHÔNG gửi qua chat/email, KHÔNG commit lên git.

---

## 2. BACKUP — 3 bước (30 giây)

1. **Dừng bot**: đóng cửa sổ terminal `node server.js` (Ctrl+C). Đảm bảo không còn tiến trình node ghi file.
2. **Chép thư mục**: copy `prototype/data/shops/<shop_id>` đến nơi lưu trữ (đổi tên kèm ngày,
   ví dụ `backup-2026-10-06-shop-demo`). Làm tương tự với `prototype/data/auth` nếu muốn giữ user.
3. **Xong.** Có thể bật lại server ngay — không ảnh hưởng gì.

Backup tự động có sẵn (không thay thế backup tay): mỗi lần server boot ở chế độ persist,
trước khi mở DB, App copy `db.json` → `db.backup.json` (1 tầng). Vì vậy đừng xoá `db.backup.json`.

---

## 3. RESTORE — phục hồi sau mất dữ liệu / chuyển máy

**Điều kiện**: đã cài Node.js, đã có thư mục `prototype` (chương trình) + thư mục backup dữ liệu.

1. Dừng server đang chạy (nếu có).
2. Xem `shops.json` trong `prototype/data/auth` để biết đúng `<shop_id>` (nếu restore cả auth thì
   bỏ qua bước này — shop_id đi kèm backup).
3. **Chép đè** thư mục backup vào `prototype/data/shops/<shop_id>/` — đủ 3 file:
   `db.json`, `settings.json`, `product-overrides.json` (đừng chép đè lên server ĐANG CHẠY).
   - Nếu chỉ có `db.json` (backup từ nguồn khác): vẫn restore được — còn thiếu settings thì cấu
     hình lại AI/kênh qua wizard (mục 4).
4. **Bật server** (`START-BOT.bat`). App nạp `db.json` (persist mode, KHÔNG xoá dataDir).
   Đăng nhập bằng tài khoản cũ (đã restore auth) hoặc tạo tài khoản rồi vào đúng shop.
5. **Kiểm tra sau restore** (2 phút):
   - Đăng nhập OK; Tổng quan hiện đúng số khách/đơn.
   - Đơn hàng: lọc vài trạng thái, mở 1 đơn xem bill + vận đơn còn nguyên.
   - Hội thoại: mở 1 hội thoại cũ xem lịch sử tin nhắn; tab "Agent runs" còn run cũ.
   - Cài đặt → AI Engine: trạng thái ONLINE (bấm "Test gọi AI" nếu chưa chắc).
   - Kênh: Facebook/Zalo hiện CONNECTED (mock khi chưa live), GHN CONNECTED.
   - Follow-up/automation: Cài đặt → Automation thấy lịch còn đó và giờ VN đúng (GMT+7).

### Trường hợp đặc biệt

- **db.json hỏng nhưng db.backup.json còn**: đổi tên `db.backup.json` → `db.json` rồi boot.
  (Đây đúng vai trò backup 1 tầng: bản gần nhất trước lần boot hỏng.)
- **Mất settings.json (token AI/kênh biến mất)**: dữ liệu đơn/khách vẫn nguyên trong db.json;
  vào wizard điền lại bước 2/3/5 + nút "Nối key DeepSeek (live)" ở AI Engine.
- **Mất product-overrides.json**: sản phẩm quay về catalogue seed (products.json). Thêm lại SP
  hoặc phục hồi file này từ backup — sản phẩm cũ trong đơn KHÔNG mất (đơn lưu snapshot giá/sku).
- **Chuyển máy mới**: cài Node.js → chép cả thư mục `prototype` (hoặc chương trình + thư mục
  `data/`) → chạy `START-BOT.bat`. Port trùng (8080) thì mở `http://localhost:8080`.

---

## 4. Việc cần LẠI SAU restore (checklist)

| Việc | Lý do |
|---|---|
| Test gọi AI (AI Engine) | Key còn nhưng nên xác nhận ONLINE trước khi bot trả lời thật |
| Webhook: đối chiếu URL public | Nếu đổi máy/IP public → khai lại webhook Meta/Zalo/GHN (`WEBHOOK_PUBLIC_BASE`) |
| Đổi mật khẩu nếu nghi lộ | Backup chứa session token — an toàn nhất là đổi password mọi user |
| Chạy 1 test hội thoại (wizard bước 7) | Chứng minh chuỗi webhook → bot trả lời còn thông suốt sau restore |

## Việc KHÔNG được làm

- KHÔNG sửa tay `db.json` khi server đang chạy (ghi đè lẫn nhau — hỏng dữ liệu).
- KHÔNG xoá `db.backup.json` "cho gọn".
- KHÔNG gửi `settings.json` / `.env.live` qua kênh không mã hoá (chứa token + key AI).
- KHÔNG restore bằng cách "copy vào data/runtime" — thư mục đúng là `data/shops/<shop_id>/`.
