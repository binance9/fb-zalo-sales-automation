'use strict';
// test/guide-content.js — CONTRACT TEST cho src/guide-content.js
// Chạy: node test/guide-content.js  →  in "guide-content: X/X PASS", exit 0/1.

const path = require('path');
const g = require(path.join(__dirname, '..', 'src', 'guide-content.js'));

let pass = 0;
let total = 0;
const failures = [];

function check(name, fn) {
  total++;
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.error(`  FAIL ${name}: ${e.message}`);
  }
}

function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || ''} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}
function ok(v, msg) {
  if (!v) throw new Error(msg || 'expected truthy');
}

// ---------- 1. shape gốc ----------
check('version === 1', () => eq(g.version, 1, 'version'));
check("product === 'Sales AI Console'", () => eq(g.product, 'Sales AI Console', 'product'));
check('typeof searchArticles === function', () => eq(typeof g.searchArticles, 'function', 'searchArticles type'));

// ---------- 2. danh mục ----------
check('>= 5 danh mục', () => ok(Array.isArray(g.categories) && g.categories.length >= 5, `categories=${g.categories && g.categories.length}`));
check('đủ 5 id danh mục chuẩn', () => {
  const ids = g.categories.map(c => c.id);
  for (const want of ['bat-dau-nhanh', 'xay-dung-ai', 'don-hang-van-chuyen', 'binh-luan-automation', 'bao-cao-quan-tri']) {
    ok(ids.includes(want), `thiếu category id "${want}"`);
  }
});
check('id danh mục là slug không dấu', () => {
  for (const c of g.categories) {
    ok(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.id), `category id "${c.id}" không phải slug`);
    ok(typeof c.title === 'string' && c.title.trim(), `category "${c.id}" thiếu title`);
  }
});

// ---------- 3. bài viết ----------
const allArticles = [];
for (const c of g.categories) {
  for (const a of c.articles || []) allArticles.push({ category: c, article: a });
}
check('tổng >= 15 bài', () => ok(allArticles.length >= 15, `chỉ có ${allArticles.length} bài`));
check('bắt đầu nhanh có đủ 7 bài', () => {
  const cat = g.categories.find(c => c.id === 'bat-dau-nhanh');
  ok(cat && cat.articles.length >= 7, `bat-dau-nhanh có ${cat ? cat.articles.length : 0} bài`);
});
check('id bài là slug không dấu + duy nhất toàn cục', () => {
  const seen = new Set();
  for (const { article } of allArticles) {
    ok(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(article.id), `article id "${article.id}" không phải slug`);
    ok(!seen.has(article.id), `article id trùng: "${article.id}"`);
    seen.add(article.id);
  }
});
check('mỗi bài có title + summary + minutes >= 1', () => {
  for (const { article } of allArticles) {
    ok(typeof article.title === 'string' && article.title.trim(), `${article.id}: thiếu title`);
    ok(typeof article.summary === 'string' && article.summary.trim().length > 10, `${article.id}: summary rỗng/quá ngắn`);
    ok(Number.isInteger(article.minutes) && article.minutes >= 1 && article.minutes <= 30, `${article.id}: minutes=${article.minutes}`);
  }
});
check('mỗi bài >= 3 bước, mỗi bước có title + body', () => {
  for (const { article } of allArticles) {
    ok(Array.isArray(article.steps) && article.steps.length >= 3, `${article.id}: chỉ ${article.steps ? article.steps.length : 0} bước`);
    for (let i = 0; i < article.steps.length; i++) {
      const s = article.steps[i];
      ok(typeof s.title === 'string' && s.title.trim(), `${article.id} bước ${i + 1}: thiếu title`);
      ok(typeof s.body === 'string' && s.body.trim().length > 10, `${article.id} bước ${i + 1}: body rỗng/quá ngắn`);
    }
  }
});
check('seeAlso (nếu có) trỏ tới id bài tồn tại', () => {
  const ids = new Set(allArticles.map(x => x.article.id));
  for (const { article } of allArticles) {
    for (const ref of article.seeAlso || []) {
      ok(ids.has(ref), `${article.id}: seeAlso "${ref}" không tồn tại`);
    }
  }
});

