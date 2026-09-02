'use strict';
/**
 * src/investigation/ai/patterns.js
 *
 * Deterministic Pattern Engine.
 * Runs BEFORE AI reasoning to identify known financial, temporal,
 * and structural patterns in the InvestigationCase.
 *
 * The pattern engine provides structured signals and evidence links
 * for the reasoning engine to synthesize.
 */

/**
 * @typedef {Object} DetectedPattern
 * @property {string}   pattern_id    - Unique pattern identifier e.g. "PATTERN_FEE_MISMATCH"
 * @property {string}   name          - Human-readable name
 * @property {string}   severity      - "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
 * @property {string[]} evidence_ids  - IDs of evidence supporting this pattern
 * @property {string}   explanation   - Description of what was detected
 * @property {number}   weight        - Relative weight for confidence scoring (0-30)
 */

/**
 * Detect patterns across an InvestigationCase and its extracted evidence.
 *
 * @param {Object} investigationCase
 * @param {Object[]} evidence - Extracted evidence list from extractEvidence()
 * @returns {DetectedPattern[]}
 */
function detectPatterns(investigationCase, evidence) {
  const patterns = [];
  const {
    exception,
    reconciliation_result: rr,
    settlement_record: sr,
    merchant_order: mo,
    merchant_ledger: le,
    refund_records: refunds = [],
    financial_analysis: fa,
    timeline = [],
    relationships = [],
  } = investigationCase;

  // Helper to find evidence ID by source and field
  function findEvId(source, field) {
    const item = evidence.find(e => e.source === source && e.field === field);
    return item ? item.id : null;
  }

  function findEvIdsBySource(source) {
    return evidence.filter(e => e.source === source).map(e => e.id);
  }

  // ── 1. PATTERN_FEE_MISMATCH ───────────────────────────────────────────────
  if (fa && fa.fee_variance !== null && fa.fee_variance !== 0) {
    const evIds = [
      findEvId('financial_analysis', 'fee_variance'),
      findEvId('reconciliation_result', 'fee_actual'),
      findEvId('reconciliation_result', 'fee_expected'),
      findEvId('settlement_record', 'fee'),
    ].filter(Boolean);

    const diff = Math.abs(fa.fee_variance);
    const direction = fa.fee_variance > 0 ? 'overcharged' : 'undercharged';
    patterns.push({
      pattern_id: 'PATTERN_FEE_MISMATCH',
      name: 'Platform Fee Discrepancy',
      severity: diff > 500 ? 'HIGH' : 'MEDIUM',
      evidence_ids: evIds,
      explanation: `Settlement fee of ${fa.fee_actual} paise deviates from standard contracted fee of ${fa.fee_expected} paise (${direction} by ${diff} paise).`,
      weight: 25,
    });
  }

  // ── 2. PATTERN_TAX_MISMATCH ───────────────────────────────────────────────
  if (fa && fa.tax_variance !== null && fa.tax_variance !== 0) {
    const evIds = [
      findEvId('financial_analysis', 'tax_variance'),
      findEvId('reconciliation_result', 'tax_actual'),
      findEvId('reconciliation_result', 'tax_expected'),
      findEvId('settlement_record', 'tax'),
    ].filter(Boolean);

    patterns.push({
      pattern_id: 'PATTERN_TAX_MISMATCH',
      name: 'GST Tax Calculation Discrepancy',
      severity: 'MEDIUM',
      evidence_ids: evIds,
      explanation: `GST tax of ${fa.tax_actual} paise differs from expected 18% GST of ${fa.tax_expected} paise.`,
      weight: 15,
    });
  }

  // ── 3. PATTERN_AMOUNT_MISMATCH ────────────────────────────────────────────
  if (rr && rr.amount_variance !== null && rr.amount_variance !== 0) {
    const evIds = [
      findEvId('reconciliation_result', 'amount_variance'),
      findEvId('reconciliation_result', 'amount_razorpay'),
      findEvId('reconciliation_result', 'amount_merchant'),
    ].filter(Boolean);

    patterns.push({
      pattern_id: 'PATTERN_AMOUNT_MISMATCH',
      name: 'Net Credit Variance',
      severity: Math.abs(rr.amount_variance) > 1000 ? 'HIGH' : 'MEDIUM',
      evidence_ids: evIds,
      explanation: `Net Razorpay credited amount (${rr.amount_razorpay} paise) does not match merchant ledger expected amount (${rr.amount_merchant} paise), variance: ${rr.amount_variance} paise.`,
      weight: 20,
    });
  }

  // ── 4. PATTERN_MISSING_ORDER ──────────────────────────────────────────────
  if (exception.category === 'MISSING_ORDER' || (!mo && sr && sr.type === 'payment')) {
    const evIds = [
      findEvId('exception', 'category'),
      findEvId('settlement_record', 'entity_id'),
      findEvId('settlement_record', 'order_id'),
      ...evidence.filter(e => e.source === 'relationships' && e.field === 'PAYMENT_TO_MERCHANT_ORDER').map(e => e.id),
    ].filter(Boolean);

    patterns.push({
      pattern_id: 'PATTERN_MISSING_ORDER',
      name: 'Orphaned Settlement Payment',
      severity: 'HIGH',
      evidence_ids: evIds,
      explanation: `Payment ${sr ? sr.entity_id : 'unknown'} is present in settlement with credit ${sr ? sr.credit : 'unknown'} paise, but has no matching order in merchant system.`,
      weight: 30,
    });
  }

  // ── 5. PATTERN_MISSING_PAYMENT ────────────────────────────────────────────
  if (exception.category === 'MISSING_PAYMENT' || (mo && le && le.status === 'pending' && !sr)) {
    const evIds = [
      findEvId('exception', 'category'),
      findEvId('merchant_order', 'id'),
      findEvId('merchant_ledger', 'expected_amount'),
      ...evidence.filter(e => e.source === 'relationships' && e.field === 'PAYMENT_TO_SETTLEMENT_BATCH').map(e => e.id),
    ].filter(Boolean);

    patterns.push({
      pattern_id: 'PATTERN_MISSING_PAYMENT',
      name: 'Unsettled Merchant Order Past Cutoff',
      severity: 'HIGH',
      evidence_ids: evIds,
      explanation: `Merchant order ${mo ? mo.id : 'unknown'} is recorded in merchant records (${le ? le.expected_amount : 'unknown'} paise) but no settlement record has arrived after cutoff period.`,
      weight: 30,
    });
  }

  // ── 6. PATTERN_DUPLICATE_TRANSACTION ──────────────────────────────────────
  if (exception.category === 'DUPLICATE') {
    const evIds = [
      findEvId('exception', 'category'),
      findEvId('settlement_record', 'entity_id'),
      findEvId('settlement_record', 'order_id'),
      findEvId('settlement_record', 'amount'),
    ].filter(Boolean);

    patterns.push({
      pattern_id: 'PATTERN_DUPLICATE_TRANSACTION',
      name: 'Duplicate Settlement Record',
      severity: 'CRITICAL',
      evidence_ids: evIds,
      explanation: `Multiple settlement records identified sharing order_id ${sr ? sr.order_id : 'unknown'} and gross amount ${sr ? sr.amount : 'unknown'} paise within a short window.`,
      weight: 30,
    });
  }

  // ── 7. PATTERN_SETTLEMENT_TIMING_MISMATCH ─────────────────────────────────
  if (exception.category === 'TIMING_MISMATCH' || (refunds.length > 0 && sr && refunds.some(r => r.settlement_id !== sr.settlement_id))) {
    const crossBatchRefunds = refunds.filter(r => sr && r.settlement_id !== sr.settlement_id);
    const evIds = [
      findEvId('exception', 'category'),
      findEvId('settlement_record', 'settlement_id'),
      ...findEvIdsBySource('refund_records'),
    ].filter(Boolean);

    patterns.push({
      pattern_id: 'PATTERN_SETTLEMENT_TIMING_MISMATCH',
      name: 'Cross-Batch Refund Timing Asynchrony',
      severity: 'MEDIUM',
      evidence_ids: evIds,
      explanation: `Parent payment settled in batch ${sr ? sr.settlement_id : 'unknown'}, but ${crossBatchRefunds.length || refunds.length} associated refund(s) settled in separate settlement batch(es).`,
      weight: 25,
    });
  }

  // ── 8. PATTERN_ADJUSTMENT_NO_COUNTERPART ──────────────────────────────────
  if (sr && sr.type === 'adjustment') {
    const evIds = [
      findEvId('settlement_record', 'entity_id'),
      findEvId('settlement_record', 'type'),
      findEvId('settlement_record', 'credit'),
      findEvId('settlement_record', 'debit'),
    ].filter(Boolean);

    patterns.push({
      pattern_id: 'PATTERN_ADJUSTMENT_NO_COUNTERPART',
      name: 'Platform Fee / Operational Adjustment',
      severity: 'MEDIUM',
      evidence_ids: evIds,
      explanation: `Settlement record ${sr.entity_id} is a direct platform adjustment (credit: ${sr.credit || 0}, debit: ${sr.debit || 0} paise) originated by payment gateway without a standard checkout order.`,
      weight: 25,
    });
  }

  // ── 9. PATTERN_UNEXPLAINED_VARIANCE ───────────────────────────────────────
  if (exception.category === 'UNEXPLAINED') {
    const evIds = [
      findEvId('exception', 'category'),
      findEvId('exception', 'amount_at_risk'),
      findEvId('settlement_record', 'credit'),
      findEvId('reconciliation_result', 'amount_variance'),
    ].filter(Boolean);

    patterns.push({
      pattern_id: 'PATTERN_UNEXPLAINED_VARIANCE',
      name: 'Non-Conforming Settlement Variance',
      severity: 'HIGH',
      evidence_ids: evIds,
      explanation: `Settlement record exhibits an unexplained credit reduction of ${exception.amount_at_risk} paise that does not correspond to fee, tax, or refund deductions.`,
      weight: 25,
    });
  }

  // ── 10. PATTERN_BROKEN_RELATIONSHIP ───────────────────────────────────────
  const missingRels = relationships.filter(r => r.status === 'MISSING');
  if (missingRels.length > 0) {
    const evIds = evidence
      .filter(e => e.source === 'relationships' && e.value === 'MISSING')
      .map(e => e.id);

    patterns.push({
      pattern_id: 'PATTERN_BROKEN_RELATIONSHIP',
      name: 'Missing Entity Linkage',
      severity: missingRels.length > 1 ? 'HIGH' : 'MEDIUM',
      evidence_ids: evIds.length > 0 ? evIds : findEvIdsBySource('relationships'),
      explanation: `${missingRels.length} structural entity relationship(s) are missing (${missingRels.map(r => r.relationship).join(', ')}).`,
      weight: 20,
    });
  }

  return patterns;
}

module.exports = { detectPatterns };
