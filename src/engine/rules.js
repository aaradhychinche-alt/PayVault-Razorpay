'use strict';
/**
 * src/engine/rules.js
 *
 * Deterministic rule implementations for the reconciliation engine.
 *
 * IMPORTANT: All classification is done here, with explicit rules.
 * No LLM, no heuristic guessing, no AI — only deterministic logic.
 *
 * Each rule function returns { matched: boolean, reason: string } or void.
 */

const config = require('./config');

// ── Utility ─────────────────────────────────────────────────────────────────

/**
 * Absolute difference between two integer paise values.
 * Safe — no floating point.
 */
function paiseDiff(a, b) {
  return Math.abs(a - b);
}

/**
 * Whether two amounts are within the configured rounding tolerance.
 */
function withinAmountTolerance(a, b) {
  return paiseDiff(a, b) <= config.AMOUNT_TOLERANCE_PAISE;
}

/**
 * Whether two fee/tax amounts are within the configured tolerance.
 */
function withinFeeTaxTolerance(a, b) {
  return paiseDiff(a, b) <= config.FEE_TAX_TOLERANCE_PAISE;
}

/**
 * Calculate expected fee and tax for a given gross amount.
 * Returns { fee, tax } in paise.
 */
function calcExpectedFee(amount) {
  const fee = Math.round(amount * config.PLATFORM_FEE_RATE);
  const tax = Math.round(fee * config.GST_RATE);
  return { fee, tax };
}

// ── Rule: MATCHED ────────────────────────────────────────────────────────────

/**
 * MATCHED: Payment exists, merchant order exists, ledger exists,
 * and the net amount matches within tolerance. Or refund matches parent payment in same batch.
 */
function ruleMatched({ sr, merchantOrder, ledgerEntry, allSettlementRecords }) {
  if (!merchantOrder || !ledgerEntry) return null;

  if (sr.type === 'payment') {
    const expectedNet = ledgerEntry.expected_amount;
    const actualNet   = sr.credit;

    if (withinAmountTolerance(actualNet, expectedNet)) {
      return {
        status:   'MATCHED',
        category: 'MATCHED',
        reason:   `Net amount matches within ${config.AMOUNT_TOLERANCE_PAISE} paise tolerance. Razorpay credit: ${actualNet} paise, merchant expected: ${expectedNet} paise.`,
      };
    }
  } else if (sr.type === 'refund') {
    if (sr.payment_id && allSettlementRecords) {
      const parentPay = allSettlementRecords.find(other => other.entity_id === sr.payment_id);
      if (parentPay && parentPay.settlement_id === sr.settlement_id) {
        return {
          status:   'MATCHED',
          category: 'MATCHED',
          reason:   `Refund ${sr.entity_id} matches parent payment ${parentPay.entity_id} in the same settlement batch ${sr.settlement_id}.`,
        };
      }
    }
  }
  return null;
}

// ── Rule: FEE_TAX_VARIANCE ───────────────────────────────────────────────────

/**
 * FEE_TAX_VARIANCE: Fee or tax differs from expected calculation beyond tolerance.
 * Checked even on otherwise-matched payments.
 */
function ruleFeeVariance({ sr }) {
  if (sr.type !== 'payment') return null;

  const { fee: expectedFee, tax: expectedTax } = calcExpectedFee(sr.amount);
  const feeVariance = paiseDiff(sr.fee, expectedFee);
  const taxVariance = paiseDiff(sr.tax, expectedTax);

  if (feeVariance > config.FEE_TAX_TOLERANCE_PAISE) {
    return {
      status:   'EXCEPTION',
      category: 'FEE_TAX_VARIANCE',
      reason:   `Fee variance of ${feeVariance} paise exceeds tolerance of ${config.FEE_TAX_TOLERANCE_PAISE} paise. Expected fee: ${expectedFee}, actual fee: ${sr.fee}.`,
      feeVariance,
      taxVariance,
    };
  }
  if (taxVariance > config.FEE_TAX_TOLERANCE_PAISE) {
    return {
      status:   'EXCEPTION',
      category: 'FEE_TAX_VARIANCE',
      reason:   `Tax variance of ${taxVariance} paise exceeds tolerance of ${config.FEE_TAX_TOLERANCE_PAISE} paise. Expected tax: ${expectedTax}, actual tax: ${sr.tax}.`,
      feeVariance,
      taxVariance,
    };
  }
  return null;
}

// ── Rule: MISSING_ORDER ──────────────────────────────────────────────────────

/**
 * MISSING_ORDER: Settlement record has no order_id and no matching merchant order.
 */
function ruleMissingOrder({ sr, merchantOrder }) {
  if (sr.type === 'adjustment') return null; // adjustments handled separately
  if (!sr.order_id && !merchantOrder) {
    return {
      status:   'EXCEPTION',
      category: 'MISSING_ORDER',
      reason:   `Settlement record ${sr.entity_id} has null order_id and no matching merchant order. Cannot trace to source transaction.`,
    };
  }
  return null;
}

// ── Rule: ADJUSTMENT ────────────────────────────────────────────────────────

