import { Router } from 'express';
import documentRoutes from './documentRoutes.js';
import chartRoutes from './chartRoutes.js';
import authRoutes from './authRoutes.js';
import adminRoutes from './adminRoutes.js';

const router = Router();

// Bump this whenever the API contract changes so clients can verify
// which build is actually running.
const API_VERSION = '1.2.0-admin-corrections';
const BUILD_FEATURES = [
  'admin-account-profile',
  'admin-account-charts',
  'admin-account-corrections',
  'analytics-by-category'
];

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'MedCode AI Backend',
    version: API_VERSION,
    features: BUILD_FEATURES,
    time: new Date().toISOString()
  });
});

router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);
router.use('/documents', documentRoutes);
router.use('/charts', chartRoutes);

router.get('/', (req, res) => {
  res.json({
    service: 'MedCode AI Backend',
    version: API_VERSION,
    features: BUILD_FEATURES,
    mode: 'async-queue',
    endpoints: {
      health: 'GET /api/health',
      documents: {
        process: 'POST /api/documents/process',
        status: 'GET /api/documents/status/:chartNumber',
        queueStats: 'GET /api/documents/queue/stats',
        health: 'GET /api/documents/health'
      },
      charts: {
        list: 'GET /api/charts',
        get: 'GET /api/charts/:chartNumber',
        modifications: 'POST /api/charts/:chartNumber/modifications',
        submit: 'POST /api/charts/:chartNumber/submit',
        updateStatus: 'PATCH /api/charts/:chartNumber/status',
        delete: 'DELETE /api/charts/:chartNumber',
        slaStats: 'GET /api/charts/stats/sla',
        dashboardAnalytics: 'GET /api/charts/analytics/dashboard',
        modificationAnalytics: 'GET /api/charts/analytics/modifications',
        facilities: 'GET /api/charts/filters/facilities',
        specialties: 'GET /api/charts/filters/specialties'
      }
    }
  });
});

export default router;
