'use strict';
// shop-settings.js — SETTINGS STORE per shop (PHASE PRODUCT-READY).
//
// File JSON trong dataDir CỦA SHOP (data/shops/<shop_id>/settings.json) — "mọi dữ liệu mới
// nằm trong dataDir của shop". Tương thích .env.live: key dùng CÙNG TÊN (META_PAGE_ACCESS_TOKEN,
// GHN_TOKEN, ...) để onboarding đọc được từ cả env lẫn settings shop (settings shop THẮNG env).
//
// CỨM SECRETS: view() trả giá trị ĐÃ REDACT (redactSecret của live-env — *** + 4 cuối);
// không có đường nào trả secret thô ra ngoài. Ghi file vẫn cần giá trị thô (adapter dùng).

const fs = require('fs');
const path = require('path');
const { redactSecret } = require('./live-env');

// AICAKE (G2): công tắc TỰ ĐỘNG COMMENT & INBOX — keys mặc định của settings shop.
// Pipeline đọc FRESH mỗi comment (ShopSettings trong dataDir shop) nên đổi công tắc qua
// settingsFor(shopId).set()/API có hiệu lực NGAY, không cần restart.
const COMMENT_FLOW_DEFAULTS = {
  auto_reply_comment: true,       // tự động trả lời bình luận (câu hỏi / ý định mua)
  hide_negative_comment: true,    // ẩn comment tiêu cực (Phase-2 gọi Graph API — lab: mock)
  auto_inbox_from_comment: true,  // khách có ý định mua từ comment -> đẩy vào inbox bán
};

class ShopSettings {
  constructor(dataDir, fileName = 'settings.json') {
    this.file = path.join(dataDir, fileName);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.data = {};
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch (e) { this.data = {}; }
  }
  get(key, dflt) {
    const v = this.data[key];
    return (v === undefined || v === null || v === '') ? (dflt !== undefined ? dflt : null) : v;
  }
  set(key, value) { this.data[key] = value; this.save(); return value; }
  setMany(obj) { Object.assign(this.data, obj); this.save(); }
  has(key) { const v = this.data[key]; return v !== undefined && v !== null && v !== ''; }
  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }
  // AICAKE (G2): đọc 3 công tắc comment-flow theo mặc định ở trên (bool chấp nhận true/'true'/1).
  commentFlowCfg() {
    const bool = k => {
      const v = this.get(k, COMMENT_FLOW_DEFAULTS[k]);
      return v === true || v === 'true' || v === 1 || v === '1';
    };
    return {
      auto_reply_comment: bool('auto_reply_comment'),
      hide_negative_comment: bool('hide_negative_comment'),
      auto_inbox_from_comment: bool('auto_inbox_from_comment'),
    };
  }
  // Bảng redact cho key nhạy cảm (token/secret/key/password) — mọi lần TRẢ RA NGOÀI đi qua đây.
  view() {
    const out = {};
    for (const [k, v] of Object.entries(this.data)) {
      out[k] = /secret|token|password|api_?key|access/i.test(k) ? redactSecret(v) : v;
    }
    return out;
  }
}

module.exports = { ShopSettings, COMMENT_FLOW_DEFAULTS };
