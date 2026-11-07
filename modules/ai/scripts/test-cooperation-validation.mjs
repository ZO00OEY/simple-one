import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';

const code = await build({ stdin: { contents: `export { Cooperation } from './src/agent/cooperation'; export { agentDefaults } from './src/agent/types'; export { default as SimpleAIPlugin } from './src/main';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'browser', external: ['obsidian'] });
const ctx = vm.createContext({ module: { exports: {} }, require: () => new Proxy({}, { get: () => class {} }), crypto: webcrypto, TextEncoder, AbortController, console });
vm.runInContext(code.outputFiles[0].text, ctx);
const { Cooperation, agentDefaults, SimpleAIPlugin } = ctx.module.exports;
function environment(responses = []) {
  const agent = agentDefaults(); agent.cooperation.examiner.enabled = true;
  let updates = 0;
  const plugin = { settings: { agent, selected: { sourceId: 's', modelId: 'm' }, sources: [{ id: 's', name: 'actual', models: [{ id: 'm' }] }] }, runtime: { state: { sessions: [] }, changed() {} }, update: async () => { updates++; } };
  const service = new Cooperation(plugin); service.save = async () => {};
  service.request = async () => responses.shift();
  service.state.records.push({ id: 'record', taskId: 'task', role: 'main', sourceId: 's', sourceName: 'actual', modelId: 'm', state: 'done', started: 1, ended: 2, input: '', output: '', rules: '', truncated: false, stage: 'test' });
  return { service, plugin, updates: () => updates };
}
const valid = () => ({ summary: 'ok', findings: [{ recordId: 'record', assessment: 'ok', reason: 'evidence', confidence: 'high' }], questions: [], recommendations: [{ role: 'memory', sourceId: 's', modelId: 'm', reason: 'evidence' }] });
const response = value => ({ role: 'assistant', text: JSON.stringify(value) });
const invalid = [null, [], { ...valid(), summary: null }, { ...valid(), findings: [null] }, { ...valid(), findings: [{ ...valid().findings[0], confidence: 'certain' }] }, { ...valid(), findings: [{ ...valid().findings[0], recordId: 'other-task' }] }, { ...valid(), questions: [null] }, { ...valid(), recommendations: [null] }, { ...valid(), recommendations: [{ ...valid().recommendations[0], role: 'constructor' }] }, { ...valid(), recommendations: [{ ...valid().recommendations[0], sourceId: null }] }, { ...valid(), recommendations: [{ ...valid().recommendations[0], modelId: 'unseen' }] }, { ...valid(), recommendations: [{ ...valid().recommendations[0], reason: [] }] }];
for (const value of invalid) {
  const e = environment([response(value)]), before = JSON.stringify(e.plugin.settings);
  await assert.rejects(e.service.evaluate('task'));
  assert.equal(e.service.state.assessments.length, 0);
  assert.equal(JSON.stringify(e.plugin.settings), before);
  assert.equal(e.updates(), 0);
}
{
  const raw = valid(); raw.findings[0].actor = { sourceId: 'fake' }; raw.findings[0].extra = 'drop';
  Object.assign(raw.recommendations[0], { baseline: { sourceId: 'fake' }, baselineFollow: 'auxiliary', applied: true, previous: { sourceId: 'fake' }, previousFollow: 'auxiliary', extra: 'drop' });
  const e = environment([response(raw)]), assessment = await e.service.evaluate('task');
  assert.equal(assessment.findings[0].actor.sourceName, 'actual');
  assert.equal(assessment.findings[0].extra, undefined);
  assert.equal(assessment.recommendations[0].baseline, null);
  for (const key of ['applied', 'previous', 'previousFollow', 'extra']) assert.equal(assessment.recommendations[0][key], undefined);
  assert.equal(e.updates(), 0);
}
for (const evidenceIds of [null, [], 'null', '{}', '[]', '[null]', '[1]', '[""]', '[" "]', '["missing"]', '["assessment",null]', '{']) {
  const suggestion = { id: 'suggest', name: 'suggest_configuration', arguments: { role: 'memory', sourceId: 's', modelId: 'm', reason: 'evidence', evidenceIds } };
  const e = environment([{ role: 'assistant', text: '', calls: [suggestion] }, { role: 'assistant', text: 'done' }]);
  e.service.state.assessments.push({ id: 'assessment', taskId: 'old', findings: [], questions: [], recommendations: [], recordIds: [] });
  const before = JSON.stringify(e.plugin.settings);
  await e.service.discuss('suggest');
  assert.equal(e.service.state.assessments.length, 1);
  assert(e.service.state.discussion.some(m => m.role === 'tool' && m.error));
  assert.equal(JSON.stringify(e.plugin.settings), before); assert.equal(e.updates(), 0);
}
for (const patch of [null, { role: 'constructor' }, { sourceId: null }, { modelId: 'unavailable' }, { reason: [] }]) {
  const args = patch === null ? null : { role: 'memory', sourceId: 's', modelId: 'm', reason: 'evidence', evidenceIds: '["assessment"]', ...patch };
  const e = environment([{ role: 'assistant', text: '', calls: [{ id: 'suggest', name: 'suggest_configuration', arguments: args }] }, { role: 'assistant', text: 'done' }]);
  e.service.state.assessments.push({ id: 'assessment', taskId: 'old', findings: [], questions: [], recommendations: [], recordIds: [] });
  await e.service.discuss('suggest');
  assert.equal(e.service.state.assessments.length, 1);
  assert(e.service.state.discussion.some(m => m.role === 'tool' && m.error));
  assert.equal(e.updates(), 0);
}
for (const value of [null, {}, { text: null }, { text: 'reply', calls: [null, {}, { id: 'bad', name: 'read_note', arguments: null }, { id: 'good', name: 'read_note', arguments: { path: 'a.md' } }] }]) {
  const e = environment(), r = e.service.state.records[0]; r.role = 'auxiliary'; r.output = JSON.stringify(value); r.input = JSON.stringify([null, {}, { role: 'user', text: null }, { role: 'user', text: 'task' }]);
  const evidence = e.service.evaluationEvidence('task');
  assert.equal(evidence.records[0].delegation.text, 'task');
  if (value?.text === 'reply') { assert.equal(evidence.records[0].reply.calls.length, 1); assert.equal(evidence.records[0].reply.calls[0].id, 'good'); }
  else assert.equal(evidence.records[0].reply, undefined);
}
console.log('PASS cooperation untrusted JSON validation, trusted metadata and malformed history');

// Use the production update() path: its legacy migration used to clear the
// obsolete selected field while silently leaving the actual candidates alone.
function realEnvironment() {
  const files = new Map(), plugin = Object.create(SimpleAIPlugin.prototype), agent = agentDefaults();
  agent.cooperation.examiner.enabled = true;
  agent.cooperation.auxiliary.candidates = [{ sourceId: 's', modelId: 'm', description: '保留用途' }, { sourceId: 's', modelId: 'p', description: '' }];
  Object.assign(plugin, { settings: { agent, selected: { sourceId: 's', modelId: 'm' }, sources: [{ id: 's', name: 'Actual', models: ['m', 'n', 'p'].map(id => ({ id })) }] },
    manifest: { dir: 'test-ai' }, writes: Promise.resolve(), runtime: { state: { sessions: [] }, changed() {} }, saveData: async value => { files.set('catalogue', JSON.stringify(value)); },
    app: { vault: { adapter: { exists: async path => files.has(path), mkdir: async path => { files.set(path, ''); }, read: async path => files.get(path), write: async (path, content) => { files.set(path, content); } } } } });
  const service = new Cooperation(plugin);
  service.state.records.push({ id: 'record', taskId: 'task', role: 'auxiliary', sourceId: 's', sourceName: 'Actual', modelId: 'n', state: 'done', started: 1, ended: 2, input: '', output: '', rules: '', truncated: false, stage: 'test' });
  service.request = async () => response({ ...valid(), recommendations: [{ role: 'auxiliary', sourceId: 's', modelId: 'n', reason: '实测' }] });
  return { plugin, service, files, candidates: () => plugin.settings.agent.cooperation.auxiliary.candidates };
}
const plain = value => JSON.parse(JSON.stringify(value));
{
  const e = realEnvironment(), original = plain(e.candidates());
  const rec = (await e.service.evaluate('task')).recommendations[0];
  assert.deepEqual(plain(rec.baselineCandidates), original);
  await e.service.applyRecommendation(rec);
  assert.deepEqual(plain(e.candidates().slice(0, 2)), original);
  assert.equal(e.candidates()[2].modelId, 'n'); assert.equal(rec.applied, true);
  assert.equal(e.plugin.settings.agent.cooperation.auxiliary.selected, null);
  assert.deepEqual(JSON.parse(e.files.get('test-ai/private/settings.json')).agent.cooperation.auxiliary.candidates, plain(e.candidates()));
  const loaded = new Cooperation(e.plugin); await loaded.load();
  e.plugin.settings.agent.cooperation.auxiliary.description = '后续默认用途';
  await loaded.applyRecommendation(loaded.state.assessments[0].recommendations[0], true);
  assert.deepEqual(plain(e.candidates()), original);
  await loaded.applyRecommendation(loaded.state.assessments[0].recommendations[0]);
  assert.equal(e.candidates().at(-1).modelId, 'n', 'restored recommendation remains reusable');
}
for (const restore of [false, true]) {
  const e = realEnvironment(), rec = (await e.service.evaluate('task')).recommendations[0];
  if (restore) await e.service.applyRecommendation(rec);
  e.candidates()[0].description = '用户更改用途';
  const before = JSON.stringify(e.plugin.settings);
  await assert.rejects(e.service.applyRecommendation(rec, restore), /配置已变化/);
  assert.equal(JSON.stringify(e.plugin.settings), before);
}
for (const baseline of [null, { sourceId: 's', modelId: 'm' }]) {
  const e = realEnvironment(); e.plugin.settings.agent.cooperation.auxiliary.candidates = baseline ? [{ ...baseline, description: '旧用途' }] : [];
  const original = plain(e.candidates()), rec = { role: 'auxiliary', sourceId: 's', modelId: 'n', reason: '旧建议', baseline };
  await e.service.applyRecommendation(rec); assert.equal(e.candidates().at(-1).modelId, 'n');
  await e.service.applyRecommendation(rec, true); assert.deepEqual(plain(e.candidates()), original);
}
{
  const e = realEnvironment(); e.plugin.settings.agent.cooperation.auxiliary.candidates = [{ sourceId: 's', modelId: 'n', description: '旧模式迁移' }];
  await e.service.applyRecommendation({ role: 'auxiliary', sourceId: 's', modelId: 'n', reason: '旧应用记录', baseline: null, applied: true, previous: { sourceId: 's', modelId: 'm' } }, true);
  assert.equal(e.candidates()[0].modelId, 'm');
  const before = JSON.stringify(e.plugin.settings);
  await assert.rejects(e.service.applyRecommendation({ role: 'auxiliary', sourceId: 's', modelId: 'n', reason: '旧版误标', baseline: null, applied: true, previous: null }, true), /配置已变化/);
  assert.equal(JSON.stringify(e.plugin.settings), before);
}
for (const snapshot of [null, [null], [{}], [{ sourceId: 's', modelId: 'm', description: null }]]) {
  const e = realEnvironment(), before = JSON.stringify(e.plugin.settings);
  await assert.rejects(e.service.applyRecommendation({ role: 'auxiliary', sourceId: 's', modelId: 'n', reason: '损坏快照', baselineCandidates: snapshot }), /快照无效/);
  assert.equal(JSON.stringify(e.plugin.settings), before);
}
console.log('PASS auxiliary recommendations use real update(), preserve candidate descriptions, reject changed baselines and recover legacy records safely');
