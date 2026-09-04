'use strict';
/**
 * src/investigation/chat/conversationState.js
 *
 * Payvault AI — Conversation State Manager.
 *
 * Builds a STRUCTURED conversation state from history turns, the current
 * user message, and the investigation context.
 *
 * This state is the authoritative source for:
 *   - What topic is currently active (currentTopic)
 *   - What intent was last classified (previousIntent)
 *   - Which financial entities have been referenced (referencedEntities)
 *   - Which financial metric was last active (activeFinancialMetric)
 *   - How many turns have occurred (turnNumber)
 *   - A short summary of the last answer (lastAnswerSummary)
 *
 * The reference resolver uses this structured state to resolve follow-ups
 * ("why?", "how?", "but how?", "what about that?") without relying on
 * regex over raw AI response text.
 *
 * ARCHITECTURAL GUARANTEE:
 *   - No financial values are invented here.
 *   - All values come from history turns or the investigation context (ctx).
 *   - This module is stateless — it re-derives state on every call.
 */

// ── Topic label map: intent → human-readable topic ───────────────────────────
const INTENT_TO_TOPIC = {
  gross_amount:             'gross_amount',
  expected_settlement:      'expected_settlement',
  actual_settlement:        'actual_settlement',
  settlement_causality:     'settlement_causality',
  settlement_lookup:        'settlement_causality',
  total_deductions:         'deductions',
  fee_specific:             'fee',
  is_fee_the_problem:       'fee',
  tax_specific:             'gst',
  amount_at_risk:           'financial_impact',
  real_financial_loss:      'financial_impact',
  why_flagged:              'exception_cause',
  diagnostic_summary:       'exception_cause',
  next_action:              'next_action',
  what_to_verify:           'verification',
  resolution_guidance:      'resolution',
  escalation_assessment:    'escalation',
  evidence_assessment:      'evidence',
  false_positive_assessment:'false_positive',
  where_did_money_go:       'financial_impact',
  historical_cases:         'historical',
  simple_explanation:       'overview',
  full_financial_breakdown: 'overview',
  math_explanation:         'calculation',
  why_not_90_paise:         'gst',
  identifier_lookup:        'identifiers',
  state_change_guard:       null,
  unknown_query:            null,
};

// ── Financial entity detector ─────────────────────────────────────────────────
const ENTITY_DETECTORS = [
  { entity: 'fee',        pattern: /\b(fee|platform fee|processing fee|gateway fee|service fee)\b/i },
  { entity: 'gst',        pattern: /\b(gst|tax|taxes|service tax)\b/i },
  { entity: 'gross',      pattern: /\b(gross|original amount|customer payment|total amount|transaction amount)\b/i },
  { entity: 'settlement', pattern: /\b(settlement|payout|net|credit|disbursement)\b/i },
  { entity: 'shortfall',  pattern: /\b(shortfall|difference|variance|gap|missing|short)\b/i },
  { entity: 'evidence',   pattern: /\b(evidence|records|documentation|proof|data|settlement record)\b/i },
  { entity: 'escalation', pattern: /\b(escalat|senior|finance team|urgent|immediate)\b/i },
  { entity: 'resolution', pattern: /\b(resolve|close|close this|resolution|completed|done)\b/i },
];

function detectEntities(text) {
  if (!text) return [];
  const found = [];
  ENTITY_DETECTORS.forEach(function(d) {
    if (d.pattern.test(text)) found.push(d.entity);
  });
  return found;
}

