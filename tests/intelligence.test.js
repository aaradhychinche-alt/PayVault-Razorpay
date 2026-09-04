'use strict';
/**
 * tests/intelligence.test.js
 *
 * Comprehensive Test Suite for Chunk 4: Investigation Intelligence.
 *
 * Covers:
 *  1. Cross-Transaction Pattern Detection (patternHistory.js)
 *  2. Repeated Merchant Issues & Trend Analysis (merchantPatterns.js)
 *  3. Deterministic Similar Case Retrieval (similarCases.js)
 *  4. Historical Exception Comparison (historicalComparison.js)
 *  5. Statistical & Deterministic Anomaly Detection (anomaly.js)
 *  6. Investigation Memory & Provenance Isolation (memory.js)
 *  7. Confidence Calibration (calibration.js)
 *  8. Investigation Intelligence Context Contract (context.js)
 *  9. End-to-End AI Engine Integration (engine.js)
 * 10. HTTP Route Endpoints (GET /api/investigations/:id/intelligence)
 * 11. Chunk 4 Acceptance Test
 */

const request = require('supertest');
const app     = require('../server');
const store   = require('../src/store/dataStore');
const { buildCase } = require('../src/investigation/caseBuilder');
const { detectPatternHistory }   = require('../src/investigation/intelligence/patternHistory');
const { analyzeMerchantPatterns } = require('../src/investigation/intelligence/merchantPatterns');
const { findSimilarCases }        = require('../src/investigation/intelligence/similarCases');
const { compareAgainstHistory }   = require('../src/investigation/intelligence/historicalComparison');
const { detectAnomalies }         = require('../src/investigation/intelligence/anomaly');
const { getConfirmedResolutions, getMemorySnapshot, MemoryProvenance } = require('../src/investigation/intelligence/memory');
const { calibrateConfidence }     = require('../src/investigation/intelligence/calibration');
const { buildIntelligenceContext } = require('../src/investigation/intelligence/context');
const { investigate }             = require('../src/investigation/ai/engine');

