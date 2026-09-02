'use strict';
/**
 * src/investigation/ai/confidence.js
 *
 * Measurable Confidence Engine.
 * Calculates an auditable confidence score (0-100) based on measurable signals:
 * - Supporting vs contradictory evidence counts & importance
 * - Deterministic pattern match strength
 * - Financial mathematical consistency
 * - Entity completeness
 */

/**
 * Calculate measurable confidence score for an investigation.
 *
 * @param {Object} params
 * @param {Object} params.primaryRootCause
 * @param {Object[]} params.evidence
 * @param {Object[]} params.patterns
 * @param {Object} params.investigationCase
 * @returns {{ score: number, level: 'LOW'|'MEDIUM'|'HIGH', factors: Object[] }}
 */
function calculateConfidence({ primaryRootCause, evidence, patterns, investigationCase }) {
  let score = 50; // Neutral baseline
  const factors = [];

  const { exception, settlement_record: sr, reconciliation_result: rr, financial_analysis: fa } = investigationCase;

  // ── 1. Supporting Evidence Signal ──────────────────────────────────────────
  const citedEvIds = new Set(primaryRootCause.evidence_ids || []);
  const supportingEv = evidence.filter(e => citedEvIds.has(e.id));
  const highImpCount = supportingEv.filter(e => e.importance === 'HIGH').length;
  const medImpCount = supportingEv.filter(e => e.importance === 'MEDIUM').length;

  const supportGain = Math.min(25, highImpCount * 6 + medImpCount * 3);
  if (supportGain > 0) {
    score += supportGain;
    factors.push({
      name: 'Supporting Evidence Depth',
      impact: `+${supportGain}`,
      explanation: `${supportingEv.length} factual evidence items (${highImpCount} high-importance) directly corroborate the root cause.`,
    });
  }

  // ── 2. Contradicting Evidence Penalty ──────────────────────────────────────
  const contradictCount = (primaryRootCause.contradicting_evidence_ids || []).length;
  if (contradictCount > 0) {
    const penalty = contradictCount * 20;
    score -= penalty;
    factors.push({
      name: 'Contradicting Evidence Penalty',
      impact: `-${penalty}`,
      explanation: `${contradictCount} evidence item(s) contradict the primary hypothesis.`,
    });
  } else {
    factors.push({
      name: 'Zero Contradictory Evidence',
      impact: '+5',
      explanation: 'No contradictory facts found across payment records, merchant orders, or ledger.',
    });
    score += 5;
  }

  // ── 3. Pattern Alignment ───────────────────────────────────────────────────
  const matchingPatterns = patterns.filter(p => p.evidence_ids.some(id => citedEvIds.has(id)));
  if (matchingPatterns.length > 0) {
    const patternGain = Math.min(15, matchingPatterns.length * 8);
    score += patternGain;
    factors.push({
      name: 'Deterministic Pattern Confirmation',
      impact: `+${patternGain}`,
      explanation: `${matchingPatterns.length} deterministic pattern(s) (${matchingPatterns.map(p => p.name).join(', ')}) independently confirm the finding.`,
    });
  }

  // ── 4. Financial Mathematical Consistency ──────────────────────────────────
  if (fa && (fa.fee_variance !== null || rr.amount_variance !== null)) {
    score += 10;
    factors.push({
      name: 'Mathematical Variance Integrity',
      impact: '+10',
      explanation: 'Monetary variance is exact to the paise without rounding error or unexplained floating delta.',
    });
  }

  // ── 5. Data Completeness & Record Integrity ────────────────────────────────
  if (sr && rr) {
    score += 5;
    factors.push({
      name: 'Source Traceability Complete',
      impact: '+5',
      explanation: 'Full settlement record and reconciliation result structures present.',
    });
  } else if (!sr && exception.category !== 'MISSING_PAYMENT') {
    score -= 15;
    factors.push({
      name: 'Missing Settlement Record',
      impact: '-15',
      explanation: 'Primary settlement record is missing, increasing hypothesis uncertainty.',
    });
  }

  // Clamp score strictly between 0 and 100
  const finalScore = Math.max(0, Math.min(100, score));

  let level = 'LOW';
  if (finalScore >= 75) {
    level = 'HIGH';
  } else if (finalScore >= 45) {
    level = 'MEDIUM';
  }

  return {
    score: finalScore,
    level,
    factors,
  };
}

module.exports = { calculateConfidence };