// ---------- 4. tìm kiếm ----------
check("searchArticles('đơn') trả kết quả (bỏ dấu đúng)", () => {
  const r = g.searchArticles('đơn');
  ok(Array.isArray(r) && r.length > 0, 'không có kết quả');
  const first = r[0];
  ok(first && first.category && first.article && typeof first.score === 'number', 'shape kết quả sai: cần {category, article, score}');
  ok(/đơn|Đơn/i.test(first.article.title + ' ' + first.article.summary), `kết quả đầu không liên quan "đơn": ${first.article.id}`);
});
check("searchArticles('AI') trả kết quả", () => {
  const r = g.searchArticles('AI');
  ok(Array.isArray(r) && r.length > 0, 'không có kết quả');
  ok(r.some(x => /ai/i.test(x.article.title)), 'không có bài nào về AI trong top');
});
check('kết quả giảm dần theo score', () => {
  for (const q of ['đơn', 'AI', 'hủy đơn', 'bình luận', 'quyền']) {
    const r = g.searchArticles(q);
    for (let i = 1; i < r.length; i++) {
      ok(r[i - 1].score >= r[i].score, `query "${q}": score không giảm dần tại ${i}`);
    }
  }
});
check('query đa từ "bật bot" tìm đúng bài go-live', () => {
  const r = g.searchArticles('bật bot');
  ok(r.length > 0, 'không có kết quả');
  eq(r[0].article.id, 'bat-bot', 'top kết quả');
});
check('chuẩn hóa bỏ dấu: "don hang" khớp "Đơn hàng"', () => {
  const r = g.searchArticles('don hang');
  ok(r.length > 0 && /đơn hàng/i.test(r[0].article.title), `top kết quả: ${r.length ? r[0].article.id : '(rỗng)'}`);
});
check('query rỗng / vô nghĩa trả mảng rỗng', () => {
  eq(g.searchArticles('').length, 0, "searchArticles('')");
  eq(g.searchArticles('zzzqqqxyz').length, 0, "searchArticles('zzzqqqxyz')");
});

// ---------- 5. nội dung khớp app thật (spot-check) ----------
check('nội dung nhắc đúng tên UI thật', () => {
  const dump = JSON.stringify(g.categories);
  for (const needle of [
    'BẬT BOT TỰ ĐỘNG', 'Lưu bước 1', '+ Thêm sản phẩm', 'sku_base',
    'Test gọi AI', 'XÁC NHẬN ĐƠN', 'RETRY HỦY QUA ĐVVC', 'TRẢ LẠI CHO AI',
    'Bình luận Facebook — tự động', 'Thành viên team', 'SECRET_IN_PROMPT',
    '{{TenKhachHang}}', 'Nháp (chờ xác nhận)', 'Đã chốt', 'Chờ hủy (ĐVVC)',
    'Tự chủ bot', 'Hồ sơ shop cho AI',
  ]) {
    ok(dump.includes(needle), `thiếu chuỗi UI "${needle}" trong nội dung`);
  }
});
check('đủ 3 công tắc bình luận + 3 loại follow-up', () => {
  const dump = JSON.stringify(g.categories);
  for (const needle of ['auto_reply_comment', 'hide_negative_comment', 'auto_inbox_from_comment', 'Care sau giao', 'Review request', 'Purchase reminder']) {
    ok(dump.includes(needle), `thiếu "${needle}"`);
  }
});

// ---------- kết luận ----------
const okAll = pass === total;
console.log('');
console.log(`guide-content: ${pass}/${total} PASS`);
if (!okAll) {
  console.error('LỖI:');
  for (const f of failures) console.error('  - ' + f);
  process.exitCode = 1;
}
