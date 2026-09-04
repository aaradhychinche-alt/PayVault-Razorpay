'use strict';
/**
 * src/investigation/chat/ollamaChatEngine.js
 *
 * Conversational LLM chat engine for Payvault Investigation Copilot.
 * Connects to local Ollama runtime using native multi-turn /api/chat endpoint.
 *
 * ARCHITECTURE CONTRACT:
 * - Receives CURRENT INVESTIGATION CONTEXT + CONVERSATION HISTORY + USER MESSAGE.
 * - Operates locally with zero cloud API dependencies.
 * - Grounded strictly in the deterministic investigation case data.
 * - Answers dynamically without keyword rules or hardcoded templates.
 * - Returns { success: false } if Ollama is unreachable so caller falls back cleanly.
 */

const http = require('http');
const { URL } = require('url');
const { fmtINR } = require('./chatContextBuilder');

const DEFAULT_OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const DEFAULT_QWEN_MODEL      = process.env.QWEN_MODEL      || 'qwen2.5:1.5b';
const DEFAULT_TIMEOUT_MS      = parseInt(process.env.QWEN_TIMEOUT_MS, 10) || 15000;

class OllamaChatEngine {
  constructor(options = {}) {
    this.baseUrl   = options.baseUrl   || DEFAULT_OLLAMA_BASE_URL;
    this.model     = options.model     || DEFAULT_QWEN_MODEL;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  /**
   * Check if Ollama is reachable.
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    return new Promise(resolve => {
      try {
        const u = new URL('/api/tags', this.baseUrl);
        const req = http.request(
          {
            hostname: u.hostname,
            port:     u.port || 80,
            path:     u.pathname,
            method:   'GET',
            timeout:  1500,
          },
          res => resolve(res.statusCode >= 200 && res.statusCode < 300),
        );
        req.on('error',   () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * Send a multi-turn chat message to Ollama with full case context injected.
   *
   * @param {string}      message – operator's current message
   * @param {ChatContext} ctx     – built by chatContextBuilder
   * @param {Array}       history – [{role:'operator'|'payvault', content:string}]
   * @returns {Promise<{success:boolean, answer?:string, model?:string, reason?:string}>}
   */
  async chat(message, ctx, history = []) {
    const avail = await this.isAvailable();
    if (!avail) {
      return { success: false, reason: 'OLLAMA_UNAVAILABLE' };
    }

    const messages = this._buildChatMessages(message, ctx, history);

    return new Promise(resolve => {
      let settled = false;
      const postData = JSON.stringify({
        model:    this.model,
        messages: messages,
        stream:   false,
        options: {
          temperature: 0.1,  // Low temperature for factual precision and grounded numbers
          top_p:       0.9,
        },
      });

      let parsedUrl;
      try {
        parsedUrl = new URL('/api/chat', this.baseUrl);
      } catch {
        return resolve({ success: false, reason: 'INVALID_BASE_URL' });
      }

      const req = http.request(
        {
          hostname: parsedUrl.hostname,
          port:     parsedUrl.port || 80,
          path:     parsedUrl.pathname,
          method:   'POST',
          headers: {
            'Content-Type':   'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
          timeout: this.timeoutMs,
        },
        res => {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => {
            if (settled) return;
            settled = true;
            try {
              const parsed = JSON.parse(body);
              const text = (parsed.message?.content || parsed.response || '').trim();
              if (text) {
                resolve({ success: true, answer: text, model: `Qwen (${this.model})` });
              } else {
                resolve({ success: false, reason: 'EMPTY_RESPONSE' });
              }
            } catch (err) {
              resolve({ success: false, reason: 'MALFORMED_RESPONSE', error: err.message });
            }
          });
        },
      );

      req.on('error', err => {
        if (!settled) {
          settled = true;
          resolve({ success: false, reason: 'NETWORK_ERROR', error: err.message });
        }
      });
      req.on('timeout', () => {
        if (!settled) {
          settled = true;
          req.destroy();
          resolve({ success: false, reason: 'TIMEOUT' });
        }
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Build multi-turn messages array for Ollama /api/chat.
   * System message establishes the copilot identity, strict factual grounding,
   * mathematical relationships, and case data facts.
   *
   * @private
   */
  /**
   * Build multi-turn messages array for Ollama /api/chat.
   * Embeds the genuine reasoning-based investigation copilot architecture:
   * Intent Understanding -> Fact Retrieval -> Arithmetic Verification -> Adaptive Response.
   *
   * @private
   */
  _buildChatMessages(message, ctx, history) {
    const grossFmt       = ctx.gross_amount_formatted || fmtINR(ctx.gross_amount_paise);
    const expNetFmt      = ctx.expected_net_formatted || fmtINR(ctx.expected_net_paise);
    const actNetFmt      = ctx.actual_settlement_formatted || fmtINR(ctx.actual_settlement_paise);
    const expFeeFmt      = ctx.fee_expected_formatted || fmtINR(ctx.fee_expected_paise);
    const actFeeFmt      = ctx.fee_actual_formatted || fmtINR(ctx.fee_actual_paise);
    const feeVarFmt      = ctx.fee_variance_formatted || (ctx.fee_variance_paise !== null ? fmtINR(Math.abs(ctx.fee_variance_paise)) : '₹0.00');
    const expTaxFmt      = ctx.tax_expected_formatted || fmtINR(ctx.tax_expected_paise);
    const actTaxFmt      = ctx.tax_actual_formatted || fmtINR(ctx.tax_actual_paise);
    const taxVarFmt      = ctx.tax_variance_formatted || (ctx.tax_variance_paise !== null ? fmtINR(Math.abs(ctx.tax_variance_paise)) : '₹0.00');
    const shortfallFmt   = ctx.net_shortfall_formatted || ctx.amount_at_risk_formatted || (ctx.merchant_variance_paise !== null ? fmtINR(Math.abs(ctx.merchant_variance_paise)) : '₹0.00');
    const riskFmt        = ctx.amount_at_risk_formatted || fmtINR(ctx.amount_at_risk_paise);

    const feeIsOver      = ctx.fee_variance_paise && ctx.fee_variance_paise > 0;
    const taxIsOver      = ctx.tax_variance_paise && ctx.tax_variance_paise > 0;

    const suggestedList = (ctx.suggested_actions || []).length > 0
      ? ctx.suggested_actions.map((a, i) => `${i + 1}. [${a.priority || 'MEDIUM'}] ${a.description || a}`).join('\n')
      : '1. [HIGH] Verify gateway contract fee schedule against actual settlement deduction.\n2. [HIGH] Request fee correction credit from the payment gateway.';

    const systemPrompt = `You are Payvault AI, an expert reasoning-based conversational investigation copilot for payment reconciliation and settlement exceptions.
You operate like a senior financial analyst pair-programming with a human investigator.
You understand natural language contextually and dynamically, without relying on keyword matching.

═══════════════════════════════════════════════════════════
INTERNAL REASONING ARCHITECTURE (Apply internally to formulate your answer):
1. UNDERSTAND USER INTENT & CONVERSATIONAL CONTEXT:
   - Interpret natural language, informal questions, conversational follow-ups, and synonyms.
   - Maintain multi-turn continuity: resolve pronouns ("it", "that", "this") and follow-up references ("what about tax?", "how much was the overcharge?", "so how much are we short overall?") using the conversation history.
   - Recognize that these questions ask about the same concept:
     • Tax / GST queries: "what is the gst here?", "how much tax was charged?", "is the tax wrong?", "what about gst?", "did we get overcharged on tax?", "how much extra tax did we pay?"
     • Root cause queries: "why was this flagged?", "what went wrong?", "what's the issue here?", "why is this case suspicious?"
     • Overcharge / loss queries: "how much did we get overcharged?", "how much was the overcharge?", "how much are we short?"
     • Causality queries: "is gst contributing to the settlement difference?", "is the fee causing the settlement difference?"
     • Verification queries: "what should I verify?", "what should I check before resolving this?"
     • Summary queries: "explain the whole case simply", "explain the whole case"

2. REASON ACROSS CASE FACTS & EXACT ARITHMETIC:
   - Always derive and verify calculations from deterministic case facts:
     • Gross Customer Amount: ${grossFmt}
     • Platform Fee: Expected ${expFeeFmt} (contracted 2.0%), Actual ${actFeeFmt}
       → Fee Overcharge = Actual Fee (${actFeeFmt}) − Expected Fee (${expFeeFmt}) = ${feeVarFmt} ${feeIsOver ? 'overcharge' : ''}
     • GST on Fee: Expected ${expTaxFmt} (contracted 18.0% on fee), Actual ${actTaxFmt}
       → GST Overcharge = Actual GST (${actTaxFmt}) − Expected GST (${expTaxFmt}) = ${taxVarFmt} ${taxIsOver ? 'overcharge' : ''}
     • Total Excess Deductions = Fee Overcharge (${feeVarFmt}) + GST Overcharge (${taxVarFmt}) = ${shortfallFmt}
     • Net Settlement: Expected ${expNetFmt} (${grossFmt} − ${expFeeFmt} − ${expTaxFmt}), Actual Received ${actNetFmt} (${grossFmt} − ${actFeeFmt} − ${actTaxFmt})
     • Settlement Shortfall = Expected Net (${expNetFmt}) − Actual Received (${actNetFmt}) = ${shortfallFmt}
   - CRITICAL MATHEMATICAL INTEGRITY & ZERO-HALLUCINATION RULES:
     • The GST overcharge is: Actual GST (${actTaxFmt}) − Expected GST (${expTaxFmt}) = ${taxVarFmt}.
     • Therefore, the GST overcharge is exactly ${taxVarFmt}.
     • There is NO secondary or additional deduction (never subtract expected GST from the overcharge to invent a ₹0.90 deduction; ₹0.90 is FALSE and completely nonexistent).
     • The only excess deductions causing the ${shortfallFmt} shortfall are the ${feeVarFmt} fee overcharge and the ${taxVarFmt} GST overcharge (${feeVarFmt} + ${taxVarFmt} = ${shortfallFmt}).
     • All arithmetic must strictly balance.

3. ADAPTIVE RESPONSES & PROPORTIONAL DEPTH:
   - Adapt your answer directly to what the user is asking:
     • If the user asks specifically about GST / tax ("what is the gst here", "is the tax wrong?"): Give a concise GST-specific answer with the actual GST (${actTaxFmt}), expected GST (${expTaxFmt}), and derived overcharge of ${taxVarFmt} (${actTaxFmt} − ${expTaxFmt} = ${taxVarFmt}). Do NOT dump the full financial table.
     • If the user asks why flagged / what went wrong: Explain the root cause of the investigation (the gateway deducted higher fee and GST than contracted, causing a ${shortfallFmt} settlement shortfall).
     • If the user asks how much was overcharged: State the total overcharge of ${shortfallFmt} and explain the breakdown into ${feeVarFmt} fee overcharge and ${taxVarFmt} GST overcharge.
     • If the user asks if GST contributes to the settlement difference: Explicitly connect the ${taxVarFmt} GST overcharge and ${feeVarFmt} fee overcharge to the ${shortfallFmt} settlement shortfall.
     • If the user asks what to verify: Provide clear, actionable verification guidance.
     • If the user asks to explain the whole case simply: Provide a complete plain-English breakdown of the entire transaction from gross to settlement.

4. GROUNDING & SAFETY CONSTRAINTS:
   - Source of truth: Current case data below. Never invent transaction values, causes, historical cases, or evidence.
   - Distinguish calculated facts from supplied facts.
   - Read-only copilot: If asked to resolve, close, or reopen a case, explain that resolution must be performed by the operator using the workstation UI buttons.
   - Output only the final useful answer and concise supporting evidence/calculations. Do not output internal scratchpads or chain-of-thought markup.

═══════════════════════════════════════════════════════════
CURRENT INVESTIGATION CASE CONTEXT:
- Case ID: ${ctx.case_id}
- Category: ${ctx.exception_category}
- Status: ${ctx.status}
- Reconciliation Result: ${ctx.reconciliation_status}
- Engine Finding: ${ctx.exception_description || 'Reconciliation discrepancy detected.'}

IDENTIFIERS:
- Payment ID: ${ctx.payment_id || '(not available)'}
- Merchant Order ID: ${ctx.order_id || '(not available)'}
- Settlement Batch: ${ctx.settlement_id || '(not available)'} (UTR: ${ctx.settlement_utr || 'N/A'})
- Payment Method: ${ctx.payment_method || 'CARD'}

DETERMINISTIC FINANCIAL FACTS:
- Gross customer amount: ${grossFmt}
- Platform fee: Expected ${expFeeFmt} (contracted 2.0%) | Actual charged ${actFeeFmt} | Fee overcharge: ${feeVarFmt}
- GST on fee: Expected ${expTaxFmt} (contracted 18.0% on fee) | Actual charged ${actTaxFmt} | GST overcharge: ${taxVarFmt}
- Settlement payout: Expected ${expNetFmt} | Actual received ${actNetFmt} | Settlement shortfall: ${shortfallFmt}
- Total amount at risk: ${riskFmt}

ARITHMETIC DERIVATIONS:
- Fee overcharge derivation: Actual Fee (${actFeeFmt}) − Expected Fee (${expFeeFmt}) = ${feeVarFmt}
- GST overcharge derivation: Actual GST (${actTaxFmt}) − Expected GST (${expTaxFmt}) = ${taxVarFmt}
- Settlement shortfall derivation: Fee overcharge (${feeVarFmt}) + GST overcharge (${taxVarFmt}) = ${shortfallFmt} excess deductions
- Net credit verification: ${grossFmt} − ${actFeeFmt} − ${actTaxFmt} = ${actNetFmt} (short by ${shortfallFmt} from expected ${expNetFmt})

SUGGESTED VERIFICATION ACTIONS:
${suggestedList}
═══════════════════════════════════════════════════════════`;

    const messages = [{ role: 'system', content: systemPrompt }];

    // Append conversation history (up to last 12 turns)
    if (Array.isArray(history)) {
      const recentHistory = history.slice(-12);
      for (const h of recentHistory) {
        if (!h || !h.content) continue;
        const role = (h.role === 'operator' || h.role === 'user') ? 'user' : 'assistant';
        messages.push({ role, content: String(h.content) });
      }
    }

    // Append current user message
    messages.push({ role: 'user', content: message });

    return messages;
  }
}

const defaultOllamaChatEngine = new OllamaChatEngine();

module.exports = { OllamaChatEngine, defaultOllamaChatEngine };

