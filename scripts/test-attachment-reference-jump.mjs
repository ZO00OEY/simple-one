import assert from "node:assert/strict";
import vm from "node:vm";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const { window } = new JSDOM('<body><div class="view-actions"></div></body>');
class TFile { constructor(path) { this.path = path; this.extension = path.split('.').at(-1); } }
class FileView {
  constructor(file) { this.file = file; }
  getViewType() { return 'image'; }
  addAction(icon, title, callback) {
    const button = window.document.createElement('button');
    button.dataset.icon = icon; button.title = title;
    button.addEventListener('click', callback);
    window.document.querySelector('.view-actions').append(button);
    return button;
  }
}
class Menu {
  static menus = [];
  constructor() { this.items = []; Menu.menus.push(this); }
  addItem(build) {
    const item = {
      setTitle(value) { this.title = value; return this; },
      setIcon(value) { this.icon = value; return this; },
      onClick(callback) { this.click = callback; return this; },
    };
    build(item); this.items.push(item); return this;
  }
  addSeparator() {}
  showAtMouseEvent() { this.shown = true; }
  showAtPosition() { this.shown = true; }
  hide() { this.hidden = true; }
}
const notices = [], listeners = new Map(), disposers = [], opens = [];
const output = await build({ entryPoints: ['src/features/attachmentReferenceJump.ts'], bundle: true,
  write: false, platform: 'node', format: 'cjs', external: ['obsidian'] });
const context = vm.createContext({ module: { exports: {} }, window, console,
  require: () => ({ TFile, FileView, Menu, Notice: class { constructor(text) { notices.push(text); } } }),
});
vm.runInContext(output.outputFiles[0].text, context);
const { registerAttachmentReferenceJump, attachmentReferencingNotes } = context.module.exports;
const image = new TFile('Attachments/image.png'), other = new TFile('Attachments/other.svg');
const a = new TFile('A/Note.md'), b = new TFile('B/Note.md');
const files = new Map([image, other, a, b].map(file => [file.path, file]));
const view = new FileView(image);
let navigatorCallback, navigatorDisposed = 0;
const plugin = {
  settings: { enableAttachmentReferenceJump: true },
  register: dispose => disposers.push(dispose), registerEvent() {},
  app: {
    vault: { getAbstractFileByPath: path => files.get(path) },
    metadataCache: { resolvedLinks: {
      [b.path]: { [image.path]: 2 }, [a.path]: { [image.path]: 1, [other.path]: 1 },
      'Deleted.md': { [image.path]: 1 }, [other.path]: { [image.path]: 1 },
    } },
    plugins: { plugins: { 'notebook-navigator': { api: { menus: {
      registerFileMenu(callback) { navigatorCallback = callback; return () => { navigatorDisposed++; }; },
    } } } } },
    workspace: {
      on(event, callback) { listeners.set(event, callback); return {}; },
      onLayoutReady() {}, iterateAllLeaves: callback => callback({ view }),
      getLeaf(mode) { assert.equal(mode, 'tab'); return { openFile: async file => opens.push(file.path) }; },
    },
  },
};
assert.deepEqual(Array.from(attachmentReferencingNotes(plugin.app, image), file => file.path), [a.path, b.path]);
const refresh = registerAttachmentReferenceJump(plugin);
refresh(); refresh();
assert.equal(window.document.querySelectorAll('.simple-attachment-reference-action').length, 1, 'refresh never duplicates header actions');
const button = window.document.querySelector('.simple-attachment-reference-action');
assert.equal(button.dataset.icon, 'search');
assert.equal(button.parentElement.className, 'view-actions');
const rightMenu = new Menu();
listeners.get('file-menu')(rightMenu, image);
assert.equal(rightMenu.items.length, 1); assert.equal(rightMenu.items[0].icon, 'search');
const navigatorMenu = new Menu();
navigatorCallback({ file: image, addItem: build => navigatorMenu.addItem(build) });
assert.equal(navigatorMenu.items.length, 1, 'Notebook Navigator custom menus are supported');
rightMenu.items[0].click(new window.MouseEvent('click'));
const choices = Menu.menus.at(-1);
assert.equal(choices.items.length, 3, 'multiple references offer open-all and individual notes');
choices.items[0].click();
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(opens, [a.path, b.path], 'each reference opens in a new tab');
view.file = other;
button.click(); await new Promise(resolve => setImmediate(resolve));
assert.equal(opens.at(-1), a.path, 'header reads the current attachment after view reuse');
view.file = new TFile('Attachments/unreferenced.png');
button.click(); assert.equal(notices.at(-1), '没有找到引用此附件的笔记');
view.file = a; refresh();
assert.equal(window.document.querySelectorAll('.simple-attachment-reference-action').length, 0, 'notes do not receive attachment actions');
view.file = image; refresh();
plugin.settings.enableAttachmentReferenceJump = false; refresh();
assert.equal(window.document.querySelectorAll('.simple-attachment-reference-action').length, 0);
const disabledMenu = new Menu(); listeners.get('file-menu')(disabledMenu, image);
assert.equal(disabledMenu.items.length, 0, 'turning off removes menu integration');
plugin.settings.enableAttachmentReferenceJump = true; refresh();
disposers.forEach(dispose => dispose());
assert.equal(navigatorDisposed, 1);
assert.equal(window.document.querySelectorAll('.simple-attachment-reference-action').length, 0, 'unloading removes header actions');
console.log('Attachment reference jump: cache lookup, new tabs, multi-reference choices, Navigator menus, view reuse, toggling and cleanup passed.');
