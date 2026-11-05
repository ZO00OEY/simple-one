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
