import assert from "node:assert/strict";
import vm from "node:vm";
import { build } from "esbuild";

const output = await build({ entryPoints: ["src/features/sync/index.ts"], bundle: true,
  platform: "browser", format: "cjs", external: ["obsidian"], write: false,
  loader: { ".png": "dataurl" } });
const platform = { isMobile: false };
const intervals = new Map(), timers = new Map();
let nextId = 0;
const obsidian = new Proxy({ Platform: platform }, {
  get: (target, key) => key in target ? target[key] : function () {}
});
const context = vm.createContext({ module: { exports: {} }, require: () => obsidian, console,
  setInterval: callback => { const id = ++nextId; intervals.set(id, callback); return id; },
  clearInterval: id => intervals.delete(id),
  setTimeout: callback => { const id = ++nextId; timers.set(id, callback); return id; },
  clearTimeout: id => timers.delete(id) });
context.window = context;
vm.runInContext(output.outputFiles[0].text, context);
const Sync = context.module.exports.default;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(mobile = false) {
  platform.isMobile = mobile;
  intervals.clear(); timers.clear();
  const calls = [];
  const sync = new Sync({ app: {
    vault: { offref: () => {} },
    workspace: { detachLeavesOfType: () => {}, onLayoutReady: fn => fn() }
  } });
  Object.assign(sync.settings, { enabled: true, setupComplete: true,
    desktopGitEnabled: !mobile, mobileSyncEnabled: false,
    mobile: { mode: "server", bound: true, autoSyncMinutes: 1 },
    mobileAutoSyncMinutes: 1, commandPollSeconds: 60 });
  sync.featureActive = true;
  sync.registerViewRefreshEvents = () => calls.push("events");
  sync.registerMobileEvents = () => calls.push("mobile-events");
  sync.registerInterval = () => {};
  sync.configureDesktopAutomation = () => calls.push("git-background");
  sync.scheduleDesktopStartup = () => {
    assert.equal(sync.switchingSyncMode, true, "background is arranged before unlock");
    calls.push("git-startup-scheduled");
  };
  sync.getMobileGithub = () => ({ state: { baseCommitSha: 'fixture-existing-baseline' }, load: async () => calls.push("load") });
  sync.saveSettings = async () => {
    assert.equal(sync.switchingSyncMode, true, "settings save belongs to the transaction");
    calls.push(sync.useLightweightSync() ? "save-lightweight" : sync.nativeGitEnabled() ? "save-git" : "save-off");
  };
  sync.setStatus = text => calls.push(text);
  sync.clearSyncActivity = () => {};
  sync.refreshSyncView = async () => {};
  return { sync, calls };
}

// A delayed engine load cannot admit another switch, manual sync or queued Git.
for (const mobile of [false, true]) {
  const { sync, calls } = fixture(mobile);
  const loading = deferred();
  sync.getMobileGithub = () => ({ load: async () => { calls.push("load"); await loading.promise; } });
  const pending = mobile ? sync.setLightweightSyncEnabled(true) : sync.setDesktopSyncMode("lightweight");
  assert.equal(sync.switchingSyncMode, true, "lock precedes the first await");
  assert.equal(sync.featureActive, false, "old background stops immediately");
  await flush();
  assert.deepEqual(calls, ["load"]);
  await sync.syncNow(false);
  await sync.commitNow(false);
  await sync.setFeatureEnabled(false);
  await sync.testConnection(false);
  assert.equal(sync.settings.enabled, true, "the master switch cannot race the mode transaction");
  assert.equal(sync.syncing, false);
  await assert.rejects(sync.enqueueDesktopGit(async () => assert.fail("must not run")), /模式切换/);
  await assert.rejects(sync.enqueueSetupGit(async () => assert.fail("must not run")), /模式切换/);
  await assert.rejects(sync.beginSetup(), /模式切换/);
  if (mobile) await sync.setLightweightSyncEnabled(false);
  else await sync.setDesktopSyncMode("off");
  assert.deepEqual(calls, ["load"], "second switch does not load or save");
  loading.resolve();
  await pending;
  assert.equal(sync.switchingSyncMode, false);
  assert.equal(sync.useLightweightSync(), true);
  assert.equal(sync.featureActive, true);
  assert.equal(calls.filter(value => value === "load").length, 1);
  assert.equal(timers.size, 0, "activating GitHub API does not await or start a first network sync");
  // Once settled, subsequent switches can proceed normally.
  if (mobile) await sync.setLightweightSyncEnabled(false);
  else await sync.setDesktopSyncMode("off");
  assert.equal(sync.useLightweightSync(), false);
  if (mobile) await sync.setLightweightSyncEnabled(true);
  else await sync.setDesktopSyncMode("git");
  assert.equal(sync.switchingSyncMode, false);
}

// An active native job finishes with its original settings. Jobs not started are rejected.
{
  const { sync, calls } = fixture();
  const running = deferred();
  const active = sync.enqueueDesktopGit(async () => {
    calls.push("native-start");
    await running.promise;
    assert.equal(sync.nativeGitEnabled(), true);
    calls.push("native-end");
  });
  await flush();
  const queued = sync.enqueueDesktopGit(async () => assert.fail("queued old task must not run"));
  const rejected = assert.rejects(queued, /模式切换/);
  const pending = sync.setDesktopSyncMode("lightweight");
  await flush();
  assert.deepEqual(calls, ["native-start"]);
  assert.equal(sync.desktopTaskActive, true);
  running.resolve();
  await Promise.all([active, rejected, pending]);
  assert(calls.indexOf("native-end") < calls.indexOf("load"));
  assert.equal(sync.desktopTaskActive, false);
  assert.equal(sync.useLightweightSync(), true);
}

