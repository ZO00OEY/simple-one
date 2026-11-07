import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import esbuild from "esbuild";

const obsidian = new Proxy({ Component: class {}, TFile: class {}, Notice: class {} }, {
  get: (target, key) => key in target ? target[key] : function () {}
});
const bundle = await esbuild.build({ stdin: { contents: 'export { default as ShareFeature } from "./src/features/share/index"; export { emptyManifest } from "./src/features/share/model";', resolveDir: process.cwd() },
  bundle: true, write: false, platform: "node", format: "cjs", external: ["obsidian"],
  plugins: [{ name: "share-timing-fixtures", setup(build) {
    build.onResolve({ filter: /^\.\/export$/ }, args => args.importer.endsWith("share/index.ts") || args.importer.endsWith("share\\index.ts") ? { path: "export", namespace: "fixture" } : undefined);
    build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'export const exportNote = (...args) => globalThis.shareTimingExport(...args);' }));
  } }] });
let clock = 0, wall = 100000;
const context = vm.createContext({ module: { exports: {} }, require: () => obsidian,
  crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, atob, btoa,
  performance: { now: () => clock }, Date: class extends Date { static now() { return wall; } },
  setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {}, console });
context.window = context;
vm.runInContext(bundle.outputFiles[0].text, context);
const { ShareFeature, emptyManifest } = context.module.exports;
const secret = "PRIVATE_BODY_AND_TOKEN_MUST_NOT_BE_LOGGED";
const tick = () => { clock += 1000; wall += 1000; };

function fixture(saved = { version: 1 }) {
  const logs = [], storage = new Map(), controls = { fail: "", outcome: "success" };
  storage.set(".obsidian/plugins/simple-one/share-local.json", JSON.stringify(saved));
  const step = name => { tick(); if (controls.fail === name) throw Error(secret); };
  const host = { manifest: { id: "simple-one" }, settings: {}, app: { vault: { configDir: ".obsidian",
    getAbstractFileByPath: () => undefined, adapter: {
      exists: async path => storage.has(path), read: async path => storage.get(path),
      write: async (path, value) => { step(path.endsWith("share-manifest.json") ? "保存网站配置" : "保存发布记录"); storage.set(path, value); }
    } }, workspace: { getLeavesOfType: () => [] } }, sync: {
      isSyncing: () => false, recordOperationLog: async (context, status, message) => logs.push({ context, status, message })
    } };
  const feature = new ShareFeature(host);
  feature.manifest = emptyManifest(); feature.manifest.recordSharePerformance = true; feature.manifest.enabled = true;
  feature.manifest.site = { owner: "example", repo: "share", branch: "main" };
  feature.reload = async () => step("准备发布");
  feature.readTemplate = async () => '<script data-simple-reader></script>';
  feature.renderViews = () => {}; feature.scan = async () => {};
  feature.index = () => new Map(); feature.scheduleDeploymentCheck = () => {};
  feature.publishProgress = message => { feature.status = message; };
  feature.validateHosting = async () => {};
  feature.edgeone.invalidateDeployment = async () => {};
  const repository = {
    verify: async () => step("读取远端"), refresh: async () => {}, state: async () => ({ version: 1, notes: {}, files: [] }),
    writeFiles: async () => { step("哈希比对"); return { expected: { "index.html": "hash" } }; },
    push: async () => { step("上传提交"); return "confirmed-commit"; }, configurePages: async () => {},
    deployment: async () => { step("部署检查"); return controls.outcome === "success" ? "网站已更新" : "已推送，网站部署中"; }
  };
  feature.repository = async () => repository;
  const local = () => JSON.parse(storage.get(".obsidian/plugins/simple-one/share-local.json"));
  return { feature, logs, controls, storage, host, local, repository };
}

