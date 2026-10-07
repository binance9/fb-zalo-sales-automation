# AI1 — PLATFORM/API REVIEW: Messenger + Zalo OA

> Người viết: AI-1 (Platform/API reviewer) — ngày 2026-10-04.
> Phạm vi: kiến thức CHÍNH THỨC hiện tại của Facebook Messenger Platform và Zalo Official Account (OA) API, phục vụ hệ thống bán hàng tự động (Inbox + AI reply + comment automation). KHÔNG nghiên cứu private API/reverse.
> Phương pháp: đọc trực tiếp tài liệu chính thức (developers.facebook.com, developers.zalo.me/openapi.zalo.me). Lưu ý: docs Zalo render bằng JS nên một số nội dung được lấy qua bản index LLM của chính docs đó (context7.com/websites/developers_zalo_me) — nội dung trích dẫn là của docs chính thức, nhưng cần spot-check lại trực tiếp khi implement.
> Phân loại: `USE` / `ADAPT` / `REJECT` / `CHƯA XÁC MINH` theo quy ước trong `00-yeu-cau.md`.

---

## 1. MESSENGER PLATFORM (FACEBOOK)

### 1.1. Webhook nhận tin nhắn

**KẾT LUẬN**
- Webhook bắt buộc HTTPS (certificate hợp lệ, cấm self-signed). Setup: dashboard cấu hình endpoint → Meta gửi GET verification (`hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`) → echo lại `hub.challenge`, sai thì trả 403.
- Mọi event đều phải trả `200 OK` nhanh (docs webhooks nói trong 5s; docs App Review nói trong 20s — thiết kế an toàn: trả 200 ngay sau khi lưu raw payload, xử lý bất đồng bộ).
- Kiểm tra tính toàn vẹn bằng HMAC-SHA256 App Secret so với header `X-Hub-Signature-256`.
- Các field subscribe cho Messenger: `messages`, `messaging_postbacks` (Get Started / persistent menu / button), `messaging_referrals` (m.me link, ad), `message_deliveries`, `message_reads`, `message_echoes`, `message_edits`, `message_reactions`, `messaging_optins`, `messaging_account_linking`, `messaging_handovers` + `standby` (Handover Protocol), `messaging_policy_enforcement`, `messaging_feedback`, `send_cart`, `messenger_template_status_update`.
- Comment/bài đăng của Page KHÔNG nằm trong Messenger webhook — dùng Page webhook field `feed` (xem 1.6).
- Payload: `{object:"page", entry:[{id, time, messaging:[...]}]}`; mỗi event có `sender.id` (PSID), `recipient.id` (Page ID), `timestamp`. **Meta KHÔNG bảo đảm thứ tự khi retry** và không có API đọc lại webhook lịch sử → phải tự lưu raw payload.
- Gửi trùng (duplicate) là hành vi có thật (retry khi chưa nhận 200) → bắt buộc idempotency theo `message.mid` / event key (case test 10).
- Fail liên tục ~1 giờ → Meta disable webhook + tự un-subscribe; phải fix rồi subscribe lại.

**NGUỒN**
- https://developers.facebook.com/docs/messenger-platform/webhooks
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks.md
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events.md

**PHÂN LOẠI:** `USE` — dùng đúng cơ chế chính thức này cho Channel Gateway (FB).
**ẢNH HƯỞNG thiết kế:** Gateway phải: (1) verify signature + verify token; (2) trả 200 tức thì rồi mới xử lý; (3) bảng inbox raw_event có unique key = (field, sender, mid/timestamp-hash) để nuốt duplicate; (4) dùng `timestamp` để sort lại thứ tự hội thoại; (5) monitor cảnh báo "Webhooks Disabled".

### 1.2. Gửi tin — Send API, cửa sổ 24 giờ, message tags

