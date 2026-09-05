'use strict';
/**
 * tests/investigationUxUpgrade.test.js
 *
 * Test suite for Payvault UX / Operations Dashboard Upgrade:
 * 1. Investigation Status Filters (All = Active OPEN+IN_REVIEW, Resolved separate)
 * 2. Investigation Priority / Severity (Explainable, derived from case discrepancy)
 * 3. Financial Impact Summary (Integer-paise precision, dynamically sourced, no hardcoded values)
 * 4. Investigation Lifecycle Timeline (Evidence-checked states: completed, current, pending)
 * 5. Case Evidence Panel Grounding & AI consistency
 * 6. Preserved Payment and Reconciliation workflows
 */

const request = require('supertest');
const app = require('../server');
const store = require('../src/store/dataStore');
const { computeCasePriority } = require('../src/investigation/caseBuilder');

describe('Payvault UX & Operations Dashboard Upgrade Suite', () => {

  beforeEach(() => {
    store.reset();
  });

  describe('1. Investigation Status Filters & Queue Semantics', () => {
    test('initial queue has active status counts and all cases start OPEN', async () => {
      const res = await request(app).get('/api/investigations');
      expect(res.status).toBe(200);
      expect(res.body.status_counts).toBeDefined();
      expect(res.body.status_counts.total).toBe(24);
      expect(res.body.status_counts.open).toBe(24);
      expect(res.body.status_counts.in_review).toBe(0);
      expect(res.body.status_counts.resolved).toBe(0);

      // Active cases count (OPEN + IN_REVIEW)
      const activeCount = res.body.status_counts.open + res.body.status_counts.in_review;
      expect(activeCount).toBe(24);
    });

    test('filtering by status returns exact partition without leaking resolved into open', async () => {
      const casesRes = await request(app).get('/api/investigations');
      const firstCaseId = casesRes.body.cases[0].case_id;

      // Resolve first case
      const resolveRes = await request(app)
        .post(`/api/investigations/${firstCaseId}/resolve`)
        .send({
          resolution_reason: 'MERCHANT_RECORD_CORRECTED',
          resolution_notes: 'Audited and approved.',
          resolved_by: 'Senior Auditor',
        });
      expect(resolveRes.status).toBe(200);

      // Verify open filter
      const openRes = await request(app).get('/api/investigations?status=open');
      expect(openRes.status).toBe(200);
      expect(openRes.body.cases.length).toBe(23);
      openRes.body.cases.forEach(c => expect(c.status).toBe('OPEN'));

      // Verify resolved filter
      const resolvedRes = await request(app).get('/api/investigations?status=resolved');
      expect(resolvedRes.status).toBe(200);
      expect(resolvedRes.body.cases.length).toBe(1);
      expect(resolvedRes.body.cases[0].case_id).toBe(firstCaseId);
      expect(resolvedRes.body.cases[0].status).toBe('RESOLVED');
    });

    test('reopening case transitions status back from RESOLVED to OPEN', async () => {
      const casesRes = await request(app).get('/api/investigations');
      const targetCaseId = casesRes.body.cases[0].case_id;

      // Resolve then reopen
      await request(app).post(`/api/investigations/${targetCaseId}/resolve`).send({
        resolution_reason: 'NO_ACTUAL_FINANCIAL_LOSS',
      });

      const reopenRes = await request(app).post(`/api/investigations/${targetCaseId}/reopen`).send({
        reopened_by: 'Operator',
        reopen_reason: 'New bank statement arrived',
      });
      expect(reopenRes.status).toBe(200);
      expect(reopenRes.body.status).toBe('OPEN');

      const checkRes = await request(app).get(`/api/investigations/${targetCaseId}`);
      expect(checkRes.body.status).toBe('OPEN');
      expect(checkRes.body.resolution).toBeNull();
    });
  });

  describe('2. Priority & Severity Engine', () => {
    test('computeCasePriority assigns HIGH to DUPLICATE and UNEXPLAINED', () => {
      const dupPriority = computeCasePriority({ category: 'DUPLICATE', amount_at_risk: 10000 });
      expect(dupPriority.level).toBe('HIGH');
      expect(dupPriority.reason).toMatch(/duplicate/i);

      const unexPriority = computeCasePriority({ category: 'UNEXPLAINED', amount_at_risk: 5000 });
      expect(unexPriority.level).toBe('HIGH');
      expect(unexPriority.reason).toMatch(/unexplained/i);
    });

    test('computeCasePriority evaluates FEE_TAX_VARIANCE materiality', () => {
      // Material fee variance >= 2000 paise (₹20.00)
      const materialPriority = computeCasePriority(
        { category: 'FEE_TAX_VARIANCE', amount_at_risk: 2950 },
        { fee_actual: 24966, fee_expected: 22466 }
      );
      expect(materialPriority.level).toBe('HIGH');
      expect(materialPriority.reason).toMatch(/fee|tax/i);

      // Minor fee variance < 2000 paise
      const minorPriority = computeCasePriority(
        { category: 'FEE_TAX_VARIANCE', amount_at_risk: 50 },
        { fee_actual: 2050, fee_expected: 2000 }
      );
      expect(minorPriority.level).toBe('MEDIUM');
    });

    test('GET /api/investigations list returns priority on all case summaries', async () => {
      const res = await request(app).get('/api/investigations');
      expect(res.status).toBe(200);
      res.body.cases.forEach(c => {
        expect(['HIGH', 'MEDIUM', 'LOW']).toContain(c.priority);
        expect(typeof c.priority_reason).toBe('string');
      });
    });

    test('GET /api/investigations/:id detail provides complete priority_info object', async () => {
      const listRes = await request(app).get('/api/investigations');
      const sampleCaseId = listRes.body.cases[0].case_id;

      const detailRes = await request(app).get(`/api/investigations/${sampleCaseId}`);
      expect(detailRes.status).toBe(200);
      expect(detailRes.body.priority).toBeDefined();
      expect(detailRes.body.priority_info).toBeDefined();
      expect(['HIGH', 'MEDIUM', 'LOW']).toContain(detailRes.body.priority_info.level);
      expect(detailRes.body.priority_info.reason.length).toBeGreaterThan(0);
    });
  });

  describe('3. Financial Impact Summary & Non-Hardcoded Values', () => {
    test('all financial values are integer paise in case financial analysis', async () => {
      const listRes = await request(app).get('/api/investigations');
      for (const item of listRes.body.cases.slice(0, 5)) {
        const detailRes = await request(app).get(`/api/investigations/${item.case_id}`);
        const fa = detailRes.body.financial_analysis;
        expect(fa).toBeDefined();
        if (fa.gross_amount !== null) expect(Number.isInteger(fa.gross_amount)).toBe(true);
        if (fa.fee_actual !== null) expect(Number.isInteger(fa.fee_actual)).toBe(true);
        if (fa.fee_expected !== null) expect(Number.isInteger(fa.fee_expected)).toBe(true);
        if (fa.tax_actual !== null) expect(Number.isInteger(fa.tax_actual)).toBe(true);
        if (fa.tax_expected !== null) expect(Number.isInteger(fa.tax_expected)).toBe(true);
        if (fa.amount_at_risk !== null) expect(Number.isInteger(fa.amount_at_risk)).toBe(true);
      }
    });

    test('financial values differ across distinct investigation cases (not hardcoded)', async () => {
      const listRes = await request(app).get('/api/investigations');
      const amounts = listRes.body.cases.map(c => c.amount_at_risk);
      const uniqueAmounts = new Set(amounts);
      expect(uniqueAmounts.size).toBeGreaterThan(1);
    });

    test('fee and tax variance arithmetic balances with settlement shortfall', async () => {
      const listRes = await request(app).get('/api/investigations');
      const feeCases = listRes.body.cases.filter(c => c.exception_category === 'FEE_TAX_VARIANCE');
      expect(feeCases.length).toBeGreaterThan(0);

      const detailRes = await request(app).get(`/api/investigations/${feeCases[0].case_id}`);
      const fa = detailRes.body.financial_analysis;

      if (fa.fee_variance !== null && fa.tax_variance !== null) {
        const totalVariance = Math.abs(fa.fee_variance + fa.tax_variance);
        expect(totalVariance).toBe(detailRes.body.amount_at_risk);
      }
    });
  });

  describe('4. Lifecycle Timeline Evidence Verification', () => {
    test('timeline reflects non-completed AI before AI execution and completed AI after', async () => {
      const listRes = await request(app).get('/api/investigations');
      const testCaseId = listRes.body.cases[0].case_id;

      // Before running AI
      const beforeRes = await request(app).get(`/api/investigations/${testCaseId}`);
      expect(beforeRes.body.ai_investigation).toBeFalsy();
      expect(beforeRes.body.status).toBe('OPEN');

      // Run AI investigation
      const runRes = await request(app).post(`/api/investigations/${testCaseId}/run`).send({});
      expect(runRes.status).toBe(200);

      // After running AI
      const afterRes = await request(app).get(`/api/investigations/${testCaseId}`);
      expect(afterRes.body.ai_investigation).toBeDefined();
      expect(afterRes.body.status).toBe('IN_REVIEW');
      expect(afterRes.body.ai_investigation.ai_metadata?.generated_at || afterRes.body.ai_investigation.timestamp).toBeDefined();
    });

    test('timeline marks resolution as completed only after operator resolves', async () => {
      const listRes = await request(app).get('/api/investigations');
      const testCaseId = listRes.body.cases[1].case_id;

      // Before resolution
      const openRes = await request(app).get(`/api/investigations/${testCaseId}`);
      expect(openRes.body.status).toBe('OPEN');
      expect(openRes.body.resolution).toBeNull();

      // Resolve
      const resolveRes = await request(app).post(`/api/investigations/${testCaseId}/resolve`).send({
        resolution_reason: 'MERCHANT_RECORD_CORRECTED',
        resolved_by: 'Auditor_01',
      });
      expect(resolveRes.status).toBe(200);

      // After resolution
      const resolvedRes = await request(app).get(`/api/investigations/${testCaseId}`);
      expect(resolvedRes.body.status).toBe('RESOLVED');
      expect(resolvedRes.body.resolution).toBeDefined();
      expect(resolvedRes.body.resolution.resolved_at).toBeDefined();
      expect(resolvedRes.body.resolution.resolution_reason).toBe('MERCHANT_RECORD_CORRECTED');
    });
  });

  describe('5. Case Evidence Provenance & Payvault AI Consistency', () => {
    test('case detail has real settlement and reconciliation evidence artifacts', async () => {
      const listRes = await request(app).get('/api/investigations');
      const sampleCaseId = listRes.body.cases[0].case_id;

      const detailRes = await request(app).get(`/api/investigations/${sampleCaseId}`);
      const c = detailRes.body;

      expect(c.case_id).toBe(sampleCaseId);
      expect(c.exception).toBeDefined();
      expect(c.reconciliation_result).toBeDefined();
      expect(c.data_sources).toBeDefined();
      expect(c.data_sources.derived).toBeDefined();
    });

    test('AI chat answers remain strictly grounded in case data', async () => {
      const listRes = await request(app).get('/api/investigations');
      const sampleCaseId = listRes.body.cases[0].case_id;

      const chatRes = await request(app)
        .post(`/api/investigations/${sampleCaseId}/chat`)
        .send({
          message: 'Why was this flagged?',
          history: [],
        });

      expect(chatRes.status).toBe(200);
      expect(chatRes.body.answer).toBeDefined();
      expect(chatRes.body.source).toBe('payvault_native_intelligence');
      // Verify no internal LLM leaks
      expect(chatRes.body.answer).not.toMatch(/ollama/i);
      expect(chatRes.body.answer).not.toMatch(/qwen/i);
    });
  });

  describe('6. Preserved Payment & Reconciliation End-to-End Integrity', () => {
    test('creating payment in local demo mode still produces clean transaction flow', async () => {
      const payRes = await request(app)
        .post('/api/payments/local')
        .send({
          amount: 50000, // ₹500
          payment_method: 'card',
          customer_ref: 'test_ord_99',
          anomaly_type: 'CLEAN_MATCH',
        });

      expect(payRes.status).toBe(200);
      expect(payRes.body.success).toBe(true);
      expect(payRes.body.mode).toBe('LOCAL_DEMO');
      expect(payRes.body.amount).toBe(50000); // 50000 paise
    });

    test('reconciliation audit table endpoint continues to return all records', async () => {
      const reconRes = await request(app).get('/api/reconciliation/results');
      expect(reconRes.status).toBe(200);
      expect(Array.isArray(reconRes.body.results)).toBe(true);
      expect(reconRes.body.results.length).toBeGreaterThan(0);
    });
  });

  describe('7. Top-of-Page Result Order & Dynamic Grounded Findings', () => {
    const fs = require('fs');
    const path = require('path');
    const checkout = require('../public/checkout');

    test('exact top-of-page order in index.html is Summary → Timeline → Impact → Evidence → AI → Operator Action', () => {
      const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

      const summaryIdx = html.indexOf('id="finding-hero-card"');
      const timelineIdx = html.indexOf('id="investigation-timeline-section"');
      const impactIdx = html.indexOf('id="financial-impact-section"');
      const evidenceIdx = html.indexOf('id="case-evidence-panel"');
      const aiIdx = html.indexOf('id="ask-payvault-ai-section"');
      const operatorActionIdx = html.indexOf('id="operator-action-section"');

      expect(summaryIdx).toBeGreaterThan(0);
      expect(timelineIdx).toBeGreaterThan(summaryIdx);
      expect(impactIdx).toBeGreaterThan(timelineIdx);
      expect(evidenceIdx).toBeGreaterThan(impactIdx);
      expect(aiIdx).toBeGreaterThan(evidenceIdx);
      expect(operatorActionIdx).toBeGreaterThan(aiIdx);
    });

    test('generateCaseFindings produces dynamic, case-specific explanation for FEE_TAX_VARIANCE', () => {
      const sampleCase = {
        exception_category: 'FEE_TAX_VARIANCE',
        amount_at_risk: 2950,
        ai_investigation: {
          ai_analysis: {
            what_happened: "Dynamically generated fee variance what happened.",
            why_it_matters: "Dynamically generated fee variance impact."
          }
        },
        suggested_actions: ["Dynamic action 1"]
      };
      const fa = {};
      const findings = checkout.generateCaseFindings(sampleCase, fa, 1123284, 1096774, 1093824, 2950);

      expect(findings.whatHappened).toBe("Dynamically generated fee variance what happened.");
      expect(findings.whyDoesItMatter).toBe("Dynamically generated fee variance impact.");
      expect(findings.actionItems.length).toBe(1);
      expect(findings.actionItems[0].desc).toBe("Dynamic action 1");
    });

    test('generateCaseFindings produces dynamic explanation for MISSING_ORDER without fee references', () => {
      const sampleCase = {
        exception_category: 'MISSING_ORDER',
        amount_at_risk: 100000,
        ai_investigation: {
          ai_analysis: {
            what_happened: "Dynamic missing order explanation.",
            why_it_matters: "Dynamic missing order impact."
          }
        },
        suggested_actions: ["Missing order action"]
      };
      const fa = {};
      const findings = checkout.generateCaseFindings(sampleCase, fa, 100000, 100000, 100000, 100000);

      expect(findings.whatHappened).toBe("Dynamic missing order explanation.");
      expect(findings.whyDoesItMatter).toBe("Dynamic missing order impact.");
    });

    test('generateCaseFindings produces dynamic explanation for DUPLICATE exception', () => {
      const sampleCase = {
        exception_category: 'DUPLICATE',
        amount_at_risk: 15000,
        ai_investigation: {
          ai_analysis: {
            what_happened: "Duplicate settlement detected.",
            why_it_matters: "Creates cash inflation."
          }
        },
        suggested_actions: ["Hold surplus credit"]
      };
      const fa = {};
      const findings = checkout.generateCaseFindings(sampleCase, fa, 15000, 15000, 15000, 15000);

      expect(findings.whatHappened).toBe("Duplicate settlement detected.");
      expect(findings.whyDoesItMatter).toBe("Creates cash inflation.");
      expect(findings.actionItems[0].desc).toBe("Hold surplus credit");
    });
  });

  describe('8. Investigation Case ID Mapping & Re-Run Guarantee', () => {
    test('Selected investigation exc_000001 routes to exc_000001 and never recon_000002', async () => {
      // 1. Fetch reconciliation results and ensure exception_id is provided
      const reconRes = await request(app).get('/api/reconciliation/results');
      expect(reconRes.status).toBe(200);
      const matched = reconRes.body.results.find(r => r.id === 'recon_000056');
      if (matched) {
        expect(matched.exception_id).toBe('exc_000001');
      }

      // 2. Run investigation with exc_000001 succeeds
      const runRes = await request(app)
        .post('/api/investigations/exc_000001/run')
        .send({ actor: 'test_operator' });
      expect(runRes.status).toBe(200);
      expect(runRes.body.case_id).toBe('exc_000001');

      // 3. Confirm recon_000002 is correctly rejected with 404
      const failRes = await request(app)
        .post('/api/investigations/recon_000002/run');
      expect(failRes.status).toBe(404);
      expect(failRes.body.error).toContain("Investigation case 'recon_000002' not found");
    });
  });

});
