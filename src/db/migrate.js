import pg from 'pg';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';

dotenv.config();

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const SCHEMA = 'medcode';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

async function migrate() {
  const client = await pool.connect();

  try {
    console.log(`🚀 Migrating into schema "${SCHEMA}"...\n`);

    await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await client.query(`SET search_path TO ${SCHEMA}, public`);
    console.log(`   ✅ schema "${SCHEMA}" ready\n`);

    console.log('📋 charts...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.charts (
        id SERIAL PRIMARY KEY,
        chart_number VARCHAR(100) UNIQUE NOT NULL,
        mrn VARCHAR(100),
        facility VARCHAR(255),
        specialty VARCHAR(255),
        date_of_service DATE,
        provider VARCHAR(255),
        document_count INTEGER DEFAULT 0,

        ai_status VARCHAR(50) DEFAULT 'queued',
        review_status VARCHAR(50) DEFAULT 'pending',

        ai_summary JSONB,
        diagnosis_codes JSONB,
        procedures JSONB,
        medications JSONB,
        vitals_summary JSONB,
        lab_results_summary JSONB,
        coding_notes JSONB,
        sla_data JSONB,
        gateway_encounter JSONB,

        original_ai_codes JSONB,
        user_modifications JSONB,

        final_codes JSONB,
        submitted_at TIMESTAMP,
        submitted_by VARCHAR(100),

        last_error TEXT,
        last_error_at TIMESTAMP,
        retry_count INTEGER DEFAULT 0,

        processing_started_at TIMESTAMP,
        processing_completed_at TIMESTAMP,

        owner_code VARCHAR(32),
        hidden_from_owner BOOLEAN DEFAULT FALSE,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('📄 documents...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.documents (
        id SERIAL PRIMARY KEY,
        chart_id INTEGER REFERENCES ${SCHEMA}.charts(id) ON DELETE CASCADE,
        document_type VARCHAR(100),
        filename VARCHAR(255),
        original_name VARCHAR(255),
        file_size INTEGER,
        mime_type VARCHAR(100),

        s3_key VARCHAR(500),
        s3_url TEXT,
        s3_bucket VARCHAR(255),

        ocr_status VARCHAR(50) DEFAULT 'pending',
        ocr_text TEXT,
        ocr_processing_time INTEGER,
        ocr_completed_at TIMESTAMP,

        ai_document_summary JSONB,

        transaction_id VARCHAR(100),
        transaction_label VARCHAR(255),
        is_group_member BOOLEAN DEFAULT FALSE,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('⏳ processing_queue...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.processing_queue (
        id SERIAL PRIMARY KEY,
        job_id VARCHAR(100) UNIQUE NOT NULL,
        chart_id INTEGER REFERENCES ${SCHEMA}.charts(id) ON DELETE CASCADE,
        chart_number VARCHAR(100),

        status VARCHAR(50) DEFAULT 'pending',
        job_data JSONB,

        worker_id VARCHAR(100),
        locked_at TIMESTAMP,

        started_at TIMESTAMP,
        completed_at TIMESTAMP,

        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        error_message TEXT,
        retry_after TIMESTAMP,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('👤 users...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.users (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'coder',
        email VARCHAR(255),
        is_active BOOLEAN DEFAULT TRUE,
        last_login TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('🔐 access_accounts...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.access_accounts (
        id SERIAL PRIMARY KEY,
        code VARCHAR(32) UNIQUE NOT NULL,
        client_name VARCHAR(255),
        speciality VARCHAR(255),
        user_name VARCHAR(255),
        designation VARCHAR(255),
        email VARCHAR(255),
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

    console.log('💬 chart_messages...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.chart_messages (
        id SERIAL PRIMARY KEY,
        chart_id INTEGER NOT NULL REFERENCES ${SCHEMA}.charts(id) ON DELETE CASCADE,
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

    console.log('🔍 indexes...');
    const indexes = [
      `CREATE INDEX IF NOT EXISTS idx_charts_ai_status      ON ${SCHEMA}.charts(ai_status)`,
      `CREATE INDEX IF NOT EXISTS idx_charts_review_status  ON ${SCHEMA}.charts(review_status)`,
      `CREATE INDEX IF NOT EXISTS idx_charts_facility       ON ${SCHEMA}.charts(facility)`,
      `CREATE INDEX IF NOT EXISTS idx_charts_specialty      ON ${SCHEMA}.charts(specialty)`,
      `CREATE INDEX IF NOT EXISTS idx_charts_mrn            ON ${SCHEMA}.charts(mrn)`,
      `CREATE INDEX IF NOT EXISTS idx_charts_created_at     ON ${SCHEMA}.charts(created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_charts_date_of_service ON ${SCHEMA}.charts(date_of_service)`,
      `CREATE INDEX IF NOT EXISTS idx_charts_owner_code     ON ${SCHEMA}.charts(owner_code)`,
      `CREATE INDEX IF NOT EXISTS idx_documents_chart_id    ON ${SCHEMA}.documents(chart_id)`,
      `CREATE INDEX IF NOT EXISTS idx_documents_transaction_id ON ${SCHEMA}.documents(transaction_id)`,
      `CREATE INDEX IF NOT EXISTS idx_documents_ocr_status  ON ${SCHEMA}.documents(ocr_status)`,
      `CREATE INDEX IF NOT EXISTS idx_queue_status          ON ${SCHEMA}.processing_queue(status)`,
      `CREATE INDEX IF NOT EXISTS idx_queue_chart_number    ON ${SCHEMA}.processing_queue(chart_number)`,
      `CREATE INDEX IF NOT EXISTS idx_queue_created_at      ON ${SCHEMA}.processing_queue(created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_queue_retry_after     ON ${SCHEMA}.processing_queue(retry_after)`,
      `CREATE INDEX IF NOT EXISTS idx_users_role            ON ${SCHEMA}.users(role)`,
      `CREATE INDEX IF NOT EXISTS idx_users_is_active       ON ${SCHEMA}.users(is_active)`,
      `CREATE INDEX IF NOT EXISTS idx_access_accounts_code  ON ${SCHEMA}.access_accounts(code)`,
      `CREATE INDEX IF NOT EXISTS idx_access_accounts_revoked ON ${SCHEMA}.access_accounts(revoked)`,
      `CREATE INDEX IF NOT EXISTS idx_chart_messages_chart_id  ON ${SCHEMA}.chart_messages(chart_id)`,
      `CREATE INDEX IF NOT EXISTS idx_chart_messages_chart_num ON ${SCHEMA}.chart_messages(chart_number)`,
      `CREATE INDEX IF NOT EXISTS idx_chart_messages_owner_code ON ${SCHEMA}.chart_messages(owner_code)`,
      `CREATE INDEX IF NOT EXISTS idx_chart_messages_created_at ON ${SCHEMA}.chart_messages(created_at DESC)`,
    ];
    for (const sql of indexes) await client.query(sql);

    console.log('👤 default admin...');
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword) {
      throw new Error('ADMIN_PASSWORD env var is required to seed the admin user. See .env.example.');
    }
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    await client.query(
      `INSERT INTO ${SCHEMA}.users (user_id, password_hash, name, role, email)
       VALUES ('admin', $1, 'System Administrator', 'admin', 'admin@medcode.ai')
       ON CONFLICT (user_id) DO NOTHING`,
      [passwordHash]
    );

    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [SCHEMA]
    );
    console.log(`\n   tables in "${SCHEMA}":`);
    tables.rows.forEach(r => console.log(`   - ${r.table_name}`));

    console.log('\n✅ Migration complete.');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    console.error(err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
