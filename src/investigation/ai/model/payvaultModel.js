'use strict';
/**
 * src/investigation/ai/model/payvaultModel.js
 *
 * Node.js Adapter for the Payvault Learned Exception Intelligence model.
 * Bridges Node.js investigation cases with the Python ML subsystem.
 *
 * ARCHITECTURE:
 * Node.js (InvestigationCase)
 *       ↓
 * Python Subprocess (src/ml/predict.py)
 *       ↓
 * Random Forest Model (scikit-learn)
 *       ↓
 * Probabilities & Top Features
 *       ↓
 * Node.js Response
 */

const path = require('path');
const { spawn } = require('child_process');

const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const PREDICT_SCRIPT = path.resolve(__dirname, '../../../ml/predict.py');

class PayvaultLocalModel {
  constructor(options = {}) {
    this.pythonBin = options.pythonBin || PYTHON_BIN;
    this.scriptPath = options.scriptPath || PREDICT_SCRIPT;
    this.timeoutMs = options.timeoutMs || 8000;
    this.cache = new Map();
  }

  /**
   * Run local ML inference on an InvestigationCase.
   *
   * @param {Object} investigationCase
   * @returns {Promise<Object>} ML prediction result
   */
  async predict(investigationCase) {
    const cacheKey = investigationCase && investigationCase.case_id
      ? `${investigationCase.case_id}_${investigationCase.amount_at_risk}_${investigationCase.exception_category}`
      : null;

    if (cacheKey && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    return new Promise((resolve, reject) => {
      const pyProcess = spawn(this.pythonBin, [this.scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdoutData = '';
      let stderrData = '';
      let isSettled = false;

      const timer = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          pyProcess.kill();
          reject(new Error(`Python ML prediction timed out after ${this.timeoutMs}ms`));
        }
      }, this.timeoutMs);

      pyProcess.stdout.on('data', (chunk) => {
        stdoutData += chunk.toString();
      });

      pyProcess.stderr.on('data', (chunk) => {
        stderrData += chunk.toString();
      });

      pyProcess.on('error', (err) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timer);
          reject(new Error(`Failed to spawn Python process: ${err.message}`));
        }
      });

      pyProcess.on('close', (code) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timer);

          if (code !== 0) {
            return reject(new Error(`Python ML process exited with code ${code}: ${stderrData}`));
          }

          try {
            const parsed = JSON.parse(stdoutData);
            if (cacheKey) {
              this.cache.set(cacheKey, parsed);
            }
            resolve(parsed);
          } catch (err) {
            reject(new Error(`Failed to parse ML output as JSON: ${err.message}. Raw output: ${stdoutData.slice(0, 300)}`));
          }
        }
      });

      // Send serialized case JSON to stdin
      pyProcess.stdin.write(JSON.stringify(investigationCase));
      pyProcess.stdin.end();
    });
  }
}

/**
 * ModelRouter — Future-ready routing between Payvault Local ML and local LLM fallback.
 */
class ModelRouter {
  constructor(options = {}) {
    this.primaryModel = options.primaryModel || new PayvaultLocalModel();
    this.fallbackModel = options.fallbackModel || null;
    this.confidenceThreshold = parseFloat(process.env.AI_PRIMARY_CONFIDENCE_THRESHOLD) || 0.75;
    this.fallbackEnabled = (process.env.AI_FALLBACK_ENABLED === 'true');
  }

  /**
   * Route investigation to appropriate model.
   *
   * @param {Object} investigationCase
   * @returns {Promise<Object>}
   */
  async route(investigationCase) {
    let mlResult = null;
    try {
      mlResult = await this.primaryModel.predict(investigationCase);
    } catch (err) {
      console.warn(`[ModelRouter] Primary ML prediction failed: ${err.message}`);
    }

    if (mlResult && mlResult.confidence >= this.confidenceThreshold) {
      return {
        routed_to: 'PRIMARY_ML',
        ml_result: mlResult,
      };
    }

    if (this.fallbackEnabled && this.fallbackModel) {
      try {
        const fallbackResult = await this.fallbackModel.generate(investigationCase);
        return {
          routed_to: 'FALLBACK_LLM',
          ml_result: mlResult,
          fallback_result: fallbackResult,
        };
      } catch (err) {
        console.warn(`[ModelRouter] Fallback model failed: ${err.message}`);
      }
    }

    return {
      routed_to: 'PRIMARY_ML',
      ml_result: mlResult,
    };
  }
}

const defaultPayvaultModel = new PayvaultLocalModel();
const defaultModelRouter = new ModelRouter({ primaryModel: defaultPayvaultModel });

module.exports = {
  PayvaultLocalModel,
  ModelRouter,
  defaultPayvaultModel,
  defaultModelRouter,
};
