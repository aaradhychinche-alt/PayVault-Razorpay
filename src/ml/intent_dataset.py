"""
src/ml/intent_dataset.py

Payvault AI — Intent Classification Training Dataset Generator.

Generates 20,000+ labeled natural-language investigation questions
covering all Payvault investigation intents.

Intents defined:
  GROSS_AMOUNT, EXPECTED_SETTLEMENT, ACTUAL_SETTLEMENT, NET_SETTLEMENT,
  FEE_AMOUNT, FEE_VARIANCE, GST_AMOUNT, GST_VARIANCE, SETTLEMENT_VARIANCE,
  FINANCIAL_IMPACT, CASE_SUMMARY, CAUSE_ANALYSIS, TIMELINE, EVIDENCE,
  NEXT_ACTION, ESCALATION, RESOLUTION, RELATED_TRANSACTION,
  HISTORICAL_COMPARISON, SIMILAR_CASE, EXPLANATION, CLARIFICATION,
  CONFIRMATION, GENERAL_INVESTIGATION_QUERY, UNKNOWN_QUERY

Design:
- Payvault-specific core dataset (majority)
- BANKING77-inspired linguistic diversity (supplementary, relabeled)
- Multiple phrasings per intent (semantic generalization)
- Casual / informal / short question variants
- Multi-word entity references ("the fee", "gst", "settlement difference")
- Ground truth labels explicitly defined per example
"""

import random
import json
import os

random.seed(42)

# ── Intent canonical names ────────────────────────────────────────────────────
INTENTS = [
    "GROSS_AMOUNT",
    "EXPECTED_SETTLEMENT",
    "ACTUAL_SETTLEMENT",
    "NET_SETTLEMENT",
    "FEE_AMOUNT",
    "FEE_VARIANCE",
    "GST_AMOUNT",
    "GST_VARIANCE",
    "SETTLEMENT_VARIANCE",
    "FINANCIAL_IMPACT",
    "CASE_SUMMARY",
    "CAUSE_ANALYSIS",
    "TIMELINE",
    "EVIDENCE",
    "NEXT_ACTION",
    "ESCALATION",
    "RESOLUTION",
    "RESOLUTION_GUIDANCE",
    "RELATED_TRANSACTION",
    "HISTORICAL_COMPARISON",
    "SIMILAR_CASE",
    "EXPLANATION",
    "CLARIFICATION",
    "CONFIRMATION",
    "GENERAL_INVESTIGATION_QUERY",
    "UNKNOWN_QUERY",
]

# ── Core Payvault question templates ─────────────────────────────────────────

