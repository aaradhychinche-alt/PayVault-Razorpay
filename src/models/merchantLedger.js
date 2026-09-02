'use strict';
/**
 * src/models/merchantLedger.js
 *
 * Merchant accounting / ledger data.
 * Represents entries in the merchant's own books — NOT Razorpay data.
 *
 * All monetary values in INTEGER PAISE.
 */

/**
 * @typedef {Object} MerchantLedgerEntry
 */

let _seq = 0;

/**
 * @param {Object} fields
 * @returns {MerchantLedgerEntry}
 */
function createMerchantLedger(fields) {
  const {
    id,                          // e.g. 'ledger_000001'
    merchant_order_id,           // FK → MerchantOrder.id
    expected_amount,             // paise — what merchant expected to receive
    posted_amount = null,        // paise — what was actually posted to books (null if not yet)
    status,                      // 'pending' | 'posted' | 'discrepancy'
    posted_at = null,            // Unix timestamp or null
    reference = null,            // e.g. UTR, payment_id, or internal ref
    description = null,
  } = fields;

  if (!id)               throw new Error('MerchantLedger: id is required');
  if (!merchant_order_id) throw new Error('MerchantLedger: merchant_order_id is required');
  if (expected_amount == null) throw new Error('MerchantLedger: expected_amount is required');
  if (!status)           throw new Error('MerchantLedger: status is required');

  if (!Number.isInteger(expected_amount)) {
    throw new Error(`MerchantLedger: 'expected_amount' must be integer paise. Got: ${expected_amount}`);
  }
  if (posted_amount !== null && !Number.isInteger(posted_amount)) {
    throw new Error(`MerchantLedger: 'posted_amount' must be integer paise or null. Got: ${posted_amount}`);
  }

  return Object.freeze({
    id,
    merchant_order_id,
    expected_amount,
    posted_amount,
    status,
    posted_at,
    reference,
    description,
  });
}

module.exports = { createMerchantLedger };
