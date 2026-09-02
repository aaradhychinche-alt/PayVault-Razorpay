'use strict';
/**
 * src/investigation/ai/formatter.js
 *
 * Output Formatter for the Payvault AI Investigation Engine.
 * Enforces the strict 10-point investigation output schema,
 * with explicit classification of FACT / INFERENCE / RECOMMENDATION.
 */

/**
 * Format the complete AI investigation report.
 *
 * @param {Object} params
 * @param {Object} params.investigationCase
 * @param {Object[]} params.evidence
 * @param {Object[]} params.patterns
 * @param {Object} params.reasoning
 * @param {Object} params.confidence
 * @param {Object} params.validation
 * @param {Object} params.modelInfo
 * @param {Object} [params.mlAnalysis]
 * @param {Object} [params.intelligenceContext]
 * @returns {Object} Final structured investigation report
 */
function formatReport({
  investigationCase,
  evidence,
  patterns,
  reasoning,
  confidence,
  validation,
  modelInfo,
  mlAnalysis,
  intelligenceContext,
  routing,
}) {
  const {
    case_id,
    exception_category,
    exception,
    settlement_record: sr,
    merchant_order: mo,
    merchant_ledger: le,
    financial_analysis: fa,
  } = investigationCase;

  const rootCause = reasoning.primary_root_cause;

  // ── 1. Executive Summary ───────────────────────────────────────────────────
  const amountStr = `${exception.amount_at_risk} paise (₹${(exception.amount_at_risk / 100).toFixed(2)})`;
  const executiveSummary =
    `Investigation of exception ${case_id} (${exception_category}) with ${amountStr} financial exposure. ` +
    `Root cause identified with ${confidence.level} confidence (${confidence.score}%): ${rootCause.cause}. ` +
    `${reasoning.risk_assessment.level} risk profile.`;

  // ── 2. Explicit Explanation Lines (FACT / INFERENCE / RECOMMENDATION) ───────
  const explanationLines = [];

  // Facts
  if (sr) {
    explanationLines.push({
      type: 'FACT',
      statement: `Settlement record ${sr.entity_id} processed with gross amount ${sr.amount} paise and net credit ${sr.credit} paise.`,
      evidence_ids: evidence.filter(e => e.source === 'settlement_record' && (e.field === 'amount' || e.field === 'credit')).map(e => e.id),
    });
  }

  if (mo) {
    explanationLines.push({
      type: 'FACT',
      statement: `Merchant order ${mo.id} recorded in local store for ${mo.amount} paise (status: ${mo.status}).`,
      evidence_ids: evidence.filter(e => e.source === 'merchant_order' && e.field === 'amount').map(e => e.id),
    });
  }

  if (fa && fa.fee_variance !== null && fa.fee_variance !== 0) {
    explanationLines.push({
      type: 'FACT',
      statement: `Platform fee charged is ${fa.fee_actual} paise vs contract baseline ${fa.fee_expected} paise (variance: ${fa.fee_variance} paise).`,
      evidence_ids: evidence.filter(e => e.source === 'financial_analysis' && e.field === 'fee_variance').map(e => e.id),
    });
  }

  // Inferences
  explanationLines.push({
    type: 'INFERENCE',
    statement: rootCause.reasoning,
    evidence_ids: rootCause.evidence_ids || [],
  });

  for (const factor of reasoning.contributing_factors) {
    explanationLines.push({
      type: 'INFERENCE',
      statement: `${factor.factor}: ${factor.explanation}`,
      evidence_ids: factor.evidence_ids || [],
    });
  }

  // Recommendations
  for (const act of (reasoning.recommended_actions || []).slice(0, 3)) {
    explanationLines.push({
      type: 'RECOMMENDATION',
      statement: `${act.action_type} (Priority ${act.priority}): ${act.resolution_hint || act.description}`,
      evidence_ids: [],
    });
  }

  // ── 3. Synthesize Human-Facing Product Fields ────────────────────────────
  const amtFormatted = `₹${((investigationCase.amount_at_risk || 0) / 100).toFixed(2)}`;
  let finding = executiveSummary;
  let whyItMatters = `Unresolved financial variance of ${amtFormatted} impacts reconciliation accuracy.`;
  let investigationStatus = 'REQUIRES_REVIEW';

  if (exception_category === 'CLEAN_MATCH') {
    finding = `Transaction amounts, fees, and taxes match the expected merchant ledger calculation exactly.`;
    whyItMatters = `All monetary entries are reconciled with zero outstanding discrepancy.`;
    investigationStatus = 'MATCHED';
  } else if (exception_category === 'FEE_TAX_VARIANCE') {
    finding = `Gateway platform fee or GST tax differs from the standard schedule by ${amtFormatted}.`;
    whyItMatters = `Overcharged gateway fees reduce merchant net payout margin by ${amtFormatted}.`;
    investigationStatus = 'REQUIRES_REVIEW';
  } else if (exception_category === 'TIMING_MISMATCH') {
    finding = `The customer payment and corresponding refund were settled across different settlement batches.`;
    whyItMatters = `Asynchronous batch timing creates temporary balance sheet discrepancies across reporting periods.`;
    investigationStatus = 'REQUIRES_REVIEW';
  } else if (exception_category === 'MISSING_ORDER') {
    finding = `A settlement credit of ${amtFormatted} was received without an associated merchant order record.`;
    whyItMatters = `Unlinked gateway funds cannot be attributed to an internal customer order.`;
    investigationStatus = 'REQUIRES_REVIEW';
  } else if (exception_category === 'MISSING_PAYMENT') {
    finding = `A merchant order of ${amtFormatted} was marked pending but no matching gateway settlement was credited.`;
    whyItMatters = `Merchant ledger expects ${amtFormatted} that has not been received in any settlement batch.`;
    investigationStatus = 'REQUIRES_REVIEW';
  } else if (exception_category === 'DUPLICATE') {
    finding = `Multiple settlement credits with identical amounts were received for the same order within a short window.`;
    whyItMatters = `Duplicate credits may lead to potential clawback or overpayment exposure of ${amtFormatted}.`;
    investigationStatus = 'REQUIRES_REVIEW';
  } else if (exception_category === 'ADJUSTMENT') {
    finding = `A settlement adjustment of ${amtFormatted} has no matching payment or refund record in the merchant ledger.`;
    whyItMatters = `This ${amtFormatted} adjustment cannot currently be tied to a specific customer order.`;
    investigationStatus = 'REQUIRES_REVIEW';
  } else if (exception_category === 'PARTIAL_REFUND') {
    finding = `A partial refund of ${amtFormatted} was deducted against the original transaction credit.`;
    whyItMatters = `Net merchant settlement is reduced by the refund amount.`;
    investigationStatus = 'LIKELY_MATCH';
  }

  const whatToCheck = (reasoning.recommended_actions || []).slice(0, 3).map(
    a => a.resolution_hint || a.description || a.action_type
  );

  const evidenceHighlights = [];
  if (investigationCase.settlement_record?.entity_id) {
    evidenceHighlights.push({ label: 'Settlement Entity', value: investigationCase.settlement_record.entity_id });
  }
  if (investigationCase.settlement_record?.payment_id) {
    evidenceHighlights.push({ label: 'Payment ID', value: investigationCase.settlement_record.payment_id });
  }
  if (investigationCase.merchant_order?.id) {
    evidenceHighlights.push({ label: 'Merchant Order', value: investigationCase.merchant_order.id });
  }
  if (investigationCase.settlement_record?.settlement_id) {
    evidenceHighlights.push({ label: 'Settlement Batch', value: investigationCase.settlement_record.settlement_id });
  }
  if (investigationCase.amount_at_risk) {
    evidenceHighlights.push({ label: 'Amount at Risk', value: amtFormatted });
  }

  // Enrich with historical intelligence evidence highlights if available
  if (intelligenceContext) {
    if (intelligenceContext.memory_context?.precedent_summary) {
      evidenceHighlights.push({
        label: 'Historical Precedent',
        value: intelligenceContext.memory_context.precedent_summary,
      });
    } else if (intelligenceContext.historical_context?.similar_cases?.length > 0) {
      evidenceHighlights.push({
        label: 'Similar Cases',
        value: `${intelligenceContext.historical_context.similar_cases.length} structurally similar cases identified in store.`,
      });
    }

    if (intelligenceContext.anomaly_context?.anomalies?.length > 0) {
      const firstAnom = intelligenceContext.anomaly_context.anomalies[0];
      evidenceHighlights.push({
        label: 'Anomaly Alert',
        value: `${firstAnom.type.replace(/_/g, ' ')} (${firstAnom.deviation})`,
      });
    }

    if (intelligenceContext.historical_context?.merchant_patterns?.length > 0) {
      evidenceHighlights.push({
        label: 'Merchant Pattern',
        value: intelligenceContext.historical_context.merchant_patterns[0].claim,
      });
    }
  }

  const assessment = (exception_category === 'CLEAN_MATCH')
    ? 'MATCHED'
    : (investigationCase.amount_at_risk > 100000 || exception_category === 'DUPLICATE' ? 'HIGH_RISK' : 'NEEDS_REVIEW');

  const supportingEvidence = evidenceHighlights.map(h => `${h.label}: ${h.value}`);

  const isQwen = !!(routing && routing.qwen_result && routing.qwen_result.success && routing.qwen_result.analysis);
  const qa = isQwen ? routing.qwen_result.analysis : null;

  const finalSummary = qa?.summary || finding;
  const finalWhatHappened = qa?.what_happened || finding;
  const finalWhyItMatters = qa?.why_it_matters || whyItMatters;
  const finalAction = qa?.recommended_action || whatToCheck[0] || 'Verify transaction in settlement statement.';
  const finalEvidence = (qa?.supporting_evidence && qa.supporting_evidence.length > 0) ? qa.supporting_evidence : supportingEvidence;

  // ── 4. Assemble Final Strict Schema ────────────────────────────────────────
  return {
    case_id,
    exception_category,
    investigation_status: investigationStatus,

    // UNIFIED USER-FACING FORMAT
    summary: finalSummary,
    what_happened: finalWhatHappened,
    why_it_matters: finalWhyItMatters,
    recommended_action: finalAction,
    assessment: qa?.assessment || assessment,
    supporting_evidence: finalEvidence,

    // Structured AI Analysis object for transparency & auditability
    ai_analysis: {
      provider: isQwen ? 'OLLAMA_QWEN' : 'PAYVAULT_LOCAL_INTELLIGENCE',
      model: isQwen ? routing.selected_model : 'Payvault Local ML',
      runtime: isQwen ? 'Ollama (Local)' : 'In-Process (Local)',
      status: isQwen ? 'COMPLETED' : (routing?.fallback_used ? 'FALLBACK_USED' : 'COMPLETED'),
      fallback_reason: routing?.fallback_reason || null,
      summary: finalSummary,
      what_happened: finalWhatHappened,
      why_it_matters: finalWhyItMatters,
      recommended_action: finalAction,
      supporting_evidence: finalEvidence,
    },

    deterministic_findings: {
      category: exception_category,
      amount_at_risk: investigationCase.amount_at_risk,
      financial_analysis: fa,
      relationships: investigationCase.relationships,
      timeline: investigationCase.timeline,
    },

    historical_findings: {
      similar_cases: intelligenceContext?.historical_context?.similar_cases || [],
      repeated_patterns: intelligenceContext?.historical_context?.repeated_patterns || [],
      anomalies: intelligenceContext?.anomaly_context?.anomalies || [],
      precedent_summary: intelligenceContext?.memory_context?.precedent_summary || null,
    },

    // Backward compatibility fields
    finding,
    what_to_check: whatToCheck,
    evidence_highlights: evidenceHighlights,
    executive_summary: executiveSummary,

    root_cause: {
      conclusion: rootCause.cause,
      probability: rootCause.probability,
      support_status: rootCause.support_status,
      confidence: {
        score: confidence.score,
        level: confidence.level,
        factors: confidence.factors,
      },
      evidence_ids: rootCause.evidence_ids || [],
      contradicting_evidence_ids: rootCause.contradicting_evidence_ids || [],
      candidate_hypotheses: reasoning.candidate_root_causes || [],
    },

    contributing_factors: reasoning.contributing_factors || [],

    financial_impact: {
      amount_at_risk: reasoning.financial_impact.amount_at_risk,
      variance: reasoning.financial_impact.variance,
      fee_variance: reasoning.financial_impact.fee_variance,
      tax_variance: reasoning.financial_impact.tax_variance,
      currency: reasoning.financial_impact.currency,
      unit: reasoning.financial_impact.unit,
      explanation: reasoning.financial_impact.explanation,
    },

    timeline_findings: reasoning.timeline_findings || [],
    relationship_findings: reasoning.relationship_findings || [],

    evidence: evidence,
    detected_patterns: patterns,

    risk_assessment: {
      level: reasoning.risk_assessment.level,
      score: reasoning.risk_assessment.score,
      reasons: reasoning.risk_assessment.reasons,
    },

    recommended_actions: reasoning.recommended_actions || [],

    explanation: explanationLines,

    uncertainty: reasoning.uncertainty || [],

    consistency_validation: {
      is_valid: validation.isValid,
      conflicts: validation.conflicts,
    },

    // Chunk 4: Historical & Cross-Transaction Intelligence Context
    intelligence_context: intelligenceContext || {
      case_id,
      historical_context: { similar_cases: [], repeated_patterns: [], merchant_patterns: [] },
      anomaly_context: { has_sufficient_history: false, anomalies: [] },
      memory_context: { confirmed_resolutions: [], precedent_summary: null },
      intelligence_metadata: { history_available: false },
    },

    ml_analysis: mlAnalysis || {
      model: 'Payvault Local ML',
      model_version: 'payvault-ml-v1',
      model_type: 'LOCAL TRAINED MODEL',
      predicted_category: rootCause.conclusion,
      confidence: confidence.score / 100,
      probabilities: {},
      top_features: [],
    },

    ai_metadata: {
      engine: 'payvault_ai',
      model: modelInfo.model || 'payvault_rule_reasoner_v1',
      mode: modelInfo.mode || 'LOCAL',
      local_inference_available: modelInfo.local_inference_available || false,
      qwen_escalated: isQwen, // Flag indicating if Qwen actually ran
      generated_at: new Date().toISOString(),
    },
    
    // Internal routing details for debugging and provenance verification
    routing: {
      routed_to: routing?.routed_to || 'PRIMARY_ML',
      selected_model: routing?.selected_model || 'Payvault Local Intelligence',
      qwen_invoked: routing?.qwen_invoked || false,
      fallback_used: routing?.fallback_used || false,
      fallback_reason: routing?.fallback_reason || null,
    },
  };
}

module.exports = { formatReport };

