'use strict';
/**
 * src/investigation/chat/ollamaChatEngine.js
 *
 * Optional Ollama-backed chat engine for the "Ask Payvault AI" feature.
 *
 * ARCHITECTURE CONTRACT:
 * - This engine is ONLY invoked when ENABLE_OLLAMA=true.
 * - It receives a pre-built ChatContext (financial facts from Payvault) + operator message.
 * - It NEVER modifies case state.
 * - It NEVER fabricates financial figures — all paise values are injected from ctx.
 * - If Ollama is unavailable, returns { success: false } so caller falls back gracefully.
 *
 * Uses the same http-based approach as QwenLocalModel to stay consistent.
 */

const http  = require('http');
const { URL } = require('url');
const { fmtINR } = require('./chatContextBuilder');

const DEFAULT_OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL  || 'http://127.0.0.1:11434';
const DEFAULT_QWEN_MODEL      = process.env.QWEN_MODEL       || 'qwen2.5:7b';
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
   * Send a chat question to Ollama with full case context injected.
   *
   * @param {string}      message        – operator's question
   * @param {ChatContext} ctx            – from chatContextBuilder
   * @param {Array}       history        – [{role:'operator'|'payvault', content:string}]
   * @returns {Promise<{success:boolean, answer?:string, model?:string, reason?:string}>}
   */
  async chat(message, ctx, history = []) {
    const avail = await this.isAvailable();
    if (!avail) {
      return { success: false, reason: 'OLLAMA_UNAVAILABLE' };
    }

    const prompt = this._buildChatPrompt(message, ctx, history);

    return new Promise(resolve => {
      let settled = false;
      const postData = JSON.stringify({
        model:  this.model,
        prompt,
        stream: false,
        options: {
          temperature: 0.15,   // Low for factual precision
          top_p: 0.9,
        },
      });

      let parsedUrl;
      try {
        parsedUrl = new URL('/api/generate', this.baseUrl);
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
              const text   = (parsed.response || '').trim();
              if (text) {
                resolve({ success: true, answer: text, model: this.model });
              } else {
                resolve({ success: false, reason: 'EMPTY_RESPONSE' });
              }
            } catch (err) {
              resolve({ success: false, reason: 'MALFORMED_RESPONSE', error: err.message });
            }
          });
        },
      );

      req.on('error',   err => { if (!settled) { settled = true; resolve({ success: false, reason: 'NETWORK_ERROR', error: err.message }); } });
      req.on('timeout', ()  => { if (!settled) { settled = true; req.destroy(); resolve({ success: false, reason: 'TIMEOUT' }); } });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Build the investigation chat prompt for Ollama.
   * All financial values come from ctx (Payvault's calculation) — never ask Ollama to calculate.
   * @private
   */
  _buildChatPrompt(message, ctx, history) {
    const financialFacts = [
      ctx.gross_amount_paise        !== null ? `Gross amount: ${fmtINR(ctx.gross_amount_paise)}`           : null,
      ctx.fee_expected_paise        !== null ? `Expected fee (2%): ${fmtINR(ctx.fee_expected_paise)}`      : null,
      ctx.fee_actual_paise          !== null ? `Actual fee charged: ${fmtINR(ctx.fee_actual_paise)}`       : null,
      ctx.fee_variance_paise        !== null ? `Fee variance: ${fmtINR(ctx.fee_variance_paise)}`           : null,
      ctx.tax_expected_paise        !== null ? `Expected GST: ${fmtINR(ctx.tax_expected_paise)}`           : null,
      ctx.tax_actual_paise          !== null ? `Actual GST: ${fmtINR(ctx.tax_actual_paise)}`               : null,
      ctx.tax_variance_paise        !== null ? `GST variance: ${fmtINR(ctx.tax_variance_paise)}`           : null,
      ctx.expected_net_paise        !== null ? `Expected net to merchant: ${fmtINR(ctx.expected_net_paise)}`   : null,
      ctx.actual_settlement_paise   !== null ? `Actual settlement credited: ${fmtINR(ctx.actual_settlement_paise)}` : null,
      ctx.merchant_variance_paise   !== null ? `Net variance: ${fmtINR(ctx.merchant_variance_paise)}`      : null,
      ctx.amount_at_risk_paise      !== null ? `Amount at risk: ${fmtINR(ctx.amount_at_risk_paise)}`       : null,
    ].filter(Boolean).join('\n');

    const similarCasesText = ctx.historical.similar_cases_count > 0
      ? `${ctx.historical.similar_cases_count} similar case(s) found in history.`
      : 'No similar cases found in current session history.';

    const historyText = history.length > 0
      ? history.slice(-6).map(h => `${h.role === 'operator' ? 'Operator' : 'Payvault AI'}: ${h.content}`).join('\n')
      : '(No prior conversation)';

    const suggestedActionsText = ctx.suggested_actions.length > 0
      ? ctx.suggested_actions.map((a, i) => `${i + 1}. [${a.priority}] ${a.description}`).join('\n')
      : '(No suggested actions generated yet — investigation may not have been run)';

    return `You are Payvault's investigation assistant. You help financial operations staff understand the current settlement exception case.

CRITICAL CONSTRAINTS:
1. Use ONLY the case data below to answer. Never invent amounts, IDs, or events.
2. Never calculate financial values — they are pre-computed and provided below.
3. Do NOT resolve, reopen, or modify cases. If asked, explain that operators must use the workstation UI.
4. Keep answers concise and operational (1-4 sentences or a short bullet list).
5. If asked about data not in the case, say it is not available.
6. Always quote the exact values provided — do not round or approximate.

═══ CURRENT CASE ═══
Case ID: ${ctx.case_id}
Exception category: ${ctx.exception_category}
Status: ${ctx.status}
Reconciliation: ${ctx.reconciliation_status}
Engine finding: ${ctx.exception_description || '(not available)'}

Payment ID: ${ctx.payment_id || '(not available)'}
Order ID: ${ctx.order_id || '(not available)'}
Settlement batch: ${ctx.settlement_id || '(not available)'}
Payment method: ${ctx.payment_method || '(not available)'}

FINANCIAL FACTS (from Payvault deterministic engine — do NOT recalculate):
${financialFacts || '(Financial details not yet available — investigation may not have been run)'}

Historical: ${similarCasesText}

Suggested actions:
${suggestedActionsText}
═══════════════════

PRIOR CONVERSATION:
${historyText}

OPERATOR QUESTION: ${message}

Answer (concise, operational, grounded in the case data above):`;
  }
}

const defaultOllamaChatEngine = new OllamaChatEngine();

module.exports = { OllamaChatEngine, defaultOllamaChatEngine };
