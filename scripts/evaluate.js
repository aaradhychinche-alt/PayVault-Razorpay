#!/usr/bin/env node
'use strict';
/**
 * scripts/evaluate.js
 *
 * Evaluation harness for Chunk 1.
 *
 * Compares the deterministic engine's actual classification
 * against the hidden ground truth from the synthetic generator.
 *
 * This script is for EVALUATION ONLY.
 * Ground truth is NEVER exposed via API or sent to the AI investigator.
 *
 * Usage:
 *   node scripts/evaluate.js
 */

const { generateDataset } = require('../src/data/generator');
const { reconcile }       = require('../src/engine/reconcile');

// Mapping from ground truth scenario label → expected engine exception_category
// Some scenarios map to MATCHED (not an exception).
const GT_TO_CATEGORY = {
  CLEAN_MATCH:      null,            // expected: MATCHED (no exception)
  PARTIAL_REFUND:   null,            // expected: MATCHED (partial refund is handled)
  TIMING_MISMATCH:  'TIMING_MISMATCH',
  FEE_TAX_VARIANCE: 'FEE_TAX_VARIANCE',
  MISSING_ORDER:    'MISSING_ORDER',
  MISSING_PAYMENT:  'MISSING_PAYMENT',
  DUPLICATE:        'DUPLICATE',
  ADJUSTMENT:       'ADJUSTMENT',
  UNEXPLAINED:      'UNEXPLAINED',
};

function main() {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  Payvault Chunk 1 — Evaluation Harness');
  console.log('════════════════════════════════════════════════════════════\n');

  // Generate dataset and run engine
  const dataset = generateDataset();
  const { results, exceptions } = reconcile(dataset);

  console.log('Dataset statistics:');
  console.log(`  Settlement records : ${dataset.settlementRecords.length}`);
  console.log(`  Merchant orders    : ${dataset.merchantOrders.length}`);
  console.log(`  Merchant ledger    : ${dataset.merchantLedger.length}`);
  console.log(`  Settlement batches : ${dataset.settlementBatches.length}`);
  console.log(`  Recon results      : ${results.length}`);
  console.log(`  Exceptions         : ${exceptions.length}`);
  console.log('');

  // Build result lookup: entity_id → reconciliation result
  const resultByEntityId = new Map();
  for (const r of results) {
    resultByEntityId.set(r.settlement_entity_id, r);
  }

  const groundTruth = dataset.groundTruth;

  let total       = 0;
  let correct     = 0;
  let incorrect   = 0;
  let unresolved  = 0;

  const perCategory = {};
  const failures    = [];

  for (const [entityId, gtLabel] of groundTruth.entries()) {
    const expectedCategory = GT_TO_CATEGORY[gtLabel];

    // MISSING_PAYMENT uses a synthesised entity_id
    if (entityId.startsWith('__missing_payment_')) {
      const moId = entityId.replace('__missing_payment_', '');
      const missingResult = results.find(
        r => r.merchant_order_id === moId && r.exception_category === 'MISSING_PAYMENT',
      );

      total++;
      const cat = perCategory[gtLabel] = perCategory[gtLabel] || { total: 0, correct: 0, incorrect: 0 };
      cat.total++;

      if (missingResult) {
        correct++;
        cat.correct++;
      } else {
        incorrect++;
        cat.incorrect++;
        failures.push({ entityId, gtLabel, expected: 'MISSING_PAYMENT', actual: 'NOT_FOUND' });
      }
      continue;
    }

    const result = resultByEntityId.get(entityId);
    total++;

    const cat = perCategory[gtLabel] = perCategory[gtLabel] || { total: 0, correct: 0, incorrect: 0 };
    cat.total++;

    if (!result) {
      unresolved++;
      cat.incorrect++;
      failures.push({ entityId, gtLabel, expected: expectedCategory, actual: 'NOT_CLASSIFIED' });
      continue;
    }

    const actualCategory = result.exception_category; // null for MATCHED

    if (actualCategory === expectedCategory) {
      correct++;
      cat.correct++;
    } else {
      incorrect++;
      cat.incorrect++;
      failures.push({ entityId, gtLabel, expected: expectedCategory, actual: actualCategory });
    }
  }

  const accuracy = total > 0 ? ((correct / total) * 100).toFixed(1) : '0.0';

  console.log('Accuracy:');
  console.log(`  Total cases        : ${total}`);
  console.log(`  Correct            : ${correct}`);
  console.log(`  Incorrect          : ${incorrect}`);
  console.log(`  Unresolved         : ${unresolved}`);
  console.log(`  Accuracy           : ${accuracy}%`);
  console.log('');

  console.log('Per-category results:');
  const maxLabelLen = Math.max(...Object.keys(perCategory).map(k => k.length));
  for (const [label, counts] of Object.entries(perCategory)) {
    const catAccuracy = ((counts.correct / counts.total) * 100).toFixed(0);
    const bar = '█'.repeat(Math.round(counts.correct / counts.total * 20)).padEnd(20, '░');
    console.log(
      `  ${label.padEnd(maxLabelLen)}  ${bar}  ${counts.correct}/${counts.total} (${catAccuracy}%)`,
    );
  }
  console.log('');

  // Financial summary
  const totalAmountPaise = dataset.settlementRecords
    .filter(sr => sr.type === 'payment')
    .reduce((s, sr) => s + sr.amount, 0);
  const amountAtRiskPaise = exceptions.reduce((s, e) => s + e.amount_at_risk, 0);

  console.log('Financial summary:');
  console.log(`  Total amount reconciled : ₹${(totalAmountPaise / 100).toLocaleString('en-IN')}`);
  console.log(`  Total amount at risk    : ₹${(amountAtRiskPaise / 100).toLocaleString('en-IN')}`);
  console.log('');

  console.log('Exception counts by category:');
  const excByCategory = {};
  for (const exc of exceptions) {
    excByCategory[exc.category] = (excByCategory[exc.category] || 0) + 1;
  }
  for (const [cat, count] of Object.entries(excByCategory)) {
    console.log(`  ${cat.padEnd(24)} ${count}`);
  }
  console.log('');

  if (failures.length > 0) {
    console.log(`Misclassifications (${failures.length}):`);
    for (const f of failures.slice(0, 10)) {
      console.log(`  ${f.entityId.slice(0, 30).padEnd(32)} GT=${f.gtLabel.padEnd(20)} ACTUAL=${f.actual}`);
    }
    if (failures.length > 10) {
      console.log(`  ... and ${failures.length - 10} more`);
    }
    console.log('');
  }

  console.log('════════════════════════════════════════════════════════════\n');

  // Exit with error code if accuracy < 80%
  if (parseFloat(accuracy) < 80) {
    console.error(`[FAIL] Accuracy ${accuracy}% is below 80% threshold.`);
    process.exit(1);
  } else {
    console.log(`[PASS] Accuracy ${accuracy}% meets threshold.\n`);
  }
}

main();