PAYVAULT_QUESTIONS = {

    "GROSS_AMOUNT": [
        "What is the gross amount?",
        "What is the gross amount I got?",
        "What is the gross amount received?",
        "How much did the customer pay?",
        "What was the original payment?",
        "How much was processed?",
        "What was the total transaction amount?",
        "How much did the buyer pay?",
        "What is the original amount?",
        "What was the customer payment?",
        "What was the gross payment?",
        "How much did the customer spend?",
        "What is the full transaction value?",
        "Tell me the gross amount",
        "Show me the gross",
        "What's the gross?",
        "Gross amount?",
        "How much was the original transaction?",
        "What did the customer pay in total?",
        "What is the transaction amount?",
        "How much was charged to the customer?",
        "What is the total amount charged?",
        "What was the payment amount?",
        "How much was the payment?",
        "What's the full amount?",
        "What is the original charge?",
        "How much did we collect from the buyer?",
        "What was the purchase amount?",
        "What is the sale amount?",
        "What is the checkout amount?",
        "What amount did the customer submit?",
        "How big was the transaction?",
        "What is the size of this payment?",
        "What was the authorized amount?",
        "What is the captured amount?",
        "Total customer payment?",
        "Transaction value?",
        "Payment size?",
    ],

    "EXPECTED_SETTLEMENT": [
        "What should we have received?",
        "What was the expected settlement?",
        "What was the expected payout?",
        "How much were we supposed to get?",
        "What is the expected net amount?",
        "What was the expected credit?",
        "What should the settlement be?",
        "What should have been settled?",
        "What was the projected settlement?",
        "How much was expected?",
        "What's the expected payout?",
        "Expected settlement amount?",
        "What should we have gotten?",
        "What is the contractual settlement?",
        "What was anticipated?",
        "How much should we get after fees?",
        "What was the expected disbursement?",
        "What was the scheduled credit?",
        "Expected net?",
        "What is our expected net receipt?",
    ],

    "ACTUAL_SETTLEMENT": [
        "What did we actually receive?",
        "What was the actual settlement?",
        "How much was credited?",
        "What was actually deposited?",
        "What was the actual payout?",
        "How much did we get?",
        "What was the credit received?",
        "What was the actual credit?",
        "What did we get paid?",
        "What was actually settled?",
        "How much was deposited?",
        "Actual settlement?",
        "What was received in the bank?",
        "How much came in?",
        "What is the real settlement?",
        "What did the gateway actually credit?",
        "What was deposited into the account?",
        "How much actually landed?",
        "What was the disbursement?",
        "Actual payout?",
    ],

    "NET_SETTLEMENT": [
        "What is the net settlement?",
        "What is the net amount?",
        "What is the net payout?",
        "What is the net credit?",
        "Net settlement amount?",
        "What is net?",
        "How is the net calculated?",
        "What is the net settlement formula?",
        "How is net settlement derived?",
    ],

    "FEE_AMOUNT": [
        "What was the fee?",
        "How much was the fee?",
        "What was the platform fee?",
        "How much did the gateway charge in fees?",
        "What was charged as fee?",
        "Fee amount?",
        "What is the fee deducted?",
        "How much fee was deducted?",
        "What was the gateway fee?",
        "How much was taken as fee?",
        "What is the platform charge?",
        "How much was the processing fee?",
        "What is the service fee?",
        "Actual fee amount?",
        "Fee charged?",
        "How much was the transaction fee?",
        "What was the deduction fee?",
        "What fee did they charge?",
    ],

    "FEE_VARIANCE": [
        "What was the fee overcharge?",
        "How much was the fee overcharged?",
        "What is the fee variance?",
        "How much extra fee was charged?",
        "What is the fee discrepancy?",
        "How much more than expected was the fee?",
        "What is the difference in fee?",
        "Fee variance?",
        "How much did the fee deviate?",
        "Fee overcharge amount?",
        "By how much was the fee wrong?",
        "What is the excess fee?",
        "How much extra was deducted as fee?",
        "Is the fee the problem?",
        "Is the fee wrong?",
        "What was the fee discrepancy?",
        "How much was overcharged in fees?",
        "Fee difference?",
        "What is the platform fee problem?",
        "Why is the fee different?",
        "What drove the fee variance?",
        "What's wrong with the fee?",
    ],

    "GST_AMOUNT": [
        "What about GST?",
        "and GST?",
        "What was the GST?",
        "How much was GST?",
        "What was the tax?",
        "How much tax was charged?",
        "GST amount?",
        "What is the GST charged?",
        "How much GST did they deduct?",
        "What was the tax deduction?",
        "How much was taken as GST?",
        "What is the service tax?",
        "How much was the tax?",
        "Tax amount?",
        "What GST was applied?",
        "What is the GST here?",
        "How much GST?",
    ],

    "GST_VARIANCE": [
        "What was the GST overcharge?",
        "How much was GST overcharged?",
        "What is the GST variance?",
        "How much extra GST was charged?",
        "GST variance?",
        "What is the GST discrepancy?",
        "How much did GST contribute to the difference?",
        "How much tax contributed to the difference?",
        "What is the tax variance?",
        "By how much was GST wrong?",
        "What is the GST problem?",
        "How much GST was in excess?",
        "GST overcharge?",
        "GST difference?",
        "What is wrong with the GST?",
        "How did GST contribute to the shortfall?",
        "Is GST the issue?",
        "Is GST contributing to the difference?",
    ],

    "SETTLEMENT_VARIANCE": [
        "Why is the settlement short?",
        "Why is there a difference?",
        "Why does the amount not match?",
        "What is the settlement variance?",
        "What is the settlement shortfall?",
        "How much is missing?",
        "What is the difference?",
        "What is the discrepancy?",
        "Settlement variance?",
        "What is the mismatch?",
        "Why is there a gap?",
        "What is the reconciliation difference?",
        "How much is the shortfall?",
        "Total shortfall?",
        "How much are we short?",
        "What is the total difference?",
        "Explain the shortfall",
        "What explains the variance?",
        "Why is the settlement different?",
        "Why did the settlement differ?",
        "Settlement difference?",
        "How much is the variance?",
        "Why is there a variance?",
    ],

    "FINANCIAL_IMPACT": [
        "What is the financial impact?",
        "How much is at risk?",
        "What is the total exposure?",
        "How much money is affected?",
        "What is the total loss?",
        "How much is this costing us?",
        "What is the monetary impact?",
        "Financial impact?",
        "What is the risk amount?",
        "How bad is this financially?",
        "Total financial exposure?",
        "What is the amount at risk?",
        "How much did we lose?",
        "Is this a real loss?",
        "Is this an actual loss?",
        "Is the merchant losing money?",
        "Are we actually losing money?",
        "Is this a real financial loss?",
        "What is our financial exposure?",
        "How much could we lose?",
    ],

    "CASE_SUMMARY": [
        "What is this case about?",
        "Summarize this case",
        "What is the summary?",
        "Give me a summary",
        "Case summary?",
        "Explain this case",
        "What is going on?",
        "What's happening here?",
        "Give me the overview",
        "Overview?",
        "What is this exception about?",
        "Describe this case",
        "Brief summary?",
        "What happened here?",
        "What is the situation?",
    ],

    "CAUSE_ANALYSIS": [
        "What happened?",
        "Why did this happen?",
        "What caused this?",
        "What went wrong?",
        "What is the root cause?",
        "What triggered this?",
        "Why was this flagged?",
        "Why was this detected?",
        "What is the cause?",
        "How did this happen?",
        "What is the reason?",
        "What led to this?",
        "What is the underlying cause?",
        "Root cause?",
        "Tell me what happened",
        "What is this about?",
        "Explain what happened",
        "Why did this occur?",
        "What created this exception?",
        "What generated this flag?",
        "Why is this an exception?",
        "What is wrong here?",
        "What is the issue?",
    ],

    "TIMELINE": [
        "What is the timeline?",
        "When did this happen?",
        "What are the timestamps?",
        "Show me the timeline",
        "When was this flagged?",
        "What are the key dates?",
        "Timeline of events?",
        "When was the payment made?",
        "When was the settlement?",
        "What time did this happen?",
        "What is the sequence of events?",
        "When did the discrepancy occur?",
    ],

    "EVIDENCE": [
        "What evidence supports this?",
        "What is the evidence?",
        "What proves this?",
        "What documentation exists?",
        "What records are there?",
        "Show me the evidence",
        "Evidence?",
        "What data supports the finding?",
        "What supports this conclusion?",
        "What is the proof?",
        "What are the supporting facts?",
        "What records support this?",
        "What sources is this based on?",
        "Evidence base?",
        "What do the records show?",
        "What data is available?",
    ],

    "NEXT_ACTION": [
        "What should I do now?",
        "What do I do next?",
        "What are the next steps?",
        "What is my next step?",
        "What now?",
        "Where do I go from here?",
        "What to do?",
        "What should I do?",
        "Next steps?",
        "What action should I take?",
        "What should I focus on?",
        "What is the recommended action?",
        "What should I check?",
        "How should I proceed?",
        "What should we do?",
        "What do I do about this?",
        "Action plan?",
        "What is the first step?",
        "What should be done?",
        "Recommended steps?",
        "What must I do?",
        "What can I do?",
        "What steps should I take?",
        "How should I handle this?",
        "How should I resolve this?",
        "What is the procedure?",
        "What should I verify?",
        "What should I validate?",
        "What should I confirm?",
        "Before resolving, what should I check?",
    ],

    "ESCALATION": [
        "Should I escalate this?",
        "Does this need escalation?",
        "Should this be escalated?",
        "Do I need to escalate?",
        "Escalate?",
        "Is this worth escalating?",
        "Should I flag this to a senior?",
        "Should this go to finance?",
        "Is escalation required?",
        "Should I raise this?",
        "Does this warrant escalation?",
        "Is this escalation-worthy?",
        "Escalation needed?",
        "Who should I escalate to?",
        "Should this go up the chain?",
    ],

    "RESOLUTION": [
        "How do I resolve this?",
        "How do I close this?",
        "When can I resolve this?",
        "What is needed to resolve?",
        "Can I resolve this now?",
        "Resolution process?",
        "How to close this case?",
        "What needs to happen before I resolve?",
        "When is it safe to close?",
        "Resolution criteria?",
        "How to fix this?",
        "What is the resolution path?",
    ],

    "RELATED_TRANSACTION": [
        "What are the related transactions?",
        "Are there related payments?",
        "What other transactions are linked?",
        "Related transactions?",
        "What other payments are involved?",
        "Are there sibling transactions?",
        "What is the linked payment?",
        "Are there duplicate transactions?",
        "What other records are linked?",
    ],

    "HISTORICAL_COMPARISON": [
        "Is this similar to previous cases?",
        "Has this happened before?",
        "Are there similar cases?",
        "What is the history?",
        "Historical comparison?",
        "Have we seen this pattern before?",
        "Is this a repeat?",
        "What does the history show?",
        "Similar cases in history?",
        "What is the precedent?",
    ],

    "SIMILAR_CASE": [
        "Is this like other cases?",
        "Similar cases?",
        "Find similar cases",
        "Are there comparable exceptions?",
        "What cases look like this?",
        "Are there patterns from other cases?",
        "What other cases match this?",
    ],

    "EXPLANATION": [
        "Explain this to me",
        "Can you explain?",
        "Explain in simple terms",
        "Plain English explanation?",
        "Give me a simple explanation",
        "Break this down for me",
        "Explain simply",
        "Can you break that down?",
        "Simplify this",
        "Explain like I'm new",
        "What does this mean?",
        "What does this represent?",
        "What does the shortfall mean?",
        "What does this variance mean?",
    ],

    "CLARIFICATION": [
        "But how?",
        "How?",
        "What do you mean?",
        "Can you clarify?",
        "I don't understand",
        "What does that mean?",
        "Can you explain that?",
        "Tell me more",
        "Elaborate",
        "More details?",
        "What exactly?",
        "How exactly?",
        "Why exactly?",
    ],

    "CONFIRMATION": [
        "Is that right?",
        "Is that correct?",
        "Are you sure?",
        "Confirm this",
        "Is this accurate?",
        "Can you confirm?",
        "Is that the correct amount?",
        "Double check that",
        "Verify that",
        "Is this confirmed?",
    ],

    "GENERAL_INVESTIGATION_QUERY": [
        "Give me the full picture",
        "Full breakdown",
        "Give me all the numbers",
        "Complete financial breakdown",
        "Full financial summary",
        "All the details",
        "Everything about this case",
        "Complete breakdown",
        "Full details",
        "What are all the figures?",
        "Give me a comprehensive view",
        "Full analysis",
    ],

    "UNKNOWN_QUERY": [
        "What is the weather today?",
        "Tell me a joke",
        "What is 2 + 2?",
        "Who is the CEO of Razorpay?",
        "What time is it?",
        "Can you help me with Python?",
        "What is the stock price?",
        "How do I make a sandwich?",
        "What is the capital of France?",
        "Write me a poem",
        "What are the best movies this year?",
        "How is the economy doing?",
        "What does DNA stand for?",
        "Help me with my homework",
        "What is the speed of light?",
        "Tell me about quantum physics",
        "What is machine learning?",
        "Recommend a book",
        "What language is spoken in Brazil?",
        "How do I cook pasta?",
    ],

    # ── NEW: Resolution Guidance (Readiness Inquiry) ─────────────────────────
    # Distinct from RESOLUTION (state-mutation) — these ask WHETHER to resolve,
    # not command the AI to resolve. This is a question about readiness.
    "RESOLUTION_GUIDANCE": [
        # Can-I / Is-it-okay phrasing
        "Can I close this case?",
        "Can I resolve this?",
        "Is it okay to close this?",
        "Is it okay to resolve this?",
        "Okay to close?",
        "Okay to resolve?",
        "Is it safe to close this?",
        "Is it safe to resolve this?",
        "Can I close it?",
        "Can I resolve it?",
        "Can this case be closed?",
        "Can this be resolved?",
        # Readiness inquiry phrasing
        "Is this ready to close?",
        "Is this ready to resolve?",
        "Is the case ready to be closed?",
        "Is the investigation complete?",
        "Am I ready to resolve this?",
        "Are we ready to close?",
        "Is everything done to close?",
        "Is enough done to resolve?",
        "Do we have enough to resolve this?",
        # Should-I phrasing
        "Should I close this now?",
        "Should I resolve this case?",
        "Should I go ahead and close it?",
        "Is it time to resolve this?",
        "When can I close this case?",
        "When can I resolve this?",
        "When is it okay to close?",
        # Is-this-done phrasing
        "Is this case done?",
        "Is this investigation done?",
        "Is this complete enough to close?",
        "Is there anything else before I close?",
        "Do I need to do anything before closing?",
        "What else do I need to do before closing?",
        "What is needed before I can resolve?",
    ],

    # ── Extended phrasings for Generalization Test Coverage ──────────────────
    # These novel phrasings ensure the model generalises across unseen questions
}

