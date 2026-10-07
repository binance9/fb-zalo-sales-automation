import io

p = 'test/matrix/e2e.js'
s = io.open(p, encoding='utf-8').read()

old = """        const req = http.request({ hostname: '127.0.0.1', port: ctx.inst.server.address().port, path: '/api/events', method: 'GET', headers: { Cookie: 'sid=' + ctx.sid } }, res => {
          let buf = '';
          const timer = setTimeout(() => { req.destroy(); resolve(null); }, 4500);
          res.on('data', c => {
            buf += c;
            const m = buf.match(/data: (.*)\\n/);
            if (m) {
              try {
                const j = JSON.parse(m[1]);
                if (j.type === 'update' && j.unread_by_shop) { clearTimeout(timer); req.destroy(); resolve(j); }
              } catch (e) { /* tiep tuc */ }
            }
          });
        });"""
new = """        const req = http.request({ hostname: '127.0.0.1', port: ctx.inst.server.address().port, path: '/api/events', method: 'GET', headers: { Cookie: 'sid=' + ctx.sid } }, res => {
          let buf = '';
          const timer = setTimeout(() => { req.destroy(); resolve(null); }, 6000);
          res.on('data', c => {
            buf += c;
            // xu LY TUNG DONG (match tu dau buffer se luon tra ve 'hello' dau tien)
            for (;;) {
              const idx = buf.indexOf('\\n');
              if (idx < 0) break;
              const line = buf.slice(0, idx).trim();
              buf = buf.slice(idx + 1);
              if (!line.startsWith('data:')) continue;
              try {
                const j = JSON.parse(line.slice(5).trim());
                if (j.type === 'update' && j.unread_by_shop) { clearTimeout(timer); req.destroy(); resolve(j); }
              } catch (e) { /* tiep tuc */ }
            }
          });
        });"""
# file co the dang CRLF do patch truoc — chuan hoa tam theo nugoi tuong ung
old_crlf = old.replace('\n', '\r\n')
new_crlf = new.replace('\n', '\r\n')
if old in s:
    s = s.replace(old, new)
elif old_crlf in s:
    s = s.replace(old_crlf, new_crlf)
else:
    raise AssertionError('H1 request block not found')
io.open(p, 'w', encoding='utf-8', newline='') .write(s)
print('patched OK')
