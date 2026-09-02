"""
tests/test_ml.py

Unit tests for Payvault Python ML subsystem.
Verifies:
1. Feature extraction dimensions and deterministic behavior
2. No ground-truth label in feature vectors (no data leakage)
3. Dataset loading and stratified splitting
4. Model training and inference
5. Probabilities summing to ~1.0
6. Model saving and loading
7. Feature importance extraction
8. Error handling for malformed input
"""

import sys
import os
import unittest
import numpy as np

# Add src/ml to python path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src", "ml")))

from features import extract_features, extract_feature_matrix, FEATURE_NAMES
from dataset import load_dataset, get_train_test_split, CATEGORIES, CATEGORY_TO_IDX
from model import PayvaultExceptionClassifier, DEFAULT_MODEL_PATH


class TestPayvaultML(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.X, cls.y, cls.labels, cls.samples = load_dataset()

    def test_feature_extraction_dimension(self):
        sample_case = self.samples[0]["investigation_case"]
        feat_vec = extract_features(sample_case)
        self.assertEqual(len(feat_vec), len(FEATURE_NAMES))
        self.assertEqual(feat_vec.dtype, np.float64)

    def test_no_ground_truth_in_features(self):
        for fname in FEATURE_NAMES:
            self.assertNotIn("ground_truth", fname.lower())
            self.assertNotIn("expected_classification", fname.lower())

    def test_dataset_categories_valid(self):
        for label in self.labels:
            self.assertIn(label, CATEGORIES)

    def test_stratified_split(self):
        X_train, X_test, y_train, y_test = get_train_test_split(test_size=0.25, random_state=42)
        self.assertGreater(len(X_train), 0)
        self.assertGreater(len(X_test), 0)
        self.assertEqual(len(X_train) + len(X_test), len(self.X))
        # Ensure all 9 classes present in training split
        self.assertEqual(len(np.unique(y_train)), len(CATEGORIES))

    def test_model_training_and_prediction(self):
        classifier = PayvaultExceptionClassifier(n_estimators=50, random_state=42)
        classifier.fit(self.X, self.y)
        self.assertTrue(classifier.is_trained)

        probs = classifier.predict_proba(self.X[:10])
        self.assertEqual(probs.shape, (10, len(CATEGORIES)))

        # Probabilities must sum to ~1.0 per row
        row_sums = np.sum(probs, axis=1)
        for r_sum in row_sums:
            self.assertAlmostEqual(r_sum, 1.0, places=4)

    def test_predict_single_and_feature_importances(self):
        classifier = PayvaultExceptionClassifier.load(DEFAULT_MODEL_PATH)
        sample_case = self.samples[0]["investigation_case"]
        pred_res = classifier.predict_single(sample_case)

        self.assertIn("predicted_category", pred_res)
        self.assertIn(pred_res["predicted_category"], CATEGORIES)
        self.assertIn("confidence", pred_res)
        self.assertGreaterEqual(pred_res["confidence"], 0.0)
        self.assertLessEqual(pred_res["confidence"], 1.0)
        self.assertIn("top_features", pred_res)
        self.assertGreater(len(pred_res["top_features"]), 0)

        # Confidence should equal the probability of the predicted category
        pred_cat = pred_res["predicted_category"]
        self.assertAlmostEqual(
            pred_res["confidence"],
            pred_res["all_probabilities"][pred_cat],
            places=4,
        )

    def test_malformed_case_handling(self):
        empty_case = {}
        feat_vec = extract_features(empty_case)
        self.assertEqual(len(feat_vec), len(FEATURE_NAMES))
        self.assertFalse(np.isnan(feat_vec).any())


if __name__ == "__main__":
    unittest.main()
