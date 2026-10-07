'use strict';
/* ============================================================
   Sales AI Console — Phase UI (app.js)
   - Mọi số liệu/tin nhắn/danh sách lấy từ API của server.js (store thật) — KHÔNG fake data.
   - SSE /api/events -> server tự quét thay đổi ~2s và báo, client refetch theo view đang mở.
   ============================================================ */

// ------------------------------------------------state + helpers
// i18n (đa ngôn ngữ): ui/i18n.js nạp TRƯỚC app.js — fallback nhẹ nếu file chưa tải (cache cũ).
if (typeof window.t !== 'function') {
  window.t = k => ((window.I18N && window.I18N.vi && window.I18N.vi[k]) || k);
}
const APP_TITLE = 'Sales AI Console — Vận hành bán hàng';
const state = {
  view: 'overview',
  user: null,
  onboarding: null,
  conversations: [],
  activeConvId: null,
  convDetail: null,
  orders: [],
  orderFilter: 'ALL',
  products: [],
  productQuery: '',
  customers: [],
  dashboard: null,
  health: null,
  settings: null,
  composerText: '',
  chatSearch: '',
  notifications: [],   // in-app notifications (đợt 2)
  notifUnread: 0,
  convTab: 'chat',     // SURI P2 (hạng mục 5b): 'chat' | 'runs' — tab phụ Agent runs trong Hội thoại
  agentRuns: [],       // bảng run cho tab Agent runs
  agentRunDetail: null,
  guide: {             // view "Hướng dẫn" (layout aicake) — dữ liệu từ GET /api/guide
    data: null,        // cache {version, product, categories:[…]} — fetch 1 lần, fail -> thông báo thử lại
    article: null,     // id bài đang mở (hash routing #guide/<id>)
    filter: null,      // id danh mục đang lọc ở trang chủ
    q: '',             // từ khóa tìm kiếm local
    asking: false,     // đang chờ POST /api/guide/ask
    i18nV: 0,          // i18n: setLang bump __i18nV -> vẽ lại shell guide
  },
};

// Notification badge trên TITLE (đề bài: document.title = "(n) Inbox — ...").
function updateTitleBadge(n) {
  document.title = n > 0 ? `(${n}) Inbox — Sales AI Console` : APP_TITLE;
}

const $ = sel => document.querySelector(sel);
const main = $('#main');

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  let body = null;
  try { body = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    if (res.status === 401) { location.href = '/'; throw new Error('UNAUTHORIZED'); }
    // SURI P2 (hạng mục 5c): ưu tiên userMessage THÂN THIỆN (server map từ src/errors.js) —
    // mã lỗi kỹ thuật chỉ là dự phòng.
    const msg = (body && (body.userMessage || body.error || body.reason)) || `HTTP ${res.status}`;
    throw Object.assign(new Error(msg), { status: res.status, body });
  }
  return body;
}

function fmtVND(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('vi-VN') + '₫';
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  return `${hh}:${mm} ${dd}/${mo}`;
}

function fmtTimeShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', !!isErr);
  t.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add('hidden'), 3200);
}

function chanIcon(channel) {
  const c = String(channel || '').toLowerCase();
  const label = c === 'facebook' ? 'f' : c === 'zalo' ? 'Z' : c.slice(0, 1).toUpperCase();
  return `<span class="chan-ico chan-${esc(c)}">${esc(label)}</span>`;
}

// i18n: NEEDS_HUMAN/ORDERED có nhãn dịch; AI/HUMAN giữ nguyên (thuật ngữ).
const BADGE_KEY = { AI: null, HUMAN: null, NEEDS_HUMAN: 'badge.needs_human', ORDERED: 'badge.ordered' };
function badge(b) {
  const lbl = BADGE_KEY[b] ? t(BADGE_KEY[b]) : b;
  return `<span class="badge badge-${esc(b)}">${esc(lbl)}</span>`;
}

function stateLabel(s) {
  return esc(String(s || '').replace(/_/g, ' '));
}

function dlvLabel(st) {
  switch (st) {
    case 'PENDING': return t('dlv.pending');
    case 'SENT_PENDING_RECEIPT': return t('dlv.sent_receipt');
    case 'DELIVERED': return t('dlv.delivered');
    case 'FAILED': return t('dlv.failed');
    case 'SENT': return t('dlv.sent');
    default: return st ? esc(st) : '';
  }
}

function orderStatusPill(ds) {
  const map = {
    DRAFT: ['pill-gray', 'ord.pill_draft'],
    CONFIRMED: ['pill-green', 'ord.pill_confirmed'],
    SHIPPING: ['pill-blue', 'ord.pill_shipping'],
    DELIVERED: ['pill-green', 'ord.pill_delivered'],
    CANCELLED: ['pill-gray', 'ord.pill_cancelled'],
    CANCEL_PENDING: ['pill-amber', 'ord.pill_cancel_pending'],
  };
  const [cls, key] = map[ds] || ['pill-gray', null];
  const label = key ? t(key) : ds;
  return `<span class="pill ${cls}"><span class="dot"></span>${esc(label)}</span>`;
}

// ------------------------------------------------fetch tổng
async function loadCommon() {
  const [dash, health] = await Promise.all([api('/api/dashboard'), api('/api/health')]);
  state.dashboard = dash;
  state.health = health;
  renderTopbar();
}

function renderTopbar() {
  const d = state.dashboard;
  if (state.user) {
    $('#userName').textContent = state.user.email;
    $('#userAvatar').textContent = state.user.email.slice(0, 2).toUpperCase();
    $('#userBadge').title = `${state.user.email} · role ${state.user.role} · shop ${state.user.shop_id}`;
  }
  if (!d) return;
  const btn = $('#botToggle');
  btn.classList.toggle('off', !d.bot.on);
  $('#botToggleText').textContent = d.bot.on ? t('top.bot_on') : t('top.bot_off');
  // chuông: đếm NOTIFICATION CHƯA ĐỌC (needs_human + đơn lỗi + DLQ + token + quota)
  renderBell(state.notifUnread);
}

function renderBell(n) {
  const bell = $('#bellCount');
  bell.textContent = String(n);
  bell.classList.toggle('hidden', !n);
  const navBadge = $('#navConvBadge');
  navBadge.textContent = String(n);
  navBadge.classList.toggle('hidden', !n);
  updateTitleBadge(n);
}

// ============================================================ IN-APP NOTIFICATIONS (đợt 2)
// i18n: giá trị chứa '.' là KEY dịch, còn lại giữ nguyên (thuật ngữ kỹ thuật).
const NOTIF_ICON = {
  needs_human: ['var(--amber)', 'notif.needs_human'],
  order_error: ['var(--red)', 'notif.order_error'],
  dlq: ['var(--red)', 'DLQ'],
  token_expired: ['var(--red)', 'Token'],
  quota_low: ['var(--amber)', 'Quota'],
  job_dead: ['var(--red)', 'Job DEAD'],
};
async function loadNotifications() {
  try {
    const r = await api('/api/notifications');
    state.notifications = r.notifications || [];
    state.notifUnread = r.unread || 0;
    renderBell(state.notifUnread);
    const panel = $('#notifPanel');
    if (!panel.classList.contains('hidden')) renderNotifList();
  } catch (e) { /* AGENT/401 đã xử lý ở api(); lỗi khác bỏ qua */ }
}

function renderNotifList() {
  const box = $('#notifList');
  const rows = state.notifications.slice(0, 30).map(n => {
    const [color, label] = NOTIF_ICON[n.type] || ['var(--text-faint)', n.type];
    const labelTxt = label.indexOf('.') > 0 ? t(label) : label;
    return `
      <button class="notif-item ${n.read ? 'read' : 'unread'}" data-notif="${esc(n.id)}" data-type="${esc(n.type)}">
        <span class="notif-dot" style="background:${color}"></span>
        <span class="notif-mid">
          <span class="notif-msg">${esc(n.message)}</span>
          <span class="notif-meta">${esc(labelTxt)} · ${n.time ? fmtTime(n.time) : '—'}</span>
        </span>
        ${n.read ? '' : '<span class="notif-unread-dot"></span>'}
      </button>`;
  }).join('');
  box.innerHTML = rows || `<div class="notif-empty">${t('top.notif_empty')}</div>`;
  box.querySelectorAll('.notif-item').forEach(b => b.addEventListener('click', () => {
    const t = b.dataset.type;
    $('#notifPanel').classList.add('hidden');
    if (t === 'needs_human') { state.chatSearch = ''; switchView('conversations'); }
    else if (t === 'order_error') switchView('orders');
    else switchView('overview');
  }));
}

function toggleNotifPanel(force) {
  const panel = $('#notifPanel');
  const show = force !== undefined ? force : panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !show);
  if (show) { loadNotifications().then(renderNotifList); }
}

// ============================================================ VIEW: TỔNG QUAN
async function renderOverview() {
  await loadCommon();
  const d = state.dashboard;
  const h = state.health;
  const kenhRow = name => {
    const k = d.kenh[name];
    if (!k) return '';
    const lbl = k.status_label || (k.connected ? 'CONNECTED' : 'DISCONNECTED');
    return `
      <div class="kv">
        <span class="k">${esc(name[0].toUpperCase() + name.slice(1))}</span>
        <span class="v"><span class="pill ${k.connected ? 'pill-green' : 'pill-red'}"><span class="dot"></span>${esc(lbl)}${k.mock ? ' (mock)' : ''}</span></span>
      </div>`;
  };
  const actRows = (d.hoatDongGanDay || []).map(a => `
    <tr>
      <td style="white-space:nowrap;color:var(--text-light)">${fmtTime(a.at)}</td>
      <td>${actIcon(a.type)} ${esc(a.label)}</td>
      <td style="color:var(--text-faint);font-size:12px">${a.type === 'tao_don' ? t('act.order') : a.type === 'khach_hoi_gia' ? t('act.conv') : a.type === 'can_nhan_vien' ? t('act.need_handle') : t('act.send')}</td>
    </tr>`).join('');
  // HEALTH GỌN (đợt 2): mỗi thành phần 1 pill — database/facebook/zalo/shipping/ai/scheduler/webhook/queue
  const compPill = (name, c) => {
    if (!c) return '';
    const cls = c.status === 'ok' ? 'pill-green' : c.status === 'degraded' ? 'pill-amber' : 'pill-red';
    const tip = c.last_error ? ` (${esc(c.last_error)})` : '';
    return `<span class="pill ${cls}" title="${esc(name)}: ${esc(c.status)}${tip}" style="cursor:default">${esc(name)}</span>`;
  };
  const comps = (h && h.components) || {};
  const healthStrip = [
    compPill('DB', comps.database), compPill('Facebook', comps.facebook), compPill('Zalo', comps.zalo),
    compPill('Ship', comps.shipping), compPill('AI', comps.ai), compPill('Scheduler', comps.scheduler),
    compPill('Webhook', comps.webhook), compPill('Queue', comps.queue),
  ].join(' ');
  main.innerHTML = `
    <div class="page-head">
      <div><h1>${t('ov.title')}</h1><div class="sub">${t('ov.sub', { time: fmtTime(d.now) })}</div></div>
    </div>
    <div class="card health-strip" style="padding:10px 14px;margin-bottom:14px;display:flex;flex-wrap:wrap;gap:6px;align-items:center">
      <strong style="font-size:12.5px;color:var(--text-light);margin-right:4px">${t('ov.health')}</strong>${healthStrip}
    </div>
    <div class="stat-grid">
      <div class="card stat-card">
        <span class="stat-icon"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg></span>
        <div><div class="stat-num">${d.khachHomNay}</div><div class="stat-label">${t('ov.khach_hom_nay')}</div></div>
      </div>
      <div class="card stat-card">
        <span class="stat-icon"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg></span>
        <div><div class="stat-num">${d.donHomNay}</div><div class="stat-label">${t('ov.don_hom_nay')}</div></div>
      </div>
      <div class="card stat-card">
        <span class="stat-icon"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></span>
        <div><div class="stat-num">${fmtVND(d.doanhThuHomNay)}</div><div class="stat-label">${t('ov.doanh_thu')}</div></div>
      </div>
      <div class="card stat-card ${d.canNhanVien ? 'alert' : ''}">
        <span class="stat-icon"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg></span>
        <div><div class="stat-num">${d.canNhanVien}</div><div class="stat-label">${t('ov.can_nhan_vien')}</div></div>
      </div>
    </div>
    <div class="ov-grid">
      <div class="card">
        <h2>${t('ov.hoat_dong')}</h2>
        <div class="table-wrap">
          <table class="tbl">
            <thead><tr><th>${t('ov.th_time')}</th><th>${t('ov.th_event')}</th><th>${t('ov.th_group')}</th></tr></thead>
            <tbody>${actRows || `<tr><td colspan="3" class="tbl-empty">${t('ov.no_activity')}</td></tr>`}</tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <h2>${t('ov.bot_status')}</h2>
        <div class="kv-list">
          ${kenhRow('facebook')}
          ${kenhRow('zalo')}
          ${kenhRow('ghn')}
          <div class="kv"><span class="k">Bot AI</span><span class="v"><span class="pill ${d.bot.on ? 'pill-green' : 'pill-gray'}"><span class="dot"></span>${d.bot.on ? t('ov.on') : t('ov.off')}</span></span></div>
          <div class="kv"><span class="k">${t('ov.auto_reply')}</span><span class="v">${d.bot.autoReply ? t('ov.on_short') : t('ov.off_short')}</span></div>
          <div class="kv"><span class="k">${t('ov.takeover')}</span><span class="v">${t('ov.conv_unit', { n: d.takeoverCount })}</span></div>
          <div class="kv"><span class="k">${t('ov.send_errors')}</span><span class="v">send_failed: ${h.errors.send_failed} · DLQ: ${h.errors.dlq_count}</span></div>
        </div>
      </div>
    </div>`;
}

function actIcon(type) {
  const c = type === 'tao_don' ? 'var(--green)' : type === 'can_nhan_vien' ? 'var(--amber)' : type === 'loi_gui_tin' ? 'var(--red)' : 'var(--primary)';
  return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};margin-right:2px"></span>`;
}

// ============================================================ VIEW: HỘI THOẠI (chat | agent runs)
async function renderConversations() {
  // SURI P2 (hạng mục 5b): tab phụ "Agent runs" — xem vệt run (run_id/state/steps) do
  // AgentOrchestrator ghi cho MỖI tin khách vào (API /api/agent/runs đã có từ SURI P1).
  const tabs = `
    <div class="conv-tabs" style="display:flex;gap:8px;margin-bottom:12px">
      <button class="btn ${state.convTab === 'chat' ? 'btn-primary' : ''}" id="tabChat">${t('conv.tab_chat')}</button>
      <button class="btn ${state.convTab === 'runs' ? 'btn-primary' : ''}" id="tabRuns">Agent runs</button>
    </div>`;
  if (state.convTab === 'runs') return renderAgentRuns(tabs);

  const data = await api('/api/conversations');
  state.conversations = data.conversations || [];
  if (!state.conversations.some(c => c.id === state.activeConvId)) {
    state.activeConvId = state.conversations.length ? state.conversations[0].id : null;
  }
  let detail = null;
  if (state.activeConvId) {
    try { detail = await api(`/api/conversations/${encodeURIComponent(state.activeConvId)}`); }
    catch (e) { state.activeConvId = null; }
  }
  state.convDetail = detail;

  const q = state.chatSearch.toLowerCase();
  const list = state.conversations.filter(c =>
    !q || (c.customerName || '').toLowerCase().includes(q) || (c.lastMessage || '').toLowerCase().includes(q));

  const listHtml = list.map(c => `
    <button class="conv-item ${c.id === state.activeConvId ? 'active' : ''}" data-conv="${esc(c.id)}">
      <span class="conv-ava">${esc((c.customerName || '?').slice(0, 1).toUpperCase())}</span>
      <span class="conv-item-mid">
        <span class="conv-item-top">
          <span class="conv-name">${esc(c.customerName)}</span>
          ${chanIcon(c.channel)}
        </span>
        <span class="conv-preview">${esc(c.lastMessage || '—')}</span>
      </span>
      <span class="conv-item-right">
        <span class="conv-time">${fmtTimeShort(c.lastTime)}</span>
        ${badge(c.badge)}
      </span>
    </button>`).join('');

  main.innerHTML = `
    ${tabs}
    <div class="conv-layout">
      <div class="card conv-list-col" style="padding:0">
        <div class="conv-search"><input id="chatSearch" placeholder="${t('conv.search_ph')}" value="${esc(state.chatSearch)}"></div>
        <div class="conv-items">${listHtml || `<div class="tbl-empty" style="padding:24px">${t('conv.empty')}</div>`}</div>
      </div>
      <div class="card chat-col" style="padding:0">${chatColHtml(detail)}</div>
      <div class="card conv-info-col" style="padding:0">${infoColHtml(detail)}</div>
    </div>`;

  bindConversationEvents();
  const tChat = $('#tabChat');
  if (tChat) tChat.addEventListener('click', () => { state.convTab = 'chat'; renderConversations(); });
  const tRuns = $('#tabRuns');
  if (tRuns) tRuns.addEventListener('click', () => { state.convTab = 'runs'; state.agentRunDetail = null; renderConversations(); });
}

