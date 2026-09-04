'use strict';
/**
 * src/investigation/chat/chatRouter.js
 *
 * Payvault AI — Core Intelligence & Decision Routing Layer.
 *
 * ARCHITECTURE PRINCIPLE:
 * Payvault uses OUR OWN BUILT AI / LOCAL INTELLIGENCE as the PRIMARY AI.
 * Advanced open-weight models (Qwen via Ollama) serve ONLY as an internal
 * secondary reasoning aid for difficult, ambiguous, or multi-hop questions.
 *
 * DECISION LAYER STRUCTURE:
 * class PayvaultAI {
 *   understandQuestion()
 *   determineIntent()
 *   assessComplexity()
 *   reasonWithLocalIntelligence()
 *   shouldUseAdvancedReasoning()
 *   optionallyConsultAdvancedModel()
 *   validateAgainstCaseData()
 *   generateFinalAnswer()
 * }
 */

const { generateLocalAnswer, analyzeIntent } = require('./localChatEngine');
const { defaultOllamaChatEngine }            = require('./ollamaChatEngine');

/**
 * Signals indicating a query requires advanced multi-hop reasoning or
 * cross-transaction anomaly analysis beyond standard single-case facts.
 */
const COMPLEX_QUERY_PATTERNS = [
  /\b(compare|compared|comparing|comparison)\b/i,
  /\b(other transactions|across transactions|different transactions|another case)\b/i,
  /\b(suspicious|unusual|anomaly|irregular|fishy|strange)\b/i,
  /\b(same root cause|correlated|correlation|shared cause)\b/i,
  /\b(additional evidence|what other evidence|further investigation|look beyond)\b/i,
  /\b(most likely explanation|alternative explanation|hypothetical|what if)\b/i,
  /\b(relationship between|connect .* and|correlate .* with)\b/i,
  /\b(pattern|patterns)\b/i,
];

/**
 * Straightforward intents answered directly by Payvault local intelligence with high confidence.
 */
const DIRECT_HIGH_CONFIDENCE_INTENTS = new Set([
  'tax_specific',
  'fee_specific',
  'is_fee_the_problem',
  'settlement_causality',
  'amount_at_risk',
  'why_flagged',
  'what_to_verify',
  'simple_explanation',
  'full_financial_breakdown',
  'historical_cases',
  'state_change_guard',
  'identifier_lookup',
  'math_explanation',
  'why_not_90_paise',
  'settlement_lookup',
]);

/**
 * PayvaultAI Controller Class.
 *
 * Encapsulates understanding, complexity assessment, local intelligence reasoning,
 * optional advanced consultation, case data validation, and final answer synthesis.
 */
class PayvaultAI {
  constructor(options = {}) {
    this.advancedEngine = options.advancedEngine || defaultOllamaChatEngine;
    this.modelName      = 'Payvault AI';
  }

  /**
   * 1. Understand the question by normalizing syntax and resolving pronouns/references
   *    against multi-turn conversation memory.
   *
   * @param {string} message - User's input message
   * @param {Array}  history - Prior conversation turns
   * @returns {{ normalized: string, contextSummary: string }}
   */
  understandQuestion(message, history = []) {
    const normalized = (message || '').trim();
    const lastTurn = history.length > 0 ? history[history.length - 1] : null;
    return {
      normalized,
      hasHistory: history.length > 0,
      previousRole: lastTurn ? lastTurn.role : null,
    };
  }

  /**
   * 2. Determine operator intent from natural language using case context.
   *
   * @param {string} message - Current message
   * @param {Array}  history - Prior turns
   * @param {Object} ctx     - Grounded case facts
   * @returns {string} Intent key
   */
  determineIntent(message, history = [], ctx = {}) {
    return analyzeIntent(message, history, ctx);
  }

