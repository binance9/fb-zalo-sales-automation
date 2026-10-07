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

console.log(`persona-soul: ${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
