import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { build } from "esbuild";

class Component {
  cleanups = [];
  register(callback) { this.cleanups.push(callback); }
  registerEvent() {}
  unload() { for (const callback of this.cleanups.splice(0)) callback(); }
}
const obsidian = new Proxy({ Component, Platform: { isMobile: false } }, {
  get: (target, key) => key in target ? target[key] : function () {}
});
const result = await build({
  stdin: { contents: 'export { default as Share } from "./src/features/share"; export { default as Sync } from "./src/features/sync";', resolveDir: process.cwd() },
  bundle: true, write: false, platform: "node", format: "cjs", external: ["obsidian"],
  plugins: [{ name: "startup-storage", setup(builder) {
    builder.onResolve({ filter: /^\.\/storage$/ }, args => /sync[/\\]index\.ts$/.test(args.importer) ? { path: "storage", namespace: "fixture" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'export const migrateLinkFiles = () => globalThis.migrate(); export const legacySyncRunning = () => globalThis.legacySyncActive; export const readLocalSyncSettings = async () => ({}); export const writeLocalSyncSettings = async () => {};' }));
  } }]
});
const nativeRequire = createRequire(import.meta.url);
const context = vm.createContext({ module: { exports: {} }, require: name => name === "obsidian" ? obsidian : nativeRequire(name), console });
vm.runInContext(result.outputFiles[0].text, context);
const { Share, Sync } = context.module.exports;

// Resume each awaited startup stage after unload: no stale UI may be registered.
for (const stage of ["reload", "change", "edgeone", "template"]) {
  let resume, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const pause = () => new Promise(resolve => { resume = resolve; entered(); });
  const host = { manifest: { id: "simple-one" }, app: { vault: {}, workspace: { on() {} } }, sync: {},
    registerEvent: () => assert.fail("unloaded share must not register UI"),
    registerView: () => assert.fail("unloaded share must not register views") };
  const feature = new Share(host);
  feature.manifest.site.repo = stage === "change" ? "" : "fixture";
  feature.manifest.libraries = { active: "pending", default: "fixture", entries: { fixture: { site: { repo: "fixture" } } } };
  feature.reload = stage === "reload" ? pause : async () => {};
  feature.change = stage === "change" ? pause : async () => {};
  feature.edgeone.load = stage === "edgeone" ? pause : async () => {};
  feature.readTemplateSelection = stage === "template" ? pause : async () => {};
  const loading = feature.initialize();
  await ready;
  feature.unload();
  resume();
  await loading;
}
for (const stage of ["migration", "settings", "legacy-save", "mobile", "desktop"]) {
  let resume, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const pause = () => new Promise(resolve => { resume = resolve; entered(); });
  context.migrate = stage === "migration" ? pause : async () => {};
  context.legacySyncActive = stage === "legacy-save";
  const host = { manifest: { id: "simple-one" }, app: { vault: { adapter: {}, configDir: ".obsidian" } } };
  const feature = new Sync(host);
  feature.settings = { enabled: stage === "mobile" || stage === "legacy-save" };
  feature.loadSettings = stage === "settings" ? pause : async () => {};
  feature.saveSettings = stage === "legacy-save" ? pause : async () => {};
  feature.useLightweightSync = () => stage === "mobile";
  feature.getMobileGithub = () => ({ load: pause });
  feature.detectDesktopGitDefaults = stage === "desktop" ? pause : async () => {};
  const loading = feature.initialize();
  await ready;
  feature.unload();
  resume();
  await loading;
}
console.log("Startup cancellation: share and sync stop registering UI after unload at every asynchronous startup stage.");

