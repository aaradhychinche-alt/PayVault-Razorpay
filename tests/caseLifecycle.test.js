'use strict';
/**
 * tests/caseLifecycle.test.js
 *
 * Test suite for Chunk 3: Exception Resolution & Case Lifecycle.
 *
 * Covers:
 *  - Lifecycle transitions (OPEN → IN_REVIEW → RESOLVED → OPEN)
 *  - Human resolution recording with maintainable ResolutionReason enum
 *  - Append-only audit trail integrity
 *  - Validation & rejection of invalid state transitions / reasons
 *  - Dashboard and reconciliation summary metrics updates
 *  - Non-destructive historical preservation
 */

const request = require('supertest');
const app     = require('../server');
const store   = require('../src/store/dataStore');
const {
  CaseStatus,
  ResolutionReason,
  ResolutionReasonDetails,
  isValidResolutionReason,
  resetAuditCounter,
} = require('../src/models/resolution');

describe('Chunk 3 — Exception Resolution & Case Lifecycle Suite', () => {

  beforeEach(() => {
    resetAuditCounter();
    store.reset(); // Reset to 79-case synthetic benchmark (24 exceptions)
  });

  describe('1. Resolution Enums & Configuration', () => {
    test('defines all standard resolution reasons', () => {
      expect(ResolutionReason.DUPLICATE_PAYMENT_CONFIRMED).toBe('DUPLICATE_PAYMENT_CONFIRMED');
      expect(ResolutionReason.MERCHANT_RECORD_CORRECTED).toBe('MERCHANT_RECORD_CORRECTED');
      expect(ResolutionReason.GATEWAY_ISSUE_CONFIRMED).toBe('GATEWAY_ISSUE_CONFIRMED');
      expect(ResolutionReason.NO_ACTUAL_FINANCIAL_LOSS).toBe('NO_ACTUAL_FINANCIAL_LOSS');
      expect(ResolutionReason.FALSE_POSITIVE).toBe('FALSE_POSITIVE');
      expect(ResolutionReason.OTHER).toBe('OTHER');
    });

    test('isValidResolutionReason correctly validates reasons', () => {
      expect(isValidResolutionReason('DUPLICATE_PAYMENT_CONFIRMED')).toBe(true);
      expect(isValidResolutionReason('MERCHANT_RECORD_CORRECTED')).toBe(true);
      expect(isValidResolutionReason('INVALID_REASON')).toBe(false);
      expect(isValidResolutionReason('')).toBe(false);
      expect(isValidResolutionReason(null)).toBe(false);
    });

    test('GET /api/investigations/config/resolution-reasons returns reason list', async () => {
      const res = await request(app).get('/api/investigations/config/resolution-reasons');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.reasons)).toBe(true);
      expect(res.body.reasons.length).toBe(6);

      const dupReason = res.body.reasons.find(r => r.id === 'DUPLICATE_PAYMENT_CONFIRMED');
      expect(dupReason).toBeDefined();
      expect(dupReason.label).toBe('Duplicate payment confirmed');
    });
  });

  describe('2. Initial State & Case Lifecycle Queries', () => {
    test('all exceptions start in OPEN status by default', async () => {
      const res = await request(app).get('/api/investigations');
      expect(res.status).toBe(200);
      expect(res.body.cases.length).toBe(24);
      expect(res.body.status_counts.total).toBe(24);
      expect(res.body.status_counts.open).toBe(24);
      expect(res.body.status_counts.in_review).toBe(0);
      expect(res.body.status_counts.resolved).toBe(0);

      res.body.cases.forEach(c => {
        expect(c.status).toBe(CaseStatus.OPEN);
        expect(c.resolution).toBeNull();
      });
    });

    test('GET /api/investigations/:id returns case with status and empty initial audit trail', async () => {
      const res = await request(app).get('/api/investigations/exc_000001');
      expect(res.status).toBe(200);
      expect(res.body.case_id).toBe('exc_000001');
      expect(res.body.status).toBe(CaseStatus.OPEN);
      expect(res.body.resolution).toBeNull();
      expect(Array.isArray(res.body.audit_trail)).toBe(true);
    });

    test('POST /api/investigations/:id/run transitions OPEN case to IN_REVIEW', async () => {
      const runRes = await request(app)
        .post('/api/investigations/exc_000001/run')
        .send({ actor: 'analyst_1' });

      expect(runRes.status).toBe(200);
      expect(runRes.body.status).toBe(CaseStatus.IN_REVIEW);

      // Verify detail endpoint reflects IN_REVIEW
      const detailRes = await request(app).get('/api/investigations/exc_000001');
      expect(detailRes.status).toBe(200);
      expect(detailRes.body.status).toBe(CaseStatus.IN_REVIEW);

      // Verify audit trail logged START_REVIEW
      expect(detailRes.body.audit_trail.length).toBe(1);
      expect(detailRes.body.audit_trail[0].action).toBe('START_REVIEW');
      expect(detailRes.body.audit_trail[0].previous_status).toBe('OPEN');
      expect(detailRes.body.audit_trail[0].new_status).toBe('IN_REVIEW');
    });
  });

  describe('3. Exception Resolution (Human in the Loop)', () => {
    test('resolves an OPEN case successfully', async () => {
      const res = await request(app)
        .post('/api/investigations/exc_000001/resolve')
        .send({
          resolution_reason: 'FEE_TAX_VARIANCE' in ResolutionReason ? 'FEE_TAX_VARIANCE' : 'MERCHANT_RECORD_CORRECTED',
          resolution_notes: 'Merchant ledger fee schedule was outdated; corrected in ERP.',
          resolved_by: 'finance_ops',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.case_id).toBe('exc_000001');
      expect(res.body.status).toBe(CaseStatus.RESOLVED);
      expect(res.body.resolution).toBeDefined();
      expect(res.body.resolution.resolution_reason).toBe('MERCHANT_RECORD_CORRECTED');
      expect(res.body.resolution.resolution_notes).toBe('Merchant ledger fee schedule was outdated; corrected in ERP.');
      expect(res.body.resolution.resolved_by).toBe('finance_ops');
      expect(typeof res.body.resolution.resolved_at).toBe('number');
    });

    test('resolves an IN_REVIEW case successfully', async () => {
      // First run investigation
      await request(app).post('/api/investigations/exc_000002/run');

      // Then resolve
      const res = await request(app)
        .post('/api/investigations/exc_000002/resolve')
        .send({
          resolution_reason: 'DUPLICATE_PAYMENT_CONFIRMED',
          resolution_notes: 'Confirmed duplicate settlement credit. Refund scheduled.',
          resolved_by: 'lead_auditor',
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(CaseStatus.RESOLVED);
      expect(res.body.resolution.resolution_reason).toBe('DUPLICATE_PAYMENT_CONFIRMED');

      // Audit trail should contain both START_REVIEW and RESOLVED events
      const auditRes = await request(app).get('/api/investigations/exc_000002/audit');
      expect(auditRes.status).toBe(200);
      expect(auditRes.body.count).toBe(2);
      expect(auditRes.body.audit_trail[0].action).toBe('START_REVIEW');
      expect(auditRes.body.audit_trail[1].action).toBe('RESOLVED');
      expect(auditRes.body.audit_trail[1].previous_status).toBe('IN_REVIEW');
      expect(auditRes.body.audit_trail[1].new_status).toBe('RESOLVED');
    });

    test('rejects resolution with missing resolution_reason', async () => {
      const res = await request(app)
        .post('/api/investigations/exc_000001/resolve')
        .send({
          resolution_notes: 'Some notes without reason',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('resolution_reason is required');
    });

    test('rejects resolution with invalid resolution_reason', async () => {
      const res = await request(app)
        .post('/api/investigations/exc_000001/resolve')
        .send({
          resolution_reason: 'NON_EXISTENT_REASON_XYZ',
          resolution_notes: 'Invalid reason test',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid resolution_reason');
    });

    test('rejects resolution for non-existent case ID', async () => {
      const res = await request(app)
        .post('/api/investigations/exc_999999/resolve')
        .send({
          resolution_reason: 'DUPLICATE_PAYMENT_CONFIRMED',
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });
  });

  describe('4. Case Reopening & Audit Trail Preservation', () => {
    test('reopens a resolved case back to OPEN and preserves audit trail', async () => {
      // 1. Resolve case
      await request(app)
        .post('/api/investigations/exc_000003/resolve')
        .send({
          resolution_reason: 'NO_ACTUAL_FINANCIAL_LOSS',
          resolution_notes: 'Variance resolved by netting.',
          resolved_by: 'auditor_1',
        });

      // 2. Reopen case
      const reopenRes = await request(app)
        .post('/api/investigations/exc_000003/reopen')
        .send({
          reopen_notes: 'New bank statement contradicts initial finding.',
          reopened_by: 'senior_manager',
        });

      expect(reopenRes.status).toBe(200);
      expect(reopenRes.body.status).toBe(CaseStatus.OPEN);
      expect(reopenRes.body.resolution).toBeNull();

      // 3. Verify case detail
      const detailRes = await request(app).get('/api/investigations/exc_000003');
      expect(detailRes.status).toBe(200);
      expect(detailRes.body.status).toBe(CaseStatus.OPEN);
      expect(detailRes.body.resolution).toBeNull();

      // Audit trail must preserve both RESOLVED and REOPENED events!
      const auditTrail = detailRes.body.audit_trail;
      expect(auditTrail.length).toBe(2);
      expect(auditTrail[0].action).toBe('RESOLVED');
      expect(auditTrail[0].resolution_reason).toBe('NO_ACTUAL_FINANCIAL_LOSS');
      expect(auditTrail[1].action).toBe('REOPENED');
      expect(auditTrail[1].previous_status).toBe('RESOLVED');
      expect(auditTrail[1].new_status).toBe('OPEN');
      expect(auditTrail[1].notes).toBe('New bank statement contradicts initial finding.');
      expect(auditTrail[1].performed_by).toBe('senior_manager');
    });

    test('rejects reopening a case that is not resolved', async () => {
      const res = await request(app)
        .post('/api/investigations/exc_000004/reopen')
        .send({ reopen_notes: 'Attempting to reopen an open case' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('is not in RESOLVED status');
    });

    test('supports full multi-cycle lifecycle (OPEN → REVIEW → RESOLVE → REOPEN → RESOLVE)', async () => {
      const caseId = 'exc_000005';

      // Cycle 1: Review → Resolve
      await request(app).post(`/api/investigations/${caseId}/run`);
      await request(app).post(`/api/investigations/${caseId}/resolve`).send({
        resolution_reason: 'FALSE_POSITIVE',
        resolution_notes: 'Initial false alarm.',
      });

      // Cycle 2: Reopen → Resolve again
      await request(app).post(`/api/investigations/${caseId}/reopen`).send({
        reopen_notes: 'Re-evaluating per gateway update.',
      });
      await request(app).post(`/api/investigations/${caseId}/resolve`).send({
        resolution_reason: 'GATEWAY_ISSUE_CONFIRMED',
        resolution_notes: 'Gateway timing discrepancy confirmed.',
      });

      const auditRes = await request(app).get(`/api/investigations/${caseId}/audit`);
      expect(auditRes.status).toBe(200);
      expect(auditRes.body.count).toBe(4);
      expect(auditRes.body.audit_trail.map(a => a.action)).toEqual([
        'START_REVIEW',
        'RESOLVED',
        'REOPENED',
        'RESOLVED',
      ]);
    });
  });

  describe('5. Status Filtering & Dashboard Summary Updates', () => {
    test('GET /api/investigations filters by status query parameter', async () => {
      // Resolve 2 cases
      await request(app).post('/api/investigations/exc_000001/resolve').send({ resolution_reason: 'OTHER' });
      await request(app).post('/api/investigations/exc_000002/resolve').send({ resolution_reason: 'OTHER' });
      // Review 1 case
      await request(app).post('/api/investigations/exc_000003/run');

      // Filter: RESOLVED
      const resResolved = await request(app).get('/api/investigations?status=RESOLVED');
      expect(resResolved.status).toBe(200);
      expect(resResolved.body.cases.length).toBe(2);
      expect(resResolved.body.status_counts.resolved).toBe(2);
      expect(resResolved.body.status_counts.in_review).toBe(1);
      expect(resResolved.body.status_counts.open).toBe(21);
      expect(resResolved.body.status_counts.total).toBe(24);

      // Filter: IN_REVIEW
      const resReview = await request(app).get('/api/investigations?status=IN_REVIEW');
      expect(resReview.status).toBe(200);
      expect(resReview.body.cases.length).toBe(1);

      // Filter: OPEN
      const resOpen = await request(app).get('/api/investigations?status=OPEN');
      expect(resOpen.status).toBe(200);
      expect(resOpen.body.cases.length).toBe(21);
    });

    test('reconciliation summary reflects real dynamic lifecycle counts and amount at risk', async () => {
      const initialSum = await request(app).get('/api/reconciliation/summary');
      expect(initialSum.status).toBe(200);
      expect(initialSum.body.exceptions_total).toBe(24);
      expect(initialSum.body.exceptions_open).toBe(24);
      expect(initialSum.body.exceptions_resolved).toBe(0);

      const exc1 = store.getExceptions().find(e => e.id === 'exc_000001');
      const exc1Risk = exc1.amount_at_risk;

      // Resolve 1 exception
      await request(app).post('/api/investigations/exc_000001/resolve').send({
        resolution_reason: 'DUPLICATE_PAYMENT_CONFIRMED',
      });

      const updatedSum = await request(app).get('/api/reconciliation/summary');
      expect(updatedSum.status).toBe(200);
      expect(updatedSum.body.exceptions_total).toBe(24); // Total historical count preserved!
      expect(updatedSum.body.exceptions_open).toBe(23);
      expect(updatedSum.body.exceptions_resolved).toBe(1);
      expect(updatedSum.body.amount_at_risk_resolved_paise).toBe(exc1Risk);
      expect(updatedSum.body.amount_at_risk_open_paise).toBe(initialSum.body.amount_at_risk_total_paise - exc1Risk);
      expect(updatedSum.body.amount_at_risk_total_paise).toBe(initialSum.body.amount_at_risk_total_paise);
    });

    test('underlying reconciliation engine results & settlement records remain untouched', () => {
      const initialReconResults = store.getReconciliationResults();
      const initialSettlementRecords = store.getSettlementRecords();

      store.resolveCase('exc_000001', { resolution_reason: 'MERCHANT_RECORD_CORRECTED' });
      store.reopenCase('exc_000001');

      expect(store.getReconciliationResults().length).toBe(initialReconResults.length);
      expect(store.getSettlementRecords().length).toBe(initialSettlementRecords.length);
    });
  });

});
