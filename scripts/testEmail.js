/**
 * Email feature test script.
 *
 * Exercises the REAL email service (src/services/emailService.js) — the same
 * code path signup / forgot-password use — so a pass here means the live
 * feature works, not a reimplementation of it.
 *
 * Usage:
 *   node scripts/testEmail.js                  # auth check only (no email sent)
 *   node scripts/testEmail.js you@example.com  # auth check + send all 3 emails
 *   node scripts/testEmail.js you@example.com --only=reset
 *
 *   --only=<verify|reset|access>   send just one template (default: all)
 *
 * Recipient may also be supplied via the TEST_EMAIL_TO env var.
 * Reads SMTP_* config from .env, exactly like the app does.
 */
import 'dotenv/config';
import {
  verifyTransport,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendAccessCodeEmail
} from '../src/services/emailService.js';

// Office365 in some environments presents an intermediate cert chain Node
// doesn't bundle; the app sets this same flag in its migrations/startup.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

function parseArgs(argv) {
  const args = { to: process.env.TEST_EMAIL_TO || null, only: 'all' };
  for (const a of argv) {
    if (a.startsWith('--only=')) args.only = a.slice('--only='.length).trim().toLowerCase();
    else if (!a.startsWith('-')) args.to = a.trim();
  }
  return args;
}

function line(char = '─') {
  return char.repeat(56);
}

async function main() {
  const { to, only } = parseArgs(process.argv.slice(2));

  console.log(line('═'));
  console.log('  Email feature test');
  console.log(line('═'));
  console.log(`  SMTP_HOST       : ${process.env.SMTP_HOST || '(unset)'}`);
  console.log(`  SMTP_PORT       : ${process.env.SMTP_PORT || '(unset)'}`);
  console.log(`  SMTP_SECURE     : ${process.env.SMTP_SECURE || '(unset)'}`);
  console.log(`  SMTP_USER       : ${process.env.SMTP_USER || '(unset)'}`);
  console.log(`  SMTP_PASSWORD   : ${process.env.SMTP_PASSWORD ? `set (${process.env.SMTP_PASSWORD.length} chars)` : '(unset)'}`);
  console.log(`  SMTP_FROM_NAME  : ${process.env.SMTP_FROM_NAME || '(falls back to "nxtcodeai")'}`);
  console.log(`  SMTP_FROM_EMAIL : ${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || '(unset)'}`);
  console.log(line());

  // ── Step 1: authentication / connection check ──────────────────────────
  console.log('\n[1/2] Verifying SMTP connection & credentials…');
  const verify = await verifyTransport();
  if (verify.ok) {
    console.log('      ✅ PASS — server reachable and credentials accepted.');
  } else {
    console.log('      ❌ FAIL — could not authenticate.');
    console.log(`         reason       : ${verify.reason}`);
    if (verify.code) console.log(`         code         : ${verify.code}`);
    if (verify.responseCode) console.log(`         responseCode : ${verify.responseCode}`);
    console.log('\n      The SMTP credentials are invalid/expired or SMTP AUTH is');
    console.log('      disabled for this mailbox. Fix SMTP_PASSWORD in .env, then');
    console.log('      re-run. No emails were sent.');
    process.exit(1);
  }

  // ── Step 2: actually send (only if a recipient was provided) ───────────
  if (!to) {
    console.log('\n[2/2] Skipped — no recipient given.');
    console.log('      Auth works. To send real test emails, pass an address:');
    console.log('        node scripts/testEmail.js you@example.com');
    console.log('\n' + line('═'));
    console.log('  RESULT: AUTH OK (no send requested)');
    console.log(line('═'));
    process.exit(0);
  }

  const templates = [
    {
      key: 'verify',
      label: 'Verification email',
      run: () => sendVerificationEmail({
        to,
        userName: 'Test User',
        verifyUrl: `${FRONTEND_URL}/verify-email?token=test-verify-token-123`
      })
    },
    {
      key: 'reset',
      label: 'Password reset email',
      run: () => sendPasswordResetEmail({
        to,
        userName: 'Test User',
        resetUrl: `${FRONTEND_URL}/reset-password?token=test-reset-token-123`
      })
    },
    {
      key: 'access',
      label: 'Access code email',
      run: () => sendAccessCodeEmail({
        to,
        userName: 'Test User',
        code: 'TEST-CODE-1234',
        processLimit: 5,
        validDays: 365,
        validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      })
    }
  ];

  const selected = only === 'all' ? templates : templates.filter((t) => t.key === only);
  if (!selected.length) {
    console.log(`\n❌ Unknown --only=${only}. Valid: verify, reset, access, all.`);
    process.exit(1);
  }

  console.log(`\n[2/2] Sending ${selected.length} test email(s) to ${to}…`);
  let failures = 0;
  for (const t of selected) {
    try {
      const res = await t.run();
      if (res.sent) {
        console.log(`      ✅ ${t.label} — sent (messageId: ${res.messageId})`);
      } else {
        failures++;
        console.log(`      ⚠️  ${t.label} — not sent (${res.reason})`);
      }
    } catch (err) {
      failures++;
      console.log(`      ❌ ${t.label} — error: ${err.message}`);
    }
  }

  console.log('\n' + line('═'));
  if (failures === 0) {
    console.log(`  RESULT: ALL SENT ✅  — check the inbox for ${to}`);
    console.log(line('═'));
    process.exit(0);
  } else {
    console.log(`  RESULT: ${failures} of ${selected.length} FAILED ❌`);
    console.log(line('═'));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nUnexpected error:', err);
  process.exit(1);
});
