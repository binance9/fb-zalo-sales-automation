'use strict';
// test/live-adapters.js — BATTERY P2 LIVE-INTEGRATION (offline, mock http — KHÔNG ra mạng).
//
// Phạm vi theo lệnh P2:
//   META  : signature valid/invalid; normalize text + comment + delivery/read/echo;
//           dedupe trùng platform id (INV-1); >24h vẫn bị Gate chặn (không đổi gate — BL-1);
//           token không nằm trong URL outbound.
//   ZALO  : refresh SINGLE-FLIGHT (mock http chậm 200ms, 5 gọi đồng thời -> đúng 1 HTTP refresh,
//           cả 5 nhận token mới); ATOMIC save cặp token xoay vòng (file riêng, không còn .tmp);
//           normalize user_send_text/image/audio(seen/unfollow); sendMessage sync: HTTP 200 +
//           error != 0 KHÔNG được coi là thành công; quota: chỉ tin field API trả về.
//   GHN   : create idempotent theo ClientOrderCode (HTTP lần 2 không xảy ra, trả đơn cũ);
//           HTTP 200 + response code lỗi -> KHÔNG thành công; timeout -> memo UNKNOWN ->
//           attempt sau TRA CỨU trước (INV-2); cancel idempotent; webhook normalize idempotent.
//   PERSISTENCE: App persist=true -> 3 tin + 1 đơn -> restart x3 -> đếm customers/messages/orders
//           + SHA256 db.json GIỮ NGUYÊN + db.backup.json tồn tại.
//   SECRETS: live-mode giả -> mọi status "health/UI" không chứa chuỗi token; redact ***+4 cuối.
// Adapter ĐỀU TIÊM httpFn (dependency injection) — battery 100% offline.
// Exit 0 khi toàn bộ PASS.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const assert = require('assert');
const { App } = require('../src/app');
const { MetaAdapter } = require('../src/channel/meta-adapter');
const { ZaloAdapter, ChannelRouter } = require('../src/channel/zalo-adapter');
const { GhnAdapter } = require('../src/shipping/ghn-adapter');
const { buildLiveExternals } = require('../src/live-runtime');
const { parseEnvText, loadEnvFile, redactSecret, redactDeep } = require('../src/live-env');

const DATA = path.join(__dirname, '..', 'data', 'test-runs');
const dir = name => path.join(DATA, name);
const sha256File = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============================================================ mock http helpers
// QUAN TRỌNG: adapters gọi httpFn ĐỒNG BỘ (hợp đồng gate) — không có delayMs thì mock trả
// GIÁ TRỊ THƯỜNG (không Promise); có delayMs (chỉ dùng cho test single-flight Zalo) mới trả Promise.
function mockHttp(routes) {
  const calls = [];
  const replyOf = (r, req) => (typeof r.reply === 'function' ? r.reply(req) : r.reply);
  const fn = req => {
    calls.push({ url: req.url, headers: req.headers, body: req.body });
    const r = routes.find(x => x.match(req.url));
    if (!r) return { ok: true, status: 404, bodyText: JSON.stringify({ code: '404', message: 'no route' }) };
    if (r.delayMs) return sleep(r.delayMs).then(() => replyOf(r, req));
    return replyOf(r, req);
  };
  fn.calls = calls;
  return fn;
}
const countCalls = (fn, substr) => fn.calls.filter(c => c.url.includes(substr)).length;

// T0 = 2026-10-04T08:00Z — TRƯỚC clockStart của App (2026-10-04T09:00Z) 1h => window 24h ĐANG MỞ
const T0 = Date.parse('2026-10-04T08:00:00.000Z');

function metaTextWebhook(overrides = {}) {
  const b = {
    object: 'page',
    entry: [{
      id: 'PAGE1',
      time: T0,
      messaging: [{
        sender: { id: 'PSID_1' },
        recipient: { id: 'PAGE1' },
        timestamp: T0,
        message: { mid: 'm.mid.1', text: 'còn hàng không shop?' },
      }],
    }],
    ...overrides,
  };
  return b;
}

// ============================================================ battery
const TESTS = [];
const T = (n, group, desc, fn) => TESTS.push({ n, group, desc, fn });

// ---------------------------------------------------------- META
T('M1', 'META', 'signature VALID: HMAC-SHA256(raw, appSecret) khớp X-Hub-Signature-256 -> PASS', () => {
  const secret = 'meta_app_secret_abcdef';
  const meta = new MetaAdapter({ config: { appSecret: secret, pageAccessToken: 'ptk', verifyToken: 'vt' } });
  const raw = JSON.stringify(metaTextWebhook());
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
  assert.strictEqual(meta.rawBodyValid(raw, sig), true);
});

T('M2', 'META', 'signature INVALID: body sửa/header sai/thiếu header/verify token sai -> FAIL', () => {
  const secret = 'meta_app_secret_abcdef';
  const meta = new MetaAdapter({ config: { appSecret: secret, pageAccessToken: 'ptk', verifyToken: 'vtok' } });
  const raw = JSON.stringify(metaTextWebhook());
  const good = 'sha256=' + crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
  const tampered = JSON.stringify(metaTextWebhook({ entry: [{ id: 'EVIL', messaging: [] }] }));
  assert.strictEqual(meta.rawBodyValid(tampered, good), false, 'body khác chữ ký phải FAIL');
  assert.strictEqual(meta.rawBodyValid(raw, 'sha256=' + '0'.repeat(64)), false, 'chữ ký sai phải FAIL');
  assert.strictEqual(meta.rawBodyValid(raw, 'md5=abc'), false, 'prefix sai phải FAIL');
  assert.strictEqual(meta.rawBodyValid(raw, undefined), false, 'thiếu header phải FAIL');
  assert.strictEqual(meta.verifySubscribe({ 'hub.mode': 'subscribe', 'hub.verify_token': 'SAI', 'hub.challenge': 'CH' }), null, 'verify token sai phải từ chối');
  assert.strictEqual(meta.verifySubscribe({ 'hub.mode': 'subscribe', 'hub.verify_token': 'vtok', 'hub.challenge': 'CHALLENGE42' }), 'CHALLENGE42', 'đúng token -> echo challenge');
});