// Layout callbacks and in-flight polling also outlive the initial initialize() call.
for (const mode of ["layout", "timer", "poll"]) {
  const layout = [], intervals = [], timers = new Map(); let next = 0, scans = 0, menus = 0, release;
  context.document = { querySelectorAll: () => [] };
  context.window = { setTimeout: fn => { timers.set(++next, fn); return next; }, clearTimeout: id => timers.delete(id),
    setInterval: fn => { intervals.push(fn); return 1; }, clearInterval() {} };
  const host = Object.assign(new Component(), {
    manifest: { id: "simple-one" }, settings: {}, sync: {},
    app: { vault: { configDir: ".obsidian", on() {}, adapter: {
      exists: () => new Promise(resolve => { release = resolve; }), read: () => assert.fail("unloaded poll must not read")
    } }, metadataCache: { on() {} }, workspace: { on() {}, getLeavesOfType: () => [], onLayoutReady: fn => layout.push(fn) },
    plugins: { getPlugin: () => ({ api: { menus: {
      registerFileMenu: () => { menus++; return () => {}; }, registerFolderMenu: () => { menus++; return () => {}; }
    } } }) } }, registerView() {}, addCommand() {}, registerInterval() {}
  });
  const feature = new Share(host);
  feature.manifest.site.repo = "fixture";
  feature.reload = feature.edgeone.load = feature.readTemplateSelection = async () => {};
  feature.scan = async () => { scans++; };
  await feature.initialize();
  if (mode === "timer") for (const fn of layout) fn();
  if (mode === "poll") intervals[0]();
  const menusBefore = menus;
  feature.unload(); host.unload();
  for (const fn of layout) fn();
  for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
  if (release) { release(true); await Promise.resolve(); await Promise.resolve(); }
  assert.equal(scans, 0, `${mode}: unloaded share must not scan`);
  assert.equal(menus, menusBefore, `${mode}: unloaded share must not register navigator menus`);
  assert.equal(timers.size, 0, `${mode}: unloaded share must not schedule more timers`);
}
console.log("Share delayed startup: layout hooks, queued scans and in-flight polling cannot restart after unload.");

// Startup settings must stop inside awaited helpers, before writing an old snapshot.
for (const stage of ["local-read", "shared-read", "local-save"]) {
  let release, reached, active = true, sharedWrites = 0;
  const ready = new Promise(resolve => { reached = resolve; });
  const pause = () => new Promise(resolve => { release = resolve; reached(); });
  const saved = { deviceId: "fixture", deviceName: "fixture", setupFlowVersion: 2 };
  const feature = new Sync({ manifest: { id: "simple-one" }, app: { vault: { configDir: ".obsidian" } } });
  feature.loadData = stage === "local-read" ? pause : async () => saved;
  feature.loadSharedSettings = stage === "shared-read" ? pause : async () => ({});
  feature.saveData = stage === "local-save" ? pause : () => assert.fail("unloaded startup must not start a local save");
  feature.saveSharedSettings = async () => { sharedWrites++; };
  const starting = feature.loadSettings(() => active);
  await ready; active = false; release(saved); await starting;
  assert.equal(sharedWrites, 0, `${stage}: unloaded startup must not save shared settings`);
}
for (const stage of ["exists", "read", "git"]) {
  let release, reached, active = true, writes = 0;
  const ready = new Promise(resolve => { reached = resolve; });
  const pause = () => new Promise(resolve => { release = resolve; reached(); });
  const feature = new Sync({ manifest: { id: "simple-one" }, app: { vault: { configDir: ".obsidian", adapter: {
    exists: stage === "exists" ? pause : async () => true,
    read: stage === "read" ? pause : () => assert.fail("unloaded startup must not read more settings"),
    write: async () => { writes++; }
  } } } });
  feature.settings = {};
  let gitGate;
  feature.git = () => gitGate ??= pause();
  feature.saveSettings = async () => { writes++; };
  const starting = stage === "git" ? feature.detectDesktopGitDefaults(() => active) : feature.saveSharedSettings(() => active);
  await ready;
  active = false; release(stage === "exists" ? true : "fixture"); await starting;
  assert.equal(writes, 0, `${stage}: unloaded startup must not persist Git/config defaults`);
}
console.log("Sync startup settings: cancelled reads, local saves, shared-file checks and Git discovery cannot save stale configuration.");
