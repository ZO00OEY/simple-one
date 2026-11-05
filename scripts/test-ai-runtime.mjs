import assert from 'node:assert/strict';
import {build} from 'esbuild';
let supported=true,created=0,stopped=0,failStart=false;
class Component{constructor(){this.children=[];}load(){this.onload?.();}unload(){this.onunload?.();for(const c of this.children)c.unload();this.children=[];}addChild(c){this.children.push(c);c.load();return c;}removeChild(c){c.unload();this.children=this.children.filter(x=>x!==c);return c;}}
class Core extends Component{constructor(app,manifest){super();created++;this.app=app;this.manifest=manifest;}async start(){if(failStart)throw Error('startup failed');}onunload(){stopped++;}}
globalThis.aiCoreMock=Core;
const bundled=await build({entryPoints:['src/features/ai.ts'],bundle:true,format:'cjs',platform:'node',write:false,external:['obsidian'],plugins:[{name:'mock-core',setup(b){b.onResolve({filter:/modules\/ai\/src\/(main|api\/settings|agent\/view)$/},args=>({path:args.path,namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:args.path.endsWith('/main')?'export default globalThis.aiCoreMock;':args.path.endsWith('/settings')?'export class ApiSettingsTab {hide(){}renderInto(){}}':'export const CHAT_VIEW="simple-one-ai-chat";'}));}}]});
const module={exports:{}};new Function('require','module','exports',bundled.outputFiles[0].text)(()=>({Component,requireApiVersion:()=>supported}),module,module.exports);
const Feature=module.exports.default;
const dirs=new Set();let failSave=false,saves=0;
const host={manifest:{id:'simple-one',dir:'.obsidian/plugins/simple-one'},settings:{enableAI:false,aiSources:[]},app:{vault:{adapter:{exists:async p=>dirs.has(p),mkdir:async p=>{dirs.add(p);},read:()=>assert.fail('enabling AI must not read standalone data')}},workspace:{getLeavesOfType:()=>[]}},saveSettings:async()=>{if(failSave)throw Error('save failed');saves++;}};
const feature=new Feature(host);await feature.initialize();assert.equal(created,0,'disabled AI starts no runtime');
await feature.setEnabled(true);assert.equal(host.settings.enableAI,true);assert(feature.core);assert.equal(created,1);
assert.deepEqual(await feature.core.loadData(),{sources:[]});
const catalog=[{id:'source',models:[]}];await feature.core.saveData({sources:catalog});assert.equal(host.settings.aiSources,catalog);
failSave=true;await assert.rejects(feature.core.saveData({sources:[]}),/save failed/);assert.equal(host.settings.aiSources,catalog,'failed catalogue writes restore the saved configuration');failSave=false;
await feature.setEnabled(false);assert.equal(stopped,1);assert.equal(feature.core,undefined);assert.equal(host.settings.enableAI,false);
failStart=true;await assert.rejects(feature.setEnabled(true),/startup failed/);assert.equal(feature.core,undefined);assert.equal(host.settings.enableAI,false);assert.equal(feature.children.length,0);failStart=false;
supported=false;const count=created;await assert.rejects(feature.setEnabled(true),/1.11.4/);assert.equal(created,count);supported=true;
assert(saves>=3);delete globalThis.aiCoreMock;
console.log('AI runtime: disabled startup, enable/disable cleanup, isolated catalogue, save rollback, failed-start cleanup, version guard and no automatic migration passed.');
