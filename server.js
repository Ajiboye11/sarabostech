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
const APP_URL = process.env.APP_URL || '';

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
   (bootstrap, admin edit, forgot-PIN) produced the write. Any employee
   object carrying a plain `pin` gets it hashed into `pinHash` and the
   plaintext dropped, right here at the storage layer. */
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
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appUrl: APP_URL, ...payload }),
    });
  } catch (e) {
    console.error('[verify-email] send failed (non-fatal to the caller, but they will not receive a code)', e.message);
  }
}

/* Fires the onboarding "welcome" email for one employee — install-the-PWA
   steps, their role, and the reminder that a signed agreement is required.
   Called (a) right after an admin directly adds someone via /api/employees,
   since they're active immediately, and (b) from the generic employees
   write route below, the moment someone is reactivated after being
   deactivated. Silently does nothing if there's no email on file. */
async function sendWelcomeEmail(emp) {
  if (!emp || !emp.email) return;
  await sendEmailInternal({
    type: 'welcome',
    to: emp.email,
    name: emp.name,
    title: emp.title,
    roles: emp.roles,
    isAdmin: !!emp.isAdmin,
  });
}
/* Fires the moment an employee is deactivated — from the generic employees
   write route below. Confirms the deactivation and tells them to contact
   their admin. Silently does nothing if there's no email on file. */
async function sendDeactivatedEmail(emp) {
  if (!emp || !emp.email) return;
  await sendEmailInternal({ type: 'deactivated', to: emp.email, name: emp.name });
}
function makeVerificationCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
function makeSessionId() { return 'bs_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
function makeEmployeeId() { return 'emp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

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

/* Strips a plaintext `pin` and/or `pinHash` off every response the client
   ever sees for 'employees' — used both by the plain storage read route and
   by every broadcastUpdate('employees', ...) call below, so the realtime
   channel can never leak a credential either. */
function stripCreds(employees) {
  if (!Array.isArray(employees)) return employees;
  return employees.map(({ pin, pinHash, ...rest }) => rest);
}

/* Only admins/super-admins, or an employee who holds the Finance role, may
   ever see salary figures for anyone but themselves. stripCreds() already
   removes pin/pinHash for every caller; this removes `salary` for everyone
   EXCEPT those privileged callers, so a non-Finance employee reading the
   shared 'employees' list (needed for names/roles/departments across the
   app) never receives payroll data alongside it. Applied on every read AND
   on every realtime broadcast — a broadcast goes out on one shared channel
   with no per-recipient targeting, so it's stripped unconditionally there
   rather than attempting (impossible) per-viewer redaction on a single
   payload. */
function redactSalary(employees, viewerId, isAdminToken) {
  if (!Array.isArray(employees)) return employees;
  if (isAdminToken) return employees;
  const me = employees.find((e) => e.id === viewerId);
  const isFinance = !!(me && Array.isArray(me.roles) && me.roles.includes('Finance'));
  if (isFinance) return employees;
  return employees.map(({ salary, ...rest }) => rest);
}
// Broadcast-only variant: no viewer to check, so salary is always stripped.
function stripSalaryForBroadcast(employees) {
  if (!Array.isArray(employees)) return employees;
  return employees.map(({ salary, ...rest }) => rest);
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

/* Verifies a submitted PIN against a stored employee record. Transparently
   upgrades a legacy plaintext `pin` to a `pinHash` the first time it's used
   successfully — same behavior as before, just shared by every code path
   that needs to check a PIN (login, PIN change, forgot-PIN), instead of
   being duplicated (or skipped) in each one. Caller is responsible for
   persisting `employees` afterward if this returns true and had to upgrade. */
async function verifyEmployeePin(emp, submittedPin) {
  if (emp.pinHash) return bcrypt.compare(String(submittedPin), emp.pinHash);
  if (emp.pin !== undefined) {
    const ok = String(emp.pin) === String(submittedPin);
    if (ok) { emp.pinHash = await bcrypt.hash(String(submittedPin), 10); delete emp.pin; }
    return ok;
  }
  return false;
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
      id: makeEmployeeId(),
      name: draft.name, pinHash, email: draft.email, emailVerified: true, title: draft.title || 'Founder',
      departmentId: null, employmentType: 'Founder', roles: [], isAdmin: true, isSuperAdmin: true,
      active: true, joinedDate: new Date().toISOString().slice(0, 10),
    };
    if (!validateSuperAdminIntegrity([emp])) return res.status(500).json({ error: 'internal integrity check failed' }); // should be unreachable — belt and suspenders
    await writeStorageValue('employees', [emp]);
    await writeStorageValue('companyInitialized', true);
    pendingBootstraps.delete(sessionId);
    const token = signToken(emp, true);
    sendWelcomeEmail(emp).catch((e) => console.error('[welcome-email]', e.message));
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

    const wasLegacyPlaintext = match.pinHash === undefined && match.pin !== undefined;
    const ok = await verifyEmployeePin(match, pin);
    if (ok && wasLegacyPlaintext) await writeStorageValue('employees', employees); // persist the upgrade to a hash

    if (!ok) return res.status(401).json({ error: 'No match. Check name and PIN.' });
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
// of rejecting — used only on the generic storage write route, which has
// one legitimate anonymous caller (forgot-PIN reset), where the payload
// shape itself (checked below) is what's actually validated.
function optionalAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) { req.user = null; return next(); }
  try { req.user = jwt.verify(token, JWT_SECRET); } catch (e) { req.user = null; }
  next();
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!(req.user.isAdmin || req.user.isSuperAdmin)) {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    next();
  });
}