// ---- SURI P2 (hạng mục 5b): bảng AgentRun (run_id/state/steps) + xem chi tiết step ----
async function renderAgentRuns(tabsHtml) {
  let runs = [];
  try { runs = (await api('/api/agent/runs?limit=50')).runs || []; }
  catch (e) { /* render rỗng + báo */ }
  state.agentRuns = runs;
  const RUN_CLS = { DONE: 'pill-green', RUNNING: 'pill-blue', NEEDS_HUMAN: 'pill-amber', FAILED: 'pill-red' };
  const rows = runs.map(r => `
    <tr class="run-row" data-run="${esc(r.run_id)}" style="cursor:pointer">
      <td style="font-family:monospace;font-size:12px" title="${esc(r.run_id)}">${esc(String(r.run_id).slice(-14))}</td>
      <td>${fmtTime(r.started_at)}</td>
      <td>${chanIcon(r.channel)}</td>
      <td>${esc((r.customer_ref || '').slice(0, 18))}</td>
      <td>${esc(r.intent || '—')}</td>
      <td>${esc(r.decision || '—')}</td>
      <td><span class="pill ${RUN_CLS[r.status] || 'pill-gray'}"><span class="dot"></span>${esc(r.status)}</span></td>
      <td><strong>${r.steps_count || 0}</strong></td>
    </tr>`).join('');
  main.innerHTML = `
    ${tabsHtml}
    <div class="card">
      <h2>Agent runs — vệt xử lý mỗi tin khách vào (UNDERSTAND → DECISION → SEND)</h2>
      <small style="display:block;color:var(--text-faint);margin-bottom:8px">Bấm 1 dòng để xem chi tiết từng step. Nguồn: agent_runs/agent_steps trong DB shop (persist qua restart).</small>
      <div class="table-wrap">
        <table class="tbl">
          <thead><tr><th>Run ID</th><th>Bắt đầu</th><th>Kênh</th><th>Khách</th><th>Intent</th><th>Quyết định</th><th>Trạng thái</th><th>Steps</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="8" class="tbl-empty">Chưa có run nào — run xuất hiện khi khách nhắn tin</td></tr>'}</tbody>
        </table>
      </div>
      <div id="runDetail" style="margin-top:12px"></div>
    </div>`;
  const tChat = $('#tabChat');
  if (tChat) tChat.addEventListener('click', () => { state.convTab = 'chat'; renderConversations(); });
  const tRuns = $('#tabRuns');
  if (tRuns) tRuns.addEventListener('click', () => { state.convTab = 'runs'; renderConversations(); });
  document.querySelectorAll('.run-row').forEach(tr => tr.addEventListener('click', () => showRunDetail(tr.dataset.run)));
}

async function showRunDetail(runId) {
  const box = $('#runDetail');
  if (!box) return;
  box.innerHTML = '<span style="color:var(--text-faint)">đang tải run…</span>';
  try {
    const d = await api(`/api/agent/runs/${encodeURIComponent(runId)}`);
    const steps = (d.steps || []).map(s => {
      const outs = s.output ? Object.entries(s.output).map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 120)}`).join(' · ') : '';
      const tools = (s.tool_calls || []).map(c => `${esc(c.tool)}: ${esc(String(c.status || ''))}`).join(', ');
      return `<li style="margin-bottom:6px"><strong>${esc(s.type)}</strong> <small style="color:var(--text-faint)">${fmtTime(s.at)}</small><br>
        <small>${esc(outs)}</small>${tools ? `<br><small style="color:var(--primary)">tool: ${tools}</small>` : ''}</li>`;
    }).join('');
    box.innerHTML = `
      <div style="border:1.5px solid var(--border-gray);border-radius:10px;padding:12px">
        <h3 style="margin:0 0 6px">Run <span style="font-family:monospace">${esc(runId)}</span>
          <span class="pill ${RUN_CLS_CHECK(d.run.status)}"><span class="dot"></span>${esc(d.run.status)}</span></h3>
        <small style="color:var(--text-faint)">Bắt đầu: ${esc(d.started_at_vn || d.run.started_at)} · Kết thúc: ${esc(d.ended_at_vn || d.run.ended_at || '—')} · Input: "${esc(d.run.input && d.run.input.text || '')}"</small>
        <ol style="margin:10px 0 0 18px">${steps || '<li>không có step</li>'}</ol>
      </div>`;
  } catch (e) {
    box.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`;
  }
}
function RUN_CLS_CHECK(st) { return { DONE: 'pill-green', RUNNING: 'pill-blue', NEEDS_HUMAN: 'pill-amber', FAILED: 'pill-red' }[st] || 'pill-gray'; }

function chatColHtml(d) {
  if (!d) return `<div class="chat-empty">${t('conv.pick')}</div>`;
  const banner = d.mode === 'HUMAN'
    ? `<div class="chat-banner human">${t('conv.banner_human')}${d.human_agent ? ' — ' + esc(d.human_agent) : ''}</div>`
    : `<div class="chat-banner ai">${t('conv.banner_ai')}</div>`;
  const msgs = (d.messages || []).map(m => {
    if (m.sender === 'system') {
      return `<div class="msg-row system"><div class="bubble">${esc(m.text || '')}<div class="msg-meta">${fmtTime(m.time)}</div></div></div>`;
    }
    const isIn = m.direction === 'in';
    const meta = [];
    meta.push(fmtTime(m.time));
    if (!isIn) {
      meta.push(m.sender === 'agent' ? t('conv.sender_agent') : m.sender === 'bot' ? t('conv.sender_bot') : t('conv.sender_system'));
      if (m.delivery_status) meta.push(`<span class="dlv dlv-${esc(m.delivery_status)}">${dlvLabel(m.delivery_status)}</span>`);
    }
    if (m.attachment) meta.push(m.attachment.type === 'voice' ? 'Voice (ASR)' : t('conv.photo'));
    return `
      <div class="msg-row ${isIn ? 'in' : 'out'}">
        <div class="bubble ${!isIn && m.sender === 'agent' ? 'from-agent' : ''}">
          ${esc(m.text || (m.attachment ? `[${m.attachment.type === 'voice' ? t('conv.voice') : t('conv.photo')}]` : ''))}
          <div class="msg-meta">${meta.map((p) => p.startsWith('<span class="dlv') ? p : esc(p)).join(' · ')}</div>
        </div>
      </div>`;
  }).join('');
  return `
    <div class="chat-head">
      <div class="who">
        <span class="conv-ava">${esc((d.customer && d.customer.name || '?').slice(0, 1).toUpperCase())}</span>
        <div>
          <strong>${esc(d.customer ? d.customer.name : d.id)}</strong>
          <div style="font-size:12px;color:var(--text-faint);display:flex;align-items:center;gap:6px">
            ${chanIcon(d.channel)} <span>${stateLabel(d.state)}</span>
            ${badge(d.mode === 'HUMAN' ? 'HUMAN' : (d.state === 'ORDERED' ? 'ORDERED' : 'AI'))}
          </div>
        </div>
      </div>
      ${d.claim ? `<span class="pill pill-amber"><span class="dot"></span>${t('info.claim_tag', { reason: esc(d.claim.reason) })}</span>` : ''}
    </div>
    ${banner}
    <div class="chat-msgs" id="chatMsgs">${msgs || `<div class="chat-empty">${t('conv.no_msgs')}</div>`}</div>
    <div class="chat-actions">
      <button class="btn-big btn-takeover" id="btnTakeover" ${d.mode === 'HUMAN' ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
        ${t('conv.takeover')}
      </button>
      <button class="btn-big btn-handback" id="btnHandback" ${d.mode !== 'HUMAN' ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        ${t('conv.handback')}
      </button>
    </div>
    <div class="composer">
      <textarea id="composer" placeholder="${t('conv.composer_ph')}">${esc(state.composerText)}</textarea>
      <button class="btn-send" id="btnSend">${t('conv.send')}</button>
    </div>`;
}

function infoColHtml(d) {
  if (!d) return `<div class="info-rows"><div class="tbl-empty">${t('conv.no_data')}</div></div>`;
  const c = d.customer || {};
  const rows = [];
  const row = (lbl, val) => `<div class="info-row"><div class="lbl">${lbl}</div><div class="val">${val}</div></div>`;
  rows.push(row(t('info.name'), esc(c.name || '—')));
  rows.push(row(t('info.phone'), esc(c.phone || '—')));
  rows.push(row(t('info.address'), esc(c.address || '—')));
  rows.push(row(t('info.channel'), `${chanIcon(d.channel)} ${esc(d.channel)}`));
  rows.push(row(t('info.asking'), esc(d.subject_name ? `${d.subject_name}${d.subject_sku ? ' (' + d.subject_sku + ')' : ''}` : '—')));
  rows.push(row(t('info.status'), `<span class="pill pill-pink"><span class="dot"></span>${stateLabel(d.state)}</span>`));
  if (d.draft && d.draft.items && d.draft.items.length) {
    rows.push(row(t('info.cart'), d.draft.items.map(i => `${i.qty} x ${esc(i.name)}`).join('<br>') + (d.draft.missing.length ? `<br><small style="color:var(--amber)">${t('info.missing')} ${esc(d.draft.missing.join(', '))}</small>` : '')));
  }
  if (d.latest_order) {
    const o = d.latest_order;
    rows.push(row(t('info.latest_order'), `${esc(o.order_code)} · ${orderStatusPill(o.display_status)}<br><strong>${fmtVND(o.total)}</strong> · ${fmtTime(o.created_at)}${o.tracking_number ? `<br>${t('info.tracking')} ${esc(o.tracking_number)}` : ''}`));
  }
  if (d.channel === 'facebook') {
    const w = d.window || {};
    rows.push(row(t('info.fb_window'), w.open
      ? `<span class="pill pill-green"><span class="dot"></span>${t('info.open')}</span>`
      : `<span class="pill pill-gray"><span class="dot"></span>${t('info.closed')}</span>` + (w.last_user_event_ts ? ` <small style="color:var(--text-faint)">${t('info.last_seen', { time: fmtTime(w.last_user_event_ts) })}</small>` : '')));
  }
  if (d.quota) {
    rows.push(row(t('info.zalo_quota'), t('info.remaining', { n: `<strong>${d.quota.cs_remain}</strong>`, total: d.quota.cs_total })));
  }
  if (d.claim) {
    rows.push(row(t('info.claim'), `${t('info.claim_opened', { time: fmtTime(d.claim.opened_at) })} ${esc(d.claim.reason)}`));
  }
  if (d.opt_out) rows.push(row(t('info.marketing'), `<span class="pill pill-amber"><span class="dot"></span>${t('info.opted_out')}</span>`));
  return `<div class="info-rows">${rows.join('')}</div>`;
}

function bindConversationEvents() {
  document.querySelectorAll('.conv-item').forEach(b => {
    b.addEventListener('click', () => {
      state.activeConvId = b.dataset.conv;
      state.composerText = '';
      renderConversations();
    });
  });
  const search = $('#chatSearch');
  if (search) {
    search.addEventListener('input', () => {
      // lọc đơn giản: vẽ lại view sau khi người dùng ngừng gõ, giữ nội dung composer
      clearTimeout(renderConversations._t);
      renderConversations._t = setTimeout(() => {
        state.chatSearch = search.value;
        const c = $('#composer');
        if (c) state.composerText = c.value;
        renderConversations().then(() => {
          const s = $('#chatSearch');
          if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
        });
      }, 250);
    });
  }
  const composer = $('#composer');
  if (composer) {
    composer.addEventListener('input', () => { state.composerText = composer.value; });
    composer.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAgentMessage(); }
    });
  }
  const btnSend = $('#btnSend');
  if (btnSend) btnSend.addEventListener('click', sendAgentMessage);
  const btnTake = $('#btnTakeover');
  if (btnTake) btnTake.addEventListener('click', async () => {
    try {
      await api(`/api/conversations/${encodeURIComponent(state.activeConvId)}/takeover`, { method: 'POST' });
      toast(t('conv.toast_takeover'));
      renderConversations();
    } catch (e) { toast('Lỗi: ' + e.message, true); }
  });
  const btnBack = $('#btnHandback');
  if (btnBack) btnBack.addEventListener('click', async () => {
    try {
      await api(`/api/conversations/${encodeURIComponent(state.activeConvId)}/handback`, { method: 'POST' });
      toast(t('conv.toast_handback'));
      renderConversations();
    } catch (e) { toast('Lỗi: ' + e.message, true); }
  });
  const box = $('#chatMsgs');
  if (box) box.scrollTop = box.scrollHeight;
}

async function sendAgentMessage() {
  const text = ($('#composer') || {}).value || '';
  if (!text.trim() || !state.activeConvId) return;
  try {
    const r = await api(`/api/conversations/${encodeURIComponent(state.activeConvId)}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (r.sent) {
      state.composerText = '';
      toast(t('conv.toast_sent') + (r.delivery_status ? ` (${dlvLabel(r.delivery_status)})` : ''));
    } else {
      toast(t('conv.toast_reject') + ' ' + (r.reason || 'không rõ lý do'), true);
    }
    renderConversations();
  } catch (e) {
    toast('Lỗi gửi: ' + e.message, true);
  }
}

// ============================================================ VIEW: ĐƠN HÀNG
// i18n: nhãn chip là KEY (dịch lúc render).
const ORDER_FILTERS = [
  ['ALL', 'ord.f_all'], ['DRAFT', 'ord.f_draft'], ['CONFIRMED', 'ord.f_confirmed'], ['SHIPPING', 'ord.f_shipping'],
  ['DELIVERED', 'ord.f_delivered'], ['CANCELLED', 'ord.f_cancelled'], ['CANCEL_PENDING', 'ord.f_cancel_pending'],
];

async function renderOrders() {
  const data = await api(`/api/orders?status=${state.orderFilter}`);
  state.orders = data.orders || [];
  const chips = ORDER_FILTERS.map(([k, key]) =>
    `<button class="chip ${state.orderFilter === k ? 'active' : ''}" data-filter="${k}">${t(key)}</button>`).join('');
  const rows = state.orders.map(o => `
    <tr class="clickable" data-order="${esc(o.order_id)}">
      <td><strong>${esc(o.order_code)}</strong></td>
      <td>${esc(o.customer_name)}</td>
      <td style="max-width:260px">${esc(o.products)}</td>
      <td class="num"><strong>${fmtVND(o.total)}</strong></td>
      <td>${orderStatusPill(o.display_status)}</td>
      <td>${o.shipment ? `${esc(o.shipment.tracking_number)}<br><small style="color:var(--text-faint)">${esc(o.shipment.status)}</small>` : '—'}</td>
      <td style="white-space:nowrap;color:var(--text-light)">${fmtTime(o.created_at)}</td>
    </tr>`).join('');
  main.innerHTML = `
    <div class="page-head">
      <div><h1>${t('ord.title')}</h1><div class="sub">${t('ord.sub', { n: state.orders.length })}</div></div>
      <div class="chips">${chips}</div>
    </div>
    <div class="card" style="padding:6px 14px">
      <div class="table-wrap">
        <table class="tbl">
          <thead><tr><th>${t('ord.th_code')}</th><th>${t('ord.th_customer')}</th><th>${t('ord.th_products')}</th><th class="num">${t('ord.th_total')}</th><th>${t('ord.th_status')}</th><th>${t('ord.th_shipping')}</th><th>${t('ord.th_time')}</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="7" class="tbl-empty">${t('ord.empty')}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
  document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
    state.orderFilter = c.dataset.filter;
    renderOrders();
  }));
  document.querySelectorAll('tr[data-order]').forEach(tr =>
    tr.addEventListener('click', () => openOrderDrawer(tr.dataset.order)));
}

