'use strict';
/**
 * src/investigation/intelligence/similarCases.js
 *
 * Deterministic Similar Case Retrieval Module (Chunk 4).
 *
 * Computes transparent, explainable similarity scores between the current
 * InvestigationCase and previously recorded historical exceptions.
 *
 * RULES:
 * - Deterministic, weighted multi-signal matching (0.0 to 1.0).
 * - No external vector databases or opaque embeddings.
 * - Always includes explicit `matched_signals` for explainability.
 * - Excludes the current case from comparison.
 */

const dataStore = require('../../store/dataStore');

/**
 * Retrieve structurally similar historical cases for a given investigation case.
 *
 * @param {Object} investigationCase - Current case built by caseBuilder
 * @param {Object} store             - Complete dataStore state
 * @param {Object} [options]         - Retrieval options
 * @param {number} [options.limit=5] - Maximum similar cases to return
 * @param {number} [options.threshold=0.25] - Minimum similarity score threshold
 * @returns {Object[]} Array of similar cases sorted by similarity_score desc
 */
function findSimilarCases(investigationCase, store, options = {}) {
  const storeInstance = store || dataStore.getStore();
  if (!storeInstance || !storeInstance.exceptions || storeInstance.exceptions.length <= 1) {
    return [];
  }

  const limit     = options.limit ?? 5;
  const threshold = options.threshold ?? 0.25;

  const currentCaseId     = investigationCase.case_id;
  const currentCategory   = investigationCase.exception_category;
  const currentAmount     = investigationCase.amount_at_risk || 0;
  const currentSr         = investigationCase.settlement_record;
  const currentMo         = investigationCase.merchant_order;
  const currentFa         = investigationCase.financial_analysis;
  const currentMethod     = currentSr?.payment_method || currentMo?.payment_method || null;
  const currentHasFeeVar  = !!(currentFa && currentFa.fee_variance !== null && currentFa.fee_variance !== 0);
  const currentHasTaxVar  = !!(currentFa && currentFa.tax_variance !== null && currentFa.tax_variance !== 0);
  const currentMissingOrder = !currentMo || !currentSr?.order_id;
  const currentMissingSr    = !currentSr;

  const candidates = [];

  for (const otherExc of storeInstance.exceptions) {
    if (otherExc.id === currentCaseId) continue; // Do not compare with self

    const otherRr = (storeInstance.reconciliationResults || []).find(r => r.id === otherExc.reconciliation_result_id);
    const otherSr = (storeInstance.settlementRecords || []).find(r => r.entity_id === otherExc.settlement_record_id || r.id === otherExc.settlement_record_id);
    const otherMo = (storeInstance.merchantOrders || []).find(o => o.id === otherExc.merchant_order_id);
    let otherLifecycle = null;
    if (storeInstance.caseStatus && storeInstance.caseStatus.has(otherExc.id)) {
      otherLifecycle = storeInstance.caseStatus.get(otherExc.id);
    } else if (typeof storeInstance.getCaseLifecycle === 'function') {
      otherLifecycle = storeInstance.getCaseLifecycle(otherExc.id);
    } else {
      otherLifecycle = dataStore.getCaseLifecycle(otherExc.id);
    }

    let score = 0.0;
    const matchedSignals = [];

    // ── Signal 1: Exception Category Match (Weight: 0.35) ─────────────────────
    if (otherExc.category === currentCategory) {
      score += 0.35;
      matchedSignals.push('same_exception_category');
    }

    // ── Signal 2: Payment Method Match (Weight: 0.15) ─────────────────────────
    const otherMethod = otherSr?.payment_method || otherMo?.payment_method || null;
    if (currentMethod && otherMethod && currentMethod.toLowerCase() === otherMethod.toLowerCase()) {
      score += 0.15;
      matchedSignals.push('same_payment_method');
    }

    // ── Signal 3: Amount Scale & Variance Alignment (Weight: 0.15) ────────────
    const otherAmount = otherExc.amount_at_risk || 0;
    const amountDiff = Math.abs(currentAmount - otherAmount);
    if (currentAmount > 0 && otherAmount > 0) {
      if (amountDiff === 0) {
        score += 0.15;
        matchedSignals.push('identical_amount_at_risk');
      } else if (amountDiff <= Math.max(currentAmount, otherAmount) * 0.20) {
        score += 0.12;
        matchedSignals.push('similar_amount_at_risk');
      } else if (amountDiff <= Math.max(currentAmount, otherAmount) * 0.50) {
        score += 0.06;
        matchedSignals.push('comparable_amount_scale');
      }
    }

    // ── Signal 4: Fee Variance Pattern Alignment (Weight: 0.10) ───────────────
    const otherFeeDiff = otherSr ? (otherSr.fee - Math.round(otherSr.amount * 0.02)) : 0;
    const otherHasFeeVar = otherFeeDiff !== 0;
    if (currentHasFeeVar && otherHasFeeVar) {
      score += 0.10;
      matchedSignals.push('similar_fee_variance');
    }

    // ── Signal 5: Tax Variance Pattern Alignment (Weight: 0.05) ───────────────
    const otherTaxDiff = otherSr ? (otherSr.tax - Math.round(otherSr.fee * 0.18)) : 0;
    const otherHasTaxVar = otherTaxDiff !== 0;
    if (currentHasTaxVar && otherHasTaxVar) {
      score += 0.05;
      matchedSignals.push('similar_tax_variance');
    }

    // ── Signal 6: Missing Entity Structure Match (Weight: 0.10) ───────────────
    const otherMissingOrder = !otherMo || !otherSr?.order_id;
    const otherMissingSr    = !otherSr;
    if (currentMissingOrder && otherMissingOrder) {
      score += 0.10;
      matchedSignals.push('same_missing_order_structure');
    } else if (currentMissingSr && otherMissingSr) {
      score += 0.10;
      matchedSignals.push('same_missing_settlement_structure');
    }

    // ── Signal 7: Batch Timing Relationship (Weight: 0.10) ────────────────────
    if (currentCategory === 'TIMING_MISMATCH' && otherExc.category === 'TIMING_MISMATCH') {
      score += 0.10;
      matchedSignals.push('cross_batch_settlement_timing');
    } else if (currentCategory === 'DUPLICATE' && otherExc.category === 'DUPLICATE') {
      score += 0.10;
      matchedSignals.push('duplicate_transaction_window');
    }

    const roundedScore = Math.min(1.0, Math.round(score * 100) / 100);

    if (roundedScore >= threshold) {
      candidates.push({
        case_id:                    otherExc.id,
        similarity_score:           roundedScore,
        matched_signals:            matchedSignals,
        category:                   otherExc.category,
        amount_at_risk:             otherAmount,
        financial_difference_paise: amountDiff,
        status:                     otherLifecycle.status || 'OPEN',
        resolution:                 otherLifecycle.resolution || null,
        settlement_record_id:       otherExc.settlement_record_id || null,
        merchant_order_id:          otherExc.merchant_order_id || null,
      });
    }
  }

  // Sort descending by similarity score, then ascending by financial difference
  candidates.sort((a, b) => b.similarity_score - a.similarity_score || a.financial_difference_paise - b.financial_difference_paise);

  return candidates.slice(0, limit);
}

module.exports = {
  findSimilarCases,
};
