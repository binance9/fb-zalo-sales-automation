'use strict';
// auth.js — AUTH + USER/SHOP MODEL (PHASE PRODUCT-READY, đợt 1).
//
// NHIỆM VỤ:
//   - users: email + passwordHash (scryptSync + salt ngẫu nhiên) + role OWNER/ADMIN/AGENT + shop_id.
//   - shops registry: shop_id -> { name, dataDir } — kiến trúc cô lập shop: MỖI SHOP = 1 APP
//     instance + dataDir RIÊNG (data/shops/<shop_id>) — server.js giữ map shop_id -> App (lazy).
//   - sessions: token ngẫu nhiên 32B (hex), cookie HttpOnly (server.js set), expiry 7 ngày,
//     lưu file trong <dir>/ — restart giữ session.
//   - Login rate limit 5 lần/phút/IP (fail-closed: lỗi limiter -> TỪ CHỐNG, không cho qua).
//   - Quên mật khẩu: reset token ghi file local (KHÔNG email thật).
//   - Setup owner đầu tiên: chỉ hoạt động khi CHƯA có user nào.
//
// KHÔNG đụng core (gate/pipeline/store/order-engine). Store JSON riêng trong data/auth/.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROLES = ['OWNER', 'ADMIN', 'AGENT'];
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 ngày
const RESET_TTL_MS = 30 * 60 * 1000;         // token reset sống 30 phút
const LOGIN_RATE = { max: 5, windowMs: 60 * 1000 }; // 5 lần/phút/IP
const MIN_PASSWORD_LEN = 8;

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '')); }
function validPassword(p) { return typeof p === 'string' && p.length >= MIN_PASSWORD_LEN; }

function slugId(name) {
  return String(name || 'shop').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'shop';
}

class AuthError extends Error {
  constructor(code, http) { super(code); this.code = code; this.http = http || 400; }
}

