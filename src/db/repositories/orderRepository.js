'use strict';
/**
 * src/db/repositories/orderRepository.js
 *
 * Repository for Merchant Order persistence.
 * All monetary amounts are strictly integer paise.
 */

const postgres = require('../postgres');
const dataStore = require('../../store/dataStore');

class OrderRepository {
  validatePaise(amount) {
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0) {
      throw new Error(`Invalid monetary amount_paise: expected non-negative integer paise, got ${amount}`);
    }
  }

  async save(order) {
    this.validatePaise(order.amount_paise || order.amount);

    const amountPaise = order.amount_paise || order.amount;

    if (postgres.isAvailable()) {
      const sql = `
        INSERT INTO orders (id, merchant_id, customer_id, amount_paise, currency, status, created_at, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO UPDATE SET
          amount_paise = EXCLUDED.amount_paise,
          status = EXCLUDED.status,
          metadata = EXCLUDED.metadata
        RETURNING *;
      `;
      const values = [
        order.id,
        order.merchant_id || null,
        order.customer_id || null,
        amountPaise,
        order.currency || 'INR',
        order.status || 'paid',
        order.created_at ? new Date(order.created_at) : new Date(),
        JSON.stringify(order.metadata || {}),
      ];
      const res = await postgres.query(sql, values);
      return res.rows[0];
    }

    // DEVELOPMENT FALLBACK
    const store = dataStore.getStore();
    const existingIdx = store.merchantOrders.findIndex(o => o.id === order.id);
    const normalized = {
      id: order.id,
      merchant_id: order.merchant_id || null,
      customer_id: order.customer_id || null,
      amount_paise: amountPaise,
      amount: amountPaise,
      currency: order.currency || 'INR',
      status: order.status || 'paid',
      created_at: order.created_at || new Date().toISOString(),
      metadata: order.metadata || {},
    };

    if (existingIdx >= 0) {
      store.merchantOrders[existingIdx] = normalized;
    } else {
      store.merchantOrders.push(normalized);
    }
    return normalized;
  }

  async findById(id) {
    if (postgres.isAvailable()) {
      const sql = 'SELECT * FROM orders WHERE id = $1';
      const res = await postgres.query(sql, [id]);
      return res.rows[0] || null;
    }

    const store = dataStore.getStore();
    return store.merchantOrders.find(o => o.id === id) || null;
  }

  async findAll() {
    if (postgres.isAvailable()) {
      const sql = 'SELECT * FROM orders ORDER BY created_at DESC';
      const res = await postgres.query(sql);
      return res.rows;
    }

    const store = dataStore.getStore();
    return store.merchantOrders;
  }
}

module.exports = new OrderRepository();
