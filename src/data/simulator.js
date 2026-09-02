'use strict';
/**
 * src/data/simulator.js
 *
 * Settlement Simulator for Razorpay-Backed Mode (Chunk 1.5).
 *
 * Sourced from REAL Razorpay Test Mode orders, payments, and refunds.
 * Generates realistic, schema-accurate simulated settlement batches and records
 * because Razorpay Test Mode does not execute the production bank clearing pipeline.
 *
 * PRESERVES:
 * - Real Razorpay payment IDs (`pay_*`)
 * - Real Razorpay order IDs (`order_*`)
 * - Real Razorpay refund IDs (`rfnd_*`)
 * - Real refund -> payment parent linkages (`payment_id`)
 * - Real monetary amounts (in integer paise)
 *
 * SIMULATES:
 * - Settlement batches (`setl_*`)
 * - Settlement UTRs
 * - Simulated settlement timestamps (`settled_at`, T+2 lifecycle)
 * - Controlled exception scenarios for evaluation
 */

const { createPRNG, makeId, makeUTR, randInt, makeLocalId, SEED_BASE } = require('./seed');
const { createSettlementRecord } = require('../models/settlementRecord');
const { createMerchantOrder }    = require('../models/merchantOrder');
const { createMerchantLedger }   = require('../models/merchantLedger');
const { calcFee }                = require('./generator');
const config                     = require('../engine/config');

/**
 * Simulate a settlement dataset from real Razorpay Test Mode transactions.
 *
 * @param {Object} params
 * @param {Array} params.orders    - Normalized Razorpay orders
 * @param {Array} params.payments  - Normalized Razorpay payments
 * @param {Array} params.refunds   - Normalized Razorpay refunds
 * @param {Object} [options]
 * @param {number} [options.seed]
 * @param {boolean} [options.injectExceptions=true]
 *
 * @returns {Object} { settlementRecords, merchantOrders, merchantLedger, settlementBatches, groundTruth, metadata }
 */
