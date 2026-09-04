'use strict';
/**
 * src/investigation/caseBuilder.js
 *
 * Assembles a complete InvestigationCase for a given exception.
 *
 * An InvestigationCase is the input contract for both:
 *   (a) The AI investigator (Gemini)
 *   (b) The GET /api/investigations/:id endpoint
 *
 * All data is deterministic and pre-computed.
 * The AI layer receives this case and adds a natural-language analysis.
 *
 * IMPORTANT RULES:
 * - All monetary values are integer paise.
 * - Ground truth is NEVER included in the case (evaluation-only).
 * - All data sources are labelled (razorpay_test_mode | simulated | merchant_data | derived).
 * - The case is frozen — it does not mutate after construction.
 */

const { buildFinancialAnalysis } = require('./financialAnalysis');
const { buildTimeline }          = require('./timeline');
const { buildRelationships }     = require('./relationships');
const { getSuggestedActions }    = require('./suggestedActions');

/**
 * @typedef {Object} InvestigationCase
 * @property {string}   case_id              - exc.id (stable, re-producible)
 * @property {string}   exception_category   - exception.category
 * @property {number}   amount_at_risk        - integer paise
 * @property {string}   status               - 'open' | 'investigating' | 'resolved'
 * @property {Object}   exception            - Full exception record
 * @property {Object}   reconciliation_result - Full reconciliation result
 * @property {Object}   settlement_record    - Full settlement record (may be null)
 * @property {Object}   merchant_order       - Full merchant order (may be null)
 * @property {Object}   merchant_ledger      - Full merchant ledger entry (may be null)
 * @property {Array}    refund_records       - Array of related settlement refund records
 * @property {Object}   financial_analysis   - Structured financial breakdown
 * @property {Array}    timeline             - Sorted chronological events
 * @property {Array}    relationships        - Graph of entity relationships (incl. MISSING)
 * @property {Array}    suggested_actions    - Deterministic resolution steps
 * @property {Object}   data_sources         - Explicit data-source labelling
 * @property {string}   generated_at_iso     - ISO-8601 timestamp of case construction
 */

/**
 * Build an InvestigationCase from store data.
 *
 * @param {Object} params
 * @param {Object}   params.exception
 * @param {Object}   params.reconResult
 * @param {Object}   params.store  - full store object (for lookup)
 * @returns {InvestigationCase}
 */
