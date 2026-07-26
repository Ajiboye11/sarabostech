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
            This is an automated message from ${escapeHtml(BRAND.companyName)}.<br>
            If you weren't expecting this, you can safely ignore it.
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

/** Dispatch by type. Returns { subject, html } or throws for an unknown type. */
function buildEmail(type, payload) {
  switch (type) {
    case 'verify': return verifyTemplate(payload);
    case 'reset-confirm': return resetConfirmTemplate(payload);
    case 'notification': return notificationTemplate(payload);
    case 'chat': return chatTemplate(payload);
    default: throw new Error(`Unknown email type: ${type}`);
  }
}

module.exports = { buildEmail };
