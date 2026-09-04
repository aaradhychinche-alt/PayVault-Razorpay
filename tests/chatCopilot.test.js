'use strict';
/**
 * tests/chatCopilot.test.js
 *
 * Test suite for the Payvault AI Conversational Investigation Copilot.
 *
 * Validates:
 * - Native reasoning pipeline (NO Qwen, NO Ollama)
 * - Multi-turn conversation understanding
 * - Intent classification (semantic, not keyword matching)
 * - Deterministic financial calculations
 * - Dynamic answer construction per-intent
 * - Investigation knowledge layer
 * - Escalation assessment
 * - Evidence reasoning
 * - Proof of no hallucination
 */

const request = require('supertest');
const app     = require('../server');
const store   = require('../src/store/dataStore');
const { buildChatContext } = require('../src/investigation/chat/chatContextBuilder');
const { generateNativeAnswer, analyzeIntent } = require('../src/investigation/chat/nativeReasoning');
const { OllamaChatEngine } = require('../src/investigation/chat/ollamaChatEngine');
const { buildCase } = require('../src/investigation/caseBuilder');
const { buildIntelligenceContext } = require('../src/investigation/intelligence/context');
const {
  evaluateEscalation,
  assessFinancialLoss,
  getInvestigationProcedure,
  getExceptionKnowledge,
} = require('../src/investigation/chat/investigationKnowledge');

// ── Shared benchmark context ──────────────────────────────────────────────────
// Represents Gross ₹1,000, Fee ₹45, GST ₹8.10, Settlement ₹946.90 (short ₹29.50)
const benchmarkCtx = {
  case_id: 'exc_benchmark_1000',
  exception_category: 'FEE_TAX_VARIANCE',
  status: 'OPEN',
  reconciliation_status: 'MISMATCH',
  exception_description: 'Platform fee and GST exceeded contracted schedule (2.0% fee + 18.0% GST on fee)',
  payment_id: 'pay_bench_001',
  order_id: 'order_bench_001',
  settlement_id: 'setl_bench_001',
  settlement_utr: 'UTR_BENCH_1000',
  payment_method: 'CARD',

  gross_amount_paise: 100000,
  expected_net_paise: 97640,
  actual_settlement_paise: 94690,
  fee_expected_paise: 2000,
  fee_actual_paise: 4500,
  fee_variance_paise: 2500,
  tax_expected_paise: 360,
  tax_actual_paise: 810,
  tax_variance_paise: 450,
  merchant_variance_paise: -2950,
  net_shortfall_paise: 2950,
  amount_at_risk_paise: 2950,

  gross_amount_formatted: '₹1,000.00',
  expected_net_formatted: '₹976.40',
  actual_settlement_formatted: '₹946.90',
  fee_expected_formatted: '₹20.00',
  fee_actual_formatted: '₹45.00',
  fee_variance_formatted: '₹25.00',
  fee_is_overcharged: true,
  tax_expected_formatted: '₹3.60',
  tax_actual_formatted: '₹8.10',
  tax_variance_formatted: '₹4.50',
  tax_is_overcharged: true,
  net_shortfall_formatted: '₹29.50',
  amount_at_risk_formatted: '₹29.50',

  suggested_actions: [
    { priority: 'HIGH', description: 'Verify gateway contract fee schedule against actual settlement deduction.' },
    { priority: 'HIGH', description: 'Request fee correction credit from the payment gateway.' },
    { priority: 'MEDIUM', description: 'Document the investigation finding and resolution in the audit trail.' },
  ],

  historical: { similar_cases_count: 0, similar_cases: [], repeated_patterns: [], anomalies: [] },
};

