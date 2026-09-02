'use strict';
/**
 * scripts/export-ml-dataset.js
 *
 * Exports labeled reconciliation cases from multiple seeded datasets
 * for training and evaluating the Payvault Python ML model.
 *
 * Usage:
 *   node scripts/export-ml-dataset.js [num_seeds=20] [output_path=src/ml/data/training_data.json]
 */

const fs = require('fs');
const path = require('path');
const { generateDataset } = require('../src/data/generator');
const { reconcile }       = require('../src/engine/reconcile');
const { buildCase }       = require('../src/investigation/caseBuilder');

const numSeeds = parseInt(process.argv[2], 10) || 25;
const outputPath = process.argv[3] || path.join(__dirname, '../src/ml/data/training_data.json');

// Ensure target directory exists
fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const samples = [];
const baseSeed = 20260801;

console.log(`[export-ml-dataset] Generating labeled samples across ${numSeeds} seeds...`);

for (let i = 0; i < numSeeds; i++) {
  const seed = baseSeed + i * 1337;
  const dataset = generateDataset(seed);
  const { results, exceptions } = reconcile(dataset);

  const fakeStore = {
    mode: 'SYNTHETIC',
    data_source: 'synthetic',
    settlement_source: 'synthetic',
    settlementRecords: dataset.settlementRecords,
    merchantOrders: dataset.merchantOrders,
    merchantLedger: dataset.merchantLedger,
    settlementBatches: dataset.settlementBatches,
    reconciliationResults: results,
    exceptions,
  };

  // Build ground truth map (entity_id / mo_id -> ground_truth)
  const gtMap = dataset.groundTruth;

  // Process all reconciliation results (both CLEAN_MATCH and EXCEPTION cases)
  for (const rr of results) {
    const isException = rr.status !== 'MATCHED';
    let targetCategory = 'CLEAN_MATCH';

    if (gtMap.has(rr.settlement_entity_id)) {
      targetCategory = gtMap.get(rr.settlement_entity_id);
    } else if (rr.merchant_order_id && gtMap.has(rr.merchant_order_id)) {
      targetCategory = gtMap.get(rr.merchant_order_id);
    } else if (rr.exception_category) {
      targetCategory = rr.exception_category;
    }

    // Build or extract case representation
    let exc = exceptions.find(e => e.reconciliation_result_id === rr.id);
    if (!exc) {
      // Mock minimal exception object for clean match case building
      exc = {
        id: `clean_${rr.id}`,
        reconciliation_result_id: rr.id,
        category: 'MATCHED',
        amount_at_risk: 0,
        created_at: rr.created_at,
        description: 'Clean match without variance',
      };
    }

    const investigationCase = buildCase({
      exception: exc,
      reconResult: rr,
      store: fakeStore,
    });

    samples.push({
      seed,
      sample_id: `${seed}_${rr.id}`,
      ground_truth_category: targetCategory,
      investigation_case: investigationCase,
    });
  }
}

console.log(`[export-ml-dataset] Successfully compiled ${samples.length} labeled samples.`);

// Count category distribution
const counts = {};
for (const s of samples) {
  counts[s.ground_truth_category] = (counts[s.ground_truth_category] || 0) + 1;
}
console.log('[export-ml-dataset] Class distribution:');
for (const [cat, count] of Object.entries(counts)) {
  console.log(`  ${cat.padEnd(20)} : ${count}`);
}

fs.writeFileSync(outputPath, JSON.stringify(samples, null, 2), 'utf-8');
console.log(`[export-ml-dataset] Saved to ${outputPath}`);
