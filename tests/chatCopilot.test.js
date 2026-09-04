'use strict';
/**
 * tests/chatCopilot.test.js
 *
 * Test suite for the Conversational Investigation Copilot.
 * Validates dynamic reasoning, multi-turn conversation memory, cause-and-effect
 * arithmetic, adaptive response depth, and state modification safeguards.
 */

const request = require('supertest');
const app     = require('../server');
const store   = require('../src/store/dataStore');
const { buildChatContext } = require('../src/investigation/chat/chatContextBuilder');
const { generateLocalAnswer, analyzeIntent } = require('../src/investigation/chat/localChatEngine');
const { OllamaChatEngine } = require('../src/investigation/chat/ollamaChatEngine');
const { buildCase } = require('../src/investigation/caseBuilder');
const { buildIntelligenceContext } = require('../src/investigation/intelligence/context');

describe('Conversational Investigation Copilot Suite', () => {

  let testCaseId;
  let testCtx;

  beforeAll(() => {
    store.reset(); // Benchmark synthetic dataset
    const s = store.getStore();
    // Find a FEE_TAX_VARIANCE exception
    const feeEx = s.exceptions.find(e => (e.category || e.exception_category) === 'FEE_TAX_VARIANCE');
    expect(feeEx).toBeDefined();
    testCaseId = feeEx.id;

    const reconResult = s.reconciliationResults.find(r => r.id === feeEx.reconciliation_result_id);
    const investigationCase = buildCase({ exception: feeEx, reconResult, store: s });
    const lifecycle = store.getCaseLifecycle(testCaseId);
    const intelligenceContext = buildIntelligenceContext({ investigationCase, store: s });
    const savedAi = store.getAiInvestigation(testCaseId);

    testCtx = buildChatContext({
      investigationCase,
      lifecycle,
      intelligenceContext,
      savedAi,
    });
  });

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

  describe('2. Multi-turn Conversational Reasoning (Local Copilot)', () => {
    test('Why was this flagged? — returns root cause without full table dump', () => {
      const { answer, intent } = generateLocalAnswer('Why was this flagged?', testCtx, []);
      expect(intent).toBe('why_flagged');
      expect(answer).toContain('Fee / Tax Variance');
      expect(answer).toContain('Fee charged:');
      expect(answer).toContain('GST charged:');
      // Should NOT dump the complete table header
      expect(answer).not.toContain('Complete Financial Breakdown');
    });

    test('How much was the fee overcharge? — returns targeted fee figure', () => {
      const { answer, intent } = generateLocalAnswer('How much was the fee overcharge?', testCtx, []);
      expect(intent).toBe('fee_specific');
      expect(answer).toContain('platform fee');
      expect(answer).toContain(testCtx.fee_actual_formatted);
      expect(answer).toContain(testCtx.fee_expected_formatted);
      expect(answer).not.toContain('Expected net to merchant');
    });

    test('And what about GST? — resolves conversational follow-up to tax variance', () => {
      const history = [
        { role: 'operator', content: 'How much was the fee overcharge?' },
        { role: 'payvault', content: 'The platform fee overcharge is ₹25.00.' },
      ];
      const { answer, intent } = generateLocalAnswer('And what about GST?', testCtx, history);
      expect(intent).toBe('tax_specific');
      expect(answer).toContain('GST');
      expect(answer).toContain(testCtx.tax_actual_formatted);
      expect(answer).toContain(testCtx.tax_expected_formatted);
    });

    test('Why does that affect the settlement? — explains deduction causality', () => {
      const history = [
        { role: 'operator', content: 'How much was the fee overcharge?' },
        { role: 'payvault', content: 'The fee overcharge is ₹25.00.' },
        { role: 'operator', content: 'And what about GST?' },
        { role: 'payvault', content: 'The GST overcharge is ₹4.50.' },
      ];
      const { answer, intent } = generateLocalAnswer('Why does that affect the settlement?', testCtx, history);
      expect(intent).toBe('settlement_causality');
      expect(answer).toContain('Net Settlement = Gross Amount − Gateway Fee − GST');
      expect(answer).toContain('excess deductions');
      expect(answer).toContain(testCtx.actual_settlement_formatted);
    });

    test('What should I verify before resolving this? — returns actionable checklist', () => {
      const { answer, intent } = generateLocalAnswer('What should I verify before resolving this?', testCtx, []);
      expect(intent).toBe('what_to_verify');
      expect(answer).toContain('verify the following:');
      expect(answer).toContain('Resolve');
    });

    test('Explain the whole case simply. — returns accessible plain-language narrative', () => {
      const { answer, intent } = generateLocalAnswer('Explain the whole case simply.', testCtx, []);
      expect(intent).toBe('simple_explanation');
      expect(answer).toContain('Simple Explanation');
      expect(answer).toContain(testCtx.gross_amount_formatted);
      expect(answer).toContain('leaving');
    });

    test('Give me the full picture — provides complete financial breakdown', () => {
      const { answer, intent } = generateLocalAnswer('Give me the full picture', testCtx, []);
      expect(intent).toBe('full_financial_breakdown');
      expect(answer).toContain('Complete Financial Breakdown');
      expect(answer).toContain('• **Gross Customer Amount:**');
      expect(answer).toContain('• **Expected Platform Fee (2.0%):**');
      expect(answer).toContain('• **Actual Platform Fee Charged:**');
      expect(answer).toContain('• **Expected GST (18.0% of fee):**');
      expect(answer).toContain('• **Actual GST Charged:**');
      expect(answer).toContain('• **Expected Net Settlement:**');
      expect(answer).toContain('• **Actual Settlement Received:**');
    });

    test('State change guard blocks resolution through chat', () => {
      const { answer, intent } = generateLocalAnswer('Please resolve this case now', testCtx, []);
      expect(intent).toBe('state_change_guard');
      expect(answer).toContain('case status changes cannot be performed through chat');
      expect(answer).toContain('human audit controls');
    });

    test('Answers to 6 key questions are meaningfully distinct and non-identical', () => {
      const q1 = generateLocalAnswer('Why was this flagged?', testCtx, []);
      const q2 = generateLocalAnswer('How much was the fee overcharge?', testCtx, []);
      const q3 = generateLocalAnswer('And what about GST?', testCtx, []);
      const q4 = generateLocalAnswer('Why does that affect the settlement?', testCtx, []);
      const q5 = generateLocalAnswer('What should I verify before resolving this?', testCtx, []);
      const q6 = generateLocalAnswer('Explain the whole case simply.', testCtx, []);

      const answers = [q1.answer, q2.answer, q3.answer, q4.answer, q5.answer, q6.answer];
      const uniqueAnswers = new Set(answers);

      expect(uniqueAnswers.size).toBe(6); // Every single answer MUST be unique!
    });
  });

  describe('3. Ollama Chat Message Construction', () => {
    test('constructs structured system, history, and user messages for /api/chat', () => {
      const engine = new OllamaChatEngine({ model: 'qwen2.5:1.5b' });
      const history = [
        { role: 'operator', content: 'Why was this flagged?' },
        { role: 'payvault', content: 'Discrepancy detected.' },
      ];

      const messages = engine._buildChatMessages('How much was the fee overcharge?', testCtx, history);

      expect(Array.isArray(messages)).toBe(true);
      expect(messages.length).toBe(4); // system + user + assistant + user

      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toContain('Payvault AI');
      expect(messages[0].content).toContain(testCtx.case_id);
      expect(messages[0].content).toContain('DETERMINISTIC FINANCIAL FACTS:');

      expect(messages[1].role).toBe('user');
      expect(messages[1].content).toBe('Why was this flagged?');

      expect(messages[2].role).toBe('assistant');
      expect(messages[2].content).toBe('Discrepancy detected.');

      expect(messages[3].role).toBe('user');
      expect(messages[3].content).toBe('How much was the fee overcharge?');
    });
  });

  describe('4. End-to-End Chat API Route (POST /api/investigations/:id/chat)', () => {
    test('handles conversation flow with history continuity', async () => {
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

        expect(res.body.case_id).toBe(testCaseId);
        expect(typeof res.body.answer).toBe('string');
        expect(res.body.answer.length).toBeGreaterThan(10);
        expect(res.body.model).toBeDefined();
        expect(res.body.source).toBeDefined();

        receivedAnswers.push(res.body.answer);
        history.push({ role: 'operator', content: q });
        history.push({ role: 'payvault', content: res.body.answer });
      }

      // Ensure every turn gave a distinct answer
      const uniqueAnswers = new Set(receivedAnswers);
      expect(uniqueAnswers.size).toBe(6);
    }, 30000);

    test('validates bad request inputs', async () => {
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
  });

  describe('5. Benchmark Case Investigation & Arithmetic Reasoning (Gross ₹1,000, Fee ₹45, GST ₹8.10)', () => {
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
      amount_at_risk_paise: 2950,

      gross_amount_formatted: '₹1,000.00',
      expected_net_formatted: '₹976.40',
      actual_settlement_formatted: '₹946.90',
      fee_expected_formatted: '₹20.00',
      fee_actual_formatted: '₹45.00',
      fee_variance_formatted: '₹25.00',
      tax_expected_formatted: '₹3.60',
      tax_actual_formatted: '₹8.10',
      tax_variance_formatted: '₹4.50',
      net_shortfall_formatted: '₹29.50',
      amount_at_risk_formatted: '₹29.50',

      suggested_actions: [
        { priority: 'HIGH', description: 'Verify gateway contract fee schedule against actual settlement deduction.' },
        { priority: 'HIGH', description: 'Request fee correction credit from the payment gateway.' }
      ]
    };

    test('what is the gst here — derives ₹4.50 overcharge and strictly NEVER mentions ₹0.90', async () => {
      const { answer, intent } = generateLocalAnswer('what is the gst here', benchmarkCtx, []);
      expect(intent).toBe('tax_specific');
      expect(answer).toContain('₹8.10');
      expect(answer).toContain('₹3.60');
      expect(answer).toContain('₹4.50');
      // Bug regression check: MUST NOT mention 0.90
      expect(answer).not.toContain('0.90');
      expect(answer).not.toContain('₹0.90');
    });

    test('why was this flagged? — explains root cause and overcharges correctly', () => {
      const { answer, intent } = generateLocalAnswer('why was this flagged?', benchmarkCtx, []);
      expect(intent).toBe('why_flagged');
      expect(answer).toContain('Fee / Tax Variance');
      expect(answer).toContain('₹25.00');
      expect(answer).toContain('₹4.50');
      expect(answer).toContain('₹29.50');
    });

    test('what went wrong? — explains the cause of the shortfall', () => {
      const { answer } = generateLocalAnswer('what went wrong?', benchmarkCtx, []);
      expect(answer).toContain('Fee / Tax Variance');
      expect(answer).toContain('₹25.00');
      expect(answer).toContain('₹4.50');
    });

    test('how much did we get overcharged? — synthesizes total exposure', () => {
      const { answer, intent } = generateLocalAnswer('how much did we get overcharged?', benchmarkCtx, []);
      expect(['amount_at_risk', 'settlement_causality', 'fee_specific'].includes(intent)).toBe(true);
      expect(answer).toContain('₹29.50');
    });

    test('is gst contributing to the settlement difference? — connects variances to shortfall', () => {
      const { answer, intent } = generateLocalAnswer('is gst contributing to the settlement difference?', benchmarkCtx, []);
      expect(intent).toBe('settlement_causality');
      expect(answer).toContain('Net Settlement = Gross Amount − Gateway Fee − GST');
      expect(answer).toContain('₹25.00');
      expect(answer).toContain('₹4.50');
      expect(answer).toContain('₹29.50');
    });

    test('what should I verify? — provides actionable verification steps', () => {
      const { answer, intent } = generateLocalAnswer('what should I verify?', benchmarkCtx, []);
      expect(intent).toBe('what_to_verify');
      expect(answer).toContain('verify the following');
      expect(answer).toContain('Resolve');
    });

    test('explain the whole case simply — delivers plain-English breakdown', () => {
      const { answer, intent } = generateLocalAnswer('explain the whole case simply', benchmarkCtx, []);
      expect(intent).toBe('simple_explanation');
      expect(answer).toContain('₹1,000.00');
      expect(answer).toContain('₹20.00');
      expect(answer).toContain('₹3.60');
      expect(answer).toContain('₹45.00');
      expect(answer).toContain('₹8.10');
      expect(answer).toContain('₹29.50');
    });

    test('Ollama system prompt integrates exact mathematical integrity constraints', () => {
      const engine = new OllamaChatEngine({ model: 'qwen2.5:1.5b' });
      const messages = engine._buildChatMessages('what is the gst here', benchmarkCtx, []);
      const systemMsg = messages.find(m => m.role === 'system');

      expect(systemMsg).toBeDefined();
      expect(systemMsg.content).toContain('Actual GST (₹8.10) − Expected GST (₹3.60) = ₹4.50');
      expect(systemMsg.content).toContain('₹0.90 is FALSE');
      expect(systemMsg.content).toContain('Fee Overcharge (₹25.00) + GST Overcharge (₹4.50) = ₹29.50');
      expect(systemMsg.content).toContain('UNDERSTAND USER INTENT');
      expect(systemMsg.content).toContain('ADAPTIVE RESPONSES');
    });
  });

  describe('6. Hybrid AI Architecture Routing & Validation (Payvault AI Core vs Internal Assistance)', () => {
    const {
      evaluateQueryComplexity,
      validateAssistedAnswer,
      routeAndAnswerChat,
    } = require('../src/investigation/chat/chatRouter');

    const benchmarkCtx = {
      case_id: 'exc_benchmark_hybrid',
      exception_category: 'FEE_TAX_VARIANCE',
      status: 'OPEN',
      gross_amount_formatted: '₹1,000.00',
      expected_net_formatted: '₹976.40',
      actual_settlement_formatted: '₹946.90',
      fee_expected_formatted: '₹20.00',
      fee_actual_formatted: '₹45.00',
      fee_variance_formatted: '₹25.00',
      fee_expected_paise: 2000,
      fee_actual_paise: 4500,
      fee_variance_paise: 2500,
      tax_expected_formatted: '₹3.60',
      tax_actual_formatted: '₹8.10',
      tax_variance_formatted: '₹4.50',
      tax_expected_paise: 360,
      tax_actual_paise: 810,
      tax_variance_paise: 450,
      net_shortfall_formatted: '₹29.50',
      amount_at_risk_formatted: '₹29.50',
      payment_id: 'pay_hybrid_test_01',
    };

    test('Straightforward questions are classified as HIGH confidence (Direct Payvault AI answering)', () => {
      const easyQuestions = [
        'What is the GST here?',
        'What was the actual fee?',
        'How much are we short?',
        'What is the payment ID?',
        'What was the expected settlement?',
        'What is the fee variance?',
        'Why was this flagged?',
        'What went wrong?',
        'What should I verify before resolving this?',
        'How did you calculate that?',
        "Why isn't the GST variance ₹0.90?",
      ];

      for (const q of easyQuestions) {
        const evalResult = evaluateQueryComplexity(q, benchmarkCtx, []);
        expect(evalResult.shouldAssist).toBe(false);
        expect(evalResult.confidence).toBeGreaterThanOrEqual(0.85);
      }
    });

    test('Complex / ambiguous questions trigger internal assistance signal', () => {
      const complexQuestions = [
        'Why does this pattern look suspicious compared with the other transactions?',
        'Could these two discrepancies actually have the same root cause?',
        'Explain the relationship between the settlement timing, refund and fee adjustment.',
        'What is the most likely explanation for this unusual reconciliation pattern?',
        'What additional evidence should an investigator look for beyond the ledger?',
      ];

      for (const q of complexQuestions) {
        const evalResult = evaluateQueryComplexity(q, benchmarkCtx, []);
        expect(evalResult.shouldAssist).toBe(true);
        expect(evalResult.complexity).toBe('HIGH');
      }
    });

    test('validateAssistedAnswer strips hallucinated ₹0.90 deductions', () => {
      const rawAssistedText = 'The GST overcharge is ₹4.50 and there is an excess deduction of ₹0.90.';
      const validated = validateAssistedAnswer(rawAssistedText, benchmarkCtx);
      expect(validated).not.toContain('0.90');
      expect(validated).not.toContain('₹0.90');
      expect(validated).toContain('₹4.50');
    });

    test('routeAndAnswerChat returns unified product identity model="Payvault AI"', async () => {
      const res = await routeAndAnswerChat({
        message: 'What is the GST here?',
        ctx: benchmarkCtx,
        history: [],
      });

      expect(res.model).toBe('Payvault AI');
      expect(res.execution_mode).toBe('DIRECT_PAYVAULT_AI');
      expect(res.answer).toContain('₹8.10');
      expect(res.answer).toContain('₹4.50');
      expect(res.answer).not.toContain('0.90');
    });

    test('PayvaultAI class methods function according to decision layer architecture', async () => {
      const { PayvaultAI } = require('../src/investigation/chat/chatRouter');
      const ai = new PayvaultAI();

      // 1. understandQuestion
      const understood = ai.understandQuestion('  What is the fee?  ', [{ role: 'operator', content: 'hello' }]);
      expect(understood.normalized).toBe('What is the fee?');
      expect(understood.hasHistory).toBe(true);

      // 2. determineIntent
      const intent = ai.determineIntent('What is the fee?', [], benchmarkCtx);
      expect(intent).toBe('fee_specific');

      // 3. assessComplexity
      const evalSimple = ai.assessComplexity('What is the fee?', benchmarkCtx, []);
      expect(evalSimple.shouldAssist).toBe(false);

      const evalComplex = ai.assessComplexity('Why does this pattern look suspicious compared with the other transactions?', benchmarkCtx, []);
      expect(evalComplex.shouldAssist).toBe(true);

      // 4. shouldUseAdvancedReasoning
      expect(ai.shouldUseAdvancedReasoning(evalSimple)).toBe(false);
      expect(ai.shouldUseAdvancedReasoning(evalComplex)).toBe(true);

      // 5. reasonWithLocalIntelligence
      const localResult = ai.reasonWithLocalIntelligence('What is the fee?', benchmarkCtx, []);
      expect(localResult.answer).toContain('₹45.00');

      // 6. validateAgainstCaseData
      const validated = ai.validateAgainstCaseData('Deduction was ₹0.90.', benchmarkCtx);
      expect(validated).not.toContain('0.90');

      // 7. generateFinalAnswer
      const finalResp = await ai.generateFinalAnswer({
        message: 'What is the fee?',
        ctx: benchmarkCtx,
        history: [],
      });
      expect(finalResp.model).toBe('Payvault AI');
      expect(finalResp.execution_mode).toBe('DIRECT_PAYVAULT_AI');
    });

    test('API endpoint POST /api/investigations/:id/chat returns model="Payvault AI"', async () => {
      const res = await request(app)
        .post(`/api/investigations/${testCaseId}/chat`)
        .send({ message: 'What is the GST here?' })
        .expect(200);

      expect(res.body.model).toBe('Payvault AI');
      expect(res.body.answer).toBeDefined();
    });
  });
});

