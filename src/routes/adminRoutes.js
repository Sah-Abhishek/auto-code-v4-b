import { Router } from 'express';
import { AccessRepository } from '../db/accessRepository.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { sendAccessCodeEmail } from '../services/emailService.js';

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.use(authenticate, requireAdmin);

router.post('/accounts', async (req, res) => {
  try {
    const { clientName, speciality, userName, designation, processLimit, validDays, email } = req.body || {};
    const limit = parseInt(processLimit, 10);
    const days = parseInt(validDays, 10);
    const trimmedEmail = typeof email === 'string' ? email.trim() : '';

    if (!userName || !clientName || !Number.isInteger(limit) || limit < 1 || !Number.isInteger(days) || days < 1) {
      return res.status(400).json({
        success: false,
        error: 'userName, clientName, processLimit (>=1) and validDays (>=1) are required'
      });
    }

    if (trimmedEmail && !EMAIL_RE.test(trimmedEmail)) {
      return res.status(400).json({ success: false, error: 'Invalid email address' });
    }

    const account = await AccessRepository.create({
      clientName,
      speciality: speciality || '',
      userName,
      designation: designation || '',
      processLimit: limit,
      validDays: days,
      email: trimmedEmail || null
    });

    let emailResult = { sent: false, reason: 'no email provided' };
    if (trimmedEmail) {
      try {
        emailResult = await sendAccessCodeEmail({
          to: trimmedEmail,
          userName: account.user_name,
          code: account.code,
          processLimit: account.process_limit,
          validDays: account.valid_days,
          validUntil: account.valid_until
        });
      } catch (mailErr) {
        console.error('Welcome email failed:', mailErr);
        emailResult = { sent: false, reason: mailErr.message };
      }
    }

    res.status(201).json({ success: true, account, email: emailResult });
  } catch (err) {
    console.error('Create account failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/accounts', async (req, res) => {
  try {
    const accounts = await AccessRepository.listAll();
    const now = new Date();
    const enriched = accounts.map(a => {
      let status = 'active';
      if (a.revoked) status = 'revoked';
      else if (new Date(a.valid_until) < now) status = 'expired';
      else if (a.process_used >= a.process_limit) status = 'exhausted';
      return {
        code: a.code,
        clientName: a.client_name,
        speciality: a.speciality,
        userName: a.user_name,
        designation: a.designation,
        email: a.email,
        processLimit: a.process_limit,
        processUsed: a.process_used,
        processRemaining: Math.max(0, a.process_limit - a.process_used),
        validDays: a.valid_days,
        validUntil: a.valid_until,
        revoked: a.revoked,
        revokedAt: a.revoked_at,
        lastLoginAt: a.last_login_at,
        chartCount: parseInt(a.chart_count || 0, 10),
        createdAt: a.created_at,
        status
      };
    });
    res.json({ success: true, accounts: enriched });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/accounts/:code/revoke', async (req, res) => {
  try {
    const account = await AccessRepository.revoke(req.params.code);
    if (!account) return res.status(404).json({ success: false, error: 'Account not found' });
    res.json({ success: true, account });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/analytics', async (req, res) => {
  try {
    const analytics = await AccessRepository.getAnalytics();
    res.json({ success: true, analytics });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