// Keys only an admin/super-admin token may write to — HR, payroll, and
// company-configuration data. ('employees', 'agreementSignatures',
// 'documents', 'docFolders', and 'peopleCases' are handled separately below
// — each needs its own narrow non-admin carve-out: an ordinary employee can
// sign their own agreement, upload/manage their own files, open a project's
// folder for the first time, and request/track their own leave — without
// ever touching anyone else's records.)
const ADMIN_ONLY_WRITE_KEYS = new Set([
  'departments', 'settings', 'automations', 'agreements',
  'payrollRuns', 'budgets', 'invoices', 'companyInitialized',
]);

/* The "forgot PIN" flow needs to write to 'employees' before the person has
   ever logged in — there's no token to check yet. And several profile
   self-service actions (verifying an email, uploading an avatar, toggling a
   notification preference, dismissing the one-time onboarding modal) are
   normal things for a logged-in non-admin to do to their OWN record, without
   needing an admin token. Rather than trust any write to this key though,
   this validates the *shape* of the change: exactly one existing record may
   change, and only in fields that particular caller is allowed to touch —
   see SELF_SERVICE_EMPLOYEE_FIELDS below. Anything else — adding someone,
   editing roles/title/department, activating/deactivating, removing an
   employee, touching more than one record, granting admin, replacing the
   whole list — is rejected unless the caller has an admin/super-admin
   token. */
// Fields an ordinary (non-admin, logged-in) employee may change on their OWN
// record via this generic route. Everything else — name, title, roles,
// department, manager, employment type, active flag, isAdmin/isSuperAdmin,
// joined date, id — requires an admin token, even for your own account, so a
// compromised non-admin session can never self-promote or falsify HR data.
const SELF_SERVICE_EMPLOYEE_FIELDS = new Set([
  'pin', 'pinHash', 'email', 'emailVerified', 'avatarDataUrl', 'notifPrefs', 'needsOnboarding',
]);
function anonymousEmployeeWriteIsAllowed(oldArr, newArr, callerSub) {
  if (!Array.isArray(oldArr) || !Array.isArray(newArr)) return false;
  const oldById = new Map(oldArr.map((e) => [e.id, e]));
  const newById = new Map(newArr.map((e) => [e.id, e]));

  if (newArr.length !== oldArr.length) return false; // no additions/removals allowed this way

  // Exactly one existing record may change, and — for a logged-in caller —
  // only in fields on the SELF_SERVICE_EMPLOYEE_FIELDS allowlist; a fully
  // anonymous caller (no token, i.e. forgot-PIN) may only ever touch the PIN.
  let changedCount = 0, changedId = null;
  for (const [id, oldE] of oldById) {
    const newE = newById.get(id);
    if (!newE) return false; // someone got removed — not allowed anonymously
    if (JSON.stringify(oldE) === JSON.stringify(newE)) continue;
    changedCount++;
    changedId = id;
    if (changedCount > 1) return false;

    // Check every field that actually differs (covers additions, removals,
    // and value changes alike) against what this caller is allowed to touch.
    const allKeys = new Set([...Object.keys(oldE), ...Object.keys(newE)]);
    for (const k of allKeys) {
      if (JSON.stringify(oldE[k]) === JSON.stringify(newE[k])) continue;
      if (!callerSub) { if (k !== 'pin' && k !== 'pinHash') return false; continue; } // fully anonymous (forgot-PIN): PIN only
      if (!SELF_SERVICE_EMPLOYEE_FIELDS.has(k)) return false; // logged-in non-admin: allowlisted self-service fields only
    }
  }
  if (changedCount !== 1) return false;
  if (callerSub && changedId !== callerSub) return false; // logged in as someone else — not allowed
  return true;
}

