// ZCODE FINAL ACCEPTANCE — 15 case runtime cho PHASE UI (gọi API thật trên :8080) — v2 khớp field thật
const BASE = 'http://localhost:8080';
const kq = [];
function cham(so, ten, ok, chiTiet = '') {
  kq.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${so}. ${ten}${chiTiet ? ' — ' + chiTiet : ''}`);
}
async function api(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
const cho = (ms) => new Promise((r) => setTimeout(r, ms));
async function khachNoi(ref) {
  const { body } = await api('GET', '/api/conversations/' + encodeURIComponent('facebook:' + ref));
  return (body.messages || []).filter((m) => m.direction === 'out' || m.sender === 'bot' || m.sender === 'agent');
}

(async () => {
  // 1. Dashboard
  let r = await api('GET', '/api/dashboard');
  cham(1, 'Mở dashboard', r.status === 200 && r.body && 'khachHomNay' in r.body,
    `khách=${r.body?.khachHomNay}, đơn=${r.body?.donHomNay}, doanh thu=${r.body?.doanhThuHomNay ?? r.body?.doanhThu}`);

  // 2. Conversation list
  r = await api('GET', '/api/conversations');
  cham(2, 'Conversation list load', r.status === 200 && (r.body.conversations || []).length > 0,
    `${(r.body.conversations || []).length} hội thoại`);

  // 3. Mở chat
  const c0 = (r.body.conversations || [])[0];
  r = await api('GET', '/api/conversations/' + encodeURIComponent(c0.id));
  cham(3, 'Mở chat hội thoại', r.status === 200 && (r.body.messages || []).length > 0,
    `${(r.body.messages || []).length} tin`);

  // 4. Gửi tin nhân viên
  r = await api('POST', '/api/conversations/' + encodeURIComponent(c0.id) + '/send', { text: '[NV test] Dạ em chào anh, em hỗ trợ ngay ạ!' });
  await cho(300);
  let outs = await khachNoi(c0.id.replace('facebook:', ''));
  cham(4, 'Gửi tin nhân viên', r.status === 200 && outs.some((m) => (m.text || '').includes('[NV test]')), '');

  // 5. Bot reply (FAQ giá — subject-scoped)
  const khach = 'fb-zcode-ac' + Date.now();
  r = await api('POST', '/api/debug/customer-message', { channel: 'facebook', ref: khach, text: 'cho hỏi nến thơm vanilla giá bao nhiêu vậy shop' });
  await cho(1200);
  let botMsgs = await khachNoi(khach);
  cham(5, 'Bot tự trả lời khách hỏi giá (từ DB)', r.status === 200 && botMsgs.some((m) => /185\.?000|165\.?000/.test(m.text || '')),
    botMsgs.length ? 'có phản hồi giá từ DB' : 'chưa có phản hồi');

  // 6. Takeover
  r = await api('POST', '/api/conversations/' + encodeURIComponent('facebook:' + khach) + '/takeover');
  let d = (await api('GET', '/api/conversations/' + encodeURIComponent('facebook:' + khach))).body;
  cham(6, 'TIẾP QUẢN → mode HUMAN', r.status === 200 && d.mode === 'HUMAN', `mode=${d.mode}`);

  // 7. Handback
  r = await api('POST', '/api/conversations/' + encodeURIComponent('facebook:' + khach) + '/handback');
  d = (await api('GET', '/api/conversations/' + encodeURIComponent('facebook:' + khach))).body;
  cham(7, 'TRẢ LẠI CHO AI → mode AI', r.status === 200 && d.mode === 'AI', `mode=${d.mode}`);

  // 8. Tạo đơn hiển thị — luồng mua đầy đủ 4 tin (SP 1 variant)
  const khachMua = 'fb-zcode-mua' + Date.now();
  await api('POST', '/api/debug/customer-message', { channel: 'facebook', ref: khachMua, text: 'đặt cho mình 2 hộp trà hoa sấy' });
  await cho(700);
  await api('POST', '/api/debug/customer-message', { channel: 'facebook', ref: khachMua, text: 'sdt 0987654321, địa chỉ 3 Lê Lợi Q1' });
  await cho(700);
  await api('POST', '/api/debug/customer-message', { channel: 'facebook', ref: khachMua, text: 'mình là Lan' });
  await cho(700);
  await api('POST', '/api/debug/customer-message', { channel: 'facebook', ref: khachMua, text: 'xác nhận' });
  await cho(1200);
  r = await api('GET', '/api/orders');
  const donMoi = (r.body.orders || []).find((o) =>
    (o.customer_name || '').includes('Lan') && (o.products || '').includes('Hộp trà hoa sấy') && /CONFIRMED|DRAFT/.test(o.status || ''));
  cham(8, 'Tạo đơn hiển thị trong danh sách', Boolean(donMoi), donMoi ? `${donMoi.order_code} ${donMoi.status}` : 'không thấy');

  // 9. Mở chi tiết đơn
  const donId = donMoi ? donMoi.order_id : null;
  r = donId ? await api('GET', '/api/orders/' + encodeURIComponent(donId)) : { status: 404, body: null };
  cham(9, 'Mở chi tiết đơn', r.status === 200 && r.body, donId);

  // 10. Hủy đơn DRAFT (SP đa variant: đặt → hỏi variant → đang mở draft)
  const khachDraft = 'fb-zcode-draft' + Date.now();
  await api('POST', '/api/debug/customer-message', { channel: 'facebook', ref: khachDraft, text: 'đặt cho mình 1 nến thơm vanilla' });
  await cho(700);
  await api('POST', '/api/debug/customer-message', { channel: 'facebook', ref: khachDraft, text: 'size M màu đỏ' });
  await cho(700);
  await api('POST', '/api/debug/customer-message', { channel: 'facebook', ref: khachDraft, text: 'sdt 0912345678 địa chỉ 12 Nguyễn Huệ Q1' });
  await cho(700);
  await api('POST', '/api/debug/customer-message', { channel: 'facebook', ref: khachDraft, text: 'mình là Bình' });
  await cho(1200);
  r = await api('GET', '/api/orders');
  const donDraft = (r.body.orders || []).find((o) => (o.customer_name || '').includes('Bình') && /DRAFT/i.test(o.status || ''));
  let ok10 = false, chi10 = 'không thấy đơn DRAFT';
  if (donDraft) {
    const rc = await api('POST', '/api/orders/' + encodeURIComponent(donDraft.order_id) + '/cancel');
    await cho(400);
    const sau = (await api('GET', '/api/orders')).body.orders.find((o) => o.order_id === donDraft.order_id);
    ok10 = rc.status === 200 && /CANCEL/i.test(sau?.status || '');
    chi10 = `${donDraft.order_code}: ${donDraft.status} → ${sau?.status || '?'}`;
  }
  cham(10, 'Hủy đơn DRAFT', ok10, chi10);

  // 11. Hủy đơn CONFIRMED (đơn vừa chốt case 8 — có shipment mock)
  let ok11 = false, chi11 = 'không có đơn';
  if (donId) {
    const rc = await api('POST', '/api/orders/' + encodeURIComponent(donId) + '/cancel');
    await cho(600);
    const sau = (await api('GET', '/api/orders/' + encodeURIComponent(donId))).body;
    const st = sau.status || '';
    ok11 = rc.status === 200 && /CANCEL/.test(st);
    chi11 = st + (sau.shipment ? ` (shipment ${sau.shipment.status})` : '');
  }
  cham(11, 'Hủy đơn CONFIRMED (qua carrier nếu có shipment)', ok11, chi11);

  // 12. Products load
  r = await api('GET', '/api/products');
  cham(12, 'Sản phẩm load', r.status === 200 && (r.body.products || []).length > 0,
    `${(r.body.products || []).length} SP`);

  // 13. Sửa sản phẩm (giá variant đầu của SP đầu)
  const sp0 = r.body.products[0];
  const giaCu = sp0.variants[0].price;
  const giaMoi = giaCu + 1000;
  r = await api('PUT', '/api/products/' + encodeURIComponent(sp0.sku_base), { price: giaMoi });
  const spSau = (await api('GET', '/api/products')).body.products.find((p) => p.sku_base === sp0.sku_base);
  cham(13, 'Sửa sản phẩm qua API', r.status === 200 && spSau.variants[0].price === giaMoi,
    `${sp0.sku_base}: ${giaCu} → ${spSau.variants[0].price}`);
  await api('PUT', '/api/products/' + encodeURIComponent(sp0.sku_base), { price: giaCu }); // trả lại giá

  // 14. Customer detail
  r = await api('GET', '/api/customers');
  const cus0 = (r.body.customers || [])[0];
  r = cus0 ? await api('GET', '/api/customers/' + encodeURIComponent(cus0.customer_id)) : { status: 404, body: null };
  cham(14, 'Customer detail', r.status === 200 && r.body, cus0 ? cus0.customer_id : 'trống');

  // 15. Bot ON/OFF
  await api('POST', '/api/settings/bot', { on: false });
  let h = await api('GET', '/api/health');
  const off = h.body.bot_on === false;
  await api('POST', '/api/settings/bot', { on: true });
  h = await api('GET', '/api/health');
  const on = h.body.bot_on === true;
  cham(15, 'Bot ON/OFF', off && on, `off=${off}, on=${on}`);

  const dat = kq.filter(Boolean).length;
  console.log(`\n=== ZCODE ACCEPTANCE: ${dat}/15 ===`);
  process.exit(dat === 15 ? 0 : 1);
})();
