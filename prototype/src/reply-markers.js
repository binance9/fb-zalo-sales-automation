'use strict';
// reply-markers.js — AICAKE (G4): TÁCH REPLY MARKER + QUICK REPLY + BIẾN (chuẩn aicake.vn).
//
// Chuẩn aicake: AI trả lời được NHIỀU Ý trong cùng 1 reply — tách bằng dòng `---` (đơn lẻ
// trên 1 dòng) thành N tin nhắn gửi LẦN LƯỢT; quick reply `[[Nhãn]]` / `[[Nhãn|payload]]`
// (payload mặc định = Nhãn); postback `[[[Nhãn|payload]]]`; biến `{{TenKhachHang}}` trong
// template câu chữ (fallback 'bạn' khi chưa biết tên khách).
//
// File THUẦN (không đụng store/gate/platform): pipeline wrap gate.sendReply ĐÚNG MỘT CHỖ —
// text reply cuối cùng -> renderVars -> splitReply -> gửi TỪNG phần text như 1 tin riêng
// (giữ đúng thứ tự, cùng conversation, cùng pattern audit/transaction/idempotency hiện có).
// Reply cũ KHÔNG marker + KHÔNG biến -> NO-OP tuyệt đối (hành vi regression 245 giữ nguyên).

// Biến tên khách chuẩn aicake — fallback 'bạn'.
const NAME_VAR = '{{TenKhachHang}}';

// Ranh giới khối: dòng chỉ gồm dấu gạch ngang (>= 3). Nội dung giữa 2 ranh giới = 1 tin.
// Chỉ nhận dòng ĐƠN LẺ (`---` đứng giữa câu không tách) — đúng spec aicake.
const BLOCK_SPLIT_RE = /^[ \t]*-{3,}[ \t]*$/m;

// Token trong khối: [[[Nhãn|payload]]] (postback) hoặc [[Nhãn]] / [[Nhãn|payload]] (quick).
// Token nằm trọn trong 1 dòng nội dung — Nhãn/payload không chứa [ ] hay xuống dòng.
// postback (3 ngoặc) được thử TRƯỚC quick (2 ngoặc) để không bị quick "ăn mất" 1 cặp.
const TOKEN_RE = /\[\[\[([^[\]\n]+?)(?:\|([^[\]\n]*?))?\]\]\]|\[\[([^[\]\n]+?)(?:\|([^[\]\n]*?))?\]\]/g;

// Có khả năng chứa marker (dòng --- hoặc cặp [[ ]] / [[[ ]]]) — dùng để chốt đường NO-OP nhanh.
function looksLikeMarked(text) {
  return BLOCK_SPLIT_RE.test(text) || /\[\[/.test(text) || /\]\]/.test(text);
}

// Tên khách hiển thị: rỗng/null/whitespace -> 'bạn'.
function customerNameOf(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return s || 'bạn';
}

// ============================================================ renderVars
// renderVars(text, {tenKhachHang}) — thay {{TenKhachHang}} bằng tên khách (fallback 'bạn').
// Tầng gửi là TEXT thuần (không HTML) nên KHÔNG escape. Text không chứa biến -> trả NGUYÊN
// chuỗi ban đầu (byte-identical — no-op tuyệt đối, không đụng reply cũ).
function renderVars(text, vars) {
  const s = String(text === undefined || text === null ? '' : text);
  if (s.indexOf(NAME_VAR) < 0) return s;
  return s.split(NAME_VAR).join(customerNameOf(vars ? vars.tenKhachHang : undefined));
}

// ============================================================ splitReply
// splitReply(text) -> [{ kind: 'text'|'quick'|'postback', label, payload }]
//   - Tách theo dòng `---` (đơn lẻ trên 1 dòng) thành các khối; khối rỗng bỏ qua.
//   - MỖI KHỐI: phần text (nhiều mảnh quanh token GỘP LẠI thành 1 phần, các mảnh nối bằng
//     '\n' — nhiều dòng giữ nguyên) đặt TRƯỚC, sau đó từng token theo thứ tự xuất hiện:
//     `[[Nhãn]]` / `[[Nhãn|payload]]` -> kind 'quick' (payload mặc định = Nhãn);
//     `[[[Nhãn|payload]]]` -> kind 'postback'. Gộp mảnh text tránh sinh tin rác 1-2 ký tự
//     (vd dấu chấm sau token) khi gửi từng phần như tin riêng.
//   - KHÔNG có marker -> trả ĐÚNG 1 phần tử text nguyên khối (không trim, byte-identical)
//     => no-op với mọi reply cũ.
//   - Text chứa marker lạ (vd `[[x` không đóng) -> giữ nguyên trong phần text.
function splitReply(text) {
  const raw = String(text === undefined || text === null ? '' : text);
  if (!raw || !looksLikeMarked(raw)) {
    // NO-OP: nguyên khối kể cả khoảng trắng — caller so sánh label === raw để đi đường gốc.
    return [{ kind: 'text', label: raw, payload: null }];
  }
  const parts = [];
  const blocks = raw.split(BLOCK_SPLIT_RE);
  for (const block of blocks) {
    const b = block.trim();
    if (!b) continue; // khối rỗng giữa 2 dòng ---
    TOKEN_RE.lastIndex = 0;
    let last = 0;
    let m;
    const fragments = [];
    while ((m = TOKEN_RE.exec(b)) !== null) {
      const before = b.slice(last, m.index).trim();
      if (before) fragments.push(before);
      last = m.index + m[0].length;
    }
    const tail = b.slice(last).trim();
    if (tail) fragments.push(tail);
    if (fragments.length) parts.push({ kind: 'text', label: fragments.join('\n'), payload: null });
    // chạy lần nữa (hoặc tiếp tục từ lastIndex) để đẩy token theo đúng thứ tự xuất hiện
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(b)) !== null) {
      if (m[1] !== undefined) {
        // [[[Nhãn|payload]]] — postback; thiếu |payload -> payload = Nhãn; |payload rỗng -> Nhãn
        const payload = (m[2] === undefined || String(m[2]).trim() === '') ? m[1] : m[2];
        parts.push({ kind: 'postback', label: m[1].trim(), payload: String(payload).trim() });
      } else {
        // [[Nhãn]] / [[Nhãn|payload]] — quick reply; payload mặc định = Nhãn
        const label = m[3].trim();
        const payload = (m[4] === undefined || String(m[4]).trim() === '') ? label : m[4];
        parts.push({ kind: 'quick', label, payload: String(payload).trim() });
      }
    }
  }
  if (!parts.length) return [{ kind: 'text', label: raw, payload: null }];
  return parts;
}

module.exports = { splitReply, renderVars, NAME_VAR, customerNameOf };
