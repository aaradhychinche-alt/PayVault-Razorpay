const { resolveWithState } = require('./src/investigation/chat/nativeReasoning');
const state = {
  currentTopic: 'gross_amount',
  previousIntent: 'gross_amount',
  activeFinancialMetric: null,
  referencedEntities: [ 'fee', 'gst', 'gross' ],
};
console.log('Resolved Message:', resolveWithState('but how', state));
