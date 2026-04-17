import { ChartRepository, DocumentRepository } from '../db/chartRepository.js';
import { QueueService } from '../db/queueService.js';
import { calculateSLAHours, calculateProcessingDuration } from '../utils/slaTracker.js';

class ChartController {

  /**
   * Get all charts (work queue)
   * GET /api/charts
   */
  async getCharts(req, res) {
    try {
      const {
        facility,
        specialty,
        aiStatus,
        reviewStatus,
        search,
        page = 1,
        limit = 10,
        sortBy,
        sortOrder
      } = req.query;

      const result = await ChartRepository.getAll({
        facility,
        specialty,
        aiStatus,
        reviewStatus,
        search,
        page: parseInt(page),
        limit: parseInt(limit),
        sortBy,
        sortOrder
      });

      // Add SLA info to each chart (processing duration: upload → AI completion)
      // UPDATED: Now includes error tracking fields
      const chartsWithSLA = result.charts.map(chart => {
        const slaInfo = calculateProcessingDuration(chart.created_at, chart.processing_completed_at);

        return {
          id: chart.id,
          mrn: chart.mrn,
          chartNumber: chart.chart_number,
          facility: chart.facility,
          specialty: chart.specialty,
          dateOfService: chart.date_of_service,
          provider: chart.provider,
          documentCount: chart.document_count,
          aiStatus: chart.ai_status,
          reviewStatus: chart.review_status,
          // NEW: Error tracking fields
          lastError: chart.last_error,
          lastErrorAt: chart.last_error_at,
          retryCount: chart.retry_count,
          // SLA info
          sla: slaInfo ? {
            display: slaInfo.display,
            hours: slaInfo.display, // Keep 'hours' for backward compatibility with frontend
            isComplete: slaInfo.isComplete,
            isExcellent: slaInfo.isExcellent,
            isGood: slaInfo.isGood,
            isWarning: slaInfo.isWarning,
            isCritical: slaInfo.isCritical
          } : null,
          createdAt: chart.created_at,
          updatedAt: chart.updated_at
        };
      });

      res.json({
        success: true,
        charts: chartsWithSLA,
        pagination: result.pagination
      });

    } catch (error) {
      console.error('❌ Error fetching charts:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get single chart with full details
   * GET /api/charts/:chartNumber
   */
  async getChart(req, res) {
    try {
      const { chartNumber } = req.params;

      const chart = await ChartRepository.getWithDocuments(chartNumber);

      if (!chart) {
        return res.status(404).json({
          success: false,
          error: 'Chart not found'
        });
      }

      const slaInfo = calculateProcessingDuration(chart.created_at, chart.processing_completed_at);

      res.json({
        success: true,
        chart: {
          id: chart.id,
          mrn: chart.mrn,
          chartNumber: chart.chart_number,
          facility: chart.facility,
          specialty: chart.specialty,
          dateOfService: chart.date_of_service,
          provider: chart.provider,
          documentCount: chart.document_count,
          aiStatus: chart.ai_status,
          reviewStatus: chart.review_status,

          // AI Results (current state - may include modifications)
          aiSummary: chart.ai_summary,
          diagnosisCodes: chart.diagnosis_codes,
          procedures: chart.procedures,
          medications: chart.medications,
          vitalsSummary: chart.vitals_summary,
          labResultsSummary: chart.lab_results_summary,
          codingNotes: chart.coding_notes,

          // Original AI codes (unmodified - for comparison)
          originalAICodes: chart.original_ai_codes,

          // User modifications tracking
          userModifications: chart.user_modifications,

          // Final submitted codes
          finalCodes: chart.final_codes,
          submittedAt: chart.submitted_at,
          submittedBy: chart.submitted_by,

          // Error tracking (NEW)
          lastError: chart.last_error,
          lastErrorAt: chart.last_error_at,
          retryCount: chart.retry_count,

          // SLA
          slaData: chart.sla_data,
          sla: slaInfo,
          processingStartedAt: chart.processing_started_at,
          processingCompletedAt: chart.processing_completed_at,

          // Documents
          documents: chart.documents?.map(doc => ({
            id: doc.id,
            documentType: doc.document_type,
            filename: doc.original_name,
            fileSize: doc.file_size,
            mimeType: doc.mime_type,
            s3Url: doc.s3_url,
            s3Key: doc.s3_key,
            ocrStatus: doc.ocr_status,
            ocrText: doc.ocr_text,
            ocrProcessingTime: doc.ocr_processing_time,
            aiDocumentSummary: doc.ai_document_summary,
            createdAt: doc.created_at
          })),

          createdAt: chart.created_at,
          updatedAt: chart.updated_at
        }
      });

    } catch (error) {
      console.error('❌ Error fetching chart:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Save user modifications to codes
   * POST /api/charts/:chartNumber/modifications
   */
  async saveModifications(req, res) {
    try {
      const { chartNumber } = req.params;
      const { modifications } = req.body;

      if (!modifications) {
        return res.status(400).json({
          success: false,
          error: 'Modifications data is required'
        });
      }

      // Add timestamp to modifications
      const timestampedModifications = {
        ...modifications,
        last_modified_at: new Date().toISOString()
      };

      const chart = await ChartRepository.saveUserModifications(chartNumber, timestampedModifications);

      if (!chart) {
        return res.status(404).json({
          success: false,
          error: 'Chart not found'
        });
      }

      res.json({
        success: true,
        message: 'Modifications saved',
        chart: {
          chartNumber: chart.chart_number,
          reviewStatus: chart.review_status,
          userModifications: chart.user_modifications
        }
      });

    } catch (error) {
      console.error('❌ Error saving modifications:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Submit final codes to NextCode
   * POST /api/charts/:chartNumber/submit
   */
  async submitCodes(req, res) {
    try {
      const { chartNumber } = req.params;
      const { finalCodes, modifications, submittedBy } = req.body;

      if (!finalCodes) {
        return res.status(400).json({
          success: false,
          error: 'Final codes are required'
        });
      }

      // First save the modifications if provided
      if (modifications) {
        await ChartRepository.saveUserModifications(chartNumber, {
          ...modifications,
          submitted_at: new Date().toISOString()
        });
      }

      // Then submit the final codes
      const chart = await ChartRepository.submitFinalCodes(chartNumber, finalCodes, submittedBy);

      if (!chart) {
        return res.status(404).json({
          success: false,
          error: 'Chart not found'
        });
      }

      console.log(`✅ Chart ${chartNumber} submitted to NextCode`);
      console.log(`   Final codes:`, JSON.stringify(finalCodes, null, 2).substring(0, 500));

      res.json({
        success: true,
        message: 'Codes submitted successfully to NextCode',
        chart: {
          chartNumber: chart.chart_number,
          reviewStatus: chart.review_status,
          submittedAt: chart.submitted_at,
          submittedBy: chart.submitted_by,
          finalCodes: chart.final_codes
        }
      });

    } catch (error) {
      console.error('❌ Error submitting codes:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Update chart review status
   * PATCH /api/charts/:chartNumber/status
   */
  async updateStatus(req, res) {
    try {
      const { chartNumber } = req.params;
      const { reviewStatus } = req.body;

      const validStatuses = ['pending', 'in_review', 'submitted', 'rejected'];
      if (!validStatuses.includes(reviewStatus)) {
        return res.status(400).json({
          success: false,
          error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
        });
      }

      const chart = await ChartRepository.updateReviewStatus(chartNumber, reviewStatus);

      if (!chart) {
        return res.status(404).json({
          success: false,
          error: 'Chart not found'
        });
      }

      res.json({
        success: true,
        message: 'Status updated',
        chart: {
          chartNumber: chart.chart_number,
          reviewStatus: chart.review_status
        }
      });

    } catch (error) {
      console.error('❌ Error updating status:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Retry a failed chart's processing
   * POST /api/charts/:chartNumber/retry
   */
  async retryChart(req, res) {
    try {
      const { chartNumber } = req.params;

      // Get the chart
      const chart = await ChartRepository.getByChartNumber(chartNumber);

      if (!chart) {
        return res.status(404).json({
          success: false,
          error: 'Chart not found'
        });
      }

      // Only allow retry for failed or retry_pending charts
      if (!['failed', 'retry_pending'].includes(chart.ai_status)) {
        return res.status(400).json({
          success: false,
          error: `Cannot retry chart with status '${chart.ai_status}'. Only failed charts can be retried.`
        });
      }

      // Get the documents for this chart
      const documents = await DocumentRepository.getByChartId(chart.id);

      if (documents.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No documents found for this chart'
        });
      }

      // Reset the chart status
      await ChartRepository.resetForRetry(chartNumber);

      // Create new job data
      const jobData = {
        chartId: chart.id,
        chartNumber,
        chartInfo: {
          mrn: chart.mrn,
          chartNumber: chart.chart_number,
          facility: chart.facility,
          specialty: chart.specialty,
          dateOfService: chart.date_of_service,
          provider: chart.provider
        },
        documentType: documents[0]?.document_type || 'unknown',
        documents: documents.map(doc => ({
          documentId: doc.id,
          documentType: doc.document_type,
          originalName: doc.original_name,
          mimeType: doc.mime_type,
          fileSize: doc.file_size,
          s3Key: doc.s3_key,
          s3Url: doc.s3_url,
          transactionId: doc.transaction_id
        }))
      };

      // Add new job to queue
      const job = await QueueService.addJob(chart.id, chartNumber, jobData);

      res.json({
        success: true,
        message: 'Chart queued for retry',
        chartNumber,
        jobId: job.job_id,
        previousError: chart.last_error,
        previousAttempts: chart.retry_count
      });

    } catch (error) {
      console.error('Retry chart error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get SLA statistics
   * GET /api/charts/stats/sla
   */
  async getSLAStats(req, res) {
    try {
      const stats = await ChartRepository.getSLAStats();

      res.json({
        success: true,
        stats: {
          pendingReview: parseInt(stats.pending_review || 0),
          queued: parseInt(stats.queued || 0),
          processing: parseInt(stats.processing || 0),
          retry_pending: parseInt(stats.retry_pending || 0),
          failed: parseInt(stats.failed || 0),
          inReview: parseInt(stats.in_review || 0),
          submitted: parseInt(stats.submitted || 0),
          slaWarning: parseInt(stats.sla_warning || 0),
          slaCritical: parseInt(stats.sla_critical || 0),
          total: parseInt(stats.total || 0)
        }
      });
    } catch (error) {
      console.error('Get SLA stats error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get modification analytics
   * GET /api/charts/analytics/modifications
   */
  async getModificationAnalytics(req, res) {
    try {
      const { startDate, endDate, facility } = req.query;

      const data = await ChartRepository.getModificationAnalytics({
        startDate,
        endDate,
        facility
      });

      // Calculate summary statistics
      const totalSubmitted = data.length;
      const chartsWithMods = data.filter(d =>
        d.user_modifications && Object.keys(d.user_modifications).length > 0
      ).length;

      // Aggregate modification reasons
      const reasonCounts = {};
      const categoryModCounts = {
        ed_em_level: 0,
        procedures: 0,
        primary_diagnosis: 0,
        secondary_diagnoses: 0,
        modifiers: 0
      };

      data.forEach(chart => {
        if (chart.user_modifications) {
          Object.entries(chart.user_modifications).forEach(([category, mods]) => {
            if (Array.isArray(mods)) {
              categoryModCounts[category] = (categoryModCounts[category] || 0) + mods.length;
              mods.forEach(mod => {
                if (mod.reason) {
                  reasonCounts[mod.reason] = (reasonCounts[mod.reason] || 0) + 1;
                }
              });
            }
          });
        }
      });

      res.json({
        success: true,
        analytics: {
          summary: {
            totalSubmitted,
            chartsWithModifications: chartsWithMods,
            modificationRate: totalSubmitted > 0 ? (chartsWithMods / totalSubmitted * 100).toFixed(1) : 0
          },
          byCategory: categoryModCounts,
          byReason: reasonCounts,
          recentSubmissions: data.slice(0, 20).map(d => ({
            chartNumber: d.chart_number,
            facility: d.facility,
            submittedAt: d.submitted_at,
            hasModifications: d.user_modifications && Object.keys(d.user_modifications).length > 0
          }))
        }
      });

    } catch (error) {
      console.error('❌ Error fetching analytics:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get comprehensive analytics for dashboard
   * GET /api/charts/analytics/dashboard
   */
  async getDashboardAnalytics(req, res) {
    try {
      const { query } = await import('../db/connection.js');
      const { period = '30' } = req.query;
      const periodDays = parseInt(period);

      // Get overall stats
      const overallStats = await query(`
        SELECT 
          COUNT(*) as total_charts,
          COUNT(*) FILTER (WHERE review_status = 'submitted') as submitted_charts,
          COUNT(*) FILTER (WHERE review_status = 'pending') as pending_charts,
          COUNT(*) FILTER (WHERE review_status = 'in_review') as in_review_charts,
          COUNT(*) FILTER (WHERE ai_status = 'processing') as processing_charts,
          COUNT(*) FILTER (WHERE ai_status = 'queued') as queued_charts,
          COUNT(*) FILTER (WHERE ai_status = 'failed') as failed_charts,
          COUNT(*) FILTER (WHERE ai_status = 'retry_pending') as retry_pending_charts,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '${periodDays} days') as charts_in_period
        FROM charts
      `);

      // Get submitted charts with original codes and modifications for CODE-LEVEL accuracy
      const submittedChartsData = await query(`
        SELECT 
          original_ai_codes,
          user_modifications,
          final_codes,
          facility,
          specialty,
          submitted_at,
          processing_started_at,
          processing_completed_at
        FROM charts 
        WHERE review_status = 'submitted'
        AND submitted_at >= NOW() - INTERVAL '${periodDays} days'
      `);

      // Calculate AI accuracy at code level
      const categories = ['ed_em_level', 'procedures', 'primary_diagnosis', 'secondary_diagnoses', 'modifiers'];

      let totalAICodes = 0;
      let modifiedCodes = 0;
      let rejectedCodes = 0;
      let addedCodes = 0;
      const reasonCounts = {};

      // Track weekly data for trends
      const weeklyData = {};

      submittedChartsData.rows.forEach(chart => {
        const originalCodes = chart.original_ai_codes || {};
        const modifications = chart.user_modifications || {};

        // Get week key for trend tracking
        let weekKey = 'unknown';
        if (chart.submitted_at) {
          const date = new Date(chart.submitted_at);
          const weekStart = new Date(date);
          weekStart.setDate(date.getDate() - date.getDay());
          weekKey = weekStart.toISOString().split('T')[0];
        }

        if (!weeklyData[weekKey]) {
          weeklyData[weekKey] = { totalCodes: 0, unchangedCodes: 0, charts: 0 };
        }
        weeklyData[weekKey].charts++;

        let chartTotalCodes = 0;
        let chartModified = 0;
        let chartRejected = 0;

        // Count original AI codes and modifications per category
        for (const category of categories) {
          const originalInCategory = Array.isArray(originalCodes[category])
            ? originalCodes[category].length
            : 0;

          totalAICodes += originalInCategory;
          chartTotalCodes += originalInCategory;

          const categoryMods = Array.isArray(modifications[category])
            ? modifications[category]
            : [];

          for (const mod of categoryMods) {
            if (mod.action === 'modified') {
              modifiedCodes++;
              chartModified++;
              if (mod.reason) {
                reasonCounts[mod.reason] = (reasonCounts[mod.reason] || 0) + 1;
              }
            } else if (mod.action === 'rejected') {
              rejectedCodes++;
              chartRejected++;
              if (mod.reason) {
                reasonCounts[mod.reason] = (reasonCounts[mod.reason] || 0) + 1;
              }
            } else if (mod.action === 'added') {
              addedCodes++;
            }
          }
        }

        weeklyData[weekKey].totalCodes += chartTotalCodes;
        weeklyData[weekKey].unchangedCodes += (chartTotalCodes - chartModified - chartRejected);
      });

      const unchangedCodes = totalAICodes - modifiedCodes - rejectedCodes;
      const aiAccuracy = totalAICodes > 0 ? ((unchangedCodes / totalAICodes) * 100) : 0;
      const correctionRate = totalAICodes > 0 ? (((modifiedCodes + rejectedCodes) / totalAICodes) * 100) : 0;
      const totalModifications = modifiedCodes + rejectedCodes;

      // Format weekly trends
      const sortedWeeks = Object.keys(weeklyData).filter(k => k !== 'unknown').sort();
      const formattedTrends = sortedWeeks.map((week, idx) => {
        const data = weeklyData[week];
        const weekAccuracy = data.totalCodes > 0
          ? ((data.unchangedCodes / data.totalCodes) * 100)
          : 0;

        return {
          week: `Week ${idx + 1}`,
          date: week,
          total: data.charts,
          totalCodes: data.totalCodes,
          unchangedCodes: data.unchangedCodes,
          acceptanceRate: parseFloat(weekAccuracy.toFixed(1)),
          accuracy: parseFloat(weekAccuracy.toFixed(1))
        };
      });

      // Volume by facility
      const volumeByFacility = await query(`
        SELECT 
          facility,
          COUNT(*) as chart_count
        FROM charts
        WHERE created_at >= NOW() - INTERVAL '${periodDays} days'
        AND facility IS NOT NULL AND facility != ''
        GROUP BY facility
        ORDER BY chart_count DESC
        LIMIT 10
      `);

      // Get processing times
      const processingTimes = await query(`
        SELECT 
          AVG(EXTRACT(EPOCH FROM (processing_completed_at - processing_started_at))/60) as avg_processing_min,
          AVG(EXTRACT(EPOCH FROM (submitted_at - processing_completed_at))/60) as avg_review_min
        FROM charts
        WHERE review_status = 'submitted'
        AND processing_completed_at IS NOT NULL
        AND submitted_at >= NOW() - INTERVAL '${periodDays} days'
      `);

      // Get SLA compliance
      const slaCompliance = await query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (
            WHERE EXTRACT(EPOCH FROM (submitted_at - processing_completed_at))/3600 <= 24
          ) as within_sla
        FROM charts
        WHERE review_status = 'submitted'
        AND processing_completed_at IS NOT NULL
        AND submitted_at >= NOW() - INTERVAL '${periodDays} days'
      `);

      // Get charts per day average
      const chartsPerDay = await query(`
        SELECT 
          COUNT(*)::float / NULLIF(${periodDays}, 0) as avg_per_day
        FROM charts
        WHERE created_at >= NOW() - INTERVAL '${periodDays} days'
      `);

      // Specialty accuracy
      const specialtyData = {};
      submittedChartsData.rows.forEach(chart => {
        if (chart.specialty) {
          if (!specialtyData[chart.specialty]) {
            specialtyData[chart.specialty] = { totalCodes: 0, unchangedCodes: 0 };
          }

          const originalCodes = chart.original_ai_codes || {};
          const modifications = chart.user_modifications || {};

          let chartTotal = 0;
          let chartChanged = 0;

          for (const category of categories) {
            const origCount = Array.isArray(originalCodes[category]) ? originalCodes[category].length : 0;
            chartTotal += origCount;

            const mods = Array.isArray(modifications[category]) ? modifications[category] : [];
            mods.forEach(mod => {
              if (mod.action === 'modified' || mod.action === 'rejected') {
                chartChanged++;
              }
            });
          }

          specialtyData[chart.specialty].totalCodes += chartTotal;
          specialtyData[chart.specialty].unchangedCodes += (chartTotal - chartChanged);
        }
      });

      const specialtyAccuracy = Object.entries(specialtyData)
        .map(([specialty, data]) => ({
          week: specialty,
          specialty,
          accuracy: data.totalCodes > 0
            ? parseFloat(((data.unchangedCodes / data.totalCodes) * 100).toFixed(1))
            : 0,
          totalCodes: data.totalCodes
        }))
        .sort((a, b) => b.totalCodes - a.totalCodes);

      // Calculate metrics
      const slaTotal = parseInt(slaCompliance.rows[0]?.total || 0);
      const slaWithin = parseInt(slaCompliance.rows[0]?.within_sla || 0);
      const slaComplianceRate = slaTotal > 0 ? (slaWithin / slaTotal * 100) : 0;

      // Format correction reasons
      const totalReasonCount = Object.values(reasonCounts).reduce((a, b) => a + b, 0);
      const sortedReasons = Object.entries(reasonCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([reason, count]) => ({
          reason,
          count,
          percentage: totalReasonCount > 0 ? parseFloat((count / totalReasonCount * 100).toFixed(1)) : 0
        }));

      // Build dynamic alerts
      const alerts = [];
      const pendingCharts = parseInt(overallStats.rows[0]?.pending_charts || 0);
      const queuedCharts = parseInt(overallStats.rows[0]?.queued_charts || 0);
      const failedCharts = parseInt(overallStats.rows[0]?.failed_charts || 0);

      if (aiAccuracy < 70 && totalAICodes > 0) {
        alerts.push({
          type: 'warning',
          title: 'Low AI Accuracy',
          message: `AI accuracy is ${aiAccuracy.toFixed(1)}%, below 70% threshold`
        });
      }

      if (correctionRate > 30 && totalAICodes > 0) {
        alerts.push({
          type: 'warning',
          title: 'High Correction Rate',
          message: `${correctionRate.toFixed(1)}% of AI codes required correction`
        });
      }

      if (failedCharts > 0) {
        alerts.push({
          type: 'error',
          title: 'Failed Charts',
          message: `${failedCharts} chart(s) failed processing`
        });
      }

      if (pendingCharts > 0) {
        alerts.push({
          type: pendingCharts > 50 ? 'warning' : 'info',
          title: 'Queue Status',
          message: `${pendingCharts} charts pending review`
        });
      }

      if (queuedCharts > 20) {
        alerts.push({
          type: 'warning',
          title: 'Processing Queue',
          message: `${queuedCharts} charts queued for AI processing`
        });
      }

      if (slaComplianceRate < 90 && slaTotal > 0) {
        alerts.push({
          type: 'warning',
          title: 'SLA Alert',
          message: `SLA compliance at ${slaComplianceRate.toFixed(1)}%`
        });
      }

      if (alerts.length === 0) {
        alerts.push({
          type: 'success',
          title: 'All Systems Normal',
          message: 'No issues detected'
        });
      }

      res.json({
        success: true,
        analytics: {
          summary: {
            aiAccuracy: parseFloat(aiAccuracy.toFixed(1)),
            aiAcceptanceRate: parseFloat(aiAccuracy.toFixed(1)),
            overallAccuracy: parseFloat(aiAccuracy.toFixed(1)),
            correctionRate: parseFloat(correctionRate.toFixed(1)),
            chartsProcessed: parseInt(overallStats.rows[0]?.charts_in_period || 0),
            totalSubmitted: submittedChartsData.rows.length,
            totalAICodes,
            unchangedCodes,
            modifiedCodes,
            rejectedCodes,
            addedCodes,
            totalModifications,
            failedCharts: parseInt(overallStats.rows[0]?.failed_charts || 0),
            retryPendingCharts: parseInt(overallStats.rows[0]?.retry_pending_charts || 0)
          },
          trends: {
            acceptanceRate: formattedTrends,
            weeklyVolume: formattedTrends.map(t => ({ week: t.week, count: t.total }))
          },
          specialtyAccuracy: specialtyAccuracy.length > 0 ? specialtyAccuracy : formattedTrends.map(t => ({
            week: t.week,
            accuracy: t.accuracy
          })),
          volumeByFacility: volumeByFacility.rows.map(r => ({
            facility: r.facility,
            count: parseInt(r.chart_count)
          })),
          correctionReasons: sortedReasons,
          performance: {
            avgProcessingTime: parseFloat(processingTimes.rows[0]?.avg_processing_min || 0).toFixed(1),
            avgReviewTime: parseFloat(processingTimes.rows[0]?.avg_review_min || 0).toFixed(1),
            totalCycleTime: (
              parseFloat(processingTimes.rows[0]?.avg_processing_min || 0) +
              parseFloat(processingTimes.rows[0]?.avg_review_min || 0)
            ).toFixed(1),
            queueBacklog: pendingCharts,
            processingQueue: queuedCharts,
            slaCompliance: parseFloat(slaComplianceRate.toFixed(1)),
            chartsPerDay: parseFloat(chartsPerDay.rows[0]?.avg_per_day || 0).toFixed(1)
          },
          alerts
        }
      });

    } catch (error) {
      console.error('❌ Error fetching dashboard analytics:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get distinct facilities
   * GET /api/charts/filters/facilities
   */
  async getFacilities(req, res) {
    try {
      const { query } = await import('../db/connection.js');
      const result = await query(
        `SELECT DISTINCT facility FROM charts WHERE facility IS NOT NULL AND facility != '' ORDER BY facility`
      );

      res.json({
        success: true,
        facilities: result.rows.map(r => r.facility)
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Get distinct specialties
   * GET /api/charts/filters/specialties
   */
  async getSpecialties(req, res) {
    try {
      const { query } = await import('../db/connection.js');
      const result = await query(
        `SELECT DISTINCT specialty FROM charts WHERE specialty IS NOT NULL AND specialty != '' ORDER BY specialty`
      );

      res.json({
        success: true,
        specialties: result.rows.map(r => r.specialty)
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Delete chart
   * DELETE /api/charts/:chartNumber
   */
  async deleteChart(req, res) {
    try {
      const { chartNumber } = req.params;

      const chart = await ChartRepository.delete(chartNumber);

      if (!chart) {
        return res.status(404).json({
          success: false,
          error: 'Chart not found'
        });
      }

      res.json({
        success: true,
        message: 'Chart deleted',
        chartNumber
      });

    } catch (error) {
      console.error('❌ Error deleting chart:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

export const chartController = new ChartController();
