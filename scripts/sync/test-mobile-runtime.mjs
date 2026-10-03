import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import vm from "node:vm";
import esbuild from "esbuild";
import { zipSync } from "fflate";

const output = resolve("../../../.codex/output");
await mkdir(output, { recursive: true });
const folder = await mkdtemp(join(output, "mobile-runtime-test-"));
try {
  const bundle = join(folder, "runtime.cjs");
  await esbuild.build({ stdin: {
    contents: 'export { default as LinkPlugin } from "./src/features/sync/index"; export { MobileGithub } from "./src/features/sync/mobileGithub"; export { extractRepositoryArchive } from "./src/features/sync/repositoryArchive"; export { blobSha } from "./src/features/sync/linkDiff"; export { ZoeySyncConflictPreviewModal } from "./src/features/sync/conflictPreview"; export { textParts, resolveTextParts } from "./src/features/sync/textDiff";',
    resolveDir: process.cwd()
  }, bundle: true, platform: "browser", format: "cjs", external: ["obsidian"],
    loader: { ".png": "dataurl" }, outfile: bundle });
  const source = await readFile(bundle, "utf8");
  for (const platform of ["android", "ios"]) {
    let response = { status: 200, headers: {}, json: { login: "fixture" } };
    const warnings = [], nodeLoads = [];
    const obsidian = new Proxy({
      Platform: { isMobile: true, isAndroidApp: platform === "android", isIosApp: platform === "ios" },
      requestUrl: async () => await response
    }, { get: (target, key) => key in target ? target[key] : function () {} });
    const context = vm.createContext({ module: { exports: {} },
      require: name => {
        if (name === "obsidian") return obsidian;
        nodeLoads.push(name); throw new Error(`Node unavailable: ${name}`);
      },
      crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer,
      setTimeout, clearTimeout, performance, atob, btoa,
      console: { warn: message => warnings.push(message) }
    });
    context.window = context;
    vm.runInContext(source, context);
    assert.deepEqual(nodeLoads, [], `${platform}: plugin loads without Node modules`);
    const { LinkPlugin, MobileGithub, extractRepositoryArchive, blobSha, ZoeySyncConflictPreviewModal, textParts, resolveTextParts } = context.module.exports;
    const zip = zipSync({ 'vault/note.md': new TextEncoder().encode('mobile archive'),
      'vault/.obsidian/plugins/unselected/main.js': new TextEncoder().encode('excluded plugin') });
    const extracted = await extractRepositoryArchive(zip, { 'note.md': { sha: 'fixture', mode: '100644' } }, () => {});
    assert.equal(extracted.size, 1);
    assert.equal(new TextDecoder().decode(extracted.get('note.md')), 'mobile archive');
    const unsafe = zipSync({ 'vault/../outside.md': new TextEncoder().encode('unsafe') });
    await assert.rejects(extractRepositoryArchive(unsafe, {}, () => {}), /路径/);
    assert.equal(typeof LinkPlugin, "function");
    let stored = { ignorePatterns: ["private/", "!private/keep.md"] };
    const settingsPlugin = { app: { vault: { configDir: ".custom" } },
      loadData: async () => stored, loadSharedSettings: async () => null,
      saveSettings: async () => {}, pruneErrorLogs: () => {} };
    await LinkPlugin.prototype.loadSettings.call(settingsPlugin);
    assert.deepEqual(Array.from(settingsPlugin.settings.ignorePatterns), stored.ignorePatterns, "explicit ignore choices are preserved");
    stored = {};
    await LinkPlugin.prototype.loadSettings.call(settingsPlugin);
    assert(settingsPlugin.settings.ignorePatterns.includes(".custom/cache/"));
    assert(settingsPlugin.settings.ignorePatterns.includes(".custom/plugins/simple-one/link-state.json*"));
    assert(!settingsPlugin.settings.ignorePatterns.includes(".custom/plugins/simple-link/data.json*"));
    assert(!settingsPlugin.settings.ignorePatterns.some(path => path.startsWith(".obsidian/")));
    const scheduled = [];
    context.window.setInterval = (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; };
    context.window.clearInterval = () => {};
    const automationPlugin = {
      useLightweightSync: () => true, featureActive: true, featureIntervals: [],
      // Old saved settings must not reactivate the removed cache timer.
      settings: { mobile: { mode: "github", cacheEnabled: true, cacheMinutes: 30, autoSyncMinutes: 0 } },
      addFeatureInterval: id => automationPlugin.featureIntervals.push(id)
    };
    LinkPlugin.prototype.restartMobileAutomation.call(automationPlugin);
    assert.equal(scheduled.length, 0, "no background hash timer, including legacy settings");
    automationPlugin.settings.mobile.autoSyncMinutes = 5;
    LinkPlugin.prototype.restartMobileAutomation.call(automationPlugin);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delay, 5 * 60000, "configured automatic sync remains available");
    let listReads = 0;
    const listState = { baseCommitSha: "fixture" };
    const listOnlyPlugin = {
      useLightweightSync: () => true, syncing: false,
      settings: { mobileSyncEnabled: true, mobile: { mode: "github", bound: true } },
      getChangeViewMode: () => "upload",
      needsLightweightBaseline: () => LinkPlugin.prototype.needsLightweightBaseline.call(listOnlyPlugin),
      app: { vault: { getFiles: () => [{ path: "note.md" }] } },
      getMobileGithub: () => ({ state: listState, cachedChanges: paths => {
        listReads++; assert.deepEqual(Array.from(paths), ["note.md"]); return [];
      }, changes: () => { throw new Error("sidebar must not scan"); } })
    };
    assert.equal((await LinkPlugin.prototype.getChanges.call(listOnlyPlugin)).length, 0);
    assert.equal(listReads, 1);
    assert.equal(LinkPlugin.prototype.getLightweightPendingStatus.call(listOnlyPlugin), undefined);
    listState.baseCommitSha = null;
    assert.equal(listOnlyPlugin.needsLightweightBaseline(), true);
    const noBaseStatus = LinkPlugin.prototype.getLightweightPendingStatus.call(listOnlyPlugin);
    assert.equal(noBaseStatus.tone, "pending");
    assert.match(noBaseStatus.text, /尚未建立同步基准/);
    assert.equal((await LinkPlugin.prototype.getChanges.call(listOnlyPlugin)).length, 0);
    assert.equal(listReads, 1, "no-baseline sidebar does not report the whole vault as candidates");
    const callbacks = [], lifecycle = { events: 0, saves: 0, refreshes: 0 };
    const fakePlugin = {
      settings: { mobile: { mode: "github" } },
      app: { workspace: { layoutReady: false }, vault: { on: (name, callback) => {
        callbacks.push({ name, callback }); return {};
      } } },
      trackFeatureEvent: () => {},
      scheduleViewRefresh: () => lifecycle.refreshes++,
      getMobileGithub: () => ({ allowed: () => true, event: () => lifecycle.events++,
        save: () => { lifecycle.saves++; return Promise.resolve(); } })
    };
    LinkPlugin.prototype.registerMobileEvents.call(fakePlugin);
    const createEvent = callbacks.find(entry => entry.name === "create").callback;
    for (let i = 0; i < 4000; i++) createEvent({ path: `existing-${i}.md` });
    assert.deepEqual(lifecycle, { events: 0, saves: 0, refreshes: 0 }, "initial vault files are not edits");
    fakePlugin.app.workspace.layoutReady = true;
    createEvent({ path: "new-note.md" });
    assert.deepEqual(lifecycle, { events: 1, saves: 1, refreshes: 1 }, "real edits are tracked after startup");
    assert.equal(await blobSha(new TextEncoder().encode("hello")), "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0");
    const options = { token: "old-token" };
    const engine = new MobileGithub({}, ".obsidian", "simple-link", () => options, () => {});
    const changes = [];
    const unsubscribe = engine.onRemainingChange(value => changes.push(value));
    response.headers = { "X-RATELIMIT-REMAINING": "42" };
    assert.equal(await engine.verifyToken(), "fixture");
    assert.equal(engine.remaining, 42);
    response.headers = { "x-ratelimit-remaining": "0" };
    await engine.verifyToken();
    assert.equal(engine.remaining, 0);
    for (const value of ["", "invalid", "-1", "1.5"]) {
      response.headers = { "x-ratelimit-remaining": value };
      await engine.verifyToken();
      assert.equal(engine.remaining, 0, "invalid headers preserve known quota");
    }
    response = { status: 429, headers: { "x-ratelimit-remaining": "0" } };
    await assert.rejects(engine.verifyToken(), /限流/);
    assert.equal(changes.at(-1), 0, "error responses also update quota");
    let finish;
    response = new Promise(resolve => { finish = resolve; });
    const pending = engine.verifyToken();
    options.token = "new-token";
    engine.resetRemaining();
    finish({ status: 200, headers: { "x-ratelimit-remaining": "99" }, json: { login: "fixture" } });
    await pending;
    assert.equal(engine.remaining, null, "old token response cannot overwrite reset quota");
    const stopBrokenListener = engine.onRemainingChange(() => { throw new Error("UI unavailable"); });
    response = { status: 200, headers: { "x-ratelimit-remaining": "20" }, json: { login: "fixture" } };
    assert.equal(await engine.verifyToken(), "fixture", "UI failure cannot break cloud operation");
    assert.equal(warnings.length, 1);
    stopBrokenListener(); unsubscribe();
    const before = changes.length;
    engine.resetRemaining();
    assert.equal(changes.length, before, "detached subscribers receive no updates");

    // Diff reconstruction preserves exact CRLF, insertions, deletions and final newline.
    for (const [local, remote] of [["", "new\n"], ["gone\n", ""], ["a\r\nb\r\nz", "a\r\nx\r\nz"],
      ["head\none\ncommon\ntwo\ntail\n", "head\nONE\ncommon\nTWO\ntail\n"],
      ["x\n".repeat(1100), "y\n".repeat(1100)]]) {
      const parts = textParts(local, remote);
      assert.equal(resolveTextParts(parts, parts.filter(p => p.common === undefined).map(p => p.local)), local);
      assert.equal(resolveTextParts(parts, parts.filter(p => p.common === undefined).map(p => p.remote)), remote);
    }
    const file = { path: "new:note.md", totalLines: 0, localUpdatedAt: "", remoteUpdatedAt: "", mergeable: true, blocks: [] };
    let reads = 0, selected;
    const review = new ZoeySyncConflictPreviewModal({}, { files: [file], read: async () => {
      reads++; return { local: "head\none\ncommon\ntwo\ntail\n", remote: "head\nONE\ncommon\nTWO\ntail\n" };
    } });
    review.render = () => {}; review.close = () => {}; review.active = true;
    review.resolve = choices => { selected = choices; };
    assert.equal(reads, 0, "collapsed review loads no file contents");
    assert.equal(review.getReadyFiles().length, 0, "unexpanded file is not silently confirmed");
    await review.loadFile(file);
    assert.equal(file.blocks.length, 2);
    review.selectBlock(file, 0, "local");
    assert.equal(review.getReadyFiles().length, 0, "every difference needs a selection");
    review.selectBlock(file, 1, "remote");
    review.applyReadyFiles();
    assert.equal(selected[file.path].choice, "manual");
    assert.equal(selected[file.path].text, "head\none\ncommon\nTWO\ntail\n");
  }
  console.log("Android/iOS browser runtime: module loading, hashing and quota checks passed");
} finally {
  await rm(folder, { recursive: true, force: true });
}
