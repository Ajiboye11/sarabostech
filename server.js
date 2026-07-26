require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const webpush = require('web-push');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const REQUIRED_ENV = ['DB_HOST', 'DB_USER', 'DB_NAME', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.warn(`[startup] Missing env vars: ${missing.join(', ')} — copy .env.example to .env and fill these in.`);
}
const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = process.env.TOKEN_TTL_HOURS ? `${Number(process.env.TOKEN_TTL_HOURS)}h` : '12h';
const PORT = process.env.PORT || 8787;

// Only this email can ever hold Super Admin — enforced below at the actual
// database-write level (validateSuperAdminIntegrity), not just at signup, so
// it can't be bypassed by a direct API call or a clever admin-token write.
const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || 'ajiboyeahmad01@gmail.com').trim().toLowerCase();

const app = express();
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true }));
app.use(express.json({ limit: '20mb' }));

// Real email delivery (verification codes, PIN-change confirmations,
// notifications, chat alerts) — relays through cPanel SMTP via nodemailer.
// See EMAIL_SETUP.md for the SMTP_* environment variables this needs.
const registerEmailRoute = require('./email-server-addon');
registerEmailRoute(app);

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

const pushEnabled = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (pushEnabled) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn('[startup] VAPID keys not set — push-to-closed-browser will be disabled until you add them (npx web-push generate-vapid-keys).');
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const REALTIME_CHANNEL = 'sarab-os-sync';
// One shared channel connection reused for every broadcast, rather than opening a new one per write.
const realtimeChannel = supabase.channel(REALTIME_CHANNEL);
realtimeChannel.subscribe();

async function broadcastUpdate(key, value) {
  try {
    await realtimeChannel.send({ type: 'broadcast', event: 'key-updated', payload: { key, value } });
  } catch (e) {
    console.error('[realtime] broadcast failed', e.message);
  }
}

/* ==================================================================
   STORAGE HELPERS
   Shared by both the generic /api/storage/:key route and the auth
   endpoints below (bootstrap/login need to read & write 'employees'
   directly, without going through an HTTP round trip to themselves).
   Every write also drops a row into app_storage_history — a cheap,
   append-only audit/recovery trail. Run the migration in
   backend/migrations/002_add_storage_history.sql once before deploying
   this file.
   ================================================================== */
async function readStorageValue(key) {
  const [rows] = await pool.query('SELECT value FROM app_storage WHERE storage_key=?', [key]);
  if (!rows.length) return null;
  try { return JSON.parse(rows[0].value); } catch (e) { return null; }
}
async function writeStorageValue(key, value) {
  const json = JSON.stringify(value);
  await pool.query(
    'INSERT INTO app_storage (storage_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)',
    [key, json]
  );
  // Best-effort history snapshot for recovery — never blocks the write, never
  // throws past this point, so a history-table hiccup can't break a save.
  pool.query(
    'INSERT INTO app_storage_history (storage_key, value, changed_at) VALUES (?, ?, NOW())',
    [key, json]
  ).catch((e) => console.error('[history] snapshot failed (non-fatal)', e.message));
}

/* Never let plaintext PINs land in the database, no matter which code path
   (bootstrap, admin edit, registration, forgot-PIN) produced the write. Any
   employee object carrying a plain `pin` gets it hashed into `pinHash` and
   the plaintext dropped, right here at the storage layer. */
/* Only SUPER_ADMIN_EMAIL may ever hold Super Admin. Checked on every write
   to 'employees', regardless of who's writing (including admin tokens) —
   this is what makes it actually tamper-proof rather than just a rule the
   frontend happens to follow. */
function validateSuperAdminIntegrity(employees) {
  if (!Array.isArray(employees)) return true;
  return employees.every((e) => !e.isSuperAdmin || (e.email || '').trim().toLowerCase() === SUPER_ADMIN_EMAIL);
}

