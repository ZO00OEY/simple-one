import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";
import { build } from "esbuild";

// Match Obsidian's load/unload order and view ownership, including partial load failures.
class Component {
  _loaded = false; _children = []; _events = [];
  async load() {
    if (this._loaded) return;
    this._loaded = true;
    await this.onload?.();
    for (const child of [...this._children]) child.load();
  }
  unload() {
    if (!this._loaded) return;
    this._loaded = false;
    while (this._children.length) this._children.pop().unload();
    while (this._events.length) this._events.pop()();
    this.onunload?.();
  }
  register(fn) { this._events.push(fn); }
  addChild(child) { this._children.push(child); if (this._loaded) child.load(); return child; }
  removeChild(child) { const index = this._children.indexOf(child); if (index >= 0) { this._children.splice(index, 1); child.unload(); } }
  registerEvent(ref) { this.register(() => ref.off()); }
  registerDomEvent() {}
  registerInterval(id) { this.register(() => timers.delete(id)); }
}
let failRibbon = false, nextTimer = 0;
const views = new Map(), commands = new Set(), timers = new Set(), events = new Set(), layout = [];
class Plugin extends Component {
  constructor(app, manifest) { super(); this.app = app; this.manifest = manifest; }
  registerView(type, creator) {
    if (views.has(type)) throw Error(`Attempting to register an existing view type "${type}"`);
    views.set(type, creator);
    this.register(() => views.delete(type));
  }
  addRibbonIcon() { if (failRibbon) throw Error("interface setup failed after view registration"); }
  addCommand(command) {
    const id = this.manifest.id + ":" + command.id;
    assert(!commands.has(id), "duplicate command: " + id);
    commands.add(id); this.register(() => commands.delete(id));
  }
}
const obsidian = new Proxy({ Plugin, Component, Notice: class {}, Platform: { isMobile: false } }, {
  get: (target, key) => key in target ? target[key] : function () {}
});
const built = await build({ stdin: { resolveDir: process.cwd(), contents: `
  export { default as Main } from "./src/main";
  export { default as AI } from "./modules/ai/src/main";
` }, bundle: true, write: false, platform: "node", format: "cjs", alias: { buffer: "buffer/" },
  external: ["obsidian", "@codemirror/state", "@codemirror/view", "@codemirror/language"] });
const nativeRequire = createRequire(import.meta.url);
const context = vm.createContext({ module: { exports: {} },
  require: name => name === "obsidian" ? obsidian : nativeRequire(name), crypto: webcrypto,
  console: { ...console, error() {} }, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, atob, btoa,
  document: {}, window: { setInterval() { timers.add(++nextTimer); return nextTimer; } }
});
vm.runInContext(built.outputFiles[0].text, context);
const { Main, AI } = context.module.exports;
const on = () => { const ref = { off: () => events.delete(ref) }; events.add(ref); return ref; };
const app = { vault: { on }, workspace: { on, getActiveFile: () => null, onLayoutReady: fn => layout.push(fn) } };
const manifest = { id: "simple-one-ai", dir: "fixture" };

// Failure in the main plugin must release both its views and already-loaded children.
{
  const plugin = new Main(app, { id: "simple-one" });
  plugin.initialize = async () => {
    plugin.registerView("simple-diary", () => {});
    const child = plugin.addChild(new Plugin(app, manifest));
    child.registerView("simple-one-sync-view", () => {});
    throw Error("startup interrupted");
  };
  await assert.rejects(plugin.load(), /startup interrupted/);
  assert.equal(plugin._loaded, false);
  assert.equal(views.size, 0);
  assert.equal(plugin._children.length, 0);
  const retry = new Main(app, { id: "simple-one" });
  retry.initialize = async () => retry.registerView("simple-diary", () => {});
  await retry.load(); assert(views.has("simple-diary")); retry.unload();
}
function ai() {
  const core = new AI(app, manifest);
  core.prepareRequests = async () => {};
  return core;
}
{
  const core = ai(); await core.load();
  failRibbon = true;
  await assert.rejects(core.start(), /interface setup failed/);
  assert.equal(views.size, 0, "partial AI startup must release the chat view");
  assert.equal(events.size, 0, "partial AI startup must release note listeners");
  assert.equal(core._children.length, 0);
  failRibbon = false;
  await core.start(); assert(views.has("simple-one-ai-chat"));
  await core.start(); assert.equal(views.size, 1, "repeated starts must not re-register UI");
  core.stopUI();
  assert.equal(views.size, 0); assert.equal(commands.size, 0); assert.equal(timers.size, 0);
  for (const callback of layout.splice(0)) callback();
  await core.start(); assert(views.has("simple-one-ai-chat"));
  core.unload(); assert.equal(views.size, 0); assert.equal(events.size, 0);
}
// An old pending start and its unload must neither register again nor remove the replacement view.
{
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const old = ai(); await old.load(); old.prepareRequests = () => gate;
  const pending = old.start(); old.stopUI();
  const replacement = ai(); await replacement.load(); await replacement.start();
  const creator = views.get("simple-one-ai-chat");
  release(); await pending; old.unload();
  assert.equal(views.get("simple-one-ai-chat"), creator);
  replacement.unload();
}
assert.equal(views.size, 0); assert.equal(events.size, 0); assert.equal(commands.size, 0); assert.equal(timers.size, 0);
console.log("View startup recovery: partial main/AI startup rollback, retry, repeated start, disable/re-enable and stale startup versus replacement ownership passed.");
