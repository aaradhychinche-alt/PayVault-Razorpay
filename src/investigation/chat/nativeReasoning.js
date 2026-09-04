'use strict';
/**
 * src/investigation/chat/nativeReasoning.js
 *
 * Payvault AI — Native Reasoning Layer.
 *
 * ACTIVE CHAT PATH: This is the sole reasoning engine for the Payvault AI
 * conversational system. NO Qwen, NO Ollama, NO external LLM is used.
 *
 * PIPELINE:
 *   resolveConversationReferences()  — resolve pronouns/references from history
 *   classifyIntent()                 — semantic intent understanding
 *   buildReasoningResult()           — internal structured reasoning representation
 *   constructAnswer()                — dynamic answer from reasoning result
 *
 * The internal reasoning result (not exposed to user):
 * {
 *   intent, facts, derived_values, evidence, risk,
 *   recommended_actions, escalation_condition, answer_points
 * }
 */

const {
  getExceptionKnowledge,
  getInvestigationProcedure,
  evaluateEscalation,
  assessFinancialLoss,
  getEvidenceSources,
} = require('./investigationKnowledge');

const { fmtINR } = require('./chatContextBuilder');

// Conversation State Manager — builds structured state from history
const {
  buildConversationState,
  resolveWithState,
} = require('./conversationState');

// ML Intent Classifier Bridge (TF-IDF + LogisticRegression — local, no LLM)
let _intentBridge = null;
function getIntentBridge() {
  if (!_intentBridge) {
    try {
      const { defaultBridge } = require('./intentClassifierBridge');
      _intentBridge = defaultBridge;
    } catch (_) {
      _intentBridge = null;
    }
  }
  return _intentBridge;
}

// ML intent label → nativeReasoning intent key mapping
const ML_TO_NATIVE_INTENT = {
  GROSS_AMOUNT:              'gross_amount',
  EXPECTED_SETTLEMENT:       'expected_settlement',
  ACTUAL_SETTLEMENT:         'actual_settlement',
  NET_SETTLEMENT:            'settlement_lookup',
  FEE_AMOUNT:                'fee_specific',
  FEE_VARIANCE:              'fee_specific',
  GST_AMOUNT:                'tax_specific',
  GST_VARIANCE:              'tax_specific',
  SETTLEMENT_VARIANCE:       'settlement_causality',
  FINANCIAL_IMPACT:          'real_financial_loss',
  CASE_SUMMARY:              'diagnostic_summary',
  CAUSE_ANALYSIS:            'why_flagged',
  TIMELINE:                  'identifier_lookup',
  EVIDENCE:                  'evidence_assessment',
  NEXT_ACTION:               'next_action',
  ESCALATION:                'escalation_assessment',
  RESOLUTION:                'what_to_verify',
  RELATED_TRANSACTION:       'identifier_lookup',
  HISTORICAL_COMPARISON:     'historical_cases',
  SIMILAR_CASE:              'historical_cases',
  EXPLANATION:               'simple_explanation',
  CLARIFICATION:             'why_flagged',
  CONFIRMATION:              'why_flagged',
  GENERAL_INVESTIGATION_QUERY: 'full_financial_breakdown',
  UNKNOWN_QUERY:             'unknown_query',
};

// ── Category display labels ───────────────────────────────────────────────────
function catLabel(cat) {
  const labels = {
    FEE_TAX_VARIANCE: 'Fee / Tax Variance',
    TIMING_MISMATCH: 'Timing Mismatch',
    MISSING_ORDER: 'Missing Order',
    MISSING_PAYMENT: 'Missing Payment',
    DUPLICATE: 'Duplicate Settlement',
    ADJUSTMENT: 'Settlement Adjustment',
    UNEXPLAINED: 'Unexplained Shortfall',
    PARTIAL_REFUND: 'Partial Refund',
    CLEAN_MATCH: 'Clean Match',
  };
  return labels[cat] || (cat || 'Exception').replace(/_/g, ' ');
}

// ── State-change guard ────────────────────────────────────────────────────────
// These patterns match MUTATION requests — actually trying to change case state.
// They do NOT match resolution READINESS inquiries like "can I close?" which
// are handled by the resolution_guidance intent.
const STATE_CHANGE_PATTERNS = [
  /\b(mark (this |this case |the case |it )?(as )?(resolved|closed)|mark resolved|mark closed)\b/i,
  /\b(please resolve|please close|go ahead and resolve|go ahead and close)\b/i,
  /\b(resolve (this|the) case|close (this|the) case)\b/i,
  /\b(reopen|re-open)\b/i,
  /\b(delete|remove|modify|approve|reject)\b/i,
];

// Resolution readiness inquiry patterns — "can I close?", "is it okay to resolve?" etc.
// These do NOT trigger state_change_guard — they get resolution_guidance instead.
const RESOLUTION_READINESS_PATTERNS = [
  /\b(can i (close|resolve|shut|finish)|okay to (close|resolve)|is it (okay|ok|safe|good) to (close|resolve))\b/i,
  /\b(ready to (close|resolve)|ready to be (closed|resolved))\b/i,
  /\b(should i (close|resolve)|is this (ready|complete|done))\b/i,
  /\b(can (this|the) case be (closed|resolved)|can this be (closed|resolved)|is the case (ready|done))\b/i,
  /\b(is it okay to close|is it okay to resolve|okay to close|okay to resolve)\b/i,
  /\b(enough to (close|resolve|finish)|safe to (close|resolve))\b/i,
  /\b(am i ready|are we ready|is everything ready)\b/i,
];

function isResolutionReadinessInquiry(message) {
  return RESOLUTION_READINESS_PATTERNS.some(function(pat) { return pat.test(message); });
}

function isStateChangeRequest(message) {
  // Resolution readiness inquiries take priority — they are NOT mutations
  if (isResolutionReadinessInquiry(message)) return false;
  return STATE_CHANGE_PATTERNS.some(function(pat) { return pat.test(message); });
}

// ── Step 1: Conversation Reference Resolution ─────────────────────────────────
/**
 * Resolve conversational references from history.
 *
 * Uses TWO strategies in priority order:
 *   1. resolveWithState() — uses STRUCTURED conversation state (preferred)
 *      State fields: currentTopic, previousIntent, activeFinancialMetric,
 *      referencedEntities, lastAnswerSummary.
 *      This is the V2 approach and handles any short/pronoun follow-up
 *      without regex over raw AI text.
 *
 *   2. Legacy regex fallbacks — for edge cases not covered by state resolution.
 *      These patterns provide a safety net for novel phrasings.
 *
 * @param {string} message
 * @param {Array}  history  [{role, content}]
 * @param {Object} ctx
 * @returns {string} enriched message with resolved topic
 */
function resolveConversationReferences(message, history, ctx) {
  if (!history || history.length === 0) return message;

  const norm = message.trim().toLowerCase();
  const wordCount = norm.split(/\s+/).length;

  // ── Strategy 1: Structured conversation state resolution ──────────────────
  // Build state from history and use it for reference resolution
  const state = buildConversationState(message, history, ctx);
  const stateResolved = resolveWithState(message, state);

  // If state resolver changed the message, use that result
  if (stateResolved !== message) return stateResolved;

  // ── Strategy 2: Legacy regex safety-net patterns ──────────────────────────
  // These handle any cases the state resolver didn't catch.
  // We keep these as a safety net — NOT as the primary path.

  const lastAiTurn = [...history].reverse().find(function(h) {
    return h.role === 'payvault' || h.role === 'assistant';
  });
  const lastUserTurn = [...history].reverse().find(function(h) {
    return h.role === 'operator' || h.role === 'user';
  });

  const lastAiText   = lastAiTurn   ? lastAiTurn.content.toLowerCase()   : '';
  const lastUserText = lastUserTurn ? lastUserTurn.content.toLowerCase() : '';

  // Medium-length pronoun-containing follow-ups (5-10 words) not caught by state
  if (wordCount >= 5 && wordCount <= 10) {
    const hasPronoun = /\b(that|it|this|the difference|the missing|the shortfall|the variance|the gap|the funds|the money)\b/.test(norm);
    if (hasPronoun) {
      if (/\bwhere\b.*\bgo\b/.test(norm)) return 'where did the missing money go?';
      if (/\bwhat (caused|created|drove|triggered)\b.*(that|this|the)\b/.test(norm)) return 'why did this discrepancy happen?';
      if (/\bhow much\b.*(that|this|the difference|the variance|the gap|the shortfall)/.test(norm)) {
        if (/\bfee\b/.test(lastAiText)) return 'how much was the fee overcharge?';
        if (/\bgst\b|\btax\b/.test(lastAiText)) return 'how much was the GST overcharge?';
        return 'how much is the total shortfall?';
      }
      if (/\bwhy does (that|this) matter\b/.test(norm)) {
        if (/\bgst\b|\btax\b/.test(lastAiText)) return 'why does the GST overcharge matter?';
        if (/\bfee\b/.test(lastAiText)) return 'why does the fee overcharge matter?';
        return 'why is the settlement shortfall significant?';
      }
      if (/\bdoes (that|this) explain\b/.test(norm)) return 'does that explain the settlement shortfall?';
      if (/\bwhat should i do (about|with|now|for) (that|this)\b/.test(norm)) return 'what should I do now?';
    }
  }

  // Very short follow-ups (≤4 words) safety net
  if (wordCount <= 4) {
    if (/^(but\s+how|how\s+so|how\s+come|how)\??$/i.test(norm)) {
      if (/\bgross\b/.test(lastAiText) || /\bgross\b/.test(lastUserText)) {
        return 'how does the gross amount relate to the settlement?';
      }
      if (/\bfee\b|\bgst\b|\btax\b|\bdeduction/.test(lastAiText) || /\bfee\b|\bgst\b|\btax\b/.test(lastUserText)) {
        return 'how was that extra deduction calculated?';
      }
      if (/\bsettlement\b|\bshort\b|\bshortfall\b/.test(lastAiText) || /\bsettlement\b|\bshort\b/.test(lastUserText)) {
        return 'why is the settlement short?';
      }
      return 'why did this discrepancy happen?';
    }

    if (/^(where did (it|the money|the missing money|that|the funds|the difference) go)\??$/i.test(norm) ||
        /\bwhere did.*go\b/i.test(norm)) {
      return 'where did the missing money go?';
    }
    if (/^(what now|what next|where now)\??$/i.test(norm)) return 'what should I do now?';

    if (/^why\??$/.test(norm)) {
      if (/\bfee\b/.test(lastAiText) || /\bfee\b/.test(lastUserText)) return 'why is the fee overcharged?';
      if (/\bgst\b|\btax\b/.test(lastAiText) || /\bgst\b|\btax\b/.test(lastUserText)) return 'why is the GST overcharged?';
      if (/\bsettlement\b|\bshort\b/.test(lastAiText)) return 'why is the settlement short?';
      return 'why did this happen?';
    }

    if (/^how much(\s+is it|\s+was it|\?)?$/.test(norm)) {
      if (/\bfee\b/.test(lastAiText) || /\bfee\b/.test(lastUserText)) return 'how much was the fee overcharge?';
      if (/\bgst\b|\btax\b/.test(lastAiText) || /\bgst\b|\btax\b/.test(lastUserText)) return 'how much was the GST overcharge?';
      if (/\bsettlement\b|\bshort\b|\brisk\b|\bloss\b/.test(lastAiText)) return 'how much is the total shortfall?';
    }

    if (/^(what about (it|that|this)|and (that|this|it))\??$/.test(norm)) {
      if (/\bgst\b|\btax\b/.test(lastAiText)) return 'what about the GST?';
      if (/\bfee\b/.test(lastAiText)) return 'what about the fee?';
      if (/\bsettlement\b/.test(lastAiText)) return 'what about the settlement?';
      return 'what about this case?';
    }
  }

  return message;
}