function simulateSettlementDataset({ orders = [], payments = [], refunds = [] }, options = {}) {
  const seed = options.seed !== undefined ? options.seed : SEED_BASE;
  const rand = createPRNG(seed);
  const injectExceptions = options.injectExceptions !== false;

  const settlementRecords = [];
  const merchantOrders    = [];
  const merchantLedger    = [];
  const groundTruth       = new Map(); // entity_id -> expected_classification

  let moSeq = 0;
  let ledgerSeq = 0;

  function gt(entityId, scenario) {
    groundTruth.set(entityId, scenario);
  }

  // Handle case with zero payments
  if (!payments || payments.length === 0) {
    return {
      settlementRecords: [],
      merchantOrders: [],
      merchantLedger: [],
      settlementBatches: [],
      groundTruth: new Map(),
      metadata: {
        data_source: 'razorpay_test_mode',
        settlement_source: 'simulated',
        simulation_version: '1.0',
        generated_at: Date.now(),
        seed,
        orders_fetched: orders.length,
        payments_fetched: 0,
        refunds_fetched: refunds.length,
      },
    };
  }

  // Index real orders by ID
  const ordersById = new Map();
  for (const o of orders) {
    ordersById.set(o.id, o);
  }

  // Index real refunds by payment_id
  const refundsByPayId = new Map();
  for (const r of refunds) {
    const list = refundsByPayId.get(r.payment_id) || [];
    list.push(r);
    refundsByPayId.set(r.payment_id, list);
  }

  // ── 1. Create simulated settlement batches ─────────────────────────────────
  // Derive base time from payment timestamps
  const timestamps = payments.map(p => p.created_at || Math.floor(Date.now() / 1000));
  const minTime = Math.min(...timestamps);
  const maxTime = Math.max(...timestamps, minTime + 86400 * 10);

  const numBatches = Math.max(2, Math.min(4, Math.ceil(payments.length / 5)));
  const timeSpan = Math.max(86400 * 4, maxTime - minTime);
  const batchStep = Math.floor(timeSpan / numBatches);

  const settlementBatches = [];
  for (let i = 0; i < numBatches; i++) {
    const settledAt = minTime + (i + 1) * batchStep + randInt(3600, 14400, rand);
    settlementBatches.push({
      index: i,
      id: makeId('setl', rand),
      utr: makeUTR(settledAt, rand),
      settled_at: settledAt,
      created_at: settledAt - randInt(3600, 7200, rand),
    });
  }

  // ── 2. Distribute payments into simulated settlements & inject scenarios ──
  const totalPayments = payments.length;

  payments.forEach((payment, idx) => {
    const batchIdx = idx % settlementBatches.length;
    const batch = settlementBatches[batchIdx];
    const { fee: defaultFee, tax: defaultTax, net: defaultNet } = calcFee(payment.amount);

    const moId = makeLocalId('mo', ++moSeq);
    const ledId = makeLocalId('ledger', ++ledgerSeq);
    const realOrder = payment.order_id ? ordersById.get(payment.order_id) : null;
    const receipt = realOrder ? realOrder.receipt : `rcpt_sim_${moSeq}`;

    // Determine scenario assignment if injection is enabled
    let scenario = 'CLEAN_MATCH';
    let feeOverride = null;
    let omitOrderId = false;
    let duplicateClone = false;
    let unexplainedShortfall = 0;

    if (injectExceptions && totalPayments >= 4) {
      if (idx === 1) {
        scenario = 'FEE_TAX_VARIANCE';
        // Add significant fee discrepancy beyond 100 paise tolerance
        feeOverride = defaultFee + 2500;
      } else if (idx === 2) {
        scenario = 'MISSING_ORDER';
        omitOrderId = true;
      } else if (idx === 3) {
        scenario = 'DUPLICATE';
        duplicateClone = true;
      } else if (idx === 4) {
        scenario = 'UNEXPLAINED';
        unexplainedShortfall = 3500; // unexplained credit shortfall
      }
    }

    const effectiveFee = feeOverride !== null ? feeOverride : defaultFee;
    const effectiveTax = feeOverride !== null ? Math.round(effectiveFee * config.GST_RATE) : defaultTax;
    const effectiveCredit = payment.amount - effectiveFee - effectiveTax - unexplainedShortfall;

    // Create simulated SettlementRecord for REAL payment
    const sr = createSettlementRecord({
      entity_id: payment.id, // REAL Razorpay payment ID preserved!
      type: 'payment',
      debit: 0,
      credit: effectiveCredit,
      amount: payment.amount,
      currency: payment.currency || 'INR',
      fee: effectiveFee,
      tax: effectiveTax,
      settled: true,
      created_at: payment.created_at || batch.created_at - 86400,
      settled_at: batch.settled_at,
      settlement_id: batch.id,
      settlement_utr: batch.utr,
      order_id: omitOrderId ? null : (payment.order_id || null),
      order_receipt: omitOrderId ? null : receipt,
      method: payment.method || 'card',
      card_network: payment.card_network || null,
      card_issuer: payment.card_issuer || null,
      card_type: payment.card_type || null,
      _batch_index: batchIdx,
      _scenario: scenario,
      _source: 'razorpay_test_simulated_settlement',
    });

    settlementRecords.push(sr);
    gt(payment.id, scenario);

    // Create corresponding MerchantOrder
    const mo = createMerchantOrder({
      id: moId,
      razorpay_order_id: payment.order_id || makeId('order', rand),
      amount: payment.amount,
      currency: payment.currency || 'INR',
      customer_email: payment.email || `customer_${moSeq}@example.com`,
      customer_name: `Customer ${moSeq}`,
      description: payment.description || `Order for payment ${payment.id}`,
      created_at: payment.created_at || batch.created_at - 86400,
      status: 'paid',
      receipt,
      _expected_classification: scenario,
    });
    merchantOrders.push(mo);

    // Create corresponding MerchantLedgerEntry
    const le = createMerchantLedger({
      id: ledId,
      merchant_order_id: moId,
      expected_amount: defaultNet,
      posted_amount: effectiveCredit,
      status: scenario === 'UNEXPLAINED' ? 'discrepancy' : 'posted',
      posted_at: batch.settled_at,
      reference: payment.id,
      description: `Settlement posted for order ${moId} (Real payment: ${payment.id})`,
    });
    merchantLedger.push(le);

    // If DUPLICATE scenario: add a duplicate simulated settlement record
    if (duplicateClone) {
      const dupPayId = makeId('pay', rand);
      const dupSr = createSettlementRecord({
        entity_id: dupPayId,
        type: 'payment',
        debit: 0,
        credit: effectiveCredit,
        amount: payment.amount,
        currency: payment.currency || 'INR',
        fee: effectiveFee,
        tax: effectiveTax,
        settled: true,
        created_at: (payment.created_at || batch.created_at) + 60, // within 300s
        settled_at: batch.settled_at,
        settlement_id: batch.id,
        settlement_utr: batch.utr,
        order_id: payment.order_id || null,
        order_receipt: receipt,
        method: payment.method || 'card',
        _batch_index: batchIdx,
        _scenario: 'DUPLICATE',
        _source: 'razorpay_test_simulated_settlement',
      });
      settlementRecords.push(dupSr);
      gt(dupPayId, 'DUPLICATE');
    }

    // ── 3. Handle associated real refunds for this payment ───────────────────
    const associatedRefunds = refundsByPayId.get(payment.id) || [];
    associatedRefunds.forEach((refund, rIdx) => {
      // If we have multiple batches, assign refund to a different batch for timing mismatch
      let refundBatchIdx = batchIdx;
      let refundScenario = 'PARTIAL_REFUND';

      if (injectExceptions && settlementBatches.length > 1 && rIdx === 0) {
        refundBatchIdx = (batchIdx + 1) % settlementBatches.length;
        refundScenario = 'TIMING_MISMATCH';
      }

      const refundBatch = settlementBatches[refundBatchIdx];

      const refundSr = createSettlementRecord({
        entity_id: refund.id, // REAL Razorpay refund ID preserved!
        type: 'refund',
        debit: refund.amount,
        credit: 0,
        amount: refund.amount,
        currency: refund.currency || 'INR',
        fee: 0,
        tax: 0,
        settled: true,
        created_at: refund.created_at || (payment.created_at + 3600),
        settled_at: refundBatch.settled_at,
        settlement_id: refundBatch.id,
        settlement_utr: refundBatch.utr,
        order_id: payment.order_id || null,
        order_receipt: receipt,
        payment_id: payment.id, // REAL parent linkage preserved!
        method: payment.method || 'card',
        _batch_index: refundBatchIdx,
        _scenario: refundScenario,
        _source: 'razorpay_test_simulated_settlement',
      });

      settlementRecords.push(refundSr);
      gt(refund.id, refundScenario);
    });
  });

  // ── 4. Inject synthetic Adjustment & Missing Payment if exceptions enabled ─
  if (injectExceptions) {
    // A. Simulated Adjustment record
    const adjId = makeId('adj', rand);
    const adjBatch = settlementBatches[0];
    const adjAmount = 2500; // ₹25.00
    const adjSr = createSettlementRecord({
      entity_id: adjId,
      type: 'adjustment',
      debit: 0,
      credit: adjAmount,
      amount: adjAmount,
      currency: 'INR',
      fee: 0,
      tax: 0,
      settled: true,
      created_at: adjBatch.created_at,
      settled_at: adjBatch.settled_at,
      settlement_id: adjBatch.id,
      settlement_utr: adjBatch.utr,
      order_id: null,
      order_receipt: null,
      payment_id: null,
      description: 'Simulated fee reversal adjustment',
      credit_type: 'default',
      _batch_index: 0,
      _scenario: 'ADJUSTMENT',
      _source: 'razorpay_test_simulated_settlement',
    });
    settlementRecords.push(adjSr);
    gt(adjId, 'ADJUSTMENT');

    // B. Simulated Missing Payment scenario (merchant ledger says paid, but settlement omitted)
    const mpMoId = makeLocalId('mo', ++moSeq);
    const mpLedId = makeLocalId('ledger', ++ledgerSeq);
    const mpAmount = 150000; // ₹1500
    const { net: mpNet } = calcFee(mpAmount);
    const mpCreatedAt = Math.min(...timestamps) - 86400 * 5; // old order past 3-day cutoff

    const mpMo = createMerchantOrder({
      id: mpMoId,
      razorpay_order_id: makeId('order', rand),
      amount: mpAmount,
      created_at: mpCreatedAt,
      status: 'paid',
      receipt: `rcpt_mp_${moSeq}`,
      _expected_classification: 'MISSING_PAYMENT',
    });
    const mpLe = createMerchantLedger({
      id: mpLedId,
      merchant_order_id: mpMoId,
      expected_amount: mpNet,
      posted_amount: null,
      status: 'pending',
      posted_at: null,
      reference: null,
      description: `Missing settlement payment for ${mpMoId}`,
    });
    merchantOrders.push(mpMo);
    merchantLedger.push(mpLe);
    gt(`__missing_payment_${mpMoId}`, 'MISSING_PAYMENT');
  }

  return {
    settlementRecords,
    merchantOrders,
    merchantLedger,
    settlementBatches,
    groundTruth,
    metadata: {
      data_source: 'razorpay_test_mode',
      settlement_source: 'simulated',
      simulation_version: '1.0',
      generated_at: Date.now(),
      seed,
      orders_fetched: orders.length,
      payments_fetched: payments.length,
      refunds_fetched: refunds.length,
    },
  };
}

module.exports = { simulateSettlementDataset };
