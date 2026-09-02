'use strict';
/**
 * src/engine/reconcile.js
 *
 * Deterministic reconciliation engine.
 *
 * Compares Razorpay settlement records against merchant orders and ledger
 * and produces ReconciliationResult + Exception records.
 *
 * Rule execution order matters — rules are tried in priority order.
 * The first matching exception rule wins.
 *
 * No AI, no LLM, no external calls.
 */

const {
  ruleMatched,
  ruleFeeVariance,
  ruleMissingOrder,
  ruleAdjustment,
  ruleTimingMismatch,
  ruleDuplicate,
  ruleUnexplained,
  calcExpectedFee,
} = require('./rules');
const { createReconciliationResult, RECON_STATUS } = require('../models/reconciliationResult');
const { createException } = require('../models/exception');

let _resultSeq = 0;
let _exceptionSeq = 0;

function nextResultId()    { return `recon_${String(++_resultSeq).padStart(6, '0')}`; }
function nextExceptionId() { return `exc_${String(++_exceptionSeq).padStart(6, '0')}`; }

/**
 * Build lookup maps for fast O(1) access during reconciliation.
 */
function buildLookups({ merchantOrders, merchantLedger, settlementRecords }) {
  // order_id → MerchantOrder
  const orderByRzpId = new Map();
  for (const mo of merchantOrders) {
    if (mo.razorpay_order_id) orderByRzpId.set(mo.razorpay_order_id, mo);
  }

  // MerchantOrder.id → MerchantLedgerEntry
  const ledgerByMoId = new Map();
  for (const le of merchantLedger) {
    ledgerByMoId.set(le.merchant_order_id, le);
  }

  // payment entity_id → refund records (where payment_id = entity_id)
  const refundsByPayId = new Map();
  for (const sr of settlementRecords) {
    if (sr.type === 'refund' && sr.payment_id) {
      const arr = refundsByPayId.get(sr.payment_id) || [];
      arr.push(sr);
      refundsByPayId.set(sr.payment_id, arr);
    }
  }

  // MerchantOrder.id → MerchantOrder (for MISSING_PAYMENT)
  const orderByMoId = new Map();
  for (const mo of merchantOrders) orderByMoId.set(mo.id, mo);

  return { orderByRzpId, ledgerByMoId, refundsByPayId, orderByMoId };
}

/**
 * Run the reconciliation engine against a complete dataset.
 *
 * @param {Object} dataset
 *   {
 *     settlementRecords: SettlementRecord[],
 *     merchantOrders:    MerchantOrder[],
 *     merchantLedger:    MerchantLedgerEntry[],
 *   }
 *
 * @returns {{ results: ReconciliationResult[], exceptions: Exception[] }}
 */
