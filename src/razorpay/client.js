'use strict';
/**
 * src/razorpay/client.js
 *
 * Server-side Razorpay SDK client initialization.
 * Credentials are read exclusively from process.env and NEVER exposed to frontend.
 */

const Razorpay = require('razorpay');

let _client = null;

/**
 * Get or create the server-side Razorpay client instance.
 * @returns {Razorpay}
 */
function getRazorpayClient() {
  if (_client) return _client;

  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;

  if (!key_id || !key_secret) {
    throw new Error('Razorpay credentials missing: RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is not set in environment.');
  }

  _client = new Razorpay({ key_id, key_secret });
  return _client;
}

module.exports = { getRazorpayClient };
