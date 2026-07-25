/**
 * email-server-addon.js
 * ----------------------
 * Adds POST /api/send-email to your existing Express backend (the one at
 * API_BASE in index.html, e.g. the server running on Render).
 *
 * SETUP
 * 1. On your backend server:  npm install nodemailer
 * 2. Copy this file and email-templates.js into the same folder as your
 *    server.js.
 * 3. In server.js, near your other `app.use(...)` lines, add:
 *
 *      const registerEmailRoute = require('./email-server-addon');
 *      registerEmailRoute(app);
 *
 * 4. Set these environment variables on your host (Render → your service →
 *    Environment). Get the SMTP host/port/username/password from cPanel →
 *    Email Accounts → [your address] → Connect Devices (it shows the exact
 *    values cPanel wants you to use).
 *
 *      SMTP_HOST=mail.yourdomain.com
 *      SMTP_PORT=465            (465 = SSL, 587 = STARTTLS — cPanel shows both)
 *      SMTP_SECURE=true         (true for port 465, false for 587)
 *      SMTP_USER=notifications@yourdomain.com
 *      SMTP_PASS=your-mailbox-password
 *      MAIL_FROM_NAME=Sarab Technologies
 *      MAIL_FROM_EMAIL=notifications@yourdomain.com
 *
 * 5. Redeploy the backend. Test with:
 *
 *      curl -X POST https://<API_BASE>/api/send-email \
 *        -H "Content-Type: application/json" \
 *        -d '{"type":"verify","to":"you@example.com","name":"Test","code":"123456","expiresAt":' $(($(date +%s%3N)+600000)) '}'
 *
 * Once real emails are confirmed arriving, set DEV_SHOW_CODES = false near
 * the top of index.html so codes stop appearing on-screen.
 */

const nodemailer = require('nodemailer');
const { buildEmail } = require('./email-templates');

function registerEmailRoute(app) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || 'true') === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  app.post('/api/send-email', async (req, res) => {
    try {
      const { type, to, appUrl, ...payload } = req.body || {};
      if (!type || !to) {
        return res.status(400).json({ ok: false, error: 'type and to are required' });
      }
      if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
        // SMTP not configured yet — respond so the app keeps working (it
        // falls back to on-screen codes via DEV_SHOW_CODES), just log it.
        console.warn('[send-email] SMTP not configured, skipping send:', type, to);
        return res.json({ ok: false, error: 'SMTP not configured' });
      }

      const { subject, html } = buildEmail(type, { ...payload, appUrl });
      const fromName = process.env.MAIL_FROM_NAME || 'Sarab Technologies';
      const fromEmail = process.env.MAIL_FROM_EMAIL || process.env.SMTP_USER;

      await transporter.sendMail({
        from: `"${fromName}" <${fromEmail}>`,
        to,
        subject,
        html,
      });

      res.json({ ok: true });
    } catch (err) {
      console.error('[send-email] failed:', err);
      // Still 200 so a flaky mail server never breaks the app's own flow —
      // the front end treats email as best-effort, not required.
      res.json({ ok: false, error: 'send failed' });
    }
  });
}

module.exports = registerEmailRoute;
