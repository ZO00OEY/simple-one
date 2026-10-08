import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const dom = new JSDOM('<div id="panel"><div></div><div></div></div>');
const prototype = dom.window.HTMLElement.prototype;
prototype.createEl = function(tag, options = {}) { const element = dom.window.document.createElement(tag); if(options.cls) element.className = options.cls; if(options.text) element.textContent = options.text; for(const [key,value] of Object.entries(options.attr || {})) element.setAttribute(key,value); this.append(element); return element; };
prototype.createDiv = function(options) { return this.createEl('div',options); };
prototype.createSpan = function(options) { return this.createEl('span',options); };
prototype.empty = function() { this.replaceChildren(); };
prototype.addClass = function(...names) { this.classList.add(...names); };
prototype.removeClass = function(...names) { this.classList.remove(...names); };
prototype.toggleClass = function(name, enabled) { this.classList.toggle(name,enabled); };
prototype.setText = function(value) { this.textContent = value; };
prototype.setAttr = function(key,value) { this.setAttribute(key,value); };
prototype.getAttr = function(key) { return this.getAttribute(key); };
const notices = [];
class ItemView { constructor(leaf) { this.app=leaf.app;this.containerEl=leaf.containerEl;this.leaf=leaf; } }
const obsidian = new Proxy({ ItemView, Platform:{isMobile:false}, Notice:class { constructor(message) { notices.push(message); } }, setIcon:()=>{},setTooltip:()=>{},addIcon:()=>{} }, { get:(target,key)=>key in target?target[key]:class {} });
const built = await esbuild.build({ entryPoints:['src/features/sync/index.ts'],bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian'],plugins:[{name:'expose-panel',setup(build){build.onLoad({filter:/features[\\/]sync[\\/]index\.ts$/}, async args=>({contents:(await readFile(args.path,'utf8'))+'\nexport { ZoeySyncView };',loader:'ts'}));}}] });
const context = vm.createContext({module:{exports:{}},require:name=>name==='obsidian'?obsidian:require(name),console,Date,setTimeout,clearTimeout});context.window=context;vm.runInContext(built.outputFiles[0].text,context);
const {default:Sync,ZoeySyncView}=context.module.exports;
let reads=0, fail=false, release;
let changes=[{path:'notes/a.md',kind:'modified'},{path:'notes/b.md',kind:'added'}];
const plugin={settings:{viewLayout:'list',lastSyncAt:Date.now(),setupComplete:true,mobile:{mode:'github'}},getPendingConflictPaths:async()=>[],getDeferredMergePaths:()=>[],getChanges:async()=>{reads++;if(release)await new Promise(resolve=>{release.resolve=resolve;});if(fail)throw Error('offline status');return changes;},getSetupActivity:()=>undefined,getSyncActivity:()=>undefined,nativeGitEnabled:()=>true,useLightweightSync:()=>false,isSyncing:()=>false,getLightweightPendingStatus:()=>undefined,getActiveSyncError:()=>undefined,getRecentErrorLogs:()=>[],saveSettings:async()=>{},syncNow:async()=>{}};
const leaf={app:{workspace:{layoutReady:true,openLinkText:()=>{}}},containerEl:dom.window.document.querySelector('#panel')};
const view=new ZoeySyncView(leaf,plugin);leaf.view=view;
plugin.refreshSyncView=async reuse=>view.render(reuse);
plugin.toggleViewLayout=()=>Sync.prototype.toggleViewLayout.call(plugin);
await view.render();assert.equal(reads,1);assert.equal(leaf.containerEl.querySelectorAll('.simple-one-sync-view__change').length,2);
assert.match(leaf.containerEl.textContent,/待同步 · 2 个文件 · 上次同步/);assert(!/Commit|Push|待上传/.test(leaf.containerEl.textContent));
await plugin.toggleViewLayout();assert.equal(reads,1,'layout switching reuses the same snapshot');assert.equal(leaf.containerEl.querySelectorAll('.simple-one-sync-view__change').length,2);assert(leaf.containerEl.querySelector('.simple-one-sync-view__group'));
changes=[{path:'notes/new.md',kind:'added'}];release={};leaf.containerEl.querySelector('[aria-label="刷新更改区"]').click();assert.match(leaf.containerEl.textContent,/正在刷新文件列表/);assert.equal(leaf.containerEl.querySelectorAll('.simple-one-sync-view__change').length,2,'keep the current list while reading');
await new Promise(resolve=>setTimeout(resolve,0));release.resolve();release=undefined;await new Promise(resolve=>setTimeout(resolve,0));assert.equal(leaf.containerEl.querySelectorAll('.simple-one-sync-view__change').length,1);assert.match(leaf.containerEl.textContent,/new.md/);assert.match(leaf.containerEl.textContent,/列表已刷新/);
fail=true;await view.render();assert.match(leaf.containerEl.textContent,/无法读取更改/);assert.equal(leaf.containerEl.querySelectorAll('.simple-one-sync-view__change').length,1,'failed refresh preserves last successful list');await plugin.toggleViewLayout();assert.match(leaf.containerEl.textContent,/无法读取更改/);
fail=false;changes=[];await view.render();assert.equal(leaf.containerEl.querySelectorAll('.simple-one-sync-view__change').length,0);assert.match(leaf.containerEl.textContent,/没有待同步文件/);assert.equal(notices.length,0);
console.log('Sync panel: unified status, stable layout, visible refresh, refreshed data and failed-read recovery passed.');
const plan = { remote:{ files:{'remote.md':{sha:'r',mode:'100644'}} }, local:{'local.md':{sha:'l',mode:'100644'}},
  uploads:['local.md'], downloads:['remote.md'], conflicts:[], localDeletes:['local.md'],remoteDeletes:[] };
const choice=view.chooseStrategy(plan);
assert.equal(leaf.containerEl.querySelectorAll('.simple-one-sync-transfer__strategies button').length,4);
assert.match(leaf.containerEl.textContent,/云端 1 个文件，本地 1 个文件/);
[...leaf.containerEl.querySelectorAll('button')].find(button=>button.textContent.includes('完全以云端为准')).click();
assert.equal(await choice,'remote');
const confirmation=view.confirmLightweightPlan(plan);
assert.match(leaf.containerEl.textContent,/删除本地 1 个/);
[...leaf.containerEl.querySelectorAll('button')].find(button=>button.textContent==='返回预览').click();
assert.equal(await confirmation,false);
const cancelled=view.chooseStrategy(plan);await view.onClose();assert.equal(await cancelled,null);
view.closed=false;
const taskEngine={downloadTask:{mode:'manual',downloads:1500,total:2000},downloadUrl:'https://github.com/example/vault/archive/fixed.zip',remaining:3500};
plugin.getMobileGithub=()=>taskEngine;plugin.useLightweightSync=()=>true;plugin.nativeGitEnabled=()=>false;
await view.render();
assert(leaf.containerEl.querySelector('[aria-label="整库下载待办尚未完成"]'));
await view.showDownloadTask();
assert.match(leaf.containerEl.textContent,/1500|1,500/);assert.match(leaf.containerEl.textContent,/75.0%/);
assert.equal(leaf.containerEl.querySelector('.simple-one-sync-transfer__download a').getAttribute('href'),taskEngine.downloadUrl);
assert([...leaf.containerEl.querySelectorAll('button')].some(button=>button.textContent==='选择 ZIP 并导入'));
assert([...leaf.containerEl.querySelectorAll('button')].some(button=>button.textContent==='确认重置进度'));
[...leaf.containerEl.querySelectorAll('button')].find(button=>button.textContent==='稍后处理，返回文件列表').click();
await new Promise(resolve=>setTimeout(resolve,0));
assert(!leaf.containerEl.querySelector('.simple-one-sync-transfer'));assert(leaf.containerEl.querySelector('.simple-one-sync-download-alert'));
taskEngine.downloadTask=undefined;await view.render();assert(!leaf.containerEl.querySelector('.simple-one-sync-download-alert'));
console.log('Sync flow panel: strategy/deletion confirmation, cancelled steps, persistent download badge, fixed link and resume page passed.');
assert.equal(view.getDisplayText(), '同步与分享');
let shareSwitches = 0, settingsOpens = 0;
plugin.host = { share: { open: async () => { shareSwitches++; } } };
plugin.openPluginSettings = () => { settingsOpens++; };
plugin.settings.enabled = false;
const readsBeforeDisabled = reads;
await view.render();
assert.equal(reads, readsBeforeDisabled, 'disabled sync panel must not read repository changes');
assert.match(leaf.containerEl.textContent, /同步已关闭/);
leaf.containerEl.querySelector('[aria-label="切换到分享"]').click();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(shareSwitches, 1, 'sharing remains reachable when sync is disabled');
[...leaf.containerEl.querySelectorAll('button')].find(button => button.textContent === '打开同步设置').click();
assert.equal(settingsOpens, 1);
let switchedType, revealed = 0;
const restoredShareLeaf = { setViewState: async state => { switchedType = state.type; } };
await Sync.prototype.openSyncView.call({
  settings: { enabled: false },
  app: { workspace: {
    getLeavesOfType: type => type === 'simple-one-share' ? [restoredShareLeaf] : [],
    getRightLeaf: () => { throw Error('must reuse the shared tab'); },
    revealLeaf: async () => { revealed++; },
  } },
}, false, false);
assert.equal(switchedType, 'simple-one-sync-view', 'default entry replaces a restored sharing page with sync');
assert.equal(revealed, 0, 'startup must preserve the active workspace pane');
console.log('Shared panel: unified title, sync default, disabled sync entry and sharing switch passed.');
