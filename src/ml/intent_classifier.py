"""
src/ml/intent_classifier.py

Payvault AI — Intent Classifier.

Architecture:
  TF-IDF Vectorizer (char + word n-grams) + Logistic Regression

This is a LOCAL ML model. No Qwen, no Ollama, no external LLM.

It classifies natural-language investigation questions into one of 25
Payvault investigation intents. Used as a signal in the nativeReasoning
pipeline (supplements the deterministic pattern rules).

Training: 80% train, 10% validation, 10% test (stratified split).
The test set is never seen during training.
"""

import os
import sys
import json
import time
import joblib
import numpy as np
from datetime import datetime, timezone

from sklearn.pipeline import Pipeline
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split, cross_val_score
from sklearn.metrics import (
    accuracy_score, classification_report, f1_score,
    precision_score, recall_score, confusion_matrix
)

sys.path.insert(0, os.path.dirname(__file__))
from intent_dataset import generate_dataset, INTENTS

INTENT_MODEL_PATH = os.path.join(os.path.dirname(__file__), "artifacts", "payvault_intent_classifier.joblib")
INTENT_META_PATH  = os.path.join(os.path.dirname(__file__), "artifacts", "payvault_intent_classifier_metadata.json")


def build_pipeline():
    """Build TF-IDF + LogisticRegression pipeline for intent classification."""
    return Pipeline([
        ("tfidf", TfidfVectorizer(
            analyzer="char_wb",       # character n-grams — tolerates typos & paraphrases
            ngram_range=(2, 4),       # bigrams to 4-grams
            max_features=80000,
            sublinear_tf=True,
            strip_accents="unicode",
            min_df=1,
        )),
        ("clf", LogisticRegression(
            max_iter=2000,
            C=3.0,
            solver="lbfgs",
            class_weight="balanced",  # handles class imbalance
            random_state=42,
        )),
    ])


