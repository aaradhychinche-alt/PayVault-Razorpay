"""
src/ml/model.py

Model definition, training, inference, explainability, and artifact persistence
for the Payvault Learned Exception Intelligence system.
"""

import os
import json
from typing import Dict, Any, List, Optional
import numpy as np
import joblib
from sklearn.ensemble import RandomForestClassifier

from features import extract_features, FEATURE_NAMES
from dataset import CATEGORIES, CATEGORY_TO_IDX, IDX_TO_CATEGORY

MODEL_VERSION = "payvault-ml-v1"
DEFAULT_MODEL_PATH = os.path.join(os.path.dirname(__file__), "artifacts", "payvault_exception_model.joblib")
DEFAULT_METADATA_PATH = os.path.join(os.path.dirname(__file__), "artifacts", "model_metadata.json")


class PayvaultExceptionClassifier:
    """
    Random Forest-based exception classifier trained on labeled settlement reconciliation cases.
    Produces well-calibrated class probabilities, predicted categories, and feature importances.
    """

    def __init__(
        self,
        n_estimators: int = 150,
        max_depth: Optional[int] = 12,
        min_samples_split: int = 4,
        random_state: int = 42,
    ):
        self.n_estimators = n_estimators
        self.max_depth = max_depth
        self.min_samples_split = min_samples_split
        self.random_state = random_state
        self.model = RandomForestClassifier(
            n_estimators=self.n_estimators,
            max_depth=self.max_depth,
            min_samples_split=self.min_samples_split,
            random_state=self.random_state,
            class_weight="balanced",
        )
        self.is_trained = False
        self.feature_names = list(FEATURE_NAMES)
        self.categories = list(CATEGORIES)

    def fit(self, X: np.ndarray, y: np.ndarray) -> "PayvaultExceptionClassifier":
        """Fit model on training feature matrix X and label indices y."""
        self.model.fit(X, y)
        self.is_trained = True
        return self

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        """Return probability matrix of shape (N, num_classes)."""
        if not self.is_trained:
            raise ValueError("Model is not trained yet. Call fit() or load().")
        probs = self.model.predict_proba(X)
        # Ensure matrix matches full 9 categories in correct order
        if probs.shape[1] < len(self.categories):
            full_probs = np.zeros((X.shape[0], len(self.categories)), dtype=np.float64)
            for model_idx, class_idx in enumerate(self.model.classes_):
                full_probs[:, class_idx] = probs[:, model_idx]
            return full_probs
        return probs

    def predict(self, X: np.ndarray) -> np.ndarray:
        """Return array of predicted class indices."""
        probs = self.predict_proba(X)
        return np.argmax(probs, axis=1)

    def get_feature_importances(self, top_n: int = 8) -> List[Dict[str, Any]]:
        """Return ranked list of top predictive features and their relative importances."""
        if not self.is_trained:
            return []
        importances = self.model.feature_importances_
        sorted_indices = np.argsort(importances)[::-1]

        results = []
        for idx in sorted_indices[:top_n]:
            results.append({
                "feature": self.feature_names[idx],
                "importance": round(float(importances[idx]), 4),
            })
        return results

    def predict_single(self, case: Dict[str, Any], top_n_features: int = 5) -> Dict[str, Any]:
        """
        Runs ML prediction for a single InvestigationCase dict.

        Returns:
            Dict containing predicted_category, confidence (probability),
            probability distribution across all categories, and top features.
        """
        features_vector = extract_features(case).reshape(1, -1)
        probs = self.predict_proba(features_vector)[0]

        best_idx = int(np.argmax(probs))
        predicted_category = IDX_TO_CATEGORY.get(best_idx, "UNEXPLAINED")
        confidence = float(probs[best_idx])

        prob_dict = {
            cat: round(float(probs[idx]), 4)
            for idx, cat in enumerate(self.categories)
        }

        # Filter to relevant non-zero probabilities for concise output
        significant_probs = {k: v for k, v in prob_dict.items() if v >= 0.01}

        return {
            "model": "Payvault Local ML",
            "model_version": MODEL_VERSION,
            "model_type": "LOCAL TRAINED MODEL",
            "predicted_category": predicted_category,
            "confidence": round(confidence, 4),
            "probabilities": significant_probs,
            "all_probabilities": prob_dict,
            "top_features": self.get_feature_importances(top_n=top_n_features),
        }

    def save(
        self,
        model_path: str = DEFAULT_MODEL_PATH,
        metadata_path: str = DEFAULT_METADATA_PATH,
        extra_metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Persist trained model weights and metadata JSON."""
        os.makedirs(os.path.dirname(model_path), exist_ok=True)
        joblib.dump(self.model, model_path)

        metadata = {
            "model_type": "RandomForestClassifier",
            "model_version": MODEL_VERSION,
            "n_estimators": self.n_estimators,
            "max_depth": self.max_depth,
            "random_state": self.random_state,
            "categories": self.categories,
            "feature_names": self.feature_names,
            "top_features": self.get_feature_importances(top_n=10),
        }
        if extra_metadata:
            metadata.update(extra_metadata)

        with open(metadata_path, "w", encoding="utf-8") as f:
            json.dump(metadata, f, indent=2)

    @classmethod
    def load(
        cls,
        model_path: str = DEFAULT_MODEL_PATH,
    ) -> "PayvaultExceptionClassifier":
        """Load trained model instance from disk."""
        if not os.path.exists(model_path):
            raise FileNotFoundError(f"Model file not found at {model_path}. Run train.py first.")

        instance = cls()
        instance.model = joblib.load(model_path)
        instance.is_trained = True
        return instance
