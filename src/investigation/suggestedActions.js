'use strict';
/**
 * src/investigation/suggestedActions.js
 *
 * Deterministic suggested-action generator.
 *
 * Maps exception category and financial facts to a structured list of
 * concrete resolution steps. These are NOT AI-generated — they are
 * rule-based, deterministic, and reproducible.
 *
 * The AI investigator can optionally enrich these with narrative; the
 * underlying list is always deterministic.
 */

/**
 * @typedef {Object} SuggestedAction
 * @property {string}   action_type     - e.g. 'RECONCILE_MANUALLY'
 * @property {number}   priority        - 1 = highest
 * @property {string}   description     - Short, imperative description of the action
 * @property {string[]} involved_entities - IDs of the entities this action involves
 * @property {string}   resolution_hint  - Specific instruction for the operations team
 * @property {string}   expected_outcome - What should be true after this action
 */

const ACTIONS_BY_CATEGORY = {
  FEE_TAX_VARIANCE: (analysis, reconResult) => [{
    action_type: 'RAISE_FEE_DISPUTE',
    priority: 2,
    description: 'Raise a fee variance dispute with Razorpay.',
    involved_entities: [
      reconResult.settlement_entity_id,
      reconResult.merchant_order_id,
    ].filter(Boolean),
    resolution_hint: `Fee variance of ${analysis.fee_variance !== null ? analysis.fee_variance : '?'} paise detected. ` +
      `Expected fee: ${analysis.fee_expected} paise. Actual fee: ${analysis.fee_actual} paise. ` +
      `Log a ticket to Razorpay Fee Disputes team with settlement entity ID ${reconResult.settlement_entity_id}.`,
    expected_outcome: 'Razorpay confirms the correct fee rate and issues a credit adjustment if overcharged.',
  }],

  MISSING_ORDER: (analysis, reconResult) => [{
    action_type: 'INVESTIGATE_UNKNOWN_PAYMENT',
    priority: 1,
    description: 'Identify the origin of a payment received without a corresponding merchant order.',
    involved_entities: [reconResult.settlement_entity_id].filter(Boolean),
    resolution_hint: `Settlement record ${reconResult.settlement_entity_id} has no matching merchant order_id (${reconResult.merchant_order_id || 'none'}). ` +
      `Search for the order in the merchant payment system using amount=${analysis.gross_amount} paise and settlement date. ` +
      `Check whether the order was created in a different environment or by another integration.`,
    expected_outcome: 'Either match the payment to a known order, or initiate a refund if the payment cannot be claimed.',
  }],

  MISSING_PAYMENT: (analysis, reconResult) => [{
    action_type: 'INVESTIGATE_MISSING_SETTLEMENT',
    priority: 1,
    description: 'Investigate why a payment marked as collected has not appeared in settlement.',
    involved_entities: [reconResult.merchant_order_id, reconResult.merchant_ledger_id].filter(Boolean),
    resolution_hint: `Merchant order ${reconResult.merchant_order_id} is marked as paid in the ledger but no settlement record has arrived. ` +
      `Verify the Razorpay payment status via the Razorpay dashboard or API. Check if payment was actually captured. ` +
      `Contact Razorpay settlement support with order ID if payment was captured.`,
    expected_outcome: 'Settlement record appears in next cycle, or the merchant ledger entry is corrected to reflect refund/failure.',
  }],

  DUPLICATE: (analysis, reconResult) => [
    {
      action_type: 'HOLD_DISBURSEMENT',
      priority: 1,
      description: 'Freeze disbursement for this transaction pending duplicate review.',
      involved_entities: [reconResult.settlement_entity_id].filter(Boolean),
      resolution_hint: `Payment ${reconResult.settlement_entity_id} appears to be a duplicate settlement for order ${reconResult.merchant_order_id || 'N/A'}. ` +
        `Do not disburse until confirmed non-duplicate. Compare payment IDs, amounts, and timestamps with sibling records.`,
      expected_outcome: 'Duplicate is confirmed or ruled out. Refund initiated if duplicate; transaction released if false positive.',
    },
    {
      action_type: 'CONTACT_RAZORPAY',
      priority: 2,
      description: 'Raise a duplicate settlement query with Razorpay.',
      involved_entities: [reconResult.settlement_entity_id].filter(Boolean),
      resolution_hint: `Submit a support ticket to Razorpay with the payment entity ID ${reconResult.settlement_entity_id}, order ID ${reconResult.merchant_order_id || 'N/A'}, and settlement batch ID.`,
      expected_outcome: 'Razorpay confirms whether two settlement records exist for the same payment capture and reverses the duplicate.',
    },
  ],

  TIMING_MISMATCH: (analysis, reconResult) => [{
    action_type: 'MONITOR_REFUND_BATCH',
    priority: 3,
    description: 'Monitor the refund settlement batch to confirm the debit lands in the correct period.',
    involved_entities: [
      reconResult.settlement_entity_id,
      ...(reconResult.refund_entity_ids || []),
    ],
    resolution_hint: `Refund(s) ${(reconResult.refund_entity_ids || []).join(', ')} settled in a different batch than the originating payment. ` +
      `Verify that the total debit appears in the next reconciliation period. Update ledger posting rules to handle cross-period refunds.`,
    expected_outcome: 'Refund debit reconciles in the following settlement cycle; ledger is net-zero for the payment.',
  }],

  ADJUSTMENT: (analysis, reconResult) => [{
    action_type: 'REVIEW_ADJUSTMENT',
    priority: 2,
    description: 'Review the Razorpay platform adjustment credit/debit and apply to ledger.',
    involved_entities: [reconResult.settlement_entity_id].filter(Boolean),
    resolution_hint: `Settlement record ${reconResult.settlement_entity_id} is a Razorpay-issued adjustment (type='adjustment'). ` +
      `Obtain the adjustment reason from the Razorpay dashboard. Post to the appropriate ledger account (e.g., platform-fees-adjustment).`,
    expected_outcome: 'Adjustment posted to ledger; reconciliation row marked MATCHED after ledger update.',
  }],

  UNEXPLAINED: (analysis, reconResult) => [
    {
      action_type: 'ESCALATE',
      priority: 1,
      description: 'Escalate to the finance team for manual investigation.',
      involved_entities: [reconResult.settlement_entity_id].filter(Boolean),
      resolution_hint: `Settlement record ${reconResult.settlement_entity_id} could not be reconciled by any deterministic rule. ` +
        `Amount at risk: ${analysis.amount_at_risk !== null ? analysis.amount_at_risk : analysis.gross_amount} paise. ` +
        `Gather the raw Razorpay settlement report for this batch and compare line-by-line.`,
      expected_outcome: 'Root cause identified, manual ledger adjustment applied or refund initiated.',
    },
    {
      action_type: 'REQUEST_BATCH_REPORT',
      priority: 2,
      description: 'Request the full settlement batch report from Razorpay for the settlement period.',
      involved_entities: [reconResult.settlement_entity_id].filter(Boolean),
      resolution_hint: `Download the settlement batch report from the Razorpay dashboard for the batch containing ${reconResult.settlement_entity_id}.`,
      expected_outcome: 'Batch report provides the additional context needed to classify and resolve this exception.',
    },
  ],

  REFUND_MISMATCH: (analysis, reconResult) => [{
    action_type: 'RECONCILE_REFUND',
    priority: 2,
    description: 'Reconcile the refund amount against the original payment and merchant refund record.',
    involved_entities: [
      reconResult.settlement_entity_id,
      ...(reconResult.refund_entity_ids || []),
      reconResult.merchant_order_id,
    ].filter(Boolean),
    resolution_hint: `Refund amount does not match the merchant-side expected refund. ` +
      `Verify whether a partial refund was intentional. Cross-check with customer service records.`,
    expected_outcome: 'Refund amount confirmed correct; ledger updated to reflect partial or full refund.',
  }],

  PARTIALLY_MATCHED: (analysis, reconResult) => [{
    action_type: 'MANUALLY_REVIEW',
    priority: 3,
    description: 'Manually review the partial match — minor variance within tolerance.',
    involved_entities: [reconResult.settlement_entity_id, reconResult.merchant_order_id].filter(Boolean),
    resolution_hint: `Amount variance: ${analysis.merchant_variance} paise. ` +
      `If within the agreed rounding tolerance (≤2 paise), mark as resolved. Otherwise investigate further.`,
    expected_outcome: 'Variance documented and ledger updated if necessary; exception closed.',
  }],

  MATCHED: () => [],  // No action needed
};

/**
 * Get deterministic suggested actions for a given exception.
 *
 * @param {Object} params
 * @param {Object} params.exception
 * @param {Object} params.reconResult
 * @param {Object} params.financialAnalysis
 * @returns {SuggestedAction[]}
 */
function getSuggestedActions({ exception, reconResult, financialAnalysis }) {
  const category  = exception.category;
  const actionsFn = ACTIONS_BY_CATEGORY[category] || ACTIONS_BY_CATEGORY.UNEXPLAINED;

  const analysis = {
    ...financialAnalysis,
    amount_at_risk: exception.amount_at_risk,
  };

  const actions = actionsFn(analysis, reconResult);

  // Always append a generic documentation step (lowest priority)
  actions.push({
    action_type:      'DOCUMENT_FINDING',
    priority:         99,
    description:      'Document the investigation finding and resolution in the audit trail.',
    involved_entities: [exception.id, reconResult.id].filter(Boolean),
    resolution_hint:  `Record the root cause, resolution taken, and any outstanding items for exception ${exception.id}.`,
    expected_outcome: 'Exception closed with full audit trail for compliance review.',
  });

  return actions.sort((a, b) => a.priority - b.priority);
}

module.exports = { getSuggestedActions };
