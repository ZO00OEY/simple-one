import assert from "node:assert/strict";
import vm from "node:vm";
import { build } from "esbuild";

const output = await build({ entryPoints: ["src/features/sync/index.ts"], bundle: true,
  platform: "browser", format: "cjs", external: ["obsidian"], write: false,
  loader: { ".png": "dataurl" } });
let now = 1, nextId = 0;
const timers = new Map();
const obsidian = new Proxy({ Platform: { isMobile: false } }, {
  get: (target, key) => key in target ? target[key] : function () {}
});
const context = vm.createContext({ module: { exports: {} }, require: () => obsidian,
  console, Date: class extends Date { static now() { return now; } },
  setTimeout: (fn, delay) => { const id = ++nextId; timers.set(id, { at: now + delay, fn }); return id; },
  clearTimeout: id => timers.delete(id) });
context.window = context;
vm.runInContext(output.outputFiles[0].text, context);
const Sync = context.module.exports.default;
const minute = 60_000;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
async function advance(minutes) {
  const end = now + minutes * minute;
  while (true) {
    const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    now = due[1].at; timers.delete(due[0]); due[1].fn(); await flush();
  }
  now = end; await flush();
}
function fixture() {
  timers.clear(); now = 1;
  const calls = [];
  const sync = Object.create(Sync.prototype);
  Object.assign(sync, { settings: { setupComplete: true, autoCommitIdleMinutes: 5, maxUncommittedMinutes: 30 },
    firstUncommittedAt: 0, automaticBackupQueued: false, automaticPushQueued: false,
    enqueueDesktopGit: async task => await task(),
    desktopCommitOnly: async () => { calls.push("commit"); sync.resetDesktopCommitTracking(); return { committed: true }; },
    hasDesktopChanges: async () => false,
    getInterruptedGitOperation: async () => null, getUnmergedPaths: async () => [], setStatus: () => {},
    desktopPushOnly: async () => { calls.push("push"); return true; } });
  return { sync, calls };
}

let { sync, calls } = fixture();
sync.scheduleDesktopCommit();
await advance(4); assert.deepEqual(calls, []);
await advance(1); assert.deepEqual(calls, ["commit", "push"], "five idle minutes commit then push");
await advance(30); assert.equal(calls.length, 2, "the other deadline is cancelled after backup");

({ sync, calls } = fixture());
sync.scheduleDesktopCommit();
for (let i = 0; i < 7; i++) { await advance(4); sync.scheduleDesktopCommit(); }
assert.deepEqual(calls, []);
await advance(2); assert.deepEqual(calls, ["commit", "push"], "continuous edits cannot postpone the thirty-minute deadline");
sync.scheduleDesktopCommit();
await advance(5); assert.equal(calls.length, 4, "new changes begin a fresh backup cycle");

({ sync, calls } = fixture());
sync.desktopPushOnly = async () => { calls.push("push-failed"); throw new Error("offline"); };
sync.scheduleDesktopCommit(); await advance(5);
assert.deepEqual(calls, ["commit", "push-failed"]);
sync.desktopPushOnly = async () => { calls.push("push-retry"); return true; };
await sync.scheduleDesktopPushRetry();
await advance(4); assert.equal(calls.length, 2);
await advance(1);
assert.deepEqual(calls, ["commit", "push-failed", "push-retry"], "retry uploads the existing commit without another commit");

({ sync, calls } = fixture());
sync.automaticPushQueued = true;
await sync.runAutomaticCommit();
assert.deepEqual(calls, ["commit", "push"], "an existing upload must not swallow a backup deadline");

({ sync, calls } = fixture());
await Promise.all([sync.runAutomaticCommit(), sync.runAutomaticCommit()]);
assert.deepEqual(calls, ["commit", "push"], "simultaneous idle and maximum deadlines produce one backup");
sync.settings.autoCommitIdleMinutes = 0; sync.settings.maxUncommittedMinutes = 0;
sync.scheduleDesktopCommit(); await advance(60);
assert.equal(calls.length, 2, "disabled backup triggers stay disabled");
console.log("Desktop backup: idle, continuous editing, new cycles, offline upload retry and concurrent deadlines passed");

for (const [pull, backup, expected] of [
  [false, false, []], [true, false, ['fetch']],
  [false, true, ['fetch', 'commit', 'push']], [true, true, ['fetch', 'commit', 'push']]
]) {
  const f = fixture();
  f.sync.settings.pullOnStartup = pull;
  f.sync.settings.backupOnStartup = backup;
  f.sync.desktopFetchAndMerge = async () => { f.calls.push('fetch'); return true; };
  f.sync.desktopPushOnly = async fetch => { f.calls.push(fetch ? 'push-with-fetch' : 'push'); return true; };
  await f.sync.desktopStartupSync();
  assert.deepEqual(f.calls, expected, `startup sync order: pull=${pull}, backup=${backup}`);
}
{
  const f = fixture();
  Object.assign(f.sync.settings, { pullOnStartup: false, backupOnStartup: true });
  f.sync.desktopFetchAndMerge = async () => { f.calls.push('fetch-deferred'); throw new Error('overlapping local edits'); };
  await assert.rejects(f.sync.desktopStartupSync(), /overlapping local edits/);
  assert.deepEqual(f.calls, ['fetch-deferred'], 'deferred startup merge cannot proceed to commit or push');
}
{
  const f = fixture();
  f.sync.getUnpushedCommitWindow = async () => ({ count: 1 });
  await f.sync.resumeDesktopDirtyState(false);
  await flush();
  assert.deepEqual(f.calls, [], 'startup recovery does not bypass the disabled startup upload switch');
}
console.log('Desktop startup: fetch-only mode, fetch-before-backup order and deferred merge protection passed');

for (const saved of [{}, { pullOnStartup: true, backupOnStartup: true }]) {
  const f = fixture();
  Object.assign(f.sync, {
    host: { app: { vault: { configDir: '.obsidian' } } },
    loadData: async () => ({ deviceId: 'test-device', deviceName: 'Test', ...saved }),
    loadSharedSettings: async () => null,
    pruneErrorLogs: () => {},
    saveSettings: async () => {}
  });
  await f.sync.loadSettings();
  assert.equal(f.sync.settings.backupOnStartup, !!saved.backupOnStartup);
  assert.equal(f.sync.settings.pullOnStartup, !saved.backupOnStartup,
    'default fetch-only mode and backup priority for old overlapping settings');
}

// Setup uses the same queue without requiring an already completed connection.
{
  const setup = Object.create(Sync.prototype);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const order = [];
  Object.assign(setup, { desktopGitQueue: pending, host: { app: {} }, settings: { setupComplete: false },
    clearDesktopTimeouts: () => order.push('pause'), nativeGitEnabled: () => false });
  const inspection = setup.enqueueSetupGit(async () => { order.push('inspect'); return 'ready'; });
  assert.equal(setup.setupGitPaused, true);
  assert.deepEqual(order, ['pause']);
  await assert.rejects(setup.enqueueDesktopGit(async () => {}), /后台 Git 同步已暂停/);
  release();
  assert.equal(await inspection, 'ready');
  assert.deepEqual(order, ['pause', 'inspect']);
  assert.equal(setup.desktopTaskActive, false);
  await assert.rejects(setup.enqueueSetupGit(async () => { throw Error('fixture failure'); }), /fixture failure/);
  assert.equal(await setup.enqueueSetupGit(async () => 'retry'), 'retry');
}
console.log('Desktop setup queue: first connection, background pause, serialization and retry passed');
