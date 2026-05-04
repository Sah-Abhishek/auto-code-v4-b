import jwt from 'jsonwebtoken';
import { AccessRepository } from '../db/accessRepository.js';
import { query } from '../db/connection.js';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}. See .env.example.`);
  }
  return v;
}

const ADMIN_TOKEN = requireEnv('ADMIN_TOKEN');
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = requireEnv('ADMIN_PASSWORD');
const JWT_SECRET = process.env.JWT_SECRET || ADMIN_TOKEN;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';

export function verifyAdminCredentials(username, password) {
  return username === ADMIN_USERNAME && password === ADMIN_PASSWORD;
}

export function getAdminToken() {
  return ADMIN_TOKEN;
}

export function signUserJwt(account) {
  return jwt.sign(
    { sub: account.code, role: 'user', email: account.email },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

export async function authenticate(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ success: false, error: 'Authentication required' });

    if (token === ADMIN_TOKEN) {
      req.auth = { role: 'admin' };
      return next();
    }

    let payload = null;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }

    if (payload.role !== 'user' || !payload.sub) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }

    const account = await AccessRepository.findByCode(payload.sub);
    if (!account) return res.status(401).json({ success: false, error: 'Account not found', code: 'ACCESS_INVALID' });
    if (!account.email_verified) {
      return res.status(403).json({ success: false, error: 'Email not verified', code: 'EMAIL_UNVERIFIED' });
    }
    const status = await AccessRepository.getStatus(account);
    if (!status.valid) {
      return res.status(401).json({ success: false, error: status.reason, code: 'ACCESS_INVALID' });
    }

    req.auth = { role: 'user', code: account.code, account };
    next();
  } catch (error) {
    next(error);
  }
}

export function requireAdmin(req, res, next) {
  if (req.auth?.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }
  next();
}

export function requireUser(req, res, next) {
  if (req.auth?.role !== 'user') {
    return res.status(403).json({ success: false, error: 'User access required' });
  }
  next();
}

export async function requireChartOwnership(req, res, next) {
  try {
    if (req.auth?.role === 'admin') return next();
    const { chartNumber } = req.params;
    if (!chartNumber) return next();
    const result = await query(`SELECT owner_code FROM charts WHERE chart_number = $1`, [chartNumber]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Chart not found' });
    if (result.rows[0].owner_code !== req.auth.code) {
      return res.status(404).json({ success: false, error: 'Chart not found' });
    }
    next();
  } catch (error) {
    next(error);
  }
}
