'use strict';
// guide-content.js — NỘI DUNG "Hướng dẫn sử dụng" cho Sales AI Console (chuẩn aicake.vn/UserGuide).
//
// 5 danh mục / 20 bài, mỗi bài 3-6 bước bấm đúng tên nút/menu trong UI thật:
//   sidebar Tổng quan/Báo cáo/Hội thoại/Đơn hàng/Sản phẩm/Khách hàng/Cài đặt;
//   wizard 7 bước (Thông tin shop → Facebook → Zalo → Sản phẩm → GHN → AI Provider → Test);
//   Cài đặt có card Thành viên team, Bình luận Facebook — tự động, Automation — follow-up sau giao.
//
// CONTRACT (Agent B dựng UI + Agent C làm AI chat code theo shape này — không đổi):
//   module.exports = { version, product, categories, searchArticles }
//   categories[]   : { id, title, articles[] }
//   articles[]     : { id, title, minutes, summary, steps[], seeAlso[] }
//   steps[]        : { title, body, tip? }
//   searchArticles(q): mảng { category, article, score } giảm dần theo score (chuẩn hóa bỏ dấu).

const categories = [
  // ============================================================ 1. BẮT ĐẦU NHANH
  {
    id: 'bat-dau-nhanh',
    title: 'Bắt đầu nhanh',
    articles: [
      {
        id: 'dang-nhap',
        title: 'Đăng nhập Console',
        minutes: 2,
        summary: 'Vào Sales AI Console bằng ID đăng nhập và mật khẩu shop cấp cho bạn. OWNER/ADMIN cấu hình toàn bộ, AGENT chỉ xem dữ liệu và bán hàng.',
        steps: [
          {
            title: 'Bước 1 — Mở trang đăng nhập',
            body: 'Truy cập địa chỉ Console của shop. Màn hình chào bằng ô ID đăng nhập + Mật khẩu. Nhập ID (kiểu thao2019, không cần email) và mật khẩu rồi bấm Đăng nhập.',
            tip: 'Sai quá 5 lần trong 1 phút hệ thống tạm chặn — chờ 1 phút rồi thử lại là được.',
          },
          {
            title: 'Bước 2 — Lần đầu đăng nhập',
            body: 'Nếu shop chưa hoàn thiện cấu hình, Console mở thẳng wizard "Thiết lập shop" (checklist go-live 7 bước). Làm lần lượt từ bước 1 đến bước 7 rồi bấm BẬT BOT TỰ ĐỘNG là shop lên sóng.',
            tip: 'Tài khoản đầu tiên được tạo là OWNER — chủ shop toàn quyền. Đăng nhập xong nên đổi mật khẩu ngay ở Cài đặt → Tài khoản & hệ thống.',
          },
          {
            title: 'Bước 3 — Quên mật khẩu',
            body: 'Bấm "Quên mật khẩu? → Đặt lại mật khẩu", nhập email đăng ký và bấm Tạo mã đặt lại. Dán mã vào ô Mã đặt lại, nhập mật khẩu mới (tối thiểu 8 ký tự) rồi bấm Đặt lại mật khẩu.',
          },
          {
            title: 'Bước 4 — Biết vai trò của mình',
            body: 'OWNER toàn quyền, ADMIN quản trị shop, AGENT (nhân viên bán) chỉ xem dữ liệu và làm việc trong Hội thoại + Đơn hàng — không sửa Cài đặt hay Sản phẩm, và không thấy wizard go-live.',
          },
        ],
        seeAlso: ['bat-bot', 'thanh-vien-phan-quy'],
      },
      {
        id: 'ho-so-shop',
        title: 'Điền hồ sơ shop',
        minutes: 2,
        summary: 'Wizard bước 1 — Thông tin shop: tên, hotline, địa chỉ. Đây là dữ liệu gốc AI dùng để giới thiệu shop và in vào bill xác nhận đơn.',
        steps: [
          {
            title: 'Bước 1 — Mở wizard Thiết lập shop',
            body: 'Sau lần đăng nhập đầu (hoặc từ Cài đặt bấm nút "Hoàn thiện cấu hình"), bạn thấy 7 thẻ bước. Thẻ số 1 là Thông tin shop.',
          },
          {
            title: 'Bước 2 — Điền đủ 3 ô',
            body: 'Tên shop (VD: Shop Nến Scent), Hotline (VD: 090xxxxxxx), Địa chỉ (VD: 123 ABC, Q1, TP.HCM). Cả 3 ô đều bắt buộc — thiếu ô nào thẻ vẫn ở trạng thái CHƯA XONG.',
          },
          {
            title: 'Bước 3 — Lưu bước 1',
            body: 'Bấm Lưu bước 1. Thẻ chuyển sang viên xanh XONG và đếm wizard tăng lên (ví dụ 1/7).',
            tip: 'Tên shop và hotline xuất hiện trong lời tư vấn của bot và trên bill — viết đúng thương hiệu bạn muốn khách nhìn thấy.',
          },
          {
            title: 'Bước 4 — Bổ sung hồ sơ cho AI',
            body: 'Muốn AI hiểu shop sâu hơn, vào Cài đặt → Hồ sơ shop cho AI điền thêm Lĩnh vực, Chính sách đổi trả, Chính sách giao hàng, Giờ làm việc… Field điền ở đây có độ ưu tiên CAO HƠN khung prompt cũ — điền là đè.',
          },
        ],
        seeAlso: ['viet-ngu-canh', 'ket-noi-fanpage-zalo'],
      },
      {
        id: 'ket-noi-fanpage-zalo',
        title: 'Kết nối Fanpage & Zalo',
        minutes: 3,
        summary: 'Wizard bước 2 (Facebook Messenger) và bước 3 (Zalo OA). Checklist go-live cần ít nhất 1 trong 2 kênh xanh để bot có khách chat. Bản lab đang chạy adapter giả lập — Phase 2 nối API thật.',
        steps: [
          {
            title: 'Bước 1 — Chuẩn bị token',
            body: 'Facebook: lấy Page ID và Page Access Token từ Meta for Developers (quyền pages_messaging). Zalo: lấy OA ID và Access Token từ trang quản trị Zalo OA. Token là thông tin bí mật — dán 1 lần, hệ thống lưu dạng masked, không bao giờ hiển thị lại.',
          },
          {
            title: 'Bước 2 — Lưu bước 2 Facebook',
            body: 'Ở thẻ 2 Facebook Messenger, điền Page ID + Page Access Token rồi bấm Lưu bước 2.',
          },
          {
            title: 'Bước 3 — Lưu bước 3 Zalo',
            body: 'Ở thẻ 3 Zalo OA, điền OA ID + Access Token rồi bấm Lưu bước 3.',
            tip: 'Go-live chỉ cần ÍT NHẤT một kênh (bước 2 hoặc bước 3). Nối cả hai thì khách Messenger và khách Zalo cùng được bot phục vụ.',
          },
          {
            title: 'Bước 4 — Lưu ý bản lab',
            body: 'Hiện kênh chạy ở chế độ giả lập (mock) để bạn đi trọn luồng mà không cần page thật. Khi nối production (Phase 2), ID/token đã lưu được giữ nguyên — hệ thống chỉ đổi sang gọi API thật.',
          },
        ],
        seeAlso: ['bat-bot'],
      },
      {
        id: 'them-san-pham',
        title: 'Thêm sản phẩm',
        minutes: 4,
        summary: 'Sản phẩm là nguồn sự thật giá/tồn cho bot. Thêm thủ công hoặc import CSV, đặt alias theo cách khách hay gọi, tắt bán ngay khi hết hàng.',
        steps: [
          {
            title: 'Bước 1 — Mở trang Sản phẩm',
            body: 'Sidebar → Sản phẩm → nút + Thêm sản phẩm.',
          },
          {
            title: 'Bước 2 — Điền thông tin gốc',
            body: 'Tên sản phẩm, SKU gốc (sku_base — duy nhất, VD: NEN-S-CANDLE), Giá (VND, phải là số > 0), Tồn kho. Có thể điền thêm Size và Màu để sinh variant.',
            tip: 'sku_base là chìa khóa: bot trích đơn, import CSV và báo cáo đều dựa vào nó — đặt ngắn, dễ nhớ và đừng đổi sau này.',
          },
          {
            title: 'Bước 3 — Thêm alias',
            body: 'Ô "Alias (cách khách gọi, phân cách bởi dấu phẩy)" ghi các cách khách hay gọi, VD: candle thơm, nen thom. Bot so alias khi khách nhắn không đúng tên chính thức.',
          },
          {
            title: 'Bước 4 — Import hàng loạt bằng CSV',
            body: 'Sản phẩm → Import CSV, dán bảng có dòng đầu là header: name,sku,price,stock,size,color,weight. Dòng lỗi được báo riêng kèm số dòng, không chặn các dòng hợp lệ.',
          },
          {
            title: 'Bước 5 — Tắt bán khi cần',
            body: 'Hết hàng hay ngừng kinh doanh: gạt công tắc bên phải dòng sản phẩm (Đang bán → Tạm tắt) — bot lập tức ngừng tư vấn món đó. Nút Xóa là xóa mềm: sản phẩm rời khỏi tư vấn nhưng đơn cũ vẫn đọc được.',
          },
        ],
        seeAlso: ['ai-tu-dong-tao-don', 'ly-do-ai-khong-bia-gia'],
      },
      {
        id: 'cau-hinh-van-chuyen',
        title: 'Cấu hình vận chuyển GHN',
        minutes: 2,
        summary: 'Wizard bước 5 — GHN (vận chuyển): shop id + token. Bắt buộc xanh nếu bạn bật Auto-order, vì chốt đơn xong hệ thống đẩy thẳng vận đơn lên GHN.',
        steps: [
          {
            title: 'Bước 1 — Chuẩn bị GHN Shop ID và Token',
            body: 'Đăng nhập GHN dành cho đối tác, lấy Shop ID (dãy số, VD: 1234567) và Token của shop.',
          },
          {
            title: 'Bước 2 — Lưu bước 5',
            body: 'Thẻ 5 GHN (vận chuyển): điền GHN Shop ID + GHN Token rồi bấm Lưu bước 5.',
            tip: 'Token chỉ ghi một lần, không hiển thị lại — lỡ mất thì tạo token mới trong GHN rồi lưu đè lên.',
          },
          {
            title: 'Bước 3 — Hiểu quan hệ với Auto-order',
            body: 'Bật Auto-order trong Cài đặt → Bot AI thì checklist go-live bắt buộc bước 5 phải xanh. Thiếu sẽ thấy đúng lý do từng chữ: "Bước 5: auto-order đang bật nên cần GHN token + shop id (hoặc tắt auto-order)".',
          },
          {
            title: 'Bước 4 — Vận đơn chạy thế nào',
            body: 'Khi đơn được bấm XÁC NHẬN ĐƠN, hệ thống tạo vận đơn GHN, ghi mã tracking vào chi tiết đơn và nhận webhook từ GHN để cập nhật Đang giao → Đã giao.',
          },
        ],
        seeAlso: ['xac-nhan-va-day-dvvc', 'ai-tu-dong-tao-don'],
      },
      {
        id: 'dang-ky-ai',
        title: 'Đăng ký & cắm key AI',
        minutes: 3,
        summary: 'Chọn provider (DeepSeek, OpenAI, Gemini, Grok, Kimi hoặc Local), dán API key và bấm Test gọi AI. Checklist go-live chỉ xanh khi AI test ra PASS ONLINE.',
        steps: [
          {
            title: 'Bước 1 — Chọn provider',
            body: 'Wizard thẻ 6 AI Provider: chọn DeepSeek / OpenAI / Local (stub — không gọi mạng). Muốn Gemini, Grok hoặc Kimi: vào Cài đặt → AI Engine → Đổi cấu hình, danh sách provider đọc động từ hệ thống.',
            tip: 'Mỗi provider có model mặc định riêng (deepseek-chat, gpt-4o-mini, gemini-2.0-flash, grok-3-mini, kimi-k2…). Ô Model để trống là dùng mặc định, điền vào là override.',
          },
          {
            title: 'Bước 2 — Dán API key',
            body: 'Ô API Key dán key dạng sk-… Key được lưu masked — không bao giờ trả về trình duyệt. Bấm Lưu cấu hình AI.',
          },
          {
            title: 'Bước 3 — Test gọi AI',
            body: 'Bấm Test gọi AI. Kết quả PASS (kèm tên provider) màu xanh nghĩa là AI ONLINE. Nếu ERROR, lỗi hiện ngay cạnh và cột last_error trong Cài đặt → AI Engine ghi rõ nguyên nhân.',
            tip: 'Key sai, hết credit hay mạng chặn đều lộ ra chỗ này — sửa xong test lại, chỉ mất vài giây.',
          },
          {
            title: 'Bước 4 — Chốt điều kiện go-live',
            body: 'Checklist go-live yêu cầu bước 6 xanh (AI ONLINE). Chưa có key thật thì tạm chọn Local để chạy thử, nhưng go-live bán hàng thật cần một provider online.',
          },
        ],
        seeAlso: ['bat-bot', 'ly-do-ai-khong-bia-gia'],
      },
      {
        id: 'bat-bot',
        title: 'Bật bot go-live',
        minutes: 2,
        summary: 'Đủ 7 bước checklist, thẻ Go-live mở khóa nút BẬT BOT TỰ ĐỘNG. Chưa đủ thì hệ thống liệt kê lý do từng bước cho bạn xử lý lần lượt.',
        steps: [
          {
            title: 'Bước 1 — Chạy 2 bài test cuối',
            body: 'Thẻ 7 Test hội thoại + đơn: bấm Chạy test hội thoại (bot trả lời được khách) và Chạy test đơn (tạo được đơn CONFIRMED). Hai viên xanh này bắt buộc trước khi bật bot.',
          },
          {
            title: 'Bước 2 — Đọc thẻ Go-live',
            body: 'Còn thiếu gì, thẻ Go-live liệt kê rõ ràng: chưa điền đủ tên shop + hotline + địa chỉ, chưa có sản phẩm bật bán, AI chưa ONLINE, chưa nối kênh nào (cần Facebook hoặc Zalo), auto-order bật mà thiếu GHN. Xử lý đúng mục được chỉ tên là xong.',
          },
          {
            title: 'Bước 3 — Bấm BẬT BOT TỰ ĐỘNG',
            body: 'Checklist đủ, nút sáng lên — bấm một lần là bot trả lời khách tự động trên kênh đã nối. Console báo "BOT ĐÃ BẬT — shop đã go-live!" và đưa bạn về Tổng quan.',
          },
          {
            title: 'Bước 4 — Về sau vẫn kiểm soát được',
            body: 'Muốn tạm dừng, vào Cài đặt → Bot AI gạt "Bot trả lời tự động" — mọi auto-send bị chặn ngay (bot_off). An toàn khi bạn đang sửa giá hay nhập tồn kho.',
          },
        ],
        seeAlso: ['dang-ky-ai', 'human-takeover'],
      },
    ],
  },

  // ============================================================ 2. XÂY DỰNG AI
  {
    id: 'xay-dung-ai',
    title: 'Xây dựng AI',
    articles: [
      {
        id: 'viet-ngu-canh',
        title: 'Viết ngữ cảnh cho AI',
        minutes: 4,
        summary: 'Dạy AI nói đúng giọng shop qua 9 nhóm thông tin: giọng nói, xưng hô, chính sách đổi trả, giờ làm việc, FAQ, điều cấm nói, ưu tiên bán, ngôn ngữ, quy tắc chốt đơn. Dán secret vào ngữ cảnh là bị hệ thống chặn ngay.',
        steps: [
          {
            title: 'Bước 1 — Điền khung Prompt theo form cấu hình',
            body: 'Cài đặt → Prompt theo form cấu hình: Giọng nói (thân thiện, dùng "dạ/ạ"), Cách xưng hô (em gọi khách là anh/chị), Ưu tiên bán (combo quà tặng, nến M), Ngôn ngữ (tiếng Việt có dấu), Chính sách đổi trả (đổi trả trong 7 ngày), Giờ làm việc (8h-21h mỗi ngày), Quy tắc chốt đơn (hỏi đủ tên/SĐT/địa chỉ rồi xác nhận), Không được nói (mỗi mục một dòng: không cam kết giá sai DB, không hứa giờ giao cụ thể). Xong bấm Lưu prompt.',
          },
          {
            title: 'Bước 2 — Bổ sung Hồ sơ shop cho AI',
            body: 'Cài đặt → Hồ sơ shop cho AI: tên, lĩnh vực, hotline, logo, chính sách giao hàng, quy tắc tư vấn, quy tắc chốt đơn, FAQ (mỗi dòng: câu hỏi | trả lời), Thông tin cấm nói. Field điền ở đây ĐÈ lên khung prompt cũ khi hệ thống build ngữ cảnh.',
            tip: 'Muốn đổi hướng tư vấn cho một chiến dịch, chỉ cần sửa ô Ưu tiên bán — không phải viết lại toàn bộ ngữ cảnh.',
          },
          {
            title: 'Bước 3 — Kiểm tra bằng Xem prompt',
            body: 'Bấm Xem prompt để đọc đúng bản ngữ cảnh cuối cùng hệ thống gửi cho model. Đây là bản chân thực nhất — chỉnh đến khi ưng rồi thôi.',
          },
          {
            title: 'Bước 4 — Tuyệt đối không dán secret',
            body: 'Không dán API key, token (sk-…, token, api-key…) vào bất kỳ ô ngữ cảnh nào — hệ thống quét và trả lỗi SECRET_IN_PROMPT. Secret chỉ nhập ở đúng ô API key của AI Engine.',
          },
          {
            title: 'Bước 5 — Giữ số liệu ngoài prompt',
            body: 'Giá, tồn, SKU, khuyến mại… đừng ghi cứng trong prompt — bot luôn đọc từ FACTS do ProductDB dựng. Ngữ cảnh chỉ dạy giọng nói và khuôn khổ tư vấn.',
          },
        ],
        seeAlso: ['ly-do-ai-khong-bia-gia', 'ho-so-shop'],
      },
      {
        id: 'ly-do-ai-khong-bia-gia',
        title: 'Vì sao AI không bịa giá',
        minutes: 3,
        summary: 'Mọi con số giá/tồn bot nói ra đều lấy 100% từ ProductDB qua FACTS. Action Gate soát từng tin trước khi gửi; AI không chắc thì trả lại nhân viên, không đoán bừa.',
        steps: [
          {
            title: 'Bước 1 — Hiểu FACTS',
            body: 'Trước mỗi lượt trả lời, hệ thống dựng FACTS từ ProductDB và đơn hàng: giá, tồn, SKU, phí ship, trạng thái đơn. AI chỉ được trích số trong FACTS — quy tắc này nằm ngay trong ngữ cảnh hệ thống.',
          },
          {
            title: 'Bước 2 — Action Gate soi trước khi gửi',
            body: 'Tin AI đề xuất phải qua Action Gate: đối chiếu giá/tồn của draft với DB. Sai số, bịa SKU hay hứa sai chính sách là bị chặn — khách sẽ không bao giờ nhận tin thiếu chính xác.',
            tip: 'Bot im lặng một tin? Xem Audit trong chi tiết đơn — Gate ghi rõ đã duyệt hay chặn gì, ở giai đoạn nào.',
          },
          {
            title: 'Bước 3 — Hết dữ liệu thì chuyển người',
            body: 'Khách hỏi thứ FACTS không có (món đã tắt bán, chính sách ngoài shop): bot mời khách để lại SĐT hoặc đánh dấu NEEDS_HUMAN — hội thoại nhảy sang trạng thái CẦN NGƯỜI và vào chuông thông báo cho nhân viên.',
          },
          {
            title: 'Bước 4 — Giữ niềm tin bằng số thật',
            body: 'Shop đổi giá giữa chừng thì hệ thống giữ chỗ lại theo giá MỚI và bắt khách xác nhận lần nữa — không bao giờ chốt đơn theo giá cũ rồi… xin lỗi sau.',
          },
        ],
        seeAlso: ['viet-ngu-canh', 'ai-tu-dong-tao-don'],
      },
      {
        id: 'tach-tin-quick-reply',
        title: 'Tách tin nhắn & quick reply',
        minutes: 4,
        summary: 'Một câu trả lời có thể gửi thành nhiều tin, kèm nút bấm cho khách: --- tách tin, [[Nhãn]] quick reply, [[[Nhãn|payload]]] postback, {{TenKhachHang}} gọi đúng tên khách.',
        steps: [
          {
            title: 'Bước 1 — Tách nhiều ý bằng ---',
            body: 'Dòng chỉ có 3 gạch ngang trở lên là ranh giới: mỗi khối thành một tin gửi lần lượt, giữ đúng thứ tự. Dấu --- nằm giữa câu thì KHÔNG tách — chỉ tính khi nó đứng đơn lẻ trên một dòng.',
            tip: 'Dùng để bóc bill ra một tin riêng, câu chào một tin — khách đọc không bị dồn cục.',
          },
          {
            title: 'Bước 2 — Thêm quick reply [[Nhãn]]',
            body: 'Ghi [[Xem bảng giá]] trong tin là hệ thống render thành nút bấm; payload mặc định chính là Nhãn. Muốn payload khác nhãn: [[Bảng giá|xem_bang_gia]].',
          },
          {
            title: 'Bước 3 — Dùng postback [[[Nhãn|payload]]]',
            body: 'Ba ngoặc [[[Nhãn|payload]]] tạo nút postback — nhãn hiển thị cho khách, payload gửi về máy chủ. Hệ thống nhận diện 3 ngoặc trước 2 ngoặc nên token không bị "ăn mất".',
          },
          {
            title: 'Bước 4 — Gọi tên khách {{TenKhachHang}}',
            body: 'Cắm biến {{TenKhachHang}} vào câu chữ, hệ thống thay bằng tên khách; chưa biết tên thì tự thành "bạn". Biến này chạy cả trong câu trả lời bình luận Facebook.',
          },
          {
            title: 'Bước 5 — Reply cũ không lo vỡ',
            body: 'Tin không chứa marker nào đi qua nguyên vẹn từng byte — template câu chữ cũ của shop không cần sửa gì vẫn chạy đúng như trước.',
          },
        ],
        seeAlso: ['ai-tu-dong-tao-don', 'viet-ngu-canh'],
      },
      {
        id: 'ai-tu-dong-tao-don',
        title: 'AI tự động tạo đơn',
        minutes: 4,
        summary: 'Khách hỏi món → chọn variant → để lại SĐT → tên & địa chỉ → bot gửi bill xác nhận. Đơn về trang Đơn hàng ở trạng thái Nháp (chờ xác nhận), giữ chỗ 24 giờ.',
        steps: [
          {
            title: 'Bước 1 — Khách hỏi món, bot tư vấn đúng variant',
            body: 'Bot so alias + FACTS để tư vấn đúng món, đúng size/màu còn hàng. Khách chọn xong là bot tự mở luồng lấy thông tin đặt hàng.',
          },
          {
            title: 'Bước 2 — Hỏi SĐT trước',
            body: 'Thiếu SĐT, bot chủ động hỏi: "anh/chị cho em xin SĐT để xác nhận đơn nha ạ". SĐT là chìa khớp khách cũ — mua lại không phải hỏi lại từ đầu.',
          },
          {
            title: 'Bước 3 — Lấy tên + địa chỉ rồi gửi bill',
            body: 'Đủ dữ kiện, hệ thống tự render bill từ dữ liệu đã validate (AI không tự sinh bill): sản phẩm, số lượng, tạm tính, phí ship, tổng. Khách gật là đơn chuyển Đã chốt.',
            tip: 'Bill luôn render từ DB tại thời điểm chốt — giá vừa sửa buổi sáng thì buổi chiều bot đã báo giá mới.',
          },
          {
            title: 'Bước 4 — Giữ chỗ 24 giờ',
            body: 'Đơn Nháp giữ tồn tối đa 24 giờ (hạn giữ chỗ hiện ngay trong chi tiết đơn). Hết giờ không được xác nhận, hệ thống tự hoàn tồn và đóng đơn Nháp.',
          },
          {
            title: 'Bước 5 — Auto-order đẩy GHN',
            body: 'Bật Auto-order (Cài đặt → Bot AI) thì ngay khi có đơn Nháp, hệ thống chuẩn bị đẩy vận đơn GHN — vì vậy bước 5 wizard bắt buộc phải có GHN token + shop id.',
          },
        ],
        seeAlso: ['doc-trang-don-hang', 'them-san-pham'],
      },
    ],
  },

  // ============================================================ 3. ĐƠN HÀNG & VẬN CHUYỂN
  {
    id: 'don-hang-van-chuyen',
    title: 'Đơn hàng & Vận chuyển',
    articles: [
      {
        id: 'doc-trang-don-hang',
        title: 'Đọc trang Đơn hàng',
        minutes: 3,
        summary: 'Sáu trạng thái một vòng đời: Nháp (chờ xác nhận) → Đã chốt → Đang giao → Đã giao; hủy theo hai nhánh Đã hủy và Chờ hủy (ĐVVC). Bấm vào dòng đơn để đọc trọn chi tiết.',
        steps: [
          {
            title: 'Bước 1 — Hiểu 6 viên trạng thái',
            body: 'Nháp (chờ xác nhận) — khách chưa gật; Đã chốt — CONFIRMED; Đang giao — đang trên đường; Đã giao — hoàn tất; Đã hủy — đóng từ phía shop/khách; Chờ hủy (ĐVVC) — đã gửi yêu cầu hủy, đang chờ đơn vị vận chuyển xác nhận.',
          },
          {
            title: 'Bước 2 — Lọc bằng chips',
            body: 'Hàng chips phía trên bảng lọc nhanh đúng nhóm đơn đang cần xử lý — dồn sức cho đống Nháp chưa chốt và các đơn Chờ hủy (ĐVVC) chưa xong.',
          },
          {
            title: 'Bước 3 — Mở chi tiết đơn',
            body: 'Bấm dòng đơn: khối chi tiết hiện Khách hàng (tên, SĐT, kênh, địa chỉ), Sản phẩm (SL, đơn giá, thành tiền), Tạm tính / Phí ship / Tổng, mục Vận chuyển (mã vận đơn, trạng thái, thời gian tạo).',
          },
          {
            title: 'Bước 4 — Truy nguồn hội thoại',
            body: 'Nút Mở hội thoại đưa bạn thẳng tới đoạn chat sinh ra đơn — cần khách nhắc lại yêu cầu thì mở đúng chỗ, không phải dò thủ công.',
            tip: 'Khối Lịch sử trạng thái ghi từng lần nhảy trạng thái (ai, lúc nào, vì sao); Audit gần đây ghi Action Gate đã duyệt hay chặn gì.',
          },
        ],
        seeAlso: ['xac-nhan-va-day-dvvc', 'ai-tu-dong-tao-don'],
      },
      {
        id: 'xac-nhan-va-day-dvvc',
        title: 'Xác nhận đơn & đẩy DVVC',
        minutes: 3,
        summary: 'Bấm XÁC NHẬN ĐƠN, hệ thống re-validate tồn/giá mới nhất rồi mới commit (pha B) và tạo vận đơn GHN. Thiếu vận đơn thì dùng RETRY GỬI HÀNG, không tạo trùng.',
        steps: [
          {
            title: 'Bước 1 — Chốt đơn Nháp',
            body: 'Mở đơn Nháp → XÁC NHẬN ĐƠN → xác nhận. Hệ thống kiểm tra lại tồn và giá MỚI NHẤT trước khi commit — giá vừa đổi lúc trưa cũng bắt kịp.',
          },
          {
            title: 'Bước 2 — Nhận vận đơn GHN',
            body: 'Chốt thành công, đơn sang Đã chốt và hệ thống đẩy GHN tạo vận đơn; mã tracking hiện ngay trong mục Vận chuyển, toast báo "Đã chốt … — vận đơn …".',
          },
          {
            title: 'Bước 3 — Xử lý đơn chốt mà chưa có vận đơn',
            body: 'Đơn Đã chốt nhưng chưa có vận đơn (GHN chập chờn…): bấm RETRY GỬI HÀNG — engine chạy lại đúng luồng gửi hàng, tự chống tạo trùng vận đơn.',
          },
          {
            title: 'Bước 4 — Theo dõi tới khi giao',
            body: 'Webhook GHN cập nhật trạng thái: Đang giao → Đã giao. Báo cáo tính doanh thu từ đơn Đã chốt + Đã giao nên không phải chờ giao xong mới thấy số.',
          },
        ],
        seeAlso: ['cau-hinh-van-chuyen', 'huy-don-2-chieu'],
      },
      {
        id: 'huy-don-2-chieu',
        title: 'Hủy đơn hai chiều',
        minutes: 3,
        summary: 'Hủy đơn Nháp là chuyện trong nhà — hệ thống hoàn tồn ngay. Đơn đã chốt có vận đơn thì phải hủy qua đơn vị vận chuyển, khi đó đơn sang Chờ hủy (ĐVVC) chờ xác nhận.',
        steps: [
          {
            title: 'Bước 1 — Hủy đơn Nháp',
            body: 'Mở đơn Nháp → HỦY ĐƠN → xác nhận. Tồn được hoàn lại ngay, bot tư vấn lại món đó bình thường.',
          },
          {
            title: 'Bước 2 — Hủy đơn đã chốt (kèm vận đơn)',
            body: 'Đơn Đã chốt có vận đơn: HỦY ĐƠN sẽ gửi yêu cầu hủy qua GHN. Đơn chuyển Chờ hủy (ĐVVC) kèm lý do — phải chờ DVVC gật mới xong, không ai được tự ghi Đã hủy.',
          },
          {
            title: 'Bước 3 — Retry khi DVVC ậm ạch',
            body: 'Đơn treo ở Chờ hủy (ĐVVC): bấm RETRY HỦY QUA ĐVVC để gọi lại đúng luồng engine — không sửa DB trực tiếp, dữ liệu luôn an toàn.',
          },
          {
            title: 'Bước 4 — Đọc kết quả trong chi tiết đơn',
            body: 'Hủy xong, khối Vận chuyển ghi rõ: ai hủy, lý do, thời gian; đơn ở Đã hủy kèm dòng đỏ "Đã hủy · bởi …". Webhook carrier vẫn theo dõi vận đơn tới khi thật sự đóng.',
            tip: 'Khách đổi ý sau khi hủy? Tạo đơn mới ngay từ chính hội thoại cũ — lịch sử chat vẫn còn nguyên.',
          },
        ],
        seeAlso: ['xac-nhan-va-day-dvvc', 'doc-trang-don-hang'],
      },
    ],
  },

  // ============================================================ 4. BÌNH LUẬN & AUTOMATION
  {
    id: 'binh-luan-automation',
    title: 'Bình luận & Automation',
    articles: [
      {
        id: '3-cong-tac-comment',
        title: 'Ba công tắc bình luận Facebook',
        minutes: 3,
        summary: 'Cài đặt → Bình luận Facebook — tự động: tự động trả lời bình luận, ẩn bình luận tiêu cực, inbox khách từ bình luận. Gạt là hiệu lực ngay, không cần restart.',
        steps: [
          {
            title: 'Bước 1 — Tự động trả lời bình luận',
            body: 'Bật "Tự động trả lời bình luận" (auto_reply_comment): câu hỏi và ý định mua dưới bài đăng được bot trả công khai, câu chữ dùng biến {{TenKhachHang}} gọi đúng tên người bình luận.',
          },
          {
            title: 'Bước 2 — Ẩn bình luận tiêu cực',
            body: 'Bật "Ẩn bình luận tiêu cực" (hide_negative_comment): comment chứa từ kiểu lừa đảo, scam, hàng fake, chê, tệ… bị ẩn và tự tạo việc cho nhân viên xử lý — bạn không phải canh bài 24/7.',
            tip: 'Danh sách từ khóa tiêu cực là cấu hình mở — thêm từ mới theo đúng giọng ngành hàng của bạn là hiệu lực ngay.',
          },
          {
            title: 'Bước 3 — Đẩy khách mua vào inbox',
            body: 'Bật "Inbox khách từ bình luận" (auto_inbox_from_comment): ai hỏi "giá bao nhiêu", "còn hàng không", "chốt"… là có ý định mua — hệ thống đẩy sang inbox bán để chuyển sang chốt đơn riêng tư.',
          },
          {
            title: 'Bước 4 — Giá vẫn từ DB, không từ bình luận',
            body: 'Câu trả lời công khai chỉ là câu lịch sự; giá/tồn vẫn đi qua luồng FACTS như tin nhắn riêng — khu vực bình luận ồn ào đến mấy cũng không làm bot nói sai số.',
          },
        ],
        seeAlso: ['human-takeover', 'ly-do-ai-khong-bia-gia'],
      },
      {
        id: 'follow-up-sau-ban',
        title: 'Follow-up sau bán',
        minutes: 3,
        summary: 'Cài đặt → Automation — follow-up sau giao: hẹn giờ care sau giao, xin đánh giá, nhắc mua lại theo số ngày. Khách đã từ chối quảng cáo không bao giờ nhận tin marketing.',
        steps: [
          {
            title: 'Bước 1 — Đặt lịch trong thẻ Automation',
            body: 'Cài đặt → Automation — follow-up sau giao: điền "Follow-up sau giao (số giờ)" (tối đa 720) và "Nhắc mua lại sau (số ngày)" (tối đa 365).',
          },
          {
            title: 'Bước 2 — Bật từng loại tin',
            body: 'Care sau giao: tin hỏi thăm sau khi đơn Đã giao. Review request: xin đánh giá sau giao. Purchase reminder: nhắc mua lại — thuộc dạng MARKETING. Xong bấm Lưu Automation.',
            tip: 'Cấu hình chỉ đặt LỊCH — mọi tin vẫn phải qua cổng Window 24h / Quota / Opt-out của core, không có cách nào spam khách.',
          },
          {
            title: 'Bước 3 — Tôn trọng khách opt-out',
            body: 'Khách từ chối quảng cáo bị đánh dấu "Đã từ chối QC" (xem ngay trong trang Khách hàng): purchase reminder dừng vĩnh viễn với họ, chỉ tin giao dịch như bill và vận đơn vẫn đi.',
          },
          {
            title: 'Bước 4 — Theo dõi sức khỏe automation',
            body: 'Thẻ Automation đếm số lịch, số khách opt-out và chia loại follow-up; gửi lỗi thì hệ thống retry có giới hạn rồi ghi NEEDS_HUMAN — không resend mù quáng.',
          },
        ],
        seeAlso: ['doc-trang-don-hang', '3-cong-tac-comment'],
      },
      {
        id: 'human-takeover',
        title: 'Tiếp quản hội thoại',
        minutes: 3,
        summary: 'AI không chắc thì trả lại người: hội thoại thành CẦN NGƯỜI, vào chuông thông báo. Bấm TIẾP QUẢN để nhân viên chat, xong việc bấm TRẢ LẠI CHO AI.',
        steps: [
          {
            title: 'Bước 1 — Nhận cảnh báo',
            body: 'Chuông thông báo gắn nhãn "Cần người" — bấm vào là nhảy thẳng trang Hội thoại đúng những đoạn AI trả lời không xong (NEEDS_HUMAN) hoặc đang do người giữ.',
          },
          {
            title: 'Bước 2 — Bấm TIẾP QUẢN',
            body: 'Mở hội thoại → TIẾP QUẢN. Banner "NHÂN VIÊN ĐANG TIẾP QUẢN" bật lên kèm tên bạn; từ giây này AI bị cấm gửi bất kỳ tin nào vào hội thoại đó.',
          },
          {
            title: 'Bước 3 — Chat như nhân viên thật',
            body: 'Gõ tin nhắn gửi thẳng khách: xử lý khiếu nại, báo giá đặc biệt, đồng ý đổi trả… Mọi con số bạn nói là ý kiến người thật, không qua Gate của AI.',
            tip: 'Một hội thoại chỉ một người giữ — khỏi lo hai nhân viên cùng trả lời một khách.',
          },
          {
            title: 'Bước 4 — TRẢ LẠI CHO AI khi xong',
            body: 'Xử lý xong, bấm TRẢ LẠI CHO AI để bot nhận lại luồng tự động. Số hội thoại đang giữ hiện ở Cài đặt → Bot AI (Human takeover); tỉ lệ AI tự chủ xem trong Báo cáo → Hiệu suất AI.',
          },
        ],
        seeAlso: ['ly-do-ai-khong-bia-gia', 'doc-bao-cao'],
      },
    ],
  },

  // ============================================================ 5. BÁO CÁO & QUẢN TRỊ
  {
    id: 'bao-cao-quan-tri',
    title: 'Báo cáo & Quản trị',
    articles: [
      {
        id: 'doc-bao-cao',
        title: 'Đọc trang Báo cáo',
        minutes: 3,
        summary: 'Báo cáo gom số liệu thật trong 14 ngày: doanh thu, đơn theo trạng thái, hiệu suất AI tự chốt bao nhiêu phần trăm, top khách và top sản phẩm.',
        steps: [
          {
            title: 'Bước 1 — Đọc 4 thẻ tổng',
            body: 'Sidebar → Báo cáo: Doanh thu 14 ngày (đơn đã chốt), Đơn hàng 14 ngày (đã chốt), Khách hàng đã mua, Giá trị TB/đơn. Doanh thu tính từ đơn Đã chốt + Đã giao.',
          },
          {
            title: 'Bước 2 — Đọc biểu đồ theo ngày',
            body: 'Biểu đồ cột "Doanh thu theo ngày": rê chuột vào cột hiện đúng ngày, số tiền và số đơn. Ngày không có doanh thu thì cột trống — nhìn phát biết ngày nào vắng.',
          },
          {
            title: 'Bước 3 — Đo hiệu suất AI',
            body: 'Thẻ Hiệu suất AI: Tổng hội thoại, AI tự xử lý, Nhân viên tiếp quản và chỉ số Tự chủ bot (%). Đây là thước đo AI đang tự lo được bao nhiêu mà không cần người can thiệp.',
          },
          {
            title: 'Bước 4 — Bám top khách / top sản phẩm',
            body: 'Top 10 khách hàng (theo chi tiêu) và Top 10 sản phẩm (theo số lượng bán) — nguyên liệu sẵn cho chương trình khách thân thiết và kế hoạch nhập hàng.',
            tip: 'Số liệu lấy trực tiếp từ store của hệ thống, không phải ước lượng — yên tâm đem ra họp.',
          },
        ],
        seeAlso: ['thanh-vien-phan-quy', 'doc-trang-don-hang'],
      },
      {
        id: 'thanh-vien-phan-quy',
        title: 'Thành viên & phân quyền',
        minutes: 3,
        summary: 'Cài đặt → Thành viên team: thêm AGENT (nhân viên bán), ADMIN (quản trị) hoặc OWNER (chủ shop). AGENT chỉ đọc dữ liệu và làm việc trong Hội thoại + Đơn hàng.',
        steps: [
          {
            title: 'Bước 1 — Mở form thêm thành viên',
            body: 'Cài đặt → Thành viên team → nút Thêm thành viên mở form: Email thành viên mới, Mật khẩu (≥8 ký tự), Vai trò.',
          },
          {
            title: 'Bước 2 — Chọn đúng vai trò',
            body: 'AGENT — nhân viên bán (hội thoại + đơn); ADMIN — quản trị shop; OWNER — chủ shop (toàn quyền). Chỉ OWNER tạo được OWNER — ADMIN không thể tự phong chủ shop.',
            tip: 'Nguyên tắc ít quyền nhất: nhân viên bán để AGENT, chỉ người giữ tài khoản GHN/AI dùng OWNER.',
          },
          {
            title: 'Bước 3 — Hiểu giới hạn của AGENT',
            body: 'AGENT xem được Tổng quan, Báo cáo, Hội thoại, Đơn hàng, Sản phẩm, Khách hàng và gửi tin/tiếp quản/chốt–hủy đơn; nhưng KHÔNG sửa Cài đặt, Sản phẩm, không thêm thành viên và không thấy wizard go-live.',
          },
          {
            title: 'Bước 4 — Quản lý vòng đời tài khoản',
            body: 'Chủ shop đổi mật khẩu của mình ở Cài đặt → Tài khoản & hệ thống → Đổi mật khẩu. Ai quên mật khẩu thì dùng đường dẫn Đặt lại mật khẩu ngay ở trang đăng nhập.',
          },
        ],
        seeAlso: ['dang-nhap', 'cai-app-pwa'],
      },
      {
        id: 'cai-app-pwa',
        title: 'Cài app lên điện thoại (PWA)',
        minutes: 2,
        summary: 'Sales AI Console là web app cài được lên màn hình chính (PWA — SalesAI). Cài một lần, mở như app thật; phần giao diện tĩnh được cache để dùng lại khi mạng yếu.',
        steps: [
          {
            title: 'Bước 1 — Cài trên iPhone/iPad',
            body: 'Mở Console bằng Safari → nút Chia sẻ → "Thêm vào Màn hình chính" → Thêm. Biểu tượng SalesAI nằm ngay màn hình chính, mở toàn màn hình như app.',
          },
          {
            title: 'Bước 2 — Cài trên Android',
            body: 'Mở bằng Chrome → menu ⋮ → "Cài đặt ứng dụng" (hoặc "Thêm vào Màn hình chính") → Cài đặt. Lần sau mở thẳng từ màn hình chính.',
          },
          {
            title: 'Bước 3 — Vẫn dùng được khi mạng chập chờn',
            body: 'Service worker cache phần tĩnh (giao diện, style, icon): mở lại app nhanh hơn và vẫn thấy khung console khi 4G yếu. Số liệu hội thoại/đơn vẫn cần mạng để cập nhật.',
          },
          {
            title: 'Bước 4 — Dùng tiện lợi một tay',
            body: 'App dựng cho màn dọc, bảng đơn kéo ngang được; nhân viên bán tài khoản AGENT chỉ cần mở app là chốt đơn, tiếp quản hội thoại ngay tại quầy.',
          },
        ],
        seeAlso: ['thanh-vien-phan-quy', 'human-takeover'],
      },
    ],
  },
];

