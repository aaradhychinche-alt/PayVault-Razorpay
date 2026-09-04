'use strict';
/**
 * src/db/repositories/investigationRepository.js
 *
 * Repository for Investigation persistence.
 *
 * All amounts (amount_at_risk_paise) are strictly integer paise.
 * Preserves strict case isolation between CASE_A and CASE_B.
 */

const postgres = require('../postgres');
const dataStore = require('../../store/dataStore');

class InvestigationRepository {
  validatePaise(val) {
    if (typeof val !== 'number' || !Number.isInteger(val) || val < 0) {
      throw new Error(`Invalid monetary amount_at_risk_paise: expected non-negative integer paise, got ${val}`);
    }
  }

  async save(investigation) {
    const amountAtRiskPaise = investigation.amount_at_risk_paise ?? investigation.amount_at_risk ?? 0;
    this.validatePaise(amountAtRiskPaise);

    const caseId = investigation.case_id || investigation.id;

    if (postgres.isAvailable()) {
      const sql = `
        INSERT INTO investigations (
          id, exception_id, case_id, exception_category, status,
          amount_at_risk_paise, summary, what_happened, why_it_matters,
          recommended_actions, evidence_summary, confidence_score,
          raw_investigation, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (case_id) DO UPDATE SET
          status = EXCLUDED.status,
          amount_at_risk_paise = EXCLUDED.amount_at_risk_paise,
          summary = EXCLUDED.summary,
          what_happened = EXCLUDED.what_happened,
          why_it_matters = EXCLUDED.why_it_matters,
          recommended_actions = EXCLUDED.recommended_actions,
          evidence_summary = EXCLUDED.evidence_summary,
          confidence_score = EXCLUDED.confidence_score,
          raw_investigation = EXCLUDED.raw_investigation,
          updated_at = NOW()
        RETURNING *;
      `;
      const values = [
        investigation.id || `inv_${caseId}`,
        investigation.exception_id || caseId,
        caseId,
        investigation.exception_category || 'UNEXPLAINED',
        investigation.status || 'OPEN',
        amountAtRiskPaise,
        investigation.summary || null,
        investigation.what_happened || null,
        investigation.why_it_matters || null,
        JSON.stringify(investigation.recommended_actions || []),
        JSON.stringify(investigation.evidence_summary || {}),
        investigation.confidence_score || null,
        JSON.stringify(investigation),
        investigation.created_at ? new Date(investigation.created_at) : new Date(),
        new Date(),
      ];
      const res = await postgres.query(sql, values);
      return res.rows[0];
    }

    // DEVELOPMENT FALLBACK
    const store = dataStore.getStore();
    const raw = investigation.raw_investigation || investigation;
    const normalized = {
      ...raw,
      id: investigation.id || `inv_${caseId}`,
      exception_id: investigation.exception_id || caseId,
      case_id: caseId,
      exception_category: investigation.exception_category || 'UNEXPLAINED',
      status: investigation.status || 'OPEN',
      amount_at_risk_paise: amountAtRiskPaise,
      amount_at_risk: amountAtRiskPaise,
      summary: investigation.summary || raw.summary || null,
      what_happened: investigation.what_happened || raw.what_happened || null,
      why_it_matters: investigation.why_it_matters || raw.why_it_matters || null,
      recommended_actions: investigation.recommended_actions || raw.recommended_actions || [],
      ai_analysis: raw.ai_analysis || {
        provider: 'PAYVAULT_LOCAL_INTELLIGENCE',
        model: 'Payvault Local ML',
        what_happened: investigation.what_happened || raw.what_happened,
        why_it_matters: investigation.why_it_matters || raw.why_it_matters,
        summary: investigation.summary || raw.summary,
      },
      evidence_summary: investigation.evidence_summary || raw.evidence || {},
      confidence_score: investigation.confidence_score || raw.confidence?.score || null,
      raw_investigation: raw,
      created_at: investigation.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    store.aiInvestigations.set(caseId, normalized);
    if (investigation.exception_id && investigation.exception_id !== caseId) {
      store.aiInvestigations.set(investigation.exception_id, normalized);
    }
    return normalized;
  }

  async findByCaseId(caseId) {
    if (postgres.isAvailable()) {
      const sql = 'SELECT * FROM investigations WHERE case_id = $1';
      const res = await postgres.query(sql, [caseId]);
      if (!res.rows[0]) return null;
      const row = res.rows[0];
      return {
        ...row,
        amount_at_risk_paise: parseInt(row.amount_at_risk_paise, 10),
      };
    }

    const store = dataStore.getStore();
    return store.aiInvestigations.get(caseId) || null;
  }

  async updateStatus(caseId, status) {
    if (postgres.isAvailable()) {
      const sql = `
        UPDATE investigations
        SET status = $2, updated_at = NOW()
        WHERE case_id = $1
        RETURNING *;
      `;
      const res = await postgres.query(sql, [caseId, status]);
      return res.rows[0] || null;
    }

    const store = dataStore.getStore();
    const inv = store.aiInvestigations.get(caseId);
    if (inv) {
      inv.status = status;
      inv.updated_at = new Date().toISOString();
    }
    return inv || null;
  }

  async findAll(filter = {}) {
    if (postgres.isAvailable()) {
      let sql = 'SELECT * FROM investigations WHERE 1=1';
      const values = [];
      if (filter.status) {
        values.push(filter.status);
        sql += ` AND status = $${values.length}`;
      }
      sql += ' ORDER BY created_at DESC';
      const res = await postgres.query(sql, values);
      return res.rows.map(r => ({
        ...r,
        amount_at_risk_paise: parseInt(r.amount_at_risk_paise, 10),
      }));
    }

    const store = dataStore.getStore();
    let res = Array.from(store.aiInvestigations.values());
    if (filter.status) res = res.filter(i => i.status === filter.status);
    return res;
  }
}

module.exports = new InvestigationRepository();
