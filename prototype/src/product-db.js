'use strict';
// product-db.js — catalogue + tồn kho. Nguồn sự thật duy nhất về giá/tồn (nguyên tắc vàng).
//
// searchProduct(text) 4 lớp (AI2 mục 3.1), dừng ở lớp trúng đầu tiên theo từng cụm từ:
//   L1 sku -> L2 alias -> L3 substring (đã bỏ dấu) -> L4 fuzzy (Levenshtein, ngưỡng 0.8)
// getStock(sku) LUÔN đọc giá trị mới nhất (mọi mutation qua chính object này, sync trong 1 tiến trình).

const fs = require('fs');
const path = require('path');
const { normKey, similarity } = require('./util');

const FUZZY_THRESHOLD = 0.8;

class ProductDB {
  constructor({ seedFile }) {
    this.seedFile = seedFile;
    const raw = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
    // Bản sao sâu: tồn kho là trạng thái sống, không sửa file seed.
    this.products = JSON.parse(JSON.stringify(raw.products));
  }

  allVariants() {
    const out = [];
    for (const p of this.products) {
      for (const v of p.variants) out.push({ product: p, variant: v });
    }
    return out;
  }

  getProduct(productId) { return this.products.find(p => p.product_id === productId) || null; }
  getProductByBase(skuBase) { return this.products.find(p => normKey(p.sku_base) === normKey(skuBase)) || null; }

  getVariant(sku) {
    for (const p of this.products) {
      const v = p.variants.find(x => x.sku === sku);
      if (v) return { product: p, variant: v };
    }
    return null;
  }

  // LUÔN đọc giá trị mới nhất — gọi lại ngay trước khi validate/execute.
  getStock(sku) {
    const hit = this.getVariant(sku);
    if (!hit) return null;
    return {
      sku,
      stock_qty: hit.variant.stock_qty,
      stock_reserved: hit.variant.stock_reserved || 0,
      effective: hit.variant.stock_qty - (hit.variant.stock_reserved || 0),
      price: hit.variant.price,
    };
  }

  effectiveStock(sku) {
    const s = this.getStock(sku);
    return s ? s.effective : 0;
  }

  setStock(sku, qty) {
    const hit = this.getVariant(sku);
    if (!hit) throw new Error(`setStock: unknown sku ${sku}`);
    hit.variant.stock_qty = qty; // mô phỏng can thiệp ngoài (bán kênh khác, admin sửa)
    return hit.variant;
  }

  reserve(sku, qty) {
    const hit = this.getVariant(sku);
    if (!hit) throw new Error(`reserve: unknown sku ${sku}`);
    if (hit.variant.stock_qty - (hit.variant.stock_reserved || 0) < qty) {
      return false; // không đủ — caller phải rollback
    }
    hit.variant.stock_reserved = (hit.variant.stock_reserved || 0) + qty;
    return true;
  }

  release(sku, qty) {
    const hit = this.getVariant(sku);
    if (!hit) throw new Error(`release: unknown sku ${sku}`);
    hit.variant.stock_reserved = Math.max(0, (hit.variant.stock_reserved || 0) - qty);
  }

  commitSale(sku, qty) {
    const hit = this.getVariant(sku);
    if (!hit) throw new Error(`commitSale: unknown sku ${sku}`);
    hit.variant.stock_qty -= qty;
    hit.variant.stock_reserved = Math.max(0, (hit.variant.stock_reserved || 0) - qty);
    if (hit.variant.stock_qty < 0) throw new Error(`OVERSELL tại ${sku} — cấm`);
  }

  // Trích giá trị DB của mọi money-number hợp lệ để gate đối chiếu (case 8)
  knownMoneyValues(skuList) {
    const values = new Set();
    for (const sku of skuList || []) {
      const s = this.getStock(sku);
      if (s) values.add(s.price);
    }
    for (const p of this.products) for (const v of p.variants) values.add(v.price);
    return values;
  }

