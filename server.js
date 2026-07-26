require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

const REQUIRED_ENV = ['DB_HOST', 'DB_USER', 'DB_NAME', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.warn(`[startup] Missing env vars: ${missing.join(', ')} — copy .env.example to .env and fill these in.`);
}

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

app.get('/api/storage/:key', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT value FROM app_storage WHERE storage_key=?', [req.params.key]);
    if (!rows.length) return res.json({ key: req.params.key, value: null });
    res.json({ key: req.params.key, value: JSON.parse(rows[0].value) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'read failed' });
  }
});

app.post('/api/storage/:key', async (req, res) => {
  const key = req.params.key;
  const value = req.body ? req.body.value : undefined;
  if (value === undefined) return res.status(400).json({ error: 'body.value is required' });
  try {
    const json = JSON.stringify(value);
    await pool.query(
      'INSERT INTO app_storage (storage_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)',
      [key, json]
    );
    res.json({ ok: true });
    // Fire-and-forget: don't make the caller wait on realtime/push delivery.
    broadcastUpdate(key, value);
    if (key === 'notifications' || key === 'announcements') {
      handlePushForNewItems(key, value).catch((e) => console.error('[push]', e.message));
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'write failed' });
  }
});

app.delete('/api/storage/:key', async (req, res) => {
  try {
    await pool.query('DELETE FROM app_storage WHERE storage_key=?', [req.params.key]);
    res.json({ ok: true });
    broadcastUpdate(req.params.key, null);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'delete failed' });
  }
});

/* ---------------- Web Push: subscriptions + send-on-new-item ---------------- */

app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null, enabled: pushEnabled });
});

app.post('/api/push/subscribe', async (req, res) => {
  const { employeeId, subscription } = req.body || {};
  if (!employeeId || !subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'employeeId and subscription are required' });
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

app.post('/api/push/unsubscribe', async (req, res) => {
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

app.get('/health', (req, res) => res.json({ ok: true, push: pushEnabled }));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Sarab OS backend listening on :${PORT}`));