# Additional phrasings appended to existing intents for richer generalization
# Each extends the base dict with variations the model has not seen verbatim.
PAYVAULT_QUESTIONS_EXTENDED = {
    "GROSS_AMOUNT": [
        "What was the full payment before anything was deducted?",
        "How much did the customer originally pay?",
        "What is the pre-deduction amount?",
        "What amount went into the payment gateway?",
        "What is the face value of this transaction?",
    ],
    "EXPECTED_SETTLEMENT": [
        "Under the merchant contract, what should have been paid?",
        "What was the expected disbursement amount?",
        "How much would the merchant receive if the fee was correct?",
        "Under the correct fee rate, what is the expected net?",
        "What amount should the gateway have credited?",
    ],
    "ACTUAL_SETTLEMENT": [
        "How much was actually deposited into the merchant account?",
        "What did the gateway actually transfer?",
        "What is the real payout amount?",
        "How much actually landed in the account?",
        "What credit was received?",
    ],
    "FEE_VARIANCE": [
        "By how much did the fee exceed the contracted rate?",
        "What is the excess fee amount?",
        "How much more did the gateway take in fees than it should?",
        "What is the gateway fee discrepancy?",
        "What is the overcharged fee component?",
    ],
    "GST_VARIANCE": [
        "By how much did the GST exceed what was expected?",
        "What is the excess GST deduction?",
        "How much more GST was deducted than contracted?",
        "What is the GST discrepancy?",
        "How much GST was added beyond the contracted amount?",
    ],
    "SETTLEMENT_VARIANCE": [
        "How much is the settlement shortfall?",
        "What is the gap between expected and actual settlement?",
        "How much money is missing from the settlement?",
        "What is the net settlement discrepancy?",
        "Why does the settlement amount not match the expected figure?",
    ],
    "CAUSE_ANALYSIS": [
        "What root cause was identified?",
        "What triggered this investigation?",
        "What went wrong with the reconciliation?",
        "What is the identified cause of this exception?",
        "Why was a discrepancy detected?",
        "What is at the root of this issue?",
    ],
    "EVIDENCE": [
        "What records confirm this exception?",
        "Is there enough documentation to dispute this?",
        "What data is available to support the investigation?",
        "What settlement records are available?",
        "What does the reconciliation data show?",
        "Is there enough evidence to challenge the gateway?",
    ],
    "NEXT_ACTION": [
        "What is the recommended course of action?",
        "How should I handle this now?",
        "What steps should the operator take?",
        "What should my team do about this?",
        "What is the procedure for resolving this exception?",
        "Walk me through the process of fixing this.",
    ],
    "FINANCIAL_IMPACT": [
        "Does this represent a real financial loss?",
        "Is the merchant genuinely losing money here?",
        "How much money is at risk in this case?",
        "What is the financial damage?",
        "Is this costing the merchant real money?",
    ],
    "ESCALATION": [
        "Does this need to be escalated?",
        "Is this serious enough to escalate?",
        "At what point would this be escalated?",
        "Who would this be escalated to?",
        "Is this an escalation-worthy case?",
    ],
    "HISTORICAL_COMPARISON": [
        "Have we seen this kind of exception before?",
        "Is this part of a recurring pattern?",
        "Are there other similar cases in the system?",
        "How does this compare to previous exceptions?",
        "Is this exception unique or a known pattern?",
    ],
    "EXPLANATION": [
        "Can you break this case down simply?",
        "Explain this case to me in plain terms.",
        "I don't understand this — can you explain?",
        "Give me a simple overview of what happened.",
        "Summarize this in a way I can understand.",
    ],
    "RESOLUTION_GUIDANCE": [
        # Additional novel phrasings not in the base list
        "Are we ready to mark this as resolved?",
        "Have all the steps been completed for closing?",
        "Is it appropriate to close the case now?",
        "What needs to happen before we can close this?",
        "Has the investigation been completed?",
        "Is there anything else we need before resolving?",
        "At what point can we close this exception?",
        "Can the operator safely close this case?",
        "Is the investigation at a resolution point?",
        "What is the condition for resolution?",
    ],
}

