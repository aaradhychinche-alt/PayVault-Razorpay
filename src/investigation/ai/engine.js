'use strict';
/**
 * src/investigation/ai/engine.js
 *
 * Payvault AI Investigation Engine.
 *
 * ARCHITECTURE PIPELINE:
 * InvestigationCase
 *       ↓
 * Evidence Extraction (evidence.js)
 *       ↓
 * Pattern Detection (patterns.js)
 *       ↓
 * Model Router & Difficulty Evaluation (modelRouter.js + difficulty.js)
 *       ├── Straightforward Case → Payvault Local ML (Random Forest)
 *       └── Difficult Case       → Local Qwen Model (Ollama)
 *       ↓
 * AI Reasoning (reasoning.js)
 *       ↓
 * Measurable Confidence Calculation (confidence.js)
 *       ↓
 * Consistency & Anti-Hallucination Validation (consistency.js)
 *       ↓
 * Unified Output Formatting (formatter.js)
 */

const { extractEvidence }          = require('./evidence');
const { detectPatterns }           = require('./patterns');
const { reasonOverCase }           = require('./reasoning');
const { calculateConfidence }      = require('./confidence');
const { validateConsistency }      = require('./consistency');
const { formatReport }             = require('./formatter');
const { evaluateDifficulty }       = require('./difficulty');
const { defaultAdapter }           = require('./model/localModel');
const { defaultPayvaultModel }     = require('./model/payvaultModel');
const { defaultQwenModel }         = require('./model/qwenModel');
const { defaultModelRouter, ModelRouter } = require('./model/modelRouter');
const { buildIntelligenceContext } = require('../intelligence/context');
const { calibrateConfidence }      = require('../intelligence/calibration');
const dataStore                    = require('../../store/dataStore');

/**
 * Investigate an exception case using the Payvault AI Investigation Engine.
 *
 * @param {Object} investigationCase - Built deterministically by caseBuilder.buildCase()
 * @param {Object} [options]         - Optional execution overrides
 * @param {Object} [options.store]        - Custom dataStore instance
 * @param {Object} [options.router]       - Custom ModelRouter instance
 * @param {Object} [options.mlModel]      - Custom ML model instance
 * @param {Object} [options.qwenModel]    - Custom Qwen model instance
 * @returns {Promise<Object>} Unified AI investigation report
 */
async function investigate(investigationCase, options = {}) {
  const startMs = Date.now();
  const currentStore = options.store || dataStore.getStore();

  // ── Step 1: Extract Structured Evidence ───────────────────────────────────
  const evidence = extractEvidence(investigationCase);

  // ── Step 2: Detect Deterministic Patterns ──────────────────────────────────
  const patterns = detectPatterns(investigationCase, evidence);

  // ── Step 3: Build Historical & Cross-Transaction Intelligence Context ─────
  const intelligenceContext = buildIntelligenceContext({
    investigationCase,
    store: currentStore,
  });

  // ── Step 4: Run Model Router (Local ML + Difficulty Gating + Qwen Escalation)
  const router = options.router || (options.mlModel || options.qwenModel
    ? new ModelRouter({ primaryModel: options.mlModel, qwenModel: options.qwenModel })
    : defaultModelRouter);

  const routing = await router.route(investigationCase, options);

  // ── Step 5: AI Reasoning & Multi-Candidate Hypothesis Generation ──────────
  let reasoningOutput = reasonOverCase(investigationCase, evidence, patterns);

  // If local Qwen provided an escalated analysis, incorporate its refined insights
  if (routing.qwen_result && routing.qwen_result.success && routing.qwen_result.analysis) {
    const qa = routing.qwen_result.analysis;
    if (qa.what_happened) {
      reasoningOutput.primary_root_cause.cause = qa.what_happened;
    }
    if (qa.recommended_action) {
      reasoningOutput.recommended_actions = [
        {
          action_type: 'RECOMMENDED_RESOLUTION',
          priority: 'HIGH',
          description: qa.recommended_action,
          resolution_hint: qa.recommended_action,
        },
        ...(reasoningOutput.recommended_actions || []),
      ];
    }
  }

  // ── Step 6: Measurable Confidence Calculation & Calibration ───────────────
  const baseConfidence = calculateConfidence({
    primaryRootCause: reasoningOutput.primary_root_cause,
    evidence,
    patterns,
    investigationCase,
  });

  let confidenceOutput = calibrateConfidence({
    baseConfidence,
    historicalContext: intelligenceContext.historical_context,
    anomalyContext:    intelligenceContext.anomaly_context,
    memoryContext:     intelligenceContext.memory_context,
    patterns:          intelligenceContext.historical_context.repeated_patterns,
    investigationCase,
  });

  // ── Step 7: Consistency & Anti-Hallucination Validation ───────────────────
  const validation = validateConsistency({
    investigationCase,
    evidence,
    reasoningOutput,
    confidenceOutput,
  });

  if (!validation.isValid) {
    reasoningOutput  = validation.adjustedReasoning;
    confidenceOutput = validation.adjustedConfidence;
  }

  // ── Step 8: Unified Output Formatting ─────────────────────────────────────
  const report = formatReport({
    investigationCase,
    evidence,
    patterns,
    reasoning: reasoningOutput,
    confidence: confidenceOutput,
    validation,
    mlAnalysis: routing.ml_result,
    modelInfo: {
      model: routing.selected_model,
      mode: 'LOCAL',
      local_inference_available: true,
    },
    intelligenceContext,
    routing,
  });

  report.latency_ms = Date.now() - startMs;

  // Attach internal diagnostics for debugging/testing
  report._diagnostics = {
    engine: 'payvault_ai',
    routing_state: routing.internal_state,
    selected_model: routing.selected_model,
    difficulty_score: routing.difficulty.difficultyScore,
    difficulty_reasons: routing.difficulty.reasons,
    qwen_escalated: !!routing.qwen_result,
    is_consistent: validation.isValid,
    history_available: intelligenceContext.intelligence_metadata.history_available,
    similar_cases_count: intelligenceContext.historical_context.similar_cases.length,
    anomalies_count: intelligenceContext.anomaly_context.anomalies.length,
  };

  return report;
}

module.exports = {
  investigate,
  extractEvidence,
  detectPatterns,
  reasonOverCase,
  calculateConfidence,
  calibrateConfidence,
  validateConsistency,
  formatReport,
  evaluateDifficulty,
  buildIntelligenceContext,
};