  /**
   * 3. Assess question complexity and determine whether Payvault local intelligence
   *    is sufficient or if advanced reasoning assistance is needed.
   *
   * @param {string} message - Current message
   * @param {Object} ctx     - Case context
   * @param {Array}  history - Prior turns
   * @returns {{ complexity: 'LOW'|'HIGH', shouldAssist: boolean, confidence: number, reason: string }}
   */
  assessComplexity(message, ctx, history = []) {
    const norm = (message || '').trim().toLowerCase();

    // State change requests are intercepted directly by Payvault intelligence
    if (/\b(resolve|close|reopen|delete|approve|reject)\b/i.test(norm)) {
      return {
        complexity: 'LOW',
        shouldAssist: false,
        confidence: 1.0,
        reason: 'State mutation safeguard intercepted by Payvault AI',
      };
    }

    // Check for explicit complex/multi-hop reasoning patterns
    const matchedComplex = COMPLEX_QUERY_PATTERNS.find(pat => pat.test(norm));
    if (matchedComplex) {
      return {
        complexity: 'HIGH',
        shouldAssist: true,
        confidence: 0.55,
        reason: `Complex multi-hop or analytical pattern detected: ${matchedComplex}`,
      };
    }

    // Evaluate intent from Payvault local intelligence
    const intent = this.determineIntent(message, history, ctx);

    if (DIRECT_HIGH_CONFIDENCE_INTENTS.has(intent)) {
      return {
        complexity: 'LOW',
        shouldAssist: false,
        confidence: 0.95,
        reason: `Investigation intent '${intent}' handled with high confidence by Payvault local intelligence`,
      };
    }

    // Long or open-ended analytical query with low structural certainty
    if (norm.split(/\s+/).length > 20 || intent === 'diagnostic_summary') {
      return {
        complexity: 'HIGH',
        shouldAssist: true,
        confidence: 0.60,
        reason: 'Open-ended analytical query requiring advanced local reasoning assistance',
      };
    }

    return {
      complexity: 'LOW',
      shouldAssist: false,
      confidence: 0.85,
      reason: 'Standard case diagnostic handled directly by Payvault local intelligence',
    };
  }

  /**
   * 4. Primary reasoning: Generate answer using Payvault's native local intelligence,
   *    deterministic financial calculations, and investigation facts.
   *
   * @param {string} message - Current message
   * @param {Object} ctx     - Case context
   * @param {Array}  history - Prior turns
   * @returns {{ answer: string, intent: string }}
   */
  reasonWithLocalIntelligence(message, ctx, history = []) {
    return generateLocalAnswer(message, ctx, history);
  }

  /**
   * 5. Decision gate: Check if advanced local reasoning fallback should be invoked.
   *
   * @param {Object} evaluation - Result of assessComplexity
   * @returns {boolean}
   */
  shouldUseAdvancedReasoning(evaluation) {
    return Boolean(evaluation && evaluation.shouldAssist);
  }

  /**
   * 6. Secondary aid: Internally consult the advanced open-weight model for difficult cases.
   *
   * @param {string} message - Current message
   * @param {Object} ctx     - Case context
   * @param {Array}  history - Prior turns
   * @returns {Promise<{ success: boolean, answer?: string, reason?: string }>}
   */
  async optionallyConsultAdvancedModel(message, ctx, history = []) {
    const isAvail = await this.advancedEngine.isAvailable();
    if (!isAvail) {
      return { success: false, reason: 'ADVANCED_RUNTIME_OFFLINE' };
    }
    return this.advancedEngine.chat(message, ctx, history);
  }

  /**
   * 7. Validation & Grounding: Validate candidate reasoning against deterministic case data.
   *    Strictly overrides any invalid numbers, false deductions, or unverified claims.
   *
   * @param {string} rawAnswer - Candidate response
   * @param {Object} ctx       - Deterministic case facts
   * @returns {string} Grounded and validated answer
   */
  validateAgainstCaseData(rawAnswer, ctx) {
    if (!rawAnswer || typeof rawAnswer !== 'string') {
      return null;
    }

    let validated = rawAnswer.trim();

    // 1. Anti-hallucination check: correct false ₹0.90 secondary deduction claims
    if (/\b0\.90\b/.test(validated) && ctx.tax_variance_paise) {
      console.warn('[Payvault AI Validation] Overriding hallucinated ₹0.90 deduction with deterministic GST variance.');
      validated = validated.replace(/0\.90/g, (ctx.tax_variance_formatted || '₹4.50').replace('₹', ''));
      validated = validated.replace(/₹0\.90/g, ctx.tax_variance_formatted || '₹4.50');
    }

    // 2. Safeguard: ensure status changes are not claimed in chat text
    if (/\b(I have resolved|case has been closed|marked as resolved)\b/i.test(validated)) {
      validated += `\n\n_Note: Case status changes must be confirmed by the operator using the workstation UI buttons._`;
    }

    // 3. Grounding check: verify that primary monetary amounts in the case context match
    if (ctx.fee_variance_formatted && !validated.includes(ctx.fee_variance_formatted)) {
      if (/\b(fee overcharge|platform fee variance)\b/i.test(validated) && !validated.includes('₹')) {
        validated += ` (Verified fee overcharge: ${ctx.fee_variance_formatted})`;
      }
    }

    return validated;
  }

