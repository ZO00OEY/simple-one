import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<body></body>");
window.HTMLElement.prototype.createEl = function(tag, options = {}) {
  const element = window.document.createElement(tag);
  if (options.cls) element.className = options.cls;
  if (options.text) element.textContent = options.text;
  for (const [key, value] of Object.entries(options.attr || {})) element.setAttribute(key, value);
  this.appendChild(element);
  return element;
};
window.HTMLElement.prototype.createDiv = function(options) { return this.createEl("div", options); };
window.HTMLElement.prototype.setText = function(text) { this.textContent = text; };
const source = await readFile("src/features/attachmentOrganizer.ts", "utf8");
const result = await build({
  stdin: { contents: source + "\nexport { attachmentModalActions, applyAttachmentMoves };", loader: "ts", resolveDir: "src/features" },
  bundle: true, platform: "node", format: "cjs", write: false, external: ["obsidian"],
  plugins: [{ name: "mock-confirm", setup(builder) {
    builder.onResolve({ filter: /shared\/confirm$/ }, () => ({ path: "confirm", namespace: "test" }));
    builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export async function confirmAction() { return globalThis.accept; }" }));
  } }],
});
const notices = [];
const context = vm.createContext({ module: { exports: {} }, document: window.document, accept: true, Error,
  require: () => ({ Modal: class {}, Notice: class { constructor(text) { notices.push(text); } }, setIcon() {}, normalizePath: path => path.replace(/\\/g, "/") }),
});
vm.runInContext(result.outputFiles[0].text, context);
const { attachmentModalActions, applyAttachmentMoves } = context.module.exports;
const contentEl = window.document.body.createDiv();
let closed = 0;
const modal = { contentEl, close() { closed++; } };
const items = [{ checked: true }, { checked: false }];
for (const item of items) {
  const input = contentEl.createEl("label", { cls: "simple-attachment-row" }).createEl("input", { attr: { type: "checkbox" } });
  input.checked = item.checked;
}
let calls = 0, finish;
attachmentModalActions(modal, items, "执行", () => { calls++; return new Promise(resolve => { finish = resolve; }); });
const [all, invert, cancel, execute] = contentEl.querySelectorAll("button");
const checked = () => [...contentEl.querySelectorAll("input")].map(input => input.checked);
all.click(); assert.deepEqual(items.map(item => item.checked), [true, true]); assert.deepEqual(checked(), [true, true]);
invert.click(); assert.deepEqual(items.map(item => item.checked), [false, false]); assert.deepEqual(checked(), [false, false]);
cancel.click(); assert.equal(closed, 1); assert.equal(calls, 0);
execute.click(); execute.click(); assert.equal(calls, 1); assert.equal(execute.disabled, true);
finish(); await new Promise(resolve => setImmediate(resolve)); assert.equal(execute.disabled, false);
const failed = window.document.body.createDiv();
attachmentModalActions({ contentEl: failed, close() {} }, [], "删除勾选项", async () => { throw new Error("模拟失败"); });
const retry = failed.querySelector("button:last-child");
retry.click(); await new Promise(resolve => setImmediate(resolve));
assert.equal(retry.disabled, false); assert.equal(notices.at(-1), "模拟失败");
assert(retry.classList.contains("mod-warning"));

// Exercise the shared move flow using in-memory files only.
const moved = [], folders = [];
const plugin = { app: { vault: { getAbstractFileByPath: () => null, createFolder: async path => folders.push(path) },
  fileManager: { renameFile: async (file, path) => moved.push([file.path, path]) } } };
const plans = [{ checked: true, file: { path: "old.png" }, targetPath: "Attachments/new.png" },
  { checked: false, file: { path: "skip.pdf" }, targetPath: "Attachments/skip.pdf" }];
const progress = window.document.body.createDiv();
context.accept = false;
await applyAttachmentMoves(modal, plugin, plans, progress, () => "确认", () => "完成");
assert.equal(moved.length, 0, "cancelled confirmation never moves files");
context.accept = true;
await applyAttachmentMoves(modal, plugin, plans, progress, () => "确认", () => "完成");
assert.deepEqual(moved, [["old.png", "Attachments/new.png"]]);
assert.deepEqual(folders, ["Attachments"]); assert.equal(progress.textContent, "处理进度：1 / 1");
assert.equal(window.document.body.classList.contains("simple-hide-notices"), false);
const beforeFailure = closed;
plugin.app.fileManager.renameFile = async () => { throw new Error("移动失败"); };
await applyAttachmentMoves(modal, plugin, plans, progress, () => "确认", () => "完成");
assert.equal(closed, beforeFailure); assert.match(progress.textContent, /移动失败/);
assert.equal(window.document.body.classList.contains("simple-hide-notices"), false);
console.log("Attachment actions and moves: selection, cancel, duplicate clicks, errors and recovery passed.");
