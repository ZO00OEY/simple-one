import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const result = await build({ stdin: { contents: `export { default as SimpleAIPlugin } from './src/main'; export * from './src/agent/cooperation'; export * from './src/agent/cooperationSchema'; export * from './src/agent/storage'; export * from './src/agent/types'; export * from './src/settingsSchema'; export * from './src/api/types';`, resolveDir: root }, bundle: true, write: false, format: 'cjs', platform: 'browser', external: ['obsidian'] });
const context = vm.createContext({ module: { exports: {} }, require: () => new Proxy({}, { get: () => class {} }), crypto: webcrypto, console, TextEncoder, AbortController });
vm.runInContext(result.outputFiles[0].text, context);
const { SimpleAIPlugin, Cooperation, decodeCooperation, decodeSettings, defaults, SessionStore, newState, newSession, roleNames } = context.module.exports;
const plain = value => JSON.parse(JSON.stringify(value));
function environment(synced = { sources: [{ id: 'host', name: '', models: [{ id: 'draft' }] }] }) {
  const disk = new Map(), writes = [];
  const adapter = { exists: async path => disk.has(path), read: async path => disk.get(path), mkdir: async path => { writes.push(path); disk.set(path, ''); }, write: async (path, text) => { writes.push(path); disk.set(path, text); },
    remove: async path => { writes.push(path); disk.delete(path); }, list: async path => ({ files: [...disk.keys()].filter(key => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/')), folders: [] }) };
  const plugin = Object.create(SimpleAIPlugin.prototype);
  Object.assign(plugin, { active: true, manifest: { dir: 'plugin' }, app: { vault: { adapter } }, settings: defaults(), writes: Promise.resolve(), loadData: async () => synced,
    saveData: async value => { writes.push('host'); disk.set('host', JSON.stringify(value)); }, runtime: { state: { sessions: [] }, load: async () => {}, changed() {} } });
  plugin.cooperation = new Cooperation(plugin);
  return { disk, writes, plugin, service: plugin.cooperation, localPath: 'plugin/private/settings.json', workPath: 'plugin/private/work.json' };
}
function work() {
  return { records: [{ id: 'record', taskId: 'task', role: 'auxiliary', sourceId: 'host', sourceName: 'draft', modelId: 'draft', started: 1, state: 'done', input: 'task', output: 'answer', rules: '', stage: 'test', truncated: false, futureRecord: { keep: 1 } }],
    assessments: [{ id: 'assessment', taskId: 'task', created: 1, summary: 'summary', findings: [{ recordId: 'record', assessment: 'ok', reason: 'evidence', confidence: 'high', futureFinding: true }], questions: [], recordIds: ['record'], recommendations: [{ role: 'auxiliary', sourceId: 'host', modelId: 'draft', reason: 'legacy', baseline: null, futureRecommendation: true }], futureAssessment: true }],
    discussion: [{ role: 'user', text: 'discussion', futureMessage: true }], futureWork: ['keep'] };
}
let checks = 0;
async function check(name, run) { await run(); checks++; console.log('PASS ' + name); }
await check('Normal and historical work snapshots preserve unknown fields through load/save', async () => {
  const e = environment(), raw = work();
  delete raw.records[0].rules; delete raw.records[0].stage; delete raw.records[0].truncated; delete raw.records[0].sourceName;
  e.disk.set(e.workPath, JSON.stringify(raw)); await e.service.load(); await e.service.save();
  const saved = JSON.parse(e.disk.get(e.workPath));
  assert.deepEqual(saved.futureWork, ['keep']); assert.deepEqual(saved.records[0].futureRecord, { keep: 1 });
  assert.equal(saved.assessments[0].findings[0].futureFinding, true); assert.equal(saved.assessments[0].recommendations[0].futureRecommendation, true);
  assert.equal(saved.discussion[0].futureMessage, true); assert.equal(saved.records[0].rules, ''); assert.equal(saved.day, '');
  const loaded = new Cooperation(e.plugin); await loaded.load(); assert.equal(loaded.state.records[0].output, 'answer');
});
const badWork = [
  value => { value.records = [null]; }, value => { value.records[0].input = []; }, value => { value.records[0].rules = null; }, value => { value.records[0].started = '1'; },
  value => { value.records[0].state = 'unknown'; }, value => { value.records[0].usage = { inputTokens: '1' }; }, value => { value.records[0].requestContext = { tools: [null] }; },
  value => { value.traffic = [null]; }, value => { value.assessments[0].findings = [null]; }, value => { value.assessments[0].questions = [false]; },
  value => { value.assessments[0].recommendations[0].baseline = []; }, value => { value.assessments[0].recommendations[0].previousCandidates = [null]; },
  value => { value.assessments[0].feedback = { satisfaction: [], reason: '', updated: 1 }; }, value => { value.discussion = [null]; },
  value => { value.discussion[0].calls = [{ id: 'call', name: 'tool', arguments: [] }]; }, value => { value.requests = '1'; }, value => { delete value.discussion; },
];
await check('Malformed work fields recover a valid backup and never rotate the corrupt primary', async () => {
  for (const corrupt of badWork) {
    const e = environment(), raw = work(), good = JSON.stringify(raw); corrupt(raw);
    e.disk.set(e.workPath, JSON.stringify(raw)); e.disk.set(e.workPath + '.previous', good);
    await e.service.load(); assert.equal(e.writes.length, 0); await e.service.save();
    assert.equal(e.disk.get(e.workPath + '.previous'), good); assert.equal(JSON.parse(e.disk.get(e.workPath)).records[0].output, 'answer');
  }
});
await check('Both damaged work copies reject load and all later saves without changing bytes', async () => {
  const e = environment(); e.disk.set(e.workPath, JSON.stringify({ ...work(), records: [null] })); e.disk.set(e.workPath + '.previous', '{');
  const before = [...e.disk]; await assert.rejects(e.service.load()); await assert.rejects(e.service.save());
  assert.deepEqual([...e.disk], before); assert.equal(e.writes.length, 0);
});
await check('Backup-only work restores and running work is marked interrupted', async () => {
  const e = environment(), raw = work(); raw.records[0].state = 'running'; e.disk.set(e.workPath + '.previous', JSON.stringify(raw));
  await e.service.load(); assert.equal(e.service.state.records[0].state, 'interrupted'); await e.service.save();
  assert.equal(JSON.parse(e.disk.get(e.workPath)).records[0].state, 'interrupted');
});
await check('Retired review roles round trip in work and session history, but cannot execute or apply settings', async () => {
  const e = environment(), raw = work(), actor = { recordId: 'record', taskId: 'task', role: 'review', sourceId: 'host', modelId: 'draft' };
  raw.records[0].role = 'review'; raw.traffic = [plain(raw.records[0])];
  raw.assessments[0].findings[0].actor = { role: 'review', sourceId: 'host', sourceName: 'old review', modelId: 'draft' };
  raw.assessments[0].recommendations[0].role = 'review'; raw.discussion[0].execution = actor;
  e.disk.set(e.workPath, JSON.stringify(raw)); await e.service.load();
  const state = newState(), session = newSession(null); state.sessions = [session]; state.active = session.id;
  session.messages = [{ role: 'assistant', text: 'historical review result', execution: actor, futureMessage: true }];
  const store = new SessionStore(e.plugin.app.vault.adapter, 'sessions'); await store.save(state);
  const loaded = await new SessionStore(e.plugin.app.vault.adapter, 'sessions').load();
  assert.equal(loaded.sessions[0].messages[0].execution.role, 'review'); assert.equal(loaded.sessions[0].messages[0].futureMessage, true);
  e.plugin.runtime.state = loaded; await e.service.initializeTraffic();
  assert.equal(e.service.taskRecords('task')[0].role, 'review'); assert.equal(e.service.evaluationEvidence('task').actors[0].role, 'review');
  const saved = JSON.parse(e.disk.get(e.workPath)); assert.equal(saved.records[0].role, 'review'); assert.equal(saved.traffic[0].role, 'review');
  assert.equal(saved.assessments[0].findings[0].actor.role, 'review'); assert.equal(saved.assessments[0].recommendations[0].role, 'review'); assert.equal(saved.discussion[0].execution.role, 'review');
  assert.equal(Object.hasOwn(roleNames, 'review'), false, 'retired roles never enter current model/tool choices');
  let requests = 0; e.plugin.client = { chat: async () => { requests++; } };
  const before = [...e.disk], settingsBefore = plain(e.plugin.settings), rec = e.service.state.assessments[0].recommendations[0];
  assert.throws(() => e.service.model('review'), /模型角色无效/);
  await assert.rejects(e.service.request('review', { sourceId: 'host', modelId: 'draft' }, '', [], []), /模型角色无效/);
  await assert.rejects(e.service.applyRecommendation(rec), /模型角色无效/); await assert.rejects(e.service.applyRecommendation(rec, true), /模型角色无效/);
  assert.equal(requests, 0); assert.deepEqual(plain(e.plugin.settings), settingsBefore); assert.deepEqual([...e.disk], before);
});
await check('Settings preserve drafts, host catalogue precedence, legacy migration and unknown fields', async () => {
  const e = environment({ sources: [{ id: 'host', name: '', models: [{ id: '', futureModel: true }], futureSource: true }], showSourceName: false });
  const raw = { sources: [null], sendShortcut: 'enter', selected: { sourceId: 'host', modelId: '' }, futureLocal: { keep: 1 },
    agent: { futureAgent: true, skills: [{ id: 'builtin', name: 'Builtin', body: 'instructions', enabled: true }],
      memory: { futureMemory: true }, cooperation: { futureCooperation: true, review: { enabled: true, selected: { sourceId: 'host', modelId: '' } }, auxiliary: { selected: { sourceId: 'host', modelId: '' }, description: 'legacy use', futureAuxiliary: true } } } };
  e.disk.set(e.localPath, JSON.stringify(raw)); await e.plugin.prepareRequests();
  assert.equal(e.plugin.settings.sources[0].id, 'host'); assert.equal(e.plugin.settings.showSourceName, false); assert.equal(e.plugin.settings.sendShortcut, 'enter');
  assert.equal(e.plugin.settings.agent.skills[0].path, undefined);
  assert.equal(e.plugin.settings.agent.cooperation.auxiliary.candidates[0].description, 'legacy use');
  await e.plugin.update(e.plugin.settings); const saved = JSON.parse(e.disk.get(e.localPath)), host = JSON.parse(e.disk.get('host'));
  assert.deepEqual(saved.futureLocal, { keep: 1 }); assert.equal(saved.agent.futureAgent, true); assert.equal(saved.agent.memory.futureMemory, true);
  assert.equal(saved.agent.cooperation.futureCooperation, true); assert.equal(saved.agent.cooperation.auxiliary.futureAuxiliary, true);
  assert.deepEqual(saved.agent.cooperation.review, raw.agent.cooperation.review);
  assert.equal(saved.agent.skills[0].path, undefined); assert.equal(host.sources[0].futureSource, true); assert.equal(host.sources[0].models[0].futureModel, true); assert.equal(saved.sources, undefined);
});
const badSettings = [null, [], { agent: null }, { sources: [null] }, { sources: [{ id: 's', models: [null] }] }, { sources: [{ id: 's', models: [], keyIds: [2] }] },
  { selected: {} }, { sendShortcut: 'invalid' }, { agent: { references: [null] } }, { agent: { referenceRules: [null] } }, { agent: { skills: [null] } },
  { agent: { skills: [{ id: 'x', name: 'skill', body: 'body', path: null }] } }, { agent: { memory: { path: 4 } } }, { agent: { cooperation: [] } },
  { agent: { cooperation: { auxiliary: { candidates: [null] } } } }, { agent: { cooperation: { auxiliary: { description: null } } } },
  { agent: { cooperation: { examiner: { automatic: 'true' } } } }, { cacheCleanupDays: '7' }, { showSourceName: 0 }];
await check('Malformed settings and nested fields are rejected instead of defaulted', () => {
  for (const value of badSettings) assert.throws(() => decodeSettings(value), JSON.stringify(value));
  assert.throws(() => decodeCooperation({ ...work(), requests: Infinity })); assert.throws(() => decodeSettings({ agent: { contextChars: NaN } }));
});
await check('Local settings corruption restores good backup without replacing it at startup', async () => {
  for (const value of badSettings.filter(value => value === null || !Array.isArray(value) && !value.sources)) {
    const e = environment(), good = JSON.stringify({ sendShortcut: 'enter', futureLocal: true });
    e.disk.set(e.localPath, JSON.stringify(value)); e.disk.set(e.localPath + '.previous', good);
    await e.plugin.prepareRequests(); assert.equal(e.plugin.settings.sendShortcut, 'enter'); assert.equal(e.disk.get(e.localPath + '.previous'), good);
  }
  const e = environment(); e.disk.set(e.localPath + '.previous', JSON.stringify({ cacheCleanupDays: 12 })); await e.plugin.prepareRequests(); assert.equal(e.plugin.settings.cacheCleanupDays, 12);
});
await check('Both damaged local settings copies stop startup and later updates without writes', async () => {
  const e = environment(); e.disk.set(e.localPath, JSON.stringify({ agent: { skills: [null] } })); e.disk.set(e.localPath + '.previous', '{');
  const before = [...e.disk]; await assert.rejects(e.plugin.prepareRequests()); await assert.rejects(e.plugin.update(defaults()));
  assert.deepEqual([...e.disk], before); assert.equal(e.writes.length, 0);
});
await check('Malformed synchronised catalogue never falls back to local catalogue or writes defaults', async () => {
  const e = environment({ sources: [null] }); e.disk.set(e.localPath, JSON.stringify({ sources: [{ id: 'local', models: [] }] }));
  const before = [...e.disk]; await assert.rejects(e.plugin.prepareRequests()); await assert.rejects(e.plugin.update(defaults()));
  assert.deepEqual([...e.disk], before); assert.equal(e.writes.length, 0);
});
await check('Writes validate live work and settings before touching good disk snapshots', async () => {
  const e = environment(); e.disk.set(e.workPath, JSON.stringify(work())); await e.service.load(); e.service.state.records[0].input = null;
  const beforeWork = [...e.disk]; await assert.rejects(e.service.save()); assert.deepEqual([...e.disk], beforeWork);
  e.disk.set(e.localPath, JSON.stringify({ sendShortcut: 'enter' })); await e.plugin.prepareRequests();
  const before = [...e.disk], invalid = plain(e.plugin.settings); invalid.agent.references = [null];
  await assert.rejects(e.plugin.update(invalid)); assert.deepEqual([...e.disk], before);
});
console.log(`${checks} work/settings persistence checks passed.`);
