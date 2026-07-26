/**
 * email-server-addon.js
 * ----------------------
 * Adds POST /api/send-email to your existing Express backend.
 *
 * Uses Resend (https://resend.com) over plain HTTPS instead of raw SMTP.
 * Raw SMTP from cloud hosts like Render is frequently blocked by network
 * firewalls (both on the cloud-host side and the receiving mail server's
 * side) — this sidesteps that entirely since it's just a normal web request,
 * the same way any other API call from this server already works.
 *
 * SETUP
 * 1. Sign up free at https://resend.com — no card required.
 * 2. Domains -> Add Domain -> add the DNS records it gives you via cPanel's
 *    Zone Editor -> click Verify (can take a few minutes to an hour).
 * 3. API Keys -> Create API Key -> copy it.
 * 4. In Render -> your service -> Environment, add:
 *
 *      RESEND_API_KEY=re_your_key_here
 *      MAIL_FROM_NAME=Sarab Technologies
 *      MAIL_FROM_EMAIL=notifications@sarabtechnologies.name.ng
 *
 *    (MAIL_FROM_EMAIL must be @ the domain you verified in step 2.)
 * 5. Make sure server.js still has, right after `app.use(express.json(...))`:
 *
 *      const registerEmailRoute = require('./email-server-addon');
 *      registerEmailRoute(app);
 *
 * 6. Redeploy. Test the same way as before:
 *
 *      $response = Invoke-RestMethod -Uri "https://sarabostech.onrender.com/api/send-email" -Method Post -ContentType "application/json" -Body '{"type":"reset-confirm","to":"you@example.com","name":"Test User"}'
 *      $response
 *
 * Once real emails are confirmed arriving, set DEV_SHOW_CODES = false near
 * the top of index.html so codes stop appearing on-screen.
 */

const { buildEmail } = require('./email-templates');

function registerEmailRoute(app) {
  app.post('/api/send-email', async (req, res) => {
    try {
      const { type, to, appUrl, ...payload } = req.body || {};
      if (!type || !to) {
        return res.status(400).json({ ok: false, error: 'type and to are required' });
      }
      if (!process.env.RESEND_API_KEY) {
        console.warn('[send-email] RESEND_API_KEY not set, skipping send:', type, to);
        return res.json({ ok: false, error: 'Resend API key not configured' });
      }

      const { subject, html } = buildEmail(type, { ...payload, appUrl });
      const fromName = process.env.MAIL_FROM_NAME || 'Sarab Technologies';
      const fromEmail = process.env.MAIL_FROM_EMAIL;
      if (!fromEmail) {
        console.warn('[send-email] MAIL_FROM_EMAIL not set, skipping send');
        return res.json({ ok: false, error: 'MAIL_FROM_EMAIL not configured' });
      }

      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${fromName} <${fromEmail}>`,
          to: [to],
          subject,
          html,
        }),
      });

      if (!resendRes.ok) {
        const errText = await resendRes.text().catch(() => '');
        console.error('[send-email] Resend rejected the request:', resendRes.status, errText);
        return res.json({ ok: false, error: `Resend error: ${resendRes.status}` });
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('[send-email] failed:', err);
      // Still 200 so a flaky mail provider never breaks the app's own flow —
      // the front end treats email as best-effort, not required.
      res.json({ ok: false, error: 'send failed' });
    }
  });
}

module.exports = registerEmailRoute;
