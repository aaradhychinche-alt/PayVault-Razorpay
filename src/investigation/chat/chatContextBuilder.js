'use strict';
/**
 * src/investigation/chat/chatContextBuilder.js
 *
 * Extracts a compact, structured financial fact-pack from a fully-built
 * InvestigationCase for use by the chat answer engine.
 *
 * RULES:
 * - All monetary values stay integer paise until formatted for display.
 * - NEVER invent values. If a field is null/undefined, mark it as null.
 * - This object is the sole source of truth for chat financial answers.
 * - Credentials, secrets, and internal store internals are NEVER included.
 */

/**
 * @typedef {Object} ChatContext
 * @property {string}      case_id
 * @property {string}      exception_category
 * @property {string}      status
 * @property {string|null} payment_id
 * @property {string|null} order_id
 * @property {string|null} settlement_id
 * @property {string|null} settlement_utr
 * @property {string|null} payment_method
 * @property {number|null} gross_amount_paise
 * @property {number|null} expected_net_paise
 * @property {number|null} actual_settlement_paise
 * @property {number|null} fee_expected_paise
 * @property {number|null} fee_actual_paise
 * @property {number|null} fee_variance_paise
 * @property {number|null} tax_expected_paise
 * @property {number|null} tax_actual_paise
 * @property {number|null} tax_variance_paise
 * @property {number|null} merchant_variance_paise
 * @property {number|null} amount_at_risk_paise
 * @property {string}      reconciliation_status
 * @property {string|null} exception_description
 * @property {Object}      historical
 * @property {Array}       suggested_actions
 * @property {Object|null} ai_investigation      – saved AI report if it exists
 */

/**
 * Build the minimal chat context from an InvestigationCase + intelligence context
 * + saved AI investigation.
 *
 * @param {Object} params
 * @param {Object}      params.investigationCase
 * @param {Object}      params.lifecycle            – { status, resolution }
 * @param {Object|null} params.intelligenceContext
 * @param {Object|null} params.savedAi              – previously run AI investigation
 * @returns {ChatContext}
 */
function buildChatContext({ investigationCase, lifecycle, intelligenceContext, savedAi }) {
  const c   = investigationCase;
  const fa  = c.financial_analysis || {};
  const sr  = c.settlement_record  || null;
  const mo  = c.merchant_order     || null;
  const rr  = c.reconciliation_result || {};
  const ic  = intelligenceContext  || {};

  const similarCases    = ic.historical_context?.similar_cases     || [];
  const repeatedPats    = ic.historical_context?.repeated_patterns || [];
  const anomalies       = ic.anomaly_context?.anomalies            || [];
  const precedent       = ic.memory_context?.precedent_summary     || null;

  return {
    // ── Identity ──────────────────────────────────────────────────────────
    case_id:             c.case_id,
    exception_category:  c.exception_category,
    status:              lifecycle?.status || 'OPEN',

    // ── Payment / Order identifiers ───────────────────────────────────────
    payment_id:          sr?.payment_id    || sr?.entity_id || null,
    order_id:            mo?.id            || rr?.merchant_order_id || null,
    settlement_id:       sr?.settlement_id || null,
    settlement_utr:      sr?.settlement_utr || null,
    payment_method:      sr?.payment_method || c.exception?.payment_method || null,

    // ── Financial facts (integer paise) ───────────────────────────────────
    gross_amount_paise:        fa.gross_amount              ?? null,
    expected_net_paise:        fa.expected_merchant_amount  ?? null,
    actual_settlement_paise:   fa.settlement_credit         ?? null,
    fee_expected_paise:        fa.fee_expected              ?? null,
    fee_actual_paise:          fa.fee_actual                ?? null,
    fee_variance_paise:        fa.fee_variance              ?? null,
    tax_expected_paise:        fa.tax_expected              ?? null,
    tax_actual_paise:          fa.tax_actual                ?? null,
    tax_variance_paise:        fa.tax_variance              ?? null,
    merchant_variance_paise:   fa.merchant_variance         ?? null,
    amount_at_risk_paise:      c.amount_at_risk             ?? null,

    // ── Reconciliation status ─────────────────────────────────────────────
    reconciliation_status:  rr.status   || 'UNKNOWN',
    exception_description:  c.exception?.description || rr.reason || null,

    // ── Historical intelligence ───────────────────────────────────────────
    historical: {
      similar_cases_count:    similarCases.length,
      similar_cases:          similarCases.slice(0, 3).map(sc => ({
        case_id:   sc.case_id,
        category:  sc.exception_category || sc.category,
        variance:  sc.variance_paise || sc.amount_at_risk,
      })),
      repeated_patterns:  repeatedPats.slice(0, 3).map(p => p.pattern || p.description || p),
      anomalies:          anomalies.slice(0, 3),
      precedent_summary:  precedent,
    },

    // ── Suggested actions (deterministic) ────────────────────────────────
    suggested_actions: (c.suggested_actions || []).slice(0, 5).map(a => ({
      priority:    a.priority    || 'MEDIUM',
      description: a.description || a.action || String(a),
    })),

    // ── Previously run AI investigation (may be null) ─────────────────────
    ai_investigation: savedAi ? {
      summary:            savedAi.summary            || savedAi.what_happened || null,
      what_happened:      savedAi.what_happened      || null,
      why_it_matters:     savedAi.why_it_matters     || null,
      recommended_action: savedAi.recommended_action || null,
      provider:           savedAi.ai_analysis?.provider || 'PAYVAULT_LOCAL_INTELLIGENCE',
    } : null,
  };
}

/**
 * Format a paise value to an INR string.
 * Used inside answer templates — keeps monetary formatting in the backend.
 *
 * @param {number|null} paise
 * @returns {string}
 */
function fmtINR(paise) {
  if (paise === null || paise === undefined || isNaN(paise)) return '(not available)';
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

module.exports = { buildChatContext, fmtINR };
