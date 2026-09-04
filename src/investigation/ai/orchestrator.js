'use strict';
/**
 * src/investigation/ai/orchestrator.js
 *
 * Payvault AI Orchestration Layer.
 *
 * Unified architecture:
 *  InvestigationCase
 *         ↓
 *  Payvault AI Orchestrator
 *         ↓
 *  Primary Intelligence (Payvault Local ML + Deterministic Reasoner)
 *         ↓
 *  Multi-Signal Difficulty & Ambiguity Evaluation (difficulty.js)
 *         ↓
 *  Unified Investigation
 *         ↓
 *  Consistency Validation (consistency.js)
 *         ↓
 *  User-Friendly Unified Report
 */

const { extractEvidence }     = require('./evidence');
const { detectPatterns }      = require('./patterns');
const { reasonOverCase }      = require('./reasoning');
const { calculateConfidence } = require('./confidence');
const { validateConsistency } = require('./consistency');
const { defaultModelRouter }  = require('./model/modelRouter');

class AIOrchestrator {
  constructor(options = {}) {
    this.router = options.router || defaultModelRouter;
  }

  /**
   * Run the end-to-end investigation pipeline on an InvestigationCase.
   *
   * @param {Object} investigationCase - Standard InvestigationCase
   * @param {Object} [options]         - Orchestration overrides
   * @returns {Promise<Object>} Unified user-facing investigation report
   */
  async orchestrate(investigationCase, options = {}) {
    const startMs = Date.now();

    // ── 1. Extract Structured Evidence ───────────────────────────────────────
    const evidence = extractEvidence(investigationCase);

    // ── 2. Detect Deterministic Patterns ─────────────────────────────────────
    const patterns = detectPatterns(investigationCase, evidence);

    // ── 3. Route Through Model Router (Payvault Local ML) ────────────────────
    const routing = await this.router.route(investigationCase, options);

    // ── 4. Formulate Deterministic Reasoning & Root Causes ───────────────────
    let reasoning = reasonOverCase(investigationCase, evidence, patterns);

    // ── 5. Calculate Measurable Confidence Scoring ───────────────────────────
    let confidence = calculateConfidence({
      primaryRootCause: reasoning.primary_root_cause,
      evidence,
      patterns,
      investigationCase,
    });

    // ── 6. Anti-Hallucination & Consistency Validation ───────────────────────
    let validation = validateConsistency({
      investigationCase,
      evidence,
      reasoningOutput: reasoning,
      confidenceOutput: confidence,
    });

    if (!validation.isValid) {
      reasoning  = validation.adjustedReasoning;
      confidence = validation.adjustedConfidence;
    }

    // ── 7. Synthesize Unified User-Friendly Output ───────────────────────────
    return this._synthesizeUnifiedResult({
      investigationCase,
      evidence,
      patterns,
      reasoning,
      confidence,
      validation,
      routing,
      latencyMs: Date.now() - startMs,
    });
  }