T('M3', 'META', 'normalize TEXT: mid -> platformEventId, PSID -> customer_ref, có timestamp_platform', () => {
  const meta = new MetaAdapter({ config: { appSecret: 's', pageAccessToken: 't', verifyToken: 'v' } });
  const out = meta.normalizeWebhook(metaTextWebhook(), { receivedAt: '2026-10-05T00:00:00.000Z' });
  assert.strictEqual(out.events.length, 1);
  assert.strictEqual(out.receipts.length, 0);
  const ev = out.events[0];
  assert.strictEqual(ev.channel, 'facebook');
  assert.strictEqual(ev.type, 'message');
  assert.strictEqual(ev.platformEventId, 'm.mid.1');
  assert.strictEqual(ev.payload.customer_ref, 'PSID_1');
  assert.strictEqual(ev.payload.thread_id, 'PSID_1');
  assert.strictEqual(ev.payload.kind, 'text');
  assert.strictEqual(ev.payload.text, 'còn hàng không shop?');
  assert.strictEqual(ev.payload.platform_message_id, 'm.mid.1');
  assert.strictEqual(ev.payload.timestamp_platform, new Date(T0).toISOString());
  // postback (ngoài phạm vi P2) -> ignored, KHÔNG sinh event user
  const out2 = meta.normalizeWebhook({
    entry: [{ id: 'P', messaging: [{ sender: { id: 'X' }, recipient: { id: 'P' }, postback: { payload: 'GET_STARTED' } }] }],
  });
  assert.strictEqual(out2.events.length, 0);
  assert.ok(out2.ignored >= 1);
});

T('M4', 'META', 'normalize COMMENT (feed): comment_id -> platformEventId, fbuser:<id> -> customer_ref', () => {
  const meta = new MetaAdapter({ config: { appSecret: 's', pageAccessToken: 't', verifyToken: 'v' } });
  const body = {
    entry: [{
      id: 'PAGE1',
      changes: [{
        field: 'feed',
        value: {
          item: 'comment', verb: 'add', comment_id: 'cmt_99',
          from: { id: '100022', name: 'Khách Comment' },
          message: 'giá bao nhiêu vậy shop', created_time: '2026-10-05T01:00:00+0700',
          post_id: 'post_7',
        },
      }],
    }],
  };
  const out = meta.normalizeWebhook(body);
  assert.strictEqual(out.events.length, 1);
  const ev = out.events[0];
  assert.strictEqual(ev.platformEventId, 'comment:cmt_99');
  assert.strictEqual(ev.payload.customer_ref, 'fbuser:100022');
  assert.strictEqual(ev.payload.text, 'giá bao nhiêu vậy shop');
  assert.strictEqual(ev.payload.origin, 'comment');
  // verb remove -> ignored (không event)
  const out2 = meta.normalizeWebhook({
    entry: [{ id: 'P', changes: [{ field: 'feed', value: { item: 'comment', verb: 'remove', comment_id: 'cmt_99' } }] }],
  });
  assert.strictEqual(out2.events.length, 0);
});

T('M5', 'META', 'normalize DELIVERY/READ/ECHO -> receipts (message_delivery/message_read/message_echo); echo KHÔNG sinh user event (không mở window)', () => {
  const meta = new MetaAdapter({ config: { appSecret: 's', pageAccessToken: 't', verifyToken: 'v' } });
  const out = meta.normalizeWebhook({
    entry: [{
      id: 'PAGE1',
      messaging: [
        { sender: { id: 'PSID_1' }, recipient: { id: 'PAGE1' }, timestamp: 1696500100000, delivery: { mids: ['m.mid.1'], watermark: 1696500100000 } },
        { sender: { id: 'PSID_1' }, recipient: { id: 'PAGE1' }, timestamp: 1696500200000, read: { watermark: 1696500200000, mid: 'm.mid.1' } },
        { sender: { id: 'PAGE1' }, recipient: { id: 'PSID_1' }, timestamp: 1696500005000, message: { is_echo: true, mid: 'm.mid.1', text: 'bot reply' } },
      ],
    }],
  });
  assert.strictEqual(out.events.length, 0, 'delivery/read/echo KHÔNG được thành event user');
  assert.strictEqual(out.receipts.length, 3);
  const kinds = out.receipts.map(r => r.kind).sort();
  assert.deepStrictEqual(kinds, ['message_delivery', 'message_echo', 'message_read']);
  const delivery = out.receipts.find(r => r.kind === 'message_delivery');
  assert.strictEqual(delivery.mid, 'm.mid.1');
  assert.strictEqual(delivery.conversation_id, 'facebook:PSID_1');
});

T('M6', 'META', 'DEDUPE: cùng platform id nhận 2 lần -> lần 2 duplicate:true, khách nhận ĐÚNG 1 tin (INV-1)', () => {
  const app1 = new App({ dataDir: dir('live-meta-dedupe') });
  const meta = new MetaAdapter({ config: { appSecret: 's', pageAccessToken: 't', verifyToken: 'v' } });
  const norm = meta.normalizeWebhook(metaTextWebhook());
  const r1 = app1.receive(norm.events[0]);
  assert.strictEqual(r1.accepted, true);
  app1.gateway.processQueue();
  const r2 = app1.receive(norm.events[0]);
  assert.strictEqual(r2.duplicate, true);
  app1.gateway.processQueue();
  // normalize cùng webhook 2 lần cũng phải deterministic (cùng event_id)
  const norm2 = meta.normalizeWebhook(metaTextWebhook());
  assert.strictEqual(norm2.events[0].platformEventId, norm.events[0].platformEventId);
  assert.strictEqual(app1.platform.sentCalls.length, 1, 'khách phải nhận đúng 1 tin AI reply');
  const conv = app1.store.findOne('conversations', c => c.platform_thread_id === 'PSID_1');
  assert.ok(conv, 'conversation sinh từ webhook thật');
});

T('M7', 'META', '>24h im lặng: event user cũ 25h -> Gate CHẶN auto-reply (fb_window_closed), 0 platform call (không đổi gate)', () => {
  const app1 = new App({ dataDir: dir('live-meta-window') });
  const meta = new MetaAdapter({ config: { appSecret: 's', pageAccessToken: 't', verifyToken: 'v' } });
  const oldMs = Date.parse('2026-10-04T09:00:00.000Z') - 25 * 3600 * 1000; // trước clockStart 25h
  const body = { entry: [{ id: 'P', messaging: [{ sender: { id: 'PSID_OLD' }, recipient: { id: 'P' }, timestamp: oldMs, message: { mid: 'm.old.1', text: 'shop ơi còn hàng không' } }] }] };
  const norm = meta.normalizeWebhook(body);
  assert.strictEqual(norm.events[0].payload.timestamp_platform, new Date(oldMs).toISOString());
  app1.receive(norm.events[0]);
  app1.gateway.processQueue();
  assert.strictEqual(app1.platform.sentCalls.length, 0, 'window đóng -> 0 tin AI tự gửi');
  assert.ok(app1.metric('gate_rejected_fb_window_closed') >= 1, 'gate phải REJECT fb_window_closed');
  const w = app1.gate.windowState(app1.store.findOne('conversations', c => c.platform_thread_id === 'PSID_OLD'));
  assert.strictEqual(w.open, false);
  assert.strictEqual(w.last_user_event_ts, new Date(oldMs).toISOString(), 'last_user_event_ts = mốc event user (gateway ghi, không đổi)');
});

