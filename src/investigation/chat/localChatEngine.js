'use strict';
/**
 * src/investigation/chat/localChatEngine.js
 *
 * Payvault Local Chat Engine — answers operator questions about the current
 * investigation case using ONLY deterministic Payvault case data.
 *
 * ARCHITECTURE:
 *   Operator Question
 *       ↓
 *   Intent Classification (keyword routing)
 *       ↓
 *   Answer Template (populated with ChatContext financial facts)
 *       ↓
 *   Formatted Answer String
 *
 * RULES:
 * - NEVER hallucinate financial values.
 * - ALWAYS reference ctx.* for amounts (already computed by deterministic engine).
 * - If a fact is missing, say so explicitly rather than guessing.
 * - Never allow state-changing side effects (read-only).
 */

const { fmtINR } = require('./chatContextBuilder');

// ── Category display labels ───────────────────────────────────────────────────
const CAT_LABELS = {
  CLEAN_MATCH:      'Clean Match',
  FEE_TAX_VARIANCE: 'Fee / Tax Variance',
  TIMING_MISMATCH:  'Timing Mismatch',
  MISSING_ORDER:    'Missing Order',
  MISSING_PAYMENT:  'Missing Payment',
  DUPLICATE:        'Duplicate Settlement',
  ADJUSTMENT:       'Settlement Adjustment',
  UNEXPLAINED:      'Unexplained Shortfall',
  PARTIAL_REFUND:   'Partial Refund',
};

function catLabel(cat) {
  return CAT_LABELS[cat] || (cat || 'Exception').replace(/_/g, ' ');
}

// ── State-change guard ────────────────────────────────────────────────────────
const STATE_CHANGE_KEYWORDS = [
  'resolve', 'close', 'close this', 'mark resolved', 'mark as resolved',
  'reopen', 'delete', 'remove', 'modify', 'change amount', 'update settlement',
  'approve', 'reject payment',
];

function isStateChangeRequest(message) {
  const lower = message.toLowerCase();
  return STATE_CHANGE_KEYWORDS.some(k => lower.includes(k));
}

// ── Intent classifier ─────────────────────────────────────────────────────────
/**
 * Returns the best-matching intent key for the operator's message.
 * Uses simple keyword scoring — sufficient for the structured financial domain.
 */
function classifyIntent(message) {
  const m = message.toLowerCase();

  const intents = [
    { key: 'why_flagged',          score: scoreKeywords(m, ['why', 'flagged', 'flag', 'detected', 'raised', 'exception', 'alert']) },
    { key: 'financial_variance',   score: scoreKeywords(m, ['variance', 'discrepancy', 'difference', 'mismatch', 'amount', 'money', 'financial', 'how much', 'explain', 'fee', 'gst', 'tax']) },
    { key: 'what_happened',        score: scoreKeywords(m, ['what happened', 'what went wrong', 'explain', 'describe', 'transaction', 'happened']) },
    { key: 'what_to_verify',       score: scoreKeywords(m, ['verify', 'check', 'validate', 'confirm', 'before resolving', 'next step', 'should i do', 'action', 'resolve', 'recommendation']) },
    { key: 'historical_cases',     score: scoreKeywords(m, ['similar', 'historical', 'history', 'past', 'precedent', 'pattern', 'previous', 'before']) },
    { key: 'classification',       score: scoreKeywords(m, ['classified', 'category', 'type', 'why is this', 'what type', 'what kind', 'called']) },
    { key: 'simple_explanation',   score: scoreKeywords(m, ['simple', 'explain', 'eli5', 'layman', 'plain english', 'what is', 'summarize', 'summary', 'overview']) },
    { key: 'amount_at_risk',       score: scoreKeywords(m, ['amount at risk', 'risk', 'exposure', 'how much is at risk', 'value', 'paise', 'rupee', 'inr']) },
    { key: 'settlement_details',   score: scoreKeywords(m, ['settlement', 'settled', 'batch', 'utr', 'nodal', 'credit', 'debit', 'payout']) },
    { key: 'payment_details',      score: scoreKeywords(m, ['payment', 'payment id', 'order', 'order id', 'method', 'captured', 'gateway']) },
    { key: 'suggested_actions',    score: scoreKeywords(m, ['suggest', 'recommendation', 'recommended', 'next step', 'what should', 'action', 'to do', 'todo']) },
  ];

  intents.sort((a, b) => b.score - a.score);
  // Minimum threshold — if nothing matches well, fall back to general explanation
  return intents[0].score >= 1 ? intents[0].key : 'general';
}