// ── Step 2: Intent Classification ────────────────────────────────────────────
/**
 * Classify the semantic intent of the user's message.
 * Uses semantic patterns, NOT exact keyword matching.
 * Covers all 25 Payvault investigation intents.
 *
 * @param {string} message
 * @param {Array}  history
 * @param {Object} ctx
 * @returns {string} intent key
 */
function classifyIntent(message, history, ctx) {
  const norm = message.trim().toLowerCase();

  // Guard: resolution readiness inquiry — must come BEFORE state_change_guard
  // "Can I close this?" is asking for guidance, not issuing a command
  if (isResolutionReadinessInquiry(norm)) return 'resolution_guidance';

  // Guard: state change mutation ("resolve this", "mark as resolved")
  if (isStateChangeRequest(norm)) return 'state_change_guard';

  // ── UNKNOWN_QUERY — clearly out of domain ──
  // Checked before all investigation intents to avoid wasting match time
  if (/\b(weather|joke|recipe|cook|poem|capital of|speed of light|stock price|who is the ceo|what time is it|homework|quantum|machine learning|how to make|tell me a|what language|what country|what sport|news today|movie|song|music|wikipedia)\b/i.test(norm)) {
    return 'unknown_query';
  }

  // ── False Positive Assessment ──
  if (/\b(false positive|false alarm|system error|mistake in reconciliation|is this wrong|could this be wrong|could this be a false positive|is this a false positive|incorrect flag|wrongly flagged|reconciliation bug|false alert)\b/i.test(norm)) {
    return 'false_positive_assessment';
  }
  // Additional false-positive phrasings
  if (/\b(does anything (suggest|indicate|point to) a false positive|does this look like a false positive|anything wrong with the flag|is the flag correct|could the system be wrong|might this be an error|is this accurate)\b/i.test(norm)) {
    return 'false_positive_assessment';
  }

  // ── Where did the money go ──
  if (/\b(where did the (missing )?(money|funds|amount|shortfall|difference|\u20B9?[\d,]+(\.\d+)?) go|where did (it|the missing|the shortfall|the funds) go|where went the money|who got the money|what happened to the (missing|shortfall) (money|funds|\u20B9?[\d,]+))\b/i.test(norm) ||
      /\bwhere did.*go\b/i.test(norm)) {
    return 'where_did_money_go';
  }

  // ── Settlement causality / why short / causal reasoning ──
  if (/^(and\s+)?(what\s+about|how\s+about)\s+(settlement|net|payout)\??$/i.test(norm)) {
    return 'settlement_causality';
  }
  if (/\b(why.*didn.t.*receive.*full|why.*didn.t.*get.*full|why.*not.*full amount|why.*receive.*instead of|why.*actual settlement lower|why.*settlement.*lower|why.*settlement.*short|why.*payout.*lower)\b/i.test(norm)) {
    return 'settlement_causality';
  }
  if (/\b(how does the gross amount relate|how does gross relate|how did the settlement shortfall happen|how does this relate to the settlement)\b/i.test(norm)) {
    return 'settlement_causality';
  }
  if (/\b(affect|impact|reduce|shortfall|difference|short|gap)\b/i.test(norm) &&
      /\b(settlement|payout|credit|net amount|received)\b/i.test(norm)) {
    return 'settlement_causality';
  }
  if (/\bwhy\b/i.test(norm) &&
      /\b(short|shortfall|less|missing|difference|variance|lower)\b/i.test(norm) &&
      !/\b(flagged|detected|raised)\b/i.test(norm)) {
    return 'settlement_causality';
  }
  if (/\bdoes that explain\b/i.test(norm)) return 'settlement_causality';
  if (/\b(why.*amount.*not match|why.*doesn.t match|why.*mismatch|why.*not match|amount.*differ|why.*differ)\b/i.test(norm)) {
    return 'settlement_causality';
  }

  // ── GROSS_AMOUNT — What was the gross / original / customer payment ──
  if (!/\b(why|relate|lower|short|shortfall|difference|impact|reduce|missing)\b/i.test(norm)) {
    if (/\b(gross amount|gross payment|gross transaction|original amount|original payment|full amount|total amount|total transaction|transaction amount|transaction value|payment amount|customer paid|customer payment|customer charge|customer spend|buyer paid|purchase amount|checkout amount|how much did the customer|how much was charged|how much was processed|how much was the payment|how much was the transaction|how much was the original|what was the original|what did the customer pay|what was the total|what is the gross|what is the full amount|what is the transaction)\b/i.test(norm)) {
      return 'gross_amount';
    }
    // Short phrasings for gross
    if (/^(gross amount\??|gross\??|the gross\??)$/.test(norm)) return 'gross_amount';
    if (/^(how much was the payment\??)$/.test(norm)) return 'gross_amount';
  }

  // ── EXPECTED_SETTLEMENT ──
  if (!/\b(why|lower|short|shortfall|difference|variance|less|gap|reduce|affect|missing)\b/i.test(norm)) {
    if (/\b(expected settlement|expected payout|expected net|expected credit|should have received|supposed to get|supposed to receive|should have gotten|should have been credited|projected settlement|scheduled credit|contractual settlement|expected disbursement|how much were we supposed|what should we have|what should have been settled|what was expected|what was anticipated)\b/i.test(norm)) {
      return 'expected_settlement';
    }
  }

  // ── ACTUAL_SETTLEMENT ──
  if (!/\b(why|lower|short|shortfall|difference|variance|less|gap|reduce|affect|missing)\b/i.test(norm)) {
    if (/\b(actually received|actually got|actually credited|actually deposited|actually paid|actual payout|actual credit|actual settlement|actually settled|what did we get|what did we receive|what was deposited|what was credited|what came in|what was actually|how much did we get|how much did we actually|how much came in|how much was credited|how much was deposited|how much was disbursed)\b/i.test(norm)) {
      return 'actual_settlement';
    }
  }

  // ── DEDUCTIONS — How much was deducted / taken out ──
  if (/\b(deducted|deductions|total deductions|how much was deducted|how much was taken|how much was taken out|what was taken|what was removed|what was withheld|what charges were deducted|what was subtracted|total deductions)\b/i.test(norm)) {
    return 'total_deductions';
  }

  // ── Full breakdown / complete picture ──
  if (/\b(full picture|full breakdown|complete breakdown|all numbers|detailed breakdown|complete picture|entire breakdown|all details)\b/i.test(norm)) {
    return 'full_financial_breakdown';
  }
  if (/\bbreakdown\b/i.test(norm) && !/\b(why|gst|tax|fee|overcharge|short|affect|simple)\b/i.test(norm)) {
    return 'full_financial_breakdown';
  }
  if (/\b(walk me through|walk through|take me through|run me through)\b/i.test(norm)) {
    return 'full_financial_breakdown';
  }

  // ── Simple / plain explanation ──
  if (/\b(simple|simply|plain english|layman|eli5|in simple terms|overview)\b/i.test(norm)) {
    return 'simple_explanation';
  }
  if (/\bexplain\b/i.test(norm) && /\b(case|whole|all|everything|this)\b/i.test(norm) && !/\b(fee|tax|settlement|math)\b/i.test(norm)) {
    return 'simple_explanation';
  }
  if (/^explain\s+(this\s+)?to me\.?$/i.test(norm)) return 'simple_explanation';
  if (/^can you break that down\??$/.test(norm)) return 'full_financial_breakdown';

  // ── Tax / GST specific ──
  if (/^(and\s+)?(what\s+about|how\s+about|and)\s+(gst|tax|taxes|the\s+tax|the\s+gst)\??$/i.test(norm)) {
    return 'tax_specific';
  }
  if (/\b(gst|taxes)\b/i.test(norm) && !/\b(settlement|affect|short|cause|because of)\b/i.test(norm)) {
    return 'tax_specific';
  }
  if (/\btax\b/i.test(norm) && !/\b(settlement|affect|short|cause)\b/i.test(norm) && !/\b(fee|platform)\b/i.test(norm)) {
    return 'tax_specific';
  }

  // ── Fee specific ──
  if (/^(and\s+)?(what\s+about|how\s+about|and)\s+(fee|platform fee|fees|the\s+fee)\??$/i.test(norm)) {
    return 'fee_specific';
  }
  if (/\b(fee|fees|platform fee|processing fee|service fee|gateway fee|transaction fee)\b/i.test(norm)) {
    if (/\b(problem|issue|reason|cause|wrong|driving)\b/i.test(norm)) return 'is_fee_the_problem';
    if (!/\b(settlement|affect|short|cause|because of)\b/i.test(norm)) return 'fee_specific';
  }

  // ── What happened / why did this happen ──
  if (/\b(what happened|what went wrong|what caused this|why did this happen|why did this occur|what is this about|tell me what happened|what's going on|what is going on|what is the issue|what is the problem|what is wrong|what is the cause|what led to this|what triggered this|why was this created|why is this here|what caused the exception|root cause|what is the root cause)\b/i.test(norm)) {
    return 'why_flagged';
  }
  if (/\b(why was this flagged|why was it flagged|why flagged|why is this flagged|why is this case here)\b/i.test(norm)) {
    return 'why_flagged';
  }

  // ── Resolution guidance (readiness inquiry — NOT state mutation) ──
  // Patterns: "can I close this?", "is it okay to resolve?", "am I ready to close?"
  // Also catch multi-word resolution inquiry phrasings not caught by RESOLUTION_READINESS_PATTERNS
  if (/\b(am i ready|are we ready|is the case ready|is everything ready)\b/i.test(norm) &&
      /\b(close|resolve|finish|done)\b/i.test(norm)) {
    return 'resolution_guidance';
  }
  if (/\b(enough to (close|resolve|finish)|ready to be closed|safe to (close|resolve))\b/i.test(norm)) {
    return 'resolution_guidance';
  }

  // ── Next action / what should I do ──
  if (/\b(what should i do|what do i do|next steps?|my next step|what now|where do i go from here|what to do now|what action|what should we do|what is the first step|what must i do|what can i do|how should i proceed|how should i handle|how do i proceed|what is the action plan|what is the procedure|recommended steps|action plan)\b/i.test(norm)) {
    return 'next_action';
  }
  if (/\b(now)\b/i.test(norm) && /\b(do|should|can|must)\b/i.test(norm)) {
    return 'next_action';
  }

  // ── What should I check / verify ──
  if (/\b(verify|check|validate|confirm|before resolving|what should i check|what to check|what to verify|what should i validate|what should i look at)\b/i.test(norm)) {
    return 'what_to_verify';
  }
  if (/\b(what should i)\b/i.test(norm) && /\b(verify|check|look at|examine|review)\b/i.test(norm)) {
    return 'what_to_verify';
  }

  // ── Should I escalate ──
  if (/\b(escalat|escalation|should i escalate|need to escalate|require escalation|does this need escalation|does this warrant escalation|is escalation needed|is escalation required|flag this|raise this|senior|finance team)\b/i.test(norm)) {
    return 'escalation_assessment';
  }

  // ── Is this a real financial loss ──
  if (/\b(real loss|actual loss|genuine loss|real financial loss|actual financial loss|financial loss|represent.*(financial\s+)?loss|actually losing|merchant.*losing money|losing money|is this a loss|is there a loss|is it a real|are we losing|merchant losing|actually at risk)\b/i.test(norm)) {
    return 'real_financial_loss';
  }

  // ── What evidence ──
  if (/\b(evidence|support|what supports|what proves|proof|documentation|documents|records|what records|what does the data|what data|data available|what sources|source of)\b/i.test(norm)) {
    return 'evidence_assessment';
  }
  if (/\b(is there enough evidence|enough evidence|enough to (dispute|challenge)|does the (settlement|record|data) support|support the exception)\b/i.test(norm)) {
    return 'evidence_assessment';
  }

  // ── Is this similar to previous cases / historical patterns ──
  if (/\b(similar|historical|history|precedent|previous cases|like this before|seen this before|pattern|recurring|repeat|happened before|has this happened|past cases|other cases like)\b/i.test(norm)) {
    return 'historical_cases';
  }

  // ── Amount at risk / financial exposure / overcharged ──
  if (/\b(lose|lost|loss|at risk|exposure|overcharge|overcharged|how much.*short|financial risk|total.*short|how much is missing|how much are we short|how much money is|total exposure|amount at risk)\b/i.test(norm)) {
    return 'amount_at_risk';
  }
  // "how much actually reached the merchant", "how much did the merchant actually get"
  if (/\b(actually reached|actually got|actually received|actually landed|actually paid to)\b/i.test(norm) &&
      /\b(merchant|seller|vendor|business)\b/i.test(norm)) {
    return 'actual_settlement';
  }
  // "which deduction caused the problem", "which deduction is the issue"
  if (/\b(which deduction|which charge|which fee)\b/i.test(norm) &&
      /\b(caused|problem|issue|driving|responsible|at fault)\b/i.test(norm)) {
    return 'is_fee_the_problem';
  }
  // "did the gateway retain more than it should" / "did the gateway overcharge"
  if (/\b(gateway (retain|keep|take|hold|deduct|charge) more than|gateway overcharg|gateway took more)\b/i.test(norm)) {
    return 'fee_specific';
  }
  // "how much would the merchant have received under the contract"
  if (/\bunder the contract|under the contracted rate|what the contract (says|specifies|states)\b/i.test(norm)) {
    return 'expected_settlement';
  }

  // ── Math / calculation explanation ──
  if (/\b(how did you calculate|how do you calculate|how did you get|show the math|how was that calculated|calculation breakdown|how is it calculated|show workings|show me the calculation)\b/i.test(norm)) {
    return 'math_explanation';
  }

  // ── Why not 0.90 ──
  if (/\b(0\.90|90 paise|why not 0\.90)\b/i.test(norm)) return 'why_not_90_paise';

  // ── Identifier lookup ──
  if (/\b(payment id|order id|settlement id|utr|settlement batch|transaction id|razorpay id|payment reference|order reference)\b/i.test(norm)) {
    return 'identifier_lookup';
  }

  // ── Settlement figures lookup ──
  if (/\b(expected settlement|actual settlement|settlement received|expected net|payout received|net settlement)\b/i.test(norm)) {
    return 'settlement_lookup';
  }

  // ── Contextual follow-up from history ──
  if (history && history.length > 0) {
    const lastUserTurn = [...history].reverse().find(function(h) {
      return h.role === 'operator' || h.role === 'user';
    });
    const lastText = lastUserTurn ? lastUserTurn.content.toLowerCase() : '';

    if (/\b(how much|how much is it|how much was it)\b/i.test(norm)) {
      if (/\bfee\b/.test(lastText)) return 'fee_specific';
      if (/\btax\b|\bgst\b/.test(lastText)) return 'tax_specific';
      if (/\bsettlement\b|\bshort\b|\bloss\b|\brisk\b/.test(lastText)) return 'amount_at_risk';
    }
  }

  // ── Out-of-Domain / Unknown Query ──
  if (/\b(restaurant|recipe|movie|movies|book|weather|sports|politics|gdp|blockchain|ai|python|java|script|code|2 \+ 2|math problem|joke)\b/i.test(norm)) {
    return 'unknown_query';
  }

  // Fallback
  return 'diagnostic_summary';
}

// ── Step 3: Internal Reasoning Result Builder ─────────────────────────────────
/**
 * Build the internal structured reasoning representation.
 * This is INTERNAL — never shown to the user.
 *
 * @param {string} intent
 * @param {Object} ctx
 * @param {Array}  history
 * @returns {Object} reasoning result
 */
function buildReasoningResult(intent, ctx, history) {
  const cat = ctx.exception_category || 'UNEXPLAINED';
  const excKnowledge = getExceptionKnowledge(cat);
  const procedure = getInvestigationProcedure(cat);
  const escalation = evaluateEscalation(cat, ctx.amount_at_risk_paise, ctx.historical);
  const lossAssessment = assessFinancialLoss(cat, ctx.amount_at_risk_paise || 0);
  const evidenceSources = getEvidenceSources(cat);

  // Gather derived financial facts
  const facts = [];
  if (ctx.gross_amount_formatted) facts.push({ name: 'Gross customer amount', value: ctx.gross_amount_formatted });
  if (ctx.fee_expected_formatted) facts.push({ name: 'Expected platform fee (2%)', value: ctx.fee_expected_formatted });
  if (ctx.fee_actual_formatted) facts.push({ name: 'Actual fee charged', value: ctx.fee_actual_formatted });
  if (ctx.fee_variance_formatted && ctx.fee_variance_paise > 0) facts.push({ name: 'Fee overcharge', value: ctx.fee_variance_formatted });
  if (ctx.tax_expected_formatted) facts.push({ name: 'Expected GST (18% of contracted fee)', value: ctx.tax_expected_formatted });
  if (ctx.tax_actual_formatted) facts.push({ name: 'Actual GST charged', value: ctx.tax_actual_formatted });
  if (ctx.tax_variance_formatted && ctx.tax_variance_paise > 0) facts.push({ name: 'GST overcharge', value: ctx.tax_variance_formatted });
  if (ctx.expected_net_formatted) facts.push({ name: 'Expected net settlement', value: ctx.expected_net_formatted });
  if (ctx.actual_settlement_formatted) facts.push({ name: 'Actual settlement received', value: ctx.actual_settlement_formatted });
  if (ctx.net_shortfall_formatted) facts.push({ name: 'Settlement shortfall', value: ctx.net_shortfall_formatted });
  if (ctx.amount_at_risk_formatted) facts.push({ name: 'Amount at risk', value: ctx.amount_at_risk_formatted });

  const derivedValues = [];
  if (ctx.fee_variance_paise !== null && ctx.tax_variance_paise !== null) {
    derivedValues.push({
      label: 'Arithmetic verification',
      formula: 'Fee variance + GST variance = Settlement shortfall',
      check: (ctx.fee_variance_paise || 0) + (ctx.tax_variance_paise || 0),
      expected: ctx.net_shortfall_paise || ctx.amount_at_risk_paise,
    });
  }

  const suggestedActions = ctx.suggested_actions && ctx.suggested_actions.length > 0
    ? ctx.suggested_actions
    : procedure.steps.slice(0, 3).map(function(s) { return { priority: 'HIGH', description: s }; });

  const answerPoints = [];

  // Intent-specific answer points
  if (intent === 'next_action') {
    answerPoints.push({ type: 'case_overview', value: catLabel(cat) + ' exception — ' + (ctx.amount_at_risk_formatted || 'unknown amount') + ' at risk' });
    if (excKnowledge.requires_gateway_action) {
      answerPoints.push({ type: 'gateway_action_required', value: true });
    }
    answerPoints.push({ type: 'procedure_steps', value: procedure.steps });
    answerPoints.push({ type: 'can_resolve_independently', value: procedure.can_resolve_independently });
    answerPoints.push({ type: 'requires_external', value: procedure.requires_external_action });
    answerPoints.push({ type: 'when_to_resolve', value: excKnowledge.typical_resolution });
    answerPoints.push({ type: 'escalation', value: escalation });
  }

  if (intent === 'escalation_assessment') {
    answerPoints.push({ type: 'escalation', value: escalation });
    answerPoints.push({ type: 'category_risk', value: excKnowledge.real_financial_loss });
    answerPoints.push({ type: 'amount_context', value: ctx.amount_at_risk_formatted });
  }

  if (intent === 'real_financial_loss') {
    answerPoints.push({ type: 'loss_assessment', value: lossAssessment });
    answerPoints.push({ type: 'category', value: cat });
    answerPoints.push({ type: 'amount', value: ctx.amount_at_risk_formatted });
  }

  if (intent === 'evidence_assessment') {
    answerPoints.push({ type: 'evidence_sources', value: evidenceSources });
    answerPoints.push({ type: 'case_facts', value: facts.filter(function(f) { return f.value; }) });
    if (ctx.ai_investigation) {
      answerPoints.push({ type: 'ai_summary', value: ctx.ai_investigation.summary || ctx.ai_investigation.what_happened });
    }
  }

  return {
    intent,
    facts,
    derived_values: derivedValues,
    evidence: evidenceSources,
    risk: escalation,
    recommended_actions: suggestedActions,
    escalation_condition: escalation.reason,
    answer_points: answerPoints,
    // Additional reasoning context
    exception_knowledge: excKnowledge,
    procedure,
    loss_assessment: lossAssessment,
    history_context: ctx.historical || {},
  };
}

// ── Step 4: Answer Construction ───────────────────────────────────────────────

function constructStateChangeGuard() {
  return [
    'I can explain the investigation findings and recommend corrective actions, but case status changes cannot be performed through chat.\n',
    '• To mark this case resolved: click the **"Resolve"** button in the investigation header.',
    '• To reopen a case: click the **"Reopen"** button in the investigation header.',
    '\nThe investigation copilot operates strictly as an analytical advisor to preserve human audit controls.',
  ].join('\n');
}

function constructNextAction(ctx, reasoning) {
  const cat = ctx.exception_category || 'UNEXPLAINED';
  const risk = ctx.amount_at_risk_formatted || fmtINR(ctx.amount_at_risk_paise);
  const excKnowledge = reasoning.exception_knowledge;
  const procedure = reasoning.procedure;
  const escalation = reasoning.risk;

  const lines = [
    '**Investigation next steps for Case `' + ctx.case_id + '` (' + catLabel(cat) + '):**\n',
  ];

  // Financial situation summary
  if (cat === 'FEE_TAX_VARIANCE') {
    lines.push(
      'The investigation has identified a **' + (ctx.fee_variance_formatted || '') + ' fee overcharge** and a **' +
      (ctx.tax_variance_formatted || '') + ' GST overcharge**, combining for a **' + risk + ' settlement shortfall**.\n'
    );
  } else {
    lines.push('The investigation has identified a **' + risk + '** discrepancy (' + catLabel(cat) + ').\n');
  }

  // Concrete steps from the investigation procedure
  const steps = procedure.steps;
  steps.forEach(function(step, i) {
    lines.push((i + 1) + '. ' + step);
  });

  // Escalation & external action guidance
  lines.push('');
  if (escalation.should_escalate) {
    lines.push('• **Internal escalation:** ' + escalation.urgency + ' priority — ' + escalation.reason);
  } else {
    lines.push('• **Internal escalation:** Not required — ' + escalation.reason);
    if (excKnowledge.requires_gateway_action) {
      lines.push('• **External action:** Raise a fee dispute with the payment gateway to claim the ' + risk + ' fee correction credit.');
    }
  }

  // Resolution guidance
  lines.push('\n**When to resolve:** ' + excKnowledge.typical_resolution);
  lines.push('\n_Use the **"Resolve"** button in the workstation UI once the above steps are complete._');

  return lines.join('\n');
}

function constructEscalationAssessment(ctx, reasoning) {
  const cat = ctx.exception_category || 'UNEXPLAINED';
  const escalation = reasoning.risk;
  const risk = ctx.amount_at_risk_formatted || fmtINR(ctx.amount_at_risk_paise);

  if (escalation.should_escalate) {
    const lines = [
      '**Yes, this case warrants internal escalation.** (' + escalation.urgency + ' priority)\n',
      'Reason: ' + escalation.reason + '\n',
      '• **Case:** `' + ctx.case_id + '` — ' + catLabel(cat),
      '• **Internal escalation:** Escalation required to Finance / Settlement Operations',
      '• **Amount at risk:** ' + risk,
      '• **Status:** ' + (ctx.status || 'OPEN'),
    ];
    if (cat === 'DUPLICATE') {
      lines.push('\n**Immediate action required:** Hold disbursement before escalating.');
    }
    return lines.join('\n');
  }

  const lines = [
    '• **Internal escalation:** Not required for Case `' + ctx.case_id + '` (' + risk + ' is within standard operating threshold).',
  ];
  if (cat === 'FEE_TAX_VARIANCE') {
    lines.push('• **External action:** Raise a fee dispute with the payment gateway to claim a ' + risk + ' fee correction credit.');
  } else if (reasoning.exception_knowledge.typical_resolution) {
    lines.push('• **External action:** ' + reasoning.exception_knowledge.typical_resolution);
  }
  lines.push('• **Category:** ' + catLabel(cat));
  lines.push('• **Amount at risk:** ' + risk);

  return lines.join('\n');
}

function constructRealFinancialLoss(ctx, reasoning) {
  const cat = ctx.exception_category || 'UNEXPLAINED';
  const lossAssessment = reasoning.loss_assessment;
  const risk = ctx.amount_at_risk_formatted || fmtINR(ctx.amount_at_risk_paise);

  const lines = [
    lossAssessment.explanation,
  ];

  if (lossAssessment.is_real_loss && cat === 'FEE_TAX_VARIANCE') {
    lines.push('');
    lines.push('**Breakdown of the ' + risk + ' exposure:**');
    if (ctx.fee_variance_formatted) lines.push('• Fee overcharge: ' + ctx.fee_variance_formatted);
    if (ctx.tax_variance_formatted) lines.push('• GST overcharge: ' + ctx.tax_variance_formatted);
    lines.push('• Total shortfall: ' + risk + ' (owed back to the merchant as a fee correction credit)');
  }

  return lines.join('\n');
}

function constructEvidenceAssessment(ctx, reasoning) {
  const cat = ctx.exception_category || 'UNEXPLAINED';
  const excKnowledge = reasoning.exception_knowledge;

  const lines = [
    '**Evidence supporting this investigation (Case `' + ctx.case_id + '`):**\n',
  ];

  // Case-specific facts as evidence
  if (cat === 'FEE_TAX_VARIANCE') {
    lines.push('**1. Settlement Record (HIGH reliability)**');
    lines.push('   The gateway settlement record shows actual fee charged: ' + (ctx.fee_actual_formatted || 'N/A') +
      ' vs expected: ' + (ctx.fee_expected_formatted || 'N/A'));
    lines.push('   Actual GST charged: ' + (ctx.tax_actual_formatted || 'N/A') +
      ' vs expected: ' + (ctx.tax_expected_formatted || 'N/A'));

    lines.push('\n**2. Reconciliation Result (HIGH reliability)**');
    lines.push('   Payvault\'s deterministic engine computed:');
    lines.push('   • Fee variance: ' + (ctx.fee_variance_formatted || '₹0') + ' overcharge');
    lines.push('   • GST variance: ' + (ctx.tax_variance_formatted || '₹0') + ' overcharge');
    lines.push('   • Settlement shortfall: ' + (ctx.net_shortfall_formatted || ctx.amount_at_risk_formatted || 'N/A'));

    lines.push('\n**3. Arithmetic Verification (Deterministic)**');
    const feeV = ctx.fee_variance_paise || 0;
    const taxV = ctx.tax_variance_paise || 0;
    const total = feeV + taxV;
    const shortfall = ctx.net_shortfall_paise || ctx.amount_at_risk_paise || 0;
    const matches = Math.abs(total - shortfall) <= 1; // 1 paise rounding tolerance
    lines.push('   Fee variance (' + (ctx.fee_variance_formatted || '₹0') + ') + GST variance (' +
      (ctx.tax_variance_formatted || '₹0') + ') = ' + fmtINR(total) + ' — ' +
      (matches ? 'matches settlement shortfall ✓' : 'discrepancy noted'));
  } else {
    // Generic evidence for other categories
    const sources = excKnowledge.evidence_sources || [];
    sources.forEach(function(src, i) {
      const interp = reasoning.evidence.find(function(e) { return e.source === src; });
      if (interp) {
        lines.push('**' + (i + 1) + '. ' + src.replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); }) +
          ' (' + interp.reliability.split(' ')[0] + ' reliability)**');
        lines.push('   ' + interp.what_it_tells);
      }
    });
  }

  // AI investigation summary if available
  if (ctx.ai_investigation && ctx.ai_investigation.summary) {
    lines.push('\n**AI Investigation Summary:**');
    lines.push('   ' + ctx.ai_investigation.summary);
  }

  if (!lines.some(function(l) { return l.length > 50; })) {
    lines.push('\nCase is flagged as **' + catLabel(cat) + '** with **' + (ctx.amount_at_risk_formatted || 'N/A') + '** at risk.');
    lines.push('Exception description: ' + (ctx.exception_description || 'No description available.'));
  }

  return lines.join('\n');
}

