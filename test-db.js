import pg from 'pg';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const pool = new pg.Pool({
  host: 'public-primary-pg-innoida-189506-1653768.db.onutho.com',
  port: 5432,
  user: 'medextract',
  password: 'x#wBg4!J8sk#Q976V!',
  database: 'medextract',
  ssl: { rejectUnauthorized: false }
});

try {
  console.log('Connecting...');
  const result = await pool.query('SELECT NOW() as time, current_user as user');
  console.log('✅ Connected!');
  console.log('Time:', result.rows[0].time);
  console.log('User:', result.rows[0].user);
} catch (err) {
  console.log('❌ Failed:', err.message);
} finally {
  await pool.end();
  process.exit();
}
