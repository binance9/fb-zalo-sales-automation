'use strict';
// persona-soul.js — test "linh hồn" AI bán hàng: chit-chat vui vẻ, ổn định theo hash,
// hook sản phẩm chỉ từ FACTS, luật vàng không bịa. Offline 100% (không gọi mạng).

const { SalesAI } = require('../src/sales-ai');
const persona = require('../src/persona');

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
};

const ai = new SalesAI({});
const ctxBase = {
  state: 'NEW_LEAD', mode: 'AI', subject_sku: null, draftMissing: [],
  facts: {}, eventId: 'ev-test-1',
};

// (1) chào -> vui vẻ, không "chưa đủ dữ liệu"
const hi = ai.stubPropose('CHITCHAT', { ...ctxBase, text: 'hi shop ơi' });
ok(hi && hi.text && hi.text.length > 10 && !/chưa đủ dữ liệu/.test(hi.text), 'chào -> reply vui vẻ, không câu cụt');
ok(hi.evidence && hi.evidence.source === 'persona_stub', 'chào -> đi qua persona_stub');

// (2) ổn định: cùng text -> cùng reply (hash, không xoay vòng)
const hi2 = ai.stubPropose('CHITCHAT', { ...ctxBase, text: 'hi shop ơi', eventId: 'ev-test-1' });
ok(hi.text === hi2.text, 'cùng input -> cùng reply (idempotency BL-9)');

// (3) cảm ơn -> lịch sự
const ty = ai.stubPropose('CHITCHAT', { ...ctxBase, text: 'cảm ơn shop nha' });
ok(ty.text && /(cảm ơn|vui khi|phục vụ)/i.test(ty.text), 'cảm ơn -> lời đáp lịch sự');

// (4) hỏi tên AI -> có tên Suri
const nm = ai.stubPropose('CHITCHAT', { ...ctxBase, text: 'em tên gì vậy shop' });
ok(nm.text && /Suri/.test(nm.text), 'hỏi tên -> giới thiệu Suri');

// (5) hook sản phẩm CHỈ từ FACTS
const hookCtx = { ...ctxBase, text: 'hi shop', facts: {
  subjectProduct: { name: 'Nến thơm vanilla' },
  variants: [{ sku: 'NT-VANILLA-S', size: 'S', price: 165000, effective: 7 }],
} };
const hooked = ai.stubPropose('CHITCHAT', hookCtx);
ok(hooked.text.includes('Nến thơm vanilla') && hooked.text.includes('còn 7'), 'chào + FACTS -> mời SP thật kèm tồn đúng');
ok(!/165\.?000|165000/.test(hooked.text), 'chit-chat KHÔNG nhả số giá (số giá chỉ luồng PRICE)');

// (6) giá vẫn 100% từ DB (luật vàng không đổi)
const price = ai.stubPropose('PRICE', { ...hookCtx, text: 'nến vanilla giá bao nhiêu' });
ok(price.text && price.text.includes('165000đ'), 'PRICE -> giá từ DB nguyên vẹn (165000đ)');
ok(!/giá sốc|GIÁ SỐC/.test(price.text), 'PRICE thường -> không tự bịa khuyến mãi');

// (7) persona block: đủ hồn + luật sự thật
const block = persona.buildPersonaBlock({});
ok(/Suri/.test(block) && /vui vẻ/.test(block), 'buildPersonaBlock có tên + tính cách');
ok(/KHÔNG BAO GIỜ bịa số/.test(block) && /FACTS/.test(block), 'persona nhấn luật không bịa số');

// (8) đa dạng giữa các text khác nhau (ít nhất 2/4 câu chào khác nhau)
const variants = new Set(['hi shop', 'hello nha', 'chào shop ơi', 'alo shop'].map(t =>
  ai.stubPropose('CHITCHAT', { ...ctxBase, text: t }).text));