function scoreKeywords(message, keywords) {
  return keywords.reduce((score, kw) => message.includes(kw) ? score + 1 : score, 0);
}

// ── Answer builders ───────────────────────────────────────────────────────────

function answerWhyFlagged(ctx) {
  const cat  = catLabel(ctx.exception_category);
  const risk = fmtINR(ctx.amount_at_risk_paise);

  const categoryReasons = {
    FEE_TAX_VARIANCE: `The gateway fee or GST charged on this transaction does not match the contracted platform rate (2% fee + 18% GST). The recorded variance is ${fmtINR(ctx.fee_variance_paise || ctx.tax_variance_paise || ctx.amount_at_risk_paise)}.`,
    TIMING_MISMATCH:  `The payment and its associated refund (or credit) were processed in different settlement batch cycles, causing a cross-period reconciliation discrepancy.`,
    MISSING_ORDER:    `A settlement credit was received from the gateway but no corresponding merchant order record exists in the system for this payment.`,
    MISSING_PAYMENT:  `A merchant order exists in the ledger but no matching settlement payout was found from the gateway. The expected credit of ${risk} has not been received.`,
    DUPLICATE:        `Multiple settlement credits with identical amounts were received for the same order reference, indicating a possible duplicate capture or double-settlement.`,
    ADJUSTMENT:       `A settlement adjustment entry exists but cannot be linked to any known payment, refund, or correction record.`,
    UNEXPLAINED:      `A variance of ${risk} was detected between the expected settlement credit and the actual gateway payout, but no specific category rule matched the discrepancy.`,
    PARTIAL_REFUND:   `A partial refund was deducted from the original settlement credit. The net credit does not match the full expected merchant payout.`,
    CLEAN_MATCH:      `This case was not flagged — it is a clean match. All amounts, fees, and taxes align with the merchant ledger exactly.`,
  };

  const reason = categoryReasons[ctx.exception_category]
    || `A ${cat} exception was detected with ${risk} at risk.`;

  const evidence = buildEvidenceList(ctx);

  return formatAnswer({
    finding:    `This case was flagged as a **${cat}**.`,
    detail:     reason,
    evidence,
    source:     ctx.exception_description || null,
    action:     ctx.suggested_actions[0]?.description || null,
    sourceNote: 'Based on Payvault deterministic reconciliation data',
  });
}

function answerFinancialVariance(ctx) {
  const parts = [];

  parts.push(`**Financial Breakdown — ${catLabel(ctx.exception_category)}**\n`);

  if (ctx.gross_amount_paise !== null)        parts.push(`• **Gross customer amount:** ${fmtINR(ctx.gross_amount_paise)}`);
  if (ctx.fee_expected_paise !== null)        parts.push(`• **Expected platform fee (2%):** ${fmtINR(ctx.fee_expected_paise)}`);
  if (ctx.fee_actual_paise !== null)          parts.push(`• **Actual platform fee charged:** ${fmtINR(ctx.fee_actual_paise)}`);
  if (ctx.fee_variance_paise !== null && ctx.fee_variance_paise !== 0)
    parts.push(`• **Fee variance:** ${fmtINR(ctx.fee_variance_paise)} ${ctx.fee_variance_paise > 0 ? '(overcharged)' : '(undercharged)'}`);
  if (ctx.tax_expected_paise !== null)        parts.push(`• **Expected GST (18% of fee):** ${fmtINR(ctx.tax_expected_paise)}`);
  if (ctx.tax_actual_paise !== null)          parts.push(`• **Actual GST charged:** ${fmtINR(ctx.tax_actual_paise)}`);
  if (ctx.tax_variance_paise !== null && ctx.tax_variance_paise !== 0)
    parts.push(`• **GST variance:** ${fmtINR(ctx.tax_variance_paise)}`);
  if (ctx.expected_net_paise !== null)        parts.push(`• **Expected net credit to merchant:** ${fmtINR(ctx.expected_net_paise)}`);
  if (ctx.actual_settlement_paise !== null)   parts.push(`• **Actual settlement credit received:** ${fmtINR(ctx.actual_settlement_paise)}`);
  if (ctx.merchant_variance_paise !== null)   parts.push(`• **Net variance (actual − expected):** ${fmtINR(ctx.merchant_variance_paise)}`);
  if (ctx.amount_at_risk_paise !== null)      parts.push(`• **Amount at risk:** ${fmtINR(ctx.amount_at_risk_paise)}`);

  if (parts.length === 1) {
    parts.push('Financial breakdown data is not available for this case. Run the Payvault Investigation first to extract full financial evidence.');
  }

  const recommendation = ctx.exception_category === 'FEE_TAX_VARIANCE'
    ? 'Verify the contracted gateway fee schedule and request a correction credit if the overcharge is confirmed.'
    : (ctx.suggested_actions[0]?.description || 'Review the settlement statement against the merchant ledger.');

  parts.push(`\n**Recommended next step:** ${recommendation}`);
  parts.push(`\n_Based on Payvault case data (integer-paise calculation)_`);

  return parts.join('\n');
}

