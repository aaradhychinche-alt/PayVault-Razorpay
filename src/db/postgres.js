'use strict';
/**
 * src/db/postgres.js
 *
 * PostgreSQL Client & Connection Manager.
 *
 * Permanent source of truth for:
 *   - orders
 *   - payments
 *   - settlements
 *   - investigations & events
 *   - audit log
 *
 * FINANCIAL RULE:
 *   All monetary amounts are strictly integer paise (BIGINT).
 *   Never floating point.
 *
 * BACKWARD COMPATIBILITY:
 *   Clearly distinguishes between:
 *     - POSTGRES PRODUCTION/PERSISTENT MODE
 *     - DEVELOPMENT FALLBACK (in-memory dataStore when Postgres is offline)
 */

const { Pool } = require('pg');

let _pool = null;
let _isAvailable = false;
let _checked = false;

function getDatabaseUrl() {
  return process.env.DATABASE_URL || 'postgresql://payvault:payvault_dev_secret@localhost:5432/payvault';
}

function initPool() {
  if (_pool) return _pool;

  const connectionString = getDatabaseUrl();
  _pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 10000,
    max: 10,
  });

  _pool.on('error', (err) => {
    // Avoid unhandled crashes if DB disconnects during runtime
    _isAvailable = false;
  });

  return _pool;
}

/**
 * Check if PostgreSQL is reachable and mark mode accordingly.
 */
async function checkConnection() {
  if (_checked) return _isAvailable;

  try {
    const pool = initPool();
    const res = await pool.query('SELECT 1 AS alive');
    _isAvailable = res && res.rows && res.rows.length > 0;
    _checked = true;
    if (_isAvailable) {
      console.log('[Payvault DB] PostgreSQL connected successfully (POSTGRES PERSISTENT MODE).');
    }
  } catch (err) {
    _isAvailable = false;
    _checked = true;
    console.log('[Payvault DB] PostgreSQL unavailable or unconfigured. Operating in DEVELOPMENT FALLBACK mode.');
  }

  return _isAvailable;
}

function isAvailable() {
  return _isAvailable;
}

function getMode() {
  return _isAvailable ? 'POSTGRES_PRODUCTION' : 'DEVELOPMENT_FALLBACK';
}

function getPool() {
  return initPool();
}

async function query(text, params) {
  const pool = initPool();
  return pool.query(text, params);
}

async function close() {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _isAvailable = false;
    _checked = false;
  }
}

module.exports = {
  initPool,
  getPool,
  checkConnection,
  isAvailable,
  getMode,
  query,
  close,
  getDatabaseUrl,
};
