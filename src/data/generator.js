'use strict';
/**
 * src/data/generator.js
 *
 * Deterministic synthetic dataset generator.
 *
 * IMPORTANT: This data is SYNTHETIC. Razorpay Test Mode does not execute the
 * real financial settlement pipeline, so no real recon data is available.
 * These records are schema-accurate replicas for demonstration and AI research.
 *
 * The generator uses a fixed seed — the same dataset is produced on every run.
 *
 * Dataset contains all 9 required exception scenarios plus clean matches.
 */

const { createPRNG, makePRNG, makeId, makeUTR, randInt, pick, pickWeighted, makeLocalId } = require('./seed');
const { createSettlementRecord }    = require('../models/settlementRecord');
const { createMerchantOrder }       = require('../models/merchantOrder');
const { createMerchantLedger }      = require('../models/merchantLedger');
const config = require('../engine/config');

// ── Constants ─────────────────────────────────────────────────────────────────

// August 2026 start (approximate Unix timestamp)
const AUG_2026_START = 1753920000; // 2026-08-01 00:00:00 UTC

const METHODS = ['card', 'upi', 'netbanking', 'wallet'];
const METHOD_WEIGHTS = [0.42, 0.36, 0.14, 0.08];
const CARD_NETWORKS = ['Visa', 'MasterCard', 'Rupay', 'Amex'];
const CARD_TYPES    = ['credit', 'debit'];
const CARD_ISSUERS  = ['HDFC', 'ICICI', 'SBI', 'AXIS', 'KOTAK'];

// Settlement batches — each settles ~15-20 days after month start
const BATCH_OFFSETS_DAYS = [7, 14, 21, 29]; // settlement dates in August

/**
 * Calculate expected fee and tax for a given gross amount (integer paise).
 * Returns { fee, tax, net } all in paise.
 */
function calcFee(amount) {
  const fee = Math.round(amount * config.PLATFORM_FEE_RATE);
  const tax = Math.round(fee * config.GST_RATE);
  const net = amount - fee - tax;
  return { fee, tax, net };
}

// ── Main generator ─────────────────────────────────────────────────────────────

/**
 * Generate the complete deterministic synthetic dataset.
 *
 * @param {number} [customSeed] - Optional seed for generating diverse training datasets
 * @returns {Object} Dataset containing settlementRecords, merchantOrders, merchantLedger, groundTruth
 */