async function openOrderDrawer(orderId) {
  const o = await api(`/api/orders/${encodeURIComponent(orderId)}`);
  const items = (o.items || []).map(i => `
    <tr><td>${esc(i.name)}</td><td>${esc(i.sku)}</td><td class="num">${i.qty}</td><td class="num">${fmtVND(i.unit_price)}</td><td class="num">${fmtVND(i.line_total)}</td></tr>`).join('');
  const hist = (o.history || []).map(hh => `
    <div class="tl-item"><span class="tl-time">${fmtTime(hh.at)}</span><span>${esc(hh.from || '—')} → <strong>${esc(hh.to)}</strong>${hh.actor ? ` <small style="color:var(--text-faint)">(bởi ${esc(hh.actor)}${hh.reason ? ': ' + esc(hh.reason) : ''})</small>` : ''}</span></div>`).join('');
  const audit = (o.audit || []).map(a => `
    <div class="audit-line"><strong>${esc(a.stage)}</strong> · ${esc(a.proposed_action || '')} → ${esc(a.execution_result || '')} <span style="color:var(--text-faint)">· ${fmtTime(a.at)}</span></div>`).join('');
  // i18n: nhãn gốc các nút drawer — "XÁC NHẬN ĐƠN", "RETRY HỦY QUA ĐVVC", "RETRY GỬI HÀNG",
  // "HỦY ĐƠN", "Mở hội thoại" (dịch qua key ord.btn_*; chuỗi gốc giữ ở đây làm tài liệu).
  const drawer = $('#drawer');
  drawer.innerHTML = `
    <div class="drawer-head">
      <div>
        <h2>${esc(o.order_code)}</h2>
        <div style="margin-top:4px">${orderStatusPill(o.display_status)}</div>
      </div>
      <button class="drawer-close" id="drawerClose">×</button>
    </div>
    <div class="drawer-sec"><h3>${t('ord.sect_customer')}</h3>
      <div class="kv-grid">
        <span class="k">${t('ord.k_name')}</span><span class="v">${esc(o.customer ? o.customer.name : '—')}</span>
        <span class="k">${t('ord.k_phone')}</span><span class="v">${esc(o.customer && o.customer.phone || '—')}</span>
        <span class="k">${t('ord.k_channel')}</span><span class="v">${o.customer ? chanIcon(o.customer.channel) + ' ' + esc(o.customer.channel) : '—'}</span>
        <span class="k">${t('ord.k_address')}</span><span class="v">${esc(o.address_snapshot || '—')}</span>
        <span class="k">${t('ord.k_created')}</span><span class="v">${fmtTime(o.created_at)}</span>
      </div>
    </div>
    <div class="drawer-sec"><h3>${t('ord.sect_products')}</h3>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>${t('ord.sect_products')}</th><th>SKU</th><th class="num">${t('ord.th_qty')}</th><th class="num">${t('ord.th_price')}</th><th class="num">${t('ord.th_line_total')}</th></tr></thead>
        <tbody>${items}</tbody>
      </table></div>
      <div class="kv-grid" style="margin-top:10px">
        <span class="k">${t('ord.k_subtotal')}</span><span class="v num">${fmtVND(o.subtotal)}</span>
        <span class="k">${t('ord.k_ship_fee')}</span><span class="v num">${fmtVND(o.shipping_fee)}</span>
        <span class="k"><strong>${t('ord.k_total')}</strong></span><span class="v num"><strong>${fmtVND(o.total)}</strong></span>
      </div>
    </div>
    <div class="drawer-sec"><h3>${t('ord.sect_shipping')}</h3>
      ${o.shipment
        ? `<div class="kv-grid">
            <span class="k">${t('ord.k_tracking')}</span><span class="v">${esc(o.shipment.tracking_number)}</span>
            <span class="k">${t('ord.th_status')}</span><span class="v">${esc(o.shipment.status)} (${esc(o.shipment.carrier)})</span>
            <span class="k">${t('ord.k_created')}</span><span class="v">${fmtTime(o.shipment.created_at)}</span>
          </div>`
        : (o.status === 'DRAFT' ? '<span style="color:var(--text-faint)">Đơn nháp — chưa tạo vận đơn. Giữ chỗ hết hạn: ' + fmtTime(o.draft_expires_at) + '</span>' : '<span style="color:var(--text-faint)">' + t('ord.no_shipment') + '</span>')}
      ${o.status === 'CANCELLED' ? `<div style="margin-top:8px;color:var(--red)">Đã hủy · bởi ${esc(o.cancel_actor || '—')} · ${esc(o.cancel_reason || '')} · ${fmtTime(o.cancel_at)}</div>` : ''}
      ${o.status === 'CANCEL_PENDING' ? `<div style="margin-top:8px;color:var(--amber)">Đang chờ ĐVVC xác nhận hủy: ${esc(o.cancel_carrier_reason || '')}</div>` : ''}
    </div>
    <div class="drawer-sec"><h3>${t('ord.sect_history')}</h3><div class="timeline">${hist || `<span style="color:var(--text-faint)">${t('ord.none')}</span>`}</div></div>
    <div class="drawer-sec"><h3>${t('ord.sect_audit')}</h3>${audit || `<span style="color:var(--text-faint)">${t('ord.none')}</span>`}</div>
    <div class="drawer-actions">
      ${o.status === 'DRAFT' ? `<button class="btn btn-primary" id="btnConfirmOrder" data-order="${esc(o.order_id)}">${t('ord.btn_confirm')}</button>` : ''}
      ${o.status === 'CANCEL_PENDING' ? `<button class="btn" id="btnRetryShipping" data-order="${esc(o.order_id)}" title="Gọi lại hủy vận đơn qua ĐVVC (đúng flow P3B)">${t('ord.btn_retry_cancel')}</button>` : ''}
      ${o.status === 'CONFIRMED' && !o.shipment ? `<button class="btn" id="btnRetryShipping" data-order="${esc(o.order_id)}" title="Gọi lại bước gửi hàng (reconcile — KHÔNG tạo trùng vận đơn)">${t('ord.btn_retry_ship')}</button>` : ''}
      ${['DRAFT', 'CONFIRMED'].includes(o.status) ? `<button class="btn-danger btn" id="btnCancelOrder" data-order="${esc(o.order_id)}">${t('ord.btn_cancel')}</button>` : ''}
      <button class="btn" id="btnViewConv">${t('ord.btn_open_conv')}</button>
    </div>`;
  drawer.classList.remove('hidden');
  $('#drawerOverlay').classList.remove('hidden');
  $('#drawerClose').addEventListener('click', closeDrawer);
  const btnConfirm = $('#btnConfirmOrder');
  if (btnConfirm) btnConfirm.addEventListener('click', async () => {
    if (!confirm(`Chốt đơn ${o.order_code}? Hệ thống re-validate tồn/giá MỚI NHẤT rồi mới commit (pha B).`)) return;
    try {
      const r = await api(`/api/orders/${encodeURIComponent(o.order_id)}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      toast(r.ok ? (r.shipment ? `Đã chốt ${r.order.order_code} — vận đơn ${r.shipment.tracking_number}` : `Đã chốt ${r.order.order_code} (đang chờ vận đơn)`) : 'Chưa chốt được', r.ok ? false : true);
      closeDrawer();
      renderOrders();
    } catch (e) { toast('Lỗi: ' + e.message, true); }
  });
  const btnRetry = $('#btnRetryShipping');
  if (btnRetry) btnRetry.addEventListener('click', async () => {
    if (!confirm('Gọi lại bước gửi/hủy vận đơn qua ĐVVC (đúng luồng engine, không sửa DB trực tiếp)?')) return;
    try {
      const r = await api(`/api/orders/${encodeURIComponent(o.order_id)}/retry-shipping`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      toast(r.ok ? `Đã retry — đơn ${r.order.status}` : `Chưa được: ${r.reason || r.error}`, r.ok ? false : true);
      closeDrawer();
      renderOrders();
    } catch (e) { toast('Lỗi: ' + e.message, true); }
  });
  const btnCancel = $('#btnCancelOrder');
  if (btnCancel) btnCancel.addEventListener('click', async () => {
    if (!confirm(`Hủy đơn ${o.order_code}? Hệ thống sẽ hoàn tồn / hủy vận đơn qua ĐVVC đúng luồng P3B.`)) return;
    try {
      const r = await api(`/api/orders/${encodeURIComponent(o.order_id)}/cancel`, { method: 'POST' });
      if (r.ok) toast(`Đã hủy ${r.order.order_code}${r.viaCarrier ? ' (kèm hủy vận đơn qua ĐVVC)' : ''}`);
      else toast('Chưa hủy được: ' + (r.reason || 'đang chờ xử lý'), true);
      closeDrawer();
      renderOrders();
    } catch (e) { toast('Lỗi: ' + e.message, true); }
  });
  $('#btnViewConv').addEventListener('click', () => {
    closeDrawer();
    state.activeConvId = o.conversation_id;
    switchView('conversations');
  });
}

function closeDrawer() {
  $('#drawer').classList.add('hidden');
  $('#drawerOverlay').classList.add('hidden');
}

// ============================================================ VIEW: SẢN PHẨM
async function renderProducts() {
  const data = await api('/api/products' + (state.productQuery ? `?q=${encodeURIComponent(state.productQuery)}` : ''));
  state.products = data.products || [];
  const rows = state.products.map(p => {
    const v0 = p.variants[0] || {};
    const totalStock = p.variants.reduce((t, v) => t + v.effective, 0);
    return `
    <tr style="${p.enabled ? '' : 'opacity:.55'}">
      <td>${p.image
        ? `<img src="${esc(p.image)}" alt="" style="width:38px;height:38px;border-radius:8px;object-fit:cover;background:var(--primary-softer)" onerror="this.outerHTML='<span class=&quot;conv-ava&quot;>${esc(p.name.slice(0, 1).toUpperCase())}</span>'">`
        : `<span class="conv-ava">${esc(p.name.slice(0, 1).toUpperCase())}</span>`}</td>
      <td><strong>${esc(p.name)}</strong><br><small style="color:var(--text-faint)">${esc((p.aliases || []).slice(0, 3).join(', '))}</small></td>
      <td>${esc(p.sku_base)}</td>
      <td class="num">${p.variants.length > 1
        ? `${fmtVND(v0.price)}…<br><small style="color:var(--text-faint)">${p.variants.length} giá</small>`
        : fmtVND(v0.price)}</td>
      <td class="num">${totalStock > 0 ? t('prd.in_stock', { n: `<strong>${totalStock}</strong>` }) : `<span style="color:var(--red)">${t('prd.out_of_stock')}</span>`}</td>
      <td><span class="pill ${p.enabled ? 'pill-green' : 'pill-gray'}"><span class="dot"></span>${p.enabled ? t('prd.active') : t('prd.paused')}</span></td>
      <td style="white-space:nowrap">
        <button class="switch ${p.enabled ? 'on' : ''}" data-toggle="${esc(p.sku_base)}" title="${p.enabled ? 'Tắt bán' : 'Bật bán'}"></button>
        <button class="btn" style="margin-left:8px" data-edit="${esc(p.sku_base)}">${t('prd.btn_edit')}</button>
        <button class="btn btn-danger" style="margin-left:8px" data-delete="${esc(p.sku_base)}" title="Xóa mềm (tắt bán vĩnh viễn khỏi bot)">${t('prd.btn_delete')}</button>
      </td>
    </tr>`;
  }).join('');
  main.innerHTML = `
    <div class="page-head">
      <div><h1>${t('prd.title')}</h1><div class="sub">${t('prd.sub', { n: state.products.length })}</div></div>
      <div style="display:flex;gap:10px">
        <input id="pSearch" value="${esc(state.productQuery)}" placeholder="${t('prd.search_ph')}" style="padding:8px 12px;border:1.5px solid var(--border-gray);border-radius:10px;min-width:220px">
        <button class="btn" id="btnImportCsv">${t('prd.import')}</button>
        <button class="btn btn-primary" id="btnAddProduct">${t('prd.add')}</button>
      </div>
    </div>
    <div class="card" style="padding:6px 14px">
      <div class="table-wrap">
        <table class="tbl">
          <thead><tr><th>${t('prd.th_image')}</th><th>${t('prd.th_name')}</th><th>SKU</th><th class="num">${t('prd.th_price')}</th><th class="num">${t('prd.th_stock')}</th><th>${t('prd.th_status')}</th><th>${t('prd.th_actions')}</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="7" class="tbl-empty">${t('prd.empty')}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
  $('#btnAddProduct').addEventListener('click', () => openProductModal(null));
  $('#pSearch').addEventListener('keydown', e => {
    if (e.key === 'Enter') { state.productQuery = $('#pSearch').value.trim(); renderProducts(); }
  });
  $('#btnImportCsv').addEventListener('click', openImportModal);
  document.querySelectorAll('[data-edit]').forEach(b =>
    b.addEventListener('click', () => openProductModal(b.dataset.edit)));
  document.querySelectorAll('[data-delete]').forEach(b =>
    b.addEventListener('click', async () => {
      const p = state.products.find(x => x.sku_base === b.dataset.delete);
      if (!confirm(`Xóa mềm "${p.name}"? Sản phẩm tắt sẽ KHÔNG còn được bot tư vấn (đơn cũ vẫn đọc được).`)) return;
      try {
        await api(`/api/products/${encodeURIComponent(p.sku_base)}`, { method: 'DELETE' });
        toast(`Đã xóa mềm "${p.name}" — bot không còn match sản phẩm này`);
        renderProducts();
      } catch (e) { toast('Lỗi: ' + e.message, true); }
    }));
  document.querySelectorAll('[data-toggle]').forEach(b =>
    b.addEventListener('click', async () => {
      const p = state.products.find(x => x.sku_base === b.dataset.toggle);
      try {
        await api(`/api/products/${encodeURIComponent(p.sku_base)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !p.enabled }),
        });
        toast(p.enabled ? `Đã tắt bán "${p.name}"` : `Đã bật bán "${p.name}"`);
        renderProducts();
      } catch (e) { toast('Lỗi: ' + e.message, true); }
    }));
}

function openImportModal() {
  const modal = $('#modalBox');
  modal.innerHTML = `
    <h2>${t('prd.import_title')}</h2>
    <p style="font-size:13px;color:var(--text-light);margin-bottom:10px">
      Cột: <code>name,sku,price,stock,size,color,weight</code> — dòng đầu là header. Dòng lỗi sẽ được báo, không chặn dòng hợp lệ.</p>
    <div class="form-row"><textarea id="csvText" rows="10" style="width:100%;padding:10px;border:1.5px solid var(--border-gray);border-radius:10px;font-family:Consolas,monospace;font-size:13px" placeholder="name,sku,price,stock,size,color,weight&#10;Nến thơm cam,NT-CAM,155000,10,M,cam,250"></textarea></div>
    <div id="csvResult" style="font-size:13px;margin-bottom:8px"></div>
    <div class="modal-actions">
      <button class="btn" id="csvCancel">${t('prd.close')}</button>
      <button class="btn btn-primary" id="csvImport">Import</button>
    </div>`;
  $('#modalOverlay').classList.remove('hidden');
  $('#csvCancel').addEventListener('click', closeModal);
  $('#csvImport').addEventListener('click', async () => {
    const csv = $('#csvText').value;
    try {
      const r = await api('/api/products/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }),
      });
      const errs = (r.errors || []).map(e => `dòng ${e.line !== null && e.line !== undefined ? e.line : '?'}: ${esc(e.error)}`).join('<br>');
      $('#csvResult').innerHTML = `<span style="color:var(--green)">Đã import ${r.imported} sản phẩm</span>${r.failed ? ` · <span style="color:var(--red)">${r.failed} dòng lỗi</span><br>${errs}` : ''}`;
      if (!r.failed) { toast(`Đã import ${r.imported} sản phẩm`); closeModal(); renderProducts(); }
    } catch (e) { $('#csvResult').innerHTML = `<span style="color:var(--red)">Lỗi: ${esc(e.message)}</span>`; }
  });
}

function openProductModal(skuBase) {
  const p = skuBase ? state.products.find(x => x.sku_base === skuBase) : null;
  const v0 = p ? p.variants[0] || {} : {};
  const modal = $('#modalBox');
  modal.innerHTML = `
    <h2>${p ? t('prd.modal_edit') : t('prd.modal_add')}</h2>
    <div class="form-row"><label>${t('prd.lbl_name')}</label><input id="pfName" value="${esc(p ? p.name : '')}" placeholder="VD: Nến thơm s candle"></div>
    ${p ? '' : '<div class="form-row"><label>SKU gốc (sku_base)</label><input id="pfSku" placeholder="VD: NEN-S-CANDLE"></div>'}
    <div class="form-2col">
      <div class="form-row"><label>${t('prd.lbl_price')}</label><input id="pfPrice" type="number" min="0" value="${p ? v0.price || '' : ''}"></div>
      <div class="form-row"><label>${t('prd.lbl_stock')}</label><input id="pfStock" type="number" min="0" value="${p ? v0.stock_qty || 0 : 0}"></div>
    </div>
    ${p ? '' : `<div class="form-2col">
      <div class="form-row"><label>${t('prd.lbl_size')}</label><input id="pfSize" placeholder="S / M / hộp 50g…"></div>
      <div class="form-row"><label>${t('prd.lbl_color')}</label><input id="pfColor" placeholder="đỏ / trắng…"></div>
    </div>`}
    <div class="form-row"><label>${t('prd.lbl_alias')}</label><input id="pfAliases" value="${esc(p ? (p.aliases || []).join(', ') : '')}" placeholder="candle thơm, nen thom"></div>
    <div class="modal-actions">
      <button class="btn" id="pfCancel">${t('prd.cancel')}</button>
      <button class="btn btn-primary" id="pfSave">${p ? t('prd.save') : t('prd.add_short')}</button>
    </div>`;
  $('#modalOverlay').classList.remove('hidden');
  $('#pfCancel').addEventListener('click', closeModal);
  $('#pfSave').addEventListener('click', async () => {
    const body = {
      name: $('#pfName').value.trim(),
      price: Number($('#pfPrice').value),
      stock_qty: Number($('#pfStock').value),
      aliases: $('#pfAliases').value.trim(),
    };
    try {
      if (p) {
        body.sku = v0.sku;
        await api(`/api/products/${encodeURIComponent(p.sku_base)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        toast('Đã lưu sản phẩm');
      } else {
        body.sku_base = ($('#pfSku').value || '').trim();
        body.size = ($('#pfSize').value || '').trim();
        body.color = ($('#pfColor').value || '').trim();
        if (!body.sku_base) { toast('Cần nhập SKU gốc', true); return; }
        if (!Number.isFinite(body.price) || body.price <= 0) { toast('Giá phải là số > 0', true); return; }
        await api('/api/products', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        toast('Đã thêm sản phẩm vào catalogue');
      }
      closeModal();
      renderProducts();
    } catch (e) { toast('Lỗi: ' + e.message, true); }
  });
}

function closeModal() {
  $('#modalOverlay').classList.add('hidden');
}

// ============================================================ VIEW: KHÁCH HÀNG
async function renderCustomers() {
  const data = await api('/api/customers');
  state.customers = data.customers || [];
  const rows = state.customers.map(c => `
    <tr class="clickable" data-cus="${esc(c.customer_id)}">
      <td><strong>${esc(c.name)}</strong></td>
      <td>${esc(c.phone || '—')}</td>
      <td>${chanIcon(c.channel)} ${esc(c.channel)}</td>
      <td class="num">${c.orders_count}</td>
      <td class="num"><strong>${fmtVND(c.total_spent)}</strong></td>
      <td>${c.opt_out
        ? '<span class="pill pill-amber"><span class="dot"></span>' + t('cus.opt_out') + '</span>'
        : `<span class="pill pill-pink"><span class="dot"></span>${stateLabel(c.state)}</span>`}</td>
      <td style="white-space:nowrap;color:var(--text-light)">${fmtTime(c.last_interaction)}</td>
    </tr>`).join('');
  main.innerHTML = `
    <div class="page-head">
      <div><h1>${t('cus.title')}</h1><div class="sub">${t('cus.sub', { n: state.customers.length })}</div></div>
    </div>
    <div class="card" style="padding:6px 14px">
      <div class="table-wrap">
        <table class="tbl">
          <thead><tr><th>${t('cus.th_name')}</th><th>${t('cus.th_phone')}</th><th>${t('cus.th_channel')}</th><th class="num">${t('cus.th_orders')}</th><th class="num">${t('cus.th_spent')}</th><th>${t('cus.th_status')}</th><th>${t('cus.th_last')}</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="7" class="tbl-empty">${t('cus.empty')}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
  document.querySelectorAll('tr[data-cus]').forEach(tr =>
    tr.addEventListener('click', () => openCustomerDrawer(tr.dataset.cus)));
}

async function openCustomerDrawer(customerId) {
  const d = await api(`/api/customers/${encodeURIComponent(customerId)}`);
  const c = d.customer;
  const convs = (d.conversations || []).map(cv => `
    <div class="set-row">
      <span class="label"><strong>${chanIcon(cv.channel)} ${esc(cv.id)}</strong><small>${stateLabel(cv.state)}${cv.claim ? ' · khiếu nại: ' + esc(cv.claim.reason) : ''}</small></span>
      <button class="btn" data-openconv="${esc(cv.id)}">${t('ord.btn_open_conv')}</button>
    </div>`).join('');
  const orders = (d.orders || []).map(o => `
    <div class="set-row">
      <span class="label"><strong>${esc(o.order_code)}</strong><small>${esc(o.products)}</small></span>
      <span>${orderStatusPill(o.display_status)} <strong>${fmtVND(o.total)}</strong></span>
    </div>`).join('');
  const drawer = $('#drawer');
  drawer.innerHTML = `
    <div class="drawer-head">
      <div><h2>${esc(c.name)}</h2><small style="color:var(--text-faint)">${esc(c.platform_ref)}</small></div>
      <button class="drawer-close" id="drawerClose">×</button>
    </div>
    <div class="drawer-sec"><h3>${t('cus.sect_info')}</h3>
      <div class="kv-grid">
        <span class="k">${t('ord.k_phone')}</span><span class="v">${esc(c.phone || '—')}</span>
        <span class="k">${t('cus.marketing')}</span><span class="v">${c.marketing_opt_out
          ? '<span class="pill pill-amber"><span class="dot"></span>' + t('cus.opted_out') + ' ' + fmtTime(c.opt_out_at) + '</span>'
          : '<span class="pill pill-green"><span class="dot"></span>' + t('cus.subscribed') + '</span>'}</span>
        <span class="k">${t('cus.since')}</span><span class="v">${fmtTime(c.created_at)}</span>
      </div>
    </div>
    <div class="drawer-sec"><h3>${t('cus.sect_convs')}</h3>${convs || `<span style="color:var(--text-faint)">${t('ord.none')}</span>`}</div>
    <div class="drawer-sec"><h3>${t('cus.sect_orders', { n: (d.orders || []).length })}</h3>${orders || '<span style="color:var(--text-faint)">Chưa có đơn</span>'}</div>`;
  drawer.classList.remove('hidden');
  $('#drawerOverlay').classList.remove('hidden');
  $('#drawerClose').addEventListener('click', closeDrawer);
  drawer.querySelectorAll('[data-openconv]').forEach(b =>
    b.addEventListener('click', () => {
      closeDrawer();
      state.activeConvId = b.dataset.openconv;
      switchView('conversations');
    }));
}

// ============================================================ VIEW: CÀI ĐẶT
// AICAKE (G5): danh sách provider AI ĐỘNG từ GET /api/ai/status (agent C thêm gemini/grok/
// kimi). Response chưa có danh sách -> fallback 6 option cứng (local, deepseek, openai,
// gemini, grok, kimi). Provider hiện tại luôn được giữ trong danh sách.
function aiProviderOptions(aiStatusBody, current) {
  const FALLBACK = [
    { id: 'local', label: 'Local (stub — không gọi mạng)' },
    { id: 'deepseek', label: 'DeepSeek' },
    { id: 'openai', label: 'OpenAI' },
    { id: 'gemini', label: 'Gemini' },
    { id: 'grok', label: 'Grok' },
    { id: 'kimi', label: 'Kimi' },
  ];
  const a = (aiStatusBody && aiStatusBody.ai) || {};
  const raw = a.providers || a.available_providers || a.providers_list || null;
  let list = Array.isArray(raw)
    ? raw.map(p => {
      if (typeof p === 'string') return { id: p, label: p };
      if (p && p.id) return { id: p.id, label: p.name || (p.id + (p.defaultModel ? ' — mặc định: ' + p.defaultModel : '')) };
      return null;
    }).filter(Boolean)
    : [];
  if (!list.length) list = FALLBACK.slice();
  if (current && !list.some(x => x.id === current)) list.unshift({ id: current, label: current });
  return list.map(p => `<option value="${esc(p.id)}"${p.id === current ? ' selected' : ''}>${esc(p.label)}</option>`).join('');
}

// AICAKE (G5): công tắc comment (3 keys chuẩn aicake — src/shop-settings.js COMMENT_FLOW_DEFAULTS).
// Đọc giá trị hiện tại từ GET /api/settings (config_keys — settings shop đã redact); key chưa
// set -> mặc định BẬT (đúng defaults backend). Ghi qua POST /api/settings (object settings).
function boolishSetting(v) {
  if (v === undefined || v === null || v === '') return true; // COMMENT_FLOW_DEFAULTS: true
  return v === true || v === 'true' || v === 1 || v === '1';
}

async function saveCommentSwitches(next) {
  try {
    await api('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    toast('Đã lưu công tắc bình luận (pipeline đọc settings FRESH — hiệu lực ngay)');
    renderSettings();
  } catch (e) {
    toast('Chưa lưu được: ' + e.message, true);
  }
}

// AICAKE (G5): Thành viên team — GET/POST /api/auth/users. 403 (role không đủ quyền) ->
// hiện thông báo thay vì bảng. Tạo user: { email, password, role: OWNER/ADMIN/AGENT }.
async function loadTeamBox() {
  const box = $('#teamBox');
  if (!box) return;
  try {
    const r = await api('/api/auth/users');
    const users = r.users || [];
    const ROLE_LABEL = { OWNER: 'OWNER — chủ shop', ADMIN: 'ADMIN — quản trị', AGENT: 'AGENT — nhân viên bán' };
    box.innerHTML = (users.map(u => `
      <div class="set-row">
        <span class="label"><strong>${esc(u.email)}</strong><small>thêm vào ${esc(fmtTime(u.created_at))}</small></span>
        <span class="pill ${u.role === 'OWNER' ? 'pill-green' : 'pill-gray'}"><span class="dot"></span>${esc(ROLE_LABEL[u.role] || u.role)}</span>
      </div>`).join('')) || '<span style="color:var(--text-faint)">Chưa có thành viên nào</span>';
    const fw = $('#teamFormWrap');
    if (fw) fw.style.display = 'block';
  } catch (e) {
    if (e.status === 403) {
      box.innerHTML = '<div style="color:var(--text-faint);font-size:14px;padding:6px 0">Bạn không đủ quyền quản lý thành viên (403) — chỉ OWNER/ADMIN.</div>';
    } else {
      box.innerHTML = `<div style="color:var(--red);font-size:14px;padding:6px 0">Không tải được danh sách thành viên: ${esc(e.message)}</div>`;
    }
  }
}

async function renderSettings() {
  const [h, st, aiSt] = await Promise.all([
    api('/api/health'),
    api('/api/settings'),
    // AICAKE (G5): /api/ai/status lấy danh sách provider ĐỘNG — lỗi không chặn trang Settings
    api('/api/ai/status').catch(() => null),
  ]);
  state.health = h;
  state.settings = st;
  // SURI P1: hồ sơ shop cho AI (đọc lỗi im lặng — UI vẫn render nếu API lỗi)
  let prof = {};
  try { prof = (await api('/api/shop-profile')).profile || {}; } catch (e) { prof = {}; }
  state.shopProfile = prof;
  await loadCommon();
  const d = state.dashboard;
  const kenhRow = (name, label) => {
    // P2: trạng thái từ /api/health.providers (adapter BIÊN) — CONNECTED/DISCONNECTED/
    // PERMISSION_REQUIRED (meta) · TOKEN_EXPIRED (zalo) · STAGING/PRODUCTION_CONNECTED (ghn).
    const k = (h.providers && h.providers[name]) || d.kenh[name] || {};
    const lbl = k.status_label || (k.connected ? 'CONNECTED' : 'DISCONNECTED');
    const mock = k.mode !== 'live';
    const errHint = k.last_error_type ? ` · lỗi gần nhất: ${k.last_error_type}` : '';
    const sub = mock ? 'Mock adapter (prototype — chưa nối API thật)' : `Live adapter${errHint}`;
    return `
      <div class="set-row">
        <span class="label"><strong>${esc(label)}</strong><small>${esc(sub)}</small></span>
        <span class="pill ${k.connected ? 'pill-green' : 'pill-red'}"><span class="dot"></span>${esc(lbl)}${mock ? ' (mock)' : ''}</span>
      </div>`;
  };
  const fu = st.automation;
  const fuStatus = Object.entries(fu.follow_ups_by_status || {}).map(([k, v]) => `${esc(k)}: <strong>${v}</strong>`).join(' · ') || '—';
  const ai = st.ai || {};
  const shopCfg = st.shop || {};
  // AICAKE (G5): 3 công tắc comment — giá trị hiện tại từ settings shop (config_keys),
  // key chưa set -> mặc định BẬT (khớp COMMENT_FLOW_DEFAULTS trong src/shop-settings.js).
  const ck = st.config_keys || {};
  const cmt = {
    auto_reply_comment: boolishSetting(ck.auto_reply_comment),
    hide_negative_comment: boolishSetting(ck.hide_negative_comment),
    auto_inbox_from_comment: boolishSetting(ck.auto_inbox_from_comment),
  };
  const saveCmt = () => saveCommentSwitches({
    auto_reply_comment: $('#swAutoReplyComment').classList.contains('on'),
    hide_negative_comment: $('#swHideNegativeComment').classList.contains('on'),
    auto_inbox_from_comment: $('#swAutoInboxComment').classList.contains('on'),
  });
  const obCard = state.onboarding ? state.onboarding : null;
  main.innerHTML = `
    <div class="page-head"><div><h1>${t('set.title')}</h1><div class="sub">${t('set.sub')}</div></div>
      ${obCard && !obCard.canGoLive ? '<button class="btn btn-primary" id="goWizard">' + t('set.complete_setup', { p: esc(obCard.progress) }) + '</button>' : ''}
    </div>
    <div class="set-grid">
      <div class="card"><h2>${t('set.card_channels')}</h2>
        ${kenhRow('facebook', 'Facebook Messenger')}
        ${kenhRow('zalo', 'Zalo OA')}
        ${kenhRow('ghn', 'GHN (đơn vị vận chuyển)')}
      </div>
      <div class="card"><h2>${t('set.card_ai')}</h2>
        <div class="set-row"><span class="label"><strong>Provider</strong><small>${ai.model ? esc(ai.model) : t('set.not_configured')}</small></span>
          <span class="pill ${ai.status === 'ONLINE' ? 'pill-green' : ai.status === 'ERROR' ? 'pill-red' : 'pill-gray'}"><span class="dot"></span>${esc(ai.status || 'DISABLED')}</span></div>
        <div class="set-row"><span class="label"><strong>AI viết lời tư vấn</strong><small>SURI P2: bật = DeepSeek viết câu tư vấn trên FACTS (giá/tồn vẫn từ DB, Gate vẫn chặn số sai) · tắt = template FAQ stub</small></span>
          <button class="switch ${ai.use_for_replies !== false ? 'on' : ''}" id="setAiUseReplies"></button></div>
        <div class="set-row"><span class="label"><strong>API key</strong><small>chỉ lưu masked — không trả key ra browser</small></span><span class="v">${esc(ai.api_key_masked || '(empty)')}</span></div>
        <div class="set-row"><span class="label"><strong>last_error</strong><small>${ai.last_success ? 'last_success: ' + esc(ai.last_success) : 'chưa test'}</small></span><span class="v" style="color:${ai.last_error ? 'var(--red)' : 'inherit'};font-size:12.5px">${esc(ai.last_error || '—')}</span></div>
        <div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap">
          <button class="btn" id="btnAiTest">${t('set.test_ai')}</button>
          <button class="btn" id="btnAiConfig">${t('set.ai_config')}</button>
          <button class="btn" id="btnWireDeepseek">${t('set.wire_ds')}</button>
          <span id="wireOut" style="font-size:12.5px;align-self:center">đọc key từ provider config ngoài — key không bao giờ hiển thị</span>
        </div>
        <div id="aiCfgBox" style="display:none;margin-top:10px">
          <div class="form-row"><label>Provider (danh sách đọc động từ /api/ai/status)</label>
            <select id="aiProvider" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px;font-size:14px">${aiProviderOptions(aiSt, ai.provider)}</select></div>
          <div class="form-row"><label>API key (bỏ trống = giữ key cũ)</label><input id="aiKey" type="password" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px;font-size:14px"></div>
          <div class="form-row"><label>Model (override — bỏ trống = mặc định provider)</label><input id="aiModel" value="${esc(ai.model || '')}" placeholder="vd: deepseek-chat, gpt-4o-mini…" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px;font-size:14px"></div>
          <button class="btn btn-primary" id="btnAiSave">${t('set.save_ai')}</button>
        </div>
      </div>
      <div class="card"><h2>${t('set.card_prompt')}</h2>
        <div class="form-2col">
          <div class="form-row"><label>Giọng nói</label><input id="pGiongNoi" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px" placeholder="thân thiện, dùng 'dạ/ạ'"></div>
          <div class="form-row"><label>Cách xưng hô</label><input id="pXungHo" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px" placeholder="em gọi khách là anh/chị"></div>
        </div>
        <div class="form-2col">
          <div class="form-row"><label>Ưu tiên bán</label><input id="pUuTien" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px" placeholder="combo quà tặng, nến M"></div>
          <div class="form-row"><label>Ngôn ngữ</label><input id="pNgonNgu" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px" placeholder="tiếng Việt có dấu"></div>
        </div>
        <div class="form-row"><label>Chính sách đổi trả</label><input id="pDoiTra" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px" placeholder="đổi trả trong 7 ngày"></div>
        <div class="form-2col">
          <div class="form-row"><label>Giờ làm việc</label><input id="pGioLam" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px" placeholder="8h-21h mỗi ngày"></div>
          <div class="form-row"><label>Quy tắc chốt đơn</label><input id="pChotDon" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px" placeholder="hỏi đủ tên/SĐT/địa chỉ rồi xác nhận"></div>
        </div>
        <div class="form-row"><label>Không được nói (mỗi mục một dòng)</label><textarea id="pKhongNoi" rows="2" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px" placeholder="không cam kết giá sai DB&#10;không hứa giờ giao cụ thể"></textarea></div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-primary" id="btnPromptSave">${t('set.save_prompt')}</button>
          <button class="btn" id="btnPromptView">${t('set.view_prompt')}</button>
          <span id="promptOut" style="font-size:12.5px"></span>
        </div>
      </div>
      <div class="card"><h2>${t('set.card_profile')}</h2>
        <small style="display:block;color:var(--text-faint);margin-bottom:8px">Độ ưu tiên CAO HƠN cấu hình prompt cũ — field điền ở đây sẽ đè khi build system prompt. Cấm pattern secret (sk-/token/api-key…).</small>
        <div class="form-2col">
          <div class="form-row"><label>Tên shop</label><input id="spTen" value="${esc(prof.ten || '')}" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px"></div>
          <div class="form-row"><label>Lĩnh vực</label><input id="spLinhVuc" value="${esc(prof.linhVuc || '')}" placeholder="nến thơm handmade, trà hoa sấy" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px"></div>
        </div>
        <div class="form-2col">
          <div class="form-row"><label>Hotline</label><input id="spHotline" value="${esc(prof.hotline || '')}" placeholder="0900123456" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px"></div>
          <div class="form-row"><label>Logo (URL)</label><input id="spLogo" value="${esc(prof.logo || '')}" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px"></div>
        </div>
        <div class="form-row"><label>Địa chỉ</label><input id="spDiaChi" value="${esc(prof.diaChi || '')}" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px"></div>
        <div class="form-2col">
          <div class="form-row"><label>Giờ làm việc</label><input id="spGioLamViec" value="${esc(prof.gioLamViec || '')}" placeholder="8h-21h mỗi ngày" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px"></div>
          <div class="form-row"><label>Giọng nói</label><input id="spGiongNoi" value="${esc(prof.giongNoi || '')}" placeholder="thân thiện, dùng 'dạ/ạ'" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px"></div>
        </div>
        <div class="form-2col">
          <div class="form-row"><label>Cách xưng hô</label><input id="spCachXungHo" value="${esc(prof.cachXungHo || '')}" placeholder="em gọi khách là anh/chị" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px"></div>
          <div class="form-row"><label>CTA kết thúc</label><input id="spCta" value="${esc(prof.cta || '')}" placeholder="Anh/chị chốt đơn giúp em nha!" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px"></div>
        </div>
        <div class="form-row"><label>Chính sách đổi trả</label><input id="spChinhSachDoiTra" value="${esc(prof.chinhSachDoiTra || '')}" placeholder="đổi trả trong 7 ngày" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px"></div>
        <div class="form-row"><label>Chính sách giao hàng</label><input id="spChinhSachGiaoHang" value="${esc(prof.chinhSachGiaoHang || '')}" placeholder="2-4 ngày toàn quốc, freeship từ 500k" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px"></div>
        <div class="form-row"><label>Quy tắc tư vấn</label><textarea id="spQuyTuVan" rows="2" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px" placeholder="hỏi nhu cầu trước, chỉ tư vấn SP còn hàng">${esc(prof.quyTacTuVan || '')}</textarea></div>
        <div class="form-row"><label>Quy tắc chốt đơn</label><textarea id="spQuyChotDon" rows="2" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px" placeholder="hỏi đủ tên/SĐT/địa chỉ rồi gửi bill xác nhận">${esc(prof.quyTacChotDon || '')}</textarea></div>
        <div class="form-row"><label>FAQ (mỗi dòng: câu hỏi | trả lời)</label><textarea id="spFaq" rows="3" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px" placeholder="ship bao lâu? | 2-4 ngày&#10;đổi trả được không? | 7 ngày">${esc((prof.faq || []).map(f => `${f.q || ''} | ${f.a || ''}`).join('\n'))}</textarea></div>
        <div class="form-row"><label>Thông tin cầm nói (mỗi dòng 1 mục)</label><textarea id="spCamNoi" rows="2" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px" placeholder="nến đốt được 30 tiếng&#10;trà hoa sấy 100% tự nhiên">${esc((prof.thongTinCamNoi || []).join('\n'))}</textarea></div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-primary" id="btnShopProfileSave">${t('set.save_profile')}</button>
          <span id="spOut" style="font-size:12.5px"></span>
        </div>
      </div>
      <div class="card"><h2>${t('set.card_bot')}</h2>
        <div class="set-row">
          <span class="label"><strong>${t('set.auto_reply')}</strong><small>Tắt = mọi auto-send bị gate chặn (bot_off)</small></span>
          <button class="switch ${d.bot.on ? 'on' : ''}" id="setBotSwitch"></button>
        </div>
        <div class="set-row"><span class="label"><strong>Auto reply</strong><small>Chung công tắc bot trong prototype</small></span><span class="pill ${d.bot.autoReply ? 'pill-green' : 'pill-gray'}"><span class="dot"></span>${d.bot.autoReply ? 'Bật' : 'Tắt'}</span></div>
        <div class="set-row"><span class="label"><strong>Auto-order (cần GHN khi go-live)</strong><small>checklist: bước 5 bắt buộc xanh khi bật</small></span>
          <button class="switch ${shopCfg.auto_order ? 'on' : ''}" id="setAutoOrder"></button></div>
        <div class="set-row"><span class="label"><strong>Human takeover</strong><small>Hội thoại đang do nhân viên giữ (INV-5: AI cấm gửi)</small></span><span class="v"><strong>${d.takeoverCount}</strong> hội thoại</span></div>
        <div class="set-row"><span class="label"><strong>${t('set.needs_staff')}</strong><small>flag needs_human hoặc mode HUMAN</small></span><span class="v"><strong>${d.canNhanVien}</strong> hội thoại</span></div>
      </div>
      <div class="card"><h2>${t('set.card_comment')}</h2>
        <small style="display:block;color:var(--text-faint);margin-bottom:8px">3 công tắc lưu trong settings shop (POST /api/settings) — pipeline đọc FRESH mỗi bình luận, đổi là hiệu lực ngay, không cần restart.</small>
        <div class="set-row"><span class="label"><strong>${t('set.cmt_auto')}</strong><small>auto_reply_comment — câu hỏi / ý định mua được bot trả công khai</small></span>
          <button class="switch ${cmt.auto_reply_comment ? 'on' : ''}" id="swAutoReplyComment"></button></div>
        <div class="set-row"><span class="label"><strong>${t('set.cmt_hide')}</strong><small>hide_negative_comment — comment lừa đảo/chê bị ẩn + vào việc cho nhân viên (mock — Phase-2 gọi Graph API)</small></span>
          <button class="switch ${cmt.hide_negative_comment ? 'on' : ''}" id="swHideNegativeComment"></button></div>
        <div class="set-row"><span class="label"><strong>${t('set.cmt_inbox')}</strong><small>auto_inbox_from_comment — khách có ý định mua từ comment được đẩy vào inbox bán</small></span>
          <button class="switch ${cmt.auto_inbox_from_comment ? 'on' : ''}" id="swAutoInboxComment"></button></div>
      </div>
      <div class="card"><h2>${t('set.card_team')}</h2>
        <div id="teamBox"><div style="color:var(--text-faint);font-size:14px;padding:4px 0">${t('set.loading_members')}</div></div>
        <div id="teamFormWrap" style="display:none;margin-top:10px;border-top:1px solid var(--bg-soft);padding-top:10px">
          <div class="form-2col">
            <div class="form-row"><label>Email thành viên mới</label><input id="tmEmail" type="email" placeholder="ban@shop.vn" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px;font-size:14px"></div>
            <div class="form-row"><label>Mật khẩu (≥8 ký tự)</label><input id="tmPass" type="password" placeholder="tối thiểu 8 ký tự" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px;font-size:14px"></div>
          </div>
          <div class="form-row"><label>Vai trò</label>
            <select id="tmRole" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px;font-size:14px">
              <option value="AGENT">AGENT — nhân viên bán (hội thoại + đơn)</option>
              <option value="ADMIN">ADMIN — quản trị shop</option>
              <option value="OWNER">OWNER — chủ shop (toàn quyền)</option>
            </select></div>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn btn-primary" id="btnTeamAdd">${t('set.add_member')}</button>
            <span id="teamOut" style="font-size:14px"></span>
          </div>
        </div>
      </div>
      <div class="card"><h2>${t('set.card_auto')}</h2>
        <div class="set-row"><span class="label"><strong>Follow-up (care / marketing)</strong><small>${fuStatus}</small></span><span class="v"><strong>${fu.follow_ups_total}</strong> lịch</span></div>
        <div class="set-row"><span class="label"><strong>Khách đã opt-out quảng cáo</strong><small>Automation marketing dừng theo chính sách</small></span><span class="v"><strong>${fu.opt_out_customers}</strong> khách</span></div>
        <div class="set-row"><span class="label"><strong>Loại follow-up</strong><small>${Object.entries(fu.follow_ups_by_kind || {}).map(([k, v]) => `${esc(k)}: ${v}`).join(' · ') || '—'}</small></span><span></span></div>
        <div class="auto-form" style="margin-top:10px;border-top:1px solid var(--bg-soft);padding-top:10px">
          <div class="form-2col">
            <div class="form-row"><label>${t('set.auto_hours')}</label>
              <input id="autoHours" type="number" min="1" max="720" value="${esc(fu.config.followup_delivery_hours)}" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px"></div>
            <div class="form-row"><label>${t('set.auto_days')}</label>
              <input id="autoReminderDays" type="number" min="1" max="365" value="${esc(fu.config.purchase_reminder_days)}" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px"></div>
          </div>
          <div class="set-row"><span class="label"><strong>${t('set.auto_care')}</strong><small>tin hỏi thăm sau khi đơn DELIVERED (core tạo — cấu hình giờ + bật/tắt)</small></span>
            <button class="switch ${fu.config.care_enabled ? 'on' : ''}" id="autoCare"></button></div>
          <div class="set-row"><span class="label"><strong>Review request</strong><small>xin đánh giá sau giao (vẫn đi qua Window/Quota/Opt-out của core)</small></span>
            <button class="switch ${fu.config.review_enabled ? 'on' : ''}" id="autoReview"></button></div>
          <div class="set-row"><span class="label"><strong>Purchase reminder</strong><small>nhắc mua lại — tin MARKETING, chịu opt-out + cửa sổ 24h</small></span>
            <button class="switch ${fu.config.purchase_reminder_enabled ? 'on' : ''}" id="autoReminder"></button></div>
          <button class="btn btn-primary" id="btnAutoSave" style="margin-top:8px">${t('set.save_auto')}</button>
          <small style="display:block;color:var(--text-faint);margin-top:6px">Gate Window/Quota/Opt-out/Receipt luôn là quyết định của core — cấu hình này chỉ đặt LỊCH.</small>
        </div>
      </div>
      <div class="card"><h2>${t('set.card_account')}</h2>
        <div class="form-2col">
          <div class="form-row"><label>${t('set.old_pass')}</label><input id="accOld" type="password" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px"></div>
          <div class="form-row"><label>${t('set.new_pass')}</label><input id="accNew" type="password" style="width:100%;padding:8px;border:1.5px solid var(--border-gray);border-radius:8px"></div>
        </div>
        <button class="btn" id="btnChangePass">${t('set.change_pass')}</button>
        <div class="kv-grid" style="grid-template-columns:160px 1fr;margin-top:12px">
          <span class="k">Phiên bản</span><span class="v">${esc(h.version)} · Node ${esc(h.node)} · APP_DATA=${esc(h.modes.data)}</span>
          <span class="k">Uptime</span><span class="v">${Math.floor(h.uptime_s / 60)} phút ${h.uptime_s % 60}s</span>
          <span class="k">Đồng hồ hệ thống</span><span class="v">${fmtTime(h.clock_now)}</span>
          <span class="k">Lỗi gần đây</span><span class="v">send_failed: <strong>${h.errors.send_failed}</strong> · DLQ: <strong>${h.errors.dlq_count}</strong> · event_failed: <strong>${h.errors.event_failed}</strong> · order timeout: <strong>${h.errors.order_create_timeout}</strong> · follow-up fail: <strong>${h.errors.follow_up_failed}</strong></span>
          <span class="k">Jobs DEAD</span><span class="v">${h.jobs_dead}</span>
        </div>
      </div>
    </div>`;
  const gw = $('#goWizard');
  if (gw) gw.addEventListener('click', () => { state.view = 'wizard'; renderCurrent(); });
  $('#btnAiTest').addEventListener('click', async () => {
    toast('Đang test AI provider…');
    try {
      const r = await api('/api/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      toast(`AI test PASS (${r.ai.provider})`);
    } catch (e) { toast('AI test ERROR: ' + e.message, true); }
    renderSettings();
  });
  $('#btnAiConfig').addEventListener('click', () => {
    const box = $('#aiCfgBox');
    box.style.display = box.style.display === 'none' ? 'block' : 'none';
  });
  // SURI P2 (hạng mục 2/5a): công tắc BẬT/TẮT AI cho lời tư vấn (không đụng provider/key —
  // tắt => engine fallback template FAQ stub như cũ).
  $('#setAiUseReplies').addEventListener('click', async () => {
    const next = !(ai.use_for_replies !== false);
    try {
      await api('/api/ai/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ use_for_replies: next }),
      });
      toast(next ? 'AI SẼ VIẾT lời tư vấn (giá/tồn vẫn lấy từ DB, Gate vẫn chặn số sai)' : 'ĐÃ TẮT AI tư vấn — trả lời bằng template FAQ stub');
    } catch (e) { toast('Lỗi: ' + e.message, true); }
    renderSettings();
  });
  $('#btnAiSave').addEventListener('click', async () => {
    try {
      await api('/api/ai/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: $('#aiProvider').value, api_key: $('#aiKey').value, model: $('#aiModel').value }),
      });
      toast('Đã lưu cấu hình AI (key không bao giờ hiển thị lại)');
      renderSettings();
    } catch (e) { toast('Lỗi: ' + e.message, true); }
  });
  $('#btnPromptSave').addEventListener('click', async () => {
    const cfg = {
      giongNoi: $('#pGiongNoi').value, cachXungHo: $('#pXungHo').value,
      uuTienBan: $('#pUuTien').value, ngonNgu: $('#pNgonNgu').value,
      chinhSachDoiTra: $('#pDoiTra').value, gioLamViec: $('#pGioLam').value,
      quyTacChotDon: $('#pChotDon').value,
      khongDuocNoi: $('#pKhongNoi').value.split('\n').map(s => s.trim()).filter(Boolean),
      faq: [],
    };
    try {
      await api('/api/prompt/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
      toast('Đã lưu prompt config');
    } catch (e) {
      toast(e.body && e.body.error === 'SECRET_IN_PROMPT' ? 'CHẶN: prompt chứa pattern secret (sk-/token…)' : 'Lỗi: ' + e.message, true);
    }
  });
  $('#btnPromptView').addEventListener('click', async () => {
    try {
      const r = await api('/api/prompt');
      $('#promptOut').textContent = `${r.prompt.length} ký tự prompt`;
    } catch (e) { $('#promptOut').textContent = 'lỗi'; }
  });
  // SURI P1: lưu hồ sơ shop cho AI (field rỗng = xoá field — form là full-state)
  $('#btnShopProfileSave').addEventListener('click', async () => {
    const faq = $('#spFaq').value.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const i = l.indexOf('|');
      return i < 0 ? { q: l, a: '' } : { q: l.slice(0, i).trim(), a: l.slice(i + 1).trim() };
    });
    try {
      await api('/api/shop-profile', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ten: $('#spTen').value, logo: $('#spLogo').value, linhVuc: $('#spLinhVuc').value,
          diaChi: $('#spDiaChi').value, hotline: $('#spHotline').value,
          chinhSachDoiTra: $('#spChinhSachDoiTra').value, chinhSachGiaoHang: $('#spChinhSachGiaoHang').value,
          gioLamViec: $('#spGioLamViec').value, giongNoi: $('#spGiongNoi').value,
          cachXungHo: $('#spCachXungHo').value, quyTacTuVan: $('#spQuyTuVan').value,
          quyTacChotDon: $('#spQuyChotDon').value, cta: $('#spCta').value,
          faq, thongTinCamNoi: $('#spCamNoi').value.split('\n').map(s => s.trim()).filter(Boolean),
        }),
      });
      $('#spOut').textContent = 'đã lưu';
      toast('Đã lưu hồ sơ shop cho AI (đè config prompt cũ khi build prompt)');
    } catch (e) {
      $('#spOut').textContent = 'lỗi';
      toast(e.body && e.body.error === 'INVALID_PROFILE' ? 'CHẶN: hồ sơ chứa pattern secret/dữ liệu lạ' : 'Lỗi: ' + e.message, true);
    }
  });
  // SURI P1: nối key DeepSeek live từ provider config ngoài (key không bao giờ về browser)
  $('#btnWireDeepseek').addEventListener('click', async () => {
    $('#wireOut').textContent = 'đang đọc provider config + gọi thử DeepSeek…';
    try {
      const r = await api('/api/ai/wire-deepseek', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      $('#wireOut').textContent = `${r.status} · ${r.model} · key ${r.maskedKey}`;
      toast(`DeepSeek wire: ${r.status}`);
    } catch (e) {
      const b = (e && e.body) || {};
      $('#wireOut').textContent = `ERROR · ${b.error || e.message}`;
      toast('Wire DeepSeek ERROR: ' + (b.error || e.message), true);
    }
  });
  $('#setAutoOrder').addEventListener('click', async () => {
    try {
      await api('/api/onboarding/complete-step', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepId: 'settings', data: { auto_order: !shopCfg.auto_order } }),
      });
      toast(`Auto-order ${!shopCfg.auto_order ? 'BẬT' : 'TẮT'}`);
    } catch (e) { toast('Lỗi: ' + e.message, true); }
  });
  $('#btnAutoSave').addEventListener('click', async () => {
    try {
      await api('/api/automation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          followup_delivery_hours: Number($('#autoHours').value),
          purchase_reminder_days: Number($('#autoReminderDays').value),
          care_enabled: $('#autoCare').classList.contains('on'),
          review_enabled: $('#autoReview').classList.contains('on'),
          purchase_reminder_enabled: $('#autoReminder').classList.contains('on'),
        }),
      });
      toast('Đã lưu cấu hình Automation (áp cho các follow-up đến hạn sau)');
      renderSettings();
    } catch (e) { toast('Lỗi: ' + e.message, true); }
  });
  $('#btnChangePass').addEventListener('click', async () => {
    try {
      await api('/api/auth/change-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ old_password: $('#accOld').value, new_password: $('#accNew').value }),
      });
      toast('Đã đổi mật khẩu');
    } catch (e) { toast(e.message === 'WEAK_PASSWORD' ? 'Mật khẩu tối thiểu 8 ký tự' : 'Lỗi: ' + e.message, true); }
  });
  const sw = $('#setBotSwitch');
  sw.addEventListener('click', async () => {
    try {
      const r = await api('/api/settings/bot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: !d.bot.on }),
      });
      toast(r.on ? 'Bot ĐÃ BẬT — tiếp tục tự trả lời' : 'Bot ĐÃ TẮT — gate chặn mọi auto-send (bot_off)');
      renderSettings();
    } catch (e) { toast('Lỗi: ' + e.message, true); }
  });
  // ---- AICAKE (G5): 3 công tắc comment — bật/tắt rồi lưu CẢ OBJECT settings 1 lần ----
  for (const id of ['swAutoReplyComment', 'swHideNegativeComment', 'swAutoInboxComment']) {
    $(`#${id}`).addEventListener('click', function () {
      this.classList.toggle('on');
      saveCmt();
    });
  }
  // ---- AICAKE (G5): Thành viên team — nạp danh sách + tạo user qua /api/auth/users ----
  loadTeamBox();
  $('#btnTeamAdd').addEventListener('click', async () => {
    const errMap = {
      BAD_EMAIL: 'Email không hợp lệ',
      WEAK_PASSWORD: 'Mật khẩu tối thiểu 8 ký tự',
      EMAIL_EXISTS: 'Email đã tồn tại trong hệ thống',
      BAD_ROLE: 'Vai trò không hợp lệ',
      ONLY_OWNER_CREATES_OWNER: 'Chỉ OWNER mới được tạo tài khoản OWNER',
      FORBIDDEN: 'Bạn không đủ quyền tạo thành viên (cần OWNER/ADMIN)',
      SHOP_NOT_FOUND: 'Shop không tồn tại',
    };
    $('#teamOut').textContent = 'đang lưu…';
    try {
      await api('/api/auth/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: $('#tmEmail').value.trim(),
          password: $('#tmPass').value,
          role: $('#tmRole').value,
        }),
      });
      $('#teamOut').textContent = '';
      $('#tmEmail').value = '';
      $('#tmPass').value = '';
      toast(`Đã thêm thành viên (${($('#tmRole') || {}).value || ''}) — gửi mật khẩu qua kênh riêng`);
      loadTeamBox();
    } catch (e) {
      const msg = errMap[e.message] || e.message;
      $('#teamOut').textContent = '';
      toast(msg, true);
    }
  });
}

// ============================================================ VIEW: ONBOARDING WIZARD (7 BƯỚC)
async function renderWizard() {
  if (state.user && state.user.role === 'AGENT') { return renderOverview(); }
  const ob = await api('/api/onboarding');
  state.onboarding = ob;
  const stIcon = s => s === 'CONNECTED'
    ? '<span class="pill pill-green"><span class="dot"></span>XONG</span>'
    : s === 'ERROR' ? '<span class="pill pill-red"><span class="dot"></span>LỖI</span>'
      : '<span class="pill pill-gray"><span class="dot"></span>CHƯA XONG</span>';
  const done = ob.steps.filter(s => s.status === 'CONNECTED').length;

  const stepCard = (n, step, bodyHtml) => `
    <div class="card" style="margin-bottom:14px">
      <h2 style="display:flex;align-items:center;gap:10px">
        <span style="display:inline-flex;width:26px;height:26px;border-radius:50%;background:${step.status === 'CONNECTED' ? 'var(--green-soft)' : 'var(--primary-soft)'};color:${step.status === 'CONNECTED' ? 'var(--green)' : 'var(--primary-dark)'};align-items:center;justify-content:center;font-size:13px;font-weight:700">${n}</span>
        ${esc(step.ten)} <span style="margin-left:auto">${stIcon(step.status)}</span>
      </h2>
      <div style="font-size:12.5px;color:var(--text-light);margin-bottom:10px">${esc(step.id)}</div>
      ${bodyHtml}
    </div>`;

  const inp = (id, label, val, ph, type) =>
    `<div class="form-row"><label>${esc(label)}</label><input id="${id}" type="${type || 'text'}" value="${esc(val || '')}" placeholder="${esc(ph || '')}"></div>`;

  const s1 = ob.steps.find(s => s.id === 'shop-info');
  const s2 = ob.steps.find(s => s.id === 'facebook');
  const s3 = ob.steps.find(s => s.id === 'zalo');
  const s4 = ob.steps.find(s => s.id === 'products');
  const s5 = ob.steps.find(s => s.id === 'shipping');
  const s6 = ob.steps.find(s => s.id === 'ai');
  const s7 = ob.steps.find(s => s.id === 'test');

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Thiết lập shop — wizard ${esc(ob.progress)}</h1>
        <div class="sub">Hoàn thiện 7 bước để BẬT bot tự động (go-live checklist)</div>
      </div>
      <button class="btn" id="wizSkip">Xem dashboard trước</button>
    </div>

    ${stepCard(1, s1, `
      <div class="form-2col">
        ${inp('wShopName', 'Tên shop', (s1.chiTiet || {}).shop_name, 'Shop Nến Scent')}
        ${inp('wHotline', 'Hotline', (s1.chiTiet || {}).hotline, '090xxxxxxx')}
      </div>
      ${inp('wAddress', 'Địa chỉ', (s1.chiTiet || {}).address, '123 ABC, Q1, TP.HCM')}
      <button class="btn btn-primary" data-step="shop-info">Lưu bước 1</button>`)}

    ${stepCard(2, s2, `
      <div class="form-2col">
        ${inp('wFbPage', 'Page ID', (s2.chiTiet || {}).page_id, '1234567890')}
        ${inp('wFbToken', 'Page Access Token', '', 'EAA… (chỉ ghi, không hiển thị lại)', 'password')}
      </div>
      <button class="btn btn-primary" data-step="facebook">Lưu bước 2</button>`)}

    ${stepCard(3, s3, `
      <div class="form-2col">
        ${inp('wZaloOa', 'OA ID', (s3.chiTiet || {}).oa_id, '123456789')}
        ${inp('wZaloToken', 'Access Token', '', 'token OA (chỉ ghi, không hiển thị lại)', 'password')}
      </div>
      <button class="btn btn-primary" data-step="zalo">Lưu bước 3</button>`)}

    ${stepCard(4, s4, `
      <div class="kv"><span class="k">Sản phẩm đang bật bán</span>
        <span class="v"><strong>${(s4.chiTiet || {}).enabled_count || 0}</strong> sản phẩm
        <button class="btn" style="margin-left:10px" onclick="switchView('products')">Quản lý sản phẩm →</button></span></div>`)}

    ${stepCard(5, s5, `
      <div class="form-2col">
        ${inp('wGhnShop', 'GHN Shop ID', (s5.chiTiet || {}).shop_id, '1234567')}
        ${inp('wGhnToken', 'GHN Token', '', 'token GHN (chỉ ghi, không hiển thị lại)', 'password')}
      </div>
      <button class="btn btn-primary" data-step="shipping">Lưu bước 5</button>`)}

    ${stepCard(6, s6, `
      <div class="form-2col">
        <div class="form-row"><label>Provider</label>
          <select id="wAiProvider">
            <option value="deepseek"${s6.chiTiet && s6.chiTiet.provider === 'deepseek' ? ' selected' : ''}>DeepSeek</option>
            <option value="openai"${s6.chiTiet && s6.chiTiet.provider === 'openai' ? ' selected' : ''}>OpenAI</option>
            <option value="local"${s6.chiTiet && s6.chiTiet.provider === 'local' ? ' selected' : ''}>Local (stub — không gọi mạng)</option>
          </select></div>
        ${inp('wAiKey', 'API Key', '', 'sk-… (chỉ ghi, không hiển thị lại)', 'password')}
        ${inp('wAiModel', 'Model (bỏ trống = mặc định)', (s6.chiTiet || {}).model, 'deepseek-chat')}
      </div>
      <div style="display:flex;gap:10px">
        <button class="btn btn-primary" data-step="ai">Lưu cấu hình AI</button>
        <button class="btn" id="wAiTest">Test gọi AI</button>
        <span id="wAiTestOut" style="align-self:center;font-size:13px">${s6.chiTiet && s6.chiTiet.last_error ? `<span style="color:var(--red)">lỗi: ${esc(s6.chiTiet.last_error)}</span>` : ''}</span>
      </div>`)}

    ${stepCard(7, s7, `
      <div class="kv"><span class="k">Test hội thoại (bot trả lời được)</span>
        <span class="v">${(s7.chiTiet || {}).test_conversation ? '<span class="pill pill-green"><span class="dot"></span>PASS</span>' : '<span class="pill pill-gray"><span class="dot"></span>Chưa test</span>'}
        <button class="btn" style="margin-left:10px" id="wTestConv">Chạy test hội thoại</button></span></div>
      <div class="kv"><span class="k">Test đơn hàng (chốt được đơn CONFIRMED)</span>
        <span class="v">${(s7.chiTiet || {}).test_order ? '<span class="pill pill-green"><span class="dot"></span>PASS</span>' : '<span class="pill pill-gray"><span class="dot"></span>Chưa test</span>'}
        <button class="btn" style="margin-left:10px" id="wTestOrder">Chạy test đơn</button></span></div>`)}

    <div class="card" style="border:1.5px solid ${ob.canGoLive ? 'var(--green)' : '#fecaca'}">
      <h2>Go-live</h2>
      ${ob.canGoLive
        ? '<p style="color:var(--green);font-weight:600;margin-bottom:10px">Checklist ĐỦ — có thể bật bot tự động.</p>'
        : `<p style="color:var(--red);font-weight:600;margin-bottom:8px">Chưa đủ điều kiện bật bot. Lý do:</p>
           <ul style="color:var(--red);margin:0 0 10px 18px;line-height:1.7">${ob.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>`}
      <button class="btn btn-primary btn-big" id="wBotOn" ${(!ob.canGoLive || state.dashboard && state.dashboard.bot.on) ? 'disabled' : ''}>BẬT BOT TỰ ĐỘNG</button>
    </div>`;

  const saveStep = async (stepId, data) => {
    try {
      const r = await api('/api/onboarding/complete-step', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepId, data }),
      });
      toast('Đã lưu');
      state.onboarding = r;
      renderWizard();
    } catch (e) { toast('Lỗi: ' + e.message, true); }
  };
  document.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => {
    const step = b.dataset.step;
    if (step === 'shop-info') saveStep(step, { name: $('#wShopName').value, hotline: $('#wHotline').value, address: $('#wAddress').value });
    else if (step === 'facebook') saveStep(step, { page_id: $('#wFbPage').value, page_access_token: $('#wFbToken').value });
    else if (step === 'zalo') saveStep(step, { oa_id: $('#wZaloOa').value, access_token: $('#wZaloToken').value });
    else if (step === 'shipping') saveStep(step, { ghn_shop_id: $('#wGhnShop').value, ghn_token: $('#wGhnToken').value });
    else if (step === 'ai') saveStep(step, { provider: $('#wAiProvider').value, api_key: $('#wAiKey').value, model: $('#wAiModel').value });
  }));
  const aiTest = $('#wAiTest');
  if (aiTest) aiTest.addEventListener('click', async () => {
    $('#wAiTestOut').textContent = 'đang test…';
    try {
      const r = await api('/api/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      $('#wAiTestOut').innerHTML = `<span style="color:var(--green)">PASS (${esc(r.ai.provider)})</span>`;
      renderWizard();
    } catch (e) {
      $('#wAiTestOut').innerHTML = `<span style="color:var(--red)">ERROR: ${esc(e.message)}</span>`;
    }
  });
  const tc = $('#wTestConv');
  if (tc) tc.addEventListener('click', async () => {
    tc.disabled = true;
    try {
      const r = await api('/api/onboarding/test-conversation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      toast(r.ok ? 'Test hội thoại PASS — bot trả lời được' : 'Test hội thoại chưa pass', !r.ok);
    } catch (e) { toast('Lỗi: ' + e.message, true); }
    renderWizard();
  });
  const to = $('#wTestOrder');
  if (to) to.addEventListener('click', async () => {
    to.disabled = true;
    try {
      const r = await api('/api/onboarding/test-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      toast(r.ok ? 'Test đơn PASS — tạo được đơn CONFIRMED' : 'Test đơn chưa pass', !r.ok);
    } catch (e) { toast('Lỗi: ' + e.message, true); }
    renderWizard();
  });
  const bon = $('#wBotOn');
  if (bon) bon.addEventListener('click', async () => {
    try {
      await api('/api/settings/bot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }) });
      toast('BOT ĐÃ BẬT — shop đã go-live!');
      state.view = 'overview';
      renderCurrent();
    } catch (e) { toast('Chưa bật được: ' + e.message, true); renderWizard(); }
  });
  $('#wizSkip').addEventListener('click', () => { state.view = 'overview'; renderCurrent(); });
}

// ============================================================ VIEW: BÁO CÁO & THỐNG KÊ (chuẩn aicake)
// Số liệu từ /api/analytics (store thật) — doanh thu/đơn theo ngày, hiệu suất AI, top khách/top sản phẩm.
// Chart bar thuần CSS (flex, chiều cao % theo max) — KHÔNG thư viện ngoài.
async function renderReports() {
  let a;
  try {
    a = await api('/api/analytics?days=14');
  } catch (e) {
    main.innerHTML = `
      <div class="page-head"><div><h1>${t('rep.title')}</h1><div class="sub">${t('rep.sub', { n: 14 })}</div></div></div>
      <div class="card"><h2>${t('rep.load_fail')}</h2>
        <p style="color:var(--red);font-size:14px">Lỗi: ${esc(e.message)}</p>
        <button class="btn btn-primary" onclick="renderReports()">${t('rep.retry')}</button></div>`;
    return;
  }
  const s = a.summary || {};
  const ai = a.ai_performance || {};

  // ---- 4 thẻ summary ----
  const stat = (num, label, icon) => `
    <div class="card stat-card">
      <span class="stat-icon">${icon}</span>
      <div><div class="stat-num">${num}</div><div class="stat-label">${label}</div></div>
    </div>`;
  const stats = `
    <div class="stat-grid">
      ${stat(fmtVND(s.revenue_total || 0), t('rep.revenue_n', { n: a.range_days || 14 }),
        '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>')}
      ${stat(String(s.orders_total || 0), t('rep.orders_n', { n: a.range_days || 14 }),
        '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>')}
      ${stat(String(s.customers_total || 0), t('rep.customers_bought'),
        '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>')}
      ${stat(fmtVND(s.avg_order_value || 0), t('rep.aov'),
        '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>')}
    </div>`;

  // ---- bar chart CSS thuần: chiều cao % theo max, hover hiện title ----
  const days = a.revenue_by_day || [];
  const maxRev = Math.max(1, ...days.map(d => Number(d.revenue) || 0));
  const bars = days.map(d => {
    const rev = Number(d.revenue) || 0;
    const h = Math.round((rev / maxRev) * 100);
    return `
      <div title="${esc(d.date)}: ${fmtVND(rev)} · ${d.orders} đơn" style="flex:1;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:4px;min-width:0">
        <div style="width:70%;max-width:34px;height:${rev > 0 ? Math.max(h, 2) : 0}%;background:${rev > 0 ? 'var(--primary)' : 'transparent'};border-radius:4px 4px 0 0"></div>
        <span style="font-size:14px;color:var(--text-faint);white-space:nowrap">${esc(String(d.date).slice(5))}</span>
      </div>`;
  }).join('');
  const chart = `
    <div class="card">
      <h2>${t('rep.chart', { today: esc(a.today || ''), n: a.range_days || 14 })}</h2>
      <div style="display:flex;align-items:flex-end;gap:6px;height:220px;padding:0 4px 0 4px">${bars}</div>
    </div>`;

  // ---- bảng đơn theo trạng thái ----
  const statusRows = Object.entries(a.orders_by_status || {})
    .sort((x, y) => y[1] - x[1])
    .map(([st, c]) => `<tr><td>${orderStatusPill(st)}</td><td style="text-align:right;font-weight:600">${c}</td></tr>`)
    .join('');
  const statusTable = `
    <div class="card">
      <h2>${t('rep.by_status')}</h2>
      <div class="table-wrap">
        <table class="tbl">
          <thead><tr><th>${t('rep.th_status')}</th><th style="text-align:right">${t('rep.th_count')}</th></tr></thead>
          <tbody>${statusRows || '<tr><td colspan="2" class="tbl-empty">Chưa có đơn nào trong khoảng</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;

  // ---- hiệu suất AI ----
  const aiCard = `
    <div class="card">
      <h2>${t('rep.ai_perf')}</h2>
      <div class="kv-list">
        <div class="kv"><span class="k">${t('rep.total_convs')}</span><span class="v">${ai.total_conversations || 0}</span></div>
        <div class="kv"><span class="k">${t('rep.ai_handled')}</span><span class="v">${ai.ai_handled || 0}</span></div>
        <div class="kv"><span class="k">${t('rep.takeovers')}</span><span class="v">${ai.human_takeover || 0}</span></div>
        <div class="kv"><span class="k">${t('rep.autonomy')}</span><span class="v"><strong style="color:var(--primary);font-size:16px">${ai.autonomy_pct != null ? ai.autonomy_pct : 0}%</strong></span></div>
      </div>
    </div>`;

  // ---- top khách hàng / top sản phẩm ----
  const custRows = (a.top_customers || []).map((c, i) => `
    <tr>
      <td style="color:var(--text-faint);width:36px">${i + 1}</td>
      <td>${esc(c.name)}</td>
      <td style="text-align:right">${c.orders}</td>
      <td style="text-align:right;font-weight:600">${fmtVND(c.total_spent)}</td>
    </tr>`).join('');
  const prodRows = (a.top_products || []).map((p, i) => `
    <tr>
      <td style="color:var(--text-faint);width:36px">${i + 1}</td>
      <td>${esc(p.name)}</td>
      <td style="color:var(--text-light)">${esc(p.sku)}</td>
      <td style="text-align:right;font-weight:600">${p.qty}</td>
      <td style="text-align:right">${p.orders}</td>
    </tr>`).join('');
  const tops = `
    <div class="ov-grid">
      <div class="card">
        <h2>${t('rep.top_customers')}</h2>
        <div class="table-wrap">
          <table class="tbl">
            <thead><tr><th>#</th><th>${t('rep.th_customer')}</th><th style="text-align:right">${t('rep.th_orders')}</th><th style="text-align:right">${t('rep.th_spent')}</th></tr></thead>
            <tbody>${custRows || '<tr><td colspan="4" class="tbl-empty">Chưa có đơn đã chốt trong khoảng</td></tr>'}</tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <h2>${t('rep.top_products')}</h2>
        <div class="table-wrap">
          <table class="tbl">
            <thead><tr><th>#</th><th>${t('rep.th_product')}</th><th>SKU</th><th style="text-align:right">${t('rep.th_qty')}</th><th style="text-align:right">${t('rep.th_orders')}</th></tr></thead>
            <tbody>${prodRows || '<tr><td colspan="5" class="tbl-empty">Chưa có đơn đã chốt trong khoảng</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    </div>`;

  main.innerHTML = `
    <div class="page-head">
      <div><h1>${t('rep.title')}</h1><div class="sub">${t('rep.sub', { n: a.range_days || 14 })}</div></div>
    </div>
    ${stats}
    ${chart}
    <div class="ov-grid">${statusTable}${aiCard}</div>
    ${tops}`;
}

// ============================================================ HƯỚNG DẪN (guide)
// Layout copy aicake.vn/UserGuide: cột trái (header + ô tìm kiếm + danh mục/bài),
// nội dung phải (hero + CTA hỏi AI + thống kê / trang bài viết theo bước).
// Chỉ copy BỐ CỤC — màu giữ theme hồng của app. Toàn bộ class tiền tố gd-.
const GD_ICO_BOOK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';
const GD_ICO_FOLDER = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
const GD_ICO_DOC = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
const GD_ICO_SEARCH = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';

function gdFindArticle(id) {
  const d = state.guide.data;
  if (!d || !Array.isArray(d.categories)) return null;
  for (const cat of d.categories) {
    for (const art of (cat.articles || [])) {
      if (String(art.id) === String(id)) return { cat, art };
    }
  }
  return null;
}

function gdCountArticles(d) {
  return (d.categories || []).reduce((n, c) => n + (c.articles || []).length, 0);
}

// tìm kiếm local: khớp title / summary / từng bước (title, body, tip)
function gdMatches(art, qLower) {
  const parts = [art.title, art.summary];
  for (const s of (art.steps || [])) parts.push(s.title, s.body, s.tip || '');
  return parts.join(' ').toLowerCase().includes(qLower);
}

// ---- hash routing nhẹ: #guide/<articleId> ----
function gdParseHash() {
  const m = (location.hash || '').match(/^#guide\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}
function gdSetHash(id) {
  const h = '#guide/' + encodeURIComponent(id);
  if (location.hash !== h) location.hash = h;
}
function gdClearHash() {
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

async function renderGuide() {
  // đã có layout + dữ liệu -> không vẽ lại (tránh mất focus ô tìm kiếm khi SSE tick refetch)
  if ($('#gdLayout') && state.guide.data && state.guide.i18nV === (window.__i18nV || 0)) return;
  if (!state.guide.data) {
    try {
      const body = await api('/api/guide');
      // nhận cả 2 shape: contract gọn {version, product, categories} hoặc bọc {ok, guide:{…}}
      state.guide.data = (body && body.guide && Array.isArray(body.guide.categories)) ? body.guide : body;
    } catch (e) {
      main.innerHTML = `
        <div class="card" style="margin-top:20px;max-width:520px">
          <h2>${t('gd.load_fail')}</h2>
          <p style="color:var(--text-light);margin:8px 0 14px">Lỗi: ${esc(e.message)}. Có thể máy chủ chưa sẵn sàng — hãy thử lại.</p>
          <button class="btn btn-primary" onclick="renderGuide()">${t('gd.retry')}</button>
        </div>`;
      return;
    }
  }
  // vào thẳng bài nếu URL có #guide/<id>
  const hid = gdParseHash();
  if (hid && gdFindArticle(hid)) state.guide.article = String(hid);
  else if (hid) { state.guide.article = null; gdClearHash(); }

  const d = state.guide.data;
  main.innerHTML = `
    <div class="gd-layout" id="gdLayout">
      <aside class="gd-side" id="gdSide">
        <div class="gd-side-head">${GD_ICO_BOOK}<span>${t('gd.title')}</span></div>
        <div class="gd-side-search">
          <span class="gd-side-search-ico">${GD_ICO_SEARCH}</span>
          <input id="gdSearch" type="text" placeholder="${t('gd.search_ph')}" value="${esc(state.guide.q)}" autocomplete="off">
        </div>
        <button class="gd-side-toggle" id="gdSideToggle">${t('gd.toggle')}</button>
        <div class="gd-side-body" id="gdSideBody"></div>
      </aside>
      <section class="gd-content" id="gdContent"></section>
    </div>`;

  state.guide.i18nV = window.__i18nV || 0; // i18n: đánh dấu shell guide đã vẽ theo ngôn ngữ hiện tại
  $('#gdSearch').addEventListener('input', e => {
    state.guide.q = e.target.value.trim();
    renderGuideContent();
  });
  $('#gdSideToggle').addEventListener('click', () => $('#gdSide').classList.toggle('open'));
  // 1 listener ủy quyền cho mọi nút trong layout (breadcrumb / danh mục / bài / CTA / xóa lọc)
  $('#gdLayout').addEventListener('click', e => {
    const t = e.target.closest('[data-gd-act]');
    if (!t) return;
    e.preventDefault();
    const act = t.dataset.gdAct;
    if (act === 'home') {
      state.guide.article = null; state.guide.filter = null;
      gdClearHash(); renderGuideContent();
    } else if (act === 'cat') {
      const cid = t.dataset.gdCat;
      state.guide.filter = (state.guide.filter === cid && !state.guide.article) ? null : cid;
      state.guide.article = null;
      gdClearHash(); renderGuideContent();
    } else if (act === 'art') {
      openGuideArticle(t.dataset.gdArt, true);
    } else if (act === 'clear') {
      state.guide.q = ''; state.guide.filter = null;
      const s = $('#gdSearch'); if (s) s.value = '';
      renderGuideContent();
    } else if (act === 'chat') {
      gdChatOpen();
    }
  });
  renderGuideContent();
}

function gdCatsHtml() {
  const cats = (state.guide.data && state.guide.data.categories) || [];
  return cats.map(cat => {
    const arts = cat.articles || [];
    const catActive = state.guide.filter === cat.id && !state.guide.article;
    const rows = arts.length ? arts.map(a => `
      <button class="gd-art-item${state.guide.article === String(a.id) ? ' active' : ''}" data-gd-act="art" data-gd-art="${esc(a.id)}" title="${esc(a.title)}">
        <span class="gd-art-ico">${GD_ICO_DOC}</span><span class="gd-art-t">${esc(a.title)}</span>
      </button>`).join('')
      : `<div class="gd-none">${t('gd.no_articles')}</div>`;
    return `
      <div class="gd-cat${catActive ? ' active' : ''}">
        <button class="gd-cat-row" data-gd-act="cat" data-gd-cat="${esc(cat.id)}" title="${esc(cat.title)}">
          <span class="gd-cat-ico">${GD_ICO_FOLDER}</span>
          <span class="gd-cat-t">${esc(cat.title)}</span>
          <span class="gd-cat-badge">${arts.length}</span>
        </button>
        <div class="gd-cat-arts">${rows}</div>
      </div>`;
  }).join('');
}

function openGuideArticle(id, push) {
  if (!gdFindArticle(id)) return;
  state.guide.article = String(id);
  if (push !== false) gdSetHash(String(id));
  renderGuideContent();
}

// vẽ lại cột phải (home hoặc bài viết) + đồng bộ highlight sidebar
function renderGuideContent() {
  const box = $('#gdContent');
  if (!box || !state.guide.data) return;
  const sideBody = $('#gdSideBody');
  if (sideBody) sideBody.innerHTML = gdCatsHtml();
  const found = state.guide.article ? gdFindArticle(state.guide.article) : null;
  box.innerHTML = found ? gdArticleHtml(found.cat, found.art) : gdHomeHtml();
  if (main) main.scrollTop = 0;
}

// ---- trang chủ hướng dẫn (mô phỏng aicake) ----
function gdHomeHtml() {
  const d = state.guide.data;
  const cats = d.categories || [];
  const product = d.product || 'Sales AI Console';
  const total = gdCountArticles(d);
  const qLower = state.guide.q.toLowerCase();
  const filterCat = state.guide.filter ? cats.find(c => c.id === state.guide.filter) : null;

  const crumb = `
    <div class="gd-crumb">
      <a href="#" data-gd-act="home">${t('gd.crumb')}</a>
      ${filterCat ? `<span class="gd-crumb-sep">/</span><a href="#" data-gd-act="cat" data-gd-cat="${esc(filterCat.id)}">${esc(filterCat.title)}</a>` : ''}
    </div>`;

  // danh sách bài khi đang tìm kiếm hoặc lọc theo danh mục
  let listHtml = '';
  if (qLower || filterCat) {
    const items = [];
    for (const c of cats) {
      for (const a of (c.articles || [])) {
        if (filterCat && c.id !== filterCat.id) continue;
        if (qLower && !gdMatches(a, qLower)) continue;
        items.push({ c, a });
      }
    }
    listHtml = `
      <div class="gd-results">
        <div class="gd-results-head">
          <span>${t('gd.results', { n: items.length })}${state.guide.q ? t('gd.results_for', { q: esc(state.guide.q) }) : ''}${filterCat ? t('gd.results_in', { c: esc(filterCat.title) }) : ''}</span>
          <button class="gd-clear" data-gd-act="clear">${t('gd.clear')}</button>
        </div>
        ${items.length
          ? items.map(x => `
            <button class="gd-hit" data-gd-act="art" data-gd-art="${esc(x.a.id)}">
              <span class="gd-hit-ico">${GD_ICO_DOC}</span>
              <span class="gd-hit-mid">
                <span class="gd-hit-title">${esc(x.a.title)}</span>
                ${x.a.summary ? `<span class="gd-hit-sum">${esc(x.a.summary)}</span>` : ''}
              </span>
              <span class="gd-hit-meta">${esc(x.c.title)} · ~${Number(x.a.minutes) || 1} phút</span>
            </button>`).join('')
          : `<div class="gd-empty">${t('gd.no_match')}</div>`}
      </div>`;
  }

  return `
    ${crumb}
    <div class="gd-hero">
      <h1 class="gd-hero-title">${t('gd.hero_title', { product: esc(product) })}</h1>
      <p class="gd-hero-sub">${t('gd.hero_sub')}</p>
      <div class="gd-cta">
        <button class="gd-cta-btn" data-gd-act="chat">${t('gd.cta')}</button>
        <div class="gd-cta-note">${t('gd.cta_note')}</div>
      </div>
      <div class="gd-stats">
        <div class="gd-stat"><span class="gd-stat-ico">${GD_ICO_FOLDER}</span><div><b>${cats.length}</b> ${t('gd.categories')}</div></div>
        <div class="gd-stat"><span class="gd-stat-ico">${GD_ICO_DOC}</span><div><b>${total}</b> ${t('gd.articles')}</div></div>
      </div>
    </div>
    ${listHtml}`;
}

// ---- trang bài viết: breadcrumb + các bước đánh số + Xem tiếp ----
function gdArticleHtml(cat, art) {
  const steps = Array.isArray(art.steps) ? art.steps : [];
  const stepHtml = steps.map((s, i) => `
    <div class="gd-step">
      <span class="gd-step-num">${i + 1}</span>
      <div class="gd-step-mid">
        <div class="gd-step-title">${esc(s.title || t('gd.step', { n: i + 1 }))}</div>
        <div class="gd-step-body">${esc(s.body || '')}</div>
        ${s.tip ? `<div class="gd-step-tip">💡 ${esc(s.tip)}</div>` : ''}
      </div>
    </div>`).join('');

  // "Xem tiếp": seeAlso (nếu có) + bài còn lại cùng danh mục
  const seeAlso = (Array.isArray(art.seeAlso) ? art.seeAlso : [])
    .map(id => { const f = gdFindArticle(id); return f ? { id: f.art.id, title: f.art.title, catTitle: f.cat.title } : null; })
    .filter(Boolean);
  const related = (cat.articles || [])
    .filter(a => String(a.id) !== String(art.id) && !seeAlso.some(s => String(s.id) === String(a.id)))
    .map(a => ({ id: a.id, title: a.title, catTitle: cat.title }));
  const next = seeAlso.concat(related);
  const nextHtml = next.length ? `
    <div class="gd-next">
      <div class="gd-next-head">${t('gd.next')}</div>
      ${next.map(n => `
        <button class="gd-next-row" data-gd-act="art" data-gd-art="${esc(n.id)}">
          <span class="gd-hit-ico">${GD_ICO_DOC}</span>
          <span class="gd-hit-mid"><span class="gd-hit-title">${esc(n.title)}</span></span>
          <span class="gd-hit-meta">${esc(n.catTitle)}</span>
        </button>`).join('')}
    </div>` : '';

  return `
    <div class="gd-crumb">
      <a href="#" data-gd-act="home">${t('gd.crumb')}</a>
      <span class="gd-crumb-sep">/</span>
      <a href="#" data-gd-act="cat" data-gd-cat="${esc(cat.id)}">${esc(cat.title)}</a>
    </div>
    <article class="gd-article">
      <h1 class="gd-art-h1">${esc(art.title)}</h1>
      <div class="gd-art-meta">
        <span class="gd-mins">⏱ ~${Number(art.minutes) || 1} ${t('gd.min_read')}</span>
        <span class="gd-art-cat">${esc(cat.title)}</span>
      </div>
      ${art.summary ? `<p class="gd-art-sum">${esc(art.summary)}</p>` : ''}
      <div class="gd-steps">${stepHtml || `<div class="gd-none">${t('gd.coming_soon')}</div>`}</div>
      ${nextHtml}
      <div class="gd-back"><a href="#" data-gd-act="home">${t('gd.back')}</a></div>
    </article>`;
}

// ---- panel chat "Hỏi AI" (nút nổi góc dưới phải, hiện ở mọi view) ----
function gdChatOpen() {
  const p = $('#gdChatPanel');
  if (!p) return;
  p.classList.remove('hidden');
  const i = $('#gdChatInput');
  if (i) i.focus();
}

function gdChatScroll() {
  const box = $('#gdChatMsgs');
  if (box) box.scrollTop = box.scrollHeight;
}

async function gdAskSend() {
  const input = $('#gdChatInput');
  const q = (input.value || '').trim();
  if (!q || state.guide.asking) return;
  state.guide.asking = true;
  const btn = $('#gdChatSend');
  if (btn) btn.disabled = true;
  $('#gdChatMsgs').insertAdjacentHTML('beforeend',
    `<div class="gd-msg-row me"><div class="gd-bubble">${esc(q)}</div></div>`);
  input.value = '';
  $('#gdChatMsgs').insertAdjacentHTML('beforeend',
    `<div class="gd-msg-row bot" id="gdTyping"><div class="gd-bubble">${t('gd.thinking')}</div></div>`);
  gdChatScroll();
  const rmTyping = () => { const ty = $('#gdTyping'); if (ty) ty.remove(); };
  try {
    const r = await api('/api/guide/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q }),
    });
    rmTyping();
    const steps = Array.isArray(r && r.steps) ? r.steps : [];
    const arts = Array.isArray(r && r.articles) ? r.articles : [];
    $('#gdChatMsgs').insertAdjacentHTML('beforeend', `
      <div class="gd-msg-row bot"><div class="gd-bubble">
        <div class="gd-ans">${esc((r && r.answer) || 'Mình chưa tìm thấy câu trả lời phù hợp — bạn thử hỏi cụ thể hơn nhé (VD: "Cách tạo đơn hàng cho khách?").')}</div>
        ${steps.length ? `<div class="gd-ans-steps">${steps.map((s, i) => `
          <div class="gd-ans-step"><b>${i + 1}. ${esc(s.title || '')}</b><div>${esc(s.body || '')}</div></div>`).join('')}</div>` : ''}
        ${arts.length ? `<div class="gd-ans-arts">${arts.map(a => `
          <button class="gd-ans-link" data-gd-art="${esc(a.id || '')}">${t('gd.view_article')} ${esc(a.title || a.id || '')}</button>`).join('')}</div>` : ''}
      </div></div>`);
  } catch (e) {
    rmTyping();
    // lỗi mạng/API -> "toast" ngay trong khung chat (không crash, không dùng toast nền toàn màn)
    $('#gdChatMsgs').insertAdjacentHTML('beforeend',
      `<div class="gd-chat-toast">⚠ Không gửi được câu hỏi (${esc(e.message)}). Kiểm tra kết nối rồi thử lại giúp mình nhé.</div>`);
  } finally {
    state.guide.asking = false;
    if (btn) btn.disabled = false;
    gdChatScroll();
  }
}

// ============================================================ router + SSE
const VIEWS = {
  overview: renderOverview,
  reports: renderReports,
  conversations: renderConversations,
  orders: renderOrders,
  products: renderProducts,
  customers: renderCustomers,
  settings: renderSettings,
  wizard: renderWizard,
  guide: renderGuide,
};

async function renderCurrent() {
  const fn = VIEWS[state.view] || renderOverview;
  try { await fn(); }
  catch (e) {
    main.innerHTML = `<div class="card" style="margin-top:20px"><h2>${t('misc.load_fail')}</h2><p style="color:var(--text-light)">${esc(e.message)}</p></div>`;
  }
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  renderCurrent();
}

document.querySelectorAll('.nav-item').forEach(b =>
  b.addEventListener('click', () => switchView(b.dataset.view)));

$('#botToggle').addEventListener('click', async () => {
  const d = state.dashboard;
  if (!d) return;
  try {
    const r = await api('/api/settings/bot', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: !d.bot.on }),
    });
    toast(r.on ? 'Bot ĐÃ BẬT' : 'Bot ĐÃ TẮT — mọi auto-send bị chặn');
    renderCurrent();
  } catch (e) {
    // Go-live checklist chưa đủ -> 403 GO_LIVE_CHECKLIST + reasons (đỏ)
    if (e.body && e.body.error === 'GO_LIVE_CHECKLIST' && Array.isArray(e.body.reasons)) {
      toast('CHƯA ĐỦ GO-LIVE: ' + e.body.reasons.join(' · '), true);
      state.view = 'wizard';
      renderCurrent();
      return;
    }
    toast('Lỗi: ' + e.message, true);
  }
});

$('#btnLogout').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (e) { /* ignore */ }
  location.href = '/login.html';
});

