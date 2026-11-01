import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { EditorState } from "@codemirror/state";

const output = await build({ entryPoints: ["src/features/typography.ts"], bundle: true,
  format: "cjs", platform: "node", write: false,
  external: ["obsidian", "@codemirror/state", "@codemirror/view", "@codemirror/language"] });
const module = { exports: {} };
new Function("require", "module", "exports", output.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { latinSpacingDecorations, decorateRenderedLatinSpacing } = module.exports;
const text = "中文 Hello 123，world!\n下一行 ABC。";
const state = EditorState.create({ doc: text });
const marked = [];
latinSpacingDecorations({ state, visibleRanges: [{ from: 0, to: text.length }] })
  .between(0, text.length, (from, to) => marked.push(text.slice(from, to)));
assert.deepEqual(marked, [" Hello 123", "world!", " ABC"]);
const doc = new JSDOM('<div id="root"><p>中文 Hello <strong>world</strong> 123，标点。</p><pre><code>code ABC</code></pre><p><code>inline ABC</code><a href="#">link</a></p></div>').window.document;
const root = doc.querySelector("#root");
doc.win = { createFragment: () => doc.createDocumentFragment(), createSpan: () => doc.createElement("span") };
globalThis.createFragment = () => doc.createDocumentFragment();
const original = root.textContent;
decorateRenderedLatinSpacing(root);
const html = root.innerHTML;
decorateRenderedLatinSpacing(root);
assert.equal(root.innerHTML, html, "repeated refresh must not nest spans");
assert.equal(root.textContent, original);
assert.equal(root.querySelectorAll("code .simple-latin-spacing").length, 0);
assert.equal(root.querySelector("strong .simple-latin-spacing").textContent, "world");
assert.equal(root.querySelector("a .simple-latin-spacing").textContent, "link");
assert.ok([...root.querySelectorAll(".simple-latin-spacing")].every(span => !/[中文，。]/.test(span.textContent)));
console.log("Latin spacing: mixed text, editor ranges, markup, code exclusions and repeat rendering passed.");
