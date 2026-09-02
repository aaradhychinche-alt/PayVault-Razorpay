'use strict';
/**
 * src/investigation/ai/difficulty.js
 *
 * Payvault Difficulty & Ambiguity Evaluation Engine.
 *
 * Evaluates whether an exception case is straightforward (Payvault Local ML is sufficient)
 * or difficult/ambiguous (requires escalation to local Qwen model).
 *
 * Signals Evaluated:
 *  1. Model probability margin between top predictions
 *  2. Prediction confidence vs configurable thresholds
 *  3. Number of competing plausible categories (>15% probability)
 *  4. Evidence completeness & missing entity references
 *  5. Missing or broken transactional relationships in graph
 *  6. Contradictory evidence (e.g. status flags vs monetary records)
 *  7. Complex category interactions (e.g. ADJUSTMENT, UNEXPLAINED, DUPLICATE)
 *  8. Amount variance complexity (non-linear fee/tax deviations)
 */

const DIFFICULTY_THRESHOLD = parseFloat(process.env.AI_DIFFICULTY_THRESHOLD || '50'); // 0-100 scale
const PROBABILITY_MARGIN_THRESHOLD = parseFloat(process.env.AI_PROB_MARGIN_THRESHOLD || '0.25');
const CONFIDENCE_MIN_THRESHOLD = parseFloat(process.env.AI_PRIMARY_CONFIDENCE_THRESHOLD || '0.75');

/**
 * Evaluate the difficulty and ambiguity of an investigation case.
 *
 * @param {Object} investigationCase - Standard InvestigationCase
 * @param {Object} [mlAnalysis]      - Primary ML model analysis
 * @param {Object} [options]         - Override options
 * @returns {Object} Internal difficulty evaluation
 */
function evaluateDifficulty(investigationCase, mlAnalysis = {}, options = {}) {
  const reasons = [];
  let score = 0;

  const threshold = options.difficultyThreshold || DIFFICULTY_THRESHOLD;
  const marginThreshold = options.marginThreshold || PROBABILITY_MARGIN_THRESHOLD;
  const confMinThreshold = options.confidenceThreshold || CONFIDENCE_MIN_THRESHOLD;

  const cat = investigationCase.exception_category || 'UNEXPLAINED';
  const probs = mlAnalysis.all_probabilities || mlAnalysis.probabilities || {};
  const confidence = (typeof mlAnalysis.confidence === 'number')
    ? mlAnalysis.confidence
    : (cat === 'CLEAN_MATCH' ? 1.0 : 0.70);

  // ── Signal 1: Model Prediction Confidence ─────────────────────────────────
  if (confidence < confMinThreshold) {
    const penalty = Math.round(((confMinThreshold - confidence) / confMinThreshold) * 40) + 15;
    score += penalty;
    reasons.push(`Low primary model confidence (${Math.round(confidence * 100)}% < ${Math.round(confMinThreshold * 100)}%)`);
  }

  // ── Signal 2: Top-2 Class Probability Margin ─────────────────────────────
  const sortedProbs = Object.entries(probs).sort((a, b) => b[1] - a[1]);
  if (sortedProbs.length >= 2) {
    const top1 = sortedProbs[0][1];
    const top2 = sortedProbs[1][1];
    const margin = top1 - top2;

    if (margin < marginThreshold) {
      const marginPenalty = margin < 0.10 ? 35 : 25;
      score += marginPenalty;
      reasons.push(`Ambiguous probability margin (${(margin * 100).toFixed(1)}%) between '${sortedProbs[0][0]}' and '${sortedProbs[1][0]}'`);
    }

    // ── Signal 3: Competing Plausible Hypotheses (>15% probability) ─────────
    const competing = sortedProbs.filter(([, p]) => p >= 0.15);
    if (competing.length >= 3) {
      score += 20;
      reasons.push(`Multiple competing plausible categories (${competing.map(([c]) => c).join(', ')})`);
    }
  }

  // ── Signal 4: Disconnected / Missing Transaction Relationships ───────────
  const relationships = investigationCase.relationships || [];
  const missingRels = relationships.filter(r => r.status === 'MISSING');
  if (missingRels.length > 0) {
    score += missingRels.length * 15;
    reasons.push(`${missingRels.length} broken/missing entity relationship(s) detected (${missingRels.map(r => r.relationship_type).join(', ')})`);
  }

  // ── Signal 5: Category Inherent Complexity ────────────────────────────────
  // UNEXPLAINED and ADJUSTMENT have no direct 1-to-1 formulaic rule and benefit from deeper reasoning
  if (cat === 'UNEXPLAINED') {
    score += 30;
    reasons.push('Unexplained discrepancy without standard fee/tax deviation signature');
  } else if (cat === 'ADJUSTMENT') {
    score += 25;
    reasons.push('Settlement adjustment requiring contextual ledger reconciliation');
  } else if (cat === 'DUPLICATE') {
    // Check if twin settlement has subtle variance
    const fa = investigationCase.financial_analysis || {};
    if (fa.variance && fa.variance !== 0) {
      score += 15;
      reasons.push('Duplicate transaction with non-zero monetary variance');
    }
  }

  // ── Signal 6: Contradictory Evidence & Complex Variance ───────────────────
  const fa = investigationCase.financial_analysis || {};
  const gross = fa.gross_amount || 0;
  const feeAct = fa.fee_actual || 0;
  const taxAct = fa.tax_actual || 0;
  const feeExp = fa.fee_expected || 0;
  const taxExp = fa.tax_expected || 0;

  if (feeAct !== feeExp && taxAct === taxExp) {
    score += 15;
    reasons.push('Asymmetric fee variance without proportional GST adjustment');
  }

  // ── Signal 7: Timeline Irregularities ─────────────────────────────────────
  const timeline = investigationCase.timeline || [];
  if (timeline.length <= 1 && cat !== 'MISSING_PAYMENT') {
    score += 10;
    reasons.push('Sparse event timeline with insufficient lifecycle checkpoints');
  }

  // Cap score at 100
  const finalScore = Math.min(100, Math.max(0, score));

  // Determine Complexity Level
  let complexityLevel = 'LOW';
  if (finalScore >= 70) complexityLevel = 'HIGH';
  else if (finalScore >= 40) complexityLevel = 'MEDIUM';

  const shouldEscalate = finalScore >= threshold;

  return {
    shouldEscalate,
    difficultyScore: finalScore,
    complexityLevel,
    threshold,
    reasons,
    signalsEvaluated: {
      confidence,
      probabilityMargin: sortedProbs.length >= 2 ? (sortedProbs[0][1] - sortedProbs[1][1]) : 1.0,
      missingRelationshipsCount: missingRels.length,
      categoryComplexity: ['UNEXPLAINED', 'ADJUSTMENT'].includes(cat) ? 'HIGH' : 'STANDARD',
    },
  };
}

module.exports = {
  evaluateDifficulty,
  DIFFICULTY_THRESHOLD,
  PROBABILITY_MARGIN_THRESHOLD,
  CONFIDENCE_MIN_THRESHOLD,
};
