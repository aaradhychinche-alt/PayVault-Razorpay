# Payvault — Enterprise Settlement Reconciliation & Exception Investigation

**Payvault** is an intelligent financial operations platform that automatically detects, investigates, and resolves settlement discrepancies in payment processing workflows. Built for merchants, payment processors, and fintech operations teams, Payvault delivers deterministic reconciliation with optional AI-powered explanations to accelerate dispute resolution and reduce financial exposure.

---

## Core Philosophy

Payvault is built on a simple principle: **deterministic financial facts are authoritative**. The reconciliation engine computes exact paise-level calculations and reconciliation rules. Optional AI layers (local ML, Ollama) provide natural-language context and operational guidance—but they never override verified financial truths.

**Key Architecture:**
```
Payment Transaction
      ↓
Deterministic Reconciliation Engine (Integer-Paise Precision)
      ↓
Historical / Local ML Intelligence
      ↓
Investigation Case Context
      ↓
Investigation Findings
      ↓
Optional AI Explanation
      ↓
Human Operator Decision
```

---

## Features

### 1. **Deterministic Reconciliation Engine**

The foundation of Payvault is a rule-based reconciliation engine that matches payment transactions, settlement records, and merchant ledger entries with penny-perfect accuracy.

#### What it does:
- **Integer-paise calculations** — All monetary values are stored and computed as integers (1 paise = 1/100 INR) to eliminate floating-point rounding errors
- **Multi-source matching** — Links Razorpay payments, settlement batches, merchant orders, and ledger entries
- **Rule-based exception detection** — Identifies 9 exception categories including timing mismatches, fee variances, missing orders, and duplicates
- **Amount-at-risk quantification** — Calculates exact financial exposure for each discrepancy

#### Exception Categories:
- **CLEAN_MATCH** — All amounts, fees, and taxes align perfectly
- **FEE_TAX_VARIANCE** — Platform fee or GST charged differs from contracted rate (2% + 18% GST)
- **TIMING_MISMATCH** — Payment and refund processed in different settlement batch cycles
- **MISSING_ORDER** — Settlement credit exists without corresponding merchant order
- **MISSING_PAYMENT** — Merchant order exists but expected settlement payout not received
- **DUPLICATE** — Multiple settlement credits for the same order reference
- **ADJUSTMENT** — Settlement adjustment exists but cannot be linked to a known transaction
- **PARTIAL_REFUND** — Refund deducted at less than original transaction amount
- **UNEXPLAINED** — Variance detected but no specific rule categorizes the discrepancy

#### Configuration:
```javascript
// src/engine/config.js controls reconciliation tolerances
{
  amountTolerance: 100,           // paise (₹1.00)
  feeTaxTolerance: 100,           // paise
  timingWindow: 172800000,        // 2 days (milliseconds)
  duplicateWindow: 300,           // seconds
  missingPaymentDays: 7           // days before flagging as uncaptured
}
```

---

### 2. **Investigation Workstation**

A modern, reactive dashboard for financial operations staff to investigate and resolve exceptions interactively.

#### Investigation Lifecycle:
1. **OPEN** — Case created, awaiting investigation
2. **IN_REVIEW** — Investigation executed, waiting for operator review
3. **RESOLVED** — Operator confirmed resolution with business justification

#### Features:
- **Case Queue** — Master-detail layout showing all cases with filters by status (All / Open / In Review / Resolved) and exception category
- **Real-time Counts** — Dynamic badge showing active exceptions and amount at risk
- **Financial Breakdown** — Detailed accordion showing gross amount, fees, taxes, variance, and payout calculations
- **Timeline Visualization** — Chronological events from payment capture to discrepancy detection
- **Entity Relationship Graph** — Visual link between merchant order, payment ID, and settlement batch
- **Historical Intelligence** — Similar cases and repeated patterns from transaction history
- **Case Audit Trail** — Immutable append-only log of all state transitions with timestamps and operators
- **Resolution Dialog** — Structured form with predefined business justification reasons and operator notes

#### No Page Refresh Required:
- Payment creation updates investigation counts immediately
- Case resolution updates status and navigation badges without reload
- Live mode to benchmark mode switching preserves session state
- All state changes reflect instantly across the entire dashboard

