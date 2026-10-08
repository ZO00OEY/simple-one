import assert from "node:assert/strict";
import { build } from "esbuild";

async function load(file, stub = "") {
  const plugins = stub ? [{ name: "obsidian-test-double", setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "test" }));
    builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: stub, loader: "js" }));
  } }] : [];
  const result = await build({ entryPoints: [file], bundle: true, format: "esm", platform: "node", write: false, plugins });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { applyTextReformatRules } = await load("src/features/noteReformatRules.ts");
const rule = { id: "check", enabled: true, name: "Replace", pattern: "foo", flags: "g", replaceWith: "bar" };
const source = "---\ntitle: foo\n---\nfoo\nhttps://example.com/foo?q=$&\n\nfoo";
assert.equal(applyTextReformatRules(source, [rule]), "---\ntitle: foo\n---\nbar\nhttps://example.com/foo?q=$&\n\nbar");
assert.equal(applyTextReformatRules("foo\r\nfoo", [{ ...rule, pattern: "[" }]), "foo\nfoo");
assert.equal(applyTextReformatRules("https://example.com/foo\nfoo\nhttps://example.com/foo", [rule]), "https://example.com/foo\nbar\nhttps://example.com/foo");

const { constrainWindowBounds, registerWindowPositionOptimization } = await load("src/features/windowPositionOptimization.ts");
const area = { x: -1920, y: 0, width: 1920, height: 1040 };
assert.deepEqual(constrainWindowBounds({ x: -2000, y: -80, width: 1000, height: 800 }, area), { x: -1920, y: 0, width: 1000, height: 800 });
assert.deepEqual(constrainWindowBounds({ x: 0, y: 900, width: 2500, height: 1500 }, area), area);
const inside = { x: -1500, y: 100, width: 900, height: 700 };
assert.deepEqual(constrainWindowBounds(inside, area), inside);

class Popout {
  open() { this.opened = true; }
  getPopoutWindow() { return { electronWindow: this.nativeWindow }; }
}
let applied;
const popout = new Popout();
popout.nativeWindow = {
  getBounds: () => ({ x: -2000, y: -80, width: 1000, height: 800 }),
  setBounds: (bounds) => { applied = bounds; },
  isDestroyed: () => false, isMaximized: () => false, isFullScreen: () => false,
};
globalThis.window = { electron: { remote: { screen: { getDisplayMatching: () => ({ workArea: area }) } } } };
let cleanup;
const plugin = { isMobile: false, app: { setting: popout }, settings: { enableWindowPositionOptimization: true }, register: (fn) => { cleanup = fn; } };
const original = Popout.prototype.open;
registerWindowPositionOptimization(plugin);
popout.open();
assert.ok(popout.opened, "the original modal open must still run with its receiver");
assert.deepEqual(applied, { x: -1920, y: 0, width: 1000, height: 800 });
applied = undefined;
plugin.settings.enableWindowPositionOptimization = false;
popout.open();
assert.equal(applied, undefined, "disabled optimization must not move windows");
plugin.settings.enableWindowPositionOptimization = true;
popout.nativeWindow.isMaximized = () => true;
popout.open();
assert.equal(applied, undefined, "maximized windows must not be resized");
cleanup();
assert.equal(Popout.prototype.open, original, "unloading must restore the original method");
plugin.isMobile = true;
registerWindowPositionOptimization(plugin);
assert.equal(Popout.prototype.open, original);
delete globalThis.window;

