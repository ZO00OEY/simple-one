import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url), { EditorState } = require('@codemirror/state');
const { window } = new JSDOM('<body></body>'), doc = window.document;
function create(parent, tag, options = {}) {
  const el = doc.createElement(tag); el.className = options.cls || ''; el.textContent = options.text || '';
  for (const [key, value] of Object.entries(options.attr || {})) el.setAttribute(key, value);
  parent.append(el); return el;
}
for (const [method, tag] of [['createDiv', 'div'], ['createSpan', 'span']]) window.HTMLElement.prototype[method] = function(options) { return create(this, tag, options); };
window.HTMLElement.prototype.createEl = function(tag, options) { return create(this, tag, options); };
doc.win = { createDiv: () => doc.createElement('div') };
const output = await build({ entryPoints: ['src/features/translationCards.ts'], bundle: true, format: 'cjs', platform: 'node', write: false, external: ['obsidian', '@codemirror/state', '@codemirror/view'] });
class Component { load() {} unload() {} }
const module = { exports: {} }, rendered = [];
new Function('require', 'module', 'exports', output.outputFiles[0].text)(name => name === 'obsidian' ? {
  Component, Modal: Component, Notice: Component, requireApiVersion: () => true, getLanguage: () => 'zh', MarkdownRenderChild: Component, setIcon: () => {}, MarkdownRenderer: { render: async (_app, source, el) => { rendered.push(source); el.textContent = source; } },
} : require(name), module, module.exports);
const { translationCardSource, translationCardRanges, registerTranslationCards } = module.exports;
const source = translationCardSource('original\n\ntranslation\n```js\ncode\n```');
assert(source.startsWith('````simple-translation\n'), 'nested fences remain inside the special markers');
const legacySource = '````simple-translation\noriginal\n\ntranslation\n```js\ncode\n```\n````';
const parsed = translationCardRanges(EditorState.create({ doc: legacySource }));
assert.equal(parsed.length, 1); assert.equal(parsed[0].markdown, 'original\n\ntranslation\n```js\ncode\n```');
assert.equal(translationCardRanges(EditorState.create({ doc: source })).length, 1);
const withOriginal = translationCardRanges(EditorState.create({ doc: translationCardSource('paired result', 'source text') }))[0];
assert.equal(withOriginal.original, 'source text'); assert.equal(withOriginal.markdown, 'paired result');
assert.equal(translationCardRanges(EditorState.create({ doc: '````markdown\n```simple-translation\nexample\n```\n````' })).length, 0, 'examples inside code remain code');
let field, processor;
const plugin = { app: { workspace: { getActiveFile: () => ({ path: 'note.md' }) } }, registerEditorExtension: value => { field = value; }, registerMarkdownCodeBlockProcessor: (name, handler) => { assert.equal(name, 'simple-translation'); processor = handler; } };
registerTranslationCards(plugin);
let state = EditorState.create({ doc: '```simple-translation\noriginal\n\ntranslation\n```', extensions: [field] });
assert.equal(state.field(field).decorations.size, 1, 'opening persisted source immediately renders a card');
let widget;
state.field(field).decorations.between(0, state.doc.length, (_from, _to, value) => { widget = value.spec.widget; });
const view = { dom: doc.body, get state() { return state; }, focus() {}, requestMeasure() {}, dispatch: spec => { state = state.update(spec).state; } };
const element = widget.toDOM(view); doc.body.append(element);
assert(element.querySelector('.simple-inline-translation-card'));
element.querySelector('button').click(); assert.equal(state.field(field).expanded.size, 1, 'source button exposes editable original Markdown');
element.querySelector('[aria-label="转为普通文字"]').click();
assert.equal(state.doc.toString(), 'original\n\ntranslation', 'text conversion removes all card markers');
let requested;
plugin.settings = { enhancements: { quickFormat: { translation: { sourceId: 'test', modelId: 'test' } } } };
plugin.app.plugins = { plugins: { 'simple-ai': {
  getTranslationModels: () => [{ sourceId: 'test', modelId: 'test' }],
  translateSelection: async input => { requested = JSON.parse(input.text); return '[{"id":1,"translation":"fresh result"}]'; },
} } };
state = EditorState.create({ doc: translationCardSource('original\n\nold result', 'original'), extensions: [field] });
state.field(field).decorations.between(0, state.doc.length, (_from, _to, value) => { widget = value.spec.widget; });
widget.toDOM(view).querySelector('[aria-label="重新翻译"]').click();
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(requested, [{ id: 1, text: 'original' }], 'refresh translates the saved original rather than previous bilingual output');
assert.equal(translationCardRanges(state)[0].markdown, 'original\n\nfresh result');
const reading = doc.body.createDiv(); await processor('original\n\ntranslation', reading, { sourcePath: 'note.md', addChild() {} });
assert(reading.querySelector('.simple-inline-translation-card'), 'reading mode uses the same card shell');
assert.equal(reading.querySelector('.simple-saved-translation-content').textContent, 'original\n\ntranslation');
console.log('Saved translation cards: safe markers, reload rendering, legacy compatibility, source editing and reading renderer passed.');
