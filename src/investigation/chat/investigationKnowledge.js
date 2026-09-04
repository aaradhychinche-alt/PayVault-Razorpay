'use strict';
/**
 * src/investigation/chat/investigationKnowledge.js
 *
 * Payvault AI — Investigation Knowledge Layer.
 *
 * ARCHITECTURE PRINCIPLE:
 * This module provides STRUCTURED INVESTIGATION KNOWLEDGE that the Payvault AI
 * reasoning layer can query. It is NOT a keyword -> canned-answer map.
 *
 * The knowledge is organized into:
 *   1. Exception type knowledge
 *   2. Financial relationship rules
 *   3. Evidence interpretation guide
 *   4. Investigation procedure knowledge
 *   5. Escalation conditions
 *   6. Resolution guidance
 *
 * Knowledge is returned as structured facts/rules assembled by the reasoning layer.
 */

// ── 1. Exception Type Knowledge ───────────────────────────────────────────────

const EXCEPTION_KNOWLEDGE = {
  FEE_TAX_VARIANCE: {
    display_name: 'Fee / Tax Variance',
    plain_description: 'The payment gateway deducted more in fees and/or taxes than the contracted schedule allows.',
    financial_relationships: [
      'Net Settlement = Gross Amount - Gateway Fee - GST on Fee',
      'Fee Variance = Actual Fee - Expected Fee (contracted rate)',
      'GST Variance = Actual GST - Expected GST (18% of contracted fee)',
      'Settlement Shortfall = Fee Variance + GST Variance',
    ],
    key_checks: [
      'Verify contracted fee rate (typically 2%) against gateway fee schedule',
      'Verify GST is 18% of the contracted fee, not the actual fee',
      'Confirm settlement shortfall equals fee variance + GST variance',
      'Check if fee rate change was announced/approved',
    ],
    evidence_sources: ['settlement_record', 'reconciliation_result', 'financial_analysis', 'suggested_actions'],
    typical_cause: 'Fee rate configuration discrepancy in the payment gateway profile',
    real_financial_loss: true,
    requires_gateway_action: true,
    escalation_threshold_paise: 50000,
    typical_resolution: 'Raise a fee dispute with the gateway; obtain credit adjustment for the overcharged amount',
  },

  TIMING_MISMATCH: {
    display_name: 'Timing Mismatch',
    plain_description: 'A payment and its refund appeared in different settlement batch cycles, creating a temporary cross-period imbalance.',
    financial_relationships: [
      'Payment settled in batch T; refund settled in batch T+1 or later',
      'Net position across batches is zero — funds are not actually missing',
    ],
    key_checks: [
      'Confirm the refund batch reference and settlement date',
      'Verify funds balance out across both batch periods',
      'Check if this is a known cross-period pattern',
    ],
    evidence_sources: ['settlement_record', 'historical_context'],
    typical_cause: 'Cross-batch refund processing where capture and refund fall in different settlement cycles',
    real_financial_loss: false,
    requires_gateway_action: false,
    escalation_threshold_paise: null,
    typical_resolution: 'Monitor the next settlement cycle to confirm the refund debit appears; then close',
  },

  MISSING_ORDER: {
    display_name: 'Missing Order',
    plain_description: 'A payment credit was received from the gateway, but no matching merchant order exists in the system.',
    financial_relationships: [
      'Gateway credit received: net settlement amount',
      'No merchant order can be matched by payment ID, order ID, or amount',
    ],
    key_checks: [
      'Search merchant system for the payment by amount and settlement date',
      'Check if order was created in a different environment (test vs. live)',
      'Verify webhook delivery — order may have been created but not received',
      'Consider whether a refund should be initiated if order cannot be claimed',
    ],
    evidence_sources: ['settlement_record', 'exception_record'],
    typical_cause: 'Orphaned gateway payment — webhook failure or order creation in wrong environment',
    real_financial_loss: true,
    requires_gateway_action: false,
    escalation_threshold_paise: 10000,
    typical_resolution: 'Match to a known order if possible; initiate refund if the payment cannot be claimed',
  },

  MISSING_PAYMENT: {
    display_name: 'Missing Payment',
    plain_description: 'A merchant order was recorded as paid, but no settlement credit has been received from the gateway.',
    financial_relationships: [
      'Expected settlement: order amount minus gateway fee and GST',
      'Actual settlement: zero (no credit received)',
    ],
    key_checks: [
      'Verify payment status via gateway dashboard or API',
      'Check if payment was actually captured (not just authorized)',
      'Verify the settlement window has passed (typically 3 business days)',
      'Check for silent refunds or chargebacks',
    ],
    evidence_sources: ['merchant_order', 'merchant_ledger'],
    typical_cause: 'Settlement batch omission or payment capture failure',
    real_financial_loss: true,
    requires_gateway_action: true,
    escalation_threshold_paise: 10000,
    typical_resolution: 'Verify with gateway; contact settlement support with order ID if payment was captured',
  },

  DUPLICATE: {
    display_name: 'Duplicate Settlement',
    plain_description: 'Multiple settlement credits with identical amounts were posted for the same order, creating duplicate payout exposure.',
    financial_relationships: [
      'Two or more credits posted for the same order reference',
      'Net exposure equals the duplicate credit amount',
    ],
    key_checks: [
      'Do NOT disburse the duplicate amount until confirmed non-duplicate',
      'Compare payment IDs, amounts, and timestamps across all credits',
      'Check for double authorization (customer may have submitted checkout twice)',
      'Raise with gateway immediately to prevent double settlement',
    ],
    evidence_sources: ['settlement_record', 'exception_record'],
    typical_cause: 'Redundant gateway settlement record or customer double-authorization',
    real_financial_loss: true,
    requires_gateway_action: true,
    escalation_threshold_paise: 0,
    typical_resolution: 'Hold disbursement; raise with gateway; initiate refund for confirmed duplicate',
    always_escalate: true,
  },

  UNEXPLAINED: {
    display_name: 'Unexplained Shortfall',
    plain_description: 'A settlement discrepancy exists that cannot be explained by known fee, tax, refund, or timing rules.',
    financial_relationships: [
      'Variance cannot be attributed to contracted fee rate, GST, or refund timing',
      'Raw settlement log comparison required',
    ],
    key_checks: [
      'Download the full settlement batch report from the gateway',
      'Compare line-by-line against merchant ledger',
      'Escalate to finance team for manual audit',
    ],
    evidence_sources: ['settlement_record', 'exception_record'],
    typical_cause: 'Unclassified discrepancy — may require raw gateway settlement log to diagnose',
    real_financial_loss: true,
    requires_gateway_action: true,
    escalation_threshold_paise: 0,
    typical_resolution: 'Manual audit; identify root cause before resolving',
    always_escalate: true,
  },

  ADJUSTMENT: {
    display_name: 'Settlement Adjustment',
    plain_description: 'The gateway applied a direct platform adjustment (credit or debit) without a corresponding merchant checkout order.',
    financial_relationships: [
      'Adjustment amount represents a direct gateway-initiated credit or debit',
      'No merchant order counterpart exists',
    ],
    key_checks: [
      'Identify the adjustment reason from the gateway dashboard',
      'Post to the correct ledger account',
      'Confirm whether this is a fee correction, dispute resolution, or penalty',
    ],
    evidence_sources: ['settlement_record'],
    typical_cause: 'Gateway-initiated platform adjustment',
    real_financial_loss: false,
    requires_gateway_action: false,
    escalation_threshold_paise: 50000,
    typical_resolution: 'Obtain adjustment reason; post to correct ledger account; mark resolved',
  },
};

