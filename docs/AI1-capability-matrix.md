# AI1 — CAPABILITY MATRIX (vòng 2 — AUDIT chính thức)

> Người viết: AI-1 (Platform/API reviewer) — ngày 2026-10-05.
> Nền: nâng cấp từ nghiên cứu vòng 1 (`AI1-platform-api.md`, 2026-10-04) thành AUDIT chính thức.
> Contract: `00-yeu-cau.md` — HARD INVARIANTS INV-1…INV-5 (không thay mục tiêu).
> Phương pháp: WebFetch/WebSearch trực tiếp vào docs chính thức HIỆN HÀNH (developers.facebook.com, developers.zalo.me, developer.ghn.vn, api.ghtk.vn, partner.viettelpost.vn) + source code SDK chính thức của Zalo trên GitHub (zaloplatform) làm bằng chứng bổ sung.
> **Phân cấp bằng chứng** (ghi ở mỗi dòng matrix):
> - **[A]** = trích nguyên văn được từ trang docs chính thức trong lần audit này.
> - **[B]** = docs chính thức có trang riêng nhưng chỉ đọc được qua search-index/SDK chính thức (docs Zalo render bằng JS) — nội dung khớp nhiều nguồn độc lập.
> - **[C]** = chỉ có nguồn bên thứ ba nhất quán — bắt buộc spot-check khi có app/OA thật.
>
> Nhãn capability (đúng 1 trong 4 cho mỗi dòng):
> - **SUPPORTED** — chính thức cho phép, doc rõ.
> - **RESTRICTED** — cho phép nhưng có điều kiện/window/quota/approve/verification.
> - **UNSUPPORTED** — nền tảng KHÔNG cho phép.
> - **CHƯA XÁC MINH** — chưa có doc rõ; ghi cần xác minh bằng gì.

---

## A. FACEBOOK / MESSENGER

