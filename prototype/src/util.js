'use strict';
// util.js — hàm dùng chung cho prototype (thuần Node, không dependency ngoài).
// Ghi chú prototype: production giữ nguyên lớp này, chỉ thay id-gen bằng ULID thật (AI3 Phụ lục A).

const crypto = require('crypto');

// Bỏ dấu tiếng Việt: chuẩn NFD + bỏ ký tự tổ hợp + đ→d (tái sử dụng thiết kế đã duyệt ở AI2 mục 8: boDau = USE)
function boDau(s) {
  if (!s) return '';
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

// Chuẩn hoá key so khớp: bỏ dấu + lowercase + gộp khoảng trắng
function normKey(s) {
  return boDau(String(s || '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function sha(text, len) {
  const h = crypto.createHash('sha256').update(String(text)).digest('hex');
  return len ? h.slice(0, len) : h;
}

let seqCounter = 0;
function uid(prefix) {
  seqCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${seqCounter.toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

// Định dạng tiền VND nguyên (AI3 mục 5.4: tiền INTEGER VND, cấm float)
function fmtVND(n) {
  return String(Math.round(n));
}

// Trích "số tiền" trong text để guard đối chiếu DB.
// Một số được coi là MONEY khi:
//   (a) có đơn vị tiền kèm theo (đ / d / vnd / vnđ / k), hoặc
//   (b) viết theo nhóm nghìn (185.000 / 185,000).
// Nhờ vậy mã đơn (ORD4_AB12CD), số nhà, ngày tháng KHÔNG bị guard hiểu nhầm là tiền.
// Ghi chú prototype: guard bản đầy đủ phải quét cả số lượng tồn/số điện thoại và cả money
// không có đơn vị (AI2 mục 5.2) — hạn chế đã ghi trong KET-QUA-18-CASE.md.
function extractMoney(text) {
  const out = [];
  const t = String(text || '');
  // SURI STABILITY (hở thật, lặp 1/20-1/400 lần chạy): order_code dạng 'ORD5_86033D' —
  // '86033' + 'D' bị reSuffixed (d\b, /gi) đọc thành "86033 đồng" -> guard OVERRIDDEN oan
  // câu ack huỷ/xác nhận có mã đơn (P3B-5a 'tin huỷ nói đúng mã đơn', P3B-1b 'xác nhận RIÊNG').
  // Fix: số tiền phải KHÔNG dính vào một identifier (chữ/chữ số/_ đứng TRƯỚC chữ số) —
  // khớp đúng ghi chú thiết kế dòng 42 ('mã đơn KHÔNG bị hiểu nhầm là tiền') mà regex cũ
  // chưa bảo đảm cho code kết thúc bằng số+chữ cái.
  // Fix 2 [chốt local — JEV THẤP-3]: chữ HOA đuôi ('D'/'K' kiểu mã đơn ORD5_86033D) KHÔNG
  // được tính là đơn vị tiền — chỉ nhận đ/Đ, d/k THƯỜNG (có biên phải), vnd/VND.
  // Conservative: nghi ngờ thì KHÔNG đè (đúng nguyên tắc guard).
  const reSuffixed = /(?<![A-Za-z0-9_])(\d{4,})\s*(?:[đĐ]|[dk](?![a-zA-Z0-9])|vnd|vnđ|VND)/g;
  const reGrouped = /(?<![A-Za-z0-9_])(\d{1,3}(?:[.,]\d{3}){1,})(?![A-Za-z0-9])/g;
  let m;
  while ((m = reSuffixed.exec(t)) !== null) {
    const v = parseInt(m[1], 10);
    if (!Number.isNaN(v) && v >= 10000) out.push(v);
  }
  while ((m = reGrouped.exec(t)) !== null) {
    const v = parseInt(m[1].replace(/[.,]/g, ''), 10);
    if (!Number.isNaN(v) && v >= 10000 && !out.includes(v)) out.push(v);
  }
  return out;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function similarity(a, b) {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

// Regex SĐT VN: 10 số, đầu 03/05/07/08/09 (AI2 mục 8: timSoDienThoai = USE)
function extractPhone(text) {
  const t = String(text || '').replace(/[\s.\-]/g, '');
  const m = t.match(/(?:\+84|84|0)(?:3|5|7|8|9)\d{8}(?!\d)/);
  if (!m) return null;
  let p = m[0];
  if (p.startsWith('+84')) p = '0' + p.slice(3);
  else if (p.startsWith('84') && p.length === 11) p = '0' + p.slice(2);
  return p;
}

// ============================================================
// BL-3 (P3A): REDACT PII KHỎI TEXT TRƯỚC KHI ĐƯA VÀO MODEL CONTEXT.
// Pipeline dùng hàm này khi dựng ctx cho ai.propose(): SĐT -> [SDT],
// mệnh đề địa chỉ -> [DIA_CHI], tên khách -> [TEN]. Deterministic, dùng cùng
// họ regex với slot-filling (fillSlots) để redact đúng phần fillSlots bắt được.
// DB (messages/ai_proposals nguồn, orders) vẫn giữ nguyên văn — chỉ MODEL bị che.
const RE_PII_PHONE = /(?:\+?84|0)(?:3|5|7|8|9)(?:[.\-\s]?\d){8,9}(?!\d)/g;
const RE_PII_NAME = /((?:tên|ten|mình là|minh la|tôi là|toi la)\s+)([A-ZÀ-Ỹa-zà-ỹ][A-Za-zÀ-ỹà-ỹ ]{1,30}?)(?=\s*(?:,|\.|sdt|số điện thoại|so dien thoai|địa chỉ|dia chi|$))/i;
const RE_PII_ADDR = /((?:địa chỉ|dia chi|giao đến|giao den|giao tới|giao toi|giao hàng tại|giao hang tai)\s*[:\-]?\s*).+$/i;

function redactPii(text) {
  let t = String(text || '');
  t = t.replace(RE_PII_PHONE, '[SDT]');
  t = t.replace(RE_PII_NAME, '$1[TEN]');
  t = t.replace(RE_PII_ADDR, '$1[DIA_CHI]');
  return t;
}

module.exports = { boDau, normKey, sha, uid, iso, fmtVND, extractMoney, extractPhone, redactPii, levenshtein, similarity };