/* A non-admin employee needs to be able to sign an agreement — i.e. write to
   'agreementSignatures' — but must never be able to touch anyone else's
   signature (edit it, delete it, or forge one under a coworker's
   employeeId). This mirrors anonymousEmployeeWriteIsAllowed's shape-based
   approach: the ONLY change a non-admin caller may ever make to this key is
   appending exactly one new signature record whose employeeId is their own. */
function signatureWriteIsAllowed(oldArr, newArr, callerSub) {
  if (!callerSub) return false; // must be logged in to sign anything
  if (!Array.isArray(oldArr)) oldArr = [];
  if (!Array.isArray(newArr)) return false;

  if (newArr.length !== oldArr.length + 1) return false; // exactly one addition, no edits/removals

  const oldIds = new Set(oldArr.map((s) => s && s.id));
  let added = null;
  for (const sig of newArr) {
    if (sig && oldIds.has(sig.id)) continue; // an existing signature, untouched — fine
    if (added) return false; // more than one new record — not allowed
    added = sig;
  }
  if (!added) return false;

  // Every pre-existing signature must be byte-for-byte unchanged.
  const newById = new Map(newArr.map((s) => [s && s.id, s]));
  for (const old of oldArr) {
    const match = newById.get(old.id);
    if (!match || JSON.stringify(old) !== JSON.stringify(match)) return false;
  }

  return added.employeeId === callerSub; // can only ever sign as yourself
}

/* ==================================================================
   Project-membership helpers — mirror the frontend's projectTeamIds(p)
   exactly (teamIds + leadId), so the write-guards below enforce the same
   "who belongs to this project" boundary the client uses to decide what to
   show. Used by the 'documents'/'docFolders' guards further down. ---- */
function projectTeamIdsServer(p) {
  const ids = new Set(Array.isArray(p.teamIds) ? p.teamIds : []);
  if (p.leadId) ids.add(p.leadId);
  return ids;
}
function isOnProjectTeamServer(project, employeeId) {
  return !!(project && employeeId && (project.leadId === employeeId || projectTeamIdsServer(project).has(employeeId)));
}

/* ---- 'docFolders' write guard ----
   A project's Documents folder gets created lazily, client-side, the first
   time anyone on that project's team opens its Files tab (ensureProjectDocFolder)
   — so this key does need a non-admin carve-out. The ONLY thing a non-admin
   caller may ever do here is add exactly one new folder tied to a project
   they actually belong to. Editing or deleting any existing folder, or
   creating a folder that isn't linked to one of their own projects, requires
   an admin token. */
async function docFoldersWriteIsAllowed(oldArr, newArr, callerSub) {
  if (!callerSub) return false;
  if (!Array.isArray(oldArr)) oldArr = [];
  if (!Array.isArray(newArr)) return false;
  if (newArr.length !== oldArr.length + 1) return false; // exactly one addition, no edits/removals

  const oldIds = new Set(oldArr.map((f) => f && f.id));
  let added = null;
  for (const f of newArr) {
    if (f && oldIds.has(f.id)) continue;
    if (added) return false; // more than one new folder
    added = f;
  }
  if (!added) return false;

  const newById = new Map(newArr.map((f) => [f && f.id, f]));
  for (const old of oldArr) {
    const match = newById.get(old.id);
    if (!match || JSON.stringify(old) !== JSON.stringify(match)) return false; // every existing folder untouched
  }

  if (!added.projectId) return false; // non-admins can only ever auto-create PROJECT folders
  const projects = (await readStorageValue('projects')) || [];
  const p = projects.find((pr) => pr.id === added.projectId);
  return isOnProjectTeamServer(p, callerSub);
}

