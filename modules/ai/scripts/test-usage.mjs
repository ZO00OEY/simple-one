import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
const result = await build({ entryPoints: ['src/agent/usage.ts'], bundle: true, write: false, format: 'cjs', platform: 'browser' });
const ctx = vm.createContext({ module: { exports: {} } });
vm.runInContext(result.outputFiles[0].text, ctx);
const { usageText, usageRecords, modelUsage, trafficRecord } = ctx.module.exports;
assert.equal(usageText(), '输入 0 / 输出 0 / 缓存读取 0');
assert(usageText({ inputTokens: 10, outputTokens: 0, cacheReadTokens: 0 }).includes('输出 0'));
assert(usageText({ cacheReadTokens: 0 }).includes('缓存读取 0'));
const actor = { recordId: 'one', sourceId: 's', modelId: 'm', role: 'main', started: 5 };
const message = { role: 'assistant', execution: actor, usage: { inputTokens: 10 } };
const sessions = [{ id: 'a', messages: [message], updated: 1 }, { id: 'b', messages: [{ ...message, inherited: true }], updated: 2 }];
assert.equal(usageRecords([], sessions, 'b').length, 0);
assert.equal(usageRecords([], sessions, 'a')[0].usage.inputTokens, 10);
const records = [{ id: 'one', sessionId: 'a', started: 5, usage: { inputTokens: 20 } }, { id: 'two', sessionId: 'b', started: 6 }];
assert.equal(usageRecords(records, sessions).length, 2);
assert.equal(usageRecords(records, sessions, 'a')[0].usage.inputTokens, 20);
assert.equal(usageRecords(records, sessions)[0].id, 'two');
console.log('Usage records: missing vs zero, session scope, deduplication, inherited history and recency passed.');
const requests = [
  { id: 'r1', sessionId: 'archived', sourceId: 's', sourceName: 'Source', modelId: 'm', started: 1, usage: { inputTokens: 10, outputTokens: 0 } },
  { id: 'r2', sessionId: 'archived', sourceId: 's', sourceName: 'Source', modelId: 'm', started: 2, usage: { inputTokens: 20, outputTokens: 5 } },
  { id: 'r3', sessionId: 'archived', sourceId: 's', sourceName: 'Source', modelId: 'm', started: 3, usage: { outputTokens: 3 } },
  { id: 'r4', sessionId: 'archived', sourceId: 'other', sourceName: 'Other', modelId: 'm', started: 4 },
];
const archived = [{ id: 'archived', archived: true, messages: [], updated: 4 }];
const summary = modelUsage(usageRecords(requests, archived, 'archived'));
const sourceSummary = summary.find(row => row.sourceName === 'Source');
assert.equal(sourceSummary.requests, 3);
assert.equal(sourceSummary.input, 30);
assert.equal(sourceSummary.output, 8);
assert.equal(sourceSummary.missingInput, 1);
assert.equal(sourceSummary.missingOutput, 0);
assert.equal(summary.length, 2);
const ledger = Array.from({ length: 250 }, (_, index) => trafficRecord({ ...requests[0], id: 'request-' + index, input: 'private prompt', output: 'reply', rules: 'rules' }));
assert.equal(usageRecords([...ledger, ...ledger.slice(-200)], archived).length, 250);
assert.equal(modelUsage(usageRecords(ledger, archived))[0].input, 2500);
assert.equal(ledger[0].input, '');
assert.equal(ledger[0].output, '');
console.log('Traffic totals: archived sessions, cumulative requests, missing fields, distinct sources and durable accounting beyond 200 requests passed.');
