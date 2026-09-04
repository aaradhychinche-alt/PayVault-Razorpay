'use strict';
/**
 * src/db/repositories/settlementRepository.js
 *
 * Repository for Settlement Records persistence.
 * All monetary amounts (debit_paise, credit_paise, fee_paise, tax_paise) are strictly integer paise.
 */

const postgres = require('../postgres');
const dataStore = require('../../store/dataStore');

class SettlementRepository {
  validatePaise(val, name) {
    if (typeof val !== 'number' || !Number.isInteger(val) || val < 0) {
      throw new Error(`Invalid monetary ${name}: expected non-negative integer paise, got ${val}`);
    }
  }

  async save(record) {
    this.validatePaise(record.debit_paise ?? record.debit ?? 0, 'debit_paise');
    this.validatePaise(record.credit_paise ?? record.credit ?? 0, 'credit_paise');
    this.validatePaise(record.fee_paise ?? record.fee ?? 0, 'fee_paise');
    this.validatePaise(record.tax_paise ?? record.tax ?? 0, 'tax_paise');

    const debitPaise = record.debit_paise ?? record.debit ?? 0;
    const creditPaise = record.credit_paise ?? record.credit ?? 0;
    const feePaise = record.fee_paise ?? record.fee ?? 0;
    const taxPaise = record.tax_paise ?? record.tax ?? 0;
    const amountPaise = record.amount_paise ?? (creditPaise > 0 ? creditPaise : debitPaise);

    if (postgres.isAvailable()) {
      const sql = `
        INSERT INTO settlements (
          id, entity_id, type, debit_paise, credit_paise, amount_paise,
          fee_paise, tax_paise, settled_at, utr, settlement_id, order_id,
          payment_id, batch_id, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (id) DO UPDATE SET
          debit_paise = EXCLUDED.debit_paise,
          credit_paise = EXCLUDED.credit_paise,
          fee_paise = EXCLUDED.fee_paise,
          tax_paise = EXCLUDED.tax_paise,
          utr = EXCLUDED.utr,
          metadata = EXCLUDED.metadata
        RETURNING *;
      `;
      const values = [
        record.id,
        record.entity_id || record.id,
        record.type || 'payment',
        debitPaise,
        creditPaise,
        amountPaise,
        feePaise,
        taxPaise,
        record.settled_at ? new Date(record.settled_at) : new Date(),
        record.utr || null,
        record.settlement_id || null,
        record.order_id || null,
        record.payment_id || null,
        record.batch_id || null,
        JSON.stringify(record.metadata || {}),
      ];
      const res = await postgres.query(sql, values);
      return res.rows[0];
    }

    // DEVELOPMENT FALLBACK
    const store = dataStore.getStore();
    const existingIdx = store.settlementRecords.findIndex(r => r.id === record.id);
    const normalized = {
      id: record.id,
      entity_id: record.entity_id || record.id,
      type: record.type || 'payment',
      debit_paise: debitPaise,
      credit_paise: creditPaise,
      debit: debitPaise,
      credit: creditPaise,
      amount_paise: amountPaise,
      fee_paise: feePaise,
      tax_paise: taxPaise,
      fee: feePaise,
      tax: taxPaise,
      settled_at: record.settled_at || new Date().toISOString(),
      utr: record.utr || null,
      settlement_id: record.settlement_id || null,
      order_id: record.order_id || null,
      payment_id: record.payment_id || null,
      batch_id: record.batch_id || null,
      metadata: record.metadata || {},
    };

    if (existingIdx >= 0) {
      store.settlementRecords[existingIdx] = normalized;
    } else {
      store.settlementRecords.push(normalized);
    }
    return normalized;
  }

  async findById(id) {
    if (postgres.isAvailable()) {
      const sql = 'SELECT * FROM settlements WHERE id = $1';
      const res = await postgres.query(sql, [id]);
      return res.rows[0] || null;
    }

    const store = dataStore.getStore();
    return store.settlementRecords.find(r => r.id === id) || null;
  }

  async findAll(filter = {}) {
    if (postgres.isAvailable()) {
      let sql = 'SELECT * FROM settlements WHERE 1=1';
      const values = [];
      if (filter.type) {
        values.push(filter.type);
        sql += ` AND type = $${values.length}`;
      }
      if (filter.order_id) {
        values.push(filter.order_id);
        sql += ` AND order_id = $${values.length}`;
      }
      sql += ' ORDER BY settled_at DESC';
      const res = await postgres.query(sql, values);
      return res.rows;
    }

    const store = dataStore.getStore();
    let res = store.settlementRecords;
    if (filter.type) res = res.filter(r => r.type === filter.type);
    if (filter.order_id) res = res.filter(r => r.order_id === filter.order_id);
    return res;
  }
}

module.exports = new SettlementRepository();
