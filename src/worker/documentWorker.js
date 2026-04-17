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
import { ocrService } from '../services/ocrService.js';
import { aiService } from '../services/aiService.js';
import { createSLATracker } from '../utils/slaTracker.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import mammoth from 'mammoth';

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

// Word document MIME types
const WORD_MIME_TYPES = [
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
];

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
      // PHASE 1: TEXT EXTRACTION (OCR for PDFs/images, direct for text/Word)
      // ═══════════════════════════════════════════════════════════════
      log.subDivider();
      log.info('OCR_START', `Starting text extraction for ${documents.length} document(s)`);
      sla.markOCRStarted();
      await QueueService.notifyStatusChange(job.job_id, 'processing', 'ocr_started', `Starting text extraction for ${documents.length} document(s)`);

      const ocrResults = [];
      let ocrSuccessCount = 0;
      let ocrFailCount = 0;
      let textFileCount = 0;
      let wordFileCount = 0;

      for (let i = 0; i < documents.length; i++) {
        const doc = documents[i];
        log.info('OCR_PROCESS', `Processing document ${i + 1}/${documents.length}: ${doc.originalName}`);

        try {
          let ocrResult;

          // Check if this is a plain text file - skip OCR and read content directly
          if (doc.mimeType === 'text/plain') {
            textFileCount++;
            log.info('TEXT_FILE', `Skipping OCR for text file: ${doc.originalName}`);
            ocrResult = await this.extractTextFile(doc);
          }
          // Check if this is a Word document - extract text using mammoth
          else if (WORD_MIME_TYPES.includes(doc.mimeType)) {
            wordFileCount++;
            log.info('WORD_FILE', `Extracting text from Word document: ${doc.originalName}`);
            ocrResult = await this.extractWordDocument(doc);
          }
          // Perform OCR for PDFs and images
          else {
            ocrResult = await this.performOCR(doc);
          }

          if (ocrResult.success) {
            ocrSuccessCount++;
            log.success('OCR_COMPLETE', `Document: ${doc.originalName}`, {
              processingTime: `${ocrResult.processingTime}ms`,
              textLength: typeof ocrResult.extractedText === 'string'
                ? ocrResult.extractedText.length
                : JSON.stringify(ocrResult.extractedText).length,
              isTextFile: doc.mimeType === 'text/plain',
              isWordFile: WORD_MIME_TYPES.includes(doc.mimeType)
            });

            // Update document with OCR text
            await DocumentRepository.updateOCRResults(
              doc.documentId,
              typeof ocrResult.extractedText === 'string'
                ? ocrResult.extractedText
                : JSON.stringify(ocrResult.extractedText),
              ocrResult.processingTime
            );

            ocrResults.push({
              ...ocrResult,
              documentId: doc.documentId,
              s3Url: doc.s3Url,
              filename: doc.originalName,
              documentType: doc.documentType
            });

          } else {
            ocrFailCount++;
            log.error('OCR_FAILED', `Document: ${doc.originalName}`, { message: ocrResult.error });

            await DocumentRepository.markOCRFailed(doc.documentId, ocrResult.error);

            ocrResults.push({
              success: false,
              documentId: doc.documentId,
              s3Url: doc.s3Url,
              filename: doc.originalName,
              documentType: doc.documentType,
              error: ocrResult.error
            });
          }
        } catch (ocrError) {
          ocrFailCount++;
          log.error('OCR_EXCEPTION', `Document: ${doc.originalName}`, ocrError);

          await DocumentRepository.markOCRFailed(doc.documentId, ocrError.message);

          ocrResults.push({
            success: false,
            documentId: doc.documentId,
            filename: doc.originalName,
            error: ocrError.message
          });
        }
      }

      sla.markOCRCompleted();
      log.info('OCR_SUMMARY', `Text Extraction Complete: ${ocrSuccessCount} success, ${ocrFailCount} failed, ${textFileCount} text files, ${wordFileCount} Word files (no OCR needed)`);
      await QueueService.notifyStatusChange(job.job_id, 'processing', 'ocr_completed', `Text extraction complete: ${ocrSuccessCount} success, ${ocrFailCount} failed`);

      const successfulOCR = ocrResults.filter(r => r.success);

      if (successfulOCR.length === 0) {
        throw new Error(`All text extraction failed (${ocrFailCount} documents)`);
      }

      // ═══════════════════════════════════════════════════════════════
      // PHASE 2: AI CODING ANALYSIS
      // ═══════════════════════════════════════════════════════════════
      log.subDivider();
      log.info('AI_START', `Starting AI analysis for chart ${chartNumber}`);
      log.info('AI_START', `Documents for AI: ${successfulOCR.length}`);
      sla.markAIStarted();
      await QueueService.notifyStatusChange(job.job_id, 'processing', 'ai_started', `Starting AI analysis with ${successfulOCR.length} document(s)`);

      let aiResult;
      try {
        const formattedDocs = ocrService.formatForAI(ocrResults);
        log.info('AI_PROCESS', `Formatted ${formattedDocs.length} documents for AI`);
        log.info('AI_PROCESS', `Sending to AI service...`);

        const aiStartTime = Date.now();
        aiResult = await aiService.processForCoding(formattedDocs, chartInfo);
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
      await QueueService.notifyStatusChange(job.job_id, 'processing', 'ai_completed', 'AI analysis complete');

      // ═══════════════════════════════════════════════════════════════
      // PHASE 3: DOCUMENT SUMMARIES (Optional - don't fail if this fails)
      // ═══════════════════════════════════════════════════════════════
      log.subDivider();
      log.info('SUMMARY_START', `Generating document summaries`);

      let summaryCount = 0;
      for (const ocrResult of successfulOCR) {
        try {
          const docSummary = await aiService.generateDocumentSummary(ocrResult, chartInfo);
          if (docSummary.success) {
            await DocumentRepository.updateAISummary(ocrResult.documentId, docSummary.data);
            summaryCount++;
          }
        } catch (summaryError) {
          log.warn('SUMMARY_SKIP', `Summary failed for ${ocrResult.filename}: ${summaryError.message}`);
        }
      }

      log.info('SUMMARY_COMPLETE', `Generated ${summaryCount}/${successfulOCR.length} summaries`);

      // ═══════════════════════════════════════════════════════════════
      // PHASE 4: SAVE RESULTS
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

  /**
   * Extract text from a plain text file (no OCR needed)
   * Downloads from S3 and reads the content directly
   */
  async extractTextFile(doc) {
    const startTime = Date.now();

    try {
      log.info('TEXT_DOWNLOAD', `Downloading text file from S3: ${doc.s3Url?.substring(0, 80)}...`);

      // Download file from S3
      const response = await axios.get(doc.s3Url, {
        responseType: 'text',
        timeout: 30000
      });

      const textContent = response.data;
      const processingTime = Date.now() - startTime;

      log.success('TEXT_EXTRACT', `Text file extracted: ${textContent.length} characters in ${processingTime}ms`);

      // Format text with line numbers for consistency with OCR output
      const lines = textContent.split('\n');
      const formattedLines = lines.map((line, index) => ({
        lineNumber: index + 1,
        text: line.trim()
      })).filter(line => line.text.length > 0);

      return {
        success: true,
        filename: doc.originalName,
        documentType: doc.documentType || 'clinical-text',
        extractedText: formattedLines,
        rawText: textContent,
        processingTime,
        isTextFile: true
      };

    } catch (error) {
      log.error('TEXT_ERROR', `Failed to extract text file: ${doc.originalName}`, error);
      return {
        success: false,
        filename: doc.originalName,
        documentType: doc.documentType,
        error: error.message,
        processingTime: Date.now() - startTime
      };
    }
  }

  /**
   * Extract text from a Word document (.doc, .docx)
   * Downloads from S3 and extracts text using mammoth
   */
  async extractWordDocument(doc) {
    const startTime = Date.now();
    let tempPath = null;

    try {
      log.info('WORD_DOWNLOAD', `Downloading Word document from S3: ${doc.s3Url?.substring(0, 80)}...`);

      // Download file from S3
      const response = await axios.get(doc.s3Url, {
        responseType: 'arraybuffer',
        timeout: 60000
      });

      log.info('WORD_DOWNLOAD', `Downloaded ${(response.data.length / 1024).toFixed(1)}KB`);

      // Create temp file for mammoth
      const tempDir = os.tmpdir();
      const safeFilename = doc.originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
      tempPath = path.join(tempDir, `word_${Date.now()}_${safeFilename}`);
      fs.writeFileSync(tempPath, Buffer.from(response.data));

      log.info('WORD_EXTRACT', `Extracting text from Word document...`);

      // Extract text using mammoth
      const result = await mammoth.extractRawText({ path: tempPath });
      const textContent = result.value;
      const processingTime = Date.now() - startTime;

      // Log any warnings from mammoth
      if (result.messages && result.messages.length > 0) {
        result.messages.forEach(msg => {
          if (msg.type === 'warning') {
            log.warn('WORD_EXTRACT', `Mammoth warning: ${msg.message}`);
          }
        });
      }

      log.success('WORD_EXTRACT', `Word document extracted: ${textContent.length} characters in ${processingTime}ms`);

      // Format text with line numbers for consistency with OCR output
      const lines = textContent.split('\n');
      const formattedLines = lines.map((line, index) => ({
        lineNumber: index + 1,
        text: line.trim()
      })).filter(line => line.text.length > 0);

      return {
        success: true,
        filename: doc.originalName,
        documentType: doc.documentType || 'word-document',
        extractedText: formattedLines,
        rawText: textContent,
        processingTime,
        isWordFile: true
      };

    } catch (error) {
      log.error('WORD_ERROR', `Failed to extract Word document: ${doc.originalName}`, error);
      return {
        success: false,
        filename: doc.originalName,
        documentType: doc.documentType,
        error: error.message,
        processingTime: Date.now() - startTime
      };
    } finally {
      // Clean up temp file
      if (tempPath) {
        try {
          fs.unlinkSync(tempPath);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    }
  }

  /**
   * Perform OCR on a document (PDF or image)
   */
  async performOCR(doc) {
    const startTime = Date.now();
    let tempPath = null;

    try {
      log.info('OCR_DOWNLOAD', `Downloading from S3: ${doc.s3Url?.substring(0, 80)}...`);

      // Download file from S3
      const response = await axios.get(doc.s3Url, {
        responseType: 'arraybuffer',
        timeout: 60000
      });

      log.info('OCR_DOWNLOAD', `Downloaded ${(response.data.length / 1024).toFixed(1)}KB`);

      // Create temp file
      const tempDir = os.tmpdir();
      const safeFilename = doc.originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
      tempPath = path.join(tempDir, `ocr_${Date.now()}_${safeFilename}`);
      fs.writeFileSync(tempPath, response.data);

      const tempFile = {
        path: tempPath,
        originalname: doc.originalName,
        mimetype: doc.mimeType
      };

      log.info('OCR_EXTRACT', `Running OCR extraction...`);

      // Run OCR
      const ocrResult = await ocrService.extractText(tempFile, doc.documentType);

      return ocrResult;

    } catch (error) {
      log.error('OCR_ERROR', `OCR failed for ${doc.originalName}`, error);
      return {
        success: false,
        filename: doc.originalName,
        documentType: doc.documentType,
        error: error.message,
        processingTime: Date.now() - startTime
      };
    } finally {
      if (tempPath) {
        try {
          fs.unlinkSync(tempPath);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
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