function generateDataset(customSeed = null) {
  const rand = customSeed !== null && customSeed !== undefined ? createPRNG(customSeed) : makePRNG();

  // ── Build 4 settlement batches ─────────────────────────────────────────────
  const settlementBatches = BATCH_OFFSETS_DAYS.map((daysOffset, i) => {
    const settled_at = AUG_2026_START + daysOffset * config.SECONDS_PER_DAY + randInt(3600, 14400, rand);
    return {
      index:      i,
      id:         makeId('setl', rand),
      utr:        makeUTR(settled_at, rand),
      settled_at,
      created_at: settled_at - randInt(3600, 7200, rand),
    };
  });

  const settlementRecords = [];
  const merchantOrders    = [];
  const merchantLedger    = [];
  const groundTruth       = new Map(); // entity_id → expected_classification

  let moSeq     = 0;
  let ledgerSeq = 0;
  let resultsSeq = 0;

  // Helper: register a ground truth entry
  function gt(entity_id, classification) {
    groundTruth.set(entity_id, classification);
  }

  // Helper: create a standard payment + merchant order + ledger (clean)
  function makeCleanPayment({ batchIndex, amount, scenario = 'CLEAN_MATCH', feeOverride = null }) {
    const batch   = settlementBatches[batchIndex];
    const method  = pickWeighted(METHODS, METHOD_WEIGHTS, rand);
    const orderId = makeId('order', rand);
    const payId   = makeId('pay',   rand);
    const moId    = makeLocalId('mo', ++moSeq);
    const ledId   = makeLocalId('ledger', ++ledgerSeq);
    const receipt = `rcpt_${moSeq}`;

    const { fee: calcedFee, tax: calcedTax, net } = calcFee(amount);
    const fee = feeOverride !== null ? feeOverride : calcedFee;
    const tax = feeOverride !== null ? Math.round(fee * config.GST_RATE) : calcedTax;
    const credit = amount - fee - tax;
    const createdAt = batch.created_at - randInt(3600, 86400 * 5, rand);

    const sr = createSettlementRecord({
      entity_id:      payId,
      type:           'payment',
      debit:          0,
      credit,
      amount,
      fee,
      tax,
      settled:        true,
      created_at:     createdAt,
      settled_at:     batch.settled_at,
      settlement_id:  batch.id,
      settlement_utr: batch.utr,
      order_id:       orderId,
      order_receipt:  receipt,
      method,
      card_network:   method === 'card' ? pick(CARD_NETWORKS, rand) : null,
      card_issuer:    method === 'card' ? pick(CARD_ISSUERS,  rand) : null,
      card_type:      method === 'card' ? pick(CARD_TYPES,    rand) : null,
      _batch_index:   batchIndex,
      _scenario:      scenario,
    });

    const mo = createMerchantOrder({
      id:                   moId,
      razorpay_order_id:    orderId,
      amount,
      customer_email:       `customer${moSeq}@example.com`,
      customer_name:        `Customer ${moSeq}`,
      description:          `Order ${moSeq}`,
      created_at:           createdAt,
      status:               'paid',
      receipt,
      _expected_classification: scenario,
    });

    // Merchant ledger — expected net after fees
    const le = createMerchantLedger({
      id:                ledId,
      merchant_order_id: moId,
      expected_amount:   net, // net of fees (what merchant actually expects)
      posted_amount:     net,
      status:            'posted',
      posted_at:         batch.settled_at,
      reference:         payId,
      description:       `Payment settled — ${moId}`,
    });

    settlementRecords.push(sr);
    merchantOrders.push(mo);
    merchantLedger.push(le);
    gt(payId, scenario);

    return { sr, mo, le, batch, payId, orderId, moId, ledId, receipt, amount, net, fee, tax, createdAt };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO 1 — CLEAN_MATCH (45 records)
  // ═══════════════════════════════════════════════════════════════════════════
  for (let i = 0; i < 45; i++) {
    const batchIndex = i % 4;
    const amount = randInt(10000, 300000, rand); // ₹100 – ₹3000
    makeCleanPayment({ batchIndex, amount, scenario: 'CLEAN_MATCH' });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO 2 — PARTIAL_REFUND (5 records)
  // A payment is captured then partially refunded in the same batch.
  // Both records are correctly represented.
  // Engine: MATCHED (partial refund is expected)
  // ═══════════════════════════════════════════════════════════════════════════
  for (let i = 0; i < 5; i++) {
    const { sr: paymentSr, mo, le, batch, payId, orderId, receipt, amount, net } =
      makeCleanPayment({ batchIndex: i % 4, amount: randInt(50000, 200000, rand), scenario: 'PARTIAL_REFUND' });

    // Partial refund — 20-60% of original
    const refundAmount = Math.round(amount * (0.2 + rand() * 0.4));
    const rfndId       = makeId('rfnd', rand);
    const refundCreatedAt = paymentSr.created_at + randInt(3600, 86400, rand);

    const refundSr = createSettlementRecord({
      entity_id:      rfndId,
      type:           'refund',
      debit:          refundAmount,
      credit:         0,
      amount:         refundAmount,
      fee:            0,
      tax:            0,
      settled:        true,
      created_at:     refundCreatedAt,
      settled_at:     batch.settled_at,
      settlement_id:  batch.id,
      settlement_utr: batch.utr,
      order_id:       orderId,
      order_receipt:  receipt,
      payment_id:     payId,
      method:         paymentSr.method,
      _batch_index:   i % 4,
      _scenario:      'PARTIAL_REFUND',
    });

    settlementRecords.push(refundSr);
    gt(rfndId, 'PARTIAL_REFUND');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO 3 — TIMING_MISMATCH (3 pairs)
  // Payment settles in batch 0; refund settles in batch 2.
  // Viewed independently they don't reconcile cleanly.
  // ═══════════════════════════════════════════════════════════════════════════
  for (let i = 0; i < 3; i++) {
    const payBatch  = settlementBatches[0];
    const rfndBatch = settlementBatches[2];

    const amount  = randInt(50000, 150000, rand);
    const { fee, tax, net } = calcFee(amount);
    const orderId = makeId('order', rand);
    const payId   = makeId('pay',   rand);
    const rfndId  = makeId('rfnd',  rand);
    const moId    = makeLocalId('mo', ++moSeq);
    const ledId   = makeLocalId('ledger', ++ledgerSeq);
    const receipt = `rcpt_timing_${i}`;
    const method  = pickWeighted(METHODS, METHOD_WEIGHTS, rand);
    const credit  = amount - fee - tax;
    const payCreatedAt = payBatch.created_at - randInt(3600, 86400 * 2, rand);

    // Payment record — in batch 0
    const paymentSr = createSettlementRecord({
      entity_id:      payId,
      type:           'payment',
      debit:          0,
      credit,
      amount,
      fee,
      tax,
      settled:        true,
      created_at:     payCreatedAt,
      settled_at:     payBatch.settled_at,
      settlement_id:  payBatch.id,
      settlement_utr: payBatch.utr,
      order_id:       orderId,
      order_receipt:  receipt,
      method,
      _batch_index:   0,
      _scenario:      'TIMING_MISMATCH',
    });

    // Refund record — in batch 2 (different batch!)
    const refundAmount = amount; // full refund
    const refundSr = createSettlementRecord({
      entity_id:      rfndId,
      type:           'refund',
      debit:          refundAmount,
      credit:         0,
      amount:         refundAmount,
      fee:            0,
      tax:            0,
      settled:        true,
      created_at:     rfndBatch.created_at - randInt(3600, 43200, rand),
      settled_at:     rfndBatch.settled_at,
      settlement_id:  rfndBatch.id,
      settlement_utr: rfndBatch.utr,
      order_id:       orderId,
      order_receipt:  receipt,
      payment_id:     payId,
      method,
      _batch_index:   2,
      _scenario:      'TIMING_MISMATCH',
    });

    const mo = createMerchantOrder({
      id:                   moId,
      razorpay_order_id:    orderId,
      amount,
      created_at:           payCreatedAt,
      status:               'refunded',
      receipt,
      _expected_classification: 'TIMING_MISMATCH',
    });

    const le = createMerchantLedger({
      id:                ledId,
      merchant_order_id: moId,
      expected_amount:   credit,
      posted_amount:     credit,
      status:            'posted',
      posted_at:         payBatch.settled_at,
      reference:         payId,
      description:       `Timing mismatch test — ${moId}`,
    });

    settlementRecords.push(paymentSr, refundSr);
    merchantOrders.push(mo);
    merchantLedger.push(le);
    gt(payId,  'TIMING_MISMATCH');
    gt(rfndId, 'TIMING_MISMATCH');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO 4 — FEE_TAX_VARIANCE (3 records)
  // Settlement fee differs from expected 2% + 18% GST by more than tolerance.
  // ═══════════════════════════════════════════════════════════════════════════
  for (let i = 0; i < 3; i++) {
    const batchIndex = i % 4;
    const amount = randInt(100000, 500000, rand);
    const { fee: correctFee } = calcFee(amount);
    // Introduce a variance of ₹5–₹50 (500–5000 paise) — exceeds 100 paise tolerance
    const feeVariance = randInt(500, 5000, rand) * (rand() > 0.5 ? 1 : -1);
    const wrongFee = Math.max(0, correctFee + feeVariance);

    makeCleanPayment({
      batchIndex,
      amount,
      scenario:    'FEE_TAX_VARIANCE',
      feeOverride: wrongFee,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO 5 — MISSING_ORDER (3 records)
  // Settlement record has null order_id — cannot be resolved to a merchant order.
  // ═══════════════════════════════════════════════════════════════════════════
  for (let i = 0; i < 3; i++) {
    const batch    = settlementBatches[i % 4];
    const amount   = randInt(20000, 100000, rand);
    const { fee, tax } = calcFee(amount);
    const credit   = amount - fee - tax;
    const payId    = makeId('pay', rand);
    const method   = pickWeighted(METHODS, METHOD_WEIGHTS, rand);

    const sr = createSettlementRecord({
      entity_id:      payId,
      type:           'payment',
      debit:          0,
      credit,
      amount,
      fee,
      tax,
      settled:        true,
      created_at:     batch.created_at - randInt(3600, 86400 * 3, rand),
      settled_at:     batch.settled_at,
      settlement_id:  batch.id,
      settlement_utr: batch.utr,
      order_id:       null,    // ← deliberately null
      order_receipt:  null,    // ← deliberately null
      method,
      _batch_index:   i % 4,
      _scenario:      'MISSING_ORDER',
    });

    settlementRecords.push(sr);
    gt(payId, 'MISSING_ORDER');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO 6 — MISSING_PAYMENT (3 records)
  // Merchant ledger says an order was paid, but no settlement record exists.
  // ═══════════════════════════════════════════════════════════════════════════
  for (let i = 0; i < 3; i++) {
    const moId  = makeLocalId('mo',     ++moSeq);
    const ledId = makeLocalId('ledger', ++ledgerSeq);
    const amount = randInt(30000, 150000, rand);
    const { net } = calcFee(amount);
    // Created well before the cutoff — should have settled by now
    const createdAt = AUG_2026_START + randInt(86400, 86400 * 5, rand);

    const mo = createMerchantOrder({
      id:                   moId,
      razorpay_order_id:    makeId('order', rand),
      amount,
      created_at:           createdAt,
      status:               'paid',  // merchant believes it's paid
      receipt:              `rcpt_mp_${i}`,
      _expected_classification: 'MISSING_PAYMENT',
    });

    const le = createMerchantLedger({
      id:                ledId,
      merchant_order_id: moId,
      expected_amount:   net,
      posted_amount:     null, // never posted — waiting for settlement
      status:            'pending',
      posted_at:         null,
      reference:         null,
      description:       `Missing payment — ${moId}`,
    });

    merchantOrders.push(mo);
    merchantLedger.push(le);
    // No settlement record exists for this order — that's the exception
    gt(`__missing_payment_${moId}`, 'MISSING_PAYMENT');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO 7 — DUPLICATE (2 pairs)
  // Two payment records share the same order_id and similar amounts.
  // One is legitimate; one is a duplicate (e.g. double-posting).
  // ═══════════════════════════════════════════════════════════════════════════
  for (let i = 0; i < 2; i++) {
    const batch      = settlementBatches[1];
    const amount     = randInt(50000, 200000, rand);
    const { fee, tax } = calcFee(amount);
    const credit     = amount - fee - tax;
    const orderId    = makeId('order', rand);
    const receipt    = `rcpt_dup_${i}`;
    const method     = pickWeighted(METHODS, METHOD_WEIGHTS, rand);
    const moId       = makeLocalId('mo', ++moSeq);
    const ledId      = makeLocalId('ledger', ++ledgerSeq);
    const baseTime   = batch.created_at - randInt(3600, 86400 * 2, rand);

    const payId1 = makeId('pay', rand);
    const payId2 = makeId('pay', rand);

    // First (legitimate) payment
    const sr1 = createSettlementRecord({
      entity_id:      payId1,
      type:           'payment',
      debit:          0,
      credit,
      amount,
      fee,
      tax,
      settled:        true,
      created_at:     baseTime,
      settled_at:     batch.settled_at,
      settlement_id:  batch.id,
      settlement_utr: batch.utr,
      order_id:       orderId,
      order_receipt:  receipt,
      method,
      _batch_index:   1,
      _scenario:      'DUPLICATE',
    });

    // Second (duplicate) payment — created within DUPLICATE_WINDOW_SECONDS
    const sr2 = createSettlementRecord({
      entity_id:      payId2,
      type:           'payment',
      debit:          0,
      credit,
      amount,
      fee,
      tax,
      settled:        true,
      created_at:     baseTime + randInt(30, 200, rand), // within 5-minute window
      settled_at:     batch.settled_at,
      settlement_id:  batch.id,
      settlement_utr: batch.utr,
      order_id:       orderId,
      order_receipt:  receipt,
      method,
      _batch_index:   1,
      _scenario:      'DUPLICATE',
    });

    const mo = createMerchantOrder({
      id:                   moId,
      razorpay_order_id:    orderId,
      amount,
      created_at:           baseTime,
      status:               'paid',
      receipt,
      _expected_classification: 'DUPLICATE',
    });

    const le = createMerchantLedger({
      id:                ledId,
      merchant_order_id: moId,
      expected_amount:   credit,
      posted_amount:     credit,
      status:            'posted',
      posted_at:         batch.settled_at,
      reference:         payId1,
      description:       `Duplicate test — ${moId}`,
    });

    settlementRecords.push(sr1, sr2);
    merchantOrders.push(mo);
    merchantLedger.push(le);
    gt(payId1, 'DUPLICATE');
    gt(payId2, 'DUPLICATE');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO 8 — ADJUSTMENT (3 records)
  // A settlement adjustment row with no normal payment/refund counterpart.
  // type = 'adjustment', no order_id, no payment_id.
  // ═══════════════════════════════════════════════════════════════════════════
  const adjDescriptions = ['Fee reversal', 'Goodwill credit', 'Dispute reversal'];
  for (let i = 0; i < 3; i++) {
    const batch   = settlementBatches[i % 4];
    const amount  = randInt(10000, 50000, rand);
    const adjId   = makeId('adj', rand);

    const sr = createSettlementRecord({
      entity_id:      adjId,
      type:           'adjustment',
      debit:          0,
      credit:         amount,
      amount,
      fee:            0,
      tax:            0,
      settled:        true,
      created_at:     batch.created_at,
      settled_at:     batch.settled_at,
      settlement_id:  batch.id,
      settlement_utr: batch.utr,
      order_id:       null,
      order_receipt:  null,
      payment_id:     null,
      description:    adjDescriptions[i % adjDescriptions.length],
      credit_type:    'default',
      _batch_index:   i % 4,
      _scenario:      'ADJUSTMENT',
    });

    settlementRecords.push(sr);
    gt(adjId, 'ADJUSTMENT');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO 9 — UNEXPLAINED (2 records)
  // A genuine financial discrepancy that no deterministic rule confidently
  // explains. Amount variance exists but doesn't match any known pattern.
  // ═══════════════════════════════════════════════════════════════════════════
  for (let i = 0; i < 2; i++) {
    const batch   = settlementBatches[2];
    const amount  = randInt(80000, 300000, rand);
    const { fee, tax } = calcFee(amount);
    // Deliberate discrepancy: credit is ₹10–₹40 less than expected
    // (too large to be rounding, too small and irregular for fee variance)
    const unexplainedShortfall = randInt(1000, 4000, rand);
    const credit  = amount - fee - tax - unexplainedShortfall;
    const orderId = makeId('order', rand);
    const payId   = makeId('pay',   rand);
    const moId    = makeLocalId('mo', ++moSeq);
    const ledId   = makeLocalId('ledger', ++ledgerSeq);
    const method  = pickWeighted(METHODS, METHOD_WEIGHTS, rand);
    const createdAt = batch.created_at - randInt(3600, 86400 * 4, rand);
    const { net } = calcFee(amount);

    const sr = createSettlementRecord({
      entity_id:      payId,
      type:           'payment',
      debit:          0,
      credit,         // ← less than expected
      amount,
      fee,            // fee looks correct
      tax,            // tax looks correct
      settled:        true,
      created_at:     createdAt,
      settled_at:     batch.settled_at,
      settlement_id:  batch.id,
      settlement_utr: batch.utr,
      order_id:       orderId,
      order_receipt:  `rcpt_unexp_${i}`,
      method,
      _batch_index:   2,
      _scenario:      'UNEXPLAINED',
    });

    const mo = createMerchantOrder({
      id:                   moId,
      razorpay_order_id:    orderId,
      amount,
      created_at:           createdAt,
      status:               'paid',
      receipt:              `rcpt_unexp_${i}`,
      _expected_classification: 'UNEXPLAINED',
    });

    const le = createMerchantLedger({
      id:                ledId,
      merchant_order_id: moId,
      expected_amount:   net,
      posted_amount:     credit, // merchant books what was actually received
      status:            'discrepancy',
      posted_at:         batch.settled_at,
      reference:         payId,
      description:       `Unexplained variance — ${moId}`,
    });

    settlementRecords.push(sr);
    merchantOrders.push(mo);
    merchantLedger.push(le);
    gt(payId, 'UNEXPLAINED');
  }

  return {
    settlementRecords,
    merchantOrders,
    merchantLedger,
    settlementBatches,
    groundTruth,
  };
}

module.exports = { generateDataset, calcFee };
