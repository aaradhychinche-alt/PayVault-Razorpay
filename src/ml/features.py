"""
src/ml/features.py

Feature engineering for the Payvault Learned Exception Intelligence model.
Extracts numerical and one-hot encoded signals from an InvestigationCase.

CRITICAL INTEGRITY RULE:
- NEVER extracts ground-truth label as a feature (no data leakage).
- All monetary figures are integer paise.
"""

from typing import Dict, Any, List
import numpy as np

FEATURE_NAMES = [
    # ── Financial features ──────────────────────────────────────────────────
    "amount_razorpay",
    "amount_merchant",
    "amount_variance",
    "abs_amount_variance",
    "gross_amount",
    "fee_actual",
    "fee_expected",
    "fee_variance",
    "abs_fee_variance",
    "tax_actual",
    "tax_expected",
    "tax_variance",
    "abs_tax_variance",
    "amount_at_risk",
    "fee_ratio",
    "tax_fee_ratio",
    # ── Structural & Relationship features ──────────────────────────────────
    "has_settlement_record",
    "has_merchant_order",
    "has_merchant_ledger",
    "has_refund_records",
    "refund_count",
    "total_refund_amount",
    "net_after_refunds",
    "is_type_payment",
    "is_type_refund",
    "is_type_adjustment",
    "missing_relationships_count",
    # ── Timeline & Process features ─────────────────────────────────────────
    "timeline_events_count",
    "simulated_events_count",
    # ── Categorical One-Hot Encodings ───────────────────────────────────────
    "method_card",
    "method_upi",
    "method_netbanking",
    "method_wallet",
    "ledger_pending",
    "ledger_settled",
    "order_paid",
    "order_pending",
    "order_refunded",
]


def extract_features(case: Dict[str, Any]) -> np.ndarray:
    """
    Extracts a 1D numpy float64 feature vector from a single InvestigationCase dict.
    Handles missing fields and nulls safely with sensible default fallbacks.
    """
    sr = case.get("settlement_record") or {}
    mo = case.get("merchant_order") or {}
    le = case.get("merchant_ledger") or {}
    rr = case.get("reconciliation_result") or {}
    fa = case.get("financial_analysis") or {}
    exc = case.get("exception") or {}
    refunds = case.get("refund_records") or []
    timeline = case.get("timeline") or []
    relationships = case.get("relationships") or []

    # Financial fields
    amount_razorpay = float(rr.get("amount_razorpay") or sr.get("credit") or 0)
    amount_merchant = float(rr.get("amount_merchant") or le.get("expected_amount") or 0)
    amount_variance = float(rr.get("amount_variance") or (amount_razorpay - amount_merchant))
    abs_amount_variance = abs(amount_variance)

    gross_amount = float(sr.get("amount") or fa.get("gross_amount") or mo.get("amount") or 0)
    fee_actual = float(sr.get("fee") or fa.get("fee_actual") or 0)
    fee_expected = float(rr.get("fee_expected") or fa.get("fee_expected") or 0)
    fee_variance = float(fa.get("fee_variance") if fa.get("fee_variance") is not None else (fee_actual - fee_expected))
    abs_fee_variance = abs(fee_variance)

    tax_actual = float(sr.get("tax") or fa.get("tax_actual") or 0)
    tax_expected = float(rr.get("tax_expected") or fa.get("tax_expected") or 0)
    tax_variance = float(fa.get("tax_variance") if fa.get("tax_variance") is not None else (tax_actual - tax_expected))
    abs_tax_variance = abs(tax_variance)

    amount_at_risk = float(exc.get("amount_at_risk") or case.get("amount_at_risk") or 0)
    fee_ratio = (fee_actual / gross_amount) if gross_amount > 0 else 0.0
    tax_fee_ratio = (tax_actual / fee_actual) if fee_actual > 0 else 0.0

    # Structural / Relationship flags
    has_settlement_record = 1.0 if case.get("settlement_record") is not None else 0.0
    has_merchant_order = 1.0 if case.get("merchant_order") is not None else 0.0
    has_merchant_ledger = 1.0 if case.get("merchant_ledger") is not None else 0.0
    has_refund_records = 1.0 if len(refunds) > 0 else 0.0
    refund_count = float(len(refunds))
    total_refund_amount = float(sum(r.get("amount", 0) for r in refunds))
    net_after_refunds = float(fa.get("net_after_refunds") or (amount_razorpay - total_refund_amount))

    sr_type = (sr.get("type") or "").lower()
    is_type_payment = 1.0 if sr_type == "payment" else 0.0
    is_type_refund = 1.0 if sr_type == "refund" else 0.0
    is_type_adjustment = 1.0 if sr_type == "adjustment" else 0.0

    missing_relationships_count = float(sum(1 for r in relationships if r.get("status") == "MISSING"))
    timeline_events_count = float(len(timeline))
    simulated_events_count = float(sum(1 for t in timeline if t.get("source") == "simulated"))

    # Categorical encodings
    method = (sr.get("method") or "").lower()
    method_card = 1.0 if method == "card" else 0.0
    method_upi = 1.0 if method == "upi" else 0.0
    method_netbanking = 1.0 if method == "netbanking" else 0.0
    method_wallet = 1.0 if method == "wallet" else 0.0

    ledger_status = (le.get("status") or "").lower()
    ledger_pending = 1.0 if ledger_status == "pending" else 0.0
    ledger_settled = 1.0 if ledger_status == "settled" else 0.0

    order_status = (mo.get("status") or "").lower()
    order_paid = 1.0 if order_status == "paid" else 0.0
    order_pending = 1.0 if order_status == "pending" else 0.0
    order_refunded = 1.0 if order_status == "refunded" else 0.0

    feature_values = [
        amount_razorpay,
        amount_merchant,
        amount_variance,
        abs_amount_variance,
        gross_amount,
        fee_actual,
        fee_expected,
        fee_variance,
        abs_fee_variance,
        tax_actual,
        tax_expected,
        tax_variance,
        abs_tax_variance,
        amount_at_risk,
        fee_ratio,
        tax_fee_ratio,
        has_settlement_record,
        has_merchant_order,
        has_merchant_ledger,
        has_refund_records,
        refund_count,
        total_refund_amount,
        net_after_refunds,
        is_type_payment,
        is_type_refund,
        is_type_adjustment,
        missing_relationships_count,
        timeline_events_count,
        simulated_events_count,
        method_card,
        method_upi,
        method_netbanking,
        method_wallet,
        ledger_pending,
        ledger_settled,
        order_paid,
        order_pending,
        order_refunded,
    ]

    return np.array(feature_values, dtype=np.float64)


def extract_feature_matrix(cases: List[Dict[str, Any]]) -> np.ndarray:
    """Extracts a 2D numpy array (num_cases, num_features) from a list of cases."""
    return np.vstack([extract_features(c) for c in cases])