  /**
   * Synthesizes the unified, user-friendly investigation result.
   * Produces an identical schema regardless of whether Local ML or Qwen was invoked.
   *
   * @private
   */
  _synthesizeUnifiedResult({
    investigationCase,
    evidence,
    patterns,
    reasoning,
    confidence,
    validation,
    routing,
    latencyMs,
  }) {
    const cat = investigationCase.exception_category || 'UNEXPLAINED';
    const amountAtRisk = investigationCase.amount_at_risk || 0;
    const amtStr = `₹${(amountAtRisk / 100).toFixed(2)}`;

    // 1. Determine User-Facing Assessment State
    let assessment = 'NEEDS_REVIEW';
    if (cat === 'CLEAN_MATCH') {
      assessment = 'MATCHED';
    } else if (amountAtRisk > 100000 || cat === 'DUPLICATE') {
      assessment = 'HIGH_RISK';
    } else {
      assessment = 'NEEDS_REVIEW';
    }

    // 2. Generate What Happened (1-2 sentences)
    const whatHappened = this._buildWhatHappened(cat, investigationCase, reasoning, routing);

    // 3. Generate Why It Matters (1 concise financial sentence)
    const whyItMatters = this._buildWhyItMatters(cat, amountAtRisk);

    // 4. Generate Recommended Action (Concrete operational steps)
    const recommendedAction = this._buildRecommendedAction(cat, reasoning, routing);

    // 5. Supporting Evidence (Concise factual bullet points)
    const supportingEvidence = this._buildSupportingEvidence(investigationCase, evidence);

    // 6. Return Unified Output Contract
    return {
      case_id: investigationCase.case_id,
      exception_category: cat,

      // Core Human-Facing Findings (UNIFIED FORMAT)
      summary: whatHappened,
      what_happened: whatHappened,
      why_it_matters: whyItMatters,
      recommended_action: recommendedAction,
      assessment: assessment,
      supporting_evidence: supportingEvidence,

      // Backward-compatible fields for UI & existing tests
      finding: whatHappened,
      what_to_check: [recommendedAction],
      evidence_highlights: this._buildEvidenceHighlights(investigationCase),
      investigation_status: assessment === 'MATCHED' ? 'MATCHED' : 'REQUIRES_REVIEW',
      status: assessment === 'MATCHED' ? 'MATCHED' : 'REQUIRES_REVIEW',
      amount_at_risk: amountAtRisk,
      financial_impact: {
        amount_at_risk_paise: amountAtRisk,
        amount_at_risk_inr: (amountAtRisk / 100).toFixed(2),
        variance: reasoning.financial_impact?.variance || amountAtRisk,
      },

      // Progressive Expandable Details
      financial_breakdown: reasoning.financial_impact || { gross_amount: amountAtRisk, variance: amountAtRisk },
      timeline: investigationCase.timeline || [],
      relationships: investigationCase.relationships || [],
      evidence: evidence,
      explanation: (reasoning.contributing_factors || []).map(f => ({
        type: 'INFERENCE',
        statement: `${f.factor}: ${f.explanation}`,
        evidence_ids: f.evidence_ids || [],
      })),

      // Internal Diagnostics (Retained for server-side logs/testing, NEVER rendered in normal UI)
      _diagnostics: {
        engine: 'payvault_ai',
        internal_routing_state: routing.internal_state,
        selected_model: routing.selected_model,
        difficulty_score: routing.difficulty.difficultyScore,
        difficulty_reasons: routing.difficulty.reasons,
        ml_analysis: routing.ml_result,
        latency_ms: latencyMs,
        is_consistent: validation.isValid,
      },
    };
  }

  _buildWhatHappened(cat, caseData, reasoning, routing) {
    const amtStr = `₹${((caseData.amount_at_risk || 0) / 100).toFixed(2)}`;
    switch (cat) {
      case 'ADJUSTMENT':
        return `A settlement adjustment was recorded, but it could not be linked to a corresponding payment or refund.`;
      case 'FEE_TAX_VARIANCE':
        return `The gateway fee or GST tax charged differs from the contracted 2% platform rate by ${amtStr}.`;
      case 'TIMING_MISMATCH':
        return `The payment and its associated refund were processed across different settlement batch cycles.`;
      case 'MISSING_ORDER':
        return `A settlement credit of ${amtStr} was deposited without an associated internal merchant order record.`;
      case 'MISSING_PAYMENT':
        return `An expected merchant order of ${amtStr} was recorded, but no matching gateway settlement payout was found.`;
      case 'DUPLICATE':
        return `Multiple settlement credits with identical amounts were received for the same order reference.`;
      case 'PARTIAL_REFUND':
        return `A partial refund was deducted against the original transaction credit.`;
      case 'CLEAN_MATCH':
        return `All payment amounts, fees, and taxes match the merchant ledger calculation exactly.`;
      case 'UNEXPLAINED':
      default:
        return reasoning.primary_root_cause?.cause || `A settlement variance of ${amtStr} was detected between gateway credit and merchant ledger.`;
    }
  }

