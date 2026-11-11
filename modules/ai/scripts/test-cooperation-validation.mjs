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

function seedRecommendationEvidence(service, recommendation) {
  for(let index=0;index<3;index++)service.state.assessments.push({id:'fixture-'+recommendation.sourceId+'-'+recommendation.modelId+'-'+index,taskId:'fixture-task-'+recommendation.sourceId+'-'+recommendation.modelId+'-'+index,created:1,summary:'fixture successful task',findings:[],questions:[],recommendations:[],recordIds:['fixture-record-'+index],taskType:'fixture',observations:[{sourceId:recommendation.sourceId,modelId:recommendation.modelId,role:'main',taskType:'fixture',records:[{id:'fixture-record-'+index,state:'done',elapsedMs:1}],verdict:'positive',reliable:true,problems:[]}]});
}

function realEnvironment() {
  const files = new Map(), plugin = Object.create(SimpleAIPlugin.prototype), agent = agentDefaults();
  agent.cooperation.examiner.enabled = true;
  agent.cooperation.auxiliary.candidates = [{ sourceId: 's', modelId: 'm', description: '保留用途' }, { sourceId: 's', modelId: 'p', description: '' }];
  Object.assign(plugin, { settings: { agent, selected: { sourceId: 's', modelId: 'm' }, sources: [{ id: 's', name: 'Actual', models: ['m', 'n', 'p'].map(id => ({ id })) }] },
    getKeys:()=>[], manifest: { dir: 'test-ai' }, writes: Promise.resolve(), runtime: { state: { sessions: [] }, changed() {} }, saveData: async value => { files.set('catalogue', JSON.stringify(value)); },
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
  seedRecommendationEvidence(e.service, rec);
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
  seedRecommendationEvidence(e.service, rec);
  if (restore) await e.service.applyRecommendation(rec);
  e.candidates()[0].description = '用户更改用途';
  const before = JSON.stringify(e.plugin.settings);
  await assert.rejects(e.service.applyRecommendation(rec, restore), /配置已变化/);
  assert.equal(JSON.stringify(e.plugin.settings), before);
}
for (const baseline of [null, { sourceId: 's', modelId: 'm' }]) {
  const e = realEnvironment(); e.plugin.settings.agent.cooperation.auxiliary.candidates = baseline ? [{ ...baseline, description: '旧用途' }] : [];
  const original = plain(e.candidates()), rec = { role: 'auxiliary', sourceId: 's', modelId: 'n', reason: '旧建议', baseline };
  seedRecommendationEvidence(e.service, rec);
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

// Examiner observations are archived separately from selected models and handwritten descriptions.
const descriptionResult = () => ({...valid(), recommendations: [], modelDescriptions: [{sourceId:'s',modelId:'n',description:'适合资料摘要；仅有一次实测，复杂推断需复核。',recordIds:['record']}]});
function descriptionEnvironment(raw = descriptionResult()) {
  const e = realEnvironment();
  e.plugin.settings.agent.cooperation.auxiliary.candidates.push({sourceId:'s',modelId:'n',description:'旧说明'});
  e.service.request = async (_role, _model, system, messages) => {
    assert(system.includes('modelDescriptions'));
    assert(messages[0].text.includes('旧说明'));
    return response(raw);
  };
  return e;
}
{
  const raw=descriptionResult(); raw.recommendations=[{role:'auxiliary',sourceId:'s',modelId:'n',reason:'实测'}];
  const e=descriptionEnvironment(raw), before=plain(e.candidates()), assessment=await e.service.evaluate('task');
  assert.deepEqual(plain(e.candidates().slice(0,2)),before.slice(0,2));
  assert.equal(e.candidates()[2].description,'旧说明');
  assert.deepEqual(plain(assessment.recommendations[0].baselineCandidates),plain(e.candidates()),'recommendation baseline preserves user descriptions');
  assert.equal(e.files.has('test-ai/private/settings.json'),false,'evaluation never writes user configuration');
  const loaded=new Cooperation(e.plugin);await loaded.load();
  assert.equal(loaded.state.assessments[0].modelDescriptions[0].description,raw.modelDescriptions[0].description);
  assert.equal(e.plugin.settings.agent.cooperation.auxiliary.supplementalInstructions,'');
}
for (const patch of [null, {}, {modelId:'m'}, {modelId:'unknown'}, {description:''}, {description:'x'.repeat(2001)}, {recordIds:[]}, {recordIds:['other']}, {recordIds:[null]}]) {
  const raw=descriptionResult(); raw.modelDescriptions=patch===null?null:[{...raw.modelDescriptions[0],...patch}];
  if(patch && !Object.keys(patch).length)raw.modelDescriptions.push({...raw.modelDescriptions[0]});
  const e=descriptionEnvironment(raw), before=JSON.stringify(e.plugin.settings);
  await assert.rejects(e.service.evaluate('task'));
  assert.equal(JSON.stringify(e.plugin.settings),before);assert.equal(e.service.state.assessments.length,0);
}
for (const limitation of ['low-confidence','failed','main','deselected','changed']) {
  const raw=descriptionResult(),e=descriptionEnvironment(raw),record=e.service.state.records[0];
  if(limitation==='low-confidence')raw.findings[0].confidence='low';
  if(limitation==='failed')record.state='failed';
  if(limitation==='main')record.role='main';
  if(limitation==='deselected')e.plugin.settings.agent.cooperation.auxiliary.candidates.pop();
  if(limitation==='changed')e.service.request=async()=>{e.candidates()[2].description='用户新说明';return response(raw);};
  await assert.rejects(e.service.evaluate('task'));
  assert.equal(e.candidates().find(c=>c.modelId==='n')?.description,limitation==='deselected'?undefined:limitation==='changed'?'用户新说明':'旧说明');
}
console.log('PASS examiner descriptions persist locally with evidence, preserve choices and instructions, and reject unsupported or stale updates');

{
  const e=realEnvironment();e.plugin.settings.agent.cooperation.auxiliary.candidates.push({sourceId:'s',modelId:'n',description:'用户手写的用途'});
  e.service.request=async(_role,_model,system,messages)=>{const data=JSON.parse(messages[0].text);assert(system.includes('不修改用户手写'));return response({taskType:'摘要',summary:'完整',findings:data.records.map(r=>({recordId:r.id,assessment:'已完成',reason:'满足要求',confidence:'medium'})),questions:[],recommendations:[{role:'memory',sourceId:'s',modelId:'n',reason:'同类任务实测'}]});};
  const first=await e.service.evaluate('task');
  assert.equal(e.service.state.capabilities[0].n,1);assert.equal(e.service.state.capabilities[0].confidence,'low');
  await assert.rejects(e.service.applyRecommendation(first.recommendations[0]),/样本不足/);
  for(let i=2;i<=3;i++){e.service.state.records.push({...e.service.state.records[0],id:'record'+i,taskId:'task'+i});await e.service.evaluate('task'+i);if(i===2)assert(e.service.observedNote('s','n').includes('n=2'));}
  assert.equal(e.candidates().at(-1).description,'用户手写的用途');assert.equal(e.service.state.capabilities[0].n,3);
  const rec=e.service.state.assessments.at(-1).recommendations[0];await e.service.applyRecommendation(rec);assert.equal(e.plugin.settings.agent.memory.selected.modelId,'n');await e.service.applyRecommendation(rec,true);
  await e.service.evaluate('task3');assert.equal(e.service.state.capabilities[0].n,3,'re-assessment is not another sample');
  await e.service.feedback(first,'未完成','考官错了，因为漏了关键数字');assert(e.service.observedNote('s','n').includes('漏了关键数字'));assert.equal(e.service.state.capabilities[0].confidence,'low');
  await assert.rejects(e.service.applyRecommendation(rec),/样本不足|结论不一致/);
  const loaded=new Cooperation(e.plugin);await loaded.load();assert.equal(loaded.state.capabilities[0].n,3);assert(loaded.observedNote('s','n').includes('漏了关键数字'));
}
{
  const e=realEnvironment();e.service.state.records[0].role='memory';e.service.request=async()=>response({...valid(),recommendations:[]});
  const a=await e.service.evaluate('task');assert.equal(a.taskType,'记忆提取与合并');assert.equal(e.service.state.capabilities[0].role,'memory');
}
console.log('PASS capability profiles: n=1/2 low, three independent consistent tasks enable guarded apply/restore, repeat evaluation does not inflate, user correction wins, memory role and restart persist');

for (const change of [e=>{e.plugin.settings.selected={sourceId:'s',modelId:'n'};},e=>{e.plugin.settings.agent.memory.maxAgeDays=12;},e=>{e.plugin.settings.sources[0].models.push({id:'new'});}]) {
  const e=realEnvironment();
  e.service.request=async()=>{change(e);return response({...valid(),recommendations:[]});};
  await assert.rejects(e.service.evaluate('task'),/配置已变化/);
  assert.equal(e.service.state.assessments.length,0);assert.equal(e.service.state.capabilities?.length??0,0);
}
console.log('PASS configuration changes during evaluation discard both assessment and capability updates');
