const { classifyIntent } = require('./src/investigation/chat/nativeReasoning');
const ctx = {};
console.log('Rule Intent:', classifyIntent('how does the gross amount relate to the settlement?', [], ctx));
