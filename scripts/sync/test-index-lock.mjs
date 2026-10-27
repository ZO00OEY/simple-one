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
for (const processName of ["git", "git.exe", "git-remote-https", "scalar"]) {
  f = fixture(); f.sync.exec = async () => processName;
  await assert.rejects(() => f.sync.cleanIndexLock(), /Git 进程/);
  assert.equal(f.removed(), false);
}
for (const props of [{ size: 10 }, { mtimeMs: Date.now() }, { isFile: () => false }]) {
  f = fixture(); Object.assign(f.stat, props);
  await assert.rejects(() => f.sync.cleanIndexLock(), /已保留/);
  assert.equal(f.removed(), false);
}
f = fixture(); f.sync.exec = async () => { throw new Error("process inspection failed"); };
await assert.rejects(() => f.sync.cleanIndexLock(), /无法确认/);
assert.equal(f.removed(), false);
f = fixture();
const original = await f.sync.indexLock();
original.fs.lstat = async () => ({ ...f.stat, mtimeMs: f.stat.mtimeMs + 1 });
f.sync.indexLock = async () => original;
await assert.rejects(() => f.sync.cleanIndexLock(), /发生变化/);
assert.equal(f.removed(), false);
f = fixture(); f.sync.indexLock = async () => null;
assert.equal(await f.sync.cleanIndexLock(), false);

f = fixture();
Object.assign(f.sync, { enqueueDesktopGit: async task => task(), ensureDesktopGit: async () => {},
  getInterruptedGitOperation: async () => null, refreshSyncView: async () => {},
  desktopCommitOnly: async () => { throw new Error("must not commit for lock-only repair"); } });
assert.equal((await f.sync.repairInterruptedGitOperation()).lockOnly, true);
console.log("index lock repair checks passed");
