# Payvault — Enterprise Settlement Reconciliation & Exception Investigation

**Payvault** is an enterprise financial operations platform that automatically synchronizes payment and settlement data, reconciles transactions, detects payment exceptions, investigates their underlying causes, quantifies financial impact, and delivers evidence-grounded conversational explanations through Payvault AI with human-controlled resolution workflows.

Built for high-volume merchants, payment facilitators, and fintech operations teams, Payvault replaces manual spreadsheet reconciliation with penny-perfect, deterministic accounting and contextual investigation intelligence.

---

## Quick Start

Get Payvault up and running in under two minutes with Docker:

```bash
# 1. Clone the repository
git clone https://github.com/aaradhychinche/RazorPay.git
cd RazorPay

# 2. Copy the environment template
cp .env.example .env

# 3. Build and launch all services with Docker Compose
docker compose up --build
```

Once the containers are healthy, open **[http://localhost:3000](http://localhost:3000)** in your browser.

- **PostgreSQL migrations execute automatically** on startup.
- **Redis connection initializes automatically** for conversational session caching.
- **Payvault starts in Test Mode** (ready for instant synthetic reconciliation or Razorpay live test mode).

---

## System Architecture

Payvault separates concerns strictly across permanent persistence, transient state, local machine learning, and deterministic financial calculation:

```
                    Docker Compose
                         │
          ┌──────────────┼──────────────┐
          ↓              ↓              ↓
      Payvault App   PostgreSQL       Redis
       (Node/ML)     (Persistent)  (Fast Context)
      Port: 3000      Port: 5432    Port: 6379
          │              │              │
          │              ↓              ↓
          │         Financial Data   Chat State
          │         Investigations   Conversation
          │         Audit Events     Context
          │              │              │
          └──────────────┴──────┬───────┘
                                ↓
                         Payvault AI
```

### Storage & Service Responsibilities

| Service | Technology | Role & Storage Guarantee |
| :--- | :--- | :--- |
| **PostgreSQL** | PostgreSQL 15 | **Permanent Authoritative Source of Truth**.<br>Persists orders, payments, refunds, settlements, settlement transactions, reconciliation results, investigations, and immutable audit events. All financial fields are strictly stored as `BIGINT` integer paise (`*_paise`). |
| **Redis** | Redis 7 | **Fast Transient State & Context Cache**.<br>Stores active conversational state, recent chat turns, and scoped session data (`payvault:chat:<caseId>:<convId>`) with configurable TTL (`CHAT_CONTEXT_TTL_SECONDS`). **Redis is NOT the financial source of truth.** |
| **Payvault App** | Node.js 18 / Express | **Application & Investigation Engine**.<br>Serves static UI, handles API routing, executes deterministic settlement reconciliation, and coordinates native Payvault AI reasoning. |
| **Local ML** | Scikit-Learn (Python 3) | **Natural Language Intent Understanding**.<br>Classifies operator questions into 26 distinct financial investigation intents. Runs 100% in-process / locally with zero external LLM dependencies. |
| **Deterministic Engine** | JavaScript | **Authoritative Calculations**.<br>Performs penny-perfect arithmetic (fee schedule validation, GST verification, timing window matching) using integer paise. Zero hallucination. |

---

## Core Capabilities

### 1. Deterministic Reconciliation Engine
Matches gateway payments, settlement batches, and merchant ledger entries with mathematical certainty:
- **Integer-Paise Precision**: All calculations occur in integer paise (100 paise = ₹1.00) to eliminate IEEE 754 floating-point errors.
- **Multi-Source Ingestion**: Ingests Razorpay payment captures, settlement UTRs, and internal order records.
- **9 Exception Categories Detected**:
  - `CLEAN_MATCH`: Gross, fee, tax, and net credit match expected schedules.
  - `FEE_TAX_VARIANCE`: Gateway platform fee or GST deviates from contracted rate (2.0% + 18% GST).
  - `TIMING_MISMATCH`: Payment captured and refund issued across different settlement batch cycles.
  - `MISSING_ORDER`: Settlement credit received with no merchant order in ledger.
  - `MISSING_PAYMENT`: Merchant order captured but payment omitted from settlement batch.
  - `DUPLICATE`: Multiple settlement credits for the same order reference within a deduplication window.
  - `ADJUSTMENT`: Gateway balance adjustment not mapped to an underlying transaction.
  - `PARTIAL_REFUND`: Refund debit does not match requested refund amount.
  - `UNEXPLAINED`: Net credit shortfall without detectable fee/tax discrepancy.
- **Amount-at-Risk Quantification**: Automatically calculates exact merchant financial exposure for every exception.

### 2. Investigation Workstation & Operations Dashboard
- **Case Queue**: Filter by status (`OPEN`, `IN_REVIEW`, `RESOLVED`) and exception category.
- **Investigation Result Summary**: Renders three dynamic, case-specific operational findings:
  1. **What happened?**
  2. **Why does it matter?**
  3. **What should I do?**
- **Auditable Transaction Facts**: Direct comparison table comparing Expected vs Actual for Gross, Gateway Fee, GST, and Net Settlement.
- **Lifecycle Timeline**: Chronological event sequence from order creation to bank UTR settlement credit.
- **Human-Controlled Resolution**: Transition cases between `OPEN`, `IN_REVIEW`, and `RESOLVED` with mandatory business justification codes and operator audit notes. The AI engine is strictly prohibited from mutating case status.

### 3. Conversational Payvault AI Copilot
Ask Payvault AI directly questions about the active investigation case:
- **Multi-turn Context Retention**: Context flows across questions (e.g., *"Why is the settlement lower?"* → *"What about GST?"* → *"Where did the missing amount go?"*).
- **Case Isolation**: Conversations on Case A never leak context into Case B.
- **100% Native Reasoning**: Grounded entirely in deterministic case data from PostgreSQL and classified by local ML. **No external LLMs (OpenAI, Claude, Qwen, Ollama) are used or required.**

---

## Prerequisites

To run Payvault with the recommended Docker development environment:

- **Docker**: Version 20.10+
- **Docker Compose**: Version 2.0+ (supports `docker compose`)
- **Git**: For cloning the repository

### For Local Standalone Development (Without Docker)
If running directly on the host machine:
- **Node.js**: v18.0.0 or v20.0.0+ LTS
- **npm**: v9.0.0+
- **Python**: v3.10+ or v3.11+
- **Python Dependencies**: Listed in `src/ml/requirements.txt` (`pip install -r src/ml/requirements.txt`)

---

## Environment Configuration

Configuration is managed via environment variables. Create your local `.env` from the provided template:

```bash
cp .env.example .env
```

### Environment Variables Reference

| Variable | Default (Local / Docker) | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | Port for the Payvault web server and frontend. |
| `DATABASE_URL` | `postgresql://payvault:payvault_dev_secret@localhost:5432/payvault` | PostgreSQL connection string. (Inside Docker, host is `postgres`). |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string. (Inside Docker, host is `redis`). |
| `CHAT_CONTEXT_TTL_SECONDS` | `3600` | Expiration time (seconds) for conversational session context in Redis. |
| `RAZORPAY_KEY_ID` | `rzp_test_TWcM6wNXkUaBlu` | Razorpay Test API Key ID. |
| `RAZORPAY_KEY_SECRET` | *(secret placeholder)* | Razorpay Test API Key Secret. |
| `POSTGRES_DB` | `payvault` | PostgreSQL database name (used by Docker Compose). |
| `POSTGRES_USER` | `payvault` | PostgreSQL user (used by Docker Compose). |
| `POSTGRES_PASSWORD` | `payvault_dev_secret` | PostgreSQL development password. |

> **Note on Security**: Never commit your actual `RAZORPAY_KEY_SECRET` or production database credentials to version control. The repository ignores `.env` by default.

---

## Docker Development Setup

The primary and recommended development environment is containerized via Docker Compose.

### Starting the Stack

```bash
docker compose up --build
```

This starts:
1. **`payvault-postgres`**: PostgreSQL 15 on port `5432` with automated schema migrations.
2. **`payvault-redis`**: Redis 7 on port `6379` for transient context state.
3. **`payvault-app`**: Node.js backend, Python ML inference server, and static frontend on port `3000`.

### Stopping the Stack

```bash
docker compose down
```

To clear persisted database volumes and start completely fresh:
```bash
docker compose down -v
```

---

## Database Architecture (PostgreSQL)

PostgreSQL serves as Payvault's permanent, authoritative source of truth.

### Database Tables & Schema

1. **`orders`**: Merchant customer orders, amounts, and currency.
2. **`payments`**: Captured transactions, gateway IDs, payment methods, and timestamps.
3. **`refunds`**: Full and partial refund records with payment associations.
4. **`settlements`**: Settlement batches, UTR references, batch dates, and totals.
5. **`settlement_transactions`**: Individual line items inside a settlement batch.
6. **`reconciliation_results`**: Deterministic ledger comparisons with variance figures.
7. **`investigations`**: Case lifecycle records, AI investigation findings, and risk metrics.
8. **`audit_events`**: Append-only compliance ledger tracking all human resolutions and status changes.

### Financial Precision Guarantee
All monetary columns are strictly integer paise:
- `gross_amount_paise BIGINT`
- `expected_fee_paise BIGINT`
- `actual_fee_paise BIGINT`
- `fee_variance_paise BIGINT`
- `expected_gst_paise BIGINT`
- `actual_gst_paise BIGINT`
- `gst_variance_paise BIGINT`
- `expected_settlement_paise BIGINT`
- `actual_settlement_paise BIGINT`
- `amount_at_risk_paise BIGINT`

The repository layer (`src/db/repositories/`) implements strict `validatePaise()` assertions that reject any floating-point or negative amounts.

### Automated Migrations
Migrations are stored in `src/db/migrations/` and managed by `src/db/migrator.js`.
- Migrations run automatically on application boot when PostgreSQL connects.
- Each migration is executed inside a transaction.
- Completed migrations are tracked in the `schema_migrations` table.
- Initial schema: `001_initial_schema.sql`.

---

## Redis Transient Context Layer

Redis provides fast, low-latency conversational context for the Payvault AI copilot:

- **Key Convention**: Strictly scoped to prevent state contamination:
  ```
  payvault:chat:<investigationId>:<conversationId>
  ```
- **State Payload**:
  - `investigationId`: Case identifier (e.g., `exc_000001`)
  - `conversationId`: Session identifier
  - `currentTopic`: Active discussion focus (`fee_variance`, `tax_overcharge`, etc.)
  - `currentIntent` & `previousIntent`: Semantic intent tracking
  - `turnNumber`: Monotonically incremented turn counter
  - `activeFinancialMetric`: Financial metric currently in question
  - `lastUserQuestion` & `lastAnswerSummary`: Recent turn memory
- **TTL Management**: State automatically expires after `CHAT_CONTEXT_TTL_SECONDS` (default: 3600 seconds), refreshed on each turn.
- **Strict Case Isolation**: `CASE_A` context is completely inaccessible and isolated from `CASE_B`.

---

## Payvault AI: Architecture & Data Flow

Payvault AI uses an intelligence pipeline grounded in deterministic data:

```
                    User Question
                          ↓
                       Chat API
            (POST /api/investigations/:id/chat)
                          ↓
              Redis Conversation State
               (Multi-turn context load)
                          ↓
              Local ML Intent Classifier
                (26 semantic intents)
                          ↓
             PostgreSQL Investigation Case
             (Authoritative integer paise)
                          ↓
             Deterministic Financial Engine
                 (Calculates variances)
                          ↓
            Native Payvault AI Reasoning
            (Causal analysis & action plan)
                          ↓
             Bounds & Case-Scope Validation
               (Hallucination prevention)
                          ↓
                Payvault AI Response
                          ↓
             Updated Redis Conversation State
                (Persist turn & refresh TTL)
```

### Local Machine Learning
- Trained on 26 financial exception intents (e.g. `what_happened`, `settlement_causality`, `fee_specific`, `tax_specific`, `where_did_money_go`, `is_financial_loss`, `recommended_action`).
- Implemented with Scikit-Learn (`RandomForestClassifier`, TF-IDF / syntactic feature extraction).
- Evaluated with 100% test accuracy across all benchmark queries.
- **Zero Cloud / External LLM Dependencies**: Completely eliminates vendor API keys, token fees, and cloud latency.

---

## Standalone Development Fallback Mode

If you run Payvault standalone without Docker (`npm start`) on a machine where PostgreSQL or Redis daemons are offline:
- The database connection layer ([src/db/postgres.js](file:///Users/aaradhychinche/RazorPay/src/db/postgres.js)) switches to `DEVELOPMENT_FALLBACK`.
- The Redis layer ([src/db/redis.js](file:///Users/aaradhychinche/RazorPay/src/db/redis.js)) switches to an internal `InMemoryRedisStore`.
- The server logs clear startup notices:
  ```
  [Payvault DB] PostgreSQL unavailable or unconfigured. Operating in DEVELOPMENT FALLBACK mode.
  [Payvault Redis] Redis unavailable. Operating with in-memory transient store fallback.
  ```
- This fallback mode is designed strictly for unit tests and local frontend UI development. For standard development and deployment, use Docker Compose.

---

## Service Health Checks

Payvault exposes dedicated health verification endpoints:
- `GET /health`
- `GET /api/health`

### Example Health Response
```json
{
  "status": "healthy",
  "timestamp": "2026-09-05T16:20:31.577Z",
  "uptime_seconds": 342,
  "database": {
    "status": "connected",
    "mode": "POSTGRES_PRODUCTION"
  },
  "redis": {
    "status": "connected",
    "mode": "REDIS_PERSISTENT"
  },
  "razorpay": {
    "configured": true,
    "mode": "test"
  }
}
```

*Note: The health endpoint returns operational statuses and active modes only; credentials, connection URLs, and secrets are strictly excluded.*

---

## Razorpay Test Mode vs Synthetic Simulation

Payvault supports two testing modes for payment ingestion:

1. **Razorpay Test Mode**:
   - Uses real Razorpay Test credentials (`RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`).
   - Launches the real Razorpay standard web checkout modal.
   - Client verifies cryptographic HMAC-SHA256 signatures upon payment completion.
   - Captures real payment IDs (e.g., `pay_...`).
2. **Settlement Simulator & Synthetic Benchmark**:
   - Payment gateway sandboxes do not execute actual bank settlement batches (UTRs).
   - Payvault's settlement simulator creates deterministic settlement batches and injects realistic real-world discrepancies (timing gaps, fee miscalculations, GST variances) so you can test reconciliation and exception investigations end-to-end.

---

## Testing & Quality Assurance

The Payvault test suite validates deterministic accuracy, persistence correctness, and AI reliability.

### Running Automated Tests

```bash
# 1. Run all Node.js Jest test suites
npm test

# 2. Run Python ML intent classification unit tests
python3 -m unittest discover -s tests

# 3. Run ML benchmark evaluation script
node scripts/evaluate.js
```

### Verified Test Coverage

- **Jest Suites**: 10 passed, 10 total (**430 tests passed**)
- **Python ML Tests**: 7 passed, 7 total
- **Persistence & Isolation Suite** (`tests/persistenceAndIsolation.test.js`):
  - Strict integer-paise validation in repositories
  - PostgreSQL CRUD operations for payments, reconciliation, investigations, and audit logs
  - Redis conversation state saving, TTL expiration, and scoped key formats
  - Multi-turn conversation state retention
  - Strict Case Isolation (Case A context never leaks into Case B)
  - 8-turn conversation regression test
  - Investigation ID mapping verification (canonical exception IDs)

---

## Project Structure

```
├── Dockerfile                      # Production container build definition
├── docker-compose.yml              # Multi-container orchestration (App, Postgres, Redis)
├── server.js                       # Express bootstrap, health endpoints, graceful shutdown
├── package.json                    # Node.js dependencies & test scripts
├── .env.example                    # Template for environment configuration
│
├── public/                         # Frontend Single-Page Application
│   ├── index.html                  # Operations workstation layout & templates
│   ├── checkout.js                 # Reactive UI state, investigation, and chat client
│   └── style.css                   # Custom obsidian fintech design system
│
├── src/
│   ├── db/                         # Persistence & Caching Layer
│   │   ├── postgres.js             # PostgreSQL connection pool & health probes
│   │   ├── redis.js                # Redis client with in-memory fallback & TTL
│   │   ├── migrator.js             # Versioned migration runner
│   │   ├── migrations/
│   │   │   └── 001_initial_schema.sql  # Core DDL schema definition
│   │   └── repositories/
│   │       ├── paymentRepository.js
│   │       ├── orderRepository.js
│   │       ├── settlementRepository.js
│   │       ├── reconciliationRepository.js
│   │       ├── investigationRepository.js
│   │       └── auditRepository.js
│   │
│   ├── engine/                     # Deterministic Reconciliation Engine
│   │   ├── reconcile.js            # Transaction matching logic
│   │   ├── rules.js                # Discrepancy detection rules
│   │   └── config.js               # Tolerances and settlement windows
│   │
│   ├── investigation/              # AI Investigation & Copilot
│   │   ├── caseBuilder.js          # Constructs unified investigation cases
│   │   ├── financialAnalysis.js    # Exact paise-level variance calculations
│   │   ├── suggestions.js          # Resolution suggestions generator
│   │   ├── chat/
│   │   │   ├── chatRouter.js       # Payvault AI chat orchestrator
│   │   │   ├── nativeReasoning.js  # Grounded causal explanation engine
│   │   │   ├── conversationState.js# Redis-backed session state builder
│   │   │   └── chatContextBuilder.js
│   │   └── intelligence/
│   │       └── context.js          # Historical patterns & anomaly context
│   │
│   ├── ml/                         # Local ML Subsystem
│   │   ├── intent_classifier.py    # Random Forest 26-intent classifier
│   │   ├── intent_dataset.py       # Benchmark training data
│   │   ├── train.py                # Model training pipeline
│   │   └── requirements.txt        # Python ML dependencies
│   │
│   ├── models/                     # Domain Models & Enums
│   │   └── resolution.js           # Case lifecycle & resolution reasons
│   │
│   ├── routes/                     # REST API Handlers
│   │   ├── investigations.js       # Case details, run action, resolve, chat
│   │   ├── reconciliation.js       # Reconciliation results & summary metrics
│   │   ├── exceptions.js           # Exception queries
│   │   └── demo.js                 # Demo data resets & Razorpay sync
│   │
│   └── store/
│       └── dataStore.js            # Application data store & state synchronization
│
└── tests/                          # Automated Verification
    ├── persistenceAndIsolation.test.js # Postgres, Redis, and isolation suite
    ├── investigationUxUpgrade.test.js  # Investigation UI & summary section tests
    ├── chatCopilot.test.js             # Conversational copilot test suite
    ├── engine.test.js                  # Reconciliation mathematical rules
    └── test_ml.py                      # Python ML intent model validation
```

---

## Scalability & Production Readiness

Payvault's architecture is built to scale with growing transaction volumes:

- **Decoupled State Lifecycles**: Heavy, append-only financial records live permanently in PostgreSQL with B-tree indexed lookups. Short-lived conversational sessions live in Redis with automatic TTL expiration, preventing unbounded memory bloat.
- **Connection Pooling**: PostgreSQL connections are pooled via `pg.Pool` with bounded timeouts and graceful termination on `SIGINT` / `SIGTERM`.
- **Stateless Application Nodes**: Because conversation state is managed in Redis and data is stored in PostgreSQL, Payvault application containers can be horizontally scaled behind a standard load balancer.
- **Microsecond Intent Inference**: Local scikit-learn models execute in milliseconds without external network calls, rate limits, or outbound API egress costs.

---

## Troubleshooting

### 1. Docker Daemon Not Running
**Symptom**: `docker compose up` returns `Cannot connect to the Docker daemon`.  
**Solution**: Ensure Docker Desktop (or your Docker daemon) is running:
```bash
docker info
```

### 2. Port Already in Use (Port 3000, 5432, or 6379)
**Symptom**: `bind: address already in use`.  
**Solution**: Check for conflicting local processes:
```bash
# Check port 3000
lsof -i :3000
# Check port 5432 (local postgres)
lsof -i :5432
# Check port 6379 (local redis)
lsof -i :6379
```
Stop the conflicting process or change ports in your `.env` file (`PORT`, `POSTGRES_PORT`, `REDIS_PORT`).

### 3. PostgreSQL or Redis Not Healthy
**Symptom**: `payvault-app` waits indefinitely for database dependencies.  
**Solution**: Inspect container logs:
```bash
docker compose logs postgres
docker compose logs redis
```

### 4. Database Migrations Failed
**Symptom**: Application fails to boot with a migration error.  
**Solution**: Verify that `src/db/migrations/001_initial_schema.sql` syntax is valid and check container database logs:
```bash
docker compose logs app
```

---

## License

Payvault is proprietary software. All rights reserved.
