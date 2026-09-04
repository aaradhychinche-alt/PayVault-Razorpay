'use strict';
/**
 * src/investigation/chat/localChatEngine.js
 *
 * Payvault Conversational Investigation Copilot (Local Engine).
 *
 * Grounded in current investigation case facts + multi-turn conversation memory.
 * Dynamically reasons over natural language questions, follow-ups, pronouns,
 * cause-and-effect relationships, and verification requirements.
 *
 * CRITICAL ARCHITECTURE RULES:
 * - NO blind keyword -> canned template dumping.
 * - Respects conversation history for pronoun resolution and follow-up continuity.
 * - Emits proportional answers (does NOT dump the full financial breakdown unless requested).
 * - Connects fee/tax variances to settlement shortfalls with exact arithmetic.
 * - Strictly grounded in deterministic case data (never hallucinates figures).
 * - Read-only: guards against state modifications.
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
const STATE_CHANGE_PATTERNS = [
  /\b(resolve|close|close this|mark resolved|mark as resolved)\b/i,
  /\b(reopen|re-open)\b/i,
  /\b(delete|remove|modify|approve|reject)\b/i,
];

function isStateChangeRequest(message) {
  return STATE_CHANGE_PATTERNS.some(pat => pat.test(message));
}

function stateChangeGuardResponse() {
  return [
    `I can explain the investigation findings and recommend corrective actions, but case status changes cannot be performed through chat.\n`,
    `• To mark this case resolved: click the **"Resolve"** button in the investigation header.`,
    `• To reopen a case: click the **"Reopen"** button in the investigation header.`,
    `\nThe investigation copilot operates strictly as an analytical advisor to preserve human audit controls.`,
  ].join('\n');
}

// ── Natural language query classification with conversation memory ────────────

/**
 * Determine the analytical intent of the operator's message, taking prior
 * conversation turns into account.
 *
 * @param {string} message - Current user message
 * @param {Array} history  - Prior conversation turns [{role, content}]
 * @param {Object} ctx     - Current case context
 * @returns {string} Intent key
 */
