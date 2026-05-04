import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

export async function runMessagesMigration(executor) {
  await executor.query(`
    CREATE TABLE IF NOT EXISTS chart_messages (
      id SERIAL PRIMARY KEY,
      chart_id INTEGER NOT NULL REFERENCES charts(id) ON DELETE CASCADE,
      chart_number VARCHAR(100) NOT NULL,
      owner_code VARCHAR(32),
      sender_role VARCHAR(20) NOT NULL,
      sender_name VARCHAR(255),
      body TEXT NOT NULL,
      read_by_admin BOOLEAN DEFAULT FALSE,
      read_by_user BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await executor.query(`CREATE INDEX IF NOT EXISTS idx_chart_messages_chart_id   ON chart_messages(chart_id)`);
  await executor.query(`CREATE INDEX IF NOT EXISTS idx_chart_messages_chart_num  ON chart_messages(chart_number)`);
  await executor.query(`CREATE INDEX IF NOT EXISTS idx_chart_messages_owner_code ON chart_messages(owner_code)`);
  await executor.query(`CREATE INDEX IF NOT EXISTS idx_chart_messages_created_at ON chart_messages(created_at DESC)`);
}

async function runStandalone() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('SET search_path TO medcode, public');
    console.log('Running messages migration...');
    await runMessagesMigration(client);
    console.log('Messages migration complete.');
  } catch (err) {
    console.error('Messages migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runStandalone();
}
