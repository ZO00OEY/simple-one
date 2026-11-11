import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {settingsUI} from './fixtures/settings-ui.mjs';

const require = createRequire(import.meta.url);
const {window, doc, obsidian, el} = settingsUI();
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
window.HTMLElement.prototype.removeClass = function(...names) { this.classList.remove(...names); };
obsidian.ButtonComponent.prototype.setClass = function(name) { this.buttonEl.classList.add(name); return this; };
let version = '1.13.0', nativeUpdates = 0, subscriptions = 0, writes = 0;
let nativePath = [], nativeContent, cleanups = [];
function renderNativePage(tab, path) {
  for (const cleanup of cleanups.splice(0)) cleanup();
  nativeContent?.remove();
  nativePath = path;
  nativeContent = path.length ? el(doc.body, 'div') : tab.containerEl;
  if (!path.length) doc.body.append(nativeContent);
  nativeContent.empty();
  let definitions = tab.getSettingDefinitions();
  for (const name of path) definitions = definitions.find(item => item.type === 'page' && item.name === name).items;
  const renderItems = items => {
    for (const item of items) {
      if (item.type === 'group') renderItems(item.items ?? []);
      else if (item.render) {
        const cleanup = item.render(new obsidian.Setting(nativeContent));
        if (cleanup) cleanups.push(cleanup);
      }
    }
  };
  renderItems(definitions);
}
obsidian.requireApiVersion = required => version.localeCompare(required, undefined, {numeric: true}) >= 0;
obsidian.PluginSettingTab.prototype.update = function() {
  assert(obsidian.requireApiVersion('1.13.0'), 'legacy display must not call the new update API');
  nativeUpdates++;
  renderNativePage(this, nativePath);
};
const built = await build({stdin: {contents: 'export {ApiSettingsTab} from "./modules/ai/src/api/settings"; export {defaults} from "./modules/ai/src/api/types";', resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'cjs', write: false, external: ['obsidian']});
const apiModule = {exports: {}};
new Function('require', 'module', 'exports', built.outputFiles[0].text)(name => name === 'obsidian' ? obsidian : require(name), apiModule, apiModule.exports);
const {ApiSettingsTab, defaults} = apiModule.exports;
assert(!(ApiSettingsTab.prototype instanceof obsidian.PluginSettingTab), 'embedded panels must not register or impersonate a second native settings tab');
const inert = new Proxy(class {}, {get: () => class {hide() {} resetNavigation() {}}});
function load(file, dependencies = {}) {
  const module = {exports: {}};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS}}).outputText;
  new Function('require', 'module', 'exports', code)(name => name === 'obsidian' ? obsidian : dependencies[name] ?? inert, module, module.exports);
  return module.exports;
}
const AiFeature = load('src/features/ai.ts', {'../../modules/ai/src/api/settings': {ApiSettingsTab}}).default;
const {SimpleSettingTab} = load('src/settings.ts', {
  './shared/settingsLayout': {settingsGroup: (parent, _title, render) => render(parent)},
});
const runtime = {busy: false, memoryBusy: false, state: {memory: {lastError: ''}, sessions: []}, subscribe() { subscriptions++; return () => { subscriptions--; }; }};
const aiPlugin = {app: {}, settings: defaults(), runtime, cooperation: {busy: false, state: {records: [], traffic: []}}, update: async () => { writes++; }};
const host = {settings: {enableAI: true, lastSettingsTab: 'ai'}, manifest: {id: 'simple-one'}, registerEvent() {}, saveSettings: async () => { writes++; }, sync: {}};
const ai = host.ai = new AiFeature(host);
ai.settingsTab = new ApiSettingsTab(aiPlugin);
ai.start = () => { assert.fail('settings search must never start the AI runtime'); };
const app = {workspace: {on() {}}, setting: {open() {}, openTabById(id) { assert.equal(id, 'simple-one'); }}};
const tab = new SimpleSettingTab(app, host);
tab.containerEl = el(doc.body, 'div');
tab.renderBasicOptimizationSettings = container => container.createEl('p', {text: '功能拓展 AI 开关'});

const definitions = tab.getSettingDefinitions();
assert.equal(definitions.length, 1, 'only the existing host settings group remains');
assert(!JSON.stringify(definitions).includes('AI 设置索引'), 'the duplicate index page is removed');
Object.defineProperty(host.settings, 'aiSources', {get() { assert.fail('rendering definitions must not inspect private provider settings'); }});
assert.doesNotThrow(() => tab.getSettingDefinitions());
renderNativePage(tab, []);
for (const [label, heading] of [
  ['API 来源', 'API 来源'], ['Skills 库', '技能库'], ['自动记忆', '自动记忆'],
  ['自动压缩设置', '自动压缩设置'], ['Token 用量统计', 'Token 用量统计'],
]) {
  const entry = [...nativeContent.querySelectorAll('.simple-ai-settings-navigation')].find(row => row.textContent.startsWith(label));
  assert(entry, label + ' remains available from the AI overview');
  entry.click();
  assert.equal(nativeContent.querySelector('.simple-ai-page-heading .setting-item-name')?.textContent, heading);
  assert.equal(subscriptions, label === '自动记忆' ? 1 : 0);
  assert.equal(nativeContent.querySelector('[role="tablist"]').style.display, 'none');
  nativeContent.querySelector('button[aria-label="返回 AI 设置"]').click();
  assert.equal(subscriptions, 0, 'returning from memory cleans up its subscription');
  assert.equal(nativeContent.querySelector('[role="tablist"]').style.display, '');
}
tab.hide(); tab.hide();
assert.equal(subscriptions, 0);
ai.stop(false);
const stoppedPanel = el(doc.body, 'div');
ai.renderInto(stoppedPanel, 'memory');
assert(stoppedPanel.textContent.includes('AI 尚未启动'));
ai.settingsTab = new ApiSettingsTab(aiPlugin);
const updatesBeforeLegacy = nativeUpdates;
for (const cleanup of cleanups.splice(0)) cleanup();
doc.body.append(tab.containerEl);
for (version of ['1.7.2', '1.11.4']) {
  host.settings.enableAI = version === '1.11.4';
  tab.displayPreviewTab = host.settings.enableAI ? 'ai' : 'basic';
  assert.equal(tab.getSettingDefinitions().length, 1);
  tab.display();
  assert.equal(nativeUpdates, updatesBeforeLegacy);
  assert.equal(tab.containerEl.querySelector('[role="tab"][aria-selected="true"]').textContent, host.settings.enableAI ? 'AI' : '拓展');
}
tab.hide();
assert.equal(subscriptions, 0);
assert.equal(writes, 2, 'navigation only remembers selected host tabs');
console.log('AI settings: duplicate index removed, existing overview destinations, cleanup and legacy navigation passed.');