// ── Summary extractor from AI turn ───────────────────────────────────────────
function extractAnswerSummary(aiText) {
  if (!aiText) return null;
  const norm = aiText.toLowerCase();
  if (/\bfee overcharge\b|\bfee variance\b|\bextra fee\b/.test(norm)) return 'fee_overcharge';
  if (/\bgst overcharge\b|\bgst variance\b|\bextra gst\b/.test(norm)) return 'gst_overcharge';
  if (/\bsettlement shortfall\b|\bsettlement.*short\b|\bshortfall.*settlement\b/.test(norm)) return 'settlement_shortfall';
  if (/\bgross amount\b|\bcustomer paid\b|\boriginal payment\b/.test(norm)) return 'gross_amount';
  if (/\bexpected settlement\b|\bexpected net\b|\bshould have received\b/.test(norm)) return 'expected_settlement';
  if (/\bactual settlement\b|\bwhat.*received\b|\bactually.*credited\b/.test(norm)) return 'actual_settlement';
  if (/\bwhat should i do\b|\bnext steps?\b|\baction\b/.test(norm)) return 'next_action';
  if (/\bescalat\b/.test(norm)) return 'escalation';
  if (/\bfinancial loss\b|\breal loss\b|\bamount at risk\b/.test(norm)) return 'financial_loss';
  if (/\bevidence\b|\bsettlement record\b|\breconciliation\b/.test(norm)) return 'evidence';
  if (/\bmissing money\b|\bwhere did.*go\b|\bgateway.*deducted\b/.test(norm)) return 'money_flow';
  if (/\bfee.*tax variance\b|\btiming mismatch\b|\bmissing order\b|\bmissing payment\b|\bduplicate\b/.test(norm)) return 'exception_type';
  return 'general';
}

// ── Intent inference from user message text ───────────────────────────────────
function inferIntentFromUserMessage(userText) {
  if (!userText) return null;
  const norm = userText.toLowerCase();
  if (/\bgross\b/.test(norm)) return 'gross_amount';
  if (/\bexpected settlement\b|\bshould have\b/.test(norm)) return 'expected_settlement';
  if (/\bactual settlement\b|\bactually received\b/.test(norm)) return 'actual_settlement';
  if (/\bfee\b/.test(norm) && !/\bsettlement\b/.test(norm)) return 'fee_specific';
  if (/\bgst\b|\btax\b/.test(norm) && !/\bsettlement\b/.test(norm)) return 'tax_specific';
  if (/\bwhy.*short\b|\bwhy.*settlement\b|\bwhy.*lower\b/.test(norm)) return 'settlement_causality';
  if (/\bwhat should i do\b|\bnext steps?\b/.test(norm)) return 'next_action';
  if (/\bescalat\b/.test(norm)) return 'escalation_assessment';
  if (/\bevidence\b|\bproof\b|\brecords\b/.test(norm)) return 'evidence_assessment';
  if (/\bwhat happened\b|\bwhy did this\b|\bwhat caused\b/.test(norm)) return 'why_flagged';
  if (/\bfinancial loss\b|\blosing money\b/.test(norm)) return 'real_financial_loss';
  if (/\bwhere did.*go\b|\bmissing money\b/.test(norm)) return 'where_did_money_go';
  return null;
}

// ── Main: Build Conversation State ────────────────────────────────────────────
/**
 * Build structured conversation state from history + current message + ctx.
 *
 * @param {string} currentMessage
 * @param {Array}  history  [{role, content, intent?}]
 * @param {Object} ctx
 * @returns {Object} conversationState
 */
