const readStoredState = async (adapter, path) => { const raw = JSON.parse(await adapter.read(path)); return raw.state ?? raw; };
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
  await esbuild.build({ stdin: { contents: 'export { MobileGithub } from "./src/features/sync/mobileGithub"; export { mirrorPlan, strategyChoices } from "./src/features/sync/syncPlan";', resolveDir: process.cwd() }, bundle: true, platform: "node", format: "cjs", outfile: bundle,
    plugins: [{ name: "mock-obsidian", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
      build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: "export const requestUrl = request => globalThis.githubRequest(request);" }));
    } }] });
  const { MobileGithub, mirrorPlan, strategyChoices } = require(bundle);
  async function fixture(localTexts, remoteTexts, { prepare = true, ...overrides } = {}) {
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
      if (path === '/user') json = { login: 'fixture-user' };
      else if (path === "") json = { private: true, default_branch: "main", permissions: { push: true } };
      else if (path === '/branches/main') json = { protected: false };
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
      syncImages: true, syncPlugins: false, plugins: [], ignorePatterns: [], cacheEnabled: true, trackPaths: true, ...overrides };
    const progress = [], timings = [];
    let timingHook;
    const engine = new MobileGithub(adapter, ".obsidian", "simple-link", () => options, message => progress.push(message),
      async (context, status, message) => {
        timings.push({ context, status, message });
        await timingHook?.(context, status, message);
      }, () => true);
    if (prepare) await engine.prepareLocalRules();
    await engine.bind();
    calls.length = 0;
    return { engine, adapter, local, calls, options, progress, timings, onTiming: hook => { timingHook = hook; }, remote: () => trees.get(root), head: () => head, root: () => root,
      fail: path => { failWrite = path; },
      move: (from, to) => { local.set(to, local.get(from)); local.delete(from); engine.event("rename", to, from); },
      cloudEdit: (path, text) => {
        const next = { ...trees.get(root), [path]: { sha: storeBlob(text), mode: "100644" } };
        const parent = head; root = `t${++treeIndex}`; trees.set(root, next); head = `c${++commitIndex}`; commits.set(head, { tree: root, parent });
      },
      cloudDelete: path => {
        const next = { ...trees.get(root) }; delete next[path];
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
      assert.equal(f.timings.at(-1).status, 'error');
      assert.match(f.timings.at(-1).message, /失败阶段：读取远端/);
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
  // Explicit setup prepares local rules once; revisiting it never rewrites valid user rules.
  {
    const original = '# personal comment\nprivate/\n';
    const f = await fixture({ '.gitignore': original }, {}, { prepare: false });
    f.calls.length = 0;
    f.adapter.list = async () => { throw Error('preparing setup must not scan the vault'); };
    f.adapter.readBinary = async () => { throw Error('preparing setup must not hash vault contents'); };
    const write = f.adapter.write;
    let rootWrites = 0, failRules = true;
    f.adapter.write = async (path, text) => {
      if (path === '.gitignore') {
        rootWrites++;
        if (failRules) throw Error('fixture root write failed');
      }
      return write(path, text);
    };
    await assert.rejects(f.engine.prepareLocalRules(), /fixture root write failed/);
    assert.equal(await f.adapter.read('.gitignore'), original);
    failRules = false;
    await f.engine.prepareLocalRules();
    const prepared = await f.adapter.read('.gitignore');
    assert(prepared.includes(original.trimEnd()));
    const writes = rootWrites;
    await f.engine.prepareLocalRules();
    assert.equal(rootWrites, writes, 'reopening setup must not rewrite local rules');
    assert.equal(await f.adapter.read('.gitignore'), prepared);
    assert.equal(f.engine.state.baseCommitSha, null, 'preparing rules does not create a sync baseline');
    assert(!f.calls.some(call => call.path.startsWith('/git/trees/') || ['POST', 'PATCH'].includes(call.method)),
      'preparing local rules does not scan or mutate remote files');
  }
  // Root rules control portable Obsidian settings, while device workspaces remain local.
  {
    const texts = { '.obsidian/hotkeys.json': '{}', '.obsidian/themes/example/theme.css': 'body{}',
      '.obsidian/workspace.json': 'device workspace', '.obsidian/cache/index.json': 'device cache' };
    const f = await fixture({}, texts);
    await f.engine.execute(await reviewedPreview(f));
    for (const path of ['.obsidian/hotkeys.json', '.obsidian/themes/example/theme.css']) {
      assert.equal(f.local.get(path).bytes.toString(), texts[path]);
    }
    for (const path of ['.obsidian/workspace.json', '.obsidian/cache/index.json']) {
      assert(!f.local.has(path));
      assert.equal(f.remote()[path].sha, hash(Buffer.from(texts[path])));
    }
  }
  // Removing a path from the local scope preserves both copies, including the remote tree.
  {
    const f = await fixture({ 'keep.md': 'keep', 'excluded/note.md': 'original' },
      { 'keep.md': 'keep', 'excluded/note.md': 'original' });
    await align(f);
    const existing = await f.adapter.read('.gitignore');
    await f.adapter.write('.gitignore', existing + '\nexcluded/\n');
    await f.adapter.write('excluded/note.md', 'unsynced local edit');
    f.cloudEdit('excluded/note.md', 'unsynced cloud edit');
    const plan = await f.engine.preview();
    assert(!plan.local['excluded/note.md'] && !plan.remote.files['excluded/note.md']);
    assert(!plan.localDeletes.includes('excluded/note.md') && !plan.remoteDeletes.includes('excluded/note.md'));
    await f.engine.execute(plan);
    assert.equal(f.local.get('excluded/note.md').bytes.toString(), 'unsynced local edit');
    assert.equal(f.remote()['excluded/note.md'].sha, hash(Buffer.from('unsynced cloud edit')));
  }
  // One timing summary per active operation, without note paths, contents or raw failures.
  {
    const f = await fixture({ 'private-local.md': 'private local text' }, { 'private-cloud.md': 'private cloud text' });
    const original = await f.engine.preview();
    const previewLog = f.timings.at(-1);
    assert.equal(previewLog.context, '轻量比对耗时'); assert.equal(previewLog.status, 'success');
    for (const label of ['预览恢复', '读取远端', '扫描本地', '保存缓存', '差异计算']) assert(previewLog.message.includes(label));
    const plan = await f.engine.recalculate(original, Object.fromEntries(original.conflicts.map(c => [c.id, { choice: c.local ? 'local' : 'remote' }])));
    assert.equal(f.timings.at(-1).context, '轻量重算耗时');
    assert.match(f.timings.at(-1).message, /差异计算/);
    await f.engine.execute(plan);
    const executed = f.timings.at(-1);
    assert.equal(executed.context, '轻量执行耗时'); assert.equal(executed.status, 'success');
    for (const label of ['核对远端', '复核本地', '上传准备与写树', '创建提交', '保存恢复记录', '更新分支', '下载与落盘', '结果验证', '保存基准']) assert(executed.message.includes(label), `${label}: ${executed.message}`);
    assert.match(executed.message, /总耗时 \d+\.\d{2} 秒/);
    assert.equal(f.timings.length, 3, 'files and internal stages do not create extra log entries');
    assert(!JSON.stringify(f.timings).includes('private'), 'timing summaries contain no paths or note contents');
    assert.match(previewLog.message, /扫描本地：\d+ 个文件/);
    f.engine.timingEnabled = () => false;
    const timingCount = f.timings.length;
    await f.engine.preview();
    assert.equal(f.timings.length, timingCount, 'disabled diagnostics skip timing collection and callbacks');
  }
  // Log callbacks keep the operation lock, and rejection never changes success or the original error.
  {
    const f = await fixture({}, { 'private.md': 'private note text' });
    f.onTiming(async () => {
      await assert.rejects(f.engine.preview(), /正在检查/);
      throw new Error('simulated log storage failure');
    });
    const original = await f.engine.preview();
    const plan = await f.engine.recalculate(original, Object.fromEntries(original.conflicts.map(c => [c.id, { choice: 'remote' }])));
    await f.engine.execute(plan);
    assert.equal(f.local.get('private.md').bytes.toString(), 'private note text');
    assert.equal(f.engine.state.pending, undefined);
    assert.equal(f.engine.running, false);
    const broken = await fixture({}, { 'private.md': 'private note text' });
    broken.onTiming(async () => { throw new Error('simulated log storage failure'); });
    const before = await broken.engine.preview();
    const ready = await broken.engine.recalculate(before, Object.fromEntries(before.conflicts.map(c => [c.id, { choice: 'remote' }])));
    const originalError = new Error('private disk failure details');
    broken.adapter.writeBinary = async () => { throw originalError; };
    await assert.rejects(broken.engine.execute(ready), error => error === originalError);
    assert.equal(broken.timings.at(-1).status, 'error');
    assert.match(broken.timings.at(-1).message, /失败阶段：下载与落盘/);
    assert(!JSON.stringify(broken.timings).includes('private'));
    assert.equal(broken.engine.running, false); assert.equal(broken.engine.activeTiming, undefined);
    assert(broken.engine.state.pending, 'timing logs cannot clear interrupted work');
    assert.equal(broken.engine.state.baseCommitSha, null);
  }
  // Choice changes reuse one immutable preview without API calls, file scans or state writes.
  {
    const f = await fixture({ 'shared.md': 'local' }, { 'shared.md': 'cloud', 'remote.md': 'remote only' });
    const original = await f.engine.preview();
    const choices = side => Object.fromEntries(original.conflicts.map(c => [c.id, { choice: side }]));
    const calls = f.calls.length, saved = JSON.stringify(f.engine.state);
    const list = f.adapter.list, stat = f.adapter.stat, readBinary = f.adapter.readBinary, write = f.adapter.write;
    let diskCalls = 0;
    const forbidden = async () => { diskCalls++; throw new Error('recalculate must not access disk'); };
    f.adapter.list = f.adapter.stat = f.adapter.readBinary = f.adapter.write = forbidden;
    let localPlan, remotePlan;
    try {
      localPlan = await f.engine.recalculate(original, choices('local'));
      remotePlan = await f.engine.recalculate(localPlan, choices('remote'));
      assert.equal(localPlan.desired['shared.md'].sha, hash(Buffer.from('local')));
      assert.equal(remotePlan.desired['shared.md'].sha, hash(Buffer.from('cloud')));
      assert(remotePlan.downloads.includes('remote.md'));
      const manual = await f.engine.recalculate(original, { ...choices('remote'), 'new:shared.md': { choice: 'manual', text: 'merged\r\n' } });
      assert.equal(manual.desired['shared.md'].sha, hash(Buffer.from('merged\n')));
      assert.equal(manual.mergedContents[manual.desired['shared.md'].sha], 'merged\n');
      original.local['shared.md'].sha = 'tampered';
      original.remote.files['shared.md'].sha = 'tampered';
      const isolated = await f.engine.recalculate(original, choices('local'));
      assert.equal(isolated.local['shared.md'].sha, hash(Buffer.from('local')), 'public plans do not mutate the private snapshot');
      assert.equal(isolated.remote.files['shared.md'].sha, hash(Buffer.from('cloud')));
    } finally {
      Object.assign(f.adapter, { list, stat, readBinary, write });
    }
    assert.equal(diskCalls, 0);
    assert.equal(f.calls.length, calls);
    assert.equal(JSON.stringify(f.engine.state), saved);
    const fresh = await f.engine.preview();
    assert.equal(fresh.conflicts.length, 2, 'ordinary preview always reads a new snapshot');
    await assert.rejects(f.engine.recalculate(localPlan, choices('remote')), /过期|变化/);
    await assert.rejects(f.engine.execute(localPlan), /过期|变化/);
  }
  for (const changed of ['event', 'scope', 'base']) {
    const f = await fixture({ 'shared.md': 'local' }, { 'shared.md': 'cloud' });
    const original = await f.engine.preview();
    if (changed === 'event') f.engine.event('modify', 'shared.md');
    if (changed === 'scope') await f.adapter.write('.gitignore', 'excluded/\n');
    if (changed === 'base') f.engine.state.base['new-baseline.md'] = { sha: 'changed', mode: '100644' };
    const calls = f.calls.length;
    await assert.rejects(f.engine.recalculate(original, { 'new:shared.md': { choice: 'local' } }), changed === 'event'
      ? error => error.name === 'LocalSyncEdit' : /状态发生变化|gitignore.*变化/);
    assert.equal(f.calls.length, calls);
  }
  for (const changed of ['local-without-event', 'remote']) {
    const f = await fixture({ 'shared.md': 'local' }, { 'shared.md': 'cloud' });
    const original = await f.engine.preview();
    if (changed === 'remote') f.cloudEdit('shared.md', 'new cloud');
    else await f.adapter.write('shared.md', 'external edit without event');
    const calls = f.calls.length;
    const selected = await f.engine.recalculate(original, { 'new:shared.md': { choice: 'local' } });
    assert.equal(f.calls.length, calls, 'recalculation deliberately leaves final IO verification to execute');
    await assert.rejects(f.engine.execute(selected), changed === 'remote' ? /云端出现新提交/ : error => error.name === 'LocalSyncEdit');
    assert(!f.calls.some(call => ['POST', 'PATCH'].includes(call.method)), 'stale previews cannot mutate the remote');
    assert.equal(f.engine.state.baseCommitSha, null);
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
      const rawSaved = JSON.parse(await f.adapter.read(path));
      const saved = rawSaved.state ?? rawSaved;
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
    assert(f.progress.some(text => text.includes("待同步 2 个文件 · 准备上传 1 个")));
    await f.engine.execute(plan);
    assert(f.progress.some(text => text.includes("待同步 2 个文件 · 准备上传 0 个")), "prepared uploads remain pending until the branch update succeeds");
    assert(f.progress.some(text => text.includes("待同步 1 个文件")));
    assert(f.progress.some(text => text.includes("待同步 0 个文件")));
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
  // All-plugin selection includes plugins installed after the first sync.
  {
    const f = await fixture({ 'keep.md': 'keep' }, { 'keep.md': 'keep' }, { syncPlugins: true, plugins: ['*'] });
    await align(f);
    const localPlugin = '.obsidian/plugins/new-local/main.js';
    await f.adapter.write(localPlugin, 'new local program');
    const localPlan = await f.engine.preview();
    assert(localPlan.uploads.includes(localPlugin), 'new local plugin is discovered after baseline');
    await f.engine.execute(localPlan);
    const cloudPlugin = '.obsidian/plugins/new-cloud/main.js';
    f.cloudEdit(cloudPlugin, 'new cloud program');
    const cloudPlan = await f.engine.preview();
    assert(cloudPlan.downloads.includes(cloudPlugin), 'new cloud plugin is discovered after baseline');
    await f.adapter.write('.gitignore', await f.adapter.read('.gitignore') + '\n.obsidian/plugins/new-cloud/\n');
    const excludedPlan = await f.engine.preview();
    assert(!excludedPlan.downloads.includes(cloudPlugin), 'explicitly excluded plugin remains excluded');
  }
  // Self-program sync keeps device state out of manifests and transactions.
  {
    const prefix = '.obsidian/plugins/simple-link/';
    const states = ['data.json', 'data.json.bak', 'link-state.json', 'link-state.json.recovery', 'mobile-ignore.json'];
    const remote = { [prefix + 'main.js']: 'new program', [prefix + 'manifest.json']: '{"id":"simple-link"}' };
    for (const name of states) remote[prefix + name] = 'other device state';
    const f = await fixture({ [prefix + 'data.json']: 'my credentials', [prefix + 'mobile-ignore.json']: 'my rules' }, remote,
      { syncPlugins: true, plugins: ['simple-link'], ignorePatterns: ['!' + prefix + '*'] });
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
  // A pending journal must be durable before the branch ref may be patched.
  {
    const f = await fixture({ 'note.md': 'base' }, { 'note.md': 'base' });
    await align(f);
    const baseline = f.engine.state.baseCommitSha, write = f.adapter.write;
    await f.adapter.write('upload.md', 'local upload'); f.engine.event('create', 'upload.md');
    const plan = await f.engine.preview();
    f.adapter.write = async (path, text) => {
      if (path.startsWith(f.engine.statePath) && JSON.parse(text).state?.pending) throw Error('fixture pending persistence failure');
      return write(path, text);
    };
    await assert.rejects(f.engine.execute(plan), /fixture pending persistence failure/);
    assert(!f.calls.some(call => call.method === 'PATCH'), 'journal failure must stop before updating the remote branch');
    assert.equal(f.head(), baseline);
    assert.equal(f.engine.state.baseCommitSha, baseline);
    assert(!f.remote()['upload.md']);
    f.adapter.write = write;
    await f.engine.execute(await f.engine.preview());
    assert.equal(f.remote()['upload.md'].sha, hash(Buffer.from('local upload')));
  }
  // A same-instance retry cannot mutate files while its application checkpoint cannot be persisted.
  {
    const f = await fixture({ 'note.md': 'base' }, { 'note.md': 'base' });
    await align(f);
    const baseline = f.engine.state.baseCommitSha, write = f.adapter.write, binary = f.adapter.writeBinary, remove = f.adapter.remove;
    f.cloudEdit('note.md', 'new cloud');
    const plan = await f.engine.preview();
    let mutations = 0, journalWrites = 0;
    f.adapter.writeBinary = async (...args) => { mutations++; return binary(...args); };
    f.adapter.remove = async (...args) => { mutations++; return remove(...args); };
    f.adapter.write = async (path, text) => {
      if (path.startsWith(f.engine.statePath) && JSON.parse(text).state?.pending && ++journalWrites > 2) throw Error('fixture journal unavailable');
      return write(path, text);
    };
    await assert.rejects(f.engine.execute(plan), /fixture journal unavailable/);
    assert((await readStoredState(f.adapter, f.engine.statePath)).pending, 'the original journal was durable before the application checkpoint failed');
    await assert.rejects(f.engine.preview(), /fixture journal unavailable/);
    assert.equal(mutations, 0, 'neither initial execute nor same-instance recovery may mutate files without a durable checkpoint');
    assert.equal(f.local.get('note.md').bytes.toString(), 'base');
    assert.equal(f.engine.state.baseCommitSha, baseline);
    f.adapter.write = write;
    await f.engine.preview();
    assert.equal(f.local.get('note.md').bytes.toString(), 'new cloud');
    assert.equal(f.engine.state.pending, undefined);
  }
  // A lost PATCH response is recovered from the persisted transaction, without another PATCH.
  {
    const f = await fixture({ 'note.md': 'base' }, { 'note.md': 'base' });
    await align(f);
    const baseline = f.engine.state.baseCommitSha;
    await f.adapter.write('upload.md', 'local upload'); f.engine.event('create', 'upload.md');
    f.cloudEdit('download.md', 'fixed cloud bytes');
    const plan = await f.engine.preview(), request = globalThis.githubRequest;
    globalThis.githubRequest = async value => {
      const response = await request(value);
      if (value.method === 'PATCH') throw Error('fixture accepted PATCH response lost');
      return response;
    };
    try { await assert.rejects(f.engine.execute(plan), /fixture accepted PATCH response lost/); }
    finally { globalThis.githubRequest = request; }
    const target = f.head();
    assert.notEqual(target, baseline);
    assert.equal(f.engine.state.baseCommitSha, baseline);
    assert.equal((await readStoredState(f.adapter, f.engine.statePath)).pending.commit, target);
    assert(!f.local.has('download.md'));
    const patches = f.calls.filter(call => call.method === 'PATCH').length;
    const restarted = new MobileGithub(f.adapter, '.obsidian', 'simple-link', () => f.options, () => {});
    const recovered = await restarted.preview();
    assert.equal(restarted.state.baseCommitSha, target);
    assert.equal(restarted.state.pending, undefined);
    assert.equal(f.local.get('download.md').bytes.toString(), 'fixed cloud bytes');
    assert.equal(f.calls.filter(call => call.method === 'PATCH').length, patches);
    assert.equal(recovered.uploads.length + recovered.downloads.length + recovered.localDeletes.length + recovered.remoteDeletes.length, 0);
  }
  // Failure to persist the final baseline retains the journal and the old common baseline.
  {
    const f = await fixture({ 'note.md': 'base' }, { 'note.md': 'base' });
    await align(f);
    const baseline = f.engine.state.baseCommitSha, oldBase = structuredClone(f.engine.state.base), write = f.adapter.write;
    f.cloudEdit('note.md', 'new cloud');
    const target = f.head(), plan = await f.engine.preview();
    f.adapter.write = async (path, text) => {
      if (path.startsWith(f.engine.statePath)) {
        const state = JSON.parse(text).state;
        if (state && state.baseCommitSha === target && !state.pending) throw Error('fixture final baseline persistence failure');
      }
      return write(path, text);
    };
    await assert.rejects(f.engine.execute(plan), /fixture final baseline persistence failure/);
    assert.equal(f.engine.state.baseCommitSha, baseline);
    assert.deepEqual(f.engine.state.base, oldBase);
    assert(f.engine.state.pending);
    const stored = await readStoredState(f.adapter, f.engine.statePath);
    assert.equal(stored.baseCommitSha, baseline); assert(stored.pending);
    assert.equal(f.local.get('note.md').bytes.toString(), 'new cloud');
    f.adapter.write = write;
    const restarted = new MobileGithub(f.adapter, '.obsidian', 'simple-link', () => f.options, () => {});
    await restarted.preview();
    assert.equal(restarted.state.baseCommitSha, target);
    assert.equal(restarted.state.pending, undefined);
    assert.equal(f.local.get('note.md').bytes.toString(), 'new cloud');
  }
  // Scope changes while a blob is in flight cannot write or advance an old transaction.
  for (const changedScope of ['branch', 'repoUrl']) {
    const f = await fixture({ 'note.md': 'base' }, { 'note.md': 'base' });
    await align(f);
    const baseline = f.engine.state.baseCommitSha;
    f.cloudEdit('note.md', 'cloud edit');
    const original = f.options[changedScope];
    const plan = await f.engine.preview(), request = globalThis.githubRequest;
    globalThis.githubRequest = async value => {
      const response = await request(value);
      if (value.url.includes('/git/blobs/')) f.options[changedScope] = changedScope === 'branch' ? 'other' : 'https://github.com/example/other.git';
      return response;
    };
    try { await assert.rejects(f.engine.execute(plan), /范围|变化|仓库/); }
    finally { globalThis.githubRequest = request; }
    assert.equal(f.local.get('note.md').bytes.toString(), 'base');
    assert.equal(f.engine.state.baseCommitSha, baseline);
    assert(f.engine.state.pending);
    assert(!f.calls.some(call => call.path.includes('/repos/example/other/git/blobs/')), 'scope switch cannot request the old transaction blob from a different repository');
    f.options[changedScope] = original;
    await f.engine.preview();
    assert.equal(f.local.get('note.md').bytes.toString(), 'cloud edit');
    assert.equal(f.engine.state.baseCommitSha, f.head());
    assert.equal(f.engine.state.pending, undefined);
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
    const saved = (await readStoredState(f.adapter, f.engine.statePath));
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
    assert.equal((await readStoredState(f.adapter, restarted.statePath)).pending, undefined);
    assert.equal(JSON.parse(await f.adapter.read(restarted.statePath)).downloadVerification, undefined);
  }
  // Recovery finishes its fixed SHA target before a later preview offers descendant edits.
  {
    const f = await fixture({ 'base.md': 'base' }, { 'base.md': 'base' });
    await align(f);
    const baseline = f.engine.state.baseCommitSha;
    f.cloudEdit('a.md', 'a-v1'); f.cloudEdit('b.md', 'b-v1');
    const target = f.head(), shaA = f.remote()['a.md'].sha, shaB = f.remote()['b.md'].sha;
    f.fail('b.md');
    await assert.rejects(f.engine.execute(await f.engine.preview()), /disk failure/);
    assert.equal(f.local.get('a.md').bytes.toString(), 'a-v1');
    assert.equal(f.engine.state.baseCommitSha, baseline);
    assert.equal(f.engine.state.pending.commit, target);
    const beforeA = f.calls.filter(call => call.path === '/git/blobs/' + shaA).length;
    f.cloudEdit('a.md', 'a-v2'); f.cloudEdit('b.md', 'b-v2');
    const descendant = f.head(), newerShaB = f.remote()['b.md'].sha;
    f.fail('');
    const restartStart = f.calls.length;
    const restarted = new MobileGithub(f.adapter, '.obsidian', 'simple-link', () => f.options, () => {});
    const next = await restarted.preview();
    assert.equal(restarted.state.baseCommitSha, target, 'recovery confirms the original target, not its descendant');
    assert.notEqual(target, descendant);
    assert.equal(restarted.state.pending, undefined);
    assert.equal(f.local.get('a.md').bytes.toString(), 'a-v1');
    assert.equal(f.local.get('b.md').bytes.toString(), 'b-v1');
    assert.equal(f.calls.filter(call => call.path === '/git/blobs/' + shaA).length, beforeA, 'already completed blob is not downloaded again');
    assert(f.calls.slice(restartStart).some(call => call.path === '/git/blobs/' + shaB), 'incomplete file resumes with its fixed transaction SHA');
    assert(!f.calls.slice(restartStart).some(call => call.path === '/git/blobs/' + newerShaB));
    assert.deepEqual(next.downloads.sort(), ['a.md', 'b.md'], 'descendant edits remain a fresh, separate sync plan');
    await restarted.execute(next);
    assert.equal(restarted.state.baseCommitSha, descendant);
    assert.equal(f.local.get('b.md').bytes.toString(), 'b-v2');
  }
  // A rewritten remote history cannot be treated as a descendant of the pending target.
  for (const history of ['behind', 'diverged']) {
    const f = await fixture({ 'note.md': 'base' }, { 'note.md': 'base' });
    await align(f);
    const baseline = f.engine.state.baseCommitSha;
    f.cloudEdit('note.md', 'pending cloud'); f.fail('note.md');
    await assert.rejects(f.engine.execute(await f.engine.preview()), /disk failure/);
    const target = f.engine.state.pending.commit;
    f.fail(''); f.cloudEdit('other.md', 'rewritten remote history');
    const request = globalThis.githubRequest;
    let mutations = 0;
    f.adapter.writeBinary = async () => { mutations++; throw Error('unexpected local write'); };
    f.adapter.remove = async () => { mutations++; throw Error('unexpected local remove'); };
    globalThis.githubRequest = async value => value.url.includes(`/compare/${target}...`)
      ? { status: 200, headers: {}, json: { status: history, files: [] } } : request(value);
    try { await assert.rejects(f.engine.preview(), /远端历史不一致/); }
    finally { globalThis.githubRequest = request; }
    assert.equal(mutations, 0);
    assert.equal(f.local.get('note.md').bytes.toString(), 'base');
    assert.equal(f.engine.state.baseCommitSha, baseline);
    assert.equal(f.engine.state.pending.commit, target);
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
    await assert.rejects(f.engine.execute(await f.engine.preview()), /同步写入结果验证未通过/);
    assert.equal(f.engine.state.baseCommitSha, base);
    assert.equal(f.engine.state.downloadVerification.phase, 'downloading', 'a no-op adapter is rejected before final verification');
    assert.equal((await readStoredState(f.adapter, f.engine.statePath)).pending.commit, f.head());
    assert(!f.local.has('lost.md'));
    f.adapter.writeBinary = originalWrite;
    const recovered = await f.engine.preview();
    assert.equal(recovered.remoteDeletes.length, 0);
    assert.equal(f.local.get('lost.md').bytes.toString(), 'must be downloaded');
    assert.equal(f.engine.state.pending, undefined);
  }
  // A failed unreceipted write cannot identify later bytes safely, even after an event.
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
    const writes = f.calls.filter(call => ['POST', 'PATCH'].includes(call.method)).length;
    await assert.rejects(f.engine.preview(), /缺少已验证完成记录/);
    const restarted = new MobileGithub(f.adapter, '.obsidian', 'simple-link', () => f.options, () => {});
    await assert.rejects(restarted.preview(), /缺少已验证完成记录/);
    assert.equal(restarted.state.baseCommitSha, base);
    assert(restarted.state.pending);
    assert.equal(restarted.needsLocalRecheck, false);
    assert.equal(f.local.get('note.md').bytes.toString(), 'new local edit');
    const durable = await readStoredState(f.adapter, restarted.statePath);
    assert.equal(durable.baseCommitSha, base);
    assert(durable.pending);
    assert.equal(f.calls.filter(call => ['POST', 'PATCH'].includes(call.method)).length, writes);
    await f.adapter.write('note.md', 'base');
    const recovered = await restarted.preview();
    assert.equal(f.local.get('note.md').bytes.toString(), 'cloud edit');
    assert.equal(restarted.state.pending, undefined);
    assert.equal(restarted.needsLocalRecheck, false);
    assert.equal(recovered.uploads.length + recovered.remoteDeletes.length, 0);
  }
  // Empty vault: import, preserve excluded cloud config, persist baseline/tree and final cache.
  // A startup/bulk event storm must retain the latest state without thousands
  // of full JSON snapshots or concurrent writes.
  let releaseWrite, writeCount = 0, lastSaved;
  const writeGate = new Promise(resolve => { releaseWrite = resolve; });
  const batchEngine = new MobileGithub({ exists: async () => false, write: async (_path, text) => {
    writeCount++;
    if (writeCount === 1) await writeGate;
    lastSaved = JSON.parse(text).state;
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
  batchEngine.adapter.write = async (_path, text) => { lastSaved = JSON.parse(text).state; };
  batchEngine.state.revision = 4001;
  await batchEngine.save();
  assert.equal(lastSaved.revision, 4001, "failed writes can be retried");

  let f = await fixture({}, { "note.md": "cloud", "copy.md": "cloud", ".obsidian/workspace.json": "private" });
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
  assert.equal(f.calls.filter(c => c.path.startsWith("/zipball/")).length, 0, "first sync does not request an archive");
  assert.equal(f.calls.filter(c => c.path.startsWith("/git/blobs/")).length, 1, "duplicate content is downloaded once");
  assert(!f.local.has('.obsidian/workspace.json'), 'fixed local workspace settings never reach the vault');
  assert.equal(f.calls.filter(c => c.path === "/git/commits").length, 0, "import creates no unnecessary commit");
  const saved = (await readStoredState(f.adapter, f.engine.statePath));
  assert(!("baseTreeSha" in saved));
  assert.equal(saved.cache["copy.md"].sha, saved.base["copy.md"].sha);
  await f.adapter.write(f.engine.statePath, JSON.stringify({ state: { ...saved, baseTreeSha: "legacy-tree" } }));
  const migrated = new MobileGithub(f.adapter, ".obsidian", "simple-link", () => f.options, () => {});
  await migrated.load();
  const cleaned = (await readStoredState(f.adapter, f.engine.statePath));
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
    await f.adapter.write(f.engine.statePath, '{torn');
    const recovered = new MobileGithub(f.adapter, '.obsidian', 'simple-link', () => f.options, () => {});
    await recovered.load();
    assert.equal(recovered.state.baseCommitSha, base);
    assert.equal((await readStoredState(f.adapter, f.engine.statePath)).baseCommitSha, base);
    await f.adapter.write(f.engine.statePath, '{torn');
    await f.adapter.write(f.engine.recoveryPath, '{torn');
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
  const failedSaved = (await readStoredState(f.adapter, f.engine.statePath));
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
    { "shared.md": "cloud", "remote.md": "remote-only", ".obsidian/workspace.json": "private" });
  plan = await f.engine.preview();
  assert.equal(plan.conflicts.length, 4);
  await assert.rejects(f.engine.execute(plan), /冲突/);
  assert.equal(f.engine.state.baseCommitSha, null);
  plan = await reviewedPreview(f, { "new:shared.md": { choice: "local" } });
  await f.engine.execute(plan);
  assert.equal(f.remote()["shared.md"].sha, hash(Buffer.from("local")));
  assert.equal(f.local.get("remote.md").bytes.toString(), "remote-only");
  assert(f.remote()[".obsidian/workspace.json"]);
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
  f.local.delete(f.engine.statePath); f.local.delete(f.engine.recoveryPath);
  await f.adapter.write(".obsidian/plugins/simple-link/link-state.json", JSON.stringify(oldState));
  const oldEngine = new MobileGithub(f.adapter, ".obsidian", "simple-link", () => f.options, () => {});
  await oldEngine.load();
  assert.deepEqual(oldEngine.state.paths, { moves: { "other.md": "moved.md" } });
  assert.deepEqual(oldEngine.state.base, oldState.base);
  assert.equal(oldEngine.state.baseCommitSha, oldState.baseCommitSha);

  // Strip the previous copy-source format without changing baseline or moves.
  oldState.paths = { moves: { "other.md": "moved.md" }, copies: { "new.md": "old.md" } };
  f.local.delete(f.engine.statePath); f.local.delete(f.engine.recoveryPath);
  await f.adapter.write(".obsidian/plugins/simple-link/link-state.json", JSON.stringify(oldState));
  const moveOnlyEngine = new MobileGithub(f.adapter, ".obsidian", "simple-link", () => f.options, () => {});
  await moveOnlyEngine.load();
  assert.deepEqual(moveOnlyEngine.state.paths, { moves: { "other.md": "moved.md" } });
  const moveOnlySaved = (await readStoredState(f.adapter, f.engine.statePath));
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
        export const requireApiVersion = () => false;
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
    const container = { empty() {}, addClass() {}, toggleClass() {}, createDiv() { return this; } };
    for (const method of ["addEnableSetting", "addDefaultRepoSetting", "addShareRepoSetting", "displayBeginner", "displayDesktop", "displayBeginnerMobile", "displayDevicePreview", "displayMobilePreview", "displaySetup", "displayDesktopSettings"]) tab[method] = () => {};
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
    constructor(tag = 'div', options = {}) { this.tag = tag; this.text = options.text; this.cls = options.cls ?? ''; this.children = []; this.style = {}; this.dataset = {}; }
    get classList() { return {
      add: (...names) => { this.cls = [...new Set([...this.cls.split(' '), ...names])].filter(Boolean).join(' '); },
      remove: (...names) => { this.cls = this.cls.split(' ').filter(name => !names.includes(name)).join(' '); },
      contains: name => this.cls.split(' ').includes(name)
    }; }
    createEl(tag, options = {}) { const child = new ReviewElement(tag, options); this.children.push(child); return child; }
    createDiv(options = {}) { return this.createEl('div', options); }
    createSpan(options = {}) { return this.createEl('span', options); }
    setAttr() {}
    setAttribute() {}
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
    querySelector(selector) {
      const match = /^(:scope > )?\.([\w-]+)$/.exec(selector);
      if (match) return (match[1] ? this.children : this.querySelectorAll('*')).find(node => node.cls.split(' ').includes(match[2])) ?? null;
      return this.querySelectorAll(selector)[0] ?? null;
    }
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
      assert.equal(page.querySelectorAll("*").find(node => node.name)?.name, step === 2 ? "核验 GitHub Token" : "选择 GitHub 仓库");
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
    // The final guide step prepares setup, retries failures, then opens sync separately.
    for (const alreadyConnected of [false, true]) {
      const tab = Object.create(SyncSettingsTab.prototype), host = new GuideElement();
      const options = { repoUrl: 'fixture-repo', branch: 'main', plugins: [], ignorePatterns: [] };
      let prepared = 0, opened = 0, fail = !alreadyConnected;
      Object.assign(tab, { settingsHost: host, desktopPage: 'beginner-mobile', lightweightGuideStep: 4,
        lightweightGuideDraft: options, lightweightGuideVerified: { branch: 'main' }, renderSettings: () => {},
        app: { vault: { configDir: '.obsidian', adapter: { write: async () => { throw Error('opening guide must not write files'); } } } } });
      tab.plugin = { manifest: { id: 'simple-one' }, settings: { mobile: { ...options, bound: alreadyConnected },
        lightweightGuideProgress: { complete: alreadyConnected } },
        completeLightweightGuide: async () => {
          prepared++;
          if (fail) throw Error('fixture preparation failure');
          tab.plugin.settings.mobile.bound = true;
          tab.plugin.settings.lightweightGuideProgress.complete = true;
        }, openSyncView: async () => { opened++; } };
      const page = host.createDiv();
      tab.displayLightweightGuideStep(page);
      const nodes = page.querySelectorAll('*');
      assert(nodes.some(node => node.name === '完成接入'));
      assert(!nodes.some(node => node.tag === 'textarea' || /缓存|路径追踪|gitignore.*正文/.test(node.text ?? '')),
        'final setup only shows connection preparation, without advanced options or rule contents');
      const button = nodes.find(node => node.tag === 'button' && node.text === (alreadyConnected ? '打开同步' : '准备接入'));
      assert(button);
      assert.equal(prepared, 0, 'reopening a completed guide performs no preparation');
      if (!alreadyConnected) {
        button.events.click(); await new Promise(resolve => setImmediate(resolve));
        assert.equal(button.text, '重试接入'); assert.equal(opened, 0);
        fail = false;
        button.events.click(); await new Promise(resolve => setImmediate(resolve));
        assert.equal(button.text, '打开同步'); assert.equal(opened, 0, 'setup completion never opens or starts sync');
      }
      button.events.click(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(opened, 1);
    }
    // Ignore baseline, rule/tracking acknowledgement and file choices are separate gates.
    {
      const tab = Object.create(SyncSettingsTab.prototype), host = new GuideElement();
      let preview = { localFiles: ["note.md"], remoteFiles: ["note.md"], localOnly: [], remoteOnly: [], overlaps: ["note.md"],
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
      assert(!nodes.some(node => node.name?.includes("忽略规则基准")));
      assert.equal(tracking, undefined, "tracking repair requires an explicit choice");
      assert.equal(tab.setupRebuildConfirmed, false);
      for (const label of ["仅本机", "仅 GitHub", "文件变化"]) {
        const card = nodes.find(node => node.tag === "button" && node.children.some(child => child.text === label));
        assert(card, `${label} is an interactive filter`);
        card.events.click();
      }
      assert(nodes.some(node => node.text === "下一步：完成接入"));
      await tab.advanceSetupAfterPreview();
      assert.equal(confirmed, 0, "unresolved file versions block completion");
      choices["note.md"] = "remote";
      await tab.advanceSetupAfterPreview();
      assert.equal(confirmed, 0, "file choices alone cannot approve removing excluded paths from tracking");
      const consent = nodes.find(node => node.tag === 'input' && node.events?.change);
      assert(consent, "tracking migration exposes a confirmation checkbox");
      consent.checked = true;
      consent.events.change();
      assert.equal(tracking, 'rebuild');
      assert.equal(tab.setupRebuildConfirmed, true);
      await tab.advanceSetupAfterPreview();
      assert.equal(confirmed, 1);
      assert.equal(tab.setupViewStep, 4);
      preview = { ...preview, trackedExcludedLocal: [], trackedExcludedRemote: [] };
      render();
      assert.equal(tracking, undefined, "new inspection recomputes default cleanup");
      assert.equal(tab.setupRebuildConfirmed, false);
    }
    console.log("Desktop inspection: explicit tracking repair consent, interactive filters and final version confirmation passed");
  } finally {
    GuideEngine.prototype.verifyToken = verifyToken; GuideEngine.prototype.verifyAccess = verifyAccess;
    delete globalThis.guideSetting;
  }
  console.log("Embedded lightweight guide: token/repository transitions, retries and closed-page results passed");

  // Shared whole-file review preserves the exact keep/delete direction.
  for (const side of ['local', 'remote']) {
    const f = await fixture(side === 'local' ? { 'single.md': 'text' } : {}, side === 'remote' ? { 'single.md': 'text' } : {});
    const conflict = (await f.engine.preview()).conflicts[0];
    const file = mobileConflictFile(conflict);
    assert.equal(file.description, side === 'local' ? '文件仅存在于本机' : '文件仅存在于云端');
    assert.equal(side === 'local' ? file.remoteMissingLabel : file.localMissingLabel, side === 'local' ? '云端无此文件' : '本地无此文件');
    const kept = await f.engine.preview({ [conflict.id]: { choice: side } });
    assert.equal((side === 'local' ? kept.uploads : kept.downloads).length, 1);
    const deleted = await f.engine.preview({ [conflict.id]: { choice: side === 'local' ? 'remote' : 'local' } });
    assert.equal((side === 'local' ? deleted.localDeletes : deleted.remoteDeletes).length, 1);
  }
  {
    const files = [{ path: 'cloud-only', localMissingLabel: '本地已删除' }, { path: 'edited' }];
    const review = new ZoeySyncConflictPreviewModal({}, { files, read: async () => ({ local: '', remote: '' }) });
    review.render = () => {}; review.close = () => {};
    let result;
    review.resolve = choices => { result = choices; };
    review.selectFile(files[0], 'local'); review.applyReadyFiles();
    assert.equal(result, undefined, 'all files need an explicit decision');
    review.selectFile(files[1], 'remote'); review.applyReadyFiles();
    assert.deepEqual(result, { 'cloud-only': { choice: 'local' }, edited: { choice: 'remote' } });
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
        await assert.rejects(review.wait(), scenario === 'staleRemote' ? /云端出现新提交/ : error => error.name === 'LocalSyncEdit');
        assert.deepEqual(stages, scenario === 'staleRemote' ? ['differences', 'execute'] : ['differences']);
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
  async function guide(outcome) {
    const plugin = Object.create(LinkPlugin.prototype), steps = [];
    const engine = { state: { baseCommitSha: null }, load: async () => {},
      verifyToken: async () => { steps.push('token'); return 'fixture-user'; },
      verifyAccess: async () => { steps.push("verify"); return { branch: "main", login: 'fixture-user' }; },
      prepareLocalRules: async () => { steps.push('rules'); if (outcome === 'rules-failure') throw Error('fixture rules failure'); },
      bind: async verified => { assert.equal(verified.branch, "main"); steps.push("bind"); return verified; },
      preview: async () => { throw Error('setup must not preview or scan files'); },
      execute: async () => { throw Error('setup must not execute a sync'); } };
    const nativeComplete = outcome !== 'success';
    plugin.settings = { errorLogs: [], mobile: { bound: false }, enabled: false, desktopGitEnabled: true, setupComplete: nativeComplete, lastSyncAt: 123 };
    plugin.host = { app: {} }; plugin.desktopGitQueue = Promise.resolve();
    plugin.syncing = false;
    plugin.getMobileGithub = () => engine;
    plugin.deactivateFeature = () => { plugin.featureActive = false; };
    plugin.activateFeature = () => { plugin.featureActive = true; };
    let saveFailure = outcome === 'save-failure';
    plugin.saveSettings = async () => { steps.push("save"); if (saveFailure) { saveFailure = false; throw Error('fixture save failure'); } };
    plugin.mobileHost = () => ({ save: async () => {} });
    plugin.refreshSyncView = async () => {
      assert.equal(plugin.syncing, false);
      assert.equal(plugin.getSyncActivity(), undefined);
    };
    plugin.setStatus = text => { plugin.lastStatus = text; };
    plugin.recordSuccess = async context => { assert.equal(context, '轻量接入', 'setup must not record a completed sync'); };
    plugin.runSync = async () => { throw Error('setup must not run a sync'); };
    const oldWait = MobileSyncModal.prototype.wait;
    MobileSyncModal.prototype.wait = async () => { throw Error('setup must not open sync review'); };
    const options = { repoUrl: "fixture", plugins: [], ignorePatterns: [] };
    try {
      if (outcome === 'success') {
        await plugin.completeLightweightGuide(options);
      } else {
        await assert.rejects(plugin.completeLightweightGuide(options), outcome === 'rules-failure' ? /fixture rules failure/ : /fixture save failure/);
        assert(!plugin.settings.lightweightGuideProgress?.complete, 'failed preparation/save must not claim setup completion');
        if (outcome === 'rules-failure') {
          assert.equal(plugin.settings.mobile.bound, false, 'rules failure must not bind the account');
          outcome = 'success';
        }
        await plugin.completeLightweightGuide(options);
      }
      assert.equal(plugin.settings.lastSyncAt, 123, 'setup preserves the last real sync time');
      assert.equal(engine.state.baseCommitSha, null, 'setup requires no first-sync baseline');
      assert.equal(plugin.settings.lightweightGuideProgress.complete, true);
      assert.equal(plugin.settings.mobile.bound, true);
      assert.equal(plugin.settings.enabled, true);
      assert.equal(plugin.settings.desktopGitEnabled, false);
      assert.equal(plugin.settings.setupComplete, nativeComplete, 'native setup completion stays independent');
      const completed = structuredClone(plugin.settings.lightweightGuideProgress);
      let syncErrors = 0;
      plugin.useLightweightSync = () => true;
      plugin.recordError = async () => { syncErrors++; };
      await plugin.syncNow(true);
      assert.equal(syncErrors, 1, 'the later manual sync fails through its own error path');
      assert.deepEqual(plugin.settings.lightweightGuideProgress, completed, 'later sync failures cannot undo completed setup');
      assert.equal(plugin.settings.mobile.bound, true);
    } finally { MobileSyncModal.prototype.wait = oldWait; }
    assert.equal(plugin.syncing, false);
    assert.equal(plugin.switchingSyncMode, false);
  }
  {
    const plugin = Object.create(LinkPlugin.prototype);
    plugin.settings = { errorLogs: [], mobile: { bound: true, token: 'keep-token', repoUrl: 'keep-repo' } };
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
  await guide('success');
  await guide('rules-failure');
  await guide('save-failure');
  {
    const cloud = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`cloud/${i}.md`, `cloud ${i}`]));
    const f = await fixture({}, cloud);
    await f.engine.execute(await reviewedPreview(f));
    assert.equal(f.calls.filter(c => c.path.startsWith('/zipball/')).length, 0);
    assert.equal(f.calls.filter(c => c.path.startsWith('/git/blobs/')).length, 120);
    assert.equal(f.engine.downloadTask, undefined);
    for (const path of Object.keys(cloud)) assert(f.local.has(path));
  }
  {
    const cloud = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`cloud/${i}.md`, `cloud ${i}`]));
    const f = await fixture({}, cloud);
    const review = new MobileSyncModal({}, f.engine, await f.engine.preview(), undefined, {
      strategy: async () => 'remote', confirm: async () => true, transfer: async () => {}
    });
    assert.equal(await mobileFlowWait.call(review), true);
    assert.equal(f.calls.filter(c => c.path.startsWith('/zipball/')).length, 0);
    assert.equal(f.calls.filter(c => c.path.startsWith('/git/blobs/')).length, 120);
    for (const path of Object.keys(cloud)) assert(f.local.has(path));
  }
  console.log('First sync uses per-file API downloads without an archive');
  // An established baseline executes directly, with review only for real conflicts.
  for (const scenario of ['ordinary', 'conflict', 'cancel-conflict', 'retry-execute']) {
    const f = await fixture({ 'note.md': 'base' }, { 'note.md': 'base' });
    await align(f);
    const baseline = f.engine.state.baseCommitSha;
    await f.adapter.write('note.md', 'local edit'); f.engine.event('modify', 'note.md');
    if (scenario.includes('conflict')) f.cloudEdit('note.md', 'remote edit');
    const stages = [], execute = f.engine.execute.bind(f.engine);
    let fail = scenario === 'retry-execute';
    f.engine.execute = async plan => { stages.push('execute'); if (fail) throw Error('fixture execute failure'); return execute(plan); };
    const modal = async () => new MobileSyncModal({}, f.engine, await f.engine.preview(), async live => {
      stages.push('review');
      return scenario === 'cancel-conflict' ? null : Object.fromEntries(live.files.map(file => [file.path, { choice: 'remote' }]));
    }, {
      strategy: async () => assert.fail('an established baseline must not ask for initial strategy'),
      confirm: async () => assert.fail('ordinary edits and explicit conflict choices need no extra confirmation'),
      transfer: async () => assert.fail('daily API sync must not reopen transfer setup')
    });
    if (fail) {
      const successes = f.timings.filter(timing => timing.context === '轻量执行耗时' && timing.status === 'success').length;
      await assert.rejects(mobileFlowWait.call(await modal()), /fixture execute failure/);
      assert.equal(f.engine.state.baseCommitSha, baseline);
      assert.equal(f.timings.filter(timing => timing.context === '轻量执行耗时' && timing.status === 'success').length, successes);
      fail = false;
      assert.equal(await mobileFlowWait.call(await modal()), true);
      assert.deepEqual(stages, ['execute', 'execute']);
    } else {
      assert.equal(await mobileFlowWait.call(await modal()), scenario !== 'cancel-conflict');
      assert.deepEqual(stages, scenario === 'ordinary' ? ['execute'] : scenario === 'conflict' ? ['review', 'execute'] : ['review']);
      if (scenario === 'cancel-conflict') assert.equal(f.engine.state.baseCommitSha, baseline);
    }
  }
  // The manual sync caller records success only after execution and can retry a failure.
  {
    const f = await fixture({ 'note.md': 'base' }, { 'note.md': 'base' });
    await align(f);
    await f.adapter.write('note.md', 'edited'); f.engine.event('modify', 'note.md');
    const plugin = Object.create(LinkPlugin.prototype), outcomes = [];
    Object.assign(plugin, { host: { app: {} }, syncing: false, switchingSyncMode: false,
      settings: { errorLogs: [], enabled: true, mobile: { mode: 'github', bound: true }, lastSyncAt: 123 },
      useLightweightSync: () => true, getMobileGithub: () => f.engine,
      lightweightFlow: () => ({ strategy: async () => assert.fail('retry is not initial setup'),
        confirm: async () => assert.fail('ordinary retry needs no confirmation'), transfer: async () => {} }),
      setStatus: () => {}, saveSettings: async () => {}, refreshSyncView: async () => {},
      recordError: async () => outcomes.push('error'), recordSuccess: async () => outcomes.push('success') });
    const execute = f.engine.execute.bind(f.engine);
    f.engine.execute = async () => { throw Error('fixture execute failure'); };
    await plugin.syncNow(true);
    assert.deepEqual(outcomes, ['error']);
    assert.equal(plugin.settings.lastSyncAt, 123);
    f.engine.execute = execute;
    await plugin.syncNow(true);
    assert.deepEqual(outcomes, ['error', 'success']);
    assert.equal(f.remote()['note.md'].sha, hash(Buffer.from('edited')));
  }
  // A reliable baseline propagates unchanged deletions in either direction, manually or automatically.
  for (const deletedAt of ['local', 'remote']) for (const automatic of [false, true]) {
    const f = await fixture({ 'keep.md': 'keep', 'remove.md': 'base' }, { 'keep.md': 'keep', 'remove.md': 'base' });
    await align(f);
    if (deletedAt === 'local') { await f.adapter.remove('remove.md'); f.engine.event('delete', 'remove.md'); }
    else f.cloudDelete('remove.md');
    const stages = [], execute = f.engine.execute.bind(f.engine);
    f.engine.execute = async plan => { stages.push('execute'); assert.equal(plan.conflicts.length, 0);
      assert((deletedAt === 'local' ? plan.remoteDeletes : plan.localDeletes).includes('remove.md')); return execute(plan); };
    if (automatic) {
      const plugin = Object.create(LinkPlugin.prototype), outcomes = [];
      Object.assign(plugin, { host: { app: {} }, syncing: false, switchingSyncMode: false,
        settings: { errorLogs: [], enabled: true, mobile: { mode: 'github', bound: true } },
        useLightweightSync: () => true, getMobileGithub: () => f.engine,
        setStatus: text => stages.push(text), saveSettings: async () => {}, refreshSyncView: async () => {},
        recordError: async () => outcomes.push('error'), recordSuccess: async () => outcomes.push('success') });
      await plugin.syncNow(false);
      assert.deepEqual(outcomes, ['success'], 'automatic known deletions must not be deferred');
      assert.equal(stages.filter(stage => stage === 'execute').length, 1);
    } else {
      const review = new MobileSyncModal({}, f.engine, await f.engine.preview(), async () => assert.fail('unchanged deletion needs no conflict review'), {
        strategy: async () => assert.fail('daily deletion must not ask for initial strategy'),
        confirm: async () => assert.fail('baseline-proven deletion needs no extra confirmation'),
        ready: async plan => { stages.push('ready'); assert((deletedAt === 'local' ? plan.remoteDeletes : plan.localDeletes).includes('remove.md')); },
        transfer: async () => assert.fail('daily deletion needs no transfer setup')
      });
      assert.equal(await mobileFlowWait.call(review), true);
      assert.deepEqual(stages, ['ready', 'execute']);
    }
    assert.equal(f.local.has('remove.md'), false);
    assert.equal(!!f.remote()['remove.md'], false);
  }
  // Delete/modify remains a review decision; choosing delete does not open a second confirmation.
  for (const deletedAt of ['local', 'remote']) for (const scenario of ['delete', 'cancel', 'stale-scope', 'stale-ref']) {
    const f = await fixture({ 'note.md': 'base' }, { 'note.md': 'base' });
    await align(f);
    const baseline = f.engine.state.baseCommitSha;
    if (deletedAt === 'local') { await f.adapter.remove('note.md'); f.engine.event('delete', 'note.md'); f.cloudEdit('note.md', 'remote edit'); }
    else { f.cloudDelete('note.md'); await f.adapter.write('note.md', 'local edit'); f.engine.event('modify', 'note.md'); }
    const stages = [], execute = f.engine.execute.bind(f.engine), plan = await f.engine.preview();
    assert.equal(plan.conflicts.length, 1);
    f.engine.execute = async next => { stages.push('execute'); return execute(next); };
    if (scenario === 'cancel') {
      const plugin = Object.create(LinkPlugin.prototype);
      Object.assign(plugin, { host: { app: {} }, syncing: false, switchingSyncMode: false,
        settings: { errorLogs: [], enabled: true, mobile: { mode: 'github', bound: true } },
        useLightweightSync: () => true, getMobileGithub: () => f.engine,
        setStatus: () => {}, saveSettings: async () => {}, refreshSyncView: async () => {},
        recordError: async () => assert.fail('delete/modify should be deferred, not treated as an error'),
        recordSuccess: async () => assert.fail('automatic sync cannot resolve delete/modify') });
      await plugin.syncNow(false);
      assert.deepEqual(stages, [], 'automatic delete/modify waits for manual review');
    }
    const review = new MobileSyncModal({}, f.engine, plan, async live => {
      stages.push('review');
      return scenario === 'cancel' ? null : Object.fromEntries(live.files.map(file => [file.path, { choice: 'delete' }]));
    }, { strategy: async () => assert.fail('delete/modify has a baseline'),
      confirm: async () => assert.fail('the explicit delete choice is the confirmation'),
      ready: async () => {
        stages.push('ready');
        if (scenario === 'stale-scope') await f.adapter.write('.gitignore', await f.adapter.read('.gitignore') + '\nexcluded/\n');
        if (scenario === 'stale-ref') f.cloudEdit('other.md', 'new remote commit');
      }, transfer: async () => assert.fail('delete review has no download setup') });
    if (scenario.startsWith('stale-')) {
      await assert.rejects(mobileFlowWait.call(review), /变化|过期|新提交/);
      assert.equal(f.engine.state.baseCommitSha, baseline);
      assert(!f.calls.some(call => ['POST', 'PATCH'].includes(call.method)));
    } else {
      assert.equal(await mobileFlowWait.call(review), scenario === 'delete');
      assert.deepEqual(stages, scenario === 'delete' ? ['review', 'ready', 'execute'] : ['review']);
      if (scenario === 'cancel') {
        assert.equal(f.engine.state.baseCommitSha, baseline);
        assert.equal(f.local.has('note.md'), deletedAt === 'remote');
        assert.equal(!!f.remote()['note.md'], deletedAt === 'local');
      } else { assert(!f.local.has('note.md')); assert(!f.remote()['note.md']); }
    }
  }
  // Without a baseline, automatic sync cannot infer deletion from an absent copy.
  {
    const f = await fixture({}, { 'unpaired.md': 'remote only' });
    const plugin = Object.create(LinkPlugin.prototype);
    Object.assign(plugin, { host: { app: {} }, syncing: false, switchingSyncMode: false,
      settings: { errorLogs: [], enabled: true, mobile: { mode: 'github', bound: true } },
      useLightweightSync: () => true, getMobileGithub: () => f.engine,
      setStatus: () => {}, saveSettings: async () => {}, refreshSyncView: async () => {},
      recordError: async () => assert.fail('first alignment should be deferred'),
      recordSuccess: async () => assert.fail('automatic sync cannot invent the first baseline') });
    f.engine.execute = async () => assert.fail('no baseline requires explicit first alignment');
    await plugin.syncNow(false);
    assert.equal(f.engine.state.baseCommitSha, null);
    assert(!f.local.has('unpaired.md'));
    assert(f.remote()['unpaired.md']);
  }
  // Identical first snapshots establish a baseline without inventing a policy question.
  for (const contents of [{}, { 'same.md': 'identical' }]) {
    const f = await fixture(contents, contents), stages = [], execute = f.engine.execute.bind(f.engine);
    f.engine.execute = async plan => { stages.push('execute'); return execute(plan); };
    const review = new MobileSyncModal({}, f.engine, await f.engine.preview(), async () => assert.fail('identical first snapshots have no differences to review'), {
      strategy: async () => assert.fail('identical first snapshots need no strategy'),
      confirm: async () => assert.fail('identical first snapshots need no confirmation'),
      ready: async () => { stages.push('ready'); }, transfer: async () => assert.fail('identical snapshots need no transfer') });
    assert.equal(await mobileFlowWait.call(review), true);
    assert.deepEqual(stages, ['ready', 'execute']);
    assert.equal(f.engine.state.baseCommitSha, f.head());
    assert(!f.calls.some(call => ['POST', 'PATCH'].includes(call.method)));
  }
  for (const strategy of ['merge', 'merge-remote', 'merge-local', 'local', 'remote', 'cancel', 'cancel-confirm']) {
    const f = await fixture({ 'local.md':'local', 'same.md':'local version', 'local-path.md':'identical content' },
      { 'remote.md':'remote', 'same.md':'remote version', 'remote-path.md':'identical content' });
    const stages=[], execute = f.engine.execute.bind(f.engine);
    f.engine.execute = async plan => { stages.push('execute'); return execute(plan); };
    const review = new MobileSyncModal({}, f.engine, await f.engine.preview(),
      async live => {
        stages.push('review');
        assert(!strategy.startsWith('merge-'), 'a preferred side resolves differences without manual review');
        if (strategy === 'merge') assert.deepEqual(live.files.map(file => file.path), ['new:same.md']);
        return Object.fromEntries(live.files.map(file=>[file.path,{choice:'local'}]));
      }, {
        strategy:async()=>{stages.push('strategy');return strategy==='cancel'?null:strategy==='cancel-confirm'?'remote':strategy;},
        confirm:async()=>{assert(['local', 'remote', 'cancel-confirm'].includes(strategy), 'only rebuilding one side needs its deletion summary');stages.push('confirm');return strategy!=='cancel-confirm';},
        transfer:async()=>{stages.push('transfer');}
      });
    const result=await mobileFlowWait.call(review);
    if(strategy==='cancel'||strategy==='cancel-confirm') {
      assert.equal(result,false);assert(!f.calls.some(call=>['POST','PATCH'].includes(call.method)));
      assert.equal(f.engine.state.baseCommitSha,null);
      assert.deepEqual(stages, strategy === 'cancel' ? ['strategy'] : ['strategy', 'confirm']);
    } else {
      assert.equal(result,true);assert.deepEqual(stages, strategy === 'merge' ? ['strategy','review','execute'] : ['local', 'remote'].includes(strategy) ? ['strategy','confirm','execute'] : ['strategy','execute']);
      if(strategy==='remote') {assert(!f.local.has('local.md'));assert.equal(f.local.get('same.md').bytes.toString(),'remote version');}
      if(strategy==='local') {assert(!f.remote()['remote.md']);assert.equal(f.local.has('remote.md'),false);}
      if(['merge', 'merge-remote', 'merge-local'].includes(strategy)) {
        for (const path of ['local.md', 'remote.md', 'local-path.md', 'remote-path.md']) {
          assert(f.local.has(path), `${strategy} retains both sides' files locally: ${path}`);
          assert(f.remote()[path], `${strategy} retains both sides' files remotely: ${path}`);
        }
        const expected = strategy === 'merge-remote' ? 'remote version' : 'local version';
        assert.equal(f.local.get('same.md').bytes.toString(), expected);
        assert.equal(f.remote()['same.md'].sha, hash(Buffer.from(expected)));
      }
    }
  }
  {
    const f = await fixture({}, Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`note-${i}.md`, String(i)])));
    const stages = [];
    const review = new MobileSyncModal({}, f.engine, await f.engine.preview(), undefined, {
      strategy: async () => { stages.push('strategy'); return 'merge'; },
      confirm: async () => assert.fail('fully resolved merge policy must execute directly'),
      transfer: async () => { stages.push('transfer'); }
    });
    assert.equal(await mobileFlowWait.call(review), true);
    assert.deepEqual(stages, ['strategy']);
    assert.equal(f.engine.downloadTask, undefined);
    assert.equal(f.calls.filter(c => c.path.startsWith('/git/blobs/')).length, 101);
    assert.equal(f.calls.filter(c => c.path.startsWith('/zipball/')).length, 0);
  }
  console.log('Sync workflow and large API downloads passed');
  {
    const f = await fixture({}, { 'note.md': 'cloud note' });
    await f.engine.execute(await reviewedPreview(f));
    const completed = f.engine.state.baseCommitSha;
    f.engine.state.pending = {
      commit: completed, parent: completed, base: f.engine.state.base,
      actions: [], revision: f.engine.state.revision, paths: f.engine.state.paths,
      scope: f.engine.state.baseScope,
      transfer: { mode: 'manual', downloads: 1, total: 1, createdAt: Date.now() }
    };
    f.engine.state.baseCommitSha = null;
    await f.engine.save();
    const restored = new MobileGithub(f.adapter, '.obsidian', 'simple-link', () => f.options, () => {},
      async (context, status, message) => { f.timings.push({ context, status, message }); }, () => true);
    await restored.load();
    await restored.resumeAutomaticDownload();
    assert.equal(f.timings.at(-1).context, '轻量恢复耗时');
    assert.equal(f.timings.at(-1).status, 'success');
    for (const label of ['保存恢复记录', '核对远端', '复核本地', '下载与落盘', '结果验证', '保存基准']) assert(f.timings.at(-1).message.includes(label));
    assert.equal(restored.downloadTask, undefined);
    assert.equal(restored.state.baseCommitSha, completed);
    assert.equal(f.calls.filter(c => c.path.startsWith('/zipball/')).length, 0);
  }
  {
    const f=await fixture({'base.md':'base'},{'base.md':'base'});await align(f);
    for(let i=0;i<1001;i++)f.cloudEdit(`daily-${i}.md`,String(i));
    let transfers=0;
    const review=new MobileSyncModal({},f.engine,await f.engine.preview(),undefined,{
      strategy:async()=>{throw Error('daily sync should not require initial strategy');},confirm:async()=>{throw Error('ordinary daily downloads should not require another confirmation');},
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
