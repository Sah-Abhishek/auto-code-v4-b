import { query } from './connection.js';
import crypto from 'crypto';

function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i === 3 || i === 7) out += '-';
  }
  return out;
}

export const AccessRepository = {
  async create({ clientName, speciality, userName, designation, processLimit, validDays, email }) {
    const validUntil = new Date(Date.now() + validDays * 24 * 60 * 60 * 1000);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode();
      try {
        const result = await query(
          `INSERT INTO access_accounts
            (code, client_name, speciality, user_name, designation, process_limit, valid_days, valid_until, email)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [code, clientName, speciality, userName, designation, processLimit, validDays, validUntil, email || null]
        );
        return result.rows[0];
      } catch (err) {
        if (err.code === '23505') continue;
        throw err;
      }
    }
    throw new Error('Failed to generate unique code');
  },

  async findByCode(code) {
    const result = await query(`SELECT * FROM access_accounts WHERE code = $1`, [code]);
    return result.rows[0];
  },

  async getStatus(account) {
    if (!account) return { valid: false, reason: 'Invalid code' };
    if (account.revoked) return { valid: false, reason: 'Access has been revoked' };
    if (new Date(account.valid_until) < new Date()) return { valid: false, reason: 'Access has expired' };
    if (account.process_used >= account.process_limit) return { valid: false, reason: 'No processing runs remaining' };
    return { valid: true };
  },

  async incrementUsed(code) {
    const result = await query(
      `UPDATE access_accounts SET process_used = process_used + 1 WHERE code = $1 RETURNING *`,
      [code]
    );
    return result.rows[0];
  },

  async updateLastLogin(code) {
    await query(`UPDATE access_accounts SET last_login_at = CURRENT_TIMESTAMP WHERE code = $1`, [code]);
  },

  async revoke(code) {
    const result = await query(
      `UPDATE access_accounts SET revoked = TRUE, revoked_at = CURRENT_TIMESTAMP
       WHERE code = $1 RETURNING *`,
      [code]
    );
    return result.rows[0];
  },

  async listAll() {
    const result = await query(`
      SELECT a.*,
        (SELECT COUNT(*) FROM charts WHERE owner_code = a.code) AS chart_count
      FROM access_accounts a
      ORDER BY created_at DESC
    `);
    return result.rows;
  },

  async getAnalytics() {
    const users = await query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE revoked = FALSE AND valid_until > NOW() AND process_used < process_limit) AS active,
        COUNT(*) FILTER (WHERE revoked = TRUE) AS revoked,
        COUNT(*) FILTER (WHERE revoked = FALSE AND valid_until <= NOW()) AS expired,
        COUNT(*) FILTER (WHERE revoked = FALSE AND process_used >= process_limit) AS exhausted
      FROM access_accounts
    `);

    const processing = await query(`
      SELECT
        COALESCE(SUM(process_limit), 0) AS total_allotted,
        COALESCE(SUM(process_used), 0) AS total_used
      FROM access_accounts
    `);

    const charts = await query(`
      SELECT
        COUNT(*) AS total_charts,
        COUNT(*) FILTER (WHERE ai_status = 'ready') AS ready,
        COUNT(*) FILTER (WHERE review_status = 'submitted') AS submitted,
        COUNT(*) FILTER (WHERE ai_status = 'failed') AS failed
      FROM charts
      WHERE owner_code IS NOT NULL
    `);

    return {
      users: users.rows[0],
      processing: processing.rows[0],
      charts: charts.rows[0]
    };
  }
};
