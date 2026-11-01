const readStoredState = async (adapter, path) => { const raw = JSON.parse(await adapter.read(path)); return raw.state ?? raw; };
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { createHash, webcrypto } from "node:crypto";
import esbuild from "esbuild";
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const output = resolve("../../../.codex/output");
await mkdir(output, { recursive: true });
const folder = await mkdtemp(join(output, "local-edit-recheck-"));
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

  const stored = async engine => (JSON.parse(await engine.adapter.read(engine.statePath))).state;
  const align = async f => { await f.engine.execute(await f.engine.preview()); return f.engine.state.baseCommitSha; };
  const restart = f => new MobileGithub(f.adapter, '.obsidian', 'simple-link', () => f.options, () => {}, undefined, () => true);
  async function editsBeforeWrite() {
    const f = await fixture({ 'a.md': 'a-base', 'b.md': 'b-base' }, { 'a.md': 'a-base', 'b.md': 'b-base' });
    const baseline = await align(f);
    f.cloudEdit('a.md', 'a-cloud'); f.cloudEdit('b.md', 'b-cloud');
    const target = f.head(), targetA = f.remote()['a.md'].sha, targetB = f.remote()['b.md'].sha;
    const plan = await f.engine.preview(), request = globalThis.githubRequest;
    let changed = false;
    globalThis.githubRequest = async value => {
      const result = await request(value);
      if (!changed && value.url.endsWith('/git/blobs/' + targetA)) {
        changed = true; await f.adapter.write('a.md', 'a-user'); f.engine.event('modify', 'a.md');
      }
      return result;
    };
    try { await f.engine.execute(plan); } finally { globalThis.githubRequest = request; }
    assert.equal(f.local.get('a.md').bytes.toString(), 'a-user');
    assert.equal(f.local.get('b.md').bytes.toString(), 'b-cloud', 'independent safe downloads continue');
    assert.equal(f.engine.state.baseCommitSha, baseline, 'partial application cannot advance the global baseline');
    assert.equal(f.engine.needsLocalRecheck, true);
    assert.equal(f.engine.state.pending, undefined);
    assert.equal(f.engine.state.downloadVerification, undefined);
    assert.equal(f.engine.state.localRecheck.commit, target);
    assert.equal(f.engine.state.localRecheck.base['a.md'].sha, hash(Buffer.from('a-base')));
    assert.equal(f.engine.state.localRecheck.base['b.md'].sha, targetB);
    assert.equal(f.engine.state.localRecheck.receipts['a.md'].applied, false);
    assert.equal((await stored(f.engine)).localRecheck.receipts['b.md'].applied, true);
    const restarted = restart(f);
    f.cloudEdit('b.md', 'b-descendant');
    const next = await restarted.preview();
    assert(next.conflicts.some(conflict => conflict.label === 'a.md'), 'an unapplied two-sided edit remains a real conflict after restart');
    assert(!next.uploads.includes('b.md'), 'completed downloads never become reverse uploads');
    assert(next.downloads.includes('b.md'), 'later cloud edits remain a separate descendant change');
    assert.equal(f.local.get('a.md').bytes.toString(), 'a-user');
    assert.equal(f.local.get('b.md').bytes.toString(), 'b-cloud');
  }
  await editsBeforeWrite();
  console.log('Before-write edits: preserve user edit, complete independent files, keep old global baseline and restart effective per-file comparison passed');

  for (const edit of ['modify', 'delete', 'rename']) {
    const f = await fixture({ 'a.md': 'a-base', 'b.md': 'b-base' }, { 'a.md': 'a-base', 'b.md': 'b-base' });
    const baseline = await align(f);
    f.cloudEdit('a.md', 'a-cloud'); f.cloudEdit('b.md', 'b-cloud');
    const targetA = f.remote()['a.md'].sha, binary = f.adapter.writeBinary;
    let changed = false;
    f.adapter.writeBinary = async (path, bytes) => {
      await binary(path, bytes);
      if (!changed && path === 'a.md') {
        changed = true;
        if (edit === 'modify') { await f.adapter.write(path, 'a-after-target'); f.engine.event('modify', path); }
        else if (edit === 'delete') { await f.adapter.remove(path); f.engine.event('delete', path); }
        else f.move(path, 'renamed.md');
      }
    };
    await f.engine.execute(await f.engine.preview());
    assert.equal(f.local.get('b.md').bytes.toString(), 'b-cloud');
    assert.equal(f.engine.state.baseCommitSha, baseline);
    assert(f.engine.needsLocalRecheck);
    assert.equal(f.engine.state.localRecheck.receipts['a.md'].applied, true, 'an accepted target remains accepted even if the adapter returns after a new user edit');
    assert.equal(f.engine.state.localRecheck.base['a.md'].sha, targetA, 'a post-write edit compares against the accepted target');
    const restarted = restart(f), next = await restarted.preview();
    assert.equal(next.conflicts.length, 0, `post-write ${edit} is not a false two-sided conflict`);
    assert(!next.downloads.includes('a.md'), 'download guards do not recreate a post-write user deletion or rename');
    if (edit === 'modify') assert(next.uploads.includes('a.md'));
    else { assert(!f.local.has('a.md')); assert(next.remoteDeletes.includes('a.md')); }
    if (edit === 'rename') { assert(f.local.has('renamed.md')); assert(next.uploads.includes('renamed.md')); }
  }
  console.log('After-write edits: modify/delete/rename survive restart with the accepted target as per-file baseline passed');

  // A changed deletion target is skipped without blocking an unrelated download.
  {
    const f = await fixture({ 'delete.md': 'base', 'safe.md': 'old' }, { 'delete.md': 'base', 'safe.md': 'old' });
    const baseline = await align(f);
    f.cloudDelete('delete.md'); f.cloudEdit('safe.md', 'safe cloud');
    const plan = await f.engine.preview(), read = f.adapter.readBinary;
    let edited = false;
    f.adapter.readBinary = async path => {
      if (!edited && path === 'delete.md' && f.engine.state.pending) {
        edited = true; await f.adapter.write(path, 'user protects deletion'); f.engine.event('modify', path);
      }
      return read(path);
    };
    await f.engine.execute(plan);
    assert.equal(f.local.get('delete.md').bytes.toString(), 'user protects deletion');
    assert.equal(f.local.get('safe.md').bytes.toString(), 'safe cloud');
    assert.equal(f.engine.state.baseCommitSha, baseline);
    const next = await restart(f).preview();
    assert(next.conflicts.some(conflict => conflict.label === 'delete.md'), 'a skipped delete/modify still requires a real file decision');
  }
  // An in-flight edit that already equals the target is accepted as aligned.
  {
    const f = await fixture({ 'note.md': 'old' }, { 'note.md': 'old' });
    await align(f); f.cloudEdit('note.md', 'cloud target');
    const plan = await f.engine.preview(), request = globalThis.githubRequest;
    globalThis.githubRequest = async value => {
      const response = await request(value);
      if (value.url.includes('/git/blobs/')) { await f.adapter.write('note.md', 'cloud target'); f.engine.event('modify', 'note.md'); }
      return response;
    };
    try { await f.engine.execute(plan); } finally { globalThis.githubRequest = request; }
    assert.equal(f.engine.needsLocalRecheck, false);
    assert.equal(f.engine.state.baseCommitSha, f.head());
    assert.equal(f.local.get('note.md').bytes.toString(), 'cloud target');
  }
  for (const representation of ['download-crlf', 'equivalent-lf-crlf', 'mode-only']) {
    const f = await fixture({ 'note.md': representation === 'equivalent-lf-crlf' ? 'line\n' : 'old' },
      { 'note.md': representation === 'equivalent-lf-crlf' ? 'line\r\n' : 'old' });
    if (representation !== 'equivalent-lf-crlf') { await align(f); f.cloudEdit('note.md', representation === 'mode-only' ? 'old' : 'line\r\n'); }
    if (representation === 'mode-only') f.remote()['note.md'].mode = '100755';
    const plan = await f.engine.preview();
    const resolved = plan.conflicts.length ? await f.engine.recalculate(plan, Object.fromEntries(plan.conflicts.map(conflict => [conflict.id, { choice: 'remote' }]))) : plan;
    await f.engine.execute(resolved);
    assert.equal(f.engine.needsLocalRecheck, false, `${representation} cannot consume the local-edit retry budget`);
    assert.equal(f.engine.state.baseCommitSha, f.head());
    assert.equal((await f.engine.preview()).conflicts.length, 0);
  }
  console.log('Deletion protection, target-equivalent edits, CRLF representations and mode-only changes passed');

  // A fulfilled adapter write with wrong bytes and no user event is corruption, not a local edit.
  {
    const f = await fixture({ 'note.md': 'old' }, { 'note.md': 'old' });
    const baseline = await align(f);
    f.cloudEdit('note.md', 'verified cloud target');
    f.adapter.writeBinary = async path => { await f.adapter.write(path, 'wrong third bytes'); };
    await assert.rejects(f.engine.execute(await f.engine.preview()), /校验失败|验证未通过/);
    assert.equal(f.engine.state.baseCommitSha, baseline); assert(f.engine.state.pending);
    assert.equal(f.engine.needsLocalRecheck, false, 'unproven adapter corruption is not reported as a normal follow-up edit');
    assert.equal(f.local.get('note.md').bytes.toString(), 'wrong third bytes');
    assert.equal((await stored(f.engine)).pending.integrityFailures['note.md'], hash(Buffer.from('wrong third bytes')));
    const restarted = restart(f), calls = f.calls.length;
    await assert.rejects(restarted.preview(), /上次写入结果未通过校验|校验失败|缺少已验证完成记录/);
    assert.equal(restarted.state.baseCommitSha, baseline); assert(restarted.state.pending);
    assert(!f.calls.slice(calls).some(call => ['POST', 'PATCH'].includes(call.method)), 'restarting cannot upload bytes with unresolved integrity failure');
    assert.equal(f.remote()['note.md'].sha, hash(Buffer.from('verified cloud target')));
  }

  // Losing the corruption-marker save cannot turn wrong bytes into an ordinary edit after restart.
  {
    const f = await fixture({ 'note.md': 'target' }, { 'note.md': 'target' });
    const baseline = await align(f), write = f.adapter.write, binary = f.adapter.writeBinary;
    await f.adapter.write('note.md', 'expected local'); f.engine.event('modify', 'note.md');
    const plan = mirrorPlan(await f.engine.preview(), 'remote');
    assert.deepEqual(plan.downloads, ['note.md']);
    assert.equal(plan.remote.files['note.md'].sha, f.engine.state.base['note.md'].sha, 'target intentionally equals the old global baseline');
    let markerFailures = 0;
    f.adapter.write = async (path, text) => {
      if (path.startsWith(f.engine.statePath) && JSON.parse(text).state?.pending?.integrityFailures?.['note.md']) {
        markerFailures++; throw Error('fixture integrity marker persistence failure');
      }
      return write(path, text);
    };
    f.adapter.writeBinary = async path => { await f.adapter.write(path, 'wrong bytes with no user event'); };
    await assert.rejects(f.engine.execute(plan), /fixture integrity marker persistence failure|校验失败/);
    assert(markerFailures > 0, 'the failure is injected specifically into saving the integrity marker');
    const durable = await stored(f.engine);
    assert(durable.pending); assert(!durable.pending.integrityFailures?.['note.md'], 'the disk journal really lacks the failed corruption marker');
    assert.equal(durable.baseCommitSha, baseline);
    f.adapter.write = write;
    let mutations = 0;
    f.adapter.writeBinary = async (...args) => { mutations++; return binary(...args); };
    const restarted = restart(f), calls = f.calls.length;
    await assert.rejects(restarted.preview(), /校验|完整性|写入结果|缺少已验证完成记录/);
    assert.equal(mutations, 0, 'recovery must reject before another local mutation');
    assert.equal(f.local.get('note.md').bytes.toString(), 'wrong bytes with no user event');
    assert.equal(restarted.state.baseCommitSha, baseline); assert(restarted.state.pending);
    assert.equal(restarted.needsLocalRecheck, false, 'a missing corruption marker cannot launder wrong bytes into localRecheck');
    assert(!f.calls.slice(calls).some(call => ['POST', 'PATCH'].includes(call.method)), 'wrong bytes cannot be uploaded even when target equals the old baseline');
    await f.adapter.write('note.md', 'expected local'); restarted.event('modify', 'note.md');
    await restarted.preview();
    assert.equal(f.local.get('note.md').bytes.toString(), 'target');
    assert.equal(restarted.state.pending, undefined); assert.equal(restarted.needsLocalRecheck, false);
  }

  // A failed atomic transfer to localRecheck retains the old baseline and durable receipts.
  {
    const f = await fixture({ 'a.md': 'old', 'b.md': 'old' }, { 'a.md': 'old', 'b.md': 'old' });
    const baseline = await align(f), binary = f.adapter.writeBinary, write = f.adapter.write;
    f.cloudEdit('a.md', 'a-target'); f.cloudEdit('b.md', 'b-target');
    let writes = 0;
    f.adapter.writeBinary = async (path, bytes) => { writes++; await binary(path, bytes);
      if (path === 'a.md') { await f.adapter.write(path, 'user-after-write'); f.engine.event('modify', path); } };
    f.adapter.write = async (path, text) => {
      if (path.startsWith(f.engine.statePath) && JSON.parse(text).state?.localRecheck) throw Error('fixture recheck persistence failure');
      return write(path, text);
    };
    await assert.rejects(f.engine.execute(await f.engine.preview()), /fixture recheck persistence failure/);
    assert.equal(f.engine.state.baseCommitSha, baseline); assert(f.engine.state.pending);
    assert.equal(f.engine.state.localRecheck, undefined);
    assert.equal((await stored(f.engine)).pending.receipts['a.md'].applied, true);
    const completedWrites = writes;
    f.adapter.write = write;
    const restarted = restart(f), next = await restarted.preview();
    assert.equal(writes, completedWrites, 'restarting a failed journal transition does not reapply completed file writes');
    assert.equal(f.local.get('a.md').bytes.toString(), 'user-after-write');
    assert.equal(f.local.get('b.md').bytes.toString(), 'b-target');
    assert.equal(restarted.state.baseCommitSha, baseline);
    assert(restarted.needsLocalRecheck);
    assert.equal(next.conflicts.length, 0); assert(next.uploads.includes('a.md'));
  }
  // Failure to persist an edit receipt stops independent mutations until the next safe recovery.
  {
    const f = await fixture({ 'a.md': 'old', 'b.md': 'old' }, { 'a.md': 'old', 'b.md': 'old' });
    const baseline = await align(f), write = f.adapter.write, binary = f.adapter.writeBinary;
    f.cloudEdit('a.md', 'a-target'); f.cloudEdit('b.md', 'b-target');
    const targetA = f.remote()['a.md'].sha, request = globalThis.githubRequest;
    let writes = 0;
    globalThis.githubRequest = async value => { const response = await request(value);
      if (value.url.endsWith('/git/blobs/' + targetA)) { await f.adapter.write('a.md', 'user-before-write'); f.engine.event('modify', 'a.md'); } return response; };
    f.adapter.writeBinary = async (...args) => { writes++; return binary(...args); };
    f.adapter.write = async (path, text) => {
      if (path.startsWith(f.engine.statePath) && JSON.parse(text).state?.pending?.receipts?.['a.md']) throw Error('fixture receipt persistence failure');
      return write(path, text);
    };
    try { await assert.rejects(f.engine.execute(await f.engine.preview()), /fixture receipt persistence failure/); }
    finally { globalThis.githubRequest = request; }
    assert.equal(f.engine.state.baseCommitSha, baseline); assert(f.engine.state.pending);
    assert.equal(f.local.get('a.md').bytes.toString(), 'user-before-write');
    const stopped = writes; await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(writes, stopped);
    f.adapter.write = write;
    const restarted = restart(f), calls = f.calls.length;
    await assert.rejects(restarted.preview(), /缺少已验证完成记录/);
    assert.equal(f.local.get('a.md').bytes.toString(), 'user-before-write');
    assert.equal(restarted.state.baseCommitSha, baseline);
    assert(restarted.state.pending); assert.equal(restarted.needsLocalRecheck, false);
    assert.equal(writes, stopped, 'an unpersisted receipt is conservatively stopped before any recovery mutation');
    assert(!f.calls.slice(calls).some(call => ['POST', 'PATCH'].includes(call.method)));
    await f.adapter.write('a.md', 'old'); restarted.event('modify', 'a.md');
    await restarted.preview();
    assert.equal(f.local.get('a.md').bytes.toString(), 'a-target');
    assert.equal(f.local.get('b.md').bytes.toString(), 'b-target');
    assert.equal(restarted.state.pending, undefined);
  }
  console.log('Receipt and local-recheck transition persistence failures retain user data, evidence and old global baseline passed');

  // Recreating a successfully deleted path is a new local file, not a deletion to replay.
  {
    const f = await fixture({ 'a.md': 'old', 'b.md': 'old' }, { 'a.md': 'old', 'b.md': 'old' });
    const baseline = await align(f), remove = f.adapter.remove;
    f.cloudDelete('a.md'); f.cloudEdit('b.md', 'b-target');
    f.adapter.remove = async path => { await remove(path); if (path === 'a.md') { await f.adapter.write(path, 'recreated by user'); f.engine.event('create', path); } };
    await f.engine.execute(await f.engine.preview());
    assert.equal(f.local.get('a.md').bytes.toString(), 'recreated by user');
    assert.equal(f.local.get('b.md').bytes.toString(), 'b-target');
    assert.equal(f.engine.state.baseCommitSha, baseline);
    assert.equal(f.engine.state.localRecheck.receipts['a.md'].applied, true);
    const next = await restart(f).preview();
    assert.equal(next.conflicts.length, 0); assert(next.uploads.includes('a.md')); assert(!next.localDeletes.includes('a.md'));
  }
  // A persisted local-recheck transaction remains bound to the original scope and remote history.
  for (const changed of ['branch', 'repoUrl', 'behind', 'diverged']) {
    const f = await fixture({ 'note.md': 'old' }, { 'note.md': 'old' });
    const baseline = await align(f), binary = f.adapter.writeBinary;
    f.cloudEdit('note.md', 'target');
    f.adapter.writeBinary = async (path, bytes) => { await binary(path, bytes); await f.adapter.write(path, 'user edit'); f.engine.event('modify', path); };
    await f.engine.execute(await f.engine.preview());
    const target = f.engine.state.localRecheck.commit, original = f.options[changed], request = globalThis.githubRequest;
    const restarted = restart(f);
    if (changed === 'branch' || changed === 'repoUrl') {
      f.options[changed] = changed === 'branch' ? 'other' : 'https://github.com/example/other.git';
      globalThis.githubRequest = async value => /\/commits\//.test(value.url)
        ? { status: 200, headers: {}, json: { sha: f.head(), commit: { tree: { sha: f.root() } } } } : request(value);
    }
    else {
      f.cloudEdit('other.md', 'later remote');
      globalThis.githubRequest = async value => value.url.includes(`/compare/${target}...`)
        ? { status: 200, headers: {}, json: { status: changed, files: [] } } : request(value);
    }
    try { await assert.rejects(restarted.preview(), /范围|仓库|变化|历史/); }
    finally { globalThis.githubRequest = request; }
    assert.equal(f.local.get('note.md').bytes.toString(), 'user edit');
    assert.equal(restarted.state.baseCommitSha, baseline); assert.equal(restarted.state.localRecheck.commit, target);
    if (changed === 'branch' || changed === 'repoUrl') {
      f.options[changed] = original;
      const next = await restarted.preview(); assert(next.uploads.includes('note.md')); assert.equal(next.conflicts.length, 0);
    }
  }
  console.log('Post-delete recreation and persisted local-recheck scope/history guards passed');

  // The real caller permits at most the original round plus one local-edit follow-up.
  {
    const built = await esbuild.build({ entryPoints: ['src/features/sync/index.ts'], bundle: true, platform: 'browser', format: 'cjs',
      external: ['obsidian'], write: false, loader: { '.png': 'dataurl' } });
    const obsidian = new Proxy({ Platform: { isMobile: false } }, { get: (target, key) => key in target ? target[key] : function () {} });
    const context = vm.createContext({ module: { exports: {} }, require: () => obsidian, console, crypto: globalThis.crypto,
      TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, performance, setTimeout, clearTimeout }); context.window = context;
    vm.runInContext(built.outputFiles[0].text, context);
    const Sync = context.module.exports.default;
    const f = await fixture({ 'note.md': 'base' }, { 'note.md': 'base' });
    const baseline = await align(f), request = globalThis.githubRequest;
    await f.adapter.write('note.md', 'edit-0'); f.engine.event('modify', 'note.md');
    let patches = 0;
    globalThis.githubRequest = async value => { const response = await request(value);
      if (value.method === 'PATCH') { patches++; await f.adapter.write('note.md', `edit-${patches}`); f.engine.event('modify', 'note.md'); }
      return response; };
    const status = [], caller = Object.create(Sync.prototype);
    Object.assign(caller, { showLightweightPlan: async () => {}, setSyncActivity: text => status.push(text), setStatus: text => status.push(text) });
    try { assert.equal(await caller.runLightweightCycle(f.engine, false), false); } finally { globalThis.githubRequest = request; }
    assert.equal(patches, 2, 'continuous edits are bounded to the original round and one follow-up');
    assert.equal(f.engine.state.baseCommitSha, baseline); assert(f.engine.needsLocalRecheck);
    assert.equal(f.local.get('note.md').bytes.toString(), 'edit-2');
    assert(status.some(text => text.includes('持续修改')));
    assert.equal(await caller.runLightweightCycle(f.engine, false), true, 'a later stable retry can finish normally');
    assert.equal(f.engine.needsLocalRecheck, false); assert.equal(f.engine.state.baseCommitSha, f.head());
    assert.equal(f.remote()['note.md'].sha, hash(Buffer.from('edit-2')));
  }
  console.log('Real caller: actionless upload edits, bounded follow-up and stable retry passed');
  // Remote A→B and an in-flight local A→C must keep the old identity in the follow-up.
  for (const contentChanged of [false, true]) for (const localEdit of ['rename', 'delete']) {
    const f = await fixture({ 'a.md': 'old identity', 'safe.md': 'old' }, { 'a.md': 'old identity', 'safe.md': 'old' });
    const baseline = await align(f);
    f.cloudDelete('a.md'); f.cloudEdit('b.md', contentChanged ? 'new remote contents' : 'old identity'); f.cloudEdit('safe.md', 'safe-target');
    const request = globalThis.githubRequest, targetB = f.remote()['b.md'].sha;
    let moved = false;
    globalThis.githubRequest = async value => {
      const response = await request(value);
      if (value.url.includes('/compare/')) response.json.files = [{ filename: 'b.md', previous_filename: 'a.md', status: 'renamed', sha: targetB },
        { filename: 'safe.md', status: 'modified', sha: f.remote()['safe.md'].sha }];
      if (!moved && value.url.endsWith('/git/blobs/' + targetB)) {
        moved = true;
        if (localEdit === 'rename') f.move('a.md', 'c.md');
        else { await f.adapter.remove('a.md'); f.engine.event('delete', 'a.md'); }
      }
      return response;
    };
    try {
      await f.engine.execute(await f.engine.preview());
      if (localEdit === 'rename') assert.equal(f.local.get('c.md').bytes.toString(), 'old identity');
      assert(!f.local.has('a.md'));
      assert.equal(f.local.get('safe.md').bytes.toString(), 'safe-target');
      assert.equal(f.engine.state.baseCommitSha, baseline);
      assert.equal(f.engine.state.localRecheck.receipts['a.md'].applied, false, 'a source removed by the user is not an app-applied deletion');
      assert.equal(f.engine.state.localRecheck.base['a.md'].sha, hash(Buffer.from('old identity')));
      const next = await restart(f).preview();
      assert(next.conflicts.some(conflict => conflict.kind === 'path' || conflict.label.includes('a.md') || conflict.label.includes('c.md')),
        'competing renames remain a file identity decision, not silent unrelated additions');
      assert(!next.uploads.includes('c.md'), 'the renamed local identity cannot be silently uploaded as an independent addition');
      assert(!next.downloads.includes('b.md'), 'the unresolved remote rename cannot silently recreate a source the user removed');
    } finally { globalThis.githubRequest = request; }
  }
  console.log('Competing rename identities survive download-time edits and restart passed');

  // Legacy persisted journals lack rename identities: stable recovery works, ambiguous edits stop safely.
  for (const editSource of [false, true]) {
    const f = await fixture({ 'a.md': 'old identity', 'safe.md': 'old' }, { 'a.md': 'old identity', 'safe.md': 'old' });
    const baseline = await align(f);
    f.cloudDelete('a.md'); f.cloudEdit('b.md', 'old identity'); f.cloudEdit('safe.md', 'safe-target');
    f.fail('b.md');
    await assert.rejects(f.engine.execute(await f.engine.preview()), /disk failure/);
    assert(f.engine.state.pending);
    delete f.engine.state.pending.identityTargets;
    await f.engine.save();
    assert.equal((await stored(f.engine)).pending.identityTargets, undefined, 'fixture persists the actual legacy schema before restart');
    f.fail('');
    const restarted = restart(f), request = globalThis.githubRequest, targetB = f.remote()['b.md'].sha;
    let sourceEdited = false;
    globalThis.githubRequest = async value => {
      const response = await request(value);
      if (editSource && !sourceEdited && value.url.endsWith('/git/blobs/' + targetB)) {
        sourceEdited = true; await f.adapter.remove('a.md'); restarted.event('delete', 'a.md');
      }
      return response;
    };
    try {
      if (editSource) {
        await assert.rejects(restarted.preview(), /旧版恢复记录缺少改名对应信息/);
        assert(sourceEdited);
        assert.equal(restarted.state.baseCommitSha, baseline);
        assert(restarted.state.pending); assert.equal(restarted.state.pending.transfer.reviewRequired, true);
        const durable = await stored(restarted);
        assert.equal(durable.baseCommitSha, baseline); assert(durable.pending.transfer.reviewRequired);
        assert(!f.local.has('a.md'), 'legacy recovery never recreates the user-deleted rename source');
        assert.equal(restarted.needsLocalRecheck, false, 'ambiguous legacy evidence cannot become an automatic upload plan');
      } else {
        const next = await restarted.preview();
        assert.equal(restarted.state.baseCommitSha, f.head());
        assert.equal(restarted.state.pending, undefined); assert.equal(restarted.needsLocalRecheck, false);
        assert.equal(next.conflicts.length + next.uploads.length + next.downloads.length + next.localDeletes.length + next.remoteDeletes.length, 0);
        assert(!f.local.has('a.md')); assert.equal(f.local.get('b.md').bytes.toString(), 'old identity');
      }
      assert.equal(f.local.get('safe.md').bytes.toString(), 'safe-target', 'safe independent files finish even for a legacy ambiguous rename');
    } finally { globalThis.githubRequest = request; }
  }
  console.log('Legacy journals: stable rename recovery completes; an edited source preserves pending/old baseline and requests manual review passed');


} finally {
  delete globalThis.githubRequest;
  if (!resolve(folder).startsWith(output + sep)) throw Error('Unsafe local-edit fixture cleanup path');
  await rm(folder, { recursive: true, force: true });
}