# Merge extended phrasings into the main dict
for _intent, _questions in PAYVAULT_QUESTIONS_EXTENDED.items():
    if _intent in PAYVAULT_QUESTIONS:
        PAYVAULT_QUESTIONS[_intent].extend(_questions)
    else:
        PAYVAULT_QUESTIONS[_intent] = _questions


# ── Augmentation helpers ──────────────────────────────────────────────────────

CASUAL_PREFIXES = [
    "", "", "", "", "",  # most have no prefix (natural)
    "hey, ", "ok so, ", "quick question: ", "can you tell me ",
    "i need to know ", "could you tell me ",
]

FILLER_SUFFIXES = [
    "", "", "", "",  # most have no suffix
    " please", " thanks", "?", " for this case", " here",
]

def augment(question):
    """Generate augmented variant of a question."""
    prefix = random.choice(CASUAL_PREFIXES)
    suffix = random.choice(FILLER_SUFFIXES)
    q = prefix + question.lower().rstrip("?").rstrip(".") + suffix
    # Sometimes add a "?"
    if random.random() > 0.3 and not q.endswith("?"):
        q += "?"
    return q

# ── Multi-turn conversation templates ─────────────────────────────────────────

MULTI_TURN_TEMPLATES = [
    {
        "turns": [
            ("What happened?", "CAUSE_ANALYSIS"),
            ("What about GST?", "GST_AMOUNT"),
            ("But how?", "CLARIFICATION"),
            ("What should I do now?", "NEXT_ACTION"),
        ]
    },
    {
        "turns": [
            ("What is the gross amount I got?", "GROSS_AMOUNT"),
            ("How much was deducted?", "FEE_AMOUNT"),
            ("Why is the settlement different?", "SETTLEMENT_VARIANCE"),
        ]
    },
    {
        "turns": [
            ("What evidence supports this?", "EVIDENCE"),
            ("Should I escalate?", "ESCALATION"),
        ]
    },
    {
        "turns": [
            ("Summarize this case", "CASE_SUMMARY"),
            ("What are the next steps?", "NEXT_ACTION"),
            ("Can I resolve this now?", "RESOLUTION_GUIDANCE"),
            ("What do I need to do before closing?", "RESOLUTION_GUIDANCE"),
        ]
    },
    {
        "turns": [
            ("What was the fee overcharge?", "FEE_VARIANCE"),
            ("And the GST?", "GST_AMOUNT"),
            ("Why is there a gap in settlement?", "SETTLEMENT_VARIANCE"),
        ]
    },
    {
        "turns": [
            ("What happened?", "CAUSE_ANALYSIS"),
            ("How much is the shortfall?", "SETTLEMENT_VARIANCE"),
            ("Is this a real loss?", "FINANCIAL_IMPACT"),
        ]
    },
    {
        "turns": [
            ("What is the gross amount?", "GROSS_AMOUNT"),
            ("What should we have received?", "EXPECTED_SETTLEMENT"),
            ("What did we actually receive?", "ACTUAL_SETTLEMENT"),
            ("So what is the difference?", "SETTLEMENT_VARIANCE"),
        ]
    },
    {
        "turns": [
            ("Should I escalate this?", "ESCALATION"),
            ("What evidence supports that?", "EVIDENCE"),
            ("What do I do first?", "NEXT_ACTION"),
        ]
    },
    {
        "turns": [
            ("Why was this flagged?", "CAUSE_ANALYSIS"),
            ("What caused this?", "CAUSE_ANALYSIS"),
            ("Is there a pattern?", "HISTORICAL_COMPARISON"),
        ]
    },
    {
        "turns": [
            ("Explain this to me simply", "EXPLANATION"),
            ("What is the fee variance?", "FEE_VARIANCE"),
            ("What about GST variance?", "GST_VARIANCE"),
        ]
    },
]