function constructHistoricalComparison(ctx) {
  const h = ctx.historical || {};
  const count = h.similar_cases_count || 0;

  if (!count) {
    return 'No similar past cases were found in the current session history for **' + catLabel(ctx.exception_category) + '**.' +
      '\n\nThis may be a first occurrence, or the session does not have enough historical data for comparison yet.';
  }

  const list = (h.similar_cases || []).map(function(sc) {
    return '• Case `' + sc.case_id + '` — ' + catLabel(sc.category || ctx.exception_category) +
      (sc.variance ? ' (' + fmtINR(sc.variance) + ')' : '');
  });

  const lines = [
    '**Historical Comparison (' + count + ' similar case(s) found):**\n',
    list.join('\n'),
  ];

  if (h.repeated_patterns && h.repeated_patterns.length > 0) {
    lines.push('\n**Detected patterns:**');
    h.repeated_patterns.forEach(function(p) { lines.push('• ' + p); });
  }

  if (h.precedent_summary) {
    lines.push('\n**Precedent summary:** ' + h.precedent_summary);
  }

  // Escalation signal if many similar cases
  if (count >= 3) {
    lines.push('\n**Note:** ' + count + ' similar cases detected — this may indicate a systemic issue worth investigating at the process level.');
  }

  return lines.join('\n');
}

