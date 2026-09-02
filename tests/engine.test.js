'use strict';
/**
 * tests/engine.test.js
 *
 * Comprehensive tests for the reconciliation engine.
 * Covers all 9 required exception scenarios plus edge cases.
 */

const { generateDataset, calcFee } = require('../src/data/generator');
const { reconcile }                = require('../src/engine/reconcile');
const {
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
} = require('../src/engine/rules');
const config = require('../src/engine/config');
const { createSettlementRecord }    = require('../src/models/settlementRecord');
const { createMerchantOrder }       = require('../src/models/merchantOrder');
const { createMerchantLedger }      = require('../src/models/merchantLedger');
const { createReconciliationResult, RECON_STATUS } = require('../src/models/reconciliationResult');
const { createException, EXCEPTION_CATEGORIES }    = require('../src/models/exception');

// ── Helper factories ──────────────────────────────────────────────────────────

const BASE_TIME = 1753920000; // 2026-08-01

function makeSR(overrides = {}) {
  const amount = overrides.amount ?? 100000;
  const { fee, tax, net } = calcFee(amount);
  return createSettlementRecord({
    entity_id:   `pay_TEST${Math.random().toString(36).slice(2, 10)}`,
    type:        'payment',
    debit:       0,
    credit:      net,
    amount,
    fee,
    tax,
    settled:     true,
    created_at:  BASE_TIME,
    settled_at:  BASE_TIME + 86400 * 7,
    settlement_id:  'setl_TESTBATCH',
    settlement_utr: '1753920000abcdef',
    order_id:    'order_TESTORDER1',
    order_receipt: 'rcpt_1',
    method:      'card',
    ...overrides,
  });
}

function makeMO(overrides = {}) {
  return createMerchantOrder({
    id:                'mo_TEST001',
    razorpay_order_id: 'order_TESTORDER1',
    amount:            100000,
    created_at:        BASE_TIME,
    status:            'paid',
    ...overrides,
  });
}

