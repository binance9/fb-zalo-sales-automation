'use strict';
// test/guide-content-i18n-ko-hi-ja.js — CONTRACT TEST cho 3 bản dịch guide
// (src/guide-content-ko.js, src/guide-content-hi.js, src/guide-content-ja.js)
//
// Kiểm tra mỗi ngôn ngữ so với bản gốc src/guide-content.js:
//   1. shape export: { lang, product, categories }
//   2. 5 danh mục / 20 bài — id (category + article) khớp 1-1 với bản gốc, đúng thứ tự
//   3. minutes + seeAlso khớp 1-1 bản gốc
//   4. đúng số bước mỗi bài; title/summary/steps không rỗng; tip có/missing giống bản gốc
//   5. KHÔNG còn chữ Việt có dấu sót trong nội dung đã dịch
//
// Chạy: node test/guide-content-i18n-ko-hi-ja.js
//   → in "guide-content-i18n-ko-hi-ja: X/X PASS", exit 0/1.

const path = require('path');

const base = require(path.join(__dirname, '..', 'src', 'guide-content.js'));
const langs = [
  { lang: 'ko', name: '한국어', file: 'guide-content-ko.js' },
  { lang: 'hi', name: 'हिन्दी', file: 'guide-content-hi.js' },
  { lang: 'ja', name: '日本語', file: 'guide-content-ja.js' },
].map(l => ({ ...l, mod: require(path.join(__dirname, '..', 'src', l.file)) }));

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

function ok(v, msg) {
  if (!v) throw new Error(msg || 'expected truthy');
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || ''} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}
function deepEq(a, b, msg) {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg || ''} (expected ${jb}, got ${ja})`);
}

// Chữ Việt có dấu: Latin-1 Supplement (À-ÿ), Latin Extended-A/B (đ, Ă, ơ, ư…),
// combining diacritics, Latin Extended Additional (ạ, ế, ữ…).
const VIET_DIACRITIC = /[\u00C0-\u00FF\u0100-\u024F\u0300-\u036F\u1E00-\u1EFF]/;

function flattenTexts(mod) {
  const out = [];
  for (const c of mod.categories) {
    out.push(c.title);
    for (const a of c.articles) {
      out.push(a.title, a.summary);
      for (const st of a.steps) out.push(st.title, st.body, st.tip || '');
    }
  }
  return out;
}

// ---------- 0. bản gốc chuẩn bị ----------
check('bản gốc: 5 danh mục / 20 bài (điều kiện tiền đề)', () => {
  eq(base.categories.length, 5, 'base categories');
  eq(base.categories.reduce((n, c) => n + c.articles.length, 0), 20, 'base articles');
});

for (const { lang, name, file, mod } of langs) {
  // ---------- 1. shape ----------
  check(`${lang} (${name}): shape { lang, product, categories }`, () => {
    eq(mod.lang, lang, 'lang');
    eq(mod.product, 'Sales AI Console', 'product');
    ok(Array.isArray(mod.categories), 'categories phải là mảng');
  });

  // ---------- 2. cấu trúc + id 1-1 ----------
  check(`${lang}: 5 danh mục, id khớp 1-1 bản gốc`, () => {
    eq(mod.categories.length, 5, 'số danh mục');
    deepEq(mod.categories.map(c => c.id), base.categories.map(c => c.id), 'category ids');
  });

  check(`${lang}: 20 bài, id khớp 1-1 bản gốc (đúng thứ tự)`, () => {
    const modA = mod.categories.flatMap(c => c.articles.map(a => a.id));
    const baseA = base.categories.flatMap(c => c.articles.map(a => a.id));
    eq(modA.length, 20, 'số bài');
    deepEq(modA, baseA, 'article ids');
  });

  check(`${lang}: minutes + seeAlso khớp 1-1 bản gốc`, () => {
    const baseMap = new Map(base.categories.flatMap(c => c.articles.map(a => [a.id, a])));
    for (const c of mod.categories) {
      for (const a of c.articles) {
        const b = baseMap.get(a.id);
        ok(b, `không tìm thấy bài gốc ${a.id}`);
        eq(a.minutes, b.minutes, `${a.id}.minutes`);
        deepEq(a.seeAlso, b.seeAlso, `${a.id}.seeAlso`);
      }
    }
  });

  // ---------- 3. số bước + nội dung không rỗng ----------
  check(`${lang}: đúng số bước mỗi bài + title/summary/steps không rỗng`, () => {
    const baseMap = new Map(base.categories.flatMap(c => c.articles.map(a => [a.id, a])));
    for (const c of mod.categories) {
      ok(typeof c.title === 'string' && c.title.trim(), `category ${c.id} thiếu title`);
      for (const a of c.articles) {
        const b = baseMap.get(a.id);
        eq(a.steps.length, b.steps.length, `${a.id}: số bước`);
        ok(typeof a.title === 'string' && a.title.trim(), `${a.id}: title rỗng`);
        ok(typeof a.summary === 'string' && a.summary.trim(), `${a.id}: summary rỗng`);
        a.steps.forEach((st, i) => {
          ok(typeof st.title === 'string' && st.title.trim(), `${a.id} bước ${i + 1}: title rỗng`);
          ok(typeof st.body === 'string' && st.body.trim(), `${a.id} bước ${i + 1}: body rỗng`);
          const hasTip = typeof st.tip === 'string' && st.tip.trim() !== '';
          const baseHasTip = typeof b.steps[i].tip === 'string' && b.steps[i].tip.trim() !== '';
          eq(hasTip, baseHasTip, `${a.id} bước ${i + 1}: tip có/không phải giống bản gốc`);
        });
      }
    }
  });

  // ---------- 4. đã dịch hết — không còn tiếng Việt có dấu ----------
  check(`${lang}: không sót chữ Việt có dấu trong nội dung đã dịch`, () => {
    for (const t of flattenTexts(mod)) {
      const m = VIET_DIACRITIC.exec(t);
      ok(!m, `tìm thấy ký tự Việt "${m && m[0]}" trong: "${t.slice(Math.max(0, (m && m.index) - 30), (m && m.index) + 30)}..."`);
    }
  });

  // ---------- 5. đúng ngôn ngữ (kí tự đặc trưng xuất hiện) ----------
  check(`${lang}: nội dung thực sự là ${name}`, () => {
    const text = flattenTexts(mod).join(' ');
    const hasScript =
      lang === 'ko' ? /[\uAC00-\uD7AF]/.test(text)
      : lang === 'hi' ? /[\u0900-\u097F]/.test(text)
      : /[\u3040-\u30FF]/.test(text);
    ok(hasScript, `không thấy chữ ${name} nào trong nội dung`);
  });
}

console.log('');
if (failures.length) {
  console.error(`guide-content-i18n-ko-hi-ja: ${pass}/${total} PASS`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`guide-content-i18n-ko-hi-ja: ${pass}/${total} PASS`);
process.exit(0);