// Persisting the new selection is part of the lock, even after in-memory flags change.
{
  const { sync } = fixture();
  const saving = deferred();
  sync.saveSettings = async () => { await saving.promise; };
  const pending = sync.setDesktopSyncMode("lightweight");
  await flush();
  assert.equal(sync.useLightweightSync(), true);
  assert.equal(sync.switchingSyncMode, true);
  assert.equal(sync.featureActive, false);
  await sync.syncNow(false);
  await sync.setDesktopSyncMode("git");
  assert.equal(sync.syncing, false);
  assert.equal(sync.useLightweightSync(), true);
  saving.resolve();
  await pending;
  assert.equal(sync.featureActive, true);
  assert.equal(sync.switchingSyncMode, false);
}

// Load/save/activation failures restore both settings and background while still locked.
for (const mobile of [false, true]) {
  for (const stage of ["load", "save", "activate"]) {
    const { sync, calls } = fixture(mobile);
    const oldMode = sync.settings.mobile.mode;
    const save = sync.saveSettings.bind(sync), activate = sync.activateFeature.bind(sync);
    let saves = 0, activations = 0;
    sync.getMobileGithub = () => ({ load: async () => { if (stage === "load") throw new Error("load failed"); } });
    sync.saveSettings = async () => { if (++saves === 1 && stage === "save") throw new Error("save failed"); await save(); };
    sync.activateFeature = () => { if (++activations === 1 && stage === "activate") throw new Error("activate failed"); activate(); };
    await assert.rejects(mobile ? sync.setLightweightSyncEnabled(true) : sync.setDesktopSyncMode("lightweight"), new RegExp(`${stage} failed`));
    assert.equal(sync.switchingSyncMode, false);
    assert.equal(sync.featureActive, true);
    assert.equal(sync.useLightweightSync(), false);
    assert.equal(sync.nativeGitEnabled(), !mobile);
    assert.equal(sync.settings.mobile.mode, oldMode);
    assert.equal(saves, stage === "load" ? 0 : 2);
    if (!mobile) assert(calls.includes("git-startup-scheduled"));
  }
}
{
  const { sync, calls } = fixture();
  sync.saveSettings = async () => { throw new Error("disk unavailable"); };
  await assert.rejects(sync.setDesktopSyncMode("lightweight"), /恢复旧模式失败.*disk unavailable.*同步已停止/);
  assert.equal(sync.switchingSyncMode, false);
  assert.equal(sync.featureActive, false);
  assert.equal(sync.settings.enabled, false, "failed rollback stops manual and background syncing in this session");
  assert(calls.some(value => value.includes("恢复旧模式失败")));
}

// Cleared callbacks may already be queued: neither off, Git, nor a later API activation revives them.
for (const mobile of [false, true]) {
  for (const mode of ["github", "server"]) {
    const { sync } = fixture(mobile);
    sync.settings.desktopGitEnabled = false;
    sync.settings.desktopLightweightEnabled = !mobile;
    sync.settings.mobileSyncEnabled = mobile;
    sync.settings.mobile.mode = mode;
    const started = [];
    sync.syncNow = async () => started.push("sync");
    sync.pollCommands = async () => started.push("poll");
    sync.restartMobileAutomation();
    const stale = [...intervals.values()];
    for (const callback of stale) callback();
    assert(started.includes("sync"), "current callback works");
    started.length = 0;
    sync.switchingSyncMode = true;
    for (const callback of stale) callback();
    assert.deepEqual(started, []);
    sync.switchingSyncMode = false;
    sync.restartMobileAutomation();
    for (const callback of stale) callback();
    assert.deepEqual(started, [], "a restarted timer invalidates already queued callbacks");
    const previousActivation = [...intervals.values()];
    if (mobile) await sync.setLightweightSyncEnabled(false);
    else await sync.setDesktopSyncMode("git");
    for (const callback of previousActivation) callback();
    assert.deepEqual(started, [], "old API timers cannot sync the new mode");
    if (mobile) await sync.setLightweightSyncEnabled(true);
    else await sync.setDesktopSyncMode("lightweight");
    for (const callback of [...stale, ...previousActivation]) callback();
    assert.deepEqual(started, [], "returning to API mode does not revive a previous generation");
    for (const callback of intervals.values()) callback();
    assert.deepEqual(started, ["sync"]);
  }
}

// A server connection timeout and an in-flight poll must not revive a stopped generation.
{
  const { sync } = fixture(true);
  sync.settings.mobileSyncEnabled = true;
  sync.featureActive = false;
  let registrations = 0;
  sync.registerMobile = async () => { registrations++; };
  sync.activateFeature();
  const staleRegistration = [...timers.values()][0];
  assert.equal(typeof staleRegistration, "function");
  await sync.setLightweightSyncEnabled(false);
  staleRegistration();
  assert.equal(registrations, 0);
}
{
  const { sync } = fixture(true);
  sync.settings.mobileSyncEnabled = true;
  sync.settings.serverUrl = "https://fixture.example";
  sync.settings.serverPassword = "fixture";
  const response = deferred();
  sync.serverRequest = async () => await response.promise;
  sync.handleCommands = async () => assert.fail("old response must not process commands");
  const polling = sync.pollCommands();
  await sync.setLightweightSyncEnabled(false);
  response.resolve({ commands: [{ kind: "sync" }] });
  await polling;
}
console.log("Sync mode switching: delayed load, native queue drain, concurrent switches, rollback and stale automation passed");
