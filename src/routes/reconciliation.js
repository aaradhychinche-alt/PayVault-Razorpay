'use strict';
/**
 * src/routes/reconciliation.js
 *
 * GET /api/reconciliation/summary
 * GET /api/reconciliation/results
 */

const express = require('express');
const router  = express.Router();
const store   = require('../store/dataStore');

// GET /api/reconciliation/summary
router.get('/summary', (req, res) => {
  try {
    return res.json(store.getSummary());
  } catch (err) {
    console.error('[recon/summary] Error:', err);
    return res.status(500).json({ error: 'Failed to compute reconciliation summary.' });
  }
});

// GET /api/reconciliation/results
// Optional query: ?status=MATCHED|EXCEPTION|PARTIALLY_MATCHED&category=FEE_TAX_VARIANCE
router.get('/results', (req, res) => {
  try {
    let results = store.getReconciliationResults();

    const { status, category } = req.query;
    if (status)   results = results.filter(r => r.status === status.toUpperCase());
    if (category) results = results.filter(r => r.exception_category === category.toUpperCase());

    // Enrich reconciliation results with canonical exception_id
    const exceptions = store.getExceptions();
    const enrichedResults = results.map(r => {
      const exc = exceptions.find(e => e.reconciliation_result_id === r.id);
      return {
        ...r,
        exception_id: exc ? (exc.id || exc.case_id) : null,
      };
    });

    return res.json({
      count: enrichedResults.length,
      results: enrichedResults,
      data_note: 'SYNTHETIC DATA — reconciliation results derived from synthetic settlement records.',
    });
  } catch (err) {
    console.error('[recon/results] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch reconciliation results.' });
  }
});

module.exports = router;