function answerWhatHappened(ctx) {
  // If a prior AI investigation exists, use its what_happened field
  if (ctx.ai_investigation?.what_happened) {
    return formatAnswer({
      finding:    `**What happened in this transaction:**`,
      detail:     ctx.ai_investigation.what_happened,
      evidence:   buildEvidenceList(ctx),
      action:     ctx.ai_investigation.recommended_action || ctx.suggested_actions[0]?.description || null,
      sourceNote: 'Based on Payvault investigation findings',
    });
  }

  const cat   = catLabel(ctx.exception_category);
  const risk  = fmtINR(ctx.amount_at_risk_paise);

  const narratives = {
    FEE_TAX_VARIANCE: `A payment of ${fmtINR(ctx.gross_amount_paise)} was captured and settled. During reconciliation, the platform fee charged (${fmtINR(ctx.fee_actual_paise)}) was found to differ from the contracted rate. The expected net credit to the merchant was ${fmtINR(ctx.expected_net_paise)}, but the recorded variance is ${risk}.`,
    TIMING_MISMATCH:  `A payment was captured and its associated refund or credit was processed in a different settlement batch cycle. This creates a cross-period mismatch where one side of the transaction appears in one settlement batch and the other appears in a later cycle.`,
    MISSING_ORDER:    `The gateway settled a payment of ${fmtINR(ctx.gross_amount_paise)} (entity: ${ctx.payment_id || 'unknown'}), but no matching merchant order record was found for this settlement. The credit cannot be attributed to a recognized purchase.`,
    MISSING_PAYMENT:  `A merchant order (${ctx.order_id || 'unknown'}) expected a settlement payout of ${risk}, but no matching gateway settlement record has been received. The payment may not have been captured or the settlement batch is pending.`,
    DUPLICATE:        `The gateway recorded multiple settlement credits for what appears to be the same order reference. This could indicate duplicate payment capture or an erroneous double-settlement.`,
    ADJUSTMENT:       `A settlement adjustment entry of ${risk} was found in the gateway batch, but it cannot be traced to any known payment, refund, or correction record in the merchant system.`,
    CLEAN_MATCH:      `This transaction reconciled cleanly. The gross amount (${fmtINR(ctx.gross_amount_paise)}), platform fee, GST, and merchant net credit all match the expected values exactly.`,
  };

  const narrative = narratives[ctx.exception_category]
    || `A ${cat} discrepancy of ${risk} was detected between the gateway settlement record and the merchant ledger.`;

  return formatAnswer({
    finding:    `**Transaction narrative — ${cat}:**`,
    detail:     narrative,
    evidence:   buildEvidenceList(ctx),
    action:     ctx.suggested_actions[0]?.description || null,
    sourceNote: 'Based on Payvault deterministic reconciliation data',
  });
}

function answerWhatToVerify(ctx) {
  const actions = ctx.suggested_actions.length > 0
    ? ctx.suggested_actions
    : getDefaultActions(ctx.exception_category);

  const actionLines = actions
    .map((a, i) => `${i + 1}. ${a.description || a}`)
    .join('\n');

  const priorityNote = ctx.amount_at_risk_paise && ctx.amount_at_risk_paise > 100000
    ? `\n⚠️ **High-value case:** ${fmtINR(ctx.amount_at_risk_paise)} at risk. Prioritize verification before the next settlement cycle.`
    : '';

  return [
    `**Before resolving case ${ctx.case_id} (${catLabel(ctx.exception_category)}), verify the following:**\n`,
    actionLines,
    priorityNote,
    `\n_Note: Case resolution must be performed using the "Resolve" button in the investigation workstation. The AI chat can explain and recommend, but cannot change case status._`,
    `\n_Based on Payvault deterministic suggested actions_`,
  ].join('\n');
}

