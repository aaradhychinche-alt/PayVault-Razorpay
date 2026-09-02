'use strict';
/**
 * src/investigation/intelligence/merchantPatterns.js
 *
 * Repeated Merchant Issues & Trend Analysis Module (Chunk 4).
 *
 * Evaluates whether the current exception reflects systemic merchant-level
 * ledger or gateway patterns based on store history.
 *
 * RULES:
 * - If insufficient history exists (< 2 matching cases), returns "INSUFFICIENT_HISTORY".
 * - Never manufactures historical claims without underlying record backing.
 * - All monetary values are integer paise.
 */

/**
 * Analyze merchant-specific patterns for an exception case.
 *
 * @param {Object} investigationCase - Current case built by caseBuilder
 * @param {Object} store             - Complete dataStore state
 * @returns {Object} Merchant patterns analysis and historical signal
 */
function analyzeMerchantPatterns(investigationCase, store) {
  if (!store || !store.exceptions || store.exceptions.length < 2) {
    return {
      historical_signal: 'INSUFFICIENT_HISTORY',
      merchant_patterns: [],
      summary:           'Insufficient historical transaction records to establish merchant-specific trends.',
      total_history_cases: store?.exceptions ? store.exceptions.length : 0,
    };
  }

  const allExceptions   = store.exceptions || [];
  const currentCategory = investigationCase.exception_category;
  const currentMethod   = investigationCase.settlement_record?.payment_method
    || investigationCase.merchant_order?.payment_method
    || null;

  const patterns = [];
  let seq = 0;

  function makeId(type) {
    return `mptrn_${type.toLowerCase()}_${String(++seq).padStart(3, '0')}`;
  }

  // ── 1. Same-Category Merchant Frequency ─────────────────────────────────────
  const sameCatCases = allExceptions.filter(e => e.category === currentCategory);
  if (sameCatCases.length >= 2) {
    const totalImpact = sameCatCases.reduce((s, e) => s + (e.amount_at_risk || 0), 0);
    const categoryHuman = currentCategory.replace(/_/g, ' ').toLowerCase();

    patterns.push({
      pattern_id:             makeId('MERCHANT_CATEGORY_FREQUENCY'),
      signal_type:            `REPEATED_MERCHANT_${currentCategory}`,
      claim:                  `${sameCatCases.length} similar ${categoryHuman} issues were recorded across merchant settlements with ₹${(totalImpact / 100).toFixed(2)} total exposure.`,
      supporting_case_ids:    sameCatCases.map(e => e.id),
      supporting_entity_ids:  sameCatCases.map(e => e.settlement_record_id || e.merchant_order_id).filter(Boolean),
      occurrence_count:       sameCatCases.length,
      financial_impact_paise: totalImpact,
      timeframe_days:         30,
    });
  }

  // ── 2. Payment Method Alignment ─────────────────────────────────────────────
  if (currentMethod) {
    const methodCases = allExceptions.filter(e => {
      const sr = (store.settlementRecords || []).find(r => r.entity_id === e.settlement_record_id || r.id === e.settlement_record_id);
      const mo = (store.merchantOrders || []).find(o => o.id === e.merchant_order_id);
      const method = sr?.payment_method || mo?.payment_method;
      return method && method.toLowerCase() === currentMethod.toLowerCase();
    });

    if (methodCases.length >= 2) {
      const totalImpact = methodCases.reduce((s, e) => s + (e.amount_at_risk || 0), 0);
      patterns.push({
        pattern_id:             makeId('MERCHANT_METHOD_PATTERN'),
        signal_type:            'REPEATED_MERCHANT_PAYMENT_METHOD',
        claim:                  `${methodCases.length} previous merchant exceptions involved ${currentMethod.toUpperCase()} payment instruments.`,
        supporting_case_ids:    methodCases.map(e => e.id),
        supporting_entity_ids:  methodCases.map(e => e.settlement_record_id || e.merchant_order_id).filter(Boolean),
        occurrence_count:       methodCases.length,
        financial_impact_paise: totalImpact,
        timeframe_days:         30,
      });
    }
  }

  // ── 3. Missing Order Linkages Pattern ───────────────────────────────────────
  if (currentCategory === 'MISSING_ORDER' || !investigationCase.merchant_order) {
    const unlinkedCases = allExceptions.filter(e => {
      const rr = (store.reconciliationResults || []).find(r => r.id === e.reconciliation_result_id);
      return !e.merchant_order_id && (!rr || !rr.merchant_order_id);
    });

    if (unlinkedCases.length >= 2) {
      const totalImpact = unlinkedCases.reduce((s, e) => s + (e.amount_at_risk || 0), 0);
      patterns.push({
        pattern_id:             makeId('MERCHANT_UNLINKED_ORDER_PATTERN'),
        signal_type:            'REPEATED_UNLINKED_ORDER_RELATIONSHIP',
        claim:                  `${unlinkedCases.length} settlements arrived without an internal merchant order ID linkage in the merchant ledger.`,
        supporting_case_ids:    unlinkedCases.map(e => e.id),
        supporting_entity_ids:  unlinkedCases.map(e => e.settlement_record_id).filter(Boolean),
        occurrence_count:       unlinkedCases.length,
        financial_impact_paise: totalImpact,
        timeframe_days:         30,
      });
    }
  }

  if (patterns.length === 0) {
    return {
      historical_signal: 'NO_SIGNIFICANT_PATTERNS',
      merchant_patterns: [],
      summary:           'No recurrent merchant-specific exception patterns identified.',
      total_history_cases: allExceptions.length,
    };
  }

  return {
    historical_signal: 'PATTERNS_DETECTED',
    merchant_patterns: patterns,
    summary:           patterns.map(p => p.claim).join(' '),
    total_history_cases: allExceptions.length,
  };
}

module.exports = {
  analyzeMerchantPatterns,
};
