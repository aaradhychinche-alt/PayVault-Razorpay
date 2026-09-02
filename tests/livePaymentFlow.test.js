'use strict';

/**
 * Live Custom Payment Flow, Settlement Pipeline, and Empty State Test Suite
 */

const request = require('supertest');
const express = require('express');
const dataStore = require('../src/store/dataStore');
const demoRouter = require('../src/routes/demo');
const investigationsRouter = require('../src/routes/investigations');

// Build test Express application
function buildTestApp() {
  const app = express();
  app.use(express.json());

  // Ingestion & Demo routes
  app.use('/api/demo', demoRouter);
  app.use('/api/investigations', investigationsRouter);

  // Summary and payments
  app.get('/api/reconciliation/summary', (req, res) => {
    res.json(dataStore.getSummary());
  });

  app.get('/api/reconciliation/results', (req, res) => {
    res.json({ count: dataStore.getResults().length, results: dataStore.getResults() });
  });

  app.get('/api/exceptions', (req, res) => {
    res.json({ count: dataStore.getExceptions().length, exceptions: dataStore.getExceptions() });
  });

  app.get('/api/payments', (req, res) => {
    res.json({ count: dataStore.getPayments().length, payments: dataStore.getPayments() });
  });

  app.get('/api/settlements', (req, res) => {
    res.json({ count: dataStore.getSettlementBatches().length, batches: dataStore.getSettlementBatches() });
  });

  app.post('/api/create-order', (req, res) => {
    const { amount, currency = 'INR', receipt = `rcpt_${Date.now()}` } = req.body || {};

    if (!amount || typeof amount !== 'number' || !Number.isInteger(amount) || amount < 100 || amount > 50000000) {
      return res.status(400).json({
        error: 'Invalid amount. Amount must be an integer between 100 (₹1.00) and 50,000,000 (₹5,00,000.00) paise.',
      });
    }

    const orderId = `order_test_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    res.json({
      order_id: orderId,
      amount,
      currency,
      receipt,
      status: 'created',
    });
  });

  app.post('/api/verify-payment', (req, res) => {
    const { razorpay_payment_id, razorpay_order_id, amount, receipt, simulate_exception } = req.body || {};

    if (!razorpay_payment_id || !amount) {
      return res.status(400).json({ error: 'Missing required payment verification fields' });
    }

    const paymentData = {
      id: razorpay_payment_id,
      order_id: razorpay_order_id || `order_${Date.now()}`,
      amount: Number(amount),
      currency: 'INR',
      status: 'captured',
      method: 'card',
      created_at: Math.floor(Date.now() / 1000),
      notes: { receipt: receipt || 'test' },
      anomaly: simulate_exception || null,
    };

    const ingestionResult = dataStore.addPaymentTransaction(paymentData);

    res.json({
      success: true,
      payment_id: paymentData.id,
      order_id: paymentData.order_id,
      amount_paise: paymentData.amount,
      amount_inr: (paymentData.amount / 100).toFixed(2),
      reconciliation_status: ingestionResult.reconciliation_status,
      net_credit_paise: ingestionResult.settlement_record.credit,
      settlement_id: ingestionResult.settlement_record.settlement_id,
      utr: ingestionResult.settlement_record.settlement_utr,
    });
  });

  app.post('/api/payments/local', (req, res) => {
    const { amount, payment_method = 'card', customer_ref, description, anomaly_type = 'CLEAN_MATCH' } = req.body || {};

    if (!amount || typeof amount !== 'number' || amount < 100 || amount > 50000000) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const amountPaise = Math.round(amount);
    const paymentId = `pay_local_${Date.now()}`;
    const orderId = customer_ref || `order_local_${Date.now()}`;

    const result = dataStore.addPaymentTransaction({
      id: paymentId,
      payment_id: paymentId,
      order_id: orderId,
      amount_paise: amountPaise,
      currency: 'INR',
      method: payment_method,
      receipt: `rcpt_${Date.now()}`,
      description: description || `Local payment for ${orderId}`,
      anomaly: anomaly_type,
      created_at: Math.floor(Date.now() / 1000),
    });

    res.json({
      success: true,
      mode: 'LOCAL_DEMO',
      payment_id: paymentId,
      order_id: orderId,
      amount_paise: amountPaise,
      settlement_record: result.settlement_record,
      reconciliation_result: result.reconciliation_result,
      is_exception: result.reconciliation_result?.status === 'EXCEPTION',
      exception: result.exception,
      summary: dataStore.getSummary(),
    });
  });

  return app;
}

describe('Live Payment & Dynamic Settlement Suite', () => {
  let app;

  beforeEach(() => {
    dataStore.initEmpty('LIVE');
    app = buildTestApp();
  });

  describe('1. Empty State Lifecycle', () => {
    test('initializes with empty store and 0 records', () => {
      const summary = dataStore.getSummary();
      expect(summary.total_settlement_records).toBe(0);
      expect(summary.merchant_orders).toBe(0);
      expect(summary.exceptions).toBe(0);
      expect(summary.total_amount_paise).toBe(0);
      expect(summary.mode).toBe('LIVE');
    });

    test('GET /api/reconciliation/summary returns 0 metrics on empty state', async () => {
      const res = await request(app).get('/api/reconciliation/summary');
      expect(res.status).toBe(200);
      expect(res.body.total_settlement_records).toBe(0);
      expect(res.body.exceptions).toBe(0);
      expect(res.body.amount_at_risk_paise).toBe(0);
    });

    test('GET /api/exceptions returns empty array without throwing', async () => {
      const res = await request(app).get('/api/exceptions');
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(0);
      expect(res.body.exceptions).toEqual([]);
    });

    test('GET /api/investigations returns empty cases on fresh startup', async () => {
      const res = await request(app).get('/api/investigations');
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(0);
      expect(res.body.cases).toEqual([]);
    });
  });

  describe('2. Local Demo Payment Flow (Zero External Credentials)', () => {
    test('POST /api/payments/local creates payment, generates settlement, and cleanly reconciles balanced payment', async () => {
      const res = await request(app)
        .post('/api/payments/local')
        .send({
          amount: 100000, // ₹1,000.00
          payment_method: 'upi',
          customer_ref: 'ord_ref_upi_100',
          anomaly_type: 'CLEAN_MATCH',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.mode).toBe('LOCAL_DEMO');
      expect(res.body.is_exception).toBe(false);

      // Expected calculation: Fee 2% (2000 paise), GST 18% (360 paise), Net = 97640 paise
      expect(res.body.settlement_record.credit).toBe(97640);
      expect(res.body.settlement_record.fee).toBe(2000);
      expect(res.body.settlement_record.tax).toBe(360);

      // Verify store state: 1 payment, 0 exceptions
      const summary = dataStore.getSummary();
      expect(summary.total_settlement_records).toBe(1);
      expect(summary.matched).toBe(1);
      expect(summary.exceptions).toBe(0);
      expect(summary.amount_at_risk_paise).toBe(0);
    });

    test('POST /api/payments/local with discrepancy creates reconcilable exception', async () => {
      const res = await request(app)
        .post('/api/payments/local')
        .send({
          amount: 1234500, // ₹12,345.00
          payment_method: 'card',
          customer_ref: 'ord_fee_variance_12345',
          anomaly_type: 'FEE_TAX_VARIANCE',
        });

      expect(res.status).toBe(200);
      expect(res.body.is_exception).toBe(true);
      expect(res.body.exception).toBeDefined();
      expect(res.body.exception.category).toBe('FEE_TAX_VARIANCE');

      // Investigation case now exists
      const invRes = await request(app).get('/api/investigations');
      expect(invRes.body.count).toBe(1);
      expect(invRes.body.cases[0].status).toBe('OPEN');
    });
  });

  describe('3. End-to-End Investigation Lifecycle', () => {
    test('runs investigation, reviews, resolves, and reopens case', async () => {
      // 1. Create a payment with anomaly
      const payRes = await request(app)
        .post('/api/payments/local')
        .send({
          amount: 500000, // ₹5,000.00
          anomaly_type: 'FEE_TAX_VARIANCE',
        });
      expect(payRes.body.is_exception).toBe(true);

      const listRes = await request(app).get('/api/investigations');
      expect(listRes.body.count).toBe(1);
      const caseId = listRes.body.cases[0].case_id;

      // 2. Run investigation -> transitions to IN_REVIEW
      const runRes = await request(app).post(`/api/investigations/${caseId}/run`);
      expect(runRes.status).toBe(200);
      expect(runRes.body.ai_investigation).toBeDefined();

      const inReviewCase = await request(app).get(`/api/investigations/${caseId}`);
      expect(inReviewCase.body.status).toBe('IN_REVIEW');

      // 3. Human resolves case -> transitions to RESOLVED
      const resolveRes = await request(app)
        .post(`/api/investigations/${caseId}/resolve`)
        .send({
          resolution_reason: 'GATEWAY_ISSUE_CONFIRMED',
          resolution_notes: 'Reviewed and confirmed promotional rate difference.',
          resolved_by: 'Operator (Aaradhy)',
        });
      expect(resolveRes.status).toBe(200);
      expect(resolveRes.body.status).toBe('RESOLVED');

      // 4. Check active open exceptions: should be 0
      const summaryAfterResolve = dataStore.getSummary();
      expect(summaryAfterResolve.exceptions_open).toBe(0);
      expect(summaryAfterResolve.exceptions_resolved).toBe(1);

      // 5. Reopen case -> transitions back to OPEN
      const reopenRes = await request(app)
        .post(`/api/investigations/${caseId}/reopen`)
        .send({
          reopened_by: 'Operator (Aaradhy)',
          reopen_notes: 'Reopened for partner audit',
        });
      expect(reopenRes.status).toBe(200);
      expect(reopenRes.body.status).toBe('OPEN');
    });
  });

  describe('4. Benchmark vs Live Mode Switching & Isolation', () => {
    test('POST /api/demo/reset-synthetic loads benchmark without corrupting clean mode', async () => {
      const res = await request(app).post('/api/demo/reset-synthetic');
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe('SYNTHETIC');
      expect(res.body.total_settlement_records).toBeGreaterThanOrEqual(76);
      expect(res.body.exceptions).toBeGreaterThanOrEqual(24);
    });

    test('POST /api/demo/clear resets back to 0 records in LIVE mode', async () => {
      await request(app).post('/api/demo/reset-synthetic');
      expect(dataStore.getSummary().total_settlement_records).toBeGreaterThanOrEqual(76);

      const clearRes = await request(app).post('/api/demo/clear');
      expect(clearRes.status).toBe(200);
      expect(clearRes.body.total_settlement_records).toBe(0);
      expect(clearRes.body.mode).toBe('LIVE');
    });
  });
});