function answerHistoricalCases(ctx) {
  const h = ctx.historical;

  if (h.similar_cases_count === 0 && h.repeated_patterns.length === 0) {
    return [
      `**Historical Intelligence — ${catLabel(ctx.exception_category)}**\n`,
      `No similar cases were found in the current session's history. This may be the first case of this type, or historical data may not yet be available.`,
      `\n_Based on Payvault historical pattern analysis_`,
    ].join('\n');
  }

  const parts = [`**Historical Intelligence — ${catLabel(ctx.exception_category)}**\n`];

  if (h.similar_cases_count > 0) {
    parts.push(`**${h.similar_cases_count} similar case(s) found:**`);
    h.similar_cases.forEach(sc => {
      parts.push(`• Case ${sc.case_id} — ${catLabel(sc.category)}${sc.variance ? ` (${fmtINR(sc.variance)})` : ''}`);
    });
    parts.push('');
  }

  if (h.repeated_patterns.length > 0) {
    parts.push(`**Repeated patterns detected:**`);
    h.repeated_patterns.forEach(p => parts.push(`• ${typeof p === 'string' ? p : JSON.stringify(p)}`));
    parts.push('');
  }

  if (h.precedent_summary) {
    parts.push(`**Precedent summary:** ${h.precedent_summary}`);
  }

  if (h.anomalies.length > 0) {
    parts.push(`\n**Anomalies detected:** ${h.anomalies.length} anomalous signal(s) found in the transaction history for this merchant.`);
  }

  parts.push(`\n_Based on Payvault historical pattern analysis_`);
  return parts.join('\n');
}

function answerClassification(ctx) {
  const cat  = catLabel(ctx.exception_category);
  const risk = fmtINR(ctx.amount_at_risk_paise);

  const classificationReasons = {
    FEE_TAX_VARIANCE: `This case is classified as **${cat}** because the platform fee or GST charged on settlement does not match the contracted rate (2% fee + 18% GST on fee). The engine detected a financial variance of ${risk} attributable to the fee/tax line items.`,
    TIMING_MISMATCH:  `This case is classified as **${cat}** because a transaction component (typically a refund or credit) was processed in a different settlement batch cycle than its originating payment. The timing offset creates a cross-period imbalance.`,
    MISSING_ORDER:    `This case is classified as **${cat}** because a gateway settlement credit was received but no merchant order record exists to match it. The reconciliation engine requires a 1:1 mapping between settlements and orders.`,
    MISSING_PAYMENT:  `This case is classified as **${cat}** because a merchant order exists in the ledger but the corresponding gateway settlement has not arrived. The engine flags this as a potential uncaptured or delayed payment.`,
    DUPLICATE:        `This case is classified as **${cat}** because two or more settlement credits with matching amounts exist for the same order reference. The engine detected more settlement credits than expected for a single transaction.`,
    ADJUSTMENT:       `This case is classified as **${cat}** because a settlement adjustment line item exists in the gateway batch that cannot be linked to any payment, refund, or fee correction record in the merchant system.`,
    CLEAN_MATCH:      `This case is classified as **${cat}** — not an exception. All reconciliation signals matched: gross amount, fee, GST, and net credit are all within tolerance.`,
    UNEXPLAINED:      `This case is classified as **${cat}** because a financial variance of ${risk} was detected but no specific reconciliation rule could categorize the discrepancy.`,
    PARTIAL_REFUND:   `This case is classified as **${cat}** because a refund was deducted from the settlement credit at an amount less than the original transaction value.`,
  };

  const reason = classificationReasons[ctx.exception_category]
    || `This case is classified as **${cat}** based on the reconciliation engine's rule evaluation. Amount at risk: ${risk}.`;

  return [
    reason,
    `\n**Reconciliation status:** ${ctx.reconciliation_status}`,
    ctx.exception_description ? `\n**Engine finding:** ${ctx.exception_description}` : '',
    `\n_Based on Payvault deterministic classification rules_`,
  ].filter(Boolean).join('\n');
}

