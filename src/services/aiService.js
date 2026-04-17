import OpenAI from 'openai';
import { config } from '../config.js';

class AIService {
  constructor() {
    this.client = new OpenAI({
      apiKey: config.ai.apiKey
    });
    this.model = config.ai.model;
  }

  /**
   * Build the system prompt for medical coding
   */
  getSystemPrompt() {
    return `You are an expert medical coder and clinical documentation specialist with extensive experience in ED/Emergency Department coding, ICD-10-CM diagnosis coding, CPT procedure coding, and modifier application.

Your task is to analyze clinical documents and extract ALL applicable codes organized into these specific categories:

1. **Reason for Admit**: The principal reason or condition that caused the patient to seek care. This is typically derived from the chief complaint and should be an ICD-10-CM code. This may differ from the primary diagnosis.

2. **Primary Diagnosis (PDX)**: The SINGLE principal ICD-10-CM diagnosis code - the main condition established after study to be chiefly responsible for the visit.

3. **Secondary Diagnoses (SDX)**: ALL additional ICD-10-CM diagnosis codes. This typically includes:
   - Conditions treated during the visit
   - Comorbidities affecting care (diabetes, hypertension, etc.)
   - Chronic conditions being monitored
   - Risk factors (family history, tobacco use, etc.)
   - Status codes (Z codes for history, screening, etc.)
   - External cause codes if applicable
   
   IMPORTANT: Include ALL relevant secondary diagnoses - real medical charts often have 10-20+ secondary codes.

4. **Procedures (CPT)**: ALL CPT procedure codes for procedures performed. Multiple procedures are common - include ALL that apply.

5. **ED/EM Level**: Evaluation & Management codes for emergency department visits (99281-99285) or office/outpatient visits (99202-99215). Include MDM justification.

6. **Modifiers**: ALL applicable modifiers for procedures and E/M codes. Common modifiers:
   - 25: Significant separate E/M with procedure
   - 59/XE/XS/XP/XU: Distinct procedural services
   - 76/77: Repeat procedures
   - LT/RT: Laterality
   - PT: Physical therapy
   - TC/26: Technical/Professional component

7. **Detailed Clinical Summary**: Provide comprehensive clinical narrative including:
   - Patient demographics (age, sex)
   - Chief complaint with onset, duration, severity
   - Detailed HPI with all relevant elements
   - Physical examination findings by system
   - Vital signs
   - Assessment and plan
   - Timeline of care
   - Clinical alerts and critical findings

8. **Feedback**: Documentation gaps, coding tips, and physician queries.

CRITICAL REQUIREMENTS:
- Extract ALL applicable codes, not just the most obvious ones
- For EVERY code, provide the EXACT text evidence from the document
- Use the most specific ICD-10 code possible (include all digits)
- Real charts typically have multiple procedures and many secondary diagnoses
- Be thorough - missing codes means missed revenue and incomplete clinical picture
- Provide detailed, actionable clinical summaries

OUTPUT FORMAT: Valid JSON only, no markdown.`;
  }

