'use strict';
/**
 * src/investigation/ai/model/modelRouter.js
 *
 * Upgraded Payvault Model Router.
 *
 * Orchestrates intelligent model routing:
 *  - Primary: Payvault Local ML (Random Forest, 38 features)
 *  - Fallback / Escalation: Local Qwen Model (via local Ollama runtime)
 *
 * Internal Decision Lifecycle:
 *  - LOCAL_MODEL_SUFFICIENT: Straightforward case handled by primary intelligence
 *  - ESCALATE_TO_QWEN: Difficult/ambiguous case routed to local Qwen
 *  - QWEN_FAILED: Qwen runtime offline/timed-out, gracefully fallback to primary
 *  - FINAL_ANALYSIS_READY: Validated analysis ready for formatting
 */

const { PayvaultLocalModel, defaultPayvaultModel } = require('./payvaultModel');
const { QwenLocalModel, defaultQwenModel }         = require('./qwenModel');
const { evaluateDifficulty }                       = require('../difficulty');

class ModelRouter {
  constructor(options = {}) {
    this.primaryModel = options.primaryModel || defaultPayvaultModel;
    this.qwenModel    = options.qwenModel || defaultQwenModel;
    
    // CRITICAL FIX: Qwen/Ollama must be explicitly enabled, NOT default
    // Check for explicit true value, not just absence of 'false'
    this.qwenEnabled  = options.qwenEnabled !== undefined
      ? options.qwenEnabled
      : (process.env.ENABLE_OLLAMA === 'true' || process.env.AI_QWEN_ENABLED === 'true');
  }

  /**
   * Route and execute investigation on a case.
   *
   * @param {Object} investigationCase - Standard InvestigationCase
   * @param {Object} [options]         - Routing overrides
   * @returns {Promise<Object>} Internal routing result + model analysis
   */
  async route(investigationCase, options = {}) {
    let internalState = 'LOCAL_MODEL_SUFFICIENT';
    let selectedModel = 'Payvault Local ML';
    let qwenResult = null;
    let mlResult = null;

    // ── Step 1: Run Primary Payvault Local ML Inference ─────────────────────
    try {
      mlResult = await this.primaryModel.predict(investigationCase);
    } catch (err) {
      mlResult = {
        model: 'Payvault Local ML',
        predicted_category: investigationCase.exception_category,
        confidence: 0.80,
        probabilities: { [investigationCase.exception_category]: 0.80 },
        top_features: [],
        warning: `Primary ML fallback: ${err.message}`,
      };
    }

    // ── Step 2: Evaluate Multi-Signal Case Difficulty ───────────────────────
    const difficulty = evaluateDifficulty(investigationCase, mlResult, options);

    // ── Step 3: Optional Qwen Enhancement (Only if explicitly enabled) ─────────
    let qwenInvoked = false;
    let fallbackUsed = false;
    let fallbackReason = null;

    // CRITICAL FIX: Only invoke Qwen if explicitly enabled AND (forced OR escalation needed)
    if (this.qwenEnabled && (options.forceQwen || difficulty.shouldEscalate)) {
      try {
        const isQwenAvail = await this.qwenModel.isAvailable();
        if (isQwenAvail) {
          const t0 = Date.now();
          console.log(`[AI Trace] Starting Qwen inference for case ${investigationCase.case_id} via Ollama (${this.qwenModel.model})...`);
          qwenResult = await this.qwenModel.investigate(investigationCase);
          qwenInvoked = true;

          if (qwenResult && qwenResult.success && qwenResult.analysis) {
            internalState = 'FINAL_ANALYSIS_READY';
            selectedModel = `Qwen (${this.qwenModel.model})`;
            console.log(`[AI Trace] Qwen inference completed in ${Date.now() - t0}ms for case ${investigationCase.case_id}`);
          } else {
            internalState = 'QWEN_FAILED';
            fallbackUsed = true;
            fallbackReason = qwenResult?.reason || 'QWEN_INVALID_JSON';
            selectedModel = 'Payvault Local Intelligence';
            console.log(`[AI Trace] Qwen returned unparseable output (${fallbackReason}). Falling back to Payvault Local Intelligence.`);
          }
        } else {
          internalState = 'LOCAL_MODEL_SUFFICIENT';
          fallbackUsed = true;
          fallbackReason = 'OLLAMA_UNAVAILABLE';
          selectedModel = 'Payvault Local Intelligence';
          console.log(`[AI Trace] Ollama runtime not available on ${this.qwenModel.baseUrl}. Using Payvault Local Intelligence.`);
        }
      } catch (err) {
        internalState = 'QWEN_FAILED';
        fallbackUsed = true;
        fallbackReason = err.message;
        selectedModel = 'Payvault Local Intelligence';
        console.log(`[AI Trace] Qwen execution error (${err.message}). Using Payvault Local Intelligence.`);
      }
    } else {
      // Qwen disabled or not needed - use Payvault local intelligence
      internalState = 'LOCAL_MODEL_SUFFICIENT';
      selectedModel = 'Payvault Local Intelligence';
      if (!this.qwenEnabled) {
        console.log(`[AI Trace] Qwen/Ollama disabled (ENABLE_OLLAMA not set to 'true'). Using Payvault Local Intelligence for case ${investigationCase.case_id}.`);
      }
    }

    return {
      routed_to: (internalState === 'FINAL_ANALYSIS_READY') ? 'LOCAL_QWEN' : 'PRIMARY_ML',
      internal_state: internalState,
      selected_model: selectedModel,
      qwen_invoked: qwenInvoked,
      fallback_used: fallbackUsed,
      fallback_reason: fallbackReason,
      difficulty,
      ml_result: mlResult,
      qwen_result: qwenResult,
    };
  }
}

const defaultModelRouter = new ModelRouter();

module.exports = {
  ModelRouter,
  defaultModelRouter,
};
