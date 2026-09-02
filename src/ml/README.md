# Payvault Learned Exception Intelligence (ML Subsystem)

## Overview

The `src/ml/` directory contains the proprietary local Machine Learning pipeline for Payvault. The model learns from multi-dimensional settlement reconciliation features to classify exception patterns and produce calibrated class probabilities and feature importance attributions.

---

## Subsystem Architecture

- `features.py`: Feature engineering pipeline extracting 38 numerical & categorical signals from `InvestigationCase` objects.
- `dataset.py`: Dataset loader, label mapping, and stratified train/test partitioning.
- `model.py`: `PayvaultExceptionClassifier` wrapping a balanced Random Forest model with persistence & explainability methods.
- `train.py`: Model training pipeline that fits the classifier on training sets and outputs persistent artifacts.
- `evaluate.py`: Evaluation harness reporting accuracy, precision, recall, F1, confusion matrix, and feature importances on unseen test splits.
- `predict.py`: Subprocess interface providing low-latency predictions to the Node.js backend.
- `artifacts/`: Houses trained model weights (`payvault_exception_model.joblib`) and training metadata (`model_metadata.json`).

---

## Training and Evaluation

### Train Model
```bash
python3 src/ml/train.py
```

### Evaluate on Held-out Test Set
```bash
python3 src/ml/evaluate.py
```

### Test Prediction via CLI
```bash
python3 src/ml/predict.py < path_to_case.json
```
