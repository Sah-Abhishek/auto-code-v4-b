import { Router } from 'express';
import { AccessRepository } from '../db/accessRepository.js';
import { verifyAdminCredentials, getAdminToken, authenticate } from '../middleware/auth.js';

const router = Router();

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

router.post('/user/login', async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ success: false, error: 'Access code required' });

  const account = await AccessRepository.findByCode(code.trim().toUpperCase());
  const status = await AccessRepository.getStatus(account);
  if (!status.valid) {
    return res.status(401).json({ success: false, error: status.reason });
  }

  await AccessRepository.updateLastLogin(account.code);

  res.json({
    success: true,
    token: account.code,
    user: {
      role: 'user',
      code: account.code,
      name: account.user_name,
      clientName: account.client_name,
      speciality: account.speciality,
      designation: account.designation,
      processLimit: account.process_limit,
      processUsed: account.process_used,
      processRemaining: account.process_limit - account.process_used,
      validUntil: account.valid_until
    }
  });
});

router.get('/me', authenticate, async (req, res) => {
  if (req.auth.role === 'admin') {
    return res.json({ success: true, user: { role: 'admin' } });
  }
  const a = req.auth.account;
  res.json({
    success: true,
    user: {
      role: 'user',
      code: a.code,
      name: a.user_name,
      clientName: a.client_name,
      speciality: a.speciality,
      designation: a.designation,
      processLimit: a.process_limit,
      processUsed: a.process_used,
      processRemaining: a.process_limit - a.process_used,
      validUntil: a.valid_until
    }
  });
});

export default router;
