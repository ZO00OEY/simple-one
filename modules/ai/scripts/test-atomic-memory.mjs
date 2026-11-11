import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
const result=await build({stdin:{contents:`export * from './src/agent/atomicMemory'; export * from './src/agent/memoryRetrieval'; export * from './src/agent/memoryDeltas'; export * from './src/agent/memoryStore'; export * from './src/agent/storageSchema'; export * from './src/agent/types';`,resolveDir:process.cwd()},bundle:true,write:false,format:'cjs',platform:'browser',external:['obsidian']});
class TFile { constructor(path){this.path=path;} }
const ctx=vm.createContext({module:{exports:{}},require:()=>({TFile}),crypto:webcrypto,console});vm.runInContext(result.outputFiles[0].text,ctx);
const {migrateMemoryItems,replaceMemoryItems,parseMemoryItems,memoryStart,memoryEnd,decodeMemory,newState,AtomicMemoryStore}=ctx.module.exports;
const plain=x=>JSON.parse(JSON.stringify(x));
const legacy={session:{text:'保持标题简洁\n范围不明的旧段落',revision:1,updated:1000}};
const items=migrateMemoryItems(legacy);assert.equal(items.length,2);assert(items.every(i=>i.status==='pending'&&i.confidence==='low'&&i.sourceSessionId==='session'));
assert.equal(migrateMemoryItems(legacy,items).length,2);
const manual='手写前缀\r\n'+memoryStart+'\n旧散文\n'+memoryEnd+'\r\n手写后缀';
items[0].text='a | b \\ c\n<comment>';const text=replaceMemoryItems(manual,items);assert(text.startsWith('手写前缀\r\n'));assert(text.endsWith('\r\n手写后缀'));assert.equal(parseMemoryItems(text)[0].text,items[0].text);
for(const malformed of [memoryStart, memoryEnd, memoryEnd+memoryStart, memoryStart+memoryEnd+memoryEnd])assert.throws(()=>replaceMemoryItems(malformed,items));
for(const patch of [{items:[null]},{items:[{...items[0],confidence:'certain'}]},{items:[items[0],items[0]]},{itemVersions:[{id:'x',before:null}]}])assert.throws(()=>decodeMemory({...newState().memory,...patch}));
let body=replaceMemoryItems('manual',items);const file=new TFile('SIMPLE_AI.md');const runtime={state:newState(),userActive(){},changed(){},save:async()=>{},plugin:{settings:{agent:{memory:{path:'SIMPLE_AI.md'}}},app:{vault:{getAbstractFileByPath:()=>file,read:async()=>body,process:async(_,fn)=>{body=fn(body);}}}}};
const store=new AtomicMemoryStore(runtime);await store.edit(items[0].id,null);assert.equal(parseMemoryItems(body).length,1);await store.undo(items[0].id);assert.equal(parseMemoryItems(body).length,2);assert(body.startsWith('manual'));
await store.edit(items[0].id,{text:'confirmed text',scope:'notes',pinned:true});assert.equal(parseMemoryItems(body).find(i=>i.id===items[0].id).confidence,'high');
body=body.replace('confirmed text','later manual edit');await assert.rejects(store.undo(items[0].id),/变化/);
assert.equal(plain((await store.read()).items).find(i=>i.id===items[0].id).text,'later manual edit');
console.log('PASS atomic migration, readable roundtrip, marker/manual preservation, schema rejection, single forget/undo and authoritative manual edits');

const {applyMemoryDeltas,readMemoryDeltas,takeMemoryProposals}=ctx.module.exports;
const source=(id,date,quote)=>({id,date,users:[quote]});
const delta=(id,date,quote,patch={})=>({action:'add',kind:'preference',text:'标题简洁',sourceSessionId:id,sourceDate:date,evidence:quote,reason:'用户长期规则',...patch});
let atomic=applyMemoryDeltas([], [delta('a',1,'以后标题都要简洁')], [source('a',1,'以后标题都要简洁')]);assert.equal(atomic[0].confidence,'low');
atomic=applyMemoryDeltas(atomic,[delta('a',2,'以后标题都要简洁')],[source('a',2,'以后标题都要简洁')]);assert.equal(atomic.length,1);assert.equal(atomic[0].confidence,'low');
atomic=applyMemoryDeltas(atomic,[delta('b',3,'以后标题都要简洁')],[source('b',3,'以后标题都要简洁')]);assert.equal(atomic[0].confidence,'medium');
atomic=applyMemoryDeltas(atomic,[delta('b',4,'对，就是这样，记下来')],[source('b',4,'对，就是这样，记下来')]);assert.equal(atomic[0].confidence,'high');
const old=atomic[0].id;
for (const action of ['update', 'retire']) {
  assert.throws(()=>applyMemoryDeltas(atomic,[delta('b',5,'我不喜欢红色',{action,id:old,text:'偏好蓝色'})],[source('b',5,'我不喜欢红色')]),/明确纠正或否定/);
  assert.equal(atomic[0].status,'active');
}
atomic=applyMemoryDeltas(atomic,[delta('b',5,'纠正一下，以后标题不要简洁',{action:'update',id:old,text:'标题需要详细'})],[source('b',5,'纠正一下，以后标题不要简洁')]);assert.equal(atomic[0].status,'retired');assert(atomic[0].retiredReason.includes(atomic[1].id));assert.equal(atomic[1].confidence,'low');
assert.throws(()=>applyMemoryDeltas(atomic,[delta('b',6,'AI invented')],[source('b',6,'actual user')]));
assert.throws(()=>readMemoryDeltas('[null]'));assert.throws(()=>readMemoryDeltas(JSON.stringify(Array(4).fill(delta('b',6,'quote')))));
assert.equal(takeMemoryProposals('visible<!-- simple-ai:memory-deltas:[] -->').text,'visible');
console.log('PASS delta deduplication, independent-session confidence, explicit confirmation, conflict retirement, source proof and three-item bounds');

