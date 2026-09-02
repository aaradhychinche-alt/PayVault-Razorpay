"""
src/ml/evaluate.py

Evaluation script for the Payvault Learned Exception Intelligence model.
Evaluates the trained model against a held-out test dataset and prints
detailed metrics: accuracy, precision, recall, F1, per-class breakdown,
confusion matrix, and feature importances.

Usage:
    python3 src/ml/evaluate.py
"""

import sys
import os
import numpy as np
from sklearn.metrics import (
    accuracy_score,
    precision_recall_fscore_support,
    confusion_matrix,
    classification_report,
)

# Ensure local imports work when run directly
sys.path.insert(0, os.path.dirname(__file__))

from dataset import get_train_test_split, CATEGORIES, IDX_TO_CATEGORY
from model import PayvaultExceptionClassifier, DEFAULT_MODEL_PATH


def main():
    print("=" * 68)
    print("  Payvault Learned Exception Intelligence — Model Evaluation")
    print("=" * 68)

    if not os.path.exists(DEFAULT_MODEL_PATH):
        print("\n[!] Trained model artifact not found. Training model first...")
        import train
        train.main()

    # Load trained model
    classifier = PayvaultExceptionClassifier.load(DEFAULT_MODEL_PATH)

    # Load test split
    X_train, X_test, y_train, y_test = get_train_test_split(test_size=0.25, random_state=42)

    y_pred = classifier.predict(X_test)
    probs = classifier.predict_proba(X_test)

    acc = accuracy_score(y_test, y_pred)
    prec_w, rec_w, f1_w, _ = precision_recall_fscore_support(y_test, y_pred, average="weighted", zero_division=0)
    prec_m, rec_m, f1_m, _ = precision_recall_fscore_support(y_test, y_pred, average="macro", zero_division=0)

    print(f"\nDataset Statistics:")
    print(f"  Training Examples  : {len(X_train)}")
    print(f"  Test Examples      : {len(X_test)}")
    print(f"  Total Features     : {X_test.shape[1]}")
    print(f"  Target Classes     : {len(CATEGORIES)}")

    print(f"\nOverall Performance Metrics:")
    print(f"  Accuracy           : {acc * 100:.2f}%")
    print(f"  Macro Precision    : {prec_m * 100:.2f}%")
    print(f"  Macro Recall       : {rec_m * 100:.2f}%")
    print(f"  Macro F1-Score     : {f1_m * 100:.2f}%")
    print(f"  Weighted F1-Score  : {f1_w * 100:.2f}%")

    print("\nPer-Class Breakdown:")
    print("-" * 68)
    print(f"{'Category':<22} | {'Precision':<10} | {'Recall':<10} | {'F1-Score':<10} | {'Support':<8}")
    print("-" * 68)

    per_prec, per_rec, per_f1, per_sup = precision_recall_fscore_support(
        y_test, y_pred, labels=range(len(CATEGORIES)), zero_division=0
    )

    for i, cat in enumerate(CATEGORIES):
        print(f"{cat:<22} | {per_prec[i]*100:>9.2f}% | {per_rec[i]*100:>9.2f}% | {per_f1[i]*100:>9.2f}% | {per_sup[i]:>7}")
    print("-" * 68)

    print("\nConfusion Matrix:")
    cm = confusion_matrix(y_test, y_pred, labels=range(len(CATEGORIES)))
    print("      " + " ".join(f"{i:>3}" for i in range(len(CATEGORIES))))
    for i, row in enumerate(cm):
        print(f"{i:>3}:  " + " ".join(f"{val:>3}" for val in row) + f"  ({CATEGORIES[i]})")

    print("\nTop Predictive Features (Model Weights):")
    top_features = classifier.get_feature_importances(top_n=8)
    for rank, f in enumerate(top_features, 1):
        print(f"  {rank}. {f['feature']:<25} : {f['importance']:.4f}")

    print("\nConfidence Calibration Sample (First 3 Test Cases):")
    for i in range(min(3, len(X_test))):
        pred_idx = y_pred[i]
        true_idx = y_test[i]
        conf = probs[i][pred_idx]
        print(f"  Test #{i+1}: True={CATEGORIES[true_idx]} | Predicted={CATEGORIES[pred_idx]} | Confidence={conf:.4f}")

    print("=" * 68)
    if acc >= 0.90:
        print("[PASS] Model generalization meets the high accuracy threshold.")
    else:
        print("[WARN] Model accuracy below target threshold.")
    print("=" * 68)


if __name__ == "__main__":
    main()
