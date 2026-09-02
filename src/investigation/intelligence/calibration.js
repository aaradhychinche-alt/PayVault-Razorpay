'use strict';
/**
 * src/investigation/intelligence/calibration.js
 *
 * Confidence Calibration Module (Chunk 4).
 *
 * Refines the internal confidence mechanism by factoring in historical precedent,
 * confirmed human resolutions, cross-transaction patterns, and statistical anomalies.
 *
 * RULES:
 * - Does NOT arbitrarily inflate confidence simply because more data exists.
 * - Confirmed historical alignment increases confidence.
 * - Historical conflict or unresolved anomalies decrease confidence.
 * - Internal signal only — never exposed to user-facing UI.
 */

/**
 * Calibrate internal confidence using multi-source intelligence signals.
 *
 * @param {Object} params
 * @param {Object} params.baseConfidence     - Base confidence output from confidence.js
 * @param {Object} params.historicalContext  - Similar cases and historical comparison
 * @param {Object} params.anomalyContext     - Detected statistical anomalies
 * @param {Object} params.memoryContext      - Confirmed human resolutions
 * @param {Object} params.patterns           - Cross-transaction patterns
 * @param {Object} params.investigationCase  - Current investigation case
 * @returns {Object} Calibrated confidence structure { score, level, factors }
 */
function calibrateConfidence({
  baseConfidence,
  historicalContext,
  anomalyContext,
  memoryContext,
  patterns = [],
  investigationCase,
}) {
  let score = baseConfidence?.score ?? 50;
  const factors = [...(baseConfidence?.factors || [])];

  // ── 1. Confirmed Historical Precedent Calibration ───────────────────────────
  if (memoryContext && memoryContext.matching_category_precedents > 0) {
    const precedentCount = memoryContext.matching_category_precedents;
    const dominantReason = memoryContext.dominant_historical_reason;

    const gain = Math.min(15, precedentCount * 5);
    score += gain;
    factors.push({
      name: 'Confirmed Historical Precedent',
      impact: `+${gain}`,
      explanation: `${precedentCount} confirmed human-resolved cases with matching category support the hypothesis (dominant: ${dominantReason}).`,
    });
  }

  // ── 2. Structural Similarity Corroboration ──────────────────────────────────
  if (historicalContext && historicalContext.similar_previous_cases && historicalContext.similar_previous_cases.length > 0) {
    const highSimilarityCases = historicalContext.similar_previous_cases.filter(c => c.similarity_score >= 0.70);
    if (highSimilarityCases.length > 0) {
      score += 5;
      factors.push({
        name: 'High Structural Similarity',
        impact: '+5',
        explanation: `${highSimilarityCases.length} previous cases share >= 70% structural signal alignment.`,
      });
    }
  }

  // ── 3. Cross-Transaction Pattern Strength ───────────────────────────────────
  if (patterns && patterns.length > 0) {
    const patternCount = patterns.length;
    const gain = Math.min(10, patternCount * 4);
    score += gain;
    factors.push({
      name: 'Cross-Transaction Pattern Alignment',
      impact: `+${gain}`,
      explanation: `${patternCount} recurrent cross-transaction pattern(s) validate this exception class.`,
    });
  }

  // ── 4. Statistical Anomaly Penalty ──────────────────────────────────────────
  if (anomalyContext && anomalyContext.anomalies && anomalyContext.anomalies.length > 0) {
    const criticals = anomalyContext.anomalies.filter(a => a.severity === 'CRITICAL').length;
    const highs     = anomalyContext.anomalies.filter(a => a.severity === 'HIGH').length;

    const penalty = criticals * 15 + highs * 8;
    if (penalty > 0) {
      score -= penalty;
      factors.push({
        name: 'Statistical Anomaly Variance',
        impact: `-${penalty}`,
        explanation: `${anomalyContext.anomalies.length} statistical anomaly outlier(s) introduce variance into expected behavior.`,
      });
    }
  }

  // ── 5. Bound Final Score (0 - 100) ──────────────────────────────────────────
  score = Math.max(5, Math.min(98, Math.round(score)));

  let level = 'LOW';
  if (score >= 75) level = 'HIGH';
  else if (score >= 50) level = 'MEDIUM';

  return {
    score,
    level,
    factors,
    is_calibrated: true,
  };
}

module.exports = {
  calibrateConfidence,
};