def train():
    print("=" * 65)
    print("  Payvault AI — Intent Classifier Training Pipeline")
    print("=" * 65)
    t0 = time.time()

    # 1. Generate dataset
    print("\n[1/5] Generating training dataset...")
    samples = generate_dataset(target_per_intent=1000)
    questions = [s["question"] for s in samples]
    labels    = [s["intent"]   for s in samples]

    print(f"  Total samples : {len(samples)}")
    by_intent = {}
    for l in labels:
        by_intent[l] = by_intent.get(l, 0) + 1
    print(f"  Intents       : {len(by_intent)}")
    print(f"  Min per intent: {min(by_intent.values())}")
    print(f"  Max per intent: {max(by_intent.values())}")

    # 2. Stratified 80/10/10 split
    print("\n[2/5] Splitting dataset (80 train / 10 val / 10 test)...")
    X_trainval, X_test, y_trainval, y_test = train_test_split(
        questions, labels, test_size=0.10, random_state=42, stratify=labels
    )
    X_train, X_val, y_train, y_val = train_test_split(
        X_trainval, y_trainval, test_size=0.111, random_state=42, stratify=y_trainval
    )  # 0.111 of 90% ≈ 10% total
    print(f"  Train : {len(X_train)}")
    print(f"  Val   : {len(X_val)}")
    print(f"  Test  : {len(X_test)}")

    # 3. Train
    print("\n[3/5] Training TF-IDF + Logistic Regression pipeline...")
    pipeline = build_pipeline()
    pipeline.fit(X_train, y_train)

    # 4. Validation metrics
    print("\n[4/5] Validation set metrics (never seen during training)...")
    val_preds = pipeline.predict(X_val)
    val_acc   = accuracy_score(y_val, val_preds)
    val_f1    = f1_score(y_val, val_preds, average="weighted", zero_division=0)
    print(f"  Val Accuracy : {val_acc * 100:.2f}%")
    print(f"  Val F1       : {val_f1 * 100:.2f}%")

    # 5. Test set metrics (held-out — NEVER used during training or tuning)
    print("\n[5/5] Test set metrics (held-out unseen data)...")
    test_preds = pipeline.predict(X_test)
    test_acc  = accuracy_score(y_test, test_preds)
    test_f1   = f1_score(y_test, test_preds, average="weighted", zero_division=0)
    test_prec = precision_score(y_test, test_preds, average="weighted", zero_division=0)
    test_rec  = recall_score(y_test, test_preds, average="weighted", zero_division=0)
    print(f"  Test Accuracy  : {test_acc * 100:.2f}%")
    print(f"  Test Precision : {test_prec * 100:.2f}%")
    print(f"  Test Recall    : {test_rec * 100:.2f}%")
    print(f"  Test F1        : {test_f1 * 100:.2f}%")

    # Semantic generalization tests (held-out unseen phrasings)
    semantic_tests = [
        ("How much was the original payment?",     "GROSS_AMOUNT"),
        ("What's my next step?",                   "NEXT_ACTION"),
        ("How much tax contributed to the difference?", "GST_VARIANCE"),
        ("Does this require escalation?",          "ESCALATION"),
        ("What are the records for this case?",    "EVIDENCE"),
        ("Something went wrong here",              "CAUSE_ANALYSIS"),
        ("How much are we actually short by?",     "SETTLEMENT_VARIANCE"),
        ("What time is it?",                       "UNKNOWN_QUERY"),
        ("Tell me a joke",                         "UNKNOWN_QUERY"),
        ("Can I settle this now?",                 "RESOLUTION"),
        ("What's the platform fee difference?",    "FEE_VARIANCE"),
        ("And GST?",                               "GST_AMOUNT"),
    ]
    print("\n  Semantic generalization checks (unseen phrasings):")
    sem_pass = 0
    for (q, expected_intent) in semantic_tests:
        pred = pipeline.predict([q])[0]
        ok   = pred == expected_intent
        if ok:
            sem_pass += 1
        status = "✓" if ok else "✗"
        print(f"    {status} [{expected_intent:<30}] \"{q}\" → {pred}")
    print(f"\n  Semantic generalization: {sem_pass}/{len(semantic_tests)} correct")

    elapsed = time.time() - t0

    # Save
    os.makedirs(os.path.dirname(INTENT_MODEL_PATH), exist_ok=True)
    joblib.dump(pipeline, INTENT_MODEL_PATH)

    metadata = {
        "model_type": "TfidfVectorizer + LogisticRegression",
        "model_name": "payvault_intent_classifier",
        "model_version": "v1",
        "purpose": "Chat intent classification for Payvault AI native reasoning",
        "no_llm": True,
        "training_framework": "scikit-learn",
        "vectorizer": "TfidfVectorizer(char_wb, ngram_range=(2,4), max_features=80000)",
        "classifier": "LogisticRegression(C=3.0, multinomial, balanced)",
        "intents": INTENTS,
        "num_intents": len(INTENTS),
        "total_dataset_size": len(samples),
        "train_samples": len(X_train),
        "val_samples": len(X_val),
        "test_samples": len(X_test),
        "val_accuracy": round(val_acc, 4),
        "val_f1": round(val_f1, 4),
        "test_accuracy": round(test_acc, 4),
        "test_precision": round(test_prec, 4),
        "test_recall": round(test_rec, 4),
        "test_f1": round(test_f1, 4),
        "semantic_generalization_score": f"{sem_pass}/{len(semantic_tests)}",
        "training_time_seconds": round(elapsed, 2),
        "training_timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "data_sources": {
            "payvault_core": "Payvault-specific question templates",
            "payvault_augmented": "Augmented variants of core templates",
            "banking77_inspired_relabeled": "Banking77 linguistic diversity, relabeled to Payvault intents",
            "multi_turn": "Multi-turn conversation turn examples",
            "edge_case": "Adversarial and edge-case questions",
        }
    }
    with open(INTENT_META_PATH, "w") as f:
        json.dump(metadata, f, indent=2)

    print(f"\n  Model saved : {INTENT_MODEL_PATH}")
    print(f"  Meta  saved : {INTENT_META_PATH}")
    print(f"\n[DONE] Training completed in {elapsed:.2f}s")
    print("=" * 65)

    return pipeline, metadata


def predict(question, model_path=INTENT_MODEL_PATH):
    """
    Load model and predict intent for a single question.
    Returns: {"intent": str, "confidence": float, "all_probs": dict}
    """
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"Intent classifier not found at {model_path}. Run train() first.")

    pipeline = joblib.load(model_path)
    proba    = pipeline.predict_proba([question])[0]
    classes  = pipeline.classes_
    best_idx = int(np.argmax(proba))
    return {
        "intent":     classes[best_idx],
        "confidence": float(proba[best_idx]),
        "all_probs":  {cls: round(float(p), 4) for cls, p in zip(classes, proba)},
    }


if __name__ == "__main__":
    train()
