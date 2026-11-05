import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{window}=new JSDOM('<body></body>'),doc=window.document;
globalThis.document=doc;globalThis.window=window;
function el(parent,tag,options={}){if(typeof options==='string')options={cls:options};const e=doc.createElement(tag);if(options.cls)e.className=options.cls;if(options.text)e.textContent=options.text;if(options.type)e.type=options.type;for(const[k,v]of Object.entries(options.attr??{}))e.setAttribute(k,v);parent.append(e);return e;}
for(const[name,tag]of [['createDiv','div'],['createSpan','span']])window.HTMLElement.prototype[name]=function(o){return el(this,tag,o);};
window.HTMLElement.prototype.createEl=function(t,o){return el(this,t,o);};window.HTMLElement.prototype.empty=function(){this.replaceChildren();};window.HTMLElement.prototype.addClass=function(...c){this.classList.add(...c);};window.HTMLElement.prototype.setText=function(t){this.textContent=t;};window.HTMLElement.prototype.setAttr=function(k,v){this.setAttribute(k,v);};
class Button{constructor(parent){this.buttonEl=el(parent,'button');}setIcon(icon){this.buttonEl.dataset.icon=icon;return this;}setTooltip(t){this.buttonEl.setAttribute('aria-label',t);return this;}setButtonText(t){this.buttonEl.textContent=t;return this;}setDisabled(v){this.buttonEl.disabled=v;return this;}onClick(fn){this.buttonEl.onclick=fn;return this;}setCta(){return this;}}
class Setting{constructor(parent){this.settingEl=el(parent,'div',{cls:'setting-item'});this.infoEl=el(this.settingEl,'div');this.nameEl=el(this.infoEl,'div',{cls:'setting-item-name'});this.descEl=el(this.infoEl,'div',{cls:'setting-item-description'});this.controlEl=el(this.settingEl,'div',{cls:'setting-item-control'});}setName(n){this.nameEl.textContent=n;return this;}setDesc(n){this.descEl.textContent=n;return this;}setClass(c){this.settingEl.classList.add(c);return this;}addButton(fn){fn(new Button(this.controlEl));return this;}addExtraButton(fn){return this.addButton(fn);}addToggle(fn){let value=false;const toggle={toggleEl:el(this.controlEl,'div'),getValue:()=>value,setValue(v){value=v;return this;},onChange(){return this;},setDisabled(){return this;}};fn(toggle);return this;}addText(fn){const e=el(this.controlEl,'input');const c={inputEl:e,setValue(v){e.value=v;return this;},setPlaceholder(v){e.placeholder=v;return this;},onChange(){return this;}};fn(c);return this;}addDropdown(fn){const e=el(this.controlEl,'select');const c={selectEl:e,addOptions(o){for(const[k,v]of Object.entries(o)){const option=el(e,'option',{text:v});option.value=k;}return this;},setValue(v){e.value=v;return this;},onChange(){return this;},setDisabled(){return this;}};fn(c);return this;}}
class Base{constructor(app){this.app=app;}}
class Modal extends Base{constructor(app){super(app);this.modalEl=el(doc.body,'div');this.titleEl=el(this.modalEl,'h2');this.contentEl=el(this.modalEl,'div');}close(){} }
let domErrors=0;window.addEventListener('error',()=>{domErrors++;});
const obsidian=new Proxy({Modal,PluginSettingTab:Base,ButtonComponent:Button,Setting,setIcon:(e,i)=>{e.dataset.icon=i;},Notice:class{constructor(){assert.fail('settings rendering must not perform operations');}}},{get:(o,k)=>o[k]??Base});
const built=await build({stdin:{contents:'export {ApiSettingsTab} from "./modules/ai/src/api/settings"; export {defaults} from "./modules/ai/src/api/types";',resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian']});
const module={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(n=>n==='obsidian'?obsidian:require(n),module,module.exports);
const {ApiSettingsTab,defaults}=module.exports;
let writes=0;const plugin={app:{},settings:defaults(),runtime:{busy:false,memoryBusy:false},cooperation:{busy:false},update:async()=>{writes++;}};
const host=el(doc.body,'div'),tab=new ApiSettingsTab(plugin);tab.renderInto(host);
assert.deepEqual([...host.querySelectorAll(':scope > fieldset > legend')].map(e=>e.textContent),['模型管理','助手设置','模型协作','上下文压缩','缓存维护','用量统计']);
assert(!host.textContent.includes('基础设置'));assert(!host.textContent.includes('高级设置'));
const skills=[...host.querySelectorAll('.setting-item')].find(e=>e.querySelector('.setting-item-name')?.textContent==='Skills 库');assert.equal(skills.querySelector('.setting-item-description').textContent,'');
const compression=[...host.querySelectorAll('.simple-ai-settings-navigation')].find(e=>e.textContent.includes('自动压缩设置'));compression.click();assert(host.querySelector('h2').textContent.includes('自动压缩'));
host.querySelector('button[aria-label="返回 AI 设置"]').click();assert.equal(host.querySelectorAll(':scope > fieldset').length,6);
tab.hide();assert.equal(writes,0,'rendering and navigation never save settings or request models');assert.equal(domErrors,0,'child navigation must not throw DOM errors');
console.log('AI settings DOM: six ordered groups, no basic/advanced tabs, no Skills description, child navigation and read-only rendering passed.');
