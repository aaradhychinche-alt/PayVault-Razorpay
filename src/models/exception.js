'use strict';
/**
 * src/models/exception.js
 *
 * Exception record — only created when the deterministic engine identifies
 * a meaningful discrepancy that warrants human/AI attention.
 */

const EXCEPTION_CATEGORIES = Object.freeze([
  'MATCHED',
  'PARTIALLY_MATCHED',
  'REFUND_MISMATCH',
  'FEE_TAX_VARIANCE',
  'MISSING_ORDER',
  'MISSING_PAYMENT',
  'DUPLICATE',
  'ADJUSTMENT',
  'TIMING_MISMATCH',
  'UNEXPLAINED',
]);

/**
 * @param {Object} fields
 * @returns {Exception}
 */
function createException(fields) {
  const {
    id,
    reconciliation_result_id,
    category,           // one of EXCEPTION_CATEGORIES
    amount_at_risk,     // paise — the financial exposure
    created_at,
    description = null, // short plain-text summary (deterministic, not AI)
  } = fields;

  if (!id)                        throw new Error('Exception: id is required');
  if (!reconciliation_result_id)  throw new Error('Exception: reconciliation_result_id is required');
  if (!category)                  throw new Error('Exception: category is required');
  if (amount_at_risk == null)     throw new Error('Exception: amount_at_risk is required');
  if (!created_at)                throw new Error('Exception: created_at is required');

  if (!EXCEPTION_CATEGORIES.includes(category)) {
    throw new Error(`Exception: unknown category '${category}'. Valid: ${EXCEPTION_CATEGORIES.join(', ')}`);
  }
  if (!Number.isInteger(amount_at_risk)) {
    throw new Error(`Exception: 'amount_at_risk' must be integer paise. Got: ${amount_at_risk}`);
  }

  return Object.freeze({
    id,
    reconciliation_result_id,
    category,
    amount_at_risk,
    created_at,
    description,
  });
}

module.exports = { createException, EXCEPTION_CATEGORIES };
