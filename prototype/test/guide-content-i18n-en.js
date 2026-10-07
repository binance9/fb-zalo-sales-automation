'use strict';
// test/guide-content-i18n-en.js — i18n parity test for guide-content-en.js / guide-content-zh.js
// Run: node test/guide-content-i18n-en.js  →  prints "guide-content-i18n-en: X/X PASS", exit 0/1.
//
// For EACH language edition (en, zh), against the source src/guide-content.js, asserts:
//   1. lang / product fields are correct;
//   2. same number of categories (exactly 5) AND category ids match 1-1, in order;
//   3. same number of articles (exactly 20) AND article ids match 1-1, in order;
//   4. minutes and seeAlso are byte-identical (structure must never drift);
//   5. per-article step counts identical AND tip placement identical;
//   6. no empty title / summary / step title / step body (tips non-empty when present);
//   7. ZERO Vietnamese diacritics remaining in any category title, article
//      title/summary or step title/body/tip.

const path = require('path');
const base = require(path.join(__dirname, '..', 'src', 'guide-content.js'));
const LANGS = [
  ['en', require(path.join(__dirname, '..', 'src', 'guide-content-en.js'))],
  ['zh', require(path.join(__dirname, '..', 'src', 'guide-content-zh.js'))],
];

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

// ---------- Vietnamese diacritics detector ----------
// (1) Precomposed letters that do NOT decompose under NFD: ă â đ ê ô ơ ư (both cases);
//     every other Vietnamese accented vowel (à á ả ã ạ ầ ấ ể ễ ộ ợ ữ ỵ …) decomposes
//     into a base letter + a combining mark in U+0300..U+036F.
const VN_PRECOMPOSED = /[ăĂâÂđĐêÊôÔơƠưƯ]/;
const VN_COMBINING = /[\u0300-\u036f]/;
function hasVietnameseDiacritics(value) {
  const s = String(value);
  if (VN_PRECOMPOSED.test(s)) return true;
  return VN_COMBINING.test(s.normalize('NFD'));
}

// Walk every human-readable string of a category tree.
function iterText(cat, cb) {
  cb(`category "${cat.id}" title`, cat.title);
  for (const a of cat.articles) {
    cb(`${a.id} title`, a.title);
    cb(`${a.id} summary`, a.summary);
    a.steps.forEach((st, i) => {
      cb(`${a.id} step ${i + 1} title`, st.title);
      cb(`${a.id} step ${i + 1} body`, st.body);
      if (st.tip !== undefined) cb(`${a.id} step ${i + 1} tip`, st.tip);
    });
  }
}

function flatArticles(g) {
  const out = [];
  for (const c of g.categories) for (const a of c.articles) out.push({ cat: c, art: a });
  return out;
}

// ---------- per-language assertions ----------
for (const [code, g] of LANGS) {
  const tag = `[${code}]`;

  check(`${tag} lang === '${code}' and product === 'Sales AI Console'`, () => {
    eq(g.lang, code, 'lang');
    eq(g.product, 'Sales AI Console', 'product');
  });

  check(`${tag} exactly 5 categories, ids match source 1-1 in order`, () => {
    eq(g.categories.length, 5, 'category count');
    g.categories.forEach((c, i) => {
      ok(c && typeof c.id === 'string', `category #${i + 1}: missing id`);
      eq(c.id, base.categories[i].id, `category #${i + 1} id`);
    });
  });

  check(`${tag} exactly 20 articles, ids match source 1-1 in order`, () => {
    const got = flatArticles(g).map(x => x.art.id);
    const want = flatArticles(base).map(x => x.art.id);
    eq(got.length, 20, 'article count');
    got.forEach((id, i) => eq(id, want[i], `article #${i + 1} id`));
  });

  check(`${tag} minutes + seeAlso byte-identical to source`, () => {
    for (const { art } of flatArticles(g)) {
      const src = flatArticles(base).find(x => x.art.id === art.id).art;
      eq(art.minutes, src.minutes, `${art.id}: minutes`);
      eq(JSON.stringify(art.seeAlso || []), JSON.stringify(src.seeAlso || []), `${art.id}: seeAlso`);
    }
  });

  check(`${tag} step counts + tip placement identical to source`, () => {
    for (const { art } of flatArticles(g)) {
      const src = flatArticles(base).find(x => x.art.id === art.id).art;
      eq(art.steps.length, src.steps.length, `${art.id}: step count`);
      art.steps.forEach((st, i) => {
        eq(st.tip !== undefined, src.steps[i].tip !== undefined, `${art.id} step ${i + 1}: tip placement`);
      });
    }
  });

  check(`${tag} no empty title/summary/step title/step body (tips non-empty when present)`, () => {
    for (const cat of g.categories) {
      iterText(cat, (label, text) => {
        ok(typeof text === 'string' && text.trim().length > 0, `${label}: empty text`);
      });
    }
  });

  check(`${tag} zero Vietnamese diacritics left in any title/summary/step title/body/tip`, () => {
    for (const cat of g.categories) {
      iterText(cat, (label, text) => {
        ok(!hasVietnameseDiacritics(text), `${label}: Vietnamese diacritics remain in "${String(text).slice(0, 60)}"`);
      });
    }
  });
}

// ---------- summary ----------
const okAll = pass === total;
console.log('');
console.log(`guide-content-i18n-en: ${pass}/${total} PASS`);
if (!okAll) {
  console.error('FAILURES:');
  for (const f of failures) console.error('  - ' + f);
  process.exitCode = 1;
}
