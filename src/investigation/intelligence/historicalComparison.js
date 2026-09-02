'use strict';
/**
 * src/investigation/intelligence/historicalComparison.js
 *
 * Historical Exception Comparison Module (Chunk 4).
 *
 * Compares the current investigation case against structurally similar
 * historical cases to extract precedents, resolution outcomes, and key differences.
 *
 * IMPORTANT:
 * - Historical cases serve as context and evidence, NOT automatic ground truth.
 * - Human operators always review evidence to determine current case resolution.
 */

const { findSimilarCases } = require('./similarCases');

/**
 * Perform a comparative analysis between the current case and similar historical cases.
 *
 * @param {Object} investigationCase - Current case built by caseBuilder
 * @param {Object} store             - Complete dataStore state
 * @returns {Object} Comparative historical analysis
 */
function compareAgainstHistory(investigationCase, store) {
  const similarCases = findSimilarCases(investigationCase, store, { limit: 5, threshold: 0.25 });

  if (similarCases.length === 0) {
    return {
      has_similar_cases:             false,
      has_confirmed_precedent:       false,
      similar_previous_cases:        [],
      confirmed_resolutions_count:   0,
      resolution_breakdown:          {},
      most_common_resolution_reason: null,
      common_evidence:               [],
      differences:                   ['No structurally similar historical cases found in store.'],
      total_historical_impact_paise: 0,
      context_summary:               'No matching historical cases found. Case requires standalone primary investigation.',
      is_definitive_truth:           false,
    };
  }

  // Aggregate resolutions
  const resolutionBreakdown = {};
  let confirmedCount = 0;

  for (const sc of similarCases) {
    if (sc.status === 'RESOLVED' && sc.resolution && sc.resolution.resolution_reason) {
      confirmedCount++;
      const reason = sc.resolution.resolution_reason;
      resolutionBreakdown[reason] = (resolutionBreakdown[reason] || 0) + 1;
    }
  }

  // Determine most common resolution reason
  let mostCommonReason = null;
  let maxCount = 0;
  for (const [reason, count] of Object.entries(resolutionBreakdown)) {
    if (count > maxCount) {
      maxCount = count;
      mostCommonReason = reason;
    }
  }

  // Identify common factual evidence
  const commonEvidence = [];
  const topMatch = similarCases[0];

  if (topMatch.matched_signals.includes('same_exception_category')) {
    commonEvidence.push(`Shared exception category (${investigationCase.exception_category}) across ${similarCases.length} similar cases`);
  }
  if (topMatch.matched_signals.includes('same_payment_method')) {
    const method = investigationCase.settlement_record?.payment_method || investigationCase.merchant_order?.payment_method;
    commonEvidence.push(`Consistent payment method (${method?.toUpperCase()}) in historical occurrences`);
  }
  if (topMatch.matched_signals.includes('similar_fee_variance')) {
    commonEvidence.push('Shared platform fee calculation variance signature');
  }
  if (topMatch.matched_signals.includes('same_missing_order_structure')) {
    commonEvidence.push('Consistent absence of internal merchant order record linkage');
  }

  // Identify notable differences
  const differences = [];
  const currentAmount = investigationCase.amount_at_risk || 0;
  const avgHistAmount = Math.round(
    similarCases.reduce((sum, c) => sum + (c.amount_at_risk || 0), 0) / similarCases.length,
  );

  if (Math.abs(currentAmount - avgHistAmount) > 5000) { // Difference > ₹50
    differences.push(
      `Current exposure of ₹${(currentAmount / 100).toFixed(2)} differs from historical average ₹${(avgHistAmount / 100).toFixed(2)}`,
    );
  }

  const totalHistoricalImpact = similarCases.reduce((sum, c) => sum + (c.amount_at_risk || 0), 0);

  // Synthesize context summary
  let contextSummary = '';
  if (confirmedCount > 0 && mostCommonReason) {
    const reasonLabel = mostCommonReason.replace(/_/g, ' ').toLowerCase();
    contextSummary = `${confirmedCount} of ${similarCases.length} similar previous cases were resolved with confirmation of "${reasonLabel}".`;
  } else if (similarCases.length > 0) {
    contextSummary = `${similarCases.length} structurally similar cases exist in active review without confirmed historical resolution.`;
  }

  return {
    has_similar_cases:             true,
    has_confirmed_precedent:       confirmedCount > 0,
    similar_previous_cases:        similarCases,
    confirmed_resolutions_count:   confirmedCount,
    resolution_breakdown:          resolutionBreakdown,
    most_common_resolution_reason: mostCommonReason,
    common_evidence:               commonEvidence,
    differences:                   differences,
    total_historical_impact_paise: totalHistoricalImpact,
    context_summary:               contextSummary,
    is_definitive_truth:           false, // Explicit notice that history is context, not ground truth
  };
}

module.exports = {
  compareAgainstHistory,
};