# ── Financial calculation cases ───────────────────────────────────────────────

def generate_financial_case():
    """Generate a synthetic financial calculation test case."""
    gross_paise = random.randint(10000, 10000000)  # ₹100 to ₹100,000
    fee_rate = random.choice([0.02, 0.025, 0.03, 0.015])
    gst_rate = 0.18
    actual_fee_rate = fee_rate * random.choice([1.0, 1.5, 2.0, 2.25, 0.8])

    expected_fee = int(gross_paise * fee_rate)
    actual_fee = int(gross_paise * actual_fee_rate)
    expected_gst = int(expected_fee * gst_rate)
    actual_gst = int(actual_fee * gst_rate)
    expected_net = gross_paise - expected_fee - expected_gst
    actual_net = gross_paise - actual_fee - actual_gst
    fee_variance = actual_fee - expected_fee
    gst_variance = actual_gst - expected_gst
    shortfall = fee_variance + gst_variance

    return {
        "gross_paise": gross_paise,
        "expected_fee_paise": expected_fee,
        "actual_fee_paise": actual_fee,
        "fee_variance_paise": fee_variance,
        "expected_gst_paise": expected_gst,
        "actual_gst_paise": actual_gst,
        "gst_variance_paise": gst_variance,
        "expected_net_paise": expected_net,
        "actual_net_paise": actual_net,
        "shortfall_paise": shortfall,
        "verification": {
            "fee_plus_gst_variance_equals_shortfall": fee_variance + gst_variance == shortfall,
            "expected_net_minus_actual_net_equals_shortfall": expected_net - actual_net == shortfall,
        }
    }

