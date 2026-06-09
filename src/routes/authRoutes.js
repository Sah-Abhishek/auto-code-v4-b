import { Router } from 'express';
import { AccessRepository } from '../db/accessRepository.js';
import { verifyAdminCredentials, getAdminToken, authenticate, signUserJwt } from '../middleware/auth.js';
import { sendVerificationEmail, sendPasswordResetEmail } from '../services/emailService.js';

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

function buildVerifyUrl(token) {
  return `${FRONTEND_URL}/verify-email?token=${encodeURIComponent(token)}`;
}

function buildResetUrl(token) {
  return `${FRONTEND_URL}/reset-password?token=${encodeURIComponent(token)}`;
}

function publicUser(account) {
  return {
    role: 'user',
    name: account.user_name,
    email: account.email,
    organization: account.client_name,
    designation: account.designation,
    emailVerified: !!account.email_verified,
    processLimit: account.process_limit,
    processUsed: account.process_used,
    processRemaining: Math.max(0, account.process_limit - account.process_used),
    validUntil: account.valid_until
  };
}

router.post('/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username and password required' });
  }
  if (!verifyAdminCredentials(username, password)) {
    return res.status(401).json({ success: false, error: 'Invalid credentials' });
  }
  res.json({
    success: true,
    token: getAdminToken(),
    user: { role: 'admin', username }
  });
});

router.post('/signup', async (req, res) => {
  try {
    const { name, email, password, organization, designation, phone } = req.body || {};
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    const trimmedEmail = typeof email === 'string' ? email.trim() : '';
    const trimmedOrg = typeof organization === 'string' ? organization.trim() : '';
    const trimmedDesignation = typeof designation === 'string' ? designation.trim() : '';
    const trimmedPhone = typeof phone === 'string' ? phone.trim() : '';
    const pw = typeof password === 'string' ? password : '';

    if (!trimmedName) return res.status(400).json({ success: false, error: 'Name is required' });
    if (!EMAIL_RE.test(trimmedEmail)) return res.status(400).json({ success: false, error: 'Valid email is required' });
    if (pw.length < 8) return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    if (!trimmedOrg) return res.status(400).json({ success: false, error: 'Organization is required' });
    // Phone format: leading "+", country code, then 6-15 digits (E.164-ish, allowing spaces/dashes that we strip).
    const phoneDigits = trimmedPhone.replace(/[\s-]/g, '');
    if (!/^\+\d{1,4}\d{6,15}$/.test(phoneDigits)) {
      return res.status(400).json({ success: false, error: 'Valid phone number with country code is required' });
    }

    const existing = await AccessRepository.findByEmail(trimmedEmail);
    if (existing) {
      return res.status(409).json({ success: false, error: 'An account with that email already exists', code: 'EMAIL_TAKEN' });
    }

    const { account, verificationToken } = await AccessRepository.createSelfServe({
      name: trimmedName,
      email: trimmedEmail,
      password: pw,
      organization: trimmedOrg,
      designation: trimmedDesignation,
      phone: phoneDigits
    });

    let emailResult = { sent: false };
    try {
      emailResult = await sendVerificationEmail({
        to: account.email,
        userName: account.user_name,
        verifyUrl: buildVerifyUrl(verificationToken)
      });
    } catch (mailErr) {
      console.error('Verification email failed:', mailErr.message);
      emailResult = { sent: false, reason: mailErr.message };
    }

    res.status(201).json({
      success: true,
      requiresVerification: true,
      email: account.email,
      emailDelivery: emailResult
    });
  } catch (err) {
    if (err.code === 'EMAIL_TAKEN') {
      return res.status(409).json({ success: false, error: err.message, code: 'EMAIL_TAKEN' });
    }
    console.error('Signup failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const trimmedEmail = typeof email === 'string' ? email.trim() : '';
    const pw = typeof password === 'string' ? password : '';

    if (!trimmedEmail || !pw) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }

    const account = await AccessRepository.findByEmail(trimmedEmail);
    if (!account || !account.password_hash) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }
    const ok = await AccessRepository.verifyPassword(account, pw);
    if (!ok) return res.status(401).json({ success: false, error: 'Invalid email or password' });

    if (!account.email_verified) {
      return res.status(403).json({
        success: false,
        error: 'Please verify your email before signing in',
        code: 'EMAIL_UNVERIFIED',
        email: account.email
      });
    }
    if (account.revoked) {
      return res.status(403).json({ success: false, error: 'Your account has been revoked', code: 'REVOKED' });
    }
    if (new Date(account.valid_until) < new Date()) {
      return res.status(403).json({ success: false, error: 'Your account has expired', code: 'EXPIRED' });
    }

    await AccessRepository.updateLastLogin(account.code);

    res.json({
      success: true,
      token: signUserJwt(account),
      user: publicUser(account)
    });
  } catch (err) {
    console.error('Login failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/verify-email', async (req, res) => {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const result = await AccessRepository.verifyEmailToken(token);
    if (!result.ok) {
      return res.status(400).json({ success: false, error: result.reason });
    }
    res.json({ success: true, alreadyVerified: !!result.alreadyVerified, email: result.account.email });
  } catch (err) {
    console.error('Verify-email failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/resend-verification', async (req, res) => {
  try {
    const { email } = req.body || {};
    const trimmedEmail = typeof email === 'string' ? email.trim() : '';
    if (!EMAIL_RE.test(trimmedEmail)) {
      return res.status(400).json({ success: false, error: 'Valid email is required' });
    }
    const result = await AccessRepository.regenerateVerification(trimmedEmail);
    // Always respond with success to avoid leaking which emails are registered
    if (!result.ok) {
      return res.json({ success: true });
    }
    try {
      await sendVerificationEmail({
        to: result.account.email,
        userName: result.account.user_name,
        verifyUrl: buildVerifyUrl(result.verificationToken)
      });
    } catch (mailErr) {
      console.error('Resend verification email failed:', mailErr.message);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Resend verification failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};
    const trimmedEmail = typeof email === 'string' ? email.trim() : '';
    if (!EMAIL_RE.test(trimmedEmail)) {
      return res.status(400).json({ success: false, error: 'Valid email is required' });
    }
    const result = await AccessRepository.createPasswordReset(trimmedEmail);
    // Always respond with success to avoid leaking which emails are registered
    if (result.ok) {
      try {
        await sendPasswordResetEmail({
          to: result.account.email,
          userName: result.account.user_name,
          resetUrl: buildResetUrl(result.resetToken)
        });
      } catch (mailErr) {
        console.error('Password reset email failed:', mailErr.message);
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Forgot password failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    const tok = typeof token === 'string' ? token : '';
    const pw = typeof password === 'string' ? password : '';
    if (!tok) {
      return res.status(400).json({ success: false, error: 'Missing reset token' });
    }
    if (pw.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }
    const result = await AccessRepository.resetPasswordWithToken(tok, pw);
    if (!result.ok) {
      return res.status(400).json({ success: false, error: result.reason });
    }
    res.json({ success: true, email: result.account.email });
  } catch (err) {
    console.error('Reset password failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/me', authenticate, async (req, res) => {
  if (req.auth.role === 'admin') {
    return res.json({ success: true, user: { role: 'admin' } });
  }
  res.json({ success: true, user: publicUser(req.auth.account) });
});

export default router;
