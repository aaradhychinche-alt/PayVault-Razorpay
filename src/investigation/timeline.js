'use strict';
/**
 * src/investigation/timeline.js
 *
 * Builds a deterministic chronological event timeline for an investigation.
 *
 * Rules:
 * - Every event must come from a real record timestamp.
 * - Simulated settlement timestamps are tagged source='simulated'.
 * - No timestamps are invented or estimated.
 * - Timeline is sorted ascending by timestamp.
 */

/**
 * @typedef {Object} TimelineEvent
 * @property {number}  timestamp   - Unix timestamp (seconds)
 * @property {string}  event_type  - e.g. 'PAYMENT_CREATED'
 * @property {string}  entity_id   - ID of the entity this event concerns
 * @property {string}  source      - 'razorpay_test_mode' | 'simulated' | 'merchant_data' | 'derived'
 * @property {string}  description - Human-readable description of the event
 */

/**
 * Build a sorted timeline for an investigation case.
 *
 * @param {Object} params
 * @param {Object}   params.exception
 * @param {Object}   params.reconResult
 * @param {Object|null} params.settlementRecord
 * @param {Object|null} params.merchantOrder
 * @param {Object|null} params.merchantLedger
 * @param {Array}    params.refundRecords
 * @returns {TimelineEvent[]}
 */
function buildTimeline({ exception, reconResult, settlementRecord, merchantOrder, merchantLedger, refundRecords = [] }) {
  const events = [];

  function add(ts, eventType, entityId, source, description) {
    if (ts == null || ts <= 0) return;  // never add null/zero timestamps
    events.push({ timestamp: ts, event_type: eventType, entity_id: entityId, source, description });
  }

  const sr  = settlementRecord;
  const mo  = merchantOrder;
  const le  = merchantLedger;
  const exc = exception;
  const rr  = reconResult;

  // ── Merchant order created ─────────────────────────────────────────────────
  if (mo) {
    add(
      mo.created_at,
      'MERCHANT_ORDER_CREATED',
      mo.id,
      'merchant_data',
      `Merchant order ${mo.id} created (Razorpay order: ${mo.razorpay_order_id || 'N/A'}, amount: ${mo.amount} paise).`,
    );
  }

  // ── Payment created (from settlement record timestamp) ────────────────────
  if (sr && sr.type === 'payment') {
    const src = sr._source === 'razorpay_test_simulated_settlement'
      ? 'razorpay_test_mode'   // payment itself is real; settlement is simulated
      : 'razorpay_test_mode';
    add(
      sr.created_at,
      'PAYMENT_CREATED',
      sr.entity_id,
      src,
      `Payment ${sr.entity_id} created. Amount: ${sr.amount} paise. Method: ${sr.method || 'N/A'}.`,
    );
  }

  // ── Refunds created ───────────────────────────────────────────────────────
  for (const rfnd of refundRecords) {
    add(
      rfnd.created_at,
      'REFUND_CREATED',
      rfnd.entity_id,
      'razorpay_test_mode',
      `Refund ${rfnd.entity_id} created for payment ${rfnd.payment_id}. Amount: ${rfnd.amount} paise.`,
    );
  }

  // ── Merchant ledger entry created ─────────────────────────────────────────
  if (le && le.posted_at) {
    add(
      le.posted_at,
      'MERCHANT_LEDGER_POSTED',
      le.id,
      'merchant_data',
      `Merchant ledger entry ${le.id} posted. Expected: ${le.expected_amount} paise, Posted: ${le.posted_amount ?? 'N/A'} paise. Status: ${le.status}.`,
    );
  }

  // ── Settlement events ─────────────────────────────────────────────────────
  if (sr && sr.settled_at) {
    const settleSrc = sr._source === 'razorpay_test_simulated_settlement' ? 'simulated' : 'razorpay_test_mode';
    add(
      sr.settled_at,
      sr.type === 'refund' ? 'REFUND_SETTLED' : 'PAYMENT_SETTLED',
      sr.entity_id,
      settleSrc,
      `${sr.type === 'refund' ? 'Refund' : 'Payment'} ${sr.entity_id} settled in batch ${sr.settlement_id || 'N/A'} (UTR: ${sr.settlement_utr || 'N/A'}). Credit: ${sr.credit} paise. Source: ${settleSrc}.`,
    );
  }

  for (const rfnd of refundRecords) {
    if (rfnd.settled_at) {
      const rfndSrc = rfnd._source === 'razorpay_test_simulated_settlement' ? 'simulated' : 'razorpay_test_mode';
      add(
        rfnd.settled_at,
        'REFUND_SETTLED',
        rfnd.entity_id,
        rfndSrc,
        `Refund ${rfnd.entity_id} settled in batch ${rfnd.settlement_id || 'N/A'}. Debit: ${rfnd.amount} paise. Source: ${rfndSrc}.`,
      );
    }
  }

  // ── Reconciliation result computed ────────────────────────────────────────
  if (rr && rr.created_at) {
    add(
      rr.created_at,
      'RECONCILIATION_RESULT_COMPUTED',
      rr.id,
      'derived',
      `Deterministic reconciliation engine produced result: status=${rr.status}, category=${rr.exception_category || 'MATCHED'}.`,
    );
  }

  // ── Exception generated ───────────────────────────────────────────────────
  if (exc && exc.created_at) {
    add(
      exc.created_at,
      'EXCEPTION_GENERATED',
      exc.id,
      'derived',
      `Exception ${exc.id} generated: category=${exc.category}, amount_at_risk=${exc.amount_at_risk} paise.`,
    );
  }

  // Sort ascending by timestamp
  events.sort((a, b) => a.timestamp - b.timestamp);

  return events;
}

module.exports = { buildTimeline };
