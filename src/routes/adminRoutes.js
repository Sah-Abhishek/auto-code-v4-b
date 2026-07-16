import { Router } from 'express';
import { AccessRepository } from '../db/accessRepository.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { query } from '../db/connection.js';
import { MessageRepository } from '../db/messageRepository.js';

const router = Router();

const CORRECTION_CATEGORIES = [
  { key: 'reason_for_admit', label: 'Admit Reason' },
  { key: 'ed_em_level', label: 'ED E&M Level' },
  { key: 'primary_diagnosis', label: 'Primary Diagnosis' },
  { key: 'secondary_diagnoses', label: 'Secondary Diagnoses' },
  { key: 'procedures', label: 'Procedures' },
  { key: 'modifiers', label: 'Modifiers' }
];

router.use(authenticate, requireAdmin);

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
        emailVerified: !!a.email_verified,
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

router.post('/accounts/:code/unrevoke', async (req, res) => {
  try {
    const account = await AccessRepository.unrevoke(req.params.code);
    if (!account) return res.status(404).json({ success: false, error: 'Account not found' });
    res.json({ success: true, account });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/accounts/:code', async (req, res) => {
  try {
    const account = await AccessRepository.deleteByCode(req.params.code);
    if (!account) return res.status(404).json({ success: false, error: 'Account not found' });
    res.json({ success: true, account });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Adjust an account's processing-run counters (limit and/or used).
// Body: { processLimit?: int >= 0, processUsed?: int >= 0 }
router.patch('/accounts/:code/process', async (req, res) => {
  try {
    const account = await AccessRepository.findByCode(req.params.code);
    if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

    const parseCount = (value, label) => {
      if (value === undefined || value === null) return undefined;
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`${label} must be a non-negative integer`);
      }
      return n;
    };

    let processLimit, processUsed;
    try {
      processLimit = parseCount(req.body?.processLimit, 'processLimit');
      processUsed = parseCount(req.body?.processUsed, 'processUsed');
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    if (processLimit === undefined && processUsed === undefined) {
      return res.status(400).json({ success: false, error: 'Provide processLimit and/or processUsed' });
    }

    const updated = await AccessRepository.setProcessCounts(req.params.code, { processLimit, processUsed });
    res.json({
      success: true,
      account: {
        code: updated.code,
        processLimit: updated.process_limit,
        processUsed: updated.process_used,
        processRemaining: Math.max(0, updated.process_limit - updated.process_used)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Hide / unhide a processed chart from the owning user's account.
// Hidden charts stay visible to admins but disappear from the user's views.
router.post('/charts/:chartNumber/hide', async (req, res) => {
  try {
    const result = await query(
      `UPDATE charts SET hidden_from_owner = TRUE, updated_at = CURRENT_TIMESTAMP
       WHERE chart_number = $1 RETURNING chart_number, hidden_from_owner`,
      [req.params.chartNumber]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Chart not found' });
    res.json({ success: true, chartNumber: result.rows[0].chart_number, hidden: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/charts/:chartNumber/unhide', async (req, res) => {
  try {
    const result = await query(
      `UPDATE charts SET hidden_from_owner = FALSE, updated_at = CURRENT_TIMESTAMP
       WHERE chart_number = $1 RETURNING chart_number, hidden_from_owner`,
      [req.params.chartNumber]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Chart not found' });
    res.json({ success: true, chartNumber: result.rows[0].chart_number, hidden: false });
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

router.get('/accounts/:code', async (req, res) => {
  try {
    const account = await AccessRepository.findByCode(req.params.code);
    if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

    const now = new Date();
    let status = 'active';
    if (account.revoked) status = 'revoked';
    else if (new Date(account.valid_until) < now) status = 'expired';
    else if (account.process_used >= account.process_limit) status = 'exhausted';

    res.json({
      success: true,
      account: {
        code: account.code,
        clientName: account.client_name,
        speciality: account.speciality,
        userName: account.user_name,
        designation: account.designation,
        email: account.email,
        emailVerified: !!account.email_verified,
        processLimit: account.process_limit,
        processUsed: account.process_used,
        processRemaining: Math.max(0, account.process_limit - account.process_used),
        validDays: account.valid_days,
        validUntil: account.valid_until,
        revoked: account.revoked,
        revokedAt: account.revoked_at,
        lastLoginAt: account.last_login_at,
        createdAt: account.created_at,
        status
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/accounts/:code/charts', async (req, res) => {
  try {
    const { code } = req.params;
    const account = await AccessRepository.findByCode(code);
    if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

    const result = await query(
      `SELECT
         c.id, c.chart_number, c.mrn, c.facility, c.specialty, c.date_of_service,
         c.provider, c.document_count, c.ai_status, c.review_status,
         c.submitted_at, c.submitted_by, c.created_at, c.updated_at,
         c.user_modifications, c.hidden_from_owner
       FROM charts c
       WHERE c.owner_code = $1
       ORDER BY c.created_at DESC`,
      [code]
    );

    const charts = result.rows.map(r => {
      const mods = r.user_modifications || {};
      let correctionCount = 0;
      for (const { key } of CORRECTION_CATEGORIES) {
        if (Array.isArray(mods[key])) correctionCount += mods[key].length;
      }
      return {
        id: r.id,
        chartNumber: r.chart_number,
        mrn: r.mrn,
        facility: r.facility,
        specialty: r.specialty,
        dateOfService: r.date_of_service,
        provider: r.provider,
        documentCount: r.document_count,
        aiStatus: r.ai_status,
        reviewStatus: r.review_status,
        submittedAt: r.submitted_at,
        submittedBy: r.submitted_by,
        correctionCount,
        hidden: !!r.hidden_from_owner,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      };
    });

    res.json({ success: true, charts });
  } catch (err) {
    console.error('Admin list charts failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/accounts/:code/corrections', async (req, res) => {
  try {
    const { code } = req.params;
    const account = await AccessRepository.findByCode(code);
    if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

    const result = await query(
      `SELECT chart_number, mrn, facility, specialty, submitted_at, submitted_by,
              user_modifications
       FROM charts
       WHERE owner_code = $1
         AND user_modifications IS NOT NULL
       ORDER BY COALESCE(submitted_at, updated_at) DESC`,
      [code]
    );

    const byCategory = {};
    for (const { key, label } of CORRECTION_CATEGORIES) {
      byCategory[key] = {
        key,
        label,
        total: 0,
        actions: { modified: 0, rejected: 0, added: 0 },
        items: []
      };
    }

    for (const row of result.rows) {
      const mods = row.user_modifications || {};
      for (const { key } of CORRECTION_CATEGORIES) {
        const entries = Array.isArray(mods[key]) ? mods[key] : [];
        for (const entry of entries) {
          byCategory[key].total += 1;
          const action = entry.action || 'modified';
          if (byCategory[key].actions[action] !== undefined) {
            byCategory[key].actions[action] += 1;
          }
          byCategory[key].items.push({
            chartNumber: row.chart_number,
            mrn: row.mrn,
            facility: row.facility,
            specialty: row.specialty,
            submittedAt: row.submitted_at,
            submittedBy: row.submitted_by,
            action,
            reason: entry.reason || null,
            comment: entry.comment || null,
            original: entry.original || null,
            modified: entry.modified || entry.added || null
          });
        }
      }
    }

    const categories = CORRECTION_CATEGORIES.map(({ key }) => byCategory[key]);
    const totals = categories.reduce(
      (acc, c) => {
        acc.total += c.total;
        acc.modified += c.actions.modified;
        acc.rejected += c.actions.rejected;
        acc.added += c.actions.added;
        return acc;
      },
      { total: 0, modified: 0, rejected: 0, added: 0 }
    );

    res.json({
      success: true,
      chartsWithCorrections: result.rows.length,
      totals,
      categories
    });
  } catch (err) {
    console.error('Admin list corrections failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// All chart-message threads across the system (newest activity first)
router.get('/messages/threads', async (req, res) => {
  try {
    const threads = await MessageRepository.listThreadsForAdmin();
    const totalUnread = threads.reduce((sum, t) => sum + (t.unread_count || 0), 0);
    res.json({ success: true, threads, totalUnread });
  } catch (err) {
    console.error('Admin list threads failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
