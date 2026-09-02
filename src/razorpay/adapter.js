'use strict';
/**
 * src/razorpay/adapter.js
 *
 * Data adapter to fetch and normalize real Razorpay Test Mode transactions.
 * Normalizes live/test mode SDK responses into clean internal representations
 * with integer paise amounts.
 *
 * Server-side only. Never exposes secrets or raw credentials.
 */

const { getRazorpayClient } = require('./client');

/**
 * Normalize a Razorpay Order object.
 */
function normalizeOrder(order) {
  return {
    id: order.id,
    amount: Math.round(Number(order.amount)),
    currency: order.currency || 'INR',
    receipt: order.receipt || null,
    status: order.status || 'created',
    created_at: Number(order.created_at),
    notes: order.notes && typeof order.notes === 'object' ? order.notes : null,
  };
}

/**
 * Normalize a Razorpay Payment object.
 */
function normalizePayment(payment) {
  return {
    id: payment.id,
    order_id: payment.order_id || null,
    amount: Math.round(Number(payment.amount)),
    currency: payment.currency || 'INR',
    status: payment.status || 'captured',
    method: payment.method || null,
    card_network: payment.card ? payment.card.network || null : null,
    card_issuer: payment.card ? payment.card.issuer || null : null,
    card_type: payment.card ? payment.card.type || null : null,
    fee: payment.fee != null ? Math.round(Number(payment.fee)) : null,
    tax: payment.tax != null ? Math.round(Number(payment.tax)) : null,
    created_at: Number(payment.created_at),
    notes: payment.notes && typeof payment.notes === 'object' ? payment.notes : null,
    description: payment.description || null,
    email: payment.email || null,
    contact: payment.contact || null,
  };
}

/**
 * Normalize a Razorpay Refund object.
 */
function normalizeRefund(refund) {
  return {
    id: refund.id,
    payment_id: refund.payment_id,
    amount: Math.round(Number(refund.amount)),
    currency: refund.currency || 'INR',
    status: refund.status || 'processed',
    created_at: Number(refund.created_at),
    notes: refund.notes && typeof refund.notes === 'object' ? refund.notes : null,
  };
}

/**
 * Fetch orders from Razorpay API.
 * @param {Object} [options]
 * @param {Razorpay} [client] - Optional client override for testing
 * @returns {Promise<Array>}
 */
async function fetchOrders(options = {}, client = null) {
  const rzp = client || getRazorpayClient();
  const count = options.count || 100;
  const res = await rzp.orders.all({ count, ...options });
  const items = res.items || [];
  return items.map(normalizeOrder);
}

/**
 * Fetch payments from Razorpay API.
 * @param {Object} [options]
 * @param {Razorpay} [client] - Optional client override for testing
 * @returns {Promise<Array>}
 */
async function fetchPayments(options = {}, client = null) {
  const rzp = client || getRazorpayClient();
  const count = options.count || 100;
  const res = await rzp.payments.all({ count, ...options });
  const items = res.items || [];
  return items.map(normalizePayment);
}

/**
 * Fetch refunds from Razorpay API.
 * @param {Object} [options]
 * @param {Razorpay} [client] - Optional client override for testing
 * @returns {Promise<Array>}
 */
async function fetchRefunds(options = {}, client = null) {
  const rzp = client || getRazorpayClient();
  const count = options.count || 100;
  const res = await rzp.refunds.all({ count, ...options });
  const items = res.items || [];
  return items.map(normalizeRefund);
}

/**
 * Fetch all available orders, payments, and refunds from Razorpay Test Mode.
 * @param {Razorpay} [client] - Optional client override for testing
 * @returns {Promise<{ orders: Array, payments: Array, refunds: Array }>}
 */
async function fetchAllTransactions(client = null) {
  const [orders, payments, refunds] = await Promise.all([
    fetchOrders({ count: 100 }, client),
    fetchPayments({ count: 100 }, client),
    fetchRefunds({ count: 100 }, client),
  ]);

  return { orders, payments, refunds };
}

module.exports = {
  fetchOrders,
  fetchPayments,
  fetchRefunds,
  fetchAllTransactions,
  normalizeOrder,
  normalizePayment,
  normalizeRefund,
};
