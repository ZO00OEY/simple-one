import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.invalid" });
for (const key of ["window", "document", "HTMLElement", "DOMParser"]) globalThis[key] = key === "window" ? dom.window : key === "document" ? dom.window.document : dom.window[key];
globalThis.createFragment = () => document.createDocumentFragment();
globalThis.createDiv = () => document.createElement("div");
globalThis.CSSStyleSheet = class { replaceSync(text) { this.text = text; } };
document.adoptedStyleSheets = [];
const require = createRequire(import.meta.url);
const notices = [];
let opened;
class TFile { constructor(path) { this.path = path; this.extension = path.split(".").at(-1); this.stat = { mtime: 1, size: 1 }; } }
class TFolder { constructor(path, children = []) { this.path = path; this.children = children; } }
class Modal { open() { opened = this; } }
const obsidian = { TFile, TFolder, Modal, Notice: class { constructor(text) { notices.push(text); } }, normalizePath: path => path };
async function load(contents, plugins = []) {
  const result = await build({ stdin: { contents, loader: "ts", resolveDir: process.cwd() }, plugins,
    bundle: true, platform: "node", format: "cjs", write: false, external: ["obsidian", "@codemirror/state", "@codemirror/view"] });
  const module = { exports: {} };
  new Function("require", "module", "exports", result.outputFiles[0].text)(name => name === "obsidian" ? obsidian : require(name), module, module.exports);
  return module.exports;
}

const htmlSource = await readFile("src/features/htmlPreview.ts", "utf8");
const html = await load(htmlSource.replaceAll('"../shared/', '"./src/shared/').replaceAll('"../types"', '"./src/types"') + "\nexport { renderHtmlPreview };");
const preview = html.renderHtmlPreview(`<style>.card { color: red; }</style><div class="card" style="padding: 8px"><think>safe custom tag</think>
  <a id="tab" href="java&#x09;script:alert(1)">tab</a><a id="newline" href="java&#10;script:alert(1)">newline</a>
  <a id="safe" href="https://example.com/path">safe</a><img src="x" onerror="alert(1)">
  <svg><a xlink:href="java&#x09;script:alert(1)"><text>svg</text></a></svg><iframe srcdoc="bad"></iframe></div>`);
assert.equal(preview.querySelector("#tab").hasAttribute("href"), false);
assert.equal(preview.querySelector("#newline").hasAttribute("href"), false);
assert.equal(preview.querySelector("svg a").hasAttribute("xlink:href"), false);
assert.equal(preview.querySelector("[onerror], script, iframe"), null);
assert.equal(preview.querySelector("#safe").getAttribute("href"), "https://example.com/path");
assert.equal(preview.querySelector("think").textContent, "safe custom tag");
assert.equal(preview.querySelector(".card").style.padding, "8px");
assert(document.adoptedStyleSheets.some(sheet => /simple-html-scope-.*\.card/.test(sheet.text) && /color: red/.test(sheet.text)), "scoped stylesheet remains available");

const organizerSource = await readFile("src/features/attachmentOrganizer.ts", "utf8");
const attachments = await load('export { registerAttachmentAutomation } from "./src/features/attachmentAutomation"; export { checkUnusedAttachments, deleteUnusedAttachments } from "./src/features/attachmentOrganizer";', [{
  name: "expose-actual-delete", setup(builder) { builder.onLoad({ filter: /attachmentOrganizer\.ts$/ }, () => ({ contents: organizerSource + "\nexport { deleteUnusedAttachments };", loader: "ts", resolveDir: process.cwd() + "/src/features" })); }
}]);
const note = new TFile("Note.md"), used = new TFile("Attachments/used.png"), orphan = new TFile("Attachments/orphan.png");
const hidden = new TFolder("Attachments/hidden");
const folder = new TFolder("Attachments", [used, orphan, hidden]);
const files = new Map([note, used, orphan, folder, hidden].map(file => [file.path, file]));
const listeners = new Map(), disposers = [], trashed = [];
let indexed = false, duringList = () => {};
const on = prefix => (event, callback) => { listeners.set(`${prefix}:${event}`, callback); return {}; };
const plugin = { settings: {}, registerEvent() {}, register: disposer => disposers.push(disposer), app: {
  vault: { on: on("vault"), getConfig: () => "Attachments", getMarkdownFiles: () => [note],
    getFiles: () => [note, used, orphan], getAbstractFileByPath: path => files.get(path),
    adapter: { list: async () => { duringList(); return { files: ["Attachments/hidden/.keep"], folders: [] }; } } },
  metadataCache: { on: on("cache"), getFileCache: () => indexed ? {} : null, resolvedLinks: {} },
  workspace: { onLayoutReady: callback => callback() },
  fileManager: { trashFile: async file => { trashed.push(file.path); } },
} };
attachments.registerAttachmentAutomation(plugin);
await attachments.checkUnusedAttachments(plugin);
assert.equal(opened, undefined, "null note cache blocks manual cleanup preview");
assert.match(notices.at(-1), /索引尚未完成/);
indexed = true;
listeners.get("cache:resolved")();
plugin.app.metadataCache.resolvedLinks = { [note.path]: { [used.path]: 1 } };
await attachments.checkUnusedAttachments(plugin);
assert.deepEqual(opened.items.map(item => item.file.path), [orphan.path]);
assert.equal(opened.items[0].checked, true, "resolved unreferenced images still support cleanup");
const selection = opened.items;
listeners.get("vault:modify")(note);
await assert.rejects(attachments.deleteUnusedAttachments(plugin, selection), /索引尚未完成/, "manual cleanup remains guarded when automatic options are all off");
assert.equal(trashed.length, 0);
listeners.get("cache:resolved")();
plugin.app.metadataCache.resolvedLinks[note.path][orphan.path] = 1;
assert.equal((await attachments.deleteUnusedAttachments(plugin, selection)).files, 0, "recheck current references rather than trusting the old checklist");
delete plugin.app.metadataCache.resolvedLinks[note.path][orphan.path];
opened = undefined;
duringList = () => listeners.get("vault:modify")(note);
await attachments.checkUnusedAttachments(plugin);
assert.equal(opened, undefined, "a change during asynchronous preview collection blocks opening the stale checklist");
duringList = () => {};
listeners.get("cache:resolved")();
assert.equal((await attachments.deleteUnusedAttachments(plugin, selection)).files, 1);
assert.deepEqual(trashed, [orphan.path]);
const second = new TFile("Attachments/second.png"); files.set(second.path, second);
plugin.app.fileManager.trashFile = async file => { trashed.push(file.path); listeners.get("vault:modify")(note); };
await assert.rejects(attachments.deleteUnusedAttachments(plugin, [...selection, { file: second, checked: true }]), /索引尚未完成/);
assert.equal(trashed.includes(second.path), false, "stop the remaining delete list when a note changes during a preceding trash operation");
disposers.forEach(dispose => dispose());
await assert.rejects(attachments.deleteUnusedAttachments(plugin, selection), /索引尚未完成/, "unloading invalidates cleanup readiness");
dom.window.close();
console.log("Release safety: HTML URL normalization, safe styles/custom tags and manual attachment cache/reference guards passed.");