// ============================================================ searchArticles
// Chuẩn hóa: lowercase + bỏ dấu tiếng Việt (NFD strip + đ→d) + gọn khoảng trắng.
function normText(s) {
  return String(s === undefined || s === null ? '' : s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

// searchArticles(q) — tìm bài theo title + summary + steps (title/body/tip).
// Mọi token của q phải khớp ÍT NHẤT một trường (AND giữa token); điểm = tổng trọng số
// trường khớp mỗi token + bonus cụm nguyên câu. Trả mảng { category, article, score }
// giảm dần theo score.
function searchArticles(q) {
  const query = normText(q);
  if (!query) return [];
  const tokens = query.split(' ').filter(Boolean);
  const results = [];
  for (const category of categories) {
    for (const article of category.articles) {
      const fields = [
        { text: normText(article.title), w: 4 },
        { text: normText(article.summary), w: 2 },
        { text: normText(article.steps.map(st => st.title).join(' \n ')), w: 1.5 },
        { text: normText(article.steps.map(st => `${st.body} ${st.tip || ''}`).join(' \n ')), w: 1 },
      ];
      let score = 0;
      let allMatch = true;
      for (const t of tokens) {
        let best = 0;
        for (const f of fields) {
          if (f.text.includes(t) && f.w > best) best = f.w;
        }
        if (!best) { allMatch = false; break; }
        score += best;
      }
      if (!allMatch) continue;
      if (fields[0].text.includes(query)) score += 6;
      else if (fields[1].text.includes(query)) score += 3;
      results.push({ category, article, score });
    }
  }
  results.sort((a, b) => b.score - a.score || a.article.title.localeCompare(b.article.title, 'vi'));
  return results;
}

module.exports = {
  version: 1,
  product: 'Sales AI Console',
  categories,
  searchArticles,
};