// ── 2. Financial Relationship Rules ──────────────────────────────────────────

const FINANCIAL_RULES = {
  fee_calculation: {
    description: 'Platform fee is calculated as a percentage of the gross customer amount',
    formula: 'Expected Fee = Gross Amount x Contracted Fee Rate (e.g., 2.0%)',
  },
  gst_calculation: {
    description: 'GST is calculated on the contracted fee, NOT the actual fee charged',
    formula: 'Expected GST = Expected Fee x GST Rate (18.0%)',
    critical_rule: 'GST variance = Actual GST - Expected GST (not Actual GST - Fee Variance)',
  },
  settlement_formula: {
    description: 'Net settlement is gross amount minus all gateway deductions',
    formula: 'Net Settlement = Gross Amount - Gateway Fee - GST on Fee',
  },
  shortfall_decomposition: {
    description: 'Settlement shortfall decomposes exactly into fee variance and GST variance',
    formula: 'Settlement Shortfall = Fee Variance + GST Variance',
    verification: 'Expected Net - Actual Net must equal Fee Variance + GST Variance',
  },
  variance_sign_convention: {
    description: 'Positive variance means the gateway charged more than expected (overcharge)',
    formula: 'Variance = Actual - Expected (positive = overcharge)',
  },
};

// ── 3. Evidence Interpretation Guide ─────────────────────────────────────────