**KẾT LUẬN**
- Endpoint: `POST /{PAGE_ID}/messages` với Page access token; bắt buộc `recipient` (PSID / user_ref / comment_id cho private reply), `messaging_type`, `message`.
- `messaging_type`: `RESPONSE` (trả lời trong 24h), `UPDATE` (proactive trong 24h), `MESSAGE_TAG` (ngoài 24h, đúng use case tag, CẤM nội dung khuyến mãi).
- **Cửa sổ 24 giờ** mở khi: user nhắn tin, bấm Get Started/CTA, click quảng cáo Click-to-Messenger, dùng plugin Send-to-Messenger/Checkbox, mở link m.me, thả reaction vào tin nhắn, **comment bài viết**, đăng visitor post. Trong 24h được gửi cả nội dung marketing; quá 24h chỉ còn các "escape hatch" dưới đây.
- **HUMAN_AGENT tag**: cho phép con người (không phải bot) trả lời trong **7 ngày** kể từ tin nhắn cuối của user — đúng cho quy trình HUMAN TAKEOVER của hệ thống. Nội dung phải là hỗ trợ thật, không phải promo.
- **⚠️ Thay đổi quan trọng 2026**: theo docs Send API hiện hành, kể từ **27/04/2026** các request dùng tag `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, `POST_PURCHASE_UPDATE` trả lỗi code 100 (đã bị khai tử). Các tag cũ kiểu SHIPPING_UPDATE, ISSUE_RESOLUTION… đã bị sunset từ trước.
- Kênh gửi ngoài 24h hiện hành: **Utility Messages** (messaging_type `UTILITY`, template có placeholder, phải được duyệt template, permission `page_utility_messaging`, cấm chứa nội dung marketing — dùng cho cập nhật đơn hàng/hẹn), **Marketing Messages** (paid, xem 1.3), **One-Time Notification** (token xin phép 1 lần, single-use, hạn ≤ 1 năm), **Sponsored Messages** (trả phí qua Ads).
- `messaging_type=MESSAGE_TAG` + tag HUMAN_AGENT chỉ dùng khi nhân viên thật đang xử lý → map thẳng vào state HUMAN_TAKEOVER.
- Lỗi hay gặp: 613 (rate limit), 10 (permission), 190 (token hết hạn), 551 (user blocked/unreachable), 1545041 (window đóng).

**NGUỒN**
- https://developers.facebook.com/docs/messenger-platform/send-messages
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/utility-messages.md
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy.md (policy-overview)

**PHÂN LOẠI:** `USE` cho 24h-window + HUMAN_AGENT; `ADAPT` cho Utility Messages (cần thiết kế template đơn hàng + luồng duyệt template); `REJECT` cho các tag cũ (ACCOUNT_UPDATE v.v. — đã chết theo docs).
**ẢNH HƯỞNG thiết kế:** Reply Policy phải có 3 nhánh: (a) còn 24h → gửi tự do; (b) quá 24h + đang human takeover → HUMAN_AGENT; (c) quá 24h + after-sales → Utility template (trạng thái đơn). Không được tự gửi marketing ngoài 24h (case 18). Clock 24h phải tính từ `timestamp` event cuối của user, lưu trong Customer Session.

### 1.3. Marketing Messages (tin marketing chủ động, có phí)

**KẾT LUẬN**
- Model mới cho marketing chủ động sau 24h: user phải **opt-in trở thành subscriber**; gửi qua API độc lập, **Meta tính phí theo tin** (pay per delivered message).
- Chỉ dành cho **tech provider** đã qua App Review với `ads_management`, `pages_messaging` và `paid_marketing_messages` / `marketing_messages_messenger`.
- Business phải nằm trong danh sách ~20 quốc gia được phép — **VIỆT NAM CÓ TRONG DANH SÁCH**; người nhận không được ở EU/JP/KR/AU/UK.
- Frequency cap: **1 tin marketing/Page/user/ngày** (+giới hạn 12h/90 ngày theo docs FAQ). Mỗi tin có link opt-out do Meta tự chèn — opt-out không có webhook thông báo. Recurring Notifications (cơ chế cũ) bị giới hạn rồi deprecated 10/02/2026.

**NGUỒN**
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/marketing-messages-on-messenger.md
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/marketing-messages-on-messenger/faq.md

**PHÂN LOẠI:** `ADAPT` — đúng luật chơi cho follow-up marketing, nhưng là tính năng trả phí + cần tech provider + opt-in; không dùng cho vận hành bán hàng cốt lõi.
**ẢNH HƯỞNG thiết kế:** Case 18 (từ chối marketing) trên Messenger: dừng hàng loạt tin marketing, nhưng vẫn nhắn được tin CS trong 24h; cần module opt-in/opt-out riêng trong CRM (Marketing Messages không push webhook opt-out → phải lưu trạng thái khi user bấm opt-out qua template hoặc hỏi trong chat).

### 1.4. Tin nhắn đa phương tiện (ảnh/voice/file)

**KẾT LUẬN**
- Webhook `messages` trả `message.attachments[]` với type `image` | `audio` | `video` | `file` | `sticker` | `fallback`…; media có `payload.url` để tải xuống. Sticker có `sticker_id` (Like = 369239263222822); từ 30/08/2026 chỉ còn type `sticker` (không còn song song `image`).
- Quick reply bấm có `message.quick_reply.payload`; reply để trích dẫn có `message.reply_to.mid`.
- Gửi ảnh/audio/video/file: attachment object `type` + `payload.url` (option `is_reusable:true`), hoặc dùng **Attachment Upload API** để upload 1 lần rồi tái sử dụng attachment_id.
- ⚠️ Docs không bảo đảm `payload.url` sống mãi (kinh nghiệm chung: URL có thể hết hạn) → phải tải về storage riêng ngay khi nhận.

**NGUỒN**
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messages.md
- https://developers.facebook.com/docs/messenger-platform/send-messages (phần Media & Attachments)

**PHÂN LOẠI:** `USE`; riêng "URL hết hạn" là `CHƯA XÁC MINH` (docs không nói rõ — cần kiểm chứng thực nghiệm: lưu URL 1 tuần rồi fetch lại).
**ẢNH HƯỞNG thiết kế:** Media Pipeline trong Gateway: nhận event → tải media về object storage nội bộ → đưa URL nội bộ (đã xác thực) cho AI hiểu ảnh/voice. Không truyền URL Meta vào prompt lâu dài.

### 1.5. Persistent Menu + Get Started (Messenger Profile)

**KẾT LUẬN**
- Messenger Profile API: `POST /me/messenger_profile` với Page token, permission `pages_messaging`, role Administrator trên Page.
- Get Started: `{get_started:{payload:"..."}}` → user bấm → nhận event `messaging_postbacks` (phải subscribe field này). Welcome screen chỉ hiện với người có role trên app khi app còn Standard Access.
- Persistent menu: `{persistent_menu:[{locale:"default", composer_input_disabled, call_to_actions:[...]}]}` — tối đa 20 item (docs hiện hành), title ≤ 30 ký tự, postback payload ≤ 1000 ký tự; bắt buộc phải có Get Started trước menu mới hiện; thay đổi Page-level có thể trễ tới 24h.
- Rate limit riêng: **10 call/10 phút/Page** cho Messenger Profile API.

**NGUỒN**
- https://developers.facebook.com/docs/messenger-platform/send-messages/persistent-menu
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/welcome-screen.md

**PHÂN LOẠI:** `USE`.
**ẢNH HƯỞNG thiết kế:** Onboarding mỗi shop: set Get Started payload (mã hóa intent "start") + menu (Xem sản phẩm / Đơn hàng của tôi / Gọi nhân viên / Bật-tắt tin marketing) → menu chính là nút opt-in/opt-out marketing thứ hai bên cạnh lệnh chat (case 18).

### 1.6. Comment automation (tự động trả lời comment)

**KẾT LUẬN**
- Nhận comment: Page webhook field **`feed`** (object `page`, không phải Messenger platform). Payload dạng `{item:"comment"|"post", verb:"add", comment_id, post_id, message, from, created_time}`. Docs khuyến nghị lấy comment_id từ webhook `feed` thay vì poll `/page/feed` để tránh rate limit. Subscribe field + cài app lên Page: `POST /{PAGE_ID}/subscribed_apps?subscribed_fields=feed` với Page token; permissions cần `pages_manage_metadata` + `pages_show_list` (và token của người có task CREATE_CONTENT/MANAGE/MODERATE).
- **Private Reply** (nhắn inbox cho người comment — kênh chính của automation bán hàng): `POST /{PAGE_ID}/messages` với `recipient:{comment_id}`. Giới hạn CHÍNH THỨC: **1 tin duy nhất cho 1 comment**, chỉ trong **7 ngày** kể từ lúc comment được tạo; cửa sổ 24h chỉ mở khi user TRẢ LỜI tin private reply. Không private-reply được cho Page khác. Cần `pages_messaging` + Page token của người có task MESSAGING.
- Trả lời công khai dưới comment: docs feed webhook chỉ dẫn `POST /{page-post-id}/comments` với `message`. Permission chính xác cho việc tạo comment (pages_manage_engagement) — `CHƯA XÁC MINH` (trang reference hiển thị lỗi khi fetch, cần xác minh lại).
- Policy: private reply phải liên quan comment, không được biến thành kênh spam; lạm dụng → restrictions.

**NGUỒN**
- https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-pages
- https://developers.facebook.com/docs/messenger-platform/discovery/private-replies
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/private-replies.md

**PHÂN LOẠI:** `USE` cho feed webhook + Private Reply; `CHƯA XÁC MINH` cho permission của public comment reply.
**ẢNH HƯỞNG thiết kế:** Luồng comment automation: `feed` event (comment chứa từ khóa giá/size…) → AI sinh private reply (1 tin duy nhất, phải chốt nội dung tốt vì chỉ nhắn được 1 lần) → kèm text công khai "Đã nhắn tin riêng ạ" (public reply, cần kiểm chứng permission). Nếu khách không trả lời private reply thì KHÔNG có cửa sổ 24h → mọi follow-up phải dừng.

### 1.7. Rate limits (Page-level)

**KẾT LUẬN (số liệu chính thức hiện hành)**
- Tổng: **200 × số Engaged Users / 24h** (rolling).
- Conversations API: 2 call/s/Page. Send API: **300 call/s/Page** (text/link/reaction/sticker), **10 call/s/Page** với audio/video. Private Replies API: **750 call/giờ/Page**.
- Spam throttle: gửi **> 40 tin/s** hoặc dồn nhiều hội thoại cùng lúc → Page Inbox bị chặn nhận tin mới cho tới khi hạ nhiệt (và API list conversations có thể fail).
- Lỗi 613 = rate limit exceeded (docs Send API); error 80001 = quá nhiều call lên Page.

**NGUỒN**
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview/rate-limiting.md
- https://developers.facebook.com/docs/messenger-platform/send-messages (Errors)

**PHÂN LOẠI:** `USE`.
**ẢNH HƯỞNG thiết kế:** Cần outbound message queue + token bucket theo Page (giữ tốc độ ≤ 40 msg/s an toàn, tốt nhất là thấp hơn nhiều), retry backoff khi 613/80001, và queue riêng cho private replies (750/giờ là trần cứng cho comment automation volume lớn).

### 1.8. Token (Page token, long-lived, exchange)

**KẾT LUẬN**
- Gọi Send API/webhook subscribe đều dùng **Page access token**. Page token tạo ra từ **long-lived User token** qua `GET /{user-id}/accounts` (hoặc /me/accounts) sẽ **KHÔNG có hạn** (chỉ mất khi user đổi mật khẩu/thu hồi quyền).
- Exchange short-lived → long-lived user token (~60 ngày): `GET /oauth/access_token?grant_type=fb_exchange_token&client_id=...&client_secret=...&fb_exchange_token=...` (gọi server-side, không lộ app secret).
- Với SaaS: **Facebook Login for Business** cho phép chọn token User hoặc **Business Integration System User (BISU)** — token mặc định không hết hạn, gắn với business portfolio của khách (xem mục 2).
- Mọi call Graph API từ server nên kèm `appsecret_proof` (HMAC app secret).

**NGUỒN**
- https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
- https://developers.facebook.com/docs/facebook-login/facebook-login-for-business

**PHÂN LOẠI:** `USE`.
**ẢNH HƯỞNG thiết kế:** Vault token: 1 long-lived Page token per shop, refresh/re-auth flow khi phát hiện lỗi 190. Token KHÔNG BAO GIỜ vào prompt AI — chỉ Gateway dùng (nguyên tắc vàng trong 00-yeu-cau.md).

### 1.9. App Review, dev mode, quyền cần duyệt

**KẾT LUẬN**
- **Standard Access (mặc định = dev mode)**: chỉ user có role trên app (admin/developer/tester) hoặc role trên Business mới dùng được → shop owner ngoài lũ KHÔNG thao tác được cho tới khi có Advanced Access.
- **Advanced Access** yêu cầu App Review; review chỉ cần khi app dùng bởi người ngoài app; docs Messenger Platform nói thẳng: "không cần App Review nếu chỉ gửi/nhắn tin cho Page của chính mình".
- Bộ permission chuẩn cho SaaS nhắn tin Page: `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, `pages_read_engagement`, `business_management` (docs cảnh báo `business_management` là dependency của `pages_messaging`, `pages_show_list` — phải khai báo trong submission). Instagram Messaging thêm `instagram_basic`, `instagram_manage_messages`.
- Điều kiện submission: Page đã publish, webhook thật trả 200 OK trong 20s, cho reviewer test được (tài khoản demo hoặc trigger phrase).
- **Business Verification** của business sở hữu app là điều kiện để phục vụ người không có role (xuất hiện như bước riêng kèm App Review).
- Reviewer test bot qua trigger phrase → cần có lệnh test riêng cho reviewer.

