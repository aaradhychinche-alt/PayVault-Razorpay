'use strict';
/**
 * src/db/repositories/auditRepository.js
 *
 * Repository for Audit Events and Case Lifecycle Trail.
 * Immutable compliance ledger.
 */

const postgres = require('../postgres');
const dataStore = require('../../store/dataStore');

class AuditRepository {
  async recordEvent(event) {
    const id = event.id || `aud_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const timestamp = event.timestamp ? new Date(event.timestamp) : new Date();

    if (postgres.isAvailable()) {
      const sql = `
        INSERT INTO audit_events (
          id, case_id, action, actor, from_status, to_status,
          resolution_reason, notes, amount_at_risk_paise, timestamp, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *;
      `;
      const values = [
        id,
        event.case_id,
        event.action,
        event.actor || 'operator',
        event.from_status || null,
        event.to_status || null,
        event.resolution_reason || null,
        event.notes || null,
        event.amount_at_risk_paise || null,
        timestamp,
        JSON.stringify(event.metadata || {}),
      ];
      const res = await postgres.query(sql, values);
      return res.rows[0];
    }

    // DEVELOPMENT FALLBACK
    const store = dataStore.getStore();
    const normalized = {
      id,
      case_id: event.case_id,
      action: event.action,
      actor: event.actor || 'operator',
      from_status: event.from_status || null,
      to_status: event.to_status || null,
      resolution_reason: event.resolution_reason || null,
      notes: event.notes || null,
      amount_at_risk_paise: event.amount_at_risk_paise || null,
      timestamp: timestamp.toISOString(),
      metadata: event.metadata || {},
    };
    store.auditTrail.push(normalized);
    return normalized;
  }

  async findByCaseId(caseId) {
    if (postgres.isAvailable()) {
      const sql = 'SELECT * FROM audit_events WHERE case_id = $1 ORDER BY timestamp ASC';
      const res = await postgres.query(sql, [caseId]);
      return res.rows;
    }

    const store = dataStore.getStore();
    return store.auditTrail.filter(e => e.case_id === caseId);
  }
}

module.exports = new AuditRepository();
