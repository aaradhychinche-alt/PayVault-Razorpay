'use strict';
/**
 * src/investigation/ai/model/localModel.js
 *
 * Abstract Local AI Model Adapter.
 *
 * Supports local open-source models (e.g. via Ollama HTTP API) if running locally.
 * If no local model runtime is running, it gracefully signals availability=false
 * so the engine proceeds with our proprietary deterministic reasoning pipeline.
 *
 * IMPORTANT:
 * - NEVER calls any cloud LLM API (no Gemini, no OpenAI, no Claude).
 * - Operates entirely within the local machine / localhost.
 * - Works 100% offline.
 */

const http = require('http');

class LocalModelAdapter {
  constructor(options = {}) {
    this.host = options.host || process.env.OLLAMA_HOST || '127.0.0.1';
    this.port = options.port || parseInt(process.env.OLLAMA_PORT, 10) || 11434;
    this.model = options.model || process.env.LOCAL_MODEL_NAME || 'qwen2.5:3b';
    this.timeoutMs = options.timeoutMs || 5000;
  }

  /**
   * Check if the local inference runtime is reachable.
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    return new Promise((resolve) => {
      const req = http.request(
        {
          host: this.host,
          port: this.port,
          path: '/api/tags',
          method: 'GET',
          timeout: 1500,
        },
        (res) => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(true);
          } else {
            resolve(false);
          }
        }
      );

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  /**
   * Generate text using the local model if available.
   *
   * @param {string} prompt
   * @returns {Promise<{ success: boolean, text?: string, model: string, error?: string }>}
   */
  async generate(prompt) {
    const available = await this.isAvailable();
    if (!available) {
      return {
        success: false,
        model: 'none',
        error: `Local model runtime not reachable at http://${this.host}:${this.port}`,
      };
    }

    return new Promise((resolve) => {
      const postData = JSON.stringify({
        model: this.model,
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.2,
          top_p: 0.9,
        },
      });

      const req = http.request(
        {
          host: this.host,
          port: this.port,
          path: '/api/generate',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          let responseBody = '';
          res.on('data', (chunk) => {
            responseBody += chunk;
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(responseBody);
              resolve({
                success: true,
                text: parsed.response,
                model: this.model,
              });
            } catch (err) {
              resolve({
                success: false,
                model: this.model,
                error: `Failed to parse local model output: ${err.message}`,
              });
            }
          });
        }
      );

      req.on('error', (err) => {
        resolve({
          success: false,
          model: this.model,
          error: `Local model request failed: ${err.message}`,
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          success: false,
          model: this.model,
          error: 'Local model request timed out',
        });
      });

      req.write(postData);
      req.end();
    });
  }
}

// Default singleton instance
const defaultAdapter = new LocalModelAdapter();

module.exports = {
  LocalModelAdapter,
  defaultAdapter,
};