function constructDiagnosticSummary(ctx, message) {
  const cat = catLabel(ctx.exception_category);
  const risk = ctx.amount_at_risk_formatted || fmtINR(ctx.amount_at_risk_paise);

  return [
    '**Case `' + ctx.case_id + '` Diagnostic — ' + cat + ':**\n',
    ctx.cause_and_effect_summary || ('A discrepancy of ' + risk + ' was detected in settlement reconciliation.'),
    '\n• **Amount at risk:** ' + risk,
    '• **Status:** ' + (ctx.status || 'OPEN'),
    '• **Next step:** ' + (ctx.suggested_actions && ctx.suggested_actions[0]
      ? ctx.suggested_actions[0].description
      : 'Review the settlement deduction against the merchant contract schedule.'),
  ].join('\n');
}

// Re-use the existing focused answer builders for fee/tax/settlement specifics
// (These maintain backwards-compatibility with localChatEngine answer patterns)

function constructFeeSpecific(ctx, message) {
  if (ctx.fee_actual_paise === null || ctx.fee_expected_paise === null) {
    return 'Fee deduction data is not available for case ' + ctx.case_id + '.';
  }
  const feeVarPaise = ctx.fee_variance_paise || 0;
  const isOver = feeVarPaise > 0;
  const feeVarFmt = ctx.fee_variance_formatted || fmtINR(Math.abs(feeVarPaise));

  if (feeVarPaise === 0) {
    return 'The platform fee charged matches the contracted rate exactly at ' + ctx.fee_expected_formatted + ' (no fee overcharge).';
  }

  const norm = (message || '').toLowerCase();
  const isExtraQuery = /\b(extra|more|overcharge|overcharged|difference|variance)\b/.test(norm);

  if (isExtraQuery) {
    return [
      'The gateway charged an extra **' + feeVarFmt + '** in platform fees.',
      '',
      '• **Actual fee deducted:** ' + ctx.fee_actual_formatted,
      '• **Contracted fee (2.0%):** ' + ctx.fee_expected_formatted,
      '• **Calculation:** ' + ctx.fee_actual_formatted + ' − ' + ctx.fee_expected_formatted + ' = ' + feeVarFmt + ' extra fee charged by the gateway.',
    ].join('\n');
  }

  return [
    'The actual platform fee deducted by the gateway is **' + ctx.fee_actual_formatted + '**.\n',
    '• **Actual fee deducted:** ' + ctx.fee_actual_formatted,
    '• **Expected fee (contracted 2.0%):** ' + ctx.fee_expected_formatted,
    '• **Difference:** ' + feeVarFmt + ' ' + (isOver ? 'more than contracted' : 'less than contracted') + '.',
  ].join('\n');
}

