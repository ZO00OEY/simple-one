import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import { build } from "esbuild";

class ItemView { constructor(leaf) { this.app = leaf.app; this.containerEl = leaf.containerEl; } }
class TFile {}
const obsidian = new Proxy({ ItemView, TFile, Platform: { isMobile: false }, normalizePath: p => p, parseYaml: JSON.parse }, {
  get: (target, key) => key in target ? target[key] : function () {}
});
const result = await build({ stdin: { resolveDir: process.cwd(), contents: `
  export { default as Main } from "./src/main";
  export { registerMarkdownAction } from "./src/shared/markdownAction";
  export { registerSearchFolderFilter } from "./src/features/searchFolderFilter";
  export { registerSelectionToolbar } from "./src/features/selectionToolbar";
  export { registerAttachmentReferenceJump } from "./src/features/attachmentReferenceJump";
  export { initializeAttachmentDefaults } from "./src/features/attachmentOrganizer";
  export { DiaryView } from "./src/features/diary";
` }, bundle: true, write: false, platform: "node", format: "cjs", alias: { buffer: "buffer/" },
  external: ["obsidian", "@codemirror/state", "@codemirror/view", "@codemirror/language"] });
const timers = new Map(); let nextTimer = 0;
const nativeRequire = createRequire(import.meta.url);
const context = vm.createContext({ module: { exports: {} },
  require: name => name === "obsidian" ? obsidian : nativeRequire(name),
  crypto: webcrypto, console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, atob, btoa,
  document: { querySelectorAll: () => [] },
  window: { setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: id => timers.delete(id) }
});
vm.runInContext(result.outputFiles[0].text, context);
const api = context.module.exports;
function fixture() {
  const callbacks = [], cleanups = [], events = new Map(); let reads = 0;
  const host = { settings: { searchFolders: { enabled: true, excludeFolders: [] }, enhancements: { quickFormat: { enabled: true, selectionToolbar: true } } },
    app: { vault: { getConfig() { reads++; } }, workspace: {
      on: (event, fn) => { events.set(event, fn); }, onLayoutReady: fn => callbacks.push(fn),
      getLeavesOfType: () => { reads++; return []; }, iterateAllLeaves: () => { reads++; }
    } }, registerEvent() {}, register: fn => cleanups.push(fn) };
  return { host, callbacks, events, unload: () => { for (const fn of cleanups.reverse()) fn(); },
    reads: () => reads, flush: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } } };
}
for (const [name, register] of [
  ["note actions", host => api.registerMarkdownAction(host, "test-action", () => true, () => assert.fail("unexpected view"), () => {})],
  ["rendered previews", host => api.Main.prototype.registerRenderedPreviewObservers.call(host)],
  ["search folders", api.registerSearchFolderFilter],
  ["selection toolbar", host => api.registerSelectionToolbar(host, () => {})],
  ["attachment reference menus", api.registerAttachmentReferenceJump]
]) {
  for (const queued of [false, true]) {
    const f = fixture();
    const refresh = register(f.host);
    if (queued) for (const fn of f.callbacks) fn();
    f.unload();
    const before = f.reads();
    for (const fn of f.callbacks) fn();
    refresh?.refresh?.();
    if (typeof refresh === "function") refresh();
    f.flush();
    assert.equal(f.reads(), before, `${name}: no work after unload (${queued ? "queued" : "layout pending"})`);
  }
}
// Closing while Navigator settings are saving must not add a listener or render later.
{
  let release; const gate = new Promise(resolve => { release = resolve; });
  let registrations = 0, renders = 0;
  const navigator = { settings: { calendarWeekendDays: "fri-sat" }, saveSettingsAndUpdate: () => gate,
    registerSettingsUpdateListener: () => registrations++, unregisterSettingsUpdateListener() {} };
  const view = new api.DiaryView({ app: { plugins: { getPlugin: () => navigator } },
    containerEl: { children: [null, { empty() {}, addClass() {} }] } }, {});
  view.render = () => renders++;
  const opening = view.onOpen();
  await view.onClose(); release(); await opening;
  assert.equal(registrations, 0); assert.equal(renders, 0);
  await view.onOpen(); assert.equal(registrations, 1); assert.equal(renders, 1);
}
// Attachment defaults must not change config or save settings after folder creation resumes.
{
  let release, active = true, config = "";
  const host = { settings: {}, app: { vault: { getConfig: () => config, getAbstractFileByPath: () => null,
    createFolder: () => new Promise(resolve => { release = resolve; }),
    setConfig: () => assert.fail("unloaded defaults must not change config") } },
    saveSettings: () => assert.fail("unloaded defaults must not save settings") };
  const starting = api.initializeAttachmentDefaults(host, () => active);
  active = false; release(); await starting;
  assert.equal(host.settings.attachmentDefaultsInitialized, undefined);
}
console.log("Delayed startup: note actions, previews, search, selection, attachment menus/defaults and diary listeners stop after unload.");
