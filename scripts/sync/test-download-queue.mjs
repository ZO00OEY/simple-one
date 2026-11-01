import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, webcrypto } from "node:crypto";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const output = resolve("../../../.codex/output");
await mkdir(output, { recursive: true });
const folder = await mkdtemp(join(output, "download-queue-test-"));
globalThis.window = globalThis;
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const hash = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const until = async condition => {
  const deadline = Date.now() + 5000;
  while (!condition()) { assert(Date.now() < deadline, "timed out waiting for queue"); await new Promise(done => setTimeout(done, 1)); }
};

try {
  const bundle = join(folder, "mobile.cjs");
  await esbuild.build({ stdin: { contents: 'export { MobileGithub } from "./src/features/sync/mobileGithub";', resolveDir: process.cwd() }, bundle: true, platform: "node", format: "cjs", outfile: bundle,
    plugins: [{ name: "mock-obsidian", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
      build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: "export const requestUrl = request => globalThis.githubRequest(request);" }));
    } }] });
  const { MobileGithub } = require(bundle);
  async function fixture(entries) {
    let clock = 1, active = 0, peak = 0, reading = 0, peakReads = 0;
    const local = new Map(), blobs = new Map(), requests = [], writes = [];
    const responseGates = new Map(), writeGates = new Map();
    const options = { repoUrl: "https://github.com/example/vault", token: "fixture", branch: "main", bound: true,
      syncImages: true, syncPlugins: false, plugins: [], ignorePatterns: [], cacheEnabled: true, trackPaths: true };
    const store = (path, bytes) => local.set(path, { bytes: Buffer.from(bytes), mtime: ++clock });
    const adapter = {
      exists: async path => local.has(path),
      read: async path => local.get(path).bytes.toString(),
      readBinary: async path => {
        reading++; peakReads = Math.max(peakReads, reading);
        try {
          await new Promise(done => setTimeout(done, 1));
          return Uint8Array.from(local.get(path).bytes).buffer;
        } finally { reading--; }
      },
      write: async (path, text) => store(path, text),
      writeBinary: async (path, bytes) => {
        writes.push(path);
        await writeGates.get(path)?.promise;
        if (path === adapter.failWrite) throw new Error("simulated disk failure");
        store(path, bytes);
      },
      remove: async path => local.delete(path), mkdir: async () => {},
      stat: async path => local.has(path) ? { type: "file", mtime: local.get(path).mtime, ctime: 1, size: local.get(path).bytes.length } : null,
      list: async dir => {
        const prefix = dir === "/" ? "" : `${dir}/`, files = [], folders = new Set();
        for (const path of local.keys()) {
          if (!path.startsWith(prefix)) continue;
          const rest = path.slice(prefix.length);
          if (rest.includes("/")) folders.add(prefix + rest.split("/")[0]); else files.push(path);
        }
        return { files, folders: [...folders] };
      }
    };
    globalThis.githubRequest = async request => {
      const sha = request.url.split("/git/blobs/")[1];
      assert(blobs.has(sha), `unexpected request ${request.url}`);
      requests.push(sha); active++; peak = Math.max(peak, active);
      try {
        await responseGates.get(sha)?.promise;
        return { status: 200, headers: { "content-type": "application/octet-stream" }, arrayBuffer: Uint8Array.from(blobs.get(sha)).buffer };
      } finally { active--; }
    };
    const engine = new MobileGithub(adapter, ".obsidian", "simple-one", () => options, () => {});
    await engine.load();
    // Direct applyPending fixtures start after the confirmed root-rule migration.
    await engine.prepareLocalRules();
    await engine.refreshRules();
    const base = {}, actions = [];
    for (const entry of entries) {
      const bytes = Buffer.from(entry.bytes ?? entry.path), sha = entry.delete ? null : hash(bytes);
      if (sha !== null) { blobs.set(sha, bytes); base[entry.path] = { sha, mode: "100644" }; }
      if (entry.local !== undefined) store(entry.path, entry.local);
      actions.push({ path: entry.path, sha, expected: entry.local === undefined ? null : hash(Buffer.from(entry.local)),
        size: entry.unknown ? undefined : entry.size ?? bytes.length });
    }
    const scope = engine.scope();
    engine.state.pending = { commit: "next", parent: "old", base, actions, revision: 0, paths: { moves: {} }, scope };
    engine.state.downloadVerification = { phase: "downloading", scope, commit: "next", files: base };
    return { engine, adapter, local, requests, writes, actions, responseGates, writeGates, store, peak: () => peak, peakReads: () => peakReads };
  }

  // A completed group refills the queue while another initial request is still blocked.
  {
    const f = await fixture(["a", "b", "c", "d", "e"].map(path => ({ path: `${path}.md` })));
    const first = gate(); f.responseGates.set(f.actions[0].sha, first);
    const run = f.engine.applyPending();
    await until(() => f.requests.length >= 4);
    assert(!f.local.has("a.md")); assert(f.requests.length <= 5);
    first.resolve(); await run;
    assert(f.peak() <= 3); assert.equal(f.engine.state.pending, undefined);
    assert.equal(f.engine.state.baseCommitSha, "next");
    for (const { path, sha } of f.actions) assert.equal(f.engine.state.cache[path].rawSha, sha);
  }
  // Reservations cover completed payloads waiting to write, not only HTTP requests.
  {
    const f = await fixture([1, 2, 3].map(n => ({ path: `${n}.bin`, bytes: Buffer.alloc(4 * 1024 * 1024, n) })));
    const disk = gate();
    for (const { path } of f.actions) f.writeGates.set(path, disk);
    const run = f.engine.applyPending();
    await until(() => f.writes.length === 1 && f.requests.length === 2);
    await new Promise(done => setTimeout(done, 10));
    assert.equal(f.requests.length, 2, "two 4 MiB payloads exhaust the 8 MiB budget until disk completes");
    disk.resolve(); await run;
  }
  // Unknown legacy sizes and an oversized payload get an exclusive slot.
  for (const entry of [{ path: "unknown.md", unknown: true }, { path: "large.bin", bytes: Buffer.alloc(9 * 1024 * 1024, 7) }]) {
    const f = await fixture([entry, { path: "after.md" }]);
    const first = gate(); f.responseGates.set(f.actions[0].sha, first);
    const run = f.engine.applyPending();
    await until(() => f.requests.length === 1);
    await new Promise(done => setTimeout(done, 10));
    assert.equal(f.requests.length, 1);
    first.resolve(); await run; assert.equal(f.peak(), 1);
  }
  // Identical blobs download once for several paths and still verify each target.
  {
    const f = await fixture(["a.md", "b.md", "c.md"].map(path => ({ path, bytes: "same" })));
    await f.engine.applyPending(); assert.equal(f.requests.length, 1); assert.equal(f.writes.length, 3);
  }
  // Large local predecessors and deletions must not bypass the remote payload budget.
  {
    const f = await fixture([
      { path: "replace-a.md", bytes: "small-a", local: Buffer.alloc(12 * 1024 * 1024, 1) },
      { path: "replace-b.md", bytes: "small-b", local: Buffer.alloc(12 * 1024 * 1024, 2) },
      { path: "delete.md", delete: true, local: Buffer.alloc(12 * 1024 * 1024, 3) }
    ]);
    await f.engine.applyPending();
    assert.equal(f.peakReads(), 1, "local reads are serialized even for small remote replacements and deletes");
    assert.equal(f.local.get("replace-a.md").bytes.toString(), "small-a");
    assert.equal(f.local.has("delete.md"), false);
  }
  // Corrupt bytes or incorrect size stop before writing and preserve pending + baseline.
  for (const corrupt of [false, true]) {
    const f = await fixture([{ path: "safe.md", bytes: "cloud", size: corrupt ? 5 : 99 }]);
    if (corrupt) {
      const upstream = globalThis.githubRequest;
      globalThis.githubRequest = async request => ({ ...await upstream(request), arrayBuffer: Uint8Array.from(Buffer.from("wrong")).buffer });
    }
    await assert.rejects(f.engine.applyPending(), corrupt ? /校验失败/ : /大小/);
    assert.equal(f.writes.length, 0); assert(f.engine.state.pending); assert.equal(f.engine.state.baseCommitSha, null);
  }
  // A local edit while downloading is retained by the immediate pre-write check.
  {
    const f = await fixture([{ path: "edited.md", bytes: "cloud", local: "old" }]);
    const download = gate(); f.responseGates.set(f.actions[0].sha, download);
    const run = f.engine.applyPending();
    await until(() => f.requests.length === 1);
    f.store("edited.md", "user edit"); download.resolve();
    await run;
    assert.equal(f.local.get("edited.md").bytes.toString(), "user edit");
    assert.equal(f.engine.state.pending, undefined); assert.equal(f.engine.state.baseCommitSha, null);
    assert.equal(f.engine.needsLocalRecheck, true);
    assert.equal(f.engine.state.localRecheck.receipts['edited.md'].applied, false, 'a pre-write edit never becomes an accepted common baseline');
  }
  // Failure drains the slow request, stops dispatch and leaves no later background write.
  {
    const f = await fixture(["bad.md", "slow.md", "third.md", "never.md"].map(path => ({ path })));
    const slow = gate(), third = gate();
    f.responseGates.set(f.actions[1].sha, slow); f.responseGates.set(f.actions[2].sha, third);
    f.adapter.failWrite = "bad.md";
    let settled = false;
    const run = f.engine.applyPending();
    const result = assert.rejects(run, /disk failure/).then(() => { settled = true; });
    await until(() => f.writes.includes("bad.md"));
    await new Promise(done => setTimeout(done, 10));
    assert.equal(settled, false); assert.equal(f.requests.length, 3);
    slow.resolve(); third.resolve(); await result;
    const writes = [...f.writes]; await new Promise(done => setTimeout(done, 10));
    assert.deepEqual(f.writes, writes); assert.deepEqual(writes, ["bad.md"]);
    assert(f.engine.state.pending); assert.equal(f.engine.state.baseCommitSha, null);
    f.adapter.failWrite = undefined; await f.engine.applyPending();
    assert.equal(f.engine.state.pending, undefined, "a retry completes the same pending transaction");
  }
  {
    const f = await fixture([{ path: "done.md", local: "done.md" }, { path: "bad.md" }]);
    f.engine.state.pending.transfer = { mode: "automatic", downloads: 2, total: 2, createdAt: Date.now() };
    f.adapter.failWrite = "bad.md";
    await assert.rejects(f.engine.applyPending(), /disk failure/);
    assert.equal(f.engine.downloadTask.completed, 1, "completed downloads exclude failed writes");
    const saved = JSON.parse(f.local.get(".obsidian/plugins/simple-one/sync-api-local.json").bytes.toString());
    assert.equal(saved.state.pending.transfer.completed, 1, "interrupted download counts survive restart");
  }
  console.log("Download queue: refill, 3 slots, 8 MiB reservations, exclusive large/unknown, SHA reuse, guards, failure drain and saved progress passed");
} finally { await rm(folder, { recursive: true, force: true }); }