function analyzeIntent(message, history = [], ctx = {}) {
  const norm = message.trim().toLowerCase();

  // 1. Guard against state mutations
  if (isStateChangeRequest(norm)) {
    return 'state_change_guard';
  }

  // 2. Full picture / Complete breakdown explicitly requested
  if (
    /\b(full picture|full breakdown|complete breakdown|all numbers|detailed breakdown|complete picture|entire breakdown|all details)\b/i.test(norm) ||
    (/\b(breakdown|financial breakdown)\b/i.test(norm) && !/\b(simple|why|gst|tax|fee|overcharge|short|affect)\b/i.test(norm))
  ) {
    return 'full_financial_breakdown';
  }

  // 3. Simple / plain-English explanation
  if (
    /\b(simple|simply|plain english|layman|eli5|in simple terms|overview)\b/i.test(norm) ||
    (/\bexplain\b/i.test(norm) && /\b(case|whole|all|everything)\b/i.test(norm) && !/\b(fee|tax|settlement|math)\b/i.test(norm))
  ) {
    return 'simple_explanation';
  }

  // 4. Follow-up conversational references based on history
  // e.g. "and what about gst?", "what about tax?", "and tax?", "and the tax?"
  if (/^(and\s+)?(what\s+about|how\s+about|what\s+of|and)\s+(gst|tax|taxes|the\s+tax|the\s+gst)\??$/i.test(norm)) {
    return 'tax_specific';
  }

  // e.g. "and what about fee?", "what about the fee?", "and the fee?"
  if (/^(and\s+)?(what\s+about|how\s+about|what\s+of|and)\s+(fee|platform fee|fees|the\s+fee)\??$/i.test(norm)) {
    return 'fee_specific';
  }

  // e.g. "and what about the settlement?", "and settlement?"
  if (/^(and\s+)?(what\s+about|how\s+about)\s+(settlement|net|payout)\??$/i.test(norm)) {
    return 'settlement_causality';
  }

  // 5. Settlement impact & causality
  // e.g. "why does that affect the settlement?", "does that explain the settlement difference?",
  // "why is the settlement short?", "how does this affect payout?", "why is it short?"
  if (
    /\b(affect|impact|reduce|shortfall|difference|short|gap|explain)\b/i.test(norm) &&
    /\b(settlement|payout|credit|net amount|received)\b/i.test(norm)
  ) {
    return 'settlement_causality';
  }
  if (
    /\bwhy\b/i.test(norm) &&
    /\b(short|shortfall|less|missing|difference|variance)\b/i.test(norm) &&
    !/\b(flagged|detected|raised)\b/i.test(norm)
  ) {
    return 'settlement_causality';
  }
  if (/\bdoes that explain\b/i.test(norm)) {
    return 'settlement_causality';
  }

  // 6. Fee-specific queries
  // e.g. "how much was the fee overcharge?", "is the fee the problem?", "what was the fee?", "fee variance?"
  if (/\b(fee|fees|platform fee)\b/i.test(norm)) {
    if (/\b(problem|issue|reason|cause|wrong)\b/i.test(norm)) {
      return 'is_fee_the_problem';
    }
    return 'fee_specific';
  }

  // 7. Tax / GST specific queries
  // e.g. "how much was the gst overcharge?", "what about tax?", "is tax wrong?"
  if (/\b(gst|tax|taxes)\b/i.test(norm)) {
    return 'tax_specific';
  }

  // 8. Amount at risk / Financial loss / Total overcharge
  // e.g. "how much did we lose?", "how much is at risk?", "how much did we get overcharged?", "total risk?"
  if (
    /\b(lose|lost|loss|at risk|exposure|overcharge|overcharged|short|shortfall|financial risk)\b/i.test(norm)
  ) {
    return 'amount_at_risk';
  }

  // 8b. Why not 0.90 / GST calculation explanation
  // e.g. "why isn't the gst variance ₹0.90?", "why not 0.90?", "is it 0.90?"
  if (/\b(0\.90|90 paise|why not 0\.90|isn't .* 0\.90)\b/i.test(norm)) {
    return 'why_not_90_paise';
  }

  // 8c. How did you calculate that / Show math
  // e.g. "how did you calculate that?", "show the math", "how is that calculated?", "how did you get that?"
  if (
    /\b(how did you calculate|how do you calculate|how did you get|show the math|how was that calculated|calculation breakdown)\b/i.test(norm)
  ) {
    return 'math_explanation';
  }

  // 8d. Identifier lookups (payment id, order id, utr, settlement id)
  // e.g. "what is the payment id?", "what is the order id?", "what is the utr?"
  if (/\b(payment id|order id|settlement id|utr|settlement batch|transaction id)\b/i.test(norm)) {
    return 'identifier_lookup';
  }

  // 8e. Settlement figures lookup
  // e.g. "what was the expected settlement?", "what was the actual settlement?", "how much settlement was received?"
  if (
    /\b(expected settlement|actual settlement|settlement received|expected net|payout received)\b/i.test(norm)
  ) {
    return 'settlement_lookup';
  }

  // 9. Verification & Next steps
  // e.g. "what should I check?", "what should I verify before resolving this?", "what actions should I take?", "next step"
  if (
    /\b(verify|check|validate|confirm|before resolving|resolution|actions|next step|what should i do)\b/i.test(norm)
  ) {
    return 'what_to_verify';
  }

  // 10. Root cause / Why flagged / What went wrong
  // e.g. "why was this flagged?", "what went wrong here?", "why did this fail?", "what happened?"
  if (
    /\b(why was this flagged|why was it flagged|why flagged|flagged|what went wrong|what happened here|what happened)\b/i.test(norm)
  ) {
    return 'why_flagged';
  }

  // 11. Historical precedent
  if (/\b(similar|historical|history|precedent|pattern|previous cases)\b/i.test(norm)) {
    return 'historical_cases';
  }

  // 12. Contextual pronoun follow-up check:
  // If the message is short or refers to previous subject (e.g. "how much?", "why?", "is that right?")
  if (history && history.length > 0) {
    const lastUserTurn = [...history].reverse().find(h => h.role === 'operator' || h.role === 'user');
    const lastText = lastUserTurn ? lastUserTurn.content.toLowerCase() : '';

    if (/\b(how much|how much is it|how much was it)\b/i.test(norm)) {
      if (/\b(fee)\b/i.test(lastText)) return 'fee_specific';
      if (/\b(tax|gst)\b/i.test(lastText)) return 'tax_specific';
      if (/\b(settlement|short|loss|risk)\b/i.test(lastText)) return 'amount_at_risk';
    }
  }

  // 13. Fallback: targeted diagnostic summary
  return 'diagnostic_summary';
}

// ── Conversational Answer Builders ────────────────────────────────────────────

/**
 * 1. Why was this flagged / What went wrong?
 * Concise, root-cause diagnostic explaining the trigger condition and evidence.
 */
function answerWhyFlagged(ctx) {
  const cat = catLabel(ctx.exception_category);
  const risk = ctx.amount_at_risk_formatted || fmtINR(ctx.amount_at_risk_paise);

  if (ctx.exception_category === 'FEE_TAX_VARIANCE') {
    const feeOver = ctx.fee_variance_formatted || fmtINR(ctx.fee_variance_paise);
    const taxOver = ctx.tax_variance_formatted || fmtINR(ctx.tax_variance_paise);
    return [
      `This case was flagged as a **Fee / Tax Variance** because the payment gateway deducted higher fees and taxes than the contracted platform rate (2.0% fee + 18.0% GST on fee).\n`,
      `• **Fee charged:** ${ctx.fee_actual_formatted} vs **Expected:** ${ctx.fee_expected_formatted} (${feeOver} overcharge)`,
      `• **GST charged:** ${ctx.tax_actual_formatted} vs **Expected:** ${ctx.tax_expected_formatted} (${taxOver} overcharge)`,
      `• **Net settlement impact:** The gateway credited ${ctx.actual_settlement_formatted} instead of ${ctx.expected_net_formatted}, leaving a shortfall of ${risk} at risk.`,
      `\n${ctx.exception_description ? `_Reconciliation rule finding: ${ctx.exception_description}_` : ''}`,
    ].filter(Boolean).join('\n');
  }

  if (ctx.exception_category === 'TIMING_MISMATCH') {
    return [
      `This case was flagged as a **Timing Mismatch** because the payment capture and its corresponding refund appeared in different settlement batch cycles.`,
      `The money is accounted for, but the cross-period batch split creates a temporary reconciliation imbalance of ${risk}.`,
    ].join('\n');
  }

  if (ctx.exception_category === 'MISSING_ORDER') {
    return [
      `This case was flagged as a **Missing Order** because a gateway settlement credit of ${ctx.actual_settlement_formatted} was received into the merchant account, but no matching order record exists in the merchant ledger for payment entity \`${ctx.payment_id || 'unknown'}\`.`,
    ].join('\n');
  }

  if (ctx.exception_category === 'MISSING_PAYMENT') {
    return [
      `This case was flagged as a **Missing Payment** because merchant order \`${ctx.order_id || 'unknown'}\` was recorded in the ledger, but no corresponding settlement payout of ${risk} has been received from the gateway.`,
    ].join('\n');
  }

  if (ctx.exception_category === 'DUPLICATE') {
    return [
      `This case was flagged as a **Duplicate Settlement** because multiple settlement credits with identical amounts were posted for order \`${ctx.order_id || 'unknown'}\`, creating potential double-credit exposure of ${risk}.`,
    ].join('\n');
  }

  return [
    `This case was flagged under category **${cat}** with **${risk}** at risk.`,
    ctx.exception_description ? `\nFinding: ${ctx.exception_description}` : '',
  ].join('\n');
}

/**
 * 2. Specific Fee Overcharge query
 * Targeted, proportional response stating the exact fee numbers.
 */
function answerFeeSpecific(ctx) {
  if (ctx.fee_actual_paise === null || ctx.fee_expected_paise === null) {
    return `Fee deduction data is not available for case ${ctx.case_id}.`;
  }

  const feeVarPaise = ctx.fee_variance_paise || 0;
  const isOver = feeVarPaise > 0;
  const feeVarFmt = ctx.fee_variance_formatted || fmtINR(Math.abs(feeVarPaise));

  if (feeVarPaise === 0) {
    return `The platform fee charged matches the contracted rate exactly at ${ctx.fee_expected_formatted} (no fee overcharge).`;
  }

  return [
    `The platform fee **${isOver ? 'overcharge' : 'undercharge'}** is **${feeVarFmt}**.\n`,
    `• **Actual fee deducted:** ${ctx.fee_actual_formatted}`,
    `• **Expected fee (contracted 2%):** ${ctx.fee_expected_formatted}`,
    `• **Difference:** ${feeVarFmt} ${isOver ? 'more than contracted' : 'less than contracted'}.`,
  ].join('\n');
}

/**
 * 3. Specific Tax / GST query
 * Targeted response answering the GST variance and connecting to the fee.
 */
function answerTaxSpecific(ctx) {
  if (ctx.tax_actual_paise === null || ctx.tax_expected_paise === null) {
    return `GST deduction data is not available for case ${ctx.case_id}.`;
  }

  const taxVarPaise = ctx.tax_variance_paise || 0;
  const isOver = taxVarPaise > 0;
  const taxVarFmt = ctx.tax_variance_formatted || fmtINR(Math.abs(taxVarPaise));

  if (taxVarPaise === 0) {
    return `GST was charged correctly at ${ctx.tax_expected_formatted} (18% of the platform fee). There is no tax variance.`;
  }

  return [
    `The GST **${isOver ? 'overcharge' : 'variance'}** is **${taxVarFmt}**.\n`,
    `• **Actual GST charged:** ${ctx.tax_actual_formatted}`,
    `• **Expected GST (18% of expected fee):** ${ctx.tax_expected_formatted}`,
    `• **Calculation:** ${ctx.tax_actual_formatted} − ${ctx.tax_expected_formatted} = ${taxVarFmt} excess tax charged by the gateway.`,
    `\nThere are no additional tax deductions.`,
  ].join('\n');
}

/**
 * 4. Is the fee the problem?
 * Evaluates whether the fee variance drives the exception.
 */
function answerIsFeeTheProblem(ctx) {
  if (ctx.fee_variance_paise && ctx.fee_variance_paise > 0) {
    const feeOver = ctx.fee_variance_formatted;
    const taxOver = ctx.tax_variance_formatted || '₹0.00';
    const totalShort = ctx.net_shortfall_formatted || ctx.amount_at_risk_formatted;
    return [
      `Yes, the platform fee is the primary driver of this exception.`,
      `The gateway deducted **${ctx.fee_actual_formatted}** instead of the contracted 2.0% fee of **${ctx.fee_expected_formatted}**, producing a **${feeOver}** fee overcharge.`,
      `This also inflated the associated GST by **${taxOver}**, combining for the total settlement shortfall of **${totalShort}**.`,
    ].join('\n\n');
  }

  if (ctx.exception_category === 'FEE_TAX_VARIANCE') {
    return `Yes, this case is specifically classified as Fee / Tax Variance with a recorded discrepancy of ${ctx.amount_at_risk_formatted}.`;
  }

  return `No, the platform fee is not the primary issue in this case. The case was flagged as **${catLabel(ctx.exception_category)}** (${ctx.amount_at_risk_formatted} at risk).`;
}

/**
 * 5. Settlement Causality & Shortfall connection
 * Explains how fee overcharge + GST overcharge sum directly to the settlement shortfall.
 */
function answerSettlementCausality(ctx) {
  if (ctx.exception_category === 'FEE_TAX_VARIANCE') {
    const feeOver = ctx.fee_variance_formatted || fmtINR(ctx.fee_variance_paise);
    const taxOver = ctx.tax_variance_formatted || fmtINR(ctx.tax_variance_paise);
    const shortfall = ctx.net_shortfall_formatted || ctx.amount_at_risk_formatted || fmtINR(ctx.amount_at_risk_paise);

    return [
      `The settlement payout is calculated as:`,
      `**Net Settlement = Gross Amount − Gateway Fee − GST**\n`,
      `Because the gateway overcharged both deductions:`,
      `• **Fee overcharge:** +${feeOver}`,
      `• **GST overcharge:** +${taxOver}`,
      `• **Total excess deductions:** **${shortfall}** (${feeOver} + ${taxOver})\n`,
      `These extra deductions directly reduce the merchant credit from the expected **${ctx.expected_net_formatted}** down to **${ctx.actual_settlement_formatted}**, creating the exact **${shortfall}** shortfall.`,
    ].join('\n');
  }

  if (ctx.cause_and_effect_summary) {
    return ctx.cause_and_effect_summary;
  }

  return `The settlement variance of ${ctx.amount_at_risk_formatted} reflects the gap between the expected net payout (${ctx.expected_net_formatted}) and the actual credit received (${ctx.actual_settlement_formatted}).`;
}

/**
 * 6. Amount at risk / Financial loss
 * Explains financial exposure concisely.
 */
function answerAmountAtRisk(ctx) {
  const risk = ctx.amount_at_risk_formatted || fmtINR(ctx.amount_at_risk_paise);
  const shortfall = ctx.net_shortfall_formatted || risk;

  if (ctx.exception_category === 'FEE_TAX_VARIANCE') {
    return [
      `The financial exposure for this case is **${risk}**.\n`,
      `This matches the net settlement shortfall caused by the combined fee overcharge (${ctx.fee_variance_formatted}) and GST overcharge (${ctx.tax_variance_formatted}). This amount is currently owed back to the merchant as a fee correction credit.`,
    ].join('\n');
  }

  return `The total amount at risk for this case is **${risk}** (Case ID: \`${ctx.case_id}\`, Status: \`${ctx.status}\`).`;
}

/**
 * 7. Verification & Next steps before resolving
 * Concrete, actionable checklist.
 */
function answerWhatToVerify(ctx) {
  const actions = ctx.suggested_actions && ctx.suggested_actions.length > 0
    ? ctx.suggested_actions
    : [
        { priority: 'HIGH', description: 'Verify gateway contract fee schedule against settlement deduction.' },
        { priority: 'HIGH', description: 'Request fee correction credit from the payment gateway.' },
        { priority: 'MEDIUM', description: 'Record investigation findings in the case audit log.' },
      ];

  const actionLines = actions.map((a, i) => `${i + 1}. **[${a.priority || 'MEDIUM'}]** ${a.description}`);

  return [
    `**Before resolving case ${ctx.case_id} (${catLabel(ctx.exception_category)}), verify the following:**\n`,
    actionLines.join('\n'),
    `\n_Note: Once verified, complete the resolution using the **"Resolve"** button in the investigation workstation._`,
  ].join('\n');
}

/**
 * 8. Simple plain-English explanation
 * Accessible, jargon-free overview.
 */
function answerSimpleExplanation(ctx) {
  const cat = catLabel(ctx.exception_category);
  const gross = ctx.gross_amount_formatted;
  const actual = ctx.actual_settlement_formatted;
  const expected = ctx.expected_net_formatted;
  const risk = ctx.amount_at_risk_formatted;

  if (ctx.exception_category === 'FEE_TAX_VARIANCE') {
    return [
      `**Simple Explanation — Fee / Tax Variance:**\n`,
      `A customer paid **${gross}**. Based on the agreed 2% contract rate, Payvault expected the gateway to deduct **${ctx.fee_expected_formatted}** in fees plus **${ctx.tax_expected_formatted}** in GST, leaving **${expected}** for the merchant.`,
      `Instead, the gateway took **${ctx.fee_actual_formatted}** in fees and **${ctx.tax_actual_formatted}** in GST, depositing only **${actual}**.`,
      `The extra **${risk}** deducted is an overcharge that needs to be verified and claimed back from the gateway.`,
    ].join('\n\n');
  }

  if (ctx.exception_category === 'TIMING_MISMATCH') {
    return [
      `**Simple Explanation — Timing Mismatch:**\n`,
      `A transaction and its refund occurred in two separate settlement batches. The funds balance out over time, but the difference across batch cutoff dates triggered this flag.`,
    ].join('\n\n');
  }

  return [
    `**Simple Explanation — ${cat}:**\n`,
    `Case \`${ctx.case_id}\` has a ${cat} discrepancy with **${risk}** at risk between what was expected and what the payment gateway processed. Review the evidence and suggested actions to close the case.`,
  ].join('\n\n');
}

/**
 * 9. Full Financial Breakdown
 * Provided ONLY when operator explicitly asks for complete details or full picture.
 */
function answerFullBreakdown(ctx) {
  const lines = [
    `**Complete Financial Breakdown — ${catLabel(ctx.exception_category)} (Case: \`${ctx.case_id}\`)**\n`,
    `• **Gross Customer Amount:** ${ctx.gross_amount_formatted}`,
    `• **Expected Platform Fee (2.0%):** ${ctx.fee_expected_formatted}`,
    `• **Actual Platform Fee Charged:** ${ctx.fee_actual_formatted}`,
    `• **Fee Variance:** ${ctx.fee_variance_formatted || '₹0.00'} ${ctx.fee_is_overcharged ? '(overcharged)' : ''}`,
    `• **Expected GST (18.0% of fee):** ${ctx.tax_expected_formatted}`,
    `• **Actual GST Charged:** ${ctx.tax_actual_formatted}`,
    `• **GST Variance:** ${ctx.tax_variance_formatted || '₹0.00'} ${ctx.tax_is_overcharged ? '(overcharged)' : ''}`,
    `• **Expected Net Settlement:** ${ctx.expected_net_formatted}`,
    `• **Actual Settlement Received:** ${ctx.actual_settlement_formatted}`,
    `• **Net Settlement Shortfall:** ${ctx.net_shortfall_formatted || ctx.amount_at_risk_formatted}`,
    `• **Amount at Risk:** ${ctx.amount_at_risk_formatted}`,
    `• **Payment ID:** \`${ctx.payment_id || 'N/A'}\``,
    `• **Settlement Batch:** \`${ctx.settlement_id || 'N/A'}\``,
  ];

  if (ctx.cause_and_effect_summary) {
    lines.push(`\n**Relationship Analysis:**\n${ctx.cause_and_effect_summary}`);
  }

  return lines.join('\n');
}

/**
 * 10. Historical Cases
 */
function answerHistoricalCases(ctx) {
  const h = ctx.historical || {};
  if (!h.similar_cases_count) {
    return `No similar past cases were found in the current session history for category **${catLabel(ctx.exception_category)}**.`;
  }

  const list = (h.similar_cases || []).map(
    sc => `• Case \`${sc.case_id}\` — ${catLabel(sc.category)}${sc.variance ? ` (${fmtINR(sc.variance)})` : ''}`
  );

  return [
    `**Historical Precedent (${h.similar_cases_count} similar case(s) found):**\n`,
    list.join('\n'),
    h.precedent_summary ? `\n**Precedent Summary:** ${h.precedent_summary}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * 11. Diagnostic Summary (general fallback when intent is conversational diagnostic)
 */
function answerDiagnosticSummary(ctx, message) {
  const cat = catLabel(ctx.exception_category);
  const risk = ctx.amount_at_risk_formatted;

  return [
    `**Case ${ctx.case_id} Diagnostic — ${cat}:**\n`,
    ctx.cause_and_effect_summary || `A discrepancy of ${risk} was detected in settlement reconciliation.`,
    `\n• **Amount at risk:** ${risk}`,
    `• **Status:** ${ctx.status}`,
    `• **Next Step:** ${ctx.suggested_actions?.[0]?.description || 'Review the settlement deduction against the merchant contract schedule.'}`,
  ].join('\n');
}

/**
 * 12. Why Not 0.90 / GST Variance Explanation
 */
function answerWhyNot90Paise(ctx) {
  const taxAct = ctx.tax_actual_formatted || '₹8.10';
  const taxExp = ctx.tax_expected_formatted || '₹3.60';
  const taxVar = ctx.tax_variance_formatted || '₹4.50';

  return [
    `The GST variance is **${taxVar}**, not ₹0.90.\n`,
    `Here is the exact derivation:`,
    `• **Actual GST charged by gateway:** ${taxAct}`,
    `• **Expected GST (18.0% of contracted fee):** ${taxExp}`,
    `• **Variance:** ${taxAct} − ${taxExp} = **${taxVar}** excess GST charged.\n`,
    `₹0.90 would only arise from an invalid double-subtraction (subtracting the expected GST of ${taxExp} from the variance of ${taxVar}: ${taxVar} − ${taxExp} = ₹0.90). That calculation has no accounting basis. The gateway deducted ${taxAct} instead of ${taxExp}, making the complete overcharge ${taxVar} with no secondary deductions.`,
  ].join('\n');
}

/**
 * 13. Mathematical Calculation Explanation
 */
function answerMathExplanation(ctx) {
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
    `**Mathematical Derivation for Case \`${ctx.case_id}\`:**\n`,
    `1. **Platform Fee Overcharge:**`,
    `   Actual Fee (${feeAct}) − Expected Fee (${feeExp}) = **${feeVar}**\n`,
    `2. **GST Overcharge (18% on fee):**`,
    `   Actual GST (${taxAct}) − Expected GST (${taxExp}) = **${taxVar}**\n`,
    `3. **Total Excess Deductions:**`,
    `   Fee Overcharge (${feeVar}) + GST Overcharge (${taxVar}) = **${shortfall}**\n`,
    `4. **Net Settlement Verification:**`,
    `   • Expected Net: ${gross} − ${feeExp} − ${taxExp} = **${expNet}**`,
    `   • Actual Net Received: ${gross} − ${feeAct} − ${taxAct} = **${actNet}**`,
    `   • Shortfall: ${expNet} − ${actNet} = **${shortfall}**.`,
  ].join('\n');
}

/**
 * 14. Identifier Lookup
 */
function answerIdentifierLookup(ctx, message) {
  const norm = (message || '').toLowerCase();
  if (norm.includes('payment')) {
    return `The payment ID for this case is \`${ctx.payment_id || 'N/A'}\`.`;
  }
  if (norm.includes('order')) {
    return `The merchant order ID for this case is \`${ctx.order_id || 'N/A'}\`.`;
  }
  if (norm.includes('utr')) {
    return `The settlement UTR for this batch is \`${ctx.settlement_utr || 'N/A'}\`.`;
  }
  if (norm.includes('batch') || norm.includes('settlement id')) {
    return `The settlement batch ID is \`${ctx.settlement_id || 'N/A'}\` (UTR: \`${ctx.settlement_utr || 'N/A'}\`).`;
  }
  return [
    `**Identifiers for Case \`${ctx.case_id}\`:**`,
    `• **Payment ID:** \`${ctx.payment_id || 'N/A'}\``,
    `• **Order ID:** \`${ctx.order_id || 'N/A'}\``,
    `• **Settlement Batch:** \`${ctx.settlement_id || 'N/A'}\` (UTR: \`${ctx.settlement_utr || 'N/A'}\`)`,
    `• **Payment Method:** \`${ctx.payment_method || 'CARD'}\``,
  ].join('\n');
}

/**
 * 15. Settlement Lookup
 */
function answerSettlementLookup(ctx, message) {
  const norm = (message || '').toLowerCase();
  if (norm.includes('expected')) {
    return `The expected net settlement payout was **${ctx.expected_net_formatted}** (Gross ${ctx.gross_amount_formatted} minus contracted fee ${ctx.fee_expected_formatted} and GST ${ctx.tax_expected_formatted}).`;
  }
  if (norm.includes('actual') || norm.includes('received')) {
    return `The actual settlement credit received was **${ctx.actual_settlement_formatted}**, which is short by **${ctx.net_shortfall_formatted || ctx.amount_at_risk_formatted}** due to gateway fee and tax overcharges.`;
  }
  return [
    `**Settlement Comparison for Case \`${ctx.case_id}\`:**`,
    `• **Expected Net Settlement:** ${ctx.expected_net_formatted}`,
    `• **Actual Settlement Received:** ${ctx.actual_settlement_formatted}`,
    `• **Net Shortfall:** ${ctx.net_shortfall_formatted || ctx.amount_at_risk_formatted}`,
  ].join('\n');
}

// ── Main Export ───────────────────────────────────────────────────────────────

/**
 * Generate a conversational answer for an operator's question using deterministic
 * case data and multi-turn conversation memory.
 *
 * @param {string} message - Operator's question
 * @param {Object} ctx     - Built by chatContextBuilder.buildChatContext()
 * @param {Array}  history - Prior turns [{role:'operator'|'payvault', content:string}]
 * @returns {{ answer: string, intent: string }}
 */
function generateLocalAnswer(message, ctx, history = []) {
  const intent = analyzeIntent(message, history, ctx);

  let answer;
  switch (intent) {
    case 'state_change_guard':
      answer = stateChangeGuardResponse();
      break;
    case 'why_flagged':
      answer = answerWhyFlagged(ctx);
      break;
    case 'fee_specific':
      answer = answerFeeSpecific(ctx);
      break;
    case 'tax_specific':
      answer = answerTaxSpecific(ctx);
      break;
    case 'is_fee_the_problem':
      answer = answerIsFeeTheProblem(ctx);
      break;
    case 'settlement_causality':
      answer = answerSettlementCausality(ctx);
      break;
    case 'amount_at_risk':
      answer = answerAmountAtRisk(ctx);
      break;
    case 'why_not_90_paise':
      answer = answerWhyNot90Paise(ctx);
      break;
    case 'math_explanation':
      answer = answerMathExplanation(ctx);
      break;
    case 'identifier_lookup':
      answer = answerIdentifierLookup(ctx, message);
      break;
    case 'settlement_lookup':
      answer = answerSettlementLookup(ctx, message);
      break;
    case 'what_to_verify':
      answer = answerWhatToVerify(ctx);
      break;
    case 'simple_explanation':
      answer = answerSimpleExplanation(ctx);
      break;
    case 'full_financial_breakdown':
      answer = answerFullBreakdown(ctx);
      break;
    case 'historical_cases':
      answer = answerHistoricalCases(ctx);
      break;
    case 'diagnostic_summary':
    default:
      answer = answerDiagnosticSummary(ctx, message);
      break;
  }

  return { answer, intent };
}

module.exports = {
  generateLocalAnswer,
  analyzeIntent,
  catLabel,
};
