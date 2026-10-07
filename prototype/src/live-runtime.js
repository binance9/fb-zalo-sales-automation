'use strict';
// live-runtime.js — FACTORY chọn adapter BIÊN theo env (P2 LIVE-INTEGRATION).
//
//   CHANNEL_MODE  = mock | live     (mặc định mock)
//   SHIPPING_MODE = mock | ghn      (mặc định mock)
//
// Mock mode: trả null — App dựng MockCarrier/MockPlatform như cũ (regression giữ nguyên).
// Live mode: dựng MetaAdapter + ZaloAdapter (+ ChannelRouter) và/hoặc GhnAdapter với config từ
// .env.live/env qua live-env.js. Core (gate/pipeline/gateway) CHỈ gọi qua interface — KHÔNG biết
// OAuth/token/URL. Mọi adapter nhận httpFn TIÊM VÀO (opts.httpFn) để test offline không ra mạng.

const path = require('path');
const { loadEnvFile, liveConfig } = require('./live-env');
const { MetaAdapter } = require('./channel/meta-adapter');
const { ZaloAdapter, ChannelRouter } = require('./channel/zalo-adapter');
const { GhnAdapter } = require('./shipping/ghn-adapter');

const PROTO_ROOT = path.join(__dirname, '..');

// opts: { channelMode, shippingMode, httpFn, zaloTokenFile, envFile, config }
// Trả null khi mock, hoặc { meta, zalo, platform, carrier } (tùy mode).
function buildLiveExternals(opts = {}) {
  const channelMode = String(opts.channelMode || process.env.CHANNEL_MODE || 'mock').toLowerCase();
  const shippingMode = String(opts.shippingMode || process.env.SHIPPING_MODE || 'mock').toLowerCase();
  if (channelMode !== 'live' && shippingMode !== 'ghn') return null;

  // nạp .env.live (chỉ điền biến CHƯA có — env thật thắng); test có thể truyền config trực tiếp
  loadEnvFile(opts.envFile || path.join(PROTO_ROOT, '.env.live'));
  const cfg = opts.config || liveConfig();

  const ext = {};
  if (channelMode === 'live') {
    ext.meta = new MetaAdapter({
      config: cfg.meta,
      httpFn: opts.httpFn,
    });
    ext.zalo = new ZaloAdapter({
      config: cfg.zalo,
      httpFn: opts.httpFn,
      tokenFile: opts.zaloTokenFile || path.join(PROTO_ROOT, 'data', 'live', 'zalo-token.json'),
    });
    ext.platform = new ChannelRouter({ facebook: ext.meta, zalo: ext.zalo });
  }
  if (shippingMode === 'ghn') {
    ext.carrier = new GhnAdapter({
      config: cfg.ghn,
      httpFn: opts.httpFn,
    });
  }
  return ext;
}

module.exports = { buildLiveExternals, PROTO_ROOT };