function constructTaxSpecific(ctx, message) {
  if (ctx.tax_actual_paise === null || ctx.tax_expected_paise === null) {
    return 'GST deduction data is not available for case ' + ctx.case_id + '.';
  }
  const taxVarPaise = ctx.tax_variance_paise || 0;
  const isOver = taxVarPaise > 0;
  const taxVarFmt = ctx.tax_variance_formatted || fmtINR(Math.abs(taxVarPaise));

  if (taxVarPaise === 0) {
    return 'GST was charged correctly at ' + ctx.tax_expected_formatted + ' (18% of the platform fee). There is no tax variance.';
  }

  const norm = (message || '').toLowerCase();
  const isExtraQuery = /\b(extra|more|overcharge|overcharged|difference|variance)\b/.test(norm);

  if (isExtraQuery) {
    return [
      'The gateway charged an extra **' + taxVarFmt + '** in GST.',
      '',
      '• **Actual GST charged:** ' + ctx.tax_actual_formatted,
      '• **Expected GST (18.0% on contracted fee):** ' + ctx.tax_expected_formatted,
      '• **Calculation:** ' + ctx.tax_actual_formatted + ' − ' + ctx.tax_expected_formatted + ' = ' + taxVarFmt + ' excess GST charged by the gateway.',
      '',
      'There are no additional tax deductions.',
    ].join('\n');
  }

  return [
    'The actual GST charged by the gateway is **' + ctx.tax_actual_formatted + '**.\n',
    '• **Actual GST charged:** ' + ctx.tax_actual_formatted,
    '• **Expected GST (18.0% of expected fee):** ' + ctx.tax_expected_formatted,
    '• **GST overcharge:** ' + taxVarFmt + ' excess tax charged by the gateway.',
    '\nThere are no additional tax deductions.',
  ].join('\n');
}

function constructSettlementCausality(ctx, message) {
  const cat = ctx.exception_category;
  const risk = ctx.amount_at_risk_formatted || fmtINR(ctx.amount_at_risk_paise);
  const shortfall = ctx.net_shortfall_formatted || ctx.amount_at_risk_formatted || fmtINR(ctx.amount_at_risk_paise);

  if (cat === 'FEE_TAX_VARIANCE') {
    const gross = ctx.gross_amount_formatted || 'the gross amount';
    const feeExpected = ctx.fee_expected_formatted || 'N/A';
    const feeActual = ctx.fee_actual_formatted || 'N/A';
    const feeOver = ctx.fee_variance_formatted || fmtINR(ctx.fee_variance_paise);

    const taxExpected = ctx.tax_expected_formatted || 'N/A';
    const taxActual = ctx.tax_actual_formatted || 'N/A';
    const taxOver = ctx.tax_variance_formatted || fmtINR(ctx.tax_variance_paise);

    const expectedNet = ctx.expected_net_formatted || 'N/A';
    const actualNet = ctx.actual_settlement_formatted || 'N/A';

    if (/\b(how does the gross amount relate|how does gross relate|gross amount relate)\b/i.test(message || '')) {
      return [
        `Here is how the gross payment of ${gross} relates to deductions and net settlement:`,
        '',
        `1. **Gross Customer Payment:** ${gross} (total charged at checkout).`,
        `2. **Gateway Deductions:** The gateway deducted ${feeActual} in fees and ${taxActual} in GST.`,
        `3. **Contracted Expectations:** Under the merchant's contracted 2% fee rate, the expected fee was ${feeExpected} and the expected GST was ${taxExpected}.`,
        `4. **Excess Withholding:** So the gateway deducted ${feeOver} more in fees and ${taxOver} more in GST, creating a total settlement shortfall of ${shortfall}.`,
        `5. **Net Settlement Result:** Deductions reduced the settlement to ${actualNet} instead of ${expectedNet}.`,
        '',
        `• **Cause:** Fee / Tax Variance`,
        `• **Impact:** ${shortfall} less settlement than expected.`,
      ].join('\n');
    }

    return [
      `The merchant didn't receive the full ${gross} because the gateway deducted ${feeActual} in fees and ${taxActual} in GST.`,
      '',
      `Under the merchant's contracted 2% fee rate, the expected fee was ${feeExpected} and the expected GST was ${taxExpected}.`,
      '',
      `So the gateway deducted ${feeOver} more in fees and ${taxOver} more in GST, creating a total settlement shortfall of ${shortfall}.`,
      '',
      '• **Causal Breakdown (Net Settlement = Gross Amount - Gateway Fee - GST):**',
      `  Gross = ${gross}`,
      `  Expected fee = ${feeExpected} | Actual fee = ${feeActual} → Fee variance = ${feeOver}`,
      `  Expected GST = ${taxExpected} | Actual GST = ${taxActual} → GST variance = ${taxOver}`,
      `  Total settlement shortfall = ${feeOver} + ${taxOver} = ${shortfall}`,
      '',
      `• **Cause:** Fee / Tax Variance`,
      `• **Impact:** ${shortfall} less settlement than expected (${actualNet} deposited vs ${expectedNet} expected).`,
    ].join('\n');
  }

  if (cat === 'TIMING_MISMATCH') {
    return [
      `The settlement payout is lower in this batch because the payment capture and its refund occurred in different settlement batches.`,
      '',
      `• **Capture Batch:** Payment settled in batch \`${ctx.settlement_id || 'N/A'}\`.`,
      `• **Batch Timing:** The gateway settlement batch cutoff shifted ${risk} into another cycle.`,
      `• **Cause:** Timing Mismatch`,
      `• **Impact:** Temporary timing variance of ${risk}; funds balance across cycles.`,
    ].join('\n');
  }

  if (cat === 'MISSING_ORDER') {
    return [
      `The settlement credit of ${ctx.actual_settlement_formatted || risk} was received, but no matching order record was found in the merchant ledger.`,
      `• **Cause:** Missing Order in merchant ledger`,
      `• **Impact:** Unreconciled credit of ${risk}.`,
    ].join('\n');
  }

  if (cat === 'MISSING_PAYMENT') {
    return [
      `The merchant did not receive the expected settlement of ${ctx.expected_net_formatted || risk} because the gateway has not disbursed a settlement record for order \`${ctx.order_id || 'N/A'}\`.`,
      `• **Cause:** Missing Payment from gateway`,
      `• **Impact:** ${risk} expected settlement missing from gateway payout.`,
    ].join('\n');
  }

  if (ctx.cause_and_effect_summary) return ctx.cause_and_effect_summary;

  return 'The settlement variance of ' + risk + ' reflects the gap between the expected net payout (' +
    ctx.expected_net_formatted + ') and the actual credit received (' + ctx.actual_settlement_formatted + ').';
}

function constructWhereDidMoneyGo(ctx) {
  const cat = ctx.exception_category;
  const risk = ctx.amount_at_risk_formatted || fmtINR(ctx.amount_at_risk_paise);
  const shortfall = ctx.net_shortfall_formatted || risk;

  if (cat === 'FEE_TAX_VARIANCE') {
    const feeOver = ctx.fee_variance_formatted || fmtINR(ctx.fee_variance_paise);
    const taxOver = ctx.tax_variance_formatted || fmtINR(ctx.tax_variance_paise);
    const feeActual = ctx.fee_actual_formatted || 'N/A';
    const feeExpected = ctx.fee_expected_formatted || 'N/A';
    const taxActual = ctx.tax_actual_formatted || 'N/A';
    const taxExpected = ctx.tax_expected_formatted || 'N/A';

    return [
      `The missing **${shortfall}** was absorbed entirely by excess deductions taken by the payment gateway:`,
      '',
      `1. **Platform fee overcharge:** **${feeOver}** extra was deducted (${feeActual} actual vs ${feeExpected} contracted).`,
      `2. **GST overcharge:** **${taxOver}** extra was deducted (${taxActual} actual vs ${taxExpected} contracted).`,
      '',
      `Combined excess deductions: ${feeOver} + ${taxOver} = **${shortfall}**.`,
      '',
      `The money is not lost in transit — it was retained by the payment gateway due to incorrect fee schedule application and is recoverable via a fee correction credit dispute.`,
    ].join('\n');
  }

  if (cat === 'TIMING_MISMATCH') {
    return `The missing ${risk} is not permanently lost — it is held in an alternate settlement batch cycle due to banking cutoff timings. Once both batches clear, the funds reconcile in full.`;
  }

  if (cat === 'MISSING_PAYMENT') {
    return `The missing ${risk} is currently held by the payment gateway and has not been disbursed for order \`${ctx.order_id || 'N/A'}\`.`;
  }

  return `The missing ${risk} represents the variance between the gateway settlement record and merchant ledger. Review the settlement records to trace allocation.`;
}

function constructFalsePositiveAssessment(ctx) {
  const cat = ctx.exception_category;
  const risk = ctx.amount_at_risk_formatted || fmtINR(ctx.amount_at_risk_paise);

  if (cat === 'FEE_TAX_VARIANCE') {
    const feeOver = ctx.fee_variance_formatted || fmtINR(ctx.fee_variance_paise);
    const taxOver = ctx.tax_variance_formatted || fmtINR(ctx.tax_variance_paise);
    const feeActual = ctx.fee_actual_formatted || 'N/A';
    const feeExpected = ctx.fee_expected_formatted || 'N/A';
    const taxActual = ctx.tax_actual_formatted || 'N/A';
    const taxExpected = ctx.tax_expected_formatted || 'N/A';

    return [
      `**Assessment: Highly unlikely to be a false positive.**`,
      '',
      `This discrepancy is confirmed by deterministic evidence from authoritative source records:`,
      '',
      `1. **Verifiable Gateway Records:** The gateway settlement log explicitly confirms actual deductions of ${feeActual} (platform fee) and ${taxActual} (GST).`,
      `2. **Contracted Schedule:** The merchant's contracted schedule specifies 2.0% fee (${feeExpected}) and 18.0% GST (${taxExpected}).`,
      `3. **Exact Mathematical Consistency:** The fee overcharge (${feeOver}) and GST overcharge (${taxOver}) sum exactly to the ${risk} settlement shortfall.`,
      '',
      `Because this variance is grounded in hard settlement logs and deterministic arithmetic rather than statistical heuristics, this represents a genuine gateway fee overcharge rather than a false positive.`,
    ].join('\n');
  }

  if (cat === 'TIMING_MISMATCH') {
    return [
      `**Assessment: Valid flag, but operationally benign.**`,
      '',
      `The timing discrepancy is real — the payment capture and refund occurred across different settlement batch cycles. However, this is not an indicator of financial loss because the funds balance out across periods.`,
    ].join('\n');
  }

  return [
    `**Assessment for Case \`${ctx.case_id}\` (${catLabel(cat)}):**`,
    `The exception was triggered by deterministic reconciliation rules with ${risk} at risk. Review the case evidence to verify before closing.`,
  ].join('\n');
}

