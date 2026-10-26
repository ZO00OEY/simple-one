import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { EditorState } from "@codemirror/state";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["document", "HTMLElement", "HTMLPreElement", "DOMParser", "NodeFilter"]) {
  globalThis[key] = key === "document" ? dom.window.document : dom.window[key];
}
dom.window.HTMLElement.prototype.instanceOf = function (type) { return this instanceof type; };
globalThis.createFragment = () => document.createDocumentFragment();
globalThis.createEl = tag => document.createElement(tag);
globalThis.createDiv = () => document.createElement("div");
globalThis.createSpan = () => document.createElement("span");
const output = await build({
  entryPoints: ["src/features/htmlPreview.ts"], bundle: true, format: "cjs",
  platform: "node", write: false,
  external: ["obsidian", "@codemirror/state", "@codemirror/view"],
});
const notices = [];
const module = { exports: {} };
const require = createRequire(import.meta.url);
new Function("require", "module", "exports", output.outputFiles[0].text)(
  (name) => name === "obsidian" ? { Notice: class { constructor(message) { notices.push(message); } } } : require(name), module, module.exports);
const { buildHtmlDecorations, refreshRenderedHtmlPreviews } = module.exports;
const rule = { id: "test", enabled: true, name: "Test", pattern: "TOKEN", flags: "g", replaceWith: "replacement" };
const source = "TOKEN\n\n```html\n<b>original</b>\n```";
const state = EditorState.create({ doc: source });
assert.equal(buildHtmlDecorations(state, false, new Set(), []).size, 0);
assert.equal(buildHtmlDecorations(state, false, new Set(), [rule]).size, 1);
assert.equal(buildHtmlDecorations(state, true, new Set(), []).size, 1);
assert.equal(buildHtmlDecorations(state, true, new Set(), [rule]).size, 2);
assert.equal(state.doc.toString(), source);
const root = document.createElement("div");
root.className = "markdown-rendered";
root.innerHTML = '<p>TOKEN</p><pre><code class="language-html">&lt;b&gt;original&lt;/b&gt;</code></pre>';
const original = root.innerHTML;
refreshRenderedHtmlPreviews(root, false, [rule]);
assert.equal(root.querySelector("p").textContent, "replacement");
assert.equal(root.querySelectorAll(".simple-html-preview").length, 0);
refreshRenderedHtmlPreviews(root, false, [{ ...rule, replaceWith: "<strong>rendered</strong><script>bad()</script>" }]);
assert.equal(root.querySelector("p strong").textContent, "rendered");
assert.equal(root.querySelector("script"), null);
refreshRenderedHtmlPreviews(root, true, []);
assert.equal(root.querySelector("p").textContent, "TOKEN");
assert.equal(root.querySelectorAll(".simple-html-preview").length, 1);
refreshRenderedHtmlPreviews(root, false, []);
assert.equal(root.innerHTML, original);
console.log("Display replacement tests passed.");

let widget;
buildHtmlDecorations(state, true, new Set(), []).between(0, source.length, (_from, _to, decoration) => { widget = decoration.spec.widget; });
assert(widget);
let clipboardResolve;
let clipboardReject;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: () => new Promise((resolve, reject) => { clipboardResolve = resolve; clipboardReject = reject; }) } } });
const view = { state, dispatch(change) { this.state = this.state.update(change).state; } };
const rendered = widget.toDOM(view);
const cut = [...rendered.querySelectorAll('button')].find(button => button.textContent === '剪贴');
const beginCut = () => cut.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true, cancelable: true }));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
beginCut();
view.state = view.state.update({ changes: { from: 0, insert: 'new edit\n' } }).state;
const edited = view.state.doc.toString();
clipboardResolve(); await settle();
assert.equal(view.state.doc.toString(), edited, 'clipboard wait must not delete content at stale offsets');
assert(notices.at(-1).includes('未删除'));
view.state = state;
beginCut(); clipboardReject(new Error('permission denied')); await settle();
assert.equal(view.state.doc.toString(), source, 'clipboard failure preserves HTML');
beginCut(); clipboardResolve(); await settle();
assert(!view.state.doc.toString().includes('<b>original</b>'), 'unchanged document still supports cut');
console.log('HTML cut: changed notes and clipboard failures preserve content; unchanged notes cut normally.');
