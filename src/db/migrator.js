'use strict';
/**
 * src/db/migrator.js
 *
 * PostgreSQL Migration Runner.
 * Executes versioned migrations tracking applied files in `schema_migrations`.
 */

const fs = require('fs');
const path = require('path');
const postgres = require('./postgres');

async function runMigrations(clientOrPool = null) {
  const runner = clientOrPool || postgres.getPool();
  if (!runner) {
    throw new Error('No PostgreSQL connection available to run migrations.');
  }

  // Create schema_migrations tracker
  await runner.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    return { applied: [], skipped: [] };
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const appliedRes = await runner.query('SELECT version FROM schema_migrations');
  const appliedSet = new Set(appliedRes.rows.map(r => r.version));

  const applied = [];
  const skipped = [];

  for (const file of files) {
    if (appliedSet.has(file)) {
      skipped.push(file);
      continue;
    }

    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf8');

    // Run within a transaction
    const client = await (runner.connect ? runner.connect() : runner);
    try {
      if (client.query) {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        console.log(`[Payvault Migrator] Applied migration: ${file}`);
      }
    } catch (err) {
      if (client.query) await client.query('ROLLBACK');
      console.error(`[Payvault Migrator] Failed to apply ${file}:`, err);
      throw err;
    } finally {
      if (client.release) client.release();
    }
  }

  return { applied, skipped };
}

module.exports = {
  runMigrations,
};
