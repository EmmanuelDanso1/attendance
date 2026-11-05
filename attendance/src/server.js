'use strict';
const express  = require('express');
const path     = require('path');
const cors     = require('cors');
const crypto   = require('crypto');
const pool     = require('./db');
const auth     = require('./auth');
const { requireAdmin } = auth;

const app  = express();
const PORT = process.env.PORT || 3000;

// ── NETWORK ALLOWLIST ─────────────────────────────────────────────
// List every IP range that belongs to the company network.
// Supports exact IPs and CIDR notation (e.g. 192.168.1.0/24).
// Set ALLOWED_NETWORKS in .env as a comma-separated list, e.g.:
//   ALLOWED_NETWORKS=192.168.1.0/24,10.0.0.0/8
// Defaults to common private LAN ranges if not set.
const ALLOWED_NETWORKS = (
  process.env.ALLOWED_NETWORKS || '192.168.0.0/16,10.0.0.0/8,172.16.0.0/12'
).split(',').map(s => s.trim()).filter(Boolean);

// Parse a CIDR block into { base (32-bit int), mask (32-bit int) }
function parseCIDR(cidr) {
  const [ip, bits] = cidr.includes('/') ? cidr.split('/') : [cidr, '32'];
  const mask = bits === '0' ? 0 : (~0 << (32 - parseInt(bits))) >>> 0;
  const base = ipToInt(ip) & mask;
  return { base, mask };
}

function ipToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function isAllowedIP(ip) {
  // Strip IPv6-mapped IPv4 prefix (::ffff:192.168.1.1 → 192.168.1.1)
  const clean = ip.replace(/^::ffff:/, '');
  // Always allow loopback (the server machine itself / admin on same box)
  if (clean === '127.0.0.1' || clean === '::1') return true;
  let num;
  try { num = ipToInt(clean); } catch { return false; }
  return ALLOWED_NETWORKS.some(range => {
    const { base, mask } = parseCIDR(range);
    return (num & mask) === base;
  });
}