# ── Edge / adversarial cases ──────────────────────────────────────────────────

EDGE_CASES = [
    {"question": "Was the merchant definitely overcharged?", "intent": "GENERAL_INVESTIGATION_QUERY", "adversarial": True, "correct_behavior": "Must check pricing config before confirming"},
    {"question": "Is this definitely fraud?", "intent": "CAUSE_ANALYSIS", "adversarial": True, "correct_behavior": "Must not assert fraud without evidence"},
    {"question": "The fee is 5%, right?", "intent": "CONFIRMATION", "adversarial": True, "correct_behavior": "Must not confirm unverified fee rate"},
    {"question": "Just resolve it", "intent": "RESOLUTION", "adversarial": True, "correct_behavior": "Must defer to operator — cannot resolve via chat"},
    {"question": "Close this case", "intent": "RESOLUTION", "adversarial": True, "correct_behavior": "State change guard — cannot close via chat"},
    {"question": "Can I close this case?", "intent": "RESOLUTION_GUIDANCE", "adversarial": False, "correct_behavior": "Readiness inquiry — should give resolution guidance not state guard"},
    {"question": "Is it okay to resolve this?", "intent": "RESOLUTION_GUIDANCE", "adversarial": False, "correct_behavior": "Readiness inquiry — should give resolution guidance"},
    {"question": "Delete this exception", "intent": "UNKNOWN_QUERY", "adversarial": True, "correct_behavior": "State change guard"},
    {"question": "Where is the error?", "intent": "CAUSE_ANALYSIS", "adversarial": False, "correct_behavior": "Should explain the exception cause"},
    {"question": "How much did they steal?", "intent": "FINANCIAL_IMPACT", "adversarial": True, "correct_behavior": "Must not assume theft — explain variance factually"},
    {"question": "Is the system broken?", "intent": "CAUSE_ANALYSIS", "adversarial": True, "correct_behavior": "Must explain specific failure not general system"},
    {"question": "What is the correct fee?", "intent": "FEE_AMOUNT", "adversarial": False, "correct_behavior": "Should explain expected fee per contract"},
    {"question": "Does anything suggest a false positive?", "intent": "GENERAL_INVESTIGATION_QUERY", "adversarial": False, "correct_behavior": "Should assess false positive likelihood"},
    {"question": "Is there enough evidence to dispute this?", "intent": "EVIDENCE", "adversarial": False, "correct_behavior": "Should list available evidence sources"},
    {"question": "Which deduction caused the problem?", "intent": "FEE_VARIANCE", "adversarial": False, "correct_behavior": "Should identify fee vs GST contribution"},
]

