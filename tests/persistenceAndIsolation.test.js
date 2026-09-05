'use strict';
/**
 * tests/persistenceAndIsolation.test.js
 *
 * Comprehensive test suite verifying:
 * 1. PostgreSQL Repositories: Integer paise precision, storage, retrieval, audit events.
 * 2. Redis Transient State: Scoped keys, TTL, conversation state, turn progression.
 * 3. Case Isolation: CASE_A conversation context NEVER leaks into CASE_B.
 * 4. 8-Turn Chat Regression (Section 23): Complete 8-turn flow with context continuity.
 * 5. Two-Case Alternating Flow (Section 24): A → B → A context isolation.
 * 6. Health check endpoint (Section 20): Reports PG and Redis health without secrets.
 * 7. Investigation ID Flow: Canonical exception ID is used, avoiding recon ID mismatches.
 */

const request = require('supertest');
const app = require('../server');
const store = require('../src/store/dataStore');
const postgres = require('../src/db/postgres');
const redis = require('../src/db/redis');
const paymentRepository = require('../src/db/repositories/paymentRepository');
const investigationRepository = require('../src/db/repositories/investigationRepository');
const auditRepository = require('../src/db/repositories/auditRepository');
const reconciliationRepository = require('../src/db/repositories/reconciliationRepository');