const { collectSwitchStates, applySwitchStates } = await load("src/shared/platformSwitches.ts");
const settings = { enabled: true, enableWindowPositionOptimization: true, enhancements: { quickFormat: { visibleModes: ["h1", "quote"] } } };
const switches = collectSwitchStates(settings);
assert.equal(switches["/enableWindowPositionOptimization"], undefined, "window optimization is a shared option");
assert.deepEqual(switches["/enhancements/quickFormat/visibleModes"], ["h1", "quote"]);
switches["/enhancements/quickFormat/visibleModes"].push("h2");
assert.deepEqual(settings.enhancements.quickFormat.visibleModes, ["h1", "quote"], "collected arrays must not alias live settings");
applySwitchStates(settings, { "/enabled": false });
assert.equal(settings.enabled, false);
const stub = `
export class Notice { constructor(message) { globalThis.__simpleTest.notices.push(message); } }
export class Modal {
  titleEl = { setText() {} };
  contentEl = { createEl() {}, empty() {}, buttons: [] };
  open() { globalThis.__simpleTest.modal = this; this.onOpen(); }
  close() { this.onClose(); }
}
export class Setting {
  constructor(el) { this.el = el; }
  addButton(fn) {
    const button = { setButtonText(text) { this.text = text; return this; }, setCta() { return this; }, onClick(handler) { this.handler = handler; return this; } };
    fn(button); this.el.buttons.push(button); return this;
  }
}`;
globalThis.__simpleTest = { notices: [] };
const { confirmAction } = await load("src/shared/confirm.ts", stub);
const cancelled = confirmAction({}, "Delete?");
globalThis.__simpleTest.modal.close();
assert.equal(await cancelled, false, "closing confirmation must cancel the operation");
const accepted = confirmAction({}, "Delete?");
globalThis.__simpleTest.modal.contentEl.buttons.find((button) => button.text === "确认").handler();
assert.equal(await accepted, true);
const { runAsync } = await load("src/shared/async.ts", stub);
const errors = [];
const originalConsoleError = console.error;
console.error = (...args) => errors.push(args);
try {
  const callback = runAsync(async () => { throw new Error("check failure"); });
  assert.equal(callback(), undefined, "DOM callbacks must not return an unhandled Promise");
  await new Promise(setImmediate);
  assert.equal(errors.length, 1);
  assert.ok(globalThis.__simpleTest.notices[0].includes("check failure"));
} finally { console.error = originalConsoleError; delete globalThis.__simpleTest; }
const { addAttachmentFolderToSearchExclusions } = await load("src/features/searchFolderFilter.ts", `
  export class Modal {} export class Setting {} export class TFile {} export class TFolder {}
  export class Notice {} export function setIcon() {}
  export function normalizePath(path) { return path.replace(/\\\\/g, '/').replace(/\\/+/g, '/').replace(/^\\/|\\/$/g, ''); }
`);
const searchConfig = { enabled: false, includeFolders: ["Notes"], excludeFolders: ["Private"] };
let attachmentFolder = "Attachments";
const searchPlugin = { settings: { searchFolders: searchConfig }, app: { vault: { getConfig: () => attachmentFolder } } };
assert.equal(addAttachmentFolderToSearchExclusions(searchPlugin), true);
assert.deepEqual(searchConfig.excludeFolders, ["Private", "Attachments"]);
assert.equal(addAttachmentFolderToSearchExclusions(searchPlugin), false, "attachment folder must not be duplicated");
assert.deepEqual(searchConfig.includeFolders, ["Notes"]);
assert.equal(searchConfig.enabled, false, "automatic exclusion must not enable search filtering");
for (const location of ["/", ".", "./", "./images", "", undefined]) {
  attachmentFolder = location;
  assert.equal(addAttachmentFolderToSearchExclusions(searchPlugin), false, "non-fixed attachment locations must be ignored");
}
attachmentFolder = "New Attachments";
assert.equal(addAttachmentFolderToSearchExclusions(searchPlugin), true);
assert.deepEqual(searchConfig.excludeFolders, ["Private", "Attachments", "New Attachments"]);
const organizer = await load("src/features/attachmentOrganizer.ts", String.raw`
export class TFile {
  constructor(path) {
    this.path = path;
    this.name = path.split('/').pop();
    this.extension = this.name.split('.').pop();
    this.basename = this.name.slice(0, -this.extension.length - 1);
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '/';
    this.parent = { path: parent, name: parent.split('/').pop() };
    this.stat = { ctime: 1, mtime: 1 };
  }
}
export class TFolder { constructor(children) { this.children = children; } }
export class Modal { open() { globalThis.__attachmentTest.modal = this; } }
export class Notice { constructor(message) { globalThis.__attachmentTest.notices.push(message); } }
export class Setting {}
export const normalizePath = path => path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
globalThis.__attachmentTest = { TFile, TFolder, notices: [] };
`);
const { TFile, TFolder } = globalThis.__attachmentTest;
const organizerFiles = [
  'Notes/Example.md', 'IMG_4439.jpeg', 'Diagram.png', 'data.pdf',
  'orphan.png', 'standalone.json', 'Root.md', 'Root.canvas', 'Root.base',
  'Templates/Example.md', 'template.png', 'Notes/IMG_9999.png',
  'Attachments/IMG_1111.png', 'Attachments/orphan.png', 'Attachments/data.txt',
  'Attachments/Notes/Example 1.jpeg',
].map(path => new TFile(path));
const organizerFolder = new TFolder(organizerFiles.filter(file => file.path.startsWith('Attachments/')));
let organizerLocation = 'Attachments';
const organizerPlugin = {
  getTemplateFolder: () => 'Templates',
  app: {
    vault: {
      configDir: '.obsidian', getConfig: () => organizerLocation,
      getFiles: () => organizerFiles,
      getMarkdownFiles: () => organizerFiles.filter(file => file.extension === 'md'),
      getAbstractFileByPath: path => path === 'Attachments' ? organizerFolder : organizerFiles.find(file => file.path === path),
    },
    metadataCache: { resolvedLinks: {
      'Notes/Example.md': { 'IMG_4439.jpeg': 1, 'Diagram.png': 1, 'data.pdf': 1, 'Notes/IMG_9999.png': 1, 'Attachments/IMG_1111.png': 1 },
      'Templates/Example.md': { 'template.png': 1 },
    } },
  },
};
await organizer.planAttachmentImageRename(organizerPlugin);
let plans = globalThis.__attachmentTest.modal.plans;
assert.deepEqual(plans.map(plan => plan.file.path).sort(), ['Attachments/IMG_1111.png', 'Diagram.png', 'IMG_4439.jpeg'].sort());
assert.equal(plans.find(plan => plan.file.path === 'IMG_4439.jpeg').targetPath, 'Attachments/Notes/Example 2.jpeg', 'existing image names must reserve numbered targets');
assert.equal(plans.find(plan => plan.file.path === 'Diagram.png').targetPath, 'Attachments/Notes/Diagram.png', 'meaningful root image names must be preserved');
await organizer.planAttachmentOrganization(organizerPlugin);
plans = globalThis.__attachmentTest.modal.plans;
assert.deepEqual(plans.map(plan => plan.file.path), ['data.pdf']);
assert.equal(plans[0].targetPath, 'Attachments/Notes/Example/data.pdf');
await organizer.checkUnusedAttachments(organizerPlugin);
const unused = globalThis.__attachmentTest.modal.items;
assert.equal(unused.find(item => item.file.path === 'orphan.png').checked, false);
assert.equal(unused.find(item => item.file.path === 'Attachments/orphan.png').checked, true);
assert.ok(!unused.some(item => ['IMG_4439.jpeg', 'standalone.json', 'Root.md', 'Root.canvas', 'Root.base', 'Notes/IMG_9999.png'].includes(item.file.path)));
organizerLocation = '.';
await organizer.planAttachmentImageRename(organizerPlugin);
assert.deepEqual(globalThis.__attachmentTest.modal.plans.map(plan => plan.file.path), ['Notes/IMG_9999.png'], 'same-folder behavior must remain scoped to the source note folder');
organizerLocation = '/';
await organizer.planAttachmentImageRename(organizerPlugin);
assert.match(globalThis.__attachmentTest.notices.at(-1), /已禁用/);
delete globalThis.__attachmentTest;
console.log("Smoke checks passed: formatting, window hooks, platform settings, confirmation, async errors, attachment search exclusions, root attachment organization.");
