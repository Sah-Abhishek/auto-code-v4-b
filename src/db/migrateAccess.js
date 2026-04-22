import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Creating access_accounts table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS access_accounts (
        id SERIAL PRIMARY KEY,
        code VARCHAR(32) UNIQUE NOT NULL,
        client_name VARCHAR(255),
        speciality VARCHAR(255),
        user_name VARCHAR(255),
        designation VARCHAR(255),
        process_limit INTEGER NOT NULL,
        process_used INTEGER DEFAULT 0,
        valid_days INTEGER NOT NULL,
        valid_until TIMESTAMP NOT NULL,
        revoked BOOLEAN DEFAULT FALSE,
        revoked_at TIMESTAMP,
        last_login_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_access_accounts_code ON access_accounts(code)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_access_accounts_revoked ON access_accounts(revoked)`);

    console.log('Adding email column to access_accounts...');
    await client.query(`ALTER TABLE access_accounts ADD COLUMN IF NOT EXISTS email VARCHAR(255)`);

    console.log('Adding owner_code column to charts...');
    await client.query(`ALTER TABLE charts ADD COLUMN IF NOT EXISTS owner_code VARCHAR(32)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_charts_owner_code ON charts(owner_code)`);

    console.log('Migration complete.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
