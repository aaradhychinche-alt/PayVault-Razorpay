'use strict';
/**
 * src/models/merchantOrder.js
 *
 * Merchant-side order data.
 * Represents data belonging to the MERCHANT's system, not Razorpay.
 *
 * All monetary values in INTEGER PAISE.
 */

/**
 * @typedef {Object} MerchantOrder
 */

/**
 * @param {Object} fields
 * @returns {MerchantOrder}
 */
function createMerchantOrder(fields) {
  const {
    id,                       // local merchant order ID, e.g. 'mo_000001'
    razorpay_order_id = null, // Razorpay order_id, e.g. 'order_xxx'
    amount,                   // paise — what the merchant expected to receive
    currency = 'INR',
    customer_email = null,
    customer_name  = null,
    description    = null,
    created_at,               // Unix timestamp
    status,                   // 'pending' | 'paid' | 'failed' | 'refunded'
    receipt = null,
    metadata = null,
    // Internal — ground truth, never supplied to engine or AI
    _expected_classification = null,
  } = fields;

  if (!id)         throw new Error('MerchantOrder: id is required');
  if (amount == null) throw new Error('MerchantOrder: amount is required');
  if (!created_at) throw new Error('MerchantOrder: created_at is required');
  if (!status)     throw new Error('MerchantOrder: status is required');

  if (!Number.isInteger(amount)) {
    throw new Error(`MerchantOrder: 'amount' must be an integer (paise). Got: ${amount}`);
  }

  return Object.freeze({
    id,
    razorpay_order_id,
    amount,
    currency,
    customer_email,
    customer_name,
    description,
    created_at,
    status,
    receipt,
    metadata,
    _expected_classification,
  });
}

module.exports = { createMerchantOrder };