$('#bellBtn').addEventListener('click', () => toggleNotifPanel());
$('#notifReadAll').addEventListener('click', async () => {
  try {
    await api('/api/notifications/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) });
    await loadNotifications();
    toast('Đã đọc tất cả thông báo');
  } catch (e) { toast('Lỗi: ' + e.message, true); }
});
document.addEventListener('click', e => {
  const panel = $('#notifPanel');
  if (!panel.classList.contains('hidden') && !panel.contains(e.target) && e.target.id !== 'bellBtn' && !e.target.closest('#bellBtn')) {
    panel.classList.add('hidden');
  }
});
$('#drawerOverlay').addEventListener('click', closeDrawer);
$('#modalOverlay').addEventListener('click', e => { if (e.target.id === 'modalOverlay') closeModal(); });

// ---- Hướng dẫn: nút nổi "🤖 Hỏi AI" + panel chat (mọi view) ----
(function wireGuideChat() {
  const fab = $('#gdAskFab');
  const panel = $('#gdChatPanel');
  if (!fab || !panel) return;
  fab.addEventListener('click', () => {
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) gdChatOpen();
  });
  $('#gdChatClose').addEventListener('click', () => panel.classList.add('hidden'));
  const send = () => gdAskSend();
  $('#gdChatSend').addEventListener('click', send);
  $('#gdChatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); send(); }
  });
  // nút "Xem bài: <title>" trong câu trả lời của AI -> mở thẳng bài trong view Hướng dẫn
  $('#gdChatMsgs').addEventListener('click', e => {
    const b = e.target.closest('[data-gd-art]');
    if (!b) return;
    const id = b.dataset.gdArt;
    if (!id) return;
    switchView('guide');
    openGuideArticle(id, true);
  });
})();

