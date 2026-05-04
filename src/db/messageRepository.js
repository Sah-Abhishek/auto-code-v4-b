import { query } from './connection.js';

export const MessageRepository = {

  async getChartByNumber(chartNumber) {
    const result = await query(
      `SELECT id, chart_number, owner_code, mrn, facility, specialty
       FROM charts WHERE chart_number = $1`,
      [chartNumber]
    );
    return result.rows[0] || null;
  },

  async list(chartNumber) {
    const result = await query(
      `SELECT id, chart_id, chart_number, owner_code, sender_role,
              sender_name, body, read_by_admin, read_by_user, created_at
       FROM chart_messages
       WHERE chart_number = $1
       ORDER BY created_at ASC`,
      [chartNumber]
    );
    return result.rows;
  },

  async create({ chartId, chartNumber, ownerCode, senderRole, senderName, body }) {
    const readByAdmin = senderRole === 'admin';
    const readByUser = senderRole === 'user';
    const result = await query(
      `INSERT INTO chart_messages
         (chart_id, chart_number, owner_code, sender_role, sender_name, body,
          read_by_admin, read_by_user)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, chart_id, chart_number, owner_code, sender_role,
                 sender_name, body, read_by_admin, read_by_user, created_at`,
      [chartId, chartNumber, ownerCode, senderRole, senderName, body, readByAdmin, readByUser]
    );
    return result.rows[0];
  },

  async markRead(chartNumber, role) {
    const column = role === 'admin' ? 'read_by_admin' : 'read_by_user';
    await query(
      `UPDATE chart_messages SET ${column} = TRUE
       WHERE chart_number = $1 AND ${column} = FALSE`,
      [chartNumber]
    );
  },

  async listThreadsForAdmin() {
    const result = await query(
      `SELECT
         m.chart_number,
         c.mrn,
         c.facility,
         c.specialty,
         c.owner_code,
         a.user_name AS owner_name,
         a.email     AS owner_email,
         COUNT(*)::int AS message_count,
         SUM(CASE WHEN m.read_by_admin = FALSE AND m.sender_role = 'user' THEN 1 ELSE 0 END)::int AS unread_count,
         MAX(m.created_at) AS last_message_at,
         (SELECT body FROM chart_messages WHERE chart_number = m.chart_number ORDER BY created_at DESC LIMIT 1) AS last_message,
         (SELECT sender_role FROM chart_messages WHERE chart_number = m.chart_number ORDER BY created_at DESC LIMIT 1) AS last_sender_role
       FROM chart_messages m
       JOIN charts c ON c.id = m.chart_id
       LEFT JOIN access_accounts a ON a.code = m.owner_code
       GROUP BY m.chart_number, c.mrn, c.facility, c.specialty, c.owner_code, a.user_name, a.email
       ORDER BY MAX(m.created_at) DESC`
    );
    return result.rows;
  },

  async listThreadsForOwner(ownerCode) {
    const result = await query(
      `SELECT
         m.chart_number,
         c.mrn,
         c.facility,
         COUNT(*)::int AS message_count,
         SUM(CASE WHEN m.read_by_user = FALSE AND m.sender_role = 'admin' THEN 1 ELSE 0 END)::int AS unread_count,
         MAX(m.created_at) AS last_message_at,
         (SELECT body FROM chart_messages WHERE chart_number = m.chart_number ORDER BY created_at DESC LIMIT 1) AS last_message,
         (SELECT sender_role FROM chart_messages WHERE chart_number = m.chart_number ORDER BY created_at DESC LIMIT 1) AS last_sender_role
       FROM chart_messages m
       JOIN charts c ON c.id = m.chart_id
       WHERE m.owner_code = $1
       GROUP BY m.chart_number, c.mrn, c.facility
       ORDER BY MAX(m.created_at) DESC`,
      [ownerCode]
    );
    return result.rows;
  }
};