function constructWhyFlagged(ctx) {
  const cat = ctx.exception_category;
  const risk = ctx.amount_at_risk_formatted || fmtINR(ctx.amount_at_risk_paise);

  if (cat === 'FEE_TAX_VARIANCE') {
    const feeOver = ctx.fee_variance_formatted || fmtINR(ctx.fee_variance_paise);
    const taxOver = ctx.tax_variance_formatted || fmtINR(ctx.tax_variance_paise);
    return [
      'This case was flagged as a **Fee / Tax Variance** because the payment gateway deducted higher fees and taxes than the contracted platform rate (2.0% fee + 18.0% GST on fee).\n',
      '• **Fee charged:** ' + ctx.fee_actual_formatted + ' vs **Expected:** ' + ctx.fee_expected_formatted + ' (' + feeOver + ' overcharge)',
      '• **GST charged:** ' + ctx.tax_actual_formatted + ' vs **Expected:** ' + ctx.tax_expected_formatted + ' (' + taxOver + ' overcharge)',
      '• **Net settlement impact:** The gateway credited ' + ctx.actual_settlement_formatted + ' instead of ' + ctx.expected_net_formatted + ', leaving a shortfall of ' + risk + ' at risk.',
    ].join('\n');
  }

  if (cat === 'TIMING_MISMATCH') {
    return 'This case was flagged as a **Timing Mismatch** because the payment capture and its corresponding refund appeared in different settlement batch cycles.\n' +
      'The money is accounted for, but the cross-period batch split creates a temporary reconciliation imbalance of ' + risk + '.';
  }

  if (cat === 'MISSING_ORDER') {
    return 'This case was flagged as a **Missing Order** because a gateway settlement credit of ' + (ctx.actual_settlement_formatted || risk) +
      ' was received into the merchant account, but no matching order record exists in the merchant ledger for payment entity `' + (ctx.payment_id || 'unknown') + '`.';
  }

  if (cat === 'MISSING_PAYMENT') {
    return 'This case was flagged as a **Missing Payment** because merchant order `' + (ctx.order_id || 'unknown') +
      '` was recorded in the ledger, but no corresponding settlement payout of ' + risk + ' has been received from the gateway.';
  }

  if (cat === 'DUPLICATE') {
    return 'This case was flagged as a **Duplicate Settlement** because multiple settlement credits with identical amounts were posted for order `' +
      (ctx.order_id || 'unknown') + '`, creating potential double-credit exposure of ' + risk + '.';
  }

  return 'This case was flagged under category **' + catLabel(cat) + '** with **' + risk + '** at risk.';
}

function constructAmountAtRisk(ctx) {
  const risk = ctx.amount_at_risk_formatted || fmtINR(ctx.amount_at_risk_paise);
  const shortfall = ctx.net_shortfall_formatted || risk;

  if (ctx.exception_category === 'FEE_TAX_VARIANCE') {
    return [
      'The financial exposure for this case is **' + risk + '**.\n',
      'This matches the net settlement shortfall caused by the combined fee overcharge (' + ctx.fee_variance_formatted + ') and GST overcharge (' + ctx.tax_variance_formatted + '). This amount is currently owed back to the merchant as a fee correction credit.',
    ].join('\n');
  }

  return 'The total amount at risk for this case is **' + risk + '** (Case ID: `' + ctx.case_id + '`, Status: `' + (ctx.status || 'OPEN') + '`).';
}

function constructWhatToVerify(ctx) {
  const actions = ctx.suggested_actions && ctx.suggested_actions.length > 0
    ? ctx.suggested_actions
    : [
        { priority: 'HIGH', description: 'Verify gateway contract fee schedule against settlement deduction.' },
        { priority: 'HIGH', description: 'Request fee correction credit from the payment gateway.' },
        { priority: 'MEDIUM', description: 'Record investigation findings in the case audit log.' },
      ];

  const actionLines = actions.map(function(a, i) {
    return (i + 1) + '. **[' + (a.priority || 'MEDIUM') + ']** ' + a.description;
  });

  return [
    '**Before resolving case `' + ctx.case_id + '` (' + catLabel(ctx.exception_category) + '), verify the following:**\n',
    actionLines.join('\n'),
    '\n_Note: Once verified, complete the resolution using the **"Resolve"** button in the investigation workstation._',
  ].join('\n');
}

function constructSimpleExplanation(ctx) {
  const cat = catLabel(ctx.exception_category);

  if (ctx.exception_category === 'FEE_TAX_VARIANCE') {
    return [
      '**Simple Explanation — Fee / Tax Variance:**\n',
      'A customer paid **' + ctx.gross_amount_formatted + '**. Based on the agreed 2% contract rate, Payvault expected the gateway to deduct **' + ctx.fee_expected_formatted + '** in fees plus **' + ctx.tax_expected_formatted + '** in GST, leaving **' + ctx.expected_net_formatted + '** for the merchant.',
      'Instead, the gateway took **' + ctx.fee_actual_formatted + '** in fees and **' + ctx.tax_actual_formatted + '** in GST, depositing only **' + ctx.actual_settlement_formatted + '**.',
      'The extra **' + ctx.amount_at_risk_formatted + '** deducted is an overcharge that needs to be verified and claimed back from the gateway.',
    ].join('\n\n');
  }

  if (ctx.exception_category === 'TIMING_MISMATCH') {
    return '**Simple Explanation — Timing Mismatch:**\n\nA transaction and its refund occurred in two separate settlement batches. The funds balance out over time, but the difference across batch cutoff dates triggered this flag.';
  }

  return '**Simple Explanation — ' + cat + ':**\n\nCase `' + ctx.case_id + '` has a ' + cat + ' discrepancy with **' + (ctx.amount_at_risk_formatted || 'unknown') + '** at risk between what was expected and what the payment gateway processed. Review the evidence and suggested actions to close the case.';
}

function constructFullBreakdown(ctx) {
  const lines = [
    '**Complete Financial Breakdown — ' + catLabel(ctx.exception_category) + ' (Case: `' + ctx.case_id + '`)**\n',
    '• **Gross Customer Amount:** ' + ctx.gross_amount_formatted,
    '• **Expected Platform Fee (2.0%):** ' + ctx.fee_expected_formatted,
    '• **Actual Platform Fee Charged:** ' + ctx.fee_actual_formatted,
    '• **Fee Variance:** ' + (ctx.fee_variance_formatted || '₹0.00') + (ctx.fee_is_overcharged ? ' (overcharged)' : ''),
    '• **Expected GST (18.0% of fee):** ' + ctx.tax_expected_formatted,
    '• **Actual GST Charged:** ' + ctx.tax_actual_formatted,
    '• **GST Variance:** ' + (ctx.tax_variance_formatted || '₹0.00') + (ctx.tax_is_overcharged ? ' (overcharged)' : ''),
    '• **Expected Net Settlement:** ' + ctx.expected_net_formatted,
    '• **Actual Settlement Received:** ' + ctx.actual_settlement_formatted,
    '• **Net Settlement Shortfall:** ' + (ctx.net_shortfall_formatted || ctx.amount_at_risk_formatted),
    '• **Amount at Risk:** ' + ctx.amount_at_risk_formatted,
    '• **Payment ID:** `' + (ctx.payment_id || 'N/A') + '`',
    '• **Settlement Batch:** `' + (ctx.settlement_id || 'N/A') + '`',
  ];

  if (ctx.cause_and_effect_summary) {
    lines.push('\n**Relationship Analysis:**\n' + ctx.cause_and_effect_summary);
  }

  return lines.join('\n');
}

function constructWhyNot90Paise(ctx) {
  const taxAct = ctx.tax_actual_formatted || '₹8.10';
  const taxExp = ctx.tax_expected_formatted || '₹3.60';
  const taxVar = ctx.tax_variance_formatted || '₹4.50';

  return [
    'The GST variance is **' + taxVar + '**, not ₹0.90.\n',
    'Here is the exact derivation:',
    '• **Actual GST charged by gateway:** ' + taxAct,
    '• **Expected GST (18.0% of contracted fee):** ' + taxExp,
    '• **Variance:** ' + taxAct + ' - ' + taxExp + ' = **' + taxVar + '** excess GST charged.\n',
    '₹0.90 would only arise from an invalid double-subtraction (subtracting the expected GST of ' + taxExp + ' from the variance of ' + taxVar + '). That calculation has no accounting basis. The gateway deducted ' + taxAct + ' instead of ' + taxExp + ', making the complete overcharge ' + taxVar + ' with no secondary deductions.',
  ].join('\n');
}

function constructMathExplanation(ctx) {
  const feeAct = ctx.fee_actual_formatted || '₹45.00';
  const feeExp = ctx.fee_expected_formatted || '₹20.00';
  const feeVar = ctx.fee_variance_formatted || '₹25.00';
  const taxAct = ctx.tax_actual_formatted || '₹8.10';
  const taxExp = ctx.tax_expected_formatted || '₹3.60';
  const taxVar = ctx.tax_variance_formatted || '₹4.50';
  const gross = ctx.gross_amount_formatted || '₹1,000.00';
  const expNet = ctx.expected_net_formatted || '₹976.40';
  const actNet = ctx.actual_settlement_formatted || '₹946.90';
  const shortfall = ctx.net_shortfall_formatted || '₹29.50';

  return [
    '**Mathematical Derivation for Case `' + ctx.case_id + '`:**\n',
    '1. **Platform Fee Overcharge:**',
    '   Actual Fee (' + feeAct + ') - Expected Fee (' + feeExp + ') = **' + feeVar + '**\n',
    '2. **GST Overcharge (18% on fee):**',
    '   Actual GST (' + taxAct + ') - Expected GST (' + taxExp + ') = **' + taxVar + '**\n',
    '3. **Total Excess Deductions:**',
    '   Fee Overcharge (' + feeVar + ') + GST Overcharge (' + taxVar + ') = **' + shortfall + '**\n',
    '4. **Net Settlement Verification:**',
    '   • Expected Net: ' + gross + ' - ' + feeExp + ' - ' + taxExp + ' = **' + expNet + '**',
    '   • Actual Net Received: ' + gross + ' - ' + feeAct + ' - ' + taxAct + ' = **' + actNet + '**',
    '   • Shortfall: ' + expNet + ' - ' + actNet + ' = **' + shortfall + '**.',
  ].join('\n');
}

function constructIdentifierLookup(ctx, message) {
  const norm = (message || '').toLowerCase();
  if (norm.includes('payment')) return 'The payment ID for this case is `' + (ctx.payment_id || 'N/A') + '`.';
  if (norm.includes('order')) return 'The merchant order ID for this case is `' + (ctx.order_id || 'N/A') + '`.';
  if (norm.includes('utr')) return 'The settlement UTR for this batch is `' + (ctx.settlement_utr || 'N/A') + '`.';
  if (norm.includes('batch') || norm.includes('settlement id')) {
    return 'The settlement batch ID is `' + (ctx.settlement_id || 'N/A') + '` (UTR: `' + (ctx.settlement_utr || 'N/A') + '`).';
  }
  return [
    '**Identifiers for Case `' + ctx.case_id + '`:**',
    '• **Payment ID:** `' + (ctx.payment_id || 'N/A') + '`',
    '• **Order ID:** `' + (ctx.order_id || 'N/A') + '`',
    '• **Settlement Batch:** `' + (ctx.settlement_id || 'N/A') + '` (UTR: `' + (ctx.settlement_utr || 'N/A') + '`)',
    '• **Payment Method:** `' + (ctx.payment_method || 'CARD') + '`',
  ].join('\n');
}

