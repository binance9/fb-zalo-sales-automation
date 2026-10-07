'use strict';
// live-http.js — HTTP client cho LIVE adapters (P2) + đường LLM bất đồng bộ (SURI ASYNC, LỖI 2).
//
// HAI HÀM, MỘT HỢP ĐỒNG KẾT QUẢ ({ok:true,status,bodyText} | {ok:false,timeout:true} | {ok:false,error}):
//   * httpOnce      — spawnSync curl.exe, ĐỒNG BỘ (chặn event loop). Dùng cho: GỬI KÊNH trong
//                     ActionGate.executeSend (P3A/P3C — hợp đồng sendMessage SYNC, KHÔNG đụng)
//                     và test ping provider. Lý do thiết kế giữ nguyên ở comment dưới.
//   * httpOnceAsync — spawn curl KHÔNG sync (child_process.spawn + await exit), body qua stdin.
//                     Dùng cho đường propose LLM (SURI ASYNC — LỖI 2): call chỉ cần kết quả
//                     MUỘN, gate re-check takeover/bot_off/stale ĐÚNG LÚC GỬI nên không cần
//                     giữ nguyên luồng trong lúc chờ mạng. KHÔNG worker thread.
//   * Tests KHÔNG BAO GIỜ dùng 2 hàm này: adapter/AI nhận httpFn TIÊM VÀO (dependency injection)
//     — battery test offline dùng mock httpFn, không ra mạng.
//   * TIMEOUT: curl --max-time; exit code 28 => {timeout:true} (INV-2: timeout = kết quả
//     CHƯA BIẾT — đường receipt đối soát, không blind-retry).

const { spawnSync, spawn } = require('child_process');

// httpOnce({url, method, headers, body, timeoutMs}) -> {ok:true,status,bodyText} | {ok:false,timeout:true} | {ok:false,error}
function httpOnce({ url, method = 'POST', headers = {}, body, timeoutMs = 15000 } = {}) {
  if (!url) return { ok: false, error: 'http_missing_url' };
  const t = Math.max(1, Math.ceil((timeoutMs || 15000) / 1000));
  const args = ['-sS', '-i', '--max-time', String(t), '-X', String(method || 'POST').toUpperCase(), url];
  for (const [k, v] of Object.entries(headers || {})) {
    if (v === undefined || v === null) continue;
    args.push('-H', `${k}: ${v}`);
  }
  // SURI P2 FIX (hở thật gặp khi nối DeepSeek vào đường trả lời — tin nhắn tiếng Việt):
  // truyền body qua COMMAND-LINE ARG làm hỏng UTF-8 trên Windows (spawnSync args đi qua
  // ANSI codepage của process curl -> DeepSeek trả 400 "invalid unicode code point", các
  // adapter live GỬI TIẾNG VIỆT cũng dính đúng lỗi này). Giải pháp: đẩy body qua STDIN
  // (`--data-binary @-` + spawnSync input) — Node ghi stdin dạng UTF-8 thô, byte-accurate.
  let stdin;
  if (body !== undefined && body !== null) {
    args.push('--data-binary', '@-');
    stdin = String(body);
  }

  let r;
  try {
    r = spawnSync('curl', args, { encoding: 'utf8', input: stdin, timeout: t * 1000 + 5000, windowsHide: true });
  } catch (e) {
    return { ok: false, error: 'http_spawn:' + String((e && e.message) || e) };
  }
  if (r.error) return { ok: false, error: 'http_spawn:' + String((r.error && r.error.message) || r.error) };
  if (r.status === 28) return { ok: false, timeout: true }; // curl exit 28 = operation timed out
  if (r.status !== 0 && !r.stdout) return { ok: false, error: 'http_exit_' + r.status };

  // tách header/body từ stdout của `-i` (chấp nhận CRLF hoặc LF)
  const out = String(r.stdout || '');
  const iCrlf = out.indexOf('\r\n\r\n');
  const iLf = out.indexOf('\n\n');
  let head = '';
  let bodyText = out;
  if (iCrlf >= 0 && (iLf < 0 || iCrlf <= iLf)) { head = out.slice(0, iCrlf); bodyText = out.slice(iCrlf + 4); }
  else if (iLf >= 0) { head = out.slice(0, iLf); bodyText = out.slice(iLf + 2); }
  const m = head.match(/HTTP\/[\d.]+\s+(\d{3})/i);
  return { ok: true, status: m ? parseInt(m[1], 10) : 0, headers: {}, bodyText };
}

