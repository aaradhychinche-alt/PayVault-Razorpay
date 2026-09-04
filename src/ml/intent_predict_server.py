"""
src/ml/intent_predict_server.py

Payvault AI — Lightweight Intent Prediction Server.

Reads JSON lines from stdin, outputs JSON lines to stdout.
This is the bridge between Node.js nativeReasoning and the Python ML classifier.

Protocol (stdin/stdout, newline-delimited JSON):
  Input:  {"question": "What happened?"}
  Output: {"intent": "CAUSE_ANALYSIS", "confidence": 0.98, "ok": true}

No HTTP server overhead — Node spawns this as a persistent subprocess,
sends questions line-by-line, receives predictions line-by-line.

This runs entirely locally. No Qwen, no Ollama, no external service.
"""

import sys
import os
import json
import joblib
import numpy as np

MODEL_PATH = os.path.join(os.path.dirname(__file__), "artifacts", "payvault_intent_classifier.joblib")

def main():
    # Pre-load model once
    try:
        pipeline = joblib.load(MODEL_PATH)
        classes = pipeline.classes_
        sys.stderr.write(f"[Payvault Intent ML] Model loaded. {len(classes)} intents.\n")
        sys.stderr.flush()
    except Exception as e:
        sys.stderr.write(f"[Payvault Intent ML] ERROR loading model: {e}\n")
        sys.stderr.flush()
        # If model fails, output error for every line
        for line in sys.stdin:
            sys.stdout.write(json.dumps({"intent": "UNKNOWN", "confidence": 0.0, "ok": False, "error": str(e)}) + "\n")
            sys.stdout.flush()
        return

    # Process stdin line by line
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            question = req.get("question", "")
            if not question:
                sys.stdout.write(json.dumps({"intent": "UNKNOWN", "confidence": 0.0, "ok": False, "error": "empty question"}) + "\n")
                sys.stdout.flush()
                continue

            proba    = pipeline.predict_proba([question])[0]
            best_idx = int(np.argmax(proba))
            intent   = classes[best_idx]
            conf     = float(proba[best_idx])

            sys.stdout.write(json.dumps({
                "intent":     intent,
                "confidence": round(conf, 4),
                "ok":         True,
            }) + "\n")
            sys.stdout.flush()

        except Exception as e:
            sys.stdout.write(json.dumps({"intent": "UNKNOWN", "confidence": 0.0, "ok": False, "error": str(e)}) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