// The same summary includes the required phases, and confirmed publication is separate from hosting.
{
  const f = fixture(); await f.feature.publish();
  assert.equal(f.logs.length, 1); assert.equal(f.logs[0].status, "success");
  const message = f.logs[0].message;
  for (const label of ["读取远端", "导出正文附件", "哈希比对", "上传提交", "保存发布记录", "部署检查", "总耗时"]) assert(message.includes(label), label);
  assert.match(message, /观测到上线耗时 \d+\.\d{2} 秒/); assert(message.includes("非云端纯构建耗时"));
  assert(f.local().commitConfirmedAt > 0); assert(f.local().deploymentObservedAt >= f.local().commitConfirmedAt);
  const confirmed = f.local().commitConfirmedAt, observed = f.local().deploymentObservedAt;
  wall += 60000; await f.feature.publish();
  assert.equal(f.local().commitConfirmedAt, confirmed, "unchanged commit retains confirmation time");
  assert.equal(f.local().deploymentObservedAt, observed, "later checks retain the first observed online time");
}
for (const stage of ["准备发布", "读取远端", "哈希比对", "上传提交", "保存发布记录", "部署检查", "保存网站配置"]) {
  const f = fixture(); f.controls.fail = stage;
  if (stage === "部署检查" || stage === "保存网站配置") await f.feature.publish();
  else await assert.rejects(f.feature.publish(), error => error.message === secret);
  assert.equal(f.logs.length, 1, stage); assert.equal(f.logs[0].status, "error", stage);
  assert(f.logs[0].message.includes(`失败阶段：${stage}`), f.logs[0].message);
  assert(f.logs[0].message.includes("总耗时")); assert(!f.logs[0].message.includes(secret));
  if (["保存发布记录", "部署检查", "保存网站配置"].includes(stage)) assert(f.logs[0].message.includes("上传已确认"));
}
// Export failure text may contain note content; logs contain only fixed stage and outcome labels.
{
  const f = fixture();
  f.feature.manifest.notes.aaaaaaaaaaaa = { enabled: true, sourcePath: "private.md", category: "", revision: 1 };
  await assert.rejects(f.feature.publish(), /源文件缺失/);
  assert(f.logs[0].message.includes("失败阶段：导出正文附件")); assert(!f.logs[0].message.includes("private.md"));
}
// A pending result remains a successful upload; automatic checks log changes only, manual checks always log.
{
  const f = fixture(); f.controls.outcome = "pending"; await f.feature.publish();
  assert.equal(f.logs[0].status, "success"); assert(f.logs[0].message.includes("网站仍在部署"));
  assert(f.logs[0].message.includes("距提交确认已等待"));
  await f.feature.checkDeployment(true); await f.feature.checkDeployment(true);
  assert.equal(f.logs.length, 1, "unchanged pending polls do not add logs after publish");
  await f.feature.checkDeployment(); assert.equal(f.logs.length, 2, "manual checks remain visible");
  f.controls.outcome = "success"; wall += 10000;
  await f.feature.checkDeployment(true); assert.equal(f.logs.length, 3);
  const observed = f.local().deploymentObservedAt;
  await f.feature.checkDeployment(true); assert.equal(f.logs.length, 3);
  f.controls.fail = "部署检查";
  await assert.rejects(f.feature.checkDeployment(true)); assert.equal(f.logs.length, 4);
  await assert.rejects(f.feature.checkDeployment(true)); assert.equal(f.logs.length, 4, "unchanged automatic errors do not flood logs");
  assert.equal(f.local().deploymentObservedAt, observed);
  assert(!f.logs.some(log => log.message.includes(secret)));
}
// Saved timestamps survive a new feature instance; legacy same-commit records stay unknown.
{
  const f = fixture({ version: 1, site: "example/share", commit: "confirmed-commit", commitConfirmedAt: wall - 20000 });
  const restarted = new ShareFeature(f.host);
  restarted.manifest = f.feature.manifest; restarted.renderViews = () => {}; restarted.publishProgress = message => { restarted.status = message; };
  restarted.repository = async () => f.repository;
  await restarted.checkDeployment();
  assert(f.logs[0].message.includes("观测到上线耗时 21.00 秒"), "observed wait includes elapsed time before this process/check");
  assert(f.local().deploymentObservedAt);
  const legacy = fixture({ version: 1, site: "example/share", commit: "confirmed-commit" });
  await legacy.feature.publish();
  assert.equal(legacy.local().commitConfirmedAt, undefined); assert.equal(legacy.local().deploymentObservedAt, undefined);
  assert(!legacy.logs[0].message.includes("观测到上线耗时")); assert(!legacy.logs[0].message.includes("距提交确认已等待"));
}
// EdgeOne can report a failed or unknown deployment without throwing a transport error.
for (const kind of ["error", "unknown"]) {
  const f = fixture(); f.feature.manifest.site.hosting = "edgeone";
  f.feature.edgeone.checkDeployment = async () => { tick(); f.feature.edgeone.state.lastCheck = { kind, commit: "confirmed-commit" }; };
  await f.feature.publish(); assert.equal(f.logs[0].status, "error");
  assert(f.logs[0].message.includes("失败阶段：部署检查")); assert(f.logs[0].message.includes("上传已确认"));
}
{
  const f = fixture(); f.feature.manifest.recordSharePerformance = false;
  await f.feature.publish();
  assert(f.logs[0].message.includes("新增 0 篇"));
  assert(!f.logs[0].message.includes("总耗时"));
}
{
  const f = fixture(); let edgeChecks = 0;
  Object.defineProperty(f.feature.edgeone, "linked", { value: true });
  f.feature.edgeone.checkDeployment = async () => { edgeChecks++; f.feature.edgeone.state.lastCheck = { kind: "pending", text: "构建中", commit: "confirmed-commit" }; };
  await f.feature.publish();
  assert.equal(edgeChecks, 1, "GitHub display selection still checks EdgeOne");
  assert(f.feature.status.includes("GitHub Pages："));
  assert(f.feature.status.includes("\n腾讯 EdgeOne："));
  assert(f.feature.deploymentPending());
  f.controls.fail = "部署检查";
  await assert.rejects(f.feature.checkDeployment());
  assert.equal(edgeChecks, 2, "one provider failure does not prevent the other check");
}
{
  const f = fixture(); let collapse, delay;
  const schedule = context.setTimeout;
  context.setTimeout = (callback, milliseconds) => { collapse = callback; delay = milliseconds; return 7; };
  try {
    Object.defineProperty(f.feature.edgeone, "linked", { value: true });
    f.feature.edgeone.checkDeployment = async () => { f.feature.edgeone.state.lastCheck = { kind: "success", commit: "confirmed-commit" }; };
    await f.feature.publish();
    assert.equal(delay, 1500); assert(f.feature.status.includes('\n腾讯 EdgeOne：'));
    collapse(); assert.equal(f.feature.status, 'GitHub Pages 与腾讯 EdgeOne 均已部署成功');
    assert(f.local().lastPushedAt > 0); assert(f.local().lastCheckedAt > 0);
    const stale = collapse; f.feature.stopDeploymentCheck(); f.feature.status = '正在推送新版本'; stale();
    assert.equal(f.feature.status, '正在推送新版本', 'old success timers never overwrite a new task');
  } finally { context.setTimeout = schedule; }
}
console.log("Share timing: optional details, counts, dual checks, delayed summary, timestamps and stale timer protection passed");