**NGUỒN**
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/app-review.md
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview.md
- https://developers.facebook.com/docs/resp-plat-initiatives/app-review

**PHÂN LOẠI:** `USE`.
**ẢNH HƯỞNG thiết kế:** Lộ trình 2 pha: (1) dev mode chỉ gắn Page của mình (không cần review) để chạy prototype; (2) trước khi bán: App Review + Business Verification, chuẩn bị screencast + trigger phrase ("test") + chính sách quyền riêng tư. Thời gian review không cam kết được → phải plan trước.

---

## 2. EMBEDDED SIGNUP / FACEBOOK LOGIN FOR BUSINESS (onboarding shop owner)

**KẾT LUẬN**
- Mục tiêu "shop owner kết nối Page mà không cần tự làm developer" đi bằng **Facebook Login for Business**: app kiểu Business định nghĩa **configuration** (config_id) chứa permissions + assets; owner login → cấp quyền Page cho app trong 1 lần; **không cho phép cấp một phần** (all-or-nothing).
- Token nhận về có thể là User token hoặc **BISU token** (không hết hạn, delegat­ed cho portfolio của khách, chỉ cho Tech Provider, web-only); quản lý token granular qua `/<CLIENT_BUSINESS_ID>/system_user_access_tokens` (cần `business_management` + `appsecret_proof`).
- **Embedded Signup đúng nghĩa** (iframe Meta hướng dẫn tạo business/page/token) là đặc quyền của **Tech Provider / Solution Partner** được Meta duyệt; bản **Hosted Embedded Signup** hiện tại chỉ onboarding được WhatsApp Cloud API (chưa phủ Messenger trong flow hosted); bản self-hosted v4 hỗ trợ WhatsApp + Messenger + Instagram. → Muốn trải nghiệm onboarding "aicake-style" cho Messenger cần nộp đơn vào chương trình Tech Provider.
- Điều kiện để phục vụ khách ngoài tổ chức mình: app ở chế độ live + **Advanced Access qua App Review** + Business Verification; khách (shop owner) không cần Business Verification riêng để cấp quyền Page qua Login for Business (chỉ cần quyền quản lý Page) — `CHƯA XÁC MINH` ở điểm khách có bị yêu cầu xác minh thêm không khi dùng Embedded Signup của Tech Provider.