function buildConversationState(currentMessage, history, ctx, existingState = null) {
  history = history || [];
  ctx = ctx || {};

  let turnNumber = Math.ceil(history.length / 2) + 1;
  if (existingState && existingState.turnNumber) {
    turnNumber = Math.max(turnNumber, existingState.turnNumber + 1);
  }

  const reversedHistory = [...history].reverse();
  const lastAiTurn   = reversedHistory.find(function(h) { return h.role === 'payvault' || h.role === 'assistant'; });
  const lastUserTurn = reversedHistory.find(function(h) { return h.role === 'operator'  || h.role === 'user'; });
  const prevTurns    = reversedHistory.slice(1);
  const prevAiTurn   = prevTurns.find(function(h) { return h.role === 'payvault' || h.role === 'assistant'; });

  const lastAiText   = lastAiTurn   ? (lastAiTurn.content   || '') : '';
  const lastUserText = lastUserTurn ? (lastUserTurn.content  || '') : '';
  const prevAiText   = prevAiTurn   ? (prevAiTurn.content   || '') : '';

  let referencedEntities = Array.from(new Set([
    ...detectEntities(lastAiText),
    ...detectEntities(lastUserText),
    ...detectEntities(prevAiText),
    ...(existingState?.referencedEntities || []),
  ]));

  let previousIntent = (lastAiTurn && lastAiTurn.intent)
    || inferIntentFromUserMessage(lastUserText)
    || existingState?.previousIntent
    || null;

  let currentTopic = previousIntent ? (INTENT_TO_TOPIC[previousIntent] || null) : (existingState?.currentTopic || null);

  // Active financial metric from last AI answer
  let activeFinancialMetric = null;
  const aiLow = lastAiText.toLowerCase();
  const userLow = lastUserText.toLowerCase();

  if (/\bfee overcharge\b|\bextra fee\b|\bfee variance\b/.test(aiLow)) {
    activeFinancialMetric = 'fee_variance';
  } else if (/\bgst overcharge\b|\bextra gst\b|\bgst variance\b/.test(aiLow)) {
    activeFinancialMetric = 'gst_variance';
  } else if (/\bsettlement shortfall\b|\bshortfall\b/.test(aiLow)) {
    activeFinancialMetric = 'settlement_shortfall';
  } else if (/\bgross amount\b/.test(aiLow)) {
    activeFinancialMetric = 'gross_amount';
  } else if (/\bexpected settlement\b|\bexpected net\b/.test(aiLow)) {
    activeFinancialMetric = 'expected_settlement';
  } else if (/\bactual settlement\b|\bactually received\b/.test(aiLow)) {
    activeFinancialMetric = 'actual_settlement';
  }

  if (/\bfee\b/i.test(userLow) && !/\bgst\b|\btax\b/i.test(userLow)) {
    activeFinancialMetric = activeFinancialMetric || 'fee_variance';
  } else if (/\bgst\b|\btax\b/i.test(userLow)) {
    activeFinancialMetric = activeFinancialMetric || 'gst_variance';
  }

  if (!activeFinancialMetric && existingState?.activeFinancialMetric) {
    activeFinancialMetric = existingState.activeFinancialMetric;
  }

  const lastAnswerSummary = extractAnswerSummary(lastAiText) || existingState?.lastAnswerSummary || null;
  const prevAnswerSummary = extractAnswerSummary(prevAiText) || null;

  return {
    investigationId:      ctx.case_id || existingState?.investigationId || null,
    conversationId:       existingState?.conversationId || null,
    exceptionCategory:    ctx.exception_category || existingState?.exceptionCategory || null,
    caseStatus:           ctx.status || existingState?.caseStatus || 'OPEN',
    turnNumber,
    lastUserQuestion:     lastUserText || existingState?.lastUserQuestion || null,
    lastAnswerSummary,
    prevAnswerSummary,
    currentTopic,
    previousIntent,
    referencedEntities,
    activeFinancialMetric,
    activeEvidenceTopic:  referencedEntities.includes('evidence') ? 'settlement_records' : null,
    activeResolutionTopic: referencedEntities.includes('resolution') ? 'procedure_steps' : null,
    _lastAiText:          lastAiText,
    _lastUserText:        lastUserText,
  };
}

/**
 * Resolve short/pronoun follow-ups using structured state (not raw text regex).
 *
 * @param {string} message - Original user message
 * @param {Object} state   - From buildConversationState()
 * @returns {string}       - Resolved message
 */
