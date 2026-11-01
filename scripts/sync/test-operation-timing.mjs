import assert from "node:assert/strict";
import vm from "node:vm";
import esbuild from "esbuild";

const built = await esbuild.build({ stdin: {
  contents: 'export { OperationTiming } from "./src/shared/operationTiming"; export { default as Sync } from "./src/features/sync/index";',
  resolveDir: process.cwd()
}, bundle: true, platform: "browser", format: "cjs", write: false, external: ["obsidian"] });
const logErrors = [];
const obsidian = new Proxy({ Platform: { isMobile: true } }, {
  get: (target, key) => key in target ? target[key] : function () {}
});
const context = vm.createContext({ module: { exports: {} },
  require: name => { assert.equal(name, "obsidian"); return obsidian; },
  Date, performance, setTimeout, clearTimeout,
  console: { error: (...args) => logErrors.push(args) }
});
context.window = context;
vm.runInContext(built.outputFiles[0].text, context);
const { OperationTiming, Sync } = context.module.exports;

let clock = 0;
const timing = new OperationTiming(() => clock);
assert.equal(timing.currentStage, "准备");
assert.equal(timing.summary(), "总耗时 0.00 秒");
timing.stage("本地扫描");
clock = 400;
assert.equal(timing.summary(), "总耗时 0.40 秒\n本地扫描：0.40 秒");
assert.equal(timing.summary(), "总耗时 0.40 秒\n本地扫描：0.40 秒", "summary does not accumulate a stage twice");
timing.stage("云端清单");
clock = 1400;
timing.stage("本地扫描");
clock = 1600;
const success = timing.summary();
assert.equal(success, "总耗时 1.60 秒\n本地扫描：0.60 秒\n云端清单：1.00 秒");
assert.equal(timing.summary(), success);
clock = 1700;
assert.match(timing.summary(), /总耗时 1.70 秒\n本地扫描：0.70 秒/);
timing.files("本地扫描", 1500);
assert.match(timing.summary(), /本地扫描：1500 个文件 · 0.70 秒/);
assert.match(new OperationTiming().summary(), /^总耗时 \d+\.\d{2} 秒$/);

clock = 0;
const failed = new OperationTiming(() => clock);
let failureMessage;
try {
  failed.stage("云端清单"); clock = 200;
  failed.stage("下载"); clock = 800;
  throw new Error("private token and note contents");
} catch {
  failureMessage = `失败阶段：${failed.currentStage} · ${failed.summary()}`;
}
assert.equal(failureMessage, "失败阶段：下载 · 总耗时 0.80 秒\n云端清单：0.20 秒\n下载：0.60 秒");
assert(!failureMessage.includes("private"));

const sync = Object.create(Sync.prototype);
const previousError = { timestamp: Date.now() - 1000, context: "同步", status: "error", message: "旧同步错误" };
const legacy = { timestamp: Date.now() - 2000, context: "旧记录", message: "旧日志内容" };
sync.settings = { errorLogs: [legacy, previousError], recordSyncPerformance: false };
let saves = 0;
sync.saveSettings = async () => { saves++; };
await sync.recordOperationLog("轻量比对耗时", "success", success);
assert.equal(saves, 0, "disabled performance logging saves no timing records");
sync.settings.recordSyncPerformance = true;
sync.syncLog = { context: "轻量同步 · 手动", timings: [], recorded: false };
await sync.recordOperationLog("轻量比对耗时", "success", success);
await sync.recordOperationLog("轻量执行耗时", "success", success);
assert.equal(saves, 0, "stages stay in memory until the operation record is saved");
await sync.recordSuccess(sync.syncLog.context, "同步完成");
assert.equal(sync.getRecentErrorLogs()[0].timings.length, 2);
assert.equal(sync.getRecentErrorLogs()[0].context, "轻量同步 · 手动");
sync.syncLog = undefined;
await sync.recordLog("轻量同步 · 手动", "pending", "等待确认");
assert.equal(sync.getActiveSyncError(), undefined, "an unfinished check does not become an error");
await sync.recordOperationLog("分享发布耗时", "error", failureMessage);
assert.equal(saves, 3);
assert.equal(sync.getRecentErrorLogs().length, 5, "timings share the existing log list and preserve legacy records");
assert.equal(sync.getActiveSyncError(), undefined, "a grouped successful sync clears the prior sync error");
assert.equal(sync.getRecentErrorLogs()[0].message, failureMessage);
await sync.recordSuccess("同步", "同步完成");
assert.equal(sync.getActiveSyncError(), undefined, "a real successful sync still clears the active sync error");
sync.refreshSyncView = async () => {};
await sync.clearErrorLogs("分享");
assert(!sync.getRecentErrorLogs().some(entry => entry.context.startsWith("分享")), "share dialog clears share records");
assert(sync.getRecentErrorLogs().some(entry => entry.context === "同步"), "share dialog preserves sync history");
sync.saveSettings = async () => { throw new Error("simulated log storage failure"); };
await assert.doesNotReject(sync.recordOperationLog("轻量执行耗时", "success", success));
assert.equal(logErrors.length, 1, "log storage failure stays outside the operation result");
console.log("Operation timing: stage totals, repeated snapshots, failure stage, shared logs, legacy history and isolated log-write failure passed");
