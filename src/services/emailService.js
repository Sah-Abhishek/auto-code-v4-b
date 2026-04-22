import nodemailer from 'nodemailer';

const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASSWORD,
  SMTP_FROM_NAME,
  SMTP_FROM_EMAIL,
  APP_URL,
  APP_LOGIN_URL
} = process.env;

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) {
    console.warn('⚠️  SMTP not fully configured — emails will be skipped.');
    return null;
  }
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT, 10) || 587,
    secure: String(SMTP_SECURE).toLowerCase() === 'true',
    requireTLS: true,
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
    tls: { ciphers: 'TLSv1.2' }
  });
  return transporter;
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildWelcomeHtml({ userName, code, loginUrl, appUrl, processLimit, validDays, validUntil }) {
  const safeName = escapeHtml(userName || 'there');
  const safeCode = escapeHtml(code);
  const validUntilStr = validUntil ? new Date(validUntil).toLocaleDateString() : '';
  return `<!DOCTYPE html>
<html>
  <body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; background:#f8fafc; margin:0; padding:24px; color:#0f172a;">
    <div style="max-width:560px; margin:0 auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:16px; overflow:hidden;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#2563eb" style="background-color:#2563eb; background-image:linear-gradient(135deg,#2563eb,#4f46e5);">
        <tr>
          <td style="padding:24px 28px; color:#ffffff;">
            <h1 style="margin:0; font-size:20px; font-weight:600; color:#ffffff;">Welcome to MedCode AI</h1>
            <p style="margin:4px 0 0; font-size:13px; color:#ffffff; opacity:.9;">Your access has been provisioned</p>
          </td>
        </tr>
      </table>
      <div style="padding:28px;">
        <p style="margin:0 0 14px; font-size:15px;">Hi ${safeName},</p>
        <p style="margin:0 0 18px; font-size:14px; line-height:1.5;">
          An administrator has created an account for you on MedCode AI. Use the access code below to sign in.
        </p>

        <div style="background:#f1f5f9; border:1px solid #e2e8f0; border-radius:12px; padding:18px; text-align:center; margin:18px 0;">
          <div style="font-size:11px; letter-spacing:.08em; color:#64748b; text-transform:uppercase;">Your access code</div>
          <div style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:22px; font-weight:700; letter-spacing:.08em; color:#0f172a; margin-top:6px;">${safeCode}</div>
        </div>

        <table role="presentation" style="width:100%; border-collapse:collapse; font-size:13px; margin:8px 0 20px;">
          <tr>
            <td style="padding:6px 0; color:#64748b;">Process runs allotted</td>
            <td style="padding:6px 0; text-align:right; color:#0f172a; font-weight:600;">${processLimit}</td>
          </tr>
          <tr>
            <td style="padding:6px 0; color:#64748b;">Valid for</td>
            <td style="padding:6px 0; text-align:right; color:#0f172a; font-weight:600;">${validDays} days</td>
          </tr>
          ${validUntilStr ? `<tr>
            <td style="padding:6px 0; color:#64748b;">Expires on</td>
            <td style="padding:6px 0; text-align:right; color:#0f172a; font-weight:600;">${escapeHtml(validUntilStr)}</td>
          </tr>` : ''}
        </table>

        <div style="text-align:center; margin:20px 0 10px;">
          <a href="${escapeHtml(loginUrl)}" style="display:inline-block; background:#2563eb; color:#ffffff; text-decoration:none; padding:12px 22px; border-radius:10px; font-weight:600; font-size:14px;">
            Sign in to MedCode AI
          </a>
        </div>
        <p style="margin:14px 0 0; font-size:12px; color:#64748b; text-align:center;">
          Or copy this link into your browser:<br/>
          <a href="${escapeHtml(loginUrl)}" style="color:#2563eb; word-break:break-all;">${escapeHtml(loginUrl)}</a>
        </p>

        <hr style="border:none; border-top:1px solid #e2e8f0; margin:22px 0;" />
        <p style="margin:0; font-size:12px; color:#64748b; line-height:1.5;">
          If you didn't expect this email, please ignore it or contact your administrator.
          ${appUrl ? `Website: <a href="${escapeHtml(appUrl)}" style="color:#2563eb;">${escapeHtml(appUrl)}</a>` : ''}
        </p>
      </div>
    </div>
  </body>
</html>`;
}

function buildWelcomeText({ userName, code, loginUrl, processLimit, validDays, validUntil }) {
  const validUntilStr = validUntil ? new Date(validUntil).toLocaleDateString() : '';
  return [
    `Hi ${userName || 'there'},`,
    '',
    'An administrator has created an account for you on MedCode AI.',
    '',
    `Access code: ${code}`,
    `Process runs allotted: ${processLimit}`,
    `Valid for: ${validDays} days${validUntilStr ? ` (expires ${validUntilStr})` : ''}`,
    '',
    `Sign in: ${loginUrl}`,
    '',
    "If you didn't expect this email, please ignore it or contact your administrator."
  ].join('\n');
}

export async function sendAccessCodeEmail({ to, userName, code, processLimit, validDays, validUntil }) {
  if (!to) return { sent: false, reason: 'no recipient' };
  const tx = getTransporter();
  if (!tx) return { sent: false, reason: 'SMTP not configured' };

  const loginUrl = APP_LOGIN_URL || (APP_URL ? `${APP_URL.replace(/\/$/, '')}/user/login` : 'https://llm.icdcore.com/user/login');
  const appUrl = APP_URL || 'https://llm.icdcore.com';
  const fromName = SMTP_FROM_NAME || 'MedCode AI';
  const fromEmail = SMTP_FROM_EMAIL || SMTP_USER;

  const info = await tx.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to,
    subject: 'Your MedCode AI access code',
    text: buildWelcomeText({ userName, code, loginUrl, processLimit, validDays, validUntil }),
    html: buildWelcomeHtml({ userName, code, loginUrl, appUrl, processLimit, validDays, validUntil })
  });

  return { sent: true, messageId: info.messageId };
}
