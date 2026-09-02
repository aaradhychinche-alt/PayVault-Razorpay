'use strict';
/**
 * src/routes/demo.js
 *
 * Demo endpoints:
 *   POST /api/demo/reset          — Regenerates the deterministic synthetic dataset (Mode A).
 *   POST /api/demo/sync-razorpay  — Fetches real Razorpay Test Mode data & runs settlement simulator (Mode B).
 */

const express = require('express');
const router  = express.Router();
const store   = require('../store/dataStore');

// POST /api/demo/reset (Mode A: Full Synthetic)
router.post('/reset', (req, res) => {
  try {
    store.reset();
    const summary = store.getSummary();
    return res.json({
      success: true,
      mode: 'SYNTHETIC',
      message: 'Demo dataset reset to deterministic synthetic baseline. Results are identical on every run.',
      summary,
    });
  } catch (err) {
    console.error('[demo/reset] Error:', err);
    return res.status(500).json({ error: 'Failed to reset demo dataset.' });
  }
});

// POST /api/demo/reset-synthetic (Explicit Synthetic Benchmark)
router.post('/reset-synthetic', (req, res) => {
  try {
    store.reset();
    const summary = store.getSummary();
    return res.json({
      success: true,
      mode: 'SYNTHETIC',
      message: '79-record deterministic benchmark dataset loaded successfully.',
      ...summary,
      summary,
    });
  } catch (err) {
    console.error('[demo/reset-synthetic] Error:', err);
    return res.status(500).json({ error: 'Failed to load synthetic benchmark.' });
  }
});

// POST /api/demo/clear (Reset to empty LIVE session)
router.post('/clear', (req, res) => {
  try {
    store.clear();
    const summary = store.getSummary();
    return res.json({
      success: true,
      mode: 'LIVE',
      message: 'Application store cleared to empty state.',
      ...summary,
      summary,
    });
  } catch (err) {
    console.error('[demo/clear] Error:', err);
    return res.status(500).json({ error: 'Failed to clear store.' });
  }
});

// POST /api/demo/sync-razorpay (Mode B: Razorpay-Backed Simulated Settlements)
router.post('/sync-razorpay', async (req, res) => {
  try {
    const updatedStore = await store.syncRazorpay();
    const summary = store.getSummary();

    const paymentsFetched = updatedStore.stats.payments_count;
    const ordersFetched   = updatedStore.stats.orders_count;
    const refundsFetched  = updatedStore.stats.refunds_count;

    if (paymentsFetched === 0) {
      return res.json({
        success: true,
        source: 'razorpay_test_mode',
        settlement_mode: 'simulated',
        orders_fetched: ordersFetched,
        payments_fetched: 0,
        refunds_fetched: refundsFetched,
        settlement_batches_simulated: 0,
        settlement_records_generated: 0,
        exceptions_detected: 0,
        amount_reconciled: 0,
        amount_at_risk: 0,
        message: 'No captured Razorpay payments found in Test Mode account; no settlement records generated. Use the checkout modal to make a test payment first.',
        summary,
      });
    }

    return res.json({
      success: true,
      source: 'razorpay_test_mode',
      settlement_mode: 'simulated',
      orders_fetched: ordersFetched,
      payments_fetched: paymentsFetched,
      refunds_fetched: refundsFetched,
      settlement_batches_simulated: updatedStore.settlementBatches.length,
      settlement_records_generated: updatedStore.settlementRecords.length,
      exceptions_detected: updatedStore.exceptions.length,
      amount_reconciled: summary.total_amount_paise,
      amount_at_risk: summary.amount_at_risk_paise,
      summary,
    });
  } catch (err) {
    console.error('[demo/sync-razorpay] Error:', err);

    if (err.statusCode === 401 || (err.error && err.error.code === 'BAD_REQUEST_ERROR')) {
      return res.status(401).json({
        error: 'Razorpay authentication failed. Please verify your RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env.',
      });
    }

    return res.status(500).json({
      error: `Failed to sync from Razorpay: ${err.message || 'Unknown error'}`,
    });
  }
});

module.exports = router;