/* ---- 'documents' write guard ----
   In one save, a non-admin caller may:
   - add exactly one new document, uploaded as themselves, filed either
     unfiled / into a non-project folder, or into a project folder for a
     project they're actually on (mirrors canAddProjectFile); or
   - edit or delete a document they uploaded themselves, or one that lives in
     a project they lead (mirrors canManageDocument) — and if editing, may
     only move it into a folder they have the same access to; or
   - touch nothing else.
   Anything else — someone else's file in a project you don't lead, filing
   into a project you're not on, more than one change per save — requires an
   admin token. This is the actual enforcement of the "only the project team
   + lead can see/add to that folder" rule; the frontend's canAccessDocument
   only controls what's rendered, not what the API will accept. */
async function documentsWriteIsAllowed(oldArr, newArr, callerSub) {
  if (!callerSub) return false;
  if (!Array.isArray(oldArr)) oldArr = [];
  if (!Array.isArray(newArr)) return false;

  const folders = (await readStorageValue('docFolders')) || [];
  const folderById = new Map(folders.map((f) => [f.id, f]));
  const projects = (await readStorageValue('projects')) || [];
  const projectById = new Map(projects.map((p) => [p.id, p]));

  function folderAccessible(folderId) {
    const f = folderId ? folderById.get(folderId) : null;
    if (!f || !f.projectId) return true; // unfiled or a non-project folder — open to any logged-in employee
    return isOnProjectTeamServer(projectById.get(f.projectId), callerSub);
  }
  function canManage(doc) {
    if (!doc) return false;
    if (doc.uploadedBy === callerSub) return true;
    const f = doc.folderId ? folderById.get(doc.folderId) : null;
    const p = f && f.projectId ? projectById.get(f.projectId) : null;
    return !!(p && p.leadId === callerSub);
  }

  const oldById = new Map(oldArr.map((d) => [d.id, d]));
  const newById = new Map(newArr.map((d) => [d.id, d]));
  let changedCount = 0;

  for (const [id, oldD] of oldById) {
    const newD = newById.get(id);
    if (!newD) { // deletion
      if (!canManage(oldD)) return false;
      changedCount++;
      continue;
    }
    if (JSON.stringify(oldD) === JSON.stringify(newD)) continue;
    if (!canManage(oldD)) return false;
    if (newD.folderId !== oldD.folderId && !folderAccessible(newD.folderId)) return false;
    changedCount++;
  }
  for (const [id, newD] of newById) {
    if (oldById.has(id)) continue; // addition
    if (newD.uploadedBy !== callerSub) return false; // must upload as yourself
    if (!folderAccessible(newD.folderId)) return false; // and only where you actually have access
    changedCount++;
  }
  return changedCount <= 1;
}

/* ---- 'peopleCases' write guard ----
   Anyone may add exactly one new case for THEMSELVES (a leave/escalation/
   dispute request) or append a note to their own case. Changing a case's
   status, or touching anyone else's case at all, is reserved for the Super
   Admin (any role) or an Admin who also holds the HR role — mirrors
   isAdminHR() on the frontend. The JWT only carries isAdmin/isSuperAdmin,
   not roles, so an admin caller's HR role is looked up fresh from the
   current 'employees' record rather than trusted from the client. */
