import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const output = resolve("../../../.codex/output");
await mkdir(output, { recursive: true });
const folder = await mkdtemp(join(output, "lightweight-guide-test-"));
globalThis.window = globalThis;
try {
  const bundle = join(folder, "mobile.cjs");
  await esbuild.build({ entryPoints: ["src/features/sync/mobileGithub.ts"], bundle: true, platform: "node", format: "cjs", outfile: bundle,
    plugins: [{ name: "mock-obsidian", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
      build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: "export const requestUrl = (request) => globalThis.githubRequest(request);" }));
    } }] });
  const { MobileGithub } = require(bundle);
  let calls = [], status = 200, privateRepo = true, protectedBranch = false, writeAllowed = true, push = true;
  let token = "fixture-token", repoUrl = "https://github.com/example/vault.git", branch = "";
  let truncated = false, hasCloudPlugins = true, syncPlugins = false, selectedPlugins = [], bound = false;
  const cloudFiles = [
    { path: ".obsidian/plugins/cloud-only/main.js", type: "blob", mode: "100644", sha: "program" },
    { path: ".obsidian/plugins/cloud-only/manifest.json", type: "blob", mode: "100644", sha: "manifest" },
    { path: ".obsidian/plugins/cloud-only/data.json", type: "blob", mode: "100644", sha: "private-config" },
    { path: ".obsidian/plugins/simple-link/main.js", type: "blob", mode: "100644", sha: "self" },
    { path: ".obsidian/plugins/simple-link/manifest.json", type: "blob", mode: "100644", sha: "self-manifest" },
    { path: ".obsidian/plugins/zoes-plugin.zip", type: "blob", mode: "100644", sha: "archive" },
    { path: ".obsidian/plugins/zoey-sync-test/sync-settings.json", type: "blob", mode: "100644", sha: "legacy" },
    { path: ".obsidian/plugins/incomplete/manifest.json", type: "blob", mode: "100644", sha: "incomplete" }
  ];
  globalThis.githubRequest = async (request) => {
    calls.push(request);
    assert.equal(request.headers.Authorization, `Bearer ${token}`);
    const path = new URL(request.url).pathname;
    let json;
    if (path === "/user") json = { login: "example" };
    else if (path === "/user/repos") json = { private: true, clone_url: repoUrl, default_branch: "main" };
    else if (path.endsWith("/branches/main")) json = { protected: protectedBranch };
    else if (path.endsWith("/commits/main")) json = { sha: "commit", commit: { tree: { sha: "tree" } } };
    else if (path.endsWith("/git/trees/tree")) {
      const note = { path: "note.md", type: "blob", mode: "100644", sha: "blob" };
      if (truncated && request.url.includes("recursive=1")) json = { tree: [], truncated: true };
      else if (truncated) json = { truncated: false, tree: [note, { path: ".obsidian", type: "tree", mode: "040000", sha: "config" }] };
      else json = { truncated: false, tree: [note, ...(hasCloudPlugins ? cloudFiles : [])], truncated: false };
    }
    else if (path.endsWith("/git/trees/config")) json = { truncated: false, tree: [{ path: "plugins", type: "tree", mode: "040000", sha: "plugins" }] };
    else if (path.endsWith("/git/trees/plugins")) json = { truncated: false, tree: hasCloudPlugins ? [
      { path: "cloud-only", type: "tree", mode: "040000", sha: "cloud-only" }, { path: "simple-link", type: "tree", mode: "040000", sha: "self" },
      { path: "zoes-plugin.zip", type: "blob", mode: "100644", sha: "archive" },
      { path: "zoey-sync-test", type: "tree", mode: "040000", sha: "legacy" }, { path: "incomplete", type: "tree", mode: "040000", sha: "incomplete" }
    ] : [] };
    else if (path.endsWith("/git/trees/cloud-only")) json = { truncated: false, tree: cloudFiles.filter((entry) => entry.path.includes("/cloud-only/"))
      .map((entry) => ({ ...entry, path: entry.path.split("/").pop() })) };
    else if (path.endsWith("/git/trees/self")) json = { truncated: false, tree: cloudFiles.filter(entry => entry.path.includes("/simple-link/"))
      .map(entry => ({ ...entry, path: entry.path.split("/").pop() })) };
    else if (path.endsWith("/git/trees/legacy")) json = { truncated: false, tree: [{ path: "sync-settings.json", type: "blob", mode: "100644", sha: "legacy" }] };
    else if (path.endsWith("/git/trees/incomplete")) json = { truncated: false, tree: [{ path: "manifest.json", type: "blob", mode: "100644", sha: "incomplete" }] };
    else if (path.endsWith("/git/blobs")) return { status: writeAllowed ? 201 : 403, json: { sha: "empty" }, headers: {} };
    else if (path === "/repos/example/vault") json = { private: privateRepo, default_branch: "main", permissions: { push } };
    else return { status: 404, json: {}, headers: {} };
    return { status, json, headers: {} };
  };
  let localWrites = 0;
  const adapter = { exists: async () => false, write: async () => { localWrites++; } };
  const options = () => ({ token, repoUrl, branch, syncImages: true, syncPlugins, plugins: selectedPlugins, bound, ignorePatterns: [], cacheEnabled: true, trackPaths: true });
  const engine = new MobileGithub(adapter, ".obsidian", "simple-link", options, () => {});
  assert.equal(await engine.verifyToken(), "example");
  assert.equal(calls.length, 1);
  status = 401;
  await assert.rejects(engine.verifyToken(), /无效或已过期/);
  status = 200; token = ""; calls = [];
  await assert.rejects(engine.verifyToken(), /填写/);
  assert.equal(calls.length, 0);
  token = "fixture-token"; privateRepo = false;
  await assert.rejects(engine.verifyAccess(), /私人仓库/);
  privateRepo = true; push = false;
  await assert.rejects(engine.verifyAccess(), /写入权限/);
  push = true; protectedBranch = true;
  await assert.rejects(engine.verifyAccess(), /受保护/);
  protectedBranch = false; branch = "missing";
  await assert.rejects(engine.verifyAccess(), /分支不存在/);
  branch = ""; writeAllowed = false;
  // Account push permission must not admit a read-only fine-grained Token.
  await assert.rejects(engine.verifyAccess(), /拒绝请求/);
  writeAllowed = true; calls = [];
  const verified = await engine.verifyAccess();
  assert.equal(verified.branch, "main");
  assert.equal(verified.files["note.md"].sha, "blob");
  assert.equal(localWrites, 0, "verification must not bind or save live settings");
  const mutations = calls.filter((request) => request.method !== "GET");
  assert.equal(mutations.length, 1);
  assert(mutations[0].url.endsWith("/git/blobs"));
  assert.deepEqual(JSON.parse(mutations[0].body), { content: "", encoding: "utf-8" });
  // A fresh device has no local plugin directory: listing must use cloud files alone.
  assert.deepEqual(await engine.listCloudPlugins(), ["cloud-only", "simple-link"]);
  assert(!Object.keys(verified.files).some((path) => path.includes("/plugins/")));
  truncated = true;
  assert.deepEqual(await engine.listCloudPlugins(), ["cloud-only", "simple-link"], "truncated trees must discover excluded plugin directories");
  hasCloudPlugins = false;
  assert.deepEqual(await engine.listCloudPlugins(), []);
  hasCloudPlugins = true;
  syncPlugins = true; selectedPlugins = ["cloud-only"];
  adapter.list = async () => ({ files: [], folders: [] });
  await engine.bind(); bound = true;
  let firstSync = await engine.preview();
  assert.equal(firstSync.downloads.length, 0, "single-sided initial files wait for direction");
  assert(firstSync.conflicts.some(c => c.kind === "unpaired" && c.label === ".obsidian/plugins/cloud-only/main.js"));
  firstSync = await engine.preview(Object.fromEntries(firstSync.conflicts.map(c => [c.id, { choice: "remote" }])));
  assert(firstSync.downloads.includes(".obsidian/plugins/cloud-only/main.js"));
  assert(firstSync.downloads.includes(".obsidian/plugins/cloud-only/manifest.json"));
  assert(firstSync.downloads.includes(".obsidian/plugins/cloud-only/data.json"));
  assert(!firstSync.downloads.includes(".obsidian/plugins/simple-link/main.js"));
  assert.equal(firstSync.uploads.length, 0);
  assert.equal(firstSync.remoteDeletes.length, 0, "empty local vault must not delete cloud files on first sync");
  selectedPlugins = ["cloud-only", "simple-link"];
  const withSelf = await engine.preview();
  assert(withSelf.conflicts.some(c => c.label === ".obsidian/plugins/simple-link/main.js"));
  assert(withSelf.conflicts.some(c => c.label === ".obsidian/plugins/simple-link/manifest.json"));
  for (const name of ["data.json", "data.json.bak", "link-state.json", "link-state.json.recovery", "mobile-ignore.json"]) {
    assert.equal(engine.allowed(".obsidian/plugins/simple-link/" + name), false);
  }
  for (const name of ["main.js", "manifest.json", "styles.css", "src/features/sync/index.ts", "assets/icon.png"]) {
    assert.equal(engine.allowed(".obsidian/plugins/simple-link/" + name), true);
  }
  assert.equal(engine.allowed(".obsidian/plugins/simple-link/sync-settings.json"), true, "shared settings retain their existing behavior");
  selectedPlugins = [];
  assert.equal(engine.allowed(".obsidian/plugins/simple-link/main.js"), false, "self must be explicitly selected");
  calls = [];
  await assert.rejects(engine.createPrivateRepository("invalid/name"), /仓库名称/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await engine.createPrivateRepository("vault"), { url: repoUrl, branch: "main" });
  const create = calls.find((request) => request.method === "POST");
  assert.deepEqual(JSON.parse(create.body), { name: "vault", private: true, auto_init: true });
  engine.state.pending = {};
  await assert.rejects(engine.bind(), /未完成同步/);
  console.log("Lightweight guide API checks passed");
} finally {
  delete globalThis.githubRequest;
  await rm(folder, { recursive: true, force: true });
}
