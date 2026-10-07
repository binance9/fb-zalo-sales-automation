'use strict';
// Probe nhanh đợt 2 (không phải suite chính — xóa sau khi báo cáo ổn).
const http = require('http');
const path = require('path');
const fs = require('fs');
const { createServer } = require('../server');

const DATA = path.join(__dirname, '..', 'data', 'test-runs', 'probe-p2');
fs.rmSync(DATA, { recursive: true, force: true });

(async () => {
  const inst = createServer({ port: 0, authDir: path.join(DATA, 'auth'), shopsRoot: path.join(DATA, 'shops'), uiDemo: '0', appDataMode: 'persist' });
  inst.listen();
  for (let i = 0; i < 50 && !inst.server.listening; i++) await new Promise(r => setTimeout(r, 20));
  let SID = null;
  const call = (method, p, body) => new Promise((res, rej) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    if (SID) headers.Cookie = `sid=${SID}`;
    const req = http.request({ hostname: '127.0.0.1', port: inst.server.address().port, path: p, method, headers }, r => {
      let raw = '';
      r.on('data', c => { raw += c; });
      r.on('end', () => {
        const sc = r.headers['set-cookie'];
        if (sc && sc[0]) { const m = sc[0].match(/sid=([^;]+)/); if (m && !SID) SID = m[1]; }
        let json = null; try { json = JSON.parse(raw); } catch (e) { /* ignore */ }
        res({ status: r.statusCode, json, text: raw });
      });
    });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });

  const setup = await call('POST', '/api/auth/setup', { email: 'o@a.vn', password: 'password123', shop_name: 'Shop A' });
  console.log('setup:', setup.status, 'shop=', setup.json.shop.shop_id);
  const shop = setup.json.shop.shop_id;
  const app = inst.getApp(shop);
  // bật bot tạm (giống nút test onboarding — ghi thẳng settings row của store)
  const botRow = () => app.store.findOne('settings', s => s.key === 'bot_enabled');
  app.store.transaction(() => { app.store.updateRow('settings', botRow(), { value: true }); });
  app.receive({ channel: 'facebook', type: 'message', platformEventId: 'e1', payload: { customer_ref: 'k1', thread_id: 'k1', kind: 'text', text: 'lấy 1 nến vanilla M đỏ, tên Test A, sdt 0901112222, địa chỉ 10 ABC Q1', platform_message_id: 'pm1' } });
  app.drain();
  const h = await call('GET', '/api/health');
  console.log('health components:', JSON.stringify(Object.fromEntries(Object.entries(h.json.components).map(([k, v]) => [k, v.status]))));
  console.log('health db counts:', JSON.stringify(h.json.components.database.counts));
  const notif = await call('GET', '/api/notifications');
  console.log('notifications:', notif.status, 'unread=', notif.json.unread, 'items=', notif.json.notifications.length);
  const rd = await call('POST', '/api/notifications/read', { all: true });
  console.log('read-all:', rd.status, 'unread=', rd.json.unread);
  const au = await call('GET', '/api/automation');
  console.log('automation GET:', au.status, JSON.stringify(au.json.automation));
  const auSave = await call('POST', '/api/automation', { followup_delivery_hours: 12, purchase_reminder_enabled: true, purchase_reminder_days: 3 });
  console.log('automation POST:', auSave.status, JSON.stringify(auSave.json.automation));
  const auBad = await call('POST', '/api/automation', { followup_delivery_hours: 9999 });
  console.log('automation BAD:', auBad.status, auBad.json.error);
  const st = await call('GET', '/api/settings');
  console.log('settings automation config:', JSON.stringify(st.json.automation.config));
  const conv = app.store.findOne('conversations', c => c.platform_thread_id === 'k1');
  const order = app.store.findOne('orders', o => o.conversation_id === conv.conversation_id);
  console.log('order status after buy msg:', order.status);
  const cf = await call('POST', '/api/orders/' + order.order_id + '/confirm', {});
  console.log('confirm:', cf.status, JSON.stringify(cf.json));
  const cf2 = await call('POST', '/api/orders/' + order.order_id + '/confirm', {});
  console.log('confirm idempotent:', cf2.status, cf2.json.idempotent);
  const cc = await call('POST', '/api/orders/' + order.order_id + '/cancel', {});
  console.log('cancel:', cc.status, cc.json.ok, cc.json.status);
  const rt = await call('POST', '/api/orders/' + order.order_id + '/retry-shipping', {});
  console.log('retry after cancelled:', rt.status, rt.json.error);
  // CANCEL_PENDING path với carrier refuse
  app.carrier.cancelMode = 'refuse';
  app.receive({ channel: 'facebook', type: 'message', platformEventId: 'e2', payload: { customer_ref: 'k2', thread_id: 'k2', kind: 'text', text: 'lấy 1 hộp trà hoa sấy, tên Test B, sdt 0909998888, địa chỉ 22 DEF Q1', platform_message_id: 'pm2' } });
  app.drain();
  const conv2 = app.store.findOne('conversations', c => c.platform_thread_id === 'k2');
  const order2 = app.store.findOne('orders', o => o.conversation_id === conv2.conversation_id && o.status === 'DRAFT');
  const cf3 = await call('POST', '/api/orders/' + order2.order_id + '/confirm', {});
  console.log('confirm2:', cf3.status, cf3.json.order && cf3.json.order.status);
  const cc2 = await call('POST', '/api/orders/' + order2.order_id + '/cancel', {});
  console.log('cancel2 (refuse):', cc2.status, cc2.json.ok, cc2.json.status);
  const rt2 = await call('POST', '/api/orders/' + order2.order_id + '/retry-shipping', {});
  console.log('retry cancel-pending (vẫn refuse):', rt2.status, JSON.stringify(rt2.json.order));
  app.carrier.cancelMode = 'ok';
  const rt3 = await call('POST', '/api/orders/' + order2.order_id + '/retry-shipping', {});
  console.log('retry cancel-pending (carrier ok):', rt3.status, JSON.stringify(rt3.json.order));
  const notif2 = await call('GET', '/api/notifications');
  console.log('notifications2 unread=', notif2.json.unread, JSON.stringify(notif2.json.notifications.slice(0, 4).map(n => n.type)));
  // close-claim flow
  const r3 = app.receive({ channel: 'facebook', type: 'message', platformEventId: 'e3', payload: { customer_ref: 'k3', thread_id: 'k3', kind: 'text', text: 'shop lừa đảo quá, đơn lỗi rồi nhé', platform_message_id: 'pm3' } });
  app.drain();
  const conv3 = app.store.findOne('conversations', c => c.platform_thread_id === 'k3');
  console.log('claim open:', !!conv3.claim, 'mode:', conv3.mode);
  const ag = await call('POST', '/api/conversations/' + encodeURIComponent(conv3.conversation_id) + '/send', { text: 'Dạ shop xin lỗi anh, em kiểm tra ngay ạ' });
  console.log('agent send in HUMAN:', ag.status, ag.json.sent);
  const cl = await call('POST', '/api/conversations/' + encodeURIComponent(conv3.conversation_id) + '/close-claim', {});
  console.log('close-claim:', cl.status, JSON.stringify(cl.json));
  const hb = await call('POST', '/api/conversations/' + encodeURIComponent(conv3.conversation_id) + '/handback', {});
  console.log('handback:', hb.status, hb.json.mode);
  await inst.close();
  console.log('PROBE DONE');
})().catch(e => { console.error(e); process.exit(1); });