/**
 * ADJUSTMENT: type=adjustment with no order_id or payment_id counterpart.
 */
function ruleAdjustment({ sr }) {
  if (sr.type === 'adjustment') {
    return {
      status:   'EXCEPTION',
      category: 'ADJUSTMENT',
      reason:   `Settlement adjustment ${sr.entity_id} (${sr.description || 'no description'}) has no payment/refund counterpart. Requires manual review.`,
    };
  }
  return null;
}

// ── Rule: TIMING_MISMATCH ────────────────────────────────────────────────────

/**
 * TIMING_MISMATCH: A payment and its corresponding refund are in different
 * settlement batches — they cannot reconcile cleanly when viewed per-batch.
 */
function ruleTimingMismatch({ sr, relatedRefunds, allSettlementRecords }) {
  if (sr.type === 'payment' && relatedRefunds && relatedRefunds.length > 0) {
    const differentBatchRefunds = relatedRefunds.filter(
      rfnd => rfnd.settlement_id !== sr.settlement_id,
    );

    if (differentBatchRefunds.length > 0) {
      return {
        status:   'EXCEPTION',
        category: 'TIMING_MISMATCH',
        reason:   `Payment ${sr.entity_id} settled in batch ${sr.settlement_id} but ${differentBatchRefunds.length} refund(s) settled in a different batch: [${differentBatchRefunds.map(r => r.settlement_id).join(', ')}]. Cross-batch reconciliation required.`,
      };
    }
  }

  if (sr.type === 'refund' && sr.payment_id && allSettlementRecords) {
    const parentPay = allSettlementRecords.find(other => other.entity_id === sr.payment_id);
    if (parentPay && parentPay.settlement_id !== sr.settlement_id) {
      return {
        status:   'EXCEPTION',
        category: 'TIMING_MISMATCH',
        reason:   `Refund ${sr.entity_id} settled in batch ${sr.settlement_id} but its parent payment ${parentPay.entity_id} settled in batch ${parentPay.settlement_id}. Cross-batch reconciliation required.`,
      };
    }
  }

  return null;
}

// ── Rule: DUPLICATE ──────────────────────────────────────────────────────────

/**
 * DUPLICATE: Multiple payment records share the same order_id and amount,
 * and their created_at timestamps are within DUPLICATE_WINDOW_SECONDS.
 */
function ruleDuplicate({ sr, allSettlementRecords }) {
  if (sr.type !== 'payment' || !sr.order_id) return null;

  const candidates = allSettlementRecords.filter(other =>
    other.entity_id !== sr.entity_id &&
    other.type === 'payment' &&
    other.order_id === sr.order_id &&
    other.amount === sr.amount &&
    Math.abs(other.created_at - sr.created_at) < config.DUPLICATE_WINDOW_SECONDS,
  );

  if (candidates.length > 0) {
    return {
      status:   'EXCEPTION',
      category: 'DUPLICATE',
      reason:   `Payment ${sr.entity_id} appears to be a duplicate of [${candidates.map(c => c.entity_id).join(', ')}] — same order_id, same amount, created within ${config.DUPLICATE_WINDOW_SECONDS}s window.`,
      duplicateIds: candidates.map(c => c.entity_id),
    };
  }
  return null;
}

// ── Rule: UNEXPLAINED ────────────────────────────────────────────────────────

/**
 * UNEXPLAINED: A discrepancy exists (credit ≠ amount − fee − tax) but no
 * other deterministic rule confidently explains it.
 * This rule is a catch-all and must NOT be used before all other rules.
 */
function ruleUnexplained({ sr, merchantOrder, ledgerEntry }) {
  if (sr.type !== 'payment') return null;
  if (!merchantOrder || !ledgerEntry) return null;

  // Expected credit per our formula
  const { fee: expFee, tax: expTax } = calcExpectedFee(sr.amount);
  const expectedCredit = sr.amount - expFee - expTax;
  const variance = sr.credit - expectedCredit;

  // Fee/tax look correct (within tolerance)
  const feeOk = withinFeeTaxTolerance(sr.fee, expFee);
  const taxOk = withinFeeTaxTolerance(sr.tax, expTax);

  // Amount variance is non-trivial but fee/tax are correct — genuinely unexplained
  if (!withinAmountTolerance(sr.credit, ledgerEntry.expected_amount) && feeOk && taxOk) {
    return {
      status:   'EXCEPTION',
      category: 'UNEXPLAINED',
      reason:   `Credit variance of ${Math.abs(variance)} paise detected for ${sr.entity_id}. Fee and tax appear correct. No deterministic rule confidently explains the shortfall. Requires investigation.`,
      variance,
    };
  }
  return null;
}

module.exports = {
  ruleMatched,
  ruleFeeVariance,
  ruleMissingOrder,
  ruleAdjustment,
  ruleTimingMismatch,
  ruleDuplicate,
  ruleUnexplained,
  calcExpectedFee,
  withinAmountTolerance,
  withinFeeTaxTolerance,
  paiseDiff,
};
