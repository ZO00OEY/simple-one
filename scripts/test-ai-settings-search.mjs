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
function searchEntry(items, query, path = []) {
  for (const item of items) {
    if (typeof item.visible === 'function' && !item.visible()) continue;
    if (item.type === 'page' || item.type === 'group') {
      const found = searchEntry(item.items ?? [], query, item.type === 'page' ? [...path, item.name] : path);
      if (found) return found;
    } else if ([item.name, ...(item.aliases ?? [])].some(text => text.toLowerCase().includes(query.toLowerCase()))) return {definition: item, path};
  }
}
function activateNativeSearchResult(tab, result) {
  // Obsidian navigateToSearchResult opens pagePath and scrolls to a definition.
  // It never invokes definition.action when a search result is clicked.
  renderNativePage(tab, result.path);
  assert(nativeContent.isConnected, 'search must render into the actual attached native page');
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
const index = definitions.find(item => item.type === 'page' && item.name === 'AI 设置索引');
assert(index, 'the registered host must provide an actual native search index');
assert.deepEqual(index.items.slice(1).map(item => item.name), ['AI 模型与 API 来源', 'AI 技能库', 'AI 自动记忆', 'AI 自动压缩', 'AI Token 用量统计']);
assert(index.items.slice(1).every(item => item.type === 'page' && item.items[0].render), 'every indexed AI topic must contain real settings');
// Indexing must use only fixed labels, even if providers or secrets are unavailable.
Object.defineProperty(host.settings, 'aiSources', {get() { assert.fail('search indexing must not inspect private provider settings'); }});
assert.doesNotThrow(() => tab.getSettingDefinitions());
const heading = () => nativeContent.querySelector('.simple-ai-page-heading .setting-item-name')?.textContent;
const destinations = ['API 来源', '技能库', '自动记忆', '自动压缩设置', 'Token 用量统计'];
for (const [position, item] of index.items.slice(1).entries()) {
  assert.equal(item.visible(), true);
  const result = searchEntry(tab.getSettingDefinitions(), item.name);
  assert.equal(typeof result.definition.render, 'function');
  activateNativeSearchResult(tab, result);
  assert.equal(heading(), destinations[position], `native search result ${item.name} must open its matching existing child page`);
  assert.equal(subscriptions, position === 2 ? 1 : 0, 'changing pages must clean up the previous memory status subscription');
}
const memoryResult = searchEntry(tab.getSettingDefinitions(), 'memory');
activateNativeSearchResult(tab, memoryResult);
assert.equal(subscriptions, 1);
renderNativePage(tab, []);
assert.equal(subscriptions, 1, 'the original AI tab may retain its memory subpage');
renderNativePage(tab, ['AI 设置索引']);
assert.equal(subscriptions, 0, 'leaving the custom overview for a native page must clean up its embedded status');
activateNativeSearchResult(tab, memoryResult);
tab.hide(); tab.hide();
assert.equal(subscriptions, 0, 'hiding the host must clean up the embedded panel exactly once');

host.settings.enableAI = false;
assert(index.items.slice(1).every(item => item.visible() === false), 'disabled AI children must leave native search');
assert.equal(searchEntry(tab.getSettingDefinitions(), 'memory'), undefined);
// A stale result from before the toggle must use the current state, without starting AI.
activateNativeSearchResult(tab, memoryResult);
assert(nativeContent.textContent.includes('AI 尚未启用'));
assert.equal(subscriptions, 0);
assert.deepEqual(index.items[0].control, {type: 'toggle', key: 'enableAI'});
assert.equal(tab.getControlValue('enableAI'), false);
let explicitToggles = 0;
ai.setEnabled = async value => { explicitToggles++; host.settings.enableAI = value; };
renderNativePage(tab, ['AI 设置索引']);
await tab.setControlValue('enableAI', true);
assert.equal(explicitToggles, 1, 'only the explicit native toggle may enable AI');
assert.equal(tab.getControlValue('enableAI'), true);
assert(searchEntry(tab.getSettingDefinitions(), 'memory'));
ai.stop(false);
const stoppedPanel = el(doc.body, 'div');
ai.renderInto(stoppedPanel, 'memory');
assert(stoppedPanel.textContent.includes('AI 尚未启动'), 'an unavailable runtime must show its existing fallback without starting it');
ai.settingsTab = new ApiSettingsTab(aiPlugin);

const updatesBeforeLegacy = nativeUpdates;
for (const cleanup of cleanups.splice(0)) cleanup();
doc.body.append(tab.containerEl);
for (version of ['1.7.2', '1.11.4']) {
  host.settings.enableAI = version === '1.11.4';
  tab.displayPreviewTab = host.settings.enableAI ? 'ai' : 'basic';
  assert.equal(tab.getSettingDefinitions().length, 1, 'new native index is guarded on old Obsidian');
  tab.display();
  assert.equal(nativeUpdates, updatesBeforeLegacy);
  assert.equal(tab.containerEl.querySelector('[role="tab"][aria-selected="true"]').textContent, host.settings.enableAI ? 'AI' : '拓展');
}
tab.hide();
assert.equal(subscriptions, 0);
assert.equal(writes, 2, 'navigation only remembers selected host tabs; no AI configuration or API writes occur');
console.log('AI settings search: real native page-path semantics, attached child-page rendering, fixed private-data-free index, explicit toggle, disabled/stale results, legacy display and cleanup passed.');