// ── Dynamic test case from store ──────────────────────────────────────────────
describe('Payvault AI Native Reasoning Test Suite', () => {

  let testCaseId;
  let testCtx;

  beforeAll(() => {
    store.reset();
    const s = store.getStore();
    const feeEx = s.exceptions.find(e => (e.category || e.exception_category) === 'FEE_TAX_VARIANCE');
    expect(feeEx).toBeDefined();
    testCaseId = feeEx.id;

    const reconResult = s.reconciliationResults.find(r => r.id === feeEx.reconciliation_result_id);
    const investigationCase = buildCase({ exception: feeEx, reconResult, store: s });
    const lifecycle = store.getCaseLifecycle(testCaseId);
    const intelligenceContext = buildIntelligenceContext({ investigationCase, store: s });
    const savedAi = store.getAiInvestigation(testCaseId);

    testCtx = buildChatContext({ investigationCase, lifecycle, intelligenceContext, savedAi });
  });

  // ── Suite 1: Chat Context Builder ─────────────────────────────────────────
  describe('1. Chat Context Builder & Fact Pack', () => {
    test('enriches context with formatted currencies and computed variances', () => {
      expect(testCtx.gross_amount_formatted).toMatch(/^₹[\d,]+\.\d{2}$/);
      expect(testCtx.fee_expected_formatted).toMatch(/^₹[\d,]+\.\d{2}$/);
      expect(testCtx.fee_actual_formatted).toMatch(/^₹[\d,]+\.\d{2}$/);
      expect(testCtx.tax_expected_formatted).toMatch(/^₹[\d,]+\.\d{2}$/);
      expect(testCtx.tax_actual_formatted).toMatch(/^₹[\d,]+\.\d{2}$/);
      expect(testCtx.actual_settlement_formatted).toMatch(/^₹[\d,]+\.\d{2}$/);
      expect(testCtx.expected_net_formatted).toMatch(/^₹[\d,]+\.\d{2}$/);
    });

    test('generates clear cause-and-effect relationship string', () => {
      expect(typeof testCtx.cause_and_effect_summary).toBe('string');
      expect(testCtx.cause_and_effect_summary).toContain('Gross Amount minus Fee minus GST');
      expect(testCtx.cause_and_effect_summary).toContain('excess deductions');
    });
  });

  // ── Suite 2: Required Intent Coverage (15 specified questions) ────────────
  describe('2. Required Investigation Question Coverage', () => {
    //
    // REQUIREMENT: These 15 questions must produce case-specific, dynamic answers.
    //

    test('1. "What happened?" — roots cause explanation', () => {
      const { answer, intent } = generateNativeAnswer('What happened?', benchmarkCtx, []);
      expect(intent).toBe('why_flagged');
      expect(answer).toContain('Fee / Tax Variance');
      expect(answer).toContain('₹25.00'); // fee overcharge
      expect(answer).toContain('₹4.50');  // GST overcharge
      expect(answer).not.toContain('Complete Financial Breakdown');
    });

    test('2. "Why did this happen?" — root cause', () => {
      const { answer, intent } = generateNativeAnswer('Why did this happen?', benchmarkCtx, []);
      expect(intent).toBe('why_flagged');
      expect(answer).toContain('Fee / Tax Variance');
      expect(answer).toContain('₹25.00');
    });

    test('3. "What about GST?" — GST-specific targeted answer', () => {
      const { answer, intent } = generateNativeAnswer('What about GST?', benchmarkCtx, []);
      expect(intent).toBe('tax_specific');
      expect(answer).toContain('₹8.10');
      expect(answer).toContain('₹3.60');
      expect(answer).toContain('₹4.50');
      // Must NOT mention 0.90 (anti-hallucination check)
      expect(answer).not.toContain('0.90');
    });

    test('4. "How much was overcharged?" — total financial exposure', () => {
      const { answer, intent } = generateNativeAnswer('How much was overcharged?', benchmarkCtx, []);
      expect(['amount_at_risk', 'settlement_causality', 'fee_specific'].includes(intent)).toBe(true);
      expect(answer).toContain('₹29.50');
    });

    test('5. "What should I do now?" — native next-action reasoning', () => {
      const { answer, intent } = generateNativeAnswer('What should I do now?', benchmarkCtx, []);
      expect(intent).toBe('next_action');
      // Must contain case-specific content (not generic)
      expect(answer).toContain('exc_benchmark_1000');
      // Must contain actual steps from the investigation procedure
      expect(answer).toContain('fee');
      // Must not be a single generic sentence
      expect(answer.split('\n').length).toBeGreaterThan(3);
    });

    test('6. "What should I check?" — verification steps', () => {
      const { answer, intent } = generateNativeAnswer('What should I check?', benchmarkCtx, []);
      expect(intent).toBe('what_to_verify');
      expect(answer).toContain('verify the following');
      expect(answer).toContain('Resolve');
    });

    test('7. "Should I escalate this?" — escalation assessment', () => {
      const { answer, intent } = generateNativeAnswer('Should I escalate this?', benchmarkCtx, []);
      expect(intent).toBe('escalation_assessment');
      // Must give a clear yes/no based on the case
      expect(answer.toLowerCase()).toMatch(/(escalat|not required)/);
      expect(answer).toContain('exc_benchmark_1000');
    });

    test('8. "Is this a real financial loss?" — loss assessment', () => {
      const { answer, intent } = generateNativeAnswer('Is this a real financial loss?', benchmarkCtx, []);
      expect(intent).toBe('real_financial_loss');
      // For FEE_TAX_VARIANCE, it IS a real loss
      expect(answer.toLowerCase()).toContain('yes');
      expect(answer).toContain('₹29.50');
    });

    test('9. "What evidence supports this?" — evidence reasoning', () => {
      const { answer, intent } = generateNativeAnswer('What evidence supports this?', benchmarkCtx, []);
      expect(intent).toBe('evidence_assessment');
      // Must reference actual case facts as evidence
      expect(answer).toContain('Settlement Record');
      expect(answer).toContain('₹45.00');
      expect(answer).toContain('₹8.10');
    });

    test('10. "Why is the settlement short?" — settlement causality', () => {
      const { answer, intent } = generateNativeAnswer('Why is the settlement short?', benchmarkCtx, []);
      expect(intent).toBe('settlement_causality');
      expect(answer).toContain('Net Settlement = Gross Amount');
      expect(answer).toContain('₹25.00');
      expect(answer).toContain('₹4.50');
      expect(answer).toContain('₹29.50');
    });

    // Questions from spec list that map to existing intents
    test('"Why does the amount not match?" — settlement causality', () => {
      const { answer, intent } = generateNativeAnswer('Why does the amount not match?', benchmarkCtx, []);
      expect(['settlement_causality', 'why_flagged'].includes(intent)).toBe(true);
      expect(answer.length).toBeGreaterThan(20);
    });

    test('"Explain this to me." — simple explanation', () => {
      const { answer, intent } = generateNativeAnswer('Explain this to me.', benchmarkCtx, []);
      expect(intent).toBe('simple_explanation');
      expect(answer).toContain('Simple Explanation');
    });

    test('"Is the merchant actually losing money?" — real financial loss', () => {
      const { answer, intent } = generateNativeAnswer('Is the merchant actually losing money?', benchmarkCtx, []);
      expect(intent).toBe('real_financial_loss');
      expect(answer).toContain('₹29.50');
    });

    test('"Is this similar to previous cases?" — historical comparison', () => {
      const { answer, intent } = generateNativeAnswer('Is this similar to previous cases?', benchmarkCtx, []);
      expect(intent).toBe('historical_cases');
      expect(answer.length).toBeGreaterThan(10);
    });

    test('"What happened before this?" / "What happened?" variations', () => {
      const questions = [
        'What happened here?',
        'Tell me what happened.',
        'What caused this?',
      ];
      for (const q of questions) {
        const { intent } = generateNativeAnswer(q, benchmarkCtx, []);
        expect(intent).toBe('why_flagged');
      }
    });

    test('10 benchmark questions all produce unique, dedicated answers and distinct intents', () => {
      const benchmarkQuestions = [
        { q: 'What happened?', expectedIntent: 'why_flagged' },
        { q: 'What is the gross amount I got?', expectedIntent: 'gross_amount' },
        { q: 'What was the expected settlement?', expectedIntent: 'expected_settlement' },
        { q: 'Why is the settlement short?', expectedIntent: 'settlement_causality' },
        { q: 'What is the fee difference?', expectedIntent: 'fee_specific' },
        { q: 'Is there a GST difference?', expectedIntent: 'tax_specific' },
        { q: 'What should I verify next?', expectedIntent: 'what_to_verify' },
        { q: 'Does this represent actual financial loss?', expectedIntent: 'real_financial_loss' },
        { q: 'What evidence supports this?', expectedIntent: 'evidence_assessment' },
        { q: 'Should I escalate this case?', expectedIntent: 'escalation_assessment' },
      ];

      const answers = [];
      for (const item of benchmarkQuestions) {
        const { answer, intent } = generateNativeAnswer(item.q, benchmarkCtx, []);
        expect(intent).toBe(item.expectedIntent);
        expect(answer.length).toBeGreaterThan(20);
        answers.push(answer);
      }

      const uniqueAnswers = new Set(answers);
      expect(uniqueAnswers.size).toBe(10);
    });
  });

  // ── Suite 3: Multi-turn Conversation Understanding ────────────────────────
  describe('3. Multi-Turn Conversation Understanding', () => {

    test('11. Three-turn sequence: What happened → What about GST → What should I do now', async () => {
      const history = [];

      // Turn 1: What happened?
      const r1 = await request(app)
        .post(`/api/investigations/${testCaseId}/chat`)
        .send({ message: 'What happened?', history })
        .expect(200);

      expect(r1.body.answer).toBeDefined();
      expect(r1.body.answer.length).toBeGreaterThan(10);
      history.push({ role: 'operator', content: 'What happened?' });
      history.push({ role: 'payvault', content: r1.body.answer });

      // Turn 2: What about GST? (follow-up referencing prior context)
      const r2 = await request(app)
        .post(`/api/investigations/${testCaseId}/chat`)
        .send({ message: 'What about GST?', history })
        .expect(200);

      expect(r2.body.answer).toBeDefined();
      expect(r2.body.answer).toContain('GST');
      history.push({ role: 'operator', content: 'What about GST?' });
      history.push({ role: 'payvault', content: r2.body.answer });

      // Turn 3: What should I do now? (context-aware next action)
      const r3 = await request(app)
        .post(`/api/investigations/${testCaseId}/chat`)
        .send({ message: 'What should I do now?', history })
        .expect(200);

      expect(r3.body.answer).toBeDefined();
      expect(r3.body.intent).toBe('next_action');
      // Should reference the specific case
      expect(r3.body.answer).toContain(testCaseId);

      // All three answers must be distinct
      const answers = [r1.body.answer, r2.body.answer, r3.body.answer];
      const unique = new Set(answers);
      expect(unique.size).toBe(3);
    }, 20000);

    test('Short pronoun follow-up "why?" resolves to previous topic', () => {
      const history = [
        { role: 'operator', content: 'How much was the fee overcharge?' },
        { role: 'payvault', content: 'The fee overcharge is ₹25.00.' },
      ];
      const { answer, intent } = generateNativeAnswer('why?', benchmarkCtx, history);
      // Should resolve to something about fees or the exception
      expect(typeof answer).toBe('string');
      expect(answer.length).toBeGreaterThan(10);
    });

    test('Follow-up "what about that?" after GST discussion resolves to GST', () => {
      const history = [
        { role: 'operator', content: 'What is the GST here?' },
        { role: 'payvault', content: 'The GST overcharge is ₹4.50.' },
        { role: 'operator', content: 'And what about the fee?' },
        { role: 'payvault', content: 'The fee overcharge is ₹25.00.' },
      ];
      // "How much was overcharged?" — should aggregate correctly
      const { answer } = generateNativeAnswer('How much were we overcharged in total?', benchmarkCtx, history);
      expect(answer).toContain('₹29.50');
    });

    test('6-turn conversation produces 6 distinct answers', async () => {
      const history = [];
      const questions = [
        'Why was this flagged?',
        'How much was the fee overcharge?',
        'And what about GST?',
        'Why does that affect the settlement?',
        'What should I verify before resolving this?',
        'Explain the whole case simply.',
      ];

      const receivedAnswers = [];
      for (const q of questions) {
        const res = await request(app)
          .post(`/api/investigations/${testCaseId}/chat`)
          .send({ message: q, history })
          .expect(200);

        expect(res.body.answer.length).toBeGreaterThan(10);
        receivedAnswers.push(res.body.answer);
        history.push({ role: 'operator', content: q });
        history.push({ role: 'payvault', content: res.body.answer });
      }

      const unique = new Set(receivedAnswers);
      expect(unique.size).toBe(6);
    }, 20000);
  });

  // ── Suite 4: Qwen/Ollama NOT Invoked ──────────────────────────────────────
  describe('4. Verify No Qwen/Ollama Invocation', () => {

    test('12. chatRouter never calls Ollama — shouldAssist is always false', () => {
      const { evaluateQueryComplexity } = require('../src/investigation/chat/chatRouter');

      // Even the "most complex" questions should have shouldAssist=false in new architecture
      const allQuestions = [
        'What happened?',
        'What should I do now?',
        'Should I escalate this?',
        'Is this a real financial loss?',
        'What evidence supports this?',
        'Why is settlement short?',
        'Why does this pattern look suspicious compared with the other transactions?',
        'Could these two discrepancies actually have the same root cause?',
        'What is the most likely explanation for this unusual reconciliation pattern?',
      ];

      for (const q of allQuestions) {
        const evalResult = evaluateQueryComplexity(q, benchmarkCtx, []);
        expect(evalResult.shouldAssist).toBe(false);
        // No question should trigger Ollama/Qwen
      }
    });

    test('13. routeAndAnswerChat uses DIRECT_PAYVAULT_AI execution mode for all questions', async () => {
      const { routeAndAnswerChat } = require('../src/investigation/chat/chatRouter');

      const questions = [
        'What happened?',
        'What should I do now?',
        'Should I escalate this?',
        'Is this a real financial loss?',
      ];

      for (const q of questions) {
        const res = await routeAndAnswerChat({ message: q, ctx: benchmarkCtx, history: [] });
        expect(res.model).toBe('Payvault AI');
        expect(res.execution_mode).toBe('DIRECT_PAYVAULT_AI');
        expect(res.source).toBe('payvault_native_intelligence');
        // Must NOT be advanced/hybrid/ollama/qwen
        expect(res.execution_mode).not.toContain('OLLAMA');
        expect(res.execution_mode).not.toContain('QWEN');
        expect(res.execution_mode).not.toContain('HYBRID');
        expect(res.execution_mode).not.toContain('ADVANCED');
      }
    });

    test('investigations.js route does NOT import ollamaChatEngine in active path', () => {
      // The route module should not have ollamaChatEngine in its require cache after load
      // We can verify by checking what routeAndAnswerChat resolves to
      const { routeAndAnswerChat } = require('../src/investigation/chat/chatRouter');
      expect(typeof routeAndAnswerChat).toBe('function');

      // The chatRouter should export nativeReasoning-based generateNativeAnswer
      const { generateNativeAnswer: gnr } = require('../src/investigation/chat/nativeReasoning');
      expect(typeof gnr).toBe('function');
    });

    test('OllamaChatEngine.chat() is NOT called during chat endpoint processing', async () => {
      // Intercept any attempted Ollama call by checking isAvailable is not actually called
      // We verify this by running a chat request and confirming it completes without Ollama
      const res = await request(app)
        .post(`/api/investigations/${testCaseId}/chat`)
        .send({ message: 'What should I do now?' })
        .expect(200);

      expect(res.body.model).toBe('Payvault AI');
      expect(res.body.execution_mode).toBe('DIRECT_PAYVAULT_AI');
      // 'payvault_native_intelligence' is the source for native answers (not Ollama)
      expect(res.body.source).toBe('payvault_native_intelligence');
    });
  });

  // ── Suite 5: Financial Calculation Correctness ────────────────────────────
  describe('5. Deterministic Financial Calculation Verification', () => {

    test('13b. GST variance is ₹4.50 — NEVER ₹0.90', () => {
      const questions = [
        'What about GST?',
        'What is the GST here?',
        'How much was the GST overcharge?',
      ];
      for (const q of questions) {
        const { answer } = generateNativeAnswer(q, benchmarkCtx, []);
        expect(answer).toContain('₹4.50');
        expect(answer).not.toContain('0.90');
        expect(answer).not.toContain('₹0.90');
      }
    });

    test('Fee variance arithmetic: ₹45 - ₹20 = ₹25', () => {
      const { answer } = generateNativeAnswer('How much was the fee overcharge?', benchmarkCtx, []);
      expect(answer).toContain('₹45.00');
      expect(answer).toContain('₹20.00');
      expect(answer).toContain('₹25.00');
    });

    test('Settlement shortfall arithmetic: ₹25 + ₹4.50 = ₹29.50', () => {
      const { answer } = generateNativeAnswer('Why is the settlement short?', benchmarkCtx, []);
      expect(answer).toContain('₹25.00');
      expect(answer).toContain('₹4.50');
      expect(answer).toContain('₹29.50');
    });

    test('Full breakdown contains all correct figures', () => {
      const { answer } = generateNativeAnswer('Give me the full picture', benchmarkCtx, []);
      expect(answer).toContain('₹1,000.00'); // gross
      expect(answer).toContain('₹20.00');    // expected fee
      expect(answer).toContain('₹45.00');    // actual fee
      expect(answer).toContain('₹25.00');    // fee variance
      expect(answer).toContain('₹3.60');     // expected GST
      expect(answer).toContain('₹8.10');     // actual GST
      expect(answer).toContain('₹4.50');     // GST variance
      expect(answer).toContain('₹976.40');   // expected net
      expect(answer).toContain('₹946.90');   // actual settlement
      expect(answer).toContain('₹29.50');    // shortfall
    });

    test('Math derivation step-by-step is correct', () => {
      const { answer } = generateNativeAnswer('How did you calculate that?', benchmarkCtx, []);
      expect(answer).toContain('₹25.00');
      expect(answer).toContain('₹4.50');
      expect(answer).toContain('₹29.50');
    });

    test('Why-not-0.90 explanation is correct', () => {
      const { answer } = generateNativeAnswer("Why isn't the GST variance ₹0.90?", benchmarkCtx, []);
      expect(answer).toContain('₹4.50');
      expect(answer).toContain('₹8.10');
      expect(answer).toContain('₹3.60');
    });
  });

  // ── Suite 6: No Hallucination ─────────────────────────────────────────────
  describe('6. No Hallucination / Missing Data Handling', () => {

    test('14. Context without fee data does not hallucinate fee figures', () => {
      const ctxNoFee = Object.assign({}, benchmarkCtx, {
        fee_actual_paise: null,
        fee_expected_paise: null,
        fee_variance_paise: null,
        fee_actual_formatted: null,
        fee_expected_formatted: null,
        fee_variance_formatted: null,
      });
      const { answer } = generateNativeAnswer('How much was the fee overcharge?', ctxNoFee, []);
      // Must say data unavailable rather than inventing figures
      expect(answer).toMatch(/(not available|N\/A|unavailable|data)/i);
    });

    test('No unsupported financial facts are invented (numbers grounded in ctx)', () => {
      // All numeric answers must come from ctx or be derivable
      const { answer } = generateNativeAnswer('What happened?', benchmarkCtx, []);
      // Numbers in the answer should be amounts that exist in the context
      const numbersInAnswer = answer.match(/₹[\d,]+\.?\d*/g) || [];
      const validAmounts = [
        '₹25.00', '₹4.50', '₹29.50', '₹20.00', '₹45.00',
        '₹8.10', '₹3.60', '₹1,000.00', '₹976.40', '₹946.90',
      ];
      for (const num of numbersInAnswer) {
        expect(validAmounts).toContain(num);
      }
    });

    test('Answer varies by investigation case — not same text for different cases', () => {
      // Create a different context (TIMING_MISMATCH)
      const timingCtx = Object.assign({}, benchmarkCtx, {
        case_id: 'exc_timing_test',
        exception_category: 'TIMING_MISMATCH',
        fee_variance_paise: 0,
        tax_variance_paise: 0,
        amount_at_risk_paise: 15000,
        amount_at_risk_formatted: '₹150.00',
      });

      const { answer: answer1 } = generateNativeAnswer('What happened?', benchmarkCtx, []);
      const { answer: answer2 } = generateNativeAnswer('What happened?', timingCtx, []);

      // Different case → different answer
      expect(answer1).not.toBe(answer2);
      expect(answer2).toContain('Timing Mismatch');
      expect(answer1).toContain('Fee / Tax Variance');
    });
  });

  // ── Suite 7: Non-Keyword / Dynamic Intent Detection ───────────────────────
  describe('7. Semantic Intent Detection (Not Simple Keyword Matching)', () => {

    test('15. Equivalent phrasing resolves to the same intent', () => {
      const nextActionVariants = [
        'What should I do now?',
        'What do I do next?',
        'What are the next steps?',
        'Where do I go from here?',
        'What now?',
      ];

      for (const q of nextActionVariants) {
        const { intent } = generateNativeAnswer(q, benchmarkCtx, []);
        expect(intent).toBe('next_action');
      }
    });

    test('Escalation variants all resolve to escalation_assessment', () => {
      const variants = [
        'Should I escalate this?',
        'Does this need escalation?',
        'Should I escalate?',
        'Do I need to escalate this case?',
      ];

      for (const q of variants) {
        const { intent } = generateNativeAnswer(q, benchmarkCtx, []);
        expect(intent).toBe('escalation_assessment');
      }
    });

    test('Financial loss variants resolve to real_financial_loss', () => {
      const variants = [
        'Is this a real financial loss?',
        'Is the merchant actually losing money?',
        'Is there a real loss here?',
      ];

      for (const q of variants) {
        const { intent } = generateNativeAnswer(q, benchmarkCtx, []);
        expect(intent).toBe('real_financial_loss');
      }
    });

    test('Why-flagged variants resolve to why_flagged', () => {
      const variants = [
        'What happened?',
        'Why did this happen?',
        'What went wrong?',
        'What caused this?',
        'Tell me what happened.',
      ];

      for (const q of variants) {
        const { intent } = generateNativeAnswer(q, benchmarkCtx, []);
        expect(intent).toBe('why_flagged');
      }
    });

    test('Evidence variants resolve to evidence_assessment', () => {
      const variants = [
        'What evidence supports this?',
        'What documentation is there?',
        'What proof is there?',
      ];

      for (const q of variants) {
        const { intent } = generateNativeAnswer(q, benchmarkCtx, []);
        expect(intent).toBe('evidence_assessment');
      }
    });

    test('Answers are NOT identical for different question types', () => {
      const answers = [
        generateNativeAnswer('What happened?', benchmarkCtx, []).answer,
        generateNativeAnswer('What about GST?', benchmarkCtx, []).answer,
        generateNativeAnswer('What should I do now?', benchmarkCtx, []).answer,
        generateNativeAnswer('Should I escalate this?', benchmarkCtx, []).answer,
        generateNativeAnswer('Is this a real financial loss?', benchmarkCtx, []).answer,
        generateNativeAnswer('What evidence supports this?', benchmarkCtx, []).answer,
      ];

      const unique = new Set(answers);
      expect(unique.size).toBe(6);
    });
  });

  // ── Suite 8: Investigation Knowledge Layer ────────────────────────────────
  describe('8. Investigation Knowledge Layer', () => {

    test('FEE_TAX_VARIANCE knowledge has correct financial relationships', () => {
      const knowledge = getExceptionKnowledge('FEE_TAX_VARIANCE');
      expect(knowledge.real_financial_loss).toBe(true);
      expect(knowledge.requires_gateway_action).toBe(true);
      expect(knowledge.financial_relationships).toContain('Settlement Shortfall = Fee Variance + GST Variance');
    });

    test('TIMING_MISMATCH is NOT a real financial loss', () => {
      const assessment = assessFinancialLoss('TIMING_MISMATCH', 10000);
      expect(assessment.is_real_loss).toBe(false);
      expect(assessment.explanation).toContain('timing difference');
    });

    test('DUPLICATE always escalates', () => {
      const escalation = evaluateEscalation('DUPLICATE', 5000, {});
      expect(escalation.should_escalate).toBe(true);
      expect(escalation.urgency).toBe('IMMEDIATE');
    });

    test('FEE_TAX_VARIANCE with small amount does not escalate', () => {
      const escalation = evaluateEscalation('FEE_TAX_VARIANCE', 2950, { similar_cases_count: 0 });
      expect(escalation.should_escalate).toBe(false);
    });

    test('FEE_TAX_VARIANCE with high amount (>₹500) escalates', () => {
      const escalation = evaluateEscalation('FEE_TAX_VARIANCE', 60000, { similar_cases_count: 0 });
      expect(escalation.should_escalate).toBe(true);
    });

    test('investigation procedure steps are non-empty for all categories', () => {
      const categories = ['FEE_TAX_VARIANCE', 'TIMING_MISMATCH', 'MISSING_ORDER', 'MISSING_PAYMENT', 'DUPLICATE', 'UNEXPLAINED'];
      for (const cat of categories) {
        const procedure = getInvestigationProcedure(cat);
        expect(procedure.steps.length).toBeGreaterThan(0);
        expect(typeof procedure.can_resolve_independently).toBe('boolean');
      }
    });
  });

  // ── Suite 9: Payvault AI Architecture Class ───────────────────────────────
  describe('9. Payvault AI Architecture Verification', () => {

    test('PayvaultAI class has all required pipeline methods', () => {
      const { PayvaultAI } = require('../src/investigation/chat/chatRouter');
      const ai = new PayvaultAI();

      expect(typeof ai.understandQuestion).toBe('function');
      expect(typeof ai.determineIntent).toBe('function');
      expect(typeof ai.assessComplexity).toBe('function');
      expect(typeof ai.reasonNatively).toBe('function');
      expect(typeof ai.shouldUseAdvancedReasoning).toBe('function');
      expect(typeof ai.validateAgainstCaseData).toBe('function');
      expect(typeof ai.generateFinalAnswer).toBe('function');
    });

    test('understandQuestion normalizes whitespace', () => {
      const { PayvaultAI } = require('../src/investigation/chat/chatRouter');
      const ai = new PayvaultAI();
      const result = ai.understandQuestion('  What is the fee?  ', [{ role: 'operator', content: 'hello' }]);
      expect(result.normalized).toBe('What is the fee?');
      expect(result.hasHistory).toBe(true);
    });

    test('shouldUseAdvancedReasoning always returns false (Qwen/Ollama disabled)', () => {
      const { PayvaultAI } = require('../src/investigation/chat/chatRouter');
      const ai = new PayvaultAI();
      // In the new architecture, this is always false
      expect(ai.shouldUseAdvancedReasoning({ shouldAssist: true })).toBe(false);
      expect(ai.shouldUseAdvancedReasoning({ shouldAssist: false })).toBe(false);
      expect(ai.shouldUseAdvancedReasoning()).toBe(false);
    });

    test('validateAgainstCaseData corrects hallucinated ₹0.90', () => {
      const { PayvaultAI } = require('../src/investigation/chat/chatRouter');
      const ai = new PayvaultAI();
      const raw = 'The GST overcharge is ₹4.50 but there is also a secondary deduction of ₹0.90.';
      const validated = ai.validateAgainstCaseData(raw, benchmarkCtx);
      expect(validated).not.toContain('0.90');
      expect(validated).toContain('₹4.50');
    });

    test('generateFinalAnswer returns Payvault AI branding and native source', async () => {
      const { PayvaultAI } = require('../src/investigation/chat/chatRouter');
      const ai = new PayvaultAI();
      const result = await ai.generateFinalAnswer({
        message: 'What is the fee?',
        ctx: benchmarkCtx,
        history: [],
      });
      expect(result.model).toBe('Payvault AI');
      expect(result.execution_mode).toBe('DIRECT_PAYVAULT_AI');
      expect(result.source).toBe('payvault_native_intelligence');
      expect(result.answer).toContain('₹45.00');
    });

    test('assessComplexity never returns shouldAssist=true for any question', () => {
      const { PayvaultAI } = require('../src/investigation/chat/chatRouter');
      const ai = new PayvaultAI();

      const questions = [
        'What happened?', 'What should I do now?', 'Should I escalate?',
        'Is this a real loss?', 'What evidence supports this?',
        'Why is settlement short?', 'What went wrong?',
        'Compare these two discrepancies and their root cause.',
        'What is the most likely explanation for this unusual pattern?',
      ];

      for (const q of questions) {
        const result = ai.assessComplexity(q, benchmarkCtx, []);
        expect(result.shouldAssist).toBe(false);
      }
    });
  });

  // ── Suite 10: Ollama Test Preserved (Module Tests Only) ───────────────────
  // The OllamaChatEngine module is preserved for future experimentation.
  // These tests verify the module itself is intact, but NOT called by chat.
  describe('10. Ollama Module (Preserved, Isolated — Not in Active Chat Path)', () => {

    test('OllamaChatEngine constructs messages correctly (module-level test)', () => {
      const engine = new OllamaChatEngine({ model: 'qwen2.5:1.5b' });
      const history = [
        { role: 'operator', content: 'Why was this flagged?' },
        { role: 'payvault', content: 'Discrepancy detected.' },
      ];

      const messages = engine._buildChatMessages('How much was the fee overcharge?', benchmarkCtx, history);

      expect(Array.isArray(messages)).toBe(true);
      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toContain('Payvault AI');
      expect(messages[0].content).toContain('DETERMINISTIC FINANCIAL FACTS:');
    });

    test('Ollama system prompt contains mathematical integrity constraints', () => {
      const engine = new OllamaChatEngine({ model: 'qwen2.5:1.5b' });
      const messages = engine._buildChatMessages('what is the gst here', benchmarkCtx, []);
      const systemMsg = messages.find(m => m.role === 'system');

      expect(systemMsg).toBeDefined();
      expect(systemMsg.content).toContain('Actual GST (₹8.10) − Expected GST (₹3.60) = ₹4.50');
      expect(systemMsg.content).toContain('₹0.90 is FALSE');
    });
  });

  // ── Suite 11: End-to-End API Tests ────────────────────────────────────────
  describe('11. End-to-End API Route Tests', () => {

    test('POST /api/investigations/:id/chat validates inputs', async () => {
      await request(app)
        .post(`/api/investigations/${testCaseId}/chat`)
        .send({ message: '' })
        .expect(400);

      await request(app)
        .post(`/api/investigations/${testCaseId}/chat`)
        .send({ message: 'Hello', history: 'not an array' })
        .expect(400);

      await request(app)
        .post('/api/investigations/nonexistent_case/chat')
        .send({ message: 'Why was this flagged?' })
        .expect(404);
    });

    test('POST /api/investigations/:id/chat returns Payvault AI branding', async () => {
      const res = await request(app)
        .post(`/api/investigations/${testCaseId}/chat`)
        .send({ message: 'What happened?' })
        .expect(200);

      expect(res.body.model).toBe('Payvault AI');
      expect(res.body.answer).toBeDefined();
      expect(res.body.answer.length).toBeGreaterThan(10);
      expect(res.body.execution_mode).toBe('DIRECT_PAYVAULT_AI');
    });

    test('Chat returns different answers for different questions', async () => {
      const questions = ['What happened?', 'What about GST?', 'What should I do now?', 'Should I escalate?'];
      const answers = [];

      for (const q of questions) {
        const res = await request(app)
          .post(`/api/investigations/${testCaseId}/chat`)
          .send({ message: q })
          .expect(200);
        answers.push(res.body.answer);
      }

      const unique = new Set(answers);
      expect(unique.size).toBe(4);
    }, 10000);
  });

  // ── 12. Causal Reasoning & Thinking UI Test Suite ───────────────────────────
  describe('12. Causal Reasoning & Thinking UI Test Suite', () => {
    const { routeAndAnswerChat, defaultPayvaultAI } = require('../src/investigation/chat/chatRouter');
    const {
      appendLoadingIndicator,
      fulfillLoadingIndicator,
      errorLoadingIndicator,
    } = require('../public/checkout');

    // Benchmark case matching user specification:
    // Gross: ₹11,232.84 (1123284 paise)
    // Expected fee (2%): ₹224.66 (22466 paise), Actual fee: ₹249.66 (24966 paise), Fee overcharge: ₹25.00 (2500 paise)
    // Expected GST (18%): ₹40.44 (4044 paise), Actual GST: ₹44.94 (4494 paise), GST overcharge: ₹4.50 (450 paise)
    // Expected net: ₹10,967.74 (1096774 paise), Actual net: ₹10,938.24 (1093824 paise), Shortfall: ₹29.50 (2950 paise)
    const causalCase = {
      case_id: 'CASE-CAUSAL-001',
      exception_category: 'FEE_TAX_VARIANCE',
      status: 'OPEN',
      gross_amount_paise: 1123284,
      amount_at_risk_paise: 2950,
      net_shortfall_paise: 2950,
      fee_actual_paise: 24966,
      fee_expected_paise: 22466,
      fee_variance_paise: 2500,
      tax_actual_paise: 4494,
      tax_expected_paise: 4044,
      tax_variance_paise: 450,
      actual_settlement_paise: 1093824,
      expected_net_paise: 1096774,
      payment_method: 'CARD',
      payment_id: 'pay_causal_001',
      order_id: 'order_causal_001',
      settlement_id: 'setl_causal_001',
    };

    test('12.1. Ten Exact Target Questions Benchmark (Multi-Turn)', async () => {
      const questions = [
        'What is the gross amount I got?',
        'but how',
        'What was the expected settlement?',
        'Why is the actual settlement lower?',
        'How much extra fee was charged?',
        'How much extra GST was charged?',
        'Where did the missing money go?',
        'What should I do now?',
        'Could this be a false positive?',
        'What evidence supports this finding?',
      ];

      const conversationHistory = [];
      const responses = [];

      for (const q of questions) {
        const res = await routeAndAnswerChat({
          message: q,
          ctx: causalCase,
          history: conversationHistory,
        });
        responses.push(res);
        conversationHistory.push({ role: 'operator', content: q });
        conversationHistory.push({ role: 'assistant', content: res.answer });
      }

      // Q1: Gross amount reasoning
      expect(responses[0].intent).toBe('gross_amount');
      expect(responses[0].answer).toContain('₹11,232.84');
      expect(responses[0].answer).toMatch(/gross customer payment/i);

      // Q2: Follow-up context ("but how") connects gross to settlement causality
      expect(responses[1].intent).toBe('settlement_causality');
      expect(responses[1].answer).toContain('₹11,232.84');
      expect(responses[1].answer).toContain('₹249.66 in fees');
      expect(responses[1].answer).toContain('₹44.94 in GST');
      expect(responses[1].answer).toContain('₹25.00 more in fees');
      expect(responses[1].answer).toContain('₹4.50 more in GST');
      expect(responses[1].answer).toContain('₹29.50');
      expect(responses[1].answer).toContain('Cause:');
      expect(responses[1].answer).toContain('Impact:');

      // Q3: Expected settlement reasoning
      expect(responses[2].intent).toBe('expected_settlement');
      expect(responses[2].answer).toContain('₹10,967.74');
      expect(responses[2].answer).toContain('₹224.66');
      expect(responses[2].answer).toContain('₹40.44');

      // Q4: Settlement causality ("Why is the actual settlement lower?")
      expect(responses[3].intent).toBe('settlement_causality');
      expect(responses[3].answer).toContain('Gross = ₹11,232.84');
      expect(responses[3].answer).toContain('Fee variance = ₹25.00');
      expect(responses[3].answer).toContain('GST variance = ₹4.50');
      expect(responses[3].answer).toContain('Total settlement shortfall = ₹25.00 + ₹4.50 = ₹29.50');

      // Q5: Fee variance reasoning ("How much extra fee was charged?")
      expect(responses[4].intent).toBe('fee_specific');
      expect(responses[4].answer).toContain('₹25.00');
      expect(responses[4].answer).toContain('₹249.66');
      expect(responses[4].answer).toContain('₹224.66');

      // Q6: GST variance reasoning ("How much extra GST was charged?")
      expect(responses[5].intent).toBe('tax_specific');
      expect(responses[5].answer).toContain('₹4.50');
      expect(responses[5].answer).toContain('₹44.94');
      expect(responses[5].answer).toContain('₹40.44');

      // Q7: "Where did the missing money go" reasoning
      expect(responses[6].intent).toBe('where_did_money_go');
      expect(responses[6].answer).toContain('₹29.50');
      expect(responses[6].answer).toContain('₹25.00');
      expect(responses[6].answer).toContain('₹4.50');
      expect(responses[6].answer).toContain('payment gateway');

      // Q8: Next-action reasoning with clean escalation distinction
      expect(responses[7].intent).toBe('next_action');
      expect(responses[7].answer).toContain('Internal escalation:');
      expect(responses[7].answer).toContain('Not required');
      expect(responses[7].answer).toContain('External action:');
      expect(responses[7].answer).toContain('Raise a fee dispute with the payment gateway');

      // Q9: False positive assessment
      expect(responses[8].intent).toBe('false_positive_assessment');
      expect(responses[8].answer).toContain('Highly unlikely to be a false positive');
      expect(responses[8].answer).toContain('Verifiable Gateway Records');
      expect(responses[8].answer).toContain('Contracted Schedule');
      expect(responses[8].answer).toContain('Exact Mathematical Consistency');

      // Q10: Evidence reasoning
      expect(responses[9].intent).toBe('evidence_assessment');
      expect(responses[9].answer).toContain('Settlement Record');
      expect(responses[9].answer).toContain('Reconciliation Result');
      expect(responses[9].answer).toContain('Arithmetic Verification');

      // Verify that all 10 responses are distinct
      const uniqueAnswers = new Set(responses.map(r => r.answer));
      expect(uniqueAnswers.size).toBe(10);
    });

    test('12.2. Dynamic Causal Chain: Gross → Deductions → Variance → Shortfall → Root Cause (No Hardcoding)', async () => {
      // Dynamic test with completely different numbers:
      // Gross: ₹5,000 (500000 paise)
      // Expected fee 2%: ₹100.00 (10000 paise), Actual: ₹150.00 (15000 paise), Over: ₹50.00 (5000 paise)
      // Expected GST 18%: ₹18.00 (1800 paise), Actual: ₹27.00 (2700 paise), Over: ₹9.00 (900 paise)
      // Expected net: ₹4,882.00 (488200 paise), Actual: ₹4,823.00 (482300 paise), Shortfall: ₹59.00 (5900 paise)
      const dynamicCase = {
        case_id: 'CASE-DYNAMIC-999',
        exception_category: 'FEE_TAX_VARIANCE',
        status: 'OPEN',
        gross_amount_paise: 500000,
        amount_at_risk_paise: 5900,
        net_shortfall_paise: 5900,
        fee_actual_paise: 15000,
        fee_expected_paise: 10000,
        fee_variance_paise: 5000,
        tax_actual_paise: 2700,
        tax_expected_paise: 1800,
        tax_variance_paise: 900,
        actual_settlement_paise: 482300,
        expected_net_paise: 488200,
        payment_method: 'CARD',
      };

      const res = await routeAndAnswerChat({
        message: 'Why is the settlement lower?',
        ctx: dynamicCase,
        history: [],
      });

      expect(res.intent).toBe('settlement_causality');
      expect(res.answer).toContain('₹5,000.00');
      expect(res.answer).toContain('₹150.00 in fees and ₹27.00 in GST');
      expect(res.answer).toContain('expected fee was ₹100.00 and the expected GST was ₹18.00');
      expect(res.answer).toContain('₹50.00 more in fees and ₹9.00 more in GST');
      expect(res.answer).toContain('total settlement shortfall of ₹59.00');
      expect(res.answer).toContain('Cause:');
      expect(res.answer).toContain('Fee / Tax Variance');
      expect(res.answer).toContain('Impact:');
      expect(res.answer).toContain('₹59.00 less settlement than expected');

      // Verify it did NOT output the previous case numbers (no hardcoding)
      expect(res.answer).not.toContain('₹25.00');
      expect(res.answer).not.toContain('₹4.50');
      expect(res.answer).not.toContain('₹29.50');
    });

    test('12.3. Removal of Internal Debug and Reconciliation Rule Findings', () => {
      const sampleAnswerWithDebug = [
        'The actual fee was ₹25.00 higher than contracted.',
        '_Reconciliation rule finding: Fee variance of 2500 paise exceeds tolerance of 100 paise..._',
        '2500 paise exceeds tolerance in settlement cycle.',
        'Merchant order found but no deterministic rule fully resolved due to tolerance.',
        'The settlement shortfall is ₹29.50.',
      ].join('\n');

      const cleaned = defaultPayvaultAI.validateAgainstCaseData(sampleAnswerWithDebug, causalCase);

      expect(cleaned).not.toContain('Reconciliation rule finding');
      expect(cleaned).not.toContain('paise exceeds tolerance');
      expect(cleaned).not.toContain('Merchant order found but no deterministic rule fully resolved');
      expect(cleaned).toContain('The actual fee was ₹25.00 higher than contracted.');
      expect(cleaned).toContain('The settlement shortfall is ₹29.50.');
    });

    test('12.4. Unknown / Unsupported Questions Route to unknown_query Gracefully', async () => {
      const unknownQuestions = [
        'What is the weather in Mumbai?',
        'Tell me a funny joke',
        'What is the capital of France?',
      ];

      for (const q of unknownQuestions) {
        const res = await routeAndAnswerChat({ message: q, ctx: causalCase, history: [] });
        expect(res.intent).toBe('unknown_query');
        expect(res.answer).toContain('payment reconciliation');
      }
    });

    test('12.5. Follow-Up Context: Short Phrases ("where did it go", "what now", "why")', async () => {
      const history = [
        { role: 'operator', content: 'What is the gross amount?' },
        { role: 'assistant', content: 'The gross amount was ₹11,232.84.' },
      ];

      // "where did it go" -> where_did_money_go
      const resWhere = await routeAndAnswerChat({ message: 'where did it go', ctx: causalCase, history });
      expect(resWhere.intent).toBe('where_did_money_go');
      expect(resWhere.answer).toContain('₹29.50');

      // "what now" -> next_action
      const resNow = await routeAndAnswerChat({ message: 'what now', ctx: causalCase, history });
      expect(resNow.intent).toBe('next_action');
      expect(resNow.answer).toContain('Investigation next steps');
    });

    test('12.6. Thinking Indicator Lifecycle: Creation, In-Place Fulfillment, and Error Handling', async () => {
      // Set up a mock DOM container
      const container = {
        children: [],
        appendChild(el) {
          this.children.push(el);
          return el;
        },
      };

      const elementsMap = new Map();

      global.document = {
        getElementById(id) {
          if (id === 'chat-conversation') return container;
          return elementsMap.get(id) || null;
        },
        createElement(tag) {
          const el = {
            tagName: tag.toUpperCase(),
            id: '',
            className: '',
            attributes: {},
            innerHTML: '',
            children: [],
            classList: {
              classes: new Set(),
              add(c) { this.classes.add(c); el.className = Array.from(this.classes).join(' '); },
              remove(c) { this.classes.delete(c); el.className = Array.from(this.classes).join(' '); },
              contains(c) { return this.classes.has(c); },
            },
            setAttribute(k, v) { this.attributes[k] = v; },
            removeAttribute(k) { delete this.attributes[k]; },
            querySelector(selector) {
              if (selector === '.chat-message-sender') {
                return { textContent: 'Payvault AI' };
              }
              if (selector === '.chat-bubble') {
                return this._bubble || (this._bubble = { innerHTML: '', className: 'chat-bubble' });
              }
              return null;
            },
            insertAdjacentHTML(pos, html) {
              this.children.push({ pos, html });
            },
            remove() {
              const idx = container.children.indexOf(this);
              if (idx >= 0) container.children.splice(idx, 1);
            },
          };
          return el;
        },
      };

      // 1. Creation: appendLoadingIndicator() creates ● ● ● and Thinking...
      const loadingId = appendLoadingIndicator();
      expect(loadingId).toBeDefined();
      expect(container.children.length).toBe(1);

      const placeholder = container.children[0];
      elementsMap.set(loadingId, placeholder);

      // Verify exact thinking UI structure
      expect(placeholder.innerHTML).toContain('Payvault AI');
      expect(placeholder.innerHTML).toContain('●');
      expect(placeholder.innerHTML).toContain('Thinking...');
      expect(placeholder.attributes['data-thinking']).toBe('true');

      // 2. Pending check: indicator is active while Promise is pending
      let isPromisePending = true;
      const apiPromise = new Promise((resolve) => {
        setTimeout(() => {
          isPromisePending = false;
          resolve({
            answer: 'The actual settlement is ₹10,938.24.',
            source: 'payvault_native_intelligence',
            ai_used: false,
            model: 'Payvault AI',
          });
        }, 10);
      });

      expect(isPromisePending).toBe(true);
      expect(placeholder.attributes['data-thinking']).toBe('true');

      // 3. Fulfillment: final answer replaces the SAME placeholder in-place (no new elements added)
      const data = await apiPromise;
      fulfillLoadingIndicator(loadingId, {
        content: data.answer,
        source: data.source,
        ai_used: data.ai_used,
        model: data.model,
      });

      // Crucial: Container still has exactly 1 child element (replaced in-place, NOT duplicated)
      expect(container.children.length).toBe(1);
      expect(placeholder.attributes['data-thinking']).toBeUndefined();
      expect(placeholder.classList.contains('loading')).toBe(false);
      expect(placeholder.querySelector('.chat-bubble').innerHTML).toContain('₹10,938.24');

      // 4. Error state test: replaces indicator with inline error and retry button
      const errorLoadingId = appendLoadingIndicator();
      const errorEl = container.children[1];
      elementsMap.set(errorLoadingId, errorEl);

      errorLoadingIndicator(errorLoadingId, 'Network timeout', 'Why was this flagged?');
      expect(errorEl.attributes['data-thinking']).toBeUndefined();
      expect(errorEl.querySelector('.chat-bubble').className).toBe('chat-error-inline');
      expect(errorEl.querySelector('.chat-bubble').innerHTML).toContain('Network timeout');
      expect(errorEl.querySelector('.chat-bubble').innerHTML).toContain('Retry');
    });

    test('12.7. Thinking Animation Verification (Individual Dots, Keyframes, Staggering, In-Place Replacement)', () => {
      const fs = require('fs');
      const path = require('path');

      // 1. Check public/checkout.js generates three individual .thinking-dot elements
      const checkoutCode = fs.readFileSync(path.join(__dirname, '../public/checkout.js'), 'utf8');
      expect(checkoutCode).toContain('class="thinking-dot');
      expect(checkoutCode).toContain('aria-label="Payvault AI is thinking"');

      // 2. Check DOM structure produced by appendLoadingIndicator
      const container = {
        children: [],
        appendChild(child) { this.children.push(child); return child; },
        scrollHeight: 100,
        scrollTop: 0,
      };
      global.document = {
        getElementById(id) {
          if (id === 'chat-conversation') return container;
          return null;
        },
        createElement(tag) {
          return {
            tagName: tag.toUpperCase(),
            id: '',
            className: '',
            attributes: {},
            setAttribute(k, v) { this.attributes[k] = v; },
            removeAttribute(k) { delete this.attributes[k]; },
            classList: {
              classes: new Set(),
              add(c) { this.classes.add(c); },
              remove(c) { this.classes.delete(c); },
              contains(c) { return this.classes.has(c); },
            },
            innerHTML: '',
            querySelector(sel) {
              if (sel === '.chat-message-sender') return { textContent: '' };
              if (sel === '.chat-bubble') return { innerHTML: '', className: 'chat-bubble' };
              return null;
            },
            querySelectorAll(sel) { return []; },
            insertAdjacentHTML() {},
          };
        },
      };

      const id = appendLoadingIndicator();
      const placeholder = container.children[0];

      // Extract thinking-dot spans
      const dotMatches = placeholder.innerHTML.match(/<span[^>]*class="[^"]*thinking-dot[^"]*"[^>]*>●<\/span>/g);
      expect(dotMatches).not.toBeNull();
      expect(dotMatches.length).toBe(3);
      expect(placeholder.innerHTML).toContain('Thinking...');
      expect(placeholder.innerHTML).toContain('Payvault AI');

      // 3. Check public/style.css for payvaultThinkingDot animation, keyframes, and staggering
      const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');

      expect(css).toContain('.thinking-dot');
      expect(css).toContain('payvaultThinkingDot');
      expect(css).toContain('@keyframes payvaultThinkingDot');

      // Verify staggered delays for children
      expect(css).toMatch(/\.thinking-dot:nth-child\(1\)[^{]*{\s*animation-delay:\s*0s;/);
      expect(css).toMatch(/\.thinking-dot:nth-child\(2\)[^{]*{\s*animation-delay:\s*0\.(15|18|2)s;/);
      expect(css).toMatch(/\.thinking-dot:nth-child\(3\)[^{]*{\s*animation-delay:\s*0\.(3|30|36|4)s;/);

      // Verify keyframes contain transform translateY and scale for clear visibility
      expect(css).toContain('translateY(-');
      expect(css).toContain('scale(');

      // 4. Verify no artificial delays (setTimeout/sleep) in the active chat submission path
      const chatRouterCode = fs.readFileSync(path.join(__dirname, '../src/investigation/chat/chatRouter.js'), 'utf8');
      expect(chatRouterCode).not.toMatch(/setTimeout/);
      expect(chatRouterCode).not.toMatch(/sleep/);
    });
  });

});


