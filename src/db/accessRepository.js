import { query } from './connection.js';
import crypto from 'crypto';
import bcrypt from 'bcrypt';

const BCRYPT_ROUNDS = 10;
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const SELF_SERVE_PROCESS_LIMIT = 5;
const SELF_SERVE_VALID_DAYS = 365;

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

function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
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

  async createSelfServe({ name, email, password, organization, designation }) {
    const normalizedEmail = email.trim().toLowerCase();
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const validUntil = new Date(Date.now() + SELF_SERVE_VALID_DAYS * 24 * 60 * 60 * 1000);
    const verificationToken = generateVerificationToken();
    const verificationExpiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);
    const clientName = organization && organization.trim() ? organization.trim() : null;
    const designationValue = designation && designation.trim() ? designation.trim() : null;

    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode();
      try {
        const result = await query(
          `INSERT INTO access_accounts
            (code, user_name, email, password_hash, client_name, designation,
             process_limit, valid_days, valid_until,
             email_verified, verification_token, verification_expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE, $10, $11)
           RETURNING *`,
          [
            code,
            name.trim(),
            normalizedEmail,
            passwordHash,
            clientName,
            designationValue,
            SELF_SERVE_PROCESS_LIMIT,
            SELF_SERVE_VALID_DAYS,
            validUntil,
            verificationToken,
            verificationExpiresAt
          ]
        );
        return { account: result.rows[0], verificationToken };
      } catch (err) {
        if (err.code === '23505' && err.constraint && err.constraint.includes('email')) {
          const e = new Error('Email already registered');
          e.code = 'EMAIL_TAKEN';
          throw e;
        }
        if (err.code === '23505') continue;
        throw err;
      }
    }
    throw new Error('Failed to generate unique code');
  },

  async findByEmail(email) {
    if (!email) return undefined;
    const result = await query(
      `SELECT * FROM access_accounts WHERE LOWER(email) = LOWER($1)`,
      [email.trim()]
    );
    return result.rows[0];
  },

  async verifyPassword(account, password) {
    if (!account || !account.password_hash) return false;
    return bcrypt.compare(password, account.password_hash);
  },

  async verifyEmailToken(token) {
    if (!token) return { ok: false, reason: 'Missing token' };
    const result = await query(
      `SELECT * FROM access_accounts WHERE verification_token = $1`,
      [token]
    );
    const account = result.rows[0];
    if (!account) return { ok: false, reason: 'Invalid or already-used verification link' };
    if (account.email_verified) return { ok: true, account, alreadyVerified: true };
    if (account.verification_expires_at && new Date(account.verification_expires_at) < new Date()) {
      return { ok: false, reason: 'Verification link has expired. Request a new one.' };
    }
    const updated = await query(
      `UPDATE access_accounts
       SET email_verified = TRUE
       WHERE id = $1
       RETURNING *`,
      [account.id]
    );
    return { ok: true, account: updated.rows[0] };
  },

  async regenerateVerification(email) {
    const account = await this.findByEmail(email);
    if (!account) return { ok: false, reason: 'No account with that email' };
    if (account.email_verified) return { ok: false, reason: 'Email already verified' };
    const verificationToken = generateVerificationToken();
    const verificationExpiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);
    const result = await query(
      `UPDATE access_accounts
       SET verification_token = $1, verification_expires_at = $2
       WHERE id = $3
       RETURNING *`,
      [verificationToken, verificationExpiresAt, account.id]
    );
    return { ok: true, account: result.rows[0], verificationToken };
  },

  async unrevoke(code) {
    const result = await query(
      `UPDATE access_accounts SET revoked = FALSE, revoked_at = NULL
       WHERE code = $1 RETURNING *`,
      [code]
    );
    return result.rows[0];
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