| # | Capability | Nhãn | Bằng chứng & điều kiện | Nguồn | Ảnh hưởng thiết kế |
|---|---|---|---|---|---|
| A1 | Nhận text | **SUPPORTED** | [A] Webhook `messages`, sender PSID, `message.text`, `mid`. Trả 200 OK trong ~5s. | [docs/webhooks](https://developers.facebook.com/docs/messenger-platform/webhooks) | Gateway lưu raw payload → normalize về envelope chung. `mid` = key idempotency (INV-1). |
| A2 | Nhận ảnh | **SUPPORTED** | [A] `message.attachments[]` type `image` + `payload.url`. | [docs/webhook-events/messages](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messages) | Tải media về storage nội bộ NGAY (URL Meta không cam kết sống mãi — thực nghiệm tuần 1). |
| A3 | Nhận voice (audio) | **SUPPORTED** | [A] attachment type `audio` + `payload.url`. | cùng A2 | Pipeline: audio → ASR. Kiểm tra codec thực tế (thường mp4/ogg) khi app test. |
| A4 | Nhận video/file | **SUPPORTED** | [A] type `video`, `file`. | cùng A2 | Như A2. |
| A5 | Nhận sticker | **SUPPORTED** | [A] Docs xác nhận: có type mới `sticker` + `sticker_id` (Like = 369239263222822); trong thời gian chuyển đổi payload chứa CẢ `sticker` và `image`, sau đó CHỈ `sticker`. Mốc kết thúc chuyển đổi (vòng 1 ghi 30/08/2026) không đọc lại được nguyên văn trong lần này → xem changelog. | cùng A2 | Webhook handler phải nhận CẢ 2 type từ nay (không đợi mốc). |
| A6 | Nhận comment mới | **SUPPORTED** | [A] Page webhook field `feed`; subscribe qua `POST /{page-id}/subscribed_apps?subscribed_fields=feed`; bắt buộc `pages_manage_metadata` + `pages_show_list`. Docs khuyến nghị lấy comment_id từ webhook thay vì poll. | [docs/webhooks-for-pages](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-pages) | Channel Gateway FB phải subscribe 2 họ field: Messenger (`messages`…) + Page (`feed`). |
| A7 | Trả lời comment CÔNG KHAI (auto rep dưới comment) | **CHƯA XÁC MINH** | [A] Reference Graph API hiện hành cho `/post/comments` hiển thị Create = "Bạn không thể thực hiện thao tác này trên điểm cuối này" (cả bản v23.0 lẫn không phiên bản). Khác với hiểu biết phổ biến (POST /{post-id}/comments với `pages_manage_engagement`). Không tìm thấy endpoint thay thế rõ ràng trong lần audit này. | [reference/post/comments](https://developers.facebook.com/docs/graph-api/reference/post/comments) | **Xác minh bằng**: Page thật + token có `pages_manage_engagement`, thử `POST /{post-id}/comments` và `POST /{comment-id}/comments`. Nếu fails → bỏ tính năng "rep công khai", chỉ giữ private reply. KHÔNG hứa tính năng này với chủ shop trước khi test. |
| A8 | Private reply theo comment | **RESTRICTED** | [A] CHÍNH THỨC: chỉ **1 tin** cho người comment; gửi trong **7 ngày** kể từ khi comment/post được tạo; 24h-window chỉ mở khi user TRẢ LỜI tin; không private-reply Page khác; cần Page token của người có task `MESSAGING` + `pages_messaging`; `recipient:{comment_id\|post_id}`. | [docs/private-replies](https://developers.facebook.com/docs/messenger-platform/discovery/private-replies) | AI phải chốt 1 tin duy nhất tốt nhất (không gửi thử nhiều tin). Không có user response → dừng follow-up. Queue riêng private reply. |
| A9 | Gửi text (trong cửa sổ) | **SUPPORTED** | [A] `POST /{page-id}/messages`, `messaging_type=RESPONSE\|UPDATES`; cửa sổ 24h mở bởi: user nhắn, Get Started/CTA, quảng cáo C2M, plugin, m.me link, reaction, **comment**, visitor post; trong 24h được chứa nội dung promotional. | [docs/send-messages](https://developers.facebook.com/docs/messenger-platform/send-messages) | Lưu `last_user_event_ts` per PSID; Reply Policy kiểm tra clock trước khi gửi. |
| A10 | Gửi ảnh (trong cửa sổ) | **SUPPORTED** | [A] attachment object + `payload.url` (`is_reusable:true`) hoặc Attachment Upload API (attachment_id tái sử dụng). | cùng A9 | Upload 1 lần, tái dùng attachment_id để giảm băng thông + rate. |
| A11 | Gửi template (trong cửa sổ) | **SUPPORTED** | [A] Generic/button/media template trong Send API; postback từ button về qua `messaging_postbacks`. | cùng A9 | Template danh sách sản phẩm: dùng generic template; payload nút encode intent cho AI. |
| A12 | Gửi ngoài 24h bằng HUMAN_AGENT | **RESTRICTED** | [A] Tag `HUMAN_AGENT`: "allows a business representative to manually respond within a 7-day period"; policy: chỉ cho người thật trả lời, không promo. | [docs/send-messages](https://developers.facebook.com/docs/messenger-platform/send-messages) + [policy-overview](https://developers.facebook.com/docs/messenger-platform/policy/policy-overview) | Map thẳng vào INV-5: chỉ bật khi session đang HUMAN_OWNED; bot KHÔNG tự dùng tag này. |
| A13 | Gửi ngoài 24h bằng Utility Messages | **RESTRICTED** | [A] `messaging_type=UTILITY` + template có placeholder; permission `page_utility_messaging`; template được duyệt (Page-owned: duyệt gần tức thì, nhận `message_template_status_update` webhook); "Utility messages must not contain marketing materials" (rejection `TAG_SHOULD_BE_MARKETING`); Page không cần link business để gửi utility. | [docs/utility-messages](https://developers.facebook.com/docs/messenger-platform/send-messages/utility-messages) | Đường after-sales CHÍNH (trạng thái đơn/hẹn). Thiết kế bộ template: đơn tạo/đang ship/đã giao/thất bại + luồng duyệt template trong onboarding. |
| A14 | Gửi marketing chủ động ngoài 24h (Marketing Messages) | **RESTRICTED** | [A] Bắt buộc user **opt-in** (subscriber) — opt-in chỉ xin trong window; **1 tin/ngày/mã thông báo; từ 01/09/2025 chuyển thành 1 lần/48h/subscriber** (token tạo sau 02/02/2023); follow-up ≤ 3 tin trong 2 phút; docs nói đây là "tính năng cao cấp… dự định tính phí trong tương lai" (chưa thấy bảng giá công bố); docs ghi từ 01/09/2025 "Không cho phép tiện ích tích hợp mới"; opt-out → nhận lỗi khi gửi, không có webhook opt-out. **Danh sách quốc gia (VN có/không) KHÔNG hiển thị trên trang hiện hành** — khác vòng 1. | [docs/marketing-messages](https://developers.facebook.com/docs/messenger-platform/marketing-messages) | KHÔNG đưa vào lõi bán hàng. Module CRM opt-in riêng + tôn trọng opt-out vĩnh viễn. Đánh dấu CHƯA XÁC MINH: khả dụng cho tích hợp mới + VN eligible → hỏi Meta partner support trước khi hứa. |
| A15 | OTN — One-Time Notification | **RESTRICTED** | [B] Xin token trong window (template "Notify me"); user bấm → webhook `message_optins` trả `one_time_notif_token` (= `notification_messages_token`); token single-use, hết hạn ~1 năm nếu không dùng; cần permission/notification access setup trên Page. | [reference/page/messages](https://developers.facebook.com/docs/graph-api/reference/page/messages) + [SO/message_optins](https://stackoverflow.com/questions/63995331/one-time-notification-message-optins-callback-not-being-received-by-testers-is) | Dùng cho các mốc "1 lần" (đơn sắp giao, hỏi đánh giá sau bán). Lưu trạng thái đã-tiêu token. |
| A16 | Marketing tự do ngoài 24h (không opt-in, không kênh phí) | **UNSUPPORTED** | [A] Ngoài window chỉ có: Tagged message (use case approved, không promo), Utility, Marketing Messages (opt-in + phí dự kiến), OTN, Sponsored Messages. Gửi promo bằng tag sai mục đích → restrictions. | [docs/send-messages](https://developers.facebook.com/docs/messenger-platform/send-messages) + [policy-overview](https://developers.facebook.com/docs/messenger-platform/policy/policy-overview) | Case 18: automation FB dừng marketing khi hết window — thiết kế KHÔNG có lối "gửi thêm tin prom". |
| A17 | Persistent menu + Get Started | **SUPPORTED** | [A] `POST /me/messenger_profile`; Get Started là điều kiện tiên quyết để menu hiện; menu tối đa **20 item**, title ≤ 30 ký tự, payload ≤ 1000 ký tự; cần `pages_messaging` + role Administrator trên Page; rate riêng **10 call/10 phút/Page**. | [docs/persistent-menu](https://developers.facebook.com/docs/messenger-platform/send-messages/persistent-menu) | Bước chuẩn trong onboarding shop; menu chứa nút opt-in/opt-out marketing + "Gọi nhân viên" (hỗ trợ INV-5 + case 18). |
| A18 | Bot policy: 30s + disclosure | **RESTRICTED** | [A] "Automated bots must respond to user input within 30 seconds" (mọi input, trừ Get Started); disclosure "bạn đang nói với bot" bắt buộc khi luật yêu cầu (California, Đức) — khuyến nghị làm tốt practice; vi phạm → cảnh báo → giới hạn gửi tin. | [policy-overview](https://developers.facebook.com/docs/messenger-platform/policy/policy-overview) | SLA gateway < 30s cho ACK + first response; tin disclosure đầu phiên khi bật chế độ bot lại sau takeover. |
| A19 | Webhook durability (retry / thứ tự / disable) | **SUPPORTED** (cơ chế được đặc tả rõ — KHÔNG bảo đảm thứ tự, CÓ duplicate) | [A] Retry ngay lập tức rồi giảm tần suất trong **36 giờ**; "Your server should handle deduplication"; KHÔNG có cam kết thứ tự; batch tối đa 1000 update nhưng "batching cannot be guaranteed"; không query được dữ liệu webhook lịch sử; fail tiếp diễn **1 giờ** → cảnh báo "Webhooks Disabled" + app bị unsubscribed khỏi Page; cảnh báo phụ tại 15 phút; ACK 200 OK trong ~5s. | [docs/graph-api/webhooks/getting-started](https://developers.facebook.com/docs/graph-api/webhooks/getting-started) + [docs/messenger-platform/webhooks](https://developers.facebook.com/docs/messenger-platform/webhooks) | **INV-1 bắt buộc tự dựng** (dedupe theo `mid`/event key); lưu raw payload ngay trước ACK; monitor alert "Webhooks Disabled" + auto re-subscribe `subscribed_apps`. |
| A20 | Token lifecycle | **SUPPORTED** | [A] Long-lived Page token "do not have an expiration date" (chỉ mất khi đổi mật khẩu/thu hồi quyền); lấy qua long-lived User token (~60 ngày) + `GET /{user-id}/accounts`; exchange gọi server-side (kèm app secret); BISU token qua FLB "Defaults to never expire". | [docs/get-long-lived](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived) + [docs/facebook-login-for-business](https://developers.facebook.com/docs/facebook-login/facebook-login-for-business) | Vault token per shop; phát hiện lỗi 190 → flow re-auth; `appsecret_proof` cho mọi call server. |
| A21 | Onboarding shop owner không làm developer | **RESTRICTED** | [A] Facebook Login for Business: config_id định nghĩa permissions/assets/token type (User hoặc **BISU** không hết hạn); nhưng "to serve businesses that you do not own or manage, your app must be approved for Advanced Access via Meta's App Review" (+ Business Verification của doanh nghiệp sở hữu app). Embedded Signup đủ mạnh chỉ khi được duyệt Tech Provider. | [docs/facebook-login-for-business](https://developers.facebook.com/docs/facebook-login/facebook-login-for-business) | Pha 1 (prototype): dev mode + Page của mình — không cần review. Pha 2 (bán): App Review + Business Verification + Advanced Access (`pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, `pages_show_list`, `business_management`). Chủ shop chỉ cần role Page — không cần dev skills. |
| A22 | Opt-out (FB) | **SUPPORTED** | [A] User block/mute bất kỳ lúc nào (gửi → lỗi 551 "person unavailable"); Marketing Messages có link opt-out do Meta chèn; policy: opt-out phải được tôn trọng. | [policy-overview](https://developers.facebook.com/docs/messenger-platform/policy/policy-overview) + [docs/marketing-messages](https://developers.facebook.com/docs/messenger-platform/marketing-messages) | Kill-switch per user khi 551; CRM lưu opt-out marketing (không có webhook → tự ghi khi user bấm link/hỏi trong chat). Case 18. |
| A23 | Rate limit (FB) | **SUPPORTED** | [A] Tổng **200 × Engaged Users/24h**; Send **300 call/s/Page** (text/link/reaction/sticker), **10 call/s** (audio/video); Conversations 2 call/s/Page; Private Replies **750 call/giờ/Page** (docs diễn đạt rối: gắn chú thích Instagram — coi 750/h là trần an toàn, đánh dấu lại khi đo thực tế); > 40 tin/s hoặc dồn nhiều hội thoại → Page inbox ngừng nhận tin mới tới khi hạ nhiệt; lỗi 613/80001. | [docs/rate-limiting](https://developers.facebook.com/docs/messenger-platform/overview/rate-limiting) | Outbound queue + token bucket per Page (mục tiêu ≤ 5–10 tin/s thực tế); retry backoff 613/80001; queue riêng private reply. |

### Kết luận FB theo nhãn: SUPPORTED 14 · RESTRICTED 7 · UNSUPPORTED 1 · CHƯA XÁC MINH 1

---

## B. ZALO OA

| # | Capability | Nhãn | Bằng chứng & điều kiện | Nguồn | Ảnh hưởng thiết kế |
|---|---|---|---|---|---|
| B1 | Nhận text | **SUPPORTED** | [B] Webhook event `user_send_text`, `sender.user_id` (follower id), `message.msg_id`. | [docs webhook user_send](https://developers.zalo.me/docs/api/official-account-api/webhook/su-kien-nguoi-dung-gui-tin-nhan-post-3720) (JS-rendered; xác nhận qua search-index chính thức) | `msg_id` = key idempotency (INV-1). |
| B2 | Nhận ảnh | **SUPPORTED** | [B] `user_send_image` + `attachments` (url + thumbnail). | cùng B1 | Tải về storage ngay — URL Zalo có hạn dùng [B]. |
| B3 | Nhận voice | **SUPPORTED** | [B] `user_send_audio` — file **.amr** (không có duration trong payload). | cùng B1 (search-index xác nhận event name + AMR) | Media pipeline: **.amr → WAV/MP3** trước ASR (case 4). Không có duration → xử lý theo file. |
| B4 | Nhận sticker/gif/video/file/link/location | **SUPPORTED** | [B] `user_send_sticker`, `user_send_gif`, `user_send_video`, `user_send_file`, `user_send_link`, `user_send_location` (+ `anonymous_send_*` từ chat widget). | cùng B1 | Normalize về envelope chung; sticker chỉ cần id + url. |
| B5 | Gửi CS text/ảnh/template (cửa sổ 48h) | **RESTRICTED** | [B] `POST /v3.0/oa/message/cs`; ràng buộc vận hành: **8 tin CS / 48h per user** kể từ tương tác cuối (docs đối tác + quota API trả `cs_reply {remain:8,total:8}`); template có sẵn: `request_user_info` (thu thập info), hỏi-đáp. Số 8 không thấy nguyên văn trên bản docs fetch được (JS) — là con số quan sát phổ biến. | [docs gửi tin tư vấn](https://developers.zalo.me/docs/official-account/tin-nhan/tin-tu-van/gui-tin-tu-van-theo-mau-yeu-cau-thong-tin-nguoi-dung) + [CloudproCRM](https://docs.cloudpro.vn) + [SDK quota example](https://github.com/zaloplatform/zalo-java-sdk) | Reply Gate Zalo đọc `cs_reply.remain` TRƯỚC mỗi auto-send; remain thấp → dừng auto, chuyển human; gom ý thành ít tin nhất (quota đắt). |
| B6 | Đọc quota động | **SUPPORTED** | [A/B] `POST /v3.0/oa/quota/message` (SDK chính thức gọi `/v2.0/oa/quota/message` — test version khi app thật) trả `cs_reply`, `promotion {daily_*, monthly_*}`, `last_interaction`; webhook `change_oa_daily_quota` báo biến động. | [SDK GetQuotaCSFree.java](https://github.com/zaloplatform/zalo-java-sdk/blob/master/src/test/java/v3/GetQuotaCSFree.java) + [docs kiểm tra hạn mức](https://developers.zalo.me/docs/official-account/quan-ly/quan-ly-thong-tin-oa/kiem-tra-han-muc-tin-nhan-oa) | Không hardcode con số gói — đọc động mỗi lần quyết định gửi + cache TTL ngắn (≤ 60s). |
| B7 | Tin chủ động promotion (ngoài tương tác) | **RESTRICTED** | [B] Loại quota `promotion`: theo user **1 tin/ngày, 6 tin/tháng** (giá trị trả về từ API/docs mẫu; có thể theo gói OA); targeting broadcast có phí riêng. | [docs gửi tin](https://developers.zalo.me/docs/official-account/tin-nhan/tin-tu-van/gui-tin-tu-van-theo-mau-yeu-cau-thong-tin-nguoi-dung) + quota API [B] | Follow-up marketing Zalo phải có ngân sách tin per user trong CRM; KHÔNG auto-send promotion nếu không có chính sách riêng của shop. |
| B8 | Tin giao dịch transaction | **RESTRICTED** | [B] Loại tin `transaction` dùng `purchase_quota`/`sub_quota` (gói dịch vụ/mua lẻ) — dùng cho tin xác nhận đơn/vận chuyển. | [B] docs OA + quota API | Tin xác nhận đơn hàng Zalo nên đi loại transaction (không tốn cs_reply) — cần xác nhận product_type khi có OA thật. |
| B9 | Marketing/ngoài quota tự do | **UNSUPPORTED** | [B] Quota là rào cứng phía nền tảng (hết `remain` → API từ chối); không có "escape hatch" miễn phí tương đương HUMAN_AGENT của FB. | cùng B5/B6 | Thiết kế KHÔNG có nhánh "gửi thêm dù hết quota". Ưu tiên human takeover qua app Chat Zalo (ngoài API). |
| B10 | Persistent menu (menu chat OA) | **CHƯA XÁC MINH** | Menu chat tồn tại như tính năng OA (cấu hình được qua quản trị OA — nguồn hướng dẫn bên thứ ba); các path API `/v3.0/oa/menu/set|get` xuất hiện trong kết quả tìm kiếm nhưng KHÔNG xác nhận được từ docs chính thức trong lần này (JS-render, search không trả trang docs riêng). | [ShopCloud hướng dẫn menu](https://shopcloud.vn) + [developers.zalo.me](https://developers.zalo.me) | **Xác minh bằng**: OA thật + app test gọi `/v3.0/oa/menu/set` (hoặc thiết kế fallback: cấu hình menu tay trong oa.zalo.me khi onboarding — không chặn prototype). Menu nên có nút "Gọi nhân viên" + "Bật/tắt tin marketing". |
| B11 | Get Started / tin chào | **RESTRICTED** | [B] "Tin chào" cấu hình trong quản trị OA (oa.zalo.me) tự gửi khi user quan tâm; loại quota riêng `welcome_msg`; không thấy API set nội dung tin chào trong lần này. | [B] docs index + hướng dẫn đối tác | Nội dung tin chào = một phần cấu hình onboarding (tay hoặc qua API nếu xác minh được); không đếm vào quota CS. |
| B12 | Webhook durability (Zalo) | **CHƯA XÁC MINH** | [B] Đặc tả event + chữ ký `X-ZEvent-Signature = sha256(appId + data + timeStamp + OAsecretKey)` có rõ; NHƯNG retry policy / cam kết thứ tự / hành vi khi endpoint fail KHÔNG có văn bản công khai trong lần audit này. | [docs webhook](https://developers.zalo.me/docs/api/official-account-api/webhook/su-kien-nguoi-dung-giu-tin-nhan-post-3720) + [Pouchy docs đối chiếu](https://pouchy.ai) | **Xác minh bằng thực nghiệm**: dựng endpoint trả 500 chủ động, đo Zalo gửi lại bao nhiêu lần/chu kỳ nào. Trong mọi kịch bản: INV-1 tự dựng cho cả hai kênh (giống FB). |
| B13 | Token lifecycle (25h + refresh) | **SUPPORTED** | [A/B] Endpoint chính thức (nguyên văn từ SDK Zalo): `POST https://oauth.zaloapp.com/v4/oa/access_token`, header `secret_key`, body `refresh_token` + `app_id` + `grant_type=refresh_token`; vòng đời: access ~**25h** (`expires_in ≈ 90000`), refresh **3 tháng**, refresh token XOAY VÒNG (dùng 1 lần, nhận cặp mới). | [SDK GetAccessTokenByRefreshToken.java](https://github.com/zaloplatform/zalo-java-sdk/blob/master/src/test/java/GetAccessTokenByRefreshToken.java) + [n8n-nodes-zalo-oa](https://github.com/) + [B] docs index | Token Service: cron refresh mỗi 12h; LƯU ĐÈ CẢ HAI token ngay khi refresh (rotation — refresh cũ chết sau 1 lần dùng); alarm khi fail; token chỉ Gateway dùng (không vào prompt). |
| B14 | Onboarding owner Zalo (không làm developer) | **RESTRICTED** | [B] Owner (quản trị OA) cấp quyền cho app Zalo của SaaS qua flow OAuth OA (`oauth.zaloapp.com/v4/oa/access_token` với `authorization_code`); owner không cần kỹ năng dev NHƯNG phải có sẵn: OA đã đăng ký (CCCD + giấy phép DN cho xác minh), Zalo App của SaaS được tạo trước, và thao tác "liên kết OA" đúng vai trò. | [SDK token example](https://github.com/zaloplatform/zalo-java-sdk) + [B] docs OAuth | Flow onboarding Zalo: hướng dẫn owner tạo OA (nếu chưa có) → bấm link ủy quyền app → hệ thống nhận code → đổi token → lưu Vault. Điểm khác FB: không có "config_id" kiểu FLB; cần app test đo UX thật. |
| B15 | Opt-out (Zalo) | **SUPPORTED** | [B] Webhook events `unfollow` (bỏ quan tâm) và `user_withdraw` (rút sự đồng ý xử lý dữ liệu) được docs liệt kê rõ; còn `user_reacted_message`/`user_seen_message` làm receipt. | [docs webhook](https://developers.zalo.me/docs/api/official-account-api/webhook/su-kien-nguoi-dung-giu-tin-nhan-post-3720) + [B] docs index | `unfollow`/`user_withdraw` → khóa mọi automation NGAY + audit (case 18). Trạng thái opt-out là input bắt buộc của Reply Gate. |
| B16 | Rate limit (Zalo) | **CHƯA XÁC MINH** | Không tìm thấy con số request/giây công khai trên docs (chỉ có bảng mã lỗi chính thức); giới hạn hiệu dụng thực tế là quota tin theo user (B5–B7). | [B] [trang mã lỗi Zalo](https://developers.zalo.me) (CDN stc-developers.zdn.vn) | Tự đặt soft-limit nội bộ (vd ≤ 2 call/s/OA) + backoff khi lỗi rate; đo thực tế khi app test rồi chỉnh. |

### Kết luận Zalo theo nhãn: SUPPORTED 7 · RESTRICTED 5 · UNSUPPORTED 1 · CHƯA XÁC MINH 3

---

## C. ĐƠN VẬN VẬN CHUYỂN (docs công khai từng hãng)

| # | Hãng | Nhãn | Bằng chứng & điều kiện | Nguồn | Ảnh hưởng thiết kế |
|---|---|---|---|---|---|
| C1 | **GHN** (Giao Hàng Nhanh) | **SUPPORTED** | [A] Portal developer công khai đầy đủ: Orders (create/update/cancel/return/in nhãn/tracking), Fees & Services (tính phí, leadtime), **Webhooks** (trạng thái đơn + COD đẩy realtime về callback), Master Data (tỉnh/huyện/xã/station), Token, Shops; docs xem không cần login; để gọi API: đăng ký miễn phí `khachhang.ghn.vn` → lấy **Token + ShopId** → **sandbox `5sao.ghn.dev`** → go-live. | [developer.ghn.vn](https://developer.ghn.vn/) | Chọn GHN làm ĐVVC ĐẦU TIÊN của prototype: duy nhất có sandbox + self-serve. Adapter interface thiết kế theo mẫu GHN (create/fee/tracking/webhook) rồi map các hãng sau. Kiểm tra idempotency field (`client_order_code`) trên docs create order khi implement (INV-3). |
| C2 | **GHTK** (Giao Hàng Tiết Kiệm) | **RESTRICTED** | [A] OpenAPI portal công khai: API đăng đơn, trạng thái đơn, tính phí, in nhãn, hủy đơn, **webhook**, nhóm API "DOANH NGHIỆP" dành riêng cho đối tác sàn TMĐT/phần mềm bán hàng (đăng ký qua tư vấn doanh nghiệp, tài khoản đăng ký trước); hỗ trợ order code của đối tác (`order.id`). | [api.ghtk.vn](https://api.ghtk.vn) | Tích hợp được nhưng phải đăng ký/hợp đồng để có token ổn định; không tự-serve như GHN. Để phase 2. |
| C3 | **J&T Express Việt Nam** | **CHƯA XÁC MINH** | Không có docs API công khai cho thị trường VN (site chính thức jtexpress.vn không lộ portal API; nền tảng open API quốc tế `open.jtexpress.com` tồn tại nhưng coverage VN + điều kiện đối tác chưa xác minh được từ nguồn chính thức). | [jtexpress.vn](https://jtexpress.vn) | **Xác minh bằng**: email CSKH/đội business J&T VN (1900 1088, cskh@jtexpress.vn) xin tài liệu API đối tác. KHÔNG dùng API không chính thức. Phase này: chỉ giữ interface ĐVVC trống cho J&T. |
| C4 | **ViettelPost** | **RESTRICTED** | [A/B] Portal đối tác tồn tại chính thức: "Partner ViettelPost - Open API" (`partner.viettelpost.vn` → `partner2.viettelpost.vn`, SPA); endpoint nghiệp vụ `apis.viettelpost.vn`; docs chi tiết nằm TRONG khu vực đối tác (bản lưu hành ngoài: lấy token tài khoản đối tác, webhook giới hạn **1 URL/đối tác**) — chưa xác minh nguyên bản docs từ portal. | [partner2.viettelpost.vn](https://partner2.viettelpost.vn/) + bản docs đối tác lưu hành ngoài (studocu/scribd — không chính thống) | Đăng ký đối tác để lấy docs gốc + token; webhook chỉ 1 URL/đối tác → Gateway phải nhận-all-then-route. Phase 2. |

### Kết luận ĐVVC theo nhãn: SUPPORTED 1 · RESTRICTED 2 · CHƯA XÁC MINH 1

---

## D. ĐỐI CHIẾU HARD INVARIANTS — nền tảng ủng hộ gì, phải tự dựng gì

| Invariant | Nền tảng ủng hộ? | Phân tích (nguồn ở matrix tương ứng) |
|---|---|---|
| **INV-1 INBOUND IDEMPOTENCY** | **KHÔNG — tự dựng 100%, bắt buộc** | Meta retry tới 36 giờ và docs NÓI THẲNG "Your server should handle deduplication"; không cam kết thứ tự; không có API đọc lại lịch sử webhook. Zalo: retry policy chưa xác minh → càng không thể tin rằng không có duplicate. → Bảng `raw_event` với unique key (`channel`, `sender`, `mid`/`msg_id`) + watermark timestamp per conversation để sort lại. Đây là điều kiện cần cho case test 10. |
| **INV-2 OUTBOUND UNKNOWN** | **Một phần công cụ, zero bảo đảm — tự dựng receipt store** | FB: gửi thành công trả `message_id` đồng bộ; lỗi trả code đồng bộ (10/190/551/613/1545041); **không có API đọc trạng thái từng tin** → receipt = webhook `message_deliveries`/`message_reads` + `message_echoes`. Zalo: response `msg_id` + `error_code`; receipt = `user_seen_message`/`user_reacted_message`. → Cấm blind-retry khi timeout: ghi pending-send kèm idempotency key outbound, chờ receipt hoặc đối chiếu echo trước khi hành động tiếp (case test 11). |
| **INV-3 ORDER IDEMPOTENCY** | **Một phần ở ĐVVC — phải thiết kế key của mình** | Không liên quan FB/Zalo. Ở ĐVVC: GHTK nhận `order.id` = mã đối tác; GHN cần kiểm tra field mã đơn khách (`client_order_code`) trên docs create — nếu có thì dùng làm idempotency key; ViettelPost có mã đơn đối tác trong docs đối tác. → Idempotency key do HỆ THỐNG sinh (order_id nội bộ) và gửi kèm; trùng key không tạo đơn thứ hai — verify bằng cách query lại trước khi tạo lại (case test 12). |
| **INV-4 REVALIDATE TRƯỚC COMMIT** | **KHÔNG liên quan nền tảng chat — tự dựng 100%** | Giá/tồn/khuyến mại là DB của shop; phí ship phải gọi lại API ĐVVC (GHN `Fees`, GHTK `tính phí`) NGAY trước commit — không dùng số đã quote trong chat. Nền tảng chat không cung cấp gì cho invariant này. |
| **INV-5 HUMAN_OWNED** | **FB ủng hộ có công cụ (Handover Protocol + HUMAN_AGENT 7 ngày); Zalo KHÔNG có công cụ tương đương công khai** | FB: webhook fields `messaging_handovers` + `standby` tồn tại chính thức trong danh sách field có thể subscribe; tag HUMAN_AGENT hợp lệ đúng cho người thật trả lời ≤ 7 ngày → AI phải tự ngắt khi session HUMAN_OWNED, chỉ nhân viên gửi (qua chính tag đó nếu quá 24h). Zalo: không thấy Handover Protocol công khai trong docs; khả năng "nhân viên dùng app Chat Zalo trả lời ngoài API" tồn tại nhưng hệ thống không thấy được qua webhook → state HUMAN_OWNED phải là trạng thái NỘI BỘ mà AI tôn trọng tuyệt đối; khi nhân viên trả quyền, cần tin nhắn disclosure rồi mới bật lại bot. |

---

## E. XÁC MINH LẠI KẾT LUẬN VÒNG 1 — sai chỗ nào sửa chỗ đó

| # | Kết luận vòng 1 | Kết quả audit vòng 2 | Hành động |
|---|---|---|---|
| 1 | 3 tag `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, `POST_PURCHASE_UPDATE` chết từ **27/04/2026**, trả lỗi code 100 | ✅ **ĐỨNG — xác nhận nguyên văn từ docs Send API hiện hành** ("Effective April 27th, 2026, requests using the tags … will return error code 100") | Chốt: after-sales FB đi Utility Messages (A13). Gỡ mọi tham chiếu tag cũ khỏi Reply Policy. |
| 2 | Zalo access token **25h** + refresh 3 tháng, xoay vòng | ✅ **ĐỨNG về cơ chế** — endpoint + flow refresh xác nhận NGUYÊN VĂN từ SDK chính thức (zaloplatform/zalo-java-sdk); con số 25h/3 tháng khớp nhiều nguồn độc lập nhưng chưa trích nguyên văn được từ docs (JS) | Giữ, nhãn [B]; spot-check `expires_in` thực tế khi app test. |
| 3 | Quota CS Zalo **8 tin/48h** | ✅ **ĐỨNG như quy tắc vận hành** — quota API trả `cs_reply {remain:8, total:8}` (SDK + docs index), docs đối tác ghi "8 tin miễn phí trong 48h"; NHƯNG con số không nằm trong văn bản docs nguyên văn fetch được | Giữ 8/48h làm mặc định thiết kế + **cấm hardcode** — Reply Gate luôn đọc API (B6). |
| 4 | Marketing Messages: "Meta tính phí theo tin (pay per delivered message)", VN trong danh sách ~20 nước, frequency 1/ngày (+12h/90 ngày) | ⚠️ **SỬA 4 ĐIỂM**: (a) docs hiện hành nói "tính năng cao cấp… **dự định** tính phí trong tương lai" — chưa thấy bảng giá công bố; (b) từ **01/09/2025** pause window thành **1 lần/48h/subscriber** (token tạo sau 02/02/2023); (c) docs ghi từ 01/09/2025 "không cho phép tiện ích tích hợp mới" → khả dụng cho SaaS mới chưa rõ; (d) danh sách quốc gia KHÔNG còn hiển thị trên trang docs → VN eligible chuyển **CHƯA XÁC MINH** | Hạ vai trò Marketing Messages từ "ADAPT" xuống "theo dõi — không thiết kế vào lõi"; ghi vào rủi ro sản phẩm. |
| 5 | Private Replies **750 call/giờ/Page** | ⚠️ **GIỮ SỐ, GHI CHÚ**: docs hiện hành diễn đạt bất thường ("750 calls per hour per Facebook Page **for private replies to comments on Instagram posts and reels**" — câu gắn chú thích Instagram ngay ở dòng Facebook Page) | Dùng 750/h làm trần an toàn trong queue; đo thực tế khi có Page thật. |
| 6 | Trả lời comment công khai: endpoint `POST /{page-post-id}/comments`, permission `CHƯA XÁC MINH` | ⚠️ **CẬP NHẬT XẤU HƠN**: reference Graph API hiện hành hiển thị **Create = không khả dụng** trên `/post/comments` (cả v23.0 lẫn không version) — không tìm thấy endpoint thay thế được docs rõ | Chuyển A7 thành **CHƯA XÁC MINH (ưu tiên cao)**: bắt buộc test Page thật trước khi hứa tính năng. Kế hoạch dự phòng: chỉ private reply. |
| 7 | Webhook Meta fail ~1h → disable | ✅ **ĐỨNG — nâng cấp thành nguyên văn chính thức**: "If delivery of a notification continues to fail for 1 hour, you will receive a **Webhooks Disabled** alert, and your app will be **unsubscribed**"; thêm: alert phụ tại 15 phút; ACK 200 trong ~5s; retry 36h | Monitor + auto re-subscribe là yêu cầu sản phẩm, không chỉ best practice. |
| 8 | Sticker FB: từ 30/08/2026 chỉ còn type `sticker` | ✅ **CƠ CHẾ ĐỨNG** (90-day transition, sau đó chỉ `sticker`) — mốc ngày cụ thể không đọc lại được nguyên văn trong lần này | Handler nhận cả 2 type từ NGAY (không đợi mốc); xem changelog để chốt ngày. |
| 9 | Long-lived Page token không hạn; user ~60 ngày | ✅ **ĐỨNG — nguyên văn**: Page token "do not have an expiration date"; user long-lived "generally lasts about 60 days" | Không thay đổi thiết kế. |
| 10 | Persistent menu 20 item / 30 ký tự / payload 1000 / rate 10-10 phút; HUMAN_AGENT 7 ngày; private reply 1 tin/7 ngày; rate limits 200×EU, 300/s, 10/s, 2/s; bot 30s; `page_utility_messaging` + duyệt template | ✅ **TẤT CẢ ĐỨNG — xác nhận lại trực tiếp từ docs hiện hành** | Không thay đổi. |
| 11 | Zalo webhook signature, events, `.amr` | ✅ **ĐỨNG** — `user_send_audio` (AMR) + events xác nhận qua search-index của chính docs chính thức; công thức signature khớp nguồn đối chiếu độc lập | Không thay đổi; giữ [B]. |
| 12 | Recurring Notifications deprecated 10/02/2026 | ➖ Không tái xuất hiện trong docs gửi tin hiện hành; không kiểm chứng lại được lần này | Coi như KHÔNG dùng; không đưa vào thiết kế. |

---

## F. TỔNG HỢP

### 6.1. Đếm nhãn (43 dòng capability)

| Nhãn | FB/Messenger | Zalo OA | ĐVVC | Tổng |
|---|---|---|---|---|
| **SUPPORTED** | 14 | 7 | 1 | **22** |
| **RESTRICTED** | 7 | 5 | 2 | **14** |
| **UNSUPPORTED** | 1 | 1 | 0 | **2** |
| **CHƯA XÁC MINH** | 1 | 3 | 1 | **5** |

### 6.2. 5 phát hiện quan trọng nhất của vòng 2

1. **3 tag chết 27/04/2026 xác nhận nguyên văn từ docs hiện hành** → sau-sales Messenger KHÔNG còn lối đi tag: phải xây hẳn luồng **Utility Messages** (permission `page_utility_messaging`, template được duyệt, cấm marketing). Đây là thay đổi kiến trúc lớn của Reply Policy nhánh (c).
2. **Marketing Messages không còn là kênh lập kế hoạch an toàn**: từ 01/09/2025 chỉ 1 tin/48h/subscriber, docs ghi "không cho phép tiện ích tích hợp mới", giá "dự định tính phí" chưa công bố, VN eligible không còn thấy trên docs → **sửa vòng 1**: hạ khỏi thiết kế lõi, coi là rủi ro cơ hội, cần hỏi Meta partner support.
3. **Webhook durability được đặc tả đủ chặt để đóng thiết kế INV-1/INV-2**: Meta retry 36h + bắt dedupe phía mình + fail 1h → disable & unsubscribe + không có lịch sử webhook → idempotency inbound và receipt store outbound là **code tự dựng bắt buộc trên CẢ HAI kênh** (Zalo retry policy còn chưa xác minh — cần thực nghiệm chủ động trả 500).
4. **Trả lời comment CÔNG KHAI đang có rủi ro tính năng**: reference Graph API hiện hành hiển thị Create không khả dụng trên `/post/comments` — khác hiểu biết phổ biến mà vòng 1 dựa vào. Private reply (1 tin/7 ngày) vẫn chắc chắn → đề xuất luồng comment automation dựa trên private reply, tính năng rep công khai chỉ cam kết sau khi test Page thật với `pages_manage_engagement`.
5. **GHN là ĐVVC duy nhất đạt SUPPORTED**: docs công khai đầy đủ (orders/fee/tracking/**webhook**/sandbox `5sao.ghn.dev`, self-serve token) → chọn làm hãng đầu tiên của adapter; GHTK + ViettelPost cần đăng ký đối tác (RESTRICTED), J&T VN không có docs công khai (CHƯA XÁC MINH — phải liên hệ business, cấm dùng API không chính thức).

### 6.3. Việc cần làm để đóng 5 ô CHƯA XÁC MINH

| Ô | Cần xác minh bằng |
|---|---|
| A7 Rep comment công khai | Page thật + token `pages_manage_engagement`: thử `POST /{post-id}/comments` và `POST /{comment-id}/comments`; xem changelog Graph API gần nhất |
| B10 Menu chat Zalo | OA thật + app test gọi `/v3.0/oa/menu/set|get`; fallback: cấu hình tay trên oa.zalo.me |
| B12 Zalo webhook retry | Thực nghiệm: endpoint trả 500/slow-response, đo số lần + chu kỳ Zalo gửi lại; endpoint dead 24h xem có bị ngừng nhận event |
| B16 Zalo rate limit | Đo thực tế khi app test (tăng dần load) + hỏi Zalo support bảng giới hạn theo gói OA |
| C3 J&T VN API | Email business J&T VN xin docs API đối tác + điều kiện ký |

---

## NGUỒN (lần audit 2026-10-05)

**Facebook/Messenger (trích nguyên văn được [A]):**
- https://developers.facebook.com/docs/messenger-platform/send-messages (24h window, messaging_type, 3 tag chết 27/04/2026 + lỗi 100, HUMAN_AGENT 7 ngày, mã lỗi)
- https://developers.facebook.com/docs/messenger-platform/send-messages/utility-messages (UTILITY, `page_utility_messaging`, duyệt template, cấm marketing)
- https://developers.facebook.com/docs/messenger-platform/marketing-messages (opt-in, 1/48h từ 01/09/2025, follow-up 3 tin/2 phút, dự định tính phí, hạn chế tích hợp mới)
- https://developers.facebook.com/docs/graph-api/webhooks/getting-started (retry 36h, dedupe, batch 1000, không đọc lịch sử)
- https://developers.facebook.com/docs/messenger-platform/webhooks (disable sau 1h fail, alert 15 phút, ACK 200/5s, danh sách field, `messaging_handovers`+`standby`)
- https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-pages (`feed`, `subscribed_apps`, permissions)
- https://developers.facebook.com/docs/messenger-platform/discovery/private-replies (1 tin, 7 ngày, 24h khi user đáp lại)
- https://developers.facebook.com/docs/messenger-platform/send-messages/persistent-menu (20 item/30 ký tự/1000 ký tự/10 call-10 phút)
- https://developers.facebook.com/docs/messenger-platform/overview/rate-limiting (200×EU, 300/s, 10/s, 2/s, 750/h, >40 tin/s)
- https://developers.facebook.com/docs/messenger-platform/policy/policy-overview (bot 30s, disclosure, cấm promo qua tag)
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messages (attachment types, `sticker_id`, chuyển đổi sticker)
- https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived (Page token không hạn, user 60 ngày)
- https://developers.facebook.com/docs/facebook-login/facebook-login-for-business (config_id, BISU, Advanced Access bắt buộc để phục vụ người ngoài)
- https://developers.facebook.com/docs/graph-api/reference/post/comments (Create hiển thị không khả dụng — căn cứ ô A7)
- https://developers.facebook.com/docs/graph-api/reference/page/messages (`one_time_notif_token`/`notification_messages_token`)

**Zalo OA ([B] — docs chính thức JS-rendered, đối chiếu SDK chính thức + index):**
- https://developers.zalo.me/docs/api/official-account-api/webhook/su-kien-nguoi-dung-giu-tin-nhan-post-3720 (user_send_* events)
- https://developers.zalo.me/docs/official-account/tin-nhan/tin-tu-van/gui-tin-tu-van-theo-mau-yeu-cau-thong-tin-nguoi-dung (`/v3.0/oa/message/cs`)
- https://developers.zalo.me/docs/official-account/quan-ly/quan-ly-thong-tin-oa/kiem-tra-han-muc-tin-nhan-oa (quota API)
- https://context7.com/websites/developers_zalo_me/llms.txt (index docs: `cs_reply {remain:8,total:8}`, `promotion {daily:1, monthly:6}`, `last_interaction`, `welcome_msg`, `user_withdraw`, `change_oa_daily_quota`)
- https://github.com/zaloplatform/zalo-java-sdk — `src/test/java/GetAccessTokenByRefreshToken.java` (endpoint + secret_key + refresh flow NGUYÊN VĂN) và `src/test/java/v3/GetQuotaCSFree.java` (quota endpoint)
- https://github.com/ (n8n-nodes-zalo-oa — 25h/3 tháng, khớp độc lập) + https://pouchy.ai (công thức `X-ZEvent-Signature`, khớp độc lập) + https://docs.cloudpro.vn (8 tin/48h, khớp độc lập)

**ĐVVC:**
- https://developer.ghn.vn/ (docs đầy đủ: Orders/Fees/Webhooks/Master Data/Token; sandbox `5sao.ghn.dev`; token từ `khachhang.ghn.vn`)
- https://api.ghtk.vn (OpenAPI: đăng đơn/trạng thái/tính phí/hủy/webhook; nhóm API doanh nghiệp)
- https://partner2.viettelpost.vn/ ("Partner ViettelPost - Open API"; endpoint `apis.viettelpost.vn`; docs đối tác không công khai hoàn toàn)
- https://jtexpress.vn (không có portal API công khai cho VN)

---
*Hết — file này là audit, không chứa code. 5 ô CHƯA XÁC MINH cần đóng trước khi build production (mục 6.3).*
