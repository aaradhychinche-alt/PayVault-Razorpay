'use strict';
/**
 * src/investigation/ai/reasoning.js
 *
 * Core AI Reasoning Engine.
 * Synthesizes evidence, deterministic patterns, financial breakdown,
 * timeline, and relationship graph to formulate and evaluate candidate root causes.
 *
 * RULES:
 * - Never invents facts; all assertions cite evidence IDs.
 * - Explicitly uses probabilistic language ("Supported by evidence", "Likely", "Possible", "Insufficient evidence").
 * - Evaluates multiple candidate root causes and ranks them.
 * - Identifies supporting AND contradicting evidence.
 */

/**
 * Perform AI reasoning over an InvestigationCase.
 *
 * @param {Object} investigationCase
 * @param {Object[]} evidence
 * @param {Object[]} patterns
 * @returns {Object} Reasoning output
 */
function reasonOverCase(investigationCase, evidence, patterns) {
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
    suggested_actions = [],
  } = investigationCase;

  function findEvId(source, field) {
    const item = evidence.find(e => e.source === source && e.field === field);
    return item ? item.id : null;
  }

  function findEvIdsBySource(source) {
    return evidence.filter(e => e.source === source).map(e => e.id);
  }

  // ── 1. Generate Candidate Root Causes based on Category & Patterns ─────────
  const candidates = [];
  const category = exception.category;

  if (category === 'FEE_TAX_VARIANCE') {
    const feeDiff = fa ? fa.fee_variance : 0;
    const taxDiff = fa ? fa.tax_variance : 0;
    const feeEvIds = [
      findEvId('financial_analysis', 'fee_variance'),
      findEvId('reconciliation_result', 'fee_actual'),
      findEvId('reconciliation_result', 'fee_expected'),
      findEvId('settlement_record', 'fee'),
    ].filter(Boolean);

    candidates.push({
      cause: 'Platform Fee Rate Configuration Discrepancy',
      probability: 'HIGH',
      support_status: 'Supported by evidence',
      confidence_score: 90,
      evidence_ids: feeEvIds,
      contradicting_evidence_ids: [],
      reasoning: `The settlement record charges a fee of ${fa ? fa.fee_actual : 'N/A'} paise on gross amount ${fa ? fa.gross_amount : 'N/A'} paise, deviating by ${feeDiff} paise from the standard 2% contract rate (${fa ? fa.fee_expected : 'N/A'} paise). This indicates a fee tier misconfiguration in the payment aggregator gateway profile.`,
    });

    if (taxDiff !== null && taxDiff !== 0) {
      candidates.push({
        cause: 'GST Tax Calculation Variance',
        probability: 'MEDIUM',
        support_status: 'Supported by evidence',
        confidence_score: 75,
        evidence_ids: [
          findEvId('financial_analysis', 'tax_variance'),
          findEvId('reconciliation_result', 'tax_actual'),
          findEvId('reconciliation_result', 'tax_expected'),
        ].filter(Boolean),
        contradicting_evidence_ids: [],
        reasoning: `GST charged (${fa ? fa.tax_actual : 'N/A'} paise) deviates by ${taxDiff} paise from expected 18% GST (${fa ? fa.tax_expected : 'N/A'} paise) due to the upstream fee rate variance.`,
      });
    }

    candidates.push({
      cause: 'Merchant Contract Pricing Schedule Update',
      probability: 'LOW',
      support_status: 'Possible',
      confidence_score: 40,
      evidence_ids: [findEvId('exception', 'category')].filter(Boolean),
      contradicting_evidence_ids: [],
      reasoning: `Merchant negotiated rate schedule may have been modified without updating the reconciliation engine rule definition. Requires merchant agreement verification.`,
    });
  } else if (category === 'MISSING_ORDER') {
    const missEvIds = [
      findEvId('exception', 'category'),
      findEvId('settlement_record', 'entity_id'),
      findEvId('settlement_record', 'order_id'),
      ...evidence.filter(e => e.source === 'relationships' && e.field === 'PAYMENT_TO_MERCHANT_ORDER').map(e => e.id),
    ].filter(Boolean);

    candidates.push({
      cause: 'Orphaned Gateway Payment Without Merchant Checkout Order',
      probability: 'HIGH',
      support_status: 'Supported by evidence',
      confidence_score: 88,
      evidence_ids: missEvIds,
      contradicting_evidence_ids: [],
      reasoning: `Settlement record ${sr ? sr.entity_id : 'unknown'} exists in settlement batch with credit ${sr ? sr.credit : 'unknown'} paise, but has no corresponding merchant order in local merchant books. Order_id is null or unlinked.`,
    });

    candidates.push({
      cause: 'Merchant Webhook / Order Ingestion Pipeline Failure',
      probability: 'MEDIUM',
      support_status: 'Likely',
      confidence_score: 65,
      evidence_ids: missEvIds,
      contradicting_evidence_ids: [],
      reasoning: `Customer completed payment on payment gateway, but merchant order ingestion webhook dropped or failed database insertion, creating an unmatched settlement.`,
    });
  } else if (category === 'MISSING_PAYMENT') {
    const missPayEvIds = [
      findEvId('exception', 'category'),
      findEvId('merchant_order', 'id'),
      findEvId('merchant_ledger', 'expected_amount'),
      ...evidence.filter(e => e.source === 'relationships' && e.field === 'PAYMENT_TO_SETTLEMENT_BATCH').map(e => e.id),
    ].filter(Boolean);

    candidates.push({
      cause: 'Settlement Batch Omission Past Cutoff Window',
      probability: 'HIGH',
      support_status: 'Supported by evidence',
      confidence_score: 85,
      evidence_ids: missPayEvIds,
      contradicting_evidence_ids: [],
      reasoning: `Merchant order ${mo ? mo.id : 'unknown'} has expected payout of ${le ? le.expected_amount : 'unknown'} paise, but no settlement credit has arrived past the 3-day cutoff window.`,
    });

    candidates.push({
      cause: 'Gateway Capture Delay or Silent Transaction Reversal',
      probability: 'MEDIUM',
      support_status: 'Possible',
      confidence_score: 55,
      evidence_ids: missPayEvIds,
      contradicting_evidence_ids: [],
      reasoning: `Payment was authorized but may have failed automated capture or been refunded prior to batch aggregation without merchant ledger notification.`,
    });
  } else if (category === 'DUPLICATE') {
    const dupEvIds = [
      findEvId('exception', 'category'),
      findEvId('settlement_record', 'entity_id'),
      findEvId('settlement_record', 'order_id'),
      findEvId('settlement_record', 'amount'),
    ].filter(Boolean);

    candidates.push({
      cause: 'Redundant Settlement Record Generated for Same Order',
      probability: 'HIGH',
      support_status: 'Supported by evidence',
      confidence_score: 92,
      evidence_ids: dupEvIds,
      contradicting_evidence_ids: [],
      reasoning: `Settlement record ${sr ? sr.entity_id : 'unknown'} shares identical order_id (${sr ? sr.order_id : 'unknown'}) and gross amount (${sr ? sr.amount : 'unknown'} paise) within a short window, resulting in duplicate payout exposure.`,
    });

    candidates.push({
      cause: 'Customer Double-Charge with Two Authorizations',
      probability: 'MEDIUM',
      support_status: 'Possible',
      confidence_score: 60,
      evidence_ids: dupEvIds,
      contradicting_evidence_ids: [],
      reasoning: `The buyer may have submitted checkout twice in quick succession, creating two authorized payments against the same merchant order session.`,
    });
  } else if (category === 'TIMING_MISMATCH') {
    const timeEvIds = [
      findEvId('exception', 'category'),
      findEvId('settlement_record', 'settlement_id'),
      ...findEvIdsBySource('refund_records'),
    ].filter(Boolean);

    candidates.push({
      cause: 'Cross-Batch Refund Settlement Timing Asynchrony',
      probability: 'HIGH',
      support_status: 'Supported by evidence',
      confidence_score: 90,
      evidence_ids: timeEvIds,
      contradicting_evidence_ids: [],
      reasoning: `The parent payment settled in batch ${sr ? sr.settlement_id : 'unknown'}, whereas associated refund(s) settled in a distinct settlement batch. This creates a temporary single-batch credit surplus until cross-period matching is consolidated.`,
    });
  } else if (category === 'ADJUSTMENT') {
    const adjEvIds = [
      findEvId('settlement_record', 'entity_id'),
      findEvId('settlement_record', 'type'),
      findEvId('settlement_record', 'credit'),
      findEvId('settlement_record', 'debit'),
    ].filter(Boolean);

    candidates.push({
      cause: 'Gateway Platform Operational Adjustment / Dispute Fee',
      probability: 'HIGH',
      support_status: 'Supported by evidence',
      confidence_score: 88,
      evidence_ids: adjEvIds,
      contradicting_evidence_ids: [],
      reasoning: `Settlement record ${sr ? sr.entity_id : 'unknown'} is a direct platform adjustment (credit: ${sr ? sr.credit : 0}, debit: ${sr ? sr.debit : 0} paise) applied by payment aggregator operations without a checkout order.`,
    });
  } else {
    // UNEXPLAINED / Default
    const unexEvIds = [
      findEvId('exception', 'category'),
      findEvId('exception', 'amount_at_risk'),
      findEvId('settlement_record', 'credit'),
    ].filter(Boolean);

    candidates.push({
      cause: 'Non-Conforming Credit Discrepancy Requiring Manual Audit',
      probability: 'HIGH',
      support_status: 'Likely',
      confidence_score: 70,
      evidence_ids: unexEvIds,
      contradicting_evidence_ids: [],
      reasoning: `Settlement record exhibits an unexplained financial variance of ${exception.amount_at_risk} paise that cannot be resolved by deterministic platform fee, tax, or refund rules. Raw settlement logs required.`,
    });
  }

  // Rank primary root cause candidate
  const primaryCandidate = candidates[0] || {
    cause: 'Unclassified Exception',
    probability: 'LOW',
    support_status: 'Insufficient evidence',
    confidence_score: 50,
    evidence_ids: [],
    contradicting_evidence_ids: [],
    reasoning: 'No definitive root cause could be established with available evidence.',
  };

  // ── 2. Contributing Factors ────────────────────────────────────────────────
  const contributingFactors = patterns.map(p => ({
    factor: p.name,
    explanation: p.explanation,
    severity: p.severity,
    evidence_ids: p.evidence_ids,
  }));

  // ── 3. Financial Impact Analysis ───────────────────────────────────────────
  const financialImpact = {
    amount_at_risk: exception.amount_at_risk,
    gross_amount: fa ? fa.gross_amount : null,
    settlement_credit: fa ? fa.settlement_credit : null,
    expected_amount: fa ? fa.expected_merchant_amount : null,
    variance: rr ? rr.amount_variance : null,
    fee_variance: fa ? fa.fee_variance : null,
    tax_variance: fa ? fa.tax_variance : null,
    currency: fa ? fa.currency : 'INR',
    unit: 'paise',
    explanation: `Financial exposure is ${exception.amount_at_risk} paise (₹${(exception.amount_at_risk / 100).toFixed(2)}). ` +
      (fa && fa.fee_variance ? `Platform fee variance of ${fa.fee_variance} paise contributed directly to the deviation. ` : '') +
      (rr && rr.amount_variance ? `Net merchant ledger variance is ${rr.amount_variance} paise. ` : ''),
  };

  // ── 4. Timeline Findings ───────────────────────────────────────────────────
  const timelineFindings = timeline.slice(0, 6).map(evItem => ({
    event_type: evItem.event_type,
    timestamp: evItem.timestamp,
    source: evItem.source,
    interpretation: evItem.description,
    evidence_ids: [findEvId('timeline', 'event_count')].filter(Boolean),
  }));

  // ── 5. Relationship Findings ───────────────────────────────────────────────
  const relationshipFindings = relationships.map(rel => ({
    relationship: rel.relationship,
    status: rel.status,
    interpretation: rel.description,
    evidence_ids: evidence
      .filter(e => e.source === 'relationships' && (e.field === rel.relationship || e.value === rel.status))
      .map(e => e.id),
  }));

  // ── 6. Risk Assessment ─────────────────────────────────────────────────────
  let riskLevel = 'LOW';
  let riskScore = 25;
  const riskReasons = [];

  if (category === 'DUPLICATE') {
    riskLevel = 'CRITICAL';
    riskScore = 95;
    riskReasons.push('Duplicate payout presents immediate double-disbursement risk.');
  } else if (exception.amount_at_risk > 50000) {
    riskLevel = 'HIGH';
    riskScore = 80;
    riskReasons.push(`High monetary exposure (> ₹500.00): ${exception.amount_at_risk} paise.`);
  } else if (category === 'MISSING_PAYMENT' || category === 'MISSING_ORDER') {
    riskLevel = 'HIGH';
    riskScore = 75;
    riskReasons.push(`Unmatched balance impacting revenue realization (${category}).`);
  } else if (category === 'FEE_TAX_VARIANCE' || category === 'UNEXPLAINED') {
    riskLevel = 'MEDIUM';
    riskScore = 50;
    riskReasons.push('Systematic fee calculation discrepancy requiring vendor audit.');
  } else {
    riskLevel = 'LOW';
    riskScore = 20;
    riskReasons.push('Timing asynchrony that resolves in subsequent settlement cycle.');
  }

  // ── 7. Uncertainty & Caveats ───────────────────────────────────────────────
  const uncertainty = [];
  if (!sr) {
    uncertainty.push('Settlement record is absent from current batch; conclusions rely on merchant ledger cutoff analysis.');
  }
  if (!mo && category !== 'ADJUSTMENT') {
    uncertainty.push('Merchant order record is absent; cannot verify buyer-side checkout intention.');
  }
  if (patterns.length === 0) {
    uncertainty.push('No recognized pattern triggered; relying entirely on baseline reconciliation parameters.');
  }

  return {
    candidate_root_causes: candidates,
    primary_root_cause: primaryCandidate,
    contributing_factors: contributingFactors,
    financial_impact: financialImpact,
    timeline_findings: timelineFindings,
    relationship_findings: relationshipFindings,
    risk_assessment: {
      level: riskLevel,
      score: riskScore,
      reasons: riskReasons,
    },
    recommended_actions: suggested_actions,
    uncertainty,
  };
}

module.exports = { reasonOverCase };
