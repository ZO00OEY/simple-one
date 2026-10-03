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
console.log("Smoke checks passed: formatting, window hooks, platform settings, confirmation, async errors.");