  /**
   * Build the user prompt with document content
   */
  buildUserPrompt(formattedDocuments, chartInfo) {
    const documentContent = formattedDocuments.map(doc => {
      const lines = doc.content.map(l => `[Line ${l.lineNumber}] ${l.text}`).join('\n');
      return `
=== DOCUMENT: ${doc.documentName} ===
Type: ${doc.documentType}
Total Lines: ${doc.totalLines}

CONTENT:
${lines}
`;
    }).join('\n\n');

    return `Analyze the following clinical documents and extract ALL applicable medical codes with a detailed clinical summary.

PATIENT INFORMATION:
- MRN: ${chartInfo.mrn || 'Not provided'}
- Chart Number: ${chartInfo.chartNumber || 'Not provided'}
- Facility: ${chartInfo.facility || 'Not provided'}
- Specialty: ${chartInfo.specialty || 'Not provided'}
- Date of Service: ${chartInfo.dateOfService || 'Not provided'}

CLINICAL DOCUMENTS:
${documentContent}

Extract ALL codes and respond with this JSON structure:

{
  "ai_narrative_summary": {
    "patient_demographics": {
      "age": "Patient age if found",
      "sex": "Patient sex if found",
      "weight": "Weight if documented",
      "allergies": ["List of allergies"]
    },
    "chief_complaint": {
      "text": "Detailed chief complaint - what brought the patient in",
      "onset": "When symptoms started",
      "duration": "How long symptoms have persisted",
      "severity": "Severity rating or description",
      "associated_symptoms": ["List of associated symptoms"],
      "evidence": {
        "document_type": "",
        "document_name": "",
        "line_number": "",
        "exact_text": ""
      }
    },
    "history_of_present_illness": {
      "text": "Comprehensive HPI narrative covering all 8 elements where documented",
      "location": "Where is the problem",
      "quality": "Character of the symptom",
      "severity": "1-10 or descriptive",
      "duration": "How long",
      "timing": "When does it occur",
      "context": "What was patient doing",
      "modifying_factors": "What makes it better/worse",
      "associated_signs_symptoms": "Related findings",
      "evidence": {
        "document_type": "",
        "document_name": "",
        "line_number": "",
        "exact_text": ""
      }
    },
    "review_of_systems": {
      "constitutional": "Fever, weight loss, fatigue, etc.",
      "cardiovascular": "Chest pain, palpitations, edema, etc.",
      "respiratory": "SOB, cough, wheezing, etc.",
      "gastrointestinal": "N/V, diarrhea, abdominal pain, etc.",
      "musculoskeletal": "Joint pain, swelling, weakness, etc.",
      "neurological": "Headache, dizziness, numbness, etc.",
      "psychiatric": "Depression, anxiety, etc.",
      "other_systems": "Any other documented systems"
    },
    "past_medical_history": {
      "conditions": ["List of past medical conditions"],
      "surgeries": ["List of past surgeries"],
      "hospitalizations": ["List of past hospitalizations"]
    },
    "medications": {
      "current": ["List of current medications with doses"],
      "allergies": ["Drug allergies"]
    },
    "social_history": {
      "tobacco": "Tobacco use status",
      "alcohol": "Alcohol use status",
      "drugs": "Drug use status",
      "occupation": "Occupation if relevant",
      "living_situation": "Living situation if documented"
    },
    "family_history": {
      "relevant_conditions": ["List of relevant family history"]
    },
    "physical_examination": {
      "general": "General appearance",
      "vitals": {
        "blood_pressure": "",
        "heart_rate": "",
        "respiratory_rate": "",
        "temperature": "",
        "oxygen_saturation": "",
        "pain_score": ""
      },
      "heent": "Head, eyes, ears, nose, throat exam",
      "neck": "Neck examination",
      "cardiovascular": "Heart exam findings",
      "respiratory": "Lung exam findings",
      "abdomen": "Abdominal exam findings",
      "extremities": "Extremity exam",
      "neurological": "Neuro exam",
      "skin": "Skin exam",
      "psychiatric": "Mental status"
    },
    "diagnostic_results": {
      "labs": [
        {
          "test": "Test name",
          "value": "Result value",
          "unit": "Unit",
          "flag": "normal/high/low/critical",
          "clinical_significance": "Why this matters"
        }
      ],
      "imaging": [
        {
          "study": "Study name",
          "findings": "Key findings",
          "impression": "Radiologist impression"
        }
      ],
      "ekg": "EKG findings if performed",
      "other_tests": ["Other diagnostic tests"]
    },
    "assessment_and_plan": {
      "assessment": "Clinical assessment summary - what the provider concluded",
      "diagnoses": ["List of diagnoses addressed"],
      "plan": "Treatment plan summary",
      "disposition": "Discharge, admit, transfer, etc.",
      "follow_up": "Follow up instructions"
    },
    "timeline_of_care": [
      {
        "time": "Time of event",
        "event": "What happened",
        "description": "Details of the event",
        "provider": "Who was involved",
        "evidence": {
          "document_type": "",
          "document_name": "",
          "line_number": "",
          "exact_text": ""
        }
      }
    ],
    "clinical_alerts": [
      {
        "alert": "Important clinical finding or concern",
        "severity": "high/medium/low",
        "action_required": "What should be done",
        "evidence": {
          "document_type": "",
          "document_name": "",
          "line_number": "",
          "exact_text": ""
        }
      }
    ],
    "attending_provider": "Attending physician name",
    "consulting_providers": ["List of consultants"]
  },
  "coding_categories": {
    "reason_for_admit": {
      "codes": [
        {
          "icd_10_code": "R10.9",
          "description": "Unspecified abdominal pain",
          "ai_reasoning": "This is the reason the patient presented to the ED - the chief complaint that drove the encounter",
          "confidence": "high",
          "evidence": [
            {
              "document_type": "",
              "document_name": "",
              "line_number": "",
              "exact_text": ""
            }
          ]
        }
      ]
    },
    "primary_diagnosis": {
      "codes": [
        {
          "icd_10_code": "K35.80",
          "description": "Unspecified acute appendicitis",
          "ai_reasoning": "This is the main condition established after study - the primary diagnosis after workup",
          "confidence": "high",
          "evidence": [
            {
              "document_type": "",
              "document_name": "",
              "line_number": "",
              "exact_text": ""
            }
          ]
        }
      ]
    },
    "secondary_diagnoses": {
      "codes": [
        {
          "icd_10_code": "E11.9",
          "description": "Type 2 diabetes mellitus without complications",
          "ai_reasoning": "Documented comorbidity affecting care",
          "confidence": "high",
          "evidence": [
            {
              "document_type": "",
              "document_name": "",
              "line_number": "",
              "exact_text": ""
            }
          ]
        }
      ]
    },
    "procedures": {
      "codes": [
        {
          "cpt_code": "99284",
          "procedure_name": "ED visit, moderate-high severity",
          "description": "Description of procedure performed",
          "provider": "Provider name if found",
          "date": "Date performed",
          "findings": ["Finding 1", "Finding 2"],
          "ai_reasoning": "Why this code was selected",
          "confidence": "high",
          "evidence": {
            "document_type": "",
            "document_name": "",
            "line_number": "",
            "exact_text": ""
          }
        }
      ]
    },
    "ed_em_level": {
      "codes": [
        {
          "code": "99284",
          "description": "Emergency department visit, moderate-high severity",
          "level_justification": {
            "mdm_complexity": "Moderate to High",
            "number_of_diagnoses": "Multiple diagnoses addressed",
            "data_reviewed": "Labs, imaging reviewed",
            "risk_of_complications": "Moderate risk - prescription drug management"
          },
          "ai_reasoning": "Detailed reasoning for this E/M level selection",
          "confidence": "high",
          "evidence": [
            {
              "document_type": "",
              "document_name": "",
              "line_number": "",
              "exact_text": ""
            }
          ]
        }
      ]
    },
    "modifiers": {
      "codes": [
        {
          "modifier_code": "25",
          "modifier_name": "Significant, Separately Identifiable E/M Service",
          "applies_to_code": "99284",
          "ai_reasoning": "E/M service provided in addition to procedure",
          "confidence": "high",
          "evidence": {
            "document_type": "",
            "document_name": "",
            "line_number": "",
            "exact_text": ""
          }
        }
      ]
    }
  },
  "feedback": {
    "documentation_gaps": [
      {
        "gap": "Description of documentation gap",
        "impact": "How this affects coding accuracy or reimbursement",
        "suggestion": "What documentation would help",
        "priority": "high/medium/low"
      }
    ],
    "physician_queries_needed": [
      {
        "query": "Question for physician",
        "reason": "Why this clarification is needed",
        "impact_on_coding": "How the answer would change coding",
        "priority": "high/medium/low"
      }
    ],
    "coding_tips": [
      {
        "tip": "Coding recommendation or optimization",
        "related_code": "Code this relates to",
        "potential_impact": "Revenue or compliance impact"
      }
    ],
    "compliance_alerts": [
      {
        "alert": "Compliance concern",
        "regulation": "Relevant regulation or guideline",
        "severity": "high/medium/low",
        "recommended_action": "What to do"
      }
    ]
  },
  "medications": [
    {
      "name": "Medication name",
      "dose": "Dose",
      "route": "Route of administration",
      "frequency": "Frequency",
      "indication": "Why prescribed",
      "new_or_existing": "new/existing"
    }
  ],
  "vitals_summary": {
    "blood_pressure": "",
    "heart_rate": "",
    "respiratory_rate": "",
    "temperature": "",
    "oxygen_saturation": "",
    "pain_score": ""
  },
  "lab_results_summary": [
    {
      "test": "Test name",
      "value": "Result",
      "unit": "Unit",
      "flag": "normal/high/low/critical",
      "clinical_significance": "Why this matters"
    }
  ],
  "metadata": {
    "patient_age": "",
    "sex": "",
    "date_of_service": "${chartInfo.dateOfService || ''}",
    "facility": "${chartInfo.facility || ''}",
    "attending_provider": "",
    "documents_analyzed": ${formattedDocuments.length},
    "total_codes_extracted": 0
  }
}

IMPORTANT CODING GUIDELINES:

1. **Reason for Admit vs Primary Diagnosis**:
   - Reason for Admit: Why the patient came in (chief complaint as ICD-10)
   - Primary Diagnosis: What was found/diagnosed after evaluation
   - These may be the same or different depending on the case

2. **ED/EM Level Selection (99281-99285)**:
   - 99281: Straightforward MDM, self-limited problem
   - 99282: Low MDM, 2+ self-limited problems or 1 acute uncomplicated
   - 99283: Moderate MDM, 1 acute uncomplicated illness with systemic symptoms
   - 99284: Moderate-High MDM, 1 acute illness with systemic symptoms or 1 acute complicated injury
   - 99285: High MDM, 1+ acute/chronic illness posing threat to life or function

3. **Secondary Diagnoses - Include ALL of these if documented**:
   - Active conditions being treated
   - Chronic conditions (diabetes, hypertension, COPD, etc.)
   - Family history codes (Z80-Z84)
   - Personal history codes (Z85-Z87)
   - Status codes (Z93-Z99)
   - BMI codes if documented
   - Tobacco/alcohol use codes
   - Screening encounter codes
   - External cause codes for injuries

4. **Modifiers - Common combinations**:
   - E/M + Procedure: Usually needs modifier 25 on E/M
   - Multiple procedures: May need 59, XE, XS, XP, or XU
   - Screening procedures: PT modifier
   - Bilateral: 50 or RT/LT

5. **Clinical Summary Requirements**:
   - Be comprehensive - include all documented findings
   - Organize by clinical relevance
   - Highlight critical values and abnormal findings
   - Note any missing documentation

6. Extract ALL codes supported by documentation - be thorough!
7. Every code MUST have evidence with exact_text from the document
8. Return ONLY valid JSON, no markdown code blocks`;
  }

