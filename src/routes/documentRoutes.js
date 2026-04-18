import { Router } from 'express';
import { documentController } from '../controllers/documentController.js';
import { upload } from '../middleware/upload.js';
import { authenticate, requireAdmin, requireUser, requireChartOwnership } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

router.get('/health', documentController.healthCheck.bind(documentController));

router.get('/queue/stats', requireAdmin, documentController.getQueueStats.bind(documentController));
router.get('/transactions/stats', requireAdmin, documentController.getTransactionStats.bind(documentController));
router.get('/dashboard/stats', requireAdmin, documentController.getDashboardStats.bind(documentController));

router.get('/status/:chartNumber', requireChartOwnership, documentController.getProcessingStatus.bind(documentController));

router.post(
  '/process',
  requireUser,
  upload.array('files', 20),
  documentController.processDocuments.bind(documentController)
);

export default router;
