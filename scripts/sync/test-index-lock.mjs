import assert from "node:assert/strict";
import vm from "node:vm";
import { build } from "esbuild";

const output = await build({ entryPoints: ["src/features/sync/index.ts"], bundle: true,
  platform: "browser", format: "cjs", external: ["obsidian"], write: false,
  loader: { ".png": "dataurl" } });
const obsidian = new Proxy({}, { get: () => function () {} });
const context = vm.createContext({ module: { exports: {} }, require: () => obsidian, console,
  process: { platform: "win32", env: {} } });
context.window = context;
context.setTimeout = setTimeout; context.clearTimeout = clearTimeout;
vm.runInContext(output.outputFiles[0].text, context);
const Sync = context.module.exports.default;
function fixture() {
  const sync = Object.create(Sync.prototype);
  const stat = { size: 0, mtimeMs: Date.now() - 600000, isFile: () => true };
  let removed = false;
  sync.indexLock = async () => ({ path: "index.lock", stat,
    fs: { lstat: async () => stat, unlink: async () => { removed = true; } } });
  sync.exec = async () => "";
  return { sync, stat, removed: () => removed };
}
let f = fixture();
assert.equal(await f.sync.cleanIndexLock(), true);
assert.equal(f.removed(), true);
// Explicit confirmation allows recent/nonempty locks without inspecting processes.
for (const props of [{ size: 10 }, { mtimeMs: Date.now() }]) {
  f = fixture(); Object.assign(f.stat, props);
  f.sync.exec = async () => { throw new Error("must not inspect processes"); };
  assert.equal(await f.sync.cleanIndexLock(), true);
  assert.equal(f.removed(), true);
}
f = fixture(); f.stat.isFile = () => false;
await assert.rejects(() => f.sync.cleanIndexLock(), /不是普通文件/);
assert.equal(f.removed(), false);
f = fixture();
const original = await f.sync.indexLock();
original.fs.unlink = async () => { throw new Error("access denied"); };
f.sync.indexLock = async () => original;
await assert.rejects(() => f.sync.cleanIndexLock(), /access denied/);
f = fixture(); f.sync.indexLock = async () => null;
assert.equal(await f.sync.cleanIndexLock(), false);

f = fixture();
Object.assign(f.sync, { enqueueDesktopGit: async task => task(), ensureDesktopGit: async () => {},
  getInterruptedGitOperation: async () => null, refreshSyncView: async () => {},
  getActiveSyncError: () => null, clearDesktopTimeouts: () => {},
  interruptGitProcesses: async () => {},
  desktopCommitOnly: async () => { throw new Error("must not commit for lock-only repair"); } });
assert.equal((await f.sync.repairInterruptedGitOperation()).lockOnly, true);
for (const [message, expected] of [["fatal: Unable to create '.git/index.lock': File exists", true], ["authentication failed", false]]) {
  let resolved = false;
  f.sync.getActiveSyncError = () => ({ message });
  f.sync.recordSuccess = async (context) => { assert.equal(context, "同步修复"); resolved = true; };
  await f.sync.repairInterruptedGitOperation();
  assert.equal(resolved, expected);
}
const order = [];
f.sync.clearDesktopTimeouts = () => order.push("pause");
f.sync.interruptGitProcesses = async () => { order.push("interrupt"); };
f.sync.enqueueDesktopGit = async task => { order.push("queue"); await task(); };
await f.sync.repairInterruptedGitOperation();
assert.deepEqual(order, ["pause", "interrupt", "queue"]);
f.sync.interruptGitProcesses = async () => { throw new Error("cannot stop Git"); };
order.length = 0;
await assert.rejects(() => f.sync.repairInterruptedGitOperation(), /cannot stop Git/);
assert.deepEqual(order, ["pause"]);
// Interrupt only the exact current-instance child PID; no global process lookup.
f = fixture();
let finish;
const finished = new Promise(resolve => { finish = resolve; });
const child = { pid: 12345, exitCode: null, signalCode: null };
f.sync.desktopGitProcesses = new Map([[child, finished]]);
const calls = [];
f.sync.exec = async (program, args) => {
  calls.push([program, [...args]]);
  f.sync.desktopGitProcesses.delete(child);
  finish();
};
await f.sync.interruptGitProcesses();
assert.deepEqual(calls, [["taskkill.exe", ["/PID", "12345", "/T", "/F"]]]);
calls.length = 0;
await f.sync.interruptGitProcesses();
assert.deepEqual(calls, []);
console.log("index lock repair checks passed");
