'use strict';
/**
 * src/investigation/intelligence/anomaly.js
 *
 * Deterministic & Statistical Anomaly Detection Module (Chunk 4).
 *
 * Evaluates whether an exception case exhibits statistical or structural
 * anomalies relative to the store's historical transaction distribution.
 *
 * RULES:
 * - Deterministic/statistical methods only (mean, standard deviation, ratios).
 * - If insufficient baseline records exist (< 4 records), explicitly reports that.
 * - All monetary calculations use integer paise.
 */

/**
 * Detect statistical and deterministic anomalies for an investigation case.
 *
 * @param {Object} investigationCase - Current case built by caseBuilder
 * @param {Object} store             - Complete dataStore state
 * @returns {Object} Anomaly detection results
 */
function detectAnomalies(investigationCase, store) {
  const settlementRecords = store?.settlementRecords || [];

  if (settlementRecords.length < 4) {
    return {
      has_sufficient_history: false,
      anomalies:              [],
      baseline_note:          'Insufficient historical transactions (< 4 settlement records) to compute baseline statistical distributions.',
      baseline_stats:         null,
    };
  }

  const anomalies = [];
  let seq = 0;

  function makeId(type) {
    return `anom_${type.toLowerCase()}_${String(++seq).padStart(3, '0')}`;
  }

  // ── Baseline Statistics Computation ─────────────────────────────────────────
  const paymentRecords = settlementRecords.filter(r => r.type === 'payment' && typeof r.amount === 'number');
  const amounts = paymentRecords.map(r => r.amount);

  let meanAmount = 0;
  let stdDevAmount = 0;

  if (amounts.length >= 4) {
    const sum = amounts.reduce((a, b) => a + b, 0);
    meanAmount = Math.round(sum / amounts.length);
    const variance = amounts.reduce((acc, val) => acc + Math.pow(val - meanAmount, 2), 0) / amounts.length;
    stdDevAmount = Math.round(Math.sqrt(variance));
  }

  const baselineStats = {
    sample_size:      amounts.length,
    mean_amount_paise: meanAmount,
    std_dev_paise:    stdDevAmount,
  };

  const sr = investigationCase.settlement_record;
  const fa = investigationCase.financial_analysis;
  const currentAmount = investigationCase.amount_at_risk || sr?.amount || 0;

  // ── 1. Settlement Amount Outlier ───────────────────────────────────────────
  if (sr && sr.amount && stdDevAmount > 0) {
    const zScore = (sr.amount - meanAmount) / stdDevAmount;
    if (zScore >= 2.5) {
      const severity = zScore >= 4.0 ? 'CRITICAL' : 'HIGH';
      const pctAbove = Math.round(((sr.amount - meanAmount) / meanAmount) * 100);

      anomalies.push({
        anomaly_id:     makeId('SETTLEMENT_AMOUNT_OUTLIER'),
        type:           'ANOMALOUS_SETTLEMENT_AMOUNT',
        severity,
        observed_value: sr.amount,
        expected_range: {
          min:  Math.max(0, meanAmount - 2 * stdDevAmount),
          max:  meanAmount + 2 * stdDevAmount,
          unit: 'paise',
        },
        deviation:      `+${pctAbove}% above average transaction amount (z-score: ${zScore.toFixed(2)})`,
        evidence_ids:   ['ev_settlement_record_amount'],
        description:    `Settlement amount of ₹${(sr.amount / 100).toFixed(2)} is an extreme statistical outlier compared to merchant baseline ₹${(meanAmount / 100).toFixed(2)}.`,
      });
    }
  }

  // ── 2. Fee Variance Anomaly ────────────────────────────────────────────────
  if (fa && fa.fee_actual && fa.gross_amount && fa.gross_amount > 0) {
    const feeRatio = fa.fee_actual / fa.gross_amount;
    const feeVariance = Math.abs(fa.fee_actual - fa.fee_expected);

    // Standard fee is ~2.0%. Flag if fee ratio > 3.0% or fee variance >= ₹10.00
    if (feeRatio > 0.03 || feeVariance >= 1000) {
      const deviationPct = Math.round(((feeRatio - 0.02) / 0.02) * 100);
      anomalies.push({
        anomaly_id:     makeId('FEE_VARIANCE_OUTLIER'),
        type:           'ANOMALOUS_FEE_VARIANCE',
        severity:       feeRatio > 0.05 ? 'HIGH' : 'MEDIUM',
        observed_value: fa.fee_actual,
        expected_range: {
          min:  fa.fee_expected,
          max:  fa.fee_expected,
          unit: 'paise',
        },
        deviation:      `+${deviationPct}% deviation from 2.0% platform fee schedule`,
        evidence_ids:   ['ev_fee_actual', 'ev_fee_expected'],
        description:    `Gateway fee of ₹${(fa.fee_actual / 100).toFixed(2)} represents ${(feeRatio * 100).toFixed(2)}% of gross, exceeding standard 2.0% schedule.`,
      });
    }
  }

  // ── 3. GST Tax Calculation Anomaly ─────────────────────────────────────────
  if (fa && fa.tax_actual && fa.fee_actual && fa.fee_actual > 0) {
    const taxRatio = fa.tax_actual / fa.fee_actual;
    // Standard GST is 18%. Flag if > 25% or < 12%
    if (taxRatio > 0.25 || taxRatio < 0.12) {
      const deviationPct = Math.round(((taxRatio - 0.18) / 0.18) * 100);
      anomalies.push({
        anomaly_id:     makeId('TAX_CALCULATION_ANOMALY'),
        type:           'ANOMALOUS_TAX_CALCULATION',
        severity:       'MEDIUM',
        observed_value: fa.tax_actual,
        expected_range: {
          min:  Math.round(fa.fee_actual * 0.18),
          max:  Math.round(fa.fee_actual * 0.18),
          unit: 'paise',
        },
        deviation:      `${deviationPct >= 0 ? '+' : ''}${deviationPct}% deviation from 18% GST baseline`,
        evidence_ids:   ['ev_tax_actual', 'ev_tax_expected'],
        description:    `GST tax of ₹${(fa.tax_actual / 100).toFixed(2)} on platform fee differs from standard 18% GST computation.`,
      });
    }
  }

  // ── 4. Timing Window Anomaly (Cross-batch delays > 4 days) ──────────────────
  if (investigationCase.timeline && investigationCase.timeline.length >= 2) {
    const events = investigationCase.timeline;
    const firstEvent = events[0];
    const lastEvent = events[events.length - 1];

    if (firstEvent.timestamp && lastEvent.timestamp) {
      const firstTs = firstEvent.timestamp < 1e11 ? firstEvent.timestamp * 1000 : firstEvent.timestamp;
      const lastTs  = lastEvent.timestamp < 1e11 ? lastEvent.timestamp * 1000 : lastEvent.timestamp;
      const deltaSec = Math.abs(lastTs - firstTs) / 1000;

      if (deltaSec > 345600) { // > 4 days (345,600s)
        const days = (deltaSec / 86400).toFixed(1);
        anomalies.push({
          anomaly_id:     makeId('TIMING_DELAY_OUTLIER'),
          type:           'ANOMALOUS_TIMING_DELAY',
          severity:       deltaSec > 604800 ? 'HIGH' : 'MEDIUM',
          observed_value: `${days} days`,
          expected_range: {
            min:  1,
            max:  3,
            unit: 'days (T+2 cycle)',
          },
          deviation:      `${days} days between lifecycle events (expected: 2 days)`,
          evidence_ids:   ['ev_timeline_events'],
          description:    `Settlement reconciliation lifecycle spanned ${days} days, exceeding the normal T+2 settlement window.`,
        });
      }
    }
  }

  // ── 5. High-Value Exposure Anomaly ──────────────────────────────────────────
  if (currentAmount >= 50000 && (investigationCase.exception_category === 'DUPLICATE' || investigationCase.exception_category === 'UNEXPLAINED')) {
    anomalies.push({
      anomaly_id:     makeId('HIGH_EXPOSURE_ANOMALY'),
      type:           'ANOMALOUS_HIGH_VALUE_EXPOSURE',
      severity:       currentAmount >= 100000 ? 'CRITICAL' : 'HIGH',
      observed_value: currentAmount,
      expected_range: {
        min:  0,
        max:  25000,
        unit: 'paise',
      },
      deviation:      `High-risk anomaly involving ₹${(currentAmount / 100).toFixed(2)} exposure`,
      evidence_ids:   ['ev_amount_at_risk'],
      description:    `Exception carries an unusually large financial exposure of ₹${(currentAmount / 100).toFixed(2)}.`,
    });
  }

  return {
    has_sufficient_history: true,
    anomalies,
    baseline_note:          `Computed from ${paymentRecords.length} historical payment transactions.`,
    baseline_stats:         baselineStats,
  };
}

module.exports = {
  detectAnomalies,
};
