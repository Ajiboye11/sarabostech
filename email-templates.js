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
  blueDeep: '#16316E',
  text: '#111827',
  textDim: '#4B5566',
  border: '#E3E6EB',
  bg: '#F5F6F8',
  companyName: 'Sarab Technologies',
};

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** Shared wrapper: blue header banner with logo, white card, footer. */
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
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader || '')}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">

        <!-- Header banner -->
        <tr><td style="background:linear-gradient(135deg,${BRAND.blue},${BRAND.blueDeep});border-radius:16px 16px 0 0;padding:28px 32px;text-align:center;">
          ${logoUrl ? `<img src="${logoUrl}" width="44" height="44" alt="${escapeHtml(BRAND.companyName)}" style="border-radius:11px;display:block;margin:0 auto 10px;box-shadow:0 2px 10px rgba(0,0,0,0.25);">` : ''}
          <span style="font-size:16px;font-weight:700;color:#FFFFFF;letter-spacing:.2px;">${escapeHtml(BRAND.companyName)}</span>
        </td></tr>

        <!-- Card body -->
        <tr><td style="background:#FFFFFF;border:1px solid ${BRAND.border};border-top:none;border-radius:0 0 16px 16px;padding:36px 32px;box-shadow:0 4px 24px rgba(16,24,40,0.06);">
          ${bodyHtml}
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:22px 8px 0;text-align:center;">
          <p style="margin:0;font-size:12px;color:#98A2B3;line-height:1.7;">
            Sent by <strong style="color:#7A8494;">${escapeHtml(BRAND.companyName)}</strong> — an automated message, no reply needed.<br>
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
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 4px;">
    <tr><td style="border-radius:10px;background:${BRAND.blue};box-shadow:0 2px 8px rgba(41,82,204,0.28);">
      <a href="${href}" style="display:inline-block;padding:13px 26px;font-size:14px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:10px;">${escapeHtml(label)}</a>
    </td></tr>
  </table>`;
}

/* ---------------- Individual templates ---------------- */

function verifyTemplate({ name, code, expiresAt, reason, appUrl }) {
  const mins = expiresAt ? Math.max(1, Math.round((expiresAt - Date.now()) / 60000)) : 10;
  const purpose = reason || 'verify your email address';
  const digits = String(code || '').split('');
  const codeCells = digits.map((d) =>
    `<td style="width:40px;height:48px;background:${BRAND.bg};border:1px solid ${BRAND.border};border-radius:8px;text-align:center;vertical-align:middle;">
      <span style="font-family:'Courier New',monospace;font-size:24px;font-weight:700;color:${BRAND.blueDark};">${escapeHtml(d)}</span>
    </td>`
  ).join('<td style="width:6px;"></td>');
  const body = `
    <h1 style="margin:0 0 12px;font-size:21px;color:${BRAND.text};letter-spacing:-.2px;">Verify your email</h1>
    <p style="margin:0 0 22px;font-size:14.5px;color:${BRAND.textDim};line-height:1.6;">
      Hi ${escapeHtml(name || '')}, use the code below to ${escapeHtml(purpose)}.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 16px;"><tr>${codeCells}</tr></table>
    <p style="margin:0;font-size:13px;color:#98A2B3;text-align:center;">This code expires in ${mins} minute${mins === 1 ? '' : 's'}. Didn't request this? You can ignore this email.</p>
  `;
  return {
    subject: `${code} is your verification code`,
    html: shell({ appUrl, preheader: `Your verification code is ${code}`, bodyHtml: body }),
  };
}

function resetConfirmTemplate({ name, appUrl }) {
  const body = `
    <div style="text-align:center;margin-bottom:18px;">
      <div style="display:inline-flex;width:48px;height:48px;border-radius:50%;background:#ECFDF3;align-items:center;justify-content:center;">
        <span style="font-size:22px;line-height:48px;">&#10003;</span>
      </div>
    </div>
    <h1 style="margin:0 0 12px;font-size:21px;color:${BRAND.text};text-align:center;letter-spacing:-.2px;">Your PIN was changed</h1>
    <p style="margin:0 0 8px;font-size:14.5px;color:${BRAND.textDim};line-height:1.6;text-align:center;">
      Hi ${escapeHtml(name || '')}, this confirms your account PIN was just changed.
    </p>
    <p style="margin:16px 0 0;font-size:13px;color:#98A2B3;text-align:center;">
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
    <span style="display:inline-block;font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:${BRAND.blue};background:#EAF0FE;padding:5px 11px;border-radius:6px;margin-bottom:16px;">${escapeHtml(typeLabel || 'Notification')}</span>
    <h1 style="margin:0 0 12px;font-size:20px;color:${BRAND.text};letter-spacing:-.2px;">${escapeHtml(title || 'New notification')}</h1>
    <p style="margin:0 0 4px;font-size:14.5px;color:${BRAND.textDim};line-height:1.6;">Hi ${escapeHtml(name || '')},</p>
    <p style="margin:0 0 6px;font-size:14.5px;color:${BRAND.textDim};line-height:1.6;">${escapeHtml(message || '')}</p>
    ${deepLink ? button('View in app', deepLink) : ''}
  `;
  return {
    subject: title || 'New notification',
    html: shell({ appUrl, preheader: message || '', bodyHtml: body }),
  };
}

function chatTemplate({ name, from, preview, deepLink, appUrl }) {
  const body = `
    <h1 style="margin:0 0 14px;font-size:20px;color:${BRAND.text};letter-spacing:-.2px;">New message from ${escapeHtml(from || 'a teammate')}</h1>
    <p style="margin:0 0 4px;font-size:14.5px;color:${BRAND.textDim};line-height:1.6;">Hi ${escapeHtml(name || '')},</p>
    <div style="background:${BRAND.bg};border:1px solid ${BRAND.border};border-left:3px solid ${BRAND.blue};border-radius:8px;padding:14px 16px;margin:12px 0 4px;">
      <p style="margin:0;font-size:14.5px;color:${BRAND.text};line-height:1.6;">${escapeHtml(preview || '')}</p>
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