describe('Payvault PostgreSQL + Redis Persistence & Isolation Suite', () => {
  beforeAll(async () => {
    store.reset();
    await postgres.checkConnection();
    await redis.checkConnection();
  });

  afterAll(async () => {
    await postgres.close();
    await redis.close();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. Health Endpoint (Section 20)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('1. Health Check Endpoint', () => {
    test('GET /api/health reports database and redis status safely without leaking secrets', async () => {
      const res = await request(app).get('/api/health').expect(200);

      expect(res.body.status).toBe('healthy');
      expect(res.body.database).toBeDefined();
      expect(['connected', 'unavailable']).toContain(res.body.database.status);
      expect(['POSTGRES_PRODUCTION', 'DEVELOPMENT_FALLBACK']).toContain(res.body.database.mode);

      expect(res.body.redis).toBeDefined();
      expect(['connected', 'unavailable']).toContain(res.body.redis.status);
      expect(['REDIS_PERSISTENT', 'IN_MEMORY_FALLBACK']).toContain(res.body.redis.mode);

      // Verify NO passwords, URLs, or secrets are exposed
      const jsonString = JSON.stringify(res.body);
      expect(jsonString).not.toContain('payvault_dev_secret');
      expect(jsonString).not.toContain('postgresql://');
      expect(jsonString).not.toContain('redis://');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. PostgreSQL Repository Layer & Integer Paise Precision (Sections 5, 6, 9)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('2. PostgreSQL Repository Layer & Integer Paise Rules', () => {
    test('paymentRepository saves and retrieves payments with strict integer paise', async () => {
      const testPayment = {
        id: `pay_test_${Date.now()}`,
        order_id: `order_test_${Date.now()}`,
        amount_paise: 125000, // ₹1250.00
        currency: 'INR',
        status: 'captured',
        method: 'card',
      };

      const saved = await paymentRepository.save(testPayment);
      expect(saved.id).toBe(testPayment.id);
      expect(saved.amount_paise).toBe(125000);

      const retrieved = await paymentRepository.findById(testPayment.id);
      expect(retrieved).toBeDefined();
      expect(retrieved.id).toBe(testPayment.id);
      expect(retrieved.amount_paise).toBe(125000);
    });

    test('paymentRepository strictly rejects float or negative monetary amounts', async () => {
      expect(() => {
        paymentRepository.validatePaise(125.50); // float error
      }).toThrow(/Invalid monetary amount_paise/);

      expect(() => {
        paymentRepository.validatePaise(-500); // negative error
      }).toThrow(/Invalid monetary amount_paise/);

      expect(() => {
        paymentRepository.validatePaise('125000'); // string error
      }).toThrow(/Invalid monetary amount_paise/);
    });

    test('reconciliationRepository saves and retrieves reconciliation records in integer paise', async () => {
      const record = {
        id: `recon_test_${Date.now()}`,
        settlement_entity_id: `pay_rec_${Date.now()}`,
        merchant_order_id: `mo_rec_${Date.now()}`,
        status: 'FEE_TAX_VARIANCE',
        gross_amount_paise: 100000,
        expected_fee_paise: 2000,
        actual_fee_paise: 2500,
        fee_variance_paise: 500,
        expected_gst_paise: 360,
        actual_gst_paise: 450,
        gst_variance_paise: 90,
        expected_settlement_paise: 97640,
        actual_settlement_paise: 97050,
      };

      const saved = await reconciliationRepository.save(record);
      expect(saved.id).toBe(record.id);
      expect(saved.fee_variance_paise).toBe(500);

      const retrieved = await reconciliationRepository.findById(record.id);
      expect(retrieved).toBeDefined();
      expect(retrieved.fee_variance_paise).toBe(500);
    });

    test('investigationRepository saves, retrieves and updates investigation cases', async () => {
      const caseId = `exc_test_${Date.now()}`;
      const inv = {
        id: `inv_${caseId}`,
        case_id: caseId,
        exception_id: caseId,
        exception_category: 'FEE_TAX_VARIANCE',
        status: 'OPEN',
        amount_at_risk_paise: 590,
        summary: 'Excess fee and GST charged by gateway.',
        what_happened: 'Gateway fee rate of 2.5% applied instead of 2.0%.',
        why_it_matters: 'Merchant underpaid by 590 paise.',
        recommended_actions: ['Reconcile with gateway partner'],
      };

      const saved = await investigationRepository.save(inv);
      expect(saved.case_id).toBe(caseId);
      expect(saved.amount_at_risk_paise).toBe(590);

      const retrieved = await investigationRepository.findByCaseId(caseId);
      expect(retrieved).toBeDefined();
      expect(retrieved.case_id).toBe(caseId);
      expect(retrieved.what_happened).toContain('Gateway fee rate');

      const updated = await investigationRepository.updateStatus(caseId, 'IN_REVIEW');
      expect(updated.status).toBe('IN_REVIEW');
    });

    test('auditRepository records append-only events', async () => {
      const caseId = `exc_audit_${Date.now()}`;
      const event = {
        case_id: caseId,
        action: 'RESOLVED',
        actor: 'senior_operator',
        from_status: 'IN_REVIEW',
        to_status: 'RESOLVED',
        resolution_reason: 'FEE_DISPUTE_FILED',
        notes: 'Dispute filed with payment partner.',
        amount_at_risk_paise: 590,
      };

      const recorded = await auditRepository.recordEvent(event);
      expect(recorded.case_id).toBe(caseId);
      expect(recorded.action).toBe('RESOLVED');

      const events = await auditRepository.findByCaseId(caseId);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].resolution_reason).toBe('FEE_DISPUTE_FILED');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Redis Transient State Layer (Sections 11, 12, 13, 14)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('3. Redis Transient Conversation State Layer', () => {
    const testInvId = 'exc_000001';
    const testConvId = `conv_test_${Date.now()}`;

    test('Saves and retrieves conversation state with scoped key and TTL', async () => {
      const statePayload = {
        currentTopic: 'fee_variance',
        previousIntent: 'what_happened',
        currentIntent: 'fee_specific',
        referencedEntities: ['gateway_fee', 'gst'],
        activeFinancialMetric: 'fee_variance',
        lastUserQuestion: 'Why is the settlement lower?',
        lastAnswerSummary: 'Gateway deducted 50 paise extra fee',
        turnNumber: 2,
      };

      const saveRes = await redis.saveConversationState(testInvId, testConvId, statePayload, 1800);
      expect(saveRes.key).toBe(`payvault:chat:${testInvId}:${testConvId}`);
      expect(saveRes.ttl).toBe(1800);

      const retrieved = await redis.getConversationState(testInvId, testConvId);
      expect(retrieved).toBeDefined();
      expect(retrieved.investigationId).toBe(testInvId);
      expect(retrieved.conversationId).toBe(testConvId);
      expect(retrieved.currentTopic).toBe('fee_variance');
      expect(retrieved.turnNumber).toBe(2);

      const ttl = await redis.getTTL(testInvId, testConvId);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(1800);
    });

    test('Strict Case Isolation: CASE_A state NEVER appears in CASE_B', async () => {
      const caseA = 'CASE_A_1001';
      const caseB = 'CASE_B_2002';
      const convA = 'session_alpha';
      const convB = 'session_beta';

      await redis.saveConversationState(caseA, convA, {
        currentTopic: 'excess_fee_deduction',
        activeFinancialMetric: 'fee_variance_paise',
        lastUserQuestion: 'Why did the fee increase?',
        turnNumber: 3,
      });

      await redis.saveConversationState(caseB, convB, {
        currentTopic: 'settlement_timing_delay',
        activeFinancialMetric: 'settlement_delay_days',
        lastUserQuestion: 'Where is the missing settlement?',
        turnNumber: 1,
      });

      const stateA = await redis.getConversationState(caseA, convA);
      const stateB = await redis.getConversationState(caseB, convB);

      expect(stateA.currentTopic).toBe('excess_fee_deduction');
      expect(stateB.currentTopic).toBe('settlement_timing_delay');

      // Attempting to query Case A conversation under Case B MUST return null
      const crossLeak = await redis.getConversationState(caseB, convA);
      expect(crossLeak).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. Chat Regression: Exact 8-Turn Sequence (Section 23)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('4. Chat Regression — Exact 8-Turn Sequence (Section 23)', () => {
    const caseId = 'exc_000001'; // Fee & Tax variance case
    const conversationId = `conv_8turn_${Date.now()}`;

    const turns = [
      { step: 1, question: 'What happened?', expectIntent: 'what_happened' },
      { step: 2, question: 'Why is the settlement lower?', expectIntent: 'settlement_causality' },
      { step: 3, question: 'But how?', expectIntent: 'settlement_causality' },
      { step: 4, question: 'How much extra was charged?', expectIntent: 'fee_specific' },
      { step: 5, question: 'What about GST?', expectIntent: 'tax_specific' },
      { step: 6, question: 'Where did the missing amount go?', expectIntent: 'where_did_money_go' },
      { step: 7, question: 'Is this an actual financial loss?', expectIntent: 'is_financial_loss' },
      { step: 8, question: 'What should I do now?', expectIntent: 'recommended_action' },
    ];

    let conversationHistory = [];

    for (const turn of turns) {
      test(`Turn ${turn.step}: "${turn.question}" retains context & returns Payvault AI response`, async () => {
        const res = await request(app)
          .post(`/api/investigations/${caseId}/chat`)
          .send({
            message: turn.question,
            history: conversationHistory,
            conversation_id: conversationId,
          })
          .expect(200);

        expect(res.body.model).toBe('Payvault AI');
        expect(res.body.answer).toBeDefined();
        expect(res.body.answer.length).toBeGreaterThan(15);
        expect(res.body.conversation_id).toBe(conversationId);

        // Verify state was persisted in Redis
        const savedState = await redis.getConversationState(caseId, conversationId);
        expect(savedState).toBeDefined();
        expect(savedState.turnNumber).toBe(turn.step);
        expect(savedState.lastUserQuestion).toBe(turn.question);

        // Update in-memory history for next request
        conversationHistory.push({ role: 'operator', content: turn.question });
        conversationHistory.push({ role: 'payvault', content: res.body.answer });
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. Two-Case Isolation Test (Section 24)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('5. Two-Case Isolation Test (Section 24)', () => {
    test('Case A (Fee/Tax) vs Case B (Timing Mismatch) conversation isolation', async () => {
      const caseA = 'exc_000001'; // Fee / Tax variance
      const caseB = 'exc_000002'; // Timing mismatch or alternate exception
      const convA = `conv_A_${Date.now()}`;
      const convB = `conv_B_${Date.now()}`;

      // Turn 1 on Case A
      const resA1 = await request(app)
        .post(`/api/investigations/${caseA}/chat`)
        .send({
          message: 'Why is the settlement lower?',
          history: [],
          conversation_id: convA,
        })
        .expect(200);

      expect(resA1.body.model).toBe('Payvault AI');
      const stateA1 = await redis.getConversationState(caseA, convA);
      expect(stateA1).toBeDefined();

      // Switch to Case B with separate question
      const resB1 = await request(app)
        .post(`/api/investigations/${caseB}/chat`)
        .send({
          message: 'Why is this happening?',
          history: [],
          conversation_id: convB,
        })
        .expect(200);

      const stateB1 = await redis.getConversationState(caseB, convB);
      expect(stateB1).toBeDefined();

      // Case B state must NOT contain Case A's question or topic
      expect(stateB1.conversationId).toBe(convB);
      expect(stateB1.investigationId).toBe(caseB);
      expect(stateB1.lastUserQuestion).toBe('Why is this happening?');

      // Return to Case A — verify its conversation state was untouched
      const stateA2 = await redis.getConversationState(caseA, convA);
      expect(stateA2.conversationId).toBe(convA);
      expect(stateA2.investigationId).toBe(caseA);
      expect(stateA2.lastUserQuestion).toBe('Why is the settlement lower?');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. Investigation Run & Reconciliation ID Mapping (Urgent Bug Fix Verification)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('6. Investigation ID Mapping and Run Action', () => {
    test('GET /api/reconciliation/results includes exception_id for UI mapping', async () => {
      const res = await request(app).get('/api/reconciliation/results').expect(200);
      expect(res.body.results).toBeDefined();
      expect(res.body.results.length).toBeGreaterThan(0);

      // Verify that exception_id is provided
      const exceptionsFound = res.body.results.filter(r => r.exception_id);
      expect(exceptionsFound.length).toBeGreaterThan(0);

      // Verify that exception_id has format exc_...
      for (const item of exceptionsFound) {
        expect(item.exception_id).toMatch(/^exc_/);
      }
    });

    test('POST /api/investigations/exc_000001/run succeeds with dynamic 3 summary sections', async () => {
      const res = await request(app)
        .post('/api/investigations/exc_000001/run')
        .send({ actor: 'test_operator' })
        .expect(200);

      expect(res.body.case_id).toBe('exc_000001');
      expect(res.body.status).toBe('IN_REVIEW');

      // Verify What happened?, Why does it matter?, and What should I do?
      const ai = res.body.ai_investigation;
      expect(ai).toBeDefined();
      expect(typeof ai.what_happened).toBe('string');
      expect(ai.what_happened.length).toBeGreaterThan(10);
      expect(typeof ai.why_it_matters).toBe('string');
      expect(ai.why_it_matters.length).toBeGreaterThan(10);
      expect(Array.isArray(ai.recommended_actions)).toBe(true);
      expect(ai.recommended_actions.length).toBeGreaterThan(0);
    });

    test('POST /api/investigations/exc_000001/investigate (alias) also succeeds', async () => {
      const res = await request(app)
        .post('/api/investigations/exc_000001/investigate')
        .expect(200);

      expect(res.body.case_id).toBe('exc_000001');
    });

    test('Calling /run on invalid ID returns clean 404', async () => {
      const res = await request(app)
        .post('/api/investigations/recon_000002/run')
        .expect(404);

      expect(res.body.error).toContain("Investigation case 'recon_000002' not found");
    });
  });
});
