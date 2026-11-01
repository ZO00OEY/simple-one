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
  stdin: { contents: source + "\nexport { attachmentModalActions, applyAttachmentMoves, emptyFoldersInFolder, deleteUnusedAttachments, applyInlineImages };", loader: "ts", resolveDir: "src/features" },
  bundle: true, platform: "node", format: "cjs", write: false, external: ["obsidian"],
  plugins: [{ name: "mock-confirm", setup(builder) {
    builder.onResolve({ filter: /shared\/confirm$/ }, () => ({ path: "confirm", namespace: "test" }));
    builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export async function confirmAction() { return globalThis.accept; }" }));
  } }],
});
const notices = [];
class TFolder {
  constructor(path, children = []) { this.path = path; this.children = children; }
}
const context = vm.createContext({ module: { exports: {} }, document: window.document, accept: true, Error,
  atob: value => Buffer.from(value, 'base64').toString('binary'),
  require: () => ({ TFolder, Modal: class {}, Notice: class { constructor(text) { notices.push(text); } }, setIcon() {}, normalizePath: path => path.replace(/\\/g, "/") }),
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

// Empty-folder cleanup never touches real vault files.
const leaf = new TFolder("Attachments/empty/leaf");
const parent = new TFolder("Attachments/empty", [leaf]);
const hidden = new TFolder("Attachments/hidden");
const occupied = new TFolder("Attachments/occupied", [{ path: "Attachments/occupied/note.md" }]);
const changed = new TFolder("Attachments/changed");
const root = new TFolder("Attachments", [parent, hidden, occupied, changed]);
const entries = new Map([root, parent, leaf, hidden, occupied, changed].map(folder => [folder.path, folder]));
const diskFiles = new Map([[hidden.path, ["Attachments/hidden/.keep"]]]);
const trashed = [];
const cleanupPlugin = { app: {
  metadataCache: { resolvedLinks: { "note.md": { "Attachments/used.png": 1 } } },
  vault: {
    getMarkdownFiles: () => [],
    getAbstractFileByPath: path => entries.get(path),
    adapter: { list: async path => ({ files: diskFiles.get(path) || [], folders: entries.get(path).children.filter(child => child instanceof TFolder).map(child => child.path) }) },
  },
  fileManager: { trashFile: async file => {
    trashed.push(file.path); entries.delete(file.path);
    for (const folder of entries.values()) if (folder instanceof TFolder) folder.children = folder.children.filter(child => child !== file);
  } },
} };
const { emptyFoldersInFolder, deleteUnusedAttachments } = context.module.exports;
context.module.exports.registerAttachmentCleanupGuard(cleanupPlugin, () => true);
const empty = await emptyFoldersInFolder(cleanupPlugin, root);
assert.deepEqual(Array.from(empty, folder => folder.path), [leaf.path, parent.path, changed.path], "exclude root, files and disk-only hidden files; include nested empty parents");
diskFiles.set(changed.path, ["Attachments/changed/new.txt"]);
let deleted = await deleteUnusedAttachments(cleanupPlugin, [parent, changed].map(file => ({ file, checked: true })));
assert.equal(deleted.folders, 0, "keep parents with deselected children and folders with newly added disk files");
const used = { path: "Attachments/used.png" }, unused = { path: "Attachments/orphan.png" };
entries.set(used.path, used); entries.set(unused.path, unused);
deleted = await deleteUnusedAttachments(cleanupPlugin, [parent, leaf, changed, used, unused].map(file => ({ file, checked: true })));
assert.equal(deleted.folders, 2); assert.equal(deleted.files, 1);
assert.deepEqual(trashed, [leaf.path, parent.path, unused.path], "remove children before parents, skip referenced attachments and newly nonempty folders");
assert(entries.has(root.path)); assert(entries.has(hidden.path)); assert(entries.has(changed.path));
assert.equal((await emptyFoldersInFolder(cleanupPlugin, new TFolder("EmptyRoot"))).length, 0, "never remove the configured attachment root");
console.log("Empty-folder cleanup: nesting, deselection, hidden files, changed folders and referenced attachments passed.");

const { initializeAttachmentDefaults, DEFAULT_ATTACHMENT_FOLDER } = context.module.exports;
assert.equal(DEFAULT_ATTACHMENT_FOLDER, '999 attachment');
for (const initial of [undefined, '/', '', 'Custom Attachments', './images', '.']) {
  let location = initial, saves = 0;
  const created = [], configured = [];
  const defaultsPlugin = {
    settings: { attachmentDefaultsInitialized: false },
    saveSettings: async () => { saves++; },
    app: { vault: {
      getConfig: () => location,
      setConfig: async (_key, value) => { configured.push(value); location = value; },
      getAbstractFileByPath: () => null,
      createFolder: async path => created.push(path),
    } },
  };
  await initializeAttachmentDefaults(defaultsPlugin);
  const needsDefault = initial === undefined || initial === '/' || initial === '';
  assert.equal(location, needsDefault ? DEFAULT_ATTACHMENT_FOLDER : initial);
  assert.deepEqual(created, needsDefault ? [DEFAULT_ATTACHMENT_FOLDER] : []);
  assert.equal(defaultsPlugin.settings.attachmentDefaultsInitialized, true);
  location = '/';
  await initializeAttachmentDefaults(defaultsPlugin);
  assert.equal(location, '/', 'reenabling must preserve later user changes, including vault root mode');
  assert.equal(saves, 1);
  assert.equal(configured.length, needsDefault ? 1 : 0);
}
const collision = { settings: {}, app: { vault: {
  getConfig: () => '/', setConfig() { throw new Error('must not write'); },
  getAbstractFileByPath: () => ({ path: DEFAULT_ATTACHMENT_FOLDER }),
} } };
await assert.rejects(initializeAttachmentDefaults(collision), /已被文件占用/);
assert.equal(collision.settings.attachmentDefaultsInitialized, undefined);
console.log('Attachment defaults: initial configuration, custom locations, reenabling and name collisions passed.');

const inlineSource = { path: 'Notes/Inline.md' };
const inlineText = '![](data:image/png;base64,AA==)';
let content = inlineText, afterCreate = () => {}, allowed = true;
const inlineFiles = new Map([['Attachments', new TFolder('Attachments')]]), rolledBack = [];
const inlinePlugin = { app: {
  vault: {
    read: async () => content,
    getAbstractFileByPath: path => inlineFiles.get(path),
    createFolder: async path => inlineFiles.set(path, new TFolder(path)),
    createBinary: async path => {
      assert(!inlineFiles.has(path), 'never overwrite existing attachments');
      const file = { path }; inlineFiles.set(path, file); afterCreate(); return file;
    },
    process: async (_source, update) => { content = update(content); },
  },
  fileManager: { trashFile: async file => { rolledBack.push(file.path); inlineFiles.delete(file.path); } },
} };
const inlinePlan = { source: inlineSource, match: inlineText, base64: 'AA==', start: 0, end: inlineText.length, targetPath: 'Attachments/Inline 1.png', checked: true };
const { applyInlineImages } = context.module.exports;
assert.equal(await applyInlineImages(inlinePlugin, [inlinePlan], () => allowed), 1);
assert.equal(content, '![[Attachments/Inline 1.png]]');
inlineFiles.delete(inlinePlan.targetPath); content = inlineText;
afterCreate = () => { content = `changed ${inlineText}`; };
await assert.rejects(applyInlineImages(inlinePlugin, [inlinePlan], () => allowed), /笔记已变化/);
assert.equal(inlineFiles.has(inlinePlan.targetPath), false, 'changed notes roll back newly created images');
content = inlineText;
afterCreate = () => { allowed = false; };
await assert.rejects(applyInlineImages(inlinePlugin, [inlinePlan], () => allowed), /已停止/);
assert.equal(inlineFiles.has(inlinePlan.targetPath), false, 'disabling mid-conversion rolls back new images');
assert.equal(content, inlineText);
assert.equal(rolledBack.length, 2);
console.log('Inline conversion: successful replacement, concurrent edits and cancellation rollback passed.');