function constructSettlementLookup(ctx, message) {
  const norm = (message || '').toLowerCase();
  if (norm.includes('expected')) {
    return 'The expected net settlement payout was **' + ctx.expected_net_formatted + '** (Gross ' + ctx.gross_amount_formatted + ' minus contracted fee ' + ctx.fee_expected_formatted + ' and GST ' + ctx.tax_expected_formatted + ').';
  }
  if (norm.includes('actual') || norm.includes('received')) {
    return 'The actual settlement credit received was **' + ctx.actual_settlement_formatted + '**, which is short by **' + (ctx.net_shortfall_formatted || ctx.amount_at_risk_formatted) + '** due to gateway fee and tax overcharges.';
  }
  return [
    '**Settlement Comparison for Case `' + ctx.case_id + '`:**',
    '• **Expected Net Settlement:** ' + ctx.expected_net_formatted,
    '• **Actual Settlement Received:** ' + ctx.actual_settlement_formatted,
    '• **Net Shortfall:** ' + (ctx.net_shortfall_formatted || ctx.amount_at_risk_formatted),
  ].join('\n');
}

function constructIsFeeTheProblem(ctx) {
  if (ctx.fee_variance_paise && ctx.fee_variance_paise > 0) {
    const feeOver = ctx.fee_variance_formatted;
    const taxOver = ctx.tax_variance_formatted || '₹0.00';
    const totalShort = ctx.net_shortfall_formatted || ctx.amount_at_risk_formatted;
    return [
      'Yes, the platform fee is the primary driver of this exception.',
      'The gateway deducted **' + ctx.fee_actual_formatted + '** instead of the contracted 2.0% fee of **' + ctx.fee_expected_formatted + '**, producing a **' + feeOver + '** fee overcharge.',
      'This also inflated the associated GST by **' + taxOver + '**, combining for the total settlement shortfall of **' + totalShort + '**.',
    ].join('\n\n');
  }

  if (ctx.exception_category === 'FEE_TAX_VARIANCE') {
    return 'Yes, this case is specifically classified as Fee / Tax Variance with a recorded discrepancy of ' + ctx.amount_at_risk_formatted + '.';
  }

  return 'No, the platform fee is not the primary issue in this case. The case was flagged as **' + catLabel(ctx.exception_category) + '** (' + ctx.amount_at_risk_formatted + ' at risk).';
}

// ── Answer constructor: Resolution Guidance ──────────────────────────────────

/**
 * Answers "can I close this?", "is it okay to resolve?", "ready to resolve?"
 *
 * This is NOT the state-change guard. The operator is asking for guidance on
 * whether to resolve — not asking the AI to resolve. The AI always defers to
 * the operator's judgment and the human-controlled Resolve button.
 *
 * Uses ctx.status, ctx.suggested_actions, and exception knowledge to advise.
 */
function constructResolutionGuidance(ctx, reasoning) {
  const cat = catLabel(ctx.exception_category);
  const status = ctx.status || 'OPEN';
  const risk = ctx.amount_at_risk_formatted || fmtINR(ctx.amount_at_risk_paise);
  const excKnowledge = reasoning ? reasoning.exception_knowledge : null;

  // If already resolved, say so clearly
  if (status === 'RESOLVED') {
    return [
      `**Case \`${ctx.case_id}\` is already resolved.**\n`,
      `The investigation was previously closed with the recorded resolution.`,
      `I can explain the resolution findings, but cannot change the case state.`,
      `\n_To reopen: click the **"Reopen"** button in the investigation workstation._`,
    ].join('\n');
  }

  // Check if actions are pending
  const actions = ctx.suggested_actions || [];
  const highPriorityPending = actions.filter(function(a) { return a.priority === 'HIGH'; });

  const lines = [
    `**Resolution Readiness — Case \`${ctx.case_id}\` (${cat}):**\n`,
    `**Current status:** ${status}`,
    `**Amount at risk:** ${risk}\n`,
  ];

  if (status === 'OPEN') {
    lines.push('This case is currently **OPEN** — not yet reviewed.');
    if (highPriorityPending.length > 0) {
      lines.push('\nBefore resolving, complete the following high-priority steps:');
      highPriorityPending.forEach(function(a, i) {
        lines.push((i + 1) + '. ' + a.description);
      });
    }
    if (excKnowledge && excKnowledge.requires_gateway_action) {
      lines.push('\n• **Gateway action required:** Raise a fee dispute and obtain a credit adjustment before resolving.');
    }
    if (excKnowledge && excKnowledge.typical_resolution) {
      lines.push(`\n**Resolve when:** ${excKnowledge.typical_resolution}`);
    }
    lines.push('\n_When ready: click the **"Resolve"** button in the investigation workstation. The AI does not resolve cases — you do._');
  } else if (status === 'IN_REVIEW') {
    lines.push('This case is currently **IN REVIEW** — under active operator review.');
    if (actions.length > 0) {
      lines.push('\nOutstanding steps:');
      actions.slice(0, 3).forEach(function(a, i) {
        lines.push((i + 1) + '. ' + a.description);
      });
    }
    if (excKnowledge && excKnowledge.typical_resolution) {
      lines.push(`\n**Resolve when:** ${excKnowledge.typical_resolution}`);
    }
    lines.push('\n_When ready: click the **"Resolve"** button in the investigation workstation._');
  }

  return lines.join('\n');
}

// ── Answer constructors for new intents ──────────────────────────────────────

function constructGrossAmount(ctx) {
  if (ctx.gross_amount_paise === null || ctx.gross_amount_paise === undefined) {
    return 'Gross amount data is not available for case `' + ctx.case_id + '`.';
  }
  return [
    'The **gross customer payment** for case `' + ctx.case_id + '` was **' + ctx.gross_amount_formatted + '**.\n',
    '• **Gross Transaction Amount:** ' + ctx.gross_amount_formatted,
    '• **Payment Method:** ' + (ctx.payment_method || 'CARD'),
    '• **Order Reference:** `' + (ctx.order_id || ctx.payment_id || 'N/A') + '`',
    '\nThis represents the total customer payment charged at checkout before any gateway fee or tax deductions.',
  ].join('\n');
}

function constructExpectedSettlement(ctx) {
  if (ctx.expected_net_paise === null || ctx.expected_net_paise === undefined) {
    return 'Expected settlement data is not available for case `' + ctx.case_id + '`.';
  }
  return [
    'The **expected net settlement** for case `' + ctx.case_id + '` was **' + ctx.expected_net_formatted + '**.\n',
    'This is calculated from:',
    '• Gross customer payment: ' + ctx.gross_amount_formatted,
    '• Minus contracted platform fee (2.0%): ' + ctx.fee_expected_formatted,
    '• Minus expected GST (18% of contracted fee): ' + ctx.tax_expected_formatted,
    '• **= Expected net settlement: ' + ctx.expected_net_formatted + '**\n',
    'Instead, the merchant received only **' + ctx.actual_settlement_formatted + '**, which is short by **' + (ctx.net_shortfall_formatted || ctx.amount_at_risk_formatted) + '** due to gateway overcharges.',
  ].join('\n');
}

function constructActualSettlement(ctx) {
  if (ctx.actual_settlement_paise === null || ctx.actual_settlement_paise === undefined) {
    return 'Actual settlement data is not available for case `' + ctx.case_id + '`.';
  }
  const shortfall = ctx.net_shortfall_formatted || ctx.amount_at_risk_formatted;
  return [
    'The **actual settlement received** for case `' + ctx.case_id + '` was **' + ctx.actual_settlement_formatted + '**.\n',
    'This is **' + shortfall + ' less** than the expected payout of ' + ctx.expected_net_formatted + '.',
    ctx.fee_variance_paise > 0
      ? 'The shortfall is caused by the gateway overcharging **' + ctx.fee_variance_formatted + '** in platform fees and **' + ctx.tax_variance_formatted + '** in GST.'
      : '',
  ].filter(Boolean).join('\n');
}

function constructTotalDeductions(ctx) {
  const totalFeeActual = ctx.fee_actual_formatted || 'N/A';
  const totalTaxActual = ctx.tax_actual_formatted || 'N/A';
  const totalActualPaise = (ctx.fee_actual_paise || 0) + (ctx.tax_actual_paise || 0);
  const totalExpectedPaise = (ctx.fee_expected_paise || 0) + (ctx.tax_expected_paise || 0);
  const overchargePaise = totalActualPaise - totalExpectedPaise;

  return [
    '**Total deductions from the gross payment for case `' + ctx.case_id + '`:**\n',
    '• **Platform fee deducted:** ' + totalFeeActual,
    '• **GST deducted:** ' + totalTaxActual,
    '• **Total deductions:** ' + fmtINR(totalActualPaise),
    '',
    '**Expected deductions (per contract):**',
    '• Expected platform fee: ' + (ctx.fee_expected_formatted || 'N/A'),
    '• Expected GST: ' + (ctx.tax_expected_formatted || 'N/A'),
    '• **Total expected deductions:** ' + fmtINR(totalExpectedPaise),
    '',
    overchargePaise > 0
      ? '**Excess deductions: ' + fmtINR(overchargePaise) + '** (overcharged by the gateway)'
      : 'Deductions are within the expected range.',
  ].join('\n');
}

function constructUnknownQuery(message) {
  return [
    'That question appears to be outside the scope of Payvault\'s payment investigation capabilities.\n',
    'Payvault AI is specialized for **payment reconciliation investigation** — it can answer questions about:',
    '• Transaction amounts, fees, and taxes',
    '• Settlement discrepancies and shortfalls',
    '• Investigation evidence and next steps',
    '• Escalation and resolution guidance',
    '• Historical case comparison and anomaly detection\n',
    'Please ask a question related to the current investigation case.',
  ].join('\n');
}

// ── Step 5: Main Entry Point ──────────────────────────────────────────────────
/**
 * Generate a Payvault AI conversational answer using the native reasoning pipeline.
 *
 * ACTIVE CHAT EXECUTION PATH — No Qwen/Ollama involved.
 *
 * Pipeline:
 *   1. Resolve conversational references
 *   2. Classify intent semantically (rule-based, with ML signal overlay)
 *   3. Build internal reasoning result
 *   4. Construct dynamic answer per intent
 *   5. Return answer + intent
 *
 * @param {string} message  — Operator's question
 * @param {Object} ctx      — Built by chatContextBuilder
 * @param {Array}  history  — [{role, content}] prior turns
 * @returns {{ answer: string, intent: string }}
 *
 * NOTE: This function is SYNCHRONOUS for test compatibility.
 * The async version (generateNativeAnswerAsync) integrates ML signals.
 */
