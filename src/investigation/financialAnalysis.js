'use strict';
/**
 * src/investigation/financialAnalysis.js
 *
 * Deterministic financial analysis for an investigation case.
 * All values are integer paise. No floating-point arithmetic.
 * Reuses calculations already available on reconciliation results;
 * adds additional breakdowns useful for AI investigation.
 */

const { calcFee } = require('../data/generator');

/**
 * Build a structured financial analysis payload.
 *
 * @param {Object} params
 * @param {Object} params.reconResult     - ReconciliationResult
 * @param {Object} params.settlementRecord - SettlementRecord (may be null for MISSING_PAYMENT)
 * @param {Object} params.merchantLedger  - MerchantLedgerEntry (may be null)
 * @param {Array}  params.refundRecords   - SettlementRecord[] of type='refund'
 * @returns {Object} financialAnalysis
 */
function buildFinancialAnalysis({ reconResult, settlementRecord, merchantLedger, refundRecords = [] }) {
  const sr  = settlementRecord;
  const le  = merchantLedger;
  const rr  = reconResult;

  // ── Gross amount ──────────────────────────────────────────────────────────
  const grossAmount = sr ? sr.amount : null;

  // ── Fee / Tax (expected vs actual) ────────────────────────────────────────
  // Re-use values already computed and stored on the reconciliation result
  const feeExpected   = rr.fee_expected  ?? null;
  const feeActual     = rr.fee_actual    ?? null;
  const taxExpected   = rr.tax_expected  ?? null;
  const taxActual     = rr.tax_actual    ?? null;

  const feeVariance = (feeExpected !== null && feeActual !== null)
    ? feeActual - feeExpected   // negative = undercharged, positive = overcharged
    : null;
  const taxVariance = (taxExpected !== null && taxActual !== null)
    ? taxActual - taxExpected
    : null;

  // ── Settlement credit / debit ─────────────────────────────────────────────
  const settlementCredit = sr ? sr.credit : null;
  const settlementDebit  = sr ? sr.debit  : null;

  // ── Merchant expected vs received ─────────────────────────────────────────
  const expectedMerchantAmount = le ? le.expected_amount : rr.amount_merchant;
  const actualMerchantAmount   = le ? le.posted_amount   : rr.amount_razorpay;
  const merchantVariance       = rr.amount_variance;   // already computed by engine

  // ── Refund totals ─────────────────────────────────────────────────────────
  const totalRefundAmount = refundRecords.reduce((s, r) => s + r.amount, 0);
  const refundCount       = refundRecords.length;

  // ── Net received after refunds ────────────────────────────────────────────
  const netAfterRefunds = (settlementCredit !== null)
    ? settlementCredit - totalRefundAmount
    : null;

  // ── Assertions / comparison lines ────────────────────────────────────────
  const comparisons = [];

  if (grossAmount !== null && expectedMerchantAmount !== null) {
    const expectedNetFromGross = grossAmount - (feeExpected ?? 0) - (taxExpected ?? 0);
    comparisons.push({
      type:        'GROSS_TO_EXPECTED_NET',
      description: 'Expected net merchant credit derived from gross amount minus expected fee and tax.',
      gross_amount:         grossAmount,
      expected_fee:         feeExpected,
      expected_tax:         taxExpected,
      expected_net:         expectedNetFromGross,
      unit: 'paise',
      source: sr ? [`settlement:${sr.entity_id}`] : [],
    });
  }

  if (settlementCredit !== null && expectedMerchantAmount !== null) {
    comparisons.push({
      type:        'CREDIT_VS_EXPECTED',
      description: 'Settlement credit received vs merchant expected amount.',
      expected:    expectedMerchantAmount,
      actual:      settlementCredit,
      variance:    merchantVariance,
      unit:        'paise',
      source: [
        sr ? `settlement:${sr.entity_id}` : null,
        le ? `ledger:${le.id}` : null,
      ].filter(Boolean),
    });
  }

  if (feeVariance !== null) {
    comparisons.push({
      type:        'FEE_COMPARISON',
      description: 'Platform fee charged vs expected fee based on contract rate (2%).',
      expected:    feeExpected,
      actual:      feeActual,
      variance:    feeVariance,
      unit:        'paise',
      source: sr ? [`settlement:${sr.entity_id}`] : [],
    });
  }

  if (taxVariance !== null) {
    comparisons.push({
      type:        'TAX_COMPARISON',
      description: 'GST on platform fee (charged vs expected at 18% of fee).',
      expected:    taxExpected,
      actual:      taxActual,
      variance:    taxVariance,
      unit:        'paise',
      source: sr ? [`settlement:${sr.entity_id}`] : [],
    });
  }

  if (refundCount > 0) {
    comparisons.push({
      type:        'REFUND_TOTAL',
      description: `Total refund amount across ${refundCount} refund record(s).`,
      refund_count:         refundCount,
      total_refund_amount:  totalRefundAmount,
      net_after_refunds:    netAfterRefunds,
      unit:                 'paise',
      source: refundRecords.map(r => `refund:${r.entity_id}`),
    });
  }

  return {
    gross_amount:             grossAmount,
    settlement_credit:        settlementCredit,
    settlement_debit:         settlementDebit,
    expected_merchant_amount: expectedMerchantAmount,
    actual_merchant_amount:   actualMerchantAmount,
    merchant_variance:        merchantVariance,
    fee_expected:             feeExpected,
    fee_actual:               feeActual,
    fee_variance:             feeVariance,
    tax_expected:             taxExpected,
    tax_actual:               taxActual,
    tax_variance:             taxVariance,
    total_refund_amount:      totalRefundAmount,
    refund_count:             refundCount,
    net_after_refunds:        netAfterRefunds,
    amount_at_risk:           null,   // populated by caseBuilder from exception
    currency:                 sr ? sr.currency : 'INR',
    unit:                     'paise',
    comparisons,
  };
}

module.exports = { buildFinancialAnalysis };