// hash routing nhẹ: #guide/<articleId> — back/forward hoặc sửa tay URL cũng cập nhật
window.addEventListener('hashchange', () => {
  if (state.view !== 'guide' || !state.guide.data) return;
  const id = gdParseHash();
  if (id && id !== state.guide.article) {
    if (gdFindArticle(id)) openGuideArticle(id, false);
    else { state.guide.article = null; gdClearHash(); renderGuideContent(); }
  } else if (!id && state.guide.article) {
    state.guide.article = null;
    renderGuideContent();
  }
});


// SSE — server tự quét store ~2s và báo update; client refetch view đang mở (KHÔNG polling 1s).
// Đợt 2: payload kèm unread_by_shop — cập nhật CHUÔNG + TITLE ngay, không cần refetch.
let refetchTimer = null;
try {
  const es = new EventSource('/api/events');
  es.onmessage = ev => {
    let msg = {};
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type !== 'update') return;
    if (msg.unread_by_shop && state.user && msg.unread_by_shop[state.user.shop_id] !== undefined) {
      state.notifUnread = msg.unread_by_shop[state.user.shop_id];
      renderBell(state.notifUnread);
    }
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(() => {
      // giữ nội dung đang gõ trong composer trước khi vẽ lại
      const c = $('#composer');
      if (c) state.composerText = c.value;
      renderCurrent();
      loadNotifications();
    }, 300);
  };
} catch (e) { console.warn('SSE không khả dụng:', e); }

// ============================================================ boot (PRODUCT-READY: auth + wizard)
(async function boot() {
  try {
    const me = await api('/api/auth/me');
    state.user = me.user;
  } catch (e) {
    return; // api() đã chuyển hướng về trang login khi 401
  }
  if (state.user.role !== 'AGENT') {
    try {
      const ob = await api('/api/onboarding');
      state.onboarding = ob;
      if (!ob.canGoLive) {
        // lần đầu login / checklist chưa đủ -> mở wizard trước
        state.view = 'wizard';
        document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === 'wizard'));
      }
    } catch (e) { /* chưa load được onboarding — vào dashboard bình thường */ }
  }
  // deep-link #guide/<articleId> -> mở thẳng view Hướng dẫn (trừ khi đang buộc mở wizard onboarding)
  if (state.view !== 'wizard' && gdParseHash()) state.view = 'guide';
  renderCurrent();
  loadNotifications();
})();
