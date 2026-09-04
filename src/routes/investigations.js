'use strict';
/**
 * src/routes/investigations.js
 *
 * GET  /api/investigations                         — list all investigation cases (lightweight with lifecycle)
 * GET  /api/investigations/config/resolution-reasons — list valid resolution reason enums & labels
 * GET  /api/investigations/:id                     — get a fully built investigation case (with status & audit trail)
 * POST /api/investigations/:id/run                 — run AI investigation on a case & transition to IN_REVIEW
 * POST /api/investigations/:id/resolve             — resolve an exception case with human justification
 * POST /api/investigations/:id/reopen              — reopen a resolved exception case
 * GET  /api/investigations/:id/audit               — get append-only audit trail for a case
 * POST /api/investigations/:id/chat                — case-aware AI chat (Ask Payvault AI)
 *
 * DESIGN NOTES:
 * - AI engine NEVER automatically marks cases as RESOLVED.
 * - Human operators always review evidence and make final resolution decisions.
 * - All state transitions append to the audit log.
 * - Chat is a read-only explanation layer; it never changes case state.
 */

const express                       = require('express');
const router                        = express.Router();
const store                         = require('../store/dataStore');
const { buildCase }                 = require('../investigation/caseBuilder');
const { investigate }               = require('../investigation/ai/engine');
const { buildIntelligenceContext }  = require('../investigation/intelligence/context');
const { buildChatContext }          = require('../investigation/chat/chatContextBuilder');
const { generateLocalAnswer }       = require('../investigation/chat/localChatEngine');
const { defaultOllamaChatEngine }   = require('../investigation/chat/ollamaChatEngine');
const { routeAndAnswerChat }        = require('../investigation/chat/chatRouter');
const {
  CaseStatus,
  ResolutionReason,
  ResolutionReasonDetails,
  isValidResolutionReason,
} = require('../models/resolution');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a lightweight summary of all exception cases including lifecycle status.
 * Does NOT build full InvestigationCases — fast O(n) list.
 */