function makeLE(overrides = {}) {
  const { net } = calcFee(100000);
  return createMerchantLedger({
    id:                'ledger_TEST001',
    merchant_order_id: 'mo_TEST001',
    expected_amount:   net,
    posted_amount:     net,
    status:            'posted',
    posted_at:         BASE_TIME + 86400 * 7,
    ...overrides,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// § PAISE / MATH UTILITIES
// ════════════════════════════════════════════════════════════════════════════

describe('Money utilities', () => {
  test('paiseDiff returns absolute difference', () => {
    expect(paiseDiff(1000, 900)).toBe(100);
    expect(paiseDiff(900, 1000)).toBe(100);
    expect(paiseDiff(500, 500)).toBe(0);
  });

  test('withinAmountTolerance respects config tolerance', () => {
    const tol = config.AMOUNT_TOLERANCE_PAISE;
    expect(withinAmountTolerance(1000, 1000)).toBe(true);
    expect(withinAmountTolerance(1000, 1000 + tol)).toBe(true);
    expect(withinAmountTolerance(1000, 1000 + tol + 1)).toBe(false);
  });

  test('withinFeeTaxTolerance respects config tolerance', () => {
    const tol = config.FEE_TAX_TOLERANCE_PAISE;
    expect(withinFeeTaxTolerance(2000, 2000 + tol)).toBe(true);
    expect(withinFeeTaxTolerance(2000, 2000 + tol + 1)).toBe(false);
  });

  test('calcFee returns integer paise values', () => {
    const { fee, tax, net } = calcFee(100000);
    expect(Number.isInteger(fee)).toBe(true);
    expect(Number.isInteger(tax)).toBe(true);
    expect(Number.isInteger(net)).toBe(true);
    expect(fee + tax + net).toBe(100000);
  });

  test('calcFee: ₹500 (50000 paise) → correct fee and tax', () => {
    const { fee, tax, net } = calcFee(50000);
    expect(fee).toBe(1000);        // 2% of 50000
    expect(tax).toBe(180);         // 18% of 1000
    expect(net).toBe(48820);       // 50000 - 1000 - 180
  });

  test('calcFee: rounding is always integer', () => {
    // Use an amount that would produce a fractional fee
    const { fee, tax, net } = calcFee(33333);
    expect(Number.isInteger(fee)).toBe(true);
    expect(Number.isInteger(tax)).toBe(true);
    expect(Number.isInteger(net)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// § MODEL VALIDATION
// ════════════════════════════════════════════════════════════════════════════

describe('Model validation', () => {
  test('SettlementRecord rejects float monetary values', () => {
    expect(() => makeSR({ fee: 1999.5 })).toThrow(/integer/);
  });

  test('SettlementRecord rejects missing entity_id', () => {
    expect(() => makeSR({ entity_id: '' })).toThrow(/entity_id/);
  });

  test('MerchantOrder rejects float amount', () => {
    expect(() => makeMO({ amount: 1000.5 })).toThrow(/integer/);
  });

  test('MerchantLedger rejects float expected_amount', () => {
    expect(() => makeLE({ expected_amount: 999.1 })).toThrow(/integer/);
  });

  test('Exception rejects unknown category', () => {
    expect(() => createException({
      id: 'exc_001',
      reconciliation_result_id: 'recon_001',
      category: 'INVALID_CATEGORY',
      amount_at_risk: 1000,
      created_at: BASE_TIME,
    })).toThrow(/unknown category/);
  });

  test('Exception rejects float amount_at_risk', () => {
    expect(() => createException({
      id: 'exc_001',
      reconciliation_result_id: 'recon_001',
      category: 'MISSING_ORDER',
      amount_at_risk: 1000.5,
      created_at: BASE_TIME,
    })).toThrow(/integer/);
  });

  test('ReconciliationResult rejects invalid status', () => {
    expect(() => createReconciliationResult({
      id: 'r1',
      status: 'WRONG',
      reason: 'test',
      created_at: BASE_TIME,
      settlement_entity_id: 'pay_xxx',
    })).toThrow(/invalid status/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// § SCENARIO 1 — CLEAN MATCH
// ════════════════════════════════════════════════════════════════════════════

describe('Scenario: CLEAN_MATCH', () => {
  test('ruleMatched fires when amounts agree within tolerance', () => {
    const sr = makeSR();
    const mo = makeMO();
    const le = makeLE();
    const result = ruleMatched({ sr, merchantOrder: mo, ledgerEntry: le });
    expect(result).not.toBeNull();
    expect(result.status).toBe('MATCHED');
    expect(result.category).toBe('MATCHED');
  });

  test('ruleMatched does not fire without merchantOrder', () => {
    const sr = makeSR();
    const result = ruleMatched({ sr, merchantOrder: null, ledgerEntry: null });
    expect(result).toBeNull();
  });

  test('ruleMatched does not fire for refund type', () => {
    const sr = makeSR({ type: 'refund', debit: 100000, credit: 0 });
    const result = ruleMatched({ sr, merchantOrder: makeMO(), ledgerEntry: makeLE() });
    expect(result).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// § SCENARIO 2 — PARTIAL REFUND
// ════════════════════════════════════════════════════════════════════════════

describe('Scenario: PARTIAL_REFUND', () => {
  test('Partial refund record is type=refund with correct debit', () => {
    const refundAmount = 30000;
    const sr = createSettlementRecord({
      entity_id:   'rfnd_PARTIAL001',
      type:        'refund',
      debit:       refundAmount,
      credit:      0,
      amount:      refundAmount,
      fee:         0,
      tax:         0,
      settled:     true,
      created_at:  BASE_TIME,
      settled_at:  BASE_TIME + 86400,
      settlement_id: 'setl_B1',
      order_id:    'order_TESTORDER1',
      payment_id:  'pay_PARENT001',
    });
    expect(sr.type).toBe('refund');
    expect(sr.debit).toBe(refundAmount);
    expect(sr.credit).toBe(0);
    expect(sr.payment_id).toBe('pay_PARENT001');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// § SCENARIO 3 — TIMING MISMATCH
// ════════════════════════════════════════════════════════════════════════════

describe('Scenario: TIMING_MISMATCH', () => {
  test('ruleTimingMismatch fires when refund is in a different settlement batch', () => {
    const sr = makeSR({ entity_id: 'pay_TIMING001', settlement_id: 'setl_BATCH1' });
    const refund = createSettlementRecord({
      entity_id:     'rfnd_TIMING001',
      type:          'refund',
      debit:         100000,
      credit:        0,
      amount:        100000,
      fee:           0,
      tax:           0,
      settled:       true,
      created_at:    BASE_TIME + 86400 * 10,
      settled_at:    BASE_TIME + 86400 * 21,
      settlement_id: 'setl_BATCH3', // ← different batch
      payment_id:    'pay_TIMING001',
    });
    const result = ruleTimingMismatch({ sr, relatedRefunds: [refund] });
    expect(result).not.toBeNull();
    expect(result.category).toBe('TIMING_MISMATCH');
    expect(result.status).toBe('EXCEPTION');
  });

  test('ruleTimingMismatch does NOT fire when refund is in same batch', () => {
    const sr = makeSR({ entity_id: 'pay_TIMING002', settlement_id: 'setl_BATCH1' });
    const refund = createSettlementRecord({
      entity_id:     'rfnd_TIMING002',
      type:          'refund',
      debit:         100000,
      credit:        0,
      amount:        100000,
      fee:           0,
      tax:           0,
      settled:       true,
      created_at:    BASE_TIME + 86400,
      settled_at:    BASE_TIME + 86400 * 7,
      settlement_id: 'setl_BATCH1', // ← same batch
      payment_id:    'pay_TIMING002',
    });
    const result = ruleTimingMismatch({ sr, relatedRefunds: [refund] });
    expect(result).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// § SCENARIO 4 — FEE_TAX_VARIANCE
// ════════════════════════════════════════════════════════════════════════════

describe('Scenario: FEE_TAX_VARIANCE', () => {
  test('ruleFeeVariance fires when fee exceeds tolerance', () => {
    const amount  = 100000;
    const { fee: correctFee } = calcExpectedFee(amount);
    // Add 5000 paise variance — well above 100 paise tolerance
    const wrongFee = correctFee + 5000;
    const sr = makeSR({ amount, fee: wrongFee, credit: amount - wrongFee - Math.round(wrongFee * 0.18) });
    const result = ruleFeeVariance({ sr });
    expect(result).not.toBeNull();
    expect(result.category).toBe('FEE_TAX_VARIANCE');
    expect(result.status).toBe('EXCEPTION');
  });

  test('ruleFeeVariance does NOT fire within tolerance', () => {
    const amount = 100000;
    const { fee, tax, net } = calcFee(amount);
    const sr = makeSR({ amount, fee, tax, credit: net });
    const result = ruleFeeVariance({ sr });
    expect(result).toBeNull();
  });

  test('ruleFeeVariance does not fire for refunds', () => {
    const sr = makeSR({ type: 'refund', debit: 100000, credit: 0, fee: 9999 });
    const result = ruleFeeVariance({ sr });
    expect(result).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// § SCENARIO 5 — MISSING ORDER
// ════════════════════════════════════════════════════════════════════════════

describe('Scenario: MISSING_ORDER', () => {
  test('ruleMissingOrder fires when order_id is null and no merchant order', () => {
    const sr = makeSR({ order_id: null, order_receipt: null });
    const result = ruleMissingOrder({ sr, merchantOrder: null });
    expect(result).not.toBeNull();
    expect(result.category).toBe('MISSING_ORDER');
  });

  test('ruleMissingOrder does NOT fire for adjustment type', () => {
    const sr = createSettlementRecord({
      entity_id: 'adj_TEST001', type: 'adjustment',
      debit: 0, credit: 5000, amount: 5000, fee: 0, tax: 0,
      settled: true, created_at: BASE_TIME,
    });
    const result = ruleMissingOrder({ sr, merchantOrder: null });
    expect(result).toBeNull();
  });

  test('ruleMissingOrder does NOT fire when merchant order exists', () => {
    const sr = makeSR({ order_id: 'order_FOUND' });
    const mo = makeMO({ razorpay_order_id: 'order_FOUND' });
    const result = ruleMissingOrder({ sr, merchantOrder: mo });
    expect(result).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// § SCENARIO 6 — MISSING PAYMENT
// ════════════════════════════════════════════════════════════════════════════

describe('Scenario: MISSING_PAYMENT', () => {
  test('engine detects MISSING_PAYMENT for old pending ledger with no settlement record', () => {
    const oldTime = BASE_TIME; // well before cutoff
    const mo = createMerchantOrder({
      id:                'mo_MISSING001',
      razorpay_order_id: 'order_NOTFOUND',
      amount:            100000,
      created_at:        oldTime,
      status:            'paid',
    });
    const le = createMerchantLedger({
      id:                'ledger_MISSING001',
      merchant_order_id: 'mo_MISSING001',
      expected_amount:   97640,
      status:            'pending', // never posted
      posted_at:         null,
    });

    const { results, exceptions } = reconcile({
      settlementRecords: [],
      merchantOrders:    [mo],
      merchantLedger:    [le],
    });

    expect(exceptions.length).toBe(1);
    expect(exceptions[0].category).toBe('MISSING_PAYMENT');
    expect(results[0].exception_category).toBe('MISSING_PAYMENT');
  });

  test('engine does NOT flag MISSING_PAYMENT for recent orders', () => {
    const recentTime = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const mo = createMerchantOrder({
      id:                'mo_RECENT001',
      razorpay_order_id: 'order_RECENTX',
      amount:            100000,
      created_at:        recentTime,
      status:            'paid',
    });
    const le = createMerchantLedger({
      id:                'ledger_RECENT001',
      merchant_order_id: 'mo_RECENT001',
      expected_amount:   97640,
      status:            'pending',
      posted_at:         null,
    });

    const { exceptions } = reconcile({
      settlementRecords: [],
      merchantOrders:    [mo],
      merchantLedger:    [le],
    });

    expect(exceptions.filter(e => e.category === 'MISSING_PAYMENT').length).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// § SCENARIO 7 — DUPLICATE
// ════════════════════════════════════════════════════════════════════════════

describe('Scenario: DUPLICATE', () => {
  test('ruleDuplicate fires when same order_id + amount within time window', () => {
    const pay1 = makeSR({ entity_id: 'pay_DUP001', order_id: 'order_DUP', created_at: BASE_TIME });
    const pay2 = makeSR({ entity_id: 'pay_DUP002', order_id: 'order_DUP', created_at: BASE_TIME + 100 });

    const result = ruleDuplicate({ sr: pay1, allSettlementRecords: [pay1, pay2] });
    expect(result).not.toBeNull();
    expect(result.category).toBe('DUPLICATE');
    expect(result.duplicateIds).toContain('pay_DUP002');
  });

  test('ruleDuplicate does NOT fire when timestamps differ beyond window', () => {
    const pay1 = makeSR({ entity_id: 'pay_ND001', order_id: 'order_ND', created_at: BASE_TIME });
    const pay2 = makeSR({ entity_id: 'pay_ND002', order_id: 'order_ND', created_at: BASE_TIME + 86400 });

    const result = ruleDuplicate({ sr: pay1, allSettlementRecords: [pay1, pay2] });
    expect(result).toBeNull();
  });

  test('ruleDuplicate does NOT fire for different order_ids', () => {
    const pay1 = makeSR({ entity_id: 'pay_DO001', order_id: 'order_A', created_at: BASE_TIME });
    const pay2 = makeSR({ entity_id: 'pay_DO002', order_id: 'order_B', created_at: BASE_TIME + 10 });

    const result = ruleDuplicate({ sr: pay1, allSettlementRecords: [pay1, pay2] });
    expect(result).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// § SCENARIO 8 — ADJUSTMENT
// ════════════════════════════════════════════════════════════════════════════

describe('Scenario: ADJUSTMENT', () => {
  test('ruleAdjustment fires for type=adjustment records', () => {
    const sr = createSettlementRecord({
      entity_id:   'adj_TEST002',
      type:        'adjustment',
      debit:       0,
      credit:      15000,
      amount:      15000,
      fee:         0,
      tax:         0,
      settled:     true,
      created_at:  BASE_TIME,
      description: 'Fee reversal',
    });
    const result = ruleAdjustment({ sr });
    expect(result).not.toBeNull();
    expect(result.category).toBe('ADJUSTMENT');
    expect(result.status).toBe('EXCEPTION');
  });

  test('ruleAdjustment does NOT fire for payment type', () => {
    const sr = makeSR();
    const result = ruleAdjustment({ sr });
    expect(result).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// § SCENARIO 9 — UNEXPLAINED
// ════════════════════════════════════════════════════════════════════════════

describe('Scenario: UNEXPLAINED', () => {
  test('ruleUnexplained fires when credit has unexplained shortfall (fee/tax correct)', () => {
    const amount = 200000;
    const { fee, tax, net } = calcFee(amount);
    // Introduce shortfall that is NOT due to fee/tax
    const shortfall = 2500;
    const credit = net - shortfall;

    const sr = makeSR({ amount, fee, tax, credit,
      order_id: 'order_UNEXP', entity_id: 'pay_UNEXP001' });
    const mo = makeMO({ razorpay_order_id: 'order_UNEXP' });
    const le = makeLE({ expected_amount: net }); // merchant expected full net

    const result = ruleUnexplained({ sr, merchantOrder: mo, ledgerEntry: le });
    expect(result).not.toBeNull();
    expect(result.category).toBe('UNEXPLAINED');
    expect(result.status).toBe('EXCEPTION');
    expect(result.variance).toBeLessThan(0); // shortfall
  });

  test('ruleUnexplained does NOT fire when amounts match', () => {
    const sr = makeSR();
    const mo = makeMO();
    const le = makeLE();
    const result = ruleUnexplained({ sr, merchantOrder: mo, ledgerEntry: le });
    expect(result).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// § EDGE CASES
// ════════════════════════════════════════════════════════════════════════════

describe('Edge cases', () => {
  test('Empty dataset produces no results or exceptions', () => {
    const { results, exceptions } = reconcile({
      settlementRecords: [],
      merchantOrders:    [],
      merchantLedger:    [],
    });
    expect(results.length).toBe(0);
    expect(exceptions.length).toBe(0);
  });

  test('Null order_id on payment triggers MISSING_ORDER', () => {
    const sr = makeSR({ order_id: null });
    const { results, exceptions } = reconcile({
      settlementRecords: [sr],
      merchantOrders:    [],
      merchantLedger:    [],
    });
    expect(exceptions.some(e => e.category === 'MISSING_ORDER')).toBe(true);
  });

  test('Adjustment with no counterpart triggers ADJUSTMENT exception', () => {
    const sr = createSettlementRecord({
      entity_id: 'adj_EDGE001', type: 'adjustment',
      debit: 0, credit: 10000, amount: 10000, fee: 0, tax: 0,
      settled: true, created_at: BASE_TIME,
    });
    const { exceptions } = reconcile({
      settlementRecords: [sr],
      merchantOrders:    [],
      merchantLedger:    [],
    });
    expect(exceptions.some(e => e.category === 'ADJUSTMENT')).toBe(true);
  });

  test('Reconciliation result has all source IDs for traceability', () => {
    const sr = makeSR();
    const mo = makeMO();
    const le = makeLE();
    const { results } = reconcile({
      settlementRecords: [sr],
      merchantOrders:    [mo],
      merchantLedger:    [le],
    });
    expect(results.length).toBeGreaterThan(0);
    const r = results[0];
    expect(r.settlement_entity_id).toBe(sr.entity_id);
    expect(r.merchant_order_id).toBe(mo.id);
    expect(r.merchant_ledger_id).toBe(le.id);
  });

  test('amount_at_risk is always an integer in exceptions', () => {
    const dataset = generateDataset();
    const { exceptions } = reconcile(dataset);
    for (const exc of exceptions) {
      expect(Number.isInteger(exc.amount_at_risk)).toBe(true);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// § FULL DATASET VALIDATION
// ════════════════════════════════════════════════════════════════════════════

describe('Full dataset validation', () => {
  let dataset, results, exceptions;

  beforeAll(() => {
    dataset = generateDataset();
    ({ results, exceptions } = reconcile(dataset));
  });

  test('Dataset has at least 60 settlement records', () => {
    expect(dataset.settlementRecords.length).toBeGreaterThanOrEqual(60);
  });

  test('Dataset has at least 60 merchant orders', () => {
    expect(dataset.merchantOrders.length).toBeGreaterThanOrEqual(60);
  });

  test('Dataset has 4 settlement batches', () => {
    expect(dataset.settlementBatches.length).toBe(4);
  });

  test('All settlement amounts are integer paise', () => {
    for (const sr of dataset.settlementRecords) {
      expect(Number.isInteger(sr.amount)).toBe(true);
      expect(Number.isInteger(sr.fee)).toBe(true);
      expect(Number.isInteger(sr.tax)).toBe(true);
      expect(Number.isInteger(sr.credit)).toBe(true);
      expect(Number.isInteger(sr.debit)).toBe(true);
    }
  });

  test('All merchant ledger amounts are integer paise', () => {
    for (const le of dataset.merchantLedger) {
      expect(Number.isInteger(le.expected_amount)).toBe(true);
    }
  });

  test('Dataset contains at least 5 PARTIAL_REFUND refund records', () => {
    const partials = dataset.settlementRecords.filter(sr => sr._scenario === 'PARTIAL_REFUND');
    expect(partials.length).toBeGreaterThanOrEqual(5);
  });

  test('Dataset contains TIMING_MISMATCH records in different batches', () => {
    const timingPays = dataset.settlementRecords.filter(
      sr => sr._scenario === 'TIMING_MISMATCH' && sr.type === 'payment',
    );
    const timingRfnd = dataset.settlementRecords.filter(
      sr => sr._scenario === 'TIMING_MISMATCH' && sr.type === 'refund',
    );
    expect(timingPays.length).toBeGreaterThanOrEqual(3);
    expect(timingRfnd.length).toBeGreaterThanOrEqual(3);
    // They must be in different batches
    for (let i = 0; i < timingPays.length; i++) {
      expect(timingPays[i].settlement_id).not.toBe(timingRfnd[i].settlement_id);
    }
  });

  test('Dataset contains MISSING_ORDER records with null order_id', () => {
    const missing = dataset.settlementRecords.filter(sr => sr._scenario === 'MISSING_ORDER');
    expect(missing.length).toBeGreaterThanOrEqual(3);
    for (const sr of missing) {
      expect(sr.order_id).toBeNull();
    }
  });

  test('Dataset contains DUPLICATE pairs with same order_id', () => {
    const dups = dataset.settlementRecords.filter(sr => sr._scenario === 'DUPLICATE');
    expect(dups.length).toBeGreaterThanOrEqual(4); // 2 pairs × 2
    // All share an order_id that appears more than once
    const orderCounts = {};
    for (const sr of dups) {
      if (sr.order_id) orderCounts[sr.order_id] = (orderCounts[sr.order_id] || 0) + 1;
    }
    expect(Object.values(orderCounts).every(c => c > 1)).toBe(true);
  });

  test('Dataset contains ADJUSTMENT records with type=adjustment', () => {
    const adjs = dataset.settlementRecords.filter(sr => sr._scenario === 'ADJUSTMENT');
    expect(adjs.length).toBeGreaterThanOrEqual(3);
    for (const sr of adjs) expect(sr.type).toBe('adjustment');
  });

  test('Dataset contains UNEXPLAINED records', () => {
    const unexp = dataset.settlementRecords.filter(sr => sr._scenario === 'UNEXPLAINED');
    expect(unexp.length).toBeGreaterThanOrEqual(2);
  });

  test('Engine produces results for every settlement record', () => {
    const srCount = dataset.settlementRecords.length;
    // Results may be more due to MISSING_PAYMENT
    expect(results.length).toBeGreaterThanOrEqual(srCount);
  });

  test('Engine detects TIMING_MISMATCH exceptions', () => {
    const timingExcs = exceptions.filter(e => e.category === 'TIMING_MISMATCH');
    expect(timingExcs.length).toBeGreaterThanOrEqual(3);
  });

  test('Engine detects FEE_TAX_VARIANCE exceptions', () => {
    const feeExcs = exceptions.filter(e => e.category === 'FEE_TAX_VARIANCE');
    expect(feeExcs.length).toBeGreaterThanOrEqual(3);
  });

  test('Engine detects MISSING_ORDER exceptions', () => {
    const moExcs = exceptions.filter(e => e.category === 'MISSING_ORDER');
    expect(moExcs.length).toBeGreaterThanOrEqual(3);
  });

  test('Engine detects DUPLICATE exceptions', () => {
    const dupExcs = exceptions.filter(e => e.category === 'DUPLICATE');
    expect(dupExcs.length).toBeGreaterThanOrEqual(2);
  });

  test('Engine detects ADJUSTMENT exceptions', () => {
    const adjExcs = exceptions.filter(e => e.category === 'ADJUSTMENT');
    expect(adjExcs.length).toBeGreaterThanOrEqual(3);
  });

  test('Engine detects UNEXPLAINED exceptions', () => {
    const unexpExcs = exceptions.filter(e => e.category === 'UNEXPLAINED');
    expect(unexpExcs.length).toBeGreaterThanOrEqual(2);
  });

  test('Engine detects MISSING_PAYMENT exceptions', () => {
    const mpExcs = exceptions.filter(e => e.category === 'MISSING_PAYMENT');
    expect(mpExcs.length).toBeGreaterThanOrEqual(3);
  });

  test('Every exception has amount_at_risk as integer paise', () => {
    for (const exc of exceptions) {
      expect(Number.isInteger(exc.amount_at_risk)).toBe(true);
      expect(exc.amount_at_risk).toBeGreaterThan(0);
    }
  });

  test('Every result has required traceability fields', () => {
    for (const r of results) {
      expect(r.id).toBeTruthy();
      expect(r.settlement_entity_id).toBeTruthy();
      expect(r.reason).toBeTruthy();
      expect(r.created_at).toBeGreaterThan(0);
    }
  });

  test('Ground truth exists for all deliberate exception scenarios', () => {
    const gt = dataset.groundTruth;
    expect([...gt.values()]).toContain('CLEAN_MATCH');
    expect([...gt.values()]).toContain('PARTIAL_REFUND');
    expect([...gt.values()]).toContain('TIMING_MISMATCH');
    expect([...gt.values()]).toContain('FEE_TAX_VARIANCE');
    expect([...gt.values()]).toContain('MISSING_ORDER');
    expect([...gt.values()]).toContain('DUPLICATE');
    expect([...gt.values()]).toContain('ADJUSTMENT');
    expect([...gt.values()]).toContain('UNEXPLAINED');
  });

  test('Dataset is deterministic — same data on two consecutive calls', () => {
    const ds1 = generateDataset();
    const ds2 = generateDataset();
    expect(ds1.settlementRecords.length).toBe(ds2.settlementRecords.length);
    expect(ds1.settlementRecords[0].entity_id).toBe(ds2.settlementRecords[0].entity_id);
    expect(ds1.settlementRecords[0].amount).toBe(ds2.settlementRecords[0].amount);
  });
});