  /**
   * Process documents through AI for ICD coding
   */
  async processForCoding(formattedDocuments, chartInfo) {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: this.getSystemPrompt()
          },
          {
            role: 'user',
            content: this.buildUserPrompt(formattedDocuments, chartInfo)
          }
        ],
        max_completion_tokens: 12000,
        temperature: 0.1,
        response_format: { type: "json_object" }
      });

      const textContent = response.choices[0]?.message?.content;
      if (!textContent) {
        throw new Error('No response from AI');
      }

      let result;
      try {
        result = JSON.parse(textContent);
      } catch (parseError) {
        const jsonMatch = textContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          result = JSON.parse(jsonMatch[0]);
        } else {
          result = {
            raw_response: textContent,
            parse_error: parseError.message
          };
        }
      }

      // Transform to database format
      const transformedResult = this.transformToDBFormat(result);

      // Add token usage info
      transformedResult.ai_metadata = {
        model: this.model,
        prompt_tokens: response.usage?.prompt_tokens,
        completion_tokens: response.usage?.completion_tokens,
        total_tokens: response.usage?.total_tokens
      };

      return {
        success: true,
        data: transformedResult
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Transform AI response to database format
   */
  transformToDBFormat(aiResult) {
    const codingCategories = aiResult.coding_categories || {};

    // Extract codes arrays from the new structure
    const reasonForAdmitCodes = codingCategories.reason_for_admit?.codes || [];
    const edEmCodes = codingCategories.ed_em_level?.codes || [];
    const procedureCodes = codingCategories.procedures?.codes || [];
    const primaryDxCodes = codingCategories.primary_diagnosis?.codes || [];
    const secondaryDxCodes = codingCategories.secondary_diagnoses?.codes || [];
    const modifierCodes = codingCategories.modifiers?.codes || [];

    return {
      // AI Summary (enhanced)
      ai_narrative_summary: aiResult.ai_narrative_summary,

      // All codes organized by category with the new array structure
      diagnosis_codes: {
        reason_for_admit: reasonForAdmitCodes,
        ed_em_level: edEmCodes,
        primary_diagnosis: primaryDxCodes,
        secondary_diagnoses: secondaryDxCodes,
        modifiers: modifierCodes,
        // Backward compatibility
        principal_diagnosis: primaryDxCodes[0] || null
      },

      // Procedures as array
      procedures: procedureCodes,

      // Feedback/Coding notes
      coding_notes: aiResult.feedback || {
        documentation_gaps: [],
        physician_queries_needed: [],
        coding_tips: [],
        compliance_alerts: []
      },

      // Other fields
      medications: aiResult.medications || [],
      vitals_summary: aiResult.vitals_summary || {},
      lab_results_summary: aiResult.lab_results_summary || [],
      metadata: aiResult.metadata || {}
    };
  }

  /**
   * Generate a summary for a single document
   */
  async generateDocumentSummary(ocrResult, chartInfo) {
    try {
      const text = typeof ocrResult.extractedText === 'string'
        ? ocrResult.extractedText
        : JSON.stringify(ocrResult.extractedText);

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: `You are a clinical documentation specialist. Analyze the given clinical document and provide a comprehensive structured summary. Return valid JSON only.`
          },
          {
            role: 'user',
            content: `Analyze this clinical document and provide a detailed summary.

Document Type: ${ocrResult.documentType || 'Unknown'}
Filename: ${ocrResult.filename}
Facility: ${chartInfo.facility || 'Unknown'}
Date: ${chartInfo.dateOfService || 'Unknown'}

DOCUMENT CONTENT:
${text}

Respond with a JSON object:
{
  "document_type": "${ocrResult.documentType || 'Unknown'}",
  "title": "Document title based on content",
  "provider": "Provider name if found",
  "date": "Document date if found",
  "time": "Document time if found",
  "sections": [
    {
      "section_name": "Section name (e.g., Chief Complaint, HPI, Physical Exam)",
      "content": "Detailed summary of section content",
      "source_line": "Line number where found",
      "key_data_points": ["Important data points from this section"]
    }
  ],
  "key_findings": [
    {
      "finding": "Important clinical finding",
      "category": "vital/lab/imaging/exam/diagnosis/treatment",
      "significance": "Why this is clinically important",
      "source_section": "Where this was found"
    }
  ],
  "extracted_data": {
    "chief_complaint": "Detailed chief complaint",
    "history_of_present_illness": "Full HPI narrative",
    "review_of_systems": {
      "documented_systems": ["List of ROS systems documented"],
      "positive_findings": ["Positive findings"],
      "negative_findings": ["Pertinent negatives"]
    },
    "past_medical_history": ["List of PMH items"],
    "medications": ["Current medications"],
    "allergies": ["Allergies"],
    "social_history": "Social history summary",
    "family_history": "Family history summary",
    "physical_examination": {
      "general": "General appearance",
      "vital_signs": {
        "blood_pressure": "",
        "heart_rate": "",
        "respiratory_rate": "",
        "temperature": "",
        "oxygen_saturation": "",
        "pain_score": ""
      },
      "system_exams": {
        "heent": "",
        "neck": "",
        "cardiovascular": "",
        "respiratory": "",
        "abdomen": "",
        "extremities": "",
        "neurological": "",
        "skin": "",
        "psychiatric": ""
      }
    },
    "assessment": "Provider's assessment/impression",
    "plan": "Treatment plan",
    "disposition": "Discharge, admit, etc."
  },
  "clinical_relevance": "Comprehensive summary of why this document is important for coding and what codes it supports",
  "coding_implications": ["List of potential codes supported by this document"]
}`
          }
        ],
        max_tokens: 4000,
        temperature: 0.1,
        response_format: { type: "json_object" }
      });

      const textContent = response.choices[0]?.message?.content;
      if (!textContent) {
        throw new Error('No response from AI');
      }

      const result = JSON.parse(textContent);

      return {
        success: true,
        data: result
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
}

export const aiService = new AIService();
