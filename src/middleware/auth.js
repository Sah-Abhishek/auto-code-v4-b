import { AccessRepository } from '../db/accessRepository.js';
import { query } from '../db/connection.js';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-admin-token-change-me';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

export function verifyAdminCredentials(username, password) {
  return username === ADMIN_USERNAME && password === ADMIN_PASSWORD;
}

export function getAdminToken() {
  return ADMIN_TOKEN;
}

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

export async function authenticate(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ success: false, error: 'Authentication required' });

  if (token === ADMIN_TOKEN) {
    req.auth = { role: 'admin' };
    return next();
  }

  const account = await AccessRepository.findByCode(token);
  const status = await AccessRepository.getStatus(account);
  if (!status.valid) {
    return res.status(401).json({ success: false, error: status.reason, code: 'ACCESS_INVALID' });
  }

  req.auth = { role: 'user', code: account.code, account };
  next();
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
  if (req.auth?.role === 'admin') return next();
  const { chartNumber } = req.params;
  if (!chartNumber) return next();
  const result = await query(`SELECT owner_code FROM charts WHERE chart_number = $1`, [chartNumber]);
  if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Chart not found' });
  if (result.rows[0].owner_code !== req.auth.code) {
    return res.status(404).json({ success: false, error: 'Chart not found' });
  }
  next();
}
