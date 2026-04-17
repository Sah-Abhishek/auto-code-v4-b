import { WebSocketServer } from 'ws';
import pg from 'pg';
import { config } from '../config.js';
import { QueueService } from '../db/queueService.js';

const { Client } = pg;

class WebSocketService {
  constructor() {
    this.wss = null;
    this.pgClient = null;
    this.subscriptions = new Map(); // jobId -> Set<WebSocket>
    this.pingInterval = null;
  }

  /**
   * Initialize WebSocket server attached to existing HTTP server
   * and start listening for PostgreSQL NOTIFY events
   */
  async init(server) {
    // Create WebSocket server on /api/ws path (so Nginx's /api proxy handles it)
    this.wss = new WebSocketServer({ server, path: '/api/ws' });

    this.wss.on('connection', (ws) => {
      console.log('🔌 WebSocket client connected');

      ws.isAlive = true;
      ws.subscribedJobs = new Set();

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', (data) => {
        this._handleMessage(ws, data);
      });

      ws.on('close', () => {
        this._cleanupClient(ws);
        console.log('🔌 WebSocket client disconnected');
      });

      ws.on('error', (err) => {
        console.error('❌ WebSocket error:', err.message);
        this._cleanupClient(ws);
      });
    });

    // Ping clients every 30s to detect dead connections
    this.pingInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
          this._cleanupClient(ws);
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);

    this.wss.on('close', () => {
      clearInterval(this.pingInterval);
    });

    // Start listening to PostgreSQL notifications
    await this._startPGListener();

    console.log('📡 WebSocket server ready on /api/ws');
  }

  /**
   * Handle incoming WebSocket messages
   */
  _handleMessage(ws, data) {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'subscribe' && msg.jobId) {
        // Add client to subscription map
        if (!this.subscriptions.has(msg.jobId)) {
          this.subscriptions.set(msg.jobId, new Set());
        }
        this.subscriptions.get(msg.jobId).add(ws);
        ws.subscribedJobs.add(msg.jobId);

        ws.send(JSON.stringify({
          type: 'subscribed',
          jobId: msg.jobId,
          timestamp: new Date().toISOString()
        }));

        // Send current job status immediately so client knows where things stand
        this._sendCurrentStatus(ws, msg.jobId);

      } else if (msg.type === 'unsubscribe' && msg.jobId) {
        this._unsubscribeJob(ws, msg.jobId);

        ws.send(JSON.stringify({
          type: 'unsubscribed',
          jobId: msg.jobId,
          timestamp: new Date().toISOString()
        }));
      }
    } catch (err) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format. Expected JSON with { type, jobId }.'
      }));
    }
  }

  /**
   * Fetch current job status from DB and send to client immediately on subscribe
   */
  async _sendCurrentStatus(ws, jobId) {
    try {
      const job = await QueueService.getJob(jobId);
      if (!job) {
        ws.send(JSON.stringify({
          type: 'status_update',
          jobId,
          status: 'not_found',
          phase: 'not_found',
          message: 'Job not found',
          timestamp: new Date().toISOString()
        }));
        return;
      }

      ws.send(JSON.stringify({
        type: 'status_update',
        jobId,
        status: job.status,
        phase: job.status,
        message: job.status === 'completed'
          ? 'Job already completed'
          : job.status === 'failed'
            ? `Job failed: ${job.error_message || 'Unknown error'}`
            : `Job is ${job.status}`,
        timestamp: new Date().toISOString()
      }));
    } catch (err) {
      console.error('❌ Error fetching current job status:', err.message);
    }
  }

  /**
   * Remove a client's subscription for a specific job
   */
  _unsubscribeJob(ws, jobId) {
    const clients = this.subscriptions.get(jobId);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) {
        this.subscriptions.delete(jobId);
      }
    }
    ws.subscribedJobs.delete(jobId);
  }

  /**
   * Clean up all subscriptions for a disconnected client
   */
  _cleanupClient(ws) {
    if (ws.subscribedJobs) {
      for (const jobId of ws.subscribedJobs) {
        this._unsubscribeJob(ws, jobId);
      }
    }
  }

  /**
   * Connect a dedicated PG client and LISTEN on job_status_update channel
   */
  async _startPGListener() {
    this.pgClient = new Client({
      connectionString: config.database.url,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });

    this.pgClient.on('error', (err) => {
      console.error('❌ WebSocket PG listener error:', err.message);
      // Attempt to reconnect after a delay
      setTimeout(() => this._reconnectPGListener(), 5000);
    });

    await this.pgClient.connect();
    await this.pgClient.query('LISTEN job_status_update');

    this.pgClient.on('notification', (msg) => {
      if (msg.channel === 'job_status_update') {
        this._handleNotification(msg.payload);
      }
    });

    console.log('👂 PG LISTEN active on channel: job_status_update');
  }

  /**
   * Reconnect the PG listener if connection drops
   */
  async _reconnectPGListener() {
    try {
      if (this.pgClient) {
        try { await this.pgClient.end(); } catch (e) { /* ignore */ }
      }
      await this._startPGListener();
      console.log('🔄 PG listener reconnected');
    } catch (err) {
      console.error('❌ PG listener reconnect failed:', err.message);
      setTimeout(() => this._reconnectPGListener(), 10000);
    }
  }

  /**
   * Handle a NOTIFY payload and push to subscribed WebSocket clients
   */
  _handleNotification(payload) {
    try {
      const update = JSON.parse(payload);
      const { jobId } = update;

      const clients = this.subscriptions.get(jobId);
      if (!clients || clients.size === 0) return;

      const message = JSON.stringify({ type: 'status_update', ...update });

      for (const ws of clients) {
        if (ws.readyState === 1) { // WebSocket.OPEN
          ws.send(message);
        }
      }
    } catch (err) {
      console.error('❌ Error handling PG notification:', err.message);
    }
  }

  /**
   * Graceful shutdown
   */
  async close() {
    clearInterval(this.pingInterval);

    if (this.wss) {
      this.wss.clients.forEach((ws) => ws.terminate());
      this.wss.close();
    }

    if (this.pgClient) {
      try { await this.pgClient.end(); } catch (e) { /* ignore */ }
    }
  }
}

export const websocketService = new WebSocketService();
export default websocketService;