T('M8', 'META', 'OUTBOUND: token đi Authorization header, KHÔNG nằm trong URL; response message_id -> ok', () => {
  const TOKEN = 'EAAG_fake_page_token_123456';
  const http = mockHttp([{
    match: u => u.includes('graph.facebook.com'),
    reply: () => ({ ok: true, status: 200, bodyText: JSON.stringify({ recipient_id: 'PSID_1', message_id: 'm.out.9' }) }),
  }]);
  const meta = new MetaAdapter({ config: { appSecret: 's', pageAccessToken: TOKEN, verifyToken: 'v' }, httpFn: http });
  const r = meta.sendMessage({ clientMessageId: 'cm1', to: 'facebook:PSID_1', text: 'Dạ còn shop ạ' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mid, 'm.out.9');
  assert.strictEqual(http.calls.length, 1);
  assert.ok(!http.calls[0].url.includes(TOKEN), 'token KHÔNG được nằm trong URL');
  assert.strictEqual(http.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  const body = JSON.parse(http.calls[0].body);
  assert.strictEqual(body.recipient.id, 'PSID_1');
  assert.strictEqual(body.message.text, 'Dạ còn shop ạ');
  // lỗi auth code 190 -> error_type 'auth' (health -> PERMISSION_REQUIRED), ok=false
  const http2 = mockHttp([{ match: () => true, reply: () => ({ ok: true, status: 401, bodyText: JSON.stringify({ error: { message: 'Error validating access token', code: 190 } }) }) }]);
  const meta2 = new MetaAdapter({ config: { appSecret: 's', pageAccessToken: 'x', verifyToken: 'v' }, httpFn: http2 });
  const r2 = meta2.sendMessage({ clientMessageId: 'cm2', to: 'facebook:PSID_1', text: 'hi' });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(meta2.state.last_error_type, 'auth');
  // timeout -> {timeout:true} (INV-2: chưa biết kết quả, không blind retry)
  const http3 = mockHttp([{ match: () => true, reply: () => ({ ok: false, timeout: true }) }]);
  const meta3 = new MetaAdapter({ config: { appSecret: 's', pageAccessToken: 'x', verifyToken: 'v' }, httpFn: http3 });
  const r3 = meta3.sendMessage({ clientMessageId: 'cm3', to: 'facebook:PSID_1', text: 'hi' });
  assert.deepStrictEqual(r3, { ok: false, timeout: true });
});

// ---------------------------------------------------------- ZALO
T('Z1', 'ZALO', 'refresh SINGLE-FLIGHT: 5 gọi đồng thời (http chậm 200ms) -> đúng 1 HTTP call, cả 5 nhận token mới', async () => {
  const tokenFile = path.join(DATA, 'live-zalo-token.json');
  try { fs.rmSync(tokenFile, { force: true }); } catch (e) { void e; }
  let httpCalls = 0;
  const slowHttp = async () => {
    httpCalls += 1;
    await sleep(200);
    return { ok: true, status: 200, bodyText: JSON.stringify({ access_token: 'AT_NEW_123456', refresh_token: 'RT_NEW_654321', expires_in: 90000 }) };
  };
  const za = new ZaloAdapter({
    config: { appId: 'app1', appSecret: 'sk_1', oaId: 'oa1', refreshToken: 'RT_OLD_000' },
    httpFn: slowHttp, tokenFile,
  });
  const results = await Promise.all([
    za.refreshToken(), za.refreshToken(), za.refreshToken(), za.refreshToken(), za.refreshToken(),
  ]);
  assert.strictEqual(httpCalls, 1, `phải đúng 1 HTTP refresh thật (thấy ${httpCalls})`);
  assert.strictEqual(za.refreshCalls.length, 1);
  for (const r of results) {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.access_token, 'AT_NEW_123456', 'cả 5 nhận CÙNG token mới');
    assert.strictEqual(r.refresh_token, 'RT_NEW_654321', 'refresh token xoay vòng được lưu');
  }
  assert.strictEqual(za.state.token_expired, false);
});

T('Z2', 'ZALO', 'ATOMIC save cặp token xoay vòng: file riêng ngoài dataDir test, không còn .tmp', async () => {
  const tokenFile = path.join(DATA, 'live-zalo-token.json');
  assert.ok(fs.existsSync(tokenFile), 'token file phải được ghi (từ Z1)');
  const j = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  assert.strictEqual(j.access_token, 'AT_NEW_123456');
  assert.strictEqual(j.refresh_token, 'RT_NEW_654321', 'refresh MỚI phải được lưu đè (rotation)');
  assert.ok(Number.isFinite(j.expires_at) && j.expires_at > Date.now(), 'expires_at = now + expires_in');
  const leftovers = fs.readdirSync(DATA).filter(f => f.startsWith('live-zalo-token.json') && f.includes('.tmp'));
  assert.strictEqual(leftovers.length, 0, 'không được để lại file .tmp (atomic rename)');
  // adapter MỚI cùng tokenFile -> nạp token mới nhất từ file (không cần refresh lại)
  const httpNoCall = mockHttp([{ match: () => true, reply: () => ({ ok: true, status: 200, bodyText: '{"error":0,"data":{"msg_id":"m1"}}' }) }]);
  const za2 = new ZaloAdapter({
    config: { appId: 'app1', appSecret: 'sk_1', oaId: 'oa1' },
    httpFn: httpNoCall, tokenFile,
  });
  const r = za2.sendMessage({ clientMessageId: 'c1', to: 'zalo:887766', text: 'Dạ bên em còn nha anh' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(httpNoCall.calls.length, 1, 'token từ file dùng gửi ngay, KHÔNG refresh thêm');
  assert.strictEqual(httpNoCall.calls[0].headers.access_token, 'AT_NEW_123456');
});

T('Z3', 'ZALO', 'normalize: user_send_text/image + audio CHỈ đánh dấu voice_not_enabled + seen=receipt + unfollow=opt_out', () => {
  const za = new ZaloAdapter({ config: { appId: 'a', appSecret: 's', oaId: 'o' }, httpFn: mockHttp([]) });
  const out1 = za.normalizeWebhook({
    event_name: 'user_send_text', app_id: 'a', sender: { id: '887766' }, recipient: { id: 'o' },
    timestamp: 1696500000000, message: { msg_id: 'zmsg1', text: 'tra hoa say con khong shop' },
  });
  assert.strictEqual(out1.events.length, 1);
  assert.strictEqual(out1.events[0].channel, 'zalo');
  assert.strictEqual(out1.events[0].platformEventId, 'zlmsg:zmsg1');
  assert.strictEqual(out1.events[0].payload.customer_ref, '887766');
  assert.strictEqual(out1.events[0].payload.text, 'tra hoa say con khong shop');

  const out2 = za.normalizeWebhook({
    event_name: 'user_send_image', sender: { id: '887766' }, timestamp: 1696500001000,
    message: { msg_id: 'zmsg2', attachments: [{ type: 'image', payload: { url: 'https://zalo.img/1.jpg', thumbnail: 'https://zalo.img/1_t.jpg' } }] },
  });
  assert.strictEqual(out2.events[0].payload.kind, 'image');
  assert.strictEqual(out2.events[0].payload.media.platform_url, 'https://zalo.img/1.jpg');

  const out3 = za.normalizeWebhook({
    event_name: 'user_send_audio', sender: { id: '887766' }, timestamp: 1696500002000,
    message: { msg_id: 'zmsg3', attachments: [{ type: 'audio', payload: { url: 'https://zalo.vn/voice.amr' } }] },
  });
  assert.strictEqual(out3.events[0].payload.kind, 'voice');
  assert.strictEqual(out3.events[0].payload.voice_not_enabled, true, 'voice CHỈ được đánh dấu chưa bật');

  const out4 = za.normalizeWebhook({
    event_name: 'user_seen_message', sender: { id: '887766' }, timestamp: 1696500003000,
    message: { msg_id: 'zmsg1' },
  });
  assert.strictEqual(out4.events.length, 0);
  assert.strictEqual(out4.receipts.length, 1);
  assert.strictEqual(out4.receipts[0].kind, 'user_seen_message');
  assert.strictEqual(out4.receipts[0].conversation_id, 'zalo:887766');

  const out5 = za.normalizeWebhook({
    event_name: 'unfollow', sender: { id: '887766' }, timestamp: 1696500004000,
  });
  assert.strictEqual(out5.events[0].type, 'opt_out_signal', 'unfollow -> opt_out cứng (case 18)');
  // dedupe: normalize cùng webhook 2 lần -> cùng event_id
  const out6 = za.normalizeWebhook({
    event_name: 'user_send_text', sender: { id: '887766' }, timestamp: 1696500000000,
    message: { msg_id: 'zmsg1', text: 'tra hoa say con khong shop' },
  });
  assert.strictEqual(out6.events[0].platformEventId, out1.events[0].platformEventId);
});

T('Z4', 'ZALO', 'send CS: HTTP 200 + error!=0 KHÔNG được coi là thành công; error===0 mới ok; timeout -> timeout:true', () => {
  const httpOk = mockHttp([{ match: () => true, reply: () => ({ ok: true, status: 200, bodyText: JSON.stringify({ error: 0, message: 'Success', data: { msg_id: 'zm9' } }) }) }]);
  const zaOk = new ZaloAdapter({
    config: { appId: 'a', appSecret: 's', oaId: 'o', accessToken: 'AT', refreshToken: 'RT' },
    httpFn: httpOk, tokenFile: path.join(DATA, 'live-zalo-token-unused.json'),
  });
  assert.strictEqual(zaOk.sendMessage({ clientMessageId: 'c', to: 'zalo:123', text: 'hi' }).mid, 'zm9');

  const httpErr = mockHttp([{ match: () => true, reply: () => ({ ok: true, status: 200, bodyText: JSON.stringify({ error: -501, message: 'user not in CS window' }) }) }]);
  const zaErr = new ZaloAdapter({
    config: { appId: 'a', appSecret: 's', oaId: 'o', accessToken: 'AT', refreshToken: 'RT' },
    httpFn: httpErr, tokenFile: path.join(DATA, 'live-zalo-token-unused.json'),
  });
  const r = zaErr.sendMessage({ clientMessageId: 'c', to: 'zalo:123', text: 'hi' });
  assert.strictEqual(r.ok, false, 'HTTP 200 + error != 0 phải là THẤT BẠI');
  assert.ok(String(r.error).includes('-501'));
  assert.strictEqual(zaErr.state.last_error_type, 'zalo_api_error:-501');

  const httpTo = mockHttp([{ match: () => true, reply: () => ({ ok: false, timeout: true }) }]);
  const zaTo = new ZaloAdapter({
    config: { appId: 'a', appSecret: 's', oaId: 'o', accessToken: 'AT', refreshToken: 'RT' },
    httpFn: httpTo, tokenFile: path.join(DATA, 'live-zalo-token-unused.json'),
  });
  assert.deepStrictEqual(zaTo.sendMessage({ clientMessageId: 'c', to: 'zalo:123', text: 'hi' }), { ok: false, timeout: true });
});

T('Z5', 'ZALO', 'quota: API trả cs_reply -> dùng SỐ API + source=api; API không trả field -> design_default_unverified (không fake verified)', () => {
  const httpApi = mockHttp([{ match: () => true, reply: () => ({ ok: true, status: 200, bodyText: JSON.stringify({ error: 0, data: { quota: { cs_reply: { remain: 5, total: 8 } }, promotion: { daily: 1, monthly: 6 } } }) }) }]);
  const za = new ZaloAdapter({
    config: { appId: 'a', appSecret: 's', oaId: 'o', accessToken: 'AT', refreshToken: 'RT' },
    httpFn: httpApi, tokenFile: path.join(DATA, 'live-zalo-token-unused.json'),
  });
  const q = za.getQuota('887766');
  assert.strictEqual(q.remain, 5);
  assert.strictEqual(q.total, 8);
  assert.strictEqual(q.source, 'api');
  assert.strictEqual(za.state.quota_verified, true);

  const httpNone = mockHttp([{ match: () => true, reply: () => ({ ok: true, status: 200, bodyText: JSON.stringify({ error: 0, data: {} }) }) }]);
  const za2 = new ZaloAdapter({
    config: { appId: 'a', appSecret: 's', oaId: 'o', accessToken: 'AT', refreshToken: 'RT' },
    httpFn: httpNone, tokenFile: path.join(DATA, 'live-zalo-token-unused.json'),
  });
  const q2 = za2.getQuota('887766');
  assert.strictEqual(q2.source, 'design_default_unverified', 'không hardcode giả khi LIVE — phải bào rõ nguồn');
  assert.strictEqual(za2.state.quota_verified, false);
});

T('Z6', 'ZALO', 'webhook signature: sha256(appId+data+timeStamp+secret) khớp -> true, sai -> false', () => {
  const za = new ZaloAdapter({ config: { appId: 'appX', appSecret: 'secY', oaId: 'o' }, httpFn: mockHttp([]) });
  const raw = '{"event_name":"user_send_text","timestamp":1696500000000}';
  const good = crypto.createHash('sha256').update(`appX${raw}1696500000000secY`).digest('hex');
  assert.strictEqual(za.verifyWebhookSignature(raw, good, 1696500000000), true);
  assert.strictEqual(za.verifyWebhookSignature(raw, 'deadbeef', 1696500000000), false);
});

// ---------------------------------------------------------- GHN
function ghnHttpFactory({ createReplies = [], detailReplies = [], cancelReplies = [] }) {
  const mk = arr => arr.map(x => (typeof x === 'function' ? x : () => x));
  const createQ = mk(createReplies);
  const detailQ = mk(detailReplies);
  const cancelQ = mk(cancelReplies);
  return mockHttp([
    {
      match: u => u.includes('/shipping-order/create'),
      reply: () => (createQ.length ? createQ.shift()() : { ok: true, status: 200, bodyText: JSON.stringify({ code: '400', message: 'exhausted' }) }),
    },
    {
      match: u => u.includes('/shipping-order/detail'),
      reply: () => (detailQ.length ? detailQ.shift()() : { ok: true, status: 200, bodyText: JSON.stringify({ code: '400', message: 'not found' }) }),
    },
    {
      match: u => u.includes('switch-status/cancel'),
      reply: () => (cancelQ.length ? cancelQ.shift()() : { ok: true, status: 200, bodyText: JSON.stringify({ code: '400', message: 'nope' }) }),
    },
  ]);
}
const ghnOk = data => ({ ok: true, status: 200, bodyText: JSON.stringify({ code: '200', message: 'Success', data }) });

T('G1', 'GHN', 'create IDEMPOTENT: cùng ClientOrderCode gọi 2 lần -> HTTP create chỉ 1 lần, trả đúng đơn cũ (INV-3)', () => {
  const http = ghnHttpFactory({ createReplies: [ghnOk({ order_code: 'GHN_ORDER_1', total_fee: 25000 })] });
  const g = new GhnAdapter({ config: { token: 'gt', shopId: '123', baseUrl: 'https://dev-online-gateway.ghn.vn' }, httpFn: http });
  const req = { idempotencyKey: 'shipment:ord1', clientOrderCode: 'ORD_1_CODE', order: { items: [{ sku: 'X1', qty: 1 }], receiver: { name: 'A', phone: '09', address: 'địa chỉ' } } };
  const r1 = g.createShipment(req);
  assert.strictEqual(r1.status, 'CREATED');
  assert.strictEqual(r1.trackingNumber, 'GHN_ORDER_1');
  const callsAfterFirst = http.calls.filter(c => c.url.includes('/shipping-order/create')).length;
  assert.strictEqual(callsAfterFirst, 1);
  const r2 = g.createShipment(req); // CÙNG ClientOrderCode
  assert.strictEqual(r2.status, 'CREATED');
  assert.strictEqual(r2.trackingNumber, 'GHN_ORDER_1', 'trả đúng đơn cũ');
  assert.strictEqual(http.calls.filter(c => c.url.includes('/shipping-order/create')).length, 1, 'HTTP create lần 2 KHÔNG được xảy ra');
  assert.strictEqual(http.calls[0].headers.Token, 'gt');
  assert.strictEqual(http.calls[0].headers.ShopId, '123');
  assert.strictEqual(http.calls[0].body.includes('"client_order_code":"ORD_1_CODE"'), true, 'ClientOrderCode = identity idempotency nội bộ');
});

T('G2', 'GHN', 'response code lỗi (HTTP 200 + code!=200) -> KHÔNG coi là thành công (REJECTED rõ)', () => {
  const http = ghnHttpFactory({ createReplies: [{ ok: true, status: 200, bodyText: JSON.stringify({ code: '400', message: 'Trùng mã đơn hàng' }) }] });
  const g = new GhnAdapter({ config: { token: 'gt', shopId: '123' }, httpFn: http });
  const r = g.createShipment({ idempotencyKey: 'k', clientOrderCode: 'ORD_X', order: {} });
  assert.strictEqual(r.status, 'REJECTED', 'HTTP 200 KHÔNG tự động = thành công');
  assert.ok(String(r.reason).includes('400'));
  // timeout -> TIMEOUT + memo UNKNOWN
  const http2 = ghnHttpFactory({ createReplies: [{ ok: false, timeout: true }] });
  const g2 = new GhnAdapter({ config: { token: 'gt', shopId: '123' }, httpFn: http2 });
  const r2 = g2.createShipment({ idempotencyKey: 'k', clientOrderCode: 'ORD_T', order: {} });
  assert.strictEqual(r2.status, 'TIMEOUT');
});

T('G3', 'GHN', 'create TIMEOUT lần 1 -> attempt sau TRA CỨU detail trước: thấy ALREADY_EXISTS -> dùng tracking cũ, KHÔNG create lại (INV-2)', () => {
  const http = ghnHttpFactory({
    createReplies: [{ ok: false, timeout: true }],
    detailReplies: [ghnOk({ order_code: 'GHN_HIDDEN_9', total_fee: 25000, status: 'ready_to_pick' })],
  });
  const g = new GhnAdapter({ config: { token: 'gt', shopId: '123' }, httpFn: http });
  const req = { idempotencyKey: 'shipment:ord9', clientOrderCode: 'ORD_9', order: {} };
  assert.strictEqual(g.createShipment(req).status, 'TIMEOUT');
  const r2 = g.createShipment(req); // retry SAU timeout
  assert.strictEqual(r2.status, 'CREATED');
  assert.strictEqual(r2.trackingNumber, 'GHN_HIDDEN_9', 'đơn lần đầu thực ra đã tạo — dùng lại, KHÔNG tạo đơn thứ 2');
  assert.strictEqual(r2.via, 'reconcile');
  assert.strictEqual(http.calls.filter(c => c.url.includes('/shipping-order/create')).length, 1, 'không bao giờ create HTTP lần 2');
  assert.strictEqual(http.calls.filter(c => c.url.includes('/shipping-order/detail')).length, 1, 'phải tra cứu detail trước khi làm gì');
});

T('G4', 'GHN', 'cancel IDEMPOTENT: 2 lần -> 1 HTTP cancel, cùng receipt; carrier từ chối -> REJECTED rõ', () => {
  const http = ghnHttpFactory({ cancelReplies: [ghnOk([{ order_code: 'GHN_ORDER_1', result: true, message: 'ok' }])] });
  const g = new GhnAdapter({ config: { token: 'gt', shopId: '123' }, httpFn: http });
  const r1 = g.cancelShipment({ idempotencyKey: 'cancel_shipment:ord1', trackingNumber: 'GHN_ORDER_1' });
  assert.strictEqual(r1.status, 'CANCELLED');
  assert.ok(r1.receipt_id);
  const r2 = g.cancelShipment({ idempotencyKey: 'cancel_shipment:ord1', trackingNumber: 'GHN_ORDER_1' });
  assert.strictEqual(r2.status, 'CANCELLED');
  assert.strictEqual(r2.receipt_id, r1.receipt_id, 'trả lại receipt cũ');
  assert.strictEqual(http.calls.filter(c => c.url.includes('switch-status/cancel')).length, 1, 'HTTP cancel lần 2 không xảy ra');
  // result:false -> REJECTED (không huỷ lửng)
  const http2 = ghnHttpFactory({ cancelReplies: [ghnOk([{ order_code: 'GHN_2', result: false, message: 'Đã giao' }])] });
  const g2 = new GhnAdapter({ config: { token: 'gt', shopId: '123' }, httpFn: http2 });
  const r3 = g2.cancelShipment({ idempotencyKey: 'k2', trackingNumber: 'GHN_2' });
  assert.strictEqual(r3.status, 'REJECTED');
  assert.ok(String(r3.reason).includes('Đã giao'));
});

T('G5', 'GHN', 'webhook status: normalize IDEMPOTENT (cùng payload lần 2 duplicate) + getStatus đọc cache không HTTP', () => {
  const http = ghnHttpFactory({});
  const g = new GhnAdapter({ config: { token: 'gt', shopId: '123' }, httpFn: http });
  const body = { order_code: 'GHN_ORDER_1', client_order_code: 'ORD_1_CODE', status: 'delivering', time: 1696500300000 };
  const n1 = g.normalizeWebhook(body);
  assert.strictEqual(n1.ok, true);
  assert.strictEqual(n1.status, 'IN_TRANSIT');
  assert.ok(n1.event_id.startsWith('ghn:GHN_ORDER_1:delivering:'));
  const n2 = g.normalizeWebhook(body);
  assert.strictEqual(n2.duplicate, true, 'normalize cùng payload lần 2 phải đánh dấu duplicate');
  assert.strictEqual(n1.event_id, n2.event_id);
  g.applyWebhook(n1);
  assert.strictEqual(g.applyWebhook(n2).applied, false, 'apply lần 2 là no-op (idempotent)');
  const st = g.getStatus('GHN_ORDER_1');
  assert.strictEqual(st.status, 'IN_TRANSIT');
  assert.strictEqual(http.calls.length, 0, 'webhook-fed status: không cần HTTP');
  // delivered mapping cho case 17
  g.applyWebhook(g.normalizeWebhook({ order_code: 'GHN_ORDER_1', status: 'delivered', time: 1696501000000 }));
  assert.strictEqual(g.getStatus('GHN_ORDER_1').status, 'DELIVERED');
});

// ---------------------------------------------------------- PERSISTENCE
T('P1', 'PERSISTENCE', 'persist=true: 3 tin + 1 đơn -> restart x3 (App mới cùng dir) -> counts + SHA256 db.json GIỮ NGUYÊN, có db.backup.json', () => {
  const d = dir('live-persist-restart');
  fs.rmSync(d, { recursive: true, force: true }); // lần chạy đầu phải từ TRẮNG (persist không tự xoá)
  const boot = () => new App({ dataDir: d, persist: true });

  // ---- lần chạy đầu: 3 event + 1 đơn CONFIRMED ----
  const app1 = boot();
  assert.strictEqual(app1.persistMode, true);
  let pid = 0;
  const send = (ref, text) => {
    pid += 1;
    return app1.receive({
      channel: 'facebook', type: 'message',
      platformEventId: `pm-live-p-${ref}-${pid}`,
      payload: { customer_ref: ref, thread_id: ref, kind: 'text', text, platform_message_id: `pm-live-${pid}` },
    });
  };
  send('fb-live-a', 'lấy 1 nến vanilla M đỏ, tên Anh Tú, sdt 0907777111, địa chỉ 5 Lê Lợi Q1 TP.HCM');
  app1.drain({});
  send('fb-live-a', 'xác nhận');
  app1.drain({});
  send('fb-live-b', 'nến vanilla giá bao nhiêu shop');
  app1.drain({});

  const counts = () => ({
    customers: app1.store.findAll('customers', () => true).length,
    conversations: app1.store.findAll('conversations', () => true).length,
    messages: app1.store.findAll('messages', () => true).length,
    orders: app1.store.findAll('orders', () => true).length,
  });
  const before = counts();
  assert.strictEqual(before.customers, 2, '3 tin từ 2 khách');
  assert.strictEqual(before.messages, 6, '3 tin vào + 3 tin ra (bill/confirm/price)');
  assert.strictEqual(before.orders, 1, 'đúng 1 đơn CONFIRMED');
  assert.strictEqual(app1.store.findOne('orders', () => true).status, 'CONFIRMED');

  app1.store.persist();
  const dbPath = path.join(d, 'db.json');
  const sha0 = sha256File(dbPath);
  assert.ok(fs.existsSync(path.join(d, 'db.backup.json')) === false, 'chưa có db có sẵn ở lần đầu -> chưa cần backup');

  // ---- restart x3: App MỚI cùng dir persist ----
  for (let i = 1; i <= 3; i++) {
    const appN = boot(); // KHÔNG rmSync; nạp db.json; backup 1 tầng
    assert.strictEqual(appN.persistMode, true);
    assert.ok(fs.existsSync(path.join(d, 'db.backup.json')), `restart #${i}: db.backup.json phải tồn tại`);
    const after = counts();
    assert.deepStrictEqual(after, before, `restart #${i}: counts customers/messages/orders GIỮ NGUYÊN`);
    const shaN = sha256File(dbPath);
    assert.strictEqual(shaN, sha0, `restart #${i}: SHA256 db.json GIỮ NGUYÊN (không có write sau boot)`);
    // dữ liệu đọc được từ DB nạp lại: đơn + hội thoại còn nguyên
    const order = appN.store.findOne('orders', () => true);
    assert.ok(order && order.status === 'CONFIRMED', `restart #${i}: đơn CONFIRMED đọc lại được`);
    const conv = appN.store.findOne('conversations', c => c.platform_thread_id === 'fb-live-a');
    assert.ok(conv && conv.draft && conv.draft.order_id, `restart #${i}: conversation + draft còn nguyên`);
    // backup đúng nội dung db.json trước restart
    assert.strictEqual(sha256File(path.join(d, 'db.backup.json')), sha0, `restart #${i}: backup = db.json`);
  }
});

T('P2', 'PERSISTENCE', 'persist=false (mặc định): dataDir vẫn bị reset — regression test suite giữ nguyên hành vi cũ', () => {
  const d = dir('live-persist-reset-check');
  const a1 = new App({ dataDir: d });
  a1.receive({ channel: 'facebook', type: 'message', platformEventId: 'x1', payload: { customer_ref: 'r1', thread_id: 'r1', kind: 'text', text: 'hi', platform_message_id: 'pm1' } });
  a1.drain({});
  assert.ok(a1.store.findAll('customers', () => true).length >= 1);
  const a2 = new App({ dataDir: d }); // không persist -> rmSync
  assert.strictEqual(a2.store.findAll('customers', () => true).length, 0, 'mặc định reset (không persist)');
});

// ---------------------------------------------------------- SECRETS
T('S1', 'SECRETS', 'live-mode GIẢ: status health/UI (providerStatus cả 3 adapter) KHÔNG chứa chuỗi token/secret nào', () => {
  const META_TOKEN = 'EAAG_super_secret_meta_token_9988';
  const META_SECRET = 'meta_app_secret_hush8877';
  const ZALO_AT = 'zalo_access_secret_776655';
  const ZALO_RT = 'zalo_refresh_secret_112233';
  const GHN_TOKEN = 'ghn_token_secret_445566';
  const secrets = [META_TOKEN, META_SECRET, ZALO_AT, ZALO_RT, GHN_TOKEN];

  const http = mockHttp([{ match: () => true, reply: () => ({ ok: true, status: 200, bodyText: '{"error":0,"data":{"msg_id":"m"}}' }) }]);
  const meta = new MetaAdapter({ config: { appSecret: META_SECRET, pageAccessToken: META_TOKEN, verifyToken: 'vt' }, httpFn: http });
  const zalo = new ZaloAdapter({ config: { appId: 'a', appSecret: 'zs', oaId: 'o', accessToken: ZALO_AT, refreshToken: ZALO_RT }, httpFn: http, tokenFile: path.join(DATA, 'live-zalo-token-unused.json') });
  const ghn = new GhnAdapter({ config: { token: GHN_TOKEN, shopId: '1' }, httpFn: http });
  meta.sendMessage({ clientMessageId: 'c', to: 'facebook:p1', text: 'hi' });
  zalo.sendMessage({ clientMessageId: 'c', to: 'zalo:p1', text: 'hi' });
  ghn.createShipment({ idempotencyKey: 'k', clientOrderCode: 'C1', order: {} });

  // đúng shape server.js phát ra (health.providers + settings.providers)
  const healthLike = {
    meta: { provider: meta.providerStatus().provider, mode: meta.providerStatus().mode, configured: meta.providerStatus().configured, connected: meta.providerStatus().connected, last_webhook_at: meta.providerStatus().last_webhook_at, last_success_at: meta.providerStatus().last_success_at, last_error_type: meta.providerStatus().last_error_type },
    zalo: zalo.providerStatus(),
    ghn: ghn.providerStatus(),
  };
  const blob = JSON.stringify(healthLike);
  for (const s of secrets) assert.ok(!blob.includes(s), `provider status KHÔNG được chứa secret (${s.slice(0, 8)}...)`);
  assert.ok(!blob.includes(ZALO_AT) && !blob.includes(ZALO_RT));

  // state nội bộ mà log có thể in cũng không chứa secret
  for (const s of secrets) {
    assert.ok(!JSON.stringify(meta.state).includes(s));
    assert.ok(!JSON.stringify(zalo.state).includes(s));
    assert.ok(!JSON.stringify(ghn.state).includes(s));
  }
  // request outbound: token ở HEADER, không ở URL (không lọt vào access log)
  assert.ok(!http.calls.every(c => c.url.includes(ZALO_AT) || c.url.includes(META_TOKEN) || c.url.includes(GHN_TOKEN)) || http.calls.length === 0);
  for (const c of http.calls) {
    assert.ok(!c.url.includes('secret'), 'URL không chứa secret');
  }
});

T('S2', 'SECRETS', 'redactSecret/redactDeep: chỉ *** + 4 ký tự cuối; JSON debug không lộ nguyên giá trị', () => {
  assert.strictEqual(redactSecret(''), '(empty)');
  assert.strictEqual(redactSecret(null), '(empty)');
  assert.strictEqual(redactSecret('abcd'), '***');
  assert.strictEqual(redactSecret('EAA1234567890WXYZ'), '***WXYZ');
  const cfg = {
    pageAccessToken: 'EAAG_top_secret_token_42',
    appSecret: 'shhh_secret_99',
    note: 'văn bản thường giữ nguyên',
    nested: { access_token: 'zzzz_private_1234', list: ['a', { refresh_token: 'rt_abcdef' }] },
  };
  const view = JSON.parse(JSON.stringify(redactDeep(cfg)));
  assert.strictEqual(view.pageAccessToken, '***n_42'); // 4 ký tự CUỐI của '...token_42'
  assert.strictEqual(view.appSecret, '***t_99');
  assert.strictEqual(view.note, 'văn bản thường giữ nguyên');
  assert.strictEqual(view.nested.access_token, '***1234');
  assert.strictEqual(view.nested.list[1].refresh_token, '***cdef');
  assert.ok(!JSON.stringify(view).includes('EAAG_top_secret_token_42'));
});

T('S3', 'SECRETS', 'env-mini: .env.live tồn tại (giá trị rỗng) — parser KHÔNG override env có sẵn; parse đúng KEY=VALUE', () => {
  const parsed = parseEnvText('# cmt\nA=1\nB = "hai ba"\n\nC=\nBAD LINE\nD=\'năm\'');
  assert.deepStrictEqual(parsed, { A: '1', B: 'hai ba', C: '', D: 'năm' });
  // no-override
  const tmp = path.join(DATA, 'tmp-test-env.live');
  fs.writeFileSync(tmp, 'LV_TEST_KEY=from_file\n');
  process.env.LV_TEST_KEY = 'from_env';
  const r = loadEnvFile(tmp);
  assert.strictEqual(process.env.LV_TEST_KEY, 'from_env', 'env có sẵn THẮNG, không override');
  assert.strictEqual(r.applied, 0);
  delete process.env.LV_TEST_KEY;
  const r2 = loadEnvFile(tmp);
  assert.strictEqual(process.env.LV_TEST_KEY, 'from_file');
  assert.strictEqual(r2.applied, 1);
  delete process.env.LV_TEST_KEY;
  fs.rmSync(tmp, { force: true });
  // .env.live thật của prototype tồn tại, mọi giá trị secret đang RỖNG
  const envLive = path.join(__dirname, '..', '.env.live');
  assert.ok(fs.existsSync(envLive), '.env.live phải tồn tại (template key rỗng)');
  const vars = parseEnvText(fs.readFileSync(envLive, 'utf8'));
  for (const k of ['META_APP_ID', 'META_APP_SECRET', 'META_PAGE_ID', 'META_PAGE_ACCESS_TOKEN', 'META_VERIFY_TOKEN',
    'ZALO_APP_ID', 'ZALO_APP_SECRET', 'ZALO_OA_ID', 'ZALO_ACCESS_TOKEN', 'ZALO_REFRESH_TOKEN',
    'GHN_TOKEN', 'GHN_SHOP_ID']) {
    assert.ok(Object.prototype.hasOwnProperty.call(vars, k), `.env.live thiếu key ${k}`);
    assert.strictEqual(vars[k], '', `${k} phải để RỖNG trong template`);
  }
});

// ---------------------------------------------------------- WIRING
T('W1', 'WIRING', 'env chọn adapter: mặc định mock -> factory trả null (App dùng Mock); live/ghn -> đúng adapter + router chia kênh', () => {
  const savedChannel = process.env.CHANNEL_MODE;
  const savedShip = process.env.SHIPPING_MODE;
  delete process.env.CHANNEL_MODE;
  delete process.env.SHIPPING_MODE;
  assert.strictEqual(buildLiveExternals({}), null, 'mặc định mock');
  process.env.CHANNEL_MODE = 'live';
  process.env.SHIPPING_MODE = 'ghn';
  const ext = buildLiveExternals({
    config: {
      meta: { appSecret: 'ms', pageAccessToken: 'mt', verifyToken: 'vt' },
      zalo: { appId: 'a', appSecret: 's', oaId: 'o', accessToken: 'at', refreshToken: 'rt' },
      ghn: { token: 'gt', shopId: '1' },
    },
    zaloTokenFile: path.join(DATA, 'live-zalo-token-unused.json'),
    httpFn: mockHttp([
      {
        match: u => u.includes('graph.facebook.com'),
        reply: () => ({ ok: true, status: 200, bodyText: JSON.stringify({ recipient_id: 'psid9', message_id: 'm_w1' }) }),
      },
      {
        match: () => true,
        reply: () => ({ ok: true, status: 200, bodyText: '{"error":0,"data":{"msg_id":"mx"}}' }),
      },
    ]),
  });
  assert.ok(ext.meta && ext.zalo && ext.platform && ext.carrier);
  // router: to 'zalo:...' -> zalo adapter; 'facebook:...' -> meta adapter
  const r1 = ext.platform.sendMessage({ clientMessageId: 'c1', to: 'facebook:psid9', text: 'a' });
  const r2 = ext.platform.sendMessage({ clientMessageId: 'c2', to: 'zalo:user9', text: 'b' });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(ext.meta.sendCalls.length, 1);
  assert.strictEqual(ext.zalo.sendCalls.length, 1);
  assert.strictEqual(ext.carrier.environment(), 'staging', 'dev-online-gateway -> staging');
  const r3 = ext.platform.sendMessage({ clientMessageId: 'c3', to: 'tiktok:user9', text: 'c' });
  assert.strictEqual(r3.ok, false, 'kênh lạ phải bị từ chối rõ');
  if (savedChannel !== undefined) process.env.CHANNEL_MODE = savedChannel; else delete process.env.CHANNEL_MODE;
  if (savedShip !== undefined) process.env.SHIPPING_MODE = savedShip; else delete process.env.SHIPPING_MODE;
});

T('W2', 'WIRING', 'App live wiring: truyền externals -> App dùng adapter thật cùng interface (gate gọi được sendMessage)', () => {
  const http = mockHttp([{ match: () => true, reply: () => ({ ok: true, status: 200, bodyText: '{"error":0,"data":{"msg_id":"zlive"}}' }) }]);
  const ext = {
    zalo: new ZaloAdapter({ config: { appId: 'a', appSecret: 's', oaId: 'o', accessToken: 'AT', refreshToken: 'RT' }, httpFn: http, tokenFile: path.join(DATA, 'live-zalo-token-unused.json') }),
    carrier: new GhnAdapter({ config: { token: 'gt', shopId: '1' }, httpFn: ghnHttpFactory({}) }),
  };
  ext.platform = new ChannelRouter({ facebook: null, zalo: ext.zalo });
  const app1 = new App({ dataDir: dir('live-app-wiring'), live: ext });
  assert.strictEqual(app1.liveMode, true);
  app1.receive({ channel: 'zalo', type: 'message', platformEventId: 'zl-wire-1', payload: { customer_ref: 'u1', thread_id: 'u1', kind: 'text', text: 'nến vanilla còn không shop', platform_message_id: 'pm-w1' } });
  app1.drain({});
  assert.strictEqual(ext.zalo.sendCalls.length >= 1, true, 'gate đã gọi adapter qua interface (zalo)');
  assert.strictEqual(http.calls.length >= 1, true);
  const conv = app1.store.findOne('conversations', c => c.platform_thread_id === 'u1');
  const outMsg = app1.store.findAll('messages', m => m.conversation_id === conv.conversation_id && m.direction === 'out');
  assert.ok(outMsg.length >= 1, 'tin AI đã ghi message row');
  assert.strictEqual(outMsg[outMsg.length - 1].delivery_status, 'SENT_PENDING_RECEIPT', 'BL-5 giữ nguyên: accepted CHƯA phải DELIVERED');
});

// ============================================================ runner
async function main() {
  console.log('===== P2 LIVE-INTEGRATION BATTERY (offline — mock http, dependency injection) =====');
  const rows = [];
  let pass = 0;
  for (const t of TESTS) {
    const started = Date.now();
    try {
      await t.fn();
      pass += 1;
      rows.push({ n: t.n, g: t.group, desc: t.desc, status: 'PASS', note: `${Date.now() - started}ms` });
      console.log(`  [PASS] ${t.n} (${t.group}) — ${t.desc}`);
    } catch (err) {
      rows.push({ n: t.n, g: t.group, desc: t.desc, status: 'FAIL', note: String(err && err.message).split('\n')[0] });
      console.log(`  [FAIL] ${t.n} (${t.group}) — ${t.desc}\n         -> ${String(err && err.message).split('\n').slice(0, 4).join(' | ')}`);
    }
  }
  console.log('\n================ KẾT QUẢ P2 LIVE-INTEGRATION ================');
  console.log('#'.padEnd(6) + 'NHÓM'.padEnd(14) + 'KẾT QUẢ'.padEnd(8) + 'MÔ TẢ'.padEnd(90) + 'GHI CHÚ');
  console.log('-'.repeat(130));
  for (const r of rows) {
    console.log(String(r.n).padEnd(6) + String(r.g).padEnd(14) + r.status.padEnd(8) + r.desc.slice(0, 88).padEnd(90) + r.note.slice(0, 24));
  }
  console.log('-'.repeat(130));
  console.log(`TỔNG: ${pass}/${TESTS.length} PASS, ${TESTS.length - pass} FAIL`);
  console.log(pass === TESTS.length
    ? '==> P2 LIVE-INTEGRATION: toàn bộ adapter offline-verified (LIVE runtime CHƯA XÁC MINH — chưa có token thật).'
    : '==> CHƯA ĐẠT, cần sửa các test FAIL phía trên.');
  process.exitCode = pass === TESTS.length ? 0 : 1;
}

main().catch(err => { console.error('[fatal]', err); process.exitCode = 1; });