**NGUỒN**
- https://developers.facebook.com/docs/facebook-login/facebook-login-for-business
- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/hosted-es
- https://developers.facebook.com/docs/messenger-platform/overview (Standard/Advanced Access)

**PHÂN LOẠI:** `USE` cho Facebook Login for Business (config_id + BISU token) — đây là lối onboarding không cần khách làm developer; `ADAPT` cho Embedded Signup (phải chờ duyệt Tech Provider; giai đoạn đầu dùng Login for Business là đủ); `CHƯA XÁC MINH`: yêu cầu xác minh phía khách trong Embedded Signup v4.
**ẢNH HƯỞNG thiết kế:** Settings → "Kết nối Facebook Page" = FB Login for Business với config chứa 5 permission ở 1.9; sau callback: lấy long-lived Page token qua /me/accounts, POST subscribed_apps (messages, messaging_postbacks, feed), set Get Started + persistent menu, ghi audit.

---

## 3. ZALO OA (OFFICIAL ACCOUNT API)

> Ghi chú nguồn: developers.zalo.me render JS; nội dung dưới lấy từ docs chính thức (trang webhook user_send đã fetch trực tiếp được) và bản index của chính docs đó (context7.com/websites/developers_zalo_me — llms.txt). Khi implement cần spot-check trực tiếp từng endpoint.

