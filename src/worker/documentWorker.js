/**
 * Document Processing Worker
 * 
 * Run this as a separate process: node workers/documentWorker.js
 * 
 * UPDATED: Added comprehensive logging at every step
 * UPDATED: Added support for text/plain files - skips OCR and uses content directly
 * UPDATED: Added support for Word documents (.doc, .docx) - extracts text using mammoth
 */

import { QueueService } from '../db/queueService.js';
import { ChartRepository, DocumentRepository } from '../db/chartRepository.js';
import { aiService } from '../services/aiService.js';
import { createSLATracker } from '../utils/slaTracker.js';
import os from 'os';
import axios from 'axios';

const DOC_TYPE_TO_REPORT_TYPE = {
  'ed-notes': 'ED_NOTE',
  'labs': 'LAB',
  'radiology': 'RADIOLOGY',
  'discharge': 'DISCHARGE_SUMMARY',
};
const mapReportType = (documentType) => DOC_TYPE_TO_REPORT_TYPE[documentType] || 'CLINIC_NOTE';

// ═══════════════════════════════════════════════════════════════
// LOGGING UTILITY
// ═══════════════════════════════════════════════════════════════
const log = {
  info: (stage, message, data = null) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ℹ️  [${stage}] ${message}`);
    if (data) console.log(`    └─ Data:`, typeof data === 'object' ? JSON.stringify(data, null, 2).substring(0, 500) : data);
  },
  success: (stage, message, data = null) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ✅ [${stage}] ${message}`);
    if (data) console.log(`    └─ Data:`, typeof data === 'object' ? JSON.stringify(data, null, 2).substring(0, 500) : data);
  },
  error: (stage, message, error = null) => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ❌ [${stage}] ${message}`);
    if (error) {
      console.error(`    └─ Error:`, error.message || error);
      if (error.stack) console.error(`    └─ Stack:`, error.stack.split('\n').slice(0, 3).join('\n'));
    }
  },
  warn: (stage, message, data = null) => {
    const timestamp = new Date().toISOString();
    console.warn(`[${timestamp}] ⚠️  [${stage}] ${message}`);
    if (data) console.warn(`    └─ Data:`, data);
  },
  divider: () => {
    console.log('\n' + '═'.repeat(70) + '\n');
  },
  subDivider: () => {
    console.log('─'.repeat(50));
  }
};

class DocumentWorker {
  constructor() {
    this.workerId = `worker-${os.hostname()}-${process.pid}`;
    this.isRunning = false;
    this.pollInterval = 2000;
    this.shutdownRequested = false;
  }

  async start() {
    log.divider();
    log.info('WORKER', `Started with ID: ${this.workerId}`);
    log.info('WORKER', `Poll interval: ${this.pollInterval}ms`);
    log.divider();

    this.isRunning = true;

    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());

    // Release stuck jobs on startup
    try {
      const stuckJobs = await QueueService.releaseStuckJobs(30);
      if (stuckJobs.length > 0) {
        log.warn('WORKER', `Released ${stuckJobs.length} stuck jobs on startup`);
      }
    } catch (error) {
      log.error('WORKER', 'Failed to release stuck jobs', error);
    }

    // Main processing loop
    while (this.isRunning) {
      try {
        await this.processNextJob();
      } catch (error) {
        log.error('WORKER', 'Unexpected error in main loop', error);
        await this.sleep(5000);
      }

      if (this.isRunning) {
        await this.sleep(this.pollInterval);
      }
    }

    log.divider();
    log.info('WORKER', 'Stopped');
    log.divider();
  }

  async processNextJob() {
    // Try to claim a job
    const job = await QueueService.claimNextJob(this.workerId);

    if (!job) {
      return; // No jobs available
    }

    log.divider();
    log.info('JOB_START', `Claimed job: ${job.job_id}`);
    log.info('JOB_START', `Attempt ${job.attempts}/${job.max_attempts}`);

    const sla = createSLATracker();
    sla.markUploadReceived();

    let jobData;
    let chartNumber = 'unknown';

    try {
      // Parse job data
      jobData = typeof job.job_data === 'string' ? JSON.parse(job.job_data) : job.job_data;
      chartNumber = jobData.chartNumber;

      log.info('JOB_START', `Chart: ${chartNumber}`);
      log.info('JOB_START', `Documents to process: ${jobData.documents?.length || 0}`);

      const { chartId, chartInfo, documents } = jobData;

      // Update chart status to processing
      log.info('STATUS', `Setting chart ${chartNumber} to 'processing'`);
      await ChartRepository.updateStatus(chartNumber, 'processing');
      await QueueService.notifyStatusChange(job.job_id, 'processing', 'processing', `Processing chart ${chartNumber}`);

      // ═══════════════════════════════════════════════════════════════
      // PHASE 1: DOWNLOAD FILES FROM S3 (gateway handles OCR itself)
      // ═══════════════════════════════════════════════════════════════
      log.subDivider();
      log.info('DOWNLOAD_START', `Downloading ${documents.length} file(s) from S3 for gateway`);
      sla.markOCRStarted();
      await QueueService.notifyStatusChange(job.job_id, 'processing', 'download_started', `Downloading ${documents.length} document(s) for gateway`);

      const gatewayDocs = [];
      const failedDownloads = [];
      for (let i = 0; i < documents.length; i++) {
        const doc = documents[i];
        log.info('DOWNLOAD', `File ${i + 1}/${documents.length}: ${doc.originalName}`);
        try {
          const response = await axios.get(doc.s3Url, { responseType: 'arraybuffer', timeout: 60000 });
          gatewayDocs.push({
            documentId: doc.documentId,
            buffer: Buffer.from(response.data),
            filename: doc.originalName,
            mimeType: doc.mimeType,
            reportType: mapReportType(doc.documentType),
          });
        } catch (dlError) {
          log.error('DOWNLOAD_FAILED', `${doc.originalName}: ${dlError.message}`);
          failedDownloads.push({ filename: doc.originalName, error: dlError.message });
          await DocumentRepository.markOCRFailed(doc.documentId, `S3 download failed: ${dlError.message}`);
        }
      }

      sla.markOCRCompleted();
      log.info('DOWNLOAD_SUMMARY', `Downloaded ${gatewayDocs.length}/${documents.length} files`);
      await QueueService.notifyStatusChange(job.job_id, 'processing', 'download_completed', `Downloaded ${gatewayDocs.length}/${documents.length} files`);

      if (gatewayDocs.length === 0) {
        throw new Error(`All S3 downloads failed (${failedDownloads.length} documents)`);
      }

      // ═══════════════════════════════════════════════════════════════
      // PHASE 2: ICD PREDICTOR GATEWAY (encounter flow B1→B5)
      // ═══════════════════════════════════════════════════════════════
      log.subDivider();
      log.info('AI_START', `Starting gateway encounter pipeline for chart ${chartNumber}`);
      log.info('AI_START', `Documents for gateway: ${gatewayDocs.length}`);
      sla.markAIStarted();
      await QueueService.notifyStatusChange(job.job_id, 'processing', 'ai_started', `Starting gateway pipeline with ${gatewayDocs.length} document(s)`);

      let aiResult;
      try {
        const aiStartTime = Date.now();
        aiResult = await aiService.processForCoding(gatewayDocs, chartInfo);
        const aiDuration = Date.now() - aiStartTime;

        log.info('AI_RESPONSE', `AI responded in ${aiDuration}ms`);
        log.info('AI_RESPONSE', `AI result success: ${aiResult?.success}`);

        if (aiResult?.error) {
          log.error('AI_RESPONSE', `AI error message: ${aiResult.error}`);
        }

        if (!aiResult) {
          log.error('AI_FAILED', `AI returned null/undefined response`);
          throw new Error('AI processing failed: No response from AI service');
        }

        if (!aiResult.success) {
          log.error('AI_FAILED', `AI returned success=false`, {
            error: aiResult.error,
            fullResponse: JSON.stringify(aiResult).substring(0, 1000)
          });
          throw new Error(`AI processing failed: ${aiResult.error || 'Unknown AI error'}`);
        }

        if (!aiResult.data) {
          log.error('AI_FAILED', `AI returned success=true but no data`);
          throw new Error('AI processing failed: No data in AI response');
        }

        log.success('AI_COMPLETE', `AI analysis successful for chart ${chartNumber}`, {
          hasDiagnosisCodes: !!aiResult.data?.diagnosis_codes,
          hasProcedures: !!aiResult.data?.procedures,
          hasSummary: !!aiResult.data?.ai_narrative_summary,
          dataKeys: Object.keys(aiResult.data || {})
        });

      } catch (aiError) {
        log.error('AI_EXCEPTION', `AI processing threw exception`, aiError);
        sla.markAICompleted();
        throw aiError;
      }

      sla.markAICompleted();
      await QueueService.notifyStatusChange(job.job_id, 'processing', 'ai_completed', 'Gateway pipeline complete');

      // ═══════════════════════════════════════════════════════════════
      // PHASE 3: SAVE RESULTS
      // ═══════════════════════════════════════════════════════════════
      log.subDivider();
      log.info('SAVE_START', `Saving AI results to database`);
      await QueueService.notifyStatusChange(job.job_id, 'processing', 'saving_results', 'Saving results to database');

      sla.markComplete();
      const slaSummary = sla.getSummary();

      try {
        await ChartRepository.updateWithAIResults(chartNumber, aiResult.data, slaSummary);
        log.success('SAVE_COMPLETE', `Chart ${chartNumber} updated with AI results`);
      } catch (saveError) {
        log.error('SAVE_FAILED', `Failed to save AI results`, saveError);
        throw saveError;
      }

      // Mark job as completed
      await QueueService.completeJob(job.job_id);
      await QueueService.notifyStatusChange(job.job_id, 'completed', 'completed', `Chart ${chartNumber} processed successfully`);

      log.divider();
      log.success('JOB_COMPLETE', `Chart ${chartNumber} processed successfully`, {
        totalDuration: slaSummary.durations.total,
        ocrDuration: slaSummary.durations.ocr,
        aiDuration: slaSummary.durations.ai,
        slaStatus: slaSummary.slaStatus.status
      });

    } catch (error) {
      log.divider();
      log.error('JOB_FAILED', `Chart ${chartNumber} processing failed`, error);

      await this.handleJobFailure(job, error.message, chartNumber);
    }
  }

  /**
   * Handle job failure with proper status updates and logging
   */
  async handleJobFailure(job, errorMessage, chartNumber) {
    log.info('FAILURE_HANDLING', `Processing failure for chart ${chartNumber}`);

    try {
      // Mark job as failed
      const failResult = await QueueService.failJob(job.job_id, errorMessage);

      if (!failResult) {
        log.error('FAILURE_HANDLING', `Could not update job status for ${job.job_id}`);
        return;
      }

      log.info('FAILURE_HANDLING', `Job marked as failed`, {
        attempts: failResult.attempts,
        maxAttempts: failResult.max_attempts,
        willRetry: failResult.willRetry,
        retryAfter: failResult.retryAfter
      });

      await QueueService.notifyStatusChange(
        job.job_id,
        'failed',
        'failed',
        failResult.willRetry
          ? `Failed (attempt ${failResult.attempts}/${failResult.max_attempts}), will retry`
          : `Permanently failed: ${errorMessage}`
      );

      // Get chartNumber from job if not provided
      if (!chartNumber || chartNumber === 'unknown') {
        try {
          const jobData = typeof job.job_data === 'string' ? JSON.parse(job.job_data) : job.job_data;
          chartNumber = jobData.chartNumber;
        } catch (e) {
          log.error('FAILURE_HANDLING', `Could not extract chartNumber from job`);
          return;
        }
      }

      // Update chart status
      if (failResult.isPermanentlyFailed) {
        log.warn('FAILURE_HANDLING', `Chart ${chartNumber} PERMANENTLY FAILED (max attempts reached)`);
        await ChartRepository.markFailed(chartNumber, errorMessage);
      } else {
        const retryInSeconds = Math.round((failResult.retryAfter - new Date()) / 1000);
        log.info('FAILURE_HANDLING', `Chart ${chartNumber} set to RETRY_PENDING (retry in ${retryInSeconds}s)`);
        await ChartRepository.updateWithError(
          chartNumber,
          errorMessage,
          true,
          failResult.attempts
        );
      }

    } catch (handlingError) {
      log.error('FAILURE_HANDLING', `Error while handling failure`, handlingError);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  shutdown() {
    if (this.shutdownRequested) return;
    log.warn('WORKER', 'Shutdown requested, finishing current job...');
    this.shutdownRequested = true;
    this.isRunning = false;
  }
}

// Run the worker
const worker = new DocumentWorker();
worker.start().catch(error => {
  log.error('FATAL', 'Worker crashed', error);
  process.exit(1);
});

export default DocumentWorker;
