import axios from 'axios';
import FormData from 'form-data';
import { config } from '../config.js';

const REPORT_TYPE_DEFAULT = 'CLINIC_NOTE';

const numericConfidenceToLabel = (n) => {
  if (typeof n !== 'number') return n || 'medium';
  if (n >= 0.8) return 'high';
  if (n >= 0.5) return 'medium';
  return 'low';
};

class AIService {
  constructor() {
    const { baseUrl, token, encounterType, pollIntervalMs, pollTimeoutMs, requestTimeoutMs } = config.gateway;
    if (!baseUrl || !token) {
      throw new Error('ICD gateway not configured: ICD_GATEWAY_URL and ICD_GATEWAY_TOKEN are required');
    }
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.encounterType = encounterType;
    this.pollIntervalMs = pollIntervalMs;
    this.pollTimeoutMs = pollTimeoutMs;
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: requestTimeoutMs,
      headers: { Authorization: `Bearer ${token}` }
    });
  }

  /**
   * Run the full Section B encounter pipeline (B1→B5) and return the gateway encounter.
   * `documents` are file buffers fetched from S3 by the worker:
   *   [{ buffer, filename, mimeType, reportType }]
   */
  async processForCoding(documents, chartInfo) {
    try {
      if (!Array.isArray(documents) || documents.length === 0) {
        throw new Error('No documents provided for gateway processing');
      }

      const encounter = await this.createEncounter(chartInfo);
      const encounterId = encounter.id;

      await this.batchUpload(encounterId, documents);
      const { task_id } = await this.runPipeline(encounterId);
      await this.pollUntilDone(encounterId, task_id);
      const finalEncounter = await this.fetchEncounter(encounterId);

      const transformed = this.transformEncounterToDBFormat(finalEncounter);
      return { success: true, data: transformed };
    } catch (error) {
      const detail = error.response?.data ? ` (gateway: ${JSON.stringify(error.response.data).slice(0, 300)})` : '';
      return { success: false, error: `${error.message}${detail}` };
    }
  }

  // No-op kept for backwards compatibility with worker call sites.
  async generateDocumentSummary() {
    return { success: false, error: 'document summary not used in gateway flow' };
  }

  // ────────────────────────────────────────────────────────────
  // Gateway calls
  // ────────────────────────────────────────────────────────────

  async createEncounter(chartInfo) {
    const today = new Date().toISOString().slice(0, 10);
    const body = {
      mrn: chartInfo.mrn || '00000000',
      encounter_type: this.encounterType,
      encounter_date: today,
      facility: chartInfo.facility || undefined,
      department: chartInfo.specialty || undefined,
    };
    const { data } = await this.client.post('/api/encounters', body);
    if (!data?.id) throw new Error('Gateway B1: missing encounter id in response');
    return data;
  }

  async batchUpload(encounterId, documents) {
    const form = new FormData();
    form.append('encounter_id', encounterId);
    form.append('encounter_type', this.encounterType);
    form.append('report_types', documents.map(d => d.reportType || REPORT_TYPE_DEFAULT).join(','));
    for (const doc of documents) {
      form.append('files', doc.buffer, {
        filename: doc.filename,
        contentType: doc.mimeType,
      });
    }
    const { data } = await this.client.post('/api/upload/batch', form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    if (!data || data.failed > 0) {
      throw new Error(`Gateway B2: batch upload reported ${data?.failed ?? '?'} failure(s)`);
    }
    return data;
  }

  async runPipeline(encounterId) {
    const { data } = await this.client.post(`/api/encounters/${encounterId}/run`, {});
    if (!data?.task_id) throw new Error('Gateway B3: missing task_id in response');
    return data;
  }

  async pollUntilDone(encounterId, taskId) {
    const start = Date.now();
    while (Date.now() - start < this.pollTimeoutMs) {
      const { data } = await this.client.get(`/api/encounters/${encounterId}/status/${taskId}`);
      const status = data?.status;
      if (status === 'SUCCESS') return data;
      if (status === 'FAILURE' || status === 'ERROR') {
        throw new Error(`Gateway B4: task ${status}: ${data?.error || 'no error message'}`);
      }
      await new Promise(r => setTimeout(r, this.pollIntervalMs));
    }
    throw new Error(`Gateway B4: poll timeout after ${this.pollTimeoutMs}ms`);
  }

  async fetchEncounter(encounterId) {
    const { data } = await this.client.get(`/api/encounters/${encounterId}`);
    if (!data) throw new Error('Gateway B5: empty response');
    return data;
  }

  // ────────────────────────────────────────────────────────────
  // Mapping gateway encounter → existing DB JSONB shape used by ChartDetail.jsx
  // ────────────────────────────────────────────────────────────

  transformEncounterToDBFormat(encounter) {
    const final = encounter?.final_codes_json || {};
    const agent4 = final.agent4_full || null;
    const summary = encounter?.clinical_summary || {};
    const timing = encounter?.pipeline_timing || {};
    const auditNotes = agent4?.audit_notes || final.audit_notes || '';

    // Prefer the rich agent4_full payload (matches the legacy OpenAI shape exactly).
    // Fall back to mapping the flat final_codes_json.codes[] when agent4_full is absent.
    let diagnosis_codes;
    let procedures;
    let ai_narrative_summary;
    let coding_notes;
    let medications;
    let vitals_summary;
    let lab_results_summary;

    if (agent4) {
      const cc = agent4.coding_categories || {};
      const primaryDx = cc.primary_diagnosis?.codes || [];
      diagnosis_codes = {
        reason_for_admit: cc.reason_for_admit?.codes || [],
        ed_em_level: cc.ed_em_level?.codes || [],
        primary_diagnosis: primaryDx,
        secondary_diagnoses: cc.secondary_diagnoses?.codes || [],
        modifiers: cc.modifiers?.codes || [],
        principal_diagnosis: primaryDx[0] || null,
      };
      procedures = cc.procedures?.codes || [];
      ai_narrative_summary = agent4.ai_narrative_summary || this.buildSummaryFromClinical(summary);
      coding_notes = {
        documentation_gaps: agent4.feedback?.documentation_gaps || [],
        physician_queries_needed: agent4.feedback?.physician_queries_needed || [],
        coding_tips: agent4.feedback?.coding_tips || [],
        compliance_alerts: agent4.feedback?.compliance_alerts || [],
        audit_notes: auditNotes,
      };
      medications = agent4.medications || summary.medications || [];
      vitals_summary = agent4.vitals_summary || summary.vitals || {};
      lab_results_summary = agent4.lab_results_summary || this.labsFromSummary(summary);
    } else {
      // Flat-codes fallback (older gateway responses without agent4_full).
      const flat = this.mapFlatCodes(final.codes || []);
      diagnosis_codes = {
        reason_for_admit: [],
        ed_em_level: [],
        primary_diagnosis: flat.primary,
        secondary_diagnoses: flat.secondary,
        modifiers: [],
        principal_diagnosis: flat.primary[0] || null,
      };
      procedures = flat.procedures;
      ai_narrative_summary = this.buildSummaryFromClinical(summary);
      coding_notes = {
        documentation_gaps: [],
        physician_queries_needed: [],
        coding_tips: [],
        compliance_alerts: [],
        audit_notes: auditNotes,
      };
      medications = summary.medications || [];
      vitals_summary = summary.vitals || {};
      lab_results_summary = this.labsFromSummary(summary);
    }

    return {
      ai_narrative_summary,
      diagnosis_codes,
      procedures,
      coding_notes,
      medications,
      vitals_summary,
      lab_results_summary,
      gateway_encounter: encounter,
      pipeline_timing: timing,
      ai_metadata: {
        provider: 'icd_predictor_gateway',
        encounter_id: encounter?.id || null,
        report_count: encounter?.report_count ?? null,
        used_agent4_full: !!agent4,
      },
    };
  }

  mapFlatCodes(codes) {
    const primary = [];
    const secondary = [];
    const procedures = [];
    for (const c of codes) {
      const base = {
        confidence: numericConfidenceToLabel(c.confidence),
        confidence_score: typeof c.confidence === 'number' ? c.confidence : null,
        ai_reasoning: c.justification || '',
        evidence: { exact_text: '' },
      };
      if (c.code_type === 'cpt') {
        procedures.push({ ...base, cpt_code: c.code, procedure_name: c.description, description: c.description });
      } else if (c.code_type === 'primary') {
        primary.push({ ...base, icd_10_code: c.code, description: c.description });
      } else {
        secondary.push({ ...base, icd_10_code: c.code, description: c.description });
      }
    }
    return { primary, secondary, procedures };
  }

  buildSummaryFromClinical(summary) {
    return {
      patient_demographics: {},
      chief_complaint: summary.chief_complaint || '',
      history_of_present_illness: summary.clinical_context || '',
      social_history: summary.social_history || {},
      vitals: summary.vitals || {},
      assessment_and_plan: {
        assessment: (summary.primary_diagnoses || []).join('; '),
        diagnoses: [
          ...(summary.primary_diagnoses || []),
          ...(summary.secondary_diagnoses || []),
        ],
        plan: (summary.procedures_performed || []).join('; '),
      },
      attending_provider: '',
    };
  }

  labsFromSummary(summary) {
    if (!summary?.significant_labs || !Object.keys(summary.significant_labs).length) return [];
    return Object.entries(summary.significant_labs).map(([test, value]) => ({
      test,
      value,
      flag: '',
      clinical_significance: '',
    }));
  }
}

export const aiService = new AIService();
