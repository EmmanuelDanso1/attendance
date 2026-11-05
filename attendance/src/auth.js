'use strict';
// ── SERVER-SIDE ADMIN AUTHENTICATION ──────────────────────────────
// The admin username/password live in the settings table (key 'admin'),
// with the password stored as a salted scrypt hash. Logging in returns a
// random session token that must be sent as "Authorization: Bearer <token>"
// on every admin API call. Sessions are kept in memory, so a server
// restart signs admins out.
const crypto = require('crypto');
const pool   = require('./db');

const SESSION_MS = 8 * 60 * 60 * 1000;   // 8 hours, extended on every request
const MAX_FAILS  = 5;                     // wrong attempts before a lockout
const LOCKOUT_MS = 5 * 60 * 1000;         // 5 minutes

const sessions = new Map();   // token → { user, exp }
const failures = new Map();   // key   → { count, until, last }

// Drop expired sessions and stale failure counters every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.exp <= now) sessions.delete(t);
  for (const [k, f] of failures) if (f.until <= now && now - f.last > LOCKOUT_MS) failures.delete(k);
}, 10 * 60 * 1000).unref();

// ── Attempt limiting (admin login and employee PINs) ──────────────
function lockMinutes(key) {
  const f = failures.get(key);
  if (!f || f.until <= Date.now()) return 0;
  return Math.ceil((f.until - Date.now()) / 60000);
}
// Returns how many attempts are left before a lockout (0 = now locked)
function recordFailure(key) {
  const f = failures.get(key) || { count: 0, until: 0, last: 0 };
  f.count += 1;
  f.last = Date.now();
  let left = MAX_FAILS - f.count;
  if (left <= 0) { f.count = 0; f.until = Date.now() + LOCKOUT_MS; left = 0; }
  failures.set(key, f);
  return left;
}
function clearFailures(key) { failures.delete(key); }
function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

// ── Password hashing ──────────────────────────────────────────────
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function verifyPassword(password, { salt, hash }) {
  const expected = Buffer.from(hash, 'hex');
  const actual   = crypto.scryptSync(password, salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function getAdmin() {
  const { rows } = await pool.query(`SELECT value FROM settings WHERE key = 'admin'`);
  return rows[0]?.value || null;
}
async function saveAdmin(admin) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('admin', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [admin]
  );
}

// Create the admin account on first start. ADMIN_USER / ADMIN_PASSWORD from
// .env are used only here; afterwards credentials are changed in Settings.
async function ensureAdmin() {
  if (await getAdmin()) return;
  const user = (process.env.ADMIN_USER || 'admin').trim();
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  await saveAdmin({ user, ...hashPassword(password) });
  console.log(`🔑  Admin account "${user}" created` +
    (process.env.ADMIN_PASSWORD ? ' from ADMIN_PASSWORD.' : ' with the default password admin123 — change it in Settings.'));
}

// ── Sessions ──────────────────────────────────────────────────────
function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user, exp: Date.now() + SESSION_MS });
  return token;
}
function tokenFrom(req) {
  const m = /^Bearer ([a-f0-9]{64})$/i.exec(req.headers.authorization || '');
  return m ? m[1] : null;
}
function requireAdmin(req, res, next) {
  const token = tokenFrom(req);
  const s = token && sessions.get(token);
  if (!s || s.exp <= Date.now()) {
    if (s) sessions.delete(token);
    return res.status(401).json({ error: 'Admin login required. Please log in again.' });
  }
  s.exp = Date.now() + SESSION_MS;   // sliding expiry
  req.admin = { user: s.user, token };
  next();
}

// ── Routes ────────────────────────────────────────────────────────
function register(app) {
  app.post('/api/auth/login', async (req, res) => {
    const user = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    // One shared counter: there is a single admin account, and client IPs
    // can be spoofed through X-Forwarded-For.
    const key = 'login';
    const mins = lockMinutes(key);
    if (mins) return res.status(429).json({ error: `Too many failed attempts. Try again in ${plural(mins, 'minute')}.` });
    if (!user || !password) return res.status(400).json({ error: 'Please enter both username and password.' });
    try {
      const admin = await getAdmin();
      if (admin && user === admin.user && verifyPassword(password, admin)) {
        clearFailures(key);
        return res.json({ token: createSession(admin.user), user: admin.user, expiresIn: SESSION_MS });
      }
      const left = recordFailure(key);
      res.status(left ? 403 : 429).json({ error: left
        ? `Incorrect username or password. ${plural(left, 'attempt')} remaining.`
        : 'Too many failed attempts. Try again in 5 minutes.' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = tokenFrom(req);
    if (token) sessions.delete(token);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAdmin, (req, res) => {
    res.json({ user: req.admin.user });
  });

  // Change username and/or password. The current password is required.
  app.put('/api/auth/credentials', requireAdmin, async (req, res) => {
    const current  = String(req.body.currentPassword || '');
    const user     = String(req.body.username || '').trim();
    const password = String(req.body.newPassword || '');
    const key = 'login';
    const mins = lockMinutes(key);
    if (mins) return res.status(429).json({ error: `Too many failed attempts. Try again in ${plural(mins, 'minute')}.` });
    if (!current) return res.status(400).json({ error: 'Enter your current password to make changes.' });
    if (!user) return res.status(400).json({ error: 'Username cannot be empty.' });
    if (password && password.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    try {
      const admin = await getAdmin();
      if (!admin || !verifyPassword(current, admin)) {
        const left = recordFailure(key);
        return res.status(403).json({ error: left ? 'Current password is incorrect.' : 'Too many failed attempts. Try again in 5 minutes.' });
      }
      clearFailures(key);
      await saveAdmin({ user, ...(password ? hashPassword(password) : { salt: admin.salt, hash: admin.hash }) });
      // Sign out every other session; keep this one, under the new username
      for (const [t] of sessions) if (t !== req.admin.token) sessions.delete(t);
      sessions.get(req.admin.token).user = user;
      res.json({ user });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { register, requireAdmin, ensureAdmin, lockMinutes, recordFailure, clearFailures, plural };
