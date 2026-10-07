'use strict';
// system-templates.js — BẢNG WHITELIST CỨNG cho mọi tin sender=system (P3A — đóng BL-8).
//
// Nguyên tắc (BAO-CAO-HOI-DONG-V2.md BL-8 + cr-R1 R3-4 / cr-R3 R2-2):
//   - actor=system KHÔNG ĐƯỢC gửi text tự do, dù caller là internal.
//   - Mỗi system send bắt buộc mang template_id TỒN TẠI trong bảng này; text phải là
//     kết quả render từ bảng (renderSystemTemplate), đúng `kind` và đúng `allowed_modes`.
//   - Tổ hợp actor=system + msgKind=ai_reply -> REJECT TUYỆT ĐỐI (system không phải kênh
//     giả danh AI; ai_reply chỉ dành cho actor=ai và bị khoá hoàn toàn trong mode HUMAN).
//   - Opt-out áp dụng đúng policy TRƯỚC khi xét template: system không phải kênh bypass
//     (marketing/care của system vẫn bị opt-out + takeover chặn ở tầng authorize).
//   - Audit bắt buộc ghi template_id + actor + mode + authorize_result (xem action-gate.authorize).
//
// Ghi chú phạm vi Gate A: ACK_DLQ được đăng ký whitelist và test trực tiếp ở tầng gate
// (test/gate-a.js A4); việc TỰ ĐỘNG bắn ACK_DLQ vào luồng DLQ (checkSendReceipt) thuộc
// closure BL-5/BL-7 — KHÔNG wiring ở vòng này để không đổi expectation case 11 hiện có.

const { renderVars } = require('./reply-markers'); // AICAKE (G4): biến {{TenKhachHang}} chuẩn aicake

const SYSTEM_TEMPLATES = {
  ASK_HUMAN_ACK: {
    kind: 'transactional',
    allowed_modes: ['AI', 'HUMAN'],
    text: 'Dạ em báo ngay nhân viên vào hỗ trợ mình nhé ạ!',
  },
  COMPLAINT_ACK: {
    kind: 'transactional',
    allowed_modes: ['AI', 'HUMAN'],
    text: 'Dạ shop thành thật xin lỗi anh/chị về trải nghiệm này ạ. Em đã báo ngay chủ shop vào xử lý, anh/chị cho shop vài phút để kiểm tra đơn và phản hồi nha ạ!',
  },
  OPT_OUT_ACK: {
    kind: 'transactional',
    allowed_modes: ['AI', 'HUMAN'],
    text: 'Dạ em đã lưu lại ý của mình, shop sẽ KHÔNG gửi tin quảng cáo cho mình nữa ạ. Tin về đơn hàng thì vẫn được gửi bình thường nha!',
  },
  FOLLOW_UP_MARKETING: {
    kind: 'marketing',
    allowed_modes: ['AI'],
    text: 'Dạ shop đang có chương trình mới, anh/chị xem thử nha ạ!',
  },
  FOLLOW_UP_CARE: {
    kind: 'care',
    allowed_modes: ['AI'],
    text: 'Dạ đơn anh/chị đã nhận được chưa ạ? Shop mong nhận được feedback của anh/chị nha ạ!',
  },
  ACK_DLQ: {
    kind: 'transactional',
    allowed_modes: ['AI', 'HUMAN'],
    // P3C/BL-1: utility_approved = template đã qua luồng duyệt Meta Utility (MOCK-APPROVED —
    // production: permission `page_utility_messaging` + template duyệt, matrix A13). Đây là
    // đường DUY NHẤT bot được phép gửi ngoài cửa sổ 24h; follow-up marketing/care KHÔNG thuộc
    // loại này (utility cấm marketing — matrix A13/A16).
    utility_approved: true,
    text: 'Dạ tin nhắn của mình đang được shop xử lý thủ công, sẽ có nhân viên phản hồi ngay ạ!',
  },
};

// P3C/BL-1: template nào thuộc luồng Utility Messages đã duyệt (mock-approved) — cho phép
// bot gửi NGOÀI cửa sổ 24h FB. Chỉ ACK_DLQ đủ điều kiện ở prototype (tin trạng thái xử lý);
// các template ACK phản hồi conversation luôn đi trong window (khách vừa nhắn).
function isUtilityApproved(templateId) {
  const tpl = SYSTEM_TEMPLATES[templateId];
  return !!(tpl && tpl.utility_approved);
}

// Render text CHÍNH THỨC từ bảng — nguồn duy nhất cho text của tin sender=system.
// Hỗ trợ biến {{ten_bien}} nếu template cần (hiện tại mọi template là text tĩnh).
// AICAKE (G4): biến {{TenKhachHang}} render qua renderVars (chuẩn aicake — fallback 'bạn'
// khi caller không truyền tên). Mọi template hiện tại là text tĩnh KHÔNG dùng biến nào nên
// đường này là NO-OP hôm nay — chỉ mở sẵn để template sau thêm biến không phải sửa caller.
function renderSystemTemplate(templateId, vars) {
  const tpl = SYSTEM_TEMPLATES[templateId];
  if (!tpl) return null;
  let text = tpl.text;
  for (const k of Object.keys(vars || {})) {
    text = text.split(`{{${k}}}`).join(String(vars[k]));
  }
  return renderVars(text, { tenKhachHang: vars ? vars.TenKhachHang : undefined });
}

module.exports = { SYSTEM_TEMPLATES, renderSystemTemplate, isUtilityApproved };
