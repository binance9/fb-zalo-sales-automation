'use strict';
// shop-profile.js — HỒ SƠ SHOP CHO AI (SURI PHASE 1, hạng mục 3 — mục 5 spec).
//
// Lưu ShopSettings key 'shop_profile' (JSON) trong dataDir CỦA SHOP. Đủ field:
//   ten, logo, linhVuc, diaChi, hotline, chinhSachDoiTra, gioLamViec, giongNoi,
//   cachXungHo, quyTacTuVan, quyTacChotDon, faq[{q,a}], thongTinCamNoi[], cta, chinhSachGiaoHang.
//
// RÀNG BUỘC:
//  - KHÔNG nhận pattern secret (sk-/token/secret/password/api_key) trong BẤT KỲ field nào
//    (tái dùng SECRET_VALUE_RE của prompt-builder — một luật cho cả profile lẫn prompt).
//  - buildSystemPrompt đọc shop-profile với ĐỘ ƯU TIÊN CAO HƠN settings prompt cũ
//    (merge ở server: profile đè key trùng tên).
//  - getShopProfile() trả DEFAULTS khi chưa cấu hình — prompt builder không bao giờ crash.

const { SECRET_VALUE_RE } = require('./prompt-builder');

const PROFILE_FIELDS = [
  'ten', 'logo', 'linhVuc', 'diaChi', 'hotline', 'chinhSachDoiTra', 'gioLamViec',
  'giongNoi', 'cachXungHo', 'quyTacTuVan', 'quyTacChotDon', 'cta', 'chinhSachGiaoHang',
];
const STRING_FIELDS = [...PROFILE_FIELDS]; // mọi field scalar đều string
const LIST_FIELDS = { faq: 'faq', thongTinCamNoi: 'list' };

const DEFAULTS = {
  ten: null, logo: null, linhVuc: null, diaChi: null, hotline: null,
  chinhSachDoiTra: null, gioLamViec: null, giongNoi: null, cachXungHo: null,
  quyTacTuVan: null, quyTacChotDon: null, faq: [], thongTinCamNoi: [], cta: null,
  chinhSachGiaoHang: null,
};

function isBlank(v) { return v === undefined || v === null || (typeof v === 'string' && !v.trim()); }

// Validate body gửi lên POST /api/shop-profile. Trả {ok, errors[], profile} — profile CHỈ gồm
// field hợp lệ (không nhận field lạ — chống nhét dữ liệu rác/secret qua key lạ).
function validateShopProfile(body) {
  const errors = [];
  const profile = {};
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  for (const f of STRING_FIELDS) {
    if (b[f] === undefined) continue; // không gửi = giữ nguyên (server merge)
    if (typeof b[f] !== 'string') { errors.push(`${f}: phải là chuỗi`); continue; }
    const v = b[f].trim();
    if (!v) continue; // rỗng = xoá field
    if (SECRET_VALUE_RE.test(v)) { errors.push(`${f}: chứa pattern secret (sk-/token/secret/password/api-key) — cấm đưa vào hồ sơ AI`); continue; }
    if (v.length > 2000) { errors.push(`${f}: quá dài (tối đa 2000 ký tự)`); continue; }
    profile[f] = v;
  }
  for (const [f, kind] of Object.entries(LIST_FIELDS)) {
    if (b[f] === undefined) continue;
    if (!Array.isArray(b[f])) { errors.push(`${f}: phải là mảng`); continue; }
    const items = [];
    b[f].forEach((it, i) => {
      if (kind === 'faq') {
        const q = it && typeof it.q === 'string' ? it.q.trim() : '';
        const a = it && typeof it.a === 'string' ? it.a.trim() : '';
        if (!q && !a) return;
        for (const [lbl, v] of [['q', q], ['a', a]]) {
          if (v && SECRET_VALUE_RE.test(v)) { errors.push(`${f}[${i}].${lbl}: chứa pattern secret — cấm`); return; }
        }
        items.push({ q, a });
      } else {
        if (typeof it !== 'string') { errors.push(`${f}[${i}]: phải là chuỗi`); return; }
        const v = it.trim();
        if (!v) return;
        if (SECRET_VALUE_RE.test(v)) { errors.push(`${f}[${i}]: chứa pattern secret — cấm`); return; }
        items.push(v.slice(0, 1000));
      }
    });
    profile[f] = items;
  }
  return { ok: errors.length === 0, errors, profile };
}

// Đọc profile hiện có (kèm DEFAULTS cho field thiếu). shopSettings = ShopSettings instance.
function getShopProfile(shopSettings) {
  let saved = {};
  try { saved = JSON.parse(shopSettings.get('shop_profile') || '{}') || {}; } catch (e) { saved = {}; }
  const merged = { ...DEFAULTS };
  for (const f of STRING_FIELDS) if (!isBlank(saved[f])) merged[f] = saved[f];
  for (const f of Object.keys(LIST_FIELDS)) if (Array.isArray(saved[f])) merged[f] = saved[f];
  return merged;
}

// Merge + lưu. bodyOnlyNewFields=true: POST gửi phần tử rỗng không xoá field cũ (merge semantics).
function saveShopProfile(shopSettings, body) {
  const v = validateShopProfile(body);
  if (!v.ok) return v;
  const current = (() => { try { return JSON.parse(shopSettings.get('shop_profile') || '{}') || {}; } catch (e) { return {}; } })();
  const next = { ...current };
  for (const [k, val] of Object.entries(v.profile)) {
    if (val === null || val === '' || (Array.isArray(val) && !val.length)) delete next[k]; // gửi rỗng = xoá
    else next[k] = val;
  }
  shopSettings.set('shop_profile', JSON.stringify(next));
  return { ok: true, errors: [], profile: getShopProfile(shopSettings) };
}

// Map profile -> config cho buildSystemPrompt (tên key trùng với prompt config cũ để profile
// ĐÈ trực tiếp settings cũ khi merge ở server — độ ưu tiên cao hơn).
function profileToPromptConfig(profile) {
  const p = profile || {};
  const cfg = {};
  if (p.giongNoi) cfg.giongNoi = p.giongNoi;
  if (p.cachXungHo) cfg.cachXungHo = p.cachXungHo;
  if (p.chinhSachDoiTra) cfg.chinhSachDoiTra = p.chinhSachDoiTra;
  if (p.gioLamViec) cfg.gioLamViec = p.gioLamViec;
  if (p.quyTacChotDon) cfg.quyTacChotDon = p.quyTacChotDon;
  if (Array.isArray(p.faq) && p.faq.length) cfg.faq = p.faq;
  return cfg;
}

// Merge prompt config: profile có ĐỘ ƯU TIÊN CAO HƠN legacy (field profile KHÔNG RỖNG đè
// field trùng tên; field profile rỗng/không có -> giữ legacy). MỘT NƠI cho server /api/prompt
// và mọi nơi cần build prompt — tránh lệch semantics giữa các caller.
function mergePromptConfig(legacyCfg, profile) {
  const legacy = legacyCfg && typeof legacyCfg === 'object' ? legacyCfg : {};
  const merged = { ...legacy };
  const p = profile && typeof profile === 'object' ? profile : {};
  for (const [k, v] of Object.entries(p)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && !v.length) continue;
    if (typeof v === 'string' && !v.trim()) continue;
    merged[k] = v;
  }
  return merged;
}

module.exports = {
  PROFILE_FIELDS, STRING_FIELDS, LIST_FIELDS, DEFAULTS,
  validateShopProfile, getShopProfile, saveShopProfile, profileToPromptConfig, mergePromptConfig, isBlank,
};
