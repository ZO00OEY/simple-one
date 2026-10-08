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

  async function reviewedPreview(f) {const plan=await f.engine.preview();const choices={};for(const c of plan.conflicts)choices[c.id]={choice:c.local?'local':'remote'};return plan.conflicts.length?f.engine.preview(choices):plan;}
  const f = await fixture({}, { 'remote.md': 'cloud' });
  const preview = await reviewedPreview(f);
  await f.engine.execute(preview);
  assert.equal(f.local.get('remote.md').bytes.toString(),'cloud');
  assert.equal(f.engine.state.cache['remote.md'].rawSha,hash(Buffer.from('cloud')));
  assert.equal(f.engine.state.pending,undefined);
  const broken = await fixture({}, {'remote.md':'cloud'});broken.fail('remote.md');
  await assert.rejects(broken.engine.execute(await reviewedPreview(broken)),/disk failure/);
  assert.equal(broken.engine.state.baseCommitSha,null);assert(broken.engine.state.pending);
  broken.fail('');await broken.engine.preview();assert.equal(broken.engine.state.pending,undefined);
  const changed = await fixture({}, {'remote.md':'cloud'});
  let injected=false;const originalStat=changed.adapter.stat;
  changed.adapter.stat=async path=>{if(path==='remote.md'&&changed.engine.state.cache[path]&&!injected){injected=true;await changed.adapter.write(path,'user edit');changed.engine.event('modify',path);}return originalStat(path);};
  await assert.rejects(changed.engine.execute(await reviewedPreview(changed)),/验证期间/);
  assert.equal(changed.local.get('remote.md').bytes.toString(),'user edit');assert.equal(changed.engine.state.baseCommitSha,null);
  console.log('Download cache, interrupted recovery and edit-during-verification passed');
} finally { await rm(folder,{recursive:true,force:true}); }
