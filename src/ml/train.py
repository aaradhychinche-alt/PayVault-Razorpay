"""
src/ml/train.py

Training script for the Payvault Learned Exception Intelligence model.
Trains a balanced Random Forest classifier on labeled reconciliation cases,
evaluates on held-out test data, and saves the model artifact and metadata.

Usage:
    python3 src/ml/train.py
"""

import sys
import os
import time
from datetime import datetime
import numpy as np
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score

# Ensure local imports work when run directly
sys.path.insert(0, os.path.dirname(__file__))

from dataset import get_train_test_split, load_dataset, CATEGORIES, IDX_TO_CATEGORY
from model import PayvaultExceptionClassifier, DEFAULT_MODEL_PATH, DEFAULT_METADATA_PATH


def main():
    print("=" * 60)
    print("  Payvault Learned Exception Intelligence — Training Pipeline")
    print("=" * 60)

    start_time = time.time()

    print("\n[1/4] Loading and splitting dataset...")
    X_train, X_test, y_train, y_test = get_train_test_split(test_size=0.25, random_state=42)

    total_samples = len(X_train) + len(X_test)
    print(f"  Total samples      : {total_samples}")
    print(f"  Training samples   : {len(X_train)}")
    print(f"  Held-out test set  : {len(X_test)}")
    print(f"  Features per sample: {X_train.shape[1]}")
    print(f"  Classes            : {len(CATEGORIES)}")

    print("\n[2/4] Training Random Forest Classifier (n_estimators=150)...")
    classifier = PayvaultExceptionClassifier(
        n_estimators=150,
        max_depth=12,
        min_samples_split=4,
        random_state=42,
    )
    classifier.fit(X_train, y_train)

    print("\n[3/4] Evaluating on held-out test set (unseen data)...")
    y_pred_test = classifier.predict(X_test)

    acc = accuracy_score(y_test, y_pred_test)
    prec = precision_score(y_test, y_pred_test, average="weighted", zero_division=0)
    rec = recall_score(y_test, y_pred_test, average="weighted", zero_division=0)
    f1 = f1_score(y_test, y_pred_test, average="weighted", zero_division=0)

    print(f"  Test Accuracy  : {acc * 100:.2f}%")
    print(f"  Weighted Prec  : {prec * 100:.2f}%")
    print(f"  Weighted Recall: {rec * 100:.2f}%")
    print(f"  Weighted F1    : {f1 * 100:.2f}%")

    print("\n  Top Learned Predictive Features:")
    top_feats = classifier.get_feature_importances(top_n=6)
    for idx, item in enumerate(top_feats, start=1):
        print(f"    {idx}. {item['feature'].padEnd(25) if hasattr(item['feature'], 'padEnd') else item['feature']:<25} (weight: {item['importance']:.4f})")

    print("\n[4/4] Saving model artifact and metadata...")
    from datetime import timezone
    extra_meta = {
        "training_timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "total_dataset_size": total_samples,
        "train_samples": len(X_train),
        "test_samples": len(X_test),
        "test_accuracy": round(acc, 4),
        "test_f1_score": round(f1, 4),
        "test_precision": round(prec, 4),
        "test_recall": round(rec, 4),
    }
    classifier.save(
        model_path=DEFAULT_MODEL_PATH,
        metadata_path=DEFAULT_METADATA_PATH,
        extra_metadata=extra_meta,
    )

    elapsed = time.time() - start_time
    print(f"  Saved model to    : {DEFAULT_MODEL_PATH}")
    print(f"  Saved metadata to : {DEFAULT_METADATA_PATH}")
    print(f"\n[DONE] Model training and persistence completed in {elapsed:.2f}s.")
    print("=" * 60)


if __name__ == "__main__":
    main()