### 3.1. Loại OA & điều kiện

**KẾT LUẬN**
- OA có trạng thái **chưa xác minh / đã xác minh** (xác thực qua oa.zalo.me/manage với giấy tờ DN/hộ kinh doanh); OA đã xác minh có nhãn xanh, độ tin cậy và quyền hạn cao hơn. Đây là thông tin thương mại/vận hành, docs API không liệt kê số liệu quota theo từng gói (dùng thử/chuyên nghiệp) → `CHƯA XÁC MINH` về con số quota free từng gói.
- Quota trong API chia theo loại: `reply` (CS trả lời trong 48h), `welcome_msg`, `sub_quota` (gói dịch vụ OA), `purchase_quota` (mua lẻ), `reward_quota` (khuyến mãi), `promotion` (tin chủ động theo user, ngày/tháng).

**NGUỒN**
- https://developers.zalo.me/docs/api/official-account-api-230 (tổng quan OA OpenAPI)
- https://context7.com/websites/developers_zalo_me/llms.txt (index docs chính thức — quota/message)
- Xác thực OA: hướng dẫn tại oa.zalo.me/manage (không có trang API chính thức public được index)

**PHÂN LOẠI:** `CHƯA XÁC MINH` về số quota từng gói OA — cần xác minh bằng: đăng ký OA thật + gọi `POST /v3.0/oa/quota/message` xem số liệu free và hỏi Zalo sales về bảng gói hiện hành.
**ẢNH HƯỞNG thiết kế:** Gateway phải đọc quota ĐỘNG qua API (không hardcode số gói), hiển thị quota còn lại trong Dashboard Settings.

### 3.2. Webhook Zalo OA

**KẾT LUẬN**
- Zalo đẩy HTTP POST JSON tới URL đã đăng ký. Chữ ký xác thực: header `X-ZEvent-Signature` = `sha256(appId + data + timeStamp + OAsecretKey)` (data = JSON body) — bắt buộc verify ở Gateway.
- Sự kiện tin nhắn user gửi: `user_send_text`, `user_send_image`, `user_send_sticker`, `user_send_gif`, `user_send_audio` (voice, file .amr), `user_send_video`, `user_send_file`, `user_send_link`, `user_send_location`, `user_send_custom`. Cấu trúc chung: `event_name`, `sender` (follower id), `message` (+ `msg_id`), media nằm trong `attachments[{type,payload}]`.
- Payload media: image (url + thumbnail), audio (.amr url), sticker (id + url), gif (url + thumbnail), video (url + thumbnail), file (size, name, checksum, type, url), location (coordinates), link (url + description + thumbnail). **URL của Zalo có hạn dùng → phải tải về ngay.**
- Sự kiện khác quan trọng: `follow`/`unfollow`, `user_seen_message`, `user_reacted_message`, `user_click_chatnow` (bấm nút Chat Ngay — cho phép OA chủ động nhắn), `user_withdraw` (user rút sự đồng ý xử lý dữ liệu), `change_oa_daily_quota` (quota OA thay đổi), các sự kiện group (`user_send_group_text`...) và `anonymous_send_*` (khách chat ẩn danh từ website plugin).

