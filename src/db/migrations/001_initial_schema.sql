-- 001_initial_schema.sql
-- Payvault Initial Schema Migration
-- All monetary amounts MUST be strictly stored as integer paise (BIGINT).
-- Never use floating-point types (FLOAT, REAL, NUMERIC without scale) for money.

-- 1. Orders
CREATE TABLE IF NOT EXISTS orders (
  id VARCHAR(128) PRIMARY KEY,
  merchant_id VARCHAR(128),
  customer_id VARCHAR(128),
  amount_paise BIGINT NOT NULL CHECK (amount_paise >= 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  status VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);

-- 2. Payments
CREATE TABLE IF NOT EXISTS payments (
  id VARCHAR(128) PRIMARY KEY,
  order_id VARCHAR(128) REFERENCES orders(id) ON DELETE SET NULL,
  amount_paise BIGINT NOT NULL CHECK (amount_paise >= 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  status VARCHAR(64) NOT NULL,
  method VARCHAR(64),
  bank VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- 3. Settlements
CREATE TABLE IF NOT EXISTS settlements (
  id VARCHAR(128) PRIMARY KEY,
  entity_id VARCHAR(128) NOT NULL,
  type VARCHAR(64) NOT NULL,
  debit_paise BIGINT NOT NULL DEFAULT 0,
  credit_paise BIGINT NOT NULL DEFAULT 0,
  amount_paise BIGINT NOT NULL DEFAULT 0,
  fee_paise BIGINT NOT NULL DEFAULT 0,
  tax_paise BIGINT NOT NULL DEFAULT 0,
  settled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  utr VARCHAR(128),
  settlement_id VARCHAR(128),
  order_id VARCHAR(128),
  payment_id VARCHAR(128),
  batch_id VARCHAR(128),
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_settlements_type ON settlements(type);
CREATE INDEX IF NOT EXISTS idx_settlements_order_id ON settlements(order_id);
CREATE INDEX IF NOT EXISTS idx_settlements_payment_id ON settlements(payment_id);
CREATE INDEX IF NOT EXISTS idx_settlements_utr ON settlements(utr);

-- 4. Investigations
CREATE TABLE IF NOT EXISTS investigations (
  id VARCHAR(128) PRIMARY KEY,
  exception_id VARCHAR(128) NOT NULL,
  case_id VARCHAR(128) UNIQUE NOT NULL,
  exception_category VARCHAR(64) NOT NULL,
  status VARCHAR(64) NOT NULL DEFAULT 'OPEN',
  amount_at_risk_paise BIGINT NOT NULL DEFAULT 0,
  summary TEXT,
  what_happened TEXT,
  why_it_matters TEXT,
  recommended_actions JSONB DEFAULT '[]'::jsonb,
  evidence_summary JSONB DEFAULT '{}'::jsonb,
  confidence_score NUMERIC(4,3),
  raw_investigation JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_investigations_case_id ON investigations(case_id);
CREATE INDEX IF NOT EXISTS idx_investigations_status ON investigations(status);
CREATE INDEX IF NOT EXISTS idx_investigations_cat ON investigations(exception_category);

-- 5. Investigation Events (Lifecycle transitions, milestones)
CREATE TABLE IF NOT EXISTS investigation_events (
  id VARCHAR(128) PRIMARY KEY,
  investigation_id VARCHAR(128) NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  event_type VARCHAR(64) NOT NULL,
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_investigation_events_inv_id ON investigation_events(investigation_id);

-- 6. Refunds
CREATE TABLE IF NOT EXISTS refunds (
  id VARCHAR(128) PRIMARY KEY,
  payment_id VARCHAR(128) REFERENCES payments(id) ON DELETE SET NULL,
  amount_paise BIGINT NOT NULL CHECK (amount_paise >= 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  status VARCHAR(64) NOT NULL DEFAULT 'processed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_refunds_payment_id ON refunds(payment_id);

-- 7. Reconciliation Results (Deterministic Reconciliation Output)
CREATE TABLE IF NOT EXISTS reconciliation_results (
  id VARCHAR(128) PRIMARY KEY,
  settlement_entity_id VARCHAR(128) NOT NULL,
  merchant_order_id VARCHAR(128),
  merchant_ledger_id VARCHAR(128),
  payment_entity_id VARCHAR(128),
  refund_entity_ids JSONB DEFAULT '[]'::jsonb,
  status VARCHAR(64) NOT NULL,
  exception_category VARCHAR(64),
  reason TEXT NOT NULL,
  amount_razorpay_paise BIGINT,
  amount_merchant_paise BIGINT,
  amount_variance_paise BIGINT,
  fee_expected_paise BIGINT,
  fee_actual_paise BIGINT,
  tax_expected_paise BIGINT,
  tax_actual_paise BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_results_status ON reconciliation_results(status);
CREATE INDEX IF NOT EXISTS idx_reconciliation_results_cat ON reconciliation_results(exception_category);
CREATE INDEX IF NOT EXISTS idx_reconciliation_results_settlement ON reconciliation_results(settlement_entity_id);

-- 8. Audit Events (Immutable compliance ledger)
CREATE TABLE IF NOT EXISTS audit_events (
  id VARCHAR(128) PRIMARY KEY,
  case_id VARCHAR(128) NOT NULL,
  action VARCHAR(64) NOT NULL,
  actor VARCHAR(128) NOT NULL,
  from_status VARCHAR(64),
  to_status VARCHAR(64),
  resolution_reason VARCHAR(128),
  notes TEXT,
  amount_at_risk_paise BIGINT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_events_case_id ON audit_events(case_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events(timestamp);