ok(variants.size >= 2, 'câu chào khác nhau -> reply đa dạng (' + variants.size + '/4 khác)');

// ---------- SURI MULTILANG (2026-10-07): bot trả lời theo ngôn ngữ shop chọn ----------
const VI_CHARS = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;

// (9) getReplyLang: hợp lệ giữ nguyên, lạ/rỗng/sai kiểu -> vi
ok(persona.getReplyLang({ replyLang: 'ja' }) === 'ja', 'getReplyLang hợp lệ -> ja');
ok(persona.getReplyLang({ replyLang: 'FR' }) === 'vi', 'getReplyLang lang lạ (FR) -> vi');
ok(persona.getReplyLang({}) === 'vi' && persona.getReplyLang(null) === 'vi', 'getReplyLang rỗng/null -> vi');

// (10a) replyLang='en' -> chữ English, KHÔNG còn dấu tiếng Việt
const enHi = ai.stubPropose('CHITCHAT', { ...ctxBase, text: 'hello there', replyLang: 'en' });
ok(enHi.text && !VI_CHARS.test(enHi.text), 'en chitchat -> không còn dấu tiếng Việt');
ok(/hi|hello|looking|browse|help|service/i.test(enHi.text), 'en chitchat -> chữ English');
const priceEn = ai.stubPropose('PRICE', { ...hookCtx, text: 'how much is this', replyLang: 'en' });
ok(/Here are the prices/.test(priceEn.text) && priceEn.text.includes('165000đ'), 'en PRICE -> tiếng Anh + giá DB nguyên gốc (165000đ)');
const buyEn = ai.stubPropose('BUY_ASK', { ...hookCtx, text: 'i want to buy', draftMissing: ['phone'],
  facts: { subjectProduct: { name: 'Vanilla candle' }, variants: [{ sku: 'NT-1', name: 'Vanilla candle', qty: 1 }] },
  replyLang: 'en' });
ok(/phone number/i.test(buyEn.text) && !VI_CHARS.test(buyEn.text), 'en BUY_ASK -> hỏi SĐT bằng tiếng Anh');

// (10b) replyLang='ja' -> có kana/kanji; khách Nhật chào tiếng Nhật vẫn rơi đúng nhóm
const jaHi = ai.stubPropose('CHITCHAT', { ...ctxBase, text: 'こんにちは', replyLang: 'ja', eventId: 'ev-ja-1' });
ok(jaHi.text && /[\u3040-\u30ff\u4e00-\u9faf]/.test(jaHi.text), 'ja chitchat -> có kana/kanji');
const jaStock = ai.stubPropose('STOCK', { ...hookCtx, text: 'まだありますか', replyLang: 'ja' });
ok(/あと7点|残り7点/.test(jaStock.text), 'ja STOCK -> tiếng Nhật + tồn đúng (7)');
const zhHi = ai.stubPropose('CHITCHAT', { ...ctxBase, text: '你好', replyLang: 'zh', eventId: 'ev-zh-1' });
ok(zhHi.text && /[\u4e00-\u9fff]/.test(zhHi.text), 'zh chitchat -> chữ Hán');
const koHi = ai.stubPropose('CHITCHAT', { ...ctxBase, text: '안녕하세요', replyLang: 'ko', eventId: 'ev-ko-1' });
ok(koHi.text && /[\uac00-\ud7af]/.test(koHi.text), 'ko chitchat -> Hangul');
const hiHi = ai.stubPropose('CHITCHAT', { ...ctxBase, text: 'नमस्ते', replyLang: 'hi', eventId: 'ev-hi-1' });
ok(hiHi.text && /[\u0900-\u097f]/.test(hiHi.text), 'hi chitchat -> Devanagari');

