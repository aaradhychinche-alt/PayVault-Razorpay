'use strict';
/**
 * src/models/settlementRecord.js
 *
 * Canonical internal model matching the Razorpay
 * GET /v1/settlements/recon/combined response schema.
 *
 * All monetary values are in INTEGER PAISE (never float).
 * Nullable fields default to null, not undefined.
 *
 * NOTE: These records are SYNTHETIC — Razorpay Test Mode does not run the
 * financial settlement pipeline, so no real recon data is available.
 */

/**
 * @typedef {Object} SettlementRecord
 *
 * Razorpay-side data layer.
 * Represents one line item in a settlement reconciliation report.
 */

/**
 * Create a validated SettlementRecord object.
 * Throws if required fields are missing or monetary values are non-integer.
 *
 * @param {Object} fields
 * @returns {SettlementRecord}
 */
function createSettlementRecord(fields) {
  const {
    entity_id,
    type,               // 'payment' | 'refund' | 'transfer' | 'adjustment'
    debit      = 0,     // paise — amount flowing OUT of merchant account
    credit     = 0,     // paise — amount flowing INTO merchant account
    amount,             // paise — gross transaction amount
    currency   = 'INR',
    fee        = 0,     // paise — Razorpay platform fee
    tax        = 0,     // paise — GST on fee
    on_hold    = false,
    settled    = false,
    created_at,         // Unix timestamp (seconds)
    settled_at = null,  // Unix timestamp (seconds) or null
    settlement_id = null,
    settlement_utr = null,
    posted_at  = null,
    credit_type = 'default',
    description = null,
    notes      = null,
    payment_id = null,  // parent payment (on refund/transfer rows)
    order_id   = null,
    order_receipt = null,
    method     = null,  // 'card' | 'upi' | 'netbanking' | 'wallet' | null
    card_network = null,
    card_issuer  = null,
    card_type    = null,
    dispute_id   = null,
    // Internal-only fields (never sent to AI layer)
    _batch_index = null,  // which settlement batch this belongs to
    _scenario    = null,  // the deliberate test scenario, e.g. 'CLEAN_MATCH'
    _source      = 'simulated_settlement',
  } = fields;

  // Required field validation
  if (!entity_id) throw new Error('SettlementRecord: entity_id is required');
  if (!type)      throw new Error('SettlementRecord: type is required');
  if (amount == null) throw new Error('SettlementRecord: amount is required');
  if (!created_at)    throw new Error('SettlementRecord: created_at is required');

  // Money safety — all monetary values must be integers
  for (const [name, val] of Object.entries({ debit, credit, amount, fee, tax })) {
    if (!Number.isInteger(val)) {
      throw new Error(`SettlementRecord: '${name}' must be an integer (paise). Got: ${val}`);
    }
  }

  return Object.freeze({
    entity_id,
    type,
    debit,
    credit,
    amount,
    currency,
    fee,
    tax,
    on_hold,
    settled,
    created_at,
    settled_at,
    settlement_id,
    settlement_utr,
    posted_at,
    credit_type,
    description,
    notes,
    payment_id,
    order_id,
    order_receipt,
    method,
    card_network,
    card_issuer,
    card_type,
    dispute_id,
    // Internal — stripped before returning to AI
    _batch_index,
    _scenario,
    _source,
  });
}

module.exports = { createSettlementRecord };
