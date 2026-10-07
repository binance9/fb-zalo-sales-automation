'use strict';
// test/matrix/auth.js — AREA AUTH (15 case)
const assert = require('assert');
const { startInst, sleep } = require('./_harness');

module.exports = {
  area: 'Auth',
  async setup() {
    const inst = await startInst('auth');
    return { inst };
  },
  cases: [
    { id: 'AU01', desc: 'setup OWNER đầu tiên 200 + role OWNER', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/auth/setup', { body: { email: 'au01@matrix.vn', password: 'password123', shop_name: 'AU' } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.user.role, 'OWNER');
      ctx.sidOwner = r.headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
    } },
    { id: 'AU02', desc: 'setup lần 2 -> 403 SETUP_ALREADY_DONE', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/auth/setup', { body: { email: 'x@y.vn', password: 'password123' } });
      assert.strictEqual(r.status, 403);
      assert.strictEqual(r.json.error, 'SETUP_ALREADY_DONE');
    } },
    { id: 'AU03', desc: 'login sai mật khẩu -> 401 BAD_CREDENTIALS', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/auth/login', { body: { email: 'au01@matrix.vn', password: 'sai-roi' } });
      assert.strictEqual(r.status, 401);
      assert.strictEqual(r.json.error, 'BAD_CREDENTIALS');
    } },
    { id: 'AU04', desc: 'login email không tồn tại -> 401 (không lộ user tồn tại)', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/auth/login', { body: { email: 'khongtonnai@matrix.vn', password: 'password123' } });
      assert.strictEqual(r.status, 401);
      assert.strictEqual(r.json.error, 'BAD_CREDENTIALS');
    } },
    { id: 'AU05', desc: 'login đúng -> 200 + cookie HttpOnly SameSite Max-Age', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/auth/login', { body: { email: 'au01@matrix.vn', password: 'password123' } });
      assert.strictEqual(r.status, 200);
      const c = r.headers['set-cookie'][0];
      assert.match(c, /HttpOnly/);
      assert.match(c, /SameSite=Lax/);
      assert.match(c, /Max-Age=\d+/);
    } },
    { id: 'AU06', desc: 'me không cookie -> 401; cookie rác -> 401', async fn(ctx) {
      assert.strictEqual((await ctx.inst.client('GET', '/api/auth/me')).status, 401);
      assert.strictEqual((await ctx.inst.client('GET', '/api/auth/me', { cookie: 'rac-rac' })).status, 401);
    } },
    { id: 'AU07', desc: 'me với cookie -> đúng email + shop_id', async fn(ctx) {
      const r = await ctx.inst.client('GET', '/api/auth/me', { cookie: ctx.sidOwner });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.user.email, 'au01@matrix.vn');
      assert.ok(r.json.user.shop_id);
    } },
    { id: 'AU08', desc: 'logout -> session chết (me 401)', async fn(ctx) {
      const lg = await ctx.inst.client('POST', '/api/auth/logout', { cookie: ctx.sidOwner });
      assert.strictEqual(lg.status, 200);
      assert.strictEqual((await ctx.inst.client('GET', '/api/auth/me', { cookie: ctx.sidOwner })).status, 401);
      ctx.sidOwner = (await ctx.inst.client('POST', '/api/auth/login', { body: { email: 'au01@matrix.vn', password: 'password123' } })).headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
    } },
    { id: 'AU09', desc: 'tạo ADMIN + AGENT 200', async fn(ctx) {
      const a = await ctx.inst.client('POST', '/api/auth/users', { cookie: ctx.sidOwner, body: { email: 'admin@matrix.vn', password: 'password456', role: 'ADMIN' } });
      const g = await ctx.inst.client('POST', '/api/auth/users', { cookie: ctx.sidOwner, body: { email: 'agent@matrix.vn', password: 'password789', role: 'AGENT' } });
      assert.strictEqual(a.status, 200);
      assert.strictEqual(g.status, 200);
      assert.strictEqual(a.json.user.role, 'ADMIN');
    } },
    { id: 'AU10', desc: 'trùng email -> 409 EMAIL_EXISTS', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/auth/users', { cookie: ctx.sidOwner, body: { email: 'agent@matrix.vn', password: 'password789', role: 'AGENT' } });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json.error, 'EMAIL_EXISTS');
    } },
    { id: 'AU11', desc: 'role sai -> 400 BAD_ROLE; mật khẩu yếu -> 400 WEAK_PASSWORD', async fn(ctx) {
      const bad = await ctx.inst.client('POST', '/api/auth/users', { cookie: ctx.sidOwner, body: { email: 'z@matrix.vn', password: 'password789', role: 'SUPERGOD' } });
      const weak = await ctx.inst.client('POST', '/api/auth/users', { cookie: ctx.sidOwner, body: { email: 'z@matrix.vn', password: '123', role: 'AGENT' } });
      assert.strictEqual(bad.status, 400);
      assert.strictEqual(bad.json.error, 'BAD_ROLE');
      assert.strictEqual(weak.status, 400);
      assert.strictEqual(weak.json.error, 'WEAK_PASSWORD');
    } },
    { id: 'AU12', desc: 'ADMIN tạo OWNER -> 403 ONLY_OWNER_CREATES_OWNER', async fn(ctx) {
      const sidAdmin = (await ctx.inst.client('POST', '/api/auth/login', { body: { email: 'admin@matrix.vn', password: 'password456' } })).headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
      const r = await ctx.inst.client('POST', '/api/auth/users', { cookie: sidAdmin, body: { email: 'newowner@matrix.vn', password: 'password789', role: 'OWNER' } });
      assert.strictEqual(r.status, 403);
      assert.strictEqual(r.json.error, 'ONLY_OWNER_CREATES_OWNER');
    } },
    { id: 'AU13', desc: 'đổi mật khẩu: old sai -> 401; old đúng -> login bằng mật khẩu mới', async fn(ctx) {
      await ctx.inst.client('POST', '/api/auth/users', { cookie: ctx.sidOwner, body: { email: 'cp@matrix.vn', password: 'password000', role: 'AGENT' } });
      const sidCp = (await ctx.inst.client('POST', '/api/auth/login', { body: { email: 'cp@matrix.vn', password: 'password000' } })).headers['set-cookie'][0].match(/sid=([^;]+)/)[1];
      const wrongOld = await ctx.inst.client('POST', '/api/auth/change-password', { cookie: sidCp, body: { old_password: 'sai', new_password: 'password999' } });
      assert.strictEqual(wrongOld.status, 401);
      const ok = await ctx.inst.client('POST', '/api/auth/change-password', { cookie: sidCp, body: { old_password: 'password000', new_password: 'password999' } });
      assert.strictEqual(ok.status, 200);
      const reNew = await ctx.inst.client('POST', '/api/auth/login', { body: { email: 'cp@matrix.vn', password: 'password999' } });
      assert.strictEqual(reNew.status, 200);
      const reOld = await ctx.inst.client('POST', '/api/auth/login', { body: { email: 'cp@matrix.vn', password: 'password000' } });
      assert.strictEqual(reOld.status, 401);
    } },
    { id: 'AU14', desc: 'forgot email lạ -> ok sent:false (không dò được user)', async fn(ctx) {
      const r = await ctx.inst.client('POST', '/api/auth/forgot', { body: { email: 'lathamat@matrix.vn' } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.ok, true);
      assert.strictEqual(r.json.sent, false);
    } },
    { id: 'AU15', desc: 'forgot + reset đúng flow; token dùng 2 lần -> 400', async fn(ctx) {
      const f = await ctx.inst.client('POST', '/api/auth/forgot', { body: { email: 'cp@matrix.vn' } });
      assert.strictEqual(f.json.sent, true);
      assert.ok(f.json.reset_token);
      const rs = await ctx.inst.client('POST', '/api/auth/reset', { body: { token: f.json.reset_token, new_password: 'password555' } });
      assert.strictEqual(rs.status, 200);
      const rs2 = await ctx.inst.client('POST', '/api/auth/reset', { body: { token: f.json.reset_token, new_password: 'password666' } });
      assert.strictEqual(rs2.status, 400);
      assert.strictEqual((await ctx.inst.client('POST', '/api/auth/login', { body: { email: 'cp@matrix.vn', password: 'password555' } })).status, 200);
    } },
    { id: 'AU16', desc: 'rate limit: 6 lần sai liên tiếp trong 1 phút -> 429 fail-closed (server riêng)', async fn(ctx) {
      const ri = await startInst('auth-ratelimit');
      try {
        await ri.client('POST', '/api/auth/setup', { body: { email: 'rl@matrix.vn', password: 'password123', shop_name: 'RL' } });
        let last = null;
        for (let i = 0; i < 6; i++) last = await ri.client('POST', '/api/auth/login', { body: { email: 'rl@matrix.vn', password: 'wrong-' + i } });
        assert.strictEqual(last.status, 429);
        assert.strictEqual(last.json.error, 'RATE_LIMITED');
        const okInLock = await ri.client('POST', '/api/auth/login', { body: { email: 'rl@matrix.vn', password: 'password123' } });
        assert.strictEqual(okInLock.status, 429, 'đúng mật khẩu vẫn 429 trong cửa sổ khoá');
      } finally { await ri.close(); }
    } },
  ],
};
