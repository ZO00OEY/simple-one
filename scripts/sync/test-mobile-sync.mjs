import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, webcrypto } from "node:crypto";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const output = resolve("../../../.codex/output");
await mkdir(output, { recursive: true });
const folder = await mkdtemp(join(output, "mobile-sync-test-"));
globalThis.window = globalThis;
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const hash = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
try {
  const bundle = join(folder, "mobile.cjs");
  await esbuild.build({ stdin: { contents: 'export { MobileGithub } from "./src/features/sync/mobileGithub"; export { downloadSummary, mirrorPlan, strategyChoices } from "./src/features/sync/syncPlan";', resolveDir: process.cwd() }, bundle: true, platform: "node", format: "cjs", outfile: bundle,
    plugins: [{ name: "mock-obsidian", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
      build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: "export const requestUrl = request => globalThis.githubRequest(request);" }));
    } }] });
  const { MobileGithub, downloadSummary, mirrorPlan, strategyChoices } = require(bundle);
  async function fixture(localTexts, remoteTexts) {
    let clock = 100, head = "c0", root = "t0", commitIndex = 0, treeIndex = 0;
    const local = new Map(), blobs = new Map(), trees = new Map(), commits = new Map(), calls = [];
    const storeBlob = value => { const bytes = Buffer.from(value); const sha = hash(bytes); blobs.set(sha, bytes); return sha; };
    for (const [path, text] of Object.entries(localTexts)) local.set(path, { bytes: Buffer.from(text), mtime: ++clock });
    const remote = Object.fromEntries(Object.entries(remoteTexts).map(([path, text]) => [path, { sha: storeBlob(text), mode: "100644" }]));
    trees.set(root, remote); commits.set(head, { tree: root, parent: null });
    let failWrite = "";
    const adapter = {
      exists: async path => local.has(path),
      read: async path => local.get(path).bytes.toString(),
      readBinary: async path => Uint8Array.from(local.get(path).bytes).buffer,
      write: async (path, text) => local.set(path, { bytes: Buffer.from(text), mtime: ++clock }),
      writeBinary: async (path, bytes) => {
        if (path === failWrite) throw new Error("simulated disk failure");
        local.set(path, { bytes: Buffer.from(bytes), mtime: ++clock });
      },
      remove: async path => local.delete(path),
      rmdir: async path => { for (const key of local.keys()) if (key.startsWith(path + '/')) local.delete(key); },
      mkdir: async () => {},
      stat: async path => local.has(path) ? { type: "file", mtime: local.get(path).mtime, ctime: 1, size: local.get(path).bytes.length } : null,
      list: async dir => {
        const prefix = dir === "/" ? "" : `${dir}/`;
        const files = [], folders = new Set();
        for (const path of local.keys()) {
          if (!path.startsWith(prefix)) continue;
          const rest = path.slice(prefix.length);
          if (rest.includes("/")) folders.add(prefix + rest.split("/")[0]); else files.push(path);
        }
        return { files, folders: [...folders] };
      }
    };
    globalThis.githubRequest = async request => {
      const path = new URL(request.url).pathname.replace("/repos/example/vault", "");
      const body = request.body ? JSON.parse(request.body) : undefined;
      calls.push({ path, method: request.method, body });
      let json;
      if (path === "") json = { default_branch: "main", permissions: { push: true } };
      else if (path === "/commits/main") json = { sha: head, commit: { tree: { sha: root } } };
      else if (path === "/git/ref/heads/main") json = { object: { sha: head } };
      else if (path.startsWith("/compare/")) {
        const [base] = path.slice(9).split("...");
        const old = trees.get(commits.get(base).tree), now = trees.get(root);
        json = { status: base === head ? "identical" : "ahead", files: [...new Set([...Object.keys(old), ...Object.keys(now)])]
          .filter(p => old[p]?.sha !== now[p]?.sha).map(filename => ({ filename, status: !now[filename] ? "removed" : !old[filename] ? "added" : "modified", sha: now[filename]?.sha })) };
      } else if (path.startsWith("/zipball/")) {
        const commit = path.slice('/zipball/'.length);
        const entries = trees.get(commits.get(commit).tree);
        const zip = zipSync(Object.fromEntries(Object.entries(entries).map(([name, entry]) =>
          [`vault-${commit}/${name}`, Uint8Array.from(blobs.get(entry.sha))])));
        return { status: 200, headers: { 'content-type': 'application/zip' }, arrayBuffer: zip.buffer };
      } else if (path.startsWith("/git/trees/")) {
        json = { truncated: false, tree: Object.entries(trees.get(path.slice(11))).map(([path, entry]) => ({ path, ...entry, type: "blob" })) };
      } else if (path.startsWith("/git/blobs/")) {
        const bytes = blobs.get(path.slice(11));
        return { status: 200, headers: { "content-type": "application/octet-stream" }, arrayBuffer: Uint8Array.from(bytes).buffer };
      } else if (path === "/git/blobs") json = { sha: storeBlob(Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8")) };
      else if (path === "/git/trees") {
        const next = { ...trees.get(body.base_tree) };
        for (const item of body.tree) {
          if (item.sha === null) delete next[item.path];
          else next[item.path] = { sha: item.sha ?? storeBlob(item.content), mode: item.mode };
        }
        const sha = `t${++treeIndex}`; trees.set(sha, next); json = { sha };
      } else if (path === "/git/commits") {
        const sha = `c${++commitIndex}`; commits.set(sha, { tree: body.tree, parent: body.parents[0] }); json = { sha };
      } else if (path === "/git/refs/heads/main") {
        assert.equal(body.force, false);
        assert.equal(commits.get(body.sha).parent, head);
        head = body.sha; root = commits.get(head).tree; json = { object: { sha: head } };
      } else throw new Error(`Unexpected API ${request.method} ${path}`);
      return { status: 200, headers: {}, json };
    };
    const options = { repoUrl: "https://github.com/example/vault.git", token: "fixture", branch: "main", bound: true,
      syncImages: true, syncPlugins: false, plugins: [], ignorePatterns: [], cacheEnabled: true, trackPaths: true };
    const progress = [];
    const engine = new MobileGithub(adapter, ".obsidian", "simple-link", () => options, message => progress.push(message));
    await engine.bind();
    return { engine, adapter, local, calls, options, progress, remote: () => trees.get(root), head: () => head, root: () => root,
      fail: path => { failWrite = path; },
      move: (from, to) => { local.set(to, local.get(from)); local.delete(from); engine.event("rename", to, from); },
      cloudEdit: (path, text) => {
        const next = { ...trees.get(root), [path]: { sha: storeBlob(text), mode: "100644" } };
        const parent = head; root = `t${++treeIndex}`; trees.set(root, next); head = `c${++commitIndex}`; commits.set(head, { tree: root, parent });
      } };
  }
  // Malformed successful API responses must never become inferred deletions.
  {
    const f = await fixture({ "keep.md": "keep" }, { "keep.md": "keep" });
    const upstream = globalThis.githubRequest;
    const invalidTrees = [undefined, null, {}, { truncated: false },
      { truncated: false, tree: [{ path: "keep.md", sha: "x", mode: "100644", type: "unexpected" }] },
      { truncated: false, tree: [{ path: "../outside.md", sha: "x", mode: "100644", type: "blob" }] }];
    const writesBefore = f.calls.filter(call => call.method !== "GET").length;
    for (const json of invalidTrees) {
      globalThis.githubRequest = async request => request.url.includes("/git/trees/")
        ? { status: 200, headers: {}, json } : upstream(request);
      await assert.rejects(f.engine.preview(), /响应|清单|目录条目|路径/);
      assert.equal(f.local.get("keep.md").bytes.toString(), "keep");
      assert.equal(f.calls.filter(call => call.method !== "GET").length, writesBefore);
    }
    globalThis.githubRequest = upstream;
  }

  async function align(f) {
    let plan = await f.engine.preview();
    assert.equal(plan.conflicts.length, 0, "identical files establish a baseline without choices");
    await f.engine.execute(plan);
  }
  // Rejoining clears interrupted work, not completed baselines or note contents.
  {
    const f = await fixture({ 'keep.md': 'keep', 'missing.md': 'remote' }, { 'keep.md': 'keep', 'missing.md': 'remote' });
    await align(f);
    const baseline = structuredClone(f.engine.state.base), commit = f.engine.state.baseCommitSha;
    f.local.delete('missing.md');
    f.engine.state.pending = { commit: f.head(), parent: f.head(), base: baseline, actions: [],
      revision: 0, paths: { moves: {} }, scope: f.engine.state.baseScope };
    f.engine.state.downloadVerification = { phase: 'downloading', scope: f.engine.state.baseScope, commit, files: baseline };
    f.engine.state.paths.moves = { 'keep.md': 'renamed.md' };
    f.engine.state.dirty['keep.md'] = 1;
    await f.engine.save();
    const beforeCalls = f.calls.length;
    assert.equal(await f.engine.restartSetup(), true);
    assert.equal(f.calls.length, beforeCalls, 'reset never calls GitHub');
    assert.deepEqual(f.engine.state.base, baseline);
    assert.equal(f.engine.state.baseCommitSha, commit);
    assert.deepEqual(f.engine.state.cache, {});
    assert.deepEqual(f.engine.state.dirty, {});
    assert.deepEqual(f.engine.state.paths, { moves: {} });
    for (const path of [f.engine.statePath, `${f.engine.statePath}.recovery`]) {
      const saved = JSON.parse(await f.adapter.read(path));
      assert.equal(saved.pending, undefined); assert.equal(saved.downloadVerification, undefined);
      assert.equal(saved.rejoinReview, true);
    }
    const restarted = new MobileGithub(f.adapter, '.obsidian', 'simple-link', () => f.options, () => {});
    await restarted.load(); await restarted.bind();
    const plan = await restarted.preview();
    assert(plan.conflicts.some(c => c.label === 'missing.md'));
    assert.equal(plan.remoteDeletes.length, 0, 'partial download cannot delete cloud notes');
    const choices = Object.fromEntries(plan.conflicts.map(c => [c.id, { choice: 'remote' }]));
    await restarted.execute(await restarted.preview(choices));
    assert.equal(f.local.get('missing.md').bytes.toString(), 'remote');
    assert.equal(restarted.state.rejoinReview, undefined, 'successful alignment finishes rejoining');
  }
  {
    const f = await fixture({ 'partial.md': 'downloaded' }, { 'partial.md': 'downloaded', 'remaining.md': 'remaining' });
    f.engine.state.base = { 'unfinished.md': { sha: 'partial', mode: '100644' } };
    f.engine.state.pending = {};
    f.engine.state.downloadVerification = {};
    await f.engine.save();
    assert.equal(await f.engine.restartSetup(), false);
    assert.deepEqual(f.engine.state.base, {});
    assert.equal(f.engine.state.baseCommitSha, null);
    await f.engine.bind();
    const plan = await f.engine.preview();
    assert(plan.conflicts.some(c => c.label === 'remaining.md'));
    assert.equal(plan.remoteDeletes.length, 0);
    assert.equal(f.local.get('partial.md').bytes.toString(), 'downloaded');
    f.engine.running = true;
    await assert.rejects(f.engine.restartSetup(), /等待任务停止/);
    f.engine.running = false;
    // Salvage the completed baseline even if both transient snapshots are broken.
    const baseline = { 'keep.md': { sha: 'known', mode: '100644' } };
    await f.adapter.write(f.engine.statePath, '{torn');
    await f.adapter.write(`${f.engine.statePath}.recovery`, JSON.stringify({ schema: 1,
      binding: 'example/vault#main', baseCommitSha: 'known-commit', base: baseline }));
    const repair = new MobileGithub(f.adapter, '.obsidian', 'simple-link', () => f.options, () => {});
    assert.equal(await repair.restartSetup(), true);
    assert.deepEqual(repair.state.base, baseline);
  }
  {
    const notes = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`notes/${index}.md`, `note ${index}`]));
    const f = await fixture(notes, { ...notes, 'notes/remaining.md': 'not yet downloaded' });
    f.engine.state.pending = {};
    await f.engine.save();
    const restarted = new MobileGithub(f.adapter, '.obsidian', 'simple-link', () => f.options, () => {});
    assert.equal(await restarted.restartSetup(), false);
    await restarted.bind();
    const plan = await restarted.preview();
    assert.equal(Object.keys(plan.local).length, 2000);
    assert.equal(plan.conflicts.length, 1);
    assert.equal(plan.conflicts[0].label, 'notes/remaining.md');
    assert.equal(plan.remoteDeletes.length, 0);
    assert.equal(plan.uploads.length, 0);
  }
  {
    const f = await fixture({ 'keep.md': 'keep' }, { 'keep.md': 'keep' });
    await align(f);
    f.engine.state.pending = {};
    const original = f.engine.state;
    const write = f.adapter.write;
    f.adapter.write = async () => { throw new Error('simulated state write failure'); };
    await assert.rejects(f.engine.restartSetup(), /state write failure/);
    assert.equal(f.engine.state, original, 'failed cleanup must keep in-memory recovery state');
    assert(f.engine.state.pending);
    assert.equal(f.engine.running, false);
    f.adapter.write = write;
  }
  {
    const f = await fixture({ 'keep.md': 'keep' }, { 'keep.md': 'keep' });
    await align(f);
    f.local.delete('keep.md');
    const binding = f.engine.state.binding, calls = f.calls.length;
    const original = f.engine.state, write = f.adapter.write;
    f.adapter.write = async () => { throw new Error('simulated state write failure'); };
    await assert.rejects(f.engine.restartSetup(true), /state write failure/);
    assert.equal(f.engine.state, original);
    f.adapter.write = write;
    assert.equal(await f.engine.restartSetup(true), false);
    assert.equal(f.calls.length, calls, 'clearing every baseline never mutates GitHub');
    assert.equal(f.local.has('keep.md'), false, 'clearing baseline never changes actual files');
    const restarted = new MobileGithub(f.adapter, '.obsidian', 'simple-link', () => f.options, () => {});
    await restarted.load();
    assert.equal(restarted.state.binding, binding);
    assert.deepEqual(restarted.state.base, {});
    assert.equal(restarted.state.baseCommitSha, null);
    assert.equal(restarted.initialSync, true);
    const plan = await restarted.preview();
    assert.equal(plan.remoteDeletes.length, 0, 'missing local content requires initial import review');
    assert(plan.conflicts.some(c => c.label === 'keep.md'));
  }
  console.log('Lightweight rejoin: 2000 partial files, baseline preservation, explicit full baseline clearing, damaged state, no inferred deletions and write failures passed');
  // Simulate explicit user decisions for one-sided first-sync fixtures.
  async function reviewedPreview(f, choices = {}) {
    const plan = await f.engine.preview(choices);
    for (const c of plan.conflicts) if (c.kind === 'unpaired') choices[c.id] = { choice: c.local ? 'local' : 'remote' };
    return plan.conflicts.some(c => c.kind === 'unpaired') ? f.engine.preview(choices) : plan;
  }
  // Preparation counts are separate from completed synchronization, in both directions.
  {
    const f = await fixture({ "upload.md": "old", "download.md": "old" }, { "upload.md": "old", "download.md": "old" });
    await align(f);
    await f.adapter.write("upload.md", "new local"); f.engine.event("modify", "upload.md");
    f.cloudEdit("download.md", "new cloud");
    f.progress.length = 0;
    const plan = await f.engine.preview();
    assert(f.progress.some(text => text.includes("待同步 2 个文件 · 待准备上传 1 个")));
    await f.engine.execute(plan);
    assert(f.progress.some(text => text.includes("正在确认云端更新 · 待同步 2 个文件 · 待准备上传 0 个 · 已准备 1/1")), "prepared uploads remain pending until the branch update succeeds");
    assert(f.progress.some(text => text.includes("正在应用本地同步结果 · 待同步 1 个文件")));
    assert(f.progress.some(text => text.includes("正在应用本地同步结果 · 待同步 0 个文件")));
    assert.equal(f.local.get("download.md").bytes.toString(), "new cloud");
    assert.equal(f.remote()["upload.md"].sha, hash(Buffer.from("new local")));
  }
  // Missing first-sync files wait for direction; choosing absence means an explicit deletion.
  for (const side of ['local', 'remote']) {
    for (const keep of [true, false]) {
      const f = await fixture(side === 'local' ? { 'single.md': 'text' } : {},
        side === 'remote' ? { 'single.md': 'text' } : {});
      const initial = await f.engine.preview();
      assert.equal(initial.conflicts[0].kind, 'unpaired');
      assert.equal(initial.uploads.length + initial.downloads.length + initial.localDeletes.length + initial.remoteDeletes.length, 0);
      await assert.rejects(f.engine.execute(initial), /冲突/);
      const choice = keep ? side : side === 'local' ? 'remote' : 'local';
      const plan = await f.engine.preview({ [initial.conflicts[0].id]: { choice } });
      assert.equal(plan.conflicts.length, 0);
      assert.equal((keep ? side === 'local' ? plan.uploads : plan.downloads : side === 'local' ? plan.localDeletes : plan.remoteDeletes).length, 1);
      assert.equal(f.local.has('single.md'), side === 'local', 'review does not mutate files');
      await f.engine.execute(plan);
      assert.equal(f.local.has('single.md'), keep);
      assert.equal(!!f.remote()['single.md'], keep);
      assert(f.engine.state.baseCommitSha);
    }
  }
  // Self-program sync keeps device state out of manifests and transactions.
  {
    const prefix = '.obsidian/plugins/simple-link/';
    const states = ['data.json', 'data.json.bak', 'link-state.json', 'link-state.json.recovery', 'mobile-ignore.json'];
    const remote = { [prefix + 'main.js']: 'new program', [prefix + 'manifest.json']: '{"id":"simple-link"}' };
    for (const name of states) remote[prefix + name] = 'other device state';
    const f = await fixture({ [prefix + 'data.json']: 'my credentials', [prefix + 'mobile-ignore.json']: 'my rules' }, remote);
    f.options.syncPlugins = true; f.options.plugins = ['simple-link'];
    f.options.ignorePatterns = ['!' + prefix + '*'];
    const plan = await reviewedPreview(f);
    assert(plan.downloads.includes(prefix + 'main.js'));
    assert(f.engine.requiresPluginReload(plan));
    for (const name of states) {
      assert(!plan.desired[prefix + name] && !plan.local[prefix + name] && !plan.remote.files[prefix + name]);
    }
    await f.engine.execute(plan);
    assert.equal(f.local.get(prefix + 'main.js').bytes.toString(), 'new program');
    assert.equal(f.local.get(prefix + 'data.json').bytes.toString(), 'my credentials');
    assert.equal(f.local.get(prefix + 'mobile-ignore.json').bytes.toString(), 'my rules');
    for (const name of states) assert.equal(f.remote()[prefix + name].sha, hash(Buffer.from('other device state')), 'excluded cloud state remains untouched');
    const next = await f.engine.preview();
    assert.equal(next.conflicts.length + next.uploads.length + next.downloads.length, 0);
    await f.adapter.write(prefix + 'main.js', 'edited program'); f.engine.event('modify', prefix + 'main.js');
    const upload = await f.engine.preview();
    assert.deepEqual(upload.uploads, [prefix + 'main.js']);
    assert(!f.engine.requiresPluginReload(upload), 'uploading does not need a local reload');
    await f.engine.execute(upload);
    assert.equal(f.remote()[prefix + 'main.js'].sha, hash(Buffer.from('edited program')));
  }
  // A thousand small text uploads use tree batches instead of a thousand blob requests.
  {
    const notes = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => ['notes/' + i + '.md', 'small note ' + i + '\n']));
    const f = await fixture(notes, {});
    await f.engine.execute(await reviewedPreview(f));
    assert.equal(f.calls.filter(c => c.method === 'POST' && c.path === '/git/blobs').length, 0);
    assert.equal(f.calls.filter(c => c.method === 'POST' && c.path === '/git/trees').length, 2);
    assert.equal(f.calls.filter(c => c.method === 'POST' && c.path === '/git/commits').length, 1);
    assert.equal(f.calls.filter(c => c.method === 'PATCH' && c.path === '/git/refs/heads/main').length, 1);
    assert.equal(Object.keys(f.remote()).length, 1000);
    const treeCalls = f.calls.filter(c => c.method === 'POST' && c.path === '/git/trees').length;
    for (const path of Object.keys(notes)) { await f.adapter.remove(path); f.engine.event('delete', path); }
    const deletions = await f.engine.preview();
    assert.equal(deletions.remoteDeletes.length, 1000);
    await f.engine.execute(deletions);
    assert.equal(Object.keys(f.remote()).length, 0);
    assert.equal(f.calls.filter(c => c.method === 'POST' && c.path === '/git/trees').length - treeCalls, 2);
    assert(f.calls.filter(c => c.method === 'POST' && c.path === '/git/trees').every(c => c.body.tree.length <= 500));
  }
  // Text uploads preserve BOM while canonicalizing CRLF.
  {
    const f = await fixture({ 'bom.md': '\ufeffhello\r\n' }, {});
    await f.engine.execute(await reviewedPreview(f));
    assert.equal(f.remote()['bom.md'].sha, hash(Buffer.from('\ufeffhello\n')));
    const next = await f.engine.preview();
    assert.equal(next.uploads.length + next.downloads.length + next.conflicts.length, 0);
  }
  // Compare omits file modes: changed heads require the authoritative tree.
  {
    const f = await fixture({ 'script.sh': 'echo hello' }, { 'script.sh': 'echo hello' });
    await align(f);
    f.cloudEdit('script.sh', 'echo hello');
    f.remote()['script.sh'].mode = '100755';
    const plan = await f.engine.preview();
    assert.equal(plan.desired['script.sh'].mode, '100755');
    assert.equal(plan.uploads.length + plan.downloads.length, 0);
    await f.engine.execute(plan);
    assert.equal((await f.engine.preview()).desired['script.sh'].mode, '100755');
  }
  {
    const f = await fixture({ 'note.md': 'hello' }, { 'note.md': 'hello' });
    await align(f);
    const base = f.engine.state.baseCommitSha;
    f.cloudEdit('note.md', 'hello');
    f.remote()['note.md'].mode = '120000';
    await assert.rejects(f.engine.preview(), /符号链接/);
    assert.equal(f.engine.state.baseCommitSha, base);
    assert.equal(f.local.get('note.md').bytes.toString(), 'hello');
  }
  // Interrupted multi-file downloads retain a durable guard and resume before
  // interpreting absent local files as deletions, including after a restart.
  {
    const f = await fixture({ 'existing.md': 'base' }, { 'existing.md': 'base' });
    await align(f);
    const base = f.engine.state.baseCommitSha;
    for (const name of ['first.md', 'second.md', 'third.md']) f.cloudEdit(name, name);
    f.fail('second.md');
    const plan = await f.engine.preview();
    await assert.rejects(f.engine.execute(plan), /disk failure/);
    assert(f.local.has('first.md'));
    assert(!f.local.has('second.md') && !f.local.has('third.md'));
    assert.equal(f.engine.state.baseCommitSha, base);
    const saved = JSON.parse(await f.adapter.read(f.engine.statePath));
    assert.equal(saved.baseCommitSha, base);
    assert.equal(saved.downloadVerification.phase, 'downloading');
    await assert.rejects(f.engine.execute(plan), /未完成的下载或验证/);
    f.fail('');
    const restarted = new MobileGithub(f.adapter, '.obsidian', 'simple-link', () => f.options, message => f.progress.push(message));
    const resumed = await restarted.preview();
    assert.equal(restarted.state.pending, undefined);
    assert.equal(restarted.state.baseCommitSha, f.head());
    assert.equal(resumed.remoteDeletes.length + resumed.localDeletes.length + resumed.downloads.length + resumed.uploads.length, 0);
    for (const name of ['first.md', 'second.md', 'third.md']) assert.equal(f.local.get(name).bytes.toString(), name);
    assert.equal(JSON.parse(await f.adapter.read(restarted.statePath)).pending, undefined);
    assert.equal(JSON.parse(await f.adapter.read(restarted.statePath)).downloadVerification, undefined);
  }
  // Even if an existing base lists a missing file, an unfinished download guard
  // makes that absence a download requirement, never an automatic cloud delete.
  {
    const f = await fixture({ 'protected.md': 'cloud content' }, { 'protected.md': 'cloud content' });
    await align(f);
    f.engine.state.downloadVerification = { phase: 'downloading', scope: f.engine.state.baseScope,
      commit: f.head(), files: { 'protected.md': f.engine.state.base['protected.md'] } };
    f.local.delete('protected.md');
    f.engine.event('delete', 'protected.md');
    await f.engine.save();
    const plan = await f.engine.preview();
    assert.deepEqual(plan.remoteDeletes, []);
    assert.deepEqual(plan.downloads, ['protected.md']);
    assert(f.engine.state.downloadVerification);
    await f.engine.execute(plan);
    assert.equal(f.local.get('protected.md').bytes.toString(), 'cloud content');
    assert.equal(f.engine.state.downloadVerification, undefined);
  }
  // A successful write call is insufficient: verify the bytes actually landed.
  {
    const f = await fixture({ 'existing.md': 'base' }, { 'existing.md': 'base' });
    await align(f);
    const base = f.engine.state.baseCommitSha;
    f.cloudEdit('lost.md', 'must be downloaded');
    const originalWrite = f.adapter.writeBinary;
    f.adapter.writeBinary = async (path, bytes) => { if (path !== 'lost.md') await originalWrite(path, bytes); };
    await assert.rejects(f.engine.execute(await f.engine.preview()), /下载结果验证未通过/);
    assert.equal(f.engine.state.baseCommitSha, base);
    assert.equal(f.engine.state.downloadVerification.phase, 'verifying');
    assert.equal(JSON.parse(await f.adapter.read(f.engine.statePath)).downloadVerification.phase, 'verifying');
    f.adapter.writeBinary = originalWrite;
    const recovered = await f.engine.preview();
    assert.equal(recovered.remoteDeletes.length, 0);
    assert.equal(f.local.get('lost.md').bytes.toString(), 'must be downloaded');
    assert.equal(f.engine.state.pending, undefined);
  }
  // Edits following interrupted downloads return to conflict review with the old baseline.
  {
    const f = await fixture({ 'note.md': 'base' }, { 'note.md': 'base' });
    await align(f);
    const base = f.engine.state.baseCommitSha;
    f.cloudEdit('note.md', 'cloud edit');
    f.fail('note.md');
    await assert.rejects(f.engine.execute(await reviewedPreview(f)), /disk failure/);
    assert(f.engine.state.pending);
    f.fail('');
    await f.adapter.write('note.md', 'new local edit');
    f.engine.event('modify', 'note.md');
    const plan = await f.engine.preview();
    assert.equal(f.engine.state.pending, undefined);
    assert.equal(f.engine.state.baseCommitSha, base);
    assert.equal(f.local.get('note.md').bytes.toString(), 'new local edit');
    assert(plan.conflicts.some(c => c.kind === 'content'));
    assert(f.engine.state.downloadVerification, 'download guard survives returning to conflict review');
  }
  // Empty vault: import, preserve excluded cloud config, persist baseline/tree and final cache.
  // A startup/bulk event storm must retain the latest state without thousands
  // of full JSON snapshots or concurrent writes.
  let releaseWrite, writeCount = 0, lastSaved;
  const writeGate = new Promise(resolve => { releaseWrite = resolve; });
  const batchEngine = new MobileGithub({ write: async (_path, text) => {
    writeCount++;
    if (writeCount === 1) await writeGate;
    lastSaved = JSON.parse(text);
  } }, ".obsidian", "simple-link", () => ({}), () => {});
  const firstSave = batchEngine.save();
  await Promise.resolve();
  const saves = [];
  for (let i = 1; i <= 4000; i++) {
    batchEngine.state.revision = i;
    saves.push(batchEngine.save());
  }
  assert(saves.every(save => save === firstSave), "one writer serves a whole event batch");
  releaseWrite();
  await Promise.all(saves);
  assert.equal(writeCount, 4, "two coalesced snapshots, each with recovery and primary writes");
  assert.equal(lastSaved.revision, 4000);
  batchEngine.adapter.write = async () => { throw new Error("save failed"); };
  await assert.rejects(batchEngine.save(), /save failed/);
  batchEngine.adapter.write = async (_path, text) => { lastSaved = JSON.parse(text); };
  batchEngine.state.revision = 4001;
  await batchEngine.save();
  assert.equal(lastSaved.revision, 4001, "failed writes can be retried");

  let f = await fixture({}, { "note.md": "cloud", "copy.md": "cloud", ".obsidian/app.json": "private" });
  let plan = await f.engine.preview();
  assert.equal(f.engine.state.baseCommitSha, null);
  assert.equal(plan.remoteDeletes.length, 0);
  assert.equal(plan.downloads.length, 0);
  assert.equal(plan.conflicts.filter(c => c.kind === "unpaired").length, 2);
  await assert.rejects(f.engine.execute(plan), /冲突/);
  plan = await reviewedPreview(f);
  await f.engine.execute(plan);
  assert.equal(f.local.get("note.md").bytes.toString(), "cloud");
  assert.equal(f.engine.state.baseCommitSha, f.head());
  assert.equal(f.engine.state.cache["note.md"].sha, f.engine.state.base["note.md"].sha);
  assert.equal(f.calls.filter(c => c.path.startsWith("/zipball/")).length, 1, "empty vault imports one archive");
  assert.equal(f.calls.filter(c => c.path.startsWith("/git/blobs/")).length, 0, "archive supplies verified duplicate bytes");
  assert(!f.local.has('.obsidian/app.json'), 'excluded settings never reach the vault');
  assert.equal(f.calls.filter(c => c.path === "/git/commits").length, 0, "import creates no unnecessary commit");
  const saved = JSON.parse(f.local.get(".obsidian/plugins/simple-link/link-state.json").bytes.toString());
  assert(!("baseTreeSha" in saved));
  assert.equal(saved.cache["copy.md"].sha, saved.base["copy.md"].sha);
  await f.adapter.write(".obsidian/plugins/simple-link/link-state.json", JSON.stringify({ ...saved, baseTreeSha: "legacy-tree" }));
  const migrated = new MobileGithub(f.adapter, ".obsidian", "simple-link", () => f.options, () => {});
  await migrated.load();
  const cleaned = JSON.parse(f.local.get(".obsidian/plugins/simple-link/link-state.json").bytes.toString());
  assert(!("baseTreeSha" in cleaned));
  assert.equal(cleaned.baseCommitSha, saved.baseCommitSha);
  assert.deepEqual(cleaned.base, saved.base);
  f.calls.length = 0;
  plan = await f.engine.preview();
  assert.equal(plan.uploads.length + plan.downloads.length + plan.conflicts.length, 0);
  assert(!f.calls.some(c => c.path.startsWith("/git/trees/")), "unchanged head reuses baseline manifest");

  // A torn primary write recovers the complete baseline rather than starting from zero.
  {
    const f = await fixture({ 'note.md': 'same' }, { 'note.md': 'same' });
    await align(f);
    const base = f.engine.state.baseCommitSha;
    await f.adapter.write('.obsidian/plugins/simple-link/link-state.json', '{torn');
    const recovered = new MobileGithub(f.adapter, '.obsidian', 'simple-link', () => f.options, () => {});
    await recovered.load();
    assert.equal(recovered.state.baseCommitSha, base);
    assert.equal(JSON.parse(await f.adapter.read('.obsidian/plugins/simple-link/link-state.json')).baseCommitSha, base);
    await f.adapter.write('.obsidian/plugins/simple-link/link-state.json', '{torn');
    await f.adapter.write('.obsidian/plugins/simple-link/link-state.json.recovery', '{torn');
    const broken = new MobileGithub(f.adapter, '.obsidian', 'simple-link', () => f.options, () => {});
    await assert.rejects(broken.load(), /停止同步/);
  }
  // Identical nonempty vaults still establish a baseline without a new commit.
  f = await fixture({ "same.md": "same" }, { "same.md": "same" });
  plan = await f.engine.preview();
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.localDeletes.length + plan.remoteDeletes.length, 0);
  await f.engine.execute(plan);
  await align(f);
  assert.equal(f.engine.state.baseCommitSha, "c0");

  // Common same-content paths never enter a duplicate group for other paths.
  {
    const f = await fixture({ 'common.md': 'same', 'local.md': 'same' },
      { 'common.md': 'same', 'remote.md': 'same' });
    const plan = await f.engine.preview();
    assert.equal(plan.conflicts.length, 1);
    assert.equal(plan.conflicts[0].kind, 'duplicate');
    assert.deepEqual(plan.conflicts[0].localFiles.map(s => s.path), ['local.md']);
    assert.deepEqual(plan.conflicts[0].remoteFiles.map(s => s.path), ['remote.md']);
    assert(plan.desired['common.md']);
    assert(!plan.uploads.includes('common.md') && !plan.downloads.includes('common.md'));
  }
  // Sidebar refresh uses memory only. Events remain provisional until the
  // scheduled/sync cache pass verifies hashes, including edits reverted back.
  f = await fixture({ "note.md": "original", "move.md": "move", "delete.md": "delete" },
    { "note.md": "original", "move.md": "move", "delete.md": "delete" });
  await align(f);
  const oldHash = f.engine.state.cache["note.md"].sha;
  await f.adapter.write("note.md", "edited");
  f.engine.event("modify", "note.md");
  f.move("move.md", "moved.md");
  await f.adapter.remove("delete.md");
  f.engine.event("delete", "delete.md");
  await f.adapter.write("new.md", "new");
  f.engine.event("create", "new.md");
  // Vault.getFiles omits dotfiles and nested hidden directories too.
  for (const path of [".gitignore", "nested/.obsidian/app.json", "nested/.hidden.md"]) {
    f.engine.state.base[path] = { ...f.engine.state.base["note.md"] };
    f.engine.state.cache[path] = { ...f.engine.state.cache["note.md"] };
  }
  const beforeRefresh = JSON.stringify(f.engine.state);
  const savedMethods = Object.fromEntries(["stat", "list", "readBinary", "write"].map(key => [key, f.adapter[key]]));
  for (const key of Object.keys(savedMethods)) f.adapter[key] = async () => { throw new Error(`sidebar must not call ${key}`); };
  const cached = f.engine.cachedChanges([...f.local.keys()]);
  assert.deepEqual(cached.map(c => c.status).sort(), ["added", "deleted", "modified", "renamed"]);
  assert.equal(JSON.stringify(f.engine.state), beforeRefresh, "sidebar does not mutate the cache or save state");
  Object.assign(f.adapter, savedMethods);
  assert.equal(f.engine.state.cache["note.md"].sha, oldHash);
  await f.adapter.write("note.md", "original");
  f.engine.event("modify", "note.md");
  assert(f.engine.cachedChanges([...f.local.keys()]).some(c => c.currentPath === "note.md"));
  await f.engine.refreshCache();
  assert(!f.engine.cachedChanges([...f.local.keys()]).some(c => c.currentPath === "note.md"));
  assert(f.engine.cachedChanges([...f.local.keys()]).some(c => c.status === "renamed"));
  await f.engine.preview();
  assert.equal(f.engine.state.cache["new.md"].sha, hash(Buffer.from("new")), "sync still updates hashes");

  // CRLF is only a disk representation: compare with GitHub LF without overwriting the note.
  // Upload failure persists a completed local check, never advances the base,
  // and a new engine can reuse those hashes on the next preview.
  f = await fixture({ "retry.md": "base" }, { "retry.md": "base" });
  await align(f);
  const retryBase = structuredClone(f.engine.state.base);
  const retryCommit = f.engine.state.baseCommitSha;
  await f.adapter.write("retry.md", "edited");
  f.engine.event("modify", "retry.md");
  plan = await f.engine.preview();
  f.engine.state.cache = {}; // Ensure execute must persist its own fresh check.
  const successfulRequest = globalThis.githubRequest;
  globalThis.githubRequest = async request => {
    if (request.method === "POST") throw new Error("simulated network failure");
    return successfulRequest(request);
  };
  await assert.rejects(f.engine.execute(plan), /network failure/);
  globalThis.githubRequest = successfulRequest;
  const failedSaved = JSON.parse(f.local.get(".obsidian/plugins/simple-link/link-state.json").bytes.toString());
  assert.equal(failedSaved.cache["retry.md"].sha, hash(Buffer.from("edited")));
  assert.equal(failedSaved.baseCommitSha, retryCommit);
  assert.deepEqual(failedSaved.base, retryBase);
  let retryReads = 0;
  const retryReadBinary = f.adapter.readBinary;
  f.adapter.readBinary = async path => { if (path === "retry.md") retryReads++; return retryReadBinary(path); };
  const retryEngine = new MobileGithub(f.adapter, ".obsidian", "simple-link", () => f.options, () => {});
  const retryPlan = await retryEngine.preview();
  assert.deepEqual(retryPlan.uploads, ["retry.md"]);
  assert.equal(retryReads, 0, "retry preview reuses the persisted local hash");
  assert.equal(retryEngine.state.baseCommitSha, retryCommit);

  f = await fixture({ "same.md": "line one\r\nline two\r\n" }, { "same.md": "line one\nline two\n" });
  plan = await f.engine.preview();
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.uploads.length + plan.downloads.length, 0);
  await align(f);
  assert.equal(f.local.get("same.md").bytes.toString(), "line one\r\nline two\r\n");
  assert.equal(f.engine.state.cache["same.md"].rawSha, hash(Buffer.from("line one\r\nline two\r\n")));
  assert.equal(f.engine.state.cache["same.md"].sha, hash(Buffer.from("line one\nline two\n")));
  assert.equal((await f.engine.changes()).length, 0);
  // Real cloud edits still use the exact CRLF disk hash as their overwrite guard.
  f.cloudEdit("same.md", "line one\ncloud edit\n");
  await f.engine.execute(await reviewedPreview(f));
  assert.equal(f.local.get("same.md").bytes.toString(), "line one\ncloud edit\n");

  // New CRLF text uploads as LF; binary bytes are not converted.
  f = await fixture({ "same.md": "same\r\n" }, { "same.md": "same\r\n" });
  plan = await f.engine.preview();
  assert.equal(plan.conflicts.length, 0);
  await align(f);
  plan = await f.engine.preview();
  assert.equal(plan.uploads.length + plan.downloads.length + plan.conflicts.length, 0);
  assert.equal((await f.engine.changes()).length, 0);

  f = await fixture({ "new.md": "new\r\nnote\r\n", "binary.bin": "a\0b\r\n" }, {});
  await f.engine.execute(await reviewedPreview(f));
  assert.equal(f.remote()["new.md"].sha, hash(Buffer.from("new\nnote\n")));
  assert.equal(f.remote()["binary.bin"].sha, hash(Buffer.from("a\0b\r\n")));

  // Nested generated folders must be excluded on both ends, not offered for download.
  f = await fixture({}, { "project/.codex/output/preview.png": "temporary", "note.md": "cloud" });
  plan = await f.engine.preview();
  assert.deepEqual(plan.downloads, []);
  assert.deepEqual(plan.conflicts.map(c => c.label), ["note.md"]);
  plan = await reviewedPreview(f);
  assert.deepEqual(plan.downloads, ["note.md"]);

  // Same contents across paths: choose one side, or explicitly preserve both.
  for (const choice of ["local", "remote", "both", "delete"]) {
    f = await fixture({ "local.md": "duplicate" }, { "cloud.md": "duplicate" });
    plan = await f.engine.preview();
    assert.equal(plan.conflicts[0].kind, "duplicate");
    assert.equal(plan.localDeletes.length + plan.remoteDeletes.length, 0);
    plan = await f.engine.preview({ [plan.conflicts[0].id]: { choice } });
    await f.engine.execute(plan);
    const expected = choice === "delete" ? [] : choice === "both" ? ["cloud.md", "local.md"] : [choice === "local" ? "local.md" : "cloud.md"];
    assert.deepEqual(Object.keys(f.engine.state.base).sort(), expected);
    for (const path of expected) assert.equal(f.local.get(path).bytes.toString(), "duplicate");
  }

  f = await fixture({ "a.md": "same", "b.md": "same" }, { "a.md": "same", "c.md": "same" });
  plan = await f.engine.preview();
  assert.equal(plan.conflicts.length, 1);
  plan = await f.engine.preview({ [plan.conflicts[0].id]: { choice: "both" } });
  await f.engine.execute(plan);
  assert.deepEqual(Object.keys(f.engine.state.base).sort(), ["a.md", "b.md", "c.md"]);

  // Edited blocks stay in memory until final execution; recovery uses uploaded blobs.
  f = await fixture({ "shared.md": "prefix\nlocal\nsuffix\n" }, { "shared.md": "prefix\ncloud\nsuffix\n" });
  plan = await f.engine.preview({ "new:shared.md": { choice: "manual", text: "prefix\nmerged\nsuffix\n" } });
  assert.equal(f.local.get("shared.md").bytes.toString(), "prefix\nlocal\nsuffix\n");
  assert.equal(plan.conflicts.length, 0);
  f.fail("shared.md");
  await assert.rejects(f.engine.execute(plan), /disk failure/);
  assert(f.engine.state.pending);
  f.fail("");
  await f.engine.preview();
  assert.equal(f.local.get("shared.md").bytes.toString(), "prefix\nmerged\nsuffix\n");
  assert.equal(f.engine.state.base["shared.md"].sha, hash(Buffer.from("prefix\nmerged\nsuffix\n")));

  // Mixed first sync: no writes before resolving conflict; one batched text upload.
  f = await fixture({ "shared.md": "local", "local.md": "local-only", "more.md": "other" },
    { "shared.md": "cloud", "remote.md": "remote-only", ".obsidian/app.json": "private" });
  plan = await f.engine.preview();
  assert.equal(plan.conflicts.length, 4);
  await assert.rejects(f.engine.execute(plan), /冲突/);
  assert.equal(f.engine.state.baseCommitSha, null);
  plan = await reviewedPreview(f, { "new:shared.md": { choice: "local" } });
  await f.engine.execute(plan);
  assert.equal(f.remote()["shared.md"].sha, hash(Buffer.from("local")));
  assert.equal(f.local.get("remote.md").bytes.toString(), "remote-only");
  assert(f.remote()[".obsidian/app.json"]);
  assert.equal(f.calls.filter(c => c.path === "/git/trees" && c.method === "POST").length, 1);
  for (const [path, entry] of Object.entries(f.engine.state.base)) assert.equal(f.engine.state.cache[path].sha, entry.sha);

  // Local move + cloud edit: keep file identity, combine cloud content with new local path.
  f.move("shared.md", "moved.md");
  f.cloudEdit("shared.md", "cloud-edited");
  plan = await f.engine.preview();
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.desired["moved.md"].sha, hash(Buffer.from("cloud-edited")));
  assert(!plan.desired["shared.md"]);
  assert(f.calls.some(c => c.path.startsWith("/compare/")));
  await f.engine.execute(plan);
  assert.equal(f.local.get("moved.md").bytes.toString(), "cloud-edited");
  assert(!f.remote()["shared.md"]);
  assert.deepEqual(f.engine.state.paths, { moves: {} });

  // Only moves enter Path: copies are additions, deletion/creation are inferred by Diff.
  f = await fixture({ "a.md": "original" }, { "a.md": "original" });
  await align(f);
  f.move("a.md", "folder/a.md");
  f.move("folder/a.md", "folder/renamed.md");
  assert.equal(f.engine.state.paths.moves["a.md"], "folder/renamed.md");
  await f.adapter.write("folder/renamed.md", "edited after moving");
  f.engine.event("modify", "folder/renamed.md");
  let changes = await f.engine.changes();
  assert.equal(changes[0].status, "renamed");
  assert.equal(changes[0].contentChanged, true);
  await f.adapter.write("copy.md", "edited after moving");
  f.engine.event("create", "copy.md");
  assert.deepEqual(f.engine.state.paths.moves, { "a.md": "folder/renamed.md" });
  f.move("copy.md", "copy-renamed.md");
  await f.adapter.write("second-copy.md", "edited after moving");
  f.engine.event("create", "second-copy.md");
  assert.equal(f.engine.state.paths.moves["copy.md"], "copy-renamed.md");
  const pathsBeforeDelete = structuredClone(f.engine.state.paths);
  await f.adapter.remove("folder/renamed.md");
  f.engine.event("delete", "folder/renamed.md");
  assert.deepEqual(f.engine.state.paths, pathsBeforeDelete, "deletion does not write Path");
  changes = await f.engine.changes();
  assert(changes.some(c => c.status === "deleted" && c.basePath === "a.md"));
  assert.equal(changes.filter(c => c.status === "added").length, 2);
  plan = await f.engine.preview();
  assert.equal(plan.conflicts.length, 0);
  assert(!plan.desired["a.md"]);
  assert(plan.desired["copy-renamed.md"] && plan.desired["second-copy.md"]);
  await f.engine.execute(plan);
  assert.deepEqual(f.engine.state.paths, { moves: {} });

  // Equal hashes without a source event must not turn delete + create into a move.
  f = await fixture({ "old.md": "same" }, { "old.md": "same" });
  await align(f);
  await f.adapter.remove("old.md");
  f.engine.event("delete", "old.md");
  await f.adapter.write("new.md", "same");
  f.engine.event("create", "new.md");
  changes = await f.engine.changes();
  assert.deepEqual(changes.map(c => c.status).sort(), ["added", "deleted"]);
  assert.deepEqual(f.engine.state.paths, { moves: {} });

  // Migrate legacy deletion markers while preserving commit/cache and moves.
  const oldState = structuredClone(f.engine.state);
  oldState.paths = { "old.md": null, "other.md": "moved.md" };
  await f.adapter.write(".obsidian/plugins/simple-link/link-state.json", JSON.stringify(oldState));
  const oldEngine = new MobileGithub(f.adapter, ".obsidian", "simple-link", () => f.options, () => {});
  await oldEngine.load();
  assert.deepEqual(oldEngine.state.paths, { moves: { "other.md": "moved.md" } });
  assert.deepEqual(oldEngine.state.base, oldState.base);
  assert.equal(oldEngine.state.baseCommitSha, oldState.baseCommitSha);

  // Strip the previous copy-source format without changing baseline or moves.
  oldState.paths = { moves: { "other.md": "moved.md" }, copies: { "new.md": "old.md" } };
  await f.adapter.write(".obsidian/plugins/simple-link/link-state.json", JSON.stringify(oldState));
  const moveOnlyEngine = new MobileGithub(f.adapter, ".obsidian", "simple-link", () => f.options, () => {});
  await moveOnlyEngine.load();
  assert.deepEqual(moveOnlyEngine.state.paths, { moves: { "other.md": "moved.md" } });
  const moveOnlySaved = JSON.parse(f.local.get(".obsidian/plugins/simple-link/link-state.json").bytes.toString());
  assert(!("copies" in moveOnlySaved.paths));
  assert.deepEqual(moveOnlySaved.base, oldState.base);
  assert.equal(moveOnlySaved.baseCommitSha, oldState.baseCommitSha);

  // Moving back cancels the net move; identical files still follow explicit events.
  f = await fixture({ "a.md": "same", "b.md": "same" }, { "a.md": "same", "b.md": "same" });
  await align(f);
  f.move("a.md", "renamed.md");
  changes = await f.engine.changes();
  assert.equal(changes.find(c => c.currentPath === "renamed.md").basePath, "a.md");
  f.move("renamed.md", "a.md");
  assert.deepEqual(f.engine.state.paths, { moves: {} });
  assert.deepEqual(await f.engine.changes(), []);

  // Copy a new file and move it before its first baseline/cache scan.
  await f.adapter.write("fresh.md", "fresh");
  f.engine.event("create", "fresh.md");
  f.move("fresh.md", "fresh-renamed.md");
  await f.adapter.write("fresh-copy.md", "fresh");
  f.engine.event("create", "fresh-copy.md");
  f.move("fresh-copy.md", "fresh-copy-renamed.md");
  assert.equal(f.engine.state.paths.moves["fresh-copy.md"], "fresh-copy-renamed.md");
  await align(f);
  assert.deepEqual(f.engine.state.paths, { moves: {} });

  // A copy moved during local application becomes an independent baseline identity.
  f = await fixture({ "a.md": "source" }, { "a.md": "source" });
  await align(f);
  await f.adapter.write("copy.md", "source");
  f.engine.event("create", "copy.md");
  f.cloudEdit("incoming.md", "incoming");
  const writeBinary = f.adapter.writeBinary;
  f.adapter.writeBinary = async (path, bytes) => {
    await writeBinary(path, bytes);
    if (path === "incoming.md") f.move("copy.md", "moved-copy.md");
  };
  await align(f);
  changes = await f.engine.changes();
  assert(changes.some(c => c.status === "renamed" && c.basePath === "copy.md" && c.currentPath === "moved-copy.md"));

  // Moving back while applying must be rebased even though the net old move vanished.
  f = await fixture({ "a.md": "source" }, { "a.md": "source" });
  await align(f);
  f.move("a.md", "b.md");
  f.cloudEdit("incoming.md", "incoming");
  const applyWrite = f.adapter.writeBinary;
  f.adapter.writeBinary = async (path, bytes) => {
    await applyWrite(path, bytes);
    if (path === "incoming.md") f.move("b.md", "a.md");
  };
  await align(f);
  changes = await f.engine.changes();
  assert(changes.some(c => c.status === "renamed" && c.basePath === "b.md" && c.currentPath === "a.md"));

  // Failed local apply must keep transaction and no baseline; next preview recovers it.
  f = await fixture({ "local.md": "local" }, { "remote.md": "cloud" });
  f.fail("remote.md");
  await assert.rejects(f.engine.execute(await reviewedPreview(f)), /disk failure/);
  assert.equal(f.engine.state.baseCommitSha, null);
  assert(f.engine.state.pending);
  f.fail("");
  await f.engine.preview();
  assert.equal(f.engine.state.baseCommitSha, f.head());
  assert.equal(f.engine.state.pending, undefined);
  assert.equal(f.engine.state.cache["remote.md"].sha, f.engine.state.base["remote.md"].sha);
  // Exercise the real guide coordinator with a controlled modal (no native UI).
  const guideBundle = join(folder, "guide.cjs");
  await esbuild.build({ stdin: { contents: 'export { default as LinkPlugin, SyncSettingsTab } from "./src/features/sync/index"; export { MobileGithub as GuideEngine } from "./src/features/sync/mobileGithub"; export { MobileSyncModal, mobileConflictFile } from "./src/features/sync/mobileUi"; export { ZoeySyncConflictPreviewModal } from "./src/features/sync/conflictPreview";', resolveDir: process.cwd() },
    bundle: true, platform: "node", format: "cjs", outfile: guideBundle, loader: { ".png": "dataurl" },
    plugins: [{ name: "mock-obsidian", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
      build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: `
        export class Component {} export class Plugin {} export class PluginSettingTab {} export class ItemView {}
        export class Modal { constructor(app) { this.app = app; } }
        export class TAbstractFile {} export class TFile {} export class FileSystemAdapter {}
        export class App {} export class Menu {} export class Notice {} export class Setting { constructor(parent) { if (globalThis.guideSetting) return globalThis.guideSetting(parent); } } export class WorkspaceLeaf {}
        export const Platform = { isMobile: false }; export const addIcon = () => {};
        export const requestUrl = () => {}; export const setIcon = () => {}; export const setTooltip = () => {};
      ` }));
    } }] });
  const { LinkPlugin, SyncSettingsTab, GuideEngine, MobileSyncModal, mobileConflictFile, ZoeySyncConflictPreviewModal } = require(guideBundle);
  const mobileFlowWait = MobileSyncModal.prototype.wait;
  for (const page of ["setup", "desktop-settings", "beginner-mobile", "mobile", "server"]) {
    const tab = Object.create(SyncSettingsTab.prototype);
    tab.plugin = { host: {} };
    tab.desktopPage = page;
    tab.settingsHost = {};
    tab.setupBrowserController = new AbortController();
    tab.lightweightGuideController = new AbortController();
    const browser = tab.setupBrowserController, lightweight = tab.lightweightGuideController;
    let renders = 0;
    tab.renderSettings = () => { renders++; };
    tab.renderDeviceHeader({ createDiv: () => { throw Error("duplicate embedded header"); } }, "Device");
    assert.equal(tab.backToOverview(), true);
    assert.equal(tab.desktopPage, "root");
    assert.equal(browser.signal.aborted, true);
    assert.equal(lightweight.signal.aborted, true);
    assert.equal(renders, 1);
    assert.equal(tab.backToOverview(), false, "only sync overview should return to Simple One");
  }
  console.log("Shared sync header: one-level back navigation and duplicate header suppression passed");
  {
    const tab = Object.create(SyncSettingsTab.prototype);
    tab.desktopPage = "root";
    tab.plugin = { host: {} };
    tab.navigationParents = [];
    tab.renderSettings = () => {};
    for (const page of ["setup", "desktop-settings", "beginner-mobile", "beginner-desktop", "beginner-server", "mobile", "server"]) {
      tab.navigateTo(page);
      assert.equal(tab.backToOverview(), true);
      assert.equal(tab.desktopPage, "root", "every direct child returns to sync overview");
      assert.equal(tab.backToOverview(), false);
    }
    tab.navigateTo("beginner-mobile");
    tab.navigateTo("setup");
    assert.equal(tab.backToOverview(), true);
    assert.equal(tab.desktopPage, "beginner-mobile", "login help returns to the originating guide");
    assert.equal(tab.backToOverview(), true);
    assert.equal(tab.desktopPage, "root");
    tab.navigateTo("mobile");
    tab.resetNavigation();
    assert.equal(tab.desktopPage, "root", "reopening sync from Simple One starts at its overview");
    assert.deepEqual(tab.navigationParents, []);
    assert.equal(tab.backToOverview(), false);
  }
  console.log("All sync pages: parent navigation, nested login help and overview reopening passed");
  {
    const tab = Object.create(SyncSettingsTab.prototype);
    const titles = [], sharedTitles = [];
    tab.desktopPage = "root"; tab.navigationParents = [];
    tab.plugin = { host: { share: { backFromEdgeOneGuide() { return false; }, detachSettings() {}, renderSettings(_root, _guide, showTitle) { sharedTitles.push(showTitle); } } } };
    const container = { empty() {}, addClass() {}, toggleClass() {} };
    for (const method of ["addEnableSetting", "addDefaultRepoSetting", "displayBeginner", "displayDesktop", "displayBeginnerMobile", "displayDevicePreview", "displayMobilePreview", "displaySetup", "displayDesktopSettings"]) tab[method] = () => {};
    tab.renderInto(container, title => titles.push(title));
    tab.navigateTo("beginner-mobile"); tab.navigateTo("setup"); tab.backToOverview(); tab.backToOverview();
    tab.navigateTo("desktop-settings"); tab.backToOverview();
    tab.navigateTo("mobile"); tab.backToOverview();
    tab.navigateTo("beginner-server"); tab.backToOverview();
    tab.navigateTo("server"); tab.backToOverview();
    assert.deepEqual(titles, ["同步", "轻量同步引导", "电脑端同步引导", "轻量同步引导", "同步", "电脑端 Git 同步设置", "同步", "轻量 Git 同步设置", "同步", "笔记分享引导", "同步", "笔记分享设置", "同步"]);
    assert.deepEqual(sharedTitles, [false, false], "share pages suppress their own title under the shared header");
    tab.hide(); assert.equal(tab.settingsTitleChanged, undefined);
  }
  console.log("Sync page titles: child titles, nested back navigation and duplicate share title suppression passed");
  // The migrated guide renders inside Simple One, rather than the old tab root.
  for (const step of [1, 2, 3]) {
    const tab = Object.create(SyncSettingsTab.prototype);
    const visible = { isConnected: true };
    tab.containerEl = { querySelector: () => { throw new Error("queried obsolete tab root"); } };
    tab.settingsHost = { querySelector: () => visible };
    tab.desktopPage = "setup";
    tab.setupViewStep = step;
    tab.setupPlatform = "github";
    tab.setupAuthVerified = true;
    tab.syncSetupProgress = () => {};
    tab.renderSettings = () => {};
    if (step === 1) await tab.advanceSetupAfterAuthorization();
    else await tab.advanceSetupAfterCheck(step, () => true);
    assert.equal(tab.setupViewStep, step + 1, "embedded guide must advance after success");
    tab.setupViewStep = step;
    visible.isConnected = false;
    if (step === 1) await tab.advanceSetupAfterAuthorization();
    else await tab.advanceSetupAfterCheck(step, () => true);
    assert.equal(tab.setupViewStep, step, "a guide closed during the delay must not advance");
  }
  console.log("Embedded desktop guide: authorization/check transitions and navigation cancellation passed");

  class ReviewElement {
    constructor(tag = 'div', options = {}) { this.tag = tag; this.text = options.text; this.cls = options.cls ?? ''; this.children = []; this.style = {}; }
    createEl(tag, options = {}) { const child = new ReviewElement(tag, options); this.children.push(child); return child; }
    createDiv(options = {}) { return this.createEl('div', options); }
    createSpan(options = {}) { return this.createEl('span', options); }
    setAttr() {}
    addEventListener(event, handler) { this.events ??= {}; this.events[event] = handler; }
    toggleClass() {}
    addClass(name) { this.cls += ' ' + name; }
  }
  class GuideElement extends ReviewElement {
    constructor(tag = "div", options = {}) { super(tag, options); this.disabled = false; this.connected = true; this.events = {}; }
    get isConnected() { return this.parentElement ? this.parentElement.isConnected : this.connected; }
    createEl(tag, options = {}) { const child = new GuideElement(tag, options); this.appendChild(child); return child; }
    appendChild(child) {
      if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(value => value !== child);
      child.parentElement = this; this.children.push(child); return child;
    }
    empty() { for (const child of this.children) { child.parentElement = undefined; child.connected = false; } this.children = []; }
    setText(text) { this.text = text; }
    addEventListener(event, action) { this.events[event] = action; }
    querySelectorAll(selector) {
      const nodes = this.children.flatMap(child => [child, ...child.querySelectorAll("*")]);
      if (selector === "*") return nodes;
      if (selector.includes("lightweight-nav")) return [];
      return nodes.filter(node => ["button", "input"].includes(node.tag));
    }
  }
  globalThis.guideSetting = parent => {
    const setting = { settingEl: parent.createDiv(), setName(name) { this.settingEl.name = name; return this; }, setHeading() { return this; },
      addText(configure) {
        const inputEl = this.settingEl.createEl("input");
        configure({ inputEl, setPlaceholder() { return this; }, setValue() { return this; }, onChange() { return this; } });
        return this;
      },
      addButton(configure) {
        const buttonEl = this.settingEl.createEl("button");
        configure({ buttonEl, setButtonText(text) { buttonEl.text = text; return this; }, setCta() { return this; }, setDisabled(value) { buttonEl.disabled = value; return this; },
          onClick(action) { buttonEl.events.click = action; return this; } });
        return this;
      } };
    return setting;
  };
  const verifyToken = GuideEngine.prototype.verifyToken, verifyAccess = GuideEngine.prototype.verifyAccess;
  try {
    for (const step of [2, 3]) for (const outcome of ["success", "failure", "closed-success", "closed-failure"]) {
      let resolveRequest, rejectRequest;
      const request = new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
      GuideEngine.prototype.verifyToken = () => request;
      GuideEngine.prototype.verifyAccess = () => request;
      const tab = Object.create(SyncSettingsTab.prototype), host = new GuideElement();
      tab.settingsHost = host;
      tab.containerEl = { querySelector: () => { throw new Error("obsolete lightweight tab root"); } };
      tab.desktopPage = "beginner-mobile";
      tab.lightweightGuideStep = step;
      tab.lightweightGuideDraft = { token: "fixture-token", repoUrl: "https://github.com/example/vault", branch: "", plugins: [], ignorePatterns: [] };
      tab.lightweightGuideRepoMode = "existing";
      tab.lightweightGuideLogin = step === 3 ? "example" : "";
      tab.plugin = { manifest: { id: "simple-one" }, settings: { mobile: { bound: false } }, saveSettings: async () => {} };
      tab.app = { vault: { adapter: {}, configDir: ".custom-config" } };
      let renders = 0;
      tab.renderSettings = () => { renders++; host.empty(); };
      const page = host.createDiv();
      tab.displayLightweightGuideStep(page);
      const button = page.querySelectorAll("button, input").find(node => node.text === (step === 2 ? "核验连接" : "检查仓库"));
      assert(button);
      button.events.click();
      assert.equal(tab.lightweightGuideBusy, true);
      if (outcome.startsWith("closed")) { tab.hide(); host.connected = false; }
      if (outcome.endsWith("failure")) rejectRequest(new Error("simulated authorization failure"));
      else resolveRequest(step === 2 ? "example" : { branch: "main" });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(tab.lightweightGuideBusy, false);
      assert.equal(tab.lightweightGuideStep, outcome === "success" ? step + 1 : step);
      assert.equal(renders > 0, outcome === "success", "late/failed results must not repaint or advance");
      if (outcome === "failure") assert.equal(button.disabled, false, "failure must allow retry");
    }
    // Ignore baseline, rule/tracking acknowledgement and file choices are separate gates.
    {
      const tab = Object.create(SyncSettingsTab.prototype), host = new GuideElement();
      let preview = { localFiles: ["note.md"], remoteFiles: ["note.md"], localOnly: [], remoteOnly: [], overlaps: [".gitignore", "note.md"],
        nestedRepos: [], localRoot: true, localBranch: "master", branch: "main", relatedHistory: true,
        localIgnore: "local/", remoteIgnore: "remote/", optimizedIgnore: "local/", missingIgnoreRules: [],
        trackedExcludedLocal: ["private.json"], trackedExcludedRemote: [] };
      const choices = {}; let tracking, confirmed = 0;
      tab.plugin = { settings: { setupStep: 3, setupComplete: false }, app: { vault: { configDir: ".obsidian" } },
        getVaultBasePath: () => "fixture-vault", getSetupPreview: () => preview, getSetupChoices: () => ({ ...choices }),
        setSetupChoice: (path, value) => { choices[path] = value; }, getSetupTrackingChoice: () => tracking,
        setSetupTrackingChoice: value => { tracking = value; }, confirmSetupPreview: async () => { confirmed++; } };
      tab.setupMessage = ""; tab.setupBusy = false; tab.setupViewStep = 3;
      tab.renderSettings = () => {};
      tab.advanceSetupAfterCheck = async step => { assert.equal(step, 3); tab.setupViewStep = 4; };
      const render = () => { host.empty(); tab.displaySetupPreview(host.createDiv()); return host.querySelectorAll("*"); };
      let nodes = render();
      assert(nodes.some(node => node.name === "1 · 选择 Git 忽略规则基准"));
      assert(nodes.some(node => node.text === "查看差异 / 合并编辑"), "different rules offer the merge viewer");
      const originalRemoteIgnore = preview.remoteIgnore;
      preview.remoteIgnore = preview.localIgnore + "\r\n";
      nodes = render();
      assert(!nodes.some(node => node.text === "查看差异 / 合并编辑"), "identical rules hide the merge viewer");
      await tab.reviewSetupIgnoreDifferences(preview);
      assert.equal(tab.setupBaseConfirmed, false, "identical rules do not open a modal or change the review state");
      preview.remoteIgnore = originalRemoteIgnore;
      nodes = render();
      assert(!nodes.some(node => node.name === "3 · 确认文件差异"));
      tab.confirmSetupIgnoreBase();
      assert.equal(tab.setupReviewStage, 1, "a different ignore baseline requires a choice");
      choices[".gitignore"] = "local";
      tab.confirmSetupIgnoreBase();
      assert.equal(tab.setupReviewStage, 2);
      nodes = render();
      assert(nodes.some(node => node.name === "2 · 建议规则与文件追踪"));
      tab.confirmSetupRules();
      assert.equal(tab.setupReviewStage, 2, "tracked exclusions require an explicit tracking decision");
      tab.confirmSetupRules("rebuild");
      assert.equal(tab.setupReviewStage, 3);
      assert.equal(tab.setupRebuildConfirmed, true);
      nodes = render();
      assert(nodes.some(node => node.name === "3 · 确认文件差异"));
      await tab.advanceSetupAfterPreview();
      assert.equal(confirmed, 0, "unresolved file differences block completion");
      choices["note.md"] = "remote";
      tab.updateSetupPreviewSelection();
      assert.equal(confirmed, 0, "choosing files must not auto-confirm the whole review");
      await tab.advanceSetupAfterPreview();
      assert.equal(confirmed, 1);
      assert.equal(tab.setupViewStep, 4);
      preview = { ...preview };
      render();
      assert.equal(tab.setupReviewStage, 1, "a new inspection requires fresh confirmations");
      assert.equal(tab.setupRulesConfirmed, false);
      assert.equal(tab.setupRebuildConfirmed, false);
    }
    console.log("Desktop inspection modules: baseline/tracking/file gates and explicit final confirmation passed");
  } finally {
    GuideEngine.prototype.verifyToken = verifyToken; GuideEngine.prototype.verifyAccess = verifyAccess;
    delete globalThis.guideSetting;
  }
  console.log("Embedded lightweight guide: token/repository transitions, retries and closed-page results passed");

  // The ignore review edits only differing blocks while preserving common rules byte for byte.
  {
    const local = "# common\r\ncommon/\r\nlocal-only/\r\n# end\r\n";
    const remote = "# common\r\ncommon/\r\nremote-only/\r\n# end\r\n";
    const file = { path: ".gitignore", totalLines: 0, localUpdatedAt: "", remoteUpdatedAt: "", blocks: [] };
    const modal = new ZoeySyncConflictPreviewModal({}, { editableColumns: true, files: [file], read: async () => ({ local, remote }) });
    modal.active = true; modal.render = () => {}; modal.close = () => {};
    await modal.loadFile(file);
    assert.equal(file.blocks.length, 1);
    assert.equal(file.blocks[0].local, "local-only/\r\n");
    assert.equal(file.blocks[0].remote, "remote-only/\r\n");
    modal.selectBlock(file, 0, "merged");
    const row = new ReviewElement();
    modal.renderBlocks(row, file);
    const block = row.children[0].children.find(node => node.cls.includes("preview__block") && !node.cls.includes("headers"));
    assert.equal(block.children.filter(node => node.cls.includes("preview__side")).length, 2, "both source columns remain visible during editing");
    const result = block.children.find(node => node.cls.includes("preview__result"));
    const editor = result.children.find(node => node.tag === "textarea");
    editor.value = "local-only/\r\nremote-only/\r\ncustom/\r\n";
    editor.events.input();
    let selected;
    modal.resolve = value => { selected = value; };
    modal.applyReadyFiles();
    assert.equal(selected[".gitignore"].choice, "manual");
    assert.equal(selected[".gitignore"].text, "# common\r\ncommon/\r\nlocal-only/\r\nremote-only/\r\ncustom/\r\n# end\r\n");
    const same = { ...file, blocks: [] };
    const identical = new ZoeySyncConflictPreviewModal({}, { files: [same], read: async () => ({ local, remote: local }) });
    identical.render = () => {};
    await identical.loadFile(same);
    assert.equal(same.blocks.length, 0, "identical rules do not create fake differences");
  }
  console.log("Ignore diff review: three columns, editable blocks, unchanged rules and identical files passed");

  // Natural wording keeps the exact keep/delete direction for either existing side.
  for (const side of ['local', 'remote']) {
    const f = await fixture(side === 'local' ? { 'single.md': 'text' } : {}, side === 'remote' ? { 'single.md': 'text' } : {});
    const plan = await f.engine.preview();
    const conflict = plan.conflicts[0];
    const file = mobileConflictFile(conflict);
    assert.equal(file.description, side === 'local' ? '文件仅存在于本机' : '文件仅存在于云端');
    assert.equal(file.keepSide, side);
    assert.equal(side === 'local' ? file.localChoiceLabel : file.remoteChoiceLabel, side === 'local' ? '上传文件' : '下载文件');
    assert.equal(side === 'local' ? file.remoteChoiceLabel : file.localChoiceLabel, '删除文件');
    assert.equal(file.showPaths, false);
    const review = new ZoeySyncConflictPreviewModal({}, { files: [file], read: async () => ({ local: '', remote: '' }) });
    const list = new ReviewElement();
    review.renderFile(list, file);
    const summary = list.children[0].children[0];
    assert.equal(summary.children.some(el => el.cls.includes('__times')), false, 'collapsed rows omit repeated paths');
    const control = summary.children.find(el => el.cls.includes('__choice-control'));
    const segments = control.children.find(el => el.cls.includes('__segments'));
    assert(segments.children[0].cls.includes('is-local'));
    assert(segments.children[1].cls.includes('is-remote'));
    assert.deepEqual(segments.children.map(el => el.text), side === 'local' ? ['上传文件', '删除文件'] : ['删除文件', '下载文件']);
    assert(segments.children.every(el => !el.cls.includes('is-keep') && !el.cls.includes('is-delete')));
    const kept = await f.engine.preview({ [conflict.id]: { choice: file.keepSide } });
    assert.equal((side === 'local' ? kept.uploads : kept.downloads).length, 1);
    const deleted = await f.engine.preview({ [conflict.id]: { choice: side === 'local' ? 'remote' : 'local' } });
    assert.equal((side === 'local' ? deleted.localDeletes : deleted.remoteDeletes).length, 1);
  }
  {
    const f = await fixture({ 'same.md': 'local content' }, { 'same.md': 'cloud content' });
    const file = mobileConflictFile((await f.engine.preview()).conflicts[0]);
    assert.equal(file.description, '文件内容不同');
    assert.equal(file.showPaths, false);
  }
  {
    const f = await fixture({ 'local.md': 'same' }, { 'cloud.md': 'same' });
    const file = mobileConflictFile((await f.engine.preview()).conflicts[0]);
    assert.equal(file.description, '文件内容相同，路径不同');
    assert.equal(file.localChoiceLabel, '采用本机路径');
    assert.equal(file.remoteChoiceLabel, '采用云端路径');
    assert.equal(file.showPaths, true);
  }
  // One-sided expansion is a readonly whole-file preview, not a selectable text diff.
  {
    const file = { path: 'missing.md', remotePaths: ['missing.md'], mergeable: false,
      totalLines: 0, localUpdatedAt: '', remoteUpdatedAt: '', blocks: [] };
    const modal = new ZoeySyncConflictPreviewModal({}, { files: [file], read: async () => ({ local: '', remote: 'existing cloud text' }) });
    modal.active = true; modal.render = () => {};
    await modal.loadFile(file);
    assert.equal(modal.wholeContents.get(file.path).remote, 'existing cloud text');
    assert.equal(modal.parts.has(file.path), false);
    assert.equal(modal.getReadyFiles().length, 0, 'expansion alone is not a direction decision');
    modal.fileChoices.set(file.path, 'local');
    assert.equal(modal.getReadyFiles().length, 1);
  }
  // File stage preserves choices, bulk actions are scoped, and only final confirmation resolves.
  {
    const files = [
      { path: 'cloud-only', reviewStage: 'file', keepSide: 'remote', blocks: [], mergeable: false },
      { path: 'local-only', reviewStage: 'file', keepSide: 'local', blocks: [], mergeable: false },
      { path: 'edited', reviewStage: 'content', blocks: [], mergeable: true }
    ];
    const review = new ZoeySyncConflictPreviewModal({}, { files, read: async () => ({ local: '', remote: '' }) });
    review.render = () => {}; review.close = () => {};
    let result;
    review.resolve = choices => { result = choices; };
    assert.equal(review.stage, 'file');
    assert.equal(review.selectionTone(files[0]), undefined, 'undecided empty blocks have no color');
    review.fileChoices.set('cloud-only', 'delete');
    assert.equal(review.selectionTone(files[0]), undefined, 'delete is not a mixed choice');
    review.clearStageChoices();
    review.keepAll();
    assert.equal(review.fileChoices.get('cloud-only'), 'remote');
    assert.equal(review.fileChoices.get('local-only'), 'local');
    assert.equal(review.fileChoices.has('edited'), false);
    review.selectAll('local');
    review.applyReadyFiles();
    assert.equal(review.stage, 'content');
    assert.equal(result, undefined);
    assert.equal(review.pending.size, 3);
    review.selectAll('remote');
    assert.equal(review.fileChoices.get('cloud-only'), 'local');
    review.applyReadyFiles();
    assert.deepEqual(result, { 'cloud-only': { choice: 'local' }, 'local-only': { choice: 'local' }, edited: { choice: 'remote' } });
  }
  // Confirming choices executes directly; cancellation/stale snapshots never execute.
  for (const scenario of ['confirm', 'cancel', 'staleLocal', 'staleRemote', 'unchanged', 'failure']) {
    const f = await fixture({ 'shared.md': 'local' }, scenario === 'unchanged' ? { 'shared.md': 'local' }
      : { 'shared.md': 'cloud', 'missing.md': 'cloud only' });
    const plan = await f.engine.preview();
    const originalReview = ZoeySyncConflictPreviewModal.prototype.wait;
    const stages = [];
    const choices = Object.fromEntries(plan.conflicts.map(c => [c.id, { choice: 'local' }]));
    const execute = f.engine.execute.bind(f.engine);
    f.engine.execute = async next => { stages.push('execute'); if (scenario === 'failure') throw new Error('simulated execution failure'); return execute(next); };
    ZoeySyncConflictPreviewModal.prototype.wait = async function () {
      stages.push('differences');
      if (scenario === 'cancel') return null;
      if (scenario === 'staleLocal') { await f.adapter.write('shared.md', 'new local edit'); f.engine.event('modify', 'shared.md'); }
      if (scenario === 'staleRemote') f.cloudEdit('shared.md', 'new cloud edit');
      return choices;
    };
    try {
      const review = new MobileSyncModal({}, f.engine, plan);
      review.open = () => { throw new Error('redundant confirmation must not open'); };
      if (scenario === 'staleLocal' || scenario === 'staleRemote') {
        await assert.rejects(review.wait(), /状态发生变化/);
        assert.deepEqual(stages, ['differences']);
        assert.equal(f.engine.state.baseCommitSha, null);
        assert(!f.calls.some(c => ['POST', 'PATCH'].includes(c.method)));
      } else if (scenario === 'cancel') {
        assert.equal(await review.wait(), false);
        assert.deepEqual(stages, ['differences']);
        assert.equal(f.engine.state.baseCommitSha, null);
        assert(!f.calls.some(c => ['POST', 'PATCH'].includes(c.method)));
      } else if (scenario === 'failure') {
        await assert.rejects(review.wait(), /execution failure/);
        assert.equal(f.engine.state.baseCommitSha, null);
      } else {
        assert.equal(await review.wait(), true);
        assert.deepEqual(stages, scenario === 'unchanged' ? ['execute'] : ['differences', 'execute']);
        assert.equal(f.engine.state.baseCommitSha, f.head());
        assert.equal(f.remote()['shared.md'].sha, hash(Buffer.from('local')));
        assert(!f.remote()['missing.md']);
      }
    } finally { ZoeySyncConflictPreviewModal.prototype.wait = originalReview; }
  }
  async function guide(result) {
    const plugin = Object.create(LinkPlugin.prototype), steps = [];
    const engine = { state: { baseCommitSha: null }, load: async () => {},
      verifyAccess: async () => { steps.push("verify"); return { branch: "main" }; },
      bind: async verified => { assert.equal(verified.branch, "main"); steps.push("bind"); return verified; },
      preview: async () => { assert.equal(plugin.syncing, true); assert.equal(plugin.featureActive, true); steps.push("preview"); return {}; } };
    plugin.settings = { mobile: {}, enabled: false, desktopGitEnabled: true };
    plugin.host = { app: {} }; plugin.desktopGitQueue = Promise.resolve();
    plugin.getMobileGithub = () => engine;
    plugin.deactivateFeature = () => { plugin.featureActive = false; };
    plugin.activateFeature = () => { plugin.featureActive = true; };
    plugin.saveSettings = async () => { steps.push("save"); };
    plugin.mobileHost = () => ({ save: async () => {} });
    plugin.setStatus = text => { plugin.lastStatus = text; };
    plugin.recordSuccess = async () => { assert(engine.state.baseCommitSha); steps.push("success"); };
    MobileSyncModal.prototype.wait = async function () {
      steps.push("review");
      if (result === "fail") throw new Error("simulated sync failure");
      if (result) engine.state.baseCommitSha = "aligned";
      return result;
    };
    if (result === true) {
      await plugin.completeLightweightGuide({ repoUrl: "fixture", plugins: [], ignorePatterns: [] });
      assert(plugin.settings.lastSyncAt);
      assert(steps.indexOf("review") < steps.indexOf("success"));
      assert.equal(plugin.settings.enabled, true);
      assert.equal(plugin.settings.desktopGitEnabled, false);
    } else {
      await assert.rejects(plugin.completeLightweightGuide({ repoUrl: "fixture", plugins: [], ignorePatterns: [] }),
        result === "fail" ? /sync failure/ : /接入尚未完成/);
      assert(!steps.includes("success"));
      assert.equal(engine.state.baseCommitSha, null);
      assert.equal(plugin.settings.mobile.bound, true, "connection remains available for retry");
    }
    assert.equal(plugin.syncing, false);
    assert.equal(plugin.switchingSyncMode, false);
  }
  {
    const plugin = Object.create(LinkPlugin.prototype);
    plugin.settings = { mobile: { bound: true, token: 'keep-token', repoUrl: 'keep-repo' } };
    plugin.host = { app: {} };
    let resets = 0;
    plugin.getMobileGithub = () => ({ restartSetup: async () => { resets++; return true; } });
    plugin.saveSettings = async () => {};
    plugin.mobileHost = () => ({ save: async () => {} });
    plugin.setStatus = () => {};
    plugin.syncing = true;
    await assert.rejects(plugin.restartLightweightSetup(), /等待当前同步/);
    assert.equal(resets, 0);
    plugin.syncing = false;
    assert.equal(await plugin.restartLightweightSetup(), true);
    assert.equal(plugin.settings.mobile.bound, false, 'automatic sync stays paused until rejoining');
    assert.equal(plugin.settings.mobile.token, 'keep-token');
    assert.equal(plugin.settings.mobile.repoUrl, 'keep-repo');
    assert.equal(plugin.switchingSyncMode, false);
  }
  await guide(true);
  await guide(false);
  await guide("fail");
  {
    const cloud = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`cloud/${index}.md`, `cloud ${index}`]));
    const packed = await fixture({ 'local-only.md': 'keep local' }, { ...cloud,
      '.obsidian/plugins/unselected/main.js': 'do not install', '.obsidian/plugins/simple-link/data.json': 'private' });
    const plan = await reviewedPreview(packed);
    const snapshot = plan.remote.commit;
    const stagedPaths = [];
    const writePacked = packed.adapter.writeBinary;
    packed.adapter.writeBinary = async (path, bytes) => {
      if (path.includes('link-state.json.archive/')) {
        stagedPaths.push(path);
        assert.equal(packed.engine.allowed(path), false, 'temporary archive files never enter the sync scope');
      }
      return writePacked(path, bytes);
    };
    await packed.engine.execute(plan);
    assert.equal(stagedPaths.length, 2000, 'archive files are staged individually instead of retained in memory');
    assert(stagedPaths.every(path => !packed.local.has(path)), 'staged data is cleaned after applying');
    assert(packed.progress.some(text => text.includes('正在从远端下载云端压缩包')));
    assert(packed.progress.some(text => text.includes('云端压缩包下载成功')));
    assert.equal(packed.calls.filter(c => c.path.startsWith('/zipball/')).length, 1);
    assert(packed.calls.some(c => c.path === `/zipball/${snapshot}`), 'archive is pinned to the reviewed snapshot');
    assert.equal(packed.calls.filter(c => c.path.startsWith('/git/blobs/')).length, 0);
    assert.equal(packed.local.get('local-only.md').bytes.toString(), 'keep local');
    for (const path of Object.keys(cloud)) assert(packed.local.has(path));
    assert(!packed.local.has('.obsidian/plugins/unselected/main.js'));
    assert(!packed.local.has('.obsidian/plugins/simple-link/data.json'));
    assert(packed.remote()['.obsidian/plugins/unselected/main.js'], 'unselected plugins stay in the cloud');
  }
  for (const invalid of ['broken-zip', 'wrong-hash', 'download-failed', 'staging-failed']) {
    const packed = await fixture({}, { 'note.md': 'original cloud' });
    const upstream = globalThis.githubRequest;
    globalThis.githubRequest = async request => {
      if (!request.url.includes('/zipball/')) return upstream(request);
      if (invalid === 'download-failed') return { status: 503, headers: {}, json: {} };
      const bytes = invalid === 'broken-zip' ? new Uint8Array([1, 2, 3])
        : zipSync({ 'vault/note.md': new TextEncoder().encode(invalid === 'staging-failed' ? 'original cloud' : 'incorrect archive content') });
      return { status: 200, headers: { 'content-type': 'application/zip' }, arrayBuffer: bytes.buffer };
    };
    if (invalid === 'staging-failed') {
      const originalWrite = packed.adapter.writeBinary;
      packed.adapter.writeBinary = async (path, bytes) => {
        if (path.includes('link-state.json.archive/')) throw new Error('staging disk failure');
        return originalWrite(path, bytes);
      };
    }
    await packed.engine.execute(await reviewedPreview(packed));
    assert.equal(packed.local.get('note.md').bytes.toString(), 'original cloud');
    assert(packed.calls.some(c => c.path.startsWith('/git/blobs/')), 'bad archive safely falls back to an original blob');
    assert(packed.progress.some(text => text.includes('改用逐文件下载')), 'fallback remains visible during local application');
    if (invalid === 'download-failed') assert(packed.progress.some(text => text.includes('压缩包下载失败：GitHub HTTP 503')));
    if (invalid === 'broken-zip') assert(packed.progress.some(text => text.includes('下载成功，但解压或暂存未完成')));
  }
  console.log('Repository archives: 2000 files in one request, empty vault, keep both sides, snapshot pinning, plugin exclusions and corrupt archive fallback passed');
  // The download task survives a restart and never falls back to networking during a local import.
  {
    assert.equal(downloadSummary(1000, 3000).recommend, false);
    assert.equal(downloadSummary(1001, 3000).recommend, true);
    assert.equal(downloadSummary(100, 200).recommend, true);
    assert.equal(downloadSummary(99, 100).recommend, false);
    const original = await fixture({ 'local.md': 'local', '.obsidian/workspace.json': 'private local' },
      { 'remote.md': 'remote', '.obsidian/workspace.json': 'cloud workspace', '.obsidian/plugins/unselected/main.js': 'unselected' });
    const plan = await original.engine.preview();
    const merged = await original.engine.preview(strategyChoices(plan, 'merge'));
    assert.equal(merged.conflicts.length, 0);
    assert(merged.desired['local.md'] && merged.desired['remote.md']);
    const cloudOnly = mirrorPlan(plan, 'remote');
    assert.deepEqual(cloudOnly.localDeletes, ['local.md']);
    assert(!cloudOnly.desired['.obsidian/workspace.json']);
    const localOnly = mirrorPlan(plan, 'local');
    assert.deepEqual(localOnly.remoteDeletes, ['remote.md']);
    await original.engine.execute(merged, true);
    assert.equal(original.engine.state.baseCommitSha, null, 'upload confirmation does not advance the baseline');
    assert(original.remote()['local.md'], 'local uploads finish before the download choice');
    assert.equal(original.local.has('remote.md'), false);
    assert.equal(original.calls.filter(call => call.path.startsWith('/zipball/') || call.path.startsWith('/git/blobs/')).length, 0);
    assert.equal(original.engine.downloadUrl, `https://github.com/example/vault/archive/${original.head()}.zip`);
    const restored = new MobileGithub(original.adapter, '.obsidian', 'simple-link', () => original.options, () => {});
    await restored.load();
    assert.equal(restored.downloadTask.mode, 'choice');
    assert.equal(restored.downloadUrl, original.engine.downloadUrl);
    await assert.rejects(restored.preview(), /整库下载待办/);
    const asSource = bytes => ({ size: bytes.length, slice: (start, end) => ({ arrayBuffer: async () => {
      assert(end - start <= 65536, 'ZIP reads stay bounded'); return Uint8Array.from(bytes.subarray(start, end)).buffer;
    } }) });
    const callsBefore = original.calls.length;
    await assert.rejects(restored.importDownload(asSource(zipSync({ 'root/remote.md': Buffer.from('wrong') }))), /不一致/);
    assert.equal(original.local.has('remote.md'), false);
    assert.equal(original.calls.length, callsBefore, 'a wrong archive makes no network requests');
    await assert.rejects(restored.importDownload(asSource(zipSync({ 'root/other.md': Buffer.from('other') }))), /缺少/);
    assert(restored.downloadTask);
    const good = zipSync({ 'root/remote.md': Buffer.from('remote'), 'root/local.md': Buffer.from('local'),
      'root/.obsidian/workspace.json': Buffer.from('cloud workspace'), 'root/.obsidian/plugins/unselected/main.js': Buffer.from('unselected') });
    original.fail('remote.md');
    await assert.rejects(restored.importDownload(asSource(good)), /disk failure/);
    assert.equal(restored.state.baseCommitSha, null);
    assert(restored.downloadTask, 'disk failure preserves the task');
    original.fail('');
    await restored.importDownload(asSource(good));
    assert.equal(original.local.get('remote.md').bytes.toString(), 'remote');
    assert.equal(original.local.get('.obsidian/workspace.json').bytes.toString(), 'private local');
    assert.equal(original.local.has('.obsidian/plugins/unselected/main.js'), false);
    assert.equal(restored.downloadTask, undefined);
    assert.equal(restored.state.baseCommitSha, original.head());
    assert.equal(original.calls.filter(call => call.path.startsWith('/zipball/') || call.path.startsWith('/git/blobs/')).length, 0);
    assert(![...original.local.keys()].some(path => path.includes('link-state.json.archive/')), 'staged files are removed after success/failure');
  }
  for (const scenario of ['nested-folder', 'ambiguous-folder', 'edited-local', 'changed-cloud', 'automatic']) {
    const f = await fixture({}, { 'note.md': 'cloud note' });
    await f.engine.execute(await reviewedPreview(f), true);
    const baseline = f.engine.state.baseCommitSha;
    const file = path => ({ name: 'note.md', webkitRelativePath: path, size: 10,
      slice: () => ({ arrayBuffer: async () => Uint8Array.from(Buffer.from('cloud note')).buffer }) });
    if (scenario === 'automatic') {
      await f.engine.resumeAutomaticDownload();
      assert.equal(f.engine.downloadTask, undefined);
      assert.equal(f.local.get('note.md').bytes.toString(), 'cloud note');
    } else if (scenario === 'ambiguous-folder') {
      await assert.rejects(f.engine.importDownload([file('outer/one/note.md'), file('outer/two/note.md')]), /多个可能/);
      assert.equal(f.local.has('note.md'), false);
      assert.equal(f.engine.state.baseCommitSha, baseline);
    } else if (scenario === 'edited-local') {
      await f.adapter.write('note.md', 'new local edit');
      await assert.rejects(f.engine.importDownload([file('root/note.md')]), /本机又被修改/);
      assert.equal(f.local.get('note.md').bytes.toString(), 'new local edit');
      assert.equal(f.engine.state.baseCommitSha, baseline);
      assert(f.engine.downloadTask, 'local edits do not silently dismiss the task');
      assert.equal(f.engine.downloadTask.reviewRequired, true);
      const editedReload = new MobileGithub(f.adapter, '.obsidian', 'simple-link', () => f.options, () => {});
      await editedReload.load();
      assert(editedReload.downloadTask.reviewRequired);
      await editedReload.resetDownloadProgress();
      assert.equal(editedReload.downloadTask, undefined);
      assert.equal(f.local.get('note.md').bytes.toString(), 'new local edit');
    } else {
      if (scenario === 'changed-cloud') f.cloudEdit('note.md', 'newer cloud note');
      const fixedCommit = f.engine.state.pending.commit;
      await f.engine.importDownload([file('outer/archive/root/note.md')]);
      assert.equal(f.local.get('note.md').bytes.toString(), 'cloud note');
      assert.equal(f.engine.state.baseCommitSha, fixedCommit, 'only the reviewed snapshot becomes baseline');
      assert(!f.calls.some(call => call.path.startsWith('/git/blobs/')));
    }
  }
  console.log('Manual download: deferred uploads, durable tasks, bounded ZIP reads, root detection, protected settings, wrong/missing data, write failures and local edits passed');
  for (const strategy of ['merge', 'local', 'remote', 'custom', 'cancel', 'cancel-confirm']) {
    const f = await fixture({ 'local.md':'local', 'same.md':'local version' }, { 'remote.md':'remote', 'same.md':'remote version' });
    const stages=[];
    const review = new MobileSyncModal({}, f.engine, await f.engine.preview(), false,
      async live => Object.fromEntries(live.files.map(file=>[file.path,{choice:file.path==='new:remote.md'?'remote':'local'}])), {
        strategy:async()=>{stages.push('strategy');return strategy==='cancel'?null:strategy==='cancel-confirm'?'merge':strategy;},
        confirm:async plan=>{stages.push('confirm');if(strategy==='remote')assert(plan.localDeletes.includes('local.md'));return strategy!=='cancel-confirm';},
        transfer:async()=>{stages.push('transfer');}
      });
    const result=await mobileFlowWait.call(review);
    if(strategy==='cancel'||strategy==='cancel-confirm') {
      assert.equal(result,false);assert(!f.calls.some(call=>['POST','PATCH'].includes(call.method)));
      assert.equal(f.engine.state.baseCommitSha,null);
    } else {
      assert.equal(result,true);assert.deepEqual(stages,['strategy','confirm']);
      if(strategy==='remote') {assert(!f.local.has('local.md'));assert.equal(f.local.get('same.md').bytes.toString(),'remote version');}
      if(strategy==='local') {assert(!f.remote()['remote.md']);assert.equal(f.local.has('remote.md'),false);}
      if(strategy==='merge') {assert(f.local.has('local.md')&&f.local.has('remote.md'));}
    }
  }
  {
    const f=await fixture({},Object.fromEntries(Array.from({length:101},(_,i)=>[`note-${i}.md`,String(i)])));
    const stages=[];
    const review=new MobileSyncModal({},f.engine,await f.engine.preview(),false,undefined,{
      strategy:async()=>{stages.push('strategy');return 'merge';},confirm:async()=>{stages.push('confirm');return true;},
      transfer:async()=>{stages.push('transfer');}
    });
    assert.equal(await mobileFlowWait.call(review),false);
    assert.deepEqual(stages,['strategy','confirm','transfer']);
    assert(f.engine.downloadTask);assert.equal(f.engine.state.baseCommitSha,null);
    assert(!f.calls.some(call=>call.path.startsWith('/git/blobs/')||call.path.startsWith('/zipball/')));
  }
  console.log('Sync workflow: four strategies, safe cancellation, deletion review and large-download deferral passed');
  {
    const f=await fixture({'base.md':'base'},{'base.md':'base'});await align(f);
    const baseline=f.engine.state.baseCommitSha;
    f.cloudEdit('new.md','new');
    await f.engine.execute(await f.engine.preview(),true);
    await f.engine.resetDownloadProgress();
    assert.equal(f.engine.state.baseCommitSha,baseline,'reset preserves the completed baseline');
    assert(f.remote()['new.md'],'reset never undoes cloud content');
    assert.equal(f.engine.initialSync,true,'reset reopens initial review');
    assert.equal(f.options.bound,true);
  }
  {
    const f=await fixture({},{'note.md':'cloud note'});
    await f.engine.execute(await reviewedPreview(f),true);
    const write=f.adapter.write;
    f.adapter.write=async(path,text)=>{
      const state=JSON.parse(text);
      if(path===f.engine.statePath&&!state.pending&&state.baseCommitSha)throw new Error('final state disk failure');
      await write(path,text);
    };
    await assert.rejects(f.engine.resumeAutomaticDownload(),/final state disk failure/);
    assert(f.engine.downloadTask,'failed completion persistence keeps the task visible');
    assert.equal(f.engine.state.baseCommitSha,null);
    f.adapter.write=write;
    await f.engine.resumeAutomaticDownload();
    assert.equal(f.engine.downloadTask,undefined);
  }
  {
    const f=await fixture({'base.md':'base'},{'base.md':'base'});await align(f);
    for(let i=0;i<1001;i++)f.cloudEdit(`daily-${i}.md`,String(i));
    let transfers=0;
    const review=new MobileSyncModal({},f.engine,await f.engine.preview(),false,undefined,{
      strategy:async()=>{throw Error('daily sync should not require initial strategy');},confirm:async()=>true,
      transfer:async()=>{transfers++;}
    });
    assert.equal(await mobileFlowWait.call(review),true);
    assert.equal(transfers,0,'daily API sync never reopens whole-vault download');
    assert.equal(f.calls.filter(call=>call.path.startsWith('/zipball/')).length,0);
    assert.equal(f.calls.filter(call=>call.path.startsWith('/git/blobs/')).length,1001);
    assert.equal(f.engine.downloadTask,undefined);
  }
  console.log('Download task lifetime: edited files, final save failures, explicit reset and daily 1001-file API sync passed');
  console.log("Mobile first sync, baseline/cache, conflicts, rename and recovery checks passed");
} finally {
  delete globalThis.githubRequest;
  await rm(folder, { recursive: true, force: true });
}