const EVIDENCE_INTERPRETATION = {
  settlement_record: {
    what_it_tells: 'The actual amounts the gateway settled: gross, fee, GST, and net credit',
    reliability: 'HIGH — gateway\'s authoritative record of what was deducted and credited',
  },
  reconciliation_result: {
    what_it_tells: 'Payvault\'s deterministic comparison of settlement vs expected amounts',
    reliability: 'HIGH — deterministic calculation from case data',
  },
  financial_analysis: {
    what_it_tells: 'Computed breakdown: gross, expected vs actual fee/GST/settlement',
    reliability: 'HIGH — deterministic arithmetic',
  },
  exception_record: {
    what_it_tells: 'The flagged discrepancy: category, amount at risk, and description',
    reliability: 'HIGH — deterministically generated by the reconciliation engine',
  },
  suggested_actions: {
    what_it_tells: 'Deterministic recommended next steps based on exception category',
    reliability: 'HIGH — rule-based deterministic recommendations',
  },
  historical_context: {
    what_it_tells: 'Similar cases from session history: patterns, precedents',
    reliability: 'MEDIUM — depends on session history volume',
  },
};

// ── 4. Investigation Procedure Knowledge ─────────────────────────────────────

const INVESTIGATION_PROCEDURES = {
  FEE_TAX_VARIANCE: {
    steps: [
      'Verify the exact fee rate applied against the merchant contract schedule',
      'Calculate expected fee (contracted rate x gross amount) and compare to actual',
      'Calculate expected GST (18% of expected fee) and compare to actual GST charged',
      'Confirm settlement shortfall = fee variance + GST variance',
      'Gather evidence: settlement record, merchant contract, gateway fee schedule',
      'Raise a fee dispute with the gateway citing the specific variance amounts',
      'Request a fee correction credit equal to the settlement shortfall',
      'Document findings in the audit trail before resolving',
    ],
    can_resolve_independently: false,
    requires_external_action: 'Fee dispute with gateway required before resolution',
  },
  TIMING_MISMATCH: {
    steps: [
      'Identify the settlement batch IDs for both the payment and the refund',
      'Verify that the refund appears in the next batch (cross-period)',
      'Confirm the net position across both batches is zero',
      'Monitor the next reconciliation cycle for the refund debit',
      'Document the cross-period nature of the transaction',
    ],
    can_resolve_independently: true,
    requires_external_action: 'None — monitor only',
  },
  MISSING_ORDER: {
    steps: [
      'Search the merchant system for the payment by amount and settlement date',
      'Check webhook delivery logs for the payment ID',
      'Verify the environment (test vs. live) the payment was processed in',
      'If order found: link order to settlement record and resolve',
      'If order not found: initiate refund with gateway if payment cannot be claimed',
    ],
    can_resolve_independently: false,
    requires_external_action: 'May need to initiate refund via gateway',
  },
  MISSING_PAYMENT: {
    steps: [
      'Verify payment capture status via gateway dashboard or API',
      'Confirm payment was captured and not just authorized',
      'Check if the settlement window has elapsed (typically 3 business days)',
      'If captured: contact gateway settlement support with order ID',
      'If not captured: update merchant ledger to reflect payment failure',
    ],
    can_resolve_independently: false,
    requires_external_action: 'May need to contact gateway settlement support',
  },
  DUPLICATE: {
    steps: [
      'IMMEDIATELY: Hold disbursement — do not release duplicate amount',
      'Compare all payment records for the same order ID and amount',
      'Check timestamps for multiple authorization attempts',
      'Raise a duplicate settlement query with the gateway',
      'Initiate refund for the confirmed duplicate amount',
    ],
    can_resolve_independently: false,
    requires_external_action: 'URGENT: Must raise with gateway immediately; hold disbursement',
  },
  UNEXPLAINED: {
    steps: [
      'Download full settlement batch report from the gateway',
      'Compare line-by-line against the merchant ledger',
      'Check for any gateway adjustments or corrections',
      'Escalate to finance team for manual audit',
      'Document all findings before resolving',
    ],
    can_resolve_independently: false,
    requires_external_action: 'Escalation to finance team required',
  },
  ADJUSTMENT: {
    steps: [
      'Obtain the adjustment reason from the gateway dashboard',
      'Confirm whether this is a fee correction, dispute fee, or processing adjustment',
      'Post the adjustment to the appropriate ledger account',
      'Document the posting reference and close the exception',
    ],
    can_resolve_independently: true,
    requires_external_action: 'May need gateway dashboard access to retrieve adjustment details',
  },
};