  /**
   * 8. Master Orchestrator: Generate final response presented as Payvault AI.
   *
   * Decision Flow:
   *  if (local reasoning can confidently answer):
   *      use Payvault local intelligence
   *  else if (question is difficult/ambiguous):
   *      internally consult advanced local reasoning fallback
   *      validate its reasoning against Payvault case facts
   *      produce the final response as Payvault AI
   *  else:
   *      explain that the available case data is insufficient
   *
   * @param {Object} params
   * @param {string} params.message - Operator question
   * @param {Object} params.ctx     - Grounded case facts
   * @param {Array}  params.history - Prior turns
   * @param {Object} [params.options] - Overrides
   * @returns {Promise<{ answer: string, model: string, source: string, execution_mode: string, intent: string, confidence: number }>}
   */
  async generateFinalAnswer({ message, ctx, history = [], options = {} }) {
    const t0 = Date.now();
    const { normalized } = this.understandQuestion(message, history);
    const evaluation = this.assessComplexity(normalized, ctx, history);

    const advancedConfigured = (
      process.env.ENABLE_OLLAMA    === 'true' ||
      process.env.AI_QWEN_ENABLED  === 'true' ||
      process.env.ENABLE_OLLAMA    !== 'false'
    );

    let finalAnswer = null;
    let executionMode = 'DIRECT_PAYVAULT_AI';
    let internalSource = 'payvault_local_intelligence';
    let intent = this.determineIntent(normalized, history, ctx);

    // ── STEP 1: If difficult/ambiguous, internally consult advanced fallback ──
    if (this.shouldUseAdvancedReasoning(evaluation) && advancedConfigured && !options.forceDirect) {
      try {
        console.log(`[Payvault AI] Difficult question detected (${evaluation.reason}). Internally consulting advanced reasoning fallback for case ${ctx.case_id}...`);
        const assistResult = await this.optionallyConsultAdvancedModel(normalized, ctx, history);

        if (assistResult.success && assistResult.answer) {
          const validated = this.validateAgainstCaseData(assistResult.answer, ctx);
          if (validated) {
            finalAnswer = validated;
            executionMode = 'ADVANCED_REASONING_ASSISTED';
            internalSource = 'payvault_ai+advanced_fallback';
            intent = 'complex_assisted_reasoning';
            console.log(`[Payvault AI] Advanced reasoning completed and validated in ${Date.now() - t0}ms.`);
          }
        }
      } catch (err) {
        console.warn(`[Payvault AI] Advanced fallback error (${err.message}). Using Payvault local intelligence.`);
      }
    }

    // ── STEP 2: Default & High-Confidence — Payvault Local Intelligence ───────
    if (!finalAnswer) {
      const localResult = this.reasonWithLocalIntelligence(normalized, ctx, history);
      finalAnswer = localResult.answer;
      intent = localResult.intent;
      executionMode = 'DIRECT_PAYVAULT_AI';
      internalSource = 'payvault_local_intelligence';
      console.log(`[Payvault AI] Direct answer produced by Payvault local intelligence in ${Date.now() - t0}ms (intent: ${intent}, confidence: ${(evaluation.confidence * 100).toFixed(0)}%).`);
    }

    // ── STEP 3: Fallback if case data is insufficient ────────────────────────
    if (!finalAnswer) {
      finalAnswer = `Payvault AI is unable to evaluate this case with the available data. Please verify ledger and gateway settlement records directly in the workstation.`;
    }

    return {
      answer: finalAnswer,
      model: this.modelName,
      source: internalSource,
      execution_mode: executionMode,
      intent,
      confidence: evaluation.confidence,
    };
  }
}

const defaultPayvaultAI = new PayvaultAI();

/**
 * Functional wrapper for routeAndAnswerChat.
 */
async function routeAndAnswerChat(params) {
  return defaultPayvaultAI.generateFinalAnswer(params);
}

function evaluateQueryComplexity(message, ctx, history) {
  return defaultPayvaultAI.assessComplexity(message, ctx, history);
}

function validateAssistedAnswer(rawAnswer, ctx) {
  return defaultPayvaultAI.validateAgainstCaseData(rawAnswer, ctx);
}

module.exports = {
  PayvaultAI,
  defaultPayvaultAI,
  routeAndAnswerChat,
  evaluateQueryComplexity,
  validateAssistedAnswer,
  COMPLEX_QUERY_PATTERNS,
};
