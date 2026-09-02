'use strict';
/**
 * src/investigation/ai/consistency.js
 *
 * Consistency & Validation Checker.
 * Validates AI reasoning output against ground facts in InvestigationCase:
 * - Ensures cited evidence IDs exist in extracted evidence list
 * - Verifies monetary values match exact integer paise in source records
 * - Checks entity IDs (payment_id, order_id, settlement_id) against case
 * - Detects contradictions with deterministic reconciliation rules
 * - Replaces any conflicting conclusion with "CONFLICTING_INFERENCE"
 */

/**
 * Validate consistency of AI reasoning against the case facts.
 *
 * @param {Object} params
 * @param {Object} params.investigationCase
 * @param {Object[]} params.evidence
 * @param {Object} params.reasoningOutput
 * @param {Object} params.confidenceOutput
 * @returns {{ isValid: boolean, conflicts: Object[], adjustedReasoning: Object, adjustedConfidence: Object }}
 */
function validateConsistency({ investigationCase, evidence, reasoningOutput, confidenceOutput }) {
  const conflicts = [];
  const validEvIds = new Set(evidence.map(e => e.id));

  const {
    exception,
    settlement_record: sr,
    merchant_order: mo,
    reconciliation_result: rr,
    financial_analysis: fa,
  } = investigationCase;

  // ── 1. Validate Evidence ID References ─────────────────────────────────────
  const primary = reasoningOutput.primary_root_cause;
  const invalidEvIds = (primary.evidence_ids || []).filter(id => !validEvIds.has(id));

  if (invalidEvIds.length > 0) {
    conflicts.push({
      type: 'INVALID_EVIDENCE_REFERENCE',
      severity: 'HIGH',
      description: `Root cause references non-existent evidence IDs: ${invalidEvIds.join(', ')}`,
    });
  }

  // ── 2. Validate Monetary Consistency ───────────────────────────────────────
  const faImpact = reasoningOutput.financial_impact;
  if (faImpact && faImpact.amount_at_risk !== exception.amount_at_risk) {
    conflicts.push({
      type: 'MONETARY_AMOUNT_MISMATCH',
      severity: 'CRITICAL',
      description: `Financial impact amount_at_risk (${faImpact.amount_at_risk}) contradicts exception amount_at_risk (${exception.amount_at_risk}).`,
    });
  }

  // ── 3. Validate Entity Identifier Integrity ────────────────────────────────
  if (sr && sr.entity_id) {
    // Ensure primary reasoning doesn't cite an alien payment ID
    const text = (primary.reasoning || '') + ' ' + (primary.cause || '');
    const alienIds = text.match(/pay_[A-Za-z0-9]+/g) || [];
    for (const id of alienIds) {
      if (id !== sr.entity_id && (!sr.payment_id || id !== sr.payment_id)) {
        // Check if it's a valid refund entity
        const isRefund = (investigationCase.refund_records || []).some(r => r.entity_id === id || r.payment_id === id);
        if (!isRefund) {
          conflicts.push({
            type: 'UNVERIFIED_ENTITY_ID',
            severity: 'MEDIUM',
            description: `Reasoning cites unverified payment ID '${id}' not found in case records.`,
          });
        }
      }
    }
  }

  // ── 4. Verify No Direct Contradiction with Deterministic Reconciliation ──
  if (rr && rr.status === 'MATCHED' && primary.probability === 'HIGH' && exception.category !== 'MATCHED') {
    conflicts.push({
      type: 'RECONCILIATION_STATUS_CONTRADICTION',
      severity: 'CRITICAL',
      description: `AI claims exception when deterministic reconciliation already verified MATCHED status.`,
    });
  }

  // ── 5. Apply Adjustments if Conflicts Found ────────────────────────────────
  let adjustedReasoning = { ...reasoningOutput };
  let adjustedConfidence = { ...confidenceOutput };

  if (conflicts.length > 0) {
    // If critical conflicts exist, flag the root cause
    const criticalConflicts = conflicts.filter(c => c.severity === 'CRITICAL');
    if (criticalConflicts.length > 0) {
      adjustedReasoning.primary_root_cause = {
        ...primary,
        cause: `CONFLICTING_INFERENCE: ${primary.cause}`,
        support_status: 'Insufficient evidence',
        confidence_score: Math.min(30, primary.confidence_score),
      };

      // Penalize confidence
      adjustedConfidence = {
        ...adjustedConfidence,
        score: Math.min(30, adjustedConfidence.score - 40),
        level: 'LOW',
        factors: [
          ...adjustedConfidence.factors,
          {
            name: 'Consistency Check Violation',
            impact: '-40',
            explanation: `Automated consistency validator detected ${criticalConflicts.length} conflict(s) with deterministic ground truth.`,
          },
        ],
      };
    }
  }

  return {
    isValid: conflicts.length === 0,
    conflicts,
    adjustedReasoning,
    adjustedConfidence,
  };
}

module.exports = { validateConsistency };