**NGUỒN**
- https://developers.zalo.me/docs/api/official-account-api/webhook/su-kien-nguoi-dung-gui-tin-nhan-post-3720
- https://developers.zalo.me/docs/official-account/webhook/tong-quan
- https://context7.com/websites/developers_zalo_me/llms.txt (payload follow / signature / chatnow / withdraw)

**PHÂN LOẠI:** `USE`. `CHƯA XÁC MINH`: retry policy của Zalo webhook (docs index chưa thấy cam kết retry/idempotent) — cần kiểm chứng thực nghiệm.
**ẢNH HƯỞNG thiết kế:** Channel Gateway nhận Zalo: verify `X-ZEvent-Signature`, idempotency theo `msg_id` (case 10), tải media về storage (voice .amr phải convert sang WAV/MP3 trước khi đưa ASR — case 4), `unfollow` + `user_withdraw` phải tắt ngay mọi automation cho user đó (case 18).

### 3.3. Gửi tin + quota Zalo

**KẾT LUẬN**
- Gửi tin CS (chăm sóc/tư vấn): `POST https://openapi.zalo.me/v3.0/oa/message/cs` — `recipient:{user_id}` + `message` (text, media, file, template `request_user_info`…). Response kèm object `quota` cho biết loại quota bị trừ.
- **Ràng buộc CS cốt lõi**: mỗi follower có **8 tin CS / 48 giờ** kể từ lần tương tác cuối (response dạng `"quota_type":"reply","remain":8,"total":8`; API `POST /v3.0/oa/quota/message` trả `cs_reply:{remain,total}` kèm `last_interaction`; SDK có `getQuotaCSMessageIn48h`). Khi hết → không gửi được CS nữa.
- Tin chủ động (không do user nhắn trước): loại `promotion` — giới hạn **theo từng user: 1 tin/ngày và 6 tin/tháng** (giá trị trong docs API; có thể theo gói OA). Tin chào mừng: quota riêng (`welcome_msg` total 3 trong ví dụ docs). Tin broadcast hàng loạt có targeting (tuổi/giới/tỉnh) qua `/v2.0/oa/message`; tin giao dịch (`transaction`) dùng `purchase_quota`/`sub_quota`.
- Kiểm tra quota: `POST /v3.0/oa/quota/message` (body `quota_owner`, `product_type` = `cs`|`transaction`, `quota_type`); webhook `change_oa_daily_quota` báo biến động quota ngày.

**NGUỒN**
- https://developers.zalo.me/docs/api/official-account-api/api/gui-tin-nhan-post-2343
- https://context7.com/websites/developers_zalo_me/llms.txt (oa/message/cs, oa/quota/message, quota types)

**PHÂN LOẠI:** `USE`; con số 8/48h và promotion 1/ngày-6/tháng: `USE` kèm cảnh báo "đọc động từ API, không hardcode" (có thể đổi theo gói) — đánh dấu lại khi có hóa đơn/gói thật.
**ẢNH HƯỞNG thiết kế:** Reply Policy Zalo PHẢI kiểm tra `cs_reply.remain` trước khi auto-send; khi `remain` thấp → dừng auto, chuyển human. AI KHÔNG được phung phí quota (mỗi lượt hỏi sản phẩm chỉ gom tối đa vài tin). Follow-up sau bán (case 17) trên Zalo phải nằm trong 48h hoặc tiêu promotion quota (có kế hoạch ngân sách tin/ngày/tháng per user).

### 3.4. Token OA

**KẾT LUẬN**
- Lấy token: `POST https://oauth.zaloapp.com/v4/oa/access_token` với header `secret_key`; body `code` + `app_id` + `grant_type=authorization_code` (+ `code_verifier` nếu có PKCE).
- **Access token chỉ sống 25 giờ** (`expires_in ≈ 90000`); **refresh token sống 3 tháng**; refresh cùng endpoint với `grant_type=refresh_token` → trả access_token + refresh_token MỚI (refresh token xoay vòng — phải lưu đè). Có hỗ trợ DPoP (refresh bằng DPoP phải dùng cùng key pair).
- Token user Zalo (social) khác: `/v4/access_token`, 1 giờ + refresh 30 ngày.

**NGUỒN**
- https://context7.com/websites/developers_zalo_me/llms.txt (oauth /v4/oa/access_token)
- https://developers.zalo.me/docs/api/official-account-api-230

**PHÂN LOẠI:** `USE`.
**ẢNH HƯỞNG thiết kế:** Token Service Zalo: cron refresh TRƯỚC 25h (ví dụ mỗi 12h), lưu cả 2 token mới ngay khi refresh (rotation), alarm khi refresh fail > 2 lần; token trong Vault, không vào prompt.

### 3.5. Follower cần gì để bot nhắn được

**KẾT LUẬN**
- Bot (OA) chỉ nhắn được khi user đã **follow hoặc tương tác** (nhắn tin, bấm Chat Ngay — event `user_click_chatnow` mở cửa nhắn chủ động). Đối tượng nhận tin là `user_id` (follower id) trong webhook.
- Sau tương tác: được gửi tối đa 8 tin CS/48h (3.3); ngoài ra còn welcome message và promotion theo quota.

