'use strict';
/**
 * src/investigation/ai/evidence.js
 *
 * Evidence Engine — converts an InvestigationCase into a structured evidence
 * package that every downstream AI component reasons over.
 *
 * RULES:
 * - Every evidence item traces back to a named field on a named source record.
 * - No values are invented or inferred here — this is pure extraction.
 * - All monetary values remain integer paise.
 * - Evidence items are classified as FACT only (inference happens in reasoning.js).
 *
 * Evidence item schema:
 * {
 *   id:         string   — stable identifier e.g. "ev_001"
 *   source:     string   — 'settlement_record' | 'merchant_order' | 'merchant_ledger'
 *                          | 'reconciliation_result' | 'refund_records'
 *                          | 'financial_analysis' | 'timeline' | 'relationships'
 *   field:      string   — the field name within the source
 *   value:      any      — the raw field value (never modified)
 *   label:      string   — human-readable label for display
 *   type:       'FACT'   — always FACT at extraction time
 *   importance: 'HIGH' | 'MEDIUM' | 'LOW'
 *   unit:       string | null   — 'paise' for monetary fields, else null
 * }
 */

let _seq = 0;
function nextId() { return `ev_${String(++_seq).padStart(3, '0')}`; }

/**
 * Reset the sequence counter (important for deterministic tests).
 */
function resetSeq() { _seq = 0; }

/**
 * Create one evidence item.
 */
function ev(source, field, value, label, importance = 'MEDIUM', unit = null) {
  if (value === null || value === undefined) return null;
  return { id: nextId(), source, field, value, label, type: 'FACT', importance, unit };
}

/**
 * Extract all structured evidence from an InvestigationCase.
 *
 * @param {Object} investigationCase — built by caseBuilder.buildCase()
 * @returns {Object[]} Array of evidence items
 */