function buildCaseList() {
  const exceptions = store.getExceptions();
  const s          = store.getStore();

  return exceptions.map(exc => {
    const rr = s.reconciliationResults.find(r => r.id === exc.reconciliation_result_id);
    const lifecycle = store.getCaseLifecycle(exc.id);

    return {
      id:                   exc.id,
      case_id:              exc.id,
      exception_category:   exc.category,
      amount_at_risk:       exc.amount_at_risk,
      status:               lifecycle.status,
      reconciliation_status: rr ? rr.status : 'UNKNOWN',
      resolution:           lifecycle.resolution || null,
      settlement_entity_id: rr ? rr.settlement_entity_id : null,
      merchant_order_id:    rr ? rr.merchant_order_id    : null,
      created_at:           exc.created_at,
      description:          exc.description,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/investigations/config/resolution-reasons
// ─────────────────────────────────────────────────────────────────────────────
router.get('/config/resolution-reasons', (req, res) => {
  try {
    const reasons = Object.keys(ResolutionReason).map(key => {
      const details = ResolutionReasonDetails[key] || {};
      return {
        id:          key,
        label:       details.label || key,
        description: details.description || '',
        category:    details.category || 'GENERAL',
      };
    });
    return res.json({ reasons });
  } catch (err) {
    console.error('[investigations/config/reasons] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch resolution reasons configuration.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/investigations
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    let caseList = buildCaseList();

    // Calculate status counts across all cases before filtering
    const statusCounts = {
      total:     caseList.length,
      open:      caseList.filter(c => c.status === CaseStatus.OPEN).length,
      in_review: caseList.filter(c => c.status === CaseStatus.IN_REVIEW).length,
      resolved:  caseList.filter(c => c.status === CaseStatus.RESOLVED).length,
    };

    // Filter by status (?status=OPEN | IN_REVIEW | RESOLVED | ALL)
    const { status, category } = req.query;
    if (status && status.toUpperCase() !== 'ALL') {
      caseList = caseList.filter(c => c.status === status.toUpperCase());
    }

    // Filter by category (?category=FEE_TAX_VARIANCE)
    if (category && category.toUpperCase() !== 'ALL') {
      caseList = caseList.filter(c => c.exception_category === category.toUpperCase());
    }

    const s = store.getStore();
    return res.json({
      count:         caseList.length,
      status_counts: statusCounts,
      mode:          s.mode,
      cases:         caseList,
      data_note:     s.mode === 'RAZORPAY_BACKED'
        ? 'Transaction data is from Razorpay Test Mode; settlement records are simulated.'
        : 'All data is synthetic. Simulated for demonstration.',
    });
  } catch (err) {
    console.error('[investigations/list] Error:', err);
    return res.status(500).json({ error: 'Failed to list investigation cases.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/investigations/:id
// Returns the full deterministic InvestigationCase with lifecycle, audit trail,
// and historical intelligence context.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  try {
    const s         = store.getStore();
    const exception = s.exceptions.find(e => e.id === req.params.id);

    if (!exception) {
      return res.status(404).json({ error: `Investigation case '${req.params.id}' not found.` });
    }

    const reconResult = s.reconciliationResults.find(
      r => r.id === exception.reconciliation_result_id,
    );
    if (!reconResult) {
      return res.status(500).json({ error: `Reconciliation result not found for exception '${req.params.id}'.` });
    }

    const investigationCase   = buildCase({ exception, reconResult, store: s });
    const lifecycle           = store.getCaseLifecycle(exception.id);
    const auditTrail          = store.getCaseAuditTrail(exception.id);
    const intelligenceContext = buildIntelligenceContext({ investigationCase, store: s });
    const savedAi             = store.getAiInvestigation(exception.id);

    return res.json({
      ...investigationCase,
      status:               lifecycle.status,
      resolution:           lifecycle.resolution || null,
      audit_trail:          auditTrail,
      intelligence_context: intelligenceContext,
      ai_investigation:     savedAi || null,
      _note: 'Deterministic case with lifecycle & historical intelligence. POST /api/investigations/:id/run to add AI analysis, POST /resolve to mark resolved.',
    });
  } catch (err) {
    console.error('[investigations/detail] Error:', err);
    return res.status(500).json({ error: 'Failed to build investigation case.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/investigations/:id/intelligence
// Returns the standalone structured InvestigationIntelligenceContext (Chunk 4).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/intelligence', (req, res) => {
  try {
    const s         = store.getStore();
    const exception = s.exceptions.find(e => e.id === req.params.id);

    if (!exception) {
      return res.status(404).json({ error: `Investigation case '${req.params.id}' not found.` });
    }

    const reconResult = s.reconciliationResults.find(
      r => r.id === exception.reconciliation_result_id,
    );
    if (!reconResult) {
      return res.status(500).json({ error: `Reconciliation result not found for exception '${req.params.id}'.` });
    }

    const investigationCase   = buildCase({ exception, reconResult, store: s });
    const intelligenceContext = buildIntelligenceContext({ investigationCase, store: s });

    return res.json(intelligenceContext);
  } catch (err) {
    console.error('[investigations/intelligence] Error:', err);
    return res.status(500).json({ error: 'Failed to build investigation intelligence context.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/investigations/:id/run
// Runs AI investigation on a case and transitions status to IN_REVIEW.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/run', async (req, res) => {
  try {
    const s         = store.getStore();
    const exception = s.exceptions.find(e => e.id === req.params.id);

    if (!exception) {
      return res.status(404).json({ error: `Investigation case '${req.params.id}' not found.` });
    }

    const reconResult = s.reconciliationResults.find(
      r => r.id === exception.reconciliation_result_id,
    );
    if (!reconResult) {
      return res.status(500).json({ error: `Reconciliation result not found for exception '${req.params.id}'.` });
    }

    // Build the deterministic case first
    const investigationCase = buildCase({ exception, reconResult, store: s });

    console.log(`[POST /investigations/${req.params.id}/run] Starting AI investigation...`);

    // Transition case to IN_REVIEW if currently OPEN
    const updatedLifecycle = store.setCaseInReview(
      exception.id,
      req.body?.actor || 'user',
      'AI investigation initiated and case reviewed',
    );

    // Run AI investigation
    const aiAnalysis = await investigate(investigationCase);
    store.saveAiInvestigation(exception.id, aiAnalysis);

    return res.json({
      case_id:            investigationCase.case_id,
      exception_category: investigationCase.exception_category,
      amount_at_risk:     investigationCase.amount_at_risk,
      status:             updatedLifecycle.status,
      resolution:         updatedLifecycle.resolution || null,
      // Deterministic context preserved alongside AI result
      financial_analysis: investigationCase.financial_analysis,
      timeline:           investigationCase.timeline,
      relationships:      investigationCase.relationships,
      suggested_actions:  investigationCase.suggested_actions,
      data_sources:       investigationCase.data_sources,
      generated_at_iso:   investigationCase.generated_at_iso,
      // AI layer output
      ai_investigation:   aiAnalysis,
    });
  } catch (err) {
    console.error('[investigations/run] Error:', err);
    return res.status(500).json({ error: `AI investigation failed: ${err.message}` });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/investigations/:id/resolve
// Human resolution of an exception case.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/resolve', (req, res) => {
  try {
    const { id } = req.params;
    const { resolution_reason, resolution_notes, resolved_by } = req.body || {};

    if (!resolution_reason) {
      return res.status(400).json({
        error: 'resolution_reason is required.',
        valid_reasons: Object.keys(ResolutionReason),
      });
    }

    if (!isValidResolutionReason(resolution_reason)) {
      return res.status(400).json({
        error: `Invalid resolution_reason '${resolution_reason}'.`,
        valid_reasons: Object.keys(ResolutionReason),
      });
    }

    const s = store.getStore();
    const exception = s.exceptions.find(e => e.id === id);
    if (!exception) {
      return res.status(404).json({ error: `Investigation case '${id}' not found.` });
    }

    const updatedLifecycle = store.resolveCase(id, {
      resolution_reason,
      resolution_notes: resolution_notes || '',
      resolved_by:      resolved_by || 'user',
    });

    const auditTrail = store.getCaseAuditTrail(id);

    return res.json({
      success:    true,
      case_id:    id,
      status:     updatedLifecycle.status,
      resolution: updatedLifecycle.resolution,
      audit_trail: auditTrail,
      message:    `Case ${id} successfully marked as RESOLVED.`,
    });
  } catch (err) {
    console.error('[investigations/resolve] Error:', err);
    return res.status(500).json({ error: `Failed to resolve investigation case: ${err.message}` });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/investigations/:id/reopen
// Reopen a resolved exception case back to OPEN while preserving audit history.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/reopen', (req, res) => {
  try {
    const { id } = req.params;
    const { reopen_notes, reopened_by } = req.body || {};

    const s = store.getStore();
    const exception = s.exceptions.find(e => e.id === id);
    if (!exception) {
      return res.status(404).json({ error: `Investigation case '${id}' not found.` });
    }

    const current = store.getCaseLifecycle(id);
    if (current.status !== CaseStatus.RESOLVED) {
      return res.status(400).json({
        error: `Cannot reopen case '${id}' because it is not in RESOLVED status (current: ${current.status}).`,
      });
    }

    const updatedLifecycle = store.reopenCase(id, {
      reopen_notes: reopen_notes || 'Case reopened by operator.',
      reopened_by:  reopened_by  || 'user',
    });

    const auditTrail = store.getCaseAuditTrail(id);

    return res.json({
      success:     true,
      case_id:     id,
      status:      updatedLifecycle.status,
      resolution:  null,
      audit_trail: auditTrail,
      message:     `Case ${id} successfully reopened to OPEN status.`,
    });
  } catch (err) {
    console.error('[investigations/reopen] Error:', err);
    return res.status(500).json({ error: `Failed to reopen investigation case: ${err.message}` });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/investigations/:id/audit
// Returns append-only audit trail for a case.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/audit', (req, res) => {
  try {
    const { id } = req.params;
    const s = store.getStore();
    const exception = s.exceptions.find(e => e.id === id);
    if (!exception) {
      return res.status(404).json({ error: `Investigation case '${id}' not found.` });
    }

    const auditTrail = store.getCaseAuditTrail(id);
    return res.json({
      case_id:     id,
      count:       auditTrail.length,
      audit_trail: auditTrail,
    });
  } catch (err) {
    console.error('[investigations/audit] Error:', err);
    return res.status(500).json({ error: `Failed to fetch audit trail: ${err.message}` });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/investigations/:id/chat
//
// Case-aware "Ask Payvault AI" chat endpoint.
//
// Request body:
//   { message: string, history?: [{role: 'operator'|'payvault', content: string}] }
//
// Response:
//   { answer, source, case_id, ai_used, model, intent }
//
// RULES:
// - Never exposes secrets, credentials, or unrelated merchant data.
// - Never modifies case state.
// - Financial facts come exclusively from the deterministic Payvault case data.
// - Ollama is ONLY used when ENABLE_OLLAMA=true AND actually available.
// - Always falls back to Payvault Local Intelligence when Ollama is absent/disabled.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/chat', async (req, res) => {
  try {
    const { id } = req.params;
    const { message, history = [] } = req.body || {};

    // ── Validate inputs ────────────────────────────────────────────────────
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'message is required and must be a non-empty string.' });
    }
    if (message.trim().length > 1000) {
      return res.status(400).json({ error: 'message must be 1000 characters or fewer.' });
    }
    if (!Array.isArray(history)) {
      return res.status(400).json({ error: 'history must be an array.' });
    }

    // ── Load case data ─────────────────────────────────────────────────────
    const s         = store.getStore();
    const exception = s.exceptions.find(e => e.id === id);
    if (!exception) {
      return res.status(404).json({ error: `Investigation case '${id}' not found.` });
    }

    const reconResult = s.reconciliationResults.find(
      r => r.id === exception.reconciliation_result_id,
    );
    if (!reconResult) {
      return res.status(500).json({ error: `Reconciliation result not found for case '${id}'.` });
    }

    // ── Build context ──────────────────────────────────────────────────────
    const investigationCase   = buildCase({ exception, reconResult, store: s });
    const lifecycle           = store.getCaseLifecycle(id);
    const intelligenceContext = buildIntelligenceContext({ investigationCase, store: s });
    const savedAi             = store.getAiInvestigation(id);

    const ctx = buildChatContext({
      investigationCase,
      lifecycle,
      intelligenceContext,
      savedAi,
    });

    // ── Execute Payvault AI Hybrid Copilot ─────────────────────────────────
    // Payvault AI Core is the primary controller. Straightforward queries are
    // answered directly with high confidence. Complex queries request internal
    // assistance from the local model, followed by validation.
    const chatResult = await routeAndAnswerChat({
      message: message.trim(),
      ctx,
      history,
    });

    return res.json({
      answer:         chatResult.answer,
      source:         chatResult.source,
      case_id:        id,
      ai_used:        chatResult.execution_mode === 'HYBRID_ASSISTED',
      model:          'Payvault AI',
      execution_mode: chatResult.execution_mode,
      intent:         chatResult.intent,
      confidence:     chatResult.confidence,
    });

  } catch (err) {
    console.error('[investigations/chat] Error:', err);
    return res.status(500).json({ error: `Chat request failed: ${err.message}` });
  }
});

module.exports = router;
