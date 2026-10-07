'use strict';
// deepseek-wire.js — NỐI LIVE DEEPSEEK KEY TỪ FILE PROVIDER CONFIG NGOÀI (SURI PHASE 1, hạng mục 4).
//
// Key DeepSeek của chủ nằm TRONG file:
//   C:\GaAi-Lab-Test\GaAiLab\backup\model-rename-20261004\provider_config.json
// JSON path: config.providerConfigRules.providerRules[] item providerId==='deepseek'
//   -> config.access.apiKey (sk-...), config.api.baseUrl ('https://api.deepseek.com/v1'),
//      personalModelIds ['deepseek-flash','deepseek-v4-pro'].
//
// WIRE = đọc file -> extract -> ghi vào AI settings CỦA SHOP (ai-provider.saveAiConfig).
// CỨM SECRETS (bắt buộc):
//   - KHÔNG in key ra console/log/báo cáo; KHÔNG trả key thô qua API (chỉ maskKey ***+4 cuối).
//   - Error message KHÔNG bao giờ ghép key vào.
// Đường dẫn file ghi đè bằng env DEEPSEEK_PROVIDER_CONFIG; mặc định đúng path trên.

const fs = require('fs');
const path = require('path');
const { maskKey, saveAiConfig } = require('./ai-provider');

const DEFAULT_PROVIDER_CONFIG_PATH = 'C:\\GaAi-Lab-Test\\GaAiLab\\backup\\model-rename-20261004\\provider_config.json';

// Model dùng cho /chat/completions thật: personalModelIds của rule là tên internal
// (deepseek-flash/deepseek-v4-pro) — API công khai của DeepSeek nhận 'deepseek-chat'
// (default) hoặc 'deepseek-reasoner'. Ghi personalModelIds vào settings để tham chiếu.
const DEFAULT_WIRE_MODEL = 'deepseek-chat';

function providerConfigPath(overrides) {
  if (overrides && overrides.file) return overrides.file;
  if (process.env.DEEPSEEK_PROVIDER_CONFIG) return process.env.DEEPSEEK_PROVIDER_CONFIG;
  return DEFAULT_PROVIDER_CONFIG_PATH;
}

// Đọc file provider_config.json -> rule deepseek. Trả {ok:true, apiKey, baseUrl, models, file}
// hoặc {ok:false, reason} — reason KHÔNG chứa key.
function readDeepseekRule(file) {
  const f = String(file || '');
  if (!f) return { ok: false, reason: 'NO_PROVIDER_CONFIG_PATH' };
  let raw;
  try { raw = fs.readFileSync(f, 'utf8'); } catch (e) {
    return { ok: false, reason: 'PROVIDER_CONFIG_UNREADABLE:' + (e && e.code ? e.code : 'io_error') };
  }
  let json;
  try { json = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'PROVIDER_CONFIG_BAD_JSON' }; }
  const rules = (((json || {}).config || {}).providerConfigRules || {}).providerRules;
  if (!Array.isArray(rules)) return { ok: false, reason: 'PROVIDER_RULES_MISSING' };
  const rule = rules.find(r => r && r.providerId === 'deepseek');
  if (!rule) return { ok: false, reason: 'DEEPSEEK_RULE_MISSING' };
  const apiKey = (((rule.config || {}).access || {}).apiKey) || '';
  const baseUrl = (((rule.config || {}).api || {}).baseUrl) || '';
  const models = Array.isArray(rule.config && rule.config.personalModelIds)
    ? rule.config.personalModelIds
    : (Array.isArray(rule.personalModelIds) ? rule.personalModelIds : []);
  if (!apiKey || !/^sk-/.test(apiKey)) return { ok: false, reason: 'DEEPSEEK_API_KEY_MISSING' };
  return { ok: true, apiKey, baseUrl, models, file: f };
}

// Wire: đọc file -> ghi AI settings shop (provider=deepseek, key, model deepseek-chat).
// Trả view ĐÃ MASK. Ném Error với code ngắn khi hỏng (caller trả 4xx/5xx) — không kèm key.
function wireDeepseek(shopSettings, overrides = {}) {
  const src = readDeepseekRule(providerConfigPath(overrides));
  if (!src.ok) { const e = new Error(src.reason); e.code = src.reason.split(':')[0]; throw e; }
  const model = String(overrides.model || DEFAULT_WIRE_MODEL).trim() || DEFAULT_WIRE_MODEL;
  // saveAiConfig validate (provider hợp lệ, key không chứa khoảng trắng) + lưu + trả view masked.
  const view = saveAiConfig(shopSettings, { provider: 'deepseek', api_key: src.apiKey, model });
  // Tham chiếu thêm (không secret): base url + model internal của rule.
  shopSettings.setMany({
    ai_deepseek_base_url: src.baseUrl || null,
    ai_deepseek_models: JSON.stringify(src.models),
    ai_deepseek_source_file: src.file,
  });
  return {
    ok: true,
    provider: 'deepseek',
    model: view.model,
    maskedKey: maskKey(src.apiKey),
    baseUrl: src.baseUrl || null,
    models: src.models,
    source_file: src.file,
    path: path.basename(src.file),
  };
}

module.exports = { readDeepseekRule, wireDeepseek, providerConfigPath, DEFAULT_PROVIDER_CONFIG_PATH, DEFAULT_WIRE_MODEL };