  _buildWhyItMatters(cat, amountAtRisk) {
    const amtStr = `₹${(amountAtRisk / 100).toFixed(2)}`;
    switch (cat) {
      case 'ADJUSTMENT':
        return `The ${amtStr} adjustment currently has no matching transaction, so its financial purpose cannot be verified.`;
      case 'FEE_TAX_VARIANCE':
        return `Discrepancies in gateway fees directly impact merchant gross margin and net payout accuracy.`;
      case 'TIMING_MISMATCH':
        return `Asynchronous batch cycles create temporary reconciliation imbalances across reporting periods.`;
      case 'MISSING_ORDER':
        return `Unlinked gateway funds cannot be attributed to a recognized customer purchase.`;
      case 'MISSING_PAYMENT':
        return `The merchant ledger expects ${amtStr} that has not yet cleared the payment gateway.`;
      case 'DUPLICATE':
        return `Duplicate credits represent potential overpayment risk and may trigger gateway clawbacks.`;
      default:
        return `Unreconciled financial exposure of ${amtStr} impacts general ledger integrity.`;
    }
  }

  _buildRecommendedAction(cat, reasoning, routing) {
    const firstAction = reasoning.recommended_actions?.[0];
    if (firstAction?.resolution_hint || firstAction?.description) {
      return firstAction.resolution_hint || firstAction.description;
    }

    switch (cat) {
      case 'ADJUSTMENT':
        return 'Check the settlement statement and verify whether this adjustment relates to a fee reversal, dispute, or other settlement correction.';
      case 'FEE_TAX_VARIANCE':
        return 'Verify the contracted gateway fee schedule (2% + 18% GST) and request a fee correction credit if overcharged.';
      case 'TIMING_MISMATCH':
        return 'Confirm the refund settlement batch UTR in the next payout cycle; no manual customer refund action required.';
      case 'MISSING_ORDER':
        return 'Search the merchant order database for the payment reference ID and manually link the unattached payment.';
      case 'MISSING_PAYMENT':
        return 'Verify if payment capture completed successfully in the Razorpay dashboard or contact gateway support.';
      case 'DUPLICATE':
        return 'Review gateway dashboard timestamps to verify twin captures and prepare for automated reversal.';
      default:
        return 'Review the raw settlement line item against the bank statement and confirm with payment gateway support.';
    }
  }

  _buildSupportingEvidence(caseData, evidence) {
    const facts = [];
    const sr = caseData.settlement_record;
    const mo = caseData.merchant_order;

    if (caseData.exception_category === 'ADJUSTMENT') {
      facts.push('Settlement adjustment exists in gateway batch');
      facts.push('No matching merchant order found');
      facts.push('No matching refund record found');
    } else if (caseData.exception_category === 'MISSING_ORDER') {
      facts.push(`Settlement entity ${sr?.entity_id || 'sr_...'} credited`);
      facts.push('Merchant order reference is null or missing in store');
    } else if (caseData.exception_category === 'FEE_TAX_VARIANCE') {
      facts.push(`Gateway fee charged differs from standard 2% rate`);
      facts.push(`Amount at risk: ₹${((caseData.amount_at_risk || 0) / 100).toFixed(2)}`);
    } else {
      if (sr?.entity_id) facts.push(`Settlement record: ${sr.entity_id}`);
      if (sr?.payment_id) facts.push(`Payment ID: ${sr.payment_id}`);
      if (mo?.id) facts.push(`Merchant order: ${mo.id}`);
      if (caseData.amount_at_risk) facts.push(`Amount at risk: ₹${((caseData.amount_at_risk || 0) / 100).toFixed(2)}`);
    }

    return facts.slice(0, 4);
  }

  _buildEvidenceHighlights(caseData) {
    const highlights = [];
    const sr = caseData.settlement_record;
    const mo = caseData.merchant_order;

    if (sr?.entity_id) highlights.push({ label: 'Settlement Entity', value: sr.entity_id });
    if (sr?.payment_id) highlights.push({ label: 'Payment ID', value: sr.payment_id });
    if (mo?.id) highlights.push({ label: 'Merchant Order', value: mo.id });
    if (sr?.settlement_id) highlights.push({ label: 'Settlement Batch', value: sr.settlement_id });
    if (caseData.amount_at_risk) {
      highlights.push({ label: 'Amount at Risk', value: `₹${(caseData.amount_at_risk / 100).toFixed(2)}` });
    }

    return highlights;
  }
}

const defaultOrchestrator = new AIOrchestrator();

module.exports = {
  AIOrchestrator,
  defaultOrchestrator,
};