// Sends email by calling this server's own existing /api/send-email route
// (registered by email-server-addon.js above) rather than assuming its
// internal function signatures. Requires Node 18+ for global fetch.
async function sendEmailInternal(payload) {
  try {
    await fetch(`http://localhost:${PORT}/api/send-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error('[verify-email] send failed (non-fatal to the caller, but they will not receive a code)', e.message);
  }
}
function makeVerificationCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
function makeSessionId() { return 'bs_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }

async function sanitizeEmployeePins(employees) {
  if (!Array.isArray(employees)) return employees;
  for (const e of employees) {
    if (e && e.pin !== undefined && e.pin !== null && String(e.pin).length) {
      e.pinHash = await bcrypt.hash(String(e.pin), 10);
      delete e.pin;
    }
  }
  return employees;
}

/* ==================================================================
   AUTH — per-user tokens issued at login, replacing the old model
   where the client fetched the whole 'employees' list unauthenticated
   and compared PINs itself in the browser.
   ================================================================== */
function signToken(emp, remember) {
  return jwt.sign(
    { sub: emp.id, name: emp.name, isAdmin: !!emp.isAdmin, isSuperAdmin: !!emp.isSuperAdmin },
    JWT_SECRET,
    { expiresIn: remember ? (process.env.REMEMBER_TOKEN_TTL_DAYS ? `${Number(process.env.REMEMBER_TOKEN_TTL_DAYS)}d` : '30d') : TOKEN_TTL }
  );
}
function safeEmployee(e) {
  const { pin, pinHash, ...rest } = e;
  return rest;
}

// Pre-login: tells the client whether a company exists yet WITHOUT exposing
// the employee list itself. Used by the frontend's boot check instead of
// reading the full 'employees' key before anyone is signed in.
app.get('/api/auth/company-status', async (req, res) => {
  try {
    const employees = (await readStorageValue('employees')) || [];
    res.json({ hasCompany: employees.length > 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'status check failed' });
  }
});

// Pending bootstrap verifications: sessionId -> { name, pin, title, email, code, expires }.
// In-memory is fine here — codes are short-lived (10 min) and low-stakes to
// lose on a restart (the person just requests a new one); nothing about the
// company itself is created until the code is confirmed.
const pendingBootstraps = new Map();

// Step 1: request a code. Hard-blocked (403) unless the email matches
// SUPER_ADMIN_EMAIL exactly — nobody else can even start this process,
// regardless of what name/PIN they submit.
app.post('/api/auth/bootstrap/request-code', async (req, res) => {
  if (!JWT_SECRET) return res.status(500).json({ error: 'server not configured (JWT_SECRET missing)' });
  const { name, pin, title, email } = req.body || {};
  if (!name || !pin || !email) return res.status(400).json({ error: 'name, pin, and email are required' });
  if (String(email).trim().toLowerCase() !== SUPER_ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Only the designated owner email can set up this company.' });
  }
  try {
    const existing = (await readStorageValue('employees')) || [];
    if (existing.length > 0) {
      return res.status(409).json({ error: 'A company already exists — bootstrap can only run once.' });
    }
    const sessionId = makeSessionId();
    const code = makeVerificationCode();
    const expires = Date.now() + 10 * 60 * 1000;
    pendingBootstraps.set(sessionId, { name: String(name).trim(), pin: String(pin), title, email: SUPER_ADMIN_EMAIL, code, expires });
    await sendEmailInternal({ type: 'verify', to: SUPER_ADMIN_EMAIL, name: String(name).trim(), code, expiresAt: expires, reason: 'set up your company as Super Admin' });
    res.json({ sessionId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'could not start verification' });
  }
});

app.post('/api/auth/bootstrap/resend-code', async (req, res) => {
  const { sessionId } = req.body || {};
  const draft = pendingBootstraps.get(sessionId);
  if (!draft) return res.status(400).json({ error: 'This verification session is invalid or expired. Start again.' });
  draft.code = makeVerificationCode();
  draft.expires = Date.now() + 10 * 60 * 1000;
  await sendEmailInternal({ type: 'verify', to: draft.email, name: draft.name, code: draft.code, expiresAt: draft.expires, reason: 'set up your company as Super Admin' });
  res.json({ ok: true });
});

// Step 2: confirm the code actually sent to SUPER_ADMIN_EMAIL. Only now does
// the company and its one Super Admin actually get created.
app.post('/api/auth/bootstrap/confirm', async (req, res) => {
  const { sessionId, code } = req.body || {};
  const draft = pendingBootstraps.get(sessionId);
  if (!draft) return res.status(400).json({ error: 'This verification session is invalid or already used. Start again.' });
  if (Date.now() > draft.expires) { pendingBootstraps.delete(sessionId); return res.status(400).json({ error: 'That code has expired. Start again.' }); }
  if (String(code || '').trim() !== draft.code) return res.status(401).json({ error: "That code doesn't match." });
  try {
    const existing = (await readStorageValue('employees')) || [];
    if (existing.length > 0) { pendingBootstraps.delete(sessionId); return res.status(409).json({ error: 'A company already exists.' }); }
    const pinHash = await bcrypt.hash(draft.pin, 10);
    const emp = {
      id: 'emp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      name: draft.name, pinHash, email: draft.email, emailVerified: true, title: draft.title || 'Founder',
      departmentId: null, employmentType: 'Founder', roles: [], isAdmin: true, isSuperAdmin: true,
      active: true, joinedDate: new Date().toISOString().slice(0, 10),
    };
    if (!validateSuperAdminIntegrity([emp])) return res.status(500).json({ error: 'internal integrity check failed' }); // should be unreachable — belt and suspenders
    await writeStorageValue('employees', [emp]);
    await writeStorageValue('companyInitialized', true);
    pendingBootstraps.delete(sessionId);
    const token = signToken(emp, true);
    res.json({ token, employee: safeEmployee(emp) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'bootstrap failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  if (!JWT_SECRET) return res.status(500).json({ error: 'server not configured (JWT_SECRET missing)' });
  const { name, pin, remember } = req.body || {};
  if (!name || !pin) return res.status(400).json({ error: 'name and pin are required' });
  try {
    const employees = (await readStorageValue('employees')) || [];
    const match = employees.find((e) => (e.name || '').toLowerCase() === String(name).trim().toLowerCase());
    if (!match) return res.status(401).json({ error: 'No match. Check name and PIN.' });

    let ok = false;
    if (match.pinHash) {
      ok = await bcrypt.compare(String(pin), match.pinHash);
    } else if (match.pin !== undefined) {
      // Legacy plaintext PIN from before this migration — verify once, then
      // upgrade this employee to a hash and drop the plaintext value for good.
      ok = String(match.pin) === String(pin);
      if (ok) {
        match.pinHash = await bcrypt.hash(String(pin), 10);
        delete match.pin;
        await writeStorageValue('employees', employees);
      }
    }
    if (!ok) return res.status(401).json({ error: 'No match. Check name and PIN.' });
    if (match.pendingApproval) return res.status(403).json({ error: 'Your account is awaiting admin approval.' });
    if (match.active === false) return res.status(403).json({ error: 'This account is marked inactive. Contact an admin.' });

    const token = signToken(match, !!remember);
    res.json({ token, employee: safeEmployee(match) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'login failed' });
  }
});

function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing bearer token — please sign in again' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid or expired token — please sign in again' });
  }
}
// Like requireAuth, but lets the request through with req.user=null instead
// of rejecting — used only on the two routes that legitimately have
// legitimate anonymous callers (registration, forgot-PIN reset), where the
// payload shape itself (checked below) is what's actually validated.
function optionalAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) { req.user = null; return next(); }
  try { req.user = jwt.verify(token, JWT_SECRET); } catch (e) { req.user = null; }
  next();
}

// Keys only an admin/super-admin token may write to — HR, payroll, and
// company-configuration data. ('employees' is handled separately below,
// since registration and forgot-PIN both need a narrow anonymous carve-out.)
const ADMIN_ONLY_WRITE_KEYS = new Set([
  'departments', 'settings', 'automations', 'agreements', 'agreementSignatures',
  'payrollRuns', 'budgets', 'invoices', 'companyInitialized',
]);

/* Registration and "forgot PIN" both need to write to 'employees' before
   the person has ever logged in — there's no token to check yet. Rather
   than trust any unauthenticated write to that key, this validates the
   *shape* of the change itself, so the only two things an anonymous caller
   can ever do to the employee list are:
     (a) append exactly one new, unprivileged, pending-approval employee
         (a registration request), or
     (b) change exactly one existing employee's PIN and nothing else
         (a forgot-PIN reset).
   Anything else — editing roles, activating/deactivating someone, removing
   an employee, touching more than one record, replacing the whole list —
   is rejected unless the caller has an admin/super-admin token. */
function isUnprivilegedPendingSignup(e) {
  return !!e && e.pendingApproval === true && e.active === false && !e.isAdmin && !e.isSuperAdmin;
}
function anonymousEmployeeWriteIsAllowed(oldArr, newArr, callerSub) {
  if (!Array.isArray(oldArr) || !Array.isArray(newArr)) return false;
  const oldById = new Map(oldArr.map((e) => [e.id, e]));
  const newById = new Map(newArr.map((e) => [e.id, e]));

  if (newArr.length === oldArr.length + 1) {
    // Case (a): registration — every existing record must be byte-identical,
    // and the one new record must look like an unprivileged pending signup.
    for (const [id, oldE] of oldById) {
      const newE = newById.get(id);
      if (!newE || JSON.stringify(oldE) !== JSON.stringify(newE)) return false;
    }
    const added = newArr.filter((e) => !oldById.has(e.id));
    return added.length === 1 && isUnprivilegedPendingSignup(added[0]);
  }

  if (newArr.length === oldArr.length) {
    // Case (b): a PIN-only change to exactly one existing record — either
    // the anonymous forgot-PIN flow, or a logged-in non-admin changing their
    // own PIN from profile settings. If the caller IS logged in (has a
    // token), they may only ever touch their OWN record this way — a
    // logged-in non-admin can never modify a coworker's PIN.
    let changedCount = 0, changedId = null;
    for (const [id, oldE] of oldById) {
      const newE = newById.get(id);
      if (!newE) return false; // someone got removed — not allowed anonymously
      if (JSON.stringify(oldE) === JSON.stringify(newE)) continue;
      changedCount++;
      changedId = id;
      if (changedCount > 1) return false;
      const oldRest = { ...oldE }; delete oldRest.pin; delete oldRest.pinHash;
      const newRest = { ...newE }; delete newRest.pin; delete newRest.pinHash;
      if (JSON.stringify(oldRest) !== JSON.stringify(newRest)) return false; // something besides the PIN changed
    }
    if (changedCount !== 1) return false;
    if (callerSub && changedId !== callerSub) return false; // logged in as someone else — not allowed
    return true;
  }

  return false; // any other size change (removals, bulk edits) needs an admin token
}

/* ---------------- Generic key/value storage (mirrors the app's loadKey/saveKey) ---------------- */

app.get('/api/storage', async (req, res) => {
  try {
    const prefix = req.query.prefix || '';
    const [rows] = await pool.query('SELECT storage_key FROM app_storage WHERE storage_key LIKE ?', [`${prefix}%`]);
    res.json({ keys: rows.map((r) => r.storage_key) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'list failed' });
  }
});

// Reads stay open (unauthenticated) for now — locking these down would also
// require rebuilding registration/forgot-PIN as dedicated backend endpoints
// (they currently look up candidates from the client-side employee list).
// The important fix already applied: that list no longer contains anyone's
// actual PIN (see sanitizeEmployeePins), and every WRITE below now requires
// either a real per-user token or one of the two narrowly-validated
// anonymous shapes. That's what stopped your data from being wipeable by
// anyone who finds this URL.
app.get('/api/storage/:key', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT value FROM app_storage WHERE storage_key=?', [req.params.key]);
    if (!rows.length) return res.json({ key: req.params.key, value: null });
    let value = JSON.parse(rows[0].value);
    if (req.params.key === 'employees' && Array.isArray(value)) {
      // PINs are short numeric codes — even a bcrypt hash of one is
      // brute-forceable in well under a second if it ever leaves the
      // server, so neither the plaintext nor the hash is included here.
      value = value.map(({ pin, pinHash, ...rest }) => rest);
    }
    res.json({ key: req.params.key, value });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'read failed' });
  }
});

app.post('/api/storage/:key', optionalAuth, async (req, res) => {
  const key = req.params.key;
  let value = req.body ? req.body.value : undefined;
  const force = !!(req.body && req.body.force);
  if (value === undefined) return res.status(400).json({ error: 'body.value is required' });

  const isAdminToken = !!(req.user && (req.user.isAdmin || req.user.isSuperAdmin));

  try {
    if (key === 'employees') {
      if (!isAdminToken) {
        const current = (await readStorageValue('employees')) || [];
        if (!anonymousEmployeeWriteIsAllowed(current, value, req.user ? req.user.sub : null)) {
          return res.status(403).json({ error: 'Sign in as an admin to make this change to the employee list.' });
        }
      }
      if (!validateSuperAdminIntegrity(value)) {
        return res.status(403).json({ error: `Only ${SUPER_ADMIN_EMAIL} may hold Super Admin.` });
      }
      value = await sanitizeEmployeePins(value); // never persist a plaintext PIN, whoever wrote it
    } else if (ADMIN_ONLY_WRITE_KEYS.has(key)) {
      if (!isAdminToken) return res.status(403).json({ error: `Only an admin can write "${key}".` });
    } else {
      if (!req.user) return res.status(401).json({ error: 'Please sign in to save changes.' });
    }

    // Anti-wipe guard — refuse to overwrite a non-empty array with an empty
    // one unless explicitly forced. This is exactly the bug class that wiped
    // the employee list before: a transient read failure produced `[]`
    // client-side, and an unconditional save persisted it.
    if (Array.isArray(value) && value.length === 0 && !force) {
      const existing = await readStorageValue(key);
      if (Array.isArray(existing) && existing.length > 0) {
        console.warn(`[anti-wipe] blocked attempt to overwrite non-empty "${key}" (${existing.length} items) with an empty array.`);
        return res.status(409).json({
          error: `Refusing to overwrite non-empty "${key}" with an empty array — pass {"force":true} if this is intentional.`,
          currentLength: existing.length,
        });
      }
    }

    await writeStorageValue(key, value);
    res.json({ ok: true });
    broadcastUpdate(key, value);
    if (key === 'notifications' || key === 'announcements') {
      handlePushForNewItems(key, value).catch((e) => console.error('[push]', e.message));
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'write failed' });
  }
});

app.delete('/api/storage/:key', requireAuth, async (req, res) => {
  const key = req.params.key;
  const isAdminToken = !!(req.user.isAdmin || req.user.isSuperAdmin);
  if ((key === 'employees' || ADMIN_ONLY_WRITE_KEYS.has(key)) && !isAdminToken) {
    return res.status(403).json({ error: `Only an admin can delete "${key}".` });
  }
  try {
    await pool.query('DELETE FROM app_storage WHERE storage_key=?', [key]);
    res.json({ ok: true });
    broadcastUpdate(key, null);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'delete failed' });
  }
});

/* ---------------- Web Push: subscriptions + send-on-new-item ---------------- */

app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null, enabled: pushEnabled });
});

app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  const { employeeId, subscription } = req.body || {};
  if (!employeeId || !subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'employeeId and subscription are required' });
  }
  if (employeeId !== req.user.sub) {
    return res.status(403).json({ error: 'you can only subscribe for your own employeeId' });
  }
  try {
    await pool.query(
      `INSERT INTO push_subscriptions (employee_id, endpoint, subscription_json) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE employee_id=VALUES(employee_id), subscription_json=VALUES(subscription_json)`,
      [employeeId, subscription.endpoint, JSON.stringify(subscription)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'subscribe failed' });
  }
});

app.post('/api/push/unsubscribe', requireAuth, async (req, res) => {
  const { endpoint } = req.body || {};
  try {
    if (endpoint) await pool.query('DELETE FROM push_subscriptions WHERE endpoint=?', [endpoint]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'unsubscribe failed' });
  }
});

// In-memory de-dupe of ids we've already pushed for, primed from DB at boot.
// Good enough for a single-instance server; move to a DB flag column if you scale to multiple instances.
const lastSeen = { notifications: new Set(), announcements: new Set() };
async function primeLastSeen() {
  for (const key of Object.keys(lastSeen)) {
    try {
      const [rows] = await pool.query('SELECT value FROM app_storage WHERE storage_key=?', [key]);
      if (rows.length) JSON.parse(rows[0].value).forEach((item) => item && lastSeen[key].add(item.id));
    } catch (e) { /* table may not exist yet on first run — fine, nothing to prime */ }
  }
}
primeLastSeen();

async function allEmployeeIds() {
  const [rows] = await pool.query('SELECT value FROM app_storage WHERE storage_key=?', ['employees']);
  if (!rows.length) return [];
  try { return JSON.parse(rows[0].value).map((e) => e.id); } catch (e) { return []; }
}

// Mirrors the client's notificationVisibleTo / announcementVisibleTo audience rules.
async function recipientsFor(key, item) {
  if (key === 'announcements' && item.active === false) return [];
  if (item.audience === 'all') return allEmployeeIds();
  return item.userIds || [];
}

async function handlePushForNewItems(key, arr) {
  if (!pushEnabled || !Array.isArray(arr)) return;
  const seen = lastSeen[key];
  const fresh = arr.filter((item) => item && item.id && !seen.has(item.id));
  fresh.forEach((item) => seen.add(item.id));
  if (!fresh.length) return;

  for (const item of fresh) {
    const recipientIds = (await recipientsFor(key, item)).filter((id) => id !== item.createdBy);
    if (!recipientIds.length) continue;
    const placeholders = recipientIds.map(() => '?').join(',');
    const [subs] = await pool.query(
      `SELECT subscription_json FROM push_subscriptions WHERE employee_id IN (${placeholders})`,
      recipientIds
    );
    if (!subs.length) continue;
    const payload = JSON.stringify({
      title: item.title || 'New notification',
      body: item.message || item.body || '',
    });
    await Promise.all(
      subs.map((row) => {
        const sub = JSON.parse(row.subscription_json);
        return webpush.sendNotification(sub, payload).catch((err) => {
          // 404/410 = the subscription is dead (user revoked permission, uninstalled, etc) — clean it up.
          if (err.statusCode === 404 || err.statusCode === 410) {
            return pool.query('DELETE FROM push_subscriptions WHERE endpoint=?', [sub.endpoint]);
          }
          console.error('[push] send failed', err.statusCode, err.message);
        });
      })
    );
  }
}

/* ==================================================================
   BACKUP / RESTORE — powers restore.html. Admin-only: lets an admin see
   past snapshots of any key (from app_storage_history, written on every
   save — see writeStorageValue) and roll a key back to an earlier version.
   ================================================================== */
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!(req.user.isAdmin || req.user.isSuperAdmin)) {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    next();
  });
}

// List recent snapshots for a key (most recent first). Returns previews,
// not full values, so this stays light even for big keys like chatMessages.
app.get('/api/storage-history/:key', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const [rows] = await pool.query(
      'SELECT id, changed_at, CHAR_LENGTH(value) AS byte_len FROM app_storage_history WHERE storage_key=? ORDER BY changed_at DESC, id DESC LIMIT ?',
      [req.params.key, limit]
    );
    const snapshots = rows.map((r) => ({ id: r.id, changedAt: r.changed_at, byteLength: r.byte_len }));
    res.json({ key: req.params.key, snapshots });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'history list failed' });
  }
});

// Full value of one specific snapshot, for preview before restoring.
app.get('/api/storage-history/:key/:id', requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT value, changed_at FROM app_storage_history WHERE storage_key=? AND id=?',
      [req.params.key, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'snapshot not found' });
    let value;
    try { value = JSON.parse(rows[0].value); } catch (e) { value = rows[0].value; }
    if (req.params.key === 'employees' && Array.isArray(value)) {
      value = value.map(({ pin, pinHash, ...rest }) => rest); // never expose PINs, even in a historical snapshot
    }
    res.json({ key: req.params.key, changedAt: rows[0].changed_at, value });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'snapshot read failed' });
  }
});

// Roll a key back to a specific past snapshot. This is a deliberate,
// admin-initiated overwrite, so it bypasses the anti-wipe guard on purpose
// (restoring TO an empty array is legitimate if that's genuinely what an
// earlier snapshot looked like) — but it goes through writeStorageValue,
// so the restore itself is also logged as a new history entry.
app.post('/api/storage-history/:key/:id/restore', requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT value FROM app_storage_history WHERE storage_key=? AND id=?',
      [req.params.key, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'snapshot not found' });
    let value = JSON.parse(rows[0].value);
    if (req.params.key === 'employees') {
      value = await sanitizeEmployeePins(value);
      if (!validateSuperAdminIntegrity(value)) {
        return res.status(403).json({ error: `Refusing to restore: this snapshot contains a Super Admin other than ${SUPER_ADMIN_EMAIL}.` });
      }
    }
    await writeStorageValue(req.params.key, value);
    broadcastUpdate(req.params.key, value);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'restore failed' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, push: pushEnabled, auth: !!JWT_SECRET }));

app.listen(PORT, () => console.log(`Sarab OS backend listening on :${PORT}`));