  // ---- search 4 lớp ----
  // Trả { matches: [{product, variant|null, layer, score}] } — có thể nhiều product (case 6).
  // [Supervisor-approved PRODUCT-READY exception] SP tắt (p.enabled === false — soft-delete/ẩn
  // khỏi bán) KHÔNG được bot match/tư vấn ở BẤT KỲ lớp nào (L1..L4). getVariant/getStock/getProduct
  // GIỮ NGUYÊN: đơn/cũ vẫn đọc được (hủy đơn, xem chi tiết không bị gãy).
  searchProduct(text) {
    const q = normKey(text);
    if (!q) return { matches: [] };

    const found = new Map(); // product_id -> match
    const push = (product, variant, layer, score) => {
      if (product.enabled === false) return; // SP tắt -> không match
      if (!found.has(product.product_id) || found.get(product.product_id).layerScore < score) {
        found.set(product.product_id, { product, variant, layer, score, layerScore: score });
      }
    };

    // L1 — SKU exact (khách gõ mã từ ảnh/quảng cáo)
    for (const { product, variant } of this.allVariants()) {
      if (product.enabled === false) continue;
      if (q.includes(normKey(variant.sku)) || q.includes(normKey(product.sku_base))) {
        push(product, variant, 'sku', 1);
      }
    }

    // L2 — alias (dữ liệu shop nhập, không phải AI đoán)
    for (const p of this.products) {
      if (p.enabled === false) continue;
      for (const alias of [...(p.aliases || []), p.name]) {
        const a = normKey(alias);
        if (a.length >= 3 && q.includes(a)) push(p, null, 'alias', 0.95);
      }
    }

    // L3 — substring trên tên đã bỏ dấu
    for (const p of this.products) {
      if (p.enabled === false) continue;
      const name = normKey(p.name);
      if (q.includes(name) || (name.length >= 5 && name.includes(q))) {
        push(p, null, 'substring', 0.9);
      }
    }

    // L4 — fuzzy: similarity cao nhất giữa query và tên/alias, ngưỡng 0.8
    if (found.size === 0) {
      for (const p of this.products) {
        if (p.enabled === false) continue;
        const candidates = [p.name, ...(p.aliases || [])].map(normKey);
        let best = 0;
        for (const c of candidates) {
          // so trên cửa sổ trượt dài bằng candidate để tránh phạt độ dài
          if (q.length >= c.length - 3) {
            best = Math.max(best, similarity(q, c));
          }
          const words = q.split(' ');
          for (let i = 0; i < words.length; i++) {
            for (let j = i + 1; j <= words.length; j++) {
              const window = words.slice(i, j).join(' ');
              if (window.length >= 4) best = Math.max(best, similarity(window, c));
            }
          }
        }
        if (best >= FUZZY_THRESHOLD) push(p, null, 'fuzzy', best);
      }
    }

    // Gắn variant mặc định (variant đầu) nếu trúng product mà chưa chỉ variant,
    // để tầng trên còn hỏi/hỏi-list đầy đủ. Không tự chọn hộ khách khi nhiều variant.
    const matches = [...found.values()];
    return { query: text, matches };
  }
}

// ============================================================ OVERRIDES (PRODUCT-READY đợt 2)
// Áp product-overrides (added/patches/disabled) lên 1 ProductDB — MỘT NƠI DUY NHẤT, dùng chung
// bởi server.js (khi dựng App cho shop) và App (khi restart trực tiếp cùng dataDir).
// IDEMPOTENT: added chỉ push khi chưa tồn tại; patches/disabled set giá trị tuyệt đối.
// (Fix matrix PS09: SP thêm bằng API phải sống qua restart Ở MỨC APP — trước đây chỉ
//  server áp khi dựng App, App dựng thẳng từ dataDir bị mất SP.)
function applyProductOverrides(productDB, o) {
  if (!o || typeof o !== 'object') return 0;
  let applied = 0;
  for (const p of o.added || []) {
    if (!p || !p.sku_base || productDB.getProductByBase(p.sku_base)) continue;
    productDB.products.push(JSON.parse(JSON.stringify(p)));
    applied += 1;
  }
  for (const [skuBase, patch] of Object.entries(o.patches || {})) {
    const p = productDB.getProductByBase(skuBase);
    if (!p) continue;
    if (patch.name) p.name = patch.name;
    if (patch.aliases) p.aliases = patch.aliases;
    if (patch.enabled !== undefined) p.enabled = patch.enabled;
    for (const [sku, vp] of Object.entries(patch.variants || {})) {
      const v = p.variants.find(x => x.sku === sku);
      if (!v) continue;
      if (Number.isFinite(vp.price)) v.price = vp.price;
      if (Number.isFinite(vp.stock_qty)) v.stock_qty = vp.stock_qty;
    }
    applied += 1;
  }
  for (const skuBase of Object.keys(o.disabled || {})) {
    const p = productDB.getProductByBase(skuBase);
    if (p && p.enabled !== false) { p.enabled = false; applied += 1; }
  }
  return applied;
}

module.exports = { ProductDB, FUZZY_THRESHOLD, applyProductOverrides };