function buildCase({ exception, reconResult, store }) {
  const settlementRecord = store.settlementRecords.find(
    sr => sr.entity_id === reconResult.settlement_entity_id,
  ) || null;

  const merchantOrder = reconResult.merchant_order_id
    ? store.merchantOrders.find(mo => mo.id === reconResult.merchant_order_id) || null
    : null;

  const merchantLedger = reconResult.merchant_ledger_id
    ? store.merchantLedger.find(le => le.id === reconResult.merchant_ledger_id) || null
    : null;

  const refundRecords = (reconResult.refund_entity_ids || [])
    .map(rid => store.settlementRecords.find(sr => sr.entity_id === rid))
    .filter(Boolean);

  const settlementBatches = store.settlementBatches || [];

  // ── Build analysis modules ─────────────────────────────────────────────────
  const financialAnalysis = buildFinancialAnalysis({
    reconResult,
    settlementRecord,
    merchantLedger,
    refundRecords,
  });
  // Inject amount_at_risk from the exception into the financial analysis
  financialAnalysis.amount_at_risk = exception.amount_at_risk;

  const timeline = buildTimeline({
    exception,
    reconResult,
    settlementRecord,
    merchantOrder,
    merchantLedger,
    refundRecords,
  });

  const relationships = buildRelationships({
    exception,
    reconResult,
    settlementRecord,
    merchantOrder,
    merchantLedger,
    refundRecords,
    settlementBatches,
  });

  const suggestedActions = getSuggestedActions({
    exception,
    reconResult,
    financialAnalysis,
  });

  // ── Data-source labelling ──────────────────────────────────────────────────
  const dataSources = {
    mode:              store.mode,
    data_source:       store.data_source,
    settlement_source: store.settlement_source,
    razorpay_side: {
      source:             store.data_source,
      settlement_status:  store.settlement_source,
      settlement_record:  settlementRecord,
      refund_records:     refundRecords,
    },
    merchant_side: {
      order:  merchantOrder,
      ledger: merchantLedger,
    },
    derived: {
      reconciliation_result: reconResult,
      exception,
    },
    simulation_note: store.settlement_source === 'simulated'
      ? 'Settlement records are simulated from real Razorpay Test Mode transactions because Razorpay Test Mode does not execute the production settlement pipeline.'
      : null,
  };

  const priorityInfo = computeCasePriority(exception, reconResult);

  const investigationCase = {
    id:                   exception.id,
    case_id:              exception.id,
    exception_category:   exception.category,
    amount_at_risk:       exception.amount_at_risk,
    priority:             priorityInfo.level,
    priority_info:        priorityInfo,
    status:               'open',
    exception,
    reconciliation_result: reconResult,
    settlement_record:    settlementRecord,
    merchant_order:       merchantOrder,
    merchant_ledger:      merchantLedger,
    refund_records:       refundRecords,
    financial_analysis:   financialAnalysis,
    timeline,
    relationships,
    suggested_actions:    suggestedActions,
    data_sources:         dataSources,
    generated_at_iso:     new Date().toISOString(),
  };

  return investigationCase;
}

/**
 * Deterministically compute investigation priority based on category and financial exposure.
 *
 * @param {Object} exception
 * @param {Object} [reconResult]
 * @returns {{ level: 'HIGH'|'MEDIUM'|'LOW', reason: string }}
 */
function computeCasePriority(exception, reconResult) {
  if (!exception) return { level: 'MEDIUM', reason: 'Standard exception' };

  const cat = exception.category || 'UNEXPLAINED';
  const risk = exception.amount_at_risk || 0;

  // Immediate operational hold or unexplained balance break
  if (cat === 'DUPLICATE' || cat === 'UNEXPLAINED') {
    return {
      level: 'HIGH',
      reason: cat === 'DUPLICATE'
        ? 'Duplicate settlement requires immediate disbursement hold'
        : 'Unexplained discrepancy on reconciliation balance',
    };
  }

  // Contract fee/tax variance directly causing settlement shortfall
  if (cat === 'FEE_TAX_VARIANCE') {
    const isMaterial = risk >= 2000;
    return {
      level: isMaterial ? 'HIGH' : 'MEDIUM',
      reason: isMaterial
        ? 'Confirmed gateway fee/tax variance impacting net settlement'
        : 'Fee discrepancy within tolerance threshold',
    };
  }

  // Missing payments or missing merchant orders
  if (cat === 'MISSING_PAYMENT' || cat === 'MISSING_ORDER') {
    return {
      level: risk >= 50000 ? 'HIGH' : 'MEDIUM',
      reason: risk >= 50000
        ? 'High monetary exposure on missing record'
        : 'Missing transaction record pending cycle clearance',
    };
  }

  // Timing mismatch (cross-period batch split) or standard adjustment
  if (cat === 'TIMING_MISMATCH' || cat === 'ADJUSTMENT' || cat === 'PARTIAL_REFUND') {
    return {
      level: 'LOW',
      reason: cat === 'TIMING_MISMATCH'
        ? 'Timing difference balances across settlement batches'
        : 'Routine ledger adjustment posting',
    };
  }

  return {
    level: risk >= 50000 ? 'HIGH' : (risk >= 10000 ? 'MEDIUM' : 'LOW'),
    reason: `${cat} with ${risk} paise exposure`,
  };
}

module.exports = { buildCase, computeCasePriority };

