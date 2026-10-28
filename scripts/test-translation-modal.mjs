import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {JSDOM} from 'jsdom';
const {window}=new JSDOM('<body></body>');
const doc=window.document;
window.HTMLElement.prototype.createEl=function(tag,options={}){const el=doc.createElement(tag);if(options.text)el.textContent=options.text;if(options.cls)el.className=options.cls;this.append(el);return el;};
window.HTMLElement.prototype.setText=function(value){this.textContent=value;};
window.HTMLElement.prototype.empty=function(){this.replaceChildren();};
class Modal {
 constructor(app){this.app=app;this.titleEl=doc.createElement('h2');this.contentEl=doc.createElement('div');}
 open(){doc.body.append(this.contentEl);this.onOpen();}
 close(){this.onClose();this.contentEl.remove();}
}
class Setting {
 constructor(parent){this.parent=parent;}
 addButton(callback){const el=this.parent.createEl('button');const button={setButtonText(value){el.textContent=value;return button;},setCta(){return button;},onClick(fn){el.addEventListener('click',fn);return button;}};callback(button);return this;}
}
const bundled=await build({entryPoints:['src/features/selectionTranslation.ts'],bundle:true,format:'cjs',platform:'node',write:false,external:['obsidian']});
const module={exports:{}};
const require=createRequire(import.meta.url);
new Function('require','module','exports',bundled.outputFiles[0].text)(name=>name==='obsidian'?{Modal,Setting,Notice:class{}}:require(name),module,module.exports);
const {SelectionTranslationModal}=module.exports;
let resolveReply,requestSignal;
const bridge={getTranslationModels:()=>[{sourceId:'source',modelId:'model',label:'Model'}],translateSelection:(_input,signal)=>{requestSignal=signal;return new Promise(resolve=>{resolveReply=resolve;});}};
const cleanups=[];
const plugin={app:{plugins:{plugins:{'simple-ai':bridge}}},register:callback=>cleanups.push(callback),settings:{enhancements:{quickFormat:{translation:{sourceId:'source',modelId:'model',prompt:'Translate',preset:'parallel'}}}}};
let insertions=0;
const first=new SelectionTranslationModal(plugin,'First.',()=>{insertions++;return true;});first.open();
first.close();assert(requestSignal.aborted,'closing the modal aborts the request');
resolveReply('[{"id":1,"translation":"第一段。"}]');await Promise.resolve();await Promise.resolve();
assert(!doc.querySelector('.simple-selection-translation-result'),'late result is discarded after close');
const second=new SelectionTranslationModal(plugin,'Second.',()=>{insertions++;return true;});second.open();
resolveReply('[{"id":1,"translation":"第二段。"}]');await Promise.resolve();await Promise.resolve();
assert(doc.querySelector('.simple-selection-translation-result'),'active result is shown for preview');
assert.equal(cleanups.length,1,'reopening translation does not accumulate plugin unload callbacks');
cleanups[0]();assert(requestSignal.aborted);assert(!second.contentEl.isConnected,'plugin unload closes the preview');assert.equal(insertions,0);
window.close();console.log('Translation modal: close/unload cancellation, late results and bounded cleanup registration passed.');