describe('Chunk 4 — Investigation Intelligence Suite', () => {

  beforeEach(() => {
    store.reset(); // Mode A: 79 records, 24 exceptions
  });

  describe('1. Cross-Transaction Pattern Detection (patternHistory.js)', () => {
    test('detects repeated category patterns across store exceptions', () => {
      const s = store.getStore();
      const exc = s.exceptions.find(e => e.category === 'FEE_TAX_VARIANCE');
      const rr = s.reconciliationResults.find(r => r.id === exc.reconciliation_result_id);
      const invCase = buildCase({ exception: exc, reconResult: rr, store: s });

      const patterns = detectPatternHistory(invCase, s);
      expect(Array.isArray(patterns)).toBe(true);
      expect(patterns.length).toBeGreaterThan(0);

      const catPattern = patterns.find(p => p.pattern_type === 'REPEATED_FEE_TAX_VARIANCE');
      expect(catPattern).toBeDefined();
      expect(catPattern.occurrence_count).toBeGreaterThanOrEqual(2);
      expect(catPattern.supporting_case_ids.length).toBe(catPattern.occurrence_count);
      expect(catPattern.supporting_case_ids).toContain(exc.id);
      expect(typeof catPattern.financial_impact_paise).toBe('number');
      expect(catPattern.financial_impact_paise).toBeGreaterThan(0);
    });

    test('does not report patterns when fewer than 2 occurrences exist', () => {
      const emptyStore = { exceptions: [], settlementRecords: [] };
      const dummyCase = {
        case_id: 'exc_test_01',
        exception_category: 'RARE_EXCEPTION_TYPE',
        amount_at_risk: 5000,
      };

      const patterns = detectPatternHistory(dummyCase, emptyStore);
      expect(patterns).toEqual([]);
    });

    test('detects repeated payment method clustering', () => {
      const s = store.getStore();
      const exc = s.exceptions[0];
      const rr = s.reconciliationResults.find(r => r.id === exc.reconciliation_result_id);
      const invCase = buildCase({ exception: exc, reconResult: rr, store: s });

      const patterns = detectPatternHistory(invCase, s);
      const methodPattern = patterns.find(p => p.pattern_type === 'REPEATED_PAYMENT_METHOD_ISSUE');
      if (methodPattern) {
        expect(methodPattern.occurrence_count).toBeGreaterThanOrEqual(2);
        expect(methodPattern.evidence_ids).toContain('ev_payment_method');
      }
    });

    test('detects amount clustering around similar ranges', () => {
      const s = store.getStore();
      const exc = s.exceptions[0];
      const rr = s.reconciliationResults.find(r => r.id === exc.reconciliation_result_id);
      const invCase = buildCase({ exception: exc, reconResult: rr, store: s });

      const patterns = detectPatternHistory(invCase, s);
      const amtPattern = patterns.find(p => p.pattern_type === 'REPEATED_AMOUNT_CLUSTERING');
      if (amtPattern) {
        expect(amtPattern.occurrence_count).toBeGreaterThanOrEqual(2);
        expect(amtPattern.description).toContain('±15%');
      }
    });
  });

  describe('2. Merchant Trends & Repeated Issues (merchantPatterns.js)', () => {
    test('returns INSUFFICIENT_HISTORY when store has fewer than 2 records', () => {
      const emptyStore = { exceptions: [] };
      const dummyCase = { case_id: 'exc_01', exception_category: 'FEE_TAX_VARIANCE' };

      const res = analyzeMerchantPatterns(dummyCase, emptyStore);
      expect(res.historical_signal).toBe('INSUFFICIENT_HISTORY');
      expect(res.merchant_patterns).toEqual([]);
    });

    test('detects merchant patterns on full store history', () => {
      const s = store.getStore();
      const exc = s.exceptions.find(e => e.category === 'TIMING_MISMATCH');
      const rr = s.reconciliationResults.find(r => r.id === exc.reconciliation_result_id);
      const invCase = buildCase({ exception: exc, reconResult: rr, store: s });

      const res = analyzeMerchantPatterns(invCase, s);
      expect(res.historical_signal).toBe('PATTERNS_DETECTED');
      expect(res.merchant_patterns.length).toBeGreaterThan(0);

      const catPattern = res.merchant_patterns.find(p => p.signal_type === 'REPEATED_MERCHANT_TIMING_MISMATCH');
      expect(catPattern).toBeDefined();
      expect(catPattern.occurrence_count).toBeGreaterThanOrEqual(2);
      expect(catPattern.claim).toContain('timing mismatch');
    });
  });

  describe('3. Deterministic Similar Case Retrieval (similarCases.js)', () => {
    test('retrieves structurally similar cases excluding current case', () => {
      const s = store.getStore();
      const exc = s.exceptions.find(e => e.category === 'FEE_TAX_VARIANCE');
      const rr = s.reconciliationResults.find(r => r.id === exc.reconciliation_result_id);
      const invCase = buildCase({ exception: exc, reconResult: rr, store: s });

      const similar = findSimilarCases(invCase, s, { limit: 5, threshold: 0.25 });
      expect(Array.isArray(similar)).toBe(true);
      expect(similar.length).toBeGreaterThan(0);

      // Must never include current case itself
      similar.forEach(sc => {
        expect(sc.case_id).not.toBe(invCase.case_id);
        expect(sc.similarity_score).toBeGreaterThanOrEqual(0.25);
        expect(Array.isArray(sc.matched_signals)).toBe(true);
        expect(sc.matched_signals.length).toBeGreaterThan(0);
      });

      // Top match should share same category
      expect(similar[0].category).toBe('FEE_TAX_VARIANCE');
      expect(similar[0].matched_signals).toContain('same_exception_category');
    });

    test('different exception categories receive lower similarity scores', () => {
      const s = store.getStore();
      const exc = s.exceptions.find(e => e.category === 'DUPLICATE');
      const rr = s.reconciliationResults.find(r => r.id === exc.reconciliation_result_id);
      const invCase = buildCase({ exception: exc, reconResult: rr, store: s });

      const similar = findSimilarCases(invCase, s, { limit: 10 });
      const sameCat = similar.filter(c => c.category === 'DUPLICATE');
      const diffCat = similar.filter(c => c.category !== 'DUPLICATE');

      if (sameCat.length > 0 && diffCat.length > 0) {
        expect(sameCat[0].similarity_score).toBeGreaterThan(diffCat[0].similarity_score);
      }
    });
  });

  describe('4. Historical Exception Comparison (historicalComparison.js)', () => {
    test('compares against retrieved cases and aggregates resolution history', () => {
      const s = store.getStore();
      const exc = s.exceptions.find(e => e.category === 'FEE_TAX_VARIANCE');
      const rr = s.reconciliationResults.find(r => r.id === exc.reconciliation_result_id);
      const invCase = buildCase({ exception: exc, reconResult: rr, store: s });

      // Before any human resolution
      const comparison1 = compareAgainstHistory(invCase, s);
      expect(comparison1.has_similar_cases).toBe(true);
      expect(comparison1.has_confirmed_precedent).toBe(false);
      expect(comparison1.is_definitive_truth).toBe(false);

      // Now human resolve a similar case
      const otherExc = s.exceptions.find(e => e.category === 'FEE_TAX_VARIANCE' && e.id !== exc.id);
      store.resolveCase(otherExc.id, {
        resolution_reason: 'MERCHANT_RECORD_CORRECTED',
        resolution_notes:  'Corrected fee ledger entry',
        resolved_by:       'lead_auditor',
      });

      const comparison2 = compareAgainstHistory(invCase, s);
      expect(comparison2.has_confirmed_precedent).toBe(true);
      expect(comparison2.confirmed_resolutions_count).toBeGreaterThanOrEqual(1);
      expect(comparison2.resolution_breakdown['MERCHANT_RECORD_CORRECTED']).toBeGreaterThanOrEqual(1);
      expect(comparison2.most_common_resolution_reason).toBe('MERCHANT_RECORD_CORRECTED');
      expect(comparison2.context_summary).toContain('merchant record corrected');
    });
  });

  describe('5. Anomaly Detection (anomaly.js)', () => {
    test('reports has_sufficient_history: false when records < 4', () => {
      const emptyStore = { settlementRecords: [] };
      const dummyCase = { case_id: 'exc_01', amount_at_risk: 1000 };

      const res = detectAnomalies(dummyCase, emptyStore);
      expect(res.has_sufficient_history).toBe(false);
      expect(res.anomalies).toEqual([]);
      expect(res.baseline_note).toContain('Insufficient historical transactions');
    });

    test('computes baseline statistics on full store and detects anomalies', () => {
      const s = store.getStore();
      const exc = s.exceptions[0];
      const rr = s.reconciliationResults.find(r => r.id === exc.reconciliation_result_id);
      const invCase = buildCase({ exception: exc, reconResult: rr, store: s });

      const res = detectAnomalies(invCase, s);
      expect(res.has_sufficient_history).toBe(true);
      expect(res.baseline_stats).toBeDefined();
      expect(res.baseline_stats.sample_size).toBeGreaterThan(0);
      expect(typeof res.baseline_stats.mean_amount_paise).toBe('number');
    });

    test('flags statistical outliers with expected range and deviation', () => {
      const s = store.getStore();
      // Fabricate an extreme outlier case with 50x mean
      const extremeCase = {
        case_id: 'exc_outlier',
        exception_category: 'FEE_TAX_VARIANCE',
        amount_at_risk: 500000,
        settlement_record: {
          entity_id: 'set_outlier',
          amount: 5000000, // ₹50,000 (mean is ~₹1,200)
          fee: 300000,     // 6% fee (normal is 2%)
          tax: 54000,
        },
        financial_analysis: {
          gross_amount: 5000000,
          fee_actual: 300000,
          fee_expected: 100000,
          tax_actual: 54000,
        },
      };

      const res = detectAnomalies(extremeCase, s);
      expect(res.has_sufficient_history).toBe(true);
      expect(res.anomalies.length).toBeGreaterThan(0);

      const amtAnom = res.anomalies.find(a => a.type === 'ANOMALOUS_SETTLEMENT_AMOUNT');
      expect(amtAnom).toBeDefined();
      expect(amtAnom.severity).toBe('CRITICAL');
      expect(amtAnom.observed_value).toBe(5000000);
      expect(amtAnom.deviation).toContain('above average');

      const feeAnom = res.anomalies.find(a => a.type === 'ANOMALOUS_FEE_VARIANCE');
      expect(feeAnom).toBeDefined();
    });
  });

  describe('6. Investigation Memory & Provenance (memory.js)', () => {
    test('distinguishes CONFIRMED_HUMAN_RESOLUTION from unresolved cases', () => {
      const s = store.getStore();
      const exc = s.exceptions[0];

      // Before resolution: 0 confirmed
      expect(getConfirmedResolutions(s).length).toBe(0);

      // Resolve 1 case with human justification
      store.resolveCase(exc.id, {
        resolution_reason: 'DUPLICATE_PAYMENT_CONFIRMED',
        resolution_notes:  'Confirmed duplicate credit from bank',
        resolved_by:       'senior_auditor',
      });

      const confirmed = getConfirmedResolutions(s);
      expect(confirmed.length).toBe(1);
      expect(confirmed[0].case_id).toBe(exc.id);
      expect(confirmed[0].provenance).toBe(MemoryProvenance.CONFIRMED_HUMAN_RESOLUTION);
      expect(confirmed[0].resolution_reason).toBe('DUPLICATE_PAYMENT_CONFIRMED');
      expect(confirmed[0].resolved_by).toBe('senior_auditor');
    });

    test('getMemorySnapshot retrieves category precedent matching current case', () => {
      const s = store.getStore();
      const exc1 = s.exceptions.filter(e => e.category === 'TIMING_MISMATCH')[0];
      const exc2 = s.exceptions.filter(e => e.category === 'TIMING_MISMATCH')[1];

      store.resolveCase(exc1.id, {
        resolution_reason: 'GATEWAY_ISSUE_CONFIRMED',
        resolution_notes:  'Gateway T+2 delay confirmed',
      });

      const rr2 = s.reconciliationResults.find(r => r.id === exc2.reconciliation_result_id);
      const invCase2 = buildCase({ exception: exc2, reconResult: rr2, store: s });

      const snapshot = getMemorySnapshot(invCase2, s);
      expect(snapshot.total_confirmed_resolutions).toBe(1);
      expect(snapshot.matching_category_precedents).toBe(1);
      expect(snapshot.dominant_historical_reason).toBe('GATEWAY_ISSUE_CONFIRMED');
      expect(snapshot.precedent_summary).toContain('GATEWAY_ISSUE_CONFIRMED');
    });
  });

  describe('7. Confidence Calibration (calibration.js)', () => {
    test('calibrates confidence upward when confirmed precedent matches', () => {
      const baseConfidence = { score: 65, level: 'MEDIUM', factors: [] };
      const memoryContext = {
        matching_category_precedents: 2,
        dominant_historical_reason: 'MERCHANT_RECORD_CORRECTED',
      };
      const historicalContext = {
        similar_previous_cases: [{ similarity_score: 0.85 }],
      };

      const calibrated = calibrateConfidence({
        baseConfidence,
        historicalContext,
        anomalyContext: { anomalies: [] },
        memoryContext,
        patterns: [{ type: 'REPEATED_FEE_VARIANCE' }],
        investigationCase: { case_id: 'exc_01' },
      });

      expect(calibrated.is_calibrated).toBe(true);
      expect(calibrated.score).toBeGreaterThan(baseConfidence.score);
      expect(calibrated.factors.some(f => f.name === 'Confirmed Historical Precedent')).toBe(true);
    });

    test('calibrates confidence downward when severe statistical anomalies exist', () => {
      const baseConfidence = { score: 70, level: 'MEDIUM', factors: [] };
      const anomalyContext = {
        anomalies: [
          { severity: 'CRITICAL', type: 'ANOMALOUS_SETTLEMENT_AMOUNT' },
          { severity: 'HIGH', type: 'ANOMALOUS_FEE_VARIANCE' },
        ],
      };

      const calibrated = calibrateConfidence({
        baseConfidence,
        historicalContext: { similar_previous_cases: [] },
        anomalyContext,
        memoryContext: { matching_category_precedents: 0 },
        patterns: [],
        investigationCase: { case_id: 'exc_01' },
      });

      expect(calibrated.score).toBeLessThan(baseConfidence.score);
      expect(calibrated.factors.some(f => f.name === 'Statistical Anomaly Variance')).toBe(true);
    });
  });

  describe('8. Intelligence Context Contract (context.js)', () => {
    test('builds fully deterministic intelligence context contract', () => {
      const s = store.getStore();
      const exc = s.exceptions[0];
      const rr = s.reconciliationResults.find(r => r.id === exc.reconciliation_result_id);
      const invCase = buildCase({ exception: exc, reconResult: rr, store: s });

      const ctx = buildIntelligenceContext({ investigationCase: invCase, store: s });

      expect(ctx).toBeDefined();
      expect(ctx.case_id).toBe(exc.id);
      expect(ctx.current_case).toBeDefined();
      expect(ctx.historical_context).toBeDefined();
      expect(Array.isArray(ctx.historical_context.similar_cases)).toBe(true);
      expect(Array.isArray(ctx.historical_context.repeated_patterns)).toBe(true);
      expect(ctx.anomaly_context).toBeDefined();
      expect(ctx.memory_context).toBeDefined();
      expect(ctx.intelligence_metadata).toBeDefined();
      expect(ctx.intelligence_metadata.history_available).toBe(true);
    });
  });

  describe('9. End-to-End AI Engine Integration', () => {
    test('investigates exception producing unified output with intelligence context', async () => {
      const s = store.getStore();
      const exc = s.exceptions[0];
      const rr = s.reconciliationResults.find(r => r.id === exc.reconciliation_result_id);
      const invCase = buildCase({ exception: exc, reconResult: rr, store: s });

      const report = await investigate(invCase);

      expect(report).toBeDefined();
      expect(report.case_id).toBe(exc.id);
      expect(report.intelligence_context).toBeDefined();
      expect(report.intelligence_context.historical_context).toBeDefined();
      expect(report.intelligence_context.anomaly_context).toBeDefined();
      expect(report.root_cause.confidence.score).toBeGreaterThan(0);
      expect(report._diagnostics.history_available).toBe(true);
    });
  });

  describe('10. HTTP Route Endpoints (Chunk 4)', () => {
    test('GET /api/investigations/:id includes intelligence_context', async () => {
      const res = await request(app).get('/api/investigations/exc_000001');
      expect(res.status).toBe(200);
      expect(res.body.case_id).toBe('exc_000001');
      expect(res.body.intelligence_context).toBeDefined();
      expect(res.body.intelligence_context.historical_context).toBeDefined();
    });

    test('GET /api/investigations/:id/intelligence returns standalone intelligence contract', async () => {
      const res = await request(app).get('/api/investigations/exc_000001/intelligence');
      expect(res.status).toBe(200);
      expect(res.body.case_id).toBe('exc_000001');
      expect(res.body.current_case).toBeDefined();
      expect(res.body.historical_context).toBeDefined();
      expect(res.body.anomaly_context).toBeDefined();
      expect(res.body.memory_context).toBeDefined();
      expect(res.body.intelligence_metadata).toBeDefined();
    });

    test('GET /api/investigations/non_existent/intelligence returns 404', async () => {
      const res = await request(app).get('/api/investigations/exc_999999/intelligence');
      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });
  });

  describe('11. Chunk 4 Acceptance Test', () => {
    test('multi-case precedent scenario: matching historical resolutions serve as supporting evidence', async () => {
      const s = store.getStore();

      // Setup Acceptance Scenario:
      // Case 1: FEE_TAX_VARIANCE -> resolved as MERCHANT_RECORD_CORRECTED
      // Case 2: FEE_TAX_VARIANCE -> resolved as MERCHANT_RECORD_CORRECTED
      // Case 3: TIMING_MISMATCH   -> resolved as GATEWAY_ISSUE_CONFIRMED
      const feeCases = s.exceptions.filter(e => e.category === 'FEE_TAX_VARIANCE');
      const timingCases = s.exceptions.filter(e => e.category === 'TIMING_MISMATCH');

      expect(feeCases.length).toBeGreaterThanOrEqual(3);

      const case1 = feeCases[0];
      const case2 = feeCases[1];
      const targetFeeCase = feeCases[2];
      const timingCase = timingCases[0];

      // Human resolve Case 1 & Case 2
      store.resolveCase(case1.id, {
        resolution_reason: 'MERCHANT_RECORD_CORRECTED',
        resolution_notes:  'Updated ERP fee schedule table',
        resolved_by:       'auditor_alice',
      });
      store.resolveCase(case2.id, {
        resolution_reason: 'MERCHANT_RECORD_CORRECTED',
        resolution_notes:  'Corrected ledger debit percentage',
        resolved_by:       'auditor_bob',
      });

      // Human resolve timing case with different reason
      store.resolveCase(timingCase.id, {
        resolution_reason: 'GATEWAY_ISSUE_CONFIRMED',
        resolution_notes:  'Bank holiday T+2 batch timing shift',
        resolved_by:       'auditor_carol',
      });

      // Now investigate target FEE_TAX_VARIANCE case
      const targetRr = s.reconciliationResults.find(r => r.id === targetFeeCase.reconciliation_result_id);
      const invTargetCase = buildCase({ exception: targetFeeCase, reconResult: targetRr, store: s });

      const targetReport = await investigate(invTargetCase);

      // Verify:
      // 1. Payvault identifies previous similar cases
      expect(targetReport.intelligence_context.historical_context.similar_cases.length).toBeGreaterThan(0);

      // 2. Resembles Case 1 & Case 2
      const similarIds = targetReport.intelligence_context.historical_context.similar_cases.map(c => c.case_id);
      expect(similarIds).toContain(case1.id);
      expect(similarIds).toContain(case2.id);

      // 3. Both previous cases had confirmed resolution MERCHANT_RECORD_CORRECTED
      const memory = targetReport.intelligence_context.memory_context;
      expect(memory.matching_category_precedents).toBeGreaterThanOrEqual(2);
      expect(memory.dominant_historical_reason).toBe('MERCHANT_RECORD_CORRECTED');

      // 4. Historical cases do NOT automatically resolve target case (it remains in review / human decides)
      const targetLifecycle = store.getCaseLifecycle(targetFeeCase.id);
      expect(targetLifecycle.status).not.toBe('RESOLVED');

      // 5. Investigate a completely different category (e.g. MISSING_ORDER)
      const missingOrderCase = s.exceptions.find(e => e.category === 'MISSING_ORDER');
      const missingOrderRr = s.reconciliationResults.find(r => r.id === missingOrderCase.reconciliation_result_id);
      const invMissingCase = buildCase({ exception: missingOrderCase, reconResult: missingOrderRr, store: s });

      const missingReport = await investigate(invMissingCase);

      // Must NOT claim FEE_TAX_VARIANCE precedent for MISSING_ORDER
      const missingMemory = missingReport.intelligence_context.memory_context;
      expect(missingMemory.matching_category_precedents).toBe(0);
      expect(missingMemory.dominant_historical_reason).toBeNull();
    }, 30000);
  });

});