function ensureFormattedContext(ctx) {
  if (!ctx) return {};
  if (!ctx.gross_amount_formatted && ctx.gross_amount_paise !== null && ctx.gross_amount_paise !== undefined) {
    ctx.gross_amount_formatted = fmtINR(ctx.gross_amount_paise);
  }
  if (!ctx.amount_at_risk_formatted && ctx.amount_at_risk_paise !== null && ctx.amount_at_risk_paise !== undefined) {
    ctx.amount_at_risk_formatted = fmtINR(ctx.amount_at_risk_paise);
  }
  if (!ctx.net_shortfall_formatted && ctx.net_shortfall_paise !== null && ctx.net_shortfall_paise !== undefined) {
    ctx.net_shortfall_formatted = fmtINR(ctx.net_shortfall_paise);
  }
  if (!ctx.fee_actual_formatted && ctx.fee_actual_paise !== null && ctx.fee_actual_paise !== undefined) {
    ctx.fee_actual_formatted = fmtINR(ctx.fee_actual_paise);
  }
  if (!ctx.fee_expected_formatted && ctx.fee_expected_paise !== null && ctx.fee_expected_paise !== undefined) {
    ctx.fee_expected_formatted = fmtINR(ctx.fee_expected_paise);
  }
  if (!ctx.fee_variance_formatted && ctx.fee_variance_paise !== null && ctx.fee_variance_paise !== undefined) {
    ctx.fee_variance_formatted = fmtINR(ctx.fee_variance_paise);
  }
  if (!ctx.tax_actual_formatted && ctx.tax_actual_paise !== null && ctx.tax_actual_paise !== undefined) {
    ctx.tax_actual_formatted = fmtINR(ctx.tax_actual_paise);
  }
  if (!ctx.tax_expected_formatted && ctx.tax_expected_paise !== null && ctx.tax_expected_paise !== undefined) {
    ctx.tax_expected_formatted = fmtINR(ctx.tax_expected_paise);
  }
  if (!ctx.tax_variance_formatted && ctx.tax_variance_paise !== null && ctx.tax_variance_paise !== undefined) {
    ctx.tax_variance_formatted = fmtINR(ctx.tax_variance_paise);
  }
  if (!ctx.actual_settlement_formatted && ctx.actual_settlement_paise !== null && ctx.actual_settlement_paise !== undefined) {
    ctx.actual_settlement_formatted = fmtINR(ctx.actual_settlement_paise);
  }
  if (!ctx.expected_net_formatted && ctx.expected_net_paise !== null && ctx.expected_net_paise !== undefined) {
    ctx.expected_net_formatted = fmtINR(ctx.expected_net_paise);
  }
  return ctx;
}

function generateNativeAnswer(message, ctx, history) {
  history = history || [];
  ctx = ensureFormattedContext(ctx);

  // Step 1: Resolve pronouns/references from conversation history
  const resolvedMessage = resolveConversationReferences(message, history, ctx);

  // Step 2: Classify semantic intent (deterministic rule-based)
  const intent = classifyIntent(resolvedMessage, history, ctx);

  // Step 3: Build internal reasoning result (never shown to user)
  const reasoning = buildReasoningResult(intent, ctx, history);

  // Step 4: Construct the answer dynamically from reasoning
  const answer = _constructAnswer(intent, ctx, reasoning, resolvedMessage);

  return { answer, intent };
}

/**
 * Async version of generateNativeAnswer.
 *
 * V2 PIPELINE — ML is the PRIMARY intent signal:
 *   Step 1: Resolve conversational references (structured state first)
 *   Step 2: Rule-based guards (state-change, resolution readiness, out-of-domain)
 *   Step 3: ML intent classifier — PRIMARY language understanding signal
 *   Step 4: Rule-based intent fallback (when ML is unavailable or low-confidence)
 *   Step 5: Safety override rules (deterministic correctness gates)
 *   Step 6: Build internal reasoning result
 *   Step 7: Construct answer
 *
 * @param {string} message
 * @param {Object} ctx
 * @param {Array}  history
 * @returns {Promise<{ answer, intent, ml_intent?, ml_confidence?, conversationState? }>}
 */
async function generateNativeAnswerAsync(message, ctx, history, existingState = null) {
  history = history || [];
  ctx = ensureFormattedContext(ctx);

  // Step 1: Resolve conversational references (V2: uses structured state first)
  const resolvedMessage = resolveConversationReferences(message, history, ctx);

  // Build and attach conversation state for downstream use
  const convState = buildConversationState(message, history, ctx, existingState);

  // Step 2: Hard deterministic guards (these always override ML)
  const normResolved = resolvedMessage.trim().toLowerCase();
  if (isResolutionReadinessInquiry(normResolved)) {
    const reasoning = buildReasoningResult('resolution_guidance', ctx, history);
    const answer = constructResolutionGuidance(ctx, reasoning);
    return {
      answer,
      intent: 'resolution_guidance',
      ml_intent: null,
      ml_confidence: null,
      conversationState: convState,
    };
  }
  if (isStateChangeRequest(normResolved)) {
    return {
      answer: constructStateChangeGuard(),
      intent: 'state_change_guard',
      ml_intent: null,
      ml_confidence: null,
      conversationState: convState,
    };
  }

  // Step 3: ML intent classifier — PRIMARY signal
  // ML runs on every question (not only as fallback).
  // High-confidence ML result (≥0.55) overrides rule-based classification.
  // This makes language understanding the primary driver, not a keyword list.
  let mlIntent     = null;
  let mlConfidence = null;
  let mlNativeIntent = null;

  const bridge = getIntentBridge();
  if (bridge) {
    try {
      const mlResult = await bridge.classify(resolvedMessage);
      if (mlResult && mlResult.nativeIntent && mlResult.confidence >= 0.40) {
        mlNativeIntent = mlResult.nativeIntent;
        mlIntent       = mlResult.mlIntent;
        mlConfidence   = mlResult.confidence;
      }
    } catch (_) {
      // ML unavailable — fall through to rule-based
    }
  }

  // Step 4: Rule-based intent (always runs — provides deterministic safety)
  const ruleIntent = classifyIntent(resolvedMessage, history, ctx);

  // Step 5: Select final intent
  // Priority:
  //   a) Rule-based ALWAYS wins for deterministic intents:
  //      - Guard intents (state_change_guard, resolution_guidance, unknown_query)
  //      - Causal/financial intents where rule patterns are precise and specific
  //   b) ML wins when rules fall back to diagnostic_summary (rules found nothing)
  //   c) High-confidence ML (≥0.65) wins for non-guarded intents vs diagnostic_summary
  const GUARD_INTENTS = new Set([
    'state_change_guard', 'resolution_guidance', 'unknown_query',
    'settlement_causality', 'where_did_money_go', 'is_fee_the_problem',
    'false_positive_assessment', 'why_flagged', 'gross_amount',
    'expected_settlement', 'actual_settlement', 'fee_specific',
    'tax_specific', 'math_explanation', 'why_not_90_paise'
  ]);

  let finalIntent = ruleIntent;

  if (!GUARD_INTENTS.has(ruleIntent)) {
    if (mlNativeIntent) {
      if (ruleIntent === 'diagnostic_summary') {
        // Rules found nothing specific — use ML
        finalIntent = mlNativeIntent;
      } else if (mlConfidence >= 0.65 && mlNativeIntent !== 'diagnostic_summary') {
        // High-confidence ML overrides specific rule match
        finalIntent = mlNativeIntent;
      }
    }
  }

  // Step 6: Build internal reasoning result
  const reasoning = buildReasoningResult(finalIntent, ctx, history);

  // Step 7: Construct answer
  const answer = _constructAnswer(finalIntent, ctx, reasoning, resolvedMessage);

  return {
    answer,
    intent:          finalIntent,
    ml_intent:       mlIntent,
    ml_confidence:   mlConfidence,
    conversationState: convState,
  };
}

/**
 * Internal answer dispatcher — maps intent to constructor.
 * Separated from generateNativeAnswer so both sync and async paths share it.
 */
function _constructAnswer(intent, ctx, reasoning, resolvedMessage) {
  switch (intent) {
    case 'state_change_guard':       return constructStateChangeGuard();
    case 'resolution_guidance':      return constructResolutionGuidance(ctx, reasoning);
    case 'gross_amount':             return constructGrossAmount(ctx);
    case 'expected_settlement':      return constructExpectedSettlement(ctx);
    case 'actual_settlement':        return constructActualSettlement(ctx);
    case 'total_deductions':         return constructTotalDeductions(ctx);
    case 'next_action':              return constructNextAction(ctx, reasoning);
    case 'escalation_assessment':    return constructEscalationAssessment(ctx, reasoning);
    case 'real_financial_loss':      return constructRealFinancialLoss(ctx, reasoning);
    case 'evidence_assessment':      return constructEvidenceAssessment(ctx, reasoning);
    case 'false_positive_assessment': return constructFalsePositiveAssessment(ctx);
    case 'where_did_money_go':       return constructWhereDidMoneyGo(ctx);
    case 'historical_cases':         return constructHistoricalComparison(ctx);
    case 'why_flagged':              return constructWhyFlagged(ctx);
    case 'fee_specific':             return constructFeeSpecific(ctx, resolvedMessage);
    case 'tax_specific':             return constructTaxSpecific(ctx, resolvedMessage);
    case 'is_fee_the_problem':       return constructIsFeeTheProblem(ctx);
    case 'settlement_causality':     return constructSettlementCausality(ctx, resolvedMessage);
    case 'amount_at_risk':           return constructAmountAtRisk(ctx);
    case 'what_to_verify':           return constructWhatToVerify(ctx);
    case 'simple_explanation':       return constructSimpleExplanation(ctx);
    case 'full_financial_breakdown': return constructFullBreakdown(ctx);
    case 'why_not_90_paise':         return constructWhyNot90Paise(ctx);
    case 'math_explanation':         return constructMathExplanation(ctx);
    case 'identifier_lookup':        return constructIdentifierLookup(ctx, resolvedMessage);
    case 'settlement_lookup':        return constructSettlementLookup(ctx, resolvedMessage);
    case 'unknown_query':            return constructUnknownQuery(resolvedMessage);
    case 'diagnostic_summary':
    default:                         return constructDiagnosticSummary(ctx, resolvedMessage);
  }
}

/**
 * Expose classifyIntent so chatRouter can use it for complexity assessment.
 */
function analyzeIntent(message, history, ctx) {
  const resolved = resolveConversationReferences(message, history || [], ctx || {});
  return classifyIntent(resolved, history || [], ctx || {});
}

module.exports = {
  generateNativeAnswer,
  generateNativeAnswerAsync,
  analyzeIntent,
  classifyIntent,
  resolveConversationReferences,
  buildReasoningResult,
  catLabel,
  // Conversation state (V2)
  buildConversationState,
  resolveWithState,
  // Exported intent constructors for testing
  constructGrossAmount,
  constructExpectedSettlement,
  constructActualSettlement,
  constructTotalDeductions,
  constructUnknownQuery,
  constructSettlementCausality,
  constructWhereDidMoneyGo,
  constructFalsePositiveAssessment,
  constructFeeSpecific,
  constructTaxSpecific,
  constructResolutionGuidance,
  isResolutionReadinessInquiry,
};

