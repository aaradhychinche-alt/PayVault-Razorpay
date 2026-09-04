'use strict';
/**
 * src/db/redis.js
 *
 * Redis Transient State Layer for Payvault AI.
 *
 * Stores:
 *   - Payvault AI conversation state
 *   - Recent conversation turns
 *   - Investigation chat context cache
 *
 * Strictly scoped keys:
 *   payvault:chat:<investigationId>:<conversationId>
 *
 * GUARANTEES:
 *   - Case isolation: CASE_A state NEVER leaks to CASE_B.
 *   - Time-to-live (TTL) expiration prevents unbounded growth.
 *   - In-memory fallback client when Redis is not running locally.
 */

const Redis = require('ioredis');

const DEFAULT_TTL_SECONDS = parseInt(process.env.CHAT_CONTEXT_TTL_SECONDS || '3600', 10);

class InMemoryRedisStore {
  constructor() {
    this.store = new Map();
    this.ttls = new Map();
  }

  _isExpired(key) {
    const expiry = this.ttls.get(key);
    if (!expiry) return false;
    if (Date.now() > expiry) {
      this.store.delete(key);
      this.ttls.delete(key);
      return true;
    }
    return false;
  }

  async get(key) {
    if (this._isExpired(key)) return null;
    return this.store.get(key) || null;
  }

  async set(key, val, exFlag, ttlSec) {
    this.store.set(key, val);
    if (exFlag === 'EX' && ttlSec) {
      this.ttls.set(key, Date.now() + ttlSec * 1000);
    } else {
      this.ttls.delete(key);
    }
    return 'OK';
  }

  async del(...keys) {
    let count = 0;
    for (const k of keys) {
      if (this.store.delete(k)) count++;
      this.ttls.delete(k);
    }
    return count;
  }

  async keys(pattern) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    const matched = [];
    for (const k of this.store.keys()) {
      if (!this._isExpired(k) && regex.test(k)) {
        matched.push(k);
      }
    }
    return matched;
  }

  async ttl(key) {
    if (!this.store.has(key) || this._isExpired(key)) return -2;
    const expiry = this.ttls.get(key);
    if (!expiry) return -1;
    return Math.max(0, Math.ceil((expiry - Date.now()) / 1000));
  }

  async quit() {
    this.store.clear();
    this.ttls.clear();
  }
}

let _client = null;
let _isRealRedis = false;
let _checked = false;

function getRedisUrl() {
  return process.env.REDIS_URL || 'redis://localhost:6379';
}

function initClient() {
  if (_client) return _client;

  // Try real Redis connection with short connect timeout
  const redisUrl = getRedisUrl();
  const realClient = new Redis(redisUrl, {
    connectTimeout: 800,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null, // don't hang if offline
    enableOfflineQueue: false,
    lazyConnect: true,
  });

  realClient.on('error', () => {
    // Suppress connection error logs; fallback will be used
  });

  _client = realClient;
  return _client;
}

/**
 * Check if Redis is online; falls back to InMemoryRedisStore if not.
 */
async function checkConnection() {
  if (_checked) return _isRealRedis;

  try {
    const client = initClient();
    await client.connect();
    await client.ping();
    _isRealRedis = true;
    _checked = true;
    console.log('[Payvault Redis] Connected to Redis successfully.');
  } catch (err) {
    _isRealRedis = false;
    _checked = true;
    _client = new InMemoryRedisStore();
    console.log('[Payvault Redis] Redis unavailable. Operating with in-memory transient store fallback.');
  }

  return _isRealRedis;
}

function getClient() {
  if (!_client) {
    _client = new InMemoryRedisStore();
  }
  return _client;
}

function buildConversationKey(investigationId, conversationId) {
  if (!investigationId || !conversationId) {
    throw new Error('Both investigationId and conversationId are required for Redis key scoping.');
  }
  return `payvault:chat:${investigationId}:${conversationId}`;
}

/**
 * Save conversation state with configurable TTL.
 *
 * @param {string} investigationId - Investigation Case ID
 * @param {string} conversationId  - Conversation Session ID
 * @param {Object} state           - ConversationState payload
 * @param {number} [ttlSeconds]    - TTL in seconds
 */
async function saveConversationState(investigationId, conversationId, state, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const key = buildConversationKey(investigationId, conversationId);
  const client = getClient();
  const payload = JSON.stringify({
    investigationId,
    conversationId,
    currentTopic:          state.currentTopic || null,
    previousIntent:        state.previousIntent || null,
    referencedEntities:    state.referencedEntities || [],
    activeFinancialMetric: state.activeFinancialMetric || null,
    activeEvidenceTopic:   state.activeEvidenceTopic || null,
    activeResolutionTopic: state.activeResolutionTopic || null,
    lastUserQuestion:      state.lastUserQuestion || null,
    lastAnswerSummary:     state.lastAnswerSummary || null,
    turnNumber:            state.turnNumber || 1,
    savedAt:               Date.now(),
  });

  await client.set(key, payload, 'EX', ttlSeconds);
  return { key, ttl: ttlSeconds };
}

/**
 * Retrieve conversation state.
 *
 * @param {string} investigationId
 * @param {string} conversationId
 * @returns {Promise<Object|null>}
 */
async function getConversationState(investigationId, conversationId) {
  const key = buildConversationKey(investigationId, conversationId);
  const client = getClient();
  const raw = await client.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Delete a specific conversation state.
 */
async function deleteConversationState(investigationId, conversationId) {
  const key = buildConversationKey(investigationId, conversationId);
  const client = getClient();
  return client.del(key);
}

/**
 * Clear all conversation states scoped to an investigation.
 */
async function clearCaseConversations(investigationId) {
  if (!investigationId) return 0;
  const client = getClient();
  const pattern = `payvault:chat:${investigationId}:*`;
  const keys = await client.keys(pattern);
  if (keys.length > 0) {
    return client.del(...keys);
  }
  return 0;
}

/**
 * Get remaining TTL for a conversation key.
 */
async function getTTL(investigationId, conversationId) {
  const key = buildConversationKey(investigationId, conversationId);
  const client = getClient();
  return client.ttl(key);
}

async function close() {
  if (_client && _client.quit) {
    await _client.quit();
  }
  _client = null;
  _isRealRedis = false;
  _checked = false;
}

module.exports = {
  getClient,
  checkConnection,
  buildConversationKey,
  saveConversationState,
  getConversationState,
  deleteConversationState,
  clearCaseConversations,
  getTTL,
  close,
  DEFAULT_TTL_SECONDS,
  InMemoryRedisStore,
};