async function callerIsAdminHR(callerSub, isSuperAdminTok, isAdminTok) {
  if (isSuperAdminTok) return true;
  if (!isAdminTok) return false;
  const employees = (await readStorageValue('employees')) || [];
  const me = employees.find((e) => e.id === callerSub);
  return !!(me && Array.isArray(me.roles) && me.roles.includes('HR'));
}
async function peopleCasesWriteIsAllowed(oldArr, newArr, callerSub, isSuperAdminTok, isAdminTok) {
  if (!callerSub) return false;
  if (!Array.isArray(oldArr)) oldArr = [];
  if (!Array.isArray(newArr)) return false;
  if (await callerIsAdminHR(callerSub, isSuperAdminTok, isAdminTok)) return true; // full triage access, any case

  if (newArr.length < oldArr.length) return false; // a plain employee can never delete a case
  const oldById = new Map(oldArr.map((c) => [c.id, c]));
  const newById = new Map(newArr.map((c) => [c.id, c]));
  let changedCount = 0;

  for (const [id, oldC] of oldById) {
    const newC = newById.get(id);
    if (!newC) return false; // deletion — HR/Super Admin only
    if (JSON.stringify(oldC) === JSON.stringify(newC)) continue;
    if (oldC.employeeId !== callerSub) return false; // not your case
    if (oldC.status !== newC.status) return false; // only HR/Super Admin can change status
    changedCount++;
  }
  let added = 0;
  for (const [id, newC] of newById) {
    if (oldById.has(id)) continue;
    if (newC.employeeId !== callerSub) return false; // can only request a case for yourself
    added++;
  }
  return (changedCount + added) <= 1;
}

/* ==================================================================
   Dedicated single-record credential endpoints.

   The client's copy of 'employees' (from GET /api/storage/employees)
   NEVER contains pin or pinHash for ANY employee — that's stripped on
   every read, on purpose, so a credential can't leak over the wire.
   That means any code path that edits an employee's non-credential
   fields (name, title, role, active flag, etc.) and then re-saves the
   *entire* array back via POST /api/storage/employees will, unless
   something restores it, submit every OTHER employee's record with no
   pinHash at all — silently deleting their password and locking them
   out at their next login. The frontend has (or had) over a dozen call
   sites that do exactly this for ordinary HR edits.

   Two independent fixes are applied:
   1) These endpoints let the three PIN-touching flows (add employee, change
      my PIN, forgot-PIN reset) update exactly one record's credential
      server-side, without the client ever sending the array at all.
   2) As a backstop for every OTHER existing (and any future) code path
      that still does a full-array save of 'employees' — see the merge
      in POST /api/storage/:key below — any employee in an incoming
      write that isn't explicitly changing its PIN has its real
      pinHash restored from the server's current copy by id before the
      write lands, so an ordinary HR edit can never wipe someone else's
      login.
   ================================================================== */

// Add a team member — admin only. Employee is created and hashed entirely
// server-side; the client never sends (or needs) the rest of the list.
app.post('/api/employees', requireAdmin, async (req, res) => {
  const { name, title, employmentType, departmentId, email, managerId, roles, isAdmin, pin } = req.body || {};
  if (!name || !pin) return res.status(400).json({ error: 'name and pin are required' });
  if (String(pin).length < 4) return res.status(400).json({ error: 'PIN must be at least 4 digits.' });
  try {
    const employees = (await readStorageValue('employees')) || [];
    if (employees.some((e) => (e.name || '').toLowerCase() === String(name).trim().toLowerCase())) {
      return res.status(409).json({ error: 'An employee with that name already exists.' });
    }
    const emp = {
      id: makeEmployeeId(),
      name: String(name).trim(), title: title || '', employmentType: employmentType || 'Full-time',
      departmentId: departmentId || null, email: (email || '').trim(), pinHash: await bcrypt.hash(String(pin), 10),
      managerId: managerId || null, roles: Array.isArray(roles) ? roles : [],
      // Only an actual admin/super-admin *token* can ever grant admin here —
      // req.user comes from requireAdmin's verified JWT, not from the body,
      // so a non-admin caller could never smuggle isAdmin:true through.
      isAdmin: !!(req.user.isSuperAdmin && isAdmin), isSuperAdmin: false, active: true,
      joinedDate: new Date().toISOString().slice(0, 10),
    };
    if (!validateSuperAdminIntegrity([emp])) return res.status(500).json({ error: 'internal integrity check failed' });
    employees.push(emp);
    await writeStorageValue('employees', employees);
    broadcastUpdate('employees', stripSalaryForBroadcast(stripCreds(employees)));
    // Admin-added accounts are active immediately — send the welcome/onboarding email now.
    sendWelcomeEmail(emp).catch((e) => console.error('[welcome-email]', e.message));
    res.json({ employee: safeEmployee(emp) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'could not add employee' });
  }
});