const {expireMemories,retrieveMemories}=ctx.module.exports;
const now=Date.now(), day=86400000;
const many=Array.from({length:40},(_,i)=>({...items[0],id:'memory-'+i,text:'unrelatedtopic'+i,kind:'preference',status:'active',lastConfirmedAt:now}));
many[0]={...many[0],text:'标题简洁',scope:'Notes',lastConfirmedAt:now-40*day};
many[1]={...many[1],text:'常驻工作规则',kind:'rule',confidence:'high'};
many[2]={...many[2],text:'已废弃的标题规则',status:'retired',pinned:true};
const expired=expireMemories(many,30,now);assert.equal(expired[0].status,'stale');assert.equal(many[0].status,'active');assert.equal(expired[2].status,'retired');
const selected=retrieveMemories(expired,'Notes/a.md 标题');assert(selected.includes('[待确认]'));assert(selected.includes('常驻工作规则'));assert(!selected.includes('已废弃的标题规则'));assert(!selected.includes('unrelatedtopic39'));assert(selected.includes('本次注入 2 条记忆，另有 37 条未注入'));
assert(!retrieveMemories(expired,'no matches').includes('标题简洁'));
assert(retrieveMemories(many.map(i=>({...i,pinned:true,text:'长'.repeat(900)})),'').length<6300);
const fresh=applyMemoryDeltas([expired[0]],[delta('new',now,'以后标题都要简洁',{scope:'Notes'})],[source('new',now,'以后标题都要简洁')]);assert.equal(fresh[0].status,'active');assert.equal(fresh[0].lastConfirmedAt,now);
console.log('PASS bounded core/retrieval, folder and Chinese keywords, unmatched/retired exclusion, expiry and fresh confirmation');

assert.equal(expireMemories([{...many[0],lastConfirmedAt:now-30*day}],30,now)[0].status,'active');
assert.equal(expireMemories([{...many[0],lastConfirmedAt:now-11*day}],10,now)[0].status,'stale');
assert.equal(expireMemories([{...many[0],status:'pending'}],30,now)[0].status,'pending');
assert.equal(expireMemories([{...many[0],lastConfirmedAt:now+day}],30,now)[0].status,'active');
const retired=applyMemoryDeltas([expired[0]],[delta('new',now,'以后不要再用这条标题规则',{action:'retire',id:expired[0].id,scope:'Notes'})],[source('new',now,'以后不要再用这条标题规则')]);assert.equal(retired[0].status,'retired');assert(!retrieveMemories(retired,'Notes 标题').includes('标题简洁'));
let coreOnly=retrieveMemories(Array.from({length:20},(_,i)=>({...many[1],id:'core'+i,text:'core '+i})),'');assert.equal((coreOnly.match(/\[生效\]/g)||[]).length,10);
body=replaceMemoryItems('manual-before\n'+memoryStart+'\n'+memoryEnd+'\nmanual-after', [many[0]]);
runtime.plugin.settings.agent.memory.maxAgeDays=30;
const persisted=await store.context('Notes 标题');assert(persisted.includes('manual-before'));assert(persisted.includes('manual-after'));assert(persisted.includes('待确认'));assert.equal(parseMemoryItems(body)[0].status,'stale');
await store.edit(expired[0].id,{text:expired[0].text,scope:'Notes',pinned:false});assert.equal(parseMemoryItems(body)[0].status,'active');assert(parseMemoryItems(body)[0].lastConfirmedAt>=now);
const correctionAt=Date.now();await store.apply([delta('other',correctionAt,'纠正一下，标题需要详细',{action:'update',id:expired[0].id,text:'标题需要详细',scope:'Notes'})],[source('other',correctionAt,'纠正一下，标题需要详细')]);
const replacement=parseMemoryItems(body).find(i=>i.status==='active');await store.undo(replacement.id);assert.equal(parseMemoryItems(body).length,1);assert.equal(parseMemoryItems(body)[0].id,expired[0].id);assert.equal(parseMemoryItems(body)[0].status,'active');
const processFile=runtime.plugin.app.vault.process;
body=replaceMemoryItems('manual', [many[0]]);
runtime.plugin.app.vault.process=async(_,fn)=>{body+='\nconcurrent manual edit';body=fn(body);};
await assert.rejects(store.context('Notes'),/变化/);assert(body.endsWith('concurrent manual edit'));runtime.plugin.app.vault.process=processFile;
console.log('PASS expiry boundary/custom age/future dates, pending retention, core count, explicit denial, persisted expiry/reconfirmation, conflict undo and concurrent-edit preservation');

body=memoryStart+'\nlegacy prose\n'+memoryEnd;runtime.state=newState();
await store.context('legacy');const migrated=parseMemoryItems(body);assert(migrated?.length);assert.equal(migrated[0].status,'pending');
await store.context('legacy');assert.equal(parseMemoryItems(body)[0].id,migrated[0].id,'first retrieval persists legacy IDs before using them in model proposals');
console.log('PASS first retrieval persists migrated pending entries with stable IDs');
