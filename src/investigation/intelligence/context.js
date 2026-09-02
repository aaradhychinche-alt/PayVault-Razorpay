'use strict';
/**
 * src/investigation/intelligence/context.js
 *
 * Investigation Intelligence Context Contract Assembler (Chunk 4).
 *
 * Combines cross-transaction patterns, merchant trends, similar cases,
 * confirmed memory, and anomaly detection into a single, deterministic contract.
 */

const { detectPatternHistory }   = require('./patternHistory');
const { analyzeMerchantPatterns } = require('./merchantPatterns');
const { findSimilarCases }        = require('./similarCases');
const { compareAgainstHistory }   = require('./historicalComparison');
const { detectAnomalies }         = require('./anomaly');
const { getMemorySnapshot }       = require('./memory');

/**
 * Build the complete InvestigationIntelligenceContext for an investigation case.
 *
 * @param {Object} params
 * @param {Object} params.investigationCase - Case built by caseBuilder
 * @param {Object} params.store             - Complete dataStore state
 * @returns {Object} Structured InvestigationIntelligenceContext
 */
function buildIntelligenceContext({ investigationCase, store }) {
  const allExceptions = store?.exceptions || [];
  const historyAvailable = allExceptions.length > 1;

  // 1. Cross-Transaction Patterns
  const repeatedPatterns = detectPatternHistory(investigationCase, store);

  // 2. Merchant-Level History & Trend Patterns
  const merchantPatternsResult = analyzeMerchantPatterns(investigationCase, store);

  // 3. Similar Case Retrieval
  const similarCases = findSimilarCases(investigationCase, store, { limit: 5, threshold: 0.25 });

  // 4. Comparative Historical Analysis
  const historicalComparisons = compareAgainstHistory(investigationCase, store);

  // 5. Statistical & Threshold Anomaly Detection
  const anomalyResult = detectAnomalies(investigationCase, store);

  // 6. Confirmed Human Resolution Memory
  const memorySnapshot = getMemorySnapshot(investigationCase, store);

  return {
    case_id: investigationCase.case_id,

    current_case: {
      category:          investigationCase.exception_category,
      amount_at_risk:    investigationCase.amount_at_risk,
      entity_id:         investigationCase.settlement_record?.entity_id || null,
      order_id:          investigationCase.merchant_order?.id || null,
      payment_method:    investigationCase.settlement_record?.payment_method || investigationCase.merchant_order?.payment_method || null,
    },

    historical_context: {
      similar_cases:          similarCases,
      repeated_patterns:      repeatedPatterns,
      merchant_patterns:      merchantPatternsResult.merchant_patterns || [],
      merchant_signal:        merchantPatternsResult.historical_signal,
      historical_comparisons: historicalComparisons,
    },

    anomaly_context: {
      has_sufficient_history: anomalyResult.has_sufficient_history,
      anomalies:              anomalyResult.anomalies,
      baseline_note:          anomalyResult.baseline_note,
      baseline_stats:         anomalyResult.baseline_stats,
    },

    memory_context: {
      total_confirmed_resolutions:  memorySnapshot.total_confirmed_resolutions,
      matching_category_precedents: memorySnapshot.matching_category_precedents,
      confirmed_resolutions:        memorySnapshot.confirmed_resolutions,
      dominant_historical_reason:   memorySnapshot.dominant_historical_reason,
      precedent_summary:            memorySnapshot.precedent_summary,
      provenance:                   memorySnapshot.memory_provenance,
    },

    intelligence_metadata: {
      history_available:      historyAvailable,
      cases_considered:       allExceptions.length,
      total_store_exceptions: allExceptions.length,
      similar_cases_found:    similarCases.length,
      anomalies_found:        anomalyResult.anomalies.length,
      patterns_found:         repeatedPatterns.length,
      generated_at:           new Date().toISOString(),
    },
  };
}

module.exports = {
  buildIntelligenceContext,
};