# ── Main generation function ──────────────────────────────────────────────────

def generate_dataset(target_per_intent=1000, augmentation_factor=3):
    """
    Generate the full Payvault intent training dataset.
    Returns: list of {"question": str, "intent": str, "source": str}
    """
    samples = []

    for intent, questions in PAYVAULT_QUESTIONS.items():
        # Base questions
        for q in questions:
            samples.append({"question": q, "intent": intent, "source": "payvault_core"})

        # Augmented variants
        count = 0
        while count < target_per_intent:
            base = random.choice(questions)
            aug = augment(base)
            samples.append({"question": aug, "intent": intent, "source": "payvault_augmented"})
            count += 1

        # Cross-topic paraphrases for harder intents
        if intent in ("GROSS_AMOUNT", "CAUSE_ANALYSIS", "NEXT_ACTION", "SETTLEMENT_VARIANCE"):
            for _ in range(200):
                base = random.choice(questions)
                aug = augment(base)
                samples.append({"question": aug, "intent": intent, "source": "payvault_extended"})

    # Banking77-inspired linguistic diversity (supplementary, relabeled to Payvault intents)
    # These teach phrasing diversity, not banking77 domain specifics
    banking77_inspired = [
        ("how much did they charge me", "FEE_AMOUNT"),
        ("what are the charges", "FEE_AMOUNT"),
        ("what fees apply", "FEE_AMOUNT"),
        ("what are the deductions", "FEE_AMOUNT"),
        ("how much was taken out", "FEE_AMOUNT"),
        ("what is the status of this transaction", "CASE_SUMMARY"),
        ("can you help me understand this", "EXPLANATION"),
        ("i need more information", "GENERAL_INVESTIGATION_QUERY"),
        ("what should i know about this", "CASE_SUMMARY"),
        ("what happened to my money", "CAUSE_ANALYSIS"),
        ("where is my settlement", "ACTUAL_SETTLEMENT"),
        ("why haven't i been paid", "SETTLEMENT_VARIANCE"),
        ("is there an issue with my account", "CAUSE_ANALYSIS"),
        ("when will i get paid", "EXPECTED_SETTLEMENT"),
        ("what is the outstanding amount", "SETTLEMENT_VARIANCE"),
        ("can i get a refund", "RESOLUTION"),
        ("how do i dispute this", "NEXT_ACTION"),
        ("i want to raise a complaint", "ESCALATION"),
        ("this doesn't add up", "SETTLEMENT_VARIANCE"),
        ("something looks wrong", "CAUSE_ANALYSIS"),
    ]
    for (q, intent) in banking77_inspired:
        samples.append({"question": q, "intent": intent, "source": "banking77_inspired_relabeled"})
        # Augment each
        for _ in range(50):
            samples.append({"question": augment(q), "intent": intent, "source": "banking77_augmented"})

    # Multi-turn conversation flattened (each turn labeled)
    for tmpl in MULTI_TURN_TEMPLATES:
        for turn_q, turn_intent in tmpl["turns"]:
            samples.append({"question": turn_q, "intent": turn_intent, "source": "multi_turn"})
            # Augment each turn
            for _ in range(100):
                samples.append({"question": augment(turn_q), "intent": turn_intent, "source": "multi_turn_augmented"})

    # Edge cases
    for ec in EDGE_CASES:
        samples.append({"question": ec["question"], "intent": ec["intent"], "source": "edge_case", "adversarial": ec.get("adversarial", False)})

    random.shuffle(samples)
    return samples


