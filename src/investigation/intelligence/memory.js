'use strict';
/**
 * src/investigation/intelligence/memory.js
 *
 * Investigation Memory Module (Chunk 4).
 *
 * Manages confirmed historical knowledge from human-resolved cases while
 * strictly isolating provisional AI inferences from authoritative historical memory.
 *
 * RULES:
 * - Never modifies original investigation or transaction records.
 * - Never overwrites history or audit logs.
 * - Only human-resolved cases (Chunk 3) become CONFIRMED_HUMAN_RESOLUTION.
 * - AI inferences are explicitly tagged as AI_INFERENCE (provisional only).
 */

const dataStore = require('../../store/dataStore');

const MemoryProvenance = {
  CONFIRMED_HUMAN_RESOLUTION: 'CONFIRMED_HUMAN_RESOLUTION',
  AI_INFERENCE:               'AI_INFERENCE',
  UNRESOLVED:                 'UNRESOLVED',
};

/**
 * Retrieve all confirmed human resolutions stored across the application.
 *
 * @param {Object} store - dataStore instance or store state
 * @returns {Object[]} Array of confirmed resolution memory records
 */
function getConfirmedResolutions(store) {
  const storeInstance = store || dataStore.getStore();
  const exceptions = storeInstance?.exceptions || [];
  const confirmed = [];

  for (const exc of exceptions) {
    let lifecycle = null;
    if (storeInstance.caseStatus && storeInstance.caseStatus.has(exc.id)) {
      lifecycle = storeInstance.caseStatus.get(exc.id);
    } else if (typeof storeInstance.getCaseLifecycle === 'function') {
      lifecycle = storeInstance.getCaseLifecycle(exc.id);
    } else {
      lifecycle = dataStore.getCaseLifecycle(exc.id);
    }

    if (lifecycle && lifecycle.status === 'RESOLVED' && lifecycle.resolution) {
      const res = lifecycle.resolution;
      confirmed.push({
        case_id:                 exc.id,
        exception_category:      exc.category,
        provenance:              MemoryProvenance.CONFIRMED_HUMAN_RESOLUTION,
        resolution_reason:       res.resolution_reason,
        resolution_reason_label: res.resolution_reason_label,
        resolution_notes:        res.resolution_notes,
        resolved_by:             res.resolved_by,
        resolved_at:             res.resolved_at,
        amount_at_risk_paise:    exc.amount_at_risk,
        settlement_record_id:    exc.settlement_record_id || null,
        merchant_order_id:       exc.merchant_order_id || null,
      });
    }
  }

  return confirmed;
}

/**
 * Build a memory snapshot for the current case, extracting matching confirmed precedents.
 *
 * @param {Object} investigationCase - Current case built by caseBuilder
 * @param {Object} store             - Complete dataStore state
 * @returns {Object} Memory snapshot matching the current case
 */
function getMemorySnapshot(investigationCase, store) {
  const confirmed = getConfirmedResolutions(store);
  const currentCategory = investigationCase.exception_category;
  const currentCaseId   = investigationCase.case_id;

  // Filter confirmed precedents for the same category (excluding current case if it was previously resolved)
  const categoryPrecedents = confirmed.filter(
    m => m.exception_category === currentCategory && m.case_id !== currentCaseId,
  );

  const reasonCounts = {};
  for (const p of categoryPrecedents) {
    const r = p.resolution_reason;
    reasonCounts[r] = (reasonCounts[r] || 0) + 1;
  }

  let dominantReason = null;
  let maxCount = 0;
  for (const [r, count] of Object.entries(reasonCounts)) {
    if (count > maxCount) {
      maxCount = count;
      dominantReason = r;
    }
  }

  let precedentSummary = null;
  if (categoryPrecedents.length > 0 && dominantReason) {
    precedentSummary = `${categoryPrecedents.length} previous ${currentCategory} case(s) resolved with confirmed human resolution (predominantly '${dominantReason}').`;
  }

  return {
    total_confirmed_resolutions: confirmed.length,
    matching_category_precedents: categoryPrecedents.length,
    confirmed_resolutions:       categoryPrecedents,
    dominant_historical_reason:  dominantReason,
    precedent_summary:           precedentSummary,
    memory_provenance:           MemoryProvenance.CONFIRMED_HUMAN_RESOLUTION,
  };
}

module.exports = {
  MemoryProvenance,
  getConfirmedResolutions,
  getMemorySnapshot,
};
