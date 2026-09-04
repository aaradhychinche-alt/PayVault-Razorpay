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

    // ── Pre-formatted display values & computed variances ─────────────────
    gross_amount_formatted:        fmtINR(fa.gross_amount ?? null),
    expected_net_formatted:        fmtINR(fa.expected_merchant_amount ?? null),
    actual_settlement_formatted:   fmtINR(fa.settlement_credit ?? null),
    fee_expected_formatted:        fmtINR(fa.fee_expected ?? null),
    fee_actual_formatted:          fmtINR(fa.fee_actual ?? null),
    fee_variance_formatted:        fa.fee_variance !== null && fa.fee_variance !== undefined ? fmtINR(Math.abs(fa.fee_variance)) : null,
    fee_overcharge_paise:          (fa.fee_variance && fa.fee_variance > 0) ? fa.fee_variance : 0,
    fee_is_overcharged:            Boolean(fa.fee_variance && fa.fee_variance > 0),
    tax_expected_formatted:        fmtINR(fa.tax_expected ?? null),
    tax_actual_formatted:          fmtINR(fa.tax_actual ?? null),
    tax_variance_formatted:        fa.tax_variance !== null && fa.tax_variance !== undefined ? fmtINR(Math.abs(fa.tax_variance)) : null,
    tax_overcharge_paise:          (fa.tax_variance && fa.tax_variance > 0) ? fa.tax_variance : 0,
    tax_is_overcharged:            Boolean(fa.tax_variance && fa.tax_variance > 0),
    net_shortfall_paise:           (fa.merchant_variance && fa.merchant_variance < 0) ? Math.abs(fa.merchant_variance) : 0,
    net_shortfall_formatted:       fa.merchant_variance !== null && fa.merchant_variance !== undefined ? fmtINR(Math.abs(fa.merchant_variance)) : null,
    amount_at_risk_formatted:      fmtINR(c.amount_at_risk ?? null),

    // ── Exact Arithmetic Derivations & Algebraic Identities ────────────────
    total_excess_deductions_paise:     Math.max(0, (fa.fee_variance || 0)) + Math.max(0, (fa.tax_variance || 0)),
    total_excess_deductions_formatted: fmtINR(Math.max(0, (fa.fee_variance || 0)) + Math.max(0, (fa.tax_variance || 0))),
    fee_derivation_text:               fa.fee_expected !== null && fa.fee_actual !== null
      ? `Actual Fee (${fmtINR(fa.fee_actual)}) − Expected Fee (${fmtINR(fa.fee_expected)}) = ${fmtINR(Math.abs(fa.fee_variance || 0))} ${fa.fee_variance > 0 ? 'overcharge' : 'undercharge'}`
      : null,
    tax_derivation_text:               fa.tax_expected !== null && fa.tax_actual !== null
      ? `Actual GST (${fmtINR(fa.tax_actual)}) − Expected GST (${fmtINR(fa.tax_expected)}) = ${fmtINR(Math.abs(fa.tax_variance || 0))} ${fa.tax_variance > 0 ? 'overcharge' : 'undercharge'}`
      : null,
    settlement_derivation_text:        fa.expected_merchant_amount !== null && fa.settlement_credit !== null
      ? `Expected Net (${fmtINR(fa.expected_merchant_amount)}) − Actual Settlement (${fmtINR(fa.settlement_credit)}) = ${fmtINR(Math.abs(fa.merchant_variance || 0))} shortfall`
      : null,

    // ── Cause-and-effect relationship description ─────────────────────────
    cause_and_effect_summary:      generateCauseAndEffect({
      category: c.exception_category,
      grossPaise: fa.gross_amount,
      feeExpectedPaise: fa.fee_expected,
      feeActualPaise: fa.fee_actual,
      feeVarPaise: fa.fee_variance,
      taxExpectedPaise: fa.tax_expected,
      taxActualPaise: fa.tax_actual,
      taxVarPaise: fa.tax_variance,
      expNetPaise: fa.expected_merchant_amount,
      actNetPaise: fa.settlement_credit,
      merchVarPaise: fa.merchant_variance,
      riskPaise: c.amount_at_risk,
    }),

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
 * Generate clear deterministic cause-and-effect relationship text.
 */
function generateCauseAndEffect({
  category, grossPaise, feeExpectedPaise, feeActualPaise, feeVarPaise,
  taxExpectedPaise, taxActualPaise, taxVarPaise, expNetPaise, actNetPaise,
  merchVarPaise, riskPaise
}) {
  if (category === 'FEE_TAX_VARIANCE' && feeVarPaise && taxVarPaise) {
    const feeOver = fmtINR(Math.abs(feeVarPaise));
    const taxOver = fmtINR(Math.abs(taxVarPaise));
    const totalShort = fmtINR(Math.abs(merchVarPaise || riskPaise || (feeVarPaise + taxVarPaise)));
    const expNet = fmtINR(expNetPaise);
    const actNet = fmtINR(actNetPaise);
    return `Net settlement is calculated as Gross Amount minus Fee minus GST. The gateway overcharged the fee by ${feeOver} and overcharged GST by ${taxOver}, which sum to ${totalShort} in excess deductions. This directly causes the settlement credit to be short by ${totalShort} (${actNet} received vs ${expNet} expected).`;
  }
  if (category === 'TIMING_MISMATCH') {
    return `The payment capture and its corresponding refund/credit occurred in different settlement batch cycles, resulting in a temporary cross-period discrepancy between the ledger and the gateway settlement batch.`;
  }
  if (category === 'MISSING_ORDER') {
    return `A settlement credit was received into the bank nodal account from the gateway, but no merchant order record could be matched to the transaction entity.`;
  }
  if (category === 'MISSING_PAYMENT') {
    return `A merchant order was authorized and expected in the ledger, but no matching settlement payout record has been received from the payment gateway.`;
  }
  if (category === 'DUPLICATE') {
    return `Multiple settlement credits with identical amounts were posted for the same order reference, leading to duplicate credit exposure that requires reversal.`;
  }
  return `Reconciliation discrepancy of ${fmtINR(riskPaise || merchVarPaise)} detected between the gateway settlement record and the merchant ledger.`;
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

module.exports = { buildChatContext, fmtINR, generateCauseAndEffect };

