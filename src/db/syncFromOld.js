import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const OLD_URL = process.env.OLD_DATABASE_URL;
const NEW_URL = process.env.DATABASE_URL;

if (!OLD_URL) {
  console.error('❌ OLD_DATABASE_URL not set in .env');
  process.exit(1);
}
if (!NEW_URL) {
  console.error('❌ DATABASE_URL not set in .env');
  process.exit(1);
}

const oldPool = new pg.Pool({
  connectionString: OLD_URL,
  ssl: { rejectUnauthorized: false }
});
const newPool = new pg.Pool({ connectionString: NEW_URL });

// Order matters: parents before children for FKs.
const TABLES = [
  'users',
  'access_accounts',
  'charts',           // referenced by documents, processing_queue
  'documents',
  'processing_queue'
];

async function getColumns(client, schema, table) {
  const r = await client.query(
    `SELECT column_name, data_type, udt_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schema, table]
  );
  return r.rows.map(x => ({
    name: x.column_name,
    dataType: x.data_type,
    udt: x.udt_name
  }));
}

async function tableExists(client, schema, table) {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = $2`,
    [schema, table]
  );
  return r.rowCount > 0;
}

async function syncTable(table) {
  const oldClient = await oldPool.connect();
  const newClient = await newPool.connect();
  try {
    await newClient.query('SET search_path TO medcode, public');

    if (!(await tableExists(oldClient, 'public', table))) {
      console.log(`   ⏭  ${table}: not in old DB, skipping`);
      return;
    }

    const oldCols = await getColumns(oldClient, 'public', table);
    const newCols = await getColumns(newClient, 'medcode', table);
    const newColMap = new Map(newCols.map(c => [c.name, c]));
    const cols = oldCols
      .filter(c => newColMap.has(c.name))
      .map(c => ({ ...c, newUdt: newColMap.get(c.name).udt }));

    if (cols.length === 0) {
      console.log(`   ⚠️  ${table}: no overlapping columns, skipping`);
      return;
    }

    const colList = cols.map(c => `"${c.name}"`).join(', ');
    const { rows } = await oldClient.query(
      `SELECT ${colList} FROM public."${table}"`
    );
    console.log(`   📦 ${table}: ${rows.length} rows`);
    if (rows.length === 0) return;

    const isJsonb = c => c.newUdt === 'jsonb' || c.newUdt === 'json';

    const BATCH = 200;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const values = [];
      const placeholders = batch.map((row, ridx) => {
        const ph = cols.map((c, cidx) => {
          const idx = ridx * cols.length + cidx + 1;
          const raw = row[c.name];
          if (isJsonb(c)) {
            // Stringify here and cast to jsonb so pg doesn't re-encode JS objects
            // into ambiguous text representations.
            values.push(raw == null ? null : JSON.stringify(raw));
            return `$${idx}::jsonb`;
          }
          values.push(raw);
          return `$${idx}`;
        });
        return `(${ph.join(', ')})`;
      }).join(', ');

      const sql = `INSERT INTO medcode."${table}" (${colList}) VALUES ${placeholders}`;
      const r = await newClient.query(sql, values);
      inserted += r.rowCount;
    }
    console.log(`     → inserted ${inserted}`);

    if (cols.some(c => c.name === 'id')) {
      await newClient.query(
        `SELECT setval(
           pg_get_serial_sequence('medcode."${table}"', 'id'),
           COALESCE((SELECT MAX(id) FROM medcode."${table}"), 1),
           (SELECT MAX(id) IS NOT NULL FROM medcode."${table}")
         )`
      );
    }
  } finally {
    oldClient.release();
    newClient.release();
  }
}

async function main() {
  console.log('🔄 Sync: old DB (public) → new DB (medcode)\n');

  // Wipe the freshly migrated tables (only the seed admin lives here) so old
  // data lands cleanly with original IDs intact for FK consistency.
  const c = await newPool.connect();
  try {
    await c.query('SET search_path TO medcode, public');
    console.log('🧹 Truncating destination tables...');
    await c.query(`
      TRUNCATE TABLE
        medcode.processing_queue,
        medcode.documents,
        medcode.charts,
        medcode.users,
        medcode.access_accounts
      RESTART IDENTITY CASCADE
    `);
    console.log('   ✅ truncated\n');
  } finally {
    c.release();
  }

  for (const t of TABLES) {
    try {
      await syncTable(t);
    } catch (err) {
      console.error(`   ❌ ${t} failed: ${err.message}`);
      throw err;
    }
  }

  // If the old DB had no admin user, restore the seed so the app stays usable.
  const post = await newPool.connect();
  try {
    await post.query('SET search_path TO medcode, public');
    const { rows } = await post.query(
      `SELECT 1 FROM medcode.users WHERE role = 'admin' LIMIT 1`
    );
    if (rows.length === 0) {
      console.log('\n👤 No admin found post-sync — re-seeding default admin...');
      const bcrypt = (await import('bcrypt')).default;
      const passwordHash = await bcrypt.hash('admin123', 10);
      await post.query(
        `INSERT INTO medcode.users (user_id, password_hash, name, role, email)
         VALUES ('admin', $1, 'System Administrator', 'admin', 'admin@medcode.ai')
         ON CONFLICT (user_id) DO NOTHING`,
        [passwordHash]
      );
      await post.query(
        `SELECT setval(
           pg_get_serial_sequence('medcode.users', 'id'),
           COALESCE((SELECT MAX(id) FROM medcode.users), 1)
         )`
      );
    }
  } finally {
    post.release();
  }

  await oldPool.end();
  await newPool.end();
  console.log('\n✅ Sync complete.');
}

main().catch(err => {
  console.error('\n❌ Sync failed:', err.message);
  console.error(err);
  oldPool.end().catch(() => {});
  newPool.end().catch(() => {});
  process.exit(1);
});
