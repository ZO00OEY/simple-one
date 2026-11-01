import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const { EditorState } = require('@codemirror/state');
const { window } = new JSDOM('<body><div id="note"></div></body>');
const doc = window.document;
function create(parent, tag, options = {}) {
  const el = doc.createElement(tag);
  if (options.cls) el.className = options.cls;
  if (options.text) el.textContent = options.text;
  for (const [key, value] of Object.entries(options.attr || {})) el.setAttribute(key, value);
  parent.append(el); return el;
}
for (const [method, tag] of [['createDiv', 'div'], ['createSpan', 'span']]) window.HTMLElement.prototype[method] = function(options) { return create(this, tag, options); };
window.HTMLElement.prototype.createEl = function(tag, options) { return create(this, tag, options); };
doc.win = { createDiv: options => { const el = doc.createElement('div'); el.className = options.cls; return el; } };
const notices = [];
let supportsLanguageApi = true, languageCalls = 0, momentCalls = 0;
const bundled = await build({ stdin: { contents: 'export * from "./src/features/inlineTranslation"; export { translationLocale } from "./src/features/selectionTranslation";', resolveDir: process.cwd() }, bundle: true, format: 'cjs', platform: 'node', write: false, external: ['obsidian', '@codemirror/state', '@codemirror/view'] });
const module = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(name => name === 'obsidian' ? { setIcon: (el, name) => { el.dataset.icon = name; },
  requireApiVersion: version => { assert.equal(version, '1.8.7'); return supportsLanguageApi; },
  getLanguage: () => { languageCalls++; assert(supportsLanguageApi, 'old Obsidian must not call the missing language API'); return 'zh'; },
  moment: { locale: () => { momentCalls++; return 'en'; } },
  Modal: class {}, Notice: class { constructor(message) { notices.push(message); } } } : require(name), module, module.exports);
assert.equal(module.exports.translationLocale(), 'zh');
supportsLanguageApi = false;
assert.equal(module.exports.translationLocale(), 'en');
assert.equal(languageCalls, 1); assert.equal(momentCalls, 1);
supportsLanguageApi = true;
const { startInlineTranslation, previewRange } = module.exports;
const { translationCardMarkdown } = module.exports;
assert.equal(translationCardMarkdown('原文\n\nHello'), '```simple-translation\n原文\n\nHello\n```');
assert.deepEqual(previewRange(EditorState.create({ doc: 'prefix hello suffix' }), 7, 12), { from: 0, to: 19, prefix: 'prefix ', suffix: ' suffix' });

function fixture() {
  const node = doc.querySelector('#note'); node.replaceChildren();
  let field, value = '原文', writes = 0, finish, reject, update, signal;
  const cleanups = [];
  const cm = { dom: node, state: EditorState.create({ doc: value }), requestMeasure() {}, dispatch(spec) {
    for (const effect of Array.isArray(spec.effects) ? spec.effects : spec.effects ? [spec.effects] : []) {
      if (Array.isArray(effect.value)) field = effect.value[0];
    }
    this.state = this.state.update(spec).state;
    node.replaceChildren();
    const current = field && this.state.field(field, false);
    if (current) node.append(current.widget.toDOM());
  } };
  const editor = { cm, posToOffset: pos => pos.ch, getValue: () => value, focus() {}, replaceRange(text) { value = text; writes++; cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: text } }); } };
  const bridge = { getTranslationModels: () => [{ sourceId: 's', modelId: 'm' }], translateSelection(input, abort, onUpdate) {
    signal = abort; update = onUpdate;
    return new Promise((resolve, failure) => { finish = resolve; reject = failure; });
  } };
  const plugin = { app: { plugins: { plugins: { 'simple-ai': bridge } } }, settings: { enhancements: { quickFormat: { translation: { sourceId: 's', modelId: 'm', prompt: 'translate', languageA: '中文', languageB: '英语' } } } }, register: callback => cleanups.push(callback) };
  const selection = { view: { containerEl: node, file: { path: 'note.md' } }, editor, from: { line: 0, ch: 0 }, to: { line: 0, ch: 2 }, text: '原文', document: '原文', file: 'note.md' };
  startInlineTranslation(plugin, selection);
  return { cm, node, get signal() { return signal; }, update: text => update(text), finish: text => finish(text), fail: error => reject(error), get value() { return value; }, get writes() { return writes; }, cleanups };
}
let f = fixture();
assert.equal(f.value, '原文'); assert.equal(f.writes, 0);
assert(f.node.querySelector('.simple-inline-translation-back'));
assert.equal(f.node.querySelector('.simple-inline-translation-actions').hidden, true);
f.update('[{"id":1,"translation":"Hello');
await new Promise(resolve => setTimeout(resolve, 80));
assert.equal(f.node.querySelector('.simple-inline-translation-text').textContent, 'Hello');
assert.equal(f.writes, 0, 'streaming never changes the source');
f.finish('[{"id":1,"translation":"Hello"}]'); await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(f.node.querySelector('.simple-inline-translation-actions').hidden, false);
f.node.querySelector('.simple-inline-translation-insert-text').click();
assert.equal(f.value, '原文\n\nHello'); assert.equal(f.writes, 1);
assert.equal(f.node.children.length, 0);

f = fixture();
f.finish('[{"id":1,"translation":"Hello"}]'); await new Promise(resolve => setTimeout(resolve, 0));
f.node.querySelector('.simple-inline-translation-insert-card').click();
assert.equal(f.value, translationCardMarkdown('原文\n\nHello', '原文'));
assert.equal(f.writes, 1, 'card mode inserts persistent Markdown only on confirmation');

f = fixture(); f.node.querySelector('.simple-inline-translation-close').click();
assert(f.signal.aborted); f.finish('[{"id":1,"translation":"late"}]');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(f.writes, 0); assert.equal(f.node.children.length, 0);

f = fixture(); f.cm.dispatch({ changes: { from: 0, insert: 'changed' } });
assert(f.signal.aborted); assert.equal(f.node.children.length, 0, 'document changes remove stale previews');
f.finish('[{"id":1,"translation":"late"}]'); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(f.writes, 0);

f = fixture(); f.finish('invalid JSON'); await new Promise(resolve => setTimeout(resolve, 0));
assert(f.node.textContent.includes('翻译失败')); assert(f.node.querySelector('.simple-inline-translation-insert-text').hidden); assert.equal(f.writes, 0);
f.cleanups.forEach(callback => callback()); assert.equal(f.node.children.length, 0);
console.log('Inline translation: temporary decoration, streaming, confirm-only writes, cancellation, late replies, stale documents, validation and cleanup passed.');