---

### 3. **Payvault AI Investigation Engine**

A multi-signal AI reasoning system that generates operational investigation findings grounded in deterministic case data.

#### How it Works:
1. **Evidence Extraction** — Structured facts (IDs, amounts, timestamps, relationships) from the deterministic case
2. **Pattern Detection** — Cross-transaction analysis identifying repeated behaviors and anomalies
3. **Primary Intelligence** — Payvault Local ML (Random Forest, 38 features) predicts exception category and confidence
4. **Difficulty Evaluation** — Multi-signal scoring to determine if escalation to Qwen is needed
5. **AI Reasoning** — Generates root-cause hypotheses, supporting evidence, and recommended actions
6. **Confidence Calculation** — Measurable scoring with explicit factor breakdown
7. **Consistency Validation** — Anti-hallucination checks to detect fabricated evidence or logical contradictions
8. **Unified Output** — Deterministic findings presented as operational investigation report

#### Investigation Output Schema:
```javascript
{
  case_id:              "exc_000001",
  exception_category:   "FEE_TAX_VARIANCE",
  status:               "OPEN" | "IN_REVIEW" | "RESOLVED",
  
  // Findings
  summary:              "...",
  what_happened:        "Gateway fee charged differs from contracted rate...",
  why_it_matters:       "Discrepancies in gateway fees directly impact merchant gross margin...",
  recommended_action:   "Verify the contracted gateway fee schedule...",
  assessment:           "NEEDS_REVIEW" | "HIGH_RISK" | "MATCHED",
  supporting_evidence:  ["Gross amount: ₹5,000.00", "Fee variance: ₹25.00", ...],
  
  // Deterministic Context (Preserved)
  financial_analysis:   {...},      // Structured paise calculations
  timeline:             [...],      // Sorted chronological events
  relationships:        [...],      // Entity linkage graph
  suggested_actions:    [...],      // Deterministic resolution steps
  
  // Intelligence Metadata
  ai_analysis: {
    provider:           "PAYVAULT_LOCAL_INTELLIGENCE" | "OLLAMA_QWEN",
    model:              "Payvault Local ML" | "Qwen 2.5",
    runtime:            "In-Process" | "Ollama",
    status:             "COMPLETED" | "FALLBACK_USED"
  },
  
  // Audit & Diagnostics
  latency_ms:           1234,
  _diagnostics: {
    engine:             "payvault_ai",
    routing_state:      "LOCAL_MODEL_SUFFICIENT",
    difficulty_score:   0.42,
    qwen_escalated:     false,
    is_consistent:      true
  }
}
```

---

### 4. **Ask Payvault AI — Case-Aware Investigation Chat**

An enterprise financial operations chat assistant that answers operator questions about the currently selected investigation using real deterministic case data.

#### Design Principles:
- **Case-scoped** — Questions and answers always refer to the selected investigation
- **Deterministic-first** — All financial facts come from Payvault's reconciliation engine, never invented
- **Read-only** — Chat cannot resolve cases or modify state; operators use UI buttons for state changes
- **NO FAKE AI** — Provenance badge only shows "Ollama" if Ollama actually ran; otherwise "Payvault Local Intelligence"
- **Conversation memory** — Multi-turn follow-ups within the same case; clears when switching cases
- **Graceful degradation** — Works perfectly offline with Payvault local intelligence; Ollama is strictly optional

#### How It Works:

**Frontend:**
1. Operator selects an investigation case
2. Suggested questions appear (dynamically personalized with exception category)
3. Operator types a question or clicks a suggested pill
4. Message posted to backend with conversation history

**Backend:**
1. Load the deterministic case and reconciliation data
2. Build structured financial context (ChatContext)
3. Classify operator intent (keyword matching)
4. If `ENABLE_OLLAMA=true` AND Ollama available → invoke Ollama with the facts
5. Otherwise → use local Payvault intelligence answer builder
6. Return response with accurate `ai_used` flag and source attribution