function resolveWithState(message, state) {
  const norm = message.trim().toLowerCase();
  const wordCount = norm.split(/\s+/).length;

  // Resolution readiness — let intent classifier handle
  if (/\b(can i (close|resolve)|is it okay to (close|resolve)|ready to (close|resolve))\b/i.test(norm)) {
    return message;
  }

  // Medium-length pronoun follow-ups (5-10 words)
  if (wordCount >= 5 && wordCount <= 10) {
    const hasPronoun = /\b(that|it|this|the difference|the missing|the shortfall|the variance|the gap|the funds|the money|the amount)\b/.test(norm);
    if (hasPronoun) {
      if (/\bwhere\b.*\bgo\b/.test(norm)) return 'where did the missing money go?';
      if (/\bwhat (caused|created|drove|triggered)\b.*(that|this|the)\b/.test(norm)) return 'why did this discrepancy happen?';
      if (/\bhow much\b.*(that|this|the difference|the variance|the gap|the shortfall)/.test(norm)) {
        if (state.activeFinancialMetric === 'fee_variance') return 'how much was the fee overcharge?';
        if (state.activeFinancialMetric === 'gst_variance') return 'how much was the GST overcharge?';
        return 'how much is the total shortfall?';
      }
      if (/\bwhy does (that|this) matter\b/.test(norm)) {
        if (state.activeFinancialMetric === 'gst_variance') return 'why does the GST overcharge matter?';
        if (state.activeFinancialMetric === 'fee_variance') return 'why does the fee overcharge matter?';
        return 'why is the settlement shortfall significant?';
      }
      if (/\bdoes (that|this) explain\b/.test(norm)) return 'does that explain the settlement shortfall?';
      if (/\bwhat should i do (about|with|now|for) (that|this)\b/.test(norm)) return 'what should I do now?';
    }
  }

  if (wordCount > 4) return message;

  // "but how" / "how so" / "how come" / "how" — use structured topic
  if (/^(but\s+how|how\s+so|how\s+come|how)\??$/i.test(norm)) {
    const topic   = state.currentTopic;
    const summary = state.lastAnswerSummary;
    const metric  = state.activeFinancialMetric;

    if (topic === 'gross_amount' || summary === 'gross_amount') return 'how does the gross amount relate to the settlement?';
    if (topic === 'fee' || summary === 'fee_overcharge' || metric === 'fee_variance') return 'how was the fee overcharge calculated?';
    if (topic === 'gst' || summary === 'gst_overcharge' || metric === 'gst_variance') return 'how was the GST overcharge calculated?';
    if (topic === 'settlement_causality' || summary === 'settlement_shortfall') return 'how was the settlement shortfall calculated?';
    if (topic === 'expected_settlement') return 'how was the expected settlement calculated?';
    if (topic === 'actual_settlement') return 'how was the actual settlement calculated?';
    return 'how was that extra deduction calculated?';
  }

  // "where did it go"
  if (/^(where did (it|the money|the missing money|that|the funds|the difference) go)\??$/i.test(norm) ||
      /\bwhere did.*go\b/i.test(norm)) {
    return 'where did the missing money go?';
  }

  // "what now" / "what next"
  if (/^(what now|what next|where now)\??$/i.test(norm)) return 'what should I do now?';

  // "why?" — use structured state
  if (/^why\??$/.test(norm)) {
    const summary = state.lastAnswerSummary;
    const metric  = state.activeFinancialMetric;
    if (summary === 'fee_overcharge' || metric === 'fee_variance') return 'why is the fee overcharged?';
    if (summary === 'gst_overcharge' || metric === 'gst_variance') return 'why is the GST overcharged?';
    if (summary === 'settlement_shortfall' || state.currentTopic === 'settlement_causality') return 'why is the settlement short?';
    return 'why did this happen?';
  }

  // "how much?"
  if (/^how much(\s+is it|\s+was it|\?)?$/.test(norm)) {
    const metric = state.activeFinancialMetric;
    if (metric === 'fee_variance') return 'how much was the fee overcharge?';
    if (metric === 'gst_variance') return 'how much was the GST overcharge?';
    if (metric === 'settlement_shortfall') return 'how much is the total shortfall?';
    if (metric === 'gross_amount') return 'what is the gross amount?';
    if (metric === 'expected_settlement') return 'what was the expected settlement?';
    if (metric === 'actual_settlement') return 'what was the actual settlement?';
    if (state.currentTopic === 'fee') return 'how much was the fee overcharge?';
    if (state.currentTopic === 'gst') return 'how much was the GST overcharge?';
    if (state.currentTopic === 'settlement_causality' || state.currentTopic === 'financial_impact') return 'how much is the total shortfall?';
  }

  // "what about it?" / "and that?"
  if (/^(what about (it|that|this)|and (that|this|it))\??$/.test(norm)) {
    const entities = state.referencedEntities;
    const metric   = state.activeFinancialMetric;
    if (entities.includes('gst') || metric === 'gst_variance') return 'what about the GST?';
    if (entities.includes('fee') || metric === 'fee_variance') return 'what about the fee?';
    if (entities.includes('settlement')) return 'what about the settlement?';
    return 'what about this case?';
  }

  return message;
}

module.exports = {
  buildConversationState,
  resolveWithState,
  detectEntities,
  extractAnswerSummary,
  INTENT_TO_TOPIC,
};