// Change my own PIN — requires a valid session token, verifies currentPin
// server-side against the real pinHash, updates only that one field.
app.post('/api/auth/pin/change', requireAuth, async (req, res) => {
  const { currentPin, newPin } = req.body || {};
  if (!currentPin || !newPin) return res.status(400).json({ error: 'currentPin and newPin are required' });
  if (String(newPin).length < 4) return res.status(400).json({ error: 'New PIN must be at least 4 digits.' });
  try {
    const employees = (await readStorageValue('employees')) || [];
    const match = employees.find((e) => e.id === req.user.sub);
    if (!match) return res.status(404).json({ error: 'Account not found.' });
    const ok = await verifyEmployeePin(match, currentPin);
    if (!ok) return res.status(401).json({ error: 'Current PIN is incorrect.' });
    match.pinHash = await bcrypt.hash(String(newPin), 10);
    delete match.pin;
    await writeStorageValue('employees', employees);
    broadcastUpdate('employees', stripSalaryForBroadcast(stripCreds(employees)));
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'pin change failed' });
  }
});

// Pending forgot-PIN resets: sessionId -> { employeeId, name, email, code, expires }.
const pendingForgots = new Map();

app.post('/api/auth/forgot/request-code', async (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });
  try {
    const employees = (await readStorageValue('employees')) || [];
    const match = employees.find((e) =>
      (e.name || '').toLowerCase() === String(name).trim().toLowerCase() &&
      (e.email || '').toLowerCase() === String(email).trim().toLowerCase()
    );
    if (!match) return res.status(404).json({ error: 'No matching account found.' });
    const sessionId = makeSessionId();
    const code = makeVerificationCode();
    const expires = Date.now() + 10 * 60 * 1000;
    pendingForgots.set(sessionId, { employeeId: match.id, name: match.name, email: match.email, code, expires });
    await sendEmailInternal({ type: 'verify', to: match.email, name: match.name, code, expiresAt: expires, reason: 'reset your PIN' });
    res.json({ sessionId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'could not start reset' });
  }
});

app.post('/api/auth/forgot/resend-code', async (req, res) => {
  const { sessionId } = req.body || {};
  const draft = pendingForgots.get(sessionId);
  if (!draft) return res.status(400).json({ error: 'This reset session is invalid or expired. Start again.' });
  draft.code = makeVerificationCode();
  draft.expires = Date.now() + 10 * 60 * 1000;
  await sendEmailInternal({ type: 'verify', to: draft.email, name: draft.name, code: draft.code, expiresAt: draft.expires, reason: 'reset your PIN' });
  res.json({ ok: true });
});

app.post('/api/auth/forgot/confirm', async (req, res) => {
  const { sessionId, code, newPin } = req.body || {};
  const draft = pendingForgots.get(sessionId);
  if (!draft) return res.status(400).json({ error: 'This reset session is invalid or expired. Start again.' });
  if (Date.now() > draft.expires) { pendingForgots.delete(sessionId); return res.status(400).json({ error: 'That code has expired. Request a new one.' }); }
  if (String(code || '').trim() !== draft.code) return res.status(401).json({ error: "That code doesn't match." });
  if (!newPin || String(newPin).length < 4) return res.status(400).json({ error: 'PIN must be at least 4 digits.' });
  try {
    const employees = (await readStorageValue('employees')) || [];
    const match = employees.find((e) => e.id === draft.employeeId);
    if (!match) { pendingForgots.delete(sessionId); return res.status(404).json({ error: 'Account not found.' }); }
    match.pinHash = await bcrypt.hash(String(newPin), 10);
    delete match.pin;
    await writeStorageValue('employees', employees);
    broadcastUpdate('employees', stripSalaryForBroadcast(stripCreds(employees)));
    pendingForgots.delete(sessionId);
    await sendEmailInternal({ type: 'reset-confirm', to: draft.email, name: draft.name });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'reset failed' });
  }
});

/* ---------------- Generic key/value storage (mirrors the app's loadKey/saveKey) ---------------- */