// SURI ASYNC (LỖI 2): httpOnceAsync — cùng hợp đồng kết quả với httpOnce nhưng KHÔNG chặn
// event loop: child_process.spawn (async) + chờ exit qua event, body đưa vào stdin như cũ
// (UTF-8 byte-accurate trên Windows — đúng fix hở thật P2), KHÔNG worker thread.
//   * DÀNH CHO đường propose LLM (chỉ cần kết quả MUỘN rồi gate re-check lúc gửi — xem
//     docs/SURI-ASYNC.md). Hợp đồng GỬI KÊNH (ActionGate.executeSend → sendMessage SYNC)
//     GIỮ NGUYÊN: kênh gửi vẫn dùng httpOnce (spawnSync) như cũ.
//   * TIMEOUT: curl --max-time (exit 28 => {timeout:true}) + kill backstop phía Node
//     (max-time + 5s — chỉ là lưới an toàn nếu curl treo không tự thoát).
//   * Giải mã stdout: buffer -> utf8 sau khi đủ dữ liệu (không ép encoding từng chunk).
function httpOnceAsync({ url, method = 'POST', headers = {}, body, timeoutMs = 15000 } = {}) {
  return new Promise(resolve => {
    if (!url) return resolve({ ok: false, error: 'http_missing_url' });
    const t = Math.max(1, Math.ceil((timeoutMs || 15000) / 1000));
    const args = ['-sS', '-i', '--max-time', String(t), '-X', String(method || 'POST').toUpperCase(), url];
    for (const [k, v] of Object.entries(headers || {})) {
      if (v === undefined || v === null) continue;
      args.push('-H', `${k}: ${v}`);
    }
    let stdin = null;
    if (body !== undefined && body !== null) {
      args.push('--data-binary', '@-');
      stdin = String(body);
    }

    let child;
    try {
      child = spawn('curl', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, error: 'http_spawn:' + String((e && e.message) || e) });
    }

    const chunks = [];
    let settled = false;
    const finish = r => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(r);
    };
    // Backstop: nếu curl vượt quá --max-time + 5s mà chưa exit (treo hiếm gặp) -> kill, coi timeout.
    const killTimer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* đã chết */ }
      finish({ ok: false, timeout: true });
    }, t * 1000 + 5000);

    child.stdout.on('data', c => chunks.push(c));
    child.on('error', e => finish({ ok: false, error: 'http_spawn:' + String((e && e.message) || e) }));
    child.on('close', code => {
      const out = Buffer.concat(chunks).toString('utf8');
      if (code === 28) return finish({ ok: false, timeout: true }); // curl exit 28 = operation timed out
      if (code !== 0 && !out) return finish({ ok: false, error: 'http_exit_' + code });
      // tách header/body từ stdout của `-i` (chấp nhận CRLF hoặc LF) — Y HỆT httpOnce
      const iCrlf = out.indexOf('\r\n\r\n');
      const iLf = out.indexOf('\n\n');
      let head = '';
      let bodyText = out;
      if (iCrlf >= 0 && (iLf < 0 || iCrlf <= iLf)) { head = out.slice(0, iCrlf); bodyText = out.slice(iCrlf + 4); }
      else if (iLf >= 0) { head = out.slice(0, iLf); bodyText = out.slice(iLf + 2); }
      const m = head.match(/HTTP\/[\d.]+\s+(\d{3})/i);
      finish({ ok: true, status: m ? parseInt(m[1], 10) : 0, headers: {}, bodyText });
    });

    // body qua stdin (UTF-8 thô, byte-accurate) — như fix P2 của httpOnce
    if (child.stdin) {
      child.stdin.on('error', () => { /* curl chết sớm — 'error'/'close' của child sẽ quyết định */ });
      child.stdin.end(stdin);
    } else if (stdin !== null) {
      finish({ ok: false, error: 'http_spawn:stdin_unavailable' });
    }
  });
}

module.exports = { httpOnce, httpOnceAsync };