**NGUỒN**
- https://developers.zalo.me/docs/api/official-account-api/api/gui-tin-nhan-post-2343
- https://context7.com/websites/developers_zalo_me/llms.txt (user_click_chatnow, cs_reply)

**PHÂN LOẠI:** `USE`.
**ẢNH HƯỞNG thiết kế:** Customer Session Zalo lưu `last_interaction` (đến từ quota API) + đếm tin đã gửi/48h — điều kiện tiên quyết của Reply Gate.

### 3.6. Zalo Cloud / Message Queue?

**KẾT LUẬN**
- Không có dịch vụ chính thức "Zalo Message Queue" trong docs API công khai; các dịch vụ "Zalo Cloud" (eTelecom, Infobip…) là **bên thứ ba** bao quanh OA API/ZNS. Hệ thống này chỉ nên gọi trực tiếp OpenAPI chính thức của Zalo.

**NGUỒN**
- https://developers.zalo.me/docs (index chính thức — không thấy MQ)
- https://docs.etelecom.vn/api-etelecom-english/api-integration/zalo-cloud/instructions-for-connecting-zalo-cloud (bên thứ ba)

**PHÂN LOẠI:** `REJECT` (dùng reseller/private gateway cho phase này).
**ẢNH HƯỞNG thiết kế:** Tự xây outbound queue nội bộ (đã có ở 1.7) thay vì phụ thuộc bên thứ ba; nếu sau này cần ZNS marketing thì cân nhắc lại.

### 3.7. Chính sách spam / opt-out Zalo

**KẾT LUẬN**
- Cơ chế "spam control" của Zalo chính là **quota cứng** (8/48h CS, promotion 1 ngày/6 tháng per user) + sự kiện `user_withdraw` (rút quyền xử lý dữ liệu) + `unfollow`. Docs API public không thấy văn bản "chính sách spam" dạng prose → `CHƯA XÁC MINH` nội dung văn bản chính sách đầy đủ (cần đọc điều khoản dịch vụ OA khi đăng ký).

**NGUỒN**
- https://developers.zalo.me/docs/api/official-account-api/api/gui-tin-nhan-post-2343
- https://context7.com/websites/developers_zalo_me/llms.txt (user_withdraw)

**PHÂN LOẠI:** `CHƯA XÁC MINH` (văn bản chính sách đầy đủ).
**ẢNH HƯỞNG thiết kế:** Xử lý `user_withdraw`/`unfollow` = xóa/khóa liên hệ khỏi mọi automation NGAY (audit lại). Tự đặt giới hạn mềm (max N tin liên tiếp không được trả lời) phía mình.

---

## 4. CHÍNH SÁCH NỀN TẢNG TỔNG HỢP (điều kiện DỪNG automation)

**KẾT LUẬN — Messenger (policy overview chính thức)**
- Bot "automated" phải phản hồi mọi input trong **30 giây** (vi phạm → cảnh báo tới admin, không sửa trong 7 ngày → bị giới hạn khả năng gửi tin).
- Phải công khai trạng thái bot khi luật yêu cầu (California, Đức) — nói với user họ đang nói chuyện với bot khi bắt đầu/tiếp quản lại từ người.
- Cấm dùng message tags cho nội dung khuyến mãi; lạm dụng tag → restrictions.
- Private reply: 1 tin/comment, trong 7 ngày.
- User chặn/mute bất cứ lúc nào = opt-out; Marketing Messages có link opt-out do Meta chèn (không có webhook báo opt-out).
- Enforcement qua Page Support Inbox; lỗi policy gửi email cho admin.

**KẾT LUẬN — Comment automation được phép gì**
- Được phép: tự nhận comment qua webhook `feed`, trả lời công khai dưới comment, và/private reply 1 tin (đúng điều kiện 1.6), sau đó hội thoại tiếp diễn trong inbox như bình thường.
- Không được phép: private reply > 1 tin/comment, private reply sau 7 ngày, gửi marketing bằng tag, automation tiếp diễn sau khi user từ chối.

**Case nào bị khóa page/app (evidence chính thức):** gửi tin ngoài window/tag sai mục đích lặp lại → messaging restrictions; bot không responsive → hạn chế gửi tin; vi phạm Community Standards/policy → webhooks disabled, app review từ chối. Con số "bao nhiêu lần thì khóa vĩnh viễn" không có trên docs → `CHƯA XÁC MINH`.

**NGUỒN**
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy.md
- https://developers.facebook.com/docs/messenger-platform/policy/policy-overview

**PHÂN LOẠI:** `USE` (áp làm rào chắn cứng); `CHƯA XÁC MINH` (ngưỡng khóa chính xác).
**ẢNH HƯỞNG thiết kế:** Automation Engine phải có "kill-switch" per channel + per user: opt-out (case 18), unfollow/withdraw (Zalo), block (error 551), quota cạn (Zalo cs_reply=0), window đóng (Messenger) — tất cả ghi audit trước khi tắt.

