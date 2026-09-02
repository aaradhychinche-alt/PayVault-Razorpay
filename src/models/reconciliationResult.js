'use strict';
/**
 * src/models/reconciliationResult.js
 *
 * The output of the deterministic reconciliation engine.
 * Links all source records and records why the engine classified them.
 *
 * NOTE: The engine classification is deterministic — no AI involved here.
 */

const RECON_STATUS = Object.freeze({
  MATCHED:           'MATCHED',
  PARTIALLY_MATCHED: 'PARTIALLY_MATCHED',
  EXCEPTION:         'EXCEPTION',
});

/**
 * @param {Object} fields
 * @returns {ReconciliationResult}
 */
function createReconciliationResult(fields) {
  const {
    id,
    // Source record IDs — for full traceability
    settlement_entity_id,      // SettlementRecord.entity_id
    merchant_order_id = null,  // MerchantOrder.id
    merchant_ledger_id = null, // MerchantLedgerEntry.id
    payment_entity_id = null,  // SettlementRecord.entity_id of the payment row
    refund_entity_ids = [],    // array of SettlementRecord.entity_ids for refunds

    // Engine output
    status,                    // RECON_STATUS value
    exception_category = null, // e.g. 'MISSING_ORDER', 'FEE_TAX_VARIANCE'
    reason,                    // Human-readable explanation (deterministic)
    amount_razorpay = null,    // paise — net amount per Razorpay
    amount_merchant = null,    // paise — expected amount per merchant
    amount_variance = null,    // paise — difference (can be negative)
    fee_expected = null,       // paise
    fee_actual = null,         // paise
    tax_expected = null,       // paise
    tax_actual = null,         // paise
    created_at,                // Unix timestamp when this result was computed
  } = fields;

  if (!id)      throw new Error('ReconciliationResult: id is required');
  if (!status)  throw new Error('ReconciliationResult: status is required');
  if (!reason)  throw new Error('ReconciliationResult: reason is required');
  if (!created_at) throw new Error('ReconciliationResult: created_at is required');
  if (!settlement_entity_id) throw new Error('ReconciliationResult: settlement_entity_id is required');

  if (!Object.values(RECON_STATUS).includes(status)) {
    throw new Error(`ReconciliationResult: invalid status '${status}'`);
  }

  // Monetary values must be integers if provided
  for (const [name, val] of Object.entries({
    amount_razorpay, amount_merchant, amount_variance,
    fee_expected, fee_actual, tax_expected, tax_actual,
  })) {
    if (val !== null && !Number.isInteger(val)) {
      throw new Error(`ReconciliationResult: '${name}' must be integer paise or null. Got: ${val}`);
    }
  }

  return Object.freeze({
    id,
    settlement_entity_id,
    merchant_order_id,
    merchant_ledger_id,
    payment_entity_id,
    refund_entity_ids: [...refund_entity_ids],
    status,
    exception_category,
    reason,
    amount_razorpay,
    amount_merchant,
    amount_variance,
    fee_expected,
    fee_actual,
    tax_expected,
    tax_actual,
    created_at,
  });
}

module.exports = { createReconciliationResult, RECON_STATUS };
