'use strict';
/**
 * src/engine/config.js
 *
 * Centralised configuration for the reconciliation engine.
 * All financial tolerances, fee rates, and timing windows are defined here.
 * No magic numbers should be scattered through the codebase.
 */

module.exports = {
  // ── Fee / Tax rates (Razorpay standard) ─────────────────────────────────
  /** Platform fee as a decimal fraction (2 %) */
  PLATFORM_FEE_RATE: 0.02,

  /** GST levied on platform fee as a decimal fraction (18 %) */
  GST_RATE: 0.18,

  // ── Matching tolerances (in paise) ──────────────────────────────────────
  /** Maximum absolute deviation in net amount considered an exact match */
  AMOUNT_TOLERANCE_PAISE: 2,

  /** Maximum absolute deviation in fee/tax considered within tolerance */
  FEE_TAX_TOLERANCE_PAISE: 100,

  // ── Timing windows ──────────────────────────────────────────────────────
  /** Days after payment creation after which MISSING_PAYMENT is declared */
  MISSING_PAYMENT_CUTOFF_DAYS: 3,

  /** Seconds per day (convenience) */
  SECONDS_PER_DAY: 86400,

  // ── Duplicate detection ──────────────────────────────────────────────────
  /**
   * Two records are considered potential duplicates if they share the same
   * (order_id, amount) and their created_at values differ by less than this.
   */
  DUPLICATE_WINDOW_SECONDS: 300,

  // ── Demo dataset size ─────────────────────────────────────────────────────
  MERCHANT_ORDER_COUNT: 64,
  SETTLEMENT_BATCH_COUNT: 4,
};
