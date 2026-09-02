"""
src/ml/predict.py

Command-line and subprocess inference interface for Payvault Learned Exception Intelligence.
Accepts an InvestigationCase in JSON format via stdin or file argument,
runs feature extraction, loads the trained model, and outputs JSON predictions.

Usage:
    python3 src/ml/predict.py < path_to_case.json
    python3 src/ml/predict.py path_to_case.json
"""

import sys
import os
import json

# Ensure local imports work
sys.path.insert(0, os.path.dirname(__file__))

from model import PayvaultExceptionClassifier, DEFAULT_MODEL_PATH


def main():
    try:
        # Read case JSON from argument or stdin
        if len(sys.argv) > 1 and os.path.exists(sys.argv[1]):
            with open(sys.argv[1], "r", encoding="utf-8") as f:
                case_data = json.load(f)
        else:
            raw_input = sys.stdin.read().strip()
            if not raw_input:
                raise ValueError("No input provided via stdin or argument.")
            case_data = json.loads(raw_input)

        # Handle wrapped input if nested e.g. {"investigation_case": ...}
        if "investigation_case" in case_data:
            case_data = case_data["investigation_case"]

        # Ensure model is available
        if not os.path.exists(DEFAULT_MODEL_PATH):
            import train
            train.main()

        classifier = PayvaultExceptionClassifier.load(DEFAULT_MODEL_PATH)
        result = classifier.predict_single(case_data)

        # Print JSON output to stdout
        print(json.dumps(result, indent=2))
        sys.exit(0)

    except Exception as err:
        error_resp = {
            "error": True,
            "message": str(err),
            "model": "Payvault Local ML",
        }
        print(json.dumps(error_resp, indent=2), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