---

## 5. BẢNG TÓM TẮT — 15 KẾT LUẬN QUAN TRỌNG NHẤT

| # | Kết luận | Phân loại | Ảnh hưởng thiết kế |
|---|---|---|---|
| 1 | Messenger chỉ gửi tự do trong **24h** từ tương tác cuối user; ngoài 24h: HUMAN_AGENT (7 ngày, do người thật gửi), Utility template (đơn hàng, cấm marketing), Marketing Messages (trả phí, opt-in) | USE | Reply Policy 3 nhánh theo window; lưu last-interaction timestamp per PSID |
| 2 | Tag ACCOUNT_UPDATE/CONFIRMED_EVENT_UPDATE/POST_PURCHASE_UPDATE trả lỗi 100 từ 27/04/2026 → after-sales phải dùng **Utility Messages** (template duyệt, `page_utility_messaging`) | ADAPT | Thiết kế template trạng thái đơn + luồng duyệt template |
| 3 | Comment automation: webhook field `feed` (Page object) + **Private Reply 1 tin/comment trong 7 ngày**; 24h chỉ mở khi user đáp lại | USE | Auto-reply comment phải chốt 1 tin duy nhất; sau đó dừng nếu không có phản hồi |
| 4 | Webhook Meta: retry KHÔNG bảo đảm thứ tự, duplicate có thật; fail 1h → disable webhook | USE | Idempotency theo mid; sort theo timestamp; monitor disable |
| 5 | Rate limit Messenger: 200×engaged users/24h; Send 300/s (text) 10/s (media); Private Reply 750/giờ/Page; spam >40 tin/s chặn inbox | USE | Outbound queue + token bucket per Page; queue riêng private reply |
| 6 | Token: long-lived Page token **không hết hạn** (lấy qua long-lived user token + /me/accounts); token user ~60 ngày | USE | Vault token per shop; flow re-auth khi lỗi 190 |
| 7 | Dev mode (Standard Access) chỉ nhắn được với người có role trên app; phục vụ khách ngoài → App Review + Business Verification + Advanced Access (`pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, `pages_show_list`, `business_management`) | USE | Pha 1 prototype dev mode; pha 2 chuẩn bị App Review sớm (webhook 200/20s + trigger phrase) |
| 8 | Onboarding shop owner KHÔNG cần khách làm developer: **Facebook Login for Business** (config_id, BISU token không hết hạn); Embedded Signup đủ mạnh chỉ khi được duyệt **Tech Provider** | USE (FLB) / ADAPT (ES) | Flow "Kết nối Page" = FLB config; roadmap nộp Tech Provider khi cần trải nghiệm aicake |
| 9 | Zalo webhook: verify `X-ZEvent-Signature` = sha256(appId+data+timeStamp+OAsecretKey); events `user_send_text/image/audio/sticker/gif/video/file/link/location`, `follow/unfollow`, `user_withdraw`, `change_oa_daily_quota` | USE | Gateway Zalo verify signature; unfollow/withdraw = tắt automation ngay |
| 10 | Voice Zalo nhận dạng URL file **.amr** (không có duration) — phải tải về + convert trước ASR | USE | Media pipeline: amr→wav; lưu storage riêng vì URL Zalo có hạn |
| 11 | Zalo CS: **8 tin/48h per user** (cs_reply); promotion **1 tin/ngày, 6 tin/tháng** per user; quota đọc động qua `POST /v3.0/oa/quota/message` | USE | Reply Gate Zalo kiểm tra remain trước khi gửi; ngân sách tin per user; không hardcode số gói |
| 12 | Token OA Zalo: access 25h, refresh 3 tháng, refresh token XOAY VÒNG (`/v4/oa/access_token`, header secret_key) | USE | Token service refresh mỗi 12h, lưu đè cặp token mới, alarm khi fail |
| 13 | Opt-out (case 18): Messenger = user block/mute hoặc link opt-out Meta (không webhook); Zalo = unfollow/`user_withdraw`; automation PHẢI dừng theo chính sách nền tảng | USE | Kill-switch per user + audit; trạng thái opt-out trong CRM |
| 14 | Bot Messenger phải phản hồi trong **30s** và công khai là bot theo luật một số vùng | USE | SLA gateway < 30s; disclosure message đầu phiên khi cần |
| 15 | Con số quota theo gói OA Zalo (dùng thử/chuyên nghiệp) & ngưỡng khóa page/app của Meta: không có trên docs chính thức | CHƯA XÁC MINH | Cần: OA thật để gọi quota API; hỏi Zalo sales bảng gói; theo dõi Support Inbox Meta; kiểm chứng URL media hết hạn + permission public-comment-reply (`pages_manage_engagement`) |

---
*Hết — file này chỉ nghiên cứu, không chứa code. Các mục `CHƯA XÁC MINH` cần đóng trước khi vào giai đoạn build production.*
