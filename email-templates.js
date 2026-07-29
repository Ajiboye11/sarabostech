/**
 * email-templates.js
 * -------------------
 * Plain HTML email templates, no build step, no external CSS — everything is
 * inline so it renders consistently across Gmail/Outlook/Apple Mail. Colors
 * match the app's brand blue (#2952CC). Each function returns { subject, html }.
 *
 * Require this from email-server-addon.js:
 *   const { buildEmail } = require('./email-templates');
 */

const BRAND = {
  blue: '#2952CC',
  blueDark: '#1E3F9E',
  text: '#111827',
  textDim: '#4B5566',
  border: '#E3E6EB',
  bg: '#F5F6F8',
  green: '#067647',
  amber: '#B54708',
  companyName: 'Sarab Technologies',
};

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** Shared wrapper: logo header, white card, footer. `bodyHtml` goes inside the card. */
function shell({ appUrl, preheader, bodyHtml }) {
  const logoUrl = appUrl ? `${appUrl.replace(/\/$/, '')}/assets/ST_Icon.png` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(BRAND.companyName)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <!-- preheader (hidden preview text) -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader || '')}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">
        <tr><td style="padding:0 4px 20px;text-align:center;">
          ${logoUrl ? `<img src="${logoUrl}" width="40" height="40" alt="${escapeHtml(BRAND.companyName)}" style="border-radius:9px;display:inline-block;vertical-align:middle;">` : ''}
          <span style="font-size:16px;font-weight:700;color:${BRAND.text};margin-left:8px;vertical-align:middle;">${escapeHtml(BRAND.companyName)}</span>
        </td></tr>
        <tr><td style="background:#FFFFFF;border:1px solid ${BRAND.border};border-radius:14px;padding:36px 32px;box-shadow:0 4px 24px rgba(16,24,40,0.06);">
          ${bodyHtml}
        </td></tr>
        <tr><td style="padding:20px 8px 0;text-align:center;">
          <p style="margin:0;font-size:12px;color:#98A2B3;line-height:1.6;">
            This is an automated message from ${escapeHtml(BRAND.companyName)}.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function button(label, href) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 4px;">
    <tr><td style="border-radius:9px;background:${BRAND.blue};">
      <a href="${href}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:9px;">${escapeHtml(label)}</a>
    </td></tr>
  </table>`;
}

/* ---------------- Individual templates ---------------- */

function verifyTemplate({ name, code, expiresAt, reason, appUrl }) {
  const mins = expiresAt ? Math.max(1, Math.round((expiresAt - Date.now()) / 60000)) : 10;
  const purpose = reason || 'verify your email address';
  const body = `
    <h1 style="margin:0 0 12px;font-size:20px;color:${BRAND.text};">Verify your email</h1>
    <p style="margin:0 0 20px;font-size:14px;color:${BRAND.textDim};line-height:1.6;">
      Hi ${escapeHtml(name || '')}, use the code below to ${escapeHtml(purpose)}.
    </p>
    <div style="text-align:center;background:${BRAND.bg};border:1px solid ${BRAND.border};border-radius:10px;padding:20px;margin-bottom:16px;">
      <span style="font-family:'Courier New',monospace;font-size:32px;font-weight:700;letter-spacing:6px;color:${BRAND.blueDark};">${escapeHtml(code)}</span>
    </div>
    <p style="margin:0;font-size:13px;color:#98A2B3;">This code expires in ${mins} minute${mins === 1 ? '' : 's'}. Didn't request this? You can ignore this email.</p>
  `;
  return {
    subject: `${code} is your verification code`,
    html: shell({ appUrl, preheader: `Your verification code is ${code}`, bodyHtml: body }),
  };
}

function resetConfirmTemplate({ name, appUrl }) {
  const body = `
    <h1 style="margin:0 0 12px;font-size:20px;color:${BRAND.text};">Your PIN was changed</h1>
    <p style="margin:0 0 8px;font-size:14px;color:${BRAND.textDim};line-height:1.6;">
      Hi ${escapeHtml(name || '')}, this confirms your account PIN was just changed.
    </p>
    <p style="margin:0;font-size:13px;color:#98A2B3;">
      If this wasn't you, sign in and change your PIN again immediately, or contact your admin.
    </p>
  `;
  return {
    subject: 'Your PIN was changed',
    html: shell({ appUrl, preheader: 'Your account PIN was just changed', bodyHtml: body }),
  };
}

function notificationTemplate({ name, title, message, typeLabel, deepLink, appUrl }) {
  const body = `
    <span style="display:inline-block;font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:${BRAND.blue};background:#EAF0FE;padding:4px 10px;border-radius:6px;margin-bottom:14px;">${escapeHtml(typeLabel || 'Notification')}</span>
    <h1 style="margin:0 0 10px;font-size:19px;color:${BRAND.text};">${escapeHtml(title || 'New notification')}</h1>
    <p style="margin:0 0 4px;font-size:14px;color:${BRAND.textDim};line-height:1.6;">Hi ${escapeHtml(name || '')},</p>
    <p style="margin:0 0 8px;font-size:14px;color:${BRAND.textDim};line-height:1.6;">${escapeHtml(message || '')}</p>
    ${deepLink ? button('View in app', deepLink) : ''}
  `;
  return {
    subject: title || 'New notification',
    html: shell({ appUrl, preheader: message || '', bodyHtml: body }),
  };
}

function chatTemplate({ name, from, preview, deepLink, appUrl }) {
  const body = `
    <h1 style="margin:0 0 12px;font-size:19px;color:${BRAND.text};">New message from ${escapeHtml(from || 'a teammate')}</h1>
    <p style="margin:0 0 4px;font-size:14px;color:${BRAND.textDim};line-height:1.6;">Hi ${escapeHtml(name || '')},</p>
    <div style="background:${BRAND.bg};border:1px solid ${BRAND.border};border-radius:10px;padding:14px 16px;margin:10px 0;">
      <p style="margin:0;font-size:14px;color:${BRAND.text};line-height:1.6;">${escapeHtml(preview || '')}</p>
    </div>
    ${deepLink ? button('Reply in app', deepLink) : ''}
  `;
  return {
    subject: `${from || 'Someone'} sent you a message`,
    html: shell({ appUrl, preheader: preview || '', bodyHtml: body }),
  };
}

function deactivatedTemplate({ name, appUrl }) {
  const body = `
    <h1 style="margin:0 0 12px;font-size:20px;color:${BRAND.text};">Your account has been deactivated</h1>
    <p style="margin:0 0 8px;font-size:14px;color:${BRAND.textDim};line-height:1.6;">
      Hi ${escapeHtml(name || '')}, your ${escapeHtml(BRAND.companyName)} account has been deactivated by an admin.
    </p>
    <div style="background:#FEF3F2;border:1px solid #FECDCA;border-radius:10px;padding:14px 16px;margin:14px 0 18px;">
      <p style="margin:0;font-size:13px;color:${BRAND.text};line-height:1.6;">
        You will not be able to sign in while your account is deactivated. If you believe this is a mistake, please contact your admin directly.
      </p>
    </div>
    <p style="margin:0;font-size:13px;color:#98A2B3;">This is a confirmation notice — no action is required from you right now.</p>
  `;
  return {
    subject: `Your ${BRAND.companyName} account has been deactivated`,
    html: shell({ appUrl, preheader: `Your account has been deactivated. Contact your admin if this is unexpected.`, bodyHtml: body }),
  };
}

/**
 * Sent the moment an admin directly adds a new team member. Kept short and
 * simple on purpose: a greeting, their role, a reminder to install the PWA
 * (no how-to steps — they already know how), the agreement requirement,
 * and a warm send-off.
 */
function welcomeTemplate({ name, title, roles, isAdmin, appUrl }) {
  const firstName = escapeHtml((name || '').split(/\s+/)[0] || '');
  const roleLine = title || (Array.isArray(roles) && roles.length ? roles.join(', ') : (isAdmin ? 'Admin' : 'Employee'));
  const loginUrl = 'https://www.sarabtechnologies.name.ng/';

  const body = `
    <h1 style="margin:0 0 12px;font-size:20px;color:${BRAND.text};">Welcome to ${escapeHtml(BRAND.companyName)}, ${firstName}! 🎉</h1>
    <p style="margin:0 0 20px;font-size:14px;color:${BRAND.textDim};line-height:1.6;">
      Your account has been created and you're all set to get started.
    </p>

    <div style="background:${BRAND.bg};border:1px solid ${BRAND.border};border-radius:10px;padding:14px 16px;margin-bottom:20px;">
      <div style="font-size:12px;font-weight:700;letter-spacing:.3px;text-transform:uppercase;color:${BRAND.blue};margin-bottom:4px;">Your role</div>
      <div style="font-size:15px;font-weight:700;color:${BRAND.text};">${escapeHtml(roleLine)}</div>
    </div>

    <p style="margin:0 0 16px;font-size:14px;color:${BRAND.textDim};line-height:1.6;">
      Go ahead and install the app on your device like you normally would. It works as a PWA, so no app store needed.
    </p>

    <div style="background:${BRAND.amber}0D;border:1px solid #FBE3C6;border-radius:10px;padding:14px 16px;margin:0 0 20px;">
      <div style="font-size:13px;font-weight:700;color:${BRAND.amber};margin-bottom:4px;">⚠️ Required: sign your agreement</div>
      <p style="margin:0;font-size:13px;color:${BRAND.textDim};line-height:1.6;">
        Once you sign in, you'll need to review and sign your company agreement before the rest of the app unlocks.
      </p>
    </div>

    ${button('Open ' + BRAND.companyName, loginUrl)}

    <p style="margin:22px 0 0;font-size:14px;color:${BRAND.textDim};line-height:1.6;">
      Wishing you a great start — welcome aboard!
    </p>
  `;
  return {
    subject: `Welcome to ${BRAND.companyName}, ${firstName}!`,
    html: shell({ appUrl, preheader: `Your account is ready, Install the app and sign your agreement to get started.`, bodyHtml: body }),
  };
}

/** Dispatch by type. Returns { subject, html } or throws for an unknown type. */
function buildEmail(type, payload) {
  switch (type) {
    case 'verify': return verifyTemplate(payload);
    case 'reset-confirm': return resetConfirmTemplate(payload);
    case 'notification': return notificationTemplate(payload);
    case 'chat': return chatTemplate(payload);
    case 'welcome': return welcomeTemplate(payload);
    case 'deactivated': return deactivatedTemplate(payload);
    default: throw new Error(`Unknown email type: ${type}`);
  }
}

module.exports = { buildEmail };
