import assert from 'node:assert/strict';
import {build} from 'esbuild';
let supported=true,created=0,prepared=0,uiStarts=0,unloaded=0,failStart=false;
let hold=false,entered;
class Component{constructor(){this.children=[];}load(){this.onload?.();}unload(){this.onunload?.();for(const c of this.children)c.unload();this.children=[];}addChild(c){this.children.push(c);c.load();return c;}removeChild(c){c.unload();this.children=this.children.filter(x=>x!==c);return c;}}
class Core extends Component{
 constructor(app,manifest){super();created++;this.app=app;this.manifest=manifest;this.settings={sources:[]};this.ui=false;}
 async prepareRequests(){prepared++;this.settings=await this.loadData();}
 async start(){if(failStart)throw Error('startup failed');uiStarts++;this.ui=true;}
 stopUI(){this.ui=false;}
 async translateSelection(input,signal,update){assert(this.settings.sources.some(s=>s.id===input.sourceId));if(hold)return new Promise((_r,reject)=>{entered();signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true});});update?.('译文');return '译文';}
 onunload(){unloaded++;this.stopUI();}
}
globalThis.aiCoreMock=Core;
const bundled=await build({entryPoints:['src/features/ai.ts'],bundle:true,format:'cjs',platform:'node',write:false,external:['obsidian'],plugins:[{name:'mock-core',setup(b){b.onResolve({filter:/modules\/ai\/src\/(main|api\/settings|agent\/view)$/},args=>({path:args.path,namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:args.path.endsWith('/main')?'export default globalThis.aiCoreMock;':args.path.endsWith('/settings')?'export class ApiSettingsTab {hide(){}renderInto(){}}':'export const CHAT_VIEW="simple-one-ai-chat";'}));}}]});
const module={exports:{}};new Function('require','module','exports',bundled.outputFiles[0].text)(()=>({Component,requireApiVersion:()=>supported}),module,module.exports);
const Feature=module.exports.default;
const dirs=new Set();let failSave=false,saves=0;
const host={manifest:{id:'simple-one',dir:'.obsidian/plugins/simple-one'},settings:{enableAI:false,aiSources:[{id:'source',name:'Source',models:[{id:'one',alias:''},{id:'two',alias:'Second'}]}]},app:{vault:{adapter:{exists:async p=>dirs.has(p),mkdir:async p=>{dirs.add(p);},read:()=>assert.fail('no automatic migration')}},workspace:{getLeavesOfType:()=>[]}},saveSettings:async()=>{if(failSave)throw Error('save failed');saves++;}};
const feature=new Feature(host);await feature.initialize();assert.equal(created,0);assert.equal(feature.getTranslationModels().length,2);
let updated;assert.equal(await feature.translateSelection({sourceId:'source',modelId:'two',text:'x',prompt:'p'},undefined,t=>{updated=t;}),'译文');assert.equal(updated,'译文');assert.equal(uiStarts,0,'translation must not register the AI interface or timers');assert.equal(host.settings.enableAI,false);assert.equal(feature.core,undefined);assert.equal(created,1);
await feature.setEnabled(true);assert.equal(host.settings.enableAI,true);assert(feature.core.ui);assert.equal(created,1,'chat and translation share one request service');assert.equal(prepared,1);
const core=feature.core,catalog=host.settings.aiSources;failSave=true;await assert.rejects(core.saveData({sources:[]}),/save failed/);assert.equal(host.settings.aiSources,catalog);failSave=false;
await feature.setEnabled(false);assert.equal(core.ui,false);assert.equal(feature.core,undefined);assert.equal(host.settings.enableAI,false);assert.equal(unloaded,0,'disabling chat keeps the shared request state and usage records');
assert.equal(await feature.translateSelection({sourceId:'source',modelId:'one',text:'x',prompt:'p'}),'译文');assert.equal(uiStarts,1);assert.equal(created,1);
failStart=true;await assert.rejects(feature.setEnabled(true),/startup failed/);assert.equal(host.settings.enableAI,false);assert.equal(core.ui,false);failStart=false;
supported=false;const fresh=new Feature(host);await assert.rejects(fresh.translateSelection({sourceId:'source',modelId:'one',text:'x',prompt:'p'}),/1.11.4/);supported=true;
const cancelled=new AbortController();cancelled.abort();await assert.rejects(feature.translateSelection({sourceId:'source',modelId:'one',text:'x',prompt:'p'},cancelled.signal),e=>e.name==='AbortError');
hold=true;const ready=new Promise(resolve=>{entered=resolve;});const pending=feature.translateSelection({sourceId:'source',modelId:'one',text:'x',prompt:'p'});await ready;feature.unload();await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(unloaded,1);assert.equal(feature.children.length,0);
assert(saves>=2);delete globalThis.aiCoreMock;
console.log('AI runtime: off-switch translation, no UI/background startup, shared service/usage state, enable/disable, save rollback, startup failure, version guard and unload cancellation passed.');
