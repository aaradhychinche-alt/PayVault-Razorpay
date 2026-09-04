'use strict';
/**
 * src/db/repositories/paymentRepository.js
 *
 * Repository for Payment persistence.
 *
 * All amounts must be non-negative integers (paise).
 * Rejects float monetary values.
 */

const postgres = require('../postgres');
const dataStore = require('../../store/dataStore');

class PaymentRepository {
  /**
   * Validate that amount is an integer paise.
   */
  validatePaise(amount) {
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0) {
      throw new Error(`Invalid monetary amount_paise: expected non-negative integer paise, got ${amount}`);
    }
  }

  async save(payment) {
    this.validatePaise(payment.amount_paise || payment.amount);

    const amountPaise = payment.amount_paise || payment.amount;

    if (postgres.isAvailable()) {
      const sql = `
        INSERT INTO payments (id, order_id, amount_paise, currency, status, method, bank, created_at, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO UPDATE SET
          order_id = EXCLUDED.order_id,
          amount_paise = EXCLUDED.amount_paise,
          status = EXCLUDED.status,
          method = EXCLUDED.method,
          bank = EXCLUDED.bank,
          metadata = EXCLUDED.metadata
        RETURNING *;
      `;
      const values = [
        payment.id,
        payment.order_id || null,
        amountPaise,
        payment.currency || 'INR',
        payment.status || 'captured',
        payment.method || null,
        payment.bank || null,
        payment.created_at ? new Date(payment.created_at) : new Date(),
        JSON.stringify(payment.metadata || {}),
      ];
      const res = await postgres.query(sql, values);
      return res.rows[0];
    }

    // DEVELOPMENT FALLBACK
    const store = dataStore.getStore();
    const existingIdx = store.payments.findIndex(p => p.id === payment.id);
    const normalized = {
      id: payment.id,
      order_id: payment.order_id || null,
      amount_paise: amountPaise,
      amount: amountPaise,
      currency: payment.currency || 'INR',
      status: payment.status || 'captured',
      method: payment.method || null,
      bank: payment.bank || null,
      created_at: payment.created_at || new Date().toISOString(),
      metadata: payment.metadata || {},
    };

    if (existingIdx >= 0) {
      store.payments[existingIdx] = normalized;
    } else {
      store.payments.push(normalized);
    }
    return normalized;
  }

  async findById(id) {
    if (postgres.isAvailable()) {
      const sql = 'SELECT * FROM payments WHERE id = $1';
      const res = await postgres.query(sql, [id]);
      return res.rows[0] || null;
    }

    const store = dataStore.getStore();
    return store.payments.find(p => p.id === id) || null;
  }

  async findAll(filter = {}) {
    if (postgres.isAvailable()) {
      let sql = 'SELECT * FROM payments WHERE 1=1';
      const values = [];
      if (filter.order_id) {
        values.push(filter.order_id);
        sql += ` AND order_id = $${values.length}`;
      }
      if (filter.status) {
        values.push(filter.status);
        sql += ` AND status = $${values.length}`;
      }
      sql += ' ORDER BY created_at DESC';
      const res = await postgres.query(sql, values);
      return res.rows;
    }

    const store = dataStore.getStore();
    let res = store.payments;
    if (filter.order_id) res = res.filter(p => p.order_id === filter.order_id);
    if (filter.status) res = res.filter(p => p.status === filter.status);
    return res;
  }
}

module.exports = new PaymentRepository();