**Example Intent Routing:**
```
"Why was this case flagged?"         → why_flagged
"Explain the financial variance"     → financial_variance
"What happened in this transaction?" → what_happened
"What should I verify?"              → what_to_verify
"Similar historical cases?"          → historical_cases
"Why classified as [category]?"      → classification
"Resolve this case"                  → state_change_guard (denied)
```

#### Suggested Questions:
```
• "Why was this case flagged?"
• "Explain the financial variance."
• "What happened in this transaction?"
• "What should I verify before resolving this?"
• "Are there similar historical cases?"
• "Why is this classified as [Exception Category]?"
• "Explain this case in simple terms."
```

#### UI Features:
- **Provenance badge** — Shows actual source (Payvault Local Intelligence or Ollama) with status indicator
- **Conversation thread** — Scrollable message bubbles with sender labels and source attribution
- **Loading indicator** — Animated dots while processing
- **Error handling** — Inline error message with one-click retry
- **Keyboard support** — Enter to send, Shift+Enter for newline
- **Auto-resize input** — Textarea grows as operator types
- **Markdown rendering** — Supports **bold**, *italic*, `code` for readable responses
- **Case switching** — Thread clears, provenance resets, and new suggested questions load

#### Configuration:
```javascript
// .env
ENABLE_OLLAMA=false              // Default: Ollama is OPTIONAL, not required
OLLAMA_BASE_URL=http://127.0.0.1:11434
QWEN_MODEL=qwen2.5:7b
QWEN_TIMEOUT_MS=15000
```

When `ENABLE_OLLAMA=false`:
- Chat uses Payvault local intelligence only
- Provenance shows "Payvault Local Intelligence"
- No Ollama calls made
- Application fully functional offline

When `ENABLE_OLLAMA=true` AND Ollama available:
- Chat tries Ollama first
- Falls back to Payvault if Ollama unavailable
- Provenance shows actual result

---

### 5. **Payment Processing Integration**

Payvault integrates with Razorpay's payment processing via two flexible modes:

#### Mode A: Local Demo (Offline)
- Zero external credentials required
- Synthetic payment + settlement generation
- Ideal for development, testing, and demonstrations
- No Razorpay API calls

```bash
POST /api/payments/local
{
  "amount": 500000,                    # paise (₹5,000)
  "payment_method": "card",
  "customer_ref": "TEST_ORDER_001",
  "anomaly_type": "FEE_TAX_VARIANCE"   # Inject a discrepancy
}
```