// ── 5. Escalation Conditions ──────────────────────────────────────────────────

const ESCALATION_RULES = {
  always_escalate: ['DUPLICATE', 'UNEXPLAINED'],
  escalate_if_high_amount: {
    threshold_paise: 50000,
    categories: ['FEE_TAX_VARIANCE', 'MISSING_PAYMENT', 'MISSING_ORDER'],
    reason: 'High monetary exposure requires senior review',
  },
  escalate_if_repeated: {
    min_similar_cases: 3,
    reason: 'Recurring pattern indicates systemic issue requiring process-level investigation',
  },
  do_not_escalate: ['TIMING_MISMATCH', 'ADJUSTMENT'],
  escalation_recipient: 'Finance team / settlement operations',
};

// ── 6. Resolution Guidance ────────────────────────────────────────────────────

const RESOLUTION_GUIDANCE = {
  when_to_resolve: {
    FEE_TAX_VARIANCE: 'After gateway confirms fee correction credit has been issued',
    TIMING_MISMATCH: 'After confirming refund debit appears in next reconciliation cycle',
    MISSING_ORDER: 'After matching payment to an order OR confirming refund has been initiated',
    MISSING_PAYMENT: 'After settlement is received OR gateway confirms payment was not captured',
    DUPLICATE: 'After gateway reverses the duplicate AND refund is confirmed',
    ADJUSTMENT: 'After adjustment reason is documented and ledger posting is complete',
    UNEXPLAINED: 'After finance team audit completes and root cause is documented',
  },
  operator_action_required: true,
  chat_cannot_resolve: true,
  resolution_note: 'Case status changes must be performed by the operator using the workstation UI buttons',
};

// ── Query functions ───────────────────────────────────────────────────────────

function getExceptionKnowledge(category) {
  return EXCEPTION_KNOWLEDGE[category] || EXCEPTION_KNOWLEDGE.UNEXPLAINED;
}

function getFinancialRules() {
  return FINANCIAL_RULES;
}

function getEvidenceInterpretation(source) {
  return EVIDENCE_INTERPRETATION[source] || null;
}

function getInvestigationProcedure(category) {
  return INVESTIGATION_PROCEDURES[category] || INVESTIGATION_PROCEDURES.UNEXPLAINED;
}

/**
 * Evaluate whether this case should be escalated.
 * @param {string} category
 * @param {number} amountAtRiskPaise
 * @param {Object} historicalCtx
 * @returns {{ should_escalate: boolean, urgency: string, reason: string }}
 */