// (10c) 'vi' -> NGUYÊN VẸN hành vi cũ (Dạ + dấu tiếng Việt + hook câu cũ)
const viHi = ai.stubPropose('CHITCHAT', { ...ctxBase, text: 'hi shop ơi' });
ok(/^Dạ/.test(viHi.text) && VI_CHARS.test(viHi.text), 'vi chitchat -> nguyên văn cũ (Dạ + dấu)');
const viHook = ai.stubPropose('CHITCHAT', { ...hookCtx, eventId: 'ev-vi-hook' });
ok(viHook.text.includes('Nến thơm vanilla') && viHook.text.includes('đang còn 7 món'), 'vi hook -> câu cũ nguyên vẹn (đang còn 7 món)');
const viPrice = ai.stubPropose('PRICE', { ...hookCtx, text: 'nến vanilla giá bao nhiêu' });
ok(viPrice.text.includes('Dạ') && viPrice.text.includes('165000đ'), 'vi PRICE -> template cũ nguyên trạng');

// (10d) lang lạ -> fallback vi (cùng input => cùng output với vi)
const frHi = ai.stubPropose('CHITCHAT', { ...ctxBase, text: 'hi shop ơi', replyLang: 'fr' });
ok(frHi.text === viHi.text, 'lang lạ (fr) stub -> fallback vi (cùng output)');
const aiFr = new SalesAI({ getReplyLang: () => 'fr' });
const pFr = aiFr.propose('CHITCHAT', { ...ctxBase, text: 'hi shop ơi' });
ok(pFr.text === viHi.text, 'propose hook lang lạ -> fallback vi');

// (11) propose gắn ctx.replyLang qua hook getReplyLang (mô phỏng app đọc settings)
const aiEn = new SalesAI({ getReplyLang: () => 'en' });
const pEn = aiEn.propose('CHITCHAT', { ...ctxBase, text: 'hello', eventId: 'ev-x1' });
ok(pEn.text && !VI_CHARS.test(pEn.text) && /hi|hello|looking|browse|help|service/i.test(pEn.text), 'propose hook en -> CHITCHAT tiếng Anh');
const aiHookErr = new SalesAI({ getReplyLang: () => { throw new Error('settings corrupted'); } });
const pErr = aiHookErr.propose('CHITCHAT', { ...ctxBase, text: 'hi shop ơi' });
ok(pErr.text === viHi.text, 'propose hook ném lỗi -> fallback vi (không crash)');
const aiNoHook = new SalesAI({});
const pNo = aiNoHook.propose('CHITCHAT', { ...ctxBase, text: 'hi shop ơi', replyLang: 'en' });
ok(pNo.text === viHi.text, 'propose không hook -> GHI ĐÈ replyLang về vi (ngôn ngữ chỉ do shop quyết)');

// (12) LIVE wiring: persona block mang ngôn ngữ, FACTS block KHÔNG bị dịch (số nguyên gốc)
const blockJa = persona.buildPersonaBlock({ replyLang: 'ja' });
ok(/NGÔN NGỮ TRẢ LỜI/.test(blockJa) && /日本語/.test(blockJa), 'persona block ja -> có dòng NGÔN NGỮ TRẢ LỜI + 日本語');
ok(!/NGÔN NGỮ TRẢ LỜI/.test(persona.buildPersonaBlock({ replyLang: 'vi' })), 'persona block vi -> KHÔNG thêm dòng ngôn ngữ');
ok(/NGÔN NGỮ TRẢ LỜI/.test(persona.buildPersonaBlock({ persona_lang: 'zh' })), 'persona block persona_lang=zh -> nhận ngôn ngữ');
const { buildFactsBlock } = require('../src/sales-ai');
const factsBlock = buildFactsBlock({ subjectProduct: { name: 'Nến thơm vanilla' }, variants: [{ sku: 'NT-1', size: 'S', price: 165000, effective: 7 }] }, {});
ok(factsBlock.includes('165000đ') && factsBlock.includes('còn 7') && !/日本語|中文/.test(factsBlock), 'FACTS block -> số nguyên gốc, không bị dịch theo lang');

console.log(`persona-soul: ${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
