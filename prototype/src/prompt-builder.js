'use strict';
// prompt-builder.js — buildSystemPrompt theo FORM CẤU HÌNH shop (PHASE PRODUCT-READY).
//
// Config (form Cài đặt AI):
//   { giongNoi, cachXungHo, chinhSachDoiTra, gioLamViec,
//     faq: [{q, a}], khongDuocNoi: [..], uuTienBan, ngonNgu, quyTacChotDon }
//
// RÀNG BUỘC (đúng nguyên tắc vàng + P3A):
//   - KHÔNG phá PII strip / FACTS: prompt chỉ là CHỈ DẪN giọng nói; mọi giá/tồn/SKU vẫn PHẢI
//     lấy từ FACTS do code dựng từ ProductDB. Prompt không được chứa secret (sk-/token/...)
//     — validatePromptConfig chặn LƯU khi phát hiện pattern secret trong bất kỳ field nào.
//   - buildSystemPrompt là HÀM THUẦN (config -> string), không đụng store/DB.

const SECRET_VALUE_RE = /sk-[A-Za-z0-9]|secret|token|passwd|password|api[_-]?key|bearer\s+[a-z0-9]/i;

// Chặn lưu khi phát hiện pattern secret trong GIÁ TRỊ field (đề bài: cấm sk-/token vào prompt).
function validatePromptConfig(cfg) {
  const errors = [];
  const scan = (label, v) => {
    if (v === undefined || v === null) return;
    const s = Array.isArray(v) ? v.map(String).join(' | ') : String(v);
    if (SECRET_VALUE_RE.test(s)) errors.push(`${label}: chứa pattern secret (sk-/token/secret/password/api-key) — cấm đưa vào prompt`);
  };
  scan('giongNoi', cfg && cfg.giongNoi);
  scan('cachXungHo', cfg && cfg.cachXungHo);
  scan('chinhSachDoiTra', cfg && cfg.chinhSachDoiTra);
  scan('gioLamViec', cfg && cfg.gioLamViec);
  scan('uuTienBan', cfg && cfg.uuTienBan);
  scan('ngonNgu', cfg && cfg.ngonNgu);
  scan('quyTacChotDon', cfg && cfg.quyTacChotDon);
  // SURI P1 (hạng mục 3): các field mới từ hồ sơ shop — cùng luật cấm secret.
  scan('ten', cfg && cfg.ten);
  scan('logo', cfg && cfg.logo);
  scan('linhVuc', cfg && cfg.linhVuc);
  scan('diaChi', cfg && cfg.diaChi);
  scan('hotline', cfg && cfg.hotline);
  scan('quyTacTuVan', cfg && cfg.quyTacTuVan);
  scan('chinhSachGiaoHang', cfg && cfg.chinhSachGiaoHang);
  scan('cta', cfg && cfg.cta);
  if (cfg && Array.isArray(cfg.thongTinCamNoi)) scan('thongTinCamNoi', cfg.thongTinCamNoi);
  if (cfg && Array.isArray(cfg.khongDuocNoi)) scan('khongDuocNoi', cfg.khongDuocNoi);
  if (cfg && Array.isArray(cfg.faq)) {
    cfg.faq.forEach((f, i) => { scan(`faq[${i}].q`, f && f.q); scan(`faq[${i}].a`, f && f.a); });
  }
  return { ok: errors.length === 0, errors };
}

const GOLDEN_RULES = [
  'NGUYÊN TẮC VÀNG: LLM KHÔNG phải nguồn sự thật.',
  '- Giá, tồn kho, SKU, khuyến mại, phí ship, trạng thái đơn, chính sách: CHỈ dùng số liệu trong FACTS do hệ thống cung cấp từ ProductDB/đơn hàng.',
  '- KHÔNG TỰ BỊA số tiền, tồn kho, thuộc tính sản phẩm, thời gian giao hàng.',
  '- KHÔNG hỏi/nhắc lại thông tin cá nhân nhạy cảm không cần thiết; KHÔNG bao giờ đọc lại SĐT/địa chỉ đầy đủ trong câu trả lời.',
  '- Không đủ dữ liệu -> nói với khách sẽ chuyển nhân viên tư vấn (NEEDS_HUMAN), KHÔNG đoán.',
];