#### Mode B: Razorpay Test Mode (Live)
- Real Razorpay Checkout modal opens
- Uses actual Razorpay test credentials
- Real test orders and payments created
- Settlement is simulated (Razorpay Test Mode doesn't complete settlements)

```javascript
// Razorpay Checkout Integration
const options = {
  key: RAZORPAY_KEY_ID,              // Test mode API key
  order_id: order.id,                // Real Razorpay order
  handler: handlePaymentSuccess,     // Client-side callback
  theme: { color: '#090d16' }        // Payvault brand color
};

rzp.open();  // Opens Razorpay modal
```

#### Payment Verification Flow:
1. Razorpay Checkout modal completes payment
2. Client receives `razorpay_payment_id`, `razorpay_order_id`, `razorpay_signature`
3. Backend verifies HMAC-SHA256 signature (constant-time comparison to prevent timing attacks)
4. Payment ingested into Payvault settlement pipeline
5. Deterministic reconciliation runs
6. Exception created if discrepancy detected
7. UI updates immediately (no page refresh)
8. Form resets automatically
9. Investigation counts update

#### Important Security Features:
- Signature verification prevents tampered responses
- Amount always re-verified from backend (never trusts client-provided amount)
- Sensitive credentials never sent to client
- All monetary calculations use integer paise only

---

### 6. **Historical Intelligence & Pattern Analysis**

Payvault learns from transaction history to identify patterns and precedents.

#### Components:
- **Similar Cases** — Find previous exceptions matching current case category
- **Repeated Patterns** — Detect behavior patterns across merchants and time periods
- **Anomaly Detection** — Flag unusual statistical signals in transaction streams
- **Precedent Memory** — Track confirmed resolutions to inform future cases
- **Merchant Patterns** — Learn merchant-specific payment behavior baselines

#### Data Sources:
- Settlement batch timing and amounts
- Historical merchant orders
- Fee and tax deviations
- Refund sequences
- Inter-transaction timing

#### Output in Investigation:
```javascript
{
  intelligence_context: {
    historical_context: {
      similar_cases: [
        { case_id: "exc_000015", category: "FEE_TAX_VARIANCE", variance_paise: 2500 },
        ...
      ],
      repeated_patterns: [
        "Pattern: Fee overcharges on card payments > ₹5,000",
        ...
      ],
      merchant_patterns: [...]
    },
    anomaly_context: {
      anomalies: [...],
      has_sufficient_history: true
    },
    memory_context: {
      precedent_summary: "3 similar FEE_TAX_VARIANCE cases previously resolved by fee adjustment dispute",
      confirmed_resolutions: [...]
    }
  }
}
```

---

### 7. **Dashboard & Metrics**

Real-time financial operations dashboard with live-updating metrics.

#### Metrics Displayed:
- **Total Payments** — Count of captured transactions
- **Total Amount Reconciled** — Sum of all matched payments (integer paise)
- **Total Amount At Risk** — Sum of all variances (integer paise)
- **Exception Breakdown** — Count by category
- **Settlement Status** — Batch count and aggregate credit/fee/tax
- **Reconciliation Summary** — Matched vs. Exception vs. Pending

#### No Manual Refresh Required:
- Creating a payment updates all metrics immediately
- Resolving an investigation updates counts instantly
- Switching between demo and live mode preserves state
- Payment list, settlement batches, and investigation queue all live-sync

#### Financial Summary Display:
```
Total Payments: 65
Total Amount: ₹93,751.97
Total Fees (2%): ₹1,875.04
Total GST (18%): ₹337.50
Net Payout: ₹91,539.43

Exceptions (24 cases):
  TIMING_MISMATCH:    6 cases
  FEE_TAX_VARIANCE:   3 cases
  MISSING_ORDER:      3 cases
  DUPLICATE:          4 cases
  ADJUSTMENT:         3 cases
  UNEXPLAINED:        2 cases
  MISSING_PAYMENT:    3 cases

Amount At Risk: ₹16,527.80
```

---

### 8. **API Reference**

#### Payments
```
POST /api/payments/local
  Create a local demo payment (offline, no credentials required)
  
GET /api/payments
  List all payments processed in current session
```

#### Reconciliation
```
GET /api/reconciliation/summary
  Get financial metrics (total amount, fees, tax, exceptions count)
  
GET /api/reconciliation/:id
  Get detailed reconciliation result for a specific payment
```

#### Settlement
```
GET /api/settlements
  List settlement batches with aggregate financials
```

#### Exceptions
```
GET /api/exceptions
  List all detected discrepancies
  
GET /api/exceptions/:id
  Get detailed exception record
```

#### Investigations
```
GET /api/investigations
  List all investigation cases (with filters by status & category)
  
GET /api/investigations/:id
  Get full investigation case with deterministic data, lifecycle, audit trail
  
POST /api/investigations/:id/run
  Execute AI investigation on a case (transitions to IN_REVIEW)
  
POST /api/investigations/:id/resolve
  Resolve a case with business justification (transitions to RESOLVED)
  
POST /api/investigations/:id/reopen
  Reopen a resolved case (transitions back to OPEN)
  
GET /api/investigations/:id/audit
  Get append-only audit trail for a case
  
POST /api/investigations/:id/chat
  Case-aware AI chat (Ask Payvault AI)
  Request:  { message: string, history: [{role, content}] }
  Response: { answer, source, case_id, ai_used, model, intent }
```

#### Demo & Admin
```
POST /api/demo/reset-synthetic
  Load 79-case benchmark dataset
  
POST /api/demo/clear
  Clear all records (return to LIVE mode with 0 cases)
  
POST /api/demo/sync-razorpay
  Sync with Razorpay Test Mode (requires credentials)
```

---

## Technical Architecture

### Backend Stack
- **Runtime** — Node.js (v14+)
- **Framework** — Express.js
- **Data Store** — In-memory (Map-based, no external DB required)
- **Configuration** — .env file with optional Razorpay credentials
- **ML Subsystem** — Python (scikit-learn Random Forest)
- **Optional AI** — Local Ollama runtime for Qwen 2.5

### Frontend Stack
- **HTML/CSS/JS** — Vanilla (no framework dependencies)
- **Design System** — Custom fintech design language (obsidian black & white, Plus Jakarta Sans, JetBrains Mono)
- **State Management** — AppState object (React-like pattern)
- **Rendering** — Dynamic template strings, no virtual DOM
- **API Communication** — Fetch API (no jQuery or axios)

### Key Implementation Files

**Backend:**
```
src/
├── engine/
│   ├── reconcile.js              # Reconciliation engine
│   ├── rules.js                  # Exception detection rules
│   └── config.js                 # Tolerances & thresholds
├── investigation/
│   ├── caseBuilder.js            # Builds InvestigationCase
│   ├── financialAnalysis.js      # Paise-level breakdown
│   ├── timeline.js               # Event sequencing
│   ├── relationships.js          # Entity linkage
│   ├── suggestedActions.js       # Deterministic recommendations
│   ├── ai/
│   │   ├── engine.js             # Main AI investigation pipeline
│   │   ├── evidence.js           # Structured fact extraction
│   │   ├── patterns.js           # Pattern detection
│   │   ├── reasoning.js          # Root-cause reasoning
│   │   ├── confidence.js         # Confidence scoring
│   │   ├── consistency.js        # Anti-hallucination validation
│   │   ├── difficulty.js         # Escalation decision logic
│   │   ├── formatter.js          # Unified output schema
│   │   ├── orchestrator.js       # High-level synthesis
│   │   ├── model/
│   │   │   ├── modelRouter.js    # Routing: Payvault ML vs Ollama
│   │   │   ├── payvaultModel.js  # Python ML adapter
│   │   │   ├── qwenModel.js      # Ollama/Qwen adapter
│   │   │   └── localModel.js     # Fallback logic
│   │   ├── intelligence/
│   │   │   ├── context.js        # Historical context builder
│   │   │   ├── similarCases.js   # Case similarity matching
│   │   │   ├── patternHistory.js # Pattern detection
│   │   │   ├── memory.js         # Precedent tracking
│   │   │   └── ...
│   │   └── chat/
│   │       ├── chatContextBuilder.js   # Chat fact extraction
│   │       ├── localChatEngine.js      # Local answer generation
│   │       └── ollamaChatEngine.js     # Optional Ollama chat
│   └── intelligence/
│       └── [pattern analysis modules]
├── razorpay/
│   └── adapter.js                # Razorpay API integration
├── routes/
│   ├── investigations.js         # Investigation endpoints + chat
│   ├── reconciliation.js         # Reconciliation metrics
│   ├── exceptions.js             # Exception queries
│   ├── demo.js                   # Demo & admin endpoints
│   └── [other routes]
├── store/
│   └── dataStore.js              # In-memory data store
└── data/
    ├── generator.js              # Synthetic data generation
    └── dataset.js                # Benchmark dataset

public/
├── index.html                    # Single-page app shell
├── checkout.js                   # UI logic + chat module
└── style.css                     # Design system & chat styles

ml/
└── predict.py                    # Python ML inference

tests/
├── investigation.test.js         # AI & investigation tests
├── engine.test.js                # Reconciliation engine tests
├── caseLifecycle.test.js         # Case state machine tests
├── simulator.test.js             # Settlement simulator tests
├── livePaymentFlow.test.js       # End-to-end payment flow tests
└── test_ml.py                    # Python ML validation

server.js                         # Express app bootstrap
.env                              # Configuration (git-ignored)
```

---

## Installation & Setup

### Prerequisites
- **Node.js** 14+ (npm or yarn)
- **Python 3.7+** (for ML subsystem)
- **Razorpay credentials** (optional, for Test Mode; not needed for Local Demo)
- **Ollama** (optional, for optional AI chat; not required)

### Quick Start (Local Demo — No Credentials)

```bash
# 1. Install dependencies
npm install

# 2. Install Python ML dependencies
pip install scikit-learn numpy pandas

# 3. Start the server
npm start

# Server runs at http://localhost:3000
```

### Setup with Razorpay Test Mode

```bash
# 1. Get credentials from Razorpay dashboard
# https://dashboard.razorpay.com/app/settings/api-keys

# 2. Create .env file
cat > .env << EOF
RAZORPAY_KEY_ID=rzp_test_XXXXXXXXXXXXXXXX
RAZORPAY_KEY_SECRET=XXXXXXXXXXXXXXXXXXXXXXXX
PORT=3000
NODE_ENV=production
ENABLE_OLLAMA=false
EOF

# 3. Start the server
npm start
```

### Optional: Enable Ollama Chat

```bash
# 1. Install Ollama
# https://ollama.ai

# 2. Download Qwen model
ollama pull qwen2.5:7b

# 3. Start Ollama (in separate terminal)
ollama serve

# 4. Enable in .env
echo "ENABLE_OLLAMA=true" >> .env

# 5. Restart server
npm start
```

---

## Running Tests

```bash
# Run all Jest tests (Node.js)
npm test

# Run Python ML validation
python3 tests/test_ml.py

# Run benchmark evaluation (accuracy, per-category metrics)
npm run evaluate

# Watch mode (optional)
npm test -- --watch
```

**Expected Results:**
```
Jest:    163/163 ✅
Python:  7/7     ✅
Benchmark: 100%  ✅
```

---

## Use Cases

### 1. **Settlement Reconciliation**
Operators upload daily settlement batches. Payvault automatically matches payments, detects discrepancies, and categorizes exceptions. No manual line-item matching required.

### 2. **Fee Dispute Investigation**
Gateway fee charged doesn't match contracted rate? Payvault quantifies the variance and recommends dispute steps.

### 3. **Refund Processing**
Track partial and full refunds across settlement batch cycles. Identify timing mismatches and cross-period reconciliation issues.

### 4. **Duplicate Payment Detection**
Catch accidental double-captures and concurrent settlement credits. Get immediate alerts with exact amounts.

### 5. **Compliance & Audit**
Every state change, resolution, and reasoning step is logged with timestamps and actor identities. Full audit trail for regulatory review.

### 6. **Merchant Operations Support**
Explain complex settlement scenarios to merchants in plain language. "Why is my payout lower than I expected?" → Payvault explains with evidence.

### 7. **AI-Assisted Investigations (Optional)**
Enable Ollama for hands-off chat assistance. Operators ask follow-up questions about cases without manual documentation.

---

## Key Guarantees

### Data Accuracy
- All monetary values are integer-paise, never floating-point
- Rounding always favors accuracy over convenience
- Reconciliation is deterministic — same input always produces same output

### No Hallucination
- AI responses quote exact financial facts from the deterministic engine
- Provenance badge shows actual source (never claims AI ran if it didn't)
- Chat cannot resolve cases or modify state

### Offline Capability
- Works perfectly without Razorpay credentials (Local Demo mode)
- Works perfectly without Ollama (Local Intelligence mode)
- No external dependencies required for core reconciliation

### Audit Trail
- Every investigation state change is immutable and timestamped
- Every resolution is justified with operator notes and business reason
- All reopenings are tracked with context

### Performance
- Investigation generation: <2 seconds per case
- Full benchmark (79 cases): ~16 seconds
- Chat response: <500ms (local) or <3s (Ollama)
- No page refresh required for any state update

---

## Support & Documentation

- **Implementation Plan** — `implementation_plan.md`
- **Testing Checklist** — `TESTING_CHECKLIST.md`
- **Fix Summary** — `FIX_SUMMARY.md`
- **Ollama Routing** — `OLLAMA_ROUTING_FIX.md`
- **API Responses** — See inline comments in `src/routes/`

---

## License

Payvault is proprietary software. All rights reserved.

---

## About

Built with ❤️ for financial operations teams who believe in **data integrity first**.

**Key Principles:**
- Deterministic reconciliation is authoritative
- AI is optional, never mandatory
- Offline-first architecture
- Integer-paise precision
- Zero hallucination
- Full audit trail
- Human operators make final decisions

---

**Ready to reconcile with confidence?**

Start with Local Demo at http://localhost:3000 — no setup required.
