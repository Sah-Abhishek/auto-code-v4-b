import { query } from './src/db/connection.js';

const marker = `VERIFY-${Date.now()}`;
const res = await query(
  `INSERT INTO charts (chart_number, mrn, facility, specialty, provider)
   VALUES ($1, 'MRN-VERIFY', 'CLAUDE-VERIFICATION', 'verification', 'claude-cli')
   RETURNING id, chart_number, created_at`,
  [marker]
);
console.log('Inserted:', res.rows[0]);
process.exit(0);