function reconcile({ settlementRecords, merchantOrders, merchantLedger }) {
  // Reset sequences for determinism (important for tests)
  _resultSeq    = 0;
  _exceptionSeq = 0;

  const NOW = Math.floor(Date.now() / 1000);
  const results   = [];
  const exceptions = [];

  const { orderByRzpId, ledgerByMoId, refundsByPayId, orderByMoId } =
    buildLookups({ merchantOrders, merchantLedger, settlementRecords });

  // Track which settlement entity_ids have been processed
  const processedEntityIds = new Set();

  // ── Pass 1: Process each settlement record ─────────────────────────────────
  for (const sr of settlementRecords) {
    processedEntityIds.add(sr.entity_id);

    const merchantOrder = sr.order_id ? orderByRzpId.get(sr.order_id) : null;
    const ledgerEntry   = merchantOrder ? ledgerByMoId.get(merchantOrder.id) : null;
    const relatedRefunds = refundsByPayId.get(sr.entity_id) || [];

    const ctx = {
      sr,
      merchantOrder,
      ledgerEntry,
      relatedRefunds,
      allSettlementRecords: settlementRecords,
    };

    let ruleResult = null;

    // ── Rule priority order ────────────────────────────────────────────────
    // 1. Adjustment (type-based, unambiguous)
    if (!ruleResult) ruleResult = ruleAdjustment(ctx);

    // 2. Missing order (no order_id and no merchant match)
    if (!ruleResult) ruleResult = ruleMissingOrder(ctx);

    // 3. Duplicate detection
    if (!ruleResult) ruleResult = ruleDuplicate(ctx);

    // 4. Fee/tax variance (before matching — a matched payment can still have fee variance)
    const feeResult = ruleFeeVariance(ctx);

    // 5. Timing mismatch (cross-batch refund)
    if (!ruleResult) ruleResult = ruleTimingMismatch(ctx);

    // 6. Clean match
    if (!ruleResult) ruleResult = ruleMatched(ctx);

    // 7. Unexplained (catch-all — must be last)
    if (!ruleResult) ruleResult = ruleUnexplained(ctx);

    // 8. Default: partially matched if merchant order exists but no clean rule fired
    if (!ruleResult && merchantOrder) {
      ruleResult = {
        status:   RECON_STATUS.PARTIALLY_MATCHED,
        category: 'PARTIALLY_MATCHED',
        reason:   `Merchant order found but no deterministic rule fully resolved the reconciliation for ${sr.entity_id}.`,
      };
    }

    // 9. Absolute default — exception with no category resolved
    if (!ruleResult) {
      ruleResult = {
        status:   RECON_STATUS.EXCEPTION,
        category: 'UNEXPLAINED',
        reason:   `No rule matched for ${sr.entity_id} and no merchant order found.`,
      };
    }

    // ── Build reconciliation result ────────────────────────────────────────
    // Fee variance can co-exist with other status — use fee result if stronger
    const finalStatus   = feeResult ? feeResult.status   : ruleResult.status;
    const finalCategory = feeResult ? feeResult.category : ruleResult.category;
    const finalReason   = feeResult
      ? `${feeResult.reason} (additionally: ${ruleResult.reason})`
      : ruleResult.reason;

    const { fee: expFee, tax: expTax } = calcExpectedFee(sr.amount);

    const result = createReconciliationResult({
      id:                   nextResultId(),
      settlement_entity_id: sr.entity_id,
      merchant_order_id:    merchantOrder ? merchantOrder.id : null,
      merchant_ledger_id:   ledgerEntry   ? ledgerEntry.id   : null,
      payment_entity_id:    sr.type === 'payment' ? sr.entity_id : null,
      refund_entity_ids:    relatedRefunds.map(r => r.entity_id),
      status:               finalStatus,
      exception_category:   finalCategory !== 'MATCHED' ? finalCategory : null,
      reason:               finalReason,
      amount_razorpay:      sr.credit !== null ? sr.credit : null,
      amount_merchant:      ledgerEntry ? ledgerEntry.expected_amount : null,
      amount_variance:      (sr.credit !== null && ledgerEntry)
                              ? sr.credit - ledgerEntry.expected_amount
                              : null,
      fee_expected:         expFee,
      fee_actual:           sr.fee,
      tax_expected:         expTax,
      tax_actual:           sr.tax,
      created_at:           NOW,
    });

    results.push(result);

    // ── Create exception if warranted ──────────────────────────────────────
    if (finalStatus !== RECON_STATUS.MATCHED) {
      const amountAtRisk = (() => {
        if (finalCategory === 'DUPLICATE') return sr.amount;
        if (finalCategory === 'MISSING_ORDER') return sr.amount;
        if (finalCategory === 'ADJUSTMENT')  return sr.credit || sr.amount;
        if (finalCategory === 'TIMING_MISMATCH') return sr.amount;
        if (result.amount_variance !== null)  return Math.abs(result.amount_variance);
        return sr.amount;
      })();

      const exc = createException({
        id:                       nextExceptionId(),
        reconciliation_result_id: result.id,
        category:                 finalCategory,
        amount_at_risk:           amountAtRisk,
        created_at:               NOW,
        description:              finalReason,
      });
      exceptions.push(exc);
    }
  }

  // ── Pass 2: MISSING_PAYMENT ───────────────────────────────────────────────
  // Find merchant orders whose ledger says 'pending' but no settlement record
  // exists for the associated Razorpay order after the cutoff window.
  const cutoffSeconds = Math.floor(Date.now() / 1000);
  const cutoff        = cutoffSeconds - (config.MISSING_PAYMENT_CUTOFF_DAYS * config.SECONDS_PER_DAY);

  for (const mo of merchantOrders) {
    const ledgerEntry = ledgerByMoId.get(mo.id);
    if (!ledgerEntry || ledgerEntry.status !== 'pending') continue;

    // Check if a settlement record exists for this order
    const hasSr = settlementRecords.some(
      sr => sr.order_id === mo.razorpay_order_id,
    );
    if (hasSr) continue;

    // Order is old enough that we'd expect settlement by now
    if (mo.created_at > cutoff) continue;

    const missingResult = createReconciliationResult({
      id:                   nextResultId(),
      settlement_entity_id: `__missing_${mo.id}`,
      merchant_order_id:    mo.id,
      merchant_ledger_id:   ledgerEntry.id,
      payment_entity_id:    null,
      refund_entity_ids:    [],
      status:               RECON_STATUS.EXCEPTION,
      exception_category:   'MISSING_PAYMENT',
      reason:               `Merchant order ${mo.id} (Razorpay order: ${mo.razorpay_order_id}) is marked 'paid' in merchant records but no settlement record exists after ${config.MISSING_PAYMENT_CUTOFF_DAYS}-day cutoff.`,
      amount_razorpay:      null,
      amount_merchant:      ledgerEntry.expected_amount,
      amount_variance:      null,
      fee_expected:         null,
      fee_actual:           null,
      tax_expected:         null,
      tax_actual:           null,
      created_at:           NOW,
    });

    results.push(missingResult);

    const missingExc = createException({
      id:                       nextExceptionId(),
      reconciliation_result_id: missingResult.id,
      category:                 'MISSING_PAYMENT',
      amount_at_risk:           ledgerEntry.expected_amount,
      created_at:               NOW,
      description:              missingResult.reason,
    });
    exceptions.push(missingExc);
  }

  return { results, exceptions };
}

// Need config here for MISSING_PAYMENT rule
const config = require('./config');

module.exports = { reconcile };