function buildSystemPrompt(cfg) {
  const c = cfg || {};
  const lines = [];
  // SURI P1 (hạng mục 3): hồ sơ shop — TEN/linhVuc/diaChi/hotline đứng ĐẦU prompt (giới thiệu shop).
  if (c.ten || c.linhVuc || c.diaChi || c.hotline) {
    const info = [
      c.ten ? `Tên shop: ${c.ten}` : null,
      c.linhVuc ? `Lĩnh vực: ${c.linhVuc}` : null,
      c.diaChi ? `Địa chỉ: ${c.diaChi}` : null,
      c.hotline ? `Hotline: ${c.hotline}` : null,
    ].filter(Boolean).join(' · ');
    lines.push(`## HỒ SƠ SHOP\n${info}`);
    lines.push('');
  }
  lines.push('Bạn là trợ lý bán hàng của shop, trả lời trên Messenger/Zalo.');
  lines.push('');
  lines.push('## QUY TẮC BẮT BUỘC (không được vi phạm)');
  for (const r of GOLDEN_RULES) lines.push(r);
  lines.push('');
  if (c.ngonNgu) lines.push(`## NGÔN NGỮ TRẢ LỜI\n${c.ngonNgu}`);
  if (c.giongNoi) lines.push(`## GIỌN NÓI\n${c.giongNoi}`);
  if (c.cachXungHo) lines.push(`## CÁCH XƯNG HÔ\n${c.cachXungHo}`);
  if (c.uuTienBan) lines.push(`## SẢN PHẨM ƯU TIÊN BÁN\n${c.uuTienBan}`);
  if (c.chinhSachDoiTra) lines.push(`## CHÍNH SÁCH ĐỔI TRẢ\n${c.chinhSachDoiTra}`);
  if (c.gioLamViec) lines.push(`## GIỜ LÀM VIỆC\n${c.gioLamViec}`);
  if (c.quyTacChotDon) lines.push(`## QUY TẮC CHỐT ĐƠN\n${c.quyTacChotDon}`);
  // SURI P1: các mục mới từ hồ sơ shop (additive — prompt cũ không đổi khi không cấu hình).
  if (c.quyTacTuVan) lines.push(`## QUY TẮC TƯ VẤN\n${c.quyTacTuVan}`);
  if (c.chinhSachGiaoHang) lines.push(`## CHÍNH SÁCH GIAO HÀNG\n${c.chinhSachGiaoHang}`);
  if (Array.isArray(c.thongTinCamNoi) && c.thongTinCamNoi.length) {
    lines.push('## THÔNG TIN CẦM NÓI (dùng khi khách hỏi, KHÔNG tự bịa)');
    for (const t of c.thongTinCamNoi) lines.push(`- ${t}`);
  }
  if (c.cta) lines.push(`## CTA KẾT THÚC\n${c.cta}`);
  if (Array.isArray(c.faq) && c.faq.length) {
    lines.push('## FAQ CỦA SHOP');
    for (const f of c.faq) {
      if (f && (f.q || f.a)) lines.push(`- Hỏi: ${f.q || ''}\n  Trả: ${f.a || ''}`);
    }
  }
  if (Array.isArray(c.khongDuocNoi) && c.khongDuocNoi.length) {
    lines.push('## TUYỆT ĐỐI KHÔNG NÓI');
    for (const k of c.khongDuocNoi) lines.push(`- ${k}`);
  }
  return lines.filter(l => l !== '').join('\n');
}

module.exports = { buildSystemPrompt, validatePromptConfig, SECRET_VALUE_RE, GOLDEN_RULES };
