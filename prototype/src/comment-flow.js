'use strict';
// comment-flow.js — TỰ ĐỘNG COMMENT & INBOX (chuẩn aicake.vn — gap G2).
//
// Chuẩn aicake: "Tự động trả lời bình luận trên bài đăng, ẩn comment tiêu cực và inbox
// khách từ comment" — reply comment dùng biến {{TenKhachHang}} thay bằng tên khách.
//
// File này là CẤU PHẦN THUẦN (không đụng store/gate): pipeline gọi khi event có
// origin === 'comment' (meta-adapter normalize feed event). Mọi REPLY thực tế vẫn do
// pipeline đẩy qua ACTION GATE như tin thường — hàm ở đây chỉ PHÂN LOẠI + SOẠN CÂU.
//
// Nguyên tắc số liệu: classify KHÔNG bịa gì; câu reply courtesy không chứa giá/tồn —
// giá/tồn CHỈ đi qua luồng tư vấn hiện có (sales-ai FACTS từ product-db).

const { normKey } = require('./util');

// ============================================================ CẤU HÌNH TỪ KHOÁ
// Từ khoá TIÊU CỰC (VI/EN) — so trên normKey (đã bỏ dấu + lowercase). Mảng config,
// THÊM TỪ MỚI chỉ cần push vào đây (từ nhiều chữ cách nhau bằng khoảng trắng).
const NEGATIVE_WORDS = [
  'lua dao',        // lừa đảo
  'scam',
  'kem chat luong', // kém chất lượng
  'hang fake',      // hàng fake
  'fake',
  'hang gia',       // hàng giả
  'khong tot',      // không tốt
  'che',            // chê
  'te',             // tệ
  'that vong',      // thất vọng
  'bad',
  'worst',
];

// Từ khoá Ý ĐỊNH MUA (buy_intent) — comment kiểu "giá bao nhiêu / còn hàng / lấy 1 cái...".
const BUY_INTENT_WORDS = [
  'gia bao nhieu',  // giá bao nhiêu
  'bao nhieu',
  'con hang',       // còn hàng
  'con khong',      // còn không (hỏi tồn)
  'mua',
  'dat hang',       // đặt hàng
  'dat',            // đặt
  'chot',           // chốt
  'size',
  'mau',            // màu
  'shipping',
  'ship',
  'gia',            // giá
];

// Từ khoá CÂU HỎI (tone question) — không rơi vào tiêu cực mà đang hỏi thông tin.
const QUESTION_WORDS = [
  'bao nhieu',
  'con khong',
  'co khong',
  'the nao',        // thế nào
  'sao',            // vì sao / làm sao
  'gi vay',         // gì vậy
  'gi the',         // gì thế
  'cach',           // cách
  'khi nao',        // khi nào
  'o dau',          // ở đâu
  'link',
];

// Từ khoá TÍCH CỰC (tone positive) — khen/sản phẩm hấp dẫn.
const POSITIVE_WORDS = [
  'tuyet',          // tuyệt
  'dep',            // đẹp
  'thich',          // thích
  'xinh',           // xinh
  'ung',            // ưng
  'hay',
  'good',
  'great',
  'love',
];

function wordRes(words) {
  return words.map(w => new RegExp(`\\b${String(w).trim().split(/\s+/).join('\\s+')}\\b`, 'i'));
}
const NEGATIVE_RES = wordRes(NEGATIVE_WORDS);
const BUY_RES = wordRes(BUY_INTENT_WORDS);
const QUESTION_RES = wordRes(QUESTION_WORDS);
const POSITIVE_RES = wordRes(POSITIVE_WORDS);

// ============================================================ PHÂN LOẠI COMMENT
// classifyComment(text, { productMatched }) ->
//   { tone: 'positive'|'negative'|'question'|'other', buy_intent: bool }
// Tiêu cực ƯU TIÊU CAO NHẤT (comment chê kèm hỏi giá vẫn là tiêu cực).
// buy_intent: từ khoá mua/hiếm hỏi giá, hoặc comment khớp SẢN PHẨM trong DB (caller truyền).
function classifyComment(text, opts = {}) {
  const t = normKey(text);
  const negative = NEGATIVE_RES.some(r => r.test(t));
  const productMatched = !!(opts && opts.productMatched);
  const buyIntent = !negative && (BUY_RES.some(r => r.test(t)) || productMatched);
  let tone;
  if (negative) tone = 'negative';
  else if (QUESTION_RES.some(r => r.test(t)) || /\?\s*$/.test(String(text || '').trim())) tone = 'question';
  else if (POSITIVE_RES.some(r => r.test(t))) tone = 'positive';
  else tone = 'other';
  return { tone, buy_intent: buyIntent };
}

// ============================================================ BIẾN {{TenKhachHang}}
// Chuẩn aicake: reply comment dùng biến {{TenKhachHang}} — thay bằng tên khách,
// fallback "bạn" khi chưa biết tên.
function renderCustomerName(name) {
  const s = String(name === undefined || name === null ? '' : name).trim();
  return s || 'bạn';
}

function replaceTenKhachHang(text, name) {
  return String(text || '').split('{{TenKhachHang}}').join(renderCustomerName(name));
}

// ============================================================ CÂU TRẢ LỜI CÔNG KHAI
// Reply cho comment TIÊU CỰC: xin lỗi công khai + mời nhắn tin riêng (giám sát bằng
// worklist 'negative_comment' ở pipeline). KHÔNG hứa hẹn bồi thường, KHÔNG chứa số liệu.
function negativeReply(comment, customerName) {
  void comment;
  const text = '{{TenKhachHang}} ơi, shop thành thật xin lỗi vì trải nghiệm chưa tốt này ạ. '
    + 'Shop đã ghi nhận phản hồi của {{TenKhachHang}} và đang kiểm tra lại ngay. '
    + '{{TenKhachHang}} vui lòng nhắn tin cho shop để em hỗ trợ nhanh và chính xác nhất nha ạ. '
    + 'Cảm ơn {{TenKhachHang}} nhiều!';
  return replaceTenKhachHang(text, customerName);
}

// Reply cho comment TÍCH CỰC: cảm ơn + mời nhắn tin tư vấn tiếp (có tên khách).
function positiveReply(comment, customerName) {
  void comment;
  const text = 'Dạ {{TenKhachHang}} ơi, shop cảm ơn {{TenKhachHang}} đã quan tâm sản phẩm của shop nha ạ! '
    + '{{TenKhachHang}} cần tư vấn thêm về mẫu/giá cứ nhắn tin cho shop, em hỗ trợ ngay nha ạ.';
  return replaceTenKhachHang(text, customerName);
}

// Reply chung (commentReply): soạn câu tuỳ ý vẫn render {{TenKhachHang}} đúng chuẩn aicake.
function commentReply(comment, customerName, replyText) {
  void comment;
  const fallback = 'Dạ {{TenKhachHang}} ơi, shop cảm ơn {{TenKhachHang}} đã bình luận nha ạ! '
    + 'Anh/chị cần hỗ trợ gì cứ nhắn tin cho shop để em phản hồi sớm nhất nha ạ.';
  return replaceTenKhachHang(replyText || fallback, customerName);
}

module.exports = {
  classifyComment,
  negativeReply,
  positiveReply,
  commentReply,
  replaceTenKhachHang,
  renderCustomerName,
  NEGATIVE_WORDS,
  BUY_INTENT_WORDS,
  QUESTION_WORDS,
  POSITIVE_WORDS,
};