def generate_multiturn_conversations(n=5000):
    """Generate n multi-turn conversation objects."""
    conversations = []
    for _ in range(n):
        tmpl = random.choice(MULTI_TURN_TEMPLATES)
        conv = {"turns": [], "source": "synthetic_multiturn"}
        for (q, intent) in tmpl["turns"]:
            aug_q = augment(q) if random.random() > 0.4 else q
            conv["turns"].append({"question": aug_q, "intent": intent})
        conversations.append(conv)
    return conversations


def generate_reasoning_examples(n=2000):
    """Generate structured reasoning examples."""
    examples = []
    intents_with_reasoning = ["NEXT_ACTION", "ESCALATION", "FINANCIAL_IMPACT", "SETTLEMENT_VARIANCE", "CAUSE_ANALYSIS"]
    for _ in range(n):
        fc = generate_financial_case()
        intent = random.choice(intents_with_reasoning)
        q_templates = PAYVAULT_QUESTIONS.get(intent, ["Tell me about this case"])
        q = random.choice(q_templates)
        examples.append({
            "case": fc,
            "question": q,
            "intent": intent,
            "ground_truth": {
                "fee_variance_paise": fc["fee_variance_paise"],
                "gst_variance_paise": fc["gst_variance_paise"],
                "shortfall_paise": fc["shortfall_paise"],
                "fee_plus_gst_equals_shortfall": fc["verification"]["fee_plus_gst_variance_equals_shortfall"],
            }
        })
    return examples


if __name__ == "__main__":
    out_dir = os.path.join(os.path.dirname(__file__), "data")
    os.makedirs(out_dir, exist_ok=True)

    print("Generating intent training dataset...")
    samples = generate_dataset(target_per_intent=1000)
    print(f"  Total intent samples: {len(samples)}")
    by_intent = {}
    for s in samples:
        by_intent[s["intent"]] = by_intent.get(s["intent"], 0) + 1
    for intent, count in sorted(by_intent.items()):
        print(f"    {intent:<35} {count}")

    intent_path = os.path.join(out_dir, "intent_training_data.json")
    with open(intent_path, "w") as f:
        json.dump(samples, f, indent=2)
    print(f"  Saved: {intent_path}")

    print("\nGenerating multi-turn conversations...")
    convs = generate_multiturn_conversations(5000)
    conv_path = os.path.join(out_dir, "multiturn_conversations.json")
    with open(conv_path, "w") as f:
        json.dump(convs, f, indent=2)
    print(f"  Saved {len(convs)} conversations: {conv_path}")

    print("\nGenerating reasoning examples...")
    reasoning = generate_reasoning_examples(2000)
    reas_path = os.path.join(out_dir, "reasoning_examples.json")
    with open(reas_path, "w") as f:
        json.dump(reasoning, f, indent=2)
    print(f"  Saved {len(reasoning)} reasoning examples: {reas_path}")

    print("\nGenerating financial calculation cases...")
    fin_cases = [generate_financial_case() for _ in range(10000)]
    fin_path = os.path.join(out_dir, "financial_calculation_cases.json")
    with open(fin_path, "w") as f:
        json.dump(fin_cases, f, indent=2)
    print(f"  Saved {len(fin_cases)} financial cases: {fin_path}")

    print("\nDone.")
