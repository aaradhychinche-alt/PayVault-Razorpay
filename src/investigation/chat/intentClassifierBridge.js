'use strict';
/**
 * src/investigation/chat/intentClassifierBridge.js
 *
 * Payvault AI — ML Intent Classifier Bridge (Node.js ↔ Python).
 *
 * Manages a persistent Python subprocess running the trained
 * TF-IDF + LogisticRegression intent classifier.
 *
 * Protocol: newline-delimited JSON over stdin/stdout.
 *   Send:    {"question": "What happened?"}
 *   Receive: {"intent": "CAUSE_ANALYSIS", "confidence": 0.98, "ok": true}
 *
 * ARCHITECTURE:
 * - The process is started once on first use (lazy start).
 * - Questions are queued and dispatched in order.
 * - If Python subprocess fails, falls back gracefully (returns null).
 * - NO Qwen, NO Ollama, NO external service — entirely local ML.
 *
 * ML MODEL: TF-IDF (char 2-4 gram) + LogisticRegression
 * Trained on 30,384 Payvault investigation intent samples.
 * Test accuracy: 99.84% | Semantic generalization: 10/12
 */

const path       = require('path');
const { spawn }  = require('child_process');

const PREDICT_SCRIPT = path.join(__dirname, '..', '..', 'ml', 'intent_predict_server.py');

// Map ML intent names → nativeReasoning intent keys
const ML_INTENT_TO_NATIVE = {
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
  RESOLUTION_GUIDANCE:       'resolution_guidance',
  RELATED_TRANSACTION:       'identifier_lookup',
  HISTORICAL_COMPARISON:     'historical_cases',
  SIMILAR_CASE:              'historical_cases',
  EXPLANATION:               'simple_explanation',
  CLARIFICATION:             'why_flagged',
  CONFIRMATION:              'why_flagged',
  GENERAL_INVESTIGATION_QUERY: 'full_financial_breakdown',
  UNKNOWN_QUERY:             'unknown_query',
};


// High-confidence ML threshold — below this, fall back to rule-based
// For 25 classes (random baseline is 0.04), 0.30 represents >7.5x uniform confidence.
const ML_CONFIDENCE_THRESHOLD = 0.30;

class IntentClassifierBridge {
  constructor() {
    this._proc       = null;
    this._starting   = false;
    this._queue      = [];
    this._buffer     = '';
    this._callbacks  = [];
    this._ready      = false;
    this._failed     = false;
  }

  /**
   * Start the Python subprocess (lazy, only on first call).
   */
  _startProcess() {
    if (this._proc || this._starting || this._failed) return;
    this._starting = true;

    try {
      this._proc = spawn('python3', [PREDICT_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this._proc.on('error', (err) => {
        console.warn('[Payvault Intent ML] Subprocess error:', err.message, '— falling back to rule-based intent.');
        this._failed = true;
        this._proc   = null;
        this._ready  = false;
        // Resolve all pending with null
        const cbs = this._callbacks.splice(0);
        cbs.forEach(function(cb) { cb(null); });
      });

      this._proc.on('exit', (code) => {
        console.warn('[Payvault Intent ML] Subprocess exited (code ' + code + ').');
        this._proc  = null;
        this._ready = false;
        const cbs = this._callbacks.splice(0);
        cbs.forEach(function(cb) { cb(null); });
      });

      // Capture stderr for logging
      this._proc.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg.includes('Model loaded')) {
          console.log('[Payvault Intent ML]', msg);
          this._ready = true;
          this._starting = false;
          // Drain queued questions
          const queued = this._queue.splice(0);
          queued.forEach((q) => this._sendQuestion(q.question, q.cb));
        }
      });

      // Parse stdout line-by-line
      this._proc.stdout.on('data', (chunk) => {
        this._buffer += chunk.toString();
        const lines = this._buffer.split('\n');
        this._buffer = lines.pop(); // keep incomplete line
        for (const line of lines) {
          if (!line.trim()) continue;
          const cb = this._callbacks.shift();
          if (!cb) continue;
          try {
            cb(JSON.parse(line));
          } catch (_) {
            cb(null);
          }
        }
      });
    } catch (err) {
      console.warn('[Payvault Intent ML] Failed to spawn subprocess:', err.message);
      this._failed = true;
      this._starting = false;
    }
  }

  _sendQuestion(question, cb) {
    if (!this._proc || !this._ready) {
      cb(null);
      return;
    }
    this._callbacks.push(cb);
    try {
      this._proc.stdin.write(JSON.stringify({ question }) + '\n');
    } catch (err) {
      this._callbacks.pop();
      cb(null);
    }
  }

  /**
   * Classify a question using the ML model.
   * Returns: Promise<{mlIntent: string, nativeIntent: string, confidence: number} | null>
   *
   * Returns null if the model is unavailable or confidence is below threshold.
   */
  classify(question) {
    return new Promise((resolve) => {
      if (this._failed) {
        resolve(null);
        return;
      }

      if (!this._proc) {
        this._startProcess();
      }

      const cb = (result) => {
        if (!result || !result.ok) {
          resolve(null);
          return;
        }
        const mlIntent     = result.intent;
        const confidence   = result.confidence;
        const nativeIntent = ML_INTENT_TO_NATIVE[mlIntent] || null;

        if (confidence < ML_CONFIDENCE_THRESHOLD || !nativeIntent) {
          resolve(null);
          return;
        }

        resolve({
          mlIntent,
          nativeIntent,
          confidence,
        });
      };

      if (this._ready) {
        this._sendQuestion(question, cb);
      } else if (!this._failed) {
        // Queue until ready
        this._queue.push({ question, cb });
      } else {
        resolve(null);
      }
    });
  }

  /**
   * Terminate the subprocess (call on server shutdown).
   */
  shutdown() {
    if (this._proc) {
      try { this._proc.kill(); } catch (_) {}
      this._proc = null;
    }
  }
}

// Singleton instance
const defaultBridge = new IntentClassifierBridge();

module.exports = {
  IntentClassifierBridge,
  defaultBridge,
  ML_INTENT_TO_NATIVE,
  ML_CONFIDENCE_THRESHOLD,
};