function evaluateEscalation(category, amountAtRiskPaise, historicalCtx) {
  historicalCtx = historicalCtx || {};
  const excKnowledge = getExceptionKnowledge(category);

  if (excKnowledge.always_escalate) {
    return {
      should_escalate: true,
      urgency: 'IMMEDIATE',
      reason: excKnowledge.display_name + ' cases always require immediate escalation — ' + (
        category === 'DUPLICATE'
          ? 'hold disbursement and raise with gateway'
          : 'requires finance team manual audit'
      ),
    };
  }

  if (ESCALATION_RULES.always_escalate.indexOf(category) !== -1) {
    return {
      should_escalate: true,
      urgency: 'HIGH',
      reason: category + ' exceptions require escalation by policy',
    };
  }

  if (
    amountAtRiskPaise !== null &&
    amountAtRiskPaise >= ESCALATION_RULES.escalate_if_high_amount.threshold_paise &&
    ESCALATION_RULES.escalate_if_high_amount.categories.indexOf(category) !== -1
  ) {
    const amt = '\u20B9' + (amountAtRiskPaise / 100).toFixed(2);
    return {
      should_escalate: true,
      urgency: 'HIGH',
      reason: 'Amount at risk (' + amt + ') exceeds the escalation threshold — ' +
        ESCALATION_RULES.escalate_if_high_amount.reason,
    };
  }

  const similarCount = historicalCtx.similar_cases_count || 0;
  if (similarCount >= ESCALATION_RULES.escalate_if_repeated.min_similar_cases) {
    return {
      should_escalate: true,
      urgency: 'MEDIUM',
      reason: similarCount + ' similar cases detected — ' + ESCALATION_RULES.escalate_if_repeated.reason,
    };
  }

  return {
    should_escalate: false,
    urgency: 'NONE',
    reason: 'This ' + excKnowledge.display_name + ' case can be investigated and resolved independently',
  };
}

/**
 * Determine whether this case represents a real financial loss.
 * @param {string} category
 * @param {number} amountAtRiskPaise
 * @returns {{ is_real_loss: boolean, explanation: string }}
 */
function assessFinancialLoss(category, amountAtRiskPaise) {
  const excKnowledge = getExceptionKnowledge(category);
  const amt = '\u20B9' + (amountAtRiskPaise / 100).toFixed(2);

  if (category === 'TIMING_MISMATCH') {
    return {
      is_real_loss: false,
      explanation: 'No — this is a timing difference, not a financial loss. The ' + amt +
        ' reconciles across settlement cycles; no funds are missing overall.',
    };
  }

  if (category === 'ADJUSTMENT') {
    return {
      is_real_loss: false,
      explanation: 'Not necessarily — this is a gateway-initiated adjustment. The ' + amt +
        ' represents a platform adjustment credit or debit that needs to be posted to the correct ledger account.',
    };
  }

  return {
    is_real_loss: excKnowledge.real_financial_loss,
    explanation: excKnowledge.real_financial_loss
      ? 'Yes — the ' + amt + ' represents a real financial exposure. ' + excKnowledge.typical_resolution
      : 'No — while this case shows a discrepancy of ' + amt + ', it does not represent an unrecoverable loss.',
  };
}

/**
 * Get all available evidence sources for a category.
 * @param {string} category
 * @returns {Object[]}
 */
function getEvidenceSources(category) {
  const excKnowledge = getExceptionKnowledge(category);
  const sources = excKnowledge.evidence_sources || [];
  return sources.map(function(s) {
    return Object.assign(
      { source: s },
      EVIDENCE_INTERPRETATION[s] || { what_it_tells: s + ' records', reliability: 'MEDIUM' }
    );
  });
}

module.exports = {
  EXCEPTION_KNOWLEDGE,
  FINANCIAL_RULES,
  EVIDENCE_INTERPRETATION,
  INVESTIGATION_PROCEDURES,
  ESCALATION_RULES,
  RESOLUTION_GUIDANCE,
  getExceptionKnowledge,
  getFinancialRules,
  getEvidenceInterpretation,
  getInvestigationProcedure,
  evaluateEscalation,
  assessFinancialLoss,
  getEvidenceSources,
};
