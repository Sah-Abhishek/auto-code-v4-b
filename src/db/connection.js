import pg from 'pg';
import dns from 'dns';
import { config } from '../config.js';

// Prefer IPv4. Neon publishes both A and AAAA; on hosts without an IPv6 route
// (most of our deploy targets), AAAA-first causes ENETUNREACH on every IPv6
// address before falling back to IPv4 — burning the connect budget.
dns.setDefaultResultOrder('ipv4first');

const { Pool } = pg;

// Disable TLS certificate validation for Neon
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const POOL_MAX = parseInt(process.env.PG_POOL_MAX) || 20;
const POOL_MIN = parseInt(process.env.PG_POOL_MIN) || 0;
const CONNECT_TIMEOUT_MS = parseInt(process.env.PG_CONNECT_TIMEOUT_MS) || 10_000;
const IDLE_TIMEOUT_MS = parseInt(process.env.PG_IDLE_TIMEOUT_MS) || 30_000;
const QUERY_TIMEOUT_MS = parseInt(process.env.PG_QUERY_TIMEOUT_MS) || 30_000;
const STATEMENT_TIMEOUT_MS = parseInt(process.env.PG_STATEMENT_TIMEOUT_MS) || 30_000;
const QUERY_RETRIES = parseInt(process.env.PG_QUERY_RETRIES ?? '3');

export const pool = new Pool({
  connectionString: config.database.url,
  max: POOL_MAX,
  min: POOL_MIN,
  connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  idleTimeoutMillis: IDLE_TIMEOUT_MS,
  query_timeout: QUERY_TIMEOUT_MS,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  allowExitOnIdle: false,
});

// Pin search_path and server-side timeouts on every new connection. Server-side
// statement_timeout is a hard cap that survives even if the client process
// disappears mid-query, preventing runaway transactions on Neon.
pool.on('connect', (client) => {
  const setup = `
    SET search_path TO medcode, public;
    SET statement_timeout = ${STATEMENT_TIMEOUT_MS};
    SET idle_in_transaction_session_timeout = ${STATEMENT_TIMEOUT_MS};
    SET lock_timeout = 5000;
  `;
  client.query(setup).catch((err) => {
    console.error('❌ Failed to initialize connection:', err.message);
  });
});

// Pool emits 'error' for idle clients dropped by the server (Neon recycles
// idle connections). Without a listener, Node treats it as unhandled and
// terminates the process. We log and let pg-pool drop the bad client.
pool.on('error', (err) => {
  console.error('❌ Pool idle-client error:', err.code || err.message);
});

const TRANSIENT_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH',
  'EAI_AGAIN', 'EPIPE',
  // Postgres SQLSTATEs for connection / admin shutdown / cannot-connect-now
  '57P01', '57P02', '57P03', '08000', '08001', '08003', '08004', '08006', '08007', '08P01',
]);

const isTransient = (err) => {
  if (!err) return false;
  if (TRANSIENT_CODES.has(err.code)) return true;
  // pg's AggregateError on multi-IP connect failure
  if (Array.isArray(err.errors) && err.errors.some(e => TRANSIENT_CODES.has(e?.code))) return true;
  return false;
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const query = async (text, params, { retries = QUERY_RETRIES } = {}) => {
  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    const start = Date.now();
    try {
      const result = await pool.query(text, params);
      const duration = Date.now() - start;
      if (duration > 1000) {
        console.log(`⚠️ Slow query (${duration}ms):`, text.substring(0, 80));
      }
      return result;
    } catch (error) {
      lastErr = error;
      if (attempt < retries && isTransient(error)) {
        const backoff = Math.min(2000, 200 * 2 ** attempt) + Math.floor(Math.random() * 150);
        console.warn(`⚠️ Transient DB error (${error.code || error.message}); retry ${attempt + 1}/${retries} in ${backoff}ms`);
        await sleep(backoff);
        attempt++;
        continue;
      }
      console.error('❌ Query error:', error.message);
      throw error;
    }
  }
  throw lastErr;
};

// Acquire a client with retry on transient connection errors. Use this
// instead of pool.connect() for transactional work (e.g. claimNextJob).
export const getClient = async ({ retries = QUERY_RETRIES } = {}) => {
  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    try {
      return await pool.connect();
    } catch (error) {
      lastErr = error;
      if (attempt < retries && isTransient(error)) {
        const backoff = Math.min(2000, 200 * 2 ** attempt) + Math.floor(Math.random() * 150);
        console.warn(`⚠️ Transient DB connect error (${error.code || error.message}); retry ${attempt + 1}/${retries} in ${backoff}ms`);
        await sleep(backoff);
        attempt++;
        continue;
      }
      throw error;
    }
  }
  throw lastErr;
};

export default { pool, query, getClient };