function answerSimpleExplanation(ctx) {
  const cat  = catLabel(ctx.exception_category);
  const risk = fmtINR(ctx.amount_at_risk_paise);

  const simpleMap = {
    FEE_TAX_VARIANCE: `Payvault expected the payment gateway to charge a specific fee (2% of the transaction + 18% tax). The gateway charged a different amount. The difference — ${risk} — is the discrepancy that needs to be verified.`,
    TIMING_MISMATCH:  `Think of this like a refund and the original payment appearing on different bank statements from different months. The money is accounted for, but it doesn't line up in the same settlement cycle, so the books show a mismatch temporarily.`,
    MISSING_ORDER:    `The bank received a payment, but there's no corresponding purchase order in the merchant's system. It's like receiving money into your account without knowing which customer invoice it belongs to.`,
    MISSING_PAYMENT:  `The merchant system recorded a sale, but the bank hasn't sent the money yet. The payment may be delayed, pending, or uncaptured.`,
    DUPLICATE:        `The payment gateway appears to have credited the merchant twice for the same transaction. One of the credits may need to be reversed.`,
    ADJUSTMENT:       `A correction entry appeared in the bank settlement, but it's unclear what it's correcting. The adjustment can't be matched to any known transaction.`,
    CLEAN_MATCH:      `Everything checks out. The amount paid, the fees charged, and the money received by the merchant all match exactly. No action needed.`,
    PARTIAL_REFUND:   `A refund was given to a customer, but only for part of the original payment amount. The settlement shows the partial deduction.`,
    UNEXPLAINED:      `There's a ${risk} gap between what was expected and what was received. The system couldn't find a specific reason, so it needs manual review.`,
  };

  const simple = simpleMap[ctx.exception_category]
    || `Case ${ctx.case_id} has a ${cat} exception with ${risk} at risk. A discrepancy was found between the gateway settlement and the merchant ledger.`;

  return [
    `**${cat} — Simple Explanation:**\n`,
    simple,
    `\n**Case ID:** ${ctx.case_id}`,
    `**Amount at risk:** ${risk}`,
    `**Status:** ${ctx.status}`,
    `\n_Based on Payvault case data_`,
  ].join('\n');
}

function answerAmountAtRisk(ctx) {
  const risk = fmtINR(ctx.amount_at_risk_paise);

  if (ctx.amount_at_risk_paise === null) {
    return `The amount at risk for case ${ctx.case_id} is not available in the current case data. Run the Payvault investigation to extract the full financial breakdown.`;
  }

  const context = {
    FEE_TAX_VARIANCE: `This represents the total fee and/or GST variance — the difference between what was expected to be charged and what was actually deducted from the settlement.`,
    MISSING_PAYMENT:  `This is the full expected merchant payout that has not been received from the gateway.`,
    MISSING_ORDER:    `This is the amount of the unlinked settlement credit that cannot be attributed to a merchant order.`,
    DUPLICATE:        `This represents the amount of the potentially duplicate settlement credit that may need to be reversed.`,
  }[ctx.exception_category] || `This is the total financial exposure identified by the reconciliation engine for this exception.`;

  return [
    `**Amount at risk for case ${ctx.case_id}:** ${risk}\n`,
    context,
    ctx.merchant_variance_paise !== null
      ? `\n**Recorded variance (actual − expected):** ${fmtINR(ctx.merchant_variance_paise)}`
      : '',
    `\n_All amounts from Payvault integer-paise calculation engine_`,
  ].filter(Boolean).join('\n');
}

