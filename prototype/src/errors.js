'use strict';
// errors.js — ERROR UX + TIMEZONE (SURI PHASE 1, hạng mục 5).
//
// (1) friendlyError: map lỗi KỸ THUẬT -> thông điệp tiếng Việt thân thiện cho khách/owner.
//     Server trả { userMessage } ra API; CHI TIẾT KỸ THUẬT (technical) CHỈ VÀO LOG
//     (console.error ở catch-all server) — KHÔNG đưa technical ra body (trừ error CODE ngắn).
// (2) Timezone mặc định Asia/Ho_Chi_Minh (GMT+7, KHÔNG có DST): helper fmtVnTime/vnOffsetIso
//     để follow-up/jobs hiển thị GIỜ VN. Scheduler vẫn lưu ISO UTC trong DB (chuẩn hoá),
//     chỉ lớp HIỂN THỊ quy đổi sang giờ VN.

const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';
const VN_OFFSET_MIN = 7 * 60; // GMT+7 cố định — Việt Nam không áp dụng daylight saving

// Bảng map: mã lỗi / pattern lỗi kỹ thuật -> thông điệp tiếng Việt.
// Thứ tự QUAN TRỌNG: match đầu tiên thắng — đặt pattern ĐẶC THÙ trước pattern TỔNG QUÁT.
const FRIENDLY_RULES = [
  // ---- kênh Facebook / Meta ----
  { re: /token_expired|META.*auth|facebook.*401|page_access_token|expired.*token/i, userMessage: 'Facebook hết phiên đăng nhập — chủ shop cần cập nhật lại Page access token trong phần Cài đặt.' },
  { re: /fb_window_closed/i, userMessage: 'Ngoài cửa sổ 24h Messenger — cần khách nhắn lại trước khi bot gửi tiếp.' },
  { re: /human_agent_spoofed/i, userMessage: 'Không gửi được: hội thoại không do nhân viên giữ nên không được gửi ngoài cửa sổ 24h.' },
  // ---- kênh Zalo ----
  { re: /zalo_quota_exhausted/i, userMessage: 'Hết quota tin nhắn Zalo cho khách này — chờ khách nhắn lại hoặc nhân viên xử lý.' },
  { re: /zalo_quota_low/i, userMessage: 'Quota Zalo sắp cạn — hệ thống chuyển nhân viên xử lý để tiết chế.' },
  { re: /ZALO.*(token|auth)|zalo.*401/i, userMessage: 'Zalo OA hết phiên đăng nhập — cần refresh access token.' },
  // ---- vận đơn / GHN ----
  { re: /GHN_NOT_CONFIGURED|ghn.*config/i, userMessage: 'Chưa cấu hình GHN — cần GHN token + shop id trước khi tạo vận đơn.' },
  { re: /create.*shipment.*fail|CREATE_SHIPMENT|shipment.*timeout|carrier_timeout|TIMEOUT_UNKNOWN/i, userMessage: 'Không tạo được vận đơn GHN — hệ thống đang chờ đối soát, nhân viên sẽ kiểm tra và báo lại.' },
  { re: /cancel_shipment|carrier_cancel/i, userMessage: 'Không huỷ được vận đơn với đơn vị vận chuyển — nhân viên sẽ xử lý thủ công và báo lại.' },
  { re: /OUT_OF_STOCK/i, userMessage: 'Sản phẩm vừa hết hàng — mình sẽ gợi ý sản phẩm thay thế còn hàng nha.' },
  { re: /PRICE_CHANGED/i, userMessage: 'Giá sản phẩm vừa được shop cập nhật — mình gửi lại tổng mới giúp anh/chị nhé.' },
  { re: /MISSING_FIELDS/i, userMessage: 'Chưa đủ thông tin đặt hàng (tên/SĐT/địa chỉ) — cần hỏi khách bổ sung.' },
  // ---- AI provider ----
  { re: /AI_NOT_CONFIGURED|MISSING_API_KEY/i, userMessage: 'AI chưa được cấu hình — thêm API key ở phần Cài đặt AI.' },
  { re: /deepseek|openai|chatcompletions|chat_completions|http_status_40[13]/i, userMessage: 'AI đang tạm gián đoạn — shop vẫn nhận tin nhắn, nhân viên sẽ trả lời thủ công trong lúc chờ.' },
  { re: /ai_error|ai_timeout|propose.*fail/i, userMessage: 'AI đang tạm gián đoạn — sẽ thử lại sau ít phút.' },
  // ---- gate / policy ----
  { re: /bot_off/i, userMessage: 'Bot đang tắt — không có tin tự động nào được gửi.' },
  { re: /takeover/i, userMessage: 'Hội thoại đang do nhân viên giữ — AI không tự trả lời.' },
  { re: /opt_out/i, userMessage: 'Khách đã từ chối nhận tin khuyến mại — chỉ gửi tin giao dịch/chính sách.' },
  { re: /bad_state/i, userMessage: 'Trạng thái hội thoại chưa phù hợp cho hành động này.' },
  // ---- dữ liệu ----
  { re: /NOT_FOUND|not_found|NO_SUCH/i, userMessage: 'Không tìm thấy dữ liệu tương ứng.' },
  { re: /VALIDATE|INVALID|BAD_/i, userMessage: 'Dữ liệu không hợp lệ — kiểm tra lại thông tin nhập.' },
];

// Map lỗi -> { userMessage, code }. KHÔNG BAO GIỜ đưa raw error message (có thể chứa
// token/URL nội bộ) vào userMessage — technical chỉ vào log phía caller.
function friendlyError(err) {
  const technical = String((err && err.message) || err || 'unknown_error');
  const code = String((err && err.code) || (err && err.error) || technical.split(':')[0] || 'INTERNAL_ERROR').slice(0, 120);
  for (const r of FRIENDLY_RULES) {
    if (r.re.test(technical) || r.re.test(code)) return { userMessage: r.userMessage, code, technical };
  }
  return { userMessage: 'Hệ thống đang bận chút, anh/chị thử lại giúp mình sau ít phút nha!', code, technical };
}

// ==== TIMEZONE ASIA/HO_CHI_MINH (GMT+7, không DST) ====

// ISO UTC -> chuỗi giờ VN 'YYYY-MM-DD HH:mm' (múi phút +7). Trả null nếu không parse được.
function vnWallClock(x) {
  const d = x instanceof Date ? x : new Date(x);
  if (!d || Number.isNaN(d.getTime())) return null;
  const shifted = new Date(d.getTime() + VN_OFFSET_MIN * 60 * 1000);
  return shifted.toISOString().replace('T', ' ').slice(0, 16);
}

// Hiển thị đầy đủ cho UI: '2026-10-06 14:30 (GMT+7 · Asia/Ho_Chi_Minh)'.
function fmtVnTime(x, timezone) {
  const wall = vnWallClock(x);
  if (!wall) return null;
  return `${wall} (GMT+7 · ${timezone || DEFAULT_TIMEZONE})`;
}

// Đổi mốc VN wall-clock ('2026-10-06 14:30') -> ISO UTC (khi owner nhập giờ VN vào form).
function vnWallClockToIso(s) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - VN_OFFSET_MIN * 60 * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

module.exports = {
  DEFAULT_TIMEZONE,
  friendlyError,
  FRIENDLY_RULES,
  vnWallClock,
  fmtVnTime,
  vnWallClockToIso,
  VN_OFFSET_MIN,
};