function extractEvidence(investigationCase) {
  resetSeq();
  const items = [];

  const add = (item) => { if (item) items.push(item); };

  const {
    exception,
    reconciliation_result: rr,
    settlement_record:     sr,
    merchant_order:        mo,
    merchant_ledger:       le,
    refund_records:        refunds = [],
    financial_analysis:    fa,
    timeline,
    relationships,
  } = investigationCase;

  // ── Exception ─────────────────────────────────────────────────────────────
  add(ev('exception', 'category',       exception.category,       'Exception category',       'HIGH'));
  add(ev('exception', 'amount_at_risk', exception.amount_at_risk, 'Amount at risk (paise)',    'HIGH', 'paise'));
  add(ev('exception', 'description',   exception.description,    'Exception description',    'MEDIUM'));

  // ── Reconciliation Result ─────────────────────────────────────────────────
  if (rr) {
    add(ev('reconciliation_result', 'status',            rr.status,            'Reconciliation status',        'HIGH'));
    add(ev('reconciliation_result', 'exception_category',rr.exception_category,'Engine exception category',    'HIGH'));
    add(ev('reconciliation_result', 'reason',            rr.reason,            'Engine determination reason',  'HIGH'));
    add(ev('reconciliation_result', 'amount_razorpay',   rr.amount_razorpay,   'Razorpay credited amount',     'HIGH', 'paise'));
    add(ev('reconciliation_result', 'amount_merchant',   rr.amount_merchant,   'Merchant expected amount',     'HIGH', 'paise'));
    add(ev('reconciliation_result', 'amount_variance',   rr.amount_variance,   'Amount variance',              'HIGH', 'paise'));
    add(ev('reconciliation_result', 'fee_expected',      rr.fee_expected,      'Expected platform fee',        'MEDIUM', 'paise'));
    add(ev('reconciliation_result', 'fee_actual',        rr.fee_actual,        'Actual platform fee charged',  'MEDIUM', 'paise'));
    add(ev('reconciliation_result', 'tax_expected',      rr.tax_expected,      'Expected GST on fee',          'MEDIUM', 'paise'));
    add(ev('reconciliation_result', 'tax_actual',        rr.tax_actual,        'Actual GST charged',           'MEDIUM', 'paise'));
  }

  // ── Settlement Record ─────────────────────────────────────────────────────
  if (sr) {
    add(ev('settlement_record', 'entity_id',     sr.entity_id,     'Settlement entity ID',        'HIGH'));
    add(ev('settlement_record', 'type',          sr.type,          'Settlement record type',      'HIGH'));
    add(ev('settlement_record', 'order_id',      sr.order_id,      'Razorpay order ID',           'HIGH'));
    add(ev('settlement_record', 'amount',        sr.amount,        'Gross transaction amount',    'HIGH', 'paise'));
    add(ev('settlement_record', 'credit',        sr.credit,        'Net credit to merchant',      'HIGH', 'paise'));
    add(ev('settlement_record', 'debit',         sr.debit,         'Debit from merchant',         'HIGH', 'paise'));
    add(ev('settlement_record', 'fee',           sr.fee,           'Platform fee charged',        'MEDIUM', 'paise'));
    add(ev('settlement_record', 'tax',           sr.tax,           'GST charged on fee',          'MEDIUM', 'paise'));
    add(ev('settlement_record', 'settlement_id', sr.settlement_id, 'Settlement batch ID',         'MEDIUM'));
    add(ev('settlement_record', 'settlement_utr',sr.settlement_utr,'Settlement UTR',              'LOW'));
    add(ev('settlement_record', 'currency',      sr.currency,      'Currency',                    'LOW'));
    add(ev('settlement_record', 'method',        sr.method,        'Payment method',              'LOW'));
    add(ev('settlement_record', 'created_at',    sr.created_at,    'Settlement record created at','LOW'));
    add(ev('settlement_record', 'settled_at',    sr.settled_at,    'Settled at timestamp',        'LOW'));
  }

  // ── Merchant Order ────────────────────────────────────────────────────────
  if (mo) {
    add(ev('merchant_order', 'id',                mo.id,                'Merchant order ID',           'HIGH'));
    add(ev('merchant_order', 'razorpay_order_id', mo.razorpay_order_id, 'Razorpay order ID (merchant)','HIGH'));
    add(ev('merchant_order', 'amount',            mo.amount,            'Merchant order amount',       'HIGH', 'paise'));
    add(ev('merchant_order', 'status',            mo.status,            'Merchant order status',       'HIGH'));
    add(ev('merchant_order', 'currency',          mo.currency,          'Currency (merchant)',         'LOW'));
    add(ev('merchant_order', 'created_at',        mo.created_at,        'Merchant order created at',   'LOW'));
  }

  // ── Merchant Ledger ───────────────────────────────────────────────────────
  if (le) {
    add(ev('merchant_ledger', 'id',              le.id,              'Ledger entry ID',             'MEDIUM'));
    add(ev('merchant_ledger', 'expected_amount', le.expected_amount, 'Ledger expected amount',      'HIGH', 'paise'));
    add(ev('merchant_ledger', 'posted_amount',   le.posted_amount,   'Ledger posted amount',        'HIGH', 'paise'));
    add(ev('merchant_ledger', 'status',          le.status,          'Ledger entry status',         'HIGH'));
    add(ev('merchant_ledger', 'posted_at',       le.posted_at,       'Ledger posting timestamp',    'LOW'));
  }

  // ── Refund Records ────────────────────────────────────────────────────────
  for (let i = 0; i < refunds.length; i++) {
    const rfnd = refunds[i];
    add(ev('refund_records', `[${i}].entity_id`,    rfnd.entity_id,    `Refund ${i + 1} entity ID`,       'MEDIUM'));
    add(ev('refund_records', `[${i}].amount`,        rfnd.amount,       `Refund ${i + 1} amount`,          'HIGH', 'paise'));
    add(ev('refund_records', `[${i}].payment_id`,    rfnd.payment_id,   `Refund ${i + 1} parent payment`,  'HIGH'));
    add(ev('refund_records', `[${i}].settlement_id`, rfnd.settlement_id,`Refund ${i + 1} settlement batch`,'MEDIUM'));
  }

  // ── Financial Analysis ────────────────────────────────────────────────────
  if (fa) {
    add(ev('financial_analysis', 'fee_variance',      fa.fee_variance,      'Fee variance (actual − expected)', 'HIGH', 'paise'));
    add(ev('financial_analysis', 'tax_variance',      fa.tax_variance,      'Tax variance (actual − expected)', 'HIGH', 'paise'));
    add(ev('financial_analysis', 'merchant_variance', fa.merchant_variance, 'Merchant credit variance',          'HIGH', 'paise'));
    add(ev('financial_analysis', 'total_refund_amount',fa.total_refund_amount,'Total refunds',                  'MEDIUM', 'paise'));
    add(ev('financial_analysis', 'net_after_refunds', fa.net_after_refunds, 'Net after refunds',                'MEDIUM', 'paise'));
  }

  // ── Timeline summary ─────────────────────────────────────────────────────
  if (timeline && timeline.length > 0) {
    add(ev('timeline', 'event_count', timeline.length, 'Number of timeline events', 'LOW'));
    const sources = [...new Set(timeline.map(e => e.source))];
    add(ev('timeline', 'data_sources', sources.join(', '), 'Timeline data sources', 'LOW'));

    // Flag simulated events explicitly
    const simulatedCount = timeline.filter(e => e.source === 'simulated').length;
    if (simulatedCount > 0) {
      add(ev('timeline', 'simulated_event_count', simulatedCount, 'Number of simulated settlement events', 'MEDIUM'));
    }
  }

  // ── Relationships summary ─────────────────────────────────────────────────
  if (relationships && relationships.length > 0) {
    const missing = relationships.filter(r => r.status === 'MISSING');
    if (missing.length > 0) {
      add(ev('relationships', 'missing_relationship_count', missing.length, 'Number of MISSING entity relationships', 'HIGH'));
      // Each missing relationship is individually evidenced
      for (const rel of missing) {
        add(ev('relationships', rel.relationship, 'MISSING', `Missing: ${rel.relationship}`, 'HIGH'));
      }
    }
  }

  return items;
}

module.exports = { extractEvidence };
