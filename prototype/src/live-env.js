'use strict';
// live-env.js — env-mini parser (thuần Node, không npm) + redaction cho LIVE mode (P2).
//
// - loadEnvFile(file): nạp .env.live (mặc định prototype/.env.live) NẾU file tồn tại,
//   KHÔNG BAO GIỜ override biến môi trường có sẵn (env thật > .env.live).
// - liveConfig(): trả config nhóm theo kênh (meta/zalo/ghn) cho adapters BIÊN.
// - redactSecret(v): chỉ hiện `***` + 4 ký tự cuối (debug); redactDeep() quét object
//   theo TÊN KHÓA nhạy cảm — mọi đường status/health/UI PHẢI đi qua đây trước khi ra ngoài.
//
// CỨM SECRETS (bắt buộc): không log giá trị secret, API/UI không trả secret, health redact.

const fs = require('fs');

// Danh sách key chuẩn của .env.live (tham chiếu — parser không giới hạn key)
const KEYS = [
  'META_APP_ID', 'META_APP_SECRET', 'META_PAGE_ID', 'META_PAGE_ACCESS_TOKEN', 'META_VERIFY_TOKEN', 'META_API_VERSION',
  'ZALO_APP_ID', 'ZALO_APP_SECRET', 'ZALO_OA_ID', 'ZALO_ACCESS_TOKEN', 'ZALO_REFRESH_TOKEN',
  'GHN_TOKEN', 'GHN_SHOP_ID', 'GHN_BASE_URL',
  'WEBHOOK_PUBLIC_BASE',
];

// Parse text .env: bỏ dòng trống/comment #, KEY=VALUE, strip nháy đơn/kép. Không export/import shell.
function parseEnvText(text) {
  const out = {};
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
        (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

// Nạp file env vào process.env CHỈ cho biến CHƯA tồn tại (không override). Idempotent.
function loadEnvFile(file) {
  let applied = 0;
  let existed = false;
  if (file && fs.existsSync(file)) {
    existed = true;
    const vars = parseEnvText(fs.readFileSync(file, 'utf8'));
    for (const k of Object.keys(vars)) {
      if (process.env[k] === undefined) { process.env[k] = vars[k]; applied += 1; }
    }
  }
  return { existed, applied, file: file || null };
}

function get(name, dflt) {
  const v = process.env[name];
  return (v === undefined || v === '') ? (dflt !== undefined ? dflt : null) : v;
}

function isConfigured(v) { return v !== null && v !== undefined && String(v).length > 0; }

// Config LIVE nhóm theo kênh — adapters BIÊN đọc, core KHÔNG đụng object này.
function liveConfig() {
  return {
    meta: {
      appId: get('META_APP_ID'),
      appSecret: get('META_APP_SECRET'),
      pageId: get('META_PAGE_ID'),
      pageAccessToken: get('META_PAGE_ACCESS_TOKEN'),
      verifyToken: get('META_VERIFY_TOKEN'),
      apiVersion: get('META_API_VERSION', 'v21.0'),
    },
    zalo: {
      appId: get('ZALO_APP_ID'),
      appSecret: get('ZALO_APP_SECRET'),
      oaId: get('ZALO_OA_ID'),
      accessToken: get('ZALO_ACCESS_TOKEN'),
      refreshToken: get('ZALO_REFRESH_TOKEN'),
    },
    ghn: {
      token: get('GHN_TOKEN'),
      shopId: get('GHN_SHOP_ID'),
      baseUrl: get('GHN_BASE_URL', 'https://dev-online-gateway.ghn.vn'),
    },
    webhookPublicBase: get('WEBHOOK_PUBLIC_BASE'),
  };
}

// REDACT: chỉ hiện *** + 4 ký tự cuối nếu cần debug. Giá trị rỗng -> '(empty)'.
function redactSecret(v) {
  const s = String(v === null || v === undefined ? '' : v);
  if (!s) return '(empty)';
  if (s.length <= 4) return '***';
  return '***' + s.slice(-4);
}

const SECRET_KEY_RE = /(secret|token|password|passwd|api_?key|appkey|app_secret|access)/i;

// Quét đệ quy object và redact mọi giá trị string có TÊN KHÓA nhạy cảm — dùng cho
// mọi object status/health/config trước khi ra log/API/UI (CỨM SECRETS).
function redactDeep(x) {
  if (Array.isArray(x)) return x.map(redactDeep);
  if (x && typeof x === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(x)) {
      o[k] = (typeof v === 'string' && SECRET_KEY_RE.test(k)) ? redactSecret(v) : redactDeep(v);
    }
    return o;
  }
  return x;
}

module.exports = { parseEnvText, loadEnvFile, liveConfig, isConfigured, redactSecret, redactDeep, KEYS, SECRET_KEY_RE };