app.get('/api/storage', requireAuth, async (req, res) => {
  try {
    const prefix = req.query.prefix || '';
    const [rows] = await pool.query('SELECT storage_key FROM app_storage WHERE storage_key LIKE ?', [`${prefix}%`]);
    res.json({ keys: rows.map((r) => r.storage_key) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'list failed' });
  }
});

// Reads now require a valid session token — the frontend's loadKey() already
// sends one on every call (see authHeaders()), so this was safe to close.
// Before this, ANY key — documents, peopleCases, projects (revenue/expenses),
// even employees minus creds — was one unauthenticated GET away for anyone
// who found this URL, regardless of what the UI chose to render. The
// per-record scoping below (who can see which project's folder, whose case
// is whose) still only happens on WRITE; reads return the full stored value
// to any signed-in caller. If a specific key needs to be filtered per-caller
// on read too (e.g. so a non-PM can't fetch another project's private
// documents directly), that needs to be added per-key here — this change
// only closes the "no login at all" hole.
app.get('/api/storage/:key', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT value FROM app_storage WHERE storage_key=?', [req.params.key]);
    if (!rows.length) return res.json({ key: req.params.key, value: null });
    let value = JSON.parse(rows[0].value);
    if (req.params.key === 'employees' && Array.isArray(value)) {
      // PINs are short numeric codes — even a bcrypt hash of one is
      // brute-forceable in well under a second if it ever leaves the
      // server, so neither the plaintext nor the hash is included here.
      value = stripCreds(value);
      // Salary is HR/finance-sensitive — only an admin/super-admin, or an
      // employee who actually holds the Finance role, gets it. Everyone
      // else still needs the rest of this array (names/roles/departments
      // are used all over the app), just not the payroll figures.
      value = redactSalary(value, req.user.sub, !!(req.user.isAdmin || req.user.isSuperAdmin));
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
  const callerSub = req.user ? req.user.sub : null;

  try {
    let newlyApproved = [];
    let newlyDeactivated = [];
    if (key === 'employees') {
      const current = (await readStorageValue('employees')) || [];

      /* Credential-preserving merge — this is the actual fix for the
         "logged in fine once, then PIN says incorrect" bug class, AND
         it must run BEFORE anonymousEmployeeWriteIsAllowed below, not
         after. GET /api/storage/employees (and every other read this
         client ever does) never includes pin or pinHash. So the moment
         ANY code path — adding a teammate, editing a title, toggling
         active/inactive, changing a role, flipping a notification
         preference, verifying an email, this whole generic route in
         general — reads that list, edits it, and posts the FULL array
         back, every employee it didn't just edit has no credential
         field at all in what's arriving here. If we ran the shape check
         against that raw payload, every other employee's missing
         pinHash would look like a "changed" field, changedCount would
         blow past 1, and the write would get rejected with a 403 —
         even a plain single-field self-service edit like verifying your
         own email. That's exactly what was happening: a real change was
         being misread as N changes because of a field the client never
         had in the first place.
         Fix: for every incoming record that ISN'T carrying a plaintext
         `pin` (i.e. isn't the one actually changing its PIN right now),
         restore the real pinHash from the server's current copy by id
         BEFORE the shape/authorization check runs, so the diff is
         comparing like-for-like. A record with a plaintext `pin` still
         gets hashed fresh by sanitizeEmployeePins() below, exactly as
         before. */
      const currentById = new Map(current.map((e) => [e.id, e]));
      for (const emp of value) {
        if (!emp || emp.pin !== undefined) continue; // this one IS setting/changing its PIN — let it through as-is
        const existing = currentById.get(emp.id);
        if (existing && existing.pinHash && emp.pinHash === undefined) emp.pinHash = existing.pinHash;
      }

      if (!isAdminToken) {
        if (!anonymousEmployeeWriteIsAllowed(current, value, callerSub)) {
          return res.status(403).json({ error: 'Sign in as an admin to make this change to the employee list.' });
        }
      }
      if (!validateSuperAdminIntegrity(value)) {
        return res.status(403).json({ error: `Only ${SUPER_ADMIN_EMAIL} may hold Super Admin.` });
      }
      value = await sanitizeEmployeePins(value); // never persist a plaintext PIN, whoever wrote it

      // Detect someone being reactivated after a deactivation, so the
      // welcome/onboarding email (PWA install steps, role, agreement notice)
      // goes out again the moment an admin flips them back to active — this
      // is the only place that transition happens, since there's no
      // separate "reactivate" endpoint; an admin just edits the active flag
      // on the full employees array and re-saves it.
      newlyApproved = value.filter((emp) => {
        const before = currentById.get(emp.id);
        if (!before) return false;
        const wasPending = before.active === false;
        const nowApproved = emp.active !== false;
        return wasPending && nowApproved;
      });

      // Symmetric detection for the opposite transition: someone just got
      // deactivated. Sends the "your account was deactivated, contact your
      // admin" email and (via requireAuth on every other route) means their
      // existing token stops working the moment they're next checked, since
      // active===false is enforced on login and on every admin-gated route.
      newlyDeactivated = value.filter((emp) => {
        const before = currentById.get(emp.id);
        if (!before) return false;
        return before.active !== false && emp.active === false;
      });
    } else if (key === 'agreementSignatures') {
      if (!isAdminToken) {
        const current = (await readStorageValue('agreementSignatures')) || [];
        if (!signatureWriteIsAllowed(current, value, callerSub)) {
          return res.status(403).json({ error: 'You can only sign an agreement as yourself.' });
        }
      }
    } else if (key === 'documents') {
      // A project's Documents folder is a hard access boundary: only the
      // project's team/lead (or an admin) may add to or manage a file inside
      // it — this is what actually enforces that, not just the frontend's
      // rendering logic. See documentsWriteIsAllowed above.
      if (!isAdminToken) {
        const current = (await readStorageValue('documents')) || [];
        if (!(await documentsWriteIsAllowed(current, value, callerSub))) {
          return res.status(403).json({ error: "You can only add your own files, or manage files you uploaded or lead the project for — and only into a project folder you're actually on." });
        }
      }
    } else if (key === 'docFolders') {
      if (!isAdminToken) {
        const current = (await readStorageValue('docFolders')) || [];
        if (!(await docFoldersWriteIsAllowed(current, value, callerSub))) {
          return res.status(403).json({ error: 'You can only create a folder for a project you belong to — ask an admin for anything else.' });
        }
      }
    } else if (key === 'peopleCases') {
      // Case triage (viewing/changing status/resolving) is the Super Admin's
      // to do regardless of role, or an Admin's as long as they also hold
      // the HR role — everyone else may only request their own case or add
      // a note to it. See peopleCasesWriteIsAllowed above.
      if (!(await peopleCasesWriteIsAllowed((await readStorageValue('peopleCases')) || [], value, callerSub, !!(req.user && req.user.isSuperAdmin), isAdminToken))) {
        return res.status(403).json({ error: 'You can only submit or update your own leave/escalation/dispute case.' });
      }
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
    broadcastUpdate(key, key === 'employees' ? stripSalaryForBroadcast(stripCreds(value)) : value);
    if (key === 'notifications' || key === 'announcements') {
      handlePushForNewItems(key, value).catch((e) => console.error('[push]', e.message));
    }
    if (newlyApproved.length) {
      newlyApproved.forEach((emp) => sendWelcomeEmail(emp).catch((e) => console.error('[welcome-email]', e.message)));
    }
    if (newlyDeactivated.length) {
      newlyDeactivated.forEach((emp) => sendDeactivatedEmail(emp).catch((e) => console.error('[deactivated-email]', e.message)));
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'write failed' });
  }
});

app.delete('/api/storage/:key', requireAuth, async (req, res) => {
  const key = req.params.key;
  const isAdminToken = !!(req.user.isAdmin || req.user.isSuperAdmin);
  if ((key === 'employees' || key === 'agreementSignatures' || key === 'documents' || key === 'docFolders' || key === 'peopleCases' || ADMIN_ONLY_WRITE_KEYS.has(key)) && !isAdminToken) {
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
      value = stripCreds(value); // never expose PINs, even in a historical snapshot
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
    broadcastUpdate(req.params.key, req.params.key === 'employees' ? stripSalaryForBroadcast(stripCreds(value)) : value);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'restore failed' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, push: pushEnabled, auth: !!JWT_SECRET }));

app.listen(PORT, () => console.log(`Sarab OS backend listening on :${PORT}`));
