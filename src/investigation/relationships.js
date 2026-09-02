'use strict';
/**
 * src/investigation/relationships.js
 *
 * Builds an explicit relationship graph for an investigation case.
 *
 * When a relationship is missing it is represented explicitly as MISSING,
 * which is critical for MISSING_ORDER, MISSING_PAYMENT, etc.
 */

/**
 * @typedef {Object} Relationship
 * @property {string}      relationship - e.g. 'PAYMENT_TO_ORDER'
 * @property {string}      from         - entity_id of the source
 * @property {string|null} to           - entity_id of the target, or null if missing
 * @property {string}      status       - 'PRESENT' | 'MISSING' | 'SIMULATED'
 * @property {string}      description
 */

/**
 * Build the relationship graph for an investigation case.
 *
 * @param {Object} params
 * @param {Object}      params.exception
 * @param {Object}      params.reconResult
 * @param {Object|null} params.settlementRecord
 * @param {Object|null} params.merchantOrder
 * @param {Object|null} params.merchantLedger
 * @param {Array}       params.refundRecords
 * @param {Array}       params.settlementBatches
 * @returns {Relationship[]}
 */
function buildRelationships({ exception, reconResult, settlementRecord, merchantOrder, merchantLedger, refundRecords = [], settlementBatches = [] }) {
  const rels = [];
  const sr   = settlementRecord;
  const mo   = merchantOrder;
  const le   = merchantLedger;
  const rr   = reconResult;

  function add(relationship, from, to, status, description) {
    rels.push({ relationship, from, to, status, description });
  }

  // ── Payment → Order (Razorpay side) ──────────────────────────────────────
  if (sr && sr.type === 'payment') {
    if (sr.order_id) {
      add(
        'PAYMENT_TO_RAZORPAY_ORDER',
        sr.entity_id,
        sr.order_id,
        'PRESENT',
        `Payment ${sr.entity_id} is linked to Razorpay order ${sr.order_id}.`,
      );
    } else {
      add(
        'PAYMENT_TO_RAZORPAY_ORDER',
        sr.entity_id,
        null,
        'MISSING',
        `Payment ${sr.entity_id} has no order_id. Cannot trace to a Razorpay order.`,
      );
    }
  }

  // ── Payment → Merchant Order ──────────────────────────────────────────────
  if (sr) {
    if (mo) {
      add(
        'PAYMENT_TO_MERCHANT_ORDER',
        sr.entity_id,
        mo.id,
        'PRESENT',
        `Payment ${sr.entity_id} resolves to merchant order ${mo.id} (Razorpay order: ${mo.razorpay_order_id}).`,
      );
    } else if (sr.type !== 'adjustment') {
      add(
        'PAYMENT_TO_MERCHANT_ORDER',
        sr.entity_id,
        null,
        'MISSING',
        `No merchant order could be found for payment ${sr.entity_id} (order_id: ${sr.order_id || 'null'}).`,
      );
    }
  }

  // ── Merchant Order → Merchant Ledger ─────────────────────────────────────
  if (mo) {
    if (le) {
      add(
        'MERCHANT_ORDER_TO_LEDGER',
        mo.id,
        le.id,
        'PRESENT',
        `Merchant order ${mo.id} has ledger entry ${le.id} (status: ${le.status}).`,
      );
    } else {
      add(
        'MERCHANT_ORDER_TO_LEDGER',
        mo.id,
        null,
        'MISSING',
        `Merchant order ${mo.id} has no corresponding ledger entry.`,
      );
    }
  }

  // ── Payment → Settlement Batch ────────────────────────────────────────────
  if (sr && sr.settlement_id) {
    const settleSrc = sr._source === 'razorpay_test_simulated_settlement' ? 'SIMULATED' : 'PRESENT';
    add(
      'PAYMENT_TO_SETTLEMENT_BATCH',
      sr.entity_id,
      sr.settlement_id,
      settleSrc,
      `Payment ${sr.entity_id} appears in settlement batch ${sr.settlement_id} (UTR: ${sr.settlement_utr || 'N/A'}). Source: ${settleSrc.toLowerCase()}.`,
    );
  } else if (sr) {
    add(
      'PAYMENT_TO_SETTLEMENT_BATCH',
      sr.entity_id,
      null,
      'MISSING',
      `Payment ${sr.entity_id} has no settlement_id — not yet settled.`,
    );
  }

  // ── MISSING_PAYMENT: Merchant order has no settlement record ──────────────
  if (!sr && mo && rr.exception_category === 'MISSING_PAYMENT') {
    add(
      'PAYMENT_TO_SETTLEMENT_BATCH',
      mo.id,
      null,
      'MISSING',
      `Merchant order ${mo.id} is marked 'paid' but has NO corresponding settlement record. Settlement is missing past the expected cutoff.`,
    );
  }

  // ── Refunds → Parent Payment ──────────────────────────────────────────────
  for (const rfnd of refundRecords) {
    if (rfnd.payment_id) {
      const rfndSrc = rfnd._source === 'razorpay_test_simulated_settlement' ? 'SIMULATED' : 'PRESENT';
      add(
        'REFUND_TO_PARENT_PAYMENT',
        rfnd.entity_id,
        rfnd.payment_id,
        rfndSrc,
        `Refund ${rfnd.entity_id} references parent payment ${rfnd.payment_id}. Settlement batch: ${rfnd.settlement_id || 'N/A'}.`,
      );
    }
  }

  // ── TIMING_MISMATCH: Payment and refund in different batches ──────────────
  if (sr && sr.type === 'payment' && refundRecords.length > 0) {
    const crossBatch = refundRecords.filter(r => r.settlement_id !== sr.settlement_id);
    for (const rfnd of crossBatch) {
      add(
        'CROSS_BATCH_REFUND',
        rfnd.entity_id,
        sr.entity_id,
        'PRESENT',
        `Refund ${rfnd.entity_id} settled in batch ${rfnd.settlement_id} while its parent payment settled in batch ${sr.settlement_id}. Cross-batch timing mismatch.`,
      );
    }
  }

  // ── DUPLICATE: Points to siblings ────────────────────────────────────────
  if (rr.exception_category === 'DUPLICATE' && sr) {
    add(
      'POTENTIAL_DUPLICATE',
      sr.entity_id,
      sr.order_id || null,
      'PRESENT',
      `Payment ${sr.entity_id} is flagged as a potential duplicate for order ${sr.order_id || 'N/A'}.`,
    );
  }

  // ── Reconciliation result → Exception ─────────────────────────────────────
  add(
    'RECONCILIATION_TO_EXCEPTION',
    rr.id,
    exception.id,
    'PRESENT',
    `Reconciliation result ${rr.id} produced exception ${exception.id} (category: ${exception.category}).`,
  );

  return rels;
}

module.exports = { buildRelationships };