function answerSettlementDetails(ctx) {
  const parts = [`**Settlement Details — Case ${ctx.case_id}:**\n`];

  if (ctx.settlement_id)       parts.push(`• **Settlement batch:** ${ctx.settlement_id}`);
  if (ctx.settlement_utr)      parts.push(`• **UTR reference:** ${ctx.settlement_utr}`);
  if (ctx.actual_settlement_paise !== null) parts.push(`• **Credit received:** ${fmtINR(ctx.actual_settlement_paise)}`);
  if (ctx.expected_net_paise !== null)      parts.push(`• **Expected credit:** ${fmtINR(ctx.expected_net_paise)}`);
  if (ctx.merchant_variance_paise !== null) parts.push(`• **Variance:** ${fmtINR(ctx.merchant_variance_paise)}`);
  if (ctx.fee_actual_paise !== null)        parts.push(`• **Fee deducted:** ${fmtINR(ctx.fee_actual_paise)}`);
  if (ctx.tax_actual_paise !== null)        parts.push(`• **GST deducted:** ${fmtINR(ctx.tax_actual_paise)}`);

  if (parts.length === 1) {
    parts.push('Settlement record details are not available for this case. The settlement may be pending or not yet linked.');
  }

  parts.push(`\n_Based on Payvault settlement records_`);
  return parts.join('\n');
}

function answerPaymentDetails(ctx) {
  const parts = [`**Payment Details — Case ${ctx.case_id}:**\n`];

  if (ctx.payment_id)          parts.push(`• **Payment ID:** ${ctx.payment_id}`);
  if (ctx.order_id)            parts.push(`• **Merchant order:** ${ctx.order_id}`);
  if (ctx.payment_method)      parts.push(`• **Payment method:** ${ctx.payment_method.toUpperCase()}`);
  if (ctx.gross_amount_paise !== null) parts.push(`• **Gross amount:** ${fmtINR(ctx.gross_amount_paise)}`);
  if (ctx.settlement_id)       parts.push(`• **Settlement batch:** ${ctx.settlement_id}`);
  parts.push(`• **Exception category:** ${catLabel(ctx.exception_category)}`);
  parts.push(`• **Case status:** ${ctx.status}`);
  parts.push(`• **Reconciliation:** ${ctx.reconciliation_status}`);

  parts.push(`\n_Based on Payvault payment and settlement records_`);
  return parts.join('\n');
}

function answerSuggestedActions(ctx) {
  const actions = ctx.suggested_actions.length > 0
    ? ctx.suggested_actions
    : getDefaultActions(ctx.exception_category);

  if (actions.length === 0) {
    return `No specific actions have been determined for this case yet. Run the Payvault investigation to generate recommended actions based on the full evidence analysis.`;
  }

  const lines = actions.map((a, i) => `${i + 1}. **[${a.priority || 'MEDIUM'}]** ${a.description || a}`);

  return [
    `**Recommended Actions — Case ${ctx.case_id}:**\n`,
    lines.join('\n'),
    `\n_These actions are deterministically generated by the Payvault rules engine._`,
    `_State changes (resolve, reopen) must be performed via the investigation workstation controls._`,
  ].join('\n');
}