class Auth {
  constructor({ dir, shopsRoot } = {}) {
    this.dir = dir || path.join(__dirname, '..', 'data', 'auth');
    this.shopsRoot = shopsRoot || path.join(__dirname, '..', 'data', 'shops');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.shopsRoot, { recursive: true });
    this.usersFile = path.join(this.dir, 'users.json');
    this.shopsFile = path.join(this.dir, 'shops.json');
    this.sessionsFile = path.join(this.dir, 'sessions.json');
    this.resetsFile = path.join(this.dir, 'reset-tokens.json');
    this.users = this._load(this.usersFile, []);
    this.shops = this._load(this.shopsFile, {});
    this.sessions = this._load(this.sessionsFile, {});
    this.resets = this._load(this.resetsFile, {});
    this.loginAttempts = new Map(); // ip -> {count, windowStart} — in-memory, reset khi restart
    this._sweepSessions();
  }

  _load(file, dflt) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return dflt; }
  }
  _save(file, obj) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
    fs.renameSync(tmp, file);
  }
  saveUsers() { this._save(this.usersFile, this.users); }
  saveShops() { this._save(this.shopsFile, this.shops); }
  saveSessions() { this._save(this.sessionsFile, this.sessions); }
  saveResets() { this._save(this.resetsFile, this.resets); }

  _sweepSessions() {
    const now = Date.now();
    let changed = false;
    for (const [token, s] of Object.entries(this.sessions)) {
      if (Date.parse(s.expires_at) <= now) { delete this.sessions[token]; changed = true; }
    }
    if (changed) this.saveSessions();
  }

  // ------------------------------------------------------------ shops
  hasShop(shopId) { return !!this.shops[shopId]; }
  getShop(shopId) { return this.shops[shopId] || null; }
  firstShopId() { return Object.keys(this.shops)[0] || null; }
  listShops() {
    return Object.entries(this.shops).map(([shop_id, s]) => ({
      shop_id, name: s.name, dataDir: s.dataDir, created_at: s.created_at,
    }));
  }

  createShop(name, { dataDir } = {}) {
    const base = slugId(name);
    let shopId = base;
    let i = 2;
    while (this.shops[shopId]) shopId = `${base}-${i++}`;
    const dir = dataDir || path.join(this.shopsRoot, shopId);
    fs.mkdirSync(dir, { recursive: true });
    this.shops[shopId] = { name: String(name || shopId), dataDir: dir, created_at: new Date().toISOString() };
    this.saveShops();
    return { shop_id: shopId, ...this.shops[shopId] };
  }

  // ------------------------------------------------------------ users
  hasUsers() { return this.users.length > 0; }
  findUserByEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    return this.users.find(u => u.email === e) || null;
  }
  _publicUser(u) {
    return { user_id: u.user_id, email: u.email, role: u.role, shop_id: u.shop_id, created_at: u.created_at };
  }

  // Tạo OWNER ĐẦU TIÊN — CHỈ khi 0 user. Đồng thời tạo shop đầu (nếu registry trống).
  setupOwner({ email, password, shop_name } = {}) {
    if (this.hasUsers()) throw new AuthError('SETUP_ALREADY_DONE', 403);
    if (!validEmail(email)) throw new AuthError('BAD_EMAIL', 400);
    if (!validPassword(password)) throw new AuthError('WEAK_PASSWORD', 400);
    let shopId = this.firstShopId();
    if (!shopId) shopId = this.createShop(shop_name || 'Cửa hàng của tôi').shop_id;
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      user_id: 'usr_' + crypto.randomBytes(8).toString('hex'),
      email: String(email).trim().toLowerCase(),
      salt,
      passwordHash: hashPassword(password, salt),
      role: 'OWNER',
      shop_id: shopId,
      created_at: new Date().toISOString(),
    };
    this.users.push(user);
    this.saveUsers();
    return { user: this._publicUser(user), shop: { shop_id: shopId, ...this.shops[shopId] } };
  }

  createUser(actor, { email, password, role, shop_id } = {}) {
    if (!actor || (actor.role !== 'OWNER' && actor.role !== 'ADMIN')) throw new AuthError('FORBIDDEN', 403);
    if (role === 'OWNER' && actor.role !== 'OWNER') throw new AuthError('ONLY_OWNER_CREATES_OWNER', 403);
    if (!ROLES.includes(role)) throw new AuthError('BAD_ROLE', 400);
    if (!validEmail(email)) throw new AuthError('BAD_EMAIL', 400);
    if (!validPassword(password)) throw new AuthError('WEAK_PASSWORD', 400);
    if (this.findUserByEmail(email)) throw new AuthError('EMAIL_EXISTS', 409);
    const sid = shop_id || actor.shop_id;
    if (!this.shops[sid]) throw new AuthError('SHOP_NOT_FOUND', 404);
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      user_id: 'usr_' + crypto.randomBytes(8).toString('hex'),
      email: String(email).trim().toLowerCase(),
      salt,
      passwordHash: hashPassword(password, salt),
      role,
      shop_id: sid,
      created_at: new Date().toISOString(),
    };
    this.users.push(user);
    this.saveUsers();
    return this._publicUser(user);
  }

  listUsers(actor) {
    if (!actor || (actor.role !== 'OWNER' && actor.role !== 'ADMIN')) throw new AuthError('FORBIDDEN', 403);
    return this.users.map(u => this._publicUser(u));
  }

  // ------------------------------------------------------------ login/logout
  // Rate limit 5 lần THẤT BẠI/phút/IP (đếm fail — chuẩn thông practice; fail-closed: mọi
  // lỗi của limiter -> TỪ CHỐNG). Khi đã vượt limit: cả mật khẩu ĐÚNG cũng bị 429 trong cửa sổ.
  _rateBlocked(ip) {
    try {
      const now = Date.now();
      const st = this.loginAttempts.get(ip);
      if (!st || now - st.windowStart > LOGIN_RATE.windowMs) return false;
      return st.count >= LOGIN_RATE.max;
    } catch (e) {
      return true; // fail-closed
    }
  }

  _rateFail(ip) {
    try {
      const now = Date.now();
      let st = this.loginAttempts.get(ip);
      if (!st || now - st.windowStart > LOGIN_RATE.windowMs) {
        st = { count: 0, windowStart: now };
        this.loginAttempts.set(ip, st);
      }
      st.count += 1;
    } catch (e) { /* không đếm được — coi như fail (đã blocked ở _rateBlocked fail-closed) */ }
  }

  login({ email, password, ip } = {}) {
    const key = String(ip || 'unknown');
    // SỬA (PRODUCT-READY đợt 2, matrix SE05): fail-closed Ở MỨC LOGIN — limiter ném lỗi
    // (crash, storage hỏng…) phải TỪ CHỐNG (429), KHÔNG để lỗi bay lên route thành 500
    // (500 vô tình mở đường "thử lại khi server khỏe" và lộ trạng thái nội bộ).
    let blocked;
    try { blocked = this._rateBlocked(key); } catch (e) { blocked = true; }
    if (blocked) throw new AuthError('RATE_LIMITED', 429);
    const u = this.findUserByEmail(email);
    let ok = false;
    if (u) {
      const hash = hashPassword(password, u.salt);
      ok = safeEqual(hash, u.passwordHash);
    } else {
      // đếm thời gian an toàn hơn: vẫn chạy scrypt trên salt giả để tránh timing-leak user tồn tại
      hashPassword(password, '0000000000000000000000000000000');
    }
    if (!ok) {
      this._rateFail(key);
      throw new AuthError('BAD_CREDENTIALS', 401);
    }
    this.loginAttempts.delete(key); // thành công -> xóa counter fail của IP này
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions[token] = {
      user_id: u.user_id,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    };
    this.saveSessions();
    return { token, user: this._publicUser(u) };
  }

  logout(token) {
    if (token && this.sessions[token]) { delete this.sessions[token]; this.saveSessions(); }
    return { ok: true };
  }

  // Token -> user (kiểm expiry). Trả null khi không hợp lệ.
  userForToken(token) {
    if (!token) return null;
    // TEST_AUTH_BYPASS: đường CHO RIÊNG regression cũ/smoke — token cố định quy về user đầu tiên
    // của shop đầu. UI thật vẫn bắt auth bình thường (bypass chỉ hoạt động khi server được bật env).
    if (process.env.TEST_AUTH_BYPASS && safeEqual(token, process.env.TEST_AUTH_BYPASS)) {
      const u = this.users.find(x => x.role === 'OWNER') || this.users[0];
      return u ? this._publicUser(u) : null;
    }
    const s = this.sessions[token];
    if (!s || Date.parse(s.expires_at) <= Date.now()) return null;
    const u = this.users.find(x => x.user_id === s.user_id);
    return u ? this._publicUser(u) : null;
  }

  // ------------------------------------------------------------ password
  changePassword(actor, { old_password, new_password } = {}) {
    const u = this.users.find(x => x.user_id === actor.user_id);
    if (!u) throw new AuthError('USER_NOT_FOUND', 404);
    const oldHash = hashPassword(old_password || '', u.salt);
    if (!safeEqual(oldHash, u.passwordHash)) throw new AuthError('BAD_CREDENTIALS', 401);
    if (!validPassword(new_password)) throw new AuthError('WEAK_PASSWORD', 400);
    u.salt = crypto.randomBytes(16).toString('hex');
    u.passwordHash = hashPassword(new_password, u.salt);
    this.saveUsers();
    return { ok: true };
  }

  // Quên mật khẩu — KHÔNG email thật: token reset ghi FILE local (mô phỏng "link gửi email").
  forgotPassword(email) {
    const u = this.findUserByEmail(email);
    // Không tiết lộ email có tồn tại hay không (chống dò user) — vẫn trả ok.
    if (!u) return { ok: true, sent: false };
    const token = crypto.randomBytes(24).toString('hex');
    this.resets[token] = {
      user_id: u.user_id,
      expires_at: new Date(Date.now() + RESET_TTL_MS).toISOString(),
      used: false,
    };
    this.saveResets();
    return { ok: true, sent: true, reset_token: token, expires_at: this.resets[token].expires_at };
  }

  resetPassword({ token, new_password } = {}) {
    const r = token ? this.resets[token] : null;
    if (!r || r.used || Date.parse(r.expires_at) <= Date.now()) throw new AuthError('BAD_RESET_TOKEN', 400);
    if (!validPassword(new_password)) throw new AuthError('WEAK_PASSWORD', 400);
    const u = this.users.find(x => x.user_id === r.user_id);
    if (!u) throw new AuthError('USER_NOT_FOUND', 404);
    u.salt = crypto.randomBytes(16).toString('hex');
    u.passwordHash = hashPassword(new_password, u.salt);
    r.used = true;
    this.saveUsers();
    this.saveResets();
    return { ok: true };
  }
}

module.exports = { Auth, AuthError, ROLES, SESSION_TTL_MS, hashPassword, MIN_PASSWORD_LEN };
