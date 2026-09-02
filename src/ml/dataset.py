"""
src/ml/dataset.py

Dataset loader and split utility for Payvault Learned Exception Intelligence.
Loads labeled investigation cases, extracts feature matrices, and creates
stratified train/test partitions for honest evaluation.
"""

import os
import json
import subprocess
from typing import Tuple, List, Dict, Any
import numpy as np
from sklearn.model_selection import train_test_split

from features import extract_features, extract_feature_matrix, FEATURE_NAMES

CATEGORIES = [
    "CLEAN_MATCH",
    "PARTIAL_REFUND",
    "TIMING_MISMATCH",
    "FEE_TAX_VARIANCE",
    "MISSING_ORDER",
    "MISSING_PAYMENT",
    "DUPLICATE",
    "ADJUSTMENT",
    "UNEXPLAINED",
]

CATEGORY_TO_IDX = {cat: i for i, cat in enumerate(CATEGORIES)}
IDX_TO_CATEGORY = {i: cat for i, cat in enumerate(CATEGORIES)}

DEFAULT_DATA_PATH = os.path.join(os.path.dirname(__file__), "data", "training_data.json")


def ensure_dataset(data_path: str = DEFAULT_DATA_PATH, num_seeds: int = 30) -> str:
    """
    Ensures that the labeled training dataset exists. If absent, runs the
    Node export script to generate fresh, deterministic synthetic samples.
    """
    if os.path.exists(data_path) and os.path.getsize(data_path) > 100:
        return data_path

    os.makedirs(os.path.dirname(data_path), exist_ok=True)
    script_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "export-ml-dataset.js")
    )
    print(f"[dataset] Generating training dataset with {num_seeds} seeds...")
    subprocess.run(["node", script_path, str(num_seeds), data_path], check=True)
    return data_path


def load_dataset(data_path: str = DEFAULT_DATA_PATH) -> Tuple[np.ndarray, np.ndarray, List[str], List[Dict[str, Any]]]:
    """
    Loads dataset JSON, extracts feature matrix X and label vector y.

    Returns:
        X: np.ndarray of shape (N, num_features)
        y: np.ndarray of shape (N,) integer class indices
        labels: List of original string category labels
        raw_samples: List of raw sample dictionaries
    """
    ensure_dataset(data_path)
    with open(data_path, "r", encoding="utf-8") as f:
        samples = json.load(f)

    cases = [s["investigation_case"] for s in samples]
    labels = [s["ground_truth_category"] for s in samples]

    X = extract_feature_matrix(cases)
    y = np.array([CATEGORY_TO_IDX.get(cat, CATEGORY_TO_IDX["UNEXPLAINED"]) for cat in labels], dtype=np.int64)

    return X, y, labels, samples


def get_train_test_split(
    test_size: float = 0.25,
    random_state: int = 42,
    data_path: str = DEFAULT_DATA_PATH,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Returns stratified (X_train, X_test, y_train, y_test).
    """
    X, y, _, _ = load_dataset(data_path)
    return train_test_split(X, y, test_size=test_size, random_state=random_state, stratify=y)