function answerGeneral(ctx) {
  if (ctx.ai_investigation?.summary) {
    return formatAnswer({
      finding:    `**Investigation Summary — ${catLabel(ctx.exception_category)}:**`,
      detail:     ctx.ai_investigation.summary,
      evidence:   buildEvidenceList(ctx),
      action:     ctx.ai_investigation.recommended_action || ctx.suggested_actions[0]?.description || null,
      sourceNote: 'Based on Payvault investigation findings',
    });
  }

  return formatAnswer({
    finding:    `**Case ${ctx.case_id} — ${catLabel(ctx.exception_category)}:**`,
    detail:     ctx.exception_description || `A ${catLabel(ctx.exception_category)} exception was detected with ${fmtINR(ctx.amount_at_risk_paise)} at risk. Run the Payvault investigation to generate a full analysis.`,
    evidence:   buildEvidenceList(ctx),
    action:     ctx.suggested_actions[0]?.description || null,
    sourceNote: 'Based on Payvault case data',
  });
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function buildEvidenceList(ctx) {
  const facts = [];
  if (ctx.payment_id)                         facts.push(`Payment: ${ctx.payment_id}`);
  if (ctx.gross_amount_paise !== null)         facts.push(`Gross amount: ${fmtINR(ctx.gross_amount_paise)}`);
  if (ctx.expected_net_paise !== null)         facts.push(`Expected net: ${fmtINR(ctx.expected_net_paise)}`);
  if (ctx.actual_settlement_paise !== null)    facts.push(`Settlement credited: ${fmtINR(ctx.actual_settlement_paise)}`);
  if (ctx.amount_at_risk_paise !== null)       facts.push(`Variance: ${fmtINR(ctx.amount_at_risk_paise)}`);
  if (ctx.settlement_id)                      facts.push(`Settlement batch: ${ctx.settlement_id}`);
  return facts;
}

function formatAnswer({ finding, detail, evidence = [], source = null, action = null, sourceNote = null }) {
  const parts = [];
  if (finding) parts.push(finding + '\n');
  if (detail)  parts.push(detail);

  if (evidence.length > 0) {
    parts.push('\n**Evidence:**');
    evidence.forEach(e => parts.push(`• ${e}`));
  }

  if (source) {
    parts.push(`\n**Engine finding:** ${source}`);
  }

  if (action) {
    parts.push(`\n**Recommended next step:** ${action}`);
  }

  if (sourceNote) {
    parts.push(`\n_${sourceNote}_`);
  }

  return parts.join('\n');
}

function getDefaultActions(category) {
  const defaults = {
    FEE_TAX_VARIANCE: [
      { priority: 'HIGH',   description: 'Verify the contracted gateway fee schedule (2% + 18% GST) against the actual settlement deduction.' },
      { priority: 'MEDIUM', description: 'Request a fee correction credit from Razorpay if the variance confirms an overcharge.' },
    ],
    TIMING_MISMATCH: [
      { priority: 'MEDIUM', description: 'Confirm the refund settlement batch UTR in the next payout cycle.' },
      { priority: 'LOW',    description: 'No customer-facing refund action needed — this is a batch timing issue.' },
    ],
    MISSING_ORDER: [
      { priority: 'HIGH',   description: 'Search the merchant order database for the payment reference ID and link the settlement.' },
    ],
    MISSING_PAYMENT: [
      { priority: 'HIGH',   description: 'Verify payment capture status in the Razorpay dashboard.' },
      { priority: 'MEDIUM', description: 'Contact gateway support if capture was confirmed but settlement is overdue.' },
    ],
    DUPLICATE: [
      { priority: 'HIGH',   description: 'Review gateway dashboard timestamps to verify duplicate captures.' },
      { priority: 'HIGH',   description: 'Prepare for automated reversal of the duplicate credit.' },
    ],
    ADJUSTMENT: [
      { priority: 'MEDIUM', description: 'Check the settlement statement for the specific adjustment reason code.' },
    ],
  };
  return defaults[category] || [
    { priority: 'MEDIUM', description: 'Review raw settlement line item against the bank statement.' },
  ];
}

// ── Guard response for state-change requests ──────────────────────────────────
function stateChangeGuardResponse() {
  return [
    `I can explain the case and recommend the resolution, but case status changes must be performed using the investigation workstation controls.\n`,
    `To resolve a case: use the **"Resolve"** button in the investigation header.`,
    `To reopen a resolved case: use the **"Reopen"** button.`,
    `\nThe AI chat is a read-only explanation layer. All state-changing operations remain with the human operator.`,
  ].join('\n');
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Generate a local, deterministic answer for an operator's chat question.
 * Uses only facts from the ChatContext — no LLM, no hallucination.
 *
 * @param {string}      message  – operator's question
 * @param {ChatContext} ctx      – built by chatContextBuilder.buildChatContext()
 * @returns {{ answer: string, intent: string }}
 */
function generateLocalAnswer(message, ctx) {
  if (isStateChangeRequest(message)) {
    return { answer: stateChangeGuardResponse(), intent: 'state_change_guard' };
  }

  const intent = classifyIntent(message);

  const answerMap = {
    why_flagged:        () => answerWhyFlagged(ctx),
    financial_variance: () => answerFinancialVariance(ctx),
    what_happened:      () => answerWhatHappened(ctx),
    what_to_verify:     () => answerWhatToVerify(ctx),
    historical_cases:   () => answerHistoricalCases(ctx),
    classification:     () => answerClassification(ctx),
    simple_explanation: () => answerSimpleExplanation(ctx),
    amount_at_risk:     () => answerAmountAtRisk(ctx),
    settlement_details: () => answerSettlementDetails(ctx),
    payment_details:    () => answerPaymentDetails(ctx),
    suggested_actions:  () => answerSuggestedActions(ctx),
    general:            () => answerGeneral(ctx),
  };

  const handler = answerMap[intent] || answerMap.general;
  const answer  = handler();

  return { answer, intent };
}

module.exports = { generateLocalAnswer, classifyIntent, fmtINR };
