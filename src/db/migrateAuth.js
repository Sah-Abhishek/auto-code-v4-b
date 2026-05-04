import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

export async function runAuthMigration(executor) {
  await executor.query(`ALTER TABLE access_accounts ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)`);
  await executor.query(`ALTER TABLE access_accounts ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE`);
  await executor.query(`ALTER TABLE access_accounts ADD COLUMN IF NOT EXISTS verification_token VARCHAR(255)`);
  await executor.query(`ALTER TABLE access_accounts ADD COLUMN IF NOT EXISTS verification_expires_at TIMESTAMP`);

  await executor.query(`ALTER TABLE access_accounts ALTER COLUMN client_name DROP NOT NULL`).catch(() => {});
  await executor.query(`ALTER TABLE access_accounts ALTER COLUMN speciality DROP NOT NULL`).catch(() => {});
  await executor.query(`ALTER TABLE access_accounts ALTER COLUMN designation DROP NOT NULL`).catch(() => {});

  await executor.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_access_accounts_email_lower
    ON access_accounts (LOWER(email))
    WHERE email IS NOT NULL
  `);
  await executor.query(`CREATE INDEX IF NOT EXISTS idx_access_accounts_verification_token ON access_accounts(verification_token)`);
}

async function runStandalone() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    console.log('Running auth migration...');
    await runAuthMigration(client);
    console.log('Auth migration complete.');
  } catch (err) {
    console.error('Auth migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runStandalone();
}
