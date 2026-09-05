'use strict';
/**
 * src/db/repositories/reconciliationRepository.js
 *
 * Repository for Reconciliation Results persistence.
 * All monetary amounts are strictly integer paise.
 */

const postgres = require('../postgres');
const dataStore = require('../../store/dataStore');

class ReconciliationRepository {
  validatePaise(val, name) {
    if (val !== null && val !== undefined) {
      if (typeof val !== 'number' || !Number.isInteger(val)) {
        throw new Error(`Invalid monetary ${name}: expected integer paise, got ${val}`);
      }
    }
  }

  async save(result) {
    this.validatePaise(result.amount_razorpay, 'amount_razorpay');
    this.validatePaise(result.amount_merchant, 'amount_merchant');
    this.validatePaise(result.amount_variance, 'amount_variance');
    this.validatePaise(result.fee_expected, 'fee_expected');
    this.validatePaise(result.fee_actual, 'fee_actual');
    this.validatePaise(result.tax_expected, 'tax_expected');
    this.validatePaise(result.tax_actual, 'tax_actual');

    if (postgres.isAvailable()) {
      const sql = `
        INSERT INTO reconciliation_results (
          id, settlement_entity_id, merchant_order_id, merchant_ledger_id,
          payment_entity_id, refund_entity_ids, status, exception_category,
          reason, amount_razorpay_paise, amount_merchant_paise, amount_variance_paise,
          fee_expected_paise, fee_actual_paise, tax_expected_paise, tax_actual_paise,
          created_at, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          exception_category = EXCLUDED.exception_category,
          reason = EXCLUDED.reason,
          amount_razorpay_paise = EXCLUDED.amount_razorpay_paise,
          amount_merchant_paise = EXCLUDED.amount_merchant_paise,
          amount_variance_paise = EXCLUDED.amount_variance_paise,
          fee_expected_paise = EXCLUDED.fee_expected_paise,
          fee_actual_paise = EXCLUDED.fee_actual_paise,
          tax_expected_paise = EXCLUDED.tax_expected_paise,
          tax_actual_paise = EXCLUDED.tax_actual_paise,
          metadata = EXCLUDED.metadata
        RETURNING *;
      `;
      const values = [
        result.id,
        result.settlement_entity_id,
        result.merchant_order_id || null,
        result.merchant_ledger_id || null,
        result.payment_entity_id || null,
        JSON.stringify(result.refund_entity_ids || []),
        result.status,
        result.exception_category || null,
        result.reason,
        result.amount_razorpay ?? null,
        result.amount_merchant ?? null,
        result.amount_variance ?? null,
        result.fee_expected ?? null,
        result.fee_actual ?? null,
        result.tax_expected ?? null,
        result.tax_actual ?? null,
        result.created_at ? (typeof result.created_at === 'number' ? new Date(result.created_at * 1000) : new Date(result.created_at)) : new Date(),
        JSON.stringify(result.metadata || {}),
      ];
      const res = await postgres.query(sql, values);
      return res.rows[0];
    }

    // DEVELOPMENT FALLBACK
    const store = dataStore.getStore();
    const existingIdx = store.reconciliationResults.findIndex(r => r.id === result.id);
    if (existingIdx >= 0) {
      store.reconciliationResults[existingIdx] = { ...store.reconciliationResults[existingIdx], ...result };
    } else {
      store.reconciliationResults.push(result);
    }
    return result;
  }

  async findById(id) {
    if (postgres.isAvailable()) {
      const sql = 'SELECT * FROM reconciliation_results WHERE id = $1';
      const res = await postgres.query(sql, [id]);
      return res.rows[0] || null;
    }

    const store = dataStore.getStore();
    return store.reconciliationResults.find(r => r.id === id) || null;
  }

  async findAll(filter = {}) {
    if (postgres.isAvailable()) {
      let sql = 'SELECT * FROM reconciliation_results WHERE 1=1';
      const values = [];
      if (filter.status) {
        values.push(filter.status.toUpperCase());
        sql += ` AND status = $${values.length}`;
      }
      if (filter.category) {
        values.push(filter.category.toUpperCase());
        sql += ` AND exception_category = $${values.length}`;
      }
      sql += ' ORDER BY created_at DESC';
      const res = await postgres.query(sql, values);
      return res.rows;
    }

    let results = dataStore.getReconciliationResults();
    if (filter.status) {
      results = results.filter(r => r.status === filter.status.toUpperCase());
    }
    if (filter.category) {
      results = results.filter(r => r.exception_category === filter.category.toUpperCase());
    }
    return results;
  }
}

module.exports = new ReconciliationRepository();
