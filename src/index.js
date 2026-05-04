import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import routes from './routes/index.js';
import { pool } from './db/connection.js';
import { websocketService } from './services/websocketService.js';
import { runAuthMigration } from './db/migrateAuth.js';

// Safety net: never let an async route handler / pg event take the process down.
// We log loudly so issues stay visible, but the server keeps serving traffic.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error('❌ Unhandled rejection:', err.code || err.message);
});
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception:', err?.code || err?.message || err);
});

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.url.includes('/api/charts')) {
    console.log(`📨 ${req.method} ${req.url}`);
  }
  next();
});

// Routes
app.use('/api', routes);

app.get('/', (req, res) => {
  res.json({
    message: 'MedCode AI Backend',
    api: '/api'
  });
});

// Error handling
const DB_TRANSIENT_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH',
  'EAI_AGAIN', 'EPIPE',
  '57P01', '57P02', '57P03', '08000', '08001', '08003', '08004', '08006', '08007', '08P01',
]);
const isDbTransient = (err) => {
  if (!err) return false;
  if (DB_TRANSIENT_CODES.has(err.code)) return true;
  if (Array.isArray(err.errors) && err.errors.some(e => DB_TRANSIENT_CODES.has(e?.code))) return true;
  return false;
};

app.use((error, req, res, next) => {
  console.error('❌ Error:', error.code || error.message);
  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, error: 'File too large (max 25MB)' });
  }
  if (isDbTransient(error)) {
    res.set('Retry-After', '5');
    return res.status(503).json({ success: false, error: 'Service temporarily unavailable, please retry' });
  }
  res.status(500).json({ success: false, error: error.message });
});

// Test database connection and start server
async function startServer() {
  try {
    // Test DB connection
    await pool.query('SELECT NOW()');
    console.log('✅ Database connected');

    // Idempotent migrations for additive columns (safe on fresh + existing DBs)
    await pool.query(`ALTER TABLE charts ADD COLUMN IF NOT EXISTS gateway_encounter JSONB`);
    await runAuthMigration(pool);
    console.log('✅ Auth migration applied');

    // Start server and capture HTTP server instance for WebSocket
    const server = app.listen(config.port, async () => {
      console.log('\n' + '═'.repeat(50));
      console.log('🏥 MedCode AI Backend');
      console.log('═'.repeat(50));
      console.log(`🚀 Server: http://localhost:${config.port}`);
      console.log(`📡 API: http://localhost:${config.port}/api`);
      console.log(`🤖 ICD Gateway: ${config.gateway.baseUrl || '(not configured)'}`);
      console.log(`📦 Database: Connected`);

      // Initialize WebSocket
      try {
        await websocketService.init(server);
        console.log(`🔌 WebSocket: ws://localhost:${config.port}/api/ws`);
      } catch (err) {
        console.error('❌ WebSocket init failed:', err.message);
      }

      console.log('═'.repeat(50) + '\n');
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
}

startServer();

export default app;