// ── NETWORK GUARD MIDDLEWARE ──────────────────────────────────────
// Runs before every request — page load AND every API call.
function networkGuard(req, res, next) {
  // Trust the real IP when behind a reverse proxy (nginx, etc.)
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
           || req.socket.remoteAddress
           || '';

  if (isAllowedIP(ip)) return next();

  // Log the blocked attempt with timestamp
  console.warn(`[BLOCKED] ${new Date().toISOString()} — IP ${ip} tried to access ${req.path}`);

  // Return a plain 403 page — give nothing useful away
  res.status(403).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Access Denied</title>
<style>
  body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;
       min-height:100vh;margin:0;background:#0f172a;color:#94a3b8;text-align:center}
  h1{color:#f1f5f9;font-size:1.5rem;margin-bottom:0.5rem}
  p{font-size:0.9rem;max-width:360px}
</style></head>
<body>
  <div>
    <h1>🔒 Access Restricted</h1>
    <p>This system is only accessible from the company network.<br>
       Please connect to the office Wi-Fi and try again.</p>
  </div>
</body></html>`);
}

// Apply the guard to every single route, first thing
app.use(networkGuard);

app.use(cors({ origin: false })); // no cross-origin requests
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// Admin login / logout / credentials (see auth.js).
// Every route marked requireAdmin needs a logged-in admin session; the
// employee check-in page only uses the public routes: POST /api/records,
// GET /api/checkin/status and GET /api/settings/gps.
auth.register(app);

// ── EMPLOYEE LOOKUP & PIN CHECK (used by check-ins) ───────────────

// Find an employee by full name or Employee ID (case-insensitive)
async function findEmployee(nameOrId) {
  const { rows } = await pool.query(
    `SELECT * FROM employees WHERE LOWER(name) = LOWER($1) OR LOWER(emp_id) = LOWER($1) LIMIT 1`,
    [nameOrId]
  );
  return rows[0] || null;
}

// PINs are stored as SHA-256 hex; compare in constant time
function pinMatches(pin, pinHash) {
  const actual   = Buffer.from(crypto.createHash('sha256').update(pin).digest('hex'));
  const expected = Buffer.from(String(pinHash || ''));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Record types this employee already has on the given day
async function dayTypes(emp, dateKey) {
  const { rows } = await pool.query(
    `SELECT type FROM attendance_records
     WHERE date_key = $1 AND ((emp_id = $2 AND emp_id <> '') OR LOWER(name) = LOWER($3))`,
    [dateKey, emp.emp_id, emp.name]
  );
  return rows.map(r => r.type);
}

// Lets the check-in form switch to "Check out" once someone has checked in.
// Reveals only whether that person has checked in/out on that day.
app.get('/api/checkin/status', async (req, res) => {
  const who = String(req.query.name || '').trim();
  const dateKey = String(req.query.date || '');
  const none = { checkedIn: false, checkedOut: false };
  if (!who || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return res.json(none);
  try {
    const emp = await findEmployee(who);
    if (!emp) return res.json(none);
    const types = await dayTypes(emp, dateKey);
    res.json({ checkedIn: types.includes('Check In'), checkedOut: types.includes('Check Out') });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── ATTENDANCE RECORDS ────────────────────────────────────────────

app.get('/api/records', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM attendance_records ORDER BY iso DESC`
    );
    res.json(rows.map(dbToRecord));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Public: employees check in/out here. Name + PIN and the GPS lock are all
// verified on the server, so the check-in page never needs the PIN list.
app.post('/api/records', async (req, res) => {
  const { type, date, dateKey, time, day, iso, status } = req.body;
  const who = String(req.body.name || '').trim();
  const pin = String(req.body.pin || '').trim();
  if (!who) return res.status(400).json({ error: 'Please enter your full name', field: 'name' });
  if (!pin) return res.status(400).json({ error: 'Please enter your PIN', field: 'pin' });
  if (type !== 'Check In' && type !== 'Check Out') return res.status(400).json({ error: 'Invalid action' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return res.status(400).json({ error: 'Invalid date' });
  try {
    // GPS lock (always on): the device must be inside the office radius.
    // Checked here so it can't be skipped by editing the page.
    const gps = await getGpsSettings();
    if (!gps) {
      return res.status(403).json({ error: 'The office location has not been set up yet. Contact your administrator.' });
    }
    const lat = Number(req.body.lat), lng = Number(req.body.lng);
    if (req.body.lat == null || req.body.lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'Your location is required to check in. Please allow location access.' });
    }
    const dist = distanceMetres(lat, lng, gps.lat, gps.lng);
    if (dist > gps.radius) {
      return res.status(403).json({ error: `You are outside the office premises (${Math.round(dist)} m away, limit ${gps.radius} m).` });
    }

    // Employee and PIN. Wrong PINs are limited per employee (5 tries, then a
    // 5-minute lockout) so nobody can guess their way through the 5 digits.
    const emp = await findEmployee(who);
    if (!emp) return res.status(404).json({ error: 'Employee not found. Contact your administrator.', field: 'name' });
    const key = 'pin|' + emp.id;
    const mins = auth.lockMinutes(key);
    if (mins) return res.status(429).json({ error: `Too many incorrect PINs. Try again in ${auth.plural(mins, 'minute')}.`, field: 'pin' });
    if (!pinMatches(pin, emp.pin_hash)) {
      const left = auth.recordFailure(key);
      return res.status(left ? 403 : 429).json({ error: left
        ? `Incorrect PIN. ${auth.plural(left, 'attempt')} remaining.`
        : 'Too many incorrect PINs. Try again in 5 minutes.', field: 'pin' });
    }
    auth.clearFailures(key);

    // Day rules: check out only after checking in, and only once
    if (type === 'Check Out') {
      const types = await dayTypes(emp, dateKey);
      if (!types.includes('Check In')) return res.status(409).json({ error: `No check-in found for ${emp.name} today. Please check in first.` });
      if (types.includes('Check Out')) return res.status(409).json({ error: `${emp.name} has already checked out today.` });
    }

    // Name and Employee ID come from the registry, not from the request
    const { rows } = await pool.query(
      `INSERT INTO attendance_records (name, emp_id, type, date, date_key, time, day, iso, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [emp.name, emp.emp_id, type, date, dateKey, time, day || '', iso, status || '']
    );
    res.status(201).json(dbToRecord(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/records/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM attendance_records WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/records/replace', requireAdmin, async (req, res) => {
  const { records } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM attendance_records');
    if (Array.isArray(records) && records.length) {
      for (const r of records) {
        await client.query(
          `INSERT INTO attendance_records (name, emp_id, type, date, date_key, time, day, iso, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [r.name, r.empId||'', r.type, r.date, r.dateKey, r.time, r.day||'', r.iso, r.status||'']
        );
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── EMPLOYEE REGISTRY ─────────────────────────────────────────────

app.get('/api/employees', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM employees ORDER BY added_at ASC`);
    res.json(rows.map(dbToEmp));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/employees', requireAdmin, async (req, res) => {
  const { name, dept, empId, pinHash, pinRaw, photo, added } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO employees (name, dept, emp_id, pin_hash, pin_raw, photo, added)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [name, dept||'', empId, pinHash, pinRaw||'', photo||'', added||'']
    );
    res.status(201).json(dbToEmp(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Edit an employee. On a rename, their past attendance records move to the
// new name in the same transaction, so history stays linked to the person.
app.put('/api/employees/:id', requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').replace(/<[^>]*>/g, '').trim();
  const dept = String(req.body.dept || '').replace(/<[^>]*>/g, '').trim();
  if (!name) return res.status(400).json({ error: 'Please enter the employee name' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [old] } = await client.query('SELECT * FROM employees WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!old) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Employee not found' });
    }
    // photo / PIN are only changed when sent ('' photo = remove it)
    const photo   = req.body.photo   !== undefined ? String(req.body.photo) : old.photo;
    const pinHash = req.body.pinHash ? String(req.body.pinHash) : old.pin_hash;
    const pinRaw  = req.body.pinHash ? String(req.body.pinRaw || '') : old.pin_raw;
    const { rows: [updated] } = await client.query(
      `UPDATE employees SET name = $1, dept = $2, photo = $3, pin_hash = $4, pin_raw = $5
       WHERE id = $6 RETURNING *`,
      [name, dept, photo, pinHash, pinRaw, req.params.id]
    );
    if (name !== old.name) {
      await client.query(
        `UPDATE attendance_records SET name = $1
         WHERE (emp_id = $2 AND emp_id <> '') OR LOWER(name) = LOWER($3)`,
        [name, old.emp_id, old.name]
      );
    }
    await client.query('COMMIT');
    res.json(dbToEmp(updated));
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Another employee already has this name' });
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/employees/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM employees WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── SETTINGS ──────────────────────────────────────────────────────
// Shared settings live in the database so every device (admin browser
// and employee phones) uses the same values.

// Create the settings table, then the admin account on first start
(async () => {
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS settings (
         key        TEXT        PRIMARY KEY,
         value      JSONB       NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    );
    await auth.ensureAdmin();
  } catch (err) {
    console.error('Database setup failed:', err.message);
  }
})();

async function getGpsSettings() {
  const { rows } = await pool.query(`SELECT value FROM settings WHERE key = 'gps'`);
  return rows[0]?.value || null;
}

// Great-circle distance in metres between two lat/lng points (haversine)
function distanceMetres(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

app.get('/api/settings/gps', async (req, res) => {
  try {
    res.json(await getGpsSettings() || { lat: null, lng: null, radius: 100 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings/gps', requireAdmin, async (req, res) => {
  const lat    = Number(req.body.lat);
  const lng    = Number(req.body.lng);
  const radius = Math.round(Number(req.body.radius));
  if (!Number.isFinite(lat) || lat < -90 || lat > 90)       return res.status(400).json({ error: 'Latitude must be between -90 and 90' });
  if (!Number.isFinite(lng) || lng < -180 || lng > 180)     return res.status(400).json({ error: 'Longitude must be between -180 and 180' });
  if (!Number.isFinite(radius) || radius < 10 || radius > 5000) return res.status(400).json({ error: 'Radius must be between 10 and 5000 metres' });
  const value = { lat, lng, radius };
  try {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('gps', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [value]
    );
    res.json(value);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── HELPERS ───────────────────────────────────────────────────────
// Convert DB rows (snake_case, BIGINT ids as strings) to the camelCase
// shape the frontend uses, with numeric ids so === comparisons work.

function dbToRecord(row) {
  return {
    id:      Number(row.id),
    name:    row.name,
    empId:   row.emp_id,
    type:    row.type,
    date:    row.date,
    dateKey: row.date_key,
    time:    row.time,
    day:     row.day,
    iso:     row.iso,
    status:  row.status,
  };
}

function dbToEmp(row) {
  return {
    id:      Number(row.id),
    name:    row.name,
    dept:    row.dept,
    empId:   row.emp_id,
    pinRaw:  row.pin_raw,   // admin-only route; shown via Show/Copy PIN
    photo:   row.photo,
    added:   row.added,
  };
}

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`✅  Softmasters server running → http://localhost:${PORT}`);
  console.log(`🔒  Network guard active — allowed ranges: ${ALLOWED_NETWORKS.join(', ')}`);
});
