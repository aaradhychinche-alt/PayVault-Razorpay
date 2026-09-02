'use strict';
/**
 * src/routes/exceptions.js
 *
 * GET /api/exceptions
 * GET /api/exceptions/:id
 */

const express = require('express');
const router  = express.Router();
const store   = require('../store/dataStore');

// GET /api/exceptions
// Optional query: ?category=MISSING_ORDER
router.get('/', (req, res) => {
  try {
    let exceptions = store.getExceptions();
    const { category } = req.query;
    if (category) exceptions = exceptions.filter(e => e.category === category.toUpperCase());

    return res.json({
      count: exceptions.length,
      exceptions,
      data_note: 'SYNTHETIC DATA — exceptions derived from synthetic settlement records.',
    });
  } catch (err) {
    console.error('[exceptions/list] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch exceptions.' });
  }
});

// GET /api/exceptions/:id
// Full exception detail with all source records — supports AI investigator (Chunk 2+)
router.get('/:id', (req, res) => {
  try {
    const detail = store.getExceptionDetail(req.params.id);
    if (!detail) {
      return res.status(404).json({ error: `Exception '${req.params.id}' not found.` });
    }
    return res.json({
      ...detail,
      data_note: 'SYNTHETIC DATA — all records are schema-accurate synthetic replicas.',
    });
  } catch (err) {
    console.error('[exceptions/detail] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch exception detail.' });
  }
});

module.exports = router;
