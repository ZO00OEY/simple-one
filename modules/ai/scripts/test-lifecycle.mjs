import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {build} from 'esbuild';
const built=await build({entryPoints:['src/main.ts'],bundle:true,format:'cjs',platform:'browser',write:false,external:['obsidian']});
const obsidian=new Proxy({Notice:class{constructor(){assert.fail('cancelled startup must not report an error');}}},{get:(o,k)=>o[k]??class{}});
const context=vm.createContext({module:{exports:{}},require:()=>obsidian,crypto:webcrypto,console});
vm.runInContext(built.outputFiles[0].text,context);
const Plugin=context.module.exports.default;
for(const stage of ['catalogue','sessions']){
 let release,reached;const ready=new Promise(resolve=>{reached=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 let stopped=0;
 const plugin=Object.create(Plugin.prototype);
 Object.assign(plugin,{active:true,manifest:{dir:'.obsidian/plugins/simple-one/private/ai'},app:{vault:{adapter:{exists:async()=>false}}},loadData:async()=>{if(stage==='catalogue'){reached();await gate;}return {sources:[]};},runtime:{stop(){stopped++;},load:async()=>{assert.equal(stage,'sessions');reached();await gate;}},cooperation:{stop(){stopped++;},load:async()=>assert.fail('unloaded runtime must not start further initialization')},update:()=>assert.fail('unloaded runtime must not write settings')});
 const starting=plugin.start();await ready;plugin.onunload();release();await starting;
 assert.equal(stopped,2);assert.equal(plugin.active,false);
}
console.log('AI startup cancellation: unloading during catalogue/session reads cannot register background tasks or save stale settings.');

{
 const plugin=Object.create(Plugin.prototype);let reads=0;
 Object.assign(plugin,{active:true,manifest:{dir:'.obsidian/plugins/simple-one/private/ai'},app:{vault:{adapter:{exists:async()=>false}}},loadData:async()=>({sources:[]}),runtime:{load:async()=>{reads++;}},cooperation:{load:async()=>{reads++;},initializeTraffic:async()=>{}},update:async()=>{},addChild(){assert.fail('request-only preparation must not create an interface plugin');}});
 await plugin.prepareRequests();await plugin.prepareRequests();assert.equal(reads,2,'request state initializes once, with no interface, note events, ribbon or timers');
}
console.log('Request-only initialization is reusable and does not start the AI interface or background work.');

// Turning off the interface while shared request preparation is pending must cancel that UI start.
{
 let release;const gate=new Promise(resolve=>{release=resolve;});
 const plugin=Object.create(Plugin.prototype);
 Object.assign(plugin,{active:true,uiGeneration:0,prepareRequests:()=>gate,runtime:{stop(){}},cooperation:{stop(){}},addChild:()=>assert.fail('stopped startup must not register UI')});
 const starting=plugin.start();plugin.stopUI();release();await starting;
 assert.equal(plugin.ui,undefined);
}
// A background check already awaiting I/O must not start its next phase after the UI stops.
for(const stage of ['attachments','memory']) {
 let release,reached;const ready=new Promise(resolve=>{reached=resolve;});
 const pause=()=>new Promise(resolve=>{release=resolve;reached();});
 const cleanups=[],layout=[];
 const ui={registerEvent(){},registerInterval(){},registerDomEvent(){},registerView(){},addRibbonIcon(){},addCommand(){},register:fn=>cleanups.push(fn)};
 context.window={setInterval:()=>1};context.document={};
 const plugin=Object.create(Plugin.prototype);
 Object.assign(plugin,{active:true,uiGeneration:0,app:{workspace:{getActiveFile:()=>null,on(){},onLayoutReady:fn=>layout.push(fn)},vault:{on(){}}},
   prepareRequests:async()=>{},addChild:()=>ui,removeChild:()=>cleanups.forEach(fn=>fn()),
   checkAttachmentCleanup:stage==='attachments'?pause:async()=>{},
   runtime:{stop(){},checkMemory:stage==='memory'?pause:()=>assert.fail('unloaded check must not start memory')},
   cooperation:{stop(){},autoCheck:()=>assert.fail('unloaded check must not start cooperation')}});
 await plugin.start();layout[0]();await ready;plugin.stopUI();release();
 await Promise.resolve();await Promise.resolve();
}
console.log('AI UI cancellation: pending interface starts and background check continuations stop when disabled.');
