'use strict';
/**
 * src/investigation/intelligence/patternHistory.js
 *
 * Cross-Transaction Pattern Detection Module (Chunk 4).
 *
 * Analyzes multiple transactions and exceptions across the store to identify
 * genuine recurring patterns without manufacturing false correlations.
 *
 * RULES:
 * - A pattern is only reported if supported by >= 2 underlying records.
 * - All monetary values are integer paise.
 * - Every pattern includes supporting_case_ids, supporting_entity_ids, and evidence references.
 */

/**
 * Detect cross-transaction patterns relevant to the current investigation case.
 *
 * @param {Object} investigationCase - Current case built by caseBuilder
 * @param {Object} store             - Complete dataStore state
 * @returns {Object[]} Array of detected cross-transaction patterns
 */
function detectPatternHistory(investigationCase, store) {
  if (!store || !store.exceptions || store.exceptions.length === 0) {
    return [];
  }

  const currentCaseId   = investigationCase.case_id;
  const currentCategory = investigationCase.exception_category;
  const currentAmount   = investigationCase.amount_at_risk || 0;
  const currentMethod   = investigationCase.settlement_record?.payment_method
    || investigationCase.merchant_order?.payment_method
    || null;

  const allExceptions   = store.exceptions || [];
  const patterns        = [];
  let patternSeq        = 0;

  function makePatternId(type) {
    return `ptrn_${type.toLowerCase()}_${String(++patternSeq).padStart(3, '0')}`;
  }

  // ── 1. Repeated Category Pattern ────────────────────────────────────────────
  const sameCategoryCases = allExceptions.filter(e => e.category === currentCategory);
  if (sameCategoryCases.length >= 2) {
    const caseIds = sameCategoryCases.map(e => e.id);
    const entityIds = sameCategoryCases
      .map(e => e.settlement_record_id || e.merchant_order_id)
      .filter(Boolean);

    const timestamps = sameCategoryCases
      .map(e => e.created_at || (e.timestamp ? (e.timestamp < 1e11 ? e.timestamp * 1000 : e.timestamp) : Date.now()))
      .filter(Boolean);

    const totalImpact = sameCategoryCases.reduce((sum, e) => sum + (e.amount_at_risk || 0), 0);

    const typeNameMap = {
      FEE_TAX_VARIANCE: 'REPEATED_FEE_TAX_VARIANCE',
      TIMING_MISMATCH:  'REPEATED_TIMING_MISMATCH',
      MISSING_ORDER:    'REPEATED_MISSING_ORDER',
      MISSING_PAYMENT:  'REPEATED_MISSING_PAYMENT',
      DUPLICATE:        'REPEATED_DUPLICATE_SETTLEMENT',
      ADJUSTMENT:       'REPEATED_ADJUSTMENT',
      UNEXPLAINED:      'REPEATED_UNEXPLAINED_SHORTFALL',
      PARTIAL_REFUND:   'REPEATED_PARTIAL_REFUND',
      CLEAN_MATCH:      'REPEATED_CLEAN_MATCH',
    };

    const patternType = typeNameMap[currentCategory] || `REPEATED_${currentCategory}`;
    const categoryHuman = currentCategory.replace(/_/g, ' ').toLowerCase();

    patterns.push({
      pattern_id:             makePatternId(patternType),
      pattern_type:           patternType,
      description:            `${sameCategoryCases.length} exceptions with ${categoryHuman} recorded across settlements with total exposure of ₹${(totalImpact / 100).toFixed(2)}.`,
      supporting_case_ids:    caseIds,
      supporting_entity_ids:  entityIds,
      occurrence_count:       sameCategoryCases.length,
      first_seen:             timestamps.length > 0 ? Math.min(...timestamps) : null,
      last_seen:              timestamps.length > 0 ? Math.max(...timestamps) : null,
      financial_impact_paise: totalImpact,
      evidence_ids:           ['ev_exception_category', 'ev_amount_at_risk'],
    });
  }

  // ── 2. Repeated Payment Method Pattern ──────────────────────────────────────
  if (currentMethod) {
    const sameMethodCases = allExceptions.filter(e => {
      const sr = (store.settlementRecords || []).find(r => r.entity_id === e.settlement_record_id || r.id === e.settlement_record_id);
      const mo = (store.merchantOrders || []).find(o => o.id === e.merchant_order_id);
      const method = sr?.payment_method || mo?.payment_method;
      return method && method.toLowerCase() === currentMethod.toLowerCase();
    });

    if (sameMethodCases.length >= 2) {
      const caseIds = sameMethodCases.map(e => e.id);
      const entityIds = sameMethodCases
        .map(e => e.settlement_record_id || e.merchant_order_id)
        .filter(Boolean);

      const timestamps = sameMethodCases
        .map(e => e.created_at || (e.timestamp ? (e.timestamp < 1e11 ? e.timestamp * 1000 : e.timestamp) : Date.now()))
        .filter(Boolean);

      const totalImpact = sameMethodCases.reduce((sum, e) => sum + (e.amount_at_risk || 0), 0);

      patterns.push({
        pattern_id:             makePatternId('REPEATED_PAYMENT_METHOD_ISSUE'),
        pattern_type:           'REPEATED_PAYMENT_METHOD_ISSUE',
        description:            `${sameMethodCases.length} exceptions involve ${currentMethod.toUpperCase()} payment instruments.`,
        supporting_case_ids:    caseIds,
        supporting_entity_ids:  entityIds,
        occurrence_count:       sameMethodCases.length,
        first_seen:             timestamps.length > 0 ? Math.min(...timestamps) : null,
        last_seen:              timestamps.length > 0 ? Math.max(...timestamps) : null,
        financial_impact_paise: totalImpact,
        evidence_ids:           ['ev_payment_method'],
      });
    }
  }

  // ── 3. Similar Monetary Amount Clustering (±15% tolerance) ──────────────────
  if (currentAmount > 0) {
    const lowerBound = Math.round(currentAmount * 0.85);
    const upperBound = Math.round(currentAmount * 1.15);

    const similarAmountCases = allExceptions.filter(e => {
      const amt = e.amount_at_risk || 0;
      return amt >= lowerBound && amt <= upperBound;
    });

    if (similarAmountCases.length >= 2) {
      const caseIds = similarAmountCases.map(e => e.id);
      const entityIds = similarAmountCases
        .map(e => e.settlement_record_id || e.merchant_order_id)
        .filter(Boolean);

      const timestamps = similarAmountCases
        .map(e => e.created_at || (e.timestamp ? (e.timestamp < 1e11 ? e.timestamp * 1000 : e.timestamp) : Date.now()))
        .filter(Boolean);

      const totalImpact = similarAmountCases.reduce((sum, e) => sum + (e.amount_at_risk || 0), 0);

      patterns.push({
        pattern_id:             makePatternId('REPEATED_AMOUNT_CLUSTERING'),
        pattern_type:           'REPEATED_AMOUNT_CLUSTERING',
        description:            `${similarAmountCases.length} exceptions cluster around ₹${(currentAmount / 100).toFixed(2)} (within ±15% range).`,
        supporting_case_ids:    caseIds,
        supporting_entity_ids:  entityIds,
        occurrence_count:       similarAmountCases.length,
        first_seen:             timestamps.length > 0 ? Math.min(...timestamps) : null,
        last_seen:              timestamps.length > 0 ? Math.max(...timestamps) : null,
        financial_impact_paise: totalImpact,
        evidence_ids:           ['ev_amount_at_risk'],
      });
    }
  }

  // ── 4. Temporal Batch/Time Window Clustering (within 24h) ───────────────────
  const currentTs = investigationCase.exception?.created_at
    || (investigationCase.exception?.timestamp
      ? (investigationCase.exception.timestamp < 1e11 ? investigationCase.exception.timestamp * 1000 : investigationCase.exception.timestamp)
      : null);

  if (currentTs) {
    const windowMs = 86400 * 1000; // 24 hours
    const closeInTimeCases = allExceptions.filter(e => {
      const ts = e.created_at || (e.timestamp ? (e.timestamp < 1e11 ? e.timestamp * 1000 : e.timestamp) : null);
      return ts && Math.abs(ts - currentTs) <= windowMs;
    });

    if (closeInTimeCases.length >= 3) {
      const caseIds = closeInTimeCases.map(e => e.id);
      const entityIds = closeInTimeCases
        .map(e => e.settlement_record_id || e.merchant_order_id)
        .filter(Boolean);

      const timestamps = closeInTimeCases
        .map(e => e.created_at || (e.timestamp ? (e.timestamp < 1e11 ? e.timestamp * 1000 : e.timestamp) : null))
        .filter(Boolean);

      const totalImpact = closeInTimeCases.reduce((sum, e) => sum + (e.amount_at_risk || 0), 0);

      patterns.push({
        pattern_id:             makePatternId('TEMPORAL_EXCEPTION_CLUSTER'),
        pattern_type:           'TEMPORAL_EXCEPTION_CLUSTER',
        description:            `${closeInTimeCases.length} exceptions occurred in a concentrated 24-hour settlement window.`,
        supporting_case_ids:    caseIds,
        supporting_entity_ids:  entityIds,
        occurrence_count:       closeInTimeCases.length,
        first_seen:             Math.min(...timestamps),
        last_seen:              Math.max(...timestamps),
        financial_impact_paise: totalImpact,
        evidence_ids:           ['ev_timeline_timestamp'],
      });
    }
  }

  return patterns;
}

module.exports = {
  detectPatternHistory,
};
