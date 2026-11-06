import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import {settingsUI} from './fixtures/settings-ui.mjs';

const require = createRequire(import.meta.url);
const {window, doc, obsidian, el} = settingsUI();
globalThis.ResizeObserver = class {observe() {} disconnect() {}};
const compiled = await build({stdin: {contents: 'export {ModelPopover} from "./modules/ai/src/agent/modelPopover"; export {ApiSettingsTab} from "./modules/ai/src/api/settings"; export {defaults} from "./modules/ai/src/api/types";', resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'cjs', write: false, external: ['obsidian']});
const module = {exports: {}};
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(name => name === 'obsidian' ? obsidian : require(name), module, module.exports);
const {ModelPopover, ApiSettingsTab, defaults} = module.exports;
const aiSource = fs.readFileSync('modules/ai/styles.css', 'utf8');
const hostSource = fs.readFileSync('styles.css', 'utf8').replace(/\/\* Built-in AI styles \*\/[\s\S]*?\/\* End built-in AI styles \*\//, '');
const css = postcss.parse('button.mod-warning { color: var(--text-error); }\n' + hostSource + '\n' + aiSource);
assert(!aiSource.includes(':not(.simple-shared-setting)'), 'AI settings all use shared Setting');
assert(!aiSource.includes('button:not(.simple-action-button)'), 'AI ButtonComponent rules must reach shared buttons');

// Compare actual host + module selectors, including specificity, order and !important.
// Pseudo-state markers let the same DOM cover hover/focus without screenshot automation.
function specificity(node) {
  let score = [0, 0, 0];
  const add = value => {score = score.map((n, i) => n + value[i]);};
  for (const item of node.nodes ?? []) {
    if (item.type === 'id') add([1, 0, 0]);
    else if (item.type === 'class' || item.type === 'attribute') add([0, 1, 0]);
    else if (item.type === 'tag') add([0, 0, 1]);
    else if (item.type === 'pseudo') {
      if (item.value === ':where') continue;
      if (item.value.startsWith('::')) add([0, 0, 1]);
      else if ([':is', ':not', ':has'].includes(item.value)) add(item.nodes.map(specificity).sort(compare).at(-1) ?? [0, 0, 0]);
      else add([0, 1, 0]);
    }
  }
  return score;
}
function compare(a, b) {for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0;}
const rules = [];
css.walkRules(rule => {
  if (rule.parent.type === 'atrule' && /keyframes/.test(rule.parent.name)) return;
  const selectors = selectorParser().astSync(rule.selector);
  selectors.each(selector => {
    const rank = specificity(selector);
    selector.walkPseudos(pseudo => {
      if ([':hover', ':focus', ':focus-visible', ':active'].includes(pseudo.value)) pseudo.replaceWith(selectorParser.className({value: 'css-' + pseudo.value.slice(1)}));
    });
    rules.push({rule, selector: selector.toString(), rank});
  });
});
function declaration(element, property, width = 900) {
  let best;
  for (const entry of rules) {
    let enabled = true;
    for (let parent = entry.rule.parent; parent; parent = parent.parent) {
      if (parent.type !== 'atrule' || !['media', 'container'].includes(parent.name)) continue;
      const max = /max-width:\s*(\d+)px/.exec(parent.params);
      if (max && width > Number(max[1])) enabled = false;
      const min = /min-width:\s*(\d+)px/.exec(parent.params);
      if (min && width < Number(min[1])) enabled = false;
    }
    if (!enabled) continue;
    let matches = false;
    try {matches = element.matches(entry.selector);} catch {continue;}
    if (!matches) continue;
    entry.rule.walkDecls(decl => {
      if (decl.prop !== property && !(property === 'border-color' && decl.prop === 'border')) return;
      const rank = [Number(Boolean(decl.important)), ...entry.rank];
      if (!best || compare(rank, best.rank) >= 0) best = {value: decl.value, rank, selector: entry.selector};
    });
  }
  return best?.value;
}
let saves = 0;
const plugin = {app: {}, settings: defaults(), runtime: {busy: false, memoryBusy: false, userActive() {}, save: async () => {saves++;}}, cooperation: {busy: false}, update: async () => {}};
plugin.settings.sources = [{id: 'one', name: 'Source', models: [{id: 'alpha', alias: 'Alpha'}, {id: 'beta', alias: 'Beta'}]}];
const chat = el(doc.body, 'div', {cls: 'simple-ai-chat'});
const anchor = el(chat, 'button');
const session = {permission: 'auto', selected: {sourceId: 'one', modelId: 'alpha'}};
const popover = new ModelPopover(plugin, chat, anchor, session, () => {}, () => {});
const models = [...chat.querySelectorAll('.simple-ai-group-model')];
assert.equal(models.length, 2);
assert(models.every(button => button.classList.contains('simple-action-button--text')));
assert.equal(declaration(models[0], 'width'), '100%', 'model rows fill the popover despite shared text-button sizing');
for (const button of [models[0], chat.querySelector('.simple-ai-approval-segments button')]) {
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  const selected = declaration(button, 'background');
  assert(selected.includes('--interactive-accent'), `selected background: ${selected}; ${button.outerHTML}`);
  button.classList.add('css-hover');
  assert.equal(declaration(button, 'background'), selected, 'hover preserves selected state');
  button.disabled = true;
  assert.equal(declaration(button, 'background'), selected, 'disabled hover preserves selection');
  button.disabled = false;
  button.classList.remove('css-hover');
}
models[1].classList.add('css-hover');
assert.equal(declaration(models[1], 'background'), 'var(--background-modifier-hover)', 'unselected hover comes from the host');
models[1].disabled = true;
assert.notEqual(declaration(models[1], 'background'), 'var(--background-modifier-hover)', 'disabled controls do not hover');
models[1].disabled = false;
const full = chat.querySelector('.simple-ai-no-approval');
full.click();
assert.equal(session.permission, 'full');
assert.equal(full.getAttribute('aria-pressed'), 'true');
full.classList.add('css-hover');
assert.equal(declaration(full, 'color'), 'var(--text-error)', 'no-approval warning remains visible when selected and hovered');
models[1].click();
assert.equal(session.selected.modelId, 'beta');
assert.equal(saves, 2);
popover.close();
const messageActions = el(chat, 'div', {cls: 'simple-ai-message-actions'});
for (const warningClass of ['mod-warning', 'mod-destructive', 'simple-action-button--danger']) {
  const button = el(messageActions, 'button', {cls: `simple-action-button simple-action-button--text ${warningClass}`});
  const expected = warningClass === 'simple-action-button--danger' ? 'var(--text-on-accent)' : 'var(--text-error)';
  assert.equal(declaration(button, 'color'), expected, `${warningClass} keeps its dangerous-action color`);
  button.classList.add('css-hover');
  assert.equal(declaration(button, 'color'), expected);
  if (warningClass === 'mod-destructive') {
    assert.equal(declaration(button, 'background'), 'var(--background-modifier-error-hover)');
    button.disabled = true;
    assert.notEqual(declaration(button, 'background'), 'var(--background-modifier-error-hover)');
  }
}

const settingsHost = el(doc.body, 'div');
new ApiSettingsTab(plugin).renderInto(settingsHost);
for (const row of settingsHost.querySelectorAll('.setting-item')) assert(row.classList.contains('simple-shared-setting'));
for (const row of settingsHost.querySelectorAll('.simple-ai-settings-navigation')) {
  assert.equal(row.getAttribute('role'), null);
  assert.equal(row.getAttribute('tabindex'), null);
  assert(row.querySelector('button.simple-action-button'));
}
const editor = el(doc.body, 'div', {cls: 'simple-ai-editor simple-settings'});
for (const [parentClass, tabsClass, attribute] of [
  ['simple-settings simple-ai-settings', 'simple-ai-settings-tabs', 'aria-selected'],
  ['simple-ai-config-modal simple-ai-examiner', 'simple-ai-examiner-tabs', 'aria-pressed'],
]) {
  const parent = el(doc.body, 'div', {cls: parentClass});
  const tabs = el(parent, 'div', {cls: tabsClass});
  const tab = el(tabs, 'button', {cls: 'simple-action-button simple-action-button--text', attr: {[attribute]: 'true'}});
  const background = declaration(tab, 'background');
  assert(background.includes('--interactive-accent'));
  tab.classList.add('css-hover');
  assert.equal(declaration(tab, 'background'), background);
}
const form = el(editor, 'div', {cls: 'simple-ai-form'});
const input = el(form, 'input', {type: 'text'});
assert.equal(declaration(form, '--simple-ai-field-indent'), '90px');
assert.equal(declaration(form, '--simple-ai-key-label-width'), '80px');
assert.equal(declaration(form, '--simple-ai-field-indent', 400), '0px');
assert.equal(declaration(form, '--simple-ai-key-label-width', 400), '100%');
input.classList.add('css-focus');
assert.equal(declaration(input, 'border-color'), 'var(--background-modifier-border-hover)');
assert.equal(declaration(input, 'background-color'), 'var(--background-primary)');
assert.equal(declaration(input, 'box-shadow'), 'none');
input.setAttribute('aria-invalid', 'true');
assert.equal(declaration(input, 'border-color'), 'var(--text-error)');
assert.match(fs.readFileSync('modules/ai/src/agent/view.ts', 'utf8'), /styleActionButton\(more, "text"\)/);
console.log('AI style integration: real model/approval DOM, host cascade, selected/hover/disabled/warning states, input focus/error and narrow editor rules passed.');
